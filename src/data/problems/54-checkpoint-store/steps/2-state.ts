import type {Step} from '@/lib/types';

export const uploadStateStep: Step = {
  id: 'state',
  title: 'Redis upload state with expiry and commit marker',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it counts chunks, flips a
\`committed\` flag and answers \`200\`, so the demo commits. It hides a race, a leak and a wrong source
of truth. Find them, fix them, and prove the fix with the checks below.

Implement the upload state used by every chunk write:

- The received chunk indexes are a **Redis set** — \`upload:{upload_id}\` — so membership is a
  question about *which* chunks arrived, not how many writes happened. A plain counter cannot tell a
  complete set from a duplicate.
- The state key is created with a **TTL** (\`EXPIRE\`, 24 h on first write) and every write refreshes
  it, so an abandoned upload stops pinning memory and its id can be reused. The draft leaves state
  without a TTL forever.
- The **commit marker** — \`committed:{upload_id}\`, the only key a reader checks — is written by one
  **atomic \`EVAL\`**: the script compares \`SCARD\` of the received set against the expected chunk
  count and writes the marker only when the set is complete. The draft sets the marker when the byte
  count derived from caller-supplied metadata reaches the declared size, so an upload missing its
  last chunk commits.
- The marker carries the step number and the chunk-set digest, gets a longer TTL (30 days) than the
  transient state, and the state key is deleted once the marker exists, so a reader can never
  observe a partially committed checkpoint as complete.
- The draft's commit is a client-side read-then-write (\`INCRBY\` then \`SET\`): two workers on the last
  two chunks can both see "complete" and both write a marker, or neither can.

**Failure mode the checks target.** A count is not a set: redelivered chunks inflate it and lost
chunks never show up, so the marker lies in both directions. A marker derived from a declared size
commits an incomplete upload — the exact state a resume trusts. And a state key without a TTL turns
every abandoned upload into permanent memory.`,
  sequence: {
    participants: ['Checkpoint API', 'Redis', 'Reader'],
    messages: [
      {from: 'Checkpoint API', to: 'Redis', label: 'SADD upload:{upload_id} index', kind: 'sync'},
      {from: 'Checkpoint API', to: 'Redis', label: 'EXPIRE upload:{upload_id} 86400', kind: 'async'},
      {from: 'Checkpoint API', to: 'Redis', label: 'EVAL COMMIT_LUA · SCARD · expected', kind: 'sync'},
      {from: 'Redis', to: 'Checkpoint API', label: '1 committed / 0 incomplete', kind: 'reply'},
      {from: 'Reader', to: 'Redis', label: 'EXISTS committed:{upload_id}', kind: 'sync'},
      {from: 'Redis', to: 'Reader', label: '0 — a partial upload is invisible', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'received-set',
      title: 'Tracks received chunks as a set, not a counter',
      detail:
        'The received indexes live in a Redis set (`SADD` on write, `SCARD` for the count) under a key scoped to the upload. The draft increments a counter, so a redelivered chunk counts twice and a lost chunk is invisible.',
      match: {
        python: {all: [/sadd\(/, /scard\(/], none: [/incrby\(/]},
        typescript: {all: [/\.sadd\(/, /\.scard\(/], none: [/\.incrby\(/]},
        go: {all: [/SAdd\(/, /SCard\(/], none: [/IncrBy\(/]},
        scala: {all: [/sadd\(/, /scard\(/], none: [/incrby\(/]},
        cpp: {all: [/sadd\(/, /scard\(/], none: [/incrby\(/]},
      },
    },
    {
      id: 'commit-marker',
      title: 'Commits on the full chunk set, never on a declared size',
      detail:
        'The marker `committed:{upload_id}` is written only when the stored chunk set is complete; a caller-declared `total_bytes` is never trusted. The draft derives completeness from that declared size and commits uploads that lost a chunk.',
      match: {
        python: {all: [/committed:/], none: [/total_bytes/]},
        typescript: {all: [/committed:/], none: [/total_bytes/]},
        go: {all: [/committed:/], none: [/totalBytes|total_bytes/]},
        scala: {all: [/committed:/], none: [/totalBytes/]},
        cpp: {all: [/committed:/], none: [/totalBytes|total_bytes/]},
      },
    },
    {
      id: 'commit-atomic',
      title: 'Writes the marker from one atomic script',
      detail:
        'The completeness test and the marker write happen inside one `EVAL`/`Eval` (`COMMIT_LUA`), so no reader can observe the marker half-written and two writers cannot both conclude "complete". The draft does a client-side read, decide, write.',
      match: {
        python: {all: [/\.eval\(/, /COMMIT_LUA/]},
        typescript: {all: [/\.eval\(/, /COMMIT_LUA/]},
        go: {all: [/Eval\(/, /commitLua/]},
        scala: {all: [/\.eval\(/, /CommitLua/]},
        cpp: {all: [/\.eval</, /kCommitLua/]},
      },
    },
    {
      id: 'state-ttl',
      title: 'Expires abandoned upload state',
      detail:
        'The state key gets a TTL (`EXPIRE` with the state TTL) so an abandoned upload frees its memory and its id. The draft leaves the key alive forever, which is how a store leaks one key per aborted run.',
      match: {
        python: {all: [/EXPIRE/, /STATE_TTL_S/]},
        typescript: {all: [/EXPIRE/, /STATE_TTL_S/]},
        go: {all: [/EXPIRE/, /stateTTLSeconds/]},
        scala: {all: [/EXPIRE/, /StateTtlSeconds/]},
        cpp: {all: [/EXPIRE/, /kStateTtlSeconds/]},
      },
    },
    {
      id: 'marker-gate',
      title: 'Readers gate on the marker alone',
      detail:
        'A reader asks whether `committed:{upload_id}` exists — a marker written only by the atomic script — rather than reconstructing completeness from the counters. The draft answers from the received count, which is exactly the state a crash can leave stale.',
      match: {
        python: {all: [/exists\(/, /committed:/]},
        typescript: {all: [/\.exists\(/, /committed:/]},
        go: {all: [/Exists\(/, /committed:/]},
        scala: {all: [/exists\(/, /committed:/]},
        cpp: {all: [/exists\(/, /committed:/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class ChunkState(BaseModel):
    index: int
    total_bytes: int
    expected_bytes: int
    step: int


@app.post("/v1/uploads/{upload_id}/chunks")
def record_chunk(upload_id: str, body: ChunkState, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft counts writes instead of tracking which chunks arrived, commits from the
    # caller's declared size, and leaves the upload state alive forever. Track the received indexes
    # in a set with a TTL, and let one atomic script write the commit marker only for a complete
    # chunk set.
    received = r.incrby(f"received:{upload_id}", 1)
    if received * body.total_bytes >= body.expected_bytes:
        r.set(f"committed:{upload_id}", "1")
    return {"upload_id": upload_id, "received": received, "complete": r.get(f"committed:{upload_id}") is not None}
`,
      solution: `import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

STATE_TTL_S = 24 * 3600
COMMIT_TTL_S = 30 * 24 * 3600

COMMIT_LUA = """
local received = redis.call('SCARD', KEYS[1])
local expected = tonumber(ARGV[1])
if received < expected then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('DEL', KEYS[1])
return 1
"""


class ChunkState(BaseModel):
    index: int
    expected_chunks: int
    step: int
    digest: str


def state_key(upload_id: str) -> str:
    return f"upload:{upload_id}"


def marker_key(upload_id: str) -> str:
    """The only key a reader checks: it exists only for a complete chunk set."""
    return f"committed:{upload_id}"


@app.post("/v1/uploads/{upload_id}/chunks")
def record_chunk(upload_id: str, body: ChunkState, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    key = state_key(upload_id)
    r.sadd(key, body.index)
    r.expire(key, STATE_TTL_S)
    received = r.scard(key)
    committed = r.eval(
        COMMIT_LUA,
        2,
        key,
        marker_key(upload_id),
        body.expected_chunks,
        f"{body.step}:{body.digest}",
        COMMIT_TTL_S,
    )
    return {"upload_id": upload_id, "received": received, "complete": int(committed) == 1}


@app.get("/v1/uploads/{upload_id}/state")
def upload_state(upload_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    return {"upload_id": upload_id, "committed": bool(r.exists(marker_key(upload_id)))}
`,
    },
    typescript: {
      starter: `/** Upload state: a model-generated draft that commits from the caller's declared size. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface ChunkState {
  index: number;
  total_bytes: number;
  expected_bytes: number;
  step: number;
}

app.post('/v1/uploads/:uploadId/chunks', async (request, reply) => {
  // TODO: this draft counts writes instead of tracking which chunks arrived, commits from the
  // caller's declared size, and leaves the upload state alive forever. Track the received indexes
  // in a set with a TTL, and let one atomic script write the commit marker only for a complete
  // chunk set.
  const tenant = request.headers['x-tenant-id'] as string;
  const {uploadId} = request.params as {uploadId: string};
  const body = request.body as ChunkState;
  const received = await r.incrby(\`received:\${uploadId}\`, 1);
  if (received * body.total_bytes >= body.expected_bytes) await r.set(\`committed:\${uploadId}\`, '1');
  return reply.code(200).send({upload_id: uploadId, received, complete: (await r.get(\`committed:\${uploadId}\`)) !== null});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Upload state: the commit marker is written by one atomic script over the received chunk set. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const STATE_TTL_S = 24 * 3600;
const COMMIT_TTL_S = 30 * 24 * 3600;

const COMMIT_LUA = \`
local received = redis.call('SCARD', KEYS[1])
local expected = tonumber(ARGV[1])
if received < expected then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('DEL', KEYS[1])
return 1
\`;

interface ChunkState {
  index: number;
  expected_chunks: number;
  step: number;
  digest: string;
}

app.post('/v1/uploads/:uploadId/chunks', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {uploadId} = request.params as {uploadId: string};
  const body = request.body as ChunkState;
  const key = \`upload:\${uploadId}\`;
  const marker = \`committed:\${uploadId}\`;

  await r.sadd(key, String(body.index));
  await r.expire(key, STATE_TTL_S);
  const received = await r.scard(key);
  const committed = await r.eval(
    COMMIT_LUA,
    2,
    key,
    marker,
    String(body.expected_chunks),
    \`\${body.step}:\${body.digest}\`,
    String(COMMIT_TTL_S),
  );
  return reply.code(200).send({upload_id: uploadId, received, complete: Number(committed) === 1});
});

app.get('/v1/uploads/:uploadId/state', async (request, reply) => {
  const {uploadId} = request.params as {uploadId: string};
  return reply.code(200).send({upload_id: uploadId, committed: (await r.exists(\`committed:\${uploadId}\`)) === 1});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type chunkState struct {
	Index         int   \`json:"index"\`
	TotalBytes    int64 \`json:"total_bytes"\`
	ExpectedBytes int64 \`json:"expected_bytes"\`
	Step          int   \`json:"step"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func recordChunk(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	uploadID := r.PathValue("uploadId")
	var body chunkState
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft counts writes instead of tracking which chunks arrived, commits from the
	// caller's declared size, and leaves the upload state alive forever. Track the received indexes
	// in a set with a TTL, and let one atomic script write the commit marker only for a complete
	// chunk set.
	received, _ := rdb.IncrBy(r.Context(), "received:"+uploadID, 1).Result()
	if received*body.TotalBytes >= body.ExpectedBytes {
		rdb.Set(r.Context(), "committed:"+uploadID, "1", 0)
	}
	stored, _ := rdb.Get(r.Context(), "committed:"+uploadID).Result()
	writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "received": received, "complete": stored != ""})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/uploads/{uploadId}/chunks", recordChunk)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	stateTTLSeconds  = 24 * 3600
	commitTTLSeconds = 30 * 24 * 3600
)

var commitLua = \`
local received = redis.call('SCARD', KEYS[1])
local expected = tonumber(ARGV[1])
if received < expected then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('DEL', KEYS[1])
return 1
\`

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type chunkState struct {
	Index          int    \`json:"index"\`
	ExpectedChunks int64  \`json:"expected_chunks"\`
	Step           int    \`json:"step"\`
	Digest         string \`json:"digest"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func recordChunk(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	uploadID := r.PathValue("uploadId")
	var body chunkState
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	ctx := r.Context()
	key := fmt.Sprintf("upload:%s", uploadID)
	// The marker is the only key a reader checks: it exists only for a complete chunk set.
	marker := fmt.Sprintf("committed:%s", uploadID)

	if err := rdb.SAdd(ctx, key, body.Index).Err(); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "state unavailable"})
		return
	}
	rdb.Expire(ctx, key, time.Duration(stateTTLSeconds)*time.Second)
	received, err := rdb.SCard(ctx, key).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "state unavailable"})
		return
	}
	committed, err := rdb.Eval(ctx, commitLua, []string{key, marker},
		body.ExpectedChunks, fmt.Sprintf("%d:%s", body.Step, body.Digest), commitTTLSeconds).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "commit unavailable"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "received": received, "complete": committed == int64(1)})
}

func uploadState(rw http.ResponseWriter, r *http.Request) {
	uploadID := r.PathValue("uploadId")
	exists, err := rdb.Exists(r.Context(), fmt.Sprintf("committed:%s", uploadID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "state unavailable"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "committed": exists == 1})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/uploads/{uploadId}/chunks", recordChunk)
	mux.HandleFunc("GET /v1/uploads/{uploadId}/state", uploadState)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ChunkState(index: Int, totalBytes: Long, expectedBytes: Long, step: Int)

object State {
  implicit val system: ActorSystem = ActorSystem("checkpoint-store")
  implicit val stateFormat: RootJsonFormat[ChunkState] = jsonFormat4(ChunkState)

  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "uploads" / Segment / "chunks") { uploadId =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ChunkState]) { body =>
            // TODO: this draft counts writes instead of tracking which chunks arrived, commits from
            // the caller's declared size, and leaves the upload state alive forever. Track the
            // received indexes in a set with a TTL, and let one atomic script write the commit
            // marker only for a complete chunk set.
            val received = jedis.incrBy(s"received:$uploadId", 1L)
            if (received * body.totalBytes >= body.expectedBytes) {
              jedis.set(s"committed:$uploadId", "1")
            }
            val committed = jedis.get(s"committed:$uploadId") != null
            complete(StatusCodes.OK, s"""{"upload_id":"$uploadId","received":$received,"complete":$committed}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ChunkState(index: Int, expectedChunks: Long, step: Int, digest: String)

object State {
  implicit val system: ActorSystem = ActorSystem("checkpoint-store")
  implicit val stateFormat: RootJsonFormat[ChunkState] = jsonFormat4(ChunkState)

  val StateTtlSeconds = 24 * 3600
  val CommitTtlSeconds = 30 * 24 * 3600

  val CommitLua: String = """local received = redis.call('SCARD', KEYS[1])
local expected = tonumber(ARGV[1])
if received < expected then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('DEL', KEYS[1])
return 1
"""

  val jedis = new Jedis("redis", 6379)

  // The marker is the only key a reader checks: it exists only for a complete chunk set.
  def markerKey(uploadId: String): String = s"committed:$uploadId"

  val route: Route =
    path("v1" / "uploads" / Segment / "chunks") { uploadId =>
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[ChunkState]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val key = s"upload:$uploadId"
              jedis.sadd(key, body.index.toString)
              jedis.expire(key, StateTtlSeconds)
              val received = jedis.scard(key)
              val committed = jedis.eval(
                CommitLua,
                java.util.List.of(key, markerKey(uploadId)),
                java.util.List.of(
                  body.expectedChunks.toString,
                  s"\${body.step}:\${body.digest}",
                  CommitTtlSeconds.toString
                )
              )
              complete(
                StatusCodes.OK,
                s"""{"upload_id":"$uploadId","received":$received,"complete":\${committed == 1L}}"""
              )
            }
          }
        }
      }
    }

  val stateRoute: Route =
    path("v1" / "uploads" / Segment / "state") { uploadId =>
      get {
        complete(StatusCodes.OK, s"""{"upload_id":"$uploadId","committed":\${jedis.exists(markerKey(uploadId))}}""")
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route ~ stateRoute)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

using json = nlohmann::json;

sw::redis::Redis r("tcp://redis:6379");

std::string pathParam(const std::string& path, const std::string& segment);

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/uploads/([^/]+)/chunks)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto uploadId = pathParam(req.path, "chunks");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft counts writes instead of tracking which chunks arrived, commits from the
    // caller's declared size, and leaves the upload state alive forever. Track the received indexes
    // in a set with a TTL, and let one atomic script write the commit marker only for a complete
    // chunk set.
    const auto received = r.incrby("received:" + uploadId, 1);
    if (received * body.value("total_bytes", 0LL) >= body.value("expected_bytes", 0LL)) {
      r.set("committed:" + uploadId, "1");
    }
    const auto committed = r.get("committed:" + uploadId).has_value();
    res.status = 200;
    res.set_content(
        json{{"upload_id", uploadId}, {"received", received}, {"complete", committed}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr long long kStateTtlSeconds = 24LL * 3600;
constexpr long long kCommitTtlSeconds = 30LL * 24 * 3600;

const std::string kCommitLua = R"LUA(
local received = redis.call('SCARD', KEYS[1])
local expected = tonumber(ARGV[1])
if received < expected then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('DEL', KEYS[1])
return 1
)LUA";

sw::redis::Redis r("tcp://redis:6379");

std::string pathParam(const std::string& path, const std::string& segment);

// The marker is the only key a reader checks: it exists only for a complete chunk set.
std::string markerKey(const std::string& uploadId) { return "committed:" + uploadId; }

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/uploads/([^/]+)/chunks)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto uploadId = pathParam(req.path, "chunks");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto key = "upload:" + uploadId;
    const auto marker = markerKey(uploadId);

    r.sadd(key, std::to_string(body.value("index", -1)));
    r.expire(key, kStateTtlSeconds);
    const long long received = r.scard(key);
    const long long committed = r.eval<long long>(
        kCommitLua, {key, marker},
        {std::to_string(body.value("expected_chunks", 0LL)),
         std::to_string(body.value("step", 0)) + ":" + body.value("digest", std::string()),
         std::to_string(kCommitTtlSeconds)});
    res.status = 200;
    res.set_content(
        json{{"upload_id", uploadId}, {"received", received}, {"complete", committed == 1}}.dump(),
        "application/json");
  });

  svr.Get(R"(/v1/uploads/([^/]+)/state)", [](const httplib::Request& req, httplib::Response& res) {
    const auto uploadId = pathParam(req.path, "state");
    res.status = 200;
    res.set_content(
        json{{"upload_id", uploadId}, {"committed", r.exists(markerKey(uploadId)) == 1}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The state is a question about *which* chunks arrived, so store the indexes in a set: `SADD upload:{upload_id} {index}`, then `SCARD` for the count. A counter cannot distinguish 8 distinct chunks from 6 chunks with two redeliveries, and it is exactly that distinction the commit decision needs.',
    'The marker must be written by the server, in one step, from the set that is actually stored — not from a size the caller declared. Keep the completeness test and the `SET committed:{upload_id}` inside one `EVAL`, so a reader either sees no marker or a marker for a complete upload, never a half-committed checkpoint.',
    'Give the state key an `EXPIRE` on the first write and let the marker carry its own, longer TTL. Abandoned uploads are the normal case in a training platform, and a state key with no TTL is memory that only a manual flush reclaims.',
  ],
  debrief: `The interviewer is testing whether you can tell durable state from bookkeeping. The draft is a counter and a flag, which is what a demo needs; the real contract is "a reader can trust the marker". That forces three decisions: the state must answer *which* chunks arrived (a set, not a count), the marker must be derived from that set on the server (never from the caller's metadata), and both the transient state and the marker need TTLs — short for the upload, long for the committed record. Real stores add a manifest written with the marker, per-chunk digests, a monotonic epoch so two uploads of the same step cannot interleave, and a reaper that removes blobs of uploads whose state expired.`,
};
