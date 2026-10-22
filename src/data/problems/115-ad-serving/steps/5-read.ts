import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/campaigns/{id}/delivery: pacing that reflects reality',
  concept: 'http',
  file: 'read',
  focus: ['advertiser', 'server', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the delivery report: it
loads the campaign, reads a counter and formats a response. It hides three production flaws, and all
three end up in the numbers an advertiser is shown. Review it like the service owner, fix it, and
prove the fix with the checks below.

Implement \`GET /v1/campaigns/{campaign_id}/delivery\` for the advertiser console.

- \`X-Advertiser-Id\` is required (**401** when missing) and the campaign must belong to that
  advertiser — a **foreign campaign is 403**, not a redacted report. An unknown campaign is **404**.
- \`paced_spend_micros\` and the impression count come from **the same counters the serve path
  writes**, and the impression count is the one taken **at render**: \`counted_at\` says \`render\`
  and \`reconciled_impressions\` is the count reconciled from render events. Serve-time counts are
  what the draft reports, and they inflate delivery by every ad that was chosen but never shown.
- The response includes \`cap_exhausted_at\` — when the pacing budget ran out, if it has — so the
  console can explain a campaign that stopped early instead of hiding it behind a totals row.
- The response includes \`under_delivery_impressions\`: the shortfall projected from the campaign's
  schedule to its end. It must appear **before the campaign ends**, because that is the only time
  anyone can still fix it.

**Failure mode the checks target.** The draft counts when the ad was served, so the report is
optimistic; it omits the projection, so a campaign that will miss its goal looks healthy until the
last day; and it answers any advertiser for any campaign, which is a data leak between advertisers
and the kind of bug that ends a partnership rather than a demo.`,
  sequence: {
    participants: ['Advertiser console', 'Ad Server', 'pacing counters', 'campaign store'],
    messages: [
      {
        from: 'Advertiser console',
        to: 'Ad Server',
        label: 'GET /v1/campaigns/{id}/delivery · X-Advertiser-Id',
        kind: 'sync',
      },
      {
        from: 'Ad Server',
        to: 'campaign store',
        label: 'campaign(id) · advertiser_id · version · schedule',
        kind: 'sync',
      },
      {from: 'campaign store', to: 'Ad Server', label: 'campaign / none', kind: 'reply'},
      {from: 'Ad Server', to: 'Ad Server', label: 'campaign.advertiser_id != caller → 403', kind: 'sync'},
      {from: 'Ad Server', to: 'pacing counters', label: 'render:{id} · pace:{id} · cap_exhausted:{id}', kind: 'sync'},
      {
        from: 'pacing counters',
        to: 'Ad Server',
        label: 'counted at render · paced spend · exhausted time',
        kind: 'reply',
      },
      {
        from: 'Ad Server',
        to: 'Advertiser console',
        label: '200 {counted_at, reconciled, under_delivery}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/campaigns/{id}/delivery',
      detail: 'Register the delivery read on `GET /v1/campaigns/{campaign_id}/delivery`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/campaigns\/\{campaign_id\}\/delivery["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/campaigns\/:campaignId\/delivery['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/campaigns\/\{campaignID\}\/delivery"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"campaigns"\s*\/\s*Segment\s*\/\s*"delivery"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(\/v1\/campaigns\//, /delivery\)"/]},
      },
    },
    {
      id: 'render-counts',
      title: 'Reports counts taken at render, not at serve',
      detail:
        '`counted_at` is `render` and `reconciled_impressions` is the count reconciled from render events, read from the same counters the serve path writes. The draft reports serve-time counts, so every ad that was chosen but never displayed is billed as delivered.',
      match: {
        python: {all: [/counted_at/, /['"]render['"]/, /reconciled/], none: [/counted_at[^\n]*['"]serve['"]/]},
        typescript: {all: [/counted_at/, /['"]render['"]/, /reconciled/], none: [/counted_at[^\n]*['"]serve['"]/]},
        go: {all: [/counted_at/, /['"]render['"]/, /reconciled/], none: [/counted_at[^\n]*['"]serve['"]/]},
        scala: {all: [/counted_at/, /['"]render['"]/, /reconciled/], none: [/counted_at[^\n]*['"]serve['"]/]},
        cpp: {all: [/counted_at/, /['"]render['"]/, /reconciled/], none: [/counted_at[^\n]*['"]serve['"]/]},
      },
    },
    {
      id: 'under-delivery',
      title: 'Projects under-delivery before the campaign ends',
      detail:
        'The response carries `under_delivery_impressions`, the shortfall projected from the schedule and the render count. The draft omits it, so a campaign that will miss its goal looks healthy until the last day.',
      match: {
        python: {all: [/under_delivery_impressions/]},
        typescript: {all: [/under_delivery_impressions/]},
        go: {all: [/under_delivery_impressions/]},
        scala: {all: [/under_delivery_impressions/]},
        cpp: {all: [/under_delivery_impressions/]},
      },
    },
    {
      id: 'pacing-picture',
      title: 'Reports paced spend and when the cap ran out',
      detail:
        '`paced_spend_micros` comes from the campaign’s pacing counter and `cap_exhausted_at` records when the budget ran out, so a stopped campaign is explained rather than hidden. The draft reports a raw spend with no pacing or exhaustion story.',
      match: {
        python: {all: [/paced_spend_micros/, /cap_exhausted_at/]},
        typescript: {all: [/paced_spend_micros/, /cap_exhausted_at/]},
        go: {all: [/paced_spend_micros/, /cap_exhausted_at/]},
        scala: {all: [/paced_spend_micros/, /cap_exhausted_at/]},
        cpp: {all: [/paced_spend_micros/, /cap_exhausted_at/]},
      },
    },
    {
      id: 'advertiser-scope',
      title: 'Refuses a campaign that belongs to another advertiser',
      detail:
        'The caller is authenticated with `X-Advertiser-Id` (**401** when missing) and a campaign owned by someone else is **403**. The draft serves any campaign to any advertiser, leaking delivery data across accounts.',
      match: {
        python: {all: [/advertiser/, /status_code\s*=\s*403/]},
        typescript: {all: [/advertiser/, /code\(\s*403\s*\)/]},
        go: {all: [/advertiser/, /StatusForbidden/]},
        scala: {all: [/advertiser/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/advertiser/, /\b403\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("adserver.delivery")


class DeliveryReader:
    def campaign(self, campaign_id: str) -> dict:
        """Campaign metadata: advertiser, version, schedule and pacing budget."""
        raise NotImplementedError

    def served_impressions(self, campaign_id: str) -> int:
        """Impressions recorded when the ad was chosen — what the draft reports as delivery."""
        raise NotImplementedError

    def spend_micros(self, campaign_id: str) -> int:
        raise NotImplementedError


reader = DeliveryReader()


@app.get("/v1/campaigns/{campaign_id}/delivery")
def delivery(campaign_id: str) -> JSONResponse:
    # TODO: this draft reports the counts taken when the ad was served rather than when it was
    # rendered, omits the under-delivery projection, and answers any campaign for any advertiser.
    # Review all three flaws.
    campaign = reader.campaign(campaign_id)
    return JSONResponse(
        {
            "campaign_id": campaign_id,
            "campaign_version": campaign["campaign_version"],
            "counted_at": "serve",
            "impressions": reader.served_impressions(campaign_id),
            "spend_micros": reader.spend_micros(campaign_id),
            "budget_micros": campaign["paced_budget_micros"],
        },
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("adserver.delivery")

COUNTS_AT = "render"


class DeliveryReader:
    """Reads the counters the serve path writes and the render path increments."""

    def campaign(self, campaign_id: str) -> dict | None:
        """Campaign metadata: advertiser, version, schedule and pacing budget."""
        raise NotImplementedError

    def render_impressions(self, campaign_id: str) -> int:
        """Impressions counted at render: the only count an advertiser can be billed for."""
        raise NotImplementedError

    def paced_spend_micros(self, campaign_id: str) -> int:
        raise NotImplementedError

    def cap_exhausted_at(self, campaign_id: str) -> str | None:
        """When the pacing budget ran out, if it has: the campaign is throttled, not deleted."""
        raise NotImplementedError


reader = DeliveryReader()


def project_under_delivery(campaign: dict, impressions: int) -> int:
    """The shortfall the schedule implies if the current render rate holds to the end."""
    scheduled = campaign["scheduled_impressions"]
    if impressions >= scheduled:
        return 0
    share = min(max(campaign["elapsed_fraction"], 0.0), 1.0)
    if share <= 0.0:
        return scheduled
    projected = int(scheduled * share)
    return max(scheduled - max(projected, impressions), 0)


@app.get("/v1/campaigns/{campaign_id}/delivery")
def delivery(
    campaign_id: str,
    advertiser: str | None = Header(default=None, alias="X-Advertiser-Id"),
) -> JSONResponse:
    if advertiser is None or advertiser == "":
        raise HTTPException(status_code=401, detail="missing X-Advertiser-Id")
    campaign = reader.campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="unknown campaign")
    if campaign["advertiser_id"] != advertiser:
        raise HTTPException(status_code=403, detail="campaign belongs to another advertiser")

    impressions = reader.render_impressions(campaign_id)
    logger.info("delivery campaign=%s advertiser=%s impressions=%d", campaign_id, advertiser, impressions)
    return JSONResponse(
        {
            "campaign_id": campaign_id,
            "campaign_version": campaign["campaign_version"],
            "counted_at": COUNTS_AT,
            "reconciled_impressions": impressions,
            "paced_spend_micros": reader.paced_spend_micros(campaign_id),
            "cap_exhausted_at": reader.cap_exhausted_at(campaign_id),
            "under_delivery_impressions": project_under_delivery(campaign, impressions),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** Delivery read: a model-generated draft that reports serve-time counts. */
import Fastify from 'fastify';

export const app = Fastify();

interface Campaign {
  campaign_version: string;
  paced_budget_micros: number;
}

interface DeliveryReader {
  campaign(campaignId: string): Promise<Campaign>;
  servedImpressions(campaignId: string): Promise<number>;
  spendMicros(campaignId: string): Promise<number>;
}

declare const reader: DeliveryReader;

app.get('/v1/campaigns/:campaignId/delivery', async (request, reply) => {
  // TODO: this draft reports the counts taken when the ad was served rather than when it was
  // rendered, omits the under-delivery projection, and answers any campaign for any advertiser.
  // Review all three flaws.
  const {campaignId} = request.params as {campaignId: string};
  const campaign = await reader.campaign(campaignId);
  return reply.code(200).send({
    campaign_id: campaignId,
    campaign_version: campaign.campaign_version,
    counted_at: 'serve',
    impressions: await reader.servedImpressions(campaignId),
    spend_micros: await reader.spendMicros(campaignId),
    budget_micros: campaign.paced_budget_micros,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Delivery read: counts at render, paced spend, exhaustion time and a projection. */
import Fastify from 'fastify';

export const app = Fastify();

const COUNTS_AT = 'render';

interface Campaign {
  campaign_version: string;
  advertiser_id: string;
  scheduled_impressions: number;
  elapsed_fraction: number;
}

interface DeliveryReader {
  campaign(campaignId: string): Promise<Campaign | null>;
  renderImpressions(campaignId: string): Promise<number>;
  pacedSpendMicros(campaignId: string): Promise<number>;
  capExhaustedAt(campaignId: string): Promise<string | null>;
}

declare const reader: DeliveryReader;

function projectUnderDelivery(campaign: Campaign, impressions: number): number {
  const scheduled = campaign.scheduled_impressions;
  if (impressions >= scheduled) return 0;
  const share = Math.min(Math.max(campaign.elapsed_fraction, 0), 1);
  if (share <= 0) return scheduled;
  const projected = Math.floor(scheduled * share);
  return Math.max(scheduled - Math.max(projected, impressions), 0);
}

app.get('/v1/campaigns/:campaignId/delivery', async (request, reply) => {
  const advertiser = request.headers['x-advertiser-id'];
  if (typeof advertiser !== 'string' || advertiser === '')
    return reply.code(401).send({error: 'missing X-Advertiser-Id'});
  const {campaignId} = request.params as {campaignId: string};
  const campaign = await reader.campaign(campaignId);
  if (campaign === null) return reply.code(404).send({error: 'unknown campaign'});
  if (campaign.advertiser_id !== advertiser)
    return reply.code(403).send({error: 'campaign belongs to another advertiser'});

  const impressions = await reader.renderImpressions(campaignId);
  request.log.info({campaign_id: campaignId, advertiser, impressions}, 'delivery read');
  return reply.code(200).send({
    campaign_id: campaignId,
    campaign_version: campaign.campaign_version,
    counted_at: COUNTS_AT,
    reconciled_impressions: impressions,
    paced_spend_micros: await reader.pacedSpendMicros(campaignId),
    cap_exhausted_at: await reader.capExhaustedAt(campaignId),
    under_delivery_impressions: projectUnderDelivery(campaign, impressions),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type Campaign struct {
	CampaignID        string \`json:"campaign_id"\`
	CampaignVersion   string \`json:"campaign_version"\`
	PacedBudgetMicros int64  \`json:"paced_budget_micros"\`
}

type DeliveryReader interface {
	Campaign(campaignID string) (Campaign, error)
	ServedImpressions(campaignID string) (int64, error)
	SpendMicros(campaignID string) (int64, error)
}

var reader DeliveryReader

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func delivery(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft reports the counts taken when the ad was served rather than when it was
	// rendered, omits the under-delivery projection, and answers any campaign for any
	// advertiser. Review all three flaws.
	campaignID := r.PathValue("campaignID")
	campaign, err := reader.Campaign(campaignID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown campaign"})
		return
	}
	served, _ := reader.ServedImpressions(campaignID)
	spend, _ := reader.SpendMicros(campaignID)
	writeJSON(rw, http.StatusOK, map[string]any{
		"campaign_id":      campaignID,
		"campaign_version": campaign.CampaignVersion,
		"counted_at":       "serve",
		"impressions":      served,
		"spend_micros":     spend,
		"budget_micros":    campaign.PacedBudgetMicros,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/campaigns/{campaignID}/delivery", delivery)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

const countedAt = "render"

type Campaign struct {
	CampaignID           string  \`json:"campaign_id"\`
	CampaignVersion      string  \`json:"campaign_version"\`
	AdvertiserID         string  \`json:"advertiser_id"\`
	PacedBudgetMicros    int64   \`json:"paced_budget_micros"\`
	ScheduledImpressions int64   \`json:"scheduled_impressions"\`
	ElapsedFraction      float64 \`json:"elapsed_fraction"\`
}

type DeliveryReader interface {
	Campaign(campaignID string) (Campaign, bool, error)
	RenderImpressions(campaignID string) (int64, error)
	PacedSpendMicros(campaignID string) (int64, error)
	CapExhaustedAt(campaignID string) (string, bool, error)
}

var reader DeliveryReader

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// projectUnderDelivery is the shortfall the schedule implies if the render rate holds to the end.
func projectUnderDelivery(campaign Campaign, impressions int64) int64 {
	scheduled := campaign.ScheduledImpressions
	if impressions >= scheduled {
		return 0
	}
	share := campaign.ElapsedFraction
	if share > 1 {
		share = 1
	}
	if share <= 0 {
		return scheduled
	}
	projected := int64(float64(scheduled) * share)
	if impressions > projected {
		projected = impressions
	}
	if scheduled <= projected {
		return 0
	}
	return scheduled - projected
}

func delivery(rw http.ResponseWriter, r *http.Request) {
	advertiser := r.Header.Get("X-Advertiser-Id")
	if advertiser == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Advertiser-Id"})
		return
	}
	campaignID := r.PathValue("campaignID")
	campaign, found, err := reader.Campaign(campaignID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "campaign store unavailable"})
		return
	}
	if !found {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown campaign"})
		return
	}
	if campaign.AdvertiserID != advertiser {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "campaign belongs to another advertiser"})
		return
	}
	impressions, err := reader.RenderImpressions(campaignID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "counters unavailable"})
		return
	}
	spend, err := reader.PacedSpendMicros(campaignID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "counters unavailable"})
		return
	}
	exhaustedAt, hasExhaustedAt, err := reader.CapExhaustedAt(campaignID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "counters unavailable"})
		return
	}
	var capExhaustedAt any
	if hasExhaustedAt {
		capExhaustedAt = exhaustedAt
	}
	log.Printf("delivery campaign=%s advertiser=%s impressions=%d", campaignID, advertiser, impressions)
	writeJSON(rw, http.StatusOK, map[string]any{
		"campaign_id":               campaignID,
		"campaign_version":          campaign.CampaignVersion,
		"counted_at":                countedAt,
		"reconciled_impressions":    impressions,
		"paced_spend_micros":        spend,
		"cap_exhausted_at":          capExhaustedAt,
		"under_delivery_impressions": projectUnderDelivery(campaign, impressions),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/campaigns/{campaignID}/delivery", delivery)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class Campaign(campaign_id: String, campaign_version: String, paced_budget_micros: Long)

object DeliveryRead {
  implicit val system: ActorSystem = ActorSystem("ad-server")

  val reader = DeliveryReader.open()

  val route: Route =
    path("v1" / "campaigns" / Segment / "delivery") {
      get {
        campaignId =>
          // TODO: this draft reports the counts taken when the ad was served rather than when it
          // was rendered, omits the under-delivery projection, and answers any campaign for any
          // advertiser. Review all three flaws.
          val campaign = reader.campaign(campaignId)
          complete(
            StatusCodes.OK,
            JsObject(
              "campaign_id" -> JsString(campaignId),
              "campaign_version" -> JsString(campaign.campaign_version),
              "counted_at" -> JsString("serve"),
              "impressions" -> JsNumber(reader.servedImpressions(campaignId)),
              "spend_micros" -> JsNumber(reader.spendMicros(campaignId)),
              "budget_micros" -> JsNumber(campaign.paced_budget_micros)))
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class Campaign(
    campaign_id: String,
    campaign_version: String,
    advertiser_id: String,
    scheduled_impressions: Long,
    elapsed_fraction: Double)

object DeliveryRead {
  implicit val system: ActorSystem = ActorSystem("ad-server")

  val CountedAt = "render"

  val reader = DeliveryReader.open()

  /** The shortfall the schedule implies if the render rate holds to the end of the flight. */
  def projectUnderDelivery(campaign: Campaign, impressions: Long): Long = {
    val scheduled = campaign.scheduled_impressions
    if (impressions >= scheduled) 0L
    else {
      val share = math.min(math.max(campaign.elapsed_fraction, 0.0), 1.0)
      if (share <= 0.0) scheduled
      else math.max(scheduled - math.max((scheduled * share).toLong, impressions), 0L)
    }
  }

  val route: Route =
    path("v1" / "campaigns" / Segment / "delivery") {
      get {
        campaignId =>
          optionalHeaderValueByName("X-Advertiser-Id") { advertiserOpt =>
            if (!advertiserOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Advertiser-Id"}""")
            } else {
              val advertiser = advertiserOpt.get
              reader.campaign(campaignId) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"unknown campaign"}""")
                case Some(campaign) if campaign.advertiser_id != advertiser =>
                  complete(StatusCodes.Forbidden, """{"error":"campaign belongs to another advertiser"}""")
                case Some(campaign) =>
                  val impressions = reader.renderImpressions(campaignId)
                  complete(
                    StatusCodes.OK,
                    JsObject(
                      "campaign_id" -> JsString(campaignId),
                      "campaign_version" -> JsString(campaign.campaign_version),
                      "counted_at" -> JsString(CountedAt),
                      "reconciled_impressions" -> JsNumber(impressions),
                      "paced_spend_micros" -> JsNumber(reader.pacedSpendMicros(campaignId)),
                      "cap_exhausted_at" -> reader.capExhaustedAt(campaignId).map(JsString(_)).getOrElse(JsNull),
                      "under_delivery_impressions" -> JsNumber(projectUnderDelivery(campaign, impressions))))
              }
            }
          }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}

trait DeliveryReader {
  def campaign(campaignId: String): Option[Campaign]
  def renderImpressions(campaignId: String): Long
  def pacedSpendMicros(campaignId: String): Long
  def capExhaustedAt(campaignId: String): Option[String]
}

object DeliveryReader {
  def open(): DeliveryReader = ???
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

struct Campaign {
  std::string campaign_id;
  std::string campaign_version;
  long paced_budget_micros;
};

struct DeliveryReader {
  std::optional<Campaign> campaign(const std::string& campaignId);
  long servedImpressions(const std::string& campaignId);
  long spendMicros(const std::string& campaignId);
};

DeliveryReader reader;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/campaigns/([^/]+)/delivery)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reports the counts taken when the ad was served rather than when it was
    // rendered, omits the under-delivery projection, and answers any campaign for any
    // advertiser. Review all three flaws.
    const std::string campaignId = req.matches[1];
    const auto campaign = reader.campaign(campaignId);
    if (!campaign) {
      res.status = 404;
      res.set_content(R"({"error":"unknown campaign"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"campaign_id", campaignId},
                         {"campaign_version", campaign->campaign_version},
                         {"counted_at", "serve"},
                         {"impressions", reader.servedImpressions(campaignId)},
                         {"spend_micros", reader.spendMicros(campaignId)},
                         {"budget_micros", campaign->paced_budget_micros}}
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
#include <optional>
#include <string>

using json = nlohmann::json;

const std::string kCountedAt = "render";

struct Campaign {
  std::string campaign_id;
  std::string campaign_version;
  std::string advertiser_id;
  long scheduled_impressions;
  double elapsed_fraction;
};

struct DeliveryReader {
  std::optional<Campaign> campaign(const std::string& campaignId);
  long renderImpressions(const std::string& campaignId);
  long pacedSpendMicros(const std::string& campaignId);
  std::optional<std::string> capExhaustedAt(const std::string& campaignId);
};

DeliveryReader reader;

/** The shortfall the schedule implies if the render rate holds to the end of the flight. */
long projectUnderDelivery(const Campaign& campaign, long impressions) {
  const long scheduled = campaign.scheduled_impressions;
  if (impressions >= scheduled) return 0;
  const double share = std::min(std::max(campaign.elapsed_fraction, 0.0), 1.0);
  if (share <= 0.0) return scheduled;
  const long projected = std::max(static_cast<long>(scheduled * share), impressions);
  return std::max(scheduled - projected, 0L);
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/campaigns/([^/]+)/delivery)", [](const httplib::Request& req, httplib::Response& res) {
    const auto advertiser = req.get_header_value("X-Advertiser-Id");
    if (advertiser.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Advertiser-Id"})", "application/json");
      return;
    }
    const std::string campaignId = req.matches[1];
    const auto campaign = reader.campaign(campaignId);
    if (!campaign) {
      res.status = 404;
      res.set_content(R"({"error":"unknown campaign"})", "application/json");
      return;
    }
    if (campaign->advertiser_id != advertiser) {
      res.status = 403;
      res.set_content(R"({"error":"campaign belongs to another advertiser"})", "application/json");
      return;
    }
    const long impressions = reader.renderImpressions(campaignId);
    const auto exhaustedAt = reader.capExhaustedAt(campaignId);
    std::cerr << "delivery campaign=" << campaignId << " advertiser=" << advertiser << "\\n";
    res.status = 200;
    res.set_content(json{{"campaign_id", campaignId},
                         {"campaign_version", campaign->campaign_version},
                         {"counted_at", kCountedAt},
                         {"reconciled_impressions", impressions},
                         {"paced_spend_micros", reader.pacedSpendMicros(campaignId)},
                         {"cap_exhausted_at", exhaustedAt ? json(*exhaustedAt) : json(nullptr)},
                         {"under_delivery_impressions", projectUnderDelivery(*campaign, impressions)}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Read the counters the serve path writes, not a second set of numbers maintained by the report. `render:{campaign_id}` for the delivered impressions, `pace:{campaign_id}` for the paced spend — one source of truth, so the report and the pacing loop cannot disagree.',
    'Say when the counts were taken: `counted_at: "render"` plus the reconciled count. A report without that label is just a number someone has to trust, and serve-time counts are the optimistic number the draft shipped.',
    'Project before the end, not after it: derive the shortfall from the schedule and the current rate so the console can alarm while there is still time to raise the pacing. And gate on ownership — a foreign campaign is 403, not a redacted view.',
  ],
  debrief: `The interviewer is testing whether the report tells the truth, which in an ad system is a billing question rather than a UI one. Three separate defects are checked: counts taken at render instead of at serve (reconciled against the same counters), a projection that surfaces under-delivery while the campaign can still be fixed, and an ownership check that keeps one advertiser out of another's delivery data. The projection is the one candidates skip, because it is the only part that has to know the campaign's schedule rather than just read a counter — and it is the part an advertiser actually acts on. Real delivery reads add a breakdown by placement and creative, a confidence interval on the projection from the last window's rate, the pacing curve in force at each hour, and an audit trail of who read which campaign's numbers.`,
};
