import type {Problem} from '@/lib/types';

import {transcriptionEndpointStep} from './steps/1-endpoint';
import {transcriptionStateStep} from './steps/2-state';
import {transcriptionDependencyStep} from './steps/3-dependency';
import {transcriptionEventsStep} from './steps/4-events';
import {transcriptionReadStep} from './steps/5-read';

/**
 * Transcription service on the AI-era track: the course is not "send audio to an ASR model", it is
 * the review you owe a model-generated long-audio pipeline before it bills a tenant three times for
 * one bad minute. Metadata-validated, idempotent job creation → one atomic, expiring chunk-progress
 * set per job → a deadline-bounded gRPC chunk stream that resumes from its own offset → segment
 * events keyed by job and redacted before publish → a read path that reports partial honestly and
 * scopes every id to its tenant.
 */
export const transcriptionServiceProblem: Problem = {
  id: 'transcription-service',
  title: 'Transcription Service',
  tagline: 'Long-audio transcription with chunked progress, redaction and honest partial results.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Transcription Service

A transcription service is the piece of an AI platform that turns hours of audio into text: it
accepts a reference to an audio object, splits it into small spans, streams each span to an ASR
model, assembles the segments into a transcript, and reports progress while the work runs. The
visible part is text that appears when the job finishes; the parts that decide whether the service
is correct and affordable are the validation funnel that runs before a single byte is fetched, the
chunk-progress bookkeeping that keeps redeliveries from re-billing, the retry policy that resumes a
failed span instead of restarting the file, the redaction pass that gates publishing, and the read
path that refuses to certify a transcript it cannot prove complete.

## The real system

Production pipelines accept an audio reference and its metadata first, and they validate duration,
language and the idempotency key from that metadata before they touch the audio bytes. A five-hour
file is rejected as a \`400\` from the metadata alone — the service never downloads it to find out.
Creation is keyed by the audio hash, so a replayed submit returns the running job rather than
starting a second one. Work is split into fixed 30-second chunks, and each chunk's completion is
recorded in Redis with a single check-and-add so two workers that receive the same redelivered
chunk cannot both bill the provider. Progress keys carry a TTL, because a finished job that keeps
its keys pins memory forever. Every chunk streams to the ASR provider over gRPC under a 60-second
deadline, and when one chunk fails the pipeline re-runs *that chunk from its own start* — never the
whole file — with at most two attempts per chunk, while a corrupt-audio rejection is terminal for
its span and is marked as such rather than retried. Transcript segments are published keyed by the
job id so they land in order, with speaker labels and timestamps, and only *after* the redaction
pass has run, because a topic is retained and replicated long after a buffer TTL. And the read path
reports status, completed chunk count and the assembled transcript, but it refuses to certify a
transcript as finished while any chunk is failed or pending, it scopes every id to the requesting
tenant, and it paginates so a long transcript is reachable past the first page.

## What you build here

One service, **transcribed**, with five pieces:

1. \`POST /v1/transcriptions\`: an authenticated tenant, an audio reference with a duration of at
   most four hours, a language hint from an allowlist, and an \`Idempotency-Key\` keyed by the audio
   hash, returning a job that resumes rather than restarts on retry — with validation that happens
   from metadata, before the audio is downloaded.
2. A **Redis** chunk-progress set: one entry per completed 30-second chunk written by one atomic
   check-and-add, so a redelivered chunk transcribes once, and a 24-hour TTL on the progress keys
   once the job completes.
3. A **gRPC** ASR client: a 60-second deadline per chunk, at most two attempts per chunk, a retry
   that resumes the failed chunk from its own start rather than the file, and a corrupt-audio
   rejection that is terminal for its span and recorded as a marker.
4. A **Kafka** segment path: \`transcript.segment\` keyed by job id so segments stay ordered per job,
   carrying timestamps and speaker labels, published only after redaction, with an outbox row when
   the broker rejects the produce.
5. \`GET /v1/transcriptions/{id}\`: status, completed chunk count and the transcript assembled from
   stored segments, a refusal to report \`done\` while any chunk is failed or pending, a \`404\` for a
   missing or foreign id, and cursor pagination past the first page of segments.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

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
