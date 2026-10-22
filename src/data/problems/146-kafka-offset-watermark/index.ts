import type {Problem} from '@/lib/types';

import {offsetWatermarkStep} from './steps/1-offset-watermark';

/**
 * One Kafka mechanism, drilled on its own: a consumer that remembers the last offset it applied per
 * partition next to its results, so a record redelivered after a crash between the apply and the
 * commit is recognised and skipped instead of applied twice.
 */
export const kafkaOffsetWatermarkProblem: Problem = {
  id: 'kafka-offset-watermark',
  title: 'An idempotent consumer: a watermark per partition',
  tagline:
    'Process-then-commit replays records after a crash; a per-partition watermark stored with the results turns the replay into a no-op.',
  difficulty: 'medium',
  concepts: ['kafka'],
  minutes: 25,
  statement: `# An idempotent consumer: a watermark per partition

A consumer that commits after its side effect is at-least-once: a crash between the two makes
the broker redeliver the record, and the side effect happens twice. For a view counter that is a
rounding error; for an account balance it is money. The standard fix does not touch the commit —
it makes the apply idempotent by storing, **next to the results**, the highest offset applied for
each partition: a **watermark**. A record at or below the watermark has already been applied and
is skipped; one above it is applied and moves the watermark. Offsets are per partition and
strictly increasing, so one integer per partition is a complete record of what has been done.

Kafka Streams keeps exactly this in its state stores, Flink in its checkpoints, and every
hand-written consumer that writes to a database keeps it in a \`consumer_offsets\` table updated
in the same transaction as the data. The watermark is the consumer's own commit — the broker's
committed offset only decides where to resume.

## What you build here

1. A consumer of \`transfers\` in group \`balances\` with auto-commit off that keeps an in-memory
   store — \`applied\` balances per account and a \`watermark\` per partition — applies a record
   only when its offset is above the partition's watermark, moves the watermark, then commits;
   \`restart()\` replaces the consumer (the store survives) and resumes from the committed offsets.

## Left out on purpose

Durable state (the store would be a database row written in the same transaction as the
watermark), rebalances, transactions, and exactly-once producers: the drill is the comparison
\`offset > watermark[partition]\` and where it sits relative to the apply and the commit.`,
  diagram: {
    nodes: [
      {id: 'kafka', kind: 'kafka', label: 'transfers', sub: 'key = account · 3 partitions', x: 25, y: 50},
      {
        id: 'consumer',
        kind: 'service',
        label: 'balances consumer',
        sub: 'applied · watermark[partition]',
        x: 70,
        y: 50,
      },
    ],
    edges: [
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'poll (partition, offset)'},
      {from: 'consumer', to: 'kafka', kind: 'kafka', label: 'commit offset + 1'},
    ],
  },
  steps: [offsetWatermarkStep],
};
