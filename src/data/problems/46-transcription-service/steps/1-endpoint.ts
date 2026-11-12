import type {Step} from '@/lib/types';

export const transcriptionEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/transcriptions: hours of audio, one job',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db', 'storage'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/transcriptions\` with a body of \`{audio_ref,
duration_seconds, language}\`, reads the tenant from \`X-Tenant-Id\` (401 without it), stages the audio
(\`audio.stage\`) and creates a job keyed by \`sha256(audio_ref)\` through \`jobs.create\`, answering
**202** \`{job_id, status: "queued", total_chunks}\` at 30 seconds per chunk. It serves the demo and
hides four flaws.

**Failure mode the checks target.** A five-hour file or an unsupported language starts a job; every
request that should be refused has already paid for the download; and a client that retries its
submit gets a second job for the same audio, transcribed and billed twice.

- \`duration_seconds\` is 1 to \`MAX_DURATION_SECONDS\` (14 400, four hours) and \`language\` is one of
  \`ALLOWED_LANGUAGES\` (\`en\`, \`es\`, \`fr\`, \`de\`, \`ja\`); anything else is **400**.
- Both are decided from the metadata, before \`audio.stage\`: a refused request stages nothing.
- Before creating a job, look up \`jobs.find_by_audio(tenant, audio_hash)\`: a replay answers **200**
  with that job and stages nothing. Another tenant's identical audio is a job of its own.`,
  sequence: {
    participants: ['Client', 'Transcription API', 'jobs store', 'audio store'],
    messages: [
      {
        from: 'Client',
        to: 'Transcription API',
        label: 'POST /v1/transcriptions · X-Tenant-Id · {audio_ref, duration_seconds, language}',
        kind: 'sync',
      },
      {
        from: 'Transcription API',
        to: 'Transcription API',
        label: 'duration ≤ 14 400 s · language allowlisted → else 400',
        kind: 'sync',
      },
      {from: 'Transcription API', to: 'jobs store', label: 'find_by_audio(tenant, sha256(audio_ref))', kind: 'sync'},
      {from: 'jobs store', to: 'Transcription API', label: 'job → 200 replay · none', kind: 'reply'},
      {from: 'Transcription API', to: 'audio store', label: 'stage(audio_ref), only for a new job', kind: 'sync'},
      {from: 'Transcription API', to: 'jobs store', label: 'create(tenant, audio_ref, audio_hash, …)', kind: 'sync'},
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
      title: 'Creates a queued job on POST /v1/transcriptions',
      detail:
        'Register `POST /v1/transcriptions`: a valid request answers **202** with the job id, `queued` and the chunk count; a request without `X-Tenant-Id` is **401**.',
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
      title: 'Refuses a file over four hours',
      detail:
        '`duration_seconds` outside 1 to `MAX_DURATION_SECONDS` (14 400) is **400**; the starter accepts any duration, so a five-hour file starts a job.',
      match: {
        python: {
          all: [
            /MAX_DURATION_SECONDS\s*=\s*(?:14_?400|4\s*\*\s*60\s*\*\s*60)\b/,
            /[<>]=?\s*MAX_DURATION_SECONDS/,
            /\b400\b/,
          ],
        },
        typescript: {
          all: [
            /MAX_DURATION_SECONDS\s*=\s*(?:14_?400|4\s*\*\s*60\s*\*\s*60)\b/,
            /[<>]=?\s*MAX_DURATION_SECONDS/,
            /\b400\b/,
          ],
        },
        go: {
          all: [
            /maxDurationSeconds\s*=\s*(?:14400|4\s*\*\s*60\s*\*\s*60)\b/,
            /[<>]=?\s*maxDurationSeconds/,
            /StatusBadRequest|\b400\b/,
          ],
        },
        scala: {
          all: [
            /MaxDurationSeconds\s*=\s*(?:14400|4\s*\*\s*60\s*\*\s*60)\b/,
            /[<>]=?\s*MaxDurationSeconds/,
            /BadRequest/,
          ],
        },
        cpp: {
          all: [
            /kMaxDurationSeconds\s*=\s*(?:14'?400|4\s*\*\s*60\s*\*\s*60)\b/,
            /[<>]=?\s*kMaxDurationSeconds/,
            /\b400\b/,
          ],
        },
      },
    },
    {
      id: 'language-allowlist',
      title: 'Accepts only the allowlisted languages',
      detail:
        '`language` is checked against `ALLOWED_LANGUAGES` (`en`, `es`, `fr`, `de`, `ja`) and anything else is **400**; the starter passes any hint through to the job.',
      match: {
        python: {all: [/ALLOWED_LANGUAGES\s*=/, /not in ALLOWED_LANGUAGES/]},
        typescript: {
          all: [/ALLOWED_LANGUAGES\s*[:=]/, /ALLOWED_LANGUAGES\.has\(|ALLOWED_LANGUAGES\[|in ALLOWED_LANGUAGES/],
        },
        go: {all: [/allowedLanguages\s*=/, /allowedLanguages\[/]},
        scala: {all: [/AllowedLanguages\s*[:=]/, /AllowedLanguages\.contains\(/]},
        cpp: {all: [/kAllowedLanguages\s*=|kAllowedLanguages\{/, /kAllowedLanguages\.(count|find|contains)\(/]},
      },
    },
    {
      id: 'stage-after-validate',
      title: 'Stages no audio for a request it refuses',
      detail:
        'The duration and language guards run before `audio.stage`: a request that is refused, or that the guards would refuse, never downloads the file. The starter stages on its first line.',
      match: {
        python: {order: [/[<>]=?\s*MAX_DURATION_SECONDS/, /not in ALLOWED_LANGUAGES/, /audio\.stage\(/]},
        typescript: {
          order: [
            /[<>]=?\s*MAX_DURATION_SECONDS/,
            /ALLOWED_LANGUAGES\.has\(|ALLOWED_LANGUAGES\[|in ALLOWED_LANGUAGES/,
            /\bstage\(/,
          ],
        },
        go: {order: [/[<>]=?\s*maxDurationSeconds/, /allowedLanguages\[/, /audio\.Stage\(/]},
        scala: {order: [/[<>]=?\s*MaxDurationSeconds/, /AllowedLanguages\.contains\(/, /Audio\.stage\(/]},
        cpp: {order: [/[<>]=?\s*kMaxDurationSeconds/, /kAllowedLanguages\.(count|find|contains)\(/, /audio::stage\(/]},
      },
    },
    {
      id: 'audio-dedupe',
      title: 'A retried submit lands on the job that exists',
      detail:
        'The job is looked up by `(tenant, sha256(audio_ref))` through `find_by_audio`/`findByAudio` before anything is staged or created; a replay answers that job. The starter creates a job on every submit.',
      match: {
        python: {order: [/jobs\.find_by_audio\(/, /audio\.stage\(/, /jobs\.create\(/]},
        typescript: {order: [/findByAudio\(\s*tenant/, /\bstage\(/, /\bcreate\(\s*tenant/]},
        go: {order: [/jobs\.FindByAudio\(/, /audio\.Stage\(/, /jobs\.Create\(/]},
        scala: {order: [/Jobs\.findByAudio\(/, /Audio\.stage\(/, /Jobs\.create\(/]},
        cpp: {order: [/jobs::findByAudio\(/, /audio::stage\(/, /jobs::create\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import math

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from transcribe import audio, jobs  # audio.stage; jobs.create, get, find_by_audio

app = FastAPI()

CHUNK_SECONDS = 30


class TranscribeRequest(BaseModel):
    audio_ref: str
    duration_seconds: int
    language: str


def view(job: dict, status_code: int) -> JSONResponse:
    return JSONResponse({"job_id": job["job_id"], "status": job["status"], "total_chunks": job["total_chunks"]}, status_code=status_code)


@app.post("/v1/transcriptions")
def create_transcription(body: TranscribeRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    audio.stage(body.audio_ref)
    audio_hash = hashlib.sha256(body.audio_ref.encode()).hexdigest()
    total_chunks = math.ceil(body.duration_seconds / CHUNK_SECONDS)
    job = jobs.create(tenant, body.audio_ref, audio_hash, body.duration_seconds, body.language, total_chunks)
    return view(job, 202)
`,
      solution: `import hashlib
import math

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from transcribe import audio, jobs  # audio.stage; jobs.create, get, find_by_audio

app = FastAPI()

CHUNK_SECONDS = 30
MAX_DURATION_SECONDS = 4 * 60 * 60
ALLOWED_LANGUAGES = {"en", "es", "fr", "de", "ja"}


class TranscribeRequest(BaseModel):
    audio_ref: str
    duration_seconds: int
    language: str


def view(job: dict, status_code: int) -> JSONResponse:
    return JSONResponse({"job_id": job["job_id"], "status": job["status"], "total_chunks": job["total_chunks"]}, status_code=status_code)


@app.post("/v1/transcriptions")
def create_transcription(body: TranscribeRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    # Everything the body can refuse is refused before a byte is downloaded.
    if not 1 <= body.duration_seconds <= MAX_DURATION_SECONDS:
        raise HTTPException(status_code=400, detail=f"duration_seconds must be 1 to {MAX_DURATION_SECONDS}")
    if body.language not in ALLOWED_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"language {body.language!r} is not supported")
    audio_hash = hashlib.sha256(body.audio_ref.encode()).hexdigest()
    existing = jobs.find_by_audio(tenant, audio_hash)
    if existing is not None:
        return view(existing, 200)  # a retried submit: the job that already exists
    audio.stage(body.audio_ref)
    total_chunks = math.ceil(body.duration_seconds / CHUNK_SECONDS)
    job = jobs.create(tenant, body.audio_ref, audio_hash, body.duration_seconds, body.language, total_chunks)
    return view(job, 202)
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {stage} from 'transcribe/audio';
import {type Job, create, findByAudio} from 'transcribe/jobs';

export const app = Fastify();

export const CHUNK_SECONDS = 30;

interface TranscribeRequest {
  audio_ref: string;
  duration_seconds: number;
  language: string;
}

const view = (job: Job) => ({job_id: job.job_id, status: job.status, total_chunks: job.total_chunks});

app.post('/v1/transcriptions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as TranscribeRequest;
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await stage(body.audio_ref);
  const audioHash = createHash('sha256').update(body.audio_ref).digest('hex');
  const totalChunks = Math.ceil(body.duration_seconds / CHUNK_SECONDS);
  const job = await create(tenant, body.audio_ref, audioHash, body.duration_seconds, body.language, totalChunks);
  return reply.code(202).send(view(job));
});

void findByAudio;
`,
      solution: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {stage} from 'transcribe/audio';
import {type Job, create, findByAudio} from 'transcribe/jobs';

export const app = Fastify();

export const CHUNK_SECONDS = 30;
export const MAX_DURATION_SECONDS = 4 * 60 * 60;
export const ALLOWED_LANGUAGES: Record<string, true> = {en: true, es: true, fr: true, de: true, ja: true};

interface TranscribeRequest {
  audio_ref: string;
  duration_seconds: number;
  language: string;
}

const view = (job: Job) => ({job_id: job.job_id, status: job.status, total_chunks: job.total_chunks});

app.post('/v1/transcriptions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as TranscribeRequest;
  // Everything the body can refuse is refused before a byte is downloaded.
  if (!Number.isInteger(body.duration_seconds) || body.duration_seconds < 1 || body.duration_seconds > MAX_DURATION_SECONDS) {
    return reply.code(400).send({error: \`duration_seconds must be 1 to \${MAX_DURATION_SECONDS}\`});
  }
  if (ALLOWED_LANGUAGES[body.language] !== true) return reply.code(400).send({error: \`language \${body.language} is not supported\`});
  const audioHash = createHash('sha256').update(body.audio_ref).digest('hex');
  const existing = await findByAudio(tenant, audioHash);
  if (existing !== null) return reply.code(200).send(view(existing)); // a retried submit: the job that already exists
  await stage(body.audio_ref);
  const totalChunks = Math.ceil(body.duration_seconds / CHUNK_SECONDS);
  const job = await create(tenant, body.audio_ref, audioHash, body.duration_seconds, body.language, totalChunks);
  return reply.code(202).send(view(job));
});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"transcribe/audio" // audio.Stage(ctx, audioRef)
	"transcribe/jobs"  // jobs.Create, Get, FindByAudio
)

const chunkSeconds = 30

type transcribeRequest struct {
	AudioRef        string \`json:"audio_ref"\`
	DurationSeconds int    \`json:"duration_seconds"\`
	Language        string \`json:"language"\`
}

type jobView struct {
	JobID       string \`json:"job_id"\`
	Status      string \`json:"status"\`
	TotalChunks int    \`json:"total_chunks"\`
}

func writeJob(rw http.ResponseWriter, status int, job *jobs.Job) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(jobView{JobID: job.JobID, Status: job.Status, TotalChunks: job.TotalChunks})
}

func createTranscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body transcribeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid JSON body", http.StatusBadRequest)
		return
	}
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	audio.Stage(r.Context(), body.AudioRef)
	sum := sha256.Sum256([]byte(body.AudioRef))
	audioHash := hex.EncodeToString(sum[:])
	totalChunks := (body.DurationSeconds + chunkSeconds - 1) / chunkSeconds
	job := jobs.Create(r.Context(), tenant, body.AudioRef, audioHash, body.DurationSeconds, body.Language, totalChunks)
	writeJob(rw, http.StatusAccepted, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/transcriptions", createTranscription)
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"

	"transcribe/audio" // audio.Stage(ctx, audioRef)
	"transcribe/jobs"  // jobs.Create, Get, FindByAudio
)

const (
	chunkSeconds       = 30
	maxDurationSeconds = 4 * 60 * 60
)

var allowedLanguages = map[string]bool{"en": true, "es": true, "fr": true, "de": true, "ja": true}

type transcribeRequest struct {
	AudioRef        string \`json:"audio_ref"\`
	DurationSeconds int    \`json:"duration_seconds"\`
	Language        string \`json:"language"\`
}

type jobView struct {
	JobID       string \`json:"job_id"\`
	Status      string \`json:"status"\`
	TotalChunks int    \`json:"total_chunks"\`
}

func writeJob(rw http.ResponseWriter, status int, job *jobs.Job) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(jobView{JobID: job.JobID, Status: job.Status, TotalChunks: job.TotalChunks})
}

func createTranscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body transcribeRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid JSON body", http.StatusBadRequest)
		return
	}
	// Everything the body can refuse is refused before a byte is downloaded.
	if body.DurationSeconds < 1 || body.DurationSeconds > maxDurationSeconds {
		http.Error(rw, fmt.Sprintf("duration_seconds must be 1 to %d", maxDurationSeconds), http.StatusBadRequest)
		return
	}
	if !allowedLanguages[body.Language] {
		http.Error(rw, fmt.Sprintf("language %q is not supported", body.Language), http.StatusBadRequest)
		return
	}
	sum := sha256.Sum256([]byte(body.AudioRef))
	audioHash := hex.EncodeToString(sum[:])
	if existing := jobs.FindByAudio(r.Context(), tenant, audioHash); existing != nil {
		writeJob(rw, http.StatusOK, existing) // a retried submit: the job that already exists
		return
	}
	audio.Stage(r.Context(), body.AudioRef)
	totalChunks := (body.DurationSeconds + chunkSeconds - 1) / chunkSeconds
	job := jobs.Create(r.Context(), tenant, body.AudioRef, audioHash, body.DurationSeconds, body.Language, totalChunks)
	writeJob(rw, http.StatusAccepted, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/transcriptions", createTranscription)
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import transcribe.{Audio, Jobs} // Audio.stage; Jobs.create, get, findByAudio

object Api {
  val ChunkSeconds = 30

  private def view(status: StatusCode, job: Jobs.Job): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`,
      JsObject("job_id" -> JsString(job.jobId), "status" -> JsString(job.status), "total_chunks" -> JsNumber(job.totalChunks)).compactPrint))

  private def sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString

  val route: Route = path("v1" / "transcriptions") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val audioRef = body("audio_ref").convertTo[String]
            val durationSeconds = body("duration_seconds").convertTo[Int]
            val language = body("language").convertTo[String]
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            Audio.stage(audioRef)
            val totalChunks = (durationSeconds + ChunkSeconds - 1) / ChunkSeconds
            val job = Jobs.create(tenant, audioRef, sha256(audioRef), durationSeconds, language, totalChunks)
            complete(view(StatusCodes.Accepted, job))
          }
      }
    }
  }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import transcribe.{Audio, Jobs} // Audio.stage; Jobs.create, get, findByAudio

object Api {
  val ChunkSeconds = 30
  val MaxDurationSeconds = 4 * 60 * 60
  val AllowedLanguages: Set[String] = Set("en", "es", "fr", "de", "ja")

  private def view(status: StatusCode, job: Jobs.Job): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`,
      JsObject("job_id" -> JsString(job.jobId), "status" -> JsString(job.status), "total_chunks" -> JsNumber(job.totalChunks)).compactPrint))

  private def sha256(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString

  val route: Route = path("v1" / "transcriptions") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val audioRef = body("audio_ref").convertTo[String]
            val durationSeconds = body("duration_seconds").convertTo[Int]
            val language = body("language").convertTo[String]
            // Everything the body can refuse is refused before a byte is downloaded.
            if (durationSeconds < 1 || durationSeconds > MaxDurationSeconds)
              complete(StatusCodes.BadRequest -> s"duration_seconds must be 1 to $MaxDurationSeconds")
            else if (!AllowedLanguages.contains(language))
              complete(StatusCodes.BadRequest -> s"language $language is not supported")
            else {
              val audioHash = sha256(audioRef)
              Jobs.findByAudio(tenant, audioHash) match {
                case Some(existing) => complete(view(StatusCodes.OK, existing)) // a retried submit: the job that already exists
                case None =>
                  Audio.stage(audioRef)
                  val totalChunks = (durationSeconds + ChunkSeconds - 1) / ChunkSeconds
                  complete(view(StatusCodes.Accepted, Jobs.create(tenant, audioRef, audioHash, durationSeconds, language, totalChunks)))
              }
            }
          }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "digest.h"            // sha256_hex(bytes)
#include "transcribe/audio.h"  // audio::stage(audio_ref)
#include "transcribe/jobs.h"   // jobs::create, get, findByAudio

using json = nlohmann::json;

constexpr long kChunkSeconds = 30;

void write_job(httplib::Response& res, int status, const jobs::Job& job) {
  res.status = status;
  res.set_content(json{{"job_id", job.job_id}, {"status", job.status}, {"total_chunks", job.total_chunks}}.dump(), "application/json");
}

void create_transcription(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body);
  const std::string audio_ref = body.value("audio_ref", "");
  const long duration_seconds = body.value("duration_seconds", 0L);
  const std::string language = body.value("language", "");
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  audio::stage(audio_ref);
  const std::string audio_hash = sha256_hex(audio_ref);
  const long total_chunks = (duration_seconds + kChunkSeconds - 1) / kChunkSeconds;
  write_job(res, 202, jobs::create(tenant, audio_ref, audio_hash, duration_seconds, language, total_chunks));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/transcriptions", create_transcription); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "digest.h"            // sha256_hex(bytes)
#include "transcribe/audio.h"  // audio::stage(audio_ref)
#include "transcribe/jobs.h"   // jobs::create, get, findByAudio

using json = nlohmann::json;

constexpr long kChunkSeconds = 30;
constexpr long kMaxDurationSeconds = 4 * 60 * 60;
const std::set<std::string> kAllowedLanguages = {"en", "es", "fr", "de", "ja"};

void write_job(httplib::Response& res, int status, const jobs::Job& job) {
  res.status = status;
  res.set_content(json{{"job_id", job.job_id}, {"status", job.status}, {"total_chunks", job.total_chunks}}.dump(), "application/json");
}

void create_transcription(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body);
  const std::string audio_ref = body.value("audio_ref", "");
  const long duration_seconds = body.value("duration_seconds", 0L);
  const std::string language = body.value("language", "");
  // Everything the body can refuse is refused before a byte is downloaded.
  if (duration_seconds < 1 || duration_seconds > kMaxDurationSeconds) {
    res.status = 400;
    res.set_content("duration_seconds must be 1 to " + std::to_string(kMaxDurationSeconds), "text/plain");
    return;
  }
  if (kAllowedLanguages.count(language) == 0) {
    res.status = 400;
    res.set_content("language " + language + " is not supported", "text/plain");
    return;
  }
  const std::string audio_hash = sha256_hex(audio_ref);
  if (const auto existing = jobs::findByAudio(tenant, audio_hash)) {
    write_job(res, 200, *existing);  // a retried submit: the job that already exists
    return;
  }
  audio::stage(audio_ref);
  const long total_chunks = (duration_seconds + kChunkSeconds - 1) / kChunkSeconds;
  write_job(res, 202, jobs::create(tenant, audio_ref, audio_hash, duration_seconds, language, total_chunks));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/transcriptions", create_transcription); }
`,
    },
  },
  harness: {
    python: `from transcribe import jobs

REF = "s3://calls/2026-11-02/support-0412.wav"
T1 = {"X-Tenant-Id": "t-1"}
T2 = {"X-Tenant-Id": "t-2"}


def _body(ref=REF, duration=95, language="en"):
    return {"audio_ref": ref, "duration_seconds": duration, "language": language}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _staged(ctx):
    return ctx.redis.lrange("audio:staged", 0, -1)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/transcriptions", json=_body(), headers=T1)
        anonymous = await c.post("/v1/transcriptions", json=_body(ref="s3://calls/other.wav"))
    assert r.status_code == 202, f"POST /v1/transcriptions answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "queued" and body.get("total_chunks") == 4, f"a 95-second file is a queued job of 4 chunks of 30 s, got {body}"
    job = jobs.get(body.get("job_id", ""))
    assert job is not None and job["tenant"] == "t-1" and job["audio_ref"] == REF, f"the jobs store holds {job} for {body.get('job_id')}"
    assert anonymous.status_code == 401, f"a request without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_duration_cap(ctx):
    async with _api(ctx) as c:
        over = await c.post("/v1/transcriptions", json=_body(ref="s3://calls/five-hours.wav", duration=14401), headers=T1)
        zero = await c.post("/v1/transcriptions", json=_body(ref="s3://calls/empty.wav", duration=0), headers=T1)
        cap = await c.post("/v1/transcriptions", json=_body(ref="s3://calls/four-hours.wav", duration=14400), headers=T1)
    assert over.status_code == 400, f"a 14 401-second file answered {over.status_code}, expected 400: the cap is four hours"
    assert zero.status_code == 400, f"a 0-second file answered {zero.status_code}, expected 400"
    assert cap.status_code == 202 and cap.json().get("total_chunks") == 480, f"a file of exactly four hours is accepted as 480 chunks, got {cap.status_code} {cap.text}"


async def check_language_allowlist(ctx):
    async with _api(ctx) as c:
        bad = await c.post("/v1/transcriptions", json=_body(language="xx"), headers=T1)
        ok = await c.post("/v1/transcriptions", json=_body(ref="s3://calls/tokyo.wav", language="ja"), headers=T1)
    assert bad.status_code == 400, f"language 'xx' answered {bad.status_code}, expected 400"
    assert ok.status_code == 202, f"language 'ja' is allowlisted, the request answered {ok.status_code}: {ok.text}"


async def check_stage_after_validate(ctx):
    async with _api(ctx) as c:
        await c.post("/v1/transcriptions", json=_body(ref="s3://calls/five-hours.wav", duration=18000), headers=T1)
        await c.post("/v1/transcriptions", json=_body(ref="s3://calls/klingon.wav", language="xx"), headers=T1)
        staged = _staged(ctx)
        assert staged == [], f"requests that must be refused (five hours; language xx) staged {staged}: the download is paid before the metadata is checked"
        r = await c.post("/v1/transcriptions", json=_body(), headers=T1)
    assert r.status_code == 202, f"a valid request answered {r.status_code}: {r.text}"
    assert _staged(ctx) == [REF], f"a valid request stages its audio once, audio:staged holds {_staged(ctx)}"


async def check_audio_dedupe(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/transcriptions", json=_body(), headers=T1)
        replay = await c.post("/v1/transcriptions", json=_body(), headers=T1)
        other = await c.post("/v1/transcriptions", json=_body(), headers=T2)
    assert first.status_code == 202, f"the first submit answered {first.status_code}: {first.text}"
    assert replay.status_code in (200, 202), f"the retried submit answered {replay.status_code}: {replay.text}"
    job_id = first.json().get("job_id")
    assert replay.json().get("job_id") == job_id, f"a retried submit of the same audio created job {replay.json().get('job_id')} beside {job_id}: the audio is transcribed and billed twice"
    assert other.status_code == 202 and other.json().get("job_id") != job_id, f"tenant t-2 submitting the same audio must get a job of its own, got {other.status_code} {other.text}"
    assert _staged(ctx) == [REF, REF], f"one staging per job: audio:staged holds {_staged(ctx)} after a submit, its retry and another tenant's submit"
`,
    typescript: `const REF = 's3://calls/2026-11-02/support-0412.wav';
const T1 = {'X-Tenant-Id': 't-1'};
const T2 = {'X-Tenant-Id': 't-2'};

const body = (ref = REF, duration = 95, language = 'en') => ({audio_ref: ref, duration_seconds: duration, language});

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), jobs: ctx.load('/support/transcribe/jobs.ts')};
}

const staged = ctx => ctx.redis.lrange('audio:staged', 0, -1);

export async function check_route(ctx) {
  const {c, jobs} = api(ctx);
  const r = await c.post('/v1/transcriptions', {json: body(), headers: T1});
  const anonymous = await c.post('/v1/transcriptions', {json: body('s3://calls/other.wav')});
  assert.equal(r.status, 202, \`POST /v1/transcriptions answered \${r.status}: \${r.text}\`);
  const out = r.json();
  assert(out.status === 'queued' && out.total_chunks === 4, \`a 95-second file is a queued job of 4 chunks of 30 s, got \${r.text}\`);
  const job = await jobs.get(out.job_id ?? '');
  assert(job !== null && job.tenant === 't-1' && job.audio_ref === REF, \`the jobs store holds \${JSON.stringify(job)} for \${out.job_id}\`);
  assert.equal(anonymous.status, 401, \`a request without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_duration_cap(ctx) {
  const {c} = api(ctx);
  const over = await c.post('/v1/transcriptions', {json: body('s3://calls/five-hours.wav', 14401), headers: T1});
  const zero = await c.post('/v1/transcriptions', {json: body('s3://calls/empty.wav', 0), headers: T1});
  const cap = await c.post('/v1/transcriptions', {json: body('s3://calls/four-hours.wav', 14400), headers: T1});
  assert.equal(over.status, 400, \`a 14 401-second file answered \${over.status}, expected 400: the cap is four hours\`);
  assert.equal(zero.status, 400, \`a 0-second file answered \${zero.status}, expected 400\`);
  assert(cap.status === 202 && cap.json().total_chunks === 480, \`a file of exactly four hours is accepted as 480 chunks, got \${cap.status} \${cap.text}\`);
}

export async function check_language_allowlist(ctx) {
  const {c} = api(ctx);
  const bad = await c.post('/v1/transcriptions', {json: body(REF, 95, 'xx'), headers: T1});
  const ok = await c.post('/v1/transcriptions', {json: body('s3://calls/tokyo.wav', 95, 'ja'), headers: T1});
  assert.equal(bad.status, 400, \`language 'xx' answered \${bad.status}, expected 400\`);
  assert.equal(ok.status, 202, \`language 'ja' is allowlisted, the request answered \${ok.status}: \${ok.text}\`);
}

export async function check_stage_after_validate(ctx) {
  const {c} = api(ctx);
  await c.post('/v1/transcriptions', {json: body('s3://calls/five-hours.wav', 18000), headers: T1});
  await c.post('/v1/transcriptions', {json: body('s3://calls/klingon.wav', 95, 'xx'), headers: T1});
  assert.deepStrictEqual(staged(ctx), [], \`requests that must be refused (five hours; language xx) staged \${JSON.stringify(staged(ctx))}: the download is paid before the metadata is checked\`);
  const r = await c.post('/v1/transcriptions', {json: body(), headers: T1});
  assert.equal(r.status, 202, \`a valid request answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(staged(ctx), [REF], \`a valid request stages its audio once, audio:staged holds \${JSON.stringify(staged(ctx))}\`);
}

export async function check_audio_dedupe(ctx) {
  const {c} = api(ctx);
  const first = await c.post('/v1/transcriptions', {json: body(), headers: T1});
  const replay = await c.post('/v1/transcriptions', {json: body(), headers: T1});
  const other = await c.post('/v1/transcriptions', {json: body(), headers: T2});
  assert.equal(first.status, 202, \`the first submit answered \${first.status}: \${first.text}\`);
  assert(replay.status === 200 || replay.status === 202, \`the retried submit answered \${replay.status}: \${replay.text}\`);
  const jobId = first.json().job_id;
  assert.equal(replay.json().job_id, jobId, \`a retried submit of the same audio created job \${replay.json().job_id} beside \${jobId}: the audio is transcribed and billed twice\`);
  assert(other.status === 202 && other.json().job_id !== jobId, \`tenant t-2 submitting the same audio must get a job of its own, got \${other.status} \${other.text}\`);
  assert.deepStrictEqual(staged(ctx), [REF, REF], \`one staging per job: audio:staged holds \${JSON.stringify(staged(ctx))} after a submit, its retry and another tenant's submit\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"transcribe/jobs"

	"leetbuild/harness"
)

const apiRef = "s3://calls/2026-11-02/support-0412.wav"

type apiView struct {
	JobID       string \`json:"job_id"\`
	Status      string \`json:"status"\`
	TotalChunks int    \`json:"total_chunks"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiBody(ref string, duration int, language string) map[string]any {
	return map[string]any{"audio_ref": ref, "duration_seconds": duration, "language": language}
}

// submit posts a job for tenant; the view is decoded only from a 2xx answer.
func submit(c *harness.HTTP, body map[string]any, tenant string) (*harness.Response, apiView) {
	r := c.Post("/v1/transcriptions", body, "X-Tenant-Id", tenant)
	var v apiView
	if r.Status >= 200 && r.Status < 300 {
		r.Decode(&v)
	}
	return r, v
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r, v := submit(c, apiBody(apiRef, 95, "en"), "t-1")
	ctx.Equal(r.Status, 202, "POST /v1/transcriptions (%s)", r.Text())
	ctx.Assert(v.Status == "queued" && v.TotalChunks == 4, "a 95-second file is a queued job of 4 chunks of 30 s, got %s", r.Text())
	job := jobs.Get(context.Background(), v.JobID)
	ctx.Assert(job != nil && job.Tenant == "t-1" && job.AudioRef == apiRef, "the jobs store holds %+v for %s", job, v.JobID)
	anonymous := c.Post("/v1/transcriptions", apiBody("s3://calls/other.wav", 95, "en"))
	ctx.Equal(anonymous.Status, 401, "a request without X-Tenant-Id")
}

func CheckDurationCap(ctx *harness.Ctx) {
	c := api(ctx)
	over, _ := submit(c, apiBody("s3://calls/five-hours.wav", 14401, "en"), "t-1")
	zero, _ := submit(c, apiBody("s3://calls/empty.wav", 0, "en"), "t-1")
	capped, v := submit(c, apiBody("s3://calls/four-hours.wav", 14400, "en"), "t-1")
	ctx.Equal(over.Status, 400, "a 14 401-second file (the cap is four hours)")
	ctx.Equal(zero.Status, 400, "a 0-second file")
	ctx.Assert(capped.Status == 202 && v.TotalChunks == 480, "a file of exactly four hours is accepted as 480 chunks, got %d %s", capped.Status, capped.Text())
}

func CheckLanguageAllowlist(ctx *harness.Ctx) {
	c := api(ctx)
	bad, _ := submit(c, apiBody(apiRef, 95, "xx"), "t-1")
	ok, _ := submit(c, apiBody("s3://calls/tokyo.wav", 95, "ja"), "t-1")
	ctx.Equal(bad.Status, 400, "language xx")
	ctx.Equal(ok.Status, 202, "language ja is allowlisted (%s)", ok.Text())
}

func CheckStageAfterValidate(ctx *harness.Ctx) {
	c := api(ctx)
	submit(c, apiBody("s3://calls/five-hours.wav", 18000, "en"), "t-1")
	submit(c, apiBody("s3://calls/klingon.wav", 95, "xx"), "t-1")
	staged := ctx.Redis.LRange("audio:staged", 0, -1)
	ctx.Assert(len(staged) == 0, "requests that must be refused (five hours; language xx) staged %q: the download is paid before the metadata is checked", staged)
	r, _ := submit(c, apiBody(apiRef, 95, "en"), "t-1")
	ctx.Equal(r.Status, 202, "a valid request (%s)", r.Text())
	ctx.Equal(ctx.Redis.LRange("audio:staged", 0, -1), []string{apiRef}, "a valid request stages its audio once; audio:staged")
}

func CheckAudioDedupe(ctx *harness.Ctx) {
	c := api(ctx)
	first, v1 := submit(c, apiBody(apiRef, 95, "en"), "t-1")
	replay, v2 := submit(c, apiBody(apiRef, 95, "en"), "t-1")
	other, v3 := submit(c, apiBody(apiRef, 95, "en"), "t-2")
	ctx.Equal(first.Status, 202, "the first submit (%s)", first.Text())
	ctx.Assert(replay.Status == 200 || replay.Status == 202, "the retried submit answered %d: %s", replay.Status, replay.Text())
	ctx.Equal(v2.JobID, v1.JobID, "a retried submit of the same audio must answer the job that exists, not a second job transcribed and billed twice; the job id")
	ctx.Assert(other.Status == 202 && v3.JobID != v1.JobID, "tenant t-2 submitting the same audio must get a job of its own, got %d %s", other.Status, other.Text())
	ctx.Equal(ctx.Redis.LRange("audio:staged", 0, -1), []string{apiRef, apiRef}, "one staging per job after a submit, its retry and another tenant's submit; audio:staged")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

namespace {

const std::string kRef = "s3://calls/2026-11-02/support-0412.wav";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string apiBody(const std::string& ref, long duration, const std::string& language) {
  return nlohmann::json{{"audio_ref", ref}, {"duration_seconds", duration}, {"language", language}}.dump();
}

// One submit for tenant: the response and its body (null unless the answer is JSON).
std::pair<harness::Response, nlohmann::json> submit(harness::HTTP& c, const std::string& body, const std::string& tenant) {
  auto r = c.Post("/v1/transcriptions", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return {r, nlohmann::json::parse(r.Text(), nullptr, false)};
}

std::string jobIdOf(const nlohmann::json& j) { return j.is_object() ? j.value("job_id", "") : ""; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto [r, body] = submit(c, apiBody(kRef, 95, "en"), "t-1");
  ctx.Equal(r.Status, 202, "POST /v1/transcriptions (%s)", r.Text());
  ctx.Assert(body.is_object() && body.value("status", "") == "queued" && body.value("total_chunks", 0) == 4, "a 95-second file is a queued job of 4 chunks of 30 s, got %s", r.Text());
  const auto job = jobs::get(jobIdOf(body));
  ctx.Assert(job && job->tenant == "t-1" && job->audio_ref == kRef, "the jobs store holds no job of t-1 for %s", jobIdOf(body));
  const auto anonymous = c.Post("/v1/transcriptions", apiBody("s3://calls/other.wav", 95, "en"), "Content-Type", "application/json");
  ctx.Equal(anonymous.Status, 401, "a request without X-Tenant-Id");
}

void CheckDurationCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto over = submit(c, apiBody("s3://calls/five-hours.wav", 14401, "en"), "t-1").first;
  const auto zero = submit(c, apiBody("s3://calls/empty.wav", 0, "en"), "t-1").first;
  const auto [capped, body] = submit(c, apiBody("s3://calls/four-hours.wav", 14400, "en"), "t-1");
  ctx.Equal(over.Status, 400, "a 14 401-second file (the cap is four hours)");
  ctx.Equal(zero.Status, 400, "a 0-second file");
  ctx.Assert(capped.Status == 202 && body.is_object() && body.value("total_chunks", 0) == 480, "a file of exactly four hours is accepted as 480 chunks, got %d %s", capped.Status, capped.Text());
}

void CheckLanguageAllowlist(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto bad = submit(c, apiBody(kRef, 95, "xx"), "t-1").first;
  const auto ok = submit(c, apiBody("s3://calls/tokyo.wav", 95, "ja"), "t-1").first;
  ctx.Equal(bad.Status, 400, "language xx");
  ctx.Equal(ok.Status, 202, "language ja is allowlisted (%s)", ok.Text());
}

void CheckStageAfterValidate(harness::Ctx& ctx) {
  auto c = api(ctx);
  submit(c, apiBody("s3://calls/five-hours.wav", 18000, "en"), "t-1");
  submit(c, apiBody("s3://calls/klingon.wav", 95, "xx"), "t-1");
  const auto staged = ctx.Redis.LRange("audio:staged", 0, -1);
  ctx.Assert(staged.empty(), "requests that must be refused (five hours; language xx) staged %q: the download is paid before the metadata is checked", staged);
  const auto r = submit(c, apiBody(kRef, 95, "en"), "t-1").first;
  ctx.Equal(r.Status, 202, "a valid request (%s)", r.Text());
  ctx.Equal(ctx.Redis.LRange("audio:staged", 0, -1), {kRef}, "a valid request stages its audio once; audio:staged");
}

void CheckAudioDedupe(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto [first, b1] = submit(c, apiBody(kRef, 95, "en"), "t-1");
  const auto [replay, b2] = submit(c, apiBody(kRef, 95, "en"), "t-1");
  const auto [other, b3] = submit(c, apiBody(kRef, 95, "en"), "t-2");
  ctx.Equal(first.Status, 202, "the first submit (%s)", first.Text());
  ctx.Assert(replay.Status == 200 || replay.Status == 202, "the retried submit answered %d: %s", replay.Status, replay.Text());
  ctx.Equal(jobIdOf(b2), jobIdOf(b1), "a retried submit of the same audio must answer the job that exists, not a second job transcribed and billed twice; the job id");
  ctx.Assert(other.Status == 202 && jobIdOf(b3) != jobIdOf(b1), "tenant t-2 submitting the same audio must get a job of its own, got %d %s", other.Status, other.Text());
  ctx.Equal(ctx.Redis.LRange("audio:staged", 0, -1), {kRef, kRef}, "one staging per job after a submit, its retry and another tenant's submit; audio:staged");
}
`,
  },
  hints: [
    'Submit the same recording twice: two job ids come back and the audio store logs two downloads. A five-hour file and a language hint of `xx` are accepted as well.',
    'The handler stages the audio on its first line and never compares the duration or the language with anything; `jobs.create` mints a new id on every call, and the audio index it writes is never read.',
    'Refuse `duration_seconds` outside `1..MAX_DURATION_SECONDS` and a language not in `ALLOWED_LANGUAGES` with 400 first, answer `jobs.find_by_audio(tenant, audio_hash)` with 200 when it exists, and only then `audio.stage` and `jobs.create`.',
  ],
  debrief: `The order is the fix: metadata costs nothing and the download is billed per byte, so every refusal the body can decide is decided before \`audio.stage\`. The audio hash turns a client retry into a lookup of the job that already exists, and scoping it by tenant keeps two customers who upload the same public recording from sharing one job and its transcript. Answering 200 for the replay lets the client tell it from a new job. Production services hash the object's bytes or its ETag rather than its name, read the duration from the container header instead of trusting the client, and make the lookup and the create one atomic step, since two submits can still race between them.`,
};
