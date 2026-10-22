import type {Problem} from '@/lib/types';

import {changelogRestoreStep} from './steps/1-changelog-restore';

/**
 * One Kafka mechanism, drilled: a key-value view that rebuilds itself from a changelog topic before
 * serving a read — end offsets captured first, every partition replayed to its captured end, then
 * live — the way a stream processor restores a state store.
 */
export const kafkaChangelogRestoreProblem: Problem = {
  id: 'kafka-changelog-restore',
  title: 'Restore state from a changelog, then go live',
  tagline:
    'Rebuild a key-value view from kv-changelog: capture every partition’s end offset, replay to it, refuse reads until then, then apply live records.',
  difficulty: 'hard',
  concepts: ['kafka'],
  minutes: 35,
  statement: `# Restore state from a changelog, then go live

A **changelog topic** is a key-value store written down as records: every \`SET\` is a record keyed
by the key, every \`DELETE\` is a record with that key and a \`null\` value — a **tombstone**. A process
that reads the topic from the beginning, applying each record over the last one, ends up holding the
whole store in memory; log compaction keeps the topic to roughly one record per key, so the replay
stays bounded. This is how Kafka Streams and ksqlDB rebuild a state store on a new instance, how
Debezium consumers materialise a table, and how a service keeps a local copy of a config topic.

The part that is easy to get wrong is **knowing when the replay is done**. A view that answers a
read while it is still half-way through the changelog returns a stale value — or no value — for a key
that exists; a view that never decides it is done never answers at all. The restore protocol is: ask
the broker for the **end offset** of every partition *before* reading anything, replay each partition
until it reaches *its* captured end, and only then become \`ready\`. Records that arrive after the
ends were captured are not part of the restore — they are live traffic, applied the same way but
counted separately.

Here you build that view as a module: \`start(on_restored)\` restores \`kv-changelog\` and keeps
consuming, \`get(key)\` refuses to answer until the restore is complete, \`stats()\` reports
\`ready\`, \`restored\` and \`applied_live\`. The consumer assigns the partitions itself — no consumer
group and never a commit, because the next restart restores from the beginning again.

## What you build here

1. The **changelog restore**: end offsets captured per partition, all partitions assigned and replayed
   from the beginning with last-write-wins and tombstones, readiness only once every partition has
   reached its captured end, live records applied afterwards, and no committed offsets.

## Left out on purpose

Log compaction itself, a standby replica that keeps the restore short, persisting the view to disk
between restarts, and the key-range transfer that happens when partitions are reassigned in a group.
The protocol above is the piece that decides whether a restarted instance serves correct answers or
confident wrong ones.`,
  diagram: {
    nodes: [
      {id: 'view', kind: 'service', label: 'kv view', sub: 'start · get · stats', x: 25, y: 50},
      {
        id: 'kafka',
        kind: 'kafka',
        label: 'kv-changelog',
        sub: '3 partitions · key = kv key · null = tombstone',
        x: 70,
        y: 50,
      },
    ],
    edges: [{from: 'view', to: 'kafka', kind: 'kafka', label: 'end offsets · assign · replay · live'}],
  },
  steps: [changelogRestoreStep],
};
