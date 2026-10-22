import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-api';
import {sessionStateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Voice agent on the AI-era track: the course is not "play audio over a socket", it is the review
 * you owe a model-generated realtime speech loop before a caller hears it. A codec and duration
 * contract at the door with a resumable session → atomic turn state in Redis so barge-in never
 * races the TTS offset → cancellable ASR/TTS streams that resume instead of replaying → turn
 * events keyed by session with a redacted transcript reference → a bounded, tenant-scoped
 * transcript read with cursor pagination.
 */
export const voiceAgentProblem: Problem = {
  id: 'voice-agent',
  title: 'Voice Agent',
  tagline: 'Realtime speech sessions with barge-in, bounded retries and transcript-safe events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Voice Agent

A voice agent is the service in front of a realtime speech loop: it recognises what the caller says,
decides when the turn is over, streams synthetic speech back, and lets the caller interrupt the
answer mid-sentence. The visible product is a conversation. The parts that decide whether it is safe
are the codec contract at the door, the atomic turn state behind barge-in, the cancellation and
retry policy on the speech streams, the ordering and privacy of the transcript events, and the
bounded reader that serves the transcript afterwards.

## The real system

Production voice platforms accept a small set of codecs and sample rates, because the media pipeline
downstream is built for those and nothing else. They cap a session at a wall-clock maximum so one
stuck caller cannot hold a stream and its GPU forever. They let a reconnecting client resume the
session it already had — same session id, same turn count — instead of forking a second one that
bills twice. Turn state lives in a fast store with a short TTL refreshed by every audio frame, so a
silent pause longer than the TTL ends a dead session but a long answer keeps its own alive. When the
caller speaks over the agent, the interruption is a single atomic transition that changes the
current speaker and truncates the speech stream at the token already delivered; two separate writes
leave a window where the agent keeps talking over the user. The speech-to-text and text-to-speech
calls are streaming RPCs with an idle deadline, and once audio has been delivered to the caller a
retry resumes from the delivered offset or fails — it never replays the first sentence. Turn events
are keyed by session so one transcript assembles in order, and they reference a stored, redacted
transcript rather than carrying audio or raw speech. The read endpoint is capped and paginated, and
it is scoped to the caller's tenant.

## What you build here

One service, **voice-gateway**, with five pieces:

1. \`POST /v1/voice/sessions\`: a validated codec and sample-rate contract, a 30-minute maximum
   duration, and an \`Idempotency-Key\` so a reconnect resumes the live session and its turn count
   instead of forking a new one.
2. A **Redis** turn state: current speaker, turn index and TTS token offset under a 30-second TTL
   refreshed by every audio frame, with barge-in as one atomic transition that truncates the
   speech stream at the current token.
3. A **gRPC** speech client: \`Recognize\` and \`Synthesize\` streams under a 10-second idle
   deadline, cancellation that stops billing, and a retry that resumes at the delivered token
   offset or fails cleanly rather than replaying audio.
4. A **Kafka** turn path: one \`voice.turn\` event per turn keyed by session, carrying the turn
   index, timings and a reference to the stored redacted transcript, with the consumer committing
   its offset only after the transcript row is durable.
5. \`GET /v1/voice/sessions/{id}\`: the transcript with per-turn timestamps and redaction spans,
   capped at 500 turns with cursor pagination, scoped to the tenant, and never exposing an audio
   storage path.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it plays the demo
call, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

WebRTC and transport negotiation, acoustic echo cancellation, VAD tuning, model selection for ASR
and TTS, voice cloning and consent flows, per-region media routing, billing and invoicing, and the
storage format of the redacted transcript itself. The five pieces above are the ones that decide
whether the agent is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'mic · speaker', x: 8, y: 50},
      {id: 'gateway', kind: 'http', label: 'Voice Gateway', sub: 'HTTPS :8444', x: 26, y: 50},
      {id: 'sessions', kind: 'db', label: 'Session store', sub: 'idempotency · sessions', x: 30, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'turn state · TTL 30s', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'voice.turn', sub: 'key = session', x: 46, y: 88},
      {id: 'asr', kind: 'grpc', label: 'ASR', sub: 'Recognize stream', x: 68, y: 10},
      {id: 'tts', kind: 'grpc', label: 'TTS', sub: 'Synthesize stream', x: 68, y: 34},
      {id: 'transcripts', kind: 'db', label: 'Transcript store', sub: 'redacted turns', x: 68, y: 60},
      {id: 'consumer', kind: 'service', label: 'Transcript consumer', sub: 'group transcripts', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'gateway', kind: 'http', label: 'session op'},
      {from: 'gateway', to: 'sessions', kind: 'plain', label: 'session · idempotency'},
      {from: 'gateway', to: 'redis', kind: 'redis', label: 'barge-in · offsets'},
      {from: 'gateway', to: 'asr', kind: 'grpc', label: 'Recognize'},
      {from: 'gateway', to: 'tts', kind: 'grpc', label: 'Synthesize'},
      {from: 'gateway', to: 'kafka', kind: 'kafka', label: 'produce voice.turn'},
      {from: 'gateway', to: 'transcripts', kind: 'plain', label: 'read turns'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'transcripts', kind: 'plain', label: 'store redacted turn'},
    ],
  },
  steps: [endpointStep, sessionStateStep, dependencyStep, eventsStep, readStep],
};
