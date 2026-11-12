import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/routes/{id}: a stored route with its provenance',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/routes/{route_id}\`, the read a reopened or shared
trip uses: it loads the stored route with \`routes.load_route(route_id)\` (\`mapsd.routes\`: the route's
fields and the \`tenant\` that computed it), answers **404** when there is none, and otherwise returns
\`route_id\`, \`distance_m\`, \`duration_s\`, \`geometry\`, \`engine_version\` and
\`epoch: current_epoch()\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reads any tenant's routes by counting up ids (\`r-1\`,
\`r-2\`, ...); a route solved at rush hour reads as solved a minute ago; and a straight-line estimate
reads as a road route.

- No \`X-Tenant-Id\` is **401**.
- Another tenant's route answers the same **404** and body as an unknown id.
- \`epoch\` is the stored route's epoch, and \`stale\` is \`true\` when it differs from
  \`current_epoch()\`.
- \`degraded\` is the stored marker.`,
  sequence: {
    participants: ['Client', 'Maps API', 'Route store'],
    messages: [
      {from: 'Client', to: 'Maps API', label: 'GET /v1/routes/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Maps API', to: 'Maps API', label: 'no tenant → 401', kind: 'sync'},
      {from: 'Maps API', to: 'Route store', label: 'load_route(id)', kind: 'sync'},
      {from: 'Route store', to: 'Maps API', label: '{tenant, geometry, epoch, degraded, …} / none', kind: 'reply'},
      {from: 'Maps API', to: 'Maps API', label: 'none or another tenant → the same 404', kind: 'sync'},
      {from: 'Maps API', to: 'Client', label: '200 {geometry, epoch (stored), stale, degraded, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route-read',
      title: 'Answers GET /v1/routes/{id} with the stored route',
      detail:
        'A stored route is read back with its `geometry`, `distance_m` and `engine_version`; an unknown id is **404**.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/routes\/\{route_id\}["']/, /load_route\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/routes\/:routeId['"]/, /loadRoute\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/routes\/\{id\}"/, /routes\.LoadRoute\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"routes"\s*\/\s*Segment\s*\)/, /Routes\.loadRoute\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/routes\//, /routes::loadRoute\(/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'A read without a tenant is 401',
      detail: 'No `X-Tenant-Id` answers **401** before the store is read; the starter has no tenant gate at all.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Tenant-Id/i, /StatusCodes\.Unauthorized|\b401\b/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'ownership-scope',
      title: "Another tenant's route is the same 404 as an unknown id",
      detail:
        "The stored route's `tenant` must be the caller's, and a foreign id answers exactly like a missing one, so counting up ids reveals nothing; the starter hands any route to any caller.",
      match: {
        python: {all: [/\["tenant"\]\s*!=\s*tenant|tenant\s*!=\s*stored\["tenant"\]/]},
        typescript: {all: [/stored\.tenant\s*!==\s*tenant|tenant\s*!==\s*stored\.tenant/]},
        go: {all: [/stored\.Tenant\s*!=\s*tenant|tenant\s*!=\s*stored\.Tenant/]},
        scala: {all: [/\.tenant\s*(!=|==)\s*tenant/]},
        cpp: {all: [/->tenant\s*!=\s*tenant|tenant\s*!=\s*stored->tenant/]},
      },
    },
    {
      id: 'epoch-provenance',
      title: "Reports the route's own epoch, and whether it is stale",
      detail:
        "`epoch` is the stored route's, and `stale` says whether that epoch has passed; the starter stamps `current_epoch()` on stored geometry, so a rush-hour route reads as solved now.",
      match: {
        python: {all: [/"epoch":\s*stored\["epoch"\]/, /"stale":/], none: [/"epoch":\s*current_epoch\(\)/]},
        typescript: {all: [/epoch:\s*stored\.epoch/, /stale:/], none: [/epoch:\s*currentEpoch\(\)/]},
        go: {all: [/"epoch":\s*stored\.Route\.Epoch/, /"stale":/], none: [/"epoch":\s*geo\.CurrentEpoch\(\)/]},
        scala: {
          all: [/"epoch"\s*->\s*JsNumber\(stored\.route\.epoch\)/, /"stale"/],
          none: [/"epoch"\s*->\s*JsNumber\(Geo\.currentEpoch\(\)\)/],
        },
        cpp: {all: [/\{"epoch",\s*stored->route\.epoch\}/, /"stale"/], none: [/\{"epoch",\s*geo::currentEpoch\(\)\}/]},
      },
    },
    {
      id: 'degraded-marker',
      title: 'A straight-line estimate stays marked degraded',
      detail:
        'The response carries the stored `degraded` marker, so a client can tell an estimate from a road route; the starter leaves it out.',
      match: {
        python: {all: [/"degraded":\s*stored\["degraded"\]/]},
        typescript: {all: [/degraded:\s*stored\.degraded/]},
        go: {all: [/"degraded":\s*stored\.Route\.Degraded/]},
        scala: {all: [/"degraded"\s*->\s*JsBoolean\(stored\.route\.degraded\)/]},
        cpp: {all: [/\{"degraded",\s*stored->route\.degraded\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

from mapsd import routes  # load_route
from mapsd.geo import current_epoch

app = FastAPI()


@app.get("/v1/routes/{route_id}")
def read_route(route_id: str) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    stored = routes.load_route(route_id)
    if stored is None:
        return JSONResponse({"error": "route not found"}, status_code=404)
    return JSONResponse(
        {
            "route_id": route_id,
            "distance_m": stored["distance_m"],
            "duration_s": stored["duration_s"],
            "geometry": stored["geometry"],
            "engine_version": stored["engine_version"],
            "epoch": current_epoch(),
        }
    )
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from mapsd import routes  # load_route
from mapsd.geo import current_epoch

app = FastAPI()


@app.get("/v1/routes/{route_id}")
def read_route(route_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    stored = routes.load_route(route_id)
    # Another tenant's route answers exactly like a missing one: the read confirms nothing.
    if stored is None or stored["tenant"] != tenant:
        return JSONResponse({"error": "route not found"}, status_code=404)
    return JSONResponse(
        {
            "route_id": route_id,
            "distance_m": stored["distance_m"],
            "duration_s": stored["duration_s"],
            "geometry": stored["geometry"],
            "engine_version": stored["engine_version"],
            # The epoch the geometry was solved under; the current one only decides whether it is stale.
            "epoch": stored["epoch"],
            "stale": stored["epoch"] != current_epoch(),
            "degraded": stored["degraded"],
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {currentEpoch} from 'mapsd/geo';
import {loadRoute} from 'mapsd/routes';

export const app = Fastify();

app.get('/v1/routes/:routeId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {routeId} = request.params as {routeId: string};
  const stored = await loadRoute(routeId);
  if (stored === null) return reply.code(404).send({error: 'route not found'});
  return {
    route_id: routeId,
    distance_m: stored.distance_m,
    duration_s: stored.duration_s,
    geometry: stored.geometry,
    engine_version: stored.engine_version,
    epoch: currentEpoch(),
  };
});
`,
      solution: `import Fastify from 'fastify';

import {currentEpoch} from 'mapsd/geo';
import {loadRoute} from 'mapsd/routes';

export const app = Fastify();

app.get('/v1/routes/:routeId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {routeId} = request.params as {routeId: string};
  const stored = await loadRoute(routeId);
  // Another tenant's route answers exactly like a missing one: the read confirms nothing.
  if (stored === null || stored.tenant !== tenant) return reply.code(404).send({error: 'route not found'});
  return {
    route_id: routeId,
    distance_m: stored.distance_m,
    duration_s: stored.duration_s,
    geometry: stored.geometry,
    engine_version: stored.engine_version,
    // The epoch the geometry was solved under; the current one only decides whether it is stale.
    epoch: stored.epoch,
    stale: stored.epoch !== currentEpoch(),
    degraded: stored.degraded,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"mapsd/geo"    // geo.CurrentEpoch
	"mapsd/routes" // routes.LoadRoute(ctx, id) *routes.Stored
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRoute(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	routeID := r.PathValue("id")
	stored := routes.LoadRoute(r.Context(), routeID)
	if stored == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "route not found"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"route_id":       routeID,
		"distance_m":     stored.Route.DistanceM,
		"duration_s":     stored.Route.DurationS,
		"geometry":       stored.Route.Geometry,
		"engine_version": stored.Route.EngineVersion,
		"epoch":          geo.CurrentEpoch(),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/routes/{id}", readRoute)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"mapsd/geo"    // geo.CurrentEpoch
	"mapsd/routes" // routes.LoadRoute(ctx, id) *routes.Stored
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRoute(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	routeID := r.PathValue("id")
	stored := routes.LoadRoute(r.Context(), routeID)
	// Another tenant's route answers exactly like a missing one: the read confirms nothing.
	if stored == nil || stored.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "route not found"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"route_id":       routeID,
		"distance_m":     stored.Route.DistanceM,
		"duration_s":     stored.Route.DurationS,
		"geometry":       stored.Route.Geometry,
		"engine_version": stored.Route.EngineVersion,
		// The epoch the geometry was solved under; the current one only decides whether it is stale.
		"epoch":    stored.Route.Epoch,
		"stale":    stored.Route.Epoch != geo.CurrentEpoch(),
		"degraded": stored.Route.Degraded,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/routes/{id}", readRoute)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import mapsd.{Geo, Routes} // Routes.loadRoute, Geo.currentEpoch

object ReadApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private val notFound = json(StatusCodes.NotFound, JsObject("error" -> JsString("route not found")))

  val route: Route = path("v1" / "routes" / Segment) { routeId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Routes.loadRoute(routeId) match {
        case None => complete(notFound)
        case Some(stored) =>
          complete(
            json(
              StatusCodes.OK,
              JsObject(
                "route_id" -> JsString(routeId),
                "distance_m" -> JsNumber(stored.route.distanceM),
                "duration_s" -> JsNumber(stored.route.durationS),
                "geometry" -> JsString(stored.route.geometry),
                "engine_version" -> JsString(stored.route.engineVersion),
                "epoch" -> JsNumber(Geo.currentEpoch()),
              ),
            ),
          )
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import mapsd.{Geo, Routes} // Routes.loadRoute, Geo.currentEpoch

object ReadApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private val notFound = json(StatusCodes.NotFound, JsObject("error" -> JsString("route not found")))

  val route: Route = path("v1" / "routes" / Segment) { routeId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) =>
          // Another tenant's route answers exactly like a missing one: the read confirms nothing.
          Routes.loadRoute(routeId).filter(_.tenant == tenant) match {
            case None => complete(notFound)
            case Some(stored) =>
              complete(
                json(
                  StatusCodes.OK,
                  JsObject(
                    "route_id" -> JsString(routeId),
                    "distance_m" -> JsNumber(stored.route.distanceM),
                    "duration_s" -> JsNumber(stored.route.durationS),
                    "geometry" -> JsString(stored.route.geometry),
                    "engine_version" -> JsString(stored.route.engineVersion),
                    // The epoch the geometry was solved under; the current one only decides whether it is stale.
                    "epoch" -> JsNumber(stored.route.epoch),
                    "stale" -> JsBoolean(stored.route.epoch != Geo.currentEpoch()),
                    "degraded" -> JsBoolean(stored.route.degraded),
                  ),
                ),
              )
          }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "mapsd/geo.h"     // geo::currentEpoch
#include "mapsd/routes.h"  // routes::loadRoute(id) -> std::optional<routes::Stored>

using json = nlohmann::json;

void read_route(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string route_id = req.matches[1];
  const auto stored = routes::loadRoute(route_id);
  if (!stored) {
    res.status = 404;
    res.set_content(json{{"error", "route not found"}}.dump(), "application/json");
    return;
  }
  const json body = {{"route_id", route_id},
                     {"distance_m", stored->route.distance_m},
                     {"duration_s", stored->route.duration_s},
                     {"geometry", stored->route.geometry},
                     {"engine_version", stored->route.engine_version},
                     {"epoch", geo::currentEpoch()}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/routes/([\\w-]+))", read_route); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "mapsd/geo.h"     // geo::currentEpoch
#include "mapsd/routes.h"  // routes::loadRoute(id) -> std::optional<routes::Stored>

using json = nlohmann::json;

void read_route(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "X-Tenant-Id is required"}}.dump(), "application/json");
    return;
  }
  const std::string route_id = req.matches[1];
  const auto stored = routes::loadRoute(route_id);
  // Another tenant's route answers exactly like a missing one: the read confirms nothing.
  if (!stored || stored->tenant != tenant) {
    res.status = 404;
    res.set_content(json{{"error", "route not found"}}.dump(), "application/json");
    return;
  }
  const json body = {{"route_id", route_id},
                     {"distance_m", stored->route.distance_m},
                     {"duration_s", stored->route.duration_s},
                     {"geometry", stored->route.geometry},
                     {"engine_version", stored->route.engine_version},
                     // The epoch the geometry was solved under; the current one only decides whether it is stale.
                     {"epoch", stored->route.epoch},
                     {"stale", stored->route.epoch != geo::currentEpoch()},
                     {"degraded", stored->route.degraded}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/routes/([\\w-]+))", read_route); }
`,
    },
  },
  harness: {
    python: `from mapsd.geo import current_epoch
from mapsd.routes import save_route

ACME = {"X-Tenant-Id": "acme"}


def _route(epoch=None, degraded=False):
    return {
        "distance_m": 2715.4 if degraded else 18842.5,
        "duration_s": 195.4 if degraded else 1713.0,
        "geometry": "" if degraded else "poly:2",
        "epoch": current_epoch() if epoch is None else epoch,
        "engine_version": "straight-line" if degraded else "osrm-v26.9",
        "degraded": degraded,
    }


def _read(ctx):
    return ctx.client(ctx.load("read").app)


async def check_route_read(ctx):
    route_id = save_route("acme", _route())
    async with _read(ctx) as c:
        r = await c.get(f"/v1/routes/{route_id}", headers=ACME)
        missing = await c.get("/v1/routes/r-404", headers=ACME)
    assert r.status_code == 200, f"GET /v1/routes/{route_id} answered {r.status_code}: {r.text}"
    body = r.json()
    for name, value in (("geometry", "poly:2"), ("distance_m", 18842.5), ("engine_version", "osrm-v26.9")):
        assert body.get(name) == value, f"the read's {name} is {body.get(name)!r}, the stored route's is {value!r}"
    assert missing.status_code == 404, f"an unknown route id answered {missing.status_code}, expected 404"


async def check_tenant_required(ctx):
    route_id = save_route("acme", _route())
    async with _read(ctx) as c:
        r = await c.get(f"/v1/routes/{route_id}")
    assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_ownership_scope(ctx):
    route_id = save_route("acme", _route())
    async with _read(ctx) as c:
        foreign = await c.get(f"/v1/routes/{route_id}", headers={"X-Tenant-Id": "beta"})
        missing = await c.get("/v1/routes/r-404", headers={"X-Tenant-Id": "beta"})
        own = await c.get(f"/v1/routes/{route_id}", headers=ACME)
    assert foreign.status_code == 404, f"tenant beta read acme's route {route_id}: {foreign.status_code} {foreign.text}"
    assert foreign.text == missing.text, f"a foreign id must answer exactly like an unknown one: {foreign.text!r} vs {missing.text!r}"
    assert own.status_code == 200, f"acme reading its own route answered {own.status_code}"


async def check_epoch_provenance(ctx):
    old = current_epoch() - 12
    old_id = save_route("acme", _route(epoch=old))
    fresh_id = save_route("acme", _route())
    async with _read(ctx) as c:
        stale = (await c.get(f"/v1/routes/{old_id}", headers=ACME)).json()
        fresh = (await c.get(f"/v1/routes/{fresh_id}", headers=ACME)).json()
    assert stale.get("epoch") == old, f"a route solved in epoch {old} reads as epoch {stale.get('epoch')}: the read must report the epoch it was solved under, not the current one"
    assert stale.get("stale") is True, f"a route from an hour ago must read stale: true, got {stale.get('stale')!r}"
    assert fresh.get("epoch") == current_epoch() and fresh.get("stale") is False, f"a route from this epoch must read epoch {current_epoch()} and stale: false, got {fresh}"


async def check_degraded_marker(ctx):
    estimate_id = save_route("acme", _route(degraded=True))
    road_id = save_route("acme", _route())
    async with _read(ctx) as c:
        estimate = (await c.get(f"/v1/routes/{estimate_id}", headers=ACME)).json()
        road = (await c.get(f"/v1/routes/{road_id}", headers=ACME)).json()
    assert estimate.get("degraded") is True, f"a straight-line estimate must read degraded: true, got {estimate}"
    assert road.get("degraded") is False, f"a road route must read degraded: false, got {road}"
`,
    typescript: `const ACME = {'X-Tenant-Id': 'acme'};

function read(ctx) {
  const {currentEpoch} = ctx.load('/support/mapsd/geo.ts');
  const {saveRoute} = ctx.load('/support/mapsd/routes.ts');
  const route = (epoch: number | null = null, degraded = false) => ({
    distance_m: degraded ? 2715.4 : 18842.5,
    duration_s: degraded ? 195.4 : 1713.0,
    geometry: degraded ? '' : 'poly:2',
    epoch: epoch ?? currentEpoch(),
    engine_version: degraded ? 'straight-line' : 'osrm-v26.9',
    degraded,
  });
  return {c: ctx.client(ctx.load('read').app), currentEpoch, saveRoute, route};
}

export async function check_route_read(ctx) {
  const {c, saveRoute, route} = read(ctx);
  const routeId = await saveRoute('acme', route());
  const r = await c.get(\`/v1/routes/\${routeId}\`, {headers: ACME});
  assert.equal(r.status, 200, \`GET /v1/routes/\${routeId} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  for (const [name, value] of [['geometry', 'poly:2'], ['distance_m', 18842.5], ['engine_version', 'osrm-v26.9']] as const) {
    assert.equal(body[name], value, \`the read's \${name} is \${JSON.stringify(body[name])}, the stored route's is \${JSON.stringify(value)}\`);
  }
  const missing = await c.get('/v1/routes/r-404', {headers: ACME});
  assert.equal(missing.status, 404, \`an unknown route id answered \${missing.status}, expected 404\`);
}

export async function check_tenant_required(ctx) {
  const {c, saveRoute, route} = read(ctx);
  const routeId = await saveRoute('acme', route());
  const r = await c.get(\`/v1/routes/\${routeId}\`);
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_ownership_scope(ctx) {
  const {c, saveRoute, route} = read(ctx);
  const routeId = await saveRoute('acme', route());
  const foreign = await c.get(\`/v1/routes/\${routeId}\`, {headers: {'X-Tenant-Id': 'beta'}});
  const missing = await c.get('/v1/routes/r-404', {headers: {'X-Tenant-Id': 'beta'}});
  const own = await c.get(\`/v1/routes/\${routeId}\`, {headers: ACME});
  assert.equal(foreign.status, 404, \`tenant beta read acme's route \${routeId}: \${foreign.status} \${foreign.text}\`);
  assert.equal(foreign.text, missing.text, \`a foreign id must answer exactly like an unknown one: \${foreign.text} vs \${missing.text}\`);
  assert.equal(own.status, 200, \`acme reading its own route answered \${own.status}\`);
}

export async function check_epoch_provenance(ctx) {
  const {c, currentEpoch, saveRoute, route} = read(ctx);
  const old = currentEpoch() - 12;
  const oldId = await saveRoute('acme', route(old));
  const freshId = await saveRoute('acme', route());
  const stale = (await c.get(\`/v1/routes/\${oldId}\`, {headers: ACME})).json();
  const fresh = (await c.get(\`/v1/routes/\${freshId}\`, {headers: ACME})).json();
  assert.equal(stale.epoch, old, \`a route solved in epoch \${old} reads as epoch \${stale.epoch}: the read must report the epoch it was solved under, not the current one\`);
  assert.equal(stale.stale, true, \`a route from an hour ago must read stale: true, got \${JSON.stringify(stale.stale)}\`);
  assert(fresh.epoch === currentEpoch() && fresh.stale === false, \`a route from this epoch must read epoch \${currentEpoch()} and stale: false, got \${JSON.stringify(fresh)}\`);
}

export async function check_degraded_marker(ctx) {
  const {c, saveRoute, route} = read(ctx);
  const estimateId = await saveRoute('acme', route(null, true));
  const roadId = await saveRoute('acme', route());
  const estimate = (await c.get(\`/v1/routes/\${estimateId}\`, {headers: ACME})).json();
  const road = (await c.get(\`/v1/routes/\${roadId}\`, {headers: ACME})).json();
  assert.equal(estimate.degraded, true, \`a straight-line estimate must read degraded: true, got \${JSON.stringify(estimate)}\`);
  assert.equal(road.degraded, false, \`a road route must read degraded: false, got \${JSON.stringify(road)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"mapsd/geo"
	"mapsd/routes"

	"leetbuild/harness"
)

var readBg = context.Background()

func storedRoute(epoch int64, degraded bool) geo.Route {
	if degraded {
		return geo.Route{DistanceM: 2715.4, DurationS: 195.4, Epoch: epoch, EngineVersion: "straight-line", Degraded: true}
	}
	return geo.Route{DistanceM: 18842.5, DurationS: 1713.0, Geometry: "poly:2", Epoch: epoch, EngineVersion: "osrm-v26.9"}
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readJSON(ctx *harness.Ctx, c *harness.HTTP, routeID string) map[string]any {
	r := c.Get("/v1/routes/"+routeID, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/routes/%s (%s)", routeID, r.Text())
	body, _ := r.JSON().(map[string]any)
	return body
}

func CheckRouteRead(ctx *harness.Ctx) {
	c := readAPI(ctx)
	routeID := routes.SaveRoute(readBg, "acme", storedRoute(geo.CurrentEpoch(), false))
	body := readJSON(ctx, c, routeID)
	ctx.Equal(body["geometry"], "poly:2", "the read's geometry")
	ctx.Equal(body["distance_m"], 18842.5, "the read's distance_m")
	ctx.Equal(body["engine_version"], "osrm-v26.9", "the read's engine_version")
	ctx.Equal(c.Get("/v1/routes/r-404", "X-Tenant-Id", "acme").Status, 404, "an unknown route id")
}

func CheckTenantRequired(ctx *harness.Ctx) {
	c := readAPI(ctx)
	routeID := routes.SaveRoute(readBg, "acme", storedRoute(geo.CurrentEpoch(), false))
	ctx.Equal(c.Get("/v1/routes/"+routeID).Status, 401, "a read without X-Tenant-Id")
}

func CheckOwnershipScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	routeID := routes.SaveRoute(readBg, "acme", storedRoute(geo.CurrentEpoch(), false))
	foreign := c.Get("/v1/routes/"+routeID, "X-Tenant-Id", "beta")
	missing := c.Get("/v1/routes/r-404", "X-Tenant-Id", "beta")
	ctx.Equal(foreign.Status, 404, "tenant beta reading acme's route %s (%s)", routeID, foreign.Text())
	ctx.Equal(foreign.Text(), missing.Text(), "a foreign id must answer exactly like an unknown one; the body")
	ctx.Equal(c.Get("/v1/routes/"+routeID, "X-Tenant-Id", "acme").Status, 200, "acme reading its own route")
}

func CheckEpochProvenance(ctx *harness.Ctx) {
	c := readAPI(ctx)
	now := geo.CurrentEpoch()
	oldID := routes.SaveRoute(readBg, "acme", storedRoute(now-12, false))
	freshID := routes.SaveRoute(readBg, "acme", storedRoute(now, false))
	stale := readJSON(ctx, c, oldID)
	fresh := readJSON(ctx, c, freshID)
	ctx.Equal(stale["epoch"], float64(now-12), "a route solved an hour ago must report the epoch it was solved under, not the current one; its epoch")
	ctx.Equal(stale["stale"], true, "a route from an hour ago must read stale")
	ctx.Equal(fresh["epoch"], float64(now), "a route from this epoch, its epoch")
	ctx.Equal(fresh["stale"], false, "a route from this epoch must not read stale")
}

func CheckDegradedMarker(ctx *harness.Ctx) {
	c := readAPI(ctx)
	estimateID := routes.SaveRoute(readBg, "acme", storedRoute(geo.CurrentEpoch(), true))
	roadID := routes.SaveRoute(readBg, "acme", storedRoute(geo.CurrentEpoch(), false))
	ctx.Equal(readJSON(ctx, c, estimateID)["degraded"], true, "a straight-line estimate must read degraded")
	ctx.Equal(readJSON(ctx, c, roadID)["degraded"], false, "a road route must read degraded: false")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "mapsd/geo.h"
#include "mapsd/routes.h"

using json = nlohmann::json;

namespace {

geo::Route storedRoute(long long epoch, bool degraded) {
  geo::Route r;
  r.distance_m = degraded ? 2715.4 : 18842.5;
  r.duration_s = degraded ? 195.4 : 1713.0;
  r.geometry = degraded ? "" : "poly:2";
  r.epoch = epoch;
  r.engine_version = degraded ? "straight-line" : "osrm-v26.9";
  r.degraded = degraded;
  return r;
}

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json readJson(harness::Ctx& ctx, harness::HTTP& c, const std::string& route_id) {
  const auto r = c.Get("/v1/routes/" + route_id, "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/routes/%s (%s)", route_id, r.Text());
  return json::parse(r.Text());
}

}  // namespace

void CheckRouteRead(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string route_id = routes::saveRoute("acme", storedRoute(geo::currentEpoch(), false));
  const json body = readJson(ctx, c, route_id);
  ctx.Equal(body.value("geometry", ""), "poly:2", "the read's geometry");
  ctx.Equal(body.value("distance_m", 0.0), 18842.5, "the read's distance_m");
  ctx.Equal(body.value("engine_version", ""), "osrm-v26.9", "the read's engine_version");
  ctx.Equal(c.Get("/v1/routes/r-404", "X-Tenant-Id", "acme").Status, 404, "an unknown route id");
}

void CheckTenantRequired(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string route_id = routes::saveRoute("acme", storedRoute(geo::currentEpoch(), false));
  ctx.Equal(c.Get("/v1/routes/" + route_id).Status, 401, "a read without X-Tenant-Id");
}

void CheckOwnershipScope(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string route_id = routes::saveRoute("acme", storedRoute(geo::currentEpoch(), false));
  const auto foreign = c.Get("/v1/routes/" + route_id, "X-Tenant-Id", "beta");
  const auto missing = c.Get("/v1/routes/r-404", "X-Tenant-Id", "beta");
  ctx.Equal(foreign.Status, 404, "tenant beta reading acme's route %s (%s)", route_id, foreign.Text());
  ctx.Equal(foreign.Text(), missing.Text(), "a foreign id must answer exactly like an unknown one; the body");
  ctx.Equal(c.Get("/v1/routes/" + route_id, "X-Tenant-Id", "acme").Status, 200, "acme reading its own route");
}

void CheckEpochProvenance(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const long long now = geo::currentEpoch();
  const std::string old_id = routes::saveRoute("acme", storedRoute(now - 12, false));
  const std::string fresh_id = routes::saveRoute("acme", storedRoute(now, false));
  const json stale = readJson(ctx, c, old_id);
  const json fresh = readJson(ctx, c, fresh_id);
  ctx.Equal(stale.value("epoch", 0LL), now - 12, "a route solved an hour ago must report the epoch it was solved under, not the current one; its epoch");
  ctx.Assert(stale.contains("stale") && stale["stale"] == true, "a route from an hour ago must read stale: true, got %s", stale.dump());
  ctx.Equal(fresh.value("epoch", 0LL), now, "a route from this epoch, its epoch");
  ctx.Assert(fresh.contains("stale") && fresh["stale"] == false, "a route from this epoch must read stale: false, got %s", fresh.dump());
}

void CheckDegradedMarker(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const std::string estimate_id = routes::saveRoute("acme", storedRoute(geo::currentEpoch(), true));
  const std::string road_id = routes::saveRoute("acme", storedRoute(geo::currentEpoch(), false));
  const json estimate = readJson(ctx, c, estimate_id);
  const json road = readJson(ctx, c, road_id);
  ctx.Assert(estimate.contains("degraded") && estimate["degraded"] == true, "a straight-line estimate must read degraded: true, got %s", estimate.dump());
  ctx.Assert(road.contains("degraded") && road["degraded"] == false, "a road route must read degraded: false, got %s", road.dump());
}
`,
  },
  hints: [
    'Save a route as acme and read it as beta, or with no tenant at all: both get it. Save one solved an hour ago and read it back: its `epoch` is the current one. Save a straight-line estimate: nothing in the response says so.',
    'The handler reads by id alone and never compares `stored["tenant"]` with the request\'s tenant. It writes `current_epoch()` where the stored epoch belongs and leaves `degraded` out of the body.',
    '401 on an empty `X-Tenant-Id`; the not-found 404 when `stored is None or stored["tenant"] != tenant`; answer `"epoch": stored["epoch"]`, `"stale": stored["epoch"] != current_epoch()` and `"degraded": stored["degraded"]`.',
  ],
  debrief: `A read hands back a claim, and the claim needs its provenance: the epoch the geometry was solved under, whether that epoch is over, and whether an engine produced it at all. Stamping the current epoch on stored geometry is the most convincing way to mislead, because the field is real and the value plausible. The tenant check compares the record with the caller, and a foreign id answers exactly like a missing one, so sequential ids reveal nothing about which routes exist. Production APIs also issue unguessable ids, return an ETag of the stored version so clients can revalidate, and offer to recompute a stale shared route rather than serve it as current.`,
};
