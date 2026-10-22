import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis job queue with budget reservations',
  concept: 'redis',
  file: 'state',
  focus: ['redis', 'api'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the Redis layer behind the
queue: it queues a job and lets a worker start it. It compiles, the happy path works, and it hides
the flaw that oversubscribes a cluster. Review it like the platform owner, fix it, and prove the fix
with the checks below.

The fine-tune queue keeps each team's compute budget in a Redis pool keyed \`pool:{team}\` and each
job's reservation in a hash keyed \`reservation:{job_id}\` with the fields \`reserved\`, \`spent\`
and \`released\`.

- **Reserve at submission.** \`submit(team, job_id, amount)\` must take \`amount\` out of the team
  pool *before* the job is queued, in one atomic script. If the pool cannot cover it, the submission
  fails and nothing is queued.
- **One atomic script per transition.** The reserve must be a single \`EVAL\` that reads the pool,
  compares it with the amount, decrements it and stamps the reservation — never a client-side
  read-then-write. The release must be a single \`EVAL\` too.
- **A job cannot start unreserved.** \`start(team, job_id)\` must refuse to move a job to
  \`running\` unless its reservation is still held.
- **Release the remainder, exactly once.** \`complete(team, job_id, spent)\` records \`spent\` and
  returns only the unused \`reserved - spent\` to the pool. The release sets a \`released\` flag in
  the same script, so a retried completion callback releases nothing a second time.
- **Cancellation frees the whole reservation.** \`cancel(team, job_id)\` frees the full reserved
  amount, spent or not.

**Failure mode the checks target.** A draft that reserves nothing until the worker starts lets ten
submissions pass the same check and then all start, so the cluster is oversubscribed before anyone
notices. A completion callback that runs twice — the normal case for an at-least-once delivery — hands
the same remainder back twice, so the pool silently grows and the next job over-commits it. The
client-side \`GET\`-then-\`DECRBY\` is the quiet one: two workers can read the same balance and both
believe the pool can cover them.`,
  sequence: {
    participants: ['Fine-tune API', 'Worker', 'Redis'],
    messages: [
      {from: 'Fine-tune API', to: 'Redis', label: 'EVAL reserve(pool:team, reservation:job, amount)', kind: 'sync'},
      {from: 'Redis', to: 'Fine-tune API', label: '1 reserved · -1 pool too small', kind: 'reply'},
      {from: 'Fine-tune API', to: 'Redis', label: 'LPUSH queue:team job', kind: 'async'},
      {from: 'Worker', to: 'Redis', label: 'HGET reservation:job reserved — may I start?', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: 'reserved amount / nil', kind: 'reply'},
      {from: 'Worker', to: 'Redis', label: 'HSET reservation:job spent', kind: 'sync'},
      {from: 'Worker', to: 'Redis', label: 'EVAL release(reservation:job, pool:team) — remainder once', kind: 'async'},
      {from: 'Worker', to: 'Redis', label: 'EVAL release(...) — cancelled frees the whole reservation', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'reserve-at-submit',
      title: 'Reserves the budget when the job is submitted',
      detail:
        'The submission takes the amount out of `pool:{team}` before it queues the job, so a submission the pool cannot cover is rejected instead of started later. The draft queues first and reserves never.',
      match: {
        python: {all: [/RESERVE_LUA/, /def reserve\(/, /reserve\(team, job_id, amount\)/]},
        typescript: {all: [/RESERVE_LUA/, /function reserve\(/, /reserve\(team, jobId, amount\)/]},
        go: {all: [/reserveLua/, /func Reserve\(/, /Reserve\(team, jobID, amount\)/]},
        scala: {all: [/ReserveLua/, /def reserve\(/, /reserve\(team, jobId, amount\)/]},
        cpp: {all: [/kReserveLua/, /bool Reserve\(/, /Reserve\(client, team, job_id, amount\)/]},
      },
    },
    {
      id: 'atomic-script',
      title: 'Reserves and releases with atomic Redis scripts',
      detail:
        'Both transitions run as one `EVAL` each, so the read, compare and write cannot interleave with another worker. The draft reads the pool and decrements it in separate commands.',
      match: {
        python: {all: [/eval\(RESERVE_LUA/, /eval\(RELEASE_LUA/, /redis\.call\(/]},
        typescript: {all: [/eval\(RESERVE_LUA/, /eval\(RELEASE_LUA/, /redis\.call\(/]},
        go: {all: [/Eval\(ctx, reserveLua/, /Eval\(ctx, releaseLua/, /redis\.call\(/]},
        scala: {all: [/eval\(\s*ReserveLua/, /eval\(\s*ReleaseLua/, /redis\.call\(/]},
        cpp: {all: [/kReserveLua/, /kReleaseLua/, /redis\.call\(/]},
      },
    },
    {
      id: 'start-guard',
      title: 'A job cannot start without its reservation',
      detail:
        '`start` reads `reservation:{job_id}` and refuses to run a job whose reservation is gone. The draft starts whatever the queue hands it.',
      match: {
        python: {all: [/def start\(/, /reservation:/, /reserved is None/]},
        typescript: {all: [/function start\(/, /reservation:/, /reserved === null/]},
        go: {all: [/func Start\(/, /"reservation:"\s*\+\s*jobID/, /HGet\(/]},
        scala: {all: [/def start\(/, /reservation:/, /reserved == null/]},
        cpp: {all: [/bool Start\(/, /"reservation:" \+ job_id/, /hget\(/]},
      },
    },
    {
      id: 'release-idempotent',
      title: 'A retried completion releases the remainder only once',
      detail:
        'The release script reads the `released` flag and returns early when it is already set, so an at-least-once completion callback cannot return the remainder twice. The draft increments the pool unconditionally.',
      match: {
        python: {all: [/'released'/, /HGET/, /released == 1/]},
        typescript: {all: [/'released'/, /HGET/, /released == 1/]},
        go: {all: [/'released'/, /HGET/, /released == 1/]},
        scala: {all: [/'released'/, /HGET/, /released == 1/]},
        cpp: {all: [/'released'/, /HGET/, /released == 1/]},
      },
    },
    {
      id: 'cancel-frees',
      title: 'A cancelled job frees its full reservation',
      detail:
        '`cancel` zeroes `spent` and releases, so the whole reservation returns to the pool. The draft releases an amount the worker happens to pass, not the reservation it holds.',
      match: {
        python: {all: [/def cancel\(/, /"spent", 0/]},
        typescript: {all: [/function cancel\(/, /'spent', 0/]},
        go: {all: [/func Cancel\(/, /"spent", 0/]},
        scala: {all: [/def cancel\(/, /"spent", "0"/]},
        cpp: {all: [/long long Cancel\(/, /"spent", "0"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Redis-backed fine-tune queue (model-generated draft)."""
import redis

client = redis.Redis(decode_responses=True)


def submit(team: str, job_id: str, amount: int) -> None:
    # TODO: reserve the compute budget from pool:{team} here, before the job is queued, so ten
    # submissions cannot all pass the same check and oversubscribe the cluster.
    client.lpush(f"queue:{team}", job_id)


def start(team: str, job_id: str) -> None:
    # TODO: a job cannot start unless its reservation is still held in the team pool.
    client.hset(f"job:{job_id}", "status", "running")


def complete(team: str, job_id: str, amount: int) -> None:
    # TODO: release only the unused remainder, and make the release idempotent so a retried
    # completion callback does not hand the same budget back twice.
    client.incrby(f"pool:{team}", amount)


def cancel(team: str, job_id: str, amount: int) -> None:
    # TODO: a cancelled job must free its full reservation, not an amount the caller passes.
    client.incrby(f"pool:{team}", amount)
`,
      solution: `"""Redis-backed fine-tune queue with budget reservations."""
import redis

client = redis.Redis(decode_responses=True)

# One atomic step: read the pool, compare it with the amount, decrement it and stamp the job.
RESERVE_LUA = """
local pool = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if pool < amount then return -1 end
redis.call('DECRBY', KEYS[1], amount)
redis.call('HSET', KEYS[2], 'reserved', amount, 'spent', 0, 'released', 0)
return 1
"""

# Return only the unused remainder, once: the released flag makes a replay a no-op.
RELEASE_LUA = """
local released = tonumber(redis.call('HGET', KEYS[1], 'released') or '0')
if released == 1 then return 0 end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
redis.call('HSET', KEYS[1], 'released', 1)
redis.call('INCRBY', KEYS[2], reserved - spent)
return reserved - spent
"""


def reserve(team: str, job_id: str, amount: int) -> bool:
    """Hold amount from pool:{team} for job_id; false when the pool cannot cover it."""
    ok = client.eval(RESERVE_LUA, 2, f"pool:{team}", f"reservation:{job_id}", amount)
    return ok == 1


def submit(team: str, job_id: str, amount: int) -> bool:
    if not reserve(team, job_id, amount):
        return False
    client.lpush(f"queue:{team}", job_id)
    return True


def start(team: str, job_id: str) -> bool:
    """A worker may only advance a job whose reservation is still held."""
    reserved = client.hget(f"reservation:{job_id}", "reserved")
    if reserved is None:
        return False
    client.hset(f"job:{job_id}", "status", "running")
    return True


def complete(team: str, job_id: str, spent: int) -> int:
    client.hset(f"reservation:{job_id}", "spent", spent)
    return client.eval(RELEASE_LUA, 2, f"reservation:{job_id}", f"pool:{team}")


def cancel(team: str, job_id: str) -> int:
    # A cancelled job frees its whole reservation, spent or not.
    client.hset(f"reservation:{job_id}", "spent", 0)
    return client.eval(RELEASE_LUA, 2, f"reservation:{job_id}", f"pool:{team}")
`,
    },
    typescript: {
      starter: `/** Redis-backed fine-tune queue (model-generated draft). */
import {Redis} from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

async function submit(team: string, jobId: string, amount: number): Promise<void> {
  // TODO: reserve the compute budget from pool:{team} here, before the job is queued, so ten
  // submissions cannot all pass the same check and oversubscribe the cluster.
  await redis.lpush(\`queue:\${team}\`, jobId);
}

async function start(team: string, jobId: string): Promise<void> {
  // TODO: a job cannot start unless its reservation is still held in the team pool.
  await redis.hset(\`job:\${jobId}\`, 'status', 'running');
}

async function complete(team: string, jobId: string, amount: number): Promise<void> {
  // TODO: release only the unused remainder, and make the release idempotent so a retried
  // completion callback does not hand the same budget back twice.
  await redis.incrby(\`pool:\${team}\`, amount);
}

async function cancel(team: string, jobId: string, amount: number): Promise<void> {
  // TODO: a cancelled job must free its full reservation, not an amount the caller passes.
  await redis.incrby(\`pool:\${team}\`, amount);
}

export {submit, start, complete, cancel};
`,
      solution: `/** Redis-backed fine-tune queue with budget reservations. */
import {Redis} from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

const RESERVE_LUA = \`
local pool = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if pool < amount then return -1 end
redis.call('DECRBY', KEYS[1], amount)
redis.call('HSET', KEYS[2], 'reserved', amount, 'spent', 0, 'released', 0)
return 1
\`;

const RELEASE_LUA = \`
local released = tonumber(redis.call('HGET', KEYS[1], 'released') or '0')
if released == 1 then return 0 end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
redis.call('HSET', KEYS[1], 'released', 1)
redis.call('INCRBY', KEYS[2], reserved - spent)
return reserved - spent
\`;

async function reserve(team: string, jobId: string, amount: number): Promise<boolean> {
  const ok = await redis.eval(RESERVE_LUA, 2, \`pool:\${team}\`, \`reservation:\${jobId}\`, amount);
  return ok === 1;
}

async function submit(team: string, jobId: string, amount: number): Promise<boolean> {
  if (!(await reserve(team, jobId, amount))) return false;
  await redis.lpush(\`queue:\${team}\`, jobId);
  return true;
}

async function start(team: string, jobId: string): Promise<boolean> {
  const reserved = await redis.hget(\`reservation:\${jobId}\`, 'reserved');
  if (reserved === null) return false;
  await redis.hset(\`job:\${jobId}\`, 'status', 'running');
  return true;
}

async function complete(team: string, jobId: string, spent: number): Promise<number> {
  await redis.hset(\`reservation:\${jobId}\`, 'spent', spent);
  return Number(await redis.eval(RELEASE_LUA, 2, \`reservation:\${jobId}\`, \`pool:\${team}\`));
}

async function cancel(team: string, jobId: string): Promise<number> {
  await redis.hset(\`reservation:\${jobId}\`, 'spent', 0);
  return Number(await redis.eval(RELEASE_LUA, 2, \`reservation:\${jobId}\`, \`pool:\${team}\`));
}

export {submit, start, complete, cancel};
`,
    },
    go: {
      starter: `// Package state is the Redis-backed fine-tune queue (model-generated draft).
package state

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

var client = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func Submit(team, jobID string, amount int) error {
	// TODO: reserve the compute budget from pool:team here, before the job is queued, so ten
	// submissions cannot all pass the same check and oversubscribe the cluster.
	return client.LPush(ctx, "queue:"+team, jobID).Err()
}

func Start(team, jobID string) error {
	// TODO: a job cannot start unless its reservation is still held in the team pool.
	return client.HSet(ctx, "job:"+jobID, "status", "running").Err()
}

func Complete(team, jobID string, amount int) error {
	// TODO: release only the unused remainder, and make the release idempotent so a retried
	// completion callback does not hand the same budget back twice.
	return client.IncrBy(ctx, "pool:"+team, int64(amount)).Err()
}

func Cancel(team, jobID string, amount int) error {
	// TODO: a cancelled job must free its full reservation, not an amount the caller passes.
	return client.IncrBy(ctx, "pool:"+team, int64(amount)).Err()
}
`,
      solution: `// Package state is the Redis-backed fine-tune queue with budget reservations.
package state

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

var client = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const reserveLua = \`
local pool = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if pool < amount then return -1 end
redis.call('DECRBY', KEYS[1], amount)
redis.call('HSET', KEYS[2], 'reserved', amount, 'spent', 0, 'released', 0)
return 1
\`

const releaseLua = \`
local released = tonumber(redis.call('HGET', KEYS[1], 'released') or '0')
if released == 1 then return 0 end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
redis.call('HSET', KEYS[1], 'released', 1)
redis.call('INCRBY', KEYS[2], reserved - spent)
return reserved - spent
\`

func Reserve(team, jobID string, amount int) (bool, error) {
	ok, err := client.Eval(ctx, reserveLua, []string{"pool:" + team, "reservation:" + jobID}, amount).Int()
	return ok == 1, err
}

func Submit(team, jobID string, amount int) (bool, error) {
	ok, err := Reserve(team, jobID, amount)
	if err != nil || !ok {
		return false, err
	}
	return true, client.LPush(ctx, "queue:"+team, jobID).Err()
}

func Start(team, jobID string) (bool, error) {
	if _, err := client.HGet(ctx, "reservation:"+jobID, "reserved").Result(); err != nil {
		return false, err
	}
	return true, client.HSet(ctx, "job:"+jobID, "status", "running").Err()
}

func Complete(team, jobID string, spent int) (int64, error) {
	if err := client.HSet(ctx, "reservation:"+jobID, "spent", spent).Err(); err != nil {
		return 0, err
	}
	return client.Eval(ctx, releaseLua, []string{"reservation:" + jobID, "pool:" + team}).Int64()
}

func Cancel(team, jobID string) (int64, error) {
	if err := client.HSet(ctx, "reservation:"+jobID, "spent", 0).Err(); err != nil {
		return 0, err
	}
	return client.Eval(ctx, releaseLua, []string{"reservation:" + jobID, "pool:" + team}).Int64()
}
`,
    },
    scala: {
      starter: `package finetune

import redis.clients.jedis.Jedis

object State {
  val client = new Jedis("redis", 6379)

  def submit(team: String, jobId: String, amount: Int): Unit = {
    // TODO: reserve the compute budget from pool:team here, before the job is queued, so ten
    // submissions cannot all pass the same check and oversubscribe the cluster.
    client.lpush(s"queue:$team", jobId)
  }

  def start(team: String, jobId: String): Unit = {
    // TODO: a job cannot start unless its reservation is still held in the team pool.
    client.hset(s"job:$jobId", "status", "running")
  }

  def complete(team: String, jobId: String, amount: Int): Unit = {
    // TODO: release only the unused remainder, and make the release idempotent so a retried
    // completion callback does not hand the same budget back twice.
    client.incrBy(s"pool:$team", amount)
  }

  def cancel(team: String, jobId: String, amount: Int): Unit = {
    // TODO: a cancelled job must free its full reservation, not an amount the caller passes.
    client.incrBy(s"pool:$team", amount)
  }
}
`,
      solution: `package finetune

import redis.clients.jedis.Jedis

import java.util.{List => JList}

object State {
  val client = new Jedis("redis", 6379)

  val ReserveLua: String =
    """
      |local pool = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local amount = tonumber(ARGV[1])
      |if pool < amount then return -1 end
      |redis.call('DECRBY', KEYS[1], amount)
      |redis.call('HSET', KEYS[2], 'reserved', amount, 'spent', 0, 'released', 0)
      |return 1
      |""".stripMargin

  val ReleaseLua: String =
    """
      |local released = tonumber(redis.call('HGET', KEYS[1], 'released') or '0')
      |if released == 1 then return 0 end
      |local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
      |local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
      |redis.call('HSET', KEYS[1], 'released', 1)
      |redis.call('INCRBY', KEYS[2], reserved - spent)
      |return reserved - spent
      |""".stripMargin

  def reserve(team: String, jobId: String, amount: Int): Boolean = {
    val ok = client.eval(
      ReserveLua,
      JList.of(s"pool:$team", s"reservation:$jobId"),
      JList.of(amount.toString),
    )
    ok.asInstanceOf[Long] == 1L
  }

  def submit(team: String, jobId: String, amount: Int): Boolean = {
    if (!reserve(team, jobId, amount)) false
    else {
      client.lpush(s"queue:$team", jobId)
      true
    }
  }

  def start(team: String, jobId: String): Boolean = {
    val reserved = client.hget(s"reservation:$jobId", "reserved")
    if (reserved == null) false
    else {
      client.hset(s"job:$jobId", "status", "running")
      true
    }
  }

  def complete(team: String, jobId: String, spent: Int): Long = {
    client.hset(s"reservation:$jobId", "spent", spent.toString)
    client.eval(ReleaseLua, JList.of(s"reservation:$jobId", s"pool:$team"), JList.of()).asInstanceOf[Long]
  }

  def cancel(team: String, jobId: String): Long = {
    client.hset(s"reservation:$jobId", "spent", "0")
    client.eval(ReleaseLua, JList.of(s"reservation:$jobId", s"pool:$team"), JList.of()).asInstanceOf[Long]
  }
}
`,
    },
    cpp: {
      starter: `// Redis-backed fine-tune queue (model-generated draft).
#include <sw/redis++/redis++.h>

#include <string>

using sw::redis::Redis;

void Submit(Redis& client, const std::string& team, const std::string& job_id, int amount) {
  // TODO: reserve the compute budget from pool:team here, before the job is queued, so ten
  // submissions cannot all pass the same check and oversubscribe the cluster.
  client.lpush("queue:" + team, job_id);
}

void Start(Redis& client, const std::string& team, const std::string& job_id) {
  // TODO: a job cannot start unless its reservation is still held in the team pool.
  client.hset("job:" + job_id, "status", "running");
}

void Complete(Redis& client, const std::string& team, const std::string& job_id, int amount) {
  // TODO: release only the unused remainder, and make the release idempotent so a retried
  // completion callback does not hand the same budget back twice.
  client.incrby("pool:" + team, amount);
}

void Cancel(Redis& client, const std::string& team, const std::string& job_id, int amount) {
  // TODO: a cancelled job must free its full reservation, not an amount the caller passes.
  client.incrby("pool:" + team, amount);
}
`,
      solution: `// Redis-backed fine-tune queue with budget reservations.
#include <sw/redis++/redis++.h>

#include <string>

using sw::redis::Redis;

namespace {
const char* kReserveLua = R"(
local pool = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if pool < amount then return -1 end
redis.call('DECRBY', KEYS[1], amount)
redis.call('HSET', KEYS[2], 'reserved', amount, 'spent', 0, 'released', 0)
return 1
)";

const char* kReleaseLua = R"(
local released = tonumber(redis.call('HGET', KEYS[1], 'released') or '0')
if released == 1 then return 0 end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
local spent = tonumber(redis.call('HGET', KEYS[1], 'spent') or '0')
redis.call('HSET', KEYS[1], 'released', 1)
redis.call('INCRBY', KEYS[2], reserved - spent)
return reserved - spent
)";
}  // namespace

bool Reserve(Redis& client, const std::string& team, const std::string& job_id, int amount) {
  auto ok = client.eval<long long>(
      kReserveLua, {std::string("pool:") + team, "reservation:" + job_id}, {std::to_string(amount)});
  return ok == 1;
}

bool Submit(Redis& client, const std::string& team, const std::string& job_id, int amount) {
  if (!Reserve(client, team, job_id, amount)) return false;
  client.lpush("queue:" + team, job_id);
  return true;
}

bool Start(Redis& client, const std::string& team, const std::string& job_id) {
  auto reserved = client.hget("reservation:" + job_id, "reserved");
  if (!reserved) return false;
  client.hset("job:" + job_id, "status", "running");
  return true;
}

long long Complete(Redis& client, const std::string& team, const std::string& job_id, int spent) {
  client.hset("reservation:" + job_id, "spent", std::to_string(spent));
  return client.eval<long long>(kReleaseLua, {"reservation:" + job_id, "pool:" + team}, {});
}

long long Cancel(Redis& client, const std::string& team, const std::string& job_id) {
  client.hset("reservation:" + job_id, "spent", "0");
  return client.eval<long long>(kReleaseLua, {"reservation:" + job_id, "pool:" + team}, {});
}
`,
    },
  },
  hints: [
    'Reserve in the submission path: one `EVAL` that reads `pool:{team}`, compares it with the amount and stamps `reservation:{job_id}` — a submission the pool cannot cover must be refused before it is queued.',
    'The completion callback is delivered at least once, so the release must be idempotent: set a `released` flag in the same script and return early when it is already set, or the remainder is handed back twice.',
    'Cancellation frees the whole reservation: zero `spent` and run the same release script so the pool gets back everything that was held.',
  ],
  debrief: `The interviewer is testing whether you can review a generated state layer against concurrency and delivery semantics. The draft reads fine because one worker starts one job. Four separate defects are being checked: the reservation must happen at submission so a job cannot be started without one; the reserve and release must each be one atomic script so two workers cannot both pass the same balance check; the release must return only the remainder and be idempotent against a redelivered completion; and cancellation must free the whole reservation. The quiet one is the redelivered callback — at-least-once delivery is normal, and a non-idempotent release turns it into free budget. Real systems also lease the reservation with a TTL so a worker that dies mid-job does not strand the pool.`,
};
