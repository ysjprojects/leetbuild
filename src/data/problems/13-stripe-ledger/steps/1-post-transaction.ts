import type {Step} from '@/lib/types';

// ---- 1. POST /transactions: double entry or nothing -------------------------------------------
export const postTransactionStep: Step = {
  id: 'post-transaction',
  title: 'POST /transactions: double entry or nothing',
  concept: 'http',
  file: 'ledger_api',
  focus: ['client', 'api', 'db'],
  task: `## Task

Internal systems post transactions to the ledger over HTTPS:

\`\`\`json
POST /transactions
{"description": "capture ch_1",
 "entries": [{"account": "cash:acquirer",     "currency": "EUR", "amount": 4999},
             {"account": "clearing:payments", "currency": "EUR", "amount": -4999}]}
\`\`\`

Amounts are **integers in minor units** (cents): a debit is positive, a credit is negative. The ledger
is only trustworthy if nothing unbalanced ever gets in, so the endpoint validates before it writes.
\`write_transaction(entries, description, posted_at=…, settles=…)\` is provided (you build it in step 4):
it writes the rows and returns the transaction id.

Implement \`validate(body)\` — the reason the body is not a double-entry transaction, or \`None\` — and
\`handle(body)\`, which returns \`(status, payload)\`:

- Fewer than **two** entries, or an entry without an account → **422** \`{"error": reason}\`.
- An \`amount\` that is not an integer — a float like \`49.99\`, a string, a boolean — or that is **0** → **422**.
  Floats cannot represent money; a zero entry moves nothing and hides a bug.
- Every entry's \`currency\` must match \`^[A-Z]{3}$\` and all entries must share **one** currency → otherwise **422**.
- Debits and credits must **net to zero** → otherwise **422**.
- Otherwise call \`write_transaction\` with the cleaned entries, the description, \`posted_at\` = now in
  milliseconds and the optional \`settles\` field, and answer **201** with
  \`{transaction_id, posted_at, entries}\` and a \`Location: /transactions/{id}\` header.

:::widget status-codes {}

> 422, not 400: the JSON is well formed and the request is understood — it is the *content* that cannot be
> accepted. The reason in the body is what the posting system's engineer will read in their logs.`,
  sequence: {
    participants: ['Caller', 'ledger', 'Postgres'],
    messages: [
      {from: 'Caller', to: 'ledger', label: 'POST /transactions {entries: [+4999 EUR, -4999 EUR]}', kind: 'sync'},
      {from: 'ledger', to: 'ledger', label: 'validate: ≥2 entries · ints ≠ 0 · one currency · Σ = 0', kind: 'sync'},
      {from: 'ledger', to: 'Postgres', label: 'write_transaction(entries, …)', kind: 'sync'},
      {from: 'Postgres', to: 'ledger', label: 'tx_7f3a', kind: 'reply'},
      {from: 'ledger', to: 'Caller', label: '201 Location: /transactions/tx_7f3a', kind: 'reply'},
      {from: 'Caller', to: 'ledger', label: 'POST /transactions {entries: [+49.99, -49.99]}', kind: 'sync'},
      {from: 'ledger', to: 'Caller', label: '422 {"error": "amount must be an integer in minor units"}', kind: 'reply'},
    ],
  },
  hints: [
    'Validate in one pass over the entries, collecting the set of currencies and the running sum as you go; return the first reason you hit. The cross-entry rules (one currency, sum zero) come after the loop.',
    'In Python `True` is an `int`: test for `bool` before `int`. In Go decode with `UseNumber()` and ask the `json.Number` for an `Int64()`; in Scala a `JsNumber` whose value `isWhole`; in C++ `is_number_integer()`.',
    'Build the entries you store from the fields you validated — account, currency, amount — not the raw objects, so an extra field a caller sends never reaches the journal.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /transactions',
      detail: 'A handler must be registered for `POST` on the `/transactions` path.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/transactions["']/]},
        go: {all: [/HandleFunc\(\s*"POST \/transactions"/]},
        scala: {all: [/path\(\s*"transactions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/transactions"/]},
      },
    },
    {
      id: 'two-entries-balanced',
      title: 'Rejects fewer than two entries or a non-zero sum with 422',
      detail:
        'A transaction has at least two entries and its amounts sum to zero; otherwise `422 Unprocessable Entity` with a reason — no write happens.',
      match: {
        python: {all: [/len\(\s*entries\s*\)\s*<\s*2/, /sum\(/, /\b422\b/]},
        go: {all: [/len\(\s*\w*[eE]ntries\s*\)\s*<\s*2/, /sum\s*\+=/, /http\.StatusUnprocessableEntity|\b422\b/]},
        scala: {all: [/entries\.(size|length)\s*<\s*2/, /\.sum\b/, /StatusCodes\.UnprocessableEntity|\b422\b/]},
        cpp: {all: [/entries\.size\(\)\s*<\s*2/, /sum\s*\+=/, /\b422\b/]},
      },
    },
    {
      id: 'integer-amounts',
      title: 'Accepts only non-zero integer amounts',
      detail:
        'Amounts are integers in minor units: a float, a string, a boolean or `0` is a `422`. Money is never a float.',
      match: {
        python: {
          all: [/isinstance\(\s*amount\s*,\s*bool\s*\)/, /isinstance\(\s*amount\s*,\s*int\s*\)/, /amount\s*==\s*0/],
        },
        go: {all: [/\(json\.Number\)/, /\.Int64\(\)/, /==\s*0/]},
        scala: {all: [/JsNumber\(/, /isWhole/, /==\s*0|Some\(0\)/]},
        cpp: {all: [/is_number_integer\(\)/, /==\s*0/]},
      },
    },
    {
      id: 'one-currency',
      title: 'Requires one well-formed currency across the entries',
      detail:
        'Every `currency` must match `^[A-Z]{3}$` (`CURRENCY_RE`) and all entries must share it; a mixed-currency transaction cannot balance and is a `422`.',
      match: {
        python: {all: [/CURRENCY_RE\.(fullmatch|match)\(/, /len\(\s*currencies\s*\)\s*(!=|>)\s*1/]},
        go: {all: [/currencyRe\.MatchString\(/, /len\(\s*currencies\s*\)\s*(!=|>)\s*1/]},
        scala: {all: [/CurrencyRe\.matches\(/, /currencies\.size\s*(!=|>)\s*1/]},
        cpp: {all: [/std::regex_match\([^\n]*kCurrencyRe/, /currencies\.size\(\)\s*(!=|>)\s*1/]},
      },
    },
    {
      id: 'created',
      title: 'Writes the transaction and answers 201 with Location',
      detail:
        'A valid body reaches `write_transaction` once, with the cleaned entries, the description, `posted_at` now and `settles`; the answer is `201 Created` with `{transaction_id, posted_at, entries}` and `Location: /transactions/{id}`.',
      match: {
        python: {all: [/(?<!def )write_transaction\(/, /Location/], order: [/await write_transaction\(/, /\b201\b/]},
        go: {
          all: [/(?<!func )writeTransaction\(/, /Location/],
          order: [/writeTransaction\(/, /http\.StatusCreated|\b201\b/],
        },
        scala: {
          all: [/(?<!def )writeTransaction\(/, /Location/],
          order: [/writeTransaction\(/, /StatusCodes\.Created|\b201\b/],
        },
        cpp: {all: [/(?<!string )write_transaction\(/, /Location/], order: [/write_transaction\(/, /\b201\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import re
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ledger_writer import write_transaction  # built in step 4: writes the rows, returns the transaction id

app = FastAPI()

CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def now_ms() -> int:
    return int(time.time() * 1000)


def validate(body: dict) -> str | None:
    """The reason \`body\` is not a double-entry transaction, or None when it is one."""
    entries = body.get("entries")
    # TODO: at least two entries, each with a non-empty account
    # TODO: every amount an int (not a bool, not a float, not a string) and not 0: minor units
    # TODO: every currency matches CURRENCY_RE and all entries share one currency
    # TODO: debits and credits net to zero
    return None


async def handle(body: dict) -> tuple[int, dict]:
    """The outcome of posting \`body\`: (status, payload). Step 2 wraps this in an idempotency key."""
    # TODO: validate → 422 {"error": reason}
    # TODO: write_transaction(entries, description, posted_at=now_ms(), settles=body.get("settles"))
    # TODO: 201 {transaction_id, posted_at, entries}
    return 501, {"error": "not implemented"}


@app.post("/transactions")
async def create_transaction(request: Request) -> JSONResponse:
    body = await request.json()
    status, payload = await handle(body if isinstance(body, dict) else {})
    # TODO: a Location header pointing at /transactions/{id} on 201
    return JSONResponse(payload, status_code=status)


# uvicorn ledger_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import re
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ledger_writer import write_transaction  # built in step 4: writes the rows, returns the transaction id

app = FastAPI()

CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def now_ms() -> int:
    return int(time.time() * 1000)


def validate(body: dict) -> str | None:
    """The reason \`body\` is not a double-entry transaction, or None when it is one."""
    entries = body.get("entries")
    if not isinstance(entries, list) or len(entries) < 2:
        return "a transaction needs at least two entries"
    currencies: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("account"), str) or not entry["account"]:
            return "every entry needs an account"
        amount = entry.get("amount")
        if isinstance(amount, bool) or not isinstance(amount, int):
            return "amount must be an integer in minor units"
        if amount == 0:
            return "an entry must move money: amount 0 is not allowed"
        currency = entry.get("currency")
        if not isinstance(currency, str) or not CURRENCY_RE.fullmatch(currency):
            return "currency must be a three-letter ISO code"
        currencies.add(currency)
    if len(currencies) != 1:
        return "all entries of a transaction share one currency"
    if sum(entry["amount"] for entry in entries) != 0:
        return "debits and credits must net to zero"
    return None


async def handle(body: dict) -> tuple[int, dict]:
    """The outcome of posting \`body\`: (status, payload). Step 2 wraps this in an idempotency key."""
    reason = validate(body)
    if reason is not None:
        return 422, {"error": reason}
    entries = [{"account": e["account"], "currency": e["currency"], "amount": e["amount"]} for e in body["entries"]]
    posted_at = now_ms()
    transaction_id = await write_transaction(
        entries, str(body.get("description", "")), posted_at=posted_at, settles=body.get("settles")
    )
    return 201, {"transaction_id": transaction_id, "posted_at": posted_at, "entries": entries}


@app.post("/transactions")
async def create_transaction(request: Request) -> JSONResponse:
    body = await request.json()
    status, payload = await handle(body if isinstance(body, dict) else {})
    headers = {"Location": f"/transactions/{payload['transaction_id']}"} if status == 201 else {}
    return JSONResponse(payload, status_code=status, headers=headers)


# uvicorn ledger_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"time"
)

var currencyRe = regexp.MustCompile(\`^[A-Z]{3}$\`)

type Entry struct {
	Account  string \`json:"account"\`
	Currency string \`json:"currency"\`
	Amount   int64  \`json:"amount"\`
}

// writeTransaction writes the rows and returns the transaction id (built in step 4, ledger_writer.go).
func writeTransaction(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
	panic("not implemented")
}

func nowMs() int64 { return time.Now().UnixMilli() }

// validate returns the reason body is not a double-entry transaction and the cleaned entries when it is.
func validate(body map[string]any) (string, []Entry) {
	rawEntries, _ := body["entries"].([]any)
	// TODO: at least two entries, each with a non-empty account
	// TODO: every amount a json.Number with an Int64() and not 0: minor units
	// TODO: every currency matches currencyRe and all entries share one currency
	// TODO: debits and credits net to zero
	_ = rawEntries
	return "not implemented", nil
}

// handle is the outcome of posting body: (status, payload). Step 2 wraps this in an idempotency key.
func handle(ctx context.Context, body map[string]any) (int, map[string]any) {
	// TODO: validate → 422 {"error": reason}
	// TODO: writeTransaction(ctx, entries, description, nil, nowMs(), settles)
	// TODO: 201 {transaction_id, posted_at, entries}
	return http.StatusNotImplemented, map[string]any{"error": "not implemented"}
}

func createTransaction(rw http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(r.Body)
	dec.UseNumber() // amounts arrive as json.Number, not float64
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	status, payload := handle(r.Context(), body)
	// TODO: a Location header pointing at /transactions/{id} on 201
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /transactions", createTransaction)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"time"
)

var currencyRe = regexp.MustCompile(\`^[A-Z]{3}$\`)

type Entry struct {
	Account  string \`json:"account"\`
	Currency string \`json:"currency"\`
	Amount   int64  \`json:"amount"\`
}

// writeTransaction writes the rows and returns the transaction id (built in step 4, ledger_writer.go).
func writeTransaction(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
	panic("not implemented")
}

func nowMs() int64 { return time.Now().UnixMilli() }

// validate returns the reason body is not a double-entry transaction and the cleaned entries when it is.
func validate(body map[string]any) (string, []Entry) {
	rawEntries, _ := body["entries"].([]any)
	if len(rawEntries) < 2 {
		return "a transaction needs at least two entries", nil
	}
	entries := make([]Entry, 0, len(rawEntries))
	currencies := map[string]bool{}
	var sum int64
	for _, raw := range rawEntries {
		obj, _ := raw.(map[string]any)
		account, _ := obj["account"].(string)
		if account == "" {
			return "every entry needs an account", nil
		}
		number, ok := obj["amount"].(json.Number) // a bool, a string or a missing field is not a Number
		if !ok {
			return "amount must be an integer in minor units", nil
		}
		amount, err := number.Int64() // 49.99 has no Int64
		if err != nil {
			return "amount must be an integer in minor units", nil
		}
		if amount == 0 {
			return "an entry must move money: amount 0 is not allowed", nil
		}
		currency, _ := obj["currency"].(string)
		if !currencyRe.MatchString(currency) {
			return "currency must be a three-letter ISO code", nil
		}
		currencies[currency] = true
		sum += amount
		entries = append(entries, Entry{Account: account, Currency: currency, Amount: amount})
	}
	if len(currencies) != 1 {
		return "all entries of a transaction share one currency", nil
	}
	if sum != 0 {
		return "debits and credits must net to zero", nil
	}
	return "", entries
}

// handle is the outcome of posting body: (status, payload). Step 2 wraps this in an idempotency key.
func handle(ctx context.Context, body map[string]any) (int, map[string]any) {
	reason, entries := validate(body)
	if reason != "" {
		return http.StatusUnprocessableEntity, map[string]any{"error": reason}
	}
	description, _ := body["description"].(string)
	var settles *string
	if s, ok := body["settles"].(string); ok {
		settles = &s
	}
	postedAt := nowMs()
	id, err := writeTransaction(ctx, entries, description, nil, postedAt, settles)
	if err != nil {
		return http.StatusServiceUnavailable, map[string]any{"error": "TRY_AGAIN"}
	}
	return http.StatusCreated, map[string]any{"transaction_id": id, "posted_at": postedAt, "entries": entries}
}

func createTransaction(rw http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(r.Body)
	dec.UseNumber() // amounts arrive as json.Number, not float64
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	status, payload := handle(r.Context(), body)
	if status == http.StatusCreated {
		rw.Header().Set("Location", "/transactions/"+payload["transaction_id"].(string))
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /transactions", createTransaction)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.Location
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import ledger.Tls // Tls.serverContext — provided
import spray.json._

final case class Entry(account: String, currency: String, amount: Long)

object LedgerApi {
  val CurrencyRe = "^[A-Z]{3}$".r

  /** Writes the rows and returns the transaction id (built in step 4, LedgerWriter). */
  def writeTransaction(entries: Seq[Entry], description: String, eventId: Option[String], postedAt: Long, settles: Option[String]): String = ???

  def nowMs(): Long = System.currentTimeMillis()

  /** Left(reason) when \`body\` is not a double-entry transaction, Right(cleaned entries) when it is. */
  def validate(body: JsObject): Either[String, Seq[Entry]] = {
    val entries = body.fields.get("entries").collect { case JsArray(items) => items }.getOrElse(Vector.empty)
    // TODO: at least two entries, each with a non-empty account
    // TODO: every amount a JsNumber that isWhole and not 0: minor units
    // TODO: every currency matches CurrencyRe and all entries share one currency
    // TODO: debits and credits net to zero
    Left("not implemented")
  }

  /** The outcome of posting \`body\`: (status, payload). Step 2 wraps this in an idempotency key. */
  def handle(body: JsObject): (StatusCode, JsObject) = {
    // TODO: validate → 422 {"error": reason}
    // TODO: writeTransaction(entries, description, None, nowMs(), settles)
    // TODO: 201 {transaction_id, posted_at, entries}
    (StatusCodes.NotImplemented, JsObject("error" -> JsString("not implemented")))
  }

  val route: Route =
    path("transactions") {
      post {
        entity(as[String]) { raw =>
          val body = scala.util.Try(raw.parseJson.asJsObject).getOrElse(JsObject())
          val (status, payload) = handle(body)
          // TODO: a Location header pointing at /transactions/{id} on 201
          complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, payload.compactPrint)))
        }
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
import org.apache.pekko.http.scaladsl.model.headers.Location
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import ledger.Tls // Tls.serverContext — provided
import spray.json._

final case class Entry(account: String, currency: String, amount: Long)

object LedgerApi {
  val CurrencyRe = "^[A-Z]{3}$".r

  /** Writes the rows and returns the transaction id (built in step 4, LedgerWriter). */
  def writeTransaction(entries: Seq[Entry], description: String, eventId: Option[String], postedAt: Long, settles: Option[String]): String = ???

  def nowMs(): Long = System.currentTimeMillis()

  private def entryJson(e: Entry): JsObject =
    JsObject("account" -> JsString(e.account), "currency" -> JsString(e.currency), "amount" -> JsNumber(e.amount))

  private def parseEntry(value: JsValue): Either[String, Entry] = {
    val fields = value.asJsObject("every entry needs an account").fields
    val account = fields.get("account").collect { case JsString(s) if s.nonEmpty => s }
    val amount = fields.get("amount").collect { case JsNumber(n) if n.isWhole => n.toLongExact } // a float, a string or a bool is not a whole JsNumber
    val currency = fields.get("currency").collect { case JsString(s) if CurrencyRe.matches(s) => s }
    (account, amount, currency) match {
      case (None, _, _)             => Left("every entry needs an account")
      case (_, None, _)             => Left("amount must be an integer in minor units")
      case (_, Some(0), _)          => Left("an entry must move money: amount 0 is not allowed")
      case (_, _, None)             => Left("currency must be a three-letter ISO code")
      case (Some(a), Some(n), Some(c)) => Right(Entry(a, c, n))
    }
  }

  /** Left(reason) when \`body\` is not a double-entry transaction, Right(cleaned entries) when it is. */
  def validate(body: JsObject): Either[String, Seq[Entry]] = {
    val entries = body.fields.get("entries").collect { case JsArray(items) => items }.getOrElse(Vector.empty)
    if (entries.size < 2) Left("a transaction needs at least two entries")
    else
      entries.foldLeft[Either[String, Vector[Entry]]](Right(Vector.empty)) { (acc, raw) =>
        acc.flatMap(done => scala.util.Try(parseEntry(raw)).getOrElse(Left("every entry needs an account")).map(done :+ _))
      }.flatMap { parsed =>
        val currencies = parsed.map(_.currency).toSet
        if (currencies.size != 1) Left("all entries of a transaction share one currency")
        else if (parsed.map(_.amount).sum != 0) Left("debits and credits must net to zero")
        else Right(parsed)
      }
  }

  /** The outcome of posting \`body\`: (status, payload). Step 2 wraps this in an idempotency key. */
  def handle(body: JsObject): (StatusCode, JsObject) =
    validate(body) match {
      case Left(reason) => (StatusCodes.UnprocessableEntity, JsObject("error" -> JsString(reason)))
      case Right(entries) =>
        val description = body.fields.get("description").collect { case JsString(s) => s }.getOrElse("")
        val settles = body.fields.get("settles").collect { case JsString(s) => s }
        val postedAt = nowMs()
        val id = writeTransaction(entries, description, None, postedAt, settles)
        (StatusCodes.Created,
         JsObject("transaction_id" -> JsString(id), "posted_at" -> JsNumber(postedAt), "entries" -> JsArray(entries.map(entryJson).toVector)))
    }

  val route: Route =
    path("transactions") {
      post {
        entity(as[String]) { raw =>
          val body = scala.util.Try(raw.parseJson.asJsObject).getOrElse(JsObject())
          val (status, payload) = handle(body)
          val headers =
            if (status == StatusCodes.Created) List(Location(Uri("/transactions/" + payload.fields("transaction_id").convertTo[String])))
            else Nil
          complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, payload.compactPrint)))
        }
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

#include <chrono>
#include <cstdint>
#include <optional>
#include <regex>
#include <set>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::regex kCurrencyRe(R"(^[A-Z]{3}$)");

struct Entry {
  std::string account;
  std::string currency;
  int64_t amount;
};

// Writes the rows and returns the transaction id (built in step 4, ledger_writer.cpp).
std::string write_transaction(const std::vector<Entry>& entries, const std::string& description,
                              std::optional<std::string> event_id, int64_t posted_at, std::optional<std::string> settles);

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// The reason body is not a double-entry transaction (empty when it is one); fills \`out\` with the cleaned entries.
std::string validate(const json& body, std::vector<Entry>& out) {
  const json entries = body.value("entries", json::array());
  // TODO: at least two entries, each with a non-empty account
  // TODO: every amount is_number_integer() and not 0: minor units
  // TODO: every currency matches kCurrencyRe and all entries share one currency
  // TODO: debits and credits net to zero
  return "not implemented";
}

// The outcome of posting body: {status, payload}. Step 2 wraps this in an idempotency key.
std::pair<int, json> handle(const json& body) {
  // TODO: validate → 422 {"error": reason}
  // TODO: write_transaction(entries, description, std::nullopt, now_ms(), settles)
  // TODO: 201 {transaction_id, posted_at, entries}
  return {501, json{{"error", "not implemented"}}};
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/transactions", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    auto [status, payload] = handle(body);
    // TODO: a Location header pointing at /transactions/{id} on 201
    res.status = status;
    res.set_content(payload.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <optional>
#include <regex>
#include <set>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::regex kCurrencyRe(R"(^[A-Z]{3}$)");

struct Entry {
  std::string account;
  std::string currency;
  int64_t amount;
};

// Writes the rows and returns the transaction id (built in step 4, ledger_writer.cpp).
std::string write_transaction(const std::vector<Entry>& entries, const std::string& description,
                              std::optional<std::string> event_id, int64_t posted_at, std::optional<std::string> settles);

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// The reason body is not a double-entry transaction (empty when it is one); fills \`out\` with the cleaned entries.
std::string validate(const json& body, std::vector<Entry>& out) {
  const json entries = body.value("entries", json::array());
  if (!entries.is_array() || entries.size() < 2) return "a transaction needs at least two entries";
  std::set<std::string> currencies;
  int64_t sum = 0;
  for (const auto& e : entries) {
    if (!e.is_object() || !e.contains("account") || !e["account"].is_string() || e["account"].get<std::string>().empty())
      return "every entry needs an account";
    if (!e.contains("amount") || !e["amount"].is_number_integer())  // a float, a string or a bool is not an integer
      return "amount must be an integer in minor units";
    const int64_t amount = e["amount"].get<int64_t>();
    if (amount == 0) return "an entry must move money: amount 0 is not allowed";
    const std::string currency = e.value("currency", "");
    if (!std::regex_match(currency, kCurrencyRe)) return "currency must be a three-letter ISO code";
    currencies.insert(currency);
    sum += amount;
    out.push_back(Entry{e["account"].get<std::string>(), currency, amount});
  }
  if (currencies.size() != 1) return "all entries of a transaction share one currency";
  if (sum != 0) return "debits and credits must net to zero";
  return "";
}

// The outcome of posting body: {status, payload}. Step 2 wraps this in an idempotency key.
std::pair<int, json> handle(const json& body) {
  std::vector<Entry> entries;
  const std::string reason = validate(body, entries);
  if (!reason.empty()) return {422, json{{"error", reason}}};
  std::optional<std::string> settles;
  if (body.contains("settles") && body["settles"].is_string()) settles = body["settles"].get<std::string>();
  const int64_t posted_at = now_ms();
  const std::string id = write_transaction(entries, body.value("description", ""), std::nullopt, posted_at, settles);
  json cleaned = json::array();
  for (const auto& e : entries) cleaned.push_back({{"account", e.account}, {"currency", e.currency}, {"amount", e.amount}});
  return {201, json{{"transaction_id", id}, {"posted_at", posted_at}, {"entries", cleaned}}};
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/transactions", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    auto [status, payload] = handle(body);
    if (status == 201) res.set_header("Location", "/transactions/" + payload["transaction_id"].get<std::string>());
    res.status = status;
    res.set_content(payload.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import time

EUR = "EUR"
BALANCED = {
    "description": "capture ch_1",
    "entries": [
        {"account": "cash:acquirer", "currency": EUR, "amount": 4999},
        {"account": "clearing:payments", "currency": EUR, "amount": -4999},
    ],
}


def _entries(*amounts, currency=EUR):
    accounts = ["cash:acquirer", "clearing:payments", "revenue:fees"]
    return [{"account": accounts[i], "currency": currency, "amount": a} for i, a in enumerate(amounts)]


def _api(ctx):
    m = ctx.load("ledger_api")
    m.written = []

    async def write_transaction(entries, description, event_id=None, posted_at=None, settles=None):
        m.written.append({"entries": entries, "description": description, "event_id": event_id, "posted_at": posted_at, "settles": settles})
        return f"tx-{len(m.written)}"

    m.write_transaction = write_transaction  # the journal is built in step 4
    return m


async def _post(c, body):
    return await c.post("/transactions", json=body)


async def check_route(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        r = await _post(c, BALANCED)
    assert r.status_code not in (404, 405), f"POST /transactions answered {r.status_code}: no handler is registered for it"
    assert r.status_code == 201, f"POST /transactions with a balanced body answered {r.status_code}: {r.text}"
    assert r.json().get("transaction_id") == "tx-1", f"the answer must carry the transaction id from write_transaction, got {r.json()}"


async def check_two_entries_balanced(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        for body, why in (
            ({"entries": _entries(4999)}, "a single entry"),
            ({"entries": []}, "no entries"),
            ({}, "a body without entries"),
            ({"entries": _entries(4999, -4000)}, "entries summing to 999"),
            ({"entries": _entries(4999, -4999, 1)}, "three entries summing to 1"),
        ):
            r = await _post(c, body)
            assert r.status_code == 422, f"{why} is not double entry: expected 422, got {r.status_code}"
            assert isinstance(r.json().get("error"), str) and r.json()["error"], f"a 422 must say why in {{'error': reason}}, got {r.json()}"
        assert m.written == [], "a rejected body must never reach write_transaction"
        r = await _post(c, {"entries": _entries(4999, -4850, -149)})
        assert r.status_code == 201, f"three entries netting to zero are a valid transaction: expected 201, got {r.status_code} {r.text}"


async def check_integer_amounts(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        for bad, why in ((49.99, "a float"), ("4999", "a string"), (True, "a boolean"), (0, "zero"), (None, "a missing amount")):
            body = {"entries": [{"account": "cash:acquirer", "currency": EUR, "amount": bad}, {"account": "clearing:payments", "currency": EUR, "amount": -4999}]}
            r = await _post(c, body)
            assert r.status_code == 422, f"amount {bad!r} ({why}) is not an integer in minor units: expected 422, got {r.status_code}"
        r = await _post(c, {"entries": _entries(4999, 0, -4999)})
        assert r.status_code == 422, f"an entry with amount 0 moves nothing and must be refused: expected 422, got {r.status_code}"
        assert m.written == [], "a rejected amount must never reach write_transaction"
        r = await _post(c, {"entries": _entries(-250000, 250000)})
        assert r.status_code == 201, f"a credit first and a debit second is fine: expected 201, got {r.status_code} {r.text}"


async def check_one_currency(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        mixed = {"entries": [{"account": "cash:acquirer", "currency": "EUR", "amount": 4999}, {"account": "clearing:payments", "currency": "USD", "amount": -4999}]}
        r = await _post(c, mixed)
        assert r.status_code == 422, f"EUR against USD cannot balance: expected 422, got {r.status_code}"
        for bad in ("eur", "EURO", "E1R", ""):
            r = await _post(c, {"entries": _entries(4999, -4999, currency=bad)})
            assert r.status_code == 422, f"currency {bad!r} does not match ^[A-Z]{{3}}$: expected 422, got {r.status_code}"
        r = await _post(c, {"entries": [{"account": "a", "amount": 1}, {"account": "b", "amount": -1}]})
        assert r.status_code == 422, f"entries without a currency: expected 422, got {r.status_code}"
        assert m.written == [], "a rejected currency must never reach write_transaction"
        r = await _post(c, {"entries": _entries(4999, -4999, currency="GBP")})
        assert r.status_code == 201, f"GBP on every entry is valid: expected 201, got {r.status_code} {r.text}"


async def check_created(ctx):
    m = _api(ctx)
    body = dict(BALANCED, settles="tx-0")
    body["entries"] = [dict(e, note="ignored") for e in body["entries"]]
    async with ctx.client(m.app) as c:
        r = await _post(c, body)
    assert r.status_code == 201, f"expected 201 Created, got {r.status_code} {r.text}"
    assert len(m.written) == 1, f"write_transaction must run exactly once, ran {len(m.written)} times"
    w = m.written[0]
    assert w["entries"] == BALANCED["entries"], f"write_transaction must get the cleaned entries (account, currency, amount only), got {w['entries']}"
    assert w["description"] == "capture ch_1", f"the description must be passed through, got {w['description']!r}"
    assert w["settles"] == "tx-0", f"the settles field must be passed through, got {w['settles']!r}"
    assert w["event_id"] is None, "an API-originated transaction has no event id"
    now = int(time.time() * 1000)
    assert isinstance(w["posted_at"], int) and abs(w["posted_at"] - now) < 5000, f"posted_at must be now in milliseconds, got {w['posted_at']!r}"
    payload = r.json()
    assert payload.get("transaction_id") == "tx-1", f"the body must carry the transaction id, got {payload}"
    assert payload.get("posted_at") == w["posted_at"], f"the body must carry the posted_at the journal got, got {payload}"
    assert payload.get("entries") == BALANCED["entries"], f"the body must echo the cleaned entries, got {payload.get('entries')}"
    assert r.headers.get("location") == "/transactions/tx-1", f"Location must be /transactions/tx-1, got {r.headers.get('location')!r}"
`,
  },
  debrief: `The validation is the product: a ledger that accepts one unbalanced transaction is no longer a ledger, because every balance computed from it is now suspect. The rules are cheap and run before any I/O — count, types, currency, sum — and each failure names the rule in the body so the publishing team can fix their producer. Integers in minor units are not pedantry: 0.1 + 0.2 ≠ 0.3 in a float, and a ledger that sums floats drifts by cents until it fails a clearing check. Stripe's post treats every event as a transaction between accounts of a fund flow; the entries here are the same idea with the account names flattened to strings. Real ledgers also type the accounts (asset, liability, clearing), restrict which accounts a producer may post to, and version the fund-flow definitions so a transaction can be re-validated against the rules that applied when it was posted.`,
};
