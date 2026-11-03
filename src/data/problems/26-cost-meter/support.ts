/**
 * Hand-written support modules the cost-meter steps import but no step builds: the `meter` package.
 * `config` is the contract every step agrees on (the pricing address, the topic, the window and its
 * key, the budget); `usage` is the usage store behind POST /v1/usage (Redis); `records` the usage
 * record step 4 publishes; `outbox` the rows kept for the relay when the broker refuses a produce; and
 * `pricing` the deterministic rate table the checks serve over gRPC in place of the pricing service.
 */
import {CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'meter/__init__.py': '',
  'meter/config.py': `"""Addresses, topics, keys and limits every step of meterd agrees on."""
# The pricing service's gRPC address: a stand-in served by the checks (meter.pricing).
PRICING = "pricing:9000"
# One event per metered report, keyed by tenant, for the billing consumer.
TOPIC = "billing.usage"
# Spend is metered per tenant per hour window; a window's key outlives the window by GRACE_S.
WINDOW_S = 3600
GRACE_S = 3600
# What a tenant may spend in one window, in micro-dollars (the budget limiter enforces it).
BUDGET_MICROS = 5_000_000

# A window is a hash: input_tokens, output_tokens, cost_micros (integer micro-dollars) and events.
# The budget limiter reads the same key.


def bucket_of(now: float) -> int:
    """The hour window a unix time falls in."""
    return int(now // WINDOW_S)


def window_key(tenant: str, bucket: int) -> str:
    return f"meter:{tenant}:{bucket}"
`,
  'meter/usage.py': `"""The usage store (provided): one row per (tenant, Idempotency-Key), kept for a day."""
import json

import redis

USAGE_TTL_S = 86_400

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class UsageStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The row this tenant stored under idem_key, None when there is none."""
        raw = r.get(f"usage:{tenant}:{idem_key}")
        return json.loads(raw) if raw else None

    def put(self, tenant: str, idem_key: str, row: dict) -> None:
        """Store the row under (tenant, idem_key) for USAGE_TTL_S."""
        r.set(f"usage:{tenant}:{idem_key}", json.dumps(row), ex=USAGE_TTL_S)


store = UsageStore()
`,
  'meter/records.py': `"""The usage record (provided): what the metering path hands to publish_usage once a report is priced."""
from dataclasses import dataclass


@dataclass
class UsageRecord:
    usage_id: str
    idempotency_key: str
    tenant_id: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_micros: int
    rate_version: str
    # The completion is tenant content: the meter has it, the topic and the logs must not.
    output_text: str
`,
  'meter/outbox.py': `"""The outbox (provided): events the broker refused, kept for the relay to republish."""
import json

import redis

OUTBOX_KEY = "billing:outbox"

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class OutboxStore:
    def insert_outbox(self, event: dict) -> None:
        """Durably keep an event the broker refused."""
        r.rpush(OUTBOX_KEY, json.dumps(event))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange(OUTBOX_KEY, 0, -1)]


outbox = OutboxStore()
`,
  'meter/pricing.py': `"""
The stand-in for the pricing service. The checks serve it over gRPC (Pricing.GetRates at
meter.config.PRICING); the meter's code never reads it directly. Rates are micro-dollars per
1 000 tokens, (input, output), under one version.
"""
VERSION = "rates-2026-11-01"
RATES = {
    "gpt-4o": (2500, 10_000),
    "gpt-4o-mini": (150, 600),
    "claude-sonnet-4": (3000, 15_000),
}
`,
};

