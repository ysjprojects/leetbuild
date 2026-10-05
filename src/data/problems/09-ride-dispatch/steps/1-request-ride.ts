import type {Step} from '@/lib/types';

// ---- 1. POST /rides with validation and an idempotency key ------------------------------------
export const requestRideStep: Step = {
  id: 'request-ride',
  title: 'Request a ride: validate, dedupe, accept',
  concept: 'http',
  file: 'ride_api',
  focus: ['rider', 'api', 'redis'],
  task: `## Task

Implement the two endpoints of the ride API. \`start_matching(ride)\` is provided (it records the ride
and hands it to the dispatcher you build in the next steps); \`rides.get(ride_id)\` is provided and
returns the stored ride, or nothing.

- \`POST /rides\` takes \`{rider_id, pickup: {lat, lng}, dropoff: {lat, lng}}\`. A latitude outside
  **[-90, 90]** or a longitude outside **[-180, 180]** is a **400**.
- The request must carry an \`Idempotency-Key\` header (**400** without one). The rider app retries on a
  flaky connection; a retry must not create a second ride.
- Dedupe with \`SET idem:{key} <ride_id> NX EX 3600\`. When the SET is refused the ride already exists:
  answer **200** with the stored ride id. Otherwise call \`start_matching\` and answer **202**
  \`{ride_id, status: "matching"}\` — accepted, not yet matched.
- \`GET /rides/{id}\` answers **404** for an unknown id, else \`{status, driver_id?}\`.

:::widget idempotency {}

> The key is written *before* the ride exists, with a TTL: a crash between the SET and \`start_matching\`
> leaves a key that points at a ride nobody recorded, and the TTL is what eventually heals it. Cheap
> validation goes first so a bad request never touches Redis.

:::widget status-codes {}`,
  sequence: {
    participants: ['Rider app', 'ride-api', 'Redis', 'dispatcher'],
    messages: [
      {from: 'Rider app', to: 'ride-api', label: 'POST /rides · Idempotency-Key: k1', kind: 'sync'},
      {from: 'ride-api', to: 'Redis', label: 'SET idem:k1 r-42 NX EX 3600', kind: 'sync'},
      {from: 'Redis', to: 'ride-api', label: 'OK', kind: 'reply'},
      {from: 'ride-api', to: 'dispatcher', label: 'start_matching(r-42)', kind: 'async'},
      {from: 'ride-api', to: 'Rider app', label: '202 {ride_id: r-42, status: matching}', kind: 'reply'},
      {from: 'Rider app', to: 'ride-api', label: 'POST /rides · Idempotency-Key: k1 (retry)', kind: 'sync'},
      {from: 'ride-api', to: 'Rider app', label: '200 {ride_id: r-42} (replayed)', kind: 'reply'},
    ],
  },
  hints: [
    'Order the branches by cost: coordinate bounds (free), the header (free), the SET NX (one round trip), start_matching (the expensive one). Each failing branch returns immediately.',
    'SET with NX returns a truthy value when it created the key and a null/false when the key already existed — that single return value is your "new ride or replay" decision.',
    'On a replay you still need the ride id you stored: GET the same key (or use SET … NX GET) and answer 200 with it; the client cannot tell the difference from the first answer, which is the point.',
  ],
  checks: [
    {
      id: 'validate',
      title: 'Rejects coordinates outside [-90, 90] × [-180, 180] with 400',
      detail:
        'Check both points against the latitude and longitude bounds before anything else and answer `400 Bad Request`.',
      match: {
        python: {all: [/\b90\b/, /\b180\b/, /status_code\s*=\s*400|HTTP_400/]},
        go: {all: [/\b90\b/, /\b180\b/, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/\b90\b/, /\b180\b/, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/\b90\b/, /\b180\b/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Requires an Idempotency-Key header',
      detail:
        'Read the `Idempotency-Key` request header; a request without one is a `400` — the server cannot dedupe what it cannot identify.',
      match: {
        python: {all: [/idempotency-key/i, /status_code\s*=\s*400|HTTP_400/]},
        go: {all: [/Idempotency-Key/i, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/Idempotency-Key/i, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/Idempotency-Key/i, /status\s*=\s*400/]},
      },
    },
    {
      id: 'dedupe-nx',
      title: 'Claims idem:{key} with SET NX EX 3600',
      detail:
        'One `SET idem:{key} <ride_id> NX EX 3600`: the NX makes the claim atomic, the TTL bounds how long a key is remembered.',
      match: {
        python: {
          all: [
            /["']idem:/,
            /\.set\((?:[^\n]*\bnx\s*=\s*True[^\n]*\bex\s*=\s*(?:IDEM_TTL_S|3600)\b|[^\n]*\bex\s*=\s*(?:IDEM_TTL_S|3600)\b[^\n]*\bnx\s*=\s*True)/,
          ],
        },
        go: {all: [/"idem:/, /rdb\.SetNX\([^\n]*\b(?:idemTTL|time\.Hour)\b|rdb\.SetArgs\([\s\S]{0,200}?Mode:\s*"NX"/]},
        scala: {all: [/"idem:/, /\.nx\(\)/, /\.ex\(\s*(?:IdemTtlSeconds|3600L?)\s*\)/]},
        cpp: {all: [/"idem:/, /redis\.set\([^;]*?\bkIdemTtl\b[^;]*?UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'replay-or-accept',
      title: 'Replays the stored ride with 200, accepts a new one with 202',
      detail:
        'A refused SET means a replay: read the stored ride id back and answer `200`. A new ride is `202 {ride_id, status: "matching"}` — accepted, the match comes later.',
      match: {
        python: {all: [/\br\.get\(/, /status_code\s*=\s*202|HTTP_202/, /"matching"/]},
        go: {all: [/rdb\.Get\(/, /http\.StatusAccepted|\b202\b/, /"matching"/]},
        scala: {all: [/jedis\.get\(/, /StatusCodes\.Accepted|\b202\b/, /"matching"/]},
        cpp: {all: [/redis\.get\(/, /status\s*=\s*202/, /"matching"/]},
      },
    },
    {
      id: 'not-found',
      title: 'GET /rides/{id} answers 404 for an unknown ride',
      detail:
        'When the ride store has no such id, respond `404 Not Found`; otherwise return the status and, once matched, the driver id.',
      match: {
        python: {all: [/status_code\s*=\s*404|HTTP_404/]},
        go: {all: [/http\.StatusNotFound|\b404\b/]},
        scala: {all: [/StatusCodes\.NotFound|\b404\b/]},
        cpp: {all: [/status\s*=\s*404/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from dispatch import rides, start_matching  # provided: rides.get(ride_id) -> dict | None; start_matching(ride) records it and finds a driver

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

IDEM_TTL_S = 3600


class Point(BaseModel):
    lat: float
    lng: float


class RideRequest(BaseModel):
    rider_id: str
    pickup: Point
    dropoff: Point


@app.post("/rides")
def request_ride(body: RideRequest, request: Request) -> JSONResponse:
    # TODO: 400 when a lat is outside [-90, 90] or a lng outside [-180, 180]
    # TODO: 400 when the Idempotency-Key header is missing
    # TODO: SET idem:{key} <ride_id> NX EX IDEM_TTL_S; refused → 200 with the stored ride_id
    # TODO: new ride → start_matching(ride), 202 {ride_id, status: "matching"}
    return JSONResponse(status_code=501, content={"error": "not implemented"})


@app.get("/rides/{ride_id}")
def get_ride(ride_id: str) -> JSONResponse:
    # TODO: 404 when rides.get returns None, else {status, driver_id?}
    return JSONResponse(status_code=501, content={"error": "not implemented"})


# uvicorn ride_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import uuid

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from dispatch import rides, start_matching  # provided: rides.get(ride_id) -> dict | None; start_matching(ride) records it and finds a driver

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

IDEM_TTL_S = 3600


class Point(BaseModel):
    lat: float
    lng: float


class RideRequest(BaseModel):
    rider_id: str
    pickup: Point
    dropoff: Point


def valid(p: Point) -> bool:
    return -90 <= p.lat <= 90 and -180 <= p.lng <= 180


@app.post("/rides")
def request_ride(body: RideRequest, request: Request) -> JSONResponse:
    if not (valid(body.pickup) and valid(body.dropoff)):
        return JSONResponse(status_code=400, content={"error": "lat must be in [-90, 90], lng in [-180, 180]"})
    key = request.headers.get("idempotency-key")
    if not key:
        return JSONResponse(status_code=400, content={"error": "Idempotency-Key header is required"})
    ride_id = uuid.uuid4().hex
    if not r.set(f"idem:{key}", ride_id, nx=True, ex=IDEM_TTL_S):
        return JSONResponse(status_code=200, content={"ride_id": r.get(f"idem:{key}"), "status": "matching"})
    ride = {
        "ride_id": ride_id,
        "rider_id": body.rider_id,
        "pickup": body.pickup.model_dump(),
        "dropoff": body.dropoff.model_dump(),
        "status": "matching",
    }
    start_matching(ride)
    return JSONResponse(status_code=202, content={"ride_id": ride_id, "status": "matching"})


@app.get("/rides/{ride_id}")
def get_ride(ride_id: str) -> JSONResponse:
    ride = rides.get(ride_id)
    if ride is None:
        return JSONResponse(status_code=404, content={"error": "no such ride"})
    out = {"status": ride["status"]}
    if ride.get("driver_id"):
        out["driver_id"] = ride["driver_id"]
    return JSONResponse(status_code=200, content=out)


# uvicorn ride_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const idemTTL = time.Hour

type Point struct {
	Lat float64 \`json:"lat"\`
	Lng float64 \`json:"lng"\`
}

type RideRequest struct {
	RiderID string \`json:"rider_id"\`
	Pickup  Point  \`json:"pickup"\`
	Dropoff Point  \`json:"dropoff"\`
}

type Ride struct {
	ID       string \`json:"ride_id"\`
	RiderID  string \`json:"rider_id"\`
	Pickup   Point  \`json:"pickup"\`
	Dropoff  Point  \`json:"dropoff"\`
	Status   string \`json:"status"\`
	DriverID string \`json:"driver_id,omitempty"\`
}

// Provided (dispatch.go): startMatching records the ride and looks for a driver; getRide is nil for unknown ids.
func startMatching(ride *Ride) { panic("not implemented") }
func getRide(id string) *Ride  { panic("not implemented") }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func requestRide(w http.ResponseWriter, r *http.Request) {
	var body RideRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	// TODO: 400 when a lat is outside [-90, 90] or a lng outside [-180, 180]
	// TODO: 400 when the Idempotency-Key header is missing
	// TODO: SetNX idem:{key} rideID idemTTL; refused → 200 with the stored ride id (Get)
	// TODO: new ride → startMatching(ride), 202 {ride_id, status: "matching"}
	_ = uuid.NewString
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func getRideStatus(w http.ResponseWriter, r *http.Request) {
	// TODO: 404 when getRide returns nil, else {status, driver_id?}
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rides", requestRide)
	mux.HandleFunc("GET /rides/{id}", getRideStatus)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const idemTTL = time.Hour

type Point struct {
	Lat float64 \`json:"lat"\`
	Lng float64 \`json:"lng"\`
}

type RideRequest struct {
	RiderID string \`json:"rider_id"\`
	Pickup  Point  \`json:"pickup"\`
	Dropoff Point  \`json:"dropoff"\`
}

type Ride struct {
	ID       string \`json:"ride_id"\`
	RiderID  string \`json:"rider_id"\`
	Pickup   Point  \`json:"pickup"\`
	Dropoff  Point  \`json:"dropoff"\`
	Status   string \`json:"status"\`
	DriverID string \`json:"driver_id,omitempty"\`
}

// Provided (dispatch.go): startMatching records the ride and looks for a driver; getRide is nil for unknown ids.
func startMatching(ride *Ride) { panic("not implemented") }
func getRide(id string) *Ride  { panic("not implemented") }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func valid(p Point) bool {
	return p.Lat >= -90 && p.Lat <= 90 && p.Lng >= -180 && p.Lng <= 180
}

func requestRide(w http.ResponseWriter, r *http.Request) {
	var body RideRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if !valid(body.Pickup) || !valid(body.Dropoff) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lat must be in [-90, 90], lng in [-180, 180]"})
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key header is required"})
		return
	}
	ctx := r.Context()
	rideID := uuid.NewString()
	won, err := rdb.SetNX(ctx, "idem:"+key, rideID, idemTTL).Result()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "idempotency store unavailable"})
		return
	}
	if !won {
		existing, _ := rdb.Get(ctx, "idem:"+key).Result()
		writeJSON(w, http.StatusOK, map[string]string{"ride_id": existing, "status": "matching"})
		return
	}
	ride := &Ride{ID: rideID, RiderID: body.RiderID, Pickup: body.Pickup, Dropoff: body.Dropoff, Status: "matching"}
	startMatching(ride)
	writeJSON(w, http.StatusAccepted, map[string]string{"ride_id": rideID, "status": "matching"})
}

func getRideStatus(w http.ResponseWriter, r *http.Request) {
	ride := getRide(r.PathValue("id"))
	if ride == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such ride"})
		return
	}
	out := map[string]string{"status": ride.Status}
	if ride.DriverID != "" {
		out["driver_id"] = ride.DriverID
	}
	writeJSON(w, http.StatusOK, out)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rides", requestRide)
	mux.HandleFunc("GET /rides/{id}", getRideStatus)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import dispatch.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided

final case class Point(lat: Double, lng: Double)
final case class RideRequest(rider_id: String, pickup: Point, dropoff: Point)
final case class Ride(rideId: String, riderId: String, pickup: Point, dropoff: Point, status: String, driverId: Option[String] = None)

object RideApi {
  val jedis = new JedisPooled("redis", 6379)
  val IdemTtlSeconds = 3600L

  implicit val pointFormat: RootJsonFormat[Point] = jsonFormat2(Point)
  implicit val rideRequestFormat: RootJsonFormat[RideRequest] = jsonFormat3(RideRequest)

  /** Provided (Dispatcher): records the ride and starts looking for a driver. */
  def startMatching(ride: Ride): Unit = ???
  /** Provided (RideStore): None for an unknown id. */
  def getRide(rideId: String): Option[Ride] = ???

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    pathPrefix("rides") {
      (pathEnd & post) {
        entity(as[RideRequest]) { req =>
          optionalHeaderValueByName("Idempotency-Key") { idemKey =>
            // TODO: 400 when a lat is outside [-90, 90] or a lng outside [-180, 180]
            // TODO: 400 when idemKey is None
            // TODO: SET idem:{key} <rideId> NX EX IdemTtlSeconds; refused → 200 with the stored ride id (get)
            // TODO: new ride → startMatching(ride), 202 {ride_id, status: "matching"}
            json(StatusCodes.NotImplemented, """{"error":"not implemented"}""")
          }
        }
      } ~
      (path(Segment) & get) { rideId =>
        // TODO: 404 when getRide is None, else {status, driver_id?}
        json(StatusCodes.NotImplemented, """{"error":"not implemented"}""")
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("ride-api")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import dispatch.Tls // Tls.serverContext(certPem, keyPem): SSLContext — provided

final case class Point(lat: Double, lng: Double)
final case class RideRequest(rider_id: String, pickup: Point, dropoff: Point)
final case class Ride(rideId: String, riderId: String, pickup: Point, dropoff: Point, status: String, driverId: Option[String] = None)

object RideApi {
  val jedis = new JedisPooled("redis", 6379)
  val IdemTtlSeconds = 3600L

  implicit val pointFormat: RootJsonFormat[Point] = jsonFormat2(Point)
  implicit val rideRequestFormat: RootJsonFormat[RideRequest] = jsonFormat3(RideRequest)

  /** Provided (Dispatcher): records the ride and starts looking for a driver. */
  def startMatching(ride: Ride): Unit = ???
  /** Provided (RideStore): None for an unknown id. */
  def getRide(rideId: String): Option[Ride] = ???

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  private def valid(p: Point): Boolean = p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180

  val route: Route =
    pathPrefix("rides") {
      (pathEnd & post) {
        entity(as[RideRequest]) { req =>
          optionalHeaderValueByName("Idempotency-Key") {
            case _ if !valid(req.pickup) || !valid(req.dropoff) =>
              json(StatusCodes.BadRequest, """{"error":"lat must be in [-90, 90], lng in [-180, 180]"}""")
            case None => json(StatusCodes.BadRequest, """{"error":"Idempotency-Key header is required"}""")
            case Some(idemKey) =>
              val key = s"idem:$idemKey"
              val rideId = UUID.randomUUID().toString
              val won = jedis.set(key, rideId, SetParams.setParams().nx().ex(IdemTtlSeconds)) != null
              if (!won) json(StatusCodes.OK, s"""{"ride_id":"\${jedis.get(key)}","status":"matching"}""")
              else {
                startMatching(Ride(rideId, req.rider_id, req.pickup, req.dropoff, "matching"))
                json(StatusCodes.Accepted, s"""{"ride_id":"$rideId","status":"matching"}""")
              }
          }
        }
      } ~
      (path(Segment) & get) { rideId =>
        getRide(rideId) match {
          case None => json(StatusCodes.NotFound, """{"error":"no such ride"}""")
          case Some(ride) =>
            val driver = ride.driverId.map(d => s""","driver_id":"$d"""").getOrElse("")
            json(StatusCodes.OK, s"""{"status":"\${ride.status}"$driver}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("ride-api")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "dispatch.h"  // Ride, Point; void start_matching(const Ride&); std::optional<Ride> get_ride(const std::string&); std::string new_ride_id()

using json = nlohmann::json;

constexpr std::chrono::seconds kIdemTtl{3600};

sw::redis::Redis redis("tcp://redis:6379");

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/rides", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const json pickup = body.value("pickup", json::object()), dropoff = body.value("dropoff", json::object());
    // TODO: 400 when a lat is outside [-90, 90] or a lng outside [-180, 180]
    // TODO: 400 when the Idempotency-Key header is missing (req.has_header)
    // TODO: SET idem:{key} <ride_id> NX EX kIdemTtl; refused → 200 with the stored ride id (get)
    // TODO: new ride → start_matching(ride), 202 {ride_id, status: "matching"}
    res.status = 501;
  });

  svr.Get(R"(/rides/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ride_id = req.matches[1];
    // TODO: 404 when get_ride is nullopt, else {status, driver_id?}
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "dispatch.h"  // Ride, Point; void start_matching(const Ride&); std::optional<Ride> get_ride(const std::string&); std::string new_ride_id()

using json = nlohmann::json;

constexpr std::chrono::seconds kIdemTtl{3600};

sw::redis::Redis redis("tcp://redis:6379");

bool valid(const json& p) {
  const double lat = p.value("lat", 999.0), lng = p.value("lng", 999.0);
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/rides", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const json pickup = body.value("pickup", json::object()), dropoff = body.value("dropoff", json::object());
    if (!valid(pickup) || !valid(dropoff)) {
      res.status = 400;
      res.set_content(R"({"error":"lat must be in [-90, 90], lng in [-180, 180]"})", "application/json");
      return;
    }
    if (!req.has_header("Idempotency-Key")) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key header is required"})", "application/json");
      return;
    }
    const std::string key = "idem:" + req.get_header_value("Idempotency-Key");
    const std::string ride_id = new_ride_id();
    if (!redis.set(key, ride_id, kIdemTtl, sw::redis::UpdateType::NOT_EXIST)) {
      const auto existing = redis.get(key);
      res.status = 200;
      res.set_content(json{{"ride_id", existing.value_or("")}, {"status", "matching"}}.dump(), "application/json");
      return;
    }
    const Ride ride{ride_id, body.value("rider_id", ""), Point{pickup["lat"].get<double>(), pickup["lng"].get<double>()},
                    Point{dropoff["lat"].get<double>(), dropoff["lng"].get<double>()}, "matching", ""};
    start_matching(ride);
    res.status = 202;
    res.set_content(json{{"ride_id", ride_id}, {"status", "matching"}}.dump(), "application/json");
  });

  svr.Get(R"(/rides/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string ride_id = req.matches[1];
    const auto ride = get_ride(ride_id);
    if (!ride) {
      res.status = 404;
      res.set_content(R"({"error":"no such ride"})", "application/json");
      return;
    }
    json out{{"status", ride->status}};
    if (!ride->driver_id.empty()) out["driver_id"] = ride->driver_id;
    res.status = 200;
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `Validation, then the idempotency claim, then the expensive work: the handler never pays for a request it will refuse, and a retry is answered from the key instead of creating a second ride. The \`202\` is honest — the ride is accepted, not matched — and the client learns the rest from \`GET /rides/{id}\`. Real APIs store the whole first response under the key (so a replay is byte-identical), answer \`409\` while the first request is still in flight, and scope keys per rider so two users cannot collide on the same string.`,
};
