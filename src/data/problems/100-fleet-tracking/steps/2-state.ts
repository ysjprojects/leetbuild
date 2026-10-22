import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis latest-position with compare-by-timestamp updates',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'state', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it receives a position for a
vehicle and writes it to the vehicle's latest-position key. It compiles, it serves the demo, and it
hides the flaw that makes a dispatch map wrong. Review it like the service owner, fix it, and prove
the fix with the checks below.

Implement the latest-position write as **one atomic Redis operation** per vehicle.

- The key is \`vehicle:{vehicle_id}:latest\`; the value is the position record serialised as JSON.
- The update compares the incoming \`device_timestamp_ms\` against the stored one and writes **only
  if the incoming timestamp is strictly newer**.
- When the timestamps are **equal**, the comparison falls back to the \`sequence\`: the higher
  sequence wins, deterministically, so two servers replaying the same position converge on one
  record.
- The whole read-compare-write sequence happens server-side in one Lua \`EVAL\` (or \`EVALSHA\`), so
  two concurrent updates cannot interleave between the read and the write.
- The stored record always matches the winner of the comparison: it holds the winning timestamp,
  sequence and coordinates, never a merged or partially updated value.

**Failure mode the checks target.** The draft writes whatever arrives last, so a delayed
cell-network position overwrites a fresh one and the map shows a ghost car. The checks verify the
atomic Lua script, the timestamp comparison, the sequence tie-break, and that the stored record is
the winner.`,
  sequence: {
    participants: ['Position API', 'Redis', 'Vehicle record'],
    messages: [
      {from: 'Position API', to: 'Redis', label: 'EVAL latest.lua KEYS[vehicle:{id}:latest]', kind: 'sync'},
      {from: 'Redis', to: 'Vehicle record', label: 'GET stored record', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'tonumber(ARGV[1]) > tonumber(stored.ts)', kind: 'sync'},
      {from: 'Redis', to: 'Vehicle record', label: 'SET when newer (or tie by sequence)', kind: 'sync'},
      {from: 'Redis', to: 'Position API', label: '1 applied / 0 ignored', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'eval',
      title: 'Writes through one atomic Lua EVAL',
      detail:
        'The compare-and-set runs server-side in a single Lua script invoked with `EVAL`/`EVALSHA` (or the client equivalent). The draft calls plain `SET`, so two writers can interleave.',
      match: {
        python: {all: [/\beval\w*\(/]},
        typescript: {all: [/\.eval\w*\(/]},
        go: {all: [/\bEval\w*\(/]},
        scala: {all: [/\beval\w*\(/]},
        cpp: {all: [/\beval\b/]},
      },
    },
    {
      id: 'keys-argv',
      title: 'Passes the key and arguments to the script',
      detail:
        'The script receives the vehicle key in `KEYS[1]` and the timestamp, sequence and payload in `ARGV`, so the comparison has everything it needs without a second round trip.',
      match: {
        python: {all: [/KEYS\[1\]/, /ARGV\[1\]/]},
        typescript: {all: [/KEYS\[1\]/, /ARGV\[1\]/]},
        go: {all: [/KEYS\[1\]/, /ARGV\[1\]/]},
        scala: {all: [/KEYS\[1\]/, /ARGV\[1\]/]},
        cpp: {all: [/KEYS\[1\]/, /ARGV\[1\]/]},
      },
    },
    {
      id: 'compare-ts',
      title: 'Compares the incoming timestamp with the stored one',
      detail:
        'The script decodes the stored record and writes only when `incoming_ts` is newer. The draft has no comparison at all, so order of arrival decides the winner.',
      match: {
        python: {all: [/tonumber/, /incoming_ts/, />/]},
        typescript: {all: [/tonumber/, /incoming_ts/, />/]},
        go: {all: [/tonumber/, /incoming_ts/, />/]},
        scala: {all: [/tonumber/, /incoming_ts/, />/]},
        cpp: {all: [/tonumber/, /incoming_ts/, />/]},
      },
    },
    {
      id: 'tie-sequence',
      title: 'Resolves equal timestamps by sequence',
      detail:
        'Equal timestamps are broken deterministically by the higher `sequence`. The draft cannot distinguish two positions carrying the same timestamp.',
      match: {
        python: {all: [/incoming_seq/, /sequence/, /==/]},
        typescript: {all: [/incoming_seq/, /sequence/, /==/]},
        go: {all: [/incoming_seq/, /sequence/, /==/]},
        scala: {all: [/incoming_seq/, /sequence/, /==/]},
        cpp: {all: [/incoming_seq/, /sequence/, /==/]},
      },
    },
    {
      id: 'winner-record',
      title: 'Stores the winner of the comparison, not a partial merge',
      detail:
        'The script reads the stored record, and only the winning branch writes the payload, so the record always matches the comparison winner. The draft overwrites on every call.',
      match: {
        python: {all: [/GET/, /SET/], order: [/GET/, /SET/]},
        typescript: {all: [/GET/, /SET/], order: [/GET/, /SET/]},
        go: {all: [/GET/, /SET/], order: [/GET/, /SET/]},
        scala: {all: [/GET/, /SET/], order: [/GET/, /SET/]},
        cpp: {all: [/GET/, /SET/], order: [/GET/, /SET/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json


def update_latest(redis, vehicle_id: str, position: dict) -> None:
    # TODO: this draft writes whatever arrives last, so a delayed position overwrites a fresh one.
    # Review the atomic compare-by-timestamp and the sequence tie-break.
    key = f"vehicle:{vehicle_id}:latest"
    redis.set(key, json.dumps(position))
`,
      solution: `import json

LATEST_SCRIPT = """
local key = KEYS[1]
local incoming_ts = tonumber(ARGV[1])
local incoming_seq = tonumber(ARGV[2])
local payload = ARGV[3]
local stored = redis.call('GET', key)
if stored then
  local current = cjson.decode(stored)
  local current_ts = tonumber(current['device_timestamp_ms'])
  local current_seq = tonumber(current['sequence'])
  if incoming_ts > current_ts or (incoming_ts == current_ts and incoming_seq > current_seq) then
    redis.call('SET', key, payload)
    return 1
  end
  return 0
end
redis.call('SET', key, payload)
return 1
"""


def update_latest(redis, vehicle_id: str, position: dict) -> int:
    key = f"vehicle:{vehicle_id}:latest"
    payload = json.dumps(position)
    return redis.eval(
        LATEST_SCRIPT,
        1,
        key,
        position["device_timestamp_ms"],
        position["sequence"],
        payload,
    )
`,
    },
    typescript: {
      starter: `/** Latest-position writer: a model-generated draft that writes the last arrival. */
import type {Redis} from 'ioredis';

export interface Position {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  lat: number;
  lon: number;
}

export async function updateLatest(redis: Redis, vehicleId: string, position: Position): Promise<void> {
  // TODO: this draft writes whatever arrives last, so a delayed position overwrites a fresh one.
  // Review the atomic compare-by-timestamp and the sequence tie-break.
  await redis.set(\`vehicle:\${vehicleId}:latest\`, JSON.stringify(position));
}
`,
      solution: `/** Latest-position writer: atomic compare-by-timestamp with a sequence tie-break. */
import type {Redis} from 'ioredis';

export interface Position {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  lat: number;
  lon: number;
}

const LATEST_SCRIPT = \`
local key = KEYS[1]
local incoming_ts = tonumber(ARGV[1])
local incoming_seq = tonumber(ARGV[2])
local payload = ARGV[3]
local stored = redis.call('GET', key)
if stored then
  local current = cjson.decode(stored)
  local current_ts = tonumber(current['device_timestamp_ms'])
  local current_seq = tonumber(current['sequence'])
  if incoming_ts > current_ts or (incoming_ts == current_ts and incoming_seq > current_seq) then
    redis.call('SET', key, payload)
    return 1
  end
  return 0
end
redis.call('SET', key, payload)
return 1
\`;

export async function updateLatest(redis: Redis, vehicleId: string, position: Position): Promise<number> {
  const key = \`vehicle:\${vehicleId}:latest\`;
  return (await redis.eval(
    LATEST_SCRIPT,
    1,
    key,
    position.device_timestamp_ms,
    position.sequence,
    JSON.stringify(position),
  )) as number;
}
`,
    },
    go: {
      starter: `package state

import (
	"context"
	"encoding/json"

	goredis "github.com/redis/go-redis/v9"
)

type Position struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int     \`json:"sequence"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
}

func UpdateLatest(ctx context.Context, rdb *goredis.Client, vehicleID string, pos Position) error {
	// TODO: this draft writes whatever arrives last, so a delayed position overwrites a fresh one.
	// Review the atomic compare-by-timestamp and the sequence tie-break.
	payload, err := json.Marshal(pos)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "vehicle:"+vehicleID+":latest", payload, 0).Err()
}
`,
      solution: `package state

import (
	"context"
	"encoding/json"

	goredis "github.com/redis/go-redis/v9"
)

type Position struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int     \`json:"sequence"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
}

const latestScript = \`
local key = KEYS[1]
local incoming_ts = tonumber(ARGV[1])
local incoming_seq = tonumber(ARGV[2])
local payload = ARGV[3]
local stored = redis.call('GET', key)
if stored then
  local current = cjson.decode(stored)
  local current_ts = tonumber(current['device_timestamp_ms'])
  local current_seq = tonumber(current['sequence'])
  if incoming_ts > current_ts or (incoming_ts == current_ts and incoming_seq > current_seq) then
    redis.call('SET', key, payload)
    return 1
  end
  return 0
end
redis.call('SET', key, payload)
return 1
\`

func UpdateLatest(ctx context.Context, rdb *goredis.Client, vehicleID string, pos Position) (int64, error) {
	payload, err := json.Marshal(pos)
	if err != nil {
		return 0, err
	}
	return rdb.Eval(
		ctx,
		latestScript,
		[]string{"vehicle:" + vehicleID + ":latest"},
		pos.DeviceTimestampMs,
		pos.Sequence,
		string(payload),
	).Int64()
}
`,
    },
    scala: {
      starter: `import play.api.libs.json.{JsObject, Json}

object LatestPosition {
  def updateLatest(redis: RedisClient, vehicleId: String, position: JsObject): Unit = {
    // TODO: this draft writes whatever arrives last, so a delayed position overwrites a fresh one.
    // Review the atomic compare-by-timestamp and the sequence tie-break.
    redis.set(s"vehicle:$vehicleId:latest", Json.stringify(position))
  }
}
`,
      solution: `import play.api.libs.json.{JsObject, Json}

object LatestPosition {
  private val LatestScript: String =
    """
local key = KEYS[1]
local incoming_ts = tonumber(ARGV[1])
local incoming_seq = tonumber(ARGV[2])
local payload = ARGV[3]
local stored = redis.call('GET', key)
if stored then
  local current = cjson.decode(stored)
  local current_ts = tonumber(current['device_timestamp_ms'])
  local current_seq = tonumber(current['sequence'])
  if incoming_ts > current_ts or (incoming_ts == current_ts and incoming_seq > current_seq) then
    redis.call('SET', key, payload)
    return 1
  end
  return 0
end
redis.call('SET', key, payload)
return 1
"""

  def updateLatest(redis: RedisClient, vehicleId: String, position: JsObject): Long = {
    val key = s"vehicle:$vehicleId:latest"
    val payload = Json.stringify(position)
    val incomingTs = (position \\ "device_timestamp_ms").as[Long]
    val incomingSeq = (position \\ "sequence").as[Int]
    redis.eval(LatestScript, Seq(key), Seq(incomingTs.toString, incomingSeq.toString, payload)) match {
      case Right(result) => result
      case Left(error) => throw error
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

void updateLatest(sw::redis::Redis& redis, const std::string& vehicleId, const json& position) {
  // TODO: this draft writes whatever arrives last, so a delayed position overwrites a fresh one.
  // Review the atomic compare-by-timestamp and the sequence tie-break.
  const auto key = "vehicle:" + vehicleId + ":latest";
  redis.set(key, position.dump());
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

constexpr const char* kLatestScript = R"(
local key = KEYS[1]
local incoming_ts = tonumber(ARGV[1])
local incoming_seq = tonumber(ARGV[2])
local payload = ARGV[3]
local stored = redis.call('GET', key)
if stored then
  local current = cjson.decode(stored)
  local current_ts = tonumber(current['device_timestamp_ms'])
  local current_seq = tonumber(current['sequence'])
  if incoming_ts > current_ts or (incoming_ts == current_ts and incoming_seq > current_seq) then
    redis.call('SET', key, payload)
    return 1
  end
  return 0
end
redis.call('SET', key, payload)
return 1
)";

long long updateLatest(sw::redis::Redis& redis, const std::string& vehicleId, const json& position) {
  const auto key = "vehicle:" + vehicleId + ":latest";
  const auto incomingTs = position["device_timestamp_ms"].get<long long>();
  const auto incomingSeq = position["sequence"].get<int>();
  const auto payload = position.dump();
  return redis.eval<long long>(
      kLatestScript,
      {key},
      {std::to_string(incomingTs), std::to_string(incomingSeq), payload});
}
`,
    },
  },
  hints: [
    'Everything that reads and writes must live inside the Lua string: `KEYS[1]` is the vehicle key, `ARGV[1]` the timestamp, `ARGV[2]` the sequence and `ARGV[3]` the JSON payload. A client-side read followed by a write is the race the check calls out.',
    'The condition is `incoming_ts > current_ts or (incoming_ts == current_ts and incoming_seq > current_seq)`. The timestamp branch handles a newer position; the sequence branch makes equal-timestamp replays deterministic.',
    'Both the "no stored record" and the "newer" paths write the same payload. Never merge fields: the record must equal the winner of the comparison.',
  ],
  debrief: `The interviewer is testing whether you can keep distributed state correct when messages arrive out of order. The draft reads fine because the demo delivers positions in order and never replays. Three defects are being checked: the atomic script (no read-modify-write race between two ingest workers), the timestamp comparison (a delayed packet cannot roll state backward), and the sequence tie-break (two positions sharing a timestamp still converge to one winner). Real systems add per-vehicle TTLs for silent devices, a separate history append, and a coarse geohash index for nearby queries.`,
};
