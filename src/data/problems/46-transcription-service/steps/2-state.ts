import type {Step} from '@/lib/types';

export const transcriptionStateStep: Step = {
  id: 'state',
  title: 'Redis chunk progress with atomic dedupe',
  concept: 'redis',
  file: 'state',
  focus: ['worker', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it records finished chunks in
Redis and the demo shows progress. Two workers that receive the same redelivered chunk both
transcribe it, a failed chunk is marked done anyway, and the set it writes to never expires. Find
the flaws, fix them, and prove the fix.

The chunk worker records per-chunk progress for a 30-second-chunk job:

- The progress key is **per job**: \`progress:{job_id}:chunks\`, a Redis set whose members are chunk
  indices. The draft writes every job into one \`progress:chunks\` set, so chunk 7 of one job blocks
  chunk 7 of every other job and no single job's progress is countable.
- The claim is **one atomic operation and it runs before the ASR call**: a Lua \`EVAL\` that does
  \`SISMEMBER\` + \`SADD\` and returns 1 only to the delivery that won. The draft checks on the
  client, calls the provider, then \`SADD\`s — a redelivered chunk passes the check in both workers
  and the provider bills twice.
- A failed chunk is **not** progress: when the provider call throws, release the claim (\`SREM\`) so
  a retry can transcribe the chunk. The draft catches the failure and marks the chunk done anyway.
- When the job completes — the set holds the expected chunk count — set an \`EXPIRE\` of **86 400**
  seconds on the progress key. The draft sets no TTL, so finished jobs pin memory forever.
- Report the completed chunk count (\`SCARD\`) with the result.

**Failure mode the checks target.** At-least-once delivery guarantees the same chunk arrives twice,
and a client-side check-then-act window turns that into two provider calls and two invoices. The
second failure is quieter: without a TTL a finished job's progress set is memory the service never
gets back, and a failed chunk that was marked done makes the job look more complete than it is.`,
  sequence: {
    participants: ['Chunk worker', 'Redis', 'ASR provider'],
    messages: [
      {
        from: 'Chunk worker',
        to: 'Redis',
        label: 'EVAL claim progress:{job}:chunks · SISMEMBER+SADD chunk 7',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Chunk worker', label: '1 claimed · 0 → another delivery owns it, skip', kind: 'reply'},
      {
        from: 'Chunk worker',
        to: 'ASR provider',
        label: 'TranscribeChunk(job, 7) · only the claimer calls',
        kind: 'sync',
      },
      {from: 'ASR provider', to: 'Chunk worker', label: 'segment text / error', kind: 'reply'},
      {from: 'Chunk worker', to: 'Redis', label: 'error → SREM release · success → SCARD', kind: 'sync'},
      {
        from: 'Chunk worker',
        to: 'Redis',
        label: 'SCARD == expected → EXPIRE progress:{job}:chunks 86400',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'chunk-key',
      title: 'Scopes the progress set to the job',
      detail:
        'The progress key is `progress:{job_id}:chunks`, one set per job whose members are chunk indices. The draft writes every job into one `progress:chunks` set, so chunk 7 of one job blocks chunk 7 of another.',
      match: {
        python: {all: [/progress:\{job_id\}:chunks/]},
        typescript: {all: [/progress:\$\{jobId\}:chunks/]},
        go: {all: [/progress:%s:chunks/]},
        scala: {all: [/progress:\$jobId:chunks/]},
        cpp: {all: [/progress:"\s*\+\s*jobId\s*\+\s*":chunks"/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Claims the chunk in one atomic step before the provider call',
      detail:
        'One Lua `EVAL` does `SISMEMBER` + `SADD` and runs before the ASR call, so of two concurrent deliveries of one chunk exactly one transcribes. The draft checks on the client, transcribes, then adds — both deliveries pass the check and both bill.',
      match: {
        python: {all: [/CLAIM_LUA/, /SISMEMBER/, /SADD/, /\.eval\(/], order: [/\.eval\(/, /asr\.transcribe\(/]},
        typescript: {all: [/CLAIM_LUA/, /SISMEMBER/, /SADD/, /\.eval\(/], order: [/\.eval\(/, /asr\.transcribe\(/]},
        go: {all: [/claimScript/, /SISMEMBER/, /SADD/, /\.Run\(/], order: [/claimScript\.Run\(/, /asr\.Transcribe\(/]},
        scala: {all: [/ClaimLua/, /SISMEMBER/, /SADD/, /\.eval\(/], order: [/\.eval\(/, /asr\.transcribe\(/]},
        cpp: {all: [/kClaimLua/, /SISMEMBER/, /SADD/, /\.eval</], order: [/\.eval</, /asr->Transcribe\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expires the progress key 24 hours after completion',
      detail:
        'Once the set holds every expected chunk the completion script sets `EXPIRE` to 86400 seconds on the progress key, so finished jobs free themselves. The draft never sets a TTL, so progress keys pin memory forever.',
      match: {
        python: {all: [/EXPIRE/, /86400|86_400/]},
        typescript: {all: [/EXPIRE/, /86400|86_400/]},
        go: {all: [/EXPIRE/, /86400|86_400/]},
        scala: {all: [/EXPIRE/, /86400|86_400/]},
        cpp: {all: [/EXPIRE/, /86400|86_400/]},
      },
    },
    {
      id: 'mark-on-success',
      title: 'A failed chunk is not recorded as complete',
      detail:
        'When the provider call throws, the claim is released (`SREM`) so the chunk can be retried and never counts as progress. The draft catches the failure and marks the chunk done anyway.',
      match: {
        python: {all: [/SREM/], order: [/asr\.transcribe\(/, /release_chunk\(/]},
        typescript: {all: [/SREM/], order: [/asr\.transcribe\(/, /eval\(RELEASE_LUA/]},
        go: {all: [/SREM/], order: [/asr\.Transcribe\(/, /releaseChunk\(/]},
        scala: {all: [/SREM/], order: [/asr\.transcribe\(/, /releaseChunk\(/]},
        cpp: {all: [/SREM/], order: [/asr->Transcribe\(/, /releaseChunk\(/]},
      },
    },
    {
      id: 'completed-count',
      title: 'Reports the completed chunk count',
      detail:
        'The completion script returns `SCARD` and the result carries it as `completed`. The draft computes no count, so nothing can tell how much of a job is done.',
      match: {
        python: {all: [/SCARD/, /"completed":\s*completed/]},
        typescript: {all: [/SCARD/, /completed:\s*completed/]},
        go: {all: [/SCARD/, /"completed":/]},
        scala: {all: [/SCARD/, /"completed"/]},
        cpp: {all: [/SCARD/, /"completed"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class ChunkWork(BaseModel):
    audio_uri: str
    start_s: float
    end_s: float
    total_chunks: int


@app.post("/v1/transcriptions/{job_id}/chunks/{index}")
def process_chunk(job_id: str, index: int, work: ChunkWork) -> dict:
    # TODO: the check and the add are two separate commands around the provider call, the key
    # forgets the job id, a failed chunk is still marked done and nothing ever expires.
    key = "progress:chunks"
    if r.sismember(key, index):
        return {"job_id": job_id, "chunk": index, "transcribed": False}
    try:
        text = asr.transcribe(work.audio_uri, work.start_s, work.end_s)
    except Exception:
        text = ""
    r.sadd(key, index)
    return {"job_id": job_id, "chunk": index, "transcribed": True, "text": text}
`,
      solution: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

CHUNK_TTL_S = 86_400

CLAIM_LUA = """
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  return 0
end
redis.call('SADD', KEYS[1], ARGV[1])
return 1
"""

RELEASE_LUA = """
redis.call('SREM', KEYS[1], ARGV[1])
return 1
"""

COMPLETE_LUA = """
local done = redis.call('SCARD', KEYS[1])
if done >= tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return done
"""


class ChunkWork(BaseModel):
    audio_uri: str
    start_s: float
    end_s: float
    total_chunks: int


def progress_key(job_id: str) -> str:
    return f"progress:{job_id}:chunks"


def claim_chunk(key: str, index: int) -> bool:
    """SISMEMBER + SADD in one script: of two concurrent deliveries exactly one wins."""
    return bool(r.eval(CLAIM_LUA, 1, key, index))


def release_chunk(key: str, index: int) -> None:
    """A failed chunk is not progress: hand the claim back so a retry can take it."""
    r.eval(RELEASE_LUA, 1, key, index)


def complete_chunk(key: str, total_chunks: int) -> int:
    """Count what is done, and start the 24 h TTL once the set holds every chunk."""
    return int(r.eval(COMPLETE_LUA, 1, key, total_chunks, CHUNK_TTL_S))


@app.post("/v1/transcriptions/{job_id}/chunks/{index}")
def process_chunk(job_id: str, index: int, work: ChunkWork) -> dict:
    key = progress_key(job_id)
    if not claim_chunk(key, index):
        # Another delivery owns this chunk: no second provider call and no second invoice.
        return {"job_id": job_id, "chunk": index, "transcribed": False, "completed": int(r.scard(key))}
    try:
        text = asr.transcribe(work.audio_uri, work.start_s, work.end_s)
    except Exception:
        release_chunk(key, index)
        raise
    completed = complete_chunk(key, work.total_chunks)
    return {"job_id": job_id, "chunk": index, "transcribed": True, "text": text, "completed": completed}
`,
    },
    typescript: {
      starter: `/** POST /v1/transcriptions/:jobId/chunks/:index: a model-generated draft around one chunk. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface ChunkWork {
  audio_uri: string;
  start_s: number;
  end_s: number;
  total_chunks: number;
}

app.post('/v1/transcriptions/:jobId/chunks/:index', async (request, reply) => {
  const {jobId, index} = request.params as {jobId: string; index: string};
  const work = request.body as ChunkWork;
  // TODO: the check and the add are two separate commands around the provider call, the key
  // forgets the job id, a failed chunk is still marked done and nothing ever expires.
  const key = 'progress:chunks';
  if (await r.sismember(key, index)) {
    return reply.send({job_id: jobId, chunk: Number(index), transcribed: false});
  }
  let text = '';
  try {
    text = await asr.transcribe(work.audio_uri, work.start_s, work.end_s);
  } catch {
    text = '';
  }
  await r.sadd(key, index);
  return reply.send({job_id: jobId, chunk: Number(index), transcribed: true, text});
});
`,
      solution: `/** POST /v1/transcriptions/:jobId/chunks/:index: claim atomically, count on success. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const CHUNK_TTL_S = 86_400;

const CLAIM_LUA = \`
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  return 0
end
redis.call('SADD', KEYS[1], ARGV[1])
return 1
\`;

const RELEASE_LUA = \`
redis.call('SREM', KEYS[1], ARGV[1])
return 1
\`;

const COMPLETE_LUA = \`
local done = redis.call('SCARD', KEYS[1])
if done >= tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return done
\`;

interface ChunkWork {
  audio_uri: string;
  start_s: number;
  end_s: number;
  total_chunks: number;
}

app.post('/v1/transcriptions/:jobId/chunks/:index', async (request, reply) => {
  const {jobId, index} = request.params as {jobId: string; index: string};
  const work = request.body as ChunkWork;
  const key = \`progress:\${jobId}:chunks\`;
  // SISMEMBER + SADD in one script, before the provider call: of two concurrent deliveries of
  // one chunk exactly one wins, and the loser never reaches the ASR provider.
  if (Number(await r.eval(CLAIM_LUA, 1, key, index)) !== 1) {
    return reply.send({
      job_id: jobId,
      chunk: Number(index),
      transcribed: false,
      completed: await r.scard(key),
    });
  }
  let text: string;
  try {
    text = await asr.transcribe(work.audio_uri, work.start_s, work.end_s);
  } catch (error) {
    // A failed chunk is not progress: release the claim so a retry can take the chunk.
    await r.eval(RELEASE_LUA, 1, key, index);
    throw error;
  }
  const completed = Number(
    await r.eval(COMPLETE_LUA, 1, key, String(work.total_chunks), String(CHUNK_TTL_S)),
  );
  return reply.send({
    job_id: jobId,
    chunk: Number(index),
    transcribed: true,
    text,
    completed: completed,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

type chunkWork struct {
	AudioURI    string  \`json:"audio_uri"\`
	StartS      float64 \`json:"start_s"\`
	EndS        float64 \`json:"end_s"\`
	TotalChunks int     \`json:"total_chunks"\`
}

var rdb *redis.Client

func processChunk(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	jobID := r.PathValue("jobId")
	index, _ := strconv.Atoi(r.PathValue("index"))
	var work chunkWork
	_ = json.NewDecoder(r.Body).Decode(&work)
	// TODO: the check and the add are two separate commands around the provider call, the key
	// forgets the job id, a failed chunk is still marked done and nothing ever expires.
	key := "progress:chunks"
	if rdb.SIsMember(ctx, key, index).Val() {
		_ = json.NewEncoder(rw).Encode(map[string]any{"job_id": jobID, "chunk": index, "transcribed": false})
		return
	}
	text, err := asr.Transcribe(ctx, work.AudioURI, work.StartS, work.EndS)
	if err != nil {
		text = ""
	}
	_ = rdb.SAdd(ctx, key, index).Err()
	_ = json.NewEncoder(rw).Encode(map[string]any{"job_id": jobID, "chunk": index, "transcribed": true, "text": text})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/transcriptions/{jobId}/chunks/{index}", processChunk)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const chunkTTLSeconds = 86400

var (
	rdb          *redis.Client
	claimScript  = redis.NewScript(\`
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  return 0
end
redis.call('SADD', KEYS[1], ARGV[1])
return 1
\`)
	releaseScript = redis.NewScript(\`
redis.call('SREM', KEYS[1], ARGV[1])
return 1
\`)
	completeScript = redis.NewScript(\`
local done = redis.call('SCARD', KEYS[1])
if done >= tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return done
\`)
)

type chunkWork struct {
	AudioURI    string  \`json:"audio_uri"\`
	StartS      float64 \`json:"start_s"\`
	EndS        float64 \`json:"end_s"\`
	TotalChunks int     \`json:"total_chunks"\`
}

func progressKey(jobID string) string {
	return fmt.Sprintf("progress:%s:chunks", jobID)
}

func claimChunk(ctx context.Context, key, index string) (bool, error) {
	claimed, err := claimScript.Run(ctx, rdb, []string{key}, index).Int()
	return claimed == 1, err
}

func releaseChunk(ctx context.Context, key, index string) {
	_ = releaseScript.Run(ctx, rdb, []string{key}, index).Err()
}

func completeChunk(ctx context.Context, key string, totalChunks int) (int64, error) {
	return completeScript.Run(ctx, rdb, []string{key}, totalChunks, chunkTTLSeconds).Int64()
}

func processChunk(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	jobID := r.PathValue("jobId")
	index, _ := strconv.Atoi(r.PathValue("index"))
	var work chunkWork
	_ = json.NewDecoder(r.Body).Decode(&work)
	key := progressKey(jobID)
	claimed, err := claimChunk(ctx, key, strconv.Itoa(index))
	if err != nil {
		http.Error(rw, \`{"error":"chunk claim failed"}\`, http.StatusInternalServerError)
		return
	}
	if !claimed {
		// Another delivery owns this chunk: no second provider call and no second invoice.
		_ = json.NewEncoder(rw).Encode(map[string]any{
			"job_id": jobID, "chunk": index, "transcribed": false, "completed": rdb.SCard(ctx, key).Val(),
		})
		return
	}
	text, err := asr.Transcribe(ctx, work.AudioURI, work.StartS, work.EndS)
	if err != nil {
		releaseChunk(ctx, key, strconv.Itoa(index))
		http.Error(rw, \`{"error":"chunk transcription failed"}\`, http.StatusBadGateway)
		return
	}
	completed, _ := completeChunk(ctx, key, work.TotalChunks)
	_ = json.NewEncoder(rw).Encode(map[string]any{
		"job_id": jobID, "chunk": index, "transcribed": true, "text": text, "completed": completed,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/transcriptions/{jobId}/chunks/{index}", processChunk)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object ChunkProgress {
  val jedis = new Jedis("redis", 6379)

  final case class ChunkWork(audioUri: String, startS: Double, endS: Double, totalChunks: Int)

  def processChunk(jobId: String, index: Int, work: ChunkWork, asr: AsrClient): Map[String, Any] = {
    // TODO: the check and the add are two separate commands around the provider call, the key
    // forgets the job id, a failed chunk is still marked done and nothing ever expires.
    val key = "progress:chunks"
    if (jedis.sismember(key, index.toString)) {
      Map("job_id" -> jobId, "chunk" -> index, "transcribed" -> false)
    } else {
      val text =
        try asr.transcribe(work.audioUri, work.startS, work.endS)
        catch { case _: Throwable => "" }
      jedis.sadd(key, index.toString)
      Map("job_id" -> jobId, "chunk" -> index, "transcribed" -> true, "text" -> text)
    }
  }
}
`,
      solution: `import java.util

import redis.clients.jedis.Jedis

object ChunkProgress {
  val ChunkTtlSeconds = 86400L
  val jedis = new Jedis("redis", 6379)

  val ClaimLua: String =
    """if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
      |  return 0
      |end
      |redis.call('SADD', KEYS[1], ARGV[1])
      |return 1""".stripMargin

  val ReleaseLua: String =
    """redis.call('SREM', KEYS[1], ARGV[1])
      |return 1""".stripMargin

  val CompleteLua: String =
    """local done = redis.call('SCARD', KEYS[1])
      |if done >= tonumber(ARGV[1]) then
      |  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
      |end
      |return done""".stripMargin

  final case class ChunkWork(audioUri: String, startS: Double, endS: Double, totalChunks: Int)

  private def evalLong(script: String, key: String, args: List[String]): Long =
    jedis.eval(script, List(key).asJava, args.asJava).asInstanceOf[java.lang.Long].longValue

  def progressKey(jobId: String): String = s"progress:$jobId:chunks"

  def claimChunk(key: String, index: Int): Boolean =
    evalLong(ClaimLua, key, List(index.toString)) == 1L

  def releaseChunk(key: String, index: Int): Unit =
    evalLong(ReleaseLua, key, List(index.toString))

  def completeChunk(key: String, totalChunks: Int): Long =
    evalLong(CompleteLua, key, List(totalChunks.toString, ChunkTtlSeconds.toString))

  def processChunk(jobId: String, index: Int, work: ChunkWork, asr: AsrClient): Map[String, Any] = {
    val key = progressKey(jobId)
    if (!claimChunk(key, index)) {
      // Another delivery owns this chunk: no second provider call and no second invoice.
      Map("job_id" -> jobId, "chunk" -> index, "transcribed" -> false, "completed" -> jedis.scard(key))
    } else {
      val text =
        try asr.transcribe(work.audioUri, work.startS, work.endS)
        catch {
          case error: Throwable =>
            releaseChunk(key, index)
            throw error
        }
      Map(
        "job_id" -> jobId,
        "chunk" -> index,
        "transcribed" -> true,
        "text" -> text,
        "completed" -> completeChunk(key, work.totalChunks),
      )
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/transcriptions/:jobId/chunks/:index", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto jobId = req.path_params.at("jobId");
    const auto index = req.path_params.at("index");
    // TODO: the check and the add are two separate commands around the provider call, the key
    // forgets the job id, a failed chunk is still marked done and nothing ever expires.
    const std::string key = "progress:chunks";
    if (redis.sismember(key, index)) {
      res.set_content(json{{"job_id", jobId}, {"chunk", index}, {"transcribed", false}}.dump(), "application/json");
      return;
    }
    std::string text;
    try {
      text = asr->Transcribe(jobId, std::stoi(index));
    } catch (const std::exception&) {
      text = "";
    }
    redis.sadd(key, index);
    res.set_content(
        json{{"job_id", jobId}, {"chunk", index}, {"transcribed", true}, {"text", text}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kChunkTtlSeconds = 86400;

const std::string kClaimLua = R"(
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  return 0
end
redis.call('SADD', KEYS[1], ARGV[1])
return 1
)";

const std::string kReleaseLua = R"(
redis.call('SREM', KEYS[1], ARGV[1])
return 1
)";

const std::string kCompleteLua = R"(
local done = redis.call('SCARD', KEYS[1])
if done >= tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return done
)";

std::string progressKey(const std::string& jobId) {
  return "progress:" + jobId + ":chunks";
}

bool claimChunk(sw::redis::Redis& redis, const std::string& key, const std::string& index) {
  const std::vector<std::string> keys = {key};
  const std::vector<std::string> args = {index};
  return redis.eval<long long>(kClaimLua, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

void releaseChunk(sw::redis::Redis& redis, const std::string& key, const std::string& index) {
  const std::vector<std::string> keys = {key};
  const std::vector<std::string> args = {index};
  redis.eval<long long>(kReleaseLua, keys.begin(), keys.end(), args.begin(), args.end());
}

long long completeChunk(sw::redis::Redis& redis, const std::string& key, long long totalChunks) {
  const std::vector<std::string> keys = {key};
  const std::vector<std::string> args = {std::to_string(totalChunks), std::to_string(kChunkTtlSeconds)};
  return redis.eval<long long>(kCompleteLua, keys.begin(), keys.end(), args.begin(), args.end());
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/transcriptions/:jobId/chunks/:index", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto jobId = req.path_params.at("jobId");
    const auto index = req.path_params.at("index");
    const auto work = json::parse(req.body);
    const auto key = progressKey(jobId);
    if (!claimChunk(redis, key, index)) {
      res.set_content(
          json{{"job_id", jobId},
               {"chunk", index},
               {"transcribed", false},
               {"completed", redis.scard(key)}}
              .dump(),
          "application/json");
      return;
    }
    std::string text;
    try {
      text = asr->Transcribe(jobId, std::stoi(index));
    } catch (const std::exception&) {
      releaseChunk(redis, key, index);
      res.status = 502;
      res.set_content(json{{"error", "chunk transcription failed"}}.dump(), "application/json");
      return;
    }
    const auto completed = completeChunk(redis, key, work.at("total_chunks").get<long long>());
    res.set_content(
        json{{"job_id", jobId},
             {"chunk", index},
             {"transcribed", true},
             {"text", text},
             {"completed", completed}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Atomicity belongs around the check-and-add, not around the call. Run one Lua `EVAL` that does `SISMEMBER` + `SADD` before the provider call — the delivery that gets `1` transcribes, the delivery that gets `0` returns without calling the ASR provider at all, so a redelivered chunk cannot re-bill.',
    'The key is a scope: `progress:{job_id}:chunks` with the chunk index as the member. One shared `progress:chunks` set lets chunk 7 of one job block chunk 7 of another, and there is no way to count a single job’s progress.',
    'Failure is not progress and memory is not free: `SREM` the claim when the provider call throws so a retry can take the chunk, and set the `EXPIRE` (86400 seconds) the moment `SCARD` reaches the expected chunk count — the TTL belongs to completion, not to every write.',
  ],
  debrief: `The interview question here is the difference between "checked" and "claimed". At-least-once
delivery guarantees the same chunk arrives twice, and a client-side \`SISMEMBER\` followed by the
provider call and a separate \`SADD\` leaves a window wide enough for both deliveries to pass it —
in production that window is billed twice. One Lua \`EVAL\` that does the check-and-add in a single
step, run before the provider call, makes the set itself the claim: the loser returns early without
touching the ASR provider. Two details get missed next. A failed chunk must be released (\`SREM\`)
instead of counted, or the job looks more complete than it is and the chunk is never retried. And
the keys need a lifetime: a finished job's progress set is memory that is never reclaimed unless
completion sets the 24-hour TTL. Real systems add a lease to the claim so a crashed worker's chunk
can be retried, drive progress and alerting from the completed count, and treat the progress key as
a cache — the transcript in the durable store remains the source of truth.`,
};
