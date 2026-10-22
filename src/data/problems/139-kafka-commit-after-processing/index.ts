import type {Problem} from '@/lib/types';

import {commitAfterProcessingStep} from './steps/1-commit-after-processing';

/**
 * One Kafka consumer loop, drilled on the single decision that sets its delivery guarantee: the
 * offset is committed after the record is processed, per record, by hand — never on a timer.
 */
export const kafkaCommitAfterProcessingProblem: Problem = {
  id: 'kafka-commit-after-processing',
  title: 'Consume, process, then commit',
  tagline:
    'A consumer loop with auto-commit off: process the record, then commit its offset — poison records skipped, a failing handler replayed.',
  difficulty: 'easy',
  concepts: ['kafka'],
  minutes: 12,
  statement: `# Consume, process, then commit

A consumer group remembers where each partition was left off as a **committed offset**: the next
offset to read when a member restarts or the partition moves. Where that commit sits relative to the
work decides what a crash does. Commit first and the crash *loses* the record (at-most-once); process
first and the crash *replays* it (at-least-once). With \`enable.auto.commit\` left on — the default —
the client commits on a timer whatever it last fetched, processed or not, so the choice is made for
you, the wrong way, silently.

Every consumer that writes somewhere is this loop: a ledger writer, a search indexer, a counter, a
notifier. The record is the unit of work; the commit is a statement that the work is done. Two
things complicate the loop and both are about *which* records get committed: a record that cannot be
parsed must be committed anyway or it blocks the partition forever, and a record whose handler fails
must **not** be committed so that it comes back.

## What you build here

1. \`run(handler)\`: a member of group \`ledger-writer\` reading \`payments\` from the beginning with
   auto-commit off. For every record: parse the JSON value, call \`handler(event)\`, then commit that
   record's offset synchronously. A malformed record is logged, skipped and committed; a handler that
   raises stops the loop with its record uncommitted.

## Left out on purpose

Rebalances and \`on_revoke\`, batching commits for throughput, a dead-letter topic for the poison
records, retries with backoff, and transactions. The loop here is the one every one of those is
bolted onto.`,
  diagram: {
    nodes: [
      {id: 'kafka', kind: 'kafka', label: 'payments', sub: 'group ledger-writer · 3 partitions', x: 25, y: 50},
      {id: 'ledger', kind: 'service', label: 'ledger-writer', sub: 'run(handler) · commit per record', x: 70, y: 50},
    ],
    edges: [
      {from: 'kafka', to: 'ledger', kind: 'kafka', label: 'poll → record'},
      {from: 'ledger', to: 'kafka', kind: 'kafka', label: 'commit offset + 1'},
    ],
  },
  steps: [commitAfterProcessingStep],
};
