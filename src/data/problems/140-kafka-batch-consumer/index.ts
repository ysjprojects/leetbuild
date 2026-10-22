import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {batchConsumerStep} from './steps/1-batch-consumer';

/**
 * One Kafka mechanism, drilled on its own: a consumer that turns a stream of records into
 * batches closed by whichever comes first — a count or a clock — hands each batch to one write,
 * and commits once per batch the highest offset + 1 of every partition the batch touched.
 */
export const kafkaBatchConsumerProblem: Problem = {
  id: 'kafka-batch-consumer',
  title: 'Batch by count or by time',
  tagline:
    'A consumer that closes a batch at 50 records or 500 ms, whichever comes first, flushes it once and commits once — one offset per partition the batch touched.',
  difficulty: 'easy',
  concepts: ['kafka'],
  minutes: 15,
  statement: `# Batch by count or by time

A consumer that writes one row per record pays the sink's round trip for every record; one that
waits for a thousand records writes nothing on a quiet afternoon. The standard shape is two knobs
and one rule: collect records into a batch, and close the batch on whichever comes first — it holds
**\`BATCH_SIZE\`** records, or **\`BATCH_WAIT_MS\`** have passed since collecting started. A closed batch
goes to the sink in **one** call, and the consumer **commits once**, the highest offset + 1 of every
partition the batch touched. Throughput is bounded below by the count; latency is bounded above by
the clock.

Every sink connector does exactly this: Kafka Connect's \`consumer.max.poll.records\` with a flush
interval, the Elasticsearch and ClickHouse sinks' bulk inserts, the S3 sink's part size and
rotation time; so does every hand-written warehouse loader. The function surface here is
\`run(flush)\`: a loop in consumer group \`rollup\` over topic \`metrics\`, auto-commit off, that calls
\`flush(records)\` once per batch with the records exactly as the client delivered them, then commits.

## What you build here

1. \`run(flush)\` with \`BATCH_SIZE = 50\` and \`BATCH_WAIT_MS = 500\`: records collected until the count
   or the clock closes the batch, \`flush\` called once per batch and never with an empty one, and one
   synchronous commit per batch of the batch's last offset + 1 per partition.

## Left out on purpose

Retrying or dead-lettering a failed flush, committing what you hold when a partition is revoked,
pausing partitions when the sink falls behind, and \`max.poll.interval.ms\` against a slow flush: the
drill is the two-condition close and the one commit that is the batch's receipt.`,
  diagram: {
    nodes: [
      {id: 'kafka', kind: 'kafka', label: 'metrics', sub: '3 partitions · group rollup', x: 15, y: 50},
      {
        id: 'consumer',
        kind: 'service',
        label: 'batch consumer',
        sub: 'BATCH_SIZE 50 · BATCH_WAIT_MS 500',
        x: 50,
        y: 50,
      },
      {id: 'sink', kind: 'db', label: 'rollup store', sub: 'flush(records): one write per batch', x: 85, y: 50},
    ],
    edges: [
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'poll'},
      {from: 'consumer', to: 'sink', kind: 'plain', label: 'flush(batch)'},
      {from: 'consumer', to: 'kafka', kind: 'kafka', label: 'commit last offset + 1 per partition'},
    ],
  },
  steps: [batchConsumerStep],
  learn,
};
