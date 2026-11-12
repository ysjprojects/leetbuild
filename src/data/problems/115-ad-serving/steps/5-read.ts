import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/campaigns/{id}/delivery: render counts and a projection',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['advertiser', 'server', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/campaigns/{campaign_id}/delivery\` for the
advertiser console: it loads the campaign with \`store.get_campaign\` (**404** when there is none),
derives \`impressions\` and \`spend_micros\` from the pacing counter \`store.spent\`, and answers
\`{"campaign_id", "campaign_version", "counted_at": "serve", "impressions", "spend_micros",
"under_delivery_impressions"}\` with the shortfall as \`goal_impressions - impressions\`. It serves
the demo and hides three flaws.

**Failure mode the checks target.** Any advertiser reads any campaign's delivery, the report bills
ads that were served but did not render, and every campaign looks behind on its first morning.

- \`X-Advertiser-Id\` is required (**401**); a campaign whose \`advertiser_id\` differs is **403**.
- \`impressions\` and \`spend_micros\` come from \`store.rendered\` (step 4's render counter), with
  \`counted_at: "render"\`.
- \`under_delivery_impressions\` is \`goal_impressions\` minus the projection
  \`impressions × (end_ts − start_ts) ÷ elapsed\`, where \`elapsed\` runs from \`start_ts\` to now (at
  most to \`end_ts\`, at least 1 s), floored at 0.`,
  sequence: {
    participants: ['Advertiser console', 'Ad Server', 'campaign store', 'Redis'],
    messages: [
      {
        from: 'Advertiser console',
        to: 'Ad Server',
        label: 'GET /v1/campaigns/{id}/delivery · X-Advertiser-Id',
        kind: 'sync',
      },
      {from: 'Ad Server', to: 'campaign store', label: 'get_campaign(id)', kind: 'sync'},
      {from: 'campaign store', to: 'Ad Server', label: 'advertiser_id · version · goal · flight', kind: 'reply'},
      {
        from: 'Ad Server',
        to: 'Advertiser console',
        label: '401 no caller · 404 unknown · 403 not yours',
        kind: 'reply',
      },
      {from: 'Ad Server', to: 'Redis', label: 'HGETALL render:{id}', kind: 'sync'},
      {from: 'Redis', to: 'Ad Server', label: 'impressions · spend counted at render', kind: 'reply'},
      {from: 'Ad Server', to: 'Advertiser console', label: '200 {counted_at render, under_delivery}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Answers GET /v1/campaigns/{id}/delivery',
      detail: 'The owner of a campaign gets 200 with the campaign id and its version; an unknown campaign is 404.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/campaigns\/\{campaign_id\}\/delivery["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/campaigns\/:campaignId\/delivery['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/campaigns\/\{id\}\/delivery"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"campaigns"\s*\/\s*Segment\s*\/\s*"delivery"\s*\)/, /\bget\b/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/campaigns\//]},
      },
    },
    {
      id: 'advertiser-scope',
      title: 'Answers only the advertiser who owns the campaign',
      detail:
        'A request without `X-Advertiser-Id` is **401**, and one from an advertiser other than the campaign’s `advertiser_id` is **403**, so no account reads another’s delivery. The starter answers anyone.',
      match: {
        python: {
          all: [/x-advertiser-id/i, /\[["']advertiser_id["']\]/, /status_code\s*=\s*401/, /status_code\s*=\s*403/],
        },
        typescript: {all: [/x-advertiser-id/i, /\.advertiser_id\b/, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Advertiser-Id/i, /\.AdvertiserID\b/, /StatusUnauthorized/, /StatusForbidden/]},
        scala: {all: [/X-Advertiser-Id/i, /\.advertiserId\b/, /StatusCodes\.Unauthorized/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/X-Advertiser-Id/i, /(\.|->)advertiser_id\b/, /\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'render-counts',
      title: 'Reports what rendered, not what was served',
      detail:
        '`impressions` and `spend_micros` come from `render:{id}` through `store.rendered`, and `counted_at` is `render`. The starter divides the pacing counter, which also holds serves that never rendered, by the bid.',
      match: {
        python: {all: [/store\.rendered\(/, /["']counted_at["']\s*:\s*["']render["']/], none: [/store\.spent\(/]},
        typescript: {all: [/\brendered\(/, /counted_at:\s*['"]render['"]/], none: [/\bspent\(/]},
        go: {all: [/store\.RenderedOf\(/, /"counted_at":\s*"render"/], none: [/store\.Spent\(/]},
        scala: {all: [/Store\.rendered\(/, /"counted_at"\s*->\s*JsString\("render"\)/], none: [/Store\.spent\(/]},
        cpp: {all: [/store::rendered\(/, /\{"counted_at",\s*"render"\}/], none: [/store::spent\(/]},
      },
    },
    {
      id: 'under-delivery',
      title: 'Projects under-delivery from the pace so far',
      detail:
        'The shortfall is the goal minus the impressions projected over the whole flight at the rate since `start_ts`, so a campaign on pace shows 0 at mid-flight and one behind shows its real gap. The starter subtracts the impressions so far, which flags every campaign that has just started.',
      match: {
        python: {all: [/time\.time\(\)|datetime\.now\(/, /start_ts/, /end_ts/]},
        typescript: {all: [/Date\.now\(\)/, /start_ts/, /end_ts/]},
        go: {all: [/time\.Now\(\)/, /StartTs/, /EndTs/]},
        scala: {all: [/System\.currentTimeMillis\(\)|Instant\.now\(\)/, /startTs/, /endTs/]},
        cpp: {all: [/system_clock::now\(\)/, /start_ts/, /end_ts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ads import store  # store.get_campaign, store.rendered, store.spent

app = FastAPI()


@app.get("/v1/campaigns/{campaign_id}/delivery")
def delivery(campaign_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    campaign = store.get_campaign(campaign_id)
    if campaign is None:
        return JSONResponse({"error": "no such campaign"}, status_code=404)
    spend = store.spent(campaign_id)
    impressions = spend // campaign["bid_micros"]
    return JSONResponse({
        "campaign_id": campaign_id,
        "campaign_version": campaign["version"],
        "counted_at": "serve",
        "impressions": impressions,
        "spend_micros": spend,
        "under_delivery_impressions": max(0, campaign["goal_impressions"] - impressions),
    })
`,
      solution: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ads import store  # store.get_campaign, store.rendered, store.spent

app = FastAPI()


@app.get("/v1/campaigns/{campaign_id}/delivery")
def delivery(campaign_id: str, request: Request) -> JSONResponse:
    advertiser = request.headers.get("x-advertiser-id", "")
    if advertiser == "":
        return JSONResponse({"error": "X-Advertiser-Id is required"}, status_code=401)
    campaign = store.get_campaign(campaign_id)
    if campaign is None:
        return JSONResponse({"error": "no such campaign"}, status_code=404)
    if campaign["advertiser_id"] != advertiser:
        return JSONResponse({"error": "the campaign belongs to another advertiser"}, status_code=403)
    # What the advertiser pays for: impressions the pages reported as rendered.
    counted = store.rendered(campaign_id)
    # The rate so far, carried over the whole flight: a campaign on pace projects its goal.
    flight = campaign["end_ts"] - campaign["start_ts"]
    elapsed = max(1, min(int(time.time()), campaign["end_ts"]) - campaign["start_ts"])
    projected = counted["impressions"] * flight // elapsed
    return JSONResponse({
        "campaign_id": campaign_id,
        "campaign_version": campaign["version"],
        "counted_at": "render",
        "impressions": counted["impressions"],
        "spend_micros": counted["spend_micros"],
        "under_delivery_impressions": max(0, campaign["goal_impressions"] - projected),
    })
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {getCampaign, rendered, spent} from 'ads/store';

export const app = Fastify();

app.get('/v1/campaigns/:campaignId/delivery', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {campaignId} = request.params as {campaignId: string};
  const campaign = await getCampaign(campaignId);
  if (campaign === null) return reply.code(404).send({error: 'no such campaign'});
  const spend = await spent(campaignId);
  const impressions = Math.floor(spend / campaign.bid_micros);
  return {
    campaign_id: campaignId,
    campaign_version: campaign.version,
    counted_at: 'serve',
    impressions,
    spend_micros: spend,
    under_delivery_impressions: Math.max(0, campaign.goal_impressions - impressions),
  };
});
`,
      solution: `import Fastify from 'fastify';

import {getCampaign, rendered, spent} from 'ads/store';

export const app = Fastify();

app.get('/v1/campaigns/:campaignId/delivery', async (request, reply) => {
  const {campaignId} = request.params as {campaignId: string};
  const advertiser = request.headers['x-advertiser-id'];
  if (typeof advertiser !== 'string' || advertiser === '') return reply.code(401).send({error: 'X-Advertiser-Id is required'});
  const campaign = await getCampaign(campaignId);
  if (campaign === null) return reply.code(404).send({error: 'no such campaign'});
  if (campaign.advertiser_id !== advertiser) return reply.code(403).send({error: 'the campaign belongs to another advertiser'});
  // What the advertiser pays for: impressions the pages reported as rendered.
  const counted = await rendered(campaignId);
  // The rate so far, carried over the whole flight: a campaign on pace projects its goal.
  const flight = campaign.end_ts - campaign.start_ts;
  const elapsed = Math.max(1, Math.min(Math.floor(Date.now() / 1000), campaign.end_ts) - campaign.start_ts);
  const projected = Math.floor((counted.impressions * flight) / elapsed);
  return {
    campaign_id: campaignId,
    campaign_version: campaign.version,
    counted_at: 'render',
    impressions: counted.impressions,
    spend_micros: counted.spend_micros,
    under_delivery_impressions: Math.max(0, campaign.goal_impressions - projected),
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"ads/store" // store.GetCampaign, store.RenderedOf, store.Spent
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func delivery(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	campaignID := r.PathValue("id")
	campaign := store.GetCampaign(r.Context(), campaignID)
	if campaign == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such campaign"})
		return
	}
	spend := store.Spent(r.Context(), campaignID)
	impressions := spend / campaign.BidMicros
	writeJSON(rw, http.StatusOK, map[string]any{
		"campaign_id":                campaignID,
		"campaign_version":           campaign.Version,
		"counted_at":                 "serve",
		"impressions":                impressions,
		"spend_micros":               spend,
		"under_delivery_impressions": max(0, campaign.GoalImpressions-impressions),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/campaigns/{id}/delivery", delivery)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"ads/store" // store.GetCampaign, store.RenderedOf, store.Spent
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func delivery(rw http.ResponseWriter, r *http.Request) {
	campaignID := r.PathValue("id")
	advertiser := r.Header.Get("X-Advertiser-Id")
	if advertiser == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Advertiser-Id is required"})
		return
	}
	campaign := store.GetCampaign(r.Context(), campaignID)
	if campaign == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such campaign"})
		return
	}
	if campaign.AdvertiserID != advertiser {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "the campaign belongs to another advertiser"})
		return
	}
	// What the advertiser pays for: impressions the pages reported as rendered.
	counted := store.RenderedOf(r.Context(), campaignID)
	// The rate so far, carried over the whole flight: a campaign on pace projects its goal.
	flight := campaign.EndTs - campaign.StartTs
	elapsed := max(1, min(time.Now().Unix(), campaign.EndTs)-campaign.StartTs)
	projected := counted.Impressions * flight / elapsed
	writeJSON(rw, http.StatusOK, map[string]any{
		"campaign_id":                campaignID,
		"campaign_version":           campaign.Version,
		"counted_at":                 "render",
		"impressions":                counted.Impressions,
		"spend_micros":               counted.SpendMicros,
		"under_delivery_impressions": max(0, campaign.GoalImpressions-projected),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/campaigns/{id}/delivery", delivery)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import ads.Store // Store.getCampaign, Store.rendered, Store.spent

object Read {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "campaigns" / Segment / "delivery") { campaignId =>
    get {
      // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
      Store.getCampaign(campaignId) match {
        case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such campaign"))))
        case Some(campaign) =>
          val spend = Store.spent(campaignId)
          val impressions = spend / campaign.bidMicros
          complete(
            json(
              StatusCodes.OK,
              JsObject(
                "campaign_id" -> JsString(campaignId),
                "campaign_version" -> JsNumber(campaign.version),
                "counted_at" -> JsString("serve"),
                "impressions" -> JsNumber(impressions),
                "spend_micros" -> JsNumber(spend),
                "under_delivery_impressions" -> JsNumber(math.max(0L, campaign.goalImpressions - impressions))
              )
            )
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

import ads.Store // Store.getCampaign, Store.rendered, Store.spent

object Read {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, why: String) = complete(json(status, JsObject("error" -> JsString(why))))

  val route: Route = path("v1" / "campaigns" / Segment / "delivery") { campaignId =>
    get {
      optionalHeaderValueByName("X-Advertiser-Id") { advertiser =>
        (advertiser.filter(_.nonEmpty), Store.getCampaign(campaignId)) match {
          case (None, _) => error(StatusCodes.Unauthorized, "X-Advertiser-Id is required")
          case (_, None) => error(StatusCodes.NotFound, "no such campaign")
          case (Some(caller), Some(campaign)) if campaign.advertiserId != caller =>
            error(StatusCodes.Forbidden, "the campaign belongs to another advertiser")
          case (_, Some(campaign)) =>
            // What the advertiser pays for: impressions the pages reported as rendered.
            val counted = Store.rendered(campaignId)
            // The rate so far, carried over the whole flight: a campaign on pace projects its goal.
            val flight = campaign.endTs - campaign.startTs
            val elapsed = math.max(1L, math.min(System.currentTimeMillis() / 1000, campaign.endTs) - campaign.startTs)
            val projected = counted.impressions * flight / elapsed
            complete(
              json(
                StatusCodes.OK,
                JsObject(
                  "campaign_id" -> JsString(campaignId),
                  "campaign_version" -> JsNumber(campaign.version),
                  "counted_at" -> JsString("render"),
                  "impressions" -> JsNumber(counted.impressions),
                  "spend_micros" -> JsNumber(counted.spendMicros),
                  "under_delivery_impressions" -> JsNumber(math.max(0L, campaign.goalImpressions - projected))
                )
              )
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

#include <algorithm>
#include <string>

#include "ads/store.h"  // store::getCampaign, store::rendered, store::spent

using json = nlohmann::json;

void delivery(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string campaign_id = req.matches[1];
  const auto campaign = store::getCampaign(campaign_id);
  if (!campaign) {
    res.status = 404;
    res.set_content(json{{"error", "no such campaign"}}.dump(), "application/json");
    return;
  }
  const long long spend = store::spent(campaign_id);
  const long long impressions = spend / campaign->bid_micros;
  res.set_content(json{{"campaign_id", campaign_id},
                       {"campaign_version", campaign->version},
                       {"counted_at", "serve"},
                       {"impressions", impressions},
                       {"spend_micros", spend},
                       {"under_delivery_impressions", std::max(0LL, campaign->goal_impressions - impressions)}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/campaigns/([\\w-]+)/delivery)", delivery); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <string>

#include "ads/store.h"  // store::getCampaign, store::rendered, store::spent

using json = nlohmann::json;

void fail(httplib::Response& res, int status, const std::string& why) {
  res.status = status;
  res.set_content(json{{"error", why}}.dump(), "application/json");
}

void delivery(const httplib::Request& req, httplib::Response& res) {
  const std::string campaign_id = req.matches[1];
  const std::string advertiser = req.get_header_value("X-Advertiser-Id");
  if (advertiser.empty()) return fail(res, 401, "X-Advertiser-Id is required");
  const auto campaign = store::getCampaign(campaign_id);
  if (!campaign) return fail(res, 404, "no such campaign");
  if (campaign->advertiser_id != advertiser) return fail(res, 403, "the campaign belongs to another advertiser");
  // What the advertiser pays for: impressions the pages reported as rendered.
  const store::Rendered counted = store::rendered(campaign_id);
  // The rate so far, carried over the whole flight: a campaign on pace projects its goal.
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long flight = campaign->end_ts - campaign->start_ts;
  const long long elapsed = std::max(1LL, std::min(now, campaign->end_ts) - campaign->start_ts);
  const long long projected = counted.impressions * flight / elapsed;
  res.set_content(json{{"campaign_id", campaign_id},
                       {"campaign_version", campaign->version},
                       {"counted_at", "render"},
                       {"impressions", counted.impressions},
                       {"spend_micros", counted.spend_micros},
                       {"under_delivery_impressions", std::max(0LL, campaign->goal_impressions - projected)}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/campaigns/([\\w-]+)/delivery)", delivery); }
`,
    },
  },
  harness: {
    python: `from ads import store

OWNER = {"X-Advertiser-Id": "adv-1"}


def _read(ctx, **fields):
    """Campaign c-1 of adv-1, half-way through a one-day flight with a goal of 1000 impressions."""
    now = int(ctx.clock.time())
    campaign = {
        "campaign_id": "c-1", "advertiser_id": "adv-1", "version": 3, "state": "active", "placement": "home-top",
        "creative_id": "cr-c-1", "bid_micros": 1500, "freq_cap": 3, "freq_window_s": 3600, "paced_budget_micros": 10_000_000,
        "goal_impressions": 1000, "start_ts": now - 43200, "end_ts": now + 43200,
    }
    campaign.update(fields)
    store.put_campaign(campaign)
    return ctx.client(ctx.load("read").app)


async def check_route(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/campaigns/c-1/delivery", headers=OWNER)
        assert r.status_code == 200, f"GET /v1/campaigns/c-1/delivery answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("campaign_id") == "c-1" and body.get("campaign_version") == 3, f"the report must name c-1 and its version 3, got {body}"
        r = await c.get("/v1/campaigns/c-404/delivery", headers=OWNER)
    assert r.status_code == 404, f"an unknown campaign answered {r.status_code} {r.text}, expected 404"


async def check_advertiser_scope(ctx):
    async with _read(ctx) as c:
        anonymous = await c.get("/v1/campaigns/c-1/delivery")
        assert anonymous.status_code == 401, f"a request without X-Advertiser-Id answered {anonymous.status_code} {anonymous.text}, expected 401"
        rival = await c.get("/v1/campaigns/c-1/delivery", headers={"X-Advertiser-Id": "adv-2"})
        assert rival.status_code == 403, f"adv-2 asked for adv-1's campaign and got {rival.status_code} {rival.text}: one account must not read another's delivery. Expected 403"
        owner = await c.get("/v1/campaigns/c-1/delivery", headers=OWNER)
    assert owner.status_code == 200, f"the owner adv-1 got {owner.status_code} {owner.text}"


async def check_render_counts(ctx):
    client = _read(ctx)
    ctx.redis.set("pace:c-1", 9000)  # six serves reserved at 1500 micros
    ctx.redis.hset("render:c-1", mapping={"impressions": 4, "spend_micros": 6000})  # four of them rendered
    async with client as c:
        r = await c.get("/v1/campaigns/c-1/delivery", headers=OWNER)
    assert r.status_code == 200, f"the owner got {r.status_code} {r.text}"
    body = r.json()
    got = {k: body.get(k) for k in ("counted_at", "impressions", "spend_micros")}
    want = {"counted_at": "render", "impressions": 4, "spend_micros": 6000}
    assert got == want, f"six ads were served and four rendered; the report says {got}, expected {want}: the advertiser pays for what rendered"


async def check_under_delivery(ctx):
    client = _read(ctx)
    async with client as c:
        ctx.redis.hset("render:c-1", mapping={"impressions": 500, "spend_micros": 750_000})
        on_pace = (await c.get("/v1/campaigns/c-1/delivery", headers=OWNER)).json().get("under_delivery_impressions")
        assert on_pace == 0, f"half-way through the flight with 500 of 1000 impressions the campaign is on pace, the report says {on_pace} short"
        ctx.redis.hset("render:c-1", mapping={"impressions": 400, "spend_micros": 600_000})
        behind = (await c.get("/v1/campaigns/c-1/delivery", headers=OWNER)).json().get("under_delivery_impressions")
        assert behind == 200, f"half-way through with 400 of 1000 the campaign projects 800, the report says {behind} short, expected 200"
        ctx.clock.advance(86400)  # the flight is over
        ended = (await c.get("/v1/campaigns/c-1/delivery", headers=OWNER)).json().get("under_delivery_impressions")
    assert ended == 600, f"after the flight ended with 400 of 1000 the report says {ended} short, expected 600: the projection stops at end_ts"
`,
    typescript: `const OWNER = {'X-Advertiser-Id': 'adv-1'};

/** Campaign c-1 of adv-1, half-way through a one-day flight with a goal of 1000 impressions. */
async function read(ctx) {
  const store = ctx.load('/support/ads/store.ts');
  const now = Math.floor(ctx.clock.now() / 1000);
  await store.putCampaign({
    campaign_id: 'c-1',
    advertiser_id: 'adv-1',
    version: 3,
    state: 'active',
    placement: 'home-top',
    creative_id: 'cr-c-1',
    bid_micros: 1500,
    freq_cap: 3,
    freq_window_s: 3600,
    paced_budget_micros: 10000000,
    goal_impressions: 1000,
    start_ts: now - 43200,
    end_ts: now + 43200,
  });
  return ctx.client(ctx.load('read').app);
}

const shortfall = async c => (await c.get('/v1/campaigns/c-1/delivery', {headers: OWNER})).json().under_delivery_impressions;

export async function check_route(ctx) {
  const c = await read(ctx);
  let r = await c.get('/v1/campaigns/c-1/delivery', {headers: OWNER});
  assert.equal(r.status, 200, \`GET /v1/campaigns/c-1/delivery answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.campaign_id === 'c-1' && body.campaign_version === 3, \`the report must name c-1 and its version 3, got \${r.text}\`);
  r = await c.get('/v1/campaigns/c-404/delivery', {headers: OWNER});
  assert.equal(r.status, 404, \`an unknown campaign answered \${r.status} \${r.text}, expected 404\`);
}

export async function check_advertiser_scope(ctx) {
  const c = await read(ctx);
  const anonymous = await c.get('/v1/campaigns/c-1/delivery');
  assert.equal(anonymous.status, 401, \`a request without X-Advertiser-Id answered \${anonymous.status} \${anonymous.text}, expected 401\`);
  const rival = await c.get('/v1/campaigns/c-1/delivery', {headers: {'X-Advertiser-Id': 'adv-2'}});
  assert.equal(rival.status, 403, \`adv-2 asked for adv-1's campaign and got \${rival.status} \${rival.text}: one account must not read another's delivery. Expected 403\`);
  const owner = await c.get('/v1/campaigns/c-1/delivery', {headers: OWNER});
  assert.equal(owner.status, 200, \`the owner adv-1 got \${owner.status} \${owner.text}\`);
}

export async function check_render_counts(ctx) {
  const c = await read(ctx);
  ctx.redis.set('pace:c-1', '9000'); // six serves reserved at 1500 micros
  ctx.redis.hset('render:c-1', 'impressions', '4', 'spend_micros', '6000'); // four of them rendered
  const r = await c.get('/v1/campaigns/c-1/delivery', {headers: OWNER});
  assert.equal(r.status, 200, \`the owner got \${r.status} \${r.text}\`);
  const {counted_at, impressions, spend_micros} = r.json();
  const got = {counted_at, impressions, spend_micros};
  assert.deepStrictEqual(got, {counted_at: 'render', impressions: 4, spend_micros: 6000}, \`six ads were served and four rendered; the report says \${JSON.stringify(got)}: the advertiser pays for what rendered\`);
}

export async function check_under_delivery(ctx) {
  const c = await read(ctx);
  ctx.redis.hset('render:c-1', 'impressions', '500', 'spend_micros', '750000');
  const onPace = await shortfall(c);
  assert.equal(onPace, 0, \`half-way through the flight with 500 of 1000 impressions the campaign is on pace, the report says \${onPace} short\`);
  ctx.redis.hset('render:c-1', 'impressions', '400', 'spend_micros', '600000');
  const behind = await shortfall(c);
  assert.equal(behind, 200, \`half-way through with 400 of 1000 the campaign projects 800, the report says \${behind} short, expected 200\`);
  ctx.clock.advance(86400); // the flight is over
  const ended = await shortfall(c);
  assert.equal(ended, 600, \`after the flight ended with 400 of 1000 the report says \${ended} short, expected 600: the projection stops at end_ts\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"ads/store"

	"leetbuild/harness"
)

func readClient(ctx *harness.Ctx) *harness.HTTP {
	now := ctx.Clock.Now() / 1000
	store.PutCampaign(context.Background(), store.Campaign{
		CampaignID: "c-1", AdvertiserID: "adv-1", Version: 3, State: "active", Placement: "home-top", CreativeID: "cr-c-1",
		BidMicros: 1500, FreqCap: 3, FreqWindowS: 3600, PacedBudgetMicros: 10000000, GoalImpressions: 1000,
		StartTs: now - 43200, EndTs: now + 43200,
	})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	ctx.Equal(r.Status, 200, "the owner's delivery read (%s)", r.Text())
	body, _ := r.JSON().(map[string]any)
	return body
}

func readShortfall(ctx *harness.Ctx, c *harness.HTTP) any {
	return readBody(ctx, c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-1"))["under_delivery_impressions"]
}

func CheckRoute(ctx *harness.Ctx) {
	c := readClient(ctx)
	body := readBody(ctx, c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-1"))
	ctx.Assert(body["campaign_id"] == "c-1" && body["campaign_version"] == float64(3), "the report must name c-1 and its version 3, got %v", body)
	r := c.Get("/v1/campaigns/c-404/delivery", "X-Advertiser-Id", "adv-1")
	ctx.Equal(r.Status, 404, "an unknown campaign (%s)", r.Text())
}

func CheckAdvertiserScope(ctx *harness.Ctx) {
	c := readClient(ctx)
	anonymous := c.Get("/v1/campaigns/c-1/delivery")
	ctx.Equal(anonymous.Status, 401, "a request without X-Advertiser-Id answered %s; the status", anonymous.Text())
	rival := c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-2")
	ctx.Equal(rival.Status, 403, "adv-2 asked for adv-1's campaign and got %s: one account must not read another's delivery; the status", rival.Text())
	owner := c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-1")
	ctx.Equal(owner.Status, 200, "the owner adv-1 (%s)", owner.Text())
}

func CheckRenderCounts(ctx *harness.Ctx) {
	c := readClient(ctx)
	ctx.Redis.Set("pace:c-1", "9000")                                         // six serves reserved at 1500 micros
	ctx.Redis.Do("HSET", "render:c-1", "impressions", "4", "spend_micros", "6000") // four of them rendered
	body := readBody(ctx, c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-1"))
	got := map[string]any{"counted_at": body["counted_at"], "impressions": body["impressions"], "spend_micros": body["spend_micros"]}
	ctx.Equal(got, map[string]any{"counted_at": "render", "impressions": 4, "spend_micros": 6000}, "six ads were served and four rendered: the advertiser pays for what rendered; the report")
}

func CheckUnderDelivery(ctx *harness.Ctx) {
	c := readClient(ctx)
	ctx.Redis.Do("HSET", "render:c-1", "impressions", "500", "spend_micros", "750000")
	ctx.Equal(readShortfall(ctx, c), 0, "half-way through the flight with 500 of 1000 impressions the campaign is on pace; under_delivery_impressions")
	ctx.Redis.Do("HSET", "render:c-1", "impressions", "400", "spend_micros", "600000")
	ctx.Equal(readShortfall(ctx, c), 200, "half-way through with 400 of 1000 the campaign projects 800; under_delivery_impressions")
	ctx.Clock.Advance(86400) // the flight is over
	ctx.Equal(readShortfall(ctx, c), 600, "after the flight ended with 400 of 1000 the projection stops at end_ts; under_delivery_impressions")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "ads/store.h"

namespace {

harness::HTTP readClient(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  store::Campaign c;
  c.campaign_id = "c-1";
  c.advertiser_id = "adv-1";
  c.version = 3;
  c.state = "active";
  c.placement = "home-top";
  c.creative_id = "cr-c-1";
  c.bid_micros = 1500;
  c.freq_cap = 3;
  c.freq_window_s = 3600;
  c.paced_budget_micros = 10000000;
  c.goal_impressions = 1000;
  c.start_ts = now - 43200;
  c.end_ts = now + 43200;
  store::putCampaign(c);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json readBody(harness::Ctx& ctx, const harness::Response& r) {
  ctx.Equal(r.Status, 200, "the owner's delivery read (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the delivery read must answer a JSON object, got %s", r.Text());
  return body;
}

long long readShortfall(harness::Ctx& ctx, harness::HTTP& c) {
  const auto body = readBody(ctx, c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-1"));
  return body.value("under_delivery_impressions", -1LL);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  const auto body = readBody(ctx, c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-1"));
  ctx.Assert(body.value("campaign_id", std::string()) == "c-1" && body.value("campaign_version", 0LL) == 3, "the report must name c-1 and its version 3, got %s", body.dump());
  const auto r = c.Get("/v1/campaigns/c-404/delivery", "X-Advertiser-Id", "adv-1");
  ctx.Equal(r.Status, 404, "an unknown campaign (%s)", r.Text());
}

void CheckAdvertiserScope(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  const auto anonymous = c.Get("/v1/campaigns/c-1/delivery");
  ctx.Equal(anonymous.Status, 401, "a request without X-Advertiser-Id answered %s; the status", anonymous.Text());
  const auto rival = c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-2");
  ctx.Equal(rival.Status, 403, "adv-2 asked for adv-1's campaign and got %s: one account must not read another's delivery; the status", rival.Text());
  const auto owner = c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-1");
  ctx.Equal(owner.Status, 200, "the owner adv-1 (%s)", owner.Text());
}

void CheckRenderCounts(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  ctx.Redis.Set("pace:c-1", "9000");                                             // six serves reserved at 1500 micros
  ctx.Redis.Do("HSET", "render:c-1", "impressions", "4", "spend_micros", "6000");  // four of them rendered
  const auto body = readBody(ctx, c.Get("/v1/campaigns/c-1/delivery", "X-Advertiser-Id", "adv-1"));
  ctx.Assert(body.value("counted_at", std::string()) == "render" && body.value("impressions", -1LL) == 4 && body.value("spend_micros", -1LL) == 6000,
             "six ads were served and four rendered; the report says %s, expected counted_at render, impressions 4, spend_micros 6000: the advertiser pays for what rendered",
             body.dump());
}

void CheckUnderDelivery(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  ctx.Redis.Do("HSET", "render:c-1", "impressions", "500", "spend_micros", "750000");
  ctx.Equal(readShortfall(ctx, c), 0, "half-way through the flight with 500 of 1000 impressions the campaign is on pace; under_delivery_impressions");
  ctx.Redis.Do("HSET", "render:c-1", "impressions", "400", "spend_micros", "600000");
  ctx.Equal(readShortfall(ctx, c), 200, "half-way through with 400 of 1000 the campaign projects 800; under_delivery_impressions");
  ctx.Clock.Advance(86400);  // the flight is over
  ctx.Equal(readShortfall(ctx, c), 600, "after the flight ended with 400 of 1000 the projection stops at end_ts; under_delivery_impressions");
}
`,
  },
  hints: [
    'Open another advertiser’s campaign id and its report comes back; a campaign whose pages failed to render shows the serves as delivered; a campaign started this morning reports most of its goal as missing.',
    'The handler does not read `X-Advertiser-Id`, takes impressions from the pacing counter (reserved at serve, rendered or not), and subtracts them from the goal as if the flight were over.',
    '401 without the header, 403 when `advertiser_id` differs; read `store.rendered`, answer `counted_at: "render"`; project `impressions * (end_ts - start_ts) // elapsed` with `elapsed` from `start_ts` to `min(now, end_ts)`.',
  ],
  debrief: `A delivery report is a billing document, so it reads the counter the bill uses (impressions that rendered) and says so in \`counted_at\`, rather than the reservation counter that also holds serves the page never showed. The ownership check comes before any counter is read, because a report that leaks across accounts is worse than a slow one. A straight-line projection is the simplest forecast that is right for an even pacing plan: on pace means projected equals goal, so the alarm only fires for campaigns that are actually behind. Production reports project against the pacing curve (frontloaded or traffic-shaped), separate house fallbacks and invalid traffic from billable impressions, and refresh from the event stream rather than reading live counters on every request.`,
};
