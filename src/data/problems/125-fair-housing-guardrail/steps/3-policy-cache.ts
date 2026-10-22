import type {Step} from '@/lib/types';

export const policyCacheStep: Step = {
  id: 'policy-cache',
  title: 'Redis: versioned policy with an atomic publish, decision cache, expiring strikes',
  concept: 'redis',
  file: 'policy_cache',
  focus: ['guard', 'redis', 'policy'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the policy loads, decisions
are cached, strikes count up, and the demo is fast on the second request. It hides four production
flaws, the first of which means a legal team's stop-list update never reaches production. Review
it, fix it, and prove the fix.

Implement the Redis layer the guard reads on every request:

- **Policy per version.** The policy (thresholds and stop phrases) is cached under
  \`fh:policy:{version}\` with \`POLICY_TTL_S = 3600\`; a miss loads \`store.load_policy(version)\`
  and writes it back with the same TTL. The active version lives under \`fh:policy:active\`.
- **Atomic publish.** \`publish(version, policy)\` saves to the store, then in **one transaction**
  (\`MULTI\`/\`EXEC\`: a transactional pipeline, \`multi().exec()\`, \`TxPipelined\`, \`multi()\`,
  \`transaction()\`) writes \`fh:policy:{version}\` with its TTL and sets \`fh:policy:active\`.
  Readers either see the old version or the new one, never a version whose policy is not cached.
- **Decision cache keyed by version.** A decision is cached under
  \`fh:decision:{version}:{text_hash}\` where \`text_hash\` is the hex SHA-256 of the text, with
  \`DECISION_TTL_S = 86400\`. A client retry or a repeated question never re-runs the tiers; a new
  policy version never serves a decision made under the old one. Raw text never appears in a key.
- **Strikes expire.** \`record_strike(conversation_id)\` increments
  \`fh:strikes:{conversation_id}\` and sets \`STRIKE_TTL_S = 86400\` on the first increment, so a
  conversation's count resets after a day instead of living forever.

**Failure mode the checks target.** The draft caches the policy under a version-less key with no
TTL, and \`publish\` only writes the store — every reader keeps the first policy it ever loaded until
Redis is flushed. The decision cache uses the raw text as the key: the most sensitive strings the
service sees are now Redis keys, visible in \`KEYS\`, \`SCAN\` and every dump, and a policy change
does not invalidate them. Strikes without a TTL turn one bad week into a permanent flag.`,
  sequence: {
    participants: ['fhguard', 'Redis', 'policy store'],
    messages: [
      {from: 'fhguard', to: 'Redis', label: 'GET fh:policy:active → fh-2024-05-21', kind: 'sync'},
      {from: 'fhguard', to: 'Redis', label: 'GET fh:policy:fh-2024-05-21', kind: 'sync'},
      {from: 'Redis', to: 'fhguard', label: 'policy JSON / nil', kind: 'reply'},
      {from: 'fhguard', to: 'policy store', label: 'load_policy(version) on miss · SET EX 3600', kind: 'sync'},
      {from: 'fhguard', to: 'Redis', label: 'GET fh:decision:{version}:{sha256} → hit, skip tiers', kind: 'sync'},
      {from: 'fhguard', to: 'Redis', label: 'INCR fh:strikes:{conversation} · EXPIRE 86400 on first', kind: 'sync'},
      {from: 'fhguard', to: 'Redis', label: 'publish: MULTI · SET fh:policy:{v} EX · SET active · EXEC', kind: 'sync'},
    ],
  },
  hints: [
    'Put the version in every key the policy touches: `fh:policy:{version}` with a TTL, `fh:policy:active` pointing at it. `get_policy` reads active, then the versioned key, and only loads from the store on a miss. Versions are immutable, so the TTL is about memory, not freshness.',
    'A publish is two writes that must be seen together: the versioned policy and the active pointer. Wrap them in a transaction — redis-py `pipeline(transaction=True)…execute()`, ioredis `multi()…exec()`, go-redis `TxPipelined`, Jedis `multi()…exec()`, redis-plus-plus `transaction()…exec()` — so no reader resolves a version whose policy is not there yet.',
    'Hash the text (`hashlib.sha256`, `createHash("sha256")`, `sha256.Sum256`, `MessageDigest "SHA-256"`, `sha256Hex`) and key the decision by `(version, hash)` with a one-day TTL. For strikes, `INCR` returns the new count: when it is 1, `EXPIRE` the key for a day.',
  ],
  checks: [
    {
      id: 'versioned-policy',
      title: 'Caches the policy per version with a one-hour TTL',
      detail:
        'The policy is cached under `fh:policy:{version}` with `POLICY_TTL_S = 3600`, loaded from the store on a miss. The draft uses one version-less key without a TTL, so no publish ever reaches a running reader.',
      match: {
        python: {all: [/fh:policy:\{version\}/, /POLICY_TTL_S\s*=\s*3600/, /ex=POLICY_TTL_S/, /store\.load_policy\(/]},
        typescript: {
          all: [/fh:policy:\$\{version\}/, /POLICY_TTL_S\s*=\s*3600/, /'EX',\s*POLICY_TTL_S/, /store\.loadPolicy\(/],
        },
        go: {all: [/fh:policy:%s/, /policyTTL\s*=\s*3600/, /policyTTL\s*\*\s*time\.Second/, /store\.LoadPolicy\(/]},
        scala: {all: [/fh:policy:\$version/, /PolicyTtlS\s*=\s*3600/, /setex\(/, /PolicyStore\.loadPolicy\(/]},
        cpp: {
          all: [
            /"fh:policy:"\s*\+\s*version/,
            /kPolicyTtlS\s*=\s*3600/,
            /std::chrono::seconds\(kPolicyTtlS\)/,
            /store\.loadPolicy\(/,
          ],
        },
      },
    },
    {
      id: 'atomic-publish',
      title: 'Publishes the version and swaps the active pointer in one transaction',
      detail:
        '`publish` writes `fh:policy:{version}` and `fh:policy:active` inside one MULTI/EXEC transaction. The draft only writes the store, so the cache never changes; two separate writes would let a reader resolve a version that is not cached yet.',
      match: {
        python: {all: [/fh:policy:active/, /pipeline\(transaction=True\)/, /\.execute\(\)/]},
        typescript: {all: [/fh:policy:active/, /\.multi\(\)/, /\.exec\(\)/]},
        go: {all: [/fh:policy:active/, /TxPipelined\(/]},
        scala: {all: [/fh:policy:active/, /\.multi\(\)/, /\.exec\(\)/]},
        cpp: {all: [/fh:policy:active/, /\.transaction\(\)/, /\.exec\(\)/]},
      },
    },
    {
      id: 'versioned-decision',
      title: 'Caches decisions by (version, text hash) for a day',
      detail:
        'A decision is stored under `fh:decision:{version}:{text_hash}` with `DECISION_TTL_S = 86400`. The draft’s key has no version, so a policy change keeps serving stale verdicts, and no TTL, so the cache grows forever.',
      match: {
        python: {all: [/fh:decision:\{version\}:\{text_hash\}/, /DECISION_TTL_S\s*=\s*86_?400/, /ex=DECISION_TTL_S/]},
        typescript: {
          all: [/fh:decision:\$\{version\}:\$\{textHash\}/, /DECISION_TTL_S\s*=\s*86_?400/, /'EX',\s*DECISION_TTL_S/],
        },
        go: {all: [/fh:decision:%s:%s/, /decisionTTL\s*=\s*86400/, /decisionTTL\s*\*\s*time\.Second/]},
        scala: {all: [/fh:decision:\$version:\$textHash/, /DecisionTtlS\s*=\s*86400/]},
        cpp: {all: [/"fh:decision:"\s*\+\s*version\s*\+\s*":"\s*\+\s*textHash/, /kDecisionTtlS\s*=\s*86400/]},
      },
    },
    {
      id: 'hash-not-text',
      title: 'Hashes the text; raw text never becomes a key',
      detail:
        'The decision key uses the SHA-256 of the text. The draft puts the raw user text in the key — protected-class queries become Redis keys, visible to `SCAN` and every dump.',
      match: {
        python: {all: [/hashlib\.sha256\(/], none: [/fh:decision:\{text\}/]},
        typescript: {all: [/createHash\(\s*'sha256'\s*\)/], none: [/fh:decision:\$\{text\}/]},
        go: {all: [/sha256\.Sum256\(/], none: [/fh:decision:%s",\s*text\)/]},
        scala: {all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/], none: [/fh:decision:\$text"/]},
        cpp: {all: [/sha256Hex\(/], none: [/"fh:decision:"\s*\+\s*text\b/]},
      },
    },
    {
      id: 'strikes-expire',
      title: 'Strike counters expire after a day',
      detail:
        '`fh:strikes:{conversation_id}` is incremented and given `STRIKE_TTL_S = 86400` on its first increment. The draft increments without an expiry, so a conversation is flagged forever.',
      match: {
        python: {all: [/fh:strikes:\{conversation_id\}/, /STRIKE_TTL_S\s*=\s*86_?400/, /\.expire\(/]},
        typescript: {all: [/fh:strikes:\$\{conversationId\}/, /STRIKE_TTL_S\s*=\s*86_?400/, /\.expire\(/]},
        go: {all: [/fh:strikes:%s/, /strikeTTL\s*=\s*86400/, /\.Expire\(/]},
        scala: {all: [/fh:strikes:\$conversationId/, /StrikeTtlS\s*=\s*86400/, /\.expire\(/]},
        cpp: {all: [/"fh:strikes:"\s*\+\s*conversationId/, /kStrikeTtlS\s*=\s*86400/, /\.expire\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POLICY_KEY = "fh:policy"


class PolicyStore:
    def load_policy(self, version: str) -> dict:
        """The policy document (thresholds, stop_phrases) saved under this version."""
        raise NotImplementedError

    def save_policy(self, version: str, policy: dict) -> None:
        raise NotImplementedError


store = PolicyStore()


def get_policy() -> dict:
    # TODO: the policy key has no version and no TTL, publish never touches the cache, the
    # decision key is the raw text with no version and no TTL, and strikes never expire.
    raw = r.get(POLICY_KEY)
    if raw is not None:
        return json.loads(raw)
    policy = store.load_policy("current")
    r.set(POLICY_KEY, json.dumps(policy))
    return policy


def publish(version: str, policy: dict) -> None:
    store.save_policy(version, policy)


def cached_decision(text: str) -> dict | None:
    raw = r.get(f"fh:decision:{text}")
    return None if raw is None else json.loads(raw)


def cache_decision(text: str, decision: dict) -> None:
    r.set(f"fh:decision:{text}", json.dumps(decision))


def record_strike(conversation_id: str) -> int:
    return int(r.incr(f"fh:strikes:{conversation_id}"))
`,
      solution: `import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POLICY_TTL_S = 3600
DECISION_TTL_S = 86_400
STRIKE_TTL_S = 86_400
ACTIVE_KEY = "fh:policy:active"


class PolicyStore:
    def load_policy(self, version: str) -> dict:
        """The policy document (thresholds, stop_phrases) saved under this version."""
        raise NotImplementedError

    def save_policy(self, version: str, policy: dict) -> None:
        raise NotImplementedError


store = PolicyStore()


def policy_key(version: str) -> str:
    return f"fh:policy:{version}"


def decision_key(version: str, text_hash: str) -> str:
    return f"fh:decision:{version}:{text_hash}"


def strikes_key(conversation_id: str) -> str:
    return f"fh:strikes:{conversation_id}"


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def active_version() -> str | None:
    return r.get(ACTIVE_KEY)


def get_policy(version: str) -> dict:
    raw = r.get(policy_key(version))
    if raw is not None:
        return json.loads(raw)
    policy = store.load_policy(version)
    r.set(policy_key(version), json.dumps(policy), ex=POLICY_TTL_S)
    return policy


def publish(version: str, policy: dict) -> None:
    store.save_policy(version, policy)
    pipe = r.pipeline(transaction=True)
    pipe.set(policy_key(version), json.dumps(policy), ex=POLICY_TTL_S)
    pipe.set(ACTIVE_KEY, version)
    pipe.execute()


def cached_decision(version: str, text: str) -> dict | None:
    raw = r.get(decision_key(version, hash_text(text)))
    return None if raw is None else json.loads(raw)


def cache_decision(version: str, text: str, decision: dict) -> None:
    r.set(decision_key(version, hash_text(text)), json.dumps(decision), ex=DECISION_TTL_S)


def record_strike(conversation_id: str) -> int:
    key = strikes_key(conversation_id)
    strikes = int(r.incr(key))
    if strikes == 1:
        r.expire(key, STRIKE_TTL_S)
    return strikes
`,
    },
    typescript: {
      starter: `/** Policy and decision cache: a model-generated draft with version-less keys and no TTLs. */
import {Redis} from 'ioredis';

import {store} from './policy_store';

const r = new Redis('redis://redis:6379');

const POLICY_KEY = 'fh:policy';

export interface Policy {
  version: string;
  blockThreshold: number;
  reviewLow: number;
  stopPhrases: string[];
}

export interface Decision {
  allowed: boolean;
  tier: string;
  score: number;
  reasons: string[];
}

export async function getPolicy(): Promise<Policy> {
  // TODO: the policy key has no version and no TTL, publish never touches the cache, the
  // decision key is the raw text with no version and no TTL, and strikes never expire.
  const raw = await r.get(POLICY_KEY);
  if (raw !== null) return JSON.parse(raw) as Policy;
  const policy = await store.loadPolicy('current');
  await r.set(POLICY_KEY, JSON.stringify(policy));
  return policy;
}

export async function publish(version: string, policy: Policy): Promise<void> {
  await store.savePolicy(version, policy);
}

export async function cachedDecision(text: string): Promise<Decision | null> {
  const raw = await r.get(\`fh:decision:\${text}\`);
  return raw === null ? null : (JSON.parse(raw) as Decision);
}

export async function cacheDecision(text: string, decision: Decision): Promise<void> {
  await r.set(\`fh:decision:\${text}\`, JSON.stringify(decision));
}

export async function recordStrike(conversationId: string): Promise<number> {
  return r.incr(\`fh:strikes:\${conversationId}\`);
}
`,
      solution: `/** Policy and decision cache: versioned keys, an atomic publish, hashed decisions, expiring strikes. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

import {store} from './policy_store';

const r = new Redis('redis://redis:6379');

const POLICY_TTL_S = 3600;
const DECISION_TTL_S = 86_400;
const STRIKE_TTL_S = 86_400;
const ACTIVE_KEY = 'fh:policy:active';

export interface Policy {
  version: string;
  blockThreshold: number;
  reviewLow: number;
  stopPhrases: string[];
}

export interface Decision {
  allowed: boolean;
  tier: string;
  score: number;
  reasons: string[];
}

function policyKey(version: string): string {
  return \`fh:policy:\${version}\`;
}

function decisionKey(version: string, textHash: string): string {
  return \`fh:decision:\${version}:\${textHash}\`;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function activeVersion(): Promise<string | null> {
  return r.get(ACTIVE_KEY);
}

export async function getPolicy(version: string): Promise<Policy> {
  const raw = await r.get(policyKey(version));
  if (raw !== null) return JSON.parse(raw) as Policy;
  const policy = await store.loadPolicy(version);
  await r.set(policyKey(version), JSON.stringify(policy), 'EX', POLICY_TTL_S);
  return policy;
}

export async function publish(version: string, policy: Policy): Promise<void> {
  await store.savePolicy(version, policy);
  await r.multi().set(policyKey(version), JSON.stringify(policy), 'EX', POLICY_TTL_S).set(ACTIVE_KEY, version).exec();
}

export async function cachedDecision(version: string, text: string): Promise<Decision | null> {
  const raw = await r.get(decisionKey(version, hashText(text)));
  return raw === null ? null : (JSON.parse(raw) as Decision);
}

export async function cacheDecision(version: string, text: string, decision: Decision): Promise<void> {
  await r.set(decisionKey(version, hashText(text)), JSON.stringify(decision), 'EX', DECISION_TTL_S);
}

export async function recordStrike(conversationId: string): Promise<number> {
  const key = \`fh:strikes:\${conversationId}\`;
  const strikes = await r.incr(key);
  if (strikes === 1) await r.expire(key, STRIKE_TTL_S);
  return strikes;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const policyKey = "fh:policy"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Policy struct {
	Version        string   \`json:"version"\`
	BlockThreshold float64  \`json:"block_threshold"\`
	ReviewLow      float64  \`json:"review_low"\`
	StopPhrases    []string \`json:"stop_phrases"\`
}

type Decision struct {
	Allowed bool     \`json:"allowed"\`
	Tier    string   \`json:"tier"\`
	Score   float64  \`json:"score"\`
	Reasons []string \`json:"reasons"\`
}

type PolicyStore struct{}

func (s *PolicyStore) LoadPolicy(ctx context.Context, version string) (Policy, error) {
	return Policy{}, nil
}

func (s *PolicyStore) SavePolicy(ctx context.Context, version string, policy Policy) error {
	return nil
}

var store = &PolicyStore{}

// TODO: the policy key has no version and no TTL, publish never touches the cache, the decision
// key is the raw text with no version and no TTL, and strikes never expire.
func getPolicy(ctx context.Context) (Policy, error) {
	var policy Policy
	raw, err := rdb.Get(ctx, policyKey).Result()
	if err == nil {
		return policy, json.Unmarshal([]byte(raw), &policy)
	}
	policy, err = store.LoadPolicy(ctx, "current")
	if err != nil {
		return policy, err
	}
	encoded, _ := json.Marshal(policy)
	return policy, rdb.Set(ctx, policyKey, encoded, 0).Err()
}

func publish(ctx context.Context, version string, policy Policy) error {
	return store.SavePolicy(ctx, version, policy)
}

func cachedDecision(ctx context.Context, text string) (*Decision, error) {
	raw, err := rdb.Get(ctx, fmt.Sprintf("fh:decision:%s", text)).Result()
	if err != nil {
		return nil, nil
	}
	var decision Decision
	return &decision, json.Unmarshal([]byte(raw), &decision)
}

func cacheDecision(ctx context.Context, text string, decision Decision) error {
	encoded, _ := json.Marshal(decision)
	return rdb.Set(ctx, fmt.Sprintf("fh:decision:%s", text), encoded, 0).Err()
}

func recordStrike(ctx context.Context, conversationID string) (int64, error) {
	return rdb.Incr(ctx, fmt.Sprintf("fh:strikes:%s", conversationID)).Result()
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	policyTTL   = 3600
	decisionTTL = 86400
	strikeTTL   = 86400
	activeKey   = "fh:policy:active"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Policy struct {
	Version        string   \`json:"version"\`
	BlockThreshold float64  \`json:"block_threshold"\`
	ReviewLow      float64  \`json:"review_low"\`
	StopPhrases    []string \`json:"stop_phrases"\`
}

type Decision struct {
	Allowed bool     \`json:"allowed"\`
	Tier    string   \`json:"tier"\`
	Score   float64  \`json:"score"\`
	Reasons []string \`json:"reasons"\`
}

type PolicyStore struct{}

func (s *PolicyStore) LoadPolicy(ctx context.Context, version string) (Policy, error) {
	return Policy{}, nil
}

func (s *PolicyStore) SavePolicy(ctx context.Context, version string, policy Policy) error {
	return nil
}

var store = &PolicyStore{}

func policyKey(version string) string {
	return fmt.Sprintf("fh:policy:%s", version)
}

func decisionKey(version, textHash string) string {
	return fmt.Sprintf("fh:decision:%s:%s", version, textHash)
}

func hashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func activeVersion(ctx context.Context) (string, error) {
	return rdb.Get(ctx, activeKey).Result()
}

func getPolicy(ctx context.Context, version string) (Policy, error) {
	var policy Policy
	raw, err := rdb.Get(ctx, policyKey(version)).Result()
	if err == nil {
		return policy, json.Unmarshal([]byte(raw), &policy)
	}
	if !errors.Is(err, redis.Nil) {
		return policy, err
	}
	policy, err = store.LoadPolicy(ctx, version)
	if err != nil {
		return policy, err
	}
	encoded, _ := json.Marshal(policy)
	return policy, rdb.Set(ctx, policyKey(version), encoded, policyTTL*time.Second).Err()
}

func publish(ctx context.Context, version string, policy Policy) error {
	if err := store.SavePolicy(ctx, version, policy); err != nil {
		return err
	}
	encoded, _ := json.Marshal(policy)
	_, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.Set(ctx, policyKey(version), encoded, policyTTL*time.Second)
		pipe.Set(ctx, activeKey, version, 0)
		return nil
	})
	return err
}

func cachedDecision(ctx context.Context, version, text string) (*Decision, error) {
	raw, err := rdb.Get(ctx, decisionKey(version, hashText(text))).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var decision Decision
	return &decision, json.Unmarshal([]byte(raw), &decision)
}

func cacheDecision(ctx context.Context, version, text string, decision Decision) error {
	encoded, _ := json.Marshal(decision)
	return rdb.Set(ctx, decisionKey(version, hashText(text)), encoded, decisionTTL*time.Second).Err()
}

func recordStrike(ctx context.Context, conversationID string) (int64, error) {
	key := fmt.Sprintf("fh:strikes:%s", conversationID)
	strikes, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	if strikes == 1 {
		if err := rdb.Expire(ctx, key, strikeTTL*time.Second).Err(); err != nil {
			return strikes, err
		}
	}
	return strikes, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Policy(version: String, blockThreshold: Double, reviewLow: Double, stopPhrases: List[String])
final case class Decision(allowed: Boolean, tier: String, score: Double, reasons: List[String])

object PolicyCache {
  implicit val policyFormat: RootJsonFormat[Policy] = jsonFormat4(Policy)
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat4(Decision)

  val PolicyKey = "fh:policy"
  val jedis = new Jedis("redis", 6379)

  // TODO: the policy key has no version and no TTL, publish never touches the cache, the decision
  // key is the raw text with no version and no TTL, and strikes never expire.
  def getPolicy(): Policy = {
    Option(jedis.get(PolicyKey)) match {
      case Some(raw) => raw.parseJson.convertTo[Policy]
      case None =>
        val policy = PolicyStore.loadPolicy("current")
        jedis.set(PolicyKey, policy.toJson.compactPrint)
        policy
    }
  }

  def publish(version: String, policy: Policy): Unit =
    PolicyStore.savePolicy(version, policy)

  def cachedDecision(text: String): Option[Decision] =
    Option(jedis.get(s"fh:decision:$text")).map(_.parseJson.convertTo[Decision])

  def cacheDecision(text: String, decision: Decision): Unit =
    jedis.set(s"fh:decision:$text", decision.toJson.compactPrint)

  def recordStrike(conversationId: String): Long =
    jedis.incr(s"fh:strikes:$conversationId")
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import redis.clients.jedis.Jedis
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class Policy(version: String, blockThreshold: Double, reviewLow: Double, stopPhrases: List[String])
final case class Decision(allowed: Boolean, tier: String, score: Double, reasons: List[String])

object PolicyCache {
  implicit val policyFormat: RootJsonFormat[Policy] = jsonFormat4(Policy)
  implicit val decisionFormat: RootJsonFormat[Decision] = jsonFormat4(Decision)

  val PolicyTtlS = 3600L
  val DecisionTtlS = 86400L
  val StrikeTtlS = 86400L
  val ActiveKey = "fh:policy:active"
  val jedis = new Jedis("redis", 6379)

  def policyKey(version: String): String = s"fh:policy:$version"

  def decisionKey(version: String, textHash: String): String = s"fh:decision:$version:$textHash"

  def hashText(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  def activeVersion(): Option[String] = Option(jedis.get(ActiveKey))

  def getPolicy(version: String): Policy = {
    Option(jedis.get(policyKey(version))) match {
      case Some(raw) => raw.parseJson.convertTo[Policy]
      case None =>
        val policy = PolicyStore.loadPolicy(version)
        jedis.setex(policyKey(version), PolicyTtlS, policy.toJson.compactPrint)
        policy
    }
  }

  def publish(version: String, policy: Policy): Unit = {
    PolicyStore.savePolicy(version, policy)
    val tx = jedis.multi()
    tx.setex(policyKey(version), PolicyTtlS, policy.toJson.compactPrint)
    tx.set(ActiveKey, version)
    tx.exec()
  }

  def cachedDecision(version: String, text: String): Option[Decision] =
    Option(jedis.get(decisionKey(version, hashText(text)))).map(_.parseJson.convertTo[Decision])

  def cacheDecision(version: String, text: String, decision: Decision): Unit =
    jedis.setex(decisionKey(version, hashText(text)), DecisionTtlS, decision.toJson.compactPrint)

  def recordStrike(conversationId: String): Long = {
    val key = s"fh:strikes:$conversationId"
    val strikes = jedis.incr(key)
    if (strikes == 1L) jedis.expire(key, StrikeTtlS)
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
#include <vector>

using json = nlohmann::json;

const std::string kPolicyKey = "fh:policy";

struct PolicyStore {
  json loadPolicy(const std::string& version);
  void savePolicy(const std::string& version, const json& policy);
};

PolicyStore store;
sw::redis::Redis redis("tcp://redis:6379");

// TODO: the policy key has no version and no TTL, publish never touches the cache, the decision
// key is the raw text with no version and no TTL, and strikes never expire.
json getPolicy() {
  const auto raw = redis.get(kPolicyKey);
  if (raw) return json::parse(*raw);
  const json policy = store.loadPolicy("current");
  redis.set(kPolicyKey, policy.dump());
  return policy;
}

void publish(const std::string& version, const json& policy) {
  store.savePolicy(version, policy);
}

std::optional<json> cachedDecision(const std::string& text) {
  const auto raw = redis.get("fh:decision:" + text);
  if (!raw) return std::nullopt;
  return json::parse(*raw);
}

void cacheDecision(const std::string& text, const json& decision) {
  redis.set("fh:decision:" + text, decision.dump());
}

long long recordStrike(const std::string& conversationId) {
  return redis.incr("fh:strikes:" + conversationId);
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kPolicyTtlS = 3600;
constexpr long long kDecisionTtlS = 86400;
constexpr long long kStrikeTtlS = 86400;
const std::string kActiveKey = "fh:policy:active";

struct PolicyStore {
  json loadPolicy(const std::string& version);
  void savePolicy(const std::string& version, const json& policy);
};

PolicyStore store;
sw::redis::Redis redis("tcp://redis:6379");
std::string sha256Hex(const std::string& input);

std::string policyKey(const std::string& version) { return "fh:policy:" + version; }

std::string decisionKey(const std::string& version, const std::string& textHash) {
  return "fh:decision:" + version + ":" + textHash;
}

std::optional<std::string> activeVersion() { return redis.get(kActiveKey); }

json getPolicy(const std::string& version) {
  const auto raw = redis.get(policyKey(version));
  if (raw) return json::parse(*raw);
  const json policy = store.loadPolicy(version);
  redis.set(policyKey(version), policy.dump(), std::chrono::seconds(kPolicyTtlS));
  return policy;
}

void publish(const std::string& version, const json& policy) {
  store.savePolicy(version, policy);
  auto tx = redis.transaction();
  tx.set(policyKey(version), policy.dump(), std::chrono::seconds(kPolicyTtlS));
  tx.set(kActiveKey, version);
  tx.exec();
}

std::optional<json> cachedDecision(const std::string& version, const std::string& text) {
  const auto raw = redis.get(decisionKey(version, sha256Hex(text)));
  if (!raw) return std::nullopt;
  return json::parse(*raw);
}

void cacheDecision(const std::string& version, const std::string& text, const json& decision) {
  redis.set(decisionKey(version, sha256Hex(text)), decision.dump(), std::chrono::seconds(kDecisionTtlS));
}

long long recordStrike(const std::string& conversationId) {
  const std::string key = "fh:strikes:" + conversationId;
  const long long strikes = redis.incr(key);
  if (strikes == 1) redis.expire(key, std::chrono::seconds(kStrikeTtlS));
  return strikes;
}
`,
    },
  },
  debrief: `The interviewer is testing whether you see a cache as part of the control plane. A guard's policy is edited by lawyers and must reach production when they publish it; the draft's version-less, TTL-less key makes every publish a no-op, which is the worst kind of bug because the dashboard says the new stop list is live. Four defects are being checked: the version in the policy key with a TTL and a store fallback; the publish as one transaction so the active pointer never leads to a missing policy; the decision cache keyed by version and hash so a retry is free but a policy change is not silently ignored; and the strike expiry, because "flagged forever" is a product and fairness problem of its own. The raw-text key is the one candidates miss: the most sensitive strings this service handles must not be enumerable with \`SCAN\`. Real systems add a policy checksum in the audit event, a pre-warm of the new version before the swap, and a per-version decision-cache purge on emergency rollback.`,
};
