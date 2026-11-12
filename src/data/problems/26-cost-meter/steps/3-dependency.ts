import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Pricing: a deadline, a fresh fallback table, uncosted when unsure',
  concept: 'grpc',
  guides: ['failing-dependencies', 'deadlines-and-retries'],
  file: 'client',
  focus: ['meter', 'pricing'],
  task: `## Task

**Starting point.** The starter's \`cost_of(model, input_tokens, output_tokens)\` prices a report before
step 2 records it: it serves a per-model \`PRICE_CACHE\` entry when there is one, otherwise calls
\`Pricing.GetRates\` (\`pricing.proto\`, a stand-in at \`meter/config\`'s \`PRICING\`) with no deadline, takes
the model's rate or \`FALLBACK_RATE\`, uses \`FALLBACK_RATE\` on any \`RpcError\` too, and caches what it
got. Against a healthy service the numbers are right. It hides five flaws.

**Failure mode the checks target.** A hung pricing replica holds the report path as long as it hangs.
One bad minute pins an invented rate, marked priced, on every model looked up during it, for the life of
the process. A model the table does not list is billed at that same rate.

\`\`\`proto
service Pricing { rpc GetRates(RatesRequest) returns (RateTable); }
message ModelRate { string model = 1; int32 input_rate = 2; int32 output_rate = 3; }  // micro-dollars per 1 000 tokens
message RateTable { string version = 1; repeated ModelRate rates = 2; }
\`\`\`

Requirements:

- Every lookup calls \`GetRates\` under a **200 ms** deadline (\`PRICE_DEADLINE_S\`); a reply replaces the
  cached table and its \`fetched_at\`, and prices the report with \`source: "service"\`.
- When the call fails, the cached table prices it (\`source: "cache"\`) while at most
  \`PRICE_MAX_AGE_S = 3600\` seconds old.
- No usable table, or a model the table lacks: \`{cost_micros: 0, priced: false, source: "uncosted",
  rate_version: ""}\`. A failure writes nothing to the cache.
- \`cost_micros = (input_tokens × input_rate + output_tokens × output_rate) // 1000\`, with the table's
  \`version\` as \`rate_version\`.`,
  sequence: {
    participants: ['meterd', 'Pricing', 'rate table'],
    messages: [
      {from: 'meterd', to: 'Pricing', label: 'GetRates · deadline 200 ms', kind: 'sync'},
      {from: 'Pricing', to: 'meterd', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'meterd', to: 'rate table', label: 'last good table · fetched_at', kind: 'sync'},
      {from: 'rate table', to: 'meterd', label: 'version · rates (≤ 1 h old)', kind: 'reply'},
      {from: 'meterd', to: 'meterd', label: '{cost_micros, priced, source: cache, rate_version}', kind: 'sync'},
    ],
  },
  hints: [
    'Symptom: during a pricing outage every model costs the same, a model the table does not list is billed anyway, and one slow pricing replica stalls every report behind it.',
    'Mechanism: the per-model cache is read before the service and written on the error path with FALLBACK_RATE, so one failure or one unknown model becomes a priced rate for good; and the call has no deadline.',
    'Change: call `GetRates` with `timeout=PRICE_DEADLINE_S` on every lookup and keep `{version, rates, fetched_at}` only from a reply; on `RpcError` price from that table if `now - fetched_at <= PRICE_MAX_AGE_S`; otherwise, or for a missing model, answer uncosted.',
  ],
  checks: [
    {
      id: 'deadline',
      title: '200 ms deadline on the pricing call',
      detail:
        'Each GetRates call carries a deadline of about 200 ms; a service that hangs is cut there and the report is priced from the fresh cached table. The starter sends no deadline.',
      match: {
        python: {all: [/timeout\s*=\s*PRICE_DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*PRICE_DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(/, /priceDeadline/]},
        scala: {all: [/withDeadlineAfter\(/, /PriceDeadlineMs/]},
        cpp: {all: [/set_deadline\(/, /kPriceDeadline/]},
      },
    },
    {
      id: 'cache-fallback',
      title: 'Prices from the last good table when the service fails',
      detail:
        "After one good reply, a failed call prices any model in that table from it, with source cache and the table's version. The starter prices a failed lookup at an invented FALLBACK_RATE.",
      match: {
        python: {all: [/["']cache["']/], none: [/FALLBACK_RATE/]},
        typescript: {all: [/['"]cache['"]/], none: [/FALLBACK_RATE/]},
        go: {all: [/"cache"/], none: [/fallbackRate/]},
        scala: {all: [/"cache"/], none: [/FallbackRate/]},
        cpp: {all: [/"cache"/], none: [/kFallbackRate/]},
      },
    },
    {
      id: 'cache-freshness',
      title: 'Uses the cached table for an hour at most',
      detail:
        'A table 3500 s old still prices a report when the service fails; one older than PRICE_MAX_AGE_S makes the report uncosted. The starter serves a cached rate for the life of the process, without asking the service.',
      match: {
        python: {all: [/PRICE_MAX_AGE_S/]},
        typescript: {all: [/PRICE_MAX_AGE_S/]},
        go: {all: [/priceMaxAge/]},
        scala: {all: [/PriceMaxAgeSeconds/]},
        cpp: {all: [/kPriceMaxAge/]},
      },
    },
    {
      id: 'uncosted-model',
      title: 'Marks a model the table lacks as uncosted',
      detail:
        'A model missing from the served table answers priced false, source uncosted, cost 0, for a reconcile job to price later. The starter bills it at FALLBACK_RATE as if it were priced.',
      match: {
        python: {all: [/["']uncosted["']/], none: [/FALLBACK_RATE/]},
        typescript: {all: [/['"]uncosted['"]/], none: [/FALLBACK_RATE/]},
        go: {all: [/"uncosted"/], none: [/fallbackRate/]},
        scala: {all: [/"uncosted"/], none: [/FallbackRate/]},
        cpp: {all: [/"uncosted"/], none: [/kFallbackRate/]},
      },
    },
    {
      id: 'failure-not-cached',
      title: 'Does not cache a failure',
      detail:
        'A failed first lookup is uncosted and the next lookup asks the service again and prices from its reply. The starter stores the fallback rate it used on the error path, so the service is not asked again for that model.',
      match: {
        python: {all: [/fetched_at/], none: [/PRICE_CACHE/]},
        typescript: {all: [/fetchedAt/], none: [/PRICE_CACHE/]},
        go: {all: [/fetchedAt/], none: [/priceCache/]},
        scala: {all: [/fetchedAt/], none: [/PriceCache/]},
        cpp: {all: [/fetched_at/], none: [/price_cache/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import pricing_pb2
import pricing_pb2_grpc
from meter.config import PRICING

logger = logging.getLogger("meter.pricing")

FALLBACK_RATE = (10_000, 30_000)

channel = grpc.insecure_channel(PRICING)
stub = pricing_pb2_grpc.PricingStub(channel)

# model -> (input_rate, output_rate, version)
PRICE_CACHE: dict[str, tuple[int, int, str]] = {}


def cost_of(model: str, input_tokens: int, output_tokens: int) -> dict:
    """Price one report: {cost_micros, priced, source, rate_version}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    if model not in PRICE_CACHE:
        try:
            table = stub.GetRates(pricing_pb2.RatesRequest())
            rates = {r.model: (r.input_rate, r.output_rate) for r in table.rates}
            PRICE_CACHE[model] = (*rates.get(model, FALLBACK_RATE), table.version)
        except grpc.RpcError as err:
            logger.warning("pricing unavailable model=%s code=%s", model, err.code())
            PRICE_CACHE[model] = (*FALLBACK_RATE, "fallback")
    input_rate, output_rate, version = PRICE_CACHE[model]
    cost = (input_tokens * input_rate + output_tokens * output_rate) // 1000
    return {"cost_micros": cost, "priced": True, "source": "service", "rate_version": version}
`,
      solution: `import logging
import time

import grpc

import pricing_pb2
import pricing_pb2_grpc
from meter.config import PRICING

logger = logging.getLogger("meter.pricing")

PRICE_DEADLINE_S = 0.2
PRICE_MAX_AGE_S = 3600

channel = grpc.insecure_channel(PRICING)
stub = pricing_pb2_grpc.PricingStub(channel)

# The last table the service answered: {version, rates, fetched_at}. Only a reply writes it.
last_table: dict | None = None


def _fetch_rates() -> dict | None:
    global last_table
    try:
        reply = stub.GetRates(pricing_pb2.RatesRequest(), timeout=PRICE_DEADLINE_S)
    except grpc.RpcError as err:
        logger.warning("pricing unavailable code=%s", err.code())
        return None
    last_table = {
        "version": reply.version,
        "rates": {r.model: (r.input_rate, r.output_rate) for r in reply.rates},
        "fetched_at": time.time(),
    }
    return last_table


def cost_of(model: str, input_tokens: int, output_tokens: int) -> dict:
    """Price one report: {cost_micros, priced, source, rate_version}."""
    uncosted = {"cost_micros": 0, "priced": False, "source": "uncosted", "rate_version": ""}
    table, source = _fetch_rates(), "service"
    if table is None:
        table, source = last_table, "cache"
        if table is None or time.time() - table["fetched_at"] > PRICE_MAX_AGE_S:
            return uncosted
    rate = table["rates"].get(model)
    if rate is None:
        return uncosted  # priced later by reconciliation, not now by a guess
    cost = (input_tokens * rate[0] + output_tokens * rate[1]) // 1000
    return {"cost_micros": cost, "priced": True, "source": source, "rate_version": table["version"]}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {PRICING} from 'meter/config';

export const FALLBACK_RATE: [number, number] = [10_000, 30_000];

interface ModelRate {
  model: string;
  input_rate: number;
  output_rate: number;
}
interface RateTable {
  version: string;
  rates: ModelRate[];
}
interface PricingClient {
  GetRates(request: Record<string, never>, options?: {deadline: number}): Promise<RateTable>;
}

const {meter} = grpc.loadPackageDefinition(protoLoader.loadSync('pricing.proto')) as unknown as {
  meter: {Pricing: new (target: string, credentials: grpc.ChannelCredentials) => PricingClient};
};
const stub = new meter.Pricing(PRICING, grpc.credentials.createInsecure());

export interface Price {
  cost_micros: number;
  priced: boolean;
  source: string;
  rate_version: string;
}

/** model → [input_rate, output_rate, version] */
const PRICE_CACHE: Record<string, [number, number, string]> = {};

/** Price one report. */
export async function costOf(model: string, inputTokens: number, outputTokens: number): Promise<Price> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  if (PRICE_CACHE[model] === undefined) {
    try {
      const table = await stub.GetRates({});
      const rate = table.rates.find(r => r.model === model);
      PRICE_CACHE[model] = rate === undefined ? [...FALLBACK_RATE, table.version] : [rate.input_rate, rate.output_rate, table.version];
    } catch (err) {
      console.warn(\`pricing unavailable model=\${model} code=\${(err as grpc.ServiceError).code}\`);
      PRICE_CACHE[model] = [...FALLBACK_RATE, 'fallback'];
    }
  }
  const [inputRate, outputRate, version] = PRICE_CACHE[model];
  const cost = Math.floor((inputTokens * inputRate + outputTokens * outputRate) / 1000);
  return {cost_micros: cost, priced: true, source: 'service', rate_version: version};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {PRICING} from 'meter/config';

export const PRICE_DEADLINE_MS = 200;
export const PRICE_MAX_AGE_S = 3600;

interface ModelRate {
  model: string;
  input_rate: number;
  output_rate: number;
}
interface RateTable {
  version: string;
  rates: ModelRate[];
}
interface PricingClient {
  GetRates(request: Record<string, never>, options?: {deadline: number}): Promise<RateTable>;
}

const {meter} = grpc.loadPackageDefinition(protoLoader.loadSync('pricing.proto')) as unknown as {
  meter: {Pricing: new (target: string, credentials: grpc.ChannelCredentials) => PricingClient};
};
const stub = new meter.Pricing(PRICING, grpc.credentials.createInsecure());

export interface Price {
  cost_micros: number;
  priced: boolean;
  source: string;
  rate_version: string;
}

interface CachedTable {
  version: string;
  rates: Map<string, [number, number]>;
  fetchedAt: number;
}

/** The last table the service answered. Only a reply writes it. */
let lastTable: CachedTable | null = null;

async function fetchRates(): Promise<CachedTable | null> {
  try {
    const reply = await stub.GetRates({}, {deadline: Date.now() + PRICE_DEADLINE_MS});
    lastTable = {
      version: reply.version,
      rates: new Map(reply.rates.map(r => [r.model, [r.input_rate, r.output_rate]])),
      fetchedAt: Date.now() / 1000,
    };
    return lastTable;
  } catch (err) {
    console.warn(\`pricing unavailable code=\${(err as grpc.ServiceError).code}\`);
    return null;
  }
}

/** Price one report. */
export async function costOf(model: string, inputTokens: number, outputTokens: number): Promise<Price> {
  const uncosted: Price = {cost_micros: 0, priced: false, source: 'uncosted', rate_version: ''};
  let table = await fetchRates();
  let source = 'service';
  if (table === null) {
    table = lastTable;
    source = 'cache';
    if (table === null || Date.now() / 1000 - table.fetchedAt > PRICE_MAX_AGE_S) return uncosted;
  }
  const rate = table.rates.get(model);
  if (rate === undefined) return uncosted; // priced later by reconciliation, not now by a guess
  const cost = Math.floor((inputTokens * rate[0] + outputTokens * rate[1]) / 1000);
  return {cost_micros: cost, priced: true, source, rate_version: table.version};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"meter/config" // config.Pricing — provided
	pb "meter/gen/pricing"
)

var fallbackRate = [2]int64{10_000, 30_000}

var conn, _ = grpc.NewClient(config.Pricing, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewPricingClient(conn)

type cachedRate struct {
	input, output int64
	version       string
}

var priceCache = map[string]cachedRate{}

// Price is one report's price.
type Price struct {
	CostMicros  int64
	Priced      bool
	Source      string
	RateVersion string
}

// costOf prices one report.
func costOf(ctx context.Context, model string, inputTokens, outputTokens int64) Price {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	rate, ok := priceCache[model]
	if !ok {
		table, err := stub.GetRates(ctx, &pb.RatesRequest{})
		if err != nil {
			log.Printf("pricing unavailable model=%s: %v", model, err)
			rate = cachedRate{fallbackRate[0], fallbackRate[1], "fallback"}
		} else {
			rate = cachedRate{fallbackRate[0], fallbackRate[1], table.GetVersion()}
			for _, r := range table.GetRates() {
				if r.GetModel() == model {
					rate = cachedRate{int64(r.GetInputRate()), int64(r.GetOutputRate()), table.GetVersion()}
				}
			}
		}
		priceCache[model] = rate
	}
	cost := (inputTokens*rate.input + outputTokens*rate.output) / 1000
	return Price{CostMicros: cost, Priced: true, Source: "service", RateVersion: rate.version}
}
`,
      solution: `package main

import (
	"context"
	"log"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"meter/config" // config.Pricing — provided
	pb "meter/gen/pricing"
)

const (
	priceDeadline = 200 * time.Millisecond
	priceMaxAge   = time.Hour
)

var conn, _ = grpc.NewClient(config.Pricing, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewPricingClient(conn)

type rateTable struct {
	version   string
	rates     map[string][2]int64
	fetchedAt time.Time
}

// lastTable is the last table the service answered. Only a reply writes it.
var (
	mu        sync.Mutex
	lastTable *rateTable
)

// Price is one report's price.
type Price struct {
	CostMicros  int64
	Priced      bool
	Source      string
	RateVersion string
}

func fetchRates(ctx context.Context) *rateTable {
	callCtx, cancel := context.WithTimeout(ctx, priceDeadline)
	defer cancel()
	reply, err := stub.GetRates(callCtx, &pb.RatesRequest{})
	if err != nil {
		log.Printf("pricing unavailable code=%s", status.Code(err))
		return nil
	}
	table := &rateTable{version: reply.GetVersion(), rates: map[string][2]int64{}, fetchedAt: time.Now()}
	for _, r := range reply.GetRates() {
		table.rates[r.GetModel()] = [2]int64{int64(r.GetInputRate()), int64(r.GetOutputRate())}
	}
	mu.Lock()
	lastTable = table
	mu.Unlock()
	return table
}

// costOf prices one report.
func costOf(ctx context.Context, model string, inputTokens, outputTokens int64) Price {
	uncosted := Price{Source: "uncosted"}
	table, source := fetchRates(ctx), "service"
	if table == nil {
		mu.Lock()
		table, source = lastTable, "cache"
		mu.Unlock()
		if table == nil || time.Now().Sub(table.fetchedAt) > priceMaxAge {
			return uncosted
		}
	}
	rate, ok := table.rates[model]
	if !ok {
		return uncosted // priced later by reconciliation, not now by a guess
	}
	cost := (inputTokens*rate[0] + outputTokens*rate[1]) / 1000
	return Price{CostMicros: cost, Priced: true, Source: source, RateVersion: table.version}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import scala.collection.mutable

import meter.Config
import meter.pricing.{PricingGrpc, RatesRequest}

/** One report's price. */
final case class Price(costMicros: Long, priced: Boolean, source: String, rateVersion: String)

object PricingClient {
  val FallbackRate: (Long, Long) = (10000L, 30000L)

  private val channel = ManagedChannelBuilder.forTarget(Config.Pricing).usePlaintext().build()
  private val stub = PricingGrpc.blockingStub(channel)

  /** model -> (input rate, output rate, version) */
  private val PriceCache = mutable.Map[String, (Long, Long, String)]()

  /** Price one report. */
  def costOf(model: String, inputTokens: Long, outputTokens: Long): Price = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val (inputRate, outputRate, version) = PriceCache.getOrElseUpdate(
      model,
      try {
        val table = stub.getRates(RatesRequest())
        table.rates.find(_.model == model) match {
          case Some(r) => (r.inputRate.toLong, r.outputRate.toLong, table.version)
          case None    => (FallbackRate._1, FallbackRate._2, table.version)
        }
      } catch {
        case e: StatusRuntimeException =>
          System.err.println(s"pricing unavailable model=$model code=\${e.getStatus.getCode}")
          (FallbackRate._1, FallbackRate._2, "fallback")
      }
    )
    Price((inputTokens * inputRate + outputTokens * outputRate) / 1000, priced = true, "service", version)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import meter.Config
import meter.pricing.{PricingGrpc, RatesRequest}

/** One report's price. */
final case class Price(costMicros: Long, priced: Boolean, source: String, rateVersion: String)

/** A table the service answered, and when. */
final case class CachedTable(version: String, rates: Map[String, (Long, Long)], fetchedAt: Long)

object PricingClient {
  val PriceDeadlineMs = 200L
  val PriceMaxAgeSeconds = 3600L

  private val channel = ManagedChannelBuilder.forTarget(Config.Pricing).usePlaintext().build()
  private val stub = PricingGrpc.blockingStub(channel)

  /** The last table the service answered. Only a reply writes it. */
  @volatile private var lastTable: Option[CachedTable] = None

  private def nowSeconds: Long = System.currentTimeMillis() / 1000

  private def fetchRates(): Option[CachedTable] =
    try {
      val reply = stub.withDeadlineAfter(PriceDeadlineMs, TimeUnit.MILLISECONDS).getRates(RatesRequest())
      val table = CachedTable(
        reply.version,
        reply.rates.map(r => r.model -> (r.inputRate.toLong, r.outputRate.toLong)).toMap,
        nowSeconds
      )
      lastTable = Some(table)
      Some(table)
    } catch {
      case e: StatusRuntimeException =>
        System.err.println(s"pricing unavailable code=\${e.getStatus.getCode}")
        None
    }

  /** Price one report. */
  def costOf(model: String, inputTokens: Long, outputTokens: Long): Price = {
    val uncosted = Price(0, priced = false, "uncosted", "")
    val (table, source) = fetchRates() match {
      case Some(fresh) => (Some(fresh), "service")
      case None        => (lastTable.filter(t => nowSeconds - t.fetchedAt <= PriceMaxAgeSeconds), "cache")
    }
    table.flatMap(t => t.rates.get(model).map(rate => (t, rate))) match {
      case Some((t, (inputRate, outputRate))) =>
        Price((inputTokens * inputRate + outputTokens * outputRate) / 1000, priced = true, source, t.version)
      case None => uncosted // priced later by reconciliation, not now by a guess
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <map>
#include <string>
#include <tuple>

#include "meter/config.h"  // config::kPricing — provided
#include "pricing.grpc.pb.h"

constexpr long long kFallbackRate[2] = {10000, 30000};

auto channel = grpc::CreateChannel(config::kPricing, grpc::InsecureChannelCredentials());
auto stub = meter::Pricing::NewStub(channel);

// One report's price.
struct Price {
  long long cost_micros = 0;
  bool priced = false;
  std::string source;
  std::string rate_version;
};

// model -> (input rate, output rate, version)
std::map<std::string, std::tuple<long long, long long, std::string>> price_cache;

// Price one report.
Price cost_of(const std::string& model, long long input_tokens, long long output_tokens) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  if (price_cache.count(model) == 0) {
    grpc::ClientContext ctx;
    meter::RatesRequest request;
    meter::RateTable table;
    const grpc::Status status = stub->GetRates(&ctx, request, &table);
    if (!status.ok()) {
      std::cerr << "pricing unavailable model=" << model << " code=" << status.error_code() << "\\n";
      price_cache[model] = {kFallbackRate[0], kFallbackRate[1], "fallback"};
    } else {
      price_cache[model] = {kFallbackRate[0], kFallbackRate[1], table.version()};
      for (const auto& r : table.rates()) {
        if (r.model() == model) price_cache[model] = {r.input_rate(), r.output_rate(), table.version()};
      }
    }
  }
  const auto& [input_rate, output_rate, version] = price_cache[model];
  return {(input_tokens * input_rate + output_tokens * output_rate) / 1000, true, "service", version};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

#include "meter/config.h"  // config::kPricing — provided
#include "pricing.grpc.pb.h"

constexpr std::chrono::milliseconds kPriceDeadline{200};
constexpr std::chrono::seconds kPriceMaxAge{3600};

auto channel = grpc::CreateChannel(config::kPricing, grpc::InsecureChannelCredentials());
auto stub = meter::Pricing::NewStub(channel);

// One report's price.
struct Price {
  long long cost_micros = 0;
  bool priced = false;
  std::string source;
  std::string rate_version;
};

// A table the service answered, and when.
struct CachedTable {
  std::string version;
  std::map<std::string, std::pair<long long, long long>> rates;
  std::chrono::system_clock::time_point fetched_at;
};

// The last table the service answered. Only a reply writes it.
std::mutex table_mu;
std::optional<CachedTable> last_table;

std::optional<CachedTable> fetch_rates() {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kPriceDeadline);
  meter::RatesRequest request;
  meter::RateTable reply;
  const grpc::Status status = stub->GetRates(&ctx, request, &reply);
  if (!status.ok()) {
    std::cerr << "pricing unavailable code=" << status.error_code() << "\\n";
    return std::nullopt;
  }
  CachedTable table{reply.version(), {}, std::chrono::system_clock::now()};
  for (const auto& r : reply.rates()) table.rates[r.model()] = {r.input_rate(), r.output_rate()};
  std::lock_guard<std::mutex> lock(table_mu);
  last_table = table;
  return table;
}

// Price one report.
Price cost_of(const std::string& model, long long input_tokens, long long output_tokens) {
  const Price uncosted{0, false, "uncosted", ""};
  std::optional<CachedTable> table = fetch_rates();
  std::string source = "service";
  if (!table) {
    {
      std::lock_guard<std::mutex> lock(table_mu);
      table = last_table;
    }
    source = "cache";
    if (!table || std::chrono::system_clock::now() - table->fetched_at > kPriceMaxAge) return uncosted;
  }
  const auto rate = table->rates.find(model);
  if (rate == table->rates.end()) return uncosted;  // priced later by reconciliation, not now by a guess
  const long long cost = (input_tokens * rate->second.first + output_tokens * rate->second.second) / 1000;
  return {cost, true, source, table->version};
}
`,
    },
  },
  harness: {
    python: `import grpc

import pricing_pb2
import pricing_pb2_grpc
from meter import config, pricing


class PricingServicer(pricing_pb2_grpc.PricingServicer):
    """The stand-in pricing service: answers meter.pricing's table."""

    def GetRates(self, request, context):
        rates = [pricing_pb2.ModelRate(model=m, input_rate=i, output_rate=o) for m, (i, o) in pricing.RATES.items()]
        return pricing_pb2.RateTable(version=pricing.VERSION, rates=rates)


def _world(ctx):
    ctx.grpc.serve(pricing_pb2_grpc.add_PricingServicer_to_server, PricingServicer(), config.PRICING)
    return ctx.load("client")


def _calls(ctx):
    return ctx.grpc.calls_to("GetRates")


def _fail(ctx, times=1):
    ctx.grpc.fail("GetRates", grpc.StatusCode.UNAVAILABLE, "pricing restarting", times=times, target=config.PRICING)


def _expect(price, cost, source, priced=True, version=pricing.VERSION):
    assert isinstance(price, dict), f"cost_of must return a dict, got {type(price).__name__}"
    got = (price.get("cost_micros"), price.get("priced"), price.get("source"), price.get("rate_version"))
    assert got == (cost, priced, source, version), f"expected cost_micros={cost}, priced={priced}, source={source!r}, rate_version={version!r}; cost_of answered {price}"


def check_deadline(ctx):
    m = _world(ctx)
    _expect(m.cost_of("gpt-4o", 1200, 300), 6000, "service")
    calls = _calls(ctx)
    assert len(calls) == 1, f"one lookup must make one GetRates call, saw {len(calls)}"
    assert calls[0].timeout is not None, "the GetRates call carries no deadline: a hung pricing replica holds the report path as long as it hangs"
    assert 0.15 <= calls[0].timeout <= 0.25, f"the deadline must be PRICE_DEADLINE_S = 0.2 s, got {calls[0].timeout} s"
    ctx.grpc.set_latency("GetRates", 5.0, config.PRICING)
    started = ctx.clock.offset
    price = m.cost_of("gpt-4o", 1200, 300)
    waited = ctx.clock.offset - started
    assert waited <= 0.3, f"the lookup waited {waited:.1f} s on a pricing service that hangs: the deadline must cut it at 0.2 s"
    _expect(price, 6000, "cache")


def check_cache_fallback(ctx):
    m = _world(ctx)
    _expect(m.cost_of("gpt-4o", 1200, 300), 6000, "service")
    _fail(ctx)
    price = m.cost_of("gpt-4o-mini", 1200, 300)
    assert len(_calls(ctx)) == 2, f"a lookup asks the service first, then falls back: saw {len(_calls(ctx))} GetRates calls for two lookups"
    _expect(price, 360, "cache")


def check_cache_freshness(ctx):
    m = _world(ctx)
    _expect(m.cost_of("gpt-4o", 1200, 300), 6000, "service")
    ctx.clock.advance(3500)
    _fail(ctx)
    _expect(m.cost_of("gpt-4o", 1200, 300), 6000, "cache")
    ctx.clock.advance(101)
    _fail(ctx)
    price = m.cost_of("gpt-4o", 1200, 300)
    assert len(_calls(ctx)) == 3, f"every lookup asks the service: saw {len(_calls(ctx))} GetRates calls for three lookups"
    _expect(price, 0, "uncosted", priced=False, version="")


def check_uncosted_model(ctx):
    m = _world(ctx)
    price = m.cost_of("llama-3-70b-local", 5000, 500)
    _expect(price, 0, "uncosted", priced=False, version="")
    _expect(m.cost_of("claude-sonnet-4", 1000, 1000), 18000, "service")


def check_failure_not_cached(ctx):
    m = _world(ctx)
    _fail(ctx)
    _expect(m.cost_of("gpt-4o", 1200, 300), 0, "uncosted", priced=False, version="")
    price = m.cost_of("gpt-4o", 1200, 300)
    assert len(_calls(ctx)) == 2, f"after a failed lookup the next one must ask the service again: saw {len(_calls(ctx))} GetRates calls for two lookups"
    _expect(price, 6000, "service")
`,
    typescript: `async function world(ctx) {
  const {meter} = ctx.proto('pricing.proto');
  const config = ctx.load('/support/meter/config.ts');
  const pricing = ctx.load('/support/meter/pricing.ts');
  ctx.grpc.serve(meter.Pricing.service, {
    GetRates(call, callback) {
      const rates = Object.entries(pricing.RATES).map(([model, [input_rate, output_rate]]) => ({model, input_rate, output_rate}));
      callback(null, {version: pricing.VERSION, rates});
    },
  }, config.PRICING);
  return {m: ctx.load('client'), config, pricing};
}

const calls = ctx => ctx.grpc.callsTo('GetRates');

function expect(price, cost: number, source: string, priced = true, version = 'rates-2026-11-01') {
  assert(price !== null && typeof price === 'object', \`costOf must resolve to an object, got \${JSON.stringify(price)}\`);
  const got = [price.cost_micros, price.priced, price.source, price.rate_version];
  assert.deepEqual(got, [cost, priced, source, version], \`expected cost_micros=\${cost}, priced=\${priced}, source=\${source}, rate_version=\${JSON.stringify(version)}; costOf answered \${JSON.stringify(price)}\`);
}

export async function check_deadline(ctx) {
  const {m, config} = await world(ctx);
  expect(await m.costOf('gpt-4o', 1200, 300), 6000, 'service');
  assert.equal(calls(ctx).length, 1, \`one lookup must make one GetRates call, saw \${calls(ctx).length}\`);
  const call = calls(ctx)[0];
  assert(call.timeout !== null, 'the GetRates call carries no deadline: a hung pricing replica holds the report path as long as it hangs');
  assert(0.15 <= call.timeout && call.timeout <= 0.25, \`the deadline must be PRICE_DEADLINE_MS = 200 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('GetRates', 5.0, config.PRICING);
  const started = ctx.clock.now();
  const price = await m.costOf('gpt-4o', 1200, 300);
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 0.3, \`the lookup waited \${waited.toFixed(1)} s on a pricing service that hangs: the deadline must cut it at 0.2 s\`);
  expect(price, 6000, 'cache');
}

export async function check_cache_fallback(ctx) {
  const {m, config} = await world(ctx);
  expect(await m.costOf('gpt-4o', 1200, 300), 6000, 'service');
  ctx.grpc.fail('GetRates', ctx.grpc.status.UNAVAILABLE, 'pricing restarting', 1, config.PRICING);
  const price = await m.costOf('gpt-4o-mini', 1200, 300);
  assert.equal(calls(ctx).length, 2, \`a lookup asks the service first, then falls back: saw \${calls(ctx).length} GetRates calls for two lookups\`);
  expect(price, 360, 'cache');
}

export async function check_cache_freshness(ctx) {
  const {m, config} = await world(ctx);
  expect(await m.costOf('gpt-4o', 1200, 300), 6000, 'service');
  ctx.clock.advance(3500);
  ctx.grpc.fail('GetRates', ctx.grpc.status.UNAVAILABLE, 'pricing restarting', 1, config.PRICING);
  expect(await m.costOf('gpt-4o', 1200, 300), 6000, 'cache');
  ctx.clock.advance(101);
  ctx.grpc.fail('GetRates', ctx.grpc.status.UNAVAILABLE, 'pricing restarting', 1, config.PRICING);
  const price = await m.costOf('gpt-4o', 1200, 300);
  assert.equal(calls(ctx).length, 3, \`every lookup asks the service: saw \${calls(ctx).length} GetRates calls for three lookups\`);
  expect(price, 0, 'uncosted', false, '');
}

export async function check_uncosted_model(ctx) {
  const {m} = await world(ctx);
  expect(await m.costOf('llama-3-70b-local', 5000, 500), 0, 'uncosted', false, '');
  expect(await m.costOf('claude-sonnet-4', 1000, 1000), 18000, 'service');
}

export async function check_failure_not_cached(ctx) {
  const {m, config} = await world(ctx);
  ctx.grpc.fail('GetRates', ctx.grpc.status.UNAVAILABLE, 'pricing restarting', 1, config.PRICING);
  expect(await m.costOf('gpt-4o', 1200, 300), 0, 'uncosted', false, '');
  const price = await m.costOf('gpt-4o', 1200, 300);
  assert.equal(calls(ctx).length, 2, \`after a failed lookup the next one must ask the service again: saw \${calls(ctx).length} GetRates calls for two lookups\`);
  expect(price, 6000, 'service');
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	"meter/config"
	pb "meter/gen/pricing"
	"meter/pricing"

	"leetbuild/harness"
)

// pricingPeer is the stand-in pricing service: answers meter/pricing's table.
type pricingPeer struct {
	pb.UnimplementedPricingServer
}

func (pricingPeer) GetRates(context.Context, *pb.RatesRequest) (*pb.RateTable, error) {
	table := &pb.RateTable{Version: pricing.Version}
	for _, model := range pricing.Models {
		rate := pricing.Rates[model]
		table.Rates = append(table.Rates, &pb.ModelRate{Model: model, InputRate: rate[0], OutputRate: rate[1]})
	}
	return table, nil
}

func clientWorld(ctx *harness.Ctx) {
	pb.RegisterPricingServer(ctx.GRPC.Server(config.Pricing), &pricingPeer{})
}

func clientCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("GetRates", "") }

func clientFail(ctx *harness.Ctx) {
	ctx.GRPC.Fail("GetRates", codes.Unavailable, "pricing restarting", 1, config.Pricing)
}

func clientExpect(ctx *harness.Ctx, price Price, cost int64, source string, priced bool, version string) {
	ctx.Equal(price, Price{CostMicros: cost, Priced: priced, Source: source, RateVersion: version}, "costOf's price")
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientExpect(ctx, costOf(context.Background(), "gpt-4o", 1200, 300), 6000, "service", true, pricing.Version)
	calls := clientCalls(ctx)
	ctx.Equal(len(calls), 1, "one lookup must make one GetRates call; calls")
	ctx.Assert(calls[0].HasDeadline(), "the GetRates call carries no deadline: a hung pricing replica holds the report path as long as it hangs")
	ctx.Assert(150*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 250*time.Millisecond, "the deadline must be 200 ms, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("GetRates", 5.0, config.Pricing)
	started := ctx.Clock.Now()
	price := costOf(context.Background(), "gpt-4o", 1200, 300)
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 0.3, "the lookup waited %.1f s on a pricing service that hangs: the deadline must cut it at 0.2 s", waited)
	clientExpect(ctx, price, 6000, "cache", true, pricing.Version)
}

func CheckCacheFallback(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientExpect(ctx, costOf(context.Background(), "gpt-4o", 1200, 300), 6000, "service", true, pricing.Version)
	clientFail(ctx)
	price := costOf(context.Background(), "gpt-4o-mini", 1200, 300)
	ctx.Equal(len(clientCalls(ctx)), 2, "a lookup asks the service first, then falls back; GetRates calls for two lookups")
	clientExpect(ctx, price, 360, "cache", true, pricing.Version)
}

func CheckCacheFreshness(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientExpect(ctx, costOf(context.Background(), "gpt-4o", 1200, 300), 6000, "service", true, pricing.Version)
	ctx.Clock.Advance(3500)
	clientFail(ctx)
	clientExpect(ctx, costOf(context.Background(), "gpt-4o", 1200, 300), 6000, "cache", true, pricing.Version)
	ctx.Clock.Advance(101)
	clientFail(ctx)
	price := costOf(context.Background(), "gpt-4o", 1200, 300)
	ctx.Equal(len(clientCalls(ctx)), 3, "every lookup asks the service; GetRates calls for three lookups")
	clientExpect(ctx, price, 0, "uncosted", false, "")
}

func CheckUncostedModel(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientExpect(ctx, costOf(context.Background(), "llama-3-70b-local", 5000, 500), 0, "uncosted", false, "")
	clientExpect(ctx, costOf(context.Background(), "claude-sonnet-4", 1000, 1000), 18000, "service", true, pricing.Version)
}

func CheckFailureNotCached(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientFail(ctx)
	clientExpect(ctx, costOf(context.Background(), "gpt-4o", 1200, 300), 0, "uncosted", false, "")
	price := costOf(context.Background(), "gpt-4o", 1200, 300)
	ctx.Equal(len(clientCalls(ctx)), 2, "after a failed lookup the next one must ask the service again; GetRates calls for two lookups")
	clientExpect(ctx, price, 6000, "service", true, pricing.Version)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "meter/pricing.h"

namespace {

// The stand-in pricing service: answers meter/pricing.h's table.
class PricingPeer final : public meter::Pricing::Service {
 public:
  grpc::Status GetRates(grpc::ServerContext*, const meter::RatesRequest*, meter::RateTable* reply) override {
    reply->set_version(pricing::kVersion);
    for (const auto& rate : pricing::rates()) {
      auto* r = reply->add_rates();
      r->set_model(rate.model);
      r->set_input_rate(rate.input_rate);
      r->set_output_rate(rate.output_rate);
    }
    return grpc::Status::OK;
  }
};

void clientWorld(harness::Ctx& ctx) {
  static PricingPeer* peer = nullptr;
  delete peer;
  peer = new PricingPeer();
  ctx.GRPC.Server(config::kPricing)->RegisterService(peer);
}

void clientFail(harness::Ctx& ctx) { ctx.GRPC.Fail("GetRates", grpc::StatusCode::UNAVAILABLE, "pricing restarting", 1, config::kPricing); }

void clientExpect(harness::Ctx& ctx, const Price& price, long long cost, const std::string& source, bool priced, const std::string& version) {
  ctx.Assert(price.cost_micros == cost && price.priced == priced && price.source == source && price.rate_version == version,
             "expected cost_micros=%d, priced=%t, source=%s, rate_version=%q; cost_of answered cost_micros=%d, priced=%t, source=%s, rate_version=%q",
             cost, priced, source, version, price.cost_micros, price.priced, price.source, price.rate_version);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  clientExpect(ctx, cost_of("gpt-4o", 1200, 300), 6000, "service", true, pricing::kVersion);
  const auto calls = ctx.GRPC.CallsTo("GetRates");
  ctx.Equal(calls.size(), 1, "one lookup must make one GetRates call; calls");
  ctx.Assert(calls[0].HasDeadline(), "the GetRates call carries no deadline: a hung pricing replica holds the report path as long as it hangs");
  ctx.Assert(0.15 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 0.25, "the deadline must be 200 ms, got %vs", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("GetRates", 5.0, config::kPricing);
  const int64_t started = ctx.Clock.Now();
  const Price price = cost_of("gpt-4o", 1200, 300);
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 0.3, "the lookup waited %.1f s on a pricing service that hangs: the deadline must cut it at 0.2 s", waited);
  clientExpect(ctx, price, 6000, "cache", true, pricing::kVersion);
}

void CheckCacheFallback(harness::Ctx& ctx) {
  clientWorld(ctx);
  clientExpect(ctx, cost_of("gpt-4o", 1200, 300), 6000, "service", true, pricing::kVersion);
  clientFail(ctx);
  const Price price = cost_of("gpt-4o-mini", 1200, 300);
  ctx.Equal(ctx.GRPC.CallsTo("GetRates").size(), 2, "a lookup asks the service first, then falls back; GetRates calls for two lookups");
  clientExpect(ctx, price, 360, "cache", true, pricing::kVersion);
}

void CheckCacheFreshness(harness::Ctx& ctx) {
  clientWorld(ctx);
  clientExpect(ctx, cost_of("gpt-4o", 1200, 300), 6000, "service", true, pricing::kVersion);
  ctx.Clock.Advance(3500);
  clientFail(ctx);
  clientExpect(ctx, cost_of("gpt-4o", 1200, 300), 6000, "cache", true, pricing::kVersion);
  ctx.Clock.Advance(101);
  clientFail(ctx);
  const Price price = cost_of("gpt-4o", 1200, 300);
  ctx.Equal(ctx.GRPC.CallsTo("GetRates").size(), 3, "every lookup asks the service; GetRates calls for three lookups");
  clientExpect(ctx, price, 0, "uncosted", false, "");
}

void CheckUncostedModel(harness::Ctx& ctx) {
  clientWorld(ctx);
  clientExpect(ctx, cost_of("llama-3-70b-local", 5000, 500), 0, "uncosted", false, "");
  clientExpect(ctx, cost_of("claude-sonnet-4", 1000, 1000), 18000, "service", true, pricing::kVersion);
}

void CheckFailureNotCached(harness::Ctx& ctx) {
  clientWorld(ctx);
  clientFail(ctx);
  clientExpect(ctx, cost_of("gpt-4o", 1200, 300), 0, "uncosted", false, "");
  const Price price = cost_of("gpt-4o", 1200, 300);
  ctx.Equal(ctx.GRPC.CallsTo("GetRates").size(), 2, "after a failed lookup the next one must ask the service again; GetRates calls for two lookups");
  clientExpect(ctx, price, 6000, "service", true, pricing::kVersion);
}
`,
  },
  debrief: `The client sorts what the pricing service can tell it into three answers: a rate it just said, a rate it said within the hour, and "unknown". Only the first two may become money; the third is \`uncosted\` so a reconcile job can price it later with the right table, instead of an invented rate that looks real on an invoice. The deadline is what makes the fallback reachable, since a call without one never fails, it only waits. Caching only replies, and stamping them, is what lets a bad minute pass without leaving a mark. Carrying the version on every price is the audit trail: a disputed charge points at the table that produced it. A production client would also refresh in the background and serve between refreshes, so the report path does not wait on pricing at all.`,
};
