import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/prices/{sku}: the price the storefront charges',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['storefront', 'operator', 'api', 'db', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/prices/{sku}\` to the storefront and the operator
console: it answers \`{"sku", "price_cents", "model_version"}\`, taking the price from the
experiment's candidate (\`store.candidate_of\`) when there is one and from the published row
otherwise, labelled with \`MODEL_VERSION\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Shoppers are charged a candidate price nobody approved and an
unknown sku answers 200 with no price; operators cannot see the candidate beside the price it would
replace; a price kept while the model is down reads like a fresh one; and nobody can tell how much
of its window a sku has spent.

- The price is the published row (\`store.get_sku\`); an unknown sku is **404**.
- With \`X-Operator-Scope: preview\` (\`PREVIEW_SCOPE\`; the gateway sets it after operator login and
  strips it from storefront traffic) the body adds \`candidate\` (\`price_cents\`, \`model_version\`)
  beside the published price. Every other caller never sees it.
- The body names the row's \`source\`, \`updated_at\` and \`stale\`.
- \`guardrail\` is \`guard.window_state(sku)\`: \`window\`, \`moved_bp\`, \`limit_bp\`, \`headroom_bp\`.`,
  sequence: {
    participants: ['Storefront', 'Operator console', 'Pricing API', 'Price store', 'Redis guard'],
    messages: [
      {from: 'Storefront', to: 'Pricing API', label: 'GET /v1/prices/SKU-1', kind: 'sync'},
      {from: 'Pricing API', to: 'Price store', label: 'get_sku · none → 404', kind: 'sync'},
      {from: 'Pricing API', to: 'Redis guard', label: 'window_state(sku)', kind: 'sync'},
      {
        from: 'Pricing API',
        to: 'Storefront',
        label: '200 {price_cents, source, updated_at, stale, guardrail}',
        kind: 'reply',
      },
      {from: 'Operator console', to: 'Pricing API', label: 'GET … · X-Operator-Scope: preview', kind: 'sync'},
      {
        from: 'Pricing API',
        to: 'Operator console',
        label: '200 {…, candidate: {price_cents, model_version}}',
        kind: 'reply',
      },
    ],
  },
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
        cpp: {all: [/svr\.Get\(\s*R?"[^\n]*\/v1\/prices\//]},
      },
    },
    {
      id: 'published-only',
      title: 'Serves the published price, 404 for an unknown sku',
      detail:
        "Every caller's `price_cents` is the published row's (`store.get_sku`), and an unknown sku answers **404**. The starter lets the experiment's candidate win for everyone and answers 200 with a null price for a sku that does not exist.",
      match: {
        python: {all: [/\b404\b/], order: [/store\.get_sku\(/, /store\.candidate_of\(/]},
        typescript: {all: [/\b404\b/], order: [/getSku\(/, /candidateOf\(/]},
        go: {all: [/StatusNotFound|\b404\b/], order: [/store\.GetSKU\(/, /store\.CandidateOf\(/]},
        scala: {all: [/NotFound|\b404\b/], order: [/Store\.getSku\(/, /Store\.candidateOf\(/]},
        cpp: {all: [/\b404\b/], order: [/store::getSku\(/, /store::candidateOf\(/]},
      },
    },
    {
      id: 'preview-scope',
      title: 'Operators see the candidate beside the price',
      detail:
        'With `X-Operator-Scope: preview` the body carries `candidate` (`price_cents`, `model_version`) next to the published `price_cents`; any other scope, or none, gets no candidate. The starter has no scope and no candidate field.',
      match: {
        python: {all: [/x-operator-scope/i, /PREVIEW_SCOPE\s*=/, /["']candidate["']/]},
        typescript: {all: [/x-operator-scope/i, /PREVIEW_SCOPE\s*=/, /candidate\s*[:=]|\.candidate\b/]},
        go: {all: [/X-Operator-Scope/i, /previewScope\s*=/, /"candidate"/]},
        scala: {all: [/X-Operator-Scope/i, /PreviewScope\s*=/, /"candidate"/]},
        cpp: {all: [/X-Operator-Scope/i, /kPreviewScope\s*=/, /"candidate"/]},
      },
    },
    {
      id: 'provenance',
      title: 'Names the source, the timestamp and the stale flag',
      detail:
        "The body carries the row's `source`, `updated_at` and `stale`, so a price kept while the model is down reads as `last-approved` with the time it was decided. The starter labels every answer with a constant model version.",
      match: {
        python: {all: [/["']source["']/, /["']updated_at["']/, /["']stale["']/], none: [/MODEL_VERSION/]},
        typescript: {all: [/source:/, /updated_at:/, /stale:/], none: [/MODEL_VERSION/]},
        go: {all: [/"source"/, /"updated_at"/, /"stale"/], none: [/\bmodelVersion\b/]},
        scala: {all: [/"source"/, /"updated_at"/, /"stale"/], none: [/\bModelVersion\b/]},
        cpp: {all: [/"source"/, /"updated_at"/, /"stale"/], none: [/\bkModelVersion\b/]},
      },
    },
    {
      id: 'guardrail-state',
      title: "Reports the sku's window",
      detail:
        'The body carries `guardrail` from `guard.window_state(sku)`: the `window`, the `moved_bp` spent in it, `limit_bp` and `headroom_bp`. The starter reports none, so a refused change cannot be explained from the read.',
      match: {
        python: {all: [/guard\.window_state\(/, /["']guardrail["']/]},
        typescript: {all: [/windowState\(/, /guardrail:/]},
        go: {all: [/guard\.WindowState\(/, /"guardrail"/]},
        scala: {all: [/Guard\.windowState\(/, /"guardrail"/]},
        cpp: {all: [/guard::windowState\(/, /"guardrail"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from pricing import guard, store  # guard.window_state; store.get_sku, candidate_of

app = FastAPI()

MODEL_VERSION = "elasticity-v7"


@app.get("/v1/prices/{sku}")
def read_price(sku: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    row = store.candidate_of(sku) or store.get_sku(sku)
    return JSONResponse({"sku": sku, "price_cents": row["price_cents"] if row else None, "model_version": MODEL_VERSION})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from pricing import guard, store  # guard.window_state; store.get_sku, candidate_of

app = FastAPI()

PREVIEW_SCOPE = "preview"


@app.get("/v1/prices/{sku}")
def read_price(sku: str, request: Request) -> JSONResponse:
    row = store.get_sku(sku)
    if row is None:
        return JSONResponse({"error": f"unknown sku {sku}"}, status_code=404)
    body = {
        "sku": sku,
        "price_cents": row["price_cents"],
        "source": row["source"],
        "updated_at": row["updated_at"],
        "stale": row["stale"],
        "guardrail": guard.window_state(sku),
    }
    # The candidate rides beside the published price for the operators running the experiment.
    if request.headers.get("x-operator-scope") == PREVIEW_SCOPE:
        candidate = store.candidate_of(sku)
        if candidate is not None:
            body["candidate"] = {"price_cents": candidate["price_cents"], "model_version": candidate["model_version"]}
    return JSONResponse(body)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {windowState} from 'pricing/guard';
import {candidateOf, getSku} from 'pricing/store';

export const app = Fastify();

export const MODEL_VERSION = 'elasticity-v7';

app.get('/v1/prices/:sku', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {sku} = request.params as {sku: string};
  const row = (await candidateOf(sku)) ?? (await getSku(sku));
  return {sku, price_cents: row === null ? null : row.price_cents, model_version: MODEL_VERSION};
});
`,
      solution: `import Fastify from 'fastify';

import {windowState} from 'pricing/guard';
import {candidateOf, getSku} from 'pricing/store';

export const app = Fastify();

export const PREVIEW_SCOPE = 'preview';

app.get('/v1/prices/:sku', async (request, reply) => {
  const {sku} = request.params as {sku: string};
  const row = await getSku(sku);
  if (row === null) return reply.code(404).send({error: \`unknown sku \${sku}\`});
  const body: Record<string, unknown> = {
    sku,
    price_cents: row.price_cents,
    source: row.source,
    updated_at: row.updated_at,
    stale: row.stale,
    guardrail: await windowState(sku),
  };
  // The candidate rides beside the published price for the operators running the experiment.
  if (request.headers['x-operator-scope'] === PREVIEW_SCOPE) {
    const candidate = await candidateOf(sku);
    if (candidate !== null) body.candidate = {price_cents: candidate.price_cents, model_version: candidate.model_version};
  }
  return body;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"pricing/store" // store.GetSKU, CandidateOf
)

const modelVersion = "elasticity-v7"

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readPrice(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	sku := r.PathValue("sku")
	var price any
	if candidate := store.CandidateOf(r.Context(), sku); candidate != nil {
		price = candidate.PriceCents
	} else if row := store.GetSKU(r.Context(), sku); row != nil {
		price = row.PriceCents
	}
	writeJSON(rw, http.StatusOK, map[string]any{"sku": sku, "price_cents": price, "model_version": modelVersion})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/prices/{sku}", readPrice)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"pricing/guard" // guard.WindowState
	"pricing/store" // store.GetSKU, CandidateOf
)

const previewScope = "preview"

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readPrice(rw http.ResponseWriter, r *http.Request) {
	sku := r.PathValue("sku")
	row := store.GetSKU(r.Context(), sku)
	if row == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown sku " + sku})
		return
	}
	body := map[string]any{
		"sku": sku, "price_cents": row.PriceCents, "source": row.Source, "updated_at": row.UpdatedAt, "stale": row.Stale,
		"guardrail": guard.WindowState(r.Context(), sku),
	}
	// The candidate rides beside the published price for the operators running the experiment.
	if r.Header.Get("X-Operator-Scope") == previewScope {
		if candidate := store.CandidateOf(r.Context(), sku); candidate != nil {
			body["candidate"] = map[string]any{"price_cents": candidate.PriceCents, "model_version": candidate.ModelVersion}
		}
	}
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/prices/{sku}", readPrice)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import pricing.{Guard, Store} // Guard.windowState; Store.getSku, candidateOf

object Read {
  val ModelVersion = "elasticity-v7"

  val route: Route = path("v1" / "prices" / Segment) { sku =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      val price = Store.candidateOf(sku).map(_.priceCents).orElse(Store.getSku(sku).map(_.priceCents))
      val body = JsObject("sku" -> JsString(sku), "price_cents" -> price.map(JsNumber(_)).getOrElse(JsNull), "model_version" -> JsString(ModelVersion))
      complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import pricing.{Guard, Store} // Guard.windowState; Store.getSku, candidateOf

object Read {
  val PreviewScope = "preview"

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def guardrail(state: Guard.State): JsObject = JsObject(
    "window" -> JsNumber(state.window), "moved_bp" -> JsNumber(state.movedBp),
    "limit_bp" -> JsNumber(state.limitBp), "headroom_bp" -> JsNumber(state.headroomBp))

  val route: Route = path("v1" / "prices" / Segment) { sku =>
    get {
      optionalHeaderValueByName("X-Operator-Scope") { scope =>
        Store.getSku(sku) match {
          case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString(s"unknown sku $sku"))))
          case Some(row) =>
            val published = Map[String, JsValue](
              "sku" -> JsString(sku), "price_cents" -> JsNumber(row.priceCents), "source" -> JsString(row.source),
              "updated_at" -> JsNumber(row.updatedAt), "stale" -> JsBoolean(row.stale), "guardrail" -> guardrail(Guard.windowState(sku)))
            // The candidate rides beside the published price for the operators running the experiment.
            val candidate =
              if (scope.contains(PreviewScope))
                Store.candidateOf(sku).map(c => "candidate" -> JsObject("price_cents" -> JsNumber(c.priceCents), "model_version" -> JsString(c.modelVersion)))
              else None
            complete(json(StatusCodes.OK, JsObject(published ++ candidate)))
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

#include "pricing/guard.h"  // guard::windowState
#include "pricing/store.h"  // store::getSku, candidateOf

using json = nlohmann::json;

const std::string kModelVersion = "elasticity-v7";

void read_price(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string sku = req.matches[1];
  json price = nullptr;
  if (const auto candidate = store::candidateOf(sku)) {
    price = candidate->price_cents;
  } else if (const auto row = store::getSku(sku)) {
    price = row->price_cents;
  }
  res.set_content(json{{"sku", sku}, {"price_cents", price}, {"model_version", kModelVersion}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/prices/([\\w-]+))", read_price); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "pricing/guard.h"  // guard::windowState
#include "pricing/store.h"  // store::getSku, candidateOf

using json = nlohmann::json;

const std::string kPreviewScope = "preview";

void read_price(const httplib::Request& req, httplib::Response& res) {
  const std::string sku = req.matches[1];
  const auto row = store::getSku(sku);
  if (!row) {
    res.status = 404;
    res.set_content(json{{"error", "unknown sku " + sku}}.dump(), "application/json");
    return;
  }
  const guard::State window = guard::windowState(sku);
  json body{{"sku", sku},
            {"price_cents", row->price_cents},
            {"source", row->source},
            {"updated_at", row->updated_at},
            {"stale", row->stale},
            {"guardrail", json{{"window", window.window}, {"moved_bp", window.moved_bp}, {"limit_bp", window.limit_bp}, {"headroom_bp", window.headroom_bp}}}};
  // The candidate rides beside the published price for the operators running the experiment.
  if (req.get_header_value("X-Operator-Scope") == kPreviewScope) {
    if (const auto candidate = store::candidateOf(sku)) {
      body["candidate"] = json{{"price_cents", candidate->price_cents}, {"model_version", candidate->model_version}};
    }
  }
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/prices/([\\w-]+))", read_price); }
`,
    },
  },
  harness: {
    python: `from pricing import guard, store

PREVIEW = {"X-Operator-Scope": "preview"}


def _read(ctx):
    return ctx.client(ctx.load("read").app)


def _experiment():
    """SKU-1 published at 1000 while an experiment proposes 1150."""
    store.seed("SKU-1", 1000)
    store.set_candidate("SKU-1", 1150, "elasticity-v8")


async def check_route(ctx):
    store.seed("SKU-1", 1000)
    async with _read(ctx) as c:
        r = await c.get("/v1/prices/SKU-1")
    assert r.status_code == 200, f"GET /v1/prices/SKU-1 answered {r.status_code}: {r.text}"
    assert r.json().get("price_cents") == 1000, f"the read answered {r.json()}, expected price_cents 1000"


async def check_published_only(ctx):
    _experiment()
    async with _read(ctx) as c:
        r = await c.get("/v1/prices/SKU-1")
        assert r.status_code == 200 and r.json().get("price_cents") == 1000, f"the storefront read answered {r.text}: 1150 is an experiment's candidate nobody approved, the published price is 1000"
        r = await c.get("/v1/prices/SKU-1", headers=PREVIEW)
        assert r.json().get("price_cents") == 1000, f"an operator's price_cents must be the published price too, got {r.text}"
        missing = await c.get("/v1/prices/SKU-404")
    assert missing.status_code == 404, f"a sku that does not exist answered {missing.status_code} {missing.text}, expected 404"


async def check_preview_scope(ctx):
    _experiment()
    async with _read(ctx) as c:
        r = await c.get("/v1/prices/SKU-1", headers=PREVIEW)
        body = r.json()
        assert body.get("candidate") == {"price_cents": 1150, "model_version": "elasticity-v8"}, f"an operator with X-Operator-Scope: preview got {body}, expected candidate {{price_cents: 1150, model_version: elasticity-v8}} beside the price"
        assert body.get("price_cents") == 1000, f"the candidate goes beside the published price, not over it: {body}"
        other = await c.get("/v1/prices/SKU-1", headers={"X-Operator-Scope": "admin"})
        plain = await c.get("/v1/prices/SKU-1")
    assert "candidate" not in other.json() and "candidate" not in plain.json(), f"a caller without the preview scope saw the candidate: {other.text} / {plain.text}"


async def check_provenance(ctx):
    store.seed("SKU-1", 1000)
    ctx.clock.advance(30)
    approved = store.publish("SKU-1", 1100, "weekend promo", "operator")
    async with _read(ctx) as c:
        body = (await c.get("/v1/prices/SKU-1")).json()
        assert body.get("source") == "operator" and body.get("updated_at") == approved["updated_at"] and body.get("stale") is False, f"the read answered {body}, expected source operator, updated_at {approved['updated_at']} and stale false"
        ctx.clock.advance(600)
        store.mark_stale("SKU-1")  # the demand model went down: the approved price is kept
        body = (await c.get("/v1/prices/SKU-1")).json()
    assert body.get("stale") is True and body.get("source") == "last-approved", f"a price kept while the model is down answered {body}: it must say stale true and source last-approved"
    assert body.get("updated_at") == approved["updated_at"], f"the kept price reports updated_at {body.get('updated_at')}, expected when it was approved, {approved['updated_at']}"


async def check_guardrail_state(ctx):
    store.seed("SKU-1", 1000)
    guard.reserve("SKU-1", 1000, 1150)
    async with _read(ctx) as c:
        body = (await c.get("/v1/prices/SKU-1")).json()
    want = {"window": int(ctx.clock.time()) // 3600, "moved_bp": 1500, "limit_bp": 2000, "headroom_bp": 500}
    assert body.get("guardrail") == want, f"after a 15 % change the read's guardrail is {body.get('guardrail')}, expected {want}"
`,
    typescript: `const PREVIEW = {'X-Operator-Scope': 'preview'};

function read(ctx) {
  return {c: ctx.client(ctx.load('read').app), store: ctx.load('/support/pricing/store.ts'), guard: ctx.load('/support/pricing/guard.ts')};
}

/** SKU-1 published at 1000 while an experiment proposes 1150. */
async function experiment(store): Promise<void> {
  await store.seed('SKU-1', 1000);
  await store.setCandidate('SKU-1', 1150, 'elasticity-v8');
}

export async function check_route(ctx) {
  const {c, store} = read(ctx);
  await store.seed('SKU-1', 1000);
  const r = await c.get('/v1/prices/SKU-1');
  assert.equal(r.status, 200, \`GET /v1/prices/SKU-1 answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().price_cents, 1000, \`the read answered \${r.text}, expected price_cents 1000\`);
}

export async function check_published_only(ctx) {
  const {c, store} = read(ctx);
  await experiment(store);
  let r = await c.get('/v1/prices/SKU-1');
  assert(r.status === 200 && r.json().price_cents === 1000, \`the storefront read answered \${r.text}: 1150 is an experiment's candidate nobody approved, the published price is 1000\`);
  r = await c.get('/v1/prices/SKU-1', {headers: PREVIEW});
  assert.equal(r.json().price_cents, 1000, \`an operator's price_cents must be the published price too, got \${r.text}\`);
  const missing = await c.get('/v1/prices/SKU-404');
  assert.equal(missing.status, 404, \`a sku that does not exist answered \${missing.status} \${missing.text}, expected 404\`);
}

export async function check_preview_scope(ctx) {
  const {c, store} = read(ctx);
  await experiment(store);
  const r = await c.get('/v1/prices/SKU-1', {headers: PREVIEW});
  const body = r.json();
  assert.deepStrictEqual(body.candidate, {price_cents: 1150, model_version: 'elasticity-v8'}, \`an operator with X-Operator-Scope: preview got \${r.text}, expected candidate {price_cents: 1150, model_version: elasticity-v8} beside the price\`);
  assert.equal(body.price_cents, 1000, \`the candidate goes beside the published price, not over it: \${r.text}\`);
  const other = await c.get('/v1/prices/SKU-1', {headers: {'X-Operator-Scope': 'admin'}});
  const plain = await c.get('/v1/prices/SKU-1');
  assert(!('candidate' in other.json()) && !('candidate' in plain.json()), \`a caller without the preview scope saw the candidate: \${other.text} / \${plain.text}\`);
}

export async function check_provenance(ctx) {
  const {c, store} = read(ctx);
  await store.seed('SKU-1', 1000);
  ctx.clock.advance(30);
  const approved = await store.publish('SKU-1', 1100, 'weekend promo', 'operator');
  let body = (await c.get('/v1/prices/SKU-1')).json();
  assert(body.source === 'operator' && body.updated_at === approved.updated_at && body.stale === false, \`the read answered \${JSON.stringify(body)}, expected source operator, updated_at \${approved.updated_at} and stale false\`);
  ctx.clock.advance(600);
  await store.markStale('SKU-1'); // the demand model went down: the approved price is kept
  body = (await c.get('/v1/prices/SKU-1')).json();
  assert(body.stale === true && body.source === 'last-approved', \`a price kept while the model is down answered \${JSON.stringify(body)}: it must say stale true and source last-approved\`);
  assert.equal(body.updated_at, approved.updated_at, \`the kept price reports updated_at \${body.updated_at}, expected when it was approved, \${approved.updated_at}\`);
}

export async function check_guardrail_state(ctx) {
  const {c, store, guard} = read(ctx);
  await store.seed('SKU-1', 1000);
  await guard.reserve('SKU-1', 1000, 1150);
  const body = (await c.get('/v1/prices/SKU-1')).json();
  const want = {window: Math.floor(ctx.clock.now() / 1000 / 3600), moved_bp: 1500, limit_bp: 2000, headroom_bp: 500};
  assert.deepStrictEqual(body.guardrail, want, \`after a 15 % change the read's guardrail is \${JSON.stringify(body.guardrail)}, expected \${JSON.stringify(want)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"pricing/guard"
	"pricing/store"

	"leetbuild/harness"
)

var readBg = context.Background()

type readReply struct {
	PriceCents int64          \`json:"price_cents"\`
	Source     string         \`json:"source"\`
	UpdatedAt  int64          \`json:"updated_at"\`
	Stale      *bool          \`json:"stale"\`
	Guardrail  *guard.State   \`json:"guardrail"\`
	Candidate  map[string]any \`json:"candidate"\`
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func getPrice(c *harness.HTTP, sku string, header ...string) (*harness.Response, readReply) {
	r := c.Get("/v1/prices/"+sku, header...)
	var body readReply
	r.Decode(&body)
	return r, body
}

// experiment: SKU-1 published at 1000 while an experiment proposes 1150.
func experiment() {
	store.Seed(readBg, "SKU-1", 1000)
	store.SetCandidate(readBg, "SKU-1", 1150, "elasticity-v8")
}

func CheckRoute(ctx *harness.Ctx) {
	store.Seed(readBg, "SKU-1", 1000)
	r, body := getPrice(readAPI(ctx), "SKU-1")
	ctx.Equal(r.Status, 200, "GET /v1/prices/SKU-1 (%s)", r.Text())
	ctx.Equal(body.PriceCents, int64(1000), "the read's price_cents (%s)", r.Text())
}

func CheckPublishedOnly(ctx *harness.Ctx) {
	experiment()
	c := readAPI(ctx)
	r, body := getPrice(c, "SKU-1")
	ctx.Assert(r.Status == 200 && body.PriceCents == 1000, "the storefront read answered %s: 1150 is an experiment's candidate nobody approved, the published price is 1000", r.Text())
	r, body = getPrice(c, "SKU-1", "X-Operator-Scope", "preview")
	ctx.Equal(body.PriceCents, int64(1000), "an operator's price_cents must be the published price too (%s)", r.Text())
	missing, _ := getPrice(c, "SKU-404")
	ctx.Equal(missing.Status, 404, "a sku that does not exist (%s)", missing.Text())
}

func CheckPreviewScope(ctx *harness.Ctx) {
	experiment()
	c := readAPI(ctx)
	r, body := getPrice(c, "SKU-1", "X-Operator-Scope", "preview")
	ctx.Assert(body.Candidate != nil && body.Candidate["price_cents"] == 1150.0 && body.Candidate["model_version"] == "elasticity-v8", "an operator with X-Operator-Scope: preview got %s, expected candidate {price_cents: 1150, model_version: elasticity-v8} beside the price", r.Text())
	ctx.Equal(body.PriceCents, int64(1000), "the candidate goes beside the published price, not over it (%s)", r.Text())
	other, otherBody := getPrice(c, "SKU-1", "X-Operator-Scope", "admin")
	plain, plainBody := getPrice(c, "SKU-1")
	ctx.Assert(otherBody.Candidate == nil && plainBody.Candidate == nil, "a caller without the preview scope saw the candidate: %s / %s", other.Text(), plain.Text())
}

func CheckProvenance(ctx *harness.Ctx) {
	store.Seed(readBg, "SKU-1", 1000)
	ctx.Clock.Advance(30)
	approved := store.Publish(readBg, "SKU-1", 1100, "weekend promo", "operator")
	c := readAPI(ctx)
	r, body := getPrice(c, "SKU-1")
	ctx.Assert(body.Source == "operator" && body.UpdatedAt == approved.UpdatedAt && body.Stale != nil && !*body.Stale, "the read answered %s, expected source operator, updated_at %d and stale false", r.Text(), approved.UpdatedAt)
	ctx.Clock.Advance(600)
	store.MarkStale(readBg, "SKU-1") // the demand model went down: the approved price is kept
	r, body = getPrice(c, "SKU-1")
	ctx.Assert(body.Stale != nil && *body.Stale && body.Source == "last-approved", "a price kept while the model is down answered %s: it must say stale true and source last-approved", r.Text())
	ctx.Equal(body.UpdatedAt, approved.UpdatedAt, "the kept price must report when it was approved; updated_at")
}

func CheckGuardrailState(ctx *harness.Ctx) {
	store.Seed(readBg, "SKU-1", 1000)
	_, err := guard.Reserve(readBg, "SKU-1", 1000, 1150)
	ctx.NoError(err, "guard.Reserve")
	r, body := getPrice(readAPI(ctx), "SKU-1")
	want := guard.State{Window: ctx.Clock.Now() / 1000 / 3600, MovedBP: 1500, LimitBP: 2000, HeadroomBP: 500}
	ctx.Assert(body.Guardrail != nil && *body.Guardrail == want, "after a 15 %% change the read answered %s, expected guardrail %+v", r.Text(), want)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "pricing/guard.h"
#include "pricing/store.h"

namespace {

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json bodyOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

// SKU-1 published at 1000 while an experiment proposes 1150.
void experiment() {
  store::seed("SKU-1", 1000);
  store::setCandidate("SKU-1", 1150, "elasticity-v8");
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/prices/SKU-1");
  ctx.Equal(r.Status, 200, "GET /v1/prices/SKU-1 (%s)", r.Text());
  ctx.Assert(bodyOf(r).value("price_cents", nlohmann::json()) == 1000, "the read answered %s, expected price_cents 1000", r.Text());
}

void CheckPublishedOnly(harness::Ctx& ctx) {
  experiment();
  auto c = readApi(ctx);
  auto r = c.Get("/v1/prices/SKU-1");
  ctx.Assert(r.Status == 200 && bodyOf(r).value("price_cents", nlohmann::json()) == 1000, "the storefront read answered %s: 1150 is an experiment's candidate nobody approved, the published price is 1000", r.Text());
  r = c.Get("/v1/prices/SKU-1", "X-Operator-Scope", "preview");
  ctx.Assert(bodyOf(r).value("price_cents", nlohmann::json()) == 1000, "an operator's price_cents must be the published price too, got %s", r.Text());
  const auto missing = c.Get("/v1/prices/SKU-404");
  ctx.Equal(missing.Status, 404, "a sku that does not exist (%s)", missing.Text());
}

void CheckPreviewScope(harness::Ctx& ctx) {
  experiment();
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/prices/SKU-1", "X-Operator-Scope", "preview");
  const auto body = bodyOf(r);
  ctx.Assert(body.value("candidate", nlohmann::json()) == nlohmann::json{{"price_cents", 1150}, {"model_version", "elasticity-v8"}}, "an operator with X-Operator-Scope: preview got %s, expected candidate {price_cents: 1150, model_version: elasticity-v8} beside the price", r.Text());
  ctx.Assert(body.value("price_cents", nlohmann::json()) == 1000, "the candidate goes beside the published price, not over it: %s", r.Text());
  const auto other = c.Get("/v1/prices/SKU-1", "X-Operator-Scope", "admin");
  const auto plain = c.Get("/v1/prices/SKU-1");
  ctx.Assert(!bodyOf(other).contains("candidate") && !bodyOf(plain).contains("candidate"), "a caller without the preview scope saw the candidate: %s / %s", other.Text(), plain.Text());
}

void CheckProvenance(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  ctx.Clock.Advance(30);
  const store::Row approved = store::publish("SKU-1", 1100, "weekend promo", "operator");
  auto c = readApi(ctx);
  auto r = c.Get("/v1/prices/SKU-1");
  auto body = bodyOf(r);
  ctx.Assert(body.value("source", nlohmann::json()) == "operator" && body.value("updated_at", nlohmann::json()) == approved.updated_at && body.value("stale", nlohmann::json()) == false,
             "the read answered %s, expected source operator, updated_at %d and stale false", r.Text(), approved.updated_at);
  ctx.Clock.Advance(600);
  store::markStale("SKU-1");  // the demand model went down: the approved price is kept
  r = c.Get("/v1/prices/SKU-1");
  body = bodyOf(r);
  ctx.Assert(body.value("stale", nlohmann::json()) == true && body.value("source", nlohmann::json()) == "last-approved", "a price kept while the model is down answered %s: it must say stale true and source last-approved", r.Text());
  ctx.Assert(body.value("updated_at", nlohmann::json()) == approved.updated_at, "the kept price reports %s, expected updated_at %d, when it was approved", r.Text(), approved.updated_at);
}

void CheckGuardrailState(harness::Ctx& ctx) {
  store::seed("SKU-1", 1000);
  guard::reserve("SKU-1", 1000, 1150);
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/prices/SKU-1");
  const nlohmann::json want{{"window", ctx.Clock.Now() / 1000 / 3600}, {"moved_bp", 1500}, {"limit_bp", 2000}, {"headroom_bp", 500}};
  ctx.Assert(bodyOf(r).value("guardrail", nlohmann::json()) == want, "after a 15 %% change the read answered %s, expected guardrail %s", r.Text(), want.dump());
}
`,
  },
  hints: [
    'Load a sku while an experiment is running: the storefront shows the candidate price. Ask for a sku that does not exist: 200 with a null price.',
    "The starter takes `candidate_of(sku) or get_sku(sku)`, so any candidate wins for every caller, and it labels the answer with a constant model version instead of the row's own source, timestamp and stale flag.",
    '`store.get_sku` → 404 on None; answer `price_cents`, `source`, `updated_at`, `stale` and `guardrail: guard.window_state(sku)`; add `candidate` only when `X-Operator-Scope` equals `PREVIEW_SCOPE`.',
  ],
  debrief: `The published row is the only price a customer can be charged, so it is what every caller reads; the candidate rides beside it for the people running the experiment, which lets an operator compare the two numbers instead of seeing one replace the other. Provenance comes from the row the earlier steps wrote: \`source\` and \`stale\` tell a decided price from one kept through an outage, and \`updated_at\` says when it was decided. The guardrail block answers "why was my change refused" without anyone opening Redis. In production the storefront path sits behind a cache keyed by sku with a short TTL, and the scope header is trusted only because the gateway sets it after login and strips it from public traffic.`,
};
