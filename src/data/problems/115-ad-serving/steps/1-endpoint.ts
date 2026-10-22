import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/ads/serve: a request that respects its own limits',
  concept: 'http',
  file: 'api',
  focus: ['client', 'server', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body, ranks the candidate campaigns by bid and returns the highest bidder. It compiles, it serves
the demo, and it hides three production flaws. Review it like the service owner, fix it, and prove
the fix with the checks below.

Implement \`POST /v1/ads/serve\` with body
\`{"placement": "…", "user_hash": "…", "page_context": {"url": "…", "num_ads": 1, "format": "banner"}}\`.

- \`placement\` is a non-empty string of at most **64** characters (**400** otherwise) and
  \`user_hash\` is required (**400** when missing): a serve request carries a stable, non-identifying
  user key, never an email, a device id or a raw cookie.
- \`page_context.format\` is one of \`banner\`, \`native\`, \`video\` (**400** otherwise).
- Eligibility is decided **before** any ranking. A campaign is eligible only when its \`state\` is
  \`active\`, its \`budget_spent_micros\` is below its \`paced_budget_micros\`, and the user's
  impressions for that campaign inside the campaign's \`freq_window_s\` are below its
  \`freq_cap_impressions\`.
- The ad that is served is the eligible candidate with the highest \`bid_micros\`; when nothing is
  eligible the response is \`{"ad": null, "reason": "no_eligible_campaign"}\` with **200**.
- The response names the campaign **version** it decided against (\`campaign_version\`) — never
  "latest", never a bare campaign id. A delivery report has to be able to say which creative, cap
  and budget a served impression used.

**Failure mode the checks target.** The draft ranks first and filters never. A capped user keeps
seeing the highest bidder on every page — the same ad fifty times — and a campaign whose pacing
budget is spent, or whose state is \`paused\`/\`exhausted\`, keeps serving because nothing reads its
state. Dropping \`campaign_version\` is the quiet one: with it, a mid-flight campaign edit rewrites
history and the reconciliation between serve and render cannot be replayed.`,
  sequence: {
    participants: ['Client', 'Ad Server', 'campaign store', 'Redis'],
    messages: [
      {from: 'Client', to: 'Ad Server', label: 'POST /v1/ads/serve · placement · user_hash', kind: 'sync'},
      {from: 'Ad Server', to: 'Ad Server', label: 'validate placement · user_hash · format', kind: 'sync'},
      {from: 'Ad Server', to: 'campaign store', label: 'campaigns(placement)', kind: 'sync'},
      {from: 'campaign store', to: 'Ad Server', label: 'candidates · state · version · caps', kind: 'reply'},
      {from: 'Ad Server', to: 'Redis', label: 'GET freq:{campaign}:{user}', kind: 'sync'},
      {from: 'Redis', to: 'Ad Server', label: 'impressions in the frequency window', kind: 'reply'},
      {from: 'Ad Server', to: 'Client', label: '200 {ad, campaign_version} / no_eligible_campaign', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/ads/serve',
      detail: 'Register the serving route on `POST /v1/ads/serve`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/ads\/serve["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/ads\/serve['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/ads\/serve"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"ads"\s*\/\s*"serve"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/ads\/serve"/]},
      },
    },
    {
      id: 'request-guard',
      title: 'Validates placement, user_hash and format before any lookup',
      detail:
        '`placement` is 1–64 characters and `user_hash` is required (**400** otherwise); an unknown `page_context.format` is **400**. The draft sends whatever arrives straight to ranking, so a malformed request is answered with an ad and no request is ever cheaply rejected.',
      match: {
        python: {all: [/MAX_PLACEMENT_CHARS/, /user_hash/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_PLACEMENT_CHARS/, /user_hash/, /code\(\s*400\s*\)/]},
        go: {all: [/maxPlacementChars/, /user_hash/, /StatusBadRequest/]},
        scala: {all: [/MaxPlacementChars/, /user_hash/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxPlacementChars/, /user_hash/, /\b400\b/]},
      },
    },
    {
      id: 'frequency-cap',
      title: 'Enforces the campaign frequency cap per user',
      detail:
        'The user’s impressions for the campaign are read from the frequency counters and compared with `freq_cap_impressions` inside the campaign’s `freq_window_s`; a capped user receives no ad from that campaign. The draft never reads a cap, so the highest bidder saturates one user.',
      match: {
        python: {all: [/freq_cap_impressions/, /freq_window_s/, /store\.frequency\(/]},
        typescript: {all: [/freq_cap_impressions/, /freq_window_s/, /\.frequency\(/]},
        go: {all: [/freq_cap_impressions/, /freq_window_s/, /\.Frequency\(/]},
        scala: {all: [/freq_cap_impressions/, /freq_window_s/, /\.frequency\(/]},
        cpp: {all: [/freq_cap_impressions/, /freq_window_s/, /\.frequency\(/]},
      },
    },
    {
      id: 'exhausted',
      title: 'Never serves a paused or budget-exhausted campaign',
      detail:
        'A campaign whose `state` is `paused`/`exhausted`, or whose `budget_spent_micros` has reached `paced_budget_micros`, is filtered out before ranking. The draft serves exhausted budgets because it reads neither the state nor the pacing fields.',
      match: {
        python: {all: [/INACTIVE_STATES/, /paced_budget_micros/, /budget_spent_micros/]},
        typescript: {all: [/INACTIVE_STATES/, /paced_budget_micros/, /budget_spent_micros/]},
        go: {all: [/inactiveStates/, /paced_budget_micros/, /budget_spent_micros/]},
        scala: {all: [/InactiveStates/, /paced_budget_micros/, /budget_spent_micros/]},
        cpp: {all: [/kInactiveStates/, /paced_budget_micros/, /budget_spent_micros/]},
      },
    },
    {
      id: 'served-version',
      title: 'Names the campaign version it served',
      detail:
        'The response carries `campaign_version` for the campaign that won, so a delivery report can tell which creative, cap and budget the decision used. The draft returns the ad without a version.',
      match: {
        python: {all: [/campaign_version/]},
        typescript: {all: [/campaign_version/]},
        go: {all: [/campaign_version/]},
        scala: {all: [/campaign_version/]},
        cpp: {all: [/campaign_version/]},
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
logger = logging.getLogger("adserver")


class PageContext(BaseModel):
    url: str = ""
    num_ads: int = 1
    format: str = "banner"


class ServeRequest(BaseModel):
    placement: str
    user_hash: str
    page_context: PageContext


class CampaignStore:
    def active_campaigns(self, placement: str) -> list[dict]:
        """Campaigns targeting this placement, whatever their state."""
        raise NotImplementedError


store = CampaignStore()


@app.post("/v1/ads/serve")
def serve(body: ServeRequest) -> JSONResponse:
    # TODO: this draft ranks the highest bidder without consulting the campaign's state, its
    # pacing budget or the user's frequency cap, and the response omits the campaign version
    # the decision was made against. Review all three flaws.
    campaigns = store.active_campaigns(body.placement)
    won = max(campaigns, key=lambda c: c["bid_micros"], default=None)
    if won is None:
        return JSONResponse({"ad": None, "reason": "no_fill"}, status_code=200)
    logger.info("serve placement=%s campaign=%s user=%s", body.placement, won["campaign_id"], body.user_hash)
    return JSONResponse(
        {
            "ad": {
                "campaign_id": won["campaign_id"],
                "creative_id": won["creative_id"],
                "price_micros": won["bid_micros"],
            },
            "fallback": False,
        },
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("adserver")

MAX_PLACEMENT_CHARS = 64
ACTIVE = "active"
EXHAUSTED = "exhausted"
PAUSED = "paused"
INACTIVE_STATES = {EXHAUSTED, PAUSED}
ALLOWED_FORMATS = {"banner", "native", "video"}


class PageContext(BaseModel):
    url: str = ""
    num_ads: int = 1
    format: str = "banner"


class ServeRequest(BaseModel):
    placement: str
    user_hash: str
    page_context: PageContext


class CampaignStore:
    def active_campaigns(self, placement: str) -> list[dict]:
        """Campaigns targeting this placement, whatever their state."""
        raise NotImplementedError

    def frequency(self, campaign_id: str, user_hash: str, window_s: int) -> int:
        """Impressions counted for this user inside the campaign's window."""
        raise NotImplementedError


store = CampaignStore()


def is_eligible(campaign: dict, user_hash: str) -> bool:
    if campaign["state"] in INACTIVE_STATES:
        return False
    if campaign["budget_spent_micros"] >= campaign["paced_budget_micros"]:
        return False
    seen = store.frequency(campaign["campaign_id"], user_hash, campaign["freq_window_s"])
    return seen < campaign["freq_cap_impressions"]


@app.post("/v1/ads/serve")
def serve(body: ServeRequest) -> JSONResponse:
    if body.placement == "" or len(body.placement) > MAX_PLACEMENT_CHARS:
        raise HTTPException(status_code=400, detail="placement must be 1..64 characters")
    if body.user_hash == "":
        raise HTTPException(status_code=400, detail="user_hash is required")
    if body.page_context.format not in ALLOWED_FORMATS:
        raise HTTPException(status_code=400, detail="unknown format")

    eligible = [c for c in store.active_campaigns(body.placement) if is_eligible(c, body.user_hash)]
    if not eligible:
        return JSONResponse({"ad": None, "reason": "no_eligible_campaign"}, status_code=200)

    won = max(eligible, key=lambda c: c["bid_micros"])
    logger.info("serve placement=%s campaign=%s", body.placement, won["campaign_id"])
    return JSONResponse(
        {
            "ad": {
                "campaign_id": won["campaign_id"],
                "creative_id": won["creative_id"],
                "price_micros": won["bid_micros"],
            },
            "campaign_version": won["campaign_version"],
            "fallback": False,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/ads/serve: a model-generated draft that ranks before it filters. */
import Fastify from 'fastify';

export const app = Fastify();

interface PageContext {
  url: string;
  num_ads?: number;
  format?: string;
}

interface ServeBody {
  placement: string;
  user_hash: string;
  page_context: PageContext;
}

interface Campaign {
  campaign_id: string;
  creative_id: string;
  bid_micros: number;
}

interface CampaignStore {
  activeCampaigns(placement: string): Campaign[];
}

declare const store: CampaignStore;

app.post('/v1/ads/serve', async (request, reply) => {
  // TODO: this draft ranks the highest bidder without consulting the campaign's state, its
  // pacing budget or the user's frequency cap, and the response omits the campaign version
  // the decision was made against. Review all three flaws.
  const body = request.body as ServeBody;
  const campaigns = store.activeCampaigns(body.placement);
  if (campaigns.length === 0) return reply.code(200).send({ad: null, reason: 'no_fill'});
  const won = campaigns.reduce((best, c) => (c.bid_micros > best.bid_micros ? c : best));
  request.log.info({placement: body.placement, campaign_id: won.campaign_id}, 'served');
  return reply.code(200).send({
    ad: {campaign_id: won.campaign_id, creative_id: won.creative_id, price_micros: won.bid_micros},
    fallback: false,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/ads/serve: eligibility (cap, pacing, state) before relevance. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_PLACEMENT_CHARS = 64;
const INACTIVE_STATES: Record<string, true> = {paused: true, exhausted: true};
const ALLOWED_FORMATS: Record<string, true> = {banner: true, native: true, video: true};

interface PageContext {
  url: string;
  num_ads?: number;
  format?: string;
}

interface ServeBody {
  placement: string;
  user_hash: string;
  page_context: PageContext;
}

interface Campaign {
  campaign_id: string;
  campaign_version: string;
  creative_id: string;
  bid_micros: number;
  state: string;
  freq_cap_impressions: number;
  freq_window_s: number;
  paced_budget_micros: number;
  budget_spent_micros: number;
}

interface CampaignStore {
  activeCampaigns(placement: string): Campaign[];
  frequency(campaign_id: string, userHash: string, windowS: number): number;
}

declare const store: CampaignStore;

function isEligible(campaign: Campaign, userHash: string): boolean {
  if (INACTIVE_STATES[campaign.state] === true) return false;
  if (campaign.budget_spent_micros >= campaign.paced_budget_micros) return false;
  const seen = store.frequency(campaign.campaign_id, userHash, campaign.freq_window_s);
  return seen < campaign.freq_cap_impressions;
}

app.post('/v1/ads/serve', async (request, reply) => {
  const body = request.body as Partial<ServeBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid body'});
  if (typeof body.placement !== 'string' || body.placement === '' || body.placement.length > MAX_PLACEMENT_CHARS)
    return reply.code(400).send({error: 'placement must be 1..64 characters'});
  if (typeof body.user_hash !== 'string' || body.user_hash === '')
    return reply.code(400).send({error: 'user_hash is required'});
  const format = body.page_context?.format ?? 'banner';
  if (ALLOWED_FORMATS[format] !== true) return reply.code(400).send({error: 'unknown format'});

  const eligible = store.activeCampaigns(body.placement).filter(c => isEligible(c, body.user_hash));
  if (eligible.length === 0) return reply.code(200).send({ad: null, reason: 'no_eligible_campaign'});
  const won = eligible.reduce((best, c) => (c.bid_micros > best.bid_micros ? c : best));
  request.log.info({placement: body.placement, campaign_id: won.campaign_id}, 'served');
  return reply.code(200).send({
    ad: {campaign_id: won.campaign_id, creative_id: won.creative_id, price_micros: won.bid_micros},
    campaign_version: won.campaign_version,
    fallback: false,
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

type PageContext struct {
	URL    string \`json:"url"\`
	NumAds int    \`json:"num_ads"\`
	Format string \`json:"format"\`
}

type ServeRequest struct {
	Placement   string      \`json:"placement"\`
	UserHash    string      \`json:"user_hash"\`
	PageContext PageContext \`json:"page_context"\`
}

type Campaign struct {
	CampaignID string \`json:"campaign_id"\`
	CreativeID string \`json:"creative_id"\`
	BidMicros  int64  \`json:"bid_micros"\`
}

type CampaignStore interface {
	ActiveCampaigns(ctx context.Context, placement string) ([]Campaign, error)
}

var store CampaignStore

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func serve(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft ranks the highest bidder without consulting the campaign's state, its
	// pacing budget or the user's frequency cap, and the response omits the campaign version
	// the decision was made against. Review all three flaws.
	var body ServeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	campaigns, err := store.ActiveCampaigns(r.Context(), body.Placement)
	if err != nil || len(campaigns) == 0 {
		writeJSON(rw, http.StatusOK, map[string]any{"ad": nil, "reason": "no_fill"})
		return
	}
	won := campaigns[0]
	for _, c := range campaigns[1:] {
		if c.BidMicros > won.BidMicros {
			won = c
		}
	}
	log.Printf("serve placement=%s campaign=%s user=%s", body.Placement, won.CampaignID, body.UserHash)
	writeJSON(rw, http.StatusOK, map[string]any{
		"ad": map[string]any{
			"campaign_id":  won.CampaignID,
			"creative_id":  won.CreativeID,
			"price_micros": won.BidMicros,
		},
		"fallback": false,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/ads/serve", serve)
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

const maxPlacementChars = 64

var (
	inactiveStates = map[string]bool{"paused": true, "exhausted": true}
	allowedFormats = map[string]bool{"banner": true, "native": true, "video": true}
)

type PageContext struct {
	URL    string \`json:"url"\`
	NumAds int    \`json:"num_ads"\`
	Format string \`json:"format"\`
}

type ServeRequest struct {
	Placement   string      \`json:"placement"\`
	UserHash    string      \`json:"user_hash"\`
	PageContext PageContext \`json:"page_context"\`
}

type Campaign struct {
	CampaignID         string \`json:"campaign_id"\`
	CampaignVersion    string \`json:"campaign_version"\`
	CreativeID         string \`json:"creative_id"\`
	BidMicros          int64  \`json:"bid_micros"\`
	State              string \`json:"state"\`
	FreqCapImpressions int    \`json:"freq_cap_impressions"\`
	FreqWindowS        int    \`json:"freq_window_s"\`
	PacedBudgetMicros  int64  \`json:"paced_budget_micros"\`
	BudgetSpentMicros  int64  \`json:"budget_spent_micros"\`
}

type CampaignStore interface {
	ActiveCampaigns(ctx context.Context, placement string) ([]Campaign, error)
	Frequency(ctx context.Context, campaignID, userHash string, windowS int) (int, error)
}

var store CampaignStore

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func isEligible(ctx context.Context, c Campaign, userHash string) bool {
	if inactiveStates[c.State] {
		return false
	}
	if c.BudgetSpentMicros >= c.PacedBudgetMicros {
		return false
	}
	seen, err := store.Frequency(ctx, c.CampaignID, userHash, c.FreqWindowS)
	if err != nil {
		return false
	}
	return seen < c.FreqCapImpressions
}

func serve(rw http.ResponseWriter, r *http.Request) {
	var body ServeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Placement == "" || len(body.Placement) > maxPlacementChars {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "placement must be 1..64 characters"})
		return
	}
	if body.UserHash == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "user_hash is required"})
		return
	}
	if !allowedFormats[body.PageContext.Format] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown format"})
		return
	}
	candidates, err := store.ActiveCampaigns(r.Context(), body.Placement)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "campaign store unavailable"})
		return
	}
	eligible := make([]Campaign, 0, len(candidates))
	for _, c := range candidates {
		if isEligible(r.Context(), c, body.UserHash) {
			eligible = append(eligible, c)
		}
	}
	if len(eligible) == 0 {
		writeJSON(rw, http.StatusOK, map[string]any{"ad": nil, "reason": "no_eligible_campaign"})
		return
	}
	won := eligible[0]
	for _, c := range eligible[1:] {
		if c.BidMicros > won.BidMicros {
			won = c
		}
	}
	log.Printf("serve placement=%s campaign=%s", body.Placement, won.CampaignID)
	writeJSON(rw, http.StatusOK, map[string]any{
		"ad": map[string]any{
			"campaign_id":  won.CampaignID,
			"creative_id":  won.CreativeID,
			"price_micros": won.BidMicros,
		},
		"campaign_version": won.CampaignVersion,
		"fallback":         false,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/ads/serve", serve)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class PageContext(url: String, num_ads: Int, format: String)
final case class ServeRequest(placement: String, user_hash: String, page_context: PageContext)

final case class Campaign(campaign_id: String, creative_id: String, bid_micros: Long)

object AdApi {
  implicit val system: ActorSystem = ActorSystem("ad-server")
  implicit val pageFormat: RootJsonFormat[PageContext] = jsonFormat3(PageContext)
  implicit val requestFormat: RootJsonFormat[ServeRequest] = jsonFormat3(ServeRequest)

  val store = CampaignStore.open()

  val route: Route =
    path("v1" / "ads" / "serve") {
      post {
        entity(as[ServeRequest]) { body =>
          // TODO: this draft ranks the highest bidder without consulting the campaign's state,
          // its pacing budget or the user's frequency cap, and the response omits the campaign
          // version the decision was made against. Review all three flaws.
          val won = store.activeCampaigns(body.placement).maxByOption(_.bid_micros)
          won match {
            case None =>
              complete(StatusCodes.OK, """{"ad":null,"reason":"no_fill"}""")
            case Some(c) =>
              system.log.info(s"serve placement=\${body.placement} campaign=\${c.campaign_id}")
              complete(
                StatusCodes.OK,
                JsObject(
                  "ad" -> JsObject(
                    "campaign_id" -> JsString(c.campaign_id),
                    "creative_id" -> JsString(c.creative_id),
                    "price_micros" -> JsNumber(c.bid_micros)),
                  "fallback" -> JsBoolean(false)))
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}

trait CampaignStore {
  def activeCampaigns(placement: String): List[Campaign]
}

object CampaignStore {
  def open(): CampaignStore = ???
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json._

final case class PageContext(url: String, num_ads: Int, format: String)
final case class ServeRequest(placement: String, user_hash: String, page_context: PageContext)

final case class Campaign(
    campaign_id: String,
    campaign_version: String,
    creative_id: String,
    bid_micros: Long,
    state: String,
    freq_cap_impressions: Int,
    freq_window_s: Int,
    paced_budget_micros: Long,
    budget_spent_micros: Long)

object AdApi {
  implicit val system: ActorSystem = ActorSystem("ad-server")
  implicit val pageFormat: RootJsonFormat[PageContext] = jsonFormat3(PageContext)
  implicit val requestFormat: RootJsonFormat[ServeRequest] = jsonFormat3(ServeRequest)

  val MaxPlacementChars = 64
  val InactiveStates = Set("paused", "exhausted")
  val AllowedFormats = Set("banner", "native", "video")

  val store = CampaignStore.open()

  def isEligible(campaign: Campaign, userHash: String): Boolean = {
    val spent = campaign.budget_spent_micros
    val budget = campaign.paced_budget_micros
    val seen = store.frequency(campaign.campaign_id, userHash, campaign.freq_window_s)
    !InactiveStates.contains(campaign.state) &&
      spent < budget &&
      seen < campaign.freq_cap_impressions
  }

  val route: Route =
    path("v1" / "ads" / "serve") {
      post {
        entity(as[ServeRequest]) { body =>
          if (body.placement.isEmpty || body.placement.length > MaxPlacementChars) {
            complete(StatusCodes.BadRequest, """{"error":"placement must be 1..64 characters"}""")
          } else if (body.user_hash.isEmpty) {
            complete(StatusCodes.BadRequest, """{"error":"user_hash is required"}""")
          } else if (!AllowedFormats.contains(body.page_context.format)) {
            complete(StatusCodes.BadRequest, """{"error":"unknown format"}""")
          } else {
            val eligible = store.activeCampaigns(body.placement).filter(isEligible(_, body.user_hash))
            if (eligible.isEmpty) {
              complete(StatusCodes.OK, """{"ad":null,"reason":"no_eligible_campaign"}""")
            } else {
              val won = eligible.maxBy(_.bid_micros)
              system.log.info(s"serve placement=\${body.placement} campaign=\${won.campaign_id}")
              complete(
                StatusCodes.OK,
                JsObject(
                  "ad" -> JsObject(
                    "campaign_id" -> JsString(won.campaign_id),
                    "creative_id" -> JsString(won.creative_id),
                    "price_micros" -> JsNumber(won.bid_micros)),
                  "campaign_version" -> JsString(won.campaign_version),
                  "fallback" -> JsBoolean(false)))
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}

trait CampaignStore {
  def activeCampaigns(placement: String): List[Campaign]
  def frequency(campaignId: String, userHash: String, windowS: Int): Int
}

object CampaignStore {
  def open(): CampaignStore = ???
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

struct Campaign {
  std::string campaign_id;
  std::string creative_id;
  long bid_micros;
};

struct CampaignStore {
  std::vector<Campaign> activeCampaigns(const std::string& placement);
};

CampaignStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/ads/serve", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft ranks the highest bidder without consulting the campaign's state, its
    // pacing budget or the user's frequency cap, and the response omits the campaign version
    // the decision was made against. Review all three flaws.
    const std::string placement = body.value("placement", std::string());
    const std::string userHash = body.value("user_hash", std::string());
    const auto campaigns = store.activeCampaigns(placement);
    if (campaigns.empty()) {
      res.status = 200;
      res.set_content(R"({"ad":null,"reason":"no_fill"})", "application/json");
      return;
    }
    const auto& won = *std::max_element(campaigns.begin(), campaigns.end(),
                                        [](const Campaign& a, const Campaign& b) {
                                          return a.bid_micros < b.bid_micros;
                                        });
    std::cerr << "serve placement=" << placement << " campaign=" << won.campaign_id << "\\n";
    res.status = 200;
    res.set_content(
        json{{"ad",
              {{"campaign_id", won.campaign_id},
               {"creative_id", won.creative_id},
               {"price_micros", won.bid_micros}}},
             {"fallback", false}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxPlacementChars = 64;
const std::set<std::string> kInactiveStates = {"paused", "exhausted"};
const std::set<std::string> kAllowedFormats = {"banner", "native", "video"};

struct Campaign {
  std::string campaign_id;
  std::string campaign_version;
  std::string creative_id;
  long bid_micros;
  std::string state;
  int freq_cap_impressions;
  int freq_window_s;
  long paced_budget_micros;
  long budget_spent_micros;
};

struct CampaignStore {
  std::vector<Campaign> activeCampaigns(const std::string& placement);
  long frequency(const std::string& campaignId, const std::string& userHash, int windowS);
};

CampaignStore store;

bool isEligible(const Campaign& campaign, const std::string& userHash) {
  if (kInactiveStates.count(campaign.state) > 0) return false;
  if (campaign.budget_spent_micros >= campaign.paced_budget_micros) return false;
  const long seen = store.frequency(campaign.campaign_id, userHash, campaign.freq_window_s);
  return seen < campaign.freq_cap_impressions;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/ads/serve", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const std::string placement = body.value("placement", std::string());
    if (placement.empty() || placement.size() > kMaxPlacementChars) {
      res.status = 400;
      res.set_content(R"({"error":"placement must be 1..64 characters"})", "application/json");
      return;
    }
    const std::string userHash = body.value("user_hash", std::string());
    if (userHash.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"user_hash is required"})", "application/json");
      return;
    }
    const std::string format = body.contains("page_context") && body["page_context"].contains("format")
                                   ? body["page_context"]["format"].get<std::string>()
                                   : std::string("banner");
    if (kAllowedFormats.count(format) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown format"})", "application/json");
      return;
    }

    std::vector<Campaign> eligible;
    for (const auto& c : store.activeCampaigns(placement)) {
      if (isEligible(c, userHash)) eligible.push_back(c);
    }
    if (eligible.empty()) {
      res.status = 200;
      res.set_content(R"({"ad":null,"reason":"no_eligible_campaign"})", "application/json");
      return;
    }
    const auto& won = *std::max_element(eligible.begin(), eligible.end(), [](const Campaign& a, const Campaign& b) {
      return a.bid_micros < b.bid_micros;
    });
    std::cerr << "serve placement=" << placement << " campaign=" << won.campaign_id << "\\n";
    res.status = 200;
    res.set_content(
        json{{"ad",
              {{"campaign_id", won.campaign_id},
               {"creative_id", won.creative_id},
               {"price_micros", won.bid_micros}}},
             {"campaign_version", won.campaign_version},
             {"fallback", false}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Filter, then rank. Every campaign the request may not serve (wrong state, spent pacing budget, this user already at the cap) has to be removed from the candidate list before you compare bids, otherwise the highest bidder wins every argument — including the ones it must lose.',
    'The frequency counter lives behind a store call, not in the request: `frequency(campaign_id, user_hash, window_s)` answers "impressions for this user inside the campaign window". Compare it with `freq_cap_impressions` and drop the campaign when it is reached.',
    'Return `campaign_version` with the ad — the version the decision used, which is the one whose caps and budget you just checked. If a report later asks why this impression appeared, the version is how you replay the decision instead of guessing from the current config.',
  ],
  debrief: `The interviewer is testing whether you review a generated handler at the point where revenue meets policy. The draft reads fine because the demo has one user, one page and an unspent budget; the flaws only show up under repetition, which is exactly what a frequency cap exists for. Three separate defects are checked: cheap rejection of malformed requests before any lookup, limits (state, pacing, per-user cap) applied before relevance, and a response that names the campaign version rather than an anonymous ad. The version is the one candidates forget: without it, a mid-flight campaign edit makes yesterday's delivery figures unreproducible and the render reconciliation cannot tell which cap was in force. Real servers go further: auction-level floors, per-placement pacing as its own control loop, budget smoothing against a diurnal curve, and a serving log with feature ids only — never the user identity.`,
};
