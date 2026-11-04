import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * CDN purge: the course is not "call an invalidate API", it is the debugging you owe a purge
 * control plane before it runs against a CDN. A scoped, idempotent intake → one atomic Redis
 * reservation for per-path dedupe and the domain's budget → a provider client with a deadline, one
 * batch id and per-path outcomes → domain-keyed events with stable ids and an outbox → a status read
 * that says propagated only once every edge confirmed. The purge records (`purge.records`) are the
 * provided store every step shares.
 */
export const cdnPurgeProblem: Problem = {
  id: 'cdn-purge',
  title: 'CDN Purge',
  tagline:
    'Scoped wildcard purges, a Redis purge budget, provider batches under one id, and a status that waits for the edges.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# CDN Purge

A purge service turns "this object changed" into "no edge serves the old one". The visible part is
a \`202\` from an invalidate API. What decides whether the platform survives a bad deploy is the
blast radius a caller may ask for, the bookkeeping that keeps a retried purge from running twice,
and the status on-call reads when a page is still stale.

## The real system

Fastly's purge API shapes the same problem. Purging everything a service caches is its own
endpoint, \`POST /service/{service_id}/purge_all\`, separate from purging one URL or one surrogate
key, so the two can be granted separately. A \`Fastly-Soft-Purge: 1\` header marks objects stale
instead of deleting them, so edges revalidate with the origin rather than all missing at once; purge
all cannot be soft. A control plane in front of such a provider adds what the provider cannot know:
who owns a domain, how much purging a domain may cost the origin, and when every path is gone.

## What you build here

One service, **purged**, around one provided store, the purge records (\`purge.records\`: a hash per
purge with its tenant, domain, \`accepted_at\`, each path's outcome and confirmation time, plus the
tenants' domains, the Idempotency-Key index, the queue and the outbox):

1. \`POST /v1/purges\`: a domain the tenant owns, 1 to 500 paths, wildcards only with
   \`purge:wildcard\` and \`/*\` only with \`purge:domain\`, and an \`Idempotency-Key\` whose replay
   answers the original purge with \`202 accepted\`.
2. \`reserve(domain, paths)\` in **Redis**: one Lua script dedupes each path for ten minutes
   (\`purge:seen:{domain}:{path}\`) and charges \`purge:budget:{domain}:{window}\`, 1000 paths per
   five minutes; a refusal writes nothing and names the \`Retry-After\` for a \`429\`.
3. \`submit_batch(purge_id, domain, paths)\`, a **gRPC** client of \`CdnProvider.BatchPurge\`: a 2 s
   deadline per attempt, three attempts under one \`batch_id\`, only pending paths resent, and every
   path ending \`accepted\`, \`invalid_pattern\` or \`failed\`.
4. \`publish_outcomes(purge_id, domain, outcomes)\` on **Kafka** \`cdn.purged\`: one event per path
   keyed by domain, \`event_id\` built from the purge id and the path's \`sha256\`, an idempotent
   producer, and an outbox row for every event the broker did not acknowledge.
5. \`GET /v1/purges/{id}\`: the tenant's own purge or \`404\`, a status of \`accepted\`, \`propagated\`
   or \`partially_failed\` derived from the paths, every outcome, and \`propagated_at\` only once the
   last edge confirmed.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path, and looks right. Your
job in every step is to debug it against the failure modes, fix it, and prove the fix with checks
that fail on the starter and pass on yours.

## Left out on purpose

CDN account and zone management, surrogate-key tagging at the origin, multi-provider fan-out,
per-POP propagation polling, the worker loop that drains the queue, the outbox relay, and the ops
projector that consumes \`cdn.purged\`.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Deploy script', sub: 'deploys · on-call', x: 8, y: 50},
      {id: 'purge', kind: 'http', label: 'Purge API', sub: 'purged', x: 26, y: 50},
      {id: 'records', kind: 'db', label: 'purge records', sub: 'outcomes · keys · outbox', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'dedupe · budget', x: 44, y: 50},
      {id: 'cdn', kind: 'grpc', label: 'CDN provider', sub: 'BatchPurge', x: 66, y: 12},
      {id: 'edges', kind: 'external', label: 'Edge POPs', sub: 'propagation', x: 88, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'cdn.purged', sub: 'key = domain', x: 44, y: 86},
      {id: 'consumer', kind: 'service', label: 'Ops projector', sub: 'dedupe on event_id', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'purge', kind: 'http', label: 'POST · GET /v1/purges'},
      {from: 'purge', to: 'records', kind: 'plain', label: 'create · get · outbox'},
      {from: 'purge', to: 'redis', kind: 'redis', label: 'EVAL reserve'},
      {from: 'purge', to: 'cdn', kind: 'grpc', label: 'BatchPurge · 2 s'},
      {from: 'cdn', to: 'edges', kind: 'plain', label: 'propagate'},
      {from: 'edges', to: 'records', kind: 'plain', label: 'confirmations'},
      {from: 'purge', to: 'kafka', kind: 'kafka', label: 'produce cdn.purged'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
