import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/tenants/{t}/spend: the spend everyone trusts',
  concept: 'http',
  file: 'read',
  focus: ['client', 'meter', 'redis', 'limiter'],
  task: `## Task

The starter is a plausible model-generated draft: a spend number comes back and the dashboard shows
it. It authorizes nothing, it reads a table that trails reality, and it rounds every request away.
Find the flaws, fix them, and prove the fix.

Implement \`GET /v1/tenants/{tenant}/spend\`, the read engineering and finance both quote:

- The caller is authenticated by \`X-Tenant-Id\` and may only read **its own** tenant: a request for
  another tenant's spend is **403**. The draft serves whatever tenant the path names, so any caller
  can read any ledger.
- The number is reconstructed from the **same Redis counters the limiter enforces** —
  \`meter:{tenant}:{bucket}\`, the current window's \`input_tokens\` and \`output_tokens\`. The draft
  sums an analytics table that trails by minutes, so the spend it shows and the budget the platform
  blocks on can differ by exactly the traffic that matters.
- The response carries the window, the tokens, \`spend_micros\`, \`spend_usd\`, the tenant's
  \`budget_micros\`, the \`remaining_micros\`, and the \`statement_version\` the numbers were priced
  under. The version comes from server config (\`STATEMENT_VERSION\`), not from the request and not
  from a literal typed into the handler.
- Costs stay **integer micro-dollars** all the way to the statement, and rounding to cents happens
  **once, on the total**: \`round(spend_micros / MICROS_PER_USD, 2)\`. The draft rounds each row to
  four decimals, so a thousand requests that each cost 0.00004 bill as a thousand zeroes.
- A tenant that is over budget reports \`remaining_micros = 0\` rather than a negative remainder —
  the limiter is already refusing requests, and the read should say the same thing.

**Failure mode the checks target.** Every one of these is a reconciliation bug rather than a display
bug: an unauthorized read, a number that disagrees with the limit that was enforced, a rate applied
after per-request rounding, and a statement version nobody can trace. The rounding flaw is the
subtle one — it looks like tidiness, and on a high-volume tenant it makes a real invoice round to
zero.`,
  sequence: {
    participants: ['Client', 'Cost Meter', 'Redis', 'Budget limiter'],
    messages: [
      {from: 'Client', to: 'Cost Meter', label: 'GET /v1/tenants/acme/spend · X-Tenant-Id', kind: 'sync'},
      {from: 'Cost Meter', to: 'Cost Meter', label: 'caller ≠ path tenant → 403', kind: 'sync'},
      {from: 'Cost Meter', to: 'Redis', label: 'HMGET meter:acme:{bucket} input_tokens output_tokens', kind: 'sync'},
      {from: 'Redis', to: 'Cost Meter', label: 'the same counters the limiter enforces', kind: 'reply'},
      {from: 'Budget limiter', to: 'Redis', label: 'same window key before admitting a request', kind: 'sync'},
      {from: 'Cost Meter', to: 'Cost Meter', label: 'micros → budget → round once at statement level', kind: 'sync'},
      {from: 'Cost Meter', to: 'Client', label: '{spend, remaining, statement_version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'tenant-403',
      title: 'Refuses a cross-tenant read',
      detail:
        'The authenticated `X-Tenant-Id` must match the tenant in the path; a mismatch is **403**. The draft serves any tenant id it is handed, so one customer can read another’s spend.',
      match: {
        python: {all: [/X-Tenant-Id/, /403/]},
        typescript: {all: [/x-tenant-id/, /403/]},
        go: {all: [/X-Tenant-Id/, /StatusForbidden/]},
        scala: {all: [/caller\s*!=\s*tenant/, /403/]},
        cpp: {all: [/X-Tenant-Id/, /res\.status\s*=\s*403/]},
      },
    },
    {
      id: 'counter-source',
      title: 'Reads the counters the limiter enforces',
      detail:
        'Spend is reconstructed from `meter:{tenant}:{bucket}` in Redis — the same hash the budget limiter checks. The draft sums an analytics table that trails by minutes, so the number it reports is not the number that was enforced.',
      match: {
        python: {all: [/meter:/, /hmget\(|hgetall\(/]},
        typescript: {all: [/meter:/, /hmget\(/]},
        go: {all: [/meter:/, /HMGet\(/]},
        scala: {all: [/meter:/, /hmget\(/]},
        cpp: {all: [/meter:/, /hmget\(/]},
      },
    },
    {
      id: 'remaining-budget',
      title: 'Reports the remaining budget the limiter compares',
      detail:
        'The response carries the tenant’s budget and what is left of it, so the number on the dashboard is the one a request is refused against. The draft reports no budget at all, leaving the caller to guess why a call started failing.',
      match: {
        python: {all: [/BUDGET_MICROS/, /remaining/]},
        typescript: {all: [/BUDGET_MICROS/, /remaining/]},
        go: {all: [/budgetMicros/, /remaining/]},
        scala: {all: [/BudgetMicros/, /remaining/]},
        cpp: {all: [/kBudgetMicros/, /remaining/]},
      },
    },
    {
      id: 'statement-version',
      title: 'Stamps the statement version from config',
      detail:
        'Every response carries the `statement_version` the numbers were priced under, and it comes from a server-side constant rather than a literal in the handler or a value the caller sent. Without it nobody can explain an old invoice.',
      match: {
        python: {all: [/statement_version/, /STATEMENT_VERSION/]},
        typescript: {all: [/statement_version/, /STATEMENT_VERSION/]},
        go: {all: [/statement_version/, /statementVersion/]},
        scala: {all: [/statement_version/, /StatementVersion/]},
        cpp: {all: [/statement_version/, /kStatementVersion/]},
      },
    },
    {
      id: 'statement-rounding',
      title: 'Rounds once, at statement level',
      detail:
        'Per-request costs stay integer micro-dollars and the only rounding is on the statement total. The draft rounds each analytics row to four decimals, so a thousand requests that each cost a fraction of a cent are billed as zero.',
      match: {
        python: {all: [/spend_micros/, /round\(/], none: [/round\(\s*row\[/]},
        typescript: {all: [/spend_micros/, /Math\.round\(|toFixed\(/], none: [/Math\.round\(row\./]},
        go: {all: [/spendMicros/, /math\.Round\(/], none: [/math\.Round\(row\./]},
        scala: {all: [/spendMicros/, /BigDecimal/], none: [/Math\.round\(row\./]},
        cpp: {all: [/spend_micros/, /std::round\(/], none: [/std::round\(row\./]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

analytics = AnalyticsTable()


@app.get("/v1/tenants/{tenant}/spend")
def read_spend(tenant: str) -> dict:
    # TODO: authorize the caller against the tenant, read the current window from the meter
    # counters instead of the analytics table, compare against the enforced budget, stamp the
    # statement version from config, and round once at statement level instead of per request.
    total = 0.0
    for row in analytics.spend_rows(tenant):
        total += round(row["cost_usd"], 4)
    return {"tenant": tenant, "spend_usd": total, "statement_version": "v1"}
`,
      solution: `import time

import redis
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 3600
MICROS_PER_USD = 1_000_000
BUDGET_MICROS = 5_000_000
STATEMENT_VERSION = "2026-10-01"

# The window's effective rate, in micro-dollars per 1K tokens, from the pricing table.
RATE_INPUT_MICROS_PER_1K = 3_000
RATE_OUTPUT_MICROS_PER_1K = 12_000


def meter_key(tenant: str, bucket: int) -> str:
    """The same hash the budget limiter checks before it admits a request."""
    return f"meter:{tenant}:{bucket}"


def spend_micros(input_tokens: int, output_tokens: int) -> int:
    """Integer micro-dollars; rounding to cents happens once, on the statement total."""
    return (input_tokens * RATE_INPUT_MICROS_PER_1K + output_tokens * RATE_OUTPUT_MICROS_PER_1K) // 1000


@app.get("/v1/tenants/{tenant}/spend")
def read_spend(tenant: str, caller: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if caller is None or caller == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if caller != tenant:
        raise HTTPException(status_code=403, detail="forbidden")

    bucket = int(time.time() // WINDOW_S)
    counters = r.hmget(meter_key(tenant, bucket), "input_tokens", "output_tokens")
    input_tokens, output_tokens = (int(value or 0) for value in counters)
    total_micros = spend_micros(input_tokens, output_tokens)
    return {
        "tenant": tenant,
        "window_bucket": bucket,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "spend_micros": total_micros,
        "spend_usd": round(total_micros / MICROS_PER_USD, 2),
        "budget_micros": BUDGET_MICROS,
        "remaining_micros": max(BUDGET_MICROS - total_micros, 0),
        "statement_version": STATEMENT_VERSION,
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/tenants/{t}/spend: a model-generated draft that trusts the path and rounds per row. */
import Fastify from 'fastify';

export const app = Fastify();

interface SpendRow {
  cost_usd: number;
}

app.get('/v1/tenants/:tenant/spend', async (request, reply) => {
  // TODO: authorize the caller against the tenant, read the current window from the meter
  // counters instead of the analytics table, compare against the enforced budget, stamp the
  // statement version from config, and round once at statement level instead of per request.
  const {tenant} = request.params as {tenant: string};
  let total = 0;
  for (const row of (await analyticsRows(tenant)) as SpendRow[]) {
    total += Math.round(row.cost_usd * 10_000) / 10_000;
  }
  return reply.code(200).send({tenant, spend_usd: total, statement_version: 'v1'});
});

async function analyticsRows(tenant: string): Promise<SpendRow[]> {
  throw new Error(\`analytics unavailable for \${tenant}\`);
}
`,
      solution: `/** GET /v1/tenants/{t}/spend: tenant-scoped, priced from the limiter's own counters. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 3600;
const MICROS_PER_USD = 1_000_000;
const BUDGET_MICROS = 5_000_000;
const STATEMENT_VERSION = '2026-10-01';

// The window's effective rate, in micro-dollars per 1K tokens, from the pricing table.
const RATE_INPUT_MICROS_PER_1K = 3_000;
const RATE_OUTPUT_MICROS_PER_1K = 12_000;

/** The same hash the budget limiter checks before it admits a request. */
function meterKey(tenant: string, bucket: number): string {
  return \`meter:\${tenant}:\${bucket}\`;
}

/** Integer micro-dollars; rounding to cents happens once, on the statement total. */
function spendMicros(inputTokens: number, outputTokens: number): number {
  return Math.floor((inputTokens * RATE_INPUT_MICROS_PER_1K + outputTokens * RATE_OUTPUT_MICROS_PER_1K) / 1000);
}

app.get('/v1/tenants/:tenant/spend', async (request, reply) => {
  const caller = request.headers['x-tenant-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {tenant} = request.params as {tenant: string};
  if (caller !== tenant) return reply.code(403).send({error: 'forbidden'});

  const bucket = Math.floor(Date.now() / 1000 / WINDOW_S);
  const counters = await r.hmget(meterKey(tenant, bucket), 'input_tokens', 'output_tokens');
  const inputTokens = Number(counters[0] ?? 0);
  const outputTokens = Number(counters[1] ?? 0);
  const totalMicros = spendMicros(inputTokens, outputTokens);
  return reply.code(200).send({
    tenant,
    window_bucket: bucket,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    spend_micros: totalMicros,
    spend_usd: Math.round(totalMicros / 10_000) / 100,
    budget_micros: BUDGET_MICROS,
    remaining_micros: Math.max(BUDGET_MICROS - totalMicros, 0),
    statement_version: STATEMENT_VERSION,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"math"
	"net/http"
)

type SpendRow struct {
	CostUsd float64 \`json:"cost_usd"\`
}

func analyticsRows(tenant string) []SpendRow {
	return nil
}

func readSpend(rw http.ResponseWriter, r *http.Request) {
	// TODO: authorize the caller against the tenant, read the current window from the meter
	// counters instead of the analytics table, compare against the enforced budget, stamp the
	// statement version from config, and round once at statement level instead of per request.
	tenant := r.PathValue("tenant")
	total := 0.0
	for _, row := range analyticsRows(tenant) {
		total += math.Round(row.CostUsd*10000) / 10000
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"tenant":            tenant,
		"spend_usd":         total,
		"statement_version": "v1",
	})
}
`,
      solution: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowS          int64 = 3600
	microsPerUSD     int64 = 1_000_000
	budgetMicros     int64 = 5_000_000
	statementVersion       = "2026-10-01"

	// The window's effective rate, in micro-dollars per 1K tokens, from the pricing table.
	rateInputMicrosPer1K  int64 = 3_000
	rateOutputMicrosPer1K int64 = 12_000
)

// meterKey is the same hash the budget limiter checks before it admits a request.
func meterKey(tenant string, bucket int64) string {
	return "meter:" + tenant + ":" + strconv.FormatInt(bucket, 10)
}

// spendMicros keeps money in integer micro-dollars; rounding to cents happens once, on the statement.
func spendMicros(inputTokens, outputTokens int64) int64 {
	return (inputTokens*rateInputMicrosPer1K + outputTokens*rateOutputMicrosPer1K) / 1000
}

func readSpend(rw http.ResponseWriter, r *http.Request) {
	caller := r.Header.Get("X-Tenant-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	tenant := r.PathValue("tenant")
	if caller != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	bucket := time.Now().Unix() / windowS
	counters, err := rdb.HMGet(r.Context(), meterKey(tenant, bucket), "input_tokens", "output_tokens").Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	inputTokens := int64(0)
	outputTokens := int64(0)
	if counters[0] != nil {
		inputTokens, _ = strconv.ParseInt(counters[0].(string), 10, 64)
	}
	if counters[1] != nil {
		outputTokens, _ = strconv.ParseInt(counters[1].(string), 10, 64)
	}
	totalMicros := spendMicros(inputTokens, outputTokens)
	remaining := budgetMicros - totalMicros
	if remaining < 0 {
		remaining = 0
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":            tenant,
		"window_bucket":     bucket,
		"input_tokens":      inputTokens,
		"output_tokens":     outputTokens,
		"spend_micros":      totalMicros,
		"spend_usd":         math.Round(float64(totalMicros)/10_000) / 100,
		"budget_micros":     budgetMicros,
		"remaining_micros":  remaining,
		"statement_version": statementVersion,
	})
}
`,
    },
    scala: {
      starter: `import spray.json._

object SpendRead {
  val analytics = AnalyticsTable.open()

  def readSpend(tenant: String): JsObject = {
    // TODO: authorize the caller against the tenant, read the current window from the meter
    // counters instead of the analytics table, compare against the enforced budget, stamp the
    // statement version from config, and round once at statement level instead of per request.
    var total = 0.0
    for (row <- analytics.spendRows(tenant)) {
      total += Math.round(row("cost_usd").convertTo[Double] * 10000) / 10000
    }
    JsObject(
      "tenant" -> JsString(tenant),
      "spend_usd" -> JsNumber(total),
      "statement_version" -> JsString("v1")
    )
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import jedis.RedisClient
import spray.json._

object SpendRead {
  val r: RedisClient = new RedisClient("redis", 6379)

  val WindowS = 3600L
  val MicrosPerUsd = 1_000_000L
  val BudgetMicros = 5_000_000L
  val StatementVersion = "2026-10-01"

  // The window's effective rate, in micro-dollars per 1K tokens, from the pricing table.
  val RateInputMicrosPer1K = 3_000L
  val RateOutputMicrosPer1K = 12_000L

  /** The same hash the budget limiter checks before it admits a request. */
  def meterKey(tenant: String, bucket: Long): String = s"meter:$tenant:$bucket"

  /** Integer micro-dollars; rounding to cents happens once, on the statement total. */
  def spendMicros(inputTokens: Long, outputTokens: Long): Long =
    (inputTokens * RateInputMicrosPer1K + outputTokens * RateOutputMicrosPer1K) / 1000

  def readSpend(caller: String, tenant: String): Either[Int, JsObject] = {
    if (caller.isEmpty) return Left(401)
    if (caller != tenant) return Left(403)
    val bucket = System.currentTimeMillis() / 1000 / WindowS
    val counters = r.hmget(meterKey(tenant, bucket), "input_tokens", "output_tokens")
    val inputTokens = Option(counters.get(0)).map(_.toLong).getOrElse(0L)
    val outputTokens = Option(counters.get(1)).map(_.toLong).getOrElse(0L)
    val totalMicros = spendMicros(inputTokens, outputTokens)
    Right(
      JsObject(
        "tenant" -> JsString(tenant),
        "window_bucket" -> JsNumber(bucket),
        "input_tokens" -> JsNumber(inputTokens),
        "output_tokens" -> JsNumber(outputTokens),
        "spend_micros" -> JsNumber(totalMicros),
        "spend_usd" -> JsNumber(BigDecimal(totalMicros.toDouble / 1_000_000).setScale(2, BigDecimal.RoundingMode.HALF_UP)),
        "budget_micros" -> JsNumber(BudgetMicros),
        "remaining_micros" -> JsNumber(math.max(BudgetMicros - totalMicros, 0L)),
        "statement_version" -> JsString(StatementVersion)
      )
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <string>

using json = nlohmann::json;

struct AnalyticsTable {
  std::vector<json> spendRows(const std::string& tenant);
};

AnalyticsTable analytics;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/tenants/([^/]+)/spend)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: authorize the caller against the tenant, read the current window from the meter
    // counters instead of the analytics table, compare against the enforced budget, stamp the
    // statement version from config, and round once at statement level instead of per request.
    const auto tenant = req.matches[1];
    double total = 0.0;
    for (const auto& row : analytics.spendRows(tenant)) {
      total += std::round(row.value("cost_usd", 0.0) * 10000) / 10000;
    }
    res.status = 200;
    res.set_content(
        json{{"tenant", tenant}, {"spend_usd", total}, {"statement_version", "v1"}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>
#include <vector>

using json = nlohmann::json;
using sw::redis::Redis;

Redis r("tcp://redis:6379");

constexpr long long kWindowS = 3600;
constexpr long long kMicrosPerUsd = 1'000'000;
constexpr long long kBudgetMicros = 5'000'000;
const std::string kStatementVersion = "2026-10-01";

// The window's effective rate, in micro-dollars per 1K tokens, from the pricing table.
constexpr long long kRateInputMicrosPer1K = 3'000;
constexpr long long kRateOutputMicrosPer1K = 12'000;

// meterKey is the same hash the budget limiter checks before it admits a request.
std::string meterKey(const std::string& tenant, long long bucket) {
  return "meter:" + tenant + ":" + std::to_string(bucket);
}

// spendMicros keeps money in integer micro-dollars; cents are rounded once, on the statement.
long long spendMicros(long long inputTokens, long long outputTokens) {
  return (inputTokens * kRateInputMicrosPer1K + outputTokens * kRateOutputMicrosPer1K) / 1000;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/tenants/([^/]+)/spend)", [](const httplib::Request& req, httplib::Response& res) {
    const auto caller = req.get_header_value("X-Tenant-Id");
    if (caller.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto tenant = req.matches[1];
    if (caller != tenant) {
      res.status = 403;
      res.set_content(R"({"error":"forbidden"})", "application/json");
      return;
    }
    const long long bucket =
        std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count() /
        kWindowS;
    const auto counters = r.hmget(meterKey(tenant, bucket), {"input_tokens", "output_tokens"});
    const long long inputTokens = counters[0] ? std::stoll(*counters[0]) : 0;
    const long long outputTokens = counters[1] ? std::stoll(*counters[1]) : 0;
    const long long totalMicros = spendMicros(inputTokens, outputTokens);
    const long long remaining = std::max(kBudgetMicros - totalMicros, 0LL);
    res.status = 200;
    res.set_content(
        json{{"tenant", tenant},
             {"window_bucket", bucket},
             {"input_tokens", inputTokens},
             {"output_tokens", outputTokens},
             {"spend_micros", totalMicros},
             {"spend_usd", std::round(static_cast<double>(totalMicros) / 10'000.0) / 100.0},
             {"budget_micros", kBudgetMicros},
             {"remaining_micros", remaining},
             {"statement_version", kStatementVersion}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Authorize the read like the write: take the caller from `X-Tenant-Id`, compare it with the tenant in the path, and answer `403` on a mismatch. An unguessable id is not an access-control mechanism, and spend data is exactly what a competitor would like to read.',
    'Read `meter:{tenant}:{bucket}` — the same key the limiter checks — so the dashboard and the 429 come from one number. A warehouse copy that trails by minutes is fine for a weekly report and wrong for a spend page someone is watching during an incident.',
    'Keep money integral: micro-dollars per request, one rounding to cents on the statement total, and `statement_version` on every response. Rounding inside the loop is the bug that makes a busy tenant’s invoice look like zero.',
  ],
  debrief: `The interviewer is testing the read side of a money system, where the interesting question is never "does it return a number" but "is it the same number the rest of the platform acted on". Four properties are checked: authorization (a ledger read is a permissioned read), one source of truth (the limiter’s own counters, not a trailing copy), a versioned statement (so an old invoice can be re-derived), and integral money with a single statement-level rounding (so small requests still add up). The rounding flaw is the one that gets shipped: it reads like defensive tidiness, and it silently zeroes exactly the workloads that keep a platform busy. Real meters add a per-model breakdown you can drill into, a period-level counter that outlives the window, and a reconciliation report that compares these counters against the provider's own usage export.`,
};
