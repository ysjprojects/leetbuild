import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Connector hub: the course is not "call a third-party API", it is the debugging you owe a
 * connector platform before it holds your customers' OAuth tokens and their vendors' rate limits.
 * Validated, idempotent registration against a held base URL → a durable Redis cursor that only
 * moves after a page is committed → a vendor fetch that backs off, gives up on permanent failures
 * and trips a breaker → connector-keyed sync events with tokens redacted and the cursor before the
 * offset commit → a health read that alerts on lag instead of reassuring on a recent run.
 */
export const connectorHubProblem: Problem = {
  id: 'connector-hub',
  title: 'Connector Hub',
  tagline: 'Vendor connectors with durable Redis cursors, backoff on 429 and a breaker on 5xx.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Connector Hub

A connector hub is the piece of a platform that keeps a vendor's records in sync with yours. The
visible part is a "connected" badge and a row count; the parts that decide whether the platform is
safe are the registration funnel, the durability of the sync cursor, the failure policy against a
vendor you do not control, the event that reports progress, and the health read that on-call pages
on.

## The real system

Airbyte's connector framework makes the checkpoint explicit: a source emits an \`AirbyteStateMessage\`
after each stream slice it finishes, the platform persists that state, and the next sync starts
from it rather than from the beginning of the stream. The checkpoint is written after the slice's
records are read, and the cursor field is the vendor's own ordering (an updated-at timestamp or an
opaque page token), which is what this course's Redis ledger reproduces with a claim key per page and
a cursor that moves only after the page has been committed.

The other pieces follow the same shape in any hub that holds customers' OAuth tokens. Registration
compares the caller's base URL against a host the operator registered instead of fetching it,
because "validate this URL for me" is a request forgery probe made with the platform's network
position. The token is referenced, not echoed. Vendor calls distinguish a 429 (backoff with jitter,
honouring \`Retry-After\`) from a 401 (one attempt, then disable with a reason) and from a run of 5xx
(a breaker). Progress events are keyed by connector id so one run reads back in order, and carry
counts and cursors rather than tokens or record contents, because the topic is retained. The health
read is an alert input: lag from the last successful page, consecutive failures, breaker state.

## What you build here

One service, **connectord**, with five pieces:

1. \`POST /v1/connectors\`: authenticated tenant, a source type from a fixed allowlist, an OAuth
   token **reference**, a base URL that must match the registration the platform already holds,
   rejected before any fetch, and an \`Idempotency-Key\` so a replayed registration returns the
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

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is to debug it against the failure modes, fix it, optimize
what is wasteful, and prove the fix with checks that fail on the starter and pass on your version.

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
