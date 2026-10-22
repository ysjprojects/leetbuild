import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Pricing lookup with a stale-safe fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['meter', 'pricing', 'cache'],
  task: `## Task

The starter is a plausible model-generated draft: while the pricing service is healthy every report
gets a rate and the dashboard has a number. Every failure path is wrong. Find them, fix them, and
prove the fix.

Implement \`price_for(model)\`, the lookup the meter makes before it turns tokens into money:

- Each call carries a **200 ms** deadline (\`PRICE_DEADLINE_S = 0.2\`). The draft calls with no
  deadline, so one slow pricing replica holds a metering worker — and the request it is serving —
  open for as long as the replica takes.
- Rates come back as a **table** with the pricing **version** in it. A successful reply replaces
  the cached table and its \`fetched_at\`, and the version travels with every price you return so an
  invoice can be explained months later.
- When the call fails or misses its deadline the **cached table is the fallback**, and it is only
  usable while it is no older than \`PRICE_MAX_AGE_S = 3600\`. A table older than that is reported as
  **uncosted**; a price from last week is a wrong number with no way to tell.
- A model that is missing from the served table is **uncosted** — \`priced: false\`, \`source:
  "uncosted"\` — never a hardcoded rate. The draft's \`FALLBACK_RATE\` silently misprices every model
  the pricing team added after the draft was written, and nothing in the ledger says so.
- A **failure is never cached**. The draft writes its fallback rate into the per-model cache inside
  the \`except\` block, so one bad minute on the pricing service pins a wrong rate on that model for
  as long as the process lives.

**Failure mode the checks target.** The deadline is the loud one (a hung pricing call becomes a
hung request), the hardcoded rate is the quiet one (it looks like resilience and is a silent
misprice), and the cached failure is the one that survives every review: a cache that is written on
the error path turns a transient outage into a permanent, wrong answer — and the version field is
the only thing that would have made it visible on the invoice.`,
  sequence: {
    participants: ['Cost Meter', 'Pricing service', 'Rate table'],
    messages: [
      {from: 'Cost Meter', to: 'Pricing service', label: 'GetPrice · deadline 200 ms', kind: 'sync'},
      {from: 'Pricing service', to: 'Cost Meter', label: 'table + version / DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Cost Meter', to: 'Rate table', label: 'write table + fetched_at on success', kind: 'async'},
      {
        from: 'Cost Meter',
        to: 'Cost Meter',
        label: 'failure → cache older than PRICE_MAX_AGE_S → uncosted',
        kind: 'sync',
      },
      {from: 'Cost Meter', to: 'Rate table', label: 'serve the cached table on failure', kind: 'sync'},
      {from: 'Rate table', to: 'Cost Meter', label: 'rates + version', kind: 'reply'},
      {
        from: 'Cost Meter',
        to: 'Cost Meter',
        label: 'an unknown model is uncosted, never a hardcoded rate',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every lookup carries a 200 ms deadline',
      detail:
        'The call is created with a 200 ms deadline — a client timeout, a context with timeout, `withDeadlineAfter` or `set_deadline`. Without it one stuck pricing replica holds a metering worker open for as long as it likes.',
      match: {
        python: {all: [/PRICE_DEADLINE_S\s*=\s*0\.2/, /timeout=PRICE_DEADLINE_S/, /\.GetPrice\(/]},
        typescript: {
          all: [/PRICE_DEADLINE_MS\s*=\s*200/, /deadline:\s*Date\.now\(\)\s*\+\s*PRICE_DEADLINE_MS/, /\.GetPrice\(/],
        },
        go: {all: [/priceDeadlineMS\s*=\s*200/, /context\.WithTimeout/, /\.GetPrice\(/]},
        scala: {all: [/PriceDeadlineMs\s*=\s*200/, /withDeadlineAfter/, /\.getPrice\(/]},
        cpp: {all: [/kPriceDeadlineMs\s*=\s*200/, /set_deadline\(/, /->GetPrice\(/]},
      },
    },
    {
      id: 'cache-fallback',
      title: 'Falls back to the cached versioned table',
      detail:
        'A failed or timed-out call serves the cached table marked `source: "cache"` instead of a hardcoded rate. The draft has no table at all: it invents a rate and reports the lookup as priced.',
      match: {
        python: {all: [/PRICE_TABLE/, /except grpc\.RpcError/, /"cache"/]},
        typescript: {all: [/priceTable/, /catch\s*\{/, /'cache'/]},
        go: {all: [/priceTable/, /err != nil/, /"cache"/]},
        scala: {all: [/PriceTable/, /catch\s*\{/, /"cache"/]},
        cpp: {all: [/kPriceTable/, /status\.ok\(\)/, /"cache"/]},
      },
    },
    {
      id: 'cache-freshness',
      title: 'Refuses a table older than one hour',
      detail:
        'The fallback is bounded by `PRICE_MAX_AGE_S = 3600`, compared against the table’s `fetched_at` and the current time. A table with no age bound misprices every model whose rate changed since it was fetched, with nothing on the invoice to say so.',
      match: {
        python: {all: [/PRICE_MAX_AGE_S/, /time\.time\(\)/]},
        typescript: {all: [/PRICE_MAX_AGE_S/, /Date\.now\(\)/]},
        go: {all: [/priceMaxAgeS/, /time\.Now\(\)/]},
        scala: {all: [/PriceMaxAgeS/, /System\.currentTimeMillis/]},
        cpp: {all: [/kPriceMaxAgeS/, /system_clock::now\(\)/]},
      },
    },
    {
      id: 'uncosted-model',
      title: 'Reports an unknown model as uncosted',
      detail:
        'A model that is not in the served table comes back `uncosted` (`priced: false`) rather than at a hardcoded rate. The draft’s `FALLBACK_RATE` misprices every model it does not know and hides the fact from the ledger.',
      match: {
        python: {all: [/"uncosted"/], none: [/FALLBACK_RATE/]},
        typescript: {all: [/'uncosted'/], none: [/FALLBACK_RATE/]},
        go: {all: [/"uncosted"/], none: [/fallbackRate/]},
        scala: {all: [/"uncosted"/], none: [/FallbackRate/]},
        cpp: {all: [/"uncosted"/], none: [/kFallbackRate/]},
      },
    },
    {
      id: 'versioned-table',
      title: 'Versions the served rates and never caches a failure',
      detail:
        'Every reply carries the pricing version it was priced under, and the cache is written only after a successful call. Caching the failure path — as the draft does — pins a wrong rate for the life of the process and makes the misprice unauditable.',
      match: {
        python: {all: [/"version"/, /PRICE_TABLE/], none: [/PRICE_CACHE/]},
        typescript: {all: [/version/, /priceTable/], none: [/priceCache/]},
        go: {all: [/version/, /priceTable/], none: [/priceCache/]},
        scala: {all: [/version/, /PriceTable/], none: [/PriceCache/]},
        cpp: {all: [/version/, /kPriceTable/], none: [/price_cache/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import pricing_pb2
import pricing_pb2_grpc

FALLBACK_RATE = 0.002
PRICE_CACHE: dict[str, dict] = {}

channel = grpc.insecure_channel("pricing:9000")
pricing = pricing_pb2_grpc.PricingStub(channel)


def price_for(model: str) -> dict:
    # TODO: put the 200 ms deadline on the call, keep a versioned table as the fallback instead of
    # a hardcoded rate, answer uncosted for a model the table does not have, and never cache a
    # failed lookup.
    if model in PRICE_CACHE:
        return PRICE_CACHE[model]
    try:
        reply = pricing.GetPrice(pricing_pb2.PriceRequest(model=model))
        row = {
            "model": model,
            "priced": True,
            "input_per_1k": reply.input_per_1k,
            "output_per_1k": reply.output_per_1k,
        }
    except grpc.RpcError:
        row = {"model": model, "priced": True, "input_per_1k": FALLBACK_RATE, "output_per_1k": FALLBACK_RATE}
    PRICE_CACHE[model] = row
    return row
`,
      solution: `import time

import grpc

import pricing_pb2
import pricing_pb2_grpc

PRICE_DEADLINE_S = 0.2
PRICE_MAX_AGE_S = 3600

channel = grpc.insecure_channel("pricing:9000")
pricing = pricing_pb2_grpc.PricingStub(channel)

PRICE_TABLE: dict = {"version": "", "fetched_at": 0.0, "models": {}}


def bill(model: str, source: str, rates: dict | None) -> dict:
    """One price, tagged with where it came from and which pricing version it came from."""
    if rates is None:
        return {
            "model": model,
            "priced": False,
            "source": "uncosted",
            "input_per_1k": 0.0,
            "output_per_1k": 0.0,
            "version": PRICE_TABLE["version"],
        }
    return {
        "model": model,
        "priced": True,
        "source": source,
        "input_per_1k": rates["input_per_1k"],
        "output_per_1k": rates["output_per_1k"],
        "version": PRICE_TABLE["version"],
    }


def price_for(model: str) -> dict:
    try:
        reply = pricing.GetPrice(pricing_pb2.PriceRequest(model=model), timeout=PRICE_DEADLINE_S)
    except grpc.RpcError:
        # The pricing service is down or slow: the cached table is the fallback, and the failure is
        # never written into it.
        if time.time() - PRICE_TABLE["fetched_at"] > PRICE_MAX_AGE_S:
            return bill(model, "uncosted", None)
        return bill(model, "cache", PRICE_TABLE["models"].get(model))
    PRICE_TABLE["version"] = reply.version
    PRICE_TABLE["fetched_at"] = time.time()
    PRICE_TABLE["models"] = {
        row.model: {"input_per_1k": row.input_per_1k, "output_per_1k": row.output_per_1k} for row in reply.models
    }
    return bill(model, "table", PRICE_TABLE["models"].get(model))
`,
    },
    typescript: {
      starter: `/** priceFor: a model-generated draft with no deadline and a hardcoded rate. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const FALLBACK_RATE = 0.002;
const priceCache: Record<string, Price> = {};

interface Price {
  model: string;
  priced: boolean;
  input_per_1k: number;
  output_per_1k: number;
}

interface PricingClient {
  GetPrice(
    request: {model: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {version: string; models: unknown}) => void,
  ): grpc.ClientUnaryCall;
}

const {pricing} = grpc.loadPackageDefinition(protoLoader.loadSync('pricing.proto')) as unknown as {
  pricing: {Pricing: new (target: string, credentials: grpc.ChannelCredentials) => PricingClient};
};
const client = new pricing.Pricing('pricing:9000', grpc.credentials.createInsecure());

export async function priceFor(model: string): Promise<Price> {
  // TODO: put the 200 ms deadline on the call, keep a versioned table as the fallback instead of
  // a hardcoded rate, answer uncosted for a model the table does not have, and never cache a
  // failed lookup.
  const cached = priceCache[model];
  if (cached !== undefined) return cached;
  let row: Price;
  try {
    const reply = await new Promise<{input_per_1k: number; output_per_1k: number}>((resolve, reject) => {
      client.GetPrice({model}, {}, (error, value) => (error === null ? resolve(value as never) : reject(error)));
    });
    row = {model, priced: true, input_per_1k: reply.input_per_1k, output_per_1k: reply.output_per_1k};
  } catch {
    row = {model, priced: true, input_per_1k: FALLBACK_RATE, output_per_1k: FALLBACK_RATE};
  }
  priceCache[model] = row;
  return row;
}
`,
      solution: `/** priceFor: a 200 ms deadline, a versioned table, and no cached failures. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PRICE_DEADLINE_MS = 200;
const PRICE_MAX_AGE_S = 3600;

interface Price {
  model: string;
  priced: boolean;
  source: 'table' | 'cache' | 'uncosted';
  input_per_1k: number;
  output_per_1k: number;
  version: string;
}

interface Rate {
  input_per_1k: number;
  output_per_1k: number;
}

const priceTable: {version: string; fetched_at: number; models: Record<string, Rate>} = {
  version: '',
  fetched_at: 0,
  models: {},
};

interface PriceReply {
  version: string;
  models: {model: string; input_per_1k: number; output_per_1k: number}[];
}

interface PricingClient {
  GetPrice(
    request: {model: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: PriceReply) => void,
  ): grpc.ClientUnaryCall;
}

const {pricing} = grpc.loadPackageDefinition(protoLoader.loadSync('pricing.proto')) as unknown as {
  pricing: {Pricing: new (target: string, credentials: grpc.ChannelCredentials) => PricingClient};
};
const client = new pricing.Pricing('pricing:9000', grpc.credentials.createInsecure());

/** One price, tagged with where it came from and which pricing version it came from. */
function bill(model: string, source: Price['source'], rate: Rate | undefined): Price {
  if (rate === undefined) {
    return {
      model,
      priced: false,
      source: 'uncosted',
      input_per_1k: 0,
      output_per_1k: 0,
      version: priceTable.version,
    };
  }
  return {
    model,
    priced: true,
    source,
    input_per_1k: rate.input_per_1k,
    output_per_1k: rate.output_per_1k,
    version: priceTable.version,
  };
}

export async function priceFor(model: string): Promise<Price> {
  let reply: PriceReply;
  try {
    reply = await new Promise<PriceReply>((resolve, reject) => {
      client.GetPrice({model}, {deadline: Date.now() + PRICE_DEADLINE_MS}, (error, value) =>
        error === null ? resolve(value) : reject(error),
      );
    });
  } catch {
    // The pricing service is down or slow: the cached table is the fallback, and the failure is
    // never written into it.
    if (Math.floor(Date.now() / 1000) - priceTable.fetched_at > PRICE_MAX_AGE_S)
      return bill(model, 'uncosted', undefined);
    return bill(model, 'cache', priceTable.models[model]);
  }
  priceTable.version = reply.version;
  priceTable.fetched_at = Math.floor(Date.now() / 1000);
  priceTable.models = Object.fromEntries(reply.models.map(row => [row.model, row]));
  return bill(model, 'table', priceTable.models[model]);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"

	pricingpb "meter/pricingpb"
)

var (
	fallbackRate = 0.002
	priceCache   = map[string]Price{}
)

type Price struct {
	Model        string  \`json:"model"\`
	Priced       bool    \`json:"priced"\`
	InputPer1k   float64 \`json:"input_per_1k"\`
	OutputPer1k  float64 \`json:"output_per_1k"\`
	Source       string  \`json:"source"\`
	Version      string  \`json:"version"\`
}

func priceFor(ctx context.Context, model string) (Price, error) {
	// TODO: put the 200 ms deadline on the call, keep a versioned table as the fallback instead of
	// a hardcoded rate, answer uncosted for a model the table does not have, and never cache a
	// failed lookup.
	if cached, ok := priceCache[model]; ok {
		return cached, nil
	}
	reply, err := pricingClient.GetPrice(ctx, &pricingpb.PriceRequest{Model: model})
	row := Price{Model: model, Priced: true}
	if err != nil {
		row.InputPer1k = fallbackRate
		row.OutputPer1k = fallbackRate
	} else {
		row.InputPer1k = reply.InputPer1K
		row.OutputPer1k = reply.OutputPer1K
	}
	priceCache[model] = row
	return row, nil
}

var pricingClient *grpc.ClientConn
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"

	pricingpb "meter/pricingpb"
)

const (
	priceDeadlineMS = 200
	priceMaxAgeS    = 3600
)

type Price struct {
	Model       string  \`json:"model"\`
	Priced      bool    \`json:"priced"\`
	Source      string  \`json:"source"\`
	InputPer1k  float64 \`json:"input_per_1k"\`
	OutputPer1k float64 \`json:"output_per_1k"\`
	Version     string  \`json:"version"\`
}

type rate struct {
	inputPer1k  float64
	outputPer1k float64
}

var priceTable = struct {
	version   string
	fetchedAt time.Time
	models    map[string]rate
}{models: map[string]rate{}}

// bill tags one price with where it came from and which pricing version it came from.
func bill(model, source string, r rate, priced bool) Price {
	if !priced {
		return Price{Model: model, Priced: false, Source: "uncosted", Version: priceTable.version}
	}
	return Price{
		Model:       model,
		Priced:      true,
		Source:      source,
		InputPer1k:  r.inputPer1k,
		OutputPer1k: r.outputPer1k,
		Version:     priceTable.version,
	}
}

func priceFor(ctx context.Context, model string) (Price, error) {
	callCtx, cancel := context.WithTimeout(ctx, priceDeadlineMS*time.Millisecond)
	defer cancel()
	reply, err := pricingClient.GetPrice(callCtx, &pricingpb.PriceRequest{Model: model})
	if err != nil {
		// The pricing service is down or slow: the cached table is the fallback, and the failure is
		// never written into it.
		if time.Since(priceTable.fetchedAt) > priceMaxAgeS*time.Second {
			return bill(model, "uncosted", rate{}, false), nil
		}
		r, ok := priceTable.models[model]
		return bill(model, "cache", r, ok), nil
	}
	priceTable.version = reply.Version
	priceTable.fetchedAt = time.Now()
	priceTable.models = map[string]rate{}
	for _, row := range reply.Models {
		priceTable.models[row.Model] = rate{inputPer1k: row.InputPer1K, outputPer1k: row.OutputPer1K}
	}
	r, ok := priceTable.models[model]
	return bill(model, "table", r, ok), nil
}

var pricingClient *grpc.ClientConn
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

import scala.collection.mutable

object PricingClient {
  val FallbackRate = 0.002
  val priceCache: mutable.Map[String, Map[String, Any]] = mutable.Map.empty

  private val channel = ManagedChannelBuilder.forAddress("pricing", 9000).usePlaintext().build()
  private val stub = PricingGrpc.blockingStub(channel)

  def priceFor(model: String): Map[String, Any] = {
    // TODO: put the 200 ms deadline on the call, keep a versioned table as the fallback instead of
    // a hardcoded rate, answer uncosted for a model the table does not have, and never cache a
    // failed lookup.
    priceCache.getOrElseUpdate(
      model, {
        try {
          val reply = stub.getPrice(PriceRequest(model))
          Map(
            "model" -> model,
            "priced" -> true,
            "input_per_1k" -> reply.inputPer1K,
            "output_per_1k" -> reply.outputPer1K
          )
        } catch {
          case _: io.grpc.StatusRuntimeException =>
            Map("model" -> model, "priced" -> true, "input_per_1k" -> FallbackRate, "output_per_1k" -> FallbackRate)
        }
      }
    )
  }
}
`,
      solution: `import io.grpc.ManagedChannelBuilder
import io.grpc.Deadline

object PricingClient {
  val PriceDeadlineMs = 200
  val PriceMaxAgeS = 3600

  private val channel = ManagedChannelBuilder.forAddress("pricing", 9000).usePlaintext().build()
  private val stub = PricingGrpc.blockingStub(channel)

  var PriceTable: Map[String, Map[String, Double]] = Map.empty
  var priceTableVersion: String = ""
  var priceTableFetchedAt: Long = 0L

  /** One price, tagged with where it came from and which pricing version it came from. */
  private def bill(model: String, source: String, rates: Option[Map[String, Double]]): Map[String, Any] =
    rates match {
      case None => Map(
          "model" -> model,
          "priced" -> false,
          "source" -> "uncosted",
          "input_per_1k" -> 0.0,
          "output_per_1k" -> 0.0,
          "version" -> priceTableVersion
        )
      case Some(r) => Map(
          "model" -> model,
          "priced" -> true,
          "source" -> source,
          "input_per_1k" -> r("input_per_1k"),
          "output_per_1k" -> r("output_per_1k"),
          "version" -> priceTableVersion
        )
    }

  def priceFor(model: String): Map[String, Any] = {
    val reply =
      try {
        Some(stub.withDeadlineAfter(PriceDeadlineMs.toLong, java.util.concurrent.TimeUnit.MILLISECONDS).getPrice(PriceRequest(model)))
      } catch {
        case _: io.grpc.StatusRuntimeException =>
          // The pricing service is down or slow: the cached table is the fallback, and the failure
          // is never written into it.
          val ageS = (System.currentTimeMillis() - priceTableFetchedAt) / 1000
          if (ageS > PriceMaxAgeS) return bill(model, "uncosted", None)
          return bill(model, "cache", PriceTable.get(model))
      }
    val table = reply.get
    priceTableVersion = table.version
    priceTableFetchedAt = System.currentTimeMillis()
    PriceTable = table.models.map(row => row.model -> Map("input_per_1k" -> row.inputPer1K, "output_per_1k" -> row.outputPer1K)).toMap
    bill(model, "table", PriceTable.get(model))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>
#include <unordered_map>

#include <nlohmann/json.hpp>

#include "pricing.grpc.pb.h"

using json = nlohmann::json;

const double kFallbackRate = 0.002;
std::unordered_map<std::string, json> price_cache;

json priceFor(const std::string& model) {
  // TODO: put the 200 ms deadline on the call, keep a versioned table as the fallback instead of a
  // hardcoded rate, answer uncosted for a model the table does not have, and never cache a failed
  // lookup.
  const auto cached = price_cache.find(model);
  if (cached != price_cache.end()) return cached->second;

  grpc::ClientContext ctx;
  pricing::PriceRequest request;
  request.set_model(model);
  pricing::PriceReply reply;
  json row = {{"model", model}, {"priced", true}};
  if (stub->GetPrice(&ctx, request, &reply).ok()) {
    row["input_per_1k"] = reply.input_per_1k();
    row["output_per_1k"] = reply.output_per_1k();
  } else {
    row["input_per_1k"] = kFallbackRate;
    row["output_per_1k"] = kFallbackRate;
  }
  price_cache[model] = row;
  return row;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <unordered_map>

#include <nlohmann/json.hpp>

#include "pricing.grpc.pb.h"

using json = nlohmann::json;

constexpr long long kPriceDeadlineMs = 200;
constexpr long long kPriceMaxAgeS = 3600;

struct Rate {
  double input_per_1k = 0.0;
  double output_per_1k = 0.0;
};

struct PriceTable {
  std::string version;
  std::chrono::system_clock::time_point fetched_at;
  std::unordered_map<std::string, Rate> models;
};

PriceTable kPriceTableImpl;
const PriceTable* kPriceTable = &kPriceTableImpl;

// bill tags one price with where it came from and which pricing version it came from.
json bill(const std::string& model, const std::string& source, const Rate* rate) {
  if (rate == nullptr) {
    return json{{"model", model},
                {"priced", false},
                {"source", "uncosted"},
                {"input_per_1k", 0.0},
                {"output_per_1k", 0.0},
                {"version", kPriceTable->version}};
  }
  return json{{"model", model},
              {"priced", true},
              {"source", source},
              {"input_per_1k", rate->input_per_1k},
              {"output_per_1k", rate->output_per_1k},
              {"version", kPriceTable->version}};
}

json priceFor(const std::string& model) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kPriceDeadlineMs));
  pricing::PriceRequest request;
  request.set_model(model);
  pricing::PriceReply reply;
  const auto status = stub->GetPrice(&ctx, request, &reply);
  if (!status.ok()) {
    // The pricing service is down or slow: the cached table is the fallback, and the failure is
    // never written into it.
    const auto age_s = std::chrono::duration_cast<std::chrono::seconds>(
                           std::chrono::system_clock::now() - kPriceTable->fetched_at)
                           .count();
    if (age_s > kPriceMaxAgeS) return bill(model, "uncosted", nullptr);
    const auto cached = kPriceTable->models.find(model);
    return bill(model, "cache", cached == kPriceTable->models.end() ? nullptr : &cached->second);
  }
  kPriceTableImpl.version = reply.version();
  kPriceTableImpl.fetched_at = std::chrono::system_clock::now();
  kPriceTableImpl.models.clear();
  for (const auto& row : reply.models()) {
    kPriceTableImpl.models[row.model()] = Rate{row.input_per_1k(), row.output_per_1k()};
  }
  const auto served = kPriceTable->models.find(model);
  return bill(model, "table", served == kPriceTable->models.end() ? nullptr : &served->second);
}
`,
    },
  },
  hints: [
    'The deadline goes on the call: `timeout=` in Python, `deadline:` in TypeScript, a `context.WithTimeout` in Go, `withDeadlineAfter` in Scala, `set_deadline` in C++. A metering path with an unbounded dependency blocks every request behind it, not just the slow one.',
    'Two fields make a cached table trustworthy: the pricing `version` and the time it was fetched. Serve the table on failure only while it is within `PRICE_MAX_AGE_S`, and return `uncosted` when it is not — a wrong rate with a version attached is still wrong, and an honest gap is what finance can chase.',
    'Read the error branch twice: nothing in it may write the cache. Storing a fallback rate there is how an outage becomes a permanent misprice; only a successful reply may replace the table and its timestamp.',
  ],
  debrief: `The interviewer is testing failure policy on a dependency that decides money. Three properties matter: the call must be bounded (a deadline, always), the fallback must be a real artifact rather than an invented number (the cached, versioned table, bounded by age), and the fallback must never harden into state (no cache writes on the error path, and an unknown model answered as uncosted). The version field is the part senior candidates add unprompted: without it nobody can answer "why was I charged this rate in March" — and with it, a pricing bug becomes an auditable row instead of an argument. Real meters add cache prewarming before deploys, a breaker in front of the pricing service so a sick dependency is not hammered, and a reconciliation job that reprices a sample of past usage against the current table.`,
};
