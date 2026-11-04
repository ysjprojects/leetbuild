/**
 * Hand-written support modules the job-queue steps import but no step builds: the `jobs` package.
 * `jobs.store` is the job registry and the job records (one Redis hash per job, its attempt history,
 * the outbox of refused events). `jobs.queue` is the queue of step 2 as later steps use it: claim,
 * ack and return_expired as step 2 builds them, plus retry_later and bury for step 3. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'jobs/__init__.py': '',
  'jobs/store.py': `"""
The job records (provided). JOB_TYPES is the registry: each job type's payload schema, field name to
"string" or "integer", closed (a field it does not list is rejected). A job is the Redis hash
job:{id} with job_id, tenant, type, payload (JSON), state (queued, running, retrying, completed or
dead), attempts and enqueued_at_ms, plus worker and deadline_ms while it is claimed,
next_retry_at_ms while a retry is scheduled and dead_reason once it is buried. job:{id}:attempts
lists every attempt's outcome; jobs:outbox holds the job.event records the broker refused.
"""
import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

JOB_TYPES = {
    "email.send": {"to": "string", "template": "string"},
    "invoice.charge": {"invoice_id": "string", "amount_cents": "integer"},
}


def now_ms() -> int:
    return int(time.time() * 1000)


def job_key(job_id: str) -> str:
    return f"job:{job_id}"


def dedupe_key(tenant: str, key: str) -> str:
    return f"jobs:dedupe:{tenant}:{key}"


def _fits(value, kind: str) -> bool:
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, str)


def validate_payload(job_type: str, payload) -> str | None:
    """The first path of payload the type's schema rejects (missing, wrong type, not in the schema), or None."""
    schema = JOB_TYPES[job_type]
    if not isinstance(payload, dict):
        return "payload"
    for name in sorted(schema):
        if name not in payload or not _fits(payload[name], schema[name]):
            return f"payload.{name}"
    for name in sorted(payload):
        if name not in schema:
            return f"payload.{name}"
    return None


def new_job_id() -> str:
    return f"job-{r.incr('jobs:seq')}"


def create_job(job_id: str, tenant: str, job_type: str, payload: dict) -> None:
    """Write the job record as queued and append the job to jobs:queue."""
    r.hset(
        job_key(job_id),
        mapping={
            "job_id": job_id,
            "tenant": tenant,
            "type": job_type,
            "payload": json.dumps(payload),
            "state": "queued",
            "attempts": 0,
            "enqueued_at_ms": now_ms(),
        },
    )
    r.rpush("jobs:queue", job_id)


def get_job(job_id: str) -> dict | None:
    """The job record, or None. Numbers are ints; a field that does not apply is None."""
    raw = r.hgetall(job_key(job_id))
    if not raw:
        return None

    def number(name: str) -> int | None:
        value = raw.get(name, "")
        return int(value) if value else None

    return {
        "job_id": raw["job_id"],
        "tenant": raw["tenant"],
        "type": raw["type"],
        "payload": json.loads(raw.get("payload") or "{}"),
        "state": raw["state"],
        "attempts": int(raw.get("attempts") or 0),
        "worker": raw.get("worker") or None,
        "deadline_ms": number("deadline_ms"),
        "next_retry_at_ms": number("next_retry_at_ms"),
        "dead_reason": raw.get("dead_reason") or None,
    }


def begin_attempt(job_id: str) -> int:
    """Count one more attempt on the job record; returns its number (1 for the first)."""
    return r.hincrby(job_key(job_id), "attempts", 1)


def record_attempt(job_id: str, attempt: int, error: str) -> None:
    """Append the attempt's outcome to the job's history; error is "" for an attempt that succeeded."""
    r.rpush(f"job:{job_id}:attempts", json.dumps({"attempt": attempt, "error": error, "at_ms": now_ms()}))


def attempt_history(job_id: str) -> list[dict]:
    """Every attempt's outcome, oldest first: {attempt, error, at_ms}."""
    return [json.loads(entry) for entry in r.lrange(f"job:{job_id}:attempts", 0, -1)]


def outbox_add(event: dict) -> None:
    """Keep a job.event the broker refused, for the relay that republishes it."""
    r.rpush("jobs:outbox", json.dumps(event))
`,
  'jobs/queue.py': `"""
The queue (provided; step 2 builds claim, ack and return_expired the same way). jobs:queue lists
the job ids waiting to run; jobs:inflight is a sorted set of the claimed and retrying job ids,
scored by the millisecond time the claim expires or the retry is due; jobs:dead lists the buried
jobs. Every move between them is one Lua script, so a job is always in exactly one of them.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE_KEY = "jobs:queue"
INFLIGHT_KEY = "jobs:inflight"
DEAD_KEY = "jobs:dead"
VISIBILITY_TIMEOUT_S = 60

CLAIM_LUA = """
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then return false end
redis.call('ZADD', KEYS[2], ARGV[1], job_id)
redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
return job_id
"""

ACK_LUA = """
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
"""

RETURN_LUA = """
local returned = {}
for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms', 'next_retry_at_ms')
    table.insert(returned, job_id)
  end
end
return returned
"""

RETRY_LUA = """
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], 'state', 'retrying', 'next_retry_at_ms', ARGV[1])
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
"""

BURY_LUA = """
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'dead', 'dead_reason', ARGV[2])
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms', 'next_retry_at_ms')
redis.call('RPUSH', KEYS[3], ARGV[1])
return 1
"""

_claim = r.register_script(CLAIM_LUA)
_ack = r.register_script(ACK_LUA)
_return = r.register_script(RETURN_LUA)
_retry = r.register_script(RETRY_LUA)
_bury = r.register_script(BURY_LUA)


def now_ms() -> int:
    return int(time.time() * 1000)


def claim(worker: str) -> str | None:
    """Move the next queued job into jobs:inflight under the visibility timeout; its id, or None."""
    return _claim(keys=[QUEUE_KEY, INFLIGHT_KEY], args=[now_ms() + VISIBILITY_TIMEOUT_S * 1000, worker])


def ack(job_id: str, worker: str) -> bool:
    """Complete the job if worker still holds its claim; False when the claim is gone."""
    return _ack(keys=[INFLIGHT_KEY, f"job:{job_id}"], args=[worker, job_id]) == 1


def return_expired() -> list[str]:
    """Put every claim past its deadline (and every retry now due) back at the head of the queue."""
    return list(_return(keys=[INFLIGHT_KEY, QUEUE_KEY], args=[now_ms()]))


def retry_later(job_id: str, at_ms: int) -> None:
    """Release the claim and schedule the next attempt: return_expired requeues the job at at_ms."""
    _retry(keys=[INFLIGHT_KEY, f"job:{job_id}"], args=[at_ms, job_id])


def bury(job_id: str, reason: str) -> None:
    """Move the job to the dead letter (jobs:dead) with its reason; it is never retried."""
    _bury(keys=[INFLIGHT_KEY, f"job:{job_id}", DEAD_KEY], args=[job_id, reason])
`,
};

export const supportModulesTs: Record<string, string> = {
  'jobs/store.ts': `/**
 * The job records (provided). JOB_TYPES is the registry: each job type's payload schema, field name
 * to "string" or "integer", closed (a field it does not list is rejected). A job is the Redis hash
 * job:{id} with job_id, tenant, type, payload (JSON), state (queued, running, retrying, completed or
 * dead), attempts and enqueued_at_ms, plus worker and deadline_ms while it is claimed,
 * next_retry_at_ms while a retry is scheduled and dead_reason once it is buried. job:{id}:attempts
 * lists every attempt's outcome; jobs:outbox holds the job.event records the broker refused.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const JOB_TYPES: Record<string, Record<string, 'string' | 'integer'>> = {
  'email.send': {to: 'string', template: 'string'},
  'invoice.charge': {invoice_id: 'string', amount_cents: 'integer'},
};

export interface Job {
  job_id: string;
  tenant: string;
  type: string;
  payload: Record<string, unknown>;
  state: string;
  attempts: number;
  worker: string | null;
  deadline_ms: number | null;
  next_retry_at_ms: number | null;
  dead_reason: string | null;
}

export interface Attempt {
  attempt: number;
  error: string;
  at_ms: number;
}

export const jobKey = (jobId: string): string => \`job:\${jobId}\`;
export const dedupeKey = (tenant: string, key: string): string => \`jobs:dedupe:\${tenant}:\${key}\`;

const fits = (value: unknown, kind: string): boolean =>
  kind === 'integer' ? Number.isInteger(value) : typeof value === 'string';

/** The first path of payload the type's schema rejects (missing, wrong type, not in the schema), or null. */
export function validatePayload(jobType: string, payload: unknown): string | null {
  const schema = JOB_TYPES[jobType];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'payload';
  const fields = payload as Record<string, unknown>;
  for (const name of Object.keys(schema).sort()) {
    if (!(name in fields) || !fits(fields[name], schema[name])) return \`payload.\${name}\`;
  }
  const extra = Object.keys(fields)
    .filter(name => !(name in schema))
    .sort();
  return extra.length > 0 ? \`payload.\${extra[0]}\` : null;
}

export async function newJobId(): Promise<string> {
  return \`job-\${await redis.incr('jobs:seq')}\`;
}

/** Write the job record as queued and append the job to jobs:queue. */
export async function createJob(jobId: string, tenant: string, jobType: string, payload: Record<string, unknown>): Promise<void> {
  await redis.hset(jobKey(jobId), {
    job_id: jobId,
    tenant,
    type: jobType,
    payload: JSON.stringify(payload),
    state: 'queued',
    attempts: 0,
    enqueued_at_ms: Date.now(),
  });
  await redis.rpush('jobs:queue', jobId);
}

/** The job record, or null; a field that does not apply is null. */
export async function getJob(jobId: string): Promise<Job | null> {
  const raw = await redis.hgetall(jobKey(jobId));
  if (Object.keys(raw).length === 0) return null;
  const number = (name: string): number | null => (raw[name] ? Number(raw[name]) : null);
  return {
    job_id: raw.job_id,
    tenant: raw.tenant,
    type: raw.type,
    payload: JSON.parse(raw.payload || '{}') as Record<string, unknown>,
    state: raw.state,
    attempts: Number(raw.attempts || 0),
    worker: raw.worker || null,
    deadline_ms: number('deadline_ms'),
    next_retry_at_ms: number('next_retry_at_ms'),
    dead_reason: raw.dead_reason || null,
  };
}

/** Count one more attempt on the job record; resolves its number (1 for the first). */
export async function beginAttempt(jobId: string): Promise<number> {
  return redis.hincrby(jobKey(jobId), 'attempts', 1);
}

/** Append the attempt's outcome to the job's history; error is "" for an attempt that succeeded. */
export async function recordAttempt(jobId: string, attempt: number, error: string): Promise<void> {
  await redis.rpush(\`job:\${jobId}:attempts\`, JSON.stringify({attempt, error, at_ms: Date.now()}));
}

/** Every attempt's outcome, oldest first. */
export async function attemptHistory(jobId: string): Promise<Attempt[]> {
  return (await redis.lrange(\`job:\${jobId}:attempts\`, 0, -1)).map(entry => JSON.parse(entry) as Attempt);
}

/** Keep a job.event the broker refused, for the relay that republishes it. */
export async function outboxAdd(event: Record<string, unknown>): Promise<void> {
  await redis.rpush('jobs:outbox', JSON.stringify(event));
}
`,
  'jobs/queue.ts': `/**
 * The queue (provided; step 2 builds claim, ack and returnExpired the same way). jobs:queue lists
 * the job ids waiting to run; jobs:inflight is a sorted set of the claimed and retrying job ids,
 * scored by the millisecond time the claim expires or the retry is due; jobs:dead lists the buried
 * jobs. Every move between them is one Lua script, so a job is always in exactly one of them.
 */
import Redis from 'ioredis';

export const QUEUE_KEY = 'jobs:queue';
export const INFLIGHT_KEY = 'jobs:inflight';
export const DEAD_KEY = 'jobs:dead';
export const VISIBILITY_TIMEOUT_S = 60;

export const CLAIM_LUA = \`
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then return false end
redis.call('ZADD', KEYS[2], ARGV[1], job_id)
redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
return job_id
\`;

export const ACK_LUA = \`
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
\`;

export const RETURN_LUA = \`
local returned = {}
for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms', 'next_retry_at_ms')
    table.insert(returned, job_id)
  end
end
return returned
\`;

export const RETRY_LUA = \`
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], 'state', 'retrying', 'next_retry_at_ms', ARGV[1])
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
\`;

export const BURY_LUA = \`
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'dead', 'dead_reason', ARGV[2])
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms', 'next_retry_at_ms')
redis.call('RPUSH', KEYS[3], ARGV[1])
return 1
\`;

interface QueueRedis extends Redis {
  claimJob(queue: string, inflight: string, deadlineMs: number, worker: string): Promise<string | null>;
  ackJob(inflight: string, job: string, worker: string, jobId: string): Promise<number>;
  returnJobs(inflight: string, queue: string, nowMs: number): Promise<string[]>;
  retryJob(inflight: string, job: string, atMs: number, jobId: string): Promise<number>;
  buryJob(inflight: string, job: string, dead: string, jobId: string, reason: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as QueueRedis;
redis.defineCommand('claimJob', {numberOfKeys: 2, lua: CLAIM_LUA});
redis.defineCommand('ackJob', {numberOfKeys: 2, lua: ACK_LUA});
redis.defineCommand('returnJobs', {numberOfKeys: 2, lua: RETURN_LUA});
redis.defineCommand('retryJob', {numberOfKeys: 2, lua: RETRY_LUA});
redis.defineCommand('buryJob', {numberOfKeys: 3, lua: BURY_LUA});

/** Move the next queued job into jobs:inflight under the visibility timeout; its id, or null. */
export async function claim(worker: string): Promise<string | null> {
  return redis.claimJob(QUEUE_KEY, INFLIGHT_KEY, Date.now() + VISIBILITY_TIMEOUT_S * 1000, worker);
}

/** Complete the job if worker still holds its claim; false when the claim is gone. */
export async function ack(jobId: string, worker: string): Promise<boolean> {
  return (await redis.ackJob(INFLIGHT_KEY, \`job:\${jobId}\`, worker, jobId)) === 1;
}

/** Put every claim past its deadline (and every retry now due) back at the head of the queue. */
export async function returnExpired(): Promise<string[]> {
  return redis.returnJobs(INFLIGHT_KEY, QUEUE_KEY, Date.now());
}

/** Release the claim and schedule the next attempt: returnExpired requeues the job at atMs. */
export async function retryLater(jobId: string, atMs: number): Promise<void> {
  await redis.retryJob(INFLIGHT_KEY, \`job:\${jobId}\`, atMs, jobId);
}

/** Move the job to the dead letter (jobs:dead) with its reason; it is never retried. */
export async function bury(jobId: string, reason: string): Promise<void> {
  await redis.buryJob(INFLIGHT_KEY, \`job:\${jobId}\`, DEAD_KEY, jobId, reason);
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'jobs/store/store.go': `// Package store is the job records (provided). JobTypes is the registry: each job type's payload
// schema, field name to "string" or "integer", closed (a field it does not list is rejected). A job
// is the Redis hash job:{id} with job_id, tenant, type, payload (JSON), state (queued, running,
// retrying, completed or dead), attempts and enqueued_at_ms, plus worker and deadline_ms while it is
// claimed, next_retry_at_ms while a retry is scheduled and dead_reason once it is buried.
// job:{id}:attempts lists every attempt's outcome; jobs:outbox holds the job.event records the
// broker refused. A field that does not apply reads as "" or 0.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// JobTypes is the registry of job types and their payload schemas.
var JobTypes = map[string]map[string]string{
	"email.send":     {"to": "string", "template": "string"},
	"invoice.charge": {"invoice_id": "string", "amount_cents": "integer"},
}

// Job is one job record.
type Job struct {
	JobID         string         \`json:"job_id"\`
	Tenant        string         \`json:"tenant"\`
	Type          string         \`json:"type"\`
	Payload       map[string]any \`json:"payload"\`
	State         string         \`json:"state"\`
	Attempts      int            \`json:"attempts"\`
	Worker        string         \`json:"worker"\`
	DeadlineMs    int64          \`json:"deadline_ms"\`
	NextRetryAtMs int64          \`json:"next_retry_at_ms"\`
	DeadReason    string         \`json:"dead_reason"\`
}

// Attempt is one attempt's outcome; Error is "" for an attempt that succeeded.
type Attempt struct {
	Attempt int    \`json:"attempt"\`
	Error   string \`json:"error"\`
	AtMs    int64  \`json:"at_ms"\`
}

// JobKey is the hash of a job.
func JobKey(jobID string) string { return "job:" + jobID }

// DedupeKey is where a tenant's Dedupe-Key is reserved.
func DedupeKey(tenant, key string) string { return "jobs:dedupe:" + tenant + ":" + key }

func fits(value any, kind string) bool {
	switch v := value.(type) {
	case string:
		return kind == "string"
	case float64:
		return kind == "integer" && v == float64(int64(v))
	case int, int64:
		return kind == "integer"
	}
	return false
}

// ValidatePayload is the first path of payload the type's schema rejects (missing, wrong type, not
// in the schema), or "".
func ValidatePayload(jobType string, payload map[string]any) string {
	schema := JobTypes[jobType]
	if payload == nil {
		return "payload"
	}
	names := make([]string, 0, len(schema))
	for name := range schema {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value, ok := payload[name]
		if !ok || !fits(value, schema[name]) {
			return "payload." + name
		}
	}
	extra := []string{}
	for name := range payload {
		if _, ok := schema[name]; !ok {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	if len(extra) > 0 {
		return "payload." + extra[0]
	}
	return ""
}

// NewJobID issues the next job id.
func NewJobID(ctx context.Context) string {
	return fmt.Sprintf("job-%d", rdb.Incr(ctx, "jobs:seq").Val())
}

// CreateJob writes the job record as queued and appends the job to jobs:queue.
func CreateJob(ctx context.Context, jobID, tenant, jobType string, payload map[string]any) error {
	raw, _ := json.Marshal(payload)
	fields := map[string]any{
		"job_id": jobID, "tenant": tenant, "type": jobType, "payload": string(raw),
		"state": "queued", "attempts": 0, "enqueued_at_ms": time.Now().UnixMilli(),
	}
	if err := rdb.HSet(ctx, JobKey(jobID), fields).Err(); err != nil {
		return err
	}
	return rdb.RPush(ctx, "jobs:queue", jobID).Err()
}

// GetJob is the job record, or nil.
func GetJob(ctx context.Context, jobID string) *Job {
	raw := rdb.HGetAll(ctx, JobKey(jobID)).Val()
	if len(raw) == 0 {
		return nil
	}
	job := &Job{JobID: raw["job_id"], Tenant: raw["tenant"], Type: raw["type"], State: raw["state"], Worker: raw["worker"], DeadReason: raw["dead_reason"]}
	json.Unmarshal([]byte(raw["payload"]), &job.Payload)
	attempts, _ := strconv.Atoi(raw["attempts"])
	deadline, _ := strconv.ParseInt(raw["deadline_ms"], 10, 64)
	nextRetry, _ := strconv.ParseInt(raw["next_retry_at_ms"], 10, 64)
	job.Attempts, job.DeadlineMs, job.NextRetryAtMs = attempts, deadline, nextRetry
	return job
}

// BeginAttempt counts one more attempt on the job record and returns its number (1 for the first).
func BeginAttempt(ctx context.Context, jobID string) (int, error) {
	n, err := rdb.HIncrBy(ctx, JobKey(jobID), "attempts", 1).Result()
	return int(n), err
}

// RecordAttempt appends the attempt's outcome to the job's history; message is "" for an attempt
// that succeeded.
func RecordAttempt(ctx context.Context, jobID string, attempt int, message string) error {
	raw, _ := json.Marshal(Attempt{Attempt: attempt, Error: message, AtMs: time.Now().UnixMilli()})
	return rdb.RPush(ctx, "job:"+jobID+":attempts", string(raw)).Err()
}

// AttemptHistory is every attempt's outcome, oldest first.
func AttemptHistory(ctx context.Context, jobID string) []Attempt {
	out := []Attempt{}
	for _, entry := range rdb.LRange(ctx, "job:"+jobID+":attempts", 0, -1).Val() {
		var a Attempt
		if json.Unmarshal([]byte(entry), &a) == nil {
			out = append(out, a)
		}
	}
	return out
}

// OutboxAdd keeps a job.event the broker refused (any JSON-encodable value), for the relay.
func OutboxAdd(ctx context.Context, event any) error {
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "jobs:outbox", string(raw)).Err()
}
`,
  'jobs/queue/queue.go': `// Package queue is the queue (provided; step 2 builds Claim, Ack and ReturnExpired the same way).
// jobs:queue lists the job ids waiting to run; jobs:inflight is a sorted set of the claimed and
// retrying job ids, scored by the millisecond time the claim expires or the retry is due; jobs:dead
// lists the buried jobs. Every move between them is one Lua script, so a job is always in exactly
// one of them.
package queue

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	QueueKey           = "jobs:queue"
	InflightKey        = "jobs:inflight"
	DeadKey            = "jobs:dead"
	VisibilityTimeoutS = 60
)

var claimScript = redis.NewScript(\`
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then return false end
redis.call('ZADD', KEYS[2], ARGV[1], job_id)
redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
return job_id
\`)

var ackScript = redis.NewScript(\`
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
\`)

var returnScript = redis.NewScript(\`
local returned = {}
for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms', 'next_retry_at_ms')
    table.insert(returned, job_id)
  end
end
return returned
\`)

var retryScript = redis.NewScript(\`
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], 'state', 'retrying', 'next_retry_at_ms', ARGV[1])
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
\`)

var buryScript = redis.NewScript(\`
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'dead', 'dead_reason', ARGV[2])
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms', 'next_retry_at_ms')
redis.call('RPUSH', KEYS[3], ARGV[1])
return 1
\`)

// Claim moves the next queued job into jobs:inflight under the visibility timeout; its id, or "".
func Claim(ctx context.Context, worker string) (string, error) {
	deadline := time.Now().Add(VisibilityTimeoutS * time.Second).UnixMilli()
	jobID, err := claimScript.Run(ctx, rdb, []string{QueueKey, InflightKey}, deadline, worker).Text()
	if err == redis.Nil {
		return "", nil
	}
	return jobID, err
}

// Ack completes the job if worker still holds its claim; false when the claim is gone.
func Ack(ctx context.Context, jobID, worker string) (bool, error) {
	n, err := ackScript.Run(ctx, rdb, []string{InflightKey, "job:" + jobID}, worker, jobID).Int64()
	return n == 1, err
}

// ReturnExpired puts every claim past its deadline (and every retry now due) back at the head of
// the queue, and returns their ids.
func ReturnExpired(ctx context.Context) ([]string, error) {
	return returnScript.Run(ctx, rdb, []string{InflightKey, QueueKey}, time.Now().UnixMilli()).StringSlice()
}

// RetryLater releases the claim and schedules the next attempt: ReturnExpired requeues the job at atMs.
func RetryLater(ctx context.Context, jobID string, atMs int64) error {
	return retryScript.Run(ctx, rdb, []string{InflightKey, "job:" + jobID}, atMs, jobID).Err()
}

// Bury moves the job to the dead letter (jobs:dead) with its reason; it is never retried.
func Bury(ctx context.Context, jobID, reason string) error {
	return buryScript.Run(ctx, rdb, []string{InflightKey, "job:" + jobID, DeadKey}, jobID, reason).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'jobs/store.h': `// The job records (provided). kJobTypes is the registry: each job type's payload schema, field
// name to "string" or "integer", closed (a field it does not list is rejected). A job is the Redis
// hash job:{id} with job_id, tenant, type, payload (JSON), state (queued, running, retrying,
// completed or dead), attempts and enqueued_at_ms, plus worker and deadline_ms while it is claimed,
// next_retry_at_ms while a retry is scheduled and dead_reason once it is buried. job:{id}:attempts
// lists every attempt's outcome; jobs:outbox holds the job.event records the broker refused. A
// field that does not apply reads as "" or 0.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

struct Job {
  std::string job_id;
  std::string tenant;
  std::string type;
  nlohmann::json payload;
  std::string state;
  long attempts = 0;
  std::string worker;
  long long deadline_ms = 0;
  long long next_retry_at_ms = 0;
  std::string dead_reason;
};

// One attempt's outcome; error is "" for an attempt that succeeded.
struct Attempt {
  long attempt = 0;
  std::string error;
  long long at_ms = 0;
};

inline const std::map<std::string, std::map<std::string, std::string>> kJobTypes = {
    {"email.send", {{"to", "string"}, {"template", "string"}}},
    {"invoice.charge", {{"invoice_id", "string"}, {"amount_cents", "integer"}}},
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

inline std::string jobKey(const std::string& job_id) { return "job:" + job_id; }

inline std::string dedupeKey(const std::string& tenant, const std::string& key) { return "jobs:dedupe:" + tenant + ":" + key; }

// The first path of payload the type's schema rejects (missing, wrong type, not in the schema), or "".
inline std::string validatePayload(const std::string& job_type, const nlohmann::json& payload) {
  const auto& schema = kJobTypes.at(job_type);
  if (!payload.is_object()) return "payload";
  for (const auto& [name, kind] : schema) {
    if (!payload.contains(name)) return "payload." + name;
    const nlohmann::json& value = payload[name];
    const bool ok = kind == "integer" ? value.is_number_integer() : value.is_string();
    if (!ok) return "payload." + name;
  }
  for (const auto& [name, value] : payload.items()) {
    if (schema.count(name) == 0) return "payload." + name;
  }
  return "";
}

inline std::string newJobId() { return "job-" + std::to_string(redis().incr("jobs:seq")); }

// Write the job record as queued and append the job to jobs:queue.
inline void createJob(const std::string& job_id, const std::string& tenant, const std::string& job_type, const nlohmann::json& payload) {
  redis().hset(jobKey(job_id), {{"job_id", job_id},
                                {"tenant", tenant},
                                {"type", job_type},
                                {"payload", payload.dump()},
                                {"state", "queued"},
                                {"attempts", "0"},
                                {"enqueued_at_ms", std::to_string(nowMs())}});
  redis().rpush("jobs:queue", job_id);
}

// The job record, if it exists.
inline std::optional<Job> getJob(const std::string& job_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(jobKey(job_id), std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0LL : std::stoll(text(name)); };
  Job job;
  job.job_id = text("job_id");
  job.tenant = text("tenant");
  job.type = text("type");
  job.payload = nlohmann::json::parse(text("payload").empty() ? "{}" : text("payload"));
  job.state = text("state");
  job.attempts = static_cast<long>(number("attempts"));
  job.worker = text("worker");
  job.deadline_ms = number("deadline_ms");
  job.next_retry_at_ms = number("next_retry_at_ms");
  job.dead_reason = text("dead_reason");
  return job;
}

// Count one more attempt on the job record; returns its number (1 for the first).
inline long beginAttempt(const std::string& job_id) { return static_cast<long>(redis().hincrby(jobKey(job_id), "attempts", 1)); }

// Append the attempt's outcome to the job's history; error is "" for an attempt that succeeded.
inline void recordAttempt(const std::string& job_id, long attempt, const std::string& error) {
  redis().rpush("job:" + job_id + ":attempts", nlohmann::json{{"attempt", attempt}, {"error", error}, {"at_ms", nowMs()}}.dump());
}

// Every attempt's outcome, oldest first.
inline std::vector<Attempt> attemptHistory(const std::string& job_id) {
  std::vector<std::string> entries;
  redis().lrange("job:" + job_id + ":attempts", 0, -1, std::back_inserter(entries));
  std::vector<Attempt> out;
  for (const std::string& entry : entries) {
    const auto e = nlohmann::json::parse(entry);
    out.push_back(Attempt{e.value("attempt", 0L), e.value("error", ""), e.value("at_ms", 0LL)});
  }
  return out;
}

// Keep a job.event the broker refused, for the relay that republishes it.
inline void outboxAdd(const nlohmann::json& event) { redis().rpush("jobs:outbox", event.dump()); }

}  // namespace store
`,
  'jobs/queue.h': `// The queue (provided; step 2 builds claim, ack and returnExpired the same way). jobs:queue lists
// the job ids waiting to run; jobs:inflight is a sorted set of the claimed and retrying job ids,
// scored by the millisecond time the claim expires or the retry is due; jobs:dead lists the buried
// jobs. Every move between them is one Lua script, so a job is always in exactly one of them.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

namespace queue {

inline const std::string kQueueKey = "jobs:queue";
inline const std::string kInflightKey = "jobs:inflight";
inline const std::string kDeadKey = "jobs:dead";
inline constexpr long long kVisibilityTimeoutS = 60;

inline const std::string kClaimLua = R"lua(
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then return false end
redis.call('ZADD', KEYS[2], ARGV[1], job_id)
redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
return job_id
)lua";

inline const std::string kAckLua = R"lua(
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
)lua";

inline const std::string kReturnLua = R"lua(
local returned = {}
for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms', 'next_retry_at_ms')
    table.insert(returned, job_id)
  end
end
return returned
)lua";

inline const std::string kRetryLua = R"lua(
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], 'state', 'retrying', 'next_retry_at_ms', ARGV[1])
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
)lua";

