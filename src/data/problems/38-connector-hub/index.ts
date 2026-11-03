import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Connector hub: the course is not "call a third-party API", it is the debugging you owe a
 * connector platform before it holds your customers' OAuth tokens and their vendors' rate limits.
 * A registration pinned to the vendor's registered host → a durable Redis cursor moved by one page
 * claim → a vendor fetch that backs off, stops on a rejected token and trips a breaker →
 * connector-keyed sync events with an outbox → a health read measured from the last page that landed.
 */
export const connectorHubProblem: Problem = {
  id: 'connector-hub',
  title: 'Connector Hub',
  tagline: 'Vendor connectors whose Redis cursor survives a quiet weekend and whose client backs off on a 429.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Connector Hub

A connector hub keeps a vendor's records in sync with yours. It holds a customer's OAuth token
reference and a cursor into a vendor it does not control, and every bug in it shows up as one of
two things: data the platform skipped, or data it fetched twice.

## The real system

Airbyte makes the checkpoint explicit: a source emits an \`AirbyteStateMessage\` after the records
it covers, the platform persists that state, and the next sync of the stream starts from it rather
than from the beginning. This course builds the same shape on Redis: a cursor per connector that
moves only when a page is claimed, a vendor client that respects the vendor's limits, and a health
read that tells a lagging connector from a busy one.

## What you build here

One service, **connectord**, with five pieces that share one connector registry (\`hub.store\`,
provided) and one sync ledger (\`load_cursor\` / \`commit_page\`, built in step 2 and provided to the
later steps as \`hub.ledger\`):

1. \`POST /v1/connectors\` with \`X-Tenant-Id\` and \`Idempotency-Key\`, body \`{source_type, token_ref,
   base_url?, sync_interval_s?}\`: the host comes from \`REGISTERED_HOSTS\`, the answer is
   \`{connector_id, source_type, host, status}\`, and a replay answers the connector its key created.
2. A **Redis** ledger: \`cursor:{id}\` is a durable checkpoint, \`page:{id}:{page_token}\` the claim of
   one page, and one Lua script claims the page and moves the cursor.
3. A **gRPC** \`Vendor.FetchPage\` client: a 2-second deadline, backoff on \`RESOURCE_EXHAUSTED\`, a
   disabled connector on \`UNAUTHENTICATED\`, and a breaker kept in \`health:{id}\`
   (\`consecutive_failures\`, \`open_until\`, \`last_run_at\`).
4. A **Kafka** \`connector.sync\` stream: \`sync_page\` commits a page and produces
   \`{connector_id, cursor, records, at}\` keyed by connector id, with an outbox list for rejected
   produces; a consumer folds each event into \`health:{id}\` (\`last_success_at\`, \`pages\`,
   \`records\`) before it commits.
5. \`GET /v1/connectors/{id}/health\`: tenant-scoped, \`disabled\`, \`unhealthy\` or \`healthy\` from the
   last page that landed against two sync intervals, with the breaker and the failure count.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

OAuth consent and token refresh, vendor-specific pagination shapes, backfills, scheduling and
quotas across connectors, and the outbox relay itself.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'register · health', x: 8, y: 50},
      {id: 'hub', kind: 'http', label: 'connectord', sub: 'HTTPS :8443', x: 27, y: 50},
      {id: 'db', kind: 'db', label: 'connector registry', sub: 'connector:{id} · idem keys', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'cursor · page claim · health', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'connector.sync', sub: 'key = connector id', x: 48, y: 90},
      {id: 'vendor', kind: 'grpc', label: 'Vendor', sub: 'FetchPage · 2 s', x: 70, y: 10},
      {id: 'oauth', kind: 'external', label: 'OAuth tokens', sub: 'token refs only', x: 70, y: 36},
      {id: 'consumer', kind: 'service', label: 'Health consumer', sub: 'group connector-health', x: 70, y: 66},
    ],
    edges: [
      {from: 'client', to: 'hub', kind: 'http', label: 'HTTPS'},
      {from: 'hub', to: 'db', kind: 'plain', label: 'create · find_by_key · disable'},
      {from: 'hub', to: 'redis', kind: 'redis', label: 'commit_page · breaker'},
      {from: 'hub', to: 'oauth', kind: 'plain', label: 'token ref'},
      {from: 'hub', to: 'vendor', kind: 'grpc', label: 'FetchPage'},
      {from: 'hub', to: 'kafka', kind: 'kafka', label: 'produce connector.sync'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'health:{id}'},
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
