import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Trace collector: the course is not "accept a span", it is the debugging you owe a trace pipeline
 * before an on-call engineer trusts it during an incident. Validated span ingest at the edge →
 * partial traces assembled atomically in Redis with dedupe and a TTL → a deadline-bounded storage
 * write that keeps the trace when storage is slow → completed traces published per service without
 * span payloads and counters before the offset commit → a read path that shows the gaps, not a
 * tidied-up tree.
 */
export const traceCollectorProblem: Problem = {
  id: 'trace-collector',
  title: 'Trace Collector',
  tagline: 'Assemble distributed traces in Redis from spans that arrive out of order and get retried.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Trace Collector

A trace collector turns the spans a fleet of services emits into one tree per trace. The visible
part is a waterfall in a UI; what decides whether it can be trusted is the validation at the edge,
the assembly state that survives spans arriving late and twice, the failure policy for the day
storage is slow, and whether the read path admits which spans it did not receive.

## The real system

Production collectors ingest from thousands of SDKs that each keep their own clock and flush on their
own schedule. A parent span can show up minutes after its children, one exporter can retry the same
batch, and a trace can stop half way because a service crashed. The OpenTelemetry Collector's tail
sampling processor makes this explicit: it groups spans by \`trace_id\` in memory, waits
\`decision_wait\` (30 seconds by default) before judging a trace, caps the traces it holds with
\`num_traces\`, and requires every span of one trace to reach the same collector instance, because
a decision made on half a trace is wrong. The same pressures shape this course: validate ids and
units before storing anything, expire each trace's key when it goes quiet, make a redelivered span
a no-op, and let a storage timeout keep the trace for a retry. When a trace is read back, the gaps
are part of the answer.

## What you build here

One service, **traced**, with five pieces:

1. \`POST /v1/spans\`: authenticated tenant, 32-hex trace ids, 16-hex span ids, an explicit
   millisecond duration unit, and a self-parenting span rejected as **422** before any write.
2. A **Redis** assembly: one atomic Lua script, a per-span dedupe key, and every key expiring 15
   minutes after the last span.
3. A **gRPC** storage client: a 2-second deadline, deletion only after storage confirms the write,
   and a schema rejection that is quarantined instead of retried.
4. A **Kafka** completion path: one \`trace.completed\` event per service, keyed by service id,
   without span tags, with rollup counters updated before the offset commit.
5. \`GET /v1/traces/{id}\`: absolute timestamps, a partial marker plus the gaps when a child did
   not arrive, and access scoped to the owning tenant.

## The debugging habit

Every starter compiles, serves the happy path and looks right. In every step you debug it against
the failure modes, fix it, and prove the fix with checks that fail on the starter.

## Left out on purpose

Sampling decisions, the OpenTelemetry wire format, span attribute schemas, multi-region collectors,
the trace UI, and retention policies per tenant.`,
  diagram: {
    nodes: [
      {id: 'sdk', kind: 'client', label: 'Traces SDK', sub: 'OTel exporters', x: 8, y: 34},
      {id: 'reader', kind: 'client', label: 'Trace reader', sub: 'on-call · UI', x: 8, y: 74},
      {id: 'collector', kind: 'http', label: 'Trace Collector', sub: 'HTTPS :8443', x: 26, y: 34},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'trace:{id} assembly', x: 46, y: 34},
      {id: 'storage', kind: 'grpc', label: 'Span storage', sub: 'TraceWriter/Write', x: 68, y: 14},
      {id: 'quarantine', kind: 'db', label: 'Quarantine', sub: 'schema rejects', x: 68, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'trace.completed', sub: 'key = service', x: 46, y: 74},
      {id: 'rollup', kind: 'service', label: 'Latency rollup', sub: 'group latency', x: 68, y: 74},
    ],
    edges: [
      {from: 'sdk', to: 'collector', kind: 'http', label: 'POST /v1/spans'},
      {from: 'reader', to: 'collector', kind: 'http', label: 'GET /v1/traces/{id}'},
      {from: 'collector', to: 'redis', kind: 'redis', label: 'EVAL insert span'},
      {from: 'collector', to: 'storage', kind: 'grpc', label: 'Write · 2s deadline'},
      {from: 'collector', to: 'quarantine', kind: 'plain', label: 'INVALID_ARGUMENT'},
      {from: 'collector', to: 'kafka', kind: 'kafka', label: 'produce trace.completed'},
      {from: 'kafka', to: 'rollup', kind: 'kafka', label: 'consume'},
      {from: 'rollup', to: 'redis', kind: 'redis', label: 'HINCRBY rollups'},
      {from: 'storage', to: 'reader', kind: 'plain', label: 'confirmed traces'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
