import type {Step} from '@/lib/types';

export const transcriptionDependencyStep: Step = {
  id: 'dependency',
  title: 'ASR streams that resume, never restart',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'asr', 'redis'],
  task: `## Task

**Starting point.** The starter's \`transcribe_chunk(job_id, audio_ref, chunk)\` opens one
\`TranscribeChunk\` stream for the whole file, collects the segments, and on any gRPC error calls a
helper that re-runs the file from byte zero in an unbounded loop. It compiles, it serves the demo,
and it hides five flaws.

\`\`\`proto
service Asr {
  rpc TranscribeChunk(ChunkRequest) returns (stream Segment);
}
message ChunkRequest { string job_id = 1; string audio_ref = 2; uint32 chunk_index = 3; int64 offset_ms = 4; uint32 seconds = 5; }
message Segment      { string text = 1; }
\`\`\`

**Failure mode the checks target.** The starter has no idea what a span is: it recovers one bad
minute by re-running the file, retries bytes already known to be corrupt, and bounds neither the
attempt count nor the time one stream may take. A demo whose audio is one perfect minute shows none
of that; the bill shows all of it. Keep the shape: one request built from one chunk, one bounded
loop around it, one terminal branch for the failure that cannot succeed.

- **One stream per chunk.** The \`ChunkRequest\` carries \`chunk_index\` and the chunk's own
  \`offset_ms\` beside the job and the audio reference.
- **A 60-second deadline per attempt** (\`timeout=DEADLINE_S\`, \`deadline: Date.now() + DEADLINE_MS\`,
  a context with timeout, \`withDeadlineAfter\`, \`set_deadline\`).
- **At most two attempts per chunk**, each re-sending this chunk's request. No path reads the file
  from its start.
- **A corrupt-audio rejection is terminal for the span.** \`INVALID_ARGUMENT\` whose details carry
  the \`corrupt\` marker records \`HSET chunks:{job_id} {index} "corrupt"\` and returns a terminal
  result; the read path reports that span as failed.

:::widget grpc-streams {"mode": "server"}

:::widget deadline-retry {"base": 250, "deadline": 60000, "attempts": 2}`,
  sequence: {
    participants: ['Chunk worker', 'ASR provider', 'Redis'],
    messages: [
      {
        from: 'Chunk worker',
        to: 'ASR provider',
        label: 'TranscribeChunk(job, chunk 12, offset 360 s) · deadline 60 s · attempt 1',
        kind: 'sync',
      },
      {from: 'ASR provider', to: 'Chunk worker', label: 'DEADLINE_EXCEEDED after 60 s', kind: 'reply'},
      {
        from: 'Chunk worker',
        to: 'ASR provider',
        label: 'attempt 2 · the same request · chunk 12, offset 360 s — never offset 0',
        kind: 'sync',
      },
      {from: 'ASR provider', to: 'Chunk worker', label: 'INVALID_ARGUMENT · corrupt audio in this span', kind: 'reply'},
      {from: 'Chunk worker', to: 'Redis', label: 'HSET chunks:{job} 12 "corrupt" · terminal marker', kind: 'sync'},
      {from: 'Redis', to: 'Chunk worker', label: 'OK · the read path reports this span as failed', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: a two-hour file with one flaky minute was billed as three transcriptions, one worker has been stuck on the same chunk since yesterday, and a corrupt span shows thousands of provider calls.',
    'Mechanism: the request names only the file, so a retry can only mean the whole file; `restart_from_start` loops `while True` with no deadline and treats `INVALID_ARGUMENT` like any other error.',
    'Change: build one `ChunkRequest` with `chunk_index` and `offset_ms`, loop `range(MAX_ATTEMPTS)` (2) with `timeout=DEADLINE_S` (60), on `INVALID_ARGUMENT` + `CORRUPT_MARKER` call `record_terminal_marker` and return `terminal=True`; delete `restart_from_start`.',
  ],
  checks: [
    {
      id: 'per-chunk-stream',
      title: 'One stream per chunk, and the request names the span',
      detail:
        'The `ChunkRequest` carries `chunk_index` and the chunk’s own `offset_ms` beside the job and the audio reference, so the provider streams back exactly that span. The starter sends the file reference alone: the provider cannot tell which minute it is asked about, and the reply is a whole-file job.',
      match: {
        python: {
          all: [/chunk_index\s*=\s*chunk\.index/, /offset_ms\s*=\s*chunk\.offset_ms/, /\.TranscribeChunk\(/],
        },
        typescript: {
          all: [/chunk_index:\s*chunk\.index/, /offset_ms:\s*chunk\.offset_ms/, /\.TranscribeChunk\(/],
        },
        go: {all: [/ChunkIndex:\s*chunk\.Index/, /OffsetMs:\s*chunk\.OffsetMs/, /\.TranscribeChunk\(/]},
        scala: {all: [/chunkIndex\s*=\s*chunk\.index/, /offsetMs\s*=\s*chunk\.offsetMs/, /\.transcribeChunk\(/]},
        cpp: {all: [/set_chunk_index\(chunk\.index\)/, /set_offset_ms\(chunk\.offset_ms\)/, /\.TranscribeChunk\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every attempt carries a 60-second deadline',
      detail:
        'Each attempt is bounded to 60 s (`timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, a context with timeout, `withDeadlineAfter`, `set_deadline`). The starter calls the provider with no bound at all, so one wedged stream holds the worker that owns the rest of the file.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*60/, /timeout=DEADLINE_S/, /\.TranscribeChunk\(/]},
        typescript: {
          all: [/DEADLINE_MS\s*=\s*60_?000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.TranscribeChunk\(/],
        },
        go: {
          all: [
            /(deadlineMs\s*=\s*60000|deadlineMs\s*=\s*60\s*\*\s*time\.Second)/,
            /context\.WithTimeout/,
            /\.TranscribeChunk\(/,
          ],
        },
        scala: {
          all: [
            /(DeadlineMs\s*=\s*60000|DeadlineMs\s*=\s*60L?\s*\*\s*1000)/,
            /withDeadlineAfter/,
            /\.transcribeChunk\(/,
          ],
        },
        cpp: {all: [/kDeadlineMs\s*=\s*60000/, /set_deadline\(/, /\.TranscribeChunk\(/]},
      },
    },
    {
      id: 'max-attempts',
      title: 'At most two attempts per chunk',
      detail:
        'The budget is per chunk — `MAX_ATTEMPTS = 2` and a bounded loop — so a failing span costs two calls and then stops. The starter has no bound at all: a corrupt or permanently rejected span is retried until someone restarts the worker.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2/, /range\(MAX_ATTEMPTS\)/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*2/, /attempt\s*<\s*MAX_ATTEMPTS/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/maxAttempts\s*=\s*2/, /attempt\s*<\s*maxAttempts/], none: [/for\s*\{/]},
        scala: {all: [/MaxAttempts\s*=\s*2/, /attempt\s*<\s*MaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2/, /attempt\s*<\s*kMaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'terminal-corrupt',
      title: 'A corrupt-audio rejection is terminal for the span',
      detail:
        'The corrupt marker is a named constant, and `INVALID_ARGUMENT` carrying it records the marker for that chunk and returns a terminal result right there, before the retry in the loop. The starter retries the rejection forever, so a span that cannot transcribe burns one provider call per iteration and is never marked.',
      match: {
        python: {
          all: [/CORRUPT_MARKER\s*=\s*["']corrupt["']/, /record_terminal_marker\(/],
          order: [/StatusCode\.INVALID_ARGUMENT/, /record_terminal_marker\(/, /terminal=True/],
        },
        typescript: {
          all: [/CORRUPT_MARKER\s*=\s*['"]corrupt['"]/, /recordTerminalMarker\(/],
          order: [/grpc\.status\.INVALID_ARGUMENT/, /recordTerminalMarker\(/, /terminal:\s*true/],
        },
        go: {
          all: [/corruptMarker\s*=\s*["']corrupt["']/, /recordTerminalMarker\(/],
          order: [/codes\.InvalidArgument/, /recordTerminalMarker\(/, /Terminal:\s*true/],
        },
        scala: {
          all: [/CorruptMarker\s*=\s*["']corrupt["']/, /recordTerminalMarker\(/],
          order: [/Status\.Code\.INVALID_ARGUMENT/, /recordTerminalMarker\(/, /terminal\s*=\s*true/],
        },
        cpp: {
          all: [/kCorruptMarker\s*=\s*["']corrupt["']/, /record_terminal_marker\(/],
          order: [/StatusCode::INVALID_ARGUMENT/, /record_terminal_marker\(/, /terminal\s*=\s*true/],
        },
      },
    },
    {
      id: 'no-restart-from-start',
      title: 'A retry resumes this chunk, never the file',
      detail:
        'The call in the retry path is bound to the one request built from this chunk, and there is no whole-file path left: `restart_from_start` / `restartFromStart` / `transcribe_file` / a request for `offset_ms = 0` would re-transcribe — and re-bill — every minute of audio that already succeeded. The starter’s recovery *is* that restart.',
      match: {
        python: {
          all: [/\.TranscribeChunk\(request/],
          none: [/restart_from_start/, /transcribe_file\(/, /offset_ms=0/],
        },
        typescript: {
          all: [/\.TranscribeChunk\(request/],
          none: [/restartFromStart/, /transcribeFile\(/, /offset_ms:\s*0/],
        },
        go: {
          all: [/\.TranscribeChunk\(callCtx, request\)/],
          none: [/restartFromStart/, /transcribeFile\(/, /OffsetMs:\s*0/],
        },
        scala: {
          all: [/\.transcribeChunk\(request\)/],
          none: [/restartFromStart/, /transcribeFile\(/, /offsetMs\s*=\s*0/],
        },
        cpp: {
          all: [/\.TranscribeChunk\(&ctx, request\)/],
          none: [/restart_from_start/, /transcribe_file\(/, /set_offset_ms\(0\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import dataclasses
import logging

import grpc
import redis

import asr_pb2
import asr_pb2_grpc

logger = logging.getLogger("transcribe")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
channel = grpc.insecure_channel("asr:9000")
asr = asr_pb2_grpc.AsrStub(channel)


@dataclasses.dataclass
class Chunk:
    """One 30-second span of a job's audio, where it starts in the file and in the transcript."""

    index: int
    offset_ms: int


def restart_from_start(job_id: str, audio_ref: str, chunk: Chunk) -> dict:
    """Re-run the file from byte zero whenever a chunk fails, so nothing is left half-transcribed."""
    while True:
        try:
            stream = asr.TranscribeChunk(asr_pb2.ChunkRequest(job_id=job_id, audio_ref=audio_ref))
            segments = [segment.text for segment in stream]
            return {"job_id": job_id, "segments": segments, "terminal": False}
        except grpc.RpcError as error:
            logger.warning("chunk %s failed, re-running the file: %s", chunk.index, error.code())


def transcribe_chunk(job_id: str, audio_ref: str, chunk: Chunk) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    try:
        stream = asr.TranscribeChunk(asr_pb2.ChunkRequest(job_id=job_id, audio_ref=audio_ref))
        segments = [segment.text for segment in stream]
        return {"job_id": job_id, "segments": segments, "terminal": False}
    except grpc.RpcError as error:
        logger.warning("chunk %s failed: %s", chunk.index, error.code())
        return restart_from_start(job_id, audio_ref, chunk)
`,
      solution: `import dataclasses
import time

import grpc
import redis

import asr_pb2
import asr_pb2_grpc

DEADLINE_S = 60
MAX_ATTEMPTS = 2
BACKOFF_S = 0.25
CHUNK_SECONDS = 30
CHUNK_TTL_S = 24 * 3600
CORRUPT_MARKER = "corrupt"
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

r = redis.Redis(host="redis", port=6379, decode_responses=True)
channel = grpc.insecure_channel("asr:9000")
asr = asr_pb2_grpc.AsrStub(channel)


class ChunkUnavailable(RuntimeError):
    """Both attempts are spent: the span stays failed and the queue redelivers this chunk alone."""


@dataclasses.dataclass
class Chunk:
    """One 30-second span of a job's audio, where it starts in the file and in the transcript."""

    index: int
    offset_ms: int


@dataclasses.dataclass
class ChunkResult:
    """One chunk's segments, and whether the span is finished for good."""

    segments: list[str]
    terminal: bool


def record_terminal_marker(job_id: str, chunk_index: int) -> None:
    """The span is corrupt: mark it in the job's chunk map, so the read path reports the chunk as
    failed and no worker spends another attempt on it."""
    key = f"chunks:{job_id}"
    r.hset(key, str(chunk_index), CORRUPT_MARKER)
    r.expire(key, CHUNK_TTL_S)


def transcribe_chunk(job_id: str, audio_ref: str, chunk: Chunk) -> ChunkResult:
    """One stream per chunk, 60 s per attempt, at most two attempts, each from the chunk's own start."""
    request = asr_pb2.ChunkRequest(
        job_id=job_id,
        audio_ref=audio_ref,
        chunk_index=chunk.index,
        offset_ms=chunk.offset_ms,
        seconds=CHUNK_SECONDS,
    )
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            stream = asr.TranscribeChunk(request, timeout=DEADLINE_S)
            segments = [segment.text for segment in stream]
            return ChunkResult(segments=segments, terminal=False)
        except grpc.RpcError as error:
            if error.code() == grpc.StatusCode.INVALID_ARGUMENT and CORRUPT_MARKER in error.details():
                record_terminal_marker(job_id, chunk.index)
                return ChunkResult(segments=[], terminal=True)
            last_error = error
            if error.code() not in RETRYABLE:
                break
            if attempt + 1 < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S)
    raise ChunkUnavailable(f"chunk {chunk.index} of {job_id} failed: {last_error}")
`,
    },
    typescript: {
      starter: `/** Chunk worker: the starter. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Redis} from 'ioredis';

interface ChunkRequest {
  job_id: string;
  audio_ref: string;
}

interface Segment {
  text: string;
}

interface AsrClient {
  TranscribeChunk(request: ChunkRequest): grpc.ClientReadableStream<Segment>;
}

const {asr: asrPackage} = grpc.loadPackageDefinition(protoLoader.loadSync('asr.proto')) as unknown as {
  asr: {Asr: new (target: string, credentials: grpc.ChannelCredentials) => AsrClient};
};
const asr = new asrPackage.Asr('asr:9000', grpc.credentials.createInsecure());
const r = new Redis('redis://redis:6379');

export interface Chunk {
  index: number;
  offset_ms: number;
}

function collect(stream: grpc.ClientReadableStream<Segment>): Promise<string[]> {
  const segments: string[] = [];
  const {promise, resolve, reject} = Promise.withResolvers<string[]>();
  stream.on('data', (segment: Segment) => segments.push(segment.text));
  stream.on('error', reject);
  stream.on('end', () => resolve(segments));
  return promise;
}

/** Re-run the file from byte zero whenever a chunk fails, so nothing is left half-transcribed. */
async function restartFromStart(jobId: string, audioRef: string, chunk: Chunk): Promise<string[]> {
  for (;;) {
    try {
      const segments = await collect(asr.TranscribeChunk({job_id: jobId, audio_ref: audioRef}));
      await r.set(\`transcript:\${jobId}\`, segments.join(' '));
      return segments;
    } catch {
      continue;
    }
  }
}

export async function transcribeChunk(jobId: string, audioRef: string, chunk: Chunk): Promise<string[]> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  try {
    return await collect(asr.TranscribeChunk({job_id: jobId, audio_ref: audioRef}));
  } catch {
    return restartFromStart(jobId, audioRef, chunk);
  }
}
`,
      solution: `/** ASR chunk client: one stream per chunk, 60 s per attempt, two attempts, resumed from its own start. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Redis} from 'ioredis';

const DEADLINE_MS = 60_000;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 250;
const CHUNK_SECONDS = 30;
const CHUNK_TTL_S = 24 * 3600;
const CORRUPT_MARKER = 'corrupt';
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface ChunkRequest {
  job_id: string;
  audio_ref: string;
  chunk_index: number;
  offset_ms: number;
  seconds: number;
}

interface Segment {
  text: string;
}

interface AsrClient {
  TranscribeChunk(request: ChunkRequest, options: {deadline: number}): grpc.ClientReadableStream<Segment>;
}

const {asr: asrPackage} = grpc.loadPackageDefinition(protoLoader.loadSync('asr.proto')) as unknown as {
  asr: {Asr: new (target: string, credentials: grpc.ChannelCredentials) => AsrClient};
};
const asr = new asrPackage.Asr('asr:9000', grpc.credentials.createInsecure());
const r = new Redis('redis://redis:6379');

export interface Chunk {
  index: number;
  offset_ms: number;
}

export interface ChunkResult {
  segments: string[];
  terminal: boolean;
}

/** The span is corrupt: mark it in the job's chunk map, so the read path reports it as failed. */
async function recordTerminalMarker(jobId: string, chunkIndex: number): Promise<void> {
  const key = \`chunks:\${jobId}\`;
  await r.hset(key, String(chunkIndex), CORRUPT_MARKER);
  await r.expire(key, CHUNK_TTL_S);
}

function collect(stream: grpc.ClientReadableStream<Segment>): Promise<string[]> {
  const segments: string[] = [];
  const {promise, resolve, reject} = Promise.withResolvers<string[]>();
  stream.on('data', (segment: Segment) => segments.push(segment.text));
  stream.on('error', reject);
  stream.on('end', () => resolve(segments));
  return promise;
}

async function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function transcribeChunk(jobId: string, audioRef: string, chunk: Chunk): Promise<ChunkResult> {
  const request: ChunkRequest = {
    job_id: jobId,
    audio_ref: audioRef,
    chunk_index: chunk.index,
    offset_ms: chunk.offset_ms,
    seconds: CHUNK_SECONDS,
  };
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const stream = asr.TranscribeChunk(request, {deadline: Date.now() + DEADLINE_MS});
      return {segments: await collect(stream), terminal: false};
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (serviceError.code === grpc.status.INVALID_ARGUMENT && serviceError.details.includes(CORRUPT_MARKER)) {
        await recordTerminalMarker(jobId, chunk.index);
        return {segments: [], terminal: true};
      }
      lastError = serviceError;
      if (RETRYABLE[serviceError.code] !== true) break;
      if (attempt + 1 < MAX_ATTEMPTS) await sleep(BACKOFF_MS);
    }
  }
  throw new Error(\`chunk \${chunk.index} of \${jobId} failed: \${lastError?.details ?? 'unknown'}\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/redis/go-redis/v9"

	pb "transcribe/asrpb"
)

type Chunk struct {
	Index    int32
	OffsetMs int64
}

// restartFromStart re-runs the whole file from byte zero whenever a chunk fails, so nothing is left
// half-transcribed.
func restartFromStart(
	ctx context.Context,
	client pb.AsrClient,
	rdb *redis.Client,
	jobID, audioRef string,
	chunk Chunk,
) ([]string, error) {
	for {
		stream, err := client.TranscribeChunk(ctx, &pb.ChunkRequest{JobId: jobID, AudioRef: audioRef})
		if err != nil {
			continue
		}
		var segments []string
		var segment *pb.Segment
		for segment, err = stream.Recv(); err == nil; segment, err = stream.Recv() {
			segments = append(segments, segment.Text)
		}
		if errors.Is(err, io.EOF) {
			rdb.Set(ctx, "transcript:"+jobID, strings.Join(segments, " "), 0)
			return segments, nil
		}
	}
}

func transcribeChunk(
	ctx context.Context,
	client pb.AsrClient,
	rdb *redis.Client,
	jobID, audioRef string,
	chunk Chunk,
) ([]string, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	stream, err := client.TranscribeChunk(ctx, &pb.ChunkRequest{JobId: jobID, AudioRef: audioRef})
	if err != nil {
		return restartFromStart(ctx, client, rdb, jobID, audioRef, chunk)
	}
	var segments []string
	var segment *pb.Segment
	for segment, err = stream.Recv(); err == nil; segment, err = stream.Recv() {
		segments = append(segments, segment.Text)
	}
	if !errors.Is(err, io.EOF) {
		return restartFromStart(ctx, client, rdb, jobID, audioRef, chunk)
	}
	return segments, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "transcribe/asrpb"
)

const (
	deadlineMs    = 60000
	maxAttempts   = 2
	backoffMs     = 250
	chunkSeconds  = 30
	chunkTTL      = 24 * time.Hour
	corruptMarker = "corrupt"
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type Chunk struct {
	Index    int32
	OffsetMs int64
}

// ChunkResult is one chunk's segments, and whether the span is finished for good.
type ChunkResult struct {
	Segments []string
	Terminal bool
}

// recordTerminalMarker marks the span corrupt in the job's chunk map, so the read path reports the
// chunk as failed and no worker spends another attempt on it.
func recordTerminalMarker(ctx context.Context, rdb *redis.Client, jobID string, chunkIndex int32) error {
	key := fmt.Sprintf("chunks:%s", jobID)
	if err := rdb.HSet(ctx, key, chunkIndex, corruptMarker).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, key, chunkTTL).Err()
}

func transcribeChunk(
	parent context.Context,
	client pb.AsrClient,
	rdb *redis.Client,
	jobID, audioRef string,
	chunk Chunk,
) (ChunkResult, error) {
	request := &pb.ChunkRequest{
		JobId:      jobID,
		AudioRef:   audioRef,
		ChunkIndex: chunk.Index,
		OffsetMs:   chunk.OffsetMs,
		Seconds:    chunkSeconds,
	}
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(parent, deadlineMs*time.Millisecond)
		stream, err := client.TranscribeChunk(callCtx, request)
		var segments []string
		if err == nil {
			var segment *pb.Segment
			for segment, err = stream.Recv(); err == nil; segment, err = stream.Recv() {
				segments = append(segments, segment.Text)
			}
			if errors.Is(err, io.EOF) {
				cancel()
				return ChunkResult{Segments: segments, Terminal: false}, nil
			}
		}
		cancel()
		st, _ := status.FromError(err)
		if st.Code() == codes.InvalidArgument && strings.Contains(st.Message(), corruptMarker) {
			_ = recordTerminalMarker(context.Background(), rdb, jobID, chunk.Index)
			return ChunkResult{Terminal: true}, nil
		}
		lastErr = err
		if !retryable[st.Code()] {
			break
		}
		if attempt+1 < maxAttempts {
			time.Sleep(backoffMs * time.Millisecond)
		}
	}
	return ChunkResult{}, fmt.Errorf("chunk %d of %s failed: %w", chunk.Index, jobID, lastErr)
}
`,
    },
    scala: {
      starter: `import scala.util.{Failure, Success, Try}

import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.Jedis

final case class Chunk(index: Int, offsetMs: Long)

object AsrClient {
  val jedis = new Jedis("redis", 6379)
  val asr = AsrGrpc.blockingStub(ManagedChannelBuilder.forAddress("asr", 9000).usePlaintext().build())

  // restartFromStart re-runs the whole file from byte zero whenever a chunk fails, so nothing is
  // left half-transcribed.
  def restartFromStart(jobId: String, audioRef: String, chunk: Chunk): List[String] = {
    while (true) {
      Try(asr.transcribeChunk(ChunkRequest(jobId, audioRef))) match {
        case Success(reply) =>
          val segments = reply.segments.map(_.text).toList
          jedis.set(s"transcript:$jobId", segments.mkString)
          return segments
        case Failure(_) => ()
      }
    }
    Nil
  }

  def transcribeChunk(jobId: String, audioRef: String, chunk: Chunk): List[String] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    Try(asr.transcribeChunk(ChunkRequest(jobId, audioRef))) match {
      case Success(reply) => reply.segments.map(_.text).toList
      case Failure(_) => restartFromStart(jobId, audioRef, chunk)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.{Failure, Success, Try}

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.Jedis

final case class Chunk(index: Int, offsetMs: Long)

final case class ChunkResult(segments: List[String], terminal: Boolean)

object AsrClient {
  val DeadlineMs = 60000L
  val MaxAttempts = 2
  val BackoffMs = 250L
  val ChunkSeconds = 30
  val ChunkTtlSeconds = 24 * 3600
  val CorruptMarker = "corrupt"
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val jedis = new Jedis("redis", 6379)
  val asr = AsrGrpc.blockingStub(ManagedChannelBuilder.forAddress("asr", 9000).usePlaintext().build())

  // recordTerminalMarker marks the span corrupt in the job's chunk map, so the read path reports the
  // chunk as failed and no worker spends another attempt on it.
  def recordTerminalMarker(jobId: String, chunkIndex: Int): Unit = {
    val key = s"chunks:$jobId"
    jedis.hset(key, chunkIndex.toString, CorruptMarker)
    jedis.expire(key, ChunkTtlSeconds)
  }

  def transcribeChunk(jobId: String, audioRef: String, chunk: Chunk): ChunkResult = {
    val request = ChunkRequest(
      jobId = jobId,
      audioRef = audioRef,
      chunkIndex = chunk.index,
      offsetMs = chunk.offsetMs,
      seconds = ChunkSeconds,
    )
    var attempt = 0
    var lastError: Option[StatusRuntimeException] = None
    while (attempt < MaxAttempts) {
      Try(asr.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).transcribeChunk(request)) match {
        case Success(reply) => return ChunkResult(reply.segments.map(_.text).toList, terminal = false)
        case Failure(error: StatusRuntimeException)
            if error.getStatus.getCode == Status.Code.INVALID_ARGUMENT &&
              Option(error.getStatus.getDescription).exists(_.contains(CorruptMarker)) =>
          recordTerminalMarker(jobId, chunk.index)
          return ChunkResult(Nil, terminal = true)
        case Failure(error: StatusRuntimeException) =>
          lastError = Some(error)
          if (!Retryable.contains(error.getStatus.getCode)) attempt = MaxAttempts
          else {
            attempt += 1
            if (attempt < MaxAttempts) Thread.sleep(BackoffMs)
          }
      }
    }
    val index = chunk.index
    throw lastError.getOrElse(new RuntimeException(s"chunk $index of $jobId failed"))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include "asr.grpc.pb.h"

#include <string>
#include <vector>

struct Chunk {
  int index = 0;
  long long offset_ms = 0;
};

// restart_from_start re-runs the whole file from byte zero whenever a chunk fails, so nothing is
// left half-transcribed.
std::vector<std::string> restart_from_start(
    Asr::Stub& stub,
    sw::redis::Redis& redis,
    const std::string& job_id,
    const std::string& audio_ref) {
  while (true) {
    grpc::ClientContext ctx;
    ChunkRequest request;
    request.set_job_id(job_id);
    request.set_audio_ref(audio_ref);
    auto reader = stub.TranscribeChunk(&ctx, request);
    Segment segment;
    std::vector<std::string> segments;
    while (reader->Read(&segment)) segments.push_back(segment.text());
    if (reader->Finish().ok()) {
      redis.set("transcript:" + job_id, segments.empty() ? std::string() : segments.front());
      return segments;
    }
  }
}

std::vector<std::string> transcribe_chunk(
    Asr::Stub& stub,
    sw::redis::Redis& redis,
    const std::string& job_id,
    const std::string& audio_ref,
    const Chunk& chunk) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  grpc::ClientContext ctx;
  ChunkRequest request;
  request.set_job_id(job_id);
  request.set_audio_ref(audio_ref);
  auto reader = stub.TranscribeChunk(&ctx, request);
  Segment segment;
  std::vector<std::string> segments;
  while (reader->Read(&segment)) segments.push_back(segment.text());
  if (reader->Finish().ok()) return segments;
  return restart_from_start(stub, redis, job_id, audio_ref);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include "asr.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

constexpr long long kDeadlineMs = 60000;
constexpr int kMaxAttempts = 2;
constexpr int kBackoffMs = 250;
constexpr int kChunkSeconds = 30;
constexpr int kChunkTtlSeconds = 24 * 3600;
const std::string kCorruptMarker = "corrupt";

struct Chunk {
  int index = 0;
  long long offset_ms = 0;
};

// ChunkResult is one chunk's segments, and whether the span is finished for good.
struct ChunkResult {
  std::vector<std::string> segments;
  bool terminal = false;
};

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// record_terminal_marker marks the span corrupt in the job's chunk map, so the read path reports the
// chunk as failed and no worker spends another attempt on it.
void record_terminal_marker(sw::redis::Redis& redis, const std::string& job_id, int chunk_index) {
  const auto key = "chunks:" + job_id;
  redis.hset(key, std::to_string(chunk_index), kCorruptMarker);
  redis.expire(key, std::chrono::seconds(kChunkTtlSeconds));
}

ChunkResult transcribe_chunk(
    Asr::Stub& stub,
    sw::redis::Redis& redis,
    const std::string& job_id,
    const std::string& audio_ref,
    const Chunk& chunk) {
  ChunkRequest request;
  request.set_job_id(job_id);
  request.set_audio_ref(audio_ref);
  request.set_chunk_index(chunk.index);
  request.set_offset_ms(chunk.offset_ms);
  request.set_seconds(kChunkSeconds);
  std::string last_error = "unknown";
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    auto reader = stub.TranscribeChunk(&ctx, request);
    Segment segment;
    std::vector<std::string> segments;
    while (reader->Read(&segment)) segments.push_back(segment.text());
    const grpc::Status status = reader->Finish();
    if (status.ok()) return {segments, false};
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT &&
        status.error_message().find(kCorruptMarker) != std::string::npos) {
      record_terminal_marker(redis, job_id, chunk.index);
      ChunkResult result;
      result.terminal = true;
      return result;
    }
    last_error = status.error_message();
    if (!retryable(status.error_code())) break;
    if (attempt + 1 < kMaxAttempts) std::this_thread::sleep_for(std::chrono::milliseconds(kBackoffMs));
  }
  throw std::runtime_error("chunk " + std::to_string(chunk.index) + " of " + job_id + " failed: " + last_error);
}
`,
    },
  },
  debrief: `A retry re-runs a unit, and the fix's shape follows from choosing the chunk as that unit. A request that carries its own \`chunk_index\` and \`offset_ms\` makes a retry cost one chunk call, so the bill grows with failures instead of with file length. Two attempts under a 60-second deadline bound the worst case to two minutes of provider time per span. The terminal branch separates "not now" (a deadline, \`UNAVAILABLE\`) from "not ever" (\`INVALID_ARGUMENT\` with the corrupt marker), and recording that marker is what lets the read path report the span as failed instead of assembling a transcript with a hole. Production clients also add jittered backoff and a per-job cost metric, so re-billing shows on a dashboard before an invoice.`,
};
