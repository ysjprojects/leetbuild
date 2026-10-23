import type {Step} from '@/lib/types';

// ---- 2. The knowledge base: chunks and embeddings in Postgres, the answer cache in Redis ---------
export const kbRetrievalStep: Step = {
  id: 'kb-retrieval',
  title: 'The knowledge base: nearest chunks and the answer cache',
  concept: 'redis',
  file: 'kb_search',
  focus: ['pg', 'redis'],
  task: `## Task

The model only answers well from text it was given, so the first thing the assistant needs is a way
to find the few paragraphs that matter for a question. The knowledge base is ten articles
(\`kb.ARTICLES\`); each is cut into overlapping word windows (\`chunk.chunk\`), every window is embedded
(\`embed.embed\`, 512 floats) and stored in Postgres next to its text, and a question is answered by the
chunks whose vectors are nearest to the question's. The same question asked twice should not cost a
second model call, so the answer is also remembered in Redis.

Implement \`kb_search\`:

- \`index_articles(articles)\` — for every article, \`chunk\` its body and \`embed\` each chunk, then
  \`INSERT INTO kb_chunks (id, article, position, text, embedding)\` with the id \`"<article>-<position>"\`
  (position 0-based) and the vector written with \`embed.to_pgvector\`. Indexing is **idempotent** —
  \`ON CONFLICT (id) DO NOTHING\` — and returns the number of chunks inserted.
- \`search(question, k=TOP_K)\` — embed the question and let the database rank:
  \`ORDER BY embedding <=> $1 LIMIT k\` (pgvector's cosine distance); each hit is
  \`{id, text, score}\` with \`score = 1 - distance\`, best first. The ranking runs in Postgres: never
  fetch the table and sort it yourself.
- \`cache_key(question)\` — \`"answer:" + sha256(normalised question)\` as hex, where the normalised
  question is lower-cased, whitespace-collapsed and trimmed, so \`"How do I get paid?"\` and
  \`"  how do i   get PAID? "\` share a key.
- \`cached_answer(question)\` — the JSON \`{answer, sources}\` stored under that key, or \`None\` on a miss.
- \`remember_answer(question, answer, sources)\` — \`SET <key> <json> EX CACHE_TTL_S\` (3600 s).

:::widget cache-aside {}

> The cache sits in front of retrieval *and* generation: step 1 asks \`cached_answer\` before it
> searches, and a hit skips both the nearest-neighbour query and the model. The key is the question
> after normalisation, never the raw text — a stray capital letter must not be a cache miss.`,
  sequence: {
    participants: ['assistant', 'Postgres', 'Redis'],
    messages: [
      {
        from: 'assistant',
        to: 'assistant',
        label: 'index_articles: chunk → embed → 512-d vector per chunk',
        kind: 'sync',
      },
      {
        from: 'assistant',
        to: 'Postgres',
        label: 'INSERT INTO kb_chunks (pay-0, pay, 0, …, [0.12,…]) ON CONFLICT DO NOTHING',
        kind: 'sync',
      },
      {
        from: 'assistant',
        to: 'Redis',
        label: 'GET answer:3f2a… (sha256 of "payout missing after five business days")',
        kind: 'sync',
      },
      {from: 'Redis', to: 'assistant', label: '(nil)', kind: 'reply'},
      {
        from: 'assistant',
        to: 'Postgres',
        label: 'SELECT id, text, embedding <=> $1 FROM kb_chunks ORDER BY embedding <=> $1 LIMIT 4',
        kind: 'sync',
      },
      {from: 'Postgres', to: 'assistant', label: 'pay-2 0.43 · pay-0 0.59 · pay-1 0.74 · tips-1 0.78', kind: 'reply'},
      {
        from: 'assistant',
        to: 'Redis',
        label: 'SET answer:3f2a… {"answer": …, "sources": ["pay-0"]} EX 3600',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The chunk id is `f"{article}-{position}"` from `enumerate(chunk.chunk(body))`; the vector goes in as the string `embed.to_pgvector(embed.embed(text))` cast with `::vector`. One INSERT per chunk inside one transaction is fine — the return value is the sum of the rows each INSERT reported, which `ON CONFLICT DO NOTHING` makes zero on a re-run.',
    '`<=>` is a distance: 0 for identical directions, 2 for opposite. Select it as a column and order by it ascending with the same parameter, then turn each row into `{id, text, score: 1 - distance}` — the `LIMIT` is the parameter `k`, not a slice of the rows in your code.',
    'Normalise with `" ".join(question.lower().split())` (or `trim().toLowerCase().replace(/\\s+/g, " ")`), hash the UTF-8 bytes with sha256, prefix `answer:`. The value is `json.dumps({"answer": answer, "sources": sources})` set with `ex=CACHE_TTL_S`; a miss is a `None` from GET, so return `None` — not an empty dict.',
  ],
  checks: [
    {
      id: 'index-chunks',
      title: 'Indexes every chunk once with its id and vector',
      detail:
        'After `index_articles(kb.ARTICLES)` the table holds one row per chunk of every article, ids `<article>-<position>`, the chunk text and a 512-dimensional embedding; the call returns the number of rows it inserted and a second call changes nothing.',
      match: {
        python: {
          all: [/INSERT INTO kb_chunks/, /ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/, /chunk\.chunk\(/, /to_pgvector\(/],
        },
        typescript: {
          all: [/INSERT INTO kb_chunks/, /ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/, /\bchunk\(/, /toPgvector\(/],
        },
        go: {
          all: [
            /INSERT INTO kb_chunks/,
            /ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/,
            /chunk\.Chunk\(/,
            /embed\.ToPgvector\(/,
          ],
        },
        scala: {
          all: [
            /INSERT INTO kb_chunks/,
            /ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/,
            /Chunk\.chunk\(/,
            /Embed\.toPgvector\(/,
          ],
        },
        cpp: {
          all: [
            /INSERT INTO kb_chunks/,
            /ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/,
            /assistant::chunk\(/,
            /assistant::to_pgvector\(/,
          ],
        },
      },
    },
    {
      id: 'nearest-chunks',
      title: 'Returns the nearest chunks best first, scored 1 − distance',
      detail:
        "A question about pay returns the pay article's chunks first and a question about signing in the login article's; `k` bounds the result, scores are `1 - cosine distance` in (0, 1] and decrease down the list.",
      match: {
        python: {all: [/ORDER BY\s+embedding\s*<=>/, /1(\.0)?\s*-\s*/, /\bk\b/]},
        typescript: {all: [/ORDER BY\s+embedding\s*<=>/, /1\s*-\s*/, /\bk\b/]},
        go: {all: [/ORDER BY\s+embedding\s*<=>/, /1\s*-\s*/, /\bk\b/]},
        scala: {all: [/ORDER BY\s+embedding\s*<=>/, /1(\.0)?\s*-\s*/, /\bk\b/]},
        cpp: {all: [/ORDER BY\s+embedding\s*<=>/, /1(\.0)?\s*-\s*/, /\bk\b/]},
      },
    },
    {
      id: 'ranked-in-database',
      title: 'Lets Postgres rank: one `<=>` query with a LIMIT',
      detail:
        'The statement log of a search shows a query on `kb_chunks` using `<=>` with a `LIMIT`; no `SELECT` on `kb_chunks` without a `LIMIT` runs — the code never pulls every chunk to sort it in memory.',
      match: {
        python: {all: [/LIMIT\s+%s/], none: [/sorted\(/, /\.sort\(/]},
        typescript: {all: [/LIMIT\s+\$\d/], none: [/\.sort\(/]},
        go: {all: [/LIMIT\s+\$\d/], none: [/sort\.Slice\(/]},
        scala: {all: [/LIMIT\s+\?/], none: [/\.sortBy\(/, /\.sorted\b/]},
        cpp: {all: [/LIMIT\s+\$\d/], none: [/std::sort\(/]},
      },
    },
    {
      id: 'cache-key',
      title: 'Keys the cache by the normalised question',
      detail:
        '`cache_key` is `answer:` followed by the sha256 hex of the question lower-cased, whitespace-collapsed and trimmed; the same question with different casing or spacing has the same key, and that key is the one that appears in Redis after `remember_answer`.',
      match: {
        python: {all: [/hashlib\.sha256\(/, /["']answer:["']/, /\.lower\(\)/, /\.split\(\)|\\s\+/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /['"]answer:['"]/, /\.toLowerCase\(\)/, /\\s\+/]},
        go: {all: [/sha256\.Sum256\(/, /"answer:"/, /strings\.ToLower\(/, /strings\.Fields\(/]},
        scala: {all: [/"SHA-256"/, /"answer:"/, /\.toLowerCase/, /\\s\+/]},
        cpp: {all: [/sha256_hex\(/, /"answer:"/, /std::tolower\(/, /std::isspace\(/]},
      },
    },
    {
      id: 'cache-round-trip',
      title: 'Misses, remembers with a TTL, hits for the same question',
      detail:
        '`cached_answer` is `None` before anything is remembered; after `remember_answer(question, answer, sources)` the same question written differently returns `{answer, sources}`, the key has a TTL of `CACHE_TTL_S` (3600 s), and a different question still misses.',
      match: {
        python: {
          all: [/\.set\(\s*[^\n]*ex\s*=\s*CACHE_TTL_S/, /\.get\(\s*cache_key\(/, /json\.loads\(/, /json\.dumps\(/],
        },
        typescript: {
          all: [
            /\.set\(\s*[^\n]*['"]EX['"]\s*,\s*CACHE_TTL_S/,
            /\.get\(\s*cacheKey\(/,
            /JSON\.parse\(/,
            /JSON\.stringify\(/,
          ],
        },
        go: {
          all: [
            /rdb\.Set\(\s*[^\n]*config\.CacheTTL/,
            /rdb\.Get\(\s*ctx\s*,\s*cacheKey\(/,
            /json\.Unmarshal\(/,
            /json\.Marshal\(/,
          ],
        },
        scala: {
          all: [
            /jedis\.setex\(\s*[^\n]*Config\.CacheTtlS/,
            /jedis\.get\(\s*cacheKey\(/,
            /Json\.parse\(/,
            /\.toJson\b|Json\.obj\(/,
          ],
        },
        cpp: {all: [/redis\.set\(\s*[^\n]*kCacheTtl/, /redis\.get\(\s*cache_key\(/, /json::parse\(/, /\.dump\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis."""
import hashlib
import json

import redis

from assistant import chunk, embed, kb
from assistant.config import CACHE_TTL_S, TOP_K
from assistant.db import db

r = redis.Redis(host="redis", port=6379, decode_responses=True)


async def index_articles(articles: list[dict] | None = None) -> int:
    """Chunk, embed and store every article; the number of chunks inserted. Safe to run again."""
    articles = kb.ARTICLES if articles is None else articles
    # TODO: for each article, for position, text in enumerate(chunk.chunk(body)):
    # TODO:   id "<article>-<position>", the vector as embed.to_pgvector(embed.embed(text)) cast ::vector
    # TODO:   one INSERT per chunk, idempotent on the id; sum the rows each INSERT reports
    raise NotImplementedError


async def search(question: str, k: int = TOP_K) -> list[dict]:
    """The k chunks nearest to the question, best first: [{id, text, score}]."""
    # TODO: embed the question; SELECT id, text and the cosine distance, ordered by it, bounded by k
    # TODO: score = 1 - distance
    raise NotImplementedError


def normalise(question: str) -> str:
    """Lower-cased, whitespace collapsed to single spaces, trimmed."""
    # TODO
    raise NotImplementedError


def cache_key(question: str) -> str:
    # TODO: "answer:" + sha256 hex of the normalised question
    raise NotImplementedError


async def cached_answer(question: str) -> dict | None:
    """{answer, sources} remembered for this question, or None."""
    # TODO: GET the key; a miss is None
    raise NotImplementedError


async def remember_answer(question: str, answer: str, sources: list[str]) -> None:
    # TODO: SET the key to the JSON {answer, sources} with EX CACHE_TTL_S
    raise NotImplementedError
`,
      solution: `"""The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis."""
import hashlib
import json

import redis

from assistant import chunk, embed, kb
from assistant.config import CACHE_TTL_S, TOP_K
from assistant.db import db

r = redis.Redis(host="redis", port=6379, decode_responses=True)


async def index_articles(articles: list[dict] | None = None) -> int:
    """Chunk, embed and store every article; the number of chunks inserted. Safe to run again."""
    articles = kb.ARTICLES if articles is None else articles
    inserted = 0
    async with db.transaction() as cur:
        for a in articles:
            for position, text in enumerate(chunk.chunk(a["body"])):
                await cur.execute(
                    "INSERT INTO kb_chunks (id, article, position, text, embedding) "
                    "VALUES (%s, %s, %s, %s, %s::vector) ON CONFLICT (id) DO NOTHING",
                    (f"{a['id']}-{position}", a["id"], position, text, embed.to_pgvector(embed.embed(text))),
                )
                inserted += cur.rowcount
    return inserted


async def search(question: str, k: int = TOP_K) -> list[dict]:
    """The k chunks nearest to the question, best first: [{id, text, score}]."""
    q = embed.to_pgvector(embed.embed(question))
    rows = await db.execute(
        "SELECT id, text, embedding <=> %s::vector AS distance FROM kb_chunks "
        "ORDER BY embedding <=> %s::vector LIMIT %s",
        (q, q, k),
    )
    return [{"id": row["id"], "text": row["text"], "score": 1.0 - float(row["distance"])} for row in rows]


def normalise(question: str) -> str:
    """Lower-cased, whitespace collapsed to single spaces, trimmed."""
    return " ".join(question.lower().split())


def cache_key(question: str) -> str:
    return "answer:" + hashlib.sha256(normalise(question).encode("utf-8")).hexdigest()


async def cached_answer(question: str) -> dict | None:
    """{answer, sources} remembered for this question, or None."""
    raw = r.get(cache_key(question))
    return json.loads(raw) if raw else None


async def remember_answer(question: str, answer: str, sources: list[str]) -> None:
    r.set(cache_key(question), json.dumps({"answer": answer, "sources": sources}), ex=CACHE_TTL_S)
`,
    },
    typescript: {
      starter: `/** The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis. */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {chunk} from 'assistant/chunk';
import {CACHE_TTL_S, TOP_K} from 'assistant/config';
import {pool} from 'assistant/db';
import {embed, toPgvector} from 'assistant/embed';
import {type Article, ARTICLES} from 'assistant/kb';

const redis = new Redis({host: 'redis', port: 6379});

export interface Hit {
  id: string;
  text: string;
  score: number;
}

export interface CachedAnswer {
  answer: string;
  sources: string[];
}

/** Chunk, embed and store every article; the number of chunks inserted. Safe to run again. */
export async function indexArticles(articles: Article[] = ARTICLES): Promise<number> {
  // TODO: for each article, for each [position, text] of chunk(body):
  // TODO:   id \`<article>-<position>\`, the vector as toPgvector(embed(text)) cast ::vector
  // TODO:   one INSERT per chunk, idempotent on the id; sum the rowCount each INSERT reports
  throw new Error('not implemented');
}

/** The k chunks nearest to the question, best first. */
export async function search(question: string, k = TOP_K): Promise<Hit[]> {
  // TODO: embed the question; SELECT id, text and the cosine distance, ordered by it, bounded by k
  // TODO: score = 1 - distance
  throw new Error('not implemented');
}

/** Lower-cased, whitespace collapsed to single spaces, trimmed. */
export function normalise(question: string): string {
  throw new Error('not implemented'); // TODO
}

export function cacheKey(question: string): string {
  throw new Error('not implemented'); // TODO: 'answer:' + sha256 hex of the normalised question
}

/** {answer, sources} remembered for this question, or null. */
export async function cachedAnswer(question: string): Promise<CachedAnswer | null> {
  throw new Error('not implemented'); // TODO: GET the key; a miss is null
}

export async function rememberAnswer(question: string, answer: string, sources: string[]): Promise<void> {
  throw new Error('not implemented'); // TODO: SET the key to the JSON {answer, sources} with EX CACHE_TTL_S
}
`,
      solution: `/** The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis. */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {chunk} from 'assistant/chunk';
import {CACHE_TTL_S, TOP_K} from 'assistant/config';
import {pool} from 'assistant/db';
import {embed, toPgvector} from 'assistant/embed';
import {type Article, ARTICLES} from 'assistant/kb';

const redis = new Redis({host: 'redis', port: 6379});

export interface Hit {
  id: string;
  text: string;
  score: number;
}

export interface CachedAnswer {
  answer: string;
  sources: string[];
}

/** Chunk, embed and store every article; the number of chunks inserted. Safe to run again. */
export async function indexArticles(articles: Article[] = ARTICLES): Promise<number> {
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const a of articles) {
      for (const [position, text] of chunk(a.body).entries()) {
        const res = await client.query(
          'INSERT INTO kb_chunks (id, article, position, text, embedding) VALUES ($1, $2, $3, $4, $5::vector) ON CONFLICT (id) DO NOTHING',
          [\`\${a.id}-\${position}\`, a.id, position, text, toPgvector(embed(text))],
        );
        inserted += res.rowCount ?? 0;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return inserted;
}

/** The k chunks nearest to the question, best first. */
export async function search(question: string, k = TOP_K): Promise<Hit[]> {
  const q = toPgvector(embed(question));
  const {rows} = await pool.query<{id: string; text: string; distance: number | string}>(
    'SELECT id, text, embedding <=> $1::vector AS distance FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT $2',
    [q, k],
  );
  return rows.map(row => ({id: row.id, text: row.text, score: 1 - Number(row.distance)}));
}

/** Lower-cased, whitespace collapsed to single spaces, trimmed. */
export function normalise(question: string): string {
  return question.toLowerCase().trim().replace(/\\s+/g, ' ');
}

export function cacheKey(question: string): string {
  return 'answer:' + createHash('sha256').update(normalise(question)).digest('hex');
}

/** {answer, sources} remembered for this question, or null. */
export async function cachedAnswer(question: string): Promise<CachedAnswer | null> {
  const raw = await redis.get(cacheKey(question));
  return raw === null ? null : (JSON.parse(raw) as CachedAnswer);
}

export async function rememberAnswer(question: string, answer: string, sources: string[]): Promise<void> {
  await redis.set(cacheKey(question), JSON.stringify({answer, sources}), 'EX', CACHE_TTL_S);
}
`,
    },
    go: {
      starter: `// The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"assistant/chunk"  // chunk.Chunk(text) []string
	"assistant/config" // config.CacheTTL (seconds), config.TopK
	"assistant/db"     // db.Pool *sql.DB (database/sql, lib/pq)
	"assistant/embed"  // embed.Embed(text) []float64, embed.ToPgvector(v) string
	"assistant/kb"     // kb.Articles []kb.Article{ID, Title, Body}
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Hit struct {
	ID    string  \`json:"id"\`
	Text  string  \`json:"text"\`
	Score float64 \`json:"score"\`
}

type CachedAnswer struct {
	Answer  string   \`json:"answer"\`
	Sources []string \`json:"sources"\`
}

// indexArticles chunks, embeds and stores every article; the number of chunks inserted. Safe to run again.
func indexArticles(ctx context.Context, articles []kb.Article) (int, error) {
	// TODO: for each article, for position, text := range chunk.Chunk(body):
	// TODO:   id "<article>-<position>", the vector as embed.ToPgvector(embed.Embed(text)) cast ::vector
	// TODO:   one INSERT per chunk in one transaction (db.Pool.BeginTx), idempotent on the id; sum each result's RowsAffected()
	panic("not implemented")
}

// search returns the k chunks nearest to the question, best first.
func search(ctx context.Context, question string, k int) ([]Hit, error) {
	// TODO: embed the question; SELECT id, text and the cosine distance, ordered by it, bounded by k
	// TODO: score = 1 - distance
	panic("not implemented")
}

// normalise lower-cases, collapses whitespace and trims.
func normalise(question string) string {
	panic("not implemented") // TODO
}

func cacheKey(question string) string {
	panic("not implemented") // TODO: "answer:" + sha256 hex of the normalised question
}

// cachedAnswer is the {answer, sources} remembered for this question, or nil.
func cachedAnswer(ctx context.Context, question string) (*CachedAnswer, error) {
	panic("not implemented") // TODO: GET the key; redis.Nil is a miss
}

func rememberAnswer(ctx context.Context, question, answer string, sources []string) error {
	panic("not implemented") // TODO: SET the key to the JSON {answer, sources} with EX config.CacheTTL
}

func main() {
	_ = sha256.Sum256
	_ = hex.EncodeToString
	_ = json.Marshal
	_ = strings.Fields
	_ = time.Second
	_ = db.Pool
	_ = config.TopK
	_ = embed.Embed
	select {}
}
`,
      solution: `// The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"assistant/chunk"  // chunk.Chunk(text) []string
	"assistant/config" // config.CacheTTL (seconds), config.TopK
	"assistant/db"     // db.Pool *sql.DB (database/sql, lib/pq)
	"assistant/embed"  // embed.Embed(text) []float64, embed.ToPgvector(v) string
	"assistant/kb"     // kb.Articles []kb.Article{ID, Title, Body}
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Hit struct {
	ID    string  \`json:"id"\`
	Text  string  \`json:"text"\`
	Score float64 \`json:"score"\`
}

type CachedAnswer struct {
	Answer  string   \`json:"answer"\`
	Sources []string \`json:"sources"\`
}

// indexArticles chunks, embeds and stores every article; the number of chunks inserted. Safe to run again.
func indexArticles(ctx context.Context, articles []kb.Article) (int, error) {
	tx, err := db.Pool.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	inserted := 0
	for _, a := range articles {
		for position, text := range chunk.Chunk(a.Body) {
			res, err := tx.ExecContext(ctx,
				"INSERT INTO kb_chunks (id, article, position, text, embedding) VALUES ($1, $2, $3, $4, $5::vector) ON CONFLICT (id) DO NOTHING",
				fmt.Sprintf("%s-%d", a.ID, position), a.ID, position, text, embed.ToPgvector(embed.Embed(text)))
			if err != nil {
				return 0, err
			}
			n, err := res.RowsAffected()
			if err != nil {
				return 0, err
			}
			inserted += int(n)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return inserted, nil
}

// search returns the k chunks nearest to the question, best first.
func search(ctx context.Context, question string, k int) ([]Hit, error) {
	q := embed.ToPgvector(embed.Embed(question))
	rows, err := db.Pool.QueryContext(ctx,
		"SELECT id, text, embedding <=> $1::vector AS distance FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT $2",
		q, k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []Hit{}
	for rows.Next() {
		var h Hit
		var distance float64
		if err := rows.Scan(&h.ID, &h.Text, &distance); err != nil {
			return nil, err
		}
		h.Score = 1 - distance
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// normalise lower-cases, collapses whitespace and trims.
func normalise(question string) string {
	return strings.Join(strings.Fields(strings.ToLower(question)), " ")
}

func cacheKey(question string) string {
	sum := sha256.Sum256([]byte(normalise(question)))
	return "answer:" + hex.EncodeToString(sum[:])
}

// cachedAnswer is the {answer, sources} remembered for this question, or nil.
func cachedAnswer(ctx context.Context, question string) (*CachedAnswer, error) {
	raw, err := rdb.Get(ctx, cacheKey(question)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out CachedAnswer
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func rememberAnswer(ctx context.Context, question, answer string, sources []string) error {
	value, _ := json.Marshal(CachedAnswer{Answer: answer, Sources: sources})
	return rdb.Set(ctx, cacheKey(question), value, time.Duration(config.CacheTTL)*time.Second).Err()
}

func main() {
	_ = config.TopK
	select {}
}
`,
    },
    scala: {
      starter: `/** The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis. */
import java.security.MessageDigest

import play.api.libs.json.{Json, JsValue}
import redis.clients.jedis.JedisPooled

import assistant.{Chunk, Config, Db, Embed, Kb}
// Chunk.chunk(text): Seq[String] · Embed.embed(text): Array[Double] · Embed.toPgvector(v): String
// Db.withConnection { conn => ... } (JDBC) · Config.CacheTtlS, Config.TopK · Kb.articles: Seq[Kb.Article]

final case class Hit(id: String, text: String, score: Double)
final case class CachedAnswer(answer: String, sources: Seq[String])

object KbSearch {
  val jedis = new JedisPooled("redis", 6379)

  /** Chunk, embed and store every article; the number of chunks inserted. Safe to run again. */
  def indexArticles(articles: Seq[Kb.Article] = Kb.articles): Int = {
    // TODO: for each article, for (text, position) <- Chunk.chunk(body).zipWithIndex:
    // TODO:   id s"$article-$position", the vector as Embed.toPgvector(Embed.embed(text)) cast to vector
    // TODO:   one INSERT per chunk, idempotent on the id; sum executeUpdate()
    ???
  }

  /** The k chunks nearest to the question, best first. */
  def search(question: String, k: Int = Config.TopK): Seq[Hit] = {
    // TODO: embed the question; SELECT id, text and the cosine distance, ordered by it, bounded by k
    // TODO: score = 1 - distance
    ???
  }

  /** Lower-cased, whitespace collapsed to single spaces, trimmed. */
  def normalise(question: String): String = ??? // TODO

  def cacheKey(question: String): String = ??? // TODO: "answer:" + sha256 hex of the normalised question

  /** The {answer, sources} remembered for this question, or None. */
  def cachedAnswer(question: String): Option[CachedAnswer] = ??? // TODO: GET the key; a miss is None

  def rememberAnswer(question: String, answer: String, sources: Seq[String]): Unit = ??? // TODO: SETEX the JSON {answer, sources} for Config.CacheTtlS
}
`,
      solution: `/** The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis. */
import java.security.MessageDigest

import play.api.libs.json.{Json, JsValue}
import redis.clients.jedis.JedisPooled

import assistant.{Chunk, Config, Db, Embed, Kb}
// Chunk.chunk(text): Seq[String] · Embed.embed(text): Array[Double] · Embed.toPgvector(v): String
// Db.withConnection { conn => ... } (JDBC) · Config.CacheTtlS, Config.TopK · Kb.articles: Seq[Kb.Article]

final case class Hit(id: String, text: String, score: Double)
final case class CachedAnswer(answer: String, sources: Seq[String])

object KbSearch {
  val jedis = new JedisPooled("redis", 6379)

  /** Chunk, embed and store every article; the number of chunks inserted. Safe to run again. */
  def indexArticles(articles: Seq[Kb.Article] = Kb.articles): Int = Db.withConnection { conn =>
    conn.setAutoCommit(false)
    val stmt = conn.prepareStatement(
      "INSERT INTO kb_chunks (id, article, position, text, embedding) VALUES (?, ?, ?, ?, CAST(? AS vector)) ON CONFLICT (id) DO NOTHING")
    var inserted = 0
    for (a <- articles; (text, position) <- Chunk.chunk(a.body).zipWithIndex) {
      stmt.setString(1, s"\${a.id}-$position"); stmt.setString(2, a.id); stmt.setInt(3, position)
      stmt.setString(4, text); stmt.setString(5, Embed.toPgvector(Embed.embed(text)))
      inserted += stmt.executeUpdate()
    }
    conn.commit()
    inserted
  }

  /** The k chunks nearest to the question, best first. */
  def search(question: String, k: Int = Config.TopK): Seq[Hit] = Db.withConnection { conn =>
    val q = Embed.toPgvector(Embed.embed(question))
    val stmt = conn.prepareStatement(
      "SELECT id, text, embedding <=> CAST(? AS vector) AS distance FROM kb_chunks ORDER BY embedding <=> CAST(? AS vector) LIMIT ?")
    stmt.setString(1, q); stmt.setString(2, q); stmt.setInt(3, k)
    val rs = stmt.executeQuery()
    val hits = Seq.newBuilder[Hit]
    while (rs.next()) hits += Hit(rs.getString("id"), rs.getString("text"), 1.0 - rs.getDouble("distance"))
    hits.result()
  }

  /** Lower-cased, whitespace collapsed to single spaces, trimmed. */
  def normalise(question: String): String = question.toLowerCase.trim.replaceAll("\\\\s+", " ")

  def cacheKey(question: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(normalise(question).getBytes("UTF-8"))
    "answer:" + digest.map("%02x".format(_)).mkString
  }

  /** The {answer, sources} remembered for this question, or None. */
  def cachedAnswer(question: String): Option[CachedAnswer] =
    Option(jedis.get(cacheKey(question))).map { raw =>
      val js: JsValue = Json.parse(raw)
      CachedAnswer((js \\ "answer").as[String], (js \\ "sources").as[Seq[String]])
    }

  def rememberAnswer(question: String, answer: String, sources: Seq[String]): Unit = {
    val value = Json.stringify(Json.obj("answer" -> answer, "sources" -> sources))
    jedis.setex(cacheKey(question), Config.CacheTtlS, value)
  }
}
`,
    },
    cpp: {
      starter: `// The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis.
#include <pqxx/pqxx>
#include <sw/redis++/redis++.h>

#include <cctype>
#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "assistant/chunk.h"   // std::vector<std::string> assistant::chunk(const std::string&)
#include "assistant/config.h"  // assistant::kCacheTtlS, assistant::kTopK
#include "assistant/db.h"      // pqxx::connection& assistant::db()
#include "assistant/embed.h"   // assistant::embed(text) -> std::vector<double>; assistant::to_pgvector(v) -> std::string
#include "assistant/kb.h"      // assistant::Article{id, title, body}; assistant::articles()
#include "digest.h"            // std::string sha256_hex(const std::string& bytes);

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");
constexpr std::chrono::seconds kCacheTtl{assistant::kCacheTtlS};

struct Hit {
  std::string id;
  std::string text;
  double score;
};

struct CachedAnswer {
  std::string answer;
  std::vector<std::string> sources;
};

// Chunk, embed and store every article; the number of chunks inserted. Safe to run again.
int index_articles(const std::vector<assistant::Article>& articles) {
  // TODO: for each article, for position, text in assistant::chunk(body):
  // TODO:   id "<article>-<position>", the vector as assistant::to_pgvector(assistant::embed(text)) cast ::vector
  // TODO:   one INSERT per chunk, idempotent on the id; sum affected_rows()
  throw std::runtime_error("not implemented");
}

// The k chunks nearest to the question, best first.
std::vector<Hit> search(const std::string& question, int k = assistant::kTopK) {
  // TODO: embed the question; SELECT id, text and the cosine distance, ordered by it, bounded by k
  // TODO: score = 1 - distance
  throw std::runtime_error("not implemented");
}

// Lower-cased, whitespace collapsed to single spaces, trimmed.
std::string normalise(const std::string& question) {
  throw std::runtime_error("not implemented");  // TODO
}

std::string cache_key(const std::string& question) {
  throw std::runtime_error("not implemented");  // TODO: "answer:" + sha256 hex of the normalised question
}

// The {answer, sources} remembered for this question, or nullopt.
std::optional<CachedAnswer> cached_answer(const std::string& question) {
  throw std::runtime_error("not implemented");  // TODO: GET the key; a miss is nullopt
}

void remember_answer(const std::string& question, const std::string& answer, const std::vector<std::string>& sources) {
  throw std::runtime_error("not implemented");  // TODO: SET the key to the JSON {answer, sources} with EX kCacheTtl
}
`,
      solution: `// The knowledge base and the answer cache: chunks and vectors in Postgres, the nearest ones by pgvector, answers remembered in Redis.
#include <pqxx/pqxx>
#include <sw/redis++/redis++.h>

#include <cctype>
#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "assistant/chunk.h"   // std::vector<std::string> assistant::chunk(const std::string&)
#include "assistant/config.h"  // assistant::kCacheTtlS, assistant::kTopK
#include "assistant/db.h"      // pqxx::connection& assistant::db()
#include "assistant/embed.h"   // assistant::embed(text) -> std::vector<double>; assistant::to_pgvector(v) -> std::string
#include "assistant/kb.h"      // assistant::Article{id, title, body}; assistant::articles()
#include "digest.h"            // std::string sha256_hex(const std::string& bytes);

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");
constexpr std::chrono::seconds kCacheTtl{assistant::kCacheTtlS};

struct Hit {
  std::string id;
  std::string text;
  double score;
};

struct CachedAnswer {
  std::string answer;
  std::vector<std::string> sources;
};

// Chunk, embed and store every article; the number of chunks inserted. Safe to run again.
int index_articles(const std::vector<assistant::Article>& articles) {
  pqxx::work tx(assistant::db());
  int inserted = 0;
  for (const auto& a : articles) {
    const auto chunks = assistant::chunk(a.body);
    for (std::size_t position = 0; position < chunks.size(); ++position) {
      const auto res = tx.exec_params(
          "INSERT INTO kb_chunks (id, article, position, text, embedding) VALUES ($1, $2, $3, $4, $5::vector) ON CONFLICT (id) DO NOTHING",
          a.id + "-" + std::to_string(position), a.id, static_cast<int>(position), chunks[position],
          assistant::to_pgvector(assistant::embed(chunks[position])));
      inserted += static_cast<int>(res.affected_rows());
    }
  }
  tx.commit();
  return inserted;
}

// The k chunks nearest to the question, best first.
std::vector<Hit> search(const std::string& question, int k = assistant::kTopK) {
  const std::string q = assistant::to_pgvector(assistant::embed(question));
  pqxx::read_transaction tx(assistant::db());
  const auto rows = tx.exec_params(
      "SELECT id, text, embedding <=> $1::vector AS distance FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT $2", q, k);
  std::vector<Hit> hits;
  hits.reserve(rows.size());
  for (const auto& row : rows) {
    hits.push_back({row["id"].as<std::string>(), row["text"].as<std::string>(), 1.0 - row["distance"].as<double>()});
  }
  return hits;
}

// Lower-cased, whitespace collapsed to single spaces, trimmed.
std::string normalise(const std::string& question) {
  std::string out;
  bool pending_space = false;
  for (unsigned char c : question) {
    if (std::isspace(c)) {
      pending_space = !out.empty();
      continue;
    }
    if (pending_space) out.push_back(' ');
    pending_space = false;
    out.push_back(static_cast<char>(std::tolower(c)));
  }
  return out;
}

std::string cache_key(const std::string& question) { return "answer:" + sha256_hex(normalise(question)); }

// The {answer, sources} remembered for this question, or nullopt.
std::optional<CachedAnswer> cached_answer(const std::string& question) {
  const auto raw = redis.get(cache_key(question));
  if (!raw) return std::nullopt;
  const json j = json::parse(*raw);
  return CachedAnswer{j.at("answer").get<std::string>(), j.at("sources").get<std::vector<std::string>>()};
}

void remember_answer(const std::string& question, const std::string& answer, const std::vector<std::string>& sources) {
  const json value = {{"answer", answer}, {"sources", sources}};
  redis.set(cache_key(question), value.dump(), kCacheTtl);
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

from assistant import chunk, embed, kb
from assistant.config import CACHE_TTL_S
from assistant.db import SCHEMA

PAY_Q = "Payout missing after five business days — bank details on file?"
LOGIN_Q = "Forgot Password reset email, two-factor code, account locked"


def expected_chunks():
    """Every (id, article, position, text) the knowledge base chunks into, computed without the learner."""
    out = []
    for a in kb.ARTICLES:
        for position, text in enumerate(chunk.chunk(a["body"])):
            out.append((f"{a['id']}-{position}", a["id"], position, text))
    return out


def expected_ranking(question, k):
    """The spec, independently: cosine of the question against every chunk, best first."""
    q = embed.embed(question)
    scored = sorted(((embed.cosine(q, embed.embed(text)), cid) for cid, _, _, text in expected_chunks()), key=lambda s: -s[0])
    return scored[:k]


def as_vector(value):
    return embed.from_pgvector(value) if isinstance(value, str) else [float(x) for x in value]


async def indexed(ctx):
    await ctx.db.reset(SCHEMA)
    m = ctx.load("kb_search")
    try:
        n = await m.index_articles(kb.ARTICLES)
    except Exception as exc:
        raise AssertionError(f"index_articles(kb.ARTICLES) crashed with {type(exc).__name__}: {exc}")
    return m, n


async def check_index_chunks(ctx):
    m, n = await indexed(ctx)
    want = expected_chunks()
    rows = await ctx.db.execute("SELECT id, article, position, text, embedding FROM kb_chunks ORDER BY article, position")
    assert len(rows) == len(want), f"the ten articles chunk into {len(want)} windows (chunk.chunk, 48 words, overlap 12), kb_chunks holds {len(rows)} row(s)"
    assert n == len(want), f"index_articles must return the number of chunks it inserted ({len(want)}), it returned {n!r}"
    got = sorted((r["id"], r["article"], r["position"], r["text"]) for r in rows)
    assert got == sorted(want), f"kb_chunks must hold one row per chunk with id <article>-<position>; ids found: {sorted(r['id'] for r in rows)}"
    for r in rows:
        v = as_vector(r["embedding"])
        assert len(v) == 512, f"chunk {r['id']} must carry a 512-dimensional embedding, found {len(v)} dimensions"
        want_v = embed.embed(r["text"])
        assert embed.cosine(v, want_v) > 0.999, f"chunk {r['id']}'s stored vector is not embed.embed(text): cosine {embed.cosine(v, want_v):.3f} against the expected vector"
    again = await m.index_articles(kb.ARTICLES)
    count = (await ctx.db.execute("SELECT count(*) AS n FROM kb_chunks"))[0]["n"]
    assert int(count) == len(want), f"indexing twice must leave the table unchanged ({len(want)} rows): ON CONFLICT (id) DO NOTHING — found {count}"
    assert again == 0, f"a second index_articles inserts nothing, so it returns 0, not {again!r}"


async def check_nearest_chunks(ctx):
    m, _ = await indexed(ctx)
    for question, article, k in ((PAY_Q, "pay", 4), (LOGIN_Q, "login", 3)):
        hits = await m.search(question, k)
        assert isinstance(hits, list) and len(hits) == k, f"search({question!r}, k={k}) must return exactly {k} chunks, got {hits if not isinstance(hits, list) else len(hits)}"
        for h in hits:
            assert isinstance(h, dict) and {"id", "text", "score"} <= set(h), f"each hit is a dict with id, text and score, got {h!r}"
            assert 0 < h["score"] <= 1 + 1e-6, f"score is 1 - cosine distance, in (0, 1]: chunk {h['id']} scored {h['score']}"
        assert hits[0]["id"].startswith(article + "-"), f"for {question!r} the best chunk must come from the '{article}' article, got {[h['id'] for h in hits]}"
        scores = [h["score"] for h in hits]
        assert scores == sorted(scores, reverse=True), f"hits must come best first, scores were {scores}"
        want = expected_ranking(question, k)
        assert sorted(h["id"] for h in hits) == sorted(cid for _, cid in want), f"the {k} nearest chunks to {question!r} are {[cid for _, cid in want]}, search returned {[h['id'] for h in hits]}"
        for h, (score, cid) in zip(hits, want):
            assert abs(h["score"] - score) < 1e-3, f"chunk {h['id']} must score 1 - distance = {score:.4f}, got {h['score']}"
        texts = {cid: text for cid, _, _, text in expected_chunks()}
        for h in hits:
            assert h["text"] == texts[h["id"]], f"hit {h['id']} must carry the chunk's text, got {h['text'][:60]!r}…"
    one = await m.search(PAY_Q, 1)
    assert len(one) == 1 and one[0]["id"].startswith("pay-"), f"k=1 returns the single best chunk, got {[h['id'] for h in one]}"


async def check_ranked_in_database(ctx):
    m, _ = await indexed(ctx)
    before = len(ctx.db.queries)
    hits = await m.search(PAY_Q, 4)
    assert len(hits) == 4, f"search must return 4 chunks, got {len(hits)}"
    during = [sql for sql, _ in ctx.db.queries[before:]]
    selects = [sql for sql in during if "kb_chunks" in sql.lower() and sql.strip().lower().startswith("select")]
    assert selects, f"search must query kb_chunks; the statements it ran were {during}"
    assert any("<=>" in sql for sql in selects), f"the nearest-neighbour ranking belongs to Postgres: use pgvector's <=> operator; the statements were {selects}"
    for sql in selects:
        assert "limit" in sql.lower(), f"a SELECT on kb_chunks without a LIMIT pulls every chunk into the process to sort it there; let the database rank and bound: {sql}"
    assert len(selects) == 1, f"one query answers a search; {len(selects)} SELECTs on kb_chunks ran: {selects}"


def _key(question):
    return "answer:" + hashlib.sha256(" ".join(question.lower().split()).encode()).hexdigest()


async def check_cache_key(ctx):
    m = ctx.load("kb_search")
    key = m.cache_key("How do I get paid?")
    assert key == _key("How do I get paid?"), f"cache_key must be 'answer:' + sha256 hex of the normalised question, got {key!r}"
    for variant in ("  how do i   get PAID? ", "HOW DO I GET PAID?", "how\\tdo i get paid?\\n"):
        assert m.cache_key(variant) == key, f"{variant!r} is the same question once lower-cased, whitespace-collapsed and trimmed, but it got the key {m.cache_key(variant)!r} instead of {key!r}"
    assert m.cache_key("How do I get a tip?") != key, "a different question must have a different key"
    await m.remember_answer("How do I get paid?", "Weekly, on Mondays [kb:pay-0].", ["pay-0"])
    assert ctx.redis.keys("*") == [key], f"remember_answer must write exactly the key {key}, Redis holds {ctx.redis.keys('*')}"


async def check_cache_round_trip(ctx):
    m = ctx.load("kb_search")
    assert await m.cached_answer("When do I get paid?") is None, "nothing has been remembered yet: cached_answer must be None"
    await m.remember_answer("When do I get paid?", "Weekly, on Mondays [kb:pay-0].", ["pay-0", "pay-1"])
    hit = await m.cached_answer("  when DO i get   paid? ")
    assert hit == {"answer": "Weekly, on Mondays [kb:pay-0].", "sources": ["pay-0", "pay-1"]}, f"the same question written differently must hit with {{answer, sources}}, got {hit!r}"
    key = _key("When do I get paid?")
    raw = ctx.redis.get(key)
    assert raw is not None, f"the answer must be stored under {key}, Redis holds {ctx.redis.keys('*')}"
    assert json.loads(raw) == hit, f"the stored value must be the JSON {{answer, sources}}, it is {raw!r}"
    ttl = ctx.redis.ttl(key)
    assert CACHE_TTL_S - 5 <= ttl <= CACHE_TTL_S, f"the cached answer must expire after CACHE_TTL_S = {CACHE_TTL_S} s, its TTL is {ttl}"
    assert await m.cached_answer("How do tips work?") is None, "a different question must still miss"
    ctx.clock.advance(CACHE_TTL_S + 1)
    assert await m.cached_answer("When do I get paid?") is None, "after CACHE_TTL_S the answer must be gone"
`,
    typescript: `import {createHash} from 'node:crypto';

const PAY_Q = 'Payout missing after five business days — bank details on file?';
const LOGIN_Q = 'Forgot Password reset email, two-factor code, account locked';

function support(ctx) {
  return {
    chunk: ctx.load('/support/assistant/chunk.ts'),
    embed: ctx.load('/support/assistant/embed.ts'),
    kb: ctx.load('/support/assistant/kb.ts'),
    config: ctx.load('/support/assistant/config.ts'),
    SCHEMA: ctx.load('/support/assistant/db.ts').SCHEMA,
  };
}

/** Every [id, article, position, text] the knowledge base chunks into, computed without the learner. */
function expectedChunks(ctx): [string, string, number, string][] {
  const {chunk, kb} = support(ctx);
  const out: [string, string, number, string][] = [];
  for (const a of kb.ARTICLES) for (const [position, text] of chunk.chunk(a.body).entries()) out.push([\`\${a.id}-\${position}\`, a.id, position, text]);
  return out;
}

/** The spec, independently: cosine of the question against every chunk, best first. */
function expectedRanking(ctx, question: string, k: number): [number, string][] {
  const {embed} = support(ctx);
  const q = embed.embed(question);
  return expectedChunks(ctx)
    .map(([id, , , text]) => [embed.cosine(q, embed.embed(text)), id] as [number, string])
    .sort((a, b) => b[0] - a[0])
    .slice(0, k);
}

function asVector(ctx, value: unknown): number[] {
  const {embed} = support(ctx);
  return typeof value === 'string' ? embed.fromPgvector(value) : (value as unknown[]).map(Number);
}

async function indexed(ctx) {
  const {SCHEMA, kb} = support(ctx);
  await ctx.db.reset(SCHEMA);
  const m = ctx.load('kb_search');
  let n: number;
  try {
    n = await m.indexArticles(kb.ARTICLES);
  } catch (e) {
    assert.fail(\`indexArticles(ARTICLES) crashed: \${e instanceof Error ? e.message : String(e)}\`);
  }
  return {m, n};
}

export async function check_index_chunks(ctx) {
  const {m, n} = await indexed(ctx);
  const {embed, kb} = support(ctx);
  const want = expectedChunks(ctx);
  const rows = await ctx.db.execute('SELECT id, article, position, text, embedding FROM kb_chunks ORDER BY article, position');
  assert.equal(rows.length, want.length, \`the ten articles chunk into \${want.length} windows (chunk(), 48 words, overlap 12), kb_chunks holds \${rows.length} row(s)\`);
  assert.equal(n, want.length, \`indexArticles must return the number of chunks it inserted (\${want.length}), it returned \${JSON.stringify(n)}\`);
  const got = rows.map(r => [r.id, r.article, Number(r.position), r.text]).sort();
  assert.deepEqual(got, [...want].sort(), \`kb_chunks must hold one row per chunk with id <article>-<position>; ids found: \${JSON.stringify(rows.map(r => r.id).sort())}\`);
  for (const r of rows) {
    const v = asVector(ctx, r.embedding);
    assert.equal(v.length, 512, \`chunk \${r.id} must carry a 512-dimensional embedding, found \${v.length} dimensions\`);
    const wantV = embed.embed(r.text);
    assert(embed.cosine(v, wantV) > 0.999, \`chunk \${r.id}'s stored vector is not embed(text): cosine \${embed.cosine(v, wantV).toFixed(3)} against the expected vector\`);
  }
  const again = await m.indexArticles(kb.ARTICLES);
  const [{n: count}] = await ctx.db.execute('SELECT count(*) AS n FROM kb_chunks');
  assert.equal(Number(count), want.length, \`indexing twice must leave the table unchanged (\${want.length} rows): ON CONFLICT (id) DO NOTHING — found \${count}\`);
  assert.equal(again, 0, \`a second indexArticles inserts nothing, so it returns 0, not \${JSON.stringify(again)}\`);
}

export async function check_nearest_chunks(ctx) {
  const {m} = await indexed(ctx);
  const texts = new Map(expectedChunks(ctx).map(([id, , , text]) => [id, text]));
  for (const [question, article, k] of [[PAY_Q, 'pay', 4], [LOGIN_Q, 'login', 3]] as [string, string, number][]) {
    const hits = await m.search(question, k);
    assert(Array.isArray(hits) && hits.length === k, \`search(\${JSON.stringify(question)}, \${k}) must return exactly \${k} chunks, got \${Array.isArray(hits) ? hits.length : JSON.stringify(hits)}\`);
    for (const h of hits) {
      assert(h && typeof h.id === 'string' && typeof h.text === 'string' && typeof h.score === 'number', \`each hit is {id, text, score}, got \${JSON.stringify(h)}\`);
      assert(h.score > 0 && h.score <= 1 + 1e-6, \`score is 1 - cosine distance, in (0, 1]: chunk \${h.id} scored \${h.score}\`);
    }
    assert(hits[0].id.startsWith(article + '-'), \`for \${JSON.stringify(question)} the best chunk must come from the '\${article}' article, got \${JSON.stringify(hits.map(h => h.id))}\`);
    const scores = hits.map(h => h.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), \`hits must come best first, scores were \${JSON.stringify(scores)}\`);
    const want = expectedRanking(ctx, question, k);
    assert.deepEqual(hits.map(h => h.id).sort(), want.map(([, id]) => id).sort(), \`the \${k} nearest chunks to \${JSON.stringify(question)} are \${JSON.stringify(want.map(([, id]) => id))}, search returned \${JSON.stringify(hits.map(h => h.id))}\`);
    hits.forEach((h, i) => assert(Math.abs(h.score - want[i][0]) < 1e-3, \`chunk \${h.id} must score 1 - distance = \${want[i][0].toFixed(4)}, got \${h.score}\`));
    for (const h of hits) assert.equal(h.text, texts.get(h.id), \`hit \${h.id} must carry the chunk's text, got \${JSON.stringify(h.text.slice(0, 60))}…\`);
  }
  const one = await m.search(PAY_Q, 1);
  assert(one.length === 1 && one[0].id.startsWith('pay-'), \`k=1 returns the single best chunk, got \${JSON.stringify(one.map(h => h.id))}\`);
}

export async function check_ranked_in_database(ctx) {
  const {m} = await indexed(ctx);
  const before = ctx.db.queries.length;
  const hits = await m.search(PAY_Q, 4);
  assert.equal(hits.length, 4, \`search must return 4 chunks, got \${hits.length}\`);
  const during: string[] = ctx.db.queries.slice(before).map(([sql]) => sql);
  const selects = during.filter(sql => sql.toLowerCase().includes('kb_chunks') && sql.trim().toLowerCase().startsWith('select'));
  assert(selects.length > 0, \`search must query kb_chunks; the statements it ran were \${JSON.stringify(during)}\`);
  assert(selects.some(sql => sql.includes('<=>')), \`the nearest-neighbour ranking belongs to Postgres: use pgvector's <=> operator; the statements were \${JSON.stringify(selects)}\`);
  for (const sql of selects) assert(sql.toLowerCase().includes('limit'), \`a SELECT on kb_chunks without a LIMIT pulls every chunk into the process to sort it there; let the database rank and bound: \${sql}\`);
  assert.equal(selects.length, 1, \`one query answers a search; \${selects.length} SELECTs on kb_chunks ran: \${JSON.stringify(selects)}\`);
}

const keyOf = (question: string) => 'answer:' + createHash('sha256').update(question.toLowerCase().trim().replace(/\\s+/g, ' ')).digest('hex');

export async function check_cache_key(ctx) {
  const m = ctx.load('kb_search');
  const key = m.cacheKey('How do I get paid?');
  assert.equal(key, keyOf('How do I get paid?'), \`cacheKey must be 'answer:' + sha256 hex of the normalised question, got \${JSON.stringify(key)}\`);
  for (const variant of ['  how do i   get PAID? ', 'HOW DO I GET PAID?', 'how\\tdo i get paid?\\n']) {
    assert.equal(m.cacheKey(variant), key, \`\${JSON.stringify(variant)} is the same question once lower-cased, whitespace-collapsed and trimmed, but it got the key \${JSON.stringify(m.cacheKey(variant))} instead of \${JSON.stringify(key)}\`);
  }
  assert.notEqual(m.cacheKey('How do I get a tip?'), key, 'a different question must have a different key');
  await m.rememberAnswer('How do I get paid?', 'Weekly, on Mondays [kb:pay-0].', ['pay-0']);
  assert.deepEqual(ctx.redis.keys('*'), [key], \`rememberAnswer must write exactly the key \${key}, Redis holds \${JSON.stringify(ctx.redis.keys('*'))}\`);
}

export async function check_cache_round_trip(ctx) {
  const m = ctx.load('kb_search');
  const {config} = support(ctx);
  assert.equal(await m.cachedAnswer('When do I get paid?'), null, 'nothing has been remembered yet: cachedAnswer must be null');
  await m.rememberAnswer('When do I get paid?', 'Weekly, on Mondays [kb:pay-0].', ['pay-0', 'pay-1']);
  const hit = await m.cachedAnswer('  when DO i get   paid? ');
  assert.deepEqual(hit, {answer: 'Weekly, on Mondays [kb:pay-0].', sources: ['pay-0', 'pay-1']}, \`the same question written differently must hit with {answer, sources}, got \${JSON.stringify(hit)}\`);
  const key = keyOf('When do I get paid?');
  const raw = ctx.redis.get(key);
  assert(raw !== null, \`the answer must be stored under \${key}, Redis holds \${JSON.stringify(ctx.redis.keys('*'))}\`);
  assert.deepEqual(JSON.parse(raw), hit, \`the stored value must be the JSON {answer, sources}, it is \${JSON.stringify(raw)}\`);
  const ttl = ctx.redis.ttl(key);
  assert(config.CACHE_TTL_S - 5 <= ttl && ttl <= config.CACHE_TTL_S, \`the cached answer must expire after CACHE_TTL_S = \${config.CACHE_TTL_S} s, its TTL is \${ttl}\`);
  assert.equal(await m.cachedAnswer('How do tips work?'), null, 'a different question must still miss');
  ctx.clock.advance(config.CACHE_TTL_S + 1);
  assert.equal(await m.cachedAnswer('When do I get paid?'), null, 'after CACHE_TTL_S the answer must be gone');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

	"assistant/chunk"
	"assistant/config"
	"assistant/db"
	"assistant/embed"
	"assistant/kb"

	"leetbuild/harness"
)

const (
	kbPayQ   = "Payout missing after five business days — bank details on file?"
	kbLoginQ = "Forgot Password reset email, two-factor code, account locked"
)

// kbRow is one chunk the knowledge base cuts into, computed without the learner.
type kbRow struct {
	id, article string
	position    int
	text        string
}

func kbExpectedChunks() []kbRow {
	var out []kbRow
	for _, a := range kb.Articles {
		for position, text := range chunk.Chunk(a.Body) {
			out = append(out, kbRow{fmt.Sprintf("%s-%d", a.ID, position), a.ID, position, text})
		}
	}
	return out
}

// kbRanked is a chunk id and its cosine with the question.
type kbRanked struct {
	score float64
	id    string
}

// kbExpectedRanking is the spec, independently: cosine of the question against every chunk, best first.
func kbExpectedRanking(question string, k int) []kbRanked {
	q := embed.Embed(question)
	var out []kbRanked
	for _, c := range kbExpectedChunks() {
		out = append(out, kbRanked{embed.Cosine(q, embed.Embed(c.text)), c.id})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	return out[:k]
}

// kbIndexed is a fresh schema with the knowledge base indexed by the learner; the count indexArticles returned.
func kbIndexed(ctx *harness.Ctx) int {
	ctx.DB.Reset(db.Schema)
	defer func() {
		if r := recover(); r != nil {
			ctx.Fatalf("indexArticles(kb.Articles) crashed: %v", r)
		}
	}()
	n, err := indexArticles(context.Background(), kb.Articles)
	if err != nil {
		ctx.Fatalf("indexArticles(kb.Articles) crashed: %v", err)
	}
	return n
}

func CheckIndexChunks(ctx *harness.Ctx) {
	n := kbIndexed(ctx)
	want := kbExpectedChunks()
	rows := ctx.DB.Query("SELECT id, article, position, text FROM kb_chunks ORDER BY article, position")
	ctx.Assert(len(rows) == len(want), "the ten articles chunk into %d windows (chunk.Chunk, 48 words, overlap 12), kb_chunks holds %d row(s)", len(want), len(rows))
	ctx.Assert(n == len(want), "indexArticles must return the number of chunks it inserted (%d), it returned %d", len(want), n)
	var got, wanted, ids []string
	for _, r := range rows {
		got = append(got, fmt.Sprintf("%v|%v|%v|%v", r["id"], r["article"], r["position"], r["text"]))
		ids = append(ids, fmt.Sprint(r["id"]))
	}
	for _, c := range want {
		wanted = append(wanted, fmt.Sprintf("%s|%s|%d|%s", c.id, c.article, c.position, c.text))
	}
	sort.Strings(got)
	sort.Strings(wanted)
	sort.Strings(ids)
	ctx.Assert(strings.Join(got, "\\n") == strings.Join(wanted, "\\n"), "kb_chunks must hold one row per chunk with id <article>-<position>; ids found: %q", ids)
	// Each stored vector is compared with embed.Embed(text) in Postgres (vector_dims, <=>) rather than parsed here.
	for _, r := range rows {
		text, _ := r["text"].(string)
		stored := ctx.DB.Query("SELECT vector_dims(embedding) AS dims, 1 - (embedding <=> $1::vector) AS cosine FROM kb_chunks WHERE id = $2", embed.ToPgvector(embed.Embed(text)), r["id"])[0]
		ctx.Assert(fmt.Sprint(stored["dims"]) == "512", "chunk %v must carry a 512-dimensional embedding, found %v dimensions", r["id"], stored["dims"])
		cos, _ := stored["cosine"].(float64)
		ctx.Assert(cos > 0.999, "chunk %v's stored vector is not embed.Embed(text): cosine %.3f against the expected vector", r["id"], cos)
	}
	again, err := indexArticles(context.Background(), kb.Articles)
	ctx.NoError(err, "indexArticles(kb.Articles) a second time")
	count := ctx.DB.Query("SELECT count(*) AS n FROM kb_chunks")[0]["n"]
	ctx.Assert(fmt.Sprint(count) == fmt.Sprint(len(want)), "indexing twice must leave the table unchanged (%d rows): ON CONFLICT (id) DO NOTHING — found %v", len(want), count)
	ctx.Assert(again == 0, "a second indexArticles inserts nothing, so it returns 0, not %d", again)
}

func CheckNearestChunks(ctx *harness.Ctx) {
	kbIndexed(ctx)
	texts := map[string]string{}
	for _, c := range kbExpectedChunks() {
		texts[c.id] = c.text
	}
	for _, tc := range []struct {
		question, article string
		k                 int
	}{{kbPayQ, "pay", 4}, {kbLoginQ, "login", 3}} {
		hits, err := search(context.Background(), tc.question, tc.k)
		ctx.NoError(err, "search(%q, %d)", tc.question, tc.k)
		ctx.Assert(len(hits) == tc.k, "search(%q, %d) must return exactly %d chunks, got %d", tc.question, tc.k, tc.k, len(hits))
		var got, scores []string
		for _, h := range hits {
			ctx.Assert(h.Score > 0 && h.Score <= 1+1e-6, "Score is 1 - cosine distance, in (0, 1]: chunk %s scored %v", h.ID, h.Score)
			got = append(got, h.ID)
		}
		ctx.Assert(strings.HasPrefix(hits[0].ID, tc.article+"-"), "for %q the best chunk must come from the '%s' article, got %q", tc.question, tc.article, got)
		for i, h := range hits {
			scores = append(scores, fmt.Sprint(h.Score))
			ctx.Assert(i == 0 || hits[i-1].Score >= h.Score, "hits must come best first, scores were %v", scores)
		}
		want := kbExpectedRanking(tc.question, tc.k)
		var wantIDs []string
		for _, r := range want {
			wantIDs = append(wantIDs, r.id)
		}
		gotSorted := append([]string(nil), got...)
		wantSorted := append([]string(nil), wantIDs...)
		sort.Strings(gotSorted)
		sort.Strings(wantSorted)
		ctx.Assert(strings.Join(gotSorted, ",") == strings.Join(wantSorted, ","), "the %d nearest chunks to %q are %q, search returned %q", tc.k, tc.question, wantIDs, got)
		for i, h := range hits {
			ctx.Assert(math.Abs(h.Score-want[i].score) < 1e-3, "chunk %s must score 1 - distance = %.4f, got %v", h.ID, want[i].score, h.Score)
		}
		for _, h := range hits {
			ctx.Equal(h.Text, texts[h.ID], "hit %s must carry the chunk's text", h.ID)
		}
	}
	one, err := search(context.Background(), kbPayQ, 1)
	ctx.NoError(err, "search(%q, 1)", kbPayQ)
	ctx.Assert(len(one) == 1 && strings.HasPrefix(one[0].ID, "pay-"), "k=1 returns the single best chunk, got %+v", one)
}

func CheckRankedInDatabase(ctx *harness.Ctx) {
	kbIndexed(ctx)
	before := len(ctx.DB.Queries())
	hits, err := search(context.Background(), kbPayQ, 4)
	ctx.NoError(err, "search(%q, 4)", kbPayQ)
	ctx.Equal(len(hits), 4, "search must return 4 chunks")
	var during, selects []string
	for _, q := range ctx.DB.Queries()[before:] {
		during = append(during, q.SQL)
		lower := strings.ToLower(q.SQL)
		if strings.Contains(lower, "kb_chunks") && strings.HasPrefix(strings.TrimSpace(lower), "select") {
			selects = append(selects, q.SQL)
		}
	}
	ctx.Assert(len(selects) > 0, "search must query kb_chunks; the statements it ran were %q", during)
	ranked := false
	for _, sql := range selects {
		ranked = ranked || strings.Contains(sql, "<=>")
	}
	ctx.Assert(ranked, "the nearest-neighbour ranking belongs to Postgres: use pgvector's <=> operator; the statements were %q", selects)
	for _, sql := range selects {
		ctx.Assert(strings.Contains(strings.ToLower(sql), "limit"), "a SELECT on kb_chunks without a LIMIT pulls every chunk into the process to sort it there; let the database rank and bound: %s", sql)
	}
	ctx.Assert(len(selects) == 1, "one query answers a search; %d SELECTs on kb_chunks ran: %q", len(selects), selects)
}

var kbSpaces = regexp.MustCompile(\`\\s+\`)

func kbKeyOf(question string) string {
	sum := sha256.Sum256([]byte(kbSpaces.ReplaceAllString(strings.TrimSpace(strings.ToLower(question)), " ")))
	return "answer:" + hex.EncodeToString(sum[:])
}

func CheckCacheKey(ctx *harness.Ctx) {
	key := cacheKey("How do I get paid?")
	ctx.Equal(key, kbKeyOf("How do I get paid?"), "cacheKey must be \\"answer:\\" + sha256 hex of the normalised question")
	for _, variant := range []string{"  how do i   get PAID? ", "HOW DO I GET PAID?", "how\\tdo i get paid?\\n"} {
		ctx.Assert(cacheKey(variant) == key, "%q is the same question once lower-cased, whitespace-collapsed and trimmed, but it got the key %q instead of %q", variant, cacheKey(variant), key)
	}
	ctx.Assert(cacheKey("How do I get a tip?") != key, "a different question must have a different key")
	ctx.NoError(rememberAnswer(context.Background(), "How do I get paid?", "Weekly, on Mondays [kb:pay-0].", []string{"pay-0"}), "rememberAnswer")
	ctx.Equal(ctx.Redis.Keys("*"), []string{key}, "rememberAnswer must write exactly the key %s", key)
}

func CheckCacheRoundTrip(ctx *harness.Ctx) {
	bg := context.Background()
	miss, err := cachedAnswer(bg, "When do I get paid?")
	ctx.NoError(err, "cachedAnswer")
	ctx.Assert(miss == nil, "nothing has been remembered yet: cachedAnswer must be nil, got %+v", miss)
	ctx.NoError(rememberAnswer(bg, "When do I get paid?", "Weekly, on Mondays [kb:pay-0].", []string{"pay-0", "pay-1"}), "rememberAnswer")
	hit, err := cachedAnswer(bg, "  when DO i get   paid? ")
	ctx.NoError(err, "cachedAnswer")
	want := CachedAnswer{Answer: "Weekly, on Mondays [kb:pay-0].", Sources: []string{"pay-0", "pay-1"}}
	ctx.Assert(hit != nil, "the same question written differently must hit with {answer, sources}, got nil")
	ctx.Equal(*hit, want, "the same question written differently must hit with {answer, sources}")
	key := kbKeyOf("When do I get paid?")
	raw, ok := ctx.Redis.Get(key)
	ctx.Assert(ok, "the answer must be stored under %s, Redis holds %q", key, ctx.Redis.Keys("*"))
	var stored CachedAnswer
	ctx.Assert(json.Unmarshal([]byte(raw), &stored) == nil && stored.Answer == hit.Answer && strings.Join(stored.Sources, ",") == strings.Join(hit.Sources, ","), "the stored value must be the JSON {answer, sources}, it is %q", raw)
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(config.CacheTTL-5 <= ttl && ttl <= config.CacheTTL, "the cached answer must expire after config.CacheTTL = %d s, its TTL is %d", config.CacheTTL, ttl)
	other, err := cachedAnswer(bg, "How do tips work?")
	ctx.NoError(err, "cachedAnswer")
	ctx.Assert(other == nil, "a different question must still miss")
	ctx.Clock.Advance(config.CacheTTL + 1)
	gone, err := cachedAnswer(bg, "When do I get paid?")
	ctx.NoError(err, "cachedAnswer")
	ctx.Assert(gone == nil, "after config.CacheTTL the answer must be gone")
}
`,
  },
  debrief: `Retrieval is a database problem before it is a model problem. Keeping the vectors in the same Postgres as the text means one store, one transaction for indexing, and a nearest-neighbour search that is just a query: \`ORDER BY embedding <=> $1 LIMIT k\` lets the planner use a vector index (HNSW or IVFFlat in production) and hands back four rows, not four thousand — the moment the code fetches the table and sorts it in memory, the knowledge base cannot grow. Cosine distance is the right metric for these vectors because they are normalised: direction is meaning, length is just how many words the chunk had; \`<=>\` is 1 − cosine, so ascending distance is descending similarity and \`score = 1 − distance\` reads naturally in a guardrail threshold. The cache is keyed by the question *after* normalisation and hashed, so a capital letter or a double space is not a miss, the key has a bounded length and the Dasher's words never become a Redis key; the value carries the sources with the answer, so a cached reply is as attributable as a fresh one, and the TTL bounds how long a stale article keeps answering. DoorDash's pipeline retrieves more than articles: the conversation is first summarised into an issue, and the top-N *similar past cases* are fetched alongside the knowledge-base segments, so the prompt carries what worked for the same problem before. Production also re-ranks the candidates with a cross-encoder, filters chunks by market and language, versions the index so a re-chunked article invalidates its cache entries, and treats "nothing close enough" as a signal to hand off rather than a reason to guess.`,
};
