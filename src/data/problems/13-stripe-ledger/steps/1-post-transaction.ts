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
        typescript: {all: [/app\.post\(\s*['"]\/transactions['"]/]},
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
        typescript: {all: [/entries\.length\s*<\s*2/, /\.reduce\(/, /\b422\b/]},
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
        typescript: {
          all: [/typeof\s+amount\s*!==\s*['"]number['"]/, /Number\.isInteger\(\s*amount\s*\)/, /amount\s*===?\s*0/],
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
        typescript: {all: [/CURRENCY_RE\.test\(/, /currencies\.size\s*(!==?|>)\s*1/]},
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
        typescript: {all: [/(?<!\{)\bwriteTransaction\(/, /Location/], order: [/await writeTransaction\(/, /\b201\b/]},
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
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Entry, writeTransaction} from './ledger_writer'; // built in step 4: writes the rows, returns the transaction id

export const app = Fastify();

export const CURRENCY_RE = /^[A-Z]{3}$/;

/** What posting a body comes to: [status, payload]. */
export type Outcome = [number, Record<string, unknown>];

const nowMs = (): number => Date.now();

/** The reason \`body\` is not a double-entry transaction, or null when it is one. */
export function validate(body: Record<string, unknown>): string | null {
  const entries = body.entries;
  // TODO: at least two entries, each with a non-empty account
  // TODO: every amount a number that is an integer (not a string, not a boolean, not a float) and not 0: minor units
  // TODO: every currency matches CURRENCY_RE and all entries share one currency
  // TODO: debits and credits net to zero
  return null;
}

/** The outcome of posting \`body\`: [status, payload]. Step 2 wraps this in an idempotency key. */
export async function handle(body: Record<string, unknown>): Promise<Outcome> {
  // TODO: validate → 422 {error: reason}
  // TODO: writeTransaction(entries, description, {postedAt: nowMs(), settles: body.settles})
  // TODO: 201 {transaction_id, posted_at, entries}
  return [501, {error: 'not implemented'}];
}

app.post('/transactions', async (request, reply) => {
  const body = request.body;
  const [status, payload] = await handle(
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
  );
  // TODO: a Location header pointing at /transactions/{id} on 201
  return reply.code(status).send(payload);
});
`,
      solution: `import Fastify from 'fastify';

import {type Entry, writeTransaction} from './ledger_writer'; // built in step 4: writes the rows, returns the transaction id

export const app = Fastify();

export const CURRENCY_RE = /^[A-Z]{3}$/;

/** What posting a body comes to: [status, payload]. */
export type Outcome = [number, Record<string, unknown>];

const nowMs = (): number => Date.now();

/** The reason \`body\` is not a double-entry transaction, or null when it is one. */
export function validate(body: Record<string, unknown>): string | null {
  const entries = body.entries;
  if (!Array.isArray(entries) || entries.length < 2) return 'a transaction needs at least two entries';
  const currencies = new Set<string>();
  for (const entry of entries as Record<string, unknown>[]) {
    if (typeof entry !== 'object' || entry === null || typeof entry.account !== 'string' || entry.account === '') {
      return 'every entry needs an account';
    }
    const {amount, currency} = entry;
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return 'amount must be an integer in minor units';
    if (amount === 0) return 'an entry must move money: amount 0 is not allowed';
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) return 'currency must be a three-letter ISO code';
    currencies.add(currency);
  }
  if (currencies.size !== 1) return 'all entries of a transaction share one currency';
  if ((entries as Entry[]).reduce((sum, entry) => sum + entry.amount, 0) !== 0) {
    return 'debits and credits must net to zero';
  }
  return null;
}

/** The outcome of posting \`body\`: [status, payload]. Step 2 wraps this in an idempotency key. */
export async function handle(body: Record<string, unknown>): Promise<Outcome> {
  const reason = validate(body);
  if (reason !== null) return [422, {error: reason}];
  const entries: Entry[] = (body.entries as Entry[]).map(e => ({account: e.account, currency: e.currency, amount: e.amount}));
  const postedAt = nowMs();
  const transactionId = await writeTransaction(entries, String(body.description ?? ''), {
    postedAt,
    settles: typeof body.settles === 'string' ? body.settles : null,
  });
  return [201, {transaction_id: transactionId, posted_at: postedAt, entries}];
}

app.post('/transactions', async (request, reply) => {
  const body = request.body;
  const [status, payload] = await handle(
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
  );
  if (status === 201) reply.header('Location', \`/transactions/\${payload.transaction_id}\`);
  return reply.code(status).send(payload);
});
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
var writeTransaction = func(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
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
var writeTransaction = func(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
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


async def _api(ctx):
    """The learner's API in front of the real journal writer (step 4) and an empty ledger database."""
    await ctx.db.reset(SCHEMA)
    return ctx.load("ledger_api")


async def _post(c, body):
    try:
        return await c.post("/transactions", json=body)
    except Exception as exc:
        raise AssertionError(f"POST /transactions with {body} crashed the service with {type(exc).__name__}: {exc} — validate before writing: the journal only takes integer amounts in one currency")


async def _journal(ctx):
    transactions = await ctx.db.execute("SELECT * FROM transactions ORDER BY posted_at, id")
    entries = await ctx.db.execute("SELECT * FROM entries ORDER BY transaction_id, account")
    return transactions, entries


async def _assert_nothing_written(ctx, why):
    transactions, entries = await _journal(ctx)
    assert not transactions and not entries, f"{why}, yet the journal now holds {len(transactions)} transaction(s) and {len(entries)} entr(ies): {[(e['account'], e['amount']) for e in entries]}"


async def check_route(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        r = await _post(c, BALANCED)
    assert r.status_code not in (404, 405), f"POST /transactions answered {r.status_code}: no handler is registered for it"
    assert r.status_code == 201, f"POST /transactions with a balanced body answered {r.status_code}: {r.text}"
    transactions, _ = await _journal(ctx)
    assert len(transactions) == 1, f"a balanced POST must leave one transaction in the journal, found {len(transactions)}"
    assert r.json().get("transaction_id") == transactions[0]["id"], f"the answer must carry the id of the transaction written to the journal ({transactions[0]['id']}), got {r.json()}"


async def check_two_entries_balanced(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        for body, why in (
            ({"entries": _entries(4999)}, "a single entry"),
            ({"entries": []}, "no entries"),
            ({}, "a body without entries"),
            ({"entries": [{"currency": EUR, "amount": 4999}, {"account": "clearing:payments", "currency": EUR, "amount": -4999}]}, "an entry without an account"),
            ({"entries": _entries(4999, -4000)}, "entries summing to 999"),
            ({"entries": _entries(4999, -4999, 1)}, "three entries summing to 1"),
        ):
            r = await _post(c, body)
            assert r.status_code == 422, f"{why} is not double entry: expected 422, got {r.status_code}"
            assert isinstance(r.json().get("error"), str) and r.json()["error"], f"a 422 must say why in {{'error': reason}}, got {r.json()}"
        await _assert_nothing_written(ctx, "every request so far was refused")
        r = await _post(c, {"entries": _entries(4999, -4850, -149)})
        assert r.status_code == 201, f"three entries netting to zero are a valid transaction: expected 201, got {r.status_code} {r.text}"
    transactions, entries = await _journal(ctx)
    assert len(transactions) == 1 and len(entries) == 3, f"the valid transaction must leave one transaction and its three entries, found {len(transactions)} and {len(entries)}"
    assert sum(e["amount"] for e in entries) == 0, f"the journal's entries must net to zero, they sum to {sum(e['amount'] for e in entries)}"


async def check_integer_amounts(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        for bad, why in ((49.99, "a float"), (4999.0, "a whole float"), ("4999", "a string"), (True, "a boolean"), (0, "zero"), (None, "a missing amount")):
            body = {"entries": [{"account": "cash:acquirer", "currency": EUR, "amount": bad}, {"account": "clearing:payments", "currency": EUR, "amount": -4999}]}
            r = await _post(c, body)
            assert r.status_code == 422, f"amount {bad!r} ({why}) is not an integer in minor units: expected 422, got {r.status_code}"
        r = await _post(c, {"entries": [{"account": "cash:acquirer", "currency": EUR, "amount": 49.99}, {"account": "clearing:payments", "currency": EUR, "amount": -49.99}]})
        assert r.status_code == 422, f"49.99 against -49.99 nets to zero but is a float: expected 422, got {r.status_code}"
        r = await _post(c, {"entries": _entries(4999, 0, -4999)})
        assert r.status_code == 422, f"an entry with amount 0 moves nothing and must be refused: expected 422, got {r.status_code}"
        await _assert_nothing_written(ctx, "every amount so far was refused")
        r = await _post(c, {"entries": _entries(-250000, 250000)})
        assert r.status_code == 201, f"a credit first and a debit second is fine: expected 201, got {r.status_code} {r.text}"
    _, entries = await _journal(ctx)
    assert sorted(e["amount"] for e in entries) == [-250000, 250000], f"the journal must hold the integer amounts -250000 and 250000, holds {[e['amount'] for e in entries]}"


async def check_one_currency(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        mixed = {"entries": [{"account": "cash:acquirer", "currency": "EUR", "amount": 4999}, {"account": "clearing:payments", "currency": "USD", "amount": -4999}]}
        r = await _post(c, mixed)
        assert r.status_code == 422, f"EUR against USD cannot balance: expected 422, got {r.status_code}"
        for bad in ("eur", "EURO", "E1R", ""):
            r = await _post(c, {"entries": _entries(4999, -4999, currency=bad)})
            assert r.status_code == 422, f"currency {bad!r} does not match ^[A-Z]{{3}}$: expected 422, got {r.status_code}"
        r = await _post(c, {"entries": [{"account": "a", "amount": 1}, {"account": "b", "amount": -1}]})
        assert r.status_code == 422, f"entries without a currency: expected 422, got {r.status_code}"
        await _assert_nothing_written(ctx, "every currency so far was refused")
        r = await _post(c, {"entries": _entries(4999, -4999, currency="GBP")})
        assert r.status_code == 201, f"GBP on every entry is valid: expected 201, got {r.status_code} {r.text}"
    _, entries = await _journal(ctx)
    assert [e["currency"] for e in entries] == ["GBP", "GBP"], f"the journal must hold two GBP entries, holds {[e['currency'] for e in entries]}"


async def check_created(ctx):
    m = await _api(ctx)
    body = dict(BALANCED, settles="tx-0")
    body["entries"] = [dict(e, note="ignored") for e in body["entries"]]
    async with ctx.client(m.app) as c:
        r = await _post(c, body)
    assert r.status_code == 201, f"expected 201 Created, got {r.status_code} {r.text}"
    transactions, entries = await _journal(ctx)
    assert len(transactions) == 1, f"one valid POST must write exactly one transaction, the journal holds {len(transactions)}"
    t = transactions[0]
    assert len(entries) == 2, f"the transaction must have its two entries in the journal, found {len(entries)}"
    stored = sorted((e["account"], e["currency"], e["amount"]) for e in entries)
    assert stored == [("cash:acquirer", "EUR", 4999), ("clearing:payments", "EUR", -4999)], f"the journal holds the entries {stored}"
    assert t["description"] == "capture ch_1", f"the description must be passed through to the journal, it holds {t['description']!r}"
    assert t["settles"] == "tx-0", f"the settles field must be passed through to the journal, it holds {t['settles']!r}"
    assert t["event_id"] is None, f"an API-originated transaction has no event id, the journal holds {t['event_id']!r}"
    now = int(time.time() * 1000)
    assert abs(t["posted_at"] - now) < 5000, f"posted_at must be now in milliseconds ({now}), the journal holds {t['posted_at']}"
    payload = r.json()
    assert payload.get("transaction_id") == t["id"], f"the body must carry the journal's transaction id {t['id']}, got {payload}"
    assert payload.get("posted_at") == t["posted_at"], f"the body must carry the posted_at the journal got ({t['posted_at']}), got {payload.get('posted_at')!r}"
    assert payload.get("entries") == BALANCED["entries"], f"the body must echo the cleaned entries (account, currency, amount only), got {payload.get('entries')}"
    assert r.headers.get("location") == f"/transactions/{t['id']}", f"Location must be /transactions/{t['id']}, got {r.headers.get('location')!r}"
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

const EUR = 'EUR';
const BALANCED = {
  description: 'capture ch_1',
  entries: [
    {account: 'cash:acquirer', currency: EUR, amount: 4999},
    {account: 'clearing:payments', currency: EUR, amount: -4999},
  ],
};

function entriesOf(amounts: number[], currency = EUR) {
  const accounts = ['cash:acquirer', 'clearing:payments', 'revenue:fees'];
  return amounts.map((amount, i) => ({account: accounts[i], currency, amount}));
}

/** The learner's API in front of the real journal writer (step 4) and an empty ledger database. */
async function api(ctx) {
  await ctx.db.reset(SCHEMA);
  return ctx.load('ledger_api');
}

async function post(c, body) {
  const r = await c.post('/transactions', {json: body});
  if (r.status === 500) {
    assert.fail(\`POST /transactions with \${JSON.stringify(body)} crashed the service: \${r.text} — validate before writing: the journal only takes integer amounts in one currency\`);
  }
  return r;
}

async function journal(ctx) {
  const transactions = await ctx.db.execute('SELECT * FROM transactions ORDER BY posted_at, id');
  const entries = await ctx.db.execute('SELECT * FROM entries ORDER BY transaction_id, account');
  return {transactions, entries};
}

async function assertNothingWritten(ctx, why: string) {
  const {transactions, entries} = await journal(ctx);
  assert(transactions.length === 0 && entries.length === 0, \`\${why}, yet the journal now holds \${transactions.length} transaction(s) and \${entries.length} entr(ies): \${JSON.stringify(entries.map(e => [e.account, Number(e.amount)]))}\`);
}

export async function check_route(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  const r = await post(c, BALANCED);
  assert(![404, 405].includes(r.status), \`POST /transactions answered \${r.status}: no handler is registered for it\`);
  assert.equal(r.status, 201, \`POST /transactions with a balanced body answered \${r.status}: \${r.text}\`);
  const {transactions} = await journal(ctx);
  assert.equal(transactions.length, 1, \`a balanced POST must leave one transaction in the journal, found \${transactions.length}\`);
  assert.equal(r.json()?.transaction_id, transactions[0].id, \`the answer must carry the id of the transaction written to the journal (\${transactions[0].id}), got \${r.text}\`);
}

export async function check_two_entries_balanced(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  const cases: [unknown, string][] = [
    [{entries: entriesOf([4999])}, 'a single entry'],
    [{entries: []}, 'no entries'],
    [{}, 'a body without entries'],
    [{entries: [{currency: EUR, amount: 4999}, {account: 'clearing:payments', currency: EUR, amount: -4999}]}, 'an entry without an account'],
    [{entries: entriesOf([4999, -4000])}, 'entries summing to 999'],
    [{entries: entriesOf([4999, -4999, 1])}, 'three entries summing to 1'],
  ];
  for (const [body, why] of cases) {
    const r = await post(c, body);
    assert.equal(r.status, 422, \`\${why} is not double entry: expected 422, got \${r.status}\`);
    const error = r.json()?.error;
    assert(typeof error === 'string' && error !== '', \`a 422 must say why in {error: reason}, got \${r.text}\`);
  }
  await assertNothingWritten(ctx, 'every request so far was refused');
  const r = await post(c, {entries: entriesOf([4999, -4850, -149])});
  assert.equal(r.status, 201, \`three entries netting to zero are a valid transaction: expected 201, got \${r.status} \${r.text}\`);
  const {transactions, entries} = await journal(ctx);
  assert(transactions.length === 1 && entries.length === 3, \`the valid transaction must leave one transaction and its three entries, found \${transactions.length} and \${entries.length}\`);
  const total = entries.reduce((sum, e) => sum + Number(e.amount), 0);
  assert.equal(total, 0, \`the journal's entries must net to zero, they sum to \${total}\`);
}

export async function check_integer_amounts(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  const cases: [unknown, string][] = [
    [49.99, 'a float'],
    ['4999', 'a string'],
    [true, 'a boolean'],
    [0, 'zero'],
    [null, 'a missing amount'],
  ];
  for (const [bad, why] of cases) {
    const body = {entries: [{account: 'cash:acquirer', currency: EUR, amount: bad}, {account: 'clearing:payments', currency: EUR, amount: -4999}]};
    const r = await post(c, body);
    assert.equal(r.status, 422, \`amount \${JSON.stringify(bad)} (\${why}) is not an integer in minor units: expected 422, got \${r.status}\`);
  }
  let r = await post(c, {entries: [{account: 'cash:acquirer', currency: EUR, amount: 49.99}, {account: 'clearing:payments', currency: EUR, amount: -49.99}]});
  assert.equal(r.status, 422, \`49.99 against -49.99 nets to zero but is a float: expected 422, got \${r.status}\`);
  r = await post(c, {entries: entriesOf([4999, 0, -4999])});
  assert.equal(r.status, 422, \`an entry with amount 0 moves nothing and must be refused: expected 422, got \${r.status}\`);
  await assertNothingWritten(ctx, 'every amount so far was refused');
  r = await post(c, {entries: entriesOf([-250000, 250000])});
  assert.equal(r.status, 201, \`a credit first and a debit second is fine: expected 201, got \${r.status} \${r.text}\`);
  const {entries} = await journal(ctx);
  const amounts = entries.map(e => Number(e.amount)).sort((a, b) => a - b);
  assert.deepEqual(amounts, [-250000, 250000], \`the journal must hold the integer amounts -250000 and 250000, holds \${JSON.stringify(amounts)}\`);
}

export async function check_one_currency(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  const mixed = {entries: [{account: 'cash:acquirer', currency: 'EUR', amount: 4999}, {account: 'clearing:payments', currency: 'USD', amount: -4999}]};
  let r = await post(c, mixed);
  assert.equal(r.status, 422, \`EUR against USD cannot balance: expected 422, got \${r.status}\`);
  for (const bad of ['eur', 'EURO', 'E1R', '']) {
    r = await post(c, {entries: entriesOf([4999, -4999], bad)});
    assert.equal(r.status, 422, \`currency \${JSON.stringify(bad)} does not match ^[A-Z]{3}$: expected 422, got \${r.status}\`);
  }
  r = await post(c, {entries: [{account: 'a', amount: 1}, {account: 'b', amount: -1}]});
  assert.equal(r.status, 422, \`entries without a currency: expected 422, got \${r.status}\`);
  await assertNothingWritten(ctx, 'every currency so far was refused');
  r = await post(c, {entries: entriesOf([4999, -4999], 'GBP')});
  assert.equal(r.status, 201, \`GBP on every entry is valid: expected 201, got \${r.status} \${r.text}\`);
  const {entries} = await journal(ctx);
  assert.deepEqual(entries.map(e => e.currency), ['GBP', 'GBP'], \`the journal must hold two GBP entries, holds \${JSON.stringify(entries.map(e => e.currency))}\`);
}

export async function check_created(ctx) {
  const m = await api(ctx);
  const body = {...BALANCED, settles: 'tx-0', entries: BALANCED.entries.map(e => ({...e, note: 'ignored'}))};
  const r = await post(ctx.client(m.app), body);
  assert.equal(r.status, 201, \`expected 201 Created, got \${r.status} \${r.text}\`);
  const {transactions, entries} = await journal(ctx);
  assert.equal(transactions.length, 1, \`one valid POST must write exactly one transaction, the journal holds \${transactions.length}\`);
  const t = transactions[0];
  assert.equal(entries.length, 2, \`the transaction must have its two entries in the journal, found \${entries.length}\`);
  const stored = entries.map(e => [e.account, e.currency, Number(e.amount)]).sort();
  assert.deepEqual(stored, [['cash:acquirer', 'EUR', 4999], ['clearing:payments', 'EUR', -4999]], \`the journal holds the entries \${JSON.stringify(stored)}\`);
  assert.equal(t.description, 'capture ch_1', \`the description must be passed through to the journal, it holds \${JSON.stringify(t.description)}\`);
  assert.equal(t.settles, 'tx-0', \`the settles field must be passed through to the journal, it holds \${JSON.stringify(t.settles)}\`);
  assert.equal(t.event_id, null, \`an API-originated transaction has no event id, the journal holds \${JSON.stringify(t.event_id)}\`);
  const now = Date.now();
  assert(Math.abs(Number(t.posted_at) - now) < 5000, \`posted_at must be now in milliseconds (\${now}), the journal holds \${t.posted_at}\`);
  const payload = r.json();
  assert.equal(payload?.transaction_id, t.id, \`the body must carry the journal's transaction id \${t.id}, got \${r.text}\`);
  assert.equal(payload?.posted_at, Number(t.posted_at), \`the body must carry the posted_at the journal got (\${t.posted_at}), got \${JSON.stringify(payload?.posted_at)}\`);
  assert.deepEqual(payload?.entries, BALANCED.entries, \`the body must echo the cleaned entries (account, currency, amount only), got \${JSON.stringify(payload?.entries)}\`);
  assert.equal(r.headers['location'], \`/transactions/\${t.id}\`, \`Location must be /transactions/\${t.id}, got \${JSON.stringify(r.headers['location'])}\`);
}
`,
    go: `package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"

	ledgerdb "ledger/db"
	"leetbuild/harness"
)

const ledgerSchema = \`
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

const ledgerEUR = "EUR"

func ledgerBalanced() map[string]any {
	return map[string]any{
		"description": "capture ch_1",
		"entries": []any{
			map[string]any{"account": "cash:acquirer", "currency": ledgerEUR, "amount": 4999},
			map[string]any{"account": "clearing:payments", "currency": ledgerEUR, "amount": -4999},
		},
	}
}

func ledgerEntriesOf(currency string, amounts ...any) []any {
	accounts := []string{"cash:acquirer", "clearing:payments", "revenue:fees"}
	out := []any{}
	for i, amount := range amounts {
		out = append(out, map[string]any{"account": accounts[i], "currency": currency, "amount": amount})
	}
	return out
}

// ledgerJournalWrite is the journal writer of step 4 (ledger_writer.go): one database transaction,
// insert-or-skip on the event id, the entries at the transaction's posted_at.
func ledgerJournalWrite(ctx context.Context, entries []Entry, description string, eventID *string, postedAt int64, settles *string) (string, error) {
	transactionID := uuid.NewString()
	if postedAt == 0 {
		postedAt = time.Now().UnixMilli()
	}
	duplicate := false
	err := ledgerdb.Transaction(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx,
			"INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING",
			transactionID, eventID, description, settles, postedAt)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			duplicate = true
			return nil
		}
		for _, e := range entries {
			if _, err := tx.ExecContext(ctx,
				"INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES ($1, $2, $3, $4, $5)",
				transactionID, e.Account, e.Currency, e.Amount, postedAt); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil || duplicate {
		return "", err
	}
	return transactionID, nil
}

// ledgerAPI is the learner's API in front of the real journal writer (step 4) and an empty ledger database.
func ledgerAPI(ctx *harness.Ctx) *harness.HTTP {
	ctx.DB.Reset(ledgerSchema)
	writeTransaction = ledgerJournalWrite
	return ctx.Main(main).HTTP()
}

func ledgerJSON(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

func ledgerPost(ctx *harness.Ctx, c *harness.HTTP, body any) (r *harness.Response) {
	defer func() {
		if rec := recover(); rec != nil {
			ctx.Fatalf("POST /transactions with %s crashed the service with %v — validate before writing: the journal only takes integer amounts in one currency", ledgerJSON(body), rec)
		}
	}()
	r = c.Post("/transactions", body)
	if r.Status == 500 {
		ctx.Fatalf("POST /transactions with %s crashed the service: %s — validate before writing: the journal only takes integer amounts in one currency", ledgerJSON(body), r.Text())
	}
	return r
}

func ledgerBody(r *harness.Response) map[string]any {
	var body map[string]any
	r.Decode(&body)
	return body
}

func ledgerJournal(ctx *harness.Ctx) ([]harness.Row, []harness.Row) {
	return ctx.DB.Query("SELECT * FROM transactions ORDER BY posted_at, id"), ctx.DB.Query("SELECT * FROM entries ORDER BY transaction_id, account")
}

func ledgerAssertNothingWritten(ctx *harness.Ctx, why string) {
	transactions, entries := ledgerJournal(ctx)
	pairs := [][2]any{}
	for _, e := range entries {
		pairs = append(pairs, [2]any{e["account"], e["amount"]})
	}
	ctx.Assert(len(transactions) == 0 && len(entries) == 0, "%s, yet the journal now holds %d transaction(s) and %d entr(ies): %v", why, len(transactions), len(entries), pairs)
}

func CheckRoute(ctx *harness.Ctx) {
	c := ledgerAPI(ctx)
	r := ledgerPost(ctx, c, ledgerBalanced())
	ctx.Assert(r.Status != 404 && r.Status != 405, "POST /transactions answered %d: no handler is registered for it", r.Status)
	ctx.Equal(r.Status, 201, "POST /transactions with a balanced body answered %s", r.Text())
	transactions, _ := ledgerJournal(ctx)
	ctx.Equal(len(transactions), 1, "a balanced POST must leave one transaction in the journal")
	ctx.Equal(ledgerBody(r)["transaction_id"], transactions[0]["id"], "the answer must carry the id of the transaction written to the journal (answer %s)", r.Text())
}

func CheckTwoEntriesBalanced(ctx *harness.Ctx) {
	c := ledgerAPI(ctx)
	cases := []struct {
		body map[string]any
		why  string
	}{
		{map[string]any{"entries": ledgerEntriesOf(ledgerEUR, 4999)}, "a single entry"},
		{map[string]any{"entries": []any{}}, "no entries"},
		{map[string]any{}, "a body without entries"},
		{map[string]any{"entries": []any{
			map[string]any{"currency": ledgerEUR, "amount": 4999},
			map[string]any{"account": "clearing:payments", "currency": ledgerEUR, "amount": -4999},
		}}, "an entry without an account"},
		{map[string]any{"entries": ledgerEntriesOf(ledgerEUR, 4999, -4000)}, "entries summing to 999"},
		{map[string]any{"entries": ledgerEntriesOf(ledgerEUR, 4999, -4999, 1)}, "three entries summing to 1"},
	}
	for _, tc := range cases {
		r := ledgerPost(ctx, c, tc.body)
		ctx.Equal(r.Status, 422, "%s is not double entry", tc.why)
		reason, _ := ledgerBody(r)["error"].(string)
		ctx.Assert(reason != "", "a 422 must say why in {error: reason}, got %s", r.Text())
	}
	ledgerAssertNothingWritten(ctx, "every request so far was refused")
	r := ledgerPost(ctx, c, map[string]any{"entries": ledgerEntriesOf(ledgerEUR, 4999, -4850, -149)})
	ctx.Equal(r.Status, 201, "three entries netting to zero are a valid transaction (answer %s)", r.Text())
	transactions, entries := ledgerJournal(ctx)
	ctx.Assert(len(transactions) == 1 && len(entries) == 3, "the valid transaction must leave one transaction and its three entries, found %d and %d", len(transactions), len(entries))
	var total int64
	for _, e := range entries {
		amount, _ := e["amount"].(int64)
		total += amount
	}
	ctx.Equal(total, 0, "the journal's entries must net to zero")
}

func CheckIntegerAmounts(ctx *harness.Ctx) {
	c := ledgerAPI(ctx)
	cases := []struct {
		bad any
		why string
	}{{49.99, "a float"}, {"4999", "a string"}, {true, "a boolean"}, {0, "zero"}, {nil, "a missing amount"}}
	for _, tc := range cases {
		body := map[string]any{"entries": []any{
			map[string]any{"account": "cash:acquirer", "currency": ledgerEUR, "amount": tc.bad},
			map[string]any{"account": "clearing:payments", "currency": ledgerEUR, "amount": -4999},
		}}
		r := ledgerPost(ctx, c, body)
		ctx.Equal(r.Status, 422, "amount %s (%s) is not an integer in minor units", ledgerJSON(tc.bad), tc.why)
	}
	r := ledgerPost(ctx, c, map[string]any{"entries": []any{
		map[string]any{"account": "cash:acquirer", "currency": ledgerEUR, "amount": 49.99},
		map[string]any{"account": "clearing:payments", "currency": ledgerEUR, "amount": -49.99},
	}})
	ctx.Equal(r.Status, 422, "49.99 against -49.99 nets to zero but is a float")
	r = ledgerPost(ctx, c, map[string]any{"entries": ledgerEntriesOf(ledgerEUR, 4999, 0, -4999)})
	ctx.Equal(r.Status, 422, "an entry with amount 0 moves nothing and must be refused")
	ledgerAssertNothingWritten(ctx, "every amount so far was refused")
	r = ledgerPost(ctx, c, map[string]any{"entries": ledgerEntriesOf(ledgerEUR, -250000, 250000)})
	ctx.Equal(r.Status, 201, "a credit first and a debit second is fine (answer %s)", r.Text())
	_, entries := ledgerJournal(ctx)
	amounts := []int64{}
	for _, e := range entries {
		amount, _ := e["amount"].(int64)
		amounts = append(amounts, amount)
	}
	sort.Slice(amounts, func(i, j int) bool { return amounts[i] < amounts[j] })
	ctx.Equal(amounts, []int64{-250000, 250000}, "the journal must hold the integer amounts -250000 and 250000")
}

func CheckOneCurrency(ctx *harness.Ctx) {
	c := ledgerAPI(ctx)
	mixed := map[string]any{"entries": []any{
		map[string]any{"account": "cash:acquirer", "currency": "EUR", "amount": 4999},
		map[string]any{"account": "clearing:payments", "currency": "USD", "amount": -4999},
	}}
	r := ledgerPost(ctx, c, mixed)
	ctx.Equal(r.Status, 422, "EUR against USD cannot balance")
	for _, bad := range []string{"eur", "EURO", "E1R", ""} {
		r = ledgerPost(ctx, c, map[string]any{"entries": ledgerEntriesOf(bad, 4999, -4999)})
		ctx.Equal(r.Status, 422, "currency %q does not match ^[A-Z]{3}$", bad)
	}
	r = ledgerPost(ctx, c, map[string]any{"entries": []any{
		map[string]any{"account": "a", "amount": 1},
		map[string]any{"account": "b", "amount": -1},
	}})
	ctx.Equal(r.Status, 422, "entries without a currency")
	ledgerAssertNothingWritten(ctx, "every currency so far was refused")
	r = ledgerPost(ctx, c, map[string]any{"entries": ledgerEntriesOf("GBP", 4999, -4999)})
	ctx.Equal(r.Status, 201, "GBP on every entry is valid (answer %s)", r.Text())
	_, entries := ledgerJournal(ctx)
	currencies := []string{}
	for _, e := range entries {
		currency, _ := e["currency"].(string)
		currencies = append(currencies, currency)
	}
	ctx.Equal(currencies, []string{"GBP", "GBP"}, "the journal must hold two GBP entries")
}

func CheckCreated(ctx *harness.Ctx) {
	c := ledgerAPI(ctx)
	body := ledgerBalanced()
	body["settles"] = "tx-0"
	noted := []any{}
	for _, e := range body["entries"].([]any) {
		entry := map[string]any{"note": "ignored"}
		for k, v := range e.(map[string]any) {
			entry[k] = v
		}
		noted = append(noted, entry)
	}
	body["entries"] = noted
	r := ledgerPost(ctx, c, body)
	ctx.Equal(r.Status, 201, "a valid body must be answered 201 Created (answer %s)", r.Text())
	transactions, entries := ledgerJournal(ctx)
	ctx.Equal(len(transactions), 1, "one valid POST must write exactly one transaction")
	t := transactions[0]
	ctx.Equal(len(entries), 2, "the transaction must have its two entries in the journal")
	stored := [][3]any{}
	for _, e := range entries {
		stored = append(stored, [3]any{e["account"], e["currency"], e["amount"]})
	}
	sort.Slice(stored, func(i, j int) bool { return fmt.Sprint(stored[i]) < fmt.Sprint(stored[j]) })
	ctx.Equal(stored, [][3]any{{"cash:acquirer", "EUR", int64(4999)}, {"clearing:payments", "EUR", int64(-4999)}}, "the journal holds the entries")
	ctx.Equal(t["description"], "capture ch_1", "the description must be passed through to the journal")
	ctx.Equal(t["settles"], "tx-0", "the settles field must be passed through to the journal")
	ctx.Equal(t["event_id"], nil, "an API-originated transaction has no event id")
	now := time.Now().UnixMilli()
	postedAt, _ := t["posted_at"].(int64)
	ctx.Assert(postedAt-now < 5000 && now-postedAt < 5000, "posted_at must be now in milliseconds (%d), the journal holds %d", now, postedAt)
	payload := ledgerBody(r)
	ctx.Equal(payload["transaction_id"], t["id"], "the body must carry the journal's transaction id (answer %s)", r.Text())
	ctx.Equal(payload["posted_at"], t["posted_at"], "the body must carry the posted_at the journal got")
	ctx.Equal(payload["entries"], []any{
		map[string]any{"account": "cash:acquirer", "currency": "EUR", "amount": float64(4999)},
		map[string]any{"account": "clearing:payments", "currency": "EUR", "amount": float64(-4999)},
	}, "the body must echo the cleaned entries (account, currency, amount only)")
	ctx.Equal(r.Header.Get("Location"), fmt.Sprintf("/transactions/%v", t["id"]), "Location must point at the transaction")
}
`,
  },
  debrief: `The validation is the product: a ledger that accepts one unbalanced transaction is no longer a ledger, because every balance computed from it is now suspect. The rules are cheap and run before any I/O — count, types, currency, sum — and each failure names the rule in the body so the publishing team can fix their producer. Integers in minor units are not pedantry: 0.1 + 0.2 ≠ 0.3 in a float, and a ledger that sums floats drifts by cents until it fails a clearing check. Stripe's post treats every event as a transaction between accounts of a fund flow; the entries here are the same idea with the account names flattened to strings. Real ledgers also type the accounts (asset, liability, clearing), restrict which accounts a producer may post to, and version the fund-flow definitions so a transaction can be re-validated against the rules that applied when it was posted.`,
};
