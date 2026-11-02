import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * CDN purge: the course is not "call an invalidate API", it is the debugging you owe a purge
 * control plane before it runs against a production CDN. Gated blast radius and an idempotent
 * intake → one atomic Redis reservation for dedupe and the domain's purge budget → a provider call
 * with a deadline, per-path outcomes and bounded retries under one batch id → domain-keyed,
 * confirmed purge events with an outbox → a status read that admits accepted is not propagated and
 * never leaks another tenant's purge.
 */
export const cdnPurgeProblem: Problem = {
  id: 'cdn-purge',
  title: 'CDN Purge',
  tagline:
    'A purge control plane that gates wildcards behind a scope and reports propagated only when every edge has confirmed.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# CDN Purge

A purge service turns "this object changed" into "no edge serves the old one". The visible part is
a \`200\` from an invalidate API; what decides whether the platform survives a bad deploy is the
blast radius a caller may ask for, the atomicity of the bookkeeping, and the status on-call reads
at 3 a.m.

## The real system

Fastly's purge API shapes the same problem. Purge-all is its own endpoint
(\`POST /service/{service_id}/purge_all\`), separate from purging one URL, because wiping a service
is a different capability from refreshing an object. Batch purges by surrogate key are capped at
256 keys per request. A \`Fastly-Soft-Purge: 1\` header marks objects stale instead of deleting
them, so edges revalidate with the origin rather than miss all at once; purge-all can not be soft,
which is why it needs the stronger gate. A control plane in front of such a provider adds the
ownership check, the per-domain budget, one batch id across retries, and propagation reported as a
separate event from acceptance.

## What you build here

One service, **purged**, with five pieces:

1. \`POST /v1/purges\`: a domain the tenant owns, at most 500 deduped paths, wildcards only with
   the \`purge:wildcard\` scope (\`purge:domain\` for \`/*\`), an \`Idempotency-Key\` so a replay
   returns the original purge, and a \`202\` that says accepted and nothing more.
2. A **Redis** reservation: per-path dedupe over ten minutes and a per-domain budget per
   five-minute window, in one atomic \`EVAL\`, answering \`429\` with \`Retry-After\` before the
   provider is called.
3. A **gRPC** provider client: a two-second deadline per attempt, three attempts, one \`batch_id\`,
   per-path outcomes where an invalid pattern is terminal, and retries of only the pending paths.
4. A **Kafka** event path: one \`cdn.purged\` event per \`(purge, path)\` keyed by domain, with a
   \`sha256\` path digest and the confirmed outcome, an idempotent producer, and an outbox row when
   the broker refuses the produce.
5. \`GET /v1/purges/{id}\`: the tenant's own purge or a \`404\`, a status derived from the per-path
   outcomes (\`accepted\`, \`propagated\`, \`partially_failed\`), the full outcome map, and
   \`propagated_at\` only once propagation has confirmed.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path, and looks right. Your
job in every step is to debug it against the failure modes, fix it, and prove the fix with checks
that fail on the starter and pass on yours.

## Left out on purpose

CDN account and zone management, multi-provider fan-out, per-POP propagation polling, purge cost
attribution, edge log shipping, tenant onboarding, and the purge timeline UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Control plane', sub: 'deploys · on-call', x: 8, y: 50},
      {id: 'purge', kind: 'http', label: 'Purge API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'tenant', kind: 'db', label: 'tenant · domains', sub: 'ownership · records', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'dedupe · budget', x: 44, y: 50},
      {id: 'cdn', kind: 'grpc', label: 'CDN provider', sub: 'BatchPurge', x: 66, y: 12},
      {id: 'edges', kind: 'external', label: 'Edge POPs', sub: 'propagation', x: 88, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'cdn.purged', sub: 'key = domain', x: 44, y: 86},
      {id: 'consumer', kind: 'service', label: 'Ops projector', sub: 'purge history', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'purge', kind: 'http', label: 'HTTPS'},
      {from: 'purge', to: 'tenant', kind: 'plain', label: 'ownership · records'},
      {from: 'purge', to: 'redis', kind: 'redis', label: 'dedupe · budget'},
      {from: 'purge', to: 'cdn', kind: 'grpc', label: 'BatchPurge'},
      {from: 'cdn', to: 'edges', kind: 'plain', label: 'propagate'},
      {from: 'purge', to: 'kafka', kind: 'kafka', label: 'produce cdn.purged'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY outcomes'},
      {from: 'consumer', to: 'tenant', kind: 'plain', label: 'confirmed outcomes'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
