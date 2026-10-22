import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {pauseAtHighWaterStep} from './steps/1-pause-at-high-water';

/**
 * One Kafka mechanism: a consumer whose fetch side outruns its work side bounds the records it
 * holds in memory by pausing every assigned partition at a high-water mark and resuming at a
 * low-water mark — staying in the group, committing only what the worker has finished.
 */
export const kafkaBackpressurePauseProblem: Problem = {
  id: 'kafka-backpressure-pause',
  title: 'Pause the partitions when the buffer is full',
  tagline:
    'A consumer that fetches faster than it works: bound the in-memory queue with pause at HIGH and resume at LOW, without leaving the group or committing ahead of the work.',
  difficulty: 'medium',
  concepts: ['kafka'],
  minutes: 25,
  statement: `# Pause the partitions when the buffer is full

A Kafka consumer fetches in bulk and processes one record at a time. When the work per record is
slow — a model call, a PDF render, a third-party API — the fetch side runs ahead of the work side,
and anything in between fills up: an unbounded queue grows until the process is killed for memory.
The consumer cannot simply stop calling \`poll\` either: the client's heartbeats and rebalance
callbacks ride on it, and past \`max.poll.interval.ms\` the broker evicts a silent member and hands
its partitions to someone else, which replays everything it had in flight.

The fix every serious consumer carries is **pause/resume with hysteresis**: fetch into a bounded
queue; when it reaches a **high-water mark**, pause every assigned partition — the client keeps
polling, heartbeating and serving callbacks, but gets no records; when the drain side brings the
queue down to a **low-water mark**, resume. Two marks, not one, so the consumer does not flap on
every record. This is how Kafka Streams, Flink's Kafka source and every job runner built on a
consumer group keep their memory flat while the topic runs ahead.

You build a module \`backpressure\`: \`run(worker)\` consumes \`jobs\` in group \`workers\` with
auto-commit off through a queue bounded at **\`HIGH = 20\`** / **\`LOW = 5\`**, a drain loop that
awaits \`worker(job)\` and then commits that record, \`stats()\` reporting \`{queued, paused,
processed}\`, and \`stop()\`.

## What you build here

1. The **poll loop and drain loop over a bounded queue**: pause the assignment at HIGH, resume at
   LOW, keep polling while paused, commit each record after its worker returns, keep every partition
   in offset order.

## Left out on purpose

Byte-based bounds, per-partition pausing when one key runs hot, retries and dead-lettering of a
failing job, rebalance handling (committing what is done when a partition is revoked), and a
multi-threaded worker pool. The drill is the hysteresis loop itself and what it commits.`,
  diagram: {
    nodes: [
      {id: 'producers', kind: 'client', label: 'producers', sub: 'jobs, keyed by tenant', x: 10, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'jobs', sub: '3 partitions · group workers', x: 45, y: 50},
      {id: 'worker', kind: 'service', label: 'worker', sub: 'queue ≤ HIGH · pause / resume', x: 80, y: 50},
    ],
    edges: [
      {from: 'producers', to: 'kafka', kind: 'kafka', label: 'produce'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'poll · pause · resume · commit'},
    ],
  },
  steps: [pauseAtHighWaterStep],
  learn,
};
