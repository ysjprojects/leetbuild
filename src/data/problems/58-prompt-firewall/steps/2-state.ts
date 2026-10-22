import type {Step} from '@/lib/types';

export const ruleCacheStep: Step = {
  id: 'state',
  title: 'Redis rule cache with versioned atomic swaps',
  concept: 'redis',
  file: 'state',
  focus: ['firewall', 'redis', 'rules'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the rule cache: it keeps the
rule set in one Redis hash and writes each rule as it is edited. It compiles, it serves the happy
path, and it makes two guarantees the firewall depends on impossible. Review it, fix it, prove it.

Implement the rule cache the firewall screens against.

- A rule set is published as **one immutable versioned value** under \`firewall:rules:v{version}\`.
  A reader never observes a half-applied batch: the whole set is written under a new key before it
  can become active, and a version is never mutated once written.
- The **active version pointer** is a single key, \`firewall:rules:active\`, holding the version
  string. It is swapped by **one atomic script** that also records the version it replaced under
  \`firewall:rules:previous\`, so the swap and the history are never observable apart.
- Each publish allocates a **new** version (\`INCR firewall:rules:version\`) — reusing the active
  version would mutate a set some in-flight screen is already reading.
- \`rollback()\` resolves the **exact previous version** from the recorded pointer and activates it.
  Never compute \`version - 1\`: after any rollback or roll-forward that arithmetic names the wrong
  set, which is precisely the case a rollback exists for.
- \`load_active()\` reads the pointer and then the whole set for that version. It never reads a
  mutable hash, and it never reads rules one at a time.

**Failure mode the checks target.** Two. The draft patches single rules into a shared hash, so a
screen running while a batch is applied can match a rule set that never existed as a whole — the
firewall's behaviour depends on when it happened to read. And the draft has no version at all: the
pointer is the rules, so a rollback has nothing to name. The fixes are the same shape — make every
published set immutable and swap one pointer atomically — which is why reviewers ask for "versioned
rules" and not "rules in Redis".`,
  sequence: {
    participants: ['Rule author', 'Rule cache', 'Redis', 'Prompt Firewall'],
    messages: [
      {from: 'Rule author', to: 'Rule cache', label: 'publish(rule set)', kind: 'sync'},
      {from: 'Rule cache', to: 'Redis', label: 'INCR firewall:rules:version', kind: 'sync'},
      {from: 'Rule cache', to: 'Redis', label: 'SET firewall:rules:v{n} = the whole set', kind: 'sync'},
      {from: 'Rule cache', to: 'Redis', label: 'EVAL swap · previous ← active · active ← v{n}', kind: 'sync'},
      {from: 'Redis', to: 'Rule cache', label: 'v{n} · one atomic step', kind: 'reply'},
      {from: 'Prompt Firewall', to: 'Rule cache', label: 'load_active() → version + complete set', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'versioned-blobs',
      title: 'Publishes each rule set as one immutable versioned value',
      detail:
        'A publish writes the whole set under `firewall:rules:v{version}` and never patches a rule into a shared hash. The draft `HSET`s one rule at a time, so a screen can match a rule set that never existed as a whole.',
      match: {
        python: {all: [/firewall:rules:v/, /def publish\(/], none: [/hset/]},
        typescript: {all: [/firewall:rules:v/, /async publish\(/], none: [/hset/]},
        go: {all: [/firewall:rules:v/, /\) publish\(ctx/], none: [/HSet/]},
        scala: {all: [/firewall:rules:v/, /def publish\(/], none: [/hSet/]},
        cpp: {all: [/firewall:rules:v/, /publish\(/], none: [/hset/]},
      },
    },
    {
      id: 'atomic-swap',
      title: 'Swaps the active pointer with one atomic script',
      detail:
        'The pointer swap is a single Lua `EVAL` that reads the old pointer into `firewall:rules:previous` and writes the new version, so no reader can see the two steps apart. The draft has no pointer and no swap at all.',
      match: {
        python: {all: [/SWAP_SCRIPT/, /\.eval\(/]},
        typescript: {all: [/SWAP_SCRIPT/, /\.eval\(/]},
        go: {all: [/swapScript/, /\.Eval\(/]},
        scala: {all: [/SwapScript/, /\.eval\(/]},
        cpp: {all: [/kSwapScript/, /redis\.eval/]},
      },
    },
    {
      id: 'rollback-previous',
      title: 'Rolls back to the recorded previous version',
      detail:
        '`rollback()` reads the version recorded by the last swap and activates that exact set. The draft keeps no previous pointer, so a rollback can only guess — and `version - 1` is wrong the moment a version is rolled back or rolled forward.',
      match: {
        python: {all: [/def rollback\(/, /PREV_KEY/]},
        typescript: {all: [/async rollback\(/, /PREV_KEY/]},
        go: {all: [/\) rollback\(ctx/, /prevKey/]},
        scala: {all: [/def rollback\(/, /PrevKey/]},
        cpp: {all: [/rollback\(/, /kPrevKey/]},
      },
    },
    {
      id: 'read-active',
      title: 'Readers resolve the pointer, then the complete versioned set',
      detail:
        '`load_active()` reads `firewall:rules:active` and then the whole set for that version, so a screen always runs against one complete batch. The draft `HGETALL`s the shared hash, which is a different (partially applied) set every time a batch is half written.',
      match: {
        python: {all: [/def load_active\(/, /\.get\(/], none: [/hgetall/]},
        typescript: {all: [/async loadActive\(/, /\.get\(/], none: [/hgetall/]},
        go: {all: [/\) loadActive\(ctx/, /\.Get\(/], none: [/HGetAll/]},
        scala: {all: [/def loadActive\(/, /\.get\(/], none: [/hGetAll/]},
        cpp: {all: [/loadActive\(/, /\.get\(/], none: [/hgetall/]},
      },
    },
    {
      id: 'new-version',
      title: 'Allocates a new version on every publish',
      detail:
        'Each publish allocates a fresh version with an atomic `INCR` and swaps the `active` pointer to it. The draft reuses the shared hash, so a publish mutates the set that in-flight screens are reading.',
      match: {
        python: {all: [/\.incr\(/, /ACTIVE_KEY/]},
        typescript: {all: [/\.incr\(/, /ACTIVE_KEY/]},
        go: {all: [/\.Incr\(/, /activeKey/]},
        scala: {all: [/\.incr\(/, /ActiveKey/]},
        cpp: {all: [/\.incr\(/, /kActiveKey/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

RULES_KEY = "firewall:rules"


class RuleCache:
    def __init__(self, client: redis.Redis) -> None:
        self.client = client

    # TODO: the draft patches one rule at a time into a shared hash and has no version pointer, so a
    # screen can match half a batch and a rollback cannot name the previous set. Publish whole
    # immutable versions under firewall:rules:v{n}, swap the active pointer atomically, and record
    # the previous version for rollback.
    def patch_rule(self, rule: dict) -> None:
        self.client.hset(RULES_KEY, rule["id"], json.dumps(rule))

    def load_rules(self) -> list[dict]:
        return [json.loads(value) for value in self.client.hgetall(RULES_KEY).values()]
`,
      solution: `import json

import redis

ACTIVE_KEY = "firewall:rules:active"
PREV_KEY = "firewall:rules:previous"
VERSION_KEY = "firewall:rules:version"

SWAP_SCRIPT = """
local previous = redis.call('GET', KEYS[1])
if previous then redis.call('SET', KEYS[2], previous) end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]
"""


class RuleCache:
    def __init__(self, client: redis.Redis) -> None:
        self.client = client

    def publish(self, rules: list[dict]) -> str:
        """Write the whole set under a new immutable version, then swap the pointer."""
        version = str(self.client.incr(VERSION_KEY))
        self.client.set(f"firewall:rules:v{version}", json.dumps(rules))
        return self.activate(version)

    def activate(self, version: str) -> str:
        """One atomic swap: the outgoing active version becomes the rollback target."""
        self.client.eval(SWAP_SCRIPT, 2, ACTIVE_KEY, PREV_KEY, version)
        return version

    def rollback(self) -> str:
        """Resolve the exact version the last swap recorded, and activate it."""
        previous = self.client.get(PREV_KEY)
        if previous is None:
            raise ValueError("no previous rule version")
        return self.activate(previous)

    def load_active(self) -> tuple[str, list[dict]]:
        """The pointer, then the whole set for that version — never a partially applied batch."""
        version = self.client.get(ACTIVE_KEY)
        if version is None:
            raise ValueError("no active rule version")
        return version, json.loads(self.client.get(f"firewall:rules:v{version}"))
`,
    },
    typescript: {
      starter: `/** A model-generated rule cache that patches one rule at a time into a shared hash. */
import Redis from 'ioredis';

const RULES_KEY = 'firewall:rules';

interface Rule {
  id: string;
  pattern: string;
  decision: 'block' | 'strip';
}

export class RuleCache {
  constructor(private readonly client: Redis) {}

  // TODO: the draft patches one rule at a time into a shared hash and has no version pointer, so a
  // screen can match half a batch and a rollback cannot name the previous set. Publish whole
  // immutable versions under firewall:rules:v{n}, swap the active pointer atomically, and record
  // the previous version for rollback.
  async patchRule(rule: Rule): Promise<void> {
    await this.client.hset(RULES_KEY, rule.id, JSON.stringify(rule));
  }

  async loadRules(): Promise<Rule[]> {
    const stored = await this.client.hgetall(RULES_KEY);
    return Object.values(stored).map(raw => JSON.parse(raw) as Rule);
  }
}
`,
      solution: `/** Versioned rule cache: immutable rule sets behind one atomic pointer swap. */
import Redis from 'ioredis';

export const ACTIVE_KEY = 'firewall:rules:active';
export const PREV_KEY = 'firewall:rules:previous';
export const VERSION_KEY = 'firewall:rules:version';

const SWAP_SCRIPT = \`
local previous = redis.call('GET', KEYS[1])
if previous then redis.call('SET', KEYS[2], previous) end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]
\`;

interface Rule {
  id: string;
  pattern: string;
  decision: 'block' | 'strip';
}

export class RuleCache {
  constructor(private readonly client: Redis) {}

  async publish(rules: Rule[]): Promise<string> {
    const version = String(await this.client.incr(VERSION_KEY));
    await this.client.set(\`firewall:rules:v\${version}\`, JSON.stringify(rules));
    return this.activate(version);
  }

  async activate(version: string): Promise<string> {
    await this.client.eval(SWAP_SCRIPT, 2, ACTIVE_KEY, PREV_KEY, version);
    return version;
  }

  async rollback(): Promise<string> {
    const previous = await this.client.get(PREV_KEY);
    if (previous === null) throw new Error('no previous rule version');
    return this.activate(previous);
  }

  async loadActive(): Promise<{version: string; rules: Rule[]}> {
    const version = await this.client.get(ACTIVE_KEY);
    if (version === null) throw new Error('no active rule version');
    const raw = await this.client.get(\`firewall:rules:v\${version}\`);
    return {version, rules: JSON.parse(raw ?? '[]') as Rule[]};
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const rulesKey = "firewall:rules"

type Rule struct {
	ID       string \`json:"id"\`
	Pattern  string \`json:"pattern"\`
	Decision string \`json:"decision"\`
}

type RuleCache struct {
	client *redis.Client
}

// TODO: the draft patches one rule at a time into a shared hash and has no version pointer, so a
// screen can match half a batch and a rollback cannot name the previous set. Publish whole
// immutable versions under firewall:rules:v{n}, swap the active pointer atomically, and record the
// previous version for rollback.
func (c *RuleCache) patchRule(ctx context.Context, rule Rule) error {
	blob, err := json.Marshal(rule)
	if err != nil {
		return err
	}
	return c.client.HSet(ctx, rulesKey, rule.ID, blob).Err()
}

func (c *RuleCache) loadRules(ctx context.Context) ([]Rule, error) {
	values, err := c.client.HGetAll(ctx, rulesKey).Result()
	if err != nil {
		return nil, err
	}
	rules := make([]Rule, 0, len(values))
	for _, raw := range values {
		var rule Rule
		if err := json.Unmarshal([]byte(raw), &rule); err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return rules, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	activeKey  = "firewall:rules:active"
	prevKey    = "firewall:rules:previous"
	versionKey = "firewall:rules:version"
)

const swapScript = \`
local previous = redis.call('GET', KEYS[1])
if previous then redis.call('SET', KEYS[2], previous) end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]
\`

type Rule struct {
	ID       string \`json:"id"\`
	Pattern  string \`json:"pattern"\`
	Decision string \`json:"decision"\`
}

type RuleCache struct {
	client *redis.Client
}

// publish writes the whole set under a new immutable version, then swaps the pointer.
func (c *RuleCache) publish(ctx context.Context, rules []Rule) (string, error) {
	version := strconv.FormatInt(c.client.Incr(ctx, versionKey).Val(), 10)
	blob, err := json.Marshal(rules)
	if err != nil {
		return "", err
	}
	if err := c.client.Set(ctx, "firewall:rules:v"+version, blob, 0).Err(); err != nil {
		return "", err
	}
	return c.activate(ctx, version)
}

// activate swaps the active pointer and records the outgoing version, atomically.
func (c *RuleCache) activate(ctx context.Context, version string) (string, error) {
	if err := c.client.Eval(ctx, swapScript, []string{activeKey, prevKey}, version).Err(); err != nil {
		return "", err
	}
	return version, nil
}

// rollback activates the exact version the last swap recorded.
func (c *RuleCache) rollback(ctx context.Context) (string, error) {
	previous, err := c.client.Get(ctx, prevKey).Result()
	if err != nil {
		return "", errors.New("no previous rule version")
	}
	return c.activate(ctx, previous)
}

// loadActive reads the pointer and then the whole versioned set; never a mutable hash.
func (c *RuleCache) loadActive(ctx context.Context) (string, []Rule, error) {
	version, err := c.client.Get(ctx, activeKey).Result()
	if err != nil {
		return "", nil, errors.New("no active rule version")
	}
	raw, err := c.client.Get(ctx, "firewall:rules:v"+version).Result()
	if err != nil {
		return "", nil, err
	}
	var rules []Rule
	if err := json.Unmarshal([]byte(raw), &rules); err != nil {
		return "", nil, err
	}
	return version, rules, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

object RuleCache {
  val RulesKey = "firewall:rules"

  final case class Rule(id: String, pattern: String, decision: String)

  // TODO: the draft patches one rule at a time into a shared hash and has no version pointer, so a
  // screen can match half a batch and a rollback cannot name the previous set. Publish whole
  // immutable versions under firewall:rules:v{n}, swap the active pointer atomically, and record
  // the previous version for rollback.
  def patchRule(jedis: Jedis, rule: Rule): Unit = {
    jedis.hset(RulesKey, rule.id, s"\${rule.id}|\${rule.pattern}|\${rule.decision}")
  }

  def loadRules(jedis: Jedis): List[Rule] = {
    jedis.hgetAll(RulesKey).asScala.values.toList.map { raw =>
      val parts = raw.split("\\\\|")
      Rule(parts(0), parts(1), parts(2))
    }
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object RuleCache {
  val ActiveKey = "firewall:rules:active"
  val PrevKey = "firewall:rules:previous"
  val VersionKey = "firewall:rules:version"

  final case class Rule(id: String, pattern: String, decision: String)

  val SwapScript =
    """
      |local previous = redis.call('GET', KEYS[1])
      |if previous then redis.call('SET', KEYS[2], previous) end
      |redis.call('SET', KEYS[1], ARGV[1])
      |return ARGV[1]
      |""".stripMargin

  def serialize(rules: List[Rule]): String =
    rules.map(rule => s"\${rule.id}|\${rule.pattern}|\${rule.decision}").mkString("\\n")

  def publish(jedis: Jedis, rules: List[Rule]): String = {
    val version = jedis.incr(VersionKey).toString
    jedis.set(s"firewall:rules:v$version", serialize(rules))
    activate(jedis, version)
  }

  def activate(jedis: Jedis, version: String): String = {
    jedis.eval(SwapScript, 2, ActiveKey, PrevKey, version)
    version
  }

  def rollback(jedis: Jedis): String = {
    val previous = Option(jedis.get(PrevKey)).getOrElse(throw new IllegalStateException("no previous rule version"))
    activate(jedis, previous)
  }

  def loadActive(jedis: Jedis): (String, List[Rule]) = {
    val version = Option(jedis.get(ActiveKey)).getOrElse(throw new IllegalStateException("no active rule version"))
    val raw = Option(jedis.get(s"firewall:rules:v$version")).getOrElse("")
    val rules = raw.split("\\n").toList.filter(_.nonEmpty).map { line =>
      val parts = line.split("\\\\|")
      Rule(parts(0), parts(1), parts(2))
    }
    (version, rules)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

const std::string kRulesKey = "firewall:rules";

struct Rule {
  std::string id;
  std::string pattern;
  std::string decision;
};

std::string serialize(const Rule& rule);
Rule deserialize(const std::string& raw);

// TODO: the draft patches one rule at a time into a shared hash and has no version pointer, so a
// screen can match half a batch and a rollback cannot name the previous set. Publish whole
// immutable versions under firewall:rules:v{n}, swap the active pointer atomically, and record the
// previous version for rollback.
void patchRule(sw::redis::Redis& redis, const Rule& rule) {
  redis.hset(kRulesKey, rule.id, serialize(rule));
}

std::vector<Rule> loadRules(sw::redis::Redis& redis) {
  std::vector<Rule> rules;
  for (const auto& entry : redis.hgetall(kRulesKey)) rules.push_back(deserialize(entry.second));
  return rules;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>
#include <vector>

const std::string kActiveKey = "firewall:rules:active";
const std::string kPrevKey = "firewall:rules:previous";
const std::string kVersionKey = "firewall:rules:version";

const std::string kSwapScript =
    "local previous = redis.call('GET', KEYS[1])\\n"
    "if previous then redis.call('SET', KEYS[2], previous) end\\n"
    "redis.call('SET', KEYS[1], ARGV[1])\\n"
    "return ARGV[1]\\n";

struct Rule {
  std::string id;
  std::string pattern;
  std::string decision;
};

std::string serialize(const std::vector<Rule>& rules);
std::vector<Rule> deserialize(const std::string& raw);

// activate swaps the active pointer and records the outgoing version in one atomic script.
std::string activate(sw::redis::Redis& redis, const std::string& version) {
  const auto swapped = redis.eval<std::string>(kSwapScript, {kActiveKey, kPrevKey}, {version});
  return swapped;
}

// publish writes the whole set under a new immutable version, then swaps the pointer.
std::string publish(sw::redis::Redis& redis, const std::vector<Rule>& rules) {
  const auto version = std::to_string(redis.incr(kVersionKey));
  redis.set("firewall:rules:v" + version, serialize(rules));
  return activate(redis, version);
}

// rollback activates the exact version the last swap recorded.
std::string rollback(sw::redis::Redis& redis) {
  const auto previous = redis.get(kPrevKey);
  if (!previous) throw std::runtime_error("no previous rule version");
  return activate(redis, *previous);
}

// loadActive reads the pointer and then the whole versioned set; never a mutable hash.
std::pair<std::string, std::vector<Rule>> loadActive(sw::redis::Redis& redis) {
  const auto version = redis.get(kActiveKey);
  if (!version) throw std::runtime_error("no active rule version");
  const auto raw = redis.get("firewall:rules:v" + *version);
  if (!raw) throw std::runtime_error("active rule set is missing");
  return {*version, deserialize(*raw)};
}
`,
    },
  },
  hints: [
    'The unit of publication is the *set*, not the rule. `SET firewall:rules:v{version} <whole set>` then swap one pointer key; the pointer is the only mutable thing in the cache, and it is one word long.',
    'Do not swap with two commands. `SET previous <active>` followed by `SET active <version>` has a window where both are new or neither is; put both writes in one `EVAL` so the history and the pointer land together, and so a reader never sees a version that is not stored yet.',
    'Rollback is a lookup, not arithmetic. `version - 1` is right only if every version is published and never reverted; the moment an operator rolls back and then forward, the previous set is not `active - 1`. Record it at swap time and read it back.',
  ],
  debrief: `The interviewer is testing whether you know what a rule cache has to guarantee: one complete, immutable rule set per version, and one atomic pointer swap, so the firewall's behaviour is a function of the version and not of scheduling. The draft's \`HSET\` looks harmless and is the whole bug — a batch applied rule by rule is a rule set that never existed, and the prompt that matched only half of it is unexplainable afterwards. The second half of the step is rollback: naming the previous set requires recording it, because the rollback path is exactly the path where arithmetic on versions breaks. Real systems add a publish policy (validate the whole set against the schema before the write), a TTL on very old versions so the cache does not grow forever, and a metric on how long the active version has been in place.`,
};
