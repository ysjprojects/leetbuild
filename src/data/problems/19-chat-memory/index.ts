import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Chat memory service: the course is not "store messages in Redis", it is the debugging you owe a
 * memory layer before it serves long conversations to real tenants. An authenticated, bounded,
 * replay-safe append → one atomic, capped, expiring buffer per (tenant, session) → a
 * deadline-bounded summarizer call whose result is stored once per span → conversation-keyed turn
 * events without content, with an outbox → a context read that keeps the newest turns within a token
 * budget and caches per tenant and turn.
 */
export const chatMemoryProblem: Problem = {
  id: 'chat-memory',
  title: 'Chat Memory Service',
  tagline: 'Turns appended per tenant, a Redis window of 50, span summaries over gRPC and a 6000-token context read.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Chat Memory Service

A chat memory service keeps a conversation alive across requests. It appends each turn, keeps the
recent window small enough to read on every model call, compresses what falls out of that window,
tells other services a turn happened, and assembles the context the next model call reads. A user
sees a conversation that remembers; the service decides whose conversation a turn lands in, how
much of it survives, and what a model is allowed to see.

## The real system

LangGraph's Redis checkpointer (\`langgraph-checkpoint-redis\`) stores each conversation thread's
state under its \`thread_id\` and takes a \`ttl\` configuration with a \`default_ttl\` in minutes and
a \`refresh_on_read\` flag, so an idle thread expires on its own while an active one keeps renewing
its lease. This course makes the same decision at the write path: one window per conversation,
expired by the store rather than by a reaper.

## What you build here

One service, **memd**, with five pieces that share one Redis layout and the provided \`memory\`
package: \`memory.sessions\` (API keys, turn ids \`t-1\`, \`t-2\`, …, the token estimate
\`count_tokens\`, idempotency records), \`memory.buffer\`, \`memory.summaries\` and \`memory.outbox\`.

1. \`POST /v1/sessions/{id}/turns\` with \`{role, content}\`: the tenant from \`Authorization: Bearer
   <key>\`, a \`user\` or \`assistant\` role, at most 32 KiB of UTF-8, and an \`Idempotency-Key\`
   recorded under \`idem:{tenant}:{key}\`.
2. A **Redis** buffer, \`turns:{tenant}:{session_id}\`: \`append_turn\` and \`recent_turns\`, the last
   50 turns, expiring 24 hours after the last write, appended by one Lua script.
3. A **gRPC** \`Summarizer.Summarize\` client, \`summarize_span\`: 1.5 s per attempt, two attempts on
   \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`, the summary stored once with \`HSETNX\` in
   \`summaries:{tenant}:{session_id}\` under the span id \`{first_turn_id}:{last_turn_id}\`.
4. A **Kafka** \`session.turn\` event, \`publish_turn_event\`: keyed \`{tenant}:{session_id}\`, carrying
   \`{type, tenant, session_id, turn_id, role, tokens}\` and no content, from an idempotent producer
   with \`acks=all\`, and an \`outbox\` row when no acknowledgement arrives within 2 s.
5. \`GET /v1/sessions/{id}/context\`: the latest summary and the newest turns within 6000 tokens,
   cached for 60 s under \`context:{tenant}:{session_id}:{latest_turn_id}\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Provider-specific tokenizers, embedding-based retrieval, multi-region replication, conversation
search, PII redaction, billing for stored tokens and the UI. The five pieces above decide whether
memory is correct, isolated and safe to ship.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Chat client', sub: 'API key · retries', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'memd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'turns · summaries · outbox', x: 48, y: 22},
      {id: 'kafka', kind: 'kafka', label: 'session.turn', sub: 'key = tenant:session', x: 48, y: 80},
      {id: 'worker', kind: 'service', label: 'Memory worker', sub: 'summarize_span · outbox relay', x: 70, y: 60},
      {id: 'summarizer', kind: 'grpc', label: 'Summarizer', sub: 'Summarize · 1.5 s', x: 88, y: 30},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS · Bearer key'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'append_turn · context cache'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'publish_turn_event'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'summarizer', kind: 'grpc', label: 'Summarize span'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'HSETNX span summary'},
      {from: 'worker', to: 'kafka', kind: 'plain', label: 'relay outbox rows'},
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
