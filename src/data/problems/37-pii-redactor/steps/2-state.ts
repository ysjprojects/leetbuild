import type {Step} from '@/lib/types';

export const redactionStateStep: Step = {
  id: 'state',
  title: 'A per-tenant hourly budget, reserved in one script',
  concept: 'redis',
  file: 'state',
  focus: ['redactor', 'redis', 'detector'],
  task: `## Task

**Starting point.** The starter meters what each tenant sends to the detector:
\`reserve_budget(tenant, chars)\` reads \`budget:{tenant}:{window}\` (\`window\` is the unix time divided
by \`WINDOW_S\`, 3600), refuses once the count reaches \`BUDGET_PER_HOUR\` (2 000 000 characters),
otherwise \`INCRBY\`s it, and answers a \`Reservation(allowed, remaining, retry_after)\`;
\`detect_within_budget(tenant, text, entities)\` calls \`ner.detect\`, reserves \`len(text)\` and
raises \`BudgetExhausted\` on a refusal. It serves the demo and hides four flaws.

**Failure mode the checks target.** Two requests read the same count and both spend the last of
the budget; a request that does not fit goes through because the count was still under the cap;
the window key never expires and every refusal says to retry in an hour; and an over-budget tenant
still costs a detector call.

- One Lua script (\`RESERVE_LUA\`) reads, refuses and charges. A request is refused when
  \`used + chars\` exceeds the cap, and a refusal charges nothing.
- The first charge of a window sets the key's TTL to the seconds left in the window; \`retry_after\`
  is those seconds, \`remaining\` what the cap still allows.
- \`detect_within_budget\` reserves before it calls \`detect\`.`,
  sequence: {
    participants: ['Redactor', 'Redis', 'Detector'],
    messages: [
      {
        from: 'Redactor',
        to: 'Redis',
        label: 'EVAL RESERVE_LUA · budget:acme:493391 · chars, cap, seconds left',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redactor', label: '{1, remaining} · or {0, remaining}, nothing charged', kind: 'reply'},
      {from: 'Redactor', to: 'Redactor', label: 'refused → BudgetExhausted(retry_after)', kind: 'sync'},
      {from: 'Redactor', to: 'Detector', label: 'ner.detect(text, entities), only once reserved', kind: 'sync'},
      {from: 'Detector', to: 'Redactor', label: 'Detection', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-reserve',
      title: 'Reads, refuses and charges in one script',
      detail:
        'The read, the comparison and the `INCRBY` run in one Lua script (`register_script`/`eval`, `defineCommand`, `redis.NewScript`), so no other request lands between them; the starter `GET`s and then `INCRBY`s in two round trips, and two requests both spend the last of the budget.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /INCRBY/], none: [/\br\.incrby\(/, /\br\.get\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /INCRBY/], none: [/redis\.incrby\(/, /redis\.get\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /INCRBY/], none: [/rdb\.IncrBy\(/, /rdb\.Get\(/]},
        scala: {all: [/\.eval\(/, /INCRBY/], none: [/jedis\.incrBy\(/, /jedis\.get\(/]},
        cpp: {all: [/\.eval</, /INCRBY/], none: [/\.incrby\(/, /\.get\(key\)/]},
      },
    },
    {
      id: 'fits-whole',
      title: 'A request that does not fit is refused and charges nothing',
      detail:
        'The script refuses when `used + chars` is over the cap and charges nothing then; the starter compares the count alone with the cap, so a tenant at 1 900 000 sends 200 000 more and ends the hour over its budget.',
      match: {
        python: {all: [/\+\s*(?:chars|tonumber\(ARGV\[1\]\))\s*>/], none: [/used\s*>=\s*BUDGET_PER_HOUR/]},
        typescript: {all: [/\+\s*(?:chars|tonumber\(ARGV\[1\]\))\s*>/], none: [/used\s*>=\s*BUDGET_PER_HOUR/]},
        go: {all: [/\+\s*(?:chars|tonumber\(ARGV\[1\]\))\s*>/], none: [/used\s*>=\s*budgetPerHour/]},
        scala: {all: [/\+\s*(?:chars|tonumber\(ARGV\[1\]\))\s*>/], none: [/used\s*>=\s*BudgetPerHour/]},
        cpp: {all: [/\+\s*(?:chars|tonumber\(ARGV\[1\]\))\s*>/], none: [/used\s*>=\s*kBudgetPerHour/]},
      },
    },
    {
      id: 'hourly-window',
      title: 'The window key expires with its hour and a refusal says when',
      detail:
        'The first charge of a window sets `EXPIRE` to the seconds left in the window, and `retry_after` is those seconds; the starter sets no TTL and answers `WINDOW_S` whatever the time, so a client refused at 12:59 waits until 13:59.',
      match: {
        python: {all: [/EXPIRE/], none: [/Reservation\([^)]*WINDOW_S\)/]},
        typescript: {all: [/EXPIRE/], none: [/retryAfter:\s*WINDOW_S\b/]},
        go: {all: [/EXPIRE/], none: [/RetryAfter:\s*windowSeconds\b/]},
        scala: {all: [/EXPIRE/], none: [/Reservation\([^)]*WindowSeconds\)/]},
        cpp: {all: [/EXPIRE/], none: [/Reservation\{[^}]*kWindowSeconds\}/]},
      },
    },
    {
      id: 'reserve-before-detect',
      title: 'Reserves before the detector runs',
      detail:
        '`detect_within_budget` reserves first and calls `detect` only when the reservation is allowed; the starter calls the detector, then reserves, so a refused request has already spent a model call.',
      match: {
        python: {order: [/=\s*reserve_budget\(/, /\bdetect\(text/]},
        typescript: {order: [/=\s*await reserveBudget\(/, /\bdetect\(text/]},
        go: {order: [/:?=\s*reserveBudget\(/, /ner\.Detect\(/]},
        scala: {order: [/=\s*reserveBudget\(/, /Ner\.detect\(/]},
        cpp: {order: [/=\s*reserve_budget\(/, /ner::detect\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
from dataclasses import dataclass

import redis

from redactor.ner import detect  # detect(text, entities) -> Detection
from redactor.spans import Detection

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUDGET_PER_HOUR = 2_000_000
WINDOW_S = 3600


@dataclass
class Reservation:
    allowed: bool
    remaining: int
    retry_after: int


class BudgetExhausted(Exception):
    def __init__(self, reservation: Reservation):
        super().__init__(f"budget exhausted, retry in {reservation.retry_after} s")
        self.reservation = reservation


def reserve_budget(tenant: str, chars: int) -> Reservation:
    """Charge chars to the tenant's budget for the current hour, if they fit."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    window = int(time.time()) // WINDOW_S
    key = f"budget:{tenant}:{window}"
    used = int(r.get(key) or 0)
    if used >= BUDGET_PER_HOUR:
        return Reservation(False, 0, WINDOW_S)
    used = r.incrby(key, chars)
    return Reservation(True, max(BUDGET_PER_HOUR - used, 0), WINDOW_S)


def detect_within_budget(tenant: str, text: str, entities) -> Detection:
    """The detection of text, charged to the tenant's budget; BudgetExhausted when it does not fit."""
    detection = detect(text, entities)
    reservation = reserve_budget(tenant, len(text))
    if not reservation.allowed:
        raise BudgetExhausted(reservation)
    return detection
`,
      solution: `import time
from dataclasses import dataclass

import redis

from redactor.ner import detect  # detect(text, entities) -> Detection
from redactor.spans import Detection

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUDGET_PER_HOUR = 2_000_000
WINDOW_S = 3600

# Read, refuse and charge in one step: no other request lands between the read and the charge.
RESERVE_LUA = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local chars = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + chars > cap then return {0, cap - used} end
used = redis.call('INCRBY', KEYS[1], chars)
if used == chars then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, cap - used}
"""
reserve = r.register_script(RESERVE_LUA)


@dataclass
class Reservation:
    allowed: bool
    remaining: int
    retry_after: int


class BudgetExhausted(Exception):
    def __init__(self, reservation: Reservation):
        super().__init__(f"budget exhausted, retry in {reservation.retry_after} s")
        self.reservation = reservation


def reserve_budget(tenant: str, chars: int) -> Reservation:
    """Charge chars to the tenant's budget for the current hour, if they fit."""
    window, into = divmod(int(time.time()), WINDOW_S)
    seconds_left = WINDOW_S - into  # the key lives as long as its window, and a refusal says when the next one opens
    allowed, remaining = reserve(keys=[f"budget:{tenant}:{window}"], args=[chars, BUDGET_PER_HOUR, seconds_left])
    return Reservation(allowed == 1, remaining, seconds_left)


def detect_within_budget(tenant: str, text: str, entities) -> Detection:
    """The detection of text, charged to the tenant's budget; BudgetExhausted when it does not fit."""
    reservation = reserve_budget(tenant, len(text))
    if not reservation.allowed:
        raise BudgetExhausted(reservation)  # refused before the model is paid for
    return detect(text, entities)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {detect} from 'redactor/ner'; // detect(text, entities): Detection
import type {Detection} from 'redactor/spans';

export const BUDGET_PER_HOUR = 2_000_000;
export const WINDOW_S = 3600;

const redis = new Redis({host: 'redis', port: 6379});

export interface Reservation {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export class BudgetExhausted extends Error {
  constructor(readonly reservation: Reservation) {
    super(\`budget exhausted, retry in \${reservation.retryAfter} s\`);
  }
}

/** Charge chars to the tenant's budget for the current hour, if they fit. */
export async function reserveBudget(tenant: string, chars: number): Promise<Reservation> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const key = \`budget:\${tenant}:\${window}\`;
  const used = Number((await redis.get(key)) ?? 0);
  if (used >= BUDGET_PER_HOUR) return {allowed: false, remaining: 0, retryAfter: WINDOW_S};
  const charged = await redis.incrby(key, chars);
  return {allowed: true, remaining: Math.max(BUDGET_PER_HOUR - charged, 0), retryAfter: WINDOW_S};
}

/** The detection of text, charged to the tenant's budget; BudgetExhausted when it does not fit. */
export async function detectWithinBudget(tenant: string, text: string, entities: readonly string[]): Promise<Detection> {
  const detection = await detect(text, entities);
  const reservation = await reserveBudget(tenant, text.length);
  if (!reservation.allowed) throw new BudgetExhausted(reservation);
  return detection;
}
`,
      solution: `import Redis from 'ioredis';

import {detect} from 'redactor/ner'; // detect(text, entities): Detection
import type {Detection} from 'redactor/spans';

export const BUDGET_PER_HOUR = 2_000_000;
export const WINDOW_S = 3600;

// Read, refuse and charge in one step: no other request lands between the read and the charge.
export const RESERVE_LUA = \`
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local chars = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + chars > cap then return {0, cap - used} end
used = redis.call('INCRBY', KEYS[1], chars)
if used == chars then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, cap - used}
\`;

interface ReserveRedis extends Redis {
  reserve(key: string, chars: number, cap: number, secondsLeft: number): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ReserveRedis;
redis.defineCommand('reserve', {numberOfKeys: 1, lua: RESERVE_LUA});

export interface Reservation {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export class BudgetExhausted extends Error {
  constructor(readonly reservation: Reservation) {
    super(\`budget exhausted, retry in \${reservation.retryAfter} s\`);
  }
}

/** Charge chars to the tenant's budget for the current hour, if they fit. */
export async function reserveBudget(tenant: string, chars: number): Promise<Reservation> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_S);
  const secondsLeft = WINDOW_S - (now % WINDOW_S); // the key lives as long as its window, and a refusal says when the next one opens
  const [allowed, remaining] = await redis.reserve(\`budget:\${tenant}:\${window}\`, chars, BUDGET_PER_HOUR, secondsLeft);
  return {allowed: allowed === 1, remaining, retryAfter: secondsLeft};
}

/** The detection of text, charged to the tenant's budget; BudgetExhausted when it does not fit. */
export async function detectWithinBudget(tenant: string, text: string, entities: readonly string[]): Promise<Detection> {
  const reservation = await reserveBudget(tenant, text.length);
  if (!reservation.allowed) throw new BudgetExhausted(reservation); // refused before the model is paid for
  return detect(text, entities);
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

	"redactor/ner"   // ner.Detect(ctx, text, entities) (spans.Detection, error)
	"redactor/spans" // spans.Detection
)

const (
	budgetPerHour = 2_000_000
	windowSeconds = 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Reservation struct {
	Allowed    bool
	Remaining  int64
	RetryAfter int64
}

// BudgetExhausted is the error of a refused reservation.
type BudgetExhausted struct{ Reservation Reservation }

func (e *BudgetExhausted) Error() string {
	return fmt.Sprintf("budget exhausted, retry in %d s", e.Reservation.RetryAfter)
}

// reserveBudget charges chars to the tenant's budget for the current hour, if they fit.
func reserveBudget(ctx context.Context, tenant string, chars int64) (Reservation, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := fmt.Sprintf("budget:%s:%d", tenant, time.Now().Unix()/windowSeconds)
	used, err := rdb.Get(ctx, key).Int64()
	if err != nil && err != redis.Nil {
		return Reservation{}, err
	}
	if used >= budgetPerHour {
		return Reservation{Allowed: false, Remaining: 0, RetryAfter: windowSeconds}, nil
	}
	charged, err := rdb.IncrBy(ctx, key, chars).Result()
	if err != nil {
		return Reservation{}, err
	}
	return Reservation{Allowed: true, Remaining: max(budgetPerHour-charged, 0), RetryAfter: windowSeconds}, nil
}

// detectWithinBudget is the detection of text, charged to the tenant's budget; a *BudgetExhausted when it does not fit.
func detectWithinBudget(ctx context.Context, tenant, text string, entities []string) (spans.Detection, error) {
	detection, err := ner.Detect(ctx, text, entities)
	if err != nil {
		return spans.Detection{}, err
	}
	reservation, err := reserveBudget(ctx, tenant, int64(len(text)))
	if err != nil {
		return spans.Detection{}, err
	}
	if !reservation.Allowed {
		return spans.Detection{}, &BudgetExhausted{Reservation: reservation}
	}
	return detection, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"redactor/ner"   // ner.Detect(ctx, text, entities) (spans.Detection, error)
	"redactor/spans" // spans.Detection
)

const (
	budgetPerHour = 2_000_000
	windowSeconds = 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// reserveScript reads, refuses and charges in one step: no other request lands between the read and the charge.
var reserveScript = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local chars = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + chars > cap then return {0, cap - used} end
used = redis.call('INCRBY', KEYS[1], chars)
if used == chars then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, cap - used}
\`)

type Reservation struct {
	Allowed    bool
	Remaining  int64
	RetryAfter int64
}

// BudgetExhausted is the error of a refused reservation.
type BudgetExhausted struct{ Reservation Reservation }

func (e *BudgetExhausted) Error() string {
	return fmt.Sprintf("budget exhausted, retry in %d s", e.Reservation.RetryAfter)
}

// reserveBudget charges chars to the tenant's budget for the current hour, if they fit.
func reserveBudget(ctx context.Context, tenant string, chars int64) (Reservation, error) {
	now := time.Now().Unix()
	key := fmt.Sprintf("budget:%s:%d", tenant, now/windowSeconds)
	secondsLeft := windowSeconds - now%windowSeconds // the key lives as long as its window, and a refusal says when the next one opens
	result, err := reserveScript.Run(ctx, rdb, []string{key}, chars, budgetPerHour, secondsLeft).Int64Slice()
	if err != nil {
		return Reservation{}, err
	}
	return Reservation{Allowed: result[0] == 1, Remaining: result[1], RetryAfter: secondsLeft}, nil
}

// detectWithinBudget is the detection of text, charged to the tenant's budget; a *BudgetExhausted when it does not fit.
func detectWithinBudget(ctx context.Context, tenant, text string, entities []string) (spans.Detection, error) {
	reservation, err := reserveBudget(ctx, tenant, int64(len(text)))
	if err != nil {
		return spans.Detection{}, err
	}
	if !reservation.Allowed {
		return spans.Detection{}, &BudgetExhausted{Reservation: reservation} // refused before the model is paid for
	}
	return ner.Detect(ctx, text, entities)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import redactor.Ner // Ner.detect(text, entities): Detection
import redactor.Spans.Detection

final case class Reservation(allowed: Boolean, remaining: Long, retryAfter: Long)

final class BudgetExhausted(val reservation: Reservation) extends Exception(s"budget exhausted, retry in \${reservation.retryAfter} s")

object State {
  val BudgetPerHour = 2000000L
  val WindowSeconds = 3600L

  private val jedis = new JedisPooled("redis", 6379)

  /** Charge chars to the tenant's budget for the current hour, if they fit. */
  def reserveBudget(tenant: String, chars: Long): Reservation = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"budget:$tenant:\${System.currentTimeMillis() / 1000 / WindowSeconds}"
    val used = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (used >= BudgetPerHour) Reservation(false, 0L, WindowSeconds)
    else {
      val charged = jedis.incrBy(key, chars)
      Reservation(true, math.max(BudgetPerHour - charged, 0L), WindowSeconds)
    }
  }

  /** The detection of text, charged to the tenant's budget; BudgetExhausted when it does not fit. */
  def detectWithinBudget(tenant: String, text: String, entities: Seq[String]): Detection = {
    val detection = Ner.detect(text, entities)
    val reservation = reserveBudget(tenant, text.length.toLong)
    if (!reservation.allowed) throw new BudgetExhausted(reservation)
    detection
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import redactor.Ner // Ner.detect(text, entities): Detection
import redactor.Spans.Detection

final case class Reservation(allowed: Boolean, remaining: Long, retryAfter: Long)

final class BudgetExhausted(val reservation: Reservation) extends Exception(s"budget exhausted, retry in \${reservation.retryAfter} s")

object State {
  val BudgetPerHour = 2000000L
  val WindowSeconds = 3600L

  private val jedis = new JedisPooled("redis", 6379)

  /** Read, refuse and charge in one step: no other request lands between the read and the charge. */
  val ReserveLua: String =
    """local used = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local chars = tonumber(ARGV[1])
      |local cap = tonumber(ARGV[2])
      |if used + chars > cap then return {0, cap - used} end
      |used = redis.call('INCRBY', KEYS[1], chars)
      |if used == chars then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
      |return {1, cap - used}
      |""".stripMargin

  /** Charge chars to the tenant's budget for the current hour, if they fit. */
  def reserveBudget(tenant: String, chars: Long): Reservation = {
    val now = System.currentTimeMillis() / 1000
    val secondsLeft = WindowSeconds - now % WindowSeconds // the key lives as long as its window, and a refusal says when the next one opens
    val args = List(chars.toString, BudgetPerHour.toString, secondsLeft.toString).asJava
    val result = jedis.eval(ReserveLua, List(s"budget:$tenant:\${now / WindowSeconds}").asJava, args).asInstanceOf[java.util.List[java.lang.Long]]
    Reservation(result.get(0) == 1L, result.get(1), secondsLeft)
  }

  /** The detection of text, charged to the tenant's budget; BudgetExhausted when it does not fit. */
  def detectWithinBudget(tenant: String, text: String, entities: Seq[String]): Detection = {
    val reservation = reserveBudget(tenant, text.length.toLong)
    if (!reservation.allowed) throw new BudgetExhausted(reservation) // refused before the model is paid for
    Ner.detect(text, entities)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "redactor/ner.h"    // ner::detect(text, entities) -> spans::Detection
#include "redactor/spans.h"  // spans::Detection

constexpr long long kBudgetPerHour = 2000000;
constexpr long long kWindowSeconds = 3600;

struct Reservation {
  bool allowed = false;
  long long remaining = 0;
  long long retry_after = 0;
};

struct BudgetExhausted : std::runtime_error {
  explicit BudgetExhausted(const Reservation& r) : std::runtime_error("budget exhausted"), reservation(r) {}
  Reservation reservation;
};

sw::redis::Redis& budget_redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

long long unix_now() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Charge chars to the tenant's budget for the current hour, if they fit.
Reservation reserve_budget(const std::string& tenant, long long chars) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "budget:" + tenant + ":" + std::to_string(unix_now() / kWindowSeconds);
  const auto value = budget_redis().get(key);
  const long long used = value ? std::stoll(*value) : 0;
  if (used >= kBudgetPerHour) return Reservation{false, 0, kWindowSeconds};
  const long long charged = budget_redis().incrby(key, chars);
  return Reservation{true, std::max(kBudgetPerHour - charged, 0LL), kWindowSeconds};
}

// The detection of text, charged to the tenant's budget; throws BudgetExhausted when it does not fit.
spans::Detection detect_within_budget(const std::string& tenant, const std::string& text, const std::vector<std::string>& entities) {
  spans::Detection detection = ner::detect(text, entities);
  const Reservation reservation = reserve_budget(tenant, static_cast<long long>(text.size()));
  if (!reservation.allowed) throw BudgetExhausted(reservation);
  return detection;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "redactor/ner.h"    // ner::detect(text, entities) -> spans::Detection
#include "redactor/spans.h"  // spans::Detection

constexpr long long kBudgetPerHour = 2000000;
constexpr long long kWindowSeconds = 3600;

// Read, refuse and charge in one step: no other request lands between the read and the charge.
const std::string kReserveLua = R"lua(
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local chars = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if used + chars > cap then return {0, cap - used} end
used = redis.call('INCRBY', KEYS[1], chars)
if used == chars then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return {1, cap - used}
)lua";

struct Reservation {
  bool allowed = false;
  long long remaining = 0;
  long long retry_after = 0;
};

struct BudgetExhausted : std::runtime_error {
  explicit BudgetExhausted(const Reservation& r) : std::runtime_error("budget exhausted"), reservation(r) {}
  Reservation reservation;
};

sw::redis::Redis& budget_redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

long long unix_now() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Charge chars to the tenant's budget for the current hour, if they fit.
Reservation reserve_budget(const std::string& tenant, long long chars) {
  const long long now = unix_now();
  const std::string key = "budget:" + tenant + ":" + std::to_string(now / kWindowSeconds);
  const long long seconds_left = kWindowSeconds - now % kWindowSeconds;  // the key lives as long as its window, and a refusal says when the next one opens
  const auto [allowed, remaining] = budget_redis().eval<long long, long long>(kReserveLua, {key}, {chars, kBudgetPerHour, seconds_left});
  return Reservation{allowed == 1, remaining, seconds_left};
}

// The detection of text, charged to the tenant's budget; throws BudgetExhausted when it does not fit.
spans::Detection detect_within_budget(const std::string& tenant, const std::string& text, const std::vector<std::string>& entities) {
  const Reservation reservation = reserve_budget(tenant, static_cast<long long>(text.size()));
  if (!reservation.allowed) throw BudgetExhausted(reservation);  // refused before the model is paid for
  return ner::detect(text, entities);
}
`,
    },
  },
  harness: {
    python: `import time

import detector_pb2
import detector_pb2_grpc
from redactor.spans import scan

CAP = 2_000_000
TEXT = "Reach Ada at ada@example.com."


class Detector(detector_pb2_grpc.DetectorServicer):
    """The NER model's stand-in: every requested type a pattern covers, by its pattern."""

    def Detect(self, request, context):
        found = [detector_pb2.EntitySpan(start=s.start, end=s.end, entity=s.entity) for s in scan(request.text, request.entities)]
        return detector_pb2.DetectResponse(spans=found, model_version="ner-2026.10")


def _window(ctx, into):
    """Move the clock to \`into\` seconds after the start of the next hourly window; that window."""
    ctx.clock.advance(3600 - time.time() % 3600 + into)
    return int(time.time()) // 3600


def _used(ctx, key):
    return int(ctx.redis.get(key) or 0)


def check_atomic_reserve(ctx):
    m = ctx.load("state")
    key = f"budget:acme:{_window(ctx, 10)}"
    ctx.redis.set(key, 1_000_000)

    def other_request():
        # another replica reserving 600 000 characters for the same tenant, between two of this one's commands
        if _used(ctx, key) + 600_000 > CAP:
            return "refused"
        ctx.redis.incrby(key, 600_000)
        return "charged"

    probe = ctx.redis_after(key, other_request)
    mine = m.reserve_budget("acme", 600_000)
    assert probe.fired, f"reserve_budget never touched {key}"
    total = _used(ctx, key)
    assert total <= CAP, f"two reservations of 600 000 on 1 000 000 used both went through: {total} charged against a cap of {CAP}. The read and the charge must be one script"
    assert mine.allowed != (probe.result == "charged"), f"exactly one of the two requests may be charged (this one allowed={mine.allowed}, the other {probe.result})"


def check_fits_whole(ctx):
    m = ctx.load("state")
    key = f"budget:acme:{_window(ctx, 10)}"
    ctx.redis.set(key, 1_900_000)
    res = m.reserve_budget("acme", 200_000)
    assert res.allowed is False, f"with 1 900 000 of 2 000 000 used, a 200 000-character request was allowed: the tenant ends the hour at {_used(ctx, key)}"
    assert _used(ctx, key) == 1_900_000, f"a refused reservation charged the budget: {_used(ctx, key)}, expected 1 900 000"
    assert res.remaining == 100_000, f"a refusal must say what the cap still allows (100 000), got remaining={res.remaining}"
    res = m.reserve_budget("acme", 100_000)
    assert res.allowed is True and res.remaining == 0, f"a request that exactly fits must be allowed with nothing remaining, got {res}"
    assert _used(ctx, key) == CAP, f"the budget holds {_used(ctx, key)}, expected exactly {CAP}"


def check_hourly_window(ctx):
    m = ctx.load("state")
    key = f"budget:acme:{_window(ctx, 1800)}"
    res = m.reserve_budget("acme", 1_000)
    assert res.allowed, f"the first reservation of the hour was refused: {res}"
    ttl = ctx.redis.ttl(key)
    assert 1790 <= ttl <= 1800, f"halfway through the hour {key} has TTL {ttl}, expected the 1800 s left in its window: a key without one outlives its hour"
    res = m.reserve_budget("acme", CAP)
    assert res.allowed is False, "a request over what is left must be refused"
    assert 1790 <= res.retry_after <= 1800, f"halfway through the hour a refusal said retry_after={res.retry_after}, expected the 1800 s until the next window"
    ctx.clock.advance(1800)
    assert ctx.redis.exists(key) == 0, f"{key} outlived its hour"
    res = m.reserve_budget("acme", 1_500_000)
    assert res.allowed, f"a new window starts with the whole budget, got {res}"


def check_reserve_before_detect(ctx):
    ctx.grpc.serve(detector_pb2_grpc.add_DetectorServicer_to_server, Detector())
    m = ctx.load("state")
    window = _window(ctx, 10)
    ctx.redis.set(f"budget:acme:{window}", CAP)
    try:
        m.detect_within_budget("acme", TEXT, ["EMAIL"])
    except m.BudgetExhausted as e:
        assert e.reservation.retry_after > 0, f"a refusal must say when to retry, got {e.reservation}"
    else:
        raise AssertionError("an exhausted tenant got a detection: detect_within_budget must raise BudgetExhausted")
    calls = len(ctx.grpc.calls_to("Detect"))
    assert calls == 0, f"an over-budget tenant cost {calls} detector call(s): reserve first, call the detector only when allowed"
    detection = m.detect_within_budget("globex", TEXT, ["EMAIL"])
    assert [s.entity for s in detection.spans] == ["EMAIL"], f"a tenant within budget gets its detection, got {detection}"
    assert _used(ctx, f"budget:globex:{window}") == len(TEXT), f"the text's {len(TEXT)} characters must be charged to globex, budget holds {_used(ctx, f'budget:globex:{window}')}"
`,
    typescript: `const CAP = 2_000_000;
const TEXT = 'Reach Ada at ada@example.com.';

/** Move the clock to \`into\` seconds after the start of the next hourly window; that window. */
function windowAt(ctx, into: number): number {
  ctx.clock.advance(3600 - ((Date.now() / 1000) % 3600) + into);
  return Math.floor(Date.now() / 1000 / 3600);
}

const used = (ctx, key: string): number => Number(ctx.redis.get(key) ?? 0);

export async function check_atomic_reserve(ctx) {
  const m = ctx.load('state');
  const key = \`budget:acme:\${windowAt(ctx, 10)}\`;
  ctx.redis.set(key, '1000000');
  // another replica reserving 600 000 characters for the same tenant, between two of this one's commands
  const probe = ctx.redisAfter(key, () => {
    if (used(ctx, key) + 600_000 > CAP) return 'refused';
    ctx.redis.incrby(key, 600_000);
    return 'charged';
  });
  const mine = await m.reserveBudget('acme', 600_000);
  assert(probe.fired, \`reserveBudget never touched \${key}\`);
  const total = used(ctx, key);
  assert(total <= CAP, \`two reservations of 600 000 on 1 000 000 used both went through: \${total} charged against a cap of \${CAP}. The read and the charge must be one script\`);
  assert(mine.allowed !== (probe.result === 'charged'), \`exactly one of the two requests may be charged (this one allowed=\${mine.allowed}, the other \${probe.result})\`);
}

export async function check_fits_whole(ctx) {
  const m = ctx.load('state');
  const key = \`budget:acme:\${windowAt(ctx, 10)}\`;
  ctx.redis.set(key, '1900000');
  let res = await m.reserveBudget('acme', 200_000);
  assert.equal(res.allowed, false, \`with 1 900 000 of 2 000 000 used, a 200 000-character request was allowed: the tenant ends the hour at \${used(ctx, key)}\`);
  assert.equal(used(ctx, key), 1_900_000, 'a refused reservation charged the budget');
  assert.equal(res.remaining, 100_000, \`a refusal must say what the cap still allows (100 000), got remaining=\${res.remaining}\`);
  res = await m.reserveBudget('acme', 100_000);
  assert(res.allowed === true && res.remaining === 0, \`a request that exactly fits must be allowed with nothing remaining, got \${JSON.stringify(res)}\`);
  assert.equal(used(ctx, key), CAP, 'the budget must hold exactly the cap');
}

export async function check_hourly_window(ctx) {
  const m = ctx.load('state');
  const key = \`budget:acme:\${windowAt(ctx, 1800)}\`;
  let res = await m.reserveBudget('acme', 1_000);
  assert(res.allowed, \`the first reservation of the hour was refused: \${JSON.stringify(res)}\`);
  const ttl = ctx.redis.ttl(key);
  assert(ttl >= 1790 && ttl <= 1800, \`halfway through the hour \${key} has TTL \${ttl}, expected the 1800 s left in its window: a key without one outlives its hour\`);
  res = await m.reserveBudget('acme', CAP);
  assert.equal(res.allowed, false, 'a request over what is left must be refused');
  assert(res.retryAfter >= 1790 && res.retryAfter <= 1800, \`halfway through the hour a refusal said retryAfter=\${res.retryAfter}, expected the 1800 s until the next window\`);
  ctx.clock.advance(1800);
  assert.equal(ctx.redis.exists(key), 0, \`\${key} outlived its hour\`);
  res = await m.reserveBudget('acme', 1_500_000);
  assert(res.allowed, \`a new window starts with the whole budget, got \${JSON.stringify(res)}\`);
}

export async function check_reserve_before_detect(ctx) {
  const {scan} = ctx.load('/support/redactor/spans.ts');
  const pkg = ctx.proto('detector.proto');
  ctx.grpc.serve(pkg.redactor.Detector.service, {
    Detect(call, callback) {
      const found = scan(call.request.text, call.request.entities ?? []).map(s => ({start: s.start, end: s.end, entity: s.entity}));
      callback(null, {spans: found, model_version: 'ner-2026.10'});
    },
  });
  const m = ctx.load('state');
  const window = windowAt(ctx, 10);
  ctx.redis.set(\`budget:acme:\${window}\`, String(CAP));
  let refused = null;
  try {
    await m.detectWithinBudget('acme', TEXT, ['EMAIL']);
  } catch (e) {
    if (!(e instanceof m.BudgetExhausted)) throw e;
    refused = e;
  }
  assert(refused !== null, 'an exhausted tenant got a detection: detectWithinBudget must throw BudgetExhausted');
  assert(refused.reservation.retryAfter > 0, \`a refusal must say when to retry, got \${JSON.stringify(refused.reservation)}\`);
  const calls = ctx.grpc.callsTo('Detect').length;
  assert.equal(calls, 0, \`an over-budget tenant cost \${calls} detector call(s): reserve first, call the detector only when allowed\`);
  const detection = await m.detectWithinBudget('globex', TEXT, ['EMAIL']);
  assert.deepStrictEqual(detection.spans.map(s => s.entity), ['EMAIL'], \`a tenant within budget gets its detection, got \${JSON.stringify(detection)}\`);
  assert.equal(used(ctx, \`budget:globex:\${window}\`), TEXT.length, \`the text's \${TEXT.length} characters must be charged to globex\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"

	pb "redactor/gen/detector"
	"redactor/spans"

	"leetbuild/harness"
)

const (
	stateCap  = 2_000_000
	stateText = "Reach Ada at ada@example.com."
)

// statePeer is the NER model's stand-in: every requested type a pattern covers, by its pattern.
type statePeer struct {
	pb.UnimplementedDetectorServer
}

func (statePeer) Detect(_ context.Context, req *pb.DetectRequest) (*pb.DetectResponse, error) {
	var found []*pb.EntitySpan
	for _, s := range spans.Scan(req.GetText(), req.GetEntities()) {
		found = append(found, &pb.EntitySpan{Start: int32(s.Start), End: int32(s.End), Entity: s.Entity})
	}
	return &pb.DetectResponse{Spans: found, ModelVersion: "ner-2026.10"}, nil
}

// stateWindow moves the clock to into seconds after the start of the next hourly window and returns that window.
func stateWindow(ctx *harness.Ctx, into float64) int64 {
	now := float64(ctx.Clock.Now()) / 1000
	ctx.Clock.Advance(3600 - math.Mod(now, 3600) + into)
	return ctx.Clock.Now() / 1000 / 3600
}

func stateKey(tenant string, window int64) string { return fmt.Sprintf("budget:%s:%d", tenant, window) }

func stateUsed(ctx *harness.Ctx, key string) int64 {
	v, _ := ctx.Redis.Get(key)
	n, _ := strconv.ParseInt(v, 10, 64)
	return n
}

func stateReserve(ctx *harness.Ctx, tenant string, chars int64) Reservation {
	res, err := reserveBudget(context.Background(), tenant, chars)
	ctx.NoError(err, "reserveBudget(%s, %d)", tenant, chars)
	return res
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	key := stateKey("acme", stateWindow(ctx, 10))
	ctx.Redis.Set(key, 1_000_000)
	other := ""
	// another replica reserving 600 000 characters for the same tenant, between two of this one's commands
	probe := ctx.Redis.After(key, func() any {
		if stateUsed(ctx, key)+600_000 > stateCap {
			other = "refused"
			return nil
		}
		ctx.Redis.Do("INCRBY", key, 600_000)
		other = "charged"
		return nil
	})
	mine := stateReserve(ctx, "acme", 600_000)
	ctx.Assert(probe.Fired, "reserveBudget never touched %s", key)
	total := stateUsed(ctx, key)
	ctx.Assert(total <= stateCap, "two reservations of 600 000 on 1 000 000 used both went through: %d charged against a cap of %d. The read and the charge must be one script", total, stateCap)
	ctx.Assert(mine.Allowed != (other == "charged"), "exactly one of the two requests may be charged (this one allowed=%t, the other %s)", mine.Allowed, other)
}

func CheckFitsWhole(ctx *harness.Ctx) {
	key := stateKey("acme", stateWindow(ctx, 10))
	ctx.Redis.Set(key, 1_900_000)
	res := stateReserve(ctx, "acme", 200_000)
	ctx.Assert(!res.Allowed, "with 1 900 000 of 2 000 000 used, a 200 000-character request was allowed: the tenant ends the hour at %d", stateUsed(ctx, key))
	ctx.Equal(stateUsed(ctx, key), 1_900_000, "a refused reservation must charge nothing; the budget")
	ctx.Equal(res.Remaining, 100_000, "a refusal must say what the cap still allows; remaining")
	res = stateReserve(ctx, "acme", 100_000)
	ctx.Assert(res.Allowed && res.Remaining == 0, "a request that exactly fits must be allowed with nothing remaining, got %+v", res)
	ctx.Equal(stateUsed(ctx, key), stateCap, "the budget must hold exactly the cap")
}

func CheckHourlyWindow(ctx *harness.Ctx) {
	key := stateKey("acme", stateWindow(ctx, 1800))
	res := stateReserve(ctx, "acme", 1_000)
	ctx.Assert(res.Allowed, "the first reservation of the hour was refused: %+v", res)
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(ttl >= 1790 && ttl <= 1800, "halfway through the hour %s has TTL %d, expected the 1800 s left in its window: a key without one outlives its hour", key, ttl)
	res = stateReserve(ctx, "acme", stateCap)
	ctx.Assert(!res.Allowed, "a request over what is left must be refused")
	ctx.Assert(res.RetryAfter >= 1790 && res.RetryAfter <= 1800, "halfway through the hour a refusal said RetryAfter=%d, expected the 1800 s until the next window", res.RetryAfter)
	ctx.Clock.Advance(1800)
	ctx.Equal(ctx.Redis.Exists(key), 0, "%s outlived its hour; it exists", key)
	res = stateReserve(ctx, "acme", 1_500_000)
	ctx.Assert(res.Allowed, "a new window starts with the whole budget, got %+v", res)
}

func CheckReserveBeforeDetect(ctx *harness.Ctx) {
	pb.RegisterDetectorServer(ctx.GRPC.Server(""), statePeer{})
	window := stateWindow(ctx, 10)
	ctx.Redis.Set(stateKey("acme", window), stateCap)
	_, err := detectWithinBudget(context.Background(), "acme", stateText, []string{"EMAIL"})
	var exhausted *BudgetExhausted
	ctx.Assert(errors.As(err, &exhausted), "an exhausted tenant must get a *BudgetExhausted, got %v", err)
	ctx.Assert(exhausted.Reservation.RetryAfter > 0, "a refusal must say when to retry, got %+v", exhausted.Reservation)
	calls := len(ctx.GRPC.CallsTo("Detect", ""))
	ctx.Equal(calls, 0, "an over-budget tenant must not cost a detector call: reserve first; Detect calls")
	detection, err := detectWithinBudget(context.Background(), "globex", stateText, []string{"EMAIL"})
	ctx.NoError(err, "a tenant within budget")
	ctx.Assert(len(detection.Spans) == 1 && detection.Spans[0].Entity == "EMAIL", "a tenant within budget gets its detection, got %+v", detection)
	ctx.Equal(stateUsed(ctx, stateKey("globex", window)), len(stateText), "the text's characters must be charged to globex; the budget")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <string>

#include "detector.grpc.pb.h"

namespace {

constexpr long long kCap = 2000000;
const std::string kText = "Reach Ada at ada@example.com.";

// The NER model's stand-in: every requested type a pattern covers, by its pattern.
class DetectorPeer final : public redactor::Detector::Service {
 public:
  grpc::Status Detect(grpc::ServerContext*, const redactor::DetectRequest* req, redactor::DetectResponse* out) override {
    for (const spans::Span& s : spans::scan(req->text(), {req->entities().begin(), req->entities().end()})) {
      redactor::EntitySpan* found = out->add_spans();
      found->set_start(s.start);
      found->set_end(s.end);
      found->set_entity(s.entity);
    }
    out->set_model_version("ner-2026.10");
    return grpc::Status::OK;
  }
};

// Move the clock to into seconds after the start of the next hourly window; that window.
long long window_at(harness::Ctx& ctx, double into) {
  const double now = static_cast<double>(ctx.Clock.Now()) / 1000;
  ctx.Clock.Advance(3600 - std::fmod(now, 3600) + into);
  return ctx.Clock.Now() / 1000 / 3600;
}

std::string key_of(const std::string& tenant, long long window) { return "budget:" + tenant + ":" + std::to_string(window); }

long long used(harness::Ctx& ctx, const std::string& key) {
  const auto v = ctx.Redis.Get(key);
  return v ? std::stoll(*v) : 0;
}

}  // namespace

void CheckAtomicReserve(harness::Ctx& ctx) {
  const std::string key = key_of("acme", window_at(ctx, 10));
  ctx.Redis.Set(key, 1000000);
  std::string other;
  // another replica reserving 600 000 characters for the same tenant, between two of this one's commands
  ctx.Redis.After(key, [&] {
    if (used(ctx, key) + 600000 > kCap) {
      other = "refused";
      return;
    }
    ctx.Redis.Do("INCRBY", key, 600000);
    other = "charged";
  });
  const Reservation mine = reserve_budget("acme", 600000);
  ctx.Assert(!other.empty(), "reserve_budget never touched %s", key);
  const long long total = used(ctx, key);
  ctx.Assert(total <= kCap, "two reservations of 600 000 on 1 000 000 used both went through: %d charged against a cap of %d. The read and the charge must be one script", total, kCap);
  ctx.Assert(mine.allowed != (other == "charged"), "exactly one of the two requests may be charged (this one allowed=%t, the other %s)", mine.allowed, other);
}

void CheckFitsWhole(harness::Ctx& ctx) {
  const std::string key = key_of("acme", window_at(ctx, 10));
  ctx.Redis.Set(key, 1900000);
  Reservation res = reserve_budget("acme", 200000);
  ctx.Assert(!res.allowed, "with 1 900 000 of 2 000 000 used, a 200 000-character request was allowed: the tenant ends the hour at %d", used(ctx, key));
  ctx.Equal(used(ctx, key), 1900000, "a refused reservation must charge nothing; the budget");
  ctx.Equal(res.remaining, 100000, "a refusal must say what the cap still allows; remaining");
  res = reserve_budget("acme", 100000);
  ctx.Assert(res.allowed && res.remaining == 0, "a request that exactly fits must be allowed with nothing remaining, got allowed=%t remaining=%d", res.allowed, res.remaining);
  ctx.Equal(used(ctx, key), kCap, "the budget must hold exactly the cap");
}

void CheckHourlyWindow(harness::Ctx& ctx) {
  const std::string key = key_of("acme", window_at(ctx, 1800));
  Reservation res = reserve_budget("acme", 1000);
  ctx.Assert(res.allowed, "the first reservation of the hour was refused");
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl >= 1790 && ttl <= 1800, "halfway through the hour %s has TTL %d, expected the 1800 s left in its window: a key without one outlives its hour", key, ttl);
  res = reserve_budget("acme", kCap);
  ctx.Assert(!res.allowed, "a request over what is left must be refused");
  ctx.Assert(res.retry_after >= 1790 && res.retry_after <= 1800, "halfway through the hour a refusal said retry_after=%d, expected the 1800 s until the next window", res.retry_after);
  ctx.Clock.Advance(1800);
  ctx.Equal(ctx.Redis.Exists(key), 0, "%s outlived its hour; it exists", key);
  res = reserve_budget("acme", 1500000);
  ctx.Assert(res.allowed, "a new window starts with the whole budget");
}

void CheckReserveBeforeDetect(harness::Ctx& ctx) {
  static DetectorPeer* peer = nullptr;
  delete peer;
  peer = new DetectorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  const long long window = window_at(ctx, 10);
  ctx.Redis.Set(key_of("acme", window), kCap);
  bool refused = false;
  try {
    detect_within_budget("acme", kText, {"EMAIL"});
  } catch (const BudgetExhausted& e) {
    refused = true;
    ctx.Assert(e.reservation.retry_after > 0, "a refusal must say when to retry, got retry_after=%d", e.reservation.retry_after);
  }
  ctx.Assert(refused, "an exhausted tenant got a detection: detect_within_budget must throw BudgetExhausted");
  ctx.Equal(ctx.GRPC.CallsTo("Detect").size(), 0, "an over-budget tenant must not cost a detector call: reserve first; Detect calls");
  const spans::Detection detection = detect_within_budget("globex", kText, {"EMAIL"});
  ctx.Assert(detection.spans.size() == 1 && detection.spans[0].entity == "EMAIL", "a tenant within budget gets its detection, got %d span(s)", detection.spans.size());
  ctx.Equal(used(ctx, key_of("globex", window)), kText.size(), "the text's characters must be charged to globex; the budget");
}
`,
  },
  hints: [
    'Fire two large requests for one tenant at once near the end of its hour: both go through and the hour ends over budget. A refusal halfway through the hour says to come back in 3600 seconds.',
    'The count is read with `GET` and charged with `INCRBY` in a second round trip, compared alone against the cap, and given no TTL; `retry_after` is the constant `WINDOW_S`, and `detect` runs before the reservation.',
    'Move the read, the `used + chars > cap` test, `INCRBY` and the first-write `EXPIRE` into one `RESERVE_LUA` script; compute `seconds_left = WINDOW_S - now % WINDOW_S` and answer it as `retry_after`; call `reserve_budget` before `detect`.',
  ],
  debrief: `The script is the unit of atomicity Redis offers: the read, the comparison and the charge run with no other command between them, which is what makes "both requests saw room" impossible. Comparing \`used + chars\` rather than \`used\` is the difference between a cap and a suggestion, and charging nothing on a refusal keeps a rejected burst from eating the next request's room. The TTL ties the key's life to its window, so the keyspace holds one hour per tenant, and the seconds left are the honest \`Retry-After\`. Reserving before the model call puts the cheap decision in front of the expensive one. Production meters refund a reservation the detector did not use and keep a sliding window, so a tenant cannot spend two hours of budget across a window boundary.`,
};
