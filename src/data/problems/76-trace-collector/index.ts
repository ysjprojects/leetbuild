import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Trace collector on the AI-era track: the course is not "accept a span", it is the review you owe
 * a model-generated trace pipeline before an on-call engineer trusts it during an incident.
 * Validated span ingest at the edge → partial traces assembled atomically in Redis with dedupe and
 * a TTL → a deadline-bounded storage write that keeps the trace when storage is slow → completed
 * traces published per service without span payloads and counters before the offset commit → a
 * read path that shows the gaps, not a tidied-up tree.
 */
export const traceCollectorProblem: Problem = {
  id: 'trace-collector',
  title: 'Trace Collector',
  tagline: 'Assemble distributed traces from spans that arrive late, out of order and twice.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Trace Collector

A trace collector is the piece of an observability platform that turns the spans a fleet of services
emits into one tree per trace. The visible part is a waterfall in a UI; the parts that decide whether
that waterfall can be trusted are the validation funnel at the edge, the assembly state that has to
survive spans arriving late, out of order and twice, the failure policy for the day storage is slow,
and the honesty of the read path about the spans it never received.

## The real system

Production collectors ingest from thousands of SDKs that each keep their own clock and flush on their
own schedule. Nothing arrives in order: a parent span can show up minutes after the children that
name it, one exporter can retry the same batch, and a trace can simply stop half way because a
service crashed before it flushed. So the collector validates ids and units before it stores
anything, assembles each trace under a key that expires when the trace goes quiet, deduplicates a
span that arrives twice, and writes only complete traces to cold storage — where a storage timeout
must leave the trace to be retried rather than discard the only copy. It also publishes latency
events per service so a rollup stays ordered, without copying span tags (which carry user
identifiers) into a topic that is retained and replicated. And when a trace is read back, the gaps
are part of the answer: a trace whose child never arrived is marked partial, because an incident
review that sees a tidied-up tree draws the wrong conclusion.

## What you build here

One service, **traced**, with five pieces:

1. \`POST /v1/spans\`: authenticated tenant, 32-hex trace ids, 16-hex span ids, an explicit
   millisecond duration unit, and a self-parenting span rejected as **422** before any state is
   written.
2. A **Redis** assembly: one atomic Lua script inserts the span and updates root/child state, a
   per-span dedupe key makes a redelivered span a no-op, and every key expires 15 minutes after the
   last span of the trace.
3. A **gRPC** storage client: a 2-second deadline, deletion of the assembly state only after storage
   confirms the write, a timeout that keeps the trace for the next cycle, and a schema rejection
   that quarantines the trace instead of being retried forever.
4. A **Kafka** completion path: one \`trace.completed\` event per service, keyed by service id,
   carrying duration percentiles and span counts and never span tags, with the consumer updating its
   rollup counters before it commits the offset.
5. \`GET /v1/traces/{id}\`: the tree with absolute timestamps and per-span durations, an explicit
   partial marker plus the gaps when a child never arrived, and access scoped to the tenant that
   owns the trace.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real
observability feature: read the draft against the failure modes, name the subtle one, fix it, and
prove the fix with checks that fail on the draft and pass on your version.

## Left out on purpose

Sampling decisions, the OpenTelemetry wire format, span attribute schemas, tail-based sampling,
multi-region collectors, the trace UI, and retention policies per tenant. The five pieces above are
the ones that decide whether a trace is complete, honest and isolated.`,
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
