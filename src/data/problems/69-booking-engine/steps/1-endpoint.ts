import type {Step} from '@/lib/types';

export const bookingEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/bookings: a range that must be real and future',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/bookings\` with body
\`{"resource_id", "start", "end"}\` (ISO-8601 instants): it reads the tenant from \`X-Tenant-Id\`
(**401** when missing), parses the instants, calls \`take_hold\` from the state step with the range's
slot fields (**409** \`slot_taken\` on \`None\`), stores the booking and answers **201** with it. It
serves the demo and hides four flaws.

**Failure mode the checks target.** A client whose clock is wrong, a form that swapped its two
fields, a calendar that reaches two years out, and the retry every mobile network produces after a
timeout.

Rules, in this order, before any hold is taken:

- \`Idempotency-Key\` is required: **400** \`missing_idempotency_key\`.
- An \`end\` that is not strictly after \`start\`, or an instant that does not parse, is **400**
  \`invalid_range\`.
- A \`start\` before now is **422** \`range_in_past\`; an \`end\` more than **90 days** out
  (\`MAX_HORIZON_DAYS\` in \`booking/slots\`) is **422** \`beyond_horizon\`.
- The key is the booking's identity for this tenant: look it up with \`store.get_by_key\` before
  taking a hold, and answer a replay with the stored booking and **200**. The booking stores the key
  as \`idempotency_key\`; later steps send it to the calendar.`,
  sequence: {
    participants: ['Client', 'Booking API', 'Booking store'],
    messages: [
      {from: 'Client', to: 'Booking API', label: 'POST /v1/bookings · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Booking API', to: 'Booking API', label: 'reject invalid · past · beyond horizon', kind: 'sync'},
      {from: 'Booking API', to: 'Booking store', label: 'get_by_key(tenant, key)', kind: 'sync'},
      {from: 'Booking store', to: 'Booking API', label: 'stored booking / none', kind: 'reply'},
      {from: 'Booking API', to: 'Booking store', label: 'take_hold · put(booking)', kind: 'async'},
      {from: 'Booking API', to: 'Client', label: '201 first booking · 200 on replay', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/bookings',
      detail:
        'A valid future range answers 201 with the booking, and the range’s slots are held in `resource:{id}:slots`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/bookings["']/, /take_hold\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/bookings['"]/, /takeHold\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/bookings"/, /takeHold\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"bookings"\s*\)/, /\bpost\s*\{/, /takeHold\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/bookings"/, /takeHold\(/]},
      },
    },
    {
      id: 'range-order',
      title: 'Rejects an inverted or zero-length range with 400',
      detail:
        'An `end` that is not strictly after `start` is **400** `invalid_range`, and nothing is held. The starter takes a hold for `end < start` and for `end == start`.',
      match: {
        python: {all: [/invalid_range/, /\bend\s*(<=|>)\s*start\b|\bstart\s*(>=|<)\s*end\b/]},
        typescript: {all: [/invalid_range/, /\bend\s*(<=|>)\s*start\b|\bstart\s*(>=|<)\s*end\b/]},
        go: {all: [/invalid_range/, /\bend\s*(<=|>)\s*start\b|\bstart\s*(>=|<)\s*end\b/]},
        scala: {all: [/invalid_range/, /\bend\s*(<=|>)\s*start\b|\bstart\s*(>=|<)\s*end\b/]},
        cpp: {all: [/invalid_range/, /\*?end\s*(<=|>)\s*\*?start\b|\*?start\s*(>=|<)\s*\*?end\b/]},
      },
    },
    {
      id: 'past-start',
      title: 'Rejects a start in the past with 422',
      detail: 'A `start` before now is **422** `range_in_past`, and nothing is held. The starter books it.',
      match: {
        python: {all: [/range_in_past/, /start\s*<\s*now|now\s*>\s*start/]},
        typescript: {all: [/range_in_past/, /start\s*<\s*now|now\s*>\s*start/]},
        go: {all: [/range_in_past/, /start\s*<\s*now|now\s*>\s*start/]},
        scala: {all: [/range_in_past/, /start\s*<\s*now|now\s*>\s*start/]},
        cpp: {all: [/range_in_past/, /start\s*<\s*now|now\s*>\s*start/]},
      },
    },
    {
      id: 'horizon',
      title: 'Rejects a range past the 90-day horizon',
      detail:
        'An `end` more than 90 days from now is **422** `beyond_horizon`; 89 days out is booked. The starter accepts any end.',
      match: {
        python: {all: [/beyond_horizon/, /MAX_HORIZON_DAYS|\b90\b/]},
        typescript: {all: [/beyond_horizon/, /MAX_HORIZON_DAYS|\b90\b/]},
        go: {all: [/beyond_horizon/, /MaxHorizonDays|\b90\b/]},
        scala: {all: [/beyond_horizon/, /MaxHorizonDays|\b90\b/]},
        cpp: {all: [/beyond_horizon/, /kMaxHorizonDays|\b90\b/]},
      },
    },
    {
      id: 'replay',
      title: 'Returns the first booking for a replayed Idempotency-Key',
      detail:
        'A missing key is **400**; a replayed key answers the stored booking with **200**, the same `booking_id`, and takes no second hold. The starter reads the header and ignores it.',
      match: {
        python: {all: [/missing_idempotency_key/], order: [/store\.get_by_key\(/, /take_hold\(/]},
        typescript: {all: [/missing_idempotency_key/], order: [/store\.getByKey\(/, /takeHold\(/]},
        go: {all: [/missing_idempotency_key/], order: [/store\.GetByKey\(/, /takeHold\(/]},
        scala: {all: [/missing_idempotency_key/], order: [/Store\.getByKey\(/, /takeHold\(/]},
        cpp: {all: [/missing_idempotency_key/], order: [/store::GetByKey\(/, /takeHold\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from booking.slots import MAX_HORIZON_DAYS, slot_fields
from booking.store import new_id, store
from booking.tz import parse_instant
from state import take_hold  # step 2: the atomic hold, None when a slot is taken

app = FastAPI()
log = logging.getLogger("booking")


class BookingRequest(BaseModel):
    resource_id: str
    start: str
    end: str


@app.post("/v1/bookings")
def create_booking(
    body: BookingRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    start = parse_instant(body.start)
    end = parse_instant(body.end)
    if start is None or end is None:
        return JSONResponse({"error": "invalid_range"}, status_code=400)
    hold = take_hold(body.resource_id, slot_fields(start, end))
    if hold is None:
        return JSONResponse({"error": "slot_taken"}, status_code=409)
    booking = {
        "booking_id": new_id(),
        "tenant": tenant,
        "resource_id": body.resource_id,
        "start": body.start,
        "end": body.end,
        "hold_id": hold["hold_id"],
        "idempotency_key": idem_key or "",
        "state": "held",
    }
    store.put(booking)
    log.info("booking=%s tenant=%s resource=%s", booking["booking_id"], tenant, body.resource_id)
    return JSONResponse(booking, status_code=201)
`,
      solution: `import logging
import time

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from booking.slots import MAX_HORIZON_DAYS, slot_fields
from booking.store import new_id, store
from booking.tz import parse_instant
from state import take_hold  # step 2: the atomic hold, None when a slot is taken

app = FastAPI()
log = logging.getLogger("booking")


class BookingRequest(BaseModel):
    resource_id: str
    start: str
    end: str


@app.post("/v1/bookings")
def create_booking(
    body: BookingRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    if not idem_key:
        return JSONResponse({"error": "missing_idempotency_key"}, status_code=400)
    start = parse_instant(body.start)
    end = parse_instant(body.end)
    if start is None or end is None or end <= start:
        return JSONResponse({"error": "invalid_range"}, status_code=400)
    now = int(time.time())
    if start < now:
        return JSONResponse({"error": "range_in_past"}, status_code=422)
    if end > now + MAX_HORIZON_DAYS * 86400:
        return JSONResponse({"error": "beyond_horizon"}, status_code=422)

    # The key is this tenant's name for the booking: a retry after a timeout is the same booking.
    stored = store.get_by_key(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    hold = take_hold(body.resource_id, slot_fields(start, end))
    if hold is None:
        return JSONResponse({"error": "slot_taken"}, status_code=409)
    booking = {
        "booking_id": new_id(),
        "tenant": tenant,
        "resource_id": body.resource_id,
        "start": body.start,
        "end": body.end,
        "hold_id": hold["hold_id"],
        "idempotency_key": idem_key,
        "state": "held",
    }
    store.put(booking)
    log.info("booking=%s tenant=%s resource=%s", booking["booking_id"], tenant, body.resource_id)
    return JSONResponse(booking, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {MAX_HORIZON_DAYS, slotFields} from 'booking/slots';
import {type Booking, newId, store} from 'booking/store';
import {parseInstant} from 'booking/tz';
import {takeHold} from './state'; // step 2: the atomic hold, null when a slot is taken

export const app = Fastify();

interface BookingBody {
  resource_id: string;
  start: string;
  end: string;
}

app.post('/v1/bookings', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  const idemKey = request.headers['idempotency-key'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const body = request.body as BookingBody;
  const start = parseInstant(body.start);
  const end = parseInstant(body.end);
  if (start === null || end === null) return reply.code(400).send({error: 'invalid_range'});
  const hold = await takeHold(body.resource_id, slotFields(start, end));
  if (hold === null) return reply.code(409).send({error: 'slot_taken'});
  const booking: Booking = {
    booking_id: newId(),
    tenant,
    resource_id: body.resource_id,
    start: body.start,
    end: body.end,
    hold_id: hold.hold_id,
    idempotency_key: typeof idemKey === 'string' ? idemKey : '',
    state: 'held',
    event_id: '',
  };
  await store.put(booking);
  app.log.info({booking: booking.booking_id, tenant, resource: body.resource_id}, 'booking held');
  return reply.code(201).send(booking);
});
`,
      solution: `import Fastify from 'fastify';

import {MAX_HORIZON_DAYS, slotFields} from 'booking/slots';
import {type Booking, newId, store} from 'booking/store';
import {parseInstant} from 'booking/tz';
import {takeHold} from './state'; // step 2: the atomic hold, null when a slot is taken

export const app = Fastify();

interface BookingBody {
  resource_id: string;
  start: string;
  end: string;
}

app.post('/v1/bookings', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const idemKey = request.headers['idempotency-key'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'missing_idempotency_key'});
  const body = request.body as BookingBody;
  const start = parseInstant(body.start);
  const end = parseInstant(body.end);
  if (start === null || end === null || end <= start) return reply.code(400).send({error: 'invalid_range'});
  const now = Math.floor(Date.now() / 1000);
  if (start < now) return reply.code(422).send({error: 'range_in_past'});
  if (end > now + MAX_HORIZON_DAYS * 86400) return reply.code(422).send({error: 'beyond_horizon'});

  // The key is this tenant's name for the booking: a retry after a timeout is the same booking.
  const stored = await store.getByKey(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const hold = await takeHold(body.resource_id, slotFields(start, end));
  if (hold === null) return reply.code(409).send({error: 'slot_taken'});
  const booking: Booking = {
    booking_id: newId(),
    tenant,
    resource_id: body.resource_id,
    start: body.start,
    end: body.end,
    hold_id: hold.hold_id,
    idempotency_key: idemKey,
    state: 'held',
    event_id: '',
  };
  await store.put(booking);
  app.log.info({booking: booking.booking_id, tenant, resource: body.resource_id}, 'booking held');
  return reply.code(201).send(booking);
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"booking/slots"
	"booking/store"
	"booking/tz"
)

// Built in step 2 (state.go): the atomic hold, nil when a slot is taken.
var takeHold = func(ctx context.Context, resourceID string, slotFields []string) (*store.Hold, error) {
	panic("not implemented")
}

type BookingRequest struct {
	ResourceID string \`json:"resource_id"\`
	Start      string \`json:"start"\`
	End        string \`json:"end"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func createBooking(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	idemKey := r.Header.Get("Idempotency-Key")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	var body BookingRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	start, okStart := tz.ParseInstant(body.Start)
	end, okEnd := tz.ParseInstant(body.End)
	if !okStart || !okEnd {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
		return
	}
	hold, err := takeHold(r.Context(), body.ResourceID, slots.Fields(start, end)) // step 2: nil when a slot is taken
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if hold == nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "slot_taken"})
		return
	}
	booking := &store.Booking{
		BookingID: store.NewID(), Tenant: tenant, ResourceID: body.ResourceID, Start: body.Start, End: body.End,
		HoldID: hold.HoldID, IdempotencyKey: idemKey, State: "held",
	}
	if err := store.Put(r.Context(), booking); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	log.Printf("booking=%s tenant=%s resource=%s", booking.BookingID, tenant, body.ResourceID)
	writeJSON(rw, http.StatusCreated, booking)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/bookings", createBooking)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"booking/slots"
	"booking/store"
	"booking/tz"
)

// Built in step 2 (state.go): the atomic hold, nil when a slot is taken.
var takeHold = func(ctx context.Context, resourceID string, slotFields []string) (*store.Hold, error) {
	panic("not implemented")
}

type BookingRequest struct {
	ResourceID string \`json:"resource_id"\`
	Start      string \`json:"start"\`
	End        string \`json:"end"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func createBooking(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	idemKey := r.Header.Get("Idempotency-Key")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "missing_idempotency_key"})
		return
	}
	var body BookingRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	start, okStart := tz.ParseInstant(body.Start)
	end, okEnd := tz.ParseInstant(body.End)
	if !okStart || !okEnd || end <= start {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
		return
	}
	now := time.Now().Unix()
	if start < now {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "range_in_past"})
		return
	}
	if end > now+slots.MaxHorizonDays*86400 {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "beyond_horizon"})
		return
	}

	// The key is this tenant's name for the booking: a retry after a timeout is the same booking.
	stored, err := store.GetByKey(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	hold, err := takeHold(r.Context(), body.ResourceID, slots.Fields(start, end)) // step 2: nil when a slot is taken
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if hold == nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "slot_taken"})
		return
	}
	booking := &store.Booking{
		BookingID: store.NewID(), Tenant: tenant, ResourceID: body.ResourceID, Start: body.Start, End: body.End,
		HoldID: hold.HoldID, IdempotencyKey: idemKey, State: "held",
	}
	if err := store.Put(r.Context(), booking); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	log.Printf("booking=%s tenant=%s resource=%s", booking.BookingID, tenant, body.ResourceID)
	writeJSON(rw, http.StatusCreated, booking)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/bookings", createBooking)
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

import booking.{Booking, Slots, Store, Tz}

final case class BookingRequest(resource_id: String, start: String, end: String)

object BookingApi {
  implicit val system: ActorSystem = ActorSystem("booking")
  implicit val requestFormat: RootJsonFormat[BookingRequest] = jsonFormat3(BookingRequest)

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  val route: Route =
    path("v1" / "bookings") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[BookingRequest]) { body =>
              // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
              val tenant = tenantOpt.getOrElse("")
              if (tenant.isEmpty) error(StatusCodes.Unauthorized, "missing_tenant")
              else {
                (Tz.parseInstant(body.start), Tz.parseInstant(body.end)) match {
                  case (Some(start), Some(end)) =>
                    HoldMap.takeHold(body.resource_id, Slots.fields(start, end)) match { // step 2: None when a slot is taken
                      case None => error(StatusCodes.Conflict, "slot_taken")
                      case Some(hold) =>
                        val booking = Booking(
                          Store.newId(),
                          tenant,
                          body.resource_id,
                          body.start,
                          body.end,
                          hold.hold_id,
                          idemOpt.getOrElse(""),
                          "held"
                        )
                        Store.put(booking)
                        system.log.info(s"booking=\${booking.booking_id} tenant=$tenant resource=\${body.resource_id}")
                        complete(StatusCodes.Created, booking)
                    }
                  case _ => error(StatusCodes.BadRequest, "invalid_range")
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
      solution: `import java.time.Instant

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import booking.{Booking, Slots, Store, Tz}

final case class BookingRequest(resource_id: String, start: String, end: String)

object BookingApi {
  implicit val system: ActorSystem = ActorSystem("booking")
  implicit val requestFormat: RootJsonFormat[BookingRequest] = jsonFormat3(BookingRequest)

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  val route: Route =
    path("v1" / "bookings") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[BookingRequest]) { body =>
              val tenant = tenantOpt.getOrElse("")
              val idemKey = idemOpt.getOrElse("")
              val now = Instant.now().getEpochSecond
              if (tenant.isEmpty) error(StatusCodes.Unauthorized, "missing_tenant")
              else if (idemKey.isEmpty) error(StatusCodes.BadRequest, "missing_idempotency_key")
              else {
                (Tz.parseInstant(body.start), Tz.parseInstant(body.end)) match {
                  case (Some(start), Some(end)) if end > start =>
                    if (start < now) error(StatusCodes.UnprocessableEntity, "range_in_past")
                    else if (end > now + Slots.MaxHorizonDays * 86400L) error(StatusCodes.UnprocessableEntity, "beyond_horizon")
                    else
                      // The key is this tenant's name for the booking: a retry after a timeout is the same booking.
                      Store.getByKey(tenant, idemKey) match {
                        case Some(stored) => complete(StatusCodes.OK, stored)
                        case None =>
                          HoldMap.takeHold(body.resource_id, Slots.fields(start, end)) match { // step 2: None when a slot is taken
                            case None => error(StatusCodes.Conflict, "slot_taken")
                            case Some(hold) =>
                              val booking = Booking(
                                Store.newId(),
                                tenant,
                                body.resource_id,
                                body.start,
                                body.end,
                                hold.hold_id,
                                idemKey,
                                "held"
                              )
                              Store.put(booking)
                              system.log.info(s"booking=\${booking.booking_id} tenant=$tenant resource=\${body.resource_id}")
                              complete(StatusCodes.Created, booking)
                          }
                      }
                  case _ => error(StatusCodes.BadRequest, "invalid_range")
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

#include <chrono>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

#include "booking/slots.h"
#include "booking/store.h"
#include "booking/tz.h"

using json = nlohmann::json;

// Built in step 2 (state.cpp): the atomic hold, nothing when a slot is taken.
std::optional<booking::Hold> takeHold(const std::string& resource_id, const std::vector<std::string>& slot_fields);

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void createBooking(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (tenant.empty()) return fail(res, 401, "missing_tenant");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid_json");
  const std::string resource_id = body.value("resource_id", "");
  const std::string start_text = body.value("start", "");
  const std::string end_text = body.value("end", "");
  const auto start = booking::tz::ParseInstant(start_text);
  const auto end = booking::tz::ParseInstant(end_text);
  if (!start || !end) return fail(res, 400, "invalid_range");
  const auto hold = takeHold(resource_id, booking::slots::Fields(*start, *end));
  if (!hold) return fail(res, 409, "slot_taken");
  const booking::Booking b{booking::NewId(), tenant, resource_id, start_text, end_text, hold->hold_id, idem_key, "held", ""};
  booking::store::Put(b);
  std::clog << "booking=" << b.booking_id << " tenant=" << tenant << " resource=" << resource_id << "\\n";
  res.status = 201;
  res.set_content(json(b).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/bookings", createBooking);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

#include "booking/slots.h"
#include "booking/store.h"
#include "booking/tz.h"

using json = nlohmann::json;

// Built in step 2 (state.cpp): the atomic hold, nothing when a slot is taken.
std::optional<booking::Hold> takeHold(const std::string& resource_id, const std::vector<std::string>& slot_fields);

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void createBooking(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (tenant.empty()) return fail(res, 401, "missing_tenant");
  if (idem_key.empty()) return fail(res, 400, "missing_idempotency_key");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid_json");
  const std::string resource_id = body.value("resource_id", "");
  const std::string start_text = body.value("start", "");
  const std::string end_text = body.value("end", "");
  const auto start = booking::tz::ParseInstant(start_text);
  const auto end = booking::tz::ParseInstant(end_text);
  if (!start || !end || *end <= *start) return fail(res, 400, "invalid_range");
  const int64_t now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  if (*start < now) return fail(res, 422, "range_in_past");
  if (*end > now + static_cast<int64_t>(booking::slots::kMaxHorizonDays) * 86400) return fail(res, 422, "beyond_horizon");

  // The key is this tenant's name for the booking: a retry after a timeout is the same booking.
  if (const auto stored = booking::store::GetByKey(tenant, idem_key)) {
    res.status = 200;
    res.set_content(json(*stored).dump(), "application/json");
    return;
  }

  const auto hold = takeHold(resource_id, booking::slots::Fields(*start, *end));
  if (!hold) return fail(res, 409, "slot_taken");
  const booking::Booking b{booking::NewId(), tenant, resource_id, start_text, end_text, hold->hold_id, idem_key, "held", ""};
  booking::store::Put(b);
  std::clog << "booking=" << b.booking_id << " tenant=" << tenant << " resource=" << resource_id << "\\n";
  res.status = 201;
  res.set_content(json(b).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/bookings", createBooking);
}
`,
    },
  },
  harness: {
    python: `import time

from booking.slots import hold_key, slot_fields, slots_key
from booking.tz import format_instant, parse_instant

H = {"X-Tenant-Id": "t1", "Idempotency-Key": "k1"}


def _body(ctx, start_in_s, length_s=3600, resource="r1"):
    """A range starting start_in_s from now, as the client sends it."""
    now = int(time.time())
    return {"resource_id": resource, "start": format_instant(now + start_in_s), "end": format_instant(now + start_in_s + length_s)}


async def _post(ctx, m, body, headers=H):
    async with ctx.client(m.app) as c:
        return await c.post("/v1/bookings", json=body, headers=headers)


def _nothing_held(ctx, what):
    assert ctx.redis.keys("*") == [], f"{what} must leave nothing behind, Redis holds {sorted(ctx.redis.keys('*'))}"


async def check_route(ctx):
    m = ctx.load("api")
    body = _body(ctx, 3600)
    r = await _post(ctx, m, body)
    assert r.status_code == 201, f"POST /v1/bookings for a free future hour answered {r.status_code}: {r.text}"
    booking = r.json()
    assert booking.get("booking_id") and booking.get("hold_id"), f"the answer must carry booking_id and hold_id: {booking}"
    fields = slot_fields(parse_instant(body["start"]), parse_instant(body["end"]))
    held = ctx.redis.hgetall(slots_key("r1"))
    assert all(held.get(f) == booking["hold_id"] for f in fields), f"resource:r1:slots holds {held}, expected the range's {len(fields)} slots owned by {booking['hold_id']}"
    assert ctx.redis.ttl(hold_key(booking["hold_id"])) > 0, "the hold key must exist with the payment window"


async def check_range_order(ctx):
    m = ctx.load("api")
    zero = _body(ctx, 3600, length_s=0)
    r = await _post(ctx, m, zero)
    assert r.status_code == 400 and r.json().get("error") == "invalid_range", f"a zero-length range answered {r.status_code} {r.text}, expected 400 invalid_range"
    _nothing_held(ctx, "a rejected range")
    inverted = _body(ctx, 7200, length_s=-3600)
    r = await _post(ctx, m, inverted)
    assert r.status_code == 400 and r.json().get("error") == "invalid_range", f"a range with end before start answered {r.status_code} {r.text}, expected 400 invalid_range"
    _nothing_held(ctx, "a rejected range")
    r = await _post(ctx, m, {"resource_id": "r1", "start": "tomorrow", "end": "later"})
    assert r.status_code == 400, f"instants that do not parse answered {r.status_code}, expected 400"


async def check_past_start(ctx):
    m = ctx.load("api")
    r = await _post(ctx, m, _body(ctx, -3600, length_s=7200))
    assert r.status_code == 422 and r.json().get("error") == "range_in_past", f"a range starting an hour ago answered {r.status_code} {r.text}, expected 422 range_in_past"
    _nothing_held(ctx, "a range in the past")
    r = await _post(ctx, m, _body(ctx, 60))
    assert r.status_code == 201, f"a range starting in a minute answered {r.status_code}: {r.text}"


async def check_horizon(ctx):
    m = ctx.load("api")
    r = await _post(ctx, m, _body(ctx, 91 * 86400))
    assert r.status_code == 422 and r.json().get("error") == "beyond_horizon", f"a range 91 days out answered {r.status_code} {r.text}, expected 422 beyond_horizon"
    _nothing_held(ctx, "a range beyond the horizon")
    r = await _post(ctx, m, _body(ctx, 89 * 86400))
    assert r.status_code == 201, f"a range 89 days out answered {r.status_code}: {r.text}"


async def check_replay(ctx):
    m = ctx.load("api")
    body = _body(ctx, 3600)
    r = await _post(ctx, m, body, {"X-Tenant-Id": "t1"})
    assert r.status_code == 400 and r.json().get("error") == "missing_idempotency_key", f"a request without Idempotency-Key answered {r.status_code} {r.text}, expected 400 missing_idempotency_key"
    first = await _post(ctx, m, body)
    assert first.status_code == 201, f"the first booking answered {first.status_code}: {first.text}"
    again = await _post(ctx, m, body)  # the client timed out and retried with the same key
    assert again.status_code == 200, f"the replayed request answered {again.status_code} {again.text}, expected 200 with the first booking"
    assert again.json().get("booking_id") == first.json()["booking_id"], f"the replay answered booking {again.json().get('booking_id')}, expected the first booking {first.json()['booking_id']}"
    holds = ctx.redis.keys("hold:*")
    assert holds == [hold_key(first.json()["hold_id"])], f"after a replay the hold keys are {holds}: a replay must not take a second hold"
    other = await _post(ctx, m, body, {"X-Tenant-Id": "t1", "Idempotency-Key": "k2"})
    assert other.status_code == 409, f"a different key for the held range answered {other.status_code}, expected 409 slot_taken"
`,
    typescript: `import {holdKey, slotFields, slotsKey} from 'booking/slots';
import {formatInstant, parseInstant} from 'booking/tz';

const H = {'X-Tenant-Id': 't1', 'Idempotency-Key': 'k1'};

/** A range starting startInS from now, as the client sends it. */
const body = (startInS: number, lengthS = 3600, resource = 'r1') => {
  const now = Math.floor(Date.now() / 1000);
  return {resource_id: resource, start: formatInstant(now + startInS), end: formatInstant(now + startInS + lengthS)};
};

const api = ctx => {
  const m = ctx.load('api');
  return ctx.client(m.app);
};

const nothingHeld = (ctx, what: string) => {
  const keys = ctx.redis.keys('*');
  assert.equal(keys.length, 0, \`\${what} must leave nothing behind, Redis holds \${JSON.stringify(keys.sort())}\`);
};

export async function check_route(ctx) {
  const c = api(ctx);
  const b = body(3600);
  const r = await c.post('/v1/bookings', {json: b, headers: H});
  assert.equal(r.status, 201, \`POST /v1/bookings for a free future hour answered \${r.status}: \${r.text}\`);
  const booking = r.json();
  assert(booking.booking_id && booking.hold_id, \`the answer must carry booking_id and hold_id: \${r.text}\`);
  const fields = slotFields(parseInstant(b.start), parseInstant(b.end));
  const held = ctx.redis.hgetall(slotsKey('r1'));
  assert(fields.every(f => held[f] === booking.hold_id), \`resource:r1:slots holds \${JSON.stringify(held)}, expected the range's \${fields.length} slots owned by \${booking.hold_id}\`);
  assert(ctx.redis.ttl(holdKey(booking.hold_id)) > 0, 'the hold key must exist with the payment window');
}

export async function check_range_order(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/bookings', {json: body(3600, 0), headers: H});
  assert(r.status === 400 && r.json().error === 'invalid_range', \`a zero-length range answered \${r.status} \${r.text}, expected 400 invalid_range\`);
  nothingHeld(ctx, 'a rejected range');
  r = await c.post('/v1/bookings', {json: body(7200, -3600), headers: H});
  assert(r.status === 400 && r.json().error === 'invalid_range', \`a range with end before start answered \${r.status} \${r.text}, expected 400 invalid_range\`);
  nothingHeld(ctx, 'a rejected range');
  r = await c.post('/v1/bookings', {json: {resource_id: 'r1', start: 'tomorrow', end: 'later'}, headers: H});
  assert.equal(r.status, 400, \`instants that do not parse answered \${r.status}, expected 400\`);
}

export async function check_past_start(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/bookings', {json: body(-3600, 7200), headers: H});
  assert(r.status === 422 && r.json().error === 'range_in_past', \`a range starting an hour ago answered \${r.status} \${r.text}, expected 422 range_in_past\`);
  nothingHeld(ctx, 'a range in the past');
  r = await c.post('/v1/bookings', {json: body(60), headers: H});
  assert.equal(r.status, 201, \`a range starting in a minute answered \${r.status}: \${r.text}\`);
}

export async function check_horizon(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/bookings', {json: body(91 * 86400), headers: H});
  assert(r.status === 422 && r.json().error === 'beyond_horizon', \`a range 91 days out answered \${r.status} \${r.text}, expected 422 beyond_horizon\`);
  nothingHeld(ctx, 'a range beyond the horizon');
  r = await c.post('/v1/bookings', {json: body(89 * 86400), headers: H});
  assert.equal(r.status, 201, \`a range 89 days out answered \${r.status}: \${r.text}\`);
}

export async function check_replay(ctx) {
  const c = api(ctx);
  const b = body(3600);
  let r = await c.post('/v1/bookings', {json: b, headers: {'X-Tenant-Id': 't1'}});
  assert(r.status === 400 && r.json().error === 'missing_idempotency_key', \`a request without Idempotency-Key answered \${r.status} \${r.text}, expected 400 missing_idempotency_key\`);
  const first = await c.post('/v1/bookings', {json: b, headers: H});
  assert.equal(first.status, 201, \`the first booking answered \${first.status}: \${first.text}\`);
  const again = await c.post('/v1/bookings', {json: b, headers: H}); // the client timed out and retried with the same key
  assert.equal(again.status, 200, \`the replayed request answered \${again.status} \${again.text}, expected 200 with the first booking\`);
  assert.equal(again.json().booking_id, first.json().booking_id, \`the replay answered booking \${again.json().booking_id}, expected the first booking \${first.json().booking_id}\`);
  const holds = ctx.redis.keys('hold:*');
  assert.deepEqual(holds, [holdKey(first.json().hold_id)], \`after a replay the hold keys are \${JSON.stringify(holds)}: a replay must not take a second hold\`);
  r = await c.post('/v1/bookings', {json: b, headers: {'X-Tenant-Id': 't1', 'Idempotency-Key': 'k2'}});
  assert.equal(r.status, 409, \`a different key for the held range answered \${r.status}, expected 409 slot_taken\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"leetbuild/harness"

	"booking/slots"
	"booking/store"
	"booking/tz"
)

type apiRange struct {
	ResourceID string \`json:"resource_id"\`
	Start      string \`json:"start"\`
	End        string \`json:"end"\`
}

// apiBody is a range starting startIn from now, as the client sends it.
func apiBody(startIn, length time.Duration) apiRange {
	now := time.Now().Unix()
	return apiRange{"r1", tz.FormatInstant(now + int64(startIn.Seconds())), tz.FormatInstant(now + int64(startIn.Seconds()) + int64(length.Seconds()))}
}

// apiClient serves the learner's routes over step 2's hold map, which the harness stands in for:
// every slot free and held together, the hold key with the payment window.
func apiClient(ctx *harness.Ctx) *harness.HTTP {
	takeHold = func(_ context.Context, resourceID string, fields []string) (*store.Hold, error) {
		held := ctx.Redis.HGetAll(slots.Key(resourceID))
		for _, f := range fields {
			if _, taken := held[f]; taken {
				return nil, nil
			}
		}
		holdID := store.NewID()
		for _, f := range fields {
			ctx.Redis.Do("HSET", slots.Key(resourceID), f, holdID)
		}
		ctx.Redis.Set(slots.HoldKey(holdID), "held", "EX", slots.HoldTTLS)
		return &store.Hold{HoldID: holdID, ExpiresIn: slots.HoldTTLS}, nil
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, body apiRange, header ...string) *harness.Response {
	if len(header) == 0 {
		header = []string{"X-Tenant-Id", "t1", "Idempotency-Key", "k1"}
	}
	return c.Post("/v1/bookings", body, header...)
}

// apiField is a string field of the JSON body ("" when absent).
func apiField(r *harness.Response, field string) string {
	var body map[string]any
	if err := json.Unmarshal(r.Body, &body); err != nil {
		return ""
	}
	s, _ := body[field].(string)
	return s
}

func apiError(r *harness.Response) string { return apiField(r, "error") }

func apiNothingHeld(ctx *harness.Ctx, what string) {
	keys := ctx.Redis.Keys("*")
	ctx.Assert(len(keys) == 0, "%s must leave nothing behind, Redis holds %q", what, keys)
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	body := apiBody(time.Hour, time.Hour)
	r := apiPost(c, body)
	ctx.Equal(r.Status, 201, "POST /v1/bookings for a free future hour (%s)", r.Text())
	bookingID := apiField(r, "booking_id")
	holdID := apiField(r, "hold_id")
	ctx.Assert(bookingID != "" && holdID != "", "the answer must carry booking_id and hold_id: %s", r.Text())
	start, _ := tz.ParseInstant(body.Start)
	end, _ := tz.ParseInstant(body.End)
	fields := slots.Fields(start, end)
	held := ctx.Redis.HGetAll(slots.Key("r1"))
	for _, f := range fields {
		ctx.Assert(held[f] == holdID, "resource:r1:slots holds %v, expected the range's %d slots owned by %s", held, len(fields), holdID)
	}
	ctx.Assert(ctx.Redis.TTL(slots.HoldKey(holdID)) > 0, "the hold key must exist with the payment window")
}

func CheckRangeOrder(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiBody(time.Hour, 0))
	ctx.Assert(r.Status == 400 && apiError(r) == "invalid_range", "a zero-length range answered %d %s, expected 400 invalid_range", r.Status, r.Text())
	apiNothingHeld(ctx, "a rejected range")
	r = apiPost(c, apiBody(2*time.Hour, -time.Hour))
	ctx.Assert(r.Status == 400 && apiError(r) == "invalid_range", "a range with end before start answered %d %s, expected 400 invalid_range", r.Status, r.Text())
	apiNothingHeld(ctx, "a rejected range")
	r = apiPost(c, apiRange{"r1", "tomorrow", "later"})
	ctx.Equal(r.Status, 400, "instants that do not parse")
}

func CheckPastStart(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiBody(-time.Hour, 2*time.Hour))
	ctx.Assert(r.Status == 422 && apiError(r) == "range_in_past", "a range starting an hour ago answered %d %s, expected 422 range_in_past", r.Status, r.Text())
	apiNothingHeld(ctx, "a range in the past")
	r = apiPost(c, apiBody(time.Minute, time.Hour))
	ctx.Equal(r.Status, 201, "a range starting in a minute (%s)", r.Text())
}

func CheckHorizon(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiBody(91*24*time.Hour, time.Hour))
	ctx.Assert(r.Status == 422 && apiError(r) == "beyond_horizon", "a range 91 days out answered %d %s, expected 422 beyond_horizon", r.Status, r.Text())
	apiNothingHeld(ctx, "a range beyond the horizon")
	r = apiPost(c, apiBody(89*24*time.Hour, time.Hour))
	ctx.Equal(r.Status, 201, "a range 89 days out (%s)", r.Text())
}

func CheckReplay(ctx *harness.Ctx) {
	c := apiClient(ctx)
	body := apiBody(time.Hour, time.Hour)
	r := apiPost(c, body, "X-Tenant-Id", "t1")
	ctx.Assert(r.Status == 400 && apiError(r) == "missing_idempotency_key", "a request without Idempotency-Key answered %d %s, expected 400 missing_idempotency_key", r.Status, r.Text())
	first := apiPost(c, body)
	ctx.Equal(first.Status, 201, "the first booking (%s)", first.Text())
	again := apiPost(c, body) // the client timed out and retried with the same key
	ctx.Equal(again.Status, 200, "the replayed request must answer the first booking (%s)", again.Text())
	ctx.Equal(apiField(again, "booking_id"), apiField(first, "booking_id"), "the replay must answer the first booking")
	holdID := apiField(first, "hold_id")
	ctx.Equal(ctx.Redis.Keys("hold:*"), []string{slots.HoldKey(holdID)}, "a replay must not take a second hold; the hold keys")
	other := apiPost(c, body, "X-Tenant-Id", "t1", "Idempotency-Key", "k2")
	ctx.Equal(other.Status, 409, "a different key for the held range (slot_taken)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <string>
#include <vector>

#include "state.cpp"

namespace {

// A range starting start_in seconds from now, as the client sends it.
std::string apiBody(int64_t start_in, int64_t length = 3600, const std::string& resource = "r1") {
  const int64_t now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return nlohmann::json{{"resource_id", resource},
                        {"start", booking::tz::FormatInstant(now + start_in)},
                        {"end", booking::tz::FormatInstant(now + start_in + length)}}
      .dump();
}

harness::HTTP apiClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response apiPost(harness::HTTP& c, const std::string& body, const std::string& tenant = "t1",
                          const std::string& key = "k1") {
  if (key.empty()) return c.Post("/v1/bookings", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/bookings", body, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

std::string apiError(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("error", "") : "";
}

void apiNothingHeld(harness::Ctx& ctx, const std::string& what) {
  const auto keys = ctx.Redis.Keys("*");
  ctx.Assert(keys.empty(), "%s must leave nothing behind, Redis holds %q", what, keys);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const std::string body = apiBody(3600);
  const auto r = apiPost(c, body);
  ctx.Equal(r.Status, 201, "POST /v1/bookings for a free future hour (%s)", r.Text());
  const auto booking = nlohmann::json::parse(r.Text(), nullptr, false);
  const std::string booking_id = booking.is_object() ? booking.value("booking_id", "") : "";
  const std::string hold_id = booking.is_object() ? booking.value("hold_id", "") : "";
  ctx.Assert(!booking_id.empty() && !hold_id.empty(), "the answer must carry booking_id and hold_id: %s", r.Text());
  const auto sent = nlohmann::json::parse(body);
  const auto fields = booking::slots::Fields(*booking::tz::ParseInstant(sent["start"]), *booking::tz::ParseInstant(sent["end"]));
  const auto held = ctx.Redis.HGetAll(booking::slots::Key("r1"));
  for (const auto& f : fields) {
    const auto it = held.find(f);
    ctx.Assert(it != held.end() && it->second == hold_id, "resource:r1:slots holds %v, expected the range's %d slots owned by %s", held,
               fields.size(), hold_id);
  }
  ctx.Assert(ctx.Redis.TTL(booking::slots::HoldKey(hold_id)) > 0, "the hold key must exist with the payment window");
}

void CheckRangeOrder(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto r = apiPost(c, apiBody(3600, 0));
  ctx.Assert(r.Status == 400 && apiError(r) == "invalid_range", "a zero-length range answered %d %s, expected 400 invalid_range",
             r.Status, r.Text());
  apiNothingHeld(ctx, "a rejected range");
  r = apiPost(c, apiBody(7200, -3600));
  ctx.Assert(r.Status == 400 && apiError(r) == "invalid_range",
             "a range with end before start answered %d %s, expected 400 invalid_range", r.Status, r.Text());
  apiNothingHeld(ctx, "a rejected range");
  r = apiPost(c, R"({"resource_id":"r1","start":"tomorrow","end":"later"})");
  ctx.Equal(r.Status, 400, "instants that do not parse");
}

void CheckPastStart(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto r = apiPost(c, apiBody(-3600, 7200));
  ctx.Assert(r.Status == 422 && apiError(r) == "range_in_past",
             "a range starting an hour ago answered %d %s, expected 422 range_in_past", r.Status, r.Text());
  apiNothingHeld(ctx, "a range in the past");
  r = apiPost(c, apiBody(60));
  ctx.Equal(r.Status, 201, "a range starting in a minute (%s)", r.Text());
}

void CheckHorizon(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto r = apiPost(c, apiBody(91LL * 86400));
  ctx.Assert(r.Status == 422 && apiError(r) == "beyond_horizon",
             "a range 91 days out answered %d %s, expected 422 beyond_horizon", r.Status, r.Text());
  apiNothingHeld(ctx, "a range beyond the horizon");
  r = apiPost(c, apiBody(89LL * 86400));
  ctx.Equal(r.Status, 201, "a range 89 days out (%s)", r.Text());
}

void CheckReplay(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const std::string body = apiBody(3600);
  auto r = apiPost(c, body, "t1", "");
  ctx.Assert(r.Status == 400 && apiError(r) == "missing_idempotency_key",
             "a request without Idempotency-Key answered %d %s, expected 400 missing_idempotency_key", r.Status, r.Text());
  const auto first = apiPost(c, body);
  ctx.Equal(first.Status, 201, "the first booking (%s)", first.Text());
  const auto again = apiPost(c, body);  // the client timed out and retried with the same key
  ctx.Equal(again.Status, 200, "the replayed request must answer the first booking (%s)", again.Text());
  const auto firstBooking = nlohmann::json::parse(first.Text());
  const auto againBooking = nlohmann::json::parse(again.Text(), nullptr, false);
  ctx.Equal(againBooking.is_object() ? againBooking.value("booking_id", "") : "", firstBooking.value("booking_id", ""),
            "the replay must answer the first booking");
  ctx.Equal(ctx.Redis.Keys("hold:*"), {booking::slots::HoldKey(firstBooking.value("hold_id", ""))},
            "a replay must not take a second hold; the hold keys");
  const auto other = apiPost(c, body, "t1", "k2");
  ctx.Equal(other.Status, 409, "a different key for the held range (slot_taken)");
}
`,
  },
  hints: [
    'A guest taps "book" twice after a spinner, and the room shows two bookings for the hour. Another guest, phone clock an hour behind, books a slot that has already started.',
    'Every rule the task lists runs before `take_hold`, or the hold exists for a request the service is about to refuse; the replay returns 200 because the key was looked up first, not because the hold failed.',
    'Add the three range checks in order (parse, `end <= start`, `start < now`, horizon), then `store.get_by_key(tenant, idem_key)` before `take_hold`; answer the stored booking with 200.',
  ],
  debrief: `The funnel runs in cost order because every rejection that happens before the hold is a rejection that leaves no state behind: a malformed range costs a parse, a past range costs a clock read, and only a request that passed everything touches Redis. The idempotency key is looked up before the hold for the same reason. A retry that reached the hold first would be refused with 409 and the client would never learn it had already booked; looked up first, the retry is visibly a replay. The distinction between 400 and 422 is for the client's benefit: one says fix the request, the other says the calendar refused it. Production systems also bound the range's length, pin the key to the request body so a reused key with a different range is a 422 rather than a silent replay, and expire stored keys after a day.`,
};
