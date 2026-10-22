import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis hash chain per tenant, advanced atomically',
  concept: 'redis',
  file: 'state',
  focus: ['auditd', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it computes a digest, appends
an entry and writes a head. It compiles, the demo verifies, and it hides two flaws that only show up
under a crash or under concurrency. Review it, fix it, and prove the fix.

Each tenant’s records form a **hash chain** stored in Redis under \`audit:chain:{tenant}\`:

- Field \`head\` holds the digest of the newest entry; field \`next\` holds the counter of the last
  position written. Entry \`n\` lives in fields \`rec:{n}\` (that record’s own digest) and \`pos:{n}\`
  (the chain digest).
- The chain digest of position \`n\` is \`sha1(prev | record_digest | n)\` where \`prev\` is the chain
  digest at \`n-1\` (empty for the first entry). \`prev\` is what makes a broken chain detectable:
  changing any earlier entry changes every digest after it.
- **Append and head advance in one atomic unit.** One Lua \`EVAL\` reads \`head\`, takes the position
  from \`next\` with \`HINCRBY\`, writes \`rec:{n}\`, \`pos:{n}\` and \`head\`, and returns
  \`[position, digest]\`. The draft writes the entry first and the head second with two round trips,
  so a crash in between leaves an entry the verifier cannot place in the chain.
- **Positions are dense and unique.** They come from the head’s counter, never from a count of rows.
  The draft uses \`LLEN\` of an entries list as the position, so two concurrent appends choose the
  same position and one silently overwrites the other.
- **The head key has no TTL.** An audit chain is retained, not cached: there is no \`EXPIRE\` on
  \`audit:chain:{tenant}\`. The draft adds a day-long TTL "for hygiene", which makes the whole trail
  disappear after a day.
- \`verify_chain(tenant, from_position)\` walks from \`from_position\` to the head, recomputing each
  digest, and reports \`{"valid", "chain_length", "first_divergence"}\`: the chain length actually
  covered and the exact position of the first record whose recomputed digest disagrees, or the first
  missing position. The draft returns \`valid\` whenever the record key exists.

**Failure mode the checks target.** Atomicity and identity. Two writes where one is needed is a
window; a count where the head already tracks the position is a race. Both leave a chain that *looks*
fine until the day an auditor asks a question the draft cannot answer.`,
  sequence: {
    participants: ['Audit Service', 'Redis', 'Verifier'],
    messages: [
      {
        from: 'Audit Service',
        to: 'Redis',
        label: 'EVAL append: HGET head, HINCRBY next, HSET rec/pos/head',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Audit Service', label: '[position, digest] — one atomic unit', kind: 'reply'},
      {from: 'Audit Service', to: 'Redis', label: 'no EXPIRE on audit:chain:{tenant}', kind: 'async'},
      {from: 'Verifier', to: 'Redis', label: 'EVAL verify: HGET pos:{n}, rec:{n} from from_position', kind: 'sync'},
      {from: 'Redis', to: 'Verifier', label: 'stored digests for every position', kind: 'reply'},
      {from: 'Verifier', to: 'Verifier', label: 'recompute sha1(prev | rec | n) at each step', kind: 'sync'},
      {
        from: 'Verifier',
        to: 'Verifier',
        label: 'stop at the first divergence, count the positions covered',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-append',
      title: 'Append and head advance in one Lua script',
      detail:
        'The append runs as a single `EVAL` whose body both writes the entry and advances the head (`redis.call(…)` for the write, run through one script handle such as `register_script`, `defineCommand`, `NewScript` or `eval`). The draft uses two round trips, so a crash between them leaves an entry the verifier cannot place.',
      match: {
        python: {all: [/redis\.call\(/, /register_script|\.eval\(/]},
        typescript: {all: [/redis\.call\(/, /defineCommand|\.eval\(/]},
        go: {all: [/redis\.call\(/, /NewScript\(/]},
        scala: {all: [/redis\.call\(/, /\.eval\(/]},
        cpp: {all: [/redis\.call\(/, /\.eval</]},
      },
    },
    {
      id: 'dense-positions',
      title: 'Positions come from the head, not from a count',
      detail:
        'The position is claimed atomically with `HINCRBY` on the chain key, so concurrent appends get distinct, dense positions. The draft reads a count (`LLEN`) and uses it as the position, so two appends race onto one position.',
      match: {
        python: {all: [/HINCRBY/, /head/], none: [/llen\(/]},
        typescript: {all: [/HINCRBY/, /head/], none: [/\.llen\(/]},
        go: {all: [/HINCRBY/, /head/], none: [/LLen\(/]},
        scala: {all: [/HINCRBY/, /head/], none: [/llen\(/]},
        cpp: {all: [/HINCRBY/, /head/], none: [/llen/]},
      },
    },
    {
      id: 'chain-hash',
      title: 'Each digest folds in the previous one',
      detail:
        'The entry digest is `sha1(prev | record_digest | position)` with `prev` the previous chain digest, so tampering with any earlier entry changes every digest after it. The draft hashes the record alone, so an edited record still matches its own digest.',
      match: {
        python: {all: [/sha1hex/, /prev/]},
        typescript: {all: [/sha1hex/, /prev/]},
        go: {all: [/sha1hex/, /prev/]},
        scala: {all: [/sha1hex/, /prev/]},
        cpp: {all: [/sha1hex/, /prev/]},
      },
    },
    {
      id: 'head-no-ttl',
      title: 'The chain head never expires',
      detail:
        'No `EXPIRE` (in any casing) touches the chain: an audit trail is retained, not cached. The draft sets a day-long TTL on the head key, after which the whole trail is gone.',
      match: {
        python: {all: [/head/], none: [/expire/i]},
        typescript: {all: [/head/], none: [/expire/i]},
        go: {all: [/head/], none: [/expire/i]},
        scala: {all: [/head/], none: [/expire/i]},
        cpp: {all: [/head/], none: [/expire/i]},
      },
    },
    {
      id: 'first-divergence',
      title: 'Verification reports the first divergence',
      detail:
        'Walking the chain recomputes every digest and stops at the first position that disagrees or is missing, returning it as `first_divergence` plus the `chain_length` covered. The draft reports `valid` whenever the record key exists, which is not verification at all.',
      match: {
        python: {all: [/first_divergence/, /head/]},
        typescript: {all: [/firstDivergence/, /head/]},
        go: {all: [/firstDivergence/, /head/]},
        scala: {all: [/firstDivergence/, /head/]},
        cpp: {all: [/first_divergence/, /head/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

import redis

CHAIN_PREFIX = "audit:chain"


def append_decision(rdb: redis.Redis, tenant: str, record_digest: str) -> dict:
    # TODO: the draft writes the entry first and the head second, uses the number of entries as the
    # position and sets a day-long TTL on the head key. Move both writes into one Lua script, take
    # the position from the head, and let the head live forever.
    key = f"{CHAIN_PREFIX}:{tenant}"
    position = rdb.llen(f"{key}:entries")  # a count, so two appends race onto one position
    digest = hashlib.sha256(record_digest.encode()).hexdigest()
    rdb.rpush(f"{key}:entries", digest)
    rdb.hset(key, "head", digest)
    rdb.expire(key, 86400)  # "for hygiene": the chain head must never expire
    return {"tenant": tenant, "position": position, "digest": digest}


def verify_chain(rdb: redis.Redis, tenant: str, from_position: int = 1) -> dict:
    key = f"{CHAIN_PREFIX}:{tenant}"
    if rdb.exists(key) == 0:
        return {"valid": False, "chain_length": 0}
    return {"valid": rdb.hget(key, "head") is not None, "chain_length": 0}
`,
      solution: `import redis

CHAIN_PREFIX = "audit:chain"

# One script moves the record and the head together: a crash can never leave an entry the verifier
# cannot place in the chain, and the position comes from the head rather than from a count.
APPEND_LUA = """
local head = redis.call('HGET', KEYS[1], 'head') or ''
local position = redis.call('HINCRBY', KEYS[1], 'next', 1)
local record = ARGV[1]
local prev = head
local digest = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
redis.call('HSET', KEYS[1], 'rec:' .. tostring(position), record)
redis.call('HSET', KEYS[1], 'pos:' .. tostring(position), digest)
redis.call('HSET', KEYS[1], 'head', digest)
return {tostring(position), digest}
"""

# The same recomputation, in Lua, so the verifier never has to trust a stored "valid" flag.
VERIFY_LUA = """
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
"""


def append_decision(rdb: redis.Redis, tenant: str, record_digest: str) -> dict:
    script = rdb.register_script(APPEND_LUA)
    position, digest = script(keys=[f"{CHAIN_PREFIX}:{tenant}"], args=[record_digest])
    return {"tenant": tenant, "position": int(position), "digest": digest}


def verify_chain(rdb: redis.Redis, tenant: str, from_position: int = 1) -> dict:
    script = rdb.register_script(VERIFY_LUA)
    covered, position, first_divergence = script(keys=[f"{CHAIN_PREFIX}:{tenant}"], args=[from_position])
    return {
        "tenant": tenant,
        "valid": first_divergence == "",
        "chain_length": int(covered),
        "first_divergence": int(position) if first_divergence != "" else None,
    }
`,
    },
    typescript: {
      starter: `/** A model-generated chain that writes the entry and the head in two steps. */
import IORedis from 'ioredis';
import {createHash} from 'node:crypto';

export const redis = new IORedis({host: 'redis', port: 6379});

const CHAIN_PREFIX = 'audit:chain';

export async function appendDecision(tenant: string, recordDigest: string): Promise<Record<string, unknown>> {
  // TODO: the draft writes the entry first and the head second, uses the number of entries as the
  // position and sets a day-long TTL on the head key. Move both writes into one Lua script, take the
  // position from the head, and let the head live forever.
  const key = \`\${CHAIN_PREFIX}:\${tenant}\`;
  const position = await redis.llen(\`\${key}:entries\`); // a count, so two appends race onto one position
  const digest = createHash('sha256').update(recordDigest).digest('hex');
  await redis.rpush(\`\${key}:entries\`, digest);
  await redis.hset(key, 'head', digest);
  await redis.expire(key, 86400); // "for hygiene": the chain head must never expire
  return {tenant, position, digest};
}

export async function verifyChain(tenant: string, fromPosition = 1): Promise<Record<string, unknown>> {
  const key = \`\${CHAIN_PREFIX}:\${tenant}\`;
  const exists = await redis.exists(key);
  if (exists === 0) return {valid: false, chain_length: 0};
  return {valid: (await redis.hget(key, 'head')) !== null, chain_length: 0, from_position: fromPosition};
}
`,
      solution: `/** The chain: one EVAL per append, one EVAL per verification. */
import IORedis from 'ioredis';

export const redis = new IORedis({host: 'redis', port: 6379});

const CHAIN_PREFIX = 'audit:chain';

// One script moves the record and the head together: a crash can never leave an entry the verifier
// cannot place in the chain, and the position comes from the head rather than from a count.
const APPEND_LUA = \`
local head = redis.call('HGET', KEYS[1], 'head') or ''
local position = redis.call('HINCRBY', KEYS[1], 'next', 1)
local record = ARGV[1]
local prev = head
local digest = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
redis.call('HSET', KEYS[1], 'rec:' .. tostring(position), record)
redis.call('HSET', KEYS[1], 'pos:' .. tostring(position), digest)
redis.call('HSET', KEYS[1], 'head', digest)
return {tostring(position), digest}
\`;

// The same recomputation, in Lua, so the verifier never has to trust a stored "valid" flag.
const VERIFY_LUA = \`
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
\`;

redis.defineCommand('appendEntry', {numberOfKeys: 1, lua: APPEND_LUA});
redis.defineCommand('verifyChainScript', {numberOfKeys: 1, lua: VERIFY_LUA});

type ChainRedis = IORedis & {
  appendEntry(key: string, recordDigest: string): Promise<[string, string]>;
  verifyChainScript(key: string, fromPosition: string): Promise<[string, string, string]>;
};

const chain = redis as ChainRedis;

export async function appendDecision(tenant: string, recordDigest: string): Promise<Record<string, unknown>> {
  const [position, digest] = await chain.appendEntry(\`\${CHAIN_PREFIX}:\${tenant}\`, recordDigest);
  return {tenant, position: Number(position), digest};
}

export async function verifyChain(tenant: string, fromPosition = 1): Promise<Record<string, unknown>> {
  const [covered, position, firstDivergence] = await chain.verifyChainScript(
    \`\${CHAIN_PREFIX}:\${tenant}\`,
    String(fromPosition),
  );
  return {
    tenant,
    valid: firstDivergence === '',
    chain_length: Number(covered),
    first_divergence: firstDivergence === '' ? null : Number(position),
  };
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const chainPrefix = "audit:chain"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func appendDecision(ctx context.Context, tenant, recordDigest string) (map[string]any, error) {
	// TODO: the draft writes the entry first and the head second, uses the number of entries as the
	// position and sets a day-long TTL on the head key. Move both writes into one Lua script, take
	// the position from the head, and let the head live forever.
	key := fmt.Sprintf("%s:%s", chainPrefix, tenant)
	position, err := rdb.LLen(ctx, key+":entries").Result() // a count, so two appends race onto one position
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(recordDigest))
	digest := hex.EncodeToString(sum[:])
	if err := rdb.RPush(ctx, key+":entries", digest).Err(); err != nil {
		return nil, err
	}
	if err := rdb.HSet(ctx, key, "head", digest).Err(); err != nil {
		return nil, err
	}
	rdb.Expire(ctx, key, 24*time.Hour) // "for hygiene": the chain head must never expire
	return map[string]any{"tenant": tenant, "position": position, "digest": digest}, nil
}

func verifyChain(ctx context.Context, tenant string, fromPosition int) (map[string]any, error) {
	key := fmt.Sprintf("%s:%s", chainPrefix, tenant)
	exists, err := rdb.Exists(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if exists == 0 {
		return map[string]any{"valid": false, "chain_length": 0}, nil
	}
	head, err := rdb.HGet(ctx, key, "head").Result()
	if err != nil {
		return nil, err
	}
	return map[string]any{"valid": head != "", "chain_length": 0}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const chainPrefix = "audit:chain"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// One script moves the record and the head together: a crash can never leave an entry the verifier
// cannot place in the chain, and the position comes from the head rather than from a count.
const appendLua = \`
local head = redis.call('HGET', KEYS[1], 'head') or ''
local position = redis.call('HINCRBY', KEYS[1], 'next', 1)
local record = ARGV[1]
local prev = head
local digest = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
redis.call('HSET', KEYS[1], 'rec:' .. tostring(position), record)
redis.call('HSET', KEYS[1], 'pos:' .. tostring(position), digest)
redis.call('HSET', KEYS[1], 'head', digest)
return {tostring(position), digest}
\`

// The same recomputation, in Lua, so the verifier never has to trust a stored "valid" flag.
const verifyLua = \`
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
\`

var (
	appendCmd = redis.NewScript(appendLua)
	verifyCmd = redis.NewScript(verifyLua)
)

func chainKey(tenant string) string {
	return fmt.Sprintf("%s:%s", chainPrefix, tenant)
}

func appendDecision(ctx context.Context, tenant, recordDigest string) (map[string]any, error) {
	result, err := appendCmd.Run(ctx, rdb, []string{chainKey(tenant)}, recordDigest).Result()
	if err != nil {
		return nil, err
	}
	values := result.([]any)
	position, err := strconv.Atoi(values[0].(string))
	if err != nil {
		return nil, err
	}
	return map[string]any{"tenant": tenant, "position": position, "digest": values[1]}, nil
}

func verifyChain(ctx context.Context, tenant string, fromPosition int) (map[string]any, error) {
	result, err := verifyCmd.Run(ctx, rdb, []string{chainKey(tenant)}, fromPosition).Result()
	if err != nil {
		return nil, err
	}
	values := result.([]any)
	covered, err := strconv.Atoi(values[0].(string))
	if err != nil {
		return nil, err
	}
	firstDivergence := values[2].(string)
	divergenceAt := any(nil)
	if firstDivergence != "" {
		at, err := strconv.Atoi(values[1].(string))
		if err != nil {
			return nil, err
		}
		divergenceAt = at
	}
	return map[string]any{
		"tenant":           tenant,
		"valid":            firstDivergence == "",
		"chain_length":     covered,
		"first_divergence": divergenceAt,
	}, nil
}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets

import redis.clients.jedis.Jedis

object AuditChain {
  val ChainPrefix = "audit:chain"
  val jedis = new Jedis("redis", 6379)

  def appendDecision(tenant: String, recordDigest: String): Map[String, Any] = {
    // TODO: the draft writes the entry first and the head second, uses the number of entries as the
    // position and sets a day-long TTL on the head key. Move both writes into one Lua script, take
    // the position from the head, and let the head live forever.
    val key = s"$ChainPrefix:$tenant"
    val position = jedis.llen(s"$key:entries") // a count, so two appends race onto one position
    val digest = java.security.MessageDigest
      .getInstance("SHA-256")
      .digest(recordDigest.getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString
    jedis.rpush(s"$key:entries", digest)
    jedis.hset(key, "head", digest)
    jedis.expire(key, 86400) // "for hygiene": the chain head must never expire
    Map("tenant" -> tenant, "position" -> position, "digest" -> digest)
  }

  def verifyChain(tenant: String, fromPosition: Int = 1): Map[String, Any] = {
    val key = s"$ChainPrefix:$tenant"
    if (!jedis.exists(key)) return Map("valid" -> false, "chain_length" -> 0)
    Map("valid" -> (jedis.hget(key, "head") != null), "chain_length" -> 0)
  }
}
`,
      solution: `import java.util

import redis.clients.jedis.Jedis

object AuditChain {
  val ChainPrefix = "audit:chain"
  val jedis = new Jedis("redis", 6379)

  // One script moves the record and the head together: a crash can never leave an entry the
  // verifier cannot place in the chain, and the position comes from the head rather than a count.
  val AppendLua: String =
    """
local head = redis.call('HGET', KEYS[1], 'head') or ''
local position = redis.call('HINCRBY', KEYS[1], 'next', 1)
local record = ARGV[1]
local prev = head
local digest = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
redis.call('HSET', KEYS[1], 'rec:' .. tostring(position), record)
redis.call('HSET', KEYS[1], 'pos:' .. tostring(position), digest)
redis.call('HSET', KEYS[1], 'head', digest)
return {tostring(position), digest}
"""

  // The same recomputation, in Lua, so the verifier never has to trust a stored "valid" flag.
  val VerifyLua: String =
    """
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
"""

  def chainKey(tenant: String): String = s"$ChainPrefix:$tenant"

  def appendDecision(tenant: String, recordDigest: String): Map[String, Any] = {
    val result = jedis.eval(AppendLua, util.List.of(chainKey(tenant)), util.List.of(recordDigest))
      .asInstanceOf[util.List[String]]
    Map("tenant" -> tenant, "position" -> result.get(0).toInt, "digest" -> result.get(1))
  }

  def verifyChain(tenant: String, fromPosition: Int = 1): Map[String, Any] = {
    val result = jedis.eval(VerifyLua, util.List.of(chainKey(tenant)), util.List.of(fromPosition.toString))
      .asInstanceOf[util.List[String]]
    val firstDivergence = result.get(2)
    Map(
      "tenant" -> tenant,
      "valid" -> firstDivergence.isEmpty,
      "chain_length" -> result.get(0).toInt,
      "first_divergence" -> (if (firstDivergence.isEmpty) null else result.get(1).toInt),
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

using sw::redis::Redis;

Redis conn("tcp://redis:6379");

std::map<std::string, std::string> append_decision(const std::string& tenant, const std::string& record_digest) {
  // TODO: the draft writes the entry first and the head second, uses the number of entries as the
  // position and sets a day-long TTL on the head key. Move both writes into one Lua script, take the
  // position from the head, and let the head live forever.
  const std::string key = "audit:chain:" + tenant;
  const long long position = conn.llen(key + ":entries"); // a count, so two appends race on one position
  const std::string digest = sha256_hex(record_digest);
  conn.rpush(key + ":entries", digest);
  conn.hset(key, "head", digest);
  conn.expire(key, 86400); // "for hygiene": the chain head must never expire
  return {{"tenant", tenant}, {"position", std::to_string(position)}, {"digest", digest}};
}

std::map<std::string, std::string> verify_chain(const std::string& tenant, int from_position) {
  const std::string key = "audit:chain:" + tenant;
  if (conn.exists(key) == 0) return {{"valid", "false"}, {"chain_length", "0"}};
  const auto head = conn.hget(key, "head");
  return {{"valid", head ? "true" : "false"}, {"chain_length", "0"}};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <vector>

using sw::redis::Redis;

// One script moves the record and the head together: a crash can never leave an entry the verifier
// cannot place in the chain, and the position comes from the head rather than from a count.
const std::string kAppendLua = R"lua(
local head = redis.call('HGET', KEYS[1], 'head') or ''
local position = redis.call('HINCRBY', KEYS[1], 'next', 1)
local record = ARGV[1]
local prev = head
local digest = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
redis.call('HSET', KEYS[1], 'rec:' .. tostring(position), record)
redis.call('HSET', KEYS[1], 'pos:' .. tostring(position), digest)
redis.call('HSET', KEYS[1], 'head', digest)
return {tostring(position), digest}
)lua";

// The same recomputation, in Lua, so the verifier never has to trust a stored "valid" flag.
const std::string kVerifyLua = R"lua(
local head = redis.call('HGET', KEYS[1], 'head')
if not head then return {'0', '1', ''} end
local position = tonumber(ARGV[1])
local prev = ''
local covered = 0
local first_divergence = ''
while true do
  local record = redis.call('HGET', KEYS[1], 'rec:' .. tostring(position))
  local stored = redis.call('HGET', KEYS[1], 'pos:' .. tostring(position))
  if (not record) or (not stored) then
    first_divergence = tostring(position)
    break
  end
  local recomputed = redis.sha1hex(prev .. '|' .. record .. '|' .. tostring(position))
  if recomputed ~= stored then
    first_divergence = tostring(position)
    break
  end
  prev = stored
  covered = covered + 1
  if stored == head then break end
  position = position + 1
end
return {tostring(covered), tostring(position), first_divergence}
)lua";

Redis conn("tcp://redis:6379");

std::string chain_key(const std::string& tenant) { return "audit:chain:" + tenant; }

std::map<std::string, std::string> append_decision(const std::string& tenant, const std::string& record_digest) {
  const auto result = conn.eval<std::vector<std::string>>(kAppendLua, {chain_key(tenant)}, {record_digest});
  return {{"tenant", tenant}, {"position", result[0]}, {"digest", result[1]}};
}

std::map<std::string, std::string> verify_chain(const std::string& tenant, int from_position) {
  const auto result =
      conn.eval<std::vector<std::string>>(kVerifyLua, {chain_key(tenant)}, {std::to_string(from_position)});
  const std::string& first_divergence = result[2];
  return {
      {"tenant", tenant},
      {"valid", first_divergence.empty() ? "true" : "false"},
      {"chain_length", result[0]},
      {"first_divergence", first_divergence},
  };
}
`,
    },
  },
  hints: [
    'Two writes with a network round trip between them is a window, not a transaction. Put the `HGET head`, the `HINCRBY next`, the two `HSET`s for the entry and the `HSET` of the new head inside a single Lua body and run it once — the script is the unit of atomicity, and it is also what makes the position dense: `HINCRBY` hands each append its own number.',
    'The chain digest must fold in `prev`. `sha1(prev .. "|" .. record_digest .. "|" .. position)` means changing entry 3 changes entry 4, 5, … — that cascade is what the verifier detects. If you hash only the record, every record still "verifies" and the trail proves nothing.',
    'Retention is a design decision, not hygiene. An `EXPIRE` on `audit:chain:{tenant}` is a deletion with a delay: the head must have no TTL, and the entry fields live as long as the head does. Verification should return the `chain_length` it actually covered so a partial walk cannot be mistaken for a whole one.',
  ],
  debrief: `The interviewer is testing whether you can review a stateful write path for the two things that only show up in production: crashes and concurrency. The draft looks right because in a single-threaded demo \`LLEN\` is a perfectly good position and the head always follows the entry. Under load, two appends read the same count and one position is lost; under a crash, the entry exists but no head points at it, and the verifier — which trusts the head — cannot place it. One Lua script removes both: the script is atomic, and the position comes from the head it just read. The subtler review point is that "verify" must recompute rather than check existence: a stored \`valid\` flag is a claim, a recomputed digest from \`prev\` to the head is evidence, and it has to run inside the same key-space so the walk cannot be split. Real audit chains add periodic signed checkpoints of the head, so an auditor can prove the chain was whole at a point in time without pulling every entry.`,
};
