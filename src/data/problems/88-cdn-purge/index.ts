import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * CDN purge on the AI-era track: the course is not "call an invalidate API", it is the review you
 * owe a model-generated purge control plane before it runs against a production CDN. Gated blast
 * radius and an idempotent intake → one atomic Redis reservation for dedupe and the domain's purge
 * budget → a provider call with a deadline, per-path outcomes and bounded retries under one batch
 * id → domain-keyed, confirmed purge events with an outbox → a status read that admits accepted is
 * not propagated and never leaks another tenant's purge.
 */
export const cdnPurgeProblem: Problem = {
  id: 'cdn-purge',
  title: 'CDN Purge',
  tagline: 'Purge exactly what changed, prove propagation and never stampede the origin.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# CDN Purge

A purge service is the piece of a delivery platform that turns "this object changed" into "no edge
serves the old one". The visible part is a \`200\` from an invalidate API; the parts that decide
whether the platform survives a bad deploy are the blast radius a caller is allowed to ask for, the
atomicity of the bookkeeping around it, the honesty of the failure reporting, and the status the
on-call engineer reads at 3 a.m.

## The real system

Production purge control planes serve many tenants against one shared CDN. They resolve a domain to
its owner before they purge anything, because a purge is a capability: a wildcard \`/pricing*\`
against someone else's domain is an outage they did not ask for. They cap and dedupe the patterns in
one request, and they charge a per-domain budget so a deploy loop cannot turn a purge into a
distributed denial of service against the origin — a wildcard purge makes every edge miss at once,
and the origin is the only place the missing objects can come from. They hand batches to the
provider under a deadline, retry only the failures that are worth retrying, reuse one batch id so a
retry cannot double-purge, and keep a per-path outcome for every pattern, because "the purge failed"
is not actionable and "this one pattern was rejected" is. They publish the *confirmed* outcome keyed
by domain so one domain's purge history stays ordered, and they keep an outbox for the day the broker
is down. And they never call a purge done when the provider merely accepted it: propagation is a
different event, minutes later, on every POP.

## What you build here

One service, **purged**, with five pieces:

1. \`POST /v1/purges\`: authenticated tenant, a domain the tenant owns, at most 500 deduped paths,
   wildcards only with the elevated \`purge:wildcard\` scope (\`purge:domain\` for \`/*\`), an
   \`Idempotency-Key\` so a replayed deploy purge returns the original purge instead of submitting
   twice, and a \`202\` that says accepted — nothing more.
2. A **Redis** reservation: per-path dedupe over a ten-minute window and a per-domain budget
   bucketed by a five-minute window, both in one atomic \`EVAL\`, answering \`429\` with
   \`Retry-After\` and \`X-Purge-Budget-Remaining\` before the provider is called.
3. A **gRPC** provider client: a two-second deadline per attempt, at most three attempts, one
   \`batch_id\` for the whole batch, per-path outcomes where an invalid pattern is terminal, and
   retries that replay only the paths still pending.
4. A **Kafka** event path: one \`cdn.purged\` event per \`(purge, path)\` keyed by domain, carrying a
   \`sha256\` path digest and the confirmed outcome, an idempotent producer, and an outbox row when
   the broker refuses the produce.
5. \`GET /v1/purges/{id}\`: the tenant's own purge or a \`404\`, a status derived from the per-path
   outcomes (\`accepted\`, \`propagated\`, \`partially_failed\`), the full outcome map with the failed
   paths in it, and \`propagated_at\` only once propagation has actually confirmed.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real delivery
platform: read the draft against the failure modes, name the subtle one, fix it, and prove the fix
with checks that fail on the draft and pass on your version.

## Left out on purpose

CDN account and zone management, multi-provider fan-out, per-POP propagation polling, purge cost
attribution, log shipping from the edges, tenant onboarding for domains, and the UI that shows a
purge timeline. The five pieces above are the ones that decide whether a purge is correct, isolated
and honest about what it knows.`,
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