export const supportModulesTs: Record<string, string> = {
  'meter/config.ts': `/** Addresses, topics, keys and limits every step of meterd agrees on. */
/** The pricing service's gRPC address: a stand-in served by the checks (meter/pricing). */
export const PRICING = 'pricing:9000';
/** One event per metered report, keyed by tenant, for the billing consumer. */
export const TOPIC = 'billing.usage';
/** Spend is metered per tenant per hour window; a window's key outlives the window by GRACE_S. */
export const WINDOW_S = 3600;
export const GRACE_S = 3600;
/** What a tenant may spend in one window, in micro-dollars (the budget limiter enforces it). */
export const BUDGET_MICROS = 5_000_000;

// A window is a hash: input_tokens, output_tokens, cost_micros (integer micro-dollars) and events.
// The budget limiter reads the same key.

/** The hour window a unix time (seconds) falls in. */
export const bucketOf = (nowS: number): number => Math.floor(nowS / WINDOW_S);
export const windowKey = (tenant: string, bucket: number): string => \`meter:\${tenant}:\${bucket}\`;
`,
  'meter/usage.ts': `/** The usage store (provided): one row per (tenant, Idempotency-Key), kept for a day. */
import Redis from 'ioredis';

export const USAGE_TTL_S = 86_400;

const redis = new Redis({host: 'redis', port: 6379});

export interface UsageRow {
  usage_id: string;
  tenant: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export const store = {
  /** The row this tenant stored under idemKey, null when there is none. */
  async get(tenant: string, idemKey: string): Promise<UsageRow | null> {
    const raw = await redis.get(\`usage:\${tenant}:\${idemKey}\`);
    return raw === null ? null : (JSON.parse(raw) as UsageRow);
  },

  /** Store the row under (tenant, idemKey) for USAGE_TTL_S. */
  async put(tenant: string, idemKey: string, row: UsageRow): Promise<void> {
    await redis.set(\`usage:\${tenant}:\${idemKey}\`, JSON.stringify(row), 'EX', USAGE_TTL_S);
  },
};
`,
  'meter/records.ts': `/** The usage record (provided): what the metering path hands to publishUsage once a report is priced. */
export interface UsageRecord {
  usage_id: string;
  idempotency_key: string;
  tenant_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  rate_version: string;
  /** The completion is tenant content: the meter has it, the topic and the logs must not. */
  output_text: string;
}
`,
  'meter/outbox.ts': `/** The outbox (provided): events the broker refused, kept for the relay to republish. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const OUTBOX_KEY = 'billing:outbox';

export const outbox = {
  /** Durably keep an event the broker refused. */
  async insertOutbox(event: Record<string, unknown>): Promise<void> {
    await redis.rpush(OUTBOX_KEY, JSON.stringify(event));
  },

  async rows(): Promise<Record<string, unknown>[]> {
    return (await redis.lrange(OUTBOX_KEY, 0, -1)).map(row => JSON.parse(row) as Record<string, unknown>);
  },
};
`,
  'meter/pricing.ts': `/**
 * The stand-in for the pricing service. The checks serve it over gRPC (Pricing.GetRates at
 * meter/config's PRICING); the meter's code never reads it directly. Rates are micro-dollars per
 * 1 000 tokens, [input, output], under one version.
 */
export const VERSION = 'rates-2026-11-01';
export const RATES: Record<string, [number, number]> = {
  'gpt-4o': [2500, 10_000],
  'gpt-4o-mini': [150, 600],
  'claude-sonnet-4': [3000, 15_000],
};
`,
};

