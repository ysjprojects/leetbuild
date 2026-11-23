import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'gRPC EncodeSegment: the segment span, a scaled deadline, two attempts',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['api', 'worker', 'source'],
  task: `## Task

**Starting point.** The starter is the worker's encoder client: \`encode_segment(job, index)\`
sends \`EncodeSegment\` with \`start_s = 0\` and the job's whole \`duration_s\`, a fixed 30 s
timeout, retries any error up to five times and re-raises the last \`RpcError\`. With a healthy
encoder it returns \`{index, output_key, duration_s}\` and it hides five flaws.

**Failure mode the checks target.** Every segment re-encodes the whole file; one timeout is too
long for a two-second tail and too short for a long chapter; corrupt bytes are sent five times;
and the error that reaches the job names no segment.

\`\`\`proto
service Encoder { rpc EncodeSegment(SegmentRequest) returns (SegmentResult); }
// INVALID_ARGUMENT: the decoder cannot read these bytes · UNAVAILABLE: the worker is gone
\`\`\`

- The request carries the segment's own span, \`jobs.segment_span(job["duration_s"], index)\`.
- Each attempt's deadline is \`DEADLINE_BASE_S\` (2 s) plus \`DEADLINE_PER_SECOND_S\` (0.5 s) per
  second of that span.
- At most \`MAX_ATTEMPTS\` = 2 attempts; \`is_retryable\` allows a second one only for
  \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`.
