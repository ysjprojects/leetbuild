import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/prices: guardrails around every change',
  concept: 'http',
  file: 'api',
  focus: ['operator', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/prices\` with \`{"sku", "price_cents", "reason"}\` on
the price store (\`pricing.store\`, provided): it calls \`store.publish(sku, price_cents, reason,
"operator")\` and answers the published row with \`previous_price_cents\` and \`moved_bp\`. It serves
the demo and hides four flaws.

**Failure mode the checks target.** A mistyped sku becomes a price row the storefront serves; a
client bug that sends \`0\` sells the item for free; an extra digit ships a tenfold price; and a
change with a blank reason leaves the audit trail nothing to explain it with.

- Look the sku up first (\`store.get_sku\`): an unknown sku is **404** and nothing is written.
- A price outside \`FLOOR_CENTS\` (50) to \`CEILING_CENTS\` (500000) is **422**, with
  \`floor_cents\` and \`ceiling_cents\` in the body.
- One change moves the price at most \`MAX_MOVE_BP\` (2000 basis points, 20 %) from the current
  price; a larger one is **409** with \`bound_cents\`: the furthest price the limit allows in that
  direction, clamped to the floor and the ceiling.
- A blank \`reason\` is **400**.`,
  sequence: {
    participants: ['Operator console', 'Pricing API', 'Price store'],
    messages: [
      {
        from: 'Operator console',
        to: 'Pricing API',
        label: 'POST /v1/prices · {sku, price_cents, reason}',
        kind: 'sync',
      },
      {from: 'Pricing API', to: 'Price store', label: 'get_sku(sku)', kind: 'sync'},
      {from: 'Price store', to: 'Pricing API', label: 'current row · none → 404', kind: 'reply'},
      {
        from: 'Pricing API',
        to: 'Pricing API',
        label: 'floor · ceiling → 422 · MAX_MOVE_BP → 409 {bound_cents}',
        kind: 'sync',
      },
      {from: 'Pricing API', to: 'Price store', label: 'publish(sku, price_cents, reason, "operator")', kind: 'sync'},
      {
        from: 'Pricing API',
        to: 'Operator console',
        label: '200 {price_cents, previous_price_cents, moved_bp}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/prices',
      detail: 'Register the price change route on `POST /v1/prices`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/prices["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/prices['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/prices"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"prices"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/prices"/]},
      },
    },
    {
      id: 'known-sku',
      title: 'An unknown sku is 404 and writes nothing',
      detail:
        'The sku is looked up (`store.get_sku`) before anything is written, and an unknown sku answers **404**. The starter publishes whatever sku it was handed, and the store creates the row.',
      match: {
        python: {all: [/store\.get_sku\(/, /\b404\b/], order: [/store\.get_sku\(/, /store\.publish\(/]},
        typescript: {all: [/getSku\(/, /\b404\b/], order: [/getSku\(/, /publish\(/]},
        go: {all: [/store\.GetSKU\(/, /StatusNotFound|\b404\b/], order: [/store\.GetSKU\(/, /store\.Publish\(/]},
        scala: {all: [/Store\.getSku\(/, /NotFound|\b404\b/], order: [/Store\.getSku\(/, /Store\.publish\(/]},
        cpp: {all: [/store::getSku\(/, /\b404\b/], order: [/store::getSku\(/, /store::publish\(/]},
      },
    },
    {
      id: 'bounds',
      title: 'Applies the floor and the ceiling',
      detail:
        'A price below `FLOOR_CENTS` or above `CEILING_CENTS` answers **422** naming `floor_cents` and `ceiling_cents`, and nothing is published. The starter has no bound, so `0` publishes a free product.',
      match: {
        python: {all: [/FLOOR_CENTS\s*=/, /CEILING_CENTS\s*=/, /\b422\b/, /floor_cents/, /ceiling_cents/]},
        typescript: {all: [/FLOOR_CENTS\s*=/, /CEILING_CENTS\s*=/, /\b422\b/, /floor_cents/, /ceiling_cents/]},
        go: {all: [/floorCents\s*=/, /ceilingCents\s*=/, /StatusUnprocessableEntity|\b422\b/, /floor_cents/]},
        scala: {all: [/FloorCents\s*=/, /CeilingCents\s*=/, /UnprocessableEntity|\b422\b/, /floor_cents/]},
        cpp: {all: [/kFloorCents\s*=/, /kCeilingCents\s*=/, /\b422\b/, /floor_cents/]},
      },
    },
    {
      id: 'move-limit',
      title: 'A move past the limit is 409 with the bound',
      detail:
        'A change of more than `MAX_MOVE_BP` (20 %) from the current price answers **409** with `bound_cents`, the furthest price the limit allows in that direction; nothing is published. The starter publishes any jump it receives.',
      match: {
        python: {all: [/MAX_MOVE_BP\s*=/, /\b409\b/, /bound_cents/], order: [/MAX_MOVE_BP/, /store\.publish\(/]},
        typescript: {all: [/MAX_MOVE_BP\s*=/, /\b409\b/, /bound_cents/]},
        go: {all: [/maxMoveBP\s*=/, /StatusConflict|\b409\b/, /bound_cents/]},
        scala: {all: [/MaxMoveBp\s*=/, /Conflict|\b409\b/, /bound_cents/]},
        cpp: {all: [/kMaxMoveBp\s*=/, /\b409\b/, /bound_cents/]},
      },
    },
    {
      id: 'reason-required',
      title: 'A blank reason is 400',
      detail:
        'A change whose `reason` is empty or only spaces answers **400** and publishes nothing: every price in the audit trail carries why it moved. The starter publishes it.',
      match: {
        python: {all: [/reason\.strip\(\)|reason\.isspace\(\)/, /\b400\b/]},
        typescript: {all: [/reason\.trim\(\)|reason\s*===\s*''/, /\b400\b/]},
        go: {all: [/strings\.TrimSpace\([^)\n]*Reason\)|Reason\s*==\s*""/]},
        scala: {all: [/reason\.trim\.isEmpty|reason\.isBlank|reason\.trim\(\)\.isEmpty/, /BadRequest|\b400\b/]},
        cpp: {all: [/reason\.find_first_not_of\(|reason\.empty\(\)/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from pydantic import BaseModel

from pricing import store  # get_sku, publish

app = FastAPI()


class PriceChange(BaseModel):
    sku: str
    price_cents: int
    reason: str


def moved_bp(previous_cents: int, price_cents: int) -> int:
    """The change in basis points of the previous price (100 bp = 1 %)."""
    return abs(price_cents - previous_cents) * 10_000 // previous_cents


@app.post("/v1/prices")
def set_price(body: PriceChange) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    row = store.publish(body.sku, body.price_cents, body.reason, "operator")
    return {
        "sku": row["sku"],
        "price_cents": row["price_cents"],
        "previous_price_cents": row["previous_price_cents"],
        "moved_bp": moved_bp(row["previous_price_cents"], row["price_cents"]),
        "source": row["source"],
        "updated_at": row["updated_at"],
    }
`,
      solution: `from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from pricing import store  # get_sku, publish

app = FastAPI()

FLOOR_CENTS = 50
CEILING_CENTS = 500_000
MAX_MOVE_BP = 2000


class PriceChange(BaseModel):
    sku: str
    price_cents: int
    reason: str


def moved_bp(previous_cents: int, price_cents: int) -> int:
    """The change in basis points of the previous price (100 bp = 1 %)."""
    return abs(price_cents - previous_cents) * 10_000 // previous_cents


def move_bound(current_cents: int, price_cents: int) -> int:
    """The furthest price one change may reach from current_cents towards price_cents, inside the floor and the ceiling."""
    delta = current_cents * MAX_MOVE_BP // 10_000
    bound = current_cents + delta if price_cents >= current_cents else current_cents - delta
    return min(max(bound, FLOOR_CENTS), CEILING_CENTS)


@app.post("/v1/prices")
def set_price(body: PriceChange) -> JSONResponse:
    if not body.reason.strip():
        return JSONResponse({"error": "reason is required"}, status_code=400)
    current = store.get_sku(body.sku)
    if current is None:
        # A typo must not become a price row the storefront serves.
        return JSONResponse({"error": f"unknown sku {body.sku}"}, status_code=404)
    if not FLOOR_CENTS <= body.price_cents <= CEILING_CENTS:
        return JSONResponse(
            {"error": "price outside the floor and the ceiling", "floor_cents": FLOOR_CENTS, "ceiling_cents": CEILING_CENTS},
            status_code=422,
        )
    if moved_bp(current["price_cents"], body.price_cents) > MAX_MOVE_BP:
        return JSONResponse(
            {
                "error": "change exceeds the per-change limit",
                "limit_bp": MAX_MOVE_BP,
                "bound_cents": move_bound(current["price_cents"], body.price_cents),
            },
            status_code=409,
        )
    row = store.publish(body.sku, body.price_cents, body.reason, "operator")
    return JSONResponse(
        {
            "sku": row["sku"],
            "price_cents": row["price_cents"],
            "previous_price_cents": row["previous_price_cents"],
            "moved_bp": moved_bp(row["previous_price_cents"], row["price_cents"]),
            "source": row["source"],
            "updated_at": row["updated_at"],
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Row, getSku, publish} from 'pricing/store';

export const app = Fastify();

interface PriceChange {
  sku: string;
  price_cents: number;
  reason: string;
}

/** The change in basis points of the previous price (100 bp = 1 %). */
const movedBp = (previousCents: number, priceCents: number): number =>
  Math.floor((Math.abs(priceCents - previousCents) * 10_000) / previousCents);

const priceResponse = (row: Row) => ({
  sku: row.sku,
  price_cents: row.price_cents,
  previous_price_cents: row.previous_price_cents,
  moved_bp: movedBp(row.previous_price_cents, row.price_cents),
  source: row.source,
  updated_at: row.updated_at,
});

app.post('/v1/prices', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as PriceChange;
  const row = await publish(body.sku, body.price_cents, body.reason, 'operator');
  return priceResponse(row);
});
`,
      solution: `import Fastify from 'fastify';

import {type Row, getSku, publish} from 'pricing/store';

export const app = Fastify();

export const FLOOR_CENTS = 50;
export const CEILING_CENTS = 500_000;
export const MAX_MOVE_BP = 2000;

interface PriceChange {
  sku: string;
  price_cents: number;
  reason: string;
}

/** The change in basis points of the previous price (100 bp = 1 %). */
const movedBp = (previousCents: number, priceCents: number): number =>
  Math.floor((Math.abs(priceCents - previousCents) * 10_000) / previousCents);

/** The furthest price one change may reach from currentCents towards priceCents, inside the floor and the ceiling. */
function moveBound(currentCents: number, priceCents: number): number {
  const delta = Math.floor((currentCents * MAX_MOVE_BP) / 10_000);
  const bound = priceCents >= currentCents ? currentCents + delta : currentCents - delta;
  return Math.min(Math.max(bound, FLOOR_CENTS), CEILING_CENTS);
}

const priceResponse = (row: Row) => ({
  sku: row.sku,
  price_cents: row.price_cents,
  previous_price_cents: row.previous_price_cents,
  moved_bp: movedBp(row.previous_price_cents, row.price_cents),
  source: row.source,
  updated_at: row.updated_at,
});

app.post('/v1/prices', async (request, reply) => {
  const body = request.body as PriceChange;
  if (typeof body.reason !== 'string' || body.reason.trim() === '') return reply.code(400).send({error: 'reason is required'});
  const current = await getSku(body.sku);
  // A typo must not become a price row the storefront serves.
  if (current === null) return reply.code(404).send({error: \`unknown sku \${body.sku}\`});
  if (body.price_cents < FLOOR_CENTS || body.price_cents > CEILING_CENTS) {
    return reply
      .code(422)
      .send({error: 'price outside the floor and the ceiling', floor_cents: FLOOR_CENTS, ceiling_cents: CEILING_CENTS});
  }
  if (movedBp(current.price_cents, body.price_cents) > MAX_MOVE_BP) {
    return reply.code(409).send({
      error: 'change exceeds the per-change limit',
      limit_bp: MAX_MOVE_BP,
      bound_cents: moveBound(current.price_cents, body.price_cents),
    });
  }
  const row = await publish(body.sku, body.price_cents, body.reason, 'operator');
  return priceResponse(row);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"pricing/store" // store.GetSKU, store.Publish
)

type priceChange struct {
	SKU        string \`json:"sku"\`
	PriceCents int64  \`json:"price_cents"\`
	Reason     string \`json:"reason"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// movedBP is the change in basis points of the previous price (100 bp = 1 %).
func movedBP(previousCents, priceCents int64) int64 {
	delta := priceCents - previousCents
	if delta < 0 {
		delta = -delta
	}
	return delta * 10_000 / previousCents
}

func priceResponse(row *store.Row) map[string]any {
	return map[string]any{
		"sku": row.SKU, "price_cents": row.PriceCents, "previous_price_cents": row.PreviousPriceCents,
		"moved_bp": movedBP(row.PreviousPriceCents, row.PriceCents), "source": row.Source, "updated_at": row.UpdatedAt,
	}
}

func setPrice(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body priceChange
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	row := store.Publish(r.Context(), body.SKU, body.PriceCents, body.Reason, "operator")
	writeJSON(rw, http.StatusOK, priceResponse(row))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/prices", setPrice)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"pricing/store" // store.GetSKU, store.Publish
)

const (
	floorCents   = 50
	ceilingCents = 500_000
	maxMoveBP    = 2000
)

type priceChange struct {
	SKU        string \`json:"sku"\`
	PriceCents int64  \`json:"price_cents"\`
	Reason     string \`json:"reason"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// movedBP is the change in basis points of the previous price (100 bp = 1 %).
func movedBP(previousCents, priceCents int64) int64 {
	delta := priceCents - previousCents
	if delta < 0 {
		delta = -delta
	}
	return delta * 10_000 / previousCents
}

// moveBound is the furthest price one change may reach from currentCents towards priceCents,
// inside the floor and the ceiling.
func moveBound(currentCents, priceCents int64) int64 {
	delta := currentCents * maxMoveBP / 10_000
	bound := currentCents - delta
	if priceCents >= currentCents {
		bound = currentCents + delta
	}
	return min(max(bound, floorCents), ceilingCents)
}

func priceResponse(row *store.Row) map[string]any {
	return map[string]any{
		"sku": row.SKU, "price_cents": row.PriceCents, "previous_price_cents": row.PreviousPriceCents,
		"moved_bp": movedBP(row.PreviousPriceCents, row.PriceCents), "source": row.Source, "updated_at": row.UpdatedAt,
	}
}

func setPrice(rw http.ResponseWriter, r *http.Request) {
	var body priceChange
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "reason is required"})
		return
	}
	current := store.GetSKU(r.Context(), body.SKU)
	if current == nil {
		// A typo must not become a price row the storefront serves.
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown sku " + body.SKU})
		return
	}
	if body.PriceCents < floorCents || body.PriceCents > ceilingCents {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{
			"error": "price outside the floor and the ceiling", "floor_cents": floorCents, "ceiling_cents": ceilingCents,
		})
		return
	}
	if movedBP(current.PriceCents, body.PriceCents) > maxMoveBP {
		writeJSON(rw, http.StatusConflict, map[string]any{
			"error": "change exceeds the per-change limit", "limit_bp": maxMoveBP, "bound_cents": moveBound(current.PriceCents, body.PriceCents),
		})
		return
	}
	row := store.Publish(r.Context(), body.SKU, body.PriceCents, body.Reason, "operator")
	writeJSON(rw, http.StatusOK, priceResponse(row))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/prices", setPrice)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import pricing.Store // Store.getSku, Store.publish

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The change in basis points of the previous price (100 bp = 1 %). */
  private def movedBp(previousCents: Long, priceCents: Long): Long = math.abs(priceCents - previousCents) * 10000 / previousCents

  private def priceResponse(row: Store.Row): JsObject = JsObject(
    "sku" -> JsString(row.sku), "price_cents" -> JsNumber(row.priceCents), "previous_price_cents" -> JsNumber(row.previousPriceCents),
    "moved_bp" -> JsNumber(movedBp(row.previousPriceCents, row.priceCents)), "source" -> JsString(row.source),
    "updated_at" -> JsNumber(row.updatedAt))

  val route: Route = path("v1" / "prices") {
    post {
      entity(as[String]) { raw =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val fields = raw.parseJson.asJsObject.fields
        val sku = fields.get("sku").collect { case JsString(s) => s }.getOrElse("")
        val priceCents = fields.get("price_cents").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
        val reason = fields.get("reason").collect { case JsString(s) => s }.getOrElse("")
        val row = Store.publish(sku, priceCents, reason, "operator")
        complete(json(StatusCodes.OK, priceResponse(row)))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import pricing.Store // Store.getSku, Store.publish

object Api {
  val FloorCents = 50L
  val CeilingCents = 500000L
  val MaxMoveBp = 2000L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String, extra: (String, JsValue)*): HttpResponse =
    json(status, JsObject(("error" -> JsString(message)) +: extra: _*))

  /** The change in basis points of the previous price (100 bp = 1 %). */
  private def movedBp(previousCents: Long, priceCents: Long): Long = math.abs(priceCents - previousCents) * 10000 / previousCents

  /** The furthest price one change may reach from currentCents towards priceCents, inside the floor and the ceiling. */
  private def moveBound(currentCents: Long, priceCents: Long): Long = {
    val delta = currentCents * MaxMoveBp / 10000
    val bound = if (priceCents >= currentCents) currentCents + delta else currentCents - delta
    math.min(math.max(bound, FloorCents), CeilingCents)
  }

  private def priceResponse(row: Store.Row): JsObject = JsObject(
    "sku" -> JsString(row.sku), "price_cents" -> JsNumber(row.priceCents), "previous_price_cents" -> JsNumber(row.previousPriceCents),
    "moved_bp" -> JsNumber(movedBp(row.previousPriceCents, row.priceCents)), "source" -> JsString(row.source),
    "updated_at" -> JsNumber(row.updatedAt))

  val route: Route = path("v1" / "prices") {
    post {
      entity(as[String]) { raw =>
        val fields = raw.parseJson.asJsObject.fields
        val sku = fields.get("sku").collect { case JsString(s) => s }.getOrElse("")
        val priceCents = fields.get("price_cents").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
        val reason = fields.get("reason").collect { case JsString(s) => s }.getOrElse("")
        if (reason.trim.isEmpty) complete(error(StatusCodes.BadRequest, "reason is required"))
        else
          Store.getSku(sku) match {
            // A typo must not become a price row the storefront serves.
            case None => complete(error(StatusCodes.NotFound, s"unknown sku $sku"))
            case Some(_) if priceCents < FloorCents || priceCents > CeilingCents =>
              complete(error(StatusCodes.UnprocessableEntity, "price outside the floor and the ceiling",
                "floor_cents" -> JsNumber(FloorCents), "ceiling_cents" -> JsNumber(CeilingCents)))
            case Some(current) if movedBp(current.priceCents, priceCents) > MaxMoveBp =>
              complete(error(StatusCodes.Conflict, "change exceeds the per-change limit",
                "limit_bp" -> JsNumber(MaxMoveBp), "bound_cents" -> JsNumber(moveBound(current.priceCents, priceCents))))
            case Some(_) =>
              val row = Store.publish(sku, priceCents, reason, "operator")
              complete(json(StatusCodes.OK, priceResponse(row)))
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

#include "pricing/store.h"  // store::getSku, store::publish

using json = nlohmann::json;

// The change in basis points of the previous price (100 bp = 1 %).
long long movedBp(long long previous_cents, long long price_cents) {
  const long long delta = price_cents > previous_cents ? price_cents - previous_cents : previous_cents - price_cents;
  return delta * 10000 / previous_cents;
}

json priceResponse(const store::Row& row) {
  return json{{"sku", row.sku},
              {"price_cents", row.price_cents},
              {"previous_price_cents", row.previous_price_cents},
              {"moved_bp", movedBp(row.previous_price_cents, row.price_cents)},
              {"source", row.source},
              {"updated_at", row.updated_at}};
}

void set_price(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  const store::Row row =
      store::publish(body.value("sku", ""), body.value("price_cents", 0LL), body.value("reason", ""), "operator");
  res.set_content(priceResponse(row).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/prices", set_price); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

#include "pricing/store.h"  // store::getSku, store::publish

using json = nlohmann::json;

constexpr long long kFloorCents = 50;
constexpr long long kCeilingCents = 500000;
constexpr long long kMaxMoveBp = 2000;

// The change in basis points of the previous price (100 bp = 1 %).
long long movedBp(long long previous_cents, long long price_cents) {
  const long long delta = price_cents > previous_cents ? price_cents - previous_cents : previous_cents - price_cents;
  return delta * 10000 / previous_cents;
}

// The furthest price one change may reach from current_cents towards price_cents, inside the floor
// and the ceiling.
long long moveBound(long long current_cents, long long price_cents) {
  const long long delta = current_cents * kMaxMoveBp / 10000;
  const long long bound = price_cents >= current_cents ? current_cents + delta : current_cents - delta;
  return std::min(std::max(bound, kFloorCents), kCeilingCents);
}

json priceResponse(const store::Row& row) {
  return json{{"sku", row.sku},
              {"price_cents", row.price_cents},
              {"previous_price_cents", row.previous_price_cents},
              {"moved_bp", movedBp(row.previous_price_cents, row.price_cents)},
              {"source", row.source},
              {"updated_at", row.updated_at}};
}

void reject(httplib::Response& res, int status, json body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void set_price(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body);
  const std::string sku = body.value("sku", "");
  const long long price_cents = body.value("price_cents", 0LL);
  const std::string reason = body.value("reason", "");
  if (reason.find_first_not_of(" \\t\\n") == std::string::npos) return reject(res, 400, json{{"error", "reason is required"}});
  const auto current = store::getSku(sku);
  // A typo must not become a price row the storefront serves.
  if (!current) return reject(res, 404, json{{"error", "unknown sku " + sku}});
  if (price_cents < kFloorCents || price_cents > kCeilingCents) {
    return reject(res, 422, json{{"error", "price outside the floor and the ceiling"}, {"floor_cents", kFloorCents}, {"ceiling_cents", kCeilingCents}});
  }
  if (movedBp(current->price_cents, price_cents) > kMaxMoveBp) {
    return reject(res, 409, json{{"error", "change exceeds the per-change limit"},
                                 {"limit_bp", kMaxMoveBp},
                                 {"bound_cents", moveBound(current->price_cents, price_cents)}});
  }
  const store::Row row = store::publish(sku, price_cents, reason, "operator");
  res.set_content(priceResponse(row).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/prices", set_price); }
`,
    },
  },
  harness: {
    python: `from pricing import store


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, sku="SKU-1", price_cents=1100, reason="weekend promo"):
    return await c.post("/v1/prices", json={"sku": sku, "price_cents": price_cents, "reason": reason})


async def check_route(ctx):
    store.seed("SKU-1", 1000)
    async with _api(ctx) as c:
        r = await _post(c)
    assert r.status_code == 200, f"POST /v1/prices answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("price_cents") == 1100 and body.get("previous_price_cents") == 1000, f"a change from 1000 to 1100 answered {body}, expected price_cents 1100 and previous_price_cents 1000"
    assert body.get("moved_bp") == 1000, f"a 10 % change answered moved_bp {body.get('moved_bp')}, expected 1000"
    row = store.get_sku("SKU-1")
    assert row["price_cents"] == 1100 and row["source"] == "operator", f"the store holds {row}, expected 1100 published by the operator"


async def check_known_sku(ctx):
    store.seed("SKU-1", 1000)
    async with _api(ctx) as c:
        r = await _post(c, sku="SKU-404")
        assert r.status_code == 404, f"a change for SKU-404, which does not exist, answered {r.status_code}: {r.text}, expected 404"
        assert store.get_sku("SKU-404") is None, f"the unknown sku now has a price row {store.get_sku('SKU-404')}: a typo became a price the storefront serves"
        r = await _post(c)
    assert r.status_code == 200, f"a change for the known SKU-1 answered {r.status_code}: {r.text}"


async def check_bounds(ctx):
    store.seed("SKU-1", 1000)
    store.seed("SKU-2", 480_000)
    store.seed("SKU-3", 55)
    async with _api(ctx) as c:
        for sku, price, why in (("SKU-1", 0, "a price of 0"), ("SKU-2", 520_000, "520000, above the ceiling"), ("SKU-3", 45, "45, below the floor")):
            r = await _post(c, sku=sku, price_cents=price)
            assert r.status_code == 422, f"{why} for {sku} answered {r.status_code}: {r.text}, expected 422"
            body = r.json()
            assert body.get("floor_cents") == 50 and body.get("ceiling_cents") == 500_000, f"the 422 must name floor_cents 50 and ceiling_cents 500000, got {body}"
        assert [store.get_sku(s)["price_cents"] for s in ("SKU-1", "SKU-2", "SKU-3")] == [1000, 480_000, 55], "a refused price was published anyway"
        r = await _post(c, price_cents=1100)
    assert r.status_code == 200, f"a price inside the bounds answered {r.status_code}: {r.text}"


async def check_move_limit(ctx):
    store.seed("SKU-1", 1000)
    async with _api(ctx) as c:
        r = await _post(c, price_cents=1300)
        assert r.status_code == 409, f"a 30 % rise from 1000 to 1300 answered {r.status_code}: {r.text}, expected 409"
        assert r.json().get("bound_cents") == 1200, f"the 409 must carry bound_cents 1200 (1000 + 20 %), got {r.json()}"
        assert store.get_sku("SKU-1")["price_cents"] == 1000, f"the refused change was published: {store.get_sku('SKU-1')}"
        r = await _post(c, price_cents=1200)
        assert r.status_code == 200, f"a change of exactly MAX_MOVE_BP (1000 to 1200) answered {r.status_code}: {r.text}"
        r = await _post(c, price_cents=900)
    assert r.status_code == 409, f"a 25 % cut from 1200 to 900 answered {r.status_code}: {r.text}, expected 409"
    assert r.json().get("bound_cents") == 960, f"a cut is bounded below: expected bound_cents 960 (1200 - 20 %), got {r.json()}"


async def check_reason_required(ctx):
    store.seed("SKU-1", 1000)
    async with _api(ctx) as c:
        for reason in ("", "   "):
            r = await _post(c, reason=reason)
            assert r.status_code == 400, f"a change with reason {reason!r} answered {r.status_code}: {r.text}, expected 400"
        assert store.get_sku("SKU-1")["price_cents"] == 1000, f"a change with no reason was published: {store.get_sku('SKU-1')}"
        r = await _post(c, reason="competitor match")
    assert r.status_code == 200, f"a change with a reason answered {r.status_code}: {r.text}"
    assert store.get_sku("SKU-1")["reason"] == "competitor match", f"the row keeps reason {store.get_sku('SKU-1')['reason']!r}"
`,
    typescript: `function api(ctx) {
  const store = ctx.load('/support/pricing/store.ts');
  return {c: ctx.client(ctx.load('api').app), store};
}

const post = (c, sku = 'SKU-1', price_cents = 1100, reason = 'weekend promo') =>
  c.post('/v1/prices', {json: {sku, price_cents, reason}});

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  await store.seed('SKU-1', 1000);
  const r = await post(c);
  assert.equal(r.status, 200, \`POST /v1/prices answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.price_cents === 1100 && body.previous_price_cents === 1000, \`a change from 1000 to 1100 answered \${r.text}, expected price_cents 1100 and previous_price_cents 1000\`);
  assert.equal(body.moved_bp, 1000, \`a 10 % change answered moved_bp \${body.moved_bp}, expected 1000\`);
  const row = await store.getSku('SKU-1');
  assert(row.price_cents === 1100 && row.source === 'operator', \`the store holds \${JSON.stringify(row)}, expected 1100 published by the operator\`);
}

export async function check_known_sku(ctx) {
  const {c, store} = api(ctx);
  await store.seed('SKU-1', 1000);
  let r = await post(c, 'SKU-404');
  assert.equal(r.status, 404, \`a change for SKU-404, which does not exist, answered \${r.status}: \${r.text}, expected 404\`);
  const phantom = await store.getSku('SKU-404');
  assert.equal(phantom, null, \`the unknown sku now has a price row \${JSON.stringify(phantom)}: a typo became a price the storefront serves\`);
  r = await post(c);
  assert.equal(r.status, 200, \`a change for the known SKU-1 answered \${r.status}: \${r.text}\`);
}

export async function check_bounds(ctx) {
  const {c, store} = api(ctx);
  await store.seed('SKU-1', 1000);
  await store.seed('SKU-2', 480_000);
  await store.seed('SKU-3', 55);
  for (const [sku, price, why] of [['SKU-1', 0, 'a price of 0'], ['SKU-2', 520_000, '520000, above the ceiling'], ['SKU-3', 45, '45, below the floor']] as const) {
    const r = await post(c, sku, price);
    assert.equal(r.status, 422, \`\${why} for \${sku} answered \${r.status}: \${r.text}, expected 422\`);
    const body = r.json();
    assert(body.floor_cents === 50 && body.ceiling_cents === 500_000, \`the 422 must name floor_cents 50 and ceiling_cents 500000, got \${r.text}\`);
  }
  const prices = [];
  for (const sku of ['SKU-1', 'SKU-2', 'SKU-3']) prices.push((await store.getSku(sku)).price_cents);
  assert.deepStrictEqual(prices, [1000, 480_000, 55], 'a refused price was published anyway');
  const r = await post(c, 'SKU-1', 1100);
  assert.equal(r.status, 200, \`a price inside the bounds answered \${r.status}: \${r.text}\`);
}

export async function check_move_limit(ctx) {
  const {c, store} = api(ctx);
  await store.seed('SKU-1', 1000);
  let r = await post(c, 'SKU-1', 1300);
  assert.equal(r.status, 409, \`a 30 % rise from 1000 to 1300 answered \${r.status}: \${r.text}, expected 409\`);
  assert.equal(r.json().bound_cents, 1200, \`the 409 must carry bound_cents 1200 (1000 + 20 %), got \${r.text}\`);
  assert.equal((await store.getSku('SKU-1')).price_cents, 1000, 'the refused change was published');
  r = await post(c, 'SKU-1', 1200);
  assert.equal(r.status, 200, \`a change of exactly MAX_MOVE_BP (1000 to 1200) answered \${r.status}: \${r.text}\`);
  r = await post(c, 'SKU-1', 900);
  assert.equal(r.status, 409, \`a 25 % cut from 1200 to 900 answered \${r.status}: \${r.text}, expected 409\`);
  assert.equal(r.json().bound_cents, 960, \`a cut is bounded below: expected bound_cents 960 (1200 - 20 %), got \${r.text}\`);
}

export async function check_reason_required(ctx) {
  const {c, store} = api(ctx);
  await store.seed('SKU-1', 1000);
  for (const reason of ['', '   ']) {
    const r = await post(c, 'SKU-1', 1100, reason);
    assert.equal(r.status, 400, \`a change with reason \${JSON.stringify(reason)} answered \${r.status}: \${r.text}, expected 400\`);
  }
  assert.equal((await store.getSku('SKU-1')).price_cents, 1000, 'a change with no reason was published');
  const r = await post(c, 'SKU-1', 1100, 'competitor match');
  assert.equal(r.status, 200, \`a change with a reason answered \${r.status}: \${r.text}\`);
  assert.equal((await store.getSku('SKU-1')).reason, 'competitor match', 'the row must keep the reason');
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"pricing/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

type priceReply struct {
	PriceCents         int64 \`json:"price_cents"\`
	PreviousPriceCents int64 \`json:"previous_price_cents"\`
	MovedBP            int64 \`json:"moved_bp"\`
	BoundCents         int64 \`json:"bound_cents"\`
	FloorCents         int64 \`json:"floor_cents"\`
	CeilingCents       int64 \`json:"ceiling_cents"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func postPrice(c *harness.HTTP, sku string, priceCents int64, reason string) (*harness.Response, priceReply) {
	r := c.Post("/v1/prices", map[string]any{"sku": sku, "price_cents": priceCents, "reason": reason})
	var body priceReply
	r.Decode(&body)
	return r, body
}

func priceOf(sku string) int64 {
	if row := store.GetSKU(apiBg, sku); row != nil {
		return row.PriceCents
	}
	return 0
}

func CheckRoute(ctx *harness.Ctx) {
	store.Seed(apiBg, "SKU-1", 1000)
	r, body := postPrice(api(ctx), "SKU-1", 1100, "weekend promo")
	ctx.Equal(r.Status, 200, "POST /v1/prices (%s)", r.Text())
	ctx.Assert(body.PriceCents == 1100 && body.PreviousPriceCents == 1000, "a change from 1000 to 1100 answered %s, expected price_cents 1100 and previous_price_cents 1000", r.Text())
	ctx.Equal(body.MovedBP, 1000, "a 10 %% change; moved_bp")
	row := store.GetSKU(apiBg, "SKU-1")
	ctx.Assert(row.PriceCents == 1100 && row.Source == "operator", "the store holds %+v, expected 1100 published by the operator", row)
}

func CheckKnownSku(ctx *harness.Ctx) {
	store.Seed(apiBg, "SKU-1", 1000)
	c := api(ctx)
	r, _ := postPrice(c, "SKU-404", 1100, "weekend promo")
	ctx.Equal(r.Status, 404, "a change for SKU-404, which does not exist (%s)", r.Text())
	phantom := store.GetSKU(apiBg, "SKU-404")
	ctx.Assert(phantom == nil, "the unknown sku now has a price row %+v: a typo became a price the storefront serves", phantom)
	r, _ = postPrice(c, "SKU-1", 1100, "weekend promo")
	ctx.Equal(r.Status, 200, "a change for the known SKU-1 (%s)", r.Text())
}

func CheckBounds(ctx *harness.Ctx) {
	store.Seed(apiBg, "SKU-1", 1000)
	store.Seed(apiBg, "SKU-2", 480_000)
	store.Seed(apiBg, "SKU-3", 55)
	c := api(ctx)
	cases := []struct {
		sku   string
		price int64
		why   string
	}{{"SKU-1", 0, "a price of 0"}, {"SKU-2", 520_000, "520000, above the ceiling"}, {"SKU-3", 45, "45, below the floor"}}
	for _, tc := range cases {
		r, body := postPrice(c, tc.sku, tc.price, "weekend promo")
		ctx.Equal(r.Status, 422, "%s for %s (%s)", tc.why, tc.sku, r.Text())
		ctx.Assert(body.FloorCents == 50 && body.CeilingCents == 500_000, "the 422 must name floor_cents 50 and ceiling_cents 500000, got %s", r.Text())
	}
	ctx.Equal([]int64{priceOf("SKU-1"), priceOf("SKU-2"), priceOf("SKU-3")}, []int64{1000, 480_000, 55}, "a refused price must not be published; the prices")
	r, _ := postPrice(c, "SKU-1", 1100, "weekend promo")
	ctx.Equal(r.Status, 200, "a price inside the bounds (%s)", r.Text())
}

func CheckMoveLimit(ctx *harness.Ctx) {
	store.Seed(apiBg, "SKU-1", 1000)
	c := api(ctx)
	r, body := postPrice(c, "SKU-1", 1300, "weekend promo")
	ctx.Equal(r.Status, 409, "a 30 %% rise from 1000 to 1300 (%s)", r.Text())
	ctx.Equal(body.BoundCents, 1200, "the 409 must carry bound_cents 1000 + 20 %%; bound_cents")
	ctx.Equal(priceOf("SKU-1"), 1000, "the refused change must not be published; the price")
	r, _ = postPrice(c, "SKU-1", 1200, "weekend promo")
	ctx.Equal(r.Status, 200, "a change of exactly MAX_MOVE_BP, 1000 to 1200 (%s)", r.Text())
	r, body = postPrice(c, "SKU-1", 900, "weekend promo")
	ctx.Equal(r.Status, 409, "a 25 %% cut from 1200 to 900 (%s)", r.Text())
	ctx.Equal(body.BoundCents, 960, "a cut is bounded below (1200 - 20 %%); bound_cents")
}

func CheckReasonRequired(ctx *harness.Ctx) {
	store.Seed(apiBg, "SKU-1", 1000)
	c := api(ctx)
	for _, reason := range []string{"", "   "} {
		r, _ := postPrice(c, "SKU-1", 1100, reason)
		ctx.Equal(r.Status, 400, "a change with reason %q (%s)", reason, r.Text())
	}
	ctx.Equal(priceOf("SKU-1"), 1000, "a change with no reason must not be published; the price")
	r, _ := postPrice(c, "SKU-1", 1100, "competitor match")
	ctx.Equal(r.Status, 200, "a change with a reason (%s)", r.Text())
	ctx.Equal(store.GetSKU(apiBg, "SKU-1").Reason, "competitor match", "the row's reason")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response postPrice(harness::HTTP& c, const std::string& sku, long long price_cents, const std::string& reason = "weekend promo") {
  const nlohmann::json body{{"sku", sku}, {"price_cents", price_cents}, {"reason", reason}};
  return c.Post("/v1/prices", body.dump(), "Content-Type", "application/json");
}

long long field(const harness::Response& r, const std::string& name) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() && body.contains(name) && body[name].is_number() ? body[name].get<long long>() : -1;
}

long long priceOf(const std::string& sku) {
  const auto row = store::getSku(sku);
  return row ? row->price_cents : 0;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  auto c = api(ctx);
  const auto r = postPrice(c, "SKU-1", 1100);
  ctx.Equal(r.Status, 200, "POST /v1/prices (%s)", r.Text());
  ctx.Assert(field(r, "price_cents") == 1100 && field(r, "previous_price_cents") == 1000, "a change from 1000 to 1100 answered %s, expected price_cents 1100 and previous_price_cents 1000", r.Text());
  ctx.Equal(field(r, "moved_bp"), 1000, "a 10 %% change; moved_bp");
  const auto row = store::getSku("SKU-1");
  ctx.Assert(row && row->price_cents == 1100 && row->source == "operator", "the store holds price %d from %q, expected 1100 published by the operator", row ? row->price_cents : 0, row ? row->source : "");
}

void CheckKnownSku(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  auto c = api(ctx);
  auto r = postPrice(c, "SKU-404", 1100);
  ctx.Equal(r.Status, 404, "a change for SKU-404, which does not exist (%s)", r.Text());
  ctx.Assert(!store::getSku("SKU-404"), "the unknown sku now has a price row: a typo became a price the storefront serves");
  r = postPrice(c, "SKU-1", 1100);
  ctx.Equal(r.Status, 200, "a change for the known SKU-1 (%s)", r.Text());
}

void CheckBounds(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  store::seed("SKU-2", 480000);
  store::seed("SKU-3", 55);
  auto c = api(ctx);
  struct Case {
    std::string sku;
    long long price;
    std::string why;
  };
  for (const Case& tc : std::vector<Case>{{"SKU-1", 0, "a price of 0"}, {"SKU-2", 520000, "520000, above the ceiling"}, {"SKU-3", 45, "45, below the floor"}}) {
    const auto r = postPrice(c, tc.sku, tc.price);
    ctx.Equal(r.Status, 422, "%s for %s (%s)", tc.why, tc.sku, r.Text());
    ctx.Assert(field(r, "floor_cents") == 50 && field(r, "ceiling_cents") == 500000, "the 422 must name floor_cents 50 and ceiling_cents 500000, got %s", r.Text());
  }
  ctx.Equal(std::vector<long long>{priceOf("SKU-1"), priceOf("SKU-2"), priceOf("SKU-3")}, std::vector<long long>{1000, 480000, 55}, "a refused price must not be published; the prices");
  const auto r = postPrice(c, "SKU-1", 1100);
  ctx.Equal(r.Status, 200, "a price inside the bounds (%s)", r.Text());
}

void CheckMoveLimit(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  auto c = api(ctx);
  auto r = postPrice(c, "SKU-1", 1300);
  ctx.Equal(r.Status, 409, "a 30 %% rise from 1000 to 1300 (%s)", r.Text());
  ctx.Equal(field(r, "bound_cents"), 1200, "the 409 must carry bound_cents 1000 + 20 %%; bound_cents");
  ctx.Equal(priceOf("SKU-1"), 1000, "the refused change must not be published; the price");
  r = postPrice(c, "SKU-1", 1200);
  ctx.Equal(r.Status, 200, "a change of exactly MAX_MOVE_BP, 1000 to 1200 (%s)", r.Text());
  r = postPrice(c, "SKU-1", 900);
  ctx.Equal(r.Status, 409, "a 25 %% cut from 1200 to 900 (%s)", r.Text());
  ctx.Equal(field(r, "bound_cents"), 960, "a cut is bounded below (1200 - 20 %%); bound_cents");
}

void CheckReasonRequired(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  auto c = api(ctx);
  for (const std::string reason : {"", "   "}) {
    const auto r = postPrice(c, "SKU-1", 1100, reason);
    ctx.Equal(r.Status, 400, "a change with reason %q (%s)", reason, r.Text());
  }
  ctx.Equal(priceOf("SKU-1"), 1000, "a change with no reason must not be published; the price");
  const auto r = postPrice(c, "SKU-1", 1100, "competitor match");
  ctx.Equal(r.Status, 200, "a change with a reason (%s)", r.Text());
  ctx.Equal(store::getSku("SKU-1")->reason, "competitor match", "the row's reason");
}
`,
  },
  hints: [
    'Post a price for `SKU-404` and read it back: the storefront now has a price for a product that does not exist. Post `0` for a real sku and it sells for free.',
    '`store.publish` writes whatever it is handed and creates a row for a new sku. The handler never reads the current price, so it has nothing to compare a floor, a ceiling or a 20 % move against.',
    'Answer 400 on a blank reason, call `store.get_sku` (404 on None), 422 outside `FLOOR_CENTS`..`CEILING_CENTS`, 409 when `moved_bp(current, target) > MAX_MOVE_BP` with `bound_cents = current ± current * MAX_MOVE_BP // 10_000`, clamped; publish last.',
  ],
  debrief: `Every refusal runs before the write, and that order is the fix: the store's publish creates rows and accepts any number, so the handler in front of it is the only place a bad change can stop. The lookup comes first because the floor, the ceiling and the move limit are all relative to a sku that exists, and \`bound_cents\` turns a 409 into a retry the caller can compute. A per-change limit still lets ten small changes compound within an hour; step 2 replaces it with a window budget. Pricing services in production load floors and ceilings per category from configuration, compare a new price with unit cost, and send changes above a threshold to a second approver.`,
};
