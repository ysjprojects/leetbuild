import type {Problem} from '@/lib/types';

import {cacheEndpointStep} from './steps/1-endpoint';
import {cacheStateStep} from './steps/2-state';
import {cacheDependencyStep} from './steps/3-dependency';
import {cacheEventsStep} from './steps/4-events';
import {cacheReadStep} from './steps/5-read';

/**
 * Prompt cache: the course is not "hash the prompt and store the completion", it is the debugging
 * you owe a cache before a tenant trusts it. A cache key built from tenant, prompt version and
 * prefix digest → one conditional Redis fill with a version-scoped TTL → a bounded model call that
 * caches only deterministic answers → tenant-keyed cache events carrying digests → a stats read
 * that reports the slice a rollout decision can act on.
 */
export const promptCacheProblem: Problem = {
  id: 'prompt-cache',
  title: 'Prompt Cache',
  tagline: 'Exact-prefix completion caching keyed by tenant and prompt version, with a hit ratio a rollout can act on.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Prompt Cache

A prompt cache decides how often an AI platform pays to generate the same completion twice. The
visible part is a hit; the parts that decide whether it is safe are the key, the fill, the answer it
refuses to store, and the number it reports back. A cache that serves one tenant's completion to
another, or stores an error as an answer, has made the wrong answer cheap and universal.

## The real system

GPTCache, the open-source LLM response cache from the Milvus team, makes the lookup policy a
pluggable similarity evaluation: \`ExactMatchEvaluation\` returns a hit only when the stored question
equals the query, while embedding-based evaluators accept near matches at a distance threshold. This
course builds the exact-match end of that spectrum and adds what a multi-tenant platform needs around
it: a key that carries tenant, prompt version and prefix digest; a conditional fill with the
version's TTL, so a version bump invalidates the namespace without a purge; a miss path that caches
only a deterministic answer; and a decision stream from which a per-tenant hit ratio can be recomputed.

## What you build here

One service, the prompt cache, with five pieces:

1. \`POST /v1/completions/cached\`: an authenticated tenant, an 8 KiB prefix cap that does not echo
   the text, a key of \`pc:{tenant}:{version}:{digest}\`, and a hit only when the stored record's
   tenant and version agree with the caller's.
2. A **Redis** cache: \`SET … NX EX\`, the loser of the race returns the stored value, the TTL is the
   prompt version's lifetime, and a hit updates a \`pc:access:{tenant}:{version}\` counter without
   extending the value's TTL.
3. A **gRPC** model client on the miss path: a 3-second deadline, a cacheable-result rule of
   \`temperature == 0\` **and** \`finish_reason == "stop"\`, an error returned uncached, and a
   content-policy refusal answered once without a retry.
4. A **Kafka** decision stream: one \`cache.result\` event per hit or miss keyed by tenant, carrying
   \`{prefix_digest, version, decision, latency_ms}\`, with a consumer that updates the ratio counter
   **before** it commits the offset.
5. \`GET /v1/cache/stats\`: one slice per prompt version for the caller's tenant only, savings priced
   by a versioned rate table, \`fill_latency_ms\` from the events, and a **403** for a foreign
   tenant's slice.

## The debugging habit

Every starter compiles and serves the happy path. Debug it, fix it, and prove the fix with checks
that fail on the starter and pass on your version.

## Left out on purpose

Tokenizer-specific prefix matching, partial-prefix (tree) caches, semantic caching, provider-side
prompt caching, cache warming and eviction policy beyond the TTL, cross-region replication, key
rotation, per-tenant quotas, and the load testing that would size the cache.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'completions · stats', x: 8, y: 50},
      {id: 'cache', kind: 'http', label: 'Prompt Cache', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'pc:{tenant}:{version}:{digest}', x: 50, y: 14},
      {id: 'model', kind: 'grpc', label: 'Model server', sub: 'Complete · 3 s', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'cache.result', sub: 'key = tenant', x: 50, y: 86},
      {id: 'consumer', kind: 'service', label: 'Stats consumer', sub: 'hits · fill latency', x: 74, y: 86},
    ],
    edges: [
      {from: 'client', to: 'cache', kind: 'http', label: 'HTTPS'},
      {from: 'cache', to: 'redis', kind: 'redis', label: 'GET · SET NX EX · HINCRBY'},
      {from: 'cache', to: 'model', kind: 'grpc', label: 'Complete(prefix, version)'},
      {from: 'cache', to: 'kafka', kind: 'kafka', label: 'produce cache.result'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY ratio counters'},
    ],
  },
  steps: [cacheEndpointStep, cacheStateStep, cacheDependencyStep, cacheEventsStep, cacheReadStep],
};
