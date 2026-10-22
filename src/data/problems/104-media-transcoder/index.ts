import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Media transcoder on the AI-era track: the course is not "call ffmpeg once", it is the review you
 * owe a model-generated segment pipeline before it silently ships a broken video. Idempotent
 * submits keyed by (source hash, preset) → one atomic Redis claim per (job, segment) with a lease
 * → a segment encode over gRPC with a length-scaled deadline, two attempts and a corrupt-input
 * classification → job-keyed events with segment ranges and signed references after the manifest
 * finalizes → a read that computes progress from the manifest and refuses foreign jobs.
 */
export const mediaTranscoderProblem: Problem = {
  id: 'media-transcoder',
  title: 'Media Transcoder',
  tagline: 'Segment-based transcoding that resumes, never double-encodes and reports real progress.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Media Transcoder

A media transcoder is the piece of a video platform that turns one uploaded source file into the
renditions a player can stream. The visible part is a progress bar; the parts that decide whether
the output is correct are the dedupe key, the segment claim, the failure classification and the
manifest. A transcoder that reports "100%" over a file with a hole in it is worse than one that
reports nothing at all.

## The real system

Production transcoders never encode a file in one process. They split the source into fixed-length
segments, hand each segment to a worker, and track completion per \`(job, segment index)\` so a
redelivered message is skipped and a worker that dies mid-segment has its segment retaken after a
lease. They dedupe by content: the same source hash at the same preset must return the existing job
rather than burning the cluster twice. They resolve the encoder command from a preset definition,
never from a caller-supplied argument list, because passing caller arguments into an encoder is a
shell injection surface. They call workers over gRPC with a deadline scaled to the segment's
length, bound the attempts per segment, and separate a corrupt input (terminal — the job fails with
the offending index) from worker loss (retryable — only that segment is retried). They publish
\`transcode.event\` keyed by job id so a job's progress stream stays ordered, carry segment index
ranges and outcomes rather than whole-file polling data, never embed output URLs with permanent
access, and only announce completion after the manifest is final. And they answer reads from the
manifest, not from a guessed duration.

## What you build here

One service, **transcoderd**, with five pieces:

1. \`POST /v1/transcodes\`: a validated source object (uri, 64-hex sha256, duration), a preset id and
   an output target, keyed idempotently by \`(source sha256, preset id)\` so the same pair never
   encodes twice. The preset definitions live server-side; caller-supplied encoder arguments are
   accepted and ignored, and an unknown or malformed preset id is \`404\`.
2. A **Redis** segment tracker: one atomic claim per \`(job, segment index)\` with a lease, so a
   redelivered segment is skipped while a crashed worker's segment is retaken once the lease
   expires, and completion is recorded only after the encode returns. The manifest covers every
   expected index with no gaps.
3. A **gRPC** worker client: a deadline scaled to the segment's length, at most two attempts per
   segment, \`INVALID_ARGUMENT\` (corrupt media) treated as terminal and \`UNAVAILABLE\` (worker
   loss) as retryable for that segment only, and a job failure that names the segment index.
4. A **Kafka** event path: \`transcode.event\` keyed by job id, segment index ranges and outcomes,
   an idempotent producer with \`acks=all\`, the completion event published only after the manifest
   is final, and signed short-lived references instead of permanent output URLs.
5. \`GET /v1/transcodes/{id}\`: progress computed from the manifest — completed segment count,
   failed segment indices, renditions with durations, and \`done\` only when the manifest covers
   every expected segment. A job owned by another tenant is \`404\`.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path on a short file, and it sounds confident. Your job in every step is the job you will have on a
real media pipeline: read the draft against the failure modes, name the subtle one, fix it, and
prove the fix with checks that fail on the draft and pass on your version.

## Left out on purpose

Per-codec rate control tuning, GPU scheduling, DRM packaging, multi-region output replication,
player-side ABR ladders, watermarking and thumbnail extraction. The five pieces above are the ones
that decide whether a transcode is correct, resumable and honest about its progress.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · poll', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Transcoder API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'jobs · manifest', sub: 'state · renditions', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'claims · leases · done', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'transcode.event', sub: 'key = job id', x: 46, y: 88},
      {id: 'worker', kind: 'grpc', label: 'Transcode workers', sub: 'EncodeSegment', x: 70, y: 30},
      {id: 'source', kind: 'external', label: 'Source store', sub: 's3 · segment ranges', x: 70, y: 6},
      {id: 'output', kind: 'external', label: 'Output store', sub: 'renditions · signed', x: 70, y: 56},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'progress · relay', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'jobs · manifest'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'claim · done'},
      {from: 'api', to: 'worker', kind: 'grpc', label: 'EncodeSegment'},
      {from: 'worker', to: 'source', kind: 'plain', label: 'segmented GET'},
      {from: 'worker', to: 'output', kind: 'plain', label: 'segment PUT'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce transcode.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'progress counters'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
