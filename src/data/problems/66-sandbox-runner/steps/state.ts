import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis job leases with hard wall-clock limits',
  concept: 'redis',
  file: 'state',
  focus: ['runner', 'redis'],
  task: `## Task

**Starting point.** The starter is the runner's clock: \`acquire(job_id)\` sets \`lease:{job_id}\`,
then gives it a \`MAX_RUNTIME_S\` (300 s) expiry and notes the start time in a process-local dict;
\`remaining(job_id)\` subtracts the elapsed local time from 300; \`finish(job_id, exit_code, output,
cpu_ms, mem_mb)\` stores the result with \`jobs.put_result\` and deletes the lease. It serves the
demo and hides three flaws.

**Failure mode the checks target.** A runner that dies between the \`SET\` and the \`EXPIRE\` leaves
a lease that never expires, and a second runner restarts the clock; an operator who shortens or
deletes a lease is ignored because the runner trusts its own memory; and a result that arrives
after the deadline is published as the job's result.

- \`acquire\` is **one command**: set the lease only if it does not exist, with its expiry
  (\`SET … NX EX MAX_RUNTIME_S\`), and answer whether it was taken.
- \`remaining\` reads the lease's \`TTL\` from Redis on every call; a missing lease is **0**.
- \`finish\` claims the lease before it stores anything: \`DEL\` answers whether the lease was still
  there, and a lease that already expired means the result is discarded and \`finish\` answers
  false.`,
  sequence: {
    participants: ['Runner', 'Redis', 'job store'],
    messages: [
      {from: 'Runner', to: 'Redis', label: 'SET lease:{id} running NX EX 300', kind: 'sync'},
      {from: 'Redis', to: 'Runner', label: 'OK · nil when another runner holds it', kind: 'reply'},
      {from: 'Runner', to: 'Redis', label: 'TTL lease:{id} (every check)', kind: 'sync'},
      {from: 'Redis', to: 'Runner', label: 'seconds left · -2 once gone', kind: 'reply'},
      {from: 'Runner', to: 'Redis', label: 'DEL lease:{id}', kind: 'sync'},
      {from: 'Redis', to: 'Runner', label: '1 inside the lease · 0 too late', kind: 'reply'},
      {from: 'Runner', to: 'job store', label: 'put_result(id, …) only after a 1', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-lease',
      title: 'Takes the lease with its expiry in one command',
      detail:
        'Right after the first command that writes `lease:{id}` the key already has its 300 s TTL, and a second `acquire` of a held lease answers false without restarting the clock. The starter sets the key, then expires it, and always answers true.',
      match: {
        python: {
          all: [/\.set\([^\n]*(nx\s*=\s*True[^\n]*ex\s*=\s*MAX_RUNTIME_S|ex\s*=\s*MAX_RUNTIME_S[^\n]*nx\s*=\s*True)/],
          none: [/\.expire\(/],
        },
        typescript: {
          all: [/\.set\([^\n]*['"]EX['"],\s*MAX_RUNTIME_S/, /\.set\([^\n]*['"]NX['"]/],
          none: [/\.expire\(/],
        },
        go: {all: [/\.SetNX\([^\n]*maxRuntime|SetArgs\{[^}]*Mode:\s*"NX"/], none: [/\.Expire\(/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(\s*MaxRuntimeS/], none: [/\.expire\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /kMaxRuntimeS/], none: [/\.expire\(/]},
      },
    },
    {
      id: 'lease-authority',
      title: 'Reads the deadline from the lease in Redis',
      detail:
        "`remaining` answers the lease's TTL: an operator who shortens the lease to 30 s or deletes it sees the runner answer 30 or 0. The starter subtracts local elapsed time and never looks at Redis.",
      match: {
        python: {all: [/\.ttl\(\s*lease_key\(/], none: [/monotonic\(|time\.time\(/]},
        typescript: {all: [/\.ttl\(\s*leaseKey\(/], none: [/Date\.now\(|performance\.now\(/]},
        go: {all: [/\.TTL\(\s*ctx,\s*leaseKey\(/], none: [/time\.Since\(|time\.Now\(/]},
        scala: {all: [/jedis\.ttl\(\s*leaseKey\(/], none: [/System\.(nanoTime|currentTimeMillis)/]},
        cpp: {all: [/\.ttl\(\s*leaseKey\(/], none: [/steady_clock|system_clock/]},
      },
    },
    {
      id: 'late-result',
      title: 'Discards a result that arrives after the lease',
      detail:
        'A `finish` 301 s after `acquire` answers false and stores no output; one inside the lease stores the result and releases the lease. The starter stores every result, then deletes the lease.',
      match: {
        python: {order: [/def finish\(/, /\.(delete|exists|ttl)\(\s*lease_key\(/, /jobs\.put_result\(/]},
        typescript: {order: [/function finish\(/, /\.(del|exists|ttl)\(\s*leaseKey\(/, /putResult\(/]},
        go: {order: [/func finish\(/, /\.(Del|Exists|TTL)\(\s*ctx,\s*leaseKey\(/, /jobs\.PutResult\(/]},
        scala: {order: [/def finish\(/, /jedis\.(del|exists|ttl)\(\s*leaseKey\(/, /Jobs\.putResult\(/]},
        cpp: {order: [/bool finish\(/, /\.(del|exists|ttl)\(\s*leaseKey\(/, /jobs::putResult\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from sandbox import jobs  # put_result

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_RUNTIME_S = 300
LEASE_PREFIX = "lease:"

started: dict[str, float] = {}


def lease_key(job_id: str) -> str:
    return LEASE_PREFIX + job_id


def acquire(job_id: str) -> bool:
    """Start the job's clock; True when this runner took the lease."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    r.set(lease_key(job_id), "running")
    r.expire(lease_key(job_id), MAX_RUNTIME_S)
    started[job_id] = time.monotonic()
    return True


def remaining(job_id: str) -> int:
    """Seconds the job may still run."""
    elapsed = time.monotonic() - started.get(job_id, time.monotonic())
    return max(int(MAX_RUNTIME_S - elapsed), 0)


def finish(job_id: str, exit_code: int, output: str, cpu_ms: int, mem_mb: int) -> bool:
    """Record the job's result; True when it was recorded."""
    jobs.put_result(job_id, exit_code, output, cpu_ms, mem_mb)
    r.delete(lease_key(job_id))
    return True
`,
      solution: `import redis

from sandbox import jobs  # put_result

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_RUNTIME_S = 300
LEASE_PREFIX = "lease:"


def lease_key(job_id: str) -> str:
    return LEASE_PREFIX + job_id


def acquire(job_id: str) -> bool:
    """Start the job's clock; True when this runner took the lease."""
    # One command: the key never exists without its expiry, and a second runner cannot restart the clock.
    return bool(r.set(lease_key(job_id), "running", nx=True, ex=MAX_RUNTIME_S))


def remaining(job_id: str) -> int:
    """Seconds the job may still run: the lease's TTL, 0 once it is gone."""
    return max(r.ttl(lease_key(job_id)), 0)


def finish(job_id: str, exit_code: int, output: str, cpu_ms: int, mem_mb: int) -> bool:
    """Record the job's result; True when it was recorded, False when the lease had already expired."""
    # DEL answers whether the lease was still there: checking it and claiming it is one command.
    if r.delete(lease_key(job_id)) == 0:
        return False
    jobs.put_result(job_id, exit_code, output, cpu_ms, mem_mb)
    return True
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {putResult} from 'sandbox/jobs';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_RUNTIME_S = 300;
export const LEASE_PREFIX = 'lease:';

const started = new Map<string, number>();

export const leaseKey = (jobId: string): string => LEASE_PREFIX + jobId;

/** Start the job's clock; true when this runner took the lease. */
export async function acquire(jobId: string): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  await redis.set(leaseKey(jobId), 'running');
  await redis.expire(leaseKey(jobId), MAX_RUNTIME_S);
  started.set(jobId, Date.now());
  return true;
}

/** Seconds the job may still run. */
export async function remaining(jobId: string): Promise<number> {
  const elapsed = (Date.now() - (started.get(jobId) ?? Date.now())) / 1000;
  return Math.max(Math.floor(MAX_RUNTIME_S - elapsed), 0);
}

/** Record the job's result; true when it was recorded. */
export async function finish(jobId: string, exitCode: number, output: string, cpuMs: number, memMb: number): Promise<boolean> {
  await putResult(jobId, exitCode, output, cpuMs, memMb);
  await redis.del(leaseKey(jobId));
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import {putResult} from 'sandbox/jobs';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_RUNTIME_S = 300;
export const LEASE_PREFIX = 'lease:';

export const leaseKey = (jobId: string): string => LEASE_PREFIX + jobId;

/** Start the job's clock; true when this runner took the lease. */
export async function acquire(jobId: string): Promise<boolean> {
  // One command: the key never exists without its expiry, and a second runner cannot restart the clock.
  return (await redis.set(leaseKey(jobId), 'running', 'EX', MAX_RUNTIME_S, 'NX')) === 'OK';
}

/** Seconds the job may still run: the lease's TTL, 0 once it is gone. */
export async function remaining(jobId: string): Promise<number> {
  return Math.max(await redis.ttl(leaseKey(jobId)), 0);
}

/** Record the job's result; true when it was recorded, false when the lease had already expired. */
export async function finish(jobId: string, exitCode: number, output: string, cpuMs: number, memMb: number): Promise<boolean> {
  // DEL answers whether the lease was still there: checking it and claiming it is one command.
  if ((await redis.del(leaseKey(jobId))) === 0) return false;
  await putResult(jobId, exitCode, output, cpuMs, memMb);
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"sandbox/jobs" // jobs.PutResult
)

const (
	maxRuntime  = 300 * time.Second
	leasePrefix = "lease:"
)

var (
	rdb     = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	started = map[string]time.Time{}
)

func leaseKey(jobID string) string { return leasePrefix + jobID }

// acquire starts the job's clock; true when this runner took the lease.
func acquire(ctx context.Context, jobID string) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	if err := rdb.Set(ctx, leaseKey(jobID), "running", 0).Err(); err != nil {
		return false, err
	}
	if err := rdb.Expire(ctx, leaseKey(jobID), maxRuntime).Err(); err != nil {
		return false, err
	}
	started[jobID] = time.Now()
	return true, nil
}

// remaining is the number of seconds the job may still run.
func remaining(ctx context.Context, jobID string) (int, error) {
	start, known := started[jobID]
	if !known {
		start = time.Now()
	}
	left := maxRuntime - time.Since(start)
	if left < 0 {
		return 0, nil
	}
	return int(left / time.Second), nil
}

// finish records the job's result; true when it was recorded.
func finish(ctx context.Context, jobID string, exitCode int, output string, cpuMs, memMB int) (bool, error) {
	jobs.PutResult(ctx, jobID, exitCode, output, cpuMs, memMB)
	return true, rdb.Del(ctx, leaseKey(jobID)).Err()
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"sandbox/jobs" // jobs.PutResult
)

const (
	maxRuntime  = 300 * time.Second
	leasePrefix = "lease:"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func leaseKey(jobID string) string { return leasePrefix + jobID }

// acquire starts the job's clock; true when this runner took the lease.
func acquire(ctx context.Context, jobID string) (bool, error) {
	// One command: the key never exists without its expiry, and a second runner cannot restart the clock.
	return rdb.SetNX(ctx, leaseKey(jobID), "running", maxRuntime).Result()
}

// remaining is the number of seconds the job may still run: the lease's TTL, 0 once it is gone.
func remaining(ctx context.Context, jobID string) (int, error) {
	ttl, err := rdb.TTL(ctx, leaseKey(jobID)).Result()
	if err != nil || ttl < 0 {
		return 0, err
	}
	return int(ttl / time.Second), nil
}

// finish records the job's result; true when it was recorded, false when the lease had already expired.
func finish(ctx context.Context, jobID string, exitCode int, output string, cpuMs, memMB int) (bool, error) {
	// DEL answers whether the lease was still there: checking it and claiming it is one command.
	removed, err := rdb.Del(ctx, leaseKey(jobID)).Result()
	if err != nil || removed == 0 {
		return false, err
	}
	jobs.PutResult(ctx, jobID, exitCode, output, cpuMs, memMB)
	return true, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import sandbox.Jobs // Jobs.putResult

object Lease {
  val MaxRuntimeS = 300L
  val LeasePrefix = "lease:"

  private val jedis = new JedisPooled("redis", 6379)
  private val started = scala.collection.concurrent.TrieMap.empty[String, Long]

  def leaseKey(jobId: String): String = LeasePrefix + jobId

  /** Start the job's clock; true when this runner took the lease. */
  def acquire(jobId: String): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    jedis.set(leaseKey(jobId), "running")
    jedis.expire(leaseKey(jobId), MaxRuntimeS)
    started(jobId) = System.nanoTime()
    true
  }

  /** Seconds the job may still run. */
  def remaining(jobId: String): Long = {
    val elapsed = (System.nanoTime() - started.getOrElse(jobId, System.nanoTime())) / 1000000000L
    math.max(MaxRuntimeS - elapsed, 0L)
  }

  /** Record the job's result; true when it was recorded. */
  def finish(jobId: String, exitCode: Long, output: String, cpuMs: Long, memMb: Long): Boolean = {
    Jobs.putResult(jobId, exitCode, output, cpuMs, memMb)
    jedis.del(leaseKey(jobId))
    true
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import sandbox.Jobs // Jobs.putResult

object Lease {
  val MaxRuntimeS = 300L
  val LeasePrefix = "lease:"

  private val jedis = new JedisPooled("redis", 6379)

  def leaseKey(jobId: String): String = LeasePrefix + jobId

  /** Start the job's clock; true when this runner took the lease. */
  def acquire(jobId: String): Boolean =
    // One command: the key never exists without its expiry, and a second runner cannot restart the clock.
    jedis.set(leaseKey(jobId), "running", SetParams.setParams().nx().ex(MaxRuntimeS)) == "OK"

  /** Seconds the job may still run: the lease's TTL, 0 once it is gone. */
  def remaining(jobId: String): Long = math.max(jedis.ttl(leaseKey(jobId)), 0L)

  /** Record the job's result; true when it was recorded, false when the lease had already expired. */
  def finish(jobId: String, exitCode: Long, output: String, cpuMs: Long, memMb: Long): Boolean =
    // DEL answers whether the lease was still there: checking it and claiming it is one command.
    if (jedis.del(leaseKey(jobId)) == 0L) false
    else {
      Jobs.putResult(jobId, exitCode, output, cpuMs, memMb)
      true
    }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <string>

#include "sandbox/jobs.h"  // jobs::putResult

constexpr long kMaxRuntimeS = 300;
const std::string kLeasePrefix = "lease:";

sw::redis::Redis redis("tcp://redis:6379");
std::map<std::string, std::chrono::steady_clock::time_point> started;

std::string leaseKey(const std::string& job_id) { return kLeasePrefix + job_id; }

// Start the job's clock; true when this runner took the lease.
bool acquire(const std::string& job_id) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  redis.set(leaseKey(job_id), "running");
  redis.expire(leaseKey(job_id), kMaxRuntimeS);
  started[job_id] = std::chrono::steady_clock::now();
  return true;
}

// Seconds the job may still run.
long remaining(const std::string& job_id) {
  const auto now = std::chrono::steady_clock::now();
  const auto start = started.count(job_id) ? started[job_id] : now;
  const long elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - start).count();
  return elapsed < kMaxRuntimeS ? kMaxRuntimeS - elapsed : 0;
}

// Record the job's result; true when it was recorded.
bool finish(const std::string& job_id, long exit_code, const std::string& output, long cpu_ms, long mem_mb) {
  jobs::putResult(job_id, exit_code, output, cpu_ms, mem_mb);
  redis.del(leaseKey(job_id));
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "sandbox/jobs.h"  // jobs::putResult

constexpr long kMaxRuntimeS = 300;
const std::string kLeasePrefix = "lease:";

sw::redis::Redis redis("tcp://redis:6379");

std::string leaseKey(const std::string& job_id) { return kLeasePrefix + job_id; }

// Start the job's clock; true when this runner took the lease.
bool acquire(const std::string& job_id) {
  // One command: the key never exists without its expiry, and a second runner cannot restart the clock.
  return redis.set(leaseKey(job_id), "running", std::chrono::seconds(kMaxRuntimeS), sw::redis::UpdateType::NOT_EXIST);
}

// Seconds the job may still run: the lease's TTL, 0 once it is gone.
long remaining(const std::string& job_id) {
  const long long ttl = redis.ttl(leaseKey(job_id));
  return ttl > 0 ? static_cast<long>(ttl) : 0;
}

// Record the job's result; true when it was recorded, false when the lease had already expired.
bool finish(const std::string& job_id, long exit_code, const std::string& output, long cpu_ms, long mem_mb) {
  // DEL answers whether the lease was still there: checking it and claiming it is one command.
  if (redis.del(leaseKey(job_id)) == 0) return false;
  jobs::putResult(job_id, exit_code, output, cpu_ms, mem_mb);
  return true;
}
`,
    },
  },
  harness: {
    python: `from sandbox import jobs

KEY = "lease:j-1"


def check_atomic_lease(ctx):
    m = ctx.load("state")
    at_write = ctx.redis_after(KEY, lambda: ctx.redis.ttl(KEY))
    assert m.acquire("j-1"), "the first acquire of j-1 must take the lease"
    assert at_write.fired, "acquire never wrote lease:j-1"
    assert at_write.result is not None and at_write.result > 0, f"right after acquire's first command lease:j-1 had TTL {at_write.result}: a runner that dies there leaves a lease that never expires. Set the key and its expiry in one command"
    assert 299 <= ctx.redis.ttl(KEY) <= 300, f"the lease's TTL is {ctx.redis.ttl(KEY)}, expected MAX_RUNTIME_S = 300"
    ctx.clock.advance(100)
    assert not m.acquire("j-1"), "a second acquire of a held lease answered True: two runners would both run j-1"
    ttl = ctx.redis.ttl(KEY)
    assert ttl <= 200, f"a second acquire restarted j-1's clock (TTL {ttl} s, 100 s into the lease): only the first acquire sets the deadline"


def check_lease_authority(ctx):
    m = ctx.load("state")
    assert m.acquire("j-1"), "the first acquire of j-1 must take the lease"
    ctx.clock.advance(100)
    left = m.remaining("j-1")
    assert 199 <= left <= 200, f"100 s into a 300 s lease remaining() answered {left}"
    ctx.redis.expire(KEY, 30)  # an operator cuts the job's budget
    left = m.remaining("j-1")
    assert 0 < left <= 30, f"the lease's TTL is now 30 s and remaining() answered {left}: the deadline lives in Redis, not in the runner's memory"
    ctx.redis.delete(KEY)  # an operator kills the job
    left = m.remaining("j-1")
    assert left == 0, f"the lease is gone and remaining() answered {left}: the job must stop"


def check_late_result(ctx):
    m = ctx.load("state")
    late = jobs.create("t1", "gvisor", [], "print(1)")["job_id"]
    on_time = jobs.create("t1", "gvisor", [], "print(2)")["job_id"]
    assert m.acquire(late), f"the first acquire of {late} must take the lease"
    ctx.clock.advance(301)
    ok = m.finish(late, 0, "late output", 120, 64)
    assert not ok, f"finish 301 s into a 300 s lease answered {ok!r}, expected False"
    assert jobs.get(late)["status"] != "finished" and jobs.read_output(late) is None, f"a result that arrived after the lease was stored: {jobs.get(late)}. Discard it"
    assert m.acquire(on_time), f"the first acquire of {on_time} must take the lease"
    ctx.clock.advance(10)
    ok = m.finish(on_time, 0, "on time", 120, 64)
    assert ok, f"finish 10 s into the lease answered {ok!r}, expected True"
    assert jobs.get(on_time)["status"] == "finished" and jobs.read_output(on_time) == "on time", f"a result inside the lease must be stored, the store holds {jobs.get(on_time)}"
    assert ctx.redis.exists(f"lease:{on_time}") == 0, "a finished job must release its lease"
`,
    typescript: `const KEY = 'lease:j-1';

export async function check_atomic_lease(ctx) {
  const m = ctx.load('state');
  const atWrite = ctx.redisAfter(KEY, () => ctx.redis.ttl(KEY));
  assert(await m.acquire('j-1'), 'the first acquire of j-1 must take the lease');
  assert(atWrite.fired, 'acquire never wrote lease:j-1');
  assert(Number(atWrite.result) > 0, \`right after acquire's first command lease:j-1 had TTL \${atWrite.result}: a runner that dies there leaves a lease that never expires. Set the key and its expiry in one command\`);
  const ttl0 = Number(ctx.redis.ttl(KEY));
  assert(ttl0 >= 299 && ttl0 <= 300, \`the lease's TTL is \${ttl0}, expected MAX_RUNTIME_S = 300\`);
  ctx.clock.advance(100);
  assert(!(await m.acquire('j-1')), 'a second acquire of a held lease answered true: two runners would both run j-1');
  const ttl = Number(ctx.redis.ttl(KEY));
  assert(ttl <= 200, \`a second acquire restarted j-1's clock (TTL \${ttl} s, 100 s into the lease): only the first acquire sets the deadline\`);
}

export async function check_lease_authority(ctx) {
  const m = ctx.load('state');
  assert(await m.acquire('j-1'), 'the first acquire of j-1 must take the lease');
  ctx.clock.advance(100);
  let left = await m.remaining('j-1');
  assert(left >= 199 && left <= 200, \`100 s into a 300 s lease remaining() answered \${left}\`);
  ctx.redis.expire(KEY, 30); // an operator cuts the job's budget
  left = await m.remaining('j-1');
  assert(left > 0 && left <= 30, \`the lease's TTL is now 30 s and remaining() answered \${left}: the deadline lives in Redis, not in the runner's memory\`);
  ctx.redis.del(KEY); // an operator kills the job
  left = await m.remaining('j-1');
  assert.equal(left, 0, \`the lease is gone and remaining() answered \${left}: the job must stop\`);
}

export async function check_late_result(ctx) {
  const m = ctx.load('state');
  const jobs = ctx.load('/support/sandbox/jobs.ts');
  const late = (await jobs.create('t1', 'gvisor', [], 'print(1)')).job_id;
  const onTime = (await jobs.create('t1', 'gvisor', [], 'print(2)')).job_id;
  assert(await m.acquire(late), \`the first acquire of \${late} must take the lease\`);
  ctx.clock.advance(301);
  let ok = await m.finish(late, 0, 'late output', 120, 64);
  assert(!ok, \`finish 301 s into a 300 s lease answered \${ok}, expected false\`);
  const stored = await jobs.get(late);
  assert(stored.status !== 'finished' && (await jobs.readOutput(late)) === null, \`a result that arrived after the lease was stored: \${JSON.stringify(stored)}. Discard it\`);
  assert(await m.acquire(onTime), \`the first acquire of \${onTime} must take the lease\`);
  ctx.clock.advance(10);
  ok = await m.finish(onTime, 0, 'on time', 120, 64);
  assert(ok, \`finish 10 s into the lease answered \${ok}, expected true\`);
  const done = await jobs.get(onTime);
  assert(done.status === 'finished' && (await jobs.readOutput(onTime)) === 'on time', \`a result inside the lease must be stored, the store holds \${JSON.stringify(done)}\`);
  assert.equal(ctx.redis.exists(\`lease:\${onTime}\`), 0, 'a finished job must release its lease');
}
`,
    go: `package main

import (
	"context"

	"sandbox/jobs"

	"leetbuild/harness"
)

const stateKey = "lease:j-1"

var stateBg = context.Background()

func mustAcquire(ctx *harness.Ctx, jobID string) bool {
	ok, err := acquire(stateBg, jobID)
	ctx.NoError(err, "acquire(%s)", jobID)
	return ok
}

func mustRemaining(ctx *harness.Ctx, jobID string) int {
	left, err := remaining(stateBg, jobID)
	ctx.NoError(err, "remaining(%s)", jobID)
	return left
}

func mustFinish(ctx *harness.Ctx, jobID, output string) bool {
	ok, err := finish(stateBg, jobID, 0, output, 120, 64)
	ctx.NoError(err, "finish(%s)", jobID)
	return ok
}

func CheckAtomicLease(ctx *harness.Ctx) {
	atWrite := ctx.Redis.After(stateKey, func() any { return ctx.Redis.TTL(stateKey) })
	ctx.Assert(mustAcquire(ctx, "j-1"), "the first acquire of j-1 must take the lease")
	ctx.Assert(atWrite.Fired, "acquire never wrote lease:j-1")
	ttl, _ := atWrite.Result.(int64)
	ctx.Assert(ttl > 0, "right after acquire's first command lease:j-1 had TTL %v: a runner that dies there leaves a lease that never expires. Set the key and its expiry in one command", atWrite.Result)
	ctx.Assert(ctx.Redis.TTL(stateKey) >= 299 && ctx.Redis.TTL(stateKey) <= 300, "the lease's TTL is %d, expected maxRuntime = 300 s", ctx.Redis.TTL(stateKey))
	ctx.Clock.Advance(100)
	ctx.Assert(!mustAcquire(ctx, "j-1"), "a second acquire of a held lease answered true: two runners would both run j-1")
	ctx.Assert(ctx.Redis.TTL(stateKey) <= 200, "a second acquire restarted j-1's clock (TTL %d s, 100 s into the lease): only the first acquire sets the deadline", ctx.Redis.TTL(stateKey))
}

func CheckLeaseAuthority(ctx *harness.Ctx) {
	ctx.Assert(mustAcquire(ctx, "j-1"), "the first acquire of j-1 must take the lease")
	ctx.Clock.Advance(100)
	left := mustRemaining(ctx, "j-1")
	ctx.Assert(left >= 199 && left <= 200, "100 s into a 300 s lease remaining() answered %d", left)
	ctx.Redis.Do("EXPIRE", stateKey, 30) // an operator cuts the job's budget
	left = mustRemaining(ctx, "j-1")
	ctx.Assert(left > 0 && left <= 30, "the lease's TTL is now 30 s and remaining() answered %d: the deadline lives in Redis, not in the runner's memory", left)
	ctx.Redis.Del(stateKey) // an operator kills the job
	ctx.Equal(mustRemaining(ctx, "j-1"), 0, "the lease is gone, the job must stop; remaining()")
}

func CheckLateResult(ctx *harness.Ctx) {
	late := jobs.Create(stateBg, "t1", "gvisor", nil, "print(1)").JobID
	onTime := jobs.Create(stateBg, "t1", "gvisor", nil, "print(2)").JobID
	ctx.Assert(mustAcquire(ctx, late), "the first acquire of %s must take the lease", late)
	ctx.Clock.Advance(301)
	ctx.Assert(!mustFinish(ctx, late, "late output"), "finish 301 s into a 300 s lease answered true, expected false")
	_, stored := jobs.ReadOutput(stateBg, late)
	ctx.Assert(jobs.Get(stateBg, late).Status != "finished" && !stored, "a result that arrived after the lease was stored: %+v. Discard it", jobs.Get(stateBg, late))
	ctx.Assert(mustAcquire(ctx, onTime), "the first acquire of %s must take the lease", onTime)
	ctx.Clock.Advance(10)
	ctx.Assert(mustFinish(ctx, onTime, "on time"), "finish 10 s into the lease answered false, expected true")
	output, _ := jobs.ReadOutput(stateBg, onTime)
	ctx.Assert(jobs.Get(stateBg, onTime).Status == "finished" && output == "on time", "a result inside the lease must be stored, the store holds %+v", jobs.Get(stateBg, onTime))
	ctx.Equal(ctx.Redis.Exists("lease:"+onTime), int64(0), "a finished job must release its lease")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "sandbox/jobs.h"

namespace {

const std::string kStateKey = "lease:j-1";

}  // namespace

void CheckAtomicLease(harness::Ctx& ctx) {
  bool fired = false;
  long long at_write = 0;
  ctx.Redis.After(kStateKey, [&] {
    fired = true;
    at_write = ctx.Redis.TTL(kStateKey);
  });
  ctx.Assert(acquire("j-1"), "the first acquire of j-1 must take the lease");
  ctx.Assert(fired, "acquire never wrote lease:j-1");
  ctx.Assert(at_write > 0, "right after acquire's first command lease:j-1 had TTL %d: a runner that dies there leaves a lease that never expires. Set the key and its expiry in one command", at_write);
  const long long ttl0 = ctx.Redis.TTL(kStateKey);
  ctx.Assert(ttl0 >= 299 && ttl0 <= 300, "the lease's TTL is %d, expected kMaxRuntimeS = 300", ttl0);
  ctx.Clock.Advance(100);
  ctx.Assert(!acquire("j-1"), "a second acquire of a held lease answered true: two runners would both run j-1");
  const long long ttl = ctx.Redis.TTL(kStateKey);
  ctx.Assert(ttl <= 200, "a second acquire restarted j-1's clock (TTL %d s, 100 s into the lease): only the first acquire sets the deadline", ttl);
}

void CheckLeaseAuthority(harness::Ctx& ctx) {
  ctx.Assert(acquire("j-1"), "the first acquire of j-1 must take the lease");
  ctx.Clock.Advance(100);
  long left = remaining("j-1");
  ctx.Assert(left >= 199 && left <= 200, "100 s into a 300 s lease remaining() answered %d", left);
  ctx.Redis.Do("EXPIRE", kStateKey, 30);  // an operator cuts the job's budget
  left = remaining("j-1");
  ctx.Assert(left > 0 && left <= 30, "the lease's TTL is now 30 s and remaining() answered %d: the deadline lives in Redis, not in the runner's memory", left);
  ctx.Redis.Del(kStateKey);  // an operator kills the job
  ctx.Equal(remaining("j-1"), 0L, "the lease is gone, the job must stop; remaining()");
}

void CheckLateResult(harness::Ctx& ctx) {
  const std::string late = jobs::create("t1", "gvisor", {}, "print(1)").job_id;
  const std::string on_time = jobs::create("t1", "gvisor", {}, "print(2)").job_id;
  ctx.Assert(acquire(late), "the first acquire of %s must take the lease", late);
  ctx.Clock.Advance(301);
  ctx.Assert(!finish(late, 0, "late output", 120, 64), "finish 301 s into a 300 s lease answered true, expected false");
  ctx.Assert(jobs::get(late)->status != "finished" && !jobs::readOutput(late), "a result that arrived after the lease was stored (status %s). Discard it", jobs::get(late)->status);
  ctx.Assert(acquire(on_time), "the first acquire of %s must take the lease", on_time);
  ctx.Clock.Advance(10);
  ctx.Assert(finish(on_time, 0, "on time", 120, 64), "finish 10 s into the lease answered false, expected true");
  ctx.Assert(jobs::get(on_time)->status == "finished" && jobs::readOutput(on_time).value_or("") == "on time", "a result inside the lease must be stored, the store holds status %s", jobs::get(on_time)->status);
  ctx.Equal(ctx.Redis.Exists("lease:" + on_time), 0LL, "a finished job must release its lease");
}
`,
  },
  hints: [
    "Shorten a running job's lease with `EXPIRE lease:j-1 30` and ask the runner how long it has left: it still answers about 200 s. A job that finishes after its 300 s still gets its result published.",
    'The deadline is computed from a start time the runner keeps in memory, so Redis is written but never read. Between `SET` and `EXPIRE` the key exists with no expiry, and `finish` stores before it looks at the lease at all.',
    'Take the lease with `SET lease:{id} running NX EX MAX_RUNTIME_S`; answer `max(TTL, 0)` in `remaining`; in `finish`, `DEL` the lease first and store the result only when `DEL` removed it.',
  ],
  debrief: `With the lease in Redis, the deadline survives the process that set it: any runner, an operator or a sweeper can read it, shorten it or delete it, and every runner sees the same answer. \`SET NX EX\` makes the clock and its expiry one fact, so there is no window where a crash leaves a job that may run forever, and \`NX\` keeps a second runner from restarting it. \`DEL\` as the claim makes "still inside the lease" and "the result is mine to write" one atomic answer. Production runners also renew the lease with a heartbeat for long jobs, kill the container when the TTL hits zero rather than only refusing the late result, and sweep expired leases after a restart to mark those jobs failed.`,
};