inline const std::string kBuryLua = R"lua(
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'dead', 'dead_reason', ARGV[2])
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms', 'next_retry_at_ms')
redis.call('RPUSH', KEYS[3], ARGV[1])
return 1
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Move the next queued job into jobs:inflight under the visibility timeout; its id, if one was queued.
inline std::optional<std::string> claim(const std::string& worker) {
  const std::string deadline = std::to_string(nowMs() + kVisibilityTimeoutS * 1000);
  const auto job_id = redis().eval<sw::redis::OptionalString>(kClaimLua, {kQueueKey, kInflightKey}, {deadline, worker});
  if (!job_id) return std::nullopt;
  return *job_id;
}

// Complete the job if worker still holds its claim; false when the claim is gone.
inline bool ack(const std::string& job_id, const std::string& worker) {
  return redis().eval<long long>(kAckLua, {kInflightKey, "job:" + job_id}, {worker, job_id}) == 1;
}

// Put every claim past its deadline (and every retry now due) back at the head of the queue.
inline std::vector<std::string> returnExpired() {
  return redis().eval<std::vector<std::string>>(kReturnLua, {kInflightKey, kQueueKey}, {std::to_string(nowMs())});
}

// Release the claim and schedule the next attempt: returnExpired requeues the job at at_ms.
inline void retryLater(const std::string& job_id, long long at_ms) {
  redis().eval<long long>(kRetryLua, {kInflightKey, "job:" + job_id}, {std::to_string(at_ms), job_id});
}

