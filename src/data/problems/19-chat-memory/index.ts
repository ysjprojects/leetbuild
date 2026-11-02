import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Chat memory service: the course is not "store messages in Redis", it is the debugging you owe a
 * memory layer before it serves long conversations to real tenants. Validated, idempotent turn
 * appends → one atomic, capped, expiring buffer per (tenant, session) → a deadline-bounded
 * summarizer call with a deterministic span identity → tenant-keyed session events without
 * content and with an outbox → a tenant-scoped, capped, fresh context read.
 */
export const chatMemoryProblem: Problem = {
  id: 'chat-memory',
  title: 'Chat Memory Service',
  tagline:
    'Conversation memory with a capped buffer per tenant, a summarizer on a deadline and a content-free event log.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Chat Memory Service

A chat memory service keeps a conversation alive across requests: it appends each turn, keeps the
recent window small enough to be fast, compresses what falls out of the window, publishes the
events other services depend on, and assembles the context a model call reads. The visible part is
a conversation that remembers; the parts that decide whether the service is safe are the validation
funnel, the bounded and expiring buffer, the deadline-bounded summarizer call, the content-free
event, and the tenant-scoped read.

## The real system

LangGraph's Redis checkpointer (\`langgraph-checkpoint-redis\`) stores each conversation thread's
state under its \`thread_id\` and takes a \`ttl\` configuration with a \`default_ttl\` in minutes and
a \`refresh_on_read\` flag, so an idle thread expires on its own and an active one keeps renewing
its lease. That is the decision this course asks for at the write path: one window per
conversation, expired by the store rather than by a reaper. A multi-tenant memory layer adds the
rest. Every field a client sends is a claim: the session id in the path, the role, the content
size, the idempotency key. A retried append answers with the turn already written. The window is
mutated in one atomic step, so concurrent appends cannot lose a turn. An overflowing span is
summarized under a deadline with a deterministic identity, so two workers race on one key. Events
carry ids and token counts rather than text, because the topic outlives any buffer TTL. The read
path shares the write path's tenant scope and carries a cache key that changes with the
conversation.

## What you build here

One service, **memd**, with five pieces:

1. \`POST /v1/sessions/{id}/turns\`: authenticated tenant, validated role, a 32 KiB content cap, a
   session-ownership check, and an \`Idempotency-Key\` so a retry returns the stored turn.
2. A **Redis** recent-turn buffer: one list per (tenant, session), the last 50 turns, a 24-hour TTL,
   and a single atomic script that pushes, trims and expires in one step.
3. A **gRPC** summarizer client: a 1.5-second deadline per attempt, at most two attempts, a
   deterministic span identity, and a \`SET NX\` write so a retry stores one summary.
4. A **Kafka** session-event path: \`session.turn\` keyed by tenant, \`acks=all\`, ids and token
   counts instead of content, a wait for the broker, and an outbox row when the produce is rejected.
5. \`GET /v1/sessions/{id}/context\`: tenant-scoped, summary plus recent turns, a 6000-token cap
   that drops the oldest first, citable turn ids, and a cache keyed on the latest turn id.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path,
and it looks right. In every step you debug it against the failure modes, name the subtle one, fix
it, optimize what is wasteful, and prove the fix with checks that fail on the starter and pass on
your version.

## Left out on purpose

Model tokenizers per provider, embedding-based retrieval, multi-region replication, conversation
search, PII redaction, billing for stored tokens, and the UI. The five pieces above decide whether
memory is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'chat UI · retries', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Memory API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'durable store', sub: 'sessions · outbox', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'turns · summaries', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'session.turn', sub: 'key = tenant', x: 46, y: 90},
      {id: 'summarizer', kind: 'grpc', label: 'Summarizer', sub: 'Summarize / Get', x: 70, y: 10},
      {id: 'worker', kind: 'service', label: 'Memory worker', sub: 'summary · outbox', x: 70, y: 60},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'sessions · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'turns · summaries'},
      {from: 'api', to: 'summarizer', kind: 'grpc', label: 'Summarize'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce session.turn'},
      {from: 'worker', to: 'summarizer', kind: 'grpc', label: 'Summarize span'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'write summary'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'db', kind: 'plain', label: 'outbox drain'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
