import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/transcodes: one job per source and preset, server-side presets',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/transcodes\` with \`X-Tenant-Id\` and
\`{"source": {"uri", "sha256", "duration_s"}, "preset", "output": {"bucket", "prefix"}, "args"}\`:
it calls \`jobs.create\` with the caller's \`args\` as the encoder arguments and answers \`201\`
\`{job_id, state, preset, segment_count, deduped: false}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A client that retries a submit pays for the same encode twice;
a caller picks the encoder's filters and codec; a typo in a preset id fails minutes later in a
worker; and a malformed hash becomes part of the dedupe key.

- \`source.uri\`, \`output.bucket\` and \`output.prefix\` are required, \`source.duration_s\` is
  positive and \`source.sha256\` is exactly 64 lowercase hex characters; anything else is **400**.
- The encoder arguments come from \`presets.encoder_args(preset)\`; an unknown preset is **404**.
  The caller's \`args\` stay accepted and unread.
- A submit is keyed by **(tenant, sha256, preset)**: \`jobs.find\` before \`jobs.create\`, and a hit
  answers the existing job with **200** and \`deduped: true\`.`,
  sequence: {
    participants: ['Client', 'transcoderd', 'presets', 'job store'],
    messages: [
      {
        from: 'Client',
        to: 'transcoderd',
        label: 'POST /v1/transcodes · X-Tenant-Id · source · preset · output',
        kind: 'sync',
      },
      {from: 'transcoderd', to: 'transcoderd', label: 'validate uri · sha256 · duration · output → 400', kind: 'sync'},
      {from: 'transcoderd', to: 'presets', label: 'encoder_args(preset)', kind: 'sync'},
      {from: 'presets', to: 'transcoderd', label: 'arguments · none → 404', kind: 'reply'},
      {from: 'transcoderd', to: 'job store', label: 'find(tenant, sha256, preset)', kind: 'sync'},
      {from: 'job store', to: 'transcoderd', label: 'existing job → 200 deduped', kind: 'reply'},
      {from: 'transcoderd', to: 'job store', label: 'create(…, preset arguments, …)', kind: 'sync'},
      {from: 'transcoderd', to: 'Client', label: '201 {job_id, segment_count, deduped: false}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/transcodes',
      detail: 'Register `POST /v1/transcodes`: a valid submit answers 201 with the job id and its segment count.',
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
      title: 'Keys the job by (tenant, source sha256, preset)',
      detail:
        'The job store is asked (`jobs.find`) before anything is created; a hit answers the existing job with 200 and `deduped: true`. The starter creates a job on every submit.',
      match: {
        python: {all: [/jobs\.find\(/, /deduped/], order: [/jobs\.find\(/, /jobs\.create\(/]},
        typescript: {all: [/\bfind\(\s*tenant/, /deduped/], order: [/\bfind\(\s*tenant/, /\bcreate\(\s*tenant/]},
        go: {all: [/jobs\.Find\(/, /deduped/], order: [/jobs\.Find\(/, /jobs\.Create\(/]},
        scala: {all: [/Jobs\.find\(/, /deduped/], order: [/Jobs\.find\(/, /Jobs\.create\(/]},
        cpp: {all: [/jobs::find\(/, /deduped/], order: [/jobs::find\(/, /jobs::create\(/]},
      },
    },
    {
      id: 'preset-args',
      title: 'Runs the preset definition, never the caller arguments',
      detail:
        'The encoder arguments stored on the job come from `encoder_args(preset)`; the request’s `args` field is never read. The starter stores the caller’s list, so any caller chooses filters and codecs.',
      match: {
        python: {all: [/presets\.encoder_args\(/], none: [/body\.args\b/]},
        typescript: {all: [/\bencoderArgs\(\s*preset/], none: [/body\.args\b/, /\bargs\s*\?\?/]},
        go: {all: [/presets\.EncoderArgs\(/], none: [/body\.Args\b/]},
        scala: {all: [/Presets\.encoderArgs\(/], none: [/"args"/]},
        cpp: {all: [/presets::encoderArgs\(/], none: [/"args"/]},
      },
    },
    {
      id: 'preset-404',
      title: 'An unknown preset is 404 before a job exists',
      detail:
        'A preset id the definitions do not hold answers **404** and creates nothing; the starter accepts any string and lets a worker fail on it later.',
      match: {
        python: {all: [/presets\.encoder_args\(/, /\b404\b/]},
        typescript: {all: [/\bencoderArgs\(\s*preset/, /\b404\b/]},
        go: {all: [/presets\.EncoderArgs\(/, /StatusNotFound|\b404\b/]},
        scala: {all: [/Presets\.encoderArgs\(/, /NotFound|\b404\b/]},
        cpp: {all: [/presets::encoderArgs\(/, /\b404\b/]},
      },
    },
    {
      id: 'source-hash',
      title: 'Validates the source before keying on it',
      detail:
        'The sha256 must be 64 lowercase hex characters and the uri, bucket, prefix and a positive duration present, else **400**: a dedupe key built from an unchecked string lets junk jobs in.',
      match: {
        python: {all: [/SHA256_RE|\[0-9a-f\]\{64\}/, /\b400\b/]},
        typescript: {all: [/SHA256_RE|\[0-9a-f\]\{64\}/, /\b400\b/]},
        go: {all: [/sha256RE|\[0-9a-f\]\{64\}/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/Sha256Re|\[0-9a-f\]\{64\}/, /BadRequest|\b400\b/]},
        cpp: {all: [/kSha256Re|\[0-9a-f\]\{64\}/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from transcoder import jobs  # jobs.find, jobs.create
from transcoder import presets  # presets.encoder_args

app = FastAPI()


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


def answer(job: dict, status: int, deduped: bool) -> JSONResponse:
    body = {"job_id": job["job_id"], "state": job["state"], "preset": job["preset"], "segment_count": job["segment_count"], "deduped": deduped}
    return JSONResponse(body, status_code=status)


@app.post("/v1/transcodes")
def submit(body: SubmitRequest, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    source, output = body.source, body.output
    job = jobs.create(tenant, source.uri, source.sha256, source.duration_s, body.preset, body.args, output.bucket, output.prefix)
    return answer(job, 201, False)
`,
      solution: `import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from transcoder import jobs  # jobs.find, jobs.create
from transcoder import presets  # presets.encoder_args

app = FastAPI()

SHA256_RE = re.compile(r"[0-9a-f]{64}")


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
    args: list[str] = []  # accepted from older clients, never read


def answer(job: dict, status: int, deduped: bool) -> JSONResponse:
    body = {"job_id": job["job_id"], "state": job["state"], "preset": job["preset"], "segment_count": job["segment_count"], "deduped": deduped}
    return JSONResponse(body, status_code=status)


@app.post("/v1/transcodes")
def submit(body: SubmitRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    source, output = body.source, body.output
    if not source.uri or not output.bucket or not output.prefix or source.duration_s <= 0:
        raise HTTPException(status_code=400, detail="source.uri, output.bucket, output.prefix and a positive source.duration_s are required")
    if not SHA256_RE.fullmatch(source.sha256):
        raise HTTPException(status_code=400, detail="source.sha256 must be 64 lowercase hex characters")
    # The preset decides the encoder command line; the caller only names it.
    args = presets.encoder_args(body.preset)
    if args is None:
        raise HTTPException(status_code=404, detail=f"unknown preset {body.preset}")
    existing = jobs.find(tenant, source.sha256, body.preset)
    if existing is not None:
        return answer(existing, 200, True)
    job = jobs.create(tenant, source.uri, source.sha256, source.duration_s, body.preset, args, output.bucket, output.prefix)
    return answer(job, 201, False)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Job, create, find} from 'transcoder/jobs';
import {encoderArgs} from 'transcoder/presets';

export const app = Fastify();

interface SubmitBody {
  source?: {uri?: string; sha256?: string; duration_s?: number};
  preset?: string;
  output?: {bucket?: string; prefix?: string};
  args?: string[];
}

const answer = (job: Job, deduped: boolean) => ({job_id: job.job_id, state: job.state, preset: job.preset, segment_count: job.segment_count, deduped});

app.post('/v1/transcodes', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as SubmitBody;
  const {uri = '', sha256 = '', duration_s: durationS = 0} = body.source ?? {};
  const {bucket = '', prefix = ''} = body.output ?? {};
  const job = await create(tenant, uri, sha256, durationS, body.preset ?? '', body.args ?? [], bucket, prefix);
  return reply.code(201).send(answer(job, false));
});
`,
      solution: `import Fastify from 'fastify';

import {type Job, create, find} from 'transcoder/jobs';
import {encoderArgs} from 'transcoder/presets';

export const app = Fastify();

const SHA256_RE = /^[0-9a-f]{64}$/;

interface SubmitBody {
  source?: {uri?: string; sha256?: string; duration_s?: number};
  preset?: string;
  output?: {bucket?: string; prefix?: string};
  args?: string[]; // accepted from older clients, never read
}

const answer = (job: Job, deduped: boolean) => ({job_id: job.job_id, state: job.state, preset: job.preset, segment_count: job.segment_count, deduped});

app.post('/v1/transcodes', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as SubmitBody;
  const preset = body.preset ?? '';
  const {uri = '', sha256 = '', duration_s: durationS = 0} = body.source ?? {};
  const {bucket = '', prefix = ''} = body.output ?? {};
  if (uri === '' || bucket === '' || prefix === '' || !(durationS > 0)) {
    return reply.code(400).send({error: 'source.uri, output.bucket, output.prefix and a positive source.duration_s are required'});
  }
  if (!SHA256_RE.test(sha256)) return reply.code(400).send({error: 'source.sha256 must be 64 lowercase hex characters'});
  // The preset decides the encoder command line; the caller only names it.
  const args = encoderArgs(preset);
  if (args === null) return reply.code(404).send({error: \`unknown preset \${preset}\`});
  const existing = await find(tenant, sha256, preset);
  if (existing !== null) return reply.code(200).send(answer(existing, true));
  const job = await create(tenant, uri, sha256, durationS, preset, args, bucket, prefix);
  return reply.code(201).send(answer(job, false));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"transcoder/jobs" // jobs.Find, jobs.Create; presets.EncoderArgs lives in "transcoder/presets"
)

type submitRequest struct {
	Source struct {
		URI       string  \`json:"uri"\`
		SHA256    string  \`json:"sha256"\`
		DurationS float64 \`json:"duration_s"\`
	} \`json:"source"\`
	Preset string \`json:"preset"\`
	Output struct {
		Bucket string \`json:"bucket"\`
		Prefix string \`json:"prefix"\`
	} \`json:"output"\`
	Args []string \`json:"args"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func answer(rw http.ResponseWriter, status int, job *jobs.Job, deduped bool) {
	writeJSON(rw, status, map[string]any{"job_id": job.JobID, "state": job.State, "preset": job.Preset, "segment_count": job.SegmentCount, "deduped": deduped})
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body submitRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid JSON body", http.StatusBadRequest)
		return
	}
	job := jobs.Create(r.Context(), tenant, body.Source.URI, body.Source.SHA256, body.Source.DurationS, body.Preset, body.Args, body.Output.Bucket, body.Output.Prefix)
	answer(rw, http.StatusCreated, job, false)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/transcodes", submit)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"transcoder/jobs"    // jobs.Find, jobs.Create
	"transcoder/presets" // presets.EncoderArgs
)

var sha256RE = regexp.MustCompile("^[0-9a-f]{64}$")

type submitRequest struct {
	Source struct {
		URI       string  \`json:"uri"\`
		SHA256    string  \`json:"sha256"\`
		DurationS float64 \`json:"duration_s"\`
	} \`json:"source"\`
	Preset string \`json:"preset"\`
	Output struct {
		Bucket string \`json:"bucket"\`
		Prefix string \`json:"prefix"\`
	} \`json:"output"\`
	Args []string \`json:"args"\` // accepted from older clients, never read
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func answer(rw http.ResponseWriter, status int, job *jobs.Job, deduped bool) {
	writeJSON(rw, status, map[string]any{"job_id": job.JobID, "state": job.State, "preset": job.Preset, "segment_count": job.SegmentCount, "deduped": deduped})
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body submitRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid JSON body", http.StatusBadRequest)
		return
	}
	source, output := body.Source, body.Output
	if source.URI == "" || output.Bucket == "" || output.Prefix == "" || source.DurationS <= 0 {
		http.Error(rw, "source.uri, output.bucket, output.prefix and a positive source.duration_s are required", http.StatusBadRequest)
		return
	}
	if !sha256RE.MatchString(source.SHA256) {
		http.Error(rw, "source.sha256 must be 64 lowercase hex characters", http.StatusBadRequest)
		return
	}
	// The preset decides the encoder command line; the caller only names it.
	args, known := presets.EncoderArgs(body.Preset)
	if !known {
		http.Error(rw, "unknown preset "+body.Preset, http.StatusNotFound)
		return
	}
	if existing := jobs.Find(r.Context(), tenant, source.SHA256, body.Preset); existing != nil {
		answer(rw, http.StatusOK, existing, true)
		return
	}
	job := jobs.Create(r.Context(), tenant, source.URI, source.SHA256, source.DurationS, body.Preset, args, output.Bucket, output.Prefix)
	answer(rw, http.StatusCreated, job, false)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/transcodes", submit)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import transcoder.{Jobs, Presets} // Jobs.find, Jobs.create, Presets.encoderArgs

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def answer(status: StatusCode, job: Jobs.Job, deduped: Boolean): HttpResponse =
    json(status, JsObject("job_id" -> JsString(job.jobId), "state" -> JsString(job.state), "preset" -> JsString(job.preset),
      "segment_count" -> JsNumber(job.segmentCount), "deduped" -> JsBoolean(deduped)))

  private def obj(o: JsObject, name: String): JsObject = o.fields.get(name).collect { case x: JsObject => x }.getOrElse(JsObject.empty)
  private def text(o: JsObject, name: String): String = o.fields.get(name).collect { case JsString(s) => s }.getOrElse("")
  private def number(o: JsObject, name: String): Double = o.fields.get(name).collect { case JsNumber(n) => n.toDouble }.getOrElse(0.0)

  val route: Route = path("v1" / "transcodes") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject
            val (source, output) = (obj(body, "source"), obj(body, "output"))
            val args = body.fields.get("args").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
            val job = Jobs.create(tenant, text(source, "uri"), text(source, "sha256"), number(source, "duration_s"), text(body, "preset"), args,
              text(output, "bucket"), text(output, "prefix"))
            complete(answer(StatusCodes.Created, job, deduped = false))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import transcoder.{Jobs, Presets} // Jobs.find, Jobs.create, Presets.encoderArgs

object Api {
  val Sha256Re = "[0-9a-f]{64}".r

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def answer(status: StatusCode, job: Jobs.Job, deduped: Boolean): HttpResponse =
    json(status, JsObject("job_id" -> JsString(job.jobId), "state" -> JsString(job.state), "preset" -> JsString(job.preset),
      "segment_count" -> JsNumber(job.segmentCount), "deduped" -> JsBoolean(deduped)))

  private def obj(o: JsObject, name: String): JsObject = o.fields.get(name).collect { case x: JsObject => x }.getOrElse(JsObject.empty)
  private def text(o: JsObject, name: String): String = o.fields.get(name).collect { case JsString(s) => s }.getOrElse("")
  private def number(o: JsObject, name: String): Double = o.fields.get(name).collect { case JsNumber(n) => n.toDouble }.getOrElse(0.0)

  val route: Route = path("v1" / "transcodes") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject
            val (source, output) = (obj(body, "source"), obj(body, "output"))
            val (uri, sha256, durationS) = (text(source, "uri"), text(source, "sha256"), number(source, "duration_s"))
            val (bucket, prefix, preset) = (text(output, "bucket"), text(output, "prefix"), text(body, "preset"))
            if (uri.isEmpty || bucket.isEmpty || prefix.isEmpty || durationS <= 0)
              complete(StatusCodes.BadRequest -> "source.uri, output.bucket, output.prefix and a positive source.duration_s are required")
            else if (!Sha256Re.matches(sha256)) complete(StatusCodes.BadRequest -> "source.sha256 must be 64 lowercase hex characters")
            else
              // The preset decides the encoder command line; the caller only names it.
              Presets.encoderArgs(preset) match {
                case None => complete(StatusCodes.NotFound -> s"unknown preset $preset")
                case Some(args) =>
                  Jobs.find(tenant, sha256, preset) match {
                    case Some(existing) => complete(answer(StatusCodes.OK, existing, deduped = true))
                    case None =>
                      val job = Jobs.create(tenant, uri, sha256, durationS, preset, args, bucket, prefix)
                      complete(answer(StatusCodes.Created, job, deduped = false))
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
#include <vector>

#include "transcoder/jobs.h"     // jobs::find, jobs::create
#include "transcoder/presets.h"  // presets::encoderArgs

using json = nlohmann::json;

void answer(httplib::Response& res, int status, const jobs::Job& job, bool deduped) {
  res.status = status;
  res.set_content(json{{"job_id", job.job_id}, {"state", job.state}, {"preset", job.preset}, {"segment_count", job.segment_count}, {"deduped", deduped}}.dump(),
                  "application/json");
}

void submit(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content("invalid JSON body", "text/plain");
    return;
  }
  const json source = body.value("source", json::object());
  const json output = body.value("output", json::object());
  const jobs::Job job = jobs::create(tenant, source.value("uri", ""), source.value("sha256", ""), source.value("duration_s", 0.0), body.value("preset", ""),
                                     body.value("args", std::vector<std::string>{}), output.value("bucket", ""), output.value("prefix", ""));
  answer(res, 201, job, false);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/transcodes", submit); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <string>
#include <vector>

#include "transcoder/jobs.h"     // jobs::find, jobs::create
#include "transcoder/presets.h"  // presets::encoderArgs

using json = nlohmann::json;

const std::regex kSha256Re("[0-9a-f]{64}");

void answer(httplib::Response& res, int status, const jobs::Job& job, bool deduped) {
  res.status = status;
  res.set_content(json{{"job_id", job.job_id}, {"state", job.state}, {"preset", job.preset}, {"segment_count", job.segment_count}, {"deduped", deduped}}.dump(),
                  "application/json");
}

void submit(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content("invalid JSON body", "text/plain");
    return;
  }
  const json source = body.value("source", json::object());
  const json output = body.value("output", json::object());
  const std::string uri = source.value("uri", ""), sha256 = source.value("sha256", ""), preset = body.value("preset", "");
  const std::string bucket = output.value("bucket", ""), prefix = output.value("prefix", "");
  const double duration_s = source.value("duration_s", 0.0);
  if (uri.empty() || bucket.empty() || prefix.empty() || duration_s <= 0) {
    res.status = 400;
    res.set_content("source.uri, output.bucket, output.prefix and a positive source.duration_s are required", "text/plain");
    return;
  }
  if (!std::regex_match(sha256, kSha256Re)) {
    res.status = 400;
    res.set_content("source.sha256 must be 64 lowercase hex characters", "text/plain");
    return;
  }
  // The preset decides the encoder command line; the caller only names it.
  const auto args = presets::encoderArgs(preset);
  if (!args) {
    res.status = 404;
    res.set_content("unknown preset " + preset, "text/plain");
    return;
  }
  if (const auto existing = jobs::find(tenant, sha256, preset)) {
    answer(res, 200, *existing, true);
    return;
  }
  answer(res, 201, jobs::create(tenant, uri, sha256, duration_s, preset, *args, bucket, prefix), false);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/transcodes", submit); }
`,
    },
  },
  harness: {
    python: `from transcoder import jobs, presets

SHA = "9f" * 32
EVIL_ARGS = ["-vf", "movie=/etc/passwd", "-f", "image2"]


def _body(sha=SHA, preset="h264-720p", duration=14.0, uri="s3://uploads/talk.mov", bucket="renditions", args=None, prefix="talks/42"):
    body = {"source": {"uri": uri, "sha256": sha, "duration_s": duration}, "preset": preset, "output": {"bucket": bucket, "prefix": prefix}}
    if args is not None:
        body["args"] = args
    return body


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _submit(c, body, tenant="t-1"):
    return await c.post("/v1/transcodes", json=body, headers={"X-Tenant-Id": tenant})


def _created(ctx):
    return int(ctx.redis.get("job:seq") or 0)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, _body())
    assert r.status_code == 201, f"a valid submit answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("segment_count") == 3 and body.get("deduped") is False, f"a 14-second source in 6-second segments is 3 segments, deduped false; the submit answered {body}"
    job = jobs.get(body.get("job_id", ""))
    assert job is not None and job["tenant"] == "t-1" and job["source_sha256"] == SHA, f"the job store holds {job} for job {body.get('job_id')}"


async def check_dedupe(ctx):
    async with _api(ctx) as c:
        first = await _submit(c, _body())
        assert first.status_code == 201, f"the first submit answered {first.status_code}: {first.text}"
        retry = await _submit(c, _body())
        body = retry.json()
        assert retry.status_code == 200 and body.get("job_id") == first.json()["job_id"] and body.get("deduped") is True, f"a retry of the same source and preset answered {retry.status_code} {body}: it must answer the existing job {first.json()['job_id']} with 200 and deduped true"
        assert _created(ctx) == 1, f"two submits of one source and preset created {_created(ctx)} jobs: the retry pays for the encode twice"
        moved = await _submit(c, _body(uri="s3://uploads/talk-copy.mov", duration=30.0))
        body = moved.json()
        assert moved.status_code == 200 and body.get("job_id") == first.json()["job_id"] and body.get("segment_count") == 3 and body.get("deduped") is True, f"a retry of the same sha256 and preset from another uri with a 30-second duration answered {moved.status_code} {body}: it must answer the existing job {first.json()['job_id']} as stored (3 segments), 200 and deduped true"
        other_source = await _submit(c, _body(sha="7c" * 32))
        assert other_source.status_code == 201 and other_source.json().get("job_id") != first.json()["job_id"], f"another source of the same tenant and preset is another job, the submit answered {other_source.status_code} {other_source.text}"
        other_preset = await _submit(c, _body(preset="h265-1080p"))
        assert other_preset.status_code == 201 and other_preset.json().get("job_id") != first.json()["job_id"], f"another preset of the same source is another job, the submit answered {other_preset.status_code} {other_preset.text}"
        other_tenant = await _submit(c, _body(), tenant="t-2")
    assert other_tenant.status_code == 201 and other_tenant.json().get("job_id") != first.json()["job_id"], f"another tenant's upload of the same file answered {other_tenant.status_code} {other_tenant.text}: it is that tenant's own job, keyed by (tenant, sha256, preset)"


async def check_preset_args(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, _body(args=EVIL_ARGS))
    assert r.status_code == 201, f"a submit carrying args answered {r.status_code}: {r.text}"
    job = jobs.get(r.json()["job_id"])
    assert job["encoder_args"] == presets.encoder_args("h264-720p"), f"the job will run the encoder with {job['encoder_args']}: the arguments must come from the h264-720p preset, the caller's args are never read"


async def check_preset_404(ctx):
    async with _api(ctx) as c:
        for preset in ("h264-4k", "H264-720P", "../h264-720p"):
            r = await _submit(c, _body(preset=preset))
            assert r.status_code == 404, f"a submit with the unknown preset {preset!r} answered {r.status_code}, expected 404 before any job exists"
        assert _created(ctx) == 0, f"submits with unknown presets created {_created(ctx)} jobs"
        r = await _submit(c, _body(preset="h264-1080p"))
    assert r.status_code == 201, f"a known preset answered {r.status_code}: {r.text}"


async def check_source_hash(ctx):
    bad = {
        "a short hash": _body(sha="abc123"),
        "an upper-case hash": _body(sha=SHA.upper()),
        "a 63-character hash": _body(sha=SHA[:63]),
        "a non-hex hash": _body(sha="z" * 64),
        "a 65-character hash": _body(sha=SHA + "9"),
        "a hash followed by a newline": _body(sha=SHA + "\\n"),
        "a zero duration": _body(duration=0),
        "a negative duration": _body(duration=-6.0),
        "an empty uri": _body(uri=""),
        "an empty bucket": _body(bucket=""),
        "an empty prefix": _body(prefix=""),
    }
    async with _api(ctx) as c:
        for what, body in bad.items():
            r = await _submit(c, body)
            assert r.status_code == 400, f"a submit with {what} answered {r.status_code}, expected 400"
        assert _created(ctx) == 0, f"invalid submits created {_created(ctx)} jobs: the dedupe key is built from whatever arrived"
        r = await _submit(c, _body())
        assert r.status_code == 201, f"the valid submit answered {r.status_code}: {r.text}"
        short = await _submit(c, _body(sha="7c" * 32, duration=0.5))
    assert short.status_code == 201 and short.json().get("segment_count") == 1, f"a valid half-second source answered {short.status_code} {short.text}: any positive duration is one segment or more"
`,
    typescript: `const SHA = '9f'.repeat(32);
const EVIL_ARGS = ['-vf', 'movie=/etc/passwd', '-f', 'image2'];

function body({sha = SHA, preset = 'h264-720p', duration = 14, uri = 's3://uploads/talk.mov', bucket = 'renditions', prefix = 'talks/42', args = undefined as string[] | undefined} = {}) {
  return {source: {uri, sha256: sha, duration_s: duration}, preset, output: {bucket, prefix}, ...(args === undefined ? {} : {args})};
}

function api(ctx) {
  return {
    c: ctx.client(ctx.load('api').app),
    jobs: ctx.load('/support/transcoder/jobs.ts'),
    presets: ctx.load('/support/transcoder/presets.ts'),
  };
}

const submit = (c, json, tenant = 't-1') => c.post('/v1/transcodes', {json, headers: {'X-Tenant-Id': tenant}});
const created = (ctx): number => Number(ctx.redis.get('job:seq') ?? 0);

export async function check_route(ctx) {
  const {c, jobs} = api(ctx);
  const r = await submit(c, body());
  assert.equal(r.status, 201, \`a valid submit answered \${r.status}: \${r.text}\`);
  const answer = r.json();
  assert(answer.segment_count === 3 && answer.deduped === false, \`a 14-second source in 6-second segments is 3 segments, deduped false; the submit answered \${r.text}\`);
  const job = await jobs.get(answer.job_id ?? '');
  assert(job !== null && job.tenant === 't-1' && job.source_sha256 === SHA, \`the job store holds \${JSON.stringify(job)} for job \${answer.job_id}\`);
}

export async function check_dedupe(ctx) {
  const {c} = api(ctx);
  const first = await submit(c, body());
  assert.equal(first.status, 201, \`the first submit answered \${first.status}: \${first.text}\`);
  const retry = await submit(c, body());
  const again = retry.json();
  assert(retry.status === 200 && again.job_id === first.json().job_id && again.deduped === true, \`a retry of the same source and preset answered \${retry.status} \${retry.text}: it must answer the existing job with 200 and deduped true\`);
  assert.equal(created(ctx), 1, \`two submits of one source and preset created \${created(ctx)} jobs: the retry pays for the encode twice\`);
  const moved = await submit(c, body({uri: 's3://uploads/talk-copy.mov', duration: 30}));
  const stored = moved.json();
  assert(moved.status === 200 && stored.job_id === first.json().job_id && stored.segment_count === 3 && stored.deduped === true, \`a retry of the same sha256 and preset from another uri with a 30-second duration answered \${moved.status} \${moved.text}: it must answer the existing job as stored (3 segments), 200 and deduped true\`);
  const otherSource = await submit(c, body({sha: '7c'.repeat(32)}));
  assert(otherSource.status === 201 && otherSource.json().job_id !== first.json().job_id, \`another source of the same tenant and preset is another job, the submit answered \${otherSource.status} \${otherSource.text}\`);
  const otherPreset = await submit(c, body({preset: 'h265-1080p'}));
  assert(otherPreset.status === 201 && otherPreset.json().job_id !== first.json().job_id, \`another preset of the same source is another job, the submit answered \${otherPreset.status} \${otherPreset.text}\`);
  const otherTenant = await submit(c, body(), 't-2');
  assert(otherTenant.status === 201 && otherTenant.json().job_id !== first.json().job_id, \`another tenant's upload of the same file answered \${otherTenant.status} \${otherTenant.text}: it is that tenant's own job, keyed by (tenant, sha256, preset)\`);
}

export async function check_preset_args(ctx) {
  const {c, jobs, presets} = api(ctx);
  const r = await submit(c, body({args: EVIL_ARGS}));
  assert.equal(r.status, 201, \`a submit carrying args answered \${r.status}: \${r.text}\`);
  const job = await jobs.get(r.json().job_id);
  assert.deepStrictEqual(job.encoder_args, presets.encoderArgs('h264-720p'), \`the job will run the encoder with \${JSON.stringify(job.encoder_args)}: the arguments must come from the h264-720p preset, the caller's args are never read\`);
}

export async function check_preset_404(ctx) {
  const {c} = api(ctx);
  for (const preset of ['h264-4k', 'H264-720P', '../h264-720p', 'constructor']) {
    const r = await submit(c, body({preset}));
    assert.equal(r.status, 404, \`a submit with the unknown preset \${JSON.stringify(preset)} answered \${r.status}, expected 404 before any job exists\`);
  }
  assert.equal(created(ctx), 0, \`submits with unknown presets created \${created(ctx)} jobs\`);
  const r = await submit(c, body({preset: 'h264-1080p'}));
  assert.equal(r.status, 201, \`a known preset answered \${r.status}: \${r.text}\`);
}

export async function check_source_hash(ctx) {
  const {c} = api(ctx);
  const bad: [string, object][] = [
    ['a short hash', body({sha: 'abc123'})],
    ['an upper-case hash', body({sha: SHA.toUpperCase()})],
    ['a 63-character hash', body({sha: SHA.slice(0, 63)})],
    ['a non-hex hash', body({sha: 'z'.repeat(64)})],
    ['a 65-character hash', body({sha: SHA + '9'})],
    ['a hash followed by a newline', body({sha: SHA + '\\n'})],
    ['a zero duration', body({duration: 0})],
    ['a negative duration', body({duration: -6})],
    ['an empty uri', body({uri: ''})],
    ['an empty bucket', body({bucket: ''})],
    ['an empty prefix', body({prefix: ''})],
  ];
  for (const [what, json] of bad) {
    const r = await submit(c, json);
    assert.equal(r.status, 400, \`a submit with \${what} answered \${r.status}, expected 400\`);
  }
  assert.equal(created(ctx), 0, \`invalid submits created \${created(ctx)} jobs: the dedupe key is built from whatever arrived\`);
  const r = await submit(c, body());
  assert.equal(r.status, 201, \`the valid submit answered \${r.status}: \${r.text}\`);
  const short = await submit(c, body({sha: '7c'.repeat(32), duration: 0.5}));
  assert(short.status === 201 && short.json().segment_count === 1, \`a valid half-second source answered \${short.status} \${short.text}: any positive duration is one segment or more\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"transcoder/jobs"
	"transcoder/presets"

	"leetbuild/harness"
)

var (
	hSourceSHA = strings.Repeat("9f", 32)
	hEvilArgs  = []string{"-vf", "movie=/etc/passwd", "-f", "image2"}
)

type HJobAnswer struct {
	JobID        string \`json:"job_id"\`
	SegmentCount int    \`json:"segment_count"\`
	Deduped      bool   \`json:"deduped"\`
}

func hTranscodeBody(sha, preset string, duration float64, uri, bucket string, args []string) map[string]any {
	body := map[string]any{
		"source": map[string]any{"uri": uri, "sha256": sha, "duration_s": duration},
		"preset": preset,
		"output": map[string]any{"bucket": bucket, "prefix": "talks/42"},
	}
	if args != nil {
		body["args"] = args
	}
	return body
}

func hValidBody() map[string]any {
	return hTranscodeBody(hSourceSHA, "h264-720p", 14, "s3://uploads/talk.mov", "renditions", nil)
}

func hSubmitter(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func hPostJob(c *harness.HTTP, body any, tenant string) *harness.Response {
	return c.Post("/v1/transcodes", body, "X-Tenant-Id", tenant)
}

func hDecodeJob(r *harness.Response) HJobAnswer {
	var a HJobAnswer
	r.Decode(&a)
	return a
}

func hJobsCreated(ctx *harness.Ctx) int {
	raw, _ := ctx.Redis.Get("job:seq")
	n, _ := strconv.Atoi(raw)
	return n
}

func CheckRoute(ctx *harness.Ctx) {
	c := hSubmitter(ctx)
	r := hPostJob(c, hValidBody(), "t-1")
	ctx.Equal(r.Status, 201, "a valid submit (%s)", r.Text())
	a := hDecodeJob(r)
	ctx.Assert(a.SegmentCount == 3 && !a.Deduped, "a 14-second source in 6-second segments is 3 segments, deduped false; the submit answered %s", r.Text())
	job := jobs.Get(context.Background(), a.JobID)
	ctx.Assert(job != nil && job.Tenant == "t-1" && job.SourceSHA256 == hSourceSHA, "the job store holds %+v for job %s", job, a.JobID)
}

func CheckDedupe(ctx *harness.Ctx) {
	c := hSubmitter(ctx)
	first := hPostJob(c, hValidBody(), "t-1")
	ctx.Equal(first.Status, 201, "the first submit (%s)", first.Text())
	firstID := hDecodeJob(first).JobID
	retry := hPostJob(c, hValidBody(), "t-1")
	again := hDecodeJob(retry)
	ctx.Assert(retry.Status == 200 && again.JobID == firstID && again.Deduped, "a retry of the same source and preset answered %d %s: it must answer the existing job %s with 200 and deduped true", retry.Status, retry.Text(), firstID)
	ctx.Equal(hJobsCreated(ctx), 1, "two submits of one source and preset must create one job (a second pays for the encode twice); jobs created")
	moved := hPostJob(c, hTranscodeBody(hSourceSHA, "h264-720p", 30, "s3://uploads/talk-copy.mov", "renditions", nil), "t-1")
	stored := hDecodeJob(moved)
	ctx.Assert(moved.Status == 200 && stored.JobID == firstID && stored.SegmentCount == 3 && stored.Deduped, "a retry of the same sha256 and preset from another uri with a 30-second duration answered %d %s: it must answer the existing job %s as stored (3 segments), 200 and deduped true", moved.Status, moved.Text(), firstID)
	otherSource := hPostJob(c, hTranscodeBody(strings.Repeat("7c", 32), "h264-720p", 14, "s3://uploads/talk.mov", "renditions", nil), "t-1")
	ctx.Assert(otherSource.Status == 201 && hDecodeJob(otherSource).JobID != firstID, "another source of the same tenant and preset is another job, the submit answered %d %s", otherSource.Status, otherSource.Text())
	otherPreset := hPostJob(c, hTranscodeBody(hSourceSHA, "h265-1080p", 14, "s3://uploads/talk.mov", "renditions", nil), "t-1")
	ctx.Assert(otherPreset.Status == 201 && hDecodeJob(otherPreset).JobID != firstID, "another preset of the same source is another job, the submit answered %d %s", otherPreset.Status, otherPreset.Text())
	otherTenant := hPostJob(c, hValidBody(), "t-2")
	ctx.Assert(otherTenant.Status == 201 && hDecodeJob(otherTenant).JobID != firstID, "another tenant's upload of the same file answered %d %s: it is that tenant's own job, keyed by (tenant, sha256, preset)", otherTenant.Status, otherTenant.Text())
}

func CheckPresetArgs(ctx *harness.Ctx) {
	c := hSubmitter(ctx)
	r := hPostJob(c, hTranscodeBody(hSourceSHA, "h264-720p", 14, "s3://uploads/talk.mov", "renditions", hEvilArgs), "t-1")
	ctx.Equal(r.Status, 201, "a submit carrying args (%s)", r.Text())
	job := jobs.Get(context.Background(), hDecodeJob(r).JobID)
	want, _ := presets.EncoderArgs("h264-720p")
	ctx.Assert(job != nil, "the job store holds no job %s", hDecodeJob(r).JobID)
	ctx.Equal(job.EncoderArgs, want, "the job's encoder arguments must come from the h264-720p preset, the caller's args are never read")
}

func CheckPreset404(ctx *harness.Ctx) {
	c := hSubmitter(ctx)
	for _, preset := range []string{"h264-4k", "H264-720P", "../h264-720p"} {
		r := hPostJob(c, hTranscodeBody(hSourceSHA, preset, 14, "s3://uploads/talk.mov", "renditions", nil), "t-1")
		ctx.Equal(r.Status, 404, "a submit with the unknown preset %q must answer 404 before any job exists; the status", preset)
	}
	ctx.Equal(hJobsCreated(ctx), 0, "submits with unknown presets must create nothing; jobs created")
	r := hPostJob(c, hTranscodeBody(hSourceSHA, "h264-1080p", 14, "s3://uploads/talk.mov", "renditions", nil), "t-1")
	ctx.Equal(r.Status, 201, "a known preset (%s)", r.Text())
}

func CheckSourceHash(ctx *harness.Ctx) {
	c := hSubmitter(ctx)
	noPrefix := hValidBody()
	noPrefix["output"] = map[string]any{"bucket": "renditions", "prefix": ""}
	bad := []struct {
		what string
		body map[string]any
	}{
		{"a short hash", hTranscodeBody("abc123", "h264-720p", 14, "s3://uploads/talk.mov", "renditions", nil)},
		{"an upper-case hash", hTranscodeBody(strings.ToUpper(hSourceSHA), "h264-720p", 14, "s3://uploads/talk.mov", "renditions", nil)},
		{"a 63-character hash", hTranscodeBody(hSourceSHA[:63], "h264-720p", 14, "s3://uploads/talk.mov", "renditions", nil)},
		{"a non-hex hash", hTranscodeBody(strings.Repeat("z", 64), "h264-720p", 14, "s3://uploads/talk.mov", "renditions", nil)},
		{"a 65-character hash", hTranscodeBody(hSourceSHA+"9", "h264-720p", 14, "s3://uploads/talk.mov", "renditions", nil)},
		{"a hash followed by a newline", hTranscodeBody(hSourceSHA+"\\n", "h264-720p", 14, "s3://uploads/talk.mov", "renditions", nil)},
		{"a zero duration", hTranscodeBody(hSourceSHA, "h264-720p", 0, "s3://uploads/talk.mov", "renditions", nil)},
		{"a negative duration", hTranscodeBody(hSourceSHA, "h264-720p", -6, "s3://uploads/talk.mov", "renditions", nil)},
		{"an empty uri", hTranscodeBody(hSourceSHA, "h264-720p", 14, "", "renditions", nil)},
		{"an empty bucket", hTranscodeBody(hSourceSHA, "h264-720p", 14, "s3://uploads/talk.mov", "", nil)},
		{"an empty prefix", noPrefix},
	}
	for _, b := range bad {
		r := hPostJob(c, b.body, "t-1")
		ctx.Equal(r.Status, 400, "a submit with %s; the status", b.what)
	}
	ctx.Equal(hJobsCreated(ctx), 0, "invalid submits must create nothing (the dedupe key would be built from whatever arrived); jobs created")
	r := hPostJob(c, hValidBody(), "t-1")
	ctx.Equal(r.Status, 201, "the valid submit (%s)", r.Text())
	short := hPostJob(c, hTranscodeBody(strings.Repeat("7c", 32), "h264-720p", 0.5, "s3://uploads/talk.mov", "renditions", nil), "t-1")
	ctx.Assert(short.Status == 201 && hDecodeJob(short).SegmentCount == 1, "a valid half-second source answered %d %s: any positive duration is one segment or more", short.Status, short.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cctype>
#include <string>
#include <vector>

#include "transcoder/jobs.h"
#include "transcoder/presets.h"

namespace {

const std::string hKSha(64, 'f');
const std::vector<std::string> kHEvilArgs = {"-vf", "movie=/etc/passwd", "-f", "image2"};

nlohmann::json hTranscodeBody(const std::string& sha, const std::string& preset, double duration, const std::string& uri, const std::string& bucket) {
  return {{"source", {{"uri", uri}, {"sha256", sha}, {"duration_s", duration}}}, {"preset", preset}, {"output", {{"bucket", bucket}, {"prefix", "talks/42"}}}};
}

nlohmann::json hValidBody() { return hTranscodeBody(hKSha, "h264-720p", 14, "s3://uploads/talk.mov", "renditions"); }

harness::HTTP hSubmitter(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response hPostJob(harness::HTTP& c, const nlohmann::json& body, const std::string& tenant) {
  return c.Post("/v1/transcodes", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

nlohmann::json hAnswerOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

long hJobsCreated(harness::Ctx& ctx) {
  const auto raw = ctx.Redis.Get("job:seq");
  return raw ? std::stol(*raw) : 0L;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = hSubmitter(ctx);
  const auto r = hPostJob(c, hValidBody(), "t-1");
  ctx.Equal(r.Status, 201, "a valid submit (%s)", r.Text());
  const auto a = hAnswerOf(r);
  ctx.Assert(a.value("segment_count", 0) == 3 && a.value("deduped", true) == false, "a 14-second source in 6-second segments is 3 segments, deduped false; the submit answered %s", r.Text());
  const auto job = jobs::get(a.value("job_id", ""));
  ctx.Assert(job && job->tenant == "t-1" && job->source_sha256 == hKSha, "the job store holds no job of t-1 for this source under %s", a.value("job_id", ""));
}

void CheckDedupe(harness::Ctx& ctx) {
  auto c = hSubmitter(ctx);
  const auto first = hPostJob(c, hValidBody(), "t-1");
  ctx.Equal(first.Status, 201, "the first submit (%s)", first.Text());
  const std::string first_id = hAnswerOf(first).value("job_id", "");
  const auto retry = hPostJob(c, hValidBody(), "t-1");
  const auto again = hAnswerOf(retry);
  ctx.Assert(retry.Status == 200 && again.value("job_id", "") == first_id && again.value("deduped", false), "a retry of the same source and preset answered %d %s: it must answer the existing job %s with 200 and deduped true", retry.Status, retry.Text(), first_id);
  ctx.Equal(hJobsCreated(ctx), 1L, "two submits of one source and preset must create one job (a second pays for the encode twice); jobs created");
  const auto moved = hPostJob(c, hTranscodeBody(hKSha, "h264-720p", 30, "s3://uploads/talk-copy.mov", "renditions"), "t-1");
  const auto stored = hAnswerOf(moved);
  ctx.Assert(moved.Status == 200 && stored.value("job_id", "") == first_id && stored.value("segment_count", 0) == 3 && stored.value("deduped", false), "a retry of the same sha256 and preset from another uri with a 30-second duration answered %d %s: it must answer the existing job %s as stored (3 segments), 200 and deduped true", moved.Status, moved.Text(), first_id);
  const auto other_source = hPostJob(c, hTranscodeBody(std::string(64, '7'), "h264-720p", 14, "s3://uploads/talk.mov", "renditions"), "t-1");
  ctx.Assert(other_source.Status == 201 && hAnswerOf(other_source).value("job_id", "") != first_id, "another source of the same tenant and preset is another job, the submit answered %d %s", other_source.Status, other_source.Text());
  const auto other_preset = hPostJob(c, hTranscodeBody(hKSha, "h265-1080p", 14, "s3://uploads/talk.mov", "renditions"), "t-1");
  ctx.Assert(other_preset.Status == 201 && hAnswerOf(other_preset).value("job_id", "") != first_id, "another preset of the same source is another job, the submit answered %d %s", other_preset.Status, other_preset.Text());
  const auto other_tenant = hPostJob(c, hValidBody(), "t-2");
  ctx.Assert(other_tenant.Status == 201 && hAnswerOf(other_tenant).value("job_id", "") != first_id, "another tenant's upload of the same file answered %d %s: it is that tenant's own job, keyed by (tenant, sha256, preset)", other_tenant.Status, other_tenant.Text());
}

void CheckPresetArgs(harness::Ctx& ctx) {
  auto c = hSubmitter(ctx);
  nlohmann::json body = hValidBody();
  body["args"] = kHEvilArgs;
  const auto r = hPostJob(c, body, "t-1");
  ctx.Equal(r.Status, 201, "a submit carrying args (%s)", r.Text());
  const auto job = jobs::get(hAnswerOf(r).value("job_id", ""));
  ctx.Assert(job.has_value(), "the job store holds no job for %s", r.Text());
  ctx.Equal(job->encoder_args, *presets::encoderArgs("h264-720p"), "the job's encoder arguments must come from the h264-720p preset, the caller's args are never read");
}

void CheckPreset404(harness::Ctx& ctx) {
  auto c = hSubmitter(ctx);
  for (const std::string preset : {"h264-4k", "H264-720P", "../h264-720p"}) {
    const auto r = hPostJob(c, hTranscodeBody(hKSha, preset, 14, "s3://uploads/talk.mov", "renditions"), "t-1");
    ctx.Equal(r.Status, 404, "a submit with the unknown preset %q must answer 404 before any job exists; the status", preset);
  }
  ctx.Equal(hJobsCreated(ctx), 0L, "submits with unknown presets must create nothing; jobs created");
  const auto r = hPostJob(c, hTranscodeBody(hKSha, "h264-1080p", 14, "s3://uploads/talk.mov", "renditions"), "t-1");
  ctx.Equal(r.Status, 201, "a known preset (%s)", r.Text());
}

void CheckSourceHash(harness::Ctx& ctx) {
  auto c = hSubmitter(ctx);
  std::string upper = hKSha;
  for (char& ch : upper) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
  nlohmann::json no_prefix = hValidBody();
  no_prefix["output"]["prefix"] = "";
  const std::vector<std::pair<std::string, nlohmann::json>> bad = {
      {"a short hash", hTranscodeBody("abc123", "h264-720p", 14, "s3://uploads/talk.mov", "renditions")},
      {"an upper-case hash", hTranscodeBody(upper, "h264-720p", 14, "s3://uploads/talk.mov", "renditions")},
      {"a 63-character hash", hTranscodeBody(hKSha.substr(0, 63), "h264-720p", 14, "s3://uploads/talk.mov", "renditions")},
      {"a non-hex hash", hTranscodeBody(std::string(64, 'z'), "h264-720p", 14, "s3://uploads/talk.mov", "renditions")},
      {"a 65-character hash", hTranscodeBody(hKSha + "9", "h264-720p", 14, "s3://uploads/talk.mov", "renditions")},
      {"a hash followed by a newline", hTranscodeBody(hKSha + "\\n", "h264-720p", 14, "s3://uploads/talk.mov", "renditions")},
      {"a zero duration", hTranscodeBody(hKSha, "h264-720p", 0, "s3://uploads/talk.mov", "renditions")},
      {"a negative duration", hTranscodeBody(hKSha, "h264-720p", -6, "s3://uploads/talk.mov", "renditions")},
      {"an empty uri", hTranscodeBody(hKSha, "h264-720p", 14, "", "renditions")},
      {"an empty bucket", hTranscodeBody(hKSha, "h264-720p", 14, "s3://uploads/talk.mov", "")},
      {"an empty prefix", no_prefix},
  };
  for (const auto& [what, body] : bad) {
    const auto r = hPostJob(c, body, "t-1");
    ctx.Equal(r.Status, 400, "a submit with %s; the status", what);
  }
  ctx.Equal(hJobsCreated(ctx), 0L, "invalid submits must create nothing (the dedupe key would be built from whatever arrived); jobs created");
  const auto r = hPostJob(c, hValidBody(), "t-1");
  ctx.Equal(r.Status, 201, "the valid submit (%s)", r.Text());
  const auto short_source = hPostJob(c, hTranscodeBody(std::string(64, '7'), "h264-720p", 0.5, "s3://uploads/talk.mov", "renditions"), "t-1");
  ctx.Assert(short_source.Status == 201 && hAnswerOf(short_source).value("segment_count", 0) == 1, "a valid half-second source answered %d %s: any positive duration is one segment or more", short_source.Status, short_source.Text());
}
`,
  },
  hints: [
    'Submit the same upload twice with a client retry: two job ids come back and two encodes run. Submit with an `args` list naming a file on the worker: the job stores it as its encoder command.',
    'The handler hands `body.args` to `jobs.create` and never asks the job store or the preset table anything first, so nothing stops a duplicate, a made-up preset or a hash like "abc" from becoming a job.',
    'Answer 400 unless the sha256 matches `^[0-9a-f]{64}$` and uri, bucket, prefix and a positive duration are present; take `presets.encoder_args(preset)` (404 when None); return `jobs.find(tenant, sha256, preset)` with 200 and `deduped: true` before `jobs.create`.',
  ],
  debrief: `The order of the handler is the fix: validate what arrived, resolve the preset, look the key up, and only then create. The dedupe key includes the tenant because two tenants uploading the same file own two jobs; sharing one would hand the second tenant an id it may not read. The preset table is the only source of encoder arguments, so the command a worker runs is something the service chose, and a caller's list is accepted for compatibility and dropped. A real submit path also closes the race between two concurrent first submits (a \`SET NX\` on the source key, or a unique index), and checks that the source object exists and that its hash matches before queueing any work.`,
};
