import type {Step} from '@/lib/types';

export const ingestDocumentStep: Step = {
  id: 'ingest-document',
  title: 'POST /v1/documents: one version, one event, one transaction',
  concept: 'http',
  file: 'ingest_api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/documents\` with body \`{"doc_id", "version",
"content_type", "content"}\` and \`X-Tenant-Id\` (**401** without it). It hashes the content, answers
**202** with the stored \`job_id\` when \`docs.get(tenant, doc_id, version)\` finds the version, and
otherwise writes the document hash at \`doc_key(tenant, doc_id, version)\`, then pushes a \`doc.ingest\`
event onto \`rag:outbox\` and answers **202** \`{job_id}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** An id with spaces, an image type or a 50 MiB body is stored and
becomes chunks. A re-upload of version 3 with new text is answered as a retry, so the index keeps
text the caller believes replaced. The two writes are two round trips: a crash between them leaves a
document no worker hears about. And the event copies the whole document into a topic.

Requirements:

- \`doc_id\` matches \`^[a-z0-9][a-z0-9_-]{2,63}$\`, \`content_type\` is in \`ALLOWED_TYPES\` (\`text/plain\`,
  \`text/markdown\`, \`text/html\`), \`version >= 1\`, else **400**; content over \`MAX_BODY_BYTES\` (1 MiB
  of UTF-8) is **413**. A rejected request stores nothing.
- A stored version with the same SHA-256 is a retry (**202**, its \`job_id\`); another hash is **409**.
- The document and its outbox row are written in one \`MULTI\`/\`EXEC\` (or one script).
- The event is \`{tenant, doc_id, version, job_id, sha256}\`; the worker reads the content from the store.`,
  sequence: {
    participants: ['Client', 'ragd API', 'Redis'],
    messages: [
      {from: 'Client', to: 'ragd API', label: 'POST /v1/documents · X-Tenant-Id', kind: 'sync'},
      {from: 'ragd API', to: 'ragd API', label: 'validate · sha256(content)', kind: 'sync'},
      {from: 'ragd API', to: 'Redis', label: 'HGETALL rag:doc:{tenant}:{doc}:{version}', kind: 'sync'},
      {from: 'Redis', to: 'ragd API', label: 'none / stored sha256', kind: 'reply'},
      {from: 'ragd API', to: 'Redis', label: 'MULTI · HSET document · RPUSH rag:outbox · EXEC', kind: 'sync'},
      {from: 'ragd API', to: 'Client', label: '202 {job_id} · 409 on another hash', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/documents',
      detail:
        'A valid upload answers 202 with a job_id, the version is stored at rag:doc:{tenant}:{doc_id}:{version} with one outbox row, and a request without X-Tenant-Id answers 401.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/documents["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/documents['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/documents"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"documents"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/documents"/]},
      },
    },
    {
      id: 'validate-body',
      title: 'Rejects a bad id, type, version or size before storing',
      detail:
        'An id outside ^[a-z0-9][a-z0-9_-]{2,63}$, a content_type outside ALLOWED_TYPES or a version below 1 is 400, content over 1 MiB is 413, and none of them leaves a key in Redis; exactly 1 MiB is accepted. The starter stores all of them.',
      match: {
        python: {all: [/ALLOWED_TYPES/, /MAX_BODY_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/ALLOWED_TYPES/, /MAX_BODY_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/allowedTypes/, /maxBodyBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/AllowedTypes/, /MaxBodyBytes/, /StatusCodes\.(PayloadTooLarge|RequestEntityTooLarge)/]},
        cpp: {all: [/kAllowedTypes/, /kMaxBodyBytes/, /\b413\b/]},
      },
    },
    {
      id: 'version-conflict',
      title: 'Tells a retry from a rewritten version',
      detail:
        'The same upload twice answers 202 with one job_id and one outbox row; version 2 gets a new job; version 1 with other content is 409 and leaves the stored text alone. The starter answers the rewrite as a retry.',
      match: {
        python: {
          all: [/status_code\s*=\s*409/, /\[["']sha256["']\]\s*!=\s*digest|digest\s*!=\s*\w+\[["']sha256["']\]/],
        },
        typescript: {all: [/code\(\s*409\s*\)/, /\.sha256\s*!==?\s*digest|digest\s*!==?\s*\w+\.sha256/]},
        go: {all: [/StatusConflict/, /\.SHA256\s*!=\s*digest|digest\s*!=\s*\w+\.SHA256/]},
        scala: {all: [/StatusCodes\.Conflict/, /\.sha256\s*!=\s*digest|digest\s*!=\s*\w+\.sha256/]},
        cpp: {all: [/\b409\b/, /->sha256\s*!=\s*digest|digest\s*!=\s*\w+->sha256/]},
      },
    },
    {
      id: 'outbox-tx',
      title: 'Writes the document and its outbox row together',
      detail:
        'At the instant the document becomes visible in Redis its outbox row is already there: one MULTI/EXEC (or one script) writes both. The starter writes the hash, then pushes the row in a second round trip.',
      match: {
        python: {all: [/\.pipeline\(|\.transaction\(|register_script/], none: [/transaction\s*=\s*False/]},
        typescript: {all: [/\.multi\(|\.eval\(|defineCommand\(/]},
        go: {all: [/TxPipelined\(|\.TxPipeline\(\)|redis\.NewScript\(/]},
        scala: {all: [/\.multi\(\)|\.eval\(/]},
        cpp: {all: [/\.transaction\(|\.eval\b/]},
      },
    },
    {
      id: 'event-ids-only',
      title: 'Puts ids and the hash in the event, not the document',
      detail:
        'The outbox row is {tenant, doc_id, version, job_id, sha256} with the SHA-256 of the content and no content field: the worker reads the text from the store. The starter copies the whole document into the event.',
      match: {
        python: {all: [/event\s*=\s*\{[^}]*["']sha256["']/], none: [/event\s*=\s*\{[^}]*["']content["']\s*:/]},
        typescript: {all: [/event\s*=\s*\{[^}]*\bsha256\b/], none: [/event\s*=\s*\{[^}]*\bcontent:/]},
        go: {
          all: [/event,\s*_?\w*\s*:?=\s*json\.Marshal\([^)]*"sha256"/],
          none: [/event,\s*_?\w*\s*:?=\s*json\.Marshal\([^)]*"content":/],
        },
        scala: {all: [/event\s*=\s*ujson\.Obj\([^)]*"sha256"/], none: [/event\s*=\s*ujson\.Obj\([^)]*"content"\s*->/]},
        cpp: {all: [/json event\s*=\s*\{[^;]*"sha256"/], none: [/json event\s*=\s*\{[^;]*\{"content",/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json
import logging
import uuid

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from rag import docs
from rag.config import OUTBOX_KEY, doc_key

app = FastAPI()
logger = logging.getLogger("ragd.ingest")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class DocumentRequest(BaseModel):
    doc_id: str
    version: int
    content_type: str
    content: str


@app.post("/v1/documents")
def ingest(body: DocumentRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    digest = hashlib.sha256(body.content.encode("utf-8")).hexdigest()
    stored = docs.get(tenant, body.doc_id, body.version)
    if stored is not None:
        return JSONResponse({"job_id": stored["job_id"]}, status_code=202)

    job_id = str(uuid.uuid4())
    r.hset(
        doc_key(tenant, body.doc_id, body.version),
        mapping={"sha256": digest, "job_id": job_id, "content_type": body.content_type, "content": body.content},
    )
    event = {
        "tenant": tenant,
        "doc_id": body.doc_id,
        "version": body.version,
        "job_id": job_id,
        "content_type": body.content_type,
        "content": body.content,
    }
    r.rpush(OUTBOX_KEY, json.dumps(event))
    logger.info("ingest tenant=%s doc=%s version=%d job=%s", tenant, body.doc_id, body.version, job_id)
    return JSONResponse({"job_id": job_id}, status_code=202)
`,
      solution: `import hashlib
import json
import logging
import re
import uuid

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from rag import docs
from rag.config import OUTBOX_KEY, doc_key

app = FastAPI()
logger = logging.getLogger("ragd.ingest")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_BODY_BYTES = 1 << 20
ALLOWED_TYPES = {"text/plain", "text/markdown", "text/html"}
DOC_ID = re.compile(r"[a-z0-9][a-z0-9_-]{2,63}")


class DocumentRequest(BaseModel):
    doc_id: str
    version: int
    content_type: str
    content: str


def rejected(status: int, error: str) -> JSONResponse:
    return JSONResponse({"error": error}, status_code=status)


@app.post("/v1/documents")
def ingest(body: DocumentRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        return rejected(401, "missing X-Tenant-Id")
    if DOC_ID.fullmatch(body.doc_id) is None:
        return rejected(400, "invalid doc_id")
    if body.content_type not in ALLOWED_TYPES:
        return rejected(400, "unsupported content_type")
    if body.version < 1:
        return rejected(400, "version must be 1 or more")
    data = body.content.encode("utf-8")
    if len(data) > MAX_BODY_BYTES:
        return JSONResponse({"error": "document over 1 MiB"}, status_code=413)

    digest = hashlib.sha256(data).hexdigest()
    stored = docs.get(tenant, body.doc_id, body.version)
    if stored is not None:
        if stored["sha256"] != digest:
            return JSONResponse({"error": "version_conflict"}, status_code=409)
        return JSONResponse({"job_id": stored["job_id"]}, status_code=202)

    job_id = str(uuid.uuid4())
    event = {"tenant": tenant, "doc_id": body.doc_id, "version": body.version, "job_id": job_id, "sha256": digest}
    tx = r.pipeline(transaction=True)
    tx.hset(
        doc_key(tenant, body.doc_id, body.version),
        mapping={"sha256": digest, "job_id": job_id, "content_type": body.content_type, "content": body.content},
    )
    tx.rpush(OUTBOX_KEY, json.dumps(event))
    tx.execute()
    logger.info("ingest tenant=%s doc=%s version=%d job=%s", tenant, body.doc_id, body.version, job_id)
    return JSONResponse({"job_id": job_id}, status_code=202)
`,
    },
    typescript: {
      starter: `import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';

import {OUTBOX_KEY, docKey} from 'rag/config';
import * as docs from 'rag/docs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

interface DocumentBody {
  doc_id: string;
  version: number;
  content_type: string;
  content: string;
}

app.post('/v1/documents', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as DocumentBody;
  const digest = createHash('sha256').update(body.content, 'utf8').digest('hex');
  const stored = await docs.get(tenant, body.doc_id, body.version);
  if (stored !== null) return reply.code(202).send({job_id: stored.job_id});

  const jobId = randomUUID();
  await redis.hset(docKey(tenant, body.doc_id, body.version), {
    sha256: digest,
    job_id: jobId,
    content_type: body.content_type,
    content: body.content,
  });
  const event = {
    tenant,
    doc_id: body.doc_id,
    version: body.version,
    job_id: jobId,
    content_type: body.content_type,
    content: body.content,
  };
  await redis.rpush(OUTBOX_KEY, JSON.stringify(event));
  request.log.info({tenant, doc_id: body.doc_id, version: body.version, job_id: jobId}, 'document stored');
  return reply.code(202).send({job_id: jobId});
});
`,
      solution: `import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';

import {OUTBOX_KEY, docKey} from 'rag/config';
import * as docs from 'rag/docs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const MAX_BODY_BYTES = 1 << 20;
export const ALLOWED_TYPES: Record<string, true> = {'text/plain': true, 'text/markdown': true, 'text/html': true};
const DOC_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;

interface DocumentBody {
  doc_id: string;
  version: number;
  content_type: string;
  content: string;
}

app.post('/v1/documents', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = (request.body ?? {}) as Partial<DocumentBody>;
  if (typeof body.doc_id !== 'string' || !DOC_ID.test(body.doc_id)) return reply.code(400).send({error: 'invalid doc_id'});
  if (typeof body.content_type !== 'string' || ALLOWED_TYPES[body.content_type] !== true)
    return reply.code(400).send({error: 'unsupported content_type'});
  if (!Number.isInteger(body.version) || (body.version as number) < 1)
    return reply.code(400).send({error: 'version must be 1 or more'});
  if (typeof body.content !== 'string') return reply.code(400).send({error: 'content is required'});
  if (Buffer.byteLength(body.content, 'utf8') > MAX_BODY_BYTES) return reply.code(413).send({error: 'document over 1 MiB'});
  const version = body.version as number;

  const digest = createHash('sha256').update(body.content, 'utf8').digest('hex');
  const stored = await docs.get(tenant, body.doc_id, version);
  if (stored !== null) {
    if (stored.sha256 !== digest) return reply.code(409).send({error: 'version_conflict'});
    return reply.code(202).send({job_id: stored.job_id});
  }

  const jobId = randomUUID();
  const event = {tenant, doc_id: body.doc_id, version, job_id: jobId, sha256: digest};
  await redis
    .multi()
    .hset(docKey(tenant, body.doc_id, version), {
      sha256: digest,
      job_id: jobId,
      content_type: body.content_type,
      content: body.content,
    })
    .rpush(OUTBOX_KEY, JSON.stringify(event))
    .exec();
  request.log.info({tenant, doc_id: body.doc_id, version, job_id: jobId}, 'document stored');
  return reply.code(202).send({job_id: jobId});
});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"rag/config" // config.DocKey(tenant, docID, version), config.OutboxKey — provided
	"rag/docs"   // docs.Get(ctx, tenant, docID, version) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type DocumentRequest struct {
	DocID       string \`json:"doc_id"\`
	Version     int    \`json:"version"\`
	ContentType string \`json:"content_type"\`
	Content     string \`json:"content"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body DocumentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	sum := sha256.Sum256([]byte(body.Content))
	digest := hex.EncodeToString(sum[:])
	ctx := r.Context()
	stored, err := docs.Get(ctx, tenant, body.DocID, body.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": stored.JobID})
		return
	}

	jobID := uuid.NewString()
	key := config.DocKey(tenant, body.DocID, body.Version)
	if err := rdb.HSet(ctx, key, "sha256", digest, "job_id", jobID, "content_type", body.ContentType, "content", body.Content).Err(); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	event, _ := json.Marshal(map[string]any{
		"tenant":       tenant,
		"doc_id":       body.DocID,
		"version":      body.Version,
		"job_id":       jobID,
		"content_type": body.ContentType,
		"content":      body.Content,
	})
	if err := rdb.RPush(ctx, config.OutboxKey, event).Err(); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	log.Printf("ingest tenant=%s doc=%s version=%d job=%s", tenant, body.DocID, body.Version, jobID)
	writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": jobID})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/documents", ingest)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"regexp"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"rag/config" // config.DocKey(tenant, docID, version), config.OutboxKey — provided
	"rag/docs"   // docs.Get(ctx, tenant, docID, version) — provided
)

const maxBodyBytes = 1 << 20

var (
	allowedTypes = map[string]bool{"text/plain": true, "text/markdown": true, "text/html": true}
	docIDPattern = regexp.MustCompile(\`^[a-z0-9][a-z0-9_-]{2,63}$\`)
	rdb          = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

type DocumentRequest struct {
	DocID       string \`json:"doc_id"\`
	Version     int    \`json:"version"\`
	ContentType string \`json:"content_type"\`
	Content     string \`json:"content"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body DocumentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	switch {
	case !docIDPattern.MatchString(body.DocID):
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid doc_id"})
		return
	case !allowedTypes[body.ContentType]:
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unsupported content_type"})
		return
	case body.Version < 1:
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "version must be 1 or more"})
		return
	case len(body.Content) > maxBodyBytes:
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "document over 1 MiB"})
		return
	}

	sum := sha256.Sum256([]byte(body.Content))
	digest := hex.EncodeToString(sum[:])
	ctx := r.Context()
	stored, err := docs.Get(ctx, tenant, body.DocID, body.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if stored != nil {
		if stored.SHA256 != digest {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": "version_conflict"})
			return
		}
		writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": stored.JobID})
		return
	}

	jobID := uuid.NewString()
	event, _ := json.Marshal(map[string]any{"tenant": tenant, "doc_id": body.DocID, "version": body.Version, "job_id": jobID, "sha256": digest})
	_, err = rdb.TxPipelined(ctx, func(tx redis.Pipeliner) error {
		tx.HSet(ctx, config.DocKey(tenant, body.DocID, body.Version), "sha256", digest, "job_id", jobID, "content_type", body.ContentType, "content", body.Content)
		tx.RPush(ctx, config.OutboxKey, event)
		return nil
	})
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	log.Printf("ingest tenant=%s doc=%s version=%d job=%s", tenant, body.DocID, body.Version, jobID)
	writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": jobID})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/documents", ingest)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.jdk.CollectionConverters._

import rag.{Config, Docs}

final case class DocumentRequest(doc_id: String, version: Int, content_type: String, content: String)

object IngestApi {
  implicit val system: ActorSystem = ActorSystem("ragd")
  implicit val requestFormat: RootJsonFormat[DocumentRequest] = jsonFormat4(DocumentRequest)
  private val jedis = new JedisPooled("redis", 6379)

  def sha256Hex(bytes: Array[Byte]): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).map("%02x".format(_)).mkString

  def reply(status: StatusCode, body: ujson.Value): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  val route: Route =
    path("v1" / "documents") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[DocumentRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) reply(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id"))
            else {
              val tenant = tenantOpt.get
              val digest = sha256Hex(body.content.getBytes("UTF-8"))
              Docs.get(tenant, body.doc_id, body.version) match {
                case Some(stored) => reply(StatusCodes.Accepted, ujson.Obj("job_id" -> stored.job_id))
                case None =>
                  val jobId = UUID.randomUUID().toString
                  jedis.hset(
                    Config.docKey(tenant, body.doc_id, body.version),
                    Map("sha256" -> digest, "job_id" -> jobId, "content_type" -> body.content_type, "content" -> body.content).asJava
                  )
                  val event = ujson.Obj(
                    "tenant" -> tenant,
                    "doc_id" -> body.doc_id,
                    "version" -> body.version,
                    "job_id" -> jobId,
                    "content_type" -> body.content_type,
                    "content" -> body.content
                  )
                  jedis.rpush(Config.OutboxKey, ujson.write(event))
                  system.log.info(s"ingest tenant=$tenant doc=\${body.doc_id} version=\${body.version} job=$jobId")
                  reply(StatusCodes.Accepted, ujson.Obj("job_id" -> jobId))
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
      solution: `import java.security.MessageDigest
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.jdk.CollectionConverters._

import rag.{Config, Docs}

final case class DocumentRequest(doc_id: String, version: Int, content_type: String, content: String)

object IngestApi {
  implicit val system: ActorSystem = ActorSystem("ragd")
  implicit val requestFormat: RootJsonFormat[DocumentRequest] = jsonFormat4(DocumentRequest)
  private val jedis = new JedisPooled("redis", 6379)

  val MaxBodyBytes: Int = 1 << 20
  val AllowedTypes = Set("text/plain", "text/markdown", "text/html")
  val DocId = "[a-z0-9][a-z0-9_-]{2,63}".r

  def sha256Hex(bytes: Array[Byte]): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).map("%02x".format(_)).mkString

  def reply(status: StatusCode, body: ujson.Value): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  def ingest(tenant: String, body: DocumentRequest): Route = {
    val data = body.content.getBytes("UTF-8")
    val digest = sha256Hex(data)
    Docs.get(tenant, body.doc_id, body.version) match {
      case Some(stored) if stored.sha256 != digest => reply(StatusCodes.Conflict, ujson.Obj("error" -> "version_conflict"))
      case Some(stored) => reply(StatusCodes.Accepted, ujson.Obj("job_id" -> stored.job_id))
      case None =>
        val jobId = UUID.randomUUID().toString
        val event = ujson.Obj("tenant" -> tenant, "doc_id" -> body.doc_id, "version" -> body.version, "job_id" -> jobId, "sha256" -> digest)
        val tx = jedis.multi()
        tx.hset(
          Config.docKey(tenant, body.doc_id, body.version),
          Map("sha256" -> digest, "job_id" -> jobId, "content_type" -> body.content_type, "content" -> body.content).asJava
        )
        tx.rpush(Config.OutboxKey, ujson.write(event))
        tx.exec()
        system.log.info(s"ingest tenant=$tenant doc=\${body.doc_id} version=\${body.version} job=$jobId")
        reply(StatusCodes.Accepted, ujson.Obj("job_id" -> jobId))
    }
  }

  val route: Route =
    path("v1" / "documents") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[DocumentRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) reply(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id"))
            else if (!DocId.matches(body.doc_id)) reply(StatusCodes.BadRequest, ujson.Obj("error" -> "invalid doc_id"))
            else if (!AllowedTypes.contains(body.content_type))
              reply(StatusCodes.BadRequest, ujson.Obj("error" -> "unsupported content_type"))
            else if (body.version < 1) reply(StatusCodes.BadRequest, ujson.Obj("error" -> "version must be 1 or more"))
            else if (body.content.getBytes("UTF-8").length > MaxBodyBytes)
              reply(StatusCodes.PayloadTooLarge, ujson.Obj("error" -> "document over 1 MiB"))
            else ingest(tenantOpt.get, body)
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

#include "digest.h"      // sha256_hex(bytes) — provided
#include "ids.h"         // new_uuid() — provided
#include "rag/config.h"  // config::doc_key(tenant, doc_id, version), config::kOutboxKey — provided
#include "rag/docs.h"    // docs::get(tenant, doc_id, version) — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "missing X-Tenant-Id"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "invalid json"}});
  const std::string doc_id = body.value("doc_id", "");
  const std::string content_type = body.value("content_type", "");
  const std::string content = body.value("content", "");
  const int version = body.value("version", 0);
  const std::string digest = sha256_hex(content);
  if (const auto stored = docs::get(tenant, doc_id, version)) return reply(res, 202, {{"job_id", stored->job_id}});

  const std::string job_id = new_uuid();
  redis.hset(config::doc_key(tenant, doc_id, version),
             {std::make_pair("sha256", digest), std::make_pair("job_id", job_id), std::make_pair("content_type", content_type),
              std::make_pair("content", content)});
  const json event = {{"tenant", tenant},   {"doc_id", doc_id},
                      {"version", version}, {"job_id", job_id},
                      {"content_type", content_type}, {"content", content}};
  redis.rpush(config::kOutboxKey, event.dump());
  std::cerr << "ingest tenant=" << tenant << " doc=" << doc_id << " version=" << version << " job=" << job_id << "\\n";
  reply(res, 202, {{"job_id", job_id}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/documents", ingest); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <regex>
#include <set>
#include <string>

#include "digest.h"      // sha256_hex(bytes) — provided
#include "ids.h"         // new_uuid() — provided
#include "rag/config.h"  // config::doc_key(tenant, doc_id, version), config::kOutboxKey — provided
#include "rag/docs.h"    // docs::get(tenant, doc_id, version) — provided

using json = nlohmann::json;

constexpr size_t kMaxBodyBytes = 1 << 20;
const std::set<std::string> kAllowedTypes = {"text/plain", "text/markdown", "text/html"};
const std::regex kDocId("[a-z0-9][a-z0-9_-]{2,63}");

sw::redis::Redis redis("tcp://redis:6379");

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "missing X-Tenant-Id"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("doc_id") || !body["doc_id"].is_string() || !body.contains("content") ||
      !body["content"].is_string())
    return reply(res, 400, {{"error", "invalid json"}});
  const std::string doc_id = body["doc_id"];
  const std::string content_type = body.value("content_type", "");
  const std::string content = body["content"];
  const int version = body.contains("version") && body["version"].is_number_integer() ? body["version"].get<int>() : 0;
  if (!std::regex_match(doc_id, kDocId)) return reply(res, 400, {{"error", "invalid doc_id"}});
  if (kAllowedTypes.count(content_type) == 0) return reply(res, 400, {{"error", "unsupported content_type"}});
  if (version < 1) return reply(res, 400, {{"error", "version must be 1 or more"}});
  if (content.size() > kMaxBodyBytes) return reply(res, 413, {{"error", "document over 1 MiB"}});

  const std::string digest = sha256_hex(content);
  if (const auto stored = docs::get(tenant, doc_id, version)) {
    if (stored->sha256 != digest) return reply(res, 409, {{"error", "version_conflict"}});
    return reply(res, 202, {{"job_id", stored->job_id}});
  }

  const std::string job_id = new_uuid();
  const json event = {{"tenant", tenant}, {"doc_id", doc_id}, {"version", version}, {"job_id", job_id}, {"sha256", digest}};
  auto tx = redis.transaction();
  tx.hset(config::doc_key(tenant, doc_id, version),
          {std::make_pair("sha256", digest), std::make_pair("job_id", job_id), std::make_pair("content_type", content_type),
           std::make_pair("content", content)});
  tx.rpush(config::kOutboxKey, event.dump());
  tx.exec();
  std::cerr << "ingest tenant=" << tenant << " doc=" << doc_id << " version=" << version << " job=" << job_id << "\\n";
  reply(res, 202, {{"job_id", job_id}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/documents", ingest); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

GOOD = {"doc_id": "handbook-2026", "version": 1, "content_type": "text/markdown", "content": "# Refunds\\nRefunds are accepted within 30 days."}
DOC = "rag:doc:t1:handbook-2026:1"


def _api(ctx):
    return ctx.client(ctx.load("ingest_api").app)


async def _post(c, body, tenant="t1"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.post("/v1/documents", json=body, headers=headers)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("rag:outbox", 0, -1)]


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 202, f"a valid upload answered {r.status_code}: {r.text}"
        job_id = r.json().get("job_id")
        assert job_id, f"the 202 body must carry the job_id: {r.text}"
        stored = ctx.redis.hgetall(DOC)
        assert stored.get("job_id") == job_id and stored.get("content") == GOOD["content"], f"the version must be stored at {DOC} with its job_id and content, found {stored}"
        assert len(_outbox(ctx)) == 1, f"one upload, one outbox row: rag:outbox holds {len(_outbox(ctx))}"
        r = await _post(c, GOOD, tenant=None)
        assert r.status_code == 401, f"without X-Tenant-Id the upload must answer 401, got {r.status_code}"


async def check_validate_body(ctx):
    cases = [
        ({**GOOD, "doc_id": "Bad ID!"}, 400, "a doc_id with spaces and capitals"),
        ({**GOOD, "doc_id": "ab"}, 400, "a two-character doc_id"),
        ({**GOOD, "content_type": "image/png"}, 400, "content_type image/png"),
        ({**GOOD, "version": 0}, 400, "version 0"),
        ({**GOOD, "content": "a" * ((1 << 20) + 1)}, 413, "content of 1 MiB + 1 byte"),
    ]
    async with _api(ctx) as c:
        for body, status, what in cases:
            r = await _post(c, body)
            assert r.status_code == status, f"{what} answered {r.status_code}, expected {status}"
        assert ctx.redis.keys("rag:*") == [], f"rejected uploads must store nothing, Redis holds {sorted(ctx.redis.keys('rag:*'))}"
        r = await _post(c, {**GOOD, "content": "a" * (1 << 20)})
        assert r.status_code == 202, f"exactly 1 MiB is within the limit, got {r.status_code}"


async def check_version_conflict(ctx):
    async with _api(ctx) as c:
        first = await _post(c, GOOD)
        assert first.status_code == 202, f"the first upload answered {first.status_code}: {first.text}"
        job = first.json()["job_id"]
        retry = await _post(c, GOOD)
        assert retry.status_code == 202 and retry.json().get("job_id") == job, f"the same upload again is a retry: 202 with job {job}, got {retry.status_code} {retry.text}"
        assert len(_outbox(ctx)) == 1, f"a retry must not add an outbox row: rag:outbox holds {len(_outbox(ctx))}"
        v2 = await _post(c, {**GOOD, "version": 2, "content": "Refunds are accepted within 45 days."})
        assert v2.status_code == 202 and v2.json().get("job_id") not in (None, job), f"version 2 is a new document version with its own job, got {v2.status_code} {v2.text}"
        rewrite = await _post(c, {**GOOD, "content": "Refunds are never accepted."})
        assert rewrite.status_code == 409, f"version 1 with other content answered {rewrite.status_code}: a stored version is immutable, so another hash is a 409, not a retry"
        stored = ctx.redis.hgetall(DOC)
        assert stored.get("sha256") == _sha(GOOD["content"]) and stored.get("content") == GOOD["content"], f"the 409 must leave version 1 as it was, found {stored}"
        assert len(_outbox(ctx)) == 2, f"two versions, two outbox rows; rag:outbox holds {len(_outbox(ctx))}"


async def check_outbox_tx(ctx):
    taken = []

    def snapshot():
        return {"doc": ctx.redis.exists(DOC), "outbox": ctx.redis.llen("rag:outbox")}

    def first_touch():
        seen = snapshot()
        if seen["doc"]:
            return seen
        taken.append(ctx.redis_after(DOC, snapshot))  # the lookup came first: watch the write
        return None

    probe = ctx.redis_after(DOC, first_touch)
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
    assert r.status_code == 202, f"a valid upload answered {r.status_code}: {r.text}"
    seen = probe.result or (taken[0].result if taken and taken[0].fired else None)
    assert seen is not None and seen["doc"], "the document was never written"
    assert seen["outbox"] == 1, f"when the document became visible rag:outbox held {seen['outbox']} rows: a crash right there leaves a document no worker hears about; write both in one MULTI/EXEC"
    rows = _outbox(ctx)
    assert len(rows) == 1 and rows[0].get("job_id") == ctx.redis.hget(DOC, "job_id"), f"the outbox row must name the stored job: {rows}"


async def check_event_ids_only(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
    assert r.status_code == 202, f"a valid upload answered {r.status_code}: {r.text}"
    rows = _outbox(ctx)
    assert len(rows) == 1, f"one upload, one outbox row: found {len(rows)}"
    row = rows[0]
    assert "content" not in row, f"the event carries the document text: {sorted(row)}; ids and the hash only, the worker reads the content from the store"
    expected = {"tenant": "t1", "doc_id": "handbook-2026", "version": 1, "job_id": r.json()["job_id"], "sha256": _sha(GOOD["content"])}
    for key, value in expected.items():
        assert row.get(key) == value, f"the event must carry {key}={value!r}, got {row}"
`,
    typescript: `import {createHash} from 'node:crypto';

const GOOD = {doc_id: 'handbook-2026', version: 1, content_type: 'text/markdown', content: '# Refunds\\nRefunds are accepted within 30 days.'};
const DOC = 'rag:doc:t1:handbook-2026:1';

const api = ctx => ctx.client(ctx.load('ingest_api').app);
const post = (c, body, tenant: string | null = 't1') => c.post('/v1/documents', {body, headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});
const outbox = ctx => ctx.redis.lrange('rag:outbox', 0, -1).map(row => JSON.parse(row));
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD);
  assert.equal(r.status, 202, \`a valid upload answered \${r.status}: \${r.text}\`);
  const jobId = r.json().job_id;
  assert(jobId, \`the 202 body must carry the job_id: \${r.text}\`);
  const stored = ctx.redis.hgetall(DOC);
  assert(stored.job_id === jobId && stored.content === GOOD.content, \`the version must be stored at \${DOC} with its job_id and content, found \${JSON.stringify(stored)}\`);
  assert.equal(outbox(ctx).length, 1, \`one upload, one outbox row: rag:outbox holds \${outbox(ctx).length}\`);
  const noTenant = await post(c, GOOD, null);
  assert.equal(noTenant.status, 401, \`without X-Tenant-Id the upload must answer 401, got \${noTenant.status}\`);
}

export async function check_validate_body(ctx) {
  const c = api(ctx);
  const cases: [Record<string, unknown>, number, string][] = [
    [{...GOOD, doc_id: 'Bad ID!'}, 400, 'a doc_id with spaces and capitals'],
    [{...GOOD, doc_id: 'ab'}, 400, 'a two-character doc_id'],
    [{...GOOD, content_type: 'image/png'}, 400, 'content_type image/png'],
    [{...GOOD, version: 0}, 400, 'version 0'],
    [{...GOOD, content: 'a'.repeat((1 << 20) + 1)}, 413, 'content of 1 MiB + 1 byte'],
  ];
  for (const [body, status, what] of cases) {
    const r = await post(c, body);
    assert.equal(r.status, status, \`\${what} answered \${r.status}, expected \${status}\`);
  }
  assert.deepEqual(ctx.redis.keys('rag:*'), [], \`rejected uploads must store nothing, Redis holds \${JSON.stringify(ctx.redis.keys('rag:*').sort())}\`);
  const max = await post(c, {...GOOD, content: 'a'.repeat(1 << 20)});
  assert.equal(max.status, 202, \`exactly 1 MiB is within the limit, got \${max.status}\`);
}

export async function check_version_conflict(ctx) {
  const c = api(ctx);
  const first = await post(c, GOOD);
  assert.equal(first.status, 202, \`the first upload answered \${first.status}: \${first.text}\`);
  const job = first.json().job_id;
  const retry = await post(c, GOOD);
  assert(retry.status === 202 && retry.json().job_id === job, \`the same upload again is a retry: 202 with job \${job}, got \${retry.status} \${retry.text}\`);
  assert.equal(outbox(ctx).length, 1, \`a retry must not add an outbox row: rag:outbox holds \${outbox(ctx).length}\`);
  const v2 = await post(c, {...GOOD, version: 2, content: 'Refunds are accepted within 45 days.'});
  assert(v2.status === 202 && v2.json().job_id && v2.json().job_id !== job, \`version 2 is a new document version with its own job, got \${v2.status} \${v2.text}\`);
  const rewrite = await post(c, {...GOOD, content: 'Refunds are never accepted.'});
  assert.equal(rewrite.status, 409, \`version 1 with other content answered \${rewrite.status}: a stored version is immutable, so another hash is a 409, not a retry\`);
  const stored = ctx.redis.hgetall(DOC);
  assert(stored.sha256 === sha(GOOD.content) && stored.content === GOOD.content, \`the 409 must leave version 1 as it was, found \${JSON.stringify(stored)}\`);
  assert.equal(outbox(ctx).length, 2, \`two versions, two outbox rows; rag:outbox holds \${outbox(ctx).length}\`);
}

export async function check_outbox_tx(ctx) {
  const snapshot = () => ({doc: ctx.redis.exists(DOC), outbox: ctx.redis.llen('rag:outbox')});
  const armed: {fired: boolean; result: unknown}[] = [];
  const probe = ctx.redisAfter(DOC, () => {
    const seen = snapshot();
    if (seen.doc) return seen;
    armed.push(ctx.redisAfter(DOC, snapshot)); // the lookup came first: watch the write
    return null;
  });
  const r = await post(api(ctx), GOOD);
  assert.equal(r.status, 202, \`a valid upload answered \${r.status}: \${r.text}\`);
  const seen = (probe.result ?? (armed[0]?.fired ? armed[0].result : null)) as {doc: number; outbox: number} | null;
  assert(seen !== null && seen.doc, 'the document was never written');
  assert.equal(seen.outbox, 1, \`when the document became visible rag:outbox held \${seen.outbox} rows: a crash right there leaves a document no worker hears about; write both in one MULTI/EXEC\`);
  const rows = outbox(ctx);
  assert(rows.length === 1 && rows[0].job_id === ctx.redis.hget(DOC, 'job_id'), \`the outbox row must name the stored job: \${JSON.stringify(rows)}\`);
}

export async function check_event_ids_only(ctx) {
  const r = await post(api(ctx), GOOD);
  assert.equal(r.status, 202, \`a valid upload answered \${r.status}: \${r.text}\`);
  const rows = outbox(ctx);
  assert.equal(rows.length, 1, \`one upload, one outbox row: found \${rows.length}\`);
  assert(!('content' in rows[0]), \`the event carries the document text: \${JSON.stringify(Object.keys(rows[0]).sort())}; ids and the hash only, the worker reads the content from the store\`);
  const expected = {tenant: 't1', doc_id: 'handbook-2026', version: 1, job_id: r.json().job_id, sha256: sha(GOOD.content)};
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(rows[0][key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${JSON.stringify(rows[0])}\`);
}
`,
    go: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"leetbuild/harness"
)

const ingestDoc = "rag:doc:t1:handbook-2026:1"

var ingestGood = map[string]any{"doc_id": "handbook-2026", "version": 1, "content_type": "text/markdown", "content": "# Refunds\\nRefunds are accepted within 30 days."}

func ingestClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func ingestWith(field string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range ingestGood {
		out[k] = v
	}
	out[field] = value
	return out
}

func ingestPost(c *harness.HTTP, body map[string]any) *harness.Response {
	return c.Post("/v1/documents", body, "X-Tenant-Id", "t1")
}

func ingestJob(r *harness.Response) string {
	body, _ := r.JSON().(map[string]any)
	job, _ := body["job_id"].(string)
	return job
}

func ingestOutbox(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, row := range ctx.Redis.LRange("rag:outbox", 0, -1) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(row), &e), "an outbox row is JSON: %s", row)
		out = append(out, e)
	}
	return out
}

func ingestSHA(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func CheckRoute(ctx *harness.Ctx) {
	c := ingestClient(ctx)
	r := ingestPost(c, ingestGood)
	ctx.Equal(r.Status, 202, "a valid upload (%s)", r.Text())
	job := ingestJob(r)
	ctx.Assert(job != "", "the 202 body must carry the job_id: %s", r.Text())
	stored := ctx.Redis.HGetAll(ingestDoc)
	ctx.Assert(stored["job_id"] == job && stored["content"] == ingestGood["content"], "the version must be stored at %s with its job_id and content, found %v", ingestDoc, stored)
	ctx.Equal(len(ingestOutbox(ctx)), 1, "one upload, one outbox row; rows in rag:outbox")
	noTenant := c.Post("/v1/documents", ingestGood)
	ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the upload")
}

func CheckValidateBody(ctx *harness.Ctx) {
	c := ingestClient(ctx)
	cases := []struct {
		field  string
		value  any
		status int
		what   string
	}{
		{"doc_id", "Bad ID!", 400, "a doc_id with spaces and capitals"},
		{"doc_id", "ab", 400, "a two-character doc_id"},
		{"content_type", "image/png", 400, "content_type image/png"},
		{"version", 0, 400, "version 0"},
		{"content", strings.Repeat("a", 1<<20+1), 413, "content of 1 MiB + 1 byte"},
	}
	for _, tc := range cases {
		r := ingestPost(c, ingestWith(tc.field, tc.value))
		ctx.Equal(r.Status, tc.status, "%s", tc.what)
	}
	ctx.Equal(len(ctx.Redis.Keys("rag:*")), 0, "rejected uploads must store nothing; keys in Redis")
	r := ingestPost(c, ingestWith("content", strings.Repeat("a", 1<<20)))
	ctx.Equal(r.Status, 202, "exactly 1 MiB is within the limit")
}

func CheckVersionConflict(ctx *harness.Ctx) {
	c := ingestClient(ctx)
	first := ingestPost(c, ingestGood)
	ctx.Equal(first.Status, 202, "the first upload (%s)", first.Text())
	job := ingestJob(first)
	retry := ingestPost(c, ingestGood)
	ctx.Assert(retry.Status == 202 && ingestJob(retry) == job, "the same upload again is a retry: 202 with job %s, got %d %s", job, retry.Status, retry.Text())
	ctx.Equal(len(ingestOutbox(ctx)), 1, "a retry must not add an outbox row; rows")
	v2 := ingestPost(c, ingestWith("version", 2))
	ctx.Assert(v2.Status == 202 && ingestJob(v2) != "" && ingestJob(v2) != job, "version 2 is a new document version with its own job, got %d %s", v2.Status, v2.Text())
	rewrite := ingestPost(c, ingestWith("content", "Refunds are never accepted."))
	ctx.Equal(rewrite.Status, 409, "version 1 with other content: a stored version is immutable, so another hash is a 409, not a retry")
	stored := ctx.Redis.HGetAll(ingestDoc)
	ctx.Assert(stored["sha256"] == ingestSHA(ingestGood["content"].(string)) && stored["content"] == ingestGood["content"], "the 409 must leave version 1 as it was, found %v", stored)
	ctx.Equal(len(ingestOutbox(ctx)), 2, "two versions, two outbox rows; rows")
}

func CheckOutboxTx(ctx *harness.Ctx) {
	var seen map[string]int64
	snapshot := func() any {
		seen = map[string]int64{"doc": ctx.Redis.Exists(ingestDoc), "outbox": ctx.Redis.LLen("rag:outbox")}
		return nil
	}
	ctx.Redis.After(ingestDoc, func() any {
		snapshot()
		if seen["doc"] == 0 {
			seen = nil
			ctx.Redis.After(ingestDoc, snapshot) // the lookup came first: watch the write
		}
		return nil
	})
	r := ingestPost(ingestClient(ctx), ingestGood)
	ctx.Equal(r.Status, 202, "a valid upload (%s)", r.Text())
	ctx.Assert(seen != nil && seen["doc"] == 1, "the document was never written")
	ctx.Equal(seen["outbox"], int64(1), "when the document became visible, the rows in rag:outbox (a crash right there leaves a document no worker hears about; write both in one MULTI/EXEC)")
	rows := ingestOutbox(ctx)
	job, _ := ctx.Redis.HGet(ingestDoc, "job_id")
	ctx.Assert(len(rows) == 1 && rows[0]["job_id"] == job, "the outbox row must name the stored job: %v", rows)
}

func CheckEventIdsOnly(ctx *harness.Ctx) {
	r := ingestPost(ingestClient(ctx), ingestGood)
	ctx.Equal(r.Status, 202, "a valid upload (%s)", r.Text())
	rows := ingestOutbox(ctx)
	ctx.Equal(len(rows), 1, "one upload, one outbox row; rows")
	_, has := rows[0]["content"]
	ctx.Assert(!has, "the event carries the document text; ids and the hash only, the worker reads the content from the store")
	expected := map[string]any{"tenant": "t1", "doc_id": "handbook-2026", "version": float64(1), "job_id": ingestJob(r), "sha256": ingestSHA(ingestGood["content"].(string))}
	for key, value := range expected {
		ctx.Equal(rows[0][key], value, "the event's %s (event %v)", key, rows[0])
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const std::string kDoc = "rag:doc:t1:handbook-2026:1";
const json kGood = {{"doc_id", "handbook-2026"}, {"version", 1}, {"content_type", "text/markdown"}, {"content", "# Refunds\\nRefunds are accepted within 30 days."}};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }
  harness::Response post(const json& body) { return http.Post("/v1/documents", body.dump(), "X-Tenant-Id", "t1"); }
};

json with(json body, const std::string& field, const json& value) {
  body[field] = value;
  return body;
}

std::string jobOf(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() && body.contains("job_id") && body["job_id"].is_string() ? body["job_id"].get<std::string>() : "";
}

std::vector<json> outboxRows(harness::Ctx& ctx) {
  std::vector<json> out;
  for (const auto& row : ctx.Redis.LRange("rag:outbox", 0, -1)) out.push_back(json::parse(row, nullptr, false));
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 202, "a valid upload (%s)", r.Text());
  const std::string job = jobOf(r);
  ctx.Assert(!job.empty(), "the 202 body must carry the job_id: %s", r.Text());
  auto stored = ctx.Redis.HGetAll(kDoc);
  ctx.Assert(stored["job_id"] == job && stored["content"] == kGood["content"].get<std::string>(), "the version must be stored at %s with its job_id and content, found %v", kDoc, stored);
  ctx.Equal(outboxRows(ctx).size(), 1, "one upload, one outbox row; rows in rag:outbox");
  const auto noTenant = api.http.Post("/v1/documents", kGood.dump());
  ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the upload");
}

void CheckValidateBody(harness::Ctx& ctx) {
  Api api(ctx);
  struct Case {
    std::string field;
    json value;
    int status;
    std::string what;
  };
  const std::vector<Case> cases = {
      {"doc_id", "Bad ID!", 400, "a doc_id with spaces and capitals"},
      {"doc_id", "ab", 400, "a two-character doc_id"},
      {"content_type", "image/png", 400, "content_type image/png"},
      {"version", 0, 400, "version 0"},
      {"content", std::string((1 << 20) + 1, 'a'), 413, "content of 1 MiB + 1 byte"},
  };
  for (const auto& c : cases) ctx.Equal(api.post(with(kGood, c.field, c.value)).Status, c.status, "%s", c.what);
  ctx.Equal(ctx.Redis.Keys("rag:*").size(), 0, "rejected uploads must store nothing; keys in Redis");
  ctx.Equal(api.post(with(kGood, "content", std::string(1 << 20, 'a'))).Status, 202, "exactly 1 MiB is within the limit");
}

void CheckVersionConflict(harness::Ctx& ctx) {
  Api api(ctx);
  const auto first = api.post(kGood);
  ctx.Equal(first.Status, 202, "the first upload (%s)", first.Text());
  const std::string job = jobOf(first);
  const auto retry = api.post(kGood);
  ctx.Assert(retry.Status == 202 && jobOf(retry) == job, "the same upload again is a retry: 202 with job %s, got %d %s", job, retry.Status, retry.Text());
  ctx.Equal(outboxRows(ctx).size(), 1, "a retry must not add an outbox row; rows");
  const auto v2 = api.post(with(kGood, "version", 2));
  ctx.Assert(v2.Status == 202 && !jobOf(v2).empty() && jobOf(v2) != job, "version 2 is a new document version with its own job, got %d %s", v2.Status, v2.Text());
  const auto rewrite = api.post(with(kGood, "content", "Refunds are never accepted."));
  ctx.Equal(rewrite.Status, 409, "version 1 with other content: a stored version is immutable, so another hash is a 409, not a retry");
  auto stored = ctx.Redis.HGetAll(kDoc);
  const std::string content = kGood["content"];
  ctx.Assert(stored["sha256"] == sha256_hex(content) && stored["content"] == content, "the 409 must leave version 1 as it was, found %v", stored);
  ctx.Equal(outboxRows(ctx).size(), 2, "two versions, two outbox rows; rows");
}

void CheckOutboxTx(harness::Ctx& ctx) {
  Api api(ctx);
  bool written = false;
  long long outbox = -1;
  ctx.Redis.After(kDoc, [&] {
    if (ctx.Redis.Exists(kDoc) == 1) {
      written = true;
      outbox = ctx.Redis.LLen("rag:outbox");
      return;
    }
    ctx.Redis.After(kDoc, [&] {  // the lookup came first: watch the write
      written = ctx.Redis.Exists(kDoc) == 1;
      outbox = ctx.Redis.LLen("rag:outbox");
    });
  });
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 202, "a valid upload (%s)", r.Text());
  ctx.Assert(written, "the document was never written");
  ctx.Equal(outbox, 1, "when the document became visible, the rows in rag:outbox (a crash right there leaves a document no worker hears about; write both in one MULTI/EXEC)");
  const auto rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 1 && rows[0].value("job_id", "") == ctx.Redis.HGet(kDoc, "job_id").value_or("?"), "the outbox row must name the stored job: %v", rows);
}

void CheckEventIdsOnly(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 202, "a valid upload (%s)", r.Text());
  const auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "one upload, one outbox row; rows");
  ctx.Assert(!rows[0].contains("content"), "the event carries the document text; ids and the hash only, the worker reads the content from the store");
  const json expected = {{"tenant", "t1"}, {"doc_id", "handbook-2026"}, {"version", 1}, {"job_id", jobOf(r)}, {"sha256", sha256_hex(kGood["content"].get<std::string>())}};
  for (const auto& [key, value] : expected.items()) ctx.Equal(rows[0].value(key, json()), value, "the event's %s (event %v)", key, rows[0]);
}
`,
  },
  hints: [
    'Symptom: a client re-uploads version 3 with corrected text, gets 202 with the old job, and answers keep quoting the old text. A 50 MiB upload is accepted, and a crash mid-request leaves a document with no event.',
    'Mechanism: any stored row for the version is treated as a retry, hash unseen; nothing is validated before the write; HSET and RPUSH are two round trips; and the event copies `content` from the request.',
    'Change: guard clauses (doc_id pattern, `ALLOWED_TYPES`, version, `MAX_BODY_BYTES` → 413); `409` when `stored["sha256"] != digest`; an event of ids plus `sha256`; HSET and RPUSH queued on one `pipeline(transaction=True)`.',
  ],
  debrief: `The version is the unit of idempotency because a document changes and its history must not: the hash is what tells a retry from an edit, and only a retry may be answered with the old job. Writing the document and its event in one MULTI/EXEC is the outbox pattern on Redis: both exist or neither does, and the relay publishes from the list, so no request waits on a broker. The event carries ids and the hash because the text is already stored and a topic is the wrong place for megabytes. Production adds a conditional write (HSETNX or WATCH) for two first uploads that race, a size limit enforced while the body is read, and per-tenant ingest quotas.`,
};
