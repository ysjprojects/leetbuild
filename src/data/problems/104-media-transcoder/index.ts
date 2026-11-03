import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Media transcoder: the course is not "call ffmpeg once", it is the debugging you owe a segment
 * pipeline before it silently ships a broken video. Idempotent submits keyed by (source hash,
 * preset) → one atomic Redis claim per (job, segment) with a lease → a segment encode over gRPC with
 * a length-scaled deadline, two attempts and a corrupt-input classification → job-keyed events with
 * segment ranges and signed references after the manifest finalizes → a read that computes progress
 * from the manifest and refuses foreign jobs.
 */
export const mediaTranscoderProblem: Problem = {
  id: 'media-transcoder',
  title: 'Media Transcoder',
  tagline: 'Segment-based transcoding with content-keyed dedupe, leased claims and a gapless manifest.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Media Transcoder

A media transcoder turns one uploaded source file into the renditions a player can stream. A
transcoder that reports "100%" over a file with a hole in it is worse than one that reports nothing.

## The real system

AWS Elemental MediaConvert exposes this split directly: a job's \`AccelerationSettings\` carries an
\`AccelerationMode\`, and with \`ENABLED\` the service fails a job whose input or settings cannot be
split for parallel encoding, while \`PREFERRED\` falls back to a single-process encode. That is the
same decision this course makes at submit time: reject what the pipeline cannot do before a worker
has spent a minute on it. Production transcoders split the source into fixed-length segments and
track completion per \`(job, segment index)\`, so a redelivered message is skipped and a crashed
worker's segment is retaken after a lease.

## What you build here

One service, **transcoderd**, with five pieces:

1. \`POST /v1/transcodes\`: a validated source (uri, 64-hex sha256, duration), a preset id and an
   output target, keyed idempotently by \`(source sha256, preset id)\`. Preset definitions live
   server-side; caller encoder arguments are accepted and ignored; an unknown preset is \`404\`.
2. A **Redis** segment tracker: one atomic claim per \`(job, segment index)\` with a lease, a
   redelivery skip, completion recorded only after the encode returns, and a manifest that covers
   every expected index.
3. A **gRPC** worker client: a deadline scaled to segment length, at most two attempts per segment,
   \`INVALID_ARGUMENT\` terminal and \`UNAVAILABLE\` retryable for that segment only, and a failure
   that names the segment index.
4. A **Kafka** event path: \`transcode.event\` keyed by job id, segment ranges and outcomes, an
   idempotent producer with \`acks=all\`, completion published after the manifest is final, and
   signed short-lived references instead of permanent output URLs.
5. \`GET /v1/transcodes/{id}\`: progress from the manifest (completed count, failed indices,
   renditions with durations), \`done\` only when nothing is missing, \`404\` for another tenant's job.

## The debugging habit

Every starter serves the happy path on a short file. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Per-codec rate control, GPU scheduling, DRM packaging, multi-region output replication, and
thumbnail extraction.`,
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
