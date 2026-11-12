import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/nodes/{id}: live counters, for operators',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['operator', 'scheduler', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/nodes/{id}\` with the node's type, capacity,
allocated and free counts for callers whose \`X-Scope\` header says \`operator\`, and
\`reconcile_node(node_id)\` recomputes \`allocated\` from the placement records. It serves the
demo dashboard and hides four flaws.

**Failure mode the checks target.** The dashboard shows GPUs the ledger booked minutes ago as
free; a node whose counter drifted above its capacity reports a negative free count; a reboot's
reconcile counts placements that were released long ago; any caller who types a header reads the
whole fleet.

- The route requires \`Authorization: Bearer <token>\`; the token is resolved in Redis
  (\`token:{token}\`, field \`scope\`). No token is **401**, a scope other than \`operator\` is
  **403**. Nothing the client sends decides the scope.
- Read \`node:{id}\` from Redis on every request: \`capacity\` and \`allocated\` as the ledger holds
  them now, \`free = max(capacity - allocated, 0)\`, \`placeable = free > 0\`, \`alive\` from
  \`heartbeat:{id}\`. An unknown node is **404**.
- \`reconcile_node(node_id)\` sums \`count\` over the ids in \`node:{id}:placements\` (the open
  placements only), writes the sum to \`allocated\` and returns it.`,
  sequence: {
    participants: ['Operator', 'gpusched', 'Redis'],
    messages: [
      {from: 'Operator', to: 'gpusched', label: 'GET /v1/nodes/gpu-1 · Authorization: Bearer op-1', kind: 'sync'},
      {from: 'gpusched', to: 'Redis', label: 'HGETALL token:op-1 → scope operator', kind: 'sync'},
      {from: 'gpusched', to: 'Redis', label: 'HGETALL node:gpu-1 · EXISTS heartbeat:gpu-1', kind: 'sync'},
      {
        from: 'gpusched',
        to: 'Operator',
        label: '200 {capacity 8, allocated 6, free 2, placeable true, alive true}',
        kind: 'reply',
      },
      {from: 'Operator', to: 'gpusched', label: 'GET /v1/nodes/gpu-1 · Bearer t-1 (a tenant)', kind: 'sync'},
      {from: 'gpusched', to: 'Operator', label: '403', kind: 'reply'},
      {
        from: 'gpusched',
        to: 'Redis',
        label: 'reconcile: SMEMBERS node:gpu-1:placements · HGET count · HSET allocated',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'Right after a booking the node still reads as idle for minutes; after a counter drift the dashboard shows free: -2; a tenant who adds a header to curl sees every node.',
    'The handler keeps a five-minute cache of `allocated`, subtracts without a floor, trusts the caller for its scope, and reconciles over every `placement:*` key, released ones included.',
    'Drop the cache and read `node:{id}` each time; clamp free with `max(…, 0)`; look the bearer token up in `token:{token}`; sum only the ids in `node:{id}:placements`.',
  ],
  checks: [
    {
      id: 'node-route',
      title: 'GET /v1/nodes/{id} answers capacity, allocated and free',
      detail:
        'The route is registered on `GET /v1/nodes/{id}` and answers `node_id`, `gpu_type`, `capacity`, `allocated`, `free`, `placeable` and `alive`; an unknown node is 404. The starter does this already.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/nodes\/\{/, /["']free["']/, /status_code=404/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/nodes\/:/, /\bfree\b/, /code\(\s*404\s*\)/]},
        go: {all: [/"GET \/v1\/nodes\/\{id\}"/, /"free"/, /StatusNotFound/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"nodes"\s*\/\s*Segment\s*\)/, /"free"/, /StatusCodes\.NotFound/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/v1\/nodes\//, /"free"/, /status\s*=\s*404/]},
      },
    },
    {
      id: 'atomic-capacity',
      title: 'allocated is read from the ledger on every request',
      detail:
        'The handler reads `node:{id}` each time; there is no per-process snapshot of `allocated`. The starter caches it for five minutes, so the read and the ledger disagree by every booking since the refresh.',
      match: {
        python: {all: [/hgetall\(\s*f["']node:\{node_id\}["']\s*\)/], none: [/CACHE_TTL_S|_allocated_cache/]},
        typescript: {all: [/hgetall\(\s*`node:\$\{nodeId\}`\s*\)/], none: [/CACHE_TTL_MS|allocatedCache/]},
        go: {all: [/HGetAll\(\s*[^,]+,\s*"node:"\s*\+\s*nodeID\s*\)/], none: [/cacheTTL|allocatedCache/]},
        scala: {all: [/hgetAll\(\s*s"node:\$nodeId"\s*\)/], none: [/CacheTtlMillis|allocatedCache/]},
        cpp: {all: [/hgetall\(\s*"node:"\s*\+\s*node_id\s*\)/], none: [/kCacheTtl|allocated_cache/]},
      },
    },
    {
      id: 'free-clamp',
      title: 'free is clamped at zero',
      detail:
        '`free = max(capacity - allocated, 0)` and `placeable = free > 0`, so a drifted counter reports no free GPUs rather than a negative number. The starter subtracts without a floor.',
      match: {
        python: {
          all: [
            /max\(\s*capacity\s*-\s*allocated\s*,\s*0\s*\)|max\(\s*0\s*,\s*capacity\s*-\s*allocated\s*\)/,
            /placeable/,
          ],
        },
        typescript: {
          all: [
            /Math\.max\(\s*capacity\s*-\s*allocated\s*,\s*0\s*\)|Math\.max\(\s*0\s*,\s*capacity\s*-\s*allocated\s*\)/,
            /placeable/,
          ],
        },
        go: {
          all: [
            /max\(\s*capacity\s*-\s*allocated\s*,\s*0\s*\)|max\(\s*0\s*,\s*capacity\s*-\s*allocated\s*\)/,
            /placeable/,
          ],
        },
        scala: {
          all: [
            /math\.max\(\s*capacity\s*-\s*allocated\s*,\s*0\s*\)|math\.max\(\s*0\s*,\s*capacity\s*-\s*allocated\s*\)/,
            /placeable/,
          ],
        },
        cpp: {
          all: [
            /std::max\(\s*capacity\s*-\s*allocated\s*,\s*0\s*\)|std::max\(\s*0\s*,\s*capacity\s*-\s*allocated\s*\)/,
            /placeable/,
          ],
        },
      },
    },
    {
      id: 'reconcile',
      title: 'reconcile_node sums the open placements only',
      detail:
        'The sum runs over the ids in `node:{id}:placements`, which release removes, and is written to `allocated`. The starter scans every `placement:*` record with the node id, released ones included.',
      match: {
        python: {
          all: [/def reconcile_node/, /smembers\(\s*f["']node:\{node_id\}:placements["']\s*\)/],
          none: [/keys\(\s*["']placement:\*["']\s*\)/],
        },
        typescript: {
          all: [/function reconcileNode/, /smembers\(\s*`node:\$\{nodeId\}:placements`\s*\)/],
          none: [/keys\(\s*['"]placement:\*['"]\s*\)/],
        },
        go: {
          all: [/func reconcileNode/, /SMembers\(\s*[^,]+,\s*"node:"\s*\+\s*nodeID\s*\+\s*":placements"\s*\)/],
          none: [/Keys\(\s*[^,]+,\s*"placement:\*"\s*\)/],
        },
        scala: {
          all: [/def reconcileNode/, /smembers\(\s*s"node:\$nodeId:placements"\s*\)/],
          none: [/keys\(\s*"placement:\*"\s*\)/],
        },
        cpp: {
          all: [/int reconcile_node/, /smembers\(\s*"node:"\s*\+\s*node_id\s*\+\s*":placements"\s*\)/],
          none: [/keys\(\s*"placement:\*"/],
        },
      },
    },
    {
      id: 'operator-scope',
      title: 'The scope comes from the bearer token, not from a header',
      detail:
        'The bearer token is looked up in `token:{token}` and its `scope` must be `operator`: 401 without a token, 403 for any other scope. The starter trusts an `X-Scope` header the client writes itself.',
      match: {
        python: {
          all: [/authorization/i, /f["']token:\{token\}["']/, /["']operator["']/, /status_code=403/, /status_code=401/],
          none: [/x-scope/i],
        },
        typescript: {
          all: [/authorization/i, /`token:\$\{token\}`/, /['"]operator['"]/, /code\(\s*403\s*\)/, /code\(\s*401\s*\)/],
          none: [/x-scope/i],
        },
        go: {
          all: [/"Authorization"/, /"token:"\s*\+\s*token/, /"operator"/, /StatusForbidden/, /StatusUnauthorized/],
          none: [/X-Scope/i],
        },
        scala: {
          all: [
            /Authorization/,
            /s"token:\$token"/,
            /"operator"/,
            /StatusCodes\.Forbidden/,
            /StatusCodes\.Unauthorized/,
          ],
          none: [/X-Scope/i],
        },
        cpp: {
          all: [/"Authorization"/, /"token:"\s*\+\s*token/, /"operator"/, /\b403\b/, /\b401\b/],
          none: [/X-Scope/i],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, HTTPException, Request

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

CACHE_TTL_S = 300
_allocated_cache: dict[str, tuple[float, int]] = {}


def allocated_gpus(node_id: str) -> int:
    """The node's allocated count, refreshed every CACHE_TTL_S: the dashboard polls this route hard."""
    cached = _allocated_cache.get(node_id)
    if cached is not None and time.monotonic() - cached[0] < CACHE_TTL_S:
        return cached[1]
    value = int(r.hget(f"node:{node_id}", "allocated") or 0)
    _allocated_cache[node_id] = (time.monotonic(), value)
    return value


def reconcile_node(node_id: str) -> int:
    """After a reboot: recompute allocated from the placement records; the new value."""
    total = 0
    for key in r.keys("placement:*"):
        record = r.hgetall(key)
        if record.get("node_id") == node_id:
            total += int(record.get("count", 0))
    r.hset(f"node:{node_id}", "allocated", total)
    return total


@app.get("/v1/nodes/{node_id}")
def read_node(node_id: str, request: Request) -> dict:
    if request.headers.get("x-scope") != "operator":
        raise HTTPException(status_code=403, detail="operators only")
    node = r.hgetall(f"node:{node_id}")
    if not node:
        raise HTTPException(status_code=404, detail="unknown node")
    capacity = int(node.get("capacity", 0))
    allocated = allocated_gpus(node_id)
    return {
        "node_id": node_id,
        "gpu_type": node.get("gpu_type"),
        "capacity": capacity,
        "allocated": allocated,
        "free": capacity - allocated,
        "placeable": capacity - allocated > 0,
        "alive": bool(r.exists(f"heartbeat:{node_id}")),
    }
`,
      solution: `import redis
from fastapi import FastAPI, HTTPException, Request

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def require_operator(request: Request) -> None:
    """The bearer token's scope, resolved in Redis: 401 without a token, 403 unless it is an operator's."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="operator token required")
    token = auth[len("Bearer ") :]
    if r.hget(f"token:{token}", "scope") != "operator":
        raise HTTPException(status_code=403, detail="operators only")


def reconcile_node(node_id: str) -> int:
    """After a reboot: recompute allocated from the open placements; the new value."""
    total = sum(int(r.hget(f"placement:{pid}", "count") or 0) for pid in r.smembers(f"node:{node_id}:placements"))
    r.hset(f"node:{node_id}", "allocated", total)
    return total


@app.get("/v1/nodes/{node_id}")
def read_node(node_id: str, request: Request) -> dict:
    require_operator(request)
    node = r.hgetall(f"node:{node_id}")
    if not node:
        raise HTTPException(status_code=404, detail="unknown node")
    capacity = int(node.get("capacity", 0))
    allocated = int(node.get("allocated", 0))
    free = max(capacity - allocated, 0)
    return {
        "node_id": node_id,
        "gpu_type": node.get("gpu_type"),
        "capacity": capacity,
        "allocated": allocated,
        "free": free,
        "placeable": free > 0,
        "alive": bool(r.exists(f"heartbeat:{node_id}")),
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

const CACHE_TTL_MS = 300_000;
const allocatedCache: Record<string, {at: number; value: number}> = {};

/** The node's allocated count, refreshed every CACHE_TTL_MS: the dashboard polls this route hard. */
async function allocatedGpus(nodeId: string): Promise<number> {
  const cached = allocatedCache[nodeId];
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = Number((await redis.hget(\`node:\${nodeId}\`, 'allocated')) ?? 0);
  allocatedCache[nodeId] = {at: Date.now(), value};
  return value;
}

/** After a reboot: recompute allocated from the placement records; the new value. */
export async function reconcileNode(nodeId: string): Promise<number> {
  let total = 0;
  for (const key of await redis.keys('placement:*')) {
    const record = await redis.hgetall(key);
    if (record.node_id === nodeId) total += Number(record.count ?? 0);
  }
  await redis.hset(\`node:\${nodeId}\`, 'allocated', total);
  return total;
}

app.get('/v1/nodes/:id', async (request, reply) => {
  if (request.headers['x-scope'] !== 'operator') return reply.code(403).send({error: 'operators only'});
  const {id: nodeId} = request.params as {id: string};
  const node = await redis.hgetall(\`node:\${nodeId}\`);
  if (Object.keys(node).length === 0) return reply.code(404).send({error: 'unknown node'});
  const capacity = Number(node.capacity ?? 0);
  const allocated = await allocatedGpus(nodeId);
  return {
    node_id: nodeId,
    gpu_type: node.gpu_type,
    capacity,
    allocated,
    free: capacity - allocated,
    placeable: capacity - allocated > 0,
    alive: (await redis.exists(\`heartbeat:\${nodeId}\`)) === 1,
  };
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

/** The bearer token's scope, resolved in Redis: 401 without a token, 403 unless it is an operator's. */
async function operatorStatus(authorization: string | undefined): Promise<number | null> {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return 401;
  const token = authorization.slice('Bearer '.length);
  return (await redis.hget(\`token:\${token}\`, 'scope')) === 'operator' ? null : 403;
}

/** After a reboot: recompute allocated from the open placements; the new value. */
export async function reconcileNode(nodeId: string): Promise<number> {
  let total = 0;
  for (const pid of await redis.smembers(\`node:\${nodeId}:placements\`)) total += Number((await redis.hget(\`placement:\${pid}\`, 'count')) ?? 0);
  await redis.hset(\`node:\${nodeId}\`, 'allocated', total);
  return total;
}

app.get('/v1/nodes/:id', async (request, reply) => {
  const refused = await operatorStatus(request.headers.authorization);
  if (refused === 401) return reply.code(401).send({error: 'operator token required'});
  if (refused === 403) return reply.code(403).send({error: 'operators only'});
  const {id: nodeId} = request.params as {id: string};
  const node = await redis.hgetall(\`node:\${nodeId}\`);
  if (Object.keys(node).length === 0) return reply.code(404).send({error: 'unknown node'});
  const capacity = Number(node.capacity ?? 0);
  const allocated = Number(node.allocated ?? 0);
  const free = Math.max(capacity - allocated, 0);
  return {
    node_id: nodeId,
    gpu_type: node.gpu_type,
    capacity,
    allocated,
    free,
    placeable: free > 0,
    alive: (await redis.exists(\`heartbeat:\${nodeId}\`)) === 1,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

const cacheTTL = 5 * time.Minute

type cachedCount struct {
	at    time.Time
	value int
}

var (
	cacheMu        sync.Mutex
	allocatedCache = map[string]cachedCount{}
)

// allocatedGPUs is the node's allocated count, refreshed every cacheTTL: the dashboard polls this route hard.
func allocatedGPUs(ctx context.Context, nodeID string) int {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if cached, ok := allocatedCache[nodeID]; ok && time.Since(cached.at) < cacheTTL {
		return cached.value
	}
	value, _ := rdb.HGet(ctx, "node:"+nodeID, "allocated").Int()
	allocatedCache[nodeID] = cachedCount{at: time.Now(), value: value}
	return value
}

// reconcileNode, after a reboot: recompute allocated from the placement records; the new value.
func reconcileNode(ctx context.Context, nodeID string) (int, error) {
	total := 0
	keys, err := rdb.Keys(ctx, "placement:*").Result()
	if err != nil {
		return 0, err
	}
	for _, key := range keys {
		record := rdb.HGetAll(ctx, key).Val()
		if record["node_id"] == nodeID {
			n, _ := strconv.Atoi(record["count"])
			total += n
		}
	}
	return total, rdb.HSet(ctx, "node:"+nodeID, "allocated", total).Err()
}

func readNode(rw http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Scope") != "operator" {
		http.Error(rw, "operators only", http.StatusForbidden)
		return
	}
	nodeID := r.PathValue("id")
	node := rdb.HGetAll(r.Context(), "node:"+nodeID).Val()
	if len(node) == 0 {
		http.Error(rw, "unknown node", http.StatusNotFound)
		return
	}
	capacity, _ := strconv.Atoi(node["capacity"])
	allocated := allocatedGPUs(r.Context(), nodeID)
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"node_id":   nodeID,
		"gpu_type":  node["gpu_type"],
		"capacity":  capacity,
		"allocated": allocated,
		"free":      capacity - allocated,
		"placeable": capacity-allocated > 0,
		"alive":     rdb.Exists(r.Context(), "heartbeat:"+nodeID).Val() == 1,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/nodes/{id}", readNode)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// operatorStatus is the bearer token's verdict, resolved in Redis: 401 without a token, 403 unless it is an operator's, 0 otherwise.
func operatorStatus(ctx context.Context, authorization string) int {
	if !strings.HasPrefix(authorization, "Bearer ") {
		return http.StatusUnauthorized
	}
	token := strings.TrimPrefix(authorization, "Bearer ")
	if rdb.HGet(ctx, "token:"+token, "scope").Val() != "operator" {
		return http.StatusForbidden
	}
	return 0
}

// reconcileNode, after a reboot: recompute allocated from the open placements; the new value.
func reconcileNode(ctx context.Context, nodeID string) (int, error) {
	ids, err := rdb.SMembers(ctx, "node:"+nodeID+":placements").Result()
	if err != nil {
		return 0, err
	}
	total := 0
	for _, pid := range ids {
		n, _ := rdb.HGet(ctx, "placement:"+pid, "count").Int()
		total += n
	}
	return total, rdb.HSet(ctx, "node:"+nodeID, "allocated", total).Err()
}

func readNode(rw http.ResponseWriter, r *http.Request) {
	if code := operatorStatus(r.Context(), r.Header.Get("Authorization")); code != 0 {
		http.Error(rw, "operators only", code)
		return
	}
	nodeID := r.PathValue("id")
	node := rdb.HGetAll(r.Context(), "node:"+nodeID).Val()
	if len(node) == 0 {
		http.Error(rw, "unknown node", http.StatusNotFound)
		return
	}
	capacity, _ := strconv.Atoi(node["capacity"])
	allocated, _ := strconv.Atoi(node["allocated"])
	free := max(capacity-allocated, 0)
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"node_id":   nodeID,
		"gpu_type":  node["gpu_type"],
		"capacity":  capacity,
		"allocated": allocated,
		"free":      free,
		"placeable": free > 0,
		"alive":     rdb.Exists(r.Context(), "heartbeat:"+nodeID).Val() == 1,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/nodes/{id}", readNode)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.collection.mutable
import scala.jdk.CollectionConverters._

object Read {
  val jedis = new JedisPooled("redis", 6379)

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

  val CacheTtlMillis = 300000L
  private val allocatedCache = mutable.Map.empty[String, (Long, Int)]

  /** The node's allocated count, refreshed every CacheTtlMillis: the dashboard polls this route hard. */
  private def allocatedGpus(nodeId: String): Int = allocatedCache.synchronized {
    allocatedCache.get(nodeId) match {
      case Some((at, value)) if System.currentTimeMillis() - at < CacheTtlMillis => value
      case _ =>
        val value = Option(jedis.hget(s"node:$nodeId", "allocated")).map(_.toInt).getOrElse(0)
        allocatedCache(nodeId) = (System.currentTimeMillis(), value)
        value
    }
  }

  /** After a reboot: recompute allocated from the placement records; the new value. */
  def reconcileNode(nodeId: String): Int = {
    val total = jedis.keys("placement:*").asScala.toList.map(jedis.hgetAll(_).asScala).filter(_.get("node_id").contains(nodeId)).map(_.get("count").map(_.toInt).getOrElse(0)).sum
    jedis.hset(s"node:$nodeId", "allocated", total.toString)
    total
  }

  val route: Route =
    path("v1" / "nodes" / Segment) { nodeId =>
      get {
        optionalHeaderValueByName("X-Scope") { scope =>
          if (!scope.contains("operator")) complete(StatusCodes.Forbidden -> "operators only")
          else {
            val node = jedis.hgetAll(s"node:$nodeId").asScala
            if (node.isEmpty) complete(StatusCodes.NotFound -> "unknown node")
            else {
              val capacity = node.get("capacity").map(_.toInt).getOrElse(0)
              val allocated = allocatedGpus(nodeId)
              val alive = jedis.exists(s"heartbeat:$nodeId")
              val json = s"""{"node_id":"$nodeId","gpu_type":"\${node.getOrElse("gpu_type", "")}","capacity":$capacity,"allocated":$allocated,"free":\${capacity - allocated},"placeable":\${capacity - allocated > 0},"alive":$alive}"""
              complete(HttpEntity(ContentTypes.\`application/json\`, json))
            }
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object Read {
  val jedis = new JedisPooled("redis", 6379)

  /** The bearer token's verdict, resolved in Redis: 401 without a token, 403 unless it is an operator's. */
  private def refused(authorization: Option[String]): Option[StatusCode] =
    authorization.filter(_.startsWith("Bearer ")) match {
      case None => Some(StatusCodes.Unauthorized)
      case Some(header) =>
        val token = header.stripPrefix("Bearer ")
        if (jedis.hget(s"token:$token", "scope") == "operator") None else Some(StatusCodes.Forbidden)
    }

  /** After a reboot: recompute allocated from the open placements; the new value. */
  def reconcileNode(nodeId: String): Int = {
    val total = jedis.smembers(s"node:$nodeId:placements").asScala.toList.map(pid => Option(jedis.hget(s"placement:$pid", "count")).map(_.toInt).getOrElse(0)).sum
    jedis.hset(s"node:$nodeId", "allocated", total.toString)
    total
  }

  val route: Route =
    path("v1" / "nodes" / Segment) { nodeId =>
      get {
        optionalHeaderValueByName("Authorization") { authorization =>
          refused(authorization) match {
            case Some(status) => complete(status -> "operators only")
            case None =>
              val node = jedis.hgetAll(s"node:$nodeId").asScala
              if (node.isEmpty) complete(StatusCodes.NotFound -> "unknown node")
              else {
                val capacity = node.get("capacity").map(_.toInt).getOrElse(0)
                val allocated = node.get("allocated").map(_.toInt).getOrElse(0)
                val free = math.max(capacity - allocated, 0)
                val alive = jedis.exists(s"heartbeat:$nodeId")
                val json = s"""{"node_id":"$nodeId","gpu_type":"\${node.getOrElse("gpu_type", "")}","capacity":$capacity,"allocated":$allocated,"free":$free,"placeable":\${free > 0},"alive":$alive}"""
                complete(HttpEntity(ContentTypes.\`application/json\`, json))
              }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <mutex>
#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

constexpr std::chrono::seconds kCacheTtl{300};

struct CachedCount {
  std::chrono::steady_clock::time_point at;
  int value;
};

std::mutex cache_mu;
std::map<std::string, CachedCount> allocated_cache;

// The node's allocated count, refreshed every kCacheTtl: the dashboard polls this route hard.
int allocated_gpus(const std::string& node_id) {
  std::lock_guard<std::mutex> lock(cache_mu);
  const auto cached = allocated_cache.find(node_id);
  if (cached != allocated_cache.end() && std::chrono::steady_clock::now() - cached->second.at < kCacheTtl) return cached->second.value;
  const auto raw = redis.hget("node:" + node_id, "allocated");
  const int value = raw ? std::stoi(*raw) : 0;
  allocated_cache[node_id] = {std::chrono::steady_clock::now(), value};
  return value;
}

// After a reboot: recompute allocated from the placement records; the new value.
int reconcile_node(const std::string& node_id) {
  int total = 0;
  for (const std::string& key : redis.keys("placement:*")) {
    const auto record = redis.hgetall(key);
    if (record.count("node_id") && record.at("node_id") == node_id && record.count("count")) total += std::stoi(record.at("count"));
  }
  redis.hset("node:" + node_id, "allocated", std::to_string(total));
  return total;
}

void read_node(const httplib::Request& req, httplib::Response& res) {
  if (req.get_header_value("X-Scope") != "operator") {
    res.status = 403;
    res.set_content("operators only", "text/plain");
    return;
  }
  const std::string node_id = req.matches[1].str();
  const auto node = redis.hgetall("node:" + node_id);
  if (node.empty()) {
    res.status = 404;
    res.set_content("unknown node", "text/plain");
    return;
  }
  const int capacity = node.count("capacity") ? std::stoi(node.at("capacity")) : 0;
  const int allocated = allocated_gpus(node_id);
  const json body = {{"node_id", node_id},
                     {"gpu_type", node.count("gpu_type") ? node.at("gpu_type") : ""},
                     {"capacity", capacity},
                     {"allocated", allocated},
                     {"free", capacity - allocated},
                     {"placeable", capacity - allocated > 0},
                     {"alive", redis.exists("heartbeat:" + node_id) == 1}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/nodes/([^/]+))", read_node); }
`,
      solution: `#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// The bearer token's verdict, resolved in Redis: 401 without a token, 403 unless it is an operator's, 0 otherwise.
int operator_status(const std::string& authorization) {
  const std::string prefix = "Bearer ";
  if (authorization.rfind(prefix, 0) != 0) return 401;
  const std::string token = authorization.substr(prefix.size());
  const auto scope = redis.hget("token:" + token, "scope");
  return scope && *scope == "operator" ? 0 : 403;
}

// After a reboot: recompute allocated from the open placements; the new value.
int reconcile_node(const std::string& node_id) {
  int total = 0;
  for (const std::string& pid : redis.smembers("node:" + node_id + ":placements")) {
    const auto count = redis.hget("placement:" + pid, "count");
    if (count) total += std::stoi(*count);
  }
  redis.hset("node:" + node_id, "allocated", std::to_string(total));
  return total;
}

void read_node(const httplib::Request& req, httplib::Response& res) {
  if (const int refused = operator_status(req.get_header_value("Authorization")); refused != 0) {
    res.status = refused;
    res.set_content(refused == 401 ? "operator token required" : "operators only", "text/plain");
    return;
  }
  const std::string node_id = req.matches[1].str();
  const auto node = redis.hgetall("node:" + node_id);
  if (node.empty()) {
    res.status = 404;
    res.set_content("unknown node", "text/plain");
    return;
  }
  const int capacity = node.count("capacity") ? std::stoi(node.at("capacity")) : 0;
  const int allocated = node.count("allocated") ? std::stoi(node.at("allocated")) : 0;
  const int free = std::max(capacity - allocated, 0);
  const json body = {{"node_id", node_id},
                     {"gpu_type", node.count("gpu_type") ? node.at("gpu_type") : ""},
                     {"capacity", capacity},
                     {"allocated", allocated},
                     {"free", free},
                     {"placeable", free > 0},
                     {"alive", redis.exists("heartbeat:" + node_id) == 1}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/nodes/([^/]+))", read_node); }
`,
    },
  },
  harness: {
    python: `# The operator console sends its bearer token; its older builds also send X-Scope, which the service must ignore.
OPERATOR = {"Authorization": "Bearer op-1", "X-Scope": "operator"}
TENANT = {"Authorization": "Bearer t-1", "X-Scope": "operator"}


def _world(ctx):
    ctx.redis.hset("token:op-1", mapping={"scope": "operator", "tenant": ""})
    ctx.redis.hset("token:t-1", mapping={"scope": "tenant", "tenant": "acme"})
    ctx.redis.hset("node:gpu-1", mapping={"gpu_type": "a100", "capacity": 8, "allocated": 0})
    ctx.redis.sadd("nodes", "gpu-1")
    ctx.redis.set("heartbeat:gpu-1", "1", ex=30)
    return ctx.load("read")


def _book(ctx, pid, count):
    """The ledger (step 2) books a placement on gpu-1."""
    ctx.redis.hincrby("node:gpu-1", "allocated", count)
    ctx.redis.hset(f"placement:{pid}", mapping={"node_id": "gpu-1", "count": count, "status": "allocated"})
    ctx.redis.sadd("node:gpu-1:placements", pid)


def _release(ctx, pid):
    count = int(ctx.redis.hget(f"placement:{pid}", "count"))
    ctx.redis.hincrby("node:gpu-1", "allocated", -count)
    ctx.redis.hset(f"placement:{pid}", "status", "released")
    ctx.redis.srem("node:gpu-1:placements", pid)


async def _get(ctx, m, node="gpu-1", headers=OPERATOR):
    async with ctx.client(m.app) as c:
        return await c.get(f"/v1/nodes/{node}", headers=headers)


async def check_node_route(ctx):
    m = _world(ctx)
    r = await _get(ctx, m)
    assert r.status_code == 200, f"GET /v1/nodes/gpu-1 as an operator answered {r.status_code}: {r.text}"
    body = r.json()
    expected = {"node_id": "gpu-1", "gpu_type": "a100", "capacity": 8, "allocated": 0, "free": 8, "placeable": True, "alive": True}
    for field, value in expected.items():
        assert body.get(field) == value, f"the answer was {body}: expected {field} = {value!r}"
    r = await _get(ctx, m, "gpu-9")
    assert r.status_code == 404, f"an unknown node answered {r.status_code}, expected 404"


async def check_atomic_capacity(ctx):
    m = _world(ctx)
    r = await _get(ctx, m)
    assert r.status_code == 200 and r.json().get("free") == 8, f"an idle node answered {r.status_code} {r.text}"
    _book(ctx, "p-1", 4)
    r = await _get(ctx, m)
    body = r.json()
    assert body.get("allocated") == 4 and body.get("free") == 4, f"right after the ledger booked 4 GPUs the read answered {body}: allocated must be read from node:gpu-1 on every request, not from a snapshot"
    _book(ctx, "p-2", 4)
    body = (await _get(ctx, m)).json()
    assert body.get("free") == 0 and body.get("placeable") is False, f"with the node full the read answered {body}"
    _release(ctx, "p-1")
    body = (await _get(ctx, m)).json()
    assert body.get("allocated") == 4 and body.get("free") == 4, f"after a release the read answered {body}"


async def check_free_clamp(ctx):
    m = _world(ctx)
    ctx.redis.hset("node:gpu-1", "allocated", 10)  # a counter that drifted past capacity
    body = (await _get(ctx, m)).json()
    assert body.get("allocated") == 10, f"the read must report allocated as the ledger holds it, got {body}"
    assert body.get("free") == 0, f"with allocated above capacity free must be 0, got {body.get('free')} (clamp at zero)"
    assert body.get("placeable") is False, f"a drifted node is not placeable, got {body}"


async def check_reconcile(ctx):
    m = _world(ctx)
    _book(ctx, "p-1", 4)
    _book(ctx, "p-2", 2)
    _release(ctx, "p-1")
    ctx.redis.hset("node:gpu-1", "allocated", 0)  # the node rebooted and its counter was lost
    total = m.reconcile_node("gpu-1")
    assert total == 2, f"reconcile_node summed {total} GPUs for gpu-1, expected 2: p-1 was released, only p-2 (2 GPUs) is open"
    assert ctx.redis.hget("node:gpu-1", "allocated") == "2", f"reconcile_node must write allocated, node:gpu-1 holds {ctx.redis.hget('node:gpu-1', 'allocated')}"
    body = (await _get(ctx, m)).json()
    assert body.get("allocated") == 2 and body.get("free") == 6, f"after the reconcile the read answered {body}"


async def check_operator_scope(ctx):
    m = _world(ctx)
    r = await _get(ctx, m, headers=TENANT)
    assert r.status_code == 403, f"a tenant's token (with an X-Scope: operator header it wrote itself) answered {r.status_code}, expected 403: the scope comes from token:{{token}}, not from the client"
    r = await _get(ctx, m, headers={"X-Scope": "operator"})
    assert r.status_code == 401, f"no token at all answered {r.status_code}, expected 401"
    r = await _get(ctx, m, headers={"Authorization": "Bearer nobody"})
    assert r.status_code == 403, f"an unknown token answered {r.status_code}, expected 403"
    r = await _get(ctx, m, headers={"Authorization": "Bearer op-1"})
    assert r.status_code == 200, f"an operator token without any X-Scope header answered {r.status_code}, expected 200"
`,
    typescript: `// The operator console sends its bearer token; its older builds also send X-Scope, which the service must ignore.
const OPERATOR = {Authorization: 'Bearer op-1', 'X-Scope': 'operator'};
const TENANT = {Authorization: 'Bearer t-1', 'X-Scope': 'operator'};

function world(ctx) {
  ctx.redis.hset('token:op-1', 'scope', 'operator', 'tenant', '');
  ctx.redis.hset('token:t-1', 'scope', 'tenant', 'tenant', 'acme');
  ctx.redis.hset('node:gpu-1', 'gpu_type', 'a100', 'capacity', 8, 'allocated', 0);
  ctx.redis.sadd('nodes', 'gpu-1');
  ctx.redis.set('heartbeat:gpu-1', '1', 'EX', 30);
  const m = ctx.load('read');
  const c = ctx.client(m.app);
  return {m, get: (node = 'gpu-1', headers: Record<string, string> = OPERATOR) => c.get(\`/v1/nodes/\${node}\`, {headers})};
}

/** The ledger (step 2) books a placement on gpu-1. */
function book(ctx, pid: string, count: number): void {
  ctx.redis.hincrby('node:gpu-1', 'allocated', count);
  ctx.redis.hset(\`placement:\${pid}\`, 'node_id', 'gpu-1', 'count', count, 'status', 'allocated');
  ctx.redis.sadd('node:gpu-1:placements', pid);
}

function releasePlacement(ctx, pid: string): void {
  const count = Number(ctx.redis.hget(\`placement:\${pid}\`, 'count'));
  ctx.redis.hincrby('node:gpu-1', 'allocated', -count);
  ctx.redis.hset(\`placement:\${pid}\`, 'status', 'released');
  ctx.redis.srem('node:gpu-1:placements', pid);
}

export async function check_node_route(ctx) {
  const {get} = world(ctx);
  let r = await get();
  assert.equal(r.status, 200, \`GET /v1/nodes/gpu-1 as an operator answered \${r.status}: \${r.text}\`);
  const body = r.json() as Record<string, unknown>;
  const expected = {node_id: 'gpu-1', gpu_type: 'a100', capacity: 8, allocated: 0, free: 8, placeable: true, alive: true};
  for (const [field, value] of Object.entries(expected)) assert.strictEqual(body[field], value, \`the answer was \${r.text}: \${field}\`);
  r = await get('gpu-9');
  assert.equal(r.status, 404, 'an unknown node');
}

export async function check_atomic_capacity(ctx) {
  const {get} = world(ctx);
  let r = await get();
  assert(r.status === 200 && (r.json() as {free: number}).free === 8, \`an idle node answered \${r.status} \${r.text}\`);
  book(ctx, 'p-1', 4);
  r = await get();
  let body = r.json() as Record<string, unknown>;
  assert(body.allocated === 4 && body.free === 4, \`right after the ledger booked 4 GPUs the read answered \${r.text}: allocated must be read from node:gpu-1 on every request, not from a snapshot\`);
  book(ctx, 'p-2', 4);
  r = await get();
  body = r.json() as Record<string, unknown>;
  assert(body.free === 0 && body.placeable === false, \`with the node full the read answered \${r.text}\`);
  releasePlacement(ctx, 'p-1');
  r = await get();
  body = r.json() as Record<string, unknown>;
  assert(body.allocated === 4 && body.free === 4, \`after a release the read answered \${r.text}\`);
}

export async function check_free_clamp(ctx) {
  const {get} = world(ctx);
  ctx.redis.hset('node:gpu-1', 'allocated', 10); // a counter that drifted past capacity
  const r = await get();
  const body = r.json() as Record<string, unknown>;
  assert.equal(body.allocated, 10, \`the read must report allocated as the ledger holds it, got \${r.text}\`);
  assert.equal(body.free, 0, 'with allocated above capacity free (clamp at zero)');
  assert.equal(body.placeable, false, \`a drifted node is not placeable, got \${r.text}\`);
}

export async function check_reconcile(ctx) {
  const {m, get} = world(ctx);
  book(ctx, 'p-1', 4);
  book(ctx, 'p-2', 2);
  releasePlacement(ctx, 'p-1');
  ctx.redis.hset('node:gpu-1', 'allocated', 0); // the node rebooted and its counter was lost
  const total = await m.reconcileNode('gpu-1');
  assert.equal(total, 2, 'GPUs reconcileNode summed for gpu-1: p-1 was released, only p-2 (2 GPUs) is open');
  assert.equal(ctx.redis.hget('node:gpu-1', 'allocated'), '2', 'reconcileNode must write allocated; node:gpu-1 holds');
  const r = await get();
  const body = r.json() as Record<string, unknown>;
  assert(body.allocated === 2 && body.free === 6, \`after the reconcile the read answered \${r.text}\`);
}

export async function check_operator_scope(ctx) {
  const {get} = world(ctx);
  let r = await get('gpu-1', TENANT);
  assert.equal(r.status, 403, "a tenant's token (with an X-Scope: operator header it wrote itself): the scope comes from token:{token}, not from the client");
  r = await get('gpu-1', {'X-Scope': 'operator'});
  assert.equal(r.status, 401, 'no token at all');
  r = await get('gpu-1', {Authorization: 'Bearer nobody'});
  assert.equal(r.status, 403, 'an unknown token');
  r = await get('gpu-1', {Authorization: 'Bearer op-1'});
  assert.equal(r.status, 200, 'an operator token without any X-Scope header');
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strconv"

	"leetbuild/harness"
)

// The operator console sends its bearer token; its older builds also send X-Scope, which the service must ignore.
var (
	readOperator = []string{"Authorization", "Bearer op-1", "X-Scope", "operator"}
	readTenant   = []string{"Authorization", "Bearer t-1", "X-Scope", "operator"}
)

func readWorld(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Do("HSET", "token:op-1", "scope", "operator", "tenant", "")
	ctx.Redis.Do("HSET", "token:t-1", "scope", "tenant", "tenant", "acme")
	ctx.Redis.Do("HSET", "node:gpu-1", "gpu_type", "a100", "capacity", 8, "allocated", 0)
	ctx.Redis.Do("SADD", "nodes", "gpu-1")
	ctx.Redis.Do("SET", "heartbeat:gpu-1", "1", "EX", 30)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// readBook: the ledger (step 2) books a placement on gpu-1.
func readBook(ctx *harness.Ctx, pid string, count int) {
	ctx.Redis.Do("HINCRBY", "node:gpu-1", "allocated", count)
	ctx.Redis.Do("HSET", "placement:"+pid, "node_id", "gpu-1", "count", count, "status", "allocated")
	ctx.Redis.Do("SADD", "node:gpu-1:placements", pid)
}

func readRelease(ctx *harness.Ctx, pid string) {
	count, _ := ctx.Redis.HGet("placement:"+pid, "count")
	n, _ := strconv.Atoi(count)
	ctx.Redis.Do("HINCRBY", "node:gpu-1", "allocated", -n)
	ctx.Redis.Do("HSET", "placement:"+pid, "status", "released")
	ctx.Redis.Do("SREM", "node:gpu-1:placements", pid)
}

func readGet(c *harness.HTTP, node string, header []string) *harness.Response {
	return c.Get("/v1/nodes/"+node, header...)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the answer must be a JSON object, got %s", r.Text())
	return body
}

func CheckNodeRoute(ctx *harness.Ctx) {
	c := readWorld(ctx)
	r := readGet(c, "gpu-1", readOperator)
	ctx.Equal(r.Status, 200, "GET /v1/nodes/gpu-1 as an operator (%s)", r.Text())
	body := readBody(ctx, r)
	for field, want := range map[string]any{"node_id": "gpu-1", "gpu_type": "a100", "capacity": 8, "allocated": 0, "free": 8, "placeable": true, "alive": true} {
		ctx.Equal(body[field], want, "the answer was %s: %s", r.Text(), field)
	}
	r = readGet(c, "gpu-9", readOperator)
	ctx.Equal(r.Status, 404, "an unknown node")
}

func CheckAtomicCapacity(ctx *harness.Ctx) {
	c := readWorld(ctx)
	r := readGet(c, "gpu-1", readOperator)
	ctx.Assert(r.Status == 200 && readBody(ctx, r)["free"] == float64(8), "an idle node answered %d %s", r.Status, r.Text())
	readBook(ctx, "p-1", 4)
	r = readGet(c, "gpu-1", readOperator)
	body := readBody(ctx, r)
	ctx.Assert(body["allocated"] == float64(4) && body["free"] == float64(4), "right after the ledger booked 4 GPUs the read answered %s: allocated must be read from node:gpu-1 on every request, not from a snapshot", r.Text())
	readBook(ctx, "p-2", 4)
	r = readGet(c, "gpu-1", readOperator)
	body = readBody(ctx, r)
	ctx.Assert(body["free"] == float64(0) && body["placeable"] == false, "with the node full the read answered %s", r.Text())
	readRelease(ctx, "p-1")
	r = readGet(c, "gpu-1", readOperator)
	body = readBody(ctx, r)
	ctx.Assert(body["allocated"] == float64(4) && body["free"] == float64(4), "after a release the read answered %s", r.Text())
}

func CheckFreeClamp(ctx *harness.Ctx) {
	c := readWorld(ctx)
	ctx.Redis.Do("HSET", "node:gpu-1", "allocated", 10) // a counter that drifted past capacity
	r := readGet(c, "gpu-1", readOperator)
	body := readBody(ctx, r)
	ctx.Equal(body["allocated"], 10, "the read must report allocated as the ledger holds it (%s)", r.Text())
	ctx.Equal(body["free"], 0, "with allocated above capacity free (clamp at zero)")
	ctx.Equal(body["placeable"], false, "a drifted node is not placeable (%s)", r.Text())
}

func CheckReconcile(ctx *harness.Ctx) {
	c := readWorld(ctx)
	readBook(ctx, "p-1", 4)
	readBook(ctx, "p-2", 2)
	readRelease(ctx, "p-1")
	ctx.Redis.Do("HSET", "node:gpu-1", "allocated", 0) // the node rebooted and its counter was lost
	total, err := reconcileNode(context.Background(), "gpu-1")
	ctx.NoError(err, "reconcileNode")
	ctx.Equal(total, 2, "GPUs reconcileNode summed for gpu-1: p-1 was released, only p-2 (2 GPUs) is open")
	allocated, _ := ctx.Redis.HGet("node:gpu-1", "allocated")
	ctx.Equal(allocated, "2", "reconcileNode must write allocated; node:gpu-1 holds")
	r := readGet(c, "gpu-1", readOperator)
	body := readBody(ctx, r)
	ctx.Assert(body["allocated"] == float64(2) && body["free"] == float64(6), "after the reconcile the read answered %s", r.Text())
}

func CheckOperatorScope(ctx *harness.Ctx) {
	c := readWorld(ctx)
	r := readGet(c, "gpu-1", readTenant)
	ctx.Equal(r.Status, 403, "a tenant's token (with an X-Scope: operator header it wrote itself): the scope comes from token:{token}, not from the client")
	r = readGet(c, "gpu-1", []string{"X-Scope", "operator"})
	ctx.Equal(r.Status, 401, "no token at all")
	r = readGet(c, "gpu-1", []string{"Authorization", "Bearer nobody"})
	ctx.Equal(r.Status, 403, "an unknown token")
	r = readGet(c, "gpu-1", []string{"Authorization", "Bearer op-1"})
	ctx.Equal(r.Status, 200, "an operator token without any X-Scope header")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

struct ReadWorld {
  httplib::Server svr;
};

ReadWorld* readWorld_ = nullptr;

harness::HTTP readWorld(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "token:op-1", "scope", "operator", "tenant", "");
  ctx.Redis.Do("HSET", "token:t-1", "scope", "tenant", "tenant", "acme");
  ctx.Redis.Do("HSET", "node:gpu-1", "gpu_type", "a100", "capacity", 8, "allocated", 0);
  ctx.Redis.Do("SADD", "nodes", "gpu-1");
  ctx.Redis.Do("SET", "heartbeat:gpu-1", "1", "EX", 30);
  delete readWorld_;
  readWorld_ = new ReadWorld;
  register_routes(readWorld_->svr);
  return ctx.HTTP(readWorld_->svr);
}

// The ledger (step 2) books a placement on gpu-1.
void readBook(harness::Ctx& ctx, const std::string& pid, int count) {
  ctx.Redis.Do("HINCRBY", "node:gpu-1", "allocated", count);
  ctx.Redis.Do("HSET", "placement:" + pid, "node_id", "gpu-1", "count", count, "status", "allocated");
  ctx.Redis.Do("SADD", "node:gpu-1:placements", pid);
}

void readRelease(harness::Ctx& ctx, const std::string& pid) {
  const int count = std::stoi(ctx.Redis.HGet("placement:" + pid, "count").value_or("0"));
  ctx.Redis.Do("HINCRBY", "node:gpu-1", "allocated", -count);
  ctx.Redis.Do("HSET", "placement:" + pid, "status", "released");
  ctx.Redis.Do("SREM", "node:gpu-1:placements", pid);
}

// The operator console sends its bearer token; its older builds also send X-Scope, which the service must ignore.
harness::Response readAsOperator(harness::HTTP& c, const std::string& node = "gpu-1") {
  return c.Get("/v1/nodes/" + node, "Authorization", "Bearer op-1", "X-Scope", "operator");
}

nlohmann::json readBody(harness::Ctx& ctx, const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the answer must be a JSON object, got %s", r.Text());
  return body;
}

}  // namespace

void CheckNodeRoute(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  auto r = readAsOperator(c);
  ctx.Equal(r.Status, 200, "GET /v1/nodes/gpu-1 as an operator (%s)", r.Text());
  const auto body = readBody(ctx, r);
  ctx.Equal(body.value("node_id", ""), "gpu-1", "the answer was %s: node_id", r.Text());
  ctx.Equal(body.value("gpu_type", ""), "a100", "the answer was %s: gpu_type", r.Text());
  ctx.Equal(body.value("capacity", -1), 8, "the answer was %s: capacity", r.Text());
  ctx.Equal(body.value("allocated", -1), 0, "the answer was %s: allocated", r.Text());
  ctx.Equal(body.value("free", -1), 8, "the answer was %s: free", r.Text());
  ctx.Equal(body.value("placeable", false), true, "the answer was %s: placeable", r.Text());
  ctx.Equal(body.value("alive", false), true, "the answer was %s: alive", r.Text());
  r = readAsOperator(c, "gpu-9");
  ctx.Equal(r.Status, 404, "an unknown node");
}

void CheckAtomicCapacity(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  auto r = readAsOperator(c);
  ctx.Assert(r.Status == 200 && readBody(ctx, r).value("free", -1) == 8, "an idle node answered %d %s", r.Status, r.Text());
  readBook(ctx, "p-1", 4);
  r = readAsOperator(c);
  auto body = readBody(ctx, r);
  ctx.Assert(body.value("allocated", -1) == 4 && body.value("free", -1) == 4,
             "right after the ledger booked 4 GPUs the read answered %s: allocated must be read from node:gpu-1 on every request, not from a snapshot", r.Text());
  readBook(ctx, "p-2", 4);
  r = readAsOperator(c);
  body = readBody(ctx, r);
  ctx.Assert(body.value("free", -1) == 0 && body.value("placeable", true) == false, "with the node full the read answered %s", r.Text());
  readRelease(ctx, "p-1");
  r = readAsOperator(c);
  body = readBody(ctx, r);
  ctx.Assert(body.value("allocated", -1) == 4 && body.value("free", -1) == 4, "after a release the read answered %s", r.Text());
}

void CheckFreeClamp(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  ctx.Redis.Do("HSET", "node:gpu-1", "allocated", 10);  // a counter that drifted past capacity
  auto r = readAsOperator(c);
  const auto body = readBody(ctx, r);
  ctx.Equal(body.value("allocated", -1), 10, "the read must report allocated as the ledger holds it (%s)", r.Text());
  ctx.Equal(body.value("free", -1), 0, "with allocated above capacity free (clamp at zero)");
  ctx.Equal(body.value("placeable", true), false, "a drifted node is not placeable (%s)", r.Text());
}

void CheckReconcile(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  readBook(ctx, "p-1", 4);
  readBook(ctx, "p-2", 2);
  readRelease(ctx, "p-1");
  ctx.Redis.Do("HSET", "node:gpu-1", "allocated", 0);  // the node rebooted and its counter was lost
  const int total = reconcile_node("gpu-1");
  ctx.Equal(total, 2, "GPUs reconcile_node summed for gpu-1: p-1 was released, only p-2 (2 GPUs) is open");
  ctx.Equal(ctx.Redis.HGet("node:gpu-1", "allocated"), "2", "reconcile_node must write allocated; node:gpu-1 holds");
  auto r = readAsOperator(c);
  const auto body = readBody(ctx, r);
  ctx.Assert(body.value("allocated", -1) == 2 && body.value("free", -1) == 6, "after the reconcile the read answered %s", r.Text());
}

void CheckOperatorScope(harness::Ctx& ctx) {
  auto c = readWorld(ctx);
  auto r = c.Get("/v1/nodes/gpu-1", "Authorization", "Bearer t-1", "X-Scope", "operator");
  ctx.Equal(r.Status, 403, "a tenant's token (with an X-Scope: operator header it wrote itself): the scope comes from token:{token}, not from the client");
  r = c.Get("/v1/nodes/gpu-1", "X-Scope", "operator");
  ctx.Equal(r.Status, 401, "no token at all");
  r = c.Get("/v1/nodes/gpu-1", "Authorization", "Bearer nobody");
  ctx.Equal(r.Status, 403, "an unknown token");
  r = c.Get("/v1/nodes/gpu-1", "Authorization", "Bearer op-1");
  ctx.Equal(r.Status, 200, "an operator token without any X-Scope header");
}
`,
  },
  debrief: `A read path is honest when it reads what the writer wrote: the same hash, now, with no snapshot in between, because the ledger's script is the only thing that moves \`allocated\` and any copy of it is stale the moment a placement lands. The clamp exists for the day the counter drifts, which a reconcile is the cure for; reconciling over the set the release script maintains, rather than over every record ever written, is what makes the cure match the ledger's own definition of open. The scope lives in Redis under the token because a header is the client's claim and a token lookup is the service's knowledge. Production node views paginate the open placements and serve the fleet summary from a replica, with the per-node read reserved for the operator who is about to drain one.`,
};
