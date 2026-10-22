import type {Step} from '@/lib/types';

export const neighborReadStep: Step = {
  id: 'read',
  title: 'GET /v1/entities/{id}/neighbors: traversal with hard stops',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the neighbour endpoint. It
registers the route, walks the graph and returns edges. It compiles, it answers for the demo graph,
and it hides three production flaws. Review it like the service owner, fix it, and prove the fix with
the checks below.

Implement \`GET /v1/entities/{id}/neighbors?depth=…\`:

- The tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when absent), and the entity
  must belong to that tenant: a foreign — or unknown — entity id is **404**.
- \`depth\` defaults to **1**. The maximum is **2**; a \`depth\` above \`MAX_DEPTH\` is **400**, never a
  deeper walk. Refuse the request instead of streaming the result.
- The traversal is **bounded breadth-first** over a \`frontier\` and a \`visited\` set; it never
  enumerates paths, so a hub entity cannot turn one request into millions of paths.
- The result is capped at **\`MAX_EDGES\` = 500** edges. When the cap truncates the walk the response
  still carries the 500 edges with \`truncated: true\`, so a caller can tell a complete answer from a
  clipped one.
- Read through the versioned adjacency cache from the earlier step; a cache miss or a stale version
  reloads from the graph store.

**Failure mode the checks target.** The draft accepts any \`depth\` the caller sends, then
materialises every path: on a hub entity the recursive walk visits the same node through an
exponential number of paths and one request becomes a combinatorial explosion that takes the service
down. It also never checks that the entity belongs to the caller's tenant, so any tenant that knows
an entity id can read another tenant's edges. And it has no edge cap, so even a legitimate depth-2
walk over a hub returns an unbounded body.`,
  sequence: {
    participants: ['Client', 'graph-api', 'Adjacency cache', 'Graph store'],
    messages: [
      {from: 'Client', to: 'graph-api', label: 'GET /v1/entities/{id}/neighbors?depth=2', kind: 'sync'},
      {from: 'graph-api', to: 'graph-api', label: '401 tenant · 400 depth · 404 owner', kind: 'sync'},
      {from: 'graph-api', to: 'Adjacency cache', label: 'GET adj:(tenant, entity)', kind: 'sync'},
      {from: 'Adjacency cache', to: 'graph-api', label: 'stamped list / miss', kind: 'reply'},
      {from: 'graph-api', to: 'Graph store', label: 'load neighbours (on miss)', kind: 'sync'},
      {from: 'Graph store', to: 'graph-api', label: 'neighbours', kind: 'reply'},
      {from: 'graph-api', to: 'Client', label: '200 edges · truncated marker', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/entities/{id}/neighbors',
      detail: 'Register the neighbour route on `GET /v1/entities/{id}/neighbors`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/entities\/\{entity_id\}\/neighbors["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/entities\/:entityId\/neighbors['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/entities\/\{entityID\}\/neighbors"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"entities"\s*\/\s*Segment\s*\/\s*"neighbors"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(R"\(\/v1\/entities/]},
      },
    },
    {
      id: 'depth-cap',
      title: 'Refuses depth above 2 with 400',
      detail:
        '`MAX_DEPTH = 2` and any `depth > MAX_DEPTH` is **400** before any traversal. The draft accepts an unbounded depth and walks it.',
      match: {
        python: {all: [/MAX_DEPTH\s*=\s*2/, /depth\s*>\s*MAX_DEPTH/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_DEPTH\s*=\s*2/, /depth\s*>\s*MAX_DEPTH/, /code\(\s*400\s*\)/]},
        go: {all: [/maxDepth\s*=\s*2/, /depth\s*>\s*maxDepth/, /StatusBadRequest/]},
        scala: {all: [/MaxDepth\s*=\s*2/, /depth\s*>\s*MaxDepth/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxDepth\s*=\s*2/, /depth\s*>\s*kMaxDepth/, /\b400\b/]},
      },
    },
    {
      id: 'edge-cap',
      title: 'Caps the result at 500 edges with a truncation marker',
      detail:
        '`MAX_EDGES = 500`; a walk that hits the cap stops and the response carries `truncated: true` so the caller knows the answer is clipped. The draft returns unbounded edges.',
      match: {
        python: {all: [/MAX_EDGES\s*=\s*500/, /truncated/]},
        typescript: {all: [/MAX_EDGES\s*=\s*500/, /truncated/]},
        go: {all: [/maxEdges\s*=\s*500/, /truncated/]},
        scala: {all: [/MaxEdges\s*=\s*500/, /truncated/]},
        cpp: {all: [/kMaxEdges\s*=\s*500/, /truncated/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'A foreign or unknown entity id is 404',
      detail:
        'The endpoint resolves the entity’s owning tenant (`entity_tenant`) and answers **404** when it is unknown or belongs to someone else. The draft returns any tenant’s edges whenever the id is known.',
      match: {
        python: {all: [/entity_tenant\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/entityTenant\(/, /code\(\s*404\s*\)/]},
        go: {all: [/EntityTenant\(/, /StatusNotFound/]},
        scala: {all: [/entityTenant\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/entityTenant\(/, /\b404\b/]},
      },
    },
    {
      id: 'bounded-traversal',
      title: 'Traverses breadth-first with a frontier and a visited set',
      detail:
        '`neighbors` walks level by level with a `frontier` and a `visited` set, so each node is expanded once. The draft recurses over paths and expands a hub exponentially.',
      match: {
        python: {all: [/def neighbors\(/, /visited/, /frontier/]},
        typescript: {all: [/function neighbors\(/, /visited/, /frontier/]},
        go: {all: [/func neighbors\(/, /visited/, /frontier/]},
        scala: {all: [/def neighbors\(/, /visited/, /frontier/]},
        cpp: {all: [/neighbors\(/, /visited/, /frontier/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("graph")


class GraphStore:
    def load_neighbors(self, tenant: str, entity_id: str) -> list[str]:
        raise NotImplementedError


store = GraphStore()


def read_neighbors(entity_id: str, depth: int = 5) -> JSONResponse:
    # TODO: this draft accepts an unbounded depth, materialises every path to a hub entity, and
    # returns edges from any tenant when the entity id is known. Review all three.
    edges: list[str] = []

    def walk(node: str, remaining: int) -> None:
        if remaining <= 0:
            return
        for neighbor in store.load_neighbors("default", node):
            edges.append(neighbor)
            walk(neighbor, remaining - 1)

    walk(entity_id, depth)
    logger.info("neighbors entity=%s edges=%d", entity_id, len(edges))
    return JSONResponse({"edges": edges}, status_code=200)


app.get("/v1/entities/{entity_id}/neighbors")(read_neighbors)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("graph")

MAX_DEPTH = 2
MAX_EDGES = 500


class GraphStore:
    def entity_tenant(self, entity_id: str) -> str | None:
        """The tenant that owns \`entity_id\`, or None when the graph has no such entity."""
        raise NotImplementedError

    def load_neighbors(self, tenant: str, entity_id: str) -> list[str]:
        raise NotImplementedError


store = GraphStore()


def neighbors(tenant: str, root: str, depth: int) -> tuple[list[str], bool]:
    """Breadth-first to \`depth\`, stopping at MAX_EDGES; each node is expanded once."""
    edges: list[str] = []
    visited: set[str] = {root}
    frontier: list[str] = [root]
    for _ in range(depth):
        next_frontier: list[str] = []
        for node in frontier:
            for neighbor in store.load_neighbors(tenant, node):
                if len(edges) >= MAX_EDGES:
                    return edges, True
                edges.append(neighbor)
                if neighbor not in visited:
                    visited.add(neighbor)
                    next_frontier.append(neighbor)
        frontier = next_frontier
    return edges, False


@app.get("/v1/entities/{entity_id}/neighbors")
def read_neighbors(
    entity_id: str,
    depth: int = 1,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if depth < 1 or depth > MAX_DEPTH:
        raise HTTPException(status_code=400, detail=f"depth must be 1..{MAX_DEPTH}")
    owner = store.entity_tenant(entity_id)
    if owner is None or owner != tenant:
        raise HTTPException(status_code=404, detail="unknown entity")
    edges, truncated = neighbors(tenant, entity_id, depth)
    logger.info("neighbors tenant=%s entity=%s edges=%d truncated=%s", tenant, entity_id, len(edges), truncated)
    return JSONResponse({"entity_id": entity_id, "edges": edges, "truncated": truncated}, status_code=200)
`,
    },
    typescript: {
      starter: `/** Neighbour read: a model-generated draft that walks every path. */
import Fastify from 'fastify';

import {store} from './graph';

export const app = Fastify();

async function walk(node: string, remaining: number, edges: string[]): Promise<void> {
  if (remaining <= 0) return;
  for (const neighbor of await store.loadNeighbors('default', node)) {
    edges.push(neighbor);
    await walk(neighbor, remaining - 1, edges);
  }
}

app.get('/v1/entities/:entityId/neighbors', async (request, reply) => {
  // TODO: this draft accepts an unbounded depth, materialises every path to a hub entity, and
  // returns edges from any tenant when the entity id is known. Review all three.
  const entityId = (request.params as {entityId: string}).entityId;
  const depth = Number((request.query as {depth?: string}).depth ?? '5');
  const edges: string[] = [];
  await walk(entityId, depth, edges);
  request.log.info({entityId, edges: edges.length}, 'neighbors');
  return reply.code(200).send({edges});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Neighbour read: depth-capped, tenant-scoped, breadth-first with a 500-edge stop. */
import Fastify from 'fastify';

import {store} from './graph';

export const app = Fastify();

const MAX_DEPTH = 2;
const MAX_EDGES = 500;

interface NeighborPage {
  edges: string[];
  truncated: boolean;
}

async function neighbors(tenant: string, root: string, depth: number): Promise<NeighborPage> {
  const edges: string[] = [];
  const visited = new Set<string>([root]);
  let frontier = [root];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of await store.loadNeighbors(tenant, node)) {
        if (edges.length >= MAX_EDGES) return {edges, truncated: true};
        edges.push(neighbor);
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return {edges, truncated: false};
}

app.get('/v1/entities/:entityId/neighbors', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const entityId = (request.params as {entityId: string}).entityId;
  const depth = Number((request.query as {depth?: string}).depth ?? '1');
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH)
    return reply.code(400).send({error: 'depth must be 1..' + MAX_DEPTH});
  const owner = await store.entityTenant(entityId);
  if (owner === null || owner !== tenant) return reply.code(404).send({error: 'unknown entity'});
  const page = await neighbors(tenant, entityId, depth);
  request.log.info({tenant, entityId, edges: page.edges.length, truncated: page.truncated}, 'neighbors');
  return reply.code(200).send({entity_id: entityId, edges: page.edges, truncated: page.truncated});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package read

import (
	"encoding/json"
	"log"
	"net/http"
)

type GraphStore interface {
	LoadNeighbors(tenant, entityID string) ([]string, error)
}

var store GraphStore

func walk(tenant, node string, remaining int, edges *[]string) {
	if remaining <= 0 {
		return
	}
	neighbors, _ := store.LoadNeighbors(tenant, node)
	for _, neighbor := range neighbors {
		*edges = append(*edges, neighbor)
		walk(tenant, neighbor, remaining-1, edges)
	}
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readNeighbors(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft accepts an unbounded depth, materialises every path to a hub entity, and
	// returns edges from any tenant when the entity id is known. Review all three.
	entityID := r.PathValue("entityID")
	edges := make([]string, 0)
	walk("default", entityID, 5, &edges)
	log.Printf("neighbors entity=%s edges=%d", entityID, len(edges))
	writeJSON(rw, http.StatusOK, map[string]any{"edges": edges})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/entities/{entityID}/neighbors", readNeighbors)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package read

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

const maxDepth = 2
const maxEdges = 500

type GraphStore interface {
	EntityTenant(ctx context.Context, entityID string) (string, bool)
	LoadNeighbors(ctx context.Context, tenant, entityID string) ([]string, error)
}

var store GraphStore

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

// Breadth-first to depth, stopping at maxEdges; each node is expanded once.
func neighbors(ctx context.Context, tenant, root string, depth int) ([]string, bool) {
	edges := make([]string, 0)
	visited := map[string]bool{root: true}
	frontier := []string{root}
	for level := 0; level < depth; level++ {
		next := make([]string, 0)
		for _, node := range frontier {
			loaded, err := store.LoadNeighbors(ctx, tenant, node)
			if err != nil {
				return edges, false
			}
			for _, neighbor := range loaded {
				if len(edges) >= maxEdges {
					return edges, true
				}
				edges = append(edges, neighbor)
				if !visited[neighbor] {
					visited[neighbor] = true
					next = append(next, neighbor)
				}
			}
		}
		frontier = next
	}
	return edges, false
}

func readNeighbors(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	entityID := r.PathValue("entityID")
	depth, err := strconv.Atoi(r.URL.Query().Get("depth"))
	if err != nil {
		depth = 1
	}
	if depth < 1 || depth > maxDepth {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "depth must be 1..2"})
		return
	}
	owner, ok := store.EntityTenant(r.Context(), entityID)
	if !ok || owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown entity"})
		return
	}
	edges, truncated := neighbors(r.Context(), tenant, entityID, depth)
	log.Printf("neighbors tenant=%s entity=%s edges=%d truncated=%t", tenant, entityID, len(edges), truncated)
	writeJSON(rw, http.StatusOK, map[string]any{"entity_id": entityID, "edges": edges, "truncated": truncated})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/entities/{entityID}/neighbors", readNeighbors)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object NeighborRead {
  implicit val system: ActorSystem = ActorSystem("knowledge-graph")

  def walk(tenant: String, node: String, remaining: Int, edges: List[String]): List[String] = {
    if (remaining <= 0) edges
    else loadNeighbors(tenant, node).foldLeft(edges) { (acc, neighbor) =>
      walk(tenant, neighbor, remaining - 1, acc :+ neighbor)
    }
  }

  val route: Route =
    path("v1" / "entities" / Segment / "neighbors") { entityId =>
      get {
        // TODO: this draft accepts an unbounded depth, materialises every path to a hub entity, and
        // returns edges from any tenant when the entity id is known. Review all three.
        val edges = walk("default", entityId, 5, Nil)
        complete(StatusCodes.OK, s"""{"edges":\${edges.size}}""")
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object NeighborRead {
  implicit val system: ActorSystem = ActorSystem("knowledge-graph")

  val MaxDepth = 2
  val MaxEdges = 500

  /** Breadth-first to depth, stopping at MaxEdges; each node is expanded once. */
  def neighbors(tenant: String, root: String, depth: Int): (List[String], Boolean) = {
    var edges = List.empty[String]
    var visited = Set(root)
    var frontier = List(root)
    var level = 0
    var truncated = false
    while (level < depth && !truncated) {
      val next = frontier.flatMap(node => loadNeighbors(tenant, node)).flatMap { neighbor =>
        if (edges.length >= MaxEdges) {
          truncated = true
          None
        } else if (visited.contains(neighbor)) {
          edges = edges :+ neighbor
          None
        } else {
          edges = edges :+ neighbor
          visited = visited + neighbor
          Some(neighbor)
        }
      }
      frontier = next
      level += 1
    }
    (edges, truncated)
  }

  val route: Route =
    path("v1" / "entities" / Segment / "neighbors") { entityId =>
      get {
        parameter("depth".as[Int].?) { depthOpt =>
          optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
            val depth = depthOpt.getOrElse(1)
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (depth < 1 || depth > MaxDepth) {
              complete(StatusCodes.BadRequest, "{\\"error\\":\\"depth must be 1.." + MaxDepth + "\\"}")
            } else {
              val tenant = tenantOpt.get
              entityTenant(entityId) match {
                case Some(owner) if owner == tenant =>
                  val (edges, truncated) = neighbors(tenant, entityId, depth)
                  complete(
                    StatusCodes.OK,
                    s"""{"entity_id":"$entityId","edges":\${edges.size},"truncated":$truncated}""",
                  )
                case _ =>
                  complete(StatusCodes.NotFound, """{"error":"unknown entity"}""")
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

#include <string>
#include <vector>

using json = nlohmann::json;

std::vector<std::string> loadNeighbors(const std::string& tenant, const std::string& entityId);

void walk(const std::string& tenant, const std::string& node, int remaining, std::vector<std::string>& edges) {
  if (remaining <= 0) return;
  for (const auto& neighbor : loadNeighbors(tenant, node)) {
    edges.push_back(neighbor);
    walk(tenant, neighbor, remaining - 1, edges);
  }
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/entities/([^/]+)/neighbors)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft accepts an unbounded depth, materialises every path to a hub entity, and
    // returns edges from any tenant when the entity id is known. Review all three.
    const std::string entityId = req.matches[1];
    const int depth = req.has_param("depth") ? std::stoi(req.get_param_value("depth")) : 5;
    std::vector<std::string> edges;
    walk("default", entityId, depth, edges);
    res.status = 200;
    res.set_content(json{{"edges", edges}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxDepth = 2;
constexpr std::size_t kMaxEdges = 500;

std::vector<std::string> loadNeighbors(const std::string& tenant, const std::string& entityId);
std::optional<std::string> entityTenant(const std::string& entityId);

struct NeighborPage {
  std::vector<std::string> edges;
  bool truncated = false;
};

/** Breadth-first to depth, stopping at kMaxEdges; each node is expanded once. */
NeighborPage neighbors(const std::string& tenant, const std::string& root, int depth) {
  NeighborPage page;
  std::set<std::string> visited{root};
  std::vector<std::string> frontier{root};
  for (int level = 0; level < depth; ++level) {
    std::vector<std::string> next;
    for (const auto& node : frontier) {
      for (const auto& neighbor : loadNeighbors(tenant, node)) {
        if (page.edges.size() >= kMaxEdges) {
          page.truncated = true;
          return page;
        }
        page.edges.push_back(neighbor);
        if (visited.insert(neighbor).second) next.push_back(neighbor);
      }
    }
    frontier = next;
  }
  return page;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/entities/([^/]+)/neighbors)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const int depth = req.has_param("depth") ? std::stoi(req.get_param_value("depth")) : 1;
    if (depth < 1 || depth > kMaxDepth) {
      res.status = 400;
      res.set_content(R"({"error":"depth must be 1..2"})", "application/json");
      return;
    }
    const std::string entityId = req.matches[1];
    const auto owner = entityTenant(entityId);
    if (!owner.has_value() || *owner != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown entity"})", "application/json");
      return;
    }
    const NeighborPage page = neighbors(tenant, entityId, depth);
    res.status = 200;
    res.set_content(
        json{{"entity_id", entityId}, {"edges", page.edges}, {"truncated", page.truncated}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate before you traverse: tenant (401), `depth` range (400), entity ownership (404). All three are cheap lookups; the expensive walk must be unreachable for a bad request.',
    'A depth cap without a node cap still explodes: a hub with 10 000 neighbours at depth 2 streams millions of edges. Walk a level at a time with a `frontier`, keep a `visited` set so each node is expanded once, and stop at `MAX_EDGES` with a `truncated` marker so the caller knows the answer is clipped.',
    'Ownership is not optional: resolve the entity’s tenant and compare it to the caller’s before loading a single edge. An entity id is guessable; the tenant is the authorisation boundary, not the id.',
  ],
  debrief: `The interviewer is testing whether you can put hard stops in front of a graph traversal. Three defects are checked. An unbounded depth is a denial-of-service waiting for a hub: recursion over paths turns one request into a combinatorial explosion, so the depth cap and the breadth-first frontier are what keep the cost polynomial. The tenant check is the authorisation boundary: an entity id is not a capability, and returning another tenant's edges because the id is known is a data leak. The 500-edge cap with a \`truncated\` marker keeps a legitimate depth-2 walk over a hub from returning an unbounded body while still telling the caller the answer is clipped. Real systems add per-tenant rate limits on the endpoint, a total-node budget as well as an edge budget, keyset pagination for the truncated case, and a cached adjacency list so a hot entity does not re-read the store on every request.`,
};
