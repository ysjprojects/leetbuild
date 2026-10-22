import type {Step} from '@/lib/types';

/**
 * Step 5 — the stats read. Win rate against every auction seen, timeout and degradation shares, and
 * spend versus cap, served only to the bidder it belongs to.
 */
export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/bidders/{id}/stats: latency and timeouts are first-class',
  concept: 'http',
  file: 'read',
  focus: ['exchange', 'bidding', 'redis', 'consumer'],
  task: `## Task

**Review premise.** You are the AI platform engineer on call. The dashboard says a bidder has a 94% win
rate and is "healthy", yet the bidder won almost nothing last week: the rate is computed against the
auctions it won and lost, and the bids that timed out were never counted at all. On top of that, any
advertiser can read any other advertiser's numbers by editing the id in the URL.

Review \`read\` and make the stats tell the truth.

Implement \`GET /v1/bidders/{id}/stats?window=day\`.

- The caller comes from the authenticated \`X-Bidder-Id\` header (**401** when missing) and may read
  **only its own** stats: a foreign bidder id is **403**. The draft serves anyone.
- \`window\` is one of \`hour\` or \`day\` (**400** otherwise) and defaults to \`day\`; it selects the
  counter bucket, not the response shape.
- \`win_rate\` is wins against **every auction the bidder saw** (\`auctions_seen\`, which includes
  no-bids and timeouts), never against wins plus losses. Define it as a named \`win_rate\` /
  \`winRate\` and let it answer \`0\` for a bidder that has seen nothing.
- \`bid_rate\` is bids over auctions seen, and **\`timeout_rate\`** is the share of auctions that ran out
  of budget — a slow bidder must look slow. The response must carry both.
- **\`degraded_share\`** is first-class too: the share of placed bids that were marked degraded, so
  tiered degradation is visible next to the money.
- Report **spend versus cap** for the same window: \`spend_cents\` from the counters and \`cap_cents\`
  from the spend ledger, so an operator can see how close the bidder is to its daily limit.

**Failure mode the checks target.** The draft omits timeouts and degradation entirely, so the two
symptoms that matter most — bids that never made the deadline and bids that are only conservative —
are invisible. Its win rate divides by wins plus losses, which flatters exactly the bidder in the
briefing: the more auctions it timed out on, the better its reported rate. And it treats the path
parameter as an identifier rather than an authorization decision.`,
  sequence: {
    participants: ['Advertiser console', 'Stats endpoint', 'Redis counters', 'Spend ledger'],
    messages: [
      {from: 'Advertiser console', to: 'Stats endpoint', label: 'GET /v1/bidders/b-7/stats?window=day', kind: 'sync'},
      {
        from: 'Stats endpoint',
        to: 'Stats endpoint',
        label: 'caller = X-Bidder-Id → 403 when it is not b-7',
        kind: 'sync',
      },
      {from: 'Stats endpoint', to: 'Redis counters', label: 'HGETALL stats:b-7:day', kind: 'sync'},
      {
        from: 'Redis counters',
        to: 'Stats endpoint',
        label: 'auctions_seen · bids · wins · timeouts · degraded',
        kind: 'reply',
      },
      {from: 'Stats endpoint', to: 'Spend ledger', label: 'cap_cents(b-7, day)', kind: 'sync'},
      {from: 'Spend ledger', to: 'Stats endpoint', label: 'spend_cents vs cap_cents', kind: 'reply'},
      {
        from: 'Stats endpoint',
        to: 'Advertiser console',
        label: '200 {win_rate, bid_rate, timeout_rate, degraded_share}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/bidders/{id}/stats',
      detail: 'Register the stats read on `GET /v1/bidders/{id}/stats`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/bidders\/\{bidder_id\}\/stats["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/bidders\/:bidderId\/stats['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/bidders\/\{bidder_id\}\/stats"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"bidders"\s*\/\s*Segment\s*\/\s*"stats"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/bidders\//, /\/stats/]},
      },
    },
    {
      id: 'timeout-share',
      title: 'Timeout and degradation shares are reported',
      detail:
        'The response carries `timeout_rate` (auctions that ran out of budget) and `degraded_share` (bids placed from a degraded tier). The draft omits both, so a bidder whose bids never land looks healthy.',
      match: {
        python: {all: [/"timeout_rate"/, /"degraded_share"/]},
        typescript: {all: [/timeout_rate/, /degraded_share/]},
        go: {all: [/"timeout_rate"/, /"degraded_share"/]},
        scala: {all: [/timeout_rate/, /degraded_share/]},
        cpp: {all: [/timeout_rate/, /degraded_share/]},
      },
    },
    {
      id: 'win-rate-denominator',
      title: 'Win rate is against every auction seen',
      detail:
        'A named `win_rate` / `winRate` divides wins by `auctions_seen` — including the auctions lost to a timeout or a no-bid — and returns 0 for a bidder that has seen nothing. The draft divides by wins plus losses, which flatters a bidder that mostly times out.',
      match: {
        python: {all: [/def win_rate\(/, /auctions_seen/], none: [/"wins"\]\s*\+\s*counters\["losses"\]/]},
        typescript: {all: [/function winRate\(/, /auctions_seen/], none: [/counters\.wins\s*\+\s*counters\.losses/]},
        go: {all: [/func winRate\(/, /auctions_seen/], none: [/counters\["wins"\]\s*\+\s*counters\["losses"\]/]},
        scala: {all: [/def winRate\(/, /auctions_seen/], none: [/counters\("wins"\)\s*\+\s*counters\("losses"\)/]},
        cpp: {all: [/winRate\(/, /auctions_seen/], none: [/wins\s*\+\s*losses/]},
      },
    },
    {
      id: 'foreign-403',
      title: 'A bidder cannot read another bidder’s stats',
      detail:
        'The authenticated `X-Bidder-Id` must match the bidder in the path: a foreign bidder is **403**, a missing caller **401**. The draft reads whatever id the URL happens to contain.',
      match: {
        python: {all: [/X-Bidder-Id/, /status_code\s*=\s*403/]},
        typescript: {all: [/x-bidder-id/, /code\(403\)/]},
        go: {all: [/X-Bidder-Id/, /StatusForbidden/]},
        scala: {all: [/X-Bidder-Id/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/X-Bidder-Id/, /\b403\b/]},
      },
    },
    {
      id: 'spend-window',
      title: 'Spend versus cap is reported for the window',
      detail:
        'The response reports `spend_cents` from the counters and `cap_cents` for the same `window`, so spend is readable next to the limit it consumes. The draft reports neither.',
      match: {
        python: {all: [/"spend_cents"/, /"cap_cents"/, /window/]},
        typescript: {all: [/spend_cents/, /cap_cents/, /window/]},
        go: {all: [/"spend_cents"/, /"cap_cents"/, /window/]},
        scala: {all: [/spend_cents/, /cap_cents/, /window/]},
        cpp: {all: [/spend_cents/, /cap_cents/, /window/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("bidding")


class StatsStore:
    """Per-bidder counters written by the event consumer."""

    def counters(self, bidder: str, window: str) -> dict:
        raise NotImplementedError


stats_store = StatsStore()


@app.get("/v1/bidders/{bidder_id}/stats")
def stats(bidder_id: str, window: str = Query(default="day")) -> JSONResponse:
    # TODO: this draft omits the timeout and degradation shares, computes the win rate against wins
    # and losses only (so a bidder whose bids never land looks perfect), and serves any bidder's
    # stats to any caller. Review all three.
    counters = stats_store.counters(bidder_id, window)
    wins = counters.get("wins", 0)
    losses = counters.get("losses", 0)
    return JSONResponse(
        {
            "bidder_id": bidder_id,
            "window": window,
            "win_rate": wins / max(1, wins + losses),
        },
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("bidding")

ALLOWED_WINDOWS = {"hour", "day"}
DEFAULT_WINDOW = "day"


class StatsStore:
    """Per-bidder counters written by the event consumer: auctions seen, bids, wins, timeouts."""

    def counters(self, bidder: str, window: str) -> dict:
        raise NotImplementedError

    def cap_cents(self, bidder: str, window: str) -> int:
        """The bidder's cap for the window, from the spend ledger."""
        raise NotImplementedError


stats_store = StatsStore()


def win_rate(counters: dict) -> float:
    """Wins against every auction the bidder saw, not just the ones it won or lost."""
    seen = counters.get("auctions_seen", 0)
    if seen == 0:
        return 0.0
    return counters.get("wins", 0) / seen


@app.get("/v1/bidders/{bidder_id}/stats")
def stats(
    bidder_id: str,
    window: str = Query(default=DEFAULT_WINDOW),
    caller: str | None = Header(default=None, alias="X-Bidder-Id"),
) -> JSONResponse:
    if caller is None or caller == "":
        raise HTTPException(status_code=401, detail="missing X-Bidder-Id")
    if caller != bidder_id:
        raise HTTPException(status_code=403, detail="a bidder may only read its own stats")
    if window not in ALLOWED_WINDOWS:
        raise HTTPException(status_code=400, detail="unknown window")

    counters = stats_store.counters(bidder_id, window)
    seen = counters.get("auctions_seen", 0)
    bids = counters.get("bids", 0)
    logger.info("stats bidder=%s window=%s seen=%d", bidder_id, window, seen)
    return JSONResponse(
        {
            "bidder_id": bidder_id,
            "window": window,
            "auctions_seen": seen,
            "bids": bids,
            "win_rate": round(win_rate(counters), 4),
            "bid_rate": round(bids / seen, 4) if seen else 0.0,
            "timeout_rate": round(counters.get("timeouts", 0) / seen, 4) if seen else 0.0,
            "degraded_share": round(counters.get("degraded", 0) / bids, 4) if bids else 0.0,
            "spend_cents": counters.get("spend_cents", 0),
            "cap_cents": stats_store.cap_cents(bidder_id, window),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/bidders/{id}/stats: a model-generated draft that flatters the bidder. */
import Fastify from 'fastify';

export const app = Fastify();

interface StatsStore {
  counters(bidder: string, window: string): Promise<Record<string, number>>;
}

const statsStore = {} as StatsStore;

app.get('/v1/bidders/:bidderId/stats', async (request, reply) => {
  // TODO: this draft omits the timeout and degradation shares, computes the win rate against wins
  // and losses only (so a bidder whose bids never land looks perfect), and serves any bidder's
  // stats to any caller. Review all three.
  const {bidderId} = request.params as {bidderId: string};
  const window = (request.query as {window?: string}).window ?? 'day';
  const counters = await statsStore.counters(bidderId, window);
  return reply.code(200).send({
    bidder_id: bidderId,
    window,
    win_rate: (counters.wins ?? 0) / Math.max(1, counters.wins + counters.losses),
  });
});
`,
      solution: `/** GET /v1/bidders/{id}/stats: honest rates, spend versus cap, and its own bidder only. */
import Fastify from 'fastify';

export const app = Fastify();

const ALLOWED_WINDOWS: Record<string, true> = {hour: true, day: true};
const DEFAULT_WINDOW = 'day';

interface StatsStore {
  counters(bidder: string, window: string): Promise<Record<string, number>>;
  capCents(bidder: string, window: string): Promise<number>;
}

const statsStore = {} as StatsStore;

/** Wins against every auction the bidder saw, not just the ones it won or lost. */
function winRate(counters: Record<string, number>): number {
  const seen = counters.auctions_seen ?? 0;
  if (seen === 0) return 0;
  return (counters.wins ?? 0) / seen;
}

app.get('/v1/bidders/:bidderId/stats', async (request, reply) => {
  const caller = request.headers['x-bidder-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Bidder-Id'});
  const {bidderId} = request.params as {bidderId: string};
  if (caller !== bidderId) return reply.code(403).send({error: 'a bidder may only read its own stats'});
  const window = (request.query as {window?: string}).window ?? DEFAULT_WINDOW;
  if (ALLOWED_WINDOWS[window] !== true) return reply.code(400).send({error: 'unknown window'});

  const counters = await statsStore.counters(bidderId, window);
  const seen = counters.auctions_seen ?? 0;
  const bids = counters.bids ?? 0;
  let bidRate = 0;
  let timeoutRate = 0;
  let degradedShare = 0;
  if (seen > 0) {
    bidRate = bids / seen;
    timeoutRate = (counters.timeouts ?? 0) / seen;
  }
  if (bids > 0) degradedShare = (counters.degraded ?? 0) / bids;
  request.log.info({bidder: bidderId, window, seen}, 'stats');
  return reply.code(200).send({
    bidder_id: bidderId,
    window,
    auctions_seen: seen,
    bids,
    win_rate: winRate(counters),
    bid_rate: bidRate,
    timeout_rate: timeoutRate,
    degraded_share: degradedShare,
    spend_cents: counters.spend_cents ?? 0,
    cap_cents: await statsStore.capCents(bidderId, window),
  });
});
`,
    },
    go: {
      starter: `package read

import (
	"encoding/json"
	"log"
	"net/http"
)

type StatsStore struct{}

func (s *StatsStore) Counters(bidder, window string) map[string]int {
	return map[string]int{}
}

var statsStore = &StatsStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func stats(rw http.ResponseWriter, r *http.Request) {
	bidderID := r.PathValue("bidder_id")
	window := r.URL.Query().Get("window")
	if window == "" {
		window = "day"
	}
	// TODO: this draft omits the timeout and degradation shares, computes the win rate against
	// wins and losses only (so a bidder whose bids never land looks perfect), and serves any
	// bidder's stats to any caller. Review all three.
	counters := statsStore.Counters(bidderID, window)
	writeJSON(rw, http.StatusOK, map[string]any{
		"bidder_id": bidderID,
		"window":    window,
		"win_rate":  float64(counters["wins"]) / float64(counters["wins"]+counters["losses"]+1),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/bidders/{bidder_id}/stats", stats)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package read

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
)

var allowedWindows = map[string]bool{"hour": true, "day": true}

type StatsStore struct{}

func (s *StatsStore) Counters(bidder, window string) map[string]int {
	return map[string]int{}
}

// CapCents is the bidder's cap for the window, from the spend ledger.
func (s *StatsStore) CapCents(bidder, window string) int {
	return 0
}

var statsStore = &StatsStore{}

// winRate counts wins against every auction the bidder saw, not just the ones it won or lost.
func winRate(counters map[string]int) float64 {
	seen := counters["auctions_seen"]
	if seen == 0 {
		return 0
	}
	return float64(counters["wins"]) / float64(seen)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func stats(rw http.ResponseWriter, r *http.Request) {
	caller := r.Header.Get("X-Bidder-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Bidder-Id"})
		return
	}
	bidderID := r.PathValue("bidder_id")
	if caller != bidderID {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "a bidder may only read its own stats"})
		return
	}
	window := r.URL.Query().Get("window")
	if window == "" {
		window = "day"
	}
	if !allowedWindows[window] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown window"})
		return
	}

	counters := statsStore.Counters(bidderID, window)
	seen := counters["auctions_seen"]
	bids := counters["bids"]
	var bidRate, timeoutRate, degradedShare float64
	if seen > 0 {
		bidRate = float64(bids) / float64(seen)
		timeoutRate = float64(counters["timeouts"]) / float64(seen)
	}
	if bids > 0 {
		degradedShare = float64(counters["degraded"]) / float64(bids)
	}
	log.Printf("stats bidder=%s window=%s seen=%d", bidderID, window, seen)
	writeJSON(rw, http.StatusOK, map[string]any{
		"bidder_id":      bidderID,
		"window":         window,
		"auctions_seen":  seen,
		"bids":           bids,
		"win_rate":       math.Round(winRate(counters)*10000) / 10000,
		"bid_rate":       bidRate,
		"timeout_rate":   timeoutRate,
		"degraded_share": degradedShare,
		"spend_cents":    counters["spend_cents"],
		"cap_cents":      statsStore.CapCents(bidderID, window),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/bidders/{bidder_id}/stats", stats)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

trait StatsStore {
  def counters(bidder: String, window: String): Map[String, Int]
}

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("bidding")

  val statsStore: StatsStore = (bidder: String, window: String) => Map.empty[String, Int]

  val route: Route =
    path("v1" / "bidders" / Segment / "stats") { bidderId =>
      get {
        parameters("window".?) { windowOpt =>
          val window = windowOpt.getOrElse("day")
          // TODO: this draft omits the timeout and degradation shares, computes the win rate
          // against wins and losses only (so a bidder whose bids never land looks perfect), and
          // serves any bidder's stats to any caller. Review all three.
          val counters = statsStore.counters(bidderId, window)
          val wins = counters.getOrElse("wins", 0)
          val losses = counters.getOrElse("losses", 0)
          complete(
            StatusCodes.OK,
            s"""{"bidder_id":"$bidderId","window":"$window","win_rate":\${wins.toDouble / math.max(1, wins + losses)}}"""
          )
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

trait StatsStore {
  def counters(bidder: String, window: String): Map[String, Int]

  /** The bidder's cap for the window, from the spend ledger. */
  def capCents(bidder: String, window: String): Int
}

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("bidding")

  val AllowedWindows = Set("hour", "day")
  val DefaultWindow = "day"

  val statsStore: StatsStore = new StatsStore {
    def counters(bidder: String, window: String): Map[String, Int] = Map.empty[String, Int]
    def capCents(bidder: String, window: String): Int = 0
  }

  /** Wins against every auction the bidder saw, not just the ones it won or lost. */
  def winRate(counters: Map[String, Int]): Double = {
    val seen = counters.getOrElse("auctions_seen", 0)
    if (seen == 0) 0.0 else counters.getOrElse("wins", 0).toDouble / seen
  }

  val route: Route =
    path("v1" / "bidders" / Segment / "stats") { bidderId =>
      get {
        optionalHeaderValueByName("X-Bidder-Id") { callerOpt =>
          parameters("window".?) { windowOpt =>
            val window = windowOpt.getOrElse(DefaultWindow)
            if (!callerOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Bidder-Id"}""")
            } else if (callerOpt.get != bidderId) {
              complete(StatusCodes.Forbidden, """{"error":"a bidder may only read its own stats"}""")
            } else if (!AllowedWindows.contains(window)) {
              complete(StatusCodes.BadRequest, """{"error":"unknown window"}""")
            } else {
              val counters = statsStore.counters(bidderId, window)
              val seen = counters.getOrElse("auctions_seen", 0)
              val bids = counters.getOrElse("bids", 0)
              val bidRate = if (seen > 0) bids.toDouble / seen else 0.0
              val timeoutRate = if (seen > 0) counters.getOrElse("timeouts", 0).toDouble / seen else 0.0
              val degradedShare = if (bids > 0) counters.getOrElse("degraded", 0).toDouble / bids else 0.0
              system.log.info(s"stats bidder=$bidderId window=$window seen=$seen")
              complete(
                StatusCodes.OK,
                s"""{"bidder_id":"$bidderId","window":"$window","auctions_seen":$seen,"bids":$bids,""" +
                  s""""win_rate":\${winRate(counters)},"bid_rate":$bidRate,"timeout_rate":$timeoutRate,""" +
                  s""""degraded_share":$degradedShare,"spend_cents":\${counters.getOrElse("spend_cents", 0)},""" +
                  s""""cap_cents":\${statsStore.capCents(bidderId, window)}}"""
              )
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
#include <map>
#include <string>

using json = nlohmann::json;

struct StatsStore {
  std::map<std::string, int> counters(const std::string& bidder, const std::string& window);
};

StatsStore statsStore;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/bidders/([A-Za-z0-9_-]+)/stats)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft omits the timeout and degradation shares, computes the win rate against
    // wins and losses only (so a bidder whose bids never land looks perfect), and serves any
    // bidder's stats to any caller. Review all three.
    const std::string bidderId = req.matches[1];
    const std::string window = req.has_param("window") ? req.get_param_value("window") : "day";
    const auto counters = statsStore.counters(bidderId, window);
    const int wins = counters.count("wins") ? counters.at("wins") : 0;
    const int losses = counters.count("losses") ? counters.at("losses") : 0;
    res.status = 200;
    res.set_content(json{{"bidder_id", bidderId}, {"window", window},
                         {"win_rate", static_cast<double>(wins) / std::max(1, wins + losses)}}
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
#include <map>
#include <set>
#include <string>

using json = nlohmann::json;

struct StatsStore {
  std::map<std::string, int> counters(const std::string& bidder, const std::string& window);
  // The bidder's cap for the window, from the spend ledger.
  int capCents(const std::string& bidder, const std::string& window);
};

StatsStore statsStore;

const std::set<std::string> kAllowedWindows = {"hour", "day"};

/** Wins against every auction the bidder saw, not just the ones it won or lost. */
double winRate(const std::map<std::string, int>& counters) {
  const int seen = counters.count("auctions_seen") ? counters.at("auctions_seen") : 0;
  if (seen == 0) return 0.0;
  return static_cast<double>(counters.count("wins") ? counters.at("wins") : 0) / seen;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/bidders/([A-Za-z0-9_-]+)/stats)", [](const httplib::Request& req, httplib::Response& res) {
    const auto caller = req.get_header_value("X-Bidder-Id");
    if (caller.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Bidder-Id"})", "application/json");
      return;
    }
    const std::string bidderId = req.matches[1];
    if (caller != bidderId) {
      res.status = 403;
      res.set_content(R"({"error":"a bidder may only read its own stats"})", "application/json");
      return;
    }
    const std::string window = req.has_param("window") ? req.get_param_value("window") : "day";
    if (kAllowedWindows.count(window) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown window"})", "application/json");
      return;
    }

    const auto counters = statsStore.counters(bidderId, window);
    const int seen = counters.count("auctions_seen") ? counters.at("auctions_seen") : 0;
    const int bids = counters.count("bids") ? counters.at("bids") : 0;
    const double bidRate = seen > 0 ? static_cast<double>(bids) / seen : 0.0;
    const double timeoutRate =
        seen > 0 ? static_cast<double>(counters.count("timeouts") ? counters.at("timeouts") : 0) / seen : 0.0;
    const double degradedShare =
        bids > 0 ? static_cast<double>(counters.count("degraded") ? counters.at("degraded") : 0) / bids : 0.0;
    std::cerr << "stats bidder=" << bidderId << " window=" << window << " seen=" << seen << "\\n";
    res.status = 200;
    res.set_content(
        json{{"bidder_id", bidderId},
             {"window", window},
             {"auctions_seen", seen},
             {"bids", bids},
             {"win_rate", winRate(counters)},
             {"bid_rate", bidRate},
             {"timeout_rate", timeoutRate},
             {"degraded_share", degradedShare},
             {"spend_cents", counters.count("spend_cents") ? counters.at("spend_cents") : 0},
             {"cap_cents", statsStore.capCents(bidderId, window)}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Authorize before you read: the `X-Bidder-Id` header must equal the id in the path (403 when it does not, 401 when the header is missing). A stats endpoint keyed only by a path parameter is an information leak, not a read.',
    'Fix the denominator first: `win_rate = wins / auctions_seen`, where `auctions_seen` counts every auction the bidder received a request for — the ones it lost on price, the ones it lost to a timeout and the ones it never answered. Dividing by wins plus losses makes a slow bidder look perfect.',
    'Report latency and degradation next to the money: `timeout_rate` over auctions seen, `degraded_share` over bids placed, and `spend_cents` beside `cap_cents` for the same `window`. Those four numbers are what tell an operator whether the bidder is slow, timid or simply out of budget.',
  ],
  debrief: `The interviewer is testing whether you can review a read path for honesty. Reads are boring to
write and easy to get subtly wrong, and the wrong read makes every later decision wrong: the polling
loop, the on-call runbook, the cap increase.

Three defects are being checked. The denominator: a win rate over resolved auctions hides the auctions
the bidder timed out on, which is precisely the failure mode the rest of this course fixes, so the
read must count \`auctions_seen\`. The missing rates: \`timeout_rate\` and \`degraded_share\` are the two
signals that separate "not competitive on price" from "never answered in time" and "only bidding
conservatively". Authorization: the path parameter identifies which stats to read, and the header
decides whether the caller may; a foreign bidder is 403. Spend versus cap closes the loop, because a
bidder at 95% of its daily cap is the next incident.

Real platforms also expose per-window percentiles of the stage timings, a loss-reason breakdown, and a
reconciliation delta between spend and wins, so an operator can tell a configuration mistake from a
market that simply was not there.`,
};
