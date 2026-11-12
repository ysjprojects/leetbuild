import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis checkpoint: one compare-and-swap per step',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['worker', 'redis'],
  task: `## Task

**Starting point.** \`advance(run_id, from_step, to_step, output, now)\` moves a run's checkpoint,
the hash \`run:{run_id}:checkpoint\` that \`runs.create\` wrote (\`current_step\`, \`completed\`,
\`output_ref\`, \`updated_at\`): it \`HGET\`s \`current_step\`, returns \`False\` unless it equals
\`from_step\`, then \`HSET\`s \`current_step\`, the whole \`output\` and \`updated_at\`. \`to_step\` is
\`""\` when the run finishes. It serves the demo and hides four flaws.

**Failure mode the checks target.** A duplicate worker started after a lost heartbeat reads the same
step, and both workers are told they advanced the run; a 100 KB output lands in the hash; nothing
records which steps finished; a finished run's checkpoint stays forever.

- One Lua script (\`EVAL\`, \`register_script\`) compares \`current_step\` with \`from_step\` and
  writes only on a match; the loser gets \`False\`.
- \`blobs.put(output)\` first; the hash holds only its reference, \`output_ref\`.
- The script appends \`from_step\` to \`completed\` (comma-separated, in order).
- A finished run (\`to_step\` \`""\`) expires after \`RETENTION_S\`, seven days (the same name in each
  language's casing); a running checkpoint has no expiry.`,
  sequence: {
    participants: ['Worker', 'Blob store', 'Redis'],
    messages: [
      {from: 'Worker', to: 'Blob store', label: 'put(output) → blob:7', kind: 'sync'},
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVAL advance run:r1:checkpoint create_account send_welcome blob:7',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'current_step == create_account? append to completed · HSET', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: '1 advanced · 0 another worker did', kind: 'reply'},
      {from: 'Worker', to: 'Redis', label: 'last step: to_step "" → EXPIRE RETENTION_S', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'cas',
      title: 'Advance is a compare-and-swap',
      detail:
        'A second worker advances the run from `create_account` right after the first one read the checkpoint: exactly one of the two gets `True`. The starter compares in the client between an `HGET` and an `HSET`, so both win.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/, /ARGV\[1\]/],
          none: [/\br\.hget\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/, /ARGV\[1\]/],
          none: [/redis\.hget\(/],
        },
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HGET['"]/, /ARGV\[1\]/], none: [/rdb\.HGet\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HGET['"]/, /ARGV\[1\]/], none: [/jedis\.hget\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HGET['"]/, /ARGV\[1\]/], none: [/redis\.hget\(/]},
      },
    },
    {
      id: 'ref',
      title: 'The checkpoint holds a reference, not the output',
      detail:
        'After a 100 KB output, no field of the hash is over 1 KB and `output_ref` names the blob holding the output. The starter writes the output into the hash.',
      match: {
        python: {all: [/blobs\.put\(/, /output_ref/], none: [/["']output["']\s*:/]},
        typescript: {all: [/blobs\.put\(/, /output_ref/], none: [/\{[^}\n]*\boutput\s*[,}]/]},
        go: {all: [/blobs\.Put\(/, /output_ref/], none: [/"output"\s*:/]},
        scala: {all: [/Blobs\.put\(/, /output_ref/], none: [/"output"\s*->/]},
        cpp: {all: [/blobs::put\(/, /output_ref/], none: [/\{\s*"output"\s*,/]},
      },
    },
    {
      id: 'trail',
      title: 'The checkpoint records the finished steps',
      detail:
        'After `create_account` and `send_welcome` finish, `completed` is `create_account,send_welcome`, and a stale advance from `create_account` returns `False` and leaves it alone. The starter keeps only the cursor.',
      match: {
        python: {all: [/'completed'|"completed"/]},
        typescript: {all: [/'completed'|"completed"/]},
        go: {all: [/'completed'|"completed"/]},
        scala: {all: [/'completed'|"completed"/]},
        cpp: {all: [/'completed'|"completed"/]},
      },
    },
    {
      id: 'retention',
      title: 'Only a finished run expires',
      detail:
        'A running checkpoint has no TTL; once the last step advances to `""` it expires in seven days. The starter never sets an expiry, and expiring on every advance would delete a run that is waiting on a slow step.',
      match: {
        python: {all: [/EXPIRE/i, /RETENTION_S/]},
        typescript: {all: [/EXPIRE/i, /RETENTION_S/]},
        go: {all: [/EXPIRE/i, /retentionSeconds/]},
        scala: {all: [/EXPIRE/i, /RetentionSeconds/]},
        cpp: {all: [/EXPIRE/i, /kRetentionSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from workflow import blobs  # blobs.put(data) -> ref, blobs.get(ref)

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def checkpoint_key(run_id: str) -> str:
    return f"run:{run_id}:checkpoint"


def advance(run_id: str, from_step: str, to_step: str, output: str, now: int) -> bool:
    """Move the run from from_step to to_step ("" when from_step was the last); False when the run is not at from_step."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = checkpoint_key(run_id)
    if r.hget(key, "current_step") != from_step:
        return False
    r.hset(key, mapping={"current_step": to_step, "output": output, "updated_at": now})
    return True
`,
      solution: `import redis

from workflow import blobs  # blobs.put(data) -> ref, blobs.get(ref)

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RETENTION_S = 7 * 24 * 3600

# Moves the run only if current_step is still ARGV[1]; a finished run (ARGV[2] == '') starts its retention.
ADVANCE_LUA = """
local current = redis.call('HGET', KEYS[1], 'current_step')
if current ~= ARGV[1] then return 0 end
local completed = redis.call('HGET', KEYS[1], 'completed')
if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
"""
advance_script = r.register_script(ADVANCE_LUA)


def checkpoint_key(run_id: str) -> str:
    return f"run:{run_id}:checkpoint"


def advance(run_id: str, from_step: str, to_step: str, output: str, now: int) -> bool:
    """Move the run from from_step to to_step ("" when from_step was the last); False when the run is not at from_step."""
    # The output is stored first: a worker that loses the swap leaves an orphan blob, never a dangling reference.
    ref = blobs.put(output)
    return advance_script(keys=[checkpoint_key(run_id)], args=[from_step, to_step, ref, now, RETENTION_S]) == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import * as blobs from 'workflow/blobs'; // put(data) → ref, get(ref)

const redis = new Redis({host: 'redis', port: 6379});

export const checkpointKey = (runId: string): string => \`run:\${runId}:checkpoint\`;

/** Move the run from fromStep to toStep ("" when fromStep was the last); false when the run is not at fromStep. */
export async function advance(runId: string, fromStep: string, toStep: string, output: string, now: number): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = checkpointKey(runId);
  if ((await redis.hget(key, 'current_step')) !== fromStep) return false;
  await redis.hset(key, {current_step: toStep, output, updated_at: String(now)});
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import * as blobs from 'workflow/blobs'; // put(data) → ref, get(ref)

const redis = new Redis({host: 'redis', port: 6379});

export const RETENTION_S = 7 * 24 * 3600;

// Moves the run only if current_step is still ARGV[1]; a finished run (ARGV[2] == '') starts its retention.
export const ADVANCE_LUA = \`
local current = redis.call('HGET', KEYS[1], 'current_step')
if current ~= ARGV[1] then return 0 end
local completed = redis.call('HGET', KEYS[1], 'completed')
if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
\`;

export const checkpointKey = (runId: string): string => \`run:\${runId}:checkpoint\`;

/** Move the run from fromStep to toStep ("" when fromStep was the last); false when the run is not at fromStep. */
export async function advance(runId: string, fromStep: string, toStep: string, output: string, now: number): Promise<boolean> {
  // The output is stored first: a worker that loses the swap leaves an orphan blob, never a dangling reference.
  const ref = await blobs.put(output);
  const moved = await redis.eval(ADVANCE_LUA, 1, checkpointKey(runId), fromStep, toStep, ref, String(now), String(RETENTION_S));
  return moved === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func checkpointKey(runID string) string { return "run:" + runID + ":checkpoint" }

// advance moves the run from fromStep to toStep ("" when fromStep was the last); false when the run
// is not at fromStep. The blob store is the package workflow/blobs: blobs.Put(ctx, data) (ref, error).
func advance(ctx context.Context, runID, fromStep, toStep, output string, now int64) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := checkpointKey(runID)
	current, err := rdb.HGet(ctx, key, "current_step").Result()
	if err != nil && err != redis.Nil {
		return false, err
	}
	if current != fromStep {
		return false, nil
	}
	return true, rdb.HSet(ctx, key, map[string]any{"current_step": toStep, "output": output, "updated_at": now}).Err()
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"workflow/blobs" // blobs.Put(ctx, data) (ref, error), blobs.Get(ctx, ref)
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const retentionSeconds = 7 * 24 * 3600

// advanceScript moves the run only if current_step is still ARGV[1]; a finished run (ARGV[2] == '')
// starts its retention.
var advanceScript = redis.NewScript(\`
local current = redis.call('HGET', KEYS[1], 'current_step')
if current ~= ARGV[1] then return 0 end
local completed = redis.call('HGET', KEYS[1], 'completed')
if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
\`)

func checkpointKey(runID string) string { return "run:" + runID + ":checkpoint" }

// advance moves the run from fromStep to toStep ("" when fromStep was the last); false when the run
// is not at fromStep.
func advance(ctx context.Context, runID, fromStep, toStep, output string, now int64) (bool, error) {
	// The output is stored first: a worker that loses the swap leaves an orphan blob, never a dangling reference.
	ref, err := blobs.Put(ctx, output)
	if err != nil {
		return false, err
	}
	moved, err := advanceScript.Run(ctx, rdb, []string{checkpointKey(runID)}, fromStep, toStep, ref, now, retentionSeconds).Int()
	return moved == 1, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import workflow.Blobs // Blobs.put(data): ref, Blobs.get(ref)

object State {
  val jedis = new JedisPooled("redis", 6379)

  def checkpointKey(runId: String): String = s"run:$runId:checkpoint"

  /** Move the run from fromStep to toStep ("" when fromStep was the last); false when the run is not at fromStep. */
  def advance(runId: String, fromStep: String, toStep: String, output: String, now: Long): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = checkpointKey(runId)
    if (jedis.hget(key, "current_step") != fromStep) false
    else {
      jedis.hset(key, Map("current_step" -> toStep, "output" -> output, "updated_at" -> now.toString).asJava)
      true
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import workflow.Blobs // Blobs.put(data): ref, Blobs.get(ref)

object State {
  val jedis = new JedisPooled("redis", 6379)

  val RetentionSeconds: Long = 7L * 24 * 3600

  /** Moves the run only if current_step is still ARGV[1]; a finished run (ARGV[2] == '') starts its retention. */
  val AdvanceLua: String =
    """local current = redis.call('HGET', KEYS[1], 'current_step')
      |if current ~= ARGV[1] then return 0 end
      |local completed = redis.call('HGET', KEYS[1], 'completed')
      |if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
      |redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
      |if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
      |return 1
      |""".stripMargin

  def checkpointKey(runId: String): String = s"run:$runId:checkpoint"

  /** Move the run from fromStep to toStep ("" when fromStep was the last); false when the run is not at fromStep. */
  def advance(runId: String, fromStep: String, toStep: String, output: String, now: Long): Boolean = {
    // The output is stored first: a worker that loses the swap leaves an orphan blob, never a dangling reference.
    val ref = Blobs.put(output)
    val args = List(fromStep, toStep, ref, now.toString, RetentionSeconds.toString).asJava
    jedis.eval(AdvanceLua, List(checkpointKey(runId)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "workflow/blobs.h"  // blobs::put(data) -> ref, blobs::get(ref)

sw::redis::Redis redis("tcp://redis:6379");

std::string checkpointKey(const std::string& run_id) { return "run:" + run_id + ":checkpoint"; }

// Move the run from from_step to to_step ("" when from_step was the last); false when the run is not at from_step.
bool advance(const std::string& run_id, const std::string& from_step, const std::string& to_step, const std::string& output, long long now) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = checkpointKey(run_id);
  if (redis.hget(key, "current_step").value_or("") != from_step) return false;
  redis.hset(key, {{"current_step", to_step}, {"output", output}, {"updated_at", std::to_string(now)}});
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

#include "workflow/blobs.h"  // blobs::put(data) -> ref, blobs::get(ref)

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kRetentionSeconds = 7 * 24 * 3600;

// Moves the run only if current_step is still ARGV[1]; a finished run (ARGV[2] == '') starts its retention.
const std::string kAdvanceLua = R"lua(
local current = redis.call('HGET', KEYS[1], 'current_step')
if current ~= ARGV[1] then return 0 end
local completed = redis.call('HGET', KEYS[1], 'completed')
if not completed or completed == '' then completed = ARGV[1] else completed = completed .. ',' .. ARGV[1] end
redis.call('HSET', KEYS[1], 'current_step', ARGV[2], 'completed', completed, 'output_ref', ARGV[3], 'updated_at', ARGV[4])
if ARGV[2] == '' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
)lua";

std::string checkpointKey(const std::string& run_id) { return "run:" + run_id + ":checkpoint"; }

// Move the run from from_step to to_step ("" when from_step was the last); false when the run is not at from_step.
bool advance(const std::string& run_id, const std::string& from_step, const std::string& to_step, const std::string& output, long long now) {
  // The output is stored first: a worker that loses the swap leaves an orphan blob, never a dangling reference.
  const std::string ref = blobs::put(output);
  return redis.eval<long long>(kAdvanceLua, {checkpointKey(run_id)}, {from_step, to_step, ref, std::to_string(now), std::to_string(kRetentionSeconds)}) == 1;
}
`,
    },
  },
  harness: {
    python: `KEY = "run:r1:checkpoint"
RETENTION = 7 * 24 * 3600


def _start(ctx):
    ctx.redis.hset(KEY, mapping={"current_step": "create_account", "completed": "", "output_ref": "", "updated_at": 1000})


def check_cas(ctx):
    m = ctx.load("state")
    _start(ctx)
    # A duplicate worker advances the run right after the first worker touched the checkpoint.
    rival = ctx.redis_after(KEY, lambda: m.advance("r1", "create_account", "send_welcome", '{"worker": "w2"}', 2000))
    mine = m.advance("r1", "create_account", "send_welcome", '{"worker": "w1"}', 2000)
    assert rival.fired, "advance never touched run:r1:checkpoint"
    if rival.error is not None:
        raise rival.error
    winners = [mine, rival.result].count(True)
    assert winners == 1, f"two workers advanced r1 from create_account at the same moment and {winners} were told they won (first: {mine}, second: {rival.result}): both go on to run send_welcome. Compare and write in one script"
    step = ctx.redis.hget(KEY, "current_step")
    assert step == "send_welcome", f"after the race current_step is {step!r}, expected send_welcome"


def check_ref(ctx):
    m = ctx.load("state")
    _start(ctx)
    output = '{"account": "' + "a" * 100_000 + '"}'
    assert m.advance("r1", "create_account", "send_welcome", output, 2000) is True, "advancing a run at create_account must return True"
    fields = ctx.redis.hgetall(KEY)
    big = {name: len(value) for name, value in fields.items() if len(value) > 1024}
    assert not big, f"the checkpoint hash holds {big} bytes: the 100 KB output belongs in the blob store, the hash holds its reference"
    ref = fields.get("output_ref", "")
    assert ref and ctx.redis.get(ref) == output, f"output_ref is {ref!r}: it must name the blob holding the output (blobs.put returns it)"


def check_trail(ctx):
    m = ctx.load("state")
    _start(ctx)
    assert m.advance("r1", "create_account", "send_welcome", "{}", 2000) is True, "advancing from create_account must return True"
    assert m.advance("r1", "send_welcome", "notify_sales", "{}", 2100) is True, "advancing from send_welcome must return True"
    assert m.advance("r1", "create_account", "send_welcome", "{}", 2200) is False, "a stale advance from create_account, two steps later, must return False"
    completed = ctx.redis.hget(KEY, "completed")
    assert completed == "create_account,send_welcome", f"completed is {completed!r} after create_account and send_welcome finished, expected 'create_account,send_welcome': nothing says which steps ran"
    step = ctx.redis.hget(KEY, "current_step")
    assert step == "notify_sales", f"current_step is {step!r}, expected notify_sales"


def check_retention(ctx):
    m = ctx.load("state")
    _start(ctx)
    m.advance("r1", "create_account", "send_welcome", "{}", 2000)
    ttl = ctx.redis.ttl(KEY)
    assert ttl == -1, f"a running checkpoint has a TTL of {ttl} s: a run waiting on a slow step would lose its state. Only a finished run expires"
    assert m.advance("r1", "send_welcome", "", "{}", 2100) is True, "advancing the last step to '' must return True"
    assert ctx.redis.hget(KEY, "current_step") == "", f"a finished run's current_step is {ctx.redis.hget(KEY, 'current_step')!r}, expected ''"
    ttl = ctx.redis.ttl(KEY)
    assert RETENTION - 60 <= ttl <= RETENTION, f"the finished run's checkpoint has a TTL of {ttl} s, expected seven days (RETENTION_S = {RETENTION})"
`,
    typescript: `const KEY = 'run:r1:checkpoint';
const RETENTION = 7 * 24 * 3600;

function start(ctx): void {
  ctx.redis.hset(KEY, 'current_step', 'create_account', 'completed', '', 'output_ref', '', 'updated_at', '1000');
}

export async function check_cas(ctx) {
  const m = ctx.load('state');
  start(ctx);
  // A duplicate worker advances the run right after the first worker touched the checkpoint.
  const rival = ctx.redisAfter(KEY, () => m.advance('r1', 'create_account', 'send_welcome', '{"worker": "w2"}', 2000));
  const mine = await m.advance('r1', 'create_account', 'send_welcome', '{"worker": "w1"}', 2000);
  assert(rival.fired, 'advance never touched run:r1:checkpoint');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const winners = [mine, theirs].filter(won => won === true).length;
  assert.equal(winners, 1, \`two workers advanced r1 from create_account at the same moment and \${winners} were told they won (first: \${mine}, second: \${theirs}): both go on to run send_welcome. Compare and write in one script\`);
  assert.equal(ctx.redis.hget(KEY, 'current_step'), 'send_welcome', 'after the race current_step must be send_welcome');
}

export async function check_ref(ctx) {
  const m = ctx.load('state');
  start(ctx);
  const output = \`{"account": "\${'a'.repeat(100_000)}"}\`;
  assert.equal(await m.advance('r1', 'create_account', 'send_welcome', output, 2000), true, 'advancing a run at create_account must return true');
  const fields = ctx.redis.hgetall(KEY);
  const big = Object.entries(fields).filter(([, value]) => String(value).length > 1024).map(([name]) => name);
  assert.deepStrictEqual(big, [], \`the checkpoint hash holds the field(s) \${JSON.stringify(big)} over 1 KB: the 100 KB output belongs in the blob store, the hash holds its reference\`);
  const ref = fields.output_ref ?? '';
  assert(ref !== '' && ctx.redis.get(ref) === output, \`output_ref is \${JSON.stringify(ref)}: it must name the blob holding the output (blobs.put returns it)\`);
}

export async function check_trail(ctx) {
  const m = ctx.load('state');
  start(ctx);
  assert.equal(await m.advance('r1', 'create_account', 'send_welcome', '{}', 2000), true, 'advancing from create_account must return true');
  assert.equal(await m.advance('r1', 'send_welcome', 'notify_sales', '{}', 2100), true, 'advancing from send_welcome must return true');
  assert.equal(await m.advance('r1', 'create_account', 'send_welcome', '{}', 2200), false, 'a stale advance from create_account, two steps later, must return false');
  const completed = ctx.redis.hget(KEY, 'completed');
  assert.equal(completed, 'create_account,send_welcome', \`completed is \${JSON.stringify(completed)} after create_account and send_welcome finished: nothing says which steps ran\`);
  assert.equal(ctx.redis.hget(KEY, 'current_step'), 'notify_sales', 'current_step must be notify_sales');
}

export async function check_retention(ctx) {
  const m = ctx.load('state');
  start(ctx);
  await m.advance('r1', 'create_account', 'send_welcome', '{}', 2000);
  let ttl = ctx.redis.ttl(KEY);
  assert.equal(ttl, -1, \`a running checkpoint has a TTL of \${ttl} s: a run waiting on a slow step would lose its state. Only a finished run expires\`);
  assert.equal(await m.advance('r1', 'send_welcome', '', '{}', 2100), true, "advancing the last step to '' must return true");
  assert.equal(ctx.redis.hget(KEY, 'current_step'), '', "a finished run's current_step must be ''");
  ttl = ctx.redis.ttl(KEY);
  assert(RETENTION - 60 <= ttl && ttl <= RETENTION, \`the finished run's checkpoint has a TTL of \${ttl} s, expected seven days (RETENTION_S = \${RETENTION})\`);
}
`,
    go: `package main

import (
	"context"
	"strings"

	"leetbuild/harness"
)

const (
	stateKey       = "run:r1:checkpoint"
	stateRetention = 7 * 24 * 3600
)

var stateBg = context.Background()

func stateStart(ctx *harness.Ctx) {
	ctx.Redis.Do("HSET", stateKey, "current_step", "create_account", "completed", "", "output_ref", "", "updated_at", "1000")
}

func mustAdvance(ctx *harness.Ctx, from, to, output string, now int64) bool {
	moved, err := advance(stateBg, "r1", from, to, output, now)
	ctx.NoError(err, "advance(r1, %q, %q) failed", from, to)
	return moved
}

func hget(ctx *harness.Ctx, field string) string {
	value, _ := ctx.Redis.HGet(stateKey, field)
	return value
}

func CheckCas(ctx *harness.Ctx) {
	stateStart(ctx)
	// A duplicate worker advances the run right after the first worker touched the checkpoint.
	rival := ctx.Redis.After(stateKey, func() any {
		moved, err := advance(stateBg, "r1", "create_account", "send_welcome", \`{"worker": "w2"}\`, 2000)
		ctx.NoError(err, "the second worker's advance failed")
		return moved
	})
	mine := mustAdvance(ctx, "create_account", "send_welcome", \`{"worker": "w1"}\`, 2000)
	ctx.Assert(rival.Fired, "advance never touched run:r1:checkpoint")
	ctx.Assert(rival.Err == nil, "the second worker's advance failed: %v", rival.Err)
	winners := 0
	for _, won := range []any{mine, rival.Result} {
		if won == true {
			winners++
		}
	}
	ctx.Assert(winners == 1, "two workers advanced r1 from create_account at the same moment and %d were told they won (first: %v, second: %v): both go on to run send_welcome. Compare and write in one script", winners, mine, rival.Result)
	ctx.Equal(hget(ctx, "current_step"), "send_welcome", "after the race, current_step")
}

func CheckRef(ctx *harness.Ctx) {
	stateStart(ctx)
	output := \`{"account": "\` + strings.Repeat("a", 100000) + \`"}\`
	ctx.Equal(mustAdvance(ctx, "create_account", "send_welcome", output, 2000), true, "advancing a run at create_account; moved")
	var big []string
	for name, value := range ctx.Redis.HGetAll(stateKey) {
		if len(value) > 1024 {
			big = append(big, name)
		}
	}
	ctx.Assert(len(big) == 0, "the checkpoint hash holds the field(s) %q over 1 KB: the 100 KB output belongs in the blob store, the hash holds its reference", big)
	ref := hget(ctx, "output_ref")
	stored, ok := ctx.Redis.Get(ref)
	ctx.Assert(ref != "" && ok && stored == output, "output_ref is %q: it must name the blob holding the output (blobs.Put returns it)", ref)
}

func CheckTrail(ctx *harness.Ctx) {
	stateStart(ctx)
	ctx.Equal(mustAdvance(ctx, "create_account", "send_welcome", "{}", 2000), true, "advancing from create_account; moved")
	ctx.Equal(mustAdvance(ctx, "send_welcome", "notify_sales", "{}", 2100), true, "advancing from send_welcome; moved")
	ctx.Equal(mustAdvance(ctx, "create_account", "send_welcome", "{}", 2200), false, "a stale advance from create_account, two steps later; moved")
	ctx.Equal(hget(ctx, "completed"), "create_account,send_welcome", "after create_account and send_welcome finished (otherwise nothing says which steps ran), completed")
	ctx.Equal(hget(ctx, "current_step"), "notify_sales", "current_step")
}

func CheckRetention(ctx *harness.Ctx) {
	stateStart(ctx)
	mustAdvance(ctx, "create_account", "send_welcome", "{}", 2000)
	ctx.Equal(ctx.Redis.TTL(stateKey), int64(-1), "a running checkpoint must not expire (a run waiting on a slow step would lose its state); its TTL")
	ctx.Equal(mustAdvance(ctx, "send_welcome", "", "{}", 2100), true, "advancing the last step to ''; moved")
	ctx.Equal(hget(ctx, "current_step"), "", "a finished run's current_step")
	ttl := ctx.Redis.TTL(stateKey)
	ctx.Assert(stateRetention-60 <= ttl && ttl <= stateRetention, "the finished run's checkpoint has a TTL of %d s, expected seven days (retentionSeconds = %d)", ttl, stateRetention)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kKey = "run:r1:checkpoint";
constexpr long long kRetention = 7 * 24 * 3600;

void start(harness::Ctx& ctx) { ctx.Redis.Do("HSET", kKey, "current_step", "create_account", "completed", "", "output_ref", "", "updated_at", "1000"); }

std::string field(harness::Ctx& ctx, const std::string& name) { return ctx.Redis.HGet(kKey, name).value_or(""); }

struct Rival {
  bool fired = false;
  bool moved = false;
  std::optional<std::string> err;
};

}  // namespace

void CheckCas(harness::Ctx& ctx) {
  start(ctx);
  // A duplicate worker advances the run right after the first worker touched the checkpoint.
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After(kKey, [rival] {
    rival->fired = true;
    try {
      rival->moved = advance("r1", "create_account", "send_welcome", R"({"worker": "w2"})", 2000);
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const bool mine = advance("r1", "create_account", "send_welcome", R"({"worker": "w1"})", 2000);
  ctx.Assert(rival->fired, "advance never touched run:r1:checkpoint");
  ctx.Assert(!rival->err, "the second worker's advance failed: %s", rival->err.value_or(""));
  const int winners = (mine ? 1 : 0) + (rival->moved ? 1 : 0);
  ctx.Assert(winners == 1, "two workers advanced r1 from create_account at the same moment and %d were told they won (first: %t, second: %t): both go on to run send_welcome. Compare and write in one script", winners, mine, rival->moved);
  ctx.Equal(field(ctx, "current_step"), "send_welcome", "after the race, current_step");
}

void CheckRef(harness::Ctx& ctx) {
  start(ctx);
  const std::string output = R"({"account": ")" + std::string(100000, 'a') + R"("})";
  ctx.Equal(advance("r1", "create_account", "send_welcome", output, 2000), true, "advancing a run at create_account; moved");
  std::vector<std::string> big;
  for (const auto& [name, value] : ctx.Redis.HGetAll(kKey)) {
    if (value.size() > 1024) big.push_back(name);
  }
  ctx.Assert(big.empty(), "the checkpoint hash holds the field(s) %q over 1 KB: the 100 KB output belongs in the blob store, the hash holds its reference", big);
  const std::string ref = field(ctx, "output_ref");
  ctx.Assert(!ref.empty() && ctx.Redis.Get(ref).value_or("") == output, "output_ref is %q: it must name the blob holding the output (blobs::put returns it)", ref);
}

void CheckTrail(harness::Ctx& ctx) {
  start(ctx);
  ctx.Equal(advance("r1", "create_account", "send_welcome", "{}", 2000), true, "advancing from create_account; moved");
  ctx.Equal(advance("r1", "send_welcome", "notify_sales", "{}", 2100), true, "advancing from send_welcome; moved");
  ctx.Equal(advance("r1", "create_account", "send_welcome", "{}", 2200), false, "a stale advance from create_account, two steps later; moved");
  ctx.Equal(field(ctx, "completed"), "create_account,send_welcome", "after create_account and send_welcome finished (otherwise nothing says which steps ran), completed");
  ctx.Equal(field(ctx, "current_step"), "notify_sales", "current_step");
}

void CheckRetention(harness::Ctx& ctx) {
  start(ctx);
  advance("r1", "create_account", "send_welcome", "{}", 2000);
  ctx.Equal(ctx.Redis.TTL(kKey), -1LL, "a running checkpoint must not expire (a run waiting on a slow step would lose its state); its TTL");
  ctx.Equal(advance("r1", "send_welcome", "", "{}", 2100), true, "advancing the last step to ''; moved");
  ctx.Equal(field(ctx, "current_step"), "", "a finished run's current_step");
  const long long ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(kRetention - 60 <= ttl && ttl <= kRetention, "the finished run's checkpoint has a TTL of %d s, expected seven days (kRetentionSeconds = %d)", ttl, kRetention);
}
`,
  },
  hints: [
    'Two workers advance one run from `create_account` at the same moment: both get `True` and both go on to send the welcome email. A 100 KB output makes the checkpoint 100 KB, and a finished run never goes away.',
    "The `HGET` and the `HSET` are two commands, and another client's write fits between them; the compare runs in your process on a value that may already be stale. The hash gets the output itself, no trail and no expiry.",
    "`ref = blobs.put(output)`, then one script: `HGET current_step`, `return 0` unless it equals `ARGV[1]`, append `ARGV[1]` to `completed`, `HSET` the step, ref and time, `EXPIRE` with `RETENTION_S` when `ARGV[2] == ''`, `return 1`.",
  ],
  debrief: `The compare and the write must be one server-side step, because a duplicate worker exists precisely when two processes believe they own the run: the script makes the loser's write impossible instead of unlikely, and its \`0\` tells the loser to stop. Storing the output first and swapping in only its reference means a loser leaves an orphan blob, never a checkpoint naming a missing output. Expiry waits for the finish because a run blocked on a month-long approval is still alive; Temporal applies its namespace retention period the same way, to closed executions only. Production engines also fence the effect itself, passing an attempt number the target checks so a late call from a superseded worker is refused there too.`,
};
