import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/ads/serve: limits before ranking',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'server', 'db', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/ads/serve\` with body
\`{"placement", "user_hash", "format"}\`: it loads every campaign of the placement with
\`store.campaigns_for\`, takes the highest \`bid_micros\` and answers
\`{"ad": {"campaign_id", "creative_id", "price_micros"}}\`, or
\`{"ad": null, "reason": "no_eligible_campaign"}\` when the placement has none. It serves the demo
and hides four flaws.

**Failure mode the checks target.** A malformed request is answered with an ad; a paused campaign
and one whose pacing budget is spent keep winning; one user sees the top bidder on every page; and a
delivery report cannot tell which campaign version a serve used.

- \`placement\` is 1 to \`MAX_PLACEMENT_CHARS\` (64) characters, \`user_hash\` is non-empty and
  \`format\` is one of \`ALLOWED_FORMATS\`; anything else is **400**.
- A campaign competes only when its \`state\` is \`active\`, when
  \`store.spent(id) + bid_micros <= paced_budget_micros\`, and when
  \`store.frequency(id, user_hash) < freq_cap\`.
- The highest bid among those wins, and the response carries its \`campaign_version\`.`,
  sequence: {
    participants: ['Page', 'Ad Server', 'campaign store', 'Redis'],
    messages: [
      {from: 'Page', to: 'Ad Server', label: 'POST /v1/ads/serve · placement · user_hash · format', kind: 'sync'},
      {from: 'Ad Server', to: 'Page', label: '400 when the request is malformed', kind: 'reply'},
      {from: 'Ad Server', to: 'campaign store', label: 'campaigns_for(placement)', kind: 'sync'},
      {from: 'campaign store', to: 'Ad Server', label: 'campaigns · state · version · caps', kind: 'reply'},
      {from: 'Ad Server', to: 'Redis', label: 'GET pace:{id} · GET freq:{id}:{user}', kind: 'sync'},
      {from: 'Redis', to: 'Ad Server', label: 'spent · impressions in the window', kind: 'reply'},
      {from: 'Ad Server', to: 'Page', label: '200 {ad, campaign_version} / no_eligible_campaign', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves the highest bid on POST /v1/ads/serve',
      detail: 'A valid request for a placement with one active campaign answers 200 with that campaign’s ad.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/ads\/serve["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/ads\/serve['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/ads\/serve"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"ads"\s*\/\s*"serve"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/ads\/serve"/]},
      },
    },
    {
      id: 'request-guard',
      title: 'Rejects a malformed request with 400',
      detail:
        'An empty or 65-character `placement`, a missing or empty `user_hash`, and a `format` outside `ALLOWED_FORMATS` are each **400** before any campaign is read. The starter answers them with an ad.',
      match: {
        python: {all: [/[<>]=?\s*MAX_PLACEMENT_CHARS/, /\bin ALLOWED_FORMATS/, /status_code\s*=\s*400/]},
        typescript: {all: [/[<>]=?\s*MAX_PLACEMENT_CHARS/, /ALLOWED_FORMATS\.includes\(/, /code\(\s*400\s*\)/]},
        go: {all: [/[<>]=?\s*maxPlacementChars/, /allowedFormats\[/, /StatusBadRequest/]},
        scala: {all: [/[<>]=?\s*MaxPlacementChars/, /AllowedFormats\.contains\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/[<>]=?\s*kMaxPlacementChars/, /kAllowedFormats\.(count|find|contains)\(/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'eligibility',
      title: 'Leaves paused and spent campaigns out of the auction',
      detail:
        'A campaign whose `state` is not `active`, or whose `store.spent(id) + bid_micros` exceeds `paced_budget_micros`, does not compete; when none is left the answer is `{"ad": null, "reason": "no_eligible_campaign"}`. The starter ranks every campaign of the placement.',
      match: {
        python: {all: [/\[["']state["']\]\s*[!=]=\s*["']active["']/, /store\.spent\(/, /paced_budget_micros/]},
        typescript: {all: [/\.state\s*[!=]==\s*['"]active['"]/, /\bspent\(/, /paced_budget_micros/]},
        go: {all: [/\.State\s*[!=]=\s*"active"/, /store\.Spent\(/, /PacedBudgetMicros/]},
        scala: {all: [/\.state\s*[!=]=\s*"active"/, /Store\.spent\(/, /pacedBudgetMicros/]},
        cpp: {all: [/\.state\s*[!=]=\s*"active"/, /store::spent\(/, /paced_budget_micros/]},
      },
    },
    {
      id: 'frequency-cap',
      title: 'Skips a campaign the user has seen freq_cap times',
      detail:
        'A campaign whose `store.frequency(id, user_hash)` has reached `freq_cap` does not compete for that user, and still does for everyone else. The starter never reads the counter.',
      match: {
        python: {all: [/store\.frequency\(/, /\bfreq_cap\b/]},
        typescript: {all: [/\bfrequency\(/, /\bfreq_cap\b/]},
        go: {all: [/store\.Frequency\(/, /\bFreqCap\b/]},
        scala: {all: [/Store\.frequency\(/, /\bfreqCap\b/]},
        cpp: {all: [/store::frequency\(/, /\bfreq_cap\b/]},
      },
    },
    {
      id: 'served-version',
      title: 'Names the campaign version it served',
      detail:
        'The response carries `campaign_version`, the `version` of the campaign row the decision read, so a delivery report can replay which creative, cap and budget applied. The starter omits it.',
      match: {
        python: {all: [/["']campaign_version["']\s*:/]},
        typescript: {all: [/campaign_version:/]},
        go: {all: [/"campaign_version"/]},
        scala: {all: [/"campaign_version"/]},
        cpp: {all: [/"campaign_version"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ads import store  # store.campaigns_for, store.frequency, store.spent

app = FastAPI()

MAX_PLACEMENT_CHARS = 64
ALLOWED_FORMATS = ("banner", "native", "video")


@app.post("/v1/ads/serve")
async def serve(request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    body = await request.json()
    campaigns = store.campaigns_for(body.get("placement", ""))
    if not campaigns:
        return JSONResponse({"ad": None, "reason": "no_eligible_campaign"})
    won = max(campaigns, key=lambda c: c["bid_micros"])
    ad = {"campaign_id": won["campaign_id"], "creative_id": won["creative_id"], "price_micros": won["bid_micros"]}
    return JSONResponse({"ad": ad})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ads import store  # store.campaigns_for, store.frequency, store.spent

app = FastAPI()

MAX_PLACEMENT_CHARS = 64
ALLOWED_FORMATS = ("banner", "native", "video")


def eligible(campaign: dict, user_hash: str) -> bool:
    """Limits before relevance: live, budget left for this impression, the user under the cap."""
    if campaign["state"] != "active":
        return False
    if store.spent(campaign["campaign_id"]) + campaign["bid_micros"] > campaign["paced_budget_micros"]:
        return False
    return store.frequency(campaign["campaign_id"], user_hash) < campaign["freq_cap"]


@app.post("/v1/ads/serve")
async def serve(request: Request) -> JSONResponse:
    body = await request.json()
    placement = body.get("placement")
    user_hash = body.get("user_hash")
    # A malformed request costs nothing: it is refused before any campaign is read.
    if not isinstance(placement, str) or not 1 <= len(placement) <= MAX_PLACEMENT_CHARS:
        return JSONResponse({"error": "placement must be 1 to 64 characters"}, status_code=400)
    if not isinstance(user_hash, str) or user_hash == "":
        return JSONResponse({"error": "user_hash is required"}, status_code=400)
    if body.get("format") not in ALLOWED_FORMATS:
        return JSONResponse({"error": "format must be banner, native or video"}, status_code=400)
    campaigns = [c for c in store.campaigns_for(placement) if eligible(c, user_hash)]
    if not campaigns:
        return JSONResponse({"ad": None, "reason": "no_eligible_campaign"})
    won = max(campaigns, key=lambda c: c["bid_micros"])
    ad = {"campaign_id": won["campaign_id"], "creative_id": won["creative_id"], "price_micros": won["bid_micros"]}
    # The version the decision read: a report can replay which creative, cap and budget applied.
    return JSONResponse({"ad": ad, "campaign_version": won["version"]})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Campaign, campaignsFor, frequency, spent} from 'ads/store';

export const app = Fastify();

export const MAX_PLACEMENT_CHARS = 64;
export const ALLOWED_FORMATS = ['banner', 'native', 'video'];

interface ServeBody {
  placement?: unknown;
  user_hash?: unknown;
  format?: unknown;
}

app.post('/v1/ads/serve', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {placement} = (request.body ?? {}) as ServeBody;
  let won: Campaign | null = null;
  for (const campaign of await campaignsFor(String(placement ?? ''))) {
    if (won === null || campaign.bid_micros > won.bid_micros) won = campaign;
  }
  if (won === null) return {ad: null, reason: 'no_eligible_campaign'};
  return {ad: {campaign_id: won.campaign_id, creative_id: won.creative_id, price_micros: won.bid_micros}};
});
`,
      solution: `import Fastify from 'fastify';

import {type Campaign, campaignsFor, frequency, spent} from 'ads/store';

export const app = Fastify();

export const MAX_PLACEMENT_CHARS = 64;
export const ALLOWED_FORMATS = ['banner', 'native', 'video'];

interface ServeBody {
  placement?: unknown;
  user_hash?: unknown;
  format?: unknown;
}

/** Limits before relevance: live, budget left for this impression, the user under the cap. */
async function eligible(campaign: Campaign, userHash: string): Promise<boolean> {
  if (campaign.state !== 'active') return false;
  if ((await spent(campaign.campaign_id)) + campaign.bid_micros > campaign.paced_budget_micros) return false;
  return (await frequency(campaign.campaign_id, userHash)) < campaign.freq_cap;
}

app.post('/v1/ads/serve', async (request, reply) => {
  const {placement, user_hash: userHash, format} = (request.body ?? {}) as ServeBody;
  // A malformed request costs nothing: it is refused before any campaign is read.
  if (typeof placement !== 'string' || placement === '' || placement.length > MAX_PLACEMENT_CHARS) {
    return reply.code(400).send({error: 'placement must be 1 to 64 characters'});
  }
  if (typeof userHash !== 'string' || userHash === '') return reply.code(400).send({error: 'user_hash is required'});
  if (typeof format !== 'string' || !ALLOWED_FORMATS.includes(format)) {
    return reply.code(400).send({error: 'format must be banner, native or video'});
  }
  let won: Campaign | null = null;
  for (const campaign of await campaignsFor(placement)) {
    if (!(await eligible(campaign, userHash))) continue;
    if (won === null || campaign.bid_micros > won.bid_micros) won = campaign;
  }
  if (won === null) return {ad: null, reason: 'no_eligible_campaign'};
  // The version the decision read: a report can replay which creative, cap and budget applied.
  return {
    ad: {campaign_id: won.campaign_id, creative_id: won.creative_id, price_micros: won.bid_micros},
    campaign_version: won.version,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"ads/store" // store.CampaignsFor, store.Frequency, store.Spent
)

const maxPlacementChars = 64

var allowedFormats = map[string]bool{"banner": true, "native": true, "video": true}

type serveRequest struct {
	Placement string \`json:"placement"\`
	UserHash  string \`json:"user_hash"\`
	Format    string \`json:"format"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func serve(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body serveRequest
	json.NewDecoder(r.Body).Decode(&body)
	campaigns := store.CampaignsFor(r.Context(), body.Placement)
	var won *store.Campaign
	for i := range campaigns {
		if won == nil || campaigns[i].BidMicros > won.BidMicros {
			won = &campaigns[i]
		}
	}
	if won == nil {
		writeJSON(rw, http.StatusOK, map[string]any{"ad": nil, "reason": "no_eligible_campaign"})
		return
	}
	ad := store.Ad{CampaignID: won.CampaignID, CreativeID: won.CreativeID, PriceMicros: won.BidMicros}
	writeJSON(rw, http.StatusOK, map[string]any{"ad": ad})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/ads/serve", serve)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"ads/store" // store.CampaignsFor, store.Frequency, store.Spent
)

const maxPlacementChars = 64

var allowedFormats = map[string]bool{"banner": true, "native": true, "video": true}

type serveRequest struct {
	Placement string \`json:"placement"\`
	UserHash  string \`json:"user_hash"\`
	Format    string \`json:"format"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// eligible applies the limits before relevance: live, budget left for this impression, the user under the cap.
func eligible(ctx context.Context, c store.Campaign, userHash string) bool {
	if c.State != "active" {
		return false
	}
	if store.Spent(ctx, c.CampaignID)+c.BidMicros > c.PacedBudgetMicros {
		return false
	}
	return store.Frequency(ctx, c.CampaignID, userHash) < c.FreqCap
}

func serve(rw http.ResponseWriter, r *http.Request) {
	var body serveRequest
	json.NewDecoder(r.Body).Decode(&body)
	// A malformed request costs nothing: it is refused before any campaign is read.
	if body.Placement == "" || len(body.Placement) > maxPlacementChars {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "placement must be 1 to 64 characters"})
		return
	}
	if body.UserHash == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "user_hash is required"})
		return
	}
	if !allowedFormats[body.Format] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "format must be banner, native or video"})
		return
	}
	campaigns := store.CampaignsFor(r.Context(), body.Placement)
	var won *store.Campaign
	for i := range campaigns {
		if !eligible(r.Context(), campaigns[i], body.UserHash) {
			continue
		}
		if won == nil || campaigns[i].BidMicros > won.BidMicros {
			won = &campaigns[i]
		}
	}
	if won == nil {
		writeJSON(rw, http.StatusOK, map[string]any{"ad": nil, "reason": "no_eligible_campaign"})
		return
	}
	ad := store.Ad{CampaignID: won.CampaignID, CreativeID: won.CreativeID, PriceMicros: won.BidMicros}
	// The version the decision read: a report can replay which creative, cap and budget applied.
	writeJSON(rw, http.StatusOK, map[string]any{"ad": ad, "campaign_version": won.Version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/ads/serve", serve)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import ads.Store // Store.campaignsFor, Store.frequency, Store.spent

object Api {
  val MaxPlacementChars = 64
  val AllowedFormats: Set[String] = Set("banner", "native", "video")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: JsObject, name: String): String = body.fields.get(name) match {
    case Some(JsString(s)) => s
    case _ => ""
  }

  private def adOf(c: Store.Campaign): JsObject =
    JsObject("campaign_id" -> JsString(c.campaignId), "creative_id" -> JsString(c.creativeId), "price_micros" -> JsNumber(c.bidMicros))

  val route: Route = path("v1" / "ads" / "serve") {
    post {
      entity(as[String]) { raw =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val body = raw.parseJson.asJsObject
        Store.campaignsFor(text(body, "placement")).sortBy(c => -c.bidMicros).headOption match {
          case None => complete(json(StatusCodes.OK, JsObject("ad" -> JsNull, "reason" -> JsString("no_eligible_campaign"))))
          case Some(won) => complete(json(StatusCodes.OK, JsObject("ad" -> adOf(won))))
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

import ads.Store // Store.campaignsFor, Store.frequency, Store.spent

object Api {
  val MaxPlacementChars = 64
  val AllowedFormats: Set[String] = Set("banner", "native", "video")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: JsObject, name: String): String = body.fields.get(name) match {
    case Some(JsString(s)) => s
    case _ => ""
  }

  private def adOf(c: Store.Campaign): JsObject =
    JsObject("campaign_id" -> JsString(c.campaignId), "creative_id" -> JsString(c.creativeId), "price_micros" -> JsNumber(c.bidMicros))

  private def badRequest(why: String) = complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString(why))))

  /** Limits before relevance: live, budget left for this impression, the user under the cap. */
  private def eligible(c: Store.Campaign, userHash: String): Boolean =
    c.state == "active" &&
      Store.spent(c.campaignId) + c.bidMicros <= c.pacedBudgetMicros &&
      Store.frequency(c.campaignId, userHash) < c.freqCap

  val route: Route = path("v1" / "ads" / "serve") {
    post {
      entity(as[String]) { raw =>
        val body = raw.parseJson.asJsObject
        val placement = text(body, "placement")
        val userHash = text(body, "user_hash")
        // A malformed request costs nothing: it is refused before any campaign is read.
        if (placement.isEmpty || placement.length > MaxPlacementChars) badRequest("placement must be 1 to 64 characters")
        else if (userHash.isEmpty) badRequest("user_hash is required")
        else if (!AllowedFormats.contains(text(body, "format"))) badRequest("format must be banner, native or video")
        else
          Store.campaignsFor(placement).filter(eligible(_, userHash)).sortBy(c => -c.bidMicros).headOption match {
            case None => complete(json(StatusCodes.OK, JsObject("ad" -> JsNull, "reason" -> JsString("no_eligible_campaign"))))
            // The version the decision read: a report can replay which creative, cap and budget applied.
            case Some(won) => complete(json(StatusCodes.OK, JsObject("ad" -> adOf(won), "campaign_version" -> JsNumber(won.version))))
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

#include <set>
#include <string>

#include "ads/store.h"  // store::campaignsFor, store::frequency, store::spent

using json = nlohmann::json;

const size_t kMaxPlacementChars = 64;
const std::set<std::string> kAllowedFormats = {"banner", "native", "video"};

void serve(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  const std::string placement = body.is_object() ? body.value("placement", std::string()) : std::string();
  const store::Campaign* won = nullptr;
  const std::vector<store::Campaign> campaigns = store::campaignsFor(placement);
  for (const auto& c : campaigns) {
    if (won == nullptr || c.bid_micros > won->bid_micros) won = &c;
  }
  if (won == nullptr) {
    res.set_content(json{{"ad", nullptr}, {"reason", "no_eligible_campaign"}}.dump(), "application/json");
    return;
  }
  const json ad = {{"campaign_id", won->campaign_id}, {"creative_id", won->creative_id}, {"price_micros", won->bid_micros}};
  res.set_content(json{{"ad", ad}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/ads/serve", serve); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "ads/store.h"  // store::campaignsFor, store::frequency, store::spent

using json = nlohmann::json;

const size_t kMaxPlacementChars = 64;
const std::set<std::string> kAllowedFormats = {"banner", "native", "video"};

void badRequest(httplib::Response& res, const std::string& why) {
  res.status = 400;
  res.set_content(json{{"error", why}}.dump(), "application/json");
}

// Limits before relevance: live, budget left for this impression, the user under the cap.
bool eligible(const store::Campaign& c, const std::string& user_hash) {
  if (c.state != "active") return false;
  if (store::spent(c.campaign_id) + c.bid_micros > c.paced_budget_micros) return false;
  return store::frequency(c.campaign_id, user_hash) < c.freq_cap;
}

void serve(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  const auto text = [&body](const char* name) {
    return body.is_object() && body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : std::string();
  };
  const std::string placement = text("placement");
  const std::string user_hash = text("user_hash");
  // A malformed request costs nothing: it is refused before any campaign is read.
  if (placement.empty() || placement.size() > kMaxPlacementChars) return badRequest(res, "placement must be 1 to 64 characters");
  if (user_hash.empty()) return badRequest(res, "user_hash is required");
  if (!kAllowedFormats.count(text("format"))) return badRequest(res, "format must be banner, native or video");
  const store::Campaign* won = nullptr;
  const std::vector<store::Campaign> campaigns = store::campaignsFor(placement);
  for (const auto& c : campaigns) {
    if (!eligible(c, user_hash)) continue;
    if (won == nullptr || c.bid_micros > won->bid_micros) won = &c;
  }
  if (won == nullptr) {
    res.set_content(json{{"ad", nullptr}, {"reason", "no_eligible_campaign"}}.dump(), "application/json");
    return;
  }
  const json ad = {{"campaign_id", won->campaign_id}, {"creative_id", won->creative_id}, {"price_micros", won->bid_micros}};
  // The version the decision read: a report can replay which creative, cap and budget applied.
  res.set_content(json{{"ad", ad}, {"campaign_version", won->version}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/ads/serve", serve); }
`,
    },
  },
  harness: {
    python: `from ads import store

REQUEST = {"placement": "home-top", "user_hash": "u-1", "format": "banner"}


def _campaign(campaign_id, bid, **fields):
    campaign = {
        "campaign_id": campaign_id, "advertiser_id": "adv-1", "version": 1, "state": "active", "placement": "home-top",
        "creative_id": f"cr-{campaign_id}", "bid_micros": bid, "freq_cap": 3, "freq_window_s": 3600,
        "paced_budget_micros": 1_000_000, "goal_impressions": 1000, "start_ts": 0, "end_ts": 86400,
    }
    campaign.update(fields)
    store.put_campaign(campaign)


def _served(r):
    assert r.status_code == 200, f"POST /v1/ads/serve answered {r.status_code}: {r.text}"
    ad = r.json().get("ad")
    return None if ad is None else ad.get("campaign_id")


async def check_route(ctx):
    _campaign("c-1", 900)
    m = ctx.load("api")
    async with ctx.client(m.app) as c:
        r = await c.post("/v1/ads/serve", json=REQUEST)
    assert r.status_code == 200, f"POST /v1/ads/serve answered {r.status_code}: {r.text}"
    ad = r.json().get("ad")
    assert ad == {"campaign_id": "c-1", "creative_id": "cr-c-1", "price_micros": 900}, f"the only active campaign must win, got {r.text}"


async def check_request_guard(ctx):
    _campaign("c-1", 900)
    m = ctx.load("api")
    bad = [
        ({**REQUEST, "placement": ""}, "an empty placement"),
        ({**REQUEST, "placement": "p" * 65}, "a 65-character placement"),
        ({"placement": "home-top", "format": "banner"}, "a request without user_hash"),
        ({**REQUEST, "user_hash": ""}, "an empty user_hash"),
        ({**REQUEST, "format": "popup"}, "format popup"),
    ]
    async with ctx.client(m.app) as c:
        for body, what in bad:
            r = await c.post("/v1/ads/serve", json=body)
            assert r.status_code == 400, f"{what} answered {r.status_code} {r.text}, expected 400 before any campaign is read"
        r = await c.post("/v1/ads/serve", json={**REQUEST, "placement": "p" * 64})
    assert r.status_code == 200, f"a 64-character placement is valid, it answered {r.status_code}: {r.text}"


async def check_eligibility(ctx):
    _campaign("c-1", 900, state="paused")
    _campaign("c-2", 800, paced_budget_micros=10_000)
    ctx.redis.set("pace:c-2", 9_500)
    _campaign("c-3", 700, state="exhausted")
    _campaign("c-4", 400)
    m = ctx.load("api")
    async with ctx.client(m.app) as c:
        won = _served(await c.post("/v1/ads/serve", json=REQUEST))
        assert won == "c-4", f"the serve went to {won}: c-1 is paused, c-3 exhausted and c-2 has 500 micros of budget left for an 800-micro bid. Only c-4 may compete"
        ctx.redis.set("pace:c-4", 1_000_000)
        r = await c.post("/v1/ads/serve", json=REQUEST)
    assert r.status_code == 200 and r.json() == {"ad": None, "reason": "no_eligible_campaign"}, f"with every campaign paused or spent the serve answered {r.status_code} {r.text}, expected no_eligible_campaign"


async def check_frequency_cap(ctx):
    _campaign("c-1", 900, freq_cap=3)
    _campaign("c-2", 500)
    ctx.redis.set("freq:c-1:u-1", 3)
    ctx.redis.set("freq:c-1:u-2", 2)
    m = ctx.load("api")
    async with ctx.client(m.app) as c:
        capped = _served(await c.post("/v1/ads/serve", json=REQUEST))
        other = _served(await c.post("/v1/ads/serve", json={**REQUEST, "user_hash": "u-2"}))
    assert capped == "c-2", f"u-1 has seen c-1 three times (freq_cap 3) and was served {capped}, expected c-2"
    assert other == "c-1", f"u-2 has seen c-1 twice, under its cap of 3, and was served {other}, expected c-1"


async def check_served_version(ctx):
    _campaign("c-1", 900, version=7)
    m = ctx.load("api")
    async with ctx.client(m.app) as c:
        r = await c.post("/v1/ads/serve", json=REQUEST)
    assert r.status_code == 200, f"POST /v1/ads/serve answered {r.status_code}: {r.text}"
    assert r.json().get("campaign_version") == 7, f"the serve of c-1 (version 7) answered {r.text}: campaign_version must name the row the decision read"
`,
    typescript: `const REQUEST = {placement: 'home-top', user_hash: 'u-1', format: 'banner'};

const campaign = (campaignId: string, bid: number, fields = {}) => ({
  campaign_id: campaignId,
  advertiser_id: 'adv-1',
  version: 1,
  state: 'active',
  placement: 'home-top',
  creative_id: \`cr-\${campaignId}\`,
  bid_micros: bid,
  freq_cap: 3,
  freq_window_s: 3600,
  paced_budget_micros: 1000000,
  goal_impressions: 1000,
  start_ts: 0,
  end_ts: 86400,
  ...fields,
});

async function api(ctx, campaigns) {
  const store = ctx.load('/support/ads/store.ts');
  for (const c of campaigns) await store.putCampaign(c);
  return ctx.client(ctx.load('api').app);
}

function served(r): string | null {
  assert.equal(r.status, 200, \`POST /v1/ads/serve answered \${r.status}: \${r.text}\`);
  return r.json().ad?.campaign_id ?? null;
}

export async function check_route(ctx) {
  const c = await api(ctx, [campaign('c-1', 900)]);
  const r = await c.post('/v1/ads/serve', {json: REQUEST});
  assert.equal(r.status, 200, \`POST /v1/ads/serve answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json().ad, {campaign_id: 'c-1', creative_id: 'cr-c-1', price_micros: 900}, \`the only active campaign must win, got \${r.text}\`);
}

export async function check_request_guard(ctx) {
  const c = await api(ctx, [campaign('c-1', 900)]);
  const bad: [object, string][] = [
    [{...REQUEST, placement: ''}, 'an empty placement'],
    [{...REQUEST, placement: 'p'.repeat(65)}, 'a 65-character placement'],
    [{placement: 'home-top', format: 'banner'}, 'a request without user_hash'],
    [{...REQUEST, user_hash: ''}, 'an empty user_hash'],
    [{...REQUEST, format: 'popup'}, 'format popup'],
  ];
  for (const [body, what] of bad) {
    const r = await c.post('/v1/ads/serve', {json: body});
    assert.equal(r.status, 400, \`\${what} answered \${r.status} \${r.text}, expected 400 before any campaign is read\`);
  }
  const r = await c.post('/v1/ads/serve', {json: {...REQUEST, placement: 'p'.repeat(64)}});
  assert.equal(r.status, 200, \`a 64-character placement is valid, it answered \${r.status}: \${r.text}\`);
}

export async function check_eligibility(ctx) {
  const c = await api(ctx, [
    campaign('c-1', 900, {state: 'paused'}),
    campaign('c-2', 800, {paced_budget_micros: 10000}),
    campaign('c-3', 700, {state: 'exhausted'}),
    campaign('c-4', 400),
  ]);
  ctx.redis.set('pace:c-2', '9500');
  const won = served(await c.post('/v1/ads/serve', {json: REQUEST}));
  assert.equal(won, 'c-4', \`the serve went to \${won}: c-1 is paused, c-3 exhausted and c-2 has 500 micros of budget left for an 800-micro bid. Only c-4 may compete\`);
  ctx.redis.set('pace:c-4', '1000000');
  const r = await c.post('/v1/ads/serve', {json: REQUEST});
  assert(r.status === 200 && r.text.includes('no_eligible_campaign') && r.json().ad === null, \`with every campaign paused or spent the serve answered \${r.status} \${r.text}, expected no_eligible_campaign\`);
}

export async function check_frequency_cap(ctx) {
  const c = await api(ctx, [campaign('c-1', 900, {freq_cap: 3}), campaign('c-2', 500)]);
  ctx.redis.set('freq:c-1:u-1', '3');
  ctx.redis.set('freq:c-1:u-2', '2');
  const capped = served(await c.post('/v1/ads/serve', {json: REQUEST}));
  const other = served(await c.post('/v1/ads/serve', {json: {...REQUEST, user_hash: 'u-2'}}));
  assert.equal(capped, 'c-2', \`u-1 has seen c-1 three times (freq_cap 3) and was served \${capped}, expected c-2\`);
  assert.equal(other, 'c-1', \`u-2 has seen c-1 twice, under its cap of 3, and was served \${other}, expected c-1\`);
}

export async function check_served_version(ctx) {
  const c = await api(ctx, [campaign('c-1', 900, {version: 7})]);
  const r = await c.post('/v1/ads/serve', {json: REQUEST});
  assert.equal(r.status, 200, \`POST /v1/ads/serve answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().campaign_version, 7, \`the serve of c-1 (version 7) answered \${r.text}: campaign_version must name the row the decision read\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"ads/store"

	"leetbuild/harness"
)

var apiRequest = map[string]any{"placement": "home-top", "user_hash": "u-1", "format": "banner"}

func apiCampaign(id string, bid int64) store.Campaign {
	return store.Campaign{
		CampaignID: id, AdvertiserID: "adv-1", Version: 1, State: "active", Placement: "home-top", CreativeID: "cr-" + id,
		BidMicros: bid, FreqCap: 3, FreqWindowS: 3600, PacedBudgetMicros: 1000000, GoalImpressions: 1000, StartTs: 0, EndTs: 86400,
	}
}

func apiClient(ctx *harness.Ctx, campaigns ...store.Campaign) *harness.HTTP {
	for _, c := range campaigns {
		store.PutCampaign(context.Background(), c)
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiWith(fields map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range apiRequest {
		out[k] = v
	}
	for k, v := range fields {
		out[k] = v
	}
	return out
}

// apiServed is the campaign the serve answered with ("" for none).
func apiServed(ctx *harness.Ctx, r *harness.Response) string {
	ctx.Equal(r.Status, 200, "POST /v1/ads/serve (%s)", r.Text())
	body, _ := r.JSON().(map[string]any)
	ad, _ := body["ad"].(map[string]any)
	id, _ := ad["campaign_id"].(string)
	return id
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx, apiCampaign("c-1", 900))
	r := c.Post("/v1/ads/serve", apiRequest)
	ctx.Equal(r.Status, 200, "POST /v1/ads/serve (%s)", r.Text())
	body, _ := r.JSON().(map[string]any)
	ctx.Equal(body["ad"], map[string]any{"campaign_id": "c-1", "creative_id": "cr-c-1", "price_micros": 900}, "the only active campaign must win; the ad")
}

func CheckRequestGuard(ctx *harness.Ctx) {
	c := apiClient(ctx, apiCampaign("c-1", 900))
	bad := []struct {
		body map[string]any
		what string
	}{
		{apiWith(map[string]any{"placement": ""}), "an empty placement"},
		{apiWith(map[string]any{"placement": strings.Repeat("p", 65)}), "a 65-character placement"},
		{map[string]any{"placement": "home-top", "format": "banner"}, "a request without user_hash"},
		{apiWith(map[string]any{"user_hash": ""}), "an empty user_hash"},
		{apiWith(map[string]any{"format": "popup"}), "format popup"},
	}
	for _, b := range bad {
		r := c.Post("/v1/ads/serve", b.body)
		ctx.Equal(r.Status, 400, "%s answered %s, expected 400 before any campaign is read; the status", b.what, r.Text())
	}
	r := c.Post("/v1/ads/serve", apiWith(map[string]any{"placement": strings.Repeat("p", 64)}))
	ctx.Equal(r.Status, 200, "a 64-character placement is valid (%s)", r.Text())
}

func CheckEligibility(ctx *harness.Ctx) {
	paused := apiCampaign("c-1", 900)
	paused.State = "paused"
	spent := apiCampaign("c-2", 800)
	spent.PacedBudgetMicros = 10000
	exhausted := apiCampaign("c-3", 700)
	exhausted.State = "exhausted"
	c := apiClient(ctx, paused, spent, exhausted, apiCampaign("c-4", 400))
	ctx.Redis.Set("pace:c-2", "9500")
	won := apiServed(ctx, c.Post("/v1/ads/serve", apiRequest))
	ctx.Equal(won, "c-4", "c-1 is paused, c-3 exhausted and c-2 has 500 micros of budget left for an 800-micro bid: only c-4 may compete; the serve went to")
	ctx.Redis.Set("pace:c-4", "1000000")
	r := c.Post("/v1/ads/serve", apiRequest)
	body, _ := r.JSON().(map[string]any)
	ctx.Assert(r.Status == 200 && body["ad"] == nil && body["reason"] == "no_eligible_campaign", "with every campaign paused or spent the serve answered %d %s, expected no_eligible_campaign", r.Status, r.Text())
}

func CheckFrequencyCap(ctx *harness.Ctx) {
	capped := apiCampaign("c-1", 900)
	capped.FreqCap = 3
	c := apiClient(ctx, capped, apiCampaign("c-2", 500))
	ctx.Redis.Set("freq:c-1:u-1", "3")
	ctx.Redis.Set("freq:c-1:u-2", "2")
	first := apiServed(ctx, c.Post("/v1/ads/serve", apiRequest))
	second := apiServed(ctx, c.Post("/v1/ads/serve", apiWith(map[string]any{"user_hash": "u-2"})))
	ctx.Equal(first, "c-2", "u-1 has seen c-1 three times (freq_cap 3); u-1 was served")
	ctx.Equal(second, "c-1", "u-2 has seen c-1 twice, under its cap of 3; u-2 was served")
}

func CheckServedVersion(ctx *harness.Ctx) {
	versioned := apiCampaign("c-1", 900)
	versioned.Version = 7
	c := apiClient(ctx, versioned)
	r := c.Post("/v1/ads/serve", apiRequest)
	ctx.Equal(r.Status, 200, "POST /v1/ads/serve (%s)", r.Text())
	body, _ := r.JSON().(map[string]any)
	ctx.Equal(body["campaign_version"], 7, "the serve of c-1 (version 7) answered %s: campaign_version must name the row the decision read; campaign_version", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

#include "ads/store.h"

namespace {

const nlohmann::json kApiRequest = {{"placement", "home-top"}, {"user_hash", "u-1"}, {"format", "banner"}};

store::Campaign apiCampaign(const std::string& id, long long bid) {
  store::Campaign c;
  c.campaign_id = id;
  c.advertiser_id = "adv-1";
  c.version = 1;
  c.state = "active";
  c.placement = "home-top";
  c.creative_id = "cr-" + id;
  c.bid_micros = bid;
  c.freq_cap = 3;
  c.freq_window_s = 3600;
  c.paced_budget_micros = 1000000;
  c.goal_impressions = 1000;
  c.start_ts = 0;
  c.end_ts = 86400;
  return c;
}

harness::HTTP apiClient(harness::Ctx& ctx, const std::vector<store::Campaign>& campaigns) {
  for (const auto& c : campaigns) store::putCampaign(c);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response apiPost(harness::HTTP& c, const nlohmann::json& body) {
  return c.Post("/v1/ads/serve", body.dump(), "Content-Type", "application/json");
}

nlohmann::json apiWith(const nlohmann::json& fields) {
  nlohmann::json out = kApiRequest;
  for (const auto& [k, v] : fields.items()) out[k] = v;
  return out;
}

nlohmann::json apiBody(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

// The campaign the serve answered with ("" for none).
std::string apiServed(harness::Ctx& ctx, const harness::Response& r) {
  ctx.Equal(r.Status, 200, "POST /v1/ads/serve (%s)", r.Text());
  const auto body = apiBody(r);
  if (!body.is_object() || !body.contains("ad") || !body["ad"].is_object()) return "";
  return body["ad"].value("campaign_id", std::string());
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx, {apiCampaign("c-1", 900)});
  const auto r = apiPost(c, kApiRequest);
  ctx.Equal(r.Status, 200, "POST /v1/ads/serve (%s)", r.Text());
  const auto body = apiBody(r);
  const nlohmann::json want = {{"campaign_id", "c-1"}, {"creative_id", "cr-c-1"}, {"price_micros", 900}};
  ctx.Assert(body.is_object() && body.contains("ad") && body["ad"] == want, "the only active campaign must win, got %s", r.Text());
}

void CheckRequestGuard(harness::Ctx& ctx) {
  auto c = apiClient(ctx, {apiCampaign("c-1", 900)});
  const std::vector<std::pair<nlohmann::json, std::string>> bad = {
      {apiWith({{"placement", ""}}), "an empty placement"},
      {apiWith({{"placement", std::string(65, 'p')}}), "a 65-character placement"},
      {nlohmann::json{{"placement", "home-top"}, {"format", "banner"}}, "a request without user_hash"},
      {apiWith({{"user_hash", ""}}), "an empty user_hash"},
      {apiWith({{"format", "popup"}}), "format popup"},
  };
  for (const auto& [body, what] : bad) {
    const auto r = apiPost(c, body);
    ctx.Equal(r.Status, 400, "%s answered %s, expected 400 before any campaign is read; the status", what, r.Text());
  }
  const auto r = apiPost(c, apiWith({{"placement", std::string(64, 'p')}}));
  ctx.Equal(r.Status, 200, "a 64-character placement is valid (%s)", r.Text());
}

void CheckEligibility(harness::Ctx& ctx) {
  auto paused = apiCampaign("c-1", 900);
  paused.state = "paused";
  auto spent = apiCampaign("c-2", 800);
  spent.paced_budget_micros = 10000;
  auto exhausted = apiCampaign("c-3", 700);
  exhausted.state = "exhausted";
  auto c = apiClient(ctx, {paused, spent, exhausted, apiCampaign("c-4", 400)});
  ctx.Redis.Set("pace:c-2", "9500");
  const std::string won = apiServed(ctx, apiPost(c, kApiRequest));
  ctx.Equal(won, std::string("c-4"), "c-1 is paused, c-3 exhausted and c-2 has 500 micros of budget left for an 800-micro bid: only c-4 may compete; the serve went to");
  ctx.Redis.Set("pace:c-4", "1000000");
  const auto r = apiPost(c, kApiRequest);
  const auto body = apiBody(r);
  ctx.Assert(r.Status == 200 && body.is_object() && body.contains("ad") && body["ad"].is_null() && body.value("reason", std::string()) == "no_eligible_campaign",
             "with every campaign paused or spent the serve answered %d %s, expected no_eligible_campaign", r.Status, r.Text());
}

void CheckFrequencyCap(harness::Ctx& ctx) {
  auto capped = apiCampaign("c-1", 900);
  capped.freq_cap = 3;
  auto c = apiClient(ctx, {capped, apiCampaign("c-2", 500)});
  ctx.Redis.Set("freq:c-1:u-1", "3");
  ctx.Redis.Set("freq:c-1:u-2", "2");
  const std::string first = apiServed(ctx, apiPost(c, kApiRequest));
  const std::string second = apiServed(ctx, apiPost(c, apiWith({{"user_hash", "u-2"}})));
  ctx.Equal(first, std::string("c-2"), "u-1 has seen c-1 three times (freq_cap 3); u-1 was served");
  ctx.Equal(second, std::string("c-1"), "u-2 has seen c-1 twice, under its cap of 3; u-2 was served");
}

void CheckServedVersion(harness::Ctx& ctx) {
  auto versioned = apiCampaign("c-1", 900);
  versioned.version = 7;
  auto c = apiClient(ctx, {versioned});
  const auto r = apiPost(c, kApiRequest);
  ctx.Equal(r.Status, 200, "POST /v1/ads/serve (%s)", r.Text());
  const auto body = apiBody(r);
  ctx.Assert(body.is_object() && body.contains("campaign_version") && body["campaign_version"] == 7,
             "the serve of c-1 (version 7) answered %s: campaign_version must name the row the decision read", r.Text());
}
`,
  },
  hints: [
    'Send a request with no `user_hash` and it gets an ad; pause the top campaign and it still wins; serve one user ten times and it sees the same banner ten times.',
    'The handler hands `campaigns_for` straight to `max`: nothing reads `state`, `store.spent` or `store.frequency`, the body is never checked, and the answer drops the row’s `version`.',
    'Return 400 for a bad `placement`, `user_hash` or `format`; keep a campaign only if `state == "active"`, `spent + bid_micros <= paced_budget_micros` and `frequency < freq_cap`; answer `campaign_version: won["version"]`.',
  ],
  debrief: `The fix follows the money: a malformed request is refused before it costs a lookup, and a campaign that may not serve never reaches the comparison, because a filter applied after ranking can only pick a worse ad, never a valid one. Budget and frequency are read from the same counters the reservation writes, so this filter and the atomic decision in step 2 agree on what "spent" means. The version in the answer is what makes a report reproducible after a mid-flight edit. Production ad servers precompute eligibility per placement as campaigns change, keep the counters in a cache close to the serving process, and log the whole decision (candidates, reasons for exclusion) for auditing.`,
};
