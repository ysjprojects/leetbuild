import type {Problem} from '@/lib/types';

import {tumblingWindowStep} from './steps/1-tumbling-window';

/**
 * One Kafka mechanism, drilled alone: tumbling-window counts over an out-of-order event-time stream,
 * closed by a watermark, published once, committed only after the publish is acknowledged.
 */
export const kafkaTumblingWindowProblem: Problem = {
  id: 'kafka-tumbling-window',
  title: 'Tumbling-window counts with a watermark',
  tagline:
    'Count clicks per page per minute of event time, close a window only when the watermark says nothing older is coming, and commit after the counts are on the topic.',
  difficulty: 'medium',
  concepts: ['kafka'],
  minutes: 25,
  statement: `# Tumbling-window counts with a watermark

A click stream carries its own time: each event says *when* it happened, and events reach the topic
out of order — a mobile client flushes a batch late, two partitions interleave. "Clicks per page per
minute" cannot be answered by the wall clock; it is answered by cutting event time into fixed,
non-overlapping windows of 60 s and deciding, per window, the moment it is safe to publish its count
once. That moment is the **watermark**: the newest event time seen, held back by the lateness you
tolerate. When the watermark passes a window's end, the window closes.

This is the core of every stream aggregator — Kafka Streams' windowed \`count()\`, Flink's event-time
windows, the per-minute dashboards behind ad serving and product analytics. The hard part is never the
counting; it is the three decisions the watermark drives: which events are too late to count, when a
window is final, and in what order the output and the offset commit happen so a crash replays a
window instead of losing it.

The surface is one module: \`run()\` consumes \`clicks\` in group \`windows\` with auto-commit off and
emits closed windows to \`page-counts\`; \`stats()\` reports late events and open windows;
\`shutdown()\` stops cleanly without emitting anything.

## What you build here

1. The aggregator: tumbling windows of \`WINDOW_MS = 60000\` keyed by \`(page, window_start)\`, a watermark
   of \`max_ts - 5000\`, late events dropped and counted, closed windows emitted as one keyed record per
   page, and the input offsets committed only after the emit is acknowledged.

## Left out on purpose

Checkpointing the open windows (a restart recounts from the committed offset), per-partition
watermarks and their merge, updating an already-emitted window instead of dropping a late event,
and a transactional emit-and-commit. The one thing drilled is the watermark and what hangs off it.`,
  diagram: {
    nodes: [
      {id: 'clicks', kind: 'kafka', label: 'clicks', sub: '{page, ts} · event time', x: 10, y: 50},
      {
        id: 'aggregator',
        kind: 'service',
        label: 'windows',
        sub: 'tumbling 60 s · watermark = max ts − 5 s',
        x: 50,
        y: 50,
      },
      {id: 'counts', kind: 'kafka', label: 'page-counts', sub: 'key = page', x: 90, y: 50},
    ],
    edges: [
      {from: 'clicks', to: 'aggregator', kind: 'kafka', label: 'consume · commit after emit'},
      {from: 'aggregator', to: 'counts', kind: 'kafka', label: 'closed windows'},
    ],
  },
  steps: [tumblingWindowStep],
};
