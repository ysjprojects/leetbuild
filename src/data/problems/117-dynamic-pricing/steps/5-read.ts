import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/prices/{sku}: the price the storefront charges',
  concept: 'http',
  file: 'read',
  focus: ['storefront', 'operator', 'api', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers
\`GET /v1/prices/{sku}\`, reads a row and the demo storefront renders a price. It is also serving an
unshipped experiment candidate to every caller, labeling the number with the model version as if
that were provenance, and answering none of the questions the platform will be asked later — where
did this price come from, when was it set, and how much room does the window have left.

Implement \`GET /v1/prices/{sku}\`.

- A **storefront read** (no \`X-Operator-Scope\` header) answers with the **published** price row from
  the store: \`store.published(sku)\`. An unknown sku is **404**. Never invent a price, and never fall
  through to an experiment candidate.
- An **operator read** carrying \`X-Operator-Scope: preview\` answers with the current **experiment
  candidate** for the sku. Any other value, or no header at all, gets the published price: a
  candidate is a proposal, not a price the storefront charges.
- The body names its provenance. \`source\` and \`updated_at\` are separate fields next to \`sku\` and
  \`price_cents\`. Stamping the model version in place of a source is not provenance: the reader must
  be able to tell model output from a published price.
- The body carries the guardrail state of the current window bucket (\`now // WINDOW_S\`,
  \`WINDOW_S = 3600\`): a \`guardrail\` object with the \`window\`, \`moved_bp\` read from the Redis hash
  \`guard:{sku}:{window}\` (0 when the field is absent), \`limit_bp\` = \`MAX_MOVE_BP\` (**2000** bp, i.e.
  20%), and \`bound\` — the furthest price the window still allows from here: the served price plus
  its remaining headroom (\`limit_bp - moved_bp\`, floored at 0).
- When the published row is missing and the answer comes from the store’s last approved price
  (\`store.last_approved(sku)\`), the \`guardrail\` object carries \`stale: true\`; otherwise
  \`stale: false\`. A fallback may serve a price, but it may not present it as current.

**Failure mode the checks target.** The draft fails in the direction a demo cannot show: every
reader sees the recommendation as a price, and nobody can tell afterwards that the number was never
published. The read is the platform’s honesty surface — the one place a merchandiser, an auditor
and the storefront all look — and the draft answers it with a price plus a model label: no
\`source\`, no \`updated_at\`, no guardrail state, and therefore no way to see which bound the window
hit or that the value came from a stale fallback. A leaked candidate charges customers a number no
one approved; a read with no provenance makes every later publish impossible to audit.`,
  sequence: {
    participants: ['Storefront', 'Operator console', 'Pricing API', 'Price store', 'Redis'],
    messages: [
      {from: 'Storefront', to: 'Pricing API', label: 'GET /v1/prices/{sku}', kind: 'sync'},
      {from: 'Pricing API', to: 'Price store', label: 'published(sku)', kind: 'sync'},
      {from: 'Price store', to: 'Pricing API', label: '{price_cents, source, updated_at}', kind: 'reply'},
      {from: 'Pricing API', to: 'Redis', label: 'HGET guard:{sku}:{window} moved', kind: 'sync'},
      {from: 'Redis', to: 'Pricing API', label: 'moved_bp → headroom_bp', kind: 'reply'},
      {from: 'Pricing API', to: 'Storefront', label: '200 {price_cents, source, updated_at, guardrail}', kind: 'reply'},
      {from: 'Pricing API', to: 'Operator console', label: '404 unknown sku', kind: 'reply'},
      {
        from: 'Operator console',
        to: 'Pricing API',
        label: 'GET /v1/prices/{sku} · X-Operator-Scope: preview',
        kind: 'sync',
      },
      {from: 'Pricing API', to: 'Price store', label: 'candidate(sku)', kind: 'sync'},
      {
        from: 'Pricing API',
        to: 'Operator console',
        label: '200 {price_cents, source: experiment, guardrail}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'The storefront is not an operator: answer a plain read from `store.published(sku)`, return **404** when the store has no such sku, and never let the candidate path be reachable without a scope. A read that falls back to “anything we have” is how an unapproved price reaches a customer.',
    'Read the header before choosing the row: `X-Operator-Scope` is the only thing that unlocks `store.candidate(sku)`. It must equal the exact value `preview`; any other value — or a storefront that sends none — gets the published row.',
    'Build the answer from two sources: the row (published, or `store.last_approved(sku)` with `stale: true` when nothing is published) and the Redis hash `guard:{sku}:{window}` for `moved_bp`. The `guardrail` object needs `window`, `moved_bp`, `limit_bp` (`MAX_MOVE_BP` = 2000) and `bound` = served price + remaining headroom — that object is what makes a frozen price explainable.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/prices/{sku}',
      detail: 'Register the read route on `GET /v1/prices/{sku}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/prices\/\{sku\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/prices\/:sku['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/prices\/\{sku\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"prices"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,]*\/v1\/prices\//]},
      },
    },
    {
      id: 'published-only',
      title: 'A plain read serves the published row, 404 otherwise',
      detail:
        'A storefront read (no preview scope) answers from `store.published(sku)`; an unknown sku is **404**, never a synthesized price. The draft hands every caller the experiment candidate and never 404s.',
      match: {
        python: {all: [/store\.published\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/store\.published\(/, /code\(\s*404\s*\)/]},
        go: {all: [/store\.Published\(/, /StatusNotFound/]},
        scala: {all: [/store\.published\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/store\.published\(/, /\b404\b/]},
      },
    },
    {
      id: 'preview-scope',
      title: 'Experiment candidates are operator-only',
      detail:
        'The candidate is served only to a caller presenting `X-Operator-Scope: preview`; every other caller gets the published row. The draft has no scope check, so a storefront read returns an experiment price.',
      match: {
        python: {all: [/X-Operator-Scope/, /==\s*"preview"/, /store\.candidate\(/]},
        typescript: {all: [/x-operator-scope/, /===\s*'preview'/, /store\.candidate\(/]},
        go: {all: [/X-Operator-Scope/, /==\s*"preview"/, /store\.Candidate\(/]},
        scala: {all: [/X-Operator-Scope/, /==\s*"preview"/, /store\.candidate\(/]},
        cpp: {all: [/X-Operator-Scope/, /==\s*"preview"/, /store\.candidate\(/]},
      },
    },
    {
      id: 'source-and-timestamp',
      title: 'Names the source and the timestamp of the served price',
      detail:
        'The body carries `source` and `updated_at` as separate fields next to `price_cents`, so a reader can tell a published price from model output and see when it was set. The draft stamps the model version and reports no source and no timestamp.',
      match: {
        python: {all: [/"source"/, /"updated_at"/]},
        typescript: {all: [/source\s*:/, /updated_at\s*:/]},
        go: {all: [/"source"/, /"updated_at"/]},
        scala: {all: [/source\s*:/, /updated_at\s*:/]},
        cpp: {all: [/"source"/, /"updated_at"/]},
      },
    },
    {
      id: 'guardrail-state',
      title: 'Reports the window, the consumed headroom and the bound',
      detail:
        'The body carries a `guardrail` object with `window`, `moved_bp` (from `guard:{sku}:{window}`), `limit_bp` (`MAX_MOVE_BP` = 2000) and `bound` — the furthest price the window still allows — plus `stale: true` when the price came from `store.last_approved(sku)`. The draft returns no guardrail state and no stale marker.',
      match: {
        python: {
          all: [
            /"guardrail"/,
            /"window"/,
            /"moved_bp"/,
            /"limit_bp"/,
            /MAX_MOVE_BP/,
            /"bound"/,
            /"stale"/,
            /guard:\{sku\}:\{window\}/,
            /store\.last_approved\(/,
          ],
        },
        typescript: {
          all: [
            /guardrail\s*:/,
            /window\s*:/,
            /moved_bp\s*:/,
            /limit_bp\s*:/,
            /MAX_MOVE_BP/,
            /bound\s*:/,
            /stale\s*:/,
            /guard:\$\{sku\}:\$\{window\}/,
            /store\.lastApproved\(/,
          ],
        },
        go: {
          all: [
            /"guardrail"/,
            /"window"/,
            /"moved_bp"/,
            /"limit_bp"/,
            /maxMoveBp/,
            /"bound"/,
            /"stale"/,
            /guard:%s:%d/,
            /store\.LastApproved\(/,
          ],
        },
        scala: {
          all: [
            /guardrail\s*:/,
            /window\s*:/,
            /moved_bp\s*:/,
            /limit_bp\s*:/,
            /MaxMoveBp/,
            /bound\s*:/,
            /stale\s*:/,
            /guard:\$sku:\$window/,
            /store\.lastApproved\(/,
          ],
        },
        cpp: {
          all: [
            /"guardrail"/,
            /"window"/,
            /"moved_bp"/,
            /"limit_bp"/,
            /kMaxMoveBp/,
            /"bound"/,
            /"stale"/,
            /"guard:"/,
            /store\.lastApproved\(/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/prices/{sku}: a model-generated draft that serves the experiment candidate to everyone."""
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()

MODEL_VERSION = "demand-model-v3"


class PriceStore:
    def candidate(self, sku: str) -> dict:
        """The model's latest experiment candidate: {"price_cents": int}."""
        raise NotImplementedError


store = PriceStore()


@app.get("/v1/prices/{sku}")
def read_price(sku: str) -> JSONResponse:
    # TODO: a storefront read must serve the published row and 404 an unknown sku; the experiment
    # candidate belongs behind X-Operator-Scope: preview; the body has to name the source and
    # updated_at and carry the guard:{sku}:{window} state (moved_bp, limit_bp, bound) plus stale,
    # instead of stamping MODEL_VERSION as provenance.
    candidate = store.candidate(sku)
    return JSONResponse(
        {"sku": sku, "price_cents": candidate["price_cents"], "model_version": MODEL_VERSION},
        status_code=200,
    )
`,
      solution: `"""GET /v1/prices/{sku}: published prices for the storefront, candidates behind a preview scope."""
import time

import redis as redis_client
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

MAX_MOVE_BP = 2000
WINDOW_S = 3600

redis = redis_client.Redis(decode_responses=True)


class PriceStore:
    def published(self, sku: str) -> dict | None:
        """The published row: {"price_cents": int, "source": str, "updated_at": str}, or None."""
        raise NotImplementedError

    def candidate(self, sku: str) -> dict | None:
        """The current experiment candidate for the sku (source "experiment"), or None."""
        raise NotImplementedError

    def last_approved(self, sku: str) -> dict | None:
        """The last approved row, served with stale: true when nothing newer is published."""
        raise NotImplementedError


store = PriceStore()


def guard_key(sku: str, window: int) -> str:
    return f"guard:{sku}:{window}"


@app.get("/v1/prices/{sku}")
def read_price(
    sku: str,
    scope: str | None = Header(default=None, alias="X-Operator-Scope"),
) -> JSONResponse:
    window = int(time.time()) // WINDOW_S
    moved_bp = int(redis.hget(guard_key(sku, window), "moved") or 0)

    row = None
    if scope == "preview":
        row = store.candidate(sku)
    if row is None:
        row = store.published(sku)
    stale = False
    if row is None:
        row = store.last_approved(sku)
        stale = True
    if row is None:
        raise HTTPException(status_code=404, detail="unknown sku")

    headroom_bp = max(0, MAX_MOVE_BP - moved_bp)
    bound = row["price_cents"] + row["price_cents"] * headroom_bp // 10000
    return JSONResponse(
        {
            "sku": sku,
            "price_cents": row["price_cents"],
            "source": row["source"],
            "updated_at": row["updated_at"],
            "guardrail": {
                "window": window,
                "moved_bp": moved_bp,
                "limit_bp": MAX_MOVE_BP,
                "headroom_bp": headroom_bp,
                "bound": bound,
                "stale": stale,
            },
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/prices/:sku: a model-generated draft that serves the experiment candidate to everyone. */
import Fastify from 'fastify';

import {store} from './price_store';

export const app = Fastify();

const MODEL_VERSION = 'demand-model-v3';

app.get('/v1/prices/:sku', async (request, reply) => {
  // TODO: a storefront read must serve the published row and 404 an unknown sku; the experiment
  // candidate belongs behind X-Operator-Scope: preview; the body has to name the source and
  // updated_at and carry the guard:{sku}:{window} state (moved_bp, limit_bp, bound) plus stale,
  // instead of stamping MODEL_VERSION as provenance.
  const {sku} = request.params as {sku: string};
  const candidate = await store.candidate(sku);
  return reply.code(200).send({sku, price_cents: candidate.price_cents, model_version: MODEL_VERSION});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/prices/:sku: published prices for the storefront, candidates behind a preview scope. */
import Fastify from 'fastify';
import Redis from 'ioredis';

import {store} from './price_store';

export const app = Fastify();

const MAX_MOVE_BP = 2000;
const WINDOW_S = 3600;

const redis = new Redis();

interface PriceRow {
  price_cents: number;
  source: string;
  updated_at: string;
}

function guardKey(sku: string, window: number): string {
  return \`guard:\${sku}:\${window}\`;
}

app.get('/v1/prices/:sku', async (request, reply) => {
  const {sku} = request.params as {sku: string};
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const movedRaw = await redis.hget(guardKey(sku, window), 'moved');
  const movedBp = movedRaw === null ? 0 : Number(movedRaw);

  const scope = request.headers['x-operator-scope'];
  const preview = typeof scope === 'string' && scope === 'preview';
  let stale = false;
  let row: PriceRow | null = null;
  if (preview) row = await store.candidate(sku);
  if (row === null) row = await store.published(sku);
  if (row === null) {
    row = await store.lastApproved(sku);
    stale = true;
  }
  if (row === null) return reply.code(404).send({error: 'unknown sku'});

  const headroomBp = Math.max(0, MAX_MOVE_BP - movedBp);
  return reply.code(200).send({
    sku,
    price_cents: row.price_cents,
    source: row.source,
    updated_at: row.updated_at,
    guardrail: {
      window: window,
      moved_bp: movedBp,
      limit_bp: MAX_MOVE_BP,
      headroom_bp: headroomBp,
      bound: row.price_cents + Math.floor((row.price_cents * headroomBp) / 10000),
      stale: stale,
    },
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// GET /v1/prices/{sku}: a model-generated draft that serves the experiment candidate to everyone.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const modelVersion = "demand-model-v3"

type PriceStore struct{}

func (s *PriceStore) Candidate(ctx context.Context, sku string) map[string]any {
	return map[string]any{}
}

var store = &PriceStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readPrice(rw http.ResponseWriter, r *http.Request) {
	// TODO: a storefront read must serve the published row and 404 an unknown sku; the experiment
	// candidate belongs behind X-Operator-Scope: preview; the body has to name the source and
	// updated_at and carry the guard:{sku}:{window} state (moved_bp, limit_bp, bound) plus stale,
	// instead of stamping modelVersion as provenance.
	sku := r.PathValue("sku")
	candidate := store.Candidate(r.Context(), sku)
	writeJSON(rw, http.StatusOK, map[string]any{
		"sku":           sku,
		"price_cents":   candidate["price_cents"],
		"model_version": modelVersion,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/prices/{sku}", readPrice)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `// GET /v1/prices/{sku}: published prices for the storefront, candidates behind a preview scope.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxMoveBp = 2000
	windowS   = 3600
)

type PriceRow struct {
	PriceCents int    \`json:"price_cents"\`
	Source     string \`json:"source"\`
	UpdatedAt  string \`json:"updated_at"\`
}

type PriceStore struct{}

func (s *PriceStore) Published(ctx context.Context, sku string) (*PriceRow, error) {
	return nil, nil
}

func (s *PriceStore) Candidate(ctx context.Context, sku string) (*PriceRow, error) {
	return nil, nil
}

func (s *PriceStore) LastApproved(ctx context.Context, sku string) (*PriceRow, error) {
	return nil, nil
}

var (
	store = &PriceStore{}
	rdb   = redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})
)

func guardKey(sku string, window int64) string {
	return fmt.Sprintf("guard:%s:%d", sku, window)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readPrice(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sku := r.PathValue("sku")
	window := time.Now().Unix() / windowS

	movedBp := 0
	if raw, err := rdb.HGet(ctx, guardKey(sku, window), "moved").Result(); err == nil {
		if parsed, perr := strconv.Atoi(raw); perr == nil {
			movedBp = parsed
		}
	}

	preview := r.Header.Get("X-Operator-Scope") == "preview"
	stale := false
	var row *PriceRow
	if preview {
		row, _ = store.Candidate(ctx, sku)
	}
	if row == nil {
		row, _ = store.Published(ctx, sku)
	}
	if row == nil {
		row, _ = store.LastApproved(ctx, sku)
		stale = true
	}
	if row == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown sku"})
		return
	}

	headroomBp := maxMoveBp - movedBp
	if headroomBp < 0 {
		headroomBp = 0
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"sku":         sku,
		"price_cents": row.PriceCents,
		"source":      row.Source,
		"updated_at":  row.UpdatedAt,
		"guardrail": map[string]any{
			"window":      window,
			"moved_bp":    movedBp,
			"limit_bp":    maxMoveBp,
			"headroom_bp": headroomBp,
			"bound":       row.PriceCents + row.PriceCents*headroomBp/10000,
			"stale":       stale,
		},
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/prices/{sku}", readPrice)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `/** GET /v1/prices/{sku}: a model-generated draft that serves the experiment candidate to everyone. */
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Candidate(price_cents: Int)

object PriceApi {
  implicit val system: ActorSystem = ActorSystem("priced")
  implicit val candidateFormat: RootJsonFormat[Candidate] = jsonFormat1(Candidate)

  val ModelVersion = "demand-model-v3"

  val store = PriceStore.open()

  val route: Route =
    path("v1" / "prices" / Segment) { sku =>
      get {
        // TODO: a storefront read must serve the published row and 404 an unknown sku; the
        // experiment candidate belongs behind X-Operator-Scope: preview; the body has to name the
        // source and updated_at and carry the guard:{sku}:{window} state (moved_bp, limit_bp,
        // bound) plus stale, instead of stamping ModelVersion as provenance.
        val candidate = store.candidate(sku)
        complete(
          StatusCodes.OK,
          s"""{"sku":"$sku","price_cents":\${candidate.price_cents},"model_version":"$ModelVersion"}"""
        )
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `/** GET /v1/prices/{sku}: published prices for the storefront, candidates behind a preview scope. */
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PriceRow(price_cents: Int, source: String, updated_at: String)
final case class Guardrail(window: Long, moved_bp: Int, limit_bp: Int, headroom_bp: Int, bound: Int, stale: Boolean)
final case class PriceResponse(
    sku: String,
    price_cents: Int,
    source: String,
    updated_at: String,
    guardrail: Guardrail
)

object PriceApi {
  implicit val system: ActorSystem = ActorSystem("priced")
  implicit val rowFormat: RootJsonFormat[PriceRow] = jsonFormat3(PriceRow)
  implicit val guardrailFormat: RootJsonFormat[Guardrail] = jsonFormat6(Guardrail)
  implicit val responseFormat: RootJsonFormat[PriceResponse] = jsonFormat5(PriceResponse)

  val MaxMoveBp = 2000
  val WindowS = 3600L

  val store = PriceStore.open()
  val redis: Jedis = new Jedis("redis://127.0.0.1:6379")

  def guardKey(sku: String, window: Long): String = s"guard:$sku:$window"

  def movedBp(sku: String, window: Long): Int =
    Option(redis.hget(guardKey(sku, window), "moved")).map(_.toInt).getOrElse(0)

  val route: Route =
    path("v1" / "prices" / Segment) { sku =>
      get {
        optionalHeaderValueByName("X-Operator-Scope") { scope =>
          val window = System.currentTimeMillis() / 1000 / WindowS
          val moved = movedBp(sku, window)

          def answer(row: PriceRow, stale: Boolean): Route = {
            val headroom = math.max(0, MaxMoveBp - moved)
            val bound = row.price_cents + row.price_cents * headroom / 10000
            complete(
              StatusCodes.OK,
              PriceResponse(
                sku,
                row.price_cents,
                row.source,
                row.updated_at,
                Guardrail(window, moved, MaxMoveBp, headroom, bound, stale)
              )
            )
          }

          val preview = scope.exists(value => value == "preview")
          val row = (if (preview) store.candidate(sku) else None).orElse(store.published(sku))
          row match {
            case Some(found) => answer(found, stale = false)
            case None =>
              store.lastApproved(sku) match {
                case Some(found) => answer(found, stale = true)
                case None        => complete(StatusCodes.NotFound, """{"error":"unknown sku"}""")
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
      starter: `/** GET /v1/prices/{sku}: a model-generated draft that serves the experiment candidate to everyone. */
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

struct PriceStore {
  json candidate(const std::string& sku);
};

PriceStore store;

constexpr const char* kModelVersion = "demand-model-v3";

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/prices/([a-z0-9_-]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: a storefront read must serve the published row and 404 an unknown sku; the experiment
    // candidate belongs behind X-Operator-Scope: preview; the body has to name the source and
    // updated_at and carry the guard:{sku}:{window} state (moved_bp, limit_bp, bound) plus stale,
    // instead of stamping kModelVersion as provenance.
    const auto sku = req.matches[1].str();
    const json candidate = store.candidate(sku);
    res.status = 200;
    res.set_content(
        json{{"sku", sku}, {"price_cents", candidate.at("price_cents")}, {"model_version", kModelVersion}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `/** GET /v1/prices/{sku}: published prices for the storefront, candidates behind a preview scope. */
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <ctime>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMaxMoveBp = 2000;
constexpr long kWindowS = 3600;

struct PriceRow {
  int price_cents = 0;
  std::string source;
  std::string updated_at;
};

struct PriceStore {
  std::optional<PriceRow> published(const std::string& sku);
  std::optional<PriceRow> candidate(const std::string& sku);
  std::optional<PriceRow> lastApproved(const std::string& sku);
};

PriceStore store;
sw::redis::Redis redis("tcp://127.0.0.1:6379");

std::string guardKey(const std::string& sku, long window) {
  return "guard:" + sku + ":" + std::to_string(window);
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/prices/([a-z0-9_-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto sku = req.matches[1].str();
    const long window = std::time(nullptr) / kWindowS;

    int moved_bp = 0;
    if (const auto raw = redis.hget(guardKey(sku, window), "moved")) moved_bp = std::stoi(*raw);

    const bool preview = req.get_header_value("X-Operator-Scope") == "preview";
    bool stale = false;
    std::optional<PriceRow> row;
    if (preview) row = store.candidate(sku);
    if (!row) row = store.published(sku);
    if (!row) {
      row = store.lastApproved(sku);
      stale = true;
    }
    if (!row) {
      res.status = 404;
      res.set_content(R"({"error":"unknown sku"})", "application/json");
      return;
    }

    const int headroom_bp = std::max(0, kMaxMoveBp - moved_bp);
    const int bound = row->price_cents + row->price_cents * headroom_bp / 10000;
    res.status = 200;
    res.set_content(
        json{{"sku", sku},
             {"price_cents", row->price_cents},
             {"source", row->source},
             {"updated_at", row->updated_at},
             {"guardrail",
              {{"window", window},
               {"moved_bp", moved_bp},
               {"limit_bp", kMaxMoveBp},
               {"headroom_bp", headroom_bp},
               {"bound", bound},
               {"stale", stale}}}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is checking whether you review a read path the way you review a write. Three
contracts are exercised. Audience: the storefront gets the published price, and only a caller
holding \`X-Operator-Scope: preview\` sees the experiment candidate — one endpoint, two audiences,
two different facts, and mixing them up charges customers a number no one approved. Provenance:
\`source\` and \`updated_at\` are separate fields, because “which writer set this, and when” is the
first question an auditor asks, and a model version is not a source. Explainability: the \`guardrail\`
object reports the window, the headroom already consumed, the limit, and the bound the window allows
from here, with \`stale\` marking an answer that came from the last approved price instead of a
published one. Real pricing platforms put a short-TTL cache in front of the published row, attach a
signed \`update_id\` so two publishes are distinguishable, serve reads from replicas, and show
merchandisers the remaining headroom before they submit a proposal.`,
};
