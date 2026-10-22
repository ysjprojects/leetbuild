import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {asyncAckTrackingStep} from './steps/1-async-ack-tracking';

/** Kafka drill: handlers run concurrently per partition, the commit still means "everything below is done". */
export const kafkaAsyncAckTrackingProblem: Problem = {
  id: 'kafka-async-ack-tracking',
  title: 'Out-of-order completion, in-order commits',
  tagline:
    'Eight handlers in flight per consumer, completions in any order, and a committed offset that never passes a record still running: a per-partition ack tracker that commits the lowest contiguous frontier.',
  difficulty: 'hard',
  concepts: ['kafka'],
  minutes: 35,
  statement: `# Out-of-order completion, in-order commits

A committed offset is one number per partition, and it makes one promise: *everything below this is done*.
A consumer that handles one record at a time keeps that promise for free — commit \`offset + 1\` after each
record. The moment handlers run concurrently the order of completion is no longer the order of delivery:
offsets 41 and 42 finish while 40 is still waiting on a slow downstream call. Commit 43 now and a crash
replays nothing — 40 is lost. Commit nothing until everything finishes and the consumer stalls on its
slowest record.

Every consumer whose handler does I/O meets this: a webhook dispatcher, an email sender, an enrichment
job calling a model. The fix is an **ack tracker** per partition: completions go into a set, and what gets
committed is the **frontier** — the lowest offset not yet finished — advanced over every finished offset
above it. 41 and 42 done, 40 running: the frontier stays at 40, nothing is committed. 40 done: the frontier
jumps to 43 in one step. Confluent's Parallel Consumer is this idea with a bitmap in the commit metadata;
here it is the idea alone.

The surface is \`run(handler)\`, which consumes \`requests\` in group \`async-workers\` with at most
\`CONCURRENCY = 8\` handlers in flight, \`shutdown()\`, which waits for the running handlers (at most 5 s),
commits every frontier and closes, and \`stats()\`, the in-flight count and the last committed offset per
partition.

## What you build here

1. The \`async-workers\` consumer: auto-commit off, a bounded set of handler tasks, a per-partition tracker
   whose frontier is the only thing ever committed, and a shutdown that drains before it closes.

## Left out on purpose

Retries and dead letters for failed handlers, ordering by key inside a partition, encoding the finished set
into commit metadata so a restart skips what was already done above the frontier, and heartbeats while
the loop waits at the limit. Those are what production adds once the frontier is right.`,
  diagram: {
    nodes: [
      {id: 'kafka', kind: 'kafka', label: 'requests', sub: 'group async-workers · auto-commit off', x: 15, y: 50},
      {
        id: 'workers',
        kind: 'service',
        label: 'async-workers',
        sub: 'run(handler) · ack tracker · shutdown()',
        x: 50,
        y: 50,
      },
      {id: 'handlers', kind: 'service', label: 'handlers', sub: '≤ 8 in flight · finish in any order', x: 85, y: 50},
    ],
    edges: [
      {from: 'kafka', to: 'workers', kind: 'kafka', label: 'poll'},
      {from: 'workers', to: 'handlers', kind: 'plain', label: 'handler(value) · ack on completion'},
      {from: 'workers', to: 'kafka', kind: 'kafka', label: 'commit frontier (lowest unfinished offset)'},
    ],
  },
  steps: [asyncAckTrackingStep],
  learn,
};
