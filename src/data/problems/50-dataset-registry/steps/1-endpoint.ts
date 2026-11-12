import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/datasets: versions nobody can edit',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'registry', 'db', 'storage'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/datasets\` with body \`{"dataset", "version",
"content_sha256", "license", "owner", "size_bytes", "row_count"}\` on the registry store
(\`registry.store\`, provided): it takes the tenant from \`X-Tenant-Id\` (or \`public\`), answers 422
when \`dataset\`, \`version\` or \`content_sha256\` is empty, writes the record with
\`store.put_version\` and answers 201 with it. It serves the demo and hides four flaws.

**Failure mode the checks target.** A second register of \`imdb-reviews@2026-01\` points the name at
other bytes, so two training runs that quote it read different data; a record goes in with no owner,
no tenant or a license nobody cleared; and the size a budget is checked against is the caller's
number.

- A version is written once: \`store.create_version(record)\` returns \`False\` when
  \`(dataset, version)\` exists, which is **409**; nothing calls \`put_version\`.
- \`license\` must be in \`ALLOWED_LICENSES\` (\`apache-2.0\`, \`cc-by-4.0\`, \`cc-by-sa-4.0\`, \`mit\`,
  \`odc-by-1.0\`), else **422**.
- \`size_bytes\` and \`row_count\` come from \`store.measure(content_sha256)\`; a hash no object has
  is **422**.
- A missing \`X-Tenant-Id\` is **401**; an empty \`owner\` is **422**. A refused request writes
  nothing.`,
  sequence: {
    participants: ['Client', 'registryd', 'registry store'],
    messages: [
      {from: 'Client', to: 'registryd', label: 'POST /v1/datasets · X-Tenant-Id', kind: 'sync'},
      {from: 'registryd', to: 'registryd', label: 'tenant → 401 · owner, license → 422', kind: 'sync'},
      {from: 'registryd', to: 'registry store', label: 'measure(content_sha256)', kind: 'sync'},
      {from: 'registry store', to: 'registryd', label: '(size_bytes, row_count) · none → 422', kind: 'reply'},
      {from: 'registryd', to: 'registry store', label: 'create_version(record)', kind: 'sync'},
      {from: 'registry store', to: 'registryd', label: 'created · exists → 409', kind: 'reply'},
      {from: 'registryd', to: 'Client', label: '201 {dataset, version, size_bytes, row_count}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/datasets',
      detail: "A valid register answers **201** with the record, which the store holds under the caller's tenant.",
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/datasets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/datasets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/datasets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"datasets"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/datasets"/]},
      },
    },
    {
      id: 'immutable',
      title: 'Re-registering an existing version is 409',
      detail:
        'The record is written with `create_version`/`createVersion`, whose HSETNX refuses an existing `(dataset, version)`; that answer is **409** and the record keeps its first hash. `put_version` writes over it.',
      match: {
        python: {all: [/store\.create_version\(/, /\b409\b/], none: [/put_version\(/]},
        typescript: {all: [/createVersion\(/, /\b409\b/], none: [/putVersion\(/]},
        go: {all: [/store\.CreateVersion\(/, /StatusConflict|\b409\b/], none: [/PutVersion\(/]},
        scala: {all: [/Store\.createVersion\(/, /Conflict|\b409\b/], none: [/putVersion\(/]},
        cpp: {all: [/store::createVersion\(/, /\b409\b/], none: [/putVersion\(/]},
      },
    },
    {
      id: 'license',
      title: 'A license off the allowlist is 422',
      detail:
        '`ALLOWED_LICENSES` is checked on the server and an unknown or missing license is **422** with nothing stored. The starter stores whatever license string arrived, including none.',
      match: {
        python: {all: [/ALLOWED_LICENSES/, /\b422\b/]},
        typescript: {all: [/ALLOWED_LICENSES/, /\b422\b/]},
        go: {all: [/allowedLicenses/, /StatusUnprocessableEntity|\b422\b/]},
        scala: {all: [/AllowedLicenses/, /UnprocessableEntity|\b422\b/]},
        cpp: {all: [/kAllowedLicenses/, /\b422\b/]},
      },
    },
    {
      id: 'measured-size',
      title: 'Size and rows come from the stored object',
      detail:
        "`size_bytes` and `row_count` come from `store.measure` on the content hash, and a hash no object has is **422**. The starter copies the caller's numbers, so a client can under-report a dataset past a budget.",
      match: {
        python: {all: [/store\.measure\(/], none: [/body\.get\(\s*["'](size_bytes|row_count)/]},
        typescript: {all: [/measure\(/], none: [/body\.(size_bytes|row_count)/]},
        go: {all: [/store\.Measure\(/], none: [/body\.(SizeBytes|RowCount)/]},
        scala: {all: [/Store\.measure\(/], none: [/number\(\s*"(size_bytes|row_count)"/]},
        cpp: {all: [/store::measure\(/], none: [/body\.value\(\s*"(size_bytes|row_count)"/]},
      },
    },
    {
      id: 'required-fields',
      title: 'A tenant and an owner before anything is written',
      detail:
        'A request without `X-Tenant-Id` is **401** and an empty `owner` is **422**, both before the store is touched. The starter files a missing tenant under `public` and stores a record with no owner.',
      match: {
        python: {
          all: [/\b401\b/, /["']content_sha256["'],\s*["']owner["']|not body\.get\(\s*["']owner["']\)/],
          none: [/["']public["']/],
        },
        typescript: {all: [/\b401\b/, /'content_sha256',\s*'owner'|!body\.owner\b/], none: [/'public'/]},
        go: {all: [/StatusUnauthorized|\b401\b/, /body\.Owner == ""/], none: [/"public"/]},
        scala: {all: [/Unauthorized|\b401\b/, /"content_sha256",\s*"owner"/], none: [/"public"/]},
        cpp: {all: [/\b401\b/, /"content_sha256",\s*"owner"/], none: [/"public"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from registry import store  # measure, version, put_version, create_version

app = FastAPI()


@app.post("/v1/datasets", status_code=201)
async def register_dataset(request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "public")
    body = await request.json()
    for name in ("dataset", "version", "content_sha256"):
        if not body.get(name):
            raise HTTPException(status_code=422, detail=f"{name} is required")
    record = {
        "tenant": tenant,
        "dataset": body["dataset"],
        "version": body["version"],
        "content_sha256": body["content_sha256"],
        "license": body.get("license", ""),
        "owner": body.get("owner", ""),
        "size_bytes": body.get("size_bytes", 0),
        "row_count": body.get("row_count", 0),
        "status": "registered",
    }
    store.put_version(record)
    return store.version(record["dataset"], record["version"])
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from registry import store  # measure, version, put_version, create_version

app = FastAPI()

ALLOWED_LICENSES = {"apache-2.0", "cc-by-4.0", "cc-by-sa-4.0", "mit", "odc-by-1.0"}


@app.post("/v1/datasets", status_code=201)
async def register_dataset(request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    body = await request.json()
    for name in ("dataset", "version", "content_sha256", "owner"):
        if not body.get(name):
            raise HTTPException(status_code=422, detail=f"{name} is required")
    if body.get("license") not in ALLOWED_LICENSES:
        raise HTTPException(status_code=422, detail="license is not on the allowlist")
    # The registry measures the object itself: the caller's numbers are claims.
    measured = store.measure(body["content_sha256"])
    if measured is None:
        raise HTTPException(status_code=422, detail="no object has that content_sha256")
    size_bytes, row_count = measured
    record = {
        "tenant": tenant,
        "dataset": body["dataset"],
        "version": body["version"],
        "content_sha256": body["content_sha256"],
        "license": body["license"],
        "owner": body["owner"],
        "size_bytes": size_bytes,
        "row_count": row_count,
        "status": "registered",
    }
    # Created once: the HSETNX inside create_version decides, so two racing registers cannot both win.
    if not store.create_version(record):
        raise HTTPException(status_code=409, detail="version already registered; versions are immutable")
    return store.version(record["dataset"], record["version"])
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type VersionRecord, createVersion, measure, putVersion, version} from 'registry/store';

export const app = Fastify();

interface RegisterBody {
  dataset?: string;
  version?: string;
  content_sha256?: string;
  license?: string;
  owner?: string;
  size_bytes?: number;
  row_count?: number;
}

app.post('/v1/datasets', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? 'public';
  const body = request.body as RegisterBody;
  for (const name of ['dataset', 'version', 'content_sha256'] as const) {
    if (!body[name]) return reply.code(422).send({error: \`\${name} is required\`});
  }
  const record: VersionRecord = {
    tenant,
    dataset: String(body.dataset),
    version: String(body.version),
    content_sha256: String(body.content_sha256),
    license: body.license ?? '',
    owner: body.owner ?? '',
    size_bytes: body.size_bytes ?? 0,
    row_count: body.row_count ?? 0,
    status: 'registered',
    report: null,
  };
  await putVersion(record);
  return reply.code(201).send(await version(record.dataset, record.version));
});
`,
      solution: `import Fastify from 'fastify';

import {type VersionRecord, createVersion, measure, putVersion, version} from 'registry/store';

export const app = Fastify();

export const ALLOWED_LICENSES: Record<string, true> = {'apache-2.0': true, 'cc-by-4.0': true, 'cc-by-sa-4.0': true, mit: true, 'odc-by-1.0': true};

interface RegisterBody {
  dataset?: string;
  version?: string;
  content_sha256?: string;
  license?: string;
  owner?: string;
  size_bytes?: number;
  row_count?: number;
}

app.post('/v1/datasets', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as RegisterBody;
  for (const name of ['dataset', 'version', 'content_sha256', 'owner'] as const) {
    if (!body[name]) return reply.code(422).send({error: \`\${name} is required\`});
  }
  if (ALLOWED_LICENSES[body.license ?? ''] !== true) return reply.code(422).send({error: 'license is not on the allowlist'});
  // The registry measures the object itself: the caller's numbers are claims.
  const measured = await measure(String(body.content_sha256));
  if (measured === null) return reply.code(422).send({error: 'no object has that content_sha256'});
  const record: VersionRecord = {
    tenant,
    dataset: String(body.dataset),
    version: String(body.version),
    content_sha256: String(body.content_sha256),
    license: String(body.license),
    owner: String(body.owner),
    size_bytes: measured.size_bytes,
    row_count: measured.row_count,
    status: 'registered',
    report: null,
  };
  // Created once: the HSETNX inside createVersion decides, so two racing registers cannot both win.
  if (!(await createVersion(record))) return reply.code(409).send({error: 'version already registered; versions are immutable'});
  return reply.code(201).send(await version(record.dataset, record.version));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"registry/store" // store.Measure, Version, PutVersion, CreateVersion
)

type registerBody struct {
	Dataset       string \`json:"dataset"\`
	Version       string \`json:"version"\`
	ContentSHA256 string \`json:"content_sha256"\`
	License       string \`json:"license"\`
	Owner         string \`json:"owner"\`
	SizeBytes     int64  \`json:"size_bytes"\`
	RowCount      int64  \`json:"row_count"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerDataset(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		tenant = "public"
	}
	var body registerBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if body.Dataset == "" || body.Version == "" || body.ContentSHA256 == "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "dataset, version and content_sha256 are required"})
		return
	}
	record := &store.VersionRecord{
		Tenant: tenant, Dataset: body.Dataset, Version: body.Version, ContentSHA256: body.ContentSHA256,
		License: body.License, Owner: body.Owner, SizeBytes: body.SizeBytes, RowCount: body.RowCount, Status: "registered",
	}
	if err := store.PutVersion(r.Context(), record); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(rw, http.StatusCreated, store.Version(r.Context(), body.Dataset, body.Version))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/datasets", registerDataset)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"registry/store" // store.Measure, Version, PutVersion, CreateVersion
)

var allowedLicenses = map[string]bool{"apache-2.0": true, "cc-by-4.0": true, "cc-by-sa-4.0": true, "mit": true, "odc-by-1.0": true}

type registerBody struct {
	Dataset       string \`json:"dataset"\`
	Version       string \`json:"version"\`
	ContentSHA256 string \`json:"content_sha256"\`
	License       string \`json:"license"\`
	Owner         string \`json:"owner"\`
	SizeBytes     int64  \`json:"size_bytes"\`
	RowCount      int64  \`json:"row_count"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerDataset(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body registerBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if body.Dataset == "" || body.Version == "" || body.ContentSHA256 == "" || body.Owner == "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "dataset, version, content_sha256 and owner are required"})
		return
	}
	if !allowedLicenses[body.License] {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "license is not on the allowlist"})
		return
	}
	// The registry measures the object itself: the caller's numbers are claims.
	sizeBytes, rowCount, found := store.Measure(r.Context(), body.ContentSHA256)
	if !found {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "no object has that content_sha256"})
		return
	}
	record := &store.VersionRecord{
		Tenant: tenant, Dataset: body.Dataset, Version: body.Version, ContentSHA256: body.ContentSHA256,
		License: body.License, Owner: body.Owner, SizeBytes: sizeBytes, RowCount: rowCount, Status: "registered",
	}
	// Created once: the HSETNX inside CreateVersion decides, so two racing registers cannot both win.
	created, err := store.CreateVersion(r.Context(), record)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !created {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "version already registered; versions are immutable"})
		return
	}
	writeJSON(rw, http.StatusCreated, store.Version(r.Context(), body.Dataset, body.Version))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/datasets", registerDataset)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import registry.Store // Store.measure, version, putVersion, createVersion

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  def recordJson(rec: Store.VersionRecord): JsObject = JsObject(
    "tenant" -> JsString(rec.tenant), "dataset" -> JsString(rec.dataset), "version" -> JsString(rec.version),
    "content_sha256" -> JsString(rec.contentSha256), "license" -> JsString(rec.license), "owner" -> JsString(rec.owner),
    "size_bytes" -> JsNumber(rec.sizeBytes), "row_count" -> JsNumber(rec.rowCount), "status" -> JsString(rec.status))

  val route: Route = path("v1" / "datasets") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val tenant = header.getOrElse("public")
          val body = raw.parseJson.asJsObject.fields
          def text(name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
          def number(name: String): Long = body.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
          Seq("dataset", "version", "content_sha256").find(name => text(name).isEmpty) match {
            case Some(name) => complete(error(StatusCodes.UnprocessableEntity, s"$name is required"))
            case None =>
              val rec = Store.VersionRecord(tenant, text("dataset"), text("version"), text("content_sha256"), text("license"),
                text("owner"), number("size_bytes"), number("row_count"))
              Store.putVersion(rec)
              complete(json(StatusCodes.Created, recordJson(rec)))
          }
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

import registry.Store // Store.measure, version, putVersion, createVersion

object Api {
  val AllowedLicenses: Set[String] = Set("apache-2.0", "cc-by-4.0", "cc-by-sa-4.0", "mit", "odc-by-1.0")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  def recordJson(rec: Store.VersionRecord): JsObject = JsObject(
    "tenant" -> JsString(rec.tenant), "dataset" -> JsString(rec.dataset), "version" -> JsString(rec.version),
    "content_sha256" -> JsString(rec.contentSha256), "license" -> JsString(rec.license), "owner" -> JsString(rec.owner),
    "size_bytes" -> JsNumber(rec.sizeBytes), "row_count" -> JsNumber(rec.rowCount), "status" -> JsString(rec.status))

  val route: Route = path("v1" / "datasets") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            def text(name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
            Seq("dataset", "version", "content_sha256", "owner").find(name => text(name).isEmpty) match {
              case Some(name) => complete(error(StatusCodes.UnprocessableEntity, s"$name is required"))
              case None if !AllowedLicenses.contains(text("license")) =>
                complete(error(StatusCodes.UnprocessableEntity, "license is not on the allowlist"))
              case None =>
                // The registry measures the object itself: the caller's numbers are claims.
                Store.measure(text("content_sha256")) match {
                  case None => complete(error(StatusCodes.UnprocessableEntity, "no object has that content_sha256"))
                  case Some((sizeBytes, rowCount)) =>
                    val rec = Store.VersionRecord(tenant, text("dataset"), text("version"), text("content_sha256"), text("license"),
                      text("owner"), sizeBytes, rowCount)
                    // Created once: the HSETNX inside createVersion decides, so two racing registers cannot both win.
                    if (Store.createVersion(rec)) complete(json(StatusCodes.Created, recordJson(rec)))
                    else complete(error(StatusCodes.Conflict, "version already registered; versions are immutable"))
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

#include "registry/store.h"  // store::measure, version, putVersion, createVersion

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json recordJson(const store::VersionRecord& rec) {
  return json{{"tenant", rec.tenant},   {"dataset", rec.dataset},     {"version", rec.version},
              {"content_sha256", rec.content_sha256}, {"license", rec.license}, {"owner", rec.owner},
              {"size_bytes", rec.size_bytes}, {"row_count", rec.row_count}, {"status", rec.status}};
}

void register_dataset(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) tenant = "public";
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "invalid JSON"}});
  for (const char* name : {"dataset", "version", "content_sha256"}) {
    if (body.value(name, "").empty()) return reply(res, 422, {{"error", std::string(name) + " is required"}});
  }
  store::VersionRecord rec;
  rec.tenant = tenant;
  rec.dataset = body.value("dataset", "");
  rec.version = body.value("version", "");
  rec.content_sha256 = body.value("content_sha256", "");
  rec.license = body.value("license", "");
  rec.owner = body.value("owner", "");
  rec.size_bytes = body.value("size_bytes", 0LL);
  rec.row_count = body.value("row_count", 0LL);
  store::putVersion(rec);
  reply(res, 201, recordJson(*store::version(rec.dataset, rec.version)));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/datasets", register_dataset); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "registry/store.h"  // store::measure, version, putVersion, createVersion

using json = nlohmann::json;

const std::set<std::string> kAllowedLicenses = {"apache-2.0", "cc-by-4.0", "cc-by-sa-4.0", "mit", "odc-by-1.0"};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json recordJson(const store::VersionRecord& rec) {
  return json{{"tenant", rec.tenant},   {"dataset", rec.dataset},     {"version", rec.version},
              {"content_sha256", rec.content_sha256}, {"license", rec.license}, {"owner", rec.owner},
              {"size_bytes", rec.size_bytes}, {"row_count", rec.row_count}, {"status", rec.status}};
}

void register_dataset(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "invalid JSON"}});
  for (const char* name : {"dataset", "version", "content_sha256", "owner"}) {
    if (body.value(name, "").empty()) return reply(res, 422, {{"error", std::string(name) + " is required"}});
  }
  if (!kAllowedLicenses.count(body.value("license", ""))) return reply(res, 422, {{"error", "license is not on the allowlist"}});
  // The registry measures the object itself: the caller's numbers are claims.
  const auto measured = store::measure(body.value("content_sha256", ""));
  if (!measured) return reply(res, 422, {{"error", "no object has that content_sha256"}});
  store::VersionRecord rec;
  rec.tenant = tenant;
  rec.dataset = body.value("dataset", "");
  rec.version = body.value("version", "");
  rec.content_sha256 = body.value("content_sha256", "");
  rec.license = body.value("license", "");
  rec.owner = body.value("owner", "");
  rec.size_bytes = measured->size_bytes;
  rec.row_count = measured->row_count;
  // Created once: the HSETNX inside createVersion decides, so two racing registers cannot both win.
  if (!store::createVersion(rec)) return reply(res, 409, {{"error", "version already registered; versions are immutable"}});
  reply(res, 201, recordJson(*store::version(rec.dataset, rec.version)));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/datasets", register_dataset); }
`,
    },
  },
  harness: {
    python: `from registry import store

ROWS = "".join(f"{i},review {i},pos\\n" for i in range(1, 13))
TENANT = {"X-Tenant-Id": "t1"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _body(sha, **changes):
    body = {"dataset": "imdb-reviews", "version": "2026-01", "content_sha256": sha, "license": "cc-by-4.0", "owner": "team-lm"}
    body.update(changes)
    return {name: value for name, value in body.items() if value is not None}


async def check_route(ctx):
    sha = store.put_object(ROWS)
    async with _api(ctx) as c:
        r = await c.post("/v1/datasets", json=_body(sha), headers=TENANT)
    assert r.status_code == 201, f"POST /v1/datasets answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("dataset") == "imdb-reviews" and body.get("version") == "2026-01" and body.get("content_sha256") == sha, f"the 201 must carry the record, got {body}"
    record = store.version("imdb-reviews", "2026-01")
    assert record is not None and record["tenant"] == "t1", f"the store holds {record}, expected the version under tenant t1"


async def check_immutable(ctx):
    first = store.put_object(ROWS)
    second = store.put_object(ROWS + "13,review 13,neg\\n")
    async with _api(ctx) as c:
        r = await c.post("/v1/datasets", json=_body(first), headers=TENANT)
        assert r.status_code == 201, f"the first register answered {r.status_code}: {r.text}"
        again = await c.post("/v1/datasets", json=_body(second), headers=TENANT)
    assert again.status_code == 409, f"re-registering imdb-reviews@2026-01 with other bytes answered {again.status_code}, expected 409"
    record = store.version("imdb-reviews", "2026-01")
    assert record["content_sha256"] == first, f"imdb-reviews@2026-01 now names {record['content_sha256'][:12]}…, not the first object {first[:12]}…: a run that quoted the version reads other bytes"


async def check_license(ctx):
    sha = store.put_object(ROWS)
    async with _api(ctx) as c:
        r = await c.post("/v1/datasets", json=_body(sha, license="proprietary"), headers=TENANT)
        assert r.status_code == 422, f"a register under license proprietary answered {r.status_code}, expected 422"
        assert store.version("imdb-reviews", "2026-01") is None, "a refused license must leave nothing in the store"
        r = await c.post("/v1/datasets", json=_body(sha, version="2026-02", license=None), headers=TENANT)
        assert r.status_code == 422, f"a register with no license answered {r.status_code}, expected 422"
        r = await c.post("/v1/datasets", json=_body(sha, version="2026-03", license="mit"), headers=TENANT)
    assert r.status_code == 201, f"a register under license mit answered {r.status_code}: {r.text}"


async def check_measured_size(ctx):
    sha = store.put_object(ROWS)
    async with _api(ctx) as c:
        r = await c.post("/v1/datasets", json=_body(sha, size_bytes=1, row_count=1), headers=TENANT)
        assert r.status_code == 201, f"the register answered {r.status_code}: {r.text}"
        record = store.version("imdb-reviews", "2026-01")
        assert (record["size_bytes"], record["row_count"]) == (len(ROWS), 12), f"the record says {record['size_bytes']} bytes and {record['row_count']} rows, the object holds {len(ROWS)} bytes in 12 rows: the caller's numbers were stored"
        r = await c.post("/v1/datasets", json=_body("0" * 64, version="2026-02"), headers=TENANT)
    assert r.status_code == 422, f"a register naming a hash no object has answered {r.status_code}, expected 422"
    assert store.version("imdb-reviews", "2026-02") is None, "a version with no object behind it must not be stored"


async def check_required_fields(ctx):
    sha = store.put_object(ROWS)
    async with _api(ctx) as c:
        r = await c.post("/v1/datasets", json=_body(sha, owner=None), headers=TENANT)
        assert r.status_code == 422, f"a register with no owner answered {r.status_code}, expected 422"
        assert store.version("imdb-reviews", "2026-01") is None, "a version with no owner must not be stored"
        r = await c.post("/v1/datasets", json=_body(sha, version="2026-02"))
        assert r.status_code == 401, f"a register without X-Tenant-Id answered {r.status_code}, expected 401"
        assert store.version("imdb-reviews", "2026-02") is None, "a version with no tenant must not be stored"
        r = await c.post("/v1/datasets", json=_body(sha, version="2026-03"), headers={"X-Tenant-Id": "t2"})
    assert r.status_code == 201, f"a complete register answered {r.status_code}: {r.text}"
    assert store.version("imdb-reviews", "2026-03")["tenant"] == "t2", "the record must carry the caller's tenant"
`,
    typescript: `const ROWS = Array.from({length: 12}, (_, i) => \`\${i + 1},review \${i + 1},pos\\n\`).join('');
const TENANT = {'X-Tenant-Id': 't1'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/registry/store.ts')};
}

function body(sha: string, changes: Record<string, unknown> = {}) {
  const out = {dataset: 'imdb-reviews', version: '2026-01', content_sha256: sha, license: 'cc-by-4.0', owner: 'team-lm', ...changes};
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null));
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const sha = await store.putObject(ROWS);
  const r = await c.post('/v1/datasets', {json: body(sha), headers: TENANT});
  assert.equal(r.status, 201, \`POST /v1/datasets answered \${r.status}: \${r.text}\`);
  const got = r.json();
  assert(got.dataset === 'imdb-reviews' && got.version === '2026-01' && got.content_sha256 === sha, \`the 201 must carry the record, got \${r.text}\`);
  const record = await store.version('imdb-reviews', '2026-01');
  assert(record !== null && record.tenant === 't1', \`the store holds \${JSON.stringify(record)}, expected the version under tenant t1\`);
}

export async function check_immutable(ctx) {
  const {c, store} = api(ctx);
  const first = await store.putObject(ROWS);
  const second = await store.putObject(ROWS + '13,review 13,neg\\n');
  const r = await c.post('/v1/datasets', {json: body(first), headers: TENANT});
  assert.equal(r.status, 201, \`the first register answered \${r.status}: \${r.text}\`);
  const again = await c.post('/v1/datasets', {json: body(second), headers: TENANT});
  assert.equal(again.status, 409, \`re-registering imdb-reviews@2026-01 with other bytes answered \${again.status}, expected 409\`);
  const record = await store.version('imdb-reviews', '2026-01');
  assert.equal(record.content_sha256, first, 'imdb-reviews@2026-01 now names another object: a run that quoted the version reads other bytes');
}

export async function check_license(ctx) {
  const {c, store} = api(ctx);
  const sha = await store.putObject(ROWS);
  let r = await c.post('/v1/datasets', {json: body(sha, {license: 'proprietary'}), headers: TENANT});
  assert.equal(r.status, 422, \`a register under license proprietary answered \${r.status}, expected 422\`);
  assert.equal(await store.version('imdb-reviews', '2026-01'), null, 'a refused license must leave nothing in the store');
  r = await c.post('/v1/datasets', {json: body(sha, {version: '2026-02', license: null}), headers: TENANT});
  assert.equal(r.status, 422, \`a register with no license answered \${r.status}, expected 422\`);
  r = await c.post('/v1/datasets', {json: body(sha, {version: '2026-03', license: 'mit'}), headers: TENANT});
  assert.equal(r.status, 201, \`a register under license mit answered \${r.status}: \${r.text}\`);
}

export async function check_measured_size(ctx) {
  const {c, store} = api(ctx);
  const sha = await store.putObject(ROWS);
  let r = await c.post('/v1/datasets', {json: body(sha, {size_bytes: 1, row_count: 1}), headers: TENANT});
  assert.equal(r.status, 201, \`the register answered \${r.status}: \${r.text}\`);
  const record = await store.version('imdb-reviews', '2026-01');
  assert(record.size_bytes === ROWS.length && record.row_count === 12, \`the record says \${record.size_bytes} bytes and \${record.row_count} rows, the object holds \${ROWS.length} bytes in 12 rows: the caller's numbers were stored\`);
  r = await c.post('/v1/datasets', {json: body('0'.repeat(64), {version: '2026-02'}), headers: TENANT});
  assert.equal(r.status, 422, \`a register naming a hash no object has answered \${r.status}, expected 422\`);
  assert.equal(await store.version('imdb-reviews', '2026-02'), null, 'a version with no object behind it must not be stored');
}

export async function check_required_fields(ctx) {
  const {c, store} = api(ctx);
  const sha = await store.putObject(ROWS);
  let r = await c.post('/v1/datasets', {json: body(sha, {owner: null}), headers: TENANT});
  assert.equal(r.status, 422, \`a register with no owner answered \${r.status}, expected 422\`);
  assert.equal(await store.version('imdb-reviews', '2026-01'), null, 'a version with no owner must not be stored');
  r = await c.post('/v1/datasets', {json: body(sha, {version: '2026-02'})});
  assert.equal(r.status, 401, \`a register without X-Tenant-Id answered \${r.status}, expected 401\`);
  assert.equal(await store.version('imdb-reviews', '2026-02'), null, 'a version with no tenant must not be stored');
  r = await c.post('/v1/datasets', {json: body(sha, {version: '2026-03'}), headers: {'X-Tenant-Id': 't2'}});
  assert.equal(r.status, 201, \`a complete register answered \${r.status}: \${r.text}\`);
  assert.equal((await store.version('imdb-reviews', '2026-03')).tenant, 't2', 'the record must carry the caller\\'s tenant');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"registry/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

func apiRows(n int) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&b, "%d,review %d,pos\\n", i, i)
	}
	return b.String()
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// apiBody is a valid register body for sha with changes applied (a nil value removes the field).
func apiBody(sha string, changes map[string]any) map[string]any {
	out := map[string]any{"dataset": "imdb-reviews", "version": "2026-01", "content_sha256": sha, "license": "cc-by-4.0", "owner": "team-lm"}
	for k, v := range changes {
		if v == nil {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	sha := store.PutObject(apiBg, apiRows(12))
	r := c.Post("/v1/datasets", apiBody(sha, nil), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "POST /v1/datasets (%s)", r.Text())
	var got struct {
		Dataset       string \`json:"dataset"\`
		Version       string \`json:"version"\`
		ContentSHA256 string \`json:"content_sha256"\`
	}
	r.Decode(&got)
	ctx.Assert(got.Dataset == "imdb-reviews" && got.Version == "2026-01" && got.ContentSHA256 == sha, "the 201 must carry the record, got %s", r.Text())
	rec := store.Version(apiBg, "imdb-reviews", "2026-01")
	ctx.Assert(rec != nil && rec.Tenant == "t1", "the store holds %+v, expected the version under tenant t1", rec)
}

func CheckImmutable(ctx *harness.Ctx) {
	c := api(ctx)
	first := store.PutObject(apiBg, apiRows(12))
	second := store.PutObject(apiBg, apiRows(13))
	r := c.Post("/v1/datasets", apiBody(first, nil), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "the first register (%s)", r.Text())
	again := c.Post("/v1/datasets", apiBody(second, nil), "X-Tenant-Id", "t1")
	ctx.Equal(again.Status, 409, "re-registering imdb-reviews@2026-01 with other bytes")
	rec := store.Version(apiBg, "imdb-reviews", "2026-01")
	ctx.Equal(rec.ContentSHA256, first, "imdb-reviews@2026-01 must keep its first object (a run that quoted the version would read other bytes); its content_sha256")
}

func CheckLicense(ctx *harness.Ctx) {
	c := api(ctx)
	sha := store.PutObject(apiBg, apiRows(12))
	r := c.Post("/v1/datasets", apiBody(sha, map[string]any{"license": "proprietary"}), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 422, "a register under license proprietary")
	ctx.Assert(store.Version(apiBg, "imdb-reviews", "2026-01") == nil, "a refused license must leave nothing in the store")
	r = c.Post("/v1/datasets", apiBody(sha, map[string]any{"version": "2026-02", "license": nil}), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 422, "a register with no license")
	r = c.Post("/v1/datasets", apiBody(sha, map[string]any{"version": "2026-03", "license": "mit"}), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "a register under license mit (%s)", r.Text())
}

func CheckMeasuredSize(ctx *harness.Ctx) {
	c := api(ctx)
	rows := apiRows(12)
	sha := store.PutObject(apiBg, rows)
	r := c.Post("/v1/datasets", apiBody(sha, map[string]any{"size_bytes": 1, "row_count": 1}), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "the register (%s)", r.Text())
	rec := store.Version(apiBg, "imdb-reviews", "2026-01")
	ctx.Assert(rec.SizeBytes == int64(len(rows)) && rec.RowCount == 12, "the record says %d bytes and %d rows, the object holds %d bytes in 12 rows: the caller's numbers were stored", rec.SizeBytes, rec.RowCount, len(rows))
	r = c.Post("/v1/datasets", apiBody(strings.Repeat("0", 64), map[string]any{"version": "2026-02"}), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 422, "a register naming a hash no object has")
	ctx.Assert(store.Version(apiBg, "imdb-reviews", "2026-02") == nil, "a version with no object behind it must not be stored")
}

func CheckRequiredFields(ctx *harness.Ctx) {
	c := api(ctx)
	sha := store.PutObject(apiBg, apiRows(12))
	r := c.Post("/v1/datasets", apiBody(sha, map[string]any{"owner": nil}), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 422, "a register with no owner")
	ctx.Assert(store.Version(apiBg, "imdb-reviews", "2026-01") == nil, "a version with no owner must not be stored")
	r = c.Post("/v1/datasets", apiBody(sha, map[string]any{"version": "2026-02"}))
	ctx.Equal(r.Status, 401, "a register without X-Tenant-Id")
	ctx.Assert(store.Version(apiBg, "imdb-reviews", "2026-02") == nil, "a version with no tenant must not be stored")
	r = c.Post("/v1/datasets", apiBody(sha, map[string]any{"version": "2026-03"}), "X-Tenant-Id", "t2")
	ctx.Equal(r.Status, 201, "a complete register (%s)", r.Text())
	ctx.Equal(store.Version(apiBg, "imdb-reviews", "2026-03").Tenant, "t2", "the record must carry the caller's tenant")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

std::string rows(int n) {
  std::string out;
  for (int i = 1; i <= n; i++) out += std::to_string(i) + ",review " + std::to_string(i) + ",pos\\n";
  return out;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// A valid register body for sha with changes applied (a null value removes the field).
std::string body(const std::string& sha, const nlohmann::json& changes = nlohmann::json::object()) {
  nlohmann::json out = {{"dataset", "imdb-reviews"}, {"version", "2026-01"}, {"content_sha256", sha}, {"license", "cc-by-4.0"}, {"owner", "team-lm"}};
  for (const auto& [k, v] : changes.items()) {
    if (v.is_null()) out.erase(k);
    else out[k] = v;
  }
  return out.dump();
}

harness::Response post(harness::HTTP& c, const std::string& payload, const std::string& tenant) {
  if (tenant.empty()) return c.Post("/v1/datasets", payload, "Content-Type", "application/json");
  return c.Post("/v1/datasets", payload, "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string sha = store::putObject(rows(12));
  const auto r = post(c, body(sha), "t1");
  ctx.Equal(r.Status, 201, "POST /v1/datasets (%s)", r.Text());
  const auto got = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(got.is_object() && got.value("dataset", "") == "imdb-reviews" && got.value("version", "") == "2026-01" && got.value("content_sha256", "") == sha,
             "the 201 must carry the record, got %s", r.Text());
  const auto rec = store::version("imdb-reviews", "2026-01");
  ctx.Assert(rec && rec->tenant == "t1", "the store holds tenant %q, expected the version under tenant t1", rec ? rec->tenant : "(no record)");
}

void CheckImmutable(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string first = store::putObject(rows(12));
  const std::string second = store::putObject(rows(13));
  const auto r = post(c, body(first), "t1");
  ctx.Equal(r.Status, 201, "the first register (%s)", r.Text());
  const auto again = post(c, body(second), "t1");
  ctx.Equal(again.Status, 409, "re-registering imdb-reviews@2026-01 with other bytes");
  ctx.Equal(store::version("imdb-reviews", "2026-01")->content_sha256, first,
            "imdb-reviews@2026-01 must keep its first object (a run that quoted the version would read other bytes); its content_sha256");
}

void CheckLicense(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string sha = store::putObject(rows(12));
  auto r = post(c, body(sha, {{"license", "proprietary"}}), "t1");
  ctx.Equal(r.Status, 422, "a register under license proprietary");
  ctx.Assert(!store::version("imdb-reviews", "2026-01"), "a refused license must leave nothing in the store");
  r = post(c, body(sha, {{"version", "2026-02"}, {"license", nullptr}}), "t1");
  ctx.Equal(r.Status, 422, "a register with no license");
  r = post(c, body(sha, {{"version", "2026-03"}, {"license", "mit"}}), "t1");
  ctx.Equal(r.Status, 201, "a register under license mit (%s)", r.Text());
}

void CheckMeasuredSize(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string content = rows(12);
  const std::string sha = store::putObject(content);
  auto r = post(c, body(sha, {{"size_bytes", 1}, {"row_count", 1}}), "t1");
  ctx.Equal(r.Status, 201, "the register (%s)", r.Text());
  const auto rec = store::version("imdb-reviews", "2026-01");
  ctx.Assert(rec && rec->size_bytes == static_cast<long long>(content.size()) && rec->row_count == 12,
             "the record says %d bytes and %d rows, the object holds %d bytes in 12 rows: the caller's numbers were stored",
             rec ? rec->size_bytes : 0LL, rec ? rec->row_count : 0LL, content.size());
  r = post(c, body(std::string(64, '0'), {{"version", "2026-02"}}), "t1");
  ctx.Equal(r.Status, 422, "a register naming a hash no object has");
  ctx.Assert(!store::version("imdb-reviews", "2026-02"), "a version with no object behind it must not be stored");
}

void CheckRequiredFields(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string sha = store::putObject(rows(12));
  auto r = post(c, body(sha, {{"owner", nullptr}}), "t1");
  ctx.Equal(r.Status, 422, "a register with no owner");
  ctx.Assert(!store::version("imdb-reviews", "2026-01"), "a version with no owner must not be stored");
  r = post(c, body(sha, {{"version", "2026-02"}}), "");
  ctx.Equal(r.Status, 401, "a register without X-Tenant-Id");
  ctx.Assert(!store::version("imdb-reviews", "2026-02"), "a version with no tenant must not be stored");
  r = post(c, body(sha, {{"version", "2026-03"}}), "t2");
  ctx.Equal(r.Status, 201, "a complete register (%s)", r.Text());
  ctx.Equal(store::version("imdb-reviews", "2026-03")->tenant, "t2", "the record must carry the caller's tenant");
}
`,
  },
  hints: [
    'Register `imdb-reviews@2026-01` twice with two different files: both answers are 201 and the record now names the second file. A body claiming `size_bytes: 1` is stored as one byte.',
    "`put_version` writes over whatever the key holds, and the handler copies every field from the body: license, owner and sizes are the caller's claims, and a missing header becomes the `public` tenant.",
    'Answer 401 without `X-Tenant-Id`, 422 on an empty `owner`, a license outside `ALLOWED_LICENSES` or a hash `store.measure` cannot find; build the record from `measure`, write it with `store.create_version`, and answer 409 when it returns False.',
  ],
  debrief: `A version name is only worth quoting if it cannot change, so the write itself has to refuse: \`create_version\` decides with HSETNX on the server, which a read-then-write check in the handler cannot do when two registers race. Measuring the object is the same idea applied to sizes: the registry records what it read, so quotas and training budgets are computed on facts. The tenant and owner checks run before any write, which keeps refused requests from leaving half a record behind. A production registry also hashes the bytes on upload instead of trusting the caller's hash, keeps license metadata with its provenance (who cleared it, under which terms), and lets a version be deprecated without ever being renamed.`,
};
