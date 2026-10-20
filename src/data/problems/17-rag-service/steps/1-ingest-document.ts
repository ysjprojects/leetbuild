import type {Step} from '@/lib/types';

export const ingestDocumentStep: Step = {
  id: 'ingest-document',
  title: 'POST /v1/documents: idempotent ingest, durable outbox',
  concept: 'http',
  file: 'ingest_api',
  focus: ['client', 'api', 'db', 'kafka'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it compiles and passes the
happy path, so a quick demo makes it look done. Review it like the service owner. Find the subtle
flaw, fix it, and prove the fix with the checks below.

Implement \`POST /v1/documents\` with body
\`{"doc_id": "…", "version": 3, "content_type": "text/markdown", "content": "…"}\`. The tenant comes
from the authenticated \`X-Tenant-Id\` header and must never be taken from the body.

- \`doc_id\` matches \`^[a-z0-9][a-z0-9_-]{2,63}$\`, \`version\` is an integer \`>= 1\`, and
  \`content_type\` is one of \`text/plain\`, \`text/markdown\`, \`application/pdf\`; otherwise **400**.
- The UTF-8 content must be at most **1 MiB** (\`1 << 20\`); otherwise **413**.
- Compute SHA-256 over the raw content bytes.
- Idempotency is keyed by \`(tenant, doc_id, version, sha256)\`: a retry of the exact same upload
  returns **202** with the **existing** job id. The same \`version\` with a different hash is a
  **409** — the caller is trying to replace immutable history.
- Insert the document row and an **outbox** row in **one transaction**. Only after that transaction
  commits may a \`doc.ingest\` event be published. The request never chunks or embeds inline.

**Failure mode the checks target.** Keying idempotency by \`doc_id\` alone means a new version is
mistaken for a retry, and a changed payload for the same version is silently accepted. Publishing
before the commit means the consumer can read a document that the database later rolled back.

:::widget status-codes {}

> The outbox row is what makes "publish after commit" recoverable: if the broker is down after the
> commit, a relay can publish the row later. A produce inside the transaction cannot be rolled back.`,
  sequence: {
    participants: ['Client', 'RAG API', 'documents · outbox', 'doc.ingest'],
    messages: [
      {from: 'Client', to: 'RAG API', label: 'POST /v1/documents + X-Tenant-Id', kind: 'sync'},
      {from: 'RAG API', to: 'RAG API', label: 'validate · sha256(content)', kind: 'sync'},
      {from: 'RAG API', to: 'documents · outbox', label: 'get_version(tenant, doc_id, version)', kind: 'sync'},
      {from: 'documents · outbox', to: 'RAG API', label: 'none / existing hash', kind: 'reply'},
      {from: 'RAG API', to: 'documents · outbox', label: 'insert document + outbox · COMMIT', kind: 'sync'},
      {from: 'RAG API', to: 'doc.ingest', label: 'produce {job_id, sha256}', kind: 'async'},
      {from: 'RAG API', to: 'Client', label: '202 {job_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/documents',
      detail: 'Register the ingestion route on `POST /v1/documents`.',
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
      title: 'Validates doc id, type and 1 MiB body',
      detail:
        'Reject an invalid `doc_id`, an unsupported `content_type` or `version < 1` with **400**, and a body over `1 << 20` bytes with **413**. The draft skips all three.',
      match: {
        python: {
          all: [/ALLOWED_TYPES/, /MAX_BODY_BYTES|1\s*<<\s*20|1048576/, /status_code\s*=\s*413|status_code\s*=\s*400/],
        },
        typescript: {
          all: [
            /(ALLOWED_TYPES|allowedTypes)/,
            /(MAX_BODY_BYTES|maxBodyBytes|1\s*<<\s*20|1048576)/,
            /(reply\.code\(\s*413\s*\)|reply\.code\(\s*400\s*\)|\b413\b|\b400\b)/,
          ],
        },
        go: {
          all: [
            /(allowedTypes|ALLOWED_TYPES)/,
            /(maxBodyBytes|1\s*<<\s*20|1048576)/,
            /(StatusRequestEntityTooLarge|StatusBadRequest|\b413\b|\b400\b)/,
          ],
        },
        scala: {
          all: [
            /(AllowedTypes|allowedTypes)/,
            /(MaxBodyBytes|1\s*<<\s*20|1048576)/,
            /(StatusCodes\.RequestEntityTooLarge|StatusCodes\.BadRequest|\b413\b|\b400\b)/,
          ],
        },
        cpp: {all: [/(kAllowedTypes|allowedTypes)/, /(kMaxBodyBytes|1\s*<<\s*20|1048576)/, /(413|\b400\b)/]},
      },
    },
    {
      id: 'version-conflict',
      title: 'Distinguishes a retry from a version conflict',
      detail:
        'Hash the content, read the stored row for `(tenant, doc_id, version)`, and answer **409** when the stored hash differs. Same hash returns **202** with the stored job id.',
      match: {
        python: {all: [/sha256/, /status_code\s*=\s*409/, /existing\.sha256\s*!=/]},
        typescript: {
          all: [/createHash\(\s*['"]sha256['"]\s*\)/, /reply\.code\(\s*409\s*\)|\b409\b/, /existing\.sha256\s*!==?/],
        },
        go: {all: [/sha256\.Sum256/, /http\.StatusConflict|\b409\b/, /existing\.SHA256\s*!=/]},
        scala: {all: [/(MessageDigest|SHA-256|sha256)/, /StatusCodes\.Conflict|\b409\b/, /existing\.sha256\s*!=/]},
        cpp: {all: [/(SHA256|sha256)/, /\b409\b/, /existing->sha256\s*!=/]},
      },
    },
    {
      id: 'outbox-tx',
      title: 'Writes the document and outbox in one transaction',
      detail:
        'The document insert and the outbox insert are inside a single transaction. One commit makes both visible; a crash leaves neither.',
      match: {
        python: {all: [/with store\.transaction/, /insert_outbox/]},
        typescript: {all: [/\.transaction\(/, /insertOutbox\(/]},
        go: {all: [/store\.Begin\(/, /InsertOutbox/]},
        scala: {all: [/store\.transaction/, /insertOutbox/]},
        cpp: {all: [/store\.begin\(/, /insertOutbox/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publishes doc.ingest only after the commit',
      detail:
        'The `doc.ingest` produce comes after the transaction commits. Producing first lets a consumer act on a document that never became durable.',
      match: {
        python: {order: [/with store\.transaction|store\.commit/, /producer\.send/]},
        typescript: {order: [/\.transaction\(|tx\.commit|COMMIT/, /producer\.send\(/]},
        go: {order: [/(store\.Begin|tx\.Commit)/, /producer\.WriteMessages/]},
        scala: {order: [/store\.transaction|tx\.commit/, /producer\.send/]},
        cpp: {order: [/(store\.begin|tx\.commit)/, /producer->produce/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import uuid

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
producer = Producer({"bootstrap.servers": "kafka:9092"})


class DocumentRequest(BaseModel):
    doc_id: str
    version: int
    content_type: str
    content: str


class Store:
    def find_by_doc(self, tenant: str, doc_id: str):
        raise NotImplementedError

    def insert_document(self, tenant: str, body: DocumentRequest, sha: str, job_id: str) -> None:
        raise NotImplementedError


store = Store()


@app.post("/v1/documents")
def ingest(body: DocumentRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft looks up idempotency by doc_id only, never validates the body,
    # and publishes before the write is durable. Review all three before trusting it.
    existing = store.find_by_doc(tenant, body.doc_id)
    if existing is not None:
        return JSONResponse({"job_id": existing.job_id}, status_code=202)

    digest = hashlib.sha256(body.content.encode("utf-8")).hexdigest()
    job_id = str(uuid.uuid4())
    producer.send(
        "doc.ingest",
        key=f"{tenant}:{body.doc_id}",
        value={"doc_id": body.doc_id, "version": body.version, "sha256": digest, "job_id": job_id},
    )
    producer.flush()
    store.insert_document(tenant, body, digest, job_id)
    return JSONResponse({"job_id": job_id}, status_code=202)
`,
      solution: `import hashlib
import re
import uuid

from confluent_kafka import Producer
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
producer = Producer({"bootstrap.servers": "kafka:9092"})
MAX_BODY_BYTES = 1 << 20
ALLOWED_TYPES = {"text/plain", "text/markdown", "application/pdf"}
DOC_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")


class DocumentRequest(BaseModel):
    doc_id: str
    version: int
    content_type: str
    content: str


class Store:
    def transaction(self):
        """A transaction exposing get_version, insert_document and insert_outbox."""
        raise NotImplementedError


store = Store()


@app.post("/v1/documents")
def ingest(body: DocumentRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    if not DOC_ID_RE.fullmatch(body.doc_id):
        raise HTTPException(status_code=400, detail="doc_id must be 3-64 chars of [a-z0-9_-]")
    if body.version < 1:
        raise HTTPException(status_code=400, detail="version must be >= 1")
    if body.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="unsupported content_type")
    raw = body.content.encode("utf-8")
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="document exceeds 1 MiB")
    digest = hashlib.sha256(raw).hexdigest()
    job_id = str(uuid.uuid4())

    with store.transaction() as tx:
        existing = tx.get_version(tenant, body.doc_id, body.version)
        if existing is not None:
            if existing.sha256 != digest:
                raise HTTPException(status_code=409, detail="version already exists with different content")
            return JSONResponse({"job_id": existing.job_id}, status_code=202)
        tx.insert_document(tenant, body.doc_id, body.version, body.content_type, body.content, digest, job_id)
        tx.insert_outbox(tenant, body.doc_id, body.version, digest, job_id)

    producer.send(
        "doc.ingest",
        key=f"{tenant}:{body.doc_id}",
        value={"doc_id": body.doc_id, "version": body.version, "sha256": digest, "job_id": job_id},
    )
    producer.flush()
    return JSONResponse({"job_id": job_id}, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/documents: a model-generated draft that only exercises the first upload. */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'rag-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface DocumentBody {
  doc_id: string;
  version: number;
  content_type: string;
  content: string;
}

app.post('/v1/documents', async (request, reply) => {
  // TODO: this draft looks up idempotency by doc_id only, never validates the body,
  // and publishes before the write is durable. Review all three before trusting it.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as DocumentBody;

  const existing = await store.findByDoc(tenant, body.doc_id);
  if (existing !== null) return reply.code(202).send({job_id: existing.job_id});

  const sha256 = createHash('sha256').update(body.content, 'utf8').digest('hex');
  const jobId = randomUUID();
  await producer.send({
    topic: 'doc.ingest',
    messages: [
      {
        key: \`\${tenant}:\${body.doc_id}\`,
        value: JSON.stringify({doc_id: body.doc_id, version: body.version, sha256, job_id: jobId}),
      },
    ],
  });
  await store.insertDocument(tenant, body, sha256, jobId);
  return reply.code(202).send({job_id: jobId});
});

void app.listen({port: 8080, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/documents: authenticate the tenant, validate, hash, and write document + outbox in one transaction. */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {db} from './db';

export const app = Fastify();
const kafka = new Kafka({clientId: 'rag-api', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const MAX_BODY_BYTES = 1 << 20;
const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const ALLOWED_TYPES: Record<string, true> = {
  'text/plain': true,
  'text/markdown': true,
  'application/pdf': true,
};

interface DocumentBody {
  doc_id: string;
  version: number;
  content_type: string;
  content: string;
}

interface StoredDocument {
  job_id: string;
  sha256: string;
}

app.post('/v1/documents', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const body = request.body as Partial<DocumentBody> | null;
  if (typeof tenant !== 'string' || tenant === '') return reply.code(400).send({error: 'missing X-Tenant-Id'});
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid body'});
  const {doc_id, version, content_type, content} = body;
  if (typeof doc_id !== 'string' || !DOC_ID_RE.test(doc_id))
    return reply.code(400).send({error: 'doc_id must be 3-64 chars of [a-z0-9_-]'});
  if (!Number.isInteger(version) || (version as number) < 1)
    return reply.code(400).send({error: 'version must be >= 1'});
  if (typeof content_type !== 'string' || ALLOWED_TYPES[content_type] !== true)
    return reply.code(400).send({error: 'unsupported content_type'});
  if (typeof content !== 'string') return reply.code(400).send({error: 'content must be text'});
  const raw = Buffer.from(content, 'utf8');
  if (raw.byteLength > MAX_BODY_BYTES) return reply.code(413).send({error: 'document exceeds 1 MiB'});

  const sha256 = createHash('sha256').update(raw).digest('hex');
  const jobId = randomUUID();
  const outcome = await db.transaction(async tx => {
    const existing: StoredDocument | null = await tx.getVersion(tenant, doc_id, version as number);
    if (existing !== null) {
      if (existing.sha256 !== sha256) return {status: 409, jobId: ''};
      return {status: 202, jobId: existing.job_id};
    }
    await tx.insertDocument({tenant, doc_id, version: version as number, content_type, content, sha256, job_id: jobId});
    await tx.insertOutbox({tenant, doc_id, version: version as number, sha256, job_id: jobId});
    return {status: 202, jobId};
  });
  if (outcome.status === 409) return reply.code(409).send({error: 'version already exists with different content'});
  if (outcome.jobId !== jobId) return reply.code(202).send({job_id: outcome.jobId});

  await producer.send({
    topic: 'doc.ingest',
    messages: [{key: \`\${tenant}:\${doc_id}\`, value: JSON.stringify({doc_id, version, sha256, job_id: jobId})}],
  });
  return reply.code(202).send({job_id: jobId});
});

void app.listen({port: 8080, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

type DocumentRequest struct {
	DocID       string \`json:"doc_id"\`
	Version     int    \`json:"version"\`
	ContentType string \`json:"content_type"\`
	Content     string \`json:"content"\`
}

type Job struct {
	JobID  string
	SHA256 string
}

type Store struct{}

func (s *Store) FindByDoc(ctx context.Context, tenant, docID string) (*Job, error) {
	return nil, nil
}

func (s *Store) InsertDocument(ctx context.Context, tenant string, body DocumentRequest, sha, jobID string) error {
	return nil
}

var store = &Store{}
var producer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "doc.ingest"}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body DocumentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: idempotency ignores version and hash, nothing is validated, and this produce
	// can land before the row exists. The retry path is not safe.
	existing, _ := store.FindByDoc(r.Context(), tenant, body.DocID)
	if existing != nil {
		writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": existing.JobID})
		return
	}
	sum := sha256.Sum256([]byte(body.Content))
	jobID := uuid.NewString()
	payload, _ := json.Marshal(map[string]string{"doc_id": body.DocID, "job_id": jobID})
	producer.WriteMessages(r.Context(), kafka.Message{
		Key:   []byte(tenant + ":" + body.DocID),
		Value: payload,
	})
	_ = store.InsertDocument(r.Context(), tenant, body, hex.EncodeToString(sum[:]), jobID)
	writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": jobID})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/documents", ingest)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"regexp"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

const maxBodyBytes = 1 << 20

var (
	docIDRe      = regexp.MustCompile(\`^[a-z0-9][a-z0-9_-]{2,63}$\`)
	allowedTypes = map[string]bool{"text/plain": true, "text/markdown": true, "application/pdf": true}
)

type DocumentRequest struct {
	DocID       string \`json:"doc_id"\`
	Version     int    \`json:"version"\`
	ContentType string \`json:"content_type"\`
	Content     string \`json:"content"\`
}

type Job struct {
	JobID  string
	SHA256 string
}

type Tx interface {
	GetVersion(ctx context.Context, tenant, docID string, version int) (*Job, error)
	InsertDocument(ctx context.Context, tenant string, body DocumentRequest, sha, jobID string) error
	InsertOutbox(ctx context.Context, tenant, docID string, version int, sha, jobID string) error
	Commit(ctx context.Context) error
	Rollback(ctx context.Context)
}

type Store struct{}

func (s *Store) Begin(ctx context.Context) (Tx, error) {
	return nil, nil
}

var store = &Store{}
var producer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "doc.ingest"}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body DocumentRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !docIDRe.MatchString(body.DocID) || body.Version < 1 || !allowedTypes[body.ContentType] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid document"})
		return
	}
	if len([]byte(body.Content)) > maxBodyBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "document exceeds 1 MiB"})
		return
	}
	digest := hex.EncodeToString(sha256Sum(body.Content))
	jobID := uuid.NewString()
	ctx := r.Context()

	tx, err := store.Begin(ctx)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	defer tx.Rollback(ctx)
	existing, err := tx.GetVersion(ctx, tenant, body.DocID, body.Version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		if existing.SHA256 != digest {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": "version already exists with different content"})
			return
		}
		writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": existing.JobID})
		return
	}
	if err := tx.InsertDocument(ctx, tenant, body, digest, jobID); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := tx.InsertOutbox(ctx, tenant, body.DocID, body.Version, digest, jobID); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	payload, _ := json.Marshal(map[string]any{"doc_id": body.DocID, "version": body.Version, "sha256": digest, "job_id": jobID})
	if err := producer.WriteMessages(ctx, kafka.Message{Key: []byte(tenant + ":" + body.DocID), Value: payload}); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "ACCEPTED_NOT_PUBLISHED"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]string{"job_id": jobID})
}

func sha256Sum(content string) []byte {
	sum := sha256.Sum256([]byte(content))
	return sum[:]
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/documents", ingest)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class DocumentRequest(docId: String, version: Int, contentType: String, content: String)
final case class Job(jobId: String, sha256: String)

object IngestApi {
  implicit val documentFormat: RootJsonFormat[DocumentRequest] = jsonFormat4(DocumentRequest)

  val store = DocumentStore.open()
  val producer = new KafkaProducer[String, String](KafkaConfig.producer())

  val route: Route =
    path("v1" / "documents") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[DocumentRequest]) { body =>
            // TODO: keyed by doc only, no validation, produce before insert. A retry can
            // double-publish and a rolled-back document can still be ingested.
            store.findById(tenant, body.docId) match {
              case Some(existing) =>
                complete(StatusCodes.Accepted, s"""{"job_id":"$existing.jobId"}""")
              case None =>
                val jobId = UUID.randomUUID().toString
                val digest = sha256(body.content)
                producer.send(new ProducerRecord("doc.ingest", tenant + ":" + body.docId, s"""{"job_id":"$jobId"}"""))
                store.insertDocument(tenant, body, digest, jobId)
                complete(StatusCodes.Accepted, s"""{"job_id":"$jobId"}""")
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("ragd")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class DocumentRequest(docId: String, version: Int, contentType: String, content: String)
final case class Job(jobId: String, sha256: String)
final case class IngestResult(jobId: String, created: Boolean)

object IngestApi {
  implicit val documentFormat: RootJsonFormat[DocumentRequest] = jsonFormat4(DocumentRequest)

  val AllowedTypes = Set("text/plain", "text/markdown", "application/pdf")
  val MaxBodyBytes = 1 << 20
  val DocId = "^[a-z0-9][a-z0-9_-]{2,63}$".r
  val store = DocumentStore.open()
  val producer = new KafkaProducer[String, String](KafkaConfig.producer())

  def sha256(text: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))
    digest.map("%02x".format(_)).mkString
  }

  val route: Route =
    path("v1" / "documents") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[DocumentRequest]) { body =>
            if (!DocId.matches(body.docId) || body.version < 1 || !AllowedTypes.contains(body.contentType)) {
              complete(StatusCodes.BadRequest, """{"error":"invalid document"}""")
            } else if (body.content.getBytes(StandardCharsets.UTF_8).length > MaxBodyBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"document exceeds 1 MiB"}""")
            } else {
              val digest = sha256(body.content)
              val jobId = UUID.randomUUID().toString
              val result = store.transaction { tx =>
                tx.getVersion(tenant, body.docId, body.version) match {
                  case Some(existing) if existing.sha256 != digest =>
                    tx.rollback()
                    None
                  case Some(existing) =>
                    Some(IngestResult(existing.jobId, created = false))
                  case None =>
                    tx.insertDocument(tenant, body, digest, jobId)
                    tx.insertOutbox(tenant, body.docId, body.version, digest, jobId)
                    Some(IngestResult(jobId, created = true))
                }
              }
              result match {
                case None =>
                  complete(StatusCodes.Conflict, """{"error":"version already exists with different content"}""")
                case Some(done) =>
                  if (done.created) {
                    producer.send(new ProducerRecord("doc.ingest", tenant + ":" + body.docId, s"""{"job_id":"\${done.jobId}"}"""))
                  }
                  complete(StatusCodes.Accepted, s"""{"job_id":"\${done.jobId}"}""")
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("ragd")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <librdkafka/rdkafkacpp.h>
#include <httplib.h>

#include <memory>
#include <optional>
#include <string>

using json = nlohmann::json;

struct Job {
  std::string jobId;
  std::string sha256;
};

struct Store {
  std::optional<Job> findByDoc(const std::string& tenant, const std::string& docId);
  void insertDocument(const std::string& tenant, const json& body, const std::string& sha, const std::string& jobId);
};

Store store;
std::unique_ptr<RdKafka::Producer> producer;
std::string uuidString();

int main() {
  httplib::Server svr;
  svr.Post("/v1/documents", [&](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto body = json::parse(req.body);
    const auto docId = body.value("doc_id", std::string());
    // TODO: lookup by doc only, no validation, publish before insert. A retry can
    // double-publish and a rolled-back document can still be ingested.
    const auto existing = store.findByDoc(tenant, docId);
    if (existing) {
      res.status = 202;
      res.set_content(json{{"job_id", existing->jobId}}.dump(), "application/json");
      return;
    }
    const auto digest = sha256(body.value("content", std::string()));
    const auto jobId = uuidString();
    const auto payload = json{{"doc_id", docId}, {"job_id", jobId}}.dump();
    producer->produce("doc.ingest", tenant + ":" + docId, payload);
    store.insertDocument(tenant, body, digest, jobId);
    res.status = 202;
    res.set_content(json{{"job_id", jobId}}.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <librdkafka/rdkafkacpp.h>
#include <httplib.h>

#include <memory>
#include <regex>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxBodyBytes = 1 << 20;
const std::set<std::string> kAllowedTypes = {"text/plain", "text/markdown", "application/pdf"};
const std::regex kDocId("^[a-z0-9][a-z0-9_-]{2,63}$");

struct Job {
  std::string jobId;
  std::string sha256;
};

struct Tx {
  virtual ~Tx() = default;
  virtual std::optional<Job> getVersion(const std::string& tenant, const std::string& docId, int version) = 0;
  virtual void insertDocument(const std::string& tenant, const json& body, const std::string& sha, const std::string& jobId) = 0;
  virtual void insertOutbox(const std::string& tenant, const std::string& docId, int version, const std::string& sha, const std::string& jobId) = 0;
  virtual void commit() = 0;
  virtual void rollback() = 0;
};

struct Store {
  std::unique_ptr<Tx> begin();
};

Store store;
std::unique_ptr<RdKafka::Producer> producer;
std::string uuidString();

int main() {
  httplib::Server svr;
  svr.Post("/v1/documents", [&](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body;
    try {
      body = json::parse(req.body);
    } catch (const std::exception&) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto docId = body.value("doc_id", std::string());
    const int version = body.value("version", 0);
    const auto contentType = body.value("content_type", std::string());
    const auto content = body.value("content", std::string());
    if (!std::regex_match(docId, kDocId) || version < 1 || !kAllowedTypes.count(contentType)) {
      res.status = 400;
      res.set_content(R"({"error":"invalid document"})", "application/json");
      return;
    }
    if (content.size() > kMaxBodyBytes) {
      res.status = 413;
      res.set_content(R"({"error":"document exceeds 1 MiB"})", "application/json");
      return;
    }
    const auto digest = sha256(content);
    const auto jobId = uuidString();
    auto tx = store.begin();
    const auto existing = tx->getVersion(tenant, docId, version);
    if (existing && existing->sha256 != digest) {
      tx->rollback();
      res.status = 409;
      res.set_content(R"({"error":"version already exists with different content"})", "application/json");
      return;
    }
    if (existing) {
      tx->rollback();
      res.status = 202;
      res.set_content(json{{"job_id", existing->jobId}}.dump(), "application/json");
      return;
    }
    tx->insertDocument(tenant, body, digest, jobId);
    tx->insertOutbox(tenant, docId, version, digest, jobId);
    tx->commit();
    const auto payload = json{{"doc_id", docId}, {"version", version}, {"sha256", digest}, {"job_id", jobId}}.dump();
    producer->produce("doc.ingest", tenant + ":" + docId, payload);
    res.status = 202;
    res.set_content(json{{"job_id", jobId}}.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the four validations as one early-return block before any lookup: shape and type first, byte length next, hash last. The hash is the only expensive part.',
    'The lookup is inside the transaction and returns the stored hash. Compare hashes before comparing job ids: equal hash → 202 with the stored job id; different hash → 409.',
    'Commit the document and outbox writes as one transaction, then publish. If the produce fails, the outbox row remains for the relay; the document is still durable.',
  ],
  debrief: `The interviewer is testing whether you can review generated code at its durability boundary. The draft reads cleanly because the happy path only exercises the first upload: no lookup, no conflict, no broker failure. Three things are being checked here — an idempotency key that includes every part of the identity (tenant, doc, version, bytes), a validation funnel that rejects cheaply before hashing, and a transaction boundary that includes the outbox. The outbox is the interview signal: it shows you know a broker is not transactional with a database, and that "publish after commit" needs a durable row rather than hope. Real systems add a relay that marks outbox rows published, content-addressed storage for the bytes, and a unique constraint on \`(tenant, doc_id, version)\` so two concurrent retries races resolve in the database, not in application code.`,
};
