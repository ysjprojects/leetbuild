import type {Problem} from '@/lib/types';

import {consumeTransformProduceStep} from './steps/1-consume-transform-produce';

/**
 * One Kafka mechanism, drilled alone: a consume → transform → produce loop that commits a batch
 * of source offsets only after every produced record is acknowledged, with an idempotent producer
 * and source headers so the output is at-least-once and deduplicable — exactly-once in effect.
 */
export const kafkaConsumeTransformProduceProblem: Problem = {
  id: 'kafka-consume-transform-produce',
  title: 'Consume, transform, produce — exactly once in effect',
  tagline:
    'A raw → clean pipeline stage: batch, flush, then commit — an idempotent producer, source headers on every record, and a crash that replays instead of losing.',
  difficulty: 'hard',
  concepts: ['kafka'],
  minutes: 35,
  statement: `# Consume, transform, produce — exactly once in effect

A stream processor's simplest shape: read \`raw\`, apply a function, write \`clean\`. The data is only as
good as what happens around the function. Commit the source offset before the output is acknowledged and
a crash loses records; commit after, and a crash replays them; let a producer retry on its own and a
lost acknowledgement writes a record twice. Every CDC relay, enrichment stage and log sanitiser is
this loop with a different function in the middle.

Kafka's transactions solve the whole problem at a price most pipelines do not pay. The everyday answer
is the one this drill builds: **produce, flush, then commit**, with an **idempotent producer** so the
broker swallows the producer's own retries, and **source headers** (\`src_partition\`, \`src_offset\`) on
every output record so a downstream consumer can drop the duplicates a crash-and-replay creates.
At-least-once on the wire, exactly-once in effect.

## What you build here

1. \`run(transform)\`: a member of group **\`cleaner\`** reading \`raw\` with auto-commit off, producing
   \`transform(value)\` to \`clean\` under the same key with \`src_partition\` and \`src_offset\` headers,
   through an idempotent \`acks=all\` producer; batches of up to **\`BATCH = 20\`** records are flushed —
   every acknowledgement awaited, at most **\`FLUSH_TIMEOUT_MS = 2000\`** — and only then committed. A
   batch that does not get every ack fails \`run\` without a commit; \`restart()\` brings a fresh consumer
   back at the committed offsets, and the batch is re-read.

## Left out on purpose

Transactions (\`sendOffsetsToTransaction\`), rebalance handling, the downstream deduplicating consumer,
schemas, metrics and a dead-letter topic for records the function rejects. The loop above is the part
that decides whether the stage loses, duplicates, or neither.`,
  diagram: {
    nodes: [
      {id: 'raw', kind: 'kafka', label: 'raw', sub: '3 partitions · keyed', x: 10, y: 50},
      {
        id: 'cleaner',
        kind: 'service',
        label: 'cleaner',
        sub: 'group cleaner · batch 20 · flush then commit',
        x: 50,
        y: 50,
      },
      {id: 'clean', kind: 'kafka', label: 'clean', sub: 'key = source key · src_partition · src_offset', x: 90, y: 50},
    ],
    edges: [
      {from: 'raw', to: 'cleaner', kind: 'kafka', label: 'poll · commit after flush'},
      {from: 'cleaner', to: 'clean', kind: 'kafka', label: 'produce (idempotent, acks=all)'},
    ],
  },
  steps: [consumeTransformProduceStep],
};
