import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Media transcoder: the course is not "call ffmpeg once", it is the debugging you owe a segment
 * pipeline before it ships a video with a hole in it. A submit keyed by (tenant, source sha256,
 * preset) that runs only server-side presets → one atomic Redis claim per (job, segment) with a
 * lease, done recorded after the encode, a manifest from the done set → a segment encode over gRPC
 * with a length-scaled deadline, two attempts and a terminal INVALID_ARGUMENT → job-keyed events and
 * a completion produced after the job is finalized, with signed references → a read that derives
 * state from the manifest and answers 404 for another tenant's job.
 */
export const mediaTranscoderProblem: Problem = {
  id: 'media-transcoder',
  title: 'Media Transcoder',
  tagline: 'Segment claims with a lease, a gapless manifest, a gRPC encoder and signed rendition URLs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Media Transcoder

A media transcoder turns one uploaded source file into the renditions a player streams. The work is
cut into segments so many workers can encode one file at once, and every part of the service exists
to keep one promise: a job that says "done" has every segment behind it.

## The real system

AWS Elemental MediaConvert decides what it will run before it runs it: a job's
\`AccelerationSettings\` carry an \`AccelerationMode\`, and with \`ENABLED\` the service fails a job
whose inputs or settings are not compatible with accelerated transcoding, while \`PREFERRED\` runs
it without acceleration. This course makes the same kind of decision at submit time, then tracks
the work per \`(job, segment index)\` so a redelivered segment is skipped and a crashed worker's
segment is retaken once its lease runs out.

## What you build here

One service, **transcoderd**, on four provided modules: \`transcoder.jobs\` (the job hash
\`job:{id}\`, \`find\`, \`create\`, \`finalize_job\`, \`segment_span\`), \`transcoder.presets\`
(\`encoder_args\`), \`transcoder.segments\` (step 2's tracker as later steps use it, plus
\`mark_failed\`/\`failed\`) and \`transcoder.urls\` (\`sign\`, \`SIGNED_URL_TTL_S\` = 900).

1. \`POST /v1/transcodes\` with \`X-Tenant-Id\` and \`{source: {uri, sha256, duration_s}, preset,
   output: {bucket, prefix}}\`: validated, keyed by \`(tenant, sha256, preset)\`, encoder arguments
   from the preset only, \`404\` for an unknown preset.
2. A **Redis** segment tracker: \`transcode:claim:{job}:{index}\` taken with \`SET NX PX\` for
   \`LEASE_MS\`, the done set \`transcode:done:{job}\` written after the encode returns, and a
   manifest computed from that set.
3. A **gRPC** client for \`Encoder.EncodeSegment\` (\`media_transcoder.proto\`): the segment's own
   span, a deadline scaled to its length, two attempts, \`INVALID_ARGUMENT\` terminal, and a
   \`SegmentFailed\` naming the index.
4. A **Kafka** \`transcode.event\` stream keyed by job id: segment ranges, and a completion
   produced only for a gapless manifest, after \`finalize_job\`, with signed references, by an
   idempotent producer with \`acks=all\`.
5. \`GET /v1/transcodes/{id}\`: state, completed and failed segments from the manifest, renditions
   signed at read time, \`404\` for another tenant's job.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path on a
short file, and it looks right. In every step, debug it against the failure modes the task names,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Per-codec rate control, GPU scheduling, DRM packaging, multi-region output replication and
thumbnail extraction.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · poll', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'transcoderd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'job store', sub: 'job:{id} · by-source index', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'claims · done · failed', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'transcode.event', sub: 'key = job id', x: 46, y: 88},
      {id: 'worker', kind: 'grpc', label: 'Encoder workers', sub: 'EncodeSegment', x: 70, y: 30},
      {id: 'source', kind: 'external', label: 'Source store', sub: 'segment spans', x: 70, y: 6},
      {id: 'output', kind: 'external', label: 'Output store', sub: 'renditions · signed URLs', x: 70, y: 56},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'progress · notify', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'find · create · finalize_job'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'claim · done · manifest'},
      {from: 'api', to: 'worker', kind: 'grpc', label: 'EncodeSegment'},
      {from: 'worker', to: 'source', kind: 'plain', label: 'ranged GET'},
      {from: 'worker', to: 'output', kind: 'plain', label: 'segment PUT'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce transcode.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'client', to: 'output', kind: 'http', label: 'signed GET'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
