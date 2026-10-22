import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {orderedMergeStep} from './steps/1-ordered-merge';

/**
 * One Kafka mechanism, drilled on its own: merging the partitions of a topic into one stream in
 * event-time order with per-partition watermarks — buffering, a lateness bound, idle-partition
 * release, late-record dropping, and commits that never run ahead of what was emitted.
 */
export const kafkaOrderedMergeWatermarkProblem: Problem = {
  id: 'kafka-ordered-merge-watermark',
  title: 'Merge partitions in timestamp order with watermarks',
  tagline:
    'Six partitions, one time-ordered stream: per-partition buffers, a watermark with a lateness bound, idle release, late drops, and commits that never outrun the emitted frontier.',
  difficulty: 'hard',
  concepts: ['kafka'],
  minutes: 40,
  statement: `# Merge partitions in timestamp order with watermarks

Kafka orders records **within** a partition and nowhere else. A topic with six partitions is six
independent logs, each roughly in event-time order; a consumer polling them sees readings from
partition 3 at 12:00:04, then partition 0 at 12:00:01, then partition 5 at 12:00:09. Anything
downstream that needs one sequence in time order — a session detector, a window aggregate, a
replay into a time-series store — has to **merge** the partitions back together, and the only safe
way to do that is the one stream processors use: buffer per partition, and release a reading only
once every partition has moved past it. That bound is the **watermark**: the smallest of the
partitions' newest timestamps, minus a lateness allowance.

Two things make the simple version wrong in production. A partition that goes quiet — the sensor
behind it is off — would hold the watermark at its last reading forever, so an **idle** partition
must stop counting after a while. And a reading that arrives after the stream has already passed
its timestamp cannot be slotted in without breaking order, so it is **dropped and counted** rather
than emitted late. Offsets follow the output, not the input: a crash must replay what was buffered,
never skip it.

## What you build here

1. One module, \`merger\`: \`run(emit)\` that consumes \`sensor-readings\` (6 partitions) in group
   \`merger\` and calls \`emit\` in global timestamp order through per-partition buffers, a watermark
   with \`LATENESS_MS\` = 2000 and \`IDLE_MS\` = 10 000, drops below the emitted frontier, commits only
   behind the output, and \`stats()\` reporting emitted, dropped and buffered counts.

## Left out on purpose

Rebalances and multiple consumer instances, checkpointing the buffers, bounded buffer memory, a
side output for dropped readings, and producer-side timestamps (\`ts\` comes from the payload).`,
  diagram: {
    nodes: [
      {id: 'sensors', kind: 'client', label: 'sensors', sub: '{"sensor", "ts"} · keyed by sensor', x: 10, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'sensor-readings', sub: '6 partitions · group merger', x: 45, y: 50},
      {id: 'merger', kind: 'service', label: 'merger', sub: 'buffers · watermark · emit in ts order', x: 82, y: 50},
    ],
    edges: [
      {from: 'sensors', to: 'kafka', kind: 'kafka', label: 'produce'},
      {from: 'kafka', to: 'merger', kind: 'kafka', label: 'poll · commit behind the frontier'},
    ],
  },
  steps: [orderedMergeStep],
  learn,
};
