import type {Step} from '@/lib/types';

export const hybridRetrieveStep: Step = {
  id: 'hybrid-retrieve',
  title: 'Hybrid retrieval: tenant scope, RRF, citations',
  concept: 'redis',
  file: 'retrieve',
  focus: ['client', 'api', 'redis', 'embed'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it compiles and passes the
happy path, so a quick demo makes it look done. Review it like the service owner. Find the subtle
flaw, fix it, and prove the fix with the checks below.

Implement \`retrieve(tenant, query, k)\`. It returns \`{"chunks": [...], "citations": [...]}\` for the
answer step.

- **Lexical candidates** come from the tenant's own Redis sorted set, \`rag:lex:{tenant}\`. **Vector
  candidates** come from the vector index, filtered by tenant before ranking. A global index makes
  one tenant's documents answer another tenant's question.
- Merge the two ranked lists with **reciprocal rank fusion** (\`1 / (60 + rank)\`, rank starting at
  1) and dedupe by \`chunk_id\`. A chunk that appears in both lists keeps one fused score.
- Cap \`k\` at **20**; a caller may ask for fewer, never for more.
- Every citation carries \`doc_id\`, \`chunk_id\`, \`start\` and \`end\` — the offsets are what lets the UI
  highlight the supporting span and what the answer step later validates quotes against.
- Cache the final result under \`rag:q:{tenant}:{sha256(query)}\` for **60 seconds**. A cache key
  without the tenant is a cross-tenant leak even when the retrieval logic is scoped.

**Failure mode the checks target.** The draft searches a global lexical set and a global vector
index, then returns the model's chunk ids with no offsets. The demo passes because there is one
tenant and one document; the second tenant gets the first tenant's data.

:::widget cache-aside {}

> Filter before rank, not after: post-filtering a global top-20 can leave a tenant with zero
> candidates while another tenant's chunks occupied every slot.`,
  sequence: {
    participants: ['Client', 'RAG API', 'Redis index', 'Embedding service'],
    messages: [
      {from: 'Client', to: 'RAG API', label: 'POST /v1/answer {query, k}', kind: 'sync'},
      {from: 'RAG API', to: 'Redis index', label: 'GET rag:q:{tenant}:{sha(query)}', kind: 'sync'},
      {from: 'Redis index', to: 'RAG API', label: 'miss', kind: 'reply'},
      {from: 'RAG API', to: 'Embedding service', label: 'Embed(query)', kind: 'sync'},
      {from: 'RAG API', to: 'Redis index', label: 'ZREVRANGE rag:lex:{tenant}', kind: 'sync'},
      {from: 'RAG API', to: 'Redis index', label: 'vector search, tenant filter', kind: 'sync'},
      {from: 'RAG API', to: 'RAG API', label: 'RRF merge · dedupe · cap 20', kind: 'sync'},
      {from: 'RAG API', to: 'Redis index', label: 'SETEX 60s', kind: 'async'},
      {from: 'RAG API', to: 'Client', label: 'chunks + citations {start, end}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'tenant-scope',
      title: 'Reads and filters per tenant',
      detail:
        'The lexical set is `rag:lex:{tenant}` and vector hits are filtered by `tenant` before ranking. A global index leaks one tenant’s documents into another tenant’s answer.',
      match: {
        python: {all: [/rag:lex:.*tenant|rag:lex:\{tenant/, /hit\["tenant"\]\s*==\s*tenant|VECTORS\.search\(tenant/]},
        typescript: {
          all: [/rag:lex:.*tenant|rag:lex:\$\{tenant\}/, /hit\.tenant\s*===?\s*tenant|VECTORS\.search\(tenant/],
        },
        go: {
          all: [
            /rag:lex:"\s*\+\s*tenant|fmt\.Sprintf\("rag:lex:%s", tenant\)/,
            /hit\.Tenant != tenant|VECTORS\.Search\(ctx, tenant/,
          ],
        },
        scala: {all: [/rag:lex:" \+ tenant/, /\.tenant == tenant|VECTORS\.search\(tenant/]},
        cpp: {all: [/rag:lex:" \+ tenant/, /hit\.tenant != tenant|VECTORS\.search\(tenant/]},
      },
    },
    {
      id: 'k-cap',
      title: 'Caps k at 20',
      detail:
        'Compute `min(k, 20)`; a caller asking for 500 must get at most 20 candidates. The draft forwards the caller value.',
      match: {
        python: {all: [/(min\(k|k\s*=\s*min|math\.min|std::min)/, /MAX_K|\b20\b/]},
        typescript: {
          all: [/(Math\.min\(\s*k|Math\.min\(\s*MAX_K|k\s*=\s*Math\.min)/, /MAX_K\s*=\s*20|\b20\b/],
        },
        go: {all: [/(if k > maxK|min\(k|maxK)/, /maxK\s*=\s*20|\b20\b/]},
        scala: {all: [/(math\.min\(k|if \(k > MaxK\))/, /MaxK\s*=\s*20|\b20\b/]},
        cpp: {all: [/(std::min\(k|min\(k)/, /kMaxK\s*=\s*20|\b20\b/]},
      },
    },
    {
      id: 'rrf-merge',
      title: 'Fuses the two lists with RRF',
      detail:
        'Rank each list from 1 and sum `1/(60+rank)` into a per-chunk score. Concatenating the lists lets one retriever’s ordering dominate and does not reward agreement.',
      match: {
        python: {all: [/(RRF|rrf|reciprocal)/, /(rank|Rank)/]},
        typescript: {all: [/(RRF_K|rrf|reciprocal)/, /(rank|Rank)/]},
        go: {all: [/(rrfK|rrf|reciprocal)/, /(rank|Rank|i \+ 1)/]},
        scala: {all: [/(RrfK|rrf|reciprocal)/, /(rank|Rank)/]},
        cpp: {all: [/(kRrfK|rrf|reciprocal)/, /(rank|Rank)/]},
      },
    },
    {
      id: 'citation-offsets',
      title: 'Returns citations with real offsets',
      detail:
        'Each citation contains `doc_id`, `chunk_id`, and numeric `start`/`end` offsets. Without offsets the answer step cannot verify a quote or highlight the source.',
      match: {
        python: {all: [/(citation|Citation)/, /\bstart\b/, /\bend\b/]},
        typescript: {all: [/(citation|Citation)/, /\bstart\b/, /\bend\b/]},
        go: {all: [/(Citation)/, /\bStart\b/, /\bEnd\b/]},
        scala: {all: [/(Citation)/, /\bstart\b/, /\bend\b/]},
        cpp: {all: [/(Citation|citation)/, /"start"|\bstart\b/, /"end"|\bend\b/]},
      },
    },
    {
      id: 'cache-ttl',
      title: 'Caches per tenant for 60 seconds',
      detail:
        'The key is `rag:q:{tenant}:{sha256(query)}` and the TTL is 60 seconds. A tenant-less key serves one tenant’s retrieval to another.',
      match: {
        python: {all: [/(rag:q:[\s\S]{0,100}tenant|tenant[\s\S]{0,100}rag:q:)/, /ex\s*=\s*(?:CACHE_TTL_S|60)/]},
        typescript: {
          all: [
            /rag:q:.*tenant|tenant.*rag:q:/,
            /(CACHE_TTL_S\s*=\s*60|['"]EX['"]\s*,\s*CACHE_TTL_S|ex\s*:\s*CACHE_TTL_S)/,
          ],
        },
        go: {all: [/(rag:q:.*tenant|tenant.*rag:q:)/, /(cacheTTL|60\s*\*\s*time\.Second)/]},
        scala: {all: [/(rag:q:.*tenant|tenant.*rag:q:)/, /setex\([^)]*CacheTtl|CacheTtl\s*=\s*60/]},
        cpp: {all: [/(rag:q:.*tenant|tenant.*rag:q:)/, /kCacheTtl\s*=\s*60|setex\([^;]*kCacheTtl/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json

from redis import Redis

from rag.embedding import embed_query
from rag.vectors import VECTORS

redis = Redis(host="redis", port=6379)


def retrieve(tenant: str, query: str, k: int = 10) -> dict:
    cache_key = f"rag:q:{hashlib.sha256(query.encode()).hexdigest()}"
    cached = redis.get(cache_key)
    if cached is not None:
        return json.loads(cached)

    lexical = redis.zrevrange("rag:lex", 0, 19)
    vector_hits = VECTORS.search(embed_query(query), 20)
    merged = []
    seen = set()
    for raw in lexical:
        hit = json.loads(raw)
        if hit["chunk_id"] not in seen:
            seen.add(hit["chunk_id"])
            merged.append(hit)
    for hit in vector_hits:
        if hit["chunk_id"] not in seen:
            seen.add(hit["chunk_id"])
            merged.append(hit)

    # TODO: global lexical set, no tenant filter on vectors, no citation offsets,
    # no k cap and a five-minute cache key without the tenant.
    result = {
        "chunks": [hit["text"] for hit in merged[:k]],
        "citations": [{"doc_id": hit["doc_id"], "chunk_id": hit["chunk_id"]} for hit in merged[:k]],
    }
    redis.set(cache_key, json.dumps(result), ex=300)
    return result
`,
      solution: `import hashlib
import json

from redis import Redis

from rag.embedding import embed_query
from rag.vectors import VECTORS

RRF_K = 60
MAX_K = 20
CACHE_TTL_S = 60
redis = Redis(host="redis", port=6379)


def retrieve(tenant: str, query: str, k: int = 10) -> dict:
    k = min(k, MAX_K)
    cache_key = f"rag:q:{tenant}:{hashlib.sha256(query.encode()).hexdigest()}"
    cached = redis.get(cache_key)
    if cached is not None:
        return json.loads(cached)

    lexical = [json.loads(raw) for raw in redis.zrevrange(f"rag:lex:{tenant}", 0, MAX_K - 1)]
    vector_hits = [
        hit
        for hit in VECTORS.search(tenant, embed_query(query), MAX_K)
        if hit["tenant"] == tenant
    ]

    scores: dict[str, float] = {}
    by_id: dict[str, dict] = {}
    for ranked in (lexical, vector_hits):
        for rank, hit in enumerate(ranked, start=1):
            cid = hit["chunk_id"]
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank)
            by_id[cid] = hit

    ordered = sorted(scores, key=scores.get, reverse=True)[:k]
    result = {
        "chunks": [by_id[cid]["text"] for cid in ordered],
        "citations": [
            {
                "doc_id": by_id[cid]["doc_id"],
                "chunk_id": cid,
                "start": by_id[cid]["start"],
                "end": by_id[cid]["end"],
            }
            for cid in ordered
        ],
    }
    redis.set(cache_key, json.dumps(result), ex=CACHE_TTL_S)
    return result
`,
    },
    typescript: {
      starter: `/** Hybrid retrieval: a model-generated draft that concatenates a global lexical list and vector hits. */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {embedQuery} from './embedding';
import {VECTORS} from './vectors';

const redis = new Redis({host: 'redis', port: 6379});

interface Hit {
  tenant: string;
  doc_id: string;
  chunk_id: string;
  text: string;
}

interface Retrieval {
  chunks: string[];
  citations: {doc_id: string; chunk_id: string}[];
}

export async function retrieve(tenant: string, query: string, k = 10): Promise<Retrieval> {
  const cacheKey = \`rag:q:\${createHash('sha256').update(query).digest('hex')}\`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) return JSON.parse(cached) as Retrieval;

  const lexical = (await redis.zrevrange('rag:lex', 0, 19)).map(raw => JSON.parse(raw) as Hit);
  const vectorHits = await VECTORS.search(embedQuery(query), 20);
  const merged: Hit[] = [];
  const seen = new Set<string>();
  for (const hit of [...lexical, ...vectorHits]) {
    if (seen.has(hit.chunk_id)) continue;
    seen.add(hit.chunk_id);
    merged.push(hit);
  }

  // TODO: a global lexical set, no tenant filter on vectors, no citation offsets,
  // no k cap and a five-minute cache key without the tenant.
  const result: Retrieval = {
    chunks: merged.slice(0, k).map(hit => hit.text),
    citations: merged.slice(0, k).map(hit => ({doc_id: hit.doc_id, chunk_id: hit.chunk_id})),
  };
  await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
  return result;
}
`,
      solution: `/** Hybrid retrieval: tenant-scoped lexical + vector candidates, fused with RRF, citations with offsets. */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {embedQuery} from './embedding';
import {VECTORS} from './vectors';

const RRF_K = 60;
const MAX_K = 20;
const CACHE_TTL_S = 60;
const redis = new Redis({host: 'redis', port: 6379});

interface Hit {
  tenant: string;
  doc_id: string;
  chunk_id: string;
  text: string;
  start: number;
  end: number;
}

interface Citation {
  doc_id: string;
  chunk_id: string;
  start: number;
  end: number;
}

interface Retrieval {
  chunks: string[];
  citations: Citation[];
}

export async function retrieve(tenant: string, query: string, k = 10): Promise<Retrieval> {
  const capped = Math.min(k, MAX_K);
  const cacheKey = \`rag:q:\${tenant}:\${createHash('sha256').update(query).digest('hex')}\`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) return JSON.parse(cached) as Retrieval;

  const lexical = (await redis.zrevrange(\`rag:lex:\${tenant}\`, 0, MAX_K - 1)).map(raw => JSON.parse(raw) as Hit);
  const vectorHits = (await VECTORS.search(tenant, embedQuery(query), MAX_K)).filter(hit => hit.tenant === tenant);

  const scores = new Map<string, number>();
  const byId = new Map<string, Hit>();
  for (const ranked of [lexical, vectorHits]) {
    ranked.forEach((hit, i) => {
      const rank = i + 1;
      scores.set(hit.chunk_id, (scores.get(hit.chunk_id) ?? 0) + 1 / (RRF_K + rank));
      byId.set(hit.chunk_id, hit);
    });
  }

  const ordered = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, capped)
    .map(([cid]) => byId.get(cid)!);
  const result: Retrieval = {
    chunks: ordered.map(hit => hit.text),
    citations: ordered.map(hit => ({
      doc_id: hit.doc_id,
      chunk_id: hit.chunk_id,
      start: hit.start,
      end: hit.end,
    })),
  };
  await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_S);
  return result;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

var redisClient = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Hit struct {
	DocID   string  \`json:"doc_id"\`
	ChunkID string  \`json:"chunk_id"\`
	Tenant  string  \`json:"tenant"\`
	Text    string  \`json:"text"\`
	Score   float64 \`json:"score"\`
}

type Citation struct {
	DocID   string \`json:"doc_id"\`
	ChunkID string \`json:"chunk_id"\`
}

type Result struct {
	Chunks    []string   \`json:"chunks"\`
	Citations []Citation \`json:"citations"\`
}

func retrieve(ctx context.Context, tenant, query string, k int) (Result, error) {
	sum := sha256.Sum256([]byte(query))
	cacheKey := "rag:q:" + hex.EncodeToString(sum[:])
	if cached, err := redisClient.Get(ctx, cacheKey).Result(); err == nil {
		var out Result
		json.Unmarshal([]byte(cached), &out)
		return out, nil
	}

	raw, _ := redisClient.ZRevRange(ctx, "rag:lex", 0, 19).Result()
	var merged []Hit
	seen := map[string]bool{}
	for _, item := range raw {
		var hit Hit
		json.Unmarshal([]byte(item), &hit)
		if !seen[hit.ChunkID] {
			seen[hit.ChunkID] = true
			merged = append(merged, hit)
		}
	}
	vectorHits, _ := VECTORS.Search(ctx, embedQuery(query), 20)
	for _, hit := range vectorHits {
		if !seen[hit.ChunkID] {
			seen[hit.ChunkID] = true
			merged = append(merged, hit)
		}
	}

	// TODO: global index, no tenant filter, no offsets, no k cap, five-minute tenant-less cache.
	out := Result{}
	for i := 0; i < k && i < len(merged); i++ {
		out.Chunks = append(out.Chunks, merged[i].Text)
		out.Citations = append(out.Citations, Citation{DocID: merged[i].DocID, ChunkID: merged[i].ChunkID})
	}
	payload, _ := json.Marshal(out)
	redisClient.Set(ctx, cacheKey, payload, 5*time.Minute)
	return out, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	rrfK     = 60
	maxK     = 20
	cacheTTL = 60 * time.Second
)

var redisClient = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Hit struct {
	DocID   string  \`json:"doc_id"\`
	ChunkID string  \`json:"chunk_id"\`
	Tenant  string  \`json:"tenant"\`
	Text    string  \`json:"text"\`
	Start   int     \`json:"start"\`
	End     int     \`json:"end"\`
	Score   float64 \`json:"score"\`
}

type Citation struct {
	DocID   string \`json:"doc_id"\`
	ChunkID string \`json:"chunk_id"\`
	Start   int    \`json:"start"\`
	End     int    \`json:"end"\`
}

type Result struct {
	Chunks    []string   \`json:"chunks"\`
	Citations []Citation \`json:"citations"\`
}

func retrieve(ctx context.Context, tenant, query string, k int) (Result, error) {
	if k > maxK {
		k = maxK
	}
	sum := sha256.Sum256([]byte(query))
	cacheKey := fmt.Sprintf("rag:q:%s:%x", tenant, sum)
	if cached, err := redisClient.Get(ctx, cacheKey).Result(); err == nil {
		var out Result
		json.Unmarshal([]byte(cached), &out)
		return out, nil
	}

	raw, _ := redisClient.ZRevRange(ctx, "rag:lex:"+tenant, 0, maxK-1).Result()
	lexical := make([]Hit, 0, len(raw))
	for _, item := range raw {
		var hit Hit
		json.Unmarshal([]byte(item), &hit)
		lexical = append(lexical, hit)
	}
	vectorHits, _ := VECTORS.Search(ctx, tenant, embedQuery(query), maxK)

	scores := map[string]float64{}
	byID := map[string]Hit{}
	for _, ranked := range [][]Hit{lexical, vectorHits} {
		for rank, hit := range ranked {
			if hit.Tenant != tenant {
				continue
			}
			scores[hit.ChunkID] += 1.0 / float64(rrfK+rank+1)
			byID[hit.ChunkID] = hit
		}
	}
	ids := make([]string, 0, len(scores))
	for id := range scores {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return scores[ids[i]] > scores[ids[j]] })
	if len(ids) > k {
		ids = ids[:k]
	}

	out := Result{}
	for _, id := range ids {
		hit := byID[id]
		out.Chunks = append(out.Chunks, hit.Text)
		out.Citations = append(out.Citations, Citation{DocID: hit.DocID, ChunkID: id, Start: hit.Start, End: hit.End})
	}
	payload, _ := json.Marshal(out)
	redisClient.Set(ctx, cacheKey, payload, cacheTTL)
	return out, nil
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

object Retrieve {
  val MaxK = 20
  val redis = new Jedis("redis", 6379)

  def sha256(text: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8"))
    digest.map("%02x".format(_)).mkString
  }

  def retrieve(tenant: String, query: String, k: Int = 10): String = {
    val cacheKey = "rag:q:" + sha256(query)
    Option(redis.get(cacheKey)) match {
      case Some(cached) => cached
      case None =>
        val lexical = redis.zrevrange("rag:lex", 0, 19).asScala.toSeq.map(parseHit)
        val vectorHits = VECTORS.search(embedQuery(query), MaxK)
        val merged = (lexical ++ vectorHits).distinctBy(_.chunkId)
        // TODO: global index, no tenant filter, no offsets, no k cap, five-minute tenant-less cache.
        val citations = merged.take(k).map(hit => Citation(hit.docId, hit.chunkId))
        val result = render(merged.take(k), citations)
        redis.setex(cacheKey, 300, result)
        result
    }
  }
}
`,
      solution: `import java.security.MessageDigest

import redis.clients.jedis.Jedis

import scala.collection.mutable
import scala.jdk.CollectionConverters._

object Retrieve {
  val RrfK = 60
  val MaxK = 20
  val CacheTtl = 60L
  val redis = new Jedis("redis", 6379)

  def sha256(text: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8"))
    digest.map("%02x".format(_)).mkString
  }

  def retrieve(tenant: String, query: String, k: Int = 10): String = {
    val limit = math.min(k, MaxK)
    val cacheKey = "rag:q:" + tenant + ":" + sha256(query)
    Option(redis.get(cacheKey)) match {
      case Some(cached) => cached
      case None =>
        val lexical = redis.zrevrange("rag:lex:" + tenant, 0, MaxK - 1).asScala.toSeq.map(parseHit)
        val vectorHits = VECTORS.search(tenant, embedQuery(query), MaxK).filter(_.tenant == tenant)
        val scores = mutable.Map.empty[String, Double]
        val byId = mutable.Map.empty[String, Hit]
        Seq(lexical, vectorHits).foreach { ranked =>
          ranked.zipWithIndex.foreach { case (hit, rank) =>
            scores(hit.chunkId) = scores.getOrElse(hit.chunkId, 0.0) + 1.0 / (RrfK + rank + 1)
            byId(hit.chunkId) = hit
          }
        }
        val ordered = scores.toSeq.sortBy(-_._2).take(limit).map(_._1)
        val citations = ordered.map(id => Citation(byId(id).docId, id, byId(id).start, byId(id).end))
        val result = render(ordered.map(byId(_)), citations)
        redis.setex(cacheKey, CacheTtl, result)
        result
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <redis++/redis++.h>

#include <string>
#include <unordered_set>
#include <vector>

using json = nlohmann::json;

std::string sha256hex(const std::string& text);
std::string embedQuery(const std::string& query);

std::string retrieve(const std::string& tenant, const std::string& query, int k) {
  auto redis = sw::redis::Redis("tcp://redis:6379");
  const auto cacheKey = "rag:q:" + sha256hex(query);
  if (auto cached = redis.get(cacheKey)) return *cached;

  auto lexical = redis.zrevrange("rag:lex", 0, 19);
  auto vectorHits = VECTORS.search(embedQuery(query), 20);
  std::vector<Hit> merged;
  std::unordered_set<std::string> seen;
  for (const auto& item : lexical) {
    auto hit = json::parse(item).get<Hit>();
    if (seen.insert(hit.chunkId).second) merged.push_back(hit);
  }
  for (const auto& hit : vectorHits) {
    if (seen.insert(hit.chunkId).second) merged.push_back(hit);
  }

  // TODO: global index, no tenant filter, no offsets, no k cap, five-minute tenant-less cache.
  json chunks = json::array();
  json citations = json::array();
  const auto limit = merged.size() < static_cast<std::size_t>(k) ? merged.size() : static_cast<std::size_t>(k);
  for (std::size_t i = 0; i < limit; ++i) {
    chunks.push_back(merged[i].text);
    citations.push_back({{"doc_id", merged[i].docId}, {"chunk_id", merged[i].chunkId}});
  }
  const auto result = json{{"chunks", chunks}, {"citations", citations}}.dump();
  redis.setex(cacheKey, 300, result);
  return result;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <redis++/redis++.h>

#include <algorithm>
#include <string>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;

constexpr int kRrfK = 60;
constexpr int kMaxK = 20;
constexpr int kCacheTtl = 60;

std::string sha256hex(const std::string& text);
std::string embedQuery(const std::string& query);

std::string retrieve(const std::string& tenant, const std::string& query, int k) {
  auto redis = sw::redis::Redis("tcp://redis:6379");
  const int limit = std::min(k, kMaxK);
  const auto cacheKey = "rag:q:" + tenant + ":" + sha256hex(query);
  if (auto cached = redis.get(cacheKey)) return *cached;

  std::vector<Hit> lexical;
  for (const auto& item : redis.zrevrange("rag:lex:" + tenant, 0, kMaxK - 1)) {
    lexical.push_back(json::parse(item).get<Hit>());
  }
  auto vectorHits = VECTORS.search(tenant, embedQuery(query), kMaxK);

  std::unordered_map<std::string, double> scores;
  std::unordered_map<std::string, Hit> byId;
  for (const auto* ranked : {&lexical, &vectorHits}) {
    for (std::size_t rank = 0; rank < ranked->size(); ++rank) {
      const auto& hit = (*ranked)[rank];
      if (hit.tenant != tenant) continue;
      scores[hit.chunkId] += 1.0 / (kRrfK + rank + 1);
      byId[hit.chunkId] = hit;
    }
  }
  std::vector<std::string> ids;
  for (const auto& [id, score] : scores) ids.push_back(id);
  std::sort(ids.begin(), ids.end(), [&](const std::string& a, const std::string& b) { return scores[a] > scores[b]; });
  if (static_cast<int>(ids.size()) > limit) ids.resize(limit);

  json chunks = json::array();
  json citations = json::array();
  for (const auto& id : ids) {
    const auto& hit = byId[id];
    chunks.push_back(hit.text);
    citations.push_back({{"doc_id", hit.docId}, {"chunk_id", id}, {"start", hit.start}, {"end", hit.end}});
  }
  const auto result = json{{"chunks", chunks}, {"citations", citations}}.dump();
  redis.setex(cacheKey, kCacheTtl, result);
  return result;
}
`,
    },
  },
  hints: [
    'Read the lexical set with `ZREVRANGE rag:lex:{tenant}`; the tenant belongs in the key, not in a filter after the fact.',
    'Filter the vector hits by `tenant` before you build the ranking. Then rank both lists from 1 and add `1/(60+rank)` into a map keyed by chunk id.',
    'Build citations from the stored chunk metadata, not from the model. `start` and `end` come from the chunk row; the answer step will re-check every quote against that span.',
  ],
  debrief: `The interviewer is testing whether you review AI-adjacent retrieval as a multi-tenant data path, not as a similarity demo. The draft’s flaw is not the missing RRF; it is the global index and the tenant-less cache key, which turn a correctness bug into a data leak. The second signal is citation geometry: returning chunk ids alone pushes the verification problem into the answer step, where a model can invent a source. RRF is deliberate because the two retrievers have incomparable scores; rank-based fusion needs no calibration and rewards chunks both retrievers agree on. Real systems add a per-tenant allowlist at the index layer, filter inside the vector query rather than after it, version the cache by index generation, and log which retriever contributed each citation for offline recall analysis.`,
};
