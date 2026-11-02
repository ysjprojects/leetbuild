import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Worker calls with segment-scoped retries and bounded attempts',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'worker', 'source'],
  task: `## Task

**Starting point.** The starter is the worker client: for each segment it calls \`EncodeSegment\`
with a fixed 30 s timeout inside \`while True\`, logs and retries on any \`RpcError\`, and still
carries a whole-file \`encode_file\` helper. It serves the demo and hides five flaws.

**Failure mode the checks target.** Retrying every error forever is the corrupt-input runaway: the
job loops for hours on a segment that can never succeed. Re-encoding the whole file when one worker
dies redoes an hour of work and, with the claim tracker, still cannot fill the hole. The fixed
ceiling starves long segments and lets short ones hang, and the bare exception cannot say which
segment broke.

- The deadline is **scaled to the segment's length**: \`DEADLINE_BASE_MS = 2000\` plus
  \`DEADLINE_PER_SECOND_MS = 500\` per second, applied per attempt (\`timeout\`, \`deadline\`,
  \`context.WithTimeout\`, \`withDeadlineAfter\`, \`set_deadline\`).
- Each segment gets at most **two attempts** (\`MAX_ATTEMPTS = 2\`) in a bounded loop.
- Failures are **classified** in one place, \`is_retryable\`/\`isRetryable\`: \`UNAVAILABLE\` and
  \`DEADLINE_EXCEEDED\` are retryable; \`INVALID_ARGUMENT\` and anything else are terminal.
- Attempts stay **inside the segment**; there is no whole-file call in this client.
- When a segment finally fails, the raised error carries the **segment index**.`,
  sequence: {
    participants: ['Transcoder API', 'Worker client', 'Transcode worker', 'Source store'],
    messages: [
      {from: 'Transcoder API', to: 'Worker client', label: 'encode(job, segment index, source uri)', kind: 'sync'},
      {from: 'Worker client', to: 'Worker client', label: 'deadline = base + 500 ms × segment seconds', kind: 'sync'},
      {
        from: 'Worker client',
        to: 'Transcode worker',
        label: 'EncodeSegment(range, deadline) · attempt 1',
        kind: 'sync',
      },
      {from: 'Transcode worker', to: 'Source store', label: 'GET byte range', kind: 'sync'},
      {from: 'Transcode worker', to: 'Worker client', label: 'UNAVAILABLE (worker died)', kind: 'reply'},
      {
        from: 'Worker client',
        to: 'Transcode worker',
        label: 'EncodeSegment · attempt 2, same segment only',
        kind: 'sync',
      },
      {from: 'Transcode worker', to: 'Worker client', label: 'INVALID_ARGUMENT (corrupt input)', kind: 'reply'},
      {
        from: 'Worker client',
        to: 'Transcoder API',
        label: 'SegmentFailure(segment_index) — terminal, bounded',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'scaled-deadline',
      title: 'Deadline scaled to the segment’s length',
      detail:
        'Each attempt carries a deadline computed as `DEADLINE_BASE_MS + DEADLINE_PER_SECOND_MS × segment_seconds` (a context with timeout, `set_deadline`, `withDeadlineAfter`, `deadline`). The starter gives every call the same fixed 30-second ceiling.',
      match: {
        python: {all: [/DEADLINE_BASE_MS/, /DEADLINE_PER_SECOND_MS/, /timeout=deadline_ms\(/]},
        typescript: {all: [/DEADLINE_BASE_MS/, /DEADLINE_PER_SECOND_MS/, /Date\.now\(\)\s*\+\s*deadlineMs\(/]},
        go: {all: [/deadlineBaseMS/, /deadlinePerSecondMS/, /context\.WithTimeout\(ctx,\s*deadlineMS\(/]},
        scala: {all: [/DeadlineBaseMs/, /DeadlinePerSecondMs/, /withDeadlineAfter\(deadlineMs\(/]},
        cpp: {all: [/kDeadlineBaseMs/, /kDeadlinePerSecondMs/, /set_deadline\(/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'At most two attempts per segment',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 2` and the loop cannot run forever. The starter retries every error indefinitely, so a corrupt segment loops until the job is killed.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2/, /range\(MAX_ATTEMPTS\)/], none: [/while True/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2/, /attempt\s*<\s*MAX_ATTEMPTS/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/maxAttempts\s*=\s*2/, /attempt\s*<\s*maxAttempts/], none: [/^\s*for\s*\{/m]},
        scala: {all: [/MaxAttempts\s*=\s*2/, /attempt < MaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2/, /attempt < kMaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'classify',
      title: 'Corrupt input is terminal, worker loss is retryable',
      detail:
        '`INVALID_ARGUMENT` (corrupt media) and `UNAVAILABLE`/`DEADLINE_EXCEEDED` (worker loss) are separated in one place — `is_retryable`/`isRetryable` — and only the retryable ones loop. The starter treats every error the same and retries all of them.',
      match: {
        python: {all: [/INVALID_ARGUMENT/, /UNAVAILABLE/, /def is_retryable\(/]},
        typescript: {all: [/INVALID_ARGUMENT/, /UNAVAILABLE/, /function isRetryable\(/]},
        go: {all: [/codes\.InvalidArgument/, /codes\.Unavailable/, /func isRetryable\(/]},
        scala: {all: [/INVALID_ARGUMENT/, /UNAVAILABLE/, /def isRetryable\(/]},
        cpp: {all: [/StatusCode::INVALID_ARGUMENT/, /StatusCode::UNAVAILABLE/, /bool isRetryable\(/]},
      },
    },
    {
      id: 'segment-scope',
      title: 'Retries stay inside the failing segment',
      detail:
        'The client encodes one segment per call (`EncodeSegment` with a `segment_index`) and never re-encodes the file; there is no whole-file call. The starter re-encodes everything when one worker dies.',
      match: {
        python: {all: [/EncodeSegment\(/, /segment_index/], none: [/EncodeFile\(|encode_all\(/]},
        typescript: {all: [/EncodeSegment\(/, /segmentIndex/], none: [/EncodeFile\(|encodeFile\(/]},
        go: {all: [/\.EncodeSegment\(/, /segmentIndex/], none: [/EncodeFile\(/]},
        scala: {all: [/encodeSegment\(/, /segmentIndex/], none: [/encodeFile\(/]},
        cpp: {all: [/EncodeSegment\(/, /segment_index/], none: [/EncodeFile\(/]},
      },
    },
    {
      id: 'fail-with-index',
      title: 'A failed segment names its index',
      detail:
        'When the attempts are exhausted (or the input is corrupt) the error carries the segment index — `SegmentFailure(segment_index, reason)` / `SegmentFailure{SegmentIndex: …}` — so the job and the event can say which segment broke. The starter raises a bare exception with no index.',
      match: {
        python: {all: [/SegmentFailure\(segment_index/, /segment_index/]},
        typescript: {all: [/SegmentFailure\(segmentIndex/, /segmentIndex/]},
        go: {all: [/SegmentFailure\{SegmentIndex:\s*segmentIndex/, /SegmentIndex/]},
        scala: {all: [/SegmentFailure\(segmentIndex/, /segmentIndex/]},
        cpp: {all: [/SegmentFailure\(segment_index/, /segment_index/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import workers_pb2
import workers_pb2_grpc

logger = logging.getLogger("transcoder")


def encode_job(stub, job_id: str, segments, source_uri: str) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    for segment_index, _segment_seconds in enumerate(segments):
        request = workers_pb2.EncodeRequest(job_id=job_id, segment_index=segment_index, source_uri=source_uri)
        while True:
            try:
                stub.EncodeSegment(request, timeout=30.0)
                break
            except grpc.RpcError as error:
                logger.warning("segment %d failed: %s, retrying", segment_index, error.details())


def encode_file(stub, job_id: str, source_uri: str) -> None:
    """One call for the whole source, the way the starter started before segments existed."""
    stub.EncodeFile(workers_pb2.EncodeFileRequest(job_id=job_id, source_uri=source_uri), timeout=30.0)
`,
      solution: `import logging

import grpc

import workers_pb2
import workers_pb2_grpc

logger = logging.getLogger("transcoder")

DEADLINE_BASE_MS = 2_000
DEADLINE_PER_SECOND_MS = 500
MAX_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)


class SegmentFailure(Exception):
    """A segment that could not be encoded: the job fails naming this index."""

    def __init__(self, segment_index: int, reason: str) -> None:
        super().__init__(f"segment {segment_index}: {reason}")
        self.segment_index = segment_index
        self.reason = reason


def deadline_ms(segment_seconds: float) -> int:
    """A long segment gets proportionally more time; a short one fails fast."""
    return int(DEADLINE_BASE_MS + DEADLINE_PER_SECOND_MS * segment_seconds)


def is_retryable(error: grpc.RpcError) -> bool:
    """Worker loss is retryable; corrupt input and anything else is terminal."""
    return error.code() in RETRYABLE


def encode_segment(
    stub: grpc.Channel, job_id: str, segment_index: int, segment_seconds: float, source_uri: str
) -> None:
    request = workers_pb2.EncodeRequest(job_id=job_id, segment_index=segment_index, source_uri=source_uri)
    last: grpc.RpcError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            stub.EncodeSegment(request, timeout=deadline_ms(segment_seconds) / 1000)
            return
        except grpc.RpcError as error:
            if error.code() == grpc.StatusCode.INVALID_ARGUMENT:
                raise SegmentFailure(segment_index, "corrupt input") from error
            if not is_retryable(error):
                raise SegmentFailure(segment_index, error.details() or "unretryable") from error
            last = error
            logger.warning("segment %d attempt %d lost the worker", segment_index, attempt + 1)
    raise SegmentFailure(segment_index, f"worker lost after {MAX_ATTEMPTS} attempts") from last


def encode_job(stub: grpc.Channel, job_id: str, segments, source_uri: str) -> None:
    """One segment at a time: losing a worker never re-encodes the whole file."""
    for segment_index, segment_seconds in enumerate(segments):
        encode_segment(stub, job_id, segment_index, segment_seconds, source_uri)
`,
    },
    typescript: {
      starter: `/** Worker client: flawed code that retries a corrupt segment forever. */
import * as grpc from '@grpc/grpc-js';

import {EncodeFileRequest, EncodeRequest} from './generated/workers_pb';

export interface WorkerStub {
  EncodeSegment: (request: EncodeRequest, options: grpc.CallOptions, callback: (error: Error | null) => void) => void;
  EncodeFile: (request: EncodeFileRequest, options: grpc.CallOptions, callback: (error: Error | null) => void) => void;
}

export async function encodeJob(worker: WorkerStub, jobId: string, segments: number[], sourceUri: string): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (const [segmentIndex] of segments.entries()) {
    const request = EncodeRequest.create({jobId, segmentIndex, sourceUri});
    while (true) {
      try {
        await new Promise<void>((resolve, reject) => {
          worker.EncodeSegment(request, {deadline: Date.now() + 30_000}, (error: Error | null) =>
            error === null ? resolve() : reject(error),
          );
        });
        break;
      } catch (error) {
        console.warn({segmentIndex, error}, 'segment failed, retrying');
      }
    }
  }
}

/** One call for the whole source, the way the starter started before segments existed. */
export async function encodeFile(worker: WorkerStub, jobId: string, sourceUri: string): Promise<void> {
  const request = EncodeFileRequest.create({jobId, sourceUri});
  await new Promise<void>((resolve, reject) => {
    worker.EncodeFile(request, {deadline: Date.now() + 30_000}, (error: Error | null) =>
      error === null ? resolve() : reject(error),
    );
  });
}
`,
      solution: `/** Worker client: length-scaled deadlines, two attempts, corrupt input terminal. */
import * as grpc from '@grpc/grpc-js';

import {EncodeRequest} from './generated/workers_pb';

export const DEADLINE_BASE_MS = 2000;
export const DEADLINE_PER_SECOND_MS = 500;
export const MAX_ATTEMPTS = 2;

const RETRYABLE = new Set<grpc.status>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

/** A segment that could not be encoded: the job fails naming this index. */
export class SegmentFailure extends Error {
  constructor(
    readonly segmentIndex: number,
    readonly reason: string,
  ) {
    super(\`segment \${segmentIndex}: \${reason}\`);
  }
}

/** A long segment gets proportionally more time; a short one fails fast. */
export function deadlineMs(segmentSeconds: number): number {
  return DEADLINE_BASE_MS + DEADLINE_PER_SECOND_MS * segmentSeconds;
}

/** Worker loss is retryable; corrupt input and anything else is terminal. */
export function isRetryable(error: grpc.ServiceError): boolean {
  return RETRYABLE.has(error.code);
}

export interface WorkerStub {
  EncodeSegment: (
    request: EncodeRequest,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null) => void,
  ) => void;
}

export async function encodeSegment(
  worker: WorkerStub,
  jobId: string,
  segmentIndex: number,
  segmentSeconds: number,
  sourceUri: string,
): Promise<void> {
  const request = EncodeRequest.create({jobId, segmentIndex, sourceUri});
  const deadline = Date.now() + deadlineMs(segmentSeconds);
  let last: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        worker.EncodeSegment(request, {deadline}, (error: grpc.ServiceError | null) =>
          error === null ? resolve() : reject(error),
        );
      });
      return;
    } catch (error) {
      const failure = error as grpc.ServiceError;
      if (failure.code === grpc.status.INVALID_ARGUMENT) throw new SegmentFailure(segmentIndex, 'corrupt input');
      if (!isRetryable(failure)) throw new SegmentFailure(segmentIndex, failure.details);
      last = failure;
    }
  }
  throw new SegmentFailure(segmentIndex, \`worker lost after \${MAX_ATTEMPTS} attempts: \${last?.details}\`);
}

/** One segment at a time: losing a worker never re-encodes the whole file. */
export async function encodeJob(
  worker: WorkerStub,
  jobId: string,
  segments: number[],
  sourceUri: string,
): Promise<void> {
  for (const [segmentIndex, segmentSeconds] of segments.entries()) {
    await encodeSegment(worker, jobId, segmentIndex, segmentSeconds, sourceUri);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"log"
	"time"
)

func encodeJob(ctx context.Context, worker WorkerClient, jobID string, segments []float64, sourceURI string) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for segmentIndex := range segments {
		request := &EncodeRequest{JobId: jobID, SegmentIndex: int32(segmentIndex), SourceUri: sourceURI}
		for {
			callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			_, err := worker.EncodeSegment(callCtx, request)
			cancel()
			if err == nil {
				break
			}
			log.Printf("segment %d failed: %v, retrying", segmentIndex, err)
		}
	}
	return nil
}

// encodeFile is one call for the whole source, the way the starter started before segments existed.
func encodeFile(ctx context.Context, worker WorkerClient, jobID, sourceURI string) error {
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err := worker.EncodeFile(callCtx, &EncodeFileRequest{JobId: jobID, SourceUri: sourceURI})
	if err != nil {
		return fmt.Errorf("encode file: %w", err)
	}
	return nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineBaseMS      = 2000
	deadlinePerSecondMS = 500
	maxAttempts         = 2
)

// SegmentFailure names the segment a job must fail on.
type SegmentFailure struct {
	SegmentIndex int
	Reason       string
}

func (e *SegmentFailure) Error() string {
	return fmt.Sprintf("segment %d: %s", e.SegmentIndex, e.Reason)
}

// deadlineMS gives a long segment proportionally more time; a short one fails fast.
func deadlineMS(segmentSeconds float64) time.Duration {
	return time.Duration(deadlineBaseMS+deadlinePerSecondMS*segmentSeconds) * time.Millisecond
}

// isRetryable separates worker loss from everything else; corrupt input is terminal.
func isRetryable(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

func encodeSegment(ctx context.Context, worker WorkerClient, jobID string, segmentIndex int, segmentSeconds float64, sourceURI string) error {
	request := &EncodeRequest{JobId: jobID, SegmentIndex: int32(segmentIndex), SourceUri: sourceURI}
	var last error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS(segmentSeconds))
		_, err := worker.EncodeSegment(callCtx, request)
		cancel()
		if err == nil {
			return nil
		}
		if status.Code(err) == codes.InvalidArgument {
			return &SegmentFailure{SegmentIndex: segmentIndex, Reason: "corrupt input"}
		}
		if !isRetryable(status.Code(err)) {
			return &SegmentFailure{SegmentIndex: segmentIndex, Reason: err.Error()}
		}
		last = err
	}
	return &SegmentFailure{SegmentIndex: segmentIndex, Reason: fmt.Sprintf("worker lost after %d attempts: %v", maxAttempts, last)}
}

// encodeJob encodes one segment at a time: losing a worker never re-encodes the whole file.
func encodeJob(ctx context.Context, worker WorkerClient, jobID string, segments []float64, sourceURI string) error {
	for segmentIndex, segmentSeconds := range segments {
		if err := encodeSegment(ctx, worker, jobID, segmentIndex, segmentSeconds, sourceURI); err != nil {
			return err
		}
	}
	return nil
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException

import scala.concurrent.duration._

object WorkerClient {

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def encodeJob(stub: WorkerGrpc.WorkerBlockingStub, jobId: String, segments: Seq[Double], sourceUri: String): Unit = {
    segments.zipWithIndex.foreach { case (_, segmentIndex) =>
      val request = EncodeRequest(jobId = jobId, segmentIndex = segmentIndex, sourceUri = sourceUri)
      var done = false
      while (!done) {
        try {
          stub.withDeadlineAfter(30, SECONDS).encodeSegment(request)
          done = true
        } catch {
          case e: StatusRuntimeException => println(s"segment $segmentIndex failed: $e, retrying")
        }
      }
    }
  }

  /** One call for the whole source, the way the starter started before segments existed. */
  def encodeFile(stub: WorkerGrpc.WorkerBlockingStub, jobId: String, sourceUri: String): Unit =
    stub.withDeadlineAfter(30, SECONDS).encodeFile(EncodeFileRequest(jobId = jobId, sourceUri = sourceUri))
}
`,
      solution: `import io.grpc.{Status, StatusRuntimeException}

import scala.concurrent.duration._

object WorkerClient {

  val DeadlineBaseMs = 2000
  val DeadlinePerSecondMs = 500
  val MaxAttempts = 2

  /** A segment that could not be encoded: the job fails naming this index. */
  final case class SegmentFailure(segmentIndex: Int, reason: String)
      extends RuntimeException(s"segment $segmentIndex: $reason")

  /** A long segment gets proportionally more time; a short one fails fast. */
  def deadlineMs(segmentSeconds: Double): Long = (DeadlineBaseMs + DeadlinePerSecondMs * segmentSeconds).toLong

  /** Worker loss is retryable; corrupt input and anything else is terminal. */
  def isRetryable(status: Status): Boolean =
    status.getCode == Status.Code.UNAVAILABLE || status.getCode == Status.Code.DEADLINE_EXCEEDED

  def encodeSegment(
      stub: WorkerGrpc.WorkerBlockingStub,
      jobId: String,
      segmentIndex: Int,
      segmentSeconds: Double,
      sourceUri: String
  ): Unit = {
    val request = EncodeRequest(jobId = jobId, segmentIndex = segmentIndex, sourceUri = sourceUri)
    var attempt = 0
    var last: StatusRuntimeException = null
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        stub.withDeadlineAfter(deadlineMs(segmentSeconds), MILLISECONDS).encodeSegment(request)
        return
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
          throw SegmentFailure(segmentIndex, "corrupt input")
        case e: StatusRuntimeException if !isRetryable(e.getStatus) =>
          throw SegmentFailure(segmentIndex, Option(e.getStatus.getDescription).getOrElse("unretryable"))
        case e: StatusRuntimeException =>
          last = e
      }
    }
    val reason = if (last == null) "worker loss" else last.getStatus.toString
    throw SegmentFailure(segmentIndex, s"worker lost after $MaxAttempts attempts: $reason")
  }

  /** One segment at a time: losing a worker never re-encodes the whole file. */
  def encodeJob(stub: WorkerGrpc.WorkerBlockingStub, jobId: String, segments: Seq[Double], sourceUri: String): Unit =
    segments.zipWithIndex.foreach { case (segmentSeconds, segmentIndex) =>
      encodeSegment(stub, jobId, segmentIndex, segmentSeconds, sourceUri)
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <vector>

#include "workers.grpc.pb.h"

void encodeJob(transcode::Worker::Stub& worker, const std::string& job_id, const std::vector<double>& segments,
               const std::string& source_uri) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (int segment_index = 0; segment_index < static_cast<int>(segments.size()); ++segment_index) {
    transcode::EncodeRequest request;
    request.set_job_id(job_id);
    request.set_segment_index(segment_index);
    request.set_source_uri(source_uri);
    while (true) {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(30));
      transcode::SegmentReply reply;
      const grpc::Status status = worker.EncodeSegment(&ctx, request, &reply);
      if (status.ok()) break;
      std::clog << "segment " << segment_index << " failed: " << status.error_message() << ", retrying" << std::endl;
    }
  }
}

/** One call for the whole source, the way the starter started before segments existed. */
void encodeFile(transcode::Worker::Stub& worker, const std::string& job_id, const std::string& source_uri) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(30));
  transcode::EncodeFileRequest request;
  request.set_job_id(job_id);
  request.set_source_uri(source_uri);
  transcode::SegmentReply reply;
  const grpc::Status status = worker.EncodeFile(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error(status.error_message());
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "workers.grpc.pb.h"

namespace {

constexpr int kDeadlineBaseMs = 2000;
constexpr int kDeadlinePerSecondMs = 500;
constexpr int kMaxAttempts = 2;

}  // namespace

/** A segment that could not be encoded: the job fails naming this index. */
struct SegmentFailure : std::runtime_error {
  SegmentFailure(int index, const std::string& reason)
      : std::runtime_error("segment " + std::to_string(index) + ": " + reason), segment_index(index), reason(reason) {}

  int segment_index;
  std::string reason;
};

/** A long segment gets proportionally more time; a short one fails fast. */
std::chrono::milliseconds deadlineMs(double segment_seconds) {
  return std::chrono::milliseconds(static_cast<long long>(kDeadlineBaseMs + kDeadlinePerSecondMs * segment_seconds));
}

/** Worker loss is retryable; corrupt input and anything else is terminal. */
bool isRetryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::UNAVAILABLE ||
         status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

void encodeSegment(transcode::Worker::Stub& worker, const std::string& job_id, int segment_index,
                   double segment_seconds, const std::string& source_uri) {
  transcode::EncodeRequest request;
  request.set_job_id(job_id);
  request.set_segment_index(segment_index);
  request.set_source_uri(source_uri);
  const auto deadline = std::chrono::system_clock::now() + deadlineMs(segment_seconds);
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(deadline);
    transcode::SegmentReply reply;
    const grpc::Status status = worker.EncodeSegment(&ctx, request, &reply);
    if (status.ok()) return;
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) throw SegmentFailure(segment_index, "corrupt input");
    if (!isRetryable(status)) throw SegmentFailure(segment_index, status.error_message());
  }
  throw SegmentFailure(segment_index, "worker lost after two attempts");
}

/** One segment at a time: losing a worker never re-encodes the whole file. */
void encodeJob(transcode::Worker::Stub& worker, const std::string& job_id, const std::vector<double>& segments,
               const std::string& source_uri) {
  for (int segment_index = 0; segment_index < static_cast<int>(segments.size()); ++segment_index) {
    encodeSegment(worker, job_id, segment_index, segments[segment_index], source_uri);
  }
}
`,
    },
  },
  hints: [
    'One job has been "encoding" for six hours on a 90-minute file; the worker log is the same line thousands of times, and nobody can tell the operator which segment is stuck.',
    '`while True` around a 30 s call retries `INVALID_ARGUMENT` the same as a dead worker, so corrupt bytes loop forever; the raise at the end carries no index, and `encode_file` restarts the whole source.',
    'Add `is_retryable` (only `UNAVAILABLE`, `DEADLINE_EXCEEDED`), loop `for attempt in range(MAX_ATTEMPTS)`, set `timeout` from base plus per-second, raise `SegmentFailure(segment_index, reason)`, and delete `encode_file`.',
  ],
  debrief: `The fix starts with classification because everything else follows from it: once \`is_retryable\` says that only worker loss is worth a second try, a bounded loop of two attempts is enough, and corrupt input exits on the first. The deadline scales with segment length because the encoder's cost does; one ceiling is wrong for both a 2-second tail and a 6-minute chapter. Keeping retries inside the segment matters twice: the encoder is the expensive part of the pipeline, and with the claim tracker a whole-file retry cannot even fill the hole, since finished indices are skipped. The index on the failure lets the job row and the event name the segment. What this step did not do: a production client puts jittered backoff between the two attempts so a rebooting worker pool is not hit twice in one second.`,
};
