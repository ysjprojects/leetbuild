/**
 * Hand-written support modules the prompt-cache steps import but no step builds: the `pcache`
 * package. `config` is the contract every step agrees on (the model server's address, the topic, the
 * entry lifetime, the price table, the stats keys); `record` the shapes of a cache entry and of a
 * miss-path answer; and `llm` the deterministic stand-in the checks serve over gRPC in place of the
 * model server.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'pcache/__init__.py': '',
  'pcache/config.py': `"""Addresses, topics, keys and prices every step of the prompt cache agrees on."""
# The model server's gRPC address: a stand-in served by the checks (pcache.llm).
MODEL = "model:9000"
# One event per cache decision (hit or miss), keyed by tenant, for the stats consumer.
TOPIC = "cache.result"
# A cache entry lives as long as its prompt version is served: six hours from the fill.
VERSION_TTL_S = 6 * 3600

# What 1 000 completion tokens cost on the model each prompt version runs on (USD). A version that
# is not listed is priced at the default row.
PRICE_PER_1K_USD = {7: 0.0020, 8: 0.0015}
DEFAULT_PRICE_PER_1K_USD = 0.0020


def price_per_1k(version: int) -> float:
    return PRICE_PER_1K_USD.get(version, DEFAULT_PRICE_PER_1K_USD)


# Entries live under pc:{tenant}:{version}:{digest} (step 1 builds the key). The stats consumer keeps,
# per (tenant, prompt version), a hash of hits, misses, fill_ms (the summed latency of misses) and
# tokens_saved (completion tokens served from the cache), and per tenant the set of its versions.
def stats_key(tenant: str, version: int) -> str:
    return f"pc-stats:{tenant}:{version}"


def versions_key(tenant: str) -> str:
    return f"pc-versions:{tenant}"
`,
  'pcache/llm.py': `"""
The stand-in for the model server. The checks serve it over gRPC (Model.Complete at
pcache.config.MODEL); the cache's code never calls it directly. Deterministic on purpose: the course
grades what the cache does around the model, not the prose.

complete(prefix, temperature) -> (text, finish_reason, completion_tokens):
  a prefix starting with "refuse:" is declined by policy ("", "content_filter", 0)
  a prefix starting with "long:" is cut at the token limit (finish_reason "length")
  anything else is answered in one line that quotes the prefix (finish_reason "stop")
  a temperature above 0 marks the answer as sampled
"""


def complete(prefix: str, temperature: float) -> tuple[str, str, int]:
    if prefix.startswith("refuse:"):
        return "", "content_filter", 0
    head = "Sampled answer" if temperature > 0 else "Answer"
    text = f"{head}: {prefix.strip()}"
    reason = "length" if prefix.startswith("long:") else "stop"
    return text, reason, len(text.split())
`,
};

export const supportModulesTs: Record<string, string> = {
  'pcache/config.ts': `/** Addresses, topics, keys and prices every step of the prompt cache agrees on. */
/** The model server's gRPC address: a stand-in served by the checks (pcache/llm). */
export const MODEL = 'model:9000';
/** One event per cache decision (hit or miss), keyed by tenant, for the stats consumer. */
export const TOPIC = 'cache.result';
/** A cache entry lives as long as its prompt version is served: six hours from the fill. */
export const VERSION_TTL_S = 6 * 3600;

/** What 1 000 completion tokens cost on the model each prompt version runs on (USD). */
export const PRICE_PER_1K_USD: Record<number, number> = {7: 0.002, 8: 0.0015};
/** The price of a version the table does not list. */
export const DEFAULT_PRICE_PER_1K_USD = 0.002;

export const pricePer1k = (version: number): number => PRICE_PER_1K_USD[version] ?? DEFAULT_PRICE_PER_1K_USD;

