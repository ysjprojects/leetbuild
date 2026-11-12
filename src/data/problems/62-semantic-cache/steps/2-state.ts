import type {Step} from '@/lib/types';

const PUT_ENTRY_LUA = [
  "redis.call('HSET', KEYS[1], 'embedding', ARGV[1], 'answer', ARGV[2], 'created_at', ARGV[3], 'expires_at', ARGV[4], 'policy_version', ARGV[5])",
  "redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))",
  "redis.call('SADD', KEYS[2], KEYS[1])",
  'return 1',
];

export const stateStep: Step = {
  id: 'state',
  title: 'Redis entries in one tenant-scoped index',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['cache', 'redis'],
  task: `## Task

**Starting point.** The starter is the cache store. \`put_entry\` writes the entry hash
\`entry:{tenant}:{model_version}:{entry_id}\` and lists its key in an index set, \`search_entries\`
scans an index by cosine similarity and returns the nearest entry at or above the threshold, and
\`get_entry\` reads one hash. It serves the demo and hides five flaws.

**Failure mode the checks target.** A write that dies between its commands leaves an embedding with
no answer behind it, and the next lookup hits it. One index shared by every tenant means the
nearest neighbour of a question can be another tenant's answer. An entry with no expiry is served
long after its model version is gone.

- \`put_entry(tenant, model_version, entry_id, embedding, answer, policy_version)\` writes
  \`embedding\` (a JSON array), \`answer\`, \`created_at\`, \`expires_at\` and \`policy_version\`, sets
  the key's \`EXPIRE\` to \`ENTRY_TTL_SECONDS\` (86400) and adds the key to the tenant's index, all in
  one Lua script.
- \`index_name(tenant, model_version)\` is \`semantic:{tenant}:{model_version}\`; the write and the
  search both go through it.
- \`search_entries(tenant, model_version, embedding, threshold)\` reads only that set, skips a hash
  without \`answer\`, and returns \`{entry_id, answer, similarity, created_at, expires_at,
  policy_version}\` for the nearest entry, expired or not: serving it is the endpoint's decision.
- \`get_entry(tenant, model_version, entry_id)\` raises \`IncompleteEntry\` when the hash exists
  without \`answer\`.`,
  sequence: {
    participants: ['Semantic Cache', 'Redis'],
    messages: [
      {
        from: 'Semantic Cache',
        to: 'Redis',
        label: 'EVAL put_entry · KEYS entry:{t}:{v}:{id}, semantic:{t}:{v} · HSET + EXPIRE + SADD',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Semantic Cache', label: '1 (hash, TTL and index membership together)', kind: 'reply'},
      {from: 'Semantic Cache', to: 'Redis', label: 'SMEMBERS semantic:{t}:{v}', kind: 'sync'},
      {from: 'Redis', to: 'Semantic Cache', label: "the tenant's entry keys", kind: 'reply'},
      {from: 'Semantic Cache', to: 'Redis', label: 'HGETALL each key · cosine · skip without answer', kind: 'sync'},
      {from: 'Redis', to: 'Semantic Cache', label: 'nearest entry at or above the threshold / none', kind: 'reply'},
    ],
  },
  hints: [
    'A lookup hits an entry whose answer is empty, a tenant gets an answer another tenant wrote, and an entry written in June is still served in December.',
    'Two HSETs are two round trips: a crash between them leaves an embedding that the scan finds with no answer behind it. `semantic:all` holds every tenant\u2019s keys, so one scan ranks them all together, and no EXPIRE means the hash never leaves.',
    'Put HSET, EXPIRE and SADD in one Lua script run with eval; build the set name from tenant and model version in `index_name` and use it in both the write and the scan; skip hashes without `answer` and raise `IncompleteEntry` from `get_entry`.',
  ],
  checks: [
    {
      id: 'atomic-write',
      title: 'Writes the embedding and its answer in one atomic step',
      detail:
        'The hash, its EXPIRE and the index membership are written by one Lua script (`EVAL`/`EVALSHA`): a client reading the entry right after the first command sees either nothing or a complete entry. Two client-side HSETs leave an embedding without an answer between them.',
      match: {
        python: {all: [/register_script\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]HSET['"]/]},
        typescript: {all: [/defineCommand\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]HSET['"]/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(|\.EvalSha\(/, /redis\.call\(\s*['"]HSET['"]/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HSET['"]/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HSET['"]/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Lists each entry in its tenant and model version index',
      detail:
        '`index_name(tenant, model_version)` is `semantic:{tenant}:{model_version}` and the write adds the key there, so two tenants never share a vector space. The starter lists everyone under `semantic:all`.',
      match: {
        python: {all: [/semantic:\{tenant\}:\{model_version\}/], none: [/semantic:all/]},
        typescript: {all: [/semantic:\$\{tenant\}:\$\{modelVersion\}/], none: [/semantic:all/]},
        go: {all: [/"semantic:%s:%s"|"semantic:"\s*\+\s*tenant/], none: [/semantic:all/]},
        scala: {all: [/s"semantic:\$\{?tenant\}?:\$\{?modelVersion\}?"/], none: [/semantic:all/]},
        cpp: {all: [/"semantic:"\s*\+\s*tenant/], none: [/semantic:all/]},
      },
    },
    {
      id: 'answer-required',
      title: 'An embedding without an answer is never a hit',
      detail:
        'A hash with an `embedding` but no `answer` is an interrupted write: `search_entries` skips it and `get_entry` raises `IncompleteEntry`. The starter returns whatever the hash holds.',
      match: {
        python: {all: [/raise IncompleteEntry\(/]},
        typescript: {all: [/throw new IncompleteEntry\(/]},
        go: {all: [/return [^\n]*ErrIncompleteEntry/]},
        scala: {all: [/throw new IncompleteEntry\(/]},
        cpp: {all: [/throw IncompleteEntry\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'Entries expire',
      detail:
        'Every written entry gets `EXPIRE` of `ENTRY_TTL_SECONDS` (86400 s) in the same script, so the hash leaves Redis when the entry is past serving; the scan skips a key whose hash is gone.',
      match: {
        python: {all: [/['"]EXPIRE['"]|\.expire\(/]},
        typescript: {all: [/['"]EXPIRE['"]|\.expire\(/]},
        go: {all: [/['"]EXPIRE['"]|\.Expire\(/]},
        scala: {all: [/['"]EXPIRE['"]|\.expire\(/]},
        cpp: {all: [/['"]EXPIRE['"]|\.expire\(/]},
      },
    },
    {
      id: 'disjoint-search',
      title: "A search reads only the caller's tenant and model version index",
      detail:
        "The scan takes its keys from `index_name(tenant, model_version)`, so a lookup can only return entries from the caller's own set. The starter scans the literal `semantic:all`.",
      match: {
        python: {all: [/smembers\(\s*index_name\(/], none: [/semantic:all/]},
        typescript: {all: [/smembers\(\s*indexName\(/], none: [/semantic:all/]},
        go: {all: [/SMembers\(\s*ctx\s*,\s*indexName\(/], none: [/semantic:all/]},
        scala: {all: [/smembers\(\s*indexName\(/], none: [/semantic:all/]},
        cpp: {all: [/smembers\(\s*index_name\(/], none: [/semantic:all/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""The cache store: entries in Redis, found by cosine similarity."""
import json
import time

import redis

from semcache.vectors import cosine

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ENTRY_TTL_SECONDS = 86400


class IncompleteEntry(Exception):
    """A hash that exists but has no answer: an interrupted write, not an entry."""


def entry_key(tenant: str, model_version: str, entry_id: str) -> str:
    return f"entry:{tenant}:{model_version}:{entry_id}"


def index_name(tenant: str, model_version: str) -> str:
    return "semantic:all"


def put_entry(tenant: str, model_version: str, entry_id: str, embedding: list[float], answer: str, policy_version: str) -> None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    now = time.time()
    key = entry_key(tenant, model_version, entry_id)
    r.hset(key, mapping={"embedding": json.dumps(embedding), "created_at": now, "expires_at": now + ENTRY_TTL_SECONDS, "policy_version": policy_version})
    r.hset(key, "answer", answer)
    r.sadd(index_name(tenant, model_version), key)


def _entry(key: str, raw: dict, similarity: float) -> dict:
    return {
        "entry_id": key.rsplit(":", 1)[1],
        "answer": raw.get("answer"),
        "similarity": similarity,
        "created_at": float(raw["created_at"]),
        "expires_at": float(raw["expires_at"]),
        "policy_version": raw.get("policy_version", ""),
    }


def search_entries(tenant: str, model_version: str, embedding: list[float], threshold: float) -> dict | None:
    """The nearest entry at or above threshold, expired or not; None when nothing qualifies."""
    best = None
    for key in r.smembers("semantic:all"):
        raw = r.hgetall(key)
        if not raw:
            continue
        similarity = cosine(embedding, json.loads(raw["embedding"]))
        if similarity >= threshold and (best is None or similarity > best["similarity"]):
            best = _entry(key, raw, similarity)
    return best


def get_entry(tenant: str, model_version: str, entry_id: str) -> dict | None:
    key = entry_key(tenant, model_version, entry_id)
    raw = r.hgetall(key)
    if not raw:
        return None
    return _entry(key, raw, 0.0)
`,
      solution: `"""The cache store: entries in Redis, one index per tenant and model version."""
import json
import time

import redis

from semcache.vectors import cosine

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ENTRY_TTL_SECONDS = 86400


class IncompleteEntry(Exception):
    """A hash that exists but has no answer: an interrupted write, not an entry."""


PUT_ENTRY_SCRIPT = """
${PUT_ENTRY_LUA.join('\n')}
"""
put_entry_script = r.register_script(PUT_ENTRY_SCRIPT)  # one EVALSHA per write: hash, TTL and index membership together


def entry_key(tenant: str, model_version: str, entry_id: str) -> str:
    return f"entry:{tenant}:{model_version}:{entry_id}"


def index_name(tenant: str, model_version: str) -> str:
    return f"semantic:{tenant}:{model_version}"


def put_entry(tenant: str, model_version: str, entry_id: str, embedding: list[float], answer: str, policy_version: str) -> None:
    now = time.time()
    put_entry_script(
        keys=[entry_key(tenant, model_version, entry_id), index_name(tenant, model_version)],
        args=[json.dumps(embedding), answer, now, now + ENTRY_TTL_SECONDS, policy_version, ENTRY_TTL_SECONDS],
    )


def _entry(key: str, raw: dict, similarity: float) -> dict:
    return {
        "entry_id": key.rsplit(":", 1)[1],
        "answer": raw["answer"],
        "similarity": similarity,
        "created_at": float(raw["created_at"]),
        "expires_at": float(raw["expires_at"]),
        "policy_version": raw.get("policy_version", ""),
    }


def search_entries(tenant: str, model_version: str, embedding: list[float], threshold: float) -> dict | None:
    """The nearest entry at or above threshold, expired or not; None when nothing qualifies."""
    best = None
    for key in r.smembers(index_name(tenant, model_version)):
        raw = r.hgetall(key)
        if not raw or "answer" not in raw:
            continue  # expired, or a write that never finished
        similarity = cosine(embedding, json.loads(raw["embedding"]))
        if similarity >= threshold and (best is None or similarity > best["similarity"]):
            best = _entry(key, raw, similarity)
    return best


def get_entry(tenant: str, model_version: str, entry_id: str) -> dict | None:
    key = entry_key(tenant, model_version, entry_id)
    raw = r.hgetall(key)
    if not raw:
        return None
    if "answer" not in raw:
        raise IncompleteEntry(key)
    return _entry(key, raw, 0.0)
`,
    },
    typescript: {
      starter: `/** The cache store: entries in Redis, found by cosine similarity. */
import Redis from 'ioredis';

import {cosine} from 'semcache/vectors';

const redis = new Redis({host: 'redis', port: 6379});

export const ENTRY_TTL_SECONDS = 86400;

/** A hash that exists but has no answer: an interrupted write, not an entry. */
export class IncompleteEntry extends Error {}

export interface CacheEntry {
  entry_id: string;
  answer: string;
  similarity: number;
  created_at: number;
  expires_at: number;
  policy_version: string;
}

export function entryKey(tenant: string, modelVersion: string, entryId: string): string {
  return \`entry:\${tenant}:\${modelVersion}:\${entryId}\`;
}

export function indexName(tenant: string, modelVersion: string): string {
  return 'semantic:all';
}

export async function putEntry(
  tenant: string,
  modelVersion: string,
  entryId: string,
  embedding: number[],
  answer: string,
  policyVersion: string,
): Promise<void> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const now = Date.now() / 1000;
  const key = entryKey(tenant, modelVersion, entryId);
  await redis.hset(key, 'embedding', JSON.stringify(embedding), 'created_at', now, 'expires_at', now + ENTRY_TTL_SECONDS, 'policy_version', policyVersion);
  await redis.hset(key, 'answer', answer);
  await redis.sadd(indexName(tenant, modelVersion), key);
}

function entryOf(key: string, raw: Record<string, string>, similarity: number): CacheEntry {
  return {
    entry_id: key.slice(key.lastIndexOf(':') + 1),
    answer: raw.answer,
    similarity,
    created_at: Number(raw.created_at),
    expires_at: Number(raw.expires_at),
    policy_version: raw.policy_version ?? '',
  };
}

/** The nearest entry at or above threshold, expired or not; null when nothing qualifies. */
export async function searchEntries(
  tenant: string,
  modelVersion: string,
  embedding: number[],
  threshold: number,
): Promise<CacheEntry | null> {
  let best: CacheEntry | null = null;
  for (const key of await redis.smembers('semantic:all')) {
    const raw = await redis.hgetall(key);
    if (Object.keys(raw).length === 0) continue;
    const similarity = cosine(embedding, JSON.parse(raw.embedding) as number[]);
    if (similarity >= threshold && (best === null || similarity > best.similarity)) best = entryOf(key, raw, similarity);
  }
  return best;
}

export async function getEntry(tenant: string, modelVersion: string, entryId: string): Promise<CacheEntry | null> {
  const key = entryKey(tenant, modelVersion, entryId);
  const raw = await redis.hgetall(key);
  if (Object.keys(raw).length === 0) return null;
  return entryOf(key, raw, 0);
}
`,
      solution: `/** The cache store: entries in Redis, one index per tenant and model version. */
import Redis from 'ioredis';

import {cosine} from 'semcache/vectors';

export const ENTRY_TTL_SECONDS = 86400;

/** A hash that exists but has no answer: an interrupted write, not an entry. */
export class IncompleteEntry extends Error {}

export interface CacheEntry {
  entry_id: string;
  answer: string;
  similarity: number;
  created_at: number;
  expires_at: number;
  policy_version: string;
}

const PUT_ENTRY_SCRIPT = \`
${PUT_ENTRY_LUA.join('\n')}
\`;

interface StoreRedis extends Redis {
  putEntry(
    entryKey: string,
    indexKey: string,
    embedding: string,
    answer: string,
    createdAt: number,
    expiresAt: number,
    policyVersion: string,
    ttl: number,
  ): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as StoreRedis;
// One EVALSHA per write: hash, TTL and index membership together.
redis.defineCommand('putEntry', {numberOfKeys: 2, lua: PUT_ENTRY_SCRIPT});

export function entryKey(tenant: string, modelVersion: string, entryId: string): string {
  return \`entry:\${tenant}:\${modelVersion}:\${entryId}\`;
}

export function indexName(tenant: string, modelVersion: string): string {
  return \`semantic:\${tenant}:\${modelVersion}\`;
}

export async function putEntry(
  tenant: string,
  modelVersion: string,
  entryId: string,
  embedding: number[],
  answer: string,
  policyVersion: string,
): Promise<void> {
  const now = Date.now() / 1000;
  await redis.putEntry(
    entryKey(tenant, modelVersion, entryId),
    indexName(tenant, modelVersion),
    JSON.stringify(embedding),
    answer,
    now,
    now + ENTRY_TTL_SECONDS,
    policyVersion,
    ENTRY_TTL_SECONDS,
  );
}

function entryOf(key: string, raw: Record<string, string>, similarity: number): CacheEntry {
  return {
    entry_id: key.slice(key.lastIndexOf(':') + 1),
    answer: raw.answer,
    similarity,
    created_at: Number(raw.created_at),
    expires_at: Number(raw.expires_at),
    policy_version: raw.policy_version ?? '',
  };
}

/** The nearest entry at or above threshold, expired or not; null when nothing qualifies. */
export async function searchEntries(
  tenant: string,
  modelVersion: string,
  embedding: number[],
  threshold: number,
): Promise<CacheEntry | null> {
  let best: CacheEntry | null = null;
  for (const key of await redis.smembers(indexName(tenant, modelVersion))) {
    const raw = await redis.hgetall(key);
    if (Object.keys(raw).length === 0 || !('answer' in raw)) continue; // expired, or a write that never finished
    const similarity = cosine(embedding, JSON.parse(raw.embedding) as number[]);
    if (similarity >= threshold && (best === null || similarity > best.similarity)) best = entryOf(key, raw, similarity);
  }
  return best;
}

export async function getEntry(tenant: string, modelVersion: string, entryId: string): Promise<CacheEntry | null> {
  const key = entryKey(tenant, modelVersion, entryId);
  const raw = await redis.hgetall(key);
  if (Object.keys(raw).length === 0) return null;
  if (!('answer' in raw)) throw new IncompleteEntry(key);
  return entryOf(key, raw, 0);
}
`,
    },
    go: {
      starter: `// The cache store: entries in Redis, found by cosine similarity.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"semcache/vectors"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const entryTTLSeconds = 86400

// ErrIncompleteEntry: a hash that exists but has no answer, an interrupted write rather than an entry.
var ErrIncompleteEntry = errors.New("incomplete entry: no answer")

// Entry is one stored answer as a lookup sees it; Similarity is the cosine to the query (0 from getEntry).
type Entry struct {
	EntryID       string
	Answer        string
	Similarity    float64
	CreatedAt     float64
	ExpiresAt     float64
	PolicyVersion string
}

func entryKey(tenant, modelVersion, entryID string) string {
	return fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID)
}

func indexName(tenant, modelVersion string) string {
	return "semantic:all"
}

func putEntry(ctx context.Context, tenant, modelVersion, entryID string, embedding []float64, answer, policyVersion string) error {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	vec, _ := json.Marshal(embedding)
	now := float64(time.Now().UnixMilli()) / 1000
	key := entryKey(tenant, modelVersion, entryID)
	if err := rdb.HSet(ctx, key, "embedding", string(vec), "created_at", now, "expires_at", now+entryTTLSeconds, "policy_version", policyVersion).Err(); err != nil {
		return err
	}
	if err := rdb.HSet(ctx, key, "answer", answer).Err(); err != nil {
		return err
	}
	return rdb.SAdd(ctx, indexName(tenant, modelVersion), key).Err()
}

func entryOf(key string, raw map[string]string, similarity float64) Entry {
	createdAt, _ := strconv.ParseFloat(raw["created_at"], 64)
	expiresAt, _ := strconv.ParseFloat(raw["expires_at"], 64)
	return Entry{
		EntryID:       key[strings.LastIndex(key, ":")+1:],
		Answer:        raw["answer"],
		Similarity:    similarity,
		CreatedAt:     createdAt,
		ExpiresAt:     expiresAt,
		PolicyVersion: raw["policy_version"],
	}
}

// searchEntries is the nearest entry at or above threshold, expired or not; nil when nothing qualifies.
func searchEntries(ctx context.Context, tenant, modelVersion string, embedding []float64, threshold float64) (*Entry, error) {
	keys, err := rdb.SMembers(ctx, "semantic:all").Result()
	if err != nil {
		return nil, err
	}
	var best *Entry
	for _, key := range keys {
		raw, err := rdb.HGetAll(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		if len(raw) == 0 {
			continue
		}
		var stored []float64
		if err := json.Unmarshal([]byte(raw["embedding"]), &stored); err != nil {
			return nil, err
		}
		similarity := vectors.Cosine(embedding, stored)
		if similarity >= threshold && (best == nil || similarity > best.Similarity) {
			e := entryOf(key, raw, similarity)
			best = &e
		}
	}
	return best, nil
}

func getEntry(ctx context.Context, tenant, modelVersion, entryID string) (*Entry, error) {
	key := entryKey(tenant, modelVersion, entryID)
	raw, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	e := entryOf(key, raw, 0)
	return &e, nil
}
`,
      solution: `// The cache store: entries in Redis, one index per tenant and model version.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"semcache/vectors"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const entryTTLSeconds = 86400

// ErrIncompleteEntry: a hash that exists but has no answer, an interrupted write rather than an entry.
var ErrIncompleteEntry = errors.New("incomplete entry: no answer")

// Entry is one stored answer as a lookup sees it; Similarity is the cosine to the query (0 from getEntry).
type Entry struct {
	EntryID       string
	Answer        string
	Similarity    float64
	CreatedAt     float64
	ExpiresAt     float64
	PolicyVersion string
}

// One EVALSHA per write: hash, TTL and index membership together.
var putEntryScript = redis.NewScript(\`
${PUT_ENTRY_LUA.join('\n')}
\`)

func entryKey(tenant, modelVersion, entryID string) string {
	return fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID)
}

func indexName(tenant, modelVersion string) string {
	return fmt.Sprintf("semantic:%s:%s", tenant, modelVersion)
}

func putEntry(ctx context.Context, tenant, modelVersion, entryID string, embedding []float64, answer, policyVersion string) error {
	vec, _ := json.Marshal(embedding)
	now := float64(time.Now().UnixMilli()) / 1000
	keys := []string{entryKey(tenant, modelVersion, entryID), indexName(tenant, modelVersion)}
	return putEntryScript.Run(ctx, rdb, keys, string(vec), answer, now, now+entryTTLSeconds, policyVersion, entryTTLSeconds).Err()
}

func entryOf(key string, raw map[string]string, similarity float64) Entry {
	createdAt, _ := strconv.ParseFloat(raw["created_at"], 64)
	expiresAt, _ := strconv.ParseFloat(raw["expires_at"], 64)
	return Entry{
		EntryID:       key[strings.LastIndex(key, ":")+1:],
		Answer:        raw["answer"],
		Similarity:    similarity,
		CreatedAt:     createdAt,
		ExpiresAt:     expiresAt,
		PolicyVersion: raw["policy_version"],
	}
}

// searchEntries is the nearest entry at or above threshold, expired or not; nil when nothing qualifies.
func searchEntries(ctx context.Context, tenant, modelVersion string, embedding []float64, threshold float64) (*Entry, error) {
	keys, err := rdb.SMembers(ctx, indexName(tenant, modelVersion)).Result()
	if err != nil {
		return nil, err
	}
	var best *Entry
	for _, key := range keys {
		raw, err := rdb.HGetAll(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		if _, ok := raw["answer"]; len(raw) == 0 || !ok {
			continue // expired, or a write that never finished
		}
		var stored []float64
		if err := json.Unmarshal([]byte(raw["embedding"]), &stored); err != nil {
			return nil, err
		}
		similarity := vectors.Cosine(embedding, stored)
		if similarity >= threshold && (best == nil || similarity > best.Similarity) {
			e := entryOf(key, raw, similarity)
			best = &e
		}
	}
	return best, nil
}

func getEntry(ctx context.Context, tenant, modelVersion, entryID string) (*Entry, error) {
	key := entryKey(tenant, modelVersion, entryID)
	raw, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	if _, ok := raw["answer"]; !ok {
		return nil, ErrIncompleteEntry
	}
	e := entryOf(key, raw, 0)
	return &e, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import semcache.Vectors

import scala.jdk.CollectionConverters._

/** The cache store: entries in Redis, found by cosine similarity. */
object State {
  val jedis = new JedisPooled("redis", 6379)
  val EntryTtlSeconds = 86400L

  /** A hash that exists but has no answer: an interrupted write, not an entry. */
  class IncompleteEntry(key: String) extends RuntimeException(s"incomplete entry $key: no answer")

  /** One stored answer as a lookup sees it; similarity is the cosine to the query (0 from getEntry). */
  case class Entry(entryId: String, answer: String, similarity: Double, createdAt: Double, expiresAt: Double, policyVersion: String)

  def entryKey(tenant: String, modelVersion: String, entryId: String): String = s"entry:$tenant:$modelVersion:$entryId"

  def indexName(tenant: String, modelVersion: String): String = "semantic:all"

  def putEntry(tenant: String, modelVersion: String, entryId: String, embedding: Seq[Double], answer: String, policyVersion: String): Unit = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val now = System.currentTimeMillis() / 1000.0
    val key = entryKey(tenant, modelVersion, entryId)
    jedis.hset(key, Map("embedding" -> embedding.mkString("[", ",", "]"), "created_at" -> now.toString, "expires_at" -> (now + EntryTtlSeconds).toString, "policy_version" -> policyVersion).asJava)
    jedis.hset(key, "answer", answer)
    jedis.sadd(indexName(tenant, modelVersion), key)
  }

  private def entryOf(key: String, raw: Map[String, String], similarity: Double): Entry =
    Entry(key.substring(key.lastIndexOf(':') + 1), raw.getOrElse("answer", ""), similarity, raw("created_at").toDouble, raw("expires_at").toDouble, raw.getOrElse("policy_version", ""))

  /** The nearest entry at or above threshold, expired or not; None when nothing qualifies. */
  def searchEntries(tenant: String, modelVersion: String, embedding: Seq[Double], threshold: Double): Option[Entry] = {
    var best: Option[Entry] = None
    for (key <- jedis.smembers("semantic:all").asScala) {
      val raw = jedis.hgetAll(key).asScala.toMap
      if (raw.nonEmpty) {
        val stored = ujson.read(raw("embedding")).arr.map(_.num).toSeq
        val similarity = Vectors.cosine(embedding, stored)
        if (similarity >= threshold && best.forall(similarity > _.similarity)) best = Some(entryOf(key, raw, similarity))
      }
    }
    best
  }

  def getEntry(tenant: String, modelVersion: String, entryId: String): Option[Entry] = {
    val key = entryKey(tenant, modelVersion, entryId)
    val raw = jedis.hgetAll(key).asScala.toMap
    if (raw.isEmpty) None else Some(entryOf(key, raw, 0.0))
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import semcache.Vectors

import scala.jdk.CollectionConverters._

/** The cache store: entries in Redis, one index per tenant and model version. */
object State {
  val jedis = new JedisPooled("redis", 6379)
  val EntryTtlSeconds = 86400L

  /** A hash that exists but has no answer: an interrupted write, not an entry. */
  class IncompleteEntry(key: String) extends RuntimeException(s"incomplete entry $key: no answer")

  /** One stored answer as a lookup sees it; similarity is the cosine to the query (0 from getEntry). */
  case class Entry(entryId: String, answer: String, similarity: Double, createdAt: Double, expiresAt: Double, policyVersion: String)

  /** One EVAL per write: hash, TTL and index membership together. */
  val PutEntryScript: String =
    """${PUT_ENTRY_LUA[0]}
      |${PUT_ENTRY_LUA[1]}
      |${PUT_ENTRY_LUA[2]}
      |${PUT_ENTRY_LUA[3]}
      |""".stripMargin

  def entryKey(tenant: String, modelVersion: String, entryId: String): String = s"entry:$tenant:$modelVersion:$entryId"

  def indexName(tenant: String, modelVersion: String): String = s"semantic:$tenant:$modelVersion"

  def putEntry(tenant: String, modelVersion: String, entryId: String, embedding: Seq[Double], answer: String, policyVersion: String): Unit = {
    val now = System.currentTimeMillis() / 1000.0
    val keys = List(entryKey(tenant, modelVersion, entryId), indexName(tenant, modelVersion))
    val args = List(embedding.mkString("[", ",", "]"), answer, now.toString, (now + EntryTtlSeconds).toString, policyVersion, EntryTtlSeconds.toString)
    jedis.eval(PutEntryScript, keys.asJava, args.asJava)
  }

  private def entryOf(key: String, raw: Map[String, String], similarity: Double): Entry =
    Entry(key.substring(key.lastIndexOf(':') + 1), raw("answer"), similarity, raw("created_at").toDouble, raw("expires_at").toDouble, raw.getOrElse("policy_version", ""))

  /** The nearest entry at or above threshold, expired or not; None when nothing qualifies. */
  def searchEntries(tenant: String, modelVersion: String, embedding: Seq[Double], threshold: Double): Option[Entry] = {
    var best: Option[Entry] = None
    for (key <- jedis.smembers(indexName(tenant, modelVersion)).asScala) {
      val raw = jedis.hgetAll(key).asScala.toMap
      if (raw.nonEmpty && raw.contains("answer")) { // expired, or a write that never finished, are skipped
        val stored = ujson.read(raw("embedding")).arr.map(_.num).toSeq
        val similarity = Vectors.cosine(embedding, stored)
        if (similarity >= threshold && best.forall(similarity > _.similarity)) best = Some(entryOf(key, raw, similarity))
      }
    }
    best
  }

  def getEntry(tenant: String, modelVersion: String, entryId: String): Option[Entry] = {
    val key = entryKey(tenant, modelVersion, entryId)
    val raw = jedis.hgetAll(key).asScala.toMap
    if (raw.isEmpty) None
    else if (!raw.contains("answer")) throw new IncompleteEntry(key)
    else Some(entryOf(key, raw, 0.0))
  }
}
`,
    },
    cpp: {
      starter: `// The cache store: entries in Redis, found by cosine similarity.
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "semcache/vectors.h"
#include "state.h"

sw::redis::Redis redis("tcp://redis:6379");

std::string entry_key(const std::string& tenant, const std::string& model_version, const std::string& entry_id) {
  return "entry:" + tenant + ":" + model_version + ":" + entry_id;
}

std::string index_name(const std::string& tenant, const std::string& model_version) { return "semantic:all"; }

void put_entry(const std::string& tenant, const std::string& model_version, const std::string& entry_id,
               const std::vector<double>& embedding, const std::string& answer, const std::string& policy_version) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const double now = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string key = entry_key(tenant, model_version, entry_id);
  redis.hset(key, "embedding", nlohmann::json(embedding).dump(), "created_at", std::to_string(now), "expires_at",
             std::to_string(now + kEntryTtlSeconds), "policy_version", policy_version);
  redis.hset(key, "answer", answer);
  redis.sadd(index_name(tenant, model_version), key);
}

static Entry entry_of(const std::string& key, const std::unordered_map<std::string, std::string>& raw, double similarity) {
  Entry e;
  e.entry_id = key.substr(key.rfind(':') + 1);
  e.answer = raw.count("answer") ? raw.at("answer") : "";
  e.similarity = similarity;
  e.created_at = std::stod(raw.at("created_at"));
  e.expires_at = std::stod(raw.at("expires_at"));
  e.policy_version = raw.count("policy_version") ? raw.at("policy_version") : "";
  return e;
}

std::optional<Entry> search_entries(const std::string& tenant, const std::string& model_version,
                                    const std::vector<double>& embedding, double threshold) {
  std::optional<Entry> best;
  for (const std::string& key : redis.smembers("semantic:all")) {
    const auto raw = redis.hgetall(key);
    if (raw.empty()) continue;
    const auto stored = nlohmann::json::parse(raw.at("embedding")).get<std::vector<double>>();
    const double similarity = semcache::cosine(embedding, stored);
    if (similarity >= threshold && (!best || similarity > best->similarity)) best = entry_of(key, raw, similarity);
  }
  return best;
}

std::optional<Entry> get_entry(const std::string& tenant, const std::string& model_version, const std::string& entry_id) {
  const std::string key = entry_key(tenant, model_version, entry_id);
  const auto raw = redis.hgetall(key);
  if (raw.empty()) return std::nullopt;
  return entry_of(key, raw, 0.0);
}
`,
      solution: `// The cache store: entries in Redis, one index per tenant and model version.
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "semcache/vectors.h"
#include "state.h"

sw::redis::Redis redis("tcp://redis:6379");

// One EVAL per write: hash, TTL and index membership together.
const std::string kPutEntryScript = R"(
${PUT_ENTRY_LUA.join('\n')}
)";

std::string entry_key(const std::string& tenant, const std::string& model_version, const std::string& entry_id) {
  return "entry:" + tenant + ":" + model_version + ":" + entry_id;
}

std::string index_name(const std::string& tenant, const std::string& model_version) {
  return "semantic:" + tenant + ":" + model_version;
}

void put_entry(const std::string& tenant, const std::string& model_version, const std::string& entry_id,
               const std::vector<double>& embedding, const std::string& answer, const std::string& policy_version) {
  const double now = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  redis.eval<long long>(kPutEntryScript, {entry_key(tenant, model_version, entry_id), index_name(tenant, model_version)},
                        {nlohmann::json(embedding).dump(), answer, std::to_string(now), std::to_string(now + kEntryTtlSeconds),
                         policy_version, std::to_string(kEntryTtlSeconds)});
}

static Entry entry_of(const std::string& key, const std::unordered_map<std::string, std::string>& raw, double similarity) {
  Entry e;
  e.entry_id = key.substr(key.rfind(':') + 1);
  e.answer = raw.at("answer");
  e.similarity = similarity;
  e.created_at = std::stod(raw.at("created_at"));
  e.expires_at = std::stod(raw.at("expires_at"));
  e.policy_version = raw.count("policy_version") ? raw.at("policy_version") : "";
  return e;
}

std::optional<Entry> search_entries(const std::string& tenant, const std::string& model_version,
                                    const std::vector<double>& embedding, double threshold) {
  std::optional<Entry> best;
  for (const std::string& key : redis.smembers(index_name(tenant, model_version))) {
    const auto raw = redis.hgetall(key);
    if (raw.empty() || !raw.count("answer")) continue;  // expired, or a write that never finished
    const auto stored = nlohmann::json::parse(raw.at("embedding")).get<std::vector<double>>();
    const double similarity = semcache::cosine(embedding, stored);
    if (similarity >= threshold && (!best || similarity > best->similarity)) best = entry_of(key, raw, similarity);
  }
  return best;
}

std::optional<Entry> get_entry(const std::string& tenant, const std::string& model_version, const std::string& entry_id) {
  const std::string key = entry_key(tenant, model_version, entry_id);
  const auto raw = redis.hgetall(key);
  if (raw.empty()) return std::nullopt;
  if (!raw.count("answer")) throw IncompleteEntry(key);
  return entry_of(key, raw, 0.0);
}
`,
    },
  },
  harness: {
    python: `import json

MV = "2024-06"
V = [1.0, 0.0, 0.0, 0.0]
NEAR = [0.9, 0.1, 0.0, 0.0]  # cosine 0.994 to V
FAR = [0.0, 1.0, 0.0, 0.0]  # cosine 0 to V
ANSWER = "Refunds take five business days."


def _seed(ctx, tenant, entry_id, embedding, answer, index=None, expires_in=86400):
    """An entry as put_entry writes it (and every other step reads it), written by another worker: no TTL."""
    key = f"entry:{tenant}:{MV}:{entry_id}"
    now = ctx.clock.time()
    mapping = {"embedding": json.dumps(embedding), "created_at": now, "expires_at": now + expires_in, "policy_version": "2024-06-1"}
    if answer is not None:
        mapping["answer"] = answer
    ctx.redis.hset(key, mapping=mapping)
    ctx.redis.sadd(index or f"semantic:{tenant}:{MV}", key)
    return key


def check_atomic_write(ctx):
    m = ctx.load("state")
    key = "entry:acme:2024-06:e1"
    commands = []
    original = m.r.execute_command

    def recording(*args, **kwargs):
        commands.append(str(args[0]).upper())
        return original(*args, **kwargs)

    m.r.execute_command = recording
    m.put_entry("acme", MV, "e1", V, ANSWER, "2024-06-1")
    raw = ctx.redis.hgetall(key)
    assert raw, f"put_entry wrote no hash at {key} (keys: {sorted(ctx.redis.keys('*'))})"
    for field in ("embedding", "answer", "created_at", "expires_at", "policy_version"):
        assert field in raw, f"{key} has fields {sorted(raw)}, expected embedding, answer, created_at, expires_at and policy_version"
    assert json.loads(raw["embedding"]) == V and raw["answer"] == ANSWER and raw["policy_version"] == "2024-06-1", f"{key} holds {raw}"
    scripted = [c for c in commands if c in ("EVAL", "EVALSHA")]
    assert scripted, f"put_entry sent {commands} to Redis: the hash, its EXPIRE and the index membership must be written inside one EVAL/EVALSHA, or a write that dies between two commands leaves an embedding with no answer"
    client_side = [c for c in commands if c.startswith("H") or c in ("SADD", "EXPIRE")]
    assert not client_side, f"put_entry sent {commands} to Redis: {client_side} ran from the client, outside the script"
    assert key in ctx.redis.smembers("semantic:acme:2024-06"), f"semantic:acme:2024-06 holds {sorted(ctx.redis.smembers('semantic:acme:2024-06'))}, expected the entry's key"


def check_tenant_scope(ctx):
    m = ctx.load("state")
    m.put_entry("acme", MV, "e1", V, ANSWER, "2024-06-1")
    m.put_entry("globex", MV, "e2", V, "Globex does not refund.", "2024-06-1")
    assert ctx.redis.exists("semantic:all") == 0, f"a global index semantic:all exists with {sorted(ctx.redis.smembers('semantic:all'))}: every tenant's entries share one vector space"
    acme = ctx.redis.smembers("semantic:acme:2024-06")
    assert acme == {"entry:acme:2024-06:e1"}, f"semantic:acme:2024-06 holds {sorted(acme)}, expected only acme's entry key (keys: {sorted(ctx.redis.keys('semantic:*'))})"
    hit = m.search_entries("acme", MV, V, 0.82)
    assert hit is not None and hit["answer"] == ANSWER, f"acme's lookup of its own question returned {hit}, expected acme's answer"


def check_answer_required(ctx):
    m = ctx.load("state")
    key = _seed(ctx, "acme", "e1", V, None)  # an interrupted write: embedding, no answer
    try:
        got = m.get_entry("acme", MV, "e1")
    except m.IncompleteEntry:
        got = "raised"
    assert got == "raised", f"get_entry returned {got!r} for a hash with an embedding and no answer: raise IncompleteEntry, an interrupted write is not an entry"
    hit = m.search_entries("acme", MV, V, 0.82)
    assert hit is None, f"search_entries returned {hit} for an entry with no answer: a lookup would serve an empty answer"
    _seed(ctx, "acme", "e2", V, ANSWER)
    hit = m.search_entries("acme", MV, V, 0.82)
    assert hit is not None and hit["entry_id"] == "e2", f"with a complete entry beside the incomplete one search_entries returned {hit}, expected e2"
    assert ctx.redis.exists(key) == 1, "the incomplete hash is the store's to clean up later; the search must only skip it"


def check_ttl(ctx):
    m = ctx.load("state")
    key = "entry:acme:2024-06:e1"
    m.put_entry("acme", MV, "e1", V, ANSWER, "2024-06-1")
    ttl = ctx.redis.ttl(key)
    assert 86000 <= ttl <= 86400, f"{key} has TTL {ttl}, expected ENTRY_TTL_SECONDS (86400) set by the write"
    raw = ctx.redis.hgetall(key)
    assert abs(float(raw["expires_at"]) - float(raw["created_at"]) - 86400) < 1, f"expires_at - created_at is {float(raw['expires_at']) - float(raw['created_at'])}, expected 86400"
    ctx.clock.advance(86401)
    assert ctx.redis.exists(key) == 0, f"{key} still exists 86401 s after the write"
    hit = m.search_entries("acme", MV, V, 0.82)
    assert hit is None, f"search_entries returned {hit} after the entry expired: a key whose hash is gone must be skipped"


def check_disjoint_search(ctx):
    m = ctx.load("state")
    key = _seed(ctx, "globex", "g1", V, "Globex does not refund.")
    ctx.redis.sadd("semantic:all", key)  # an older build's global index, still around
    hit = m.search_entries("acme", MV, V, 0.82)
    assert hit is None, f"acme's lookup returned {hit}, globex's entry: the search read an index that is not acme's"
    hit = m.search_entries("globex", MV, NEAR, 0.82)
    assert hit is not None and hit["entry_id"] == "g1", f"globex's lookup of a near question returned {hit}, expected g1"
    assert 0.99 <= hit["similarity"] <= 1.0, f"similarity is {hit['similarity']}, expected the cosine of the two embeddings (0.994)"
    assert m.search_entries("globex", MV, FAR, 0.82) is None, "an orthogonal question must not hit"
`,
    typescript: `const MV = '2024-06';
const V = [1, 0, 0, 0];
const NEAR = [0.9, 0.1, 0, 0]; // cosine 0.994 to V
const FAR = [0, 1, 0, 0]; // cosine 0 to V
const ANSWER = 'Refunds take five business days.';

/** An entry as putEntry writes it (and every other step reads it), written by another worker: no TTL. */
function seed(ctx, tenant: string, entryId: string, embedding: number[], answer: string | null, index?: string, expiresIn = 86400): string {
  const key = \`entry:\${tenant}:\${MV}:\${entryId}\`;
  const now = ctx.clock.now() / 1000;
  const fields: (string | number)[] = ['embedding', JSON.stringify(embedding), 'created_at', now, 'expires_at', now + expiresIn, 'policy_version', '2024-06-1'];
  if (answer !== null) fields.push('answer', answer);
  ctx.redis.hset(key, ...fields);
  ctx.redis.sadd(index ?? \`semantic:\${tenant}:\${MV}\`, key);
  return key;
}

export async function check_atomic_write(ctx) {
  const m = ctx.load('state');
  const key = 'entry:acme:2024-06:e1';
  // Another worker reads the entry right after the first command that touches it.
  const probe = ctx.redisAfter(key, () => ctx.redis.hgetall(key));
  await m.putEntry('acme', MV, 'e1', V, ANSWER, '2024-06-1');
  const raw = ctx.redis.hgetall(key);
  assert(Object.keys(raw).length > 0, \`putEntry wrote no hash at \${key} (keys: \${JSON.stringify(ctx.redis.keys('*'))})\`);
  for (const field of ['embedding', 'answer', 'created_at', 'expires_at', 'policy_version']) {
    assert(field in raw, \`\${key} has fields \${JSON.stringify(Object.keys(raw))}, expected embedding, answer, created_at, expires_at and policy_version\`);
  }
  assert(probe.fired, 'nothing touched the entry key');
  const seen = Object.keys(probe.result as Record<string, string>);
  assert(seen.includes('answer') && seen.includes('embedding'), \`right after your first command on \${key} another worker read fields \${JSON.stringify(seen)}: an embedding with no answer behind it. Write the hash, its EXPIRE and the index membership inside one Lua script\`);
  assert.equal(raw.answer, ANSWER);
  assert.deepEqual(JSON.parse(raw.embedding), V);
  assert(ctx.redis.smembers('semantic:acme:2024-06').includes(key), \`semantic:acme:2024-06 holds \${JSON.stringify(ctx.redis.smembers('semantic:acme:2024-06'))}, expected the entry's key\`);
}

export async function check_tenant_scope(ctx) {
  const m = ctx.load('state');
  await m.putEntry('acme', MV, 'e1', V, ANSWER, '2024-06-1');
  await m.putEntry('globex', MV, 'e2', V, 'Globex does not refund.', '2024-06-1');
  assert.equal(ctx.redis.exists('semantic:all'), 0, \`a global index semantic:all exists with \${JSON.stringify(ctx.redis.smembers('semantic:all'))}: every tenant's entries share one vector space\`);
  const acme = ctx.redis.smembers('semantic:acme:2024-06');
  assert.deepEqual(acme, ['entry:acme:2024-06:e1'], \`semantic:acme:2024-06 holds \${JSON.stringify(acme)}, expected only acme's entry key (keys: \${JSON.stringify(ctx.redis.keys('semantic:*'))})\`);
  const hit = await m.searchEntries('acme', MV, V, 0.82);
  assert(hit !== null && hit.answer === ANSWER, \`acme's lookup of its own question returned \${JSON.stringify(hit)}, expected acme's answer\`);
}

export async function check_answer_required(ctx) {
  const m = ctx.load('state');
  const key = seed(ctx, 'acme', 'e1', V, null); // an interrupted write: embedding, no answer
  let got: unknown = 'returned';
  try {
    got = await m.getEntry('acme', MV, 'e1');
  } catch (e) {
    got = e instanceof m.IncompleteEntry ? 'raised' : e;
  }
  assert.equal(got, 'raised', \`getEntry gave \${JSON.stringify(got)} for a hash with an embedding and no answer: throw IncompleteEntry, an interrupted write is not an entry\`);
  let hit = await m.searchEntries('acme', MV, V, 0.82);
  assert.equal(hit, null, \`searchEntries returned \${JSON.stringify(hit)} for an entry with no answer: a lookup would serve an empty answer\`);
  seed(ctx, 'acme', 'e2', V, ANSWER);
  hit = await m.searchEntries('acme', MV, V, 0.82);
  assert(hit !== null && hit.entry_id === 'e2', \`with a complete entry beside the incomplete one searchEntries returned \${JSON.stringify(hit)}, expected e2\`);
  assert.equal(ctx.redis.exists(key), 1, "the incomplete hash is the store's to clean up later; the search must only skip it");
}

export async function check_ttl(ctx) {
  const m = ctx.load('state');
  const key = 'entry:acme:2024-06:e1';
  await m.putEntry('acme', MV, 'e1', V, ANSWER, '2024-06-1');
  const ttl = ctx.redis.ttl(key);
  assert(86000 <= ttl && ttl <= 86400, \`\${key} has TTL \${ttl}, expected ENTRY_TTL_SECONDS (86400) set by the write\`);
  const raw = ctx.redis.hgetall(key);
  assert(Math.abs(Number(raw.expires_at) - Number(raw.created_at) - 86400) < 1, \`expires_at - created_at is \${Number(raw.expires_at) - Number(raw.created_at)}, expected 86400\`);
  ctx.clock.advance(86401);
  assert.equal(ctx.redis.exists(key), 0, \`\${key} still exists 86401 s after the write\`);
  const hit = await m.searchEntries('acme', MV, V, 0.82);
  assert.equal(hit, null, \`searchEntries returned \${JSON.stringify(hit)} after the entry expired: a key whose hash is gone must be skipped\`);
}

export async function check_disjoint_search(ctx) {
  const m = ctx.load('state');
  const key = seed(ctx, 'globex', 'g1', V, 'Globex does not refund.');
  ctx.redis.sadd('semantic:all', key); // an older build's global index, still around
  let hit = await m.searchEntries('acme', MV, V, 0.82);
  assert.equal(hit, null, \`acme's lookup returned \${JSON.stringify(hit)}, globex's entry: the search read an index that is not acme's\`);
  hit = await m.searchEntries('globex', MV, NEAR, 0.82);
  assert(hit !== null && hit.entry_id === 'g1', \`globex's lookup of a near question returned \${JSON.stringify(hit)}, expected g1\`);
  assert(0.99 <= hit.similarity && hit.similarity <= 1, \`similarity is \${hit.similarity}, expected the cosine of the two embeddings (0.994)\`);
  assert.equal(await m.searchEntries('globex', MV, FAR, 0.82), null, 'an orthogonal question must not hit');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"leetbuild/harness"
)

const (
	stateMV     = "2024-06"
	stateAnswer = "Refunds take five business days."
)

var (
	stateV    = []float64{1, 0, 0, 0}
	stateNear = []float64{0.9, 0.1, 0, 0} // cosine 0.994 to stateV
	stateFar  = []float64{0, 1, 0, 0}     // cosine 0 to stateV
)

// seedEntry writes an entry as putEntry writes it (and every other step reads it), from another worker: no TTL.
func seedEntry(ctx *harness.Ctx, tenant, entryID string, embedding []float64, answer *string, index string, expiresIn float64) string {
	key := fmt.Sprintf("entry:%s:%s:%s", tenant, stateMV, entryID)
	now := float64(ctx.Clock.Now()) / 1000
	vec, _ := json.Marshal(embedding)
	args := []any{"HSET", key, "embedding", string(vec), "created_at", now, "expires_at", now + expiresIn, "policy_version", "2024-06-1"}
	if answer != nil {
		args = append(args, "answer", *answer)
	}
	ctx.Redis.Do(args...)
	if index == "" {
		index = fmt.Sprintf("semantic:%s:%s", tenant, stateMV)
	}
	ctx.Redis.Do("SADD", index, key)
	return key
}

func CheckAtomicWrite(ctx *harness.Ctx) {
	key := "entry:acme:2024-06:e1"
	// Another worker reads the entry right after the first command that touches it.
	probe := ctx.Redis.After(key, func() any { return ctx.Redis.HGetAll(key) })
	ctx.NoError(putEntry(context.Background(), "acme", stateMV, "e1", stateV, stateAnswer, "2024-06-1"), "putEntry")
	raw := ctx.Redis.HGetAll(key)
	ctx.Assert(len(raw) > 0, "putEntry wrote no hash at %s (keys: %v)", key, ctx.Redis.Keys("*"))
	for _, field := range []string{"embedding", "answer", "created_at", "expires_at", "policy_version"} {
		_, ok := raw[field]
		ctx.Assert(ok, "%s has fields %v, expected embedding, answer, created_at, expires_at and policy_version", key, raw)
	}
	ctx.Assert(probe.Fired, "nothing touched the entry key")
	seen, _ := probe.Result.(map[string]string)
	_, hasAnswer := seen["answer"]
	_, hasEmbedding := seen["embedding"]
	ctx.Assert(hasAnswer && hasEmbedding, "right after your first command on %s another worker read fields %v: an embedding with no answer behind it. Write the hash, its EXPIRE and the index membership inside one Lua script", key, seen)
	ctx.Equal(raw["answer"], stateAnswer, "answer")
	ctx.Equal(ctx.Redis.SMembers("semantic:acme:2024-06"), []string{key}, "semantic:acme:2024-06 must hold the entry's key")
}

func CheckTenantScope(ctx *harness.Ctx) {
	bg := context.Background()
	ctx.NoError(putEntry(bg, "acme", stateMV, "e1", stateV, stateAnswer, "2024-06-1"), "putEntry acme")
	ctx.NoError(putEntry(bg, "globex", stateMV, "e2", stateV, "Globex does not refund.", "2024-06-1"), "putEntry globex")
	ctx.Equal(ctx.Redis.Exists("semantic:all"), 0, "a global index semantic:all exists with %v: every tenant's entries share one vector space; its EXISTS", ctx.Redis.SMembers("semantic:all"))
	ctx.Equal(ctx.Redis.SMembers("semantic:acme:2024-06"), []string{"entry:acme:2024-06:e1"}, "semantic:acme:2024-06 must hold only acme's entry key (keys: %v)", ctx.Redis.Keys("semantic:*"))
	hit, err := searchEntries(bg, "acme", stateMV, stateV, 0.82)
	ctx.NoError(err, "searchEntries")
	ctx.Assert(hit != nil && hit.Answer == stateAnswer, "acme's lookup of its own question returned %v, expected acme's answer", hit)
}

func CheckAnswerRequired(ctx *harness.Ctx) {
	bg := context.Background()
	key := seedEntry(ctx, "acme", "e1", stateV, nil, "", 86400) // an interrupted write: embedding, no answer
	got, err := getEntry(bg, "acme", stateMV, "e1")
	ctx.Assert(errors.Is(err, ErrIncompleteEntry), "getEntry returned (%v, %v) for a hash with an embedding and no answer: return ErrIncompleteEntry, an interrupted write is not an entry", got, err)
	hit, err := searchEntries(bg, "acme", stateMV, stateV, 0.82)
	ctx.NoError(err, "searchEntries")
	ctx.Assert(hit == nil, "searchEntries returned %v for an entry with no answer: a lookup would serve an empty answer", hit)
	answer := stateAnswer
	seedEntry(ctx, "acme", "e2", stateV, &answer, "", 86400)
	hit, err = searchEntries(bg, "acme", stateMV, stateV, 0.82)
	ctx.NoError(err, "searchEntries")
	ctx.Assert(hit != nil && hit.EntryID == "e2", "with a complete entry beside the incomplete one searchEntries returned %v, expected e2", hit)
	ctx.Equal(ctx.Redis.Exists(key), 1, "the incomplete hash is the store's to clean up later; the search must only skip it; EXISTS")
}

func CheckTtl(ctx *harness.Ctx) {
	bg := context.Background()
	key := "entry:acme:2024-06:e1"
	ctx.NoError(putEntry(bg, "acme", stateMV, "e1", stateV, stateAnswer, "2024-06-1"), "putEntry")
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(86000 <= ttl && ttl <= 86400, "%s has TTL %d, expected entryTTLSeconds (86400) set by the write", key, ttl)
	raw := ctx.Redis.HGetAll(key)
	createdAt, _ := strconv.ParseFloat(raw["created_at"], 64)
	expiresAt, _ := strconv.ParseFloat(raw["expires_at"], 64)
	ctx.Assert(expiresAt-createdAt > 86399 && expiresAt-createdAt < 86401, "expires_at - created_at is %v, expected 86400", expiresAt-createdAt)
	ctx.Clock.Advance(86401)
	ctx.Equal(ctx.Redis.Exists(key), 0, "%s still exists 86401 s after the write; EXISTS", key)
	hit, err := searchEntries(bg, "acme", stateMV, stateV, 0.82)
	ctx.NoError(err, "searchEntries")
	ctx.Assert(hit == nil, "searchEntries returned %v after the entry expired: a key whose hash is gone must be skipped", hit)
}

func CheckDisjointSearch(ctx *harness.Ctx) {
	bg := context.Background()
	answer := "Globex does not refund."
	key := seedEntry(ctx, "globex", "g1", stateV, &answer, "", 86400)
	ctx.Redis.Do("SADD", "semantic:all", key) // an older build's global index, still around
	hit, err := searchEntries(bg, "acme", stateMV, stateV, 0.82)
	ctx.NoError(err, "searchEntries")
	ctx.Assert(hit == nil, "acme's lookup returned %v, globex's entry: the search read an index that is not acme's", hit)
	hit, err = searchEntries(bg, "globex", stateMV, stateNear, 0.82)
	ctx.NoError(err, "searchEntries")
	ctx.Assert(hit != nil && hit.EntryID == "g1", "globex's lookup of a near question returned %v, expected g1", hit)
	ctx.Assert(0.99 <= hit.Similarity && hit.Similarity <= 1, "similarity is %v, expected the cosine of the two embeddings (0.994)", hit.Similarity)
	hit, err = searchEntries(bg, "globex", stateMV, stateFar, 0.82)
	ctx.NoError(err, "searchEntries")
	ctx.Assert(hit == nil, "an orthogonal question must not hit, got %v", hit)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kMV = "2024-06";
const std::string kAnswer = "Refunds take five business days.";
const std::vector<double> kV = {1, 0, 0, 0};
const std::vector<double> kNear = {0.9, 0.1, 0, 0};  // cosine 0.994 to kV
const std::vector<double> kFar = {0, 1, 0, 0};       // cosine 0 to kV

// An entry as put_entry writes it (and every other step reads it), from another worker: no TTL.
std::string seedEntry(harness::Ctx& ctx, const std::string& tenant, const std::string& entryId, const std::vector<double>& embedding,
                      const std::optional<std::string>& answer, std::string index = "", double expiresIn = 86400) {
  const std::string key = "entry:" + tenant + ":" + kMV + ":" + entryId;
  const double now = static_cast<double>(ctx.Clock.Now()) / 1000;
  std::vector<std::string> args = {"HSET", key, "embedding", nlohmann::json(embedding).dump(), "created_at", harness::Value(now),
                                   "expires_at", harness::Value(now + expiresIn), "policy_version", "2024-06-1"};
  if (answer) {
    args.push_back("answer");
    args.push_back(*answer);
  }
  ctx.Redis.Must(args);
  if (index.empty()) index = "semantic:" + tenant + ":" + kMV;
  ctx.Redis.Do("SADD", index, key);
  return key;
}

std::string show(const std::optional<Entry>& e) {
  if (!e) return "<nil>";
  return "{entry_id=" + e->entry_id + " answer=" + harness::Quote(e->answer) + " similarity=" + harness::FormatFloat(e->similarity) + "}";
}

}  // namespace

void CheckAtomicWrite(harness::Ctx& ctx) {
  const std::string key = "entry:acme:2024-06:e1";
  // Another worker reads the entry right after the first command that touches it.
  bool fired = false;
  std::map<std::string, std::string> seen;
  ctx.Redis.After(key, [&] {
    fired = true;
    seen = ctx.Redis.HGetAll(key);
  });
  put_entry("acme", kMV, "e1", kV, kAnswer, "2024-06-1");
  const auto raw = ctx.Redis.HGetAll(key);
  ctx.Assert(!raw.empty(), "put_entry wrote no hash at %s (keys: %v)", key, ctx.Redis.Keys("*"));
  for (const std::string field : {"embedding", "answer", "created_at", "expires_at", "policy_version"}) {
    ctx.Assert(raw.count(field) > 0, "%s has fields %v, expected embedding, answer, created_at, expires_at and policy_version", key, raw);
  }
  ctx.Assert(fired, "nothing touched the entry key");
  ctx.Assert(seen.count("answer") > 0 && seen.count("embedding") > 0,
             "right after your first command on %s another worker read fields %v: an embedding with no answer behind it. Write the "
             "hash, its EXPIRE and the index membership inside one Lua script",
             key, seen);
  ctx.Equal(raw.at("answer"), kAnswer, "answer");
  ctx.Equal(ctx.Redis.SMembers("semantic:acme:2024-06"), {key}, "semantic:acme:2024-06 must hold the entry's key");
}

void CheckTenantScope(harness::Ctx& ctx) {
  put_entry("acme", kMV, "e1", kV, kAnswer, "2024-06-1");
  put_entry("globex", kMV, "e2", kV, "Globex does not refund.", "2024-06-1");
  ctx.Equal(ctx.Redis.Exists("semantic:all"), 0,
            "a global index semantic:all exists with %v: every tenant's entries share one vector space; its EXISTS",
            ctx.Redis.SMembers("semantic:all"));
  ctx.Equal(ctx.Redis.SMembers("semantic:acme:2024-06"), {"entry:acme:2024-06:e1"},
            "semantic:acme:2024-06 must hold only acme's entry key (keys: %v)", ctx.Redis.Keys("semantic:*"));
  const auto hit = search_entries("acme", kMV, kV, 0.82);
  ctx.Assert(hit && hit->answer == kAnswer, "acme's lookup of its own question returned %s, expected acme's answer", show(hit));
}

void CheckAnswerRequired(harness::Ctx& ctx) {
  const std::string key = seedEntry(ctx, "acme", "e1", kV, std::nullopt);  // an interrupted write: embedding, no answer
  std::string got = "returned";
  try {
    const auto e = get_entry("acme", kMV, "e1");
    got = "returned " + show(e);
  } catch (const IncompleteEntry&) {
    got = "raised";
  }
  ctx.Equal(got, "raised", "get_entry on a hash with an embedding and no answer: throw IncompleteEntry, an interrupted write is not an entry");
  auto hit = search_entries("acme", kMV, kV, 0.82);
  ctx.Assert(!hit, "search_entries returned %s for an entry with no answer: a lookup would serve an empty answer", show(hit));
  seedEntry(ctx, "acme", "e2", kV, kAnswer);
  hit = search_entries("acme", kMV, kV, 0.82);
  ctx.Assert(hit && hit->entry_id == "e2", "with a complete entry beside the incomplete one search_entries returned %s, expected e2", show(hit));
  ctx.Equal(ctx.Redis.Exists(key), 1, "the incomplete hash is the store's to clean up later; the search must only skip it; EXISTS");
}

void CheckTtl(harness::Ctx& ctx) {
  const std::string key = "entry:acme:2024-06:e1";
  put_entry("acme", kMV, "e1", kV, kAnswer, "2024-06-1");
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(86000 <= ttl && ttl <= 86400, "%s has TTL %d, expected kEntryTtlSeconds (86400) set by the write", key, ttl);
  const auto raw = ctx.Redis.HGetAll(key);
  const double span = std::stod(raw.at("expires_at")) - std::stod(raw.at("created_at"));
  ctx.Assert(span > 86399 && span < 86401, "expires_at - created_at is %v, expected 86400", span);
  ctx.Clock.Advance(86401);
  ctx.Equal(ctx.Redis.Exists(key), 0, "%s still exists 86401 s after the write; EXISTS", key);
  const auto hit = search_entries("acme", kMV, kV, 0.82);
  ctx.Assert(!hit, "search_entries returned %s after the entry expired: a key whose hash is gone must be skipped", show(hit));
}

void CheckDisjointSearch(harness::Ctx& ctx) {
  const std::string key = seedEntry(ctx, "globex", "g1", kV, std::string("Globex does not refund."));
  ctx.Redis.Do("SADD", "semantic:all", key);  // an older build's global index, still around
  auto hit = search_entries("acme", kMV, kV, 0.82);
  ctx.Assert(!hit, "acme's lookup returned %s, globex's entry: the search read an index that is not acme's", show(hit));
  hit = search_entries("globex", kMV, kNear, 0.82);
  ctx.Assert(hit && hit->entry_id == "g1", "globex's lookup of a near question returned %s, expected g1", show(hit));
  ctx.Assert(0.99 <= hit->similarity && hit->similarity <= 1, "similarity is %v, expected the cosine of the two embeddings (0.994)",
             hit->similarity);
  hit = search_entries("globex", kMV, kFar, 0.82);
  ctx.Assert(!hit, "an orthogonal question must not hit, got %s", show(hit));
}
`,
  },
  debrief: `The store's whole promise is "a key in the index is an entry you may serve", and one Lua script is what keeps it: the hash, its TTL and the set membership land together or not at all, so a scan never meets a half-written entry. The index set is named by tenant and model version because similarity is only meaningful inside one vector space; a shared set would rank another tenant's answers against this tenant's question, and the nearest one wins. The scan skips an expired key and a hash without an answer rather than failing, because the index is allowed to lag the data. A production store replaces the scan with an ANN index (HNSW in pgvector or RediSearch) and removes keys from the set when the hash expires, which this step leaves to the scan's tolerance.`,
};
