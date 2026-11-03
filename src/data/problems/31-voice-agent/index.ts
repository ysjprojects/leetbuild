import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-api';
import {sessionStateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Voice agent: the course is not "play audio over a socket", it is the debugging you owe a realtime
 * speech loop before a caller hears it. An audio contract and a resumable session at the door → a
 * Redis turn state where barge-in and late frames cannot race → a TTS stream that stops on barge-in
 * and resumes instead of replaying → session-keyed turn events that carry a redacted reference → a
 * tenant-scoped transcript read in bounded pages.
 */
export const voiceAgentProblem: Problem = {
  id: 'voice-agent',
  title: 'Voice Agent',
  tagline: 'Codec contract, Lua barge-in, resumable TTS streams, redacted turn events and paged transcripts.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Voice Agent

A voice agent is the service in front of a realtime speech loop: the caller speaks, the agent
answers in synthetic speech, and the caller can cut in mid-sentence. Whether a call holds up depends
on the plain parts around the models: the audio contract at the door, who holds the floor when both
talk, what happens when the speech stream drops, what leaves the gateway about the conversation, and
who can read the transcript afterwards.

## The real system

OpenAI's Realtime API has a client event for barge-in, \`conversation.item.truncate\`. The server
produces audio faster than realtime, so when the user interrupts, the client sends how much of the
assistant's audio was actually played (\`audio_end_ms\`) and the server cuts the message there: the
conversation remembers what the caller heard, not what was sent. This course keeps the same split
between the tokens the speech stream delivered and the tokens the caller heard.

## What you build here

One service, **voice-gateway**, over one provided package, \`voice\`: the session store
(\`voice.sessions\`), the turn state as the later steps use it (\`voice.turnstate\`, built in step 2)
and the transcript store (\`voice.transcripts\`: \`redact\`, \`insert_turn\`, \`list_turns\`).

1. \`POST /v1/voice/sessions\` with \`X-Tenant-Id\`, \`Idempotency-Key\` and \`{codec, sample_rate,
   max_duration_s}\`: 401 without a tenant, 415 for a pair outside \`SUPPORTED_FORMATS\`, a duration
   of 1 to 1800 s (default 1800), and a replayed key answers the session it created.
2. A **Redis** turn state \`voice:state:{id}\` (\`current_speaker\`, \`turn_index\`, \`tts_offset\`):
   \`record_frame\` records playback only for the current turn and \`barge_in\` hands the floor to the
   caller at what was heard, each one Lua script that refreshes a 30 s TTL; \`read_state\` is one read.
3. A **gRPC** \`Synthesize\` stream from \`tts:9000\` (\`speak\`): a 10 s deadline per attempt, a cancel
   once \`record_frame\` says the turn moved on, and up to three attempts on \`UNAVAILABLE\` that
   resume at \`resume_offset\`.
4. A **Kafka** \`voice.turn\` stream (\`record_turn\`, \`run\`): keyed by session, carrying the turn
   index, the timings and the reference \`redact\` returned, from an idempotent producer with
   \`acks=all\`; the consumer commits after \`insert_turn\`.
5. \`GET /v1/voice/sessions/{id}\`: the tenant's transcript, at most 500 turns a page with a
   \`next_cursor\`, each turn with its timings and redaction spans and no recording path.

## The debugging habit

Every starter is working code with flaws: it compiles, plays the demo call and looks right. Debug it
against the failure modes the task names, fix it, and prove the fix with checks that fail on the
starter and pass on your version.

## Left out on purpose

WebRTC negotiation, voice activity detection, speech recognition, echo cancellation, voice
selection, per-region media routing, billing, and how the media pipeline stores recordings.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'mic · speaker', x: 8, y: 50},
      {id: 'gateway', kind: 'http', label: 'Voice Gateway', sub: 'voice-gateway', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'sessions · turn state · TTL 30s', x: 50, y: 14},
      {id: 'tts', kind: 'grpc', label: 'TTS', sub: 'Synthesize · tts:9000', x: 76, y: 14},
      {id: 'transcripts', kind: 'db', label: 'Transcript store', sub: 'redacted turns', x: 76, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'voice.turn', sub: 'key = session', x: 50, y: 86},
      {id: 'consumer', kind: 'service', label: 'Transcript consumer', sub: 'group transcripts', x: 76, y: 86},
    ],
    edges: [
      {from: 'client', to: 'gateway', kind: 'http', label: 'session · transcript'},
      {from: 'gateway', to: 'redis', kind: 'redis', label: 'sessions · barge-in'},
      {from: 'gateway', to: 'tts', kind: 'grpc', label: 'Synthesize'},
      {from: 'gateway', to: 'transcripts', kind: 'plain', label: 'redact · list_turns'},
      {from: 'gateway', to: 'kafka', kind: 'kafka', label: 'produce voice.turn'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'transcripts', kind: 'plain', label: 'insert_turn'},
    ],
  },
  steps: [endpointStep, sessionStateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
