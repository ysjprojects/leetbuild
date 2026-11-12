/**
 * Hand-written support modules the autocomplete steps import but no step builds: the `suggest`
 * package. `suggest.terms` is the term store (what tenants searched for, the catalog version, the
 * hourly trend buckets the event consumer counts) and `fold`, the normalization every step shares.
 * `suggest.cache` is the suggestion cache of step 2 as step 3 uses it. `suggest.outbox` is the list
 * a relay publishes from; `suggest.privacy` hashes a prefix for the event stream. The five
 * languages keep the same keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'suggest/__init__.py': '',
  'suggest/terms.py': `"""
The term store (provided). suggest:terms:{tenant} is a sorted set of the queries a tenant's users
typed (member: the term as typed, score: how often it was searched); suggest:catalog:{tenant} the
tenant's catalog version, which a catalog change increments; suggest:trend:{tenant}:{hour} the
searches of one hour (hours since the epoch) the event consumer counts; suggest:category:{tenant}
each term's category; suggest:searcher:{tenant} the user who last searched each term, kept for abuse
investigations.

fold() is the normalization every step shares: ASCII letters lowercased, the accented Latin letters
U+00C0 to U+00FF folded to their base letter (FOLD_LATIN1), runs of whitespace collapsed to one
space, the ends trimmed. "  CRÈME  Brûlée" folds to "creme brulee".
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# U+00C0 to U+00FF: the base letter each folds to, "-" for a character kept as it is.
FOLD_LATIN1 = "aaaaaa-ceeeeiiii-nooooo--uuuuy--aaaaaa-ceeeeiiii-nooooo--uuuuy-y"
WHITESPACE = " \\t\\n\\r\\f\\v"


def fold(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        if "A" <= ch <= "Z":
            ch = chr(code + 32)
        elif 0xC0 <= code <= 0xFF and FOLD_LATIN1[code - 0xC0] != "-":
            ch = FOLD_LATIN1[code - 0xC0]
        out.append(" " if ch in WHITESPACE else ch)
    return " ".join(part for part in "".join(out).split(" ") if part)


def matching(tenant: str, prefix: str) -> list[str]:
    """The tenant's terms whose folded form starts with prefix (already folded), most searched first."""
    return [term for term in r.zrevrange(f"suggest:terms:{tenant}", 0, -1) if fold(term).startswith(prefix)]


def catalog_version(tenant: str) -> int:
    """The tenant's catalog version: 0 until its first catalog change."""
    return int(r.get(f"suggest:catalog:{tenant}") or 0)


def current_hour() -> int:
    """The hour bucket now falls in: hours since the epoch."""
    return int(time.time() // 3600)


def trend_counts(tenant: str, since_hour: int) -> dict[str, int]:
    """Searches per term, summed over the tenant's hour buckets from since_hour on."""
    counts: dict[str, int] = {}
    head = f"suggest:trend:{tenant}:"
    for key in r.keys(head + "*"):
        if int(key[len(head):]) < since_hour:
            continue
        for term, score in r.zrange(key, 0, -1, withscores=True):
            counts[term] = counts.get(term, 0) + int(score)
    return counts


def category_of(tenant: str, term: str) -> str:
    """The term's category, "" when it has none."""
    return r.hget(f"suggest:category:{tenant}", term) or ""


def last_searcher(tenant: str, term: str) -> str:
    """The user id of the last person who searched the term, for abuse investigations."""
    return r.hget(f"suggest:searcher:{tenant}", term) or ""
`,
  'suggest/cache.py': `"""
The suggestion cache (provided; step 2 builds the same two functions). A tenant's completions for a
folded prefix live under suggest:cache:{tenant}:v{catalog version}:{prefix} as a JSON list for
TTL_SECONDS; suggest:recent:{tenant} scores each cached prefix by its last read or write, and past
MAX_PREFIXES_PER_TENANT the coldest prefix is evicted.
"""
import json
import time

import redis

from suggest import terms

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_SECONDS = 300
MAX_PREFIXES_PER_TENANT = 100


def cache_key(tenant: str, prefix: str) -> str:
    return f"suggest:cache:{tenant}:v{terms.catalog_version(tenant)}:{prefix}"


def recent_key(tenant: str) -> str:
    return f"suggest:recent:{tenant}"


def get_suggestions(tenant: str, prefix: str) -> list[str] | None:
    raw = r.get(cache_key(tenant, prefix))
    if raw is None:
        return None
    r.zadd(recent_key(tenant), {prefix: time.time()})
    return json.loads(raw)


def put_suggestions(tenant: str, prefix: str, suggestions: list[str]) -> None:
    r.set(cache_key(tenant, prefix), json.dumps(suggestions), ex=TTL_SECONDS)
    r.zadd(recent_key(tenant), {prefix: time.time()})
    while r.zcard(recent_key(tenant)) > MAX_PREFIXES_PER_TENANT:
        for coldest, _ in r.zpopmin(recent_key(tenant)):
            r.delete(cache_key(tenant, coldest))
`,
  'suggest/outbox.py': `"""
The outbox (provided): the Redis list suggest:outbox of JSON rows {"topic", "key", "payload"} a
relay publishes later, oldest first.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(topic: str, key: str, payload: dict) -> None:
    r.rpush("suggest:outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))


def rows() -> list[dict]:
    return [json.loads(row) for row in r.lrange("suggest:outbox", 0, -1)]
`,
  'suggest/privacy.py': `"""
Prefix hashing (provided): prefix_hash(tenant, prefix) is the HMAC-SHA256 of "{tenant}:{prefix}"
under the service's hashing key, its first 32 hex digits. One tenant's equal prefixes hash alike, so
the consumer can count and join them; the text does not leave the service.
"""
import hashlib
import hmac

PREFIX_HASH_KEY = b"suggestd-prefix-hash-v1"


def prefix_hash(tenant: str, prefix: str) -> str:
    return hmac.new(PREFIX_HASH_KEY, f"{tenant}:{prefix}".encode(), hashlib.sha256).hexdigest()[:32]
`,
};

export const supportModulesTs: Record<string, string> = {
  'suggest/terms.ts': `/**
 * The term store (provided). suggest:terms:{tenant} is a sorted set of the queries a tenant's users
 * typed (member: the term as typed, score: how often it was searched); suggest:catalog:{tenant} the
 * tenant's catalog version, which a catalog change increments; suggest:trend:{tenant}:{hour} the
 * searches of one hour (hours since the epoch) the event consumer counts; suggest:category:{tenant}
 * each term's category; suggest:searcher:{tenant} the user who last searched each term, kept for
 * abuse investigations.
 *
 * fold() is the normalization every step shares: ASCII letters lowercased, the accented Latin
 * letters U+00C0 to U+00FF folded to their base letter (FOLD_LATIN1), runs of whitespace collapsed
 * to one space, the ends trimmed. "  CRÈME  Brûlée" folds to "creme brulee".
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** U+00C0 to U+00FF: the base letter each folds to, "-" for a character kept as it is. */
export const FOLD_LATIN1 = 'aaaaaa-ceeeeiiii-nooooo--uuuuy--aaaaaa-ceeeeiiii-nooooo--uuuuy-y';
const WHITESPACE = ' \\t\\n\\r\\f\\v';

