import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis dedupe and per-tenant ingest quota',
  concept: 'redis',
  file: 'state',
  focus: ['ingest', 'redis'],
  task: `## Task

**Starting point.** The starter's \`reserve(tenant, checksum, asset_id)\` is the reservation a
registration takes before it creates an asset. It reads the counter \`ingest:quota:{tenant}\`
(\`throttled\` with \`retry_after: 60\` at 500), increments it, reads \`ingest:dedupe:{checksum}\` and
answers \`duplicate\` with the stored asset id, or marks the hash with \`SET\` and answers
\`reserved\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** Tenant t2 uploading an image t1 already has is answered with
t1's asset id; two replicas registering one upload both pass the \`GET\` and both create it; a
counter without a window locks a tenant out after its first busy minute, and no key ever expires;
re-uploads spend quota and are refused once it runs out; every refused client comes back exactly
60 s later, wherever in the minute it was refused.

- Keys: \`ingest:dedupe:{tenant}:{checksum}\` (the asset id, expiring after a day) and
  \`ingest:quota:{tenant}:{window}\`, \`window = floor(unix_seconds / WINDOW_S)\`, expiring with its
  window.
- One Lua script (\`EVAL\`) runs the dedupe check, the quota check, the mark and the increment in
  that order: a duplicate answers before the counter is read, a refusal changes nothing.
- At most \`QUOTA_PER_MINUTE\` = 500 reservations per tenant and window; past it the answer is
  \`throttled\` with \`retry_after\` = the seconds left in the window.`,
  sequence: {
    participants: ['Ingest API', 'Redis'],
    messages: [
      {
        from: 'Ingest API',
        to: 'Redis',
        label: 'EVAL reserve · ingest:dedupe:t1:sha256:… · ingest:quota:t1:29716417',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Redis',
        label: 'GET dedupe → duplicate · GET quota → throttled · SET EX · INCR · EXPIRE',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Ingest API', label: '"reserved:a-7" · "duplicate:a-3" · "throttled:"', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'tenant-dedupe',
      title: 'Keys the dedupe mark by tenant and checksum',
      detail:
        "The dedupe key is `ingest:dedupe:{tenant}:{checksum}`; the starter keys it by the checksum alone, so a tenant uploading an image another tenant has is answered with that tenant's asset id.",
      match: {
        python: {all: [/ingest:dedupe:["'+\s{$]*tenant/]},
        typescript: {all: [/ingest:dedupe:["'+\s{$]*tenant/]},
        go: {all: [/ingest:dedupe:["'+\s{$]*tenant/]},
        scala: {all: [/ingest:dedupe:["'+\s{$]*tenant/]},
        cpp: {all: [/ingest:dedupe:["'+\s{$]*tenant/]},
      },
    },
    {
      id: 'atomic-reserve',
      title: 'Checks and marks in one Lua script',
      detail:
        'The dedupe check, quota check, mark and increment run in one script; the starter sends them as separate commands, so a second replica landing between its `GET` and its `SET` registers the same upload too.',
      match: {
        python: {all: [/register_script\(|\.eval\(/], none: [/\br\.incr\(/, /\br\.set\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/], none: [/redis\.incr\(/, /redis\.set\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/], none: [/rdb\.Incr\(/, /rdb\.Set\(/]},
        scala: {all: [/jedis\.eval\(/], none: [/jedis\.incr\(/, /jedis\.set\(/]},
        cpp: {all: [/redis\.eval</], none: [/redis\.incr\(/, /redis\.set\(/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'Counts per minute window and expires every key',
      detail:
        'The counter is keyed by `floor(unix_seconds / WINDOW_S)` and expires with its window, the dedupe mark after a day; the starter keeps one counter per tenant forever, so a busy minute refuses the tenant from then on.',
      match: {
        python: {all: [/\/\/\s*WINDOW_S/, /EXPIRE/, /'EX'|"EX"/]},
        typescript: {all: [/\/\s*WINDOW_S/, /EXPIRE/, /'EX'|"EX"/]},
        go: {all: [/\/\s*windowSeconds/, /EXPIRE/, /'EX'|"EX"/]},
        scala: {all: [/\/\s*WindowSeconds/, /EXPIRE/, /'EX'|"EX"/]},
        cpp: {all: [/\/\s*kWindowSeconds/, /EXPIRE/, /'EX'|"EX"/]},
      },
    },
    {
      id: 'duplicate-free',
      title: 'A duplicate answers before the quota is read',
      detail:
        'The script returns `duplicate` before it reads or increments the counter; the starter counts first, so re-uploads spend quota and are refused once the tenant runs out.',
      match: {
        python: {
          order: [/GET['"]?\s*,\s*KEYS\[1\]/, /duplicate/, /GET['"]?\s*,\s*KEYS\[2\]/, /INCR['"]?\s*,\s*KEYS\[2\]/],
        },
        typescript: {
          order: [/GET['"]?\s*,\s*KEYS\[1\]/, /duplicate/, /GET['"]?\s*,\s*KEYS\[2\]/, /INCR['"]?\s*,\s*KEYS\[2\]/],
        },
        go: {order: [/GET['"]?\s*,\s*KEYS\[1\]/, /duplicate/, /GET['"]?\s*,\s*KEYS\[2\]/, /INCR['"]?\s*,\s*KEYS\[2\]/]},
        scala: {
          order: [/GET['"]?\s*,\s*KEYS\[1\]/, /duplicate/, /GET['"]?\s*,\s*KEYS\[2\]/, /INCR['"]?\s*,\s*KEYS\[2\]/],
        },
        cpp: {
          order: [/GET['"]?\s*,\s*KEYS\[1\]/, /duplicate/, /GET['"]?\s*,\s*KEYS\[2\]/, /INCR['"]?\s*,\s*KEYS\[2\]/],
        },
      },
    },
    {
      id: 'retry-after',
      title: 'A refusal says when the window resets',
      detail:
        '`retry_after` is the seconds left in the current window (`WINDOW_S - now % WINDOW_S`) and the refusal reserves nothing; the starter always says 60.',
      match: {
        python: {all: [/%\s*WINDOW_S/]},
        typescript: {all: [/%\s*WINDOW_S/]},
        go: {all: [/%\s*windowSeconds/]},
        scala: {all: [/%\s*WindowSeconds/]},
        cpp: {all: [/%\s*kWindowSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUOTA_PER_MINUTE = 500
WINDOW_S = 60


def reserve(tenant: str, checksum: str, asset_id: str) -> dict:
    """Reserve (tenant, checksum) for asset_id: {"outcome": reserved | duplicate | throttled, "asset_id", "retry_after"}."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    dedupe_key = f"ingest:dedupe:{checksum}"
    quota_key = f"ingest:quota:{tenant}"
    used = int(r.get(quota_key) or 0)
    if used >= QUOTA_PER_MINUTE:
        return {"outcome": "throttled", "asset_id": None, "retry_after": WINDOW_S}
    r.incr(quota_key)
    existing = r.get(dedupe_key)
    if existing is not None:
        return {"outcome": "duplicate", "asset_id": existing, "retry_after": 0}
    r.set(dedupe_key, asset_id)
    return {"outcome": "reserved", "asset_id": asset_id, "retry_after": 0}
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUOTA_PER_MINUTE = 500
WINDOW_S = 60
DEDUPE_TTL_S = 24 * 3600

# KEYS[1] the dedupe mark, KEYS[2] this window's counter; ARGV: asset id, quota, window, dedupe TTL.
# A duplicate answers before the counter is read: a re-upload costs nothing, whatever the counter says.
RESERVE_LUA = """
local existing = redis.call('GET', KEYS[1])
if existing then return 'duplicate:' .. existing end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= tonumber(ARGV[2]) then return 'throttled:' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return 'reserved:' .. ARGV[1]
"""
reserve_script = r.register_script(RESERVE_LUA)


def reserve(tenant: str, checksum: str, asset_id: str) -> dict:
    """Reserve (tenant, checksum) for asset_id: {"outcome": reserved | duplicate | throttled, "asset_id", "retry_after"}."""
    now = int(time.time())
    window = now // WINDOW_S
    keys = [f"ingest:dedupe:{tenant}:{checksum}", f"ingest:quota:{tenant}:{window}"]
    reply = reserve_script(keys=keys, args=[asset_id, QUOTA_PER_MINUTE, WINDOW_S, DEDUPE_TTL_S])
    outcome, _, found = reply.partition(":")
    if outcome == "throttled":
        return {"outcome": outcome, "asset_id": None, "retry_after": WINDOW_S - now % WINDOW_S}
    return {"outcome": outcome, "asset_id": found, "retry_after": 0}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const QUOTA_PER_MINUTE = 500;
export const WINDOW_S = 60;

export interface Reservation {
  outcome: 'reserved' | 'duplicate' | 'throttled';
  asset_id: string | null;
  retry_after: number;
}

/** Reserve (tenant, checksum) for assetId against the tenant's quota. */
export async function reserve(tenant: string, checksum: string, assetId: string): Promise<Reservation> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const dedupeKey = \`ingest:dedupe:\${checksum}\`;
  const quotaKey = \`ingest:quota:\${tenant}\`;
  const used = Number((await redis.get(quotaKey)) ?? 0);
  if (used >= QUOTA_PER_MINUTE) return {outcome: 'throttled', asset_id: null, retry_after: WINDOW_S};
  await redis.incr(quotaKey);
  const existing = await redis.get(dedupeKey);
  if (existing !== null) return {outcome: 'duplicate', asset_id: existing, retry_after: 0};
  await redis.set(dedupeKey, assetId);
  return {outcome: 'reserved', asset_id: assetId, retry_after: 0};
}
`,
      solution: `import Redis from 'ioredis';

export const QUOTA_PER_MINUTE = 500;
export const WINDOW_S = 60;
export const DEDUPE_TTL_S = 24 * 3600;

// KEYS[1] the dedupe mark, KEYS[2] this window's counter; ARGV: asset id, quota, window, dedupe TTL.
// A duplicate answers before the counter is read: a re-upload costs nothing, whatever the counter says.
export const RESERVE_LUA = \`
local existing = redis.call('GET', KEYS[1])
if existing then return 'duplicate:' .. existing end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= tonumber(ARGV[2]) then return 'throttled:' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return 'reserved:' .. ARGV[1]
\`;

interface ReserveRedis extends Redis {
  reserveUpload(dedupeKey: string, quotaKey: string, assetId: string, quota: number, window: number, ttl: number): Promise<string>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ReserveRedis;
redis.defineCommand('reserveUpload', {numberOfKeys: 2, lua: RESERVE_LUA});

export interface Reservation {
  outcome: 'reserved' | 'duplicate' | 'throttled';
  asset_id: string | null;
  retry_after: number;
}

/** Reserve (tenant, checksum) for assetId against the tenant's quota. */
export async function reserve(tenant: string, checksum: string, assetId: string): Promise<Reservation> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_S);
  const reply = await redis.reserveUpload(
    \`ingest:dedupe:\${tenant}:\${checksum}\`,
    \`ingest:quota:\${tenant}:\${window}\`,
    assetId,
    QUOTA_PER_MINUTE,
    WINDOW_S,
    DEDUPE_TTL_S,
  );
  const colon = reply.indexOf(':');
  const outcome = reply.slice(0, colon) as Reservation['outcome'];
  if (outcome === 'throttled') return {outcome, asset_id: null, retry_after: WINDOW_S - (now % WINDOW_S)};
  return {outcome, asset_id: reply.slice(colon + 1), retry_after: 0};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const (
	quotaPerMinute = 500
	windowSeconds  = 60
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Reservation is the answer to a reservation: Outcome reserved, duplicate or throttled.
type Reservation struct {
	Outcome    string \`json:"outcome"\`
	AssetID    string \`json:"asset_id"\`
	RetryAfter int64  \`json:"retry_after"\`
}

// reserve reserves (tenant, checksum) for assetID against the tenant's quota.
func reserve(ctx context.Context, tenant, checksum, assetID string) (Reservation, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	dedupeKey := "ingest:dedupe:" + checksum
	quotaKey := "ingest:quota:" + tenant
	used, _ := rdb.Get(ctx, quotaKey).Int()
	if used >= quotaPerMinute {
		return Reservation{Outcome: "throttled", RetryAfter: windowSeconds}, nil
	}
	if err := rdb.Incr(ctx, quotaKey).Err(); err != nil {
		return Reservation{}, err
	}
	if existing, err := rdb.Get(ctx, dedupeKey).Result(); err == nil {
		return Reservation{Outcome: "duplicate", AssetID: existing}, nil
	}
	if err := rdb.Set(ctx, dedupeKey, assetID, 0).Err(); err != nil {
		return Reservation{}, err
	}
	return Reservation{Outcome: "reserved", AssetID: assetID}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	quotaPerMinute   = 500
	windowSeconds    = 60
	dedupeTTLSeconds = 24 * 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// reserveScript: KEYS[1] the dedupe mark, KEYS[2] this window's counter; ARGV: asset id, quota,
// window, dedupe TTL. A duplicate answers before the counter is read: a re-upload costs nothing.
var reserveScript = redis.NewScript(\`
local existing = redis.call('GET', KEYS[1])
if existing then return 'duplicate:' .. existing end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= tonumber(ARGV[2]) then return 'throttled:' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return 'reserved:' .. ARGV[1]
\`)

// Reservation is the answer to a reservation: Outcome reserved, duplicate or throttled.
type Reservation struct {
	Outcome    string \`json:"outcome"\`
	AssetID    string \`json:"asset_id"\`
	RetryAfter int64  \`json:"retry_after"\`
}

// reserve reserves (tenant, checksum) for assetID against the tenant's quota.
func reserve(ctx context.Context, tenant, checksum, assetID string) (Reservation, error) {
	now := time.Now().Unix()
	window := now / windowSeconds
	keys := []string{"ingest:dedupe:" + tenant + ":" + checksum, fmt.Sprintf("ingest:quota:%s:%d", tenant, window)}
	reply, err := reserveScript.Run(ctx, rdb, keys, assetID, quotaPerMinute, windowSeconds, dedupeTTLSeconds).Text()
	if err != nil {
		return Reservation{}, err
	}
	outcome, found, _ := strings.Cut(reply, ":")
	if outcome == "throttled" {
		return Reservation{Outcome: outcome, RetryAfter: windowSeconds - now%windowSeconds}, nil
	}
	return Reservation{Outcome: outcome, AssetID: found}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object State {
  /** The answer to a reservation: outcome reserved, duplicate or throttled. */
  final case class Reservation(outcome: String, assetId: Option[String], retryAfter: Long)

  val QuotaPerMinute = 500
  val WindowSeconds = 60L

  val jedis = new JedisPooled("redis", 6379)

  /** Reserve (tenant, checksum) for assetId against the tenant's quota. */
  def reserve(tenant: String, checksum: String, assetId: String): Reservation = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val dedupeKey = s"ingest:dedupe:$checksum"
    val quotaKey = s"ingest:quota:$tenant"
    val used = Option(jedis.get(quotaKey)).map(_.toLong).getOrElse(0L)
    if (used >= QuotaPerMinute) Reservation("throttled", None, WindowSeconds)
    else {
      jedis.incr(quotaKey)
      Option(jedis.get(dedupeKey)) match {
        case Some(existing) => Reservation("duplicate", Some(existing), 0L)
        case None =>
          jedis.set(dedupeKey, assetId)
          Reservation("reserved", Some(assetId), 0L)
      }
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  /** The answer to a reservation: outcome reserved, duplicate or throttled. */
  final case class Reservation(outcome: String, assetId: Option[String], retryAfter: Long)

  val QuotaPerMinute = 500
  val WindowSeconds = 60L
  val DedupeTtlSeconds: Long = 24 * 3600

  val jedis = new JedisPooled("redis", 6379)

  /** KEYS[1] the dedupe mark, KEYS[2] this window's counter; ARGV: asset id, quota, window, dedupe TTL. */
  val ReserveLua: String =
    """local existing = redis.call('GET', KEYS[1])
      |if existing then return 'duplicate:' .. existing end
      |local used = tonumber(redis.call('GET', KEYS[2]) or '0')
      |if used >= tonumber(ARGV[2]) then return 'throttled:' end
      |redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
      |if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
      |return 'reserved:' .. ARGV[1]
      |""".stripMargin

  /** Reserve (tenant, checksum) for assetId against the tenant's quota. */
  def reserve(tenant: String, checksum: String, assetId: String): Reservation = {
    val now = System.currentTimeMillis() / 1000
    val window = now / WindowSeconds
    val keys = List(s"ingest:dedupe:$tenant:$checksum", s"ingest:quota:$tenant:$window").asJava
    val args = List(assetId, QuotaPerMinute.toString, WindowSeconds.toString, DedupeTtlSeconds.toString).asJava
    val (outcome, found) = jedis.eval(ReserveLua, keys, args).toString.span(_ != ':')
    if (outcome == "throttled") Reservation(outcome, None, WindowSeconds - now % WindowSeconds)
    else Reservation(outcome, Some(found.drop(1)), 0L)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kQuotaPerMinute = 500;
constexpr long kWindowSeconds = 60;

// The answer to a reservation: outcome reserved, duplicate or throttled.
struct Reservation {
  std::string outcome;
  std::string asset_id;
  long retry_after = 0;
};

// Reserve (tenant, checksum) for asset_id against the tenant's quota.
Reservation reserve(const std::string& tenant, const std::string& checksum, const std::string& asset_id) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string dedupe_key = "ingest:dedupe:" + checksum;
  const std::string quota_key = "ingest:quota:" + tenant;
  const auto used = redis.get(quota_key);
  if (used && std::stol(*used) >= kQuotaPerMinute) return {"throttled", "", kWindowSeconds};
  redis.incr(quota_key);
  if (const auto existing = redis.get(dedupe_key)) return {"duplicate", *existing, 0};
  redis.set(dedupe_key, asset_id);
  return {"reserved", asset_id, 0};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kQuotaPerMinute = 500;
constexpr long kWindowSeconds = 60;
constexpr long kDedupeTtlSeconds = 24 * 3600;

// KEYS[1] the dedupe mark, KEYS[2] this window's counter; ARGV: asset id, quota, window, dedupe TTL.
// A duplicate answers before the counter is read: a re-upload costs nothing, whatever the counter says.
const std::string kReserveLua = R"lua(
local existing = redis.call('GET', KEYS[1])
if existing then return 'duplicate:' .. existing end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= tonumber(ARGV[2]) then return 'throttled:' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return 'reserved:' .. ARGV[1]
)lua";

// The answer to a reservation: outcome reserved, duplicate or throttled.
struct Reservation {
  std::string outcome;
  std::string asset_id;
  long retry_after = 0;
};

// Reserve (tenant, checksum) for asset_id against the tenant's quota.
Reservation reserve(const std::string& tenant, const std::string& checksum, const std::string& asset_id) {
  const long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long window = now / kWindowSeconds;
  const std::string reply = redis.eval<std::string>(
      kReserveLua, {"ingest:dedupe:" + tenant + ":" + checksum, "ingest:quota:" + tenant + ":" + std::to_string(window)},
      {asset_id, std::to_string(kQuotaPerMinute), std::to_string(kWindowSeconds), std::to_string(kDedupeTtlSeconds)});
  const size_t colon = reply.find(':');
  const std::string outcome = reply.substr(0, colon);
  if (outcome == "throttled") return {outcome, "", kWindowSeconds - now % kWindowSeconds};
  return {outcome, reply.substr(colon + 1), 0};
}
`,
    },
  },
  harness: {
    python: `import time

H1 = "sha256:" + "a" * 64
H2 = "sha256:" + "b" * 64


def _fresh_window(ctx):
    """One second into a minute window, so a check never straddles two."""
    ctx.clock.advance(60 - time.time() % 60 + 1)


def _quota_used(ctx, tenant="t1"):
    return sum(int(ctx.redis.get(k) or 0) for k in ctx.redis.keys(f"ingest:quota:{tenant}*"))


def _fill_quota(ctx, tenant="t1", to=500):
    """Every counter of the tenant at to: the tenant has used its minute."""
    for k in ctx.redis.keys(f"ingest:quota:{tenant}*"):
        ctx.redis.incrby(k, to - int(ctx.redis.get(k)))


def check_tenant_dedupe(ctx):
    m = ctx.load("state")
    first = m.reserve("t1", H1, "a-1")
    assert first["outcome"] == "reserved" and first["asset_id"] == "a-1", f"the first reservation answered {first}"
    other = m.reserve("t2", H1, "a-2")
    assert other["outcome"] == "reserved" and other["asset_id"] == "a-2", f"tenant t2 uploading an image t1 already has was answered {other}: t2 would get an asset id from t1's library. The dedupe key is ingest:dedupe:{{tenant}}:{{checksum}}"
    again = m.reserve("t1", H1, "a-3")
    assert again["outcome"] == "duplicate" and again["asset_id"] == "a-1", f"t1 uploading its image again was answered {again}, expected duplicate of a-1"


def check_atomic_reserve(ctx):
    m = ctx.load("state")
    # Another API replica registers the same upload, right after this reserve's first command on the dedupe key.
    probes = [
        ctx.redis_after(key, lambda key=key: bool(ctx.redis.set(key, "a-9", nx=True, ex=86400)))
        for key in ("ingest:dedupe:t1:" + H1, "ingest:dedupe:" + H1)
    ]
    got = m.reserve("t1", H1, "a-1")
    fired = [p for p in probes if p.fired]
    assert fired, "reserve touched no dedupe key for the upload"
    if any(p.result for p in fired):
        assert got["outcome"] == "duplicate" and got["asset_id"] == "a-9", f"another replica reserved the same upload (as a-9) between two of reserve's commands, and reserve answered {got}: both replicas register the image. The check and the mark must run in one script"
    else:
        assert got["outcome"] == "reserved" and ctx.redis.get("ingest:dedupe:t1:" + H1) == "a-1", f"reserve answered {got} and the mark holds {ctx.redis.get('ingest:dedupe:t1:' + H1)!r}"
    _fill_quota(ctx, to=499)
    counters = ctx.redis.keys("ingest:quota:t1*")

    def take_last():
        # Another replica takes the tenant's last reservation of the minute, between this reserve's commands.
        for k in counters:
            if int(ctx.redis.get(k) or 0) < 500:
                ctx.redis.incr(k)

    for k in counters:
        ctx.redis_after(k, take_last)
    m.reserve("t1", H2, "a-2")
    used = _quota_used(ctx)
    assert used <= 500, f"two replicas each took the tenant's last reservation of the minute: the counter reads {used}. The quota check and the increment must run in one script"


def check_window_ttl(ctx):
    m = ctx.load("state")
    _fresh_window(ctx)
    m.reserve("t1", H1, "a-1")
    keys = ctx.redis.keys("ingest:*")
    assert keys, "reserve wrote no ingest:* key"
    for key in keys:
        ttl = ctx.redis.ttl(key)
        assert ttl > 0, f"{key} has no TTL: every mark and counter stays in Redis forever"
        if key.startswith("ingest:quota:"):
            assert ttl <= 60, f"{key} expires in {ttl} s: a counter lives as long as its minute window"
        else:
            assert 3600 < ttl <= 86400, f"{key} expires in {ttl} s, expected a day"
    _fill_quota(ctx)
    ctx.clock.advance(61)
    later = m.reserve("t1", H2, "a-2")
    assert later["outcome"] == "reserved", f"a minute after the tenant used its whole quota, a new upload was answered {later}: the counter must be per minute window"
    assert _quota_used(ctx) == 1, f"the new window's counters read {_quota_used(ctx)}, expected 1"


def check_duplicate_free(ctx):
    m = ctx.load("state")
    _fresh_window(ctx)
    m.reserve("t1", H1, "a-1")
    for n in range(2, 5):
        again = m.reserve("t1", H1, f"a-{n}")
        assert again["outcome"] == "duplicate" and again["asset_id"] == "a-1", f"a re-upload was answered {again}, expected duplicate of a-1"
    used = _quota_used(ctx)
    assert used == 1, f"one upload and three re-uploads of it spent {used} reservations of the quota: a duplicate answers before the counter moves"
    _fill_quota(ctx)
    again = m.reserve("t1", H1, "a-9")
    assert again["outcome"] == "duplicate" and again["asset_id"] == "a-1", f"with the quota used up, a re-upload of a registered image was answered {again}: it costs nothing, so it is answered as a duplicate"


def check_retry_after(ctx):
    m = ctx.load("state")
    _fresh_window(ctx)
    m.reserve("t1", H1, "a-1")
    _fill_quota(ctx)
    refused = m.reserve("t1", H2, "a-2")
    assert refused["outcome"] == "throttled", f"the 501st upload of the minute was answered {refused}"
    assert 57 <= refused["retry_after"] <= 59, f"one second into the minute a refusal says retry_after {refused['retry_after']}: it is the seconds left in the window (59), when the counter resets"
    assert _quota_used(ctx) == 500, f"a refused upload moved the counter to {_quota_used(ctx)}"
    ctx.clock.advance(refused["retry_after"])
    later = m.reserve("t1", H2, "a-2")
    assert later["outcome"] == "reserved", f"retried after retry_after, the upload was answered {later}: a refusal must leave no mark"
`,
    typescript: `const H1 = 'sha256:' + 'a'.repeat(64);
const H2 = 'sha256:' + 'b'.repeat(64);

/** One second into a minute window, so a check never straddles two. */
const freshWindow = ctx => ctx.clock.advance(60 - ((ctx.clock.now() / 1000) % 60) + 1);

const quotaUsed = (ctx, tenant = 't1'): number =>
  (ctx.redis.keys(\`ingest:quota:\${tenant}*\`) as string[]).reduce((n, k) => n + Number(ctx.redis.get(k) ?? 0), 0);

/** Every counter of the tenant at to: the tenant has used its minute. */
function fillQuota(ctx, tenant = 't1', to = 500): void {
  for (const k of ctx.redis.keys(\`ingest:quota:\${tenant}*\`) as string[]) ctx.redis.incrby(k, to - Number(ctx.redis.get(k)));
}

export async function check_tenant_dedupe(ctx) {
  const m = ctx.load('state');
  const first = await m.reserve('t1', H1, 'a-1');
  assert(first.outcome === 'reserved' && first.asset_id === 'a-1', \`the first reservation answered \${JSON.stringify(first)}\`);
  const other = await m.reserve('t2', H1, 'a-2');
  assert(other.outcome === 'reserved' && other.asset_id === 'a-2', \`tenant t2 uploading an image t1 already has was answered \${JSON.stringify(other)}: t2 would get an asset id from t1's library. The dedupe key is ingest:dedupe:{tenant}:{checksum}\`);
  const again = await m.reserve('t1', H1, 'a-3');
  assert(again.outcome === 'duplicate' && again.asset_id === 'a-1', \`t1 uploading its image again was answered \${JSON.stringify(again)}, expected duplicate of a-1\`);
}

export async function check_atomic_reserve(ctx) {
  const m = ctx.load('state');
  // Another API replica registers the same upload, right after this reserve's first command on the dedupe key.
  const probes = ['ingest:dedupe:t1:' + H1, 'ingest:dedupe:' + H1].map(key =>
    ctx.redisAfter(key, () => ctx.redis.set(key, 'a-9', 'NX', 'EX', 86400) === 'OK'),
  );
  const got = await m.reserve('t1', H1, 'a-1');
  const fired = probes.filter(p => p.fired);
  assert(fired.length > 0, 'reserve touched no dedupe key for the upload');
  if (fired.some(p => p.result === true)) {
    assert(got.outcome === 'duplicate' && got.asset_id === 'a-9', \`another replica reserved the same upload (as a-9) between two of reserve's commands, and reserve answered \${JSON.stringify(got)}: both replicas register the image. The check and the mark must run in one script\`);
  } else {
    assert(got.outcome === 'reserved' && ctx.redis.get('ingest:dedupe:t1:' + H1) === 'a-1', \`reserve answered \${JSON.stringify(got)} and the mark holds \${ctx.redis.get('ingest:dedupe:t1:' + H1)}\`);
  }
  fillQuota(ctx, 't1', 499);
  const counters = ctx.redis.keys('ingest:quota:t1*') as string[];
  // Another replica takes the tenant's last reservation of the minute, between this reserve's commands.
  const takeLast = () => {
    for (const k of counters) if (Number(ctx.redis.get(k) ?? 0) < 500) ctx.redis.incr(k);
  };
  for (const k of counters) ctx.redisAfter(k, takeLast);
  await m.reserve('t1', H2, 'a-2');
  const used = quotaUsed(ctx);
  assert(used <= 500, \`two replicas each took the tenant's last reservation of the minute: the counter reads \${used}. The quota check and the increment must run in one script\`);
}

export async function check_window_ttl(ctx) {
  const m = ctx.load('state');
  freshWindow(ctx);
  await m.reserve('t1', H1, 'a-1');
  const keys = ctx.redis.keys('ingest:*') as string[];
  assert(keys.length > 0, 'reserve wrote no ingest:* key');
  for (const key of keys) {
    const ttl = Number(ctx.redis.ttl(key));
    assert(ttl > 0, \`\${key} has no TTL: every mark and counter stays in Redis forever\`);
    if (key.startsWith('ingest:quota:')) assert(ttl <= 60, \`\${key} expires in \${ttl} s: a counter lives as long as its minute window\`);
    else assert(ttl > 3600 && ttl <= 86400, \`\${key} expires in \${ttl} s, expected a day\`);
  }
  fillQuota(ctx);
  ctx.clock.advance(61);
  const later = await m.reserve('t1', H2, 'a-2');
  assert.equal(later.outcome, 'reserved', \`a minute after the tenant used its whole quota, a new upload was answered \${JSON.stringify(later)}: the counter must be per minute window\`);
  assert.equal(quotaUsed(ctx), 1, \`the new window's counters read \${quotaUsed(ctx)}, expected 1\`);
}

export async function check_duplicate_free(ctx) {
  const m = ctx.load('state');
  freshWindow(ctx);
  await m.reserve('t1', H1, 'a-1');
  for (let n = 2; n <= 4; n++) {
    const again = await m.reserve('t1', H1, \`a-\${n}\`);
    assert(again.outcome === 'duplicate' && again.asset_id === 'a-1', \`a re-upload was answered \${JSON.stringify(again)}, expected duplicate of a-1\`);
  }
  const used = quotaUsed(ctx);
  assert.equal(used, 1, \`one upload and three re-uploads of it spent \${used} reservations of the quota: a duplicate answers before the counter moves\`);
  fillQuota(ctx);
  const again = await m.reserve('t1', H1, 'a-9');
  assert(again.outcome === 'duplicate' && again.asset_id === 'a-1', \`with the quota used up, a re-upload of a registered image was answered \${JSON.stringify(again)}: it costs nothing, so it is answered as a duplicate\`);
}

export async function check_retry_after(ctx) {
  const m = ctx.load('state');
  freshWindow(ctx);
  await m.reserve('t1', H1, 'a-1');
  fillQuota(ctx);
  const refused = await m.reserve('t1', H2, 'a-2');
  assert.equal(refused.outcome, 'throttled', \`the 501st upload of the minute was answered \${JSON.stringify(refused)}\`);
  assert(refused.retry_after >= 57 && refused.retry_after <= 59, \`one second into the minute a refusal says retry_after \${refused.retry_after}: it is the seconds left in the window (59), when the counter resets\`);
  assert.equal(quotaUsed(ctx), 500, \`a refused upload moved the counter to \${quotaUsed(ctx)}\`);
  ctx.clock.advance(refused.retry_after);
  const later = await m.reserve('t1', H2, 'a-2');
  assert.equal(later.outcome, 'reserved', \`retried after retry_after, the upload was answered \${JSON.stringify(later)}: a refusal must leave no mark\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"strings"

	"leetbuild/harness"
)

var (
	stateBg = context.Background()
	stateH1 = "sha256:" + strings.Repeat("a", 64)
	stateH2 = "sha256:" + strings.Repeat("b", 64)
)

// freshWindow moves the clock one second into a minute window, so a check never straddles two.
func freshWindow(ctx *harness.Ctx) {
	ctx.Clock.Advance(60 - float64(ctx.Clock.Now()%60000)/1000 + 1)
}

func quotaUsed(ctx *harness.Ctx, tenant string) int {
	used := 0
	for _, k := range ctx.Redis.Keys("ingest:quota:" + tenant + "*") {
		v, _ := ctx.Redis.Get(k)
		n, _ := strconv.Atoi(v)
		used += n
	}
	return used
}

// fillQuota sets every counter of the tenant to n: the tenant has used its minute.
func fillQuota(ctx *harness.Ctx, tenant string, n int) {
	for _, k := range ctx.Redis.Keys("ingest:quota:" + tenant + "*") {
		v, _ := ctx.Redis.Get(k)
		have, _ := strconv.Atoi(v)
		ctx.Redis.Do("INCRBY", k, n-have)
	}
}

func mustReserve(ctx *harness.Ctx, tenant, checksum, assetID string) Reservation {
	got, err := reserve(stateBg, tenant, checksum, assetID)
	ctx.NoError(err, "reserve(%s, %s, %s) failed", tenant, checksum, assetID)
	return got
}

func CheckTenantDedupe(ctx *harness.Ctx) {
	first := mustReserve(ctx, "t1", stateH1, "a-1")
	ctx.Assert(first.Outcome == "reserved" && first.AssetID == "a-1", "the first reservation answered %+v", first)
	other := mustReserve(ctx, "t2", stateH1, "a-2")
	ctx.Assert(other.Outcome == "reserved" && other.AssetID == "a-2", "tenant t2 uploading an image t1 already has was answered %+v: t2 would get an asset id from t1's library. The dedupe key is ingest:dedupe:{tenant}:{checksum}", other)
	again := mustReserve(ctx, "t1", stateH1, "a-3")
	ctx.Assert(again.Outcome == "duplicate" && again.AssetID == "a-1", "t1 uploading its image again was answered %+v, expected duplicate of a-1", again)
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	// Another API replica registers the same upload, right after this reserve's first command on the dedupe key.
	keys := []string{"ingest:dedupe:t1:" + stateH1, "ingest:dedupe:" + stateH1}
	first := ctx.Redis.After(keys[0], func() any { return ctx.Redis.Set(keys[0], "a-9", "NX", "EX", 86400) })
	second := ctx.Redis.After(keys[1], func() any { return ctx.Redis.Set(keys[1], "a-9", "NX", "EX", 86400) })
	got := mustReserve(ctx, "t1", stateH1, "a-1")
	ctx.Assert(first.Fired || second.Fired, "reserve touched no dedupe key for the upload")
	if first.Result == true || second.Result == true {
		ctx.Assert(got.Outcome == "duplicate" && got.AssetID == "a-9", "another replica reserved the same upload (as a-9) between two of reserve's commands, and reserve answered %+v: both replicas register the image. The check and the mark must run in one script", got)
	} else {
		mark, _ := ctx.Redis.Get("ingest:dedupe:t1:" + stateH1)
		ctx.Assert(got.Outcome == "reserved" && mark == "a-1", "reserve answered %+v and the mark holds %q", got, mark)
	}
	fillQuota(ctx, "t1", 499)
	counters := ctx.Redis.Keys("ingest:quota:t1*")
	// Another replica takes the tenant's last reservation of the minute, between this reserve's commands.
	takeLast := func() any {
		for _, k := range counters {
			v, _ := ctx.Redis.Get(k)
			if n, _ := strconv.Atoi(v); n < 500 {
				ctx.Redis.Do("INCR", k)
			}
		}
		return nil
	}
	for _, k := range counters {
		ctx.Redis.After(k, takeLast)
	}
	mustReserve(ctx, "t1", stateH2, "a-2")
	used := quotaUsed(ctx, "t1")
	ctx.Assert(used <= 500, "two replicas each took the tenant's last reservation of the minute: the counter reads %d. The quota check and the increment must run in one script", used)
}

func CheckWindowTtl(ctx *harness.Ctx) {
	freshWindow(ctx)
	mustReserve(ctx, "t1", stateH1, "a-1")
	keys := ctx.Redis.Keys("ingest:*")
	ctx.Assert(len(keys) > 0, "reserve wrote no ingest:* key")
	for _, key := range keys {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl > 0, "%s has no TTL: every mark and counter stays in Redis forever", key)
		if strings.HasPrefix(key, "ingest:quota:") {
			ctx.Assert(ttl <= 60, "%s expires in %d s: a counter lives as long as its minute window", key, ttl)
		} else {
			ctx.Assert(ttl > 3600 && ttl <= 86400, "%s expires in %d s, expected a day", key, ttl)
		}
	}
	fillQuota(ctx, "t1", 500)
	ctx.Clock.Advance(61)
	later := mustReserve(ctx, "t1", stateH2, "a-2")
	ctx.Equal(later.Outcome, "reserved", "a minute after the tenant used its whole quota, a new upload must be reserved (the counter is per minute window); the outcome")
	ctx.Equal(quotaUsed(ctx, "t1"), 1, "the new window's counters")
}

func CheckDuplicateFree(ctx *harness.Ctx) {
	freshWindow(ctx)
	mustReserve(ctx, "t1", stateH1, "a-1")
	for n := 2; n <= 4; n++ {
		again := mustReserve(ctx, "t1", stateH1, "a-"+strconv.Itoa(n))
		ctx.Assert(again.Outcome == "duplicate" && again.AssetID == "a-1", "a re-upload was answered %+v, expected duplicate of a-1", again)
	}
	used := quotaUsed(ctx, "t1")
	ctx.Equal(used, 1, "one upload and three re-uploads of it must spend one reservation (a duplicate answers before the counter moves); the reservations spent")
	fillQuota(ctx, "t1", 500)
	again := mustReserve(ctx, "t1", stateH1, "a-9")
	ctx.Assert(again.Outcome == "duplicate" && again.AssetID == "a-1", "with the quota used up, a re-upload of a registered image was answered %+v: it costs nothing, so it is answered as a duplicate", again)
}

func CheckRetryAfter(ctx *harness.Ctx) {
	freshWindow(ctx)
	mustReserve(ctx, "t1", stateH1, "a-1")
	fillQuota(ctx, "t1", 500)
	refused := mustReserve(ctx, "t1", stateH2, "a-2")
	ctx.Equal(refused.Outcome, "throttled", "the 501st upload of the minute")
	ctx.Assert(refused.RetryAfter >= 57 && refused.RetryAfter <= 59, "one second into the minute a refusal says retry_after %d: it is the seconds left in the window (59), when the counter resets", refused.RetryAfter)
	ctx.Equal(quotaUsed(ctx, "t1"), 500, "a refused upload must not move the counter")
	ctx.Clock.Advance(float64(refused.RetryAfter))
	later := mustReserve(ctx, "t1", stateH2, "a-2")
	ctx.Equal(later.Outcome, "reserved", "retried after retry_after the upload must be reserved (a refusal leaves no mark); the outcome")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

namespace {

const std::string kH1 = "sha256:" + std::string(64, 'a');
const std::string kH2 = "sha256:" + std::string(64, 'b');

// One second into a minute window, so a check never straddles two.
void freshWindow(harness::Ctx& ctx) { ctx.Clock.Advance(60 - static_cast<double>(ctx.Clock.Now() % 60000) / 1000 + 1); }

long long quotaUsed(harness::Ctx& ctx, const std::string& tenant) {
  long long used = 0;
  for (const auto& k : ctx.Redis.Keys("ingest:quota:" + tenant + "*")) used += std::stoll(ctx.Redis.Get(k).value_or("0"));
  return used;
}

// Every counter of the tenant at n: the tenant has used its minute.
void fillQuota(harness::Ctx& ctx, const std::string& tenant, long long n) {
  for (const auto& k : ctx.Redis.Keys("ingest:quota:" + tenant + "*")) ctx.Redis.Do("INCRBY", k, n - std::stoll(ctx.Redis.Get(k).value_or("0")));
}

}  // namespace

void CheckTenantDedupe(harness::Ctx& ctx) {
  const Reservation first = reserve("t1", kH1, "a-1");
  ctx.Assert(first.outcome == "reserved" && first.asset_id == "a-1", "the first reservation answered %s %s", first.outcome, first.asset_id);
  const Reservation other = reserve("t2", kH1, "a-2");
  ctx.Assert(other.outcome == "reserved" && other.asset_id == "a-2",
             "tenant t2 uploading an image t1 already has was answered %s %s: t2 would get an asset id from t1's library. The dedupe key is ingest:dedupe:{tenant}:{checksum}",
             other.outcome, other.asset_id);
  const Reservation again = reserve("t1", kH1, "a-3");
  ctx.Assert(again.outcome == "duplicate" && again.asset_id == "a-1", "t1 uploading its image again was answered %s %s, expected duplicate of a-1", again.outcome, again.asset_id);
}

void CheckAtomicReserve(harness::Ctx& ctx) {
  // Another API replica registers the same upload, right after this reserve's first command on the dedupe key.
  bool claimed = false;
  bool fired = false;
  for (const std::string key : {"ingest:dedupe:t1:" + kH1, "ingest:dedupe:" + kH1}) {
    ctx.Redis.After(key, [&ctx, &claimed, &fired, key] {
      fired = true;
      if (ctx.Redis.Set(key, "a-9", "NX", "EX", 86400)) claimed = true;
    });
  }
  const Reservation got = reserve("t1", kH1, "a-1");
  ctx.Assert(fired, "reserve touched no dedupe key for the upload");
  if (claimed) {
    ctx.Assert(got.outcome == "duplicate" && got.asset_id == "a-9",
               "another replica reserved the same upload (as a-9) between two of reserve's commands, and reserve answered %s %s: both replicas register the image. The check and the mark must run in one script",
               got.outcome, got.asset_id);
  } else {
    const std::string mark = ctx.Redis.Get("ingest:dedupe:t1:" + kH1).value_or("");
    ctx.Assert(got.outcome == "reserved" && mark == "a-1", "reserve answered %s %s and the mark holds %q", got.outcome, got.asset_id, mark);
  }
  fillQuota(ctx, "t1", 499);
  const std::vector<std::string> counters = ctx.Redis.Keys("ingest:quota:t1*");
  // Another replica takes the tenant's last reservation of the minute, between this reserve's commands.
  for (const auto& k : counters) {
    ctx.Redis.After(k, [&ctx, counters] {
      for (const auto& c : counters)
        if (std::stoll(ctx.Redis.Get(c).value_or("0")) < 500) ctx.Redis.Do("INCR", c);
    });
  }
  reserve("t1", kH2, "a-2");
  const long long used = quotaUsed(ctx, "t1");
  ctx.Assert(used <= 500, "two replicas each took the tenant's last reservation of the minute: the counter reads %d. The quota check and the increment must run in one script", used);
}

void CheckWindowTtl(harness::Ctx& ctx) {
  freshWindow(ctx);
  reserve("t1", kH1, "a-1");
  const auto keys = ctx.Redis.Keys("ingest:*");
  ctx.Assert(!keys.empty(), "reserve wrote no ingest:* key");
  for (const auto& key : keys) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl > 0, "%s has no TTL: every mark and counter stays in Redis forever", key);
    if (key.rfind("ingest:quota:", 0) == 0) ctx.Assert(ttl <= 60, "%s expires in %d s: a counter lives as long as its minute window", key, ttl);
    else ctx.Assert(ttl > 3600 && ttl <= 86400, "%s expires in %d s, expected a day", key, ttl);
  }
  fillQuota(ctx, "t1", 500);
  ctx.Clock.Advance(61);
  const Reservation later = reserve("t1", kH2, "a-2");
  ctx.Equal(later.outcome, "reserved", "a minute after the tenant used its whole quota, a new upload must be reserved (the counter is per minute window); the outcome");
  ctx.Equal(quotaUsed(ctx, "t1"), 1, "the new window's counters");
}

void CheckDuplicateFree(harness::Ctx& ctx) {
  freshWindow(ctx);
  reserve("t1", kH1, "a-1");
  for (int n = 2; n <= 4; n++) {
    const Reservation again = reserve("t1", kH1, "a-" + std::to_string(n));
    ctx.Assert(again.outcome == "duplicate" && again.asset_id == "a-1", "a re-upload was answered %s %s, expected duplicate of a-1", again.outcome, again.asset_id);
  }
  ctx.Equal(quotaUsed(ctx, "t1"), 1, "one upload and three re-uploads of it must spend one reservation (a duplicate answers before the counter moves); the reservations spent");
  fillQuota(ctx, "t1", 500);
  const Reservation again = reserve("t1", kH1, "a-9");
  ctx.Assert(again.outcome == "duplicate" && again.asset_id == "a-1",
             "with the quota used up, a re-upload of a registered image was answered %s %s: it costs nothing, so it is answered as a duplicate", again.outcome,
             again.asset_id);
}

void CheckRetryAfter(harness::Ctx& ctx) {
  freshWindow(ctx);
  reserve("t1", kH1, "a-1");
  fillQuota(ctx, "t1", 500);
  const Reservation refused = reserve("t1", kH2, "a-2");
  ctx.Equal(refused.outcome, "throttled", "the 501st upload of the minute");
  ctx.Assert(refused.retry_after >= 57 && refused.retry_after <= 59,
             "one second into the minute a refusal says retry_after %d: it is the seconds left in the window (59), when the counter resets", refused.retry_after);
  ctx.Equal(quotaUsed(ctx, "t1"), 500, "a refused upload must not move the counter");
  ctx.Clock.Advance(static_cast<double>(refused.retry_after));
  const Reservation later = reserve("t1", kH2, "a-2");
  ctx.Equal(later.outcome, "reserved", "retried after retry_after the upload must be reserved (a refusal leaves no mark); the outcome");
}
`,
  },
  hints: [
    "Have t2 upload an image t1 already registered: t2 is handed t1's asset id. Re-upload one image three times and the counter reads 4; an hour later `ingest:quota:t1` still blocks the tenant.",
    'Every decision is its own command, so another replica can land between the `GET` and the `SET`. The keys carry no tenant or window and no TTL, and the counter moves before the duplicate check.',
    'One script: `GET` the mark and return `duplicate`; compare the counter with `QUOTA_PER_MINUTE` and return `throttled`; `SET` the mark with `EX` a day, `INCR`, `EXPIRE` when it returns 1. Answer `WINDOW_S - now % WINDOW_S` as `retry_after`.',
  ],
  debrief: `The script is the unit of atomicity Redis offers: everything inside it sees one state and leaves another, so two replicas cannot both read "not registered yet" and both register. The order inside it is policy: the duplicate check comes first because a re-upload costs the platform nothing and must cost the tenant nothing, and the counter only moves for an upload that will be ingested. Naming the window in the key gives every minute its own counter, which is why a plain expiry cleans up and why a busy minute does not leak into the next. Production limiters smooth the minute boundary with a sliding window or a token bucket, and keep the dedupe record in the asset database as well, since Redis eviction would forget it.`,
};
