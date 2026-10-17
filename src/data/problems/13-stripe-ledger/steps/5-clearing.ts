import type {Step} from '@/lib/types';

// ---- 5. Clearing accounts: money in transit must come back to zero ----------------------------
export const clearingStep: Step = {
  id: 'clearing',
  title: 'Clearing: find the money that is stuck',
  concept: 'redis',
  file: 'clearing_tracker',
  focus: ['ingest', 'api', 'redis'],
  task: `## Task

A captured payment first lands in \`clearing:payments\`; the payout that later moves it to the bank
debits \`clearing:payouts\`. Clearing accounts hold **money in transit**, and at steady state they are
empty: every amount that enters one leaves it when the next event of the flow arrives. When that next
event is missing, late or mislabelled, the money sits there — and that is how a ledger finds a broken
pipeline without knowing anything about the pipeline. A transaction that closes a flow names the one it
closes with \`settles: <transaction_id>\`.

Implement the tracker, called by the journal writer after every commit, and the report:

- \`track(transaction_id, posted_at, entries, settles=None)\`: when \`settles\` is given, \`ZREM\` that id
  from the sorted set \`clearing:open\` — the settling transaction closes a position, it does not open
  one. Otherwise, if any entry touches a \`clearing:*\` account, \`ZADD clearing:open {transaction_id: posted_at}\`:
  the score is the transaction's **own time**, so an event that arrives a day late is already overdue.
- \`stuck(now=None)\`: the open items older than **24 h** — \`ZRANGEBYSCORE clearing:open -inf (now − 86400000)\`
  with scores — as \`[{transaction_id, opened_at, age_s}]\`, oldest first. It reports; it never removes.
- \`GET /clearing/stuck\` answers **200** with that list.

> Stripe's post describes clearing as the fraction of the ledger that has zeroed out, measured per flow
> and per account; the detection query is the same one you write here — find what should be zero and is
> not — and a single late event shows up in it within its window.`,
  sequence: {
    participants: ['journal writer', 'Redis', 'Reporting'],
    messages: [
      {
        from: 'journal writer',
        to: 'Redis',
        label: 'track(tx_7f3a, T0, [+4999 cash:acquirer, −4999 clearing:payments])',
        kind: 'sync',
      },
      {from: 'journal writer', to: 'Redis', label: 'ZADD clearing:open T0 tx_7f3a', kind: 'sync'},
      {
        from: 'journal writer',
        to: 'Redis',
        label: 'track(tx_9c21, T0 + 2 h, [+4999 clearing:payments, −4999 clearing:payouts], settles = tx_7f3a)',
        kind: 'sync',
      },
      {from: 'journal writer', to: 'Redis', label: 'ZREM clearing:open tx_7f3a', kind: 'sync'},
      {
        from: 'Reporting',
        to: 'Redis',
        label: 'GET /clearing/stuck → ZRANGEBYSCORE clearing:open -inf now − 24 h WITHSCORES',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Reporting', label: '200 [{tx_1a07, opened_at, age_s: 97200}]', kind: 'reply'},
    ],
  },
  hints: [
    '`track` is two branches, not three: `settles` present → ZREM and stop; else any `clearing:` account → ZADD. Walk the entries with `any(e["account"].startswith("clearing:") …)`.',
    "The cutoff is a score, not a rank: `now − STUCK_AFTER_MS` as the max of ZRANGEBYSCORE, `-inf` as the min, `withscores=True` so you can compute each item's age without a second round trip.",
    'Removing a member that is not in the set is a no-op for ZREM — do not pre-check with ZSCORE; the settling transaction may legitimately arrive before the one it settles was tracked.',
  ],
  checks: [
    {
      id: 'opens-item',
      title: 'A transaction touching a clearing account opens an item scored by its own time',
      detail:
        "When any entry's account starts with `clearing:`, `ZADD clearing:open {transaction_id: posted_at}` — the given `posted_at`, not now; a transaction between cash accounts opens nothing.",
      match: {
        python: {
          all: [
            /startswith\(\s*["']clearing:["']\s*\)/,
            /\.zadd\(\s*OPEN_KEY\s*,\s*\{\s*transaction_id\s*:\s*posted_at\s*\}\s*\)/,
          ],
        },
        go: {
          all: [
            /strings\.HasPrefix\(\s*[\w.]+\s*,\s*"clearing:"\s*\)/,
            /rdb\.ZAdd\(\s*ctx\s*,\s*openKey\s*,\s*redis\.Z\{\s*Score:\s*float64\(\s*postedAt\s*\)\s*,\s*Member:\s*transactionID\s*\}\s*\)/,
          ],
        },
        scala: {
          all: [
            /startsWith\(\s*"clearing:"\s*\)/,
            /jedis\.zadd\(\s*OpenKey\s*,\s*postedAt\.toDouble\s*,\s*transactionId\s*\)/,
          ],
        },
        cpp: {
          all: [
            /rfind\(\s*"clearing:"\s*,\s*0\s*\)\s*==\s*0/,
            /redis\.zadd\(\s*kOpenKey\s*,\s*transaction_id\s*,[^\n]*posted_at/,
          ],
        },
      },
    },
    {
      id: 'settles-closes',
      title: 'A settling transaction removes the item it settles and opens none',
      detail:
        'With `settles` given, `ZREM clearing:open settles` and return — the settling transaction touches a clearing account too, but it is the closing side of the flow.',
      match: {
        python: {all: [/\.zrem\(\s*OPEN_KEY\s*,\s*settles\s*\)/], order: [/if settles/, /\.zrem\(/, /\.zadd\(/]},
        go: {
          all: [/rdb\.ZRem\(\s*ctx\s*,\s*openKey\s*,\s*\*settles\s*\)/],
          order: [/settles != nil/, /rdb\.ZRem\(/, /rdb\.ZAdd\(/],
        },
        scala: {
          all: [/jedis\.zrem\(\s*OpenKey\s*,\s*\w+\s*\)/],
          order: [/settles match|settles\.foreach|case Some\(/, /jedis\.zrem\(/, /jedis\.zadd\(/],
        },
        cpp: {
          all: [/redis\.zrem\(\s*kOpenKey\s*,\s*\*settles\s*\)/],
          order: [/if \(settles\)/, /redis\.zrem\(/, /redis\.zadd\(/],
        },
      },
    },
    {
      id: 'stuck-window',
      title: 'Reports only items older than 24 h, oldest first',
      detail:
        "`ZRANGEBYSCORE clearing:open -inf now − STUCK_AFTER_MS WITHSCORES`: everything younger than a day is in flight, not stuck; the result keeps Redis's score order.",
      match: {
        python: {
          all: [/\.zrangebyscore\(\s*OPEN_KEY\s*,\s*["']-inf["']\s*,/, /STUCK_AFTER_MS/, /withscores\s*=\s*True/],
        },
        go: {all: [/rdb\.ZRangeByScoreWithScores\(\s*ctx\s*,\s*openKey\s*,/, /Min:\s*"-inf"/, /stuckAfter/]},
        scala: {all: [/jedis\.zrangeByScoreWithScores\(\s*OpenKey\s*,\s*"-inf"\s*,/, /StuckAfterMs/]},
        cpp: {all: [/redis\.zrangebyscore\(\s*kOpenKey\s*,/, /RightBoundedInterval<double>/, /kStuckAfterMs/]},
      },
    },
    {
      id: 'stuck-endpoint',
      title: 'GET /clearing/stuck lists the stuck items with their age',
      detail:
        'The endpoint answers `200` with `[{transaction_id, opened_at, age_s}]` from `stuck()`; reading the report never changes the set.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/clearing\/stuck["']/, /age_s/, /opened_at/]},
        go: {all: [/HandleFunc\(\s*"GET \/clearing\/stuck"/, /age_s/, /opened_at/]},
        scala: {all: [/path\(\s*"clearing"\s*\/\s*"stuck"\s*\)/, /age_s/, /opened_at/]},
        cpp: {all: [/svr\.Get\(\s*"\/clearing\/stuck"/, /age_s/, /opened_at/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

OPEN_KEY = "clearing:open"
STUCK_AFTER_MS = 24 * 3600 * 1000


def now_ms() -> int:
    return int(time.time() * 1000)


def track(transaction_id: str, posted_at: int, entries: list[dict], settles: str | None = None) -> None:
    """Called by the journal writer after every commit: close the item this transaction settles, or open one."""
    # TODO: settles given → ZREM OPEN_KEY settles, and nothing else
    # TODO: any entry on a clearing:* account → ZADD OPEN_KEY {transaction_id: posted_at}
    raise NotImplementedError


def stuck(now: int | None = None) -> list[dict]:
    """Open items older than STUCK_AFTER_MS as [{transaction_id, opened_at, age_s}], oldest first."""
    # TODO: ZRANGEBYSCORE OPEN_KEY -inf (now - STUCK_AFTER_MS) withscores → age_s = (now - score) // 1000
    return []


@app.get("/clearing/stuck")
def clearing_stuck() -> list[dict]:
    # TODO: 200 with stuck()
    return []


# uvicorn clearing_tracker:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import time

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

OPEN_KEY = "clearing:open"
STUCK_AFTER_MS = 24 * 3600 * 1000


def now_ms() -> int:
    return int(time.time() * 1000)


def track(transaction_id: str, posted_at: int, entries: list[dict], settles: str | None = None) -> None:
    """Called by the journal writer after every commit: close the item this transaction settles, or open one."""
    if settles:
        r.zrem(OPEN_KEY, settles)  # the closing side of a flow; a no-op if the opening side has not arrived yet
        return
    if any(entry["account"].startswith("clearing:") for entry in entries):
        r.zadd(OPEN_KEY, {transaction_id: posted_at})  # scored by the transaction's own time, not the arrival time


def stuck(now: int | None = None) -> list[dict]:
    """Open items older than STUCK_AFTER_MS as [{transaction_id, opened_at, age_s}], oldest first."""
    now = now_ms() if now is None else now
    cutoff = now - STUCK_AFTER_MS
    return [
        {"transaction_id": member, "opened_at": int(score), "age_s": (now - int(score)) // 1000}
        for member, score in r.zrangebyscore(OPEN_KEY, "-inf", cutoff, withscores=True)
    ]


@app.get("/clearing/stuck")
def clearing_stuck() -> list[dict]:
    return stuck()


# uvicorn clearing_tracker:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	openKey    = "clearing:open"
	stuckAfter = 24 * time.Hour
)

type Entry struct {
	Account  string \`json:"account"\`
	Currency string \`json:"currency"\`
	Amount   int64  \`json:"amount"\`
}

type StuckItem struct {
	TransactionID string \`json:"transaction_id"\`
	OpenedAt      int64  \`json:"opened_at"\`
	AgeS          int64  \`json:"age_s"\`
}

func nowMs() int64 { return time.Now().UnixMilli() }

// track is called by the journal writer after every commit: close the item this transaction settles, or open one.
func track(ctx context.Context, transactionID string, postedAt int64, entries []Entry, settles *string) {
	// TODO: settles != nil → ZRem openKey *settles, and nothing else
	// TODO: any entry whose Account has the prefix "clearing:" → ZAdd openKey {Score: postedAt, Member: transactionID}
	_ = strings.HasPrefix
}

// stuck returns the open items older than stuckAfter, oldest first.
func stuck(ctx context.Context, now int64) ([]StuckItem, error) {
	// TODO: ZRangeByScoreWithScores openKey Min "-inf" Max now - stuckAfter → age_s = (now - score) / 1000
	_ = strconv.FormatInt
	return nil, nil
}

func clearingStuck(rw http.ResponseWriter, r *http.Request) {
	// TODO: 200 with stuck(ctx, nowMs())
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode([]StuckItem{})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /clearing/stuck", clearingStuck)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	openKey    = "clearing:open"
	stuckAfter = 24 * time.Hour
)

type Entry struct {
	Account  string \`json:"account"\`
	Currency string \`json:"currency"\`
	Amount   int64  \`json:"amount"\`
}

type StuckItem struct {
	TransactionID string \`json:"transaction_id"\`
	OpenedAt      int64  \`json:"opened_at"\`
	AgeS          int64  \`json:"age_s"\`
}

func nowMs() int64 { return time.Now().UnixMilli() }

// track is called by the journal writer after every commit: close the item this transaction settles, or open one.
func track(ctx context.Context, transactionID string, postedAt int64, entries []Entry, settles *string) {
	if settles != nil {
		rdb.ZRem(ctx, openKey, *settles) // the closing side of a flow; a no-op if the opening side has not arrived yet
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Account, "clearing:") {
			rdb.ZAdd(ctx, openKey, redis.Z{Score: float64(postedAt), Member: transactionID}) // the transaction's own time
			return
		}
	}
}

// stuck returns the open items older than stuckAfter, oldest first.
func stuck(ctx context.Context, now int64) ([]StuckItem, error) {
	cutoff := now - stuckAfter.Milliseconds()
	members, err := rdb.ZRangeByScoreWithScores(ctx, openKey, &redis.ZRangeBy{Min: "-inf", Max: strconv.FormatInt(cutoff, 10)}).Result()
	if err != nil {
		return nil, err
	}
	items := make([]StuckItem, 0, len(members))
	for _, z := range members {
		openedAt := int64(z.Score)
		items = append(items, StuckItem{TransactionID: z.Member.(string), OpenedAt: openedAt, AgeS: (now - openedAt) / 1000})
	}
	return items, nil
}

func clearingStuck(rw http.ResponseWriter, r *http.Request) {
	items, err := stuck(r.Context(), nowMs())
	if err != nil {
		http.Error(rw, "clearing store unavailable", http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusOK)
	json.NewEncoder(rw).Encode(items)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /clearing/stuck", clearingStuck)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import ledger.Tls // Tls.serverContext — provided
import redis.clients.jedis.JedisPooled
import spray.json._
import scala.jdk.CollectionConverters._

final case class Entry(account: String, currency: String, amount: Long)
final case class StuckItem(transactionId: String, openedAt: Long, ageS: Long)

object ClearingTracker {
  val jedis = new JedisPooled("redis", 6379)
  val OpenKey = "clearing:open"
  val StuckAfterMs = 24L * 3600 * 1000

  def nowMs(): Long = System.currentTimeMillis()

  /** Called by the journal writer after every commit: close the item this transaction settles, or open one. */
  def track(transactionId: String, postedAt: Long, entries: Seq[Entry], settles: Option[String]): Unit = {
    // TODO: settles defined → zrem OpenKey settles, and nothing else
    // TODO: any entry whose account startsWith "clearing:" → zadd OpenKey postedAt.toDouble transactionId
  }

  /** Open items older than StuckAfterMs, oldest first. */
  def stuck(now: Long = nowMs()): Seq[StuckItem] = {
    // TODO: zrangeByScoreWithScores OpenKey "-inf" (now - StuckAfterMs) → ageS = (now - score) / 1000
    Nil
  }

  private def itemJson(i: StuckItem): JsValue = ??? // TODO: {"transaction_id", "opened_at", "age_s"}

  val route: Route =
    path("clearing" / "stuck") {
      get {
        // TODO: 200 with stuck()
        complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, "[]")))
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("ledger")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import ledger.Tls // Tls.serverContext — provided
import redis.clients.jedis.JedisPooled
import spray.json._
import scala.jdk.CollectionConverters._

final case class Entry(account: String, currency: String, amount: Long)
final case class StuckItem(transactionId: String, openedAt: Long, ageS: Long)

object ClearingTracker {
  val jedis = new JedisPooled("redis", 6379)
  val OpenKey = "clearing:open"
  val StuckAfterMs = 24L * 3600 * 1000

  def nowMs(): Long = System.currentTimeMillis()

  /** Called by the journal writer after every commit: close the item this transaction settles, or open one. */
  def track(transactionId: String, postedAt: Long, entries: Seq[Entry], settles: Option[String]): Unit =
    settles match {
      case Some(settled) => jedis.zrem(OpenKey, settled) // the closing side of a flow; a no-op if the opening side has not arrived yet
      case None =>
        if (entries.exists(_.account.startsWith("clearing:")))
          jedis.zadd(OpenKey, postedAt.toDouble, transactionId) // the transaction's own time, not the arrival time
    }

  /** Open items older than StuckAfterMs, oldest first. */
  def stuck(now: Long = nowMs()): Seq[StuckItem] =
    jedis.zrangeByScoreWithScores(OpenKey, "-inf", (now - StuckAfterMs).toString).asScala.toSeq.map { t =>
      val openedAt = t.getScore.toLong
      StuckItem(t.getElement, openedAt, (now - openedAt) / 1000)
    }

  private def itemJson(i: StuckItem): JsValue =
    JsObject("transaction_id" -> JsString(i.transactionId), "opened_at" -> JsNumber(i.openedAt), "age_s" -> JsNumber(i.ageS))

  val route: Route =
    path("clearing" / "stuck") {
      get {
        val body = JsArray(stuck().map(itemJson).toVector).compactPrint
        complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body)))
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("ledger")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <iterator>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kOpenKey = "clearing:open";
constexpr int64_t kStuckAfterMs = 24LL * 3600 * 1000;

struct Entry {
  std::string account;
  std::string currency;
  int64_t amount;
};

struct StuckItem {
  std::string transaction_id;
  int64_t opened_at;
  int64_t age_s;
};

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Called by the journal writer after every commit: close the item this transaction settles, or open one.
void track(const std::string& transaction_id, int64_t posted_at, const std::vector<Entry>& entries, std::optional<std::string> settles) {
  // TODO: settles → zrem kOpenKey *settles, and nothing else
  // TODO: any entry whose account starts with "clearing:" (rfind("clearing:", 0) == 0) → zadd kOpenKey transaction_id posted_at
}

// Open items older than kStuckAfterMs, oldest first.
std::vector<StuckItem> stuck(int64_t now) {
  // TODO: zrangebyscore kOpenKey (-inf, now - kStuckAfterMs] with scores → age_s = (now - score) / 1000
  return {};
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/clearing/stuck", [](const httplib::Request&, httplib::Response& res) {
    // TODO: 200 with stuck(now_ms()) as [{transaction_id, opened_at, age_s}]
    res.status = 200;
    res.set_content("[]", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <iterator>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kOpenKey = "clearing:open";
constexpr int64_t kStuckAfterMs = 24LL * 3600 * 1000;

struct Entry {
  std::string account;
  std::string currency;
  int64_t amount;
};

struct StuckItem {
  std::string transaction_id;
  int64_t opened_at;
  int64_t age_s;
};

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Called by the journal writer after every commit: close the item this transaction settles, or open one.
void track(const std::string& transaction_id, int64_t posted_at, const std::vector<Entry>& entries, std::optional<std::string> settles) {
  if (settles) {
    redis.zrem(kOpenKey, *settles);  // the closing side of a flow; a no-op if the opening side has not arrived yet
    return;
  }
  for (const auto& e : entries) {
    if (e.account.rfind("clearing:", 0) == 0) {
      redis.zadd(kOpenKey, transaction_id, static_cast<double>(posted_at));  // the transaction's own time
      return;
    }
  }
}

// Open items older than kStuckAfterMs, oldest first.
std::vector<StuckItem> stuck(int64_t now) {
  const double cutoff = static_cast<double>(now - kStuckAfterMs);
  std::vector<std::pair<std::string, double>> members;
  redis.zrangebyscore(kOpenKey, sw::redis::RightBoundedInterval<double>(cutoff, sw::redis::BoundType::CLOSED),
                      std::back_inserter(members));
  std::vector<StuckItem> items;
  for (const auto& [member, score] : members) {
    const int64_t opened_at = static_cast<int64_t>(score);
    items.push_back(StuckItem{member, opened_at, (now - opened_at) / 1000});
  }
  return items;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get("/clearing/stuck", [](const httplib::Request&, httplib::Response& res) {
    json body = json::array();
    for (const auto& item : stuck(now_ms()))
      body.push_back({{"transaction_id", item.transaction_id}, {"opened_at", item.opened_at}, {"age_s", item.age_s}});
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import time

H = 3600 * 1000
CAPTURE = [{"account": "cash:acquirer", "currency": "EUR", "amount": 4999}, {"account": "clearing:payments", "currency": "EUR", "amount": -4999}]
PAYOUT = [{"account": "clearing:payments", "currency": "EUR", "amount": 4999}, {"account": "clearing:payouts", "currency": "EUR", "amount": -4999}]
CASH_ONLY = [{"account": "cash:bank", "currency": "EUR", "amount": 100}, {"account": "cash:acquirer", "currency": "EUR", "amount": -100}]


def _now():
    return int(time.time() * 1000)


def _open(ctx):
    return {m: int(s) for m, s in ctx.redis.zrange("clearing:open", 0, -1, withscores=True)}


def check_opens_item(ctx):
    m = ctx.load("clearing_tracker")
    t0 = _now() - 3 * H
    m.track("tx-1", t0, CAPTURE)
    assert ctx.redis.type("clearing:open") == "zset", f"clearing:open must be a sorted set, found {ctx.redis.type('clearing:open')!r}"
    score = ctx.redis.zscore("clearing:open", "tx-1")
    assert score is not None, "a transaction crediting clearing:payments must be added to clearing:open"
    assert int(score) == t0, f"the score must be the transaction's own posted_at ({t0}), got {int(score)}: a late event must already be overdue"
    m.track("tx-2", _now(), CASH_ONLY)
    assert ctx.redis.zscore("clearing:open", "tx-2") is None, "a transaction between cash accounts touches no clearing account and must not be tracked"
    m.track("tx-3", t0 + 1, PAYOUT)
    assert _open(ctx) == {"tx-1": t0, "tx-3": t0 + 1}, f"clearing:open should hold tx-1 and tx-3, holds {_open(ctx)}"


def check_settles_closes(ctx):
    m = ctx.load("clearing_tracker")
    t0 = _now() - 3 * H
    m.track("tx-1", t0, CAPTURE)
    m.track("tx-2", t0 + 2 * H, PAYOUT, settles="tx-1")
    assert ctx.redis.zscore("clearing:open", "tx-1") is None, "the transaction that settles tx-1 must ZREM it from clearing:open"
    assert ctx.redis.zscore("clearing:open", "tx-2") is None, "the settling transaction is the closing side of the flow: it must not open an item of its own"
    try:
        m.track("tx-9", t0, PAYOUT, settles="tx-unknown")
    except Exception as exc:
        raise AssertionError(f"settling an id that is not open must be a no-op, but track raised {exc!r}")
    assert _open(ctx) == {}, f"clearing:open should be empty, holds {_open(ctx)}"
    m.track("tx-4", t0, CAPTURE)
    m.track("tx-5", t0 + 1, CAPTURE)
    m.track("tx-6", t0 + 2, PAYOUT, settles="tx-4")
    assert _open(ctx) == {"tx-5": t0 + 1}, f"only tx-4 was settled: clearing:open should hold tx-5, holds {_open(ctx)}"


def check_stuck_window(ctx):
    m = ctx.load("clearing_tracker")
    now = _now()
    ctx.redis.zadd("clearing:open", {"tx-48h": now - 48 * H, "tx-23h": now - 23 * H, "tx-25h": now - 25 * H, "tx-1h": now - 1 * H})
    items = m.stuck()
    assert isinstance(items, list), f"stuck() must return a list, got {type(items).__name__}"
    ids = [i.get("transaction_id") for i in items]
    assert ids == ["tx-48h", "tx-25h"], f"items older than 24 h, oldest first, are ['tx-48h', 'tx-25h']; got {ids}"
    for item in items:
        assert item.get("opened_at") == int(ctx.redis.zscore("clearing:open", item["transaction_id"])), f"opened_at must be the item's score, got {item}"
    ages = {i["transaction_id"]: i.get("age_s") for i in items}
    assert abs(ages["tx-48h"] - 48 * 3600) <= 2 and abs(ages["tx-25h"] - 25 * 3600) <= 2, f"age_s must be the age in seconds, got {ages}"
    assert len(_open(ctx)) == 4, "stuck() reports; it must not remove anything from clearing:open"
    ctx.clock.advance(2 * 3600)
    ids = [i["transaction_id"] for i in m.stuck()]
    assert ids == ["tx-48h", "tx-25h", "tx-23h"], f"two hours later tx-23h has crossed 24 h and must be reported: got {ids}"
    # A late event: posted 30 h ago, tracked just now — stuck immediately, because the score is its own time.
    m.track("tx-late", _now() - 30 * H, CAPTURE)
    assert "tx-late" in [i["transaction_id"] for i in m.stuck()], "an event posted 30 h ago that arrives now is already stuck"


async def check_stuck_endpoint(ctx):
    m = ctx.load("clearing_tracker")
    now = _now()
    ctx.redis.zadd("clearing:open", {"tx-27h": now - 27 * H, "tx-2h": now - 2 * H, "tx-30h": now - 30 * H})
    async with ctx.client(m.app) as c:
        r = await c.get("/clearing/stuck")
    assert r.status_code == 200, f"GET /clearing/stuck answered {r.status_code}"
    assert r.headers.get("content-type", "").startswith("application/json"), f"the report must be JSON, got Content-Type {r.headers.get('content-type')!r}"
    body = r.json()
    assert isinstance(body, list), f"the report is a JSON list, got {body!r}"
    assert [i.get("transaction_id") for i in body] == ["tx-30h", "tx-27h"], f"expected the two items older than 24 h, oldest first; got {body}"
    for item in body:
        assert set(item) >= {"transaction_id", "opened_at", "age_s"}, f"every item carries transaction_id, opened_at and age_s, got {item}"
    assert abs(body[0]["age_s"] - 30 * 3600) <= 2, f"tx-30h's age_s should be about {30 * 3600}, got {body[0]['age_s']}"
    assert len(_open(ctx)) == 3, "reading the report must not change clearing:open"
`,
  },
  debrief: `A sorted set keyed by the transaction's own time turns "which money has been in transit too long" into one range query, and the 24-hour cutoff is the timeliness window from Stripe's post expressed as a score. The rule that a settling transaction closes rather than opens is what makes the set converge: every flow adds exactly one item on its way in and removes it on its way out. The report is deliberately read-only — someone has to decide whether a stuck item is a missing event, a mislabelled one or a real operational problem, and Stripe's post describes tooling that attributes each one to a team and generates the investigation query. Real systems track clearing per account and per currency with the open *balance* as well as the open items, alert on the aged balance rather than on the count, and let an item be re-opened when a correction reverses the transaction that settled it.`,
};
