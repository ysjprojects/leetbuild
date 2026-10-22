import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/placements: a request the scheduler can actually satisfy',
  concept: 'http',
  file: 'api',
  focus: ['client', 'scheduler', 'registry', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers \`POST /v1/placements\`,
parses the body and answers with a node. It compiles, it places the demo job, and it hides four
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/placements\` with body
\`{"gpu_type": "a100", "count": 4, "memory_gb": 80, "max_hourly_bid": 3.5}\`.

- \`gpu_type\` must be one of the known types — \`a100\`, \`h100\`, \`l40s\` — and anything else is
  **400**. The draft treats an unlisted type as *whatever is free*, so a typo silently lands a job on
  an arbitrary node instead of failing the caller.
- \`count\` must be a positive integer (**400** otherwise) and must not exceed the largest node's
  capacity — the constant is \`MAX_NODE_GPUS\` (**8** here). A request no node can ever satisfy is
  rejected **before** the placement is queued: queueing it first leaves work that can never start.
- \`memory_gb\` and \`max_hourly_bid\` must be numbers (**400** otherwise).
- Capacity is read from the node registry **once per request** (\`node_registry.list_nodes()\`) and the
  read carries a \`capacity_as_of\` timestamp. A snapshot older than \`CAPACITY_TTL_S\` is marked stale
  (**503 \`STALE_CAPACITY\`**) instead of being trusted. The draft schedules against \`BOOT_CAPACITY\`,
  the snapshot loaded while the process booted, so a node that filled up an hour ago still looks empty.
- The placement decision is logged with the placement id, the node id and the counters
  (\`count\`, \`free\`) — never with the request body. A GPU request carries tenant payloads, and the
  log pipeline outlives the request.
- A placed request answers **201** with \`placement_id\`, \`node_id\`, \`free\` and \`capacity_as_of\`;
  when nothing fits, **409**.

**Failure mode the checks target.** An unlisted type falling back to "whatever is free" turns a
typo into a placement on a machine that cannot run the job; an uncapped \`count\` queues a request
that no node can satisfy, so it occupies the queue forever; a boot-time capacity snapshot goes stale
the moment a node fills up, and the scheduler keeps offering GPUs that are already allocated to
someone else. The logged request body is the quiet one: it ships tenant content, memory footprints
and bids into the log pipeline on every placement.`,
  sequence: {
    participants: ['Client', 'GPU Scheduler', 'node registry'],
    messages: [
      {
        from: 'Client',
        to: 'GPU Scheduler',
        label: 'POST /v1/placements · {gpu_type, count, memory_gb, max_hourly_bid}',
        kind: 'sync',
      },
      {
        from: 'GPU Scheduler',
        to: 'GPU Scheduler',
        label: 'validate: known gpu_type · count ≥ 1 · count ≤ MAX_NODE_GPUS',
        kind: 'sync',
      },
      {
        from: 'GPU Scheduler',
        to: 'node registry',
        label: 'list_nodes() · fresh capacity + capacity_as_of',
        kind: 'sync',
      },
      {from: 'node registry', to: 'GPU Scheduler', label: '{nodes, capacity_as_of}', kind: 'reply'},
      {
        from: 'GPU Scheduler',
        to: 'GPU Scheduler',
        label: 'queue placement · log node id + counters, never the body',
        kind: 'sync',
      },
      {
        from: 'GPU Scheduler',
        to: 'Client',
        label: '201 {placement_id, node_id, free} · 400 unknown type / impossible count · 503 stale',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Validate the body shape yourself, in cost order, before any registry work: parse the JSON, then `gpu_type`, `count`, `memory_gb`, `max_hourly_bid`. Every failure returns **400** — a count of `0`, `2.5` or `"four"` is never a placement.',
    'The type whitelist and the capacity ceiling are different guards. `KNOWN_GPU_TYPES` answers "does this GPU type exist at all?" and `MAX_NODE_GPUS` answers "could any node ever hold this many?" Both must run **before** `enqueue`: a queued request that can never start is worse than a rejection, because no one will ever notice it.',
    "Drop the boot snapshot. Read `node_registry.list_nodes()` on every request and carry its `capacity_as_of` with the decision; when the read is older than `CAPACITY_TTL_S`, answer **503** instead of scheduling from memory. And keep the log line to ids and counters — the request body is the tenant's, and their bid is not yours to retain.",
  ],
  checks: [
    {
      id: 'route-shape',
      title: 'Registers POST /v1/placements and validates the body shape',
      detail:
        'The route is registered on `POST /v1/placements`, `gpu_type` is checked against the known types, `count` against a positive-integer helper, and `memory_gb` / `max_hourly_bid` against a number helper — each rejection a **400**. The draft accepts any value the JSON parser tolerates, so `count: 0` or a missing bid reaches the queue.',
      match: {
        python: {
          all: [
            /@app\.post\(\s*["']\/v1\/placements["']/,
            /KNOWN_GPU_TYPES/,
            /is_positive_int\(/,
            /is_number\(/,
            /status_code=400/,
          ],
        },
        typescript: {
          all: [
            /app\.post\(\s*['"]\/v1\/placements['"]/,
            /KNOWN_GPU_TYPES/,
            /isPositiveInt\(/,
            /isFiniteNumber\(/,
            /code\(\s*400\s*\)/,
          ],
        },
        go: {
          all: [/"POST \/v1\/placements"/, /knownGpuTypes/, /isPositiveInt\(/, /isFiniteNumber\(/, /StatusBadRequest/],
        },
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"placements"\s*\)/,
            /\bpost\s*\{/,
            /KnownGpuTypes/,
            /isPositiveInt\(/,
            /isFiniteNumber\(/,
            /StatusCodes\.BadRequest/,
          ],
        },
        cpp: {
          all: [/svr\.Post\(\s*"\/v1\/placements"/, /kKnownGpuTypes/, /isPositiveInt\(/, /isFiniteNumber\(/, /\b400\b/],
        },
      },
    },
    {
      id: 'unknown-type',
      title: 'Rejects an unknown GPU type with 400 before queueing',
      detail:
        'An unknown `gpu_type` is a **400** raised before the placement is enqueued, and the order is the point: a fallback to "whatever is free" sends a typo to a node that cannot run the job, and queueing before the check makes the rejection impossible. The draft picks the first node it finds instead.',
      match: {
        python: {
          all: [/status_code=400/],
          order: [/gpu_type not in KNOWN_GPU_TYPES/, /\benqueue\(/],
        },
        typescript: {
          all: [/code\(\s*400\s*\)/],
          order: [/KNOWN_GPU_TYPES\[gpuType\] !== true/, /\benqueue\(/],
        },
        go: {
          all: [/StatusBadRequest/],
          order: [/!knownGpuTypes\[gpuType\]/, /\bEnqueue\(/],
        },
        scala: {
          all: [/StatusCodes\.BadRequest/],
          order: [/!KnownGpuTypes\.contains/, /\.enqueue\(/],
        },
        cpp: {
          all: [/\b400\b/],
          order: [/kKnownGpuTypes\.count/, /\benqueue\(/],
        },
      },
    },
    {
      id: 'capacity-ceiling',
      title: 'Rejects a count above the largest node before queueing',
      detail:
        '`count` is compared against the per-node ceiling (`MAX_NODE_GPUS` / `maxNodeGpus` / `MaxNodeGpus` / `kMaxNodeGpus`) and the rejection happens before `enqueue`. A request that exceeds every node is unsatisfiable, so queueing it first leaves permanent backlog. The draft never looks at the number.',
      match: {
        python: {all: [/status_code=400/], order: [/count > MAX_NODE_GPUS/, /\benqueue\(/]},
        typescript: {all: [/code\(\s*400\s*\)/], order: [/count > MAX_NODE_GPUS/, /\benqueue\(/]},
        go: {all: [/StatusBadRequest/], order: [/countInt > maxNodeGpus/, /\bEnqueue\(/]},
        scala: {all: [/StatusCodes\.BadRequest/], order: [/body\.count > MaxNodeGpus/, /\.enqueue\(/]},
        cpp: {all: [/\b400\b/], order: [/count > kMaxNodeGpus/, /\benqueue\(/]},
      },
    },
    {
      id: 'fresh-capacity',
      title: 'Reads capacity fresh per request, with the boot snapshot gone',
      detail:
        "Every request reads the registry live (`node_registry.list_nodes()` / `nodeRegistry.list()` / `nodeRegistry.ListNodes()` / `nodeRegistry.list()`) and keeps the read's `capacity_as_of` timestamp, so a stale snapshot can be detected (`CAPACITY_TTL_S` / `CAPACITY_TTL_MS` / `capacityTtlSec` / `CapacityTtlSeconds` / `kCapacityTtlSeconds`) rather than trusted. The draft schedules from `BOOT_CAPACITY` — a snapshot taken at boot — which any later allocation invalidates.",
      match: {
        python: {
          all: [/node_registry\.list_nodes\(\)/, /capacity_as_of/, /CAPACITY_TTL_S/],
          none: [/BOOT_CAPACITY|cached_nodes/],
        },
        typescript: {
          all: [/nodeRegistry\.list\(\)/, /capacityAsOf/, /CAPACITY_TTL_MS/],
          none: [/BOOT_CAPACITY|cachedNodes/],
        },
        go: {
          all: [/nodeRegistry\.ListNodes\(\)/, /CapacityAsOf/, /capacityTtlSec/],
          none: [/bootCapacity|cachedNodes/],
        },
        scala: {
          all: [/nodeRegistry\.list\(\)/, /capacityAsOf/, /CapacityTtlSeconds/],
          none: [/BootCapacity|CachedNodes/],
        },
        cpp: {
          all: [/nodeRegistry\.list\(\)/, /capacityAsOf/, /kCapacityTtlSeconds/],
          none: [/kBootCapacity|cachedNodes/],
        },
      },
    },
    {
      id: 'log-no-payload',
      title: 'Logs the placement with node id and counters, never the body',
      detail:
        "The placement decision is logged with the placement id, the node id and the counters. The request body never reaches a log line: the draft logs it verbatim, shipping the tenant's memory footprint and hourly bid into every log sink, where it outlives the request and the retention policy.",
      match: {
        python: {
          all: [/logger\.info\(/, /node_id/],
          none: [/logger\.\w+\([^)]*\bbody\b/, /logger\.\w+\([^)]*max_hourly_bid/],
        },
        typescript: {
          all: [/request\.log\.info\(/, /nodeId/],
          none: [/\.info\([^)]*\bbody\b/, /\.info\([^)]*max_hourly_bid/],
        },
        go: {all: [/log\.Printf\(/, /nodeID/], none: [/log\.\w+\([^)]*\bbody\b/, /log\.\w+\([^)]*MaxHourlyBid/]},
        scala: {all: [/system\.log\.info\(/, /nodeId/], none: [/\.info\([^)]*\bbody\b/, /\.info\([^)]*max_hourly_bid/]},
        cpp: {
          all: [/(std::)?(cerr|clog)\s*<</, /nodeId/],
          none: [/(std::)?(cerr|clog)[^;]*\bbody\b/, /(std::)?(cerr|clog)[^;]*max_hourly_bid/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("gpusched")

# Capacity is loaded once while the service boots.
BOOT_CAPACITY = load_boot_capacity()


class PlacementRequest(BaseModel):
    gpu_type: str
    count: int
    memory_gb: float
    max_hourly_bid: float


class NodeRegistry:
    def enqueue(self, placement: dict, node: dict) -> str:
        """Queue the placement for \`node\`; returns the placement id."""
        raise NotImplementedError


node_registry = NodeRegistry()


@app.post("/v1/placements")
def place(body: PlacementRequest) -> JSONResponse:
    # TODO: this draft accepts any count, treats an unlisted gpu_type as whatever is free, places
    # against the capacity snapshot taken at boot, and logs the request body. Review all four.
    node = next((n for n in BOOT_CAPACITY if n["gpu_type"] == body.gpu_type), BOOT_CAPACITY[0])
    placement_id = node_registry.enqueue(body.model_dump(), node)
    logger.info("placement queued payload=%r", body.model_dump())
    return JSONResponse(
        {"placement_id": placement_id, "node_id": node["id"], "status": "queued"}, status_code=201
    )
`,
      solution: `import logging
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("gpusched")

KNOWN_GPU_TYPES = {"a100", "h100", "l40s"}
MAX_NODE_GPUS = 8
CAPACITY_TTL_S = 2


def is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class NodeRegistry:
    def list_nodes(self) -> dict:
        """Every schedulable node plus when its capacity was read: {"nodes", "capacity_as_of"}."""
        raise NotImplementedError

    def enqueue(self, placement: dict, node: dict) -> str:
        """Queue the placement for \`node\`; returns the placement id."""
        raise NotImplementedError


node_registry = NodeRegistry()


@app.post("/v1/placements")
async def place(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="malformed JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")

    gpu_type = body.get("gpu_type")
    if not isinstance(gpu_type, str) or gpu_type not in KNOWN_GPU_TYPES:
        raise HTTPException(status_code=400, detail="unknown gpu_type")
    count = body.get("count")
    if not is_positive_int(count):
        raise HTTPException(status_code=400, detail="count must be a positive integer")
    if not is_number(body.get("memory_gb")):
        raise HTTPException(status_code=400, detail="memory_gb must be a number")
    if not is_number(body.get("max_hourly_bid")):
        raise HTTPException(status_code=400, detail="max_hourly_bid must be a number")
    if count > MAX_NODE_GPUS:
        raise HTTPException(status_code=400, detail="count exceeds the largest node")

    snapshot = node_registry.list_nodes()
    capacity_as_of = snapshot["capacity_as_of"]
    if time.time() - capacity_as_of > CAPACITY_TTL_S:
        raise HTTPException(status_code=503, detail="STALE_CAPACITY")

    best = None
    for node in snapshot["nodes"]:
        if node["gpu_type"] != gpu_type or node["free"] < count:
            continue
        if best is None or node["free"] > best["free"]:
            best = node
    if best is None:
        return JSONResponse({"error": "no node with enough free capacity"}, status_code=409)

    placement = {
        "gpu_type": gpu_type,
        "count": count,
        "memory_gb": body["memory_gb"],
        "max_hourly_bid": body["max_hourly_bid"],
        "node_id": best["id"],
    }
    node_id = best["id"]
    placement_id = node_registry.enqueue(placement, best)
    logger.info(
        "placed id=%s node=%s gpu_type=%s count=%d free=%d capacity_as_of=%s",
        placement_id,
        node_id,
        gpu_type,
        count,
        best["free"],
        capacity_as_of,
    )
    return JSONResponse(
        {
            "placement_id": placement_id,
            "node_id": node_id,
            "free": best["free"],
            "capacity_as_of": capacity_as_of,
        },
        status_code=201,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/placements: a model-generated draft that trusts a boot-time capacity snapshot. */
import Fastify from 'fastify';

export const app = Fastify();

/** Capacity snapshot taken once while the service boots. */
const BOOT_CAPACITY = loadBootCapacity();

interface NodeRecord {
  id: string;
  gpuType: string;
  free: number;
}

const nodeRegistry = {
  async enqueue(placement: Record<string, unknown>, node: NodeRecord): Promise<string> {
    void placement;
    void node;
    throw new Error('NotImplemented');
  },
};

app.post('/v1/placements', async (request, reply) => {
  // TODO: this draft accepts any count, treats an unlisted gpu_type as whatever is free, places
  // against the capacity snapshot taken at boot, and logs the request body. Review all four.
  const body = request.body as Record<string, unknown>;
  const node =
    BOOT_CAPACITY.find(candidate => candidate.gpuType === body.gpu_type) ?? BOOT_CAPACITY[0];
  const placementId = await nodeRegistry.enqueue({...body, node_id: node.id}, node);
  request.log.info({payload: body}, 'placement queued');
  return reply.code(201).send({placement_id: placementId, node_id: node.id, status: 'queued'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/placements: validated admission, fresh capacity, and a log without the payload. */
import Fastify from 'fastify';

export const app = Fastify();

const KNOWN_GPU_TYPES: Record<string, true> = {a100: true, h100: true, l40s: true};
const MAX_NODE_GPUS = 8;
const CAPACITY_TTL_MS = 2000;

interface NodeRecord {
  id: string;
  gpuType: string;
  free: number;
}

interface NodeSnapshot {
  nodes: NodeRecord[];
  capacityAsOf: number;
}

/** The node registry: read live per request, and queue a placement on the chosen node. */
const nodeRegistry = {
  async list(): Promise<NodeSnapshot> {
    throw new Error('NotImplemented');
  },
  async enqueue(placement: Record<string, unknown>, node: NodeRecord): Promise<string> {
    void placement;
    void node;
    throw new Error('NotImplemented');
  },
};

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

app.post('/v1/placements', async (request, reply) => {
  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== 'object')
    return reply.code(400).send({error: 'body must be a JSON object'});

  const gpuType = body.gpu_type;
  if (typeof gpuType !== 'string' || KNOWN_GPU_TYPES[gpuType] !== true)
    return reply.code(400).send({error: 'unknown gpu_type'});
  const count = body.count;
  if (!isPositiveInt(count)) return reply.code(400).send({error: 'count must be a positive integer'});
  if (!isFiniteNumber(body.memory_gb)) return reply.code(400).send({error: 'memory_gb must be a number'});
  if (!isFiniteNumber(body.max_hourly_bid))
    return reply.code(400).send({error: 'max_hourly_bid must be a number'});
  if (count > MAX_NODE_GPUS) return reply.code(400).send({error: 'count exceeds the largest node'});

  const {nodes, capacityAsOf} = await nodeRegistry.list();
  if (Date.now() - capacityAsOf > CAPACITY_TTL_MS)
    return reply.code(503).send({error: 'STALE_CAPACITY'});

  const candidates = nodes.filter(node => node.gpuType === gpuType && node.free >= count);
  candidates.sort((a, b) => b.free - a.free);
  const best = candidates[0];
  if (best === undefined) return reply.code(409).send({error: 'no node with enough free capacity'});

  const placementId = await nodeRegistry.enqueue(
    {
      gpu_type: gpuType,
      count,
      memory_gb: body.memory_gb,
      max_hourly_bid: body.max_hourly_bid,
      node_id: best.id,
    },
    best,
  );
  request.log.info(
    {placementId, nodeId: best.id, gpuType, count, free: best.free, capacityAsOf},
    'placed',
  );
  return reply
    .code(201)
    .send({placement_id: placementId, node_id: best.id, free: best.free, capacity_as_of: capacityAsOf});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

// bootCapacity is the node snapshot loaded once while the service boots.
var bootCapacity = loadBootCapacity()

type placementRequest struct {
	GpuType      string  \`json:"gpu_type"\`
	Count        int     \`json:"count"\`
	MemoryGb     float64 \`json:"memory_gb"\`
	MaxHourlyBid float64 \`json:"max_hourly_bid"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func place(rw http.ResponseWriter, r *http.Request) {
	var body placementRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts any count, treats an unlisted gpu_type as whatever is free, places
	// against the capacity snapshot taken at boot, and logs the request body. Review all four.
	node := bootCapacity[0]
	for _, candidate := range bootCapacity {
		if candidate.GpuType == body.GpuType {
			node = candidate
			break
		}
	}
	placementID, _ := nodeRegistry.Enqueue(body, node)
	log.Printf("placement queued payload=%v", body)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"placement_id": placementID,
		"node_id":      node.ID,
		"status":       "queued",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/placements", place)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

const (
	maxNodeGpus    = 8
	capacityTtlSec = 2
)

var knownGpuTypes = map[string]bool{"a100": true, "h100": true, "l40s": true}

type placementRequest struct {
	GpuType      string  \`json:"gpu_type"\`
	Count        int     \`json:"count"\`
	MemoryGb     float64 \`json:"memory_gb"\`
	MaxHourlyBid float64 \`json:"max_hourly_bid"\`
}

type nodeRecord struct {
	ID      string \`json:"id"\`
	GpuType string \`json:"gpu_type"\`
	Free    int    \`json:"free"\`
}

type nodeSnapshot struct {
	Nodes        []nodeRecord \`json:"nodes"\`
	CapacityAsOf int64        \`json:"capacity_as_of"\`
}

type nodeRegistryClient struct{}

var nodeRegistry = &nodeRegistryClient{}

// ListNodes reads every schedulable node live, with the time its capacity was read.
func (c *nodeRegistryClient) ListNodes() (nodeSnapshot, error) {
	return nodeSnapshot{}, nil
}

// Enqueue queues the placement on the chosen node and returns its placement id.
func (c *nodeRegistryClient) Enqueue(placement placementRequest, node nodeRecord) (string, error) {
	return "", nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func isPositiveInt(value json.Number) bool {
	n, err := value.Int64()
	return err == nil && n >= 1
}

func isFiniteNumber(value json.Number) bool {
	_, err := value.Float64()
	return err == nil
}

func place(rw http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "malformed JSON body"})
		return
	}
	gpuType, ok := body["gpu_type"].(string)
	if !ok || !knownGpuTypes[gpuType] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown gpu_type"})
		return
	}
	countRaw, ok := body["count"].(json.Number)
	if !ok || !isPositiveInt(countRaw) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "count must be a positive integer"})
		return
	}
	memoryRaw, ok := body["memory_gb"].(json.Number)
	if !ok || !isFiniteNumber(memoryRaw) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "memory_gb must be a number"})
		return
	}
	bidRaw, ok := body["max_hourly_bid"].(json.Number)
	if !ok || !isFiniteNumber(bidRaw) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_hourly_bid must be a number"})
		return
	}
	countVal, _ := countRaw.Int64()
	countInt := int(countVal)
	if countInt > maxNodeGpus {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "count exceeds the largest node"})
		return
	}

	snapshot, err := nodeRegistry.ListNodes()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "node registry unavailable"})
		return
	}
	if time.Now().Unix()-snapshot.CapacityAsOf > capacityTtlSec {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "STALE_CAPACITY"})
		return
	}

	var best *nodeRecord
	for i := range snapshot.Nodes {
		node := &snapshot.Nodes[i]
		if node.GpuType != gpuType || node.Free < countInt {
			continue
		}
		if best == nil || node.Free > best.Free {
			best = node
		}
	}
	if best == nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "no node with enough free capacity"})
		return
	}

	memoryGb, _ := memoryRaw.Float64()
	bid, _ := bidRaw.Float64()
	placementID, err := nodeRegistry.Enqueue(placementRequest{
		GpuType:      gpuType,
		Count:        countInt,
		MemoryGb:     memoryGb,
		MaxHourlyBid: bid,
	}, *best)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "node registry unavailable"})
		return
	}

	nodeID := best.ID
	log.Printf("placed id=%s node=%s gpu_type=%s count=%d free=%d capacity_as_of=%d",
		placementID, nodeID, gpuType, countInt, best.Free, snapshot.CapacityAsOf)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"placement_id":   placementID,
		"node_id":        nodeID,
		"free":           best.Free,
		"capacity_as_of": snapshot.CapacityAsOf,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/placements", place)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PlacementRequest(gpu_type: String, count: Int, memory_gb: Double, max_hourly_bid: Double)
final case class NodeRecord(id: String, gpu_type: String, free: Int)

class NodeRegistry {
  def enqueue(placement: PlacementRequest, node: NodeRecord): String = ""
}

object PlacementApi {
  implicit val system: ActorSystem = ActorSystem("gpusched")
  implicit val placementFormat: RootJsonFormat[PlacementRequest] = jsonFormat4(PlacementRequest)

  // Node capacity as loaded once while the service boots.
  val BootCapacity: List[NodeRecord] = loadBootCapacity()

  val nodeRegistry = new NodeRegistry()

  val route: Route =
    path("v1" / "placements") {
      post {
        entity(as[PlacementRequest]) { body =>
          // TODO: this draft accepts any count, treats an unlisted gpu_type as whatever is free,
          // places against the capacity snapshot taken at boot, and logs the request body.
          val node = BootCapacity.find(_.gpu_type == body.gpu_type).getOrElse(BootCapacity.head)
          val placementId = nodeRegistry.enqueue(body, node)
          system.log.info(s"placement queued payload=$body")
          complete(StatusCodes.Created, s"""{"placement_id":"$placementId","node_id":"$nodeId"}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PlacementRequest(gpu_type: String, count: Int, memory_gb: Double, max_hourly_bid: Double)
final case class NodeRecord(id: String, gpu_type: String, free: Int)
final case class NodeSnapshot(nodes: List[NodeRecord], capacityAsOf: Long)
final case class PlacementJob(
    gpu_type: String,
    count: Int,
    memory_gb: Double,
    max_hourly_bid: Double,
    node_id: String,
)
final case class PlacementResponse(placement_id: String, node_id: String, free: Int, capacity_as_of: Long)

class NodeRegistry {
  /** Every schedulable node plus the time its capacity was read. */
  def list(): NodeSnapshot = NodeSnapshot(Nil, 0L)

  def enqueue(placement: PlacementJob, node: NodeRecord): String = ""
}

object PlacementApi {
  implicit val system: ActorSystem = ActorSystem("gpusched")
  implicit val placementFormat: RootJsonFormat[PlacementRequest] = jsonFormat4(PlacementRequest)
  implicit val responseFormat: RootJsonFormat[PlacementResponse] = jsonFormat4(PlacementResponse)

  val KnownGpuTypes = Set("a100", "h100", "l40s")
  val MaxNodeGpus = 8
  val CapacityTtlSeconds = 2

  val nodeRegistry = new NodeRegistry()

  def isPositiveInt(value: Int): Boolean = value >= 1

  def isFiniteNumber(value: Double): Boolean = !value.isNaN && !value.isInfinite

  val route: Route =
    path("v1" / "placements") {
      post {
        entity(as[PlacementRequest]) { body =>
          if (!KnownGpuTypes.contains(body.gpu_type)) {
            complete(StatusCodes.BadRequest, """{"error":"unknown gpu_type"}""")
          } else if (!isPositiveInt(body.count)) {
            complete(StatusCodes.BadRequest, """{"error":"count must be a positive integer"}""")
          } else if (!isFiniteNumber(body.memory_gb)) {
            complete(StatusCodes.BadRequest, """{"error":"memory_gb must be a number"}""")
          } else if (!isFiniteNumber(body.max_hourly_bid)) {
            complete(StatusCodes.BadRequest, """{"error":"max_hourly_bid must be a number"}""")
          } else if (body.count > MaxNodeGpus) {
            complete(StatusCodes.BadRequest, """{"error":"count exceeds the largest node"}""")
          } else {
            val snapshot = nodeRegistry.list()
            if (System.currentTimeMillis() / 1000 - snapshot.capacityAsOf > CapacityTtlSeconds) {
              complete(StatusCodes.ServiceUnavailable, """{"error":"STALE_CAPACITY"}""")
            } else {
              val candidates =
                snapshot.nodes.filter(node => node.gpu_type == body.gpu_type && node.free >= body.count)
              candidates.sortBy(node => -node.free).headOption match {
                case None =>
                  complete(StatusCodes.Conflict, """{"error":"no node with enough free capacity"}""")
                case Some(best) =>
                  val job = PlacementJob(body.gpu_type, body.count, body.memory_gb, body.max_hourly_bid, best.id)
                  val placementId = nodeRegistry.enqueue(job, best)
                  val nodeId = best.id
                  val free = best.free
                  val gpuType = body.gpu_type
                  val count = body.count
                  system.log.info(s"placed id=$placementId node=$nodeId gpu_type=$gpuType count=$count free=$free")
                  complete(
                    StatusCodes.Created,
                    PlacementResponse(placementId, nodeId, free, snapshot.capacityAsOf),
                  )
              }
            }
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

#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

struct NodeRecord {
  std::string id;
  std::string gpu_type;
  int free;
};

/** Node capacity as loaded once while the service boots. */
std::vector<NodeRecord> loadBootCapacity();

const std::vector<NodeRecord> kBootCapacity = loadBootCapacity();

struct NodeRegistry {
  std::string enqueue(const json& placement, const NodeRecord& node);
};

NodeRegistry nodeRegistry;

int main() {
  httplib::Server svr;

  svr.Post("/v1/placements", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    // TODO: this draft accepts any count, treats an unlisted gpu_type as whatever is free, places
    // against the capacity snapshot taken at boot, and logs the request body. Review all four.
    const auto gpuType = body.value("gpu_type", std::string("a100"));
    const NodeRecord* node = &kBootCapacity.front();
    for (const auto& candidate : kBootCapacity) {
      if (candidate.gpu_type == gpuType) {
        node = &candidate;
        break;
      }
    }
    const auto placementId = nodeRegistry.enqueue(body, *node);
    std::cerr << "placement queued payload=" << body.dump() << "\\n";
    res.status = 201;
    res.set_content(
        json{{"placement_id", placementId}, {"node_id", node->id}, {"status", "queued"}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <ctime>
#include <iostream>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::set<std::string> kKnownGpuTypes = {"a100", "h100", "l40s"};
constexpr int kMaxNodeGpus = 8;
constexpr long kCapacityTtlSeconds = 2;

struct NodeRecord {
  std::string id;
  std::string gpu_type;
  int free;
};

struct NodeSnapshot {
  std::vector<NodeRecord> nodes;
  long capacityAsOf;
};

struct NodeRegistry {
  /** Every schedulable node plus the time its capacity was read. */
  NodeSnapshot list();

  std::string enqueue(const json& placement, const NodeRecord& node);
};

NodeRegistry nodeRegistry;

bool isPositiveInt(const json& value) {
  return value.is_number_integer() && value.get<long long>() >= 1;
}

bool isFiniteNumber(const json& value) { return value.is_number(); }

void fail(httplib::Response& res, int status, const char* message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/placements", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      fail(res, 400, "body must be a JSON object");
      return;
    }
    if (!body.contains("gpu_type") || !body["gpu_type"].is_string() ||
        kKnownGpuTypes.count(body["gpu_type"].get<std::string>()) == 0) {
      fail(res, 400, "unknown gpu_type");
      return;
    }
    if (!body.contains("count") || !isPositiveInt(body["count"])) {
      fail(res, 400, "count must be a positive integer");
      return;
    }
    if (!body.contains("memory_gb") || !isFiniteNumber(body["memory_gb"])) {
      fail(res, 400, "memory_gb must be a number");
      return;
    }
    if (!body.contains("max_hourly_bid") || !isFiniteNumber(body["max_hourly_bid"])) {
      fail(res, 400, "max_hourly_bid must be a number");
      return;
    }
    const int count = body["count"].get<int>();
    if (count > kMaxNodeGpus) {
      fail(res, 400, "count exceeds the largest node");
      return;
    }

    const auto snapshot = nodeRegistry.list();
    if (std::time(nullptr) - snapshot.capacityAsOf > kCapacityTtlSeconds) {
      fail(res, 503, "STALE_CAPACITY");
      return;
    }

    const auto gpuType = body["gpu_type"].get<std::string>();
    const NodeRecord* best = nullptr;
    for (const auto& node : snapshot.nodes) {
      if (node.gpu_type != gpuType || node.free < count) continue;
      if (best == nullptr || node.free > best->free) best = &node;
    }
    if (best == nullptr) {
      fail(res, 409, "no node with enough free capacity");
      return;
    }

    const auto placementId = nodeRegistry.enqueue(
        json{{"gpu_type", gpuType},
             {"count", count},
             {"memory_gb", body["memory_gb"]},
             {"max_hourly_bid", body["max_hourly_bid"]},
             {"node_id", best->id}},
        *best);
    const auto nodeId = best->id;
    std::cerr << "placed id=" << placementId << " node=" << nodeId << " count=" << count
              << " free=" << best->free << " capacity_as_of=" << snapshot.capacityAsOf << "\\n";
    res.status = 201;
    res.set_content(
        json{{"placement_id", placementId},
             {"node_id", nodeId},
             {"free", best->free},
             {"capacity_as_of", snapshot.capacityAsOf}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the admission boundary of a scheduler. The draft reads fine because the demo sends a well-formed request for a type that exists and fits: nothing in it exercises a typo, a count larger than the fleet, or a node that filled up since the process booted. Four defects are being checked, and they are ordered by how expensive they are to find in production. The unknown-type fallback is the loud one: a caller's typo becomes a placement on a machine that cannot run the job, and the GPU is wasted until someone notices. The uncapped count is the quiet one: nothing fails, the request simply sits in the queue forever, and the caller has no signal that it was impossible from the start. The boot-time capacity snapshot is the dangerous one, because it is *correct on the first request* and drifts afterwards — every later allocation the rest of the system performs is invisible to it, so the scheduler keeps handing out GPUs that are already taken. Reading capacity fresh per request, and carrying the read's \`capacity_as_of\` timestamp so a stale answer can be refused rather than trusted, is the same discipline the rest of this course applies to the Redis counters: never schedule from memory that something else can invalidate. The log line is the one candidates miss: a GPU request carries tenant ids, memory footprints and private bids, so the placement log must be ids and counters only. Real schedulers push further — a registry watch rather than a pull, a cache with an explicit invalidation epoch, per-tenant admission quotas before the capacity check, and a structured audit event for every rejected placement so that "why did my job never start" has an answer.`,
};
