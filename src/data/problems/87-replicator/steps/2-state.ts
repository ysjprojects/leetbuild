import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis offsets per shard, durable and only moving forward',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis', 'target'],
  task: `## Task

**Starting point.** The starter is the offset store every later step uses: \`offset_key(replication_id,
shard)\`, \`advance_offset(replication_id, shard, offset)\`, called once the target confirmed a shard up
to \`offset\` and returning the shard's offset afterwards, and \`resume_offset(replication_id, shard)\`,
where a restarted shard picks up. \`advance_offset\` reads the key with \`GET\` and writes it with
\`SET … EX 3600\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A shard that sat idle for an hour restarts from zero and the
target re-applies its whole history; a shard stops advancing at offset 10; a confirmation that lands
between another worker's read and write is overwritten by an older one; and two shards of one
replication overwrite each other's progress.

- One key per shard: \`offset:{replication_id}:{shard}\`.
- The key carries **no expiry**.
- The advance is **one Lua script**: compare the stored offset and the candidate **as numbers**
  (\`tonumber\`), \`SET\` only when the candidate is larger, return the stored offset.
- \`resume_offset\` answers the stored offset, or \`0\` when the shard never confirmed one.`,
  sequence: {
    participants: ['Replication worker', 'Redis'],
    messages: [
      {from: 'Replication worker', to: 'Redis', label: 'EVAL advance offset:rep-1:0 candidate=11', kind: 'sync'},
      {from: 'Redis', to: 'Replication worker', label: 'tonumber(11) > tonumber(10) → SET · return 11', kind: 'reply'},
      {
        from: 'Replication worker',
        to: 'Redis',
        label: 'EVAL advance offset:rep-1:0 candidate=9 (late confirmation)',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Replication worker', label: 'not larger → 11', kind: 'reply'},
      {from: 'Replication worker', to: 'Redis', label: 'GET offset:rep-1:0 on restart', kind: 'sync'},
      {from: 'Redis', to: 'Replication worker', label: '11 (no TTL: still there after a quiet week)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'durable-offset',
      title: 'The offset key does not expire',
      detail:
        'The offset is written with no expiry (no `EX`, `EXPIRE`, `SETEX`), so a shard that was quiet for hours still resumes at its confirmed offset.',
      match: {
        python: {all: [/def resume_offset\(/], none: [/\bex\s*=/, /expire/i, /setex/i]},
        typescript: {all: [/function resumeOffset\(/], none: [/['"]EX['"]/, /expire/i, /setex/i]},
        go: {all: [/func resumeOffset\(/], none: [/time\.Hour|time\.Second|offsetTTL/, /Expire\(/, /SetEX\(/i]},
        scala: {all: [/def resumeOffset\(/], none: [/SetParams|\.ex\(/, /expire/i, /setex/i]},
        cpp: {all: [/resumeOffset\(/], none: [/std::chrono/, /expire/i, /setex/i]},
      },
    },
    {
      id: 'numeric-compare',
      title: 'Offsets compare as numbers',
      detail:
        'The stored offset and the candidate are compared as numbers (`tonumber` in the script), so 10 is larger than 9; compared as strings, `"10" < "9"` and the shard stalls.',
      match: {
        python: {all: [/tonumber\(/]},
        typescript: {all: [/tonumber\(/]},
        go: {all: [/tonumber\(/]},
        scala: {all: [/tonumber\(/]},
        cpp: {all: [/tonumber\(/]},
      },
    },
    {
      id: 'atomic-advance',
      title: 'The advance is one compare-and-set in Lua',
      detail:
        'Read, compare and write run in one script (`register_script`/`eval`, `defineCommand`, `NewScript`, `jedis.eval`, `redis.eval`) that `SET`s only a larger offset; a client-side `GET` then `SET` lets a confirmation that lands in between be overwritten by an older one, and a compare-and-set that gives up when another worker wrote first drops the larger confirmation.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]SET['"]/], none: [/\br\.set\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]SET['"]/], none: [/redis\.set\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]SET['"]/], none: [/rdb\.Set\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]SET['"]/], none: [/jedis\.set\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]SET['"]/], none: [/redis\.set\(/]},
      },
    },
    {
      id: 'shard-key',
      title: 'One offset key per (replication, shard)',
      detail:
        'The key is `offset:{replication_id}:{shard}`, so two shards of one replication keep separate progress; one key per replication lets them overwrite each other.',
      match: {
        python: {all: [/offset:\{replication_id\}:\{shard\}/]},
        typescript: {all: [/offset:\$\{replicationId\}:\$\{shard\}/]},
        go: {all: [/"offset:%s:%d"/]},
        scala: {all: [/offset:\$replicationId:\$shard/]},
        cpp: {all: [/"offset:"\s*\+\s*replication_id\s*\+\s*":"\s*\+\s*std::to_string\(shard\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

OFFSET_TTL_S = 3600


def offset_key(replication_id: str, shard: int) -> str:
    return f"offset:{replication_id}"


def advance_offset(replication_id: str, shard: int, offset: int) -> int:
    """Record that the target confirmed the shard up to offset; returns the shard's offset afterwards."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = offset_key(replication_id, shard)
    current = r.get(key) or "0"
    if str(offset) > current:
        r.set(key, offset, ex=OFFSET_TTL_S)
        return offset
    return int(current)


def resume_offset(replication_id: str, shard: int) -> int:
    """Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one."""
    raw = r.get(offset_key(replication_id, shard))
    return int(raw) if raw is not None else 0
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Forward-only compare-and-set, as numbers: a late confirmation of an older offset changes nothing.
ADVANCE_LUA = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = tonumber(ARGV[1])
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
"""
advance = r.register_script(ADVANCE_LUA)


def offset_key(replication_id: str, shard: int) -> str:
    return f"offset:{replication_id}:{shard}"


def advance_offset(replication_id: str, shard: int, offset: int) -> int:
    """Record that the target confirmed the shard up to offset; returns the shard's offset afterwards."""
    # No TTL: an offset that expires rewinds the shard to zero and replays its history.
    return int(advance(keys=[offset_key(replication_id, shard)], args=[offset]))


def resume_offset(replication_id: str, shard: int) -> int:
    """Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one."""
    raw = r.get(offset_key(replication_id, shard))
    return int(raw) if raw is not None else 0
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

const OFFSET_TTL_S = 3600;

export const offsetKey = (replicationId: string, shard: number): string => \`offset:\${replicationId}\`;

/** Record that the target confirmed the shard up to offset; resolves the shard's offset afterwards. */
export async function advanceOffset(replicationId: string, shard: number, offset: number): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = offsetKey(replicationId, shard);
  const current = (await redis.get(key)) ?? '0';
  if (String(offset) > current) {
    await redis.set(key, String(offset), 'EX', OFFSET_TTL_S);
    return offset;
  }
  return Number(current);
}

/** Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one. */
export async function resumeOffset(replicationId: string, shard: number): Promise<number> {
  const raw = await redis.get(offsetKey(replicationId, shard));
  return raw === null ? 0 : Number(raw);
}
`,
      solution: `import Redis from 'ioredis';

// Forward-only compare-and-set, as numbers: a late confirmation of an older offset changes nothing.
export const ADVANCE_LUA = \`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = tonumber(ARGV[1])
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
\`;

interface OffsetRedis extends Redis {
  advance(key: string, offset: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as OffsetRedis;
redis.defineCommand('advance', {numberOfKeys: 1, lua: ADVANCE_LUA});

export const offsetKey = (replicationId: string, shard: number): string => \`offset:\${replicationId}:\${shard}\`;

/** Record that the target confirmed the shard up to offset; resolves the shard's offset afterwards. */
export async function advanceOffset(replicationId: string, shard: number, offset: number): Promise<number> {
  // No TTL: an offset that expires rewinds the shard to zero and replays its history.
  return Number(await redis.advance(offsetKey(replicationId, shard), offset));
}

/** Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one. */
export async function resumeOffset(replicationId: string, shard: number): Promise<number> {
  const raw = await redis.get(offsetKey(replicationId, shard));
  return raw === null ? 0 : Number(raw);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const offsetTTL = time.Hour

func offsetKey(replicationID string, shard int) string {
	return "offset:" + replicationID
}

// advanceOffset records that the target confirmed the shard up to offset; it returns the shard's offset afterwards.
func advanceOffset(ctx context.Context, replicationID string, shard int, offset int64) (int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := offsetKey(replicationID, shard)
	current, err := rdb.Get(ctx, key).Result()
	if err == redis.Nil {
		current = "0"
	} else if err != nil {
		return 0, err
	}
	if strconv.FormatInt(offset, 10) > current {
		return offset, rdb.Set(ctx, key, offset, offsetTTL).Err()
	}
	return strconv.ParseInt(current, 10, 64)
}

// resumeOffset is where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one.
func resumeOffset(ctx context.Context, replicationID string, shard int) (int64, error) {
	offset, err := rdb.Get(ctx, offsetKey(replicationID, shard)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return offset, err
}
`,
      solution: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// advance is a forward-only compare-and-set, as numbers: a late confirmation of an older offset changes nothing.
var advance = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = tonumber(ARGV[1])
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
\`)

func offsetKey(replicationID string, shard int) string {
	return fmt.Sprintf("offset:%s:%d", replicationID, shard)
}

// advanceOffset records that the target confirmed the shard up to offset; it returns the shard's offset afterwards.
func advanceOffset(ctx context.Context, replicationID string, shard int, offset int64) (int64, error) {
	// No TTL: an offset that expires rewinds the shard to zero and replays its history.
	return advance.Run(ctx, rdb, []string{offsetKey(replicationID, shard)}, offset).Int64()
}

// resumeOffset is where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one.
func resumeOffset(ctx context.Context, replicationID string, shard int) (int64, error) {
	offset, err := rdb.Get(ctx, offsetKey(replicationID, shard)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return offset, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object State {
  val jedis = new JedisPooled("redis", 6379)

  val OffsetTtlSeconds = 3600L

  def offsetKey(replicationId: String, shard: Int): String = s"offset:$replicationId"

  /** Record that the target confirmed the shard up to offset; returns the shard's offset afterwards. */
  def advanceOffset(replicationId: String, shard: Int, offset: Long): Long = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = offsetKey(replicationId, shard)
    val current = Option(jedis.get(key)).getOrElse("0")
    if (offset.toString > current) {
      jedis.set(key, offset.toString, SetParams.setParams().ex(OffsetTtlSeconds))
      offset
    } else current.toLong
  }

  /** Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one. */
  def resumeOffset(replicationId: String, shard: Int): Long =
    Option(jedis.get(offsetKey(replicationId, shard))).map(_.toLong).getOrElse(0L)
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Forward-only compare-and-set, as numbers: a late confirmation of an older offset changes nothing. */
  val AdvanceLua: String =
    """local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local candidate = tonumber(ARGV[1])
      |if candidate > current then
      |  redis.call('SET', KEYS[1], ARGV[1])
      |  return candidate
      |end
      |return current
      |""".stripMargin

  def offsetKey(replicationId: String, shard: Int): String = s"offset:$replicationId:$shard"

  /** Record that the target confirmed the shard up to offset; returns the shard's offset afterwards. */
  def advanceOffset(replicationId: String, shard: Int, offset: Long): Long =
    // No TTL: an offset that expires rewinds the shard to zero and replays its history.
    jedis.eval(AdvanceLua, List(offsetKey(replicationId, shard)).asJava, List(offset.toString).asJava).asInstanceOf[java.lang.Long]

  /** Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one. */
  def resumeOffset(replicationId: String, shard: Int): Long =
    Option(jedis.get(offsetKey(replicationId, shard))).map(_.toLong).getOrElse(0L)
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

const std::chrono::seconds kOffsetTtl{3600};

std::string offsetKey(const std::string& replication_id, int shard) { return "offset:" + replication_id; }

// Record that the target confirmed the shard up to offset; returns the shard's offset afterwards.
long long advanceOffset(const std::string& replication_id, int shard, long long offset) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = offsetKey(replication_id, shard);
  const std::string current = redis.get(key).value_or("0");
  if (std::to_string(offset) > current) {
    redis.set(key, std::to_string(offset), kOffsetTtl);
    return offset;
  }
  return std::stoll(current);
}

// Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one.
long long resumeOffset(const std::string& replication_id, int shard) {
  const auto raw = redis.get(offsetKey(replication_id, shard));
  return raw ? std::stoll(*raw) : 0;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// Forward-only compare-and-set, as numbers: a late confirmation of an older offset changes nothing.
const std::string kAdvanceLua = R"lua(
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local candidate = tonumber(ARGV[1])
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return candidate
end
return current
)lua";

std::string offsetKey(const std::string& replication_id, int shard) {
  return "offset:" + replication_id + ":" + std::to_string(shard);
}

// Record that the target confirmed the shard up to offset; returns the shard's offset afterwards.
long long advanceOffset(const std::string& replication_id, int shard, long long offset) {
  // No TTL: an offset that expires rewinds the shard to zero and replays its history.
  return redis.eval<long long>(kAdvanceLua, {offsetKey(replication_id, shard)}, {std::to_string(offset)});
}

// Where a restarted shard resumes: its confirmed offset, 0 when it never confirmed one.
long long resumeOffset(const std::string& replication_id, int shard) {
  const auto raw = redis.get(offsetKey(replication_id, shard));
  return raw ? std::stoll(*raw) : 0;
}
`,
    },
  },
  harness: {
    python: `def check_durable_offset(ctx):
    m = ctx.load("state")
    m.advance_offset("rep-1", 0, 42)
    for key in ctx.redis.keys("offset:*"):
        assert ctx.redis.ttl(key) == -1, f"{key} expires in {ctx.redis.ttl(key)} s: a shard that is quiet that long forgets its offset and the target re-applies its history"
    ctx.clock.advance(7200)
    resumed = m.resume_offset("rep-1", 0)
    assert resumed == 42, f"after two quiet hours resume_offset(rep-1, 0) is {resumed}, expected the confirmed offset 42"


def check_numeric_compare(ctx):
    m = ctx.load("state")
    m.advance_offset("rep-1", 0, 9)
    after = m.advance_offset("rep-1", 0, 10)
    resumed = m.resume_offset("rep-1", 0)
    assert resumed == 10 and after == 10, f"confirming 9 then 10 left the shard at {resumed} (advance returned {after}): offsets compared as strings put '10' before '9'"
    m.advance_offset("rep-1", 0, 11)
    late = m.advance_offset("rep-1", 0, 7)
    assert m.resume_offset("rep-1", 0) == 11 and late == 11, f"a late confirmation of 7 after 11 left the shard at {m.resume_offset('rep-1', 0)} (advance returned {late}), expected 11"


def check_atomic_advance(ctx):
    m = ctx.load("state")
    m.advance_offset("rep-1", 0, 1)
    rivals = [
        ctx.redis_after(key, lambda: m.advance_offset("rep-1", 0, 20))
        for key in ("offset:rep-1:0", "offset:rep-1")
    ]
    m.advance_offset("rep-1", 0, 15)
    fired = [p for p in rivals if p.fired]
    assert fired, "advance_offset never touched the shard's offset key"
    if fired[0].error is not None:
        raise fired[0].error
    resumed = m.resume_offset("rep-1", 0)
    assert resumed == 20, f"a worker confirmed 20 while this one advanced to 15, and the shard ended at {resumed}: read, compare and write must run in one script, or the older confirmation wins"

    def rival(key):
        def advance():  # another worker's forward-only advance to 30
            if int(ctx.redis.get(key) or 0) < 30:
                ctx.redis.set(key, 30)
        return advance

    for key in ("offset:rep-1:0", "offset:rep-1"):
        ctx.redis_after(key, rival(key))
    after = m.advance_offset("rep-1", 0, 40)
    resumed = m.resume_offset("rep-1", 0)
    assert resumed == 40 and after == 40, f"another worker advanced the shard to 30 while this one confirmed 40, and the shard ended at {resumed} (advance returned {after}): the larger confirmation must win, so a compare-and-set that lost the race retries"


def check_shard_key(ctx):
    m = ctx.load("state")
    m.advance_offset("rep-1", 0, 30)
    m.advance_offset("rep-1", 1, 12)
    first, second = m.resume_offset("rep-1", 0), m.resume_offset("rep-1", 1)
    assert (first, second) == (30, 12), f"shards 0 and 1 resume at {first} and {second}, expected 30 and 12: each shard needs its own offset key"
    assert ctx.redis.get("offset:rep-1:0") == "30" and ctx.redis.get("offset:rep-1:1") == "12", f"Redis holds {sorted(ctx.redis.keys('offset:*'))}, expected offset:rep-1:0 = 30 and offset:rep-1:1 = 12"
`,
    typescript: `export async function check_durable_offset(ctx) {
  const m = ctx.load('state');
  await m.advanceOffset('rep-1', 0, 42);
  for (const key of ctx.redis.keys('offset:*')) {
    assert.equal(ctx.redis.ttl(key), -1, \`\${key} expires in \${ctx.redis.ttl(key)} s: a shard that is quiet that long forgets its offset and the target re-applies its history\`);
  }
  ctx.clock.advance(7200);
  const resumed = await m.resumeOffset('rep-1', 0);
  assert.equal(resumed, 42, \`after two quiet hours resumeOffset(rep-1, 0) is \${resumed}, expected the confirmed offset 42\`);
}

export async function check_numeric_compare(ctx) {
  const m = ctx.load('state');
  await m.advanceOffset('rep-1', 0, 9);
  const after = await m.advanceOffset('rep-1', 0, 10);
  const resumed = await m.resumeOffset('rep-1', 0);
  assert(resumed === 10 && after === 10, \`confirming 9 then 10 left the shard at \${resumed} (advance returned \${after}): offsets compared as strings put '10' before '9'\`);
  await m.advanceOffset('rep-1', 0, 11);
  const late = await m.advanceOffset('rep-1', 0, 7);
  const now = await m.resumeOffset('rep-1', 0);
  assert(now === 11 && late === 11, \`a late confirmation of 7 after 11 left the shard at \${now} (advance returned \${late}), expected 11\`);
}

export async function check_atomic_advance(ctx) {
  const m = ctx.load('state');
  await m.advanceOffset('rep-1', 0, 1);
  const rivals = ['offset:rep-1:0', 'offset:rep-1'].map(key => ctx.redisAfter(key, () => m.advanceOffset('rep-1', 0, 20)));
  await m.advanceOffset('rep-1', 0, 15);
  const fired = rivals.filter(p => p.fired);
  assert(fired.length > 0, 'advanceOffset never touched the shard offset key');
  if (fired[0].error !== undefined) throw fired[0].error;
  await fired[0].result;
  let resumed = await m.resumeOffset('rep-1', 0);
  assert.equal(resumed, 20, \`a worker confirmed 20 while this one advanced to 15, and the shard ended at \${resumed}: read, compare and write must run in one script, or the older confirmation wins\`);
  for (const key of ['offset:rep-1:0', 'offset:rep-1']) {
    ctx.redisAfter(key, () => {
      // another worker's forward-only advance to 30
      if (Number(ctx.redis.get(key) ?? 0) < 30) ctx.redis.set(key, '30');
    });
  }
  const after = await m.advanceOffset('rep-1', 0, 40);
  resumed = await m.resumeOffset('rep-1', 0);
  assert(resumed === 40 && after === 40, \`another worker advanced the shard to 30 while this one confirmed 40, and the shard ended at \${resumed} (advance returned \${after}): the larger confirmation must win, so a compare-and-set that lost the race retries\`);
}

export async function check_shard_key(ctx) {
  const m = ctx.load('state');
  await m.advanceOffset('rep-1', 0, 30);
  await m.advanceOffset('rep-1', 1, 12);
  const first = await m.resumeOffset('rep-1', 0);
  const second = await m.resumeOffset('rep-1', 1);
  assert(first === 30 && second === 12, \`shards 0 and 1 resume at \${first} and \${second}, expected 30 and 12: each shard needs its own offset key\`);
  assert(ctx.redis.get('offset:rep-1:0') === '30' && ctx.redis.get('offset:rep-1:1') === '12', \`Redis holds \${JSON.stringify(ctx.redis.keys('offset:*'))}, expected offset:rep-1:0 = 30 and offset:rep-1:1 = 12\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"
)

var stateBg = context.Background()

func mustAdvance(ctx *harness.Ctx, shard int, offset int64) int64 {
	after, err := advanceOffset(stateBg, "rep-1", shard, offset)
	ctx.NoError(err, "advanceOffset(rep-1, %d, %d)", shard, offset)
	return after
}

func mustResume(ctx *harness.Ctx, shard int) int64 {
	offset, err := resumeOffset(stateBg, "rep-1", shard)
	ctx.NoError(err, "resumeOffset(rep-1, %d)", shard)
	return offset
}

func CheckDurableOffset(ctx *harness.Ctx) {
	mustAdvance(ctx, 0, 42)
	for _, key := range ctx.Redis.Keys("offset:*") {
		ctx.Equal(ctx.Redis.TTL(key), int64(-1), "%s expires: a shard that is quiet that long forgets its offset and the target re-applies its history; its TTL", key)
	}
	ctx.Clock.Advance(7200)
	ctx.Equal(mustResume(ctx, 0), int64(42), "after two quiet hours resumeOffset(rep-1, 0) must be the confirmed offset")
}

func CheckNumericCompare(ctx *harness.Ctx) {
	mustAdvance(ctx, 0, 9)
	after := mustAdvance(ctx, 0, 10)
	resumed := mustResume(ctx, 0)
	ctx.Assert(resumed == 10 && after == 10, "confirming 9 then 10 left the shard at %d (advance returned %d): offsets compared as strings put \\"10\\" before \\"9\\"", resumed, after)
	mustAdvance(ctx, 0, 11)
	late := mustAdvance(ctx, 0, 7)
	now := mustResume(ctx, 0)
	ctx.Assert(now == 11 && late == 11, "a late confirmation of 7 after 11 left the shard at %d (advance returned %d), expected 11", now, late)
}

func CheckAtomicAdvance(ctx *harness.Ctx) {
	mustAdvance(ctx, 0, 1)
	fired := false
	for _, key := range []string{"offset:rep-1:0", "offset:rep-1"} {
		ctx.Redis.After(key, func() any {
			fired = true
			after, err := advanceOffset(stateBg, "rep-1", 0, 20)
			ctx.NoError(err, "the rival advance failed")
			return after
		})
	}
	mustAdvance(ctx, 0, 15)
	ctx.Assert(fired, "advanceOffset never touched the shard's offset key")
	ctx.Equal(mustResume(ctx, 0), int64(20), "a worker confirmed 20 while this one advanced to 15: read, compare and write must run in one script, or the older confirmation wins; the shard's offset")
	for _, rivalKey := range []string{"offset:rep-1:0", "offset:rep-1"} {
		key := rivalKey
		ctx.Redis.After(key, func() any {
			// another worker's forward-only advance to 30
			current, _ := ctx.Redis.Get(key)
			if n, err := strconv.ParseInt(current, 10, 64); err != nil || n < 30 {
				ctx.Redis.Set(key, "30")
			}
			return nil
		})
	}
	after := mustAdvance(ctx, 0, 40)
	resumed := mustResume(ctx, 0)
	ctx.Assert(resumed == 40 && after == 40, "another worker advanced the shard to 30 while this one confirmed 40, and the shard ended at %d (advance returned %d): the larger confirmation must win, so a compare-and-set that lost the race retries", resumed, after)
}

func CheckShardKey(ctx *harness.Ctx) {
	mustAdvance(ctx, 0, 30)
	mustAdvance(ctx, 1, 12)
	first, second := mustResume(ctx, 0), mustResume(ctx, 1)
	ctx.Assert(first == 30 && second == 12, "shards 0 and 1 resume at %d and %d, expected 30 and 12: each shard needs its own offset key", first, second)
	a, _ := ctx.Redis.Get("offset:rep-1:0")
	b, _ := ctx.Redis.Get("offset:rep-1:1")
	ctx.Assert(a == "30" && b == "12", "Redis holds %q, expected offset:rep-1:0 = 30 and offset:rep-1:1 = 12", ctx.Redis.Keys("offset:*"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

namespace {

struct Rival {
  bool fired = false;
  std::optional<std::string> err;
};

std::shared_ptr<Rival> rivalAdvance(harness::Ctx& ctx, const std::string& key) {
  auto out = std::make_shared<Rival>();
  ctx.Redis.After(key, [out] {
    out->fired = true;
    try {
      advanceOffset("rep-1", 0, 20);
    } catch (const std::exception& e) {
      out->err = e.what();
    }
  });
  return out;
}

}  // namespace

void CheckDurableOffset(harness::Ctx& ctx) {
  advanceOffset("rep-1", 0, 42);
  for (const auto& key : ctx.Redis.Keys("offset:*")) {
    ctx.Equal(ctx.Redis.TTL(key), -1, "%s expires: a shard that is quiet that long forgets its offset and the target re-applies its history; its TTL", key);
  }
  ctx.Clock.Advance(7200);
  ctx.Equal(resumeOffset("rep-1", 0), 42, "after two quiet hours resumeOffset(rep-1, 0) must be the confirmed offset");
}

void CheckNumericCompare(harness::Ctx& ctx) {
  advanceOffset("rep-1", 0, 9);
  const long long after = advanceOffset("rep-1", 0, 10);
  const long long resumed = resumeOffset("rep-1", 0);
  ctx.Assert(resumed == 10 && after == 10, "confirming 9 then 10 left the shard at %d (advance returned %d): offsets compared as strings put \\"10\\" before \\"9\\"", resumed, after);
  advanceOffset("rep-1", 0, 11);
  const long long late = advanceOffset("rep-1", 0, 7);
  const long long now = resumeOffset("rep-1", 0);
  ctx.Assert(now == 11 && late == 11, "a late confirmation of 7 after 11 left the shard at %d (advance returned %d), expected 11", now, late);
}

void CheckAtomicAdvance(harness::Ctx& ctx) {
  advanceOffset("rep-1", 0, 1);
  const auto shardKey = rivalAdvance(ctx, "offset:rep-1:0");
  const auto sharedKey = rivalAdvance(ctx, "offset:rep-1");
  advanceOffset("rep-1", 0, 15);
  ctx.Assert(shardKey->fired || sharedKey->fired, "advanceOffset never touched the shard's offset key");
  ctx.Assert(!shardKey->err && !sharedKey->err, "the rival advance failed: %s", shardKey->err.value_or(sharedKey->err.value_or("")));
  ctx.Equal(resumeOffset("rep-1", 0), 20, "a worker confirmed 20 while this one advanced to 15: read, compare and write must run in one script, or the older confirmation wins; the shard's offset");
  for (const std::string key : {"offset:rep-1:0", "offset:rep-1"}) {
    ctx.Redis.After(key, [&ctx, key] {
      // another worker's forward-only advance to 30
      const auto current = ctx.Redis.Get(key);
      if (!current || std::stoll(*current) < 30) ctx.Redis.Set(key, "30");
    });
  }
  const long long after = advanceOffset("rep-1", 0, 40);
  const long long resumed = resumeOffset("rep-1", 0);
  ctx.Assert(resumed == 40 && after == 40, "another worker advanced the shard to 30 while this one confirmed 40, and the shard ended at %d (advance returned %d): the larger confirmation must win, so a compare-and-set that lost the race retries", resumed, after);
}

void CheckShardKey(harness::Ctx& ctx) {
  advanceOffset("rep-1", 0, 30);
  advanceOffset("rep-1", 1, 12);
  const long long first = resumeOffset("rep-1", 0);
  const long long second = resumeOffset("rep-1", 1);
  ctx.Assert(first == 30 && second == 12, "shards 0 and 1 resume at %d and %d, expected 30 and 12: each shard needs its own offset key", first, second);
  ctx.Assert(ctx.Redis.Get("offset:rep-1:0").value_or("") == "30" && ctx.Redis.Get("offset:rep-1:1").value_or("") == "12",
             "Redis holds %q, expected offset:rep-1:0 = 30 and offset:rep-1:1 = 12", ctx.Redis.Keys("offset:*"));
}
`,
  },
  hints: [
    'Confirm offset 42, let two hours pass and restart: the shard resumes at 0. Confirm 9 then 10: the shard stays at 9. Two shards of one replication show the same offset.',
    'The key is set with a one-hour expiry and has no shard in its name; the compare is between two strings, where "10" sorts before "9"; and the GET and the SET are two round trips another worker can land between.',
    'Key `offset:{replication_id}:{shard}`; one Lua script: `tonumber(GET or 0)`, `SET` the candidate only if `tonumber(ARGV[1])` is larger, return the stored value; no `ex`. `resume_offset` reads the same key.',
  ],
  debrief: `An offset is the replicator's only memory of where a shard stands, so everything about it is chosen so it cannot go backwards: no expiry, because time passing is not evidence that anything was applied; a numeric compare, because offsets are numbers; and the compare inside the script, because confirmations from parallel workers arrive in any order and the larger one must win whoever writes last. Keying by shard is what lets shards advance independently. Kafka Connect keeps source offsets in a compacted topic for the same reasons, and flushes them on an interval, which is why a crash replays a few changes and the target must dedupe them: the next step's change ids exist for that.`,
};
