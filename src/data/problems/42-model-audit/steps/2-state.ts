import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis hash chain per tenant, advanced atomically',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['auditd', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the tenant chain every later step relies on, one Redis hash
\`audit:chain:{tenant}\`: \`append_entry(tenant, record_id, record_digest)\` reads \`length\`, writes
\`rec:{n}\`, \`link:{n}\`, \`id:{n}\`, \`head\` and \`length\` for the next position with one \`HSET\`,
then sets a one-day \`EXPIRE\`; \`verify_chain(tenant, from_position)\` answers \`{"valid",
"chain_length", "first_divergence"}\`. Appends and verifies work in the demo; it hides 4 flaws.

**Failure mode the checks target.** An edited record still verifies because no link depends on the
one before it; two appends that land together take the same position and one record drops out of
the chain; the whole trail disappears a day after the last append; and a verify that only looks
for the head says valid about a chain with a hole in it.

- \`link:{n}\` is \`link_digest(link:{n-1}, rec:{n}, n)\` (provided, \`audit.digest\`), \`""\` before
  position 1; \`head\` is the newest link.
- The write is **one Lua script** that checks \`length\` still holds what the append read and
  returns 0 otherwise; the append then reads again and retries (\`MAX_APPEND_ATTEMPTS\` = 5).
- The chain key has no TTL.
- \`verify_chain\` recomputes every link from \`from_position\` to \`length\`: \`chain_length\` is the
  number of links that verified, \`first_divergence\` the first position that did not (\`None\` when
  every one did).`,
  sequence: {
    participants: ['Audit Service', 'Redis', 'Verifier'],
    messages: [
      {from: 'Audit Service', to: 'Redis', label: 'HMGET audit:chain:{tenant} length head', kind: 'sync'},
      {from: 'Audit Service', to: 'Audit Service', label: 'link = link_digest(head, rec, length + 1)', kind: 'sync'},
      {from: 'Audit Service', to: 'Redis', label: 'EVAL append: only while length is unchanged', kind: 'sync'},
      {from: 'Redis', to: 'Audit Service', label: 'position · 0 → read again, retry', kind: 'reply'},
      {from: 'Verifier', to: 'Redis', label: 'HGETALL audit:chain:{tenant}', kind: 'sync'},
      {from: 'Verifier', to: 'Verifier', label: 'recompute each link · stop at the first divergence', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'chain-link',
      title: 'Each link folds in the one before it',
      detail:
        'A link is `link_digest(prev, record_digest, position)` with `prev` the previous link; a digest of the record alone lets an edited record keep a valid-looking link.',
      match: {
        python: {all: [/link_digest\(/], none: [/sha256_hex\(/]},
        typescript: {all: [/linkDigest\(/], none: [/sha256Hex\(/]},
        go: {all: [/digest\.LinkDigest\(/], none: [/digest\.Sha256Hex\(/]},
        cpp: {all: [/digest::linkDigest\(/], none: [/sha256_hex\(/]},
      },
    },
    {
      id: 'cas-append',
      title: 'One script appends only while the chain is where the append read it',
      detail:
        'The write is a Lua script (`register_script`/`defineCommand`/`NewScript`/`eval`) that compares `length` with what the append read (`~=`) before writing, and the append reads again and retries on 0, up to `MAX_APPEND_ATTEMPTS` = 5 attempts, so it still lands after losing four races; a plain `HSET` lets two appends write the same position.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/, /~=/], none: [/\br\.hset\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/, /~=/], none: [/redis\.hset\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HGET['"]/, /~=/], none: [/rdb\.HSet\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HGET['"]/, /~=/], none: [/redis\.hset\(/]},
      },
    },
    {
      id: 'no-ttl',
      title: 'The chain never expires',
      detail: 'Nothing sets a TTL on the chain (no `EXPIRE` in any casing): an audit trail is retained, not cached.',
      match: {
        python: {none: [/expire/i]},
        typescript: {none: [/expire/i]},
        go: {none: [/expire/i]},
        cpp: {none: [/expire/i]},
      },
    },
    {
      id: 'first-divergence',
      title: 'Verification recomputes every link and reports the first divergence',
      detail:
        '`verify_chain`/`verifyChain` recomputes each link with `link_digest` and stops at the first one that disagrees or is missing; checking that the head exists (`HEXISTS`) verifies nothing.',
      match: {
        python: {order: [/def verify_chain/, /link_digest\(/], none: [/hexists/i]},
        typescript: {order: [/function verifyChain/, /linkDigest\(/], none: [/hexists/i]},
        go: {order: [/func verifyChain/, /digest\.LinkDigest\(/], none: [/hexists/i]},
        cpp: {order: [/Verdict verifyChain/, /digest::linkDigest\(/], none: [/hexists/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from audit.digest import sha256_hex

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAY_S = 86400


def chain_key(tenant: str) -> str:
    return f"audit:chain:{tenant}"


def append_entry(tenant: str, record_id: str, record_digest: str) -> dict:
    """Chain the record at the tenant's next position: {"position", "digest"} (the link written)."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    key = chain_key(tenant)
    position = int(r.hget(key, "length") or 0) + 1
    link = sha256_hex(f"{record_digest}|{position}")
    r.hset(key, mapping={f"rec:{position}": record_digest, f"link:{position}": link, f"id:{position}": record_id, "head": link, "length": position})
    r.expire(key, DAY_S)
    return {"position": position, "digest": link}


def verify_chain(tenant: str, from_position: int) -> dict:
    """The links from from_position to the last: {"valid", "chain_length", "first_divergence"}."""
    key = chain_key(tenant)
    length = int(r.hget(key, "length") or 0)
    if length and not r.hexists(key, "head"):
        return {"valid": False, "chain_length": 0, "first_divergence": from_position}
    return {"valid": True, "chain_length": max(length - from_position + 1, 0), "first_divergence": None}
`,
      solution: `import redis

from audit.digest import link_digest

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_APPEND_ATTEMPTS = 5

# Writes position ARGV[1] + 1 only while the chain still ends at ARGV[1]: a concurrent append makes it return 0.
APPEND_LUA = """
if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
return n
"""
append = r.register_script(APPEND_LUA)


def chain_key(tenant: str) -> str:
    return f"audit:chain:{tenant}"


def append_entry(tenant: str, record_id: str, record_digest: str) -> dict:
    """Chain the record at the tenant's next position: {"position", "digest"} (the link written)."""
    key = chain_key(tenant)
    for _ in range(MAX_APPEND_ATTEMPTS):
        length, head = r.hmget(key, "length", "head")
        length = int(length or 0)
        # The link depends on the one before it: changing any earlier record changes every later link.
        link = link_digest(head or "", record_digest, length + 1)
        position = append(keys=[key], args=[length, record_digest, link, record_id])
        if position:
            return {"position": int(position), "digest": link}
    raise RuntimeError(f"the chain of {tenant} kept moving: {MAX_APPEND_ATTEMPTS} appends lost the race")


def verify_chain(tenant: str, from_position: int) -> dict:
    """The links from from_position to the last: {"valid", "chain_length", "first_divergence"}."""
    entries = r.hgetall(chain_key(tenant))
    length = int(entries.get("length") or 0)
    prev = entries.get(f"link:{from_position - 1}", "") if from_position > 1 else ""
    covered = 0
    for n in range(from_position, length + 1):
        rec, link = entries.get(f"rec:{n}"), entries.get(f"link:{n}")
        if rec is None or link is None or link != link_digest(prev, rec, n):
            return {"valid": False, "chain_length": covered, "first_divergence": n}
        prev = link
        covered += 1
    return {"valid": True, "chain_length": covered, "first_divergence": None}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {sha256Hex} from 'audit/digest';

const redis = new Redis({host: 'redis', port: 6379});

export const DAY_S = 86400;

export interface Entry {
  position: number;
  digest: string;
}

export interface Verdict {
  valid: boolean;
  chain_length: number;
  first_divergence: number | null;
}

export const chainKey = (tenant: string): string => \`audit:chain:\${tenant}\`;

/** Chain the record at the tenant's next position: the position and the link written. */
export async function appendEntry(tenant: string, recordId: string, recordDigest: string): Promise<Entry> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const key = chainKey(tenant);
  const position = Number((await redis.hget(key, 'length')) ?? 0) + 1;
  const link = sha256Hex(\`\${recordDigest}|\${position}\`);
  await redis.hset(key, {[\`rec:\${position}\`]: recordDigest, [\`link:\${position}\`]: link, [\`id:\${position}\`]: recordId, head: link, length: String(position)});
  await redis.expire(key, DAY_S);
  return {position, digest: link};
}

/** The links from fromPosition to the last. */
export async function verifyChain(tenant: string, fromPosition: number): Promise<Verdict> {
  const key = chainKey(tenant);
  const length = Number((await redis.hget(key, 'length')) ?? 0);
  if (length > 0 && (await redis.hexists(key, 'head')) === 0) return {valid: false, chain_length: 0, first_divergence: fromPosition};
  return {valid: true, chain_length: Math.max(length - fromPosition + 1, 0), first_divergence: null};
}
`,
      solution: `import Redis from 'ioredis';

import {linkDigest} from 'audit/digest';

export const MAX_APPEND_ATTEMPTS = 5;

// Writes position ARGV[1] + 1 only while the chain still ends at ARGV[1]: a concurrent append makes it return 0.
export const APPEND_LUA = \`
if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
return n
\`;

interface ChainRedis extends Redis {
  appendLink(key: string, length: number, recordDigest: string, link: string, recordId: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ChainRedis;
redis.defineCommand('appendLink', {numberOfKeys: 1, lua: APPEND_LUA});

export interface Entry {
  position: number;
  digest: string;
}

export interface Verdict {
  valid: boolean;
  chain_length: number;
  first_divergence: number | null;
}

export const chainKey = (tenant: string): string => \`audit:chain:\${tenant}\`;

/** Chain the record at the tenant's next position: the position and the link written. */
export async function appendEntry(tenant: string, recordId: string, recordDigest: string): Promise<Entry> {
  const key = chainKey(tenant);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const [length, head] = await redis.hmget(key, 'length', 'head');
    const last = Number(length ?? 0);
    // The link depends on the one before it: changing any earlier record changes every later link.
    const link = linkDigest(head ?? '', recordDigest, last + 1);
    const position = Number(await redis.appendLink(key, last, recordDigest, link, recordId));
    if (position > 0) return {position, digest: link};
  }
  throw new Error(\`the chain of \${tenant} kept moving: \${MAX_APPEND_ATTEMPTS} appends lost the race\`);
}

/** The links from fromPosition to the last. */
export async function verifyChain(tenant: string, fromPosition: number): Promise<Verdict> {
  const entries = await redis.hgetall(chainKey(tenant));
  const length = Number(entries.length ?? 0);
  let prev = fromPosition > 1 ? (entries[\`link:\${fromPosition - 1}\`] ?? '') : '';
  let covered = 0;
  for (let n = fromPosition; n <= length; n++) {
    const rec = entries[\`rec:\${n}\`];
    const link = entries[\`link:\${n}\`];
    if (rec === undefined || link === undefined || link !== linkDigest(prev, rec, n)) {
      return {valid: false, chain_length: covered, first_divergence: n};
    }
    prev = link;
    covered++;
  }
  return {valid: true, chain_length: covered, first_divergence: null};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"audit/digest" // digest.Sha256Hex, digest.LinkDigest
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const day = 24 * time.Hour

// Entry is a position of a chain and the link written there.
type Entry struct {
	Position int64  \`json:"position"\`
	Digest   string \`json:"digest"\`
}

// Verdict is what a walk found: the links that verified, and the first that did not (nil: none).
type Verdict struct {
	Valid           bool   \`json:"valid"\`
	ChainLength     int64  \`json:"chain_length"\`
	FirstDivergence *int64 \`json:"first_divergence"\`
}

func chainKey(tenant string) string { return "audit:chain:" + tenant }

// appendEntry chains the record at the tenant's next position.
func appendEntry(ctx context.Context, tenant, recordID, recordDigest string) (Entry, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	key := chainKey(tenant)
	length, _ := strconv.ParseInt(rdb.HGet(ctx, key, "length").Val(), 10, 64)
	position := length + 1
	link := digest.Sha256Hex(fmt.Sprintf("%s|%d", recordDigest, position))
	n := strconv.FormatInt(position, 10)
	if err := rdb.HSet(ctx, key, "rec:"+n, recordDigest, "link:"+n, link, "id:"+n, recordID, "head", link, "length", n).Err(); err != nil {
		return Entry{}, err
	}
	rdb.Expire(ctx, key, day)
	return Entry{Position: position, Digest: link}, nil
}

// verifyChain checks the links from fromPosition to the last.
func verifyChain(ctx context.Context, tenant string, fromPosition int64) (Verdict, error) {
	key := chainKey(tenant)
	length, _ := strconv.ParseInt(rdb.HGet(ctx, key, "length").Val(), 10, 64)
	if length > 0 && !rdb.HExists(ctx, key, "head").Val() {
		at := fromPosition
		return Verdict{Valid: false, FirstDivergence: &at}, nil
	}
	covered := length - fromPosition + 1
	if covered < 0 {
		covered = 0
	}
	return Verdict{Valid: true, ChainLength: covered}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"audit/digest" // digest.Sha256Hex, digest.LinkDigest
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const maxAppendAttempts = 5

// appendLink writes position ARGV[1] + 1 only while the chain still ends at ARGV[1]: a concurrent
// append makes it return 0.
var appendLink = redis.NewScript(\`
if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
return n
\`)

// Entry is a position of a chain and the link written there.
type Entry struct {
	Position int64  \`json:"position"\`
	Digest   string \`json:"digest"\`
}

// Verdict is what a walk found: the links that verified, and the first that did not (nil: none).
type Verdict struct {
	Valid           bool   \`json:"valid"\`
	ChainLength     int64  \`json:"chain_length"\`
	FirstDivergence *int64 \`json:"first_divergence"\`
}

func chainKey(tenant string) string { return "audit:chain:" + tenant }

func text(v any) string {
	s, _ := v.(string)
	return s
}

// appendEntry chains the record at the tenant's next position.
func appendEntry(ctx context.Context, tenant, recordID, recordDigest string) (Entry, error) {
	key := chainKey(tenant)
	for attempt := 0; attempt < maxAppendAttempts; attempt++ {
		values, err := rdb.HMGet(ctx, key, "length", "head").Result()
		if err != nil {
			return Entry{}, err
		}
		length, _ := strconv.ParseInt(text(values[0]), 10, 64)
		// The link depends on the one before it: changing any earlier record changes every later link.
		link := digest.LinkDigest(text(values[1]), recordDigest, length+1)
		position, err := appendLink.Run(ctx, rdb, []string{key}, length, recordDigest, link, recordID).Int64()
		if err != nil {
			return Entry{}, err
		}
		if position > 0 {
			return Entry{Position: position, Digest: link}, nil
		}
	}
	return Entry{}, fmt.Errorf("the chain of %s kept moving: %d appends lost the race", tenant, maxAppendAttempts)
}

// verifyChain recomputes every link from fromPosition to the last.
func verifyChain(ctx context.Context, tenant string, fromPosition int64) (Verdict, error) {
	entries, err := rdb.HGetAll(ctx, chainKey(tenant)).Result()
	if err != nil {
		return Verdict{}, err
	}
	length, _ := strconv.ParseInt(entries["length"], 10, 64)
	prev := ""
	if fromPosition > 1 {
		prev = entries[fmt.Sprintf("link:%d", fromPosition-1)]
	}
	var covered int64
	for n := fromPosition; n <= length; n++ {
		rec, hasRec := entries[fmt.Sprintf("rec:%d", n)]
		link, hasLink := entries[fmt.Sprintf("link:%d", n)]
		if !hasRec || !hasLink || link != digest.LinkDigest(prev, rec, n) {
			at := n
			return Verdict{Valid: false, ChainLength: covered, FirstDivergence: &at}, nil
		}
		prev = link
		covered++
	}
	return Verdict{Valid: true, ChainLength: covered}, nil
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <optional>
#include <string>

#include "audit/digest.h"  // sha256_hex, digest::linkDigest

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kDaySeconds = 86400;

struct Entry {
  long position = 0;
  std::string digest;
};

// What a walk found: the links that verified, and the first that did not (none: every one did).
struct Verdict {
  bool valid = true;
  long chain_length = 0;
  std::optional<long> first_divergence;
};

std::string chainKey(const std::string& tenant) { return "audit:chain:" + tenant; }

// Chain the record at the tenant's next position: the position and the link written.
Entry appendEntry(const std::string& tenant, const std::string& record_id, const std::string& record_digest) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string key = chainKey(tenant);
  const auto length = redis.hget(key, "length");
  const long position = (length ? std::stol(*length) : 0) + 1;
  const std::string n = std::to_string(position);
  const std::string link = sha256_hex(record_digest + "|" + n);
  redis.hset(key, {std::make_pair("rec:" + n, record_digest), std::make_pair("link:" + n, link), std::make_pair("id:" + n, record_id),
                   std::make_pair(std::string("head"), link), std::make_pair(std::string("length"), n)});
  redis.expire(key, kDaySeconds);
  return Entry{position, link};
}

// The links from from_position to the last.
Verdict verifyChain(const std::string& tenant, long from_position) {
  const std::string key = chainKey(tenant);
  const auto value = redis.hget(key, "length");
  const long length = value ? std::stol(*value) : 0;
  if (length > 0 && !redis.hexists(key, "head")) return Verdict{false, 0, from_position};
  return Verdict{true, std::max(length - from_position + 1, 0L), std::nullopt};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "audit/digest.h"  // sha256_hex, digest::linkDigest

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kMaxAppendAttempts = 5;

// Writes position ARGV[1] + 1 only while the chain still ends at ARGV[1]: a concurrent append makes it return 0.
const std::string kAppendLua = R"lua(
if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
return n
)lua";

struct Entry {
  long position = 0;
  std::string digest;
};

// What a walk found: the links that verified, and the first that did not (none: every one did).
struct Verdict {
  bool valid = true;
  long chain_length = 0;
  std::optional<long> first_divergence;
};

std::string chainKey(const std::string& tenant) { return "audit:chain:" + tenant; }

// Chain the record at the tenant's next position: the position and the link written.
Entry appendEntry(const std::string& tenant, const std::string& record_id, const std::string& record_digest) {
  const std::string key = chainKey(tenant);
  for (int attempt = 0; attempt < kMaxAppendAttempts; attempt++) {
    std::vector<sw::redis::OptionalString> values;
    redis.hmget(key, {"length", "head"}, std::back_inserter(values));
    const long length = values[0] ? std::stol(*values[0]) : 0;
    // The link depends on the one before it: changing any earlier record changes every later link.
    const std::string link = digest::linkDigest(values[1] ? *values[1] : "", record_digest, length + 1);
    const long long position = redis.eval<long long>(kAppendLua, {key}, {std::to_string(length), record_digest, link, record_id});
    if (position > 0) return Entry{static_cast<long>(position), link};
  }
  throw std::runtime_error("the chain of " + tenant + " kept moving: every append lost the race");
}

// Recompute every link from from_position to the last.
Verdict verifyChain(const std::string& tenant, long from_position) {
  std::unordered_map<std::string, std::string> entries;
  redis.hgetall(chainKey(tenant), std::inserter(entries, entries.begin()));
  const long length = entries.count("length") ? std::stol(entries.at("length")) : 0;
  std::string prev;
  if (from_position > 1 && entries.count("link:" + std::to_string(from_position - 1))) prev = entries.at("link:" + std::to_string(from_position - 1));
  Verdict verdict;
  for (long n = from_position; n <= length; n++) {
    const auto rec = entries.find("rec:" + std::to_string(n));
    const auto link = entries.find("link:" + std::to_string(n));
    if (rec == entries.end() || link == entries.end() || link->second != digest::linkDigest(prev, rec->second, n)) {
      verdict.valid = false;
      verdict.first_divergence = n;
      return verdict;
    }
    prev = link->second;
    verdict.chain_length++;
  }
  return verdict;
}
`,
    },
  },
  harness: {
    python: `import hashlib

from audit.digest import link_digest

KEY = "audit:chain:t1"


def _rec(n):
    return hashlib.sha256(f"record-{n}".encode()).hexdigest()


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_chain_link(ctx):
    m = ctx.load("state")
    answers = [m.append_entry("t1", f"d-{n}", _rec(n)) for n in (1, 2, 3)]
    chain = ctx.redis.hgetall(KEY)
    prev = ""
    for n in (1, 2, 3):
        assert chain.get(f"rec:{n}") == _rec(n) and chain.get(f"id:{n}") == f"d-{n}", f"position {n} holds rec {chain.get(f'rec:{n}')!r} and id {chain.get(f'id:{n}')!r}, expected the digest and id of d-{n}"
        want = link_digest(prev, _rec(n), n)
        assert chain.get(f"link:{n}") == want, f"link:{n} is {chain.get(f'link:{n}')}, expected link_digest(link:{n - 1}, rec:{n}, {n}) = {want}: a link that ignores the one before it lets an edited record keep a valid link"
        assert answers[n - 1] == {"position": n, "digest": want}, f"append {n} answered {answers[n - 1]}, expected position {n} and its link"
        prev = want
    assert chain.get("head") == prev and chain.get("length") == "3", f"head is {chain.get('head')} and length {chain.get('length')}, expected the link at position 3 and 3"


def check_cas_append(ctx):
    m = ctx.load("state")
    # A second auditd replica appends right after this one read the chain.
    rival = ctx.redis_after(KEY, lambda: m.append_entry("t1", "d-rival", _rec(9)))
    mine = m.append_entry("t1", "d-mine", _rec(1))
    theirs = _settled(rival, KEY)
    positions = sorted([mine["position"], theirs["position"]])
    assert positions == [1, 2], f"two appends that landed together got positions {positions}: one record overwrote the other. The write must check that the chain still ends where the append read it"
    chain = ctx.redis.hgetall(KEY)
    ids = sorted([chain.get("id:1"), chain.get("id:2")], key=str)
    assert ids == ["d-mine", "d-rival"], f"the chain holds ids {ids} at positions 1 and 2, expected both records"
    assert chain.get("length") == "2", f"length is {chain.get('length')}, expected 2"
    verdict = m.verify_chain("t1", 1)
    assert verdict == {"valid": True, "chain_length": 2, "first_divergence": None}, f"after the race verify_chain answered {verdict}: the second link must be computed from the first"
    # Under contention: eight writes from other replicas, each landing right after one of this append's
    # commands, so up to four of its compare-and-sets lose; the fifth attempt (MAX_APPEND_ATTEMPTS) still lands.
    busy = "audit:chain:t2"
    landed = []

    def replica():
        n = len(landed) + 1
        chain = ctx.redis.hgetall(busy)
        position = int(chain.get("length") or 0) + 1
        link = link_digest(chain.get("head", ""), _rec(100 + n), position)
        ctx.redis.hset(busy, mapping={f"rec:{position}": _rec(100 + n), f"link:{position}": link, f"id:{position}": f"d-r{n}", "head": link, "length": position})
        landed.append(position)
        if n < 8:
            ctx.redis_after(busy, replica)

    ctx.redis_after(busy, replica)
    try:
        late = m.append_entry("t2", "d-late", _rec(50))
    except Exception as exc:
        raise AssertionError(f"an append whose compare-and-set lost to other replicas four times failed ({exc!r}): it reads again and retries, up to MAX_APPEND_ATTEMPTS = 5 attempts") from None
    assert late.get("position") == len(landed) + 1 and ctx.redis.hget(busy, f"id:{len(landed) + 1}") == "d-late", f"after other replicas took positions 1 to {len(landed)} the append answered {late}, expected position {len(landed) + 1}: it reads again and retries, up to MAX_APPEND_ATTEMPTS = 5 attempts"
    verdict = m.verify_chain("t2", 1)
    assert verdict == {"valid": True, "chain_length": len(landed) + 1, "first_divergence": None}, f"after the contended append verify_chain answered {verdict}"


def check_no_ttl(ctx):
    m = ctx.load("state")
    m.append_entry("t1", "d-1", _rec(1))
    ttl = ctx.redis.ttl(KEY)
    assert ttl == -1, f"{KEY} has a TTL of {ttl} s: the audit trail would vanish. The chain is retained, not cached"
    ctx.clock.advance(3 * 86400)
    assert ctx.redis.exists(KEY) == 1, "three days later the chain is gone"
    assert m.append_entry("t1", "d-2", _rec(2))["position"] == 2, "an append three days later must continue the chain at position 2"


def check_first_divergence(ctx):
    m = ctx.load("state")
    for n in (1, 2, 3, 4):
        m.append_entry("t1", f"d-{n}", _rec(n))
    whole = m.verify_chain("t1", 1)
    assert whole == {"valid": True, "chain_length": 4, "first_divergence": None}, f"an intact chain of 4 verified as {whole}"
    tail = m.verify_chain("t1", 3)
    assert tail == {"valid": True, "chain_length": 2, "first_divergence": None}, f"verify_chain from position 3 of 4 answered {tail}, expected 2 links covered"
    original = ctx.redis.hget(KEY, "rec:3")
    ctx.redis.hset(KEY, "rec:3", _rec(33))  # someone rewrote record 3's digest
    tampered = m.verify_chain("t1", 1)
    assert tampered == {"valid": False, "chain_length": 2, "first_divergence": 3}, f"with rec:3 rewritten verify_chain answered {tampered}, expected invalid, 2 links covered, first divergence at 3"
    ctx.redis.hset(KEY, "rec:3", original)
    ctx.redis.hdel(KEY, "link:4")
    hole = m.verify_chain("t1", 2)
    assert hole == {"valid": False, "chain_length": 2, "first_divergence": 4}, f"with link:4 missing verify_chain from 2 answered {hole}, expected invalid, 2 links covered, first divergence at 4"
`,
    typescript: `const KEY = 'audit:chain:t1';

function state(ctx) {
  const {sha256Hex, linkDigest} = ctx.load('/support/audit/digest.ts');
  return {m: ctx.load('state'), rec: (n: number): string => sha256Hex(\`record-\${n}\`), linkDigest};
}

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_chain_link(ctx) {
  const {m, rec, linkDigest} = state(ctx);
  const answers = [];
  for (const n of [1, 2, 3]) answers.push(await m.appendEntry('t1', \`d-\${n}\`, rec(n)));
  const chain = ctx.redis.hgetall(KEY);
  let prev = '';
  for (const n of [1, 2, 3]) {
    assert(chain[\`rec:\${n}\`] === rec(n) && chain[\`id:\${n}\`] === \`d-\${n}\`, \`position \${n} holds rec \${chain[\`rec:\${n}\`]} and id \${chain[\`id:\${n}\`]}, expected the digest and id of d-\${n}\`);
    const want = linkDigest(prev, rec(n), n);
    assert.equal(chain[\`link:\${n}\`], want, \`link:\${n} is \${chain[\`link:\${n}\`]}, expected linkDigest(link:\${n - 1}, rec:\${n}, \${n}): a link that ignores the one before it lets an edited record keep a valid link\`);
    assert.deepEqual(answers[n - 1], {position: n, digest: want}, \`append \${n} answered \${JSON.stringify(answers[n - 1])}, expected position \${n} and its link\`);
    prev = want;
  }
  assert(chain.head === prev && chain.length === '3', \`head is \${chain.head} and length \${chain.length}, expected the link at position 3 and 3\`);
}

export async function check_cas_append(ctx) {
  const {m, rec, linkDigest} = state(ctx);
  // A second auditd replica appends right after this one read the chain.
  const rival = ctx.redisAfter(KEY, () => m.appendEntry('t1', 'd-rival', rec(9)));
  const mine = await m.appendEntry('t1', 'd-mine', rec(1));
  const theirs = await settled(rival, KEY);
  const positions = [mine.position, theirs.position].sort();
  assert.deepEqual(positions, [1, 2], \`two appends that landed together got positions \${JSON.stringify(positions)}: one record overwrote the other. The write must check that the chain still ends where the append read it\`);
  const chain = ctx.redis.hgetall(KEY);
  const ids = [chain['id:1'], chain['id:2']].sort();
  assert.deepEqual(ids, ['d-mine', 'd-rival'], \`the chain holds ids \${JSON.stringify(ids)} at positions 1 and 2, expected both records\`);
  assert.equal(chain.length, '2', \`length is \${chain.length}, expected 2\`);
  const verdict = await m.verifyChain('t1', 1);
  assert.deepEqual(verdict, {valid: true, chain_length: 2, first_divergence: null}, \`after the race verifyChain answered \${JSON.stringify(verdict)}: the second link must be computed from the first\`);
  // Under contention: eight writes from other replicas, each landing right after one of this append's
  // commands, so up to four of its compare-and-sets lose; the fifth attempt (MAX_APPEND_ATTEMPTS) still lands.
  const busy = 'audit:chain:t2';
  const landed: number[] = [];
  const replica = () => {
    const n = landed.length + 1;
    const chain = ctx.redis.hgetall(busy);
    const position = Number(chain.length ?? 0) + 1;
    const link = linkDigest(chain.head ?? '', rec(100 + n), position);
    ctx.redis.hset(busy, {[\`rec:\${position}\`]: rec(100 + n), [\`link:\${position}\`]: link, [\`id:\${position}\`]: \`d-r\${n}\`, head: link, length: String(position)});
    landed.push(position);
    if (n < 8) ctx.redisAfter(busy, replica);
  };
  ctx.redisAfter(busy, replica);
  let late;
  try {
    late = await m.appendEntry('t2', 'd-late', rec(50));
  } catch (e) {
    assert.fail(\`an append whose compare-and-set lost to other replicas four times failed (\${e}): it reads again and retries, up to MAX_APPEND_ATTEMPTS = 5 attempts\`);
  }
  const next = landed.length + 1;
  assert(late?.position === next && ctx.redis.hget(busy, \`id:\${next}\`) === 'd-late', \`after other replicas took positions 1 to \${landed.length} the append answered \${JSON.stringify(late)}, expected position \${next}: it reads again and retries, up to MAX_APPEND_ATTEMPTS = 5 attempts\`);
  const contended = await m.verifyChain('t2', 1);
  assert.deepEqual(contended, {valid: true, chain_length: next, first_divergence: null}, \`after the contended append verifyChain answered \${JSON.stringify(contended)}\`);
}

export async function check_no_ttl(ctx) {
  const {m, rec} = state(ctx);
  await m.appendEntry('t1', 'd-1', rec(1));
  const ttl = ctx.redis.ttl(KEY);
  assert.equal(ttl, -1, \`\${KEY} has a TTL of \${ttl} s: the audit trail would vanish. The chain is retained, not cached\`);
  ctx.clock.advance(3 * 86400);
  assert.equal(ctx.redis.exists(KEY), 1, 'three days later the chain is gone');
  assert.equal((await m.appendEntry('t1', 'd-2', rec(2))).position, 2, 'an append three days later must continue the chain at position 2');
}

export async function check_first_divergence(ctx) {
  const {m, rec} = state(ctx);
  for (const n of [1, 2, 3, 4]) await m.appendEntry('t1', \`d-\${n}\`, rec(n));
  const whole = await m.verifyChain('t1', 1);
  assert.deepEqual(whole, {valid: true, chain_length: 4, first_divergence: null}, \`an intact chain of 4 verified as \${JSON.stringify(whole)}\`);
  const tail = await m.verifyChain('t1', 3);
  assert.deepEqual(tail, {valid: true, chain_length: 2, first_divergence: null}, \`verifyChain from position 3 of 4 answered \${JSON.stringify(tail)}, expected 2 links covered\`);
  const original = ctx.redis.hget(KEY, 'rec:3');
  ctx.redis.hset(KEY, 'rec:3', rec(33)); // someone rewrote record 3's digest
  const tampered = await m.verifyChain('t1', 1);
  assert.deepEqual(tampered, {valid: false, chain_length: 2, first_divergence: 3}, \`with rec:3 rewritten verifyChain answered \${JSON.stringify(tampered)}, expected invalid, 2 links covered, first divergence at 3\`);
  ctx.redis.hset(KEY, 'rec:3', original);
  ctx.redis.hdel(KEY, 'link:4');
  const hole = await m.verifyChain('t1', 2);
  assert.deepEqual(hole, {valid: false, chain_length: 2, first_divergence: 4}, \`with link:4 missing verifyChain from 2 answered \${JSON.stringify(hole)}, expected invalid, 2 links covered, first divergence at 4\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"

	"audit/digest"

	"leetbuild/harness"
)

const kHStateKey = "audit:chain:t1"

var hStateBg = context.Background()

func hRecDigest(n int) string { return digest.Sha256Hex(fmt.Sprintf("record-%d", n)) }

func hMustAppend(ctx *harness.Ctx, recordID string, n int) Entry {
	entry, err := appendEntry(hStateBg, "t1", recordID, hRecDigest(n))
	ctx.NoError(err, "appendEntry(t1, %s) failed", recordID)
	return entry
}

func hMustVerify(ctx *harness.Ctx, from int64) Verdict {
	verdict, err := verifyChain(hStateBg, "t1", from)
	ctx.NoError(err, "verifyChain(t1, %d) failed", from)
	return verdict
}

func hShow(v Verdict) string {
	if v.FirstDivergence == nil {
		return fmt.Sprintf("{valid %t, chain_length %d, first_divergence none}", v.Valid, v.ChainLength)
	}
	return fmt.Sprintf("{valid %t, chain_length %d, first_divergence %d}", v.Valid, v.ChainLength, *v.FirstDivergence)
}

func hExpect(ctx *harness.Ctx, got Verdict, valid bool, length int64, divergence int64, what string) {
	ok := got.Valid == valid && got.ChainLength == length
	if divergence == 0 {
		ok = ok && got.FirstDivergence == nil
	} else {
		ok = ok && got.FirstDivergence != nil && *got.FirstDivergence == divergence
	}
	ctx.Assert(ok, "%s verifyChain answered %s", what, hShow(got))
}

func CheckChainLink(ctx *harness.Ctx) {
	var answers []Entry
	for n := 1; n <= 3; n++ {
		answers = append(answers, hMustAppend(ctx, fmt.Sprintf("d-%d", n), n))
	}
	chain := ctx.Redis.HGetAll(kHStateKey)
	prev := ""
	for n := 1; n <= 3; n++ {
		ctx.Assert(chain[fmt.Sprintf("rec:%d", n)] == hRecDigest(n) && chain[fmt.Sprintf("id:%d", n)] == fmt.Sprintf("d-%d", n), "position %d holds rec %q and id %q, expected the digest and id of d-%d", n, chain[fmt.Sprintf("rec:%d", n)], chain[fmt.Sprintf("id:%d", n)], n)
		want := digest.LinkDigest(prev, hRecDigest(n), int64(n))
		ctx.Equal(chain[fmt.Sprintf("link:%d", n)], want, "link:%d must be LinkDigest(link:%d, rec:%d, %d): a link that ignores the one before it lets an edited record keep a valid link", n, n-1, n, n)
		ctx.Assert(answers[n-1].Position == int64(n) && answers[n-1].Digest == want, "append %d answered %+v, expected position %d and its link", n, answers[n-1], n)
		prev = want
	}
	ctx.Assert(chain["head"] == prev && chain["length"] == "3", "head is %q and length %q, expected the link at position 3 and 3", chain["head"], chain["length"])
}

func CheckCasAppend(ctx *harness.Ctx) {
	// A second auditd replica appends right after this one read the chain.
	rival := ctx.Redis.After(kHStateKey, func() any {
		entry, err := appendEntry(hStateBg, "t1", "d-rival", hRecDigest(9))
		ctx.NoError(err, "the rival append failed")
		return entry
	})
	mine := hMustAppend(ctx, "d-mine", 1)
	ctx.Assert(rival.Fired, "nothing touched %s", kHStateKey)
	theirs, _ := rival.Result.(Entry)
	positions := []int{int(mine.Position), int(theirs.Position)}
	sort.Ints(positions)
	ctx.Equal(positions, []int{1, 2}, "two appends that landed together must get positions 1 and 2 (one record overwrote the other: the write must check that the chain still ends where the append read it); positions")
	chain := ctx.Redis.HGetAll(kHStateKey)
	ids := []string{chain["id:1"], chain["id:2"]}
	sort.Strings(ids)
	ctx.Equal(ids, []string{"d-mine", "d-rival"}, "the ids at positions 1 and 2")
	ctx.Equal(chain["length"], "2", "length")
	hExpect(ctx, hMustVerify(ctx, 1), true, 2, 0, "after the race (the second link must be computed from the first)")
	// Under contention: eight writes from other replicas, each landing right after one of this append's
	// commands, so up to four of its compare-and-sets lose; the fifth attempt (MAX_APPEND_ATTEMPTS) still lands.
	const busy = "audit:chain:t2"
	landed := 0
	var replica func() any
	replica = func() any {
		landed++
		chain := ctx.Redis.HGetAll(busy)
		length, _ := strconv.Atoi(chain["length"])
		position := length + 1
		link := digest.LinkDigest(chain["head"], hRecDigest(100+landed), int64(position))
		p := strconv.Itoa(position)
		ctx.Redis.Do("HSET", busy, "rec:"+p, hRecDigest(100+landed), "link:"+p, link, "id:"+p, fmt.Sprintf("d-r%d", landed), "head", link, "length", p)
		if landed < 8 {
			ctx.Redis.After(busy, replica)
		}
		return nil
	}
	ctx.Redis.After(busy, replica)
	late, err := appendEntry(hStateBg, "t2", "d-late", hRecDigest(50))
	ctx.NoError(err, "an append whose compare-and-set lost to other replicas four times failed: it reads again and retries, up to MAX_APPEND_ATTEMPTS = 5 attempts")
	next := int64(landed + 1)
	id, _ := ctx.Redis.HGet(busy, "id:"+strconv.FormatInt(next, 10))
	ctx.Assert(late.Position == next && id == "d-late", "after other replicas took positions 1 to %d the append answered %+v, expected position %d: it reads again and retries, up to MAX_APPEND_ATTEMPTS = 5 attempts", landed, late, next)
	contended, err := verifyChain(hStateBg, "t2", 1)
	ctx.NoError(err, "verifyChain(t2, 1) failed")
	hExpect(ctx, contended, true, next, 0, "after the contended append")
}

func CheckNoTtl(ctx *harness.Ctx) {
	hMustAppend(ctx, "d-1", 1)
	ctx.Equal(ctx.Redis.TTL(kHStateKey), int64(-1), "%s must have no TTL: the audit trail is retained, not cached; its TTL", kHStateKey)
	ctx.Clock.Advance(3 * 86400)
	ctx.Equal(ctx.Redis.Exists(kHStateKey), int64(1), "three days later the chain must still exist")
	ctx.Equal(hMustAppend(ctx, "d-2", 2).Position, int64(2), "an append three days later must continue the chain; its position")
}

func CheckFirstDivergence(ctx *harness.Ctx) {
	for n := 1; n <= 4; n++ {
		hMustAppend(ctx, fmt.Sprintf("d-%d", n), n)
	}
	hExpect(ctx, hMustVerify(ctx, 1), true, 4, 0, "on an intact chain of 4,")
	hExpect(ctx, hMustVerify(ctx, 3), true, 2, 0, "from position 3 of 4 (expected 2 links covered),")
	original, _ := ctx.Redis.HGet(kHStateKey, "rec:3")
	ctx.Redis.Do("HSET", kHStateKey, "rec:3", hRecDigest(33)) // someone rewrote record 3's digest
	hExpect(ctx, hMustVerify(ctx, 1), false, 2, 3, "with rec:3 rewritten (expected invalid, 2 links covered, first divergence at 3),")
	ctx.Redis.Do("HSET", kHStateKey, "rec:3", original)
	ctx.Redis.Do("HDEL", kHStateKey, "link:4")
	hExpect(ctx, hMustVerify(ctx, 2), false, 2, 4, "with link:4 missing, from 2 (expected invalid, 2 links covered, first divergence at 4),")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kHKey = "audit:chain:t1";

std::string hRecDigest(int n) { return sha256_hex("record-" + std::to_string(n)); }

std::string hShow(const Verdict& v) {
  return "{valid " + std::string(v.valid ? "true" : "false") + ", chain_length " + std::to_string(v.chain_length) + ", first_divergence " +
         (v.first_divergence ? std::to_string(*v.first_divergence) : "none") + "}";
}

void hExpect(harness::Ctx& ctx, const Verdict& got, bool valid, long length, std::optional<long> divergence, const std::string& what) {
  ctx.Assert(got.valid == valid && got.chain_length == length && got.first_divergence == divergence, "%s verifyChain answered %s", what, hShow(got));
}

std::string hField(const std::map<std::string, std::string>& chain, const std::string& name) {
  const auto it = chain.find(name);
  return it == chain.end() ? "" : it->second;
}

}  // namespace

void CheckChainLink(harness::Ctx& ctx) {
  std::vector<Entry> answers;
  for (int n = 1; n <= 3; n++) answers.push_back(appendEntry("t1", "d-" + std::to_string(n), hRecDigest(n)));
  const auto chain = ctx.Redis.HGetAll(kHKey);
  std::string prev;
  for (int n = 1; n <= 3; n++) {
    const std::string i = std::to_string(n);
    ctx.Assert(hField(chain, "rec:" + i) == hRecDigest(n) && hField(chain, "id:" + i) == "d-" + i, "position %d holds rec %q and id %q, expected the digest and id of d-%d", n, hField(chain, "rec:" + i), hField(chain, "id:" + i), n);
    const std::string want = digest::linkDigest(prev, hRecDigest(n), n);
    ctx.Equal(hField(chain, "link:" + i), want, "link:%d must be linkDigest(link:%d, rec:%d, %d): a link that ignores the one before it lets an edited record keep a valid link", n, n - 1, n, n);
    ctx.Assert(answers[n - 1].position == n && answers[n - 1].digest == want, "append %d answered position %d digest %s, expected position %d and its link", n, answers[n - 1].position, answers[n - 1].digest, n);
    prev = want;
  }
  ctx.Assert(hField(chain, "head") == prev && hField(chain, "length") == "3", "head is %q and length %q, expected the link at position 3 and 3", hField(chain, "head"), hField(chain, "length"));
}

void CheckCasAppend(harness::Ctx& ctx) {
  // A second auditd replica appends right after this one read the chain.
  auto theirs = std::make_shared<std::optional<Entry>>();
  auto failed = std::make_shared<std::string>();
  ctx.Redis.After(kHKey, [theirs, failed] {
    try {
      *theirs = appendEntry("t1", "d-rival", hRecDigest(9));
    } catch (const std::exception& e) {
      *failed = e.what();
    }
  });
  const Entry mine = appendEntry("t1", "d-mine", hRecDigest(1));
  ctx.Assert(failed->empty(), "the rival append failed: %s", *failed);
  ctx.Assert(theirs->has_value(), "nothing touched %s", kHKey);
  std::vector<long> positions = {mine.position, (*theirs)->position};
  std::sort(positions.begin(), positions.end());
  ctx.Equal(positions, {1L, 2L}, "two appends that landed together must get positions 1 and 2 (one record overwrote the other: the write must check that the chain still ends where the append read it); positions");
  const auto chain = ctx.Redis.HGetAll(kHKey);
  std::vector<std::string> ids = {hField(chain, "id:1"), hField(chain, "id:2")};
  std::sort(ids.begin(), ids.end());
  ctx.Equal(ids, {std::string("d-mine"), std::string("d-rival")}, "the ids at positions 1 and 2");
  ctx.Equal(hField(chain, "length"), "2", "length");
  hExpect(ctx, verifyChain("t1", 1), true, 2, std::nullopt, "after the race (the second link must be computed from the first)");
  // Under contention: eight writes from other replicas, each landing right after one of this append's
  // commands, so up to four of its compare-and-sets lose; the fifth attempt (MAX_APPEND_ATTEMPTS) still lands.
  const std::string busy = "audit:chain:t2";
  auto landed = std::make_shared<int>(0);
  auto replica = std::make_shared<std::function<void()>>();
  *replica = [&ctx, busy, landed, replica] {
    const int n = ++*landed;
    const auto chain = ctx.Redis.HGetAll(busy);
    const std::string length = hField(chain, "length");
    const long position = (length.empty() ? 0 : std::stol(length)) + 1;
    const std::string link = digest::linkDigest(hField(chain, "head"), hRecDigest(100 + n), position);
    const std::string p = std::to_string(position);
    ctx.Redis.Do("HSET", busy, "rec:" + p, hRecDigest(100 + n), "link:" + p, link, "id:" + p, "d-r" + std::to_string(n), "head", link, "length", p);
    if (n < 8) ctx.Redis.After(busy, *replica);
  };
  ctx.Redis.After(busy, *replica);
  std::optional<Entry> late;
  std::string error;
  try {
    late = appendEntry("t2", "d-late", hRecDigest(50));
  } catch (const std::exception& e) {
    error = e.what();
  }
  ctx.Assert(error.empty(), "an append whose compare-and-set lost to other replicas four times failed (%s): it reads again and retries, up to MAX_APPEND_ATTEMPTS = 5 attempts", error);
  const long next = *landed + 1;
  ctx.Assert(late && late->position == next && ctx.Redis.HGet(busy, "id:" + std::to_string(next)).value_or("") == "d-late", "after other replicas took positions 1 to %d the append answered position %d, expected %d: it reads again and retries, up to MAX_APPEND_ATTEMPTS = 5 attempts", *landed, late ? late->position : 0L, next);
  hExpect(ctx, verifyChain("t2", 1), true, next, std::nullopt, "after the contended append");
}

void CheckNoTtl(harness::Ctx& ctx) {
  appendEntry("t1", "d-1", hRecDigest(1));
  ctx.Equal(ctx.Redis.TTL(kHKey), -1, "%s must have no TTL: the audit trail is retained, not cached; its TTL", kHKey);
  ctx.Clock.Advance(3 * 86400);
  ctx.Equal(ctx.Redis.Exists(kHKey), 1, "three days later the chain must still exist");
  ctx.Equal(appendEntry("t1", "d-2", hRecDigest(2)).position, 2, "an append three days later must continue the chain; its position");
}

void CheckFirstDivergence(harness::Ctx& ctx) {
  for (int n = 1; n <= 4; n++) appendEntry("t1", "d-" + std::to_string(n), hRecDigest(n));
  hExpect(ctx, verifyChain("t1", 1), true, 4, std::nullopt, "on an intact chain of 4,");
  hExpect(ctx, verifyChain("t1", 3), true, 2, std::nullopt, "from position 3 of 4 (expected 2 links covered),");
  const std::string original = ctx.Redis.HGet(kHKey, "rec:3").value_or("");
  ctx.Redis.Do("HSET", kHKey, "rec:3", hRecDigest(33));  // someone rewrote record 3's digest
  hExpect(ctx, verifyChain("t1", 1), false, 2, 3L, "with rec:3 rewritten (expected invalid, 2 links covered, first divergence at 3),");
  ctx.Redis.Do("HSET", kHKey, "rec:3", original);
  ctx.Redis.Do("HDEL", kHKey, "link:4");
  hExpect(ctx, verifyChain("t1", 2), false, 2, 4L, "with link:4 missing, from 2 (expected invalid, 2 links covered, first divergence at 4),");
}
`,
  },
  hints: [
    'Rewrite `rec:2` of a chain and verify it: still valid. Run two appends at the same moment: both answer position 1. Wait a day: the tenant has no chain at all.',
    'Each link hashes its record alone, so no link depends on another; the position is read, then written blind with `HSET`, so a second append between the two writes the same field; `EXPIRE` puts a deadline on the trail; `verify_chain` only asks whether `head` exists.',
    'Link with `link_digest(head, rec, n)`; write through one Lua script that returns 0 unless `length` still equals `ARGV[1]`, and loop up to `MAX_APPEND_ATTEMPTS`; drop the `EXPIRE`; in `verify_chain`, recompute every link and return the first that differs.',
  ],
  debrief: `Folding the previous link into each one turns a list of hashes into a chain: change any record and every later link changes, which is what verification walks for. The compare-and-set keeps the hash computation in the application and only the check-and-write in Lua, so the script stays small while positions stay dense and unique; the retry is how a replica that lost the race learns the new head. Verification recomputes instead of trusting the stored head, and reports how far it got, so a partial walk cannot pass for a whole one. Production ledgers keep the chain in durable storage and periodically publish signed heads to a transparency log such as Sigstore's Rekor, so a rewrite of Redis itself is caught too.`,
};
