import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {keyedProducerStep} from './steps/1-keyed-producer';

/** Kafka drill: a keyed, acks=all producer whose request path never waits and whose shutdown waits at most 5 s. */
export const kafkaKeyedProducerProblem: Problem = {
  id: 'kafka-keyed-producer',
  title: 'Produce keyed events, flush on shutdown',
  tagline:
    'A Kafka producer done right: keyed by order id, acks=all, outcomes counted in the delivery callback, a shutdown that flushes for five seconds and no longer.',
  difficulty: 'easy',
  concepts: ['kafka'],
  minutes: 15,
  statement: `# Produce keyed events, flush on shutdown

A Kafka producer is a buffer with a background thread: \`produce\` appends to a queue and returns, batches go
out later, and the broker's answer comes back through a **delivery callback**. Three decisions make or break
it: the **key** (equal keys hash to one partition, so an order's events stay in order), **\`acks=all\`** (an
acknowledged record is replicated, not just on the leader), and **what the process does when it stops** — a
flush that never returns holds a deploy hostage, no flush at all loses the tail of the queue.

Every order service, every analytics pipeline, every audit log has this module: an \`emit\` that costs
microseconds on the request path and a \`shutdown\` that drains the queue with a deadline. The surface here is
\`emit(order_id, event)\`, \`stats()\` with the \`delivered\` / \`failed\` counts the callback keeps, and
\`shutdown() -> int\`, the number of records still undelivered after a 5-second flush.

## What you build here

1. The \`order-events\` producer: keyed by order id, JSON \`{"order_id", "type", "ts"}\` values, \`acks=all\`, a
   counting delivery callback served by \`poll(0)\`, and a \`shutdown()\` that flushes for at most 5 s and reports
   what is left.

## Left out on purpose

Idempotent retries, a bounded queue with a drop policy, headers and schema registries, and the consumer side.
Those come after the producer's three decisions are right.`,
  diagram: {
    nodes: [
      {id: 'orders', kind: 'service', label: 'orders', sub: 'emit(order_id, event) · shutdown()', x: 25, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'order-events', sub: 'key = order id · acks=all', x: 75, y: 50},
    ],
    edges: [{from: 'orders', to: 'kafka', kind: 'kafka', label: 'produce · poll(0) · flush(5 s)'}],
  },
  steps: [keyedProducerStep],
  learn,
};
