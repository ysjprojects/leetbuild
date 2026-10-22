import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Connector hub on the AI-era track: the course is not "call a third-party API", it is the review
 * you owe a model-generated connector platform before it holds your customers' OAuth tokens and
 * their vendors' rate limits. Validated, idempotent registration against a held base URL → a
 * durable Redis cursor that only moves after a page is committed → a vendor fetch that backs off,
 * gives up on permanent failures and trips a breaker → connector-keyed sync events with tokens
 * redacted and the cursor before the offset commit → a health read that alerts on lag instead of
 * reassuring on a recent run.
 */
export const connectorHubProblem: Problem = {
  id: 'connector-hub',
  title: 'Connector Hub',
  tagline: 'Third-party connectors that sync on cursors, retry politely and never leak tokens.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Connector Hub

A connector hub is the piece of a platform that keeps a vendor's records in sync with yours. The
visible part is a "connected" badge and a row count; the parts that decide whether the platform is
safe are the registration funnel, the durability of the sync cursor, the failure policy against a
vendor you do not control, the event that reports progress, and the health read that on-call pages
on.

## The real system

Production connector hubs never trust the URL a caller supplies: the base URL is registered once, by
an operator, and every later sync fetches only that host, because "validate the customer's URL for
me" is a server-side request forgery probe with your network position attached. They hold a
reference to an OAuth token, never the token itself in a response or a log line, and they answer a
replayed registration with the connector that already exists instead of a second one.

A sync is a long-running job over pages, so its checkpoint is durable state, not a cache: the cursor
lives in Redis with no TTL, moves in one atomic step and only after the page has been committed, so
a crash mid-page re-fetches that page — deduped by its own page key — rather than skipping it. A
quiet connector that stops for a week must resume where it stopped, not replay three months of the
vendor's history.

Vendor calls fail in ways that must be told apart. A 429 is answered with exponential backoff and
jitter, honouring the vendor's own \`Retry-After\` when it sends one; a 401 is permanent, so it stops
after a single attempt and the connector is disabled with a reason a human can read; a run of 5xx
responses trips a breaker so five failures do not become thousands of calls against a vendor that is
already down.

Every page and every run publishes one \`connector.sync\` event keyed by **connector id**, so one
connector's run log stays ordered. The event carries counts, the cursor position and an error code —
never the access token, never a record's contents: the topic is retained and replicated, so whatever
it carries outlives the sync. The consumer folds the cursor forward before it commits its offset, so
a rebalance replays a page instead of losing a cursor advance.

And the health endpoint is what an alert fires on: last successful page time, cursor lag,
consecutive failures and breaker state, turning unhealthy when no page has landed in twice the
connector's configured sync interval — not "healthy, the last run was recent" while every page in
that run failed.

## What you build here

One service, **connectord**, with five pieces:

1. \`POST /v1/connectors\`: authenticated tenant, a source type from a fixed allowlist, an OAuth
   token **reference**, and a base URL that must match the registration the platform already holds
   — rejected before any fetch — with an \`Idempotency-Key\` so a replayed registration returns the
   existing connector.
2. A **Redis** sync ledger: a durable cursor per connector with no TTL, a per-page dedupe key, and
   one atomic script that claims the page and moves the cursor only after it is committed.
3. A **gRPC** vendor client: exponential backoff with jitter on 429, one attempt and a disable on
   401, and a breaker after five consecutive 5xx responses.
4. A **Kafka** sync path: one \`connector.sync\` event per page and per run keyed by connector id,
   an idempotent producer with \`acks=all\`, tokens and record contents excluded, an outbox row when
   the broker rejects the produce, and a consumer that advances the cursor before it commits.
5. \`GET /v1/connectors/{id}/health\`: tenant-scoped, a lag and breaker-state read that turns
   unhealthy after two missed sync intervals.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

OAuth consent flows and token refresh, vendor-specific pagination shapes, cursor compaction,
backfill tooling, connector scheduling and quotas, PII classification of vendor records, and the
dashboard. The five pieces above are the ones that decide whether a connector platform is correct,
durable and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator / Sync', sub: 'register · health', x: 8, y: 50},
      {id: 'hub', kind: 'http', label: 'Connector Hub', sub: 'HTTPS :8443', x: 27, y: 50},
      {id: 'db', kind: 'db', label: 'connectors · outbox', sub: 'registrations · cursor', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'cursors · health', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'connector.sync', sub: 'key = connector', x: 48, y: 90},
      {id: 'vendor', kind: 'grpc', label: 'Vendor fetch', sub: 'FetchPage', x: 70, y: 10},
      {id: 'oauth', kind: 'external', label: 'OAuth tokens', sub: 'token refs only', x: 70, y: 36},
      {id: 'consumer', kind: 'service', label: 'Sync consumer', sub: 'cursor · counters', x: 70, y: 66},
    ],
    edges: [
      {from: 'client', to: 'hub', kind: 'http', label: 'HTTPS'},
      {from: 'hub', to: 'db', kind: 'plain', label: 'connectors · outbox'},
      {from: 'hub', to: 'redis', kind: 'redis', label: 'cursor · page claim'},
      {from: 'hub', to: 'oauth', kind: 'plain', label: 'token ref'},
      {from: 'hub', to: 'vendor', kind: 'grpc', label: 'FetchPage'},
      {from: 'hub', to: 'kafka', kind: 'kafka', label: 'produce connector.sync'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'advance cursor'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'outbox drain'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
