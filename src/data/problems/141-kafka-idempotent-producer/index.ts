import type {Problem} from '@/lib/types';

import {idempotentProducerStep} from './steps/1-idempotent-producer';

/**
 * One Kafka mechanism, drilled: the idempotent producer with `acks=all`, a delivery callback that
 * retries retriable failures a bounded number of times and parks the rest, and a bounded in-flight
 * window that back-pressures the caller instead of dropping or growing without limit.
 */
export const kafkaIdempotentProducerProblem: Problem = {
  id: 'kafka-idempotent-producer',
  title: 'An idempotent producer under lost acks and failures',
  tagline:
    'enable.idempotence + acks=all, a delivery callback that retries then parks, and an in-flight window that holds the caller back.',
  difficulty: 'medium',
  concepts: ['kafka'],
  minutes: 25,
  statement: `# An idempotent producer under lost acks and failures

A producer hands a record to the client, the client sends it, the broker writes it and answers. Any
of the three can fail, and the failures look different from the producer's chair: the ack never
comes back (was it written?), the delivery report says *timed out* (try again?), or the broker says
no and means it. **\`enable.idempotence\`** answers the first question — the broker tags the
producer's batches with a sequence number and writes a resend of an already-written batch once —
and the delivery callback is where the other two are decided.

Every service that emits events this way — order systems, audit logs, change feeds — carries the
same three rules: an idempotent producer with \`acks=all\`, a callback that retries a retriable error
a bounded number of times and parks the record otherwise, and a bound on how many records may be in
flight so a slow broker slows the caller instead of exhausting its memory.

## What you build here

1. \`send(event_id, payload)\` on the **\`events\`** topic, keyed by \`event_id\`, with \`stats()\` and a
   bounded \`shutdown()\`: delivered counted once per record whatever the ack did, retriable failures
   retried up to \`MAX_RETRIES\`, the rest in \`dead\`, and never more than \`MAX_PENDING\` records in
   flight.

## Left out on purpose

Transactions, the dead-letter *topic* the parked ids would be written to, batching tuning
(\`linger.ms\`, \`batch.size\`) and the consumer side. The three rules above are what decide whether a
retry turns one event into two or into zero.`,
  diagram: {
    nodes: [
      {
        id: 'emitter',
        kind: 'service',
        label: 'event emitter',
        sub: 'send(event_id, payload) · stats · shutdown',
        x: 25,
        y: 50,
      },
      {id: 'kafka', kind: 'kafka', label: 'events', sub: 'key = event_id · 3 partitions', x: 70, y: 50},
    ],
    edges: [
      {from: 'emitter', to: 'kafka', kind: 'kafka', label: 'produce · acks=all · idempotent'},
      {from: 'kafka', to: 'emitter', kind: 'kafka', label: 'delivery report'},
    ],
  },
  steps: [idempotentProducerStep],
};
