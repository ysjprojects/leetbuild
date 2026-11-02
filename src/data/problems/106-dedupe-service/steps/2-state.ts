import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis exact-key sets with atomic insert-and-check',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter is the exact-key index over Redis: \`ExactKeyIndex.key()\` builds the
set name from the key type alone, and \`insert_and_check()\` runs \`SISMEMBER\` and then \`SADD\` as two
client commands, returning a bare boolean. It compiles, it works in a single-writer demo, and it
hides five flaws.

**Failure mode the checks target.** \`SISMEMBER\`-then-\`SADD\` is two round trips: both concurrent
requests can observe a miss, and both create a record. A namespace without the tenant is worse. It
does not lose a duplicate, it invents one, merging two tenants' records because their email hashes
collided in a shared set.

Requirements:

- Exact keys live in **per-tenant sets**: the namespace is \`t:{tenant}:exact:{key_type}\`, built by a
  \`tenant_namespace\` helper, so two tenants with the same hash do not share a set.
- Insert-and-check is **one atomic operation**: a single registered Lua script does the \`SADD\` and
  returns whether the key already existed, so two concurrent submissions of the same record agree on
  one winner instead of both creating a row. Do not \`SISMEMBER\` and then \`SADD\` in the client.
- The result names the outcome: \`winner\` when the caller inserted the key, \`existing\` when it was
  already there.
- The index must be **rebuildable from the durable record store**: a \`rebuild\` routine reads every
  record's exact keys and re-inserts them into the right tenant namespaces, so the sets survive a
  flush or a failover without losing duplicates.`,
  sequence: {
    participants: ['Dedupe API', 'Redis', 'record store'],
    messages: [
      {
        from: 'Dedupe API',
        to: 'Redis',
        label: 'EVALSHA insert_and_check(KEYS[1]=t:{tenant}:exact:{type})',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Dedupe API', label: 'winner / existing', kind: 'reply'},
      {from: 'Dedupe API', to: 'record store', label: 'create(record) on winner', kind: 'sync'},
      {from: 'Dedupe API', to: 'record store', label: 'load(record_id) on existing', kind: 'sync'},
      {from: 'record store', to: 'Dedupe API', label: 'durable records', kind: 'reply'},
      {from: 'Dedupe API', to: 'Redis', label: 'rebuild from records', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'script',
      title: 'Registers one Lua script',
      detail:
        'The index loads a single Lua script once and calls it by name or SHA. The starter runs two separate client commands instead of one script.',
      match: {
        python: {all: [/register_script\(/]},
        typescript: {all: [/defineCommand\(/]},
        go: {all: [/NewScript\(/]},
        scala: {all: [/scriptLoad\(/]},
        cpp: {all: [/script_load\(/]},
      },
    },
    {
      id: 'atomic',
      title: 'Inserts and checks in one atomic call',
      detail:
        'The script does the `SADD` and reports existence in the same call; the client issues no separate `SISMEMBER`. The starter checks membership first, so two concurrent submissions both see a miss.',
      match: {
        python: {all: [/sadd/i], none: [/sismember/i]},
        typescript: {all: [/sadd/i], none: [/sismember/i]},
        go: {all: [/sadd/i], none: [/sismember/i]},
        scala: {all: [/sadd/i], none: [/sismember/i]},
        cpp: {all: [/sadd/i], none: [/sismember/i]},
      },
    },
    {
      id: 'tenant-namespace',
      title: 'Namespaces the set by tenant',
      detail:
        'The set key is built from the tenant (`t:{tenant}:exact:{key_type}`) so namespaces are disjoint. The starter names only the key type, so distinct tenants collide into a false duplicate.',
      match: {
        python: {all: [/tenant_namespace\(/]},
        typescript: {all: [/tenantNamespace\(/]},
        go: {all: [/tenantNamespace\(/]},
        scala: {all: [/tenantNamespace\(/]},
        cpp: {all: [/tenant_namespace\(/]},
      },
    },
    {
      id: 'rebuild',
      title: 'Rebuilds the sets from durable records',
      detail:
        "A `rebuild` routine re-inserts every record's exact keys from the durable store into the right tenant namespaces. The starter has no way to reconstruct the index after a flush.",
      match: {
        python: {all: [/rebuild\(/]},
        typescript: {all: [/rebuild\(/]},
        go: {all: [/Rebuild\(/]},
        scala: {all: [/rebuild\(/]},
        cpp: {all: [/rebuild\(/]},
      },
    },
    {
      id: 'winner',
      title: 'Reports the winner and the existing key',
      detail:
        'The atomic call returns whether the caller won the insert (`winner`) or the key already existed (`existing`), so concurrent submissions agree on one record. The starter returns a bare boolean from two commands.',
      match: {
        python: {all: [/winner/, /existing/]},
        typescript: {all: [/winner/, /existing/]},
        go: {all: [/winner/, /existing/]},
        scala: {all: [/winner/, /existing/]},
        cpp: {all: [/winner/, /existing/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis


class ExactKeyIndex:
    def __init__(self, client: redis.Redis) -> None:
        self.client = client

    def key(self, key_type: str) -> str:
        # The namespace names the key type only; the tenant is assumed from the connection.
        return f"exact:{key_type}"

    def insert_and_check(self, tenant: str, key_type: str, value: str) -> bool:
        # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
        if self.client.sismember(self.key(key_type), value):
            return False
        self.client.sadd(self.key(key_type), value)
        return True
`,
      solution: `import redis

EXACT_KEY_SCRIPT = """
local added = redis.call('sadd', KEYS[1], ARGV[1])
if added == 1 then
  return 'winner'
end
return 'existing'
"""


class ExactKeyIndex:
    def __init__(self, client: redis.Redis) -> None:
        self.client = client
        self.script = client.register_script(EXACT_KEY_SCRIPT)

    def tenant_namespace(self, tenant: str, key_type: str) -> str:
        """Disjoint namespace per tenant so one tenant's keys never collide with another's."""
        return f"t:{tenant}:exact:{key_type}"

    def insert_and_check(self, tenant: str, key_type: str, value: str) -> str:
        """One atomic call: add the key and report whether it already existed."""
        outcome = self.script(keys=[self.tenant_namespace(tenant, key_type)], args=[value])
        if outcome == "winner":
            return "winner"
        return "existing"

    def rebuild(self, records) -> None:
        """Reconstruct every tenant's set from the durable record store."""
        for record in records:
            for key_type, value in record.exact_keys.items():
                self.client.sadd(self.tenant_namespace(record.tenant, key_type), value)
`,
    },
    typescript: {
      starter: `import type {Redis} from 'ioredis';

class ExactKeyIndex {
  constructor(private readonly client: Redis) {}

  key(keyType: string): string {
    // The namespace names the key type only; the tenant is assumed from the connection.
    return 'exact:' + keyType;
  }

  async insertAndCheck(tenant: string, keyType: string, value: string): Promise<boolean> {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    if (await this.client.sismember(this.key(keyType), value)) return false;
    await this.client.sadd(this.key(keyType), value);
    return true;
  }
}
`,
      solution: `import type {Redis} from 'ioredis';

const EXACT_KEY_SCRIPT = \`local added = redis.call('sadd', KEYS[1], ARGV[1])
if added == 1 then return 'winner' end
return 'existing'\`;

interface DurableRecord {
  tenant: string;
  exact_keys: Record<string, string>;
}

class ExactKeyIndex {
  private readonly script: (keys: string[], args: string[]) => Promise<string>;

  constructor(private readonly client: Redis) {
    this.client.defineCommand('insertAndCheck', {numberOfKeys: 1, lua: EXACT_KEY_SCRIPT});
    this.script = (keys, args) =>
      (this.client as unknown as {insertAndCheck: (...args: unknown[]) => Promise<string>}).insertAndCheck(
        ...keys,
        ...args,
      );
  }

  tenantNamespace(tenant: string, keyType: string): string {
    // Disjoint namespace per tenant so one tenant's keys never collide with another's.
    return 't:' + tenant + ':exact:' + keyType;
  }

  async insertAndCheck(tenant: string, keyType: string, value: string): Promise<string> {
    const outcome = await this.script([this.tenantNamespace(tenant, keyType)], [value]);
    return outcome === 'winner' ? 'winner' : 'existing';
  }

  async rebuild(records: DurableRecord[]): Promise<void> {
    for (const record of records)
      for (const [keyType, value] of Object.entries(record.exact_keys))
        await this.client.sadd(this.tenantNamespace(record.tenant, keyType), value);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

type ExactKeyIndex struct {
	client *redis.Client
}

func NewExactKeyIndex(client *redis.Client) *ExactKeyIndex {
	return &ExactKeyIndex{client: client}
}

func (idx *ExactKeyIndex) key(keyType string) string {
	// The namespace names the key type only; the tenant is assumed from the connection.
	return "exact:" + keyType
}

func (idx *ExactKeyIndex) InsertAndCheck(ctx context.Context, tenant, keyType, value string) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	exists, err := idx.client.Sismember(ctx, idx.key(keyType), value).Result()
	if err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	if err := idx.client.Sadd(ctx, idx.key(keyType), value).Err(); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const exactKeyScript = \`
local added = redis.call('sadd', KEYS[1], ARGV[1])
if added == 1 then
  return 'winner'
end
return 'existing'
\`

type DurableRecord struct {
	Tenant    string
	ExactKeys map[string]string
}

type ExactKeyIndex struct {
	client *redis.Client
	script *redis.Script
}

func NewExactKeyIndex(client *redis.Client) *ExactKeyIndex {
	return &ExactKeyIndex{client: client, script: redis.NewScript(exactKeyScript)}
}

func (idx *ExactKeyIndex) tenantNamespace(tenant, keyType string) string {
	// Disjoint namespace per tenant so one tenant's keys never collide with another's.
	return "t:" + tenant + ":exact:" + keyType
}

func (idx *ExactKeyIndex) InsertAndCheck(ctx context.Context, tenant, keyType, value string) (string, error) {
	outcome, err := idx.script.Run(ctx, idx.client, []string{idx.tenantNamespace(tenant, keyType)}, value).Text()
	if err != nil {
		return "", err
	}
	if outcome == "winner" {
		return "winner", nil
	}
	return "existing", nil
}

func (idx *ExactKeyIndex) Rebuild(ctx context.Context, records []DurableRecord) error {
	for _, record := range records {
		for keyType, value := range record.ExactKeys {
			if err := idx.client.Sadd(ctx, idx.tenantNamespace(record.Tenant, keyType), value).Err(); err != nil {
				return err
			}
		}
	}
	return nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

class ExactKeyIndex(jedis: Jedis) {
  def key(keyType: String): String =
    // The namespace names the key type only; the tenant is assumed from the connection.
    "exact:" + keyType

  def insertAndCheck(tenant: String, keyType: String, value: String): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    if (jedis.sismember(key(keyType), value)) {
      false
    } else {
      jedis.sadd(key(keyType), value)
      true
    }
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object ExactKeyScript {
  val Script: String =
    """local added = redis.call('sadd', KEYS[1], ARGV[1])
      |if added == 1 then
      |  return 'winner'
      |end
      |return 'existing'
      |""".stripMargin
}

final case class DurableRecord(tenant: String, exact_keys: Map[String, String])

class ExactKeyIndex(jedis: Jedis) {
  private val sha: String = jedis.scriptLoad(ExactKeyScript.Script)

  def tenantNamespace(tenant: String, keyType: String): String =
    "t:" + tenant + ":exact:" + keyType

  def insertAndCheck(tenant: String, keyType: String, value: String): String = {
    val namespace = tenantNamespace(tenant, keyType)
    val outcome = jedis.evalsha(sha, java.util.List.of(namespace), java.util.List.of(value))
    if (outcome == "winner") "winner" else "existing"
  }

  def rebuild(records: List[DurableRecord]): Unit =
    for (record <- records; (keyType, value) <- record.exact_keys)
      jedis.sadd(tenantNamespace(record.tenant, keyType), value)
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

using namespace sw::redis;

class ExactKeyIndex {
 public:
  explicit ExactKeyIndex(Redis& redis) : redis_(redis) {}

  std::string key(const std::string& keyType) {
    // The namespace names the key type only; the tenant is assumed from the connection.
    return "exact:" + keyType;
  }

  bool insert_and_check(const std::string& tenant, const std::string& keyType,
                        const std::string& value) {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    if (redis_.sismember(key(keyType), value)) {
      return false;
    }
    redis_.sadd(key(keyType), value);
    return true;
  }

 private:
  Redis& redis_;
};
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using namespace sw::redis;

const std::string kExactKeyScript =
    "local added = redis.call('sadd', KEYS[1], ARGV[1]) "
    "if added == 1 then return 'winner' end "
    "return 'existing'";

struct DurableRecord {
  std::string tenant;
  std::map<std::string, std::string> exact_keys;
};

class ExactKeyIndex {
 public:
  explicit ExactKeyIndex(Redis& redis) : redis_(redis) { sha_ = redis_.script_load(kExactKeyScript); }

  std::string tenant_namespace(const std::string& tenant, const std::string& keyType) {
    // Disjoint namespace per tenant so one tenant's keys never collide with another's.
    return "t:" + tenant + ":exact:" + keyType;
  }

  std::string insert_and_check(const std::string& tenant, const std::string& keyType,
                               const std::string& value) {
    const auto namespace_ = tenant_namespace(tenant, keyType);
    const auto outcome = redis_.evalsha(sha_, {namespace_}, {value}).as<std::string>();
    if (outcome == "winner") return "winner";
    return "existing";
  }

  void rebuild(const std::vector<DurableRecord>& records) {
    for (const auto& record : records)
      for (const auto& [keyType, value] : record.exact_keys)
        redis_.sadd(tenant_namespace(record.tenant, keyType), value);
  }

 private:
  Redis& redis_;
  std::string sha_;
};
`,
    },
  },
  hints: [
    'Symptom: two clients submit the same record at the same instant and both get "winner", so the store ends up with two rows; separately, tenant B is told its new contact duplicates one it never created.',
    'Mechanism: `insert_and_check` runs `SISMEMBER` then `SADD` as two round trips, so both callers see a miss before either writes; and `key()` names only the key type, so every tenant shares one set.',
    "Change: register one Lua script that does `SADD` and returns existing-or-winner; build the set name with `tenant_namespace(tenant, key_type)`; add a `rebuild` that re-inserts every record's keys from the durable store.",
  ],
  debrief: `The fix puts the decision inside Redis because that is the only place the two concurrent writers are serialized: a script that inserts and reports in one call gives both callers the same answer, where two client commands give each caller its own answer. The tenant goes into the set name for the same reason the tenant went into the search scope in step 1: the key space is the isolation boundary, and a shared set makes a hash collision look like a duplicate person. Rebuild exists because Redis is a cache of the record store, not the record store. Production indexes also set a TTL or a size cap in the script, run the rebuild as an idempotent backfill that can overlap live traffic, and alert when the set count drifts from the durable row count.`,
};
