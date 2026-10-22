import type {Problem} from '@/lib/types';

import {replayToSnapshotStep} from './steps/1-replay-to-snapshot';

/**
 * Kafka drill: a stand-alone replay tool that rewinds a topic to an offset and reads up to a
 * snapshot of each partition's end taken before it started — without committing anything, so the
 * live consumer group never notices.
 */
export const kafkaReplayFromOffsetProblem: Problem = {
  id: 'kafka-replay-from-offset',
  title: 'Rewind and replay to a snapshot of the end',
  tagline:
    'A replay tool: seek every partition to an offset, read to the end offsets captured before the replay started, commit nothing.',
  difficulty: 'medium',
  concepts: ['kafka'],
  minutes: 25,
  statement: `# Rewind and replay to a snapshot of the end

A topic is a log, and a log can be read again: to rebuild a projection after a bug, to backfill a
new index, to replay yesterday's orders into a staging system. The tool that does it is a consumer
that does **not** belong to the live group: it assigns the partitions itself, seeks them to the offset
it wants, and never commits — because a commit would move the live group's bookmarks.

The hard part is knowing where to stop. A topic keeps growing while the replay runs; "read until the
end" is a moving target, and chasing it turns a bounded backfill into a second live consumer. The tool
therefore captures each partition's **end offset before it starts** and reads exactly up to that
snapshot: every record appended during the replay belongs to the next one.

## What you build here

1. \`replay(topic, from_offset, handler)\`: capture the end offsets, assign every partition of the topic
   at \`from_offset\`, call \`handler\` for each record up to the snapshot, return how many were handled —
   with group id \`replay-tool\`, auto-commit off and not one commit.

## Left out on purpose

Discovering the partition count (every topic here has three), offsets by timestamp
(\`offsets_for_times\`), compacted topics, and transactional reads. A replay is the mechanism this drill
tests: rewind, bounded end, no side effect on the group.`,
  diagram: {
    nodes: [
      {id: 'tool', kind: 'service', label: 'replay tool', sub: 'group replay-tool · never commits', x: 20, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'order-events', sub: '3 partitions · group orders', x: 70, y: 50},
    ],
    edges: [{from: 'tool', to: 'kafka', kind: 'kafka', label: 'watermarks · assign · seek · poll'}],
  },
  steps: [replayToSnapshotStep],
};
