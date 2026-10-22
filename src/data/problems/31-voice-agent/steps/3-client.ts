import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'STT and TTS calls with cancellation and no replay',
  concept: 'grpc',
  file: 'client',
  focus: ['gateway', 'asr', 'tts'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it opens the TTS stream and plays the audio, so the demo speaks. It hides an unbounded retry and a replay bug. Find them, fix them, and prove the fix.

Implement the speech client the gateway uses for one turn.

- \`Recognize\` (ASR) and \`Synthesize\` (TTS) are streaming RPCs run under a **10-second idle deadline** per call: a stream that produces nothing for ten seconds is dead and must be abandoned.
- Cancelling a stream must actually cancel it — \`cancel()\` / \`Cancel()\` / \`TryCancel()\` on the client side — and the resulting \`CANCELLED\` status is a normal stop, never an error to retry, so the provider stops billing for audio nobody will hear.
- Starting a new stream cancels the previous one **first**: the order matters, one session must never keep two synthesizers alive.
- When TTS fails **after** audio has been delivered, the retry resumes at the delivered token offset (\`resume_offset = delivered_tokens\`); it must never replay from zero, and if the server cannot resume, the client surfaces a clean error instead of replaying the first sentence.
- Retries are bounded (\`MAX_ATTEMPTS\`) and only on \`UNAVAILABLE\`.

**Failure mode the checks target.** A retry that restarts the stream at offset zero re-plays and re-bills audio the caller already heard; a retry loop with no bound turns one provider outage into a hot loop; and leaving the old stream running when a new one starts bills twice and can interleave two answers.`,
  sequence: {
    participants: ['Voice Gateway', 'ASR', 'TTS'],
    messages: [
      {from: 'Voice Gateway', to: 'ASR', label: 'Recognize(stream) · deadline 10s', kind: 'sync'},
      {from: 'ASR', to: 'Voice Gateway', label: 'partial transcripts', kind: 'reply'},
      {from: 'Voice Gateway', to: 'TTS', label: 'Synthesize(text, resume_offset=delivered_tokens)', kind: 'sync'},
      {from: 'TTS', to: 'Voice Gateway', label: 'audio chunks [0..delivered_tokens]', kind: 'reply'},
      {from: 'Voice Gateway', to: 'TTS', label: 'cancel() on barge-in · CANCELLED', kind: 'async'},
      {from: 'Voice Gateway', to: 'TTS', label: 'resume at resume_offset after UNAVAILABLE', kind: 'sync'},
    ],
  },
  hints: [
    'the deadline belongs on the call context (`timeout=` / `deadline` / `context.WithTimeout`), not on the socket: `UNAVAILABLE` and `DEADLINE_EXCEEDED` are the only statuses worth retrying, and a bound like `MAX_ATTEMPTS` stops the hot loop.',
    '`resume_offset` is the number of tokens already delivered to the caller; the request carries it, so the server continues instead of restarting. Offset zero means the retry replays the whole sentence.',
    'cancel before you start: keep a handle on the live stream, cancel it (and swallow `CANCELLED`) before opening the new one, so a barge-in cannot leave two synthesizers speaking.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every speech call runs under a 10-second idle deadline',
      detail:
        'The ASR and TTS calls carry a 10-second idle deadline on their context (`timeout=` / `deadline` / `context.WithTimeout`). The draft has no deadline, so a silent stream hangs a session forever.',
      match: {
        python: {all: [/IDLE_DEADLINE_S/, /timeout=/]},
        typescript: {all: [/IDLE_DEADLINE_S/, /deadline/]},
        go: {all: [/idleDeadline/, /context\.WithTimeout/]},
        scala: {all: [/IdleDeadline/, /deadline/]},
        cpp: {all: [/kIdleDeadline/, /deadline/]},
      },
    },
    {
      id: 'cancel',
      title: 'Cancelling a stream stops the work and the billing',
      detail:
        'A cancelled stream is really cancelled (`cancel()` / `Cancel()` / `TryCancel()`) and the `CANCELLED` status is handled as a normal stop. The draft drops the handle and lets the provider keep synthesising audio nobody will hear.',
      match: {
        python: {all: [/cancel\(\)/, /CancelledError/]},
        typescript: {all: [/cancel\(\)/, /CANCELLED/]},
        go: {all: [/Cancel\(\)/, /codes\.Canceled/]},
        scala: {all: [/cancel\(\)/, /CANCELLED/]},
        cpp: {all: [/TryCancel\(\)/, /CANCELLED/]},
      },
    },
    {
      id: 'resume',
      title: 'A retried TTS resumes at the delivered token offset',
      detail:
        'The retry request carries `resume_offset` (`resumeOffset` / `ResumeOffset`) set to the tokens already delivered, so the server continues instead of replaying. The draft re-sends the request from offset zero and the caller hears the first sentence twice.',
      match: {
        python: {all: [/resume_offset/, /delivered_tokens/]},
        typescript: {all: [/resumeOffset/, /deliveredTokens/]},
        go: {all: [/ResumeOffset/, /DeliveredTokens/]},
        scala: {all: [/resumeOffset/, /deliveredTokens/]},
        cpp: {all: [/resume_offset/, /delivered_tokens/]},
      },
    },
    {
      id: 'single-stream',
      title: 'A new stream cancels the previous one first',
      detail:
        'In the source, the cancellation of the live stream comes before the new `Synthesize` call, so one session never has two synthesizers. The draft starts the new stream and leaves the old one running.',
      match: {
        python: {order: [/\.cancel\(\)/, /\.Synthesize\(/]},
        typescript: {order: [/\.cancel\(\)/, /\.synthesize\(/]},
        go: {order: [/\.Cancel\(\)/, /\.Synthesize\(/]},
        scala: {order: [/\.cancel\(\)/, /\.synthesize\(/]},
        cpp: {order: [/TryCancel\(\)/, /Synthesize\(/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries are bounded and status-filtered',
      detail:
        'Retries stop after `MAX_ATTEMPTS` (`maxAttempts` / `MaxAttempts` / `kMaxAttempts`) and only `UNAVAILABLE`/`Unavailable` is retried; `INVALID_ARGUMENT` fails immediately. The draft catches every error and loops forever.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /UNAVAILABLE/]},
        typescript: {all: [/MAX_ATTEMPTS/, /UNAVAILABLE/]},
        go: {all: [/maxAttempts/, /codes\.Unavailable/]},
        scala: {all: [/MaxAttempts/, /UNAVAILABLE/]},
        cpp: {all: [/kMaxAttempts/, /UNAVAILABLE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import speech_pb2
import speech_pb2_grpc

channel = grpc.aio.insecure_channel("speech:9000")
tts = speech_pb2_grpc.TtsStub(channel)
asr = speech_pb2_grpc.AsrStub(channel)


class SpeechClient:
    def __init__(self) -> None:
        self._stream = None

    async def recognize(self, audio_frames):
        call = asr.Recognize(audio_frames)
        async for partial in call:
            yield partial

    async def synthesize(self, text: str):
        # TODO: every retry restarts the stream at the beginning, so the caller hears the first
        # sentence twice, and this retry loop has no bound, so one provider outage turns into a hot
        # loop. Add the 10-second idle deadline, cancel the live stream before opening the new one,
        # and resume at the delivered token offset.
        while True:
            try:
                call = tts.Synthesize(speech_pb2.SynthesizeRequest(text=text))
                self._stream = call
                async for chunk in call:
                    yield chunk.audio
                return
            except grpc.aio.AioRpcError:
                continue
`,
      solution: `import asyncio

import grpc

import speech_pb2
import speech_pb2_grpc

IDLE_DEADLINE_S = 10
MAX_ATTEMPTS = 3

channel = grpc.aio.insecure_channel("speech:9000")
tts = speech_pb2_grpc.TtsStub(channel)
asr = speech_pb2_grpc.AsrStub(channel)


class SpeechClient:
    """The gateway's speech client for one turn: both streams live under the idle deadline."""

    def __init__(self) -> None:
        self._stream = None
        self._delivered_tokens = 0

    async def recognize(self, audio_frames):
        call = asr.Recognize(audio_frames, timeout=IDLE_DEADLINE_S)
        try:
            async for partial in call:
                yield partial
        except grpc.aio.AioRpcError as exc:
            if exc.code() == grpc.StatusCode.CANCELLED:
                return
            raise

    async def synthesize(self, text: str):
        # Cancel before you start: a barge-in must leave exactly one synthesizer alive.
        if self._stream is not None:
            try:
                self._stream.cancel()
            except (grpc.FutureCancelledError, asyncio.CancelledError):
                pass
            self._stream = None

        delivered_tokens = self._delivered_tokens
        last_error: grpc.aio.AioRpcError | None = None
        for _ in range(MAX_ATTEMPTS):
            call = tts.Synthesize(
                speech_pb2.SynthesizeRequest(text=text, resume_offset=delivered_tokens),
                timeout=IDLE_DEADLINE_S,
            )
            self._stream = call
            try:
                async for chunk in call:
                    delivered_tokens += chunk.tokens
                    self._delivered_tokens = delivered_tokens
                    yield chunk.audio
                self._stream = None
                return
            except grpc.aio.AioRpcError as exc:
                self._stream = None
                if exc.code() == grpc.StatusCode.CANCELLED:
                    return
                last_error = exc
                if exc.code() != grpc.StatusCode.UNAVAILABLE:
                    raise
        if last_error is not None:
            raise last_error
`,
    },
    typescript: {
      starter: `/** Speech client: a model-generated draft that replays and retries forever. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface SynthesizeRequest {
  text: string;
}

interface AudioChunk {
  tokens: number;
  audio: Buffer;
}

interface TtsClient {
  synthesize(
    request: SynthesizeRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<AudioChunk>;
}

const {speech} = grpc.loadPackageDefinition(protoLoader.loadSync('speech.proto')) as unknown as {
  speech: {Tts: new (target: string, credentials: grpc.ChannelCredentials) => TtsClient};
};
const tts = new speech.Tts('speech:9000', grpc.credentials.createInsecure());

export class SpeechClient {
  private stream: grpc.ClientReadableStream<AudioChunk> | null = null;

  async *synthesize(text: string): AsyncGenerator<AudioChunk> {
    // TODO: every retry restarts the stream at offset zero, so the caller hears the first sentence
    // twice, and the loop has no bound, so one provider outage turns into a hot loop. Add the
    // 10-second idle deadline, cancel the live stream before opening the new one, and resume at
    // the delivered token offset.
    for (;;) {
      try {
        const call = this.tts.synthesize({text}, new grpc.Metadata(), {});
        this.stream = call;
        for await (const chunk of call) {
          yield chunk;
        }
        return;
      } catch {
        continue;
      }
    }
  }
}
`,
      solution: `/** Speech client: 10 s idle deadline, cancel-before-start, resume at the delivered offset. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const IDLE_DEADLINE_S = 10;
const MAX_ATTEMPTS = 3;

interface SynthesizeRequest {
  text: string;
  resumeOffset: number;
}

interface AudioChunk {
  tokens: number;
  audio: Buffer;
}

interface TtsClient {
  synthesize(
    request: SynthesizeRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<AudioChunk>;
}

const {speech} = grpc.loadPackageDefinition(protoLoader.loadSync('speech.proto')) as unknown as {
  speech: {Tts: new (target: string, credentials: grpc.ChannelCredentials) => TtsClient};
};
const tts = new speech.Tts('speech:9000', grpc.credentials.createInsecure());

export class SpeechClient {
  private stream: grpc.ClientReadableStream<AudioChunk> | null = null;
  private deliveredTokens = 0;

  async *synthesize(text: string): AsyncGenerator<AudioChunk> {
    // Cancel before you start: a barge-in must leave exactly one synthesizer alive.
    if (this.stream !== null) {
      this.stream.cancel();
      this.stream = null;
    }

    let deliveredTokens = this.deliveredTokens;
    let lastError: grpc.ServiceError | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const call = this.tts.synthesize(
        {text, resumeOffset: deliveredTokens},
        new grpc.Metadata(),
        {deadline: Date.now() + IDLE_DEADLINE_S * 1_000},
      );
      this.stream = call;
      try {
        for await (const chunk of call) {
          deliveredTokens += chunk.tokens;
          this.deliveredTokens = deliveredTokens;
          yield chunk;
        }
        this.stream = null;
        return;
      } catch (error) {
        this.stream = null;
        const serviceError = error as grpc.ServiceError;
        if (serviceError.code === grpc.status.CANCELLED) return; // barge-in: a normal stop
        lastError = serviceError;
        if (serviceError.code !== grpc.status.UNAVAILABLE) throw serviceError;
      }
    }
    if (lastError !== null) throw lastError;
  }
}
`,
    },
    go: {
      starter: `// Speech client: a model-generated draft that replays and retries forever.
package main

import (
	"context"
	"io"

	pb "gateway/speechpb"
)

type SpeechClient struct {
	tts    pb.TtsClient
	stream pb.Tts_SynthesizeClient
}

func (c *SpeechClient) Synthesize(ctx context.Context, text string, audio chan<- []byte) error {
	// TODO: every retry restarts the stream at offset zero, so the caller hears the first sentence
	// twice, and the loop has no bound, so one provider outage turns into a hot loop. Add the
	// 10-second idle deadline, cancel the live stream before opening the new one, and resume at
	// the delivered token offset.
	for {
		stream, err := c.tts.Synthesize(ctx, &pb.SynthesizeRequest{Text: text})
		if err != nil {
			continue
		}
		c.stream = stream
		for {
			chunk, err := stream.Recv()
			if err == io.EOF {
				return nil
			}
			if err != nil {
				break
			}
			audio <- chunk.Audio
		}
	}
}
`,
      solution: `// Speech client: 10 s idle deadline, cancel-before-start, resume at the delivered offset.
package main

import (
	"context"
	"errors"
	"io"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "gateway/speechpb"
)

const (
	idleDeadline = 10 * time.Second
	maxAttempts  = 3
)

type SpeechClient struct {
	tts        pb.TtsClient
	stream     pb.Tts_SynthesizeClient
	streamStop context.CancelFunc
	delivered  int32
}

func (c *SpeechClient) stopStream() {
	if c.streamStop != nil {
		c.streamStop()
		c.streamStop = nil
	}
	c.stream = nil
}

func (c *SpeechClient) Synthesize(ctx context.Context, text string, audio chan<- []byte) error {
	// Cancel before you start: a barge-in must leave exactly one synthesizer alive.
	if c.stream != nil {
		c.stream.Cancel()
		c.stopStream()
	}

	DeliveredTokens := c.delivered
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, idleDeadline)
		stream, err := c.tts.Synthesize(callCtx, &pb.SynthesizeRequest{Text: text, ResumeOffset: DeliveredTokens})
		if err != nil {
			cancel()
			lastErr = err
			if status.Code(err) != codes.Unavailable {
				return err
			}
			continue
		}
		c.stream = stream
		c.streamStop = cancel
		delivered := false
		for {
			chunk, err := stream.Recv()
			if errors.Is(err, io.EOF) {
				c.stopStream()
				c.delivered = DeliveredTokens
				return nil
			}
			if err != nil {
				c.stopStream()
				if status.Code(err) == codes.Canceled {
					return nil // barge-in: a normal stop
				}
				lastErr = err
				if status.Code(err) != codes.Unavailable {
					return err
				}
				break
			}
			delivered = true
			DeliveredTokens += chunk.Tokens
			audio <- chunk.Audio
		}
		_ = delivered
	}
	return lastErr
}
`,
    },
    scala: {
      starter: `// Speech client: a model-generated draft that replays and retries forever.
import io.grpc.ManagedChannelBuilder

object SpeechClient {
  val channel = ManagedChannelBuilder.forAddress("speech", 9000).usePlaintext().build()
  val tts = TtsGrpc.blockingStub(channel)

  def synthesize(text: String, deliveredTokens: Int): Iterator[AudioChunk] = {
    // TODO: every retry restarts the stream at offset zero, so the caller hears the first sentence
    // twice, and the loop has no bound, so one provider outage turns into a hot loop. Add the
    // 10-second idle deadline, cancel the live stream before opening the new one, and resume at
    // the delivered token offset.
    var done = false
    var chunks: Iterator[AudioChunk] = Iterator.empty
    while (!done) {
      try {
        chunks = tts.synthesize(SynthesizeRequest(text = text))
        done = true
      } catch {
        case _: Throwable => ()
      }
    }
    chunks
  }
}
`,
      solution: `// Speech client: 10 s idle deadline, cancel-before-start, resume at the delivered offset.
import java.util.concurrent.TimeUnit

import io.grpc.{Context, ManagedChannelBuilder, Status, StatusRuntimeException}

object SpeechClient {
  val IdleDeadline = 10L
  val MaxAttempts = 3

  val channel = ManagedChannelBuilder.forAddress("speech", 9000).usePlaintext().build()
  val tts = TtsGrpc.blockingStub(channel)

  private var live: Option[Context.CancellableContext] = None

  private def deadline: Long = IdleDeadline

  def stopLive(): Unit = {
    live.foreach { context =>
      try context.cancel()
      catch { case _: StatusRuntimeException => () }
    }
    live = None
  }

  def synthesize(text: String, deliveredTokens: Int): Iterator[AudioChunk] = {
    // Cancel before you start: a barge-in must leave exactly one synthesizer alive.
    stopLive()

    var delivered = deliveredTokens
    var attempt = 0
    var lastError: Option[StatusRuntimeException] = None
    while (attempt < MaxAttempts) {
      val context = Context.current().withCancellation()
      live = Some(context)
      try {
        val chunks = tts
          .withDeadlineAfter(deadline, TimeUnit.SECONDS)
          .synthesize(SynthesizeRequest(text = text, resumeOffset = delivered))
        return chunks.map { chunk =>
          delivered += chunk.tokens
          chunk
        }
      } catch {
        case exc: StatusRuntimeException =>
          live = None
          if (exc.getStatus.getCode == Status.CANCELLED) return Iterator.empty
          lastError = Some(exc)
          if (exc.getStatus.getCode != Status.UNAVAILABLE) throw exc
      }
      attempt += 1
    }
    throw lastError.getOrElse(new RuntimeException("speech unavailable"))
  }
}
`,
    },
    cpp: {
      starter: `// Speech client: a model-generated draft that replays and retries forever.
#include <grpcpp/grpcpp.h>

#include "speech.grpc.pb.h"

#include <functional>
#include <string>

std::unique_ptr<Tts::Stub> tts;

void synthesize(const std::string& text, const std::function<void(const std::string&)>& on_audio) {
  // TODO: every retry restarts the stream at offset zero, so the caller hears the first sentence
  // twice, and the loop has no bound, so one provider outage turns into a hot loop. Add the
  // 10-second idle deadline, cancel the live stream before opening the new one, and resume at
  // the delivered token offset.
  while (true) {
    grpc::ClientContext ctx;
    SynthesizeRequest request;
    request.set_text(text);
    auto reader = tts->Synthesize(&ctx, request);
    AudioChunk chunk;
    while (reader->Read(&chunk)) {
      on_audio(chunk.audio());
    }
    if (reader->Finish().ok()) return;
  }
}
`,
      solution: `// Speech client: 10 s idle deadline, cancel-before-start, resume at the delivered offset.
#include <grpcpp/grpcpp.h>

#include "speech.grpc.pb.h"

#include <chrono>
#include <functional>
#include <memory>
#include <string>

constexpr int kIdleDeadline = 10;
constexpr int kMaxAttempts = 3;

std::unique_ptr<Tts::Stub> tts;

class SpeechClient {
 public:
  void stop_stream() {
    if (stream_ != nullptr) {
      stream_->TryCancel();  // a barge-in: the provider must stop billing for unheard audio
    }
    stream_ = nullptr;
  }

  bool synthesize(const std::string& text, int delivered_tokens,
                  const std::function<void(const AudioChunk&)>& on_audio) {
    // Cancel before you start: a barge-in must leave exactly one synthesizer alive.
    stop_stream();

    for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
      context_ = std::make_shared<grpc::ClientContext>();
      context_->set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kIdleDeadline));
      SynthesizeRequest request;
      request.set_text(text);
      request.set_resume_offset(delivered_tokens);
      auto reader = tts->Synthesize(context_.get(), request);
      AudioChunk chunk;
      while (reader->Read(&chunk)) {
        delivered_tokens += chunk.tokens();
        on_audio(chunk);
      }
      const grpc::Status status = reader->Finish();
      context_ = nullptr;
      if (status.ok()) return true;
      if (status.error_code() == grpc::StatusCode::CANCELLED) return false;
      if (status.error_code() != grpc::StatusCode::UNAVAILABLE) return false;
    }
    return false;
  }

 private:
  std::shared_ptr<grpc::ClientContext> context_;
  grpc::ClientReader<AudioChunk>* stream_ = nullptr;
};
`,
    },
  },
  debrief: `A streaming speech call is not a request you can retry for free: the client owns a session that keeps generating audio after the caller stopped listening, so two contracts have to be explicit. The idle deadline belongs on the call, because a stream that has gone silent is dead even though the socket is open — ten seconds without a chunk is the line between "the model is thinking" and "nobody will ever hear this answer", and without it one stuck provider pins a live call until the caller hangs up. Cancellation has to be real too: a handle that is dropped instead of cancelled leaves the provider synthesising, and because the new stream must cancel the old one before it opens, a barge-in can otherwise leave two synthesizers talking over each other and billing twice. Resuming at the delivered offset is what separates a retry from a replay: the offset is the tokens the caller already heard, so a retry after UNAVAILABLE continues the sentence, while a retry from zero re-plays and re-bills it — and a server that cannot resume must fail cleanly instead of falling back to the start. Production adds provider-side session ids that survive reconnects, usage reconciliation for the audio that was delivered before a failure, and jittered backoff so a provider outage does not become a hot loop.`,
};
