import type {Step} from '@/lib/types';

export const readCheckpointStep: Step = {
  id: 'read',
  title: 'GET the latest checkpoint a resumed run can trust',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/runs/{run_id}/checkpoints/latest\` for a resuming
trainer: with \`X-Tenant-Id\` set (401 otherwise) it takes the run's newest upload
(\`store.latest_upload\`) and answers its \`upload_id\`, \`run_id\`, \`step\`, \`chunks\`, a read \`url\`
signed with \`store.sign_url\` and its \`expires_at\`, valid for a week (\`URL_TTL_S\`). It serves the
demo and hides three flaws.

**Failure mode the checks target.** A trainer resumes from an upload that never finished; a tenant
reads another tenant's weights by guessing a run id; and a read link pasted into a ticket keeps
working for a week.

- The run must belong to the caller (\`store.run_tenant\`); another tenant's run is **404**, the
  same answer as a missing one.
- The checkpoint is \`latest_committed(run_id)\` (step 2, provided as \`checkpoint.commit\`): the
  highest committed step, with its \`digest\`. A run with nothing committed is **404**.
- The URL expires **15 minutes** after the read: \`URL_TTL_S = 900\`, \`expires_at\` = now + 900.`,
  sequence: {
    participants: ['Training job', 'Checkpoint API', 'Redis'],
    messages: [
      {
        from: 'Training job',
        to: 'Checkpoint API',
        label: 'GET /v1/runs/r1/checkpoints/latest · X-Tenant-Id t1',
        kind: 'sync',
      },
      {from: 'Checkpoint API', to: 'Redis', label: 'run_tenant(r1) → t1', kind: 'sync'},
      {from: 'Checkpoint API', to: 'Redis', label: 'latest_committed(r1) → step 1200, digest', kind: 'sync'},
      {
        from: 'Checkpoint API',
        to: 'Training job',
        label: '200 {step, digest, url, expires_at = now + 900} · 404',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves the latest checkpoint of the caller’s run',
      detail:
        'Register `GET /v1/runs/{run_id}/checkpoints/latest`: a run with a committed checkpoint answers its upload, step and chunk count with a working read URL; no tenant is 401, an unknown run 404.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/runs\/\{run_id\}\/checkpoints\/latest["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/runs\/:runId\/checkpoints\/latest['"]/]},
        go: {all: [/"GET \/v1\/runs\/\{id\}\/checkpoints\/latest"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"runs"\s*\/\s*Segment\s*\/\s*"checkpoints"\s*\/\s*"latest"\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/runs\/[^\n]*\/checkpoints\/latest\)"/]},
      },
    },
    {
      id: 'committed-only',
      title: 'Serves only a committed checkpoint',
      detail:
        'The checkpoint comes from `latest_committed`/`latestCommitted`, so a newer upload that is still missing a chunk stays invisible and a run with nothing committed is **404**. The starter serves the newest upload, committed or not.',
      match: {
        python: {all: [/latest_committed\(\s*run_id\s*\)/], none: [/latest_upload\(/]},
        typescript: {all: [/latestCommitted\(\s*runId\s*\)/], none: [/latestUpload\(/]},
        go: {all: [/commit\.LatestCommitted\(/], none: [/LatestUpload\(/]},
        scala: {all: [/Commit\.latestCommitted\(/], none: [/latestUpload\(/]},
        cpp: {all: [/commit::latestCommitted\(/], none: [/latestUpload\(/]},
      },
    },
    {
      id: 'tenant-404',
      title: 'Another tenant’s run is 404',
      detail:
        'The run’s tenant (`run_tenant`/`runTenant`) is compared with `X-Tenant-Id` before any checkpoint is read, and a foreign run answers **404** like a missing one. The starter serves any run to any tenant.',
      match: {
        python: {
          all: [/store\.run_tenant\(\s*run_id\s*\)/, /\b404\b/],
          order: [/store\.run_tenant\(/, /latest_committed\(|latest_upload\(/],
        },
        typescript: {
          all: [/runTenant\(\s*runId\s*\)/, /\b404\b/],
          order: [/runTenant\(/, /latestCommitted\(|latestUpload\(/],
        },
        go: {
          all: [/store\.RunTenant\(/, /StatusNotFound|\b404\b/],
          order: [/store\.RunTenant\(/, /LatestCommitted\(|LatestUpload\(/],
        },
        scala: {
          all: [/Store\.runTenant\(/, /NotFound|\b404\b/],
          order: [/Store\.runTenant\(/, /latestCommitted\(|latestUpload\(/],
        },
        cpp: {
          all: [/store::runTenant\(/, /\b404\b/],
          order: [/store::runTenant\(/, /latestCommitted\(|latestUpload\(/],
        },
      },
    },
    {
      id: 'url-ttl',
      title: 'The read URL expires in 15 minutes',
      detail:
        'The URL is signed to expire 900 s after the read and the response says when (`expires_at`); a minute past that the store refuses it. The starter signs it for a week.',
      match: {
        python: {all: [/URL_TTL_S\s*=\s*(900|15\s*\*\s*60)\b/]},
        typescript: {all: [/URL_TTL_S\s*=\s*(900|15\s*\*\s*60)\b/]},
        go: {all: [/urlTTL\s*=\s*(15\s*\*\s*time\.Minute|900\s*\*\s*time\.Second)/]},
        scala: {all: [/UrlTtlSeconds\s*=\s*(900|15\s*\*\s*60)L?\b/]},
        cpp: {all: [/kUrlTtl\{900\}|minutes kUrlTtl\{15\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request

from checkpoint import store  # run_tenant, latest_upload, sign_url
from checkpoint.commit import latest_committed

app = FastAPI()

URL_TTL_S = 7 * 24 * 3600  # a week: a long resume never meets an expired link


@app.get("/v1/runs/{run_id}/checkpoints/latest")
def latest_checkpoint(run_id: str, request: Request) -> dict:
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    upload = store.latest_upload(run_id)
    if upload is None:
        raise HTTPException(status_code=404, detail="no checkpoint for this run")
    expires_at = int(time.time()) + URL_TTL_S
    return {
        "upload_id": upload["upload_id"],
        "run_id": run_id,
        "step": upload["step"],
        "chunks": upload["chunks"],
        "url": store.sign_url(upload["upload_id"], expires_at),
        "expires_at": expires_at,
    }
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from checkpoint import store  # run_tenant, latest_upload, sign_url
from checkpoint.commit import latest_committed

app = FastAPI()

URL_TTL_S = 900  # a read link outlives the resume by minutes, not days


@app.get("/v1/runs/{run_id}/checkpoints/latest")
def latest_checkpoint(run_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    if store.run_tenant(run_id) != tenant:
        # Another tenant's run answers like a missing one: a 403 would confirm that it exists.
        raise HTTPException(status_code=404, detail="no checkpoint for this run")
    record = latest_committed(run_id)  # committed only: an upload missing a chunk is not a checkpoint
    if record is None:
        raise HTTPException(status_code=404, detail="no checkpoint for this run")
    expires_at = int(time.time()) + URL_TTL_S
    return {**record, "url": store.sign_url(record["upload_id"], expires_at), "expires_at": expires_at}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {latestCommitted} from 'checkpoint/commit';
import {latestUpload, runTenant, signUrl} from 'checkpoint/store';

export const app = Fastify();

export const URL_TTL_S = 7 * 24 * 3600; // a week: a long resume never meets an expired link

app.get('/v1/runs/:runId/checkpoints/latest', async (request, reply) => {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const {runId} = request.params as {runId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const upload = await latestUpload(runId);
  if (upload === null) return reply.code(404).send({error: 'no checkpoint for this run'});
  const expiresAt = Math.floor(Date.now() / 1000) + URL_TTL_S;
  return {
    upload_id: upload.upload_id,
    run_id: runId,
    step: upload.step,
    chunks: upload.chunks,
    url: signUrl(upload.upload_id, expiresAt),
    expires_at: expiresAt,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {latestCommitted} from 'checkpoint/commit';
import {latestUpload, runTenant, signUrl} from 'checkpoint/store';

export const app = Fastify();

export const URL_TTL_S = 900; // a read link outlives the resume by minutes, not days

app.get('/v1/runs/:runId/checkpoints/latest', async (request, reply) => {
  const {runId} = request.params as {runId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  // Another tenant's run answers like a missing one: a 403 would confirm that it exists.
  if ((await runTenant(runId)) !== tenant) return reply.code(404).send({error: 'no checkpoint for this run'});
  const record = await latestCommitted(runId); // committed only: an upload missing a chunk is not a checkpoint
  if (record === null) return reply.code(404).send({error: 'no checkpoint for this run'});
  const expiresAt = Math.floor(Date.now() / 1000) + URL_TTL_S;
  return {...record, url: signUrl(record.upload_id, expiresAt), expires_at: expiresAt};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"checkpoint/store" // store.RunTenant, LatestUpload, SignURL; checkpoint/commit has LatestCommitted
)

const urlTTL = 7 * 24 * time.Hour // a week: a long resume never meets an expired link

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func latestCheckpoint(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	runID := r.PathValue("id")
	if r.Header.Get("X-Tenant-Id") == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	upload := store.LatestUpload(r.Context(), runID)
	if upload == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no checkpoint for this run"})
		return
	}
	expiresAt := time.Now().Add(urlTTL).Unix()
	writeJSON(rw, http.StatusOK, map[string]any{
		"upload_id":  upload.UploadID,
		"run_id":     runID,
		"step":       upload.Step,
		"chunks":     upload.Chunks,
		"url":        store.SignURL(upload.UploadID, expiresAt),
		"expires_at": expiresAt,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/runs/{id}/checkpoints/latest", latestCheckpoint)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"checkpoint/commit" // commit.LatestCommitted
	"checkpoint/store"  // store.RunTenant, LatestUpload, SignURL
)

const urlTTL = 15 * time.Minute // a read link outlives the resume by minutes, not days

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func latestCheckpoint(rw http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	// Another tenant's run answers like a missing one: a 403 would confirm that it exists.
	if store.RunTenant(r.Context(), runID) != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no checkpoint for this run"})
		return
	}
	record := commit.LatestCommitted(r.Context(), runID) // committed only: an upload missing a chunk is not a checkpoint
	if record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no checkpoint for this run"})
		return
	}
	expiresAt := time.Now().Add(urlTTL).Unix()
	writeJSON(rw, http.StatusOK, map[string]any{
		"upload_id":  record.UploadID,
		"run_id":     record.RunID,
		"step":       record.Step,
		"chunks":     record.Chunks,
		"digest":     record.Digest,
		"url":        store.SignURL(record.UploadID, expiresAt),
		"expires_at": expiresAt,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/runs/{id}/checkpoints/latest", latestCheckpoint)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import checkpoint.{Commit, Store} // Commit.latestCommitted; Store.runTenant, latestUpload, signUrl

object Read {
  val UrlTtlSeconds: Long = 7L * 24 * 3600 // a week: a long resume never meets an expired link

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "runs" / Segment / "checkpoints" / "latest") { runId =>
      get {
        // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          case Some(_) =>
            Store.latestUpload(runId) match {
              case None => complete(error(StatusCodes.NotFound, "no checkpoint for this run"))
              case Some(upload) =>
                val expiresAt = System.currentTimeMillis / 1000 + UrlTtlSeconds
                complete(json(StatusCodes.OK, JsObject(
                  "upload_id" -> JsString(upload.uploadId),
                  "run_id" -> JsString(runId),
                  "step" -> JsNumber(upload.step),
                  "chunks" -> JsNumber(upload.chunks),
                  "url" -> JsString(Store.signUrl(upload.uploadId, expiresAt)),
                  "expires_at" -> JsNumber(expiresAt))))
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

import checkpoint.{Commit, Store} // Commit.latestCommitted; Store.runTenant, latestUpload, signUrl

object Read {
  val UrlTtlSeconds = 900L // a read link outlives the resume by minutes, not days

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "runs" / Segment / "checkpoints" / "latest") { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          // Another tenant's run answers like a missing one: a 403 would confirm that it exists.
          case Some(tenant) if !Store.runTenant(runId).contains(tenant) => complete(error(StatusCodes.NotFound, "no checkpoint for this run"))
          case Some(_) =>
            Commit.latestCommitted(runId) match { // committed only: an upload missing a chunk is not a checkpoint
              case None => complete(error(StatusCodes.NotFound, "no checkpoint for this run"))
              case Some(record) =>
                val expiresAt = System.currentTimeMillis / 1000 + UrlTtlSeconds
                complete(json(StatusCodes.OK, JsObject(
                  "upload_id" -> JsString(record.uploadId),
                  "run_id" -> JsString(record.runId),
                  "step" -> JsNumber(record.step),
                  "chunks" -> JsNumber(record.chunks),
                  "digest" -> JsString(record.digest),
                  "url" -> JsString(Store.signUrl(record.uploadId, expiresAt)),
                  "expires_at" -> JsNumber(expiresAt))))
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

#include <chrono>
#include <string>

#include "checkpoint/commit.h"  // commit::latestCommitted
#include "checkpoint/store.h"   // store::runTenant, latestUpload, signUrl

using json = nlohmann::json;

constexpr std::chrono::hours kUrlTtl{7 * 24};  // a week: a long resume never meets an expired link

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void latest_checkpoint(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const std::string run_id = req.matches[1];
  if (req.get_header_value("X-Tenant-Id").empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const auto upload = store::latestUpload(run_id);
  if (!upload) return reply(res, 404, {{"error", "no checkpoint for this run"}});
  const long long expires_at = std::chrono::duration_cast<std::chrono::seconds>((std::chrono::system_clock::now() + kUrlTtl).time_since_epoch()).count();
  reply(res, 200, {{"upload_id", upload->upload_id},
                   {"run_id", run_id},
                   {"step", upload->step},
                   {"chunks", upload->chunks},
                   {"url", store::signUrl(upload->upload_id, expires_at)},
                   {"expires_at", expires_at}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/runs/([\\w-]+)/checkpoints/latest)", latest_checkpoint); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "checkpoint/commit.h"  // commit::latestCommitted
#include "checkpoint/store.h"   // store::runTenant, latestUpload, signUrl

using json = nlohmann::json;

constexpr std::chrono::seconds kUrlTtl{900};  // a read link outlives the resume by minutes, not days

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void latest_checkpoint(const httplib::Request& req, httplib::Response& res) {
  const std::string run_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  // Another tenant's run answers like a missing one: a 403 would confirm that it exists.
  if (store::runTenant(run_id) != tenant) return reply(res, 404, {{"error", "no checkpoint for this run"}});
  const auto record = commit::latestCommitted(run_id);  // committed only: an upload missing a chunk is not a checkpoint
  if (!record) return reply(res, 404, {{"error", "no checkpoint for this run"}});
  const long long expires_at = std::chrono::duration_cast<std::chrono::seconds>((std::chrono::system_clock::now() + kUrlTtl).time_since_epoch()).count();
  reply(res, 200, {{"upload_id", record->upload_id},
                   {"run_id", record->run_id},
                   {"step", record->step},
                   {"chunks", record->chunks},
                   {"digest", record->digest},
                   {"url", store::signUrl(record->upload_id, expires_at)},
                   {"expires_at", expires_at}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/runs/([\\w-]+)/checkpoints/latest)", latest_checkpoint); }
`,
    },
  },
  harness: {
    python: `from checkpoint import store
from checkpoint.commit import commit

T1 = {"X-Tenant-Id": "t1"}


def _checkpoint(run, tenant, step, staged=2):
    """An upload of run's checkpoint at step in 2 chunks, committed when both are staged."""
    store.create_run(run, tenant)
    upload_id = store.open_upload(run, tenant, step, 2)["upload_id"]
    for i in range(staged):
        payload = f"{run} step {step} layer {i}".encode()
        store.put_chunk(upload_id, i, payload, store.digest(payload))
    if staged == 2:
        assert commit(upload_id) is not None, "the harness could not commit its own upload"
    return upload_id


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _latest(c, run, headers=T1):
    return await c.get(f"/v1/runs/{run}/checkpoints/latest", headers=headers)


async def check_route(ctx):
    upload_id = _checkpoint("r1", "t1", 1200)
    async with _api(ctx) as c:
        r = await _latest(c, "r1")
        assert r.status_code == 200, f"GET /v1/runs/r1/checkpoints/latest answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("upload_id") == upload_id and body.get("step") == 1200 and body.get("chunks") == 2, f"the latest checkpoint of r1 is {upload_id} at step 1200 in 2 chunks, got {body}"
        assert store.verify_url(body.get("url", "")), f"the object store refuses the read URL {body.get('url')!r}"
        none = await _latest(c, "r1", headers={})
        assert none.status_code == 401, f"a read without X-Tenant-Id answered {none.status_code}, expected 401"
        missing = await _latest(c, "r404")
    assert missing.status_code == 404, f"an unknown run answered {missing.status_code}, expected 404"


async def check_committed_only(ctx):
    committed = _checkpoint("r1", "t1", 1200)
    _checkpoint("r1", "t1", 1300, staged=1)  # the newer upload is still missing a chunk
    _checkpoint("r3", "t1", 50, staged=1)
    async with _api(ctx) as c:
        r = await _latest(c, "r1")
        body = r.json()
        assert r.status_code == 200 and body.get("step") == 1200 and body.get("upload_id") == committed, f"r1 has step 1200 committed and step 1300 missing a chunk; the read answered {r.status_code} {body}: a trainer would resume from weights that were never complete"
        assert body.get("digest") == store.manifest(committed), f"the read must carry the committed digest {store.manifest(committed)}, got {body.get('digest')!r}"
        r = await _latest(c, "r3")
    assert r.status_code == 404, f"a run with nothing committed answered {r.status_code}: {r.text}, expected 404"


async def check_tenant_404(ctx):
    _checkpoint("r2", "t2", 700)
    async with _api(ctx) as c:
        foreign = await _latest(c, "r2")
        assert foreign.status_code == 404, f"tenant t1 reading tenant t2's run answered {foreign.status_code}: {foreign.text}, expected 404 (the same answer as a missing run)"
        own = await _latest(c, "r2", headers={"X-Tenant-Id": "t2"})
    assert own.status_code == 200 and own.json().get("step") == 700, f"tenant t2 reading its own run answered {own.status_code}: {own.text}"


async def check_url_ttl(ctx):
    _checkpoint("r1", "t1", 1200)
    async with _api(ctx) as c:
        r = await _latest(c, "r1")
    assert r.status_code == 200, f"the read answered {r.status_code}: {r.text}"
    body = r.json()
    lifetime = body.get("expires_at", 0) - ctx.clock.time()
    assert 895 <= lifetime <= 905, f"the read URL lives {lifetime:.0f} s, expected 900 (15 minutes): a link pasted into a ticket must not keep working for days"
    assert f"expires={body.get('expires_at')}" in body.get("url", ""), f"expires_at {body.get('expires_at')} is not the expiry the URL is signed with: {body.get('url')}"
    assert store.verify_url(body["url"]), "the object store refuses the fresh read URL"
    ctx.clock.advance(901)
    assert not store.verify_url(body["url"]), "the object store still serves the read URL 15 minutes later"
`,
    typescript: `const T1 = {'X-Tenant-Id': 't1'};

function setup(ctx) {
  const store = ctx.load('/support/checkpoint/store.ts');
  const {commit} = ctx.load('/support/checkpoint/commit.ts');
  /** An upload of run's checkpoint at step in 2 chunks, committed when both are staged. */
  const checkpoint = async (run: string, tenant: string, step: number, staged = 2): Promise<string> => {
    await store.createRun(run, tenant);
    const {upload_id} = await store.openUpload(run, tenant, step, 2);
    for (let i = 0; i < staged; i++) {
      const payload = Buffer.from(\`\${run} step \${step} layer \${i}\`);
      await store.putChunk(upload_id, i, payload, store.digest(payload));
    }
    if (staged === 2) assert((await commit(upload_id)) !== null, 'the harness could not commit its own upload');
    return upload_id;
  };
  return {c: ctx.client(ctx.load('read').app), store, checkpoint};
}

const latest = (c, run: string, headers: Record<string, string> = T1) => c.get(\`/v1/runs/\${run}/checkpoints/latest\`, {headers});

export async function check_route(ctx) {
  const {c, store, checkpoint} = setup(ctx);
  const uploadId = await checkpoint('r1', 't1', 1200);
  const r = await latest(c, 'r1');
  assert.equal(r.status, 200, \`GET /v1/runs/r1/checkpoints/latest answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.upload_id === uploadId && body.step === 1200 && body.chunks === 2, \`the latest checkpoint of r1 is \${uploadId} at step 1200 in 2 chunks, got \${r.text}\`);
  assert(store.verifyUrl(body.url ?? ''), \`the object store refuses the read URL \${body.url}\`);
  const none = await latest(c, 'r1', {});
  assert.equal(none.status, 401, \`a read without X-Tenant-Id answered \${none.status}, expected 401\`);
  const missing = await latest(c, 'r404');
  assert.equal(missing.status, 404, \`an unknown run answered \${missing.status}, expected 404\`);
}

export async function check_committed_only(ctx) {
  const {c, store, checkpoint} = setup(ctx);
  const committed = await checkpoint('r1', 't1', 1200);
  await checkpoint('r1', 't1', 1300, 1); // the newer upload is still missing a chunk
  await checkpoint('r3', 't1', 50, 1);
  let r = await latest(c, 'r1');
  const body = r.json();
  assert(r.status === 200 && body.step === 1200 && body.upload_id === committed, \`r1 has step 1200 committed and step 1300 missing a chunk; the read answered \${r.status} \${r.text}: a trainer would resume from weights that were never complete\`);
  assert.equal(body.digest, await store.manifest(committed), 'the read must carry the committed digest');
  r = await latest(c, 'r3');
  assert.equal(r.status, 404, \`a run with nothing committed answered \${r.status}: \${r.text}, expected 404\`);
}

export async function check_tenant_404(ctx) {
  const {c, checkpoint} = setup(ctx);
  await checkpoint('r2', 't2', 700);
  const foreign = await latest(c, 'r2');
  assert.equal(foreign.status, 404, \`tenant t1 reading tenant t2's run answered \${foreign.status}: \${foreign.text}, expected 404 (the same answer as a missing run)\`);
  const own = await latest(c, 'r2', {'X-Tenant-Id': 't2'});
  assert(own.status === 200 && own.json().step === 700, \`tenant t2 reading its own run answered \${own.status}: \${own.text}\`);
}

export async function check_url_ttl(ctx) {
  const {c, store, checkpoint} = setup(ctx);
  await checkpoint('r1', 't1', 1200);
  const r = await latest(c, 'r1');
  assert.equal(r.status, 200, \`the read answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const lifetime = body.expires_at - ctx.clock.now() / 1000;
  assert(895 <= lifetime && lifetime <= 905, \`the read URL lives \${lifetime.toFixed(0)} s, expected 900 (15 minutes): a link pasted into a ticket must not keep working for days\`);
  assert(String(body.url).includes(\`expires=\${body.expires_at}\`), \`expires_at \${body.expires_at} is not the expiry the URL is signed with: \${body.url}\`);
  assert(store.verifyUrl(body.url), 'the object store refuses the fresh read URL');
  ctx.clock.advance(901);
  assert(!store.verifyUrl(body.url), 'the object store still serves the read URL 15 minutes later');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"checkpoint/commit"
	"checkpoint/store"

	"leetbuild/harness"
)

var readBg = context.Background()

// readCheckpoint opens an upload of run's checkpoint at step in 2 chunks, committed when both are staged.
func readCheckpoint(ctx *harness.Ctx, runID, tenant string, step int64, staged int) string {
	store.CreateRun(readBg, runID, tenant)
	upload := store.OpenUpload(readBg, runID, tenant, step, 2)
	for i := 0; i < staged; i++ {
		payload := []byte(fmt.Sprintf("%s step %d layer %d", runID, step, i))
		store.PutChunk(readBg, upload.UploadID, int64(i), payload, store.Digest(payload))
	}
	if staged == 2 {
		record, err := commit.Commit(readBg, upload.UploadID)
		ctx.Assert(err == nil && record != nil, "the harness could not commit its own upload: %v", err)
	}
	return upload.UploadID
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type readBody struct {
	UploadID  string \`json:"upload_id"\`
	Step      int64  \`json:"step"\`
	Chunks    int64  \`json:"chunks"\`
	Digest    string \`json:"digest"\`
	URL       string \`json:"url"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

func readLatest(c *harness.HTTP, runID string, header ...string) (*harness.Response, readBody) {
	r := c.Get("/v1/runs/"+runID+"/checkpoints/latest", header...)
	var body readBody
	if r.Status == 200 {
		r.Decode(&body)
	}
	return r, body
}

func CheckRoute(ctx *harness.Ctx) {
	uploadID := readCheckpoint(ctx, "r1", "t1", 1200, 2)
	c := readAPI(ctx)
	r, body := readLatest(c, "r1", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/runs/r1/checkpoints/latest (%s)", r.Text())
	ctx.Assert(body.UploadID == uploadID && body.Step == 1200 && body.Chunks == 2, "the latest checkpoint of r1 is %s at step 1200 in 2 chunks, got %s", uploadID, r.Text())
	ctx.Assert(store.VerifyURL(body.URL), "the object store refuses the read URL %q", body.URL)
	none, _ := readLatest(c, "r1")
	ctx.Equal(none.Status, 401, "a read without X-Tenant-Id")
	missing, _ := readLatest(c, "r404", "X-Tenant-Id", "t1")
	ctx.Equal(missing.Status, 404, "an unknown run")
}

func CheckCommittedOnly(ctx *harness.Ctx) {
	committed := readCheckpoint(ctx, "r1", "t1", 1200, 2)
	readCheckpoint(ctx, "r1", "t1", 1300, 1) // the newer upload is still missing a chunk
	readCheckpoint(ctx, "r3", "t1", 50, 1)
	c := readAPI(ctx)
	r, body := readLatest(c, "r1", "X-Tenant-Id", "t1")
	ctx.Assert(r.Status == 200 && body.Step == 1200 && body.UploadID == committed, "r1 has step 1200 committed and step 1300 missing a chunk; the read answered %d %s: a trainer would resume from weights that were never complete", r.Status, r.Text())
	ctx.Equal(body.Digest, store.Manifest(readBg, committed), "the read must carry the committed digest")
	r, _ = readLatest(c, "r3", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 404, "a run with nothing committed (%s)", r.Text())
}

func CheckTenant404(ctx *harness.Ctx) {
	readCheckpoint(ctx, "r2", "t2", 700, 2)
	c := readAPI(ctx)
	foreign, _ := readLatest(c, "r2", "X-Tenant-Id", "t1")
	ctx.Equal(foreign.Status, 404, "tenant t1 reading tenant t2's run must get the same answer as a missing run (%s)", foreign.Text())
	own, body := readLatest(c, "r2", "X-Tenant-Id", "t2")
	ctx.Assert(own.Status == 200 && body.Step == 700, "tenant t2 reading its own run answered %d %s", own.Status, own.Text())
}

func CheckUrlTtl(ctx *harness.Ctx) {
	readCheckpoint(ctx, "r1", "t1", 1200, 2)
	r, body := readLatest(readAPI(ctx), "r1", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "the read (%s)", r.Text())
	lifetime := float64(body.ExpiresAt) - float64(ctx.Clock.Now())/1000
	ctx.Assert(895 <= lifetime && lifetime <= 905, "the read URL lives %.0f s, expected 900 (15 minutes): a link pasted into a ticket must not keep working for days", lifetime)
	ctx.Assert(strings.Contains(body.URL, fmt.Sprintf("expires=%d", body.ExpiresAt)), "expires_at %d is not the expiry the URL is signed with: %s", body.ExpiresAt, body.URL)
	ctx.Assert(store.VerifyURL(body.URL), "the object store refuses the fresh read URL")
	ctx.Clock.Advance(901)
	ctx.Assert(!store.VerifyURL(body.URL), "the object store still serves the read URL 15 minutes later")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "checkpoint/commit.h"
#include "checkpoint/store.h"

namespace {

// An upload of run's checkpoint at step in 2 chunks, committed when both are staged.
std::string readCheckpoint(harness::Ctx& ctx, const std::string& run_id, const std::string& tenant, long step, int staged = 2) {
  store::createRun(run_id, tenant);
  const store::Upload upload = store::openUpload(run_id, tenant, step, 2);
  for (int i = 0; i < staged; i++) {
    const std::string payload = run_id + " step " + std::to_string(step) + " layer " + std::to_string(i);
    store::putChunk(upload.upload_id, i, payload, store::digest(payload));
  }
  if (staged == 2) ctx.Assert(commit::commit(upload.upload_id).has_value(), "the harness could not commit its own upload");
  return upload.upload_id;
}

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readLatest(harness::HTTP& c, const std::string& run_id, const std::string& tenant = "t1") {
  const std::string path = "/v1/runs/" + run_id + "/checkpoints/latest";
  if (tenant.empty()) return c.Get(path);
  return c.Get(path, "X-Tenant-Id", tenant);
}

nlohmann::json bodyOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string upload_id = readCheckpoint(ctx, "r1", "t1", 1200);
  auto c = readApi(ctx);
  const auto r = readLatest(c, "r1");
  ctx.Equal(r.Status, 200, "GET /v1/runs/r1/checkpoints/latest (%s)", r.Text());
  const auto body = bodyOf(r);
  ctx.Assert(body.value("upload_id", "") == upload_id && body.value("step", 0L) == 1200 && body.value("chunks", 0L) == 2,
             "the latest checkpoint of r1 is %s at step 1200 in 2 chunks, got %s", upload_id, r.Text());
  ctx.Assert(store::verifyUrl(body.value("url", "")), "the object store refuses the read URL %q", body.value("url", ""));
  ctx.Equal(readLatest(c, "r1", "").Status, 401, "a read without X-Tenant-Id");
  ctx.Equal(readLatest(c, "r404").Status, 404, "an unknown run");
}

void CheckCommittedOnly(harness::Ctx& ctx) {
  const std::string committed = readCheckpoint(ctx, "r1", "t1", 1200);
  readCheckpoint(ctx, "r1", "t1", 1300, 1);  // the newer upload is still missing a chunk
  readCheckpoint(ctx, "r3", "t1", 50, 1);
  auto c = readApi(ctx);
  auto r = readLatest(c, "r1");
  const auto body = bodyOf(r);
  ctx.Assert(r.Status == 200 && body.value("step", 0L) == 1200 && body.value("upload_id", "") == committed,
             "r1 has step 1200 committed and step 1300 missing a chunk; the read answered %d %s: a trainer would resume from weights that were never complete",
             r.Status, r.Text());
  ctx.Equal(body.value("digest", ""), store::manifest(committed), "the read must carry the committed digest");
  r = readLatest(c, "r3");
  ctx.Equal(r.Status, 404, "a run with nothing committed (%s)", r.Text());
}

void CheckTenant404(harness::Ctx& ctx) {
  readCheckpoint(ctx, "r2", "t2", 700);
  auto c = readApi(ctx);
  const auto foreign = readLatest(c, "r2", "t1");
  ctx.Equal(foreign.Status, 404, "tenant t1 reading tenant t2's run must get the same answer as a missing run (%s)", foreign.Text());
  const auto own = readLatest(c, "r2", "t2");
  ctx.Assert(own.Status == 200 && bodyOf(own).value("step", 0L) == 700, "tenant t2 reading its own run answered %d %s", own.Status, own.Text());
}

void CheckUrlTtl(harness::Ctx& ctx) {
  readCheckpoint(ctx, "r1", "t1", 1200);
  auto c = readApi(ctx);
  const auto r = readLatest(c, "r1");
  ctx.Equal(r.Status, 200, "the read (%s)", r.Text());
  const auto body = bodyOf(r);
  const long long expires_at = body.value("expires_at", 0LL);
  const std::string url = body.value("url", "");
  const double lifetime = static_cast<double>(expires_at) - static_cast<double>(ctx.Clock.Now()) / 1000;
  ctx.Assert(895 <= lifetime && lifetime <= 905, "the read URL lives %.0f s, expected 900 (15 minutes): a link pasted into a ticket must not keep working for days", lifetime);
  ctx.Assert(url.find("expires=" + std::to_string(expires_at)) != std::string::npos, "expires_at %d is not the expiry the URL is signed with: %s", expires_at, url);
  ctx.Assert(store::verifyUrl(url), "the object store refuses the fresh read URL");
  ctx.Clock.Advance(901);
  ctx.Assert(!store::verifyUrl(url), "the object store still serves the read URL 15 minutes later");
}
`,
  },
  hints: [
    'Leave a newer upload one chunk short and read the run: it answers that upload’s step. Read another tenant’s run id: it answers too. The link it hands out still works a week later.',
    'The handler reads `store.latest_upload`, which indexes every opened upload; it never asks who owns the run; and `URL_TTL_S` signs the URL for seven days.',
    'Before any lookup, 404 unless `store.run_tenant(run_id)` is the caller; read `latest_committed(run_id)`, 404 on None, and answer the record; set `URL_TTL_S = 900` so `expires_at` is now + 900.',
  ],
  debrief: `A resumed run trusts this response without checking, so it may only point at the commit record: the same record step 2 wrote atomically and step 4 announced, never a staged upload. The ownership check comes before any lookup, and a foreign run answers exactly like a missing one, so the endpoint cannot be used to discover which runs exist. The URL is a bearer capability on the weights; fifteen minutes covers a resume and makes a leaked link short-lived. Production stores sign the URL for one object at a time, bind it to the caller's network or identity, and log every redemption, which turns a leaked link into an alert rather than a silent download.`,
};
