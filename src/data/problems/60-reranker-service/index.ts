import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {rerankEndpointStep} from './steps/1-endpoint';
import {rerankStateStep} from './steps/2-state';
import {rerankClientStep} from './steps/3-dependency';
import {rerankEventsStep} from './steps/4-events';
import {readStatsStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Reranking service: the course is not "call a cross-encoder and sort", it is the debugging you
 * owe a reranker before anyone trusts the order it returns. Byte caps and a reported cut on the
 * endpoint → a Redis score cache keyed by the whole (query, passage, version) triple → a gRPC batch
 * client whose failures are unscored, not neutral → numbers-only outcomes keyed by query fingerprint
 * with an outbox → a stats read per model version that shows silent degradation.
 */
export const rerankerServiceProblem: Problem = {
  id: 'reranker-service',
  title: 'Reranking Service',
  tagline:
    'Reorder retrieved passages behind byte caps, with a Redis score cache keyed per query, passage and model build.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Reranking Service

A reranking service takes the passages a retriever already returned and puts them in the order a
reader or a generator should see them. Its failures rarely look like errors: a degraded model, a stale
cache or a clipped passage all still produce a list, just in the wrong order.

## The real system

Cohere's Rerank API puts the request budget in the contract: each document is truncated to
\`max_tokens_per_doc\` (4096 tokens by default), and the docs recommend against sending more than 1,000
documents in one request. This course builds the service around such a model: caps the caller can
see, truncation reported per passage, a score cache that knows which build produced a score, and a
client that says "unscored" when a batch fails instead of inventing a number.

## What you build here

One service, **rerankd**, whose steps share the provided \`rerank\` package: \`config\` (the model's
address \`reranker:9000\`, the topic \`rerank.done\`, \`fingerprint(text)\`, the stats key layout),
\`model\` (the deterministic cross-encoder stand-in: the share of the query's words a passage holds),
\`outcome\` (the record a finished rerank hands to step 4) and \`outbox\` (\`insert(topic, key, payload)\`).

1. \`POST /v1/rerank\` with \`{query, candidates: [{passage_id, text}]}\`: 401 without \`X-Tenant-Id\`, 413
   over 2 KiB of query, 400 over 200 candidates, texts cut at 4 KiB and marked \`truncated\`, results by
   score then \`passage_id\`.
2. \`cached_scores(query, passages, model_version, compute)\`: one \`MGET\` of
   \`rerank:score:{fingerprint(query)}:{fingerprint(passage)}:{model_version}\`, one \`compute\` over the
   misses, a 30-minute TTL.
3. \`rerank_passages(query, passages)\` over \`Reranker.Score\` (\`reranker_service.proto\`): batches of 64,
   700 ms each, a failed batch unscored, \`INVALID_ARGUMENT\` terminal.
4. \`publish_outcome(outcome)\` to \`rerank.done\`, keyed by query fingerprint, counts and a score
   histogram only, an idempotent producer, an outbox row from the delivery report.
5. \`GET /v1/rerank/cache/stats\` from the consumer's per-version hashes \`rerank:stats:{v}\` and latency
   lists \`rerank:latency:{v}:queue|model\`: hit ratio, unscored and fallback shares, boundary latency.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Model training, embedding generation and the retrieval layer, token-exact budgets, per-tenant
relevance tuning, the stats consumer and the outbox relay. The five pieces above decide whether a
reranked list is correct and whether anyone can tell when it is not.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'rerank · stats', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'rerankd', sub: 'POST /v1/rerank', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'score cache · stats · outbox', x: 52, y: 18},
      {id: 'reranker', kind: 'grpc', label: 'Reranker model', sub: 'Score · 64 per batch · 700 ms', x: 52, y: 82},
      {id: 'kafka', kind: 'kafka', label: 'rerank.done', sub: 'key = query fingerprint', x: 74, y: 50},
      {id: 'consumer', kind: 'service', label: 'Stats consumer', sub: 'per model version', x: 92, y: 24},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'MGET · SET EX · outbox'},
      {from: 'api', to: 'reranker', kind: 'grpc', label: 'Score(batch)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce (numbers only)'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'rerank:stats:{v} · latency lists'},
    ],
  },
  steps: [rerankEndpointStep, rerankStateStep, rerankClientStep, rerankEventsStep, readStatsStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
