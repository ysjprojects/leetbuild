import type {Step} from '@/lib/types';

export const transcriptionDependencyStep: Step = {
  id: 'dependency',
  title: 'ASR streams that resume, never restart',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'asr', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: against a healthy provider it
streams segments back and the demo transcribes. Every failure path is wrong, and two of them bill the
provider for audio you already paid for. Review it, fix it, and prove the fix.

The provider exposes:

\`\`\`proto
service Asr {
  rpc TranscribeChunk(ChunkRequest) returns (stream Segment);
}
message ChunkRequest { string job_id = 1; string audio_ref = 2; uint32 chunk_index = 3; int64 offset_ms = 4; uint32 seconds = 5; }
message Segment      { string text = 1; }
\`\`\`

Implement \`transcribe_chunk(job_id, audio_ref, chunk)\`, the call the chunk worker makes for one
30-second span.

- **One stream per chunk, and the request names that span.** The \`ChunkRequest\` carries the
  \`chunk_index\` and the chunk's own \`offset_ms\` beside the job and the audio reference. The draft
  sends the file reference alone, so the provider cannot tell which minute it is being asked about —
  and every retry is a whole-file job.
- **Every attempt carries a 60-second deadline** (\`timeout=60\`, \`deadline: Date.now() + DEADLINE_MS\`,
  a context with timeout, \`withDeadlineAfter\`, \`set_deadline\`). A minute of audio that has not
  streamed back within a minute is not coming; without the bound, one wedged stream pins the worker
  that owns the rest of the file.
- **At most two attempts per chunk**, and a retry re-sends *this chunk's* request: same
  \`chunk_index\`, same \`offset_ms\`, never a request for the file from byte zero. A flaky minute must
  cost one extra chunk call, not two hours of provider time and a second bill for the whole file.
- **A corrupt-audio rejection is terminal for that span.** \`INVALID_ARGUMENT\` whose details carry the
  \`corrupt\` marker means the bytes themselves are bad, so no attempt can succeed: record the marker
  for that chunk in Redis (\`HSET chunks:{job_id} {index} "corrupt"\`) and return instead of spending
  the second attempt on it. The read path sees that marker as a failed span — which is what makes a
  partial transcript honest.

:::widget grpc-streams {"mode": "server"}

:::widget deadline-retry {"base": 250, "deadline": 60000, "attempts": 2}

**Failure mode the checks target.** All four draft defects are one sentence: the draft has no idea
what a *span* is. It recovers one bad minute by re-running the file, it spends an attempt on bytes
already known to be corrupt, it has no deadline so a stuck stream owns the worker, and its retry has
no bound. None of that shows in the demo — the demo's audio is one perfect minute — and all of it
shows in the bill: a two-hour file that restarts once is two transcriptions, and a corrupt chunk that
retries forever is an unbounded one. Keep the shape: one request built from one chunk, one bounded
loop around it, and one terminal branch for the failure that can never succeed.`,
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
    'Two bounds, both on the call rather than around it: a 60-second deadline per attempt (`timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, a context with timeout, `withDeadlineAfter`, `set_deadline`) and a loop over `MAX_ATTEMPTS = 2`. The draft’s retry has neither, so one bad minute can hold a worker — and a provider — for as long as it likes.',
    'The retry is the *same request*: build `ChunkRequest` once, outside the loop, from the chunk’s own `index` and `offset_ms`, and re-send it. Anything in the retry path that reads the file from its start turns a transient failure into a second bill for audio that was already transcribed.',
    'Read the status code out of the error before the retryable test: `INVALID_ARGUMENT` with the `corrupt` marker in the details is a permanent property of those bytes. Record the marker for that chunk in the job’s chunk map and return — retrying it is the same bill twice, and the missing marker is what lets the read path call a broken transcript `done`.',
  ],
  checks: [
    {
      id: 'per-chunk-stream',
      title: 'One stream per chunk, and the request names the span',
      detail:
        'The `ChunkRequest` carries `chunk_index` and the chunk’s own `offset_ms` beside the job and the audio reference, so the provider streams back exactly that span. The draft sends the file reference alone: the provider cannot tell which minute it is asked about, and the reply is a whole-file job.',
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
        'Each attempt is bounded to 60 s (`timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, a context with timeout, `withDeadlineAfter`, `set_deadline`). The draft calls the provider with no bound at all, so one wedged stream holds the worker that owns the rest of the file.',
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
        'The budget is per chunk — `MAX_ATTEMPTS = 2` and a bounded loop — so a failing span costs two calls and then stops. The draft has no bound at all: a corrupt or permanently rejected span is retried until someone restarts the worker.',
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
        'The corrupt marker is a named constant, and `INVALID_ARGUMENT` carrying it records the marker for that chunk and returns a terminal result right there — it never reaches the retry in the loop. The draft retries the rejection forever, so a span that can never transcribe burns one provider call per iteration and never gets marked.',
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
        'The call in the retry path is bound to the one request built from this chunk, and there is no whole-file path left: `restart_from_start` / `restartFromStart` / `transcribe_file` / a request for `offset_ms = 0` would re-transcribe — and re-bill — every minute of audio that already succeeded. The draft’s recovery *is* that restart.',
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
    # TODO: the draft streams the whole file, restarts it from byte zero when a chunk fails, retries
    # a corrupt-audio rejection forever, and sets neither a deadline nor an attempt bound. Send one
    # request per chunk that names its index and offset, cap the attempts at two under a 60-second
    # deadline, and make a corrupt rejection terminal for this span.
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
      starter: `/** Chunk worker: a model-generated draft that re-runs the whole file whenever a chunk fails. */
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
  // TODO: the draft streams the whole file, restarts it from byte zero when a chunk fails, retries
  // a corrupt-audio rejection forever, and sets neither a deadline nor an attempt bound. Send one
  // request per chunk that names its index and offset, cap the attempts at two under a 60-second
  // deadline, and make a corrupt rejection terminal for this span.
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
	// TODO: the draft streams the whole file, restarts it from byte zero when a chunk fails, retries
	// a corrupt-audio rejection forever, and sets neither a deadline nor an attempt bound. Send one
	// request per chunk that names its index and offset, cap the attempts at two under a 60-second
	// deadline, and make a corrupt rejection terminal for this span.
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
    // TODO: the draft streams the whole file, restarts it from byte zero when a chunk fails, retries
    // a corrupt-audio rejection forever, and sets neither a deadline nor an attempt bound. Send one
    // request per chunk that names its index and offset, cap the attempts at two under a 60-second
    // deadline, and make a corrupt rejection terminal for this span.
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
  // TODO: the draft streams the whole file, restarts it from byte zero when a chunk fails, retries
  // a corrupt-audio rejection forever, and sets neither a deadline nor an attempt bound. Send one
  // request per chunk that names its index and offset, cap the attempts at two under a 60-second
  // deadline, and make a corrupt rejection terminal for this span.
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
  debrief: `The interview question behind this step is one sentence: what does a retry re-run? Every
answer the draft gives is wrong in the same direction, because "retry the transcription" is not a
unit — a chunk is. A per-chunk request that carries its own \`chunk_index\` and \`offset_ms\` is what
makes the retry cheap and the bill linear in failures instead of in file length; without that span
identity, recovery can only mean "start over", which is exactly how one flaky minute re-runs two
hours of audio. The attempt budget belongs to the chunk too: two attempts under a 60-second deadline
bound the worst case to two minutes of provider time, and the deadline also bounds what a retry
storm can do to a provider that is already failing. The subtle half is the terminal branch: a
deadline or an \`UNAVAILABLE\` says *not now*, so another attempt is meaningful, while
\`INVALID_ARGUMENT\` with the corrupt marker says *not ever*, and retrying it is the client arguing
with the format. Recording that marker in the job's chunk map is what keeps a partial transcript
honest — the read path can report the span as failed rather than quietly assembling a transcript
with a hole in it. Real clients add jittered backoff between attempts, per-provider concurrency
limits, a byte-level resume cursor inside a chunk for very long spans, and a cost metric per job so
the re-billing this step prevents shows up on a dashboard before it shows up on an invoice.`,
};
