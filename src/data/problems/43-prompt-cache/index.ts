import type {Problem} from '@/lib/types';

import {cacheEndpointStep} from './steps/1-endpoint';
import {cacheStateStep} from './steps/2-state';
import {cacheDependencyStep} from './steps/3-dependency';
import {cacheEventsStep} from './steps/4-events';
import {cacheReadStep} from './steps/5-read';

/**
 * Prompt cache on the AI-era track: the course is not "hash the prompt and store the completion", it
 * is the review you owe a model-generated cache before a tenant trusts it. A cache key built from
 * tenant, prompt version and prefix digest → one conditional Redis fill with a version-scoped TTL →
 * a bounded model call that caches only deterministic answers → tenant-keyed cache events carrying
 * digests → a stats read that reports the slice a rollout decision can act on.
 */
export const promptCacheProblem: Problem = {
  id: 'prompt-cache',
  title: 'Prompt Cache',
  tagline: 'Exact-prefix completion caching that is tenant-safe, version-aware and honest about hits.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Prompt Cache

A prompt cache is the piece of an AI platform that decides how often the platform pays to generate the
same completion twice. The visible part is a hit; the parts that decide whether it is safe are the key,
the fill, the answer it refuses to store, and the number it reports back. A cache that serves one
tenant's completion to another, that keeps a deprecated prompt version alive in a hot key, or that
counts an error as a hit is worse than no cache at all — it has made the wrong answer cheap and
universal instead of rare and local.

## The real system

Production caches hash a prompt prefix and key the entry by *everything the answer depends on*: the
tenant that asked, the prompt version that produced it, and the prefix digest — never the raw text,
which would put customer prompts into every key listing and slow log. Fills are conditional writes, so a
slow fill cannot replace a newer result, and every entry carries the TTL of the version it belongs to,
which means a version bump invalidates the namespace without a purge. Hits update telemetry, not the
entry's lifetime: a value that is popular must still expire when its version does. A miss calls the
model under a deadline and caches the answer only when the answer is deterministic — a sampled
completion, a truncated one, an error or a policy refusal is returned to its caller and stored for
nobody. Every decision becomes one event keyed by tenant, carrying a digest, a version, a decision and a
latency, so the ratio a rollout decision reads can be recomputed per tenant and per version from the
same stream the fill path emits.

## What you build here

One service, the prompt cache, with five pieces:

1. \`POST /v1/completions/cached\`: an authenticated tenant, an 8 KiB prefix cap that never echoes the
   text, a key of \`pc:{tenant}:{version}:{digest}\`, and a hit only when the stored record's tenant and
   version agree with the caller's.
2. A **Redis** cache: \`SET … NX EX\`, the first writer wins and the loser returns the stored value, the
   TTL is the prompt version's lifetime, and a hit updates a separate \`pc:access:{tenant}:{version}\`
   counter without ever extending the value's TTL.
3. A **gRPC** model client on the miss path: a 3-second deadline, a cacheable-result rule of
   \`temperature == 0\` **and** \`finish_reason == "stop"\`, an error returned uncached, and a
   content-policy refusal answered once and never retried.
4. A **Kafka** decision stream: one \`cache.result\` event per hit or miss keyed by tenant, carrying
   \`{prefix_digest, version, decision, latency_ms}\` and no prompt text, with a durable idempotent
   producer and a consumer that updates the ratio counter **before** it commits the offset.
5. \`GET /v1/cache/stats\`: one slice per prompt version for the caller's tenant only, a ratio computed
   from the same counters, savings priced by a versioned rate table, \`fill_latency_ms\` from the events,
   and a **403** for a foreign tenant's slice.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Tokenizer-specific prefix matching and block-aligned prefix reuse, partial-prefix (tree) caches,
vectorised or semantic caching, provider-side prompt caching, cache warming and eviction policy beyond
the TTL, cross-region replication, key rotation, per-tenant quotas, and the load testing that would size
the cache. The five pieces above are the ones that decide whether the cache is correct, isolated and
honest about its hits.`,
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
