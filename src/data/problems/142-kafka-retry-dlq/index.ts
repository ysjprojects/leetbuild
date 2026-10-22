import type {Problem} from '@/lib/types';

import {retryDlqStep} from './steps/1-retry-dlq';

/**
 * One Kafka mechanism, tested deeply: a consumer that hands failed records to a retry topic and,
 * after MAX_ATTEMPTS, to a dead-letter topic — same key, attempt and error in headers — and commits
 * the source offset only once the hand-off is acknowledged.
 */
export const kafkaRetryDlqProblem: Problem = {
  id: 'kafka-retry-dlq',
  title: 'A retry topic and a dead letter',
  tagline:
    'A consumer that re-produces failed records to orders.retry with an attempt header, dead-letters them after three tries, and commits the source only once the hand-off is acknowledged.',
  difficulty: 'medium',
  concepts: ['kafka'],
  minutes: 25,
  statement: `# A retry topic and a dead letter

A Kafka partition is a queue with one head: a record the handler cannot process blocks every record
behind it, and a handler that retries in place turns one bad order into a stalled fulfilment line.
The standard answer is to move the failure sideways: re-produce the record to a **retry topic** with a
count of how many times it has failed, consume that topic with the same loop, and after a bounded
number of attempts re-produce it to a **dead-letter topic** where a human or a replay tool finds it.
The source offset is committed as soon as the record has been handed on — but not before the hand-off
is acknowledged, or a slow broker turns the commit into data loss.

Every order pipeline, payment processor and notification service with a Kafka consumer has this
pattern somewhere; frameworks (Spring Kafka's \`DeadLetterPublishingRecoverer\`, Kafka Connect's
\`errors.deadletterqueue\`) package exactly these moves.

You implement \`run(handler)\`: a member of group \`fulfilment\` over \`orders\` and \`orders.retry\`,
auto-commit off, that calls \`handler(event)\` per record and on failure hands the record — same key,
same value, headers \`attempt\` and \`error\` — to \`orders.retry\` while \`attempt + 1 < MAX_ATTEMPTS\`
(3), else to \`orders.dlq\`; malformed JSON is dead-lettered on sight; the commit waits for the
hand-off's acknowledgement.

## What you build here

1. **\`run(handler)\`** in \`retry_dlq\`: the two-topic consumer loop with the keyed hand-off, the
   attempt/error headers, the dead-letter cut-off, and an acknowledged produce before every commit.

## Left out on purpose

Delays between attempts (tiered retry topics or pausing a partition until a record is due), the
dead-letter consumer that alerts and replays, rebalance handling, and batching commits. The one
mechanism here is the hand-off and where its commit sits.`,
  diagram: {
    nodes: [
      {id: 'fulfilment', kind: 'service', label: 'fulfilment', sub: 'run(handler) · group fulfilment', x: 25, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'Kafka', sub: 'orders · orders.retry · orders.dlq', x: 70, y: 50},
    ],
    edges: [
      {from: 'kafka', to: 'fulfilment', kind: 'kafka', label: 'consume orders · orders.retry'},
      {from: 'fulfilment', to: 'kafka', kind: 'kafka', label: 'hand-off (attempt, error) · commit'},
    ],
  },
  steps: [retryDlqStep],
};
