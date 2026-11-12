import type {Step} from '@/lib/types';

export const neighborReadStep: Step = {
  id: 'read',
  title: 'GET /v1/entities/{id}/neighbors: a bounded walk inside the tenant',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'db', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/entities/{id}/neighbors?depth=\` on the adjacency
cache (\`graph.adjacency.read_neighbors\`, step 2, provided). It reads the tenant from
\`X-Tenant-Id\` (401 without it), answers 404 for an unknown entity, defaults \`depth\` to 2 and
walks recursively from the entity, answering
\`{"entity_id", "depth", "neighbors": [{"id", "distance"}], "truncated": false}\`. It serves the
demo and hides four flaws.

**Failure mode the checks target.** Any tenant reads another tenant's graph by id; a request with
\`depth=6\` on a hub takes the service down; the walk lists the same entity many times, the entity
itself included; and a hub with thousands of neighbours answers all of them.

- An entity whose \`tenant\` is not the caller's is **404**, the same answer as an unknown id.
- \`depth\` defaults to **1**; a depth that is not a number from 1 to \`MAX_DEPTH\` (2) is **400**
  before any traversal.
- The walk is breadth-first over a \`frontier\` with a \`visited\` set: each entity once, at its
  shortest distance, never the entity itself.
- At most \`MAX_RESULTS\` (500) neighbours; a walk that had more answers the first 500 with
  \`truncated: true\`.`,
  sequence: {
    participants: ['Client', 'graph-api', 'Graph store', 'Adjacency cache'],
    messages: [
      {from: 'Client', to: 'graph-api', label: 'GET /v1/entities/e-1/neighbors?depth=2 · X-Tenant-Id', kind: 'sync'},
      {from: 'graph-api', to: 'Graph store', label: 'get_entity(e-1) → tenant', kind: 'sync'},
      {from: 'graph-api', to: 'Client', label: '404 another tenant · 400 depth outside 1..2', kind: 'reply'},
      {from: 'graph-api', to: 'Adjacency cache', label: 'read_neighbors(node) per frontier node', kind: 'sync'},
      {from: 'graph-api', to: 'graph-api', label: 'skip visited · stop at 500', kind: 'sync'},
      {from: 'graph-api', to: 'Client', label: '200 neighbors [{id, distance}] · truncated', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/entities/{id}/neighbors on the adjacency cache',
      detail:
        'Register the route, read the tenant from `X-Tenant-Id` and answer the entity’s neighbours with their distance, read through `read_neighbors`/`readNeighbors`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/entities\/\{entity_id\}\/neighbors["']/, /read_neighbors\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/entities\/:\w+\/neighbors['"]/, /readNeighbors\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/entities\/\{\w+\}\/neighbors"/, /adjacency\.ReadNeighbors\(/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"entities"\s*\/\s*Segment\s*\/\s*"neighbors"\s*\)/, /Adjacency\.readNeighbors\(/],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/entities\/[^"]*\/neighbors\)"/, /adjacency::readNeighbors\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Another tenant’s entity is 404',
      detail:
        'The entity’s `tenant` is compared with `X-Tenant-Id` and a mismatch answers 404, as an unknown id does; the starter only checks that the entity exists.',
      match: {
        python: {all: [/\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*\w+\[["']tenant["']\]/, /\b404\b/]},
        typescript: {all: [/\.tenant\s*!==\s*tenant|tenant\s*!==\s*\w+\.tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/\.Tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.Tenant/, /StatusNotFound|\b404\b/]},
        scala: {all: [/\.tenant\s*==\s*tenant|tenant\s*==\s*\w+\.tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/->tenant\s*!=\s*tenant|tenant\s*!=\s*\w+->tenant/, /\b404\b/]},
      },
    },
    {
      id: 'depth-cap',
      title: 'Depth defaults to 1 and above 2 is 400',
      detail:
        '`depth` defaults to 1 and anything outside 1..`MAX_DEPTH` (2) answers 400 before the walk; the starter defaults to 2 and walks whatever depth it is given.',
      match: {
        python: {all: [/MAX_DEPTH\s*=\s*2\b/, /\b400\b/]},
        typescript: {all: [/MAX_DEPTH\s*=\s*2\b/, /code\(\s*400\s*\)/]},
        go: {all: [/maxDepth\s*=\s*2\b/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/MaxDepth\s*=\s*2\b/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxDepth\s*=\s*2\b/, /\b400\b/]},
      },
    },
    {
      id: 'bounded-traversal',
      title: 'Walks breadth-first with a visited set',
      detail:
        'A `frontier` per distance and a `visited` set seeded with the entity: each neighbour appears once at its shortest distance. The starter recurses into every neighbour, so paths are enumerated and the entity lists itself.',
      match: {
        python: {all: [/visited/, /frontier/], none: [/walk\(\s*neighbor/]},
        typescript: {all: [/visited/, /frontier/], none: [/walk\(\s*neighbor/]},
        go: {all: [/visited/, /frontier/], none: [/walk\(\s*neighbor/]},
        scala: {all: [/visited/, /frontier/], none: [/walk\(\s*neighbor/]},
        cpp: {all: [/visited/, /frontier/], none: [/walk\(\s*neighbor/]},
      },
    },
    {
      id: 'result-cap',
      title: 'Caps the answer at 500 neighbours with a truncation marker',
      detail:
        'The walk stops at `MAX_RESULTS` (500) and answers `truncated: true` when more neighbours were left; the starter answers every neighbour and always says `false`.',
      match: {
        python: {all: [/MAX_RESULTS\s*=\s*500\b/, /len\(\w+\)\s*(==|>=)\s*MAX_RESULTS/]},
        typescript: {all: [/MAX_RESULTS\s*=\s*500\b/, /\.length\s*(===|>=)\s*MAX_RESULTS/]},
        go: {all: [/maxResults\s*=\s*500\b/, /len\(\w+\)\s*(==|>=)\s*maxResults/]},
        scala: {all: [/MaxResults\s*=\s*500\b/, /\.size\s*(==|>=)\s*MaxResults/]},
        cpp: {all: [/kMaxResults\s*=\s*500\b/, /\.size\(\)\s*(==|>=)\s*kMaxResults/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from graph import store  # get_entity
from graph.adjacency import read_neighbors

app = FastAPI()


@app.get("/v1/entities/{entity_id}/neighbors")
def neighbors(entity_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    if store.get_entity(entity_id) is None:
        return JSONResponse({"error": "no such entity"}, status_code=404)
    depth = int(request.query_params.get("depth", "2"))
    found = []

    def walk(node: str, distance: int) -> None:
        if distance > depth:
            return
        for neighbor in read_neighbors(node):
            found.append({"id": neighbor, "distance": distance})
            walk(neighbor, distance + 1)

    walk(entity_id, 1)
    return JSONResponse({"entity_id": entity_id, "depth": depth, "neighbors": found, "truncated": False})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from graph import store  # get_entity
from graph.adjacency import read_neighbors

app = FastAPI()

MAX_DEPTH = 2
MAX_RESULTS = 500


def walk(entity_id: str, depth: int) -> tuple[list[dict], bool]:
    """Breadth-first from entity_id: each entity once, at its shortest distance, at most MAX_RESULTS."""
    found = []
    visited = {entity_id}
    frontier = [entity_id]
    for distance in range(1, depth + 1):
        next_frontier = []
        for node in frontier:
            for neighbor in read_neighbors(node):
                if neighbor in visited:
                    continue
                if len(found) == MAX_RESULTS:
                    return found, True
                visited.add(neighbor)
                found.append({"id": neighbor, "distance": distance})
                next_frontier.append(neighbor)
        frontier = next_frontier
    return found, False


@app.get("/v1/entities/{entity_id}/neighbors")
def neighbors(entity_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    entity = store.get_entity(entity_id)
    if entity is None or entity["tenant"] != tenant:
        # Another tenant's entity is as absent as one that never existed.
        return JSONResponse({"error": "no such entity"}, status_code=404)
    raw = request.query_params.get("depth", "1")
    depth = int(raw) if raw.isdigit() else 0
    if not 1 <= depth <= MAX_DEPTH:
        return JSONResponse({"error": f"depth must be between 1 and {MAX_DEPTH}"}, status_code=400)
    found, truncated = walk(entity_id, depth)
    return JSONResponse({"entity_id": entity_id, "depth": depth, "neighbors": found, "truncated": truncated})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {readNeighbors} from 'graph/adjacency';
import {getEntity} from 'graph/store';

export const app = Fastify();

interface Found {
  id: string;
  distance: number;
}

app.get('/v1/entities/:entityId/neighbors', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {entityId} = request.params as {entityId: string};
  if ((await getEntity(entityId)) === null) return reply.code(404).send({error: 'no such entity'});
  const depth = Number((request.query as {depth?: string}).depth ?? '2');
  const found: Found[] = [];
  const walk = async (node: string, distance: number): Promise<void> => {
    if (distance > depth) return;
    for (const neighbor of await readNeighbors(node)) {
      found.push({id: neighbor, distance});
      await walk(neighbor, distance + 1);
    }
  };
  await walk(entityId, 1);
  return {entity_id: entityId, depth, neighbors: found, truncated: false};
});
`,
      solution: `import Fastify from 'fastify';

import {readNeighbors} from 'graph/adjacency';
import {getEntity} from 'graph/store';

export const app = Fastify();

const MAX_DEPTH = 2;
const MAX_RESULTS = 500;

interface Found {
  id: string;
  distance: number;
}

/** Breadth-first from entityId: each entity once, at its shortest distance, at most MAX_RESULTS. */
async function walk(entityId: string, depth: number): Promise<{found: Found[]; truncated: boolean}> {
  const found: Found[] = [];
  const visited = new Set([entityId]);
  let frontier = [entityId];
  for (let distance = 1; distance <= depth; distance++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of await readNeighbors(node)) {
        if (visited.has(neighbor)) continue;
        if (found.length === MAX_RESULTS) return {found, truncated: true};
        visited.add(neighbor);
        found.push({id: neighbor, distance});
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return {found, truncated: false};
}

app.get('/v1/entities/:entityId/neighbors', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {entityId} = request.params as {entityId: string};
  const entity = await getEntity(entityId);
  // Another tenant's entity is as absent as one that never existed.
  if (entity === null || entity.tenant !== tenant) return reply.code(404).send({error: 'no such entity'});
  const raw = (request.query as {depth?: string}).depth ?? '1';
  const depth = /^\\d+$/.test(raw) ? Number(raw) : 0;
  if (depth < 1 || depth > MAX_DEPTH) return reply.code(400).send({error: \`depth must be between 1 and \${MAX_DEPTH}\`});
  const {found, truncated} = await walk(entityId, depth);
  return {entity_id: entityId, depth, neighbors: found, truncated};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"graph/adjacency" // adjacency.ReadNeighbors
	"graph/store"     // store.GetEntity
)

type found struct {
	ID       string \`json:"id"\`
	Distance int    \`json:"distance"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func neighbors(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	entityID := r.PathValue("id")
	if store.GetEntity(r.Context(), entityID) == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such entity"})
		return
	}
	depth := 2
	if raw := r.URL.Query().Get("depth"); raw != "" {
		depth, _ = strconv.Atoi(raw)
	}
	out := []found{}
	var walk func(node string, distance int) error
	walk = func(node string, distance int) error {
		if distance > depth {
			return nil
		}
		ids, err := adjacency.ReadNeighbors(r.Context(), node)
		if err != nil {
			return err
		}
		for _, neighbor := range ids {
			out = append(out, found{ID: neighbor, Distance: distance})
			if err := walk(neighbor, distance+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(entityID, 1); err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"entity_id": entityID, "depth": depth, "neighbors": out, "truncated": false})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/entities/{id}/neighbors", neighbors)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"graph/adjacency" // adjacency.ReadNeighbors
	"graph/store"     // store.GetEntity
)

const (
	maxDepth   = 2
	maxResults = 500
)

type found struct {
	ID       string \`json:"id"\`
	Distance int    \`json:"distance"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// walk goes breadth-first from entityID: each entity once, at its shortest distance, at most maxResults.
func walk(ctx context.Context, entityID string, depth int) ([]found, bool, error) {
	out := []found{}
	visited := map[string]bool{entityID: true}
	frontier := []string{entityID}
	for distance := 1; distance <= depth; distance++ {
		next := []string{}
		for _, node := range frontier {
			ids, err := adjacency.ReadNeighbors(ctx, node)
			if err != nil {
				return nil, false, err
			}
			for _, neighbor := range ids {
				if visited[neighbor] {
					continue
				}
				if len(out) == maxResults {
					return out, true, nil
				}
				visited[neighbor] = true
				out = append(out, found{ID: neighbor, Distance: distance})
				next = append(next, neighbor)
			}
		}
		frontier = next
	}
	return out, false, nil
}

func neighbors(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	entityID := r.PathValue("id")
	entity := store.GetEntity(r.Context(), entityID)
	if entity == nil || entity.Tenant != tenant {
		// Another tenant's entity is as absent as one that never existed.
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such entity"})
		return
	}
	raw := r.URL.Query().Get("depth")
	if raw == "" {
		raw = "1"
	}
	depth, err := strconv.Atoi(raw)
	if err != nil || depth < 1 || depth > maxDepth {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("depth must be between 1 and %d", maxDepth)})
		return
	}
	out, truncated, err := walk(r.Context(), entityID, depth)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"entity_id": entityID, "depth": depth, "neighbors": out, "truncated": truncated})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/entities/{id}/neighbors", neighbors)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import graph.{Adjacency, Store} // Adjacency.readNeighbors, Store.getEntity

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def read(tenant: String, entityId: String, raw: Option[String]): HttpResponse =
    Store.getEntity(entityId) match {
      case None => json(StatusCodes.NotFound, JsObject("error" -> JsString("no such entity")))
      case Some(_) =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val depth = raw.map(_.toInt).getOrElse(2)
        val found = scala.collection.mutable.ListBuffer.empty[JsObject]
        def walk(node: String, distance: Int): Unit =
          if (distance <= depth) Adjacency.readNeighbors(node).foreach { neighbor =>
            found += JsObject("id" -> JsString(neighbor), "distance" -> JsNumber(distance))
            walk(neighbor, distance + 1)
          }
        walk(entityId, 1)
        json(
          StatusCodes.OK,
          JsObject("entity_id" -> JsString(entityId), "depth" -> JsNumber(depth), "neighbors" -> JsArray(found.toVector), "truncated" -> JsBoolean(false)))
    }

  val route: Route = path("v1" / "entities" / Segment / "neighbors") { entityId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant)    => parameter("depth".optional) { raw => complete(read(tenant, entityId, raw)) }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import scala.collection.mutable

import graph.{Adjacency, Store} // Adjacency.readNeighbors, Store.getEntity

object Read {
  val MaxDepth = 2
  val MaxResults = 500

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** Breadth-first from entityId: each entity once, at its shortest distance, at most MaxResults. */
  def walk(entityId: String, depth: Int): (List[JsObject], Boolean) = {
    val found = mutable.ListBuffer.empty[JsObject]
    val visited = mutable.Set(entityId)
    var frontier = List(entityId)
    var truncated = false
    var distance = 1
    while (distance <= depth && !truncated) {
      val next = mutable.ListBuffer.empty[String]
      val nodes = frontier.iterator
      while (nodes.hasNext && !truncated) {
        val ids = Adjacency.readNeighbors(nodes.next()).iterator
        while (ids.hasNext && !truncated) {
          val neighbor = ids.next()
          if (!visited.contains(neighbor)) {
            if (found.size == MaxResults) truncated = true
            else {
              visited += neighbor
              found += JsObject("id" -> JsString(neighbor), "distance" -> JsNumber(distance))
              next += neighbor
            }
          }
        }
      }
      frontier = next.toList
      distance += 1
    }
    (found.toList, truncated)
  }

  private def read(tenant: String, entityId: String, raw: Option[String]): HttpResponse =
    Store.getEntity(entityId).filter(_.tenant == tenant) match {
      // Another tenant's entity is as absent as one that never existed.
      case None => json(StatusCodes.NotFound, JsObject("error" -> JsString("no such entity")))
      case Some(_) =>
        raw.getOrElse("1").toIntOption.filter(d => d >= 1 && d <= MaxDepth) match {
          case None => json(StatusCodes.BadRequest, JsObject("error" -> JsString(s"depth must be between 1 and $MaxDepth")))
          case Some(depth) =>
            val (found, truncated) = walk(entityId, depth)
            json(
              StatusCodes.OK,
              JsObject("entity_id" -> JsString(entityId), "depth" -> JsNumber(depth), "neighbors" -> JsArray(found.toVector), "truncated" -> JsBoolean(truncated)))
        }
    }

  val route: Route = path("v1" / "entities" / Segment / "neighbors") { entityId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant)    => parameter("depth".optional) { raw => complete(read(tenant, entityId, raw)) }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <functional>
#include <string>

#include "graph/adjacency.h"  // adjacency::readNeighbors
#include "graph/store.h"      // store::getEntity

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void neighbors(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string entity_id = req.matches[1];
  if (!store::getEntity(entity_id)) return reply(res, 404, json{{"error", "no such entity"}});
  const int depth = req.has_param("depth") ? std::stoi(req.get_param_value("depth")) : 2;
  json found = json::array();
  std::function<void(const std::string&, int)> walk = [&](const std::string& node, int distance) {
    if (distance > depth) return;
    for (const std::string& neighbor : adjacency::readNeighbors(node)) {
      found.push_back(json{{"id", neighbor}, {"distance", distance}});
      walk(neighbor, distance + 1);
    }
  };
  walk(entity_id, 1);
  reply(res, 200, json{{"entity_id", entity_id}, {"depth", depth}, {"neighbors", found}, {"truncated", false}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/entities/([\\w-]+)/neighbors)", neighbors); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <vector>

#include "graph/adjacency.h"  // adjacency::readNeighbors
#include "graph/store.h"      // store::getEntity

using json = nlohmann::json;

constexpr int kMaxDepth = 2;
constexpr size_t kMaxResults = 500;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// Breadth-first from entity_id: each entity once, at its shortest distance, at most kMaxResults.
json walk(const std::string& entity_id, int depth) {
  json found = json::array();
  std::set<std::string> visited = {entity_id};
  std::vector<std::string> frontier = {entity_id};
  for (int distance = 1; distance <= depth; distance++) {
    std::vector<std::string> next;
    for (const std::string& node : frontier) {
      for (const std::string& neighbor : adjacency::readNeighbors(node)) {
        if (visited.count(neighbor)) continue;
        if (found.size() == kMaxResults) return json{{"neighbors", found}, {"truncated", true}};
        visited.insert(neighbor);
        found.push_back(json{{"id", neighbor}, {"distance", distance}});
        next.push_back(neighbor);
      }
    }
    frontier = next;
  }
  return json{{"neighbors", found}, {"truncated", false}};
}

void neighbors(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string entity_id = req.matches[1];
  const auto entity = store::getEntity(entity_id);
  // Another tenant's entity is as absent as one that never existed.
  if (!entity || entity->tenant != tenant) return reply(res, 404, json{{"error", "no such entity"}});
  const std::string raw = req.has_param("depth") ? req.get_param_value("depth") : "1";
  const bool digits = !raw.empty() && raw.size() < 4 && std::all_of(raw.begin(), raw.end(), [](unsigned char c) { return std::isdigit(c) != 0; });
  const int depth = digits ? std::stoi(raw) : 0;
  if (depth < 1 || depth > kMaxDepth) return reply(res, 400, json{{"error", "depth must be between 1 and " + std::to_string(kMaxDepth)}});
  json body = walk(entity_id, depth);
  body["entity_id"] = entity_id;
  body["depth"] = depth;
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/entities/([\\w-]+)/neighbors)", neighbors); }
`,
    },
  },
  harness: {
    python: `from graph import store


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _entity(tenant="t1"):
    return store.create_entity(tenant, "person", "node", [])["id"]


def _edge(ctx, left, right):
    ctx.redis.sadd(f"edges:{left}", right)
    ctx.redis.sadd(f"edges:{right}", left)


async def _get(client, entity_id, depth=None, tenant="t1"):
    params = {} if depth is None else {"depth": depth}
    headers = {} if tenant is None else {"X-Tenant-Id": tenant}
    return await client.get(f"/v1/entities/{entity_id}/neighbors", params=params, headers=headers)


def _pairs(r):
    return sorted((n.get("id"), n.get("distance")) for n in r.json().get("neighbors", []))


async def check_route(ctx):
    root, left, right = _entity(), _entity(), _entity()
    _edge(ctx, root, left)
    _edge(ctx, root, right)
    async with _api(ctx) as client:
        r = await _get(client, root, depth=1)
    assert r.status_code == 200, f"GET /v1/entities/{root}/neighbors?depth=1 answered {r.status_code}: {r.text}"
    assert r.json().get("entity_id") == root and _pairs(r) == sorted([(left, 1), (right, 1)]), f"the neighbours of {root} at depth 1 are {left} and {right}, got {r.text}"
    assert ctx.redis.exists(f"adj:{root}") == 1, "the walk must read through the adjacency cache (read_neighbors), yet adj:{root} was never filled"


async def check_tenant_scope(ctx):
    mine, theirs, friend = _entity("t1"), _entity("t2"), _entity("t2")
    _edge(ctx, theirs, friend)
    async with _api(ctx) as client:
        r = await _get(client, theirs, depth=1, tenant="t1")
        assert r.status_code == 404, f"tenant t1 asked for the neighbours of {theirs}, an entity of t2, and got {r.status_code} {r.text}: another tenant's entity is 404"
        assert friend not in r.text, f"the answer to t1 leaks {friend}, a neighbour in t2"
        r = await _get(client, "e-999", depth=1)
        assert r.status_code == 404, f"an unknown entity answered {r.status_code}, expected 404"
        r = await _get(client, mine, depth=1, tenant=None)
        assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _get(client, theirs, depth=1, tenant="t2")
    assert r.status_code == 200 and _pairs(r) == [(friend, 1)], f"the owning tenant must still read {theirs}, got {r.status_code} {r.text}"


async def check_depth_cap(ctx):
    a, b, c, d = _entity(), _entity(), _entity(), _entity()
    _edge(ctx, a, b)
    _edge(ctx, b, c)
    _edge(ctx, c, d)
    async with _api(ctx) as client:
        r = await _get(client, a)
        assert r.status_code == 200 and _pairs(r) == [(b, 1)], f"without depth the walk must stop after 1 hop (depth defaults to 1), got {r.status_code} {r.text}"
        r = await _get(client, a, depth=2)
        assert r.status_code == 200 and _pairs(r) == sorted([(b, 1), (c, 2)]), f"depth=2 on the chain must reach {b} and {c}, got {r.status_code} {r.text}"
        for bad in ("3", "0", "ten"):
            r = await _get(client, a, depth=bad)
            assert r.status_code == 400, f"depth={bad} answered {r.status_code}: a depth outside 1..MAX_DEPTH (2) is 400 before any traversal"


async def check_bounded_traversal(ctx):
    a, b, c, d = _entity(), _entity(), _entity(), _entity()
    for left, right in ((a, b), (a, c), (b, d), (c, d)):
        _edge(ctx, left, right)
    async with _api(ctx) as client:
        r = await _get(client, a, depth=2)
    assert r.status_code == 200, f"depth=2 answered {r.status_code}: {r.text}"
    pairs = _pairs(r)
    assert pairs == sorted([(b, 1), (c, 1), (d, 2)]), f"a depth-2 walk over the diamond {a}-{b}/{c}-{d} answered {pairs}: each entity must appear once, at its shortest distance, and never {a} itself. Walk breadth-first with a visited set"


async def check_result_cap(ctx):
    hub, small = _entity(), _entity()
    ctx.redis.sadd(f"edges:{hub}", *[f"l-{i:03d}" for i in range(600)])
    _edge(ctx, small, "l-000")
    async with _api(ctx) as client:
        r = await _get(client, hub, depth=1)
        assert r.status_code == 200, f"the hub's neighbours answered {r.status_code}: {r.text}"
        ids = [n.get("id") for n in r.json().get("neighbors", [])]
        assert len(ids) == 500 and len(set(ids)) == 500, f"a hub with 600 neighbours answered {len(ids)} entries: cap the answer at MAX_RESULTS = 500"
        assert r.json().get("truncated") is True, f"the answer was cut at 500 and says truncated={r.json().get('truncated')!r}: a client cannot tell a complete answer from a clipped one"
        r = await _get(client, small, depth=1)
    assert r.json().get("truncated") is False and _pairs(r) == [("l-000", 1)], f"a complete answer must say truncated false, got {r.text}"
`,
    typescript: `function api(ctx) {
  return {c: ctx.client(ctx.load('read').app), store: ctx.load('/support/graph/store.ts')};
}

async function entities(store, n: number, tenant = 't1'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await store.createEntity(tenant, 'person', 'node', [])).id);
  return ids;
}

function edge(ctx, left: string, right: string): void {
  ctx.redis.sadd(\`edges:\${left}\`, right);
  ctx.redis.sadd(\`edges:\${right}\`, left);
}

function get(c, entityId: string, depth?: string, tenant: string | null = 't1') {
  const headers = tenant === null ? {} : {'X-Tenant-Id': tenant};
  return c.get(\`/v1/entities/\${entityId}/neighbors\`, {headers, query: depth === undefined ? {} : {depth}});
}

const pairs = r => JSON.stringify((r.json().neighbors ?? []).map(n => \`\${n.id}@\${n.distance}\`).sort());
const expect = (...items: string[]) => JSON.stringify(items.sort());

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const [root, left, right] = await entities(store, 3);
  edge(ctx, root, left);
  edge(ctx, root, right);
  const r = await get(c, root, '1');
  assert.equal(r.status, 200, \`GET /v1/entities/\${root}/neighbors?depth=1 answered \${r.status}: \${r.text}\`);
  assert(r.json().entity_id === root && pairs(r) === expect(\`\${left}@1\`, \`\${right}@1\`), \`the neighbours of \${root} at depth 1 are \${left} and \${right}, got \${r.text}\`);
  assert.equal(ctx.redis.exists(\`adj:\${root}\`), 1, \`the walk must read through the adjacency cache (readNeighbors), yet adj:\${root} was never filled\`);
}

export async function check_tenant_scope(ctx) {
  const {c, store} = api(ctx);
  const [mine] = await entities(store, 1, 't1');
  const [theirs, friend] = await entities(store, 2, 't2');
  edge(ctx, theirs, friend);
  let r = await get(c, theirs, '1', 't1');
  assert.equal(r.status, 404, \`tenant t1 asked for the neighbours of \${theirs}, an entity of t2, and got \${r.status} \${r.text}: another tenant's entity is 404\`);
  assert(!r.text.includes(friend), \`the answer to t1 leaks \${friend}, a neighbour in t2\`);
  r = await get(c, 'e-999', '1');
  assert.equal(r.status, 404, \`an unknown entity answered \${r.status}, expected 404\`);
  r = await get(c, mine, '1', null);
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await get(c, theirs, '1', 't2');
  assert(r.status === 200 && pairs(r) === expect(\`\${friend}@1\`), \`the owning tenant must still read \${theirs}, got \${r.status} \${r.text}\`);
}

export async function check_depth_cap(ctx) {
  const {c, store} = api(ctx);
  const [a, b, cc, d] = await entities(store, 4);
  edge(ctx, a, b);
  edge(ctx, b, cc);
  edge(ctx, cc, d);
  let r = await get(c, a);
  assert(r.status === 200 && pairs(r) === expect(\`\${b}@1\`), \`without depth the walk must stop after 1 hop (depth defaults to 1), got \${r.status} \${r.text}\`);
  r = await get(c, a, '2');
  assert(r.status === 200 && pairs(r) === expect(\`\${b}@1\`, \`\${cc}@2\`), \`depth=2 on the chain must reach \${b} and \${cc}, got \${r.status} \${r.text}\`);
  for (const bad of ['3', '0', 'ten']) {
    r = await get(c, a, bad);
    assert.equal(r.status, 400, \`depth=\${bad} answered \${r.status}: a depth outside 1..MAX_DEPTH (2) is 400 before any traversal\`);
  }
}

export async function check_bounded_traversal(ctx) {
  const {c, store} = api(ctx);
  const [a, b, cc, d] = await entities(store, 4);
  for (const [left, right] of [[a, b], [a, cc], [b, d], [cc, d]]) edge(ctx, left, right);
  const r = await get(c, a, '2');
  assert.equal(r.status, 200, \`depth=2 answered \${r.status}: \${r.text}\`);
  assert.equal(pairs(r), expect(\`\${b}@1\`, \`\${cc}@1\`, \`\${d}@2\`), \`a depth-2 walk over the diamond answered \${pairs(r)}: each entity must appear once, at its shortest distance, and never \${a} itself. Walk breadth-first with a visited set\`);
}

export async function check_result_cap(ctx) {
  const {c, store} = api(ctx);
  const [hub, small] = await entities(store, 2);
  const leaves = Array.from({length: 600}, (_, i) => \`l-\${String(i).padStart(3, '0')}\`);
  ctx.redis.sadd(\`edges:\${hub}\`, ...leaves);
  edge(ctx, small, 'l-000');
  let r = await get(c, hub, '1');
  assert.equal(r.status, 200, \`the hub's neighbours answered \${r.status}: \${r.text}\`);
  const ids = (r.json().neighbors ?? []).map(n => n.id);
  assert(ids.length === 500 && new Set(ids).size === 500, \`a hub with 600 neighbours answered \${ids.length} entries: cap the answer at MAX_RESULTS = 500\`);
  assert.equal(r.json().truncated, true, \`the answer was cut at 500 and says truncated=\${r.json().truncated}: a client cannot tell a complete answer from a clipped one\`);
  r = await get(c, small, '1');
  assert(r.json().truncated === false && pairs(r) === expect('l-000@1'), \`a complete answer must say truncated false, got \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"graph/store"

	"leetbuild/harness"
)

var readBg = context.Background()

type readAnswer struct {
	EntityID  string \`json:"entity_id"\`
	Neighbors []struct {
		ID       string \`json:"id"\`
		Distance int    \`json:"distance"\`
	} \`json:"neighbors"\`
	Truncated *bool \`json:"truncated"\`
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readEntity(tenant string) string { return store.CreateEntity(readBg, tenant, "person", "node", nil).ID }

func readEdge(ctx *harness.Ctx, left, right string) {
	ctx.Redis.Do("SADD", "edges:"+left, right)
	ctx.Redis.Do("SADD", "edges:"+right, left)
}

func readGet(c *harness.HTTP, entityID, query, tenant string) *harness.Response {
	path := "/v1/entities/" + entityID + "/neighbors" + query
	if tenant == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-Tenant-Id", tenant)
}

func readDecode(r *harness.Response) readAnswer {
	out := readAnswer{}
	r.Decode(&out)
	return out
}

// readPairs is the answer's neighbours as sorted "id@distance".
func readPairs(r *harness.Response) string {
	pairs := []string{}
	for _, n := range readDecode(r).Neighbors {
		pairs = append(pairs, fmt.Sprintf("%s@%d", n.ID, n.Distance))
	}
	sort.Strings(pairs)
	return strings.Join(pairs, ",")
}

func readExpect(pairs ...string) string {
	sort.Strings(pairs)
	return strings.Join(pairs, ",")
}

func CheckRoute(ctx *harness.Ctx) {
	root, left, right := readEntity("t1"), readEntity("t1"), readEntity("t1")
	readEdge(ctx, root, left)
	readEdge(ctx, root, right)
	r := readGet(readAPI(ctx), root, "?depth=1", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/entities/%s/neighbors?depth=1 (%s)", root, r.Text())
	ctx.Assert(readDecode(r).EntityID == root && readPairs(r) == readExpect(left+"@1", right+"@1"), "the neighbours of %s at depth 1 are %s and %s, got %s", root, left, right, r.Text())
	ctx.Equal(ctx.Redis.Exists("adj:"+root), 1, "the walk must read through the adjacency cache (adjacency.ReadNeighbors); adj:%s exists", root)
}

func CheckTenantScope(ctx *harness.Ctx) {
	mine, theirs, friend := readEntity("t1"), readEntity("t2"), readEntity("t2")
	readEdge(ctx, theirs, friend)
	c := readAPI(ctx)
	r := readGet(c, theirs, "?depth=1", "t1")
	ctx.Assert(r.Status == 404, "tenant t1 asked for the neighbours of %s, an entity of t2, and got %d %s: another tenant's entity is 404", theirs, r.Status, r.Text())
	ctx.Assert(!strings.Contains(r.Text(), friend), "the answer to t1 leaks %s, a neighbour in t2", friend)
	ctx.Equal(readGet(c, "e-999", "?depth=1", "t1").Status, 404, "an unknown entity")
	ctx.Equal(readGet(c, mine, "?depth=1", "").Status, 401, "a request without X-Tenant-Id")
	r = readGet(c, theirs, "?depth=1", "t2")
	ctx.Assert(r.Status == 200 && readPairs(r) == friend+"@1", "the owning tenant must still read %s, got %d %s", theirs, r.Status, r.Text())
}

func CheckDepthCap(ctx *harness.Ctx) {
	a, b, c3, d := readEntity("t1"), readEntity("t1"), readEntity("t1"), readEntity("t1")
	readEdge(ctx, a, b)
	readEdge(ctx, b, c3)
	readEdge(ctx, c3, d)
	c := readAPI(ctx)
	r := readGet(c, a, "", "t1")
	ctx.Assert(r.Status == 200 && readPairs(r) == b+"@1", "without depth the walk must stop after 1 hop (depth defaults to 1), got %d %s", r.Status, r.Text())
	r = readGet(c, a, "?depth=2", "t1")
	ctx.Assert(r.Status == 200 && readPairs(r) == readExpect(b+"@1", c3+"@2"), "depth=2 on the chain must reach %s and %s, got %d %s", b, c3, r.Status, r.Text())
	for _, bad := range []string{"3", "0", "ten"} {
		r = readGet(c, a, "?depth="+bad, "t1")
		ctx.Assert(r.Status == 400, "depth=%s answered %d: a depth outside 1..maxDepth (2) is 400 before any traversal", bad, r.Status)
	}
}

func CheckBoundedTraversal(ctx *harness.Ctx) {
	a, b, c3, d := readEntity("t1"), readEntity("t1"), readEntity("t1"), readEntity("t1")
	readEdge(ctx, a, b)
	readEdge(ctx, a, c3)
	readEdge(ctx, b, d)
	readEdge(ctx, c3, d)
	r := readGet(readAPI(ctx), a, "?depth=2", "t1")
	ctx.Equal(r.Status, 200, "depth=2 (%s)", r.Text())
	got := readPairs(r)
	ctx.Assert(got == readExpect(b+"@1", c3+"@1", d+"@2"), "a depth-2 walk over the diamond answered %s: each entity must appear once, at its shortest distance, and never %s itself. Walk breadth-first with a visited set", got, a)
}

func CheckResultCap(ctx *harness.Ctx) {
	hub, small := readEntity("t1"), readEntity("t1")
	args := []any{"SADD", "edges:" + hub}
	for i := 0; i < 600; i++ {
		args = append(args, fmt.Sprintf("l-%03d", i))
	}
	ctx.Redis.Do(args...)
	readEdge(ctx, small, "l-000")
	c := readAPI(ctx)
	r := readGet(c, hub, "?depth=1", "t1")
	ctx.Equal(r.Status, 200, "the hub's neighbours (%s)", r.Text())
	answer := readDecode(r)
	unique := map[string]bool{}
	for _, n := range answer.Neighbors {
		unique[n.ID] = true
	}
	ctx.Assert(len(answer.Neighbors) == 500 && len(unique) == 500, "a hub with 600 neighbours answered %d entries: cap the answer at maxResults = 500", len(answer.Neighbors))
	ctx.Assert(answer.Truncated != nil && *answer.Truncated, "the answer was cut at 500 and does not say truncated true: a client cannot tell a complete answer from a clipped one")
	r = readGet(c, small, "?depth=1", "t1")
	complete := readDecode(r)
	ctx.Assert(complete.Truncated != nil && !*complete.Truncated && readPairs(r) == "l-000@1", "a complete answer must say truncated false, got %s", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <set>
#include <string>
#include <vector>

namespace {

harness::HTTP readAPI(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string readEntity(const std::string& tenant) { return store::createEntity(tenant, "person", "node", {}).id; }

void readEdge(harness::Ctx& ctx, const std::string& left, const std::string& right) {
  ctx.Redis.Do("SADD", "edges:" + left, right);
  ctx.Redis.Do("SADD", "edges:" + right, left);
}

harness::Response readGet(harness::HTTP& c, const std::string& entity_id, const std::string& query, const std::string& tenant) {
  const std::string path = "/v1/entities/" + entity_id + "/neighbors" + query;
  if (tenant.empty()) return c.Get(path);
  return c.Get(path, "X-Tenant-Id", tenant);
}

nlohmann::json readBody(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

// The answer's neighbours as sorted "id@distance".
std::string readPairs(const harness::Response& r) {
  const auto body = readBody(r);
  std::vector<std::string> pairs;
  if (body.is_object() && body.contains("neighbors") && body["neighbors"].is_array()) {
    for (const auto& n : body["neighbors"]) pairs.push_back(n.value("id", "") + "@" + std::to_string(n.value("distance", 0)));
  }
  std::sort(pairs.begin(), pairs.end());
  std::string out;
  for (const auto& p : pairs) out += (out.empty() ? "" : ",") + p;
  return out;
}

std::string readExpect(std::vector<std::string> pairs) {
  std::sort(pairs.begin(), pairs.end());
  std::string out;
  for (const auto& p : pairs) out += (out.empty() ? "" : ",") + p;
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string root = readEntity("t1"), left = readEntity("t1"), right = readEntity("t1");
  readEdge(ctx, root, left);
  readEdge(ctx, root, right);
  auto c = readAPI(ctx);
  const auto r = readGet(c, root, "?depth=1", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/entities/%s/neighbors?depth=1 (%s)", root, r.Text());
  ctx.Assert(readBody(r).value("entity_id", "") == root && readPairs(r) == readExpect({left + "@1", right + "@1"}), "the neighbours of %s at depth 1 are %s and %s, got %s", root, left, right, r.Text());
  ctx.Equal(ctx.Redis.Exists("adj:" + root), 1, "the walk must read through the adjacency cache (adjacency::readNeighbors); adj:%s exists", root);
}

void CheckTenantScope(harness::Ctx& ctx) {
  const std::string mine = readEntity("t1"), theirs = readEntity("t2"), friend_ = readEntity("t2");
  readEdge(ctx, theirs, friend_);
  auto c = readAPI(ctx);
  auto r = readGet(c, theirs, "?depth=1", "t1");
  ctx.Assert(r.Status == 404, "tenant t1 asked for the neighbours of %s, an entity of t2, and got %d %s: another tenant's entity is 404", theirs, r.Status, r.Text());
  ctx.Assert(r.Text().find(friend_) == std::string::npos, "the answer to t1 leaks %s, a neighbour in t2", friend_);
  ctx.Equal(readGet(c, "e-999", "?depth=1", "t1").Status, 404, "an unknown entity");
  ctx.Equal(readGet(c, mine, "?depth=1", "").Status, 401, "a request without X-Tenant-Id");
  r = readGet(c, theirs, "?depth=1", "t2");
  ctx.Assert(r.Status == 200 && readPairs(r) == friend_ + "@1", "the owning tenant must still read %s, got %d %s", theirs, r.Status, r.Text());
}

void CheckDepthCap(harness::Ctx& ctx) {
  const std::string a = readEntity("t1"), b = readEntity("t1"), c3 = readEntity("t1"), d = readEntity("t1");
  readEdge(ctx, a, b);
  readEdge(ctx, b, c3);
  readEdge(ctx, c3, d);
  auto c = readAPI(ctx);
  auto r = readGet(c, a, "", "t1");
  ctx.Assert(r.Status == 200 && readPairs(r) == b + "@1", "without depth the walk must stop after 1 hop (depth defaults to 1), got %d %s", r.Status, r.Text());
  r = readGet(c, a, "?depth=2", "t1");
  ctx.Assert(r.Status == 200 && readPairs(r) == readExpect({b + "@1", c3 + "@2"}), "depth=2 on the chain must reach %s and %s, got %d %s", b, c3, r.Status, r.Text());
  for (const std::string bad : {"3", "0", "ten"}) {
    r = readGet(c, a, "?depth=" + bad, "t1");
    ctx.Assert(r.Status == 400, "depth=%s answered %d: a depth outside 1..kMaxDepth (2) is 400 before any traversal", bad, r.Status);
  }
}

void CheckBoundedTraversal(harness::Ctx& ctx) {
  const std::string a = readEntity("t1"), b = readEntity("t1"), c3 = readEntity("t1"), d = readEntity("t1");
  readEdge(ctx, a, b);
  readEdge(ctx, a, c3);
  readEdge(ctx, b, d);
  readEdge(ctx, c3, d);
  auto c = readAPI(ctx);
  const auto r = readGet(c, a, "?depth=2", "t1");
  ctx.Equal(r.Status, 200, "depth=2 (%s)", r.Text());
  const std::string got = readPairs(r);
  ctx.Assert(got == readExpect({b + "@1", c3 + "@1", d + "@2"}), "a depth-2 walk over the diamond answered %s: each entity must appear once, at its shortest distance, and never %s itself. Walk breadth-first with a visited set", got, a);
}

void CheckResultCap(harness::Ctx& ctx) {
  const std::string hub = readEntity("t1"), small = readEntity("t1");
  for (int i = 0; i < 600; i++) {
    char leaf[8];
    std::snprintf(leaf, sizeof leaf, "l-%03d", i);
    ctx.Redis.Do("SADD", "edges:" + hub, std::string(leaf));
  }
  readEdge(ctx, small, "l-000");
  auto c = readAPI(ctx);
  auto r = readGet(c, hub, "?depth=1", "t1");
  ctx.Equal(r.Status, 200, "the hub's neighbours (%s)", r.Text().substr(0, 200));
  const auto body = readBody(r);
  std::set<std::string> unique;
  size_t count = 0;
  if (body.is_object() && body.contains("neighbors") && body["neighbors"].is_array()) {
    for (const auto& n : body["neighbors"]) {
      unique.insert(n.value("id", ""));
      count++;
    }
  }
  ctx.Assert(count == 500 && unique.size() == 500, "a hub with 600 neighbours answered %d entries: cap the answer at kMaxResults = 500", count);
  ctx.Assert(body.value("truncated", false) == true, "the answer was cut at 500 and does not say truncated true: a client cannot tell a complete answer from a clipped one");
  r = readGet(c, small, "?depth=1", "t1");
  const auto complete = readBody(r);
  ctx.Assert(complete.is_object() && complete.contains("truncated") && complete["truncated"] == false && readPairs(r) == "l-000@1", "a complete answer must say truncated false, got %s", r.Text());
}
`,
  },
  hints: [
    'Ask for a neighbour of another tenant with your own tenant header, then ask for `depth=6` around a hub: the first answers, the second never returns. Around a small cycle, entities appear several times, the starting one too.',
    'The handler checks that the entity exists, never whose it is. The recursive walk has no memory of where it has been, so it follows every path, back edges included, and nothing bounds the depth or the size of the answer.',
    'Compare `entity["tenant"]` with the header (404); default `depth` to 1 and 400 outside 1..`MAX_DEPTH`; walk a `frontier` per distance with a `visited` set seeded with the entity; stop at `MAX_RESULTS` and answer `truncated: true`.',
  ],
  debrief: `Every bound here protects a different party. The tenant check protects the other tenant, and answering 404 rather than 403 avoids confirming that the id exists. The depth cap protects the service: neighbourhoods grow roughly with the average degree raised to the depth, so a second hop is affordable and a sixth is not. The visited set turns path enumeration into a walk that touches each entity once. The result cap with an explicit truncated flag protects the client from mistaking a clipped answer for a complete one. Graph databases built for this, like Neo4j, also bound a query by time and memory and expose paging, so a caller can ask for the next 500 rather than more at once.`,
};
