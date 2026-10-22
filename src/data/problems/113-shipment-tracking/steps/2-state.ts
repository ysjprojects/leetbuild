import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis status timeline with monotonic transitions',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'carrier'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a scan arrives, the status is
written, the tracking page moves. It never fails in a demo where scans arrive in order and one
carrier scans at a time. Both of those assumptions are false in production. Review it, fix it, and
prove the fix with the checks below.

Implement \`POST /v1/shipments/{shipment_id}/scans\` with body
\`{"status": "out_for_delivery", "scan_at": 1761000000, "carrier": "ups"}\`.

- The shipment's status is one of \`label\`, \`in_transit\`, \`out_for_delivery\`, \`delivered\`,
  \`returned\`, ranked in that order (\`STATUS_RANK\`). A status outside the set is **400** and never
  reaches Redis.
- The status may only move **forward**: a scan whose rank is not strictly greater than the current
  one is **dropped, not applied**. A delayed \`in_transit\` scan that arrives after the delivery
  scan must leave the shipment \`delivered\`.
- **Terminal states are immutable.** Once the shipment is \`delivered\` or \`returned\`, no scan may
  move it anywhere, including \`returned\` after \`delivered\` — the parcel has already been handed
  over.
- The read, the comparison and the write happen inside **one atomic Lua \`EVAL\`**
  (\`APPLY_LUA\`). Two carriers scanning at once must resolve to the **furthest valid state**, not
  to whichever request was slower to write; a client-side \`GET\` followed by \`HSET\` is the race
  the draft ships.
- A dropped transition is not applied and is **recorded**: \`LPUSH\` the attempted edge
  (\`delivered->in_transit\`) onto \`shipment:rejects:{shipment_id}\` and keep it on the hash, so
  operations can see which carrier is reporting out of order.
- Answer with \`{"applied": bool, "status": "<current>", "attempted": "<from>-><to>",
  "terminal": bool}\`.

**Failure mode the checks target.** The draft applies whatever status the latest poll reports, so a
delayed in-transit scan after delivery rolls the shipment backward and the customer's page
"un-delivers" a parcel that is already on the porch. Two carriers scanning the same shipment both
read and both write, and the later write wins regardless of rank, so the outcome depends on
scheduling. And with no terminal guard, a \`returned\` after \`delivered\` reopens a closed shipment.
Every one of those is invisible until a real carrier network disagrees with itself.`,
  sequence: {
    participants: ['Carrier gateway', 'Shipment API', 'Redis'],
    messages: [
      {
        from: 'Carrier gateway',
        to: 'Shipment API',
        label: 'scan in_transit · arrived after the delivery scan',
        kind: 'sync',
      },
      {from: 'Shipment API', to: 'Shipment API', label: 'status ∈ STATUS_RANK, else 400', kind: 'sync'},
      {
        from: 'Shipment API',
        to: 'Redis',
        label: 'EVAL APPLY_LUA · KEYS[shipment:shp_8f:status, shipment:rejects:shp_8f]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Shipment API', label: "'0|delivered|delivered' — dropped and recorded", kind: 'reply'},
      {
        from: 'Shipment API',
        to: 'Redis',
        label: 'EVAL APPLY_LUA · two carriers scanning the same shipment',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Shipment API',
        label: "'1|in_transit|out_for_delivery' — the furthest valid state wins",
        kind: 'reply',
      },
      {from: 'Shipment API', to: 'Carrier gateway', label: '200 {applied, status, attempted, terminal}', kind: 'reply'},
    ],
  },
  hints: [
    'The comparison has to live where the state lives. `GET`, compare in your process, `HSET`: two carriers do that at the same time and both see the old status. One `APPLY_LUA` script does `HGET`, ranks the statuses and `HSET`s only on a forward move, so the winner is decided inside Redis.',
    'Forward-only is a rank comparison, and a rejected scan is information, not noise: `LPUSH` the attempted edge (`delivered->in_transit`) onto `shipment:rejects:{id}` and mirror it onto the hash, then answer with `applied: false` and the status you kept. Operations needs to know which carrier is scanning out of order.',
    'Terminal is a separate guard from monotonic: `delivered` and `returned` are both the end of the line, so a `returned` scan after a delivery would pass a rank check. Test `terminals[current]` before the rank comparison, and keep the language-side `TERMINAL` set and `is_terminal()` helper so the response can say the shipment is closed.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Applies the transition in one atomic Lua script',
      detail:
        'The read, the rank comparison and the write all happen inside one `APPLY_LUA` script run through `EVAL` (`HGET` and `HSET` on the script side). A client-side `GET` followed by `HSET` lets two carriers both observe the old status and the later write win.',
      match: {
        python: {all: [/APPLY_LUA/, /\.eval\(/, /HGET/, /HSET/]},
        typescript: {all: [/APPLY_LUA/, /\.eval\(/, /HGET/, /HSET/]},
        go: {all: [/(applyScript|NewScript)/, /\.Run\(/, /HGET/, /HSET/]},
        scala: {all: [/ApplyLua/, /\.eval\(/, /HGET/, /HSET/]},
        cpp: {all: [/kApplyLua/, /\.eval</, /HGET/, /HSET/]},
      },
    },
    {
      id: 'monotonic',
      title: 'Rejects any transition that is not strictly forward',
      detail:
        'The statuses carry a rank (`STATUS_RANK`) and the script keeps only strictly forward moves: `ranks[new] <= ranks[current]` is dropped. The draft writes whatever status the poll reported, so a delayed in-transit scan rolls a delivered shipment backward.',
      match: {
        python: {all: [/STATUS_RANK/, /ranks\[new\]/, /ranks\[current\]/]},
        typescript: {all: [/STATUS_RANK/, /ranks\[new\]/, /ranks\[current\]/]},
        go: {all: [/statusRank/, /ranks\[new\]/, /ranks\[current\]/]},
        scala: {all: [/StatusRank/, /ranks\[new\]/, /ranks\[current\]/]},
        cpp: {all: [/kStatusRank/, /ranks\[new\]/, /ranks\[current\]/]},
      },
    },
    {
      id: 'rejected-recorded',
      title: 'Records the attempted edge of a dropped transition',
      detail:
        'A rejected scan is pushed onto `shipment:rejects:{shipment_id}` with `LPUSH` and reported back as the `attempted` edge, so operations can see the out-of-order scan instead of it disappearing.',
      match: {
        python: {all: [/rejects:/, /LPUSH/, /attempted/]},
        typescript: {all: [/rejects:/, /LPUSH/, /attempted/]},
        go: {all: [/rejects:/, /LPUSH/, /attempted/]},
        scala: {all: [/rejects:/, /LPUSH/, /attempted/]},
        cpp: {all: [/rejects:/, /LPUSH/, /attempted/]},
      },
    },
    {
      id: 'terminal-immutable',
      title: 'Keeps delivered and returned terminal',
      detail:
        '`delivered` and `returned` are terminal: the script tests `terminals[current]` before the rank comparison, and the response reports `terminal` through the language-side `TERMINAL` set and `is_terminal()`. The draft lets a `returned` scan follow a delivery and reopen a closed shipment.',
      match: {
        python: {all: [/terminals\[current\]/, /TERMINAL\s*=/, /is_terminal\(/]},
        typescript: {all: [/terminals\[current\]/, /TERMINAL\s*[:=]/, /isTerminal\(/]},
        go: {all: [/terminals\[current\]/, /terminalStatuses/, /isTerminal\(/]},
        scala: {all: [/terminals\[current\]/, /Terminal\s*=/, /isTerminal\(/]},
        cpp: {all: [/terminals\[current\]/, /kTerminal/, /isTerminal\(/]},
      },
    },
    {
      id: 'no-client-write',
      title: 'Never writes the status from the client after a read',
      detail:
        'The status is written only by the script; there is no client-side `HSET` after a `GET`. The draft reads the status, then writes whatever the poll reported, which is exactly the read-modify-write race that loses the furthest state.',
      match: {
        python: {all: [/\.eval\(/], none: [/r\.hset\(/]},
        typescript: {all: [/\.eval\(/], none: [/r\.hset\(/]},
        go: {all: [/(\.Run\(|\.Eval\()/], none: [/rdb\.HSet\(/]},
        scala: {all: [/\.eval\(/], none: [/jedis\.hset\(/]},
        cpp: {all: [/\.eval</], none: [/\.hset\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("shipment-state")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class ScanRequest(BaseModel):
    status: str
    scan_at: int
    carrier: str


def status_key(shipment_id: str) -> str:
    return f"shipment:{shipment_id}:status"


@app.post("/v1/shipments/{shipment_id}/scans")
def record_scan(shipment_id: str, body: ScanRequest) -> dict:
    # TODO: this draft applies whatever status the poll reports: a delayed in-transit scan after a
    # delivery rolls the shipment backward, two carriers scanning at once race and the later write
    # wins, and nothing protects a terminal state. Apply the transition in one atomic Lua script,
    # keep only strictly forward moves, and record the rejected edge instead of applying it.
    current = r.get(f"{status_key(shipment_id)}:status") or "label"
    r.hset(
        status_key(shipment_id),
        mapping={"status": body.status, "updated_at": body.scan_at, "carrier": body.carrier},
    )
    logger.info("scan shipment=%s %s->%s", shipment_id, current, body.status)
    return {"applied": True, "status": body.status, "attempted": f"{current}->{body.status}"}
`,
      solution: `import logging

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("shipment-state")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# The forward-only contract: a scan may move a shipment to a strictly further status.
STATUS_RANK = {"label": 0, "in_transit": 1, "out_for_delivery": 2, "delivered": 3, "returned": 4}
TERMINAL = {"delivered", "returned"}

APPLY_LUA = """
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true}
local current = redis.call('HGET', KEYS[1], 'status') or 'label'
local new = ARGV[1]
local edge = current .. '->' .. new
if terminals[current] or ranks[new] <= ranks[current] then
  redis.call('LPUSH', KEYS[2], edge)
  redis.call('HSET', KEYS[1], 'rejected_edge', edge)
  return '0|' .. current .. '|' .. current
end
redis.call('HSET', KEYS[1], 'status', new)
redis.call('HSET', KEYS[1], 'updated_at', ARGV[2])
redis.call('HSET', KEYS[1], 'carrier', ARGV[3])
return '1|' .. current .. '|' .. new
"""


class ScanRequest(BaseModel):
    status: str
    scan_at: int
    carrier: str


def status_key(shipment_id: str) -> str:
    return f"shipment:{shipment_id}:status"


def rejects_key(shipment_id: str) -> str:
    return f"shipment:rejects:{shipment_id}"


def is_terminal(status: str) -> bool:
    return status in TERMINAL


def apply_scan(shipment_id: str, status: str, scan_at: int, carrier: str) -> tuple[bool, str, str]:
    applied, previous, current = r.eval(
        APPLY_LUA, 2, status_key(shipment_id), rejects_key(shipment_id), status, scan_at, carrier
    ).split("|")
    return applied == "1", previous, current


@app.post("/v1/shipments/{shipment_id}/scans")
def record_scan(shipment_id: str, body: ScanRequest) -> dict:
    if body.status not in STATUS_RANK:
        raise HTTPException(status_code=400, detail="unknown status")
    applied, previous, current = apply_scan(shipment_id, body.status, body.scan_at, body.carrier)
    logger.info(
        "scan shipment=%s applied=%s attempted=%s->%s carrier=%s",
        shipment_id,
        applied,
        previous,
        body.status,
        body.carrier,
    )
    return {
        "applied": applied,
        "status": current,
        "attempted": f"{previous}->{body.status}",
        "terminal": is_terminal(current),
    }
`,
    },
    typescript: {
      starter: `/** POST /v1/shipments/:shipmentId/scans: a model-generated draft that writes whatever it is told. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface ScanBody {
  status: string;
  scan_at: number;
  carrier: string;
}

function statusKey(shipmentId: string): string {
  return \`shipment:\${shipmentId}:status\`;
}

app.post('/v1/shipments/:shipmentId/scans', async (request, reply) => {
  // TODO: this draft applies whatever status the poll reports: a delayed in-transit scan after a
  // delivery rolls the shipment backward, two carriers scanning at once race and the later write
  // wins, and nothing protects a terminal state. Apply the transition in one atomic Lua script,
  // keep only strictly forward moves, and record the rejected edge instead of applying it.
  const {shipmentId} = request.params as {shipmentId: string};
  const body = request.body as ScanBody;
  const current = (await r.hget(statusKey(shipmentId), 'status')) ?? 'label';
  await r.hset(statusKey(shipmentId), {
    status: body.status,
    updated_at: String(body.scan_at),
    carrier: body.carrier,
  });
  request.log.info({shipmentId, from: current, to: body.status}, 'scan');
  return reply.code(200).send({
    applied: true,
    status: body.status,
    attempted: \`\${current}->\${body.status}\`,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/shipments/:shipmentId/scans: forward-only status, decided inside one Lua script. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

// The forward-only contract: a scan may move a shipment to a strictly further status.
const STATUS_RANK: Record<string, number> = {
  label: 0,
  in_transit: 1,
  out_for_delivery: 2,
  delivered: 3,
  returned: 4,
};
const TERMINAL: Record<string, true> = {delivered: true, returned: true};

const APPLY_LUA = \`
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true}
local current = redis.call('HGET', KEYS[1], 'status') or 'label'
local new = ARGV[1]
local edge = current .. '->' .. new
if terminals[current] or ranks[new] <= ranks[current] then
  redis.call('LPUSH', KEYS[2], edge)
  redis.call('HSET', KEYS[1], 'rejected_edge', edge)
  return '0|' .. current .. '|' .. current
end
redis.call('HSET', KEYS[1], 'status', new)
redis.call('HSET', KEYS[1], 'updated_at', ARGV[2])
redis.call('HSET', KEYS[1], 'carrier', ARGV[3])
return '1|' .. current .. '|' .. new
\`;

interface ScanBody {
  status: string;
  scan_at: number;
  carrier: string;
}

function statusKey(shipmentId: string): string {
  return \`shipment:\${shipmentId}:status\`;
}

function rejectsKey(shipmentId: string): string {
  return \`shipment:rejects:\${shipmentId}\`;
}

function isTerminal(status: string): boolean {
  return TERMINAL[status] === true;
}

async function applyScan(
  shipmentId: string,
  status: string,
  scanAt: number,
  carrier: string,
): Promise<[boolean, string, string]> {
  const reply = (await r.eval(
    APPLY_LUA,
    2,
    statusKey(shipmentId),
    rejectsKey(shipmentId),
    status,
    String(scanAt),
    carrier,
  )) as string;
  const [applied, previous, current] = reply.split('|');
  return [applied === '1', previous, current];
}

app.post('/v1/shipments/:shipmentId/scans', async (request, reply) => {
  const {shipmentId} = request.params as {shipmentId: string};
  const body = request.body as ScanBody;
  if (STATUS_RANK[body.status] === undefined) return reply.code(400).send({error: 'unknown status'});
  const [applied, previous, current] = await applyScan(shipmentId, body.status, body.scan_at, body.carrier);
  request.log.info({shipmentId, applied, from: previous, to: body.status}, 'scan');
  return reply.code(200).send({
    applied,
    status: current,
    attempted: \`\${previous}->\${body.status}\`,
    terminal: isTerminal(current),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func statusKey(shipmentID string) string {
	return fmt.Sprintf("shipment:%s:status", shipmentID)
}

func recordScan(rw http.ResponseWriter, r *http.Request) {
	shipmentID := r.PathValue("id")
	var body struct {
		Status  string \`json:"status"\`
		ScanAt  int64  \`json:"scan_at"\`
		Carrier string \`json:"carrier"\`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this draft applies whatever status the poll reports: a delayed in-transit scan after a
	// delivery rolls the shipment backward, two carriers scanning at once race and the later write
	// wins, and nothing protects a terminal state. Apply the transition in one atomic Lua script,
	// keep only strictly forward moves, and record the rejected edge instead of applying it.
	current, _ := rdb.HGet(context.Background(), statusKey(shipmentID), "status").Result()
	if current == "" {
		current = "label"
	}
	rdb.HSet(context.Background(), statusKey(shipmentID), map[string]any{
		"status":     body.Status,
		"updated_at": body.ScanAt,
		"carrier":    body.Carrier,
	})
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(\`{"applied":true,"status":%q,"attempted":"%s->%s"}\`, body.Status, current, body.Status)))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/shipments/{id}/scans", recordScan)
	_ = http.ListenAndServe(":8080", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

// The forward-only contract: a scan may move a shipment to a strictly further status.
var statusRank = map[string]int{"label": 0, "in_transit": 1, "out_for_delivery": 2, "delivered": 3, "returned": 4}

var terminalStatuses = map[string]bool{"delivered": true, "returned": true}

var rdb *redis.Client

var applyScript = redis.NewScript(\`
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true}
local current = redis.call('HGET', KEYS[1], 'status') or 'label'
local new = ARGV[1]
local edge = current .. '->' .. new
if terminals[current] or ranks[new] <= ranks[current] then
  redis.call('LPUSH', KEYS[2], edge)
  redis.call('HSET', KEYS[1], 'rejected_edge', edge)
  return '0|' .. current .. '|' .. current
end
redis.call('HSET', KEYS[1], 'status', new)
redis.call('HSET', KEYS[1], 'updated_at', ARGV[2])
redis.call('HSET', KEYS[1], 'carrier', ARGV[3])
return '1|' .. current .. '|' .. new
\`)

func statusKey(shipmentID string) string {
	return fmt.Sprintf("shipment:%s:status", shipmentID)
}

func rejectsKey(shipmentID string) string {
	return fmt.Sprintf("shipment:rejects:%s", shipmentID)
}

func isTerminal(status string) bool {
	return terminalStatuses[status]
}

func applyScan(ctx context.Context, shipmentID, status string, scanAt int64, carrier string) (bool, string, string, error) {
	reply, err := applyScript.Run(
		ctx,
		rdb,
		[]string{statusKey(shipmentID), rejectsKey(shipmentID)},
		status,
		strconv.FormatInt(scanAt, 10),
		carrier,
	).Result()
	if err != nil {
		return false, "", "", err
	}
	parts := strings.Split(reply.(string), "|")
	return parts[0] == "1", parts[1], parts[2], nil
}

func recordScan(rw http.ResponseWriter, r *http.Request) {
	shipmentID := r.PathValue("id")
	var body struct {
		Status  string \`json:"status"\`
		ScanAt  int64  \`json:"scan_at"\`
		Carrier string \`json:"carrier"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, \`{"error":"invalid json"}\`, http.StatusBadRequest)
		return
	}
	if _, ok := statusRank[body.Status]; !ok {
		http.Error(rw, \`{"error":"unknown status"}\`, http.StatusBadRequest)
		return
	}
	applied, previous, current, err := applyScan(r.Context(), shipmentID, body.Status, body.ScanAt, body.Carrier)
	if err != nil {
		http.Error(rw, \`{"error":"state store unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(fmt.Sprintf(
		\`{"applied":%t,"status":%q,"attempted":"%s->%s","terminal":%t}\`,
		applied, current, previous, body.Status, isTerminal(current),
	)))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/shipments/{id}/scans", recordScan)
	_ = http.ListenAndServe(":8080", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ScanRequest(status: String, scan_at: Long, carrier: String)

object StateApi {
  implicit val system: ActorSystem = ActorSystem("shipment-state")
  implicit val scanFormat: RootJsonFormat[ScanRequest] = jsonFormat3(ScanRequest)

  val jedis = new Jedis("redis", 6379)

  def statusKey(shipmentId: String): String = "shipment:" + shipmentId + ":status"

  val route: Route =
    path("v1" / "shipments" / Segment / "scans") { shipmentId =>
      post {
        entity(as[ScanRequest]) { body =>
          // TODO: this draft applies whatever status the poll reports: a delayed in-transit scan
          // after a delivery rolls the shipment backward, two carriers scanning at once race and
          // the later write wins, and nothing protects a terminal state. Apply the transition in
          // one atomic Lua script, keep only strictly forward moves, and record the rejected edge.
          val current = Option(jedis.hget(statusKey(shipmentId), "status")).getOrElse("label")
          jedis.hset(
            statusKey(shipmentId),
            Map("status" -> body.status, "updated_at" -> body.scan_at.toString, "carrier" -> body.carrier).asJava
          )
          system.log.info("scan shipment=" + shipmentId + " " + current + "->" + body.status)
          complete(
            StatusCodes.OK,
            "{\\"applied\\":true,\\"status\\":\\"" + body.status + "\\",\\"attempted\\":\\"" + current + "->" + body.status + "\\"}"
          )
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ScanRequest(status: String, scan_at: Long, carrier: String)

object StateApi {
  implicit val system: ActorSystem = ActorSystem("shipment-state")
  implicit val scanFormat: RootJsonFormat[ScanRequest] = jsonFormat3(ScanRequest)

  // The forward-only contract: a scan may move a shipment to a strictly further status.
  val StatusRank = Map("label" -> 0, "in_transit" -> 1, "out_for_delivery" -> 2, "delivered" -> 3, "returned" -> 4)
  val Terminal = Set("delivered", "returned")

  val ApplyLua =
    """
      |local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
      |local terminals = {delivered = true, returned = true}
      |local current = redis.call('HGET', KEYS[1], 'status') or 'label'
      |local new = ARGV[1]
      |local edge = current .. '->' .. new
      |if terminals[current] or ranks[new] <= ranks[current] then
      |  redis.call('LPUSH', KEYS[2], edge)
      |  redis.call('HSET', KEYS[1], 'rejected_edge', edge)
      |  return '0|' .. current .. '|' .. current
      |end
      |redis.call('HSET', KEYS[1], 'status', new)
      |redis.call('HSET', KEYS[1], 'updated_at', ARGV[2])
      |redis.call('HSET', KEYS[1], 'carrier', ARGV[3])
      |return '1|' .. current .. '|' .. new
      |""".stripMargin

  val jedis = new Jedis("redis", 6379)

  def statusKey(shipmentId: String): String = "shipment:" + shipmentId + ":status"

  def rejectsKey(shipmentId: String): String = "shipment:rejects:" + shipmentId

  def isTerminal(status: String): Boolean = Terminal.contains(status)

  def applyScan(shipmentId: String, status: String, scanAt: Long, carrier: String): (Boolean, String, String) = {
    val reply = jedis
      .eval(
        ApplyLua,
        2,
        statusKey(shipmentId),
        rejectsKey(shipmentId),
        status,
        scanAt.toString,
        carrier
      )
      .asInstanceOf[String]
    val parts = reply.split("\\|")
    (parts(0) == "1", parts(1), parts(2))
  }

  val route: Route =
    path("v1" / "shipments" / Segment / "scans") { shipmentId =>
      post {
        entity(as[ScanRequest]) { body =>
          if (!StatusRank.contains(body.status)) {
            complete(StatusCodes.BadRequest, """{"error":"unknown status"}""")
          } else {
            val (applied, previous, current) = applyScan(shipmentId, body.status, body.scan_at, body.carrier)
            system.log.info(
              "scan shipment=" + shipmentId + " applied=" + applied + " attempted=" + previous + "->" + body.status
            )
            complete(
              StatusCodes.OK,
              "{\\"applied\\":" + applied + ",\\"status\\":\\"" + current + "\\",\\"attempted\\":\\"" + previous +
                "->" + body.status + "\\",\\"terminal\\":" + isTerminal(current) + "}"
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

using json = nlohmann::json;

std::string statusKey(const std::string& shipmentId) {
  return "shipment:" + shipmentId + ":status";
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post(R"(/v1/shipments/([^/]+)/scans)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto shipmentId = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft applies whatever status the poll reports: a delayed in-transit scan after a
    // delivery rolls the shipment backward, two carriers scanning at once race and the later write
    // wins, and nothing protects a terminal state. Apply the transition in one atomic Lua script,
    // keep only strictly forward moves, and record the rejected edge instead of applying it.
    const auto status = body.value("status", std::string());
    auto rawCurrent = redis.hget(statusKey(shipmentId), "status");
    const auto current = rawCurrent ? *rawCurrent : std::string("label");
    redis.hset(statusKey(shipmentId), "status", status);
    redis.hset(statusKey(shipmentId), "updated_at", std::to_string(body.value("scan_at", 0LL)));
    redis.hset(statusKey(shipmentId), "carrier", body.value("carrier", std::string()));
    std::cerr << "scan shipment=" << shipmentId << " " << current << "->" << status << "\\n";
    res.status = 200;
    res.set_content(json{{"applied", true}, {"status", status}, {"attempted", current + "->" + status}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

// The forward-only contract: a scan may move a shipment to a strictly further status.
const std::map<std::string, int> kStatusRank = {
    {"label", 0}, {"in_transit", 1}, {"out_for_delivery", 2}, {"delivered", 3}, {"returned", 4}};
const std::vector<std::string> kTerminal = {"delivered", "returned"};

const char* kApplyLua = R"LUA(
local ranks = {label = 0, in_transit = 1, out_for_delivery = 2, delivered = 3, returned = 4}
local terminals = {delivered = true, returned = true}
local current = redis.call('HGET', KEYS[1], 'status') or 'label'
local new = ARGV[1]
local edge = current .. '->' .. new
if terminals[current] or ranks[new] <= ranks[current] then
  redis.call('LPUSH', KEYS[2], edge)
  redis.call('HSET', KEYS[1], 'rejected_edge', edge)
  return '0|' .. current .. '|' .. current
end
redis.call('HSET', KEYS[1], 'status', new)
redis.call('HSET', KEYS[1], 'updated_at', ARGV[2])
redis.call('HSET', KEYS[1], 'carrier', ARGV[3])
return '1|' .. current .. '|' .. new
)LUA";

std::string statusKey(const std::string& shipmentId) {
  return "shipment:" + shipmentId + ":status";
}

std::string rejectsKey(const std::string& shipmentId) {
  return "shipment:rejects:" + shipmentId;
}

bool isTerminal(const std::string& status) {
  for (const auto& terminal : kTerminal) {
    if (terminal == status) return true;
  }
  return false;
}

std::vector<std::string> split(const std::string& value, char sep) {
  std::vector<std::string> parts;
  std::string part;
  for (const char c : value) {
    if (c == sep) {
      parts.push_back(part);
      part.clear();
    } else {
      part.push_back(c);
    }
  }
  parts.push_back(part);
  return parts;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post(R"(/v1/shipments/([^/]+)/scans)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto shipmentId = req.matches[1].str();
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto status = body.value("status", std::string());
    if (kStatusRank.count(status) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown status"})", "application/json");
      return;
    }
    const auto reply = redis.eval<std::string>(
        kApplyLua,
        {statusKey(shipmentId), rejectsKey(shipmentId)},
        {status, std::to_string(body.value("scan_at", 0LL)), body.value("carrier", std::string())});
    const auto parts = split(reply, '|');
    const bool applied = parts[0] == "1";
    const auto& previous = parts[1];
    const auto& current = parts[2];
    std::cerr << "scan shipment=" << shipmentId << " applied=" << applied << " attempted=" << previous << "->"
              << status << "\\n";
    res.status = 200;
    res.set_content(
        json{{"applied", applied},
             {"status", current},
             {"attempted", previous + "->" + status},
             {"terminal", isTerminal(current)}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The question behind this step is monotonicity under concurrency: a status that only moves forward is a compare-and-set on a ranked value, and both halves have to happen in one place. Doing the comparison in your process turns it into a read-modify-write race that passes every serial test and fails when two carriers scan the same parcel a second apart. The rank table makes "forward" checkable; the terminal guard makes it safe to replay any late scan; the rejects list turns a dropped scan into an observed event instead of a mystery in the customer's timeline. Real tracking services add per-scan dedupe by carrier scan id, a separate history list for the full timeline, and a reconciliation job that compares the carrier's own scan history against the state they recorded.`,
};
