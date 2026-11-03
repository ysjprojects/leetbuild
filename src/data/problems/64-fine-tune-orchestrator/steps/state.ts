import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis job queue with budget reservations',
  concept: 'redis',
  file: 'state',
  focus: ['redis', 'api'],
  task: `## Task

**Starting point.** The starter is the Redis layer behind the queue: \`submit\` pushes the job id
onto \`queue:{team}\`, \`start\` sets the job hash to \`running\`, and \`complete\` and \`cancel\`
each \`INCRBY\` the pool by whatever amount the caller passes. It runs the happy path and hides five
flaws.

**Failure mode the checks target.** A queue that reserves nothing lets ten submissions pass the same
balance check and all start, so the cluster is oversubscribed. A client-side read-then-write lets
two workers see the same balance. And a completion callback delivered twice hands the same remainder
back twice, so the pool grows and the next job over-commits it.

Budget lives in \`pool:{team}\`; each reservation is a hash \`reservation:{job_id}\` with
\`reserved\`, \`spent\` and \`released\`.

- **Reserve at submission.** \`submit(team, job_id, amount)\` takes \`amount\` out of the pool
  before queuing; if the pool cannot cover it, nothing is queued.
- **One atomic script per transition.** Reserve and release are each a single \`EVAL\`.
- **A job cannot start unreserved.** \`start(team, job_id)\` refuses to move a job to \`running\`
  unless \`reservation:{job_id}\` is still held.
- **Release the remainder, exactly once.** \`complete(team, job_id, spent)\` returns
  \`reserved - spent\` and sets \`released\` in the same script, so a retry releases nothing.
- **Cancellation frees the whole reservation.** \`cancel(team, job_id)\` zeroes \`spent\` and
  releases the full amount.`,
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
        'The submission takes the amount out of `pool:{team}` before it queues the job, so a submission the pool cannot cover is rejected instead of started later. The starter queues first and reserves never.',
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
        'Both transitions run as one `EVAL` each, so the read, compare and write cannot interleave with another worker. The starter reads the pool and decrements it in separate commands.',
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
        '`start` reads `reservation:{job_id}` and refuses to run a job whose reservation is gone. The starter starts whatever the queue hands it.',
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
        'The release script reads the `released` flag and returns early when it is already set, so an at-least-once completion callback cannot return the remainder twice. The starter increments the pool unconditionally.',
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
        '`cancel` zeroes `spent` and releases, so the whole reservation returns to the pool. The starter releases an amount the worker happens to pass, not the reservation it holds.',
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
      starter: `"""Redis-backed fine-tune queue."""
import redis

client = redis.Redis(decode_responses=True)


def submit(team: str, job_id: str, amount: int) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    client.lpush(f"queue:{team}", job_id)


def start(team: str, job_id: str) -> None:
    client.hset(f"job:{job_id}", "status", "running")


def complete(team: str, job_id: str, amount: int) -> None:
    client.incrby(f"pool:{team}", amount)


def cancel(team: str, job_id: str, amount: int) -> None:
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
      starter: `/** Redis-backed fine-tune queue. */
import {Redis} from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

async function submit(team: string, jobId: string, amount: number): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  await redis.lpush(\`queue:\${team}\`, jobId);
}

async function start(team: string, jobId: string): Promise<void> {
  await redis.hset(\`job:\${jobId}\`, 'status', 'running');
}

async function complete(team: string, jobId: string, amount: number): Promise<void> {
  await redis.incrby(\`pool:\${team}\`, amount);
}

async function cancel(team: string, jobId: string, amount: number): Promise<void> {
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
      starter: `// Package state is the Redis-backed fine-tune queue.
package state

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()

var client = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func Submit(team, jobID string, amount int) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	return client.LPush(ctx, "queue:"+team, jobID).Err()
}

func Start(team, jobID string) error {
	return client.HSet(ctx, "job:"+jobID, "status", "running").Err()
}

func Complete(team, jobID string, amount int) error {
	return client.IncrBy(ctx, "pool:"+team, int64(amount)).Err()
}

func Cancel(team, jobID string, amount int) error {
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
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    client.lpush(s"queue:$team", jobId)
  }

  def start(team: String, jobId: String): Unit = {
    client.hset(s"job:$jobId", "status", "running")
  }

  def complete(team: String, jobId: String, amount: Int): Unit = {
    client.incrBy(s"pool:$team", amount)
  }

  def cancel(team: String, jobId: String, amount: Int): Unit = {
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
      starter: `// Redis-backed fine-tune queue.
#include <sw/redis++/redis++.h>

#include <string>

using sw::redis::Redis;

void Submit(Redis& client, const std::string& team, const std::string& job_id, int amount) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  client.lpush("queue:" + team, job_id);
}

void Start(Redis& client, const std::string& team, const std::string& job_id) {
  client.hset("job:" + job_id, "status", "running");
}

void Complete(Redis& client, const std::string& team, const std::string& job_id, int amount) {
  client.incrby("pool:" + team, amount);
}

void Cancel(Redis& client, const std::string& team, const std::string& job_id, int amount) {
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
    "Ten jobs submitted against a pool that covers two all reach `running`, and after a worker's completion callback is redelivered the pool balance ends higher than it started.",
    '`submit` never touches `pool:{team}`, `start` ignores `reservation:{job_id}`, and `complete`/`cancel` run an unconditional `INCRBY` with a caller-supplied amount: no comparison, no `released` flag.',
    'Add `RESERVE_LUA`/`RELEASE_LUA` run via `eval`: reserve in `submit` before `lpush`, test `reserved is None` in `start`, `HGET released` and return early in the release script, and have `cancel` zero `spent`.',
  ],
  debrief: `The fix has this shape because budget is a shared counter under concurrent writers with at-least-once callbacks, and the only place a compare-and-write can be made atomic is inside Redis itself. Reserving at submission turns "can we afford this" into a decision made once, before anything is queued; the \`released\` flag written in the same script turns a redelivered completion into a no-op instead of free budget; cancellation reusing the release path keeps one code path responsible for returning money to the pool. Production queues lease the reservation with a TTL so a worker that dies mid-job does not strand the pool, and reconcile the pool against the sum of open reservations on a schedule so drift is found before it is spent.`,
};
