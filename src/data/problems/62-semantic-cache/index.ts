import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {lookupEndpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Semantic cache: a lookup whose similarity floor the caller cannot lower → entries written
 * atomically into a per-tenant, per-version index in Redis → a model call on a miss with a deadline
 * and a cacheability gate → result events keyed by tenant with an outbox → stats that report age,
 * not just a hit rate. Every step's starter runs and hides flaws the learner debugs.
 */
export const semanticCacheProblem: Problem = {
  id: 'semantic-cache',
  title: 'Semantic Cache',
  tagline:
    'An answer cache keyed by embedding: a similarity floor, tenant-scoped Redis entries, a model call on a miss, result events, a stats endpoint.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Semantic Cache

A semantic cache answers a new question from an old one that meant the same thing: the caller sends
an embedding, the cache finds the nearest stored entry, and above a similarity threshold it returns
the stored answer instead of paying for a model call. It is the cheapest large win in an AI platform
and the easiest one to get wrong, because every failure it has looks like a hit.

## The real system

RedisVL's \`SemanticCache\` stores prompt, response and prompt vector per entry, takes a
\`distance_threshold\` (cosine distance, 0.1 by default) that every \`check\` applies, a \`ttl\` per cache
or per entry, and \`filterable_fields\` so a lookup can be scoped to a tenant or a model. The same
decisions sit under GPTCache and under every in-house cache in front of a model: who sets the
threshold, how entries are scoped, when an answer may be reused, and how the cache reports on itself.

## What you build here

One service, **semcached**, over one Redis. The entry is the hash
\`entry:{tenant}:{model_version}:{entry_id}\` with \`embedding\` (a JSON array), \`answer\`,
\`created_at\`, \`expires_at\` (unix seconds) and \`policy_version\`; the set
\`semantic:{tenant}:{model_version}\` lists a tenant's entry keys; the hash
\`stats:{tenant}:{model_version}\` holds the counters.

1. \`POST /v1/semantic-cache/lookup\` with \`{"query_embedding", "model_version", "threshold"}\`
   and \`X-Tenant-Id\`: the threshold is clamped into \`[0.82, 0.99]\`, the nearest entry is served
   only while \`expires_at > now\`, a hit reports \`similarity\` and \`age_seconds\`, a miss is
   \`{"hit": false, "similarity": null}\`. Every lookup publishes one result event.
2. The **Redis store**: \`put_entry\` writes the hash, its 24-hour \`EXPIRE\` and the index membership
   in one Lua script; \`search_entries\` scans only the caller's set by cosine similarity; a hash
   without an \`answer\` is never an entry.
3. The **gRPC model client** on a miss: one \`Answer\` call under a 4-second deadline, a refusal is
   terminal, and the write-back stores only self-contained, deterministic, policy-cacheable answers
   with no tool calls, stamped \`policy_version: 2024-06-1\`.
4. The **result stream**: one \`semantic-cache.result\` event per lookup keyed by tenant, carrying
   \`{outcome, entry_id, similarity, policy_version, model_version, client_class, entry_age_seconds}\`
   and no answer text; an idempotent \`acks=all\` producer; a rejected produce goes to the Redis list
   \`outbox:semantic-cache.result\`, bumps \`cache_result_produce_failures\` and raises. The stats
   consumer folds events into \`stats:{tenant}:{model_version}\`: \`hits_total\`, \`misses_total\`,
   \`similarity_sum\`, \`automated_hits\`, \`automated_total\`, \`hits_older_than_1h\`.
5. \`GET /v1/semantic-cache/{tenant}/stats?model_version=\`: **401** without a caller, **403** for
   another tenant's caller; the hit rate, the automated hit rate and share, the mean similarity, and
   the share of hits whose entry was older than an hour.

## Left out on purpose

Embedding generation and model hosting, an ANN index (the search here scans one tenant's set),
invalidation webhooks, negative caching, cross-region replication, billing, and the dashboard that
reads the stats endpoint.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'lookup · stats', x: 8, y: 50},
      {id: 'cache', kind: 'http', label: 'semcached', sub: 'HTTP :8080', x: 28, y: 50},
      {id: 'policy', kind: 'service', label: 'Serving policy', sub: 'floor 0.82 · cacheable', x: 50, y: 12},
      {
        id: 'redis',
        kind: 'redis',
        label: 'Redis',
        sub: 'entry:{t}:{v}:{id} · semantic:{t}:{v} · stats:{t}:{v}',
        x: 50,
        y: 40,
      },
      {id: 'llm', kind: 'grpc', label: 'Model', sub: 'Answer · 4 s', x: 50, y: 68},
      {id: 'kafka', kind: 'kafka', label: 'semantic-cache.result', sub: 'key = tenant', x: 50, y: 92},
      {id: 'stats', kind: 'service', label: 'stats consumer', sub: 'HINCRBY stats:{t}:{v}', x: 76, y: 92},
    ],
    edges: [
      {from: 'client', to: 'cache', kind: 'http', label: 'HTTP'},
      {from: 'cache', to: 'policy', kind: 'plain', label: 'clamp · is_cacheable'},
      {from: 'cache', to: 'redis', kind: 'redis', label: 'EVAL put_entry · SMEMBERS · HGETALL'},
      {from: 'cache', to: 'llm', kind: 'grpc', label: 'Answer on miss'},
      {from: 'cache', to: 'kafka', kind: 'kafka', label: 'produce · outbox on rejection'},
      {from: 'kafka', to: 'stats', kind: 'kafka', label: 'consume'},
      {from: 'stats', to: 'redis', kind: 'redis', label: 'HINCRBY · commit after'},
    ],
  },
  steps: [lookupEndpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
