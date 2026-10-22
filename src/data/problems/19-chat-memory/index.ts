import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Chat memory service on the AI-era track: the course is not "store messages in Redis", it is the
 * review you owe a model-generated memory layer before it serves long conversations to real tenants.
 * Validated, idempotent turn appends → one atomic, capped, expiring buffer per (tenant, session) →
 * a deadline-bounded summarizer call with a deterministic span identity → tenant-keyed session
 * events without content and with an outbox → a tenant-scoped, capped, fresh context read.
 */
export const chatMemoryProblem: Problem = {
  id: 'chat-memory',
  title: 'Chat Memory Service',
  tagline: 'Bounded, tenant-scoped, crash-safe conversation memory — reviewed like production.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Chat Memory Service

A chat memory service is the piece of an AI platform that keeps a conversation alive across
requests: it appends each turn, keeps the recent window small enough to be fast, compresses what
falls out of the window, publishes the events other services live on, and assembles the context a
model call actually reads. The visible part is a conversation that remembers; the parts that decide
whether the service is safe are the validation funnel, the bounded and expiring buffer, the
deadline-bounded summarizer call, the content-free event, and the tenant-scoped read.

## The real system

Production memory layers receive turns from many tenants, and every field a client sends is a claim:
the session id in the path, the role string, the size of the content, the idempotency key. They
answer a retried append with the turn they already wrote instead of appending it twice. They keep
the recent window in one structure per (tenant, session) and mutate it in one atomic step, so a
concurrent pair of appends cannot lose a turn and a trim cannot race an append. They cap the window
and expire it, because an unbounded buffer is a memory leak with a latency story attached. When the
window overflows they summarize the oldest span under a deadline and a bounded retry, and they give
the span a deterministic identity so two workers race on one key instead of writing two summaries.
They publish what other services need — ids and token counts — and never the message text, because
the topic is retained and replicated far past any buffer TTL. And they serve the read path with the
same tenant scope as the write path, a token budget, and a cache key that changes when the
conversation does.

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

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Model tokenizers per provider, embedding-based retrieval, multi-region replication, conversation
search, PII redaction, billing for stored tokens, and the UI. The five pieces above are the ones
that decide whether memory is correct, isolated and shippable.`,
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
