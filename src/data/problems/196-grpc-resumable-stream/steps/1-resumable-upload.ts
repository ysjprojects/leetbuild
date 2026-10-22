import type {Step} from '@/lib/types';

export const resumableUploadStep: Step = {
  id: 'resumable-upload',
  title: 'upload(): resume from the committed point, back off, give up',
  concept: 'grpc',
  file: 'uploader',
  focus: ['uploader', 'ingest'],
  task: `## Task

The ingest service, in \`ingest.proto\` (package \`ingest.v1\`):

\`\`\`proto
service Ingest {
  rpc Upload(stream Chunk) returns (stream Ack);
  rpc GetStatus(StatusRequest) returns (StatusResponse);
}
message Chunk          { string upload_id = 1; int32 seq = 2; bytes data = 3; }
message Ack            { int32 seq = 1; }      // highest contiguous committed seq
message StatusRequest  { string upload_id = 1; }
message StatusResponse { int32 next_seq = 1; } // 0 for a new upload
\`\`\`

Implement \`upload\` in \`uploader\`. It returns the number of attempts it used.

- Python: \`async def upload(stub, upload_id: str, chunks: list[bytes], max_attempts: int = 4) -> int\`
- TypeScript: \`export async function upload(client, uploadId, chunks: Buffer[], maxAttempts = 4): Promise<number>\`

Each attempt:

1. Call \`GetStatus\` for \`next_seq\`. If \`next_seq == len(chunks)\`, the server has every chunk: return
   without opening \`Upload\`.
2. Open \`Upload\` and send \`Chunk{upload_id, seq: i, data: chunks[i]}\` for every \`i >= next_seq\`, in
   order. Never a seq below \`next_seq\`, never a skipped one.
3. Finish on \`Ack{seq: len(chunks) - 1}\`: close the send side and return.

When the stream fails:

- \`UNAVAILABLE\` or \`ABORTED\`: wait \`0.1 × 2^(attempt - 1)\` s (0.1, 0.2, 0.4), then start the next
  attempt at step 1. After \`max_attempts\` attempts, raise the last error at once, with no wait.
- Any other status (\`INVALID_ARGUMENT\`, \`PERMISSION_DENIED\`, …) raises at once.
- Raise the gRPC error itself: \`grpc.RpcError\` in Python, the \`ServiceError\` in TypeScript.

A stream can die after the server committed a chunk and before its \`Ack\` reached you. The server
ignores a seq below its committed point and rejects one above it with \`FAILED_PRECONDITION\`.

:::widget grpc-streams {"mode": "bidi"}

> Your last \`Ack\` is a lower bound on what the server holds. \`GetStatus\` is the committed point
> itself: resume from it, never from your own count and never from 0.`,
  sequence: {
    participants: ['uploader', 'Ingest'],
    messages: [
      {from: 'uploader', to: 'Ingest', label: 'GetStatus(up-1)', kind: 'sync'},
      {from: 'Ingest', to: 'uploader', label: 'next_seq 0', kind: 'reply'},
      {from: 'uploader', to: 'Ingest', label: 'Upload: Chunk 0 … 7', kind: 'async'},
      {from: 'Ingest', to: 'uploader', label: 'Ack 0 … Ack 3', kind: 'reply'},
      {from: 'Ingest', to: 'uploader', label: 'UNAVAILABLE (4 committed, Ack lost)', kind: 'reply'},
      {from: 'uploader', to: 'uploader', label: 'sleep 0.1 s', kind: 'sync'},
      {from: 'uploader', to: 'Ingest', label: 'GetStatus(up-1)', kind: 'sync'},
      {from: 'Ingest', to: 'uploader', label: 'next_seq 5', kind: 'reply'},
      {from: 'uploader', to: 'Ingest', label: 'Upload: Chunk 5 … 7', kind: 'async'},
      {from: 'Ingest', to: 'uploader', label: 'Ack 5 … Ack 7', kind: 'reply'},
      {from: 'uploader', to: 'Ingest', label: 'close send · return 2', kind: 'async'},
    ],
  },
  hints: [
    'Start every attempt with `GetStatus`: its `next_seq` is where this attempt begins, whatever the last stream acked. If it equals `len(chunks)`, the attempt is already a success.',
    'Python: pass an async generator of `Chunk`s to `stub.Upload(...)` (it is the send side and closes when exhausted) and `async for ack in call` until `ack.seq == len(chunks) - 1`. TypeScript: `call.write` each chunk, resolve on the last `data` after `call.end()`, reject on `error`. The stream error surfaces on the read side.',
    'Loop `attempt` from 1 to `max_attempts`; catch the gRPC error around one attempt. Re-raise unless the code is `UNAVAILABLE` or `ABORTED` and `attempt < max_attempts`; otherwise sleep `0.1 * 2 ** (attempt - 1)` and go round. Return `attempt` on success.',
  ],
  checks: [
    {
      id: 'clean-upload',
      title: 'A clean upload sends each chunk once, in order',
      detail:
        'One `GetStatus`, one `Upload` stream carrying seqs 0 to 7, each with `upload_id` `up-1` and its own bytes. The server is slow to commit seq 7: `upload` returns only after `Ack{seq: 7}`, not after the last write, and with its send side closed.',
      match: {
        python: {all: [/stub\.Upload\(/, /Chunk\(/]},
        typescript: {all: [/\.Upload\(/, /\.write\(\s*\{/]},
        go: {all: [/\.Upload\(ctx\)/, /\.Send\(&pb\.Chunk\{/]},
        scala: {all: [/\.upload\(/, /onNext\(\s*Chunk\(/]},
        cpp: {all: [/\bUpload\(&\w+\)/, /->Write\(/]},
      },
    },
    {
      id: 'resume-from-status',
      title: 'A retry resumes from GetStatus.next_seq',
      detail:
        'A server already at `next_seq` 3 gets 3 to 7. After UNAVAILABLE with 0 to 4 committed and the Ack for 4 lost, the next stream carries exactly 5, 6, 7: not 4 (the last Ack said 3), not 0. With all 8 committed and the final Ack lost, no second stream opens.',
      match: {
        python: {all: [/\.GetStatus\(/, /\.next_seq\b/]},
        typescript: {all: [/\.GetStatus\(/, /\bnext_seq\b/]},
        go: {all: [/\.GetStatus\(/, /GetNextSeq\(\)|\.NextSeq\b/]},
        scala: {all: [/\.getStatus\(/, /\.nextSeq\b/]},
        cpp: {all: [/\bGetStatus\(&/, /\.next_seq\(\)/]},
      },
    },
    {
      id: 'backoff',
      title: 'Backs off 0.1, 0.2, 0.4 s between attempts',
      detail:
        'Three streams fail (UNAVAILABLE, ABORTED, UNAVAILABLE) and the fourth succeeds: the four `GetStatus` calls land at 0, 0.1, 0.3 and 0.7 s on the virtual clock.',
      match: {
        python: {all: [/asyncio\.sleep\(/, /2\s*\*\*|<<\s*\(?attempt|pow\(\s*2/]},
        typescript: {all: [/setTimeout\(/, /2\s*\*\*|Math\.pow\(\s*2|<<\s*\(?attempt/]},
        go: {all: [/time\.(Sleep|After|NewTimer)\(/, /<<\s*\(?attempt|math\.Pow\(\s*2/]},
        scala: {all: [/Thread\.sleep\(|TimeUnit\.\w+\.sleep\(/, /<<\s*\(?attempt|math\.pow\(\s*2|Math\.pow\(\s*2/]},
        cpp: {all: [/sleep_for\(/, /<<\s*\(?attempt|std::pow\(\s*2/]},
      },
    },
    {
      id: 'gives-up',
      title: 'Gives up after max_attempts with the last error',
      detail:
        "A server that drops every stream with UNAVAILABLE: with `max_attempts` 3, three streams, then the third stream's error (details intact), raised with no further wait. With the default, four streams.",
      match: {
        python: {all: [/(==|>=|<|<=)\s*max_attempts|range\([^)\n]*max_attempts/, /\braise\b/]},
        typescript: {all: [/attempt\s*(>=|===|==|<|<=)\s*maxAttempts/, /\bthrow\b/]},
        go: {all: [/attempt\s*(>=|==|<|<=)\s*maxAttempts/, /return attempt, err\b/]},
        scala: {all: [/attempt\s*(>=|==|<|<=)\s*maxAttempts/, /\bthrow\b/]},
        cpp: {all: [/attempt\s*(>=|==|<|<=)\s*max_attempts/, /\bthrow\b/]},
      },
    },
    {
      id: 'other-codes',
      title: 'Other codes are raised at once',
      detail:
        'A stream that ends with `INVALID_ARGUMENT`, or with `PERMISSION_DENIED`, ends the upload after one `GetStatus` and one stream, with no wait. Only `UNAVAILABLE` and `ABORTED` are retried.',
      match: {
        python: {all: [/StatusCode\.UNAVAILABLE/, /StatusCode\.ABORTED/, /\.code\(\)/]},
        typescript: {all: [/status\.UNAVAILABLE/, /status\.ABORTED/, /\.code\b|\{\s*code\s*\}/]},
        go: {all: [/codes\.Unavailable/, /codes\.Aborted/, /status\.Code\(/]},
        scala: {all: [/Code\.UNAVAILABLE/, /Code\.ABORTED/, /getCode\b/]},
        cpp: {all: [/StatusCode::UNAVAILABLE/, /StatusCode::ABORTED/, /error_code\(\)/]},
      },
    },
    {
      id: 'returns-attempts',
      title: 'Returns the attempts it used',
      detail:
        '1 for a clean upload, 2 after one ABORTED stream, 2 when the second attempt finds every chunk committed, 3 when the third of `max_attempts` 3 succeeds.',
      match: {
        python: {all: [/return attempt\b/]},
        typescript: {all: [/return attempt\b/]},
        go: {all: [/return attempt, nil\b/]},
        scala: {all: [/\)\s*attempt\s*$|=>\s*attempt\s*$|return attempt\b/m]},
        cpp: {all: [/return attempt;/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio

import grpc

import ingest_pb2

BASE_BACKOFF_S = 0.1


async def upload(stub, upload_id: str, chunks: list[bytes], max_attempts: int = 4) -> int:
    # TODO: per attempt, stub.GetStatus for next_seq; nothing left to send means done
    # TODO: stream ingest_pb2.Chunk(upload_id, seq, data) for every seq from next_seq on, and
    #       return the attempt number once the Ack for the last seq arrives
    # TODO: UNAVAILABLE / ABORTED: sleep BASE_BACKOFF_S * 2 ** (attempt - 1) and retry, up to
    #       max_attempts; any other code, or the last attempt, raises
    raise NotImplementedError
`,
      solution: `import asyncio

import grpc

import ingest_pb2

BASE_BACKOFF_S = 0.1
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.ABORTED)


async def _chunks_from(upload_id: str, chunks: list[bytes], next_seq: int):
    """The send side of one stream: every chunk from next_seq on, in order. It closes when exhausted."""
    for seq in range(next_seq, len(chunks)):
        yield ingest_pb2.Chunk(upload_id=upload_id, seq=seq, data=chunks[seq])


async def upload(stub, upload_id: str, chunks: list[bytes], max_attempts: int = 4) -> int:
    last = len(chunks) - 1
    for attempt in range(1, max_attempts + 1):
        status = await stub.GetStatus(ingest_pb2.StatusRequest(upload_id=upload_id))
        if status.next_seq > last:
            return attempt  # everything is committed; only the final ack was lost
        try:
            call = stub.Upload(_chunks_from(upload_id, chunks, status.next_seq))
            async for ack in call:
                if ack.seq == last:
                    return attempt
            raise RuntimeError("the stream ended before the last chunk was acked")
        except grpc.RpcError as e:
            if e.code() not in RETRYABLE or attempt >= max_attempts:
                raise
            await asyncio.sleep(BASE_BACKOFF_S * 2 ** (attempt - 1))
    raise ValueError("max_attempts must be at least 1")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';

export interface Chunk {
  upload_id: string;
  seq: number;
  data: Buffer;
}
export interface Ack {
  seq: number;
}
export interface UploadCall {
  write(chunk: Chunk): boolean;
  end(): void;
  on(event: 'data', listener: (ack: Ack) => void): UploadCall;
  on(event: 'error', listener: (error: grpc.ServiceError) => void): UploadCall;
  on(event: 'end', listener: () => void): UploadCall;
}
export interface IngestClient {
  GetStatus(request: {upload_id: string}): Promise<{next_seq: number}>;
  Upload(): UploadCall;
}

export const BASE_BACKOFF_MS = 100;

export async function upload(client: IngestClient, uploadId: string, chunks: Buffer[], maxAttempts = 4): Promise<number> {
  // TODO: per attempt, client.GetStatus for next_seq; nothing left to send means done
  // TODO: client.Upload(), write {upload_id, seq, data} for every seq from next_seq on, and
  //       resolve with the attempt number on the Ack for the last seq
  // TODO: UNAVAILABLE / ABORTED: wait BASE_BACKOFF_MS * 2 ** (attempt - 1) and retry, up to
  //       maxAttempts; any other code, or the last attempt, rejects
  throw new Error('not implemented');
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';

export interface Chunk {
  upload_id: string;
  seq: number;
  data: Buffer;
}
export interface Ack {
  seq: number;
}
export interface UploadCall {
  write(chunk: Chunk): boolean;
  end(): void;
  on(event: 'data', listener: (ack: Ack) => void): UploadCall;
  on(event: 'error', listener: (error: grpc.ServiceError) => void): UploadCall;
  on(event: 'end', listener: () => void): UploadCall;
}
export interface IngestClient {
  GetStatus(request: {upload_id: string}): Promise<{next_seq: number}>;
  Upload(): UploadCall;
}

export const BASE_BACKOFF_MS = 100;
const RETRYABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.ABORTED]);

/** One stream: every chunk from \`from\` on; resolves on the Ack for the last one, rejects with the stream's error. */
function send(client: IngestClient, uploadId: string, chunks: Buffer[], from: number): Promise<void> {
  const last = chunks.length - 1;
  const {promise, resolve, reject} = Promise.withResolvers<void>();
  const call = client.Upload();
  call.on('data', ack => {
    if (ack.seq !== last) return;
    call.end();
    resolve();
  });
  call.on('error', reject);
  call.on('end', () => reject(new Error('the stream ended before the last chunk was acked')));
  for (let seq = from; seq <= last; seq++) call.write({upload_id: uploadId, seq, data: chunks[seq]});
  return promise;
}

export async function upload(client: IngestClient, uploadId: string, chunks: Buffer[], maxAttempts = 4): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    const {next_seq} = await client.GetStatus({upload_id: uploadId});
    if (next_seq >= chunks.length) return attempt; // everything is committed; only the final ack was lost
    try {
      await send(client, uploadId, chunks, next_seq);
      return attempt;
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (!RETRYABLE.has(code) || attempt >= maxAttempts) throw e;
      const backoff = Promise.withResolvers<void>();
      setTimeout(backoff.resolve, BASE_BACKOFF_MS * 2 ** (attempt - 1));
      await backoff.promise;
    }
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "ingest/gen/ingest"
)

const baseBackoff = 100 * time.Millisecond

// upload streams chunks to Ingest.Upload and returns the attempts it used.
func upload(ctx context.Context, client pb.IngestClient, uploadID string, chunks [][]byte, maxAttempts int) (int, error) {
	// TODO: per attempt, client.GetStatus for NextSeq; nothing left to send means done
	// TODO: client.Upload(ctx), Send every chunk from NextSeq on, Recv until the Ack for the last seq
	// TODO: codes.Unavailable / codes.Aborted: wait baseBackoff << (attempt - 1) and retry, up to
	//       maxAttempts; any other code, or the last attempt, returns the error
	_ = codes.OK
	_ = status.Code
	return 0, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"io"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "ingest/gen/ingest"
)

const baseBackoff = 100 * time.Millisecond

// upload streams chunks to Ingest.Upload and returns the attempts it used.
func upload(ctx context.Context, client pb.IngestClient, uploadID string, chunks [][]byte, maxAttempts int) (int, error) {
	for attempt := 1; ; attempt++ {
		st, err := client.GetStatus(ctx, &pb.StatusRequest{UploadId: uploadID})
		if err != nil {
			return attempt, err
		}
		if int(st.GetNextSeq()) >= len(chunks) {
			return attempt, nil // everything is committed; only the final ack was lost
		}
		err = send(ctx, client, uploadID, chunks, st.GetNextSeq())
		if err == nil {
			return attempt, nil
		}
		code := status.Code(err)
		if (code != codes.Unavailable && code != codes.Aborted) || attempt >= maxAttempts {
			return attempt, err
		}
		select {
		case <-time.After(baseBackoff << (attempt - 1)):
		case <-ctx.Done():
			return attempt, ctx.Err()
		}
	}
}

// send runs one stream: a goroutine sends every chunk from \`from\` on and closes the send side,
// while this one reads acks until the last seq is acked or the stream fails.
func send(ctx context.Context, client pb.IngestClient, uploadID string, chunks [][]byte, from int32) error {
	stream, err := client.Upload(ctx)
	if err != nil {
		return err
	}
	last := int32(len(chunks) - 1)
	go func() {
		for seq := from; seq <= last; seq++ {
			if stream.Send(&pb.Chunk{UploadId: uploadID, Seq: seq, Data: chunks[seq]}) != nil {
				return // the stream is gone; Recv reports why
			}
		}
		_ = stream.CloseSend()
	}()
	for {
		ack, err := stream.Recv()
		if err == io.EOF {
			return errors.New("ingest: the stream ended before the last chunk was acked")
		}
		if err != nil {
			return err
		}
		if ack.GetSeq() == last {
			return nil
		}
	}
}
`,
    },
    scala: {
      starter: `import com.google.protobuf.ByteString
import io.grpc.{ManagedChannel, Status, StatusRuntimeException}
import io.grpc.stub.StreamObserver
import ingest.v1.ingest.{Ack, Chunk, IngestGrpc, StatusRequest}

object Uploader {
  val BaseBackoffMillis = 100L

  /** Streams chunks to Ingest.Upload and returns the attempts it used. */
  def upload(channel: ManagedChannel, uploadId: String, chunks: IndexedSeq[Array[Byte]], maxAttempts: Int = 4): Int = {
    // TODO: per attempt, getStatus for nextSeq; nothing left to send means done
    // TODO: IngestGrpc.stub(channel).upload(...), onNext every Chunk from nextSeq on, wait for the Ack of the last seq
    // TODO: UNAVAILABLE / ABORTED: sleep BaseBackoffMillis << (attempt - 1) and retry, up to maxAttempts;
    //       any other code, or the last attempt, throws
    0
  }
}
`,
      solution: `import scala.concurrent.{Await, Promise}
import scala.concurrent.duration.Duration

import com.google.protobuf.ByteString
import io.grpc.{ManagedChannel, Status, StatusRuntimeException}
import io.grpc.stub.StreamObserver
import ingest.v1.ingest.{Ack, Chunk, IngestGrpc, StatusRequest}

object Uploader {
  val BaseBackoffMillis = 100L
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.ABORTED)

  /** Streams chunks to Ingest.Upload and returns the attempts it used. */
  def upload(channel: ManagedChannel, uploadId: String, chunks: IndexedSeq[Array[Byte]], maxAttempts: Int = 4): Int = {
    val blocking = IngestGrpc.blockingStub(channel)
    val async = IngestGrpc.stub(channel)

    @annotation.tailrec
    def attemptFrom(attempt: Int): Int = {
      val nextSeq = blocking.getStatus(StatusRequest(uploadId = uploadId)).nextSeq
      if (nextSeq >= chunks.length) attempt // everything is committed; only the final ack was lost
      else {
        val failure =
          try { send(async, uploadId, chunks, nextSeq); None }
          catch { case e: StatusRuntimeException => Some(e) }
        failure match {
          case None => attempt
          case Some(e) if Retryable(e.getStatus.getCode) && attempt < maxAttempts =>
            Thread.sleep(BaseBackoffMillis << (attempt - 1))
            attemptFrom(attempt + 1)
          case Some(e) => throw e
        }
      }
    }
    attemptFrom(1)
  }

  /** One stream: every chunk from \`from\` on; returns on the Ack for the last one, throws the stream's error. */
  private def send(stub: IngestGrpc.IngestStub, uploadId: String, chunks: IndexedSeq[Array[Byte]], from: Int): Unit = {
    val last = chunks.length - 1
    val done = Promise[Unit]()
    lazy val requests: StreamObserver[Chunk] = stub.upload(new StreamObserver[Ack] {
      def onNext(ack: Ack): Unit = if (ack.seq == last) { requests.onCompleted(); done.trySuccess(()) }
      def onError(t: Throwable): Unit = done.tryFailure(Status.fromThrowable(t).asRuntimeException())
      def onCompleted(): Unit = done.tryFailure(new IllegalStateException("the stream ended before the last chunk was acked"))
    })
    for (seq <- from to last)
      requests.onNext(Chunk(uploadId = uploadId, seq = seq, data = ByteString.copyFrom(chunks(seq))))
    Await.result(done.future, Duration.Inf)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "ingest.grpc.pb.h"

using ingest::v1::Ack;
using ingest::v1::Chunk;
using ingest::v1::Ingest;
using ingest::v1::StatusRequest;
using ingest::v1::StatusResponse;

constexpr std::chrono::milliseconds kBaseBackoff{100};

// Streams chunks to Ingest.Upload and returns the attempts it used.
int upload(Ingest::Stub& stub, const std::string& upload_id, const std::vector<std::string>& chunks, int max_attempts = 4) {
  // TODO: per attempt, stub.GetStatus for next_seq(); nothing left to send means done
  // TODO: stub.Upload(&ctx), Write every Chunk from next_seq on, Read until the Ack of the last seq
  // TODO: UNAVAILABLE / ABORTED: sleep kBaseBackoff * (1 << (attempt - 1)) and retry, up to
  //       max_attempts; any other code, or the last attempt, throws
  return 0;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "ingest.grpc.pb.h"

using ingest::v1::Ack;
using ingest::v1::Chunk;
using ingest::v1::Ingest;
using ingest::v1::StatusRequest;
using ingest::v1::StatusResponse;

constexpr std::chrono::milliseconds kBaseBackoff{100};

// One stream: a writer thread sends every chunk from \`from\` on and closes the send side; this
// thread reads acks until the server ends the call.
grpc::Status send(Ingest::Stub& stub, const std::string& upload_id, const std::vector<std::string>& chunks, int from) {
  grpc::ClientContext ctx;
  auto stream = stub.Upload(&ctx);
  const int last = static_cast<int>(chunks.size()) - 1;
  std::thread writer([&] {
    for (int seq = from; seq <= last; ++seq) {
      Chunk chunk;
      chunk.set_upload_id(upload_id);
      chunk.set_seq(seq);
      chunk.set_data(chunks[seq]);
      if (!stream->Write(chunk)) break;  // the stream is gone; Finish reports why
    }
    stream->WritesDone();
  });
  Ack ack;
  bool acked = false;
  while (stream->Read(&ack)) acked = ack.seq() == last;
  writer.join();
  const grpc::Status status = stream->Finish();
  if (status.ok() && !acked) return grpc::Status(grpc::StatusCode::DATA_LOSS, "the stream ended before the last chunk was acked");
  return status;
}

// Streams chunks to Ingest.Upload and returns the attempts it used.
int upload(Ingest::Stub& stub, const std::string& upload_id, const std::vector<std::string>& chunks, int max_attempts = 4) {
  for (int attempt = 1;; ++attempt) {
    grpc::ClientContext ctx;
    StatusRequest request;
    request.set_upload_id(upload_id);
    StatusResponse reply;
    const grpc::Status got = stub.GetStatus(&ctx, request, &reply);
    if (!got.ok()) throw std::runtime_error("GetStatus: " + got.error_message());
    if (reply.next_seq() >= static_cast<int>(chunks.size())) return attempt;  // only the final ack was lost
    const grpc::Status status = send(stub, upload_id, chunks, reply.next_seq());
    if (status.ok()) return attempt;
    const auto code = status.error_code();
    const bool retryable = code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::ABORTED;
    if (!retryable || attempt >= max_attempts) throw std::runtime_error("Upload: " + status.error_message());
    std::this_thread::sleep_for(kBaseBackoff * (1 << (attempt - 1)));
  }
}
`,
    },
  },
  harness: {
    python: `import asyncio
import importlib
import time

import grpc

import ingest_pb2
import ingest_pb2_grpc

CHUNKS = [f"chunk-{i}".encode() for i in range(8)]
LAST = len(CHUNKS) - 1
UNAVAILABLE = grpc.StatusCode.UNAVAILABLE
ABORTED = grpc.StatusCode.ABORTED


class Fault:
    """How one Upload stream ends early: after \`after\` fresh commits, with \`code\`; \`drop_ack\` loses that commit's Ack."""

    def __init__(self, code, after=1, drop_ack=False, details=""):
        self.code = code
        self.after = after
        self.drop_ack = drop_ack
        self.details = details or f"injected {code.name}"


class FakeIngest(ingest_pb2_grpc.IngestServicer):
    """The ingest server: a committed point per upload, when each GetStatus and stream came, every chunk each stream delivered."""

    def __init__(self, plan=(), hold_final_ack=False):
        self.plan = list(plan)
        self.hold_final_ack = hold_final_ack
        self.committed = {}
        self.status_calls = []
        self.opened = []
        self.streams = []
        self.closed = []
        self.final_acked = False

    async def GetStatus(self, request, context):
        self.status_calls.append((request.upload_id, time.time()))
        return ingest_pb2.StatusResponse(next_seq=self.committed.get(request.upload_id, 0))

    async def Upload(self, request_iterator, context):
        n = len(self.streams)
        self.opened.append(time.time())
        self.streams.append([])
        self.closed.append(False)
        fault = self.plan.pop(0) if self.plan else None
        commits = 0
        async for chunk in request_iterator:
            self.streams[n].append((chunk.upload_id, chunk.seq, bytes(chunk.data)))
            expected = self.committed.get(chunk.upload_id, 0)
            if chunk.seq > expected:
                await context.abort(grpc.StatusCode.FAILED_PRECONDITION, f"gap: expected seq {expected}, got {chunk.seq}")
            if chunk.seq == expected:
                if self.hold_final_ack and chunk.seq == LAST:
                    for _ in range(50):  # a slow final commit: the Ack for seq 7 comes many loop turns later
                        await asyncio.sleep(0)
                self.committed[chunk.upload_id] = expected + 1
                commits += 1
            ack = ingest_pb2.Ack(seq=self.committed[chunk.upload_id] - 1)
            if fault is not None and commits == fault.after:
                if not fault.drop_ack:
                    yield ack
                await context.abort(fault.code, fault.details)
            self.final_acked = self.final_acked or ack.seq == LAST
            yield ack
        self.closed[n] = True


def _start(ctx, fake):
    """Serve \`fake\`, load the learner's module, and dial Ingest with the stub it is handed."""
    ctx.grpc.serve(ingest_pb2_grpc.add_IngestServicer_to_server, fake)
    m = ctx.load("uploader")
    stubs = importlib.import_module("ingest_pb2_grpc")  # the generated module the learner's imports share
    return m, stubs.IngestStub(grpc.aio.insecure_channel("ingest:9000"))


async def _settle():
    for _ in range(10):
        await asyncio.sleep(0)


async def _upload(m, stub, fake, *args):
    """upload(stub, "up-1", CHUNKS, *args) to the end: (returned, error, finished_at). Sets fake.acked_on_return."""
    task = asyncio.ensure_future(m.upload(stub, "up-1", list(CHUNKS), *args))
    for _ in range(5000):  # event-loop turns; a correct upload needs a few hundred at most
        if task.done():
            break
        await asyncio.sleep(0)
    else:
        task.cancel()
        await _settle()
        raise AssertionError("upload() never returned: it is still waiting on the stream. Send every seq from next_seq to the last and finish on Ack{seq: 7}")
    fake.acked_on_return = fake.final_acked
    finished = time.time()
    error = task.exception()
    return (None if error is not None else task.result()), error, finished


def _sent(fake):
    """The seqs each stream delivered: [[0, 1, 2, 3, 4], [5, 6, 7]]."""
    return [[seq for _, seq, _ in stream] for stream in fake.streams]


def _describe(error):
    if isinstance(error, grpc.RpcError):
        return f"{error.code().name} ({error.details()})"
    return f"{type(error).__name__}: {error}" if str(error) else type(error).__name__


def _ok(error, what):
    if error is not None:
        raise AssertionError(f"{what}: upload() raised {_describe(error)}")


def _rpc_error(returned, error, code, what):
    assert error is not None, f"{what}: upload() returned {returned!r} instead of raising {code.name}"
    assert isinstance(error, grpc.RpcError), f"{what}: upload() raised {_describe(error)}, expected the grpc.RpcError with {code.name}"
    assert error.code() == code, f"{what}: upload() raised {error.code().name}, expected {code.name}"


async def check_clean_upload(ctx):
    fake = FakeIngest(hold_final_ack=True)
    m, stub = _start(ctx, fake)
    returned, error, _ = await _upload(m, stub, fake)
    _ok(error, "a clean upload")
    assert len(fake.status_calls) == 1, f"a clean upload called GetStatus {len(fake.status_calls)} times, expected once, before the stream"
    assert fake.status_calls[0][0] == "up-1", f"GetStatus asked for upload_id {fake.status_calls[0][0]!r}, expected 'up-1'"
    assert len(fake.streams) == 1, f"a clean upload opened {len(fake.streams)} Upload streams, expected 1"
    assert _sent(fake) == [list(range(8))], f"the stream delivered seqs {_sent(fake)[0]}, expected [0, 1, 2, 3, 4, 5, 6, 7]: each chunk once, in order"
    for upload_id, seq, data in fake.streams[0]:
        assert upload_id == "up-1", f"Chunk seq {seq} carried upload_id {upload_id!r}, expected 'up-1'"
        assert data == CHUNKS[seq], f"Chunk seq {seq} carried {data!r}, expected chunks[{seq}] = {CHUNKS[seq]!r}"
    assert fake.acked_on_return, "upload() returned before the server sent Ack{seq: 7}: the last write is not the end, the Ack for the last seq is"
    await _settle()
    assert fake.closed[0], "upload() returned with the stream's send side still open: close it after the last chunk (end the request iterator, or done_writing())"


async def check_resume_from_status(ctx):
    fake = FakeIngest()
    fake.committed["up-1"] = 3
    m, stub = _start(ctx, fake)
    returned, error, _ = await _upload(m, stub, fake)
    _ok(error, "an upload the server already holds seqs 0 to 2 of")
    assert _sent(fake) == [[3, 4, 5, 6, 7]], f"with GetStatus at next_seq 3 the streams delivered {_sent(fake)}, expected [[3, 4, 5, 6, 7]]: start at next_seq, not at 0"

    fake = FakeIngest([Fault(UNAVAILABLE, after=5, drop_ack=True)])
    m, stub = _start(ctx, fake)
    returned, error, _ = await _upload(m, stub, fake)
    _ok(error, "an upload whose stream died after seq 4 was committed")
    sent = _sent(fake)
    assert len(sent) == 2 and sent[1] == [5, 6, 7], f"seqs 0 to 4 were committed, the Ack for 4 was lost, then UNAVAILABLE; the streams delivered {sent}, expected [[0, 1, 2, 3, 4], [5, 6, 7]]: ask GetStatus (next_seq 5) and resend nothing below it"

    fake = FakeIngest([Fault(UNAVAILABLE, after=8, drop_ack=True)])
    m, stub = _start(ctx, fake)
    returned, error, _ = await _upload(m, stub, fake)
    _ok(error, "an upload whose final Ack was lost")
    assert _sent(fake) == [list(range(8))], f"every chunk was committed and only the final Ack lost; the streams delivered {_sent(fake)}, expected one stream: GetStatus says next_seq 8, so there is nothing to send"


async def check_backoff(ctx):
    fake = FakeIngest([Fault(UNAVAILABLE), Fault(ABORTED), Fault(UNAVAILABLE)])
    m, stub = _start(ctx, fake)
    started = time.time()
    returned, error, _ = await _upload(m, stub, fake)
    _ok(error, "three failed streams, then a clean one")
    times = [at - started for _, at in fake.status_calls]
    assert len(times) == 4, f"three failed streams then a clean one called GetStatus {len(times)} times, expected 4: once per attempt"
    assert times[0] < 0.05, f"the first GetStatus came {times[0]:.2f} s in; the first attempt does not wait"
    gaps = [round(b - a, 2) for a, b in zip(times, times[1:])]
    for got, want in zip(gaps, (0.1, 0.2, 0.4)):
        assert abs(got - want) < 0.05, f"the GetStatus calls were {gaps} s apart, expected [0.1, 0.2, 0.4]: wait 0.1 * 2^(attempt - 1) s after attempt number attempt fails"
    assert _sent(fake) == [[0], [1], [2], [3, 4, 5, 6, 7]], f"the streams delivered {_sent(fake)}, expected [[0], [1], [2], [3, 4, 5, 6, 7]]"


async def check_gives_up(ctx):
    fake = FakeIngest([Fault(UNAVAILABLE, details=f"ingest restarting ({i})") for i in range(1, 11)])
    m, stub = _start(ctx, fake)
    returned, error, finished = await _upload(m, stub, fake, 3)
    _rpc_error(returned, error, UNAVAILABLE, "a server that drops every stream, max_attempts 3")
    assert len(fake.streams) == 3, f"with max_attempts 3 upload() opened {len(fake.streams)} streams, expected 3"
    assert error.details() == "ingest restarting (3)", f"upload() raised details {error.details()!r}, expected the third stream's 'ingest restarting (3)': raise the last error"
    waited = finished - fake.opened[-1]
    assert waited < 0.05, f"upload() raised {waited:.2f} s after its last stream opened: after the last attempt there is nothing to wait for"

    fake = FakeIngest([Fault(UNAVAILABLE) for _ in range(10)])
    m, stub = _start(ctx, fake)
    returned, error, _ = await _upload(m, stub, fake)
    _rpc_error(returned, error, UNAVAILABLE, "a server that drops every stream, default max_attempts")
    assert len(fake.streams) == 4, f"with the default max_attempts upload() opened {len(fake.streams)} streams, expected 4"


async def check_other_codes(ctx):
    for code in (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.PERMISSION_DENIED):
        fake = FakeIngest([Fault(code, after=2)])
        m, stub = _start(ctx, fake)
        started = time.time()
        returned, error, finished = await _upload(m, stub, fake)
        _rpc_error(returned, error, code, f"a stream that ends with {code.name}")
        assert len(fake.status_calls) == 1 and len(fake.streams) == 1, f"{code.name} was retried ({len(fake.status_calls)} GetStatus calls, {len(fake.streams)} streams): only UNAVAILABLE and ABORTED are"
        assert finished - started < 0.05, f"upload() waited {finished - started:.2f} s before raising {code.name}: raise it at once"


async def check_returns_attempts(ctx):
    cases = [
        ([], 4, 1, "a clean upload"),
        ([Fault(ABORTED, after=3)], 4, 2, "one ABORTED stream"),
        ([Fault(UNAVAILABLE, after=8, drop_ack=True)], 4, 2, "a stream that lost only the final Ack"),
        ([Fault(UNAVAILABLE), Fault(ABORTED)], 3, 3, "two failed streams with max_attempts 3"),
    ]
    for plan, max_attempts, want, what in cases:
        fake = FakeIngest(plan)
        m, stub = _start(ctx, fake)
        returned, error, _ = await _upload(m, stub, fake, max_attempts)
        _ok(error, what)
        assert returned == want, f"{what}: upload() returned {returned!r}, expected {want}, the attempts it used"
`,
    typescript: `const CHUNKS = () => Array.from({length: 8}, (_, i) => Buffer.from('chunk-' + i));
const LAST = 7;

const statusName = (ctx, code) => Object.keys(ctx.grpc.status).find(k => ctx.grpc.status[k] === code) ?? String(code);

/** How one Upload stream ends early: after \`after\` fresh commits, with \`code\`; \`dropAck\` loses that commit's Ack. */
const fault = (code, {after = 1, dropAck = false, details = ''} = {}) => ({code, after, dropAck, details});

/** The ingest server: a committed point per upload, when each GetStatus and stream came, every chunk each stream delivered. */
function start(ctx, plan = [], holdFinalAck = false) {
  const fake = {committed: new Map(), statusCalls: [], opened: [], streams: [], closed: [], plan: [...plan], finalAcked: false};
  const {ingest} = ctx.proto('ingest.proto');
  ctx.grpc.serve(ingest.v1.Ingest.service, {
    GetStatus: (call, callback) => {
      fake.statusCalls.push({uploadId: call.request.upload_id, at: Date.now()});
      callback(null, {next_seq: fake.committed.get(call.request.upload_id) ?? 0});
    },
    Upload: call => {
      const n = fake.streams.length;
      fake.opened.push(Date.now());
      const got = [];
      fake.streams.push(got);
      fake.closed.push(false);
      const f = fake.plan.shift() ?? null;
      let commits = 0;
      let dead = false;
      let queue = Promise.resolve();
      const abort = (code, details) => {
        dead = true;
        call.emit('error', {code, details: details || 'injected ' + statusName(ctx, code)});
      };
      const take = async chunk => {
        got.push({uploadId: chunk.upload_id, seq: chunk.seq, data: Buffer.from(chunk.data).toString()});
        const expected = fake.committed.get(chunk.upload_id) ?? 0;
        if (chunk.seq > expected) return abort(ctx.grpc.status.FAILED_PRECONDITION, 'gap: expected seq ' + expected + ', got ' + chunk.seq);
        if (chunk.seq === expected) {
          if (holdFinalAck && chunk.seq === LAST) await settle(50); // a slow final commit: the Ack for seq 7 comes many loop turns later
          fake.committed.set(chunk.upload_id, expected + 1);
          commits += 1;
        }
        const ack = {seq: fake.committed.get(chunk.upload_id) - 1};
        if (f !== null && commits === f.after) {
          if (!f.dropAck) call.write(ack);
          return abort(f.code, f.details);
        }
        if (ack.seq === LAST) fake.finalAcked = true;
        call.write(ack);
      };
      call.on('data', chunk => {
        queue = queue.then(() => (dead ? undefined : take(chunk)));
      });
      call.on('end', () => {
        queue = queue.then(() => {
          if (dead) return;
          fake.closed[n] = true;
          call.end();
        });
      });
    },
  });
  return {fake, m: ctx.load('uploader'), client: new ingest.v1.Ingest('ingest:9000')};
}

async function settle(turns = 10) {
  for (let i = 0; i < turns; i++) {
    const {promise, resolve} = Promise.withResolvers();
    setTimeout(resolve, 0);
    await promise;
  }
}

/** upload(client, 'up-1', CHUNKS, maxAttempts?) to the end: {returned, error, finished}. */
async function run(m, client, maxAttempts = undefined) {
  const args = maxAttempts === undefined ? [client, 'up-1', CHUNKS()] : [client, 'up-1', CHUNKS(), maxAttempts];
  try {
    const returned = await m.upload(...args);
    return {returned, error: null, finished: Date.now()};
  } catch (error) {
    return {returned: undefined, error, finished: Date.now()};
  }
}

/** The seqs each stream delivered: [[0, 1, 2, 3, 4], [5, 6, 7]]. */
const sent = fake => fake.streams.map(s => s.map(c => c.seq));

const describe = (ctx, e) =>
  typeof e?.code === 'number' ? statusName(ctx, e.code) + ' (' + e.details + ')' : String(e?.message ?? e);

function ok(ctx, r, what) {
  assert(r.error === null, what + ': upload() threw ' + (r.error === null ? '' : describe(ctx, r.error)));
}

function rpcError(ctx, r, code, what) {
  assert(r.error !== null, what + ': upload() returned ' + JSON.stringify(r.returned) + ' instead of rejecting with ' + statusName(ctx, code));
  assert(typeof r.error?.code === 'number', what + ': upload() threw ' + describe(ctx, r.error) + ', expected the ServiceError with ' + statusName(ctx, code));
  assert.equal(r.error.code, code, what + ': upload() threw ' + statusName(ctx, r.error.code) + ', expected ' + statusName(ctx, code));
}

export async function check_clean_upload(ctx) {
  const {fake, m, client} = start(ctx, [], true);
  const r = await run(m, client);
  const ackedOnReturn = fake.finalAcked;
  ok(ctx, r, 'a clean upload');
  assert.equal(fake.statusCalls.length, 1, \`a clean upload called GetStatus \${fake.statusCalls.length} times, expected once, before the stream\`);
  assert.equal(fake.statusCalls[0].uploadId, 'up-1', \`GetStatus asked for upload_id \${JSON.stringify(fake.statusCalls[0].uploadId)}, expected 'up-1'\`);
  assert.equal(fake.streams.length, 1, \`a clean upload opened \${fake.streams.length} Upload streams, expected 1\`);
  assert.deepEqual(sent(fake), [[0, 1, 2, 3, 4, 5, 6, 7]], \`the stream delivered seqs \${JSON.stringify(sent(fake)[0])}, expected [0,1,2,3,4,5,6,7]: each chunk once, in order\`);
  for (const c of fake.streams[0]) {
    assert.equal(c.uploadId, 'up-1', \`Chunk seq \${c.seq} carried upload_id \${JSON.stringify(c.uploadId)}, expected 'up-1'\`);
    assert.equal(c.data, 'chunk-' + c.seq, \`Chunk seq \${c.seq} carried \${JSON.stringify(c.data)}, expected chunks[\${c.seq}] = 'chunk-\${c.seq}'\`);
  }
  assert(ackedOnReturn, 'upload() returned before the server sent Ack{seq: 7}: the last write is not the end, the Ack for the last seq is');
  await settle();
  assert(fake.closed[0], "upload() returned with the stream's send side still open: call.end() after the last Ack");
}

export async function check_resume_from_status(ctx) {
  let {fake, m, client} = start(ctx);
  fake.committed.set('up-1', 3);
  let r = await run(m, client);
  ok(ctx, r, 'an upload the server already holds seqs 0 to 2 of');
  assert.deepEqual(sent(fake), [[3, 4, 5, 6, 7]], \`with GetStatus at next_seq 3 the streams delivered \${JSON.stringify(sent(fake))}, expected [[3,4,5,6,7]]: start at next_seq, not at 0\`);

  ({fake, m, client} = start(ctx, [fault(ctx.grpc.status.UNAVAILABLE, {after: 5, dropAck: true})]));
  r = await run(m, client);
  ok(ctx, r, 'an upload whose stream died after seq 4 was committed');
  const streams = sent(fake);
  assert(streams.length === 2 && JSON.stringify(streams[1]) === '[5,6,7]', \`seqs 0 to 4 were committed, the Ack for 4 was lost, then UNAVAILABLE; the streams delivered \${JSON.stringify(streams)}, expected [[0,1,2,3,4],[5,6,7]]: ask GetStatus (next_seq 5) and resend nothing below it\`);

  ({fake, m, client} = start(ctx, [fault(ctx.grpc.status.UNAVAILABLE, {after: 8, dropAck: true})]));
  r = await run(m, client);
  ok(ctx, r, 'an upload whose final Ack was lost');
  assert.deepEqual(sent(fake), [[0, 1, 2, 3, 4, 5, 6, 7]], \`every chunk was committed and only the final Ack lost; the streams delivered \${JSON.stringify(sent(fake))}, expected one stream: GetStatus says next_seq 8, so there is nothing to send\`);
}

export async function check_backoff(ctx) {
  const {UNAVAILABLE, ABORTED} = ctx.grpc.status;
  const {fake, m, client} = start(ctx, [fault(UNAVAILABLE), fault(ABORTED), fault(UNAVAILABLE)]);
  const started = Date.now();
  const r = await run(m, client);
  ok(ctx, r, 'three failed streams, then a clean one');
  const times = fake.statusCalls.map(c => (c.at - started) / 1000);
  assert.equal(times.length, 4, \`three failed streams then a clean one called GetStatus \${times.length} times, expected 4: once per attempt\`);
  assert(times[0] < 0.05, \`the first GetStatus came \${times[0].toFixed(2)} s in; the first attempt does not wait\`);
  const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) * 100) / 100);
  [0.1, 0.2, 0.4].forEach((want, i) =>
    assert(Math.abs(gaps[i] - want) < 0.05, \`the GetStatus calls were \${JSON.stringify(gaps)} s apart, expected [0.1,0.2,0.4]: wait 0.1 * 2^(attempt - 1) s after attempt number attempt fails\`),
  );
  assert.deepEqual(sent(fake), [[0], [1], [2], [3, 4, 5, 6, 7]], \`the streams delivered \${JSON.stringify(sent(fake))}, expected [[0],[1],[2],[3,4,5,6,7]]\`);
}

export async function check_gives_up(ctx) {
  const {UNAVAILABLE} = ctx.grpc.status;
  let {fake, m, client} = start(ctx, Array.from({length: 10}, (_, i) => fault(UNAVAILABLE, {details: 'ingest restarting (' + (i + 1) + ')'})));
  let r = await run(m, client, 3);
  rpcError(ctx, r, UNAVAILABLE, 'a server that drops every stream, maxAttempts 3');
  assert.equal(fake.streams.length, 3, \`with maxAttempts 3 upload() opened \${fake.streams.length} streams, expected 3\`);
  assert.equal(r.error.details, 'ingest restarting (3)', \`upload() threw details \${JSON.stringify(r.error.details)}, expected the third stream's 'ingest restarting (3)': throw the last error\`);
  const waited = (r.finished - fake.opened[fake.opened.length - 1]) / 1000;
  assert(waited < 0.05, \`upload() threw \${waited.toFixed(2)} s after its last stream opened: after the last attempt there is nothing to wait for\`);

  ({fake, m, client} = start(ctx, Array.from({length: 10}, () => fault(UNAVAILABLE))));
  r = await run(m, client);
  rpcError(ctx, r, UNAVAILABLE, 'a server that drops every stream, default maxAttempts');
  assert.equal(fake.streams.length, 4, \`with the default maxAttempts upload() opened \${fake.streams.length} streams, expected 4\`);
}

export async function check_other_codes(ctx) {
  for (const code of [ctx.grpc.status.INVALID_ARGUMENT, ctx.grpc.status.PERMISSION_DENIED]) {
    const {fake, m, client} = start(ctx, [fault(code, {after: 2})]);
    const started = Date.now();
    const r = await run(m, client);
    rpcError(ctx, r, code, 'a stream that ends with ' + statusName(ctx, code));
    assert(fake.statusCalls.length === 1 && fake.streams.length === 1, \`\${statusName(ctx, code)} was retried (\${fake.statusCalls.length} GetStatus calls, \${fake.streams.length} streams): only UNAVAILABLE and ABORTED are\`);
    const waited = (r.finished - started) / 1000;
    assert(waited < 0.05, \`upload() waited \${waited.toFixed(2)} s before throwing \${statusName(ctx, code)}: throw it at once\`);
  }
}

export async function check_returns_attempts(ctx) {
  const {UNAVAILABLE, ABORTED} = ctx.grpc.status;
  const cases = [
    [[], 4, 1, 'a clean upload'],
    [[fault(ABORTED, {after: 3})], 4, 2, 'one ABORTED stream'],
    [[fault(UNAVAILABLE, {after: 8, dropAck: true})], 4, 2, 'a stream that lost only the final Ack'],
    [[fault(UNAVAILABLE), fault(ABORTED)], 3, 3, 'two failed streams with maxAttempts 3'],
  ];
  for (const [plan, maxAttempts, want, what] of cases) {
    const {m, client} = start(ctx, plan);
    const r = await run(m, client, maxAttempts);
    ok(ctx, r, what);
    assert.equal(r.returned, want, \`\${what}: upload() returned \${JSON.stringify(r.returned)}, expected \${want}, the attempts it used\`);
  }
}
`,
  },
  debrief: `A resumable upload is at-least-once delivery that the server turns into exactly-once storage. The seq is the idempotency key: the server commits seq \`n\` only when its committed point is \`n\`, ignores anything below and refuses anything above. The committed point lives on the server because only the server knows it: a stream can die after a commit and before the Ack crosses the wire, so the client's last Ack is a lower bound. Trusting it resends committed chunks (harmless here, wasted bandwidth, a bug wherever the server is not idempotent); restarting from 0 resends all of them, and a large upload on a flaky link may never finish. Asking \`GetStatus\` costs one round trip per attempt and is always right.

The retry policy is the usual one: exponential backoff, a hard cap on attempts, and only \`UNAVAILABLE\` and \`ABORTED\` retried, because \`INVALID_ARGUMENT\` or \`PERMISSION_DENIED\` will fail the same way again. Production uploaders add jitter to the backoff; a checksum per chunk (GCS uses CRC32C and MD5) so a corrupt chunk is refused instead of committed; a session that expires (a GCS session URI lasts a week); chunk sizes aligned to the server's granularity (GCS wants multiples of 256 KiB); and reading Acks while writing, which this solution does, so neither side's flow-control window fills while the other waits.`,
};
