import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {tieredRetryStep} from './steps/1-tiered-retry';

/**
 * One Kafka mechanism, tested deeply: delayed retries without blocking — a failed record climbs
 * tasks.retry.5s → 30s → 5m → dlq with a not_before header, and a consumer that meets a record
 * before its time pauses that partition (and seeks back to it) instead of sleeping or skipping.
 */
export const kafkaTieredRetryDelaysProblem: Problem = {
  id: 'kafka-tiered-retry-delays',
  title: 'Tiered retry topics with non-blocking delays',
  tagline:
    'A worker that escalates failures through tasks.retry.5s → 30s → 5m → dlq with a not_before header, and pauses a retry partition until its record is due instead of sleeping on it.',
  difficulty: 'hard',
  concepts: ['kafka'],
  minutes: 40,
  statement: `# Tiered retry topics with non-blocking delays

A retry topic takes a failed record off the partition's head, but it does not wait: the same loop
picks the record up milliseconds later and fails it again against the same dead dependency. Real
systems want *backoff* — 5 seconds, then 30, then 5 minutes — and Kafka has no delayed delivery.
The standard answer is **one retry topic per delay**, each record stamped with the earliest time it
may be processed, and a consumer that, on meeting a record whose time has not come, **pauses that
partition** and comes back to it when it is due. Pausing is the whole trick: a \`sleep\` would stall
every record behind it, including the main topic's; skipping it would lose it.

Uber's consumer framework, Spring Kafka's \`RetryTopicConfiguration\` and most home-grown
notification and webhook pipelines are built exactly like this: tiered topics, a \`not_before\`
header, \`pause\`/\`resume\` driven by a clock.

You implement \`run(handler)\`: one member of group \`tasks-workers\` over \`tasks\` and the three retry
topics, auto-commit off. A failure hands the record to the next tier with \`attempt\` and
\`not_before = now + tier\` headers — to \`tasks.dlq\` after the last tier — flushed before the source
offset is committed. A retry record that is not yet due is neither handled nor skipped: its partition
is paused, the position is moved back to it, and it is resumed once the clock reaches \`not_before\`.

## What you build here

1. **\`run(handler)\`** in \`tiered_retry\`: the four-topic loop, the tiered hand-off with
   \`attempt\`/\`not_before\`/\`error\` headers, the acknowledged produce before every commit, and the
   pause → remember → resume + seek dance that delays a record without blocking anyone.

## Left out on purpose

Rebalance handling (a paused partition that is revoked and reassigned), a dead-letter replayer,
per-record backoff instead of fixed tiers, and batching commits. The one mechanism here is a delay
that costs the partition nothing.`,
  diagram: {
    nodes: [
      {id: 'kafka', kind: 'kafka', label: 'tasks', sub: 'group tasks-workers', x: 15, y: 50},
      {id: 'worker', kind: 'service', label: 'worker', sub: 'run(handler) · pause until not_before', x: 50, y: 50},
      {id: 'retry', kind: 'kafka', label: 'retry tiers', sub: 'tasks.retry.5s · 30s · 5m · tasks.dlq', x: 85, y: 50},
    ],
    edges: [
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume · commit'},
      {from: 'worker', to: 'retry', kind: 'kafka', label: 'hand-off (attempt, not_before) · flush'},
      {from: 'retry', to: 'worker', kind: 'kafka', label: 'consume when due · pause/resume/seek'},
    ],
  },
  steps: [tieredRetryStep],
  learn,
};
