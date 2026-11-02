import type {Step} from '@/lib/types';

export const redactionStateStep: Step = {
  id: 'state',
  title: 'Redis pattern cache and per-tenant budget',
  concept: 'redis',
  file: 'state',
  focus: ['redactor', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter resolves each tenant's custom patterns through a Redis cache
keyed by pattern id, calls the detector, then \`INCRBY\`s a per-tenant character counter. It serves
the demo, because the demo tenant is alone and under any limit, and hides 5 flaws.

**Failure mode the checks target.** A cache key without the tenant makes one tenant's custom rule
authoritative for everyone who uses the same pattern id, and because it is a detection rule the
failure is silent: spans stop appearing. The budget is a read-then-write race made worse by
charging after the expensive call.

- **Pattern cache.** The key is \`patterns:{tenant}:{pattern_id}:{version}\`, where \`version\` is a
  stable hash of the regex body. A miss stores the body with a **3600-second** TTL; a hit returns
  it. A changed body lands under a new version instead of shadowing the old one.
- **Budget.** Each tenant may redact **2 000 000 characters per hour** under
  \`budget:{tenant}:{window}\` with \`window = floor(unix_seconds / 3600)\`.
- **Reserve atomically and before the detector.** One **Lua \`EVAL\`** reads the used count, rejects
  when the request does not fit, increments on success and sets \`EXPIRE\` on first write.
- An exhausted tenant is **429** with \`Retry-After\` (the key's TTL in seconds) and
  \`X-RateLimit-Remaining\` built from the script result, and the detector is not called.`,
  sequence: {
    participants: ['Redactor', 'Redis', 'Detector'],
    messages: [
      {from: 'Redactor', to: 'Redis', label: 'EVAL reserve · KEYS[budget:acme:486814]', kind: 'sync'},
      {from: 'Redis', to: 'Redactor', label: 'remaining chars / -1', kind: 'reply'},
      {from: 'Redactor', to: 'Redis', label: 'GET patterns:acme:p-42:9a1f (tenant + version)', kind: 'sync'},
      {from: 'Redis', to: 'Redactor', label: 'regex body / nil → SET EX 3600', kind: 'reply'},
      {from: 'Redactor', to: 'Detector', label: 'Detect(text, resolved patterns)', kind: 'sync'},
      {from: 'Detector', to: 'Redactor', label: 'spans[]', kind: 'reply'},
      {
        from: 'Redactor',
        to: 'Redactor',
        label: '429 {Retry-After, X-RateLimit-Remaining} before the detector when refused',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'pattern-key',
      title: 'Scopes the pattern cache by tenant and version',
      detail:
        'The key is `patterns:{tenant}:{pattern_id}:{version}` and the entry carries the TTL. A key built from the pattern id alone lets two tenants overwrite each other’s custom rules; dropping the version lets an edited body shadow the cached one.',
      match: {
        python: {all: [/patterns:\{tenant\}:\{pattern_id\}:\{version\}/, /PATTERN_TTL/]},
        typescript: {all: [/patterns:\$\{tenant\}:\$\{patternId\}:\$\{version\}/, /PATTERN_TTL/]},
        go: {all: [/patterns:%s:%s:%d/, /patternTTL/]},
        scala: {all: [/patterns:\$tenant:\$patternId:\$version/, /PatternTtl/]},
        cpp: {all: [/"patterns:"/, /kPatternTtl/]},
      },
    },
    {
      id: 'budget-key',
      title: 'Keys the budget by tenant and hourly window',
      detail:
        'The budget key is `budget:{tenant}:{window}` with a 3 600-second window and a 2 000 000 character cap. The starter keys by tenant alone with no cap and no window, so one busy hour spends forever.',
      match: {
        python: {all: [/budget:\{tenant\}:\{window\}/, /BUDGET_PER_HOUR/, /WINDOW_S/]},
        typescript: {all: [/budget:\$\{tenant\}:\$\{window\}/, /BUDGET_PER_HOUR/, /WINDOW_S/]},
        go: {all: [/budget:%s:%d/, /budgetPerHour/, /windowSeconds/]},
        scala: {all: [/budget:\$tenant:\$window/, /BudgetPerHour/, /WindowSeconds/]},
        cpp: {all: [/"budget:"/, /kBudgetPerHour/, /kWindowSeconds/]},
      },
    },
    {
      id: 'atomic-reserve',
      title: 'Reads, rejects and increments inside one Lua script',
      detail:
        'One `EVAL` does `HGET`, the cap comparison, `HINCRBY` and `EXPIRE`. A client-side read followed by a separate increment races: two requests both observe budget that only one of them can spend.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/, /HINCRBY/, /HGET/, /EXPIRE/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/, /HINCRBY/, /HGET/, /EXPIRE/]},
        go: {all: [/reserveScript/, /\.Run\(/, /HINCRBY/, /HGET/, /EXPIRE/]},
        scala: {all: [/ReserveLua/, /\.eval\(/, /HINCRBY/, /HGET/, /EXPIRE/]},
        cpp: {all: [/kReserveLua/, /\.eval[<(]/, /HINCRBY/, /HGET/, /EXPIRE/]},
      },
    },
    {
      id: 'reserve-before-detect',
      title: 'Reserves the budget before the detector runs',
      detail:
        'The reservation happens before `detect`; an over-budget request never reaches the detector. The starter calls the detector first and increments afterwards, so rejected work is already paid for.',
      match: {
        python: {order: [/reserve_budget\(/, /detector\.detect\(/]},
        typescript: {order: [/reserveBudget\(/, /detector\.detect\(/]},
        go: {order: [/reserveBudget\(/, /detector\.Detect\(/]},
        scala: {order: [/reserveBudget\(/, /detector\.detect\(/]},
        cpp: {order: [/reserve_budget\(/, /detector\.detect\(/]},
      },
    },
    {
      id: 'over-budget-429',
      title: 'Answers 429 with Retry-After and remaining characters',
      detail:
        'An exhausted tenant gets **429** with `Retry-After` (the key TTL) and `X-RateLimit-Remaining`, built from the script result — not a hardcoded constant. The starter has no refusal path at all.',
      match: {
        python: {all: [/status_code\s*=\s*429/, /Retry-After/, /X-RateLimit-Remaining/]},
        typescript: {all: [/\b429\b/, /Retry-After/, /X-RateLimit-Remaining/]},
        go: {all: [/StatusTooManyRequests/, /Retry-After/, /X-RateLimit-Remaining/]},
        scala: {all: [/StatusCodes\.TooManyRequests/, /Retry-After/, /X-RateLimit-Remaining/]},
        cpp: {all: [/\b429\b/, /Retry-After/, /X-RateLimit-Remaining/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import time

import redis

conn = redis.Redis.from_url("redis://redis:6379/0", decode_responses=True)


def pattern_version(regex: str) -> int:
    """Stable id for a pattern body."""
    return int(hashlib.sha256(regex.encode("utf-8")).hexdigest()[:8], 16)


def cached_patterns(tenant: str, patterns: dict[str, str]) -> list[tuple[str, str]]:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    resolved = []
    for pattern_id, regex in patterns.items():
        key = f"pattern:{pattern_id}"
        cached = conn.get(key)
        if cached is None:
            conn.set(key, regex)
            cached = regex
        resolved.append((pattern_id, cached))
    return resolved


def redact(tenant: str, text: str, patterns: dict[str, str], detector) -> dict:
    resolved = cached_patterns(tenant, patterns)
    spans = detector.detect(text, resolved)
    conn.incrby(f"budget:{tenant}", len(text))
    return {"spans": spans, "pattern_version": pattern_version(str(patterns))}
`,
      solution: `import hashlib
import time

from fastapi import HTTPException

import redis

PATTERN_TTL = 3600
WINDOW_S = 3600
BUDGET_PER_HOUR = 2_000_000

RESERVE_LUA = """
local used = tonumber(redis.call('HGET', KEYS[1], 'chars') or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + cost > cap then
  return -1
end
redis.call('HINCRBY', KEYS[1], 'chars', cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return cap - used - cost
"""

conn = redis.Redis.from_url("redis://redis:6379/0", decode_responses=True)


def pattern_version(regex: str) -> int:
    """Stable id for a pattern body: editing the body lands under a new version."""
    return int(hashlib.sha256(regex.encode("utf-8")).hexdigest()[:8], 16)


def pattern_key(tenant: str, pattern_id: str, version: int) -> str:
    return f"patterns:{tenant}:{pattern_id}:{version}"


def budget_key(tenant: str, window: int) -> str:
    return f"budget:{tenant}:{window}"


def resolve_patterns(tenant: str, patterns: dict[str, str]) -> list[tuple[str, str, int]]:
    """Resolve (pattern_id, regex, version) inside this tenant's namespace, caching every miss."""
    resolved = []
    for pattern_id, regex in patterns.items():
        version = pattern_version(regex)
        key = pattern_key(tenant, pattern_id, version)
        cached = conn.get(key)
        if cached is None:
            conn.set(key, regex, ex=PATTERN_TTL)
            cached = regex
        resolved.append((pattern_id, cached, version))
    return resolved


def reserve_budget(tenant: str, chars: int) -> tuple[int, int]:
    """Reserve \`chars\` against the tenant's hourly budget in one atomic script.

    Returns (remaining, retry_after); remaining is -1 when the reservation was refused.
    """
    window = int(time.time()) // WINDOW_S
    key = budget_key(tenant, window)
    remaining = int(conn.eval(RESERVE_LUA, 1, key, chars, BUDGET_PER_HOUR, WINDOW_S))
    retry_after = max(int(conn.ttl(key)), 0) if remaining == -1 else 0
    return remaining, retry_after


def redact(tenant: str, text: str, patterns: dict[str, str], detector) -> dict:
    remaining, retry_after = reserve_budget(tenant, len(text))
    if remaining == -1:
        raise HTTPException(
            status_code=429,
            detail={"error": "budget_exceeded"},
            headers={"Retry-After": str(retry_after), "X-RateLimit-Remaining": "0"},
        )
    resolved = resolve_patterns(tenant, patterns)
    spans = detector.detect(text, resolved)
    version = resolved[0][2] if resolved else 0
    return {"spans": spans, "pattern_version": version, "remaining_chars": remaining}
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import IORedis from 'ioredis';

export const conn = new IORedis('redis://redis:6379/0');

function patternVersion(regex: string): number {
  return parseInt(createHash('sha256').update(regex).digest('hex').slice(0, 8), 16);
}

function cachedPatterns(tenant: string, patterns: Record<string, string>): Array<[string, string]> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const resolved: Array<[string, string]> = [];
  for (const [patternId, regex] of Object.entries(patterns)) {
    void conn.get(\`pattern:\${patternId}\`).then(async cached => {
      if (cached === null) await conn.set(\`pattern:\${patternId}\`, regex);
    });
    resolved.push([patternId, regex]);
  }
  return resolved;
}

export async function redact(tenant: string, text: string, patterns: Record<string, string>, detector: Detector) {
  const resolved = cachedPatterns(tenant, patterns);
  const spans = await detector.detect(text, resolved);
  await conn.incrby(\`budget:\${tenant}\`, text.length);
  return {spans, pattern_version: patternVersion(JSON.stringify(patterns))};
}
`,
      solution: `import {createHash} from 'node:crypto';

import IORedis from 'ioredis';

export const conn = new IORedis('redis://redis:6379/0');

const PATTERN_TTL = 3600;
const WINDOW_S = 3600;
const BUDGET_PER_HOUR = 2_000_000;

const RESERVE_LUA = \`
local used = tonumber(redis.call('HGET', KEYS[1], 'chars') or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + cost > cap then
  return -1
end
redis.call('HINCRBY', KEYS[1], 'chars', cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return cap - used - cost
\`;

function patternVersion(regex: string): number {
  return parseInt(createHash('sha256').update(regex).digest('hex').slice(0, 8), 16);
}

const patternKey = (tenant: string, patternId: string, version: number): string =>
  \`patterns:\${tenant}:\${patternId}:\${version}\`;
const budgetKey = (tenant: string, window: number): string => \`budget:\${tenant}:\${window}\`;

async function resolvePatterns(tenant: string, patterns: Record<string, string>) {
  const resolved: Array<{pattern_id: string; regex: string; version: number}> = [];
  for (const [patternId, regex] of Object.entries(patterns)) {
    const version = patternVersion(regex);
    const key = patternKey(tenant, patternId, version);
    let cached = await conn.get(key);
    if (cached === null) {
      await conn.set(key, regex, 'EX', PATTERN_TTL);
      cached = regex;
    }
    resolved.push({pattern_id: patternId, regex: cached, version});
  }
  return resolved;
}

/** Reserve \`chars\` against the tenant's hourly budget in one atomic script. */
async function reserveBudget(tenant: string, chars: number): Promise<{remaining: number; retryAfter: number}> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const key = budgetKey(tenant, window);
  const remaining = Number(await conn.eval(RESERVE_LUA, 1, key, chars, BUDGET_PER_HOUR, WINDOW_S));
  if (remaining === -1) return {remaining, retryAfter: Math.max(await conn.ttl(key), 0)};
  return {remaining, retryAfter: 0};
}

export async function redact(tenant: string, text: string, patterns: Record<string, string>, detector: Detector) {
  const {remaining, retryAfter} = await reserveBudget(tenant, text.length);
  if (remaining === -1)
    throw Object.assign(new Error('budget_exceeded'), {
      status: 429,
      headers: {'Retry-After': String(retryAfter), 'X-RateLimit-Remaining': '0'},
    });
  const resolved = await resolvePatterns(tenant, patterns);
  const spans = await detector.detect(text, resolved);
  return {spans, pattern_version: resolved[0]?.version ?? 0, remaining_chars: remaining};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func patternVersion(regex string) int {
	sum := sha256.Sum256([]byte(regex))
	return int(binary.BigEndian.Uint32(sum[:4]))
}

func cachedPatterns(ctx context.Context, tenant string, patterns map[string]string) []ResolvedPattern {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	resolved := make([]ResolvedPattern, 0, len(patterns))
	for id, regex := range patterns {
		key := fmt.Sprintf("pattern:%s", id)
		cached, err := rdb.Get(ctx, key).Result()
		if err != nil {
			rdb.Set(ctx, key, regex, 0)
			cached = regex
		}
		resolved = append(resolved, ResolvedPattern{ID: id, Regex: cached})
	}
	return resolved
}

func redact(ctx context.Context, tenant, text string, patterns map[string]string, detector Detector) (any, error) {
	resolved := cachedPatterns(ctx, tenant, patterns)
	spans, err := detector.Detect(ctx, text, resolved)
	if err != nil {
		return nil, err
	}
	rdb.IncrBy(ctx, fmt.Sprintf("budget:%s", tenant), int64(len(text)))
	return map[string]any{"spans": spans}, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	patternTTL    = 3600 * time.Second
	windowSeconds = 3600
	budgetPerHour = 2_000_000
)

const reserveScript = \`
local used = tonumber(redis.call('HGET', KEYS[1], 'chars') or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + cost > cap then
  return -1
end
redis.call('HINCRBY', KEYS[1], 'chars', cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return cap - used - cost
\`

var (
	rdb        = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	reserveCmd = redis.NewScript(reserveScript)
)

// ErrBudgetExceeded carries how long the caller should wait before retrying.
type ErrBudgetExceeded struct{ RetryAfter int64 }

func (e *ErrBudgetExceeded) Error() string { return "budget_exceeded" }

func patternVersion(regex string) int {
	sum := sha256.Sum256([]byte(regex))
	return int(binary.BigEndian.Uint32(sum[:4]))
}

func patternKey(tenant, patternID string, version int) string {
	return fmt.Sprintf("patterns:%s:%s:%d", tenant, patternID, version)
}

func budgetKey(tenant string, window int64) string {
	return fmt.Sprintf("budget:%s:%d", tenant, window)
}

func resolvePatterns(ctx context.Context, tenant string, patterns map[string]string) ([]ResolvedPattern, error) {
	resolved := make([]ResolvedPattern, 0, len(patterns))
	for id, regex := range patterns {
		version := patternVersion(regex)
		key := patternKey(tenant, id, version)
		cached, err := rdb.Get(ctx, key).Result()
		if errors.Is(err, redis.Nil) {
			if err := rdb.Set(ctx, key, regex, patternTTL).Err(); err != nil {
				return nil, err
			}
			cached = regex
		} else if err != nil {
			return nil, err
		}
		resolved = append(resolved, ResolvedPattern{ID: id, Regex: cached, Version: version})
	}
	return resolved, nil
}

// reserveBudget reserves chars against the tenant's hourly budget in one atomic script.
// It returns (remaining, retryAfter); remaining is -1 when the reservation was refused.
func reserveBudget(ctx context.Context, tenant string, chars int) (int, int64, error) {
	window := time.Now().Unix() / windowSeconds
	key := budgetKey(tenant, window)
	remaining, err := reserveCmd.Run(ctx, rdb, []string{key}, chars, budgetPerHour, windowSeconds).Int()
	if err != nil {
		return 0, 0, err
	}
	if remaining == -1 {
		ttl, err := rdb.TTL(ctx, key).Result()
		if err != nil {
			return 0, 0, err
		}
		return -1, int64(ttl.Seconds()), nil
	}
	return remaining, 0, nil
}

func redact(ctx context.Context, tenant, text string, patterns map[string]string, detector Detector) (any, error) {
	remaining, retryAfter, err := reserveBudget(ctx, tenant, len(text))
	if err != nil {
		return nil, err
	}
	if remaining == -1 {
		return nil, &ErrBudgetExceeded{RetryAfter: retryAfter}
	}
	resolved, err := resolvePatterns(ctx, tenant, patterns)
	if err != nil {
		return nil, err
	}
	spans, err := detector.Detect(ctx, text, resolved)
	if err != nil {
		return nil, err
	}
	version := 0
	if len(resolved) > 0 {
		version = resolved[0].Version
	}
	return map[string]any{"spans": spans, "pattern_version": version, "remaining_chars": remaining}, nil
}

// budgetError maps an exhausted budget to the 429 contract; it reports whether it handled the error.
func budgetError(rw http.ResponseWriter, err error) bool {
	var exceeded *ErrBudgetExceeded
	if !errors.As(err, &exceeded) {
		return false
	}
	rw.Header().Set("Retry-After", strconv.FormatInt(exceeded.RetryAfter, 10))
	rw.Header().Set("X-RateLimit-Remaining", "0")
	writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "budget_exceeded"})
	return true
}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets

import redis.clients.jedis.Jedis

object RedactionState {
  val jedis = new Jedis("redis", 6379)

  def patternVersion(regex: String): Int =
    java.security.MessageDigest.getInstance("SHA-256").digest(regex.getBytes(StandardCharsets.UTF_8)).take(4).foldLeft(0)((acc, b) => (acc << 8) | (b & 0xff))

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def cachedPatterns(tenant: String, patterns: Map[String, String]): List[ResolvedPattern] =
    patterns.map { case (id, regex) =>
      val key = s"pattern:$id"
      val cached = Option(jedis.get(key)).getOrElse {
        jedis.set(key, regex)
        regex
      }
      ResolvedPattern(id, cached)
    }.toList

  def redact(tenant: String, text: String, patterns: Map[String, String], detector: Detector): Map[String, Any] = {
    val resolved = cachedPatterns(tenant, patterns)
    val spans = detector.detect(text, resolved)
    jedis.incrBy(s"budget:$tenant", text.getBytes(StandardCharsets.UTF_8).length.toLong)
    Map("spans" -> spans)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.util

import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import redis.clients.jedis.Jedis

object RedactionState {
  val PatternTtl = 3600L
  val WindowSeconds = 3600L
  val BudgetPerHour = 2000000L

  val ReserveLua: String =
    """local used = tonumber(redis.call('HGET', KEYS[1], 'chars') or '0')
      |local cost = tonumber(ARGV[1])
      |local cap = tonumber(ARGV[2])
      |if used + cost > cap then
      |  return -1
      |end
      |redis.call('HINCRBY', KEYS[1], 'chars', cost)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |end
      |return cap - used - cost""".stripMargin

  val jedis = new Jedis("redis", 6379)

  final case class BudgetExceeded(retryAfter: Long) extends RuntimeException("budget_exceeded")

  def patternVersion(regex: String): Int =
    java.security.MessageDigest.getInstance("SHA-256").digest(regex.getBytes(StandardCharsets.UTF_8)).take(4).foldLeft(0)((acc, b) => (acc << 8) | (b & 0xff))

  def patternKey(tenant: String, patternId: String, version: Int): String =
    s"patterns:$tenant:$patternId:$version"

  def budgetKey(tenant: String, window: Long): String = s"budget:$tenant:$window"

  def resolvePatterns(tenant: String, patterns: Map[String, String]): List[ResolvedPattern] =
    patterns.map { case (id, regex) =>
      val version = patternVersion(regex)
      val key = patternKey(tenant, id, version)
      val cached = Option(jedis.get(key)).getOrElse {
        jedis.setex(key, PatternTtl, regex)
        regex
      }
      ResolvedPattern(id, cached, version)
    }.toList

  /** Reserves chars against the tenant's hourly budget in one atomic script.
    * Returns (remaining, retryAfter); remaining is -1 when the reservation was refused.
    */
  def reserveBudget(tenant: String, chars: Long): (Long, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val key = budgetKey(tenant, window)
    val args = List(chars.toString, BudgetPerHour.toString, WindowSeconds.toString)
    val remaining = jedis.eval(ReserveLua, List(key).asJava, args.asJava).asInstanceOf[java.lang.Long].longValue
    if (remaining == -1) (-1L, Math.max(jedis.ttl(key), 0L)) else (remaining, 0L)
  }

  def redact(tenant: String, text: String, patterns: Map[String, String], detector: Detector): Map[String, Any] = {
    val (remaining, retryAfter) = reserveBudget(tenant, text.getBytes(StandardCharsets.UTF_8).length.toLong)
    if (remaining == -1) throw BudgetExceeded(retryAfter)
    val resolved = resolvePatterns(tenant, patterns)
    val spans = detector.detect(text, resolved)
    Map("spans" -> spans, "pattern_version" -> resolved.headOption.map(_.version).getOrElse(0), "remaining_chars" -> remaining)
  }

  /** Maps an exhausted budget to the 429 contract. */
  def budgetResponse(exceeded: BudgetExceeded): HttpResponse =
    HttpResponse(
      StatusCodes.TooManyRequests,
      headers = List(
        RawHeader("Retry-After", exceeded.retryAfter.toString),
        RawHeader("X-RateLimit-Remaining", "0"),
      ),
      entity = HttpEntity(ContentTypes.\`application/json\`, """{"error":"budget_exceeded"}"""),
    )
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>
#include <vector>

using sw::redis::Redis;

Redis conn("tcp://redis:6379");

struct ResolvedPattern {
  std::string id;
  std::string regex;
};

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
std::vector<ResolvedPattern> cached_patterns(const std::string& tenant, const std::unordered_map<std::string, std::string>& patterns) {
  std::vector<ResolvedPattern> resolved;
  for (const auto& [id, regex] : patterns) {
    const std::string key = "pattern:" + id;
    auto cached = conn.get(key);
    if (!cached) {
      conn.set(key, regex);
      cached = regex;
    }
    resolved.push_back({id, *cached});
  }
  return resolved;
}

std::vector<Span> redact(const std::string& tenant, const std::string& text, const std::unordered_map<std::string, std::string>& patterns) {
  const auto resolved = cached_patterns(tenant, patterns);
  auto spans = detector.detect(text, resolved);
  conn.incr("budget:" + tenant, text.size());
  return spans;
}
`,
      solution: `#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <functional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

using sw::redis::Redis;

constexpr long long kPatternTtl = 3600;
constexpr long long kWindowSeconds = 3600;
constexpr long long kBudgetPerHour = 2000000;

const std::string kReserveLua = R"lua(
local used = tonumber(redis.call('HGET', KEYS[1], 'chars') or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + cost > cap then
  return -1
end
redis.call('HINCRBY', KEYS[1], 'chars', cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return cap - used - cost
)lua";

Redis conn("tcp://redis:6379");

struct ResolvedPattern {
  std::string id;
  std::string regex;
  int version = 0;
};

struct BudgetExceeded : std::exception {
  long long retry_after = 0;
  explicit BudgetExceeded(long long after) : retry_after(after) {}
};

int pattern_version(const std::string& regex) {
  return static_cast<int>(std::hash<std::string>{}(regex) & 0x7fffffff);
}

std::string pattern_key(const std::string& tenant, const std::string& pattern_id, int version) {
  return "patterns:" + tenant + ":" + pattern_id + ":" + std::to_string(version);
}

std::string budget_key(const std::string& tenant, long long window) {
  return "budget:" + tenant + ":" + std::to_string(window);
}

std::vector<ResolvedPattern> resolve_patterns(const std::string& tenant, const std::unordered_map<std::string, std::string>& patterns) {
  std::vector<ResolvedPattern> resolved;
  for (const auto& [id, regex] : patterns) {
    const int version = pattern_version(regex);
    const std::string key = pattern_key(tenant, id, version);
    auto cached = conn.get(key);
    if (!cached) {
      conn.set(key, regex, std::chrono::seconds(kPatternTtl));
      cached = regex;
    }
    resolved.push_back({id, *cached, version});
  }
  return resolved;
}

/** Reserves chars against the tenant's hourly budget in one atomic script.
 *  Returns (remaining, retry_after); remaining is -1 when the reservation was refused. */
std::pair<long long, long long> reserve_budget(const std::string& tenant, long long chars) {
  const long long window = std::chrono::duration_cast<std::chrono::seconds>(
                               std::chrono::system_clock::now().time_since_epoch()).count() / kWindowSeconds;
  const std::string key = budget_key(tenant, window);
  const long long remaining = conn.eval<long long>(
      kReserveLua, {key},
      {std::to_string(chars), std::to_string(kBudgetPerHour), std::to_string(kWindowSeconds)});
  if (remaining == -1) return {-1, std::max<long long>(conn.ttl(key), 0)};
  return {remaining, 0};
}

std::vector<Span> redact(const std::string& tenant, const std::string& text, const std::unordered_map<std::string, std::string>& patterns) {
  const auto [remaining, retry_after] = reserve_budget(tenant, static_cast<long long>(text.size()));
  if (remaining == -1) throw BudgetExceeded(retry_after);
  const auto resolved = resolve_patterns(tenant, patterns);
  auto spans = detector.detect(text, resolved);
  return spans;
}

/** Maps an exhausted budget to the 429 contract. */
void budget_exceeded(httplib::Response& res, long long retry_after) {
  res.status = 429;
  res.set_header("Retry-After", std::to_string(retry_after));
  res.set_header("X-RateLimit-Remaining", "0");
  res.set_content(R"({"error":"budget_exceeded"})", "application/json");
}
`,
    },
  },
  hints: [
    "After a second tenant registers a rule with the id `http-url`, the first tenant's documents stop producing spans for it, and one busy tenant can run the detector all day without ever seeing a 429.",
    'The cache key is `pattern:{pattern_id}` with no tenant or version, so the last writer wins; the counter is `budget:{tenant}` with no window, no cap and no refusal path, incremented after the detector ran.',
    'Key patterns as `patterns:{tenant}:{pattern_id}:{version}` with `SET … EX 3600`; before `detect`, run one `EVAL` that `HGET`s, compares to the cap, `HINCRBY`s and `EXPIRE`s `budget:{tenant}:{window}`, answering 429 on rejection.',
  ],
  debrief: `The fix has its shape because every flaw here is about where a decision is made. Tenant and version in the key move the isolation decision into Redis addressing, so a rule edit is a new entry and another tenant's rule cannot be found at all. The Lua script moves the budget decision into one Redis round trip, so two concurrent requests cannot both observe room, and running it before the detector means a refusal costs nothing. The 429 carries the key's TTL as \`Retry-After\` so the client knows when the window turns over. Production meters also reconcile the reservation after the call (refund on detector failure), keep a per-tenant cap in configuration instead of a constant, and alert on budget keys that grow without a matching expiry.`,
};
