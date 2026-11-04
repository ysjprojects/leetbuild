import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis per-path dedupe and a purge budget in one script',
  concept: 'redis',
  file: 'state',
  focus: ['purge', 'redis'],
  task: `## Task

**Starting point.** The starter's \`reserve(domain, paths)\` runs before a purge goes to the provider:
it asks \`EXISTS purge:seen:{domain}:{path}\` for each path, charges \`purge:budget:{domain}\` with
\`INCRBY\` by the number of new paths, marks each new path with \`SET\`, and refuses when the charge
passes \`BUDGET_MAX\` = 1000. It answers \`{allowed, new_paths, duplicates, remaining, retry_after}\`.
It works one request at a time and hides four flaws.

**Failure mode the checks target.** Two replicas reserve the same path at once and both purge it; a
path purged once stays a duplicate forever; the budget never resets, so a week later every purge of
the domain is refused; and a refused request still marks its paths, so its retry reports them as
duplicates and they are never purged.

- One Lua script (\`EVAL\`) checks every path and reads the budget; only when the new paths fit does
  it charge \`INCRBY\` and mark them with \`SET … EX\` \`DEDUPE_TTL_S\` = 600.
- The budget key is \`purge:budget:{domain}:{window}\` with \`window = now // WINDOW_S\` (300 s), and
  it expires (\`EXPIRE\`).
- A refusal writes nothing and reports \`remaining\`; \`retry_after\` is the seconds until the window
  ends (\`WINDOW_S - now % WINDOW_S\`), the value a \`429\`'s \`Retry-After\` names.

:::widget token-bucket {"rate": 3, "burst": 1000}`,
  sequence: {
    participants: ['Purge API', 'Redis'],
    messages: [
      {from: 'Purge API', to: 'Purge API', label: 'window = now // 300 · a seen key per path', kind: 'sync'},
      {from: 'Purge API', to: 'Redis', label: 'EVAL reserve (budget key, seen keys · 1000, 300, 600)', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'EXISTS each path · GET budget · fits? INCRBY, SET EX 600', kind: 'sync'},
      {from: 'Redis', to: 'Purge API', label: '[allowed, remaining, new or duplicate per path]', kind: 'reply'},
      {from: 'Purge API', to: 'Purge API', label: 'refused → retry_after = 300 - now % 300', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-reserve',
      title: 'Two concurrent reservations cannot both win a path',
      detail:
        'The existence checks and the writes run inside one script, so a reservation that lands between two of the starter’s commands sees the path as taken. The starter asks `EXISTS` from the client and writes later.',
      match: {
        python: {
          all: [/redis\.call\(\s*'EXISTS'/, /\.eval\(|register_script\(/],
          none: [/\br\.exists\(/, /\br\.set\(/],
        },
        typescript: {
          all: [/redis\.call\(\s*'EXISTS'/, /\.eval\(|defineCommand\(/],
          none: [/redis\.exists\(/, /redis\.set\(/],
        },
        go: {all: [/redis\.call\(\s*'EXISTS'/, /redis\.NewScript\(|\.Eval\(/], none: [/rdb\.Exists\(/, /rdb\.Set\(/]},
        scala: {all: [/redis\.call\(\s*'EXISTS'/, /jedis\.eval\(/], none: [/jedis\.exists\(/, /jedis\.set\(/]},
        cpp: {all: [/redis\.call\(\s*'EXISTS'/, /\.eval[<(]/], none: [/redis\.exists\(/, /redis\.set\(/]},
      },
    },
    {
      id: 'dedupe-window',
      title: 'A path is a duplicate for ten minutes, then purgeable again',
      detail:
        'Each new path is marked with `SET … EX 600` (`DEDUPE_TTL_S`), so a repeat inside ten minutes is a duplicate and a later one is purged. The starter’s mark has no expiry.',
      match: {
        python: {all: [/DEDUPE_TTL_S\s*=\s*600/, /'EX'/]},
        typescript: {all: [/DEDUPE_TTL_S\s*=\s*600/, /'EX'/]},
        go: {all: [/dedupeTTLS\s*=\s*600/, /'EX'/]},
        scala: {all: [/DedupeTtlS\s*=\s*600/, /'EX'/]},
        cpp: {all: [/kDedupeTtlS\s*=\s*600/, /'EX'/]},
      },
    },
    {
      id: 'budget-window',
      title: 'The budget belongs to a five-minute window and expires with it',
      detail:
        'The budget key carries the window (`purge:budget:{domain}:{window}`), expires, and a refusal’s `retry_after` is the time left in the window; after it the domain can purge again. The starter’s one counter only grows.',
      match: {
        python: {all: [/purge:budget:\{domain\}:\{window\}/, /'EXPIRE'/, /%\s*WINDOW_S/]},
        typescript: {all: [/purge:budget:\$\{domain\}:\$\{window\}/, /'EXPIRE'/, /%\s*WINDOW_S/]},
        go: {all: [/purge:budget:%s:%d/, /'EXPIRE'/, /%\s*windowS/]},
        scala: {all: [/purge:budget:\$domain:\$window/, /'EXPIRE'/, /%\s*WindowS/]},
        cpp: {all: [/"purge:budget:"\s*\+\s*domain\s*\+\s*":"/, /'EXPIRE'/, /%\s*kWindowS/]},
      },
    },
    {
      id: 'refusal-clean',
      title: 'A refused reservation charges nothing and marks nothing',
      detail:
        'The script reads the budget (`GET`) and charges (`INCRBY`) only when the new paths fit, so a refusal leaves the budget and the paths as they were. The starter charges and marks first and compares afterwards.',
      match: {
        python: {order: [/redis\.call\(\s*'GET'/, /redis\.call\(\s*'INCRBY'/], none: [/\.incrby\(/]},
        typescript: {order: [/redis\.call\(\s*'GET'/, /redis\.call\(\s*'INCRBY'/], none: [/\.incrby\(/]},
        go: {order: [/redis\.call\(\s*'GET'/, /redis\.call\(\s*'INCRBY'/], none: [/\.IncrBy\(/]},
        scala: {order: [/redis\.call\(\s*'GET'/, /redis\.call\(\s*'INCRBY'/], none: [/\.incrBy\(/]},
        cpp: {order: [/redis\.call\(\s*'GET'/, /redis\.call\(\s*'INCRBY'/], none: [/\.incrby\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 300
BUDGET_MAX = 1000


def seen_key(domain: str, path: str) -> str:
    return f"purge:seen:{domain}:{path}"


def reserve(domain: str, paths: list[str]) -> dict:
    """Reserve the domain's paths for a purge: which are new, which were purged recently, and whether the budget allows it."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    budget = f"purge:budget:{domain}"
    new_paths = [path for path in paths if not r.exists(seen_key(domain, path))]
    duplicates = [path for path in paths if path not in new_paths]
    used = r.incrby(budget, len(new_paths))
    for path in new_paths:
        r.set(seen_key(domain, path), "1")
    if used > BUDGET_MAX:
        return {"allowed": False, "new_paths": [], "duplicates": duplicates, "remaining": 0, "retry_after": WINDOW_S}
    return {"allowed": True, "new_paths": new_paths, "duplicates": duplicates, "remaining": BUDGET_MAX - used, "retry_after": 0}
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 300
BUDGET_MAX = 1000
DEDUPE_TTL_S = 600

# KEYS[1] the window's budget, KEYS[2..] one seen key per path; ARGV budget max, window, dedupe TTL.
# The reply: allowed, remaining, then "1" (new) or "0" (duplicate) per path. A refusal writes nothing.
RESERVE_LUA = """
local budget_max, window_s, dedupe_ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local reply = {'0', '0'}
local fresh = 0
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    reply[i + 1] = '1'
    fresh = fresh + 1
  else
    reply[i + 1] = '0'
  end
end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used + fresh > budget_max then
  reply[2] = tostring(budget_max - used)
  return reply
end
if fresh > 0 then
  used = redis.call('INCRBY', KEYS[1], fresh)
  if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], window_s) end
end
for i = 2, #KEYS do
  if reply[i + 1] == '1' then redis.call('SET', KEYS[i], '1', 'EX', dedupe_ttl) end
end
reply[1] = '1'
reply[2] = tostring(budget_max - used)
return reply
"""


def seen_key(domain: str, path: str) -> str:
    return f"purge:seen:{domain}:{path}"


def reserve(domain: str, paths: list[str]) -> dict:
    """Reserve the domain's paths for a purge: which are new, which were purged recently, and whether the budget allows it."""
    now = int(time.time())
    window = now // WINDOW_S
    keys = [f"purge:budget:{domain}:{window}"] + [seen_key(domain, path) for path in paths]
    reply = r.eval(RESERVE_LUA, len(keys), *keys, BUDGET_MAX, WINDOW_S, DEDUPE_TTL_S)
    allowed = reply[0] == "1"
    flags = reply[2:]
    return {
        "allowed": allowed,
        "new_paths": [path for path, flag in zip(paths, flags) if flag == "1"] if allowed else [],
        "duplicates": [path for path, flag in zip(paths, flags) if flag == "0"],
        "remaining": int(reply[1]),
        "retry_after": 0 if allowed else WINDOW_S - now % WINDOW_S,  # the seconds until the window resets
    }
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const WINDOW_S = 300;
export const BUDGET_MAX = 1000;

export interface Reservation {
  allowed: boolean;
  new_paths: string[];
  duplicates: string[];
  remaining: number;
  retry_after: number;
}

const seenKey = (domain: string, path: string): string => \`purge:seen:\${domain}:\${path}\`;

/** Reserve the domain's paths for a purge: which are new, which were purged recently, and whether the budget allows it. */
export async function reserve(domain: string, paths: string[]): Promise<Reservation> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const budget = \`purge:budget:\${domain}\`;
  const newPaths: string[] = [];
  const duplicates: string[] = [];
  for (const path of paths) {
    if ((await redis.exists(seenKey(domain, path))) === 0) newPaths.push(path);
    else duplicates.push(path);
  }
  const used = await redis.incrby(budget, newPaths.length);
  for (const path of newPaths) await redis.set(seenKey(domain, path), '1');
  if (used > BUDGET_MAX) return {allowed: false, new_paths: [], duplicates, remaining: 0, retry_after: WINDOW_S};
  return {allowed: true, new_paths: newPaths, duplicates, remaining: BUDGET_MAX - used, retry_after: 0};
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const WINDOW_S = 300;
export const BUDGET_MAX = 1000;
export const DEDUPE_TTL_S = 600;

// KEYS[1] the window's budget, KEYS[2..] one seen key per path; ARGV budget max, window, dedupe TTL.
// The reply: allowed, remaining, then "1" (new) or "0" (duplicate) per path. A refusal writes nothing.
const RESERVE_LUA = \`
local budget_max, window_s, dedupe_ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local reply = {'0', '0'}
local fresh = 0
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    reply[i + 1] = '1'
    fresh = fresh + 1
  else
    reply[i + 1] = '0'
  end
end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used + fresh > budget_max then
  reply[2] = tostring(budget_max - used)
  return reply
end
if fresh > 0 then
  used = redis.call('INCRBY', KEYS[1], fresh)
  if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], window_s) end
end
for i = 2, #KEYS do
  if reply[i + 1] == '1' then redis.call('SET', KEYS[i], '1', 'EX', dedupe_ttl) end
end
reply[1] = '1'
reply[2] = tostring(budget_max - used)
return reply
\`;

export interface Reservation {
  allowed: boolean;
  new_paths: string[];
  duplicates: string[];
  remaining: number;
  retry_after: number;
}

const seenKey = (domain: string, path: string): string => \`purge:seen:\${domain}:\${path}\`;

/** Reserve the domain's paths for a purge: which are new, which were purged recently, and whether the budget allows it. */
export async function reserve(domain: string, paths: string[]): Promise<Reservation> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_S);
  const keys = [\`purge:budget:\${domain}:\${window}\`, ...paths.map(path => seenKey(domain, path))];
  const reply = (await redis.eval(RESERVE_LUA, keys.length, ...keys, BUDGET_MAX, WINDOW_S, DEDUPE_TTL_S)) as string[];
  const allowed = reply[0] === '1';
  const flags = reply.slice(2);
  return {
    allowed,
    new_paths: allowed ? paths.filter((_, i) => flags[i] === '1') : [],
    duplicates: paths.filter((_, i) => flags[i] === '0'),
    remaining: Number(reply[1]),
    retry_after: allowed ? 0 : WINDOW_S - (now % WINDOW_S), // the seconds until the window resets
  };
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
	windowS   = 300
	budgetMax = 1000
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Reservation says which paths are new, which were purged recently, and whether the budget allows the purge.
type Reservation struct {
	Allowed    bool
	NewPaths   []string
	Duplicates []string
	Remaining  int64
	RetryAfter int64
}

func seenKey(domain, path string) string {
	return "purge:seen:" + domain + ":" + path
}

// reserve reserves the domain's paths for a purge.
func reserve(ctx context.Context, domain string, paths []string) (Reservation, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	budget := "purge:budget:" + domain
	var res Reservation
	for _, path := range paths {
		n, err := rdb.Exists(ctx, seenKey(domain, path)).Result()
		if err != nil {
			return Reservation{}, err
		}
		if n == 0 {
			res.NewPaths = append(res.NewPaths, path)
		} else {
			res.Duplicates = append(res.Duplicates, path)
		}
	}
	used, err := rdb.IncrBy(ctx, budget, int64(len(res.NewPaths))).Result()
	if err != nil {
		return Reservation{}, err
	}
	for _, path := range res.NewPaths {
		rdb.Set(ctx, seenKey(domain, path), "1", 0)
	}
	if used > budgetMax {
		return Reservation{Duplicates: res.Duplicates, RetryAfter: windowS}, nil
	}
	res.Allowed = true
	res.Remaining = budgetMax - used
	return res, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowS    = 300
	budgetMax  = 1000
	dedupeTTLS = 600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// reserveScript: KEYS[1] the window's budget, KEYS[2..] one seen key per path; ARGV budget max,
// window, dedupe TTL. The reply: allowed, remaining, then "1" (new) or "0" (duplicate) per path.
// A refusal writes nothing.
var reserveScript = redis.NewScript(\`
local budget_max, window_s, dedupe_ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local reply = {'0', '0'}
local fresh = 0
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    reply[i + 1] = '1'
    fresh = fresh + 1
  else
    reply[i + 1] = '0'
  end
end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used + fresh > budget_max then
  reply[2] = tostring(budget_max - used)
  return reply
end
if fresh > 0 then
  used = redis.call('INCRBY', KEYS[1], fresh)
  if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], window_s) end
end
for i = 2, #KEYS do
  if reply[i + 1] == '1' then redis.call('SET', KEYS[i], '1', 'EX', dedupe_ttl) end
end
reply[1] = '1'
reply[2] = tostring(budget_max - used)
return reply
\`)

// Reservation says which paths are new, which were purged recently, and whether the budget allows the purge.
type Reservation struct {
	Allowed    bool
	NewPaths   []string
	Duplicates []string
	Remaining  int64
	RetryAfter int64
}

func seenKey(domain, path string) string {
	return "purge:seen:" + domain + ":" + path
}

// reserve reserves the domain's paths for a purge.
func reserve(ctx context.Context, domain string, paths []string) (Reservation, error) {
	now := time.Now().Unix()
	window := now / windowS
	keys := []string{fmt.Sprintf("purge:budget:%s:%d", domain, window)}
	for _, path := range paths {
		keys = append(keys, seenKey(domain, path))
	}
	reply, err := reserveScript.Run(ctx, rdb, keys, budgetMax, windowS, dedupeTTLS).StringSlice()
	if err != nil {
		return Reservation{}, err
	}
	res := Reservation{Allowed: reply[0] == "1"}
	res.Remaining, _ = strconv.ParseInt(reply[1], 10, 64)
	for i, path := range paths {
		if reply[i+2] == "0" {
			res.Duplicates = append(res.Duplicates, path)
		} else if res.Allowed {
			res.NewPaths = append(res.NewPaths, path)
		}
	}
	if !res.Allowed {
		res.RetryAfter = windowS - now%windowS // the seconds until the window resets
	}
	return res, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

/** Which paths are new, which were purged recently, and whether the budget allows the purge. */
final case class Reservation(allowed: Boolean, newPaths: Seq[String], duplicates: Seq[String], remaining: Long, retryAfter: Long)

object State {
  val WindowS = 300L
  val BudgetMax = 1000L

  val jedis = new JedisPooled("redis", 6379)

  def seenKey(domain: String, path: String): String = s"purge:seen:$domain:$path"

  /** Reserve the domain's paths for a purge. */
  def reserve(domain: String, paths: Seq[String]): Reservation = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val budget = s"purge:budget:$domain"
    val (duplicates, newPaths) = paths.partition(path => jedis.exists(seenKey(domain, path)))
    val used = jedis.incrBy(budget, newPaths.size.toLong)
    newPaths.foreach(path => jedis.set(seenKey(domain, path), "1"))
    if (used > BudgetMax) Reservation(allowed = false, Seq.empty, duplicates, 0L, WindowS)
    else Reservation(allowed = true, newPaths, duplicates, BudgetMax - used, 0L)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** Which paths are new, which were purged recently, and whether the budget allows the purge. */
final case class Reservation(allowed: Boolean, newPaths: Seq[String], duplicates: Seq[String], remaining: Long, retryAfter: Long)

object State {
  val WindowS = 300L
  val BudgetMax = 1000L
  val DedupeTtlS = 600L

  val jedis = new JedisPooled("redis", 6379)

  /**
   * KEYS[1] the window's budget, KEYS[2..] one seen key per path; ARGV budget max, window, dedupe TTL.
   * The reply: allowed, remaining, then "1" (new) or "0" (duplicate) per path. A refusal writes nothing.
   */
  val ReserveLua: String = """
local budget_max, window_s, dedupe_ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local reply = {'0', '0'}
local fresh = 0
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    reply[i + 1] = '1'
    fresh = fresh + 1
  else
    reply[i + 1] = '0'
  end
end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used + fresh > budget_max then
  reply[2] = tostring(budget_max - used)
  return reply
end
if fresh > 0 then
  used = redis.call('INCRBY', KEYS[1], fresh)
  if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], window_s) end
end
for i = 2, #KEYS do
  if reply[i + 1] == '1' then redis.call('SET', KEYS[i], '1', 'EX', dedupe_ttl) end
end
reply[1] = '1'
reply[2] = tostring(budget_max - used)
return reply
"""

  def seenKey(domain: String, path: String): String = s"purge:seen:$domain:$path"

  /** Reserve the domain's paths for a purge. */
  def reserve(domain: String, paths: Seq[String]): Reservation = {
    val now = System.currentTimeMillis() / 1000
    val window = now / WindowS
    val keys = s"purge:budget:$domain:$window" +: paths.map(seenKey(domain, _))
    val args = Seq(BudgetMax, WindowS, DedupeTtlS).map(_.toString)
    val reply = jedis.eval(ReserveLua, keys.asJava, args.asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(String.valueOf).toSeq
    val allowed = reply.head == "1"
    val flags = reply.drop(2)
    Reservation(
      allowed,
      if (allowed) paths.zip(flags).collect { case (path, "1") => path } else Seq.empty,
      paths.zip(flags).collect { case (path, "0") => path },
      reply(1).toLong,
      if (allowed) 0L else WindowS - now % WindowS // the seconds until the window resets
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

const long long kWindowS = 300;
const long long kBudgetMax = 1000;

sw::redis::Redis redis("tcp://redis:6379");

// Which paths are new, which were purged recently, and whether the budget allows the purge.
struct Reservation {
  bool allowed = false;
  std::vector<std::string> new_paths;
  std::vector<std::string> duplicates;
  long long remaining = 0;
  long long retry_after = 0;
};

std::string seenKey(const std::string& domain, const std::string& path) { return "purge:seen:" + domain + ":" + path; }

// Reserve the domain's paths for a purge.
Reservation reserve(const std::string& domain, const std::vector<std::string>& paths) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string budget = "purge:budget:" + domain;
  Reservation res;
  for (const auto& path : paths) {
    if (redis.exists(seenKey(domain, path)) == 0) {
      res.new_paths.push_back(path);
    } else {
      res.duplicates.push_back(path);
    }
  }
  const long long used = redis.incrby(budget, static_cast<long long>(res.new_paths.size()));
  for (const auto& path : res.new_paths) redis.set(seenKey(domain, path), "1");
  if (used > kBudgetMax) return Reservation{false, {}, res.duplicates, 0, kWindowS};
  res.allowed = true;
  res.remaining = kBudgetMax - used;
  return res;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <vector>

const long long kWindowS = 300;
const long long kBudgetMax = 1000;
const long long kDedupeTtlS = 600;

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] the window's budget, KEYS[2..] one seen key per path; ARGV budget max, window, dedupe TTL.
// The reply: allowed, remaining, then "1" (new) or "0" (duplicate) per path. A refusal writes nothing.
const std::string kReserveLua = R"lua(
local budget_max, window_s, dedupe_ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local reply = {'0', '0'}
local fresh = 0
for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    reply[i + 1] = '1'
    fresh = fresh + 1
  else
    reply[i + 1] = '0'
  end
end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used + fresh > budget_max then
  reply[2] = tostring(budget_max - used)
  return reply
end
if fresh > 0 then
  used = redis.call('INCRBY', KEYS[1], fresh)
  if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], window_s) end
end
for i = 2, #KEYS do
  if reply[i + 1] == '1' then redis.call('SET', KEYS[i], '1', 'EX', dedupe_ttl) end
end
reply[1] = '1'
reply[2] = tostring(budget_max - used)
return reply
)lua";

// Which paths are new, which were purged recently, and whether the budget allows the purge.
struct Reservation {
  bool allowed = false;
  std::vector<std::string> new_paths;
  std::vector<std::string> duplicates;
  long long remaining = 0;
  long long retry_after = 0;
};

std::string seenKey(const std::string& domain, const std::string& path) { return "purge:seen:" + domain + ":" + path; }

// Reserve the domain's paths for a purge.
Reservation reserve(const std::string& domain, const std::vector<std::string>& paths) {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long window = now / kWindowS;
  std::vector<std::string> keys = {"purge:budget:" + domain + ":" + std::to_string(window)};
  for (const auto& path : paths) keys.push_back(seenKey(domain, path));
  const std::vector<std::string> args = {std::to_string(kBudgetMax), std::to_string(kWindowS), std::to_string(kDedupeTtlS)};
  std::vector<std::string> reply;
  redis.eval(kReserveLua, keys.begin(), keys.end(), args.begin(), args.end(), std::back_inserter(reply));
  Reservation res;
  res.allowed = reply[0] == "1";
  res.remaining = std::stoll(reply[1]);
  for (size_t i = 0; i < paths.size(); i++) {
    if (reply[i + 2] == "0") {
      res.duplicates.push_back(paths[i]);
    } else if (res.allowed) {
      res.new_paths.push_back(paths[i]);
    }
  }
  if (!res.allowed) res.retry_after = kWindowS - now % kWindowS;  // the seconds until the window resets
  return res;
}
`,
    },
  },
  harness: {
    python: `DOMAIN = "shop.example.com"
SEEN = f"purge:seen:{DOMAIN}:/pricing"


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def _budget_used(ctx):
    return sum(int(ctx.redis.get(key) or 0) for key in ctx.redis.keys(f"purge:budget:{DOMAIN}*"))


def check_atomic_reserve(ctx):
    m = ctx.load("state")
    # A second replica reserves the same path right after this reservation's first command on it.
    rival = ctx.redis_after(SEEN, lambda: m.reserve(DOMAIN, ["/pricing"]))
    mine = m.reserve(DOMAIN, ["/pricing"])
    theirs = _settled(rival, SEEN)
    won = [res for res in (mine, theirs) if "/pricing" in res["new_paths"]]
    assert len(won) == 1, f"two concurrent reservations of /pricing answered {mine} and {theirs}: {len(won)} of them won the path, so it is purged {len(won)} times. The check and the mark must run in one script"
    assert _budget_used(ctx) == 1, f"one path reserved once charged the budget {_budget_used(ctx)}"


def check_dedupe_window(ctx):
    m = ctx.load("state")
    first = m.reserve(DOMAIN, ["/pricing", "/img/logo.png"])
    assert first["allowed"] and first["new_paths"] == ["/pricing", "/img/logo.png"], f"a first reservation answered {first}"
    again = m.reserve(DOMAIN, ["/pricing", "/about"])
    assert again["new_paths"] == ["/about"] and again["duplicates"] == ["/pricing"], f"/pricing again within ten minutes answered {again}: it is a duplicate, /about is new"
    ttl = ctx.redis.ttl(SEEN)
    assert 0 < ttl <= 600, f"{SEEN} has TTL {ttl}, expected the 600 s dedupe window: without it a path purged once is a duplicate forever"
    ctx.clock.advance(601)
    later = m.reserve(DOMAIN, ["/pricing"])
    assert later["new_paths"] == ["/pricing"], f"/pricing eleven minutes later answered {later}: the dedupe window is over and the path must be purged again"


def check_budget_window(ctx):
    m = ctx.load("state")
    full = m.reserve(DOMAIN, [f"/p/{i}" for i in range(1000)])
    assert full["allowed"] and full["remaining"] == 0, f"1000 new paths in an empty window answered allowed={full['allowed']} remaining={full['remaining']}"
    refused = m.reserve(DOMAIN, ["/one-more"])
    expected = 300 - int(ctx.clock.time()) % 300
    assert not refused["allowed"], f"a path past the budget of 1000 answered {refused}"
    assert abs(refused["retry_after"] - expected) <= 1, f"retry_after is {refused['retry_after']}, but the window ends in {expected} s: a client told to wait the wrong time retries into another refusal"
    keys = ctx.redis.keys(f"purge:budget:{DOMAIN}*")
    assert keys and all(ctx.redis.ttl(key) > 0 for key in keys), f"the budget keys {keys} have TTLs {[ctx.redis.ttl(k) for k in keys]}: a counter without expiry only grows"
    ctx.clock.advance(expected)
    after = m.reserve(DOMAIN, ["/one-more"])
    assert after["allowed"] and after["new_paths"] == ["/one-more"], f"after the window reset the domain was refused again: {after}. The budget key must belong to its window"


def check_refusal_clean(ctx):
    m = ctx.load("state")
    m.reserve(DOMAIN, [f"/p/{i}" for i in range(999)])
    refused = m.reserve(DOMAIN, ["/pricing", "/about"])
    assert not refused["allowed"], f"two new paths with one left in the budget answered {refused}"
    assert refused["remaining"] == 1, f"the refusal reports remaining {refused['remaining']}: a refused reservation must not spend the budget"
    assert ctx.redis.exists(SEEN) == 0, "the refused reservation marked /pricing as purged: its retry reports it as a duplicate and the path is never purged"
    one = m.reserve(DOMAIN, ["/pricing"])
    assert one["allowed"] and one["new_paths"] == ["/pricing"], f"the one path the budget still holds answered {one}"
`,
    typescript: `const DOMAIN = 'shop.example.com';
const SEEN = \`purge:seen:\${DOMAIN}:/pricing\`;

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

const budgetUsed = ctx => (ctx.redis.keys(\`purge:budget:\${DOMAIN}*\`) as string[]).reduce((sum, key) => sum + Number(ctx.redis.get(key) ?? 0), 0);

export async function check_atomic_reserve(ctx) {
  const m = ctx.load('state');
  // A second replica reserves the same path right after this reservation's first command on it.
  const rival = ctx.redisAfter(SEEN, () => m.reserve(DOMAIN, ['/pricing']));
  const mine = await m.reserve(DOMAIN, ['/pricing']);
  const theirs = await settled(rival, SEEN);
  const won = [mine, theirs].filter(res => res.new_paths.includes('/pricing'));
  assert.equal(won.length, 1, \`two concurrent reservations of /pricing answered \${JSON.stringify(mine)} and \${JSON.stringify(theirs)}: \${won.length} of them won the path. The check and the mark must run in one script\`);
  assert.equal(budgetUsed(ctx), 1, 'one path reserved once must charge the budget once');
}

export async function check_dedupe_window(ctx) {
  const m = ctx.load('state');
  const first = await m.reserve(DOMAIN, ['/pricing', '/img/logo.png']);
  assert(first.allowed && JSON.stringify(first.new_paths) === JSON.stringify(['/pricing', '/img/logo.png']), \`a first reservation answered \${JSON.stringify(first)}\`);
  const again = await m.reserve(DOMAIN, ['/pricing', '/about']);
  assert(JSON.stringify(again.new_paths) === '["/about"]' && JSON.stringify(again.duplicates) === '["/pricing"]', \`/pricing again within ten minutes answered \${JSON.stringify(again)}: it is a duplicate, /about is new\`);
  const ttl = ctx.redis.ttl(SEEN);
  assert(0 < ttl && ttl <= 600, \`\${SEEN} has TTL \${ttl}, expected the 600 s dedupe window: without it a path purged once is a duplicate forever\`);
  ctx.clock.advance(601);
  const later = await m.reserve(DOMAIN, ['/pricing']);
  assert.deepEqual(later.new_paths, ['/pricing'], \`/pricing eleven minutes later answered \${JSON.stringify(later)}: the dedupe window is over and the path must be purged again\`);
}

export async function check_budget_window(ctx) {
  const m = ctx.load('state');
  const full = await m.reserve(DOMAIN, Array.from({length: 1000}, (_, i) => \`/p/\${i}\`));
  assert(full.allowed && full.remaining === 0, \`1000 new paths in an empty window answered allowed=\${full.allowed} remaining=\${full.remaining}\`);
  const refused = await m.reserve(DOMAIN, ['/one-more']);
  const expected = 300 - (Math.floor(ctx.clock.now() / 1000) % 300);
  assert(!refused.allowed, \`a path past the budget of 1000 answered \${JSON.stringify(refused)}\`);
  assert(Math.abs(refused.retry_after - expected) <= 1, \`retry_after is \${refused.retry_after}, but the window ends in \${expected} s: a client told to wait the wrong time retries into another refusal\`);
  const keys = ctx.redis.keys(\`purge:budget:\${DOMAIN}*\`) as string[];
  assert(keys.length > 0 && keys.every(key => ctx.redis.ttl(key) > 0), \`the budget keys \${JSON.stringify(keys)} have no expiry: a counter without one only grows\`);
  ctx.clock.advance(expected);
  const after = await m.reserve(DOMAIN, ['/one-more']);
  assert(after.allowed && JSON.stringify(after.new_paths) === '["/one-more"]', \`after the window reset the domain was refused again: \${JSON.stringify(after)}. The budget key must belong to its window\`);
}

export async function check_refusal_clean(ctx) {
  const m = ctx.load('state');
  await m.reserve(DOMAIN, Array.from({length: 999}, (_, i) => \`/p/\${i}\`));
  const refused = await m.reserve(DOMAIN, ['/pricing', '/about']);
  assert(!refused.allowed, \`two new paths with one left in the budget answered \${JSON.stringify(refused)}\`);
  assert.equal(refused.remaining, 1, \`the refusal reports remaining \${refused.remaining}: a refused reservation must not spend the budget\`);
  assert.equal(ctx.redis.exists(SEEN), 0, 'the refused reservation marked /pricing as purged: its retry reports it as a duplicate and the path is never purged');
  const one = await m.reserve(DOMAIN, ['/pricing']);
  assert(one.allowed && JSON.stringify(one.new_paths) === '["/pricing"]', \`the one path the budget still holds answered \${JSON.stringify(one)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strconv"

	"leetbuild/harness"
)

const stateDomain = "shop.example.com"

var (
	stateBg   = context.Background()
	stateSeen = "purge:seen:" + stateDomain + ":/pricing"
)

func mustReserve(ctx *harness.Ctx, paths []string) Reservation {
	res, err := reserve(stateBg, stateDomain, paths)
	ctx.NoError(err, "reserve(%s, %d paths) failed", stateDomain, len(paths))
	return res
}

func numberedPaths(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("/p/%d", i)
	}
	return out
}

func budgetUsed(ctx *harness.Ctx) int {
	used := 0
	for _, key := range ctx.Redis.Keys("purge:budget:" + stateDomain + "*") {
		raw, _ := ctx.Redis.Get(key)
		n, _ := strconv.Atoi(raw)
		used += n
	}
	return used
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	// A second replica reserves the same path right after this reservation's first command on it.
	rival := ctx.Redis.After(stateSeen, func() any {
		res, err := reserve(stateBg, stateDomain, []string{"/pricing"})
		ctx.NoError(err, "the rival reservation failed")
		return res
	})
	mine := mustReserve(ctx, []string{"/pricing"})
	ctx.Assert(rival.Fired, "nothing touched %s", stateSeen)
	theirs := rival.Result.(Reservation)
	won := 0
	for _, res := range []Reservation{mine, theirs} {
		if fmt.Sprint(res.NewPaths) == "[/pricing]" {
			won++
		}
	}
	ctx.Assert(won == 1, "two concurrent reservations of /pricing answered %+v and %+v: %d of them won the path. The check and the mark must run in one script", mine, theirs, won)
	ctx.Equal(budgetUsed(ctx), 1, "one path reserved once must charge the budget once; the budget used")
}

func CheckDedupeWindow(ctx *harness.Ctx) {
	first := mustReserve(ctx, []string{"/pricing", "/img/logo.png"})
	ctx.Assert(first.Allowed && fmt.Sprint(first.NewPaths) == "[/pricing /img/logo.png]", "a first reservation answered %+v", first)
	again := mustReserve(ctx, []string{"/pricing", "/about"})
	ctx.Assert(fmt.Sprint(again.NewPaths) == "[/about]" && fmt.Sprint(again.Duplicates) == "[/pricing]", "/pricing again within ten minutes answered %+v: it is a duplicate, /about is new", again)
	ttl := ctx.Redis.TTL(stateSeen)
	ctx.Assert(0 < ttl && ttl <= 600, "%s has TTL %d, expected the 600 s dedupe window: without it a path purged once is a duplicate forever", stateSeen, ttl)
	ctx.Clock.Advance(601)
	later := mustReserve(ctx, []string{"/pricing"})
	ctx.Assert(fmt.Sprint(later.NewPaths) == "[/pricing]", "/pricing eleven minutes later answered %+v: the dedupe window is over and the path must be purged again", later)
}

func CheckBudgetWindow(ctx *harness.Ctx) {
	full := mustReserve(ctx, numberedPaths(1000))
	ctx.Assert(full.Allowed && full.Remaining == 0, "1000 new paths in an empty window answered allowed=%v remaining=%d", full.Allowed, full.Remaining)
	refused := mustReserve(ctx, []string{"/one-more"})
	expected := 300 - (ctx.Clock.Now()/1000)%300
	ctx.Assert(!refused.Allowed, "a path past the budget of 1000 answered %+v", refused)
	diff := refused.RetryAfter - int64(expected)
	ctx.Assert(diff >= -1 && diff <= 1, "retry_after is %d, but the window ends in %d s: a client told to wait the wrong time retries into another refusal", refused.RetryAfter, expected)
	keys := ctx.Redis.Keys("purge:budget:" + stateDomain + "*")
	ctx.Assert(len(keys) > 0, "no budget key was written")
	for _, key := range keys {
		ctx.Assert(ctx.Redis.TTL(key) > 0, "the budget key %s has TTL %d: a counter without expiry only grows", key, ctx.Redis.TTL(key))
	}
	ctx.Clock.Advance(float64(expected))
	after := mustReserve(ctx, []string{"/one-more"})
	ctx.Assert(after.Allowed && fmt.Sprint(after.NewPaths) == "[/one-more]", "after the window reset the domain was refused again: %+v. The budget key must belong to its window", after)
}

func CheckRefusalClean(ctx *harness.Ctx) {
	mustReserve(ctx, numberedPaths(999))
	refused := mustReserve(ctx, []string{"/pricing", "/about"})
	ctx.Assert(!refused.Allowed, "two new paths with one left in the budget answered %+v", refused)
	ctx.Equal(refused.Remaining, int64(1), "a refused reservation must not spend the budget; the remaining it reports")
	ctx.Equal(ctx.Redis.Exists(stateSeen), 0, "the refused reservation marked /pricing as purged: its retry reports it as a duplicate and the path is never purged; the seen key")
	one := mustReserve(ctx, []string{"/pricing"})
	ctx.Assert(one.Allowed && fmt.Sprint(one.NewPaths) == "[/pricing]", "the one path the budget still holds answered %+v", one)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdlib>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kStateDomain = "shop.example.com";
const std::string kSeen = "purge:seen:shop.example.com:/pricing";

std::vector<std::string> numberedPaths(int n) {
  std::vector<std::string> out;
  for (int i = 0; i < n; i++) out.push_back("/p/" + std::to_string(i));
  return out;
}

long long budgetUsed(harness::Ctx& ctx) {
  long long used = 0;
  for (const auto& key : ctx.Redis.Keys("purge:budget:" + kStateDomain + "*")) {
    const auto raw = ctx.Redis.Get(key);
    if (raw) used += std::stoll(*raw);
  }
  return used;
}

bool only(const std::vector<std::string>& paths, const std::vector<std::string>& want) { return paths == want; }

}  // namespace

void CheckAtomicReserve(harness::Ctx& ctx) {
  // A second replica reserves the same path right after this reservation's first command on it.
  auto theirs = std::make_shared<std::optional<Reservation>>();
  ctx.Redis.After(kSeen, [theirs] { *theirs = reserve(kStateDomain, {"/pricing"}); });
  const Reservation mine = reserve(kStateDomain, {"/pricing"});
  ctx.Assert(theirs->has_value(), "nothing touched %s", kSeen);
  int won = 0;
  for (const Reservation& res : std::vector<Reservation>{mine, theirs->value()}) {
    if (only(res.new_paths, {"/pricing"})) won++;
  }
  ctx.Assert(won == 1, "two concurrent reservations of /pricing: %d of them won the path, so it is purged %d times. The check and the mark must run in one script", won, won);
  ctx.Equal(budgetUsed(ctx), 1, "one path reserved once must charge the budget once; the budget used");
}

void CheckDedupeWindow(harness::Ctx& ctx) {
  const Reservation first = reserve(kStateDomain, {"/pricing", "/img/logo.png"});
  ctx.Assert(first.allowed && only(first.new_paths, {"/pricing", "/img/logo.png"}), "a first reservation must find both paths new");
  const Reservation again = reserve(kStateDomain, {"/pricing", "/about"});
  ctx.Assert(only(again.new_paths, {"/about"}) && only(again.duplicates, {"/pricing"}), "/pricing again within ten minutes is a duplicate and /about is new; new paths %q, duplicates %q", again.new_paths, again.duplicates);
  const long long ttl = ctx.Redis.TTL(kSeen);
  ctx.Assert(0 < ttl && ttl <= 600, "%s has TTL %d, expected the 600 s dedupe window: without it a path purged once is a duplicate forever", kSeen, ttl);
  ctx.Clock.Advance(601);
  const Reservation later = reserve(kStateDomain, {"/pricing"});
  ctx.Assert(only(later.new_paths, {"/pricing"}), "/pricing eleven minutes later answered new paths %q: the dedupe window is over and the path must be purged again", later.new_paths);
}

void CheckBudgetWindow(harness::Ctx& ctx) {
  const Reservation full = reserve(kStateDomain, numberedPaths(1000));
  ctx.Assert(full.allowed && full.remaining == 0, "1000 new paths in an empty window answered allowed=%t remaining=%d", full.allowed, full.remaining);
  const Reservation refused = reserve(kStateDomain, {"/one-more"});
  const long long expected = 300 - (ctx.Clock.Now() / 1000) % 300;
  ctx.Assert(!refused.allowed, "a path past the budget of 1000 was allowed");
  ctx.Assert(std::llabs(refused.retry_after - expected) <= 1, "retry_after is %d, but the window ends in %d s: a client told to wait the wrong time retries into another refusal", refused.retry_after, expected);
  const auto keys = ctx.Redis.Keys("purge:budget:" + kStateDomain + "*");
  ctx.Assert(!keys.empty(), "no budget key was written");
  for (const auto& key : keys) {
    ctx.Assert(ctx.Redis.TTL(key) > 0, "the budget key %s has TTL %d: a counter without expiry only grows", key, ctx.Redis.TTL(key));
  }
  ctx.Clock.Advance(static_cast<double>(expected));
  const Reservation after = reserve(kStateDomain, {"/one-more"});
  ctx.Assert(after.allowed && only(after.new_paths, {"/one-more"}), "after the window reset the domain was refused again (allowed=%t). The budget key must belong to its window", after.allowed);
}

void CheckRefusalClean(harness::Ctx& ctx) {
  reserve(kStateDomain, numberedPaths(999));
  const Reservation refused = reserve(kStateDomain, {"/pricing", "/about"});
  ctx.Assert(!refused.allowed, "two new paths with one left in the budget were allowed");
  ctx.Equal(refused.remaining, 1, "a refused reservation must not spend the budget; the remaining it reports");
  ctx.Equal(ctx.Redis.Exists(kSeen), 0, "the refused reservation marked /pricing as purged: its retry reports it as a duplicate and the path is never purged; the seen key");
  const Reservation one = reserve(kStateDomain, {"/pricing"});
  ctx.Assert(one.allowed && only(one.new_paths, {"/pricing"}), "the one path the budget still holds must be reserved (allowed=%t)", one.allowed);
}
`,
  },
  hints: [
    'Two replicas submit the same deploy purge and both send `/pricing` to the provider; a week later every purge of the domain is refused; a refused purge retried later reports its paths as duplicates.',
    '`EXISTS`, `INCRBY` and `SET` are separate round trips, so another reservation lands between them. The `SET` has no `EX`, `purge:budget:{domain}` has no window and no expiry, and the charge and the marks happen before the comparison.',
    'One `EVAL`: `EXISTS` each key, `GET` the budget, return untouched if the new paths do not fit, else `INCRBY`, `EXPIRE WINDOW_S` on a fresh key, `SET … EX DEDUPE_TTL_S`. Key the budget by `now // WINDOW_S`; `retry_after = WINDOW_S - now % WINDOW_S`.',
  ],
  debrief: `A reservation is one decision, and a decision made in several round trips is several decisions another replica can interleave with. Inside \`EVAL\` nothing runs between the existence checks, the budget read and the writes, and because the script returns before writing when the paths do not fit, a refusal leaves nothing behind for the retry to trip over. The window lives in the key name rather than in a sweeper: the next window starts at zero by construction, and the \`EXPIRE\` only reclaims memory. That is also what makes \`retry_after\` exact. Production systems load the script once and call it with \`EVALSHA\`, size budgets per tenant tier, and keep the dedupe key per path short enough that a failed purge can be repeated soon.`,
};