export function fold(text: string): string {
  let out = '';
  for (let ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch >= 'A' && ch <= 'Z') ch = String.fromCharCode(code + 32);
    else if (code >= 0xc0 && code <= 0xff && FOLD_LATIN1[code - 0xc0] !== '-') ch = FOLD_LATIN1[code - 0xc0];
    out += WHITESPACE.includes(ch) ? ' ' : ch;
  }
  return out
    .split(' ')
    .filter(part => part !== '')
    .join(' ');
}

/** The tenant's terms whose folded form starts with prefix (already folded), most searched first. */
export async function matching(tenant: string, prefix: string): Promise<string[]> {
  const ranked = await redis.zrevrange(\`suggest:terms:\${tenant}\`, 0, -1);
  return ranked.filter(term => fold(term).startsWith(prefix));
}

/** The tenant's catalog version: 0 until its first catalog change. */
export async function catalogVersion(tenant: string): Promise<number> {
  return Number((await redis.get(\`suggest:catalog:\${tenant}\`)) ?? 0);
}

/** The hour bucket now falls in: hours since the epoch. */
export const currentHour = (): number => Math.floor(Date.now() / 3_600_000);

/** Searches per term, summed over the tenant's hour buckets from sinceHour on. */
export async function trendCounts(tenant: string, sinceHour: number): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const head = \`suggest:trend:\${tenant}:\`;
  for (const key of await redis.keys(\`\${head}*\`)) {
    if (Number(key.slice(head.length)) < sinceHour) continue;
    const flat = await redis.zrange(key, 0, -1, 'WITHSCORES');
    for (let i = 0; i + 1 < flat.length; i += 2) counts.set(flat[i], (counts.get(flat[i]) ?? 0) + Number(flat[i + 1]));
  }
  return counts;
}

/** The term's category, "" when it has none. */
export async function categoryOf(tenant: string, term: string): Promise<string> {
  return (await redis.hget(\`suggest:category:\${tenant}\`, term)) ?? '';
}

/** The user id of the last person who searched the term, for abuse investigations. */
export async function lastSearcher(tenant: string, term: string): Promise<string> {
  return (await redis.hget(\`suggest:searcher:\${tenant}\`, term)) ?? '';
}
`,
  'suggest/cache.ts': `/**
 * The suggestion cache (provided; step 2 builds the same two functions). A tenant's completions for
 * a folded prefix live under suggest:cache:{tenant}:v{catalog version}:{prefix} as a JSON list for
 * TTL_SECONDS; suggest:recent:{tenant} scores each cached prefix by its last read or write, and past
 * MAX_PREFIXES_PER_TENANT the coldest prefix is evicted.
 */
import Redis from 'ioredis';

import {catalogVersion} from 'suggest/terms';

const redis = new Redis({host: 'redis', port: 6379});

export const TTL_SECONDS = 300;
export const MAX_PREFIXES_PER_TENANT = 100;

export const cacheKey = async (tenant: string, prefix: string): Promise<string> =>
  \`suggest:cache:\${tenant}:v\${await catalogVersion(tenant)}:\${prefix}\`;
export const recentKey = (tenant: string): string => \`suggest:recent:\${tenant}\`;

export async function getSuggestions(tenant: string, prefix: string): Promise<string[] | null> {
  const raw = await redis.get(await cacheKey(tenant, prefix));
  if (raw === null) return null;
  await redis.zadd(recentKey(tenant), Date.now(), prefix);
  return JSON.parse(raw) as string[];
}

export async function putSuggestions(tenant: string, prefix: string, suggestions: string[]): Promise<void> {
  await redis.set(await cacheKey(tenant, prefix), JSON.stringify(suggestions), 'EX', TTL_SECONDS);
  await redis.zadd(recentKey(tenant), Date.now(), prefix);
  while ((await redis.zcard(recentKey(tenant))) > MAX_PREFIXES_PER_TENANT) {
    const [coldest] = (await redis.call('ZPOPMIN', recentKey(tenant))) as string[];
    await redis.del(await cacheKey(tenant, coldest));
  }
}
`,
  'suggest/outbox.ts': `/**
 * The outbox (provided): the Redis list suggest:outbox of JSON rows {"topic", "key", "payload"} a
 * relay publishes later, oldest first.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export async function insert(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('suggest:outbox', JSON.stringify({topic, key, payload}));
}

export async function rows(): Promise<{topic: string; key: string; payload: Record<string, unknown>}[]> {
  return (await redis.lrange('suggest:outbox', 0, -1)).map(row => JSON.parse(row));
}
`,
  'suggest/privacy.ts': `/**
 * Prefix hashing (provided): prefixHash(tenant, prefix) is the HMAC-SHA256 of "{tenant}:{prefix}"
 * under the service's hashing key, its first 32 hex digits. One tenant's equal prefixes hash alike,
 * so the consumer can count and join them; the text does not leave the service.
 */
import {createHmac} from 'node:crypto';

const PREFIX_HASH_KEY = 'suggestd-prefix-hash-v1';

export const prefixHash = (tenant: string, prefix: string): string =>
  (createHmac('sha256', PREFIX_HASH_KEY).update(\`\${tenant}:\${prefix}\`).digest('hex') as string).slice(0, 32);
`,
};

export const supportModulesGo: Record<string, string> = {
  'suggest/terms/terms.go': `// Package terms is the term store (provided). suggest:terms:{tenant} is a sorted set of the
// queries a tenant's users typed (member: the term as typed, score: how often it was searched);
// suggest:catalog:{tenant} the tenant's catalog version, which a catalog change increments;
// suggest:trend:{tenant}:{hour} the searches of one hour (hours since the epoch) the event consumer
// counts; suggest:category:{tenant} each term's category; suggest:searcher:{tenant} the user who
// last searched each term, kept for abuse investigations.
//
// Fold is the normalization every step shares: ASCII letters lowercased, the accented Latin letters
// U+00C0 to U+00FF folded to their base letter (FoldLatin1), runs of whitespace collapsed to one
// space, the ends trimmed. "  CRÈME  Brûlée" folds to "creme brulee".
package terms

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// FoldLatin1 maps U+00C0 to U+00FF to the base letter each folds to, "-" for a character kept as it is.
const FoldLatin1 = "aaaaaa-ceeeeiiii-nooooo--uuuuy--aaaaaa-ceeeeiiii-nooooo--uuuuy-y"

// Fold normalizes a prefix or a term for matching.
func Fold(text string) string {
	var b strings.Builder
	for _, ch := range text {
		switch {
		case ch >= 'A' && ch <= 'Z':
			ch += 32
		case ch >= 0xC0 && ch <= 0xFF && FoldLatin1[ch-0xC0] != '-':
			ch = rune(FoldLatin1[ch-0xC0])
		case strings.ContainsRune(" \\t\\n\\r\\f\\v", ch):
			ch = ' '
		}
		b.WriteRune(ch)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// Matching is the tenant's terms whose folded form starts with prefix (already folded), most searched first.
func Matching(ctx context.Context, tenant, prefix string) []string {
	var out []string
	for _, term := range rdb.ZRevRange(ctx, "suggest:terms:"+tenant, 0, -1).Val() {
		if strings.HasPrefix(Fold(term), prefix) {
			out = append(out, term)
		}
	}
	return out
}

// CatalogVersion is the tenant's catalog version: 0 until its first catalog change.
func CatalogVersion(ctx context.Context, tenant string) int64 {
	n, _ := strconv.ParseInt(rdb.Get(ctx, "suggest:catalog:"+tenant).Val(), 10, 64)
	return n
}

// CurrentHour is the hour bucket now falls in: hours since the epoch.
func CurrentHour() int64 { return time.Now().Unix() / 3600 }

// TrendCounts is the searches per term, summed over the tenant's hour buckets from sinceHour on.
func TrendCounts(ctx context.Context, tenant string, sinceHour int64) map[string]int64 {
	counts := map[string]int64{}
	head := "suggest:trend:" + tenant + ":"
	for _, key := range rdb.Keys(ctx, head+"*").Val() {
		hour, err := strconv.ParseInt(strings.TrimPrefix(key, head), 10, 64)
		if err != nil || hour < sinceHour {
			continue
		}
		for _, z := range rdb.ZRangeWithScores(ctx, key, 0, -1).Val() {
			counts[z.Member.(string)] += int64(z.Score)
		}
	}
	return counts
}

// CategoryOf is the term's category, "" when it has none.
func CategoryOf(ctx context.Context, tenant, term string) string {
	return rdb.HGet(ctx, "suggest:category:"+tenant, term).Val()
}

// LastSearcher is the user id of the last person who searched the term, for abuse investigations.
func LastSearcher(ctx context.Context, tenant, term string) string {
	return rdb.HGet(ctx, "suggest:searcher:"+tenant, term).Val()
}
`,
  'suggest/cache/cache.go': `// Package cache is the suggestion cache (provided; step 2 builds the same two functions). A
// tenant's completions for a folded prefix live under suggest:cache:{tenant}:v{catalog
// version}:{prefix} as a JSON list for TTL; suggest:recent:{tenant} scores each cached prefix by its
// last read or write, and past MaxPrefixesPerTenant the coldest prefix is evicted.
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"suggest/terms"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	TTL                  = 300 * time.Second
	MaxPrefixesPerTenant = 100
)

// CacheKey is where a tenant's completions for prefix live under the current catalog version.
func CacheKey(ctx context.Context, tenant, prefix string) string {
	return fmt.Sprintf("suggest:cache:%s:v%d:%s", tenant, terms.CatalogVersion(ctx, tenant), prefix)
}

// RecentKey scores a tenant's cached prefixes by last use.
func RecentKey(tenant string) string { return "suggest:recent:" + tenant }

// GetSuggestions is the cached completions, and whether there were any.
func GetSuggestions(ctx context.Context, tenant, prefix string) ([]string, bool) {
	raw, err := rdb.Get(ctx, CacheKey(ctx, tenant, prefix)).Result()
	if err != nil {
		return nil, false
	}
	rdb.ZAdd(ctx, RecentKey(tenant), redis.Z{Score: float64(time.Now().UnixMilli()), Member: prefix})
	var suggestions []string
	json.Unmarshal([]byte(raw), &suggestions)
	return suggestions, true
}

// PutSuggestions caches completions for TTL and evicts the tenant's coldest prefixes past the cap.
func PutSuggestions(ctx context.Context, tenant, prefix string, suggestions []string) {
	raw, _ := json.Marshal(suggestions)
	rdb.Set(ctx, CacheKey(ctx, tenant, prefix), raw, TTL)
	rdb.ZAdd(ctx, RecentKey(tenant), redis.Z{Score: float64(time.Now().UnixMilli()), Member: prefix})
	for rdb.ZCard(ctx, RecentKey(tenant)).Val() > MaxPrefixesPerTenant {
		for _, coldest := range rdb.ZPopMin(ctx, RecentKey(tenant)).Val() {
			rdb.Del(ctx, CacheKey(ctx, tenant, coldest.Member.(string)))
		}
	}
}
`,
  'suggest/outbox/outbox.go': `// Package outbox is the outbox (provided): the Redis list suggest:outbox of JSON rows {"topic",
// "key", "payload"} a relay publishes later, oldest first.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Row is one queued record.
type Row struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

// Insert queues a record for the relay.
func Insert(ctx context.Context, topic, key string, payload map[string]any) error {
	row, _ := json.Marshal(Row{Topic: topic, Key: key, Payload: payload})
	return rdb.RPush(ctx, "suggest:outbox", row).Err()
}

// Rows is everything queued, oldest first.
func Rows(ctx context.Context) []Row {
	var rows []Row
	for _, raw := range rdb.LRange(ctx, "suggest:outbox", 0, -1).Val() {
		var row Row
		json.Unmarshal([]byte(raw), &row)
		rows = append(rows, row)
	}
	return rows
}
`,
  'suggest/privacy/privacy.go': `// Package privacy is prefix hashing (provided): PrefixHash(tenant, prefix) is the HMAC-SHA256 of
// "{tenant}:{prefix}" under the service's hashing key, its first 32 hex digits. One tenant's equal
// prefixes hash alike, so the consumer can count and join them; the text does not leave the service.
package privacy

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

const prefixHashKey = "suggestd-prefix-hash-v1"

// PrefixHash is the hashed form of a tenant's prefix.
func PrefixHash(tenant, prefix string) string {
	mac := hmac.New(sha256.New, []byte(prefixHashKey))
	mac.Write([]byte(tenant + ":" + prefix))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'suggest/terms.h': `// The term store (provided). suggest:terms:{tenant} is a sorted set of the queries a tenant's
// users typed (member: the term as typed, score: how often it was searched);
// suggest:catalog:{tenant} the tenant's catalog version, which a catalog change increments;
// suggest:trend:{tenant}:{hour} the searches of one hour (hours since the epoch) the event consumer
// counts; suggest:category:{tenant} each term's category; suggest:searcher:{tenant} the user who
// last searched each term, kept for abuse investigations.
//
// fold() is the normalization every step shares: ASCII letters lowercased, the accented Latin
// letters U+00C0 to U+00FF folded to their base letter (kFoldLatin1), runs of whitespace collapsed
// to one space, the ends trimmed. "  CRÈME  Brûlée" folds to "creme brulee".
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace terms {

// U+00C0 to U+00FF: the base letter each folds to, '-' for a character kept as it is.
inline const std::string kFoldLatin1 = "aaaaaa-ceeeeiiii-nooooo--uuuuy--aaaaaa-ceeeeiiii-nooooo--uuuuy-y";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string fold(const std::string& text) {
  std::string spaced;
  for (size_t i = 0; i < text.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    if (c >= 'A' && c <= 'Z') {
      spaced += static_cast<char>(c + 32);
    } else if (c == 0xC3 && i + 1 < text.size() && (static_cast<unsigned char>(text[i + 1]) & 0xC0) == 0x80 &&
               kFoldLatin1[static_cast<unsigned char>(text[i + 1]) - 0x80] != '-') {
      // U+00C0 to U+00FF are C3 80 to C3 BF in UTF-8.
      spaced += kFoldLatin1[static_cast<unsigned char>(text[i + 1]) - 0x80];
      ++i;
    } else {
      spaced += (c == ' ' || c == '\\t' || c == '\\n' || c == '\\r' || c == '\\f' || c == '\\v') ? ' ' : static_cast<char>(c);
    }
  }
  std::string out;
  for (const char c : spaced) {
    if (c == ' ' && (out.empty() || out.back() == ' ')) continue;
    out += c;
  }
  if (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

// The tenant's terms whose folded form starts with prefix (already folded), most searched first.
inline std::vector<std::string> matching(const std::string& tenant, const std::string& prefix) {
  std::vector<std::string> out;
  for (const std::string& term : redis().zrevrange("suggest:terms:" + tenant, 0, -1)) {
    if (fold(term).rfind(prefix, 0) == 0) out.push_back(term);
  }
  return out;
}

// The tenant's catalog version: 0 until its first catalog change.
inline long long catalogVersion(const std::string& tenant) {
  const auto raw = redis().get("suggest:catalog:" + tenant);
  return raw ? std::stoll(*raw) : 0;
}

// The hour bucket now falls in: hours since the epoch.
inline long long currentHour() {
  return std::chrono::duration_cast<std::chrono::hours>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Searches per term, summed over the tenant's hour buckets from since_hour on.
inline std::map<std::string, long long> trendCounts(const std::string& tenant, long long since_hour) {
  std::map<std::string, long long> counts;
  const std::string head = "suggest:trend:" + tenant + ":";
  for (const std::string& key : redis().keys(head + "*")) {
    if (std::stoll(key.substr(head.size())) < since_hour) continue;
    std::vector<std::pair<std::string, double>> scored;
    redis().zrange(key, 0, -1, std::back_inserter(scored));
    for (const auto& [term, score] : scored) counts[term] += static_cast<long long>(score);
  }
  return counts;
}

// The term's category, "" when it has none.
inline std::string categoryOf(const std::string& tenant, const std::string& term) {
  return redis().hget("suggest:category:" + tenant, term).value_or("");
}

// The user id of the last person who searched the term, for abuse investigations.
inline std::string lastSearcher(const std::string& tenant, const std::string& term) {
  return redis().hget("suggest:searcher:" + tenant, term).value_or("");
}

}  // namespace terms
`,
  'suggest/cache.h': `// The suggestion cache (provided; step 2 builds the same two functions). A tenant's completions for
// a folded prefix live under suggest:cache:{tenant}:v{catalog version}:{prefix} as a JSON list for
// kTtlSeconds; suggest:recent:{tenant} scores each cached prefix by its last read or write, and past
// kMaxPrefixesPerTenant the coldest prefix is evicted.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "suggest/terms.h"

namespace cache {

constexpr long long kTtlSeconds = 300;
constexpr long long kMaxPrefixesPerTenant = 100;

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string cacheKey(const std::string& tenant, const std::string& prefix) {
  return "suggest:cache:" + tenant + ":v" + std::to_string(terms::catalogVersion(tenant)) + ":" + prefix;
}

inline std::string recentKey(const std::string& tenant) { return "suggest:recent:" + tenant; }

inline double nowMs() {
  return static_cast<double>(
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

inline std::optional<std::vector<std::string>> getSuggestions(const std::string& tenant, const std::string& prefix) {
  const auto raw = redis().get(cacheKey(tenant, prefix));
  if (!raw) return std::nullopt;
  redis().zadd(recentKey(tenant), prefix, nowMs());
  return nlohmann::json::parse(*raw).get<std::vector<std::string>>();
}

inline void putSuggestions(const std::string& tenant, const std::string& prefix, const std::vector<std::string>& suggestions) {
  redis().set(cacheKey(tenant, prefix), nlohmann::json(suggestions).dump(), std::chrono::seconds(kTtlSeconds));
  redis().zadd(recentKey(tenant), prefix, nowMs());
  while (redis().zcard(recentKey(tenant)) > kMaxPrefixesPerTenant) {
    const auto coldest = redis().zpopmin(recentKey(tenant));
    if (!coldest) break;
    redis().del(cacheKey(tenant, coldest->first));
  }
}

}  // namespace cache
`,
  'suggest/outbox.h': `// The outbox (provided): the Redis list suggest:outbox of JSON rows {"topic", "key", "payload"} a
// relay publishes later, oldest first.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

namespace outbox {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline void insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("suggest:outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

inline std::vector<nlohmann::json> rows() {
  std::vector<nlohmann::json> out;
  for (const std::string& row : redis().lrange("suggest:outbox", 0, -1)) out.push_back(nlohmann::json::parse(row));
  return out;
}

}  // namespace outbox
`,
  'suggest/privacy.h': `// Prefix hashing (provided): prefixHash(tenant, prefix) is the HMAC-SHA256 of "{tenant}:{prefix}"
// under the service's hashing key, its first 32 hex digits. One tenant's equal prefixes hash alike,
// so the consumer can count and join them; the text does not leave the service.
#pragma once

#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <cstdio>
#include <string>

namespace privacy {

inline const std::string kPrefixHashKey = "suggestd-prefix-hash-v1";

inline std::string prefixHash(const std::string& tenant, const std::string& prefix) {
  const std::string message = tenant + ":" + prefix;
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int length = 0;
  HMAC(EVP_sha256(), kPrefixHashKey.data(), static_cast<int>(kPrefixHashKey.size()),
       reinterpret_cast<const unsigned char*>(message.data()), message.size(), mac, &length);
  std::string hex;
  char digit[3];
  for (unsigned int i = 0; i < 16 && i < length; ++i) {
    std::snprintf(digit, sizeof digit, "%02x", mac[i]);
    hex += digit;
  }
  return hex;
}

}  // namespace privacy
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('suggest', 'Terms')]: `package suggest

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The term store (provided). suggest:terms:{tenant} is a sorted set of the queries a tenant's users
 * typed (member: the term as typed, score: how often it was searched); suggest:catalog:{tenant} the
 * tenant's catalog version, which a catalog change increments; suggest:trend:{tenant}:{hour} the
 * searches of one hour (hours since the epoch) the event consumer counts; suggest:category:{tenant}
 * each term's category; suggest:searcher:{tenant} the user who last searched each term, kept for
 * abuse investigations.
 *
 * fold() is the normalization every step shares: ASCII letters lowercased, the accented Latin
 * letters U+00C0 to U+00FF folded to their base letter (FoldLatin1), runs of whitespace collapsed to
 * one space, the ends trimmed. "  CRÈME  Brûlée" folds to "creme brulee".
 */
object Terms {
  val jedis = new JedisPooled("redis", 6379)

  /** U+00C0 to U+00FF: the base letter each folds to, '-' for a character kept as it is. */
  val FoldLatin1 = "aaaaaa-ceeeeiiii-nooooo--uuuuy--aaaaaa-ceeeeiiii-nooooo--uuuuy-y"

  def fold(text: String): String = {
    val mapped = text.map {
      case ch if ch >= 'A' && ch <= 'Z' => (ch + 32).toChar
      case ch if ch >= '\\u00c0' && ch <= '\\u00ff' && FoldLatin1(ch - 0xc0) != '-' => FoldLatin1(ch - 0xc0)
      case ch if " \\t\\n\\r\\f\\u000b".contains(ch) => ' '
      case ch => ch
    }
    mapped.split(' ').filter(_.nonEmpty).mkString(" ")
  }

  /** The tenant's terms whose folded form starts with prefix (already folded), most searched first. */
  def matching(tenant: String, prefix: String): Seq[String] =
    jedis.zrevrange(s"suggest:terms:$tenant", 0, -1).asScala.toSeq.filter(term => fold(term).startsWith(prefix))

  /** The tenant's catalog version: 0 until its first catalog change. */
  def catalogVersion(tenant: String): Long = Option(jedis.get(s"suggest:catalog:$tenant")).map(_.toLong).getOrElse(0L)

  /** The hour bucket now falls in: hours since the epoch. */
  def currentHour(): Long = System.currentTimeMillis() / 3600000L

  /** Searches per term, summed over the tenant's hour buckets from sinceHour on. */
  def trendCounts(tenant: String, sinceHour: Long): Map[String, Long] = {
    val head = s"suggest:trend:$tenant:"
    val buckets = jedis.keys(head + "*").asScala.toSeq.filter(_.stripPrefix(head).toLong >= sinceHour)
    buckets
      .flatMap(key => jedis.zrangeWithScores(key, 0, -1).asScala.map(t => t.getElement -> t.getScore.toLong))
      .groupMapReduce(_._1)(_._2)(_ + _)
  }

  /** The term's category, "" when it has none. */
  def categoryOf(tenant: String, term: String): String = Option(jedis.hget(s"suggest:category:$tenant", term)).getOrElse("")

  /** The user id of the last person who searched the term, for abuse investigations. */
  def lastSearcher(tenant: String, term: String): String = Option(jedis.hget(s"suggest:searcher:$tenant", term)).getOrElse("")
}
`,
  [scalaPath('suggest', 'Cache')]: `package suggest

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/**
 * The suggestion cache (provided; step 2 builds the same two functions). A tenant's completions for
 * a folded prefix live under suggest:cache:{tenant}:v{catalog version}:{prefix} as a JSON list for
 * TtlSeconds; suggest:recent:{tenant} scores each cached prefix by its last read or write, and past
 * MaxPrefixesPerTenant the coldest prefix is evicted.
 */
object Cache {
  val jedis = new JedisPooled("redis", 6379)

  val TtlSeconds = 300L
  val MaxPrefixesPerTenant = 100L

  def cacheKey(tenant: String, prefix: String): String = s"suggest:cache:$tenant:v\${Terms.catalogVersion(tenant)}:$prefix"
  def recentKey(tenant: String): String = s"suggest:recent:$tenant"

  def getSuggestions(tenant: String, prefix: String): Option[Seq[String]] =
    Option(jedis.get(cacheKey(tenant, prefix))).map { raw =>
      jedis.zadd(recentKey(tenant), System.currentTimeMillis().toDouble, prefix)
      raw.parseJson.convertTo[Seq[String]]
    }

  def putSuggestions(tenant: String, prefix: String, suggestions: Seq[String]): Unit = {
    jedis.setex(cacheKey(tenant, prefix), TtlSeconds, suggestions.toJson.compactPrint)
    jedis.zadd(recentKey(tenant), System.currentTimeMillis().toDouble, prefix)
    while (jedis.zcard(recentKey(tenant)) > MaxPrefixesPerTenant) {
      val coldest = jedis.zpopmin(recentKey(tenant))
      if (coldest != null) jedis.del(cacheKey(tenant, coldest.getElement))
    }
  }
}
`,
  [scalaPath('suggest', 'Outbox')]: `package suggest

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/** The outbox (provided): the Redis list suggest:outbox of JSON rows {"topic", "key", "payload"} a relay publishes later, oldest first. */
object Outbox {
  val jedis = new JedisPooled("redis", 6379)

  def insert(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("suggest:outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  def rows(): Seq[JsValue] = jedis.lrange("suggest:outbox", 0, -1).asScala.toSeq.map(_.parseJson)
}
`,
  [scalaPath('suggest', 'Privacy')]: `package suggest

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Prefix hashing (provided): prefixHash(tenant, prefix) is the HMAC-SHA256 of "{tenant}:{prefix}"
 * under the service's hashing key, its first 32 hex digits. One tenant's equal prefixes hash alike,
 * so the consumer can count and join them; the text does not leave the service.
 */
object Privacy {
  private val PrefixHashKey = "suggestd-prefix-hash-v1"

  def prefixHash(tenant: String, prefix: String): String = {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(new SecretKeySpec(PrefixHashKey.getBytes("UTF-8"), "HmacSHA256"))
    mac.doFinal(s"$tenant:$prefix".getBytes("UTF-8")).map(b => f"\${b & 0xff}%02x").mkString.take(32)
  }
}
`,
};
