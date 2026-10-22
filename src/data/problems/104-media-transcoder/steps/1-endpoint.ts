import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/transcodes: source and preset pinned',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db', 'source'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body, mints a job id and returns \`201\`. It compiles, it serves the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/transcodes\` with body
\`{"source": {"uri": "s3://raw/movie.mp4", "sha256": "…", "duration_s": 5400}, "preset": "h264-720p", "output": {"bucket": "renditions", "prefix": "movies/42"}}\`.

- \`source.uri\` is required (**400** when empty), \`source.sha256\` is exactly **64 lowercase hex**
  characters (**400** otherwise), and \`source.duration_s\` is positive (**400** otherwise).
- \`output.bucket\` and \`output.prefix\` are required (**400** when either is empty).
- The submission is idempotent by \`(source sha256, preset id)\`: a lookup keyed by that pair returns
  the **existing** job instead of starting a second one. A replay answers **200** with
  \`{"job_id": …, "state": …, "deduped": true}\`; a first submit answers **201** with
  \`"deduped": false\`.
- \`preset\` is resolved against the **server-side preset definitions** (\`h264-720p\`,
  \`h264-1080p\`, \`h265-1080p\`): each definition carries its container, codec and encoder
  arguments. The caller never supplies the encoder command.
- The request may still carry an \`args\` list from older clients; it is accepted for compatibility
  and **never read**. Passing caller-supplied arguments to the encoder is a shell injection surface
  and lets a caller burn the cluster on any filter graph it likes.
- A preset id that is malformed (not \`^[a-z0-9][a-z0-9._-]{0,63}$\`) or not in the definitions is
  **404** — the preset is a resource, an unknown one does not exist.

**Failure mode the checks target.** The draft has no dedupe at all, so a client retry (or two
workers picking up the same upload) encodes the same source twice and pays for it twice; it hands
\`body.args\` straight to the encoder, so any caller picks the filters, the codec and the
arguments; and it never looks the preset up, so a typo produces a job that fails minutes later in a
worker instead of a \`404\` at submit time.`,
  sequence: {
    participants: ['Client', 'Transcoder API', 'job store', 'Source store'],
    messages: [
      {from: 'Client', to: 'Transcoder API', label: 'POST /v1/transcodes · source · preset · output', kind: 'sync'},
      {from: 'Transcoder API', to: 'Transcoder API', label: 'validate uri · sha256 · duration · output', kind: 'sync'},
      {from: 'Transcoder API', to: 'Transcoder API', label: 'resolve preset definition (server-side)', kind: 'sync'},
      {from: 'Transcoder API', to: 'job store', label: 'find(sha256, preset)', kind: 'sync'},
      {from: 'job store', to: 'Transcoder API', label: 'existing job / none', kind: 'reply'},
      {from: 'Transcoder API', to: 'job store', label: 'create(sha256, preset, output)', kind: 'async'},
      {from: 'Transcoder API', to: 'Source store', label: 'plan segments from duration_s', kind: 'sync'},
      {from: 'Transcoder API', to: 'Client', label: '201 {job_id, segments} · 200 deduped', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/transcodes',
      detail: 'Register the submit route on `POST /v1/transcodes`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/transcodes["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/transcodes['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/transcodes"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"transcodes"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/transcodes"/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Keys the job by (source sha256, preset)',
      detail:
        'The job store is queried with `(source sha256, preset id)` before anything is created; a hit returns the existing job (200, `deduped: true`) instead of starting a second encode. The draft mints a fresh job id on every submit.',
      match: {
        python: {all: [/jobs\.find\(/, /sha256/, /existing/, /status_code\s*=\s*200/]},
        typescript: {all: [/jobs\.find\(/, /sha256/, /existing/, /code\(\s*200\s*\)/]},
        go: {all: [/jobs\.Find\(/, /SHA256/, /existing/, /StatusOK/]},
        scala: {all: [/jobs\.find\(/, /sha256/, /existing/, /StatusCodes\.OK/]},
        cpp: {all: [/jobs\.find\(/, /sha256/, /existing/, /\b200\b/]},
      },
    },
    {
      id: 'preset-args',
      title: 'Resolves the preset definition, never the caller arguments',
      detail:
        'The encoder arguments come from the server-side preset definitions; the request’s `args` field is never read. The draft forwards `body.args` to the encoder, so a caller chooses the filters and the codec.',
      match: {
        python: {all: [/PRESETS\s*=\s*\{/, /args\s*=\s*PRESETS\[/], none: [/body\.args/]},
        typescript: {all: [/const PRESETS/, /args = PRESETS\[/], none: [/body\.args/]},
        go: {all: [/var presets = map\[string\]/, /args := presets\[/], none: [/body\.Args/]},
        scala: {all: [/Presets\s*=\s*Map\(/, /val args = Presets\(/], none: [/body\.args/]},
        cpp: {all: [/kPresets/, /args = kPresets\.at\(/], none: [/body\.args/]},
      },
    },
    {
      id: 'preset-404',
      title: 'Unknown or malformed preset id is 404',
      detail:
        'The preset id is checked against the id pattern and the definitions; a miss answers `404` before a job exists. The draft accepts any string and lets a worker fail later.',
      match: {
        python: {all: [/PRESET_RE/, /status_code\s*=\s*404/]},
        typescript: {all: [/PRESET_RE/, /code\(\s*404\s*\)/]},
        go: {all: [/presetRE/, /StatusNotFound/]},
        scala: {all: [/PresetRe/, /StatusCodes\.NotFound/]},
        cpp: {all: [/kPresetRe/, /\b404\b/]},
      },
    },
    {
      id: 'source-hash',
      title: 'Validates the source hash before keying',
      detail:
        'The sha256 is required to be 64 lowercase hex characters (**400** otherwise) — a dedupe key built from an unvalidated string lets two different sources collide or a malformed one create a junk job.',
      match: {
        python: {all: [/SHA256_RE/, /status_code\s*=\s*400/]},
        typescript: {all: [/SHA256_RE/, /code\(\s*400\s*\)/]},
        go: {all: [/sha256RE/, /StatusBadRequest/]},
        scala: {all: [/Sha256Re/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kSha256Re/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("transcoder")


class Source(BaseModel):
    uri: str
    sha256: str
    duration_s: float


class Output(BaseModel):
    bucket: str
    prefix: str


class SubmitRequest(BaseModel):
    source: Source
    preset: str
    output: Output
    args: list[str] = []


@app.post("/v1/transcodes")
def submit(body: SubmitRequest) -> JSONResponse:
    # TODO: this draft never dedupes on (source sha256, preset), hands the caller's ffmpeg
    # arguments straight to the encoder, and checks neither the hash nor the preset id.
    # Review all three before this reaches a worker.
    job_id = str(uuid.uuid4())
    logger.info("transcode job=%s preset=%s args=%s", job_id, body.preset, body.args)
    return JSONResponse({"job_id": job_id, "state": "queued", "args": body.args}, status_code=201)
`,
      solution: `import logging
import math
import re
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI()
logger = logging.getLogger("transcoder")

SEGMENT_SECONDS = 6
PRESET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PRESETS = {
    "h264-720p": {"container": "mp4", "vcodec": "libx264", "args": ["-vf", "scale=1280:720", "-crf", "21"]},
    "h264-1080p": {"container": "mp4", "vcodec": "libx264", "args": ["-vf", "scale=1920:1080", "-crf", "21"]},
    "h265-1080p": {"container": "mp4", "vcodec": "libx265", "args": ["-vf", "scale=1920:1080", "-crf", "24"]},
}


class Source(BaseModel):
    uri: str
    sha256: str
    duration_s: float


class Output(BaseModel):
    bucket: str
    prefix: str


class SubmitRequest(BaseModel):
    source: Source
    preset: str
    output: Output
    # Accepted so older clients keep sending it, never read: the preset decides the encoder command.
    args: list[str] = Field(default_factory=list)


class JobStore:
    def find(self, source_sha256: str, preset: str) -> dict | None:
        """The job already encoding (source_sha256, preset), if one exists."""
        raise NotImplementedError

    def create(self, source_sha256: str, preset: str, source_uri: str, output: Output) -> dict:
        """Create and persist a queued job for (source_sha256, preset)."""
        raise NotImplementedError


jobs = JobStore()


@app.post("/v1/transcodes")
def submit(body: SubmitRequest) -> JSONResponse:
    if body.source.uri == "":
        raise HTTPException(status_code=400, detail="source.uri is required")
    if SHA256_RE.fullmatch(body.source.sha256) is None:
        raise HTTPException(status_code=400, detail="source.sha256 must be 64 lowercase hex characters")
    if body.source.duration_s <= 0:
        raise HTTPException(status_code=400, detail="source.duration_s must be positive")
    if body.output.bucket == "" or body.output.prefix == "":
        raise HTTPException(status_code=400, detail="output target is incomplete")
    if PRESET_RE.fullmatch(body.preset) is None or body.preset not in PRESETS:
        raise HTTPException(status_code=404, detail="unknown preset")

    existing = jobs.find(body.source.sha256, body.preset)
    if existing is not None:
        logger.info("transcode deduped job=%s preset=%s", existing["job_id"], body.preset)
        return JSONResponse(
            {"job_id": existing["job_id"], "state": existing["state"], "deduped": True}, status_code=200
        )

    args = PRESETS[body.preset]["args"]
    job = jobs.create(body.source.sha256, body.preset, body.source.uri, body.output)
    segments = int(math.ceil(body.source.duration_s / SEGMENT_SECONDS))
    logger.info("transcode queued job=%s preset=%s segments=%d", job["job_id"], body.preset, segments)
    return JSONResponse(
        {"job_id": job["job_id"], "state": job["state"], "deduped": False, "segments": segments, "args": args},
        status_code=201,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/transcodes: a model-generated draft that trusts the caller's arguments. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface SubmitBody {
  source: {uri: string; sha256: string; duration_s: number};
  preset: string;
  output: {bucket: string; prefix: string};
  args?: string[];
}

app.post('/v1/transcodes', async (request, reply) => {
  // TODO: this draft never dedupes on (source sha256, preset), hands the caller's ffmpeg
  // arguments straight to the encoder, and checks neither the hash nor the preset id.
  // Review all three before this reaches a worker.
  const body = request.body as SubmitBody;
  const jobId = randomUUID();
  request.log.info({job_id: jobId, preset: body.preset, args: body.args}, 'transcode queued');
  return reply.code(201).send({job_id: jobId, state: 'queued', args: body.args});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/transcodes: idempotent by (source hash, preset); the preset owns the command. */
import Fastify from 'fastify';

import {jobs} from './state';

export const app = Fastify();

const SEGMENT_SECONDS = 6;
const PRESET_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

interface PresetDef {
  container: string;
  vcodec: string;
  args: string[];
}

const PRESETS: Record<string, PresetDef> = {
  'h264-720p': {container: 'mp4', vcodec: 'libx264', args: ['-vf', 'scale=1280:720', '-crf', '21']},
  'h264-1080p': {container: 'mp4', vcodec: 'libx264', args: ['-vf', 'scale=1920:1080', '-crf', '21']},
  'h265-1080p': {container: 'mp4', vcodec: 'libx265', args: ['-vf', 'scale=1920:1080', '-crf', '24']},
};

interface SubmitBody {
  source: {uri: string; sha256: string; duration_s: number};
  preset: string;
  output: {bucket: string; prefix: string};
  /** Accepted so older clients keep sending it, never read: the preset decides the encoder command. */
  args?: string[];
}

app.post('/v1/transcodes', async (request, reply) => {
  const body = request.body as Partial<SubmitBody> | null;
  if (body === null || typeof body !== 'object' || body.source === undefined || body.preset === undefined)
    return reply.code(400).send({error: 'source, preset and output are required'});
  if (body.output === undefined || body.output.bucket === '' || body.output.prefix === '')
    return reply.code(400).send({error: 'output target is incomplete'});
  if (!SHA256_RE.test(body.source.sha256))
    return reply.code(400).send({error: 'source.sha256 must be 64 lowercase hex characters'});
  if (!(body.source.duration_s > 0)) return reply.code(400).send({error: 'source.duration_s must be positive'});
  if (!PRESET_RE.test(body.preset) || PRESETS[body.preset] === undefined)
    return reply.code(404).send({error: 'unknown preset'});

  const existing = await jobs.find(body.source.sha256, body.preset);
  if (existing !== null) {
    request.log.info({job_id: existing.job_id, preset: body.preset}, 'transcode deduped');
    return reply.code(200).send({job_id: existing.job_id, state: existing.state, deduped: true});
  }

  const args = PRESETS[body.preset].args;
  const job = await jobs.create(body.source.sha256, body.preset, body.source.uri, body.output);
  const segments = Math.ceil(body.source.duration_s / SEGMENT_SECONDS);
  request.log.info({job_id: job.job_id, preset: body.preset, segments}, 'transcode queued');
  return reply.code(201).send({job_id: job.job_id, state: job.state, deduped: false, segments, args});
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

type Source struct {
	URI       string  \`json:"uri"\`
	SHA256    string  \`json:"sha256"\`
	DurationS float64 \`json:"duration_s"\`
}

type Output struct {
	Bucket string \`json:"bucket"\`
	Prefix string \`json:"prefix"\`
}

type SubmitRequest struct {
	Source Source   \`json:"source"\`
	Preset string   \`json:"preset"\`
	Output Output   \`json:"output"\`
	Args   []string \`json:"args"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	var body SubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft never dedupes on (source sha256, preset), hands the caller's ffmpeg
	// arguments straight to the encoder, and checks neither the hash nor the preset id.
	// Review all three before this reaches a worker.
	jobID := uuid.NewString()
	log.Printf("transcode job=%s preset=%s args=%v", jobID, body.Preset, body.Args)
	writeJSON(rw, http.StatusCreated, map[string]any{"job_id": jobID, "state": "queued", "args": body.Args})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/transcodes", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"regexp"

	"github.com/google/uuid"
)

const segmentSeconds = 6.0

type presetDef struct {
	Container string
	VCodec    string
	Args      []string
}

var presets = map[string]presetDef{
	"h264-720p":  {Container: "mp4", VCodec: "libx264", Args: []string{"-vf", "scale=1280:720", "-crf", "21"}},
	"h264-1080p": {Container: "mp4", VCodec: "libx264", Args: []string{"-vf", "scale=1920:1080", "-crf", "21"}},
	"h265-1080p": {Container: "mp4", VCodec: "libx265", Args: []string{"-vf", "scale=1920:1080", "-crf", "24"}},
}

var (
	presetRE = regexp.MustCompile(\`^[a-z0-9][a-z0-9._-]{0,63}$\`)
	sha256RE = regexp.MustCompile(\`^[0-9a-f]{64}$\`)
)

type Source struct {
	URI       string  \`json:"uri"\`
	SHA256    string  \`json:"sha256"\`
	DurationS float64 \`json:"duration_s"\`
}

type Output struct {
	Bucket string \`json:"bucket"\`
	Prefix string \`json:"prefix"\`
}

type SubmitRequest struct {
	Source Source   \`json:"source"\`
	Preset string   \`json:"preset"\`
	Output Output   \`json:"output"\`
	// Accepted so older clients keep sending it, never read: the preset decides the encoder command.
	Args []string \`json:"args"\`
}

type JobStore struct{}

func (s *JobStore) Find(ctx context.Context, sourceSHA256, preset string) (map[string]any, error) {
	return nil, nil
}

func (s *JobStore) Create(ctx context.Context, sourceSHA256, preset, sourceURI string, out Output) (map[string]any, error) {
	return map[string]any{"job_id": uuid.NewString(), "state": "queued"}, nil
}

var jobs = &JobStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	var body SubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Source.URI == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "source.uri is required"})
		return
	}
	if !sha256RE.MatchString(body.Source.SHA256) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "source.sha256 must be 64 lowercase hex"})
		return
	}
	if body.Source.DurationS <= 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "source.duration_s must be positive"})
		return
	}
	if body.Output.Bucket == "" || body.Output.Prefix == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "output target is incomplete"})
		return
	}
	if !presetRE.MatchString(body.Preset) || presets[body.Preset].Container == "" {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown preset"})
		return
	}

	existing, err := jobs.Find(r.Context(), body.Source.SHA256, body.Preset)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		log.Printf("transcode deduped job=%v preset=%s", existing["job_id"], body.Preset)
		writeJSON(rw, http.StatusOK, map[string]any{
			"job_id": existing["job_id"], "state": existing["state"], "deduped": true,
		})
		return
	}

	args := presets[body.Preset].Args
	job, err := jobs.Create(r.Context(), body.Source.SHA256, body.Preset, body.Source.URI, body.Output)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	segments := int(math.Ceil(body.Source.DurationS / segmentSeconds))
	log.Printf("transcode queued job=%v preset=%s segments=%d", job["job_id"], body.Preset, segments)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"job_id": job["job_id"], "state": job["state"], "deduped": false, "segments": segments, "args": args,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/transcodes", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.util.UUID

final case class Source(uri: String, sha256: String, duration_s: Double)
final case class Output(bucket: String, prefix: String)
final case class SubmitRequest(source: Source, preset: String, output: Output, args: List[String] = Nil)

object Api {
  implicit val system: ActorSystem = ActorSystem("media-transcoder")
  implicit val sourceFormat: RootJsonFormat[Source] = jsonFormat3(Source.apply)
  implicit val outputFormat: RootJsonFormat[Output] = jsonFormat2(Output.apply)
  implicit val submitFormat: RootJsonFormat[SubmitRequest] = jsonFormat4(SubmitRequest.apply)

  val route: Route = path("v1" / "transcodes") {
    post {
      entity(as[SubmitRequest]) { body =>
        // TODO: this draft never dedupes on (source sha256, preset), hands the caller's ffmpeg
        // arguments straight to the encoder, and checks neither the hash nor the preset id.
        // Review all three before this reaches a worker.
        val jobId = UUID.randomUUID().toString
        log.info("transcode job={} preset={} args={}", jobId, body.preset, body.args)
        complete(StatusCodes.Created, s"""{"job_id":"$jobId","state":"queued"}""")
      }
    }
  }

  val log = system.log

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.util.UUID
import scala.math.ceil

final case class Source(uri: String, sha256: String, duration_s: Double)
final case class Output(bucket: String, prefix: String)
final case class SubmitRequest(source: Source, preset: String, output: Output, args: List[String] = Nil)
final case class PresetDef(container: String, vcodec: String, args: List[String])
final case class Job(jobId: String, state: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("media-transcoder")
  implicit val sourceFormat: RootJsonFormat[Source] = jsonFormat3(Source.apply)
  implicit val outputFormat: RootJsonFormat[Output] = jsonFormat2(Output.apply)
  implicit val submitFormat: RootJsonFormat[SubmitRequest] = jsonFormat4(SubmitRequest.apply)

  val log = system.log
  val SegmentSeconds = 6.0
  val PresetRe = "^[a-z0-9][a-z0-9._-]{0,63}$".r
  val Sha256Re = "^[0-9a-f]{64}$".r
  val Presets = Map(
    "h264-720p" -> PresetDef("mp4", "libx264", List("-vf", "scale=1280:720", "-crf", "21")),
    "h264-1080p" -> PresetDef("mp4", "libx264", List("-vf", "scale=1920:1080", "-crf", "21")),
    "h265-1080p" -> PresetDef("mp4", "libx265", List("-vf", "scale=1920:1080", "-crf", "24"))
  )

  val jobs = new JobStore

  def jobJson(jobId: String, state: String, deduped: Boolean, segments: Int, args: List[String]): String = {
    val rendered = args.map(arg => "\\"" + arg + "\\"").mkString("[", ",", "]")
    s"""{"job_id":"$jobId","state":"$state","deduped":$deduped,"segments":$segments,"args":$rendered}"""
  }

  def submit(body: SubmitRequest): Either[(StatusCode, String), (StatusCode, String)] = {
    if (body.source.uri.isEmpty) return Left(StatusCodes.BadRequest -> "source.uri is required")
    if (Sha256Re.findFirstIn(body.source.sha256).isEmpty)
      return Left(StatusCodes.BadRequest -> "source.sha256 must be 64 lowercase hex characters")
    if (body.source.duration_s <= 0) return Left(StatusCodes.BadRequest -> "source.duration_s must be positive")
    if (body.output.bucket.isEmpty || body.output.prefix.isEmpty)
      return Left(StatusCodes.BadRequest -> "output target is incomplete")
    if (PresetRe.findFirstIn(body.preset).isEmpty || !Presets.contains(body.preset))
      return Left(StatusCodes.NotFound -> "unknown preset")

    jobs.find(body.source.sha256, body.preset) match {
      case Some(existing) =>
        log.info("transcode deduped job={} preset={}", existing.jobId, body.preset)
        Right(StatusCodes.OK -> jobJson(existing.jobId, existing.state, deduped = true, segments = 0, args = Nil))
      case None =>
        val args = Presets(body.preset).args
        val job = jobs.create(body.source.sha256, body.preset, body.source.uri)
        val segments = ceil(body.source.duration_s / SegmentSeconds).toInt
        log.info("transcode queued job={} preset={} segments={}", job.jobId, body.preset, segments)
        Right(StatusCodes.Created -> jobJson(job.jobId, job.state, deduped = false, segments, args))
    }
  }

  val route: Route = path("v1" / "transcodes") {
    post {
      entity(as[SubmitRequest]) { body =>
        submit(body) match {
          case Left((status, error))  => complete(status, error)
          case Right((status, ok))    => complete(status, ok)
        }
      }
    }
  }

  def main(args: Array[String]): Unit = Http().newServerAt("0.0.0.0", 8443).bind(route)
}

class JobStore {
  /** The job already encoding (sourceSha256, preset), if one exists. */
  def find(sourceSha256: String, preset: String): Option[Job] = None

  /** Create and persist a queued job for (sourceSha256, preset). */
  def create(sourceSha256: String, preset: String, sourceUri: String): Job =
    Job(UUID.randomUUID().toString, "queued")
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

std::string newJobId() {
  static std::atomic<uint64_t> counter{0};
  return "job-" + std::to_string(++counter);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/transcodes", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    // TODO: this draft never dedupes on (source sha256, preset), hands the caller's ffmpeg
    // arguments straight to the encoder, and checks neither the hash nor the preset id.
    // Review all three before this reaches a worker.
    const std::string jobId = newJobId();
    const std::string preset = body.value("preset", "");
    const std::vector<std::string> args = body.value("args", std::vector<std::string>{});
    std::clog << "transcode job=" << jobId << " preset=" << preset << " args=" << args.size() << std::endl;
    res.status = 201;
    res.set_content(json{{"job_id", jobId}, {"state", "queued"}, {"args", args}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <cmath>
#include <iostream>
#include <map>
#include <optional>
#include <regex>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

struct PresetDef {
  std::string container;
  std::string vcodec;
  std::vector<std::string> args;
};

const std::map<std::string, PresetDef> kPresets = {
    {"h264-720p", {"mp4", "libx264", {"-vf", "scale=1280:720", "-crf", "21"}}},
    {"h264-1080p", {"mp4", "libx264", {"-vf", "scale=1920:1080", "-crf", "21"}}},
    {"h265-1080p", {"mp4", "libx265", {"-vf", "scale=1920:1080", "-crf", "24"}}},
};

const std::regex kPresetRe(R"(^[a-z0-9][a-z0-9._-]{0,63}$)");
const std::regex kSha256Re(R"(^[0-9a-f]{64}$)");
const double kSegmentSeconds = 6.0;

std::string newJobId() {
  static std::atomic<uint64_t> counter{0};
  return "job-" + std::to_string(++counter);
}

}  // namespace

class JobStore {
 public:
  /** The job already encoding (source_sha256, preset), if one exists. */
  std::optional<json> find(const std::string& source_sha256, const std::string& preset) { return std::nullopt; }

  /** Create and persist a queued job for (source_sha256, preset). */
  json create(const std::string& source_sha256, const std::string& preset, const std::string& source_uri) {
    return json{{"job_id", newJobId()}, {"state", "queued"}};
  }
};

JobStore jobs;

int main() {
  httplib::Server svr;

  svr.Post("/v1/transcodes", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded() || !body.contains("source") || !body.contains("preset") || !body.contains("output")) {
      res.status = 400;
      res.set_content(json{{"error", "source, preset and output are required"}}.dump(), "application/json");
      return;
    }
    const json source = body.at("source");
    const std::string preset = body.at("preset").get<std::string>();
    const json out = body.at("output");
    if (source.value("uri", "").empty()) {
      res.status = 400;
      res.set_content(json{{"error", "source.uri is required"}}.dump(), "application/json");
      return;
    }
    const std::string sha256 = source.value("sha256", "");
    if (!std::regex_match(sha256, kSha256Re)) {
      res.status = 400;
      res.set_content(json{{"error", "source.sha256 must be 64 lowercase hex characters"}}.dump(), "application/json");
      return;
    }
    if (!(source.value("duration_s", 0.0) > 0.0)) {
      res.status = 400;
      res.set_content(json{{"error", "source.duration_s must be positive"}}.dump(), "application/json");
      return;
    }
    if (out.value("bucket", "").empty() || out.value("prefix", "").empty()) {
      res.status = 400;
      res.set_content(json{{"error", "output target is incomplete"}}.dump(), "application/json");
      return;
    }
    if (!std::regex_match(preset, kPresetRe) || kPresets.count(preset) == 0) {
      res.status = 404;
      res.set_content(json{{"error", "unknown preset"}}.dump(), "application/json");
      return;
    }

    // The preset decides the encoder command; a caller-supplied args list is never read.
    if (auto existing = jobs.find(sha256, preset); existing.has_value()) {
      std::clog << "transcode deduped job=" << existing->at("job_id") << " preset=" << preset << std::endl;
      res.status = 200;
      res.set_content(
          json{{"job_id", existing->at("job_id")}, {"state", existing->at("state")}, {"deduped", true}}.dump(),
          "application/json");
      return;
    }

    const std::vector<std::string> args = kPresets.at(preset).args;
    const json job = jobs.create(sha256, preset, source.value("uri", ""));
    const int segments = static_cast<int>(std::ceil(source.value("duration_s", 0.0) / kSegmentSeconds));
    std::clog << "transcode queued job=" << job.at("job_id") << " preset=" << preset << " segments=" << segments
              << std::endl;
    res.status = 201;
    res.set_content(
        json{{"job_id", job.at("job_id")},
             {"state", job.at("state")},
             {"deduped", false},
             {"segments", segments},
             {"args", args}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses before the job exists: uri, 64-hex sha256, positive duration, complete output target, then the preset id. Every one of them answers 400 or 404 without creating a row or a worker message, which is what keeps junk out of the cluster.',
    'The dedupe key is the pair, not the request: `find(source.sha256, preset)` returns the job that is already encoding that content at that preset, and the replay answers 200 with `deduped: true`. Keying on the upload id or on a fresh UUID is what lets the same source be encoded twice.',
    'The encoder command is a server-side fact. Keep `PRESETS` as the only source of container, codec and `args`, accept a caller `args` list for compatibility and never read it — otherwise a caller chooses the filter graph, the codec and the arguments that run on your workers.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of a media pipeline. The draft reads fine because the demo uploads one file once and hands the encoder exactly the arguments the example used. Three defects are being checked: dedupe on the content key (a retry or a second pickup must return the existing job instead of paying for the file twice), server-side preset resolution (the caller names a preset, never an encoder command — passing caller arguments into an encoder is a shell injection surface), and preset validation (an unknown or malformed preset is a 404 at submit time, not a worker failure minutes later). The hash check is the quieter one: a dedupe key built from an unvalidated string is how two different files end up sharing one job. Real pipelines add a signed upload URL per source, a per-tenant concurrency cap and an idempotency key for callers that do not know the content hash yet.`,
};
