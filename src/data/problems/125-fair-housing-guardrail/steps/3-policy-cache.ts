import type {Step} from '@/lib/types';

export const policyCacheStep: Step = {
  id: 'policy-cache',
  title: 'Redis: versioned policy with an atomic publish, decision cache, expiring strikes',
  concept: 'redis',
  guides: ['keys-and-expiry'],
  file: 'policy_cache',
  focus: ['guard', 'redis', 'policy'],
  task: `## Task

**Starting point.** The starter is the policy cache (provided to the other steps as
\`fhguard.cache\`). \`get_policy(version)\` reads one key, \`fh:policy\`, and on a miss loads
\`store.load_policy(version)\` and sets it with no TTL. \`publish(policy)\` sets \`fh:policy:active\`,
then saves the policy to the store. \`cached_decision\`/\`cache_decision(version, text, …)\` use
\`fh:decision:{text}\` with no TTL, and \`record_strike\` is a bare \`INCR\` on
\`fh:strikes:{conversation_id}\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** Legal publishes a new stop list and every reader keeps the first
policy it cached. Right after a publish the active version names a policy no store holds yet. A
verdict reached under the old policy is served under the new one. User questions become Redis key
names, visible to \`SCAN\` and every dump. One bad week flags a conversation forever.

- Cache a policy under \`fh:policy:{version}\` for \`POLICY_TTL_S\` = 3600 s, loading it from the
  store on a miss.
- \`publish\` saves to the store first, then sets \`fh:policy:{version}\` and \`fh:policy:active\` in
  one MULTI/EXEC.
- Cache decisions under \`fh:decision:{version}:{sha256 hex of the text}\` for \`DECISION_TTL_S\` =
  86400 s.
- \`record_strike\` sets \`STRIKE_TTL_S\` = 86400 s on the first strike only: strikes expire a day
  after the first.`,
  sequence: {
    participants: ['fhguard', 'Redis', 'policy store'],
    messages: [
      {from: 'fhguard', to: 'Redis', label: 'GET fh:policy:{version}', kind: 'sync'},
      {from: 'fhguard', to: 'policy store', label: 'load_policy(version) on a miss · SET EX 3600', kind: 'sync'},
      {from: 'fhguard', to: 'policy store', label: 'publish: save_policy(policy)', kind: 'sync'},
      {from: 'fhguard', to: 'Redis', label: 'MULTI · SET fh:policy:{v} EX · SET fh:policy:active · EXEC', kind: 'sync'},
      {from: 'fhguard', to: 'Redis', label: 'GET/SET fh:decision:{version}:{sha256} EX 86400', kind: 'sync'},
      {from: 'fhguard', to: 'Redis', label: 'INCR fh:strikes:{conversation} · EXPIRE 86400 on the first', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'versioned-policy',
      title: 'Caches each policy version under its own key for an hour',
      detail:
        'A policy is cached under `fh:policy:{version}` with a one-hour TTL and loaded from the store on a miss; the starter caches the first policy it sees under one version-less key, forever.',
      match: {
        python: {
          all: [/fh:policy:\{version\}/, /POLICY_TTL_S\s*=\s*3600\b/, /ex\s*=\s*POLICY_TTL_S/],
          none: [/get\(POLICY_KEY\)/],
        },
        typescript: {
          all: [/fh:policy:\$\{version\}/, /POLICY_TTL_S\s*=\s*3600\b/, /'EX',\s*POLICY_TTL_S/],
          none: [/get\(POLICY_KEY\)/],
        },
        go: {
          all: [/"fh:policy:"\s*\+\s*version/, /policyTTL\s*=\s*(time\.Hour|3600\s*\*\s*time\.Second)/, /policyTTL\)/],
          none: [/Get\(ctx,\s*policyKey\)/],
        },
        scala: {
          all: [/s"fh:policy:\$version"/, /PolicyTtlSeconds\s*=\s*3600L?\b/, /setex\([^\n]*PolicyTtlSeconds/],
          none: [/get\(PolicyKey\)/],
        },
        cpp: {all: [/"fh:policy:"\s*\+\s*version/, /kPolicyTtl\{3600\}/, /kPolicyTtl\)/], none: [/get\(kPolicyKey\)/]},
      },
    },
    {
      id: 'atomic-publish',
      title: 'Publishes the version, then moves the active pointer with its cache entry in one transaction',
      detail:
        '`publish` saves the policy to the store, then sets `fh:policy:{version}` and `fh:policy:active` in one MULTI/EXEC, so a reader that sees the new version finds its policy; the starter moves the pointer before the version exists anywhere.',
      match: {
        python: {
          all: [/pipeline\(transaction=True\)/, /\.execute\(\)/],
          order: [/store\.save_policy\(/, /\.set\(ACTIVE_KEY/],
        },
        typescript: {all: [/\.multi\(\)/, /\.exec\(\)/], order: [/savePolicy\(policy\)/, /\.set\(ACTIVE_KEY/]},
        go: {all: [/TxPipelined\(/], order: [/store\.SavePolicy\(/, /Set\(ctx,\s*activeKey/]},
        scala: {all: [/\.multi\(\)/, /\.exec\(\)/], order: [/Store\.savePolicy\(/, /\.set\(ActiveKey/]},
        cpp: {all: [/\.transaction\(\)/, /\.exec\(\)/], order: [/store::savePolicy\(/, /\.set\(kActiveKey/]},
      },
    },
    {
      id: 'versioned-decision',
      title: 'Caches decisions per policy version, for a day',
      detail:
        'A decision is cached under `fh:decision:{version}:{hash}` with a one-day TTL, so a new policy version starts from an empty cache; the starter’s key has no version and no TTL.',
      match: {
        python: {all: [/fh:decision:\{version\}:/, /DECISION_TTL_S\s*=\s*86_?400\b/, /ex\s*=\s*DECISION_TTL_S/]},
        typescript: {all: [/fh:decision:\$\{version\}:/, /DECISION_TTL_S\s*=\s*86_?400\b/, /'EX',\s*DECISION_TTL_S/]},
        go: {
          all: [/"fh:decision:"\s*\+\s*version\s*\+\s*":"/, /decisionTTL\s*=\s*24\s*\*\s*time\.Hour/, /decisionTTL\)/],
        },
        scala: {
          all: [/s"fh:decision:\$version:/, /DecisionTtlSeconds\s*=\s*86400L?\b/, /setex\([^\n]*DecisionTtlSeconds/],
        },
        cpp: {all: [/"fh:decision:"\s*\+\s*version\s*\+\s*":"/, /kDecisionTtl\{86400\}/, /kDecisionTtl\)/]},
      },
    },
    {
      id: 'hash-not-text',
      title: 'Keys a decision by the SHA-256 of the text, never the text',
      detail:
        'The decision key carries the SHA-256 hex of the text; the starter puts the user’s question in the key name, where `SCAN`, `MONITOR` and every dump show it.',
      match: {
        python: {all: [/hashlib\.sha256\(/], none: [/fh:decision:\{text\}/]},
        typescript: {all: [/createHash\(\s*'sha256'\s*\)/], none: [/fh:decision:\$\{text\}/]},
        go: {all: [/sha256\.Sum256\(/], none: [/"fh:decision:"\s*\+\s*text\b/]},
        scala: {all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/], none: [/fh:decision:\$text\b/]},
        cpp: {all: [/sha256_hex\(/], none: [/"fh:decision:"\s*\+\s*text\b/]},
      },
    },
    {
      id: 'strikes-expire',
      title: 'Strikes expire a day after the first',
      detail:
        '`fh:strikes:{conversation_id}` gets a one-day TTL when the first strike creates it, and later strikes leave it alone; the starter’s bare `INCR` keeps a conversation flagged forever.',
      match: {
        python: {all: [/STRIKE_TTL_S\s*=\s*86_?400\b/, /\.expire\([^\n]*STRIKE_TTL_S/]},
        typescript: {all: [/STRIKE_TTL_S\s*=\s*86_?400\b/, /\.expire\([^\n]*STRIKE_TTL_S/]},
        go: {all: [/strikeTTL\s*=\s*24\s*\*\s*time\.Hour/, /\.Expire\([^\n]*strikeTTL/]},
        scala: {all: [/StrikeTtlSeconds\s*=\s*86400L?\b/, /\.expire\([^\n]*StrikeTtlSeconds/]},
        cpp: {all: [/kStrikeTtl\{86400\}/, /\.expire\([^\n]*kStrikeTtl/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
from dataclasses import asdict

import redis

from fhguard import store  # load_policy(version) -> Policy | None, save_policy(policy)
from fhguard.store import Decision, Policy

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POLICY_KEY = "fh:policy"
ACTIVE_KEY = "fh:policy:active"


def get_policy(version: str) -> Policy | None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    raw = r.get(POLICY_KEY)
    if raw is not None:
        return Policy(**json.loads(raw))
    policy = store.load_policy(version)
    if policy is not None:
        r.set(POLICY_KEY, json.dumps(asdict(policy)))
    return policy


def active_version() -> str | None:
    return r.get(ACTIVE_KEY)


def publish(policy: Policy) -> None:
    r.set(ACTIVE_KEY, policy.version)
    store.save_policy(policy)


def cached_decision(version: str, text: str) -> Decision | None:
    raw = r.get(f"fh:decision:{text}")
    return None if raw is None else Decision(**json.loads(raw))


def cache_decision(version: str, text: str, decision: Decision) -> None:
    r.set(f"fh:decision:{text}", json.dumps(asdict(decision)))


def record_strike(conversation_id: str) -> int:
    return int(r.incr(f"fh:strikes:{conversation_id}"))
`,
      solution: `import hashlib
import json
from dataclasses import asdict

import redis

from fhguard import store  # load_policy(version) -> Policy | None, save_policy(policy)
from fhguard.store import Decision, Policy

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POLICY_TTL_S = 3600
DECISION_TTL_S = 86_400
STRIKE_TTL_S = 86_400
ACTIVE_KEY = "fh:policy:active"


def get_policy(version: str) -> Policy | None:
    key = f"fh:policy:{version}"
    raw = r.get(key)
    if raw is not None:
        return Policy(**json.loads(raw))
    policy = store.load_policy(version)
    if policy is not None:
        r.set(key, json.dumps(asdict(policy)), ex=POLICY_TTL_S)
    return policy


def active_version() -> str | None:
    return r.get(ACTIVE_KEY)


def publish(policy: Policy) -> None:
    store.save_policy(policy)  # the version exists before anything points at it
    pipe = r.pipeline(transaction=True)
    pipe.set(f"fh:policy:{policy.version}", json.dumps(asdict(policy)), ex=POLICY_TTL_S)
    pipe.set(ACTIVE_KEY, policy.version)
    pipe.execute()


def decision_key(version: str, text: str) -> str:
    return f"fh:decision:{version}:{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


def cached_decision(version: str, text: str) -> Decision | None:
    raw = r.get(decision_key(version, text))
    return None if raw is None else Decision(**json.loads(raw))


def cache_decision(version: str, text: str, decision: Decision) -> None:
    r.set(decision_key(version, text), json.dumps(asdict(decision)), ex=DECISION_TTL_S)


def record_strike(conversation_id: str) -> int:
    key = f"fh:strikes:{conversation_id}"
    strikes = int(r.incr(key))
    if strikes == 1:
        r.expire(key, STRIKE_TTL_S)  # the window starts at the first strike and does not slide
    return strikes
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Decision, type Policy, loadPolicy, savePolicy} from 'fhguard/store';

const redis = new Redis({host: 'redis', port: 6379});

const POLICY_KEY = 'fh:policy';
export const ACTIVE_KEY = 'fh:policy:active';

export async function getPolicy(version: string): Promise<Policy | null> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const raw = await redis.get(POLICY_KEY);
  if (raw !== null) return JSON.parse(raw) as Policy;
  const policy = await loadPolicy(version);
  if (policy !== null) await redis.set(POLICY_KEY, JSON.stringify(policy));
  return policy;
}

export async function activeVersion(): Promise<string | null> {
  return redis.get(ACTIVE_KEY);
}

export async function publish(policy: Policy): Promise<void> {
  await redis.set(ACTIVE_KEY, policy.version);
  await savePolicy(policy);
}

export async function cachedDecision(version: string, text: string): Promise<Decision | null> {
  const raw = await redis.get(\`fh:decision:\${text}\`);
  return raw === null ? null : (JSON.parse(raw) as Decision);
}

export async function cacheDecision(version: string, text: string, decision: Decision): Promise<void> {
  await redis.set(\`fh:decision:\${text}\`, JSON.stringify(decision));
}

export async function recordStrike(conversationId: string): Promise<number> {
  return redis.incr(\`fh:strikes:\${conversationId}\`);
}
`,
      solution: `import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {type Decision, type Policy, loadPolicy, savePolicy} from 'fhguard/store';

const redis = new Redis({host: 'redis', port: 6379});

export const POLICY_TTL_S = 3600;
export const DECISION_TTL_S = 86_400;
export const STRIKE_TTL_S = 86_400;
export const ACTIVE_KEY = 'fh:policy:active';

export async function getPolicy(version: string): Promise<Policy | null> {
  const key = \`fh:policy:\${version}\`;
  const raw = await redis.get(key);
  if (raw !== null) return JSON.parse(raw) as Policy;
  const policy = await loadPolicy(version);
  if (policy !== null) await redis.set(key, JSON.stringify(policy), 'EX', POLICY_TTL_S);
  return policy;
}

export async function activeVersion(): Promise<string | null> {
  return redis.get(ACTIVE_KEY);
}

export async function publish(policy: Policy): Promise<void> {
  await savePolicy(policy); // the version exists before anything points at it
  await redis
    .multi()
    .set(\`fh:policy:\${policy.version}\`, JSON.stringify(policy), 'EX', POLICY_TTL_S)
    .set(ACTIVE_KEY, policy.version)
    .exec();
}

const decisionKey = (version: string, text: string): string =>
  \`fh:decision:\${version}:\${createHash('sha256').update(text, 'utf8').digest('hex')}\`;

export async function cachedDecision(version: string, text: string): Promise<Decision | null> {
  const raw = await redis.get(decisionKey(version, text));
  return raw === null ? null : (JSON.parse(raw) as Decision);
}

export async function cacheDecision(version: string, text: string, decision: Decision): Promise<void> {
  await redis.set(decisionKey(version, text), JSON.stringify(decision), 'EX', DECISION_TTL_S);
}

export async function recordStrike(conversationId: string): Promise<number> {
  const key = \`fh:strikes:\${conversationId}\`;
  const strikes = await redis.incr(key);
  if (strikes === 1) await redis.expire(key, STRIKE_TTL_S); // the window starts at the first strike and does not slide
  return strikes;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"fhguard/store" // LoadPolicy(ctx, version) (*Policy, error), SavePolicy(ctx, policy); Policy, Decision
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	policyKey = "fh:policy"
	activeKey = "fh:policy:active"
)

func getPolicy(ctx context.Context, version string) (*store.Policy, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	raw, err := rdb.Get(ctx, policyKey).Result()
	if err == nil {
		var policy store.Policy
		return &policy, json.Unmarshal([]byte(raw), &policy)
	}
	policy, err := store.LoadPolicy(ctx, version)
	if err != nil || policy == nil {
		return nil, err
	}
	doc, _ := json.Marshal(policy)
	return policy, rdb.Set(ctx, policyKey, doc, 0).Err()
}

func activeVersion(ctx context.Context) string {
	return rdb.Get(ctx, activeKey).Val()
}

func publish(ctx context.Context, policy store.Policy) error {
	if err := rdb.Set(ctx, activeKey, policy.Version, 0).Err(); err != nil {
		return err
	}
	return store.SavePolicy(ctx, policy)
}

func cachedDecision(ctx context.Context, version, text string) (*store.Decision, error) {
	raw, err := rdb.Get(ctx, "fh:decision:"+text).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var decision store.Decision
	return &decision, json.Unmarshal([]byte(raw), &decision)
}

func cacheDecision(ctx context.Context, version, text string, decision store.Decision) error {
	doc, _ := json.Marshal(decision)
	return rdb.Set(ctx, "fh:decision:"+text, doc, 0).Err()
}

func recordStrike(ctx context.Context, conversationID string) (int64, error) {
	return rdb.Incr(ctx, "fh:strikes:"+conversationID).Result()
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"fhguard/store" // LoadPolicy(ctx, version) (*Policy, error), SavePolicy(ctx, policy); Policy, Decision
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	policyTTL   = time.Hour
	decisionTTL = 24 * time.Hour
	strikeTTL   = 24 * time.Hour
	activeKey   = "fh:policy:active"
)

func getPolicy(ctx context.Context, version string) (*store.Policy, error) {
	key := "fh:policy:" + version
	raw, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var policy store.Policy
		return &policy, json.Unmarshal([]byte(raw), &policy)
	}
	if err != redis.Nil {
		return nil, err
	}
	policy, err := store.LoadPolicy(ctx, version)
	if err != nil || policy == nil {
		return nil, err
	}
	doc, _ := json.Marshal(policy)
	return policy, rdb.Set(ctx, key, doc, policyTTL).Err()
}

func activeVersion(ctx context.Context) string {
	return rdb.Get(ctx, activeKey).Val()
}

func publish(ctx context.Context, policy store.Policy) error {
	// The version exists before anything points at it.
	if err := store.SavePolicy(ctx, policy); err != nil {
		return err
	}
	doc, _ := json.Marshal(policy)
	_, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.Set(ctx, "fh:policy:"+policy.Version, doc, policyTTL)
		pipe.Set(ctx, activeKey, policy.Version, 0)
		return nil
	})
	return err
}

func decisionKey(version, text string) string {
	sum := sha256.Sum256([]byte(text))
	return "fh:decision:" + version + ":" + hex.EncodeToString(sum[:])
}

func cachedDecision(ctx context.Context, version, text string) (*store.Decision, error) {
	raw, err := rdb.Get(ctx, decisionKey(version, text)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var decision store.Decision
	return &decision, json.Unmarshal([]byte(raw), &decision)
}

func cacheDecision(ctx context.Context, version, text string, decision store.Decision) error {
	doc, _ := json.Marshal(decision)
	return rdb.Set(ctx, decisionKey(version, text), doc, decisionTTL).Err()
}

func recordStrike(ctx context.Context, conversationID string) (int64, error) {
	key := "fh:strikes:" + conversationID
	strikes, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	if strikes == 1 {
		rdb.Expire(ctx, key, strikeTTL) // the window starts at the first strike and does not slide
	}
	return strikes, nil
}
`,
    },
    scala: {
      starter: `import spray.json._

import fhguard.Store // Store.loadPolicy(version), Store.savePolicy(policy); Store.Policy, Store.Decision

object PolicyCache {
  private val jedis = Store.jedis

  val PolicyKey = "fh:policy"
  val ActiveKey = "fh:policy:active"

  def getPolicy(version: String): Option[Store.Policy] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    Option(jedis.get(PolicyKey)).map(raw => Store.policyFrom(raw.parseJson)).orElse {
      val policy = Store.loadPolicy(version)
      policy.foreach(p => jedis.set(PolicyKey, Store.policyJson(p).compactPrint))
      policy
    }
  }

  def activeVersion(): Option[String] = Option(jedis.get(ActiveKey))

  def publish(policy: Store.Policy): Unit = {
    jedis.set(ActiveKey, policy.version)
    Store.savePolicy(policy)
  }

  def cachedDecision(version: String, text: String): Option[Store.Decision] =
    Option(jedis.get(s"fh:decision:$text")).map(raw => Store.decisionFrom(raw.parseJson))

  def cacheDecision(version: String, text: String, decision: Store.Decision): Unit =
    jedis.set(s"fh:decision:$text", Store.decisionJson(decision).compactPrint)

  def recordStrike(conversationId: String): Long = jedis.incr(s"fh:strikes:$conversationId")
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import spray.json._

import fhguard.Store // Store.loadPolicy(version), Store.savePolicy(policy); Store.Policy, Store.Decision

object PolicyCache {
  private val jedis = Store.jedis

  val PolicyTtlSeconds = 3600L
  val DecisionTtlSeconds = 86400L
  val StrikeTtlSeconds = 86400L
  val ActiveKey = "fh:policy:active"

  def getPolicy(version: String): Option[Store.Policy] =
    Option(jedis.get(s"fh:policy:$version")).map(raw => Store.policyFrom(raw.parseJson)).orElse {
      val policy = Store.loadPolicy(version)
      policy.foreach(p => jedis.setex(s"fh:policy:$version", PolicyTtlSeconds, Store.policyJson(p).compactPrint))
      policy
    }

  def activeVersion(): Option[String] = Option(jedis.get(ActiveKey))

  def publish(policy: Store.Policy): Unit = {
    Store.savePolicy(policy) // the version exists before anything points at it
    val tx = jedis.multi()
    tx.setex(s"fh:policy:\${policy.version}", PolicyTtlSeconds, Store.policyJson(policy).compactPrint)
    tx.set(ActiveKey, policy.version)
    tx.exec()
  }

  private def decisionKey(version: String, text: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))
    s"fh:decision:$version:\${digest.map("%02x".format(_)).mkString}"
  }

  def cachedDecision(version: String, text: String): Option[Store.Decision] =
    Option(jedis.get(decisionKey(version, text))).map(raw => Store.decisionFrom(raw.parseJson))

  def cacheDecision(version: String, text: String, decision: Store.Decision): Unit =
    jedis.setex(decisionKey(version, text), DecisionTtlSeconds, Store.decisionJson(decision).compactPrint)

  def recordStrike(conversationId: String): Long = {
    val key = s"fh:strikes:$conversationId"
    val strikes = jedis.incr(key)
    if (strikes == 1L) jedis.expire(key, StrikeTtlSeconds) // the window starts at the first strike and does not slide
    strikes
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

#include "fhguard/store.h"  // store::loadPolicy(version), store::savePolicy(policy); Policy, Decision

sw::redis::Redis redis("tcp://redis:6379");

const std::string kPolicyKey = "fh:policy";
const std::string kActiveKey = "fh:policy:active";

std::optional<store::Policy> getPolicy(const std::string& version) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  if (const auto raw = redis.get(kPolicyKey)) return nlohmann::json::parse(*raw).get<store::Policy>();
  const auto policy = store::loadPolicy(version);
  if (policy) redis.set(kPolicyKey, nlohmann::json(*policy).dump());
  return policy;
}

std::optional<std::string> activeVersion() {
  const auto version = redis.get(kActiveKey);
  if (!version) return std::nullopt;
  return *version;
}

void publish(const store::Policy& policy) {
  redis.set(kActiveKey, policy.version);
  store::savePolicy(policy);
}

std::optional<store::Decision> cachedDecision(const std::string& version, const std::string& text) {
  const auto raw = redis.get("fh:decision:" + text);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<store::Decision>();
}

void cacheDecision(const std::string& version, const std::string& text, const store::Decision& decision) {
  redis.set("fh:decision:" + text, nlohmann::json(decision).dump());
}

long long recordStrike(const std::string& conversation_id) { return redis.incr("fh:strikes:" + conversation_id); }
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "digest.h"         // sha256_hex(bytes)
#include "fhguard/store.h"  // store::loadPolicy(version), store::savePolicy(policy); Policy, Decision

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kPolicyTtl{3600};
constexpr std::chrono::seconds kDecisionTtl{86400};
constexpr std::chrono::seconds kStrikeTtl{86400};
const std::string kActiveKey = "fh:policy:active";

std::optional<store::Policy> getPolicy(const std::string& version) {
  const std::string key = "fh:policy:" + version;
  if (const auto raw = redis.get(key)) return nlohmann::json::parse(*raw).get<store::Policy>();
  const auto policy = store::loadPolicy(version);
  if (policy) redis.set(key, nlohmann::json(*policy).dump(), kPolicyTtl);
  return policy;
}

std::optional<std::string> activeVersion() {
  const auto version = redis.get(kActiveKey);
  if (!version) return std::nullopt;
  return *version;
}

void publish(const store::Policy& policy) {
  store::savePolicy(policy);  // the version exists before anything points at it
  auto tx = redis.transaction();
  tx.set("fh:policy:" + policy.version, nlohmann::json(policy).dump(), kPolicyTtl).set(kActiveKey, policy.version);
  tx.exec();
}

std::string decisionKey(const std::string& version, const std::string& text) {
  return "fh:decision:" + version + ":" + sha256_hex(text);
}

std::optional<store::Decision> cachedDecision(const std::string& version, const std::string& text) {
  const auto raw = redis.get(decisionKey(version, text));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<store::Decision>();
}

void cacheDecision(const std::string& version, const std::string& text, const store::Decision& decision) {
  redis.set(decisionKey(version, text), nlohmann::json(decision).dump(), kDecisionTtl);
}

long long recordStrike(const std::string& conversation_id) {
  const std::string key = "fh:strikes:" + conversation_id;
  const long long strikes = redis.incr(key);
  if (strikes == 1) redis.expire(key, kStrikeTtl);  // the window starts at the first strike and does not slide
  return strikes;
}
`,
    },
  },
  harness: {
    python: `import hashlib
from dataclasses import asdict

from fhguard import store
from fhguard.store import Decision, Policy

V1 = Policy("fh-2024-05-21", ["no section 8"])
V2 = Policy("fh-2024-06-01", ["no section 8", "adults only"])
V3 = Policy("fh-2024-07-01", ["no section 8", "adults only", "no vouchers"])
TEXT = "Which blocks have fewer families with kids?"
BLOCKED = Decision(False, "classifier", 0.4, ["classifier:familial_status"])


def _cache(ctx):
    store.save_policy(V1)
    store.save_policy(V2)
    return ctx.load("policy_cache")


def _phrases(policy):
    return None if policy is None else list(policy.stop_phrases)


def check_versioned_policy(ctx):
    m = _cache(ctx)
    assert _phrases(m.get_policy(V1.version)) == V1.stop_phrases, f"get_policy({V1.version!r}) returned {m.get_policy(V1.version)}"
    got = m.get_policy(V2.version)
    assert _phrases(got) == V2.stop_phrases, f"get_policy({V2.version!r}) returned {got}: the policy cached for {V1.version} answered for another version. Key the cache by version"
    ttl = ctx.redis.ttl(f"fh:policy:{V1.version}")
    assert 0 < ttl <= 3600, f"fh:policy:{V1.version} has TTL {ttl}, expected at most POLICY_TTL_S = 3600 (keys: {sorted(ctx.redis.keys('fh:policy*'))})"
    assert m.get_policy("fh-2023-01-01") is None, "a version no store holds must come back None"
    ctx.clock.advance(3601)
    assert ctx.redis.get(f"fh:policy:{V1.version}") is None, "the cached policy must expire after an hour"
    assert _phrases(m.get_policy(V1.version)) == V1.stop_phrases, "after expiry the policy is loaded from the store again"


def check_atomic_publish(ctx):
    m = _cache(ctx)
    m.publish(V2)
    assert m.active_version() == V2.version, f"after publishing {V2.version} the active version is {m.active_version()!r}"
    key = f"fh:policy:{V3.version}"
    seen = ctx.redis_after("fh:policy:active", lambda: (ctx.redis.get("fh:policy:active"), ctx.redis.get(key), ctx.redis.exists(f"fhstore:policy:{V3.version}")))
    m.publish(V3)
    assert seen.fired, "publish never touched fh:policy:active"
    active, cached, stored = seen.result
    assert active == V3.version, f"fh:policy:active held {active!r} right after the publish wrote it"
    assert stored, f"fh:policy:active pointed at {V3.version} before the store held that version: a reader in between finds no policy"
    assert cached is not None, f"fh:policy:active pointed at {V3.version} while {key} was missing: move the pointer and the cache entry in one MULTI/EXEC"
    assert _phrases(m.get_policy(m.active_version())) == V3.stop_phrases, f"a reader after the publish got {m.get_policy(m.active_version())}"
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= 3600, f"{key} has TTL {ttl}, expected at most POLICY_TTL_S = 3600"


def check_versioned_decision(ctx):
    m = _cache(ctx)
    m.cache_decision(V1.version, TEXT, BLOCKED)
    got = m.cached_decision(V1.version, TEXT)
    assert got is not None and got.allowed is False and got.reasons == BLOCKED.reasons, f"cached_decision under the same version returned {got}"
    other = m.cached_decision(V2.version, TEXT)
    assert other is None, f"a decision cached under {V1.version} was served under {V2.version}: {other}. The key must carry the policy version"
    keys = ctx.redis.keys("fh:decision:*")
    assert len(keys) == 1, f"one cached decision left the keys {keys}"
    ttl = ctx.redis.ttl(keys[0])
    assert 0 < ttl <= 86400, f"{keys[0]} has TTL {ttl}, expected at most DECISION_TTL_S = 86400"
    ctx.clock.advance(86401)
    assert m.cached_decision(V1.version, TEXT) is None, "a cached decision must expire after a day"


def check_hash_not_text(ctx):
    m = _cache(ctx)
    m.cache_decision(V1.version, TEXT, BLOCKED)
    leaked = [k for k in ctx.redis.keys("*") if "families" in k]
    assert not leaked, f"the user's question is a Redis key name: {leaked}"
    expected = f"fh:decision:{V1.version}:{hashlib.sha256(TEXT.encode('utf-8')).hexdigest()}"
    assert ctx.redis.exists(expected), f"expected the decision under {expected}, Redis holds {sorted(ctx.redis.keys('fh:decision:*'))}"
    assert asdict(m.cached_decision(V1.version, TEXT)) == asdict(BLOCKED), "the cached decision must read back unchanged"


def check_strikes_expire(ctx):
    m = _cache(ctx)
    counts = [m.record_strike("c-1") for _ in range(3)]
    assert counts == [1, 2, 3], f"three strikes counted {counts}"
    ttl = ctx.redis.ttl("fh:strikes:c-1")
    assert 0 < ttl <= 86400, f"fh:strikes:c-1 has TTL {ttl}: a conversation stays flagged forever. Expire it STRIKE_TTL_S after the first strike"
    ctx.clock.advance(80_000)
    assert m.record_strike("c-1") == 4, "a strike within the day adds to the count"
    ctx.clock.advance(7_000)
    fresh = m.record_strike("c-1")
    assert fresh == 1, f"87000 s after the first strike the count is {fresh}: the window starts at the first strike and a later strike must not extend it"
    assert m.record_strike("c-2") == 1, "strikes are counted per conversation"
`,
    typescript: `const V1 = {version: 'fh-2024-05-21', stop_phrases: ['no section 8']};
const V2 = {version: 'fh-2024-06-01', stop_phrases: ['no section 8', 'adults only']};
const V3 = {version: 'fh-2024-07-01', stop_phrases: ['no section 8', 'adults only', 'no vouchers']};
const TEXT = 'Which blocks have fewer families with kids?';
const BLOCKED = {allowed: false, tier: 'classifier', score: 0.4, reasons: ['classifier:familial_status']};

async function cache(ctx) {
  const store = ctx.load('/support/fhguard/store.ts');
  await store.savePolicy(V1);
  await store.savePolicy(V2);
  return ctx.load('policy_cache');
}

const phrases = p => (p === null ? null : JSON.stringify(p.stop_phrases));

export async function check_versioned_policy(ctx) {
  const m = await cache(ctx);
  assert.equal(phrases(await m.getPolicy(V1.version)), JSON.stringify(V1.stop_phrases), \`getPolicy(\${V1.version}) returned the wrong policy\`);
  const got = await m.getPolicy(V2.version);
  assert.equal(phrases(got), JSON.stringify(V2.stop_phrases), \`getPolicy(\${V2.version}) returned \${JSON.stringify(got)}: the policy cached for \${V1.version} answered for another version. Key the cache by version\`);
  const ttl = ctx.redis.ttl(\`fh:policy:\${V1.version}\`);
  assert(0 < ttl && ttl <= 3600, \`fh:policy:\${V1.version} has TTL \${ttl}, expected at most POLICY_TTL_S = 3600 (keys: \${JSON.stringify(ctx.redis.keys('fh:policy*'))})\`);
  assert.equal(await m.getPolicy('fh-2023-01-01'), null, 'a version no store holds must come back null');
  ctx.clock.advance(3601);
  assert.equal(ctx.redis.get(\`fh:policy:\${V1.version}\`), null, 'the cached policy must expire after an hour');
  assert.equal(phrases(await m.getPolicy(V1.version)), JSON.stringify(V1.stop_phrases), 'after expiry the policy is loaded from the store again');
}

export async function check_atomic_publish(ctx) {
  const m = await cache(ctx);
  await m.publish(V2);
  assert.equal(await m.activeVersion(), V2.version, \`after publishing \${V2.version} the active version must name it\`);
  const key = \`fh:policy:\${V3.version}\`;
  const seen = ctx.redisAfter('fh:policy:active', () => [ctx.redis.get('fh:policy:active'), ctx.redis.get(key), ctx.redis.exists(\`fhstore:policy:\${V3.version}\`)]);
  await m.publish(V3);
  assert(seen.fired, 'publish never touched fh:policy:active');
  const [active, cached, stored] = seen.result;
  assert.equal(active, V3.version, \`fh:policy:active held \${JSON.stringify(active)} right after the publish wrote it\`);
  assert.equal(stored, 1, \`fh:policy:active pointed at \${V3.version} before the store held that version: a reader in between finds no policy\`);
  assert(cached !== null, \`fh:policy:active pointed at \${V3.version} while \${key} was missing: move the pointer and the cache entry in one MULTI/EXEC\`);
  assert.equal(phrases(await m.getPolicy(await m.activeVersion())), JSON.stringify(V3.stop_phrases), 'a reader after the publish must get the new policy');
  const ttl = ctx.redis.ttl(key);
  assert(0 < ttl && ttl <= 3600, \`\${key} has TTL \${ttl}, expected at most POLICY_TTL_S = 3600\`);
}

export async function check_versioned_decision(ctx) {
  const m = await cache(ctx);
  await m.cacheDecision(V1.version, TEXT, BLOCKED);
  const got = await m.cachedDecision(V1.version, TEXT);
  assert(got !== null && got.allowed === false && JSON.stringify(got.reasons) === JSON.stringify(BLOCKED.reasons), \`cachedDecision under the same version returned \${JSON.stringify(got)}\`);
  const other = await m.cachedDecision(V2.version, TEXT);
  assert.equal(other, null, \`a decision cached under \${V1.version} was served under \${V2.version}: \${JSON.stringify(other)}. The key must carry the policy version\`);
  const keys = ctx.redis.keys('fh:decision:*');
  assert.equal(keys.length, 1, \`one cached decision left the keys \${JSON.stringify(keys)}\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(0 < ttl && ttl <= 86400, \`\${keys[0]} has TTL \${ttl}, expected at most DECISION_TTL_S = 86400\`);
  ctx.clock.advance(86401);
  assert.equal(await m.cachedDecision(V1.version, TEXT), null, 'a cached decision must expire after a day');
}

export async function check_hash_not_text(ctx) {
  const m = await cache(ctx);
  await m.cacheDecision(V1.version, TEXT, BLOCKED);
  const leaked = ctx.redis.keys('*').filter(k => k.includes('families'));
  assert.equal(leaked.length, 0, \`the user's question is a Redis key name: \${JSON.stringify(leaked)}\`);
  const {textHash} = ctx.load('/support/fhguard/cache.ts');
  const expected = \`fh:decision:\${V1.version}:\${textHash(TEXT)}\`;
  assert.equal(ctx.redis.exists(expected), 1, \`expected the decision under \${expected}, Redis holds \${JSON.stringify(ctx.redis.keys('fh:decision:*'))}\`);
  assert.deepStrictEqual(await m.cachedDecision(V1.version, TEXT), BLOCKED, 'the cached decision must read back unchanged');
}

export async function check_strikes_expire(ctx) {
  const m = await cache(ctx);
  const counts = [await m.recordStrike('c-1'), await m.recordStrike('c-1'), await m.recordStrike('c-1')];
  assert.deepStrictEqual(counts, [1, 2, 3], \`three strikes counted \${JSON.stringify(counts)}\`);
  const ttl = ctx.redis.ttl('fh:strikes:c-1');
  assert(0 < ttl && ttl <= 86400, \`fh:strikes:c-1 has TTL \${ttl}: a conversation stays flagged forever. Expire it STRIKE_TTL_S after the first strike\`);
  ctx.clock.advance(80_000);
  assert.equal(await m.recordStrike('c-1'), 4, 'a strike within the day adds to the count');
  ctx.clock.advance(7_000);
  const fresh = await m.recordStrike('c-1');
  assert.equal(fresh, 1, \`87000 s after the first strike the count is \${fresh}: the window starts at the first strike and a later strike must not extend it\`);
  assert.equal(await m.recordStrike('c-2'), 1, 'strikes are counted per conversation');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"fhguard/store"

	"leetbuild/harness"
)

var (
	cacheBg = context.Background()
	pv1     = store.Policy{Version: "fh-2024-05-21", StopPhrases: []string{"no section 8"}}
	pv2     = store.Policy{Version: "fh-2024-06-01", StopPhrases: []string{"no section 8", "adults only"}}
	pv3     = store.Policy{Version: "fh-2024-07-01", StopPhrases: []string{"no section 8", "adults only", "no vouchers"}}
	blocked = store.Decision{Allowed: false, Tier: "classifier", Score: 0.4, Reasons: []string{"classifier:familial_status"}}
)

const question = "Which blocks have fewer families with kids?"

func seedPolicies() {
	store.SavePolicy(cacheBg, pv1)
	store.SavePolicy(cacheBg, pv2)
}

func phrasesOf(ctx *harness.Ctx, version string) []string {
	p, err := getPolicy(cacheBg, version)
	ctx.NoError(err, "getPolicy(%s) failed", version)
	if p == nil {
		return nil
	}
	return p.StopPhrases
}

func CheckVersionedPolicy(ctx *harness.Ctx) {
	seedPolicies()
	ctx.Equal(phrasesOf(ctx, pv1.Version), pv1.StopPhrases, "getPolicy(%s)'s stop phrases", pv1.Version)
	ctx.Equal(phrasesOf(ctx, pv2.Version), pv2.StopPhrases, "getPolicy(%s)'s stop phrases (the policy cached for %s must not answer for another version: key the cache by version)", pv2.Version, pv1.Version)
	ttl := ctx.Redis.TTL("fh:policy:" + pv1.Version)
	ctx.Assert(0 < ttl && ttl <= 3600, "fh:policy:%s has TTL %d, expected at most an hour (keys: %q)", pv1.Version, ttl, ctx.Redis.Keys("fh:policy*"))
	p, _ := getPolicy(cacheBg, "fh-2023-01-01")
	ctx.Assert(p == nil, "a version no store holds must come back nil, got %+v", p)
	ctx.Clock.Advance(3601)
	_, ok := ctx.Redis.Get("fh:policy:" + pv1.Version)
	ctx.Assert(!ok, "the cached policy must expire after an hour")
	ctx.Equal(phrasesOf(ctx, pv1.Version), pv1.StopPhrases, "after expiry the policy is loaded from the store again; its stop phrases")
}

func CheckAtomicPublish(ctx *harness.Ctx) {
	seedPolicies()
	ctx.NoError(publish(cacheBg, pv2), "publish(%s) failed", pv2.Version)
	ctx.Equal(activeVersion(cacheBg), pv2.Version, "the active version after publishing %s", pv2.Version)
	key := "fh:policy:" + pv3.Version
	var active, cached string
	var hasCache, stored bool
	probe := ctx.Redis.After("fh:policy:active", func() any {
		active, _ = ctx.Redis.Get("fh:policy:active")
		cached, hasCache = ctx.Redis.Get(key)
		stored = ctx.Redis.Exists("fhstore:policy:"+pv3.Version) == 1
		return nil
	})
	ctx.NoError(publish(cacheBg, pv3), "publish(%s) failed", pv3.Version)
	ctx.Assert(probe.Fired, "publish never touched fh:policy:active")
	ctx.Equal(active, pv3.Version, "fh:policy:active right after the publish wrote it")
	ctx.Assert(stored, "fh:policy:active pointed at %s before the store held that version: a reader in between finds no policy", pv3.Version)
	ctx.Assert(hasCache && cached != "", "fh:policy:active pointed at %s while %s was missing: move the pointer and the cache entry in one MULTI/EXEC", pv3.Version, key)
	ctx.Equal(phrasesOf(ctx, activeVersion(cacheBg)), pv3.StopPhrases, "a reader after the publish; the stop phrases")
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(0 < ttl && ttl <= 3600, "%s has TTL %d, expected at most an hour", key, ttl)
}

func CheckVersionedDecision(ctx *harness.Ctx) {
	seedPolicies()
	ctx.NoError(cacheDecision(cacheBg, pv1.Version, question, blocked), "cacheDecision failed")
	got, err := cachedDecision(cacheBg, pv1.Version, question)
	ctx.NoError(err, "cachedDecision failed")
	ctx.Assert(got != nil && !got.Allowed && len(got.Reasons) == 1, "cachedDecision under the same version returned %+v", got)
	other, _ := cachedDecision(cacheBg, pv2.Version, question)
	ctx.Assert(other == nil, "a decision cached under %s was served under %s: %+v. The key must carry the policy version", pv1.Version, pv2.Version, other)
	keys := ctx.Redis.Keys("fh:decision:*")
	ctx.Equal(len(keys), 1, "one cached decision; the keys %q", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(0 < ttl && ttl <= 86400, "%s has TTL %d, expected at most a day", keys[0], ttl)
	ctx.Clock.Advance(86401)
	gone, _ := cachedDecision(cacheBg, pv1.Version, question)
	ctx.Assert(gone == nil, "a cached decision must expire after a day")
}

func CheckHashNotText(ctx *harness.Ctx) {
	seedPolicies()
	cacheDecision(cacheBg, pv1.Version, question, blocked)
	var leaked []string
	for _, k := range ctx.Redis.Keys("*") {
		if strings.Contains(k, "families") {
			leaked = append(leaked, k)
		}
	}
	ctx.Assert(len(leaked) == 0, "the user's question is a Redis key name: %q", leaked)
	sum := sha256.Sum256([]byte(question))
	expected := "fh:decision:" + pv1.Version + ":" + hex.EncodeToString(sum[:])
	ctx.Equal(ctx.Redis.Exists(expected), int64(1), "the decision under %s (Redis holds %q)", expected, ctx.Redis.Keys("fh:decision:*"))
	got, _ := cachedDecision(cacheBg, pv1.Version, question)
	ctx.Assert(got != nil && got.Tier == blocked.Tier && got.Score == blocked.Score, "the cached decision must read back unchanged, got %+v", got)
}

func strike(ctx *harness.Ctx, conversationID string) int64 {
	n, err := recordStrike(cacheBg, conversationID)
	ctx.NoError(err, "recordStrike(%s) failed", conversationID)
	return n
}

func CheckStrikesExpire(ctx *harness.Ctx) {
	seedPolicies()
	counts := []int64{strike(ctx, "c-1"), strike(ctx, "c-1"), strike(ctx, "c-1")}
	ctx.Equal(counts, []int64{1, 2, 3}, "three strikes counted")
	ttl := ctx.Redis.TTL("fh:strikes:c-1")
	ctx.Assert(0 < ttl && ttl <= 86400, "fh:strikes:c-1 has TTL %d: a conversation stays flagged forever. Expire it a day after the first strike", ttl)
	ctx.Clock.Advance(80000)
	ctx.Equal(strike(ctx, "c-1"), int64(4), "a strike within the day adds to the count")
	ctx.Clock.Advance(7000)
	ctx.Equal(strike(ctx, "c-1"), int64(1), "87000 s after the first strike the window must have closed (a later strike must not extend it); the count")
	ctx.Equal(strike(ctx, "c-2"), int64(1), "strikes are counted per conversation; c-2's first")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "digest.h"
#include "fhguard/store.h"

namespace {

const store::Policy kV1{"fh-2024-05-21", {"no section 8"}};
const store::Policy kV2{"fh-2024-06-01", {"no section 8", "adults only"}};
const store::Policy kV3{"fh-2024-07-01", {"no section 8", "adults only", "no vouchers"}};
const std::string kQuestion = "Which blocks have fewer families with kids?";
const store::Decision kBlocked{false, "classifier", 0.4, {"classifier:familial_status"}};

void seedPolicies() {
  store::savePolicy(kV1);
  store::savePolicy(kV2);
}

std::optional<std::vector<std::string>> phrasesOf(const std::string& version) {
  const auto p = getPolicy(version);
  if (!p) return std::nullopt;
  return p->stop_phrases;
}

struct Snapshot {
  bool fired = false;
  std::optional<std::string> active;
  std::optional<std::string> cached;
  bool stored = false;
};

}  // namespace

void CheckVersionedPolicy(harness::Ctx& ctx) {
  seedPolicies();
  ctx.Equal(phrasesOf(kV1.version), std::optional<std::vector<std::string>>(kV1.stop_phrases), "getPolicy(%s)'s stop phrases", kV1.version);
  ctx.Equal(phrasesOf(kV2.version), std::optional<std::vector<std::string>>(kV2.stop_phrases), "getPolicy(%s)'s stop phrases (the policy cached for %s must not answer for another version: key the cache by version)", kV2.version, kV1.version);
  const long long ttl = ctx.Redis.TTL("fh:policy:" + kV1.version);
  ctx.Assert(0 < ttl && ttl <= 3600, "fh:policy:%s has TTL %d, expected at most an hour (keys: %q)", kV1.version, ttl, ctx.Redis.Keys("fh:policy*"));
  ctx.Assert(!getPolicy("fh-2023-01-01"), "a version no store holds must come back empty");
  ctx.Clock.Advance(3601);
  ctx.Assert(!ctx.Redis.Get("fh:policy:" + kV1.version), "the cached policy must expire after an hour");
  ctx.Equal(phrasesOf(kV1.version), std::optional<std::vector<std::string>>(kV1.stop_phrases), "after expiry the policy is loaded from the store again; its stop phrases");
}

void CheckAtomicPublish(harness::Ctx& ctx) {
  seedPolicies();
  publish(kV2);
  ctx.Equal(activeVersion(), std::optional<std::string>(kV2.version), "the active version after publishing %s", kV2.version);
  const std::string key = "fh:policy:" + kV3.version;
  auto seen = std::make_shared<Snapshot>();
  ctx.Redis.After("fh:policy:active", [&ctx, seen, key] {
    seen->fired = true;
    seen->active = ctx.Redis.Get("fh:policy:active");
    seen->cached = ctx.Redis.Get(key);
    seen->stored = ctx.Redis.Exists("fhstore:policy:" + kV3.version) == 1;
  });
  publish(kV3);
  ctx.Assert(seen->fired, "publish never touched fh:policy:active");
  ctx.Equal(seen->active, std::optional<std::string>(kV3.version), "fh:policy:active right after the publish wrote it");
  ctx.Assert(seen->stored, "fh:policy:active pointed at %s before the store held that version: a reader in between finds no policy", kV3.version);
  ctx.Assert(seen->cached.has_value(), "fh:policy:active pointed at %s while %s was missing: move the pointer and the cache entry in one MULTI/EXEC", kV3.version, key);
  ctx.Equal(phrasesOf(activeVersion().value_or("")), std::optional<std::vector<std::string>>(kV3.stop_phrases), "a reader after the publish; the stop phrases");
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(0 < ttl && ttl <= 3600, "%s has TTL %d, expected at most an hour", key, ttl);
}

void CheckVersionedDecision(harness::Ctx& ctx) {
  seedPolicies();
  cacheDecision(kV1.version, kQuestion, kBlocked);
  const auto got = cachedDecision(kV1.version, kQuestion);
  ctx.Assert(got && !got->allowed && got->reasons == kBlocked.reasons, "cachedDecision under the same version came back %s", got ? nlohmann::json(*got).dump() : "empty");
  const auto other = cachedDecision(kV2.version, kQuestion);
  ctx.Assert(!other, "a decision cached under %s was served under %s: the key must carry the policy version", kV1.version, kV2.version);
  const auto keys = ctx.Redis.Keys("fh:decision:*");
  ctx.Equal(keys.size(), 1, "one cached decision; the keys %q", keys);
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(0 < ttl && ttl <= 86400, "%s has TTL %d, expected at most a day", keys[0], ttl);
  ctx.Clock.Advance(86401);
  ctx.Assert(!cachedDecision(kV1.version, kQuestion), "a cached decision must expire after a day");
}

void CheckHashNotText(harness::Ctx& ctx) {
  seedPolicies();
  cacheDecision(kV1.version, kQuestion, kBlocked);
  std::vector<std::string> leaked;
  for (const auto& k : ctx.Redis.Keys("*")) {
    if (k.find("families") != std::string::npos) leaked.push_back(k);
  }
  ctx.Assert(leaked.empty(), "the user's question is a Redis key name: %q", leaked);
  const std::string expected = "fh:decision:" + kV1.version + ":" + sha256_hex(kQuestion);
  ctx.Equal(ctx.Redis.Exists(expected), 1, "the decision under %s (Redis holds %q)", expected, ctx.Redis.Keys("fh:decision:*"));
  const auto got = cachedDecision(kV1.version, kQuestion);
  ctx.Assert(got && got->tier == kBlocked.tier && got->score == kBlocked.score, "the cached decision must read back unchanged");
}

void CheckStrikesExpire(harness::Ctx& ctx) {
  seedPolicies();
  std::vector<long long> counts;
  for (int i = 0; i < 3; i++) counts.push_back(recordStrike("c-1"));
  ctx.Equal(counts, std::vector<long long>{1, 2, 3}, "three strikes counted");
  const long long ttl = ctx.Redis.TTL("fh:strikes:c-1");
  ctx.Assert(0 < ttl && ttl <= 86400, "fh:strikes:c-1 has TTL %d: a conversation stays flagged forever. Expire it a day after the first strike", ttl);
  ctx.Clock.Advance(80000);
  ctx.Equal(recordStrike("c-1"), 4, "a strike within the day adds to the count");
  ctx.Clock.Advance(7000);
  ctx.Equal(recordStrike("c-1"), 1, "87000 s after the first strike the window must have closed (a later strike must not extend it); the count");
  ctx.Equal(recordStrike("c-2"), 1, "strikes are counted per conversation; c-2's first");
}
`,
  },
  hints: [
    'Publish a second policy version and ask for it: the reader serves the first one. Scan Redis: the user questions are key names, and a strike counter from last month is still there.',
    'Every version shares the key `fh:policy`, written once with no TTL. `publish` sets the pointer before the store has the version. Decision keys embed the text but no version; the strike key never gets an expiry.',
    'Key by `fh:policy:{version}` with `ex=POLICY_TTL_S`; in `publish` call `store.save_policy` first, then set both keys in `pipeline(transaction=True)`; key decisions by version and `hashlib.sha256` hex with `ex=DECISION_TTL_S`; `expire` on the first strike.',
  ],
  debrief: `Versioned keys make a policy change a pointer move instead of a cache flush: readers that pinned the old version keep a consistent rulebook, and a new conversation starts on the new one. Saving the version before the pointer moves, and moving the pointer with the cache entry in one transaction, is what keeps a reader from resolving a version that has no rules yet. Hashing the text keeps the cache useful without turning protected-class questions into key names. A fixed strike window means an offender ages out; a sliding one would keep a persistent user flagged as long as they keep trying. Production guards also keep the decision cache out of RDB snapshots or encrypt it, and publish through a reviewed change request.`,
};
