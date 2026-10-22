import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis vector sets with tenant-scoped indexes',
  concept: 'redis',
  file: 'state',
  focus: ['cache', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a single tenant asking its own
question gets the cached answer, so the demo passes. It hides three production flaws — one write
that is not atomic, one index shared by every tenant, and one read that accepts a half-written
entry. Review it like the cache's owner, fix it, and prove the fix with the checks below.

Cached answers live in a Redis vector index. Implement the cache store the semantic cache calls:

- \`put_entry(tenant, model_version, entry_id, embedding, answer)\` must write the embedding, the
  answer and the entry's expiry in **one atomic step**, through the \`PUT_ENTRY_SCRIPT\` Lua script
  executed with a single \`eval\`. Two separate \`HSET\`s can be interrupted between them, leaving an
  embedding whose answer write never landed — a lookup then "hits" an entry that cannot be served.
- \`index_name(tenant, model_version)\` returns \`semantic:{tenant}:{model_version}\`. Every entry lives
  in exactly one tenant's vector space; the draft indexes all tenants together under \`semantic:all\`,
  so a similar question from another tenant surfaces an answer that is not theirs to see.
- \`search_entries(tenant, model_version, embedding, threshold)\` runs the KNN query against **only**
  the caller's index, clamps the requested threshold into \`[0.82, 0.99]\`, and skips any entry whose
  \`expires_at\` has already passed. Searching a shared index returns another tenant's nearest
  neighbour, which is both a correctness bug and a data-boundary bug.
- \`get_entry(tenant, model_version, entry_id)\` raises an \`IncompleteEntry\` error when the stored
  hash exists but has no \`answer\` field. An embedding without an answer is never a hit: the draft
  returns the partial hash and the caller caches a poisoned answer.
- Every written entry gets an \`EXPIRE\` of \`ENTRY_TTL_SECONDS\` (**3600** seconds) in the same script.
  Without it the entry outlives its model version and is served forever.

**Failure mode the checks target.** The atomicity bug is the subtle one: it only shows up when a
write dies between the two commands, so every serial test passes and one unlucky request poisons the
cache. The tenancy bug is the dangerous one: a global index means the nearest neighbour of a
tenant's question may be another tenant's cached answer, and the caller cannot tell the difference.
The read path then makes both worse — it treats "a hash with an embedding" as a valid hit, so a
partial write is served instead of rejected.`,
  sequence: {
    participants: ['Semantic Cache', 'Redis vector index', 'cache store'],
    messages: [
      {
        from: 'Semantic Cache',
        to: 'Redis vector index',
        label: 'EVAL PUT_ENTRY_SCRIPT key=entry:{tenant}:{version}:{id} · embedding · answer · expires_at',
        kind: 'sync',
      },
      {from: 'Redis vector index', to: 'Semantic Cache', label: 'embedding + answer applied atomically', kind: 'reply'},
      {from: 'Semantic Cache', to: 'Redis vector index', label: 'EXPIRE key ENTRY_TTL_SECONDS', kind: 'sync'},
      {from: 'Semantic Cache', to: 'Redis vector index', label: 'KNN semantic:{tenant}:{version}', kind: 'sync'},
      {from: 'Redis vector index', to: 'Semantic Cache', label: 'nearest live entry / none', kind: 'reply'},
      {from: 'Semantic Cache', to: 'cache store', label: 'record entry digest', kind: 'async'},
    ],
  },
  hints: [
    'The write is the contract: one `HSET` with `embedding`, `answer` and `expires_at` inside one `PUT_ENTRY_SCRIPT`, run with a single `eval`, plus the `EXPIRE` in that same script. Two client-side `hset` calls are two round trips and two chances to fail between them.',
    'Tenancy lives in the index name. `index_name(tenant, model_version)` must build `semantic:{tenant}:{model_version}`, and both the write and the KNN query must go through it — a literal `semantic:all` anywhere is the leak. Two tenants sharing one index share one vector space.',
    'A hash without an `answer` is not an entry: `get_entry` must check the field before returning, and the search must drop documents whose `expires_at` is in the past. Returning the partial hash is how a failed answer write becomes a served answer.',
  ],
  checks: [
    {
      id: 'atomic-write',
      title: 'Writes the embedding and its answer in one atomic step',
      detail:
        'The entry is written by `PUT_ENTRY_SCRIPT` — one `HSET` carrying `embedding` and `answer` — run through a single `eval`/`Run`. Two separate `hset` calls can be interrupted between them, leaving an embedding with no answer for a later lookup to hit.',
      match: {
        python: {all: [/PUT_ENTRY_SCRIPT/, /\.eval\(/, /HSET/]},
        typescript: {all: [/PUT_ENTRY_SCRIPT/, /\.eval\(/, /HSET/]},
        go: {all: [/putEntryScript/, /\.Run\(/, /HSET/]},
        scala: {all: [/PutEntryScript/, /\.eval\(/, /HSET/]},
        cpp: {all: [/kPutEntryScript/, /\.eval</, /HSET/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the index per (tenant, model version)',
      detail:
        '`index_name(tenant, model_version)` returns `semantic:{tenant}:{model_version}`, so two tenants never share a vector space. The draft indexes everyone under the literal `semantic:all`, and a similar question from one tenant then surfaces another tenant’s answer.',
      match: {
        python: {all: [/def index_name\(tenant: str, model_version: str\)/, /semantic:\{tenant\}:\{model_version\}/]},
        typescript: {
          all: [
            /function indexName\(tenant: string, modelVersion: string\)/,
            /semantic:\$\{tenant\}:\$\{modelVersion\}/,
          ],
        },
        go: {all: [/func indexName\(tenant, modelVersion string\)/, /semantic:%s:%s/]},
        scala: {all: [/def indexName\(tenant: String, modelVersion: String\)/, /semantic:\$tenant:\$modelVersion/]},
        cpp: {all: [/"semantic:"/, /indexName\(tenant, modelVersion\)/]},
      },
    },
    {
      id: 'answer-required',
      title: 'An embedding without an answer is never a hit',
      detail:
        'The read path checks that the stored hash carries an `answer` and raises `IncompleteEntry` when it does not. The draft returns whatever the hash holds, so an interrupted write looks like a valid entry and its empty answer gets served.',
      match: {
        python: {all: [/raise IncompleteEntry\(/, /"answer" not in raw/]},
        typescript: {all: [/throw new IncompleteEntry\(/, /'answer' in raw|answer === undefined/]},
        go: {all: [/return nil, ErrIncompleteEntry/, /raw\["answer"\]/]},
        scala: {all: [/throw new IncompleteEntry\(/, /containsKey\("answer"\)/]},
        cpp: {all: [/throw IncompleteEntry\(/, /count\("answer"\)/]},
      },
    },
    {
      id: 'ttl',
      title: 'Entries expire',
      detail:
        'Every written entry is given `EXPIRE` with `ENTRY_TTL_SECONDS` (3600 s). An entry without an expiry outlives its model version and keeps being served long after the policy that produced it is gone.',
      match: {
        python: {all: [/EXPIRE/, /ENTRY_TTL_SECONDS/]},
        typescript: {all: [/EXPIRE/, /ENTRY_TTL_SECONDS/]},
        go: {all: [/EXPIRE/, /entryTtlSeconds/]},
        scala: {all: [/EXPIRE/, /EntryTtlSeconds/]},
        cpp: {all: [/EXPIRE/, /kEntryTtlSeconds/]},
      },
    },
    {
      id: 'disjoint-search',
      title: "A lookup only searches the caller's tenant/version index",
      detail:
        'The KNN query is issued against `index_name(tenant, model_version)`, never a global index, so a lookup can only ever return entries from the caller’s own vector space.',
      match: {
        python: {all: [/def search_entries\(/, /index_name\(tenant, model_version\)/]},
        typescript: {all: [/function searchEntries\(/, /indexName\(tenant, modelVersion\)/]},
        go: {all: [/func searchEntries\(/, /indexName\(tenant, modelVersion\)/]},
        scala: {all: [/def searchEntries\(/, /indexName\(tenant, modelVersion\)/]},
        cpp: {all: [/searchEntries\(/, /indexName\(tenant, modelVersion\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from redis.commands.search.query import Query

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ENTRY_TTL_SECONDS = 3600
HIT_FRESHNESS_SECONDS = 3600
SIMILARITY_FLOOR = 0.82
MAX_SIMILARITY_THRESHOLD = 0.99


class IncompleteEntry(Exception):
    pass


def index_name(tenant: str, model_version: str) -> str:
    # TODO: every tenant shares one vector space; scope the index per (tenant, model version) so a
    # similar question from one tenant cannot surface another tenant's answer.
    return "semantic:all"


def put_entry(tenant, model_version, entry_id, embedding, answer):
    # TODO: the embedding and the answer are two separate commands and nothing expires. One atomic
    # script must set both fields and the TTL together, so a crash cannot leave an embedding
    # without an answer.
    key = f"entry:{tenant}:{model_version}:{entry_id}"
    r.hset(key, "embedding", json.dumps(embedding))
    r.hset(key, "answer", answer)


def search_entries(tenant, model_version, embedding, threshold):
    # TODO: this searches the shared index and never skips entries whose expires_at has passed.
    query = Query("*=>[KNN 5 @embedding $vec AS score]").return_fields("answer", "expires_at").dialect(2)
    found = r.ft("semantic:all").search(query, query_params={"vec": json.dumps(embedding)}).docs
    return [{"entry_id": doc.id, "answer": doc.answer} for doc in found]


def get_entry(tenant, model_version, entry_id):
    key = f"entry:{tenant}:{model_version}:{entry_id}"
    raw = r.hgetall(key)
    if not raw:
        return None
    return {"embedding": raw.get("embedding"), "answer": raw.get("answer")}
`,
      solution: `import json
import time

import redis
from redis.commands.search.query import Query

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ENTRY_TTL_SECONDS = 3600
HIT_FRESHNESS_SECONDS = 3600
SIMILARITY_FLOOR = 0.82
MAX_SIMILARITY_THRESHOLD = 0.99

PUT_ENTRY_SCRIPT = """
redis.call('HSET', KEYS[1], 'embedding', ARGV[1], 'answer', ARGV[2], 'expires_at', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
"""


class IncompleteEntry(Exception):
    pass


def effective_threshold(threshold: float) -> float:
    """Clamp the caller's requested similarity into the serving policy's [floor, ceiling]."""
    return min(max(threshold, SIMILARITY_FLOOR), MAX_SIMILARITY_THRESHOLD)


def index_name(tenant: str, model_version: str) -> str:
    return f"semantic:{tenant}:{model_version}"


def put_entry(tenant, model_version, entry_id, embedding, answer):
    """Write the embedding, the answer and the entry's expiry in one atomic step."""
    key = f"entry:{tenant}:{model_version}:{entry_id}"
    expires_at = int(time.time()) + ENTRY_TTL_SECONDS
    r.eval(PUT_ENTRY_SCRIPT, 1, key, json.dumps(embedding), answer, expires_at, ENTRY_TTL_SECONDS)


def search_entries(tenant, model_version, embedding, threshold):
    """KNN against this tenant's index only, skipping entries whose expiry has passed."""
    index = index_name(tenant, model_version)
    floor = effective_threshold(threshold)
    now = time.time()
    query = Query("*=>[KNN 5 @embedding $vec AS score]").return_fields("answer", "expires_at").dialect(2)
    found = r.ft(index).search(query, query_params={"vec": json.dumps(embedding)}).docs
    return [
        {"entry_id": doc.id, "answer": doc.answer}
        for doc in found
        if float(doc.expires_at) > now and 1.0 - float(doc.score) >= floor
    ]


def get_entry(tenant, model_version, entry_id):
    """Return the entry, or raise when the hash exists without an answer."""
    key = f"entry:{tenant}:{model_version}:{entry_id}"
    raw = r.hgetall(key)
    if not raw:
        return None
    if "answer" not in raw:
        raise IncompleteEntry(f"entry {entry_id} has no answer")
    return {"embedding": raw.get("embedding"), "answer": raw["answer"]}
`,
    },
    typescript: {
      starter: `/** Cache store: a model-generated draft that writes the embedding and the answer as two commands. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

export const ENTRY_TTL_SECONDS = 3600;
export const HIT_FRESHNESS_SECONDS = 3600;
export const SIMILARITY_FLOOR = 0.82;
export const MAX_SIMILARITY_THRESHOLD = 0.99;

export interface CacheEntry {
  entry_id: string;
  answer: string;
}

export class IncompleteEntry extends Error {}

export function indexName(tenant: string, modelVersion: string): string {
  // TODO: every tenant shares one vector space; scope the index per (tenant, model version) so a
  // similar question from one tenant cannot surface another tenant's answer.
  return 'semantic:all';
}

export async function putEntry(
  tenant: string,
  modelVersion: string,
  entryId: string,
  embedding: number[],
  answer: string,
): Promise<void> {
  // TODO: the embedding and the answer are two separate commands and nothing expires. One atomic
  // script must set both fields and the TTL together, so a crash cannot leave an embedding
  // without an answer.
  const key = \`entry:\${tenant}:\${modelVersion}:\${entryId}\`;
  await r.hset(key, 'embedding', JSON.stringify(embedding));
  await r.hset(key, 'answer', answer);
}

export async function searchEntries(
  tenant: string,
  modelVersion: string,
  embedding: number[],
  threshold: number,
): Promise<CacheEntry[]> {
  // TODO: this searches the shared index and never skips entries whose expires_at has passed.
  const reply = (await r.call(
    'FT.SEARCH',
    'semantic:all',
    '*=>[KNN 5 @embedding $vec AS score]',
    'PARAMS',
    '2',
    'vec',
    JSON.stringify(embedding),
    'RETURN',
    '2',
    'answer',
    'expires_at',
    'DIALECT',
    '2',
  )) as unknown[];
  return reply as CacheEntry[];
}

export async function getEntry(
  tenant: string,
  modelVersion: string,
  entryId: string,
): Promise<CacheEntry | null> {
  const key = \`entry:\${tenant}:\${modelVersion}:\${entryId}\`;
  const raw = await r.hgetall(key);
  if (Object.keys(raw).length === 0) return null;
  return {entry_id: entryId, answer: raw.answer};
}
`,
      solution: `/** Cache store: one atomic script per entry, an index scoped to the tenant and model version. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

export const ENTRY_TTL_SECONDS = 3600;
export const HIT_FRESHNESS_SECONDS = 3600;
export const SIMILARITY_FLOOR = 0.82;
export const MAX_SIMILARITY_THRESHOLD = 0.99;

const PUT_ENTRY_SCRIPT = \`
redis.call('HSET', KEYS[1], 'embedding', ARGV[1], 'answer', ARGV[2], 'expires_at', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
\`;

export interface CacheEntry {
  entry_id: string;
  answer: string;
}

export class IncompleteEntry extends Error {}

export function effectiveThreshold(threshold: number): number {
  return Math.min(Math.max(threshold, SIMILARITY_FLOOR), MAX_SIMILARITY_THRESHOLD);
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
): Promise<void> {
  const key = \`entry:\${tenant}:\${modelVersion}:\${entryId}\`;
  const expiresAt = Math.floor(Date.now() / 1000) + ENTRY_TTL_SECONDS;
  await r.eval(
    PUT_ENTRY_SCRIPT,
    1,
    key,
    JSON.stringify(embedding),
    answer,
    String(expiresAt),
    String(ENTRY_TTL_SECONDS),
  );
}

export async function searchEntries(
  tenant: string,
  modelVersion: string,
  embedding: number[],
  threshold: number,
): Promise<CacheEntry[]> {
  const index = indexName(tenant, modelVersion);
  const floor = effectiveThreshold(threshold);
  const now = Math.floor(Date.now() / 1000);
  const reply = (await r.call(
    'FT.SEARCH',
    index,
    '*=>[KNN 5 @embedding $vec AS score]',
    'PARAMS',
    '2',
    'vec',
    JSON.stringify(embedding),
    'RETURN',
    '3',
    'answer',
    'expires_at',
    'score',
    'DIALECT',
    '2',
  )) as unknown[];
  return reply as CacheEntry[];
}

export async function getEntry(
  tenant: string,
  modelVersion: string,
  entryId: string,
): Promise<CacheEntry | null> {
  const key = \`entry:\${tenant}:\${modelVersion}:\${entryId}\`;
  const raw = await r.hgetall(key);
  if (Object.keys(raw).length === 0) return null;
  if (!('answer' in raw)) throw new IncompleteEntry(\`entry \${entryId} has no answer\`);
  return {entry_id: entryId, answer: raw.answer};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	entryTtlSeconds        = 3600
	hitFreshnessSeconds    = 3600
	similarityFloor        = 0.82
	maxSimilarityThreshold = 0.99
)

var (
	rdb                *redis.Client
	ErrIncompleteEntry = errors.New("entry has no answer")
)

// CacheEntry is one cached answer as the search returns it.
type CacheEntry struct {
	EntryID   string
	Answer    string
	ExpiresAt float64
	Score     float64
}

func indexName(tenant, modelVersion string) string {
	// TODO: every tenant shares one vector space; scope the index per (tenant, model version) so a
	// similar question from one tenant cannot surface another tenant's answer.
	return "semantic:all"
}

func putEntry(ctx context.Context, tenant, modelVersion, entryID string, embedding []float64, answer string) error {
	// TODO: the embedding and the answer are two separate commands and nothing expires. One atomic
	// script must set both fields and the TTL together, so a crash cannot leave an embedding
	// without an answer.
	key := fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID)
	raw, _ := json.Marshal(embedding)
	rdb.HSet(ctx, key, "embedding", raw)
	rdb.HSet(ctx, key, "answer", answer)
	return nil
}

func searchEntries(ctx context.Context, tenant, modelVersion string, embedding []float64, threshold float64) ([]CacheEntry, error) {
	// TODO: this searches the shared index and never skips entries whose expires_at has passed.
	raw, _ := json.Marshal(embedding)
	reply, err := rdb.Do(ctx, "FT.SEARCH", "semantic:all", "*=>[KNN 5 @embedding $vec AS score]",
		"PARAMS", "2", "vec", string(raw), "RETURN", "2", "answer", "expires_at", "DIALECT", "2").Result()
	if err != nil {
		return nil, err
	}
	return parseHits(reply), nil
}

func getEntry(ctx context.Context, tenant, modelVersion, entryID string) (*CacheEntry, error) {
	key := fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID)
	raw, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	return &CacheEntry{EntryID: entryID, Answer: raw["answer"]}, nil
}

// parseHits flattens the FT.SEARCH reply into one CacheEntry per document.
func parseHits(reply any) []CacheEntry {
	rows, ok := reply.([]any)
	if !ok || len(rows) < 2 {
		return nil
	}
	hits := make([]CacheEntry, 0, len(rows)/2)
	for i := 1; i+1 < len(rows); i += 2 {
		id, _ := rows[i].(string)
		fields, ok := rows[i+1].([]any)
		if !ok {
			continue
		}
		entry := CacheEntry{EntryID: id}
		for j := 0; j+1 < len(fields); j += 2 {
			name, _ := fields[j].(string)
			value, _ := fields[j+1].(string)
			switch name {
			case "answer":
				entry.Answer = value
			case "expires_at":
				entry.ExpiresAt, _ = strconv.ParseFloat(value, 64)
			case "score":
				entry.Score, _ = strconv.ParseFloat(value, 64)
			}
		}
		hits = append(hits, entry)
	}
	return hits
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	entryTtlSeconds        = 3600
	hitFreshnessSeconds    = 3600
	similarityFloor        = 0.82
	maxSimilarityThreshold = 0.99
)

var (
	rdb                *redis.Client
	ErrIncompleteEntry = errors.New("entry has no answer")
)

// putEntryScript writes the embedding, the answer and the entry's expiry in one step.
var putEntryScript = redis.NewScript(\`
redis.call('HSET', KEYS[1], 'embedding', ARGV[1], 'answer', ARGV[2], 'expires_at', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
\`)

// CacheEntry is one cached answer as the search returns it.
type CacheEntry struct {
	EntryID   string
	Answer    string
	ExpiresAt float64
	Score     float64
}

func indexName(tenant, modelVersion string) string {
	return fmt.Sprintf("semantic:%s:%s", tenant, modelVersion)
}

func effectiveThreshold(threshold float64) float64 {
	return math.Min(math.Max(threshold, similarityFloor), maxSimilarityThreshold)
}

func putEntry(ctx context.Context, tenant, modelVersion, entryID string, embedding []float64, answer string) error {
	key := fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID)
	expiresAt := time.Now().Unix() + entryTtlSeconds
	raw, err := json.Marshal(embedding)
	if err != nil {
		return err
	}
	return putEntryScript.Run(ctx, rdb, []string{key}, string(raw), answer, expiresAt, entryTtlSeconds).Err()
}

func searchEntries(ctx context.Context, tenant, modelVersion string, embedding []float64, threshold float64) ([]CacheEntry, error) {
	index := indexName(tenant, modelVersion)
	floor := effectiveThreshold(threshold)
	now := float64(time.Now().Unix())
	raw, err := json.Marshal(embedding)
	if err != nil {
		return nil, err
	}
	reply, err := rdb.Do(ctx, "FT.SEARCH", index, "*=>[KNN 5 @embedding $vec AS score]",
		"PARAMS", "2", "vec", string(raw), "RETURN", "3", "answer", "expires_at", "score", "DIALECT", "2").Result()
	if err != nil {
		return nil, err
	}
	hits := make([]CacheEntry, 0)
	for _, hit := range parseHits(reply) {
		if hit.ExpiresAt > now && 1.0-hit.Score >= floor {
			hits = append(hits, hit)
		}
	}
	return hits, nil
}

func getEntry(ctx context.Context, tenant, modelVersion, entryID string) (*CacheEntry, error) {
	key := fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID)
	raw, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	answer, ok := raw["answer"]
	if !ok {
		return nil, ErrIncompleteEntry
	}
	return &CacheEntry{EntryID: entryID, Answer: answer}, nil
}

// parseHits flattens the FT.SEARCH reply into one CacheEntry per document.
func parseHits(reply any) []CacheEntry {
	rows, ok := reply.([]any)
	if !ok || len(rows) < 2 {
		return nil
	}
	hits := make([]CacheEntry, 0, len(rows)/2)
	for i := 1; i+1 < len(rows); i += 2 {
		id, _ := rows[i].(string)
		fields, ok := rows[i+1].([]any)
		if !ok {
			continue
		}
		entry := CacheEntry{EntryID: id}
		for j := 0; j+1 < len(fields); j += 2 {
			name, _ := fields[j].(string)
			value, _ := fields[j+1].(string)
			switch name {
			case "answer":
				entry.Answer = value
			case "expires_at":
				entry.ExpiresAt, _ = strconv.ParseFloat(value, 64)
			case "score":
				entry.Score, _ = strconv.ParseFloat(value, 64)
			}
		}
		hits = append(hits, entry)
	}
	return hits
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object CacheStore {
  val EntryTtlSeconds = 3600L
  val HitFreshnessSeconds = 3600L
  val SimilarityFloor = 0.82
  val MaxSimilarityThreshold = 0.99

  final class IncompleteEntry(message: String) extends RuntimeException(message)

  final case class CacheEntry(entry_id: String, answer: String)

  val jedis = new Jedis("redis", 6379)

  // TODO: every tenant shares one vector space; scope the index per (tenant, model version) so a
  // similar question from one tenant cannot surface another tenant's answer.
  def indexName(tenant: String, modelVersion: String): String = "semantic:all"

  // TODO: the embedding and the answer are two separate commands and nothing expires. One atomic
  // script must set both fields and the TTL together, so a crash cannot leave an embedding
  // without an answer.
  def putEntry(tenant: String, modelVersion: String, entryId: String, embedding: Seq[Double], answer: String): Unit = {
    val key = s"entry:$tenant:$modelVersion:$entryId"
    jedis.hset(key, "embedding", embedding.mkString(","))
    jedis.hset(key, "answer", answer)
  }

  // TODO: this searches the shared index and never skips entries whose expires_at has passed.
  def searchEntries(tenant: String, modelVersion: String, embedding: Seq[Double], threshold: Double): Seq[CacheEntry] = {
    val result = jedis.ftSearch("semantic:all", "*=>[KNN 5 @embedding $vec AS score]")
    result.getDocuments.asScala.map(doc => CacheEntry(doc.getId, doc.getString("answer"))).toSeq
  }

  def getEntry(tenant: String, modelVersion: String, entryId: String): Option[CacheEntry] = {
    val key = s"entry:$tenant:$modelVersion:$entryId"
    val raw = jedis.hgetAll(key).asScala
    if (raw.isEmpty) None else Some(CacheEntry(entryId, raw.getOrElse("answer", "")))
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object CacheStore {
  val EntryTtlSeconds = 3600L
  val HitFreshnessSeconds = 3600L
  val SimilarityFloor = 0.82
  val MaxSimilarityThreshold = 0.99

  final class IncompleteEntry(message: String) extends RuntimeException(message)

  final case class CacheEntry(entry_id: String, answer: String)

  val jedis = new Jedis("redis", 6379)

  // PutEntryScript writes the embedding, the answer and the entry's expiry in one step.
  val PutEntryScript =
    """
      |redis.call('HSET', KEYS[1], 'embedding', ARGV[1], 'answer', ARGV[2], 'expires_at', ARGV[3])
      |redis.call('EXPIRE', KEYS[1], ARGV[4])
      |return 1
      |""".stripMargin

  def effectiveThreshold(threshold: Double): Double =
    math.min(math.max(threshold, SimilarityFloor), MaxSimilarityThreshold)

  def indexName(tenant: String, modelVersion: String): String =
    s"semantic:$tenant:$modelVersion"

  def putEntry(tenant: String, modelVersion: String, entryId: String, embedding: Seq[Double], answer: String): Unit = {
    val key = s"entry:$tenant:$modelVersion:$entryId"
    val expiresAt = System.currentTimeMillis() / 1000 + EntryTtlSeconds
    jedis.eval(
      PutEntryScript,
      1,
      key,
      embedding.mkString(","),
      answer,
      expiresAt.toString,
      EntryTtlSeconds.toString
    )
  }

  def searchEntries(tenant: String, modelVersion: String, embedding: Seq[Double], threshold: Double): Seq[CacheEntry] = {
    val index = indexName(tenant, modelVersion)
    val floor = effectiveThreshold(threshold)
    val now = System.currentTimeMillis() / 1000
    val result = jedis.ftSearch(index, "*=>[KNN 5 @embedding $vec AS score]")
    result.getDocuments.asScala
      .filter(doc => Option(doc.getString("expires_at")).forall(_.toLong > now))
      .map(doc => CacheEntry(doc.getId, doc.getString("answer")))
      .toSeq
      .filter(_.answer.nonEmpty)
  }

  def getEntry(tenant: String, modelVersion: String, entryId: String): Option[CacheEntry] = {
    val key = s"entry:$tenant:$modelVersion:$entryId"
    val raw = jedis.hgetAll(key).asScala
    if (raw.isEmpty) None
    else if (!raw.containsKey("answer")) throw new IncompleteEntry(s"entry $entryId has no answer")
    else Some(CacheEntry(entryId, raw("answer")))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kEntryTtlSeconds = 3600;
constexpr long long kHitFreshnessSeconds = 3600;
constexpr double kSimilarityFloor = 0.82;
constexpr double kMaxSimilarityThreshold = 0.99;

struct IncompleteEntry : std::runtime_error {
  explicit IncompleteEntry(const std::string& message) : std::runtime_error(message) {}
};

struct CacheEntry {
  std::string entry_id;
  std::string answer;
  long long expires_at = 0;
  double score = 0.0;
};

std::string indexName(const std::string& tenant, const std::string& modelVersion) {
  // TODO: every tenant shares one vector space; scope the index per (tenant, model version) so a
  // similar question from one tenant cannot surface another tenant's answer.
  return "semantic:all";
}

void putEntry(sw::redis::Redis& redis, const std::string& tenant, const std::string& modelVersion,
              const std::string& entryId, const std::vector<double>& embedding, const std::string& answer) {
  // TODO: the embedding and the answer are two separate commands and nothing expires. One atomic
  // script must set both fields and the TTL together, so a crash cannot leave an embedding
  // without an answer.
  const auto key = "entry:" + tenant + ":" + modelVersion + ":" + entryId;
  redis.hset(key, "embedding", json(embedding).dump());
  redis.hset(key, "answer", answer);
}

// parseHits flattens the FT.SEARCH reply into one CacheEntry per document.
std::vector<CacheEntry> parseHits(redisReply* raw) {
  std::vector<CacheEntry> hits;
  if (raw == nullptr || raw->type != REDIS_REPLY_ARRAY) return hits;
  for (size_t i = 1; i + 1 < raw->elements; i += 2) {
    CacheEntry entry;
    if (raw->element[i]->type == REDIS_REPLY_STRING) entry.entry_id = raw->element[i]->str;
    redisReply* fields = raw->element[i + 1];
    if (fields->type != REDIS_REPLY_ARRAY) continue;
    for (size_t j = 0; j + 1 < fields->elements; j += 2) {
      const std::string name = fields->element[j]->str;
      const std::string value = fields->element[j + 1]->str;
      if (name == "answer") entry.answer = value;
      if (name == "expires_at") entry.expires_at = std::stoll(value);
      if (name == "score") entry.score = std::stod(value);
    }
    hits.push_back(entry);
  }
  return hits;
}

std::vector<CacheEntry> searchEntries(sw::redis::Redis& redis, const std::string& tenant,
                                      const std::string& modelVersion, const std::vector<double>& embedding,
                                      double threshold) {
  // TODO: this searches the shared index and never skips entries whose expires_at has passed.
  const auto reply = redis.command("FT.SEARCH", "semantic:all", "*=>[KNN 5 @embedding $vec AS score]",
                                   "PARAMS", "2", "vec", json(embedding).dump(),
                                   "RETURN", "2", "answer", "expires_at", "DIALECT", "2");
  return parseHits(reply.get());
}

CacheEntry getEntry(sw::redis::Redis& redis, const std::string& tenant, const std::string& modelVersion,
                    const std::string& entryId) {
  const auto key = "entry:" + tenant + ":" + modelVersion + ":" + entryId;
  const auto raw = redis.hgetall(key);
  const auto it = raw.find("answer");
  return CacheEntry{entryId, it == raw.end() ? std::string() : it->second};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kEntryTtlSeconds = 3600;
constexpr long long kHitFreshnessSeconds = 3600;
constexpr double kSimilarityFloor = 0.82;
constexpr double kMaxSimilarityThreshold = 0.99;

// kPutEntryScript writes the embedding, the answer and the entry's expiry in one step.
const char* kPutEntryScript = R"LUA(
redis.call('HSET', KEYS[1], 'embedding', ARGV[1], 'answer', ARGV[2], 'expires_at', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
)LUA";

struct IncompleteEntry : std::runtime_error {
  explicit IncompleteEntry(const std::string& message) : std::runtime_error(message) {}
};

struct CacheEntry {
  std::string entry_id;
  std::string answer;
  long long expires_at = 0;
  double score = 0.0;
};

double effectiveThreshold(double threshold) {
  return std::min(std::max(threshold, kSimilarityFloor), kMaxSimilarityThreshold);
}

std::string indexName(const std::string& tenant, const std::string& modelVersion) {
  return "semantic:" + tenant + ":" + modelVersion;
}

void putEntry(sw::redis::Redis& redis, const std::string& tenant, const std::string& modelVersion,
              const std::string& entryId, const std::vector<double>& embedding, const std::string& answer) {
  const auto key = "entry:" + tenant + ":" + modelVersion + ":" + entryId;
  const auto expiresAt = std::chrono::duration_cast<std::chrono::seconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() +
                         kEntryTtlSeconds;
  redis.eval<long long>(kPutEntryScript, {key},
                        {json(embedding).dump(), answer, std::to_string(expiresAt),
                         std::to_string(kEntryTtlSeconds)});
}

// parseHits flattens the FT.SEARCH reply into one CacheEntry per document.
std::vector<CacheEntry> parseHits(redisReply* raw) {
  std::vector<CacheEntry> hits;
  if (raw == nullptr || raw->type != REDIS_REPLY_ARRAY) return hits;
  for (size_t i = 1; i + 1 < raw->elements; i += 2) {
    CacheEntry entry;
    if (raw->element[i]->type == REDIS_REPLY_STRING) entry.entry_id = raw->element[i]->str;
    redisReply* fields = raw->element[i + 1];
    if (fields->type != REDIS_REPLY_ARRAY) continue;
    for (size_t j = 0; j + 1 < fields->elements; j += 2) {
      const std::string name = fields->element[j]->str;
      const std::string value = fields->element[j + 1]->str;
      if (name == "answer") entry.answer = value;
      if (name == "expires_at") entry.expires_at = std::stoll(value);
      if (name == "score") entry.score = std::stod(value);
    }
    hits.push_back(entry);
  }
  return hits;
}

std::vector<CacheEntry> searchEntries(sw::redis::Redis& redis, const std::string& tenant,
                                      const std::string& modelVersion, const std::vector<double>& embedding,
                                      double threshold) {
  const auto index = indexName(tenant, modelVersion);
  const auto floor = effectiveThreshold(threshold);
  const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
  const auto reply = redis.command("FT.SEARCH", index, "*=>[KNN 5 @embedding $vec AS score]",
                                   "PARAMS", "2", "vec", json(embedding).dump(),
                                   "RETURN", "3", "answer", "expires_at", "score", "DIALECT", "2");
  std::vector<CacheEntry> hits;
  for (const auto& hit : parseHits(reply.get())) {
    if (hit.expires_at > now && 1.0 - hit.score >= floor) hits.push_back(hit);
  }
  return hits;
}

CacheEntry getEntry(sw::redis::Redis& redis, const std::string& tenant, const std::string& modelVersion,
                    const std::string& entryId) {
  const auto key = "entry:" + tenant + ":" + modelVersion + ":" + entryId;
  const auto raw = redis.hgetall(key);
  if (raw.count("answer") == 0) throw IncompleteEntry("entry " + entryId + " has no answer");
  return CacheEntry{entryId, raw.at("answer")};
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated cache at its three failure seams: the write, the key, and the read. The draft passes every serial test because one tenant, one question and one healthy write is the whole demo. Atomicity is the seam candidates miss — two \`HSET\`s are two round trips, and the window between them is exactly where a crash turns an embedding into a hit with no answer. Tenancy is the seam that turns a cache into a data leak: one global index means the nearest neighbour of a tenant's question can be another tenant's answer, and a KNN result carries no tenant label to check afterwards. The read path is the third seam: a hash is not an entry, so the guard on \`answer\` is what makes "half-written" observable instead of silently served. Real systems add an \`expires_at\` field beside the key TTL so a stale document can be dropped even if Redis has not evicted it yet, per-model-version index aliases so a model rollout gets a clean vector space, and a background compaction job that re-indexes after an embedding model change.`,
};