// Entries live under pc:{tenant}:{version}:{digest} (step 1 builds the key). The stats consumer keeps,
// per (tenant, prompt version), a hash of hits, misses, fill_ms (the summed latency of misses) and
// tokens_saved (completion tokens served from the cache), and per tenant the set of its versions.
export const statsKey = (tenant: string, version: number): string => \`pc-stats:\${tenant}:\${version}\`;
export const versionsKey = (tenant: string): string => \`pc-versions:\${tenant}\`;
`,
  'pcache/record.ts': `/** A cache entry (provided): the JSON stored under pc:{tenant}:{version}:{digest}. */
export interface CacheRecord {
  tenant: string;
  version: number;
  completion: string;
  /** Completion tokens: what a hit saves. */
  tokens: number;
}

/** What the miss path answers: cached (stored and served), uncached (served, not stored), refused, error. */
export interface Miss {
  status: 'cached' | 'uncached' | 'refused' | 'error';
  completion: string;
  tokens: number;
}
`,
  'pcache/llm.ts': `/**
 * The stand-in for the model server. The checks serve it over gRPC (Model.Complete at pcache/config's
 * MODEL); the cache's code never calls it directly. Deterministic on purpose: the course grades what
 * the cache does around the model, not the prose.
 *
 * complete(prefix, temperature) → {text, finish_reason, completion_tokens}:
 *   a prefix starting with "refuse:" is declined by policy ('', 'content_filter', 0)
 *   a prefix starting with "long:" is cut at the token limit (finish_reason 'length')
 *   anything else is answered in one line that quotes the prefix (finish_reason 'stop')
 *   a temperature above 0 marks the answer as sampled
 */
export function complete(
  prefix: string,
  temperature: number,
): {text: string; finish_reason: string; completion_tokens: number} {
  if (prefix.startsWith('refuse:')) return {text: '', finish_reason: 'content_filter', completion_tokens: 0};
  const text = \`\${temperature > 0 ? 'Sampled answer' : 'Answer'}: \${prefix.trim()}\`;
  const reason = prefix.startsWith('long:') ? 'length' : 'stop';
  return {text, finish_reason: reason, completion_tokens: text.split(/\\s+/).length};
}
`,
};

/** The Go twins: the same \`pcache\` packages, imported as pcache/config, pcache/record, pcache/llm. */
export const supportModulesGo: Record<string, string> = {
  'pcache/config/config.go': `// Package config holds the addresses, topics, keys and prices every step of the prompt cache agrees on.
package config

import "strconv"

const (
	// Model is the model server's gRPC address: a stand-in served by the checks (pcache/llm).
	Model = "model:9000"
	// Topic carries one event per cache decision (hit or miss), keyed by tenant, for the stats consumer.
	Topic = "cache.result"
	// VersionTTLSeconds: a cache entry lives as long as its prompt version is served, six hours from the fill.
	VersionTTLSeconds = 6 * 3600
	// DefaultPricePer1kUSD prices a version the table does not list.
	DefaultPricePer1kUSD = 0.0020
)

// PricePer1kUSD is what 1 000 completion tokens cost on the model each prompt version runs on.
var PricePer1kUSD = map[int]float64{7: 0.0020, 8: 0.0015}

func PricePer1k(version int) float64 {
	if price, ok := PricePer1kUSD[version]; ok {
		return price
	}
	return DefaultPricePer1kUSD
}

// Entries live under pc:{tenant}:{version}:{digest} (step 1 builds the key). The stats consumer keeps,
// per (tenant, prompt version), a hash of hits, misses, fill_ms (the summed latency of misses) and
// tokens_saved (completion tokens served from the cache), and per tenant the set of its versions.
func StatsKey(tenant string, version int) string {
	return "pc-stats:" + tenant + ":" + strconv.Itoa(version)
}

func VersionsKey(tenant string) string { return "pc-versions:" + tenant }
`,
  'pcache/record/record.go': `// Package record holds the shapes the steps pass around (provided): a cache entry and a miss-path answer.
package record

// Record is a cache entry: the JSON stored under pc:{tenant}:{version}:{digest}.
type Record struct {
	Tenant     string \`json:"tenant"\`
	Version    int    \`json:"version"\`
	Completion string \`json:"completion"\`
	// Tokens are the completion tokens: what a hit saves.
	Tokens int \`json:"tokens"\`
}

// Miss is what the miss path answers. Status: cached (stored and served), uncached (served, not
// stored), refused, error.
type Miss struct {
	Status     string
	Completion string
	Tokens     int
}
`,
  'pcache/llm/llm.go': `// Package llm is the stand-in for the model server. The checks serve it over gRPC (Model.Complete at
// config.Model); the cache's code never calls it directly. Deterministic on purpose: the course grades
// what the cache does around the model, not the prose.
//
// Complete(prefix, temperature) → (text, finishReason, tokens):
//
//	a prefix starting with "refuse:" is declined by policy ("", "content_filter", 0)
//	a prefix starting with "long:" is cut at the token limit (finish reason "length")
//	anything else is answered in one line that quotes the prefix (finish reason "stop")
//	a temperature above 0 marks the answer as sampled
package llm

import "strings"

func Complete(prefix string, temperature float64) (text, finishReason string, tokens int) {
	if strings.HasPrefix(prefix, "refuse:") {
		return "", "content_filter", 0
	}
	head := "Answer"
	if temperature > 0 {
		head = "Sampled answer"
	}
	text = head + ": " + strings.TrimSpace(prefix)
	finishReason = "stop"
	if strings.HasPrefix(prefix, "long:") {
		finishReason = "length"
	}
	return text, finishReason, len(strings.Fields(text))
}
`,
};

