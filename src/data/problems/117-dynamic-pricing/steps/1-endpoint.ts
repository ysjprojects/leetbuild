import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/prices: guardrails around every change',
  concept: 'http',
  file: 'api',
  focus: ['api', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and publishes a price. It compiles, it serves the demo, and it hides three production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/prices\` with body \`{"sku": "SKU-1", "price_cents": 1299, "reason": "weekend promo"}\`.

- The caller is authenticated by \`X-Caller-Id\`; a missing or unknown caller is **401**.
- \`sku\` names an sku that already exists in the price store. An unknown sku is **404**, and it must
  never create a row: a phantom sku is a price nobody can buy and a row every catalog query has to
  account for.
- \`price_cents\` is the **target price** in integer cents — not a multiplier. The caller states where
  the price should land; the platform decides whether it may. A non-integer is **400**.
- The absolute guardrails always apply: a target below \`FLOOR_CENTS\` (50) or above \`CEILING_CENTS\`
  (500000) is **422**, and the response names the floor and the ceiling that rejected it.
- The move limit always applies: the sku may move at most \`MAX_MOVE_BP\` (2000, i.e. 20 %) per hour
  window from its current published price. A larger move is **409**, and the response carries
  \`bound_cents\` — the furthest price the window still allows, computed from the current price and
  the remaining headroom, never a hardcoded constant.
- \`reason\` is a non-empty string (**400** otherwise); it is the audit trail's only explanation of
  the change.
- The response returns the published row: \`price_cents\`, \`previous_price_cents\`, \`moved_bp\`,
  \`headroom_bp\`, \`source\` and \`updated_at\`, so the caller can log what actually shipped.

**Failure mode the checks target.** The draft takes a \`multiplier\` from the request body and applies
it to whatever price it finds, so a client bug that sends \`4.0\` ships a 400 percent spike, and a
multiplier of \`0\` drives the price to zero — the floor is the only thing between a typo and a free
product. It also upserts the sku it was given, so a mistyped sku silently becomes a real price row
that the storefront will happily serve. The third flaw is quieter: a change limit the handler never
computes is a rejection that cannot explain itself, so the caller that gets a 409 is never told the
bound it has to stay under, and its next retry repeats the same oversized change.`,
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
      {from: 'Price store', to: 'Pricing API', label: 'current price / unknown sku', kind: 'reply'},
      {from: 'Pricing API', to: 'Pricing API', label: 'floor · ceiling · window bound', kind: 'sync'},
      {from: 'Pricing API', to: 'Price store', label: 'publish(price, reason, source)', kind: 'async'},
      {
        from: 'Pricing API',
        to: 'Operator console',
        label: '200 {price_cents, moved_bp, headroom_bp} · 404 · 409 {bound_cents} · 422',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/prices',
      detail: 'Register the publish route on `POST /v1/prices`.',
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
      title: 'Rejects an unknown sku with 404 and writes nothing',
      detail:
        'The sku is looked up before anything is written; an unknown sku is **404** and no row is created. The draft upserts whatever sku it was handed, so a typo becomes a phantom price row.',
      match: {
        python: {all: [/store\.get_sku\(/, /status_code\s*=\s*404/], none: [/store\.upsert/]},
        typescript: {all: [/store\.getSku\(/, /code\(\s*404\s*\)/], none: [/store\.upsert/]},
        go: {all: [/store\.GetSKU\(/, /StatusNotFound/], none: [/store\.Upsert/]},
        scala: {all: [/store\.getSku\(/, /StatusCodes\.NotFound/], none: [/store\.upsert/]},
        cpp: {all: [/store\.getSku\(/, /\b404\b/], none: [/store\.upsert/]},
      },
    },
    {
      id: 'bounds',
      title: 'Applies the absolute floor and ceiling',
      detail:
        'A target outside `FLOOR_CENTS`..`CEILING_CENTS` is **422** with the floor and the ceiling named in the body. The draft has neither bound, so a multiplier of zero publishes a free product.',
      match: {
        python: {all: [/FLOOR_CENTS/, /CEILING_CENTS/, /status_code\s*=\s*422/]},
        typescript: {all: [/FLOOR_CENTS/, /CEILING_CENTS/, /code\(\s*422\s*\)/]},
        go: {all: [/floorCents/, /ceilingCents/, /StatusUnprocessableEntity/]},
        scala: {all: [/FloorCents/, /CeilingCents/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kFloorCents/, /kCeilingCents/, /\b422\b/]},
      },
    },
    {
      id: 'window-limit',
      title: 'Rejects a move past the window limit with the computed bound',
      detail:
        'A move larger than `MAX_MOVE_BP` (20 %) of the current price is **409**, and the response carries `bound_cents` derived from the current price and the remaining headroom. The draft applies whatever it was handed and reports no bound.',
      match: {
        python: {all: [/MAX_MOVE_BP/, /status_code\s*=\s*409/, /bound_cents/]},
        typescript: {all: [/MAX_MOVE_BP/, /code\(\s*409\s*\)/, /bound_cents/]},
        go: {all: [/maxMoveBP/, /StatusConflict/, /bound_cents/]},
        scala: {all: [/MaxMoveBp/, /StatusCodes\.Conflict/, /bound_cents/]},
        cpp: {all: [/kMaxMoveBp/, /\b409\b/, /bound_cents/]},
      },
    },
    {
      id: 'target-price',
      title: 'Takes a target price, never a caller-supplied multiplier',
      detail:
        'The body carries `price_cents` and the handler publishes that target; there is no multiplier path at all. The draft multiplies the current price by a caller-supplied factor, which is how a 400 percent spike shipped.',
      match: {
        python: {all: [/body\.price_cents/], none: [/\bmultiplier\b/]},
        typescript: {all: [/body\.price_cents/], none: [/\bmultiplier\b/]},
        go: {all: [/body\.PriceCents/], none: [/\bmultiplier\b/i]},
        scala: {all: [/body\.price_cents/], none: [/\bmultiplier\b/]},
        cpp: {all: [/body\[\s*"price_cents"\s*\]/], none: [/\bmultiplier\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("priced")


class PriceRequest(BaseModel):
    sku: str
    multiplier: float
    reason: str


class PriceStore:
    def current_price(self, sku: str) -> int:
        """The sku's current price, or a house default for a sku nobody has priced."""
        raise NotImplementedError

    def upsert(self, sku: str, price_cents: int, reason: str) -> dict:
        """Write the sku's price, creating the row when the sku is unknown."""
        raise NotImplementedError


store = PriceStore()


@app.post("/v1/prices")
def propose(body: PriceRequest) -> JSONResponse:
    # TODO: this draft applies whatever multiplier the caller sends (a 400 percent spike shipped),
    # has no floor or ceiling so a price can be driven to zero, and upserts an unknown sku into a
    # phantom price row. Review all three.
    current = store.current_price(body.sku)
    price_cents = int(current * body.multiplier)
    row = store.upsert(body.sku, price_cents, body.reason)
    logger.info("price sku=%s multiplier=%s price_cents=%d", body.sku, body.multiplier, price_cents)
    return JSONResponse({"sku": body.sku, "price_cents": row["price_cents"]}, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("priced")

FLOOR_CENTS = 50
CEILING_CENTS = 500_000
MAX_MOVE_BP = 2000
WINDOW_S = 3600


class PriceRequest(BaseModel):
    sku: str
    price_cents: int
    reason: str


class PriceStore:
    def get_sku(self, sku: str) -> dict | None:
        """The sku's published row, or None when the sku does not exist."""
        raise NotImplementedError

    def publish(self, sku: str, price_cents: int, reason: str, source: str) -> dict:
        """Commit the new price and its audit row, returning the published row."""
        raise NotImplementedError


store = PriceStore()


def window_bound(current_cents: int, headroom_bp: int, direction: int) -> int:
    """The furthest price the remaining headroom allows, clamped by floor and ceiling."""
    delta = current_cents * headroom_bp // 10_000
    return min(max(current_cents + direction * delta, FLOOR_CENTS), CEILING_CENTS)


def moved_bp(current_cents: int, price_cents: int) -> int:
    return abs(price_cents - current_cents) * 10_000 // max(current_cents, 1)


@app.post("/v1/prices")
def propose(body: PriceRequest, caller: str | None = Header(default=None, alias="X-Caller-Id")) -> JSONResponse:
    if caller is None or caller == "":
        raise HTTPException(status_code=401, detail="missing X-Caller-Id")
    if body.reason.strip() == "":
        raise HTTPException(status_code=400, detail="reason is required")

    row = store.get_sku(body.sku)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown sku")
    current = int(row["price_cents"])

    if body.price_cents < FLOOR_CENTS or body.price_cents > CEILING_CENTS:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "price outside the absolute guardrails",
                "price_cents": body.price_cents,
                "floor_cents": FLOOR_CENTS,
                "ceiling_cents": CEILING_CENTS,
            },
        )

    direction = 1 if body.price_cents >= current else -1
    bound = window_bound(current, MAX_MOVE_BP, direction)
    if (direction > 0 and body.price_cents > bound) or (direction < 0 and body.price_cents < bound):
        raise HTTPException(
            status_code=409,
            detail={
                "error": "change exceeds the per-window limit",
                "limit_bp": MAX_MOVE_BP,
                "current_price_cents": current,
                "bound_cents": bound,
            },
        )

    moved = moved_bp(current, body.price_cents)
    published = store.publish(body.sku, body.price_cents, body.reason, source="operator")
    logger.info("publish sku=%s moved_bp=%d bound_cents=%d", body.sku, moved, bound)
    return JSONResponse(
        {
            "sku": body.sku,
            "price_cents": published["price_cents"],
            "previous_price_cents": current,
            "moved_bp": moved,
            "headroom_bp": MAX_MOVE_BP - moved,
            "source": published["source"],
            "updated_at": published["updated_at"],
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/prices: a model-generated draft that applies whatever multiplier the caller sends. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

interface PriceBody {
  sku: string;
  multiplier: number;
  reason: string;
}

app.post('/v1/prices', async (request, reply) => {
  // TODO: this draft applies whatever multiplier the caller sends (a 400 percent spike shipped),
  // has no floor or ceiling so a price can be driven to zero, and upserts an unknown sku into a
  // phantom price row. Review all three.
  const body = request.body as PriceBody;
  const current = await store.currentPrice(body.sku);
  const row = await store.upsert(body.sku, Math.round(current * body.multiplier), body.reason);
  request.log.info({sku: body.sku, multiplier: body.multiplier}, 'price set');
  return reply.code(200).send({sku: body.sku, price_cents: row.price_cents});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/prices: floor, ceiling and a computed per-window move bound around every change. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const FLOOR_CENTS = 50;
const CEILING_CENTS = 500_000;
const MAX_MOVE_BP = 2000;
const WINDOW_S = 3600;

interface PriceBody {
  sku: string;
  price_cents: number;
  reason: string;
}

/** The furthest price the remaining headroom allows, clamped by the floor and the ceiling. */
function windowBound(currentCents: number, headroomBp: number, direction: number): number {
  const delta = Math.floor((currentCents * headroomBp) / 10_000);
  return Math.min(Math.max(currentCents + direction * delta, FLOOR_CENTS), CEILING_CENTS);
}

function movedBp(currentCents: number, priceCents: number): number {
  return Math.floor((Math.abs(priceCents - currentCents) * 10_000) / Math.max(currentCents, 1));
}

app.post('/v1/prices', async (request, reply) => {
  const caller = request.headers['x-caller-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Caller-Id'});

  const body = request.body as Partial<PriceBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid body'});
  if (typeof body.reason !== 'string' || body.reason.trim() === '')
    return reply.code(400).send({error: 'reason is required'});
  if (typeof body.price_cents !== 'number' || !Number.isInteger(body.price_cents))
    return reply.code(400).send({error: 'price_cents must be an integer'});

  const row = await store.getSku(body.sku);
  if (row === null) return reply.code(404).send({error: 'unknown sku'});
  const current = row.price_cents;

  if (body.price_cents < FLOOR_CENTS || body.price_cents > CEILING_CENTS)
    return reply.code(422).send({
      error: 'price outside the absolute guardrails',
      price_cents: body.price_cents,
      floor_cents: FLOOR_CENTS,
      ceiling_cents: CEILING_CENTS,
    });

  const direction = body.price_cents >= current ? 1 : -1;
  const bound = windowBound(current, MAX_MOVE_BP, direction);
  if ((direction > 0 && body.price_cents > bound) || (direction < 0 && body.price_cents < bound))
    return reply.code(409).send({
      error: 'change exceeds the per-window limit',
      limit_bp: MAX_MOVE_BP,
      current_price_cents: current,
      bound_cents: bound,
    });

  const moved = movedBp(current, body.price_cents);
  const published = await store.publish(body.sku, body.price_cents, body.reason, 'operator');
  request.log.info({sku: body.sku, moved_bp: moved, bound_cents: bound}, 'published');
  return reply.code(200).send({
    sku: body.sku,
    price_cents: published.price_cents,
    previous_price_cents: current,
    moved_bp: moved,
    headroom_bp: MAX_MOVE_BP - moved,
    source: published.source,
    updated_at: published.updated_at,
  });
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

type PriceRequest struct {
	SKU        string  \`json:"sku"\`
	Multiplier float64 \`json:"multiplier"\`
	Reason     string  \`json:"reason"\`
}

type PriceStore struct{}

func (s *PriceStore) CurrentPrice(ctx context.Context, sku string) (int, error) {
	return 0, nil
}

func (s *PriceStore) Upsert(ctx context.Context, sku string, priceCents int, reason string) (int, error) {
	return priceCents, nil
}

var store = &PriceStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func propose(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft applies whatever multiplier the caller sends (a 400 percent spike shipped),
	// has no floor or ceiling so a price can be driven to zero, and upserts an unknown sku into a
	// phantom price row. Review all three.
	var body PriceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	current, _ := store.CurrentPrice(r.Context(), body.SKU)
	priceCents := int(float64(current) * body.Multiplier)
	published, _ := store.Upsert(r.Context(), body.SKU, priceCents, body.Reason)
	log.Printf("price sku=%s multiplier=%f price_cents=%d", body.SKU, body.Multiplier, priceCents)
	writeJSON(rw, http.StatusOK, map[string]any{"sku": body.SKU, "price_cents": published})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/prices", propose)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const (
	floorCents   = 50
	ceilingCents = 500000
	maxMoveBP    = 2000
	windowSecs   = 3600
)

var knownCallers = map[string]bool{"operator": true, "demand-model": true}

type PriceRequest struct {
	SKU        string \`json:"sku"\`
	PriceCents int    \`json:"price_cents"\`
	Reason     string \`json:"reason"\`
}

type PriceRow struct {
	PriceCents int    \`json:"price_cents"\`
	Source     string \`json:"source"\`
	UpdatedAt  string \`json:"updated_at"\`
}

type PriceStore struct{}

func (s *PriceStore) GetSKU(ctx context.Context, sku string) (*PriceRow, error) {
	return nil, nil
}

func (s *PriceStore) Publish(ctx context.Context, sku string, priceCents int, reason, source string) (*PriceRow, error) {
	return nil, nil
}

var store = &PriceStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// windowBound is the furthest price the remaining headroom allows, clamped by floor and ceiling.
func windowBound(currentCents, headroomBP, direction int) int {
	delta := currentCents * headroomBP / 10000
	bound := currentCents + direction*delta
	if bound < floorCents {
		return floorCents
	}
	if bound > ceilingCents {
		return ceilingCents
	}
	return bound
}

func movedBP(currentCents, priceCents int) int {
	diff := priceCents - currentCents
	if diff < 0 {
		diff = -diff
	}
	if currentCents < 1 {
		currentCents = 1
	}
	return diff * 10000 / currentCents
}

func propose(rw http.ResponseWriter, r *http.Request) {
	if !knownCallers[r.Header.Get("X-Caller-Id")] {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Caller-Id"})
		return
	}
	var body PriceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Reason == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "reason is required"})
		return
	}
	row, err := store.GetSKU(r.Context(), body.SKU)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if row == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown sku"})
		return
	}
	current := row.PriceCents
	if body.PriceCents < floorCents || body.PriceCents > ceilingCents {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{
			"error":         "price outside the absolute guardrails",
			"price_cents":   body.PriceCents,
			"floor_cents":   floorCents,
			"ceiling_cents": ceilingCents,
		})
		return
	}
	direction := 1
	if body.PriceCents < current {
		direction = -1
	}
	bound := windowBound(current, maxMoveBP, direction)
	if (direction > 0 && body.PriceCents > bound) || (direction < 0 && body.PriceCents < bound) {
		writeJSON(rw, http.StatusConflict, map[string]any{
			"error":               "change exceeds the per-window limit",
			"limit_bp":            maxMoveBP,
			"current_price_cents": current,
			"bound_cents":         bound,
		})
		return
	}
	moved := movedBP(current, body.PriceCents)
	published, err := store.Publish(r.Context(), body.SKU, body.PriceCents, body.Reason, "operator")
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("publish sku=%s moved_bp=%d bound_cents=%d", body.SKU, moved, bound)
	writeJSON(rw, http.StatusOK, map[string]any{
		"sku":                  body.SKU,
		"price_cents":          published.PriceCents,
		"previous_price_cents": current,
		"moved_bp":             moved,
		"headroom_bp":          maxMoveBP - moved,
		"source":               published.Source,
		"updated_at":           published.UpdatedAt,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/prices", propose)
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

final case class PriceRequest(sku: String, multiplier: Double, reason: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("priced")
  implicit val requestFormat: RootJsonFormat[PriceRequest] = jsonFormat3(PriceRequest)

  val store = PriceStore.open()

  val route: Route =
    path("v1" / "prices") {
      post {
        entity(as[PriceRequest]) { body =>
          // TODO: this draft applies whatever multiplier the caller sends (a 400 percent spike
          // shipped), has no floor or ceiling so a price can be driven to zero, and upserts an
          // unknown sku into a phantom price row. Review all three.
          val current = store.currentPrice(body.sku)
          val priceCents = (current * body.multiplier).toInt
          val row = store.upsert(body.sku, priceCents, body.reason)
          system.log.info(s"price sku=\${body.sku} multiplier=\${body.multiplier}")
          complete(StatusCodes.OK, s"""{"sku":"\${body.sku}","price_cents":\${row.price_cents}}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PriceRequest(sku: String, price_cents: Int, reason: String)
final case class PriceRow(price_cents: Int, source: String, updated_at: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("priced")
  implicit val requestFormat: RootJsonFormat[PriceRequest] = jsonFormat3(PriceRequest)

  val FloorCents = 50
  val CeilingCents = 500000
  val MaxMoveBp = 2000
  val WindowSeconds = 3600

  val store = PriceStore.open()

  /** The furthest price the remaining headroom allows, clamped by floor and ceiling. */
  def windowBound(currentCents: Int, headroomBp: Int, direction: Int): Int = {
    val delta = currentCents * headroomBp / 10000
    math.min(math.max(currentCents + direction * delta, FloorCents), CeilingCents)
  }

  def movedBp(currentCents: Int, priceCents: Int): Int =
    math.abs(priceCents - currentCents) * 10000 / math.max(currentCents, 1)

  val route: Route =
    path("v1" / "prices") {
      post {
        optionalHeaderValueByName("X-Caller-Id") { callerOpt =>
          entity(as[PriceRequest]) { body =>
            if (!callerOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Caller-Id"}""")
            } else if (body.reason.trim.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"reason is required"}""")
            } else {
              store.getSku(body.sku) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"unknown sku"}""")
                case Some(row) =>
                  val current = row.price_cents
                  if (body.price_cents < FloorCents || body.price_cents > CeilingCents) {
                    complete(
                      StatusCodes.UnprocessableEntity,
                      s"""{"error":"price outside the absolute guardrails","price_cents":\${body.price_cents},"floor_cents":$FloorCents,"ceiling_cents":$CeilingCents}"""
                    )
                  } else {
                    val direction = if (body.price_cents >= current) 1 else -1
                    val bound = windowBound(current, MaxMoveBp, direction)
                    if ((direction > 0 && body.price_cents > bound) || (direction < 0 && body.price_cents < bound)) {
                      complete(
                        StatusCodes.Conflict,
                        s"""{"error":"change exceeds the per-window limit","limit_bp":$MaxMoveBp,"current_price_cents":$current,"bound_cents":$bound}"""
                      )
                    } else {
                      val moved = movedBp(current, body.price_cents)
                      val published = store.publish(body.sku, body.price_cents, body.reason, "operator")
                      system.log.info(s"publish sku=\${body.sku} moved_bp=$moved bound_cents=$bound")
                      complete(
                        StatusCodes.OK,
                        s"""{"sku":"\${body.sku}","price_cents":\${published.price_cents},"previous_price_cents":$current,"moved_bp":$moved,"headroom_bp":\${MaxMoveBp - moved},"source":"\${published.source}","updated_at":"\${published.updated_at}"}"""
                      )
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

struct PriceStore {
  int currentPrice(const std::string& sku);
  json upsert(const std::string& sku, int priceCents, const std::string& reason);
};

PriceStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/prices", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft applies whatever multiplier the caller sends (a 400 percent spike shipped),
    // has no floor or ceiling so a price can be driven to zero, and upserts an unknown sku into a
    // phantom price row. Review all three.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto sku = body.value("sku", std::string());
    const double multiplier = body.value("multiplier", 1.0);
    const int current = store.currentPrice(sku);
    const int priceCents = static_cast<int>(static_cast<double>(current) * multiplier);
    const auto row = store.upsert(sku, priceCents, body.value("reason", std::string()));
    std::cerr << "price sku=" << sku << " multiplier=" << multiplier << "\\n";
    res.status = 200;
    res.set_content(json{{"sku", sku}, {"price_cents", row["price_cents"]}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kFloorCents = 50;
constexpr int kCeilingCents = 500000;
constexpr int kMaxMoveBp = 2000;

struct PriceStore {
  std::optional<json> getSku(const std::string& sku);
  json publish(const std::string& sku, int priceCents, const std::string& reason, const std::string& source);
};

PriceStore store;

/** The furthest price the remaining headroom allows, clamped by floor and ceiling. */
int windowBound(int currentCents, int headroomBp, int direction) {
  const int delta = currentCents * headroomBp / 10000;
  return std::min(std::max(currentCents + direction * delta, kFloorCents), kCeilingCents);
}

int movedBp(int currentCents, int priceCents) {
  return std::abs(priceCents - currentCents) * 10000 / std::max(currentCents, 1);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/prices", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("price_cents") || !body["price_cents"].is_number_integer()) {
      res.status = 400;
      res.set_content(R"({"error":"price_cents must be an integer"})", "application/json");
      return;
    }
    const auto reason = body.value("reason", std::string());
    if (reason.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"reason is required"})", "application/json");
      return;
    }
    const auto sku = body.value("sku", std::string());
    const auto found = store.getSku(sku);
    if (!found) {
      res.status = 404;
      res.set_content(R"({"error":"unknown sku"})", "application/json");
      return;
    }
    const int current = (*found)["price_cents"].get<int>();
    const int priceCents = body["price_cents"].get<int>();
    if (priceCents < kFloorCents || priceCents > kCeilingCents) {
      res.status = 422;
      res.set_content(
          json{{"error", "price outside the absolute guardrails"},
               {"price_cents", priceCents},
               {"floor_cents", kFloorCents},
               {"ceiling_cents", kCeilingCents}}
              .dump(),
          "application/json");
      return;
    }
    const int direction = priceCents >= current ? 1 : -1;
    const int bound = windowBound(current, kMaxMoveBp, direction);
    if ((direction > 0 && priceCents > bound) || (direction < 0 && priceCents < bound)) {
      res.status = 409;
      res.set_content(
          json{{"error", "change exceeds the per-window limit"},
               {"limit_bp", kMaxMoveBp},
               {"current_price_cents", current},
               {"bound_cents", bound}}
              .dump(),
          "application/json");
      return;
    }
    const int moved = movedBp(current, priceCents);
    const auto published = store.publish(sku, priceCents, reason, "operator");
    std::cerr << "publish sku=" << sku << " moved_bp=" << moved << " bound_cents=" << bound << "\\n";
    res.status = 200;
    res.set_content(
        json{{"sku", sku},
             {"price_cents", published["price_cents"]},
             {"previous_price_cents", current},
             {"moved_bp", moved},
             {"headroom_bp", kMaxMoveBp - moved},
             {"source", published["source"]},
             {"updated_at", published["updated_at"]}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the rejections by cost: caller, body shape, `reason`, then the store lookup, then the two guardrails. Every guard that can reject without touching the price store is free, and the sku lookup has to happen before anything can write.',
    'The bound is derived, never hardcoded: `bound = current + direction * current * headroom_bp / 10_000`, clamped by the floor and the ceiling, and returned in the 409 body so the caller can retry with a legal price instead of guessing what the limit was.',
    '`price_cents` is a target, not a factor. Keeping the multiplier out of the request is the point: a caller cannot express "double it" in a way the platform can check against the current price and the window headroom.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of a system that moves money. The draft reads fine because the demo sends a multiplier of 1.0 against a sku that exists. Three separate defects are being checked. First, the request has to express a target price, because a multiplier is a change the platform cannot compare against its own guardrails without first trusting the caller's arithmetic. Second, the absolute floor and ceiling are the last line of defense: they hold even when the window accounting is wrong, which is exactly what happens under concurrency. Third, a rejection has to explain itself — \`bound_cents\` is what turns a 409 from a dead end into a retry the caller can compute. The phantom sku is the quiet one: an upsert on the write path lets a typo create a price row, and every later read, catalog export and experiment has to reason about a sku that was never in the catalog. Real platforms add a comparable-to-price check, per-category guardrail recipes from config, and a two-person approval for changes above a threshold.`,
};
