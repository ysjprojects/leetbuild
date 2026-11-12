import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/routes: refuse a bad trip before the solver sees it',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'api', 'coverage'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/routes\` with body
\`{"origin": {"lat", "lng"}, "destination": {"lat", "lng"}, "waypoints": [...]}\`: it takes the
tenant from \`X-Tenant-Id\`, gets the route from \`cached_route(origin, destination, waypoints)\`
(step 2's cache, provided as \`mapsd.cache\`), stores it with \`routes.save_route(tenant, route)\` and
answers **201** with \`route_id\` and the route's fields; a \`NoRoute\` is **422** \`NO_ROUTE\`. It
serves the demo and hides four flaws.

**Failure mode the checks target.** Every request reaches the solver: one with no tenant, one with
a coordinate off the planet, a trip with hundreds of stops that ties the engine up for every
tenant, and a trip outside the tenant's map, which gets a route its data cannot support.

- No \`X-Tenant-Id\` is **401**.
- At most \`MAX_WAYPOINTS = 25\` waypoints; more is **422**.
- Every point is finite, with \`lat\` within ±90 and \`lng\` within ±180; anything else is **422**.
- Every point lies in the tenant's coverage (\`covers(tenant, point)\`, provided as
  \`mapsd.coverage\`); otherwise **403** \`{"error": "OUT_OF_COVERAGE"}\`.
- All four are answered before \`cached_route\` runs: a refused request costs no engine call.`,
  sequence: {
    participants: ['Client', 'Maps API', 'Coverage store', 'Route cache'],
    messages: [
      {
        from: 'Client',
        to: 'Maps API',
        label: 'POST /v1/routes · X-Tenant-Id · origin, destination, waypoints',
        kind: 'sync',
      },
      {
        from: 'Maps API',
        to: 'Maps API',
        label: 'no tenant → 401 · > 25 waypoints or bad coordinate → 422',
        kind: 'sync',
      },
      {from: 'Maps API', to: 'Coverage store', label: 'covers(tenant, point) for every point', kind: 'sync'},
      {from: 'Coverage store', to: 'Maps API', label: 'outside → 403 OUT_OF_COVERAGE', kind: 'reply'},
      {from: 'Maps API', to: 'Route cache', label: 'cached_route(origin, destination, waypoints)', kind: 'sync'},
      {from: 'Route cache', to: 'Maps API', label: 'route', kind: 'reply'},
      {from: 'Maps API', to: 'Client', label: '201 {route_id, distance_m, epoch, degraded, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Serves POST /v1/routes and stores the route under the tenant',
      detail: 'A covered trip answers **201** with a `route_id` whose stored route belongs to the calling tenant.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/routes["']/, /save_route\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/routes['"]/, /saveRoute\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/routes"/, /routes\.SaveRoute\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"routes"\s*\)/, /Routes\.saveRoute\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/routes"/, /routes::saveRoute\(/]},
      },
    },
    {
      id: 'tenant',
      title: 'A request without a tenant is 401',
      detail:
        'No `X-Tenant-Id` answers **401** before anything is solved or stored; the starter routes it and stores the route under an empty tenant.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Tenant-Id/i, /StatusCodes\.Unauthorized|\b401\b/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'coordinates',
      title: 'A coordinate off the planet is 422',
      detail:
        'Every point is finite with `lat` within ±90 and `lng` within ±180, or the request is **422** with no engine call; the starter hands the raw floats to the solver.',
      match: {
        python: {all: [/math\.isfinite\(|isfinite\(/, /\b90\b/, /\b180\b/]},
        typescript: {all: [/Number\.isFinite\(/, /\b90\b/, /\b180\b/]},
        go: {all: [/math\.IsNaN\(|math\.IsInf\(/, /\b90\b/, /\b180\b/]},
        scala: {all: [/\.isNaN|\.isInfinite|isFinite/, /\b90\b/, /\b180\b/]},
        cpp: {all: [/std::isfinite\(|std::isnan\(/, /\b90\b/, /\b180\b/]},
      },
    },
    {
      id: 'waypoints',
      title: 'More than 25 waypoints is 422, before the solver',
      detail:
        'The waypoint count is compared with `MAX_WAYPOINTS` (25) before the route is computed, so a trip with hundreds of stops costs no solve; the starter forwards the whole list.',
      match: {
        python: {
          all: [/len\(body\.waypoints\)\s*>\s*(MAX_WAYPOINTS|25)/],
          order: [/len\(body\.waypoints\)\s*>/, /cached_route\(/],
        },
        typescript: {
          all: [/waypoints\.length\s*>\s*(MAX_WAYPOINTS|25)/],
          order: [/waypoints\.length\s*>/, /cachedRoute\(/],
        },
        go: {
          all: [/len\(body\.Waypoints\)\s*>\s*(maxWaypoints|MaxWaypoints|25)/],
          order: [/len\(body\.Waypoints\)\s*>/, /cache\.CachedRoute\(/],
        },
        scala: {
          all: [/waypoints\.(length|size)\s*>\s*(MaxWaypoints|25)/],
          order: [/waypoints\.(length|size)\s*>/, /RouteCache\.cachedRoute\(/],
        },
        cpp: {
          all: [/waypoints\.size\(\)\s*>\s*(kMaxWaypoints|25)|\["waypoints"\]\.size\(\)\s*>/],
          order: [/\.size\(\)\s*>\s*(kMaxWaypoints|25)/, /cache::cachedRoute\(/],
        },
      },
    },
    {
      id: 'coverage',
      title: "A point outside the tenant's coverage is 403",
      detail:
        "Every point is checked with the tenant's `covers` before the route is computed, and one outside it answers **403** `OUT_OF_COVERAGE`; the starter never consults coverage.",
      match: {
        python: {all: [/covers\(\s*tenant/, /OUT_OF_COVERAGE/, /\b403\b/], order: [/covers\(/, /cached_route\(/]},
        typescript: {all: [/covers\(\s*tenant/, /OUT_OF_COVERAGE/, /\b403\b/], order: [/covers\(/, /cachedRoute\(/]},
        go: {
          all: [/coverage\.Covers\(/, /OUT_OF_COVERAGE/, /StatusForbidden|\b403\b/],
          order: [/coverage\.Covers\(/, /cache\.CachedRoute\(/],
        },
        scala: {
          all: [/Coverage\.covers\(/, /OUT_OF_COVERAGE/, /StatusCodes\.Forbidden|\b403\b/],
          order: [/Coverage\.covers\(/, /RouteCache\.cachedRoute\(/],
        },
        cpp: {
          all: [/coverage::covers\(/, /OUT_OF_COVERAGE/, /\b403\b/],
          order: [/coverage::covers\(/, /cache::cachedRoute\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from mapsd import routes  # save_route
from mapsd.cache import cached_route
from mapsd.engine import NoRoute
from mapsd.geo import Point

app = FastAPI()


class LatLng(BaseModel):
    lat: float
    lng: float


class RouteRequest(BaseModel):
    origin: LatLng
    destination: LatLng
    waypoints: list[LatLng] = []


@app.post("/v1/routes")
def create_route(body: RouteRequest, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    origin = Point(body.origin.lat, body.origin.lng)
    destination = Point(body.destination.lat, body.destination.lng)
    waypoints = [Point(p.lat, p.lng) for p in body.waypoints]
    try:
        route = cached_route(origin, destination, waypoints)
    except NoRoute:
        return JSONResponse({"error": "NO_ROUTE"}, status_code=422)
    route_id = routes.save_route(tenant, route)
    return JSONResponse({"route_id": route_id, **route}, status_code=201)
`,
      solution: `import math

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from mapsd import routes  # save_route
from mapsd.cache import cached_route
from mapsd.coverage import covers
from mapsd.engine import NoRoute
from mapsd.geo import Point

app = FastAPI()

MAX_WAYPOINTS = 25


class LatLng(BaseModel):
    lat: float
    lng: float


class RouteRequest(BaseModel):
    origin: LatLng
    destination: LatLng
    waypoints: list[LatLng] = []


def valid(point: LatLng) -> bool:
    return math.isfinite(point.lat) and math.isfinite(point.lng) and abs(point.lat) <= 90 and abs(point.lng) <= 180


@app.post("/v1/routes")
def create_route(body: RouteRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    # The cheap refusals first: the solver is the expensive part, and every tenant shares it.
    if len(body.waypoints) > MAX_WAYPOINTS:
        return JSONResponse({"error": f"at most {MAX_WAYPOINTS} waypoints"}, status_code=422)
    if not all(valid(p) for p in [body.origin, body.destination, *body.waypoints]):
        return JSONResponse({"error": "every point needs a finite lat within ±90 and lng within ±180"}, status_code=422)
    origin = Point(body.origin.lat, body.origin.lng)
    destination = Point(body.destination.lat, body.destination.lng)
    waypoints = [Point(p.lat, p.lng) for p in body.waypoints]
    if not all(covers(tenant, p) for p in [origin, *waypoints, destination]):
        return JSONResponse({"error": "OUT_OF_COVERAGE"}, status_code=403)
    try:
        route = cached_route(origin, destination, waypoints)
    except NoRoute:
        return JSONResponse({"error": "NO_ROUTE"}, status_code=422)
    route_id = routes.save_route(tenant, route)
    return JSONResponse({"route_id": route_id, **route}, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {cachedRoute} from 'mapsd/cache';
import {NoRoute} from 'mapsd/engine';
import type {Point} from 'mapsd/geo';
import {saveRoute} from 'mapsd/routes';

export const app = Fastify();

interface RouteBody {
  origin: Point;
  destination: Point;
  waypoints?: Point[];
}

app.post('/v1/routes', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const {origin, destination, waypoints = []} = request.body as RouteBody;
  try {
    const route = await cachedRoute(origin, destination, waypoints);
    const routeId = await saveRoute(tenant, route);
    return reply.code(201).send({route_id: routeId, ...route});
  } catch (e) {
    if (e instanceof NoRoute) return reply.code(422).send({error: 'NO_ROUTE'});
    throw e;
  }
});
`,
      solution: `import Fastify from 'fastify';

import {cachedRoute} from 'mapsd/cache';
import {covers} from 'mapsd/coverage';
import {NoRoute} from 'mapsd/engine';
import type {Point} from 'mapsd/geo';
import {saveRoute} from 'mapsd/routes';

export const app = Fastify();

export const MAX_WAYPOINTS = 25;

interface RouteBody {
  origin: Point;
  destination: Point;
  waypoints?: Point[];
}

const valid = (p: Point | undefined): boolean =>
  p !== undefined && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

app.post('/v1/routes', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {origin, destination, waypoints = []} = request.body as RouteBody;
  // The cheap refusals first: the solver is the expensive part, and every tenant shares it.
  if (waypoints.length > MAX_WAYPOINTS) return reply.code(422).send({error: \`at most \${MAX_WAYPOINTS} waypoints\`});
  const points = [origin, ...waypoints, destination];
  if (!points.every(valid)) return reply.code(422).send({error: 'every point needs a finite lat within ±90 and lng within ±180'});
  for (const point of points) {
    if (!(await covers(tenant, point))) return reply.code(403).send({error: 'OUT_OF_COVERAGE'});
  }
  try {
    const route = await cachedRoute(origin, destination, waypoints);
    const routeId = await saveRoute(tenant, route);
    return reply.code(201).send({route_id: routeId, ...route});
  } catch (e) {
    if (e instanceof NoRoute) return reply.code(422).send({error: 'NO_ROUTE'});
    throw e;
  }
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"errors"
	"net/http"

	"mapsd/cache"  // cache.CachedRoute(ctx, origin, destination, waypoints) (geo.Route, error)
	"mapsd/engine" // engine.ErrNoRoute
	"mapsd/geo"    // geo.Point, geo.Route
	"mapsd/routes" // routes.SaveRoute(ctx, tenant, route) string
)

type routeRequest struct {
	Origin      geo.Point   \`json:"origin"\`
	Destination geo.Point   \`json:"destination"\`
	Waypoints   []geo.Point \`json:"waypoints"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func routeBody(routeID string, route geo.Route) map[string]any {
	return map[string]any{"route_id": routeID, "distance_m": route.DistanceM, "duration_s": route.DurationS, "geometry": route.Geometry,
		"epoch": route.Epoch, "engine_version": route.EngineVersion, "degraded": route.Degraded}
}

func createRoute(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body routeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "the body is not a route request"})
		return
	}
	route, err := cache.CachedRoute(r.Context(), body.Origin, body.Destination, body.Waypoints)
	if errors.Is(err, engine.ErrNoRoute) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "NO_ROUTE"})
		return
	}
	if err != nil {
		http.Error(rw, err.Error(), http.StatusBadGateway)
		return
	}
	routeID := routes.SaveRoute(r.Context(), tenant, route)
	writeJSON(rw, http.StatusCreated, routeBody(routeID, route))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/routes", createRoute)
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"

	"mapsd/cache"    // cache.CachedRoute(ctx, origin, destination, waypoints) (geo.Route, error)
	"mapsd/coverage" // coverage.Covers(ctx, tenant, point) bool
	"mapsd/engine"   // engine.ErrNoRoute
	"mapsd/geo"      // geo.Point, geo.Route
	"mapsd/routes"   // routes.SaveRoute(ctx, tenant, route) string
)

const maxWaypoints = 25

type routeRequest struct {
	Origin      geo.Point   \`json:"origin"\`
	Destination geo.Point   \`json:"destination"\`
	Waypoints   []geo.Point \`json:"waypoints"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func routeBody(routeID string, route geo.Route) map[string]any {
	return map[string]any{"route_id": routeID, "distance_m": route.DistanceM, "duration_s": route.DurationS, "geometry": route.Geometry,
		"epoch": route.Epoch, "engine_version": route.EngineVersion, "degraded": route.Degraded}
}

func valid(p geo.Point) bool {
	finite := !math.IsNaN(p.Lat) && !math.IsInf(p.Lat, 0) && !math.IsNaN(p.Lng) && !math.IsInf(p.Lng, 0)
	return finite && math.Abs(p.Lat) <= 90 && math.Abs(p.Lng) <= 180
}

func createRoute(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body routeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "the body is not a route request"})
		return
	}
	// The cheap refusals first: the solver is the expensive part, and every tenant shares it.
	if len(body.Waypoints) > maxWaypoints {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": fmt.Sprintf("at most %d waypoints", maxWaypoints)})
		return
	}
	points := append([]geo.Point{body.Origin}, body.Waypoints...)
	points = append(points, body.Destination)
	for _, p := range points {
		if !valid(p) {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "every point needs a finite lat within ±90 and lng within ±180"})
			return
		}
	}
	for _, p := range points {
		if !coverage.Covers(r.Context(), tenant, p) {
			writeJSON(rw, http.StatusForbidden, map[string]string{"error": "OUT_OF_COVERAGE"})
			return
		}
	}
	route, err := cache.CachedRoute(r.Context(), body.Origin, body.Destination, body.Waypoints)
	if errors.Is(err, engine.ErrNoRoute) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "NO_ROUTE"})
		return
	}
	if err != nil {
		http.Error(rw, err.Error(), http.StatusBadGateway)
		return
	}
	routeID := routes.SaveRoute(r.Context(), tenant, route)
	writeJSON(rw, http.StatusCreated, routeBody(routeID, route))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/routes", createRoute)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import mapsd.{Engine, Geo, RouteCache, Routes} // RouteCache.cachedRoute, Engine.NoRoute, Routes.saveRoute

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def point(value: JsValue): Geo.Point = {
    val f = value.asJsObject.fields
    Geo.Point(f("lat").asInstanceOf[JsNumber].value.toDouble, f("lng").asInstanceOf[JsNumber].value.toDouble)
  }

  val route: Route = path("v1" / "routes") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val tenant = tenantHeader.getOrElse("")
          val body = raw.parseJson.asJsObject.fields
          val origin = point(body("origin"))
          val destination = point(body("destination"))
          val waypoints = body.get("waypoints").map(_.asInstanceOf[JsArray].elements.map(point)).getOrElse(Vector.empty)
          try {
            val computed = RouteCache.cachedRoute(origin, destination, waypoints)
            val routeId = Routes.saveRoute(tenant, computed)
            complete(json(StatusCodes.Created, JsObject(Geo.toJson(computed).fields + ("route_id" -> JsString(routeId)))))
          } catch {
            case _: Engine.NoRoute => complete(error(StatusCodes.UnprocessableEntity, "NO_ROUTE"))
          }
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import mapsd.{Coverage, Engine, Geo, RouteCache, Routes} // RouteCache.cachedRoute, Coverage.covers, Engine.NoRoute, Routes.saveRoute

object Api {
  val MaxWaypoints = 25

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def point(value: JsValue): Geo.Point = {
    val f = value.asJsObject.fields
    Geo.Point(f("lat").asInstanceOf[JsNumber].value.toDouble, f("lng").asInstanceOf[JsNumber].value.toDouble)
  }

  private def valid(p: Geo.Point): Boolean =
    !p.lat.isNaN && !p.lat.isInfinite && !p.lng.isNaN && !p.lng.isInfinite && math.abs(p.lat) <= 90 && math.abs(p.lng) <= 180

  val route: Route = path("v1" / "routes") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val origin = point(body("origin"))
            val destination = point(body("destination"))
            val waypoints = body.get("waypoints").map(_.asInstanceOf[JsArray].elements.map(point)).getOrElse(Vector.empty)
            val points = origin +: waypoints :+ destination
            // The cheap refusals first: the solver is the expensive part, and every tenant shares it.
            if (waypoints.length > MaxWaypoints) complete(error(StatusCodes.UnprocessableEntity, s"at most $MaxWaypoints waypoints"))
            else if (!points.forall(valid)) complete(error(StatusCodes.UnprocessableEntity, "every point needs a finite lat within ±90 and lng within ±180"))
            else if (!points.forall(p => Coverage.covers(tenant, p))) complete(error(StatusCodes.Forbidden, "OUT_OF_COVERAGE"))
            else
              try {
                val computed = RouteCache.cachedRoute(origin, destination, waypoints)
                val routeId = Routes.saveRoute(tenant, computed)
                complete(json(StatusCodes.Created, JsObject(Geo.toJson(computed).fields + ("route_id" -> JsString(routeId)))))
              } catch {
                case _: Engine.NoRoute => complete(error(StatusCodes.UnprocessableEntity, "NO_ROUTE"))
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
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "mapsd/cache.h"   // cache::cachedRoute(origin, destination, waypoints) -> geo::Route
#include "mapsd/engine.h"  // engine::NoRoute
#include "mapsd/geo.h"     // geo::Point, geo::Route, geo::toJson
#include "mapsd/routes.h"  // routes::saveRoute(tenant, route) -> id

using json = nlohmann::json;

geo::Point point(const json& j) { return geo::Point{j.at("lat").get<double>(), j.at("lng").get<double>()}; }

void create_route(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body);
  const geo::Point origin = point(body.at("origin"));
  const geo::Point destination = point(body.at("destination"));
  std::vector<geo::Point> waypoints;
  for (const json& w : body.value("waypoints", json::array())) waypoints.push_back(point(w));
  try {
    const geo::Route route = cache::cachedRoute(origin, destination, waypoints);
    json out = geo::toJson(route);
    out["route_id"] = routes::saveRoute(tenant, route);
    res.status = 201;
    res.set_content(out.dump(), "application/json");
  } catch (const engine::NoRoute&) {
    res.status = 422;
    res.set_content(json{{"error", "NO_ROUTE"}}.dump(), "application/json");
  }
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/routes", create_route); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <string>
#include <vector>

#include "mapsd/cache.h"     // cache::cachedRoute(origin, destination, waypoints) -> geo::Route
#include "mapsd/coverage.h"  // coverage::covers(tenant, point) -> bool
#include "mapsd/engine.h"    // engine::NoRoute
#include "mapsd/geo.h"       // geo::Point, geo::Route, geo::toJson
#include "mapsd/routes.h"    // routes::saveRoute(tenant, route) -> id

using json = nlohmann::json;

constexpr size_t kMaxWaypoints = 25;

geo::Point point(const json& j) { return geo::Point{j.at("lat").get<double>(), j.at("lng").get<double>()}; }

bool valid(const geo::Point& p) {
  return std::isfinite(p.lat) && std::isfinite(p.lng) && std::abs(p.lat) <= 90 && std::abs(p.lng) <= 180;
}

void reply(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json{{"error", error}}.dump(), "application/json");
}

void create_route(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body);
  const geo::Point origin = point(body.at("origin"));
  const geo::Point destination = point(body.at("destination"));
  std::vector<geo::Point> waypoints;
  for (const json& w : body.value("waypoints", json::array())) waypoints.push_back(point(w));
  // The cheap refusals first: the solver is the expensive part, and every tenant shares it.
  if (waypoints.size() > kMaxWaypoints) return reply(res, 422, "at most 25 waypoints");
  std::vector<geo::Point> points = {origin};
  points.insert(points.end(), waypoints.begin(), waypoints.end());
  points.push_back(destination);
  for (const geo::Point& p : points) {
    if (!valid(p)) return reply(res, 422, "every point needs a finite lat within ±90 and lng within ±180");
  }
  for (const geo::Point& p : points) {
    if (!coverage::covers(tenant, p)) return reply(res, 403, "OUT_OF_COVERAGE");
  }
  try {
    const geo::Route route = cache::cachedRoute(origin, destination, waypoints);
    json out = geo::toJson(route);
    out["route_id"] = routes::saveRoute(tenant, route);
    res.status = 201;
    res.set_content(out.dump(), "application/json");
  } catch (const engine::NoRoute&) {
    reply(res, 422, "NO_ROUTE");
  }
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/routes", create_route); }
`,
    },
  },
  harness: {
    python: `import grpc

import maps_routing_pb2
import maps_routing_pb2_grpc
from mapsd import routes
from mapsd.coverage import set_coverage
from mapsd.geo import haversine_m

SF = {"lat": 37.77412, "lng": -122.41942}
OAKLAND = {"lat": 37.80418, "lng": -122.27112}
BERKELEY = {"lat": 37.87159, "lng": -122.27275}
ALCATRAZ = {"lat": 37.82667, "lng": -122.42306}
LA = {"lat": 34.05223, "lng": -118.24368}
PASADENA = {"lat": 34.14778, "lng": -118.14452}
ACME = {"X-Tenant-Id": "acme"}


class Engine(maps_routing_pb2_grpc.RoutingEngineServicer):
    """A road route is 1.3 times the great-circle legs; no road reaches Alcatraz."""

    def ComputeRoute(self, request, context):
        points = [request.origin, *request.waypoints, request.destination]
        if any(abs(p.lat - ALCATRAZ["lat"]) < 0.001 and abs(p.lng - ALCATRAZ["lng"]) < 0.001 for p in points):
            context.abort(grpc.StatusCode.NOT_FOUND, "no road reaches Alcatraz")
        distance = 1.3 * sum(haversine_m(a, b) for a, b in zip(points, points[1:]))
        return maps_routing_pb2.ComputeRouteReply(distance_m=distance, duration_s=distance / 11, geometry=f"poly:{len(points)}", engine_version="osrm-v26.9")


def _api(ctx):
    ctx.grpc.serve(maps_routing_pb2_grpc.add_RoutingEngineServicer_to_server, Engine())
    set_coverage("acme", 37.0, 38.5, -123.0, -121.5)
    set_coverage("south", 33.5, 34.5, -118.8, -117.6)
    return ctx.client(ctx.load("api").app)


def _trip(origin=SF, destination=OAKLAND, waypoints=()):
    return {"origin": origin, "destination": destination, "waypoints": list(waypoints)}


def _solves(ctx):
    return len(ctx.grpc.calls_to("ComputeRoute"))


async def check_routes(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/routes", json=_trip(waypoints=[BERKELEY]), headers=ACME)
        assert r.status_code == 201, f"a covered trip answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("degraded") is False and body.get("distance_m", 0) > 0, f"the answer must carry the engine's route, got {body}"
        stored = routes.load_route(str(body.get("route_id")))
        assert stored is not None and stored["tenant"] == "acme", f"route {body.get('route_id')} must be stored under tenant acme, the store holds {stored}"
        r = await c.post("/v1/routes", json=_trip(destination=ALCATRAZ), headers=ACME)
    assert r.status_code == 422 and "NO_ROUTE" in r.text, f"a trip no road connects answered {r.status_code} {r.text}, expected 422 NO_ROUTE"


async def check_tenant(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/routes", json=_trip())
    assert r.status_code == 401, f"a route request without X-Tenant-Id answered {r.status_code}, expected 401"
    assert _solves(ctx) == 0, "the engine solved a trip for a request with no tenant"
    assert not ctx.redis.keys("routes:r-*"), f"a route was stored for nobody: {ctx.redis.keys('routes:r-*')}"


async def check_coordinates(ctx):
    async with _api(ctx) as c:
        for trip, what in (
            (_trip(origin={"lat": 91.0, "lng": SF["lng"]}), "an origin at lat 91"),
            (_trip(destination={"lat": OAKLAND["lat"], "lng": -190.0}), "a destination at lng -190"),
            (_trip(waypoints=[{"lat": -95.0, "lng": BERKELEY["lng"]}]), "a waypoint at lat -95"),
        ):
            r = await c.post("/v1/routes", json=trip, headers=ACME)
            assert r.status_code == 422, f"{what} answered {r.status_code}, expected 422"
        nan = '{"origin": {"lat": NaN, "lng": -122.41942}, "destination": {"lat": 37.80418, "lng": -122.27112}}'
        r = await c.post("/v1/routes", content=nan, headers={**ACME, "content-type": "application/json"})
        assert r.status_code == 422, f"an origin at lat NaN answered {r.status_code}, expected 422"
    assert _solves(ctx) == 0, f"the engine was asked to solve {_solves(ctx)} trip(s) with a coordinate off the planet: refuse them before the solver"


async def check_waypoints(ctx):
    stops = [{"lat": 37.78 + i * 0.002, "lng": -122.40} for i in range(26)]
    async with _api(ctx) as c:
        r = await c.post("/v1/routes", json=_trip(waypoints=stops), headers=ACME)
        assert r.status_code == 422, f"a trip with 26 waypoints answered {r.status_code}, expected 422 (MAX_WAYPOINTS is 25)"
        assert _solves(ctx) == 0, "a trip with 26 waypoints reached the solver"
        r = await c.post("/v1/routes", json=_trip(waypoints=stops[:25]), headers=ACME)
    assert r.status_code == 201, f"a trip with 25 waypoints answered {r.status_code}: {r.text}, expected 201"


async def check_coverage(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/routes", json=_trip(destination=LA), headers=ACME)
        assert r.status_code == 403 and "OUT_OF_COVERAGE" in r.text, f"a Bay Area tenant asking for Los Angeles answered {r.status_code} {r.text}, expected 403 OUT_OF_COVERAGE"
        r = await c.post("/v1/routes", json=_trip(waypoints=[PASADENA]), headers=ACME)
        assert r.status_code == 403, f"a waypoint outside the tenant's coverage answered {r.status_code}, expected 403"
        r = await c.post("/v1/routes", json=_trip(), headers={"X-Tenant-Id": "nobody"})
        assert r.status_code == 403, f"a tenant with no coverage answered {r.status_code}, expected 403"
        assert _solves(ctx) == 0, f"the engine solved {_solves(ctx)} trip(s) outside the tenant's coverage"
        r = await c.post("/v1/routes", json=_trip(origin=LA, destination=PASADENA), headers={"X-Tenant-Id": "south"})
    assert r.status_code == 201, f"a Los Angeles trip for the Los Angeles tenant answered {r.status_code}: {r.text}, expected 201"
`,
    typescript: `const SF = {lat: 37.77412, lng: -122.41942};
const OAKLAND = {lat: 37.80418, lng: -122.27112};
const BERKELEY = {lat: 37.87159, lng: -122.27275};
const ALCATRAZ = {lat: 37.82667, lng: -122.42306};
const LA = {lat: 34.05223, lng: -118.24368};
const PASADENA = {lat: 34.14778, lng: -118.14452};
const ACME = {'X-Tenant-Id': 'acme'};

/** The engine stand-in (a road route is 1.3 times the great-circle legs; no road reaches Alcatraz) and the tenants' coverage. */
async function api(ctx) {
  const {haversineM} = ctx.load('/support/mapsd/geo.ts');
  const pkg = ctx.proto('maps_routing.proto');
  ctx.grpc.serve(pkg.mapsrouting.RoutingEngine.service, {
    ComputeRoute(call, callback) {
      const points = [call.request.origin, ...call.request.waypoints, call.request.destination];
      if (points.some(p => Math.abs(p.lat - ALCATRAZ.lat) < 0.001 && Math.abs(p.lng - ALCATRAZ.lng) < 0.001)) {
        return callback({code: ctx.grpc.status.NOT_FOUND, details: 'no road reaches Alcatraz'});
      }
      let distance = 0;
      for (let i = 1; i < points.length; i += 1) distance += haversineM(points[i - 1], points[i]);
      distance *= 1.3;
      callback(null, {distance_m: distance, duration_s: distance / 11, geometry: \`poly:\${points.length}\`, engine_version: 'osrm-v26.9'});
    },
  });
  const {setCoverage} = ctx.load('/support/mapsd/coverage.ts');
  await setCoverage('acme', 37.0, 38.5, -123.0, -121.5);
  await setCoverage('south', 33.5, 34.5, -118.8, -117.6);
  return {c: ctx.client(ctx.load('api').app), routes: ctx.load('/support/mapsd/routes.ts')};
}

const trip = ({origin = SF, destination = OAKLAND, waypoints = []}: {origin?: object; destination?: object; waypoints?: object[]} = {}) => ({origin, destination, waypoints});

const solves = ctx => ctx.grpc.callsTo('ComputeRoute').length;

export async function check_routes(ctx) {
  const {c, routes} = await api(ctx);
  let r = await c.post('/v1/routes', {json: trip({waypoints: [BERKELEY]}), headers: ACME});
  assert.equal(r.status, 201, \`a covered trip answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.degraded === false && body.distance_m > 0, \`the answer must carry the engine's route, got \${r.text}\`);
  const stored = await routes.loadRoute(String(body.route_id));
  assert(stored !== null && stored.tenant === 'acme', \`route \${body.route_id} must be stored under tenant acme, the store holds \${JSON.stringify(stored)}\`);
  r = await c.post('/v1/routes', {json: trip({destination: ALCATRAZ}), headers: ACME});
  assert(r.status === 422 && r.text.includes('NO_ROUTE'), \`a trip no road connects answered \${r.status} \${r.text}, expected 422 NO_ROUTE\`);
}

export async function check_tenant(ctx) {
  const {c} = await api(ctx);
  const r = await c.post('/v1/routes', {json: trip()});
  assert.equal(r.status, 401, \`a route request without X-Tenant-Id answered \${r.status}, expected 401\`);
  assert.equal(solves(ctx), 0, 'the engine solved a trip for a request with no tenant');
  assert.deepStrictEqual(ctx.redis.keys('routes:r-*'), [], 'a route was stored for nobody');
}

export async function check_coordinates(ctx) {
  const {c} = await api(ctx);
  const bad: [object, string][] = [
    [trip({origin: {lat: 91.0, lng: SF.lng}}), 'an origin at lat 91'],
    [trip({destination: {lat: OAKLAND.lat, lng: -190.0}}), 'a destination at lng -190'],
    [trip({waypoints: [{lat: -95.0, lng: BERKELEY.lng}]}), 'a waypoint at lat -95'],
  ];
  for (const [body, what] of bad) {
    const r = await c.post('/v1/routes', {json: body, headers: ACME});
    assert.equal(r.status, 422, \`\${what} answered \${r.status}, expected 422\`);
  }
  assert.equal(solves(ctx), 0, \`the engine was asked to solve \${solves(ctx)} trip(s) with a coordinate off the planet: refuse them before the solver\`);
}

export async function check_waypoints(ctx) {
  const {c} = await api(ctx);
  const stops = Array.from({length: 26}, (_, i) => ({lat: 37.78 + i * 0.002, lng: -122.4}));
  let r = await c.post('/v1/routes', {json: trip({waypoints: stops}), headers: ACME});
  assert.equal(r.status, 422, \`a trip with 26 waypoints answered \${r.status}, expected 422 (MAX_WAYPOINTS is 25)\`);
  assert.equal(solves(ctx), 0, 'a trip with 26 waypoints reached the solver');
  r = await c.post('/v1/routes', {json: trip({waypoints: stops.slice(0, 25)}), headers: ACME});
  assert.equal(r.status, 201, \`a trip with 25 waypoints answered \${r.status}: \${r.text}, expected 201\`);
}

export async function check_coverage(ctx) {
  const {c} = await api(ctx);
  let r = await c.post('/v1/routes', {json: trip({destination: LA}), headers: ACME});
  assert(r.status === 403 && r.text.includes('OUT_OF_COVERAGE'), \`a Bay Area tenant asking for Los Angeles answered \${r.status} \${r.text}, expected 403 OUT_OF_COVERAGE\`);
  r = await c.post('/v1/routes', {json: trip({waypoints: [PASADENA]}), headers: ACME});
  assert.equal(r.status, 403, \`a waypoint outside the tenant's coverage answered \${r.status}, expected 403\`);
  r = await c.post('/v1/routes', {json: trip(), headers: {'X-Tenant-Id': 'nobody'}});
  assert.equal(r.status, 403, \`a tenant with no coverage answered \${r.status}, expected 403\`);
  assert.equal(solves(ctx), 0, \`the engine solved \${solves(ctx)} trip(s) outside the tenant's coverage\`);
  r = await c.post('/v1/routes', {json: trip({origin: LA, destination: PASADENA}), headers: {'X-Tenant-Id': 'south'}});
  assert.equal(r.status, 201, \`a Los Angeles trip for the Los Angeles tenant answered \${r.status}: \${r.text}, expected 201\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"mapsd/coverage"
	pb "mapsd/gen/maps_routing"
	"mapsd/geo"
	"mapsd/routes"

	"leetbuild/harness"
)

type point = map[string]float64

var (
	apiBg    = context.Background()
	sf       = point{"lat": 37.77412, "lng": -122.41942}
	oakland  = point{"lat": 37.80418, "lng": -122.27112}
	berkeley = point{"lat": 37.87159, "lng": -122.27275}
	alcatraz = point{"lat": 37.82667, "lng": -122.42306}
	la       = point{"lat": 34.05223, "lng": -118.24368}
	pasadena = point{"lat": 34.14778, "lng": -118.14452}
)

// enginePeer: a road route is 1.3 times the great-circle legs; no road reaches Alcatraz.
type enginePeer struct {
	pb.UnimplementedRoutingEngineServer
}

func (enginePeer) ComputeRoute(_ context.Context, req *pb.ComputeRouteRequest) (*pb.ComputeRouteReply, error) {
	points := append([]*pb.LatLng{req.GetOrigin()}, req.GetWaypoints()...)
	points = append(points, req.GetDestination())
	distance := 0.0
	for i, p := range points {
		if math.Abs(p.GetLat()-alcatraz["lat"]) < 0.001 && math.Abs(p.GetLng()-alcatraz["lng"]) < 0.001 {
			return nil, status.Error(codes.NotFound, "no road reaches Alcatraz")
		}
		if i > 0 {
			distance += geo.HaversineM(geo.Point{Lat: points[i-1].GetLat(), Lng: points[i-1].GetLng()}, geo.Point{Lat: p.GetLat(), Lng: p.GetLng()})
		}
	}
	distance *= 1.3
	return &pb.ComputeRouteReply{DistanceM: distance, DurationS: distance / 11, Geometry: fmt.Sprintf("poly:%d", len(points)), EngineVersion: "osrm-v26.9"}, nil
}

func api(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterRoutingEngineServer(ctx.GRPC.Server(""), enginePeer{})
	coverage.SetCoverage(apiBg, "acme", 37.0, 38.5, -123.0, -121.5)
	coverage.SetCoverage(apiBg, "south", 33.5, 34.5, -118.8, -117.6)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func trip(origin, destination point, waypoints ...point) map[string]any {
	if waypoints == nil {
		waypoints = []point{}
	}
	return map[string]any{"origin": origin, "destination": destination, "waypoints": waypoints}
}

func solves(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("ComputeRoute", "")) }

func CheckRoutes(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/routes", trip(sf, oakland, berkeley), "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 201, "a covered trip (%s)", r.Text())
	var body struct {
		RouteID   string  \`json:"route_id"\`
		DistanceM float64 \`json:"distance_m"\`
		Degraded  bool    \`json:"degraded"\`
	}
	r.Decode(&body)
	ctx.Assert(!body.Degraded && body.DistanceM > 0, "the answer must carry the engine's route, got %s", r.Text())
	stored := routes.LoadRoute(apiBg, body.RouteID)
	ctx.Assert(stored != nil && stored.Tenant == "acme", "route %s must be stored under tenant acme, the store holds %+v", body.RouteID, stored)
	r = c.Post("/v1/routes", trip(sf, alcatraz), "X-Tenant-Id", "acme")
	ctx.Assert(r.Status == 422 && strings.Contains(r.Text(), "NO_ROUTE"), "a trip no road connects answered %d %s, expected 422 NO_ROUTE", r.Status, r.Text())
}

func CheckTenant(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/routes", trip(sf, oakland))
	ctx.Equal(r.Status, 401, "a route request without X-Tenant-Id")
	ctx.Equal(solves(ctx), 0, "the engine solved a trip for a request with no tenant; the solves")
	ctx.Equal(len(ctx.Redis.Keys("routes:r-*")), 0, "a route was stored for nobody; the stored routes")
}

func CheckCoordinates(ctx *harness.Ctx) {
	c := api(ctx)
	bad := []struct {
		body map[string]any
		what string
	}{
		{trip(point{"lat": 91.0, "lng": sf["lng"]}, oakland), "an origin at lat 91"},
		{trip(sf, point{"lat": oakland["lat"], "lng": -190.0}), "a destination at lng -190"},
		{trip(sf, oakland, point{"lat": -95.0, "lng": berkeley["lng"]}), "a waypoint at lat -95"},
	}
	for _, b := range bad {
		r := c.Post("/v1/routes", b.body, "X-Tenant-Id", "acme")
		ctx.Equal(r.Status, 422, "%s", b.what)
	}
	ctx.Equal(solves(ctx), 0, "the engine was asked to solve trips with a coordinate off the planet (refuse them before the solver); the solves")
}

func CheckWaypoints(ctx *harness.Ctx) {
	c := api(ctx)
	stops := make([]point, 26)
	for i := range stops {
		stops[i] = point{"lat": 37.78 + float64(i)*0.002, "lng": -122.4}
	}
	r := c.Post("/v1/routes", trip(sf, oakland, stops...), "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 422, "a trip with 26 waypoints (MAX_WAYPOINTS is 25)")
	ctx.Equal(solves(ctx), 0, "a trip with 26 waypoints reached the solver; the solves")
	r = c.Post("/v1/routes", trip(sf, oakland, stops[:25]...), "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 201, "a trip with 25 waypoints (%s)", r.Text())
}

func CheckCoverage(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/routes", trip(sf, la), "X-Tenant-Id", "acme")
	ctx.Assert(r.Status == 403 && strings.Contains(r.Text(), "OUT_OF_COVERAGE"), "a Bay Area tenant asking for Los Angeles answered %d %s, expected 403 OUT_OF_COVERAGE", r.Status, r.Text())
	r = c.Post("/v1/routes", trip(sf, oakland, pasadena), "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 403, "a waypoint outside the tenant's coverage")
	r = c.Post("/v1/routes", trip(sf, oakland), "X-Tenant-Id", "nobody")
	ctx.Equal(r.Status, 403, "a tenant with no coverage")
	ctx.Equal(solves(ctx), 0, "the engine solved trips outside the tenant's coverage; the solves")
	r = c.Post("/v1/routes", trip(la, pasadena), "X-Tenant-Id", "south")
	ctx.Equal(r.Status, 201, "a Los Angeles trip for the Los Angeles tenant (%s)", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>
#include <vector>

#include "maps_routing.grpc.pb.h"
#include "mapsd/coverage.h"
#include "mapsd/geo.h"
#include "mapsd/routes.h"

using json = nlohmann::json;

namespace {

const json kSf = {{"lat", 37.77412}, {"lng", -122.41942}};
const json kOakland = {{"lat", 37.80418}, {"lng", -122.27112}};
const json kBerkeley = {{"lat", 37.87159}, {"lng", -122.27275}};
const json kAlcatraz = {{"lat", 37.82667}, {"lng", -122.42306}};
const json kLa = {{"lat", 34.05223}, {"lng", -118.24368}};
const json kPasadena = {{"lat", 34.14778}, {"lng", -118.14452}};

// A road route is 1.3 times the great-circle legs; no road reaches Alcatraz.
class EnginePeer final : public mapsrouting::RoutingEngine::Service {
 public:
  grpc::Status ComputeRoute(grpc::ServerContext*, const mapsrouting::ComputeRouteRequest* req, mapsrouting::ComputeRouteReply* out) override {
    std::vector<geo::Point> points = {{req->origin().lat(), req->origin().lng()}};
    for (const auto& w : req->waypoints()) points.push_back({w.lat(), w.lng()});
    points.push_back({req->destination().lat(), req->destination().lng()});
    double distance = 0;
    for (size_t i = 0; i < points.size(); i++) {
      if (std::abs(points[i].lat - 37.82667) < 0.001 && std::abs(points[i].lng + 122.42306) < 0.001) {
        return grpc::Status(grpc::StatusCode::NOT_FOUND, "no road reaches Alcatraz");
      }
      if (i > 0) distance += geo::haversineM(points[i - 1], points[i]);
    }
    distance *= 1.3;
    out->set_distance_m(distance);
    out->set_duration_s(distance / 11);
    out->set_geometry("poly:" + std::to_string(points.size()));
    out->set_engine_version("osrm-v26.9");
    return grpc::Status::OK;
  }
};

harness::HTTP api(harness::Ctx& ctx) {
  static EnginePeer* peer = nullptr;
  static httplib::Server* svr = nullptr;
  delete peer;
  peer = new EnginePeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  coverage::setCoverage("acme", 37.0, 38.5, -123.0, -121.5);
  coverage::setCoverage("south", 33.5, 34.5, -118.8, -117.6);
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string trip(const json& origin, const json& destination, const json& waypoints = json::array()) {
  return json{{"origin", origin}, {"destination", destination}, {"waypoints", waypoints}}.dump();
}

harness::Response post(harness::HTTP& c, const std::string& body, const std::string& tenant) {
  return c.Post("/v1/routes", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

size_t solves(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("ComputeRoute").size(); }

bool has(const std::string& text, const std::string& part) { return text.find(part) != std::string::npos; }

}  // namespace

void CheckRoutes(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, trip(kSf, kOakland, json::array({kBerkeley})), "acme");
  ctx.Equal(r.Status, 201, "a covered trip (%s)", r.Text());
  const json body = json::parse(r.Text());
  ctx.Assert(!body.value("degraded", true) && body.value("distance_m", 0.0) > 0, "the answer must carry the engine's route, got %s", r.Text());
  const std::string route_id = body.value("route_id", "");
  const auto stored = routes::loadRoute(route_id);
  ctx.Assert(stored && stored->tenant == "acme", "route %s must be stored under tenant acme, the store holds tenant %q", route_id, stored ? stored->tenant : "(none)");
  r = post(c, trip(kSf, kAlcatraz), "acme");
  ctx.Assert(r.Status == 422 && has(r.Text(), "NO_ROUTE"), "a trip no road connects answered %d %s, expected 422 NO_ROUTE", r.Status, r.Text());
}

void CheckTenant(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = c.Post("/v1/routes", trip(kSf, kOakland), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a route request without X-Tenant-Id");
  ctx.Equal(solves(ctx), 0, "the engine solved a trip for a request with no tenant; the solves");
  ctx.Equal(ctx.Redis.Keys("routes:r-*").size(), 0, "a route was stored for nobody; the stored routes");
}

void CheckCoordinates(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::pair<std::string, std::string>> bad = {
      {trip({{"lat", 91.0}, {"lng", -122.41942}}, kOakland), "an origin at lat 91"},
      {trip(kSf, {{"lat", 37.80418}, {"lng", -190.0}}), "a destination at lng -190"},
      {trip(kSf, kOakland, json::array({{{"lat", -95.0}, {"lng", -122.27275}}})), "a waypoint at lat -95"},
  };
  for (const auto& [body, what] : bad) {
    const auto r = post(c, body, "acme");
    ctx.Equal(r.Status, 422, "%s", what);
  }
  ctx.Equal(solves(ctx), 0, "the engine was asked to solve trips with a coordinate off the planet (refuse them before the solver); the solves");
}

void CheckWaypoints(harness::Ctx& ctx) {
  auto c = api(ctx);
  json stops = json::array();
  for (int i = 0; i < 26; i++) stops.push_back({{"lat", 37.78 + i * 0.002}, {"lng", -122.4}});
  auto r = post(c, trip(kSf, kOakland, stops), "acme");
  ctx.Equal(r.Status, 422, "a trip with 26 waypoints (MAX_WAYPOINTS is 25)");
  ctx.Equal(solves(ctx), 0, "a trip with 26 waypoints reached the solver; the solves");
  stops.erase(stops.end() - 1);
  r = post(c, trip(kSf, kOakland, stops), "acme");
  ctx.Equal(r.Status, 201, "a trip with 25 waypoints (%s)", r.Text());
}

void CheckCoverage(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, trip(kSf, kLa), "acme");
  ctx.Assert(r.Status == 403 && has(r.Text(), "OUT_OF_COVERAGE"), "a Bay Area tenant asking for Los Angeles answered %d %s, expected 403 OUT_OF_COVERAGE", r.Status, r.Text());
  r = post(c, trip(kSf, kOakland, json::array({kPasadena})), "acme");
  ctx.Equal(r.Status, 403, "a waypoint outside the tenant's coverage");
  r = post(c, trip(kSf, kOakland), "nobody");
  ctx.Equal(r.Status, 403, "a tenant with no coverage");
  ctx.Equal(solves(ctx), 0, "the engine solved trips outside the tenant's coverage; the solves");
  r = post(c, trip(kLa, kPasadena), "south");
  ctx.Equal(r.Status, 201, "a Los Angeles trip for the Los Angeles tenant (%s)", r.Text());
}
`,
  },
  hints: [
    'Send a trip with `lat: 91`, one that ends in Los Angeles for a Bay Area tenant, and one with no tenant at all: each comes back 201 with a route, and the engine logged a solve for every one.',
    "The handler goes straight from the parsed body to `cached_route`. Nothing between them looks at the tenant header, the number of waypoints, the coordinates' range or the tenant's coverage box, so the solver is the first thing that sees a bad request.",
    'Before `cached_route`: 401 on an empty `X-Tenant-Id`; 422 when `len(body.waypoints) > MAX_WAYPOINTS`; 422 unless every point passes `math.isfinite` with `abs(lat) <= 90` and `abs(lng) <= 180`; 403 `OUT_OF_COVERAGE` unless `covers(tenant, p)` for every point.',
  ],
  debrief: `The refusals run in cost order because the solver is the one expensive resource every tenant shares: a header, a count and a range cost nothing, coverage is one Redis read per point, and only a request that passed them buys a solve. Counting the waypoints before validating them keeps a body with thousands of stops from being walked at all. Coverage is per tenant, which is why the answer is a 403 that names it: the same trip is fine for a tenant whose map covers it. Production routers also snap each point to the road graph and refuse points too far from any road (OSRM answers \`NoSegment\`), cap the body size before parsing it, and rate-limit solves per tenant.`,
};
