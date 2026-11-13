import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis suppression and per-recipient rate limits',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'admission',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the admission gate the send path asks: \`suppress(address)\`
writes \`mail:suppressed:{address}\` with a one-hour expiry, \`is_suppressed\` checks that key, and
\`admit(address)\` answers \`"suppressed"\`, then reads the minute counter
\`mail:rate:{address}:{window}\`, answers \`"rate_limited"\` once it reached \`RATE_LIMIT\` (5) and
otherwise increments it. It serves the demo and hides four flaws.

**Failure mode the checks target.** An unsubscribe is forgotten after an hour; two sends racing at
the fifth email of the minute both pass; every counter stays in Redis for good; and
\`Ana@Example.com\` is treated as someone other than \`ana@example.com\`.

- Suppression is durable: \`SADD\` to the set \`SUPPRESSED_SET\` (\`mail:suppressed\`), with no expiry.
- \`admit\` decides in **one Lua script** (\`register_script\` or \`EVAL\`): \`SISMEMBER\` on the set,
  then \`INCR\` the counter, \`EXPIRE\` it for \`WINDOW_S\` (60 s) on its first increment, and compare
  with \`RATE_LIMIT\`.
- Every function normalizes the address first (\`normalize\`, provided in \`mail.address\`).`,
  sequence: {
    participants: ['Email API', 'Gate', 'Redis'],
    messages: [
      {from: 'Email API', to: 'Gate', label: 'admit("Ana@Example.com")', kind: 'sync'},
      {from: 'Gate', to: 'Gate', label: 'normalize → ana@example.com', kind: 'sync'},
      {
        from: 'Gate',
        to: 'Redis',
        label: 'EVAL: SISMEMBER mail:suppressed · INCR mail:rate:… · EXPIRE 60',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Gate', label: 'suppressed · rate_limited · ok', kind: 'reply'},
      {from: 'Gate', to: 'Email API', label: 'verdict', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'durable-suppression',
      title: 'Keeps suppressed addresses in a set that never expires',
      detail:
        '`suppress` adds the address to the set `mail:suppressed` (`SADD`) and admission reads it with `SISMEMBER`; the starter writes a key with a one-hour expiry, so an unsubscribe lapses.',
      match: {
        python: {
          all: [/SUPPRESSED_SET\s*=\s*["']mail:suppressed["']/, /\.sadd\(/, /SISMEMBER/],
          none: [/\bex\s*=/, /setex/i, /SUPPRESSION_TTL/],
        },
        typescript: {
          all: [/SUPPRESSED_SET\s*=\s*['"]mail:suppressed['"]/, /\.sadd\(/, /SISMEMBER/],
          none: [/['"]EX['"]/, /setex/i, /SUPPRESSION_TTL/],
        },
        go: {
          all: [/suppressedSet\s*=\s*"mail:suppressed"/, /\.SAdd\(/, /SISMEMBER/],
          none: [/suppressionTTL/i, /SetEx\(|\.Set\([^\n]*mail:suppressed/],
        },
        scala: {
          all: [/SuppressedSet\s*=\s*"mail:suppressed"/, /jedis\.sadd\(/, /SISMEMBER/],
          none: [/setex/i, /SuppressionTtl/i],
        },
        cpp: {
          all: [/kSuppressedSet\s*=\s*"mail:suppressed"/, /\.sadd\(/, /SISMEMBER/],
          none: [/kSuppressionTtl/i, /\.set\([^\n]*mail:suppressed/],
        },
      },
    },
    {
      id: 'atomic-admission',
      title: 'Decides suppression and the count in one Lua script',
      detail:
        'One script checks the set and increments the counter, so a second send cannot land between the read and the write; the starter reads the count with `GET` and increments it in another round trip.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/],
          none: [/r\.incr\(/, /r\.get\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/],
          none: [/redis\.incr\(/, /redis\.get\(/],
        },
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/rdb\.Incr\(/, /rdb\.Get\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/jedis\.incr\(/, /jedis\.get\(/]},
        cpp: {all: [/\.eval(sha)?</, /redis\.call\(\s*['"]INCR['"]/], none: [/\.incr\(/, /redis\.get\(/]},
      },
    },
    {
      id: 'rate-window',
      title: 'Expires each minute counter with its window',
      detail:
        'The script gives the counter `EXPIRE` for the window (60 s) on its first increment; without it every recipient leaves one key per minute in Redis for good.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /WINDOW_S\s*=\s*60\b/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /WINDOW_S\s*=\s*60\b/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /windowSeconds\s*=\s*60\b/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /WindowSeconds\s*=\s*60L?\b/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /kWindowSeconds\s*=\s*60\b/]},
      },
    },
    {
      id: 'normalized-address',
      title: 'Normalizes the address before every key',
      detail:
        'Suppression and the counter use the trimmed, lowercased address (`normalize`), so one mailbox written two ways is one entry.',
      match: {
        python: {all: [/normalize\(\s*address\s*\)/]},
        typescript: {all: [/normalize\(\s*address\s*\)/]},
        go: {all: [/address\.Normalize\(/]},
        scala: {all: [/Address\.normalize\(/]},
        cpp: {all: [/address::normalize\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from mail.address import normalize  # trimmed, lowercase

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RATE_LIMIT = 5
WINDOW_S = 60
SUPPRESSION_TTL_S = 3600


def rate_key(address: str, now: float) -> str:
    return f"mail:rate:{address}:{int(now // WINDOW_S)}"


def suppress(address: str) -> None:
    """Stop mailing an address (a hard bounce, a complaint, an unsubscribe)."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    r.set(f"mail:suppressed:{address}", "1", ex=SUPPRESSION_TTL_S)


def is_suppressed(address: str) -> bool:
    return r.exists(f"mail:suppressed:{address}") == 1


def admit(address: str) -> str:
    """"suppressed", "rate_limited" or "ok" for one more email to the address."""
    if is_suppressed(address):
        return "suppressed"
    key = rate_key(address, time.time())
    sent = int(r.get(key) or 0)
    if sent >= RATE_LIMIT:
        return "rate_limited"
    r.incr(key)
    return "ok"
`,
      solution: `import time

import redis

from mail.address import normalize  # trimmed, lowercase

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SUPPRESSED_SET = "mail:suppressed"
RATE_LIMIT = 5
WINDOW_S = 60

# One decision, run whole by Redis: no other send can land between the check and the count.
ADMIT_LUA = """
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
local sent = redis.call('INCR', KEYS[2])
if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if sent > tonumber(ARGV[3]) then return 'rate_limited' end
return 'ok'
"""
admit_script = r.register_script(ADMIT_LUA)


def rate_key(address: str, now: float) -> str:
    return f"mail:rate:{address}:{int(now // WINDOW_S)}"


def suppress(address: str) -> None:
    """Stop mailing an address (a hard bounce, a complaint, an unsubscribe)."""
    r.sadd(SUPPRESSED_SET, normalize(address))  # durable: removed only by an explicit request


def is_suppressed(address: str) -> bool:
    return bool(r.sismember(SUPPRESSED_SET, normalize(address)))


def admit(address: str) -> str:
    """"suppressed", "rate_limited" or "ok" for one more email to the address."""
    address = normalize(address)
    return admit_script(keys=[SUPPRESSED_SET, rate_key(address, time.time())], args=[address, WINDOW_S, RATE_LIMIT])
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {normalize} from 'mail/address'; // trimmed, lowercase

const redis = new Redis({host: 'redis', port: 6379});

export const RATE_LIMIT = 5;
export const WINDOW_S = 60;
export const SUPPRESSION_TTL_S = 3600;

export const rateKey = (address: string, nowMs: number): string => \`mail:rate:\${address}:\${Math.floor(nowMs / 1000 / WINDOW_S)}\`;

/** Stop mailing an address (a hard bounce, a complaint, an unsubscribe). */
export async function suppress(address: string): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await redis.set(\`mail:suppressed:\${address}\`, '1', 'EX', SUPPRESSION_TTL_S);
}

export async function isSuppressed(address: string): Promise<boolean> {
  return (await redis.exists(\`mail:suppressed:\${address}\`)) === 1;
}

/** 'suppressed', 'rate_limited' or 'ok' for one more email to the address. */
export async function admit(address: string): Promise<string> {
  if (await isSuppressed(address)) return 'suppressed';
  const key = rateKey(address, Date.now());
  const sent = Number((await redis.get(key)) ?? 0);
  if (sent >= RATE_LIMIT) return 'rate_limited';
  await redis.incr(key);
  return 'ok';
}
`,
      solution: `import Redis from 'ioredis';

import {normalize} from 'mail/address'; // trimmed, lowercase

export const SUPPRESSED_SET = 'mail:suppressed';
export const RATE_LIMIT = 5;
export const WINDOW_S = 60;

// One decision, run whole by Redis: no other send can land between the check and the count.
export const ADMIT_LUA = \`
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
local sent = redis.call('INCR', KEYS[2])
if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if sent > tonumber(ARGV[3]) then return 'rate_limited' end
return 'ok'
\`;

interface AdmitRedis extends Redis {
  admitScript(suppressedSet: string, rateKey: string, address: string, windowS: number, limit: number): Promise<string>;
}

const redis = new Redis({host: 'redis', port: 6379}) as AdmitRedis;
redis.defineCommand('admitScript', {numberOfKeys: 2, lua: ADMIT_LUA});

export const rateKey = (address: string, nowMs: number): string => \`mail:rate:\${address}:\${Math.floor(nowMs / 1000 / WINDOW_S)}\`;

/** Stop mailing an address (a hard bounce, a complaint, an unsubscribe). */
export async function suppress(address: string): Promise<void> {
  await redis.sadd(SUPPRESSED_SET, normalize(address)); // durable: removed only by an explicit request
}

export async function isSuppressed(address: string): Promise<boolean> {
  return (await redis.sismember(SUPPRESSED_SET, normalize(address))) === 1;
}

/** 'suppressed', 'rate_limited' or 'ok' for one more email to the address. */
export async function admit(address: string): Promise<string> {
  const normalized = normalize(address);
  return redis.admitScript(SUPPRESSED_SET, rateKey(normalized, Date.now()), normalized, WINDOW_S, RATE_LIMIT);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// The address helpers live in "mail/address": address.Normalize(addr) is trimmed and lowercase.

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	rateLimit      = 5
	windowSeconds  = 60
	suppressionTTL = time.Hour
)

func rateKey(addr string, now time.Time) string {
	return fmt.Sprintf("mail:rate:%s:%d", addr, now.Unix()/windowSeconds)
}

// suppress stops mailing an address (a hard bounce, a complaint, an unsubscribe).
func suppress(ctx context.Context, addr string) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	return rdb.Set(ctx, "mail:suppressed:"+addr, "1", suppressionTTL).Err()
}

func isSuppressed(ctx context.Context, addr string) (bool, error) {
	n, err := rdb.Exists(ctx, "mail:suppressed:"+addr).Result()
	return n == 1, err
}

// admit is "suppressed", "rate_limited" or "ok" for one more email to the address.
func admit(ctx context.Context, addr string) (string, error) {
	suppressed, err := isSuppressed(ctx, addr)
	if err != nil {
		return "", err
	}
	if suppressed {
		return "suppressed", nil
	}
	key := rateKey(addr, time.Now())
	sent, err := rdb.Get(ctx, key).Int()
	if err != nil && err != redis.Nil {
		return "", err
	}
	if sent >= rateLimit {
		return "rate_limited", nil
	}
	return "ok", rdb.Incr(ctx, key).Err()
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"mail/address" // address.Normalize(addr): trimmed, lowercase
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	suppressedSet = "mail:suppressed"
	rateLimit     = 5
	windowSeconds = 60
)

// One decision, run whole by Redis: no other send can land between the check and the count.
var admitScript = redis.NewScript(\`
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
local sent = redis.call('INCR', KEYS[2])
if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if sent > tonumber(ARGV[3]) then return 'rate_limited' end
return 'ok'
\`)

func rateKey(addr string, now time.Time) string {
	return fmt.Sprintf("mail:rate:%s:%d", addr, now.Unix()/windowSeconds)
}

// suppress stops mailing an address (a hard bounce, a complaint, an unsubscribe).
func suppress(ctx context.Context, addr string) error {
	return rdb.SAdd(ctx, suppressedSet, address.Normalize(addr)).Err() // durable: removed only by an explicit request
}

func isSuppressed(ctx context.Context, addr string) (bool, error) {
	return rdb.SIsMember(ctx, suppressedSet, address.Normalize(addr)).Result()
}

// admit is "suppressed", "rate_limited" or "ok" for one more email to the address.
func admit(ctx context.Context, addr string) (string, error) {
	normalized := address.Normalize(addr)
	return admitScript.Run(ctx, rdb, []string{suppressedSet, rateKey(normalized, time.Now())}, normalized, windowSeconds, rateLimit).Text()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import mail.Address // Address.normalize(address): trimmed, lowercase

object Admission {
  val jedis = new JedisPooled("redis", 6379)

  val RateLimit = 5
  val WindowSeconds = 60L
  val SuppressionTtlSeconds = 3600L

  def rateKey(address: String, nowMillis: Long): String = s"mail:rate:$address:\${nowMillis / 1000 / WindowSeconds}"

  /** Stop mailing an address (a hard bounce, a complaint, an unsubscribe). */
  def suppress(address: String): Unit = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    jedis.setex(s"mail:suppressed:$address", SuppressionTtlSeconds, "1")
    ()
  }

  def isSuppressed(address: String): Boolean = jedis.exists(s"mail:suppressed:$address")

  /** "suppressed", "rate_limited" or "ok" for one more email to the address. */
  def admit(address: String): String =
    if (isSuppressed(address)) "suppressed"
    else {
      val key = rateKey(address, System.currentTimeMillis())
      val sent = Option(jedis.get(key)).map(_.toInt).getOrElse(0)
      if (sent >= RateLimit) "rate_limited"
      else {
        jedis.incr(key)
        "ok"
      }
    }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import mail.Address // Address.normalize(address): trimmed, lowercase

object Admission {
  val jedis = new JedisPooled("redis", 6379)

  val SuppressedSet = "mail:suppressed"
  val RateLimit = 5
  val WindowSeconds = 60L

  // One decision, run whole by Redis: no other send can land between the check and the count.
  val AdmitLua: String =
    """if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
      |local sent = redis.call('INCR', KEYS[2])
      |if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
      |if sent > tonumber(ARGV[3]) then return 'rate_limited' end
      |return 'ok'
      |""".stripMargin

  def rateKey(address: String, nowMillis: Long): String = s"mail:rate:$address:\${nowMillis / 1000 / WindowSeconds}"

  /** Stop mailing an address (a hard bounce, a complaint, an unsubscribe). */
  def suppress(address: String): Unit = {
    jedis.sadd(SuppressedSet, Address.normalize(address)) // durable: removed only by an explicit request
    ()
  }

  def isSuppressed(address: String): Boolean = jedis.sismember(SuppressedSet, Address.normalize(address))

  /** "suppressed", "rate_limited" or "ok" for one more email to the address. */
  def admit(address: String): String = {
    val normalized = Address.normalize(address)
    val keys = List(SuppressedSet, rateKey(normalized, System.currentTimeMillis())).asJava
    jedis.eval(AdmitLua, keys, List(normalized, WindowSeconds.toString, RateLimit.toString).asJava).toString
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "mail/address.h"  // mail::address::normalize(addr): trimmed, lowercase

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kRateLimit = 5;
constexpr long kWindowSeconds = 60;
constexpr std::chrono::seconds kSuppressionTtl{3600};

std::string rateKey(const std::string& addr) {
  const long now = static_cast<long>(
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
  return "mail:rate:" + addr + ":" + std::to_string(now / kWindowSeconds);
}

// Stop mailing an address (a hard bounce, a complaint, an unsubscribe).
void suppress(const std::string& addr) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  redis.set("mail:suppressed:" + addr, "1", kSuppressionTtl);
}

bool isSuppressed(const std::string& addr) { return redis.exists("mail:suppressed:" + addr) == 1; }

// "suppressed", "rate_limited" or "ok" for one more email to the address.
std::string admit(const std::string& addr) {
  if (isSuppressed(addr)) return "suppressed";
  const std::string key = rateKey(addr);
  const auto sent = redis.get(key);
  if (sent && std::stol(*sent) >= kRateLimit) return "rate_limited";
  redis.incr(key);
  return "ok";
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "mail/address.h"  // mail::address::normalize(addr): trimmed, lowercase

namespace address = mail::address;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kSuppressedSet = "mail:suppressed";
constexpr long kRateLimit = 5;
constexpr long kWindowSeconds = 60;

// One decision, run whole by Redis: no other send can land between the check and the count.
const std::string kAdmitLua = R"lua(
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'suppressed' end
local sent = redis.call('INCR', KEYS[2])
if sent == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if sent > tonumber(ARGV[3]) then return 'rate_limited' end
return 'ok'
)lua";

std::string rateKey(const std::string& addr) {
  const long now = static_cast<long>(
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
  return "mail:rate:" + addr + ":" + std::to_string(now / kWindowSeconds);
}

// Stop mailing an address (a hard bounce, a complaint, an unsubscribe).
void suppress(const std::string& addr) {
  redis.sadd(kSuppressedSet, address::normalize(addr));  // durable: removed only by an explicit request
}

bool isSuppressed(const std::string& addr) { return redis.sismember(kSuppressedSet, address::normalize(addr)); }

// "suppressed", "rate_limited" or "ok" for one more email to the address.
std::string admit(const std::string& addr) {
  const std::string normalized = address::normalize(addr);
  return redis.eval<std::string>(kAdmitLua, {kSuppressedSet, rateKey(normalized)},
                                 {normalized, std::to_string(kWindowSeconds), std::to_string(kRateLimit)});
}
`,
    },
  },
  harness: {
    python: `ADDR = "ana@example.com"


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_durable_suppression(ctx):
    m = ctx.load("admission")
    m.suppress(ADDR)
    verdict = m.admit(ADDR)
    assert verdict == "suppressed", f"right after suppress({ADDR!r}) admit answered {verdict!r}"
    ctx.clock.advance(2 * 3600)
    verdict = m.admit(ADDR)
    assert verdict == "suppressed", f"two hours after the unsubscribe admit answered {verdict!r}: the suppression expired and the customer is mailed again. Keep suppressed addresses in a set with no expiry"
    assert m.is_suppressed(ADDR) is True, "is_suppressed must still answer True two hours later"
    assert ctx.redis.sismember("mail:suppressed", ADDR), f"mail:suppressed does not hold {ADDR}; Redis holds {sorted(ctx.redis.keys('mail:*'))}"
    ttl = ctx.redis.ttl("mail:suppressed")
    assert ttl == -1, f"mail:suppressed has TTL {ttl}: when it runs out every unsubscribe lapses at once. The set never expires"


def check_atomic_admission(ctx):
    m = ctx.load("admission")
    for n in range(4):
        verdict = m.admit(ADDR)
        assert verdict == "ok", f"send {n + 1} of a 5-per-minute limit answered {verdict!r}"
    keys = ctx.redis.keys("mail:rate:*")
    assert len(keys) == 1, f"four sends to one address left the counters {keys}, expected one mail:rate:{{address}}:{{window}}"
    # Another send lands between the fifth send's commands on the counter.
    rival = ctx.redis_after(keys[0], lambda: m.admit(ADDR))
    fifth = m.admit(ADDR)
    racing = _settled(rival, keys[0])
    assert not (fifth == racing == "rate_limited"), "the fifth send of the minute and a send racing it were both refused: the limit admits RATE_LIMIT (5) sends a minute, so only the sixth is rate_limited"
    assert sorted([fifth, racing]) == ["ok", "rate_limited"], f"the fifth send and a send racing it were answered {fifth!r} and {racing!r}: both read the count before either incremented it, so six emails went out under a limit of five. Decide in one Lua script"
    # An unsubscribe lands right after admission reads the set.
    seen = ctx.redis_after("mail:suppressed", lambda: (ctx.redis.keys("mail:rate:*cy@example.com*"), ctx.redis.sadd("mail:suppressed", "cy@example.com"))[0])
    verdict = m.admit("cy@example.com")
    if seen.fired:
        counted = _settled(seen, "mail:suppressed")
        assert counted or verdict == "suppressed", f"an unsubscribe landed after admission read mail:suppressed and before it counted the send, and the send was answered {verdict!r}: the check and the count are separate commands, so a customer who just unsubscribed is mailed. Check the set and count in one Lua script"


def check_rate_window(ctx):
    m = ctx.load("admission")
    assert m.admit("lee@example.com") == "ok", "the first send to lee@example.com must be admitted"
    first = ctx.redis.keys("mail:rate:*")
    assert len(first) == 1, f"one send left the counters {first}, expected one mail:rate:{{address}}:{{window}}"
    created = first[0].replace("lee@example.com", ADDR)
    # A snapshot of the counter's TTL right after the command that creates it.
    snapshot = ctx.redis_after(created, lambda: ctx.redis.ttl(created))
    verdicts = [m.admit(ADDR) for _ in range(6)]
    assert verdicts == ["ok"] * 5 + ["rate_limited"], f"six sends in one minute answered {verdicts}, expected five ok and rate_limited"
    ttl = _settled(snapshot, created)
    assert 0 < ttl <= 60, f"right after the command that created {created}, its TTL was {ttl}: the EXPIRE comes in a later command, and a crash in between leaves a counter that never expires. EXPIRE it in the script that increments it"
    keys = ctx.redis.keys("mail:rate:*")
    for key in keys:
        ttl = ctx.redis.ttl(key)
        assert 0 < ttl <= 60, f"{key} has TTL {ttl}: a counter without an expiry stays in Redis for good, one per recipient per minute. EXPIRE it with the window"
    ctx.clock.advance(61)
    verdict = m.admit(ADDR)
    assert verdict == "ok", f"a minute later the next send answered {verdict!r}, expected ok"


def check_normalized_address(ctx):
    m = ctx.load("admission")
    m.suppress("  Ana@Example.COM")
    verdict = m.admit("ana@example.com")
    assert verdict == "suppressed", f"after suppress('  Ana@Example.COM'), admit('ana@example.com') answered {verdict!r}: one mailbox, two spellings. Normalize the address before every key"
    assert m.is_suppressed("ANA@example.com ") is True, "is_suppressed('ANA@example.com ') must find the suppressed mailbox"
    spellings = ["bo@example.com", "Bo@example.com", "BO@EXAMPLE.COM", " bo@example.com", "bo@Example.com", "Bo@Example.Com"]
    verdicts = [m.admit(s) for s in spellings]
    assert verdicts == ["ok"] * 5 + ["rate_limited"], f"six sends to one mailbox spelled six ways answered {verdicts}: each spelling got its own counter"
`,
    typescript: `const ADDR = 'ana@example.com';

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_durable_suppression(ctx) {
  const m = ctx.load('admission');
  await m.suppress(ADDR);
  let verdict = await m.admit(ADDR);
  assert.equal(verdict, 'suppressed', \`right after suppress(\${ADDR}) admit answered \${verdict}\`);
  ctx.clock.advance(2 * 3600);
  verdict = await m.admit(ADDR);
  assert.equal(verdict, 'suppressed', \`two hours after the unsubscribe admit answered \${verdict}: the suppression expired and the customer is mailed again. Keep suppressed addresses in a set with no expiry\`);
  assert.equal(await m.isSuppressed(ADDR), true, 'isSuppressed must still answer true two hours later');
  assert.equal(ctx.redis.sismember('mail:suppressed', ADDR), 1, \`mail:suppressed does not hold \${ADDR}; Redis holds \${JSON.stringify(ctx.redis.keys('mail:*'))}\`);
  const ttl = ctx.redis.ttl('mail:suppressed');
  assert.equal(ttl, -1, \`mail:suppressed has TTL \${ttl}: when it runs out every unsubscribe lapses at once. The set never expires\`);
}

export async function check_atomic_admission(ctx) {
  const m = ctx.load('admission');
  for (let n = 0; n < 4; n++) assert.equal(await m.admit(ADDR), 'ok', \`send \${n + 1} of a 5-per-minute limit\`);
  const keys = ctx.redis.keys('mail:rate:*');
  assert.equal(keys.length, 1, \`four sends to one address left the counters \${JSON.stringify(keys)}, expected one mail:rate:{address}:{window}\`);
  // Another send lands between the fifth send's commands on the counter.
  const rival = ctx.redisAfter(keys[0], () => m.admit(ADDR));
  const fifth = await m.admit(ADDR);
  const racing = await settled(rival, keys[0]);
  assert(!(fifth === 'rate_limited' && racing === 'rate_limited'), 'the fifth send of the minute and a send racing it were both refused: the limit admits RATE_LIMIT (5) sends a minute, so only the sixth is rate_limited');
  assert.deepStrictEqual([fifth, racing].sort(), ['ok', 'rate_limited'], \`the fifth send and a send racing it were answered \${fifth} and \${racing}: both read the count before either incremented it, so six emails went out under a limit of five. Decide in one Lua script\`);
  // An unsubscribe lands right after admission reads the set.
  const seen = ctx.redisAfter('mail:suppressed', () => {
    const counters = ctx.redis.keys('mail:rate:*cy@example.com*');
    ctx.redis.sadd('mail:suppressed', 'cy@example.com');
    return counters;
  });
  const verdict = await m.admit('cy@example.com');
  if (seen.fired) {
    const counted = await settled(seen, 'mail:suppressed');
    assert(counted.length > 0 || verdict === 'suppressed', \`an unsubscribe landed after admission read mail:suppressed and before it counted the send, and the send was answered \${verdict}: the check and the count are separate commands, so a customer who just unsubscribed is mailed. Check the set and count in one Lua script\`);
  }
}

export async function check_rate_window(ctx) {
  const m = ctx.load('admission');
  assert.equal(await m.admit('lee@example.com'), 'ok', 'the first send to lee@example.com must be admitted');
  const first = ctx.redis.keys('mail:rate:*');
  assert.equal(first.length, 1, \`one send left the counters \${JSON.stringify(first)}, expected one mail:rate:{address}:{window}\`);
  const created = first[0].replace('lee@example.com', ADDR);
  // A snapshot of the counter's TTL right after the command that creates it.
  const snapshot = ctx.redisAfter(created, () => ctx.redis.ttl(created));
  const verdicts: string[] = [];
  for (let n = 0; n < 6; n++) verdicts.push(await m.admit(ADDR));
  assert.deepStrictEqual(verdicts, ['ok', 'ok', 'ok', 'ok', 'ok', 'rate_limited'], \`six sends in one minute answered \${JSON.stringify(verdicts)}\`);
  const createdTtl = await settled(snapshot, created);
  assert(createdTtl > 0 && createdTtl <= 60, \`right after the command that created \${created}, its TTL was \${createdTtl}: the EXPIRE comes in a later command, and a crash in between leaves a counter that never expires. EXPIRE it in the script that increments it\`);
  const keys = ctx.redis.keys('mail:rate:*');
  for (const key of keys) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl > 0 && ttl <= 60, \`\${key} has TTL \${ttl}: a counter without an expiry stays in Redis for good, one per recipient per minute. EXPIRE it with the window\`);
  }
  ctx.clock.advance(61);
  assert.equal(await m.admit(ADDR), 'ok', 'a minute later the next send must be admitted');
}

export async function check_normalized_address(ctx) {
  const m = ctx.load('admission');
  await m.suppress('  Ana@Example.COM');
  const verdict = await m.admit('ana@example.com');
  assert.equal(verdict, 'suppressed', \`after suppress('  Ana@Example.COM'), admit('ana@example.com') answered \${verdict}: one mailbox, two spellings. Normalize the address before every key\`);
  assert.equal(await m.isSuppressed('ANA@example.com '), true, "isSuppressed('ANA@example.com ') must find the suppressed mailbox");
  const verdicts: string[] = [];
  for (const s of ['bo@example.com', 'Bo@example.com', 'BO@EXAMPLE.COM', ' bo@example.com', 'bo@Example.com', 'Bo@Example.Com']) verdicts.push(await m.admit(s));
  assert.deepStrictEqual(verdicts, ['ok', 'ok', 'ok', 'ok', 'ok', 'rate_limited'], \`six sends to one mailbox spelled six ways answered \${JSON.stringify(verdicts)}: each spelling got its own counter\`);
}
`,
    go: `package main

import (
	"context"
	"strings"

	"leetbuild/harness"
)

const harnessAddr = "ana@example.com"

var admissionBg = context.Background()

func mustAdmit(ctx *harness.Ctx, addr string) string {
	verdict, err := admit(admissionBg, addr)
	ctx.NoError(err, "admit(%q) failed", addr)
	return verdict
}

func CheckDurableSuppression(ctx *harness.Ctx) {
	ctx.NoError(suppress(admissionBg, harnessAddr), "suppress failed")
	ctx.Equal(mustAdmit(ctx, harnessAddr), "suppressed", "right after suppress, admit")
	ctx.Clock.Advance(2 * 3600)
	ctx.Equal(mustAdmit(ctx, harnessAddr), "suppressed", "two hours after the unsubscribe the suppression expired and the customer is mailed again (keep suppressed addresses in a set with no expiry); admit")
	suppressed, err := isSuppressed(admissionBg, harnessAddr)
	ctx.NoError(err, "isSuppressed failed")
	ctx.Equal(suppressed, true, "isSuppressed two hours later")
	ctx.Assert(ctx.Redis.SIsMember("mail:suppressed", harnessAddr), "mail:suppressed does not hold %s; Redis holds %q", harnessAddr, ctx.Redis.Keys("mail:*"))
	ctx.Equal(ctx.Redis.TTL("mail:suppressed"), int64(-1), "the TTL of mail:suppressed (when it runs out every unsubscribe lapses at once; the set never expires)")
}

func CheckAtomicAdmission(ctx *harness.Ctx) {
	for n := 0; n < 4; n++ {
		ctx.Equal(mustAdmit(ctx, harnessAddr), "ok", "send %d of a 5-per-minute limit", n+1)
	}
	keys := ctx.Redis.Keys("mail:rate:*")
	ctx.Equal(len(keys), 1, "four sends to one address must leave one mail:rate:{address}:{window} counter (%q); counters", keys)
	// Another send lands between the fifth send's commands on the counter.
	rival := ctx.Redis.After(keys[0], func() any {
		verdict, _ := admit(admissionBg, harnessAddr)
		return verdict
	})
	fifth := mustAdmit(ctx, harnessAddr)
	ctx.Assert(rival.Fired, "nothing touched %s", keys[0])
	racing, _ := rival.Result.(string)
	ctx.Assert(!(fifth == "rate_limited" && racing == "rate_limited"), "the fifth send of the minute and a send racing it were both refused: the limit admits RATE_LIMIT (5) sends a minute, so only the sixth is rate_limited")
	ctx.Assert((fifth == "ok" && racing == "rate_limited") || (fifth == "rate_limited" && racing == "ok"),
		"the fifth send and a send racing it were answered %q and %q: both read the count before either incremented it, so six emails went out under a limit of five. Decide in one Lua script", fifth, racing)
	// An unsubscribe lands right after admission reads the set.
	seen := ctx.Redis.After("mail:suppressed", func() any {
		counters := ctx.Redis.Keys("mail:rate:*cy@example.com*")
		ctx.Redis.Do("SADD", "mail:suppressed", "cy@example.com")
		return counters
	})
	verdict := mustAdmit(ctx, "cy@example.com")
	if seen.Fired {
		counted, _ := seen.Result.([]string)
		ctx.Assert(len(counted) > 0 || verdict == "suppressed", "an unsubscribe landed after admission read mail:suppressed and before it counted the send, and the send was answered %q: the check and the count are separate commands, so a customer who just unsubscribed is mailed. Check the set and count in one Lua script", verdict)
	}
}

func CheckRateWindow(ctx *harness.Ctx) {
	ctx.Equal(mustAdmit(ctx, "lee@example.com"), "ok", "the first send to lee@example.com")
	first := ctx.Redis.Keys("mail:rate:*")
	ctx.Equal(len(first), 1, "one send must leave one mail:rate:{address}:{window} counter (%q); counters", first)
	created := strings.ReplaceAll(first[0], "lee@example.com", harnessAddr)
	// A snapshot of the counter's TTL right after the command that creates it.
	snapshot := ctx.Redis.After(created, func() any { return ctx.Redis.TTL(created) })
	var verdicts []string
	for n := 0; n < 6; n++ {
		verdicts = append(verdicts, mustAdmit(ctx, harnessAddr))
	}
	ctx.Equal(verdicts, []string{"ok", "ok", "ok", "ok", "ok", "rate_limited"}, "six sends in one minute")
	ctx.Assert(snapshot.Fired, "nothing touched %s", created)
	createdTTL, _ := snapshot.Result.(int64)
	ctx.Assert(createdTTL > 0 && createdTTL <= 60, "right after the command that created %s, its TTL was %d: the EXPIRE comes in a later command, and a crash in between leaves a counter that never expires. EXPIRE it in the script that increments it", created, createdTTL)
	keys := ctx.Redis.Keys("mail:rate:*")
	for _, key := range keys {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: a counter without an expiry stays in Redis for good, one per recipient per minute. EXPIRE it with the window", key, ttl)
	}
	ctx.Clock.Advance(61)
	ctx.Equal(mustAdmit(ctx, harnessAddr), "ok", "a minute later the next send")
}

func CheckNormalizedAddress(ctx *harness.Ctx) {
	ctx.NoError(suppress(admissionBg, "  Ana@Example.COM"), "suppress failed")
	ctx.Equal(mustAdmit(ctx, "ana@example.com"), "suppressed", "after suppress('  Ana@Example.COM') one mailbox has two spellings (normalize the address before every key); admit('ana@example.com')")
	suppressed, _ := isSuppressed(admissionBg, "ANA@example.com ")
	ctx.Equal(suppressed, true, "isSuppressed('ANA@example.com ')")
	var verdicts []string
	for _, s := range []string{"bo@example.com", "Bo@example.com", "BO@EXAMPLE.COM", " bo@example.com", "bo@Example.com", "Bo@Example.Com"} {
		verdicts = append(verdicts, mustAdmit(ctx, s))
	}
	ctx.Equal(verdicts, []string{"ok", "ok", "ok", "ok", "ok", "rate_limited"}, "six sends to one mailbox spelled six ways (each spelling got its own counter)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kAddr = "ana@example.com";

}  // namespace

void CheckDurableSuppression(harness::Ctx& ctx) {
  suppress(kAddr);
  ctx.Equal(admit(kAddr), "suppressed", "right after suppress, admit");
  ctx.Clock.Advance(2 * 3600);
  ctx.Equal(admit(kAddr), "suppressed", "two hours after the unsubscribe the suppression expired and the customer is mailed again (keep suppressed addresses in a set with no expiry); admit");
  ctx.Equal(isSuppressed(kAddr), true, "isSuppressed two hours later");
  ctx.Assert(ctx.Redis.SIsMember("mail:suppressed", kAddr), "mail:suppressed does not hold %s; Redis holds %q", kAddr, ctx.Redis.Keys("mail:*"));
  ctx.Equal(ctx.Redis.TTL("mail:suppressed"), -1LL, "the TTL of mail:suppressed (when it runs out every unsubscribe lapses at once; the set never expires)");
}

void CheckAtomicAdmission(harness::Ctx& ctx) {
  for (int n = 0; n < 4; n++) ctx.Equal(admit(kAddr), "ok", "send %d of a 5-per-minute limit", n + 1);
  const auto keys = ctx.Redis.Keys("mail:rate:*");
  ctx.Equal(keys.size(), 1, "four sends to one address must leave one mail:rate:{address}:{window} counter (%q); counters", keys);
  // Another send lands between the fifth send's commands on the counter.
  auto racing = std::make_shared<std::string>();
  ctx.Redis.After(keys[0], [racing] { *racing = admit(kAddr); });
  const std::string fifth = admit(kAddr);
  ctx.Assert(!racing->empty(), "nothing touched %s", keys[0]);
  ctx.Assert(!(fifth == "rate_limited" && *racing == "rate_limited"),
             "the fifth send of the minute and a send racing it were both refused: the limit admits RATE_LIMIT (5) sends a minute, so only the sixth is rate_limited");
  ctx.Assert((fifth == "ok" && *racing == "rate_limited") || (fifth == "rate_limited" && *racing == "ok"),
             "the fifth send and a send racing it were answered %q and %q: both read the count before either incremented it, so six emails went out under a limit of five. Decide in one Lua script",
             fifth, *racing);
  // An unsubscribe lands right after admission reads the set.
  auto counted = std::make_shared<std::optional<bool>>();
  ctx.Redis.After("mail:suppressed", [&ctx, counted] {
    *counted = !ctx.Redis.Keys("mail:rate:*cy@example.com*").empty();
    ctx.Redis.Do("SADD", "mail:suppressed", "cy@example.com");
  });
  const std::string verdict = admit("cy@example.com");
  if (counted->has_value()) {
    ctx.Assert(**counted || verdict == "suppressed",
               "an unsubscribe landed after admission read mail:suppressed and before it counted the send, and the send was answered %q: the check and the count are separate commands, so a customer who just unsubscribed is mailed. Check the set and count in one Lua script",
               verdict);
  }
}

void CheckRateWindow(harness::Ctx& ctx) {
  ctx.Equal(admit("lee@example.com"), "ok", "the first send to lee@example.com");
  const auto first = ctx.Redis.Keys("mail:rate:*");
  ctx.Equal(first.size(), 1, "one send must leave one mail:rate:{address}:{window} counter (%q); counters", first);
  std::string created = first[0];
  if (const auto at = created.find("lee@example.com"); at != std::string::npos) created.replace(at, std::string("lee@example.com").size(), kAddr);
  // A snapshot of the counter's TTL right after the command that creates it.
  auto snapshot = std::make_shared<std::optional<long long>>();
  ctx.Redis.After(created, [&ctx, created, snapshot] { *snapshot = ctx.Redis.TTL(created); });
  std::vector<std::string> verdicts;
  for (int n = 0; n < 6; n++) verdicts.push_back(admit(kAddr));
  ctx.Equal(verdicts, std::vector<std::string>{"ok", "ok", "ok", "ok", "ok", "rate_limited"}, "six sends in one minute");
  ctx.Assert(snapshot->has_value(), "nothing touched %s", created);
  const long long created_ttl = snapshot->value_or(0);
  ctx.Assert(created_ttl > 0 && created_ttl <= 60,
             "right after the command that created %s, its TTL was %d: the EXPIRE comes in a later command, and a crash in between leaves a counter that never expires. EXPIRE it in the script that increments it",
             created, created_ttl);
  const auto keys = ctx.Redis.Keys("mail:rate:*");
  for (const auto& key : keys) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl > 0 && ttl <= 60, "%s has TTL %d: a counter without an expiry stays in Redis for good, one per recipient per minute. EXPIRE it with the window", key, ttl);
  }
  ctx.Clock.Advance(61);
  ctx.Equal(admit(kAddr), "ok", "a minute later the next send");
}

void CheckNormalizedAddress(harness::Ctx& ctx) {
  suppress("  Ana@Example.COM");
  ctx.Equal(admit("ana@example.com"), "suppressed", "after suppress('  Ana@Example.COM') one mailbox has two spellings (normalize the address before every key); admit('ana@example.com')");
  ctx.Equal(isSuppressed("ANA@example.com "), true, "isSuppressed('ANA@example.com ')");
  std::vector<std::string> verdicts;
  for (const std::string s : {"bo@example.com", "Bo@example.com", "BO@EXAMPLE.COM", " bo@example.com", "bo@Example.com", "Bo@Example.Com"}) {
    verdicts.push_back(admit(s));
  }
  ctx.Equal(verdicts, std::vector<std::string>{"ok", "ok", "ok", "ok", "ok", "rate_limited"}, "six sends to one mailbox spelled six ways (each spelling got its own counter)");
}
`,
  },
  hints: [
    'Unsubscribe a customer and send again two hours later: the mail goes out. Fire two sends at the fifth email of the minute: both are admitted. `Ana@Example.com` escapes a suppression of `ana@example.com`.',
    'The suppression is a key with a one-hour expiry. The counter is read with GET and raised with INCR in two round trips, so another send lands between them; nothing expires it; and the raw address is the key.',
    '`SADD mail:suppressed normalize(address)`. One script: `SISMEMBER KEYS[1] ARGV[1]` → suppressed; `INCR KEYS[2]`, `EXPIRE KEYS[2] ARGV[2]` when it returns 1, above `ARGV[3]` → rate_limited, else ok.',
  ],
  debrief: `Suppression is a fact about a person, not a cache entry, so it lives in a set with no expiry and leaves it only on an explicit request. The rate limit needs its read and its write to be one step, which a Lua script gives: Redis runs it whole, so no send can read the count between another send's check and its increment. The EXPIRE on the first increment keeps a fixed window cheap, one key per recipient per minute that cleans itself up, and normalizing first keeps one mailbox under one key. Providers also store the reason and the date with each suppressed address, keep a list per tenant as well as a global one, and smooth the burst at each minute boundary with a sliding window or a token bucket.`,
};
