import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/reports: a report that must be real and unique',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and writes a case row. It compiles, it serves the demo, and it hides four production flaws.
Review it like the trust-and-safety owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/reports\` with body \`{"content_id": "…", "reason": "…", "detail": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header and the reporter from
  \`X-Reporter-Id\`; either one missing is **401**.
- \`content_id\` must resolve to content **owned by the calling tenant** — look it up in the tenant
  catalogue and answer **404** for a foreign or unknown id. The draft accepts any content id, so a
  tenant can file a report against another tenant's content.
- \`reason\` must be one of \`spam\`, \`harassment\`, \`hate\`, \`self_harm\`, \`csam\`; anything else is
  **400**. The draft falls back to an \`"other"\` bucket, so a typo silently becomes a real case.
- \`detail\` is optional (default \`""\`) and at most **4096 bytes** of UTF-8; a larger detail is
  **413**. The draft never caps it, so one report can carry a megabyte into the case store.
- A reporter may report the same item only once: look up the reporter's open case on
  \`(tenant, content_id, reporter_id)\` and **update it** (200, \`status: "updated"\`) instead of
  minting a second case. A genuinely new report creates a case (**201**, \`status: "created"\`). The
  draft inserts a fresh row for every duplicate, so one angry reporter can inflate the queue.
- Log the case id, the tenant and the content id — never the detail text, which is report content
  about a person.

**Failure mode the checks target.** A report is a claim about someone else's content, so the
endpoint is a trust boundary: the tenant must own the content, the reason must be a real reason,
the detail must be bounded, and a repeat report is a signal on an existing case, not a new one. The
draft fails all four because the demo only ever sends well-formed reports from the content owner.`,
  sequence: {
    participants: ['Reporter', 'Moderation API', 'case store'],
    messages: [
      {from: 'Reporter', to: 'Moderation API', label: 'POST /v1/reports · X-Tenant-Id · X-Reporter-Id', kind: 'sync'},
      {from: 'Moderation API', to: 'Moderation API', label: 'allowlisted reason · detail ≤ 4 KiB', kind: 'sync'},
      {from: 'Moderation API', to: 'case store', label: 'find(tenant, content_id, reporter_id)', kind: 'sync'},
      {from: 'case store', to: 'Moderation API', label: 'existing case / none', kind: 'reply'},
      {from: 'Moderation API', to: 'case store', label: 'update(case_id) or insert(case_id)', kind: 'async'},
      {from: 'Moderation API', to: 'Reporter', label: '201 created · 200 updated', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/reports',
      detail: 'Register the report intake on `POST /v1/reports`.',
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
        'The content id is resolved against the tenant catalogue and a foreign or unknown id is **404**. The draft accepts any content id, so a tenant can report content it does not own and start a case against someone else.',
      match: {
        python: {all: [/CONTENT_TENANTS/, /belongs_to\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/CONTENT_TENANTS/, /belongsTo\(/, /code\(\s*404\s*\)/]},
        go: {all: [/contentTenants/, /belongsTo\(/, /StatusNotFound/]},
        scala: {all: [/ContentTenants/, /belongsTo\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/kContentTenants/, /belongsTo\(/, /\b404\b/]},
      },
    },
    {
      id: 'reason-allowlist',
      title: 'Rejects a reason outside the allowlist',
      detail:
        'Only `spam`, `harassment`, `hate`, `self_harm` and `csam` are accepted; anything else is **400**. The draft maps an unknown reason to `other`, so a typo becomes a real moderation case with no rule behind it.',
      match: {
        python: {all: [/ALLOWED_REASONS/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_REASONS/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedReasons/, /StatusBadRequest/]},
        scala: {all: [/AllowedReasons/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedReasons/, /\b400\b/]},
      },
    },
    {
      id: 'detail-cap',
      title: 'Caps the optional detail at 4 KiB',
      detail:
        'A `detail` longer than **4096 bytes** is **413**. The draft never measures it, so one report can push an unbounded and highly personal free-text field into the case store and every downstream record.',
      match: {
        python: {all: [/MAX_DETAIL_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_DETAIL_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxDetailBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxDetailBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxDetailBytes/, /\b413\b/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Updates the reporter’s existing case instead of creating a second',
      detail:
        'The lookup on `(tenant, content_id, reporter_id)` runs first; a hit updates that case and answers `status: "updated"`, a miss inserts and answers `status: "created"`. The draft always inserts, so a reporter who reports twice creates two cases for one item.',
      match: {
        python: {all: [/cases\.find\(/, /cases\.update\(/, /"updated"/]},
        typescript: {all: [/cases\.find\(/, /cases\.update\(/, /'updated'/]},
        go: {all: [/cases\.Find\(/, /cases\.Update\(/, /"updated"/]},
        scala: {all: [/cases\.find\(/, /cases\.update\(/, /"updated"/]},
        cpp: {all: [/cases\.find\(/, /cases\.update\(/, /"updated"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("moderation")

REASON_FALLBACK = "other"


class ReportRequest(BaseModel):
    content_id: str
    reason: str
    detail: str = ""


class CaseStore:
    def insert(self, case_id: str, **fields) -> None:
        """Write a new case row."""
        raise NotImplementedError


cases = CaseStore()


@app.post("/v1/reports")
def create_report(
    body: ReportRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
    reporter_id: str = Header(alias="X-Reporter-Id"),
) -> JSONResponse:
    # TODO: this draft accepts content ids from any tenant, lets unknown reasons through as
    # "other", never caps the detail, and mints a new case for every duplicate report. Fix all four.
    reason = body.reason or REASON_FALLBACK
    case_id = str(uuid.uuid4())
    cases.insert(
        case_id,
        tenant=tenant,
        content_id=body.content_id,
        reporter_id=reporter_id,
        reason=reason,
        detail=body.detail,
    )
    logger.info("report case=%s tenant=%s bytes=%d", case_id, tenant, len(body.detail))
    return JSONResponse({"case_id": case_id}, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("moderation")

ALLOWED_REASONS = {"spam", "harassment", "hate", "self_harm", "csam"}
MAX_DETAIL_BYTES = 4096
CONTENT_TENANTS = {"c_8f21": "acme", "c_1a44": "globex", "c_77bd": "acme"}


class ReportRequest(BaseModel):
    content_id: str
    reason: str
    detail: str = ""


class CaseStore:
    def find(self, tenant: str, content_id: str, reporter_id: str) -> dict | None:
        """The reporter's open case on this item, if any."""
        raise NotImplementedError

    def insert(self, case_id: str, **fields) -> None:
        """Write a new case row."""
        raise NotImplementedError

    def update(self, case_id: str, **fields) -> None:
        """Update the existing case row."""
        raise NotImplementedError


cases = CaseStore()


def belongs_to(tenant: str, content_id: str) -> bool:
    return CONTENT_TENANTS.get(content_id) == tenant


@app.post("/v1/reports")
def create_report(
    body: ReportRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    reporter_id: str | None = Header(default=None, alias="X-Reporter-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if reporter_id is None or reporter_id == "":
        raise HTTPException(status_code=401, detail="missing X-Reporter-Id")
    if not belongs_to(tenant, body.content_id):
        raise HTTPException(status_code=404, detail="unknown content")
    if body.reason not in ALLOWED_REASONS:
        raise HTTPException(status_code=400, detail="unknown reason")
    if len(body.detail.encode("utf-8")) > MAX_DETAIL_BYTES:
        raise HTTPException(status_code=413, detail="detail exceeds 4 KiB")

    existing = cases.find(tenant, body.content_id, reporter_id)
    if existing is not None:
        cases.update(existing["case_id"], reason=body.reason, detail=body.detail)
        logger.info("report updated case=%s tenant=%s content=%s", existing["case_id"], tenant, body.content_id)
        return JSONResponse({"case_id": existing["case_id"], "status": "updated"}, status_code=200)

    case_id = str(uuid.uuid4())
    cases.insert(
        case_id,
        tenant=tenant,
        content_id=body.content_id,
        reporter_id=reporter_id,
        reason=body.reason,
        detail=body.detail,
    )
    logger.info("report created case=%s tenant=%s content=%s", case_id, tenant, body.content_id)
    return JSONResponse({"case_id": case_id, "status": "created"}, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/reports: a model-generated draft that trusts the body and duplicates cases. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const REASON_FALLBACK = 'other';

interface ReportBody {
  content_id: string;
  reason: string;
  detail?: string;
}

interface CaseStore {
  insert(caseId: string, fields: Record<string, unknown>): Promise<void>;
}

export const cases: CaseStore = {
  insert: async () => {},
};

app.post('/v1/reports', async (request, reply) => {
  // TODO: this draft accepts content ids from any tenant, lets unknown reasons through as
  // "other", never caps the detail, and mints a new case for every duplicate report. Fix all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const reporterId = request.headers['x-reporter-id'] as string;
  const body = request.body as ReportBody;
  const reason = body.reason || REASON_FALLBACK;
  const caseId = randomUUID();
  await cases.insert(caseId, {
    tenant,
    content_id: body.content_id,
    reporter_id: reporterId,
    reason,
    detail: body.detail ?? '',
  });
  request.log.info({case_id: caseId, tenant, bytes: (body.detail ?? '').length}, 'report');
  return reply.code(201).send({case_id: caseId});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/reports: a report that must be real, in-tenant and unique per reporter. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const ALLOWED_REASONS: Record<string, true> = {
  spam: true,
  harassment: true,
  hate: true,
  self_harm: true,
  csam: true,
};
const MAX_DETAIL_BYTES = 4096;
const CONTENT_TENANTS: Record<string, string> = {c_8f21: 'acme', c_1a44: 'globex', c_77bd: 'acme'};

interface ReportBody {
  content_id: string;
  reason: string;
  detail?: string;
}

interface CaseStore {
  find(tenant: string, contentId: string, reporterId: string): Promise<{case_id: string} | null>;
  insert(caseId: string, fields: Record<string, unknown>): Promise<void>;
  update(caseId: string, fields: Record<string, unknown>): Promise<void>;
}

export const cases: CaseStore = {
  find: async () => null,
  insert: async () => {},
  update: async () => {},
};

function belongsTo(tenant: string, contentId: string): boolean {
  return CONTENT_TENANTS[contentId] === tenant;
}

app.post('/v1/reports', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const reporterId = request.headers['x-reporter-id'];
  if (typeof reporterId !== 'string' || reporterId === '')
    return reply.code(401).send({error: 'missing X-Reporter-Id'});

  const body = request.body as Partial<ReportBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.content_id !== 'string')
    return reply.code(400).send({error: 'unknown content'});
  if (!belongsTo(tenant, body.content_id)) return reply.code(404).send({error: 'unknown content'});
  if (typeof body.reason !== 'string' || ALLOWED_REASONS[body.reason] !== true)
    return reply.code(400).send({error: 'unknown reason'});
  const detail = body.detail ?? '';
  if (Buffer.byteLength(detail, 'utf8') > MAX_DETAIL_BYTES)
    return reply.code(413).send({error: 'detail exceeds 4 KiB'});

  const existing = await cases.find(tenant, body.content_id, reporterId);
  if (existing !== null) {
    await cases.update(existing.case_id, {reason: body.reason, detail});
    request.log.info({case_id: existing.case_id, tenant, content_id: body.content_id}, 'report updated');
    return reply.code(200).send({case_id: existing.case_id, status: 'updated'});
  }

  const caseId = randomUUID();
  await cases.insert(caseId, {
    tenant,
    content_id: body.content_id,
    reporter_id: reporterId,
    reason: body.reason,
    detail,
  });
  request.log.info({case_id: caseId, tenant, content_id: body.content_id}, 'report created');
  return reply.code(201).send({case_id: caseId, status: 'created'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

const reasonFallback = "other"

type ReportRequest struct {
	ContentID string \`json:"content_id"\`
	Reason    string \`json:"reason"\`
	Detail    string \`json:"detail"\`
}

type CaseStore struct{}

func (s *CaseStore) Insert(caseID string, fields map[string]any) error { return nil }

var cases = &CaseStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	reporterID := r.Header.Get("X-Reporter-Id")
	var body ReportRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts content ids from any tenant, lets unknown reasons through as
	// "other", never caps the detail, and mints a new case for every duplicate report.
	reason := body.Reason
	if reason == "" {
		reason = reasonFallback
	}
	caseID := fmt.Sprintf("case_%d", time.Now().UnixNano())
	cases.Insert(caseID, map[string]any{
		"tenant": tenant, "content_id": body.ContentID, "reporter_id": reporterID,
		"reason": reason, "detail": body.Detail,
	})
	log.Printf("report case=%s tenant=%s bytes=%d", caseID, tenant, len(body.Detail))
	writeJSON(rw, http.StatusCreated, map[string]any{"case_id": caseID})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/reports", createReport)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const maxDetailBytes = 4096

var allowedReasons = map[string]bool{
	"spam":       true,
	"harassment": true,
	"hate":       true,
	"self_harm":  true,
	"csam":       true,
}

var contentTenants = map[string]string{"c_8f21": "acme", "c_1a44": "globex", "c_77bd": "acme"}

type ReportRequest struct {
	ContentID string \`json:"content_id"\`
	Reason    string \`json:"reason"\`
	Detail    string \`json:"detail"\`
}

type CaseStore struct{}

func (s *CaseStore) Find(tenant, contentID, reporterID string) (map[string]any, error) {
	return nil, nil
}

func (s *CaseStore) Insert(caseID string, fields map[string]any) error { return nil }

func (s *CaseStore) Update(caseID string, fields map[string]any) error { return nil }

var cases = &CaseStore{}

func belongsTo(tenant, contentID string) bool {
	return contentTenants[contentID] == tenant
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createReport(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	reporterID := r.Header.Get("X-Reporter-Id")
	if reporterID == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Reporter-Id"})
		return
	}
	var body ReportRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !belongsTo(tenant, body.ContentID) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown content"})
		return
	}
	if !allowedReasons[body.Reason] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown reason"})
		return
	}
	if len([]byte(body.Detail)) > maxDetailBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "detail exceeds 4 KiB"})
		return
	}
	existing, err := cases.Find(tenant, body.ContentID, reporterID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		caseID := existing["case_id"].(string)
		cases.Update(caseID, map[string]any{"reason": body.Reason, "detail": body.Detail})
		log.Printf("report updated case=%s tenant=%s content=%s", caseID, tenant, body.ContentID)
		writeJSON(rw, http.StatusOK, map[string]any{"case_id": caseID, "status": "updated"})
		return
	}
	caseID := uuid.NewString()
	cases.Insert(caseID, map[string]any{
		"tenant": tenant, "content_id": body.ContentID, "reporter_id": reporterID,
		"reason": body.Reason, "detail": body.Detail,
	})
	log.Printf("report created case=%s tenant=%s content=%s", caseID, tenant, body.ContentID)
	writeJSON(rw, http.StatusCreated, map[string]any{"case_id": caseID, "status": "created"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/reports", createReport)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReportRequest(content_id: String, reason: String, detail: String)

object ReportApi {
  implicit val system: ActorSystem = ActorSystem("moderation")
  implicit val reportFormat: RootJsonFormat[ReportRequest] = jsonFormat3(ReportRequest)

  val ReasonFallback = "other"

  val cases = CaseStore.open()

  val route: Route =
    path("v1" / "reports") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-Reporter-Id") { reporterOpt =>
            entity(as[ReportRequest]) { body =>
              // TODO: this draft accepts content ids from any tenant, lets unknown reasons through
              // as "other", never caps the detail, and mints a new case for every duplicate report.
              val reason = if (body.reason.nonEmpty) body.reason else ReasonFallback
              val caseId = UUID.randomUUID().toString
              cases.insert(caseId, tenantOpt.getOrElse(""), body.content_id, reporterOpt.getOrElse(""), reason, body.detail)
              system.log.info(s"report case=$caseId tenant=\${tenantOpt.getOrElse("")}")
              complete(StatusCodes.Created, s"""{"case_id":"$caseId"}""")
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
      solution: `import java.nio.charset.StandardCharsets
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReportRequest(content_id: String, reason: String, detail: String)

object ReportApi {
  implicit val system: ActorSystem = ActorSystem("moderation")
  implicit val reportFormat: RootJsonFormat[ReportRequest] = jsonFormat3(ReportRequest)

  val AllowedReasons = Set("spam", "harassment", "hate", "self_harm", "csam")
  val MaxDetailBytes = 4096
  val ContentTenants = Map("c_8f21" -> "acme", "c_1a44" -> "globex", "c_77bd" -> "acme")

  val cases = CaseStore.open()

  def belongsTo(tenant: String, contentId: String): Boolean =
    ContentTenants.get(contentId).contains(tenant)

  val route: Route =
    path("v1" / "reports") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-Reporter-Id") { reporterOpt =>
            entity(as[ReportRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!reporterOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Reporter-Id"}""")
              } else if (!belongsTo(tenantOpt.get, body.content_id)) {
                complete(StatusCodes.NotFound, """{"error":"unknown content"}""")
              } else if (!AllowedReasons.contains(body.reason)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown reason"}""")
              } else if (body.detail.getBytes(StandardCharsets.UTF_8).length > MaxDetailBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"detail exceeds 4 KiB"}""")
              } else {
                val tenant = tenantOpt.get
                val reporter = reporterOpt.get
                cases.find(tenant, body.content_id, reporter) match {
                  case Some(existing) =>
                    cases.update(existing.case_id, body.reason, body.detail)
                    system.log.info(s"report updated case=\${existing.case_id} tenant=$tenant")
                    complete(StatusCodes.OK, s"""{"case_id":"\${existing.case_id}","status":"updated"}""")
                  case None =>
                    val caseId = UUID.randomUUID().toString
                    cases.insert(caseId, tenant, body.content_id, reporter, body.reason, body.detail)
                    system.log.info(s"report created case=$caseId tenant=$tenant")
                    complete(StatusCodes.Created, s"""{"case_id":"$caseId","status":"created"}""")
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

const std::string kReasonFallback = "other";

struct CaseStore {
  void insert(const std::string& caseId, const json& fields);
};

CaseStore cases;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/reports", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto reporter = req.get_header_value("X-Reporter-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts content ids from any tenant, lets unknown reasons through as
    // "other", never caps the detail, and mints a new case for every duplicate report.
    auto reason = body.value("reason", std::string());
    if (reason.empty()) reason = kReasonFallback;
    const auto detail = body.value("detail", std::string());
    const auto caseId = uuidString();
    cases.insert(caseId, json{{"tenant", tenant}, {"content_id", body.value("content_id", std::string())},
                              {"reporter_id", reporter}, {"reason", reason}, {"detail", detail}});
    std::cerr << "report case=" << caseId << " tenant=" << tenant << " bytes=" << detail.size() << "\\n";
    res.status = 201;
    res.set_content(json{{"case_id", caseId}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxDetailBytes = 4096;
const std::set<std::string> kAllowedReasons = {"spam", "harassment", "hate", "self_harm", "csam"};
const std::map<std::string, std::string> kContentTenants = {
    {"c_8f21", "acme"}, {"c_1a44", "globex"}, {"c_77bd", "acme"}};

struct CaseStore {
  std::optional<json> find(const std::string& tenant, const std::string& contentId, const std::string& reporterId);
  void insert(const std::string& caseId, const json& fields);
  void update(const std::string& caseId, const json& fields);
};

CaseStore cases;
std::string uuidString();

bool belongsTo(const std::string& tenant, const std::string& contentId) {
  const auto it = kContentTenants.find(contentId);
  return it != kContentTenants.end() && it->second == tenant;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/reports", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto reporter = req.get_header_value("X-Reporter-Id");
    if (reporter.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Reporter-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("content_id") || !body["content_id"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"unknown content"})", "application/json");
      return;
    }
    const auto contentId = body["content_id"].get<std::string>();
    if (!belongsTo(tenant, contentId)) {
      res.status = 404;
      res.set_content(R"({"error":"unknown content"})", "application/json");
      return;
    }
    const auto reason = body.value("reason", std::string());
    if (kAllowedReasons.count(reason) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown reason"})", "application/json");
      return;
    }
    const auto detail = body.value("detail", std::string());
    if (detail.size() > kMaxDetailBytes) {
      res.status = 413;
      res.set_content(R"({"error":"detail exceeds 4 KiB"})", "application/json");
      return;
    }
    const auto existing = cases.find(tenant, contentId, reporter);
    if (existing) {
      const auto caseId = existing->value("case_id", std::string());
      cases.update(caseId, json{{"reason", reason}, {"detail", detail}});
      res.status = 200;
      res.set_content(json{{"case_id", caseId}, {"status", "updated"}}.dump(), "application/json");
      return;
    }
    const auto caseId = uuidString();
    cases.insert(caseId, json{{"tenant", tenant}, {"content_id", contentId}, {"reporter_id", reporter},
                              {"reason", reason}, {"detail", detail}});
    std::cerr << "report created case=" << caseId << " tenant=" << tenant << "\\n";
    res.status = 201;
    res.set_content(json{{"case_id", caseId}, {"status", "created"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guards by cost: tenant and reporter, then the content lookup, then the reason, then the byte length. Every rejection returns before anything is written, so a malformed or foreign report never reaches the case store.',
    'The dedupe lookup is keyed by `(tenant, content_id, reporter_id)` and runs before the insert. A hit means this reporter already has a case on this item: update the reason and detail, bump the case, and answer `status: "updated"` instead of minting a second row.',
    'The detail is report content about a person, so it is both bounded and never logged: measure its UTF-8 bytes against 4096 and log the case id, the tenant and the content id. `logger.info(..., body.detail)` ships a private statement into every log sink.',
  ],
  debrief: `The interviewer is testing whether you treat a report as a claim, not as trusted input. The draft reads fine because the demo reports the tenant's own content with a valid reason, once. Four defects are being checked: ownership (a tenant can only report its own content — anything else is a 404, not a 403 that confirms the content exists), a closed reason set, a byte cap on the free text, and per-reporter uniqueness that turns a repeat report into a signal on an existing case rather than queue inflation. Real systems add rate limits per reporter, a hashed content fingerprint for cross-tenant detection, and a separate store for the sensitive detail so it can be sealed and audited apart from the case metadata.`,
};