// Move the job to the dead letter (jobs:dead) with its reason; it is never retried.
inline void bury(const std::string& job_id, const std::string& reason) {
  redis().eval<long long>(kBuryLua, {kInflightKey, "job:" + job_id, kDeadKey}, {job_id, reason});
}

}  // namespace queue
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('jobs', 'Store')]: `package jobs

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The job records (provided). JobTypes is the registry: each job type's payload schema, field name
 * to "string" or "integer", closed (a field it does not list is rejected). A job is the Redis hash
 * job:{id} with job_id, tenant, type, payload (JSON), state (queued, running, retrying, completed or
 * dead), attempts and enqueued_at_ms, plus worker and deadline_ms while it is claimed,
 * next_retry_at_ms while a retry is scheduled and dead_reason once it is buried. job:{id}:attempts
 * lists every attempt's outcome; jobs:outbox holds the job.event records the broker refused.
 */
object Store {
  final case class Job(
      jobId: String,
      tenant: String,
      jobType: String,
      payload: JsObject,
      state: String,
      attempts: Int,
      worker: Option[String],
      deadlineMs: Option[Long],
      nextRetryAtMs: Option[Long],
      deadReason: Option[String])

  /** One attempt's outcome; error is "" for an attempt that succeeded. */
  final case class Attempt(attempt: Int, error: String, atMs: Long)

  val JobTypes: Map[String, Map[String, String]] = Map(
    "email.send" -> Map("to" -> "string", "template" -> "string"),
    "invoice.charge" -> Map("invoice_id" -> "string", "amount_cents" -> "integer"))

  val jedis = new JedisPooled("redis", 6379)

  def jobKey(jobId: String): String = s"job:$jobId"
  def dedupeKey(tenant: String, key: String): String = s"jobs:dedupe:$tenant:$key"

  private def fits(value: JsValue, kind: String): Boolean = (value, kind) match {
    case (JsString(_), "string") => true
    case (JsNumber(n), "integer") => n.isWhole
    case _ => false
  }

  /** The first path of payload the type's schema rejects (missing, wrong type, not in the schema). */
  def validatePayload(jobType: String, payload: JsValue): Option[String] = {
    val schema = JobTypes(jobType)
    payload match {
      case JsObject(fields) =>
        schema.keys.toSeq.sorted
          .find(name => !fields.get(name).exists(fits(_, schema(name))))
          .orElse(fields.keys.toSeq.sorted.find(name => !schema.contains(name)))
          .map(name => s"payload.$name")
      case _ => Some("payload")
    }
  }

  def newJobId(): String = s"job-\${jedis.incr("jobs:seq")}"

  /** Write the job record as queued and append the job to jobs:queue. */
  def createJob(jobId: String, tenant: String, jobType: String, payload: JsObject): Unit = {
    jedis.hset(
      jobKey(jobId),
      Map(
        "job_id" -> jobId, "tenant" -> tenant, "type" -> jobType, "payload" -> payload.compactPrint,
        "state" -> "queued", "attempts" -> "0", "enqueued_at_ms" -> System.currentTimeMillis.toString).asJava)
    jedis.rpush("jobs:queue", jobId)
  }

  /** The job record, if it exists. */
  def getJob(jobId: String): Option[Job] = {
    val raw = jedis.hgetAll(jobKey(jobId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): Option[String] = raw.get(name).filter(_.nonEmpty)
      Some(Job(raw("job_id"), raw("tenant"), raw("type"), text("payload").getOrElse("{}").parseJson.asJsObject, raw("state"),
        text("attempts").map(_.toInt).getOrElse(0), text("worker"), text("deadline_ms").map(_.toLong),
        text("next_retry_at_ms").map(_.toLong), text("dead_reason")))
    }
  }

  /** Count one more attempt on the job record; returns its number (1 for the first). */
  def beginAttempt(jobId: String): Long = jedis.hincrBy(jobKey(jobId), "attempts", 1)

  /** Append the attempt's outcome to the job's history; error is "" for an attempt that succeeded. */
  def recordAttempt(jobId: String, attempt: Long, error: String): Unit =
    jedis.rpush(s"job:$jobId:attempts",
      JsObject("attempt" -> JsNumber(attempt), "error" -> JsString(error), "at_ms" -> JsNumber(System.currentTimeMillis)).compactPrint)

  /** Every attempt's outcome, oldest first. */
  def attemptHistory(jobId: String): Seq[Attempt] =
    jedis.lrange(s"job:$jobId:attempts", 0, -1).asScala.toSeq.map { entry =>
      val fields = entry.parseJson.asJsObject.fields
      Attempt(fields("attempt").asInstanceOf[JsNumber].value.toInt, fields("error").asInstanceOf[JsString].value,
        fields("at_ms").asInstanceOf[JsNumber].value.toLong)
    }

  /** Keep a job.event the broker refused, for the relay that republishes it. */
  def outboxAdd(event: JsObject): Unit = jedis.rpush("jobs:outbox", event.compactPrint)
}
`,
  [scalaPath('jobs', 'Queue')]: `package jobs

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The queue (provided; step 2 builds claim, ack and returnExpired the same way). jobs:queue lists
 * the job ids waiting to run; jobs:inflight is a sorted set of the claimed and retrying job ids,
 * scored by the millisecond time the claim expires or the retry is due; jobs:dead lists the buried
 * jobs. Every move between them is one Lua script, so a job is always in exactly one of them.
 */
object Queue {
  val QueueKey = "jobs:queue"
  val InflightKey = "jobs:inflight"
  val DeadKey = "jobs:dead"
  val VisibilityTimeoutS = 60L

  val jedis = new JedisPooled("redis", 6379)

  val ClaimLua: String =
    """local job_id = redis.call('LPOP', KEYS[1])
      |if not job_id then return false end
      |redis.call('ZADD', KEYS[2], ARGV[1], job_id)
      |redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
      |return job_id
      |""".stripMargin

  val AckLua: String =
    """if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
      |if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
      |redis.call('HSET', KEYS[2], 'state', 'completed')
      |redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
      |return 1
      |""".stripMargin

  val ReturnLua: String =
    """local returned = {}
      |for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
      |  if redis.call('ZREM', KEYS[1], job_id) == 1 then
      |    redis.call('LPUSH', KEYS[2], job_id)
      |    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
      |    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms', 'next_retry_at_ms')
      |    table.insert(returned, job_id)
      |  end
      |end
      |return returned
      |""".stripMargin

  val RetryLua: String =
    """redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
      |redis.call('HSET', KEYS[2], 'state', 'retrying', 'next_retry_at_ms', ARGV[1])
      |redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
      |return 1
      |""".stripMargin

  val BuryLua: String =
    """redis.call('ZREM', KEYS[1], ARGV[1])
      |redis.call('HSET', KEYS[2], 'state', 'dead', 'dead_reason', ARGV[2])
      |redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms', 'next_retry_at_ms')
      |redis.call('RPUSH', KEYS[3], ARGV[1])
      |return 1
      |""".stripMargin

  private def run(script: String, keys: List[String], args: List[String]): AnyRef = jedis.eval(script, keys.asJava, args.asJava)

  /** Move the next queued job into jobs:inflight under the visibility timeout; its id, if one was queued. */
  def claim(worker: String): Option[String] = {
    val deadline = System.currentTimeMillis + VisibilityTimeoutS * 1000
    Option(run(ClaimLua, List(QueueKey, InflightKey), List(deadline.toString, worker))).map(_.toString)
  }

  /** Complete the job if worker still holds its claim; false when the claim is gone. */
  def ack(jobId: String, worker: String): Boolean =
    run(AckLua, List(InflightKey, s"job:$jobId"), List(worker, jobId)).asInstanceOf[java.lang.Long] == 1L

  /** Put every claim past its deadline (and every retry now due) back at the head of the queue. */
  def returnExpired(): Seq[String] =
    run(ReturnLua, List(InflightKey, QueueKey), List(System.currentTimeMillis.toString))
      .asInstanceOf[java.util.List[AnyRef]].asScala.toSeq.map(_.toString)

  /** Release the claim and schedule the next attempt: returnExpired requeues the job at atMs. */
  def retryLater(jobId: String, atMs: Long): Unit =
    run(RetryLua, List(InflightKey, s"job:$jobId"), List(atMs.toString, jobId))

  /** Move the job to the dead letter (jobs:dead) with its reason; it is never retried. */
  def bury(jobId: String, reason: String): Unit =
    run(BuryLua, List(InflightKey, s"job:$jobId", DeadKey), List(jobId, reason))
}
`,
};
