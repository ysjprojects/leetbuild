import type {Step} from '@/lib/types';

export const hybridRetrieveStep: Step = {
  id: 'hybrid-retrieve',
  title: 'Hybrid retrieval: a tenant prefilter, RRF, offsets, a per-tenant cache',
  concept: 'redis',
  guides: ['honest-reads', 'keys-and-expiry'],
  file: 'retrieve',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter's \`retrieve(tenant, query, k)\` returns the list cached at
\`rag:q:{sha256(query)}\` when there is one. Otherwise it takes \`search.lexical(tenant, query, k)\` and
\`search.knn("*", embed.vector(query), k)\`, appends the vector ids the lexical list lacks, turns the
first \`k\` into hits (\`chunk_id\`, \`doc_id\`, \`version\`, \`start\`, \`end\`, \`text\`, \`score\` = 1/position,
offsets counted inside the chunk) and caches them with no expiry. It looks right for one tenant and
hides five flaws.

**Failure mode the checks target.** The vector search runs over every tenant's chunks, and the cache key
without the tenant hands one tenant's results to the next. Appending one list to the other lets the
lexical order decide everything; a caller asking for 500 hits gets them all; and offsets inside the
chunk highlight the wrong place in the document.

Requirements:

- The vector search's prefilter is \`search.tenant_filter(tenant)\`.
- \`k\` is capped at \`MAX_K\` = 20; each retriever returns up to \`CANDIDATES\` = 50 ids.
- RRF: a chunk scores the sum of \`1 / (60 + rank)\` over the lists it is in (rank from 1); order by
  score, then chunk id; \`score\` is that sum.
- \`start\` and \`end\` are the chunk's offsets in its document (\`search.get_chunk\`).
- The cache key is \`rag:q:{tenant}:{k}:{sha256(query)}\`, kept \`CACHE_TTL_S\` = 60 s.`,
  sequence: {
    participants: ['ragd API', 'Redis'],
    messages: [
      {from: 'ragd API', to: 'Redis', label: 'GET rag:q:{tenant}:{k}:{sha256}', kind: 'sync'},
      {from: 'Redis', to: 'ragd API', label: 'miss', kind: 'reply'},
      {from: 'ragd API', to: 'Redis', label: 'lexical: SMEMBERS rag:lex:{tenant}:{word}', kind: 'sync'},
      {from: 'ragd API', to: 'Redis', label: 'knn: @tenant:{tenant} prefilter', kind: 'sync'},
      {from: 'ragd API', to: 'ragd API', label: 'RRF: Σ 1/(60 + rank) · top k ≤ 20', kind: 'sync'},
      {from: 'ragd API', to: 'Redis', label: 'SET rag:q:… hits EX 60', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'tenant-scope',
      title: 'Prefilters the vector search by tenant',
      detail:
        "Tenant t1's hits are exactly t1's chunks, all five of them, while 61 of t2's chunks sit nearer the query in the index. The starter's knn searches every tenant with the \"*\" prefilter.",
      match: {
        python: {all: [/tenant_filter\(\s*tenant\s*\)/], none: [/knn\(\s*["']\*["']/]},
        typescript: {all: [/tenantFilter\(\s*tenant\s*\)/], none: [/knn\(\s*['"]\*['"]/]},
        go: {all: [/search\.TenantFilter\(\s*tenant\s*\)/], none: [/Knn\(\s*\w+,\s*"\*"/]},
        cpp: {all: [/search::tenant_filter\(\s*tenant\s*\)/], none: [/knn\(\s*"\*"/]},
      },
    },
    {
      id: 'k-cap',
      title: 'Caps k at 20',
      detail:
        'Over 25 matching chunks, k = 500 returns 20 hits and k = 3 returns 3. The starter returns as many as the caller asks for.',
      match: {
        python: {all: [/\bMAX_K\b/, /min\(\s*\w+\s*,\s*MAX_K\s*\)|min\(\s*MAX_K\s*,\s*\w+\s*\)/]},
        typescript: {all: [/\bMAX_K\b/, /Math\.min\(\s*\w+\s*,\s*MAX_K\s*\)|Math\.min\(\s*MAX_K\s*,\s*\w+\s*\)/]},
        go: {all: [/\bmaxK\b/, /min\(\s*\w+\s*,\s*maxK\s*\)|min\(\s*maxK\s*,\s*\w+\s*\)/]},
        cpp: {all: [/\bkMaxK\b/, /std::min\(\s*\w+\s*,\s*kMaxK\s*\)|std::min\(\s*kMaxK\s*,\s*\w+\s*\)/]},
      },
    },
    {
      id: 'rrf-merge',
      title: 'Fuses the two rankings with RRF',
      detail:
        'A chunk second in both lists outranks one first in the lexical list and last in the vector list, and its score is 2/62; k = 1 returns that chunk too, since each retriever ranks its 50 candidates whatever k is; two chunks with the same fused score come in chunk id order. The starter appends the vector list to the lexical one.',
      match: {
        python: {all: [/RRF_K\s*\+\s*rank|rank\s*\+\s*RRF_K/]},
        typescript: {all: [/RRF_K\s*\+\s*rank|rank\s*\+\s*RRF_K/]},
        go: {all: [/rrfK\s*\+\s*rank|rank\s*\+\s*rrfK/]},
        cpp: {all: [/kRrfK\s*\+\s*rank|rank\s*\+\s*kRrfK/]},
      },
    },
    {
      id: 'citation-offsets',
      title: "Returns the chunk's offsets in its document",
      detail:
        'A hit for a chunk stored at 1600..1641 of its document says start 1600 and end 1641, with its doc_id and version. The starter counts from the start of the chunk.',
      match: {
        python: {all: [/["']start["']\s*:\s*\w+\[["']start["']\]/], none: [/["']start["']\s*:\s*0\b/]},
        typescript: {all: [/start:\s*\w+\.start\b/], none: [/start:\s*0\b/]},
        go: {all: [/Start:\s*\w+\.Start\b/], none: [/Start:\s*0\b/]},
        cpp: {all: [/\.start\s*=\s*\w+->start\b/], none: [/\.start\s*=\s*0\b/]},
      },
    },
    {
      id: 'cache-key',
      title: 'Caches per tenant and k for 60 seconds',
      detail:
        'After a retrieval rag:q:{tenant}:{k}:{sha256(query)} holds the hits with a TTL of at most 60 s from the moment it is written, another tenant asking the same query gets a key of its own, and 61 s later the entry is gone. The starter keys by the query alone and never expires it.',
      match: {
        python: {all: [/ex\s*=\s*CACHE_TTL_S/, /rag:q:\{tenant\}/]},
        typescript: {all: [/['"]EX['"],\s*CACHE_TTL_S/, /rag:q:\$\{tenant\}/]},
        go: {all: [/\bcacheTTL\b/, /"rag:q:"\s*\+\s*tenant/]},
        cpp: {all: [/\bkCacheTtl\b/, /"rag:q:"\s*\+\s*tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json

import redis

from rag import embed, search

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def retrieve(tenant: str, query: str, k: int) -> list[dict]:
    """The best chunks for the query: chunk_id, doc_id, version, start, end, text, score."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    key = "rag:q:" + hashlib.sha256(query.encode("utf-8")).hexdigest()
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)

    lexical = search.lexical(tenant, query, k)
    vector = search.knn("*", embed.vector(query), k)
    merged = lexical + [cid for cid in vector if cid not in lexical]
    hits = []
    for position, cid in enumerate(merged[:k], start=1):
        chunk = search.get_chunk(cid)
        if chunk is None:
            continue
        hits.append(
            {
                "chunk_id": cid,
                "doc_id": chunk["doc_id"],
                "version": chunk["version"],
                "start": 0,
                "end": len(chunk["text"]),
                "text": chunk["text"],
                "score": 1.0 / position,
            }
        )
    r.set(key, json.dumps(hits))
    return hits
`,
      solution: `import hashlib
import json

import redis

from rag import embed, search

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_K = 20
CANDIDATES = 50
RRF_K = 60
CACHE_TTL_S = 60


def retrieve(tenant: str, query: str, k: int) -> list[dict]:
    """The best chunks for the query: chunk_id, doc_id, version, start, end, text, score."""
    k = max(1, min(k, MAX_K))
    key = f"rag:q:{tenant}:{k}:{hashlib.sha256(query.encode('utf-8')).hexdigest()}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)

    lexical = search.lexical(tenant, query, CANDIDATES)
    vector = search.knn(search.tenant_filter(tenant), embed.vector(query), CANDIDATES)
    score: dict[str, float] = {}
    for ranked in (lexical, vector):
        for rank, cid in enumerate(ranked, start=1):
            score[cid] = score.get(cid, 0.0) + 1.0 / (RRF_K + rank)
    hits = []
    for cid in sorted(score, key=lambda c: (-score[c], c))[:k]:
        chunk = search.get_chunk(cid)
        if chunk is None:
            continue
        hits.append(
            {
                "chunk_id": cid,
                "doc_id": chunk["doc_id"],
                "version": chunk["version"],
                "start": chunk["start"],
                "end": chunk["end"],
                "text": chunk["text"],
                "score": score[cid],
            }
        )
    r.set(key, json.dumps(hits), ex=CACHE_TTL_S)
    return hits
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {vector} from 'rag/embed';
import * as search from 'rag/search';

const redis = new Redis({host: 'redis', port: 6379});

/** The best chunks for the query: chunk_id, doc_id, version, start, end, text, score. */
export async function retrieve(tenant: string, query: string, k: number): Promise<search.Hit[]> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const key = 'rag:q:' + createHash('sha256').update(query, 'utf8').digest('hex');
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as search.Hit[];

  const lexical = await search.lexical(tenant, query, k);
  const nearest = await search.knn('*', vector(query), k);
  const merged = [...lexical, ...nearest.filter(cid => !lexical.includes(cid))];
  const hits: search.Hit[] = [];
  for (const [i, cid] of merged.slice(0, k).entries()) {
    const chunk = await search.getChunk(cid);
    if (chunk === null) continue;
    hits.push({chunk_id: cid, doc_id: chunk.doc_id, version: chunk.version, start: 0, end: chunk.text.length, text: chunk.text, score: 1 / (i + 1)});
  }
  await redis.set(key, JSON.stringify(hits));
  return hits;
}
`,
      solution: `import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {vector} from 'rag/embed';
import * as search from 'rag/search';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_K = 20;
export const CANDIDATES = 50;
export const RRF_K = 60;
export const CACHE_TTL_S = 60;

/** The best chunks for the query: chunk_id, doc_id, version, start, end, text, score. */
export async function retrieve(tenant: string, query: string, k: number): Promise<search.Hit[]> {
  k = Math.max(1, Math.min(k, MAX_K));
  const key = \`rag:q:\${tenant}:\${k}:\${createHash('sha256').update(query, 'utf8').digest('hex')}\`;
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as search.Hit[];

  const lexical = await search.lexical(tenant, query, CANDIDATES);
  const nearest = await search.knn(search.tenantFilter(tenant), vector(query), CANDIDATES);
  const score = new Map<string, number>();
  for (const ranked of [lexical, nearest])
    for (const [i, cid] of ranked.entries()) {
      const rank = i + 1;
      score.set(cid, (score.get(cid) ?? 0) + 1 / (RRF_K + rank));
    }
  const order = [...score.keys()].sort((a, b) => (score.get(b) as number) - (score.get(a) as number) || (a < b ? -1 : 1));
  const hits: search.Hit[] = [];
  for (const cid of order.slice(0, k)) {
    const chunk = await search.getChunk(cid);
    if (chunk === null) continue;
    hits.push({chunk_id: cid, doc_id: chunk.doc_id, version: chunk.version, start: chunk.start, end: chunk.end, text: chunk.text, score: score.get(cid) as number});
  }
  await redis.set(key, JSON.stringify(hits), 'EX', CACHE_TTL_S);
  return hits;
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
	"errors"
	"slices"

	"github.com/redis/go-redis/v9"

	"rag/embed"  // embed.Vector(text) — provided
	"rag/search" // search.Lexical, search.Knn, search.GetChunk, search.Hit — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// retrieve is the best chunks for the query.
func retrieve(ctx context.Context, tenant, query string, k int) ([]search.Hit, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	sum := sha256.Sum256([]byte(query))
	key := "rag:q:" + hex.EncodeToString(sum[:])
	if cached, err := rdb.Get(ctx, key).Bytes(); err == nil {
		var hits []search.Hit
		if json.Unmarshal(cached, &hits) == nil {
			return hits, nil
		}
	} else if !errors.Is(err, redis.Nil) {
		return nil, err
	}

	lexical, err := search.Lexical(ctx, tenant, query, k)
	if err != nil {
		return nil, err
	}
	nearest, err := search.Knn(ctx, "*", embed.Vector(query), k)
	if err != nil {
		return nil, err
	}
	merged := lexical
	for _, id := range nearest {
		if !slices.Contains(lexical, id) {
			merged = append(merged, id)
		}
	}
	hits := []search.Hit{}
	for i, id := range merged[:min(k, len(merged))] {
		chunk, err := search.GetChunk(ctx, id)
		if err != nil {
			return nil, err
		}
		if chunk == nil {
			continue
		}
		hits = append(hits, search.Hit{ChunkID: id, DocID: chunk.DocID, Version: chunk.Version, Start: 0, End: len(chunk.Text), Text: chunk.Text, Score: 1 / float64(i+1)})
	}
	data, _ := json.Marshal(hits)
	if err := rdb.Set(ctx, key, data, 0).Err(); err != nil {
		return nil, err
	}
	return hits, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"rag/embed"  // embed.Vector(text) — provided
	"rag/search" // search.Lexical, search.Knn, search.GetChunk, search.Hit — provided
)

const (
	maxK       = 20
	candidates = 50
	rrfK       = 60
	cacheTTL   = 60 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// retrieve is the best chunks for the query.
func retrieve(ctx context.Context, tenant, query string, k int) ([]search.Hit, error) {
	k = max(1, min(k, maxK))
	sum := sha256.Sum256([]byte(query))
	key := "rag:q:" + tenant + ":" + strconv.Itoa(k) + ":" + hex.EncodeToString(sum[:])
	if cached, err := rdb.Get(ctx, key).Bytes(); err == nil {
		var hits []search.Hit
		if json.Unmarshal(cached, &hits) == nil {
			return hits, nil
		}
	} else if !errors.Is(err, redis.Nil) {
		return nil, err
	}

	lexical, err := search.Lexical(ctx, tenant, query, candidates)
	if err != nil {
		return nil, err
	}
	nearest, err := search.Knn(ctx, search.TenantFilter(tenant), embed.Vector(query), candidates)
	if err != nil {
		return nil, err
	}
	score := map[string]float64{}
	for _, ranked := range [][]string{lexical, nearest} {
		for i, id := range ranked {
			rank := i + 1
			score[id] += 1 / float64(rrfK+rank)
		}
	}
	order := make([]string, 0, len(score))
	for id := range score {
		order = append(order, id)
	}
	sort.Slice(order, func(i, j int) bool {
		if score[order[i]] != score[order[j]] {
			return score[order[i]] > score[order[j]]
		}
		return order[i] < order[j]
	})
	hits := []search.Hit{}
	for _, id := range order[:min(k, len(order))] {
		chunk, err := search.GetChunk(ctx, id)
		if err != nil {
			return nil, err
		}
		if chunk == nil {
			continue
		}
		hits = append(hits, search.Hit{ChunkID: id, DocID: chunk.DocID, Version: chunk.Version, Start: chunk.Start, End: chunk.End, Text: chunk.Text, Score: score[id]})
	}
	data, _ := json.Marshal(hits)
	if err := rdb.Set(ctx, key, data, cacheTTL).Err(); err != nil {
		return nil, err
	}
	return hits, nil
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>
#include <vector>

#include "digest.h"      // sha256_hex(bytes) — provided
#include "rag/embed.h"   // embed::vector(text) — provided
#include "rag/search.h"  // search::lexical, search::knn, search::get_chunk, search::Hit — provided

sw::redis::Redis redis("tcp://redis:6379");

// The best chunks for the query.
std::vector<search::Hit> retrieve(const std::string& tenant, const std::string& query, int k) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string key = "rag:q:" + sha256_hex(query);
  if (const auto cached = redis.get(key)) return nlohmann::json::parse(*cached).get<std::vector<search::Hit>>();

  const auto lexical = search::lexical(tenant, query, k);
  const auto nearest = search::knn("*", embed::vector(query), k);
  std::vector<std::string> merged = lexical;
  for (const auto& id : nearest)
    if (std::find(lexical.begin(), lexical.end(), id) == lexical.end()) merged.push_back(id);
  std::vector<search::Hit> hits;
  for (int i = 0; i < std::min(k, static_cast<int>(merged.size())); i++) {
    const auto c = search::get_chunk(merged[i]);
    if (!c) continue;
    hits.push_back(search::Hit{.chunk_id = merged[i], .doc_id = c->doc_id, .version = c->version, .start = 0,
                               .end = static_cast<int>(c->text.size()), .text = c->text, .score = 1.0 / (i + 1)});
  }
  redis.set(key, nlohmann::json(hits).dump());
  return hits;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "digest.h"      // sha256_hex(bytes) — provided
#include "rag/embed.h"   // embed::vector(text) — provided
#include "rag/search.h"  // search::lexical, search::knn, search::get_chunk, search::Hit — provided

constexpr int kMaxK = 20;
constexpr int kCandidates = 50;
constexpr int kRrfK = 60;
constexpr std::chrono::seconds kCacheTtl{60};

sw::redis::Redis redis("tcp://redis:6379");

// The best chunks for the query.
std::vector<search::Hit> retrieve(const std::string& tenant, const std::string& query, int k) {
  k = std::max(1, std::min(k, kMaxK));
  const std::string key = "rag:q:" + tenant + ":" + std::to_string(k) + ":" + sha256_hex(query);
  if (const auto cached = redis.get(key)) return nlohmann::json::parse(*cached).get<std::vector<search::Hit>>();

  const auto lexical = search::lexical(tenant, query, kCandidates);
  const auto nearest = search::knn(search::tenant_filter(tenant), embed::vector(query), kCandidates);
  std::map<std::string, double> score;
  for (const auto* ranked : {&lexical, &nearest})
    for (size_t i = 0; i < ranked->size(); i++) {
      const int rank = static_cast<int>(i) + 1;
      score[(*ranked)[i]] += 1.0 / (kRrfK + rank);
    }
  std::vector<std::string> order;
  for (const auto& [id, _] : score) order.push_back(id);
  std::stable_sort(order.begin(), order.end(), [&](const std::string& a, const std::string& b) {
    return score[a] != score[b] ? score[a] > score[b] : a < b;
  });
  std::vector<search::Hit> hits;
  for (size_t i = 0; i < std::min(static_cast<size_t>(k), order.size()); i++) {
    const auto c = search::get_chunk(order[i]);
    if (!c) continue;
    hits.push_back(search::Hit{.chunk_id = order[i], .doc_id = c->doc_id, .version = c->version, .start = c->start,
                               .end = c->end, .text = c->text, .score = score[order[i]]});
  }
  redis.set(key, nlohmann::json(hits).dump(), kCacheTtl);
  return hits;
}
`,
    },
  },
  harness: {
    python: `import hashlib

from rag import embed, search

Q = "refund window policy"


def _seed(tenant, name, text, scale, start=0):
    """A chunk whose vector is the query's, scaled: its knn rank follows the scale."""
    vector = [x * scale for x in embed.vector(Q)]
    search.upsert({"chunk_id": f"{tenant}-{name}", "tenant": tenant, "doc_id": "handbook", "version": 2, "start": start, "end": start + len(text), "text": text}, vector)


def _corpus():
    # lexical (words shared with Q): a 2, b 1. knn (scale): c, b, d, e, a. t2's x is nearest of all.
    _seed("t1", "a", "Refund window: 30 days from delivery.", 0.1, start=1600)
    _seed("t1", "b", "Refund requests need the order number.", 0.9)
    _seed("t1", "c", "Shipping takes five business days.", 1.0)
    _seed("t1", "d", "Invoices are emailed monthly.", 0.8)
    _seed("t1", "e", "Support answers within a day.", 0.7)
    _seed("t2", "x", "Refund window for partners: 90 days.", 2.0)


def _ids(hits):
    return [h["chunk_id"] for h in hits]


def check_tenant_scope(ctx):
    _corpus()
    for i in range(60):  # another tenant's chunks, all nearer the query than any of t1's
        _seed("t2", f"p{i:02d}", f"Partner note {i}.", 3.0)
    m = ctx.load("retrieve")
    ids = _ids(m.retrieve("t1", Q, 10))
    assert not [i for i in ids if not i.startswith("t1-")], f"tenant t1's retrieval returned t2's chunks ({ids}): the vector search must be prefiltered by tenant, not run over the whole index"
    assert sorted(ids) == ["t1-a", "t1-b", "t1-c", "t1-d", "t1-e"], f"t1 has five chunks and k = 10: expected all five, got {ids}; with 61 of t2's chunks nearer the query, filtering a search over the whole index afterwards loses t1's"


def check_k_cap(ctx):
    for i in range(25):
        _seed("t1", f"n{i:02d}", f"Refund note {i}.", (i + 1) / 100)
    m = ctx.load("retrieve")
    many = m.retrieve("t1", Q, 500)
    assert len(many) == 20, f"k = 500 returned {len(many)} hits: k is capped at MAX_K = 20, whatever the caller asks"
    few = m.retrieve("t1", "refund note", 3)
    assert len(few) == 3, f"k = 3 returned {len(few)} hits"


def check_rrf_merge(ctx):
    _corpus()
    m = ctx.load("retrieve")
    hits = m.retrieve("t1", Q, 5)
    ids = _ids(hits)
    assert ids[:2] == ["t1-b", "t1-a"], f"t1-b is second in both rankings, t1-a first in one and last in the other: fused by 1/(60 + rank), b leads, then a; got {ids}"
    assert abs(hits[0]["score"] - 2 / 62) < 1e-9, f"the top hit's score must be its fused score 1/62 + 1/62, got {hits[0]['score']}"
    top = m.retrieve("t1", Q, 1)
    assert _ids(top) == ["t1-b"] and abs(top[0]["score"] - 2 / 62) < 1e-9, f"k = 1 must return the best fused chunk, t1-b with 2/62: each retriever ranks CANDIDATES = 50 ids before the fusion, whatever k is; got {[(h['chunk_id'], h['score']) for h in top]}"
    _seed("t3", "z", "Refund window policy.", 0.5)  # lexical first, vector second
    _seed("t3", "m", "Refund.", 1.0)  # lexical second, vector first
    tied = _ids(m.retrieve("t3", Q, 2))
    assert tied == ["t3-m", "t3-z"], f"t3-m and t3-z both score 1/61 + 1/62; a tie is ordered by chunk id, got {tied}"


def check_citation_offsets(ctx):
    _corpus()
    m = ctx.load("retrieve")
    hits = {h["chunk_id"]: h for h in m.retrieve("t1", Q, 5)}
    a = hits.get("t1-a")
    assert a is not None, f"t1-a must be retrieved, got {list(hits)}"
    text = "Refund window: 30 days from delivery."
    assert (a.get("doc_id"), a.get("version")) == ("handbook", 2), f"a hit names its document and version, got {a}"
    assert (a.get("start"), a.get("end")) == (1600, 1600 + len(text)), f"t1-a sits at {1600}..{1600 + len(text)} of its document; the hit says {a.get('start')}..{a.get('end')}: offsets are document coordinates, so a citation can highlight them"


def check_cache_key(ctx):
    _corpus()
    m = ctx.load("retrieve")
    digest = hashlib.sha256(Q.encode()).hexdigest()
    key = f"rag:q:t1:5:{digest}"
    created = []

    def ttl_at_creation():
        if not ctx.redis.exists(key):  # the lookup came first: watch the write
            created.append(ctx.redis_after(key, ttl_at_creation))
            return None
        return ctx.redis.ttl(key)

    created.append(ctx.redis_after(key, ttl_at_creation))
    m.retrieve("t1", Q, 5)
    assert ctx.redis.exists(key), f"the hits must be cached at rag:q:{{tenant}}:{{k}}:{{sha256(query)}}, found {sorted(ctx.redis.keys('rag:q:*'))}"
    born = created[-1].result
    assert born is not None and 0 < born <= 60, f"{key} had TTL {born} the moment it was written: the entry and its 60 s expiry go in one command (SET … EX), so no crash leaves it immortal"
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= 60, f"{key} has TTL {ttl}: the cache keeps hits CACHE_TTL_S = 60 s"
    m.retrieve("t2", Q, 5)
    assert ctx.redis.exists(f"rag:q:t2:5:{digest}"), "t2 asking the same query must get a cache entry of its own: a key without the tenant serves t1's chunks to t2"
    ctx.clock.advance(61)
    assert not ctx.redis.exists(key), f"{key} outlived its 60 s"
`,
    typescript: `import {createHash} from 'node:crypto';

const Q = 'refund window policy';

/** A chunk whose vector is the query's, scaled: its knn rank follows the scale. */
async function seed(ctx, tenant: string, name: string, text: string, scale: number, start = 0) {
  const search = ctx.load('/support/rag/search.ts');
  const embed = ctx.load('/support/rag/embed.ts');
  const vector = embed.vector(Q).map(x => x * scale);
  await search.upsert({chunk_id: \`\${tenant}-\${name}\`, tenant, doc_id: 'handbook', version: 2, start, end: start + text.length, text}, vector);
}

async function corpus(ctx) {
  // lexical (words shared with Q): a 2, b 1. knn (scale): c, b, d, e, a. t2's x is nearest of all.
  await seed(ctx, 't1', 'a', 'Refund window: 30 days from delivery.', 0.1, 1600);
  await seed(ctx, 't1', 'b', 'Refund requests need the order number.', 0.9);
  await seed(ctx, 't1', 'c', 'Shipping takes five business days.', 1.0);
  await seed(ctx, 't1', 'd', 'Invoices are emailed monthly.', 0.8);
  await seed(ctx, 't1', 'e', 'Support answers within a day.', 0.7);
  await seed(ctx, 't2', 'x', 'Refund window for partners: 90 days.', 2.0);
}

const ids = hits => hits.map(h => h.chunk_id);

export async function check_tenant_scope(ctx) {
  await corpus(ctx);
  for (let i = 0; i < 60; i++) await seed(ctx, 't2', \`p\${String(i).padStart(2, '0')}\`, \`Partner note \${i}.\`, 3.0); // all nearer the query than any of t1's
  const m = ctx.load('retrieve');
  const got = ids(await m.retrieve('t1', Q, 10));
  assert(got.every(id => id.startsWith('t1-')), \`tenant t1's retrieval returned t2's chunks (\${JSON.stringify(got)}): the vector search must be prefiltered by tenant, not run over the whole index\`);
  assert.deepEqual([...got].sort(), ['t1-a', 't1-b', 't1-c', 't1-d', 't1-e'], \`t1 has five chunks and k = 10: expected all five, got \${JSON.stringify(got)}; with 61 of t2's chunks nearer the query, filtering a search over the whole index afterwards loses t1's\`);
}

export async function check_k_cap(ctx) {
  for (let i = 0; i < 25; i++) await seed(ctx, 't1', \`n\${String(i).padStart(2, '0')}\`, \`Refund note \${i}.\`, (i + 1) / 100);
  const m = ctx.load('retrieve');
  const many = await m.retrieve('t1', Q, 500);
  assert.equal(many.length, 20, \`k = 500 returned \${many.length} hits: k is capped at MAX_K = 20, whatever the caller asks\`);
  const few = await m.retrieve('t1', 'refund note', 3);
  assert.equal(few.length, 3, \`k = 3 returned \${few.length} hits\`);
}

export async function check_rrf_merge(ctx) {
  await corpus(ctx);
  const m = ctx.load('retrieve');
  const hits = await m.retrieve('t1', Q, 5);
  const got = ids(hits);
  assert.deepEqual(got.slice(0, 2), ['t1-b', 't1-a'], \`t1-b is second in both rankings, t1-a first in one and last in the other: fused by 1/(60 + rank), b leads, then a; got \${JSON.stringify(got)}\`);
  assert(Math.abs(hits[0].score - 2 / 62) < 1e-9, \`the top hit's score must be its fused score 1/62 + 1/62, got \${hits[0].score}\`);
  const top = await m.retrieve('t1', Q, 1);
  assert(top.length === 1 && top[0].chunk_id === 't1-b' && Math.abs(top[0].score - 2 / 62) < 1e-9, \`k = 1 must return the best fused chunk, t1-b with 2/62: each retriever ranks CANDIDATES = 50 ids before the fusion, whatever k is; got \${JSON.stringify(top.map(h => [h.chunk_id, h.score]))}\`);
  await seed(ctx, 't3', 'z', 'Refund window policy.', 0.5); // lexical first, vector second
  await seed(ctx, 't3', 'm', 'Refund.', 1.0); // lexical second, vector first
  const tied = ids(await m.retrieve('t3', Q, 2));
  assert.deepEqual(tied, ['t3-m', 't3-z'], \`t3-m and t3-z both score 1/61 + 1/62; a tie is ordered by chunk id, got \${JSON.stringify(tied)}\`);
}

export async function check_citation_offsets(ctx) {
  await corpus(ctx);
  const m = ctx.load('retrieve');
  const a = (await m.retrieve('t1', Q, 5)).find(h => h.chunk_id === 't1-a');
  assert(a !== undefined, 't1-a must be retrieved');
  const text = 'Refund window: 30 days from delivery.';
  assert(a.doc_id === 'handbook' && a.version === 2, \`a hit names its document and version, got \${JSON.stringify(a)}\`);
  assert(a.start === 1600 && a.end === 1600 + text.length, \`t1-a sits at 1600..\${1600 + text.length} of its document; the hit says \${a.start}..\${a.end}: offsets are document coordinates, so a citation can highlight them\`);
}

export async function check_cache_key(ctx) {
  await corpus(ctx);
  const m = ctx.load('retrieve');
  const digest = createHash('sha256').update(Q).digest('hex');
  const key = \`rag:q:t1:5:\${digest}\`;
  const created: {result: unknown}[] = [];
  const ttlAtCreation = () => {
    if (ctx.redis.exists(key) === 0) {
      created.push(ctx.redisAfter(key, ttlAtCreation)); // the lookup came first: watch the write
      return null;
    }
    return ctx.redis.ttl(key);
  };
  created.push(ctx.redisAfter(key, ttlAtCreation));
  await m.retrieve('t1', Q, 5);
  assert(ctx.redis.exists(key) === 1, \`the hits must be cached at rag:q:{tenant}:{k}:{sha256(query)}, found \${JSON.stringify(ctx.redis.keys('rag:q:*').sort())}\`);
  const born = created[created.length - 1].result as number | null;
  assert(born !== null && 0 < born && born <= 60, \`\${key} had TTL \${born} the moment it was written: the entry and its 60 s expiry go in one command (SET … EX), so no crash leaves it immortal\`);
  const ttl = ctx.redis.ttl(key);
  assert(0 < ttl && ttl <= 60, \`\${key} has TTL \${ttl}: the cache keeps hits CACHE_TTL_S = 60 s\`);
  await m.retrieve('t2', Q, 5);
  assert(ctx.redis.exists(\`rag:q:t2:5:\${digest}\`) === 1, 't2 asking the same query must get a cache entry of its own: a key without the tenant serves t1\\'s chunks to t2');
  ctx.clock.advance(61);
  assert.equal(ctx.redis.exists(key), 0, \`\${key} outlived its 60 s\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strings"

	"rag/embed"
	"rag/search"

	"leetbuild/harness"
)

const kHRetrieveQ = "refund window policy"

// hRetrieveSeed stores a chunk whose vector is the query's, scaled: its knn rank follows the scale.
func hRetrieveSeed(ctx *harness.Ctx, tenant, name, text string, scale float64, start int) {
	q := embed.Vector(kHRetrieveQ)
	vector := make([]float64, len(q))
	for i, x := range q {
		vector[i] = x * scale
	}
	err := search.Upsert(context.Background(), search.Chunk{ChunkID: tenant + "-" + name, Tenant: tenant, DocID: "handbook", Version: 2, Start: start, End: start + len(text), Text: text}, vector)
	ctx.NoError(err, "seeding %s-%s", tenant, name)
}

func hRetrieveCorpus(ctx *harness.Ctx) {
	// lexical (words shared with the query): a 2, b 1. knn (scale): c, b, d, e, a. t2's x is nearest of all.
	hRetrieveSeed(ctx, "t1", "a", "Refund window: 30 days from delivery.", 0.1, 1600)
	hRetrieveSeed(ctx, "t1", "b", "Refund requests need the order number.", 0.9, 0)
	hRetrieveSeed(ctx, "t1", "c", "Shipping takes five business days.", 1.0, 0)
	hRetrieveSeed(ctx, "t1", "d", "Invoices are emailed monthly.", 0.8, 0)
	hRetrieveSeed(ctx, "t1", "e", "Support answers within a day.", 0.7, 0)
	hRetrieveSeed(ctx, "t2", "x", "Refund window for partners: 90 days.", 2.0, 0)
}

func hRetrieveRun(ctx *harness.Ctx, tenant, query string, k int) []search.Hit {
	hits, err := retrieve(context.Background(), tenant, query, k)
	ctx.NoError(err, "retrieve(%q, %q, %d)", tenant, query, k)
	return hits
}

func hRetrieveIDs(hits []search.Hit) []string {
	ids := []string{}
	for _, h := range hits {
		ids = append(ids, h.ChunkID)
	}
	return ids
}

func CheckTenantScope(ctx *harness.Ctx) {
	hRetrieveCorpus(ctx)
	for i := 0; i < 60; i++ { // another tenant's chunks, all nearer the query than any of t1's
		hRetrieveSeed(ctx, "t2", fmt.Sprintf("p%02d", i), fmt.Sprintf("Partner note %d.", i), 3.0, 0)
	}
	ids := hRetrieveIDs(hRetrieveRun(ctx, "t1", kHRetrieveQ, 10))
	for _, id := range ids {
		ctx.Assert(strings.HasPrefix(id, "t1-"), "tenant t1's retrieval returned t2's chunks (%v): the vector search must be prefiltered by tenant, not run over the whole index", ids)
	}
	sorted := append([]string(nil), ids...)
	sort.Strings(sorted)
	ctx.Equal(sorted, []string{"t1-a", "t1-b", "t1-c", "t1-d", "t1-e"}, "t1 has five chunks and k = 10 (with 61 of t2's chunks nearer the query, filtering a search over the whole index afterwards loses t1's): the hits")
}

func CheckKCap(ctx *harness.Ctx) {
	for i := 0; i < 25; i++ {
		hRetrieveSeed(ctx, "t1", fmt.Sprintf("n%02d", i), fmt.Sprintf("Refund note %d.", i), float64(i+1)/100, 0)
	}
	many := hRetrieveRun(ctx, "t1", kHRetrieveQ, 500)
	ctx.Equal(len(many), 20, "k = 500: k is capped at maxK = 20, whatever the caller asks; hits")
	few := hRetrieveRun(ctx, "t1", "refund note", 3)
	ctx.Equal(len(few), 3, "k = 3; hits")
}

func CheckRrfMerge(ctx *harness.Ctx) {
	hRetrieveCorpus(ctx)
	hits := hRetrieveRun(ctx, "t1", kHRetrieveQ, 5)
	ids := hRetrieveIDs(hits)
	ctx.Assert(len(ids) >= 2 && ids[0] == "t1-b" && ids[1] == "t1-a", "t1-b is second in both rankings, t1-a first in one and last in the other: fused by 1/(60 + rank), b leads, then a; got %v", ids)
	ctx.Assert(math.Abs(hits[0].Score-2.0/62) < 1e-9, "the top hit's score must be its fused score 1/62 + 1/62, got %v", hits[0].Score)
	top := hRetrieveRun(ctx, "t1", kHRetrieveQ, 1)
	ctx.Assert(len(top) == 1 && top[0].ChunkID == "t1-b" && math.Abs(top[0].Score-2.0/62) < 1e-9, "k = 1 must return the best fused chunk, t1-b with 2/62: each retriever ranks candidates = 50 ids before the fusion, whatever k is; got %+v", top)
	hRetrieveSeed(ctx, "t3", "z", "Refund window policy.", 0.5, 0) // lexical first, vector second
	hRetrieveSeed(ctx, "t3", "m", "Refund.", 1.0, 0)                // lexical second, vector first
	tied := hRetrieveIDs(hRetrieveRun(ctx, "t3", kHRetrieveQ, 2))
	ctx.Equal(tied, []string{"t3-m", "t3-z"}, "t3-m and t3-z both score 1/61 + 1/62; a tie is ordered by chunk id")
}

func CheckCitationOffsets(ctx *harness.Ctx) {
	hRetrieveCorpus(ctx)
	text := "Refund window: 30 days from delivery."
	for _, h := range hRetrieveRun(ctx, "t1", kHRetrieveQ, 5) {
		if h.ChunkID != "t1-a" {
			continue
		}
		ctx.Assert(h.DocID == "handbook" && h.Version == 2, "a hit names its document and version, got %+v", h)
		ctx.Assert(h.Start == 1600 && h.End == 1600+len(text), "t1-a sits at 1600..%d of its document; the hit says %d..%d: offsets are document coordinates, so a citation can highlight them", 1600+len(text), h.Start, h.End)
		return
	}
	ctx.Fatalf("t1-a must be retrieved")
}

func CheckCacheKey(ctx *harness.Ctx) {
	hRetrieveCorpus(ctx)
	sum := sha256.Sum256([]byte(kHRetrieveQ))
	digest := hex.EncodeToString(sum[:])
	key := "rag:q:t1:5:" + digest
	born, bornSeen := int64(0), false
	var ttlAtCreation func() any
	ttlAtCreation = func() any {
		if ctx.Redis.Exists(key) == 0 {
			ctx.Redis.After(key, ttlAtCreation) // the lookup came first: watch the write
			return nil
		}
		born, bornSeen = int64(ctx.Redis.TTL(key)), true
		return nil
	}
	ctx.Redis.After(key, ttlAtCreation)
	hRetrieveRun(ctx, "t1", kHRetrieveQ, 5)
	ctx.Assert(ctx.Redis.Exists(key) == 1, "the hits must be cached at rag:q:{tenant}:{k}:{sha256(query)}, found %v", ctx.Redis.Keys("rag:q:*"))
	ctx.Assert(bornSeen && 0 < born && born <= 60, "%s had TTL %d the moment it was written: the entry and its 60 s expiry go in one command (SET … EX), so no crash leaves it immortal", key, born)
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(0 < ttl && ttl <= 60, "%s has TTL %d: the cache keeps hits cacheTTL = 60 s", key, ttl)
	hRetrieveRun(ctx, "t2", kHRetrieveQ, 5)
	ctx.Assert(ctx.Redis.Exists("rag:q:t2:5:"+digest) == 1, "t2 asking the same query must get a cache entry of its own: a key without the tenant serves t1's chunks to t2")
	ctx.Clock.Advance(61)
	ctx.Equal(ctx.Redis.Exists(key), int64(0), "%s outlived its 60 s", key)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace {

const std::string kHQ = "refund window policy";

// A chunk whose vector is the query's, scaled: its knn rank follows the scale.
void hRetrieveSeed(const std::string& tenant, const std::string& name, const std::string& text, double scale, int start = 0) {
  std::vector<double> vector = embed::vector(kHQ);
  for (double& x : vector) x *= scale;
  search::upsert({tenant + "-" + name, tenant, "handbook", 2, start, start + static_cast<int>(text.size()), text}, vector);
}

void hRetrieveCorpus() {
  // lexical (words shared with the query): a 2, b 1. knn (scale): c, b, d, e, a. t2's x is nearest of all.
  hRetrieveSeed("t1", "a", "Refund window: 30 days from delivery.", 0.1, 1600);
  hRetrieveSeed("t1", "b", "Refund requests need the order number.", 0.9);
  hRetrieveSeed("t1", "c", "Shipping takes five business days.", 1.0);
  hRetrieveSeed("t1", "d", "Invoices are emailed monthly.", 0.8);
  hRetrieveSeed("t1", "e", "Support answers within a day.", 0.7);
  hRetrieveSeed("t2", "x", "Refund window for partners: 90 days.", 2.0);
}

std::vector<std::string> hIdsOf(const std::vector<search::Hit>& hits) {
  std::vector<std::string> ids;
  for (const auto& h : hits) ids.push_back(h.chunk_id);
  return ids;
}

}  // namespace

void CheckTenantScope(harness::Ctx& ctx) {
  hRetrieveCorpus();
  for (int i = 0; i < 60; i++) {  // another tenant's chunks, all nearer the query than any of t1's
    char name[8];
    std::snprintf(name, sizeof name, "p%02d", i);
    hRetrieveSeed("t2", name, "Partner note " + std::to_string(i) + ".", 3.0);
  }
  const auto ids = hIdsOf(retrieve("t1", kHQ, 10));
  for (const auto& id : ids) ctx.Assert(id.rfind("t1-", 0) == 0, "tenant t1's retrieval returned t2's chunks (%v): the vector search must be prefiltered by tenant, not run over the whole index", ids);
  auto sorted = ids;
  std::sort(sorted.begin(), sorted.end());
  ctx.Equal(sorted, {"t1-a", "t1-b", "t1-c", "t1-d", "t1-e"}, "t1 has five chunks and k = 10 (with 61 of t2's chunks nearer the query, filtering a search over the whole index afterwards loses t1's): the hits");
}

void CheckKCap(harness::Ctx& ctx) {
  for (int i = 0; i < 25; i++) {
    char name[8];
    std::snprintf(name, sizeof name, "n%02d", i);
    hRetrieveSeed("t1", name, "Refund note " + std::to_string(i) + ".", (i + 1) / 100.0);
  }
  ctx.Equal(retrieve("t1", kHQ, 500).size(), 20, "k = 500: k is capped at kMaxK = 20, whatever the caller asks; hits");
  ctx.Equal(retrieve("t1", "refund note", 3).size(), 3, "k = 3; hits");
}

void CheckRrfMerge(harness::Ctx& ctx) {
  hRetrieveCorpus();
  const auto hits = retrieve("t1", kHQ, 5);
  const auto ids = hIdsOf(hits);
  ctx.Assert(ids.size() >= 2 && ids[0] == "t1-b" && ids[1] == "t1-a", "t1-b is second in both rankings, t1-a first in one and last in the other: fused by 1/(60 + rank), b leads, then a; got %v", ids);
  ctx.Assert(std::abs(hits[0].score - 2.0 / 62) < 1e-9, "the top hit's score must be its fused score 1/62 + 1/62, got %v", hits[0].score);
  const auto top = retrieve("t1", kHQ, 1);
  ctx.Assert(top.size() == 1 && top[0].chunk_id == "t1-b" && std::abs(top[0].score - 2.0 / 62) < 1e-9, "k = 1 must return the best fused chunk, t1-b with 2/62: each retriever ranks kCandidates = 50 ids before the fusion, whatever k is; got %v", hIdsOf(top));
  hRetrieveSeed("t3", "z", "Refund window policy.", 0.5);  // lexical first, vector second
  hRetrieveSeed("t3", "m", "Refund.", 1.0);                // lexical second, vector first
  ctx.Equal(hIdsOf(retrieve("t3", kHQ, 2)), {"t3-m", "t3-z"}, "t3-m and t3-z both score 1/61 + 1/62; a tie is ordered by chunk id");
}

void CheckCitationOffsets(harness::Ctx& ctx) {
  hRetrieveCorpus();
  const int len = static_cast<int>(std::string("Refund window: 30 days from delivery.").size());
  for (const auto& h : retrieve("t1", kHQ, 5)) {
    if (h.chunk_id != "t1-a") continue;
    ctx.Assert(h.doc_id == "handbook" && h.version == 2, "a hit names its document and version, got doc %q version %d", h.doc_id, h.version);
    ctx.Assert(h.start == 1600 && h.end == 1600 + len, "t1-a sits at 1600..%d of its document; the hit says %d..%d: offsets are document coordinates, so a citation can highlight them", 1600 + len, h.start, h.end);
    return;
  }
  ctx.Fatalf("t1-a must be retrieved");
}

void CheckCacheKey(harness::Ctx& ctx) {
  hRetrieveCorpus();
  const std::string digest = sha256_hex(kHQ);
  const std::string key = "rag:q:t1:5:" + digest;
  bool bornSeen = false;
  long long born = 0;
  std::function<void()> ttlAtCreation = [&] {
    if (ctx.Redis.Exists(key) == 0) {
      ctx.Redis.After(key, ttlAtCreation);  // the lookup came first: watch the write
      return;
    }
    bornSeen = true;
    born = ctx.Redis.TTL(key);
  };
  ctx.Redis.After(key, ttlAtCreation);
  retrieve("t1", kHQ, 5);
  ctx.Assert(ctx.Redis.Exists(key) == 1, "the hits must be cached at rag:q:{tenant}:{k}:{sha256(query)}, found %v", ctx.Redis.Keys("rag:q:*"));
  ctx.Assert(bornSeen && 0 < born && born <= 60, "%s had TTL %d the moment it was written: the entry and its 60 s expiry go in one command (SET … EX), so no crash leaves it immortal", key, born);
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(0 < ttl && ttl <= 60, "%s has TTL %d: the cache keeps hits kCacheTtl = 60 s", key, ttl);
  retrieve("t2", kHQ, 5);
  ctx.Assert(ctx.Redis.Exists("rag:q:t2:5:" + digest) == 1, "t2 asking the same query must get a cache entry of its own: a key without the tenant serves t1's chunks to t2");
  ctx.Clock.Advance(61);
  ctx.Equal(ctx.Redis.Exists(key), 0, "%s outlived its 60 s", key);
}
`,
  },
  hints: [
    "Symptom: an agent in one tenant sees another tenant's refund terms cited; the second tenant to ask a question gets the first tenant's results, indefinitely; a highlight lands at the top of the document.",
    'Mechanism: `knn("*", …)` searches every tenant; the cache key is the query hash alone, set without `ex`; concatenation ranks a chunk both retrievers like below a lexical-only one; `start` is 0 for every hit.',
    'Change: `knn(search.tenant_filter(tenant), …, CANDIDATES)`; `k = min(k, MAX_K)`; `score[cid] += 1 / (RRF_K + rank)` over both lists, sorted by `(-score, cid)`; offsets from `get_chunk`; `set(f"rag:q:{tenant}:{k}:{digest}", …, ex=CACHE_TTL_S)`.',
  ],
  debrief: `The prefilter belongs inside the search, not after it: a filter applied to the global top 50 can return fewer than k results, and a forgotten one returns another tenant's text. The same boundary runs through the cache key, because a cache is a second index. RRF fuses ranks rather than scores because BM25 and cosine scores are not on one scale; the constant 60 keeps a single first place from dominating, so agreement between retrievers wins. Offsets are document coordinates because a citation highlights the document. Production retrieval adds a reranker over the fused candidates, drops a tenant's cache entries when its documents change, and logs the chunk ids behind every answer for audit.`,
};
