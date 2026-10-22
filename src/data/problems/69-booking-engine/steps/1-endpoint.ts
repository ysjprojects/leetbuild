import type {Step} from '@/lib/types';

export const bookingEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/bookings: a range that must be real and future',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and takes a hold. It compiles, it serves the demo, and it hides three production flaws.
Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/bookings\` with body \`{"resource_id": "…", "start": "…", "end": "…"}\` — ISO-8601
instants — and the following rules, evaluated in this order:

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing).
- A range whose \`end\` is **not strictly after** its \`start\` — inverted or zero-length — is **400**
  with \`{"error": "invalid_range"}\`. That is a shape error: what arrived is not a range.
- A \`start\` before the current instant is **422** with \`{"error": "range_in_past"}\`. The shape is
  fine, the calendar is not — a hold in the past can never be honoured.
- An \`end\` past the tenant's horizon — **90 days** from now — is **422** with
  \`{"error": "beyond_horizon"}\`.
- The booking is idempotent on \`(tenant, resource, range)\`: build the key from those three parts
  (for instance \`book:{tenant}:{resource_id}:{start}:{end}\`) and look it up **before** taking a
  hold. A replay returns the first booking — the same \`booking_id\` — with **200**, never a second
  hold with **201**.
- Only a booking that passed every rule takes a hold; the handler is the only place that decides,
  and the hold itself is atomic in the next step.
- Log the booking id, the tenant and the resource — never the range owner's details.

**Failure mode the checks target.** The draft takes a hold for whatever body it is handed: a past
range, an inverted range, a range two years out. Worse, it keys nothing, so a client that retries
after a timeout — the exact case an \`Idempotency-Key\` exists for — books the slot twice.`,
  sequence: {
    participants: ['Client', 'Booking API', 'Booking store'],
    messages: [
      {from: 'Client', to: 'Booking API', label: 'POST /v1/bookings · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Booking API', to: 'Booking API', label: 'reject invalid · past · beyond horizon', kind: 'sync'},
      {from: 'Booking API', to: 'Booking store', label: 'get(book:{tenant}:{resource}:{range})', kind: 'sync'},
      {from: 'Booking store', to: 'Booking API', label: 'stored booking / none', kind: 'reply'},
      {from: 'Booking API', to: 'Booking store', label: 'take hold · put booking', kind: 'async'},
      {from: 'Booking API', to: 'Client', label: '201 first booking · 200 on replay', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/bookings',
      detail: 'Register the booking route on `POST /v1/bookings`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/bookings["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/bookings['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/bookings"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"bookings"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/bookings"/]},
      },
    },
    {
      id: 'range-order',
      title: 'Rejects an inverted or zero-length range with 400',
      detail:
        'A range whose `end` is not strictly after its `start` is a shape error — **400** with `invalid_range`. The draft takes a hold for `end < start` and for `end == start`.',
      match: {
        python: {all: [/invalid_range/, /status_code\s*=\s*400/]},
        typescript: {all: [/invalid_range/, /code\(\s*400\s*\)/]},
        go: {all: [/invalid_range/, /StatusBadRequest/]},
        scala: {all: [/invalid_range/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/invalid_range/, /\b400\b/]},
      },
    },
    {
      id: 'past-start',
      title: 'Rejects a start in the past with 422',
      detail:
        'A `start` before now is **422** with `range_in_past`: the request is well-formed but the calendar cannot honour it. The draft books it.',
      match: {
        python: {all: [/range_in_past/, /status_code\s*=\s*422/]},
        typescript: {all: [/range_in_past/, /code\(\s*422\s*\)/]},
        go: {all: [/range_in_past/, /StatusUnprocessableEntity/]},
        scala: {all: [/range_in_past/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/range_in_past/, /\b422\b/]},
      },
    },
    {
      id: 'horizon',
      title: 'Rejects a range past the 90-day horizon',
      detail:
        'The horizon is `90` days from now, and a range that ends past it is **422** with `beyond_horizon`. The draft accepts any end date.',
      match: {
        python: {all: [/MAX_HORIZON_DAYS/, /beyond_horizon/]},
        typescript: {all: [/MAX_HORIZON_DAYS/, /beyond_horizon/]},
        go: {all: [/maxHorizonDays/, /beyond_horizon/]},
        scala: {all: [/MaxHorizonDays/, /beyond_horizon/]},
        cpp: {all: [/kMaxHorizonDays/, /beyond_horizon/]},
      },
    },
    {
      id: 'replay',
      title: 'Returns the first booking for a replayed (tenant, resource, range)',
      detail:
        'The idempotency key is built from `(tenant, resource, range)` and looked up before any hold, so a retry after a timeout returns the stored booking instead of a second hold. The draft keys nothing.',
      match: {
        python: {all: [/def idempotency_key\(/, /book:/, /store\.get\(/]},
        typescript: {all: [/function idempotencyKey\(/, /book:/, /await store\.get\(/]},
        go: {all: [/func idempotencyKey\(/, /book:/, /store\.Get\(/]},
        scala: {all: [/def idempotencyKey\(/, /book:/, /store\.get\(/]},
        cpp: {all: [/idempotencyKey\(/, /"book:/, /store\.get\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("booking")


class BookingRequest(BaseModel):
    resource_id: str
    start: str
    end: str
    customer_email: str = ""


def take_hold(tenant: str, resource_id: str, start: str, end: str) -> dict:
    """The Redis hold map; a real deployment takes it atomically."""
    raise NotImplementedError


@app.post("/v1/bookings")
def create_booking(body: BookingRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft books whatever range it is handed — past, inverted or beyond the horizon —
    # and it ignores Idempotency-Key, so a client retry after a timeout takes a second hold.
    # Review the range rules and the idempotency lookup.
    hold = take_hold(tenant, body.resource_id, body.start, body.end)
    logger.info("hold=%s tenant=%s email=%s", hold["hold_id"], tenant, body.customer_email)
    return JSONResponse(hold, status_code=201)
`,
      solution: `import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("booking")

MAX_HORIZON_DAYS = 90


class BookingRequest(BaseModel):
    resource_id: str
    start: str
    end: str


class BookingStore:
    def get(self, tenant: str, key: str) -> dict | None:
        """The booking stored under an idempotency key, if any."""
        raise NotImplementedError

    def put(self, tenant: str, key: str, booking: dict) -> None:
        """Store the booking under its idempotency key."""
        raise NotImplementedError


store = BookingStore()


def take_hold(tenant: str, resource_id: str, start: str, end: str) -> dict:
    """The Redis hold map; the atomic take lives in the state step."""
    raise NotImplementedError


def parse_instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def idempotency_key(tenant: str, resource_id: str, start: str, end: str) -> str:
    """One key per (tenant, resource, range): a retry is the same booking, not a second hold."""
    return f"book:{tenant}:{resource_id}:{start}:{end}"


@app.post("/v1/bookings")
def create_booking(
    body: BookingRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    if idem_key is None or idem_key == "":
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)

    start = parse_instant(body.start)
    end = parse_instant(body.end)
    if end <= start:
        return JSONResponse({"error": "invalid_range"}, status_code=400)
    now = datetime.now(timezone.utc)
    if start < now:
        return JSONResponse({"error": "range_in_past"}, status_code=422)
    if end > now + timedelta(days=MAX_HORIZON_DAYS):
        return JSONResponse({"error": "beyond_horizon"}, status_code=422)

    key = idempotency_key(tenant, body.resource_id, body.start, body.end)
    stored = store.get(tenant, key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    hold = take_hold(tenant, body.resource_id, body.start, body.end)
    booking = {
        "booking_id": str(uuid.uuid4()),
        "hold_id": hold["hold_id"],
        "idempotency_key": key,
        "resource_id": body.resource_id,
        "start": body.start,
        "end": body.end,
    }
    store.put(tenant, key, booking)
    logger.info("booking=%s tenant=%s resource=%s", booking["booking_id"], tenant, body.resource_id)
    return JSONResponse(booking, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

export const app = Fastify();

interface BookingBody {
  resource_id: string;
  start: string;
  end: string;
  customer_email?: string;
}

async function takeHold(tenant: string, resourceId: string, start: string, end: string): Promise<{hold_id: string}> {
  throw new Error('not implemented');
}

app.post('/v1/bookings', async (request, reply) => {
  // TODO: this draft books whatever range it is handed — past, inverted or beyond the horizon —
  // and it ignores Idempotency-Key, so a client retry after a timeout takes a second hold.
  // Review the range rules and the idempotency lookup.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as BookingBody;
  const hold = await takeHold(tenant, body.resource_id, body.start, body.end);
  app.log.info({tenant, hold: hold.hold_id, email: body.customer_email}, 'hold taken');
  return reply.code(201).send(hold);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_HORIZON_DAYS = 90;
const HORIZON_MS = MAX_HORIZON_DAYS * 24 * 60 * 60 * 1000;

interface BookingBody {
  resource_id: string;
  start: string;
  end: string;
}

interface Booking {
  booking_id: string;
  hold_id: string;
  idempotency_key: string;
  resource_id: string;
  start: string;
  end: string;
}

interface BookingStore {
  get(tenant: string, key: string): Promise<Booking | null>;
  put(tenant: string, key: string, booking: Booking): Promise<void>;
}

export const store: BookingStore = {
  async get(): Promise<Booking | null> {
    throw new Error('not implemented');
  },
  async put(): Promise<void> {
    throw new Error('not implemented');
  },
};

async function takeHold(tenant: string, resourceId: string, start: string, end: string): Promise<{hold_id: string}> {
  throw new Error('not implemented');
}

function idempotencyKey(tenant: string, resourceId: string, start: string, end: string): string {
  return \`book:\${tenant}:\${resourceId}:\${start}:\${end}\`;
}

app.post('/v1/bookings', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as BookingBody;
  const start = Date.parse(body.start);
  const end = Date.parse(body.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return reply.code(400).send({error: 'invalid_range'});
  if (end <= start) return reply.code(400).send({error: 'invalid_range'});
  const now = Date.now();
  if (start < now) return reply.code(422).send({error: 'range_in_past'});
  if (end > now + HORIZON_MS) return reply.code(422).send({error: 'beyond_horizon'});

  const key = idempotencyKey(tenant, body.resource_id, body.start, body.end);
  const stored = await store.get(tenant, key);
  if (stored !== null) return reply.code(200).send(stored);

  const hold = await takeHold(tenant, body.resource_id, body.start, body.end);
  const booking: Booking = {
    booking_id: randomUUID(),
    hold_id: hold.hold_id,
    idempotency_key: key,
    resource_id: body.resource_id,
    start: body.start,
    end: body.end,
  };
  await store.put(tenant, key, booking);
  app.log.info({tenant, booking: booking.booking_id, resource: body.resource_id}, 'booked');
  return reply.code(201).send(booking);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type BookingRequest struct {
	ResourceID string \`json:"resource_id"\`
	Start      string \`json:"start"\`
	End        string \`json:"end"\`
}

func takeHold(ctx context.Context, tenant, resourceID, start, end string) (map[string]any, error) {
	return nil, nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func createBooking(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft books whatever range it is handed — past, inverted or beyond the horizon —
	// and it ignores Idempotency-Key, so a client retry after a timeout takes a second hold.
	// Review the range rules and the idempotency lookup.
	var body BookingRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	hold, err := takeHold(r.Context(), r.Header.Get("X-Tenant-Id"), body.ResourceID, body.Start, body.End)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("hold=%v tenant=%s", hold["hold_id"], r.Header.Get("X-Tenant-Id"))
	writeJSON(rw, http.StatusCreated, hold)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/bookings", createBooking)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const maxHorizonDays = 90

type BookingRequest struct {
	ResourceID string \`json:"resource_id"\`
	Start      string \`json:"start"\`
	End        string \`json:"end"\`
}

type BookingStore interface {
	Get(ctx context.Context, tenant, key string) (map[string]any, error)
	Put(ctx context.Context, tenant, key string, booking map[string]any) error
}

func takeHold(ctx context.Context, tenant, resourceID, start, end string) (map[string]any, error) {
	return nil, nil
}

func idempotencyKey(tenant, resourceID, start, end string) string {
	return "book:" + tenant + ":" + resourceID + ":" + start + ":" + end
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func createBooking(store BookingStore, rdb HoldMap) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		tenant := r.Header.Get("X-Tenant-Id")
		if tenant == "" {
			writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
			return
		}
		idemKey := r.Header.Get("Idempotency-Key")
		if idemKey == "" {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
			return
		}
		var body BookingRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		start, err := time.Parse(time.RFC3339, body.Start)
		if err != nil {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
			return
		}
		end, err := time.Parse(time.RFC3339, body.End)
		if err != nil {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
			return
		}
		if !end.After(start) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
			return
		}
		now := time.Now().UTC()
		if start.Before(now) {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "range_in_past"})
			return
		}
		if end.After(now.AddDate(0, 0, maxHorizonDays)) {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "beyond_horizon"})
			return
		}
		key := idempotencyKey(tenant, body.ResourceID, body.Start, body.End)
		stored, err := store.Get(r.Context(), tenant, key)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		if stored != nil {
			writeJSON(rw, http.StatusOK, stored)
			return
		}
		hold, err := takeHold(r.Context(), tenant, body.ResourceID, body.Start, body.End)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		booking := map[string]any{
			"booking_id":      uuid.NewString(),
			"hold_id":         hold["hold_id"],
			"idempotency_key": key,
			"resource_id":     body.ResourceID,
			"start":           body.Start,
			"end":             body.End,
		}
		if err := store.Put(r.Context(), tenant, key, booking); err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		log.Printf("booking=%s tenant=%s resource=%s", booking["booking_id"], tenant, body.ResourceID)
		writeJSON(rw, http.StatusCreated, booking)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/bookings", createBooking(store, rdb))
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

final case class BookingRequest(resource_id: String, start: String, end: String)

object BookingApi {
  implicit val system: ActorSystem = ActorSystem("booking")

  def takeHold(tenant: String, resourceId: String, start: String, end: String): Map[String, String] =
    Map.empty

  val route: Route =
    path("v1" / "bookings") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[BookingRequest]) { body =>
            // TODO: this draft books whatever range it is handed — past, inverted or beyond the
            // horizon — and it ignores Idempotency-Key, so a client retry after a timeout takes a
            // second hold. Review the range rules and the idempotency lookup.
            val hold = takeHold(tenant, body.resource_id, body.start, body.end)
            system.log.info(s"hold=\${hold("hold_id")} tenant=$tenant")
            complete(StatusCodes.Created, hold("hold_id"))
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.time.{Duration, Instant}
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class BookingRequest(resource_id: String, start: String, end: String)

object BookingApi {
  implicit val system: ActorSystem = ActorSystem("booking")
  implicit val requestFormat: RootJsonFormat[BookingRequest] = jsonFormat3(BookingRequest)

  val MaxHorizonDays = 90L

  val store: BookingStore = BookingStore.open()

  def takeHold(tenant: String, resourceId: String, start: String, end: String): Map[String, String] =
    Map.empty

  def idempotencyKey(tenant: String, resourceId: String, start: String, end: String): String =
    s"book:$tenant:$resourceId:$start:$end"

  val route: Route =
    path("v1" / "bookings") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[BookingRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else {
                val tenant = tenantOpt.get
                val start = Instant.parse(body.start)
                val end = Instant.parse(body.end)
                if (!end.isAfter(start)) {
                  complete(StatusCodes.BadRequest, """{"error":"invalid_range"}""")
                } else if (start.isBefore(Instant.now())) {
                  complete(StatusCodes.UnprocessableEntity, """{"error":"range_in_past"}""")
                } else if (end.isAfter(Instant.now().plus(Duration.ofDays(MaxHorizonDays)))) {
                  complete(StatusCodes.UnprocessableEntity, """{"error":"beyond_horizon"}""")
                } else {
                  val key = idempotencyKey(tenant, body.resource_id, body.start, body.end)
                  store.get(tenant, key) match {
                    case Some(stored) =>
                      complete(StatusCodes.OK, stored)
                    case None =>
                      val hold = takeHold(tenant, body.resource_id, body.start, body.end)
                      val booking = Map(
                        "booking_id" -> UUID.randomUUID().toString,
                        "hold_id" -> hold.getOrElse("hold_id", ""),
                        "idempotency_key" -> key
                      )
                      store.put(tenant, key, booking)
                      system.log.info(s"booking=\${booking("booking_id")} tenant=$tenant resource=\${body.resource_id}")
                      complete(StatusCodes.Created, booking)
                  }
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

#include <iostream>
#include <string>

using json = nlohmann::json;

static json takeHold(const std::string& tenant, const std::string& resourceId, const std::string& start,
                     const std::string& end) {
  return json{{"hold_id", "hold-1"}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/bookings", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft books whatever range it is handed — past, inverted or beyond the horizon —
    // and it ignores Idempotency-Key, so a client retry after a timeout takes a second hold.
    // Review the range rules and the idempotency lookup.
    const auto body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"invalid json\\"}", "application/json");
      return;
    }
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto hold = takeHold(tenant, body.value("resource_id", std::string()),
                               body.value("start", std::string()), body.value("end", std::string()));
    std::clog << "hold=" << hold.value("hold_id", std::string()) << " tenant=" << tenant << "\\n";
    res.status = 201;
    res.set_content(hold.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr long long kMaxHorizonDays = 90;

class BookingStore {
 public:
  virtual ~BookingStore() = default;
  virtual json get(const std::string& tenant, const std::string& key) = 0;
  virtual void put(const std::string& tenant, const std::string& key, const json& booking) = 0;
};

static json takeHold(const std::string& tenant, const std::string& resourceId, const std::string& start,
                     const std::string& end) {
  return json{{"hold_id", "hold-1"}};
}

static std::string idempotencyKey(const std::string& tenant, const std::string& resourceId,
                                  const std::string& start, const std::string& end) {
  return "book:" + tenant + ":" + resourceId + ":" + start + ":" + end;
}

int main() {
  httplib::Server svr;
  BookingStore& store = *openStore();

  svr.Post("/v1/bookings", [&store](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content("{\\"error\\":\\"missing X-Tenant-Id\\"}", "application/json");
      return;
    }
    if (req.get_header_value("Idempotency-Key").empty()) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"Idempotency-Key is required\\"}", "application/json");
      return;
    }
    const auto body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"invalid json\\"}", "application/json");
      return;
    }
    const auto resource_id = body.value("resource_id", std::string());
    const auto start_text = body.value("start", std::string());
    const auto end_text = body.value("end", std::string());
    const auto start = parseInstant(start_text);
    const auto end = parseInstant(end_text);
    if (!start.has_value() || !end.has_value() || end.value() <= start.value()) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"invalid_range\\"}", "application/json");
      return;
    }
    const auto now = std::chrono::system_clock::now();
    if (start.value() < now) {
      res.status = 422;
      res.set_content("{\\"error\\":\\"range_in_past\\"}", "application/json");
      return;
    }
    if (end.value() > now + std::chrono::hours(24 * kMaxHorizonDays)) {
      res.status = 422;
      res.set_content("{\\"error\\":\\"beyond_horizon\\"}", "application/json");
      return;
    }
    const auto key = idempotencyKey(tenant, resource_id, start_text, end_text);
    const auto stored = store.get(tenant, key);
    if (!stored.is_null()) {
      res.status = 200;
      res.set_content(stored.dump(), "application/json");
      return;
    }
    const auto hold = takeHold(tenant, resource_id, start_text, end_text);
    json booking = {{"booking_id", newId()},
                    {"hold_id", hold.value("hold_id", std::string())},
                    {"idempotency_key", key},
                    {"resource_id", resource_id},
                    {"start", start_text},
                    {"end", end_text}};
    store.put(tenant, key, booking);
    std::clog << "booking=" << booking["booking_id"] << " tenant=" << tenant << " resource=" << resource_id << "\\n";
    res.status = 201;
    res.set_content(booking.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate in cost order and stop at the first failure: tenant, key, then the range — shape first (`end <= start`), then clock (`start < now`), then horizon. Every rejection happens before a hold exists.',
    'A range that will never be valid and a range that is not valid yet are different answers: `400 invalid_range` is a malformed request, `422` is a well-formed request the calendar refuses.',
    'The idempotency key is a function of the booking identity — `(tenant, resource, range)` — not of the request. Look it up before taking the hold, and return the stored booking with `200` so a retry is visibly a replay.',
  ],
  debrief: `The interviewer is testing the funnel in front of the expensive, stateful part of the system.
The draft is plausible because a demo sends one future range from one client; the defects only appear
with a stale client clock, a client that sends \`end\` before \`start\`, and the timeout-then-retry that
every mobile network produces. Three things are being checked: the range is a real interval, the range
is in the future within the tenant's horizon, and the booking is keyed so a retry returns the first
booking instead of taking a second hold. The ordering matters too — every rejection runs before the
hold, so a bad request can never leave state behind. Real booking systems add a maximum duration per
range, a per-tenant booking rate limit, and a far-future staging window for seasonal inventory.`,
};
