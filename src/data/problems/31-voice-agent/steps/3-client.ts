import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'A Synthesize stream that stops on barge-in and resumes instead of replaying',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['gateway', 'tts', 'redis'],
  task: `## Task

**Starting point.** The starter is \`speak(session_id, text, play)\`, the speech client a turn runs: it
reads the session's turn from \`voice.turnstate\`, opens \`Synthesize\` on \`tts:9000\`, hands every
\`AudioChunk\` to \`play\`, records each frame with \`turnstate.record_frame(session_id, turn,
chunk.offset)\`, and on any error sleeps \`RETRY_BACKOFF_S\` and starts the answer again. It plays the
demo answer and hides four flaws.

**Failure mode the checks target.** A TTS node that stops answering holds the turn open; a caller who
talks over the agent keeps hearing it; a stream that drops after three words replays them; and an
outage turns one answer into a retry loop that never ends.

- Every attempt carries a **10 s deadline** (\`SYNTHESIZE_DEADLINE_S\`): synthesis runs faster than
  playback, so it bounds a whole answer.
- When \`record_frame\` returns false the caller barged in: stop playing and **cancel** the stream, so
  the provider stops synthesising.
- A retry sends \`resume_offset\`, the offset already played, and goes on from there.
- At most \`MAX_ATTEMPTS\` (3) attempts, and only \`UNAVAILABLE\` is retried; any other status fails
  the turn at once. \`speak\` returns the offset played.`,
  sequence: {
    participants: ['Voice Gateway', 'TTS', 'Redis'],
    messages: [
      {from: 'Voice Gateway', to: 'TTS', label: 'Synthesize · deadline 10 s · resume_offset 0', kind: 'sync'},
      {from: 'TTS', to: 'Voice Gateway', label: 'AudioChunk offset 1 … 3, then UNAVAILABLE', kind: 'reply'},
      {from: 'Voice Gateway', to: 'TTS', label: 'Synthesize · resume_offset 3', kind: 'sync'},
      {from: 'TTS', to: 'Voice Gateway', label: 'AudioChunk offset 4, 5 …', kind: 'reply'},
      {from: 'Voice Gateway', to: 'Redis', label: 'record_frame(turn 0, 5) → 0: the caller barged in', kind: 'sync'},
      {from: 'Voice Gateway', to: 'TTS', label: 'cancel', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries the 10 s deadline',
      detail:
        'Each `Synthesize` call is opened with `SYNTHESIZE_DEADLINE_S` (`timeout=`, `deadline:`, a context with timeout, `withDeadlineAfter`, `set_deadline`), so a TTS that stops answering fails the turn instead of holding it.',
      match: {
        python: {all: [/Synthesize\([\s\S]{0,200}?timeout\s*=/]},
        typescript: {all: [/Synthesize\([\s\S]{0,200}?deadline\s*:/]},
        go: {all: [/context\.With(Timeout|Deadline)\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'barge-in',
      title: 'Stops and cancels the stream once the caller barged in',
      detail:
        "When `record_frame` reports the turn moved on, `speak` plays nothing more and cancels the call (`cancel()`, the context's cancel, `TryCancel()`); the starter ignores the answer and plays to the end.",
      match: {
        python: {all: [/not\s+turnstate\.record_frame\(/, /\.cancel\(\)/]},
        typescript: {all: [/!\s*\(\s*await\s+recordFrame\(/, /\.cancel\(\)/]},
        go: {all: [/\w+\s*,\s*\w+\s*:?=\s*turnstate\.RecordFrame\(/, /cancel\(\)/]},
        scala: {all: [/!\s*TurnState\.recordFrame\(/, /\.cancel\(/]},
        cpp: {all: [/!\s*turnstate::recordFrame\(/, /TryCancel\(\)/]},
      },
    },
    {
      id: 'resume',
      title: 'A retry resumes at the offset already played',
      detail:
        'The retried request carries `resume_offset` set to the offset the caller was played, and playback goes on from there; the starter starts the answer again from the first token.',
      match: {
        python: {all: [/resume_offset\s*=/]},
        typescript: {all: [/resume_offset\s*:/]},
        go: {all: [/ResumeOffset\s*:/]},
        scala: {all: [/resumeOffset\s*=/]},
        cpp: {all: [/set_resume_offset\(/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'At most three attempts, and only on UNAVAILABLE',
      detail:
        'The attempts are bounded by `MAX_ATTEMPTS` (3) and only `UNAVAILABLE` is retried; `INVALID_ARGUMENT` or a deadline fails the turn at once. The starter loops forever on any error.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3/, /UNAVAILABLE/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /UNAVAILABLE/],
          none: [/for\s*\(\s*;\s*;\s*\)|while\s*\(\s*true\s*\)/],
        },
        go: {
          all: [
            /maxAttempts\s*=\s*3/,
            /codes\.Unavailable/,
            /for\s+\w+\s*:=\s*0;\s*\w+\s*<\s*maxAttempts|range\s+maxAttempts/,
          ],
        },
        scala: {all: [/MaxAttempts\s*=\s*3/, /UNAVAILABLE/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3/, /UNAVAILABLE/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import speech_pb2
import speech_pb2_grpc
from voice import turnstate  # read_state, record_frame

RETRY_BACKOFF_S = 0.5

stub = speech_pb2_grpc.SpeechStub(grpc.insecure_channel("tts:9000"))


def speak(session_id: str, text: str, play) -> int:
    """Stream the answer to text and hand each chunk to play; returns the offset played."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    state = turnstate.read_state(session_id)
    turn = state["turn_index"] if state else 0
    while True:
        delivered = 0
        try:
            for chunk in stub.Synthesize(speech_pb2.SynthesizeRequest(session_id=session_id, text=text)):
                play(chunk)
                delivered = chunk.offset
                turnstate.record_frame(session_id, turn, delivered)
            return delivered
        except grpc.RpcError:
            time.sleep(RETRY_BACKOFF_S)
`,
      solution: `import grpc

import speech_pb2
import speech_pb2_grpc
from voice import turnstate  # read_state, record_frame

SYNTHESIZE_DEADLINE_S = 10.0
MAX_ATTEMPTS = 3

stub = speech_pb2_grpc.SpeechStub(grpc.insecure_channel("tts:9000"))


class SpeechUnavailable(Exception):
    pass


def speak(session_id: str, text: str, play) -> int:
    """Stream the answer to text and hand each chunk to play; returns the offset played."""
    state = turnstate.read_state(session_id)
    turn = state["turn_index"] if state else 0
    delivered = 0
    for _ in range(MAX_ATTEMPTS):
        # A retry continues where the caller is: the tokens before resume_offset were played.
        request = speech_pb2.SynthesizeRequest(session_id=session_id, text=text, resume_offset=delivered)
        try:
            call = stub.Synthesize(request, timeout=SYNTHESIZE_DEADLINE_S)
            for chunk in call:
                play(chunk)
                delivered = chunk.offset
                if not turnstate.record_frame(session_id, turn, delivered):
                    call.cancel()  # the caller has the floor: the provider stops synthesising
                    return delivered
            return delivered
        except grpc.RpcError as exc:
            if exc.code() != grpc.StatusCode.UNAVAILABLE:
                raise  # a refused request or a stalled provider fails the same way on every attempt
    raise SpeechUnavailable(f"Synthesize failed {MAX_ATTEMPTS} times")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {readState, recordFrame} from 'voice/turnstate';

export const RETRY_BACKOFF_MS = 500;

export interface AudioChunk {
  offset: number;
  audio: Buffer;
}
interface SynthesizeRequest {
  session_id: string;
  text: string;
  resume_offset?: number;
}
type SpeechStub = grpc.Client & {
  Synthesize(request: SynthesizeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): grpc.ClientReadableStream<AudioChunk>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('speech.proto')) as unknown as {
  voice: {Speech: grpc.ServiceClientConstructor};
};
const stub = new pkg.voice.Speech('tts:9000', grpc.credentials.createInsecure()) as SpeechStub;

/** The chunks of one call as they arrive; throws the call's error once the chunks before it are out. */
async function* chunksOf(call: grpc.ClientReadableStream<AudioChunk>): AsyncGenerator<AudioChunk> {
  const queue: AudioChunk[] = [];
  let done = false;
  let failed: grpc.ServiceError | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  call.on('data', (chunk: AudioChunk) => {
    queue.push(chunk);
    notify();
  });
  call.on('error', (e: grpc.ServiceError) => {
    failed = e;
    notify();
  });
  call.on('end', () => {
    done = true;
    notify();
  });
  while (!done || queue.length > 0 || failed !== null) {
    if (queue.length > 0) {
      yield queue.shift() as AudioChunk;
      continue;
    }
    if (failed !== null) throw failed;
    const {promise, resolve} = Promise.withResolvers<void>();
    wake = resolve;
    await promise;
  }
}

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Stream the answer to text and hand each chunk to play; returns the offset played. */
export async function speak(sessionId: string, text: string, play: (chunk: AudioChunk) => void): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const state = await readState(sessionId);
  const turn = state?.turn_index ?? 0;
  for (;;) {
    let delivered = 0;
    try {
      for await (const chunk of chunksOf(stub.Synthesize({session_id: sessionId, text}, new grpc.Metadata(), {}))) {
        play(chunk);
        delivered = chunk.offset;
        await recordFrame(sessionId, turn, delivered);
      }
      return delivered;
    } catch {
      await sleep(RETRY_BACKOFF_MS);
    }
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {readState, recordFrame} from 'voice/turnstate';

export const SYNTHESIZE_DEADLINE_MS = 10_000;
export const MAX_ATTEMPTS = 3;

export interface AudioChunk {
  offset: number;
  audio: Buffer;
}
interface SynthesizeRequest {
  session_id: string;
  text: string;
  resume_offset?: number;
}
type SpeechStub = grpc.Client & {
  Synthesize(request: SynthesizeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): grpc.ClientReadableStream<AudioChunk>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('speech.proto')) as unknown as {
  voice: {Speech: grpc.ServiceClientConstructor};
};
const stub = new pkg.voice.Speech('tts:9000', grpc.credentials.createInsecure()) as SpeechStub;

export class SpeechUnavailable extends Error {}

/** The chunks of one call as they arrive; throws the call's error once the chunks before it are out. */
async function* chunksOf(call: grpc.ClientReadableStream<AudioChunk>): AsyncGenerator<AudioChunk> {
  const queue: AudioChunk[] = [];
  let done = false;
  let failed: grpc.ServiceError | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  call.on('data', (chunk: AudioChunk) => {
    queue.push(chunk);
    notify();
  });
  call.on('error', (e: grpc.ServiceError) => {
    failed = e;
    notify();
  });
  call.on('end', () => {
    done = true;
    notify();
  });
  while (!done || queue.length > 0 || failed !== null) {
    if (queue.length > 0) {
      yield queue.shift() as AudioChunk;
      continue;
    }
    if (failed !== null) throw failed;
    const {promise, resolve} = Promise.withResolvers<void>();
    wake = resolve;
    await promise;
  }
}

/** Stream the answer to text and hand each chunk to play; returns the offset played. */
export async function speak(sessionId: string, text: string, play: (chunk: AudioChunk) => void): Promise<number> {
  const state = await readState(sessionId);
  const turn = state?.turn_index ?? 0;
  let delivered = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // A retry continues where the caller is: the tokens before resume_offset were played.
    const call = stub.Synthesize(
      {session_id: sessionId, text, resume_offset: delivered},
      new grpc.Metadata(),
      {deadline: Date.now() + SYNTHESIZE_DEADLINE_MS},
    );
    try {
      for await (const chunk of chunksOf(call)) {
        play(chunk);
        delivered = chunk.offset;
        if (!(await recordFrame(sessionId, turn, delivered))) {
          call.cancel(); // the caller has the floor: the provider stops synthesising
          return delivered;
        }
      }
      return delivered;
    } catch (e) {
      // A refused request or a stalled provider fails the same way on every attempt.
      if ((e as grpc.ServiceError).code !== grpc.status.UNAVAILABLE) throw e;
    }
  }
  throw new SpeechUnavailable(\`Synthesize failed \${MAX_ATTEMPTS} times\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"io"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "voice/gen/speech"
	"voice/turnstate" // turnstate.ReadState, RecordFrame
)

const retryBackoff = 500 * time.Millisecond

var tts = dial("tts:9000")

func dial(target string) pb.SpeechClient {
	conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	return pb.NewSpeechClient(conn)
}

// speak streams the answer to text and hands each chunk to play; it returns the offset played.
func speak(ctx context.Context, sessionID, text string, play func(*pb.AudioChunk)) (int, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	state, err := turnstate.ReadState(ctx, sessionID)
	if err != nil {
		return 0, err
	}
	turn := 0
	if state != nil {
		turn = state.TurnIndex
	}
	for {
		delivered := 0
		stream, err := tts.Synthesize(ctx, &pb.SynthesizeRequest{SessionId: sessionID, Text: text})
		for err == nil {
			var chunk *pb.AudioChunk
			chunk, err = stream.Recv()
			if err == io.EOF {
				return delivered, nil
			}
			if err == nil {
				play(chunk)
				delivered = int(chunk.GetOffset())
				turnstate.RecordFrame(ctx, sessionID, turn, delivered)
			}
		}
		time.Sleep(retryBackoff)
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"io"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "voice/gen/speech"
	"voice/turnstate" // turnstate.ReadState, RecordFrame
)

const (
	synthesizeDeadline = 10 * time.Second
	maxAttempts        = 3
)

var tts = dial("tts:9000")

func dial(target string) pb.SpeechClient {
	conn, _ := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	return pb.NewSpeechClient(conn)
}

var errSpeechUnavailable = errors.New("Synthesize failed on every attempt")

// attempt plays one Synthesize stream from *delivered on; nil once the answer is over or the caller barged in.
func attempt(ctx context.Context, sessionID, text string, turn int, delivered *int, play func(*pb.AudioChunk)) error {
	call, cancel := context.WithTimeout(ctx, synthesizeDeadline)
	defer cancel() // the caller has the floor, or the answer is over: the provider stops synthesising
	// A retry continues where the caller is: the tokens before ResumeOffset were played.
	stream, err := tts.Synthesize(call, &pb.SynthesizeRequest{SessionId: sessionID, Text: text, ResumeOffset: int32(*delivered)})
	if err != nil {
		return err
	}
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		play(chunk)
		*delivered = int(chunk.GetOffset())
		current, err := turnstate.RecordFrame(ctx, sessionID, turn, *delivered)
		if err != nil {
			return err
		}
		if !current {
			cancel()
			return nil
		}
	}
}

// speak streams the answer to text and hands each chunk to play; it returns the offset played.
func speak(ctx context.Context, sessionID, text string, play func(*pb.AudioChunk)) (int, error) {
	state, err := turnstate.ReadState(ctx, sessionID)
	if err != nil {
		return 0, err
	}
	turn := 0
	if state != nil {
		turn = state.TurnIndex
	}
	delivered := 0
	for i := 0; i < maxAttempts; i++ {
		err := attempt(ctx, sessionID, text, turn, &delivered, play)
		if err == nil {
			return delivered, nil
		}
		if status.Code(err) != codes.Unavailable {
			return delivered, err // a refused request or a stalled provider fails the same way on every attempt
		}
	}
	return delivered, errSpeechUnavailable
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import voice.TurnState // TurnState.readState, recordFrame
import voice.speech.{AudioChunk, SpeechGrpc, SynthesizeRequest}

import scala.jdk.CollectionConverters._

object Client {
  val RetryBackoffMillis = 500L

  private val stub = SpeechGrpc.blockingStub(ManagedChannelBuilder.forAddress("tts", 9000).usePlaintext().build())

  /** Stream the answer to text and hand each chunk to play; returns the offset played. */
  def speak(sessionId: String, text: String, play: AudioChunk => Unit): Int = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val turn = TurnState.readState(sessionId).map(_.turnIndex).getOrElse(0)
    while (true) {
      var delivered = 0
      try {
        stub.synthesize(SynthesizeRequest(sessionId = sessionId, text = text)).foreach { chunk =>
          play(chunk)
          delivered = chunk.offset
          TurnState.recordFrame(sessionId, turn, delivered)
        }
        return delivered
      } catch {
        case _: StatusRuntimeException => Thread.sleep(RetryBackoffMillis)
      }
    }
    0
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Context, ManagedChannelBuilder, Status, StatusRuntimeException}
import voice.TurnState // TurnState.readState, recordFrame
import voice.speech.{AudioChunk, SpeechGrpc, SynthesizeRequest}

object Client {
  val SynthesizeDeadlineMillis = 10000L
  val MaxAttempts = 3

  private val stub = SpeechGrpc.blockingStub(ManagedChannelBuilder.forAddress("tts", 9000).usePlaintext().build())

  class SpeechUnavailable extends RuntimeException(s"Synthesize failed $MaxAttempts times")

  /** Stream the answer to text and hand each chunk to play; returns the offset played. */
  def speak(sessionId: String, text: String, play: AudioChunk => Unit): Int = {
    val turn = TurnState.readState(sessionId).map(_.turnIndex).getOrElse(0)
    var delivered = 0
    var attempt = 0
    while (attempt < MaxAttempts) {
      attempt += 1
      val scope = Context.current().withCancellation()
      val previous = scope.attach()
      try {
        // A retry continues where the caller is: the tokens before resumeOffset were played.
        val chunks = stub
          .withDeadlineAfter(SynthesizeDeadlineMillis, TimeUnit.MILLISECONDS)
          .synthesize(SynthesizeRequest(sessionId = sessionId, text = text, resumeOffset = delivered))
        var current = true
        while (current && chunks.hasNext) {
          val chunk = chunks.next()
          play(chunk)
          delivered = chunk.offset
          if (!TurnState.recordFrame(sessionId, turn, delivered)) current = false
        }
        return delivered
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE => ()
      } finally {
        scope.detach(previous)
        scope.cancel(null) // the caller has the floor, or the answer is over: the provider stops synthesising
      }
    }
    throw new SpeechUnavailable
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <thread>

#include "speech.grpc.pb.h"
#include "voice/turnstate.h"  // turnstate::readState, recordFrame

constexpr std::chrono::milliseconds kRetryBackoff{500};

auto tts = voice::Speech::NewStub(grpc::CreateChannel("tts:9000", grpc::InsecureChannelCredentials()));

// Stream the answer to text and hand each chunk to play; returns the offset played.
long speak(const std::string& session_id, const std::string& text, const std::function<void(const voice::AudioChunk&)>& play) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto state = turnstate::readState(session_id);
  const long turn = state ? state->turn_index : 0;
  while (true) {
    grpc::ClientContext ctx;
    voice::SynthesizeRequest request;
    request.set_session_id(session_id);
    request.set_text(text);
    auto reader = tts->Synthesize(&ctx, request);
    long delivered = 0;
    voice::AudioChunk chunk;
    while (reader->Read(&chunk)) {
      play(chunk);
      delivered = chunk.offset();
      turnstate::recordFrame(session_id, turn, delivered);
    }
    if (reader->Finish().ok()) return delivered;
    std::this_thread::sleep_for(kRetryBackoff);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>

#include "speech.grpc.pb.h"
#include "voice/turnstate.h"  // turnstate::readState, recordFrame

constexpr std::chrono::seconds kSynthesizeDeadline{10};
constexpr int kMaxAttempts = 3;

auto tts = voice::Speech::NewStub(grpc::CreateChannel("tts:9000", grpc::InsecureChannelCredentials()));

// A failed turn: the status of the last attempt.
struct SpeechError : std::runtime_error {
  grpc::StatusCode code;
  SpeechError(grpc::StatusCode c, const std::string& what) : std::runtime_error(what), code(c) {}
};

// Stream the answer to text and hand each chunk to play; returns the offset played.
long speak(const std::string& session_id, const std::string& text, const std::function<void(const voice::AudioChunk&)>& play) {
  const auto state = turnstate::readState(session_id);
  const long turn = state ? state->turn_index : 0;
  long delivered = 0;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kSynthesizeDeadline);
    voice::SynthesizeRequest request;
    request.set_session_id(session_id);
    request.set_text(text);
    request.set_resume_offset(static_cast<int32_t>(delivered));  // the tokens before it were played
    auto reader = tts->Synthesize(&ctx, request);
    voice::AudioChunk chunk;
    bool current = true;
    while (current && reader->Read(&chunk)) {
      play(chunk);
      delivered = chunk.offset();
      if (!turnstate::recordFrame(session_id, turn, delivered)) {
        ctx.TryCancel();  // the caller has the floor: the provider stops synthesising
        current = false;
      }
    }
    const grpc::Status status = reader->Finish();
    if (!current || status.ok()) return delivered;
    // A refused request or a stalled provider fails the same way on every attempt.
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) throw SpeechError(status.error_code(), status.error_message());
  }
  throw SpeechError(grpc::StatusCode::UNAVAILABLE, "Synthesize failed on every attempt");
}
`,
    },
  },
  harness: {
    python: `import grpc

import speech_pb2
import speech_pb2_grpc
from voice import turnstate

TTS = "tts:9000"
TOKENS = 10
ANSWER = "Your order ships tomorrow and arrives on Friday before noon, signed for."


class Tts(speech_pb2_grpc.SpeechServicer):
    """The TTS provider: one chunk per token after resume_offset; with fail_after, its first stream fails UNAVAILABLE after that many chunks."""

    def __init__(self, fail_after=None):
        self.fail_after = fail_after
        self.contexts = []
        self.resumes = []

    def Synthesize(self, request, context):
        self.contexts.append(context)
        self.resumes.append(request.resume_offset)
        first = len(self.contexts) == 1
        for i, token in enumerate(range(request.resume_offset, TOKENS)):
            if first and self.fail_after is not None and i == self.fail_after:
                context.abort(grpc.StatusCode.UNAVAILABLE, "tts node restarting")
            yield speech_pb2.AudioChunk(offset=token + 1, audio=bytes([token]))


def _world(ctx, fail_after=None):
    tts = Tts(fail_after)
    ctx.grpc.serve(speech_pb2_grpc.add_SpeechServicer_to_server, tts, TTS)
    return ctx.load("client"), tts


def _speak(ctx, m, on_play=None):
    """One turn: the offsets played, what speak returned or raised, and whether it ended at all."""
    played, out = [], {}

    def play(chunk):
        played.append(chunk.offset)
        if on_play is not None:
            on_play(chunk)

    def run():
        try:
            out["spoken"] = m.speak("vs-1", ANSWER, play)
        except Exception as exc:  # noqa: BLE001 - whatever the turn ended with is the outcome
            out["error"] = exc
        return True

    ctx.clock.sleep_limit = ctx.clock.sleeps + 200  # a retry loop that never ends is stopped here
    ended = bool(ctx.drain(run))
    return played, out, ended


def _calls(ctx):
    return ctx.grpc.calls_to("Synthesize", TTS)


async def check_deadline(ctx):
    m, tts = _world(ctx)
    ctx.grpc.set_latency("Synthesize", 20.0, TTS)
    played, out, ended = _speak(ctx, m)
    calls = _calls(ctx)
    assert ended, f"with the TTS stalled the turn never ended ({len(calls)} attempts): every attempt needs a deadline"
    assert calls and calls[0].timeout is not None, "the Synthesize call carries no deadline: a TTS that stops answering holds the turn open"
    assert 9.5 <= calls[0].timeout <= 10.5, f"the deadline must be SYNTHESIZE_DEADLINE_S (10 s), got {calls[0].timeout} s"
    assert "error" in out, f"a TTS that did not answer within 10 s must fail the turn; speak returned {out.get('spoken')} after playing {played}"
    assert len(calls) == 1, f"a deadline is not retried (the provider is stalled, not restarting), got {len(calls)} attempts"


async def check_barge_in(ctx):
    m, tts = _world(ctx)

    def caller_talks(chunk):
        if chunk.offset == 5:
            turnstate.barge_in("vs-1", 4)  # the caller talks over the fifth token, having heard four

    played, out, ended = _speak(ctx, m, caller_talks)
    assert ended and "error" not in out, f"the turn must end normally after a barge-in, it ended with {out}"
    assert played == [1, 2, 3, 4, 5], f"the caller barged in during offset 5 and speak went on playing {played[5:]}: stop once record_frame reports the turn moved on"
    state = turnstate.read_state("vs-1")
    assert state == {"current_speaker": "user", "turn_index": 1, "tts_offset": 4}, f"after the barge-in the turn state is {state}, expected the caller on turn 1 at offset 4"
    assert out.get("spoken") == 5, f"speak must return the offset played (5), got {out.get('spoken')}"
    assert tts.contexts[0].cancelled(), "speak stopped reading but left the Synthesize stream open: cancel it, or the provider keeps synthesising (and billing) the rest of the answer"


async def check_resume(ctx):
    m, tts = _world(ctx, fail_after=3)
    played, out, ended = _speak(ctx, m)
    assert ended and "error" not in out, f"a stream that dropped once must be resumed, the turn ended with {out}"
    assert played == list(range(1, TOKENS + 1)), f"the caller was played offsets {played}: after the stream dropped at offset 3 the retry replayed what they had heard. Send resume_offset"
    assert tts.resumes == [0, 3], f"the attempts asked for resume_offset {tts.resumes}, expected 0 and then 3"
    assert out.get("spoken") == TOKENS, f"speak must return the offset played ({TOKENS}), got {out.get('spoken')}"


async def check_bounded_retry(ctx):
    m, tts = _world(ctx)
    ctx.grpc.fail("Synthesize", grpc.StatusCode.INVALID_ARGUMENT, "text too long", times=1, target=TTS)
    played, out, ended = _speak(ctx, m)
    assert ended and "error" in out, f"INVALID_ARGUMENT must fail the turn at once, speak returned {out.get('spoken')}"
    assert len(_calls(ctx)) == 1, f"INVALID_ARGUMENT was retried ({len(_calls(ctx))} attempts): the request itself is refused, a retry fails the same way"
    ctx.grpc.stop(TTS)
    played, out, ended = _speak(ctx, m)
    attempts = len(_calls(ctx)) - 1
    assert ended, f"with the TTS down the turn never ended: {attempts} attempts and counting. Bound the attempts by MAX_ATTEMPTS"
    assert "error" in out, "with the TTS down speak must fail the turn, it returned normally"
    assert attempts == 3, f"with the TTS down speak made {attempts} attempts, expected MAX_ATTEMPTS (3)"
`,
    typescript: `const TTS = 'tts:9000';
const TOKENS = 10;
const ANSWER = 'Your order ships tomorrow and arrives on Friday before noon, signed for.';

/** The TTS provider: one chunk per token after resume_offset; with failAfter, its first stream fails UNAVAILABLE after that many chunks. */
function world(ctx, failAfter: number | null = null) {
  const calls: {cancelled: boolean}[] = []; // the server side of each Synthesize call
  const resumes: number[] = [];
  const pkg = ctx.proto('speech.proto');
  ctx.grpc.serve(
    pkg.voice.Speech.service,
    {
      Synthesize(call) {
        calls.push(call);
        const from = Number(call.request.resume_offset ?? 0);
        resumes.push(from);
        const first = calls.length === 1;
        for (let token = from, i = 0; token < TOKENS; token += 1, i += 1) {
          if (first && failAfter !== null && i === failAfter) {
            call.emit('error', Object.assign(new Error('tts node restarting'), {code: ctx.grpc.status.UNAVAILABLE}));
            return;
          }
          call.write({offset: token + 1, audio: Buffer.from([token])});
        }
        call.end();
      },
    },
    TTS,
  );
  return {m: ctx.load('client'), turnstate: ctx.load('/support/voice/turnstate.ts'), calls, resumes};
}

/** One turn: the offsets played, what speak returned or threw, and whether it ended at all. */
async function speak(ctx, m, onPlay: ((chunk) => Promise<void> | void) | null = null) {
  const played: number[] = [];
  const pending: Promise<void>[] = [];
  let spoken: number | null = null;
  let error: unknown = null;
  const run = async () => {
    try {
      spoken = await m.speak('vs-1', ANSWER, chunk => {
        played.push(chunk.offset);
        if (onPlay !== null) pending.push(Promise.resolve(onPlay(chunk)));
      });
    } catch (e) {
      error = e;
    }
    return true;
  };
  const ended = (await ctx.drain(run())) === true;
  await Promise.all(pending);
  return {played, spoken, error, ended};
}

const calls = (ctx) => ctx.grpc.callsTo('Synthesize', TTS);

export async function check_deadline(ctx) {
  const {m} = world(ctx);
  ctx.grpc.setLatency('Synthesize', 20.0, TTS);
  const out = await speak(ctx, m);
  const made = calls(ctx);
  assert(out.ended, \`with the TTS stalled the turn never ended (\${made.length} attempts): every attempt needs a deadline\`);
  assert(made.length > 0 && made[0].timeout !== null, 'the Synthesize call carries no deadline: a TTS that stops answering holds the turn open');
  assert(9.5 <= made[0].timeout && made[0].timeout <= 10.5, \`the deadline must be SYNTHESIZE_DEADLINE_MS (10 s), got \${made[0].timeout} s\`);
  assert(out.error !== null, \`a TTS that did not answer within 10 s must fail the turn; speak returned \${out.spoken} after playing \${JSON.stringify(out.played)}\`);
  assert.equal(made.length, 1, \`a deadline is not retried (the provider is stalled, not restarting), got \${made.length} attempts\`);
}

export async function check_barge_in(ctx) {
  const w = world(ctx);
  // The caller talks over the fifth token, having heard four.
  const out = await speak(ctx, w.m, async chunk => {
    if (chunk.offset === 5) await w.turnstate.bargeIn('vs-1', 4);
  });
  assert(out.ended && out.error === null, \`the turn must end normally after a barge-in, it ended with \${out.error}\`);
  assert.deepStrictEqual(out.played, [1, 2, 3, 4, 5], \`the caller barged in during offset 5 and speak went on playing \${JSON.stringify(out.played.slice(5))}: stop once recordFrame reports the turn moved on\`);
  const state = await w.turnstate.readState('vs-1');
  assert.deepStrictEqual(state, {current_speaker: 'user', turn_index: 1, tts_offset: 4}, \`after the barge-in the turn state is \${JSON.stringify(state)}, expected the caller on turn 1 at offset 4\`);
  assert.equal(out.spoken, 5, \`speak must return the offset played (5), got \${out.spoken}\`);
  assert(w.calls[0].cancelled, 'speak stopped reading but left the Synthesize stream open: cancel it, or the provider keeps synthesising (and billing) the rest of the answer');
}

export async function check_resume(ctx) {
  const w = world(ctx, 3);
  const out = await speak(ctx, w.m);
  assert(out.ended && out.error === null, \`a stream that dropped once must be resumed, the turn ended with \${out.error}\`);
  assert.deepStrictEqual(out.played, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], \`the caller was played offsets \${JSON.stringify(out.played)}: after the stream dropped at offset 3 the retry replayed what they had heard. Send resume_offset\`);
  assert.deepStrictEqual(w.resumes, [0, 3], \`the attempts asked for resume_offset \${JSON.stringify(w.resumes)}, expected 0 and then 3\`);
  assert.equal(out.spoken, TOKENS, \`speak must return the offset played (\${TOKENS}), got \${out.spoken}\`);
}

export async function check_bounded_retry(ctx) {
  const {m} = world(ctx);
  ctx.grpc.fail('Synthesize', ctx.grpc.status.INVALID_ARGUMENT, 'text too long', 1, TTS);
  let out = await speak(ctx, m);
  assert(out.ended && out.error !== null, \`INVALID_ARGUMENT must fail the turn at once, speak returned \${out.spoken}\`);
  assert.equal(calls(ctx).length, 1, \`INVALID_ARGUMENT was retried (\${calls(ctx).length} attempts): the request itself is refused, a retry fails the same way\`);
  ctx.grpc.stop(TTS);
  out = await speak(ctx, m);
  const attempts = calls(ctx).length - 1;
  assert(out.ended, \`with the TTS down the turn never ended: \${attempts} attempts and counting. Bound the attempts by MAX_ATTEMPTS\`);
  assert(out.error !== null, 'with the TTS down speak must fail the turn, it returned normally');
  assert.equal(attempts, 3, \`with the TTS down speak made \${attempts} attempts, expected MAX_ATTEMPTS (3)\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "voice/gen/speech"
	"voice/turnstate"
)

const (
	ttsTarget = "tts:9000"
	ttsTokens = 10
	ttsAnswer = "Your order ships tomorrow and arrives on Friday before noon, signed for."
)

var speechBg = context.Background()

// ttsPeer is the TTS provider: one chunk per token after resume_offset; with failAfter >= 0, its first stream fails UNAVAILABLE after that many chunks.
// With played set it streams in step with playback: each chunk after the first waits until the caller played the one before,
// or the stream is cancelled; ended then receives how its first stream ended.
type ttsPeer struct {
	pb.UnimplementedSpeechServer
	failAfter int
	resumes   []int
	played    chan struct{}
	ended     chan error
}

func (p *ttsPeer) Synthesize(req *pb.SynthesizeRequest, srv pb.Speech_SynthesizeServer) error {
	p.resumes = append(p.resumes, int(req.GetResumeOffset()))
	first := len(p.resumes) == 1
	for i, token := 0, int(req.GetResumeOffset()); token < ttsTokens; i, token = i+1, token+1 {
		if first && p.failAfter >= 0 && i == p.failAfter {
			return status.Error(codes.Unavailable, "tts node restarting")
		}
		if p.played != nil && i > 0 {
			select {
			case <-p.played:
			case <-srv.Context().Done():
				p.ended <- srv.Context().Err()
				return status.FromContextError(srv.Context().Err()).Err()
			}
		}
		if err := srv.Send(&pb.AudioChunk{Offset: int32(token + 1), Audio: []byte{byte(token)}}); err != nil {
			if p.ended != nil {
				p.ended <- err
			}
			return err
		}
	}
	if p.ended != nil {
		p.ended <- nil
	}
	return nil
}

func ttsWorld(ctx *harness.Ctx, failAfter int) *ttsPeer {
	peer := &ttsPeer{failAfter: failAfter}
	pb.RegisterSpeechServer(ctx.GRPC.Server(ttsTarget), peer)
	return peer
}

type turnOut struct {
	played []int
	spoken int
	err    error
	ended  bool
}

// speakTurn is one turn: the offsets played, what speak returned, and whether it ended at all.
func speakTurn(ctx *harness.Ctx, onPlay func(*pb.AudioChunk)) turnOut {
	out := turnOut{played: []int{}}
	out.ended = ctx.Drain(func() {
		out.spoken, out.err = speak(speechBg, "vs-1", ttsAnswer, func(chunk *pb.AudioChunk) {
			out.played = append(out.played, int(chunk.GetOffset()))
			if onPlay != nil {
				onPlay(chunk)
			}
		})
	})
	return out
}

func synthesizeCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Synthesize", ttsTarget) }

func CheckDeadline(ctx *harness.Ctx) {
	ttsWorld(ctx, -1)
	ctx.GRPC.SetLatency("Synthesize", 20.0, ttsTarget)
	out := speakTurn(ctx, nil)
	calls := synthesizeCalls(ctx)
	ctx.Assert(out.ended, "with the TTS stalled the turn never ended (%d attempts): every attempt needs a deadline", len(calls))
	ctx.Assert(len(calls) > 0 && calls[0].HasDeadline(), "the Synthesize call carries no deadline: a TTS that stops answering holds the turn open")
	ctx.Assert(9500*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 10500*time.Millisecond, "the deadline must be 10 s, got %v", calls[0].Timeout)
	ctx.Assert(out.err != nil, "a TTS that did not answer within 10 s must fail the turn; speak returned %d after playing %v", out.spoken, out.played)
	ctx.Equal(len(calls), 1, "a deadline is not retried (the provider is stalled, not restarting); the attempts")
}

func CheckBargeIn(ctx *harness.Ctx) {
	peer := ttsWorld(ctx, -1)
	peer.played = make(chan struct{}, ttsTokens)
	peer.ended = make(chan error, 1)
	out := speakTurn(ctx, func(chunk *pb.AudioChunk) {
		if chunk.GetOffset() == 5 {
			turnstate.BargeIn(speechBg, "vs-1", 4) // the caller talks over the fifth token, having heard four
		}
		peer.played <- struct{}{}
	})
	ctx.Assert(out.ended && out.err == nil, "the turn must end normally after a barge-in, it ended with %v", out.err)
	ctx.Equal(out.played, []int{1, 2, 3, 4, 5}, "the caller barged in during offset 5; speak must stop once RecordFrame reports the turn moved on; the offsets played")
	state, err := turnstate.ReadState(speechBg, "vs-1")
	ctx.NoError(err, "ReadState failed")
	ctx.Assert(state != nil && *state == turnstate.State{CurrentSpeaker: "user", TurnIndex: 1, TTSOffset: 4}, "after the barge-in the turn state is %+v, expected the caller on turn 1 at offset 4", state)
	ctx.Equal(out.spoken, 5, "speak must return the offset played")
	cancelled := false
	select {
	case streamErr := <-peer.ended:
		cancelled = streamErr != nil
	case <-time.After(5 * time.Second):
	}
	ctx.Assert(cancelled, "speak stopped reading but left the Synthesize stream open: cancel it, or the provider keeps synthesising (and billing) the rest of the answer")
}

func CheckResume(ctx *harness.Ctx) {
	peer := ttsWorld(ctx, 3)
	out := speakTurn(ctx, nil)
	ctx.Assert(out.ended && out.err == nil, "a stream that dropped once must be resumed, the turn ended with %v", out.err)
	ctx.Equal(out.played, []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, "after the stream dropped at offset 3 the retry must not replay what the caller heard (send resume_offset); the offsets played")
	ctx.Equal(peer.resumes, []int{0, 3}, "the resume_offset of each attempt")
	ctx.Equal(out.spoken, ttsTokens, "speak must return the offset played")
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	ttsWorld(ctx, -1)
	ctx.GRPC.Fail("Synthesize", codes.InvalidArgument, "text too long", 1, ttsTarget)
	out := speakTurn(ctx, nil)
	ctx.Assert(out.ended && out.err != nil, "INVALID_ARGUMENT must fail the turn at once, speak returned %d", out.spoken)
	ctx.Equal(len(synthesizeCalls(ctx)), 1, "INVALID_ARGUMENT is the request's fault and a retry fails the same way; the attempts")
	ctx.GRPC.Stop(ttsTarget)
	out = speakTurn(ctx, nil)
	attempts := len(synthesizeCalls(ctx)) - 1
	ctx.Assert(out.ended, "with the TTS down the turn never ended: %d attempts and counting. Bound the attempts by maxAttempts", attempts)
	ctx.Assert(out.err != nil, "with the TTS down speak must fail the turn, it returned nil")
	ctx.Equal(attempts, 3, "with the TTS down, the attempts (maxAttempts)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <atomic>
#include <chrono>
#include <exception>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace {

const std::string kTts = "tts:9000";
constexpr int kTokens = 10;
const std::string kAnswer = "Your order ships tomorrow and arrives on Friday before noon, signed for.";

// The TTS provider: one chunk per token after resume_offset; with fail_after >= 0, its first stream fails UNAVAILABLE after that many chunks.
// With lockstep it streams in step with playback: each chunk after the first waits until the caller played the one before, or the
// stream is cancelled; ended is then 1 for a stream that finished, 2 for one the client cancelled.
class TtsPeer final : public voice::Speech::Service {
 public:
  explicit TtsPeer(int fail_after) : fail_after_(fail_after) {}

  grpc::Status Synthesize(grpc::ServerContext* context, const voice::SynthesizeRequest* request, grpc::ServerWriter<voice::AudioChunk>* srv) override {
    resumes.push_back(request->resume_offset());
    const bool first = resumes.size() == 1;
    for (int token = request->resume_offset(), i = 0; token < kTokens; token++, i++) {
      if (first && fail_after_ >= 0 && i == fail_after_) return grpc::Status(grpc::StatusCode::UNAVAILABLE, "tts node restarting");
      for (int waited = 0; lockstep && i > 0 && played.load() < i && !context->IsCancelled() && waited < 2000; waited++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      if (context->IsCancelled()) {
        ended = 2;
        return grpc::Status::CANCELLED;
      }
      voice::AudioChunk chunk;
      chunk.set_offset(token + 1);
      chunk.set_audio(std::string(1, static_cast<char>(token)));
      if (!srv->Write(chunk)) {
        ended = 2;
        return grpc::Status::CANCELLED;
      }
    }
    ended = 1;
    return grpc::Status::OK;
  }

  std::vector<int> resumes;
  bool lockstep = false;
  std::atomic<int> played{0};
  std::atomic<int> ended{0};

 private:
  int fail_after_;
};

TtsPeer& ttsWorld(harness::Ctx& ctx, int fail_after) {
  static TtsPeer* peer = nullptr;
  delete peer;
  peer = new TtsPeer(fail_after);
  ctx.GRPC.Server(kTts)->RegisterService(peer);
  return *peer;
}

struct TurnOut {
  std::vector<int> played;
  long spoken = -1;
  std::string error;  // what speak threw, "" if it returned
  bool ended = false;
};

// One turn: the offsets played, what speak returned or threw, and whether it ended at all.
TurnOut speakTurn(harness::Ctx& ctx, const std::function<void(const voice::AudioChunk&)>& on_play = nullptr) {
  TurnOut out;
  out.ended = ctx.Drain([&] {
    try {
      out.spoken = speak("vs-1", kAnswer, [&](const voice::AudioChunk& chunk) {
        out.played.push_back(chunk.offset());
        if (on_play) on_play(chunk);
      });
    } catch (const std::exception& e) {
      out.error = e.what()[0] ? e.what() : "an exception";
    }
  });
  return out;
}

std::vector<harness::Call> synthesizeCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Synthesize", kTts); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  ttsWorld(ctx, -1);
  ctx.GRPC.SetLatency("Synthesize", 20.0, kTts);
  const auto out = speakTurn(ctx);
  const auto calls = synthesizeCalls(ctx);
  ctx.Assert(out.ended, "with the TTS stalled the turn never ended (%d attempts): every attempt needs a deadline", calls.size());
  ctx.Assert(!calls.empty() && calls[0].HasDeadline(), "the Synthesize call carries no deadline: a TTS that stops answering holds the turn open");
  ctx.Assert(9.5 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 10.5, "the deadline must be 10 s, got %vs", calls[0].TimeoutSeconds());
  ctx.Assert(!out.error.empty(), "a TTS that did not answer within 10 s must fail the turn; speak returned %d after playing %v", out.spoken, out.played);
  ctx.Equal(calls.size(), 1, "a deadline is not retried (the provider is stalled, not restarting); the attempts");
}

void CheckBargeIn(harness::Ctx& ctx) {
  auto& peer = ttsWorld(ctx, -1);
  peer.lockstep = true;
  const auto out = speakTurn(ctx, [&peer](const voice::AudioChunk& chunk) {
    if (chunk.offset() == 5) turnstate::bargeIn("vs-1", 4);  // the caller talks over the fifth token, having heard four
    peer.played++;
  });
  ctx.Assert(out.ended && out.error.empty(), "the turn must end normally after a barge-in, it threw %s", out.error);
  ctx.Equal(out.played, std::vector<int>{1, 2, 3, 4, 5}, "the caller barged in during offset 5; speak must stop once recordFrame reports the turn moved on; the offsets played");
  const auto state = turnstate::readState("vs-1");
  ctx.Assert(state && state->current_speaker == "user" && state->turn_index == 1 && state->tts_offset == 4,
             "after the barge-in the turn state is %s turn %d offset %d, expected the caller on turn 1 at offset 4",
             state ? state->current_speaker : "none", state ? state->turn_index : -1L, state ? state->tts_offset : -1L);
  ctx.Equal(out.spoken, 5, "speak must return the offset played");
  for (int waited = 0; peer.ended.load() == 0 && waited < 2000; waited++) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  ctx.Assert(peer.ended.load() == 2, "speak stopped reading but left the Synthesize stream open: cancel it, or the provider keeps synthesising (and billing) the rest of the answer");
}

void CheckResume(harness::Ctx& ctx) {
  auto& peer = ttsWorld(ctx, 3);
  const auto out = speakTurn(ctx);
  ctx.Assert(out.ended && out.error.empty(), "a stream that dropped once must be resumed, the turn threw %s", out.error);
  ctx.Equal(out.played, std::vector<int>{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, "after the stream dropped at offset 3 the retry must not replay what the caller heard (send resume_offset); the offsets played");
  ctx.Equal(peer.resumes, std::vector<int>{0, 3}, "the resume_offset of each attempt");
  ctx.Equal(out.spoken, kTokens, "speak must return the offset played");
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  ttsWorld(ctx, -1);
  ctx.GRPC.Fail("Synthesize", grpc::StatusCode::INVALID_ARGUMENT, "text too long", 1, kTts);
  auto out = speakTurn(ctx);
  ctx.Assert(out.ended && !out.error.empty(), "INVALID_ARGUMENT must fail the turn at once, speak returned %d", out.spoken);
  ctx.Equal(synthesizeCalls(ctx).size(), 1, "INVALID_ARGUMENT is the request's fault and a retry fails the same way; the attempts");
  ctx.GRPC.Stop(kTts);
  out = speakTurn(ctx);
  const size_t attempts = synthesizeCalls(ctx).size() - 1;
  ctx.Assert(out.ended, "with the TTS down the turn never ended: %d attempts and counting. Bound the attempts by kMaxAttempts", attempts);
  ctx.Assert(!out.error.empty(), "with the TTS down speak must fail the turn, it returned normally");
  ctx.Equal(attempts, 3, "with the TTS down, the attempts (kMaxAttempts)");
}
`,
  },
  hints: [
    'A caller says "stop" and the agent keeps talking; when a TTS node restarts mid-answer the caller hears the first words twice; with the TTS down the turn never ends.',
    "The call has no deadline, `record_frame`'s answer is thrown away, each retry builds a request without `resume_offset` and resets the offset to zero, and the `while True` catches every status with no bound.",
    'Pass `timeout=SYNTHESIZE_DEADLINE_S`; when `record_frame` is false, cancel the call and return; send `resume_offset=delivered`; loop `MAX_ATTEMPTS` times, re-raising anything but `UNAVAILABLE`, then raise.',
  ],
  debrief: `A gRPC deadline bounds a whole stream, and that is the right bound here: synthesis runs ahead of playback, so ten seconds without the end of an answer means a provider that will not finish. The barge-in signal comes from the frame write itself, the one place that already knows whether the turn moved on; a separate flag check would leave a window between the check and the write. Cancelling matters as much as stopping, because an unread stream is still synthesised and billed. The resume offset turns a retry into a continuation, and only UNAVAILABLE earns one: a refused request fails the same way every time. Production clients back off between attempts, hedge a slow first chunk against a second region, and cache short phrases the agent repeats.`,
};
