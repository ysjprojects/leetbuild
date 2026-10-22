import type {Problem} from '@/lib/types';

import {rerankEndpointStep} from './steps/1-endpoint';
import {rerankStateStep} from './steps/2-state';
import {rerankClientStep} from './steps/3-dependency';
import {rerankEventsStep} from './steps/4-events';
import {readStatsStep} from './steps/5-read';

/**
 * Reranking service on the AI-era track: the course is not "call a cross-encoder and sort", it is
 * the review you owe a model-generated reranker before anyone trusts the order it returns. A query
 * and candidate set with hard caps → a Redis score cache keyed by the whole (query, passage,
 * version) triple → a gRPC batch call whose failures become unscored markers that keep retrieval
 * order → outcomes published by query fingerprint with an outbox → a stats read that reports the
 * unscored share per version so silent degradation cannot hide.
 */
export const rerankerServiceProblem: Problem = {
  id: 'reranker-service',
  title: 'Reranking Service',
  tagline: 'Reorder candidate passages for relevance with a bounded budget and honest scores.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Reranking Service

A reranking service is the piece of an AI platform that takes the passages a retriever already
returned and puts them in the order a reader — or a generator — should see them. The visible part is
a list of scores; the parts that decide whether the product is honest are the caps on what one
request may ask for, what a score means when the model never saw the whole passage, what happens
when a batch of the model call fails, what the event stream carries, and whether the numbers on the
dashboard can separate a real regression from silent degradation.

## The real system

Production rerankers receive a query and a bounded set of candidates from a retrieval layer, and
they enforce that bound before the model call: a query over its cap or a candidate count over its
cap is rejected, and a passage over its per-passage cap is clipped *visibly*, never silently. A
score that describes a clipped passage is not the score of the full passage, so truncation is
reported per passage and the caller can decide whether to re-fetch or accept a degraded comparison.
Scores are cached per (query fingerprint, passage hash, model version), because a score is only
meaningful for a query-passage pair under a specific model; caching by passage alone serves one
query's scores to every other query and never notices a model version bump. The model runs over
gRPC in bounded batches under a deadline, and when a batch fails the service falls back to the
original retrieval order for exactly those passages and marks them **unscored** — a neutral score
would make an infrastructure failure indistinguishable from genuine mid-tier relevance. Outcomes are
published keyed by query fingerprint so a query's events stay ordered, carrying candidate counts,
latency and a score histogram and never the query or passage text. And the read side reports hit
ratio, unscored share and latency percentiles *per model version*, with latency measured at the
queue and model boundaries rather than from a client's clock.

## What you build here

One service, **rerankd**, with five pieces:

1. \`POST /v1/rerank\`: authenticated tenant, a query capped at **2 KiB** and at most **200**
   candidate passages of **4 KiB** each, per-passage truncation reported in the response, and a
   score order that is deterministic under ties.
2. A **Redis** score cache keyed by \`(query fingerprint, passage hash, model version)\` with a
   30-minute TTL, where a miss on either half of the pair recomputes and a model version bump
   serves a fresh score for the same pair.
3. A **gRPC** reranker client: batches of **64** with a **700 ms** deadline per batch, a failed
   batch returning unscored markers that keep the original retrieval order, a malformed batch
   treated as terminal, and the remaining batches still completing.
4. A **Kafka** \`rerank.done\` path keyed by query fingerprint, carrying candidate counts, latency
   and a score histogram — never the query or passage text — with an idempotent producer and an
   outbox row when the produce fails.
5. \`GET /v1/rerank/cache/stats\`: hit ratio, unscored batch share and latency percentiles per model
   version, plus the share of requests that used fallback order.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Model training and fine-tuning, embedding generation and vector index choice, cross-encoder
architecture details, passage chunking strategies, per-tenant relevance tuning, online A/B
infrastructure, and the retrieval layer itself. The five pieces above are the ones that decide
whether a reranked list is correct, honest and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'rerank · stats', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Rerank API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'db', kind: 'db', label: 'outbox · counters', sub: 'stats rows', x: 50, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'score cache · TTL', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'rerank.done', sub: 'key = query fingerprint', x: 50, y: 88},
      {id: 'reranker', kind: 'grpc', label: 'Reranker model', sub: 'Rerank · 700 ms', x: 74, y: 24},
      {id: 'consumer', kind: 'service', label: 'Stats consumer', sub: 'group rerank-stats', x: 74, y: 76},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'score cache'},
      {from: 'api', to: 'db', kind: 'plain', label: 'outbox · counters'},
      {from: 'api', to: 'reranker', kind: 'grpc', label: 'Rerank(batch of 64)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce rerank.done'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'hit ratio · unscored share'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'latency · histogram'},
    ],
  },
  steps: [rerankEndpointStep, rerankStateStep, rerankClientStep, rerankEventsStep, readStatsStep],
};
