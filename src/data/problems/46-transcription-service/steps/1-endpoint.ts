import type {Step} from '@/lib/types';

export const transcriptionEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/transcriptions: hours of audio, one durable job',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db', 'storage'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the body and creates a job. It compiles, it serves the demo, and it hides three production flaws.
Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/transcriptions\` with body
\`{"audio_ref": "s3://bucket/talk.wav", "duration_seconds": 7200, "language": "en"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`audio_ref\` is a non-empty string (**400** otherwise).
- \`duration_seconds\` is an integer from **1** to **14400** (four hours) and anything else is
  **400**. The decision must be made from the metadata alone: a five-hour submission is rejected
  before a single byte of audio is fetched.
- \`language\` is one of \`en\`, \`es\`, \`fr\`, \`de\`, \`ja\` (**400** otherwise).
- \`Idempotency-Key\` is required (**400** when missing) and the job is keyed by the **audio hash**,
  \`sha256(audio_ref)\`: a replay of the same audio returns the running job instead of starting a
  second one.
- Only after the metadata validates may the service download the audio — the fetch call comes
  *after* the duration and language checks, never before.
- The response reports the job id, a \`queued\` status and the total chunk count derived from the
  duration at 30 seconds per chunk.

**Failure mode the checks target.** A model-generated handler downloads first and validates second,
so every bad request has already paid for the bytes; it accepts any duration, so a five-hour file
starts a job; and it keys nothing, so every client retry starts a second transcription. The fix is
an ordering contract: authenticate, validate the metadata, look up the audio hash, and only then
touch the audio store.`,
  sequence: {
    participants: ['Client', 'Transcription API', 'jobs store', 'audio store'],
    messages: [
      {
        from: 'Client',
        to: 'Transcription API',
        label: 'POST /v1/transcriptions · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {
        from: 'Transcription API',
        to: 'Transcription API',
        label: 'validate duration · language from metadata alone',
        kind: 'sync',
      },
      {from: 'Transcription API', to: 'jobs store', label: 'get(tenant, sha256(audio_ref))', kind: 'sync'},
      {from: 'jobs store', to: 'Transcription API', label: 'running job / none', kind: 'reply'},
      {from: 'Transcription API', to: 'audio store', label: 'fetch(audio_ref) — only after validation', kind: 'sync'},
      {from: 'audio store', to: 'Transcription API', label: 'audio bytes', kind: 'reply'},
      {from: 'Transcription API', to: 'jobs store', label: 'put(tenant, audio_hash, job)', kind: 'async'},
      {
        from: 'Transcription API',
        to: 'Client',
        label: '202 {job_id, status: queued, total_chunks}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/transcriptions',
      detail: 'Register the job-creation route on `POST /v1/transcriptions`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/transcriptions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/transcriptions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/transcriptions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"transcriptions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/transcriptions"/]},
      },
    },
    {
      id: 'duration-cap',
      title: 'Rejects a file over four hours from metadata alone',
      detail:
        '`duration_seconds` outside 1..14400 is **400**, decided before any audio is fetched. The draft accepts unbounded duration, so a five-hour file starts a job and pays for the download.',
      match: {
        python: {all: [/MAX_DURATION_SECONDS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_DURATION_SECONDS/, /code\(\s*400\s*\)/]},
        go: {all: [/maxDurationSeconds/, /StatusBadRequest/]},
        scala: {all: [/MaxDurationSeconds/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxDurationSeconds/, /\b400\b/]},
      },
    },
    {
      id: 'language-allowlist',
      title: 'Accepts only the allowlisted language hints',
      detail:
        '`language` is checked against an allowlist and anything else is **400**. The draft never looks at the hint, so a request with an unsupported language reaches the provider and is billed before it fails.',
      match: {
        python: {all: [/ALLOWED_LANGUAGES/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_LANGUAGES/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedLanguages/, /StatusBadRequest/]},
        scala: {all: [/AllowedLanguages/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedLanguages/, /\b400\b/]},
      },
    },
    {
      id: 'idempotent-by-hash',
      title: 'Keys the job by the audio hash so a retry resumes',
      detail:
        'The job is stored under `(tenant, sha256(audio_ref))`; a replay returns the stored running job instead of creating a second one. The draft creates a fresh job on every submit, so a client retry bills the same file twice.',
      match: {
        python: {all: [/audio_hash/, /sha256/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/audioHash/, /createHash\(\s*['"]sha256['"]\)/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/audioHash/, /sha256\.Sum256/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/audioHash/, /MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/audioHash/, /sha256/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'validate-before-fetch',
      title: 'Never downloads a byte before the metadata validates',
      detail:
        'The duration check runs before the audio is fetched: the `fetch_audio` call comes *after* the validation, so a rejected request never pays for the file. The draft downloads first, so every 400 has already downloaded two hours of audio.',
      match: {
        python: {order: [/MAX_DURATION_SECONDS/, /fetch_audio\(body\.audio_ref\)/]},
        typescript: {order: [/MAX_DURATION_SECONDS/, /fetchAudio\(body\.audio_ref\)/]},
        go: {order: [/maxDurationSeconds/, /fetchAudio\(body\.AudioRef\)/]},
        scala: {order: [/MaxDurationSeconds/, /fetchAudio\(body\.audio_ref\)/]},
        cpp: {order: [/kMaxDurationSeconds/, /fetchAudio\(audioRef\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class TranscribeRequest(BaseModel):
    audio_ref: str
    duration_seconds: int
    language: str = "en"


class JobStore:
    def get(self, tenant: str, audio_hash: str):
        """The job stored for (tenant, audio_hash), if any."""
        raise NotImplementedError

    def put(self, tenant: str, audio_hash: str, job: dict) -> None:
        """Store the job under (tenant, audio_hash)."""
        raise NotImplementedError


store = JobStore()


def fetch_audio(audio_ref: str) -> bytes:
    """Download the audio bytes. Only call after the metadata validates."""
    raise NotImplementedError


@app.post("/v1/transcriptions")
def create_transcription(body: TranscribeRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft accepts any duration, downloads the audio before validating it, starts a new
    # job on every submit, and never checks the language hint. Review all four.
    audio = fetch_audio(body.audio_ref)
    job = {"job_id": str(uuid.uuid4()), "bytes": len(audio)}
    return JSONResponse(job, status_code=201)
`,
      solution: `import hashlib
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

CHUNK_SECONDS = 30
MAX_DURATION_SECONDS = 4 * 60 * 60
ALLOWED_LANGUAGES = {"en", "es", "fr", "de", "ja"}


class TranscribeRequest(BaseModel):
    audio_ref: str
    duration_seconds: int
    language: str = "en"


class JobStore:
    def get(self, tenant: str, audio_hash: str) -> dict | None:
        """The job stored for (tenant, audio_hash), if any."""
        raise NotImplementedError

    def put(self, tenant: str, audio_hash: str, job: dict) -> None:
        """Store the job under (tenant, audio_hash)."""
        raise NotImplementedError


store = JobStore()


def fetch_audio(audio_ref: str) -> bytes:
    """Download the audio bytes. Only call after the metadata validates."""
    raise NotImplementedError


@app.post("/v1/transcriptions")
def create_transcription(
    body: TranscribeRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.audio_ref == "":
        raise HTTPException(status_code=400, detail="audio_ref is required")

    # Validate from metadata alone, before a single byte is downloaded.
    if not 1 <= body.duration_seconds <= MAX_DURATION_SECONDS:
        raise HTTPException(status_code=400, detail="audio exceeds four hours")
    if body.language not in ALLOWED_LANGUAGES:
        raise HTTPException(status_code=400, detail="unknown language")

    audio_hash = hashlib.sha256(body.audio_ref.encode("utf-8")).hexdigest()
    stored = store.get(tenant, audio_hash)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    # Only now is it safe to touch the audio bytes.
    _ = fetch_audio(body.audio_ref)

    total_chunks = (body.duration_seconds + CHUNK_SECONDS - 1) // CHUNK_SECONDS
    job = {
        "job_id": str(uuid.uuid4()),
        "status": "queued",
        "total_chunks": total_chunks,
        "language": body.language,
        "audio_hash": audio_hash,
    }
    store.put(tenant, audio_hash, job)
    return JSONResponse(job, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/transcriptions: a model-generated draft that downloads first and never dedupes. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface TranscribeBody {
  audio_ref: string;
  duration_seconds: number;
  language?: string;
}

const fetchAudio = async (_audioRef: string): Promise<Buffer> => Buffer.alloc(0);

app.post('/v1/transcriptions', async (request, reply) => {
  // TODO: this draft accepts any duration, downloads the audio before validating it, starts a new
  // job on every submit, and never checks the language hint. Review all four.
  const body = request.body as TranscribeBody;
  const audio = await fetchAudio(body.audio_ref);
  return reply.code(201).send({job_id: randomUUID(), bytes: audio.byteLength});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/transcriptions: validate from metadata, then key the job by the audio hash. */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const CHUNK_SECONDS = 30;
const MAX_DURATION_SECONDS = 4 * 60 * 60;
const ALLOWED_LANGUAGES: Record<string, true> = {en: true, es: true, fr: true, de: true, ja: true};

interface TranscribeBody {
  audio_ref: string;
  duration_seconds: number;
  language?: string;
}

interface Job {
  job_id: string;
  status: string;
  total_chunks: number;
  language: string;
  audio_hash: string;
}

const store = {
  async get(_tenant: string, _audioHash: string): Promise<Job | null> {
    return null;
  },
  async put(_tenant: string, _audioHash: string, _job: Job): Promise<void> {},
};

const fetchAudio = async (_audioRef: string): Promise<Buffer> => Buffer.alloc(0);

const audioHashOf = (audioRef: string): string => createHash('sha256').update(audioRef).digest('hex');

app.post('/v1/transcriptions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<TranscribeBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.audio_ref !== 'string' || body.audio_ref === '')
    return reply.code(400).send({error: 'audio_ref is required'});

  // Validate from metadata alone, before a single byte is downloaded.
  const duration = body.duration_seconds ?? 0;
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION_SECONDS)
    return reply.code(400).send({error: 'audio exceeds four hours'});
  const language = body.language ?? 'en';
  if (ALLOWED_LANGUAGES[language] !== true) return reply.code(400).send({error: 'unknown language'});

  const audioHash = audioHashOf(body.audio_ref);
  const stored: Job | null = await store.get(tenant, audioHash);
  if (stored !== null) return reply.code(200).send(stored);

  // Only now is it safe to touch the audio bytes.
  await fetchAudio(body.audio_ref);

  const job: Job = {
    job_id: randomUUID(),
    status: 'queued',
    total_chunks: Math.ceil(duration / CHUNK_SECONDS),
    language,
    audio_hash: audioHash,
  };
  await store.put(tenant, audioHash, job);
  return reply.code(202).send(job);
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

	"github.com/google/uuid"
)

type TranscribeRequest struct {
	AudioRef        string \`json:"audio_ref"\`
	DurationSeconds int    \`json:"duration_seconds"\`
	Language        string \`json:"language"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createTranscription(rw http.ResponseWriter, r *http.Request) {
	var body TranscribeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts any duration, downloads the audio before validating it, starts a new
	// job on every submit, and never checks the language hint. Review all four.
	audio := fetchAudio(body.AudioRef)
	log.Printf("transcription ref=%s bytes=%d", body.AudioRef, len(audio))
	writeJSON(rw, http.StatusCreated, map[string]any{"job_id": uuid.NewString(), "bytes": len(audio)})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/transcriptions", createTranscription)
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

	"github.com/google/uuid"
)

const (
	chunkSeconds       = 30
	maxDurationSeconds = 4 * 60 * 60
)

var allowedLanguages = map[string]bool{"en": true, "es": true, "fr": true, "de": true, "ja": true}

type TranscribeRequest struct {
	AudioRef        string \`json:"audio_ref"\`
	DurationSeconds int    \`json:"duration_seconds"\`
	Language        string \`json:"language"\`
}

type Job struct {
	JobID       string \`json:"job_id"\`
	Status      string \`json:"status"\`
	TotalChunks int    \`json:"total_chunks"\`
	Language    string \`json:"language"\`
	AudioHash   string \`json:"audio_hash"\`
}

type JobStore struct{}

func (s *JobStore) Get(ctx context.Context, tenant, audioHash string) (*Job, error) {
	return nil, nil
}

func (s *JobStore) Put(ctx context.Context, tenant, audioHash string, job *Job) error {
	return nil
}

var store = &JobStore{}

func fetchAudio(audioRef string) []byte {
	return nil
}

func audioHashOf(audioRef string) string {
	sum := sha256.Sum256([]byte(audioRef))
	return hex.EncodeToString(sum[:])
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createTranscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body TranscribeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.AudioRef == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "audio_ref is required"})
		return
	}
	if body.DurationSeconds < 1 || body.DurationSeconds > maxDurationSeconds {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "audio exceeds four hours"})
		return
	}
	if !allowedLanguages[body.Language] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown language"})
		return
	}
	audioHash := audioHashOf(body.AudioRef)
	stored, err := store.Get(r.Context(), tenant, audioHash)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	_ = fetchAudio(body.AudioRef)
	totalChunks := (body.DurationSeconds + chunkSeconds - 1) / chunkSeconds
	job := &Job{
		JobID:       uuid.NewString(),
		Status:      "queued",
		TotalChunks: totalChunks,
		Language:    body.Language,
		AudioHash:   audioHash,
	}
	if err := store.Put(r.Context(), tenant, audioHash, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusAccepted, job)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/transcriptions", createTranscription)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TranscribeRequest(audio_ref: String, duration_seconds: Int, language: String)

object TranscriptionApi {
  implicit val system: ActorSystem = ActorSystem("transcription")
  implicit val requestFormat: RootJsonFormat[TranscribeRequest] = jsonFormat3(TranscribeRequest)

  def fetchAudio(audioRef: String): Array[Byte] = Array.emptyByteArray

  val route: Route =
    path("v1" / "transcriptions") {
      post {
        entity(as[TranscribeRequest]) { body =>
          // TODO: this draft accepts any duration, downloads the audio before validating it, starts
          // a new job on every submit, and never checks the language hint. Review all four.
          val audio = fetchAudio(body.audio_ref)
          val jobId = UUID.randomUUID().toString
          complete(StatusCodes.Created, s"""{"job_id":"$jobId","bytes":\${audio.length}}""")
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TranscribeRequest(audio_ref: String, duration_seconds: Int, language: String)
final case class Job(job_id: String, status: String, total_chunks: Int, language: String, audio_hash: String)

object TranscriptionApi {
  implicit val system: ActorSystem = ActorSystem("transcription")
  implicit val requestFormat: RootJsonFormat[TranscribeRequest] = jsonFormat3(TranscribeRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat5(Job)

  val ChunkSeconds = 30
  val MaxDurationSeconds = 4 * 60 * 60
  val AllowedLanguages = Set("en", "es", "fr", "de", "ja")

  val store = JobStore.open()

  def audioHashOf(audioRef: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(audioRef.getBytes("UTF-8"))
    digest.map("%02x".format(_)).mkString
  }

  def fetchAudio(audioRef: String): Array[Byte] = Array.emptyByteArray

  val route: Route =
    path("v1" / "transcriptions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[TranscribeRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.audio_ref.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"audio_ref is required"}""")
              } else if (body.duration_seconds < 1 || body.duration_seconds > MaxDurationSeconds) {
                complete(StatusCodes.BadRequest, """{"error":"audio exceeds four hours"}""")
              } else if (!AllowedLanguages.contains(body.language)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown language"}""")
              } else {
                val tenant = tenantOpt.get
                val audioHash = audioHashOf(body.audio_ref)
                store.get(tenant, audioHash) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    fetchAudio(body.audio_ref)
                    val totalChunks = (body.duration_seconds + ChunkSeconds - 1) / ChunkSeconds
                    val job = Job(UUID.randomUUID().toString, "queued", totalChunks, body.language, audioHash)
                    store.put(tenant, audioHash, job)
                    complete(StatusCodes.Accepted, job)
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

#include <iostream>
#include <string>

using json = nlohmann::json;

std::string uuidString();
std::string fetchAudio(const std::string& audioRef);

int main() {
  httplib::Server svr;

  svr.Post("/v1/transcriptions", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts any duration, downloads the audio before validating it, starts a new
    // job on every submit, and never checks the language hint. Review all four.
    const auto audioRef = body.value("audio_ref", std::string());
    const auto audio = fetchAudio(audioRef);
    std::cerr << "transcription ref=" << audioRef << " bytes=" << audio.size() << "\\n";
    res.status = 201;
    res.set_content(json{{"job_id", uuidString()}, {"bytes", audio.size()}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr int kChunkSeconds = 30;
constexpr int kMaxDurationSeconds = 4 * 60 * 60;
const std::set<std::string> kAllowedLanguages = {"en", "es", "fr", "de", "ja"};

struct JobStore {
  std::optional<json> get(const std::string& tenant, const std::string& audioHash);
  void put(const std::string& tenant, const std::string& audioHash, const json& job);
};

JobStore store;
std::string uuidString();
std::string fetchAudio(const std::string& audioRef);
std::string sha256Hex(const std::string& value);

int main() {
  httplib::Server svr;

  svr.Post("/v1/transcriptions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("audio_ref") || !body["audio_ref"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"audio_ref is required"})", "application/json");
      return;
    }
    const auto audioRef = body["audio_ref"].get<std::string>();
    if (audioRef.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"audio_ref is required"})", "application/json");
      return;
    }
    const int duration = body.value("duration_seconds", 0);
    if (duration < 1 || duration > kMaxDurationSeconds) {
      res.status = 400;
      res.set_content(R"({"error":"audio exceeds four hours"})", "application/json");
      return;
    }
    const auto language = body.value("language", std::string("en"));
    if (kAllowedLanguages.count(language) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown language"})", "application/json");
      return;
    }
    const auto audioHash = sha256Hex(audioRef);
    const auto stored = store.get(tenant, audioHash);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    fetchAudio(audioRef);
    const int totalChunks = (duration + kChunkSeconds - 1) / kChunkSeconds;
    const json job = {
        {"job_id", uuidString()},
        {"status", "queued"},
        {"total_chunks", totalChunks},
        {"language", language},
        {"audio_hash", audioHash},
    };
    store.put(tenant, audioHash, job);
    res.status = 202;
    res.set_content(job.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Guard the request before it costs anything: tenant, Idempotency-Key, audio_ref, duration, language. A five-hour file must be a 400 from `duration_seconds` alone — reaching the audio store to find out is already a billable download.',
    'Key idempotency on the audio, not the request: `sha256(audio_ref)` is stable across retries, and a hit returns the stored running job instead of creating a second one.',
    'The order of the handler is the contract: validate the metadata, look up the audio hash, and only then call `fetch_audio`. If the download appears before the duration check, every rejection has already paid for the audio.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary before it spends money. The draft reads fine because the demo sends one well-formed, in-range request and never retries. Three defects are being checked: the missing metadata cap (a five-hour file must be a 400 decided before any download), the missing idempotency key (keyed by the audio hash so a retry resumes the same job instead of starting a second), and the ordering flaw that is the quiet one — the draft downloads the audio first and validates second, so every rejected request has already paid for bytes it will never use. Real pipelines validate the reference and its duration from an index or a manifest, never by pulling the object, and they keep the idempotency record in the same transaction that creates the job.`,
};
