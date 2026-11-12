import type {Step} from '@/lib/types';

// ---- 2. Latest position per vehicle: one Lua compare-and-set ----------------------------------------
export const stateStep: Step = {
  id: 'state',
  title: 'The latest position per vehicle, decided in one Lua script',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter's \`update_latest(vehicle_id, position)\` reads the \`ts\` field of
the hash \`vehicle:{vehicle_id}:latest\`, returns \`False\` when the incoming timestamp is older,
and otherwise writes \`ts\`, \`seq\`, \`lat\` and \`lon\` and returns \`True\`. It serves the demo
and hides four flaws.

**Failure mode the checks target.** Positions arrive late, out of order, replayed, and from more
than one fleetd replica at once. A delayed packet must not roll the record back, a replay must be
reported as ignored so the endpoint counts it as \`duplicate\`, and two replicas writing the same
vehicle must not lose the fresher position.

- The record is the hash \`vehicle:{vehicle_id}:latest\` with fields \`ts\` (the device timestamp in
  ms), \`seq\`, \`lat\` and \`lon\`.
- A position is applied when its timestamp is newer than the stored one, or equal with a higher
  sequence; everything else, the exact same position included, is ignored. Compare as numbers.
- The read, the comparison and the write run inside **one Lua script** (\`EVAL\`/\`EVALSHA\`) so
  nothing lands between them.
- \`update_latest\` returns whether the position was applied, and costs one round trip.`,
  sequence: {
    participants: ['fleetd', 'Redis'],
    messages: [
      {from: 'fleetd', to: 'Redis', label: 'EVALSHA latest vehicle:v-1:latest 2000 2 47.6 -122.3', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'HMGET ts seq → 1000 1 · newer → HSET', kind: 'sync'},
      {from: 'Redis', to: 'fleetd', label: '1 (applied)', kind: 'reply'},
      {from: 'fleetd', to: 'Redis', label: 'EVALSHA latest vehicle:v-1:latest 1500 3 …', kind: 'sync'},
      {from: 'Redis', to: 'fleetd', label: '0 (older: ignored)', kind: 'reply'},
    ],
  },
  hints: [
    'On the map a truck jumps back to where it was a minute ago whenever a delayed packet lands, and a device replaying its buffer after a reconnect gets every position counted as accepted.',
    'The starter reads `ts`, decides on the client, then writes: a fresher write from another replica lands in between and is overwritten. The decision ignores `seq`, and the write reports applied when nothing changed.',
    'One Lua script: `HMGET ts seq`, `tonumber` both, return 0 unless the timestamp is newer or equal with a higher `seq`, else `HSET` the four fields and return 1. Call it with `EVALSHA`.',
  ],
  checks: [
    {
      id: 'compare-ts',
      title: 'Timestamp first, then sequence',
      detail:
        'A newer timestamp is applied even with a lower sequence (the device rebooted); an older one is ignored even with a higher sequence; equal timestamps go to the higher sequence, compared as numbers. The starter compares the timestamp alone and writes on a tie.',
      match: {
        python: {
          all: [/tonumber\(/, /\bseq\b/],
          none: [/position\[["']device_timestamp_ms["']\]\s*<\s*int\(/],
        },
        typescript: {all: [/tonumber\(/, /\bseq\b/], none: [/position\.device_timestamp_ms\s*<\s*Number\(/]},
        go: {all: [/tonumber\(/, /\bseq\b/], none: [/p\.DeviceTimestampMs\s*<\s*current/]},
        scala: {all: [/tonumber\(/, /\bseq\b/], none: [/p\.deviceTimestampMs\s*<\s*_/]},
        cpp: {all: [/tonumber\(/, /\bseq\b/], none: [/p\.device_timestamp_ms\s*<\s*std::stoll/]},
      },
    },
    {
      id: 'eval',
      title: 'Read, compare and write inside one Lua script',
      detail:
        'The hash is read and written by a script run with `EVAL`/`EVALSHA` (`register_script`, `defineCommand`, `redis.NewScript`, `scriptLoad`); a client-side read then write lets another replica land in between.',
      match: {
        python: {
          all: [
            /redis\.call\(\s*['"]HM?GET['"]/,
            /redis\.call\(\s*['"]HSET['"]/,
            /register_script\(|\.eval\(|\.evalsha\(/,
          ],
          none: [/\br\.hget\(|\br\.hset\(|\br\.hmget\(/],
        },
        typescript: {
          all: [
            /redis\.call\(\s*['"]HM?GET['"]/,
            /redis\.call\(\s*['"]HSET['"]/,
            /defineCommand\(|\.eval\(|\.evalsha\(/,
          ],
          none: [/redis\.hget\(|redis\.hset\(|redis\.hmget\(/],
        },
        go: {
          all: [
            /redis\.call\(\s*['"]HM?GET['"]/,
            /redis\.call\(\s*['"]HSET['"]/,
            /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/,
          ],
          none: [/rdb\.HGet\(|rdb\.HSet\(|rdb\.HMGet\(/],
        },
        scala: {
          all: [/redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]HSET['"]/, /jedis\.eval(sha)?\(/],
          none: [/jedis\.hget\(|jedis\.hset\(|jedis\.hmget\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]HSET['"]/, /redis\.eval(sha)?[<(]/],
          none: [/redis\.hget\(|redis\.hset\(|redis\.hmget\(/],
        },
      },
    },
    {
      id: 'replay',
      title: 'A replayed position is reported as ignored',
      detail:
        'The exact same position again (equal timestamp and sequence) changes nothing and returns ignored, so the endpoint counts it as `duplicate`. The starter writes it again and reports applied.',
      match: {
        python: {all: [/seq\s*<=\s*current_seq|current_seq\s*>=\s*seq/, /return 0/, /return 1/]},
        typescript: {all: [/seq\s*<=\s*current_seq|current_seq\s*>=\s*seq/, /return 0/, /return 1/]},
        go: {all: [/seq\s*<=\s*current_seq|current_seq\s*>=\s*seq/, /return 0/, /return 1/]},
        scala: {all: [/seq\s*<=\s*current_seq|current_seq\s*>=\s*seq/, /return 0/, /return 1/]},
        cpp: {all: [/seq\s*<=\s*current_seq|current_seq\s*>=\s*seq/, /return 0/, /return 1/]},
      },
    },
    {
      id: 'one-round-trip',
      title: 'One round trip per update',
      detail:
        'Once the script is loaded, an update is one `EVALSHA`: 5 000 vehicles reporting every second must not cost a read and a write each.',
      match: {
        python: {all: [/register_script\(|\.evalsha\(/], none: [/\br\.hget\(/]},
        typescript: {all: [/defineCommand\(|\.evalsha\(/], none: [/redis\.hget\(/]},
        go: {all: [/redis\.NewScript\(|\.EvalSha\(/], none: [/rdb\.HGet\(/]},
        scala: {all: [/scriptLoad\(|jedis\.evalsha\(/], none: [/jedis\.hget\(/]},
        cpp: {all: [/script_load\(|redis\.evalsha[<(]/], none: [/redis\.hget\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def latest_key(vehicle_id: str) -> str:
    return f"vehicle:{vehicle_id}:latest"


def update_latest(vehicle_id: str, position: dict) -> bool:
    """Write the position as the vehicle's latest when it is newer; True when it was applied."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    key = latest_key(vehicle_id)
    current = r.hget(key, "ts")
    if current is not None and position["device_timestamp_ms"] < int(current):
        return False
    r.hset(
        key,
        mapping={
            "ts": position["device_timestamp_ms"],
            "seq": position["sequence"],
            "lat": position["lat"],
            "lon": position["lon"],
        },
    )
    return True
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LATEST_SCRIPT = """
local stored = redis.call('HMGET', KEYS[1], 'ts', 'seq')
local ts, seq = tonumber(ARGV[1]), tonumber(ARGV[2])
local current_ts, current_seq = tonumber(stored[1]), tonumber(stored[2])
if current_ts and (ts < current_ts or (ts == current_ts and seq <= current_seq)) then
  return 0
end
redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'seq', ARGV[2], 'lat', ARGV[3], 'lon', ARGV[4])
return 1
"""
compare_and_set = r.register_script(LATEST_SCRIPT)  # EVALSHA, with EVAL as the fallback on NOSCRIPT


def latest_key(vehicle_id: str) -> str:
    return f"vehicle:{vehicle_id}:latest"


def update_latest(vehicle_id: str, position: dict) -> bool:
    """Write the position as the vehicle's latest when it is newer; True when it was applied."""
    applied = compare_and_set(
        keys=[latest_key(vehicle_id)],
        args=[position["device_timestamp_ms"], position["sequence"], position["lat"], position["lon"]],
    )
    return applied == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {Position} from 'fleet/position';

export const redis = new Redis({host: 'redis', port: 6379});

export const latestKey = (vehicleId: string): string => \`vehicle:\${vehicleId}:latest\`;

/** Write the position as the vehicle's latest when it is newer; true when it was applied. */
export async function updateLatest(vehicleId: string, position: Position): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const key = latestKey(vehicleId);
  const current = await redis.hget(key, 'ts');
  if (current !== null && position.device_timestamp_ms < Number(current)) return false;
  await redis.hset(key, {ts: position.device_timestamp_ms, seq: position.sequence, lat: position.lat, lon: position.lon});
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import type {Position} from 'fleet/position';

const LATEST_SCRIPT = \`
local stored = redis.call('HMGET', KEYS[1], 'ts', 'seq')
local ts, seq = tonumber(ARGV[1]), tonumber(ARGV[2])
local current_ts, current_seq = tonumber(stored[1]), tonumber(stored[2])
if current_ts and (ts < current_ts or (ts == current_ts and seq <= current_seq)) then
  return 0
end
redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'seq', ARGV[2], 'lat', ARGV[3], 'lon', ARGV[4])
return 1
\`;

interface LatestRedis extends Redis {
  compareAndSet(key: string, ts: number, seq: number, lat: number, lon: number): Promise<number>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as LatestRedis;
// Loaded once: every call is an EVALSHA, with EVAL as the fallback on NOSCRIPT.
redis.defineCommand('compareAndSet', {numberOfKeys: 1, lua: LATEST_SCRIPT});

export const latestKey = (vehicleId: string): string => \`vehicle:\${vehicleId}:latest\`;

/** Write the position as the vehicle's latest when it is newer; true when it was applied. */
export async function updateLatest(vehicleId: string, position: Position): Promise<boolean> {
  const applied = await redis.compareAndSet(
    latestKey(vehicleId),
    position.device_timestamp_ms,
    position.sequence,
    position.lat,
    position.lon,
  );
  return applied === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"

	"fleet/position"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func latestKey(vehicleID string) string { return "vehicle:" + vehicleID + ":latest" }

// updateLatest writes the position as the vehicle's latest when it is newer; true when it was applied.
func updateLatest(ctx context.Context, vehicleID string, p position.Position) (bool, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	key := latestKey(vehicleID)
	current, err := rdb.HGet(ctx, key, "ts").Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return false, err
	}
	if err == nil && p.DeviceTimestampMs < current {
		return false, nil
	}
	if err := rdb.HSet(ctx, key, "ts", p.DeviceTimestampMs, "seq", p.Sequence, "lat", p.Lat, "lon", p.Lon).Err(); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"fleet/position"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Run uses EVALSHA and falls back to EVAL once when the script is not loaded yet.
var compareAndSet = redis.NewScript(\`
local stored = redis.call('HMGET', KEYS[1], 'ts', 'seq')
local ts, seq = tonumber(ARGV[1]), tonumber(ARGV[2])
local current_ts, current_seq = tonumber(stored[1]), tonumber(stored[2])
if current_ts and (ts < current_ts or (ts == current_ts and seq <= current_seq)) then
  return 0
end
redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'seq', ARGV[2], 'lat', ARGV[3], 'lon', ARGV[4])
return 1
\`)

func latestKey(vehicleID string) string { return "vehicle:" + vehicleID + ":latest" }

// updateLatest writes the position as the vehicle's latest when it is newer; true when it was applied.
func updateLatest(ctx context.Context, vehicleID string, p position.Position) (bool, error) {
	applied, err := compareAndSet.Run(ctx, rdb, []string{latestKey(vehicleID)}, p.DeviceTimestampMs, p.Sequence, p.Lat, p.Lon).Int()
	if err != nil {
		return false, err
	}
	return applied == 1, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import fleet.Position

object State {
  val jedis = new JedisPooled("redis", 6379)

  def latestKey(vehicleId: String): String = s"vehicle:$vehicleId:latest"

  /** Write the position as the vehicle's latest when it is newer; true when it was applied. */
  def updateLatest(vehicleId: String, p: Position): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val key = latestKey(vehicleId)
    val current = Option(jedis.hget(key, "ts")).map(_.toLong)
    if (current.exists(p.deviceTimestampMs < _)) return false
    val fields = Map(
      "ts"  -> p.deviceTimestampMs.toString,
      "seq" -> p.sequence.toString,
      "lat" -> p.lat.toString,
      "lon" -> p.lon.toString
    )
    jedis.hset(key, fields.asJava)
    true
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import fleet.Position

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LatestScript: String =
    """local stored = redis.call('HMGET', KEYS[1], 'ts', 'seq')
      |local ts, seq = tonumber(ARGV[1]), tonumber(ARGV[2])
      |local current_ts, current_seq = tonumber(stored[1]), tonumber(stored[2])
      |if current_ts and (ts < current_ts or (ts == current_ts and seq <= current_seq)) then
      |  return 0
      |end
      |redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'seq', ARGV[2], 'lat', ARGV[3], 'lon', ARGV[4])
      |return 1
      |""".stripMargin
  private val sha = jedis.scriptLoad(LatestScript)

  def latestKey(vehicleId: String): String = s"vehicle:$vehicleId:latest"

  /** Write the position as the vehicle's latest when it is newer; true when it was applied. */
  def updateLatest(vehicleId: String, p: Position): Boolean = {
    val args = List(p.deviceTimestampMs.toString, p.sequence.toString, p.lat.toString, p.lon.toString).asJava
    jedis.evalsha(sha, List(latestKey(vehicleId)).asJava, args).asInstanceOf[java.lang.Long] == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "position.h"

sw::redis::Redis redis("tcp://redis:6379");

std::string latest_key(const std::string& vehicle_id) { return "vehicle:" + vehicle_id + ":latest"; }

// Write the position as the vehicle's latest when it is newer; true when it was applied.
bool update_latest(const std::string& vehicle_id, const Position& p) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string key = latest_key(vehicle_id);
  const auto current = redis.hget(key, "ts");
  if (current && p.device_timestamp_ms < std::stoll(*current)) return false;
  redis.hset(key, {{"ts", p.device_timestamp_ms}, {"seq", p.sequence}, {"lat", p.lat}, {"lon", p.lon}});
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

#include "position.h"

sw::redis::Redis redis("tcp://redis:6379");

const std::string kLatestScript = R"lua(
local stored = redis.call('HMGET', KEYS[1], 'ts', 'seq')
local ts, seq = tonumber(ARGV[1]), tonumber(ARGV[2])
local current_ts, current_seq = tonumber(stored[1]), tonumber(stored[2])
if current_ts and (ts < current_ts or (ts == current_ts and seq <= current_seq)) then
  return 0
end
redis.call('HSET', KEYS[1], 'ts', ARGV[1], 'seq', ARGV[2], 'lat', ARGV[3], 'lon', ARGV[4])
return 1
)lua";
const std::string kLatestSha = redis.script_load(kLatestScript);

std::string latest_key(const std::string& vehicle_id) { return "vehicle:" + vehicle_id + ":latest"; }

// Write the position as the vehicle's latest when it is newer; true when it was applied.
bool update_latest(const std::string& vehicle_id, const Position& p) {
  const long long applied =
      redis.evalsha<long long>(kLatestSha, {latest_key(vehicle_id)}, {p.device_timestamp_ms, p.sequence, p.lat, p.lon});
  return applied == 1;
}
`,
    },
  },
  harness: {
    python: `from leetbuild.metrics import METRICS

V1 = "vehicle:v-1:latest"


def pos(ts, seq, lat=47.6, lon=-122.3):
    return {"vehicle_id": "v-1", "device_timestamp_ms": ts, "sequence": seq, "lat": lat, "lon": lon}


def record(ctx):
    """The record as numbers (ts, seq, lat, lon), or None."""
    h = ctx.redis.hgetall(V1)
    if not h:
        return None
    assert {"ts", "seq", "lat", "lon"} <= set(h), f"vehicle:v-1:latest holds fields {sorted(h)}, expected ts, seq, lat, lon"
    return (int(float(h["ts"])), int(float(h["seq"])), float(h["lat"]), float(h["lon"]))


def check_compare_ts(ctx):
    m = ctx.load("state")
    assert m.update_latest("v-1", pos(1000, 1)) is True, "the first position for a vehicle must be applied (True)"
    assert record(ctx) == (1000, 1, 47.6, -122.3), f"after the first position vehicle:v-1:latest holds {record(ctx)}, expected (1000, 1, 47.6, -122.3)"
    assert m.update_latest("v-1", pos(900, 2, lat=1.0)) is False, "an older timestamp (900 after 1000) must be ignored even with a higher sequence: the device's clock orders positions, its counter only breaks ties"
    assert record(ctx)[0] == 1000 and record(ctx)[2] == 47.6, f"the older position overwrote the record ({record(ctx)}): the map shows where the vehicle was"
    assert m.update_latest("v-1", pos(2000, 0, lat=2.0)) is True, "a newer timestamp with a lower sequence (the device rebooted and its counter restarted) must be applied"
    assert m.update_latest("v-1", pos(2000, 9, lat=3.0)) is True, "equal timestamps: the higher sequence (9 after 0) must be applied"
    assert m.update_latest("v-1", pos(2000, 10, lat=4.0)) is True, "equal timestamps: sequence 10 is higher than 9; comparing them as strings ('10' < '9') ignores it"
    assert m.update_latest("v-1", pos(2000, 9, lat=5.0)) is False, "equal timestamps: a lower sequence (9 after 10) must be ignored"
    assert record(ctx) == (2000, 10, 4.0, -122.3), f"vehicle:v-1:latest holds {record(ctx)}, expected the winner (2000, 10, 4.0, -122.3)"


def check_eval(ctx):
    m = ctx.load("state")
    assert m.update_latest("v-1", pos(1000, 1)) is True, "the first position for a vehicle must be applied"
    # Another fleetd replica lands right after the first command that touches the record, between a
    # client-side read and its write, with a fresher position.
    probe = ctx.redis_after(V1, lambda: ctx.redis.hset(V1, mapping={"ts": 3000, "seq": 5, "lat": 9.0, "lon": 9.0}))
    m.update_latest("v-1", pos(2000, 2, lat=2.0))
    assert probe.fired, "update_latest sent no command touching vehicle:v-1:latest"
    rec = record(ctx)
    assert rec is not None and rec[0] == 3000, f"vehicle:v-1:latest holds ts {rec and rec[0]} after another replica wrote ts 3000 between your read and your write: the fresher position was lost. Read, compare and write inside one Lua script (EVAL/EVALSHA), which Redis runs without interleaving"
    assert m.update_latest("v-1", pos(2500, 3)) is False, "with ts 3000 stored, a position at 2500 must be ignored"


def check_replay(ctx):
    m = ctx.load("state")
    assert m.update_latest("v-1", pos(1000, 7)) is True, "the first position for a vehicle must be applied"
    before = ctx.redis.hgetall(V1)
    applied = m.update_latest("v-1", pos(1000, 7))
    assert applied is False, f"the same position again (a device replaying its buffer after a reconnect) was reported as {applied!r}: the endpoint counts it as accepted instead of duplicate. Equal timestamp and equal sequence is not newer"
    assert ctx.redis.hgetall(V1) == before, f"a replay changed the record from {before} to {ctx.redis.hgetall(V1)}"
    assert m.update_latest("v-1", pos(1000, 8)) is True, "the next sequence at the same timestamp is new and must be applied"


def check_one_round_trip(ctx):
    m = ctx.load("state")
    m.update_latest("v-1", pos(1000, 1))  # the first call may load the script
    before = METRICS.redis_trips
    m.update_latest("v-1", pos(2000, 2))
    m.update_latest("v-1", pos(1500, 3))
    trips = METRICS.redis_trips - before
    assert trips <= 2, f"two updates cost {trips} Redis round trips, expected one each (EVALSHA): 5 000 vehicles reporting every second must not pay a read and a write per position"
    assert record(ctx)[0] == 2000, f"vehicle:v-1:latest holds {record(ctx)}, expected ts 2000"
`,
    typescript: `const V1 = 'vehicle:v-1:latest';

const pos = (ts: number, seq: number, lat = 47.6, lon = -122.3) => ({vehicle_id: 'v-1', device_timestamp_ms: ts, sequence: seq, lat, lon});

/** The record as numbers [ts, seq, lat, lon], or null. */
function record(ctx): [number, number, number, number] | null {
  const h = ctx.redis.hgetall(V1) as Record<string, string>;
  const fields = Object.keys(h);
  if (fields.length === 0) return null;
  assert(['ts', 'seq', 'lat', 'lon'].every(f => fields.includes(f)), \`vehicle:v-1:latest holds fields \${JSON.stringify(fields.sort())}, expected ts, seq, lat, lon\`);
  return [Number(h.ts), Number(h.seq), Number(h.lat), Number(h.lon)];
}

export async function check_compare_ts(ctx) {
  const m = ctx.load('state');
  assert.strictEqual(await m.updateLatest('v-1', pos(1000, 1)), true, 'the first position for a vehicle must be applied (true)');
  assert.deepStrictEqual(record(ctx), [1000, 1, 47.6, -122.3], \`after the first position vehicle:v-1:latest holds \${JSON.stringify(record(ctx))}, expected [1000, 1, 47.6, -122.3]\`);
  assert.strictEqual(await m.updateLatest('v-1', pos(900, 2, 1.0)), false, "an older timestamp (900 after 1000) must be ignored even with a higher sequence: the device's clock orders positions, its counter only breaks ties");
  assert(record(ctx)[0] === 1000 && record(ctx)[2] === 47.6, \`the older position overwrote the record (\${JSON.stringify(record(ctx))}): the map shows where the vehicle was\`);
  assert.strictEqual(await m.updateLatest('v-1', pos(2000, 0, 2.0)), true, 'a newer timestamp with a lower sequence (the device rebooted and its counter restarted) must be applied');
  assert.strictEqual(await m.updateLatest('v-1', pos(2000, 9, 3.0)), true, 'equal timestamps: the higher sequence (9 after 0) must be applied');
  assert.strictEqual(await m.updateLatest('v-1', pos(2000, 10, 4.0)), true, "equal timestamps: sequence 10 is higher than 9; comparing them as strings ('10' < '9') ignores it");
  assert.strictEqual(await m.updateLatest('v-1', pos(2000, 9, 5.0)), false, 'equal timestamps: a lower sequence (9 after 10) must be ignored');
  assert.deepStrictEqual(record(ctx), [2000, 10, 4.0, -122.3], \`vehicle:v-1:latest holds \${JSON.stringify(record(ctx))}, expected the winner [2000, 10, 4, -122.3]\`);
}

export async function check_eval(ctx) {
  const m = ctx.load('state');
  assert.strictEqual(await m.updateLatest('v-1', pos(1000, 1)), true, 'the first position for a vehicle must be applied');
  // Another fleetd replica lands right after the first command that touches the record, between a
  // client-side read and its write, with a fresher position.
  const probe = ctx.redisAfter(V1, () => ctx.redis.hset(V1, 'ts', 3000, 'seq', 5, 'lat', 9.0, 'lon', 9.0));
  await m.updateLatest('v-1', pos(2000, 2, 2.0));
  assert(probe.fired, 'updateLatest sent no command touching vehicle:v-1:latest');
  const rec = record(ctx);
  assert(rec !== null && rec[0] === 3000, \`vehicle:v-1:latest holds ts \${rec?.[0]} after another replica wrote ts 3000 between your read and your write: the fresher position was lost. Read, compare and write inside one Lua script (EVAL/EVALSHA), which Redis runs without interleaving\`);
  assert.strictEqual(await m.updateLatest('v-1', pos(2500, 3)), false, 'with ts 3000 stored, a position at 2500 must be ignored');
}

export async function check_replay(ctx) {
  const m = ctx.load('state');
  assert.strictEqual(await m.updateLatest('v-1', pos(1000, 7)), true, 'the first position for a vehicle must be applied');
  const before = JSON.stringify(ctx.redis.hgetall(V1));
  const applied = await m.updateLatest('v-1', pos(1000, 7));
  assert.strictEqual(applied, false, \`the same position again (a device replaying its buffer after a reconnect) was reported as \${JSON.stringify(applied)}: the endpoint counts it as accepted instead of duplicate. Equal timestamp and equal sequence is not newer\`);
  assert.strictEqual(JSON.stringify(ctx.redis.hgetall(V1)), before, \`a replay changed the record from \${before} to \${JSON.stringify(ctx.redis.hgetall(V1))}\`);
  assert.strictEqual(await m.updateLatest('v-1', pos(1000, 8)), true, 'the next sequence at the same timestamp is new and must be applied');
}

export async function check_one_round_trip(ctx) {
  const m = ctx.load('state');
  await m.updateLatest('v-1', pos(1000, 1)); // the first call may load the script
  const before = ctx.redisRoundTrips().length;
  await m.updateLatest('v-1', pos(2000, 2));
  await m.updateLatest('v-1', pos(1500, 3));
  const trips = ctx.redisRoundTrips().length - before;
  assert(trips <= 2, \`two updates cost \${trips} Redis round trips, expected one each (EVALSHA): 5 000 vehicles reporting every second must not pay a read and a write per position\`);
  assert.strictEqual(record(ctx)[0], 2000, \`vehicle:v-1:latest holds \${JSON.stringify(record(ctx))}, expected ts 2000\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"

	"fleet/position"
)

const stateV1 = "vehicle:v-1:latest"

func statePos(ts, seq int64, latLon ...float64) position.Position {
	p := position.Position{VehicleID: "v-1", DeviceTimestampMs: ts, Sequence: seq, Lat: 47.6, Lon: -122.3}
	if len(latLon) > 0 {
		p.Lat = latLon[0]
	}
	if len(latLon) > 1 {
		p.Lon = latLon[1]
	}
	return p
}

// stateRecord is the record as numbers [ts, seq, lat, lon], or nil.
func stateRecord(ctx *harness.Ctx) []float64 {
	h := ctx.Redis.HGetAll(stateV1)
	if len(h) == 0 {
		return nil
	}
	out := make([]float64, 0, 4)
	for _, f := range []string{"ts", "seq", "lat", "lon"} {
		v, ok := h[f]
		ctx.Assert(ok, "vehicle:v-1:latest holds fields %v, expected ts, seq, lat, lon", h)
		n, err := strconv.ParseFloat(v, 64)
		ctx.NoError(err, "vehicle:v-1:latest field %s is %q, expected a number", f, v)
		out = append(out, n)
	}
	return out
}

func stateUpdate(ctx *harness.Ctx, p position.Position) bool {
	applied, err := updateLatest(context.Background(), "v-1", p)
	ctx.NoError(err, "updateLatest(%v)", p)
	return applied
}

func CheckCompareTs(ctx *harness.Ctx) {
	ctx.Equal(stateUpdate(ctx, statePos(1000, 1)), true, "the first position for a vehicle must be applied")
	ctx.Equal(stateRecord(ctx), []float64{1000, 1, 47.6, -122.3}, "after the first position vehicle:v-1:latest (ts, seq, lat, lon)")
	ctx.Equal(stateUpdate(ctx, statePos(900, 2, 1.0)), false, "an older timestamp (900 after 1000) must be ignored even with a higher sequence: the device's clock orders positions, its counter only breaks ties; applied")
	rec := stateRecord(ctx)
	ctx.Assert(rec[0] == 1000 && rec[2] == 47.6, "the older position overwrote the record (%v): the map shows where the vehicle was", rec)
	ctx.Equal(stateUpdate(ctx, statePos(2000, 0, 2.0)), true, "a newer timestamp with a lower sequence (the device rebooted and its counter restarted) must be applied")
	ctx.Equal(stateUpdate(ctx, statePos(2000, 9, 3.0)), true, "equal timestamps: the higher sequence (9 after 0) must be applied")
	ctx.Equal(stateUpdate(ctx, statePos(2000, 10, 4.0)), true, "equal timestamps: sequence 10 is higher than 9; comparing them as strings ('10' < '9') ignores it; applied")
	ctx.Equal(stateUpdate(ctx, statePos(2000, 9, 5.0)), false, "equal timestamps: a lower sequence (9 after 10) must be ignored; applied")
	ctx.Equal(stateRecord(ctx), []float64{2000, 10, 4.0, -122.3}, "vehicle:v-1:latest must hold the winner (ts, seq, lat, lon)")
}

func CheckEval(ctx *harness.Ctx) {
	ctx.Equal(stateUpdate(ctx, statePos(1000, 1)), true, "the first position for a vehicle must be applied")
	// Another fleetd replica lands right after the first command that touches the record, between a
	// client-side read and its write, with a fresher position.
	probe := ctx.Redis.After(stateV1, func() any {
		return ctx.Redis.Do("HSET", stateV1, "ts", 3000, "seq", 5, "lat", 9.0, "lon", 9.0)
	})
	stateUpdate(ctx, statePos(2000, 2, 2.0))
	ctx.Assert(probe.Fired, "updateLatest sent no command touching vehicle:v-1:latest")
	rec := stateRecord(ctx)
	ctx.Assert(rec != nil && rec[0] == 3000, "vehicle:v-1:latest holds %v after another replica wrote ts 3000 between your read and your write: the fresher position was lost. Read, compare and write inside one Lua script (EVAL/EVALSHA), which Redis runs without interleaving", rec)
	ctx.Equal(stateUpdate(ctx, statePos(2500, 3)), false, "with ts 3000 stored, a position at 2500 must be ignored; applied")
}

func CheckReplay(ctx *harness.Ctx) {
	ctx.Equal(stateUpdate(ctx, statePos(1000, 7)), true, "the first position for a vehicle must be applied")
	before := ctx.Redis.HGetAll(stateV1)
	applied := stateUpdate(ctx, statePos(1000, 7))
	ctx.Assert(!applied, "the same position again (a device replaying its buffer after a reconnect) was reported as applied: the endpoint counts it as accepted instead of duplicate. Equal timestamp and equal sequence is not newer")
	ctx.Equal(ctx.Redis.HGetAll(stateV1), before, "a replay must not change the record")
	ctx.Equal(stateUpdate(ctx, statePos(1000, 8)), true, "the next sequence at the same timestamp is new and must be applied")
}

func CheckOneRoundTrip(ctx *harness.Ctx) {
	stateUpdate(ctx, statePos(1000, 1)) // the first call may load the script
	before := len(ctx.Redis.RoundTrips())
	stateUpdate(ctx, statePos(2000, 2))
	stateUpdate(ctx, statePos(1500, 3))
	trips := len(ctx.Redis.RoundTrips()) - before
	ctx.Assert(trips <= 2, "two updates cost %d Redis round trips, expected one each (EVALSHA): 5 000 vehicles reporting every second must not pay a read and a write per position", trips)
	ctx.Equal(stateRecord(ctx)[0], 2000, "vehicle:v-1:latest ts")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace {

const std::string kStateV1 = "vehicle:v-1:latest";

Position statePos(long long ts, long long seq, double lat = 47.6, double lon = -122.3) {
  return Position{"v-1", ts, seq, lat, lon};
}

// The record as numbers {ts, seq, lat, lon}, or empty.
std::vector<double> stateRecord(harness::Ctx& ctx) {
  const auto h = ctx.Redis.HGetAll(kStateV1);
  if (h.empty()) return {};
  std::vector<double> out;
  for (const std::string f : {"ts", "seq", "lat", "lon"}) {
    const auto it = h.find(f);
    ctx.Assert(it != h.end(), "vehicle:v-1:latest holds fields %v, expected ts, seq, lat, lon", h);
    char* end = nullptr;
    const double n = std::strtod(it->second.c_str(), &end);
    ctx.Assert(end != it->second.c_str(), "vehicle:v-1:latest field %s is %q, expected a number", f, it->second);
    out.push_back(n);
  }
  return out;
}

}  // namespace

void CheckCompareTs(harness::Ctx& ctx) {
  ctx.Equal(update_latest("v-1", statePos(1000, 1)), true, "the first position for a vehicle must be applied");
  ctx.Equal(stateRecord(ctx), {1000.0, 1.0, 47.6, -122.3}, "after the first position vehicle:v-1:latest (ts, seq, lat, lon)");
  ctx.Equal(update_latest("v-1", statePos(900, 2, 1.0)), false,
            "an older timestamp (900 after 1000) must be ignored even with a higher sequence: the device's clock orders "
            "positions, its counter only breaks ties; applied");
  const auto rec = stateRecord(ctx);
  ctx.Assert(rec.size() == 4 && rec[0] == 1000 && rec[2] == 47.6,
             "the older position overwrote the record (%v): the map shows where the vehicle was", rec);
  ctx.Equal(update_latest("v-1", statePos(2000, 0, 2.0)), true,
            "a newer timestamp with a lower sequence (the device rebooted and its counter restarted) must be applied");
  ctx.Equal(update_latest("v-1", statePos(2000, 9, 3.0)), true, "equal timestamps: the higher sequence (9 after 0) must be applied");
  ctx.Equal(update_latest("v-1", statePos(2000, 10, 4.0)), true,
            "equal timestamps: sequence 10 is higher than 9; comparing them as strings ('10' < '9') ignores it; applied");
  ctx.Equal(update_latest("v-1", statePos(2000, 9, 5.0)), false, "equal timestamps: a lower sequence (9 after 10) must be ignored; applied");
  ctx.Equal(stateRecord(ctx), {2000.0, 10.0, 4.0, -122.3}, "vehicle:v-1:latest must hold the winner (ts, seq, lat, lon)");
}

void CheckEval(harness::Ctx& ctx) {
  ctx.Equal(update_latest("v-1", statePos(1000, 1)), true, "the first position for a vehicle must be applied");
  // Another fleetd replica lands right after the first command that touches the record, between a
  // client-side read and its write, with a fresher position.
  bool fired = false;
  ctx.Redis.After(kStateV1, [&] {
    fired = true;
    ctx.Redis.Do("HSET", kStateV1, "ts", 3000, "seq", 5, "lat", 9.0, "lon", 9.0);
  });
  update_latest("v-1", statePos(2000, 2, 2.0));
  ctx.Assert(fired, "update_latest sent no command touching vehicle:v-1:latest");
  const auto rec = stateRecord(ctx);
  ctx.Assert(rec.size() == 4 && rec[0] == 3000,
             "vehicle:v-1:latest holds %v after another replica wrote ts 3000 between your read and your write: the "
             "fresher position was lost. Read, compare and write inside one Lua script (EVAL/EVALSHA), which Redis runs "
             "without interleaving",
             rec);
  ctx.Equal(update_latest("v-1", statePos(2500, 3)), false, "with ts 3000 stored, a position at 2500 must be ignored; applied");
}

void CheckReplay(harness::Ctx& ctx) {
  ctx.Equal(update_latest("v-1", statePos(1000, 7)), true, "the first position for a vehicle must be applied");
  const auto before = ctx.Redis.HGetAll(kStateV1);
  const bool applied = update_latest("v-1", statePos(1000, 7));
  ctx.Assert(!applied,
             "the same position again (a device replaying its buffer after a reconnect) was reported as applied: the "
             "endpoint counts it as accepted instead of duplicate. Equal timestamp and equal sequence is not newer");
  ctx.Equal(ctx.Redis.HGetAll(kStateV1), before, "a replay must not change the record");
  ctx.Equal(update_latest("v-1", statePos(1000, 8)), true, "the next sequence at the same timestamp is new and must be applied");
}

void CheckOneRoundTrip(harness::Ctx& ctx) {
  update_latest("v-1", statePos(1000, 1));  // the first call may load the script
  const size_t before = ctx.Redis.RoundTrips().size();
  update_latest("v-1", statePos(2000, 2));
  update_latest("v-1", statePos(1500, 3));
  const size_t trips = ctx.Redis.RoundTrips().size() - before;
  ctx.Assert(trips <= 2,
             "two updates cost %d Redis round trips, expected one each (EVALSHA): 5 000 vehicles reporting every second "
             "must not pay a read and a write per position",
             static_cast<int>(trips));
  ctx.Equal(stateRecord(ctx)[0], 2000, "vehicle:v-1:latest ts");
}
`,
  },
  debrief: `The record is a hash because the script needs two numbers out of it and Lua has no JSON; the script exists because the decision and the write must be one event on the server, where no replica can land in between. Comparing timestamp first and sequence second is what makes a rebooted device (counter back at zero, clock still right) keep reporting, and the strict \`<=\` on the sequence is what turns a replay into a 0 the endpoint can count. Production trackers add a per-device clock offset learned from the server's arrival time, keep a short history per vehicle beside the latest record, and expire records for vehicles that stop reporting so the snapshot does not carry a fleet of ghosts.`,
};
