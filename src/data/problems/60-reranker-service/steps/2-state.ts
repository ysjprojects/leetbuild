import type {Step} from '@/lib/types';

export const rerankStateStep: Step = {
  id: 'state',
  title: 'A Redis score cache keyed by query, passage and model version',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'reranker'],
  task: `## Task

**Starting point.** The starter's \`cached_scores(query, passages, model_version, compute)\` caches
scores in Redis: for each passage it \`GET\`s \`rerank:score:{fingerprint(passage)}\`, calls
\`compute([passage])\` on a miss, \`SET\`s the score back and returns the scores in passage order.
\`compute(passages)\` is the model call (step 3's client in the service; the checks hand in a
counting stand-in) and \`fingerprint\` comes from \`rerank.config\`. It serves the demo and hides 5
flaws.

**Failure mode the checks target.** A score belongs to a (query, passage, model version) triple. Keyed
by the passage alone, the first query to score a passage decides what every later query sees, and a
new model build serves the old build's numbers for as long as Redis keeps them, which is forever. A
200-candidate request also costs 200 round trips and up to 200 one-passage model calls.

- \`score_key(query, passage, model_version)\` is
  \`rerank:score:{fingerprint(query)}:{fingerprint(passage)}:{model_version}\`.
- Every entry is written with \`SCORE_TTL_S\` = 30 minutes.
- The batch is read with one \`MGET\`; \`compute(missing)\` runs once with exactly the passages that
  missed, in order; those are written back and the scores return in passage order.`,
  sequence: {
    participants: ['Rerank API', 'Redis', 'Reranker model'],
    messages: [
      {from: 'Rerank API', to: 'Redis', label: 'MGET rerank:score:{qf}:{pf}:{version} …', kind: 'sync'},
      {from: 'Redis', to: 'Rerank API', label: 'values (nil = miss)', kind: 'reply'},
      {from: 'Rerank API', to: 'Reranker model', label: 'compute(missing passages only)', kind: 'sync'},
      {from: 'Reranker model', to: 'Rerank API', label: 'fresh scores', kind: 'reply'},
      {from: 'Rerank API', to: 'Redis', label: 'SET key score EX 1800', kind: 'sync'},
      {from: 'Rerank API', to: 'Rerank API', label: 'merge cached + fresh in passage order', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'pair-key',
      title: 'Keys a score by the query and the passage',
      detail:
        "The key carries `fingerprint(query)` beside the passage fingerprint: a second query over the same passage is scored for itself, under `rerank:score:{qf}:{pf}:{version}`. The starter keys by the passage alone, so the second query reads the first one's score.",
      match: {
        python: {all: [/fingerprint\(\s*query\s*\)/]},
        typescript: {all: [/fingerprint\(\s*query\s*\)/]},
        go: {all: [/config\.Fingerprint\(\s*query\s*\)/]},
        scala: {all: [/Config\.fingerprint\(\s*query\s*\)/]},
        cpp: {all: [/config::fingerprint\(\s*query\s*\)/]},
      },
    },
    {
      id: 'version-in-key',
      title: 'Puts the model version in the key',
      detail:
        "A new `model_version` is a new key: the same pair under the next build is scored again, and the old build's entry stays where it was. The starter serves the old build's number.",
      match: {
        python: {all: [/def score_key\([^)]*model_version/]},
        typescript: {all: [/scoreKey\([^)]*modelVersion/]},
        go: {all: [/func scoreKey\([^)]*modelVersion/]},
        scala: {all: [/def scoreKey\([^)]*modelVersion/]},
        cpp: {all: [/scoreKey\([^)]*model_version/]},
      },
    },
    {
      id: 'score-ttl',
      title: 'Writes every score with a 30-minute TTL',
      detail:
        'Each entry expires 1800 seconds after it is written (`SCORE_TTL_S`), so a cached number cannot outlive the build that produced it by more than half an hour. The starter writes with no expiry.',
      match: {
        python: {all: [/SCORE_TTL_S/, /\bex\s*=\s*\w+|setex\(/]},
        typescript: {all: [/SCORE_TTL_S/, /['"]EX['"]|setex\(/]},
        go: {all: [/\.Set\([\s\S]{0,120}?(scoreTTL|time\.Minute|time\.Second)/]},
        scala: {all: [/setex\(|\.ex\(/]},
        cpp: {all: [/\.set\([^;]*(kScoreTtl|std::chrono::)/]},
      },
    },
    {
      id: 'one-mget',
      title: 'Reads the batch in one MGET',
      detail:
        'A lookup of three cached passages is one round trip carrying one `MGET`, not one `GET` per passage: 200 candidates are one network wait. The starter sends a `GET` each.',
      match: {
        python: {all: [/\.mget\(/], none: [/\br\.get\(/]},
        typescript: {all: [/\.mget\(/], none: [/redis\.get\(/]},
        go: {all: [/\.MGet\(/], none: [/rdb\.Get\(/]},
        scala: {all: [/\.mget\(/], none: [/jedis\.get\(/]},
        cpp: {all: [/\.mget\(/], none: [/cache\(\)\.get\(/]},
      },
    },
    {
      id: 'misses-only',
      title: 'Scores exactly the passages that missed, in one call',
      detail:
        'With one of three passages already cached, `compute` runs once with the other two in request order, and the cached score comes back untouched in its place. The starter calls the model once per miss.',
      match: {
        python: {all: [/\bmissing\b/], none: [/compute\(\s*\[\s*passage\s*\]\s*\)/]},
        typescript: {all: [/\bmissing\b/], none: [/compute\(\s*\[\s*passage\s*\]\s*\)/]},
        go: {all: [/\bmissing\b/], none: [/compute\(\s*\[\]string\{\s*passage\s*\}\s*\)/]},
        scala: {all: [/\bmissing\b/], none: [/compute\(\s*Seq\(\s*passage\s*\)\s*\)/]},
        cpp: {all: [/\bmissing\b/], none: [/compute\(\s*\{\s*passage\s*\}\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from rerank.config import fingerprint  # fingerprint(text): 32 hex digits of SHA-256 — provided

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def score_key(passage: str) -> str:
    return f"rerank:score:{fingerprint(passage)}"


def cached_scores(query: str, passages: list[str], model_version: str, compute) -> list[float]:
    """The scores of passages for query under model_version, in passage order; compute(passages) scores what missed."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    scores = []
    for passage in passages:
        key = score_key(passage)
        cached = r.get(key)
        if cached is not None:
            scores.append(float(cached))
            continue
        fresh = compute([passage])[0]
        r.set(key, repr(fresh))
        scores.append(fresh)
    return scores
`,
      solution: `import redis

from rerank.config import fingerprint  # fingerprint(text): 32 hex digits of SHA-256 — provided

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SCORE_TTL_S = 30 * 60


def score_key(query: str, passage: str, model_version: str) -> str:
    # A score belongs to the whole triple: change any part and it is another comparison.
    return f"rerank:score:{fingerprint(query)}:{fingerprint(passage)}:{model_version}"


def cached_scores(query: str, passages: list[str], model_version: str, compute) -> list[float]:
    """The scores of passages for query under model_version, in passage order; compute(passages) scores what missed."""
    if not passages:
        return []
    keys = [score_key(query, passage, model_version) for passage in passages]
    cached = r.mget(keys)
    scores = [None if value is None else float(value) for value in cached]
    missing = [i for i, value in enumerate(cached) if value is None]
    if missing:
        fresh = compute([passages[i] for i in missing])
        for i, score in zip(missing, fresh):
            scores[i] = score
            r.set(keys[i], repr(score), ex=SCORE_TTL_S)
    return scores
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {fingerprint} from 'rerank/config'; // fingerprint(text): 32 hex digits of SHA-256 — provided

export const redis = new Redis({host: 'redis', port: 6379});

/** The model call the service hands in: scores for these passages, in order. */
export type Compute = (passages: string[]) => Promise<number[]>;

export function scoreKey(passage: string): string {
  return \`rerank:score:\${fingerprint(passage)}\`;
}

/** The scores of passages for query under modelVersion, in passage order; compute scores what missed. */
export async function cachedScores(query: string, passages: string[], modelVersion: string, compute: Compute): Promise<number[]> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const scores: number[] = [];
  for (const passage of passages) {
    const key = scoreKey(passage);
    const cached = await redis.get(key);
    if (cached !== null) {
      scores.push(Number(cached));
      continue;
    }
    const [fresh] = await compute([passage]);
    await redis.set(key, String(fresh));
    scores.push(fresh);
  }
  return scores;
}
`,
      solution: `import Redis from 'ioredis';

import {fingerprint} from 'rerank/config'; // fingerprint(text): 32 hex digits of SHA-256 — provided

export const redis = new Redis({host: 'redis', port: 6379});

export const SCORE_TTL_S = 30 * 60;

/** The model call the service hands in: scores for these passages, in order. */
export type Compute = (passages: string[]) => Promise<number[]>;

/** A score belongs to the whole triple: change any part and it is another comparison. */
export function scoreKey(query: string, passage: string, modelVersion: string): string {
  return \`rerank:score:\${fingerprint(query)}:\${fingerprint(passage)}:\${modelVersion}\`;
}

/** The scores of passages for query under modelVersion, in passage order; compute scores what missed. */
export async function cachedScores(query: string, passages: string[], modelVersion: string, compute: Compute): Promise<number[]> {
  if (passages.length === 0) return [];
  const keys = passages.map(passage => scoreKey(query, passage, modelVersion));
  const cached = await redis.mget(...keys);
  const scores = cached.map(value => (value === null ? 0 : Number(value)));
  const missing = cached.flatMap((value, i) => (value === null ? [i] : []));
  if (missing.length > 0) {
    const fresh = await compute(missing.map(i => passages[i]));
    for (const [j, i] of missing.entries()) {
      scores[i] = fresh[j];
      await redis.set(keys[i], String(fresh[j]), 'EX', SCORE_TTL_S);
    }
  }
  return scores;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"rerank/config" // config.Fingerprint(text): 32 hex digits of SHA-256 — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func scoreKey(passage string) string {
	return "rerank:score:" + config.Fingerprint(passage)
}

// cachedScores returns the scores of passages for query under modelVersion, in passage order;
// compute scores what missed.
func cachedScores(ctx context.Context, query string, passages []string, modelVersion string, compute func([]string) []float64) ([]float64, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	scores := make([]float64, 0, len(passages))
	for _, passage := range passages {
		key := scoreKey(passage)
		cached, err := rdb.Get(ctx, key).Result()
		if err == nil {
			score, _ := strconv.ParseFloat(cached, 64)
			scores = append(scores, score)
			continue
		}
		if err != redis.Nil {
			return nil, err
		}
		fresh := compute([]string{passage})[0]
		if err := rdb.Set(ctx, key, strconv.FormatFloat(fresh, 'g', -1, 64), 0).Err(); err != nil {
			return nil, err
		}
		scores = append(scores, fresh)
	}
	return scores, nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"rerank/config" // config.Fingerprint(text): 32 hex digits of SHA-256 — provided
)

const scoreTTL = 30 * time.Minute

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// scoreKey names the whole triple: change any part and it is another comparison.
func scoreKey(query, passage, modelVersion string) string {
	return "rerank:score:" + config.Fingerprint(query) + ":" + config.Fingerprint(passage) + ":" + modelVersion
}

// cachedScores returns the scores of passages for query under modelVersion, in passage order;
// compute scores what missed.
func cachedScores(ctx context.Context, query string, passages []string, modelVersion string, compute func([]string) []float64) ([]float64, error) {
	scores := make([]float64, len(passages))
	if len(passages) == 0 {
		return scores, nil
	}
	keys := make([]string, len(passages))
	for i, passage := range passages {
		keys[i] = scoreKey(query, passage, modelVersion)
	}
	cached, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	var missing []int
	for i, value := range cached {
		text, ok := value.(string)
		if !ok {
			missing = append(missing, i)
			continue
		}
		scores[i], _ = strconv.ParseFloat(text, 64)
	}
	if len(missing) == 0 {
		return scores, nil
	}
	batch := make([]string, len(missing))
	for j, i := range missing {
		batch[j] = passages[i]
	}
	fresh := compute(batch)
	for j, i := range missing {
		scores[i] = fresh[j]
		if err := rdb.Set(ctx, keys[i], strconv.FormatFloat(fresh[j], 'g', -1, 64), scoreTTL).Err(); err != nil {
			return nil, err
		}
	}
	return scores, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import rerank.Config // Config.fingerprint(text): 32 hex digits of SHA-256 — provided

object ScoreCache {
  private val jedis = new JedisPooled("redis", 6379)

  def scoreKey(passage: String): String = s"rerank:score:\${Config.fingerprint(passage)}"

  /** The scores of passages for query under modelVersion, in passage order; compute scores what missed. */
  def cachedScores(query: String, passages: Seq[String], modelVersion: String, compute: Seq[String] => Seq[Double]): Seq[Double] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    passages.map { passage =>
      val key = scoreKey(passage)
      Option(jedis.get(key)) match {
        case Some(cached) => cached.toDouble
        case None =>
          val fresh = compute(Seq(passage)).head
          jedis.set(key, fresh.toString)
          fresh
      }
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import rerank.Config // Config.fingerprint(text): 32 hex digits of SHA-256 — provided

object ScoreCache {
  val ScoreTtlSeconds: Long = 30 * 60
  private val jedis = new JedisPooled("redis", 6379)

  /** A score belongs to the whole triple: change any part and it is another comparison. */
  def scoreKey(query: String, passage: String, modelVersion: String): String =
    s"rerank:score:\${Config.fingerprint(query)}:\${Config.fingerprint(passage)}:$modelVersion"

  /** The scores of passages for query under modelVersion, in passage order; compute scores what missed. */
  def cachedScores(query: String, passages: Seq[String], modelVersion: String, compute: Seq[String] => Seq[Double]): Seq[Double] =
    if (passages.isEmpty) Seq.empty
    else {
      val keys = passages.map(scoreKey(query, _, modelVersion))
      val cached = jedis.mget(keys: _*).asScala.toVector.map(Option(_))
      val missing = cached.indices.filter(cached(_).isEmpty)
      val fresh = if (missing.isEmpty) Map.empty[Int, Double] else missing.zip(compute(missing.map(passages))).toMap
      fresh.foreach { case (i, score) => jedis.setex(keys(i), ScoreTtlSeconds, score.toString) }
      cached.indices.map(i => cached(i).map(_.toDouble).getOrElse(fresh(i)))
    }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <functional>
#include <string>
#include <vector>

#include "rerank/config.h"  // config::fingerprint(text): 32 hex digits of SHA-256 — provided

// The model call the service hands in: scores for these passages, in order.
using Compute = std::function<std::vector<double>(const std::vector<std::string>&)>;

sw::redis::Redis& cache() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

std::string scoreKey(const std::string& passage) { return "rerank:score:" + config::fingerprint(passage); }

// The scores of passages for query under model_version, in passage order; compute scores what missed.
std::vector<double> cachedScores(const std::string& query, const std::vector<std::string>& passages, const std::string& model_version,
                                 const Compute& compute) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  std::vector<double> scores;
  for (const std::string& passage : passages) {
    const std::string key = scoreKey(passage);
    if (const auto cached = cache().get(key)) {
      scores.push_back(std::stod(*cached));
      continue;
    }
    const double fresh = compute({passage})[0];
    cache().set(key, std::to_string(fresh));
    scores.push_back(fresh);
  }
  return scores;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <functional>
#include <iterator>
#include <string>
#include <vector>

#include "rerank/config.h"  // config::fingerprint(text): 32 hex digits of SHA-256 — provided

// The model call the service hands in: scores for these passages, in order.
using Compute = std::function<std::vector<double>(const std::vector<std::string>&)>;

constexpr std::chrono::seconds kScoreTtl{30 * 60};

sw::redis::Redis& cache() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

// A score belongs to the whole triple: change any part and it is another comparison.
std::string scoreKey(const std::string& query, const std::string& passage, const std::string& model_version) {
  return "rerank:score:" + config::fingerprint(query) + ":" + config::fingerprint(passage) + ":" + model_version;
}

// The scores of passages for query under model_version, in passage order; compute scores what missed.
std::vector<double> cachedScores(const std::string& query, const std::vector<std::string>& passages, const std::string& model_version,
                                 const Compute& compute) {
  std::vector<double> scores(passages.size(), 0.0);
  if (passages.empty()) return scores;
  std::vector<std::string> keys;
  for (const std::string& passage : passages) keys.push_back(scoreKey(query, passage, model_version));
  std::vector<sw::redis::OptionalString> cached;
  cache().mget(keys.begin(), keys.end(), std::back_inserter(cached));
  std::vector<size_t> missing;
  for (size_t i = 0; i < cached.size(); i++) {
    if (cached[i]) {
      scores[i] = std::stod(*cached[i]);
    } else {
      missing.push_back(i);
    }
  }
  if (missing.empty()) return scores;
  std::vector<std::string> batch;
  for (size_t i : missing) batch.push_back(passages[i]);
  const std::vector<double> fresh = compute(batch);
  for (size_t j = 0; j < missing.size(); j++) {
    scores[missing[j]] = fresh[j];
    cache().set(keys[missing[j]], std::to_string(fresh[j]), kScoreTtl);
  }
  return scores;
}
`,
    },
  },
  harness: {
    python: `from rerank import model
from rerank.config import fingerprint

Q1 = "solar panel efficiency"
Q2 = "wind turbine noise"
V = "xenc-v7"
P1 = "solar panel guide"
P2 = "efficiency of panels"
P3 = "solar efficiency panel tips"


class Model:
    """The compute the service hands in: the stand-in model for one query, counting what it was asked."""

    def __init__(self, query, scale=1.0):
        self.query = query
        self.scale = scale
        self.calls = []

    def __call__(self, passages):
        self.calls.append(list(passages))
        return [model.score(self.query, p) * self.scale for p in passages]


def _key(query, passage, version=V):
    return f"rerank:score:{fingerprint(query)}:{fingerprint(passage)}:{version}"


def _close(got, want):
    return isinstance(got, list) and len(got) == len(want) and all(abs(g - w) < 1e-5 for g, w in zip(got, want))


def check_pair_key(ctx):
    m = ctx.load("state")
    first = m.cached_scores(Q1, [P1], V, Model(Q1))
    assert _close(first, [model.score(Q1, P1)]), f"the first lookup must answer the model's score {model.score(Q1, P1):.4f}, got {first}"
    other = Model(Q2)
    second = m.cached_scores(Q2, [P1], V, other)
    assert other.calls == [[P1]], f"a second query over the same passage asked the model {other.calls}: it read the first query's score. The key must name the query too"
    assert _close(second, [model.score(Q2, P1)]), f"the second query must get its own score {model.score(Q2, P1):.4f}, got {second}"
    for q in (Q1, Q2):
        assert ctx.redis.exists(_key(q, P1)), f"no entry at {_key(q, P1)}: the key is rerank:score:{{fingerprint(query)}}:{{fingerprint(passage)}}:{{model_version}}; Redis holds {sorted(ctx.redis.keys('rerank:score:*'))}"


def check_version_in_key(ctx):
    m = ctx.load("state")
    m.cached_scores(Q1, [P1], "xenc-v7", Model(Q1))
    rebuilt = Model(Q1, scale=0.5)
    got = m.cached_scores(Q1, [P1], "xenc-v8", rebuilt)
    assert rebuilt.calls == [[P1]], f"the next model build was not asked ({rebuilt.calls}): it served the old build's score. A new model_version is a new key"
    assert _close(got, [model.score(Q1, P1) * 0.5]), f"under xenc-v8 the pair must get the new build's score, got {got}"
    assert ctx.redis.exists(_key(Q1, P1, "xenc-v8")), f"no entry at {_key(Q1, P1, 'xenc-v8')}; Redis holds {sorted(ctx.redis.keys('rerank:score:*'))}"
    old = Model(Q1)
    again = m.cached_scores(Q1, [P1], "xenc-v7", old)
    assert old.calls == [] and _close(again, [model.score(Q1, P1)]), f"xenc-v7's entry must still answer for xenc-v7, got {again} after {old.calls} model calls"


def check_score_ttl(ctx):
    m = ctx.load("state")
    m.cached_scores(Q1, [P1, P2], V, Model(Q1))
    keys = sorted(ctx.redis.keys("rerank:score:*"))
    assert len(keys) == 2, f"two scored passages must leave two entries, Redis holds {keys}"
    for key in keys:
        ttl = ctx.redis.ttl(key)
        assert 1790 <= ttl <= 1800, f"{key} has TTL {ttl}: every score expires 30 minutes (1800 s) after it is written, so an old build's number cannot outlive it"


def check_one_mget(ctx):
    m = ctx.load("state")
    m.cached_scores(Q1, [P1, P2, P3], V, Model(Q1))
    client = getattr(m, "r", None)
    assert client is not None, "the module's Redis client must be named r"
    commands = []
    original = client.execute_command

    def recording(*args, **kwargs):
        commands.append(str(args[0]).upper())
        return original(*args, **kwargs)

    client.execute_command = recording
    warm = Model(Q1)
    got = m.cached_scores(Q1, [P1, P2, P3], V, warm)
    assert warm.calls == [], f"three cached passages asked the model again: {warm.calls}"
    assert _close(got, [model.score(Q1, p) for p in (P1, P2, P3)]), f"the cached scores came back as {got}"
    assert commands == ["MGET"], f"a lookup of three cached passages sent {commands} to Redis: one MGET round trip, not a GET each"


def check_misses_only(ctx):
    m = ctx.load("state")
    ctx.redis.set(_key(Q1, P2), "0.42", ex=1800)  # another replica scored P2 a minute ago
    asked = Model(Q1)
    got = m.cached_scores(Q1, [P1, P2, P3], V, asked)
    assert asked.calls == [[P1, P3]], f"with P2 cached the model must be asked once for [P1, P3] in order, it was asked {asked.calls}"
    assert _close(got, [model.score(Q1, P1), 0.42, model.score(Q1, P3)]), f"the scores must be P1's, the cached 0.42, P3's, in passage order, got {got}"
`,
    typescript: `const Q1 = 'solar panel efficiency';
const Q2 = 'wind turbine noise';
const V = 'xenc-v7';
const P1 = 'solar panel guide';
const P2 = 'efficiency of panels';
const P3 = 'solar efficiency panel tips';

function world(ctx) {
  return {m: ctx.load('state'), model: ctx.load('/support/rerank/model.ts'), config: ctx.load('/support/rerank/config.ts')};
}

/** The compute the service hands in: the stand-in model for one query, counting what it was asked. */
function counting(model, query: string, scale = 1) {
  const calls: string[][] = [];
  const compute = async (passages: string[]) => {
    calls.push([...passages]);
    return passages.map(p => model.score(query, p) * scale);
  };
  return {compute, calls};
}

const key = (config, query: string, passage: string, version = V) => \`rerank:score:\${config.fingerprint(query)}:\${config.fingerprint(passage)}:\${version}\`;
const close = (got, want: number[]) => Array.isArray(got) && got.length === want.length && got.every((g, i) => Math.abs(g - want[i]) < 1e-5);

export async function check_pair_key(ctx) {
  const {m, model, config} = world(ctx);
  const first = await m.cachedScores(Q1, [P1], V, counting(model, Q1).compute);
  assert(close(first, [model.score(Q1, P1)]), \`the first lookup must answer the model's score, got \${JSON.stringify(first)}\`);
  const other = counting(model, Q2);
  const second = await m.cachedScores(Q2, [P1], V, other.compute);
  assert.deepEqual(other.calls, [[P1]], \`a second query over the same passage asked the model \${JSON.stringify(other.calls)}: it read the first query's score. The key must name the query too\`);
  assert(close(second, [model.score(Q2, P1)]), \`the second query must get its own score, got \${JSON.stringify(second)}\`);
  for (const q of [Q1, Q2]) assert.equal(ctx.redis.exists(key(config, q, P1)), 1, \`no entry at \${key(config, q, P1)}: the key is rerank:score:{fingerprint(query)}:{fingerprint(passage)}:{model_version}; Redis holds \${JSON.stringify(ctx.redis.keys('rerank:score:*'))}\`);
}

export async function check_version_in_key(ctx) {
  const {m, model, config} = world(ctx);
  await m.cachedScores(Q1, [P1], 'xenc-v7', counting(model, Q1).compute);
  const rebuilt = counting(model, Q1, 0.5);
  const got = await m.cachedScores(Q1, [P1], 'xenc-v8', rebuilt.compute);
  assert.deepEqual(rebuilt.calls, [[P1]], \`the next model build was not asked (\${JSON.stringify(rebuilt.calls)}): it served the old build's score. A new model_version is a new key\`);
  assert(close(got, [model.score(Q1, P1) * 0.5]), \`under xenc-v8 the pair must get the new build's score, got \${JSON.stringify(got)}\`);
  assert.equal(ctx.redis.exists(key(config, Q1, P1, 'xenc-v8')), 1, \`no entry at \${key(config, Q1, P1, 'xenc-v8')}\`);
  const old = counting(model, Q1);
  const again = await m.cachedScores(Q1, [P1], 'xenc-v7', old.compute);
  assert(old.calls.length === 0 && close(again, [model.score(Q1, P1)]), \`xenc-v7's entry must still answer for xenc-v7, got \${JSON.stringify(again)} after \${old.calls.length} model calls\`);
}

export async function check_score_ttl(ctx) {
  const {m, model} = world(ctx);
  await m.cachedScores(Q1, [P1, P2], V, counting(model, Q1).compute);
  const keys = ctx.redis.keys('rerank:score:*');
  assert.equal(keys.length, 2, \`two scored passages must leave two entries, Redis holds \${JSON.stringify(keys)}\`);
  for (const k of keys) {
    const ttl = ctx.redis.ttl(k);
    assert(ttl >= 1790 && ttl <= 1800, \`\${k} has TTL \${ttl}: every score expires 30 minutes (1800 s) after it is written, so an old build's number cannot outlive it\`);
  }
}

export async function check_one_mget(ctx) {
  const {m, model} = world(ctx);
  await m.cachedScores(Q1, [P1, P2, P3], V, counting(model, Q1).compute);
  const before = ctx.redisRoundTrips().length;
  const warm = counting(model, Q1);
  const got = await m.cachedScores(Q1, [P1, P2, P3], V, warm.compute);
  const trips = ctx.redisRoundTrips().slice(before);
  assert.equal(warm.calls.length, 0, \`three cached passages asked the model again: \${JSON.stringify(warm.calls)}\`);
  assert(close(got, [P1, P2, P3].map(p => model.score(Q1, p))), \`the cached scores came back as \${JSON.stringify(got)}\`);
  assert.deepEqual(trips, [['MGET']], \`a lookup of three cached passages made the round trips \${JSON.stringify(trips)}: one MGET, not a GET each\`);
}

export async function check_misses_only(ctx) {
  const {m, model, config} = world(ctx);
  ctx.redis.set(key(config, Q1, P2), '0.42', 'EX', 1800); // another replica scored P2 a minute ago
  const asked = counting(model, Q1);
  const got = await m.cachedScores(Q1, [P1, P2, P3], V, asked.compute);
  assert.deepEqual(asked.calls, [[P1, P3]], \`with P2 cached the model must be asked once for [P1, P3] in order, it was asked \${JSON.stringify(asked.calls)}\`);
  assert(close(got, [model.score(Q1, P1), 0.42, model.score(Q1, P3)]), \`the scores must be P1's, the cached 0.42, P3's, in passage order, got \${JSON.stringify(got)}\`);
}
`,
    go: `package main

import (
	"context"
	"math"

	"rerank/config"
	"rerank/model"

	"leetbuild/harness"
)

const (
	stateQ1 = "solar panel efficiency"
	stateQ2 = "wind turbine noise"
	stateV  = "xenc-v7"
	stateP1 = "solar panel guide"
	stateP2 = "efficiency of panels"
	stateP3 = "solar efficiency panel tips"
)

// stateModel is the compute the service hands in: the stand-in model for one query, counting what it was asked.
type stateModel struct {
	query string
	scale float64
	calls [][]string
}

func (s *stateModel) compute(passages []string) []float64 {
	s.calls = append(s.calls, append([]string{}, passages...))
	out := make([]float64, len(passages))
	for i, p := range passages {
		out[i] = model.Score(s.query, p) * s.scale
	}
	return out
}

func stateKey(query, passage, version string) string {
	return "rerank:score:" + config.Fingerprint(query) + ":" + config.Fingerprint(passage) + ":" + version
}

func stateLookup(ctx *harness.Ctx, query string, passages []string, version string, s *stateModel) []float64 {
	got, err := cachedScores(context.Background(), query, passages, version, s.compute)
	ctx.NoError(err, "cachedScores")
	return got
}

func stateClose(got, want []float64) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if math.Abs(got[i]-want[i]) > 1e-5 {
			return false
		}
	}
	return true
}

func CheckPairKey(ctx *harness.Ctx) {
	first := stateLookup(ctx, stateQ1, []string{stateP1}, stateV, &stateModel{query: stateQ1, scale: 1})
	ctx.Assert(stateClose(first, []float64{model.Score(stateQ1, stateP1)}), "the first lookup must answer the model's score, got %v", first)
	other := &stateModel{query: stateQ2, scale: 1}
	second := stateLookup(ctx, stateQ2, []string{stateP1}, stateV, other)
	ctx.Equal(other.calls, [][]string{{stateP1}}, "a second query over the same passage must be scored for itself (the key must name the query too); the model calls")
	ctx.Assert(stateClose(second, []float64{model.Score(stateQ2, stateP1)}), "the second query must get its own score, got %v", second)
	for _, q := range []string{stateQ1, stateQ2} {
		ctx.Equal(ctx.Redis.Exists(stateKey(q, stateP1, stateV)), int64(1), "an entry at %s (rerank:score:{fingerprint(query)}:{fingerprint(passage)}:{model_version}); Redis holds %v", stateKey(q, stateP1, stateV), ctx.Redis.Keys("rerank:score:*"))
	}
}

func CheckVersionInKey(ctx *harness.Ctx) {
	stateLookup(ctx, stateQ1, []string{stateP1}, "xenc-v7", &stateModel{query: stateQ1, scale: 1})
	rebuilt := &stateModel{query: stateQ1, scale: 0.5}
	got := stateLookup(ctx, stateQ1, []string{stateP1}, "xenc-v8", rebuilt)
	ctx.Equal(rebuilt.calls, [][]string{{stateP1}}, "the next model build must be asked (a new model_version is a new key); the model calls")
	ctx.Assert(stateClose(got, []float64{model.Score(stateQ1, stateP1) * 0.5}), "under xenc-v8 the pair must get the new build's score, got %v", got)
	ctx.Equal(ctx.Redis.Exists(stateKey(stateQ1, stateP1, "xenc-v8")), int64(1), "an entry at %s", stateKey(stateQ1, stateP1, "xenc-v8"))
	old := &stateModel{query: stateQ1, scale: 1}
	again := stateLookup(ctx, stateQ1, []string{stateP1}, "xenc-v7", old)
	ctx.Assert(len(old.calls) == 0 && stateClose(again, []float64{model.Score(stateQ1, stateP1)}), "xenc-v7's entry must still answer for xenc-v7, got %v after %d model calls", again, len(old.calls))
}

func CheckScoreTtl(ctx *harness.Ctx) {
	stateLookup(ctx, stateQ1, []string{stateP1, stateP2}, stateV, &stateModel{query: stateQ1, scale: 1})
	keys := ctx.Redis.Keys("rerank:score:*")
	ctx.Equal(len(keys), 2, "two scored passages must leave two entries (%v); the entries", keys)
	for _, key := range keys {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl >= 1790 && ttl <= 1800, "%s has TTL %d: every score expires 30 minutes (1800 s) after it is written, so an old build's number cannot outlive it", key, ttl)
	}
}

func CheckOneMget(ctx *harness.Ctx) {
	passages := []string{stateP1, stateP2, stateP3}
	stateLookup(ctx, stateQ1, passages, stateV, &stateModel{query: stateQ1, scale: 1})
	before := len(ctx.Redis.RoundTrips())
	warm := &stateModel{query: stateQ1, scale: 1}
	got := stateLookup(ctx, stateQ1, passages, stateV, warm)
	trips := ctx.Redis.RoundTrips()[before:]
	ctx.Equal(len(warm.calls), 0, "three cached passages must not ask the model again; the model calls")
	ctx.Assert(stateClose(got, []float64{model.Score(stateQ1, stateP1), model.Score(stateQ1, stateP2), model.Score(stateQ1, stateP3)}), "the cached scores came back as %v", got)
	ctx.Equal(trips, [][]string{{"MGET"}}, "a lookup of three cached passages: one MGET round trip, not a GET each; the round trips")
}

func CheckMissesOnly(ctx *harness.Ctx) {
	ctx.Redis.Set(stateKey(stateQ1, stateP2, stateV), "0.42", "EX", 1800) // another replica scored P2 a minute ago
	asked := &stateModel{query: stateQ1, scale: 1}
	got := stateLookup(ctx, stateQ1, []string{stateP1, stateP2, stateP3}, stateV, asked)
	ctx.Equal(asked.calls, [][]string{{stateP1, stateP3}}, "with P2 cached the model must be asked once for [P1, P3] in order; the model calls")
	ctx.Assert(stateClose(got, []float64{model.Score(stateQ1, stateP1), 0.42, model.Score(stateQ1, stateP3)}), "the scores must be P1's, the cached 0.42, P3's, in passage order, got %v", got)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <string>
#include <vector>

#include "rerank/config.h"
#include "rerank/model.h"

namespace {

const std::string kQ1 = "solar panel efficiency";
const std::string kQ2 = "wind turbine noise";
const std::string kV = "xenc-v7";
const std::string kP1 = "solar panel guide";
const std::string kP2 = "efficiency of panels";
const std::string kP3 = "solar efficiency panel tips";

// The compute the service hands in: the stand-in model for one query, counting what it was asked.
struct Counting {
  std::string query;
  double scale = 1.0;
  std::vector<std::vector<std::string>> calls;

  Compute fn() {
    return [this](const std::vector<std::string>& passages) {
      calls.push_back(passages);
      std::vector<double> out;
      for (const auto& p : passages) out.push_back(model::score(query, p) * scale);
      return out;
    };
  }
};

std::string key(const std::string& query, const std::string& passage, const std::string& version) {
  return "rerank:score:" + config::fingerprint(query) + ":" + config::fingerprint(passage) + ":" + version;
}

bool close(const std::vector<double>& got, const std::vector<double>& want) {
  if (got.size() != want.size()) return false;
  for (size_t i = 0; i < got.size(); i++) {
    if (std::fabs(got[i] - want[i]) > 1e-5) return false;
  }
  return true;
}

}  // namespace

void CheckPairKey(harness::Ctx& ctx) {
  Counting first{kQ1};
  const auto a = cachedScores(kQ1, {kP1}, kV, first.fn());
  ctx.Assert(close(a, {model::score(kQ1, kP1)}), "the first lookup must answer the model's score, got %v", a);
  Counting other{kQ2};
  const auto b = cachedScores(kQ2, {kP1}, kV, other.fn());
  ctx.Equal(other.calls, std::vector<std::vector<std::string>>{{kP1}}, "a second query over the same passage must be scored for itself (the key must name the query too); the model calls");
  ctx.Assert(close(b, {model::score(kQ2, kP1)}), "the second query must get its own score, got %v", b);
  for (const auto& q : {kQ1, kQ2}) {
    ctx.Equal(ctx.Redis.Exists(key(q, kP1, kV)), 1, "an entry at %s (rerank:score:{fingerprint(query)}:{fingerprint(passage)}:{model_version}); Redis holds %v", key(q, kP1, kV), ctx.Redis.Keys("rerank:score:*"));
  }
}

void CheckVersionInKey(harness::Ctx& ctx) {
  Counting seed{kQ1};
  cachedScores(kQ1, {kP1}, "xenc-v7", seed.fn());
  Counting rebuilt{kQ1, 0.5};
  const auto got = cachedScores(kQ1, {kP1}, "xenc-v8", rebuilt.fn());
  ctx.Equal(rebuilt.calls, std::vector<std::vector<std::string>>{{kP1}}, "the next model build must be asked (a new model_version is a new key); the model calls");
  ctx.Assert(close(got, {model::score(kQ1, kP1) * 0.5}), "under xenc-v8 the pair must get the new build's score, got %v", got);
  ctx.Equal(ctx.Redis.Exists(key(kQ1, kP1, "xenc-v8")), 1, "an entry at %s", key(kQ1, kP1, "xenc-v8"));
  Counting old{kQ1};
  const auto again = cachedScores(kQ1, {kP1}, "xenc-v7", old.fn());
  ctx.Assert(old.calls.empty() && close(again, {model::score(kQ1, kP1)}), "xenc-v7's entry must still answer for xenc-v7, got %v after %d model calls", again, old.calls.size());
}

void CheckScoreTtl(harness::Ctx& ctx) {
  Counting seed{kQ1};
  cachedScores(kQ1, {kP1, kP2}, kV, seed.fn());
  const auto keys = ctx.Redis.Keys("rerank:score:*");
  ctx.Equal(keys.size(), 2, "two scored passages must leave two entries (%v); the entries", keys);
  for (const auto& k : keys) {
    const long long ttl = ctx.Redis.TTL(k);
    ctx.Assert(ttl >= 1790 && ttl <= 1800, "%s has TTL %d: every score expires 30 minutes (1800 s) after it is written, so an old build's number cannot outlive it", k, ttl);
  }
}

void CheckOneMget(harness::Ctx& ctx) {
  const std::vector<std::string> passages = {kP1, kP2, kP3};
  Counting seed{kQ1};
  cachedScores(kQ1, passages, kV, seed.fn());
  const size_t before = ctx.Redis.RoundTrips().size();
  Counting warm{kQ1};
  const auto got = cachedScores(kQ1, passages, kV, warm.fn());
  const auto all = ctx.Redis.RoundTrips();
  const std::vector<std::vector<std::string>> trips(all.begin() + static_cast<long>(before), all.end());
  ctx.Equal(warm.calls.size(), 0, "three cached passages must not ask the model again; the model calls");
  ctx.Assert(close(got, {model::score(kQ1, kP1), model::score(kQ1, kP2), model::score(kQ1, kP3)}), "the cached scores came back as %v", got);
  ctx.Equal(trips, std::vector<std::vector<std::string>>{{"MGET"}}, "a lookup of three cached passages: one MGET round trip, not a GET each; the round trips");
}

void CheckMissesOnly(harness::Ctx& ctx) {
  ctx.Redis.Set(key(kQ1, kP2, kV), "0.42", "EX", 1800);  // another replica scored P2 a minute ago
  Counting asked{kQ1};
  const auto got = cachedScores(kQ1, {kP1, kP2, kP3}, kV, asked.fn());
  ctx.Equal(asked.calls, std::vector<std::vector<std::string>>{{kP1, kP3}}, "with P2 cached the model must be asked once for [P1, P3] in order; the model calls");
  ctx.Assert(close(got, {model::score(kQ1, kP1), 0.42, model::score(kQ1, kP3)}), "the scores must be P1's, the cached 0.42, P3's, in passage order, got %v", got);
}
`,
  },
  hints: [
    "Score one passage for two different queries: the second query gets the first one's number. Bump the model version: the old build's score comes back. Watch Redis: one GET per passage, no TTL.",
    'The key is built from the passage alone, so the query and the version never reach it; each passage is looked up, scored and written on its own, so a batch is N round trips and N model calls.',
    'Key `rerank:score:{fingerprint(query)}:{fingerprint(passage)}:{model_version}`; `MGET` all keys; collect `missing` indexes; `compute(missing passages)` once; `SET … EX SCORE_TTL_S` each fresh score; merge in passage order.',
  ],
  debrief: `The key has three parts because a cross-encoder score is a function of three inputs: drop the query and the cache hands one query's relevance to another, drop the version and a model rollout is invisible until Redis evicts. The TTL bounds how long a wrong entry can live when the version is not bumped, as when a tokenizer fix ships under the same build name. One \`MGET\` and one \`compute\` over the misses keep a partial hit cheap: the round trip and the model batch are paid once, whatever the hit ratio. Production caches also skip writing unscored results, so a failed batch is not pinned for half an hour, and fingerprint the passage after truncation, so a clipped and a full passage do not share a score.`,
};
