import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis status timeline: forward only, applied atomically',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'carrier'],
  task: `## Task

**Starting point.** The starter is the status apply every scan goes through:
\`apply_scan(shipment_id, status, scan_at, city)\` reads \`status\` and \`status_at\` from the
\`shipment:{id}\` hash, keeps the scan only when it is newer than the last one, \`HSET\`s the new
status, appends \`"at|status|city"\` to \`shipment:{id}:scans\` and answers
\`{"applied", "status", "attempted": "from->to"}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** The van returns to the depot and its later \`in_transit\` scan
rolls an out-for-delivery parcel backward; a \`returned\` scan reopens a delivered one; two carriers
scanning at once both read the old status and the slower write wins; a dropped scan leaves no trace
for operations.

- Order by rank, not by time: \`STATUS_RANK\` (\`label\` < \`in_transit\` < \`out_for_delivery\` <
  \`delivered\` < \`returned\`); a scan whose rank is not above the current one is dropped.
- \`delivered\`, \`returned\` and \`cancelled\` are terminal: the script's \`terminals\` table drops
  any scan on them.
- Read, compare and write in **one Lua script** (\`KEYS\`: the hash, \`:scans\`, \`:rejects\`).
- A dropped scan appends its edge (\`out_for_delivery->in_transit\`) to \`shipment:{id}:rejects\`.`,
  sequence: {
    participants: ['Carrier scan', 'Shipment API', 'Redis'],
    messages: [
      {from: 'Carrier scan', to: 'Shipment API', label: 'in_transit · t=260 · after out_for_delivery', kind: 'sync'},
      {from: 'Shipment API', to: 'Redis', label: 'EVAL apply · KEYS shipment:shp_1, :scans, :rejects', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'HGET status · terminals · ranks[new] <= ranks[current]', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'RPUSH :rejects out_for_delivery->in_transit', kind: 'sync'},
      {from: 'Redis', to: 'Shipment API', label: "{'0', out_for_delivery}", kind: 'reply'},
      {from: 'Carrier scan', to: 'Shipment API', label: 'delivered · t=300', kind: 'sync'},
      {from: 'Shipment API', to: 'Redis', label: 'EVAL apply → HSET status · RPUSH :scans', kind: 'sync'},
      {from: 'Redis', to: 'Shipment API', label: "{'1', delivered}", kind: 'reply'},
    ],
  },
  hints: [
    'A parcel out for delivery shows in transit again after the van returns to the depot, a delivered one reopens as returned, and operations find no record of either scan arriving.',
    'The starter orders scans by `scan_at`, which says when the carrier scanned, not how far the parcel got. It reads the hash, decides in the process and writes back, so another scan can land in between.',
    'One Lua script: `HGET` the status; when `terminals[current]` or `ranks[ARGV[1]] <= ranks[current]`, `RPUSH` the edge to `KEYS[3]` and stop; else `HSET` the status and `RPUSH` the scan to `KEYS[2]`.',
  ],
  checks: [
    {
      id: 'monotonic',
      title: 'Orders scans by rank, not by scan time',
      detail:
        'A scan applies only when its rank is above the current status (`ranks[new] <= ranks[current]` is dropped); comparing `scan_at` lets a later depot scan roll a parcel backward.',
      match: {
        python: {all: [/STATUS_RANK/, /ranks\[[^\]\n]*\]?\]\s*(<=|>=|<|>)\s*ranks\[/], none: [/scan_at\s*<=/]},
        typescript: {all: [/STATUS_RANK/, /ranks\[[^\]\n]*\]?\]\s*(<=|>=|<|>)\s*ranks\[/], none: [/scanAt\s*<=/]},
        go: {all: [/statusRank/, /ranks\[[^\]\n]*\]?\]\s*(<=|>=|<|>)\s*ranks\[/], none: [/scanAt\s*<=/]},
        scala: {all: [/StatusRank/, /ranks\[[^\]\n]*\]?\]\s*(<=|>=|<|>)\s*ranks\[/], none: [/scanAt\s*<=/]},
        cpp: {all: [/kStatusRank/, /ranks\[[^\]\n]*\]?\]\s*(<=|>=|<|>)\s*ranks\[/], none: [/scan_at\s*<=/]},
      },
    },
    {
      id: 'terminal-immutable',
      title: 'Keeps delivered, returned and cancelled closed',
      detail:
        'The script drops any scan on a terminal status (`terminals[current]`) before the rank comparison: rank alone lets `returned` follow `delivered`.',
      match: {
        python: {all: [/terminals\[\s*current\s*\]/]},
        typescript: {all: [/terminals\[\s*current\s*\]/]},
        go: {all: [/terminals\[\s*current\s*\]/]},
        scala: {all: [/terminals\[\s*current\s*\]/]},
        cpp: {all: [/terminals\[\s*current\s*\]/]},
      },
    },
    {
      id: 'atomic',
      title: 'Reads, compares and writes in one Lua script',
      detail:
        'The status is read (`HGET`) and written inside one script run with `EVAL` (`register_script`, `defineCommand`, `NewScript`); a client-side read followed by `HSET` lets two concurrent scans both see the old status.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/r\.hmget\(|r\.hget\(|r\.hset\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/redis\.hmget\(|redis\.hget\(|redis\.hset\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/rdb\.HMGet\(|rdb\.HGet\(|rdb\.HSet\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HGET['"]/],
          none: [/jedis\.hmget\(|jedis\.hget\(|jedis\.hset\(/],
        },
        cpp: {all: [/\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HGET['"]/], none: [/\.hmget\(|\.hget\(|\.hset\(/]},
      },
    },
    {
      id: 'rejected-recorded',
      title: 'Records the edge of a dropped scan',
      detail:
        'A dropped scan appends its `from->to` edge to `shipment:{id}:rejects` inside the script, so operations see the out-of-order feed instead of a silent drop.',
      match: {
        python: {all: [/rejects/, /['"][LR]PUSH['"]/]},
        typescript: {all: [/rejects/, /['"][LR]PUSH['"]/]},
        go: {all: [/rejects/, /['"][LR]PUSH['"]/]},
        scala: {all: [/rejects/, /['"][LR]PUSH['"]/]},
        cpp: {all: [/rejects/, /['"][LR]PUSH['"]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

STATUS_RANK = {"label": 0, "in_transit": 1, "out_for_delivery": 2, "delivered": 3, "returned": 4}


def apply_scan(shipment_id: str, status: str, scan_at: int, city: str) -> dict:
    """Apply one carrier scan to the shipment's status; answers {"applied", "status", "attempted"}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if status not in STATUS_RANK:
        raise ValueError(f"unknown status {status!r}")
    key = f"shipment:{shipment_id}"
    current, current_at = r.hmget(key, "status", "status_at")
    if current is None:
        raise LookupError(f"no shipment {shipment_id}")
    attempted = f"{current}->{status}"
    if scan_at <= int(current_at or 0):
        return {"applied": False, "status": current, "attempted": attempted}
    r.hset(key, mapping={"status": status, "status_at": scan_at})
    r.rpush(f"{key}:scans", f"{scan_at}|{status}|{city}")
    return {"applied": True, "status": status, "attempted": attempted}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

STATUS_RANK = {"label": 0, "in_transit": 1, "out_for_delivery": 2, "delivered": 3, "returned": 4}
TERMINAL = ("delivered", "returned", "cancelled")

# The read, the comparison and the write run as one script: no other scan can land in between.
APPLY_LUA = """
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return redis.error_reply('no such shipment') end
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true, cancelled = true}
if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
  return {'0', current, current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
return {'1', ARGV[1], current}
"""
apply = r.register_script(APPLY_LUA)


def apply_scan(shipment_id: str, status: str, scan_at: int, city: str) -> dict:
    """Apply one carrier scan to the shipment's status; answers {"applied", "status", "attempted"}."""
    if status not in STATUS_RANK:
        raise ValueError(f"unknown status {status!r}")
    key = f"shipment:{shipment_id}"
    applied, now, before = apply(keys=[key, f"{key}:scans", f"{key}:rejects"], args=[status, scan_at, city])
    return {"applied": applied == "1", "status": now, "attempted": f"{before}->{status}"}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const STATUS_RANK: Record<string, number> = {label: 0, in_transit: 1, out_for_delivery: 2, delivered: 3, returned: 4};

export interface ScanResult {
  applied: boolean;
  status: string;
  attempted: string;
}

/** Apply one carrier scan to the shipment's status. */
export async function applyScan(shipmentId: string, status: string, scanAt: number, city: string): Promise<ScanResult> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (!Object.prototype.hasOwnProperty.call(STATUS_RANK, status)) throw new Error(\`unknown status \${status}\`);
  const key = \`shipment:\${shipmentId}\`;
  const [current, currentAt] = await redis.hmget(key, 'status', 'status_at');
  if (current === null) throw new Error(\`no shipment \${shipmentId}\`);
  const attempted = \`\${current}->\${status}\`;
  if (scanAt <= Number(currentAt ?? 0)) return {applied: false, status: current, attempted};
  await redis.hset(key, {status, status_at: String(scanAt)});
  await redis.rpush(\`\${key}:scans\`, \`\${scanAt}|\${status}|\${city}\`);
  return {applied: true, status, attempted};
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const STATUS_RANK: Record<string, number> = {label: 0, in_transit: 1, out_for_delivery: 2, delivered: 3, returned: 4};
export const TERMINAL = ['delivered', 'returned', 'cancelled'];

// The read, the comparison and the write run as one script: no other scan can land in between.
export const APPLY_LUA = \`
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return redis.error_reply('no such shipment') end
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true, cancelled = true}
if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
  return {'0', current, current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
return {'1', ARGV[1], current}
\`;

export interface ScanResult {
  applied: boolean;
  status: string;
  attempted: string;
}

/** Apply one carrier scan to the shipment's status. */
export async function applyScan(shipmentId: string, status: string, scanAt: number, city: string): Promise<ScanResult> {
  if (!Object.prototype.hasOwnProperty.call(STATUS_RANK, status)) throw new Error(\`unknown status \${status}\`);
  const key = \`shipment:\${shipmentId}\`;
  const [applied, now, before] = (await redis.eval(APPLY_LUA, 3, key, \`\${key}:scans\`, \`\${key}:rejects\`, status, String(scanAt), city)) as string[];
  return {applied: applied === '1', status: now, attempted: \`\${before}->\${status}\`};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var statusRank = map[string]int{"label": 0, "in_transit": 1, "out_for_delivery": 2, "delivered": 3, "returned": 4}

// Result is what one scan did to the shipment.
type Result struct {
	Applied   bool   \`json:"applied"\`
	Status    string \`json:"status"\`
	Attempted string \`json:"attempted"\`
}

// applyScan applies one carrier scan to the shipment's status.
func applyScan(ctx context.Context, shipmentID, status string, scanAt int64, city string) (Result, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if _, known := statusRank[status]; !known {
		return Result{}, fmt.Errorf("unknown status %q", status)
	}
	key := "shipment:" + shipmentID
	current, err := rdb.HMGet(ctx, key, "status", "status_at").Result()
	if err != nil {
		return Result{}, err
	}
	was, ok := current[0].(string)
	if !ok {
		return Result{}, fmt.Errorf("no shipment %s", shipmentID)
	}
	wasAt, _ := strconv.ParseInt(fmt.Sprint(current[1]), 10, 64)
	attempted := was + "->" + status
	if scanAt <= wasAt {
		return Result{Applied: false, Status: was, Attempted: attempted}, nil
	}
	rdb.HSet(ctx, key, "status", status, "status_at", strconv.FormatInt(scanAt, 10))
	rdb.RPush(ctx, key+":scans", fmt.Sprintf("%d|%s|%s", scanAt, status, city))
	return Result{Applied: true, Status: status, Attempted: attempted}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var statusRank = map[string]int{"label": 0, "in_transit": 1, "out_for_delivery": 2, "delivered": 3, "returned": 4}

// applyScript reads, compares and writes as one script: no other scan can land in between.
var applyScript = redis.NewScript(\`
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return redis.error_reply('no such shipment') end
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true, cancelled = true}
if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
  return {'0', current, current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
return {'1', ARGV[1], current}
\`)

// Result is what one scan did to the shipment.
type Result struct {
	Applied   bool   \`json:"applied"\`
	Status    string \`json:"status"\`
	Attempted string \`json:"attempted"\`
}

// applyScan applies one carrier scan to the shipment's status.
func applyScan(ctx context.Context, shipmentID, status string, scanAt int64, city string) (Result, error) {
	if _, known := statusRank[status]; !known {
		return Result{}, fmt.Errorf("unknown status %q", status)
	}
	key := "shipment:" + shipmentID
	reply, err := applyScript.Run(ctx, rdb, []string{key, key + ":scans", key + ":rejects"}, status, strconv.FormatInt(scanAt, 10), city).StringSlice()
	if err != nil {
		return Result{}, err
	}
	return Result{Applied: reply[0] == "1", Status: reply[1], Attempted: reply[2] + "->" + status}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  final case class Result(applied: Boolean, status: String, attempted: String)

  val StatusRank: Map[String, Int] = Map("label" -> 0, "in_transit" -> 1, "out_for_delivery" -> 2, "delivered" -> 3, "returned" -> 4)

  val jedis = new JedisPooled("redis", 6379)

  /** Apply one carrier scan to the shipment's status. */
  def applyScan(shipmentId: String, status: String, scanAt: Long, city: String): Result = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    require(StatusRank.contains(status), s"unknown status $status")
    val key = s"shipment:$shipmentId"
    val current = jedis.hmget(key, "status", "status_at").asScala.toVector
    val was = Option(current(0)).getOrElse(throw new NoSuchElementException(s"no shipment $shipmentId"))
    val attempted = s"$was->$status"
    if (scanAt <= Option(current(1)).flatMap(_.toLongOption).getOrElse(0L)) Result(applied = false, was, attempted)
    else {
      jedis.hset(key, Map("status" -> status, "status_at" -> scanAt.toString).asJava)
      jedis.rpush(s"$key:scans", s"$scanAt|$status|$city")
      Result(applied = true, status, attempted)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  final case class Result(applied: Boolean, status: String, attempted: String)

  val StatusRank: Map[String, Int] = Map("label" -> 0, "in_transit" -> 1, "out_for_delivery" -> 2, "delivered" -> 3, "returned" -> 4)
  val Terminal: Set[String] = Set("delivered", "returned", "cancelled")

  /** The read, the comparison and the write run as one script: no other scan can land in between. */
  val ApplyLua: String =
    """local current = redis.call('HGET', KEYS[1], 'status')
      |if not current then return redis.error_reply('no such shipment') end
      |local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
      |local terminals = {delivered = true, returned = true, cancelled = true}
      |if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
      |  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
      |  return {'0', current, current}
      |end
      |redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
      |redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
      |return {'1', ARGV[1], current}
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  /** Apply one carrier scan to the shipment's status. */
  def applyScan(shipmentId: String, status: String, scanAt: Long, city: String): Result = {
    require(StatusRank.contains(status), s"unknown status $status")
    val key = s"shipment:$shipmentId"
    val reply = jedis.eval(ApplyLua, List(key, s"$key:scans", s"$key:rejects").asJava, List(status, scanAt.toString, city).asJava)
      .asInstanceOf[java.util.List[String]].asScala.toVector
    Result(reply(0) == "1", reply(1), s"\${reply(2)}->$status")
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <map>
#include <stdexcept>
#include <string>

const std::map<std::string, int> kStatusRank = {{"label", 0}, {"in_transit", 1}, {"out_for_delivery", 2}, {"delivered", 3}, {"returned", 4}};

struct ScanResult {
  bool applied = false;
  std::string status;
  std::string attempted;
};

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Apply one carrier scan to the shipment's status.
ScanResult applyScan(const std::string& shipment_id, const std::string& status, long scan_at, const std::string& city) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (kStatusRank.count(status) == 0) throw std::invalid_argument("unknown status " + status);
  const std::string key = "shipment:" + shipment_id;
  const auto current = redis().hmget(key, {"status", "status_at"});
  if (!current.at(0)) throw std::out_of_range("no shipment " + shipment_id);
  const std::string attempted = *current[0] + "->" + status;
  const long was_at = current.at(1) ? std::stol(*current[1]) : 0;
  if (scan_at <= was_at) return ScanResult{false, *current[0], attempted};
  redis().hset(key, {{"status", status}, {"status_at", std::to_string(scan_at)}});
  redis().rpush(key + ":scans", std::to_string(scan_at) + "|" + status + "|" + city);
  return ScanResult{true, status, attempted};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

const std::map<std::string, int> kStatusRank = {{"label", 0}, {"in_transit", 1}, {"out_for_delivery", 2}, {"delivered", 3}, {"returned", 4}};

// The read, the comparison and the write run as one script: no other scan can land in between.
const std::string kApplyLua = R"lua(
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return redis.error_reply('no such shipment') end
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true, cancelled = true}
if terminals[current] or ranks[ARGV[1]] <= ranks[current] then
  redis.call('RPUSH', KEYS[3], current .. '->' .. ARGV[1])
  return {'0', current, current}
end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'status_at', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2] .. '|' .. ARGV[1] .. '|' .. ARGV[3])
return {'1', ARGV[1], current}
)lua";

struct ScanResult {
  bool applied = false;
  std::string status;
  std::string attempted;
};

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Apply one carrier scan to the shipment's status.
ScanResult applyScan(const std::string& shipment_id, const std::string& status, long scan_at, const std::string& city) {
  if (kStatusRank.count(status) == 0) throw std::invalid_argument("unknown status " + status);
  const std::string key = "shipment:" + shipment_id;
  std::vector<std::string> reply;
  redis().eval(kApplyLua, {key, key + ":scans", key + ":rejects"}, {status, std::to_string(scan_at), city}, std::back_inserter(reply));
  return ScanResult{reply.at(0) == "1", reply.at(1), reply.at(2) + "->" + status};
}
`,
    },
  },
  harness: {
    python: `from shipments import store

SHIP = "shp_1"


def _ship(ctx, shipment_id=SHIP, status="label"):
    store.save({"shipment_id": shipment_id, "tenant_id": "t-acme", "order_id": "ord_1", "carrier": "ups", "service_level": "ground", "status": status, "replacement_of": "", "created_at": 0})


def _status(ctx, shipment_id=SHIP):
    return ctx.redis.hget(f"shipment:{shipment_id}", "status")


def _apply(m, status, at, city="Leeds", shipment_id=SHIP):
    return m.apply_scan(shipment_id, status, at, city)


def check_monotonic(ctx):
    m = ctx.load("state")
    _ship(ctx)
    assert _apply(m, "in_transit", 100, "Memphis")["applied"] is True, "the first in_transit scan must apply to a fresh label"
    assert _apply(m, "out_for_delivery", 200)["applied"] is True, "out_for_delivery after in_transit must apply"
    # The van returns to the depot: a later scan, a lower rank.
    result = _apply(m, "in_transit", 260)
    assert _status(ctx) == "out_for_delivery", f"an in_transit depot scan at t=260 after out_for_delivery at t=200 moved the shipment to {_status(ctx)}: only a scan that ranks above the current status applies, whatever its time"
    assert result.get("applied") is False and result.get("status") == "out_for_delivery", f"the dropped scan must answer applied False with status out_for_delivery, got {result}"
    # A carrier device whose clock lags: a forward scan stamped earlier still moves the parcel on.
    result = _apply(m, "delivered", 190)
    assert result.get("applied") is True and _status(ctx) == "delivered", f"a delivered scan stamped t=190 after out_for_delivery at t=200 left the shipment {_status(ctx)} ({result}): rank orders the journey, not the scan clock"


def check_terminal_immutable(ctx):
    m = ctx.load("state")
    _ship(ctx)
    _apply(m, "out_for_delivery", 100)
    assert _apply(m, "delivered", 200)["applied"] is True, "delivered after out_for_delivery must apply"
    result = _apply(m, "returned", 300)
    assert _status(ctx) == "delivered", f"a returned scan after delivered moved the shipment to {_status(ctx)}: delivered is terminal"
    assert result.get("applied") is False, f"a scan on a delivered shipment must answer applied False, got {result}"
    _ship(ctx, "shp_2", "cancelled")
    result = _apply(m, "in_transit", 400, shipment_id="shp_2")
    assert _status(ctx, "shp_2") == "cancelled" and result.get("applied") is False, f"a scan on a cancelled shipment moved it to {_status(ctx, 'shp_2')} ({result}): cancelled is terminal"


def check_atomic(ctx):
    m = ctx.load("state")
    _ship(ctx)
    _apply(m, "in_transit", 100, "Memphis")
    # A second carrier's delivery scan lands between this scan's read and its write.
    rival = ctx.redis_after(f"shipment:{SHIP}", lambda: _apply(m, "delivered", 300))
    _apply(m, "out_for_delivery", 200)
    assert rival.fired, "the scan never touched shipment:shp_1"
    if rival.error is not None:
        raise rival.error
    assert _status(ctx) == "delivered", f"two scans raced and the shipment reads {_status(ctx)}: the out_for_delivery scan read in_transit before the delivery landed, then wrote over it. Read, compare and write in one Lua script"
    assert "delivered" in [s["status"] for s in store.scans(SHIP)], f"the delivery scan is missing from the timeline: {store.scans(SHIP)}"


def check_rejected_recorded(ctx):
    m = ctx.load("state")
    _ship(ctx)
    _apply(m, "in_transit", 100, "Memphis")
    _apply(m, "out_for_delivery", 200)
    result = _apply(m, "in_transit", 150, "Memphis")
    assert result.get("applied") is False and result.get("attempted") == "out_for_delivery->in_transit", f"a late in_transit scan must be dropped with attempted out_for_delivery->in_transit, got {result}"
    rejects = ctx.redis.lrange(f"shipment:{SHIP}:rejects", 0, -1)
    assert rejects == ["out_for_delivery->in_transit"], f"shipment:shp_1:rejects holds {rejects}: a dropped scan must leave its edge for operations"
    timeline = [s["status"] for s in store.scans(SHIP)]
    assert timeline == ["in_transit", "out_for_delivery"], f"the timeline holds {timeline}: a dropped scan is not part of it"
    _apply(m, "delivered", 300)
    assert ctx.redis.lrange(f"shipment:{SHIP}:rejects", 0, -1) == rejects, "an applied scan must not be recorded as dropped"
`,
    typescript: `const SHIP = 'shp_1';

function state(ctx) {
  return {m: ctx.load('state'), store: ctx.load('/support/shipments/store.ts')};
}

async function ship(store, shipmentId = SHIP, status = 'label') {
  await store.save({shipment_id: shipmentId, tenant_id: 't-acme', order_id: 'ord_1', carrier: 'ups', service_level: 'ground', status, replacement_of: '', created_at: 0});
}

const statusOf = (ctx, shipmentId = SHIP): string => ctx.redis.hget(\`shipment:\${shipmentId}\`, 'status');

export async function check_monotonic(ctx) {
  const {m, store} = state(ctx);
  await ship(store);
  assert.equal((await m.applyScan(SHIP, 'in_transit', 100, 'Memphis')).applied, true, 'the first in_transit scan must apply to a fresh label');
  assert.equal((await m.applyScan(SHIP, 'out_for_delivery', 200, 'Leeds')).applied, true, 'out_for_delivery after in_transit must apply');
  // The van returns to the depot: a later scan, a lower rank.
  let result = await m.applyScan(SHIP, 'in_transit', 260, 'Leeds');
  assert.equal(statusOf(ctx), 'out_for_delivery', \`an in_transit depot scan at t=260 after out_for_delivery at t=200 moved the shipment to \${statusOf(ctx)}: only a scan that ranks above the current status applies, whatever its time\`);
  assert(result.applied === false && result.status === 'out_for_delivery', \`the dropped scan must answer applied false with status out_for_delivery, got \${JSON.stringify(result)}\`);
  // A carrier device whose clock lags: a forward scan stamped earlier still moves the parcel on.
  result = await m.applyScan(SHIP, 'delivered', 190, 'Leeds');
  assert(result.applied === true && statusOf(ctx) === 'delivered', \`a delivered scan stamped t=190 after out_for_delivery at t=200 left the shipment \${statusOf(ctx)} (\${JSON.stringify(result)}): rank orders the journey, not the scan clock\`);
}

export async function check_terminal_immutable(ctx) {
  const {m, store} = state(ctx);
  await ship(store);
  await m.applyScan(SHIP, 'out_for_delivery', 100, 'Leeds');
  assert.equal((await m.applyScan(SHIP, 'delivered', 200, 'Leeds')).applied, true, 'delivered after out_for_delivery must apply');
  let result = await m.applyScan(SHIP, 'returned', 300, 'Leeds');
  assert.equal(statusOf(ctx), 'delivered', \`a returned scan after delivered moved the shipment to \${statusOf(ctx)}: delivered is terminal\`);
  assert.equal(result.applied, false, \`a scan on a delivered shipment must answer applied false, got \${JSON.stringify(result)}\`);
  await ship(store, 'shp_2', 'cancelled');
  result = await m.applyScan('shp_2', 'in_transit', 400, 'Leeds');
  assert(statusOf(ctx, 'shp_2') === 'cancelled' && result.applied === false, \`a scan on a cancelled shipment moved it to \${statusOf(ctx, 'shp_2')} (\${JSON.stringify(result)}): cancelled is terminal\`);
}

export async function check_atomic(ctx) {
  const {m, store} = state(ctx);
  await ship(store);
  await m.applyScan(SHIP, 'in_transit', 100, 'Memphis');
  // A second carrier's delivery scan lands between this scan's read and its write.
  const rival = ctx.redisAfter(\`shipment:\${SHIP}\`, () => m.applyScan(SHIP, 'delivered', 300, 'Leeds'));
  await m.applyScan(SHIP, 'out_for_delivery', 200, 'Leeds');
  assert(rival.fired, 'the scan never touched shipment:shp_1');
  if (rival.error !== undefined) throw rival.error;
  await rival.result;
  assert.equal(statusOf(ctx), 'delivered', \`two scans raced and the shipment reads \${statusOf(ctx)}: the out_for_delivery scan read in_transit before the delivery landed, then wrote over it. Read, compare and write in one Lua script\`);
  const timeline = (await store.scans(SHIP)).map(s => s.status);
  assert(timeline.includes('delivered'), \`the delivery scan is missing from the timeline: \${JSON.stringify(timeline)}\`);
}

export async function check_rejected_recorded(ctx) {
  const {m, store} = state(ctx);
  await ship(store);
  await m.applyScan(SHIP, 'in_transit', 100, 'Memphis');
  await m.applyScan(SHIP, 'out_for_delivery', 200, 'Leeds');
  const result = await m.applyScan(SHIP, 'in_transit', 150, 'Memphis');
  assert(result.applied === false && result.attempted === 'out_for_delivery->in_transit', \`a late in_transit scan must be dropped with attempted out_for_delivery->in_transit, got \${JSON.stringify(result)}\`);
  const rejects = ctx.redis.lrange(\`shipment:\${SHIP}:rejects\`, 0, -1);
  assert.deepStrictEqual(rejects, ['out_for_delivery->in_transit'], \`shipment:shp_1:rejects holds \${JSON.stringify(rejects)}: a dropped scan must leave its edge for operations\`);
  const timeline = (await store.scans(SHIP)).map(s => s.status);
  assert.deepStrictEqual(timeline, ['in_transit', 'out_for_delivery'], \`the timeline holds \${JSON.stringify(timeline)}: a dropped scan is not part of it\`);
  await m.applyScan(SHIP, 'delivered', 300, 'Leeds');
  assert.deepStrictEqual(ctx.redis.lrange(\`shipment:\${SHIP}:rejects\`, 0, -1), rejects, 'an applied scan must not be recorded as dropped');
}
`,
    go: `package main

import (
	"context"

	"shipments/store"

	"leetbuild/harness"
)

var stateBg = context.Background()

func ship(shipmentID, status string) {
	store.Save(stateBg, store.Shipment{ShipmentID: shipmentID, TenantID: "t-acme", OrderID: "ord_1", Carrier: "ups", ServiceLevel: "ground", Status: status})
}

func statusOf(ctx *harness.Ctx, shipmentID string) string {
	s, _ := ctx.Redis.HGet("shipment:"+shipmentID, "status")
	return s
}

func mustApply(ctx *harness.Ctx, shipmentID, status string, at int64, city string) Result {
	result, err := applyScan(stateBg, shipmentID, status, at, city)
	ctx.NoError(err, "applyScan(%s, %s, %d) failed", shipmentID, status, at)
	return result
}

func timeline(shipmentID string) []string {
	out := []string{}
	for _, s := range store.Scans(stateBg, shipmentID) {
		out = append(out, s.Status)
	}
	return out
}

func CheckMonotonic(ctx *harness.Ctx) {
	ship("shp_1", "label")
	ctx.Equal(mustApply(ctx, "shp_1", "in_transit", 100, "Memphis").Applied, true, "the first in_transit scan must apply to a fresh label; applied")
	ctx.Equal(mustApply(ctx, "shp_1", "out_for_delivery", 200, "Leeds").Applied, true, "out_for_delivery after in_transit must apply; applied")
	// The van returns to the depot: a later scan, a lower rank.
	result := mustApply(ctx, "shp_1", "in_transit", 260, "Leeds")
	ctx.Equal(statusOf(ctx, "shp_1"), "out_for_delivery", "an in_transit depot scan at t=260 after out_for_delivery at t=200 must be dropped (only a scan that ranks above the current status applies, whatever its time); the status")
	ctx.Assert(!result.Applied && result.Status == "out_for_delivery", "the dropped scan must answer applied false with status out_for_delivery, got %+v", result)
	// A carrier device whose clock lags: a forward scan stamped earlier still moves the parcel on.
	result = mustApply(ctx, "shp_1", "delivered", 190, "Leeds")
	ctx.Assert(result.Applied && statusOf(ctx, "shp_1") == "delivered", "a delivered scan stamped t=190 after out_for_delivery at t=200 left the shipment %s (%+v): rank orders the journey, not the scan clock", statusOf(ctx, "shp_1"), result)
}

func CheckTerminalImmutable(ctx *harness.Ctx) {
	ship("shp_1", "label")
	mustApply(ctx, "shp_1", "out_for_delivery", 100, "Leeds")
	ctx.Equal(mustApply(ctx, "shp_1", "delivered", 200, "Leeds").Applied, true, "delivered after out_for_delivery must apply; applied")
	result := mustApply(ctx, "shp_1", "returned", 300, "Leeds")
	ctx.Equal(statusOf(ctx, "shp_1"), "delivered", "a returned scan after delivered must be dropped (delivered is terminal); the status")
	ctx.Equal(result.Applied, false, "a scan on a delivered shipment; applied")
	ship("shp_2", "cancelled")
	result, err := applyScan(stateBg, "shp_2", "in_transit", 400, "Leeds")
	ctx.Assert(statusOf(ctx, "shp_2") == "cancelled" && !result.Applied, "a scan on a cancelled shipment moved it to %s (%+v, %v): cancelled is terminal", statusOf(ctx, "shp_2"), result, err)
}

func CheckAtomic(ctx *harness.Ctx) {
	ship("shp_1", "label")
	mustApply(ctx, "shp_1", "in_transit", 100, "Memphis")
	// A second carrier's delivery scan lands between this scan's read and its write.
	rival := ctx.Redis.After("shipment:shp_1", func() any {
		_, err := applyScan(stateBg, "shp_1", "delivered", 300, "Leeds")
		return err
	})
	mustApply(ctx, "shp_1", "out_for_delivery", 200, "Leeds")
	ctx.Assert(rival.Fired, "the scan never touched shipment:shp_1")
	ctx.Assert(rival.Result == nil, "the rival delivery scan failed: %v", rival.Result)
	ctx.Equal(statusOf(ctx, "shp_1"), "delivered", "two scans raced: the out_for_delivery scan read in_transit before the delivery landed, then wrote over it. Read, compare and write in one Lua script; the status")
	found := false
	for _, s := range timeline("shp_1") {
		found = found || s == "delivered"
	}
	ctx.Assert(found, "the delivery scan is missing from the timeline: %q", timeline("shp_1"))
}

func CheckRejectedRecorded(ctx *harness.Ctx) {
	ship("shp_1", "label")
	mustApply(ctx, "shp_1", "in_transit", 100, "Memphis")
	mustApply(ctx, "shp_1", "out_for_delivery", 200, "Leeds")
	result := mustApply(ctx, "shp_1", "in_transit", 150, "Memphis")
	ctx.Assert(!result.Applied && result.Attempted == "out_for_delivery->in_transit", "a late in_transit scan must be dropped with attempted out_for_delivery->in_transit, got %+v", result)
	rejects := ctx.Redis.LRange("shipment:shp_1:rejects", 0, -1)
	ctx.Equal(rejects, []string{"out_for_delivery->in_transit"}, "a dropped scan must leave its edge for operations; shipment:shp_1:rejects")
	ctx.Equal(timeline("shp_1"), []string{"in_transit", "out_for_delivery"}, "a dropped scan is not part of the timeline; the scans")
	mustApply(ctx, "shp_1", "delivered", 300, "Leeds")
	ctx.Equal(ctx.Redis.LRange("shipment:shp_1:rejects", 0, -1), rejects, "an applied scan must not be recorded as dropped; the rejects")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "shipments/store.h"

namespace {

void ship(const std::string& shipment_id, const std::string& status) {
  store::save(store::Shipment{shipment_id, "t-acme", "ord_1", "ups", "ground", status, "", 0});
}

std::string statusOf(harness::Ctx& ctx, const std::string& shipment_id) {
  return ctx.Redis.HGet("shipment:" + shipment_id, "status").value_or("");
}

ScanResult mustApply(harness::Ctx& ctx, const std::string& shipment_id, const std::string& status, long at, const std::string& city) {
  try {
    return applyScan(shipment_id, status, at, city);
  } catch (const std::exception& e) {
    ctx.Fatalf("applyScan(%s, %s, %d) threw %s: %s", shipment_id, status, at, harness::CurrentExceptionType(), e.what());
  }
  return {};
}

std::vector<std::string> timeline(const std::string& shipment_id) {
  std::vector<std::string> out;
  for (const auto& s : store::scans(shipment_id)) out.push_back(s.status);
  return out;
}

}  // namespace

void CheckMonotonic(harness::Ctx& ctx) {
  ship("shp_1", "label");
  ctx.Equal(mustApply(ctx, "shp_1", "in_transit", 100, "Memphis").applied, true, "the first in_transit scan must apply to a fresh label; applied");
  ctx.Equal(mustApply(ctx, "shp_1", "out_for_delivery", 200, "Leeds").applied, true, "out_for_delivery after in_transit must apply; applied");
  // The van returns to the depot: a later scan, a lower rank.
  auto result = mustApply(ctx, "shp_1", "in_transit", 260, "Leeds");
  ctx.Equal(statusOf(ctx, "shp_1"), "out_for_delivery", "an in_transit depot scan at t=260 after out_for_delivery at t=200 must be dropped (only a scan that ranks above the current status applies, whatever its time); the status");
  ctx.Assert(!result.applied && result.status == "out_for_delivery", "the dropped scan must answer applied false with status out_for_delivery, got applied %t status %q", result.applied, result.status);
  // A carrier device whose clock lags: a forward scan stamped earlier still moves the parcel on.
  result = mustApply(ctx, "shp_1", "delivered", 190, "Leeds");
  ctx.Assert(result.applied && statusOf(ctx, "shp_1") == "delivered", "a delivered scan stamped t=190 after out_for_delivery at t=200 left the shipment %s: rank orders the journey, not the scan clock", statusOf(ctx, "shp_1"));
}

void CheckTerminalImmutable(harness::Ctx& ctx) {
  ship("shp_1", "label");
  mustApply(ctx, "shp_1", "out_for_delivery", 100, "Leeds");
  ctx.Equal(mustApply(ctx, "shp_1", "delivered", 200, "Leeds").applied, true, "delivered after out_for_delivery must apply; applied");
  const auto result = mustApply(ctx, "shp_1", "returned", 300, "Leeds");
  ctx.Equal(statusOf(ctx, "shp_1"), "delivered", "a returned scan after delivered must be dropped (delivered is terminal); the status");
  ctx.Equal(result.applied, false, "a scan on a delivered shipment; applied");
  ship("shp_2", "cancelled");
  bool applied = false;
  try {
    applied = applyScan("shp_2", "in_transit", 400, "Leeds").applied;
  } catch (const std::exception&) {
  }
  ctx.Assert(statusOf(ctx, "shp_2") == "cancelled" && !applied, "a scan on a cancelled shipment moved it to %s: cancelled is terminal", statusOf(ctx, "shp_2"));
}

void CheckAtomic(harness::Ctx& ctx) {
  ship("shp_1", "label");
  mustApply(ctx, "shp_1", "in_transit", 100, "Memphis");
  // A second carrier's delivery scan lands between this scan's read and its write.
  auto fired = std::make_shared<bool>(false);
  auto failed = std::make_shared<std::optional<std::string>>();
  ctx.Redis.After("shipment:shp_1", [fired, failed] {
    *fired = true;
    try {
      applyScan("shp_1", "delivered", 300, "Leeds");
    } catch (const std::exception& e) {
      *failed = e.what();
    }
  });
  mustApply(ctx, "shp_1", "out_for_delivery", 200, "Leeds");
  ctx.Assert(*fired, "the scan never touched shipment:shp_1");
  ctx.Assert(!failed->has_value(), "the rival delivery scan failed: %s", failed->value_or(""));
  ctx.Equal(statusOf(ctx, "shp_1"), "delivered", "two scans raced: the out_for_delivery scan read in_transit before the delivery landed, then wrote over it. Read, compare and write in one Lua script; the status");
  const auto scans = timeline("shp_1");
  ctx.Assert(std::count(scans.begin(), scans.end(), "delivered") > 0, "the delivery scan is missing from the timeline: %q", scans);
}

void CheckRejectedRecorded(harness::Ctx& ctx) {
  ship("shp_1", "label");
  mustApply(ctx, "shp_1", "in_transit", 100, "Memphis");
  mustApply(ctx, "shp_1", "out_for_delivery", 200, "Leeds");
  const auto result = mustApply(ctx, "shp_1", "in_transit", 150, "Memphis");
  ctx.Assert(!result.applied && result.attempted == "out_for_delivery->in_transit", "a late in_transit scan must be dropped with attempted out_for_delivery->in_transit, got applied %t attempted %q", result.applied, result.attempted);
  const auto rejects = ctx.Redis.LRange("shipment:shp_1:rejects", 0, -1);
  ctx.Equal(rejects, {"out_for_delivery->in_transit"}, "a dropped scan must leave its edge for operations; shipment:shp_1:rejects");
  ctx.Equal(timeline("shp_1"), {"in_transit", "out_for_delivery"}, "a dropped scan is not part of the timeline; the scans");
  mustApply(ctx, "shp_1", "delivered", 300, "Leeds");
  ctx.Equal(ctx.Redis.LRange("shipment:shp_1:rejects", 0, -1), rejects, "an applied scan must not be recorded as dropped; the rejects");
}
`,
  },
  debrief: `Rank is the only order a parcel's journey has: carrier clocks drift, handhelds upload in batches, and a depot re-scan is newer than the out-for-delivery scan without being further along. Putting the read, the comparison and the write in one script is what makes two concurrent scans safe, because Redis runs the script whole and the second scan compares against the first one's result. Terminal states are their own rule since rank alone lets \`returned\` follow \`delivered\`. Recording the dropped edge turns a silent drop into data: a carrier that sends many backward edges has a feed problem worth a ticket. A production tracker also keeps the dropped scan's payload, and lets an operator replay it or override the status with an audit entry.`,
};
