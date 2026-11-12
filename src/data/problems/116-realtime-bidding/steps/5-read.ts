import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/bidders/{id}/stats: timeouts and spend on the same page as wins',
  concept: 'http',
  file: 'read',
  focus: ['dashboard', 'api', 'redis', 'consumer'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/bidders/{id}/stats\` and reads today's counters
(UTC) from the hash \`stats:{bidder}:{yyyymmdd}\` (\`auctions\`, \`bids\`, \`wins\`, \`losses\`,
\`timeouts\`, \`degraded\`, written by the stats consumer). It answers \`{bidder, day, auctions, bids,
wins, win_rate, bid_rate, spend_cents}\` with \`spend_cents\` from \`spend:{bidder}\`. It serves the demo
and hides 4 flaws.

**Failure mode the checks target.** A bidder that timed out on half its auctions reads a 25% win rate
where it won one in eight, sees no timeouts at all, reads another bidder's numbers by editing the URL,
and sees 0 spent on a day it spent most of its cap.

- The caller is \`X-Bidder-Id\`: missing is **401**, a different bidder than the path is **403**.
- \`win_rate\` is wins over **auctions**, and every rate is 0 when its denominator is 0.
- Add \`timeout_rate\` (timeouts over auctions) and \`degraded_share\` (degraded over bids).
- \`spend_cents\` is today's counter from step 2 (\`spend.spent(bidder, day)\`) and \`cap_cents\` is
  \`spend.cap_of(bidder)\`.`,
  sequence: {
    participants: ['Bidder dashboard', 'biddingd', 'Redis'],
    messages: [
      {from: 'Bidder dashboard', to: 'biddingd', label: 'GET /v1/bidders/b-1/stats · X-Bidder-Id: b-1', kind: 'sync'},
      {from: 'biddingd', to: 'biddingd', label: 'caller ≠ path → 403', kind: 'sync'},
      {from: 'biddingd', to: 'Redis', label: 'HGETALL stats:b-1:20261103', kind: 'sync'},
      {from: 'Redis', to: 'biddingd', label: 'auctions · bids · wins · timeouts · degraded', kind: 'reply'},
      {from: 'biddingd', to: 'Redis', label: 'GET spend:b-1:20261103 · GET cap:b-1', kind: 'sync'},
      {
        from: 'biddingd',
        to: 'Bidder dashboard',
        label: '200 {win_rate, timeout_rate, degraded_share, spend_cents, cap_cents}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/bidders/{id}/stats',
      detail: "A bidder reading its own stats gets 200 with today's auction, bid and win counts.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/bidders\/\{\w+\}\/stats["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/bidders\/:\w+\/stats['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/bidders\/\{\w+\}\/stats"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"bidders"\s*\/\s*Segment\s*\/\s*"stats"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^\n]*\/v1\/bidders\//]},
      },
    },
    {
      id: 'win-rate-denominator',
      title: 'Win rate is wins over every auction seen',
      detail:
        'One win in eight auctions, three of them lost and four timed out, is a win rate of 0.125, and a bidder with nothing seen reads 0. The starter divides by wins plus losses, so every timeout makes the bidder look better.',
      match: {
        python: {all: [/share\(\s*wins\s*,\s*auctions\s*\)|wins\s*\/\s*auctions/], none: [/wins\s*\+\s*losses/]},
        typescript: {all: [/share\(\s*wins\s*,\s*auctions\s*\)|wins\s*\/\s*auctions/], none: [/wins\s*\+\s*losses/]},
        go: {all: [/share\(\s*wins\s*,\s*auctions\s*\)|\/\s*float64\(\s*auctions\s*\)/], none: [/wins\s*\+\s*losses/]},
        scala: {
          all: [/share\(\s*wins\s*,\s*auctions\s*\)|wins\.toDouble\s*\/\s*auctions/],
          none: [/wins\s*\+\s*losses/],
        },
        cpp: {all: [/share\(\s*wins\s*,\s*auctions\s*\)|\/\s*auctions/], none: [/wins\s*\+\s*losses/]},
      },
    },
    {
      id: 'timeout-share',
      title: 'Timeout rate and degraded share are reported',
      detail:
        'The response carries `timeout_rate` (timeouts over auctions) and `degraded_share` (degraded over bids), 0 with nothing to divide. The starter omits both, so a bidder whose answers never arrive looks healthy.',
      match: {
        python: {all: [/["']timeout_rate["']/, /["']degraded_share["']/]},
        typescript: {all: [/timeout_rate/, /degraded_share/]},
        go: {all: [/"timeout_rate"/, /"degraded_share"/]},
        scala: {all: [/"timeout_rate"/, /"degraded_share"/]},
        cpp: {all: [/"timeout_rate"/, /"degraded_share"/]},
      },
    },
    {
      id: 'foreign-403',
      title: 'A bidder reads only its own stats',
      detail:
        'No `X-Bidder-Id` is **401**; a caller other than the bidder in the path is **403** and sees none of its numbers. The starter serves whatever id the URL names.',
      match: {
        python: {all: [/\b401\b/, /\b403\b/]},
        typescript: {all: [/\b401\b/, /\b403\b/]},
        go: {all: [/StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/]},
        scala: {all: [/Unauthorized|\b401\b/, /Forbidden|\b403\b/]},
        cpp: {all: [/\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'spend-window',
      title: "Spend is today's counter, next to the cap",
      detail:
        "`spend_cents` comes from the day's counter step 2 writes (`spend:{bidder}:{yyyymmdd}`) and `cap_cents` from `cap:{bidder}`. The starter reads a key nothing writes, so the bidder reads 0 spent.",
      match: {
        python: {all: [/spend\.spent\(/, /spend\.cap_of\(/]},
        typescript: {all: [/\bspent\(/, /\bcapOf\(/]},
        go: {all: [/spend\.Spent\(/, /spend\.CapOf\(/]},
        scala: {all: [/Spend\.spent\(/, /Spend\.capOf\(/]},
        cpp: {all: [/rtb::spend::spent\(/, /rtb::spend::capOf\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request

from rtb import spend  # spend.today() -> yyyymmdd, spend.spent(bidder, day), spend.cap_of(bidder)

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def share(part: int, whole: int) -> float:
    return part / whole if whole else 0.0


@app.get("/v1/bidders/{bidder_id}/stats")
def stats(bidder_id: str, request: Request) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    day = spend.today()
    counters = {name: int(value) for name, value in r.hgetall(f"stats:{bidder_id}:{day}").items()}
    auctions, bids = counters.get("auctions", 0), counters.get("bids", 0)
    wins, losses = counters.get("wins", 0), counters.get("losses", 0)
    return {
        "bidder": bidder_id,
        "day": day,
        "auctions": auctions,
        "bids": bids,
        "wins": wins,
        "win_rate": wins / (wins + losses),
        "bid_rate": share(bids, auctions),
        "spend_cents": int(r.get(f"spend:{bidder_id}") or 0),
    }
`,
      solution: `import redis
from fastapi import FastAPI, HTTPException, Request

from rtb import spend  # spend.today() -> yyyymmdd, spend.spent(bidder, day), spend.cap_of(bidder)

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def share(part: int, whole: int) -> float:
    return part / whole if whole else 0.0


@app.get("/v1/bidders/{bidder_id}/stats")
def stats(bidder_id: str, request: Request) -> dict:
    caller = request.headers.get("x-bidder-id", "")
    if not caller:
        raise HTTPException(status_code=401, detail="X-Bidder-Id is required")
    if caller != bidder_id:
        raise HTTPException(status_code=403, detail="a bidder reads only its own stats")
    day = spend.today()
    counters = {name: int(value) for name, value in r.hgetall(f"stats:{bidder_id}:{day}").items()}
    auctions, bids = counters.get("auctions", 0), counters.get("bids", 0)
    wins, timeouts, degraded = counters.get("wins", 0), counters.get("timeouts", 0), counters.get("degraded", 0)
    return {
        "bidder": bidder_id,
        "day": day,
        "auctions": auctions,
        "bids": bids,
        "wins": wins,
        "win_rate": share(wins, auctions),  # every auction seen, timeouts and no-bids included
        "bid_rate": share(bids, auctions),
        "timeout_rate": share(timeouts, auctions),
        "degraded_share": share(degraded, bids),
        "spend_cents": spend.spent(bidder_id, day),
        "cap_cents": spend.cap_of(bidder_id),
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {today} from 'rtb/spend'; // today() -> yyyymmdd, spent(bidder, day), capOf(bidder)

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

app.get('/v1/bidders/:id/stats', async request => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {id} = request.params as {id: string};
  const day = today();
  const raw = await redis.hgetall(\`stats:\${id}:\${day}\`);
  const count = (name: string): number => Number(raw[name] ?? 0);
  const [auctions, bids, wins, losses] = [count('auctions'), count('bids'), count('wins'), count('losses')];
  return {
    bidder: id,
    day,
    auctions,
    bids,
    wins,
    win_rate: wins / (wins + losses),
    bid_rate: share(bids, auctions),
    spend_cents: Number((await redis.get(\`spend:\${id}\`)) ?? 0),
  };
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {capOf, spent, today} from 'rtb/spend'; // today() -> yyyymmdd, spent(bidder, day), capOf(bidder)

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

app.get('/v1/bidders/:id/stats', async (request, reply) => {
  const {id} = request.params as {id: string};
  const caller = String(request.headers['x-bidder-id'] ?? '');
  if (caller === '') return reply.code(401).send({error: 'X-Bidder-Id is required'});
  if (caller !== id) return reply.code(403).send({error: 'a bidder reads only its own stats'});
  const day = today();
  const raw = await redis.hgetall(\`stats:\${id}:\${day}\`);
  const count = (name: string): number => Number(raw[name] ?? 0);
  const [auctions, bids, wins, timeouts, degraded] = [count('auctions'), count('bids'), count('wins'), count('timeouts'), count('degraded')];
  return {
    bidder: id,
    day,
    auctions,
    bids,
    wins,
    win_rate: share(wins, auctions), // every auction seen, timeouts and no-bids included
    bid_rate: share(bids, auctions),
    timeout_rate: share(timeouts, auctions),
    degraded_share: share(degraded, bids),
    spend_cents: await spent(id, day),
    cap_cents: await capOf(id),
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"rtb/spend" // spend.Today() yyyymmdd, spend.Spent(ctx, bidder, day), spend.CapOf(ctx, bidder)
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func share(part, whole int64) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole)
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func stats(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	bidderID := r.PathValue("id")
	day := spend.Today()
	counters := map[string]int64{}
	for name, value := range rdb.HGetAll(r.Context(), "stats:"+bidderID+":"+day).Val() {
		counters[name], _ = strconv.ParseInt(value, 10, 64)
	}
	auctions, bids, wins, losses := counters["auctions"], counters["bids"], counters["wins"], counters["losses"]
	spent, _ := rdb.Get(r.Context(), "spend:"+bidderID).Int64()
	writeJSON(rw, http.StatusOK, map[string]any{
		"bidder":      bidderID,
		"day":         day,
		"auctions":    auctions,
		"bids":        bids,
		"wins":        wins,
		"win_rate":    float64(wins) / float64(wins+losses),
		"bid_rate":    share(bids, auctions),
		"spend_cents": spent,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/bidders/{id}/stats", stats)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"rtb/spend" // spend.Today() yyyymmdd, spend.Spent(ctx, bidder, day), spend.CapOf(ctx, bidder)
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func share(part, whole int64) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole)
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func stats(rw http.ResponseWriter, r *http.Request) {
	bidderID := r.PathValue("id")
	caller := r.Header.Get("X-Bidder-Id")
	if caller == "" {
		http.Error(rw, "X-Bidder-Id is required", http.StatusUnauthorized)
		return
	}
	if caller != bidderID {
		http.Error(rw, "a bidder reads only its own stats", http.StatusForbidden)
		return
	}
	day := spend.Today()
	counters := map[string]int64{}
	for name, value := range rdb.HGetAll(r.Context(), "stats:"+bidderID+":"+day).Val() {
		counters[name], _ = strconv.ParseInt(value, 10, 64)
	}
	auctions, bids, wins := counters["auctions"], counters["bids"], counters["wins"]
	writeJSON(rw, http.StatusOK, map[string]any{
		"bidder":         bidderID,
		"day":            day,
		"auctions":       auctions,
		"bids":           bids,
		"wins":           wins,
		"win_rate":       share(wins, auctions), // every auction seen, timeouts and no-bids included
		"bid_rate":       share(bids, auctions),
		"timeout_rate":   share(counters["timeouts"], auctions),
		"degraded_share": share(counters["degraded"], bids),
		"spend_cents":    spend.Spent(r.Context(), bidderID, day),
		"cap_cents":      spend.CapOf(r.Context(), bidderID),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/bidders/{id}/stats", stats)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import rtb.Spend // Spend.today(): yyyymmdd; Spend.spent(bidder, day); Spend.capOf(bidder)

import scala.jdk.CollectionConverters._

object Read {
  private val jedis = new JedisPooled("redis", 6379)

  private def share(part: Long, whole: Long): Double = if (whole == 0) 0.0 else part.toDouble / whole

  val route: Route = path("v1" / "bidders" / Segment / "stats") { bidderId =>
    get {
      // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
      val day = Spend.today()
      val counters = jedis.hgetAll(s"stats:$bidderId:$day").asScala.view.mapValues(_.toLong).toMap.withDefaultValue(0L)
      val (auctions, bids, wins, losses) = (counters("auctions"), counters("bids"), counters("wins"), counters("losses"))
      val spent = Option(jedis.get(s"spend:$bidderId")).map(_.toLong).getOrElse(0L)
      val body = JsObject(
        "bidder" -> JsString(bidderId),
        "day" -> JsString(day),
        "auctions" -> JsNumber(auctions),
        "bids" -> JsNumber(bids),
        "wins" -> JsNumber(wins),
        "win_rate" -> JsNumber(wins.toDouble / (wins + losses)),
        "bid_rate" -> JsNumber(share(bids, auctions)),
        "spend_cents" -> JsNumber(spent)
      )
      complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import rtb.Spend // Spend.today(): yyyymmdd; Spend.spent(bidder, day); Spend.capOf(bidder)

import scala.jdk.CollectionConverters._

object Read {
  private val jedis = new JedisPooled("redis", 6379)

  private def share(part: Long, whole: Long): Double = if (whole == 0) 0.0 else part.toDouble / whole

  val route: Route = path("v1" / "bidders" / Segment / "stats") { bidderId =>
    get {
      optionalHeaderValueByName("X-Bidder-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Bidder-Id is required")
        case Some(caller) if caller != bidderId => complete(StatusCodes.Forbidden -> "a bidder reads only its own stats")
        case Some(_) =>
          val day = Spend.today()
          val counters = jedis.hgetAll(s"stats:$bidderId:$day").asScala.view.mapValues(_.toLong).toMap.withDefaultValue(0L)
          val (auctions, bids, wins) = (counters("auctions"), counters("bids"), counters("wins"))
          val body = JsObject(
            "bidder" -> JsString(bidderId),
            "day" -> JsString(day),
            "auctions" -> JsNumber(auctions),
            "bids" -> JsNumber(bids),
            "wins" -> JsNumber(wins),
            "win_rate" -> JsNumber(share(wins, auctions)), // every auction seen, timeouts and no-bids included
            "bid_rate" -> JsNumber(share(bids, auctions)),
            "timeout_rate" -> JsNumber(share(counters("timeouts"), auctions)),
            "degraded_share" -> JsNumber(share(counters("degraded"), bids)),
            "spend_cents" -> JsNumber(Spend.spent(bidderId, day)),
            "cap_cents" -> JsNumber(Spend.capOf(bidderId))
          )
          complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>

#include "rtb/spend.h"  // rtb::spend::today() yyyymmdd, rtb::spend::spent(bidder, day), rtb::spend::capOf(bidder)

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

double share(long part, long whole) { return whole == 0 ? 0.0 : static_cast<double>(part) / whole; }

void stats(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string bidder_id = req.matches[1];
  const std::string day = rtb::spend::today();
  std::unordered_map<std::string, std::string> raw;
  redis.hgetall("stats:" + bidder_id + ":" + day, std::inserter(raw, raw.begin()));
  const auto count = [&raw](const char* name) { return raw.count(name) ? std::stol(raw.at(name)) : 0L; };
  const long auctions = count("auctions"), bids = count("bids"), wins = count("wins"), losses = count("losses");
  const auto spent = redis.get("spend:" + bidder_id);
  const json body = {{"bidder", bidder_id},
                     {"day", day},
                     {"auctions", auctions},
                     {"bids", bids},
                     {"wins", wins},
                     {"win_rate", static_cast<double>(wins) / (wins + losses)},
                     {"bid_rate", share(bids, auctions)},
                     {"spend_cents", spent ? std::stol(*spent) : 0L}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/bidders/([\\w-]+)/stats)", stats); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>

#include "rtb/spend.h"  // rtb::spend::today() yyyymmdd, rtb::spend::spent(bidder, day), rtb::spend::capOf(bidder)

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

double share(long part, long whole) { return whole == 0 ? 0.0 : static_cast<double>(part) / whole; }

void stats(const httplib::Request& req, httplib::Response& res) {
  const std::string bidder_id = req.matches[1];
  const std::string caller = req.get_header_value("X-Bidder-Id");
  if (caller.empty()) {
    res.status = 401;
    return res.set_content("X-Bidder-Id is required", "text/plain");
  }
  if (caller != bidder_id) {
    res.status = 403;
    return res.set_content("a bidder reads only its own stats", "text/plain");
  }
  const std::string day = rtb::spend::today();
  std::unordered_map<std::string, std::string> raw;
  redis.hgetall("stats:" + bidder_id + ":" + day, std::inserter(raw, raw.begin()));
  const auto count = [&raw](const char* name) { return raw.count(name) ? std::stol(raw.at(name)) : 0L; };
  const long auctions = count("auctions"), bids = count("bids"), wins = count("wins");
  const json body = {{"bidder", bidder_id},
                     {"day", day},
                     {"auctions", auctions},
                     {"bids", bids},
                     {"wins", wins},
                     {"win_rate", share(wins, auctions)},  // every auction seen, timeouts and no-bids included
                     {"bid_rate", share(bids, auctions)},
                     {"timeout_rate", share(count("timeouts"), auctions)},
                     {"degraded_share", share(count("degraded"), bids)},
                     {"spend_cents", rtb::spend::spent(bidder_id, day)},
                     {"cap_cents", rtb::spend::capOf(bidder_id)}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/bidders/([\\w-]+)/stats)", stats); }
`,
    },
  },
  harness: {
    python: `from rtb import spend

COUNTERS = {"auctions": 8, "bids": 4, "wins": 1, "losses": 3, "timeouts": 4, "degraded": 2}


def _read(ctx):
    day = spend.today()
    ctx.redis.hset(f"stats:b-1:{day}", mapping=COUNTERS)
    ctx.redis.set(f"spend:b-1:{day}", 310)
    ctx.redis.set("cap:b-1", 1000)
    return ctx.client(ctx.load("read").app)


async def _stats(c, bidder="b-1", caller="b-1"):
    headers = {"X-Bidder-Id": caller} if caller else {}
    return await c.get(f"/v1/bidders/{bidder}/stats", headers=headers)


def _body(r, why):
    assert r.status_code == 200, f"{why}: GET /v1/bidders/…/stats answered {r.status_code}: {r.text}"
    return r.json()


def _near(got, want):
    return isinstance(got, (int, float)) and abs(got - want) < 1e-6


async def check_route(ctx):
    async with _read(ctx) as c:
        body = _body(await _stats(c), "b-1 reading its own stats")
    assert body.get("bidder") == "b-1" and body.get("day") == spend.today(), f"the answer is {body}, expected bidder b-1 and today's day {spend.today()}"
    assert (body.get("auctions"), body.get("bids"), body.get("wins")) == (8, 4, 1), f"the answer is {body}, expected today's 8 auctions, 4 bids and 1 win"


async def check_win_rate_denominator(ctx):
    async with _read(ctx) as c:
        body = _body(await _stats(c), "b-1 reading its own stats")
        assert _near(body.get("win_rate"), 0.125), f"1 win in 8 auctions (3 lost, 4 timed out) reads win_rate {body.get('win_rate')}, expected 0.125: the denominator is every auction seen"
        empty = _body(await _stats(c, "b-2", "b-2"), "a bidder with nothing seen today")
    assert _near(empty.get("win_rate"), 0), f"a bidder with no auctions today reads win_rate {empty.get('win_rate')!r}, expected 0"


async def check_timeout_share(ctx):
    async with _read(ctx) as c:
        body = _body(await _stats(c), "b-1 reading its own stats")
        assert _near(body.get("timeout_rate"), 0.5), f"4 timeouts in 8 auctions read timeout_rate {body.get('timeout_rate')!r}, expected 0.5"
        assert _near(body.get("degraded_share"), 0.5), f"2 degraded bids of 4 read degraded_share {body.get('degraded_share')!r}, expected 0.5"
        empty = _body(await _stats(c, "b-2", "b-2"), "a bidder with nothing seen today")
    assert _near(empty.get("timeout_rate"), 0) and _near(empty.get("degraded_share"), 0), f"a bidder with nothing seen today reads {empty}, expected timeout_rate and degraded_share 0"


async def check_foreign_403(ctx):
    async with _read(ctx) as c:
        r = await _stats(c, "b-1", None)
        assert r.status_code == 401, f"a stats read without X-Bidder-Id answered {r.status_code}, expected 401"
        r = await _stats(c, "b-1", "b-2")
    assert r.status_code == 403, f"bidder b-2 reading b-1's stats answered {r.status_code}: {r.text}, expected 403"
    assert "auctions" not in r.text, f"the 403 for b-2 carries b-1's numbers: {r.text}"


async def check_spend_window(ctx):
    ctx.redis.set("spend:b-1:20200101", 900)  # an old day's counter: not today's spend
    async with _read(ctx) as c:
        body = _body(await _stats(c), "b-1 reading its own stats")
    assert body.get("spend_cents") == 310, f"with 310 claimed today (spend:b-1:{spend.today()}) the answer reads spend_cents {body.get('spend_cents')!r}"
    assert body.get("cap_cents") == 1000, f"with cap:b-1 at 1000 the answer reads cap_cents {body.get('cap_cents')!r}"
`,
    typescript: `const COUNTERS = {auctions: 8, bids: 4, wins: 1, losses: 3, timeouts: 4, degraded: 2};

function read(ctx) {
  const spend = ctx.load('/support/rtb/spend.ts');
  const day = spend.today();
  ctx.redis.hset(\`stats:b-1:\${day}\`, COUNTERS);
  ctx.redis.set(\`spend:b-1:\${day}\`, 310);
  ctx.redis.set('cap:b-1', 1000);
  return {c: ctx.client(ctx.load('read').app), day};
}

const stats = (c, bidder = 'b-1', caller: string | null = 'b-1') =>
  c.get(\`/v1/bidders/\${bidder}/stats\`, {headers: caller === null ? {} : {'X-Bidder-Id': caller}});

function body(r, why: string) {
  assert.equal(r.status, 200, \`\${why}: GET /v1/bidders/…/stats answered \${r.status}: \${r.text}\`);
  return r.json();
}

const near = (got: unknown, want: number): boolean => typeof got === 'number' && Math.abs(got - want) < 1e-6;

export async function check_route(ctx) {
  const {c, day} = read(ctx);
  const b = body(await stats(c), 'b-1 reading its own stats');
  assert(b.bidder === 'b-1' && b.day === day, \`the answer is \${JSON.stringify(b)}, expected bidder b-1 and today's day \${day}\`);
  assert(b.auctions === 8 && b.bids === 4 && b.wins === 1, \`the answer is \${JSON.stringify(b)}, expected today's 8 auctions, 4 bids and 1 win\`);
}

export async function check_win_rate_denominator(ctx) {
  const {c} = read(ctx);
  const b = body(await stats(c), 'b-1 reading its own stats');
  assert(near(b.win_rate, 0.125), \`1 win in 8 auctions (3 lost, 4 timed out) reads win_rate \${b.win_rate}, expected 0.125: the denominator is every auction seen\`);
  const empty = body(await stats(c, 'b-2', 'b-2'), 'a bidder with nothing seen today');
  assert(near(empty.win_rate, 0), \`a bidder with no auctions today reads win_rate \${JSON.stringify(empty.win_rate)}, expected 0\`);
}

export async function check_timeout_share(ctx) {
  const {c} = read(ctx);
  const b = body(await stats(c), 'b-1 reading its own stats');
  assert(near(b.timeout_rate, 0.5), \`4 timeouts in 8 auctions read timeout_rate \${JSON.stringify(b.timeout_rate)}, expected 0.5\`);
  assert(near(b.degraded_share, 0.5), \`2 degraded bids of 4 read degraded_share \${JSON.stringify(b.degraded_share)}, expected 0.5\`);
  const empty = body(await stats(c, 'b-2', 'b-2'), 'a bidder with nothing seen today');
  assert(near(empty.timeout_rate, 0) && near(empty.degraded_share, 0), \`a bidder with nothing seen today reads \${JSON.stringify(empty)}, expected timeout_rate and degraded_share 0\`);
}

export async function check_foreign_403(ctx) {
  const {c} = read(ctx);
  let r = await stats(c, 'b-1', null);
  assert.equal(r.status, 401, \`a stats read without X-Bidder-Id answered \${r.status}, expected 401\`);
  r = await stats(c, 'b-1', 'b-2');
  assert.equal(r.status, 403, \`bidder b-2 reading b-1's stats answered \${r.status}: \${r.text}, expected 403\`);
  assert(!r.text.includes('auctions'), \`the 403 for b-2 carries b-1's numbers: \${r.text}\`);
}

export async function check_spend_window(ctx) {
  ctx.redis.set('spend:b-1:20200101', 900); // an old day's counter: not today's spend
  const {c, day} = read(ctx);
  const b = body(await stats(c), 'b-1 reading its own stats');
  assert.equal(b.spend_cents, 310, \`with 310 claimed today (spend:b-1:\${day}) the answer reads spend_cents \${JSON.stringify(b.spend_cents)}\`);
  assert.equal(b.cap_cents, 1000, \`with cap:b-1 at 1000 the answer reads cap_cents \${JSON.stringify(b.cap_cents)}\`);
}
`,
    go: `package main

import (
	"math"
	"net/http"
	"strings"

	"rtb/spend"

	"leetbuild/harness"
)

func readSetup(ctx *harness.Ctx) *harness.HTTP {
	day := spend.Today()
	ctx.Redis.Do("HSET", "stats:b-1:"+day, "auctions", 8, "bids", 4, "wins", 1, "losses", 3, "timeouts", 4, "degraded", 2)
	ctx.Redis.Set("spend:b-1:"+day, 310)
	ctx.Redis.Set("cap:b-1", 1000)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readStats(c *harness.HTTP, bidder, caller string) *harness.Response {
	if caller == "" {
		return c.Get("/v1/bidders/" + bidder + "/stats")
	}
	return c.Get("/v1/bidders/"+bidder+"/stats", "X-Bidder-Id", caller)
}

func readBody(ctx *harness.Ctx, r *harness.Response, why string) map[string]any {
	ctx.Equal(r.Status, 200, "%s: GET /v1/bidders/…/stats (%s)", why, strings.TrimSpace(r.Text()))
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "%s: the answer is not a JSON object: %s", why, r.Text())
	return body
}

func readNear(got any, want float64) bool {
	f, ok := got.(float64)
	return ok && math.Abs(f-want) < 1e-6
}

func CheckRoute(ctx *harness.Ctx) {
	c := readSetup(ctx)
	body := readBody(ctx, readStats(c, "b-1", "b-1"), "b-1 reading its own stats")
	ctx.Assert(body["bidder"] == "b-1" && body["day"] == spend.Today(), "the answer is %v, expected bidder b-1 and today's day %s", body, spend.Today())
	ctx.Assert(readNear(body["auctions"], 8) && readNear(body["bids"], 4) && readNear(body["wins"], 1), "the answer is %v, expected today's 8 auctions, 4 bids and 1 win", body)
}

func CheckWinRateDenominator(ctx *harness.Ctx) {
	c := readSetup(ctx)
	body := readBody(ctx, readStats(c, "b-1", "b-1"), "b-1 reading its own stats")
	ctx.Assert(readNear(body["win_rate"], 0.125), "1 win in 8 auctions (3 lost, 4 timed out) reads win_rate %v, expected 0.125: the denominator is every auction seen", body["win_rate"])
	empty := readBody(ctx, readStats(c, "b-2", "b-2"), "a bidder with nothing seen today")
	ctx.Assert(readNear(empty["win_rate"], 0), "a bidder with no auctions today reads win_rate %v, expected 0", empty["win_rate"])
}

func CheckTimeoutShare(ctx *harness.Ctx) {
	c := readSetup(ctx)
	body := readBody(ctx, readStats(c, "b-1", "b-1"), "b-1 reading its own stats")
	ctx.Assert(readNear(body["timeout_rate"], 0.5), "4 timeouts in 8 auctions read timeout_rate %v, expected 0.5", body["timeout_rate"])
	ctx.Assert(readNear(body["degraded_share"], 0.5), "2 degraded bids of 4 read degraded_share %v, expected 0.5", body["degraded_share"])
	empty := readBody(ctx, readStats(c, "b-2", "b-2"), "a bidder with nothing seen today")
	ctx.Assert(readNear(empty["timeout_rate"], 0) && readNear(empty["degraded_share"], 0), "a bidder with nothing seen today reads %v, expected timeout_rate and degraded_share 0", empty)
}

func CheckForeign403(ctx *harness.Ctx) {
	c := readSetup(ctx)
	r := readStats(c, "b-1", "")
	ctx.Equal(r.Status, 401, "a stats read without X-Bidder-Id")
	r = readStats(c, "b-1", "b-2")
	ctx.Equal(r.Status, 403, "bidder b-2 reading b-1's stats (%s)", strings.TrimSpace(r.Text()))
	ctx.Assert(!strings.Contains(r.Text(), "auctions"), "the 403 for b-2 carries b-1's numbers: %s", r.Text())
}

func CheckSpendWindow(ctx *harness.Ctx) {
	ctx.Redis.Set("spend:b-1:20200101", 900) // an old day's counter: not today's spend
	c := readSetup(ctx)
	body := readBody(ctx, readStats(c, "b-1", "b-1"), "b-1 reading its own stats")
	ctx.Assert(readNear(body["spend_cents"], 310), "with 310 claimed today (spend:b-1:%s) the answer reads spend_cents %v", spend.Today(), body["spend_cents"])
	ctx.Assert(readNear(body["cap_cents"], 1000), "with cap:b-1 at 1000 the answer reads cap_cents %v", body["cap_cents"])
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>

#include "rtb/spend.h"

using json = nlohmann::json;

namespace {

harness::HTTP readSetup(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  const std::string day = rtb::spend::today();
  ctx.Redis.Do("HSET", "stats:b-1:" + day, "auctions", 8, "bids", 4, "wins", 1, "losses", 3, "timeouts", 4, "degraded", 2);
  ctx.Redis.Set("spend:b-1:" + day, 310);
  ctx.Redis.Set("cap:b-1", 1000);
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readStats(harness::HTTP& c, const std::string& bidder, const std::string& caller) {
  if (caller.empty()) return c.Get("/v1/bidders/" + bidder + "/stats");
  return c.Get("/v1/bidders/" + bidder + "/stats", "X-Bidder-Id", caller);
}

json readBody(harness::Ctx& ctx, const harness::Response& r, const std::string& why) {
  ctx.Equal(r.Status, 200, "%s: GET /v1/bidders/…/stats (%s)", why, r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "%s: the answer is not a JSON object: %s", why, r.Text());
  return body;
}

bool near(const json& body, const std::string& field, double want) {
  return body.contains(field) && body[field].is_number() && std::fabs(body[field].get<double>() - want) < 1e-6;
}

std::string fieldText(const json& body, const std::string& field) { return body.contains(field) ? body[field].dump() : "missing"; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readSetup(ctx);
  const json body = readBody(ctx, readStats(c, "b-1", "b-1"), "b-1 reading its own stats");
  ctx.Assert(body.value("bidder", "") == "b-1" && body.value("day", "") == rtb::spend::today(), "the answer is %s, expected bidder b-1 and today's day %s", body.dump(), rtb::spend::today());
  ctx.Assert(near(body, "auctions", 8) && near(body, "bids", 4) && near(body, "wins", 1), "the answer is %s, expected today's 8 auctions, 4 bids and 1 win", body.dump());
}

void CheckWinRateDenominator(harness::Ctx& ctx) {
  auto c = readSetup(ctx);
  const json body = readBody(ctx, readStats(c, "b-1", "b-1"), "b-1 reading its own stats");
  ctx.Assert(near(body, "win_rate", 0.125), "1 win in 8 auctions (3 lost, 4 timed out) reads win_rate %s, expected 0.125: the denominator is every auction seen", fieldText(body, "win_rate"));
  const json empty = readBody(ctx, readStats(c, "b-2", "b-2"), "a bidder with nothing seen today");
  ctx.Assert(near(empty, "win_rate", 0), "a bidder with no auctions today reads win_rate %s, expected 0", fieldText(empty, "win_rate"));
}

void CheckTimeoutShare(harness::Ctx& ctx) {
  auto c = readSetup(ctx);
  const json body = readBody(ctx, readStats(c, "b-1", "b-1"), "b-1 reading its own stats");
  ctx.Assert(near(body, "timeout_rate", 0.5), "4 timeouts in 8 auctions read timeout_rate %s, expected 0.5", fieldText(body, "timeout_rate"));
  ctx.Assert(near(body, "degraded_share", 0.5), "2 degraded bids of 4 read degraded_share %s, expected 0.5", fieldText(body, "degraded_share"));
  const json empty = readBody(ctx, readStats(c, "b-2", "b-2"), "a bidder with nothing seen today");
  ctx.Assert(near(empty, "timeout_rate", 0) && near(empty, "degraded_share", 0), "a bidder with nothing seen today reads %s, expected timeout_rate and degraded_share 0", empty.dump());
}

void CheckForeign403(harness::Ctx& ctx) {
  auto c = readSetup(ctx);
  auto r = readStats(c, "b-1", "");
  ctx.Equal(r.Status, 401, "a stats read without X-Bidder-Id");
  r = readStats(c, "b-1", "b-2");
  ctx.Equal(r.Status, 403, "bidder b-2 reading b-1's stats (%s)", r.Text());
  ctx.Assert(r.Text().find("auctions") == std::string::npos, "the 403 for b-2 carries b-1's numbers: %s", r.Text());
}

void CheckSpendWindow(harness::Ctx& ctx) {
  ctx.Redis.Set("spend:b-1:20200101", 900);  // an old day's counter: not today's spend
  auto c = readSetup(ctx);
  const json body = readBody(ctx, readStats(c, "b-1", "b-1"), "b-1 reading its own stats");
  ctx.Assert(near(body, "spend_cents", 310), "with 310 claimed today (spend:b-1:%s) the answer reads spend_cents %s", rtb::spend::today(), fieldText(body, "spend_cents"));
  ctx.Assert(near(body, "cap_cents", 1000), "with cap:b-1 at 1000 the answer reads cap_cents %s", fieldText(body, "cap_cents"));
}
`,
  },
  hints: [
    'A bidder that timed out on half its auctions reads a 25% win rate, no timeout figure at all, 0 cents spent on a busy day, and any other bidder can read the same page by changing the id in the URL.',
    'The win rate divides by wins plus losses, which leaves out timeouts and no-bids; the response has no timeout or degraded field; the spend comes from `spend:{bidder}`, a key step 2 replaced with a per-day one; nothing compares the caller with the path.',
    'Check `X-Bidder-Id` (401 when empty, 403 when not the path id); use `share(wins, auctions)`; add `timeout_rate` and `degraded_share`; read `spend.spent(bidder, day)` and `spend.cap_of(bidder)`.',
  ],
  debrief: `A rate is only as honest as its denominator. Auctions seen is the one number that includes every way a bid fails to land, so dividing by it turns timeouts and no-bids into a lower win rate instead of hiding them; the timeout rate and the degraded share then say why. Reading spend from the counter the claim script writes keeps the dashboard and the cap on the same number. The caller check is the cheapest part and the one a URL edit tests first. Production dashboards read these counters per exchange and per hour, compute percentiles of response time from a histogram rather than an average, and alert on the timeout rate before the win rate moves, since timeouts arrive first.`,
};