/** The C++ twins as headers (pcache/*.h), plus digest.h (SHA-256). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'pcache/config.h': `// Addresses, topics, keys and prices every step of the prompt cache agrees on.
#pragma once

#include <map>
#include <string>

#include <sw/redis++/redis++.h>

namespace config {

// The model server's gRPC address: a stand-in served by the checks (pcache/llm.h).
inline constexpr const char* kModel = "model:9000";
// One event per cache decision (hit or miss), keyed by tenant, for the stats consumer.
inline constexpr const char* kTopic = "cache.result";
// A cache entry lives as long as its prompt version is served: six hours from the fill.
inline constexpr long long kVersionTtlSeconds = 6 * 3600;

// What 1 000 completion tokens cost on the model each prompt version runs on (USD).
inline const std::map<int, double> kPricePer1kUsd = {{7, 0.0020}, {8, 0.0015}};
// The price of a version the table does not list.
inline constexpr double kDefaultPricePer1kUsd = 0.0020;

inline double price_per_1k(int version) {
  const auto it = kPricePer1kUsd.find(version);
  return it == kPricePer1kUsd.end() ? kDefaultPricePer1kUsd : it->second;
}

// Entries live under pc:{tenant}:{version}:{digest} (step 1 builds the key). The stats consumer keeps,
// per (tenant, prompt version), a hash of hits, misses, fill_ms (the summed latency of misses) and
// tokens_saved (completion tokens served from the cache), and per tenant the set of its versions.
inline std::string stats_key(const std::string& tenant, int version) {
  return "pc-stats:" + tenant + ":" + std::to_string(version);
}
inline std::string versions_key(const std::string& tenant) { return "pc-versions:" + tenant; }

// The one Redis connection the steps share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'pcache/record.h': `// The shapes the steps pass around (provided): a cache entry and a miss-path answer.
#pragma once

#include <string>

#include <nlohmann/json.hpp>

namespace record {

// A cache entry: the JSON stored under pc:{tenant}:{version}:{digest}. tokens are the completion
// tokens, what a hit saves.
struct Record {
  std::string tenant;
  int version = 0;
  std::string completion;
  int tokens = 0;
};

inline std::string encode(const Record& r) {
  return nlohmann::json{{"tenant", r.tenant}, {"version", r.version}, {"completion", r.completion}, {"tokens", r.tokens}}.dump();
}

inline Record decode(const std::string& raw) {
  const auto j = nlohmann::json::parse(raw);
  return {j.at("tenant").get<std::string>(), j.at("version").get<int>(), j.at("completion").get<std::string>(),
          j.at("tokens").get<int>()};
}

// What the miss path answers. status: cached (stored and served), uncached (served, not stored),
// refused, error.
struct Miss {
  std::string status;
  std::string completion;
  int tokens = 0;
};

}  // namespace record
`,
  'pcache/llm.h': `// The stand-in for the model server. The checks serve it over gRPC (Model.Complete at config::kModel);
// the cache's code never calls it directly. Deterministic on purpose: the course grades what the cache
// does around the model, not the prose.
//
// complete(prefix, temperature) -> {text, finish_reason, tokens}:
//   a prefix starting with "refuse:" is declined by policy ("", "content_filter", 0)
//   a prefix starting with "long:" is cut at the token limit (finish_reason "length")
//   anything else is answered in one line that quotes the prefix (finish_reason "stop")
//   a temperature above 0 marks the answer as sampled
#pragma once

#include <sstream>
#include <string>

namespace llm {

struct Completion {
  std::string text;
  std::string finish_reason;
  int tokens = 0;
};

inline std::string trim(const std::string& s) {
  const size_t start = s.find_first_not_of(" \\t\\r\\n");
  if (start == std::string::npos) return "";
  return s.substr(start, s.find_last_not_of(" \\t\\r\\n") - start + 1);
}

inline Completion complete(const std::string& prefix, double temperature) {
  if (prefix.rfind("refuse:", 0) == 0) return {"", "content_filter", 0};
  const std::string text = std::string(temperature > 0 ? "Sampled answer" : "Answer") + ": " + trim(prefix);
  std::istringstream words(text);
  int tokens = 0;
  for (std::string word; words >> word;) tokens++;
  return {text, prefix.rfind("long:", 0) == 0 ? "length" : "stop", tokens};
}

}  // namespace llm
`,
};

/** The Scala twins: the same \`pcache\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('pcache', 'Config')]: `package pcache

/** Addresses, topics, keys and prices every step of the prompt cache agrees on. */
object Config {
  /** The model server's gRPC address: a stand-in served by the checks. */
  val Model = "model:9000"
  /** One event per cache decision (hit or miss), keyed by tenant, for the stats consumer. */
  val Topic = "cache.result"
  /** A cache entry lives as long as its prompt version is served: six hours from the fill. */
  val VersionTtlSeconds: Long = 6L * 3600

