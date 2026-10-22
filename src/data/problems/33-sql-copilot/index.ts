import type {Problem} from '@/lib/types';

import {sqlEndpointStep} from './steps/1-endpoint';
import {sqlStateStep} from './steps/2-state';
import {sqlDependencyStep} from './steps/3-dependency';
import {sqlEventsStep} from './steps/4-events';
import {sqlReadStep} from './steps/5-read';

/**
 * SQL copilot on the AI-era track: the course is not "ask a model for SQL", it is the review you owe
 * a natural-language-to-SQL service before any of its output reaches a database. A validated
 * generation funnel that returns a read-only verdict → an atomic schema cache and a per-user
 * generation budget → a warehouse dry-run with a deadline that denies instead of degrading → schema
 * keyed events with a fingerprint instead of the question → read-only execution behind a row cap and
 * a server-held cursor.
 */
export const sqlCopilotProblem: Problem = {
  id: 'sql-copilot',
  title: 'SQL Copilot',
  tagline: 'Natural language to SQL where the generated query must be provably read-only.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# SQL Copilot

A SQL copilot turns "how many orders did we ship late last month?" into a statement an analyst can
run. The visible part is a question and a query; the parts that decide whether the company survives
are the validation funnel, the cached schema the model is allowed to see, the dry-run that gates every
statement, the way the outcome is published, and the connection the query finally runs on.

## The real system

Production copilots never accept SQL from the caller and never hand back a statement they have not
classified. The generation endpoint measures the question, takes the dialect from an allowlist, asks
the model, and refuses anything that is not read-only before the caller can send it on. The schema
summary the model sees is cached and versioned, so a half-refreshed schema cannot make it invent
columns. Every statement is dry-run against the warehouse under a deadline, and a timeout denies the
query instead of degrading into "probably fine". Outcomes are published keyed by schema handle,
carrying a fingerprint of the question rather than the question and never a literal value, because a
topic is retained and replicated. And the thing that finally runs is a statement the service itself
chose, read-only, row-capped, on a replica, on a transaction that cannot write.

## What you build here

One service, **copilotd**, with five pieces:

1. \`POST /v1/queries/generate\`: an authenticated tenant, a question capped at 2 KiB, a schema handle
   and a dialect from an allowlist, a server-side read-only verdict in the response, and a **422**
   for any draft that may write.
2. A **Redis** cache and limiter: schema summaries per \`(tenant, schema handle)\` with a 15-minute
   TTL refreshed by one atomic replacement, and 100 generations per user per hour reserved with an
   atomic \`INCR\` whose window key expires, answering \`429\` with \`Retry-After\` before the model is
   called.
3. A **gRPC** warehouse client: every statement dry-run with a 2-second deadline, a fail-closed
   \`validation_error\`, retries only on \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and no length gate —
   a long statement is exactly the one that needs validating.
4. A **Kafka** audit path: one \`copilot.query\` event per generation keyed by the schema handle, a
   SHA-256 fingerprint instead of the question, an outbox row when the broker rejects the produce,
   and an idempotent producer with \`acks=all\`.
5. \`GET /v1/queries/{id}/results\`: the validated statement looked up by id — never taken from the
   request — rejected when a second statement follows a semicolon, capped at 5000 rows whatever the
   SQL asks for, paged by a server-held cursor, and executed on a read replica inside
   \`SET TRANSACTION READ ONLY\`.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident — "clean up the stale rows" comes back as an answer instead of a warning.
Your job in every step is the job you will have on a real AI feature: read the draft against the
failure modes, name the subtle one, fix it, and prove the fix with checks that fail on the draft and
pass on your version.

## Left out on purpose

Model fine-tuning and prompt authoring, the schema-summary extractor itself, row-level permissions
inside the warehouse, result formatting and charts, cursor signing, and cost accounting against the
warehouse's own billing. The five pieces above are the ones that decide whether the copilot is
correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'question · results', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'SQL Copilot', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'Schema store', sub: 'summaries · statements', x: 46, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'schema cache · budget', x: 46, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'copilot.query', sub: 'key = schema', x: 46, y: 86},
      {id: 'warehouse', kind: 'grpc', label: 'Warehouse', sub: 'DryRun / Execute', x: 70, y: 8},
      {id: 'model', kind: 'external', label: 'Model', sub: 'question → statement', x: 70, y: 44},
      {id: 'replica', kind: 'db', label: 'Read replica', sub: 'read-only txn', x: 70, y: 74},
      {id: 'consumer', kind: 'service', label: 'Query audit', sub: 'group by schema', x: 90, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'schema handle'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'cache · budget'},
      {from: 'api', to: 'model', kind: 'plain', label: 'generate'},
      {from: 'api', to: 'warehouse', kind: 'grpc', label: 'DryRun'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce copilot.query'},
      {from: 'api', to: 'replica', kind: 'plain', label: 'read-only execute'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'history'},
    ],
  },
  steps: [sqlEndpointStep, sqlStateStep, sqlDependencyStep, sqlEventsStep, sqlReadStep],
};
