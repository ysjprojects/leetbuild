import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/placements: admit, pick a node, book it',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'scheduler', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/placements\`, picks the node with the most
free GPUs of the requested type from a node set it read once, when the service started serving,
books it through the ledger's \`allocate\` and answers \`201\`. It serves the demo and hides four
flaws.

**Failure mode the checks target.** A typo in \`gpu_type\` lands on whatever node is free; a count
no node could ever hold goes to the ledger instead of being refused; a node that filled up or joined
after boot is invisible, so the scheduler offers GPUs it no longer has and ignores ones it does; the
log line carries the tenant's bid.

- Body: \`{"gpu_type", "count", "memory_gb", "max_hourly_bid"}\`. \`gpu_type\` must be in
  \`KNOWN_GPU_TYPES\`, \`count\` an integer from 1 to \`MAX_NODE_GPUS\`, the other two numbers;
  anything else is **400**, before any node is read.
- Read \`nodes\` and each \`node:{id}\` from Redis on every request; a node counts only while
  \`heartbeat:{id}\` exists. Try candidates of the type by free GPUs, most first, through
  \`allocate(node_id, placement_id, count)\`; the first \`ALLOCATED\` wins.
- **201** with \`placement_id\`, \`node_id\` and \`free\` (after the booking); **409** when no node
  takes it.
- Log the decision with the placement id, the node id and the counts; the request body stays out
  of the log.`,
  sequence: {
    participants: ['Client', 'gpusched', 'Redis'],
    messages: [
      {from: 'Client', to: 'gpusched', label: 'POST /v1/placements {a100, 4, 80, 3.5}', kind: 'sync'},
      {from: 'gpusched', to: 'gpusched', label: 'validate: known type · 1 ≤ count ≤ 8 · numbers', kind: 'sync'},
      {
        from: 'gpusched',
        to: 'Redis',
        label: 'SMEMBERS nodes · HGETALL node:{id} · EXISTS heartbeat:{id}',
        kind: 'sync',
      },
      {from: 'gpusched', to: 'Redis', label: 'EVAL allocate gpu-2 p-7 4', kind: 'sync'},
      {from: 'Redis', to: 'gpusched', label: 'ALLOCATED', kind: 'reply'},
      {from: 'gpusched', to: 'Client', label: '201 {placement_id: p-7, node_id: gpu-2, free: 4}', kind: 'reply'},
      {from: 'Client', to: 'gpusched', label: 'POST {tpu, 4, …}', kind: 'sync'},
      {from: 'gpusched', to: 'Client', label: '400 unknown gpu_type', kind: 'reply'},
    ],
  },
  hints: [
    'A request for `gpu_type: "tpu"` answers 201 on an a100 node; `count: 9` answers 409 instead of 400; a node that joined an hour after the scheduler started is never chosen.',
    'The node list is a module-level constant filled at import time, so every request schedules against the fleet as it was at boot; the body is typed, not checked against the known types or the ceiling.',
    'Validate the body yourself and answer 400 before touching Redis; read `nodes`, `node:{id}` and `heartbeat:{id}` inside the handler; log `placement_id`, `node_id`, `count` and `free` rather than the body.',
  ],
  checks: [
    {
      id: 'route-shape',
      title: 'POST /v1/placements books a node through the ledger',
      detail:
        'The route is registered on `POST /v1/placements` and a valid body is booked with `allocate`, answering 201 with `placement_id`, `node_id` and `free`. The starter does this already.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/placements["']/, /\ballocate\(/, /status_code=201/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/placements['"]/, /\ballocate\(/, /code\(\s*201\s*\)/]},
        go: {all: [/"POST \/v1\/placements"/, /\ballocate\(/, /StatusCreated|\b201\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/placements"/, /\ballocate\(/, /status\s*=\s*201/]},
      },
    },
    {
      id: 'unknown-type',
      title: 'An unknown gpu_type is 400 before any node is read',
      detail:
        '`gpu_type` is checked against `KNOWN_GPU_TYPES` and refused with 400 before the node set is read or `allocate` runs; a known type no live node has is a 409, never a booking on another type. The starter has no such check and lands a typo on any node of the fleet.',
      match: {
        python: {all: [/status_code=400/], order: [/not in KNOWN_GPU_TYPES/, /\ballocate\(/]},
        typescript: {all: [/code\(\s*400\s*\)/], order: [/KNOWN_GPU_TYPES\[/, /\ballocate\(/]},
        go: {all: [/StatusBadRequest/], order: [/config\.KnownGPUTypes\[/, /\ballocate\(/]},
        cpp: {all: [/\b400\b/], order: [/kKnownGpuTypes\.count/, /\ballocate\(/]},
      },
    },
    {
      id: 'capacity-ceiling',
      title: 'count is an integer from 1 to MAX_NODE_GPUS',
      detail:
        '`count` is an integer (not a boolean, not a fraction) compared against `MAX_NODE_GPUS` and refused below 1 with a 400 before `allocate` runs, however large it is. The starter passes any integer to the ledger, so an impossible request is a 409 and a zero is a booking.',
      match: {
        python: {all: [/status_code=400/], order: [/[<>]=?\s*MAX_NODE_GPUS|MAX_NODE_GPUS\s*[<>]=?/, /\ballocate\(/]},
        typescript: {
          all: [/code\(\s*400\s*\)/],
          order: [/[<>]=?\s*MAX_NODE_GPUS|MAX_NODE_GPUS\s*[<>]=?/, /\ballocate\(/],
        },
        go: {
          all: [/StatusBadRequest/],
          order: [/[<>]=?\s*config\.MaxNodeGPUs|config\.MaxNodeGPUs\s*[<>]=?/, /\ballocate\(/],
        },
        cpp: {all: [/\b400\b/], order: [/[<>]=?\s*(gpusched::)?kMaxNodeGpus|kMaxNodeGpus\s*[<>]=?/, /\ballocate\(/]},
      },
    },
    {
      id: 'fresh-capacity',
      title: 'The node set is read on every request',
      detail:
        'The handler reads `nodes` and the node hashes from Redis each time (`schedulable_nodes()` inside the handler) and the boot snapshot is gone. Candidates are tried by free GPUs, most first, and a node the ledger refuses (another replica filled it after the read) passes the request to the next one. The starter schedules against `BOOT_NODES`, read once at import.',
      match: {
        python: {all: [/def place[\s\S]*?schedulable_nodes\(\)/], none: [/BOOT_NODES/]},
        typescript: {all: [/app\.post\([\s\S]*?schedulableNodes\(\)/], none: [/BOOT_NODES/]},
        go: {all: [/func place[\s\S]*?schedulableNodes\(/], none: [/bootNodes/]},
        cpp: {all: [/void place[\s\S]*?schedulable_nodes\(\)/], none: [/kBootNodes/]},
      },
    },
    {
      id: 'log-no-payload',
      title: 'The log line names ids and counts, not the body',
      detail:
        'The decision is logged with the placement id, the node id and the counts. The request body and its `max_hourly_bid` stay out of the log; the starter logs the body verbatim.',
      match: {
        python: {
          all: [/logger\.info\(/, /placement_id/],
          none: [/logger\.\w+\([^)]*model_dump|logger\.\w+\([^)]*\bbody\b|logger\.\w+\([^)]*max_hourly_bid/],
        },
        typescript: {
          all: [/console\.info\(/, /placement_id|placementId/],
          none: [/console\.\w+\([^)]*\bbody\b|console\.\w+\([^)]*max_hourly_bid/],
        },
        go: {
          all: [/log\.Printf\(/, /placementID/],
          none: [/log\.\w+\([^)]*\bbody\b|log\.\w+\([^)]*MaxHourlyBid|log\.\w+\([^)]*max_hourly_bid/],
        },
        cpp: {all: [/std::clog\s*<</, /placement_id/], none: [/std::clog[^;]*\bbody\b|std::clog[^;]*max_hourly_bid/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from gpusched.config import KNOWN_GPU_TYPES, MAX_NODE_GPUS
from state import allocate

app = FastAPI()
logger = logging.getLogger("gpusched")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.


class PlacementRequest(BaseModel):
    gpu_type: str
    count: int
    memory_gb: float
    max_hourly_bid: float


def schedulable_nodes() -> list[dict]:
    """Every node with a live heartbeat: id, gpu_type, capacity, allocated and free."""
    nodes = []
    for node_id in r.smembers("nodes"):
        if not r.exists(f"heartbeat:{node_id}"):
            continue
        node = r.hgetall(f"node:{node_id}")
        capacity, allocated = int(node.get("capacity", 0)), int(node.get("allocated", 0))
        nodes.append({"id": node_id, "gpu_type": node.get("gpu_type"), "capacity": capacity, "allocated": allocated, "free": max(capacity - allocated, 0)})
    return nodes


# The fleet, read once while the service boots.
BOOT_NODES = schedulable_nodes()


@app.post("/v1/placements")
def place(body: PlacementRequest) -> JSONResponse:
    nodes = sorted(BOOT_NODES, key=lambda n: n["free"], reverse=True)
    candidates = [n for n in nodes if n["gpu_type"] == body.gpu_type] or nodes
    placement_id = f"p-{uuid.uuid4().hex[:12]}"
    for node in candidates:
        if allocate(node["id"], placement_id, body.count) == "ALLOCATED":
            free = node["free"] - body.count
            logger.info("placement queued payload=%r node=%s", body.model_dump(), node["id"])
            return JSONResponse({"placement_id": placement_id, "node_id": node["id"], "free": free}, status_code=201)
    return JSONResponse({"error": "NO_CAPACITY"}, status_code=409)
`,
      solution: `import logging
import uuid

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from gpusched.config import KNOWN_GPU_TYPES, MAX_NODE_GPUS
from state import allocate

app = FastAPI()
logger = logging.getLogger("gpusched")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def schedulable_nodes() -> list[dict]:
    """Every node with a live heartbeat: id, gpu_type, capacity, allocated and free."""
    nodes = []
    for node_id in r.smembers("nodes"):
        if not r.exists(f"heartbeat:{node_id}"):
            continue
        node = r.hgetall(f"node:{node_id}")
        capacity, allocated = int(node.get("capacity", 0)), int(node.get("allocated", 0))
        nodes.append({"id": node_id, "gpu_type": node.get("gpu_type"), "capacity": capacity, "allocated": allocated, "free": max(capacity - allocated, 0)})
    return nodes


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


@app.post("/v1/placements")
async def place(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="malformed JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    gpu_type = body.get("gpu_type")
    if gpu_type not in KNOWN_GPU_TYPES:
        raise HTTPException(status_code=400, detail="unknown gpu_type")
    count = body.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 1 or count > MAX_NODE_GPUS:
        raise HTTPException(status_code=400, detail=f"count must be an integer from 1 to {MAX_NODE_GPUS}")
    if not is_number(body.get("memory_gb")) or not is_number(body.get("max_hourly_bid")):
        raise HTTPException(status_code=400, detail="memory_gb and max_hourly_bid must be numbers")

    nodes = sorted(schedulable_nodes(), key=lambda n: n["free"], reverse=True)
    placement_id = f"p-{uuid.uuid4().hex[:12]}"
    for node in nodes:
        if node["gpu_type"] != gpu_type or node["free"] < count:
            continue
        if allocate(node["id"], placement_id, count) == "ALLOCATED":
            free = node["free"] - count
            logger.info("placed placement_id=%s node_id=%s count=%d free=%d", placement_id, node["id"], count, free)
            return JSONResponse({"placement_id": placement_id, "node_id": node["id"], "free": free}, status_code=201)
    return JSONResponse({"error": "NO_CAPACITY"}, status_code=409)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {KNOWN_GPU_TYPES, MAX_NODE_GPUS} from 'gpusched/config';
import {allocate} from './state';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

interface Node {
  id: string;
  gpuType: string;
  capacity: number;
  allocated: number;
  free: number;
}

/** Every node with a live heartbeat: id, gpu type, capacity, allocated and free. */
async function schedulableNodes(): Promise<Node[]> {
  const nodes: Node[] = [];
  for (const id of await redis.smembers('nodes')) {
    if (!(await redis.exists(\`heartbeat:\${id}\`))) continue;
    const node = await redis.hgetall(\`node:\${id}\`);
    const capacity = Number(node.capacity ?? 0);
    const allocated = Number(node.allocated ?? 0);
    nodes.push({id, gpuType: node.gpu_type, capacity, allocated, free: Math.max(capacity - allocated, 0)});
  }
  return nodes.sort((a, b) => b.free - a.free);
}

/** The fleet, read once while the service boots. */
const BOOT_NODES = schedulableNodes();

interface PlacementBody {
  gpu_type: string;
  count: number;
  memory_gb: number;
  max_hourly_bid: number;
}

app.post('/v1/placements', async (request, reply) => {
  const body = request.body as PlacementBody;
  const nodes = await BOOT_NODES;
  const typed = nodes.filter(n => n.gpuType === body.gpu_type);
  const placementId = \`p-\${Math.random().toString(16).slice(2, 14)}\`;
  for (const node of typed.length > 0 ? typed : nodes) {
    if ((await allocate(node.id, placementId, body.count)) === 'ALLOCATED') {
      console.info('placement queued', JSON.stringify({payload: body, node_id: node.id}));
      return reply.code(201).send({placement_id: placementId, node_id: node.id, free: node.free - body.count});
    }
  }
  return reply.code(409).send({error: 'NO_CAPACITY'});
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {KNOWN_GPU_TYPES, MAX_NODE_GPUS} from 'gpusched/config';
import {allocate} from './state';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

interface Node {
  id: string;
  gpuType: string;
  capacity: number;
  allocated: number;
  free: number;
}

/** Every node with a live heartbeat: id, gpu type, capacity, allocated and free. */
async function schedulableNodes(): Promise<Node[]> {
  const nodes: Node[] = [];
  for (const id of await redis.smembers('nodes')) {
    if (!(await redis.exists(\`heartbeat:\${id}\`))) continue;
    const node = await redis.hgetall(\`node:\${id}\`);
    const capacity = Number(node.capacity ?? 0);
    const allocated = Number(node.allocated ?? 0);
    nodes.push({id, gpuType: node.gpu_type, capacity, allocated, free: Math.max(capacity - allocated, 0)});
  }
  return nodes.sort((a, b) => b.free - a.free);
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

app.post('/v1/placements', async (request, reply) => {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reply.code(400).send({error: 'body must be a JSON object'});
  }
  const {gpu_type: gpuType, count, memory_gb: memoryGb, max_hourly_bid: bid} = body as Record<string, unknown>;
  if (typeof gpuType !== 'string' || KNOWN_GPU_TYPES[gpuType] !== true) {
    return reply.code(400).send({error: 'unknown gpu_type'});
  }
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_NODE_GPUS) {
    return reply.code(400).send({error: \`count must be an integer from 1 to \${MAX_NODE_GPUS}\`});
  }
  if (!isNumber(memoryGb) || !isNumber(bid)) {
    return reply.code(400).send({error: 'memory_gb and max_hourly_bid must be numbers'});
  }
  const wanted = count as number;
  const placementId = \`p-\${Math.random().toString(16).slice(2, 14)}\`;
  for (const node of await schedulableNodes()) {
    if (node.gpuType !== gpuType || node.free < wanted) continue;
    if ((await allocate(node.id, placementId, wanted)) === 'ALLOCATED') {
      const free = node.free - wanted;
      console.info(\`placed placement_id=\${placementId} node_id=\${node.id} count=\${wanted} free=\${free}\`);
      return reply.code(201).send({placement_id: placementId, node_id: node.id, free});
    }
  }
  return reply.code(409).send({error: 'NO_CAPACITY'});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"gpusched/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// allocate books count GPUs of the node for the placement (state.go, step 2): ALLOCATED, NO_CAPACITY or NO_HEARTBEAT.
var allocate = func(ctx context.Context, nodeID, placementID string, count int) (string, error) { panic("not implemented") }

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

type node struct {
	ID        string
	GPUType   string
	Capacity  int
	Allocated int
	Free      int
}

// schedulableNodes is every node with a live heartbeat, most free GPUs first.
func schedulableNodes(ctx context.Context) ([]node, error) {
	ids, err := rdb.SMembers(ctx, "nodes").Result()
	if err != nil {
		return nil, err
	}
	var nodes []node
	for _, id := range ids {
		if rdb.Exists(ctx, "heartbeat:"+id).Val() == 0 {
			continue
		}
		fields := rdb.HGetAll(ctx, "node:"+id).Val()
		capacity, _ := strconv.Atoi(fields["capacity"])
		allocated, _ := strconv.Atoi(fields["allocated"])
		nodes = append(nodes, node{ID: id, GPUType: fields["gpu_type"], Capacity: capacity, Allocated: allocated, Free: max(capacity-allocated, 0)})
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Free > nodes[j].Free })
	return nodes, nil
}

// bootNodes is the fleet as it was when the service booted.
var bootNodes []node

type placementBody struct {
	GPUType      string  \`json:"gpu_type"\`
	Count        int     \`json:"count"\`
	MemoryGB     float64 \`json:"memory_gb"\`
	MaxHourlyBid float64 \`json:"max_hourly_bid"\`
}

func place(rw http.ResponseWriter, r *http.Request) {
	var body placementBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "malformed JSON body", http.StatusBadRequest)
		return
	}
	_, _ = config.KnownGPUTypes, config.MaxNodeGPUs
	var typed []node
	for _, n := range bootNodes {
		if n.GPUType == body.GPUType {
			typed = append(typed, n)
		}
	}
	if len(typed) == 0 {
		typed = bootNodes
	}
	placementID := fmt.Sprintf("p-%012x", rand.Uint64()&0xffffffffffff)
	for _, n := range typed {
		result, err := allocate(r.Context(), n.ID, placementID, body.Count)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if result == "ALLOCATED" {
			log.Printf("placement queued body=%+v node=%s", body, n.ID)
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(http.StatusCreated)
			json.NewEncoder(rw).Encode(map[string]any{"placement_id": placementID, "node_id": n.ID, "free": n.Free - body.Count})
			return
		}
	}
	http.Error(rw, "NO_CAPACITY", http.StatusConflict)
}

func register(mux *http.ServeMux) {
	bootNodes, _ = schedulableNodes(context.Background())
	mux.HandleFunc("POST /v1/placements", place)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"math/rand/v2"
	"net/http"
	"sort"
	"strconv"

	"github.com/redis/go-redis/v9"

	"gpusched/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// allocate books count GPUs of the node for the placement (state.go, step 2): ALLOCATED, NO_CAPACITY or NO_HEARTBEAT.
var allocate = func(ctx context.Context, nodeID, placementID string, count int) (string, error) { panic("not implemented") }

type node struct {
	ID        string
	GPUType   string
	Capacity  int
	Allocated int
	Free      int
}

// schedulableNodes is every node with a live heartbeat, most free GPUs first.
func schedulableNodes(ctx context.Context) ([]node, error) {
	ids, err := rdb.SMembers(ctx, "nodes").Result()
	if err != nil {
		return nil, err
	}
	var nodes []node
	for _, id := range ids {
		if rdb.Exists(ctx, "heartbeat:"+id).Val() == 0 {
			continue
		}
		fields := rdb.HGetAll(ctx, "node:"+id).Val()
		capacity, _ := strconv.Atoi(fields["capacity"])
		allocated, _ := strconv.Atoi(fields["allocated"])
		nodes = append(nodes, node{ID: id, GPUType: fields["gpu_type"], Capacity: capacity, Allocated: allocated, Free: max(capacity-allocated, 0)})
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Free > nodes[j].Free })
	return nodes, nil
}

// isNumber is a JSON number: not a string, not a bool, not null.
func isNumber(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}

func place(rw http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body == nil {
		http.Error(rw, "body must be a JSON object", http.StatusBadRequest)
		return
	}
	gpuType, _ := body["gpu_type"].(string)
	if !config.KnownGPUTypes[gpuType] {
		http.Error(rw, "unknown gpu_type", http.StatusBadRequest)
		return
	}
	raw, _ := body["count"].(float64)
	count := int(raw)
	if !isNumber(body["count"]) || float64(count) != raw || count < 1 || count > config.MaxNodeGPUs {
		http.Error(rw, fmt.Sprintf("count must be an integer from 1 to %d", config.MaxNodeGPUs), http.StatusBadRequest)
		return
	}
	if !isNumber(body["memory_gb"]) || !isNumber(body["max_hourly_bid"]) {
		http.Error(rw, "memory_gb and max_hourly_bid must be numbers", http.StatusBadRequest)
		return
	}
	nodes, err := schedulableNodes(r.Context())
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	placementID := fmt.Sprintf("p-%012x", rand.Uint64()&0xffffffffffff)
	for _, n := range nodes {
		if n.GPUType != gpuType || n.Free < count {
			continue
		}
		result, err := allocate(r.Context(), n.ID, placementID, count)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if result == "ALLOCATED" {
			free := n.Free - count
			log.Printf("placed placement_id=%s node_id=%s count=%d free=%d", placementID, n.ID, count, free)
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(http.StatusCreated)
			json.NewEncoder(rw).Encode(map[string]any{"placement_id": placementID, "node_id": n.ID, "free": free})
			return
		}
	}
	http.Error(rw, "NO_CAPACITY", http.StatusConflict)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/placements", place)
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <random>
#include <string>
#include <vector>

#include "gpusched/config.h"
#include "state.h"

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

struct Node {
  std::string id;
  std::string gpu_type;
  int capacity = 0;
  int allocated = 0;
  int free = 0;
};

// Every node with a live heartbeat, most free GPUs first.
std::vector<Node> schedulable_nodes() {
  std::vector<Node> nodes;
  for (const std::string& id : redis.smembers("nodes")) {
    if (!redis.exists("heartbeat:" + id)) continue;
    const auto fields = redis.hgetall("node:" + id);
    Node n{id, fields.count("gpu_type") ? fields.at("gpu_type") : ""};
    n.capacity = fields.count("capacity") ? std::stoi(fields.at("capacity")) : 0;
    n.allocated = fields.count("allocated") ? std::stoi(fields.at("allocated")) : 0;
    n.free = std::max(n.capacity - n.allocated, 0);
    nodes.push_back(n);
  }
  std::sort(nodes.begin(), nodes.end(), [](const Node& a, const Node& b) { return a.free > b.free; });
  return nodes;
}

// The fleet as it was when the service booted.
std::vector<Node> kBootNodes;

std::string new_placement_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  char buf[16];
  std::snprintf(buf, sizeof buf, "p-%012llx", static_cast<unsigned long long>(rng() & 0xffffffffffffULL));
  return buf;
}

void place(const httplib::Request& req, httplib::Response& res) {
  json body;
  try {
    body = json::parse(req.body);
  } catch (const std::exception&) {
    res.status = 400;
    res.set_content("malformed JSON body", "text/plain");
    return;
  }
  const std::string gpu_type = body.value("gpu_type", "");
  const int count = body.value("count", 0);
  std::vector<Node> candidates;
  for (const Node& n : kBootNodes) {
    if (n.gpu_type == gpu_type) candidates.push_back(n);
  }
  if (candidates.empty()) candidates = kBootNodes;
  const std::string placement_id = new_placement_id();
  for (const Node& n : candidates) {
    if (allocate(n.id, placement_id, count) == "ALLOCATED") {
      std::clog << "placement queued body=" << body.dump() << " node=" << n.id << "\\n";
      res.status = 201;
      res.set_content(json{{"placement_id", placement_id}, {"node_id", n.id}, {"free", n.free - count}}.dump(), "application/json");
      return;
    }
  }
  res.status = 409;
  res.set_content("NO_CAPACITY", "text/plain");
}

void register_routes(httplib::Server& svr) {
  kBootNodes = schedulable_nodes();
  svr.Post("/v1/placements", place);
}
`,
      solution: `#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <random>
#include <string>
#include <vector>

#include "gpusched/config.h"
#include "state.h"

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

struct Node {
  std::string id;
  std::string gpu_type;
  int capacity = 0;
  int allocated = 0;
  int free = 0;
};

// Every node with a live heartbeat, most free GPUs first.
std::vector<Node> schedulable_nodes() {
  std::vector<Node> nodes;
  for (const std::string& id : redis.smembers("nodes")) {
    if (!redis.exists("heartbeat:" + id)) continue;
    const auto fields = redis.hgetall("node:" + id);
    Node n{id, fields.count("gpu_type") ? fields.at("gpu_type") : ""};
    n.capacity = fields.count("capacity") ? std::stoi(fields.at("capacity")) : 0;
    n.allocated = fields.count("allocated") ? std::stoi(fields.at("allocated")) : 0;
    n.free = std::max(n.capacity - n.allocated, 0);
    nodes.push_back(n);
  }
  std::sort(nodes.begin(), nodes.end(), [](const Node& a, const Node& b) { return a.free > b.free; });
  return nodes;
}

std::string new_placement_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  char buf[16];
  std::snprintf(buf, sizeof buf, "p-%012llx", static_cast<unsigned long long>(rng() & 0xffffffffffffULL));
  return buf;
}

void bad_request(httplib::Response& res, const std::string& why) {
  res.status = 400;
  res.set_content(why, "text/plain");
}

void place(const httplib::Request& req, httplib::Response& res) {
  json body;
  try {
    body = json::parse(req.body);
  } catch (const std::exception&) {
    return bad_request(res, "malformed JSON body");
  }
  if (!body.is_object()) return bad_request(res, "body must be a JSON object");
  if (!body["gpu_type"].is_string() || gpusched::kKnownGpuTypes.count(body["gpu_type"].get<std::string>()) == 0) {
    return bad_request(res, "unknown gpu_type");
  }
  const std::string gpu_type = body["gpu_type"].get<std::string>();
  if (!body["count"].is_number_integer()) return bad_request(res, "count must be an integer");
  const long long wanted = body["count"].get<long long>();
  if (wanted < 1 || wanted > gpusched::kMaxNodeGpus) {
    return bad_request(res, "count must be an integer from 1 to " + std::to_string(gpusched::kMaxNodeGpus));
  }
  const int count = static_cast<int>(wanted);
  if (!body["memory_gb"].is_number() || !body["max_hourly_bid"].is_number()) {
    return bad_request(res, "memory_gb and max_hourly_bid must be numbers");
  }
  const std::string placement_id = new_placement_id();
  for (const Node& n : schedulable_nodes()) {
    if (n.gpu_type != gpu_type || n.free < count) continue;
    if (allocate(n.id, placement_id, count) == "ALLOCATED") {
      const int free = n.free - count;
      std::clog << "placed placement_id=" << placement_id << " node_id=" << n.id << " count=" << count << " free=" << free << "\\n";
      res.status = 201;
      res.set_content(json{{"placement_id", placement_id}, {"node_id", n.id}, {"free", free}}.dump(), "application/json");
      return;
    }
  }
  res.status = 409;
  res.set_content("NO_CAPACITY", "text/plain");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/placements", place); }
`,
    },
  },
  harness: {
    python: `import logging

BODY = {"gpu_type": "a100", "count": 4, "memory_gb": 80, "max_hourly_bid": 3.5}


def _node(ctx, node_id, gpu_type="a100", capacity=8, allocated=0):
    """A registered node with a live heartbeat, as the ledger (step 2) writes it."""
    ctx.redis.hset(f"node:{node_id}", mapping={"gpu_type": gpu_type, "capacity": capacity, "allocated": allocated})
    ctx.redis.sadd("nodes", node_id)
    ctx.redis.set(f"heartbeat:{node_id}", "1", ex=30)


class _Lines(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


def _api(ctx):
    """The scheduler with gpu-1 (a100, 8 GPUs) registered before it boots, and its log captured."""
    _node(ctx, "gpu-1")
    lines = _Lines()
    logger = logging.getLogger("gpusched")
    logger.setLevel(logging.INFO)
    logger.addHandler(lines)
    m = ctx.load("api")
    return m, lines


async def _post(ctx, m, body):
    async with ctx.client(m.app) as c:
        return await c.post("/v1/placements", json=body)


async def check_route_shape(ctx):
    m, _ = _api(ctx)
    r = await _post(ctx, m, BODY)
    assert r.status_code == 201, f"POST /v1/placements with a valid body answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("node_id") == "gpu-1" and body.get("free") == 4 and isinstance(body.get("placement_id"), str), f"the answer was {body}, expected placement_id, node_id gpu-1 and free 4"
    record = ctx.redis.hgetall(f"placement:{body['placement_id']}")
    assert record.get("node_id") == "gpu-1" and record.get("count") == "4", f"placement:{body['placement_id']} is {record}: the placement must be booked through allocate"
    assert ctx.redis.hget("node:gpu-1", "allocated") == "4", "allocate must have moved node:gpu-1's allocated to 4"


async def check_unknown_type(ctx):
    m, _ = _api(ctx)
    fleet_read = ctx.redis_after("nodes", lambda: "read")
    r = await _post(ctx, m, {**BODY, "gpu_type": "tpu"})
    assert r.status_code == 400, f"gpu_type tpu answered {r.status_code}, expected 400: an unknown type must be refused, not placed on whatever node is free"
    assert ctx.redis.hget("node:gpu-1", "allocated") == "0", "a refused request must not book a node"
    assert not ctx.redis.keys("placement:*"), f"a refused request must write no placement record, found {ctx.redis.keys('placement:*')}"
    r = await _post(ctx, m, {**BODY, "gpu_type": 7})
    assert r.status_code == 400, f"gpu_type 7 answered {r.status_code}, expected 400"
    assert not fleet_read.fired, "a request refused for its gpu_type read the node set first: validate the body before any node is read"
    r = await _post(ctx, m, {**BODY, "gpu_type": "h100"})
    assert r.status_code == 409, f"gpu_type h100 with only an a100 node live answered {r.status_code}, expected 409: a known type is placed only on a node of that type, never on another type's"
    assert ctx.redis.hget("node:gpu-1", "allocated") == "0" and not ctx.redis.keys("placement:*"), "an h100 request must not book the a100 node"


async def check_capacity_ceiling(ctx):
    m, _ = _api(ctx)
    for count in (9, 0, -1, 2.5, "four", True, 4294967297):
        r = await _post(ctx, m, {**BODY, "count": count})
        assert r.status_code == 400, f"count {count!r} answered {r.status_code}, expected 400 (an integer from 1 to MAX_NODE_GPUS = 8)"
    assert ctx.redis.hget("node:gpu-1", "allocated") == "0" and not ctx.redis.keys("placement:*"), "no refused count may reach the ledger"
    for field in ("memory_gb", "max_hourly_bid"):
        r = await _post(ctx, m, {**BODY, field: "lots"})
        assert r.status_code == 400, f"{field} 'lots' answered {r.status_code}, expected 400"
    r = await _post(ctx, m, {**BODY, "count": 8})
    assert r.status_code == 201, f"count 8 on an idle 8-GPU node answered {r.status_code}: {r.text}"


async def check_fresh_capacity(ctx):
    m, _ = _api(ctx)
    # After boot: gpu-2 joins the fleet and gpu-1 fills up with placements from another replica.
    _node(ctx, "gpu-2")
    ctx.redis.hset("node:gpu-1", "allocated", 8)
    r = await _post(ctx, m, BODY)
    assert r.status_code == 201, f"with gpu-1 full and gpu-2 idle the request answered {r.status_code}: the node set must be read on every request, not at boot"
    assert r.json().get("node_id") == "gpu-2", f"the request landed on {r.json().get('node_id')}, expected gpu-2 (gpu-1 has 0 free)"
    ctx.redis.delete("heartbeat:gpu-2")
    r = await _post(ctx, m, BODY)
    assert r.status_code == 409, f"with gpu-1 full and gpu-2's heartbeat lapsed the request answered {r.status_code}, expected 409"
    # gpu-2 reports in again (4 free), gpu-1 frees up to 2, gpu-3 joins idle (8 free).
    ctx.redis.set("heartbeat:gpu-2", "1", ex=30)
    ctx.redis.hset("node:gpu-1", "allocated", 6)
    _node(ctx, "gpu-3")
    r = await _post(ctx, m, {**BODY, "count": 1})
    assert r.status_code == 201 and r.json().get("node_id") == "gpu-3", f"with 2, 4 and 8 GPUs free on gpu-1, gpu-2 and gpu-3 the request answered {r.status_code} {r.text}, expected gpu-3: candidates are tried by free GPUs, most first"

    def rival():
        """Another replica fills gpu-3 right after this request read it."""
        ctx.redis.hset("node:gpu-3", "allocated", 8)

    filled = ctx.redis_after("node:gpu-3", rival)
    r = await _post(ctx, m, {**BODY, "count": 2})
    assert filled.fired, "the request never read node:gpu-3"
    assert r.status_code == 201 and r.json().get("node_id") == "gpu-2", f"gpu-3 filled up between the read and allocate, so the ledger answered NO_CAPACITY there; the request answered {r.status_code} {r.text}, expected 201 on gpu-2 (4 free): the next candidate is tried, the first ALLOCATED wins"


async def check_log_no_payload(ctx):
    m, lines = _api(ctx)
    r = await _post(ctx, m, BODY)
    assert r.status_code == 201, f"POST answered {r.status_code}: {r.text}"
    placement_id = r.json()["placement_id"]
    assert lines.lines, "the placement must be logged (logger gpusched, level INFO)"
    for line in lines.lines:
        bare = line.replace(placement_id, "")  # a random id can contain "80"
        assert "3.5" not in bare and "max_hourly_bid" not in bare and "80" not in bare, f"the log line {line!r} carries the request body: log ids and counts, the tenant's bid stays out of the log"
    assert any(placement_id in line and "gpu-1" in line for line in lines.lines), f"no log line names the placement id and the node id: {lines.lines}"
`,
    typescript: `const BODY = {gpu_type: 'a100', count: 4, memory_gb: 80, max_hourly_bid: 3.5};

/** A registered node with a live heartbeat, as the ledger (step 2) writes it. */
function node(ctx, id: string, gpuType = 'a100', capacity = 8, allocatedGpus = 0): void {
  ctx.redis.hset(\`node:\${id}\`, 'gpu_type', gpuType, 'capacity', capacity, 'allocated', allocatedGpus);
  ctx.redis.sadd('nodes', id);
  ctx.redis.set(\`heartbeat:\${id}\`, '1', 'EX', 30);
}

/** The scheduler with gpu-1 (a100, 8 GPUs) registered before it boots, and its console captured. */
function api(ctx) {
  node(ctx, 'gpu-1');
  const lines: string[] = [];
  const original = {log: console.log, info: console.info};
  console.log = console.info = (...args: unknown[]) => void lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  const m = ctx.load('api');
  const c = ctx.client(m.app);
  const restore = (): void => {
    console.log = original.log;
    console.info = original.info;
  };
  return {c, lines, restore, post: (body: unknown) => c.post('/v1/placements', {json: body})};
}

export async function check_route_shape(ctx) {
  const {post, restore} = api(ctx);
  try {
    const r = await post(BODY);
    assert.equal(r.status, 201, \`POST /v1/placements with a valid body answered \${r.status}: \${r.text}\`);
    const body = r.json() as Record<string, unknown>;
    assert(body.node_id === 'gpu-1' && body.free === 4 && typeof body.placement_id === 'string', \`the answer was \${r.text}, expected placement_id, node_id gpu-1 and free 4\`);
    const record = ctx.redis.hgetall(\`placement:\${body.placement_id}\`);
    assert(record.node_id === 'gpu-1' && record.count === '4', \`placement:\${body.placement_id} is \${JSON.stringify(record)}: the placement must be booked through allocate\`);
    assert.equal(ctx.redis.hget('node:gpu-1', 'allocated'), '4', "allocate must have moved node:gpu-1's allocated");
  } finally {
    restore();
  }
}

export async function check_unknown_type(ctx) {
  const {post, restore} = api(ctx);
  try {
    const fleetRead = ctx.redisAfter('nodes', () => 'read');
    let r = await post({...BODY, gpu_type: 'tpu'});
    assert.equal(r.status, 400, 'gpu_type tpu: an unknown type must be refused, not placed on whatever node is free');
    assert.equal(ctx.redis.hget('node:gpu-1', 'allocated'), '0', 'a refused request must not book a node');
    assert.deepEqual(ctx.redis.keys('placement:*'), [], 'a refused request must write no placement record');
    r = await post({...BODY, gpu_type: 7});
    assert.equal(r.status, 400, 'gpu_type 7');
    assert(!fleetRead.fired, 'a request refused for its gpu_type read the node set first: validate the body before any node is read');
    r = await post({...BODY, gpu_type: 'h100'});
    assert.equal(r.status, 409, "gpu_type h100 with only an a100 node live: a known type is placed only on a node of that type, never on another type's");
    assert(ctx.redis.hget('node:gpu-1', 'allocated') === '0' && ctx.redis.keys('placement:*').length === 0, 'an h100 request must not book the a100 node');
  } finally {
    restore();
  }
}

export async function check_capacity_ceiling(ctx) {
  const {post, restore} = api(ctx);
  try {
    for (const count of [9, 0, -1, 2.5, 'four', true, 4294967297]) {
      const r = await post({...BODY, count});
      assert.equal(r.status, 400, \`count \${JSON.stringify(count)} (an integer from 1 to MAX_NODE_GPUS = 8)\`);
    }
    assert(ctx.redis.hget('node:gpu-1', 'allocated') === '0' && ctx.redis.keys('placement:*').length === 0, 'no refused count may reach the ledger');
    for (const field of ['memory_gb', 'max_hourly_bid']) {
      const r = await post({...BODY, [field]: 'lots'});
      assert.equal(r.status, 400, \`\${field} 'lots'\`);
    }
    const r = await post({...BODY, count: 8});
    assert.equal(r.status, 201, \`count 8 on an idle 8-GPU node: \${r.text}\`);
  } finally {
    restore();
  }
}

export async function check_fresh_capacity(ctx) {
  const {post, restore} = api(ctx);
  try {
    // After boot: gpu-2 joins the fleet and gpu-1 fills up with placements from another replica.
    node(ctx, 'gpu-2');
    ctx.redis.hset('node:gpu-1', 'allocated', 8);
    let r = await post(BODY);
    assert.equal(r.status, 201, 'with gpu-1 full and gpu-2 idle: the node set must be read on every request, not at boot');
    assert.equal((r.json() as {node_id: string}).node_id, 'gpu-2', 'the node the request landed on (gpu-1 has 0 free)');
    ctx.redis.del('heartbeat:gpu-2');
    r = await post(BODY);
    assert.equal(r.status, 409, "with gpu-1 full and gpu-2's heartbeat lapsed");
    // gpu-2 reports in again (4 free), gpu-1 frees up to 2, gpu-3 joins idle (8 free).
    ctx.redis.set('heartbeat:gpu-2', '1', 'EX', 30);
    ctx.redis.hset('node:gpu-1', 'allocated', 6);
    node(ctx, 'gpu-3');
    const landedOn = (res: {json(): unknown}): unknown => {
      const answer = res.json();
      return answer !== null && typeof answer === 'object' && 'node_id' in answer ? answer.node_id : undefined;
    };
    r = await post({...BODY, count: 1});
    assert(r.status === 201 && landedOn(r) === 'gpu-3', \`with 2, 4 and 8 GPUs free on gpu-1, gpu-2 and gpu-3 the request answered \${r.status} \${r.text}, expected gpu-3: candidates are tried by free GPUs, most first\`);
    // Another replica fills gpu-3 right after this request read it.
    const filled = ctx.redisAfter('node:gpu-3', () => ctx.redis.hset('node:gpu-3', 'allocated', 8));
    r = await post({...BODY, count: 2});
    assert(filled.fired, 'the request never read node:gpu-3');
    assert(r.status === 201 && landedOn(r) === 'gpu-2', \`gpu-3 filled up between the read and allocate, so the ledger answered NO_CAPACITY there; the request answered \${r.status} \${r.text}, expected 201 on gpu-2 (4 free): the next candidate is tried, the first ALLOCATED wins\`);
  } finally {
    restore();
  }
}

export async function check_log_no_payload(ctx) {
  const {post, lines, restore} = api(ctx);
  try {
    const r = await post(BODY);
    assert.equal(r.status, 201, \`POST answered \${r.status}: \${r.text}\`);
    const {placement_id: placementId} = r.json() as {placement_id: string};
    assert(lines.length > 0, 'the placement must be logged (console.info)');
    for (const line of lines) {
      const bare = line.split(placementId).join(''); // a random id can contain "80"
      assert(!bare.includes('3.5') && !bare.includes('max_hourly_bid') && !bare.includes('80'), \`the log line \${JSON.stringify(line)} carries the request body: log ids and counts, the tenant's bid stays out of the log\`);
    }
    assert(lines.some(line => line.includes(placementId) && line.includes('gpu-1')), \`no log line names the placement id and the node id: \${JSON.stringify(lines)}\`);
  } finally {
    restore();
  }
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"os"
	"strings"

	"leetbuild/harness"
)

var hApiBody = map[string]any{"gpu_type": "a100", "count": 4, "memory_gb": 80, "max_hourly_bid": 3.5}

// apiNode is a registered node with a live heartbeat, as the ledger (step 2) writes it.
func hApiNode(ctx *harness.Ctx, id, gpuType string, capacity, allocatedGPUs int) {
	ctx.Redis.Do("HSET", "node:"+id, "gpu_type", gpuType, "capacity", capacity, "allocated", allocatedGPUs)
	ctx.Redis.Do("SADD", "nodes", id)
	ctx.Redis.Do("SET", "heartbeat:"+id, "1", "EX", 30)
}

// apiLedger stands in for allocate (state.go, step 2): the ledger's script.
func hApiLedger(ctx *harness.Ctx) {
	allocate = func(_ context.Context, nodeID, placementID string, count int) (string, error) {
		if ctx.Redis.Exists("heartbeat:"+nodeID) == 0 {
			return "NO_HEARTBEAT", nil
		}
		fields := ctx.Redis.HGetAll("node:" + nodeID)
		var capacity, allocatedGPUs int
		for _, v := range []struct {
			s string
			p *int
		}{{fields["capacity"], &capacity}, {fields["allocated"], &allocatedGPUs}} {
			for _, c := range v.s {
				*v.p = *v.p*10 + int(c-'0')
			}
		}
		if allocatedGPUs+count > capacity {
			return "NO_CAPACITY", nil
		}
		ctx.Redis.Do("HINCRBY", "node:"+nodeID, "allocated", count)
		ctx.Redis.Do("HSET", "placement:"+placementID, "node_id", nodeID, "count", count, "status", "allocated")
		ctx.Redis.Do("SADD", "node:"+nodeID+":placements", placementID)
		return "ALLOCATED", nil
	}
}

// apiBoot is the scheduler with gpu-1 (a100, 8 GPUs) registered before it boots, and its log captured.
func hApiBoot(ctx *harness.Ctx) (*harness.HTTP, *bytes.Buffer) {
	hApiNode(ctx, "gpu-1", "a100", 8, 0)
	hApiLedger(ctx)
	var logged bytes.Buffer
	log.SetOutput(&logged)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), &logged
}

func hApiWith(field string, value any) map[string]any {
	body := map[string]any{}
	for k, v := range hApiBody {
		body[k] = v
	}
	body[field] = value
	return body
}

func CheckRouteShape(ctx *harness.Ctx) {
	c, _ := hApiBoot(ctx)
	defer log.SetOutput(os.Stderr)
	r := c.Post("/v1/placements", hApiBody)
	ctx.Equal(r.Status, 201, "POST /v1/placements with a valid body (%s)", r.Text())
	body, _ := r.JSON().(map[string]any)
	pid, _ := body["placement_id"].(string)
	ctx.Assert(body["node_id"] == "gpu-1" && body["free"] == float64(4) && pid != "", "the answer was %s, expected placement_id, node_id gpu-1 and free 4", r.Text())
	record := ctx.Redis.HGetAll("placement:" + pid)
	ctx.Assert(record["node_id"] == "gpu-1" && record["count"] == "4", "placement:%s is %v: the placement must be booked through allocate", pid, record)
	allocatedGPUs, _ := ctx.Redis.HGet("node:gpu-1", "allocated")
	ctx.Equal(allocatedGPUs, "4", "allocate must have moved node:gpu-1's allocated")
}

func CheckUnknownType(ctx *harness.Ctx) {
	c, _ := hApiBoot(ctx)
	defer log.SetOutput(os.Stderr)
	fleetRead := ctx.Redis.After("nodes", func() any { return "read" })
	r := c.Post("/v1/placements", hApiWith("gpu_type", "tpu"))
	ctx.Equal(r.Status, 400, "gpu_type tpu: an unknown type must be refused, not placed on whatever node is free")
	allocatedGPUs, _ := ctx.Redis.HGet("node:gpu-1", "allocated")
	ctx.Equal(allocatedGPUs, "0", "a refused request must not book a node; allocated")
	ctx.Equal(len(ctx.Redis.Keys("placement:*")), 0, "a refused request must write no placement record; the records")
	r = c.Post("/v1/placements", hApiWith("gpu_type", 7))
	ctx.Equal(r.Status, 400, "gpu_type 7")
	ctx.Assert(!fleetRead.Fired, "a request refused for its gpu_type read the node set first: validate the body before any node is read")
	r = c.Post("/v1/placements", hApiWith("gpu_type", "h100"))
	ctx.Equal(r.Status, 409, "gpu_type h100 with only an a100 node live: a known type is placed only on a node of that type, never on another type's")
	allocatedGPUs, _ = ctx.Redis.HGet("node:gpu-1", "allocated")
	ctx.Assert(allocatedGPUs == "0" && len(ctx.Redis.Keys("placement:*")) == 0, "an h100 request must not book the a100 node")
}

func CheckCapacityCeiling(ctx *harness.Ctx) {
	c, _ := hApiBoot(ctx)
	defer log.SetOutput(os.Stderr)
	for _, count := range []any{9, 0, -1, 2.5, "four", true, 4294967297} {
		r := c.Post("/v1/placements", hApiWith("count", count))
		ctx.Equal(r.Status, 400, "count %v (an integer from 1 to MaxNodeGPUs = 8)", harness.Show(count))
	}
	allocatedGPUs, _ := ctx.Redis.HGet("node:gpu-1", "allocated")
	ctx.Assert(allocatedGPUs == "0" && len(ctx.Redis.Keys("placement:*")) == 0, "no refused count may reach the ledger")
	for _, field := range []string{"memory_gb", "max_hourly_bid"} {
		r := c.Post("/v1/placements", hApiWith(field, "lots"))
		ctx.Equal(r.Status, 400, "%s 'lots'", field)
	}
	r := c.Post("/v1/placements", hApiWith("count", 8))
	ctx.Equal(r.Status, 201, "count 8 on an idle 8-GPU node (%s)", r.Text())
}

func CheckFreshCapacity(ctx *harness.Ctx) {
	c, _ := hApiBoot(ctx)
	defer log.SetOutput(os.Stderr)
	// After boot: gpu-2 joins the fleet and gpu-1 fills up with placements from another replica.
	hApiNode(ctx, "gpu-2", "a100", 8, 0)
	ctx.Redis.Do("HSET", "node:gpu-1", "allocated", 8)
	r := c.Post("/v1/placements", hApiBody)
	ctx.Equal(r.Status, 201, "with gpu-1 full and gpu-2 idle: the node set must be read on every request, not at boot")
	body, _ := r.JSON().(map[string]any)
	ctx.Equal(body["node_id"], "gpu-2", "the node the request landed on (gpu-1 has 0 free)")
	ctx.Redis.Del("heartbeat:gpu-2")
	r = c.Post("/v1/placements", hApiBody)
	ctx.Equal(r.Status, 409, "with gpu-1 full and gpu-2's heartbeat lapsed")
	// gpu-2 reports in again (4 free), gpu-1 frees up to 2, gpu-3 joins idle (8 free).
	ctx.Redis.Do("SET", "heartbeat:gpu-2", "1", "EX", 30)
	ctx.Redis.Do("HSET", "node:gpu-1", "allocated", 6)
	hApiNode(ctx, "gpu-3", "a100", 8, 0)
	r = c.Post("/v1/placements", hApiWith("count", 1))
	ctx.Equal(r.Status, 201, "with 2, 4 and 8 GPUs free on gpu-1, gpu-2 and gpu-3 a request for 1 GPU (%s)", r.Text())
	body, _ = r.JSON().(map[string]any)
	ctx.Assert(body["node_id"] == "gpu-3", "with 2, 4 and 8 GPUs free on gpu-1, gpu-2 and gpu-3 the request landed on %v, expected gpu-3: candidates are tried by free GPUs, most first", body["node_id"])
	// Another replica fills gpu-3 right after this request read it.
	filled := ctx.Redis.After("node:gpu-3", func() any { return ctx.Redis.Do("HSET", "node:gpu-3", "allocated", 8) })
	r = c.Post("/v1/placements", hApiWith("count", 2))
	ctx.Assert(filled.Fired, "the request never read node:gpu-3")
	ctx.Equal(r.Status, 201, "gpu-3 filled up between the read and allocate, so the ledger answered NO_CAPACITY there (%s): the next candidate is tried, the first ALLOCATED wins", r.Text())
	body, _ = r.JSON().(map[string]any)
	ctx.Assert(body["node_id"] == "gpu-2", "gpu-3 filled up between the read and allocate; the request landed on %v, expected gpu-2 (4 free)", body["node_id"])
}

func CheckLogNoPayload(ctx *harness.Ctx) {
	c, logged := hApiBoot(ctx)
	defer log.SetOutput(os.Stderr)
	r := c.Post("/v1/placements", hApiBody)
	ctx.Equal(r.Status, 201, "POST (%s)", r.Text())
	body, _ := r.JSON().(map[string]any)
	pid, _ := body["placement_id"].(string)
	lines := strings.Split(strings.TrimSpace(logged.String()), "\\n")
	ctx.Assert(logged.Len() > 0, "the placement must be logged (log.Printf)")
	for _, line := range lines {
		bare := line // a random id can contain "80"
		if pid != "" {
			bare = strings.ReplaceAll(line, pid, "")
		}
		ctx.Assert(!strings.Contains(bare, "3.5") && !strings.Contains(bare, "max_hourly_bid") && !strings.Contains(bare, "MaxHourlyBid") && !strings.Contains(bare, "80"), "the log line %q carries the request body: log ids and counts, the tenant's bid stays out of the log", line)
	}
	named := false
	for _, line := range lines {
		named = named || (strings.Contains(line, pid) && strings.Contains(line, "gpu-1"))
	}
	ctx.Assert(named, "no log line names the placement id and the node id: %q", lines)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <atomic>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace {

harness::Ctx* hApiCtx = nullptr;

const nlohmann::json kHApiBody = {{"gpu_type", "a100"}, {"count", 4}, {"memory_gb", 80}, {"max_hourly_bid", 3.5}};

// A registered node with a live heartbeat, as the ledger (step 2) writes it.
void hApiNode(harness::Ctx& ctx, const std::string& id, const std::string& gpu_type = "a100", int capacity = 8, int allocated = 0) {
  ctx.Redis.Do("HSET", "node:" + id, "gpu_type", gpu_type, "capacity", capacity, "allocated", allocated);
  ctx.Redis.Do("SADD", "nodes", id);
  ctx.Redis.Do("SET", "heartbeat:" + id, "1", "EX", 30);
}

nlohmann::json hApiWith(const std::string& field, const nlohmann::json& value) {
  nlohmann::json body = kHApiBody;
  body[field] = value;
  return body;
}

struct HApiWorld {
  httplib::Server svr;
  std::ostringstream logged;
  std::streambuf* clog = nullptr;
  ~HApiWorld() {
    if (clog) std::clog.rdbuf(clog);
  }
};

HApiWorld* hApiWorld = nullptr;

// The scheduler with gpu-1 (a100, 8 GPUs) registered before it serves, and its log captured.
harness::HTTP hApiBoot(harness::Ctx& ctx) {
  delete hApiWorld;
  hApiWorld = new HApiWorld;
  hApiCtx = &ctx;
  hApiNode(ctx, "gpu-1");
  hApiWorld->clog = std::clog.rdbuf(hApiWorld->logged.rdbuf());
  register_routes(hApiWorld->svr);
  return ctx.HTTP(hApiWorld->svr);
}

// What the handler wrote to std::clog so far, line by line.
std::vector<std::string> hApiLines() {
  std::vector<std::string> lines;
  std::istringstream in(hApiWorld->logged.str());
  for (std::string line; std::getline(in, line);) lines.push_back(line);
  return lines;
}

harness::Response hApiPost(harness::HTTP& c, const nlohmann::json& body) {
  return c.Post("/v1/placements", body.dump(), "Content-Type", "application/json");
}

}  // namespace

// The ledger (state.cpp, step 2) as the harness stands in for it: its script.
std::string allocate(const std::string& node_id, const std::string& placement_id, int count) {
  harness::Ctx& ctx = *hApiCtx;
  if (ctx.Redis.Exists("heartbeat:" + node_id) == 0) return "NO_HEARTBEAT";
  const auto fields = ctx.Redis.HGetAll("node:" + node_id);
  const int capacity = fields.count("capacity") ? std::stoi(fields.at("capacity")) : 0;
  const int allocated = fields.count("allocated") ? std::stoi(fields.at("allocated")) : 0;
  if (allocated + count > capacity) return "NO_CAPACITY";
  ctx.Redis.Do("HINCRBY", "node:" + node_id, "allocated", count);
  ctx.Redis.Do("HSET", "placement:" + placement_id, "node_id", node_id, "count", count, "status", "allocated");
  ctx.Redis.Do("SADD", "node:" + node_id + ":placements", placement_id);
  return "ALLOCATED";
}

void CheckRouteShape(harness::Ctx& ctx) {
  auto c = hApiBoot(ctx);
  auto r = hApiPost(c, kHApiBody);
  ctx.Equal(r.Status, 201, "POST /v1/placements with a valid body (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  const std::string pid = body.is_object() ? body.value("placement_id", "") : "";
  ctx.Assert(body.is_object() && body.value("node_id", "") == "gpu-1" && body.value("free", -1) == 4 && !pid.empty(),
             "the answer was %s, expected placement_id, node_id gpu-1 and free 4", r.Text());
  const auto record = ctx.Redis.HGetAll("placement:" + pid);
  ctx.Assert(record.count("node_id") && record.at("node_id") == "gpu-1" && record.count("count") && record.at("count") == "4",
             "placement:%s is %v: the placement must be booked through allocate", pid, record);
  ctx.Equal(ctx.Redis.HGet("node:gpu-1", "allocated"), "4", "allocate must have moved node:gpu-1's allocated");
}

void CheckUnknownType(harness::Ctx& ctx) {
  auto c = hApiBoot(ctx);
  auto fleetRead = std::make_shared<std::atomic<bool>>(false);
  ctx.Redis.After("nodes", [fleetRead] { *fleetRead = true; });
  auto r = hApiPost(c, hApiWith("gpu_type", "tpu"));
  ctx.Equal(r.Status, 400, "gpu_type tpu: an unknown type must be refused, not placed on whatever node is free");
  ctx.Equal(ctx.Redis.HGet("node:gpu-1", "allocated"), "0", "a refused request must not book a node; allocated");
  ctx.Equal(ctx.Redis.Keys("placement:*").size(), 0, "a refused request must write no placement record; the records");
  r = hApiPost(c, hApiWith("gpu_type", 7));
  ctx.Equal(r.Status, 400, "gpu_type 7");
  ctx.Assert(!*fleetRead, "a request refused for its gpu_type read the node set first: validate the body before any node is read");
  r = hApiPost(c, hApiWith("gpu_type", "h100"));
  ctx.Equal(r.Status, 409, "gpu_type h100 with only an a100 node live: a known type is placed only on a node of that type, never on another type's");
  ctx.Assert(ctx.Redis.HGet("node:gpu-1", "allocated") == "0" && ctx.Redis.Keys("placement:*").empty(), "an h100 request must not book the a100 node");
}

void CheckCapacityCeiling(harness::Ctx& ctx) {
  auto c = hApiBoot(ctx);
  for (const nlohmann::json count : {nlohmann::json(9), nlohmann::json(0), nlohmann::json(-1), nlohmann::json(2.5), nlohmann::json("four"), nlohmann::json(true),
                                     nlohmann::json(4294967297LL)}) {
    auto r = hApiPost(c, hApiWith("count", count));
    ctx.Equal(r.Status, 400, "count %s (an integer from 1 to kMaxNodeGpus = 8)", count.dump());
  }
  ctx.Assert(ctx.Redis.HGet("node:gpu-1", "allocated") == "0" && ctx.Redis.Keys("placement:*").empty(), "no refused count may reach the ledger");
  for (const std::string field : {"memory_gb", "max_hourly_bid"}) {
    auto r = hApiPost(c, hApiWith(field, "lots"));
    ctx.Equal(r.Status, 400, "%s 'lots'", field);
  }
  auto r = hApiPost(c, hApiWith("count", 8));
  ctx.Equal(r.Status, 201, "count 8 on an idle 8-GPU node (%s)", r.Text());
}

void CheckFreshCapacity(harness::Ctx& ctx) {
  auto c = hApiBoot(ctx);
  // After boot: gpu-2 joins the fleet and gpu-1 fills up with placements from another replica.
  hApiNode(ctx, "gpu-2");
  ctx.Redis.Do("HSET", "node:gpu-1", "allocated", 8);
  auto r = hApiPost(c, kHApiBody);
  ctx.Equal(r.Status, 201, "with gpu-1 full and gpu-2 idle: the node set must be read on every request, not at boot");
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Equal(body.is_object() ? body.value("node_id", "") : "", "gpu-2", "the node the request landed on (gpu-1 has 0 free)");
  ctx.Redis.Del("heartbeat:gpu-2");
  r = hApiPost(c, kHApiBody);
  ctx.Equal(r.Status, 409, "with gpu-1 full and gpu-2's heartbeat lapsed");
  // gpu-2 reports in again (4 free), gpu-1 frees up to 2, gpu-3 joins idle (8 free).
  ctx.Redis.Do("SET", "heartbeat:gpu-2", "1", "EX", 30);
  ctx.Redis.Do("HSET", "node:gpu-1", "allocated", 6);
  hApiNode(ctx, "gpu-3");
  r = hApiPost(c, hApiWith("count", 1));
  ctx.Equal(r.Status, 201, "with 2, 4 and 8 GPUs free on gpu-1, gpu-2 and gpu-3 a request for 1 GPU (%s)", r.Text());
  auto landed = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Equal(landed.is_object() ? landed.value("node_id", "") : "", "gpu-3",
            "with 2, 4 and 8 GPUs free on gpu-1, gpu-2 and gpu-3 the node the request landed on (candidates are tried by free GPUs, most first)");
  // Another replica fills gpu-3 right after this request read it.
  auto filled = std::make_shared<std::atomic<bool>>(false);
  ctx.Redis.After("node:gpu-3", [&ctx, filled] {
    *filled = true;
    ctx.Redis.Do("HSET", "node:gpu-3", "allocated", 8);
  });
  r = hApiPost(c, hApiWith("count", 2));
  ctx.Assert(*filled, "the request never read node:gpu-3");
  ctx.Equal(r.Status, 201, "gpu-3 filled up between the read and allocate, so the ledger answered NO_CAPACITY there (%s): the next candidate is tried, the first ALLOCATED wins", r.Text());
  landed = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Equal(landed.is_object() ? landed.value("node_id", "") : "", "gpu-2", "gpu-3 filled up between the read and allocate; the node the request landed on (gpu-2 has 4 free)");
}

void CheckLogNoPayload(harness::Ctx& ctx) {
  auto c = hApiBoot(ctx);
  auto r = hApiPost(c, kHApiBody);
  ctx.Equal(r.Status, 201, "POST (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  const std::string pid = body.is_object() ? body.value("placement_id", "") : "";
  std::clog.flush();
  const std::vector<std::string> lines = hApiLines();
  ctx.Assert(!lines.empty(), "the placement must be logged (std::clog)");
  for (const auto& line : lines) {
    std::string bare = line;  // a random id can contain "80"
    if (!pid.empty())
      for (auto at = bare.find(pid); at != std::string::npos; at = bare.find(pid)) bare.erase(at, pid.size());
    ctx.Assert(bare.find("3.5") == std::string::npos && bare.find("max_hourly_bid") == std::string::npos && bare.find("80") == std::string::npos,
               "the log line %q carries the request body: log ids and counts, the tenant's bid stays out of the log", line);
  }
  bool named = false;
  for (const auto& line : lines) named = named || (line.find(pid) != std::string::npos && line.find("gpu-1") != std::string::npos);
  ctx.Assert(named, "no log line names the placement id and the node id: %q", lines);
}
`,
  },
  debrief: `Admission is cheap checks in cost order, then the fleet, then the ledger: a body that can be refused from its own fields is refused before Redis is touched, and a count above \`MAX_NODE_GPUS\` is a 400 rather than a 409 because the caller can fix the first and only wait on the second. Reading the node set per request costs a few round trips and buys a picture of the fleet as old as the request, not as old as the process; the ledger's script is still the only thing that books, so a stale read costs one refused attempt, not an oversubscribed node. The log carries ids and counts because a bid is the tenant's and a log line outlives the request. Production schedulers cache the node set with a short TTL, invalidated by registration events, and score candidates by fragmentation.`,
};
