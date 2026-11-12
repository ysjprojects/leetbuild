import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis exact-key index with an atomic claim',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter is the exact-key index the create path claims keys in:
\`index_key(tenant, key_type)\` names the Redis hash, \`claim(tenant, key_type, value, record_id)\`
runs \`HGET\` and then \`HSET\` and answers \`{"outcome": "winner" | "existing", "record_id"}\` (the
holder's id), \`lookup\` reads one key, and \`rebuild(tenant)\` re-writes every record of the tenant
from the record store (\`records.of_tenant\`, provided). It works with one writer and hides four
flaws.

**Failure mode the checks target.** Two tenants with the same email hash become duplicates of each
other; two concurrent creates of one record both win; the index forgets a key after a day; and a
rebuild after a failover hands a key to the duplicate instead of the original.

- The hash is \`t:{tenant}:exact:{key_type}\`: tenants never share one.
- \`claim\` is **one Lua script** (\`HSETNX\`, then \`HGET\` of the holder) so no command lands between
  the check and the insert; it answers the outcome and the holder.
- The index is the dedupe authority, not a cache: no TTL.
- \`rebuild\` claims every record's keys oldest first through \`claim\`, so the record that held a key
  first keeps it; it returns how many keys it claimed.`,
  sequence: {
    participants: ['Dedupe API', 'Redis', 'record store'],
    messages: [
      {from: 'Dedupe API', to: 'Redis', label: 'EVALSHA claim t:{tenant}:exact:{type} value record_id', kind: 'sync'},
      {from: 'Redis', to: 'Dedupe API', label: '[winner, record_id] · [existing, holder]', kind: 'reply'},
      {from: 'Dedupe API', to: 'record store', label: 'of_tenant(tenant), oldest first (rebuild)', kind: 'sync'},
      {from: 'Dedupe API', to: 'Redis', label: 'claim each key: the first holder keeps it', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'tenant-namespace',
      title: 'Keeps one index per tenant',
      detail:
        "The hash is `t:{tenant}:exact:{key_type}`, so a globex record with acme's email hash is a winner in globex's index. The starter names the hash after the key type alone and reports globex's record as a duplicate of acme's.",
      match: {
        python: {all: [/t:\{tenant\}:exact|["']t:["']\s*\+\s*tenant/], none: [/f?["']exact:\{key_type\}["']/]},
        typescript: {all: [/t:\$\{tenant\}:exact|['"]t:['"]\s*\+\s*tenant/], none: [/`exact:\$\{keyType\}`/]},
        go: {all: [/"t:"\s*\+\s*tenant\s*\+\s*":exact:"|"t:%s:exact:%s"/], none: [/return "exact:"\s*\+/]},
        scala: {all: [/s"t:\$tenant:exact:|s"t:\$\{tenant\}:exact:/], none: [/s"exact:\$keyType"/]},
        cpp: {all: [/"t:"\s*\+\s*tenant\s*\+\s*":exact:"/], none: [/return "exact:"\s*\+/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Claims a key in one Lua script',
      detail:
        'The check and the insert are one script (`HSETNX`), so a second create landing between them sees the first one\'s key: one winner, one "existing" naming it. The starter runs `HGET` then `HSET` as two round trips and both creates win.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HSETNX['"]/],
          none: [/def claim(?:(?!\ndef )[\s\S])*?\br\.(hget|hset|hexists)\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HSETNX['"]/],
          none: [/function claim(?:(?!\nexport )[\s\S])*?redis\.(hget|hset|hexists)\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HSETNX['"]/],
          none: [/func claim\((?:(?!\n\})[\s\S])*?rdb\.(HGet|HSet|HExists)\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HSETNX['"]/],
          none: [/def claim\((?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?jedis\.(hget|hset|hexists)\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HSETNX['"]/],
          none: [/ClaimResult claim\((?:(?!\n\})[\s\S])*?redis\.(hget|hset|hexists)\(/],
        },
      },
    },
    {
      id: 'no-expiry',
      title: 'Keeps keys without a TTL',
      detail:
        'An index key has no TTL: a record created two days ago is still a duplicate today. The starter expires the hash after a day, as if the index were a cache.',
      match: {
        python: {all: [/def index_key\(/], none: [/\.expire\(/, /INDEX_TTL/]},
        typescript: {all: [/indexKey\s*=|function indexKey/], none: [/\.expire\(/, /INDEX_TTL/]},
        go: {all: [/func indexKey\(/], none: [/\.Expire\(/, /indexTTL/]},
        scala: {all: [/def indexKey\(/], none: [/\.expire\(/, /IndexTtl/]},
        cpp: {all: [/indexKey\(/], none: [/\.expire\(/, /kIndexTtl/]},
      },
    },
    {
      id: 'rebuild-first-wins',
      title: 'Rebuilds through claim, oldest record first',
      detail:
        '`rebuild` walks `records.of_tenant` oldest first and claims each key through `claim`, so the original keeps its key and the duplicate does not take it over. The starter writes each key with `HSET`, and the newest record wins.',
      match: {
        python: {
          all: [/records\.of_tenant\(/, /def rebuild(?:(?!\ndef )[\s\S])*?\bclaim\(/],
          none: [/def rebuild(?:(?!\ndef )[\s\S])*?\.hset\(/],
        },
        typescript: {
          all: [/ofTenant\(/, /function rebuild(?:(?!\nexport )[\s\S])*?\bclaim\(/],
          none: [/function rebuild(?:(?!\nexport )[\s\S])*?\.hset\(/],
        },
        go: {
          all: [/records\.OfTenant\(/, /func rebuild\((?:(?!\n\})[\s\S])*?\bclaim\(/],
          none: [/func rebuild\((?:(?!\n\})[\s\S])*?\.HSet\(/],
        },
        scala: {
          all: [/Records\.ofTenant\(/, /def rebuild\((?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?\bclaim\(/],
          none: [/def rebuild\((?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?\.hset\(/],
        },
        cpp: {
          all: [/records::ofTenant\(/, /int rebuild\((?:(?!\n\})[\s\S])*?\bclaim\(/],
          none: [/int rebuild\((?:(?!\n\})[\s\S])*?\.hset\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from dedupe import records  # records.of_tenant

r = redis.Redis(host="redis", port=6379, decode_responses=True)

INDEX_TTL_S = 86_400  # keep the index small, like the other caches in front of the record store


def index_key(tenant: str, key_type: str) -> str:
    return f"exact:{key_type}"


def claim(tenant: str, key_type: str, value: str, record_id: str) -> dict:
    """Insert the key for record_id unless a record holds it: {"outcome": "winner" | "existing", "record_id": holder}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = index_key(tenant, key_type)
    holder = r.hget(key, value)
    if holder is not None:
        return {"outcome": "existing", "record_id": holder}
    r.hset(key, value, record_id)
    r.expire(key, INDEX_TTL_S)
    return {"outcome": "winner", "record_id": record_id}


def lookup(tenant: str, key_type: str, value: str) -> str | None:
    """The id of the tenant's record holding the key, or None."""
    return r.hget(index_key(tenant, key_type), value)


def rebuild(tenant: str) -> int:
    """Rebuild the tenant's index from the record store after a flush or a failover; returns how many keys it wrote."""
    written = 0
    for record in records.of_tenant(tenant):
        for key_type, value in record["keys"].items():
            r.hset(index_key(tenant, key_type), value, record["record_id"])
            written += 1
    return written
`,
      solution: `import redis

from dedupe import records  # records.of_tenant

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# Insert ARGV[1] -> ARGV[2] unless the key is held; answer the outcome and the holder.
CLAIM_LUA = """
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
"""
claim_script = r.register_script(CLAIM_LUA)


def index_key(tenant: str, key_type: str) -> str:
    return f"t:{tenant}:exact:{key_type}"


def claim(tenant: str, key_type: str, value: str, record_id: str) -> dict:
    """Insert the key for record_id unless a record holds it: {"outcome": "winner" | "existing", "record_id": holder}."""
    # One script: no other command can land between the check and the insert.
    outcome, holder = claim_script(keys=[index_key(tenant, key_type)], args=[value, record_id])
    return {"outcome": outcome, "record_id": holder}


def lookup(tenant: str, key_type: str, value: str) -> str | None:
    """The id of the tenant's record holding the key, or None."""
    return r.hget(index_key(tenant, key_type), value)


def rebuild(tenant: str) -> int:
    """Rebuild the tenant's index from the record store after a flush or a failover; returns how many keys it claimed."""
    claimed = 0
    # Oldest first, through claim: the record that held a key first keeps it.
    for record in records.of_tenant(tenant):
        for key_type, value in record["keys"].items():
            if claim(tenant, key_type, value, record["record_id"])["outcome"] == "winner":
                claimed += 1
    return claimed
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {ofTenant} from 'dedupe/records';

const redis = new Redis({host: 'redis', port: 6379});

export const INDEX_TTL_S = 86_400; // keep the index small, like the other caches in front of the record store

export interface Claim {
  outcome: string;
  record_id: string;
}

export const indexKey = (tenant: string, keyType: string): string => \`exact:\${keyType}\`;

/** Insert the key for recordId unless a record holds it: the outcome and the holder's id. */
export async function claim(tenant: string, keyType: string, value: string, recordId: string): Promise<Claim> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = indexKey(tenant, keyType);
  const holder = await redis.hget(key, value);
  if (holder !== null) return {outcome: 'existing', record_id: holder};
  await redis.hset(key, value, recordId);
  await redis.expire(key, INDEX_TTL_S);
  return {outcome: 'winner', record_id: recordId};
}

/** The id of the tenant's record holding the key, or null. */
export async function lookup(tenant: string, keyType: string, value: string): Promise<string | null> {
  return redis.hget(indexKey(tenant, keyType), value);
}

/** Rebuild the tenant's index from the record store after a flush or a failover; returns how many keys it wrote. */
export async function rebuild(tenant: string): Promise<number> {
  let written = 0;
  for (const record of await ofTenant(tenant)) {
    for (const [keyType, value] of Object.entries(record.keys)) {
      await redis.hset(indexKey(tenant, keyType), value, record.record_id);
      written += 1;
    }
  }
  return written;
}
`,
      solution: `import Redis from 'ioredis';

import {ofTenant} from 'dedupe/records';

// Insert ARGV[1] -> ARGV[2] unless the key is held; answer the outcome and the holder.
export const CLAIM_LUA = \`
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
\`;

interface ClaimRedis extends Redis {
  claimKey(key: string, value: string, recordId: string): Promise<[string, string]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ClaimRedis;
redis.defineCommand('claimKey', {numberOfKeys: 1, lua: CLAIM_LUA});

export interface Claim {
  outcome: string;
  record_id: string;
}

export const indexKey = (tenant: string, keyType: string): string => \`t:\${tenant}:exact:\${keyType}\`;

/** Insert the key for recordId unless a record holds it: the outcome and the holder's id. */
export async function claim(tenant: string, keyType: string, value: string, recordId: string): Promise<Claim> {
  // One script: no other command can land between the check and the insert.
  const [outcome, holder] = await redis.claimKey(indexKey(tenant, keyType), value, recordId);
  return {outcome, record_id: holder};
}

/** The id of the tenant's record holding the key, or null. */
export async function lookup(tenant: string, keyType: string, value: string): Promise<string | null> {
  return redis.hget(indexKey(tenant, keyType), value);
}

/** Rebuild the tenant's index from the record store after a flush or a failover; returns how many keys it claimed. */
export async function rebuild(tenant: string): Promise<number> {
  let claimed = 0;
  // Oldest first, through claim: the record that held a key first keeps it.
  for (const record of await ofTenant(tenant)) {
    for (const [keyType, value] of Object.entries(record.keys)) {
      if ((await claim(tenant, keyType, value, record.record_id)).outcome === 'winner') claimed += 1;
    }
  }
  return claimed;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"dedupe/records" // records.OfTenant
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const indexTTL = 24 * time.Hour // keep the index small, like the other caches in front of the record store

// claimResult is what a claim answers: "winner" or "existing", and the id of the record holding the key.
type claimResult struct {
	Outcome  string
	RecordID string
}

func indexKey(tenant, keyType string) string {
	return "exact:" + keyType
}

// claim inserts the key for recordID unless a record holds it.
func claim(ctx context.Context, tenant, keyType, value, recordID string) (claimResult, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := indexKey(tenant, keyType)
	holder, err := rdb.HGet(ctx, key, value).Result()
	if err == nil {
		return claimResult{Outcome: "existing", RecordID: holder}, nil
	}
	if err != redis.Nil {
		return claimResult{}, err
	}
	if err := rdb.HSet(ctx, key, value, recordID).Err(); err != nil {
		return claimResult{}, err
	}
	rdb.Expire(ctx, key, indexTTL)
	return claimResult{Outcome: "winner", RecordID: recordID}, nil
}

// lookup is the id of the tenant's record holding the key, or "".
func lookup(ctx context.Context, tenant, keyType, value string) (string, error) {
	holder, err := rdb.HGet(ctx, indexKey(tenant, keyType), value).Result()
	if err == redis.Nil {
		return "", nil
	}
	return holder, err
}

// rebuild rebuilds the tenant's index from the record store after a flush or a failover; it returns how many keys it wrote.
func rebuild(ctx context.Context, tenant string) (int, error) {
	rows, err := records.OfTenant(ctx, tenant)
	if err != nil {
		return 0, err
	}
	written := 0
	for _, row := range rows {
		for keyType, value := range row.Keys {
			if err := rdb.HSet(ctx, indexKey(tenant, keyType), value, row.RecordID).Err(); err != nil {
				return written, err
			}
			written++
		}
	}
	return written, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"dedupe/records" // records.OfTenant
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// claimScript inserts ARGV[1] -> ARGV[2] unless the key is held and answers {outcome, holder}.
var claimScript = redis.NewScript(\`
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
\`)

// claimResult is what a claim answers: "winner" or "existing", and the id of the record holding the key.
type claimResult struct {
	Outcome  string
	RecordID string
}

func indexKey(tenant, keyType string) string {
	return "t:" + tenant + ":exact:" + keyType
}

// claim inserts the key for recordID unless a record holds it.
func claim(ctx context.Context, tenant, keyType, value, recordID string) (claimResult, error) {
	// One script: no other command can land between the check and the insert.
	got, err := claimScript.Run(ctx, rdb, []string{indexKey(tenant, keyType)}, value, recordID).StringSlice()
	if err != nil {
		return claimResult{}, err
	}
	return claimResult{Outcome: got[0], RecordID: got[1]}, nil
}

// lookup is the id of the tenant's record holding the key, or "".
func lookup(ctx context.Context, tenant, keyType, value string) (string, error) {
	holder, err := rdb.HGet(ctx, indexKey(tenant, keyType), value).Result()
	if err == redis.Nil {
		return "", nil
	}
	return holder, err
}

// rebuild rebuilds the tenant's index from the record store after a flush or a failover; it returns how many keys it claimed.
func rebuild(ctx context.Context, tenant string) (int, error) {
	rows, err := records.OfTenant(ctx, tenant)
	if err != nil {
		return 0, err
	}
	claimed := 0
	// Oldest first, through claim: the record that held a key first keeps it.
	for _, row := range rows {
		for keyType, value := range row.Keys {
			got, err := claim(ctx, tenant, keyType, value, row.RecordID)
			if err != nil {
				return claimed, err
			}
			if got.Outcome == "winner" {
				claimed++
			}
		}
	}
	return claimed, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import dedupe.Records // Records.ofTenant

object State {
  /** What a claim answers: "winner" or "existing", and the id of the record holding the key. */
  final case class ClaimResult(outcome: String, recordId: String)

  val jedis = new JedisPooled("redis", 6379)

  val IndexTtl = 86400L // keep the index small, like the other caches in front of the record store

  def indexKey(tenant: String, keyType: String): String = s"exact:$keyType"

  /** Insert the key for recordId unless a record holds it. */
  def claim(tenant: String, keyType: String, value: String, recordId: String): ClaimResult = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = indexKey(tenant, keyType)
    Option(jedis.hget(key, value)) match {
      case Some(holder) => ClaimResult("existing", holder)
      case None =>
        jedis.hset(key, value, recordId)
        jedis.expire(key, IndexTtl)
        ClaimResult("winner", recordId)
    }
  }

  /** The id of the tenant's record holding the key, if any. */
  def lookup(tenant: String, keyType: String, value: String): Option[String] = Option(jedis.hget(indexKey(tenant, keyType), value))

  /** Rebuild the tenant's index from the record store after a flush or a failover; returns how many keys it wrote. */
  def rebuild(tenant: String): Int = {
    var written = 0
    for (record <- Records.ofTenant(tenant); (keyType, value) <- record.keys) {
      jedis.hset(indexKey(tenant, keyType), value, record.recordId)
      written += 1
    }
    written
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import dedupe.Records // Records.ofTenant

object State {
  /** What a claim answers: "winner" or "existing", and the id of the record holding the key. */
  final case class ClaimResult(outcome: String, recordId: String)

  val jedis = new JedisPooled("redis", 6379)

  /** Insert ARGV[1] -> ARGV[2] unless the key is held; answer the outcome and the holder. */
  val ClaimLua: String =
    """if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
      |return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
      |""".stripMargin

  def indexKey(tenant: String, keyType: String): String = s"t:$tenant:exact:$keyType"

  /** Insert the key for recordId unless a record holds it. */
  def claim(tenant: String, keyType: String, value: String, recordId: String): ClaimResult = {
    // One script: no other command can land between the check and the insert.
    val got = jedis.eval(ClaimLua, List(indexKey(tenant, keyType)).asJava, List(value, recordId).asJava).asInstanceOf[java.util.List[String]]
    ClaimResult(got.get(0), got.get(1))
  }

  /** The id of the tenant's record holding the key, if any. */
  def lookup(tenant: String, keyType: String, value: String): Option[String] = Option(jedis.hget(indexKey(tenant, keyType), value))

  /** Rebuild the tenant's index from the record store after a flush or a failover; returns how many keys it claimed. */
  def rebuild(tenant: String): Int =
    // Oldest first, through claim: the record that held a key first keeps it.
    Records.ofTenant(tenant).map { record =>
      record.keys.count { case (keyType, value) => claim(tenant, keyType, value, record.recordId).outcome == "winner" }
    }.sum
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "dedupe/records.h"  // records::ofTenant

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kIndexTtl{86400};  // keep the index small, like the other caches in front of the record store

// What a claim answers: "winner" or "existing", and the id of the record holding the key.
struct ClaimResult {
  std::string outcome;
  std::string record_id;
};

std::string indexKey(const std::string& tenant, const std::string& key_type) { return "exact:" + key_type; }

// Insert the key for record_id unless a record holds it.
ClaimResult claim(const std::string& tenant, const std::string& key_type, const std::string& value, const std::string& record_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = indexKey(tenant, key_type);
  const auto holder = redis.hget(key, value);
  if (holder) return ClaimResult{"existing", *holder};
  redis.hset(key, value, record_id);
  redis.expire(key, kIndexTtl);
  return ClaimResult{"winner", record_id};
}

// The id of the tenant's record holding the key, if any.
std::optional<std::string> lookup(const std::string& tenant, const std::string& key_type, const std::string& value) {
  const auto holder = redis.hget(indexKey(tenant, key_type), value);
  if (!holder) return std::nullopt;
  return std::string(*holder);
}

// Rebuild the tenant's index from the record store after a flush or a failover; returns how many keys it wrote.
int rebuild(const std::string& tenant) {
  int written = 0;
  for (const records::Row& row : records::ofTenant(tenant)) {
    for (const auto& [key_type, value] : row.keys) {
      redis.hset(indexKey(tenant, key_type), value, row.record_id);
      written++;
    }
  }
  return written;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <vector>

#include "dedupe/records.h"  // records::ofTenant

sw::redis::Redis redis("tcp://redis:6379");

// Insert ARGV[1] -> ARGV[2] unless the key is held; answer the outcome and the holder.
const std::string kClaimLua = R"lua(
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then return {'winner', ARGV[2]} end
return {'existing', redis.call('HGET', KEYS[1], ARGV[1])}
)lua";

// What a claim answers: "winner" or "existing", and the id of the record holding the key.
struct ClaimResult {
  std::string outcome;
  std::string record_id;
};

std::string indexKey(const std::string& tenant, const std::string& key_type) { return "t:" + tenant + ":exact:" + key_type; }

// Insert the key for record_id unless a record holds it.
ClaimResult claim(const std::string& tenant, const std::string& key_type, const std::string& value, const std::string& record_id) {
  // One script: no other command can land between the check and the insert.
  std::vector<std::string> got;
  redis.eval(kClaimLua, {indexKey(tenant, key_type)}, {value, record_id}, std::back_inserter(got));
  return ClaimResult{got.at(0), got.at(1)};
}

// The id of the tenant's record holding the key, if any.
std::optional<std::string> lookup(const std::string& tenant, const std::string& key_type, const std::string& value) {
  const auto holder = redis.hget(indexKey(tenant, key_type), value);
  if (!holder) return std::nullopt;
  return std::string(*holder);
}

// Rebuild the tenant's index from the record store after a flush or a failover; returns how many keys it claimed.
int rebuild(const std::string& tenant) {
  int claimed = 0;
  // Oldest first, through claim: the record that held a key first keeps it.
  for (const records::Row& row : records::ofTenant(tenant)) {
    for (const auto& [key_type, value] : row.keys) {
      if (claim(tenant, key_type, value, row.record_id).outcome == "winner") claimed++;
    }
  }
  return claimed;
}
`,
    },
  },
  harness: {
    python: `from dedupe import records

EMAIL = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d"
PHONE = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00"
OTHER = "86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d"


def check_tenant_namespace(ctx):
    m = ctx.load("state")
    first = m.claim("acme", "email_hash", EMAIL, "r-1")
    assert first == {"outcome": "winner", "record_id": "r-1"}, f"the first claim of a key answered {first}, expected winner r-1"
    other = m.claim("globex", "email_hash", EMAIL, "r-2")
    assert other == {"outcome": "winner", "record_id": "r-2"}, f"globex's new record with the same email hash answered {other}: it was reported as a duplicate of acme's record. Keep one index per tenant (t:{{tenant}}:exact:{{key_type}})"
    assert m.index_key("acme", "email_hash") != m.index_key("globex", "email_hash"), f"acme and globex share the hash {m.index_key('acme', 'email_hash')!r}"
    assert ctx.redis.hget("t:acme:exact:email_hash", EMAIL) == "r-1" and ctx.redis.hget("t:globex:exact:email_hash", EMAIL) == "r-2", f"Redis holds {sorted(ctx.redis.keys('*exact*'))}, expected t:acme:exact:email_hash and t:globex:exact:email_hash each with its tenant's record"
    assert m.lookup("globex", "email_hash", EMAIL) == "r-2" and m.lookup("acme", "email_hash", EMAIL) == "r-1", "each tenant's lookup must answer its own record"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    m.claim("acme", "email_hash", OTHER, "r-0")  # the index exists and its script is loaded
    key = m.index_key("acme", "email_hash")
    # A second create of the same record lands right after the first command of this claim touches the index.
    rival = ctx.redis_after(key, lambda: m.claim("acme", "email_hash", EMAIL, "r-2"))
    mine = m.claim("acme", "email_hash", EMAIL, "r-1")
    assert rival.fired, f"the claim never touched {key}"
    if rival.error is not None:
        raise rival.error
    outcomes = sorted([mine["outcome"], rival.result["outcome"]])
    assert outcomes == ["existing", "winner"], f"two concurrent creates of one record answered {mine} and {rival.result}: both won, so the store gets two rows. Claim in one Lua script"
    assert mine["record_id"] == rival.result["record_id"], f"the two claims disagree about who holds the key: {mine} and {rival.result}"
    assert m.lookup("acme", "email_hash", EMAIL) == mine["record_id"], f"the index holds {m.lookup('acme', 'email_hash', EMAIL)!r}, but both claims named {mine['record_id']} as the holder"


def check_no_expiry(ctx):
    m = ctx.load("state")
    m.claim("acme", "email_hash", EMAIL, "r-1")
    key = m.index_key("acme", "email_hash")
    ttl = ctx.redis.ttl(key)
    assert ttl == -1, f"{key} has a TTL of {ttl} s: the index is the dedupe authority, and a key that expires lets the same customer be created again"
    ctx.clock.advance(2 * 86_400)
    again = m.claim("acme", "email_hash", EMAIL, "r-2")
    assert again == {"outcome": "existing", "record_id": "r-1"}, f"two days later the same email hash answered {again}, expected existing r-1"


def check_rebuild_first_wins(ctx):
    m = ctx.load("state")
    original = records.create("acme", "ds-1", "Jane Doe", "jane@example.com", {"email_hash": EMAIL, "phone_hash": PHONE})
    duplicate = records.create("acme", "ds-1", "Jane Doe", "jane@example.com", {"email_hash": EMAIL})
    for key in ctx.redis.keys("*exact*"):
        ctx.redis.delete(key)  # the index was lost in a failover; the record store was not
    m.rebuild("acme")
    holder = m.lookup("acme", "email_hash", EMAIL)
    assert holder == original["record_id"], f"after the rebuild the email hash points at {holder!r}, expected the original {original['record_id']}: {duplicate['record_id']} is the duplicate that slipped in later. Claim oldest first, through claim"
    assert m.lookup("acme", "phone_hash", PHONE) == original["record_id"], "the rebuild must restore every key of every record, the phone hash included"
    again = m.claim("acme", "email_hash", EMAIL, "r-99")
    assert again == {"outcome": "existing", "record_id": original["record_id"]}, f"a new claim after the rebuild answered {again}, expected existing {original['record_id']}"
`,
    typescript: `const EMAIL = '8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d';
const PHONE = '602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00';
const OTHER = '86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function check_tenant_namespace(ctx) {
  const m = ctx.load('state');
  const first = await m.claim('acme', 'email_hash', EMAIL, 'r-1');
  assert(same(first, {outcome: 'winner', record_id: 'r-1'}), \`the first claim of a key answered \${JSON.stringify(first)}, expected winner r-1\`);
  const other = await m.claim('globex', 'email_hash', EMAIL, 'r-2');
  assert(same(other, {outcome: 'winner', record_id: 'r-2'}), \`globex's new record with the same email hash answered \${JSON.stringify(other)}: it was reported as a duplicate of acme's record. Keep one index per tenant (t:{tenant}:exact:{key_type})\`);
  assert.notEqual(m.indexKey('acme', 'email_hash'), m.indexKey('globex', 'email_hash'), \`acme and globex share the hash \${m.indexKey('acme', 'email_hash')}\`);
  assert(ctx.redis.hget('t:acme:exact:email_hash', EMAIL) === 'r-1' && ctx.redis.hget('t:globex:exact:email_hash', EMAIL) === 'r-2', \`Redis holds \${JSON.stringify(ctx.redis.keys('*exact*'))}, expected t:acme:exact:email_hash and t:globex:exact:email_hash each with its tenant's record\`);
  assert((await m.lookup('globex', 'email_hash', EMAIL)) === 'r-2' && (await m.lookup('acme', 'email_hash', EMAIL)) === 'r-1', "each tenant's lookup must answer its own record");
}

export async function check_atomic_claim(ctx) {
  const m = ctx.load('state');
  await m.claim('acme', 'email_hash', OTHER, 'r-0'); // the index exists and its script is loaded
  const key = m.indexKey('acme', 'email_hash');
  // A second create of the same record lands right after the first command of this claim touches the index.
  const rival = ctx.redisAfter(key, () => m.claim('acme', 'email_hash', EMAIL, 'r-2'));
  const mine = await m.claim('acme', 'email_hash', EMAIL, 'r-1');
  assert(rival.fired, \`the claim never touched \${key}\`);
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const outcomes = [mine.outcome, theirs.outcome].sort();
  assert(same(outcomes, ['existing', 'winner']), \`two concurrent creates of one record answered \${JSON.stringify(mine)} and \${JSON.stringify(theirs)}: both won, so the store gets two rows. Claim in one Lua script\`);
  assert.equal(mine.record_id, theirs.record_id, \`the two claims disagree about who holds the key: \${JSON.stringify(mine)} and \${JSON.stringify(theirs)}\`);
  assert.equal(await m.lookup('acme', 'email_hash', EMAIL), mine.record_id, 'the index must hold the record both claims named as the holder');
}

export async function check_no_expiry(ctx) {
  const m = ctx.load('state');
  await m.claim('acme', 'email_hash', EMAIL, 'r-1');
  const key = m.indexKey('acme', 'email_hash');
  const ttl = ctx.redis.ttl(key);
  assert.equal(ttl, -1, \`\${key} has a TTL of \${ttl} s: the index is the dedupe authority, and a key that expires lets the same customer be created again\`);
  ctx.clock.advance(2 * 86_400);
  const again = await m.claim('acme', 'email_hash', EMAIL, 'r-2');
  assert(same(again, {outcome: 'existing', record_id: 'r-1'}), \`two days later the same email hash answered \${JSON.stringify(again)}, expected existing r-1\`);
}

export async function check_rebuild_first_wins(ctx) {
  const m = ctx.load('state');
  const records = ctx.load('/support/dedupe/records.ts');
  const original = await records.create('acme', 'ds-1', 'Jane Doe', 'jane@example.com', {email_hash: EMAIL, phone_hash: PHONE});
  const duplicate = await records.create('acme', 'ds-1', 'Jane Doe', 'jane@example.com', {email_hash: EMAIL});
  for (const key of ctx.redis.keys('*exact*')) ctx.redis.del(key); // the index was lost in a failover; the record store was not
  await m.rebuild('acme');
  const holder = await m.lookup('acme', 'email_hash', EMAIL);
  assert.equal(holder, original.record_id, \`after the rebuild the email hash points at \${holder}, expected the original \${original.record_id}: \${duplicate.record_id} is the duplicate that slipped in later. Claim oldest first, through claim\`);
  assert.equal(await m.lookup('acme', 'phone_hash', PHONE), original.record_id, 'the rebuild must restore every key of every record, the phone hash included');
  const again = await m.claim('acme', 'email_hash', EMAIL, 'r-99');
  assert(same(again, {outcome: 'existing', record_id: original.record_id}), \`a new claim after the rebuild answered \${JSON.stringify(again)}, expected existing \${original.record_id}\`);
}
`,
    go: `package main

import (
	"context"

	"dedupe/records"

	"leetbuild/harness"
)

const (
	stateEmail = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d"
	statePhone = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00"
	stateOther = "86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d"
)

var stateBg = context.Background()

func mustClaim(ctx *harness.Ctx, tenant, keyType, value, recordID string) claimResult {
	got, err := claim(stateBg, tenant, keyType, value, recordID)
	ctx.NoError(err, "claim(%s, %s, …, %s) failed", tenant, keyType, recordID)
	return got
}

func mustLookup(ctx *harness.Ctx, tenant, keyType, value string) string {
	got, err := lookup(stateBg, tenant, keyType, value)
	ctx.NoError(err, "lookup(%s, %s, …) failed", tenant, keyType)
	return got
}

func CheckTenantNamespace(ctx *harness.Ctx) {
	ctx.Equal(mustClaim(ctx, "acme", "email_hash", stateEmail, "r-1"), claimResult{Outcome: "winner", RecordID: "r-1"}, "the first claim of a key")
	other := mustClaim(ctx, "globex", "email_hash", stateEmail, "r-2")
	ctx.Assert(other == claimResult{Outcome: "winner", RecordID: "r-2"}, "globex's new record with the same email hash answered %+v: it was reported as a duplicate of acme's record. Keep one index per tenant (t:{tenant}:exact:{key_type})", other)
	ctx.Assert(indexKey("acme", "email_hash") != indexKey("globex", "email_hash"), "acme and globex share the hash %q", indexKey("acme", "email_hash"))
	acme, _ := ctx.Redis.HGet("t:acme:exact:email_hash", stateEmail)
	globex, _ := ctx.Redis.HGet("t:globex:exact:email_hash", stateEmail)
	ctx.Assert(acme == "r-1" && globex == "r-2", "Redis holds %q, expected t:acme:exact:email_hash and t:globex:exact:email_hash each with its tenant's record", ctx.Redis.Keys("*exact*"))
	ctx.Assert(mustLookup(ctx, "globex", "email_hash", stateEmail) == "r-2" && mustLookup(ctx, "acme", "email_hash", stateEmail) == "r-1", "each tenant's lookup must answer its own record")
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	mustClaim(ctx, "acme", "email_hash", stateOther, "r-0") // the index exists and its script is loaded
	key := indexKey("acme", "email_hash")
	// A second create of the same record lands right after the first command of this claim touches the index.
	rival := ctx.Redis.After(key, func() any {
		got, err := claim(stateBg, "acme", "email_hash", stateEmail, "r-2")
		ctx.NoError(err, "the concurrent claim failed")
		return got
	})
	mine := mustClaim(ctx, "acme", "email_hash", stateEmail, "r-1")
	ctx.Assert(rival.Fired, "the claim never touched %s", key)
	ctx.Assert(rival.Err == nil, "the concurrent claim failed: %v", rival.Err)
	theirs := rival.Result.(claimResult)
	ctx.Assert(mine.Outcome != theirs.Outcome, "two concurrent creates of one record answered %+v and %+v: both %s, so the store gets two rows (or none). Claim in one Lua script", mine, theirs, mine.Outcome)
	ctx.Equal(mine.RecordID, theirs.RecordID, "the two claims must agree about who holds the key (%+v, %+v)", mine, theirs)
	ctx.Equal(mustLookup(ctx, "acme", "email_hash", stateEmail), mine.RecordID, "the index must hold the record both claims named as the holder")
}

func CheckNoExpiry(ctx *harness.Ctx) {
	mustClaim(ctx, "acme", "email_hash", stateEmail, "r-1")
	key := indexKey("acme", "email_hash")
	ctx.Equal(ctx.Redis.TTL(key), int64(-1), "%s must have no TTL: the index is the dedupe authority, and a key that expires lets the same customer be created again; the TTL", key)
	ctx.Clock.Advance(2 * 86400)
	ctx.Equal(mustClaim(ctx, "acme", "email_hash", stateEmail, "r-2"), claimResult{Outcome: "existing", RecordID: "r-1"}, "two days later the same email hash")
}

func CheckRebuildFirstWins(ctx *harness.Ctx) {
	original, err := records.Create(stateBg, "acme", "ds-1", "Jane Doe", "jane@example.com", map[string]string{"email_hash": stateEmail, "phone_hash": statePhone})
	ctx.NoError(err, "creating the original record")
	duplicate, err := records.Create(stateBg, "acme", "ds-1", "Jane Doe", "jane@example.com", map[string]string{"email_hash": stateEmail})
	ctx.NoError(err, "creating the duplicate record")
	for _, key := range ctx.Redis.Keys("*exact*") {
		ctx.Redis.Del(key) // the index was lost in a failover; the record store was not
	}
	_, err = rebuild(stateBg, "acme")
	ctx.NoError(err, "rebuild(acme) failed")
	holder := mustLookup(ctx, "acme", "email_hash", stateEmail)
	ctx.Assert(holder == original.RecordID, "after the rebuild the email hash points at %q, expected the original %s: %s is the duplicate that slipped in later. Claim oldest first, through claim", holder, original.RecordID, duplicate.RecordID)
	ctx.Equal(mustLookup(ctx, "acme", "phone_hash", statePhone), original.RecordID, "the rebuild must restore every key of every record; the phone hash's holder")
	ctx.Equal(mustClaim(ctx, "acme", "email_hash", stateEmail, "r-99"), claimResult{Outcome: "existing", RecordID: original.RecordID}, "a new claim after the rebuild")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

#include "dedupe/records.h"

namespace {

const std::string kEmail = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d";
const std::string kPhone = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00";
const std::string kOther = "86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d";

void expectClaim(harness::Ctx& ctx, const ClaimResult& got, const std::string& outcome, const std::string& record_id, const std::string& what) {
  ctx.Assert(got.outcome == outcome && got.record_id == record_id, "%s answered {%s, %s}, expected {%s, %s}", what, got.outcome, got.record_id, outcome, record_id);
}

}  // namespace

void CheckTenantNamespace(harness::Ctx& ctx) {
  expectClaim(ctx, claim("acme", "email_hash", kEmail, "r-1"), "winner", "r-1", "the first claim of a key");
  const ClaimResult other = claim("globex", "email_hash", kEmail, "r-2");
  ctx.Assert(other.outcome == "winner" && other.record_id == "r-2",
             "globex's new record with the same email hash answered {%s, %s}: it was reported as a duplicate of acme's record. Keep one index per tenant (t:{tenant}:exact:{key_type})",
             other.outcome, other.record_id);
  ctx.Assert(indexKey("acme", "email_hash") != indexKey("globex", "email_hash"), "acme and globex share the hash %q", indexKey("acme", "email_hash"));
  ctx.Assert(ctx.Redis.HGet("t:acme:exact:email_hash", kEmail).value_or("") == "r-1" && ctx.Redis.HGet("t:globex:exact:email_hash", kEmail).value_or("") == "r-2",
             "Redis holds %q, expected t:acme:exact:email_hash and t:globex:exact:email_hash each with its tenant's record", ctx.Redis.Keys("*exact*"));
  ctx.Assert(lookup("globex", "email_hash", kEmail).value_or("") == "r-2" && lookup("acme", "email_hash", kEmail).value_or("") == "r-1",
             "each tenant's lookup must answer its own record");
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  claim("acme", "email_hash", kOther, "r-0");  // the index exists and its script is loaded
  const std::string key = indexKey("acme", "email_hash");
  // A second create of the same record lands right after the first command of this claim touches the index.
  auto theirs = std::make_shared<std::optional<ClaimResult>>();
  auto err = std::make_shared<std::string>();
  ctx.Redis.After(key, [theirs, err] {
    try {
      *theirs = claim("acme", "email_hash", kEmail, "r-2");
    } catch (const std::exception& e) {
      *err = e.what();
    }
  });
  const ClaimResult mine = claim("acme", "email_hash", kEmail, "r-1");
  ctx.Assert(err->empty(), "the concurrent claim failed: %s", *err);
  ctx.Assert(theirs->has_value(), "the claim never touched %s", key);
  const ClaimResult rival = **theirs;
  ctx.Assert(mine.outcome != rival.outcome, "two concurrent creates of one record answered {%s, %s} and {%s, %s}: both %s, so the store gets two rows (or none). Claim in one Lua script",
             mine.outcome, mine.record_id, rival.outcome, rival.record_id, mine.outcome);
  ctx.Equal(mine.record_id, rival.record_id, "the two claims must agree about who holds the key");
  ctx.Equal(lookup("acme", "email_hash", kEmail).value_or(""), mine.record_id, "the index must hold the record both claims named as the holder");
}

void CheckNoExpiry(harness::Ctx& ctx) {
  claim("acme", "email_hash", kEmail, "r-1");
  const std::string key = indexKey("acme", "email_hash");
  ctx.Equal(ctx.Redis.TTL(key), -1, "%s must have no TTL: the index is the dedupe authority, and a key that expires lets the same customer be created again; the TTL", key);
  ctx.Clock.Advance(2 * 86400);
  expectClaim(ctx, claim("acme", "email_hash", kEmail, "r-2"), "existing", "r-1", "two days later the same email hash");
}

void CheckRebuildFirstWins(harness::Ctx& ctx) {
  const records::Row original = records::create("acme", "ds-1", "Jane Doe", "jane@example.com", {{"email_hash", kEmail}, {"phone_hash", kPhone}});
  const records::Row duplicate = records::create("acme", "ds-1", "Jane Doe", "jane@example.com", {{"email_hash", kEmail}});
  for (const std::string& key : ctx.Redis.Keys("*exact*")) ctx.Redis.Del(key);  // the index was lost in a failover; the record store was not
  rebuild("acme");
  const std::string holder = lookup("acme", "email_hash", kEmail).value_or("");
  ctx.Assert(holder == original.record_id, "after the rebuild the email hash points at %q, expected the original %s: %s is the duplicate that slipped in later. Claim oldest first, through claim",
             holder, original.record_id, duplicate.record_id);
  ctx.Equal(lookup("acme", "phone_hash", kPhone).value_or(""), original.record_id, "the rebuild must restore every key of every record; the phone hash's holder");
  expectClaim(ctx, claim("acme", "email_hash", kEmail, "r-99"), "existing", original.record_id, "a new claim after the rebuild");
}
`,
  },
  hints: [
    'Create the same customer twice at the same instant: both requests answer "winner" and the store has two rows. Separately, a globex record is reported as a duplicate of an acme record it has not seen.',
    "`claim` reads with `HGET` and writes with `HSET` in two round trips, so a second create can read between them; `index_key` ignores the tenant; an `EXPIRE` forgets keys; `rebuild`'s `HSET` lets the last record overwrite the first.",
    'Name the hash `t:{tenant}:exact:{key_type}`; register one Lua script that runs `HSETNX` and returns `{winner, record_id}` or `{existing, HGET holder}`; drop the TTL; have `rebuild` call `claim` for each record in `of_tenant` order.',
  ],
  debrief: `Redis runs one script at a time, so putting the check and the insert in one script is what turns two concurrent creates into a winner and a loser that agree on the holder; two client commands give each caller its own private view. The tenant goes in the hash name because the namespace is the isolation boundary: equal digests in two tenants are two customers. The index is the authority on who exists, so it has no TTL, and rebuilding it through the same claim, oldest first, keeps the original as the holder. Production systems rebuild from a change stream rather than a full scan, and compare the index with the record store on a schedule to find drift.`,
};
