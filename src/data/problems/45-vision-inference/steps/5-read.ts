import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: "GET /v1/inferences/{id}: the tenant's own result, pending or expired said out loud",
  concept: 'http',
  guides: ['request-boundaries', 'honest-reads'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/inferences/{inference_id}\`: 401 without
\`X-Tenant-Id\`, 404 when the provided inference store has no such row, then 200 with
\`{inference_id, status, task, label, confidence, model_version, downgraded, content_hash,
created_at}\` from the row. The demo reads back the inference it just made. It hides three flaws.

**Failure mode the checks target.** The row carries its tenant and the starter does not compare it, so
any caller who has an id reads another tenant's prediction. A row the worker has not finished goes out
as a 200 with a null label, which a cache in front of the service keeps as the answer. And a prediction
older than the retention window is still served, though the service promised to stop serving it.

Requirements:

- A row whose \`tenant\` is not the caller's is **404**, the same answer as an id that does not exist.
- A row with \`status\` \`pending\` is **202** with \`{inference_id, status}\` and no result fields.
- A result older than \`RESULT_TTL_S\` (30 days, from \`created_at\`) is **410** with
  \`{inference_id, status: "expired", metadata: {task, content_hash, model_version, created_at}}\`:
  the label and the confidence are gone, the record that a prediction was made stays.
- Otherwise **200** with the fields above.`,
  sequence: {
    participants: ['Client', 'Vision API', 'Inference store'],
    messages: [
      {from: 'Client', to: 'Vision API', label: 'GET /v1/inferences/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Vision API', to: 'Inference store', label: 'by_id(id)', kind: 'sync'},
      {from: 'Inference store', to: 'Vision API', label: 'row · tenant · status · created_at', kind: 'reply'},
      {
        from: 'Vision API',
        to: 'Vision API',
        label: 'other tenant 404 · pending 202 · older than 30 days 410',
        kind: 'sync',
      },
      {from: 'Vision API', to: 'Client', label: '200 {label, confidence, model_version, downgraded}', kind: 'reply'},
    ],
  },
  hints: [
    "Symptom: tenant t1 reads t2's prediction by id, a client polling a fresh inference gets a 200 with a null label, and a 40-day-old prediction is still served.",
    'Mechanism: the handler looks the row up by id alone; it compares neither `row["tenant"]` with the caller nor `created_at` with the clock, and it does not read `status`.',
    'Change: 404 when the row is missing or `row["tenant"] != tenant`; 202 with `{inference_id, status}` while pending; 410 with the metadata when `time.time() - created_at > RESULT_TTL_S`; 200 otherwise.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/inferences/{id}',
      detail:
        "The read route answers the tenant's complete inference with 200 (label, confidence, model_version, downgraded), 401 without X-Tenant-Id and 404 for an unknown id.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/inferences\/\{inference_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/inferences\/:inference_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/inferences\/\{inferenceID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"inferences"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,\n]*v1\/inferences\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Another tenant's id is 404",
      detail:
        'A row that belongs to another tenant answers 404 with the same body an id that does not exist gets, and carries none of the row; that holds for its pending and its expired rows too. The starter serves whichever row the id names.',
      match: {
        python: {all: [/\[\s*["']tenant["']\s*\]\s*!=\s*tenant|\.get\(\s*["']tenant["']\s*\)\s*!=\s*tenant/]},
        typescript: {all: [/\.tenant\s*!==\s*tenant/]},
        go: {all: [/\.Tenant\s*!=\s*tenant/]},
        scala: {all: [/\("tenant"\)\.str\s*!=\s*tenant/]},
        cpp: {all: [/value\(\s*"tenant"\s*,[^)]*\)\s*!=\s*tenant/]},
      },
    },
    {
      id: 'pending-202',
      title: 'A pending inference is 202, not a result',
      detail:
        'A row the worker has not finished answers 202 with inference_id and status pending and nothing else; once it is complete the same id answers 200. The starter answers 200 with a null label.',
      match: {
        python: {all: [/status_code\s*=\s*202/]},
        typescript: {all: [/code\(\s*202\s*\)/]},
        go: {all: [/StatusAccepted/]},
        scala: {all: [/StatusCodes\.Accepted/]},
        cpp: {all: [/\b202\b/]},
      },
    },
    {
      id: 'result-expiry',
      title: 'A result past 30 days is 410 with its metadata',
      detail:
        'A complete row whose created_at is more than RESULT_TTL_S old answers 410 with status expired and metadata of exactly task, content_hash, model_version and created_at, and no label or confidence; the window is counted in seconds, so a minute past 30 days is 410 and a minute short of it is still 200. The starter serves every result forever.',
      match: {
        python: {all: [/RESULT_TTL_S/, /status_code\s*=\s*410/]},
        typescript: {all: [/RESULT_TTL_S/, /code\(\s*410\s*\)/]},
        go: {all: [/ResultTTLSeconds/, /StatusGone/]},
        scala: {all: [/ResultTtlSeconds/, /StatusCodes\.Gone/]},
        cpp: {all: [/kResultTtlSeconds/, /\b410\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from vision.inferences import store

app = FastAPI()

FIELDS = ("inference_id", "status", "task", "label", "confidence", "model_version", "downgraded", "content_hash", "created_at")


@app.get("/v1/inferences/{inference_id}")
def read_inference(inference_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    row = store.by_id(inference_id)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown inference")
    return JSONResponse({key: row.get(key) for key in FIELDS}, status_code=200)
`,
      solution: `import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from vision.config import RESULT_TTL_S
from vision.inferences import store

app = FastAPI()

FIELDS = ("inference_id", "status", "task", "label", "confidence", "model_version", "downgraded", "content_hash", "created_at")
METADATA = ("task", "content_hash", "model_version", "created_at")


@app.get("/v1/inferences/{inference_id}")
def read_inference(inference_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    row = store.by_id(inference_id)
    if row is None or row["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown inference")
    if row["status"] != "complete":
        return JSONResponse({"inference_id": inference_id, "status": row["status"]}, status_code=202)
    if time.time() - row["created_at"] > RESULT_TTL_S:
        metadata = {key: row.get(key) for key in METADATA}
        return JSONResponse({"inference_id": inference_id, "status": "expired", "metadata": metadata}, status_code=410)
    return JSONResponse({key: row.get(key) for key in FIELDS}, status_code=200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {store} from 'vision/inferences';

export const app = Fastify();

app.get('/v1/inferences/:inference_id', async (request, reply) => {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {inference_id: inferenceId} = request.params as {inference_id: string};
  const row = await store.byId(inferenceId);
  if (row === null) return reply.code(404).send({error: 'unknown inference'});
  const {inference_id, status, task, label, confidence, model_version, downgraded, content_hash, created_at} = row;
  return reply.code(200).send({inference_id, status, task, label, confidence, model_version, downgraded, content_hash, created_at});
});
`,
      solution: `import Fastify from 'fastify';

import {RESULT_TTL_S} from 'vision/config';
import {store} from 'vision/inferences';

export const app = Fastify();

app.get('/v1/inferences/:inference_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {inference_id: inferenceId} = request.params as {inference_id: string};
  const row = await store.byId(inferenceId);
  if (row === null || row.tenant !== tenant) return reply.code(404).send({error: 'unknown inference'});
  if (row.status !== 'complete') return reply.code(202).send({inference_id: inferenceId, status: row.status});
  const {inference_id, status, task, label, confidence, model_version, downgraded, content_hash, created_at} = row;
  if (Date.now() / 1000 - created_at > RESULT_TTL_S)
    return reply.code(410).send({inference_id, status: 'expired', metadata: {task, content_hash, model_version, created_at}});
  return reply.code(200).send({inference_id, status, task, label, confidence, model_version, downgraded, content_hash, created_at});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"vision/inferences" // inferences.ByID(ctx, id) — provided
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readInference(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	row, err := inferences.ByID(r.Context(), r.PathValue("inferenceID"))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if row == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown inference"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"inference_id":  row.InferenceID,
		"status":        row.Status,
		"task":          row.Task,
		"label":         row.Label,
		"confidence":    row.Confidence,
		"model_version": row.ModelVersion,
		"downgraded":    row.Downgraded,
		"content_hash":  row.ContentHash,
		"created_at":    row.CreatedAt,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/inferences/{inferenceID}", readInference)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"vision/config"     // config.ResultTTLSeconds — provided
	"vision/inferences" // inferences.ByID(ctx, id) — provided
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readInference(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	row, err := inferences.ByID(r.Context(), r.PathValue("inferenceID"))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if row == nil || row.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown inference"})
		return
	}
	if row.Status != "complete" {
		writeJSON(rw, http.StatusAccepted, map[string]any{"inference_id": row.InferenceID, "status": row.Status})
		return
	}
	if time.Now().Unix()-row.CreatedAt > config.ResultTTLSeconds {
		writeJSON(rw, http.StatusGone, map[string]any{
			"inference_id": row.InferenceID,
			"status":       "expired",
			"metadata":     map[string]any{"task": row.Task, "content_hash": row.ContentHash, "model_version": row.ModelVersion, "created_at": row.CreatedAt},
		})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"inference_id":  row.InferenceID,
		"status":        row.Status,
		"task":          row.Task,
		"label":         row.Label,
		"confidence":    row.Confidence,
		"model_version": row.ModelVersion,
		"downgraded":    row.Downgraded,
		"content_hash":  row.ContentHash,
		"created_at":    row.CreatedAt,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/inferences/{inferenceID}", readInference)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import vision.Inferences

object VisionRead {
  implicit val system: ActorSystem = ActorSystem("vision-read")

  val Fields = Seq("inference_id", "status", "task", "label", "confidence", "model_version", "downgraded", "content_hash", "created_at")

  private def json(status: StatusCode, body: ujson.Value) =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  val route: Route =
    path("v1" / "inferences" / Segment) { inferenceId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
          if (!tenantOpt.exists(_.nonEmpty)) {
            json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id"))
          } else {
            Inferences.byId(inferenceId) match {
              case None => json(StatusCodes.NotFound, ujson.Obj("error" -> "unknown inference"))
              case Some(row) =>
                json(StatusCodes.OK, ujson.Obj.from(Fields.map(k => k -> row.value.getOrElse(k, ujson.Null))))
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import vision.{Config, Inferences}

object VisionRead {
  implicit val system: ActorSystem = ActorSystem("vision-read")

  val Fields = Seq("inference_id", "status", "task", "label", "confidence", "model_version", "downgraded", "content_hash", "created_at")
  val Metadata = Seq("task", "content_hash", "model_version", "created_at")

  private def json(status: StatusCode, body: ujson.Value) =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  val route: Route =
    path("v1" / "inferences" / Segment) { inferenceId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id"))
          } else {
            val tenant = tenantOpt.get
            Inferences.byId(inferenceId) match {
              case Some(row) if row("tenant").str != tenant => json(StatusCodes.NotFound, ujson.Obj("error" -> "unknown inference"))
              case None => json(StatusCodes.NotFound, ujson.Obj("error" -> "unknown inference"))
              case Some(row) if row("status").str != "complete" =>
                json(StatusCodes.Accepted, ujson.Obj("inference_id" -> inferenceId, "status" -> row("status")))
              case Some(row) if System.currentTimeMillis() / 1000 - row("created_at").num.toLong > Config.ResultTtlSeconds =>
                val metadata = ujson.Obj.from(Metadata.map(k => k -> row.value.getOrElse(k, ujson.Null)))
                json(StatusCodes.Gone, ujson.Obj("inference_id" -> inferenceId, "status" -> "expired", "metadata" -> metadata))
              case Some(row) =>
                json(StatusCodes.OK, ujson.Obj.from(Fields.map(k => k -> row.value.getOrElse(k, ujson.Null))))
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

#include <string>

#include "vision/inferences.h"  // inferences::by_id(id) — provided

using json = nlohmann::json;

const char* const kFields[] = {"inference_id", "status", "task", "label", "confidence", "model_version", "downgraded", "content_hash", "created_at"};

void read_inference(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const auto row = inferences::by_id(req.matches[1].str());
  if (!row) {
    res.status = 404;
    res.set_content(R"({"error":"unknown inference"})", "application/json");
    return;
  }
  json body = json::object();
  for (const char* key : kFields) body[key] = row->contains(key) ? (*row)[key] : json();
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/inferences/([^/]+))", read_inference); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "vision/config.h"      // config::kResultTtlSeconds — provided
#include "vision/inferences.h"  // inferences::by_id(id) — provided

using json = nlohmann::json;

const char* const kFields[] = {"inference_id", "status", "task", "label", "confidence", "model_version", "downgraded", "content_hash", "created_at"};
const char* const kMetadata[] = {"task", "content_hash", "model_version", "created_at"};

long long now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_inference(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "missing X-Tenant-Id"}});
  const std::string inference_id = req.matches[1].str();
  const auto row = inferences::by_id(inference_id);
  if (!row || row->value("tenant", "") != tenant) return reply(res, 404, {{"error", "unknown inference"}});
  if (row->value("status", "") != "complete") return reply(res, 202, {{"inference_id", inference_id}, {"status", row->value("status", "")}});
  if (now_s() - row->value("created_at", 0LL) > config::kResultTtlSeconds) {
    json metadata = json::object();
    for (const char* key : kMetadata) metadata[key] = row->contains(key) ? (*row)[key] : json();
    return reply(res, 410, {{"inference_id", inference_id}, {"status", "expired"}, {"metadata", metadata}});
  }
  json body = json::object();
  for (const char* key : kFields) body[key] = row->contains(key) ? (*row)[key] : json();
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/inferences/([^/]+))", read_inference); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json
import time

DAY = 86_400
LARGE = "vision-large-3.1.0"


def _row(ctx, inference_id, tenant="t1", status="complete", age_days=0, age_s=0):
    row = {"inference_id": inference_id, "tenant": tenant, "status": status, "task": "classify", "image": f"tenants/{tenant}/images/cat.jpg", "content_hash": "9f2c41aa", "created_at": int(time.time()) - age_days * DAY - age_s}
    if status == "complete":
        row.update(label="tabby_cat", confidence=0.92, model_version=LARGE, downgraded=False)
    ctx.redis.set(f"vision:inference:{inference_id}", json.dumps(row))


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, inference_id, tenant="t1"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.get(f"/v1/inferences/{inference_id}", headers=headers)


async def check_route(ctx):
    _row(ctx, "inf-1")
    async with _api(ctx) as c:
        r = await _get(c, "inf-1")
        assert r.status_code == 200, f"the tenant's own complete inference answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("label") == "tabby_cat" and body.get("confidence") == 0.92 and body.get("model_version") == LARGE and body.get("downgraded") is False, f"the 200 carries label, confidence, model_version and downgraded: {body}"
        r = await _get(c, "inf-1", tenant=None)
        assert r.status_code == 401, f"without X-Tenant-Id the read must answer 401, got {r.status_code}"
        r = await _get(c, "inf-missing")
        assert r.status_code == 404, f"an unknown id answered {r.status_code}, expected 404"


async def check_tenant_scope(ctx):
    _row(ctx, "inf-t2", tenant="t2")
    _row(ctx, "inf-t2-pending", tenant="t2", status="pending")
    _row(ctx, "inf-t2-old", tenant="t2", age_days=31)
    async with _api(ctx) as c:
        r = await _get(c, "inf-t2", tenant="t1")
        assert r.status_code == 404, f"tenant t1 read t2's inference and got {r.status_code}: {r.text}; another tenant's id must be 404, like an id that does not exist"
        assert "tabby_cat" not in r.text, f"the refusal leaks t2's prediction: {r.text}"
        r = await _get(c, "inf-t2", tenant="t2")
        assert r.status_code == 200, f"t2 reads its own inference, got {r.status_code}"
        foreign = await _get(c, "inf-t2", tenant="t1")
        missing = await _get(c, "inf-t9", tenant="t1")
        assert foreign.text.replace("inf-t2", "{id}") == missing.text.replace("inf-t9", "{id}"), f"another tenant's id must answer exactly like an id that does not exist: {foreign.text} vs {missing.text}"
        for inference_id in ("inf-t2-pending", "inf-t2-old"):
            r = await _get(c, inference_id, tenant="t1")
            assert r.status_code == 404, f"tenant t1 read t2's {inference_id} and got {r.status_code}: {r.text}; the tenant is compared before the status or the age says anything"


async def check_pending_202(ctx):
    _row(ctx, "inf-1", status="pending")
    async with _api(ctx) as c:
        r = await _get(c, "inf-1")
        assert r.status_code == 202, f"an inference the worker has not finished answered {r.status_code}, expected 202: a 200 with a null label is cached as the answer"
        body = r.json()
        assert body.get("status") == "pending" and body.get("inference_id") == "inf-1", f"the 202 says which inference and that it is pending: {body}"
        assert set(body) == {"inference_id", "status"}, f"a pending inference is {{inference_id, status}} and nothing more: {body}"
        _row(ctx, "inf-1")
        r = await _get(c, "inf-1")
        assert r.status_code == 200 and r.json().get("label") == "tabby_cat", f"once complete the same id answers 200 with the label, got {r.status_code}: {r.text}"


async def check_result_expiry(ctx):
    _row(ctx, "inf-old", age_days=31)
    _row(ctx, "inf-recent", age_days=29)
    _row(ctx, "inf-edge-old", age_days=30, age_s=60)
    _row(ctx, "inf-edge-recent", age_days=30, age_s=-60)
    async with _api(ctx) as c:
        r = await _get(c, "inf-old")
        assert r.status_code == 410, f"a 31-day-old result answered {r.status_code}, expected 410: results are kept for RESULT_TTL_S (30 days)"
        body = r.json()
        assert "tabby_cat" not in r.text and "confidence" not in body, f"an expired result must not carry the label or the confidence: {r.text}"
        assert body.get("status") == "expired" and body.get("inference_id") == "inf-old", f"the 410 names the inference and says expired: {body}"
        metadata = body.get("metadata") or {}
        for key, value in (("task", "classify"), ("content_hash", "9f2c41aa"), ("model_version", LARGE)):
            assert metadata.get(key) == value, f"the 410 metadata must keep {key}={value!r}, got {metadata}"
        assert isinstance(metadata.get("created_at"), int), f"the 410 metadata keeps created_at: {metadata}"
        assert set(metadata) == {"task", "content_hash", "model_version", "created_at"}, f"the 410 metadata is task, content_hash, model_version and created_at and nothing more: {metadata}"
        r = await _get(c, "inf-recent")
        assert r.status_code == 200, f"a 29-day-old result is still inside the window, got {r.status_code}"
        r = await _get(c, "inf-edge-old")
        assert r.status_code == 410, f"a result 30 days and one minute old answered {r.status_code}, expected 410: the window is RESULT_TTL_S seconds, not whole days"
        r = await _get(c, "inf-edge-recent")
        assert r.status_code == 200, f"a result one minute short of 30 days answered {r.status_code}, expected 200: it is still inside RESULT_TTL_S"
`,
    typescript: `const DAY = 86_400;
const LARGE = 'vision-large-3.1.0';

function row(ctx, inferenceId: string, {tenant = 't1', status = 'complete', ageDays = 0, ageS = 0} = {}) {
  const r: Record<string, unknown> = {inference_id: inferenceId, tenant, status, task: 'classify', image: \`tenants/\${tenant}/images/cat.jpg\`, content_hash: '9f2c41aa', created_at: Math.floor(ctx.clock.now() / 1000) - ageDays * DAY - ageS};
  if (status === 'complete') Object.assign(r, {label: 'tabby_cat', confidence: 0.92, model_version: LARGE, downgraded: false});
  ctx.redis.set(\`vision:inference:\${inferenceId}\`, JSON.stringify(r));
}

const api = ctx => ctx.client(ctx.load('read').app);
const read = (c, inferenceId: string, tenant: string | null = 't1') => c.get(\`/v1/inferences/\${inferenceId}\`, {headers: tenant ? {'X-Tenant-Id': tenant} : {}});

export async function check_route(ctx) {
  row(ctx, 'inf-1');
  const c = api(ctx);
  let r = await read(c, 'inf-1');
  assert.equal(r.status, 200, \`the tenant's own complete inference answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.label === 'tabby_cat' && body.confidence === 0.92 && body.model_version === LARGE && body.downgraded === false, \`the 200 carries label, confidence, model_version and downgraded: \${r.text}\`);
  r = await read(c, 'inf-1', null);
  assert.equal(r.status, 401, \`without X-Tenant-Id the read must answer 401, got \${r.status}\`);
  r = await read(c, 'inf-missing');
  assert.equal(r.status, 404, \`an unknown id answered \${r.status}, expected 404\`);
}

export async function check_tenant_scope(ctx) {
  row(ctx, 'inf-t2', {tenant: 't2'});
  row(ctx, 'inf-t2-pending', {tenant: 't2', status: 'pending'});
  row(ctx, 'inf-t2-old', {tenant: 't2', ageDays: 31});
  const c = api(ctx);
  let r = await read(c, 'inf-t2', 't1');
  assert.equal(r.status, 404, \`tenant t1 read t2's inference and got \${r.status}: \${r.text}; another tenant's id must be 404, like an id that does not exist\`);
  assert(!r.text.includes('tabby_cat'), \`the refusal leaks t2's prediction: \${r.text}\`);
  r = await read(c, 'inf-t2', 't2');
  assert.equal(r.status, 200, \`t2 reads its own inference, got \${r.status}\`);
  const foreign = await read(c, 'inf-t2', 't1');
  const missing = await read(c, 'inf-t9', 't1');
  assert.equal(foreign.text.replaceAll('inf-t2', '{id}'), missing.text.replaceAll('inf-t9', '{id}'), \`another tenant's id must answer exactly like an id that does not exist: \${foreign.text} vs \${missing.text}\`);
  for (const inferenceId of ['inf-t2-pending', 'inf-t2-old']) {
    r = await read(c, inferenceId, 't1');
    assert.equal(r.status, 404, \`tenant t1 read t2's \${inferenceId} and got \${r.status}: \${r.text}; the tenant is compared before the status or the age says anything\`);
  }
}

export async function check_pending_202(ctx) {
  row(ctx, 'inf-1', {status: 'pending'});
  const c = api(ctx);
  let r = await read(c, 'inf-1');
  assert.equal(r.status, 202, \`an inference the worker has not finished answered \${r.status}, expected 202: a 200 with a null label is cached as the answer\`);
  const body = r.json();
  assert(body.status === 'pending' && body.inference_id === 'inf-1', \`the 202 says which inference and that it is pending: \${r.text}\`);
  assert.deepEqual(Object.keys(body).sort(), ['inference_id', 'status'], \`a pending inference is {inference_id, status} and nothing more: \${r.text}\`);
  row(ctx, 'inf-1');
  r = await read(c, 'inf-1');
  assert(r.status === 200 && r.json().label === 'tabby_cat', \`once complete the same id answers 200 with the label, got \${r.status}: \${r.text}\`);
}

export async function check_result_expiry(ctx) {
  row(ctx, 'inf-old', {ageDays: 31});
  row(ctx, 'inf-recent', {ageDays: 29});
  row(ctx, 'inf-edge-old', {ageDays: 30, ageS: 60});
  row(ctx, 'inf-edge-recent', {ageDays: 30, ageS: -60});
  const c = api(ctx);
  let r = await read(c, 'inf-old');
  assert.equal(r.status, 410, \`a 31-day-old result answered \${r.status}, expected 410: results are kept for RESULT_TTL_S (30 days)\`);
  const body = r.json();
  assert(!r.text.includes('tabby_cat') && !('confidence' in body), \`an expired result must not carry the label or the confidence: \${r.text}\`);
  assert(body.status === 'expired' && body.inference_id === 'inf-old', \`the 410 names the inference and says expired: \${r.text}\`);
  const metadata = body.metadata ?? {};
  for (const [key, value] of [['task', 'classify'], ['content_hash', '9f2c41aa'], ['model_version', LARGE]]) assert.equal(metadata[key], value, \`the 410 metadata must keep \${key}=\${value}, got \${JSON.stringify(metadata)}\`);
  assert(Number.isInteger(metadata.created_at), \`the 410 metadata keeps created_at: \${JSON.stringify(metadata)}\`);
  assert.deepEqual(Object.keys(metadata).sort(), ['content_hash', 'created_at', 'model_version', 'task'], \`the 410 metadata is task, content_hash, model_version and created_at and nothing more: \${JSON.stringify(metadata)}\`);
  r = await read(c, 'inf-recent');
  assert.equal(r.status, 200, \`a 29-day-old result is still inside the window, got \${r.status}\`);
  r = await read(c, 'inf-edge-old');
  assert.equal(r.status, 410, \`a result 30 days and one minute old answered \${r.status}, expected 410: the window is RESULT_TTL_S seconds, not whole days\`);
  r = await read(c, 'inf-edge-recent');
  assert.equal(r.status, 200, \`a result one minute short of 30 days answered \${r.status}, expected 200: it is still inside RESULT_TTL_S\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"leetbuild/harness"
)

const (
	readDay   = 86_400
	readLarge = "vision-large-3.1.0"
)

func readRow(ctx *harness.Ctx, inferenceID, tenant, status string, ageSeconds int64) {
	row := map[string]any{"inference_id": inferenceID, "tenant": tenant, "status": status, "task": "classify", "image": "tenants/" + tenant + "/images/cat.jpg", "content_hash": "9f2c41aa", "created_at": ctx.Clock.Now()/1000 - ageSeconds}
	if status == "complete" {
		row["label"] = "tabby_cat"
		row["confidence"] = 0.92
		row["model_version"] = readLarge
		row["downgraded"] = false
	}
	doc, _ := json.Marshal(row)
	ctx.Redis.Set("vision:inference:"+inferenceID, string(doc))
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func readKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func CheckRoute(ctx *harness.Ctx) {
	readRow(ctx, "inf-1", "t1", "complete", 0)
	c := readClient(ctx)
	r := c.Get("/v1/inferences/inf-1", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "the tenant's own complete inference (%s)", r.Text())
	body := readBody(ctx, r)
	ctx.Assert(body["label"] == "tabby_cat" && body["confidence"] == 0.92 && body["model_version"] == readLarge && body["downgraded"] == false, "the 200 carries label, confidence, model_version and downgraded: %s", r.Text())
	ctx.Equal(c.Get("/v1/inferences/inf-1").Status, 401, "without X-Tenant-Id the read")
	ctx.Equal(c.Get("/v1/inferences/inf-missing", "X-Tenant-Id", "t1").Status, 404, "an unknown id")
}

func CheckTenantScope(ctx *harness.Ctx) {
	readRow(ctx, "inf-t2", "t2", "complete", 0)
	readRow(ctx, "inf-t2-pending", "t2", "pending", 0)
	readRow(ctx, "inf-t2-old", "t2", "complete", 31*readDay)
	c := readClient(ctx)
	r := c.Get("/v1/inferences/inf-t2", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 404, "tenant t1 read t2's inference (%s): another tenant's id must be 404, like an id that does not exist", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), "tabby_cat"), "the refusal leaks t2's prediction: %s", r.Text())
	ctx.Equal(c.Get("/v1/inferences/inf-t2", "X-Tenant-Id", "t2").Status, 200, "t2 reads its own inference")
	foreign := c.Get("/v1/inferences/inf-t2", "X-Tenant-Id", "t1")
	missing := c.Get("/v1/inferences/inf-t9", "X-Tenant-Id", "t1")
	ctx.Equal(strings.ReplaceAll(foreign.Text(), "inf-t2", "{id}"), strings.ReplaceAll(missing.Text(), "inf-t9", "{id}"), "another tenant's id must answer exactly like an id that does not exist; the bodies")
	for _, id := range []string{"inf-t2-pending", "inf-t2-old"} {
		r = c.Get("/v1/inferences/"+id, "X-Tenant-Id", "t1")
		ctx.Equal(r.Status, 404, "tenant t1 read t2's %s (%s): the tenant is compared before the status or the age says anything", id, r.Text())
	}
}

func CheckPending202(ctx *harness.Ctx) {
	readRow(ctx, "inf-1", "t1", "pending", 0)
	c := readClient(ctx)
	r := c.Get("/v1/inferences/inf-1", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 202, "an inference the worker has not finished (a 200 with a null label is cached as the answer)")
	body := readBody(ctx, r)
	ctx.Assert(body["status"] == "pending" && body["inference_id"] == "inf-1", "the 202 says which inference and that it is pending: %s", r.Text())
	ctx.Equal(readKeys(body), []string{"inference_id", "status"}, "a pending inference is {inference_id, status} and nothing more; the 202's fields")
	readRow(ctx, "inf-1", "t1", "complete", 0)
	r = c.Get("/v1/inferences/inf-1", "X-Tenant-Id", "t1")
	ctx.Assert(r.Status == 200 && readBody(ctx, r)["label"] == "tabby_cat", "once complete the same id answers 200 with the label, got %d: %s", r.Status, r.Text())
}

func CheckResultExpiry(ctx *harness.Ctx) {
	readRow(ctx, "inf-old", "t1", "complete", 31*readDay)
	readRow(ctx, "inf-recent", "t1", "complete", 29*readDay)
	readRow(ctx, "inf-edge-old", "t1", "complete", 30*readDay+60)
	readRow(ctx, "inf-edge-recent", "t1", "complete", 30*readDay-60)
	c := readClient(ctx)
	r := c.Get("/v1/inferences/inf-old", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 410, "a 31-day-old result: results are kept for ResultTTLSeconds (30 days)")
	body := readBody(ctx, r)
	_, hasConfidence := body["confidence"]
	ctx.Assert(!strings.Contains(r.Text(), "tabby_cat") && !hasConfidence, "an expired result must not carry the label or the confidence: %s", r.Text())
	ctx.Assert(body["status"] == "expired" && body["inference_id"] == "inf-old", "the 410 names the inference and says expired: %s", r.Text())
	metadata, _ := body["metadata"].(map[string]any)
	ctx.Assert(metadata["task"] == "classify" && metadata["content_hash"] == "9f2c41aa" && metadata["model_version"] == readLarge, "the 410 metadata must keep task, content_hash and model_version, got %v", metadata)
	_, hasCreated := metadata["created_at"].(float64)
	ctx.Assert(hasCreated, "the 410 metadata keeps created_at: %v", metadata)
	ctx.Equal(readKeys(metadata), []string{"content_hash", "created_at", "model_version", "task"}, "the 410 metadata is task, content_hash, model_version and created_at and nothing more; its fields")
	ctx.Equal(c.Get("/v1/inferences/inf-recent", "X-Tenant-Id", "t1").Status, 200, "a 29-day-old result is still inside the window")
	ctx.Equal(c.Get("/v1/inferences/inf-edge-old", "X-Tenant-Id", "t1").Status, 410, "a result 30 days and one minute old: the window is ResultTTLSeconds seconds, not whole days")
	ctx.Equal(c.Get("/v1/inferences/inf-edge-recent", "X-Tenant-Id", "t1").Status, 200, "a result one minute short of 30 days is still inside ResultTTLSeconds")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

constexpr long long kDay = 86400;
const std::string kLarge = "vision-large-3.1.0";

void readRow(harness::Ctx& ctx, const std::string& inference_id, const std::string& tenant = "t1", const std::string& status = "complete", long long age_seconds = 0) {
  json row = {{"inference_id", inference_id}, {"tenant", tenant}, {"status", status}, {"task", "classify"}, {"image", "tenants/" + tenant + "/images/cat.jpg"}, {"content_hash", "9f2c41aa"}, {"created_at", ctx.Clock.Now() / 1000 - age_seconds}};
  if (status == "complete") {
    row["label"] = "tabby_cat";
    row["confidence"] = 0.92;
    row["model_version"] = kLarge;
    row["downgraded"] = false;
  }
  ctx.Redis.Set("vision:inference:" + inference_id, row.dump());
}

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }
  harness::Response read(const std::string& inference_id, const std::string& tenant = "t1") {
    return http.Get("/v1/inferences/" + inference_id, "X-Tenant-Id", tenant);
  }
};

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

std::vector<std::string> keysOf(const json& object) {
  std::vector<std::string> keys;
  for (const auto& [key, value] : object.items()) keys.push_back(key);
  return keys;  // nlohmann::json keeps an object's keys sorted
}

std::string withId(std::string text, const std::string& id) {
  for (auto at = text.find(id); at != std::string::npos; at = text.find(id, at)) text.replace(at, id.size(), "{id}");
  return text;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  readRow(ctx, "inf-1");
  Api api(ctx);
  const auto r = api.read("inf-1");
  ctx.Equal(r.Status, 200, "the tenant's own complete inference (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  ctx.Assert(body.value("label", "") == "tabby_cat" && body.value("confidence", 0.0) == 0.92 && body.value("model_version", "") == kLarge && body.contains("downgraded") && body["downgraded"] == false,
             "the 200 carries label, confidence, model_version and downgraded: %s", r.Text());
  ctx.Equal(api.http.Get("/v1/inferences/inf-1").Status, 401, "without X-Tenant-Id the read");
  ctx.Equal(api.read("inf-missing").Status, 404, "an unknown id");
}

void CheckTenantScope(harness::Ctx& ctx) {
  readRow(ctx, "inf-t2", "t2");
  readRow(ctx, "inf-t2-pending", "t2", "pending");
  readRow(ctx, "inf-t2-old", "t2", "complete", 31 * kDay);
  Api api(ctx);
  const auto r = api.read("inf-t2", "t1");
  ctx.Equal(r.Status, 404, "tenant t1 read t2's inference (%s): another tenant's id must be 404, like an id that does not exist", r.Text());
  ctx.Assert(r.Text().find("tabby_cat") == std::string::npos, "the refusal leaks t2's prediction: %s", r.Text());
  ctx.Equal(api.read("inf-t2", "t2").Status, 200, "t2 reads its own inference");
  ctx.Equal(withId(api.read("inf-t2", "t1").Text(), "inf-t2"), withId(api.read("inf-t9", "t1").Text(), "inf-t9"), "another tenant's id must answer exactly like an id that does not exist; the bodies");
  for (const char* id : {"inf-t2-pending", "inf-t2-old"}) {
    const auto foreign = api.read(id, "t1");
    ctx.Equal(foreign.Status, 404, "tenant t1 read t2's %s (%s): the tenant is compared before the status or the age says anything", id, foreign.Text());
  }
}

void CheckPending202(harness::Ctx& ctx) {
  readRow(ctx, "inf-1", "t1", "pending");
  Api api(ctx);
  auto r = api.read("inf-1");
  ctx.Equal(r.Status, 202, "an inference the worker has not finished (a 200 with a null label is cached as the answer)");
  const json body = bodyOf(ctx, r);
  ctx.Assert(body.value("status", "") == "pending" && body.value("inference_id", "") == "inf-1", "the 202 says which inference and that it is pending: %s", r.Text());
  ctx.Equal(keysOf(body), std::vector<std::string>{"inference_id", "status"}, "a pending inference is {inference_id, status} and nothing more; the 202's fields");
  readRow(ctx, "inf-1");
  r = api.read("inf-1");
  ctx.Assert(r.Status == 200 && bodyOf(ctx, r).value("label", "") == "tabby_cat", "once complete the same id answers 200 with the label, got %d: %s", r.Status, r.Text());
}

void CheckResultExpiry(harness::Ctx& ctx) {
  readRow(ctx, "inf-old", "t1", "complete", 31 * kDay);
  readRow(ctx, "inf-recent", "t1", "complete", 29 * kDay);
  readRow(ctx, "inf-edge-old", "t1", "complete", 30 * kDay + 60);
  readRow(ctx, "inf-edge-recent", "t1", "complete", 30 * kDay - 60);
  Api api(ctx);
  const auto r = api.read("inf-old");
  ctx.Equal(r.Status, 410, "a 31-day-old result: results are kept for kResultTtlSeconds (30 days)");
  const json body = bodyOf(ctx, r);
  ctx.Assert(r.Text().find("tabby_cat") == std::string::npos && !body.contains("confidence"), "an expired result must not carry the label or the confidence: %s", r.Text());
  ctx.Assert(body.value("status", "") == "expired" && body.value("inference_id", "") == "inf-old", "the 410 names the inference and says expired: %s", r.Text());
  const json metadata = body.contains("metadata") && body["metadata"].is_object() ? body["metadata"] : json::object();
  ctx.Assert(metadata.value("task", "") == "classify" && metadata.value("content_hash", "") == "9f2c41aa" && metadata.value("model_version", "") == kLarge,
             "the 410 metadata must keep task, content_hash and model_version, got %s", metadata.dump());
  ctx.Assert(metadata.contains("created_at") && metadata["created_at"].is_number_integer(), "the 410 metadata keeps created_at: %s", metadata.dump());
  ctx.Equal(keysOf(metadata), std::vector<std::string>{"content_hash", "created_at", "model_version", "task"}, "the 410 metadata is task, content_hash, model_version and created_at and nothing more; its fields");
  ctx.Equal(api.read("inf-recent").Status, 200, "a 29-day-old result is still inside the window");
  ctx.Equal(api.read("inf-edge-old").Status, 410, "a result 30 days and one minute old: the window is kResultTtlSeconds seconds, not whole days");
  ctx.Equal(api.read("inf-edge-recent").Status, 200, "a result one minute short of 30 days is still inside kResultTtlSeconds");
}
`,
  },
  debrief: `The read path is where isolation and retention become visible. The tenant test compares the row with the caller, and a mismatch is 404 rather than 403 because a 403 confirms the id exists, which is what an enumeration needs. The 202 keeps a half-written row out of every cache between the worker and the client, and says when to ask again. The two windows split what the service stores from what it must be able to prove: the label has a 30-day shelf life, the fact that a prediction was made outlives it, and 410 rather than 404 says so. Production services also delete the expired label from storage instead of hiding it on read, sign result URLs with a short life of their own, and offer per-tenant retention for regulated customers.`,
};
