import type {Step} from '@/lib/types';

export const checkpointEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/checkpoints: chunked and resumable writes',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, decodes
the chunk and answers \`200\`. It compiles, it serves a single well-behaved uploader, and it hides
three production flaws. Review it like the service owner, fix it, and prove the fix with the checks
below.

Implement \`POST /v1/checkpoints\` with body \`{"index": 0, "data": "…"}\` (\`data\` is base64).

- The tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when missing) and the upload
  id from \`X-Upload-Id\` (**400** when missing). The upload id is the idempotency key for the whole
  upload: a retry of a chunk belongs to the same upload, it never forks a second checkpoint.
- A chunk may hold at most **8 MiB** (\`1 << 23\` bytes) of decoded payload; a larger chunk is
  **413**.
- Chunk indexes are monotonically increasing: a chunk is accepted only at the index that follows the
  chunks already stored for that upload. A chunk that arrives before its predecessor is **409**, not
  a reason to apply it out of order.
- A chunk is stored **at its index** — a hash field per index, never an append — so a redelivered
  chunk overwrites its own position.
- Every chunk is digested with **sha256** and the digest is persisted next to it. A replay of the
  same \`(index, bytes)\` is byte-identical and idempotent: it returns the same state and stores
  nothing new. A replay of the same index with *different* bytes is **409** — a chunk that changes
  under the same index is a corrupt upload, not a retry.
- Completeness is derived from the **stored chunk set** (\`len(stored chunks)\`), never from a
  caller-supplied \`total_bytes\`. An incomplete upload can never be reported as complete.

**Failure mode the checks target.** Applying chunks as they arrive reorders the weights silently —
the resume succeeds and the model is wrong. Appending on a redelivered chunk duplicates a slice of
the checkpoint. And a caller-declared size lets an upload that lost its last chunk claim to be
complete, which is the state a resume trusts most.`,
  sequence: {
    participants: ['Training job', 'Checkpoint API', 'Redis'],
    messages: [
      {from: 'Training job', to: 'Checkpoint API', label: 'POST /v1/checkpoints · X-Upload-Id · index=7', kind: 'sync'},
      {from: 'Checkpoint API', to: 'Redis', label: 'HLEN chunks:{upload_id}', kind: 'sync'},
      {from: 'Redis', to: 'Checkpoint API', label: '7 (chunks stored so far)', kind: 'reply'},
      {from: 'Checkpoint API', to: 'Redis', label: 'HGET digests:{upload_id} 7', kind: 'sync'},
      {from: 'Checkpoint API', to: 'Redis', label: 'HSET chunks:{upload_id} 7 payload', kind: 'async'},
      {from: 'Checkpoint API', to: 'Training job', label: '200 {index, received} · 409 out of order', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'chunk-order',
      title: 'Accepts a chunk only at its expected index',
      detail:
        'The next expected index comes from the chunks already stored for the upload; a chunk before its predecessor is **409**. The draft applies chunks in arrival order, so a redelivered or reordered chunk silently reorders the weights.',
      match: {
        python: {all: [/CHUNK_BYTES/, /status_code\s*=\s*409/]},
        typescript: {all: [/CHUNK_BYTES/, /code\(\s*409\s*\)/]},
        go: {all: [/chunkBytes/, /StatusConflict/]},
        scala: {all: [/ChunkBytes/, /StatusCodes\.Conflict/]},
        cpp: {all: [/kChunkBytes/, /\b409\b/]},
      },
    },
    {
      id: 'chunk-cap',
      title: 'Rejects a chunk over 8 MiB',
      detail:
        'The decoded payload may not exceed `1 << 23` bytes — an over-sized chunk is **413** before anything is stored. The draft has no size cap, so one request can push an unbounded body into the checkpoint.',
      match: {
        python: {all: [/CHUNK_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/CHUNK_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/chunkBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/ChunkBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kChunkBytes/, /\b413\b/]},
      },
    },
    {
      id: 'chunk-position',
      title: 'Stores the chunk at its index instead of appending',
      detail:
        'Chunks live in a hash field per index under `chunks:{upload_id}`, so a replay overwrites its own position. The draft pushes each chunk onto a list, so a redelivered chunk is appended a second time and the chunk count no longer matches the upload.',
      match: {
        python: {all: [/chunks:\{upload_id\}/, /hset\(/], none: [/rpush\(/]},
        typescript: {all: [/chunks:\$\{uploadId\}/, /\.hset\(/], none: [/\.rpush\(/]},
        go: {all: [/chunks:%s/, /HSet\(/], none: [/RPush\(/]},
        scala: {all: [/chunks:\$uploadId/, /hset\(/], none: [/rpush\(/]},
        cpp: {all: [/chunks:/, /hset\(/], none: [/rpush\(/]},
      },
    },
    {
      id: 'chunk-digest',
      title: 'Digests every chunk and keeps the digest with it',
      detail:
        'Each chunk is digested with **sha256** and the digest is persisted under `digests:{upload_id}`, so a replay can be compared byte-for-byte and an index rewritten with different bytes is refused. The draft stores no digest at all.',
      match: {
        python: {all: [/sha256\(/, /digests:\{upload_id\}/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /digests:\$\{uploadId\}/]},
        go: {all: [/sha256\.Sum256/, /digests:%s/]},
        scala: {all: [/getInstance\("SHA-256"\)/, /digests:\$uploadId/]},
        cpp: {all: [/SHA256\(/, /digests:/]},
      },
    },
    {
      id: 'stored-set-completeness',
      title: 'Never completes an upload from a caller-declared size',
      detail:
        'Completeness is read from the stored chunk set (`HLEN`), never from a `total_bytes` the caller declares. The draft trusts that number, so an upload missing its last chunk still reports itself complete.',
      match: {
        python: {all: [/hlen\(/], none: [/total_bytes/]},
        typescript: {all: [/\.hlen\(/], none: [/total_bytes/]},
        go: {all: [/HLen\(/], none: [/totalBytes|total_bytes/]},
        scala: {all: [/hlen\(/], none: [/totalBytes/]},
        cpp: {all: [/hlen\(/], none: [/totalBytes/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import base64

import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=False)


class ChunkRequest(BaseModel):
    index: int
    data: str
    total_bytes: int = 0


@app.post("/v1/checkpoints")
def put_chunk(
    body: ChunkRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
    upload_id: str = Header(alias="X-Upload-Id"),
) -> dict:
    # TODO: this draft concatenates chunks in arrival order, appends a redelivered chunk a second
    # time, and reports the upload complete from the caller's total_bytes. Accept a chunk only at
    # the expected index, store it at that index with its digest, and derive completeness from the
    # stored chunk set.
    payload = base64.b64decode(body.data)
    r.rpush(f"chunks:{upload_id}", payload)
    received = int(r.get(f"received:{upload_id}") or 0) + len(payload)
    r.set(f"received:{upload_id}", received)
    return {"upload_id": upload_id, "complete": received >= body.total_bytes}
`,
      solution: `import base64
import hashlib

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=False)

CHUNK_BYTES = 1 << 23


class ChunkRequest(BaseModel):
    index: int
    data: str


def chunk_key(upload_id: str) -> str:
    """One hash field per chunk index: a replay overwrites its own position."""
    return f"chunks:{upload_id}"


def digest_key(upload_id: str) -> str:
    return f"digests:{upload_id}"


@app.post("/v1/checkpoints")
def put_chunk(
    body: ChunkRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
    upload_id: str = Header(default="", alias="X-Upload-Id"),
) -> dict:
    if upload_id == "":
        raise HTTPException(status_code=400, detail="X-Upload-Id is required")
    payload = base64.b64decode(body.data)
    if len(payload) > CHUNK_BYTES:
        raise HTTPException(status_code=413, detail="chunk exceeds 8 MiB")

    received = r.hlen(chunk_key(upload_id))
    digest = hashlib.sha256(payload).hexdigest()
    stored = r.hget(digest_key(upload_id), body.index)
    if stored is not None:
        if stored.decode() != digest:
            raise HTTPException(status_code=409, detail="index already stored with another digest")
        return {"upload_id": upload_id, "index": body.index, "received": received}
    if body.index != received:
        raise HTTPException(status_code=409, detail=f"expected chunk {received}, got {body.index}")

    r.hset(chunk_key(upload_id), body.index, payload)
    r.hset(digest_key(upload_id), body.index, digest)
    return {"upload_id": upload_id, "index": body.index, "received": r.hlen(chunk_key(upload_id))}
`,
    },
    typescript: {
      starter: `/** POST /v1/checkpoints: a model-generated draft that applies chunks as they arrive. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface ChunkBody {
  index: number;
  data: string;
  total_bytes: number;
}

app.post('/v1/checkpoints', async (request, reply) => {
  // TODO: this draft concatenates chunks in arrival order, appends a redelivered chunk a second
  // time, and reports the upload complete from the caller's total_bytes. Accept a chunk only at
  // the expected index, store it at that index with its digest, and derive completeness from the
  // stored chunk set.
  const tenant = request.headers['x-tenant-id'] as string;
  const uploadId = request.headers['x-upload-id'] as string;
  const body = request.body as ChunkBody;
  const payload = Buffer.from(body.data, 'base64');
  await r.rpush(\`chunks:\${uploadId}\`, payload);
  const received = Number((await r.get(\`received:\${uploadId}\`)) ?? '0') + payload.byteLength;
  await r.set(\`received:\${uploadId}\`, String(received));
  return reply.code(200).send({upload_id: uploadId, complete: received >= body.total_bytes});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/checkpoints: a chunk is accepted at its index, digested, and never reordered. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const CHUNK_BYTES = 1 << 23;

interface ChunkBody {
  index: number;
  data: string;
}

const chunkKey = (uploadId: string): string => \`chunks:\${uploadId}\`;
const digestKey = (uploadId: string): string => \`digests:\${uploadId}\`;

app.post('/v1/checkpoints', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const uploadId = request.headers['x-upload-id'];
  if (typeof uploadId !== 'string' || uploadId === '') return reply.code(400).send({error: 'X-Upload-Id is required'});

  const body = request.body as ChunkBody;
  const payload = Buffer.from(body.data, 'base64');
  if (payload.byteLength > CHUNK_BYTES) return reply.code(413).send({error: 'chunk exceeds 8 MiB'});

  const received = await r.hlen(chunkKey(uploadId));
  const digest = createHash('sha256').update(payload).digest('hex');
  const stored = await r.hget(digestKey(uploadId), String(body.index));
  if (stored !== null) {
    if (stored !== digest) return reply.code(409).send({error: 'index already stored with another digest'});
    return reply.code(200).send({upload_id: uploadId, index: body.index, received});
  }
  if (body.index !== received)
    return reply.code(409).send({error: \`expected chunk \${received}, got \${body.index}\`});

  await r.hset(chunkKey(uploadId), String(body.index), payload);
  await r.hset(digestKey(uploadId), String(body.index), digest);
  return reply.code(200).send({upload_id: uploadId, index: body.index, received: received + 1});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type chunkRequest struct {
	Index      int    \`json:"index"\`
	Data       string \`json:"data"\`
	TotalBytes int64  \`json:"total_bytes"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func putChunk(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	uploadID := r.Header.Get("X-Upload-Id")
	var body chunkRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft concatenates chunks in arrival order, appends a redelivered chunk a second
	// time, and reports the upload complete from the caller's total_bytes. Accept a chunk only at
	// the expected index, store it at that index with its digest, and derive completeness from the
	// stored chunk set.
	payload, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid base64"})
		return
	}
	rdb.RPush(r.Context(), "chunks:"+uploadID, payload)
	received, _ := rdb.IncrBy(r.Context(), "received:"+uploadID, int64(len(payload))).Result()
	writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "complete": received >= body.TotalBytes})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/checkpoints", putChunk)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const chunkBytes = 1 << 23

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type chunkRequest struct {
	Index int    \`json:"index"\`
	Data  string \`json:"data"\`
}

// chunkKey is one hash field per chunk index: a replay overwrites its own position.
func chunkKey(uploadID string) string { return fmt.Sprintf("chunks:%s", uploadID) }

func digestKey(uploadID string) string { return fmt.Sprintf("digests:%s", uploadID) }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func putChunk(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	uploadID := r.Header.Get("X-Upload-Id")
	if uploadID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "X-Upload-Id is required"})
		return
	}
	var body chunkRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	payload, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid base64"})
		return
	}
	if len(payload) > chunkBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "chunk exceeds 8 MiB"})
		return
	}
	received, err := rdb.HLen(r.Context(), chunkKey(uploadID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "state unavailable"})
		return
	}
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	stored, err := rdb.HGet(r.Context(), digestKey(uploadID), strconv.Itoa(body.Index)).Result()
	if err == nil {
		if stored != digest {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": "index already stored with another digest"})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "index": body.Index, "received": received})
		return
	}
	if err != redis.Nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "state unavailable"})
		return
	}
	if int64(body.Index) != received {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "chunk arrives out of order"})
		return
	}
	if err := rdb.HSet(r.Context(), chunkKey(uploadID), strconv.Itoa(body.Index), payload).Err(); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "write failed"})
		return
	}
	if err := rdb.HSet(r.Context(), digestKey(uploadID), strconv.Itoa(body.Index), digest).Err(); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "write failed"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"upload_id": uploadID, "index": body.Index, "received": received + 1})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/checkpoints", putChunk)
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

final case class ChunkRequest(index: Int, data: String, totalBytes: Long)

object Api {
  implicit val system: ActorSystem = ActorSystem("checkpoint-store")
  implicit val chunkFormat: RootJsonFormat[ChunkRequest] = jsonFormat3(ChunkRequest)

  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "checkpoints") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          headerValueByName("X-Upload-Id") { uploadId =>
            entity(as[ChunkRequest]) { body =>
              // TODO: this draft concatenates chunks in arrival order, appends a redelivered chunk a
              // second time, and reports the upload complete from the caller's totalBytes. Accept a
              // chunk only at the expected index, store it at that index with its digest, and derive
              // completeness from the stored chunk set.
              val payload = java.util.Base64.getDecoder.decode(body.data)
              jedis.rpush(s"chunks:$uploadId", new String(payload))
              val received = jedis.incrBy(s"received:$uploadId", payload.length.toLong)
              complete(
                StatusCodes.OK,
                s"""{"upload_id":"$uploadId","complete":\${received >= body.totalBytes}}"""
              )
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Base64

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ChunkRequest(index: Int, data: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("checkpoint-store")
  implicit val chunkFormat: RootJsonFormat[ChunkRequest] = jsonFormat2(ChunkRequest)

  val ChunkBytes = 1 << 23

  val jedis = new Jedis("redis", 6379)

  // One hash field per chunk index: a replay overwrites its own position.
  def chunkKey(uploadId: String): String = s"chunks:$uploadId"

  def digestKey(uploadId: String): String = s"digests:$uploadId"

  def sha256Hex(payload: Array[Byte]): String =
    MessageDigest.getInstance("SHA-256").digest(payload).map("%02x".format(_)).mkString

  val route: Route =
    path("v1" / "checkpoints") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-Upload-Id") { uploadOpt =>
            entity(as[ChunkRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!uploadOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"X-Upload-Id is required"}""")
              } else {
                val uploadId = uploadOpt.get
                val payload = Base64.getDecoder.decode(body.data)
                if (payload.length > ChunkBytes) {
                  complete(StatusCodes.RequestEntityTooLarge, """{"error":"chunk exceeds 8 MiB"}""")
                } else {
                  val received = jedis.hlen(chunkKey(uploadId))
                  val digest = sha256Hex(payload)
                  Option(jedis.hget(digestKey(uploadId), body.index.toString)) match {
                    case Some(stored) if stored != digest =>
                      complete(StatusCodes.Conflict, """{"error":"index already stored with another digest"}""")
                    case Some(_) =>
                      complete(
                        StatusCodes.OK,
                        s"""{"upload_id":"$uploadId","index":\${body.index},"received":$received}"""
                      )
                    case None if body.index.toLong != received =>
                      complete(StatusCodes.Conflict, """{"error":"chunk arrives out of order"}""")
                    case None =>
                      jedis.hset(chunkKey(uploadId), body.index.toString, new String(payload))
                      jedis.hset(digestKey(uploadId), body.index.toString, digest)
                      complete(
                        StatusCodes.OK,
                        s"""{"upload_id":"$uploadId","index":\${body.index},"received":\${received + 1}}"""
                      )
                  }
                }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
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

std::string base64Decode(const std::string& data);

int main() {
  httplib::Server svr;

  svr.Post("/v1/checkpoints", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto uploadId = req.get_header_value("X-Upload-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft concatenates chunks in arrival order, appends a redelivered chunk a second
    // time, and reports the upload complete from the caller's total_bytes. Accept a chunk only at
    // the expected index, store it at that index with its digest, and derive completeness from the
    // stored chunk set.
    const auto payload = base64Decode(body.value("data", std::string()));
    r.rpush("chunks:" + uploadId, payload);
    const auto received = r.incrby("received:" + uploadId, static_cast<long long>(payload.size()));
    res.status = 200;
    res.set_content(
        json{{"upload_id", uploadId}, {"complete", received >= body.value("total_bytes", 0LL)}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kChunkBytes = 1 << 23;

sw::redis::Redis r("tcp://redis:6379");

std::string base64Decode(const std::string& data);

// One hash field per chunk index: a replay overwrites its own position.
std::string chunkKey(const std::string& uploadId) { return "chunks:" + uploadId; }

std::string digestKey(const std::string& uploadId) { return "digests:" + uploadId; }

std::string sha256Hex(const std::string& payload) {
  unsigned char out[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), out);
  std::ostringstream hex;
  for (unsigned char byte : out) hex << std::hex << std::setw(2) << std::setfill('0') << int(byte);
  return hex.str();
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/checkpoints", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto uploadId = req.get_header_value("X-Upload-Id");
    if (uploadId.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"X-Upload-Id is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("data")) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto payload = base64Decode(body.value("data", std::string()));
    if (payload.size() > kChunkBytes) {
      res.status = 413;
      res.set_content(R"({"error":"chunk exceeds 8 MiB"})", "application/json");
      return;
    }
    const long long received = r.hlen(chunkKey(uploadId));
    const auto digest = sha256Hex(payload);
    const auto index = std::to_string(body.value("index", -1));
    const auto stored = r.hget(digestKey(uploadId), index);
    if (stored) {
      if (*stored != digest) {
        res.status = 409;
        res.set_content(R"({"error":"index already stored with another digest"})", "application/json");
        return;
      }
      res.status = 200;
      res.set_content(json{{"upload_id", uploadId}, {"index", body.value("index", -1)}, {"received", received}}.dump(),
                      "application/json");
      return;
    }
    if (body.value("index", -1) != received) {
      res.status = 409;
      res.set_content(R"({"error":"chunk arrives out of order"})", "application/json");
      return;
    }
    r.hset(chunkKey(uploadId), index, payload);
    r.hset(digestKey(uploadId), index, digest);
    res.status = 200;
    res.set_content(
        json{{"upload_id", uploadId}, {"index", body.value("index", -1)}, {"received", received + 1}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The next expected index is not a counter you keep in the request: it is `HLEN(chunks:{upload_id})`, the number of chunks already stored for that upload. Compare the incoming index against it and reject with 409 before writing anything — a chunk that arrives early would otherwise be applied out of order.',
    'Store each chunk as its own hash field keyed by the index (`HSET chunks:{upload_id} {index} payload`), the way the object store will read it back. Appending to a list is what turns a redelivered chunk into a duplicated slice of the weights.',
    'The digest is what makes a replay safe: compute `sha256` of the decoded bytes, keep it next to the chunk, and compare it when the index already exists. Same bytes → 200 and nothing written; different bytes → 409, because a chunk rewriting an index is corruption rather than a retry. And completeness comes from `HLEN`, never from the size the caller declares.',
  ],
  debrief: `The interviewer is testing whether you can review a generated upload handler at the point where a distributed write becomes a durable object. The draft looks fine because one well-behaved client sends chunks in order exactly once. What it breaks is the retry contract: chunk indexes are the only thing that ties a stream of requests to one checkpoint, a replay has to be idempotent by construction (store at the index, compare the digest), and completeness must be a property of the stored set rather than of a number the caller sent. Real stores add per-chunk checksums returned by the object store, a manifest written last, resumable upload negotiation, and a chunk-level rate limit per upload so one client cannot saturate the store.`,
};
