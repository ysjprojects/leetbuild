import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis attempt counters and one active case per applicant',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it counts an applicant’s
attempts, opens their case and answers the caller. It compiles, it serves the demo, and it hides the
two flaws that make KYC state unsafe under a burst. Review it like the service owner, fix it, and
prove the fix with the checks below.

Implement the Redis state layer behind \`POST /v1/verifications\` and the status read that follows it:

- **One atomic script per decision.** A reservation script moves the attempt bucket
  \`kyc:attempts:{tenant}:{applicant}\` — read, compare against the cap, \`INCR\`, and \`EXPIRE\` in the
  same \`EVAL\` (redis-py \`register_script\`, ioredis \`defineCommand\`, go-redis \`NewScript\`, Jedis
  \`eval\`, redis-plus-plus \`eval\`) — and a second script opens the case create-if-absent. A
  client-side read followed by a write leaves a window where a whole burst reads the same count and
  every submission passes the cap.
- **The cap is 4.** The fifth attempt is refused \`429 Too Many Requests\` with \`Retry-After\` set to
  the seconds left in the bucket, taken from the script’s \`TTL\` and never from a constant. A refused
  attempt must not open a case.
- **The case key is scoped by tenant and applicant:** \`kyc:case:{tenant}:{applicant}\`. A shared key
  hands the second applicant the first one’s case, and a second submission of the same applicant must
  find the case that already exists instead of starting a parallel review.
- **Both keys expire:** the attempt bucket with its attempt window, the case with its own lifetime,
  set inside the script that creates it.
- \`GET /v1/applicants/{id}/status\` reads the same case key, scoped by the caller’s tenant, and
  answers \`404\` when that applicant has no case.

**Failure mode the checks target.** The draft reads the attempt count and writes it back in two round
trips, so a burst slips past the cap; it keys the active case \`kyc:case:active\`, so two applicants
collide on one case; and its refusal carries no \`Retry-After\`, so a refused client retries
immediately.`,
  sequence: {
    participants: ['KYC API', 'Redis'],
    messages: [
      {from: 'KYC API', to: 'Redis', label: 'EVAL reserve · KEYS[kyc:attempts:{tenant}:{applicant}]', kind: 'sync'},
      {from: 'Redis', to: 'KYC API', label: '{allowed=1, remaining=3, ttl=887}', kind: 'reply'},
      {from: 'KYC API', to: 'Redis', label: 'EVAL open case · KEYS[kyc:case:{tenant}:{applicant}]', kind: 'sync'},
      {from: 'Redis', to: 'KYC API', label: '{created=1} / the case that is already open', kind: 'reply'},
      {
        from: 'KYC API',
        to: 'KYC API',
        label: '429 {Retry-After: ttl} when the bucket is full, no case opened',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'One script per decision: the bucket must move server-side. Read the counter, compare it against the cap, `INCR` and set `EXPIRE` inside the same script (`register_script`/`defineCommand`/`NewScript`/`EVAL`). A `GET` followed by `incr` from the client lets a whole burst read the same count and pass the cap together.',
    'Scope the case to the tenant **and** the applicant: `kyc:case:{tenant}:{applicant}`. Inside the same script, create it only when it is absent (`SET ... NX`) and give it its lifetime there, so two concurrent submissions of one applicant converge on a single case instead of two parallel reviews.',
    'The script’s return value is the contract: whether the attempt was allowed, how many are left, and the bucket’s remaining `TTL`. Feed that `TTL` into `Retry-After` on the 429 — a refused client that is handed nothing to wait for retries immediately.',
  ],
  checks: [
    {
      id: 'atomic-attempts',
      title: 'Increments attempts with one atomic script',
      detail:
        'The attempt bucket moves server-side in one script: the counter is read, compared against the cap, `INCR`ed and given its `EXPIRE` in the same `EVAL` — redis-py `register_script`, ioredis `defineCommand`, go-redis `NewScript`, Jedis `eval`, redis-plus-plus `eval`. The draft does a client-side `GET` followed by `incr`, so a burst reads the same count and every submission passes the cap.',
      match: {
        python: {all: [/\bregister_script\b/, /\bINCR\b/, /\bEXPIRE\b/]},
        typescript: {all: [/\bdefineCommand\b/, /\bINCR\b/, /\bEXPIRE\b/]},
        go: {all: [/redis\.NewScript\(/, /\bINCR\b/, /\bEXPIRE\b/]},
        scala: {all: [/\beval\(|\bevalSha\(/, /\bINCR\b/, /\bEXPIRE\b/]},
        cpp: {all: [/\beval\(/, /\bINCR\b/, /\bEXPIRE\b/]},
      },
    },
    {
      id: 'single-case',
      title: 'Opens one active case per applicant, atomically',
      detail:
        'The active case is created create-if-absent inside the script that also gives it its lifetime: `SET ... NX`, guarded by an `EXISTS` check or by the `SET` result, so two concurrent submissions of one applicant converge on a single case. The draft checks `exists` and then `set`s from the client, so both submissions open a case.',
      match: {
        python: {all: [/\bSET\b/, /\bNX\b/]},
        typescript: {all: [/\bSET\b/, /\bNX\b/]},
        go: {all: [/\bSET\b/, /\bNX\b/]},
        scala: {all: [/\bSET\b/, /\bNX\b/]},
        cpp: {all: [/\bSET\b/, /\bNX\b/]},
      },
    },
    {
      id: 'case-key-scope',
      title: 'Scopes the active case key by tenant and applicant',
      detail:
        'The case key is `kyc:case:{tenant}:{applicant}` — tenant and applicant, so two applicants never collide on one case and a tenant cannot read another tenant’s applicant. The draft keys it `kyc:case:active`: one case for the whole service.',
      match: {
        python: {all: [/kyc:case:/, /applicant/], none: [/kyc:case:active/]},
        typescript: {all: [/kyc:case:/, /applicant/], none: [/kyc:case:active/]},
        go: {all: [/kyc:case:/, /applicant/], none: [/kyc:case:active/]},
        scala: {all: [/kyc:case:/, /applicant/], none: [/kyc:case:active/]},
        cpp: {all: [/kyc:case:/, /applicant/], none: [/kyc:case:active/]},
      },
    },
    {
      id: 'cap-refusal',
      title: 'Refuses the fifth attempt with 429',
      detail:
        'Attempts past the cap of 4 are refused with `429 Too Many Requests`, spelled as the literal status the client gets: `status_code=429`, `reply.code(429)`, `http.StatusTooManyRequests`, `StatusCodes.TooManyRequests`, `429`. The draft answers through its own spelling of the status, so the refusal it sends is not the 429 a full bucket owes.',
      match: {
        python: {all: [/status_code\s*=\s*429/]},
        typescript: {all: [/code\(\s*429\s*\)/]},
        go: {all: [/StatusTooManyRequests/]},
        scala: {all: [/StatusCodes\.TooManyRequests/]},
        cpp: {all: [/\b429\b/]},
      },
    },
    {
      id: 'retry-after',
      title: 'Reports the remaining window in Retry-After',
      detail:
        'A refused attempt answers with `Retry-After` holding the seconds left in the bucket — the `TTL` the script returned — so a client waits the window out instead of retrying immediately. The draft refuses without either.',
      match: {
        python: {all: [/Retry-After/, /TTL|EXPIRE/]},
        typescript: {all: [/Retry-After/, /TTL|EXPIRE/]},
        go: {all: [/Retry-After/, /TTL|EXPIRE/]},
        scala: {all: [/Retry-After/, /TTL|EXPIRE/]},
        cpp: {all: [/Retry-After/, /TTL|EXPIRE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/verifications: a model-generated draft of the KYC attempt and case state."""
import json

import redis
from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_ATTEMPTS = 4
ATTEMPT_WINDOW_S = 900
CASE_TTL_S = 86400


class Document(BaseModel):
    type: str
    ref: str


class SubmitRequest(BaseModel):
    applicant: str
    documents: list[Document]
    status: str | None = None


def attempts_key(tenant: str, applicant: str) -> str:
    return f"kyc:attempts:{tenant}:{applicant}"


def case_key(tenant: str, applicant: str) -> str:
    return "kyc:case:active"


def reserve_attempt(tenant: str, applicant: str) -> tuple[bool, int, int]:
    # TODO: the count is read and written in two round trips, so a burst of submissions of one
    # applicant passes the cap together. Move the whole reservation into one script that INCRs and
    # EXPIREs the bucket, and return the key's remaining window.
    key = attempts_key(tenant, applicant)
    used = int(r.get(key) or 0)
    if used >= MAX_ATTEMPTS:
        return False, 0, ATTEMPT_WINDOW_S
    r.incr(key)
    r.expire(key, ATTEMPT_WINDOW_S)
    return True, MAX_ATTEMPTS - used - 1, ATTEMPT_WINDOW_S


def open_case(tenant: str, applicant: str) -> tuple[bool, dict]:
    # TODO: the case key carries no applicant, so two applicants collide on one case and a second
    # submission replaces the first one's case. Scope the key to kyc:case:{tenant}:{applicant} and
    # open it create-if-absent with SET ... NX inside the script that gives it its lifetime.
    key = case_key(tenant, applicant)
    record = {"applicant": applicant, "status": "pending"}
    if r.exists(key):
        return False, json.loads(r.get(key) or json.dumps(record))
    r.set(key, json.dumps(record))
    r.expire(key, CASE_TTL_S)
    return True, record


@app.post("/v1/verifications")
def submit(body: SubmitRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    allowed, remaining, _window = reserve_attempt(tenant, body.applicant)
    if not allowed:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="attempt cap reached")
    created, record = open_case(tenant, body.applicant)
    return {"case": record, "case_created": created, "attempts_remaining": remaining}


@app.get("/v1/applicants/{applicant_id}/status")
def case_status(applicant_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    raw = r.get(case_key(tenant, applicant_id))
    if raw is None:
        raise HTTPException(status_code=404, detail="no case for this applicant")
    return json.loads(raw)
`,
      solution: `"""POST /v1/verifications: one atomic script per decision, keys scoped and expiring."""
import json

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_ATTEMPTS = 4
ATTEMPT_WINDOW_S = 900
CASE_TTL_S = 86400

RESERVE_ATTEMPTS_LUA = """
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local cap = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
if used >= cap then
  local left = redis.call('TTL', KEYS[1])
  if left < 0 then left = window end
  return {0, 0, left}
end
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], window)
end
local left = redis.call('TTL', KEYS[1])
if left < 0 then left = window end
return {1, cap - count, left}
"""

OPEN_CASE_LUA = """
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if created then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return {1, tonumber(ARGV[2])}
end
return {0, redis.call('TTL', KEYS[1])}
"""

reserve_attempts = r.register_script(RESERVE_ATTEMPTS_LUA)
open_case_script = r.register_script(OPEN_CASE_LUA)


class Document(BaseModel):
    type: str
    ref: str


class SubmitRequest(BaseModel):
    applicant: str
    documents: list[Document]
    status: str | None = None


def attempts_key(tenant: str, applicant: str) -> str:
    return f"kyc:attempts:{tenant}:{applicant}"


def case_key(tenant: str, applicant: str) -> str:
    return f"kyc:case:{tenant}:{applicant}"


def reserve_attempt(tenant: str, applicant: str) -> tuple[bool, int, int]:
    """Move the attempt bucket in one round trip and report the window it has left."""
    allowed, remaining, retry_after = reserve_attempts(
        keys=[attempts_key(tenant, applicant)], args=[MAX_ATTEMPTS, ATTEMPT_WINDOW_S]
    )
    return bool(allowed), int(remaining), int(retry_after)


def open_case(tenant: str, applicant: str) -> tuple[bool, dict]:
    """Open the applicant's single active case, or return the case that is already open."""
    record = {"applicant": applicant, "status": "pending"}
    payload = json.dumps(record)
    created, _expires_in = open_case_script(keys=[case_key(tenant, applicant)], args=[payload, CASE_TTL_S])
    if created:
        return True, record
    return False, json.loads(r.get(case_key(tenant, applicant)) or payload)


@app.post("/v1/verifications")
def submit(body: SubmitRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    allowed, remaining, retry_after = reserve_attempt(tenant, body.applicant)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="attempt cap reached",
            headers={"Retry-After": str(max(retry_after, 1))},
        )
    created, record = open_case(tenant, body.applicant)
    return {"case": record, "case_created": created, "attempts_remaining": remaining}


@app.get("/v1/applicants/{applicant_id}/status")
def case_status(applicant_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    raw = r.get(case_key(tenant, applicant_id))
    if raw is None:
        raise HTTPException(status_code=404, detail="no case for this applicant")
    return json.loads(raw)
`,
    },
    typescript: {
      starter: `/** POST /v1/verifications: a model-generated draft of the KYC attempt and case state. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MAX_ATTEMPTS = 4;
const ATTEMPT_WINDOW_S = 900;
const CASE_TTL_S = 86_400;
const CAP_REFUSAL = 429;

interface Document {
  type: string;
  ref: string;
}

interface SubmitRequest {
  applicant: string;
  documents: Document[];
  status?: string;
}

const attemptsKey = (tenant: string, applicant: string): string => \`kyc:attempts:\${tenant}:\${applicant}\`;

const caseKey = (_tenant: string, _applicant: string): string => 'kyc:case:active';

async function reserveAttempt(tenant: string, applicant: string): Promise<[boolean, number, number]> {
  // TODO: the count is read and written in two round trips, so a burst of submissions of one
  // applicant passes the cap together. Move the whole reservation into one defineCommand script
  // that INCRs and EXPIREs the bucket and returns the window it has left.
  const key = attemptsKey(tenant, applicant);
  const used = Number((await r.get(key)) ?? 0);
  if (used >= MAX_ATTEMPTS) return [false, 0, ATTEMPT_WINDOW_S];
  await r.incr(key);
  await r.expire(key, ATTEMPT_WINDOW_S);
  return [true, MAX_ATTEMPTS - used - 1, ATTEMPT_WINDOW_S];
}

async function openCase(tenant: string, applicant: string): Promise<[boolean, Record<string, string>]> {
  // TODO: the case key carries no applicant, so two applicants collide on one case and a second
  // submission replaces the first one's case. Scope the key to kyc:case:{tenant}:{applicant} and
  // open it create-if-absent with SET ... NX inside the script that gives it its lifetime.
  const key = caseKey(tenant, applicant);
  const record = {applicant, status: 'pending'};
  if (await r.exists(key)) {
    return [false, JSON.parse((await r.get(key)) ?? JSON.stringify(record)) as Record<string, string>];
  }
  await r.set(key, JSON.stringify(record));
  await r.expire(key, CASE_TTL_S);
  return [true, record];
}

app.post('/v1/verifications', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as SubmitRequest;
  const [allowed, remaining] = await reserveAttempt(tenant, body.applicant);
  if (!allowed) return reply.code(CAP_REFUSAL).send({error: 'attempt cap reached'});
  const [created, record] = await openCase(tenant, body.applicant);
  return reply.code(200).send({case: record, case_created: created, attempts_remaining: remaining});
});

app.get('/v1/applicants/:applicantId/status', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {applicantId} = request.params as {applicantId: string};
  const raw = await r.get(caseKey(tenant, applicantId));
  if (raw === null) return reply.code(404).send({error: 'no case for this applicant'});
  return reply.code(200).send(JSON.parse(raw));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/verifications: one atomic script per decision, keys scoped and expiring. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const MAX_ATTEMPTS = 4;
const ATTEMPT_WINDOW_S = 900;
const CASE_TTL_S = 86_400;

const RESERVE_ATTEMPTS_LUA = \`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local cap = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
if used >= cap then
  local left = redis.call('TTL', KEYS[1])
  if left < 0 then left = window end
  return {0, 0, left}
end
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], window)
end
local left = redis.call('TTL', KEYS[1])
if left < 0 then left = window end
return {1, cap - count, left}
\`;

const OPEN_CASE_LUA = \`
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if created then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return {1, tonumber(ARGV[2])}
end
return {0, redis.call('TTL', KEYS[1])}
\`;

r.defineCommand('reserveAttempts', {numberOfKeys: 1, lua: RESERVE_ATTEMPTS_LUA});
r.defineCommand('openCase', {numberOfKeys: 1, lua: OPEN_CASE_LUA});

/** The two custom commands registered above; the typed surface the handlers call. */
interface StateCommands {
  reserveAttempts(key: string, cap: number, windowSeconds: number): Promise<[number, number, number]>;
  openCase(key: string, payload: string, ttlSeconds: number): Promise<[number, number]>;
}

const state = r as unknown as StateCommands;

interface Document {
  type: string;
  ref: string;
}

interface SubmitRequest {
  applicant: string;
  documents: Document[];
  status?: string;
}

const attemptsKey = (tenant: string, applicant: string): string => \`kyc:attempts:\${tenant}:\${applicant}\`;

const caseKey = (tenant: string, applicant: string): string => \`kyc:case:\${tenant}:\${applicant}\`;

async function reserveAttempt(tenant: string, applicant: string): Promise<[boolean, number, number]> {
  const [allowed, remaining, retryAfter] = await state.reserveAttempts(
    attemptsKey(tenant, applicant),
    MAX_ATTEMPTS,
    ATTEMPT_WINDOW_S,
  );
  return [allowed === 1, remaining, retryAfter];
}

async function openCase(tenant: string, applicant: string): Promise<[boolean, Record<string, string>]> {
  const record = {applicant, status: 'pending'};
  const key = caseKey(tenant, applicant);
  const [created] = await state.openCase(key, JSON.stringify(record), CASE_TTL_S);
  if (created === 1) return [true, record];
  return [false, JSON.parse((await r.get(key)) ?? JSON.stringify(record)) as Record<string, string>];
}

app.post('/v1/verifications', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as SubmitRequest;
  const [allowed, remaining, retryAfter] = await reserveAttempt(tenant, body.applicant);
  if (!allowed) {
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(retryAfter, 1)))
      .send({error: 'attempt cap reached'});
  }
  const [created, record] = await openCase(tenant, body.applicant);
  return reply.code(200).send({case: record, case_created: created, attempts_remaining: remaining});
});

app.get('/v1/applicants/:applicantId/status', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {applicantId} = request.params as {applicantId: string};
  const raw = await r.get(caseKey(tenant, applicantId));
  if (raw === null) return reply.code(404).send({error: 'no case for this applicant'});
  return reply.code(200).send(JSON.parse(raw));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// POST /v1/verifications: a model-generated draft of the KYC attempt and case state.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxAttempts    = 4
	attemptWindowS = 900
	caseTTLSeconds = 86400
)

var rdb *redis.Client

type document struct {
	Type string \`json:"type"\`
	Ref  string \`json:"ref"\`
}

type submitRequest struct {
	Applicant string     \`json:"applicant"\`
	Documents []document \`json:"documents"\`
	Status    string     \`json:"status,omitempty"\`
}

func attemptsKey(tenant, applicant string) string {
	return fmt.Sprintf("kyc:attempts:%s:%s", tenant, applicant)
}

func caseKey(_, _ string) string {
	return "kyc:case:active"
}

func reserveAttempt(ctx context.Context, tenant, applicant string) (bool, int64, int64, error) {
	// TODO: the count is read and written in two round trips, so a burst of submissions of one
	// applicant passes the cap together. Move the whole reservation into one redis.NewScript that
	// INCRs and EXPIREs the bucket and returns the window it has left.
	key := attemptsKey(tenant, applicant)
	used, err := rdb.Get(ctx, key).Int64()
	if err != nil && err != redis.Nil {
		return false, 0, 0, err
	}
	if used >= maxAttempts {
		return false, 0, attemptWindowS, nil
	}
	count, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return false, 0, 0, err
	}
	rdb.Expire(ctx, key, time.Duration(attemptWindowS)*time.Second)
	return true, maxAttempts - count, attemptWindowS, nil
}

func openCase(ctx context.Context, tenant, applicant string) (bool, map[string]any, error) {
	// TODO: the case key carries no applicant, so two applicants collide on one case and a second
	// submission replaces the first one's case. Scope the key to kyc:case:{tenant}:{applicant} and
	// open it create-if-absent with SET ... NX inside the script that gives it its lifetime.
	record := map[string]any{"applicant": applicant, "status": "pending"}
	key := caseKey(tenant, applicant)
	exists, err := rdb.Exists(ctx, key).Result()
	if err != nil {
		return false, nil, err
	}
	if exists > 0 {
		raw, err := rdb.Get(ctx, key).Bytes()
		if err != nil {
			return false, record, nil
		}
		var stored map[string]any
		if err := json.Unmarshal(raw, &stored); err != nil {
			return false, record, nil
		}
		return false, stored, nil
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return false, nil, err
	}
	if err := rdb.Set(ctx, key, payload, time.Duration(caseTTLSeconds)*time.Second).Err(); err != nil {
		return false, nil, err
	}
	return true, record, nil
}

func handleSubmit(rw http.ResponseWriter, req *http.Request) {
	tenant := req.Header.Get("X-Tenant-Id")
	var body submitRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(rw, \`{"error":"invalid body"}\`, http.StatusBadRequest)
		return
	}
	allowed, remaining, _, err := reserveAttempt(req.Context(), tenant, body.Applicant)
	if err != nil {
		http.Error(rw, \`{"error":"state unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	if !allowed {
		rw.WriteHeader(429)
		_, _ = rw.Write([]byte(\`{"error":"attempt cap reached"}\`))
		return
	}
	created, record, err := openCase(req.Context(), tenant, body.Applicant)
	if err != nil {
		http.Error(rw, \`{"error":"state unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(rw).Encode(map[string]any{
		"case":               record,
		"case_created":       created,
		"attempts_remaining": remaining,
	})
}

func handleStatus(rw http.ResponseWriter, req *http.Request) {
	tenant := req.Header.Get("X-Tenant-Id")
	raw, err := rdb.Get(req.Context(), caseKey(tenant, req.PathValue("id"))).Bytes()
	rw.Header().Set("Content-Type", "application/json")
	if err != nil {
		rw.WriteHeader(http.StatusNotFound)
		_, _ = rw.Write([]byte(\`{"error":"no case for this applicant"}\`))
		return
	}
	_, _ = rw.Write(raw)
}

func main() {
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	http.HandleFunc("POST /v1/verifications", handleSubmit)
	http.HandleFunc("GET /v1/applicants/{id}/status", handleStatus)
	_ = http.ListenAndServe(":8443", nil)
}
`,
      solution: `// POST /v1/verifications: one atomic script per decision, keys scoped and expiring.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxAttempts    = 4
	attemptWindowS = 900
	caseTTLSeconds = 86400
)

var rdb *redis.Client

var reserveAttemptsScript = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local cap = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
if used >= cap then
  local left = redis.call('TTL', KEYS[1])
  if left < 0 then left = window end
  return {0, 0, left}
end
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], window)
end
local left = redis.call('TTL', KEYS[1])
if left < 0 then left = window end
return {1, cap - count, left}
\`)

var openCaseScript = redis.NewScript(\`
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if created then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return {1, tonumber(ARGV[2])}
end
return {0, redis.call('TTL', KEYS[1])}
\`)

type document struct {
	Type string \`json:"type"\`
	Ref  string \`json:"ref"\`
}

type submitRequest struct {
	Applicant string     \`json:"applicant"\`
	Documents []document \`json:"documents"\`
	Status    string     \`json:"status,omitempty"\`
}

func attemptsKey(tenant, applicant string) string {
	return fmt.Sprintf("kyc:attempts:%s:%s", tenant, applicant)
}

func caseKey(tenant, applicant string) string {
	return fmt.Sprintf("kyc:case:%s:%s", tenant, applicant)
}

func reserveAttempt(ctx context.Context, tenant, applicant string) (bool, int64, int64, error) {
	values, err := reserveAttemptsScript.
		Run(ctx, rdb, []string{attemptsKey(tenant, applicant)}, maxAttempts, attemptWindowS).
		Int64Slice()
	if err != nil {
		return false, 0, 0, err
	}
	return values[0] == 1, values[1], values[2], nil
}

func openCase(ctx context.Context, tenant, applicant string) (bool, map[string]any, error) {
	record := map[string]any{"applicant": applicant, "status": "pending"}
	payload, err := json.Marshal(record)
	if err != nil {
		return false, nil, err
	}
	key := caseKey(tenant, applicant)
	values, err := openCaseScript.Run(ctx, rdb, []string{key}, payload, caseTTLSeconds).Int64Slice()
	if err != nil {
		return false, nil, err
	}
	if values[0] == 1 {
		return true, record, nil
	}
	raw, err := rdb.Get(ctx, key).Bytes()
	if err != nil {
		return false, record, nil
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		return false, record, nil
	}
	return false, stored, nil
}

func handleSubmit(rw http.ResponseWriter, req *http.Request) {
	tenant := req.Header.Get("X-Tenant-Id")
	var body submitRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		http.Error(rw, \`{"error":"invalid body"}\`, http.StatusBadRequest)
		return
	}
	allowed, remaining, retryAfter, err := reserveAttempt(req.Context(), tenant, body.Applicant)
	if err != nil {
		http.Error(rw, \`{"error":"state unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	if !allowed {
		rw.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		rw.WriteHeader(http.StatusTooManyRequests)
		_, _ = rw.Write([]byte(\`{"error":"attempt cap reached"}\`))
		return
	}
	created, record, err := openCase(req.Context(), tenant, body.Applicant)
	if err != nil {
		http.Error(rw, \`{"error":"state unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(rw).Encode(map[string]any{
		"case":               record,
		"case_created":       created,
		"attempts_remaining": remaining,
	})
}

func handleStatus(rw http.ResponseWriter, req *http.Request) {
	tenant := req.Header.Get("X-Tenant-Id")
	raw, err := rdb.Get(req.Context(), caseKey(tenant, req.PathValue("id"))).Bytes()
	rw.Header().Set("Content-Type", "application/json")
	if err != nil {
		rw.WriteHeader(http.StatusNotFound)
		_, _ = rw.Write([]byte(\`{"error":"no case for this applicant"}\`))
		return
	}
	_, _ = rw.Write(raw)
}

func main() {
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	http.HandleFunc("POST /v1/verifications", handleSubmit)
	http.HandleFunc("GET /v1/applicants/{id}/status", handleStatus)
	_ = http.ListenAndServe(":8443", nil)
}
`,
    },
    scala: {
      starter: `// POST /v1/verifications: a model-generated draft of the KYC attempt and case state.
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._

final case class Document(\`type\`: String, ref: String)
final case class SubmitRequest(applicant: String, documents: List[Document], status: Option[String])

object KycStateApi {
  implicit val system: ActorSystem = ActorSystem("kycd")
  implicit val documentFormat = jsonFormat2(Document)
  implicit val submitFormat = jsonFormat3(SubmitRequest)

  val MaxAttempts = 4L
  val AttemptWindowSeconds = 900L
  val CaseTtlSeconds = 86400L

  val jedis = new Jedis("redis", 6379)

  def attemptsKey(tenant: String, applicant: String): String = s"kyc:attempts:$tenant:$applicant"

  def caseKey(tenant: String, applicant: String): String = "kyc:case:active"

  def reserveAttempt(tenant: String, applicant: String): (Boolean, Long, Long) = {
    // TODO: the count is read and written in two round trips, so a burst of submissions of one
    // applicant passes the cap together. Move the whole reservation into one jedis.eval script that
    // INCRs and EXPIREs the bucket and returns the window it has left.
    val key = attemptsKey(tenant, applicant)
    val used = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (used >= MaxAttempts) {
      (false, 0L, AttemptWindowSeconds)
    } else {
      jedis.incr(key)
      jedis.expire(key, AttemptWindowSeconds)
      (true, MaxAttempts - used - 1L, AttemptWindowSeconds)
    }
  }

  def openCase(tenant: String, applicant: String): (Boolean, String) = {
    // TODO: the case key carries no applicant, so two applicants collide on one case and a second
    // submission replaces the first one's case. Scope the key to kyc:case:{tenant}:{applicant} and
    // open it create-if-absent with SET ... NX inside the script that gives it its lifetime.
    val key = caseKey(tenant, applicant)
    val record = s"""{"applicant":"$applicant","status":"pending"}"""
    if (jedis.exists(key)) {
      (false, Option(jedis.get(key)).getOrElse(record))
    } else {
      jedis.set(key, record)
      jedis.expire(key, CaseTtlSeconds)
      (true, record)
    }
  }

  val route: Route =
    path("v1" / "verifications") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[SubmitRequest]) { body =>
            val (allowed, remaining, _) = reserveAttempt(tenant, body.applicant)
            if (!allowed) {
              complete(
                HttpResponse(
                  status = 429,
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"attempt cap reached"}""")
                )
              )
            } else {
              val (created, record) = openCase(tenant, body.applicant)
              complete(StatusCodes.OK, s"""{"case":$record,"case_created":$created,"attempts_remaining":$remaining}""")
            }
          }
        }
      }
    } ~
      path("v1" / "applicants" / Segment / "status") { applicantId =>
        get {
          headerValueByName("X-Tenant-Id") { tenant =>
            Option(jedis.get(caseKey(tenant, applicantId))) match {
              case Some(raw) =>
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, raw)))
              case None =>
                complete(
                  HttpResponse(
                    StatusCodes.NotFound,
                    entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"no case for this applicant"}""")
                  )
                )
            }
          }
        }
      }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `// POST /v1/verifications: one atomic script per decision, keys scoped and expiring.
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._

final case class Document(\`type\`: String, ref: String)
final case class SubmitRequest(applicant: String, documents: List[Document], status: Option[String])

object KycStateApi {
  implicit val system: ActorSystem = ActorSystem("kycd")
  implicit val documentFormat = jsonFormat2(Document)
  implicit val submitFormat = jsonFormat3(SubmitRequest)

  val MaxAttempts = 4L
  val AttemptWindowSeconds = 900L
  val CaseTtlSeconds = 86400L

  val jedis = new Jedis("redis", 6379)

  val ReserveAttemptsLua =
    """
      |local used = tonumber(redis.call('GET', KEYS[1])) or 0
      |local cap = tonumber(ARGV[1])
      |local window = tonumber(ARGV[2])
      |if used >= cap then
      |  local left = redis.call('TTL', KEYS[1])
      |  if left < 0 then left = window end
      |  return {0, 0, left}
      |end
      |local count = redis.call('INCR', KEYS[1])
      |if count == 1 then
      |  redis.call('EXPIRE', KEYS[1], window)
      |end
      |local left = redis.call('TTL', KEYS[1])
      |if left < 0 then left = window end
      |return {1, cap - count, left}
      |""".stripMargin

  val OpenCaseLua =
    """
      |local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
      |if created then
      |  redis.call('EXPIRE', KEYS[1], ARGV[2])
      |  return {1, tonumber(ARGV[2])}
      |end
      |return {0, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def attemptsKey(tenant: String, applicant: String): String = s"kyc:attempts:$tenant:$applicant"

  def caseKey(tenant: String, applicant: String): String = s"kyc:case:$tenant:$applicant"

  def reserveAttempt(tenant: String, applicant: String): (Boolean, Long, Long) = {
    val result = jedis
      .eval(
        ReserveAttemptsLua,
        1,
        attemptsKey(tenant, applicant),
        MaxAttempts.toString,
        AttemptWindowSeconds.toString
      )
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1), result.get(2))
  }

  def openCase(tenant: String, applicant: String): (Boolean, String) = {
    val record = s"""{"applicant":"$applicant","status":"pending"}"""
    val key = caseKey(tenant, applicant)
    val result = jedis
      .eval(OpenCaseLua, 1, key, record, CaseTtlSeconds.toString)
      .asInstanceOf[java.util.List[Long]]
    if (result.get(0) == 1L) {
      (true, record)
    } else {
      (false, Option(jedis.get(key)).getOrElse(record))
    }
  }

  val route: Route =
    path("v1" / "verifications") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[SubmitRequest]) { body =>
            val (allowed, remaining, retryAfter) = reserveAttempt(tenant, body.applicant)
            if (!allowed) {
              complete(
                HttpResponse(
                  StatusCodes.TooManyRequests,
                  headers = List(RawHeader("Retry-After", math.max(retryAfter, 1L).toString)),
                  entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"attempt cap reached"}""")
                )
              )
            } else {
              val (created, record) = openCase(tenant, body.applicant)
              complete(StatusCodes.OK, s"""{"case":$record,"case_created":$created,"attempts_remaining":$remaining}""")
            }
          }
        }
      }
    } ~
      path("v1" / "applicants" / Segment / "status") { applicantId =>
        get {
          headerValueByName("X-Tenant-Id") { tenant =>
            Option(jedis.get(caseKey(tenant, applicantId))) match {
              case Some(raw) =>
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, raw)))
              case None =>
                complete(
                  HttpResponse(
                    StatusCodes.NotFound,
                    entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"no case for this applicant"}""")
                  )
                )
            }
          }
        }
      }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `// POST /v1/verifications: a model-generated draft of the KYC attempt and case state.
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kMaxAttempts = 4;
constexpr long long kAttemptWindowSeconds = 900;
constexpr long long kCaseTtlSeconds = 86400;

std::string attemptsKey(const std::string& tenant, const std::string& applicant) {
  return "kyc:attempts:" + tenant + ":" + applicant;
}

std::string caseKey(const std::string&, const std::string&) {
  return "kyc:case:active";
}

std::vector<long long> reserveAttempt(
    sw::redis::Redis& redis,
    const std::string& tenant,
    const std::string& applicant) {
  // TODO: the count is read and written in two round trips, so a burst of submissions of one
  // applicant passes the cap together. Move the whole reservation into one Lua script that INCRs and
  // EXPIREs the bucket and returns the window it has left.
  const auto key = attemptsKey(tenant, applicant);
  const auto raw = redis.get(key);
  const long long used = raw ? std::stoll(*raw) : 0;
  if (used >= kMaxAttempts) {
    return {0, 0, kAttemptWindowSeconds};
  }
  const long long count = redis.incr(key);
  redis.expire(key, kAttemptWindowSeconds);
  return {1, kMaxAttempts - count, kAttemptWindowSeconds};
}

std::pair<bool, std::string> openCase(
    sw::redis::Redis& redis,
    const std::string& tenant,
    const std::string& applicant) {
  // TODO: the case key carries no applicant, so two applicants collide on one case and a second
  // submission replaces the first one's case. Scope the key to kyc:case:{tenant}:{applicant} and
  // open it create-if-absent with SET ... NX inside the script that gives it its lifetime.
  const json record = {{"applicant", applicant}, {"status", "pending"}};
  const auto key = caseKey(tenant, applicant);
  if (redis.exists(key)) {
    const auto stored = redis.get(key);
    return {false, stored ? *stored : record.dump()};
  }
  redis.set(key, record.dump());
  redis.expire(key, kCaseTtlSeconds);
  return {true, record.dump()};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/verifications", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const std::string applicant = body.value("applicant", std::string());

    const auto reservation = reserveAttempt(redis, tenant, applicant);
    if (reservation[0] != 1) {
      res.status = 429;
      res.set_content(R"({"error":"attempt cap reached"})", "application/json");
      return;
    }
    const auto opened = openCase(redis, tenant, applicant);
    res.status = 200;
    res.set_content(
        json{{"case", json::parse(opened.second)},
             {"case_created", opened.first},
             {"attempts_remaining", reservation[1]}}
            .dump(),
        "application/json");
  });

  svr.Get(R"(/v1/applicants/([^/]+)/status)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const auto stored = redis.get(caseKey(tenant, req.matches[1]));
    if (!stored) {
      res.status = 404;
      res.set_content(R"({"error":"no case for this applicant"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(*stored, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `// POST /v1/verifications: one atomic script per decision, keys scoped and expiring.
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr long long kMaxAttempts = 4;
constexpr long long kAttemptWindowSeconds = 900;
constexpr long long kCaseTtlSeconds = 86400;

const char* kReserveAttemptsLua = R"LUA(
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local cap = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
if used >= cap then
  local left = redis.call('TTL', KEYS[1])
  if left < 0 then left = window end
  return {0, 0, left}
end
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], window)
end
local left = redis.call('TTL', KEYS[1])
if left < 0 then left = window end
return {1, cap - count, left}
)LUA";

const char* kOpenCaseLua = R"LUA(
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if created then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return {1, tonumber(ARGV[2])}
end
return {0, redis.call('TTL', KEYS[1])}
)LUA";

std::string attemptsKey(const std::string& tenant, const std::string& applicant) {
  return "kyc:attempts:" + tenant + ":" + applicant;
}

std::string caseKey(const std::string& tenant, const std::string& applicant) {
  return "kyc:case:" + tenant + ":" + applicant;
}

/** Runs the reservation script and fills the reply vector with {allowed, remaining, retry_after}. */
std::vector<long long> reserveAttempt(
    sw::redis::Redis& redis,
    const std::string& tenant,
    const std::string& applicant) {
  std::vector<long long> reply;
  redis.eval(
      kReserveAttemptsLua,
      {attemptsKey(tenant, applicant)},
      {std::to_string(kMaxAttempts), std::to_string(kAttemptWindowSeconds)},
      std::back_inserter(reply));
  return reply;
}

std::pair<bool, std::string> openCase(
    sw::redis::Redis& redis,
    const std::string& tenant,
    const std::string& applicant) {
  const json record = {{"applicant", applicant}, {"status", "pending"}};
  const auto key = caseKey(tenant, applicant);
  std::vector<long long> reply;
  redis.eval(
      kOpenCaseLua,
      {key},
      {record.dump(), std::to_string(kCaseTtlSeconds)},
      std::back_inserter(reply));
  if (reply[0] == 1) return {true, record.dump()};
  const auto stored = redis.get(key);
  return {false, stored ? *stored : record.dump()};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/verifications", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const std::string applicant = body.value("applicant", std::string());

    const auto reservation = reserveAttempt(redis, tenant, applicant);
    if (reservation[0] != 1) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(std::max(reservation[2], 1LL)));
      res.set_content(R"({"error":"attempt cap reached"})", "application/json");
      return;
    }
    const auto opened = openCase(redis, tenant, applicant);
    res.status = 200;
    res.set_content(
        json{{"case", json::parse(opened.second)},
             {"case_created", opened.first},
             {"attempts_remaining", reservation[1]}}
            .dump(),
        "application/json");
  });

  svr.Get(R"(/v1/applicants/([^/]+)/status)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const auto stored = redis.get(caseKey(tenant, req.matches[1]));
    if (!stored) {
      res.status = 404;
      res.set_content(R"({"error":"no case for this applicant"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(*stored, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is state that moves in one step and is scoped to the entity it belongs to. A read-then-write attempt counter passes every serial test and fails exactly under a burst, which is when an attempt cap has to hold: two submissions both read three attempts used and both write four. One script per decision makes read, compare, increment and expiry a single step, and the same script returns the bucket’s \`TTL\`, which is what a refusal owes its client in \`Retry-After\`. The case key carries the tenant and the applicant because a case belongs to exactly that pair: the draft’s shared \`kyc:case:active\` key answers the second applicant with the first one’s case and lets one tenant read another tenant’s applicant. \`SET ... NX\` inside the script makes opening a case create-if-absent, so a duplicate submission finds the case that already exists instead of racing a second review into being. Real services keep the case record in the key with a lifetime that matches the review window, keep the attempt bucket short-lived, and write both to an audit trail, because every counter they move is evidence a regulator may ask for.`,
};
