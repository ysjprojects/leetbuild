import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/reports: a report that must be real and unique',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/reports\` with body
\`{"content_id", "reason", "detail"}\`: it reads the tenant from \`X-Tenant-Id\` and the reporter from
\`X-Reporter-Id\` (either missing is **401**), answers **404** for content the catalogue does not know
(\`store.content_tenant\`), and opens a case with \`store.insert_case\`, answering **201**
\`{case_id, status: "created"}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A tenant opens a case against another tenant's content; a typo
in the reason becomes a case filed under \`other\`; a detail of 3,000 accented characters slips past
the 4 KiB cap; and a reporter who reports the same post twice opens two cases.

- The content must belong to the calling tenant: a foreign id answers exactly as an unknown one,
  **404**.
- \`reason\` is one of \`ALLOWED_REASONS\` (\`spam\`, \`harassment\`, \`hate\`, \`self_harm\`, \`csam\`);
  anything else is **400**.
- \`detail\` (default \`""\`) is at most \`MAX_DETAIL_BYTES\` = **4096 bytes** of UTF-8; more is **413**.
- A repeat report from the same reporter on the same content updates that case
  (\`store.find_case\`, \`store.update_case\`) and answers **200** \`{case_id, status: "updated"}\`.`,
  sequence: {
    participants: ['Reporter', 'Moderation API', 'case store'],
    messages: [
      {from: 'Reporter', to: 'Moderation API', label: 'POST /v1/reports · X-Tenant-Id · X-Reporter-Id', kind: 'sync'},
      {from: 'Moderation API', to: 'case store', label: 'content_tenant(content_id) == tenant?', kind: 'sync'},
      {from: 'Moderation API', to: 'Moderation API', label: 'ALLOWED_REASONS · detail ≤ 4096 bytes', kind: 'sync'},
      {from: 'Moderation API', to: 'case store', label: 'find_case(tenant, content_id, reporter_id)', kind: 'sync'},
      {from: 'Moderation API', to: 'case store', label: 'update_case(case_id) or insert_case(…)', kind: 'sync'},
      {from: 'Moderation API', to: 'Reporter', label: '201 created · 200 updated', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/reports',
      detail:
        'A well-formed report from the content owner opens a case (**201**, `status: "created"`); a missing tenant or reporter header is **401**.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/reports["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/reports['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/reports"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"reports"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/reports"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Confines a report to content the tenant owns',
      detail:
        'The owner from `content_tenant`/`contentTenant` is compared with the caller’s tenant, and a foreign id answers exactly as an unknown one (**404**). The starter only asks whether the content exists.',
      match: {
        python: {all: [/content_tenant\(/, /[!=]=\s*tenant\b/]},
        typescript: {all: [/contentTenant\(/, /[!=]==?\s*tenant\b/]},
        go: {all: [/store\.ContentTenant\(/, /[!=]=\s*tenant\b/]},
        scala: {all: [/Store\.contentTenant\(/, /contains\(tenant\)|[!=]=\s*(Some\()?tenant\b/]},
        cpp: {all: [/store::contentTenant\(/, /[!=]=\s*tenant\b/]},
      },
    },
    {
      id: 'reason-allowlist',
      title: 'Rejects a reason outside the allowlist',
      detail: 'A reason outside `ALLOWED_REASONS` is **400** and opens nothing; the starter files it under `other`.',
      match: {
        python: {all: [/ALLOWED_REASONS/, /status_code\s*=\s*400/], none: [/["']other["']/]},
        typescript: {all: [/ALLOWED_REASONS/, /code\(\s*400\s*\)/], none: [/['"]other['"]/]},
        go: {all: [/allowedReasons/, /StatusBadRequest|\b400\b/], none: [/"other"/]},
        scala: {all: [/AllowedReasons/, /BadRequest/], none: [/"other"/]},
        cpp: {all: [/kAllowedReasons/, /\b400\b/], none: [/"other"/]},
      },
    },
    {
      id: 'detail-bytes',
      title: 'Caps the detail at 4096 bytes of UTF-8',
      detail:
        'The detail is measured in UTF-8 bytes against `MAX_DETAIL_BYTES` and a larger one is **413**; the starter counts characters, so accented or emoji text passes at twice to four times the cap.',
      match: {
        python: {all: [/MAX_DETAIL_BYTES/, /len\([^)\n]*\.encode\(/], none: [/len\(body\.detail\)\s*>/]},
        typescript: {
          all: [/MAX_DETAIL_BYTES/, /Buffer\.byteLength\(|TextEncoder\(\)\.encode\(/],
          none: [/detail\.length\s*>/],
        },
        go: {all: [/len\(body\.Detail\)\s*>\s*maxDetailBytes/], none: [/RuneCountInString/]},
        scala: {all: [/MaxDetailBytes/, /getBytes\(/], none: [/detail\.length\s*>/]},
        cpp: {all: [/detail\.(size|length)\(\)\s*>\s*kMaxDetailBytes/], none: [/characters\(/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Updates the reporter’s existing case instead of opening a second',
      detail:
        'The reporter’s case on the content is looked up first (`find_case`/`findCase`); a hit is updated (`update_case`/`updateCase`) and answers **200** `status: "updated"`, a miss inserts. The starter always inserts.',
      match: {
        python: {
          all: [/store\.find_case\(/, /store\.update_case\(/, /["']updated["']/],
          order: [/store\.find_case\(/, /store\.insert_case\(/],
        },
        typescript: {
          all: [/findCase\(/, /updateCase\(/, /['"]updated['"]/],
          order: [/await findCase\(/, /await insertCase\(/],
        },
        go: {
          all: [/store\.FindCase\(/, /store\.UpdateCase\(/, /"updated"/],
          order: [/store\.FindCase\(/, /store\.InsertCase\(/],
        },
        scala: {
          all: [/Store\.findCase\(/, /Store\.updateCase\(/, /"updated"/],
          order: [/Store\.findCase\(/, /Store\.insertCase\(/],
        },
        cpp: {
          all: [/store::findCase\(/, /store::updateCase\(/, /"updated"/],
          order: [/store::findCase\(/, /store::insertCase\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from moderation import store  # content_tenant, find_case, insert_case, update_case

app = FastAPI()

ALLOWED_REASONS = ("spam", "harassment", "hate", "self_harm", "csam")
MAX_DETAIL_BYTES = 4096


class ReportRequest(BaseModel):
    content_id: str
    reason: str
    detail: str = ""


@app.post("/v1/reports")
def create_report(body: ReportRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    reporter_id = request.headers.get("x-reporter-id", "")
    if not tenant or not reporter_id:
        raise HTTPException(status_code=401, detail="X-Tenant-Id and X-Reporter-Id are required")
    if store.content_tenant(body.content_id) is None:
        raise HTTPException(status_code=404, detail="no such content")
    reason = body.reason if body.reason in ALLOWED_REASONS else "other"
    if len(body.detail) > MAX_DETAIL_BYTES:
        raise HTTPException(status_code=413, detail="detail is too long")
    case = store.insert_case(tenant, body.content_id, reporter_id, reason, body.detail)
    return JSONResponse({"case_id": case["case_id"], "status": "created"}, status_code=201)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from moderation import store  # content_tenant, find_case, insert_case, update_case

app = FastAPI()

ALLOWED_REASONS = ("spam", "harassment", "hate", "self_harm", "csam")
MAX_DETAIL_BYTES = 4096


class ReportRequest(BaseModel):
    content_id: str
    reason: str
    detail: str = ""


@app.post("/v1/reports")
def create_report(body: ReportRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    reporter_id = request.headers.get("x-reporter-id", "")
    if not tenant or not reporter_id:
        raise HTTPException(status_code=401, detail="X-Tenant-Id and X-Reporter-Id are required")
    # A foreign id answers exactly as an unknown one: nothing confirms what another tenant hosts.
    if store.content_tenant(body.content_id) != tenant:
        raise HTTPException(status_code=404, detail="no such content")
    if body.reason not in ALLOWED_REASONS:
        raise HTTPException(status_code=400, detail=f"reason must be one of {', '.join(ALLOWED_REASONS)}")
    if len(body.detail.encode("utf-8")) > MAX_DETAIL_BYTES:
        raise HTTPException(status_code=413, detail=f"detail is over {MAX_DETAIL_BYTES} bytes")
    existing = store.find_case(tenant, body.content_id, reporter_id)
    if existing is not None:
        case = store.update_case(existing["case_id"], body.reason, body.detail)
        return JSONResponse({"case_id": case["case_id"], "status": "updated"}, status_code=200)
    case = store.insert_case(tenant, body.content_id, reporter_id, body.reason, body.detail)
    return JSONResponse({"case_id": case["case_id"], "status": "created"}, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {contentTenant, findCase, insertCase, updateCase} from 'moderation/store';

export const app = Fastify();

export const ALLOWED_REASONS = ['spam', 'harassment', 'hate', 'self_harm', 'csam'];
export const MAX_DETAIL_BYTES = 4096;

interface ReportBody {
  content_id: string;
  reason: string;
  detail?: string;
}

app.post('/v1/reports', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  const reporterId = request.headers['x-reporter-id'];
  if (typeof tenant !== 'string' || tenant === '' || typeof reporterId !== 'string' || reporterId === '') {
    return reply.code(401).send({error: 'X-Tenant-Id and X-Reporter-Id are required'});
  }
  const body = request.body as ReportBody;
  const detail = body.detail ?? '';
  if ((await contentTenant(body.content_id)) === null) return reply.code(404).send({error: 'no such content'});
  const reason = ALLOWED_REASONS.includes(body.reason) ? body.reason : 'other';
  if (detail.length > MAX_DETAIL_BYTES) return reply.code(413).send({error: 'detail is too long'});
  const created = await insertCase(tenant, body.content_id, reporterId, reason, detail);
  return reply.code(201).send({case_id: created.case_id, status: 'created'});
});
`,
      solution: `import Fastify from 'fastify';

import {contentTenant, findCase, insertCase, updateCase} from 'moderation/store';

export const app = Fastify();

export const ALLOWED_REASONS = ['spam', 'harassment', 'hate', 'self_harm', 'csam'];
export const MAX_DETAIL_BYTES = 4096;

interface ReportBody {
  content_id: string;
  reason: string;
  detail?: string;
}

app.post('/v1/reports', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const reporterId = request.headers['x-reporter-id'];
  if (typeof tenant !== 'string' || tenant === '' || typeof reporterId !== 'string' || reporterId === '') {
    return reply.code(401).send({error: 'X-Tenant-Id and X-Reporter-Id are required'});
  }
  const body = request.body as ReportBody;
  const detail = body.detail ?? '';
  // A foreign id answers exactly as an unknown one: nothing confirms what another tenant hosts.
  if ((await contentTenant(body.content_id)) !== tenant) return reply.code(404).send({error: 'no such content'});
  if (!ALLOWED_REASONS.includes(body.reason)) {
    return reply.code(400).send({error: \`reason must be one of \${ALLOWED_REASONS.join(', ')}\`});
  }
  if (Buffer.byteLength(detail, 'utf8') > MAX_DETAIL_BYTES) {
    return reply.code(413).send({error: \`detail is over \${MAX_DETAIL_BYTES} bytes\`});
  }
  const existing = await findCase(tenant, body.content_id, reporterId);
  if (existing !== null) {
    const updated = await updateCase(existing.case_id, body.reason, detail);
    return reply.code(200).send({case_id: updated.case_id, status: 'updated'});
  }
  const created = await insertCase(tenant, body.content_id, reporterId, body.reason, detail);
  return reply.code(201).send({case_id: created.case_id, status: 'created'});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"unicode/utf8"

	"moderation/store" // store.ContentTenant, FindCase, InsertCase, UpdateCase
)

var allowedReasons = map[string]bool{"spam": true, "harassment": true, "hate": true, "self_harm": true, "csam": true}

const maxDetailBytes = 4096

type reportBody struct {
	ContentID string \`json:"content_id"\`
	Reason    string \`json:"reason"\`
	Detail    string \`json:"detail"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createReport(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	reporterID := r.Header.Get("X-Reporter-Id")
	if tenant == "" || reporterID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id and X-Reporter-Id are required"})
		return
	}
	var body reportBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "the body is not a report"})
		return
	}
	if _, ok := store.ContentTenant(r.Context(), body.ContentID); !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such content"})
		return
	}
	reason := body.Reason
	if !allowedReasons[reason] {
		reason = "other"
	}
	if utf8.RuneCountInString(body.Detail) > maxDetailBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "detail is too long"})
		return
	}
	created := store.InsertCase(r.Context(), tenant, body.ContentID, reporterID, reason, body.Detail)
	writeJSON(rw, http.StatusCreated, map[string]string{"case_id": created.CaseID, "status": "created"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/reports", createReport)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"moderation/store" // store.ContentTenant, FindCase, InsertCase, UpdateCase
)

var allowedReasons = map[string]bool{"spam": true, "harassment": true, "hate": true, "self_harm": true, "csam": true}

const maxDetailBytes = 4096

type reportBody struct {
	ContentID string \`json:"content_id"\`
	Reason    string \`json:"reason"\`
	Detail    string \`json:"detail"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	reporterID := r.Header.Get("X-Reporter-Id")
	if tenant == "" || reporterID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id and X-Reporter-Id are required"})
		return
	}
	var body reportBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "the body is not a report"})
		return
	}
	// A foreign id answers exactly as an unknown one: nothing confirms what another tenant hosts.
	if owner, ok := store.ContentTenant(r.Context(), body.ContentID); !ok || owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such content"})
		return
	}
	if !allowedReasons[body.Reason] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "reason must be one of spam, harassment, hate, self_harm, csam"})
		return
	}
	if len(body.Detail) > maxDetailBytes { // len counts bytes
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": fmt.Sprintf("detail is over %d bytes", maxDetailBytes)})
		return
	}
	if existing := store.FindCase(r.Context(), tenant, body.ContentID, reporterID); existing != nil {
		updated := store.UpdateCase(r.Context(), existing.CaseID, body.Reason, body.Detail)
		writeJSON(rw, http.StatusOK, map[string]string{"case_id": updated.CaseID, "status": "updated"})
		return
	}
	created := store.InsertCase(r.Context(), tenant, body.ContentID, reporterID, body.Reason, body.Detail)
	writeJSON(rw, http.StatusCreated, map[string]string{"case_id": created.CaseID, "status": "created"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/reports", createReport)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import moderation.Store // Store.contentTenant, findCase, insertCase, updateCase

object Api {
  val AllowedReasons: Set[String] = Set("spam", "harassment", "hate", "self_harm", "csam")
  val MaxDetailBytes = 4096

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def field(body: JsObject, name: String): String = body.fields.get(name) match {
    case Some(JsString(s)) => s
    case _ => ""
  }

  private def report(tenant: String, reporterId: String, body: JsObject): HttpResponse = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val contentId = field(body, "content_id")
    val detail = field(body, "detail")
    val reason = if (AllowedReasons.contains(field(body, "reason"))) field(body, "reason") else "other"
    if (Store.contentTenant(contentId).isEmpty) error(StatusCodes.NotFound, "no such content")
    else if (detail.length > MaxDetailBytes) error(StatusCodes.PayloadTooLarge, "detail is too long")
    else {
      val created = Store.insertCase(tenant, contentId, reporterId, reason, detail)
      json(StatusCodes.Created, JsObject("case_id" -> JsString(created.caseId), "status" -> JsString("created")))
    }
  }

  val route: Route = path("v1" / "reports") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("X-Reporter-Id") { reporterId =>
          entity(as[String]) { raw =>
            (tenant.filter(_.nonEmpty), reporterId.filter(_.nonEmpty)) match {
              case (Some(t), Some(r)) => complete(report(t, r, raw.parseJson.asJsObject))
              case _ => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id and X-Reporter-Id are required"))
            }
          }
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import moderation.Store // Store.contentTenant, findCase, insertCase, updateCase

object Api {
  val AllowedReasons: Set[String] = Set("spam", "harassment", "hate", "self_harm", "csam")
  val MaxDetailBytes = 4096

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def field(body: JsObject, name: String): String = body.fields.get(name) match {
    case Some(JsString(s)) => s
    case _ => ""
  }

  private def report(tenant: String, reporterId: String, body: JsObject): HttpResponse = {
    val contentId = field(body, "content_id")
    val reason = field(body, "reason")
    val detail = field(body, "detail")
    // A foreign id answers exactly as an unknown one: nothing confirms what another tenant hosts.
    if (!Store.contentTenant(contentId).contains(tenant)) error(StatusCodes.NotFound, "no such content")
    else if (!AllowedReasons.contains(reason)) error(StatusCodes.BadRequest, "reason must be one of spam, harassment, hate, self_harm, csam")
    else if (detail.getBytes(StandardCharsets.UTF_8).length > MaxDetailBytes) error(StatusCodes.PayloadTooLarge, s"detail is over $MaxDetailBytes bytes")
    else
      Store.findCase(tenant, contentId, reporterId) match {
        case Some(existing) =>
          val updated = Store.updateCase(existing.caseId, reason, detail)
          json(StatusCodes.OK, JsObject("case_id" -> JsString(updated.caseId), "status" -> JsString("updated")))
        case None =>
          val created = Store.insertCase(tenant, contentId, reporterId, reason, detail)
          json(StatusCodes.Created, JsObject("case_id" -> JsString(created.caseId), "status" -> JsString("created")))
      }
  }

  val route: Route = path("v1" / "reports") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("X-Reporter-Id") { reporterId =>
          entity(as[String]) { raw =>
            (tenant.filter(_.nonEmpty), reporterId.filter(_.nonEmpty)) match {
              case (Some(t), Some(r)) => complete(report(t, r, raw.parseJson.asJsObject))
              case _ => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id and X-Reporter-Id are required"))
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

#include <set>
#include <string>

#include "moderation/store.h"  // store::contentTenant, findCase, insertCase, updateCase

using json = nlohmann::json;

const std::set<std::string> kAllowedReasons = {"spam", "harassment", "hate", "self_harm", "csam"};
constexpr size_t kMaxDetailBytes = 4096;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// Characters as the report form counts them.
size_t characters(const std::string& text) {
  size_t n = 0;
  for (const unsigned char c : text) {
    if ((c & 0xC0) != 0x80) n++;
  }
  return n;
}

void create_report(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string reporter_id = req.get_header_value("X-Reporter-Id");
  if (tenant.empty() || reporter_id.empty()) return reply(res, 401, {{"error", "X-Tenant-Id and X-Reporter-Id are required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 422, {{"error", "the body is not a report"}});
  const std::string content_id = body.value("content_id", "");
  const std::string detail = body.value("detail", "");
  std::string reason = body.value("reason", "");
  if (!store::contentTenant(content_id)) return reply(res, 404, {{"error", "no such content"}});
  if (!kAllowedReasons.count(reason)) reason = "other";
  if (characters(detail) > kMaxDetailBytes) return reply(res, 413, {{"error", "detail is too long"}});
  const store::Case created = store::insertCase(tenant, content_id, reporter_id, reason, detail);
  reply(res, 201, {{"case_id", created.case_id}, {"status", "created"}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/reports", create_report); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "moderation/store.h"  // store::contentTenant, findCase, insertCase, updateCase

using json = nlohmann::json;

const std::set<std::string> kAllowedReasons = {"spam", "harassment", "hate", "self_harm", "csam"};
constexpr size_t kMaxDetailBytes = 4096;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_report(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string reporter_id = req.get_header_value("X-Reporter-Id");
  if (tenant.empty() || reporter_id.empty()) return reply(res, 401, {{"error", "X-Tenant-Id and X-Reporter-Id are required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 422, {{"error", "the body is not a report"}});
  const std::string content_id = body.value("content_id", "");
  const std::string reason = body.value("reason", "");
  const std::string detail = body.value("detail", "");
  // A foreign id answers exactly as an unknown one: nothing confirms what another tenant hosts.
  const auto owner = store::contentTenant(content_id);
  if (!owner || *owner != tenant) return reply(res, 404, {{"error", "no such content"}});
  if (!kAllowedReasons.count(reason)) return reply(res, 400, {{"error", "reason must be one of spam, harassment, hate, self_harm, csam"}});
  if (detail.size() > kMaxDetailBytes) return reply(res, 413, {{"error", "detail is over 4096 bytes"}});  // size() counts bytes
  if (const auto existing = store::findCase(tenant, content_id, reporter_id)) {
    const store::Case updated = store::updateCase(existing->case_id, reason, detail);
    return reply(res, 200, {{"case_id", updated.case_id}, {"status", "updated"}});
  }
  const store::Case created = store::insertCase(tenant, content_id, reporter_id, reason, detail);
  reply(res, 201, {{"case_id", created.case_id}, {"status", "created"}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/reports", create_report); }
`,
    },
  },
  harness: {
    python: `from moderation import store

ACME = {"X-Tenant-Id": "acme", "X-Reporter-Id": "u-17"}


def _api(ctx):
    store.add_content("c-1", "acme", "Buy followers now")
    store.add_content("c-2", "globex", "Quarterly results")
    return ctx.client(ctx.load("api").app)


def _report(c, content_id="c-1", reason="spam", detail="", headers=None):
    return c.post("/v1/reports", json={"content_id": content_id, "reason": reason, "detail": detail}, headers=ACME if headers is None else headers)


def _cases(ctx):
    return sorted(ctx.redis.keys("case:case-*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _report(c, detail="Spam link in bio")
        assert r.status_code == 201, f"a report from the content owner answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("status") == "created" and body.get("case_id"), f"a new report must answer {{case_id, status: created}}, got {body}"
        case = store.get_case(body["case_id"])
        assert case is not None and (case["tenant"], case["content_id"], case["reporter_id"], case["reason"], case["detail"]) == ("acme", "c-1", "u-17", "spam", "Spam link in bio"), f"the stored case is {case}"
        r = await c.post("/v1/reports", json={"content_id": "c-1", "reason": "spam"}, headers={"X-Tenant-Id": "acme"})
        assert r.status_code == 401, f"a report without X-Reporter-Id answered {r.status_code}, expected 401"
        r = await _report(c, content_id="c-404")
        assert r.status_code == 404, f"a report on unknown content answered {r.status_code}, expected 404"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        foreign = await _report(c, content_id="c-2")
        unknown = await _report(c, content_id="c-404")
    assert foreign.status_code == 404, f"acme reported globex's content c-2 and got {foreign.status_code}: {foreign.text}. The content must belong to the calling tenant"
    assert _cases(ctx) == [], f"a report on another tenant's content opened {_cases(ctx)}"
    assert foreign.text == unknown.text, f"a foreign id answered {foreign.text!r} and an unknown one {unknown.text!r}: the difference tells acme what globex hosts"


async def check_reason_allowlist(ctx):
    async with _api(ctx) as c:
        for reason in ("spamm", "other", ""):
            r = await _report(c, reason=reason)
            assert r.status_code == 400, f"a report with reason {reason!r} answered {r.status_code}, expected 400"
        assert _cases(ctx) == [], f"rejected reasons opened {_cases(ctx)}"
        r = await _report(c, reason="self_harm")
    assert r.status_code == 201, f"a report with reason 'self_harm' answered {r.status_code}: {r.text}"
    assert store.get_case(r.json()["case_id"])["reason"] == "self_harm", "the case must keep the reason the reporter chose"


async def check_detail_bytes(ctx):
    async with _api(ctx) as c:
        accented = await _report(c, detail="é" * 3000)
        long = await _report(c, detail="a" * 4097)
        exact = await _report(c, detail="é" * 2048)
    assert accented.status_code == 413, f"a detail of 3000 accented characters (6000 bytes of UTF-8) answered {accented.status_code}, expected 413: the cap is in bytes"
    assert long.status_code == 413, f"a detail of 4097 bytes answered {long.status_code}, expected 413"
    assert exact.status_code == 201, f"a detail of exactly 4096 bytes answered {exact.status_code}: {exact.text}"
    assert len(_cases(ctx)) == 1, f"only the report within the cap may open a case, Redis holds {_cases(ctx)}"


async def check_dedupe(ctx):
    async with _api(ctx) as c:
        first = await _report(c, reason="spam", detail="first look")
        again = await _report(c, reason="harassment", detail="second look")
        other = await _report(c, headers={"X-Tenant-Id": "acme", "X-Reporter-Id": "u-18"})
    assert first.status_code == 201, f"the first report answered {first.status_code}: {first.text}"
    case_id = first.json()["case_id"]
    assert again.status_code == 200 and again.json() == {"case_id": case_id, "status": "updated"}, f"the same reporter reporting c-1 again answered {again.status_code} {again.text}, expected 200 {{case_id: {case_id}, status: updated}}"
    case = store.get_case(case_id)
    assert case["reports"] == 2 and case["reason"] == "harassment" and case["detail"] == "second look", f"the repeat report must update the case, it holds {case}"
    assert other.status_code == 201 and other.json()["case_id"] != case_id, f"another reporter on the same content must open their own case, got {other.status_code} {other.text}"
    assert len(_cases(ctx)) == 2, f"two reporters must leave two cases, Redis holds {_cases(ctx)}"
`,
    typescript: `const ACME = {'X-Tenant-Id': 'acme', 'X-Reporter-Id': 'u-17'};

function api(ctx) {
  ctx.redis.hset('content:c-1', 'tenant', 'acme', 'text', 'Buy followers now');
  ctx.redis.hset('content:c-2', 'tenant', 'globex', 'text', 'Quarterly results');
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/moderation/store.ts')};
}

const report = (c, {contentId = 'c-1', reason = 'spam', detail = '', headers = ACME as Record<string, string>} = {}) =>
  c.post('/v1/reports', {json: {content_id: contentId, reason, detail}, headers});

const cases = (ctx): string[] => ctx.redis.keys('case:case-*').sort();

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  let r = await report(c, {detail: 'Spam link in bio'});
  assert.equal(r.status, 201, \`a report from the content owner answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'created' && body.case_id, \`a new report must answer {case_id, status: created}, got \${r.text}\`);
  const stored = await store.getCase(body.case_id);
  assert(
    stored !== null && stored.tenant === 'acme' && stored.content_id === 'c-1' && stored.reporter_id === 'u-17' && stored.reason === 'spam' && stored.detail === 'Spam link in bio',
    \`the stored case is \${JSON.stringify(stored)}\`,
  );
  r = await c.post('/v1/reports', {json: {content_id: 'c-1', reason: 'spam'}, headers: {'X-Tenant-Id': 'acme'}});
  assert.equal(r.status, 401, \`a report without X-Reporter-Id answered \${r.status}, expected 401\`);
  r = await report(c, {contentId: 'c-404'});
  assert.equal(r.status, 404, \`a report on unknown content answered \${r.status}, expected 404\`);
}

export async function check_tenant_scope(ctx) {
  const {c} = api(ctx);
  const foreign = await report(c, {contentId: 'c-2'});
  const unknown = await report(c, {contentId: 'c-404'});
  assert.equal(foreign.status, 404, \`acme reported globex's content c-2 and got \${foreign.status}: \${foreign.text}. The content must belong to the calling tenant\`);
  assert.deepStrictEqual(cases(ctx), [], \`a report on another tenant's content opened \${JSON.stringify(cases(ctx))}\`);
  assert.equal(foreign.text, unknown.text, \`a foreign id answered \${foreign.text} and an unknown one \${unknown.text}: the difference tells acme what globex hosts\`);
}

export async function check_reason_allowlist(ctx) {
  const {c, store} = api(ctx);
  for (const reason of ['spamm', 'other', '']) {
    const r = await report(c, {reason});
    assert.equal(r.status, 400, \`a report with reason \${JSON.stringify(reason)} answered \${r.status}, expected 400\`);
  }
  assert.deepStrictEqual(cases(ctx), [], \`rejected reasons opened \${JSON.stringify(cases(ctx))}\`);
  const r = await report(c, {reason: 'self_harm'});
  assert.equal(r.status, 201, \`a report with reason 'self_harm' answered \${r.status}: \${r.text}\`);
  assert.equal((await store.getCase(r.json().case_id)).reason, 'self_harm', 'the case must keep the reason the reporter chose');
}

export async function check_detail_bytes(ctx) {
  const {c} = api(ctx);
  const accented = await report(c, {detail: 'é'.repeat(3000)});
  const long = await report(c, {detail: 'a'.repeat(4097)});
  const exact = await report(c, {detail: 'é'.repeat(2048)});
  assert.equal(accented.status, 413, \`a detail of 3000 accented characters (6000 bytes of UTF-8) answered \${accented.status}, expected 413: the cap is in bytes\`);
  assert.equal(long.status, 413, \`a detail of 4097 bytes answered \${long.status}, expected 413\`);
  assert.equal(exact.status, 201, \`a detail of exactly 4096 bytes answered \${exact.status}: \${exact.text}\`);
  assert.equal(cases(ctx).length, 1, \`only the report within the cap may open a case, Redis holds \${JSON.stringify(cases(ctx))}\`);
}

export async function check_dedupe(ctx) {
  const {c, store} = api(ctx);
  const first = await report(c, {reason: 'spam', detail: 'first look'});
  const again = await report(c, {reason: 'harassment', detail: 'second look'});
  const other = await report(c, {headers: {'X-Tenant-Id': 'acme', 'X-Reporter-Id': 'u-18'}});
  assert.equal(first.status, 201, \`the first report answered \${first.status}: \${first.text}\`);
  const caseId = first.json().case_id;
  assert(
    again.status === 200 && again.json().case_id === caseId && again.json().status === 'updated',
    \`the same reporter reporting c-1 again answered \${again.status} \${again.text}, expected 200 {case_id: \${caseId}, status: updated}\`,
  );
  const stored = await store.getCase(caseId);
  assert(stored.reports === 2 && stored.reason === 'harassment' && stored.detail === 'second look', \`the repeat report must update the case, it holds \${JSON.stringify(stored)}\`);
  assert(other.status === 201 && other.json().case_id !== caseId, \`another reporter on the same content must open their own case, got \${other.status} \${other.text}\`);
  assert.equal(cases(ctx).length, 2, \`two reporters must leave two cases, Redis holds \${JSON.stringify(cases(ctx))}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"moderation/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	store.AddContent(apiBg, "c-1", "acme", "Buy followers now")
	store.AddContent(apiBg, "c-2", "globex", "Quarterly results")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiReport(c *harness.HTTP, contentID, reason, detail string, header ...string) *harness.Response {
	if len(header) == 0 {
		header = []string{"X-Tenant-Id", "acme", "X-Reporter-Id", "u-17"}
	}
	return c.Post("/v1/reports", map[string]string{"content_id": contentID, "reason": reason, "detail": detail}, header...)
}

func apiField(r *harness.Response, name string) string {
	body, _ := r.JSON().(map[string]any)
	s, _ := body[name].(string)
	return s
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiReport(c, "c-1", "spam", "Spam link in bio")
	ctx.Equal(r.Status, 201, "a report from the content owner (%s)", r.Text())
	caseID := apiField(r, "case_id")
	ctx.Assert(apiField(r, "status") == "created" && caseID != "", "a new report must answer {case_id, status: created}, got %s", r.Text())
	stored := store.GetCase(apiBg, caseID)
	ctx.Assert(stored != nil && stored.Tenant == "acme" && stored.ContentID == "c-1" && stored.ReporterID == "u-17" && stored.Reason == "spam" && stored.Detail == "Spam link in bio", "the stored case is %+v", stored)
	r = c.Post("/v1/reports", map[string]string{"content_id": "c-1", "reason": "spam"}, "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 401, "a report without X-Reporter-Id")
	r = apiReport(c, "c-404", "spam", "")
	ctx.Equal(r.Status, 404, "a report on unknown content")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := apiClient(ctx)
	foreign := apiReport(c, "c-2", "spam", "")
	unknown := apiReport(c, "c-404", "spam", "")
	ctx.Equal(foreign.Status, 404, "acme reported globex's content c-2 (%s); the content must belong to the calling tenant", foreign.Text())
	ctx.Equal(len(ctx.Redis.Keys("case:case-*")), 0, "a report on another tenant's content must open no case; cases")
	ctx.Equal(foreign.Text(), unknown.Text(), "a foreign id must answer exactly as an unknown one, or the difference tells acme what globex hosts; the foreign answer")
}

func CheckReasonAllowlist(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, reason := range []string{"spamm", "other", ""} {
		r := apiReport(c, "c-1", reason, "")
		ctx.Equal(r.Status, 400, "a report with reason %q", reason)
	}
	ctx.Equal(len(ctx.Redis.Keys("case:case-*")), 0, "rejected reasons must open no case; cases")
	r := apiReport(c, "c-1", "self_harm", "")
	ctx.Equal(r.Status, 201, "a report with reason self_harm (%s)", r.Text())
	ctx.Equal(store.GetCase(apiBg, apiField(r, "case_id")).Reason, "self_harm", "the case must keep the reason the reporter chose")
}

func CheckDetailBytes(ctx *harness.Ctx) {
	c := apiClient(ctx)
	accented := apiReport(c, "c-1", "spam", strings.Repeat("é", 3000))
	long := apiReport(c, "c-1", "spam", strings.Repeat("a", 4097))
	exact := apiReport(c, "c-1", "spam", strings.Repeat("é", 2048))
	ctx.Equal(accented.Status, 413, "a detail of 3000 accented characters (6000 bytes of UTF-8): the cap is in bytes")
	ctx.Equal(long.Status, 413, "a detail of 4097 bytes")
	ctx.Equal(exact.Status, 201, "a detail of exactly 4096 bytes (%s)", exact.Text())
	ctx.Equal(len(ctx.Redis.Keys("case:case-*")), 1, "only the report within the cap may open a case; cases")
}

func CheckDedupe(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := apiReport(c, "c-1", "spam", "first look")
	again := apiReport(c, "c-1", "harassment", "second look")
	other := apiReport(c, "c-1", "spam", "", "X-Tenant-Id", "acme", "X-Reporter-Id", "u-18")
	ctx.Equal(first.Status, 201, "the first report (%s)", first.Text())
	caseID := apiField(first, "case_id")
	ctx.Assert(again.Status == 200 && apiField(again, "case_id") == caseID && apiField(again, "status") == "updated", "the same reporter reporting c-1 again answered %d %s, expected 200 {case_id: %s, status: updated}", again.Status, again.Text(), caseID)
	stored := store.GetCase(apiBg, caseID)
	ctx.Assert(stored.Reports == 2 && stored.Reason == "harassment" && stored.Detail == "second look", "the repeat report must update the case, it holds %+v", stored)
	ctx.Assert(other.Status == 201 && apiField(other, "case_id") != caseID, "another reporter on the same content must open their own case, got %d %s", other.Status, other.Text())
	ctx.Equal(len(ctx.Redis.Keys("case:case-*")), 2, "two reporters must leave two cases; cases")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

harness::HTTP apiClient(harness::Ctx& ctx) {
  store::addContent("c-1", "acme", "Buy followers now");
  store::addContent("c-2", "globex", "Quarterly results");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string apiBody(const std::string& content_id, const std::string& reason, const std::string& detail) {
  return nlohmann::json{{"content_id", content_id}, {"reason", reason}, {"detail", detail}}.dump();
}

harness::Response apiReport(harness::HTTP& c, const std::string& content_id, const std::string& reason, const std::string& detail,
                            const std::string& reporter = "u-17") {
  return c.Post("/v1/reports", apiBody(content_id, reason, detail), "Content-Type", "application/json", "X-Tenant-Id", "acme",
                "X-Reporter-Id", reporter);
}

std::string apiField(const harness::Response& r, const std::string& name) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value(name, "") : "";
}

std::string repeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto r = apiReport(c, "c-1", "spam", "Spam link in bio");
  ctx.Equal(r.Status, 201, "a report from the content owner (%s)", r.Text());
  const std::string case_id = apiField(r, "case_id");
  ctx.Assert(apiField(r, "status") == "created" && !case_id.empty(), "a new report must answer {case_id, status: created}, got %s", r.Text());
  const auto stored = store::getCase(case_id);
  ctx.Assert(stored && stored->tenant == "acme" && stored->content_id == "c-1" && stored->reporter_id == "u-17" && stored->reason == "spam" &&
                 stored->detail == "Spam link in bio",
             "the stored case for %s is missing or wrong (reason %q, detail %q)", case_id, stored ? stored->reason : "", stored ? stored->detail : "");
  r = c.Post("/v1/reports", apiBody("c-1", "spam", ""), "Content-Type", "application/json", "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 401, "a report without X-Reporter-Id");
  r = apiReport(c, "c-404", "spam", "");
  ctx.Equal(r.Status, 404, "a report on unknown content");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto foreign = apiReport(c, "c-2", "spam", "");
  const auto unknown = apiReport(c, "c-404", "spam", "");
  ctx.Equal(foreign.Status, 404, "acme reported globex's content c-2 (%s); the content must belong to the calling tenant", foreign.Text());
  ctx.Equal(ctx.Redis.Keys("case:case-*").size(), 0, "a report on another tenant's content must open no case; cases");
  ctx.Equal(foreign.Text(), unknown.Text(), "a foreign id must answer exactly as an unknown one, or the difference tells acme what globex hosts; the foreign answer");
}

void CheckReasonAllowlist(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  for (const std::string reason : {"spamm", "other", ""}) {
    const auto r = apiReport(c, "c-1", reason, "");
    ctx.Equal(r.Status, 400, "a report with reason %q", reason);
  }
  ctx.Equal(ctx.Redis.Keys("case:case-*").size(), 0, "rejected reasons must open no case; cases");
  const auto r = apiReport(c, "c-1", "self_harm", "");
  ctx.Equal(r.Status, 201, "a report with reason self_harm (%s)", r.Text());
  const auto stored = store::getCase(apiField(r, "case_id"));
  ctx.Equal(stored ? stored->reason : "", "self_harm", "the case must keep the reason the reporter chose");
}

void CheckDetailBytes(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto accented = apiReport(c, "c-1", "spam", repeat("é", 3000));
  const auto long_detail = apiReport(c, "c-1", "spam", repeat("a", 4097));
  const auto exact = apiReport(c, "c-1", "spam", repeat("é", 2048));
  ctx.Equal(accented.Status, 413, "a detail of 3000 accented characters (6000 bytes of UTF-8): the cap is in bytes");
  ctx.Equal(long_detail.Status, 413, "a detail of 4097 bytes");
  ctx.Equal(exact.Status, 201, "a detail of exactly 4096 bytes (%s)", exact.Text());
  ctx.Equal(ctx.Redis.Keys("case:case-*").size(), 1, "only the report within the cap may open a case; cases");
}

void CheckDedupe(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto first = apiReport(c, "c-1", "spam", "first look");
  const auto again = apiReport(c, "c-1", "harassment", "second look");
  const auto other = apiReport(c, "c-1", "spam", "", "u-18");
  ctx.Equal(first.Status, 201, "the first report (%s)", first.Text());
  const std::string case_id = apiField(first, "case_id");
  ctx.Assert(again.Status == 200 && apiField(again, "case_id") == case_id && apiField(again, "status") == "updated",
             "the same reporter reporting c-1 again answered %d %s, expected 200 {case_id: %s, status: updated}", again.Status, again.Text(), case_id);
  const auto stored = store::getCase(case_id);
  ctx.Assert(stored && stored->reports == 2 && stored->reason == "harassment" && stored->detail == "second look",
             "the repeat report must update the case: reports %v, reason %q, detail %q", stored ? stored->reports : 0L, stored ? stored->reason : "",
             stored ? stored->detail : "");
  ctx.Assert(other.Status == 201 && apiField(other, "case_id") != case_id, "another reporter on the same content must open their own case, got %d %s",
             other.Status, other.Text());
  ctx.Equal(ctx.Redis.Keys("case:case-*").size(), 2, "two reporters must leave two cases; cases");
}
`,
  },
  hints: [
    'Signed in as acme, report globex’s post: a case opens. Report the same post twice from one account: two cases. Send `spamm` as the reason: a case filed under `other`.',
    'The catalogue lookup asks whether the content exists, not who owns it; an unknown reason falls back instead of failing; the cap counts characters, and `é` is two bytes; nothing looks for the reporter’s case before inserting.',
    'Compare `store.content_tenant(id)` with the caller’s tenant (404 when they differ); 400 when the reason is not in `ALLOWED_REASONS`; measure `len(detail.encode("utf-8"))`; call `store.find_case` first and `update_case` on a hit.',
  ],
  debrief: `The report endpoint is a trust boundary: the body names someone else's content, so ownership is checked against the catalogue before anything is stored, and a foreign id gets the same 404 as an unknown one so the endpoint does not confirm what other tenants host. A closed reason list keeps every case attached to a policy a moderator can apply; a fallback category turns typos into queue work. Bytes are what the store and every copy downstream pay for, so the cap counts bytes. Keying a case by tenant, content and reporter turns a repeat report into a signal on one case. Production intake also rate-limits reports per reporter, weighs reporters by how often their reports were upheld, and merges cases from different reporters on one item for the moderator.`,
};
