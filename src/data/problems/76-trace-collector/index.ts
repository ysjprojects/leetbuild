import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Trace collector: the course is not "accept a span", it is the debugging you owe a trace pipeline
 * before an on-call engineer trusts it during an incident. Validated span ingest at the edge → one
 * Redis hash per trace assembled by one Lua script with dedupe and a TTL → a deadline-bounded
 * storage write that keeps the trace when storage is slow → one trace.completed event per service
 * and a rollup that counts before it commits → a read path that shows the gaps.
 */
export const traceCollectorProblem: Problem = {
  id: 'trace-collector',
  title: 'Trace Collector',
  tagline:
    'Spans that arrive late and twice, assembled in one Redis hash per trace and written to storage under a deadline.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Trace Collector

A trace collector turns the spans a fleet of services emits into one tree per trace. The visible
part is a waterfall in a UI; what decides whether it can be trusted is the validation at the edge,
the assembly that survives spans arriving late and twice, the policy for the day storage is slow,
and whether the read path admits which spans it did not receive.

## The real system

The OpenTelemetry Collector's tail sampling processor meets the same problem: it groups spans by
\`trace_id\` in memory, waits \`decision_wait\` (30 seconds by default) before judging a trace, caps
the traces it holds with \`num_traces\`, and needs every span of one trace to reach the same
collector instance, because a decision made on half a trace is wrong. The pressures behind it shape
this course: parents arrive after their children, exporters retry whole batches, and a trace stops
half way when a service crashes.

## What you build here

One service, **traced**, around one Redis hash per trace, \`trace:{trace_id}\`: \`owner\`, \`count\`,
\`missing\`, \`root\`, \`extra_roots\`, \`span:{span_id}\` (the span as JSON) and \`refs:{span_id}\`.
Step 2 builds \`insert_span(tenant, span)\`; the other steps use the provided \`traces.assembly\`
(\`insert_span\`, \`load_trace\`, \`delete_trace\`, \`quarantine\`), which keeps the same layout.

1. \`POST /v1/spans\` with \`{trace_id, span_id, parent_span_id, service, start_ms, duration_ms}\` and
   \`X-Tenant-Id\`: 401 without a tenant, 422 for a malformed id, a self-parent or a duration out of
   range, all before \`insert_span\`.
2. **Redis** \`insert_span\`: one Lua script, a stored span is a no-op, a late parent closes its gap,
   the hash expires 900 s after the last span.
3. **gRPC** \`flush_trace\` to \`TraceWriter.Write\` at \`storage:9000\`: a 2-second deadline, at most 3
   attempts, the hash deleted only after OK, \`INVALID_ARGUMENT\` quarantined.
4. **Kafka** \`trace.completed\`: one \`{trace_id, service, span_count, max_ms}\` per service, keyed by
   service, idempotent with \`acks=all\`; \`run_rollup\` (group \`latency-rollup\`) increments
   \`rollup:{service}\` before it commits.
5. \`GET /v1/traces/{trace_id}\`: the owner's trace only, every span with absolute \`start_ms\` and
   \`end_ms\`, \`gaps\` and \`partial\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

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
      {id: 'quarantine', kind: 'redis', label: 'Quarantine', sub: 'quarantine:{id} · 7 days', x: 68, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'trace.completed', sub: 'key = service', x: 46, y: 74},
      {id: 'rollup', kind: 'service', label: 'Latency rollup', sub: 'group latency-rollup', x: 68, y: 74},
    ],
    edges: [
      {from: 'sdk', to: 'collector', kind: 'http', label: 'POST /v1/spans'},
      {from: 'reader', to: 'collector', kind: 'http', label: 'GET /v1/traces/{id}'},
      {from: 'collector', to: 'redis', kind: 'redis', label: 'EVAL insert_span'},
      {from: 'collector', to: 'storage', kind: 'grpc', label: 'Write · 2s deadline'},
      {from: 'collector', to: 'quarantine', kind: 'plain', label: 'INVALID_ARGUMENT'},
      {from: 'collector', to: 'kafka', kind: 'kafka', label: 'produce trace.completed'},
      {from: 'kafka', to: 'rollup', kind: 'kafka', label: 'consume'},
      {from: 'rollup', to: 'redis', kind: 'redis', label: 'HINCRBY rollup:{service}'},
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
