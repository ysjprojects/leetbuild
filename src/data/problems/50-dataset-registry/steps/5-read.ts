import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/datasets/{dataset}/versions/{version}: provenance, not just bytes',
  concept: 'http',
  file: 'read',
  focus: ['client', 'registry', 'db', 'storage'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/datasets/{dataset}/versions/{version}\` with
\`X-Tenant-Id\` (401 without it): \`latest\` resolves to the newest name in \`store.versions\`, the
record's provenance (\`dataset\`, \`version\`, \`content_sha256\`, \`license\`, \`owner\`, \`size_bytes\`,
\`row_count\`, \`status\`) is answered with \`validator_report\` when the status is \`validated\`, and
\`download_url\` is the object's address in the object store. It serves the demo and hides four
flaws.

**Failure mode the checks target.** Any tenant reads any tenant's dataset; a download link works
forever for whoever holds it; a rejected version reads like one nobody checked; and \`latest\` hands a
training run a version that was never validated.

- A record of another tenant answers **404**, as an unknown version does.
- \`latest\` resolves through \`pointer.latest\` (step 2, provided); no promoted version is **404**.
- \`validator_report\` is in every answer (\`null\` when there is none).
- \`download_url\` is \`store.sign_url(tenant, content_sha256, expires_at)\` with \`expires_at\` = now +
  \`SIGNED_URL_TTL_S\` (300 s), and \`expires_at\` is in the answer; no unsigned object URL.`,
  sequence: {
    participants: ['Client', 'registryd', 'Redis pointer', 'registry store'],
    messages: [
      {
        from: 'Client',
        to: 'registryd',
        label: 'GET /v1/datasets/imdb-reviews/versions/latest · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'registryd', to: 'Redis pointer', label: 'latest(dataset) · none → 404', kind: 'sync'},
      {from: 'registryd', to: 'registry store', label: 'version(dataset, version)', kind: 'sync'},
      {from: 'registry store', to: 'registryd', label: 'record · other tenant → 404', kind: 'reply'},
      {from: 'registryd', to: 'registryd', label: 'sign_url(tenant, sha, now + 300)', kind: 'sync'},
      {
        from: 'registryd',
        to: 'Client',
        label: '200 provenance · validator_report · download_url · expires_at',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/datasets/{dataset}/versions/{version}',
      detail:
        'A tenant reading its own version gets **200** with the provenance: dataset, version, content hash, license, owner, size, rows and status.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/datasets\/\{dataset\}\/versions\/\{version\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/datasets\/:dataset\/versions\/:version['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/datasets\/\{dataset\}\/versions\/\{version\}"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"datasets"\s*\/\s*Segment\s*\/\s*"versions"\s*\/\s*Segment\s*\)/, /\bget\s*\{/],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/datasets\//]},
      },
    },
    {
      id: 'tenant-scoped',
      title: "Another tenant's version is 404",
      detail:
        "The record's tenant is compared with the caller's, and a foreign version answers **404** like an unknown one, so its existence is not confirmed either. The starter answers any tenant that asks.",
      match: {
        python: {all: [/record\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*record\[["']tenant["']\]/]},
        typescript: {all: [/record\.tenant\s*!==\s*tenant|tenant\s*!==\s*record\.tenant/]},
        go: {all: [/record\.Tenant\s*!=\s*tenant|tenant\s*!=\s*record\.Tenant/]},
        scala: {all: [/\.tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.tenant/]},
        cpp: {all: [/->tenant\s*!=\s*tenant|tenant\s*!=\s*\w+->tenant/]},
      },
    },
    {
      id: 'signed-url',
      title: 'The download URL is signed and expires in five minutes',
      detail:
        "`download_url` comes from `sign_url`/`signUrl`/`SignURL` over the caller's tenant, the hash and an `expires_at` 300 s ahead, which the answer carries. The starter hands out the object's permanent address.",
      match: {
        python: {all: [/SIGNED_URL_TTL_S\s*=\s*300\b/, /store\.sign_url\(/], none: [/OBJECT_BASE/]},
        typescript: {all: [/SIGNED_URL_TTL_S\s*=\s*300\b/, /signUrl\(/], none: [/OBJECT_BASE/]},
        go: {all: [/signedURLTTL\s*=\s*300\b/, /store\.SignURL\(/], none: [/ObjectBase/]},
        scala: {all: [/SignedUrlTtlSeconds\s*=\s*300L?\b/, /Store\.signUrl\(/], none: [/ObjectBase/]},
        cpp: {all: [/kSignedUrlTtlSeconds\s*=\s*300\b/, /store::signUrl\(/], none: [/kObjectBase/]},
      },
    },
    {
      id: 'validator-report',
      title: 'The validator report is in every answer',
      detail:
        '`validator_report` is answered whatever the status, `null` when the version has none, so a rejected version shows its failures. The starter includes it only for `validated`.',
      match: {
        python: {all: [/validator_report/], none: [/if record\[["']status["']\]\s*==\s*["']validated["']/]},
        typescript: {all: [/validator_report/], none: [/status\s*===\s*'validated'/]},
        go: {all: [/validator_report/], none: [/Status == "validated"/]},
        scala: {all: [/validator_report/], none: [/status == "validated"/]},
        cpp: {all: [/validator_report/], none: [/status == "validated"/]},
      },
    },
    {
      id: 'latest-pointer',
      title: '`latest` follows the promoted pointer',
      detail:
        '`latest` resolves through `pointer.latest`, and a dataset with no promoted version is **404**. The starter takes the newest registered name, which can be a version no validator passed.',
      match: {
        python: {all: [/pointer\.latest\(/], none: [/store\.versions\(/]},
        typescript: {all: [/\blatest\(\s*dataset\s*\)/], none: [/\bversions\(\s*dataset\s*\)/]},
        go: {all: [/pointer\.Latest\(/], none: [/store\.Versions\(/]},
        scala: {all: [/Pointer\.latest\(/], none: [/Store\.versions\(/]},
        cpp: {all: [/pointer::latest\(/], none: [/store::versions\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request

from registry import pointer, store  # store.version, versions, sign_url, OBJECT_BASE; pointer.latest

app = FastAPI()

PROVENANCE = ("dataset", "version", "content_sha256", "license", "owner", "size_bytes", "row_count", "status")


@app.get("/v1/datasets/{dataset}/versions/{version}")
def read_version(dataset: str, version: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    if version == "latest":
        names = store.versions(dataset)
        if not names:
            raise HTTPException(status_code=404, detail="no versions")
        version = names[-1]
    record = store.version(dataset, version)
    if record is None:
        raise HTTPException(status_code=404, detail="no such version")
    body = {name: record[name] for name in PROVENANCE}
    if record["status"] == "validated":
        body["validator_report"] = record["report"]
    body["download_url"] = f"{store.OBJECT_BASE}/{record['content_sha256']}"
    return body
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from registry import pointer, store  # store.version, versions, sign_url, OBJECT_BASE; pointer.latest

app = FastAPI()

PROVENANCE = ("dataset", "version", "content_sha256", "license", "owner", "size_bytes", "row_count", "status")
SIGNED_URL_TTL_S = 300


@app.get("/v1/datasets/{dataset}/versions/{version}")
def read_version(dataset: str, version: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    if version == "latest":
        try:
            version = pointer.latest(dataset)
        except pointer.LatestVersionMissing:
            raise HTTPException(status_code=404, detail="no promoted version")
    record = store.version(dataset, version)
    # Another tenant's version answers like a missing one: a 403 would confirm that it exists.
    if record is None or record["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such version")
    body = {name: record[name] for name in PROVENANCE}
    body["validator_report"] = record["report"]  # in every status: a rejected version shows why
    expires_at = int(time.time()) + SIGNED_URL_TTL_S
    body["download_url"] = store.sign_url(tenant, record["content_sha256"], expires_at)
    body["expires_at"] = expires_at
    return body
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {latest} from 'registry/pointer';
import {OBJECT_BASE, signUrl, version as versionOf, versions} from 'registry/store';

export const app = Fastify();

app.get('/v1/datasets/:dataset/versions/:version', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {dataset} = request.params as {dataset: string; version: string};
  let {version} = request.params as {dataset: string; version: string};
  if (version === 'latest') {
    const names = await versions(dataset);
    if (names.length === 0) return reply.code(404).send({error: 'no versions'});
    version = names[names.length - 1];
  }
  const record = await versionOf(dataset, version);
  if (record === null) return reply.code(404).send({error: 'no such version'});
  const {content_sha256, license, owner, size_bytes, row_count, status} = record;
  const body: Record<string, unknown> = {dataset, version, content_sha256, license, owner, size_bytes, row_count, status};
  if (status === 'validated') body.validator_report = record.report;
  body.download_url = \`\${OBJECT_BASE}/\${content_sha256}\`;
  return body;
});
`,
      solution: `import Fastify from 'fastify';

import {LatestVersionMissing, latest} from 'registry/pointer';
import {signUrl, version as versionOf} from 'registry/store';

export const app = Fastify();

export const SIGNED_URL_TTL_S = 300;

app.get('/v1/datasets/:dataset/versions/:version', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {dataset} = request.params as {dataset: string; version: string};
  let {version} = request.params as {dataset: string; version: string};
  if (version === 'latest') {
    try {
      version = await latest(dataset);
    } catch (e) {
      if (e instanceof LatestVersionMissing) return reply.code(404).send({error: 'no promoted version'});
      throw e;
    }
  }
  const record = await versionOf(dataset, version);
  // Another tenant's version answers like a missing one: a 403 would confirm that it exists.
  if (record === null || record.tenant !== tenant) return reply.code(404).send({error: 'no such version'});
  const {content_sha256, license, owner, size_bytes, row_count, status} = record;
  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
  return {
    dataset,
    version,
    content_sha256,
    license,
    owner,
    size_bytes,
    row_count,
    status,
    validator_report: record.report, // in every status: a rejected version shows why
    download_url: signUrl(tenant, content_sha256, expiresAt),
    expires_at: expiresAt,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"registry/store" // store.Version, Versions, SignURL, ObjectBase; registry/pointer: pointer.Latest
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	dataset, version := r.PathValue("dataset"), r.PathValue("version")
	if version == "latest" {
		names := store.Versions(r.Context(), dataset)
		if len(names) == 0 {
			writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no versions"})
			return
		}
		version = names[len(names)-1]
	}
	record := store.Version(r.Context(), dataset, version)
	if record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such version"})
		return
	}
	body := map[string]any{
		"dataset": record.Dataset, "version": record.Version, "content_sha256": record.ContentSHA256, "license": record.License,
		"owner": record.Owner, "size_bytes": record.SizeBytes, "row_count": record.RowCount, "status": record.Status,
	}
	if record.Status == "validated" {
		body["validator_report"] = record.Report
	}
	body["download_url"] = store.ObjectBase + "/" + record.ContentSHA256
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/datasets/{dataset}/versions/{version}", readVersion)
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"registry/pointer" // pointer.Latest, ErrLatestVersionMissing
	"registry/store"   // store.Version, Versions, SignURL, ObjectBase
)

const signedURLTTL = 300 // seconds

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	dataset, version := r.PathValue("dataset"), r.PathValue("version")
	if version == "latest" {
		promoted, err := pointer.Latest(r.Context(), dataset)
		if errors.Is(err, pointer.ErrLatestVersionMissing) {
			writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no promoted version"})
			return
		}
		if err != nil {
			writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		version = promoted
	}
	record := store.Version(r.Context(), dataset, version)
	// Another tenant's version answers like a missing one: a 403 would confirm that it exists.
	if record == nil || record.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such version"})
		return
	}
	expiresAt := time.Now().Unix() + signedURLTTL
	writeJSON(rw, http.StatusOK, map[string]any{
		"dataset": record.Dataset, "version": record.Version, "content_sha256": record.ContentSHA256, "license": record.License,
		"owner": record.Owner, "size_bytes": record.SizeBytes, "row_count": record.RowCount, "status": record.Status,
		"validator_report": record.Report, // in every status: a rejected version shows why
		"download_url":     store.SignURL(tenant, record.ContentSHA256, expiresAt),
		"expires_at":       expiresAt,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/datasets/{dataset}/versions/{version}", readVersion)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import registry.{Pointer, Store} // Store.version, versions, signUrl, ObjectBase; Pointer.latest

object ReadApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def provenance(rec: Store.VersionRecord): Map[String, JsValue] = Map(
    "dataset" -> JsString(rec.dataset), "version" -> JsString(rec.version), "content_sha256" -> JsString(rec.contentSha256),
    "license" -> JsString(rec.license), "owner" -> JsString(rec.owner), "size_bytes" -> JsNumber(rec.sizeBytes),
    "row_count" -> JsNumber(rec.rowCount), "status" -> JsString(rec.status))

  val route: Route = path("v1" / "datasets" / Segment / "versions" / Segment) { (dataset, requested) =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val version = if (requested == "latest") Store.versions(dataset).lastOption.getOrElse("") else requested
          Store.version(dataset, version) match {
            case None => complete(error(StatusCodes.NotFound, "no such version"))
            case Some(rec) =>
              val report = if (rec.status == "validated") Map("validator_report" -> rec.report.getOrElse(JsNull)) else Map.empty[String, JsValue]
              val url = Map("download_url" -> JsString(s"\${Store.ObjectBase}/\${rec.contentSha256}"))
              complete(json(StatusCodes.OK, JsObject(provenance(rec) ++ report ++ url)))
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

import registry.{LatestVersionMissing, Pointer, Store} // Store.version, versions, signUrl; Pointer.latest

object ReadApi {
  val SignedUrlTtlSeconds = 300L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def provenance(rec: Store.VersionRecord): Map[String, JsValue] = Map(
    "dataset" -> JsString(rec.dataset), "version" -> JsString(rec.version), "content_sha256" -> JsString(rec.contentSha256),
    "license" -> JsString(rec.license), "owner" -> JsString(rec.owner), "size_bytes" -> JsNumber(rec.sizeBytes),
    "row_count" -> JsNumber(rec.rowCount), "status" -> JsString(rec.status))

  val route: Route = path("v1" / "datasets" / Segment / "versions" / Segment) { (dataset, requested) =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          val version =
            if (requested != "latest") Some(requested)
            else try Some(Pointer.latest(dataset)) catch { case _: LatestVersionMissing => None }
          // Another tenant's version answers like a missing one: a 403 would confirm that it exists.
          version.flatMap(Store.version(dataset, _)).filterNot(rec => rec.tenant != tenant) match {
            case None => complete(error(StatusCodes.NotFound, "no such version"))
            case Some(rec) =>
              val expiresAt = System.currentTimeMillis() / 1000 + SignedUrlTtlSeconds
              val signed = Map(
                "validator_report" -> rec.report.getOrElse(JsNull), // in every status: a rejected version shows why
                "download_url" -> JsString(Store.signUrl(tenant, rec.contentSha256, expiresAt)),
                "expires_at" -> JsNumber(expiresAt))
              complete(json(StatusCodes.OK, JsObject(provenance(rec) ++ signed)))
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

#include "registry/pointer.h"  // pointer::latest
#include "registry/store.h"    // store::version, versions, signUrl, kObjectBase

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_version(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string dataset = req.matches[1];
  std::string version = req.matches[2];
  if (version == "latest") {
    const auto names = store::versions(dataset);
    if (names.empty()) return reply(res, 404, {{"error", "no versions"}});
    version = names.back();
  }
  const auto record = store::version(dataset, version);
  if (!record) return reply(res, 404, {{"error", "no such version"}});
  json body = {{"dataset", record->dataset},   {"version", record->version},       {"content_sha256", record->content_sha256},
               {"license", record->license},   {"owner", record->owner},           {"size_bytes", record->size_bytes},
               {"row_count", record->row_count}, {"status", record->status}};
  if (record->status == "validated") body["validator_report"] = record->report ? *record->report : json(nullptr);
  body["download_url"] = store::kObjectBase + "/" + record->content_sha256;
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/datasets/([\\w.-]+)/versions/([\\w.-]+))", read_version); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "registry/pointer.h"  // pointer::latest
#include "registry/store.h"    // store::version, versions, signUrl, kObjectBase

using json = nlohmann::json;

constexpr long long kSignedUrlTtlSeconds = 300;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_version(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string dataset = req.matches[1];
  std::string version = req.matches[2];
  if (version == "latest") {
    try {
      version = pointer::latest(dataset);
    } catch (const pointer::LatestVersionMissing&) {
      return reply(res, 404, {{"error", "no promoted version"}});
    }
  }
  const auto record = store::version(dataset, version);
  // Another tenant's version answers like a missing one: a 403 would confirm that it exists.
  if (!record || record->tenant != tenant) return reply(res, 404, {{"error", "no such version"}});
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long expires_at = now + kSignedUrlTtlSeconds;
  json body = {{"dataset", record->dataset},   {"version", record->version},       {"content_sha256", record->content_sha256},
               {"license", record->license},   {"owner", record->owner},           {"size_bytes", record->size_bytes},
               {"row_count", record->row_count}, {"status", record->status}};
  body["validator_report"] = record->report ? *record->report : json(nullptr);  // in every status: a rejected version shows why
  body["download_url"] = store::signUrl(tenant, record->content_sha256, expires_at);
  body["expires_at"] = expires_at;
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/datasets/([\\w.-]+)/versions/([\\w.-]+))", read_version); }
`,
    },
  },
  harness: {
    python: `from registry import pointer, store

DS = "imdb-reviews"
T1 = {"X-Tenant-Id": "t1"}
PASSED = {"passed": True, "rows_scanned": 3, "rows_total": 3, "failures": []}
FAILED = {"passed": False, "rows_scanned": 3, "rows_total": 3, "failures": ["row 2: label missing"]}


def _seed(dataset, version, tenant, status, report):
    sha = store.put_object(f"1,{dataset} {version},pos\\n2,{dataset} {version},neg\\n3,{dataset} {version},pos\\n")
    store.put_version({"tenant": tenant, "dataset": dataset, "version": version, "content_sha256": sha, "license": "mit", "owner": "team-lm", "size_bytes": 60, "row_count": 3, "status": status, "report": report})
    return sha


def _read(ctx):
    _seed(DS, "2026-01", "t1", "validated", PASSED)
    _seed(DS, "2026-02", "t1", "rejected", FAILED)
    _seed(DS, "2026-03", "t1", "pending", None)
    _seed("private-logs", "2026-01", "t2", "validated", PASSED)
    pointer.promote(DS, "2026-01", "alice")
    return ctx.client(ctx.load("read").app)


async def check_route(ctx):
    async with _read(ctx) as c:
        r = await c.get(f"/v1/datasets/{DS}/versions/2026-01", headers=T1)
    assert r.status_code == 200, f"GET /v1/datasets/{DS}/versions/2026-01 answered {r.status_code}: {r.text}"
    body = r.json()
    record = store.version(DS, "2026-01")
    for name in ("dataset", "version", "content_sha256", "license", "owner", "size_bytes", "row_count", "status"):
        assert body.get(name) == record[name], f"the answer's {name} is {body.get(name)!r}, the record holds {record[name]!r}"


async def check_tenant_scoped(ctx):
    async with _read(ctx) as c:
        foreign = await c.get("/v1/datasets/private-logs/versions/2026-01", headers=T1)
        unknown = await c.get(f"/v1/datasets/{DS}/versions/2030-01", headers=T1)
        own = await c.get("/v1/datasets/private-logs/versions/2026-01", headers={"X-Tenant-Id": "t2"})
    sha = store.version("private-logs", "2026-01")["content_sha256"]
    assert foreign.status_code == 404, f"tenant t1 reading t2's private-logs@2026-01 got {foreign.status_code}: another tenant's version must answer 404"
    assert sha not in foreign.text, "the answer to another tenant carries the content hash"
    assert unknown.status_code == 404, f"an unknown version answered {unknown.status_code}, expected 404"
    assert own.status_code == 200, f"t2 reading its own version answered {own.status_code}: {own.text}"


async def check_signed_url(ctx):
    async with _read(ctx) as c:
        now = int(ctx.clock.time())
        r = await c.get(f"/v1/datasets/{DS}/versions/2026-01", headers=T1)
    assert r.status_code == 200, f"the read answered {r.status_code}: {r.text}"
    body = r.json()
    sha = store.version(DS, "2026-01")["content_sha256"]
    expires_at = body.get("expires_at")
    assert isinstance(expires_at, int) and now + 290 <= expires_at <= now + 301, f"expires_at is {expires_at!r}, expected about 300 s from now ({now + 300}): a link without an expiry works for whoever holds it, for ever"
    assert body.get("download_url") == store.sign_url("t1", sha, expires_at), f"download_url is {body.get('download_url')!r}: it must be store.sign_url for the caller's tenant, the hash and expires_at"
    unsigned = f"{store.OBJECT_BASE}/{sha}"
    assert not any(value == unsigned for value in body.values()), f"the answer carries the unsigned object URL {unsigned}"


async def check_validator_report(ctx):
    async with _read(ctx) as c:
        rejected = await c.get(f"/v1/datasets/{DS}/versions/2026-02", headers=T1)
        pending = await c.get(f"/v1/datasets/{DS}/versions/2026-03", headers=T1)
    assert rejected.status_code == 200, f"reading the rejected 2026-02 answered {rejected.status_code}: {rejected.text}"
    body = rejected.json()
    assert body.get("status") == "rejected" and body.get("validator_report") == FAILED, f"the rejected version answered status {body.get('status')!r} with validator_report {body.get('validator_report')!r}: its failures must be in the answer"
    body = pending.json()
    assert "validator_report" in body and body["validator_report"] is None, f"a pending version must answer validator_report null, got {body}"


async def check_latest_pointer(ctx):
    async with _read(ctx) as c:
        r = await c.get(f"/v1/datasets/{DS}/versions/latest", headers=T1)
        none = await c.get("/v1/datasets/wiki-text/versions/latest", headers=T1)
    assert r.status_code == 200, f"GET …/versions/latest answered {r.status_code}: {r.text}"
    assert r.json().get("version") == "2026-01", f"latest resolved to {r.json().get('version')!r}, the promoted version is 2026-01: a training run asking for latest gets a version nobody validated"
    assert none.status_code == 404, f"latest of a dataset with no promoted version answered {none.status_code}, expected 404"
`,
    typescript: `const DS = 'imdb-reviews';
const T1 = {'X-Tenant-Id': 't1'};
const PASSED = {passed: true, rows_scanned: 3, rows_total: 3, failures: []};
const FAILED = {passed: false, rows_scanned: 3, rows_total: 3, failures: ['row 2: label missing']};

async function read(ctx) {
  const store = ctx.load('/support/registry/store.ts');
  const pointer = ctx.load('/support/registry/pointer.ts');
  const seed = async (dataset: string, version: string, tenant: string, status: string, report) => {
    const sha = await store.putObject(\`1,\${dataset} \${version},pos\\n2,\${dataset} \${version},neg\\n3,\${dataset} \${version},pos\\n\`);
    await store.putVersion({tenant, dataset, version, content_sha256: sha, license: 'mit', owner: 'team-lm', size_bytes: 60, row_count: 3, status, report});
  };
  await seed(DS, '2026-01', 't1', 'validated', PASSED);
  await seed(DS, '2026-02', 't1', 'rejected', FAILED);
  await seed(DS, '2026-03', 't1', 'pending', null);
  await seed('private-logs', '2026-01', 't2', 'validated', PASSED);
  await pointer.promote(DS, '2026-01', 'alice');
  return {c: ctx.client(ctx.load('read').app), store};
}

export async function check_route(ctx) {
  const {c, store} = await read(ctx);
  const r = await c.get(\`/v1/datasets/\${DS}/versions/2026-01\`, {headers: T1});
  assert.equal(r.status, 200, \`GET /v1/datasets/\${DS}/versions/2026-01 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const record = await store.version(DS, '2026-01');
  for (const name of ['dataset', 'version', 'content_sha256', 'license', 'owner', 'size_bytes', 'row_count', 'status']) {
    assert.equal(body[name], record[name], \`the answer's \${name}\`);
  }
}

export async function check_tenant_scoped(ctx) {
  const {c, store} = await read(ctx);
  const foreign = await c.get('/v1/datasets/private-logs/versions/2026-01', {headers: T1});
  const unknown = await c.get(\`/v1/datasets/\${DS}/versions/2030-01\`, {headers: T1});
  const own = await c.get('/v1/datasets/private-logs/versions/2026-01', {headers: {'X-Tenant-Id': 't2'}});
  const {content_sha256} = await store.version('private-logs', '2026-01');
  assert.equal(foreign.status, 404, \`tenant t1 reading t2's private-logs@2026-01 got \${foreign.status}: another tenant's version must answer 404\`);
  assert(!foreign.text.includes(content_sha256), 'the answer to another tenant carries the content hash');
  assert.equal(unknown.status, 404, \`an unknown version answered \${unknown.status}, expected 404\`);
  assert.equal(own.status, 200, \`t2 reading its own version answered \${own.status}: \${own.text}\`);
}

export async function check_signed_url(ctx) {
  const {c, store} = await read(ctx);
  const now = Math.floor(ctx.clock.now() / 1000);
  const r = await c.get(\`/v1/datasets/\${DS}/versions/2026-01\`, {headers: T1});
  assert.equal(r.status, 200, \`the read answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const {content_sha256} = await store.version(DS, '2026-01');
  const expiresAt = body.expires_at;
  assert(Number.isInteger(expiresAt) && now + 290 <= expiresAt && expiresAt <= now + 301, \`expires_at is \${JSON.stringify(expiresAt)}, expected about 300 s from now (\${now + 300}): a link without an expiry works for whoever holds it, for ever\`);
  assert.equal(body.download_url, store.signUrl('t1', content_sha256, expiresAt), 'download_url must be signUrl for the caller\\'s tenant, the hash and expires_at');
  const unsigned = \`\${store.OBJECT_BASE}/\${content_sha256}\`;
  assert(!Object.values(body).includes(unsigned), \`the answer carries the unsigned object URL \${unsigned}\`);
}

export async function check_validator_report(ctx) {
  const {c} = await read(ctx);
  const rejected = await c.get(\`/v1/datasets/\${DS}/versions/2026-02\`, {headers: T1});
  const pending = await c.get(\`/v1/datasets/\${DS}/versions/2026-03\`, {headers: T1});
  assert.equal(rejected.status, 200, \`reading the rejected 2026-02 answered \${rejected.status}: \${rejected.text}\`);
  const body = rejected.json();
  assert(body.status === 'rejected' && JSON.stringify(body.validator_report) === JSON.stringify(FAILED), \`the rejected version answered status \${body.status} with validator_report \${JSON.stringify(body.validator_report)}: its failures must be in the answer\`);
  const p = pending.json();
  assert('validator_report' in p && p.validator_report === null, \`a pending version must answer validator_report null, got \${pending.text}\`);
}

export async function check_latest_pointer(ctx) {
  const {c} = await read(ctx);
  const r = await c.get(\`/v1/datasets/\${DS}/versions/latest\`, {headers: T1});
  const none = await c.get('/v1/datasets/wiki-text/versions/latest', {headers: T1});
  assert.equal(r.status, 200, \`GET …/versions/latest answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().version, '2026-01', \`latest resolved to \${r.json().version}, the promoted version is 2026-01: a training run asking for latest gets a version nobody validated\`);
  assert.equal(none.status, 404, \`latest of a dataset with no promoted version answered \${none.status}, expected 404\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"registry/pointer"
	"registry/store"

	"leetbuild/harness"
)

const readDS = "imdb-reviews"

var readBg = context.Background()

func readSeed(ctx *harness.Ctx, dataset, version, tenant, status string, report *store.Report) {
	sha := store.PutObject(readBg, fmt.Sprintf("1,%[1]s %[2]s,pos\\n2,%[1]s %[2]s,neg\\n3,%[1]s %[2]s,pos\\n", dataset, version))
	err := store.PutVersion(readBg, &store.VersionRecord{Tenant: tenant, Dataset: dataset, Version: version, ContentSHA256: sha, License: "mit", Owner: "team-lm", SizeBytes: 60, RowCount: 3, Status: status, Report: report})
	ctx.NoError(err, "seeding %s@%s", dataset, version)
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	readSeed(ctx, readDS, "2026-01", "t1", "validated", &store.Report{Passed: true, RowsScanned: 3, RowsTotal: 3, Failures: []string{}})
	readSeed(ctx, readDS, "2026-02", "t1", "rejected", &store.Report{Passed: false, RowsScanned: 3, RowsTotal: 3, Failures: []string{"row 2: label missing"}})
	readSeed(ctx, readDS, "2026-03", "t1", "pending", nil)
	readSeed(ctx, "private-logs", "2026-01", "t2", "validated", &store.Report{Passed: true, RowsScanned: 3, RowsTotal: 3, Failures: []string{}})
	_, err := pointer.Promote(readBg, readDS, "2026-01", "alice")
	ctx.NoError(err, "promoting 2026-01")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	var body map[string]any
	r.Decode(&body)
	ctx.Assert(body != nil, "the answer is not a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := c.Get("/v1/datasets/"+readDS+"/versions/2026-01", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/datasets/%s/versions/2026-01 (%s)", readDS, r.Text())
	body := readBody(ctx, r)
	rec := store.Version(readBg, readDS, "2026-01")
	ctx.Equal(body["content_sha256"], rec.ContentSHA256, "the answer's content_sha256")
	ctx.Equal(body["version"], "2026-01", "the answer's version")
	ctx.Equal(body["owner"], "team-lm", "the answer's owner")
	ctx.Equal(body["license"], "mit", "the answer's license")
	ctx.Equal(body["row_count"], 3, "the answer's row_count")
	ctx.Equal(body["status"], "validated", "the answer's status")
}

func CheckTenantScoped(ctx *harness.Ctx) {
	c := readAPI(ctx)
	foreign := c.Get("/v1/datasets/private-logs/versions/2026-01", "X-Tenant-Id", "t1")
	unknown := c.Get("/v1/datasets/"+readDS+"/versions/2030-01", "X-Tenant-Id", "t1")
	own := c.Get("/v1/datasets/private-logs/versions/2026-01", "X-Tenant-Id", "t2")
	sha := store.Version(readBg, "private-logs", "2026-01").ContentSHA256
	ctx.Equal(foreign.Status, 404, "tenant t1 reading t2's private-logs@2026-01: another tenant's version must answer 404")
	ctx.Assert(!strings.Contains(foreign.Text(), sha), "the answer to another tenant carries the content hash")
	ctx.Equal(unknown.Status, 404, "an unknown version")
	ctx.Equal(own.Status, 200, "t2 reading its own version (%s)", own.Text())
}

func CheckSignedUrl(ctx *harness.Ctx) {
	c := readAPI(ctx)
	now := ctx.Clock.Now() / 1000
	r := c.Get("/v1/datasets/"+readDS+"/versions/2026-01", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "the read (%s)", r.Text())
	body := readBody(ctx, r)
	sha := store.Version(readBg, readDS, "2026-01").ContentSHA256
	raw, _ := body["expires_at"].(float64)
	expiresAt := int64(raw)
	ctx.Assert(now+290 <= expiresAt && expiresAt <= now+301, "expires_at is %v, expected about 300 s from now (%d): a link without an expiry works for whoever holds it, for ever", body["expires_at"], now+300)
	ctx.Equal(body["download_url"], store.SignURL("t1", sha, expiresAt), "download_url must be store.SignURL for the caller's tenant, the hash and expires_at")
	unsigned := store.ObjectBase + "/" + sha
	for name, value := range body {
		ctx.Assert(value != unsigned, "the answer carries the unsigned object URL %s in %s", unsigned, name)
	}
}

func CheckValidatorReport(ctx *harness.Ctx) {
	c := readAPI(ctx)
	rejected := c.Get("/v1/datasets/"+readDS+"/versions/2026-02", "X-Tenant-Id", "t1")
	pending := c.Get("/v1/datasets/"+readDS+"/versions/2026-03", "X-Tenant-Id", "t1")
	ctx.Equal(rejected.Status, 200, "reading the rejected 2026-02 (%s)", rejected.Text())
	body := readBody(ctx, rejected)
	report, _ := body["validator_report"].(map[string]any)
	ctx.Assert(body["status"] == "rejected" && report != nil && report["passed"] == false, "the rejected version answered %s: its failures must be in the answer", rejected.Text())
	ctx.Equal(report["failures"], []any{"row 2: label missing"}, "the rejected version's failures")
	p := readBody(ctx, pending)
	value, present := p["validator_report"]
	ctx.Assert(present && value == nil, "a pending version must answer validator_report null, got %s", pending.Text())
}

func CheckLatestPointer(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := c.Get("/v1/datasets/"+readDS+"/versions/latest", "X-Tenant-Id", "t1")
	none := c.Get("/v1/datasets/wiki-text/versions/latest", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "GET …/versions/latest (%s)", r.Text())
	ctx.Equal(readBody(ctx, r)["version"], "2026-01", "latest must resolve to the promoted 2026-01 (anything else hands a training run a version nobody validated); it resolved to")
	ctx.Equal(none.Status, 404, "latest of a dataset with no promoted version")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "registry/pointer.h"
#include "registry/store.h"

using json = nlohmann::json;

namespace {

const std::string kDS = "imdb-reviews";
const json kPassed = {{"passed", true}, {"rows_scanned", 3}, {"rows_total", 3}, {"failures", json::array()}};
const json kFailed = {{"passed", false}, {"rows_scanned", 3}, {"rows_total", 3}, {"failures", {"row 2: label missing"}}};

void seed(const std::string& dataset, const std::string& version, const std::string& tenant, const std::string& status,
          const std::optional<json>& report) {
  store::VersionRecord rec;
  rec.tenant = tenant;
  rec.dataset = dataset;
  rec.version = version;
  rec.content_sha256 = store::putObject("1," + dataset + " " + version + ",pos\\n2," + dataset + " " + version + ",neg\\n3," + dataset + " " + version + ",pos\\n");
  rec.license = "mit";
  rec.owner = "team-lm";
  rec.size_bytes = 60;
  rec.row_count = 3;
  rec.status = status;
  rec.report = report;
  store::putVersion(rec);
}

harness::HTTP api(harness::Ctx& ctx) {
  seed(kDS, "2026-01", "t1", "validated", kPassed);
  seed(kDS, "2026-02", "t1", "rejected", kFailed);
  seed(kDS, "2026-03", "t1", "pending", std::nullopt);
  seed("private-logs", "2026-01", "t2", "validated", kPassed);
  pointer::promote(kDS, "2026-01", "alice");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the answer is not a JSON object: %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = c.Get("/v1/datasets/" + kDS + "/versions/2026-01", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/datasets/%s/versions/2026-01 (%s)", kDS, r.Text());
  const json body = bodyOf(ctx, r);
  const auto rec = store::version(kDS, "2026-01");
  ctx.Equal(body.value("content_sha256", ""), rec->content_sha256, "the answer's content_sha256");
  ctx.Equal(body.value("version", ""), "2026-01", "the answer's version");
  ctx.Equal(body.value("owner", ""), "team-lm", "the answer's owner");
  ctx.Equal(body.value("license", ""), "mit", "the answer's license");
  ctx.Equal(body.value("row_count", 0LL), 3LL, "the answer's row_count");
  ctx.Equal(body.value("status", ""), "validated", "the answer's status");
}

void CheckTenantScoped(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto foreign = c.Get("/v1/datasets/private-logs/versions/2026-01", "X-Tenant-Id", "t1");
  const auto unknown = c.Get("/v1/datasets/" + kDS + "/versions/2030-01", "X-Tenant-Id", "t1");
  const auto own = c.Get("/v1/datasets/private-logs/versions/2026-01", "X-Tenant-Id", "t2");
  const std::string sha = store::version("private-logs", "2026-01")->content_sha256;
  ctx.Equal(foreign.Status, 404, "tenant t1 reading t2's private-logs@2026-01: another tenant's version must answer 404");
  ctx.Assert(foreign.Text().find(sha) == std::string::npos, "the answer to another tenant carries the content hash");
  ctx.Equal(unknown.Status, 404, "an unknown version");
  ctx.Equal(own.Status, 200, "t2 reading its own version (%s)", own.Text());
}

void CheckSignedUrl(harness::Ctx& ctx) {
  auto c = api(ctx);
  const long long now = ctx.Clock.Now() / 1000;
  const auto r = c.Get("/v1/datasets/" + kDS + "/versions/2026-01", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "the read (%s)", r.Text());
  const json body = bodyOf(ctx, r);
  const std::string sha = store::version(kDS, "2026-01")->content_sha256;
  const long long expires_at = body.contains("expires_at") && body["expires_at"].is_number() ? body["expires_at"].get<long long>() : 0;
  ctx.Assert(now + 290 <= expires_at && expires_at <= now + 301,
             "expires_at is %d, expected about 300 s from now (%d): a link without an expiry works for whoever holds it, for ever", expires_at, now + 300);
  ctx.Equal(body.value("download_url", ""), store::signUrl("t1", sha, expires_at), "download_url must be store::signUrl for the caller's tenant, the hash and expires_at");
  const std::string unsigned_url = store::kObjectBase + "/" + sha;
  for (const auto& [name, value] : body.items()) {
    ctx.Assert(!(value.is_string() && value.get<std::string>() == unsigned_url), "the answer carries the unsigned object URL %s in %s", unsigned_url, name);
  }
}

void CheckValidatorReport(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto rejected = c.Get("/v1/datasets/" + kDS + "/versions/2026-02", "X-Tenant-Id", "t1");
  const auto pending = c.Get("/v1/datasets/" + kDS + "/versions/2026-03", "X-Tenant-Id", "t1");
  ctx.Equal(rejected.Status, 200, "reading the rejected 2026-02 (%s)", rejected.Text());
  const json body = bodyOf(ctx, rejected);
  ctx.Assert(body.value("status", "") == "rejected" && body.contains("validator_report") && body["validator_report"] == kFailed,
             "the rejected version answered %s: its failures must be in the answer", rejected.Text());
  const json p = bodyOf(ctx, pending);
  ctx.Assert(p.contains("validator_report") && p["validator_report"].is_null(), "a pending version must answer validator_report null, got %s", pending.Text());
}

void CheckLatestPointer(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = c.Get("/v1/datasets/" + kDS + "/versions/latest", "X-Tenant-Id", "t1");
  const auto none = c.Get("/v1/datasets/wiki-text/versions/latest", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "GET …/versions/latest (%s)", r.Text());
  ctx.Equal(bodyOf(ctx, r).value("version", ""), "2026-01", "latest must resolve to the promoted 2026-01 (anything else hands a training run a version nobody validated); it resolved to");
  ctx.Equal(none.Status, 404, "latest of a dataset with no promoted version");
}
`,
  },
  hints: [
    "Read another tenant's dataset with your own header: it answers 200. Ask for `latest` right after registering a new version: you get the new one, which no validator has seen.",
    "Nothing compares the record's tenant with the caller's; `latest` takes the last name in `store.versions`; the report is added only for `validated`; and the URL is the object's fixed address, valid as long as the object exists.",
    'Answer 404 when `record["tenant"] != tenant`; resolve `latest` with `pointer.latest` (404 on `LatestVersionMissing`); always set `validator_report`; sign with `store.sign_url(tenant, sha, int(time.time()) + SIGNED_URL_TTL_S)` and answer `expires_at`.',
  ],
  debrief: `The read is where a registry's promises become visible: \`latest\` means the promoted pointer, not the newest upload, so a run that asks for it gets the bytes a validator passed. Answering a foreign version with 404 rather than 403 keeps one tenant from mapping another's datasets by probing names. The report rides along in every status because "rejected" without its failures is a dead end for the owner. The signed URL binds the download to a tenant and five minutes, so a link pasted into a ticket stops working instead of becoming a public mirror. A production registry also logs every signed URL it hands out, scopes reads by role inside a tenant, and serves lineage (which runs read this version) next to the provenance.`,
};
