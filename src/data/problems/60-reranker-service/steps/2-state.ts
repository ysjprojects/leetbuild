import type {Step} from '@/lib/types';

export const rerankStateStep: Step = {
  id: 'state',
  title: 'Redis score cache with pair keys',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'reranker'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads a cache, computes a
miss and writes it back. It works for one query and one model build, and it quietly serves the wrong
answer everywhere else. Review it like the service owner, fix it, and prove the fix with the checks
below.

A score is a function of **(query, passage, model version)** — change any one of the three and the
cached number is no longer the score of this comparison. Implement the score cache:

- Key every entry by \`rerank:score:{query_fingerprint}:{passage_hash}:{model_version}\`.
- A 32-hex digest of the UTF-8 bytes is a good fingerprint for both the query and the passage.
- Set a **30-minute TTL** (\`30 * 60\` seconds) when an entry is first written, because a score is
  only fresh relative to the model build that produced it.
- Read the whole batch at once (\`MGET\`) and recompute only the entries whose value is missing — a
  miss on **either half** of the pair is a miss.
- Write the recomputed entries back with the TTL, and return scores in the caller's candidate order.
- A model version bump must produce a different key, so the same pair gets a fresh score instead of
  the previous build's number.

**Failure mode the checks target.** The draft keys by passage hash alone, so the first query to
score a passage populates an entry every other query then receives; it never puts the model version
in the key, so a new build silently reuses old numbers; and it writes without a TTL, so a score
outlives the model that made it.`,
  sequence: {
    participants: ['Rerank API', 'Redis', 'Reranker model'],
    messages: [
      {from: 'Rerank API', to: 'Redis', label: 'MGET rerank:score:{qf}:{ph}:{version}…', kind: 'sync'},
      {from: 'Redis', to: 'Rerank API', label: 'values (nil = miss)', kind: 'reply'},
      {from: 'Rerank API', to: 'Reranker model', label: 'Rerank(missing only)', kind: 'sync'},
      {from: 'Reranker model', to: 'Rerank API', label: 'fresh scores', kind: 'reply'},
      {from: 'Rerank API', to: 'Redis', label: 'SET key score EX 1800', kind: 'async'},
      {from: 'Rerank API', to: 'Rerank API', label: 'merge cached + fresh in candidate order', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'cache-key',
      title: 'Keys scores by query fingerprint and passage hash',
      detail:
        'The cache key names the query fingerprint and the passage hash, so a score is stored for a pair rather than for a passage. The draft keys by the passage hash alone.',
      match: {
        python: {all: [/query_fingerprint/, /passage_hash/, /score_key/]},
        typescript: {all: [/queryFingerprint/, /passageHash/, /scoreKey/]},
        go: {all: [/queryFingerprint/, /passageHash/, /scoreKey/]},
        scala: {all: [/queryFingerprint/, /passageHash/, /scoreKey/]},
        cpp: {all: [/queryFingerprint/, /passageHash/, /scoreKey/]},
      },
    },
    {
      id: 'version-in-key',
      title: 'Includes the model version in the key',
      detail:
        'The key builder takes the model version, so a version bump is a different key and serves a fresh score for the same pair. The draft ignores the version.',
      match: {
        python: {all: [/def score_key\([^)]*model_version/]},
        typescript: {all: [/function scoreKey\([^)]*modelVersion/]},
        go: {all: [/func scoreKey\([^)]*modelVersion/]},
        scala: {all: [/def scoreKey\([^)]*modelVersion/]},
        cpp: {all: [/scoreKey\([^)]*modelVersion/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expires every entry after 30 minutes',
      detail:
        'Scores are written with a `30 * 60` second TTL, so a cached number cannot outlive the model build. The draft writes with no expiry.',
      match: {
        python: {all: [/SCORE_TTL_S/, /ex\s*=\s*SCORE_TTL_S/]},
        typescript: {all: [/SCORE_TTL_S/, /['"]EX['"]/]},
        go: {all: [/scoreTTLS/, /time\.Second/]},
        scala: {all: [/ScoreTtlS/, /setex/]},
        cpp: {all: [/kScoreTtl/, /std::chrono::seconds/]},
      },
    },
    {
      id: 'cache-aside',
      title: 'Reads the batch, writes only the misses',
      detail:
        'The batch is read in one `MGET` and the recomputed values are written back with the TTL. The draft reads one key at a time and never batches.',
      match: {
        python: {all: [/mget/, /\.set\(/]},
        typescript: {all: [/mget/, /\.set\(/]},
        go: {all: [/MGet/, /\.Set\(/]},
        scala: {all: [/mget/, /setex/]},
        cpp: {all: [/mget/, /\.set\(/]},
      },
    },
    {
      id: 'miss-recompute',
      title: 'Recomputes exactly the missing pair entries',
      detail:
        'Entries whose `MGET` value is nil are collected and recomputed; cached entries are returned untouched. The draft has no concept of a partial hit.',
      match: {
        python: {all: [/missing/, /compute_scores/]},
        typescript: {all: [/missing/, /computeScores/]},
        go: {all: [/missing/, /computeScores/]},
        scala: {all: [/missing/, /computeScores/]},
        cpp: {all: [/missing/, /computeScores/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

import redis as redis_lib

r = redis_lib.Redis()


def passage_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def score_key(text: str) -> str:
    # TODO: this draft keys by the passage hash alone, so one query's scores are served for every
    # other query, and it never distinguishes model versions. It also writes with no TTL.
    return "rerank:score:" + passage_hash(text)


def score_one(query: str, text: str, model_version: str) -> float:
    return 0.0


def cached_scores(query: str, candidates, model_version: str) -> list[float]:
    out = []
    for candidate in candidates:
        raw = r.get(score_key(candidate.text))
        if raw is None:
            score = score_one(query, candidate.text, model_version)
            r.set(score_key(candidate.text), score)
            raw = score
        out.append(float(raw))
    return out
`,
      solution: `import hashlib

import redis as redis_lib

r = redis_lib.Redis()

SCORE_TTL_S = 30 * 60


def query_fingerprint(query: str) -> str:
    return hashlib.sha256(query.encode("utf-8")).hexdigest()[:32]


def passage_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def score_key(query: str, text: str, model_version: str) -> str:
    return "rerank:score:" + query_fingerprint(query) + ":" + passage_hash(text) + ":" + model_version


def compute_scores(query: str, texts: list[str], model_version: str) -> list[float]:
    """The cross-encoder batch; step 3 turns this into the gRPC call with a deadline."""
    return [0.0 for _ in texts]


def cached_scores(query: str, candidates, model_version: str) -> list[float]:
    keys = [score_key(query, candidate.text, model_version) for candidate in candidates]
    values = r.mget(keys)
    missing = [candidate for candidate, value in zip(candidates, values) if value is None]
    fresh: dict[str, float] = {}
    if missing:
        computed = compute_scores(query, [candidate.text for candidate in missing], model_version)
        pipe = r.pipeline()
        for candidate, score in zip(missing, computed):
            key = score_key(query, candidate.text, model_version)
            pipe.set(key, score, ex=SCORE_TTL_S)
            fresh[key] = score
        pipe.execute()
    return [float(value) if value is not None else fresh[keys[i]] for i, value in enumerate(values)]
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

function passageHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

function scoreKey(text: string): string {
  // TODO: this draft keys by the passage hash alone, so one query's scores are served for every
  // other query, and it never distinguishes model versions. It also writes with no TTL.
  return 'rerank:score:' + passageHash(text);
}

function scoreOne(query: string, text: string, modelVersion: string): number {
  return 0;
}

export async function cachedScores(
  query: string,
  candidates: {passageId: string; text: string}[],
  modelVersion: string,
): Promise<number[]> {
  const out: number[] = [];
  for (const candidate of candidates) {
    let raw = await r.get(scoreKey(candidate.text));
    if (raw === null) {
      const score = scoreOne(query, candidate.text, modelVersion);
      raw = String(score);
      await r.set(scoreKey(candidate.text), raw);
    }
    out.push(Number(raw));
  }
  return out;
}
`,
      solution: `import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const SCORE_TTL_S = 30 * 60;

function queryFingerprint(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 32);
}

function passageHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

function scoreKey(query: string, text: string, modelVersion: string): string {
  return 'rerank:score:' + queryFingerprint(query) + ':' + passageHash(text) + ':' + modelVersion;
}

function computeScores(query: string, texts: string[], modelVersion: string): number[] {
  return texts.map(() => 0);
}

export async function cachedScores(
  query: string,
  candidates: {passageId: string; text: string}[],
  modelVersion: string,
): Promise<number[]> {
  const keys = candidates.map(candidate => scoreKey(query, candidate.text, modelVersion));
  const values = await r.mget(...keys);
  const missing: {passageId: string; text: string}[] = [];
  candidates.forEach((candidate, i) => {
    if (values[i] === null) missing.push(candidate);
  });
  const fresh = new Map<string, number>();
  if (missing.length > 0) {
    const computed = computeScores(query, missing.map(candidate => candidate.text), modelVersion);
    const pipe = r.pipeline();
    missing.forEach((candidate, i) => {
      const key = scoreKey(query, candidate.text, modelVersion);
      pipe.set(key, String(computed[i]), 'EX', SCORE_TTL_S);
      fresh.set(key, computed[i]);
    });
    await pipe.exec();
  }
  return values.map((value, i) => (value === null ? fresh.get(keys[i]) ?? 0 : Number(value)));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Candidate struct {
	PassageID string
	Text      string
}

func passageHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])[:32]
}

func scoreKey(text string) string {
	// TODO: this draft keys by the passage hash alone, so one query's scores are served for every
	// other query, and it never distinguishes model versions. It also writes with no TTL.
	return "rerank:score:" + passageHash(text)
}

func scoreOne(query, text, modelVersion string) float64 {
	return 0
}

func cachedScores(ctx context.Context, query string, candidates []Candidate, modelVersion string) ([]float64, error) {
	out := make([]float64, 0, len(candidates))
	for _, candidate := range candidates {
		raw, err := rdb.Get(ctx, scoreKey(candidate.Text)).Result()
		if err == redis.Nil {
			raw = strconv.FormatFloat(scoreOne(query, candidate.Text, modelVersion), 'f', -1, 64)
			rdb.Set(ctx, scoreKey(candidate.Text), raw, 0)
		} else if err != nil {
			return nil, err
		}
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const scoreTTLS = 30 * 60

type Candidate struct {
	PassageID string
	Text      string
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:32]
}

func queryFingerprint(query string) string {
	return digest(query)
}

func passageHash(text string) string {
	return digest(text)
}

func scoreKey(query, text, modelVersion string) string {
	return "rerank:score:" + queryFingerprint(query) + ":" + passageHash(text) + ":" + modelVersion
}

func computeScores(query string, texts []string, modelVersion string) []float64 {
	out := make([]float64, len(texts))
	return out
}

func cachedScores(ctx context.Context, query string, candidates []Candidate, modelVersion string) ([]float64, error) {
	keys := make([]string, len(candidates))
	for i, candidate := range candidates {
		keys[i] = scoreKey(query, candidate.Text, modelVersion)
	}
	values, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	missing := make([]Candidate, 0)
	missingAt := make([]int, 0)
	for i, value := range values {
		if value == nil {
			missing = append(missing, candidates[i])
			missingAt = append(missingAt, i)
		}
	}
	out := make([]float64, len(candidates))
	if len(missing) > 0 {
		texts := make([]string, len(missing))
		for i, candidate := range missing {
			texts[i] = candidate.Text
		}
		computed := computeScores(query, texts, modelVersion)
		pipe := rdb.Pipeline()
		for i, candidate := range missing {
			pipe.Set(ctx, scoreKey(query, candidate.Text, modelVersion), computed[i], time.Duration(scoreTTLS)*time.Second)
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return nil, err
		}
		for i, at := range missingAt {
			out[at] = computed[i]
		}
	}
	for i, value := range values {
		if value == nil {
			continue
		}
		parsed, err := strconv.ParseFloat(value.(string), 64)
		if err != nil {
			return nil, err
		}
		out[i] = parsed
	}
	return out, nil
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import redis.clients.jedis.Jedis

object ScoreCache {
  private val jedis = new Jedis("redis", 6379)

  def passageHash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString.take(32)

  def scoreKey(text: String): String =
    // TODO: this draft keys by the passage hash alone, so one query's scores are served for every
    // other query, and it never distinguishes model versions. It also writes with no TTL.
    "rerank:score:" + passageHash(text)

  def scoreOne(query: String, text: String, modelVersion: String): Double = 0.0

  def cachedScores(query: String, candidates: Seq[Candidate], modelVersion: String): Seq[Double] =
    candidates.map { candidate =>
      val raw = jedis.get(scoreKey(candidate.text))
      if (raw == null) {
        val score = scoreOne(query, candidate.text, modelVersion)
        jedis.set(scoreKey(candidate.text), score.toString)
        score
      } else raw.toDouble
    }
}
`,
      solution: `import java.security.MessageDigest

import redis.clients.jedis.Jedis

case class Candidate(passageId: String, text: String)

object ScoreCache {
  val ScoreTtlS = 30 * 60

  private val jedis = new Jedis("redis", 6379)

  def digest(value: String): String =
    MessageDigest.getInstance("SHA-256").digest(value.getBytes("UTF-8")).map("%02x".format(_)).mkString.take(32)

  def queryFingerprint(query: String): String = digest(query)

  def passageHash(text: String): String = digest(text)

  def scoreKey(query: String, text: String, modelVersion: String): String =
    "rerank:score:" + queryFingerprint(query) + ":" + passageHash(text) + ":" + modelVersion

  def computeScores(query: String, texts: Seq[String], modelVersion: String): Seq[Double] = texts.map(_ => 0.0)

  def cachedScores(query: String, candidates: Seq[Candidate], modelVersion: String): Seq[Double] = {
    val keys = candidates.map(candidate => scoreKey(query, candidate.text, modelVersion))
    val values = jedis.mget(keys: _*)
    val missing = candidates.zip(values).collect { case (candidate, null) => candidate }
    val fresh = scala.collection.mutable.Map.empty[String, Double]
    if (missing.nonEmpty) {
      val computed = computeScores(query, missing.map(_.text), modelVersion)
      missing.zip(computed).foreach { case (candidate, score) =>
        val key = scoreKey(query, candidate.text, modelVersion)
        jedis.setex(key, ScoreTtlS, score.toString)
        fresh(key) = score
      }
    }
    values.zipWithIndex.map { case (value, i) =>
      if (value != null) value.toDouble else fresh(keys(i))
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

struct Candidate {
  std::string passage_id;
  std::string text;
};

std::string digest(const std::string& value) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), hash);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char byte : hash) {
    out.push_back(hex[byte >> 4]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out.substr(0, 32);
}

std::string passageHash(const std::string& text) { return digest(text); }

std::string scoreKey(const std::string& text) {
  // TODO: this draft keys by the passage hash alone, so one query's scores are served for every
  // other query, and it never distinguishes model versions. It also writes with no TTL.
  return "rerank:score:" + passageHash(text);
}

double scoreOne(const std::string& query, const std::string& text, const std::string& modelVersion) {
  return 0.0;
}

std::vector<double> cachedScores(const std::string& query, const std::vector<Candidate>& candidates,
                                 const std::string& modelVersion) {
  std::vector<double> out;
  for (const auto& candidate : candidates) {
    const auto raw = redis.get(scoreKey(candidate.text));
    if (!raw) {
      const double score = scoreOne(query, candidate.text, modelVersion);
      redis.set(scoreKey(candidate.text), std::to_string(score));
      out.push_back(score);
    } else {
      out.push_back(std::stod(*raw));
    }
  }
  return out;
}
`,
      solution: `#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kScoreTtl = 30 * 60;
constexpr std::chrono::seconds kScoreTtlSeconds{kScoreTtl};

struct Candidate {
  std::string passage_id;
  std::string text;
};

std::string digest(const std::string& value) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(value.data()), value.size(), hash);
  static const char* hex = "0123456789abcdef";
  std::string out;
  for (unsigned char byte : hash) {
    out.push_back(hex[byte >> 4]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out.substr(0, 32);
}

std::string queryFingerprint(const std::string& query) { return digest(query); }

std::string passageHash(const std::string& text) { return digest(text); }

std::string scoreKey(const std::string& query, const std::string& text, const std::string& modelVersion) {
  return "rerank:score:" + queryFingerprint(query) + ":" + passageHash(text) + ":" + modelVersion;
}

std::vector<double> computeScores(const std::string& query, const std::vector<std::string>& texts,
                                  const std::string& modelVersion) {
  return std::vector<double>(texts.size(), 0.0);
}

std::vector<double> cachedScores(const std::string& query, const std::vector<Candidate>& candidates,
                                 const std::string& modelVersion) {
  std::vector<std::string> keys;
  keys.reserve(candidates.size());
  for (const auto& candidate : candidates) keys.push_back(scoreKey(query, candidate.text, modelVersion));
  const auto values = redis.mget(keys);
  std::vector<Candidate> missing;
  for (std::size_t i = 0; i < candidates.size(); ++i) {
    if (!values[i]) missing.push_back(candidates[i]);
  }
  std::unordered_map<std::string, double> fresh;
  if (!missing.empty()) {
    std::vector<std::string> texts;
    for (const auto& candidate : missing) texts.push_back(candidate.text);
    const auto computed = computeScores(query, texts, modelVersion);
    for (std::size_t i = 0; i < missing.size(); ++i) {
      const auto key = scoreKey(query, missing[i].text, modelVersion);
      redis.set(key, std::to_string(computed[i]), kScoreTtlSeconds);
      fresh[key] = computed[i];
    }
  }
  std::vector<double> out;
  out.reserve(candidates.size());
  for (std::size_t i = 0; i < candidates.size(); ++i) {
    out.push_back(values[i] ? std::stod(*values[i]) : fresh[keys[i]]);
  }
  return out;
}
`,
    },
  },
  hints: [
    'The cache key is the contract. If it does not name the query, the passage and the model version, it is not a key for a score — it is a key for a passage.',
    'Read the batch with one `MGET` and keep the nil positions; only those entries need the model. Writing with `EX` makes the entry expire even if a later step forgets to invalidate it.',
    'A version bump should be invisible to the caller: the same pair under a new version simply misses and recomputes, because the version is part of the key rather than a field beside it.',
  ],
  debrief: `The interviewer is testing whether you understand that a relevance score is not a property of a
passage. The draft reads fine because the demo reruns the same query against the same build. Three
defects are being checked: an incomplete pair key (query fingerprint missing), a missing model
version (so a new build silently reuses old numbers), and no TTL (so a score outlives the build that
made it). The batch read and the miss list are the operational half: a per-key loop issues N round
trips and, under a cold cache, N model calls instead of one. Real systems add a lock or single-flight
to collapse a stampede on one key, and they store the model version in the value as well so a
mismatched entry can be detected even when the key is right.`,
};
