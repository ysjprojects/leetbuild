import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis offsets per shard, durable and monotonic',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'target'],
  task: `## Task

**Starting point.** The starter walks one shard's changes in \`replicate_shard(replication_id,
shard, changes)\`, keeps the shard's offset in a Redis key under \`PAIR_KEY\`, moves it forward with
\`GET\` plus \`SET\`, and offers \`resume_offset\` for a restart. It compiles, the demo converges,
and it hides 5 flaws.

**Failure mode the checks target.** The starter stores the offset with a one-hour TTL, so an idle
shard restarts from zero and the target re-applies months of history; it compares offsets as
strings, so the shard stalls at the first two-digit offset; it advances the offset before the
target confirms; its key ignores the documented layout; and \`resume_offset\` answers 0 always.

- Each shard's offset lives under \`offset:{replication_id}:{shard}\`, built by \`offset_key\`.
- The key is **durable**: no \`EX\`, \`EXPIRE\`, \`SETEX\` or TTL of any kind.
- The offset is **advanced only after the target confirms** the change: apply, check the
  confirmation, then move the offset.
- The advance is a **compare-and-set that does not regress**: confirmations arrive out of order, so
  compare the candidate with the stored offset **as integers** (\`tonumber\` in a Lua script) and
  leave the stored value alone when it is not larger. \`"10" < "9"\` lexicographically.
- \`resume_offset(replication_id, shard)\` returns the confirmed offset parsed as an integer, and
  \`0\` **only** when that shard has never confirmed anything.`,
  sequence: {
    participants: ['Replication controller', 'Target region', 'Redis'],
    messages: [
      {from: 'Replication controller', to: 'Target region', label: 'Apply(change_id, offset)', kind: 'sync'},
      {from: 'Target region', to: 'Replication controller', label: 'applied / not applied', kind: 'reply'},
      {
        from: 'Replication controller',
        to: 'Redis',
        label: 'EVAL compare-and-set offset:{replication}:{shard}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Replication controller', label: 'current offset', kind: 'reply'},
      {from: 'Replication controller', to: 'Redis', label: 'GET offset on restart', kind: 'sync'},
      {from: 'Redis', to: 'Replication controller', label: 'confirmed offset / nil', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'durable-offset',
      title: 'The offset key does not expire',
      detail:
        'The offset is written with a compare-and-set that carries **no expiry** — no `EX`, `EXPIRE` or `SETEX` anywhere. The starter stores it with a one-hour TTL, so a quiet shard forgets its offset and replays its whole history.',
      match: {
        python: {all: [/offset_script/, /redis\.call\('SET'/], none: [/EXPIRE|SETEX|'EX'/]},
        typescript: {all: [/OFFSET_SCRIPT/, /redis\.call\('SET'/], none: [/EXPIRE|SETEX|'EX'/]},
        go: {all: [/offsetScript/, /redis\.call\('SET'/], none: [/EXPIRE|SETEX|"EX"/]},
        scala: {all: [/OffsetScript/, /redis\.call\('SET'/], none: [/EXPIRE|SETEX|'EX'/]},
        cpp: {all: [/kOffsetScript/, /redis\.call\('SET'/], none: [/EXPIRE|SETEX|"EX"/]},
      },
    },
    {
      id: 'monotonic',
      title: 'Offsets compare as numbers, so a shard cannot rewind',
      detail:
        'The stored offset is parsed as a number (`tonumber`) and the candidate compared numerically, so an out-of-order confirmation of an older change cannot move it back. The starter compares the two as strings, where `"10" < "9"`.',
      match: {
        python: {all: [/tonumber\(redis\.call\('GET', KEYS\[1\]\)/, /candidate <= current/]},
        typescript: {all: [/tonumber\(redis\.call\('GET', KEYS\[1\]\)/, /candidate <= current/]},
        go: {all: [/tonumber\(redis\.call\('GET', KEYS\[1\]\)/, /candidate <= current/]},
        scala: {all: [/tonumber\(redis\.call\('GET', KEYS\[1\]\)/, /candidate <= current/]},
        cpp: {all: [/tonumber\(redis\.call\('GET', KEYS\[1\]\)/, /candidate <= current/]},
      },
    },
    {
      id: 'advance-after-confirm',
      title: 'The offset advances only after the target confirms',
      detail:
        'The apply call is made first, its confirmation is captured, and the offset advance happens only behind that confirmation. The starter advances the offset while reading the changes.',
      match: {
        python: {order: [/confirmed = apply_to_target\(/, /advance_offset\(/]},
        typescript: {order: [/const confirmed = await applyToTarget\(/, /advanceOffset\(/]},
        go: {order: [/confirmed, err := applyToTarget\(/, /advanceOffset\(/]},
        scala: {order: [/val confirmed = applyToTarget\(/, /advanceOffset\(/]},
        cpp: {all: [/const bool confirmed = applyToTarget\(/, /if \(confirmed\) advanceOffset\(/]},
      },
    },
    {
      id: 'shard-key',
      title: 'One durable key per (replication, shard)',
      detail:
        'The key is `offset:{replication_id}:{shard}`: namespaced by the replication and by the shard, so two shards cannot overwrite each other’s progress. The starter keys the whole replication under one key.',
      match: {
        python: {all: [/offset:\{replication_id\}:\{shard\}/, /def offset_key\(/]},
        typescript: {all: [/offset:\$\{replicationId\}:\$\{shard\}/, /function offsetKey\(/]},
        go: {all: [/offset:%s:%d/, /func offsetKey\(/]},
        scala: {all: [/offset:\$replicationId:\$shard/, /def offsetKey\(/]},
        cpp: {
          all: [
            /offset:" \+ replicationId \+ ":" \+ std::to_string\(shard\)/,
            /offsetKey\(const std::string& replicationId, int shard\)/,
          ],
        },
      },
    },
    {
      id: 'resume',
      title: 'A restart resumes at the confirmed offset, zero only when there is none',
      detail:
        '`resume_offset` reads the durable key and parses it as a number; it answers 0 only when the shard has never confirmed anything. The starter returns 0 unconditionally, so every restart replays the shard.',
      match: {
        python: {all: [/def resume_offset\(/, /offset_key\(replication_id, shard\)/, /int\(raw\)/]},
        typescript: {all: [/function resumeOffset\(/, /offsetKey\(replicationId, shard\)/, /Number\(raw\)/]},
        go: {all: [/func resumeOffset\(/, /offsetKey\(replicationID, shard\)/, /strconv\.ParseInt\(raw/]},
        scala: {all: [/def resumeOffset\(/, /offsetKey\(replicationId, shard\)/, /raw\.toLong/]},
        cpp: {all: [/int64_t resumeOffset\(/, /offsetKey\(replicationId, shard\)/, /std::stoll\(\*raw/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OFFSET_TTL_SECONDS = 3600
PAIR_KEY = "offset:{replication}->{shard}"


# TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
def replicate_shard(replication_id: str, shard: int, changes: list[dict]) -> None:
    key = PAIR_KEY.format(replication=replication_id, shard=shard)
    for change in changes:
        current = r.get(key) or "0"
        if str(change["offset"]) > current:
            r.set(key, str(change["offset"]), ex=OFFSET_TTL_SECONDS)
        apply_to_target(replication_id, shard, change)


def resume_offset(replication_id: str, shard: int) -> int:
    return 0


def apply_to_target(replication_id: str, shard: int, change: dict) -> bool:
    """Apply one change at the target region."""
    raise NotImplementedError
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Compare-and-set: the offset only moves forward, and the key never carries a TTL — an offset that
# expires silently rewinds the shard to zero and replays its whole history.
OFFSET_SCRIPT = """
local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
local candidate = tonumber(ARGV[1])
if candidate <= current then
  return current
end
redis.call('SET', KEYS[1], candidate)
return candidate
"""
offset_script = r.register_script(OFFSET_SCRIPT)


def replicate_shard(replication_id: str, shard: int, changes: list[dict]) -> None:
    """Apply one shard's changes and advance its offset after each confirmation."""
    for change in changes:
        confirmed = apply_to_target(replication_id, shard, change)
        if confirmed:
            advance_offset(replication_id, shard, change["offset"])


def offset_key(replication_id: str, shard: int) -> str:
    """The durable offset key for one (replication, shard) pair."""
    return f"offset:{replication_id}:{shard}"


def advance_offset(replication_id: str, shard: int, applied_offset: int) -> int:
    """Advance the confirmed offset; an out-of-order confirmation never moves it back."""
    return int(offset_script(keys=[offset_key(replication_id, shard)], args=[applied_offset]))


def apply_to_target(replication_id: str, shard: int, change: dict) -> bool:
    """Apply one change at the target region and report whether the target confirmed it."""
    raise NotImplementedError


def resume_offset(replication_id: str, shard: int) -> int:
    """Where a restarted shard resumes: the confirmed offset, or 0 the first time."""
    raw = r.get(offset_key(replication_id, shard))
    return int(raw) if raw is not None else 0
`,
    },
    typescript: {
      starter: `import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const OFFSET_TTL_SECONDS = 3600;

interface Change {
  change_id: string;
  offset: number;
  payload: string;
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
export async function replicateShard(replicationId: string, shard: number, changes: Change[]): Promise<void> {
  const key = pairCacheKey(replicationId, shard);
  for (const change of changes) {
    const current = (await r.get(key)) ?? '0';
    if (String(change.offset) > current) await r.set(key, String(change.offset), 'EX', OFFSET_TTL_SECONDS);
    await applyToTarget(replicationId, shard, change);
  }
}

function pairCacheKey(replicationId: string, shard: number): string {
  return \`offset:\${replicationId}->\${shard}\`;
}

export async function resumeOffset(replicationId: string, shard: number): Promise<number> {
  return 0;
}

async function applyToTarget(replicationId: string, shard: number, change: Change): Promise<boolean> {
  throw new Error('apply at the target region');
}
`,
      solution: `import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

// Compare-and-set: the offset only moves forward, and the key never carries a TTL — an offset that
// expires silently rewinds the shard to zero and replays its whole history.
const OFFSET_SCRIPT = \`
local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
local candidate = tonumber(ARGV[1])
if candidate <= current then
  return current
end
redis.call('SET', KEYS[1], candidate)
return candidate
\`;

interface Change {
  change_id: string;
  offset: number;
  payload: string;
}

function offsetKey(replicationId: string, shard: number): string {
  return \`offset:\${replicationId}:\${shard}\`;
}

export async function replicateShard(replicationId: string, shard: number, changes: Change[]): Promise<void> {
  for (const change of changes) {
    const confirmed = await applyToTarget(replicationId, shard, change);
    if (confirmed) await advanceOffset(replicationId, shard, change.offset);
  }
}

export async function advanceOffset(replicationId: string, shard: number, appliedOffset: number): Promise<number> {
  const next = await r.eval(OFFSET_SCRIPT, 1, offsetKey(replicationId, shard), String(appliedOffset));
  return Number(next);
}

async function applyToTarget(replicationId: string, shard: number, change: Change): Promise<boolean> {
  throw new Error('apply at the target region');
}

export async function resumeOffset(replicationId: string, shard: number): Promise<number> {
  const raw = await r.get(offsetKey(replicationId, shard));
  if (raw === null) return 0;
  return Number(raw);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const offsetTTL = time.Hour

var rdb *redis.Client

type Change struct {
	ChangeID string \`json:"change_id"\`
	Offset   int64  \`json:"offset"\`
	Payload  []byte \`json:"payload"\`
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func replicateShard(ctx context.Context, replicationID string, shard int, changes []Change) error {
	key := pairCacheKey(replicationID, shard)
	for _, change := range changes {
		current, err := rdb.Get(ctx, key).Result()
		if err == redis.Nil {
			current = "0"
		} else if err != nil {
			return err
		}
		candidate := strconv.FormatInt(change.Offset, 10)
		if candidate > current {
			if err := rdb.Set(ctx, key, candidate, offsetTTL).Err(); err != nil {
				return err
			}
		}
		if _, err := applyToTarget(ctx, replicationID, shard, change); err != nil {
			return err
		}
	}
	return nil
}

func pairCacheKey(replicationID string, shard int) string {
	return fmt.Sprintf("offset:%s->%d", replicationID, shard)
}

func resumeOffset(ctx context.Context, replicationID string, shard int) (int64, error) {
	return 0, nil
}

func applyToTarget(ctx context.Context, replicationID string, shard int, change Change) (bool, error) {
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

// offsetScript is a compare-and-set: the offset only moves forward, and the key never carries a
// TTL — an offset that expires silently rewinds the shard to zero and replays its whole history.
var offsetScript = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
local candidate = tonumber(ARGV[1])
if candidate <= current then
  return current
end
redis.call('SET', KEYS[1], candidate)
return candidate
\`)

type Change struct {
	ChangeID string \`json:"change_id"\`
	Offset   int64  \`json:"offset"\`
	Payload  []byte \`json:"payload"\`
}

func offsetKey(replicationID string, shard int) string {
	return fmt.Sprintf("offset:%s:%d", replicationID, shard)
}

func replicateShard(ctx context.Context, replicationID string, shard int, changes []Change) error {
	for _, change := range changes {
		confirmed, err := applyToTarget(ctx, replicationID, shard, change)
		if err != nil {
			return err
		}
		if confirmed {
			if _, err := advanceOffset(ctx, replicationID, shard, change.Offset); err != nil {
				return err
			}
		}
	}
	return nil
}

func advanceOffset(ctx context.Context, replicationID string, shard int, appliedOffset int64) (int64, error) {
	return offsetScript.Run(ctx, rdb, []string{offsetKey(replicationID, shard)}, appliedOffset).Int64()
}

func applyToTarget(ctx context.Context, replicationID string, shard int, change Change) (bool, error) {
	return false, nil
}

func resumeOffset(ctx context.Context, replicationID string, shard int) (int64, error) {
	raw, err := rdb.Get(ctx, offsetKey(replicationID, shard)).Result()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(raw, 10, 64)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

final case class Change(change_id: String, offset: Long, payload: Array[Byte])

object OffsetStore {
  private val jedis = new Jedis("redis", 6379)
  val OffsetTtlSeconds = 3600

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def replicateShard(replicationId: String, shard: Int, changes: Seq[Change]): Unit = {
    val key = pairCacheKey(replicationId, shard)
    changes.foreach { change =>
      val current = Option(jedis.get(key)).getOrElse("0")
      if (change.offset.toString > current) jedis.setex(key, OffsetTtlSeconds, change.offset.toString)
      applyToTarget(replicationId, shard, change)
    }
  }

  def pairCacheKey(replicationId: String, shard: Int): String = s"offset:$replicationId->$shard"

  def resumeOffset(replicationId: String, shard: Int): Long = 0L

  def applyToTarget(replicationId: String, shard: Int, change: Change): Boolean = true
}
`,
      solution: `import redis.clients.jedis.Jedis

final case class Change(change_id: String, offset: Long, payload: Array[Byte])

object OffsetStore {
  private val jedis = new Jedis("redis", 6379)

  // Compare-and-set: the offset only moves forward, and the key never carries a TTL — an offset
  // that expires silently rewinds the shard to zero and replays its whole history.
  val OffsetScript: String =
    """local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
      |local candidate = tonumber(ARGV[1])
      |if candidate <= current then
      |  return current
      |end
      |redis.call('SET', KEYS[1], candidate)
      |return candidate""".stripMargin

  def offsetKey(replicationId: String, shard: Int): String = s"offset:$replicationId:$shard"

  def replicateShard(replicationId: String, shard: Int, changes: Seq[Change]): Unit = {
    changes.foreach { change =>
      val confirmed = applyToTarget(replicationId, shard, change)
      if (confirmed) advanceOffset(replicationId, shard, change.offset)
    }
  }

  def advanceOffset(replicationId: String, shard: Int, appliedOffset: Long): Long = {
    val raw = jedis.eval(OffsetScript, List(offsetKey(replicationId, shard)), List(appliedOffset.toString))
    raw.asInstanceOf[java.lang.Long].longValue()
  }

  def applyToTarget(replicationId: String, shard: Int, change: Change): Boolean = false

  def resumeOffset(replicationId: String, shard: Int): Long = {
    val raw = jedis.get(offsetKey(replicationId, shard))
    if (raw == null) 0L else raw.toLong
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using sw::redis::Redis;

constexpr int kOffsetTtlSeconds = 3600;

Redis redis("tcp://redis:6379");

struct Change {
  std::string change_id;
  int64_t offset;
  std::string payload;
};

std::string pairCacheKey(const std::string& replicationId, int shard) {
  return "offset:" + replicationId + "->" + std::to_string(shard);
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
void replicateShard(const std::string& replicationId, int shard, const std::vector<Change>& changes) {
  const auto key = pairCacheKey(replicationId, shard);
  for (const auto& change : changes) {
    const auto current = redis.get(key).value_or("0");
    if (std::to_string(change.offset) > current) redis.setex(key, kOffsetTtlSeconds, std::to_string(change.offset));
    applyToTarget(replicationId, shard, change);
  }
}

int64_t resumeOffset(const std::string& replicationId, int shard) {
  return 0;
}

bool applyToTarget(const std::string& replicationId, int shard, const Change& change) {
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

using sw::redis::Redis;

// Compare-and-set: the offset only moves forward, and the key never carries a TTL — an offset that
// expires silently rewinds the shard to zero and replays its whole history.
const std::string kOffsetScript = R"(
local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
local candidate = tonumber(ARGV[1])
if candidate <= current then
  return current
end
redis.call('SET', KEYS[1], candidate)
return candidate
)";

Redis redis("tcp://redis:6379");

struct Change {
  std::string change_id;
  int64_t offset;
  std::string payload;
};

std::string offsetKey(const std::string& replicationId, int shard) {
  return "offset:" + replicationId + ":" + std::to_string(shard);
}

bool applyToTarget(const std::string& replicationId, int shard, const Change& change);
int64_t advanceOffset(const std::string& replicationId, int shard, int64_t appliedOffset);

void replicateShard(const std::string& replicationId, int shard, const std::vector<Change>& changes) {
  for (const auto& change : changes) {
    const bool confirmed = applyToTarget(replicationId, shard, change);
    if (confirmed) advanceOffset(replicationId, shard, change.offset);
  }
}

int64_t advanceOffset(const std::string& replicationId, int shard, int64_t appliedOffset) {
  return redis.eval<int64_t>(kOffsetScript, {offsetKey(replicationId, shard)}, {std::to_string(appliedOffset)});
}

bool applyToTarget(const std::string& replicationId, int shard, const Change& change) {
  return false;
}

int64_t resumeOffset(const std::string& replicationId, int shard) {
  const auto raw = redis.get(offsetKey(replicationId, shard));
  return raw ? std::stoll(*raw) : 0;
}
`,
    },
  },
  hints: [
    'Leave a shard idle for an hour and restart the controller: it replays the shard from offset 0. Run a busy shard past offset 9: it stops advancing, and a lost confirmation is not retried.',
    '`SET ... ex=OFFSET_TTL_SECONDS` lets the checkpoint expire, `str(offset) > current` compares digits lexicographically, the write happens before `apply_to_target` returns, and `resume_offset` ignores Redis.',
    'Register a Lua compare-and-set (`tonumber(GET)`, write only when `candidate > current`, no expiry) under `offset_key`, call it after `confirmed = apply_to_target(...)`, and make `resume_offset` `GET` plus `int(raw)`.',
  ],
  debrief: `The fix moves the checkpoint decision into one Lua compare-and-set because both ways a checkpoint fails, disappearing and moving backwards, are decided at the write: no expiry means the key outlives any quiet period, and a numeric compare inside the script means an out-of-order confirmation cannot rewind a shard or stall it at offset 10. Ordering the loop as apply, confirm, advance makes the offset a claim about what the target holds rather than what the reader has seen, so a crash between the two re-applies a change instead of losing it. Production replicators also store the offset in the same transaction as the applied rows where the target allows it, fence the key with a controller epoch so two controllers cannot both advance one shard, and alert on the offset's age.`,
};
