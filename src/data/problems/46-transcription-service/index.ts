import type {Problem} from '@/lib/types';

import {transcriptionEndpointStep} from './steps/1-endpoint';
import {transcriptionStateStep} from './steps/2-state';
import {transcriptionDependencyStep} from './steps/3-dependency';
import {transcriptionEventsStep} from './steps/4-events';
import {transcriptionReadStep} from './steps/5-read';

/**
 * Transcription service: the course is not "send audio to an ASR model", it is the debugging you
 * owe a long-audio pipeline before it bills a tenant three times for one bad minute.
 * Metadata-validated, idempotent job creation → one atomic, expiring chunk-progress set per job →
 * a deadline-bounded gRPC chunk stream that resumes from its own offset → segment events keyed by
 * job and redacted before publish → a read path that reports partial honestly and scopes every id
 * to its tenant.
 */
export const transcriptionServiceProblem: Problem = {
  id: 'transcription-service',
  title: 'Transcription Service',
  tagline: 'Long-audio transcription that bills each chunk once and redacts before it publishes.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Transcription Service

A transcription service turns hours of audio into text: it accepts a reference to an audio object,
splits it into 30-second spans, streams each span to an ASR model, assembles the segments, and
reports progress while the work runs. The text is the visible part. What decides whether the service
is correct and affordable is everything around it: validation before a byte is fetched, chunk
bookkeeping that keeps redeliveries from re-billing, retries that resume a span instead of the file,
redaction that gates publishing, and a read path that certifies only what it can prove.

## The real system

AssemblyAI's transcript API has the shape this course debugs toward. A client posts an \`audio_url\`
to \`/v2/transcript\`, receives an id, and polls \`/v2/transcript/{id}\` until \`status\` is
\`completed\` or \`error\`; nothing is certified before the job says so. Redaction is a property of
the job rather than a pass the caller runs afterwards: with \`redact_pii\` set,
\`redact_pii_policies\` names the entity types to remove and \`redact_pii_sub\` picks the
substitution, so the returned text reads \`Hi, my name is ####\` or \`[PERSON_NAME]\`.

## What you build here

One service, **transcribed**, with five pieces:

1. \`POST /v1/transcriptions\`: an authenticated tenant, an audio reference, a duration cap of four
   hours, a language allowlist, an \`Idempotency-Key\` keyed by the audio hash, and validation from
   metadata before any download.
2. A **Redis** chunk-progress set: one atomic check-and-add per 30-second chunk, so a redelivered
   chunk transcribes once, and a 24-hour TTL once the job completes.
3. A **gRPC** ASR client: a 60-second deadline per chunk, at most two attempts, a retry that resumes
   the chunk rather than the file, and a terminal marker for corrupt audio.
4. A **Kafka** segment path: \`transcript.segment\` keyed by job id, carrying timestamps and speaker
   labels, published after redaction, with an outbox row when the broker rejects the produce.
5. \`GET /v1/transcriptions/{id}\`: status, completed chunk count and the assembled transcript,
   \`partial\` while any chunk is failed or pending, \`404\` for a missing or foreign id, and cursor
   pagination past the first page.

## The debugging habit

Every starter compiles and serves the happy path. Debug it, fix it, and prove the fix with checks
that fail on the starter and pass on your version.

## Left out on purpose

Model selection per language, diarization quality, streaming to the browser, audio decoding and
resampling internals, chunk-boundary heuristics, multi-region job placement, storage lifecycle
rules, billing reconciliation, and the transcript editor UI. The five pieces above are the ones
that decide whether transcription is correct, affordable and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · poll', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Transcription API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'storage', kind: 'external', label: 'Audio store', sub: 'object storage', x: 48, y: 8},
      {id: 'db', kind: 'db', label: 'jobs · segments', sub: 'durable store', x: 48, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'chunk progress', x: 48, y: 88},
      {id: 'asr', kind: 'grpc', label: 'ASR provider', sub: 'TranscribeChunk', x: 74, y: 8},
      {id: 'worker', kind: 'service', label: 'Chunk worker', sub: 'fetch · chunk · publish', x: 74, y: 50},
      {id: 'redactor', kind: 'service', label: 'Redactor', sub: 'redact before publish', x: 74, y: 88},
      {id: 'kafka', kind: 'kafka', label: 'transcript.segment', sub: 'key = job', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'storage', kind: 'plain', label: 'audio ref'},
      {from: 'api', to: 'db', kind: 'plain', label: 'jobs · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'chunk progress'},
      {from: 'worker', to: 'storage', kind: 'plain', label: 'read chunk bytes'},
      {from: 'worker', to: 'asr', kind: 'grpc', label: 'TranscribeChunk'},
      {from: 'worker', to: 'redactor', kind: 'grpc', label: 'redact segments'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'progress marks'},
      {from: 'worker', to: 'db', kind: 'plain', label: 'segments · outbox'},
      {from: 'redactor', to: 'kafka', kind: 'kafka', label: 'produce transcript.segment'},
    ],
  },
  steps: [
    transcriptionEndpointStep,
    transcriptionStateStep,
    transcriptionDependencyStep,
    transcriptionEventsStep,
    transcriptionReadStep,
  ],
};
