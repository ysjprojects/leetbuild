import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis: a one-time captcha and a limit on form and address',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the abuse path a submission passes before the endpoint stores
it: \`consume_captcha(token)\` reads \`captcha:{token}\` and then deletes it, and
\`reserve(form_id, ip)\` reads the counter \`limit:ip:{ip}\`, compares it with \`IP_LIMIT\` and
increments it, answering \`{allowed, remaining, retry_after}\`. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** Two parallel replays of one captcha both pass; a botnet sweeps
one form from a thousand addresses; the first busy minute blocks an address forever; two parallel
requests at the limit both get through; and a refused client is told to wait longer than it must.

- A token is consumed by **one command**: \`GETDEL captcha:{token}\`; it passes only if it was there.
- A submission is limited per window of \`WINDOW_S\` = 60 s on **two dimensions**, \`FORM_LIMIT\` = 20
  per form and \`IP_LIMIT\` = 5 per address, under \`limit:form:{form_id}:{window}\` and
  \`limit:ip:{ip}:{window}\` with \`window = floor(now / WINDOW_S)\`; both keys expire with it.
- One **Lua script** checks both counters and increments both only when both have room, so a refused
  request spends nothing.
- \`remaining\` is the smaller room left; a refusal's \`retry_after\` is the seconds until the window
  ends.`,
  sequence: {
    participants: ['Form API', 'Redis'],
    messages: [
      {from: 'Form API', to: 'Redis', label: 'GETDEL captcha:{token}', kind: 'sync'},
      {from: 'Redis', to: 'Form API', label: 'the token once · nil for every replay', kind: 'reply'},
      {
        from: 'Form API',
        to: 'Redis',
        label: 'EVAL reserve limit:form:{id}:{window} limit:ip:{ip}:{window}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Form API', label: '{allowed, remaining} · both incremented or neither', kind: 'reply'},
      {from: 'Form API', to: 'Form API', label: 'retry_after = WINDOW_S - now % WINDOW_S', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'captcha-once',
      title: 'Consumes a captcha token in one command',
      detail:
        'The token is read and removed by one `GETDEL` (or a Lua script), so of two parallel replays exactly one passes. The starter `GET`s and then `DEL`s: a replay landing between the two also passes.',
      match: {
        python: {all: [/\.getdel\(|["']GETDEL["']/], none: [/\.delete\(/]},
        typescript: {all: [/\.getdel\(|['"]GETDEL['"]/], none: [/redis\.del\(/]},
        go: {all: [/\.GetDel\(|"GETDEL"/], none: [/rdb\.Del\(/]},
        scala: {all: [/\.getDel\(|"GETDEL"/], none: [/jedis\.del\(/]},
        cpp: {all: [/\.getdel\(|"GETDEL"/], none: [/redis\.del\(/]},
      },
    },
    {
      id: 'both-dimensions',
      title: 'Limits per form and per address',
      detail:
        'A form takes at most `FORM_LIMIT` submissions per window across all addresses, an address at most `IP_LIMIT`, and a refused request spends neither budget. The starter counts the address only.',
      match: {
        python: {all: [/limit:form:/, /limit:ip:/]},
        typescript: {all: [/limit:form:/, /limit:ip:/]},
        go: {all: [/limit:form:/, /limit:ip:/]},
        scala: {all: [/limit:form:/, /limit:ip:/]},
        cpp: {all: [/limit:form:/, /limit:ip:/]},
      },
    },
    {
      id: 'window-bucket',
      title: 'Keys carry the window and expire with it',
      detail:
        'The counters are `limit:…:{window}` with `window = floor(now / WINDOW_S)`, and the script sets an `EXPIRE`, so the next minute starts from zero and old keys go away. The starter’s counter has no window and no TTL.',
      match: {
        python: {all: [/\/\/\s*WINDOW_S/, /EXPIRE/]},
        typescript: {all: [/\/\s*WINDOW_S/, /EXPIRE/]},
        go: {all: [/\/\s*windowSeconds/, /EXPIRE/]},
        scala: {all: [/\/\s*WindowSeconds/, /EXPIRE/]},
        cpp: {all: [/\/\s*kWindowSeconds/, /EXPIRE/]},
      },
    },
    {
      id: 'atomic-reserve',
      title: 'Reserves both counters in one Lua script',
      detail:
        'The check and the increments run in one script (`register_script`/`defineCommand`/`NewScript`/`eval`), so a parallel request cannot land between them. The starter reads, compares and `INCR`s in three round trips.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/\br\.incr\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/redis\.incr\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/rdb\.Incr\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/jedis\.incr\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]INCR['"]/], none: [/redis\.incr\(/]},
      },
    },
    {
      id: 'retry-after',
      title: 'Retry-after counts down to the window’s end',
      detail:
        'A refusal reports `retry_after = WINDOW_S - now % WINDOW_S`, the seconds until the counters reset. The starter always answers 60.',
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

WINDOW_S = 60
FORM_LIMIT = 20
IP_LIMIT = 5


def consume_captcha(token: str) -> bool:
    """True once for a token the captcha widget issued: this call uses it up."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    key = f"captcha:{token}"
    if r.get(key) is None:
        return False
    r.delete(key)
    return True


def reserve(form_id: str, ip: str) -> dict:
    """One submission's slot in the current window: allowed, remaining, retry_after (seconds)."""
    key = f"limit:ip:{ip}"
    used = int(r.get(key) or 0)
    if used >= IP_LIMIT:
        return {"allowed": False, "remaining": 0, "retry_after": WINDOW_S}
    used = r.incr(key)
    return {"allowed": True, "remaining": IP_LIMIT - used, "retry_after": 0}
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
FORM_LIMIT = 20
IP_LIMIT = 5

# Both counters are checked, and both incremented, or neither: a refused request spends nothing.
RESERVE_LUA = """
local form = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip = tonumber(redis.call('GET', KEYS[2]) or '0')
local allowed = 0
if form < tonumber(ARGV[1]) and ip < tonumber(ARGV[2]) then
  form = redis.call('INCR', KEYS[1])
  ip = redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
  allowed = 1
end
local remaining = tonumber(ARGV[1]) - form
if tonumber(ARGV[2]) - ip < remaining then remaining = tonumber(ARGV[2]) - ip end
return {allowed, remaining}
"""
reserve_script = r.register_script(RESERVE_LUA)


def consume_captcha(token: str) -> bool:
    """True once for a token the captcha widget issued: this call uses it up."""
    # One command reads and removes it: a parallel replay finds nothing.
    return r.getdel(f"captcha:{token}") is not None


def reserve(form_id: str, ip: str) -> dict:
    """One submission's slot in the current window: allowed, remaining, retry_after (seconds)."""
    now = int(time.time())
    window = now // WINDOW_S
    keys = [f"limit:form:{form_id}:{window}", f"limit:ip:{ip}:{window}"]
    allowed, remaining = reserve_script(keys=keys, args=[FORM_LIMIT, IP_LIMIT, WINDOW_S])
    retry_after = 0 if allowed else WINDOW_S - now % WINDOW_S
    return {"allowed": allowed == 1, "remaining": remaining, "retry_after": retry_after}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const WINDOW_S = 60;
export const FORM_LIMIT = 20;
export const IP_LIMIT = 5;

export interface Reservation {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/** True once for a token the captcha widget issued: this call uses it up. */
export async function consumeCaptcha(token: string): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const key = \`captcha:\${token}\`;
  if ((await redis.get(key)) === null) return false;
  await redis.del(key);
  return true;
}

/** One submission's slot in the current window. */
export async function reserve(formId: string, ip: string): Promise<Reservation> {
  const key = \`limit:ip:\${ip}\`;
  const used = Number((await redis.get(key)) ?? 0);
  if (used >= IP_LIMIT) return {allowed: false, remaining: 0, retryAfter: WINDOW_S};
  const now = await redis.incr(key);
  return {allowed: true, remaining: IP_LIMIT - now, retryAfter: 0};
}
`,
      solution: `import Redis from 'ioredis';

export const WINDOW_S = 60;
export const FORM_LIMIT = 20;
export const IP_LIMIT = 5;

// Both counters are checked, and both incremented, or neither: a refused request spends nothing.
export const RESERVE_LUA = \`
local form = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip = tonumber(redis.call('GET', KEYS[2]) or '0')
local allowed = 0
if form < tonumber(ARGV[1]) and ip < tonumber(ARGV[2]) then
  form = redis.call('INCR', KEYS[1])
  ip = redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
  allowed = 1
end
local remaining = tonumber(ARGV[1]) - form
if tonumber(ARGV[2]) - ip < remaining then remaining = tonumber(ARGV[2]) - ip end
return {allowed, remaining}
\`;

interface LimitRedis extends Redis {
  reserveSlot(formKey: string, ipKey: string, formLimit: number, ipLimit: number, ttl: number): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LimitRedis;
redis.defineCommand('reserveSlot', {numberOfKeys: 2, lua: RESERVE_LUA});

export interface Reservation {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/** True once for a token the captcha widget issued: this call uses it up. */
export async function consumeCaptcha(token: string): Promise<boolean> {
  // One command reads and removes it: a parallel replay finds nothing.
  return (await redis.getdel(\`captcha:\${token}\`)) !== null;
}

/** One submission's slot in the current window. */
export async function reserve(formId: string, ip: string): Promise<Reservation> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_S);
  const [allowed, remaining] = await redis.reserveSlot(\`limit:form:\${formId}:\${window}\`, \`limit:ip:\${ip}:\${window}\`, FORM_LIMIT, IP_LIMIT, WINDOW_S);
  return {allowed: allowed === 1, remaining, retryAfter: allowed === 1 ? 0 : WINDOW_S - (now % WINDOW_S)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowSeconds = 60
	formLimit     = 20
	ipLimit       = 5
)

// Reservation is one submission's slot in the current window.
type Reservation struct {
	Allowed    bool
	Remaining  int64
	RetryAfter int64 // seconds
}

// consumeCaptcha is true once for a token the captcha widget issued: this call uses it up.
func consumeCaptcha(ctx context.Context, token string) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	key := "captcha:" + token
	err := rdb.Get(ctx, key).Err()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, rdb.Del(ctx, key).Err()
}

func reserve(ctx context.Context, formID, ip string) (Reservation, error) {
	key := "limit:ip:" + ip
	used, err := rdb.Get(ctx, key).Int64()
	if err != nil && err != redis.Nil {
		return Reservation{}, err
	}
	if used >= ipLimit {
		return Reservation{Allowed: false, RetryAfter: windowSeconds}, nil
	}
	used, err = rdb.Incr(ctx, key).Result()
	return Reservation{Allowed: true, Remaining: ipLimit - used}, err
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowSeconds = 60
	formLimit     = 20
	ipLimit       = 5
)

// reserveScript checks both counters and increments both, or neither: a refused request spends nothing.
var reserveScript = redis.NewScript(\`
local form = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip = tonumber(redis.call('GET', KEYS[2]) or '0')
local allowed = 0
if form < tonumber(ARGV[1]) and ip < tonumber(ARGV[2]) then
  form = redis.call('INCR', KEYS[1])
  ip = redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
  allowed = 1
end
local remaining = tonumber(ARGV[1]) - form
if tonumber(ARGV[2]) - ip < remaining then remaining = tonumber(ARGV[2]) - ip end
return {allowed, remaining}
\`)

// Reservation is one submission's slot in the current window.
type Reservation struct {
	Allowed    bool
	Remaining  int64
	RetryAfter int64 // seconds
}

// consumeCaptcha is true once for a token the captcha widget issued: this call uses it up.
func consumeCaptcha(ctx context.Context, token string) (bool, error) {
	// One command reads and removes it: a parallel replay finds nothing.
	err := rdb.GetDel(ctx, "captcha:"+token).Err()
	if err == redis.Nil {
		return false, nil
	}
	return err == nil, err
}

func reserve(ctx context.Context, formID, ip string) (Reservation, error) {
	now := time.Now().Unix()
	window := now / windowSeconds
	keys := []string{fmt.Sprintf("limit:form:%s:%d", formID, window), fmt.Sprintf("limit:ip:%s:%d", ip, window)}
	reply, err := reserveScript.Run(ctx, rdb, keys, formLimit, ipLimit, windowSeconds).Int64Slice()
	if err != nil {
		return Reservation{}, err
	}
	if reply[0] == 1 {
		return Reservation{Allowed: true, Remaining: reply[1]}, nil
	}
	return Reservation{Allowed: false, Remaining: reply[1], RetryAfter: windowSeconds - now%windowSeconds}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

/** One submission's slot in the current window; retryAfter in seconds. */
final case class Reservation(allowed: Boolean, remaining: Long, retryAfter: Long)

object Abuse {
  val WindowSeconds = 60L
  val FormLimit = 20L
  val IpLimit = 5L

  private val jedis = new JedisPooled("redis", 6379)

  /** True once for a token the captcha widget issued: this call uses it up. */
  def consumeCaptcha(token: String): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val key = s"captcha:$token"
    if (jedis.get(key) == null) false
    else {
      jedis.del(key)
      true
    }
  }

  def reserve(formId: String, ip: String): Reservation = {
    val key = s"limit:ip:$ip"
    val used = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (used >= IpLimit) Reservation(allowed = false, 0L, WindowSeconds)
    else {
      val now = jedis.incr(key)
      Reservation(allowed = true, IpLimit - now, 0L)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** One submission's slot in the current window; retryAfter in seconds. */
final case class Reservation(allowed: Boolean, remaining: Long, retryAfter: Long)

object Abuse {
  val WindowSeconds = 60L
  val FormLimit = 20L
  val IpLimit = 5L

  /** Both counters are checked, and both incremented, or neither: a refused request spends nothing. */
  val ReserveLua: String =
    """local form = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local ip = tonumber(redis.call('GET', KEYS[2]) or '0')
      |local allowed = 0
      |if form < tonumber(ARGV[1]) and ip < tonumber(ARGV[2]) then
      |  form = redis.call('INCR', KEYS[1])
      |  ip = redis.call('INCR', KEYS[2])
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |  redis.call('EXPIRE', KEYS[2], ARGV[3])
      |  allowed = 1
      |end
      |local remaining = tonumber(ARGV[1]) - form
      |if tonumber(ARGV[2]) - ip < remaining then remaining = tonumber(ARGV[2]) - ip end
      |return {allowed, remaining}
      |""".stripMargin

  private val jedis = new JedisPooled("redis", 6379)

  /** True once for a token the captcha widget issued: this call uses it up. */
  def consumeCaptcha(token: String): Boolean =
    jedis.getDel(s"captcha:$token") != null // one command reads and removes it: a parallel replay finds nothing

  def reserve(formId: String, ip: String): Reservation = {
    val now = System.currentTimeMillis() / 1000
    val window = now / WindowSeconds
    val keys = List(s"limit:form:$formId:$window", s"limit:ip:$ip:$window").asJava
    val args = List(FormLimit, IpLimit, WindowSeconds).map(_.toString).asJava
    val reply = jedis.eval(ReserveLua, keys, args).asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    if (reply.head == 1L) Reservation(allowed = true, reply(1), 0L)
    else Reservation(allowed = false, reply(1), WindowSeconds - now % WindowSeconds)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowSeconds = 60;
constexpr long long kFormLimit = 20;
constexpr long long kIpLimit = 5;

// One submission's slot in the current window; retry_after in seconds.
struct Reservation {
  bool allowed = false;
  long long remaining = 0;
  long long retry_after = 0;
};

// True once for a token the captcha widget issued: this call uses it up.
bool consumeCaptcha(const std::string& token) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string key = "captcha:" + token;
  if (!redis.get(key)) return false;
  redis.del(key);
  return true;
}

Reservation reserve(const std::string& form_id, const std::string& ip) {
  const std::string key = "limit:ip:" + ip;
  const auto used = redis.get(key);
  if (used && std::stoll(*used) >= kIpLimit) return {false, 0, kWindowSeconds};
  const long long now = redis.incr(key);
  return {true, kIpLimit - now, 0};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowSeconds = 60;
constexpr long long kFormLimit = 20;
constexpr long long kIpLimit = 5;

// Both counters are checked, and both incremented, or neither: a refused request spends nothing.
const std::string kReserveLua = R"lua(
local form = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip = tonumber(redis.call('GET', KEYS[2]) or '0')
local allowed = 0
if form < tonumber(ARGV[1]) and ip < tonumber(ARGV[2]) then
  form = redis.call('INCR', KEYS[1])
  ip = redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
  allowed = 1
end
local remaining = tonumber(ARGV[1]) - form
if tonumber(ARGV[2]) - ip < remaining then remaining = tonumber(ARGV[2]) - ip end
return {allowed, remaining}
)lua";

// One submission's slot in the current window; retry_after in seconds.
struct Reservation {
  bool allowed = false;
  long long remaining = 0;
  long long retry_after = 0;
};

// True once for a token the captcha widget issued: this call uses it up.
bool consumeCaptcha(const std::string& token) {
  // One command reads and removes it: a parallel replay finds nothing.
  return static_cast<bool>(redis.getdel("captcha:" + token));
}

Reservation reserve(const std::string& form_id, const std::string& ip) {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long window = now / kWindowSeconds;
  const std::string form_key = "limit:form:" + form_id + ":" + std::to_string(window);
  const std::string ip_key = "limit:ip:" + ip + ":" + std::to_string(window);
  std::vector<long long> reply;
  redis.eval(kReserveLua, {form_key, ip_key}, {std::to_string(kFormLimit), std::to_string(kIpLimit), std::to_string(kWindowSeconds)},
             std::back_inserter(reply));
  if (reply.at(0) == 1) return {true, reply.at(1), 0};
  return {false, reply.at(1), kWindowSeconds - now % kWindowSeconds};
}
`,
    },
  },
  harness: {
    python: `WINDOW_S = 60


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_captcha_once(ctx):
    m = ctx.load("state")
    ctx.redis.set("captcha:t-1", "1")
    # A second tab replays the same token while the first request is consuming it.
    rival = ctx.redis_after("captcha:t-1", lambda: m.consume_captcha("t-1"))
    first = m.consume_captcha("t-1")
    second = _settled(rival, "captcha:t-1")
    assert [first, second].count(True) == 1, f"two parallel replays of one captcha token answered {first} and {second}: the replay landed between the GET and the DEL. Consume it with one GETDEL"
    assert ctx.redis.exists("captcha:t-1") == 0, "the token is still in Redis after it was used"
    assert m.consume_captcha("t-1") is False, "a used token passed again"
    assert m.consume_captcha("never-issued") is False, "a token nobody issued passed"


def check_both_dimensions(ctx):
    m = ctx.load("state")
    allowed = sum(1 for i in range(25) if m.reserve("f-1", f"10.0.0.{i}")["allowed"])
    assert allowed == 20, f"25 submissions to form f-1 from 25 addresses: {allowed} allowed, expected FORM_LIMIT = 20 per window. A botnet sweeps one form from many addresses"
    tries = [m.reserve("f-2", "10.9.9.9")["allowed"] for _ in range(8)]
    assert tries == [True] * 5 + [False] * 3, f"eight submissions to f-2 from one address answered {tries}, expected five allowed (IP_LIMIT = 5), then refused"
    others = sum(1 for i in range(20) if m.reserve("f-2", f"10.1.0.{i}")["allowed"])
    assert others == 15, f"after 5 allowed and 3 refused from 10.9.9.9, f-2 let {others} of 20 other addresses in, expected its 15 remaining slots: a refused request must not spend the form's budget"


def check_window_bucket(ctx):
    m = ctx.load("state")
    for _ in range(5):
        m.reserve("f-1", "10.0.0.1")
    assert m.reserve("f-1", "10.0.0.1")["allowed"] is False, "the sixth submission from one address in a window must be refused (IP_LIMIT = 5)"
    keys = sorted(ctx.redis.keys("limit:*"))
    assert keys, "reserve wrote no limit:* key"
    for key in keys:
        ttl = ctx.redis.ttl(key)
        assert 0 < ttl <= 2 * WINDOW_S, f"{key} has TTL {ttl}: a limit key must expire with its window, or one busy minute blocks the address forever"
    window = int(ctx.clock.time()) // WINDOW_S
    assert f"limit:ip:10.0.0.1:{window}" in keys and f"limit:form:f-1:{window}" in keys, f"the limit keys are {keys}, expected the window in their names: limit:form:f-1:{window} and limit:ip:10.0.0.1:{window}"
    ctx.clock.advance(WINDOW_S)
    assert m.reserve("f-1", "10.0.0.1")["allowed"] is True, "a minute later the address must be allowed again: the next window has keys of its own"


def check_atomic_reserve(ctx):
    m = ctx.load("state")
    for _ in range(4):
        assert m.reserve("f-1", "10.0.0.1")["allowed"] is True, "the first four submissions from one address must be allowed"
    window = int(ctx.clock.time()) // WINDOW_S
    # A second request from the same address lands while this one is reserving the fifth slot.
    probes = [ctx.redis_after(key, lambda: m.reserve("f-1", "10.0.0.1")) for key in ("limit:ip:10.0.0.1", f"limit:ip:10.0.0.1:{window}")]
    mine = m.reserve("f-1", "10.0.0.1")
    fired = [p for p in probes if p.fired]
    assert fired, "reserve never touched the address's counter"
    rival = _settled(fired[0], "the address's counter")
    both = [mine["allowed"], rival["allowed"]]
    assert both.count(True) == 1, f"with 4 of 5 slots used, two parallel submissions answered allowed={both}: the read, the comparison and the INCR are separate round trips and the other request landed between them. Reserve in one Lua script"
    assert m.reserve("f-1", "10.0.0.1")["allowed"] is False, "the address's sixth submission must be refused"


def check_retry_after(ctx):
    m = ctx.load("state")
    ctx.clock.advance((45 - ctx.clock.time() % WINDOW_S) % WINDOW_S)
    left = WINDOW_S - int(ctx.clock.time()) % WINDOW_S
    for expected in (4, 3, 2, 1, 0):
        got = m.reserve("f-1", "10.0.0.1")
        assert got["allowed"] is True and got["remaining"] == expected, f"a submission with {expected + 1} slots left answered {got}, expected allowed with remaining {expected}"
    refused = m.reserve("f-1", "10.0.0.1")
    assert refused["allowed"] is False, f"the sixth submission in a window answered {refused}, expected a refusal"
    assert refused["retry_after"] == left, f"the refusal says retry_after {refused['retry_after']} s, but this window ends in {left} s: the client waits longer than it must"
`,
    typescript: `const WINDOW_S = 60;

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

const nowS = (ctx): number => Math.floor(ctx.clock.now() / 1000);

export async function check_captcha_once(ctx) {
  const m = ctx.load('state');
  ctx.redis.set('captcha:t-1', '1');
  // A second tab replays the same token while the first request is consuming it.
  const rival = ctx.redisAfter('captcha:t-1', () => m.consumeCaptcha('t-1'));
  const first = await m.consumeCaptcha('t-1');
  const second = await settled(rival, 'captcha:t-1');
  assert.equal([first, second].filter(Boolean).length, 1, \`two parallel replays of one captcha token answered \${first} and \${second}: the replay landed between the GET and the DEL. Consume it with one GETDEL\`);
  assert.equal(ctx.redis.exists('captcha:t-1'), 0, 'the token is still in Redis after it was used');
  assert.equal(await m.consumeCaptcha('t-1'), false, 'a used token passed again');
  assert.equal(await m.consumeCaptcha('never-issued'), false, 'a token nobody issued passed');
}

export async function check_both_dimensions(ctx) {
  const m = ctx.load('state');
  let allowed = 0;
  for (let i = 0; i < 25; i++) if ((await m.reserve('f-1', \`10.0.0.\${i}\`)).allowed) allowed++;
  assert.equal(allowed, 20, \`25 submissions to form f-1 from 25 addresses: \${allowed} allowed, expected FORM_LIMIT = 20 per window. A botnet sweeps one form from many addresses\`);
  const tries: boolean[] = [];
  for (let i = 0; i < 8; i++) tries.push((await m.reserve('f-2', '10.9.9.9')).allowed);
  assert.deepEqual(tries, [true, true, true, true, true, false, false, false], \`eight submissions to f-2 from one address answered \${JSON.stringify(tries)}, expected five allowed (IP_LIMIT = 5), then refused\`);
  let others = 0;
  for (let i = 0; i < 20; i++) if ((await m.reserve('f-2', \`10.1.0.\${i}\`)).allowed) others++;
  assert.equal(others, 15, \`after 5 allowed and 3 refused from 10.9.9.9, f-2 let \${others} of 20 other addresses in, expected its 15 remaining slots: a refused request must not spend the form's budget\`);
}

export async function check_window_bucket(ctx) {
  const m = ctx.load('state');
  for (let i = 0; i < 5; i++) await m.reserve('f-1', '10.0.0.1');
  assert.equal((await m.reserve('f-1', '10.0.0.1')).allowed, false, 'the sixth submission from one address in a window must be refused (IP_LIMIT = 5)');
  const keys = (ctx.redis.keys('limit:*') as string[]).sort();
  assert(keys.length > 0, 'reserve wrote no limit:* key');
  for (const key of keys) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl > 0 && ttl <= 2 * WINDOW_S, \`\${key} has TTL \${ttl}: a limit key must expire with its window, or one busy minute blocks the address forever\`);
  }
  const window = Math.floor(nowS(ctx) / WINDOW_S);
  assert(keys.includes(\`limit:ip:10.0.0.1:\${window}\`) && keys.includes(\`limit:form:f-1:\${window}\`), \`the limit keys are \${JSON.stringify(keys)}, expected the window in their names: limit:form:f-1:\${window} and limit:ip:10.0.0.1:\${window}\`);
  ctx.clock.advance(WINDOW_S);
  assert.equal((await m.reserve('f-1', '10.0.0.1')).allowed, true, 'a minute later the address must be allowed again: the next window has keys of its own');
}

export async function check_atomic_reserve(ctx) {
  const m = ctx.load('state');
  for (let i = 0; i < 4; i++) assert.equal((await m.reserve('f-1', '10.0.0.1')).allowed, true, 'the first four submissions from one address must be allowed');
  const window = Math.floor(nowS(ctx) / WINDOW_S);
  // A second request from the same address lands while this one is reserving the fifth slot.
  const probes = ['limit:ip:10.0.0.1', \`limit:ip:10.0.0.1:\${window}\`].map(key => ctx.redisAfter(key, () => m.reserve('f-1', '10.0.0.1')));
  const mine = await m.reserve('f-1', '10.0.0.1');
  const fired = probes.filter(p => p.fired);
  assert(fired.length > 0, "reserve never touched the address's counter");
  const rival = await settled(fired[0], "the address's counter");
  const both = [mine.allowed, rival.allowed];
  assert.equal(both.filter(Boolean).length, 1, \`with 4 of 5 slots used, two parallel submissions answered allowed=\${JSON.stringify(both)}: the read, the comparison and the INCR are separate round trips and the other request landed between them. Reserve in one Lua script\`);
  assert.equal((await m.reserve('f-1', '10.0.0.1')).allowed, false, "the address's sixth submission must be refused");
}

export async function check_retry_after(ctx) {
  const m = ctx.load('state');
  ctx.clock.advance((((45 - (nowS(ctx) % WINDOW_S)) % WINDOW_S) + WINDOW_S) % WINDOW_S);
  const left = WINDOW_S - (nowS(ctx) % WINDOW_S);
  for (const expected of [4, 3, 2, 1, 0]) {
    const got = await m.reserve('f-1', '10.0.0.1');
    assert(got.allowed === true && got.remaining === expected, \`a submission with \${expected + 1} slots left answered \${JSON.stringify(got)}, expected allowed with remaining \${expected}\`);
  }
  const refused = await m.reserve('f-1', '10.0.0.1');
  assert.equal(refused.allowed, false, \`the sixth submission in a window answered \${JSON.stringify(refused)}, expected a refusal\`);
  assert.equal(refused.retryAfter, left, \`the refusal says retryAfter \${refused.retryAfter} s, but this window ends in \${left} s: the client waits longer than it must\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"

	"leetbuild/harness"
)

const stateWindow = 60

var stateBg = context.Background()

func stateReserve(ctx *harness.Ctx, formID, ip string) Reservation {
	r, err := reserve(stateBg, formID, ip)
	ctx.NoError(err, "reserve(%s, %s)", formID, ip)
	return r
}

func stateConsume(ctx *harness.Ctx, token string) bool {
	ok, err := consumeCaptcha(stateBg, token)
	ctx.NoError(err, "consumeCaptcha(%s)", token)
	return ok
}

func stateNow(ctx *harness.Ctx) int64 { return ctx.Clock.Now() / 1000 }

func CheckCaptchaOnce(ctx *harness.Ctx) {
	ctx.Redis.Set("captcha:t-1", "1")
	// A second tab replays the same token while the first request is consuming it.
	rival := ctx.Redis.After("captcha:t-1", func() any {
		ok, _ := consumeCaptcha(stateBg, "t-1")
		return ok
	})
	first := stateConsume(ctx, "t-1")
	ctx.Assert(rival.Fired, "nothing touched captcha:t-1")
	second, _ := rival.Result.(bool)
	passed := 0
	for _, ok := range []bool{first, second} {
		if ok {
			passed++
		}
	}
	ctx.Equal(passed, 1, "two parallel replays of one captcha token answered %t and %t: the replay landed between the GET and the DEL. Consume it with one GETDEL; tokens passed", first, second)
	ctx.Equal(ctx.Redis.Exists("captcha:t-1"), 0, "the token must be gone once used")
	ctx.Equal(stateConsume(ctx, "t-1"), false, "a used token passed again")
	ctx.Equal(stateConsume(ctx, "never-issued"), false, "a token nobody issued passed")
}

func CheckBothDimensions(ctx *harness.Ctx) {
	allowed := 0
	for i := 0; i < 25; i++ {
		if stateReserve(ctx, "f-1", fmt.Sprintf("10.0.0.%d", i)).Allowed {
			allowed++
		}
	}
	ctx.Equal(allowed, 20, "25 submissions to form f-1 from 25 addresses must allow FORM_LIMIT = 20 per window (a botnet sweeps one form from many addresses); allowed")
	var tries []bool
	for i := 0; i < 8; i++ {
		tries = append(tries, stateReserve(ctx, "f-2", "10.9.9.9").Allowed)
	}
	ctx.Equal(tries, []bool{true, true, true, true, true, false, false, false}, "eight submissions to f-2 from one address: five allowed (IP_LIMIT = 5), then refused")
	others := 0
	for i := 0; i < 20; i++ {
		if stateReserve(ctx, "f-2", fmt.Sprintf("10.1.0.%d", i)).Allowed {
			others++
		}
	}
	ctx.Equal(others, 15, "after 5 allowed and 3 refused from 10.9.9.9, f-2 must let in its 15 remaining slots (a refused request must not spend the form's budget); other addresses allowed")
}

func CheckWindowBucket(ctx *harness.Ctx) {
	for i := 0; i < 5; i++ {
		stateReserve(ctx, "f-1", "10.0.0.1")
	}
	ctx.Equal(stateReserve(ctx, "f-1", "10.0.0.1").Allowed, false, "the sixth submission from one address in a window must be refused (IP_LIMIT = 5)")
	keys := ctx.Redis.Keys("limit:*")
	ctx.Assert(len(keys) > 0, "reserve wrote no limit:* key")
	for _, key := range keys {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl > 0 && ttl <= 2*stateWindow, "%s has TTL %d: a limit key must expire with its window, or one busy minute blocks the address forever", key, ttl)
	}
	window := stateNow(ctx) / stateWindow
	sort.Strings(keys)
	want := []string{fmt.Sprintf("limit:form:f-1:%d", window), fmt.Sprintf("limit:ip:10.0.0.1:%d", window)}
	ctx.Equal(keys, want, "the limit keys must carry the window in their names")
	ctx.Clock.Advance(stateWindow)
	ctx.Equal(stateReserve(ctx, "f-1", "10.0.0.1").Allowed, true, "a minute later the address must be allowed again: the next window has keys of its own")
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	for i := 0; i < 4; i++ {
		ctx.Equal(stateReserve(ctx, "f-1", "10.0.0.1").Allowed, true, "the first four submissions from one address must be allowed")
	}
	window := stateNow(ctx) / stateWindow
	// A second request from the same address lands while this one is reserving the fifth slot.
	var rivals []Reservation
	for _, key := range []string{"limit:ip:10.0.0.1", fmt.Sprintf("limit:ip:10.0.0.1:%d", window)} {
		ctx.Redis.After(key, func() any {
			r, _ := reserve(stateBg, "f-1", "10.0.0.1")
			rivals = append(rivals, r)
			return nil
		})
	}
	mine := stateReserve(ctx, "f-1", "10.0.0.1")
	ctx.Assert(len(rivals) > 0, "reserve never touched the address's counter")
	both := []bool{mine.Allowed, rivals[0].Allowed}
	ctx.Assert(mine.Allowed != rivals[0].Allowed, "with 4 of 5 slots used, two parallel submissions answered allowed=%v: the read, the comparison and the INCR are separate round trips and the other request landed between them. Reserve in one Lua script", both)
	ctx.Equal(stateReserve(ctx, "f-1", "10.0.0.1").Allowed, false, "the address's sixth submission must be refused")
}

func CheckRetryAfter(ctx *harness.Ctx) {
	ctx.Clock.Advance(float64(((45-stateNow(ctx)%stateWindow)%stateWindow + stateWindow) % stateWindow))
	left := stateWindow - stateNow(ctx)%stateWindow
	for _, expected := range []int64{4, 3, 2, 1, 0} {
		got := stateReserve(ctx, "f-1", "10.0.0.1")
		ctx.Assert(got.Allowed && got.Remaining == expected, "a submission with %d slots left answered %+v, expected allowed with remaining %d", expected+1, got, expected)
	}
	refused := stateReserve(ctx, "f-1", "10.0.0.1")
	ctx.Equal(refused.Allowed, false, "the sixth submission in a window must be refused")
	ctx.Equal(refused.RetryAfter, left, "the refusal's RetryAfter must be the seconds until this window ends")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

namespace {

constexpr long long kWindow = 60;

long long nowS(harness::Ctx& ctx) { return ctx.Clock.Now() / 1000; }

}  // namespace

void CheckCaptchaOnce(harness::Ctx& ctx) {
  ctx.Redis.Must({"SET", "captcha:t-1", "1"});
  // A second tab replays the same token while the first request is consuming it.
  auto rival = std::make_shared<int>(-1);
  ctx.Redis.After("captcha:t-1", [rival] { *rival = consumeCaptcha("t-1") ? 1 : 0; });
  const bool first = consumeCaptcha("t-1");
  ctx.Assert(*rival >= 0, "nothing touched captcha:t-1");
  const bool second = *rival == 1;
  ctx.Equal(int(first) + int(second), 1, "two parallel replays of one captcha token answered %t and %t: the replay landed between the GET and the DEL. Consume it with one GETDEL; tokens passed", first, second);
  ctx.Equal(ctx.Redis.Type("captcha:t-1"), "none", "the token must be gone once used; its type");
  ctx.Equal(consumeCaptcha("t-1"), false, "a used token passed again");
  ctx.Equal(consumeCaptcha("never-issued"), false, "a token nobody issued passed");
}

void CheckBothDimensions(harness::Ctx& ctx) {
  int allowed = 0;
  for (int i = 0; i < 25; i++) allowed += reserve("f-1", "10.0.0." + std::to_string(i)).allowed ? 1 : 0;
  ctx.Equal(allowed, 20, "25 submissions to form f-1 from 25 addresses must allow FORM_LIMIT = 20 per window (a botnet sweeps one form from many addresses); allowed");
  std::vector<bool> tries;
  for (int i = 0; i < 8; i++) tries.push_back(reserve("f-2", "10.9.9.9").allowed);
  ctx.Equal(tries, std::vector<bool>{true, true, true, true, true, false, false, false}, "eight submissions to f-2 from one address: five allowed (IP_LIMIT = 5), then refused");
  int others = 0;
  for (int i = 0; i < 20; i++) others += reserve("f-2", "10.1.0." + std::to_string(i)).allowed ? 1 : 0;
  ctx.Equal(others, 15, "after 5 allowed and 3 refused from 10.9.9.9, f-2 must let in its 15 remaining slots (a refused request must not spend the form's budget); other addresses allowed");
}

void CheckWindowBucket(harness::Ctx& ctx) {
  for (int i = 0; i < 5; i++) reserve("f-1", "10.0.0.1");
  ctx.Equal(reserve("f-1", "10.0.0.1").allowed, false, "the sixth submission from one address in a window must be refused (IP_LIMIT = 5)");
  auto keys = ctx.Redis.Keys("limit:*");
  ctx.Assert(!keys.empty(), "reserve wrote no limit:* key");
  for (const auto& key : keys) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl > 0 && ttl <= 2 * kWindow, "%s has TTL %d: a limit key must expire with its window, or one busy minute blocks the address forever", key, ttl);
  }
  const long long window = nowS(ctx) / kWindow;
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, std::vector<std::string>{"limit:form:f-1:" + std::to_string(window), "limit:ip:10.0.0.1:" + std::to_string(window)}, "the limit keys must carry the window in their names");
  ctx.Clock.Advance(kWindow);
  ctx.Equal(reserve("f-1", "10.0.0.1").allowed, true, "a minute later the address must be allowed again: the next window has keys of its own");
}

void CheckAtomicReserve(harness::Ctx& ctx) {
  for (int i = 0; i < 4; i++) ctx.Equal(reserve("f-1", "10.0.0.1").allowed, true, "the first four submissions from one address must be allowed");
  const long long window = nowS(ctx) / kWindow;
  // A second request from the same address lands while this one is reserving the fifth slot.
  auto rivals = std::make_shared<std::vector<bool>>();
  for (const std::string key : {std::string("limit:ip:10.0.0.1"), "limit:ip:10.0.0.1:" + std::to_string(window)}) {
    ctx.Redis.After(key, [rivals] { rivals->push_back(reserve("f-1", "10.0.0.1").allowed); });
  }
  const bool mine = reserve("f-1", "10.0.0.1").allowed;
  ctx.Assert(!rivals->empty(), "reserve never touched the address's counter");
  ctx.Assert(mine != rivals->front(), "with 4 of 5 slots used, two parallel submissions answered allowed=%t and %t: the read, the comparison and the INCR are separate round trips and the other request landed between them. Reserve in one Lua script", mine, rivals->front());
  ctx.Equal(reserve("f-1", "10.0.0.1").allowed, false, "the address's sixth submission must be refused");
}

void CheckRetryAfter(harness::Ctx& ctx) {
  ctx.Clock.Advance(static_cast<double>(((45 - nowS(ctx) % kWindow) % kWindow + kWindow) % kWindow));
  const long long left = kWindow - nowS(ctx) % kWindow;
  for (const long long expected : {4LL, 3LL, 2LL, 1LL, 0LL}) {
    const auto got = reserve("f-1", "10.0.0.1");
    ctx.Assert(got.allowed && got.remaining == expected, "a submission with %d slots left answered allowed=%t remaining=%d, expected allowed with remaining %d", expected + 1, got.allowed, got.remaining, expected);
  }
  const auto refused = reserve("f-1", "10.0.0.1");
  ctx.Equal(refused.allowed, false, "the sixth submission in a window must be refused");
  ctx.Equal(refused.retry_after, left, "the refusal's retry_after must be the seconds until this window ends");
}
`,
  },
  hints: [
    'Send one captcha token from two tabs at once: both submissions pass. A thousand addresses can each submit to one form, and an address that hit the limit at 09:00 is still refused at noon.',
    'The token is read and deleted in two round trips, so a replay fits between them; the counter names only the address, has no window and no TTL; and the read, the comparison and the INCR are three commands.',
    '`GETDEL` the token. In one Lua script, read `limit:form:{id}:{w}` and `limit:ip:{ip}:{w}`, INCR and EXPIRE both only if both are under their limits; `retry_after = WINDOW_S - now % WINDOW_S`.',
  ],
  debrief: `Both fixes have the same shape: make the decision and the write one operation on the server, because any gap between them is where a parallel request lands. GETDEL turns "is it there, then remove it" into one command; the Lua script turns "is there room on both counters, then take a slot on both" into one, and checking both before incrementing either is what keeps a refused request from spending a form's budget. The window in the key name is what lets an address recover: each minute has counters of its own, and EXPIRE cleans up the old ones. A fixed window lets a client burst twice at its boundary; a sliding log or a token bucket smooths that, and abuse systems add reputation per address range so one botnet cannot rotate through fresh addresses unseen.`,
};
