import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/routes: coordinates that exist on the planet',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'coverage'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it decodes the route request,
hands the points straight to the routing engine and returns the plan. It compiles, it serves the
demo, and it hides three production flaws. Review it like the service owner, fix it, and prove the
fix with the checks below.

Implement \`POST /v1/routes\`. The body is
\`{"origin": {"lat": 37.77, "lng": -122.41}, "destination": {"lat": 34.05, "lng": -118.24}, "waypoints": [{"lat": 36.77, "lng": -119.41}]}\`;
\`waypoints\` is optional and defaults to \`[]\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`origin\` and \`destination\` are required, and every point — the two endpoints and each waypoint
  — is a pair of finite numbers: \`lat\` inside **±90**, \`lng\` inside **±180**. NaN, ±Infinity,
  a missing point or an out-of-range value is **422**, before the routing engine sees anything.
- At most **25 waypoints**. The cap is a length check, so it runs before the points are validated
  and before the solver is called: a 5000-waypoint list is rejected, not forwarded.
- Both endpoints must fall inside the tenant's map coverage (\`coverage.covers(tenant, …)\`); an
  out-of-coverage pair is **403** with an \`OUT_OF_COVERAGE\` error — never a straight-line guess
  dressed up as a route.
- Call the engine with the validated points and answer **201** with
  \`{"route_id": …, "distance_m": …, "geometry": …}\`.

**Failure mode the checks target.** The draft forwards whatever floats arrived straight into the
solver. One \`NaN\` in an origin poisons the spatial index the engine builds, and a 5000-waypoint
request turns one client call into a stalled solver for every other tenant. Coverage is the quiet
one: a draft that treats the map as global answers an out-of-coverage pair with a plan the tenant's
data does not support. Cheap rejections first — authentication, shape, the cap, coordinate validity,
then coverage — so no request buys engine time its caller cannot pay for.`,
  sequence: {
    participants: ['Client', 'Maps API', 'Coverage store', 'Routing engine'],
    messages: [
      {from: 'Client', to: 'Maps API', label: 'POST /v1/routes · X-Tenant-Id', kind: 'sync'},
      {from: 'Maps API', to: 'Maps API', label: '401 · 422 shape · 422 cap · 422 coordinates', kind: 'sync'},
      {from: 'Maps API', to: 'Coverage store', label: 'covers(tenant, origin · destination)', kind: 'sync'},
      {from: 'Coverage store', to: 'Maps API', label: 'inside / outside', kind: 'reply'},
      {from: 'Maps API', to: 'Routing engine', label: 'Solve(validated points)', kind: 'sync'},
      {from: 'Routing engine', to: 'Maps API', label: 'plan · geometry', kind: 'reply'},
      {from: 'Maps API', to: 'Client', label: '201 {route_id, distance_m, geometry}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'routes',
      title: 'Handles POST /v1/routes',
      detail: 'Register the routing endpoint on `POST /v1/routes`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/routes["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/routes['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/routes"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"routes"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/routes"/]},
      },
    },
    {
      id: 'finite',
      title: 'Rejects NaN, infinite and out-of-range coordinates',
      detail:
        'Every point is finite and inside ±90 lat / ±180 lng, and a bad coordinate answers **422** before the engine is called. The draft forwards raw floats, so one `NaN` reaches the solver and poisons its spatial index.',
      match: {
        python: {all: [/math\.isfinite/, /MAX_LAT/, /MAX_LNG/, /status_code\s*=\s*422/]},
        typescript: {all: [/Number\.isFinite/, /MAX_LAT/, /MAX_LNG/, /code\(\s*422\s*\)/]},
        go: {all: [/math\.IsNaN/, /math\.IsInf/, /maxLat/, /maxLng/, /StatusUnprocessableEntity/]},
        scala: {all: [/isNaN/, /isInfinite/, /MaxLat/, /MaxLng/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/std::isfinite/, /kMaxLat/, /kMaxLng/, /\b422\b/]},
      },
    },
    {
      id: 'waypoints',
      title: 'Caps a route at 25 waypoints before the solver runs',
      detail:
        'More than **25** waypoints is **422**, and the cap is checked before `solver.plan(…)` is reached — a 5000-waypoint list must never buy engine time. The draft forwards the whole list.',
      match: {
        python: {
          all: [/MAX_WAYPOINTS/, /status_code\s*=\s*422/],
          order: [/len\(body\.waypoints\) > MAX_WAYPOINTS/, /solver\.plan\(/],
        },
        typescript: {
          all: [/MAX_WAYPOINTS/, /code\(\s*422\s*\)/],
          order: [/length > MAX_WAYPOINTS/, /solver\.plan\(/],
        },
        go: {
          all: [/maxWaypoints/, /StatusUnprocessableEntity/],
          order: [/len\(body\.Waypoints\) > maxWaypoints/, /solver\.Plan\(/],
        },
        scala: {
          all: [/MaxWaypoints/, /StatusCodes\.UnprocessableEntity/],
          order: [/body\.waypoints\.length > MaxWaypoints/, /solver\.plan\(/],
        },
        cpp: {
          all: [/kMaxWaypoints/, /\b422\b/],
          order: [/listed\.size\(\) > kMaxWaypoints/, /solver\.plan\(/],
        },
      },
    },
    {
      id: 'coverage',
      title: 'Scopes coverage to the tenant and refuses to guess',
      detail:
        'The tenant is required — **401** when `X-Tenant-Id` is absent — and an out-of-coverage endpoint pair is **403** with an `OUT_OF_COVERAGE` error instead of a straight-line route. The draft treats coverage as global.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/, /OUT_OF_COVERAGE/, /status_code\s*=\s*403/]},
        typescript: {all: [/X-Tenant-Id/, /code\(\s*401\s*\)/, /OUT_OF_COVERAGE/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/, /OUT_OF_COVERAGE/, /StatusForbidden/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/, /OUT_OF_COVERAGE/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/, /OUT_OF_COVERAGE/, /\b403\b/]},
      },
    },
    {
      id: 'solver',
      title: 'Hands the solver validated points, never raw request fields',
      detail:
        'The engine is called with the checked locals — `solver.plan(origin, destination, waypoints)` — so no raw body field can reach it; `solver.plan(body…)` is the draft slipping input past the guards.',
      match: {
        python: {all: [/solver\.plan\(/], none: [/solver\.plan\(\s*body\./]},
        typescript: {all: [/solver\.plan\(/], none: [/solver\.plan\(\s*body\./]},
        go: {all: [/solver\.Plan\(/], none: [/solver\.Plan\(\s*body\./]},
        scala: {all: [/solver\.plan\(/], none: [/solver\.plan\(\s*body\./]},
        cpp: {all: [/solver\.plan\(/], none: [/solver\.plan\(\s*body/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class Point(BaseModel):
    lat: float
    lng: float


class RouteRequest(BaseModel):
    origin: Point
    destination: Point
    waypoints: list[Point] = []


class Solver:
    def plan(self, origin: Point, destination: Point, waypoints: list[Point]) -> dict:
        """Ask the routing engine for geometry and distance."""
        raise NotImplementedError


solver = Solver()


@app.post("/v1/routes")
def create_route(body: RouteRequest) -> JSONResponse:
    # TODO: this draft hands coordinates to the engine unchecked, lets a 5000-waypoint list reach
    # the solver, and treats the tenant's map coverage as global. Review all three.
    plan = solver.plan(body.origin, body.destination, body.waypoints)
    return JSONResponse(
        {"route_id": str(uuid.uuid4()), "distance_m": plan["distance_m"], "geometry": plan["geometry"]},
        status_code=201,
    )
`,
      solution: `import math
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_LAT = 90.0
MAX_LNG = 180.0
MAX_WAYPOINTS = 25


class Point(BaseModel):
    lat: float
    lng: float


class RouteRequest(BaseModel):
    origin: Point
    destination: Point
    waypoints: list[Point] = []


class Solver:
    def plan(self, origin: Point, destination: Point, waypoints: list[Point]) -> dict:
        """Ask the routing engine for geometry and distance."""
        raise NotImplementedError


class CoverageStore:
    def covers(self, tenant: str, points: list[Point]) -> bool:
        """Whether every point falls inside the tenant's map coverage."""
        raise NotImplementedError


solver = Solver()
coverage = CoverageStore()


def checked_point(point: Point) -> Point:
    if not (math.isfinite(point.lat) and math.isfinite(point.lng)):
        raise HTTPException(status_code=422, detail="coordinates must be finite")
    if abs(point.lat) > MAX_LAT or abs(point.lng) > MAX_LNG:
        raise HTTPException(status_code=422, detail="coordinates out of range")
    return point


@app.post("/v1/routes")
def create_route(
    body: RouteRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if len(body.waypoints) > MAX_WAYPOINTS:
        raise HTTPException(status_code=422, detail="at most 25 waypoints")
    origin = checked_point(body.origin)
    destination = checked_point(body.destination)
    waypoints = [checked_point(point) for point in body.waypoints]
    if not coverage.covers(tenant, [origin, destination]):
        raise HTTPException(status_code=403, detail="OUT_OF_COVERAGE")
    plan = solver.plan(origin, destination, waypoints)
    return JSONResponse(
        {"route_id": str(uuid.uuid4()), "distance_m": plan["distance_m"], "geometry": plan["geometry"]},
        status_code=201,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/routes: a model-generated draft of the routing endpoint. */
import Fastify from 'fastify';

export const app = Fastify();

interface Point {
  lat: number;
  lng: number;
}

interface RouteBody {
  origin: Point;
  destination: Point;
  waypoints?: Point[];
}

const solver = {
  plan(origin: Point, destination: Point, waypoints: Point[]): {distance_m: number; geometry: string} {
    throw new Error('routing engine not wired yet');
  },
};

app.post('/v1/routes', async (request, reply) => {
  // TODO: this draft hands coordinates to the engine unchecked, lets a 5000-waypoint list reach
  // the solver, and treats the tenant's map coverage as global. Review all three.
  const body = request.body as RouteBody;
  const plan = solver.plan(body.origin, body.destination, body.waypoints ?? []);
  return reply.code(201).send({route_id: 'draft-route', distance_m: plan.distance_m, geometry: plan.geometry});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/routes: coordinates validated before the routing engine sees them. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_LAT = 90;
const MAX_LNG = 180;
const MAX_WAYPOINTS = 25;

interface Point {
  lat: number;
  lng: number;
}

interface RouteBody {
  origin: Point;
  destination: Point;
  waypoints?: Point[];
}

const solver = {
  plan(origin: Point, destination: Point, waypoints: Point[]): {distance_m: number; geometry: string} {
    throw new Error('routing engine not wired yet');
  },
};

const coverage = {
  covers(tenant: string, points: Point[]): boolean {
    throw new Error('coverage store not wired yet');
  },
};

function checkedPoint(raw: unknown): Point | null {
  if (raw === null || typeof raw !== 'object') return null;
  const {lat, lng} = raw as Partial<Point>;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > MAX_LAT || Math.abs(lng) > MAX_LNG) return null;
  return {lat, lng};
}

app.post('/v1/routes', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as Partial<RouteBody> | null;
  if (body === null || typeof body !== 'object')
    return reply.code(422).send({error: 'origin and destination are required'});
  const origin = checkedPoint(body.origin);
  const destination = checkedPoint(body.destination);
  if (origin === null || destination === null)
    return reply.code(422).send({error: 'coordinates must be finite and in range'});
  const listed = body.waypoints ?? [];
  if (!Array.isArray(listed)) return reply.code(422).send({error: 'waypoints must be a list'});
  if (listed.length > MAX_WAYPOINTS) return reply.code(422).send({error: 'at most 25 waypoints'});
  const waypoints: Point[] = [];
  for (const raw of listed) {
    const point = checkedPoint(raw);
    if (point === null) return reply.code(422).send({error: 'coordinates must be finite and in range'});
    waypoints.push(point);
  }
  if (!coverage.covers(tenant, [origin, destination])) return reply.code(403).send({error: 'OUT_OF_COVERAGE'});
  const plan = solver.plan(origin, destination, waypoints);
  return reply.code(201).send({route_id: randomUUID(), distance_m: plan.distance_m, geometry: plan.geometry});
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

type Point struct {
	Lat float64 \`json:"lat"\`
	Lng float64 \`json:"lng"\`
}

type RouteRequest struct {
	Origin      Point   \`json:"origin"\`
	Destination Point   \`json:"destination"\`
	Waypoints   []Point \`json:"waypoints"\`
}

type Solver struct{}

func (s *Solver) Plan(origin, destination Point, waypoints []Point) (map[string]any, error) {
	return nil, nil
}

var solver = &Solver{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createRoute(rw http.ResponseWriter, r *http.Request) {
	var body RouteRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft hands coordinates to the engine unchecked, lets a 5000-waypoint list reach
	// the solver, and treats the tenant's map coverage as global. Review all three.
	plan, err := solver.Plan(body.Origin, body.Destination, body.Waypoints)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "ENGINE_UNAVAILABLE"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{
		"route_id":   "draft-route",
		"distance_m": plan["distance_m"],
		"geometry":   plan["geometry"],
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/routes", createRoute)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
)

const (
	maxLat       = 90.0
	maxLng       = 180.0
	maxWaypoints = 25
)

type Point struct {
	Lat float64 \`json:"lat"\`
	Lng float64 \`json:"lng"\`
}

type RouteRequest struct {
	Origin      Point   \`json:"origin"\`
	Destination Point   \`json:"destination"\`
	Waypoints   []Point \`json:"waypoints"\`
}

type Solver struct{}

func (s *Solver) Plan(origin, destination Point, waypoints []Point) (map[string]any, error) {
	return nil, nil
}

type CoverageStore struct{}

func (c *CoverageStore) Covers(tenant string, points []Point) bool {
	return false
}

var solver = &Solver{}
var coverage = &CoverageStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func checkedPoint(point Point) (Point, bool) {
	if math.IsNaN(point.Lat) || math.IsNaN(point.Lng) || math.IsInf(point.Lat, 0) || math.IsInf(point.Lng, 0) {
		return Point{}, false
	}
	if math.Abs(point.Lat) > maxLat || math.Abs(point.Lng) > maxLng {
		return Point{}, false
	}
	return point, true
}

func createRoute(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body RouteRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Waypoints) > maxWaypoints {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "at most 25 waypoints"})
		return
	}
	origin, ok := checkedPoint(body.Origin)
	if !ok {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "coordinates must be finite and in range"})
		return
	}
	destination, ok := checkedPoint(body.Destination)
	if !ok {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "coordinates must be finite and in range"})
		return
	}
	waypoints := make([]Point, 0, len(body.Waypoints))
	for _, raw := range body.Waypoints {
		point, ok := checkedPoint(raw)
		if !ok {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "coordinates must be finite and in range"})
			return
		}
		waypoints = append(waypoints, point)
	}
	if !coverage.Covers(tenant, append([]Point{origin, destination}, waypoints...)) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "OUT_OF_COVERAGE"})
		return
	}
	plan, err := solver.Plan(origin, destination, waypoints)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "ENGINE_UNAVAILABLE"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{
		"route_id":   "route-1",
		"distance_m": plan["distance_m"],
		"geometry":   plan["geometry"],
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/routes", createRoute)
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

final case class Point(lat: Double, lng: Double)
final case class RouteRequest(origin: Point, destination: Point, waypoints: List[Point])
final case class Plan(distance_m: Double, geometry: String)
final case class RouteResult(route_id: String, distance_m: Double, geometry: String)

class Solver {
  def plan(origin: Point, destination: Point, waypoints: List[Point]): Plan =
    throw new NotImplementedError("routing engine not wired")
}

object Solver {
  def open(): Solver = new Solver()
}

object RouteApi {
  implicit val system: ActorSystem = ActorSystem("maps-api")
  implicit val pointFormat: RootJsonFormat[Point] = jsonFormat2(Point)
  implicit val requestFormat: RootJsonFormat[RouteRequest] = jsonFormat3(RouteRequest)
  implicit val planFormat: RootJsonFormat[Plan] = jsonFormat2(Plan)
  implicit val resultFormat: RootJsonFormat[RouteResult] = jsonFormat3(RouteResult)

  val solver = Solver.open()

  val route: Route =
    path("v1" / "routes") {
      post {
        entity(as[RouteRequest]) { body =>
          // TODO: this draft hands coordinates to the engine unchecked, lets a 5000-waypoint list
          // reach the solver, and treats the tenant's map coverage as global. Review all three.
          val plan = solver.plan(body.origin, body.destination, body.waypoints)
          complete(StatusCodes.Created, RouteResult("draft-route", plan.distance_m, plan.geometry))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Point(lat: Double, lng: Double)
final case class RouteRequest(origin: Point, destination: Point, waypoints: List[Point])
final case class Plan(distance_m: Double, geometry: String)
final case class RouteResult(route_id: String, distance_m: Double, geometry: String)

class Solver {
  def plan(origin: Point, destination: Point, waypoints: List[Point]): Plan =
    throw new NotImplementedError("routing engine not wired")
}

object Solver {
  def open(): Solver = new Solver()
}

class CoverageStore {
  def covers(tenant: String, points: List[Point]): Boolean =
    throw new NotImplementedError("coverage store not wired")
}

object CoverageStore {
  def open(): CoverageStore = new CoverageStore()
}

object RouteApi {
  implicit val system: ActorSystem = ActorSystem("maps-api")
  implicit val pointFormat: RootJsonFormat[Point] = jsonFormat2(Point)
  implicit val requestFormat: RootJsonFormat[RouteRequest] = jsonFormat3(RouteRequest)
  implicit val planFormat: RootJsonFormat[Plan] = jsonFormat2(Plan)
  implicit val resultFormat: RootJsonFormat[RouteResult] = jsonFormat3(RouteResult)

  val MaxLat = 90.0
  val MaxLng = 180.0
  val MaxWaypoints = 25

  val solver = Solver.open()
  val coverage = CoverageStore.open()

  def checkedPoint(point: Point): Either[String, Point] =
    if (point.lat.isNaN || point.lat.isInfinite || point.lng.isNaN || point.lng.isInfinite)
      Left("coordinates must be finite")
    else if (math.abs(point.lat) > MaxLat || math.abs(point.lng) > MaxLng)
      Left("coordinates out of range")
    else Right(point)

  val route: Route =
    path("v1" / "routes") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[RouteRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (body.waypoints.length > MaxWaypoints) {
              complete(StatusCodes.UnprocessableEntity, """{"error":"at most 25 waypoints"}""")
            } else {
              val checked = for {
                origin <- checkedPoint(body.origin)
                destination <- checkedPoint(body.destination)
                waypoints <- body.waypoints.foldLeft[Either[String, List[Point]]](Right(Nil)) { (acc, point) =>
                  for {
                    soFar <- acc
                    next <- checkedPoint(point)
                  } yield soFar :+ next
                }
              } yield (origin, destination, waypoints)

              checked match {
                case Left(reason) =>
                  complete(StatusCodes.UnprocessableEntity, s"""{"error":"$reason"}""")
                case Right((origin, destination, waypoints)) =>
                  if (!coverage.covers(tenantOpt.get, origin :: destination :: waypoints)) {
                    complete(StatusCodes.Forbidden, """{"error":"OUT_OF_COVERAGE"}""")
                  } else {
                    val plan = solver.plan(origin, destination, waypoints)
                    complete(
                      StatusCodes.Created,
                      RouteResult(UUID.randomUUID().toString, plan.distance_m, plan.geometry),
                    )
                  }
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

using json = nlohmann::json;

struct Solver {
  json plan(const json& origin, const json& destination, const json& waypoints);
};

Solver solver;

int main() {
  httplib::Server svr;

  svr.Post("/v1/routes", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft hands coordinates to the engine unchecked, lets a 5000-waypoint list reach
    // the solver, and treats the tenant's map coverage as global. Review all three.
    const auto plan = solver.plan(body["origin"], body["destination"], body.value("waypoints", json::array()));
    res.status = 201;
    res.set_content(
        json{{"route_id", "draft-route"}, {"distance_m", plan["distance_m"]}, {"geometry", plan["geometry"]}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr double kMaxLat = 90.0;
constexpr double kMaxLng = 180.0;
constexpr std::size_t kMaxWaypoints = 25;

struct Solver {
  json plan(const json& origin, const json& destination, const json& waypoints);
};

struct CoverageStore {
  bool covers(const std::string& tenant, const json& points);
};

Solver solver;
CoverageStore coverage;
std::string uuidString();

std::optional<json> checkedPoint(const json& raw) {
  if (!raw.is_object() || !raw.contains("lat") || !raw.contains("lng")) return std::nullopt;
  if (!raw["lat"].is_number() || !raw["lng"].is_number()) return std::nullopt;
  const double lat = raw["lat"].get<double>();
  const double lng = raw["lng"].get<double>();
  if (!std::isfinite(lat) || !std::isfinite(lng)) return std::nullopt;
  if (std::abs(lat) > kMaxLat || std::abs(lng) > kMaxLng) return std::nullopt;
  return json{{"lat", lat}, {"lng", lng}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/routes", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const json listed = body.value("waypoints", json::array());
    if (!listed.is_array() || listed.size() > kMaxWaypoints) {
      res.status = 422;
      res.set_content(R"({"error":"at most 25 waypoints"})", "application/json");
      return;
    }
    const auto origin = checkedPoint(body.value("origin", json()));
    const auto destination = checkedPoint(body.value("destination", json()));
    json waypoints = json::array();
    for (const auto& raw : listed) {
      const auto point = checkedPoint(raw);
      if (!point) {
        res.status = 422;
        res.set_content(R"({"error":"coordinates must be finite and in range"})", "application/json");
        return;
      }
      waypoints.push_back(*point);
    }
    if (!origin || !destination) {
      res.status = 422;
      res.set_content(R"({"error":"coordinates must be finite and in range"})", "application/json");
      return;
    }
    if (!coverage.covers(tenant, json::array({*origin, *destination}))) {
      res.status = 403;
      res.set_content(R"({"error":"OUT_OF_COVERAGE"})", "application/json");
      return;
    }
    const auto plan = solver.plan(*origin, *destination, waypoints);
    res.status = 201;
    res.set_content(
        json{{"route_id", uuidString()}, {"distance_m", plan["distance_m"]}, {"geometry", plan["geometry"]}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate in cost order and return early: tenant (**401**), the waypoint cap, coordinate validity, then coverage (**403**) — every guard returns before `solver.plan(…)` is reached. The engine solve is the expensive resource; nothing may buy it before the request has earned it.',
    'A coordinate is two separate checks: it must be finite (`math.isfinite`, `Number.isFinite`, `math.IsNaN`/`math.IsInf`, `isNaN`/`isInfinite`, `std::isfinite`) and in range (`abs(lat) > 90`, `abs(lng) > 180`). Both answer **422** — a point the engine cannot place is not something the engine should discover.',
    'Coverage is a per-tenant fact: look it up with the header tenant (`coverage.covers(tenant, …)`) and answer **403** with an `OUT_OF_COVERAGE` error for an uncovered pair. If you find yourself estimating a straight line for just this once, the endpoint has stopped being a router and become a guesser.',
  ],
  debrief: `The interviewer is testing whether you can review a geo endpoint at the trust boundary. The draft reads fine because the demo always sends two well-formed points from one tenant and never asks for 5000 stops. Three separate defects are being checked: coordinates that are not numbers the planet has (\`NaN\` is a valid float in every language here, and a missing point decodes to \`(0, 0)\` — Null Island — in a typed decoder), a waypoint list that is a denial-of-service against the solver's super-linear solve time, and coverage that is a per-tenant fact the draft replaced with an assumption. The order of the guards is the interview answer: cheap and decisive first (auth, shape, cap), expensive last (coverage, solver). Real routing APIs add geohash or H3 cell validation, coverage polygons with a border tolerance, snapping to the nearest graph node, per-tenant quotas, and a \`route_id\` that the later steps use to read the stored route back.
`,
};