  /** What 1 000 completion tokens cost on the model each prompt version runs on (USD). */
  val PricePer1kUsd: Map[Int, Double] = Map(7 -> 0.0020, 8 -> 0.0015)
  /** The price of a version the table does not list. */
  val DefaultPricePer1kUsd = 0.0020

  def pricePer1k(version: Int): Double = PricePer1kUsd.getOrElse(version, DefaultPricePer1kUsd)

  // Entries live under pc:{tenant}:{version}:{digest} (step 1 builds the key). The stats consumer keeps,
  // per (tenant, prompt version), a hash of hits, misses, fill_ms (the summed latency of misses) and
  // tokens_saved (completion tokens served from the cache), and per tenant the set of its versions.
  def statsKey(tenant: String, version: Int): String = s"pc-stats:$tenant:$version"
  def versionsKey(tenant: String): String = s"pc-versions:$tenant"
}
`,
  [scalaPath('pcache', 'Record')]: `package pcache

/** A cache entry: the JSON stored under pc:{tenant}:{version}:{digest}. tokens: what a hit saves. */
final case class CacheRecord(tenant: String, version: Int, completion: String, tokens: Int)

object CacheRecord {
  def encode(r: CacheRecord): String =
    ujson.write(ujson.Obj("tenant" -> r.tenant, "version" -> r.version, "completion" -> r.completion, "tokens" -> r.tokens))

  def decode(raw: String): CacheRecord = {
    val j = ujson.read(raw)
    CacheRecord(j("tenant").str, j("version").num.toInt, j("completion").str, j("tokens").num.toInt)
  }
}

/** What the miss path answers. status: cached (stored and served), uncached (served, not stored), refused, error. */
final case class Miss(status: String, completion: String, tokens: Int)
`,
};
