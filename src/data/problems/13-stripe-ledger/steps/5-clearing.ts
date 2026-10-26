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
        typescript: {
          all: [/startsWith\(\s*['"]clearing:['"]\s*\)/, /\.zadd\(\s*OPEN_KEY\s*,\s*postedAt\s*,\s*transactionId\s*\)/],
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
        typescript: {all: [/\.zrem\(\s*OPEN_KEY\s*,\s*settles\s*\)/], order: [/if \(settles/, /\.zrem\(/, /\.zadd\(/]},
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
        typescript: {
          all: [/\.zrangebyscore\(\s*OPEN_KEY\s*,\s*['"]-inf['"]\s*,/, /STUCK_AFTER_MS/, /['"]WITHSCORES['"]/],
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
        typescript: {all: [/app\.get\(\s*['"]\/clearing\/stuck['"]/, /age_s/, /opened_at/]},
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
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const OPEN_KEY = 'clearing:open';
export const STUCK_AFTER_MS = 24 * 3600 * 1000;

export interface Entry {
  account: string;
  currency: string;
  amount: number;
}

export interface StuckItem {
  transaction_id: string;
  opened_at: number;
  age_s: number;
}

const nowMs = (): number => Date.now();

/** Called by the journal writer after every commit: close the item this transaction settles, or open one. */
export async function track(
  transactionId: string,
  postedAt: number,
  entries: Entry[],
  settles: string | null = null,
): Promise<void> {
  // TODO: settles given → ZREM OPEN_KEY settles, and nothing else
  // TODO: any entry on a clearing:* account → ZADD OPEN_KEY postedAt transactionId
  throw new Error('not implemented');
}

/** Open items older than STUCK_AFTER_MS as [{transaction_id, opened_at, age_s}], oldest first. */
export async function stuck(now: number = nowMs()): Promise<StuckItem[]> {
  // TODO: ZRANGEBYSCORE OPEN_KEY -inf (now - STUCK_AFTER_MS) WITHSCORES → age_s = floor((now - score) / 1000)
  return [];
}

app.get('/clearing/stuck', async () => {
  // TODO: 200 with stuck()
  return [];
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const OPEN_KEY = 'clearing:open';
export const STUCK_AFTER_MS = 24 * 3600 * 1000;

export interface Entry {
  account: string;
  currency: string;
  amount: number;
}

export interface StuckItem {
  transaction_id: string;
  opened_at: number;
  age_s: number;
}

const nowMs = (): number => Date.now();

/** Called by the journal writer after every commit: close the item this transaction settles, or open one. */
export async function track(
  transactionId: string,
  postedAt: number,
  entries: Entry[],
  settles: string | null = null,
): Promise<void> {
  if (settles) {
    await redis.zrem(OPEN_KEY, settles); // the closing side of a flow; a no-op if the opening side has not arrived yet
    return;
  }
  if (entries.some(entry => entry.account.startsWith('clearing:'))) {
    await redis.zadd(OPEN_KEY, postedAt, transactionId); // scored by the transaction's own time, not the arrival time
  }
}

/** Open items older than STUCK_AFTER_MS as [{transaction_id, opened_at, age_s}], oldest first. */
export async function stuck(now: number = nowMs()): Promise<StuckItem[]> {
  const cutoff = now - STUCK_AFTER_MS;
  const flat = await redis.zrangebyscore(OPEN_KEY, '-inf', cutoff, 'WITHSCORES');
  const items: StuckItem[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const openedAt = Number(flat[i + 1]);
    items.push({transaction_id: flat[i], opened_at: openedAt, age_s: Math.floor((now - openedAt) / 1000)});
  }
  return items;
}

app.get('/clearing/stuck', async () => stuck());
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

SCHEMA = """
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
"""

H = 3600 * 1000
CAPTURE = [{"account": "cash:acquirer", "currency": "EUR", "amount": 4999}, {"account": "clearing:payments", "currency": "EUR", "amount": -4999}]
PAYOUT = [{"account": "clearing:payments", "currency": "EUR", "amount": 4999}, {"account": "clearing:payouts", "currency": "EUR", "amount": -4999}]
CASH_ONLY = [{"account": "cash:bank", "currency": "EUR", "amount": 100}, {"account": "cash:acquirer", "currency": "EUR", "amount": -100}]


def _now():
    return int(time.time() * 1000)


async def _world(ctx):
    """The real journal writer (step 4) on an empty ledger, calling the learner's tracker after every commit."""
    await ctx.db.reset(SCHEMA)
    writer = ctx.load("ledger_writer")
    import clearing_tracker

    return writer, clearing_tracker


async def _write(writer, entries, posted_at, settles=None):
    """A real transaction through the journal, posted at its own time; returns its id."""
    return await writer.write_transaction(entries, "flow", posted_at=posted_at, settles=settles)


def _open(ctx):
    return {m: int(s) for m, s in ctx.redis.zrange("clearing:open", 0, -1, withscores=True)}


async def check_opens_item(ctx):
    writer, _ = await _world(ctx)
    t0 = _now() - 3 * H
    a = await _write(writer, CAPTURE, t0)
    assert ctx.redis.type("clearing:open") == "zset", f"clearing:open must be a sorted set, found {ctx.redis.type('clearing:open')!r}"
    score = ctx.redis.zscore("clearing:open", a)
    assert score is not None, "a transaction crediting clearing:payments must be added to clearing:open under its transaction id"
    assert int(score) == t0, f"the score must be the transaction's own posted_at ({t0}), got {int(score)}: a late event must already be overdue"
    b = await _write(writer, CASH_ONLY, _now())
    assert ctx.redis.zscore("clearing:open", b) is None, "a transaction between cash accounts touches no clearing account and must not be tracked"
    c = await _write(writer, PAYOUT, t0 + 1)
    assert _open(ctx) == {a: t0, c: t0 + 1}, f"clearing:open should hold the capture and the payout, holds {_open(ctx)}"


async def check_settles_closes(ctx):
    writer, _ = await _world(ctx)
    t0 = _now() - 3 * H
    a = await _write(writer, CAPTURE, t0)
    b = await _write(writer, PAYOUT, t0 + 2 * H, settles=a)
    assert ctx.redis.zscore("clearing:open", a) is None, "the transaction that settles the capture must ZREM it from clearing:open"
    assert ctx.redis.zscore("clearing:open", b) is None, "the settling transaction is the closing side of the flow: it must not open an item of its own"
    try:
        await _write(writer, PAYOUT, t0, settles="tx-unknown")
    except Exception as exc:
        raise AssertionError(f"settling an id that is not open must be a no-op, but the write failed in track with {type(exc).__name__}: {exc}")
    assert _open(ctx) == {}, f"clearing:open should be empty, holds {_open(ctx)}"
    c = await _write(writer, CAPTURE, t0)
    d = await _write(writer, CAPTURE, t0 + 1)
    await _write(writer, PAYOUT, t0 + 2, settles=c)
    assert _open(ctx) == {d: t0 + 1}, f"only the first of two captures was settled: clearing:open should hold the second, holds {_open(ctx)}"


async def check_stuck_window(ctx):
    writer, m = await _world(ctx)
    now = _now()
    ids = {}
    for name, hours in (("48h", 48), ("23h", 23), ("25h", 25), ("1h", 1)):
        ids[await _write(writer, CAPTURE, now - hours * H)] = name
    items = m.stuck()
    assert isinstance(items, list), f"stuck() must return a list, got {type(items).__name__}"
    assert len(_open(ctx)) == 4, "stuck() reports; it must not remove anything from clearing:open"
    got = [ids.get(i.get("transaction_id"), i.get("transaction_id")) for i in items]
    assert got == ["48h", "25h"], f"of transactions posted 48 h, 23 h, 25 h and 1 h ago, the ones older than 24 h, oldest first, are ['48h', '25h']; got {got}"
    for item in items:
        assert item.get("opened_at") == int(ctx.redis.zscore("clearing:open", item["transaction_id"])), f"opened_at must be the item's score, got {item}"
    ages = {ids[i["transaction_id"]]: i.get("age_s") for i in items}
    assert abs(ages["48h"] - 48 * 3600) <= 2 and abs(ages["25h"] - 25 * 3600) <= 2, f"age_s must be the age in seconds, got {ages}"
    ctx.clock.advance(2 * 3600)
    got = [ids.get(i["transaction_id"], i["transaction_id"]) for i in m.stuck()]
    assert got == ["48h", "25h", "23h"], f"two hours later the 23 h one has crossed 24 h and must be reported: got {got}"
    # A late event: posted 30 h ago, journaled just now — stuck immediately, because the score is its own time.
    late = await _write(writer, CAPTURE, _now() - 30 * H)
    assert late in [i["transaction_id"] for i in m.stuck()], "a transaction posted 30 h ago that reaches the journal now is already stuck"


async def check_stuck_endpoint(ctx):
    writer, m = await _world(ctx)
    now = _now()
    ids = {}
    for name, hours in (("27h", 27), ("2h", 2), ("30h", 30)):
        ids[await _write(writer, CAPTURE, now - hours * H)] = name
    async with ctx.client(m.app) as c:
        r = await c.get("/clearing/stuck")
    assert r.status_code == 200, f"GET /clearing/stuck answered {r.status_code}"
    assert r.headers.get("content-type", "").startswith("application/json"), f"the report must be JSON, got Content-Type {r.headers.get('content-type')!r}"
    body = r.json()
    assert isinstance(body, list), f"the report is a JSON list, got {body!r}"
    got = [ids.get(i.get("transaction_id"), i.get("transaction_id")) for i in body]
    assert got == ["30h", "27h"], f"expected the two transactions older than 24 h, oldest first (['30h', '27h']); got {got}"
    for item in body:
        assert set(item) >= {"transaction_id", "opened_at", "age_s"}, f"every item carries transaction_id, opened_at and age_s, got {item}"
    assert abs(body[0]["age_s"] - 30 * 3600) <= 2, f"the 30 h one's age_s should be about {30 * 3600}, got {body[0]['age_s']}"
    assert len(_open(ctx)) == 3, "reading the report must not change clearing:open"
`,
    typescript: `const SCHEMA = \`
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
\`;

const H = 3600 * 1000;
const CAPTURE = [
  {account: 'cash:acquirer', currency: 'EUR', amount: 4999},
  {account: 'clearing:payments', currency: 'EUR', amount: -4999},
];
const PAYOUT = [
  {account: 'clearing:payments', currency: 'EUR', amount: 4999},
  {account: 'clearing:payouts', currency: 'EUR', amount: -4999},
];
const CASH_ONLY = [
  {account: 'cash:bank', currency: 'EUR', amount: 100},
  {account: 'cash:acquirer', currency: 'EUR', amount: -100},
];

/** The real journal writer (step 4) on an empty ledger, calling the learner's tracker after every commit. */
async function world(ctx) {
  await ctx.db.reset(SCHEMA);
  const writer = ctx.load('ledger_writer');
  const tracker = ctx.load('clearing_tracker');
  return {writer, tracker};
}

/** A real transaction through the journal, posted at its own time; returns its id. */
async function write(writer, entries, postedAt: number, settles: string | null = null): Promise<string> {
  return writer.writeTransaction(entries, 'flow', {postedAt, settles});
}

function open(ctx): Record<string, number> {
  const flat = ctx.redis.zrange('clearing:open', 0, -1, 'WITHSCORES');
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]);
  return out;
}

const score = (ctx, member: string): number | null => {
  const s = ctx.redis.zscore('clearing:open', member);
  return s === null ? null : Number(s);
};

export async function check_opens_item(ctx) {
  const {writer} = await world(ctx);
  const t0 = Date.now() - 3 * H;
  const a = await write(writer, CAPTURE, t0);
  assert.equal(ctx.redis.type('clearing:open'), 'zset', \`clearing:open must be a sorted set, found \${JSON.stringify(ctx.redis.type('clearing:open'))}\`);
  const s = score(ctx, a);
  assert(s !== null, 'a transaction crediting clearing:payments must be added to clearing:open under its transaction id');
  assert.equal(s, t0, \`the score must be the transaction's own posted_at (\${t0}), got \${s}: a late event must already be overdue\`);
  const b = await write(writer, CASH_ONLY, Date.now());
  assert.equal(score(ctx, b), null, 'a transaction between cash accounts touches no clearing account and must not be tracked');
  const c = await write(writer, PAYOUT, t0 + 1);
  assert.deepEqual(open(ctx), {[a]: t0, [c]: t0 + 1}, \`clearing:open should hold the capture and the payout, holds \${JSON.stringify(open(ctx))}\`);
}

export async function check_settles_closes(ctx) {
  const {writer} = await world(ctx);
  const t0 = Date.now() - 3 * H;
  const a = await write(writer, CAPTURE, t0);
  const b = await write(writer, PAYOUT, t0 + 2 * H, a);
  assert.equal(score(ctx, a), null, 'the transaction that settles the capture must ZREM it from clearing:open');
  assert.equal(score(ctx, b), null, 'the settling transaction is the closing side of the flow: it must not open an item of its own');
  try {
    await write(writer, PAYOUT, t0, 'tx-unknown');
  } catch (e) {
    assert.fail(\`settling an id that is not open must be a no-op, but the write failed in track with \${e instanceof Error ? e.name : typeof e}: \${e instanceof Error ? e.message : String(e)}\`);
  }
  assert.deepEqual(open(ctx), {}, \`clearing:open should be empty, holds \${JSON.stringify(open(ctx))}\`);
  const c = await write(writer, CAPTURE, t0);
  const d = await write(writer, CAPTURE, t0 + 1);
  await write(writer, PAYOUT, t0 + 2, c);
  assert.deepEqual(open(ctx), {[d]: t0 + 1}, \`only the first of two captures was settled: clearing:open should hold the second, holds \${JSON.stringify(open(ctx))}\`);
}

export async function check_stuck_window(ctx) {
  const {writer, tracker} = await world(ctx);
  const now = Date.now();
  const ids: Record<string, string> = {};
  for (const [name, hours] of [['48h', 48], ['23h', 23], ['25h', 25], ['1h', 1]] as const) {
    ids[await write(writer, CAPTURE, now - hours * H)] = name;
  }
  const items = await tracker.stuck();
  assert(Array.isArray(items), \`stuck() must return a list, got \${typeof items}\`);
  assert.equal(Object.keys(open(ctx)).length, 4, 'stuck() reports; it must not remove anything from clearing:open');
  let got = items.map(i => ids[i?.transaction_id] ?? i?.transaction_id);
  assert.deepEqual(got, ['48h', '25h'], \`of transactions posted 48 h, 23 h, 25 h and 1 h ago, the ones older than 24 h, oldest first, are ['48h', '25h']; got \${JSON.stringify(got)}\`);
  for (const item of items) {
    assert.equal(item.opened_at, score(ctx, item.transaction_id), \`opened_at must be the item's score, got \${JSON.stringify(item)}\`);
  }
  const ages = Object.fromEntries(items.map(i => [ids[i.transaction_id], i.age_s]));
  assert(Math.abs(ages['48h'] - 48 * 3600) <= 2 && Math.abs(ages['25h'] - 25 * 3600) <= 2, \`age_s must be the age in seconds, got \${JSON.stringify(ages)}\`);
  ctx.clock.advance(2 * 3600);
  got = (await tracker.stuck()).map(i => ids[i.transaction_id] ?? i.transaction_id);
  assert.deepEqual(got, ['48h', '25h', '23h'], \`two hours later the 23 h one has crossed 24 h and must be reported: got \${JSON.stringify(got)}\`);
  // A late event: posted 30 h ago, journaled just now — stuck immediately, because the score is its own time.
  const late = await write(writer, CAPTURE, Date.now() - 30 * H);
  assert((await tracker.stuck()).some(i => i.transaction_id === late), 'a transaction posted 30 h ago that reaches the journal now is already stuck');
}

export async function check_stuck_endpoint(ctx) {
  const {writer, tracker} = await world(ctx);
  const now = Date.now();
  const ids: Record<string, string> = {};
  for (const [name, hours] of [['27h', 27], ['2h', 2], ['30h', 30]] as const) {
    ids[await write(writer, CAPTURE, now - hours * H)] = name;
  }
  const r = await ctx.client(tracker.app).get('/clearing/stuck');
  assert.equal(r.status, 200, \`GET /clearing/stuck answered \${r.status}\`);
  assert((r.headers['content-type'] ?? '').startsWith('application/json'), \`the report must be JSON, got Content-Type \${JSON.stringify(r.headers['content-type'])}\`);
  const body = r.json();
  assert(Array.isArray(body), \`the report is a JSON list, got \${r.text}\`);
  const got = body.map(i => ids[i?.transaction_id] ?? i?.transaction_id);
  assert.deepEqual(got, ['30h', '27h'], \`expected the two transactions older than 24 h, oldest first (['30h', '27h']); got \${JSON.stringify(got)}\`);
  for (const item of body) {
    assert(['transaction_id', 'opened_at', 'age_s'].every(k => k in item), \`every item carries transaction_id, opened_at and age_s, got \${JSON.stringify(item)}\`);
  }
  assert(Math.abs(body[0].age_s - 30 * 3600) <= 2, \`the 30 h one's age_s should be about \${30 * 3600}, got \${body[0].age_s}\`);
  assert.equal(Object.keys(open(ctx)).length, 3, 'reading the report must not change clearing:open');
}
`,
    go: `package main

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"github.com/google/uuid"

	ledgerdb "ledger/db"
	"leetbuild/harness"
)

const clrSchema = \`
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
\`

const clrH = 3600 * 1000

var (
	clrCapture  = []Entry{{Account: "cash:acquirer", Currency: "EUR", Amount: 4999}, {Account: "clearing:payments", Currency: "EUR", Amount: -4999}}
	clrPayout   = []Entry{{Account: "clearing:payments", Currency: "EUR", Amount: 4999}, {Account: "clearing:payouts", Currency: "EUR", Amount: -4999}}
	clrCashOnly = []Entry{{Account: "cash:bank", Currency: "EUR", Amount: 100}, {Account: "cash:acquirer", Currency: "EUR", Amount: -100}}
)

// clrWorld is an empty ledger behind the real journal writer (step 4), which calls the learner's
// track after every commit.
func clrWorld(ctx *harness.Ctx) {
	ctx.DB.Reset(clrSchema)
}

// clrWrite is a real transaction through the journal, posted at its own time ("" settles nothing):
// one database transaction, then track. It returns the transaction id.
func clrWrite(ctx *harness.Ctx, entries []Entry, postedAt int64, settles string) string {
	var settled *string
	if settles != "" {
		settled = &settles
	}
	bg := context.Background()
	transactionID := uuid.NewString()
	err := ledgerdb.Transaction(bg, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(bg,
			"INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES ($1, NULL, 'flow', $2, $3)",
			transactionID, settled, postedAt); err != nil {
			return err
		}
		for _, e := range entries {
			if _, err := tx.ExecContext(bg,
				"INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES ($1, $2, $3, $4, $5)",
				transactionID, e.Account, e.Currency, e.Amount, postedAt); err != nil {
				return err
			}
		}
		return nil
	})
	ctx.NoError(err, "the journal writer failed")
	track(bg, transactionID, postedAt, entries, settled)
	return transactionID
}

func clrOpen(ctx *harness.Ctx) map[string]float64 {
	out := map[string]float64{}
	for _, z := range ctx.Redis.ZRangeWithScores("clearing:open", 0, -1) {
		out[z.Member] = z.Score
	}
	return out
}

// clrNames maps transaction ids to the names they were written under (unknown ids stay as they are).
func clrNames(transactionIDs []string, names map[string]string) []string {
	out := []string{}
	for _, id := range transactionIDs {
		if name, ok := names[id]; ok {
			id = name
		}
		out = append(out, id)
	}
	return out
}

func clrStuckIDs(items []StuckItem) []string {
	out := []string{}
	for _, item := range items {
		out = append(out, item.TransactionID)
	}
	return out
}

func clrAbs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func CheckOpensItem(ctx *harness.Ctx) {
	clrWorld(ctx)
	t0 := time.Now().UnixMilli() - 3*clrH
	a := clrWrite(ctx, clrCapture, t0, "")
	ctx.Equal(ctx.Redis.Type("clearing:open"), "zset", "clearing:open must be a sorted set")
	s, ok := ctx.Redis.ZScore("clearing:open", a)
	ctx.Assert(ok, "a transaction crediting clearing:payments must be added to clearing:open under its transaction id")
	ctx.Equal(s, t0, "the score must be the transaction's own posted_at: a late event must already be overdue")
	b := clrWrite(ctx, clrCashOnly, time.Now().UnixMilli(), "")
	_, ok = ctx.Redis.ZScore("clearing:open", b)
	ctx.Assert(!ok, "a transaction between cash accounts touches no clearing account and must not be tracked")
	c := clrWrite(ctx, clrPayout, t0+1, "")
	ctx.Equal(clrOpen(ctx), map[string]float64{a: float64(t0), c: float64(t0 + 1)}, "clearing:open should hold the capture and the payout")
}

func CheckSettlesCloses(ctx *harness.Ctx) {
	clrWorld(ctx)
	t0 := time.Now().UnixMilli() - 3*clrH
	a := clrWrite(ctx, clrCapture, t0, "")
	b := clrWrite(ctx, clrPayout, t0+2*clrH, a)
	_, ok := ctx.Redis.ZScore("clearing:open", a)
	ctx.Assert(!ok, "the transaction that settles the capture must ZRem it from clearing:open")
	_, ok = ctx.Redis.ZScore("clearing:open", b)
	ctx.Assert(!ok, "the settling transaction is the closing side of the flow: it must not open an item of its own")
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				ctx.Fatalf("settling an id that is not open must be a no-op, but the write failed in track with %v", rec)
			}
		}()
		clrWrite(ctx, clrPayout, t0, "tx-unknown")
	}()
	ctx.Equal(clrOpen(ctx), map[string]float64{}, "clearing:open should be empty")
	c := clrWrite(ctx, clrCapture, t0, "")
	d := clrWrite(ctx, clrCapture, t0+1, "")
	clrWrite(ctx, clrPayout, t0+2, c)
	ctx.Equal(clrOpen(ctx), map[string]float64{d: float64(t0 + 1)}, "only the first of two captures was settled: clearing:open should hold the second")
}

func CheckStuckWindow(ctx *harness.Ctx) {
	clrWorld(ctx)
	now := time.Now().UnixMilli()
	ids := map[string]string{}
	for _, w := range []struct {
		name  string
		hours int64
	}{{"48h", 48}, {"23h", 23}, {"25h", 25}, {"1h", 1}} {
		ids[clrWrite(ctx, clrCapture, now-w.hours*clrH, "")] = w.name
	}
	items, err := stuck(context.Background(), nowMs())
	ctx.Assert(err == nil, "stuck must return the list of stuck items, it failed: %v", err)
	ctx.Equal(len(clrOpen(ctx)), 4, "stuck reports; it must not remove anything from clearing:open: items there")
	got := clrNames(clrStuckIDs(items), ids)
	ctx.Equal(got, []string{"48h", "25h"}, "of transactions posted 48 h, 23 h, 25 h and 1 h ago, the ones older than 24 h, oldest first")
	for _, item := range items {
		s, _ := ctx.Redis.ZScore("clearing:open", item.TransactionID)
		ctx.Equal(item.OpenedAt, s, "OpenedAt must be the item's score (item %+v)", item)
	}
	ages := map[string]int64{}
	for _, item := range items {
		ages[ids[item.TransactionID]] = item.AgeS
	}
	ctx.Assert(clrAbs(ages["48h"]-48*3600) <= 2 && clrAbs(ages["25h"]-25*3600) <= 2, "AgeS must be the age in seconds, got %v", ages)
	ctx.Clock.Advance(2 * 3600)
	items, err = stuck(context.Background(), nowMs())
	ctx.Assert(err == nil, "stuck must return the list of stuck items, it failed: %v", err)
	got = clrNames(clrStuckIDs(items), ids)
	ctx.Equal(got, []string{"48h", "25h", "23h"}, "two hours later the 23 h one has crossed 24 h and must be reported")
	// A late event: posted 30 h ago, journaled just now — stuck immediately, because the score is its own time.
	late := clrWrite(ctx, clrCapture, time.Now().UnixMilli()-30*clrH, "")
	items, _ = stuck(context.Background(), nowMs())
	found := false
	for _, item := range items {
		found = found || item.TransactionID == late
	}
	ctx.Assert(found, "a transaction posted 30 h ago that reaches the journal now is already stuck")
}

func CheckStuckEndpoint(ctx *harness.Ctx) {
	clrWorld(ctx)
	now := time.Now().UnixMilli()
	ids := map[string]string{}
	for _, w := range []struct {
		name  string
		hours int64
	}{{"27h", 27}, {"2h", 2}, {"30h", 30}} {
		ids[clrWrite(ctx, clrCapture, now-w.hours*clrH, "")] = w.name
	}
	r := ctx.Main(main).HTTP().Get("/clearing/stuck")
	ctx.Equal(r.Status, 200, "GET /clearing/stuck")
	contentType := r.Header.Get("Content-Type")
	ctx.Assert(strings.HasPrefix(contentType, "application/json"), "the report must be JSON, got Content-Type %q", contentType)
	body, ok := r.JSON().([]any)
	ctx.Assert(ok, "the report is a JSON list, got %s", r.Text())
	transactionIDs := []string{}
	for _, raw := range body {
		item, _ := raw.(map[string]any)
		id, _ := item["transaction_id"].(string)
		transactionIDs = append(transactionIDs, id)
	}
	ctx.Equal(clrNames(transactionIDs, ids), []string{"30h", "27h"}, "expected the two transactions older than 24 h, oldest first")
	for _, raw := range body {
		item, _ := raw.(map[string]any)
		_, hasID := item["transaction_id"]
		_, hasOpened := item["opened_at"]
		_, hasAge := item["age_s"]
		ctx.Assert(hasID && hasOpened && hasAge, "every item carries transaction_id, opened_at and age_s, got %v", item)
	}
	age, _ := body[0].(map[string]any)["age_s"].(float64)
	ctx.Assert(age-30*3600 <= 2 && 30*3600-age <= 2, "the 30 h one's age_s should be about %d, got %v", 30*3600, age)
	ctx.Equal(len(clrOpen(ctx)), 3, "reading the report must not change clearing:open: items there")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdlib>
#include <exception>
#include <map>

#include "db.h"
#include "ids.h"

namespace {

const std::string clrSchema = R"(
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
)";

constexpr int64_t clrH = 3600 * 1000;

const std::vector<Entry> clrCapture = {{"cash:acquirer", "EUR", 4999}, {"clearing:payments", "EUR", -4999}};
const std::vector<Entry> clrPayout = {{"clearing:payments", "EUR", 4999}, {"clearing:payouts", "EUR", -4999}};
const std::vector<Entry> clrCashOnly = {{"cash:bank", "EUR", 100}, {"cash:acquirer", "EUR", -100}};

// clrWorld is an empty ledger behind the real journal writer (step 4), which calls the learner's
// track after every commit.
void clrWorld(harness::Ctx& ctx) { ctx.DB.Reset(clrSchema); }

// clrWrite is a real transaction through the journal, posted at its own time ("" settles nothing):
// one database transaction, then track. It returns the transaction id.
std::string clrWrite(harness::Ctx& ctx, const std::vector<Entry>& entries, int64_t postedAt, const std::string& settles) {
  std::optional<std::string> settled;
  if (!settles.empty()) settled = settles;
  const std::string transactionID = new_uuid();
  try {
    db::transaction([&](pqxx::work& tx) {
      tx.exec_params("INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES ($1, NULL, 'flow', $2, $3)",
                     transactionID, settled, postedAt);
      for (const auto& e : entries)
        tx.exec_params("INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES ($1, $2, $3, $4, $5)",
                       transactionID, e.account, e.currency, e.amount, postedAt);
    });
  } catch (const std::exception& e) {
    ctx.Fatalf("the journal writer failed: %v", std::string(e.what()));  // Go's ctx.NoError
  }
  track(transactionID, postedAt, entries, settled);
  return transactionID;
}

std::map<std::string, double> clrOpen(harness::Ctx& ctx) {
  std::map<std::string, double> out;
  for (const auto& z : ctx.Redis.ZRangeWithScores("clearing:open", 0, -1)) out[z.Member] = z.Score;
  return out;
}

// clrStuck calls the learner's stuck at the current time; an exception (Go: a non-nil error) fails the check.
std::vector<StuckItem> clrStuck(harness::Ctx& ctx) {
  try {
    return stuck(now_ms());
  } catch (const std::exception& e) {
    ctx.Fatalf("stuck must return the list of stuck items, it failed: %v", std::string(e.what()));
  }
}

// clrNames maps transaction ids to the names they were written under (unknown ids stay as they are).
std::vector<std::string> clrNames(const std::vector<std::string>& transactionIDs, const std::map<std::string, std::string>& names) {
  std::vector<std::string> out;
  for (const auto& id : transactionIDs) {
    const auto it = names.find(id);
    out.push_back(it != names.end() ? it->second : id);
  }
  return out;
}

std::vector<std::string> clrStuckIDs(const std::vector<StuckItem>& items) {
  std::vector<std::string> out;
  for (const auto& item : items) out.push_back(item.transaction_id);
  return out;
}

}  // namespace

void CheckOpensItem(harness::Ctx& ctx) {
  clrWorld(ctx);
  const int64_t t0 = ctx.Clock.Now() - 3 * clrH;
  const std::string a = clrWrite(ctx, clrCapture, t0, "");
  ctx.Equal(ctx.Redis.Type("clearing:open"), "zset", "clearing:open must be a sorted set");
  const auto s = ctx.Redis.ZScore("clearing:open", a);
  ctx.Assert(s.has_value(), "a transaction crediting clearing:payments must be added to clearing:open under its transaction id");
  ctx.Equal(*s, t0, "the score must be the transaction's own posted_at: a late event must already be overdue");
  const std::string b = clrWrite(ctx, clrCashOnly, ctx.Clock.Now(), "");
  ctx.Assert(!ctx.Redis.ZScore("clearing:open", b).has_value(), "a transaction between cash accounts touches no clearing account and must not be tracked");
  const std::string c = clrWrite(ctx, clrPayout, t0 + 1, "");
  ctx.Equal(clrOpen(ctx), std::map<std::string, double>{{a, double(t0)}, {c, double(t0 + 1)}}, "clearing:open should hold the capture and the payout");
}

void CheckSettlesCloses(harness::Ctx& ctx) {
  clrWorld(ctx);
  const int64_t t0 = ctx.Clock.Now() - 3 * clrH;
  const std::string a = clrWrite(ctx, clrCapture, t0, "");
  const std::string b = clrWrite(ctx, clrPayout, t0 + 2 * clrH, a);
  ctx.Assert(!ctx.Redis.ZScore("clearing:open", a).has_value(), "the transaction that settles the capture must ZRem it from clearing:open");
  ctx.Assert(!ctx.Redis.ZScore("clearing:open", b).has_value(), "the settling transaction is the closing side of the flow: it must not open an item of its own");
  // Go recovers a panic here; in C++ the learner's track throws (sw::redis::Error is a std::exception).
  try {
    clrWrite(ctx, clrPayout, t0, "tx-unknown");
  } catch (const std::exception& e) {
    ctx.Fatalf("settling an id that is not open must be a no-op, but the write failed in track with %v", std::string(e.what()));
  }
  ctx.Equal(clrOpen(ctx), std::map<std::string, double>{}, "clearing:open should be empty");
  const std::string c = clrWrite(ctx, clrCapture, t0, "");
  const std::string d = clrWrite(ctx, clrCapture, t0 + 1, "");
  clrWrite(ctx, clrPayout, t0 + 2, c);
  ctx.Equal(clrOpen(ctx), std::map<std::string, double>{{d, double(t0 + 1)}}, "only the first of two captures was settled: clearing:open should hold the second");
}

void CheckStuckWindow(harness::Ctx& ctx) {
  clrWorld(ctx);
  const int64_t now = ctx.Clock.Now();
  std::map<std::string, std::string> ids;
  const std::vector<std::pair<std::string, int64_t>> windows = {{"48h", 48}, {"23h", 23}, {"25h", 25}, {"1h", 1}};
  for (const auto& [name, hours] : windows) ids[clrWrite(ctx, clrCapture, now - hours * clrH, "")] = name;
  auto items = clrStuck(ctx);
  ctx.Equal(clrOpen(ctx).size(), 4, "stuck reports; it must not remove anything from clearing:open: items there");
  auto got = clrNames(clrStuckIDs(items), ids);
  ctx.Equal(got, {"48h", "25h"}, "of transactions posted 48 h, 23 h, 25 h and 1 h ago, the ones older than 24 h, oldest first");
  for (const auto& item : items) {
    const double s = ctx.Redis.ZScore("clearing:open", item.transaction_id).value_or(0);
    ctx.Equal(item.opened_at, s, "opened_at must be the item's score (item {%s %d %d})", item.transaction_id, item.opened_at, item.age_s);
  }
  std::map<std::string, int64_t> ages;
  for (const auto& item : items) ages[ids[item.transaction_id]] = item.age_s;
  ctx.Assert(std::abs(ages["48h"] - 48 * 3600) <= 2 && std::abs(ages["25h"] - 25 * 3600) <= 2, "age_s must be the age in seconds, got %v", ages);
  ctx.Clock.Advance(2 * 3600);
  items = clrStuck(ctx);
  got = clrNames(clrStuckIDs(items), ids);
  ctx.Equal(got, {"48h", "25h", "23h"}, "two hours later the 23 h one has crossed 24 h and must be reported");
  // A late event: posted 30 h ago, journaled just now — stuck immediately, because the score is its own time.
  const std::string late = clrWrite(ctx, clrCapture, ctx.Clock.Now() - 30 * clrH, "");
  bool found = false;
  for (const auto& item : clrStuck(ctx)) found = found || item.transaction_id == late;
  ctx.Assert(found, "a transaction posted 30 h ago that reaches the journal now is already stuck");
}

void CheckStuckEndpoint(harness::Ctx& ctx) {
  clrWorld(ctx);
  const int64_t now = ctx.Clock.Now();
  std::map<std::string, std::string> ids;
  const std::vector<std::pair<std::string, int64_t>> windows = {{"27h", 27}, {"2h", 2}, {"30h", 30}};
  for (const auto& [name, hours] : windows) ids[clrWrite(ctx, clrCapture, now - hours * clrH, "")] = name;
  const auto r = ctx.Main().HTTP().Get("/clearing/stuck");
  ctx.Equal(r.Status, 200, "GET /clearing/stuck");
  const std::string contentType = r.HeaderValue("Content-Type");
  ctx.Assert(contentType.rfind("application/json", 0) == 0, "the report must be JSON, got Content-Type %q", contentType);
  const auto body = harness::ParseJSON(r.Text()).value_or(harness::Any());
  ctx.Assert(body.IsArray(), "the report is a JSON list, got %s", r.Text());
  std::vector<std::string> transactionIDs;
  for (const auto& item : body.Items()) transactionIDs.push_back(item["transaction_id"].String());
  ctx.Equal(clrNames(transactionIDs, ids), {"30h", "27h"}, "expected the two transactions older than 24 h, oldest first");
  for (const auto& item : body.Items()) {
    const auto& fields = item.Fields();
    const bool hasID = fields.count("transaction_id") != 0, hasOpened = fields.count("opened_at") != 0, hasAge = fields.count("age_s") != 0;
    ctx.Assert(hasID && hasOpened && hasAge, "every item carries transaction_id, opened_at and age_s, got %v", item);
  }
  const double age = body[0]["age_s"].Float();
  ctx.Assert(age - 30 * 3600 <= 2 && 30 * 3600 - age <= 2, "the 30 h one's age_s should be about %d, got %v", 30 * 3600, age);
  ctx.Equal(clrOpen(ctx).size(), 3, "reading the report must not change clearing:open: items there");
}
`,
  },
  debrief: `A sorted set keyed by the transaction's own time turns "which money has been in transit too long" into one range query, and the 24-hour cutoff is the timeliness window from Stripe's post expressed as a score. The rule that a settling transaction closes rather than opens is what makes the set converge: every flow adds exactly one item on its way in and removes it on its way out. The report is deliberately read-only — someone has to decide whether a stuck item is a missing event, a mislabelled one or a real operational problem, and Stripe's post describes tooling that attributes each one to a team and generates the investigation query. Real systems track clearing per account and per currency with the open *balance* as well as the open items, alert on the aged balance rather than on the count, and let an item be re-opened when a correction reverses the transaction that settled it.`,
};
