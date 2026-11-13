import type {Step} from '@/lib/types';

export const transcriptionDependencyStep: Step = {
  id: 'dependency',
  title: 'ASR streams that resume a chunk instead of restarting the file',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['worker', 'asr', 'redis'],
  task: `## Task

**Starting point.** The starter is the worker's ASR client, the \`transcribe()\` the ledger of step 2
calls: \`transcribe_chunk(job_id, audio_ref, index)\` opens \`Asr.TranscribeChunk\` with the job, the
audio and the chunk index, collects the streamed segments as \`{chunk_index, start_ms, end_ms, speaker,
text}\`, and on any gRPC error sends the same request again, up to five times. With a healthy provider
it returns the chunk's segments, and it hides five flaws.

\`\`\`proto
service Asr { rpc TranscribeChunk(ChunkRequest) returns (stream Segment); }  // INVALID_ARGUMENT: corrupt audio
message ChunkRequest { string job_id = 1; string audio_ref = 2; int32 chunk_index = 3; int32 offset_ms = 4; int32 duration_ms = 5; }
\`\`\`

**Failure mode the checks target.** \`offset_ms\` and \`duration_ms\` stay 0, which the provider reads as
the whole file from the start; a stream that breaks after one segment is replayed from its beginning,
so that segment comes back twice; a stalled provider holds the worker with no deadline; and audio the
provider cannot decode is sent five times.

- A chunk is \`CHUNK_MS\` = 30 000 ms from \`index * CHUNK_MS\`: send that \`offset_ms\` and \`duration_ms\`.
- Every attempt carries a \`DEADLINE_S\` = 60 s deadline of its own; after \`MAX_ATTEMPTS\` = 2 that
  did not finish the chunk, raise \`AsrUnavailable\`, even if some segments arrived.
- A retry resumes at the \`end_ms\` of the last segment received, for the rest of the chunk, and keeps
  what already arrived.
- \`INVALID_ARGUMENT\` raises \`CorruptAudio\` at once.`,
  sequence: {
    participants: ['Chunk worker', 'ASR provider'],
    messages: [
      {
        from: 'Chunk worker',
        to: 'ASR provider',
        label: 'TranscribeChunk(chunk 1 · offset 30 000 · 30 000 ms) · deadline 60 s',
        kind: 'sync',
      },
      {from: 'ASR provider', to: 'Chunk worker', label: 'Segment 30–40 s', kind: 'async'},
      {from: 'ASR provider', to: 'Chunk worker', label: 'UNAVAILABLE mid-stream', kind: 'reply'},
      {
        from: 'Chunk worker',
        to: 'ASR provider',
        label: 'attempt 2: offset 40 000 · 20 000 ms · deadline 60 s',
        kind: 'sync',
      },
      {from: 'ASR provider', to: 'Chunk worker', label: 'Segment 40–50 s · Segment 50–60 s', kind: 'async'},
      {from: 'ASR provider', to: 'Chunk worker', label: 'INVALID_ARGUMENT → CorruptAudio, no retry', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'chunk-span',
      title: "One stream per chunk, for the chunk's own span",
      detail:
        'The request carries `offset_ms = index * CHUNK_MS` and `duration_ms`, so the provider transcribes 30 seconds; the starter leaves both 0 and pays for the whole file on every chunk.',
      match: {
        python: {all: [/offset_ms\s*=/, /duration_ms\s*=/, /index\s*\*\s*CHUNK_MS/]},
        typescript: {all: [/offset_ms\s*:/, /duration_ms\s*:/, /index\s*\*\s*CHUNK_MS/]},
        go: {all: [/OffsetMs\s*:/, /DurationMs\s*:/, /index\s*\*\s*chunkMs/]},
        scala: {all: [/offsetMs\s*=/, /durationMs\s*=/, /index\s*\*\s*ChunkMs/]},
        cpp: {all: [/set_offset_ms\(/, /set_duration_ms\(/, /index\s*\*\s*kChunkMs/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every attempt carries a 60-second deadline',
      detail:
        'Each `TranscribeChunk` stream is opened with a `DEADLINE_S` (60 s) deadline of its own (`timeout=`, `deadline:`, a context with timeout, `withDeadlineAfter`, `set_deadline`), the retry included, even when the first attempt took 59 s; the starter sets none, so a stalled provider holds the worker and the chunk indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*60\b/, /TranscribeChunk\([^)]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*60_?000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*60\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*60L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{60\}|kDeadline\(60\)/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'max-attempts',
      title: 'At most two attempts per chunk',
      detail:
        'A chunk gets `MAX_ATTEMPTS` (2) streams, then `AsrUnavailable`, even when each stream delivered part of the chunk: a chunk with a hole is not transcribed, and the ledger records it failed for a later redelivery. The starter tries five times, each one billed.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*2\b/, /range\(\s*MAX_ATTEMPTS\s*\)/],
          none: [/range\(\s*5\s*\)/, /while\s+True/],
        },
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /<\s*MAX_ATTEMPTS/], none: [/<\s*5\b/, /while\s*\(true\)/]},
        go: {all: [/maxAttempts\s*=\s*2\b/, /<\s*maxAttempts/], none: [/<\s*5\b/]},
        scala: {all: [/MaxAttempts\s*=\s*2\b/, /<\s*MaxAttempts|until\s+MaxAttempts/], none: [/<\s*5\b|until\s+5\b/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /<\s*kMaxAttempts/], none: [/<\s*5\b/, /while\s*\(true\)/]},
      },
    },
    {
      id: 'resume-offset',
      title: 'A retry resumes where the stream stopped',
      detail:
        'Each segment received moves the offset to its `end_ms`, and the next attempt asks for the rest of the chunk from there, so every segment is returned once; the starter replays the same request and keeps both copies.',
      match: {
        python: {all: [/=\s*\w+\.end_ms\b/, /duration_ms\s*=\s*\w+\s*-\s*\w+/]},
        typescript: {all: [/=\s*\w+\.end_ms\b/, /duration_ms:\s*\w+\s*-\s*\w+/]},
        go: {all: [/=\s*(?:int\(\s*)?\w+\.(?:GetEndMs\(\)|EndMs)/, /DurationMs:\s*(?:int32\(\s*)?\w+\s*-\s*\w+/]},
        scala: {all: [/=\s*\w+\.endMs\b/, /durationMs\s*=\s*\w+\s*-\s*\w+/]},
        cpp: {all: [/=\s*\w+\.end_ms\(\)/, /set_duration_ms\(\s*\w+\s*-\s*\w+/]},
      },
    },
    {
      id: 'corrupt-terminal',
      title: 'Corrupt audio is terminal',
      detail:
        '`INVALID_ARGUMENT` raises `CorruptAudio` on the first attempt: a span the provider cannot decode fails the same way every time. The starter retries every status alike.',
      match: {
        python: {all: [/StatusCode\.INVALID_ARGUMENT/, /raise CorruptAudio/]},
        typescript: {all: [/status\.INVALID_ARGUMENT/, /throw new CorruptAudio/]},
        go: {all: [/codes\.InvalidArgument/, /return[^\n]*ErrCorruptAudio/]},
        scala: {all: [/INVALID_ARGUMENT/, /throw new CorruptAudio/]},
        cpp: {all: [/StatusCode::INVALID_ARGUMENT/, /throw CorruptAudio/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import transcription_pb2
import transcription_pb2_grpc

asr = transcription_pb2_grpc.AsrStub(grpc.insecure_channel("asr:9000"))


class CorruptAudio(Exception):
    """The provider cannot decode this span: another attempt fails the same way."""


class AsrUnavailable(Exception):
    """The provider did not transcribe the chunk within the attempts: a later redelivery may."""


def _segment(index: int, seg) -> dict:
    return {"chunk_index": index, "start_ms": seg.start_ms, "end_ms": seg.end_ms, "speaker": seg.speaker, "text": seg.text}


def transcribe_chunk(job_id: str, audio_ref: str, index: int) -> list[dict]:
    """The segments of chunk index (30 s of audio from index * 30 s), in order."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    request = transcription_pb2.ChunkRequest(job_id=job_id, audio_ref=audio_ref, chunk_index=index)
    segments = []
    for attempt in range(5):
        try:
            for seg in asr.TranscribeChunk(request):
                segments.append(_segment(index, seg))
            return segments
        except grpc.RpcError:
            continue  # the provider hiccupped: send it again
    raise AsrUnavailable(f"chunk {index} of {job_id}: the provider kept failing")
`,
      solution: `import grpc

import transcription_pb2
import transcription_pb2_grpc

asr = transcription_pb2_grpc.AsrStub(grpc.insecure_channel("asr:9000"))

CHUNK_MS = 30_000
DEADLINE_S = 60
MAX_ATTEMPTS = 2


class CorruptAudio(Exception):
    """The provider cannot decode this span: another attempt fails the same way."""


class AsrUnavailable(Exception):
    """The provider did not transcribe the chunk within the attempts: a later redelivery may."""


def _segment(index: int, seg) -> dict:
    return {"chunk_index": index, "start_ms": seg.start_ms, "end_ms": seg.end_ms, "speaker": seg.speaker, "text": seg.text}


def transcribe_chunk(job_id: str, audio_ref: str, index: int) -> list[dict]:
    """The segments of chunk index (30 s of audio from index * 30 s), in order."""
    end = (index + 1) * CHUNK_MS
    offset = index * CHUNK_MS
    segments = []
    for attempt in range(MAX_ATTEMPTS):
        # One stream for this chunk only, from where the last attempt stopped.
        request = transcription_pb2.ChunkRequest(job_id=job_id, audio_ref=audio_ref, chunk_index=index, offset_ms=offset, duration_ms=end - offset)
        try:
            for seg in asr.TranscribeChunk(request, timeout=DEADLINE_S):
                segments.append(_segment(index, seg))
                offset = seg.end_ms
            return segments
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                raise CorruptAudio(f"chunk {index} of {job_id}: {exc.details()}") from exc
            # UNAVAILABLE, DEADLINE_EXCEEDED: the next attempt resumes at offset
    raise AsrUnavailable(f"chunk {index} of {job_id}: no transcript after {MAX_ATTEMPTS} attempts")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Segment} from 'transcribe/jobs';

interface ChunkRequest {
  job_id: string;
  audio_ref: string;
  chunk_index: number;
  offset_ms?: number;
  duration_ms?: number;
}

interface AsrSegment {
  start_ms: number;
  end_ms: number;
  speaker: string;
  text: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('transcription.proto')) as unknown as {
  transcribe: {Asr: grpc.ServiceClientConstructor};
};
const asr = new pkg.transcribe.Asr('asr:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  TranscribeChunk(request: ChunkRequest, metadata: grpc.Metadata, options: grpc.CallOptions): grpc.ClientReadableStream<AsrSegment>;
};

/** The provider cannot decode this span: another attempt fails the same way. */
export class CorruptAudio extends Error {}
/** The provider did not transcribe the chunk within the attempts: a later redelivery may. */
export class AsrUnavailable extends Error {}

/** Hands every segment of one stream to onSegment as it arrives; rejects with the stream's error. */
function readAll(call: grpc.ClientReadableStream<AsrSegment>, onSegment: (s: AsrSegment) => void): Promise<void> {
  const {promise, resolve, reject} = Promise.withResolvers<void>();
  call.on('data', onSegment);
  call.on('error', reject);
  call.on('end', resolve);
  return promise;
}

/** The segments of chunk index (30 s of audio from index * 30 s), in order. */
export async function transcribeChunk(jobId: string, audioRef: string, index: number): Promise<Segment[]> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const request: ChunkRequest = {job_id: jobId, audio_ref: audioRef, chunk_index: index};
  const segments: Segment[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await readAll(asr.TranscribeChunk(request, new grpc.Metadata(), {}), s =>
        segments.push({chunk_index: index, start_ms: s.start_ms, end_ms: s.end_ms, speaker: s.speaker, text: s.text}),
      );
      return segments;
    } catch {
      // the provider hiccupped: send it again
    }
  }
  throw new AsrUnavailable(\`chunk \${index} of \${jobId}: the provider kept failing\`);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Segment} from 'transcribe/jobs';

export const CHUNK_MS = 30_000;
export const DEADLINE_MS = 60_000;
export const MAX_ATTEMPTS = 2;

interface ChunkRequest {
  job_id: string;
  audio_ref: string;
  chunk_index: number;
  offset_ms?: number;
  duration_ms?: number;
}

interface AsrSegment {
  start_ms: number;
  end_ms: number;
  speaker: string;
  text: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('transcription.proto')) as unknown as {
  transcribe: {Asr: grpc.ServiceClientConstructor};
};
const asr = new pkg.transcribe.Asr('asr:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  TranscribeChunk(request: ChunkRequest, metadata: grpc.Metadata, options: grpc.CallOptions): grpc.ClientReadableStream<AsrSegment>;
};

/** The provider cannot decode this span: another attempt fails the same way. */
export class CorruptAudio extends Error {}
/** The provider did not transcribe the chunk within the attempts: a later redelivery may. */
export class AsrUnavailable extends Error {}

/** Hands every segment of one stream to onSegment as it arrives; rejects with the stream's error. */
function readAll(call: grpc.ClientReadableStream<AsrSegment>, onSegment: (s: AsrSegment) => void): Promise<void> {
  const {promise, resolve, reject} = Promise.withResolvers<void>();
  call.on('data', onSegment);
  call.on('error', reject);
  call.on('end', resolve);
  return promise;
}

/** The segments of chunk index (30 s of audio from index * 30 s), in order. */
export async function transcribeChunk(jobId: string, audioRef: string, index: number): Promise<Segment[]> {
  const end = (index + 1) * CHUNK_MS;
  let offset = index * CHUNK_MS;
  const segments: Segment[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // One stream for this chunk only, from where the last attempt stopped.
    const request: ChunkRequest = {job_id: jobId, audio_ref: audioRef, chunk_index: index, offset_ms: offset, duration_ms: end - offset};
    try {
      await readAll(asr.TranscribeChunk(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}), s => {
        segments.push({chunk_index: index, start_ms: s.start_ms, end_ms: s.end_ms, speaker: s.speaker, text: s.text});
        offset = s.end_ms;
      });
      return segments;
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.INVALID_ARGUMENT) throw new CorruptAudio(\`chunk \${index} of \${jobId}: \${details}\`);
      // UNAVAILABLE, DEADLINE_EXCEEDED: the next attempt resumes at offset
    }
  }
  throw new AsrUnavailable(\`chunk \${index} of \${jobId}: no transcript after \${MAX_ATTEMPTS} attempts\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"io"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "transcribe/gen/transcription"
	"transcribe/jobs" // jobs.Segment
)

var (
	asrConn, _ = grpc.NewClient("asr:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	asr        = pb.NewAsrClient(asrConn)
)

var (
	// ErrCorruptAudio: the provider cannot decode this span, another attempt fails the same way.
	ErrCorruptAudio = errors.New("corrupt audio")
	// ErrAsrUnavailable: the provider did not transcribe the chunk within the attempts, a later redelivery may.
	ErrAsrUnavailable = errors.New("asr unavailable")
)

func segmentOf(index int, seg *pb.Segment) jobs.Segment {
	return jobs.Segment{ChunkIndex: index, StartMs: int(seg.GetStartMs()), EndMs: int(seg.GetEndMs()), Speaker: seg.GetSpeaker(), Text: seg.GetText()}
}

// transcribeChunk returns the segments of chunk index (30 s of audio from index * 30 s), in order.
func transcribeChunk(ctx context.Context, jobID, audioRef string, index int) ([]jobs.Segment, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	req := &pb.ChunkRequest{JobId: jobID, AudioRef: audioRef, ChunkIndex: int32(index)}
	var segments []jobs.Segment
	for attempt := 0; attempt < 5; attempt++ {
		stream, err := asr.TranscribeChunk(ctx, req)
		for err == nil {
			var seg *pb.Segment
			seg, err = stream.Recv()
			if err == nil {
				segments = append(segments, segmentOf(index, seg))
			}
		}
		if err == io.EOF {
			return segments, nil
		}
		// the provider hiccupped: send it again
	}
	return nil, fmt.Errorf("%w: chunk %d of %s", ErrAsrUnavailable, index, jobID)
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "transcribe/gen/transcription"
	"transcribe/jobs" // jobs.Segment
)

const (
	chunkMs     = 30000
	deadline    = 60 * time.Second
	maxAttempts = 2
)

var (
	asrConn, _ = grpc.NewClient("asr:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	asr        = pb.NewAsrClient(asrConn)
)

var (
	// ErrCorruptAudio: the provider cannot decode this span, another attempt fails the same way.
	ErrCorruptAudio = errors.New("corrupt audio")
	// ErrAsrUnavailable: the provider did not transcribe the chunk within the attempts, a later redelivery may.
	ErrAsrUnavailable = errors.New("asr unavailable")
)

func segmentOf(index int, seg *pb.Segment) jobs.Segment {
	return jobs.Segment{ChunkIndex: index, StartMs: int(seg.GetStartMs()), EndMs: int(seg.GetEndMs()), Speaker: seg.GetSpeaker(), Text: seg.GetText()}
}

// attempt runs one stream under the deadline, appending what arrives; it returns the offset the
// last segment reached and how the stream ended (nil when it completed).
func attempt(ctx context.Context, req *pb.ChunkRequest, index int, segments *[]jobs.Segment) (int, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	offset := int(req.GetOffsetMs())
	stream, err := asr.TranscribeChunk(callCtx, req)
	if err != nil {
		return offset, err
	}
	for {
		seg, err := stream.Recv()
		if err == io.EOF {
			return offset, nil
		}
		if err != nil {
			return offset, err
		}
		*segments = append(*segments, segmentOf(index, seg))
		offset = int(seg.GetEndMs())
	}
}

// transcribeChunk returns the segments of chunk index (30 s of audio from index * 30 s), in order.
func transcribeChunk(ctx context.Context, jobID, audioRef string, index int) ([]jobs.Segment, error) {
	end := (index + 1) * chunkMs
	offset := index * chunkMs
	var segments []jobs.Segment
	for try := 0; try < maxAttempts; try++ {
		// One stream for this chunk only, from where the last attempt stopped.
		req := &pb.ChunkRequest{JobId: jobID, AudioRef: audioRef, ChunkIndex: int32(index), OffsetMs: int32(offset), DurationMs: int32(end - offset)}
		reached, err := attempt(ctx, req, index, &segments)
		if err == nil {
			return segments, nil
		}
		if status.Code(err) == codes.InvalidArgument {
			return nil, fmt.Errorf("%w: chunk %d of %s: %s", ErrCorruptAudio, index, jobID, status.Convert(err).Message())
		}
		offset = reached // Unavailable, DeadlineExceeded: the next attempt resumes here
	}
	return nil, fmt.Errorf("%w: chunk %d of %s after %d attempts", ErrAsrUnavailable, index, jobID, maxAttempts)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import scala.collection.mutable.ListBuffer

import transcribe.Jobs // Jobs.Segment
import transcribe.transcription.{AsrGrpc, ChunkRequest}

/** The provider cannot decode this span: another attempt fails the same way. */
final class CorruptAudio(message: String) extends Exception(message)
/** The provider did not transcribe the chunk within the attempts: a later redelivery may. */
final class AsrUnavailable(message: String) extends Exception(message)

object AsrClient {
  private val asr = AsrGrpc.blockingStub(ManagedChannelBuilder.forAddress("asr", 9000).usePlaintext().build())

  /** The segments of chunk index (30 s of audio from index * 30 s), in order. */
  def transcribeChunk(jobId: String, audioRef: String, index: Int): Seq[Jobs.Segment] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val request = ChunkRequest(jobId = jobId, audioRef = audioRef, chunkIndex = index)
    val segments = ListBuffer.empty[Jobs.Segment]
    var attempt = 0
    while (attempt < 5) {
      try {
        asr.transcribeChunk(request).foreach(s => segments += Jobs.Segment(index, s.startMs, s.endMs, s.speaker, s.text))
        return segments.toList
      } catch {
        case _: StatusRuntimeException => attempt += 1 // the provider hiccupped: send it again
      }
    }
    throw new AsrUnavailable(s"chunk $index of $jobId: the provider kept failing")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import scala.collection.mutable.ListBuffer

import transcribe.Jobs // Jobs.Segment
import transcribe.transcription.{AsrGrpc, ChunkRequest}

/** The provider cannot decode this span: another attempt fails the same way. */
final class CorruptAudio(message: String) extends Exception(message)
/** The provider did not transcribe the chunk within the attempts: a later redelivery may. */
final class AsrUnavailable(message: String) extends Exception(message)

object AsrClient {
  val ChunkMs = 30000
  val DeadlineSeconds = 60L
  val MaxAttempts = 2

  private val asr = AsrGrpc.blockingStub(ManagedChannelBuilder.forAddress("asr", 9000).usePlaintext().build())

  /** The segments of chunk index (30 s of audio from index * 30 s), in order. */
  def transcribeChunk(jobId: String, audioRef: String, index: Int): Seq[Jobs.Segment] = {
    val end = (index + 1) * ChunkMs
    var offset = index * ChunkMs
    val segments = ListBuffer.empty[Jobs.Segment]
    var attempt = 0
    while (attempt < MaxAttempts) {
      // One stream for this chunk only, from where the last attempt stopped.
      val request = ChunkRequest(jobId = jobId, audioRef = audioRef, chunkIndex = index, offsetMs = offset, durationMs = end - offset)
      try {
        asr.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).transcribeChunk(request).foreach { s =>
          segments += Jobs.Segment(index, s.startMs, s.endMs, s.speaker, s.text)
          offset = s.endMs
        }
        return segments.toList
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
          throw new CorruptAudio(s"chunk $index of $jobId: \${e.getStatus.getDescription}")
        case _: StatusRuntimeException => attempt += 1 // UNAVAILABLE, DEADLINE_EXCEEDED: the next attempt resumes at offset
      }
    }
    throw new AsrUnavailable(s"chunk $index of $jobId: no transcript after $MaxAttempts attempts")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>
#include <vector>

#include "transcription.grpc.pb.h"
#include "transcribe/jobs.h"  // jobs::Segment

auto asr = transcribe::Asr::NewStub(grpc::CreateChannel("asr:9000", grpc::InsecureChannelCredentials()));

// The provider cannot decode this span: another attempt fails the same way.
struct CorruptAudio : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The provider did not transcribe the chunk within the attempts: a later redelivery may.
struct AsrUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The segments of chunk index (30 s of audio from index * 30 s), in order.
std::vector<jobs::Segment> transcribeChunk(const std::string& job_id, const std::string& audio_ref, int index) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  transcribe::ChunkRequest request;
  request.set_job_id(job_id);
  request.set_audio_ref(audio_ref);
  request.set_chunk_index(index);
  std::vector<jobs::Segment> segments;
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    auto reader = asr->TranscribeChunk(&ctx, request);
    transcribe::Segment seg;
    while (reader->Read(&seg)) segments.push_back({index, seg.start_ms(), seg.end_ms(), seg.speaker(), seg.text()});
    if (reader->Finish().ok()) return segments;
    // the provider hiccupped: send it again
  }
  throw AsrUnavailable("chunk " + std::to_string(index) + " of " + job_id + ": the provider kept failing");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "transcription.grpc.pb.h"
#include "transcribe/jobs.h"  // jobs::Segment

constexpr int kChunkMs = 30000;
constexpr std::chrono::seconds kDeadline{60};
constexpr int kMaxAttempts = 2;

auto asr = transcribe::Asr::NewStub(grpc::CreateChannel("asr:9000", grpc::InsecureChannelCredentials()));

// The provider cannot decode this span: another attempt fails the same way.
struct CorruptAudio : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The provider did not transcribe the chunk within the attempts: a later redelivery may.
struct AsrUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The segments of chunk index (30 s of audio from index * 30 s), in order.
std::vector<jobs::Segment> transcribeChunk(const std::string& job_id, const std::string& audio_ref, int index) {
  const int end = (index + 1) * kChunkMs;
  int offset = index * kChunkMs;
  std::vector<jobs::Segment> segments;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    // One stream for this chunk only, from where the last attempt stopped.
    transcribe::ChunkRequest request;
    request.set_job_id(job_id);
    request.set_audio_ref(audio_ref);
    request.set_chunk_index(index);
    request.set_offset_ms(offset);
    request.set_duration_ms(end - offset);
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    auto reader = asr->TranscribeChunk(&ctx, request);
    transcribe::Segment seg;
    while (reader->Read(&seg)) {
      segments.push_back({index, seg.start_ms(), seg.end_ms(), seg.speaker(), seg.text()});
      offset = seg.end_ms();
    }
    const grpc::Status status = reader->Finish();
    if (status.ok()) return segments;
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) {
      throw CorruptAudio("chunk " + std::to_string(index) + " of " + job_id + ": " + status.error_message());
    }
    // UNAVAILABLE, DEADLINE_EXCEEDED: the next attempt resumes at offset
  }
  throw AsrUnavailable("chunk " + std::to_string(index) + " of " + job_id + ": no transcript after " + std::to_string(kMaxAttempts) + " attempts");
}
`,
    },
  },
  harness: {
    python: `import grpc

import transcription_pb2
import transcription_pb2_grpc

REF = "s3://calls/2026-11-02/support-0412.wav"
AUDIO_MS = 90_000
SEGMENT_MS = 10_000


class Asr(transcription_pb2_grpc.AsrServicer):
    """Ninety seconds of audio, one 10-second segment after another; with break_after set, the next
    stream fails UNAVAILABLE after that many segments (with break_always, every stream fails, even
    one that reached the end of its span)."""

    def __init__(self):
        self.break_after = None
        self.break_always = False

    def TranscribeChunk(self, request, context):
        end = AUDIO_MS if request.duration_ms == 0 else min(AUDIO_MS, request.offset_ms + request.duration_ms)
        t, sent = request.offset_ms, 0
        while t < end:
            if self.break_after is not None and sent == self.break_after:
                if not self.break_always:
                    self.break_after = None
                context.abort(grpc.StatusCode.UNAVAILABLE, "asr worker restarted mid-stream")
            yield transcription_pb2.Segment(start_ms=t, end_ms=min(t + SEGMENT_MS, end), speaker="AB"[(t // SEGMENT_MS) % 2], text=f"words at {t // 1000} s")
            t += SEGMENT_MS
            sent += 1
        if self.break_always:
            context.abort(grpc.StatusCode.UNAVAILABLE, "asr worker restarted mid-stream")


def _client(ctx):
    peer = Asr()
    ctx.grpc.serve(transcription_pb2_grpc.add_AsrServicer_to_server, peer)
    return ctx.load("client"), peer


def _calls(ctx):
    return ctx.grpc.calls_to("TranscribeChunk")


def _starts(segments):
    return [s["start_ms"] for s in segments]


def _raises(m, name, why):
    exc = getattr(m, name)
    try:
        got = m.transcribe_chunk("tr-1", REF, 1)
    except exc:
        return
    except Exception as other:
        raise AssertionError(f"{why}: transcribe_chunk raised {type(other).__name__}: {other}, expected {name}") from other
    raise AssertionError(f"{why}: transcribe_chunk returned {len(got)} segments instead of raising {name}")


def check_chunk_span(ctx):
    m, _ = _client(ctx)
    segments = m.transcribe_chunk("tr-1", REF, 1)
    request = _calls(ctx)[0].request
    assert _starts(segments) == [30000, 40000, 50000], f"chunk 1 is the 30 s from 30 000 ms, transcribe_chunk returned segments starting at {_starts(segments)}: the request asked for offset {request.offset_ms} ms, duration {request.duration_ms} ms (0 is the whole file)"
    assert request.chunk_index == 1 and request.offset_ms == 30000 and request.duration_ms == 30000, f"the request was chunk {request.chunk_index}, offset {request.offset_ms}, duration {request.duration_ms}; expected 1, 30000, 30000"
    assert all(s["chunk_index"] == 1 for s in segments), f"every segment belongs to chunk 1, got {segments}"


def check_deadline(ctx):
    m, peer = _client(ctx)
    m.transcribe_chunk("tr-1", REF, 0)
    call = _calls(ctx)[0]
    assert call.timeout is not None, "the TranscribeChunk stream carries no deadline: a stalled provider holds the worker and its chunk indefinitely"
    assert 59 <= call.timeout <= 61, f"the TranscribeChunk stream carries a {call.timeout} s deadline, expected DEADLINE_S = 60"
    ctx.grpc.set_latency("TranscribeChunk", 120.0)
    _raises(m, "AsrUnavailable", "with the provider stalled past the deadline")
    assert len(_calls(ctx)) == 3, f"a stalled provider gets its two attempts, then the chunk is given up: {len(_calls(ctx)) - 1} attempts were made"
    # A slow provider answers 59 s into each stream, and the first stream breaks after one segment.
    ctx.grpc.set_latency("TranscribeChunk", 59.0)
    peer.break_after = 1
    try:
        m.transcribe_chunk("tr-1", REF, 1)
    except Exception as e:  # noqa: BLE001
        timeouts = [c.timeout for c in _calls(ctx)[3:]]
        raise AssertionError(f"a first stream that broke 59 s in left the retry nothing: transcribe_chunk raised {type(e).__name__}: {e}; the streams carried deadlines of {timeouts} s, expected DEADLINE_S = 60 on each attempt") from e
    timeouts = [c.timeout for c in _calls(ctx)[3:]]
    assert len(timeouts) == 2 and all(t is not None and 59 <= t <= 61 for t in timeouts), f"the broken stream and its retry carried deadlines of {timeouts} s: each attempt gets DEADLINE_S = 60 of its own"


def check_max_attempts(ctx):
    m, peer = _client(ctx)
    # Every stream breaks after one segment: the chunk is never whole.
    peer.break_after, peer.break_always = 1, True
    _raises(m, "AsrUnavailable", "with every stream breaking after one segment (the chunk is never complete)")
    attempts = len(_calls(ctx))
    assert attempts == 2, f"a provider whose streams keep breaking was asked {attempts} times for one chunk, expected MAX_ATTEMPTS = 2"
    peer.break_after, peer.break_always = None, False
    ctx.grpc.fail("TranscribeChunk", grpc.StatusCode.UNAVAILABLE, "asr overloaded", times=10)
    _raises(m, "AsrUnavailable", "with the provider unavailable")
    attempts = len(_calls(ctx)) - 2
    assert attempts == 2, f"an unavailable provider was asked {attempts} times for one chunk, expected MAX_ATTEMPTS = 2: each attempt is billed"


def check_resume_offset(ctx):
    m, peer = _client(ctx)
    peer.break_after = 1
    segments = m.transcribe_chunk("tr-1", REF, 1)
    assert _starts(segments) == [30000, 40000, 50000], f"after a stream broke one segment into chunk 1, transcribe_chunk returned segments starting at {_starts(segments)}: every segment of the chunk once"
    calls = _calls(ctx)
    assert len(calls) == 2, f"one broken stream and its retry are 2 calls, got {len(calls)}"
    retry = calls[1].request
    assert retry.offset_ms == 40000 and retry.duration_ms == 20000, f"the retry asked for offset {retry.offset_ms} ms, duration {retry.duration_ms} ms; expected 40 000 (where the first stream stopped) for the remaining 20 000 ms"


def check_corrupt_terminal(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("TranscribeChunk", grpc.StatusCode.INVALID_ARGUMENT, "corrupt audio: no decodable frames", times=5)
    _raises(m, "CorruptAudio", "with audio the provider cannot decode")
    attempts = len(_calls(ctx))
    assert attempts == 1, f"corrupt audio was sent {attempts} times: INVALID_ARGUMENT fails the same way on every attempt"
`,
    typescript: `const REF = 's3://calls/2026-11-02/support-0412.wav';
const AUDIO_MS = 90_000;
const SEGMENT_MS = 10_000;

/** Ninety seconds of audio, one 10-second segment after another; with breakAfter set, the next stream fails UNAVAILABLE after that many segments (with breakAlways, every stream fails, even one that reached the end of its span). */
function client(ctx) {
  const pkg = ctx.proto('transcription.proto');
  const peer = {breakAfter: null as number | null, breakAlways: false};
  ctx.grpc.serve(pkg.transcribe.Asr.service, {
    TranscribeChunk(call) {
      const offset = Number(call.request.offset_ms ?? 0);
      const duration = Number(call.request.duration_ms ?? 0);
      const end = duration === 0 ? AUDIO_MS : Math.min(AUDIO_MS, offset + duration);
      let sent = 0;
      for (let t = offset; t < end; t += SEGMENT_MS) {
        if (peer.breakAfter !== null && sent === peer.breakAfter) {
          if (!peer.breakAlways) peer.breakAfter = null;
          call.emit('error', Object.assign(new Error('asr worker restarted mid-stream'), {code: ctx.grpc.status.UNAVAILABLE}));
          return;
        }
        call.write({start_ms: t, end_ms: Math.min(t + SEGMENT_MS, end), speaker: (t / SEGMENT_MS) % 2 === 0 ? 'A' : 'B', text: \`words at \${t / 1000} s\`});
        sent += 1;
      }
      if (peer.breakAlways) {
        call.emit('error', Object.assign(new Error('asr worker restarted mid-stream'), {code: ctx.grpc.status.UNAVAILABLE}));
        return;
      }
      call.end();
    },
  });
  return {m: ctx.load('client'), peer};
}

const calls = ctx => ctx.grpc.callsTo('TranscribeChunk');
const starts = segments => segments.map(s => s.start_ms);

async function raises(m, name: string, why: string): Promise<void> {
  let got;
  try {
    got = await m.transcribeChunk('tr-1', REF, 1);
  } catch (e) {
    if (e instanceof m[name]) return;
    assert.fail(\`\${why}: transcribeChunk threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected \${name}\`);
  }
  assert.fail(\`\${why}: transcribeChunk returned \${got.length} segments instead of throwing \${name}\`);
}

export async function check_chunk_span(ctx) {
  const {m} = client(ctx);
  const segments = await m.transcribeChunk('tr-1', REF, 1);
  const request = calls(ctx)[0].request;
  assert.deepStrictEqual(starts(segments), [30000, 40000, 50000], \`chunk 1 is the 30 s from 30 000 ms, transcribeChunk returned segments starting at \${JSON.stringify(starts(segments))}: the request asked for offset \${request.offset_ms ?? 0} ms, duration \${request.duration_ms ?? 0} ms (0 is the whole file)\`);
  assert(Number(request.chunk_index) === 1 && Number(request.offset_ms) === 30000 && Number(request.duration_ms) === 30000, \`the request was \${JSON.stringify(request)}; expected chunk 1, offset 30000, duration 30000\`);
  assert(segments.every(s => s.chunk_index === 1), \`every segment belongs to chunk 1, got \${JSON.stringify(segments)}\`);
}

export async function check_deadline(ctx) {
  const {m, peer} = client(ctx);
  await m.transcribeChunk('tr-1', REF, 0);
  const call = calls(ctx)[0];
  assert(call.timeout !== null, 'the TranscribeChunk stream carries no deadline: a stalled provider holds the worker and its chunk indefinitely');
  assert(59 <= call.timeout && call.timeout <= 61, \`the TranscribeChunk stream carries a \${call.timeout} s deadline, expected DEADLINE_MS = 60000\`);
  ctx.grpc.setLatency('TranscribeChunk', 120.0);
  await raises(m, 'AsrUnavailable', 'with the provider stalled past the deadline');
  assert.equal(calls(ctx).length, 3, \`a stalled provider gets its two attempts, then the chunk is given up: \${calls(ctx).length - 1} attempts were made\`);
  // A slow provider answers 59 s into each stream, and the first stream breaks after one segment.
  ctx.grpc.setLatency('TranscribeChunk', 59.0);
  peer.breakAfter = 1;
  const timeouts = () => calls(ctx).slice(3).map(c => c.timeout);
  try {
    await m.transcribeChunk('tr-1', REF, 1);
  } catch (e) {
    assert.fail(\`a first stream that broke 59 s in left the retry nothing: transcribeChunk threw \${(e as Error).constructor.name}: \${(e as Error).message}; the streams carried deadlines of \${JSON.stringify(timeouts())} s, expected DEADLINE_MS = 60000 on each attempt\`);
  }
  assert(timeouts().length === 2 && timeouts().every(t => t !== null && 59 <= t && t <= 61), \`the broken stream and its retry carried deadlines of \${JSON.stringify(timeouts())} s: each attempt gets DEADLINE_MS = 60000 of its own\`);
}

export async function check_max_attempts(ctx) {
  const {m, peer} = client(ctx);
  // Every stream breaks after one segment: the chunk is never whole.
  peer.breakAfter = 1;
  peer.breakAlways = true;
  await raises(m, 'AsrUnavailable', 'with every stream breaking after one segment (the chunk is never complete)');
  assert.equal(calls(ctx).length, 2, \`a provider whose streams keep breaking was asked \${calls(ctx).length} times for one chunk, expected MAX_ATTEMPTS = 2\`);
  peer.breakAfter = null;
  peer.breakAlways = false;
  ctx.grpc.fail('TranscribeChunk', ctx.grpc.status.UNAVAILABLE, 'asr overloaded', 10);
  await raises(m, 'AsrUnavailable', 'with the provider unavailable');
  assert.equal(calls(ctx).length - 2, 2, \`an unavailable provider was asked \${calls(ctx).length - 2} times for one chunk, expected MAX_ATTEMPTS = 2: each attempt is billed\`);
}

export async function check_resume_offset(ctx) {
  const {m, peer} = client(ctx);
  peer.breakAfter = 1;
  const segments = await m.transcribeChunk('tr-1', REF, 1);
  assert.deepStrictEqual(starts(segments), [30000, 40000, 50000], \`after a stream broke one segment into chunk 1, transcribeChunk returned segments starting at \${JSON.stringify(starts(segments))}: every segment of the chunk once\`);
  assert.equal(calls(ctx).length, 2, \`one broken stream and its retry are 2 calls, got \${calls(ctx).length}\`);
  const retry = calls(ctx)[1].request;
  assert(Number(retry.offset_ms) === 40000 && Number(retry.duration_ms) === 20000, \`the retry asked for offset \${retry.offset_ms} ms, duration \${retry.duration_ms} ms; expected 40 000 (where the first stream stopped) for the remaining 20 000 ms\`);
}

export async function check_corrupt_terminal(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('TranscribeChunk', ctx.grpc.status.INVALID_ARGUMENT, 'corrupt audio: no decodable frames', 5);
  await raises(m, 'CorruptAudio', 'with audio the provider cannot decode');
  assert.equal(calls(ctx).length, 1, \`corrupt audio was sent \${calls(ctx).length} times: INVALID_ARGUMENT fails the same way on every attempt\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "transcribe/gen/transcription"
	"transcribe/jobs"

	"leetbuild/harness"
)

const (
	clientRef  = "s3://calls/2026-11-02/support-0412.wav"
	audioMs    = 90000
	segmentMs  = 10000
	speakers   = "AB"
	noBreaking = -1
)

// asrPeer is ninety seconds of audio, one 10-second segment after another; with breakAfter >= 0,
// the next stream fails UNAVAILABLE after that many segments (with breakAlways, every stream
// fails, even one that reached the end of its span).
type asrPeer struct {
	pb.UnimplementedAsrServer
	breakAfter  int
	breakAlways bool
}

func (p *asrPeer) TranscribeChunk(req *pb.ChunkRequest, srv pb.Asr_TranscribeChunkServer) error {
	end := audioMs
	if req.GetDurationMs() != 0 {
		end = min(audioMs, int(req.GetOffsetMs()+req.GetDurationMs()))
	}
	sent := 0
	for t := int(req.GetOffsetMs()); t < end; t += segmentMs {
		if p.breakAfter >= 0 && sent == p.breakAfter {
			if !p.breakAlways {
				p.breakAfter = noBreaking
			}
			return status.Error(codes.Unavailable, "asr worker restarted mid-stream")
		}
		seg := &pb.Segment{StartMs: int32(t), EndMs: int32(min(t+segmentMs, end)), Speaker: string(speakers[(t/segmentMs)%2]), Text: fmt.Sprintf("words at %d s", t/1000)}
		if err := srv.Send(seg); err != nil {
			return err
		}
		sent++
	}
	if p.breakAlways {
		return status.Error(codes.Unavailable, "asr worker restarted mid-stream")
	}
	return nil
}

func asrWorld(ctx *harness.Ctx) *asrPeer {
	peer := &asrPeer{breakAfter: noBreaking}
	pb.RegisterAsrServer(ctx.GRPC.Server(""), peer)
	return peer
}

func asrCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("TranscribeChunk", "") }

func startsOf(segments []jobs.Segment) []int {
	out := []int{}
	for _, s := range segments {
		out = append(out, s.StartMs)
	}
	return out
}

func mustTranscribe(ctx *harness.Ctx, index int) []jobs.Segment {
	segments, err := transcribeChunk(context.Background(), "tr-1", clientRef, index)
	ctx.NoError(err, "transcribeChunk(chunk %d) failed", index)
	return segments
}

func mustFail(ctx *harness.Ctx, target error, why string) {
	segments, err := transcribeChunk(context.Background(), "tr-1", clientRef, 1)
	ctx.Assert(err != nil, "%s: transcribeChunk returned %d segments instead of an error wrapping %v", why, len(segments), target)
	ctx.ErrorIs(err, target, "%s: transcribeChunk returned %v", why, err)
}

func CheckChunkSpan(ctx *harness.Ctx) {
	asrWorld(ctx)
	segments := mustTranscribe(ctx, 1)
	req := asrCalls(ctx)[0].Request.(*pb.ChunkRequest)
	ctx.Equal(startsOf(segments), []int{30000, 40000, 50000}, "chunk 1 is the 30 s from 30 000 ms; the request asked for offset %d ms, duration %d ms (0 is the whole file); the segment starts", req.GetOffsetMs(), req.GetDurationMs())
	ctx.Assert(req.GetChunkIndex() == 1 && req.GetOffsetMs() == 30000 && req.GetDurationMs() == 30000, "the request was chunk %d, offset %d, duration %d; expected 1, 30000, 30000", req.GetChunkIndex(), req.GetOffsetMs(), req.GetDurationMs())
	for _, s := range segments {
		ctx.Equal(s.ChunkIndex, 1, "every segment belongs to chunk 1 (%+v)", s)
	}
}

func CheckDeadline(ctx *harness.Ctx) {
	peer := asrWorld(ctx)
	mustTranscribe(ctx, 0)
	call := asrCalls(ctx)[0]
	ctx.Assert(call.HasDeadline(), "the TranscribeChunk stream carries no deadline: a stalled provider holds the worker and its chunk indefinitely")
	ctx.Assert(59*time.Second <= call.Timeout && call.Timeout <= 61*time.Second, "the TranscribeChunk stream carries a %v deadline, expected 60 s", call.Timeout)
	ctx.GRPC.SetLatency("TranscribeChunk", 120.0, "")
	mustFail(ctx, ErrAsrUnavailable, "with the provider stalled past the deadline")
	ctx.Equal(len(asrCalls(ctx))-1, 2, "a stalled provider gets its two attempts, then the chunk is given up; attempts")
	// A slow provider answers 59 s into each stream, and the first stream breaks after one segment.
	ctx.GRPC.SetLatency("TranscribeChunk", 59.0, "")
	peer.breakAfter = 1
	_, err := transcribeChunk(context.Background(), "tr-1", clientRef, 1)
	var timeouts []time.Duration
	ok := true
	for _, c := range asrCalls(ctx)[3:] {
		timeouts = append(timeouts, c.Timeout)
		ok = ok && c.HasDeadline() && 59*time.Second <= c.Timeout && c.Timeout <= 61*time.Second
	}
	ctx.Assert(err == nil, "a first stream that broke 59 s in left the retry nothing: transcribeChunk returned %v; the streams carried deadlines of %v, expected 60 s on each attempt", err, timeouts)
	ctx.Assert(len(timeouts) == 2 && ok, "the broken stream and its retry carried deadlines of %v: each attempt gets 60 s of its own", timeouts)
}

func CheckMaxAttempts(ctx *harness.Ctx) {
	peer := asrWorld(ctx)
	// Every stream breaks after one segment: the chunk is never whole.
	peer.breakAfter, peer.breakAlways = 1, true
	mustFail(ctx, ErrAsrUnavailable, "with every stream breaking after one segment (the chunk is never complete)")
	ctx.Equal(len(asrCalls(ctx)), 2, "a provider whose streams keep breaking is asked MAX_ATTEMPTS = 2 times for one chunk; attempts")
	peer.breakAfter, peer.breakAlways = noBreaking, false
	ctx.GRPC.Fail("TranscribeChunk", codes.Unavailable, "asr overloaded", 10, "")
	mustFail(ctx, ErrAsrUnavailable, "with the provider unavailable")
	ctx.Equal(len(asrCalls(ctx))-2, 2, "an unavailable provider is asked MAX_ATTEMPTS = 2 times for one chunk (each attempt is billed); attempts")
}

func CheckResumeOffset(ctx *harness.Ctx) {
	peer := asrWorld(ctx)
	peer.breakAfter = 1
	segments := mustTranscribe(ctx, 1)
	ctx.Equal(startsOf(segments), []int{30000, 40000, 50000}, "after a stream broke one segment into chunk 1, every segment of the chunk once; the segment starts")
	calls := asrCalls(ctx)
	ctx.Equal(len(calls), 2, "one broken stream and its retry; calls")
	retry := calls[1].Request.(*pb.ChunkRequest)
	ctx.Assert(retry.GetOffsetMs() == 40000 && retry.GetDurationMs() == 20000, "the retry asked for offset %d ms, duration %d ms; expected 40 000 (where the first stream stopped) for the remaining 20 000 ms", retry.GetOffsetMs(), retry.GetDurationMs())
}

func CheckCorruptTerminal(ctx *harness.Ctx) {
	asrWorld(ctx)
	ctx.GRPC.Fail("TranscribeChunk", codes.InvalidArgument, "corrupt audio: no decodable frames", 5, "")
	mustFail(ctx, ErrCorruptAudio, "with audio the provider cannot decode")
	ctx.Equal(len(asrCalls(ctx)), 1, "INVALID_ARGUMENT fails the same way on every attempt; attempts")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <exception>
#include <string>
#include <vector>

namespace {

const std::string kClientRef = "s3://calls/2026-11-02/support-0412.wav";
constexpr int kAudioMs = 90000;
constexpr int kSegmentMs = 10000;

// Ninety seconds of audio, one 10-second segment after another; with break_after >= 0, the next
// stream fails UNAVAILABLE after that many segments (with break_always, every stream fails, even
// one that reached the end of its span).
class AsrPeer final : public transcribe::Asr::Service {
 public:
  int break_after = -1;
  bool break_always = false;

  grpc::Status TranscribeChunk(grpc::ServerContext*, const transcribe::ChunkRequest* req, grpc::ServerWriter<transcribe::Segment>* srv) override {
    const int end = req->duration_ms() == 0 ? kAudioMs : std::min(kAudioMs, req->offset_ms() + req->duration_ms());
    int sent = 0;
    for (int t = req->offset_ms(); t < end; t += kSegmentMs) {
      if (break_after >= 0 && sent == break_after) {
        if (!break_always) break_after = -1;
        return grpc::Status(grpc::StatusCode::UNAVAILABLE, "asr worker restarted mid-stream");
      }
      transcribe::Segment seg;
      seg.set_start_ms(t);
      seg.set_end_ms(std::min(t + kSegmentMs, end));
      seg.set_speaker((t / kSegmentMs) % 2 == 0 ? "A" : "B");
      seg.set_text("words at " + std::to_string(t / 1000) + " s");
      if (!srv->Write(seg)) return grpc::Status::CANCELLED;
      sent++;
    }
    if (break_always) return grpc::Status(grpc::StatusCode::UNAVAILABLE, "asr worker restarted mid-stream");
    return grpc::Status::OK;
  }
};

AsrPeer& asrWorld(harness::Ctx& ctx) {
  static AsrPeer* peer = nullptr;
  delete peer;
  peer = new AsrPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::vector<int> startsOf(const std::vector<jobs::Segment>& segments) {
  std::vector<int> out;
  for (const auto& s : segments) out.push_back(s.start_ms);
  return out;
}

std::vector<jobs::Segment> mustTranscribe(harness::Ctx& ctx, int index) {
  try {
    return transcribeChunk("tr-1", kClientRef, index);
  } catch (const std::exception& e) {
    ctx.Fatalf("transcribeChunk(chunk %d) threw %s: %s", index, harness::CurrentExceptionType(), e.what());
  }
  return {};
}

template <class E>
void mustThrow(harness::Ctx& ctx, const std::string& expected, const std::string& why) {
  size_t got = 0;
  try {
    got = transcribeChunk("tr-1", kClientRef, 1).size();
  } catch (const E&) {
    return;
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: transcribeChunk threw %s: %s, expected %s", why, harness::CurrentExceptionType(), e.what(), expected);
  }
  ctx.Fatalf("%s: transcribeChunk returned %d segments instead of throwing %s", why, got, expected);
}

}  // namespace

void CheckChunkSpan(harness::Ctx& ctx) {
  asrWorld(ctx);
  const auto segments = mustTranscribe(ctx, 1);
  const auto req = ctx.GRPC.CallsTo("TranscribeChunk")[0].Request<transcribe::ChunkRequest>();
  ctx.Equal(startsOf(segments), {30000, 40000, 50000}, "chunk 1 is the 30 s from 30 000 ms; the request asked for offset %d ms, duration %d ms (0 is the whole file); the segment starts", req.offset_ms(), req.duration_ms());
  ctx.Assert(req.chunk_index() == 1 && req.offset_ms() == 30000 && req.duration_ms() == 30000, "the request was chunk %d, offset %d, duration %d; expected 1, 30000, 30000", req.chunk_index(), req.offset_ms(), req.duration_ms());
  for (const auto& s : segments) ctx.Equal(s.chunk_index, 1, "every segment belongs to chunk 1; its chunk_index");
}

void CheckDeadline(harness::Ctx& ctx) {
  AsrPeer& peer = asrWorld(ctx);
  mustTranscribe(ctx, 0);
  const auto call = ctx.GRPC.CallsTo("TranscribeChunk")[0];
  ctx.Assert(call.HasDeadline(), "the TranscribeChunk stream carries no deadline: a stalled provider holds the worker and its chunk indefinitely");
  ctx.Assert(59 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 61, "the TranscribeChunk stream carries a %v s deadline, expected kDeadline = 60 s", call.TimeoutSeconds());
  ctx.GRPC.SetLatency("TranscribeChunk", 120.0);
  mustThrow<AsrUnavailable>(ctx, "AsrUnavailable", "with the provider stalled past the deadline");
  ctx.Equal(ctx.GRPC.CallsTo("TranscribeChunk").size() - 1, 2, "a stalled provider gets its two attempts, then the chunk is given up; attempts");
  // A slow provider answers 59 s into each stream, and the first stream breaks after one segment.
  ctx.GRPC.SetLatency("TranscribeChunk", 59.0);
  peer.break_after = 1;
  std::string error;
  try {
    transcribeChunk("tr-1", kClientRef, 1);
  } catch (const std::exception& e) {
    error = std::string(harness::CurrentExceptionType()) + ": " + e.what();
  }
  const auto calls = ctx.GRPC.CallsTo("TranscribeChunk");
  std::vector<double> timeouts;
  bool each = true;
  for (size_t i = 3; i < calls.size(); i++) {
    timeouts.push_back(calls[i].HasDeadline() ? calls[i].TimeoutSeconds() : -1);
    each = each && calls[i].HasDeadline() && 59 <= calls[i].TimeoutSeconds() && calls[i].TimeoutSeconds() <= 61;
  }
  ctx.Assert(error.empty(), "a first stream that broke 59 s in left the retry nothing: transcribeChunk threw %s; the streams carried deadlines of %v s (-1: none), expected kDeadline = 60 s on each attempt", error, timeouts);
  ctx.Assert(timeouts.size() == 2 && each, "the broken stream and its retry carried deadlines of %v s (-1: none): each attempt gets kDeadline = 60 s of its own", timeouts);
}

void CheckMaxAttempts(harness::Ctx& ctx) {
  AsrPeer& peer = asrWorld(ctx);
  // Every stream breaks after one segment: the chunk is never whole.
  peer.break_after = 1;
  peer.break_always = true;
  mustThrow<AsrUnavailable>(ctx, "AsrUnavailable", "with every stream breaking after one segment (the chunk is never complete)");
  ctx.Equal(ctx.GRPC.CallsTo("TranscribeChunk").size(), 2, "a provider whose streams keep breaking is asked kMaxAttempts = 2 times for one chunk; attempts");
  peer.break_after = -1;
  peer.break_always = false;
  ctx.GRPC.Fail("TranscribeChunk", grpc::StatusCode::UNAVAILABLE, "asr overloaded", 10);
  mustThrow<AsrUnavailable>(ctx, "AsrUnavailable", "with the provider unavailable");
  ctx.Equal(ctx.GRPC.CallsTo("TranscribeChunk").size() - 2, 2, "an unavailable provider is asked kMaxAttempts = 2 times for one chunk (each attempt is billed); attempts");
}

void CheckResumeOffset(harness::Ctx& ctx) {
  AsrPeer& peer = asrWorld(ctx);
  peer.break_after = 1;
  const auto segments = mustTranscribe(ctx, 1);
  ctx.Equal(startsOf(segments), {30000, 40000, 50000}, "after a stream broke one segment into chunk 1, every segment of the chunk once; the segment starts");
  const auto calls = ctx.GRPC.CallsTo("TranscribeChunk");
  ctx.Equal(calls.size(), 2, "one broken stream and its retry; calls");
  const auto retry = calls[1].Request<transcribe::ChunkRequest>();
  ctx.Assert(retry.offset_ms() == 40000 && retry.duration_ms() == 20000, "the retry asked for offset %d ms, duration %d ms; expected 40 000 (where the first stream stopped) for the remaining 20 000 ms", retry.offset_ms(), retry.duration_ms());
}

void CheckCorruptTerminal(harness::Ctx& ctx) {
  asrWorld(ctx);
  ctx.GRPC.Fail("TranscribeChunk", grpc::StatusCode::INVALID_ARGUMENT, "corrupt audio: no decodable frames", 5);
  mustThrow<CorruptAudio>(ctx, "CorruptAudio", "with audio the provider cannot decode");
  ctx.Equal(ctx.GRPC.CallsTo("TranscribeChunk").size(), 1, "INVALID_ARGUMENT fails the same way on every attempt; attempts");
}
`,
  },
  hints: [
    'Transcribe chunk 1 of a 90-second file: segments from 0 s to 90 s come back. Break the stream after one segment: that segment appears twice. Corrupt audio is sent five times.',
    'The request never sets `offset_ms` or `duration_ms`, so the provider reads it as the whole file; every retry resends that same request and appends to the list it already filled; the `except` treats every status as worth retrying.',
    'Build the request from `offset = index * CHUNK_MS` and `duration_ms = end - offset`, move `offset` to each `seg.end_ms`, loop `range(MAX_ATTEMPTS)` with `timeout=DEADLINE_S`, and raise `CorruptAudio` on `INVALID_ARGUMENT`.',
  ],
  debrief: `The offset is the whole design: a stream that already delivered 10 seconds of a chunk has told the client exactly where to resume, so the retry asks for what is missing and the segments come back once each. Sending the chunk's own span is what turns one bad minute into one re-sent minute instead of a re-billed file. The deadline and the attempt bound hand a stuck chunk back to the ledger, which records it failed for a later redelivery, and \`INVALID_ARGUMENT\` skips the retry because corrupt bytes decode the same way every time. Production clients add jittered backoff between attempts, overlap chunk boundaries by a second so a word cut in half is heard twice and merged, and track provider cost per chunk.`,
};
