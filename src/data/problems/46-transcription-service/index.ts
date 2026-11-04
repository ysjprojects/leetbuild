import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {transcriptionEndpointStep} from './steps/1-endpoint';
import {transcriptionStateStep} from './steps/2-state';
import {transcriptionDependencyStep} from './steps/3-dependency';
import {transcriptionEventsStep} from './steps/4-events';
import {transcriptionReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Transcription service: the course is not "send audio to an ASR model", it is the debugging you
 * owe a long-audio pipeline before it bills a tenant three times for one bad minute. Job creation
 * validated from metadata and keyed by the audio hash → a per-job Redis chunk ledger claimed in one
 * Lua script → a deadline-bounded gRPC chunk stream that resumes from its own offset → segment
 * events keyed by job and redacted before publish → a read that says done only when it is.
 */
export const transcriptionServiceProblem: Problem = {
  id: 'transcription-service',
  title: 'Transcription Service',
  tagline: 'A chunk ledger, resumable ASR streams and redacted segment events for hours of audio.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Transcription Service

A transcription service turns hours of audio into text: it accepts a reference to an audio object,
cuts it into 30-second chunks, streams each chunk to an ASR model, keeps the segments, and reports
progress while the work runs. The text is the visible part. Whether the service is correct and
affordable is decided around it: refusals made before a byte is downloaded, a ledger that keeps a
redelivered chunk from being billed twice, retries that resume a chunk instead of the file,
redaction before anything is published, and a read that only says done when it is.

## The real system

AssemblyAI's transcript API has the shape this course builds. A client posts an \`audio_url\` to
\`/v2/transcript\`, receives an id, and polls \`/v2/transcript/{id}\` until \`status\` is \`completed\` or
\`error\`. Redaction is a property of the job, not a pass the caller runs afterwards: with
\`redact_pii\` set, \`redact_pii_policies\` names the entity types to remove and \`redact_pii_sub\` picks
the substitution, so the text that comes back is already redacted.

## What you build here

One service, **transcribed**, with five pieces that share one jobs store (\`transcribe.jobs\`,
provided: \`job:{id}\`, the audio index, saved segments, the \`outbox\` list), one chunk ledger
(\`job:{id}:chunks\`, built in step 2 and provided to step 5 as \`transcribe.progress\`), the audio
store client \`transcribe.audio\` and the redactor \`transcribe.redact\`:

1. \`POST /v1/transcriptions\` with \`{audio_ref, duration_seconds, language}\`: at most four hours, an
   allowlisted language, both refused before \`audio.stage\`, and a job looked up by
   \`(tenant, sha256(audio_ref))\` before a new one is created.
2. \`run_chunk(job_id, index, total, transcribe)\`: a **Redis** hash per job, claimed in one Lua script
   before the ASR call, \`failed\` apart from \`done\`, expired 24 hours after the last chunk, which
   also marks the job done.
3. \`transcribe_chunk(job_id, audio_ref, index)\`: a **gRPC** \`Asr.TranscribeChunk\` stream for the
   chunk's own 30 seconds, a 60-second deadline, two attempts that resume at the last segment, and
   corrupt audio as terminal.
4. \`publish_segments(job_id, segments)\`: **Kafka** \`transcript.segment\` records keyed by job id,
   with timestamps and speaker, redacted first, an idempotent producer, and an outbox row written
   from the delivery report.
5. \`GET /v1/transcriptions/{id}\`: 404 for another tenant's job, \`done\` from the job record and
   \`partial\` otherwise, segments by \`start_ms\`, and a cursor past the first 100.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Model selection per language, diarization quality, streaming captions to the browser, audio
decoding and resampling, chunk-boundary overlap, multi-region placement, storage lifecycle rules,
billing reconciliation and the transcript editor. The five pieces above decide whether a
transcript is billed once, kept private and reported honestly.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · poll', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Transcription API', sub: 'POST · GET /v1/transcriptions', x: 28, y: 50},
      {id: 'storage', kind: 'external', label: 'Audio store', sub: 'stage(audio_ref)', x: 48, y: 8},
      {id: 'db', kind: 'db', label: 'jobs store', sub: 'job · segments · outbox', x: 48, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'job:{id}:chunks', x: 48, y: 88},
      {id: 'asr', kind: 'grpc', label: 'ASR provider', sub: 'TranscribeChunk', x: 74, y: 8},
      {id: 'worker', kind: 'service', label: 'Chunk worker', sub: 'run_chunk · publish_segments', x: 74, y: 50},
      {id: 'redactor', kind: 'service', label: 'Redactor', sub: 'redact(text)', x: 74, y: 88},
      {id: 'kafka', kind: 'kafka', label: 'transcript.segment', sub: 'key = job_id', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'storage', kind: 'plain', label: 'stage after validation'},
      {from: 'api', to: 'db', kind: 'plain', label: 'find_by_audio · create · read'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'completed chunks'},
      {from: 'worker', to: 'asr', kind: 'grpc', label: 'TranscribeChunk'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'claim · done · failed'},
      {from: 'worker', to: 'redactor', kind: 'plain', label: 'redact before publish'},
      {from: 'worker', to: 'db', kind: 'plain', label: 'segments · outbox'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce transcript.segment'},
    ],
  },
  steps: [
    transcriptionEndpointStep,
    transcriptionStateStep,
    transcriptionDependencyStep,
    transcriptionEventsStep,
    transcriptionReadStep,
  ],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
