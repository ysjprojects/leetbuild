import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {cacheEndpointStep} from './steps/1-endpoint';
import {cacheStateStep} from './steps/2-state';
import {cacheDependencyStep} from './steps/3-dependency';
import {cacheEventsStep} from './steps/4-events';
import {cacheReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Prompt cache: the debugging a completion cache owes before a tenant trusts it. A key built from
 * tenant, prompt version and prefix digest → one conditional Redis fill that dies with its version →
 * a bounded model call that stores only deterministic answers → tenant-keyed decision events counted
 * before the offset commits → per-version stats a rollout decision can act on. The model server is a
 * deterministic stand-in the harness serves over gRPC.
 */
export const promptCacheProblem: Problem = {
  id: 'prompt-cache',
  title: 'Prompt Cache',
  tagline:
    'Completions cached under tenant and prompt version, with a Redis fill, a gRPC miss path and per-version stats.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Prompt Cache

A prompt cache decides how often an AI platform pays to generate the same completion twice. A hit is
the visible part; what makes a hit safe is the key it was found under, the fill that wrote it, the
answers the cache refused to keep, and the number it reports back. A cache that serves one tenant's
completion to another, or stores an outage message as an answer, has made the wrong answer cheap and
shared.

## The real system

GPTCache, the open-source LLM response cache, makes the lookup policy a pluggable similarity
evaluation: its \`exact_match\` evaluator counts a hit only when the stored question equals the query,
while embedding-based evaluators accept near matches. This course builds the exact-match end and adds
what a multi-tenant platform needs around it: a key that carries the tenant and the prompt version, a
fill that cannot overwrite a winner and dies with its version, a miss path that stores only
deterministic answers, and a decision stream the per-tenant stats are rebuilt from.

## What you build here

One service with five pieces sharing the \`pcache\` support package (\`config\`: the model address, the
topic, \`VERSION_TTL_S\`, the price table, the stats keys; \`record\`: the entry and miss shapes):

1. \`POST /v1/completions/cached\` (\`api\`): \`X-Tenant-Id\`, body \`{prefix, prompt_version,
   temperature}\`, an 8 KiB prefix cap, entries under \`pc:{tenant}:{version}:{sha256(prefix)}\`. It
   calls the next three pieces.
2. **Redis entries** (\`cache\`): \`lookup(key)\` and \`fill(key, record)\`; the fill is one
   \`SET … NX EX VERSION_TTL_S\` and the loser returns the stored record.
3. **gRPC miss path** (\`miss\`): \`complete_miss(key, tenant, version, prefix, temperature)\` calls
   \`Model.Complete\` under a 3-second deadline and fills only when \`temperature == 0\` and
   \`finish_reason == "stop"\`; a refusal or an error is answered and not stored.
4. **Kafka decisions** (\`events\`): \`emit_decision\` produces \`{tenant, version, prefix_digest,
   decision, latency_ms, tokens}\` to \`cache.result\` keyed by tenant; \`run_stats\` adds each one to
   \`pc-stats:{tenant}:{version}\` (\`hits\`, \`misses\`, \`fill_ms\`, \`tokens_saved\`) and
   \`pc-versions:{tenant}\`, then commits.
5. \`GET /v1/cache/stats\` (\`stats\`): one slice per prompt version for the caller's tenant, with hit
   ratio, fill latency and savings priced from the table; **403** for another tenant's stats.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and it
looks right. In every step, debug it against the failure modes the task names, fix it, and prove the
fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Tokenizer-aware prefix matching, partial-prefix (tree) caches, semantic caching, provider-side prompt
caching, eviction beyond the TTL, cache warming, cross-region replication and per-tenant quotas.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'completions · stats', x: 8, y: 50},
      {id: 'cache', kind: 'http', label: 'Prompt Cache', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'pc:{tenant}:{version}:{digest}', x: 50, y: 14},
      {id: 'model', kind: 'grpc', label: 'Model server', sub: 'Complete · 3 s', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'cache.result', sub: 'key = tenant', x: 50, y: 86},
      {id: 'consumer', kind: 'service', label: 'Stats consumer', sub: 'group cache-stats', x: 74, y: 86},
    ],
    edges: [
      {from: 'client', to: 'cache', kind: 'http', label: 'HTTPS'},
      {from: 'cache', to: 'redis', kind: 'redis', label: 'GET · SET NX EX'},
      {from: 'cache', to: 'model', kind: 'grpc', label: 'Complete · deadline 3 s'},
      {from: 'cache', to: 'kafka', kind: 'kafka', label: 'produce decision'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY pc-stats · SADD'},
    ],
  },
  steps: [cacheEndpointStep, cacheStateStep, cacheDependencyStep, cacheEventsStep, cacheReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