/** The Go twins: the same \`meter\` packages, imported as meter/config, meter/usage, meter/records, meter/outbox, meter/pricing. */
export const supportModulesGo: Record<string, string> = {
  'meter/config/config.go': `// Package config holds the addresses, topics, keys and limits every step of meterd agrees on.
package config

import "strconv"

const (
	// Pricing is the pricing service's gRPC address: a stand-in served by the checks (meter/pricing).
	Pricing = "pricing:9000"
	// Topic carries one event per metered report, keyed by tenant, for the billing consumer.
	Topic = "billing.usage"
	// WindowSeconds: spend is metered per tenant per hour window; a window's key outlives the window
	// by GraceSeconds.
	WindowSeconds = 3600
	GraceSeconds  = 3600
	// BudgetMicros is what a tenant may spend in one window, in micro-dollars (the budget limiter
	// enforces it).
	BudgetMicros = 5_000_000
)

// A window is a hash: input_tokens, output_tokens, cost_micros (integer micro-dollars) and events.
// The budget limiter reads the same key.

// BucketOf is the hour window a unix time (seconds) falls in.
func BucketOf(unixSeconds int64) int64 { return unixSeconds / WindowSeconds }

func WindowKey(tenant string, bucket int64) string {
	return "meter:" + tenant + ":" + strconv.FormatInt(bucket, 10)
}
`,
  'meter/usage/usage.go': `// Package usage is the usage store (provided): one row per (tenant, Idempotency-Key), kept for a day.
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const TTL = 24 * time.Hour

// Row is a stored usage report as the API answers it.
type Row struct {
	UsageID      string \`json:"usage_id"\`
	Tenant       string \`json:"tenant"\`
	Model        string \`json:"model"\`
	InputTokens  int64  \`json:"input_tokens"\`
	OutputTokens int64  \`json:"output_tokens"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the row tenant stored under idemKey; nil when there is none.
func Get(ctx context.Context, tenant, idemKey string) (*Row, error) {
	raw, err := rdb.Get(ctx, "usage:"+tenant+":"+idemKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var row Row
	if err := json.Unmarshal(raw, &row); err != nil {
		return nil, err
	}
	return &row, nil
}

// Put stores the row under (tenant, idemKey) for TTL.
func Put(ctx context.Context, tenant, idemKey string, row Row) error {
	doc, err := json.Marshal(row)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "usage:"+tenant+":"+idemKey, doc, TTL).Err()
}
`,
  'meter/records/records.go': `// Package records holds the usage record (provided): what the metering path hands to publishUsage
// once a report is priced.
package records

// UsageRecord is one priced report. OutputText is tenant content: the meter has it, the topic and
// the logs must not.
type UsageRecord struct {
	UsageID        string
	IdempotencyKey string
	TenantID       string
	Model          string
	InputTokens    int64
	OutputTokens   int64
	CostMicros     int64
	RateVersion    string
	OutputText     string
}
`,
  'meter/outbox/outbox.go': `// Package outbox keeps the events the broker refused (provided), for the relay to republish.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "billing:outbox"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert durably keeps an event the broker refused (the event's JSON).
func Insert(ctx context.Context, event []byte) error {
	return rdb.RPush(ctx, Key, event).Err()
}

// Rows are the kept events, decoded, oldest first.
func Rows(ctx context.Context) ([]map[string]any, error) {
	raw, err := rdb.LRange(ctx, Key, 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		var row map[string]any
		if err := json.Unmarshal([]byte(r), &row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
  'meter/pricing/pricing.go': `// Package pricing is the stand-in for the pricing service. The checks serve it over gRPC
// (Pricing.GetRates at config.Pricing); the meter's code never reads it directly. Rates are
// micro-dollars per 1 000 tokens, {input, output}, under one version.
package pricing

const Version = "rates-2026-11-01"

// Models lists the priced models in a fixed order.
var Models = []string{"gpt-4o", "gpt-4o-mini", "claude-sonnet-4"}

var Rates = map[string][2]int32{
	"gpt-4o":          {2500, 10_000},
	"gpt-4o-mini":     {150, 600},
	"claude-sonnet-4": {3000, 15_000},
}
`,
};

/** The C++ twins as headers (meter/*.h), plus ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'ids.h': CPP_IDS_H,
  'meter/config.h': `// Addresses, topics, keys and limits every step of meterd agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The pricing service's gRPC address: a stand-in served by the checks (meter/pricing.h).
inline constexpr const char* kPricing = "pricing:9000";
// One event per metered report, keyed by tenant, for the billing consumer.
inline constexpr const char* kTopic = "billing.usage";
// Spend is metered per tenant per hour window; a window's key outlives the window by kGraceSeconds.
inline constexpr long long kWindowSeconds = 3600;
inline constexpr long long kGraceSeconds = 3600;
// What a tenant may spend in one window, in micro-dollars (the budget limiter enforces it).
inline constexpr long long kBudgetMicros = 5000000;

// A window is a hash: input_tokens, output_tokens, cost_micros (integer micro-dollars) and events.
// The budget limiter reads the same key.

// The hour window a unix time (seconds) falls in.
inline long long bucket_of(long long unix_seconds) { return unix_seconds / kWindowSeconds; }
inline std::string window_key(const std::string& tenant, long long bucket) {
  return "meter:" + tenant + ":" + std::to_string(bucket);
}

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'meter/usage.h': `// The usage store (provided): one row per (tenant, Idempotency-Key), kept for a day.
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "meter/config.h"

namespace usage {

inline constexpr long long kTtlSeconds = 86400;

// The row this tenant stored under idem_key, if any.
inline std::optional<nlohmann::json> get(const std::string& tenant, const std::string& idem_key) {
  const auto raw = config::redis().get("usage:" + tenant + ":" + idem_key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Store the row under (tenant, idem_key) for kTtlSeconds.
inline void put(const std::string& tenant, const std::string& idem_key, const nlohmann::json& row) {
  config::redis().set("usage:" + tenant + ":" + idem_key, row.dump(), kTtlSeconds);
}

}  // namespace usage
`,
  'meter/records.h': `// The usage record (provided): what the metering path hands to publish_usage once a report is priced.
#pragma once

#include <string>

namespace records {

// One priced report. output_text is tenant content: the meter has it, the topic and the logs must not.
struct UsageRecord {
  std::string usage_id;
  std::string idempotency_key;
  std::string tenant_id;
  std::string model;
  long long input_tokens = 0;
  long long output_tokens = 0;
  long long cost_micros = 0;
  std::string rate_version;
  std::string output_text;
};

}  // namespace records
`,
  'meter/outbox.h': `// The outbox (provided): events the broker refused, kept for the relay to republish.
#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "meter/config.h"

namespace outbox {

inline constexpr const char* kKey = "billing:outbox";

// Durably keep an event the broker refused (its JSON).
inline void insert_outbox(const std::string& event_json) { config::redis().rpush(kKey, event_json); }

// The kept events, decoded, oldest first.
inline std::vector<nlohmann::json> rows() {
  std::vector<nlohmann::json> out;
  for (const auto& row : config::redis().lrange(kKey, 0, -1)) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
  'meter/pricing.h': `// The stand-in for the pricing service. The checks serve it over gRPC (Pricing.GetRates at
// config::kPricing); the meter's code never reads it directly. Rates are micro-dollars per
// 1 000 tokens, {input, output}, under one version.
#pragma once

#include <string>
#include <vector>

namespace pricing {

inline constexpr const char* kVersion = "rates-2026-11-01";

struct Rate {
  std::string model;
  int input_rate;
  int output_rate;
};

inline const std::vector<Rate>& rates() {
  static const std::vector<Rate> table = {
      {"gpt-4o", 2500, 10000},
      {"gpt-4o-mini", 150, 600},
      {"claude-sonnet-4", 3000, 15000},
  };
  return table;
}

}  // namespace pricing
`,
};

/** The Scala twins: the same \`meter\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('meter', 'Config')]: `package meter

/** Addresses, topics, keys and limits every step of meterd agrees on. */
object Config {
  /** The pricing service's gRPC address: a stand-in served by the checks. */
  val Pricing = "pricing:9000"
  /** One event per metered report, keyed by tenant, for the billing consumer. */
  val Topic = "billing.usage"
  /** Spend is metered per tenant per hour window; a window's key outlives the window by GraceSeconds. */
  val WindowSeconds = 3600L
  val GraceSeconds = 3600L
  /** What a tenant may spend in one window, in micro-dollars (the budget limiter enforces it). */
  val BudgetMicros = 5000000L

  // A window is a hash: input_tokens, output_tokens, cost_micros (integer micro-dollars) and events.
  // The budget limiter reads the same key.

  /** The hour window a unix time (seconds) falls in. */
  def bucketOf(unixSeconds: Long): Long = unixSeconds / WindowSeconds
  def windowKey(tenant: String, bucket: Long): String = s"meter:$tenant:$bucket"
}
`,
  [scalaPath('meter', 'Usage')]: `package meter

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** A stored usage report as the API answers it. */
final case class UsageRow(usage_id: String, tenant: String, model: String, input_tokens: Long, output_tokens: Long)

/** The usage store (provided): one row per (tenant, Idempotency-Key), kept for a day. */
object Usage {
  val TtlSeconds = 86400L
  private val jedis = new JedisPooled("redis", 6379)

  private def encode(row: UsageRow): String = ujson.write(
    ujson.Obj(
      "usage_id" -> row.usage_id,
      "tenant" -> row.tenant,
      "model" -> row.model,
      "input_tokens" -> row.input_tokens.toDouble,
      "output_tokens" -> row.output_tokens.toDouble
    )
  )

  private def decode(raw: String): UsageRow = {
    val j = ujson.read(raw)
    UsageRow(j("usage_id").str, j("tenant").str, j("model").str, j("input_tokens").num.toLong, j("output_tokens").num.toLong)
  }

  /** The row this tenant stored under idemKey, if any. */
  def get(tenant: String, idemKey: String): Option[UsageRow] =
    Option(jedis.get(s"usage:$tenant:$idemKey")).map(decode)

  /** Store the row under (tenant, idemKey) for TtlSeconds. */
  def put(tenant: String, idemKey: String, row: UsageRow): Unit = {
    jedis.set(s"usage:$tenant:$idemKey", encode(row), SetParams.setParams().ex(TtlSeconds))
    ()
  }
}
`,
  [scalaPath('meter', 'UsageRecord')]: `package meter

/**
 * The usage record (provided): what the metering path hands to publishUsage once a report is
 * priced. The completion is tenant content: the meter has it, the topic and the logs must not.
 */
final case class UsageRecord(
    usage_id: String,
    idempotency_key: String,
    tenant_id: String,
    model: String,
    input_tokens: Long,
    output_tokens: Long,
    cost_micros: Long,
    rate_version: String,
    output_text: String
)
`,
  [scalaPath('meter', 'Outbox')]: `package meter

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The outbox (provided): events the broker refused, kept for the relay to republish. */
object Outbox {
  val Key = "billing:outbox"
  private val jedis = new JedisPooled("redis", 6379)

  /** Durably keep an event the broker refused (its JSON). */
  def insertOutbox(eventJson: String): Unit = {
    jedis.rpush(Key, eventJson)
    ()
  }

  /** The kept events, decoded, oldest first. */
  def rows(): List[ujson.Value] = jedis.lrange(Key, 0, -1).asScala.toList.map(ujson.read(_))
}
`,
};