- A segment that finally fails raises \`SegmentFailed(index, code)\`.`,
  sequence: {
    participants: ['Worker loop', 'Encoder client', 'Encoder worker'],
    messages: [
      {from: 'Worker loop', to: 'Encoder client', label: 'encode_segment(job, 7)', kind: 'sync'},
      {
        from: 'Encoder client',
        to: 'Encoder client',
        label: 'segment_span → start 42 s, 6 s · deadline 2 + 0.5 × 6 = 5 s',
        kind: 'sync',
      },
      {from: 'Encoder client', to: 'Encoder worker', label: 'EncodeSegment · attempt 1', kind: 'sync'},
      {from: 'Encoder worker', to: 'Encoder client', label: 'UNAVAILABLE → retryable', kind: 'reply'},
      {from: 'Encoder client', to: 'Encoder worker', label: 'EncodeSegment · attempt 2', kind: 'sync'},
      {from: 'Encoder worker', to: 'Encoder client', label: 'SegmentResult · or SegmentFailed(7, code)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'segment-range',
      title: 'Asks for the segment span, not the whole source',
      detail:
        'The request carries `segment_span(duration_s, index)`: segment 2 of a 14-second source is `start_s` 12, `duration_s` 2. The starter sends start 0 and the whole duration for every segment.',
      match: {
        python: {all: [/jobs\.segment_span\(/], none: [/start_s\s*=\s*0\b/]},
        typescript: {all: [/\bsegmentSpan\(/], none: [/start_s:\s*0\b/]},
        go: {all: [/jobs\.SegmentSpan\(/], none: [/StartS:\s*0\b/]},
        cpp: {all: [/jobs::segmentSpan\(/], none: [/set_start_s\(\s*0\s*\)/]},
      },
    },
    {
      id: 'scaled-deadline',
      title: "Each attempt's deadline scales with the segment's length",
      detail:
        'The deadline is `DEADLINE_BASE_S` + `DEADLINE_PER_SECOND_S` × the span length (5 s for 6 s, 3 s for a 2-second tail), set in full on every attempt, even after a first attempt that failed late; the starter gives every call 30 s.',
      match: {
        python: {
          all: [
            /DEADLINE_BASE_S\s*=\s*2/,
            /DEADLINE_PER_SECOND_S\s*=\s*0?\.5/,
            /timeout\s*=\s*\w*deadline|timeout\s*=\s*DEADLINE_BASE_S/,
          ],
          none: [/timeout\s*=\s*30\b/],
        },
        typescript: {
          all: [
            /DEADLINE_BASE_MS\s*=\s*2_?000/,
            /DEADLINE_PER_SECOND_MS\s*=\s*500/,
            /deadline:\s*Date\.now\(\)\s*\+\s*deadlineMs/,
          ],
          none: [/Date\.now\(\)\s*\+\s*30_?000/],
        },
        go: {
          all: [
            /deadlineBase\s*=\s*2\s*\*\s*time\.Second/,
            /deadlinePerSecond\s*=\s*500\s*\*\s*time\.Millisecond/,
            /context\.WithTimeout\([^\n]*deadline\)/,
          ],
          none: [/30\s*\*\s*time\.Second/],
        },
        cpp: {
          all: [/kDeadlineBaseMs\s*=\s*2000/, /kDeadlinePerSecondMs\s*=\s*500/, /set_deadline\([^\n]*deadline_ms/],
          none: [/seconds\{30\}|seconds\(30\)/],
        },
      },
    },
    {
      id: 'bounded-attempts',
      title: 'At most two attempts per segment',
      detail:
        '`MAX_ATTEMPTS` = 2 bounds the loop: a worker that answers UNAVAILABLE twice fails the segment instead of being asked five times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /range\([^\n]*MAX_ATTEMPTS/], none: [/range\(\s*5\s*\)/]},
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*2\b/, /attempt\s*(===|<|<=)\s*MAX_ATTEMPTS/],
          none: [/attempt\s*<\s*5\b/],
        },
        go: {
          all: [/maxAttempts\s*=\s*2\b/, /attempt\s*==\s*maxAttempts|attempt\s*<=?\s*maxAttempts/],
          none: [/attempt\s*<=?\s*5\b/],
        },
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /attempt\s*(==|<|<=)\s*kMaxAttempts/], none: [/attempt\s*<=?\s*5\b/]},
      },
    },
    {
      id: 'classify',
      title: 'INVALID_ARGUMENT is terminal, a lost worker is retryable',
      detail:
        'One classification, `is_retryable`, allows a second attempt for UNAVAILABLE and DEADLINE_EXCEEDED only; corrupt input (INVALID_ARGUMENT) and every other status fail on the first answer. The starter retries every status alike.',
      match: {
        python: {all: [/def is_retryable/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /is_retryable\(\s*exc\.code\(\)/]},
        typescript: {
          all: [/function isRetryable|const isRetryable/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /isRetryable\(\s*code/],
        },
        go: {all: [/func isRetryable/, /codes\.Unavailable/, /codes\.DeadlineExceeded/, /isRetryable\(\s*code/]},
        cpp: {all: [/bool isRetryable/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /isRetryable\(\s*code/]},
      },
    },
    {
      id: 'fail-with-index',
      title: 'A failed segment raises SegmentFailed with its index',
      detail:
        'The final failure is `SegmentFailed(index, code)`, so the worker can record which segment failed and why; the starter re-raises a bare RPC error that names no segment.',
      match: {
        python: {all: [/raise SegmentFailed\(\s*index/]},
        typescript: {all: [/throw new SegmentFailed\(\s*index/]},
        go: {all: [/&SegmentFailed\{\s*Index:\s*index/]},
        cpp: {all: [/throw SegmentFailed\(\s*index/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import media_transcoder_pb2
import media_transcoder_pb2_grpc
from transcoder import jobs  # jobs.segment_span(duration_s, index) -> (start_s, length_s)

log = logging.getLogger("encoder")

encoder = media_transcoder_pb2_grpc.EncoderStub(grpc.insecure_channel("encoder:9000"))


class SegmentFailed(Exception):
    """A segment the encoder could not produce: its index and the final status code."""

    def __init__(self, index: int, code: grpc.StatusCode, details: str = ""):
        super().__init__(f"segment {index} failed: {code.name} {details}".rstrip())
        self.index = index
        self.code = code


def encode_segment(job: dict, index: int) -> dict:
    """Encode segment index of the job; returns {index, output_key, duration_s}."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    request = media_transcoder_pb2.SegmentRequest(
        job_id=job["job_id"],
        index=index,
        source_uri=job["source_uri"],
        start_s=0,
        duration_s=job["duration_s"],
        preset=job["preset"],
        encoder_args=job["encoder_args"],
    )
    last = None
    for attempt in range(5):
        try:
            result = encoder.EncodeSegment(request, timeout=30)
            return {"index": result.index, "output_key": result.output_key, "duration_s": result.duration_s}
        except grpc.RpcError as exc:
            log.warning("segment %d attempt %d failed: %s", index, attempt + 1, exc.code())
            last = exc
    raise last
`,
      solution: `import logging

import grpc

import media_transcoder_pb2
import media_transcoder_pb2_grpc
from transcoder import jobs  # jobs.segment_span(duration_s, index) -> (start_s, length_s)

log = logging.getLogger("encoder")

DEADLINE_BASE_S = 2.0
DEADLINE_PER_SECOND_S = 0.5
MAX_ATTEMPTS = 2

encoder = media_transcoder_pb2_grpc.EncoderStub(grpc.insecure_channel("encoder:9000"))


class SegmentFailed(Exception):
    """A segment the encoder could not produce: its index and the final status code."""

    def __init__(self, index: int, code: grpc.StatusCode, details: str = ""):
        super().__init__(f"segment {index} failed: {code.name} {details}".rstrip())
        self.index = index
        self.code = code


def is_retryable(code: grpc.StatusCode) -> bool:
    """A lost or slow worker may succeed on another try; bytes the decoder rejected never will."""
    return code in (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)


def encode_segment(job: dict, index: int) -> dict:
    """Encode segment index of the job; returns {index, output_key, duration_s}."""
    start_s, length_s = jobs.segment_span(job["duration_s"], index)
    request = media_transcoder_pb2.SegmentRequest(
        job_id=job["job_id"],
        index=index,
        source_uri=job["source_uri"],
        start_s=start_s,
        duration_s=length_s,
        preset=job["preset"],
        encoder_args=job["encoder_args"],
    )
    # The encode's cost grows with the segment's length, so its deadline does too.
    deadline = DEADLINE_BASE_S + DEADLINE_PER_SECOND_S * length_s
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            result = encoder.EncodeSegment(request, timeout=deadline)
            return {"index": result.index, "output_key": result.output_key, "duration_s": result.duration_s}
        except grpc.RpcError as exc:
            if not is_retryable(exc.code()) or attempt == MAX_ATTEMPTS:
                raise SegmentFailed(index, exc.code(), exc.details() or "") from exc
            log.warning("segment %d attempt %d failed: %s", index, attempt, exc.code())
    raise AssertionError("unreachable")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Job, segmentSpan} from 'transcoder/jobs';

export interface SegmentOutput {
  index: number;
  output_key: string;
  duration_s: number;
}

interface SegmentRequest {
  job_id: string;
  index: number;
  source_uri: string;
  start_s: number;
  duration_s: number;
  preset: string;
  encoder_args: string[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('media_transcoder.proto')) as unknown as {
  transcoderd: {Encoder: grpc.ServiceClientConstructor};
};
const encoder = new pkg.transcoderd.Encoder('encoder:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  EncodeSegment(request: SegmentRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<SegmentOutput>;
};

/** A segment the encoder could not produce: its index and the final status code. */
export class SegmentFailed extends Error {
  constructor(
    readonly index: number,
    readonly code: grpc.status,
    details = '',
  ) {
    super(\`segment \${index} failed: \${grpc.status[code]} \${details}\`.trimEnd());
  }
}

/** Encode segment index of the job. */
export async function encodeSegment(job: Job, index: number): Promise<SegmentOutput> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const request: SegmentRequest = {
    job_id: job.job_id,
    index,
    source_uri: job.source_uri,
    start_s: 0,
    duration_s: job.duration_s,
    preset: job.preset,
    encoder_args: job.encoder_args,
  };
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const {output_key, duration_s} = await encoder.EncodeSegment(request, new grpc.Metadata(), {deadline: Date.now() + 30_000});
      return {index, output_key, duration_s};
    } catch (e) {
      console.warn(\`segment \${index} attempt \${attempt + 1} failed: \${(e as grpc.ServiceError).code}\`);
      last = e;
    }
  }
  throw last;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Job, segmentSpan} from 'transcoder/jobs';

export const DEADLINE_BASE_MS = 2000;
export const DEADLINE_PER_SECOND_MS = 500;
export const MAX_ATTEMPTS = 2;

export interface SegmentOutput {
  index: number;
  output_key: string;
  duration_s: number;
}

interface SegmentRequest {
  job_id: string;
  index: number;
  source_uri: string;
  start_s: number;
  duration_s: number;
  preset: string;
  encoder_args: string[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('media_transcoder.proto')) as unknown as {
  transcoderd: {Encoder: grpc.ServiceClientConstructor};
};
const encoder = new pkg.transcoderd.Encoder('encoder:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  EncodeSegment(request: SegmentRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<SegmentOutput>;
};

/** A segment the encoder could not produce: its index and the final status code. */
export class SegmentFailed extends Error {
  constructor(
    readonly index: number,
    readonly code: grpc.status,
    details = '',
  ) {
    super(\`segment \${index} failed: \${grpc.status[code]} \${details}\`.trimEnd());
  }
}

/** A lost or slow worker may succeed on another try; bytes the decoder rejected never will. */
export function isRetryable(code: grpc.status): boolean {
  return code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED;
}

/** Encode segment index of the job. */
export async function encodeSegment(job: Job, index: number): Promise<SegmentOutput> {
  const [startS, lengthS] = segmentSpan(job.duration_s, index);
  const request: SegmentRequest = {
    job_id: job.job_id,
    index,
    source_uri: job.source_uri,
    start_s: startS,
    duration_s: lengthS,
    preset: job.preset,
    encoder_args: job.encoder_args,
  };
  // The encode's cost grows with the segment's length, so its deadline does too.
  const deadlineMs = DEADLINE_BASE_MS + DEADLINE_PER_SECOND_MS * lengthS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const {output_key, duration_s} = await encoder.EncodeSegment(request, new grpc.Metadata(), {deadline: Date.now() + deadlineMs});
      return {index, output_key, duration_s};
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (!isRetryable(code) || attempt === MAX_ATTEMPTS) throw new SegmentFailed(index, code, details);
      console.warn(\`segment \${index} attempt \${attempt} failed: \${grpc.status[code]}\`);
    }
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

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"

	pb "transcoder/gen/media_transcoder"
	"transcoder/jobs" // jobs.Job, jobs.SegmentSpan(durationS, index) (startS, lengthS)
)

var (
	encoderConn, _ = grpc.NewClient("encoder:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	encoder        = pb.NewEncoderClient(encoderConn)
)

// SegmentOutput is what the encoder produced for one segment.
type SegmentOutput struct {
	Index     int
	OutputKey string
	DurationS float64
}

// SegmentFailed is a segment the encoder could not produce: its index and the final status code.
type SegmentFailed struct {
	Index   int
	Code    codes.Code
	Message string
}

func (e *SegmentFailed) Error() string {
	return fmt.Sprintf("segment %d failed: %v %s", e.Index, e.Code, e.Message)
}

// encodeSegment encodes segment index of the job.
func encodeSegment(ctx context.Context, job *jobs.Job, index int) (SegmentOutput, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	req := &pb.SegmentRequest{
		JobId:       job.JobID,
		Index:       int32(index),
		SourceUri:   job.SourceURI,
		StartS:      0,
		DurationS:   job.DurationS,
		Preset:      job.Preset,
		EncoderArgs: job.EncoderArgs,
	}
	var last error
	for attempt := 1; attempt <= 5; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		res, err := encoder.EncodeSegment(callCtx, req)
		cancel()
		if err == nil {
			return SegmentOutput{Index: int(res.GetIndex()), OutputKey: res.GetOutputKey(), DurationS: res.GetDurationS()}, nil
		}
		log.Printf("segment %d attempt %d failed: %v", index, attempt, err)
		last = err
	}
	return SegmentOutput{}, last
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "transcoder/gen/media_transcoder"
	"transcoder/jobs" // jobs.Job, jobs.SegmentSpan(durationS, index) (startS, lengthS)
)

const (
	deadlineBase      = 2 * time.Second
	deadlinePerSecond = 500 * time.Millisecond
	maxAttempts       = 2
)

var (
	encoderConn, _ = grpc.NewClient("encoder:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	encoder        = pb.NewEncoderClient(encoderConn)
)

// SegmentOutput is what the encoder produced for one segment.
type SegmentOutput struct {
	Index     int
	OutputKey string
	DurationS float64
}

// SegmentFailed is a segment the encoder could not produce: its index and the final status code.
type SegmentFailed struct {
	Index   int
	Code    codes.Code
	Message string
}

func (e *SegmentFailed) Error() string {
	return fmt.Sprintf("segment %d failed: %v %s", e.Index, e.Code, e.Message)
}

// isRetryable: a lost or slow worker may succeed on another try; bytes the decoder rejected never will.
func isRetryable(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

// encodeSegment encodes segment index of the job.
func encodeSegment(ctx context.Context, job *jobs.Job, index int) (SegmentOutput, error) {
	startS, lengthS := jobs.SegmentSpan(job.DurationS, index)
	req := &pb.SegmentRequest{
		JobId:       job.JobID,
		Index:       int32(index),
		SourceUri:   job.SourceURI,
		StartS:      startS,
		DurationS:   lengthS,
		Preset:      job.Preset,
		EncoderArgs: job.EncoderArgs,
	}
	// The encode's cost grows with the segment's length, so its deadline does too.
	deadline := deadlineBase + time.Duration(lengthS*float64(deadlinePerSecond))
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		res, err := encoder.EncodeSegment(callCtx, req)
		cancel()
		if err == nil {
			return SegmentOutput{Index: int(res.GetIndex()), OutputKey: res.GetOutputKey(), DurationS: res.GetDurationS()}, nil
		}
		code := status.Code(err)
		if !isRetryable(code) || attempt == maxAttempts {
			return SegmentOutput{}, &SegmentFailed{Index: index, Code: code, Message: status.Convert(err).Message()}
		}
		log.Printf("segment %d attempt %d failed: %v", index, attempt, code)
	}
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>

#include "media_transcoder.grpc.pb.h"
#include "transcoder/jobs.h"  // jobs::Job, jobs::segmentSpan(duration_s, index) -> (start_s, length_s)

auto encoder = transcoderd::Encoder::NewStub(grpc::CreateChannel("encoder:9000", grpc::InsecureChannelCredentials()));

// What the encoder produced for one segment.
struct SegmentOutput {
  int index = 0;
  std::string output_key;
  double duration_s = 0;
};

// A segment the encoder could not produce: its index and the final status code.
struct SegmentFailed : std::runtime_error {
  SegmentFailed(int index, grpc::StatusCode code, const std::string& details)
      : std::runtime_error("segment " + std::to_string(index) + " failed: " + details), index(index), code(code) {}
  int index;
  grpc::StatusCode code;
};

// Encode segment index of the job.
SegmentOutput encodeSegment(const jobs::Job& job, int index) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  transcoderd::SegmentRequest request;
  request.set_job_id(job.job_id);
  request.set_index(index);
  request.set_source_uri(job.source_uri);
  request.set_start_s(0);
  request.set_duration_s(job.duration_s);
  request.set_preset(job.preset);
  for (const std::string& arg : job.encoder_args) request.add_encoder_args(arg);
  grpc::Status last;
  for (int attempt = 1; attempt <= 5; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{30});
    transcoderd::SegmentResult result;
    const grpc::Status status = encoder->EncodeSegment(&ctx, request, &result);
    if (status.ok()) return SegmentOutput{result.index(), result.output_key(), result.duration_s()};
    std::cerr << "segment " << index << " attempt " << attempt << " failed: " << status.error_message() << "\\n";
    last = status;
  }
  throw std::runtime_error(last.error_message());
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>

#include "media_transcoder.grpc.pb.h"
#include "transcoder/jobs.h"  // jobs::Job, jobs::segmentSpan(duration_s, index) -> (start_s, length_s)

constexpr long long kDeadlineBaseMs = 2000;
constexpr long long kDeadlinePerSecondMs = 500;
constexpr int kMaxAttempts = 2;

auto encoder = transcoderd::Encoder::NewStub(grpc::CreateChannel("encoder:9000", grpc::InsecureChannelCredentials()));

// What the encoder produced for one segment.
struct SegmentOutput {
  int index = 0;
  std::string output_key;
  double duration_s = 0;
};

// A segment the encoder could not produce: its index and the final status code.
struct SegmentFailed : std::runtime_error {
  SegmentFailed(int index, grpc::StatusCode code, const std::string& details)
      : std::runtime_error("segment " + std::to_string(index) + " failed: " + details), index(index), code(code) {}
  int index;
  grpc::StatusCode code;
};

// A lost or slow worker may succeed on another try; bytes the decoder rejected never will.
bool isRetryable(grpc::StatusCode code) { return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED; }

// Encode segment index of the job.
SegmentOutput encodeSegment(const jobs::Job& job, int index) {
  const auto [start_s, length_s] = jobs::segmentSpan(job.duration_s, index);
  transcoderd::SegmentRequest request;
  request.set_job_id(job.job_id);
  request.set_index(index);
  request.set_source_uri(job.source_uri);
  request.set_start_s(start_s);
  request.set_duration_s(length_s);
  request.set_preset(job.preset);
  for (const std::string& arg : job.encoder_args) request.add_encoder_args(arg);
  // The encode's cost grows with the segment's length, so its deadline does too.
  const auto deadline_ms = std::chrono::milliseconds(kDeadlineBaseMs + static_cast<long long>(kDeadlinePerSecondMs * length_s));
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + deadline_ms);
    transcoderd::SegmentResult result;
    const grpc::Status status = encoder->EncodeSegment(&ctx, request, &result);
    if (status.ok()) return SegmentOutput{result.index(), result.output_key(), result.duration_s()};
    const grpc::StatusCode code = status.error_code();
    if (!isRetryable(code) || attempt == kMaxAttempts) throw SegmentFailed(index, code, status.error_message());
    std::cerr << "segment " << index << " attempt " << attempt << " failed: " << status.error_message() << "\\n";
  }
}
`,
    },
  },
  harness: {
    python: `import grpc

import media_transcoder_pb2
import media_transcoder_pb2_grpc
from transcoder import jobs, presets


class Encoder(media_transcoder_pb2_grpc.EncoderServicer):
    """Encodes whatever span it is asked for."""

    def EncodeSegment(self, request, context):
        return media_transcoder_pb2.SegmentResult(index=request.index, output_key=f"talks/42/{request.preset}/seg-{request.index:05d}.ts", duration_s=request.duration_s)


class DrainedMidEncode(Encoder):
    """The first call runs 4 s of the encode and then loses its worker (UNAVAILABLE); later calls encode."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.seen = 0

    def EncodeSegment(self, request, context):
        self.seen += 1
        if self.seen == 1:
            self.ctx.clock.advance(4)
            context.abort(grpc.StatusCode.UNAVAILABLE, "worker drained mid-encode")
        return super().EncodeSegment(request, context)


def _client(ctx, duration=14.0):
    ctx.grpc.serve(media_transcoder_pb2_grpc.add_EncoderServicer_to_server, Encoder())
    job = jobs.create("t-1", "s3://uploads/talk.mov", "9f" * 32, duration, "h264-720p", presets.encoder_args("h264-720p"), "renditions", "talks/42")
    return ctx.load("client"), job


def _calls(ctx):
    return ctx.grpc.calls_to("EncodeSegment")


def _fails(m, job, index, why):
    try:
        out = m.encode_segment(job, index)
    except m.SegmentFailed as exc:
        return exc
    except Exception as other:
        raise AssertionError(f"{why}: encode_segment raised {type(other).__name__}: {other}, expected SegmentFailed carrying the segment index")
    raise AssertionError(f"{why}: encode_segment returned {out} instead of raising SegmentFailed")


def check_segment_range(ctx):
    m, job = _client(ctx)
    outs = [m.encode_segment(job, i) for i in range(3)]
    spans = [(c.request.start_s, c.request.duration_s) for c in _calls(ctx)]
    assert spans == [(0, 6), (6, 6), (12, 2)], f"the three segments of a 14-second source asked the encoder for spans (start_s, duration_s) {spans}, expected [(0, 6), (6, 6), (12, 2)]: each segment encodes its own span, not the whole file"
    first = _calls(ctx)[0].request
    assert first.job_id == job["job_id"] and first.preset == "h264-720p" and list(first.encoder_args) == job["encoder_args"], f"the request must carry the job id, preset and encoder arguments, got {first}"
    assert [o["index"] for o in outs] == [0, 1, 2] and outs[2]["duration_s"] == 2, f"encode_segment answered {outs}"


def check_scaled_deadline(ctx):
    m, job = _client(ctx)
    for i in range(3):
        m.encode_segment(job, i)
    for call in _calls(ctx):
        want = 2.0 + 0.5 * call.request.duration_s
        assert call.timeout is not None and abs(call.timeout - want) < 0.1, f"a call for a {call.request.duration_s} s span carries a {call.timeout} s deadline, expected DEADLINE_BASE_S + DEADLINE_PER_SECOND_S × length = {want} s"
    ctx.grpc.fail("EncodeSegment", grpc.StatusCode.UNAVAILABLE, "worker drained")
    m.encode_segment(job, 1)
    retry = _calls(ctx)[-1]
    assert abs(retry.timeout - (2.0 + 0.5 * retry.request.duration_s)) < 0.1, f"the second attempt carries a {retry.timeout} s deadline: every attempt gets the scaled deadline"
    # The first attempt fails late, 4 s into its 5 s: the retry still gets a deadline of its own.
    ctx.grpc.serve(media_transcoder_pb2_grpc.add_EncoderServicer_to_server, DrainedMidEncode(ctx))
    before = len(_calls(ctx))
    try:
        m.encode_segment(job, 0)
    except Exception as exc:
        raise AssertionError(f"segment 0's first attempt lost its worker 4 s into its 5 s deadline and the retry failed with {exc!r}: every attempt carries the full scaled deadline, not what is left of the first one") from exc
    late = _calls(ctx)[before:]
    assert len(late) == 2 and abs(late[1].timeout - 5.0) < 0.1, f"after a first attempt that failed 4 s in, the retry of a 6 s segment carried a {late[-1].timeout} s deadline over {len(late)} calls: every attempt gets the full 5 s"


def check_bounded_attempts(ctx):
    m, job = _client(ctx)
    ctx.grpc.fail("EncodeSegment", grpc.StatusCode.UNAVAILABLE, "worker drained")
    out = m.encode_segment(job, 0)
    assert len(_calls(ctx)) == 2 and out["index"] == 0, f"one UNAVAILABLE then success took {len(_calls(ctx))} calls and answered {out}: a lost worker earns one retry"
    ctx.grpc.fail("EncodeSegment", grpc.StatusCode.UNAVAILABLE, "worker drained", times=2)
    _fails(m, job, 1, "after two UNAVAILABLE answers for segment 1")
    assert len(_calls(ctx)) == 4, f"segment 1 was attempted {len(_calls(ctx)) - 2} times: at most MAX_ATTEMPTS = 2"


def check_classify(ctx):
    m, job = _client(ctx)
    ctx.grpc.fail("EncodeSegment", grpc.StatusCode.DEADLINE_EXCEEDED, "slow worker")
    m.encode_segment(job, 0)
    assert len(_calls(ctx)) == 2, f"a DEADLINE_EXCEEDED took {len(_calls(ctx))} calls: it is retryable, once"
    ctx.grpc.fail("EncodeSegment", grpc.StatusCode.INVALID_ARGUMENT, "invalid NAL unit at 00:00:07")
    exc = _fails(m, job, 1, "with corrupt bytes in segment 1 (INVALID_ARGUMENT)")
    assert len(_calls(ctx)) == 3, f"corrupt input was sent to the encoder {len(_calls(ctx)) - 2} times: INVALID_ARGUMENT is terminal, the first answer decides"
    assert exc.code == grpc.StatusCode.INVALID_ARGUMENT, f"the failure carries {exc.code}, expected INVALID_ARGUMENT"
    # Only UNAVAILABLE and DEADLINE_EXCEEDED earn a second attempt: every other status is terminal.
    for code in (grpc.StatusCode.INTERNAL, grpc.StatusCode.UNKNOWN, grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.FAILED_PRECONDITION, grpc.StatusCode.NOT_FOUND):
        before = len(_calls(ctx))
        ctx.grpc.fail("EncodeSegment", code, "encoder refused the segment")
        exc = _fails(m, job, 2, f"with the encoder answering {code.name} for segment 2")
        assert len(_calls(ctx)) - before == 1 and exc.code == code, f"a {code.name} answer took {len(_calls(ctx)) - before} calls and failed with {exc.code}: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, {code.name} fails on the first answer"


def check_fail_with_index(ctx):
    m, job = _client(ctx, duration=30.0)
    ctx.grpc.fail("EncodeSegment", grpc.StatusCode.UNAVAILABLE, "worker drained", times=5)
    exc = _fails(m, job, 4, "with every worker gone while encoding segment 4")
    assert exc.index == 4 and exc.code == grpc.StatusCode.UNAVAILABLE, f"the failure says segment {exc.index}, {exc.code}: it must name segment 4 and UNAVAILABLE"
`,
    typescript: `function client(ctx, duration = 14) {
  const pkg = ctx.proto('media_transcoder.proto');
  ctx.grpc.serve(pkg.transcoderd.Encoder.service, {
    EncodeSegment(call, callback) {
      const {index, preset, duration_s} = call.request;
      callback(null, {index, output_key: \`talks/42/\${preset}/seg-\${String(index).padStart(5, '0')}.ts\`, duration_s});
    },
  });
  const jobs = ctx.load('/support/transcoder/jobs.ts');
  const presets = ctx.load('/support/transcoder/presets.ts');
  const m = ctx.load('client');
  const job = jobs.create('t-1', 's3://uploads/talk.mov', '9f'.repeat(32), duration, 'h264-720p', presets.encoderArgs('h264-720p'), 'renditions', 'talks/42');
  return {m, job};
}

const calls = ctx => ctx.grpc.callsTo('EncodeSegment');

async function fails(m, job, index: number, why: string) {
  let out;
  try {
    out = await m.encodeSegment(job, index);
  } catch (e) {
    if (e instanceof m.SegmentFailed) return e;
    assert.fail(\`\${why}: encodeSegment threw \${(e as Error).constructor?.name}: \${(e as Error).message}, expected SegmentFailed carrying the segment index\`);
  }
  assert.fail(\`\${why}: encodeSegment returned \${JSON.stringify(out)} instead of throwing SegmentFailed\`);
}

export async function check_segment_range(ctx) {
  const {m, job: pending} = client(ctx);
  const job = await pending;
  const outs = [];
  for (let i = 0; i < 3; i += 1) outs.push(await m.encodeSegment(job, i));
  const spans = calls(ctx).map(c => [Number(c.request.start_s), Number(c.request.duration_s)]);
  assert.deepStrictEqual(spans, [[0, 6], [6, 6], [12, 2]], \`the three segments of a 14-second source asked the encoder for spans \${JSON.stringify(spans)}, expected [[0,6],[6,6],[12,2]]: each segment encodes its own span, not the whole file\`);
  const first = calls(ctx)[0].request;
  assert(first.job_id === job.job_id && first.preset === 'h264-720p' && JSON.stringify(first.encoder_args) === JSON.stringify(job.encoder_args), \`the request must carry the job id, preset and encoder arguments, got \${JSON.stringify(first)}\`);
  assert(outs.map(o => o.index).join() === '0,1,2' && Number(outs[2].duration_s) === 2, \`encodeSegment answered \${JSON.stringify(outs)}\`);
}

export async function check_scaled_deadline(ctx) {
  const {m, job: pending} = client(ctx);
  const job = await pending;
  for (let i = 0; i < 3; i += 1) await m.encodeSegment(job, i);
  for (const call of calls(ctx)) {
    const want = 2 + 0.5 * Number(call.request.duration_s);
    assert(call.timeout !== null && Math.abs(call.timeout - want) < 0.1, \`a call for a \${call.request.duration_s} s span carries a \${call.timeout} s deadline, expected DEADLINE_BASE_MS + DEADLINE_PER_SECOND_MS × length = \${want} s\`);
  }
  ctx.grpc.fail('EncodeSegment', ctx.grpc.status.UNAVAILABLE, 'worker drained');
  await m.encodeSegment(job, 1);
  const retry = calls(ctx).at(-1);
  assert(Math.abs(retry.timeout - (2 + 0.5 * Number(retry.request.duration_s))) < 0.1, \`the second attempt carries a \${retry.timeout} s deadline: every attempt gets the scaled deadline\`);
  // The first attempt fails late, 4 s into its 5 s: the retry still gets a deadline of its own.
  let seen = 0;
  ctx.grpc.serve(ctx.proto('media_transcoder.proto').transcoderd.Encoder.service, {
    EncodeSegment(call, callback) {
      seen += 1;
      if (seen === 1) {
        ctx.clock.advance(4);
        callback({code: ctx.grpc.status.UNAVAILABLE, details: 'worker drained mid-encode'});
        return;
      }
      const {index, preset, duration_s} = call.request;
      callback(null, {index, output_key: \`talks/42/\${preset}/seg-\${String(index).padStart(5, '0')}.ts\`, duration_s});
    },
  });
  const before = calls(ctx).length;
  try {
    await m.encodeSegment(job, 0);
  } catch (e) {
    assert.fail(\`segment 0's first attempt lost its worker 4 s into its 5 s deadline and the retry failed with \${(e as Error).message}: every attempt carries the full scaled deadline, not what is left of the first one\`);
  }
  const late = calls(ctx).slice(before);
  assert(late.length === 2 && Math.abs(late[1].timeout - 5) < 0.1, \`after a first attempt that failed 4 s in, the retry of a 6 s segment carried a \${late.at(-1)?.timeout} s deadline over \${late.length} calls: every attempt gets the full 5 s\`);
}

export async function check_bounded_attempts(ctx) {
  const {m, job: pending} = client(ctx);
  const job = await pending;
  ctx.grpc.fail('EncodeSegment', ctx.grpc.status.UNAVAILABLE, 'worker drained');
  const out = await m.encodeSegment(job, 0);
  assert(calls(ctx).length === 2 && out.index === 0, \`one UNAVAILABLE then success took \${calls(ctx).length} calls and answered \${JSON.stringify(out)}: a lost worker earns one retry\`);
  ctx.grpc.fail('EncodeSegment', ctx.grpc.status.UNAVAILABLE, 'worker drained', 2);
  await fails(m, job, 1, 'after two UNAVAILABLE answers for segment 1');
  assert.equal(calls(ctx).length, 4, \`segment 1 was attempted \${calls(ctx).length - 2} times: at most MAX_ATTEMPTS = 2\`);
}

export async function check_classify(ctx) {
  const {m, job: pending} = client(ctx);
  const job = await pending;
  ctx.grpc.fail('EncodeSegment', ctx.grpc.status.DEADLINE_EXCEEDED, 'slow worker');
  await m.encodeSegment(job, 0);
  assert.equal(calls(ctx).length, 2, \`a DEADLINE_EXCEEDED took \${calls(ctx).length} calls: it is retryable, once\`);
  ctx.grpc.fail('EncodeSegment', ctx.grpc.status.INVALID_ARGUMENT, 'invalid NAL unit at 00:00:07');
  const e = await fails(m, job, 1, 'with corrupt bytes in segment 1 (INVALID_ARGUMENT)');
  assert.equal(calls(ctx).length, 3, \`corrupt input was sent to the encoder \${calls(ctx).length - 2} times: INVALID_ARGUMENT is terminal, the first answer decides\`);
  assert.equal(e.code, ctx.grpc.status.INVALID_ARGUMENT, \`the failure carries code \${e.code}, expected INVALID_ARGUMENT\`);
  // Only UNAVAILABLE and DEADLINE_EXCEEDED earn a second attempt: every other status is terminal.
  for (const name of ['INTERNAL', 'UNKNOWN', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'NOT_FOUND']) {
    const before = calls(ctx).length;
    ctx.grpc.fail('EncodeSegment', ctx.grpc.status[name], 'encoder refused the segment');
    const terminal = await fails(m, job, 2, \`with the encoder answering \${name} for segment 2\`);
    assert(calls(ctx).length - before === 1 && terminal.code === ctx.grpc.status[name], \`a \${name} answer took \${calls(ctx).length - before} calls and failed with code \${terminal.code}: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, \${name} fails on the first answer\`);
  }
}

export async function check_fail_with_index(ctx) {
  const {m, job: pending} = client(ctx, 30);
  const job = await pending;
  ctx.grpc.fail('EncodeSegment', ctx.grpc.status.UNAVAILABLE, 'worker drained', 5);
  const e = await fails(m, job, 4, 'with every worker gone while encoding segment 4');
  assert(e.index === 4 && e.code === ctx.grpc.status.UNAVAILABLE, \`the failure says segment \${e.index}, code \${e.code}: it must name segment 4 and UNAVAILABLE\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"math"

	"google.golang.org/grpc/codes"
	grpcstatus "google.golang.org/grpc/status"

	pb "transcoder/gen/media_transcoder"
	"transcoder/jobs"
	"transcoder/presets"

	"leetbuild/harness"
)

var hClientBg = context.Background()

// encoderPeer encodes whatever span it is asked for; with drainNext set, the next call runs 4 s of
// the encode and then loses its worker (UNAVAILABLE).
type HEncoderPeer struct {
	pb.UnimplementedEncoderServer
	ctx       *harness.Ctx
	drainNext *bool
}

func (p HEncoderPeer) EncodeSegment(_ context.Context, req *pb.SegmentRequest) (*pb.SegmentResult, error) {
	if *p.drainNext {
		*p.drainNext = false
		p.ctx.Clock.Advance(4)
		return nil, grpcstatus.Error(codes.Unavailable, "worker drained mid-encode")
	}
	return &pb.SegmentResult{Index: req.GetIndex(), OutputKey: fmt.Sprintf("talks/42/%s/seg-%05d.ts", req.GetPreset(), req.GetIndex()), DurationS: req.GetDurationS()}, nil
}

var hEncoderDrainNext bool

func hEncoderClient(ctx *harness.Ctx, duration float64) *jobs.Job {
	hEncoderDrainNext = false
	pb.RegisterEncoderServer(ctx.GRPC.Server(""), HEncoderPeer{ctx: ctx, drainNext: &hEncoderDrainNext})
	args, _ := presets.EncoderArgs("h264-720p")
	return jobs.Create(hClientBg, "t-1", "s3://uploads/talk.mov", "9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f", duration, "h264-720p", args, "renditions", "talks/42")
}

func hEncodeCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("EncodeSegment", "") }

func hSpanOf(c harness.Call) (float64, float64) {
	req := c.Request.(*pb.SegmentRequest)
	return req.GetStartS(), req.GetDurationS()
}

func hMustEncode(ctx *harness.Ctx, job *jobs.Job, index int, why string) SegmentOutput {
	out, err := encodeSegment(hClientBg, job, index)
	ctx.NoError(err, "%s: encodeSegment(%d) failed", why, index)
	return out
}

func hMustFailSegment(ctx *harness.Ctx, job *jobs.Job, index int, why string) *SegmentFailed {
	out, err := encodeSegment(hClientBg, job, index)
	ctx.Assert(err != nil, "%s: encodeSegment returned %+v instead of a *SegmentFailed", why, out)
	var failed *SegmentFailed
	ctx.Assert(errors.As(err, &failed), "%s: encodeSegment returned %v (%T), expected a *SegmentFailed carrying the segment index", why, err, err)
	return failed
}

func CheckSegmentRange(ctx *harness.Ctx) {
	job := hEncoderClient(ctx, 14)
	var outs []SegmentOutput
	for i := 0; i < 3; i++ {
		outs = append(outs, hMustEncode(ctx, job, i, "a healthy encoder"))
	}
	var spans [][]float64
	for _, c := range hEncodeCalls(ctx) {
		start, length := hSpanOf(c)
		spans = append(spans, []float64{start, length})
	}
	ctx.Equal(spans, [][]float64{{0, 6}, {6, 6}, {12, 2}}, "the three segments of a 14-second source must each ask for their own span (start_s, duration_s), not the whole file")
	first := hEncodeCalls(ctx)[0].Request.(*pb.SegmentRequest)
	ctx.Assert(first.GetJobId() == job.JobID && first.GetPreset() == "h264-720p" && len(first.GetEncoderArgs()) == len(job.EncoderArgs), "the request must carry the job id, preset and encoder arguments, got %v", first)
	ctx.Assert(outs[2].Index == 2 && outs[2].DurationS == 2, "encodeSegment answered %+v for the tail segment", outs[2])
}

func CheckScaledDeadline(ctx *harness.Ctx) {
	job := hEncoderClient(ctx, 14)
	for i := 0; i < 3; i++ {
		hMustEncode(ctx, job, i, "a healthy encoder")
	}
	for _, c := range hEncodeCalls(ctx) {
		_, length := hSpanOf(c)
		want := 2 + 0.5*length
		ctx.Assert(c.HasDeadline() && math.Abs(c.Timeout.Seconds()-want) < 0.1, "a call for a %v s span carries a %v deadline, expected deadlineBase + deadlinePerSecond × length = %v s", length, c.Timeout, want)
	}
	ctx.GRPC.Fail("EncodeSegment", codes.Unavailable, "worker drained", 1, "")
	hMustEncode(ctx, job, 1, "one UNAVAILABLE then success")
	calls := hEncodeCalls(ctx)
	retry := calls[len(calls)-1]
	_, length := hSpanOf(retry)
	ctx.Assert(math.Abs(retry.Timeout.Seconds()-(2+0.5*length)) < 0.1, "the second attempt carries a %v deadline: every attempt gets the scaled deadline", retry.Timeout)
	// The first attempt fails late, 4 s into its 5 s: the retry still gets a deadline of its own.
	hEncoderDrainNext = true
	before := len(hEncodeCalls(ctx))
	_, err := encodeSegment(hClientBg, job, 0)
	ctx.NoError(err, "segment 0's first attempt lost its worker 4 s into its 5 s deadline and the retry failed: every attempt carries the full scaled deadline, not what is left of the first one")
	late := hEncodeCalls(ctx)[before:]
	ctx.Assert(len(late) == 2 && math.Abs(late[len(late)-1].Timeout.Seconds()-5) < 0.1, "after a first attempt that failed 4 s in, the retry of a 6 s segment carried a %v deadline over %d calls: every attempt gets the full 5 s", late[len(late)-1].Timeout, len(late))
}

func CheckBoundedAttempts(ctx *harness.Ctx) {
	job := hEncoderClient(ctx, 14)
	ctx.GRPC.Fail("EncodeSegment", codes.Unavailable, "worker drained", 1, "")
	out := hMustEncode(ctx, job, 0, "one UNAVAILABLE then success")
	ctx.Assert(len(hEncodeCalls(ctx)) == 2 && out.Index == 0, "one UNAVAILABLE then success took %d calls and answered %+v: a lost worker earns one retry", len(hEncodeCalls(ctx)), out)
	ctx.GRPC.Fail("EncodeSegment", codes.Unavailable, "worker drained", 2, "")
	hMustFailSegment(ctx, job, 1, "after two UNAVAILABLE answers for segment 1")
	ctx.Equal(len(hEncodeCalls(ctx))-2, 2, "segment 1 may be attempted at most maxAttempts = 2 times; attempts")
}

func CheckClassify(ctx *harness.Ctx) {
	job := hEncoderClient(ctx, 14)
	ctx.GRPC.Fail("EncodeSegment", codes.DeadlineExceeded, "slow worker", 1, "")
	hMustEncode(ctx, job, 0, "one DEADLINE_EXCEEDED then success")
	ctx.Equal(len(hEncodeCalls(ctx)), 2, "a DEADLINE_EXCEEDED is retryable, once; calls")
	ctx.GRPC.Fail("EncodeSegment", codes.InvalidArgument, "invalid NAL unit at 00:00:07", 1, "")
	failed := hMustFailSegment(ctx, job, 1, "with corrupt bytes in segment 1 (INVALID_ARGUMENT)")
	ctx.Equal(len(hEncodeCalls(ctx))-2, 1, "INVALID_ARGUMENT is terminal, the first answer decides; times corrupt input was sent")
	ctx.Equal(failed.Code, codes.InvalidArgument, "the failure's code")
	// Only UNAVAILABLE and DEADLINE_EXCEEDED earn a second attempt: every other status is terminal.
	for _, code := range []codes.Code{codes.Internal, codes.Unknown, codes.ResourceExhausted, codes.FailedPrecondition, codes.NotFound} {
		before := len(hEncodeCalls(ctx))
		ctx.GRPC.Fail("EncodeSegment", code, "encoder refused the segment", 1, "")
		terminal := hMustFailSegment(ctx, job, 2, fmt.Sprintf("with the encoder answering %v for segment 2", code))
		ctx.Assert(len(hEncodeCalls(ctx))-before == 1 && terminal.Code == code, "a %v answer took %d calls and failed with %v: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, %v fails on the first answer", code, len(hEncodeCalls(ctx))-before, terminal.Code, code)
	}
}

func CheckFailWithIndex(ctx *harness.Ctx) {
	job := hEncoderClient(ctx, 30)
	ctx.GRPC.Fail("EncodeSegment", codes.Unavailable, "worker drained", 5, "")
	failed := hMustFailSegment(ctx, job, 4, "with every worker gone while encoding segment 4")
	ctx.Assert(failed.Index == 4 && failed.Code == codes.Unavailable, "the failure says segment %d, %v: it must name segment 4 and UNAVAILABLE", failed.Index, failed.Code)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include "transcoder/jobs.h"
#include "transcoder/presets.h"

namespace {

// Encodes whatever span it is asked for; with drain_next set, the next call runs 4 s of the encode
// and then loses its worker (UNAVAILABLE).
class HEncoderPeer final : public transcoderd::Encoder::Service {
 public:
  harness::Ctx* ctx = nullptr;
  bool drain_next = false;

  grpc::Status EncodeSegment(grpc::ServerContext*, const transcoderd::SegmentRequest* req, transcoderd::SegmentResult* out) override {
    if (drain_next) {
      drain_next = false;
      ctx->Clock.Advance(4);
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "worker drained mid-encode");
    }
    char name[16];
    std::snprintf(name, sizeof name, "seg-%05d.ts", req->index());
    out->set_index(req->index());
    out->set_output_key("talks/42/" + req->preset() + "/" + name);
    out->set_duration_s(req->duration_s());
    return grpc::Status::OK;
  }
};

HEncoderPeer* hEncoder_peer = nullptr;

jobs::Job hEncoderClient(harness::Ctx& ctx, double duration) {
  delete hEncoder_peer;
  hEncoder_peer = new HEncoderPeer;
  hEncoder_peer->ctx = &ctx;
  ctx.GRPC.Server("")->RegisterService(hEncoder_peer);
  return jobs::create("t-1", "s3://uploads/talk.mov", std::string(64, 'f'), duration, "h264-720p", *presets::encoderArgs("h264-720p"), "renditions", "talks/42");
}

std::vector<harness::Call> hEncodeCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("EncodeSegment"); }

SegmentOutput hMustEncode(harness::Ctx& ctx, const jobs::Job& job, int index, const std::string& why) {
  try {
    return encodeSegment(job, index);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: encodeSegment(%d) threw %s: %s", why, index, harness::CurrentExceptionType(), e.what());
  }
}

SegmentFailed hMustFailSegment(harness::Ctx& ctx, const jobs::Job& job, int index, const std::string& why) {
  try {
    const SegmentOutput out = encodeSegment(job, index);
    ctx.Fatalf("%s: encodeSegment returned segment %d instead of throwing SegmentFailed", why, out.index);
  } catch (const SegmentFailed& e) {
    return e;
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: encodeSegment threw %s: %s, expected SegmentFailed carrying the segment index", why, harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckSegmentRange(harness::Ctx& ctx) {
  const jobs::Job job = hEncoderClient(ctx, 14);
  std::vector<SegmentOutput> outs;
  for (int i = 0; i < 3; i++) outs.push_back(hMustEncode(ctx, job, i, "a healthy encoder"));
  std::vector<std::vector<double>> spans;
  for (const auto& c : hEncodeCalls(ctx)) {
    const auto& req = c.Request<transcoderd::SegmentRequest>();
    spans.push_back({req.start_s(), req.duration_s()});
  }
  ctx.Equal(spans, std::vector<std::vector<double>>{{0, 6}, {6, 6}, {12, 2}}, "the three segments of a 14-second source must each ask for their own span (start_s, duration_s), not the whole file");
  const auto first = hEncodeCalls(ctx)[0].Request<transcoderd::SegmentRequest>();
  ctx.Assert(first.job_id() == job.job_id && first.preset() == "h264-720p" && first.encoder_args_size() == static_cast<int>(job.encoder_args.size()), "the request must carry the job id, preset and encoder arguments");
  ctx.Assert(outs[2].index == 2 && outs[2].duration_s == 2, "encodeSegment answered segment %d of %v s for the tail segment", outs[2].index, outs[2].duration_s);
}

void CheckScaledDeadline(harness::Ctx& ctx) {
  const jobs::Job job = hEncoderClient(ctx, 14);
  for (int i = 0; i < 3; i++) hMustEncode(ctx, job, i, "a healthy encoder");
  for (const auto& c : hEncodeCalls(ctx)) {
    const double length = c.Request<transcoderd::SegmentRequest>().duration_s();
    const double want = 2 + 0.5 * length;
    ctx.Assert(c.HasDeadline() && std::abs(c.TimeoutSeconds() - want) < 0.1, "a call for a %v s span carries a %v s deadline, expected kDeadlineBaseMs + kDeadlinePerSecondMs × length = %v s", length, c.TimeoutSeconds(), want);
  }
  ctx.GRPC.Fail("EncodeSegment", grpc::StatusCode::UNAVAILABLE, "worker drained", 1);
  hMustEncode(ctx, job, 1, "one UNAVAILABLE then success");
  const auto calls = hEncodeCalls(ctx);
  const auto& retry = calls.back();
  const double length = retry.Request<transcoderd::SegmentRequest>().duration_s();
  ctx.Assert(std::abs(retry.TimeoutSeconds() - (2 + 0.5 * length)) < 0.1, "the second attempt carries a %v s deadline: every attempt gets the scaled deadline", retry.TimeoutSeconds());
  // The first attempt fails late, 4 s into its 5 s: the retry still gets a deadline of its own.
  hEncoder_peer->drain_next = true;
  const size_t before = hEncodeCalls(ctx).size();
  try {
    encodeSegment(job, 0);
  } catch (const std::exception& e) {
    ctx.Fatalf("segment 0's first attempt lost its worker 4 s into its 5 s deadline and the retry threw %s: %s: every attempt carries the full scaled deadline, not what is left of the first one", harness::CurrentExceptionType(), e.what());
  }
  const auto late = hEncodeCalls(ctx);
  ctx.Assert(late.size() - before == 2 && std::abs(late.back().TimeoutSeconds() - 5) < 0.1, "after a first attempt that failed 4 s in, the retry of a 6 s segment carried a %v s deadline over %d calls: every attempt gets the full 5 s", late.back().TimeoutSeconds(), late.size() - before);
}

void CheckBoundedAttempts(harness::Ctx& ctx) {
  const jobs::Job job = hEncoderClient(ctx, 14);
  ctx.GRPC.Fail("EncodeSegment", grpc::StatusCode::UNAVAILABLE, "worker drained", 1);
  const SegmentOutput out = hMustEncode(ctx, job, 0, "one UNAVAILABLE then success");
  ctx.Assert(hEncodeCalls(ctx).size() == 2 && out.index == 0, "one UNAVAILABLE then success took %d calls: a lost worker earns one retry", hEncodeCalls(ctx).size());
  ctx.GRPC.Fail("EncodeSegment", grpc::StatusCode::UNAVAILABLE, "worker drained", 2);
  hMustFailSegment(ctx, job, 1, "after two UNAVAILABLE answers for segment 1");
  ctx.Equal(hEncodeCalls(ctx).size() - 2, size_t{2}, "segment 1 may be attempted at most kMaxAttempts = 2 times; attempts");
}

void CheckClassify(harness::Ctx& ctx) {
  const jobs::Job job = hEncoderClient(ctx, 14);
  ctx.GRPC.Fail("EncodeSegment", grpc::StatusCode::DEADLINE_EXCEEDED, "slow worker", 1);
  hMustEncode(ctx, job, 0, "one DEADLINE_EXCEEDED then success");
  ctx.Equal(hEncodeCalls(ctx).size(), size_t{2}, "a DEADLINE_EXCEEDED is retryable, once; calls");
  ctx.GRPC.Fail("EncodeSegment", grpc::StatusCode::INVALID_ARGUMENT, "invalid NAL unit at 00:00:07", 1);
  const SegmentFailed failed = hMustFailSegment(ctx, job, 1, "with corrupt bytes in segment 1 (INVALID_ARGUMENT)");
  ctx.Equal(hEncodeCalls(ctx).size() - 2, size_t{1}, "INVALID_ARGUMENT is terminal, the first answer decides; times corrupt input was sent");
  ctx.Assert(failed.code == grpc::StatusCode::INVALID_ARGUMENT, "the failure carries code %d, expected INVALID_ARGUMENT", static_cast<int>(failed.code));
  // Only UNAVAILABLE and DEADLINE_EXCEEDED earn a second attempt: every other status is terminal.
  const std::vector<std::pair<grpc::StatusCode, std::string>> terminal_codes = {
      {grpc::StatusCode::INTERNAL, "INTERNAL"},
      {grpc::StatusCode::UNKNOWN, "UNKNOWN"},
      {grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"},
      {grpc::StatusCode::FAILED_PRECONDITION, "FAILED_PRECONDITION"},
      {grpc::StatusCode::NOT_FOUND, "NOT_FOUND"},
  };
  for (const auto& [code, name] : terminal_codes) {
    const size_t before = hEncodeCalls(ctx).size();
    ctx.GRPC.Fail("EncodeSegment", code, "encoder refused the segment", 1);
    const SegmentFailed terminal = hMustFailSegment(ctx, job, 2, "with the encoder answering " + name + " for segment 2");
    ctx.Assert(hEncodeCalls(ctx).size() - before == 1 && terminal.code == code, "a %s answer took %d calls and failed with code %d: only UNAVAILABLE and DEADLINE_EXCEEDED are retried, %s fails on the first answer", name, hEncodeCalls(ctx).size() - before, static_cast<int>(terminal.code), name);
  }
}

void CheckFailWithIndex(harness::Ctx& ctx) {
  const jobs::Job job = hEncoderClient(ctx, 30);
  ctx.GRPC.Fail("EncodeSegment", grpc::StatusCode::UNAVAILABLE, "worker drained", 5);
  const SegmentFailed failed = hMustFailSegment(ctx, job, 4, "with every worker gone while encoding segment 4");
  ctx.Assert(failed.index == 4 && failed.code == grpc::StatusCode::UNAVAILABLE, "the failure says segment %d, code %d: it must name segment 4 and UNAVAILABLE", failed.index, static_cast<int>(failed.code));
}
`,
  },
  hints: [
    'A 90-minute upload has been "encoding" for six hours: the worker log repeats the same line, every segment request names the whole file, and nobody can say which segment is stuck.',
    'Each request asks for start 0 and the full duration under one 30 s timeout, and the loop treats INVALID_ARGUMENT like a dead worker, so corrupt bytes are sent five times and the final RpcError carries no index.',
    'Send `jobs.segment_span(duration_s, index)`, set `timeout=DEADLINE_BASE_S + DEADLINE_PER_SECOND_S * length`, loop `range(1, MAX_ATTEMPTS + 1)`, and when `not is_retryable(code)` or the last attempt fails, raise `SegmentFailed(index, code)`.',
  ],
  debrief: `Classification comes first because the rest follows from it: once only a lost or slow worker earns a second try, two attempts are enough and corrupt input stops on the first answer. The deadline scales with the span because the encoder's cost does; one ceiling is wrong for a two-second tail and for a six-minute chapter alike. Asking for the segment's own span is what makes the segment the unit of work at all, and the index on the failure is what lets the worker record \`mark_failed(job, index)\` and the read report it. What this step did not do: a real client spaces the two attempts with jittered backoff and sends the retry to a different worker, so a drained host is not asked twice.`,
};
