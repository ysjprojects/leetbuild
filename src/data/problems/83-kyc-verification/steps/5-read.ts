import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/applicants/{id}/status: scoped status with public reasons',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'db', 'storage'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/applicants/{id}/status\`, the read the applicant app
polls: it finds the applicant's newest case with \`cases.lookup_any\`, and answers \`{applicant,
case_id, status, reasons, documents}\` with the stored reason codes and each document's
\`storage.url\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** One tenant's app reads another tenant's applicant; a refusal
reaches the customer in the vendor's internal codes, watchlist hits included; a passport link
pasted into a support ticket opens the scan years later; and the app shows a verdict while a person
is still deciding.

- The caller is the tenant in \`X-Tenant-Id\`: look up \`cases.lookup(tenant, applicant)\`; another
  tenant's applicant is **404**, like a missing one, and a read without the header shows no case.
- \`reasons\` are mapped through \`PUBLIC_REASONS\` (\`DOC_EXPIRED\` → \`document_expired\`,
  \`DOC_UNREADABLE\` → \`document_unreadable\`, \`FACE_MISMATCH\` → \`selfie_mismatch\`,
  \`DATA_MISMATCH\` → \`details_mismatch\`); a code it does not list stays inside.
- Each document is \`{type, url, expires_at}\` from \`storage.sign(ref, LINK_TTL_S)\` with
  \`LINK_TTL_S = 300\`, never the permanent \`storage.url\`.
- The body carries \`degraded\` and \`awaiting_review\` (true while the case is \`manual_review\`).`,
  sequence: {
    participants: ['Applicant app', 'KYC API', 'Case store', 'Document storage'],
    messages: [
      {from: 'Applicant app', to: 'KYC API', label: 'GET /v1/applicants/a-1/status · X-Tenant-Id', kind: 'sync'},
      {from: 'KYC API', to: 'Case store', label: 'lookup(tenant, applicant)', kind: 'sync'},
      {from: 'Case store', to: 'KYC API', label: 'case · none for another tenant’s applicant', kind: 'reply'},
      {from: 'KYC API', to: 'Document storage', label: 'sign(ref, 300 s)', kind: 'sync'},
      {from: 'Document storage', to: 'KYC API', label: 'url + expires_at', kind: 'reply'},
      {
        from: 'KYC API',
        to: 'Applicant app',
        label: '200 {status, public reasons, degraded, awaiting_review, documents} · 404',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/applicants/{id}/status',
      detail:
        'Register `GET /v1/applicants/{id}/status`; the applicant’s case answers 200 with its status and case id.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/applicants\/\{[^"']+\}\/status["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/applicants\/:[^'"]+\/status['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/applicants\/\{id\}\/status"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"applicants"\s*\/\s*Segment\s*\/\s*"status"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/applicants/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Another tenant’s applicant is 404',
      detail:
        'The case is looked up under the caller’s tenant (`lookup(tenant, applicant)`), and a read without `X-Tenant-Id` shows no case; `lookup_any`, the support console’s cross-tenant search, hands one tenant’s app another tenant’s applicant.',
      match: {
        python: {all: [/cases\.lookup\(\s*tenant/, /\b404\b/], none: [/lookup_any\(/]},
        typescript: {all: [/cases\.lookup\(\s*tenant/, /\b404\b/], none: [/lookupAny\(/]},
        go: {all: [/cases\.Lookup\([^\n]*tenant/, /StatusNotFound/], none: [/LookupAny\(/]},
        scala: {all: [/Cases\.lookup\(\s*tenant/, /NotFound/], none: [/lookupAny\(/]},
        cpp: {all: [/cases::lookup\(\s*tenant/, /\b404\b/], none: [/lookupAny\(/]},
      },
    },
    {
      id: 'public-reasons',
      title: 'Maps vendor codes to the public reason set',
      detail:
        'Each stored code goes out through `PUBLIC_REASONS` and a code it does not list is dropped, whatever it is called: the vendor’s vocabulary, watchlist and sanctions codes included, never reaches the customer.',
      match: {
        python: {all: [/PUBLIC_REASONS\s*=/, /in PUBLIC_REASONS/]},
        typescript: {all: [/PUBLIC_REASONS\s*[:=]/, /in PUBLIC_REASONS/]},
        go: {all: [/publicReasons\s*=/, /publicReasons\[/]},
        scala: {all: [/PublicReasons\s*[:=]/, /PublicReasons\.get\(/]},
        cpp: {all: [/kPublicReasons\s*=/, /kPublicReasons\.find\(/]},
      },
    },
    {
      id: 'signed-link',
      title: 'Hands out document links that expire',
      detail:
        'Each document carries a link from `sign(ref, LINK_TTL_S)` (300 s) with its `expires_at`, and no permanent `url` appears in the body: a permanent url keeps opening the scan wherever it is pasted.',
      match: {
        python: {all: [/storage\.sign\(/, /LINK_TTL_S\s*=\s*300\b/], none: [/storage\.url\(/]},
        typescript: {all: [/storage\.sign\(/, /LINK_TTL_S\s*=\s*300\b/], none: [/storage\.url\(/]},
        go: {all: [/storage\.Sign\(/, /linkTTLS\s*=\s*300\b/], none: [/storage\.URL\(/]},
        scala: {all: [/Storage\.sign\(/, /LinkTtlS\s*=\s*300L?\b/], none: [/Storage\.url\(/]},
        cpp: {all: [/storage::sign\(/, /kLinkTtlS\s*=\s*300\b/], none: [/storage::url\(/]},
      },
    },
    {
      id: 'review-flags',
      title: 'Says whether the case is degraded or awaiting a person',
      detail:
        'The body carries the case’s own `degraded` flag and `awaiting_review` (true for `manual_review` only), so the app can say “still deciding” instead of reading the status as a verdict.',
      match: {
        python: {all: [/["']degraded["']:\s*\w+\[["']degraded["']\]/, /["']awaiting_review["']:/]},
        typescript: {all: [/degraded:\s*\w+\.degraded/, /awaiting_review:/]},
        go: {all: [/"degraded":\s*\w+\.Degraded/, /"awaiting_review":/]},
        scala: {all: [/"degraded"\s*->\s*JsBoolean\(/, /"awaiting_review"/]},
        cpp: {all: [/\{"degraded",\s*\w+(->|\.)degraded\}/, /"awaiting_review"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from kyc import cases, storage  # cases.lookup/lookup_any, storage.sign/url

app = FastAPI()


@app.get("/v1/applicants/{applicant_id}/status")
def applicant_status(applicant_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    case = cases.lookup_any(applicant_id)
    if case is None:
        raise HTTPException(status_code=404, detail="no such applicant")
    return JSONResponse(
        {
            "applicant": applicant_id,
            "case_id": case["case_id"],
            "status": case["status"],
            "reasons": case["reasons"],
            "documents": [{"type": d["type"], "url": storage.url(d["ref"])} for d in case["documents"]],
        }
    )
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from kyc import cases, storage  # cases.lookup/lookup_any, storage.sign/url

app = FastAPI()

LINK_TTL_S = 300
# The vendor codes a customer may see, in the app's words; every other code stays inside.
PUBLIC_REASONS = {
    "DOC_EXPIRED": "document_expired",
    "DOC_UNREADABLE": "document_unreadable",
    "FACE_MISMATCH": "selfie_mismatch",
    "DATA_MISMATCH": "details_mismatch",
}


@app.get("/v1/applicants/{applicant_id}/status")
def applicant_status(applicant_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    # Scoped to the caller: another tenant's applicant is as absent as one nobody has.
    case = cases.lookup(tenant, applicant_id) if tenant else None
    if case is None:
        raise HTTPException(status_code=404, detail="no such applicant")
    return JSONResponse(
        {
            "applicant": applicant_id,
            "case_id": case["case_id"],
            "status": case["status"],
            "reasons": [PUBLIC_REASONS[code] for code in case["reasons"] if code in PUBLIC_REASONS],
            "degraded": case["degraded"],
            "awaiting_review": case["status"] == "manual_review",
            "documents": [{"type": d["type"], **storage.sign(d["ref"], LINK_TTL_S)} for d in case["documents"]],
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as cases from 'kyc/cases'; // cases.lookup, lookupAny
import * as storage from 'kyc/storage'; // storage.sign, url

export const app = Fastify();

app.get('/v1/applicants/:applicantId/status', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {applicantId} = request.params as {applicantId: string};
  const found = await cases.lookupAny(applicantId);
  if (found === null) return reply.code(404).send({error: 'no such applicant'});
  return {
    applicant: applicantId,
    case_id: found.case_id,
    status: found.status,
    reasons: found.reasons,
    documents: found.documents.map(d => ({type: d.type, url: storage.url(d.ref)})),
  };
});
`,
      solution: `import Fastify from 'fastify';

import * as cases from 'kyc/cases'; // cases.lookup, lookupAny
import * as storage from 'kyc/storage'; // storage.sign, url

export const app = Fastify();

const LINK_TTL_S = 300;
// The vendor codes a customer may see, in the app's words; every other code stays inside.
const PUBLIC_REASONS: Record<string, string> = {
  DOC_EXPIRED: 'document_expired',
  DOC_UNREADABLE: 'document_unreadable',
  FACE_MISMATCH: 'selfie_mismatch',
  DATA_MISMATCH: 'details_mismatch',
};

app.get('/v1/applicants/:applicantId/status', async (request, reply) => {
  const {applicantId} = request.params as {applicantId: string};
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  // Scoped to the caller: another tenant's applicant is as absent as one nobody has.
  const found = tenant === '' ? null : await cases.lookup(tenant, applicantId);
  if (found === null) return reply.code(404).send({error: 'no such applicant'});
  const documents = [];
  for (const d of found.documents) documents.push({type: d.type, ...(await storage.sign(d.ref, LINK_TTL_S))});
  return {
    applicant: applicantId,
    case_id: found.case_id,
    status: found.status,
    reasons: found.reasons.filter(code => code in PUBLIC_REASONS).map(code => PUBLIC_REASONS[code]),
    degraded: found.degraded,
    awaiting_review: found.status === 'manual_review',
    documents,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"kyc/cases"   // cases.Lookup, LookupAny
	"kyc/storage" // storage.Sign, URL
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func applicantStatus(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	applicant := r.PathValue("id")
	found := cases.LookupAny(r.Context(), applicant)
	if found == nil {
		http.Error(rw, "no such applicant", http.StatusNotFound)
		return
	}
	documents := []map[string]any{}
	for _, d := range found.Documents {
		documents = append(documents, map[string]any{"type": d.Type, "url": storage.URL(d.Ref)})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"applicant": applicant,
		"case_id":   found.CaseID,
		"status":    found.Status,
		"reasons":   found.Reasons,
		"documents": documents,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/applicants/{id}/status", applicantStatus)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"kyc/cases"   // cases.Lookup, LookupAny
	"kyc/storage" // storage.Sign, URL
)

const linkTTLS = 300

// publicReasons are the vendor codes a customer may see, in the app's words; every other code stays inside.
var publicReasons = map[string]string{
	"DOC_EXPIRED":    "document_expired",
	"DOC_UNREADABLE": "document_unreadable",
	"FACE_MISMATCH":  "selfie_mismatch",
	"DATA_MISMATCH":  "details_mismatch",
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func applicantStatus(rw http.ResponseWriter, r *http.Request) {
	applicant := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	// Scoped to the caller: another tenant's applicant is as absent as one nobody has.
	var found *cases.Case
	if tenant != "" {
		found = cases.Lookup(r.Context(), tenant, applicant)
	}
	if found == nil {
		http.Error(rw, "no such applicant", http.StatusNotFound)
		return
	}
	reasons := []string{}
	for _, code := range found.Reasons {
		if public, ok := publicReasons[code]; ok {
			reasons = append(reasons, public)
		}
	}
	documents := []map[string]any{}
	for _, d := range found.Documents {
		link := storage.Sign(r.Context(), d.Ref, linkTTLS)
		documents = append(documents, map[string]any{"type": d.Type, "url": link.URL, "expires_at": link.ExpiresAt})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"applicant":       applicant,
		"case_id":         found.CaseID,
		"status":          found.Status,
		"reasons":         reasons,
		"degraded":        found.Degraded,
		"awaiting_review": found.Status == "manual_review",
		"documents":       documents,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/applicants/{id}/status", applicantStatus)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import kyc.{Cases, Storage} // Cases.lookup/lookupAny, Storage.sign/url

object Read {
  val route: Route = path("v1" / "applicants" / Segment / "status") { applicant =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Cases.lookupAny(applicant) match {
        case None => complete(StatusCodes.NotFound -> "no such applicant")
        case Some(found) =>
          val body = JsObject(
            "applicant" -> JsString(applicant),
            "case_id" -> JsString(found.caseId),
            "status" -> JsString(found.status),
            "reasons" -> JsArray(found.reasons.map(JsString(_)).toVector),
            "documents" -> JsArray(found.documents.map(d => JsObject("type" -> JsString(d.documentType), "url" -> JsString(Storage.url(d.ref)))).toVector))
          complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import kyc.{Cases, Storage} // Cases.lookup/lookupAny, Storage.sign/url

object Read {
  val LinkTtlS = 300L
  // The vendor codes a customer may see, in the app's words; every other code stays inside.
  val PublicReasons: Map[String, String] = Map(
    "DOC_EXPIRED" -> "document_expired",
    "DOC_UNREADABLE" -> "document_unreadable",
    "FACE_MISMATCH" -> "selfie_mismatch",
    "DATA_MISMATCH" -> "details_mismatch")

  val route: Route = path("v1" / "applicants" / Segment / "status") { applicant =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        val tenant = header.getOrElse("")
        // Scoped to the caller: another tenant's applicant is as absent as one nobody has.
        (if (tenant.isEmpty) None else Cases.lookup(tenant, applicant)) match {
          case None => complete(StatusCodes.NotFound -> "no such applicant")
          case Some(found) =>
            val documents = found.documents.map { d =>
              val link = Storage.sign(d.ref, LinkTtlS)
              JsObject("type" -> JsString(d.documentType), "url" -> JsString(link.url), "expires_at" -> JsNumber(link.expiresAt))
            }
            val body = JsObject(
              "applicant" -> JsString(applicant),
              "case_id" -> JsString(found.caseId),
              "status" -> JsString(found.status),
              "reasons" -> JsArray(found.reasons.flatMap(code => PublicReasons.get(code)).map(JsString(_)).toVector),
              "degraded" -> JsBoolean(found.degraded),
              "awaiting_review" -> JsBoolean(found.status == "manual_review"),
              "documents" -> JsArray(documents.toVector))
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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

#include "kyc/cases.h"    // cases::lookup, lookupAny
#include "kyc/storage.h"  // storage::sign, url

using json = nlohmann::json;

void applicant_status(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string applicant = req.matches[1];
  const auto found = cases::lookupAny(applicant);
  if (!found) {
    res.status = 404;
    res.set_content("no such applicant", "text/plain");
    return;
  }
  json documents = json::array();
  for (const cases::Document& d : found->documents) documents.push_back({{"type", d.type}, {"url", storage::url(d.ref)}});
  const json body = {{"applicant", applicant}, {"case_id", found->case_id}, {"status", found->status}, {"reasons", found->reasons}, {"documents", documents}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/applicants/([\\w-]+)/status)", applicant_status); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "kyc/cases.h"    // cases::lookup, lookupAny
#include "kyc/storage.h"  // storage::sign, url

using json = nlohmann::json;

constexpr long kLinkTtlS = 300;
// The vendor codes a customer may see, in the app's words; every other code stays inside.
const std::map<std::string, std::string> kPublicReasons = {
    {"DOC_EXPIRED", "document_expired"},
    {"DOC_UNREADABLE", "document_unreadable"},
    {"FACE_MISMATCH", "selfie_mismatch"},
    {"DATA_MISMATCH", "details_mismatch"},
};

void applicant_status(const httplib::Request& req, httplib::Response& res) {
  const std::string applicant = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  // Scoped to the caller: another tenant's applicant is as absent as one nobody has.
  const std::optional<cases::Case> found = tenant.empty() ? std::nullopt : cases::lookup(tenant, applicant);
  if (!found) {
    res.status = 404;
    res.set_content("no such applicant", "text/plain");
    return;
  }
  std::vector<std::string> reasons;
  for (const std::string& code : found->reasons) {
    const auto public_code = kPublicReasons.find(code);
    if (public_code != kPublicReasons.end()) reasons.push_back(public_code->second);
  }
  json documents = json::array();
  for (const cases::Document& d : found->documents) {
    const storage::Link link = storage::sign(d.ref, kLinkTtlS);
    documents.push_back({{"type", d.type}, {"url", link.url}, {"expires_at", link.expires_at}});
  }
  const json body = {{"applicant", applicant},
                     {"case_id", found->case_id},
                     {"status", found->status},
                     {"reasons", reasons},
                     {"degraded", found->degraded},
                     {"awaiting_review", found->status == "manual_review"},
                     {"documents", documents}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/applicants/([\\w-]+)/status)", applicant_status); }
`,
    },
  },
  harness: {
    python: `from kyc import cases, storage

DOCS = [
    {"type": "passport", "ref": "documents/t-a/passport-1.jpg", "digest": "sha256:5e1f0c"},
    {"type": "drivers_license", "ref": "documents/t-a/license-1.jpg", "digest": "sha256:77ab02"},
]


def _open(tenant, applicant, status=None, reasons=(), degraded=False):
    case_id = cases.create(cases.new_id(), tenant, applicant, DOCS)["case_id"]
    if status is not None:
        cases.decide(case_id, status, list(reasons), degraded)
    return case_id


def _api(ctx):
    for d in DOCS:
        storage.put(d["ref"], "<scan>", d["digest"])
    return ctx.client(ctx.load("read").app)


async def _status(c, applicant, tenant="t-a"):
    return await c.get(f"/v1/applicants/{applicant}/status", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route(ctx):
    case_id = _open("t-a", "a-1", "approved")
    async with _api(ctx) as c:
        r = await _status(c, "a-1")
    assert r.status_code == 200, f"GET /v1/applicants/a-1/status answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "approved" and body.get("case_id") == case_id, f"the read must answer a-1's case {case_id} as approved, got {body}"


async def check_tenant_scope(ctx):
    mine = _open("t-a", "a-1", "approved")
    theirs = _open("t-b", "a-1", "rejected", ["DOC_EXPIRED"])
    foreign_case = _open("t-b", "a-9", "approved")
    async with _api(ctx) as c:
        foreign = await _status(c, "a-9")
        assert foreign.status_code == 404, f"tenant t-a reading t-b's applicant a-9 answered {foreign.status_code}: {foreign.text}. Another tenant's applicant is 404"
        shared = await _status(c, "a-1")
        assert shared.status_code == 200 and shared.json().get("case_id") == mine, f"a-1 exists in t-a ({mine}) and in t-b; t-a was answered {shared.text}: look the case up under the caller's tenant"
        for applicant, case_id in (("a-9", foreign_case), ("a-1", theirs)):
            anonymous = await _status(c, applicant, tenant=None)
            assert anonymous.status_code != 200 and case_id not in anonymous.text, f"a read of {applicant} without X-Tenant-Id answered {anonymous.status_code}: {anonymous.text}. Without a tenant there is no case to show"


async def check_public_reasons(ctx):
    _open("t-a", "a-1", "rejected", ["DOC_EXPIRED", "WATCHLIST_FUZZY_47", "SANCTIONS_LIST_3", "FACE_MISMATCH"])
    async with _api(ctx) as c:
        r = await _status(c, "a-1")
    assert "WATCHLIST" not in r.text, f"the response carries the vendor's watchlist code: {r.text}. Map codes through PUBLIC_REASONS and drop the rest"
    assert r.json().get("reasons") == ["document_expired", "selfie_mismatch"], f"stored DOC_EXPIRED, WATCHLIST_FUZZY_47, SANCTIONS_LIST_3 and FACE_MISMATCH must go out as the public codes ['document_expired', 'selfie_mismatch'], got {r.json().get('reasons')}: a code PUBLIC_REASONS does not list stays inside"


async def check_signed_link(ctx):
    _open("t-a", "a-1", "approved")
    async with _api(ctx) as c:
        r = await _status(c, "a-1")
    documents = r.json().get("documents") or []
    assert len(documents) == 2, f"the response must list both documents, got {documents}"
    assert f"{storage.BASE}/o/" not in r.text, f"the response carries a permanent storage url: {r.text}. Hand out only the signed links"
    now = int(ctx.clock.time())
    for d, want in zip(documents, DOCS):
        assert storage.resolve(d.get("url", "")) == want["ref"], f"the link {d.get('url')!r} does not open {want['ref']}"
    ctx.clock.advance(299)
    for d, want in zip(documents, DOCS):
        assert storage.resolve(d["url"]) == want["ref"], f"299 s after the read the link {d['url']!r} no longer opens {want['ref']}: links last LINK_TTL_S = 300 s"
    ctx.clock.advance(2)
    still = [d["url"] for d in documents if storage.resolve(d["url"]) is not None]
    assert not still, f"301 s later {still} still open the scans: hand out storage.sign links that expire, not the permanent url"
    for d in documents:
        assert isinstance(d.get("expires_at"), int) and abs(d["expires_at"] - (now + 300)) <= 2, f"expires_at must be 300 s from the read ({now + 300}), got {d.get('expires_at')!r}"


async def check_review_flags(ctx):
    _open("t-a", "a-1", "manual_review", [], True)
    _open("t-a", "a-2", "approved")
    _open("t-a", "a-3", "manual_review", ["FACE_MISMATCH"], False)
    _open("t-a", "a-4", "rejected", ["DOC_EXPIRED"], False)
    async with _api(ctx) as c:
        waiting = (await _status(c, "a-1")).json()
        done = (await _status(c, "a-2")).json()
        asked = (await _status(c, "a-3")).json()
        rejected = (await _status(c, "a-4")).json()
    assert waiting.get("degraded") is True and waiting.get("awaiting_review") is True, f"a case in manual review after a vendor failure must say degraded and awaiting_review, got {waiting}"
    assert done.get("degraded") is False and done.get("awaiting_review") is False, f"an approved case must say degraded false and awaiting_review false, got {done}"
    assert asked.get("degraded") is False and asked.get("awaiting_review") is True, f"a case the vendor itself sent to manual review must say degraded false (the case's own flag) and awaiting_review true, got {asked}"
    assert rejected.get("degraded") is False and rejected.get("awaiting_review") is False, f"a rejected case is decided: it must say degraded false and awaiting_review false, got {rejected}"
`,
    typescript: `const DOCS = [
  {type: 'passport', ref: 'documents/t-a/passport-1.jpg', digest: 'sha256:5e1f0c'},
  {type: 'drivers_license', ref: 'documents/t-a/license-1.jpg', digest: 'sha256:77ab02'},
];

async function setup(ctx) {
  const cases = ctx.load('/support/kyc/cases.ts');
  const storage = ctx.load('/support/kyc/storage.ts');
  for (const d of DOCS) await storage.put(d.ref, '<scan>', d.digest);
  const open = async (tenant: string, applicant: string, status: string | null = null, reasons: string[] = [], degraded = false): Promise<string> => {
    const caseId = (await cases.create(await cases.newId(), tenant, applicant, DOCS)).case_id;
    if (status !== null) await cases.decide(caseId, status, reasons, degraded);
    return caseId;
  };
  return {c: ctx.client(ctx.load('read').app), storage, open};
}

const status = (c, applicant: string, tenant: string | null = 't-a') =>
  c.get(\`/v1/applicants/\${applicant}/status\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const {c, open} = await setup(ctx);
  const caseId = await open('t-a', 'a-1', 'approved');
  const r = await status(c, 'a-1');
  assert.equal(r.status, 200, \`GET /v1/applicants/a-1/status answered \${r.status}: \${r.text}\`);
  assert(r.json().status === 'approved' && r.json().case_id === caseId, \`the read must answer a-1's case \${caseId} as approved, got \${r.text}\`);
}

export async function check_tenant_scope(ctx) {
  const {c, open} = await setup(ctx);
  const mine = await open('t-a', 'a-1', 'approved');
  const theirs = await open('t-b', 'a-1', 'rejected', ['DOC_EXPIRED']);
  const foreignCase = await open('t-b', 'a-9', 'approved');
  const foreign = await status(c, 'a-9');
  assert.equal(foreign.status, 404, \`tenant t-a reading t-b's applicant a-9 answered \${foreign.status}: \${foreign.text}. Another tenant's applicant is 404\`);
  const shared = await status(c, 'a-1');
  assert(shared.status === 200 && shared.json().case_id === mine, \`a-1 exists in t-a (\${mine}) and in t-b; t-a was answered \${shared.text}: look the case up under the caller's tenant\`);
  for (const [applicant, caseId] of [['a-9', foreignCase], ['a-1', theirs]]) {
    const anonymous = await status(c, applicant, null);
    assert(anonymous.status !== 200 && !anonymous.text.includes(caseId), \`a read of \${applicant} without X-Tenant-Id answered \${anonymous.status}: \${anonymous.text}. Without a tenant there is no case to show\`);
  }
}

export async function check_public_reasons(ctx) {
  const {c, open} = await setup(ctx);
  await open('t-a', 'a-1', 'rejected', ['DOC_EXPIRED', 'WATCHLIST_FUZZY_47', 'SANCTIONS_LIST_3', 'FACE_MISMATCH']);
  const r = await status(c, 'a-1');
  assert(!r.text.includes('WATCHLIST'), \`the response carries the vendor's watchlist code: \${r.text}. Map codes through PUBLIC_REASONS and drop the rest\`);
  assert.deepStrictEqual(r.json().reasons, ['document_expired', 'selfie_mismatch'], \`stored DOC_EXPIRED, WATCHLIST_FUZZY_47, SANCTIONS_LIST_3 and FACE_MISMATCH must go out as the public codes ["document_expired","selfie_mismatch"], got \${JSON.stringify(r.json().reasons)}: a code PUBLIC_REASONS does not list stays inside\`);
}

export async function check_signed_link(ctx) {
  const {c, storage, open} = await setup(ctx);
  await open('t-a', 'a-1', 'approved');
  const r = await status(c, 'a-1');
  const documents = r.json().documents ?? [];
  assert.equal(documents.length, 2, \`the response must list both documents, got \${r.text}\`);
  assert(!r.text.includes(\`\${storage.BASE}/o/\`), \`the response carries a permanent storage url: \${r.text}. Hand out only the signed links\`);
  const now = Math.floor(ctx.clock.now() / 1000);
  for (const [i, d] of documents.entries()) {
    assert.equal(await storage.resolve(d.url ?? ''), DOCS[i].ref, \`the link \${d.url} does not open \${DOCS[i].ref}\`);
  }
  ctx.clock.advance(299);
  for (const [i, d] of documents.entries()) {
    assert.equal(await storage.resolve(d.url), DOCS[i].ref, \`299 s after the read the link \${d.url} no longer opens \${DOCS[i].ref}: links last LINK_TTL_S = 300 s\`);
  }
  ctx.clock.advance(2);
  const still = [];
  for (const d of documents) if ((await storage.resolve(d.url)) !== null) still.push(d.url);
  assert.equal(still.length, 0, \`301 s later \${JSON.stringify(still)} still open the scans: hand out storage.sign links that expire, not the permanent url\`);
  for (const d of documents) {
    assert(typeof d.expires_at === 'number' && Math.abs(d.expires_at - (now + 300)) <= 2, \`expires_at must be 300 s from the read (\${now + 300}), got \${d.expires_at}\`);
  }
}

export async function check_review_flags(ctx) {
  const {c, open} = await setup(ctx);
  await open('t-a', 'a-1', 'manual_review', [], true);
  await open('t-a', 'a-2', 'approved');
  await open('t-a', 'a-3', 'manual_review', ['FACE_MISMATCH'], false);
  await open('t-a', 'a-4', 'rejected', ['DOC_EXPIRED'], false);
  const waiting = (await status(c, 'a-1')).json();
  const done = (await status(c, 'a-2')).json();
  const asked = (await status(c, 'a-3')).json();
  const rejected = (await status(c, 'a-4')).json();
  assert(waiting.degraded === true && waiting.awaiting_review === true, \`a case in manual review after a vendor failure must say degraded and awaiting_review, got \${JSON.stringify(waiting)}\`);
  assert(done.degraded === false && done.awaiting_review === false, \`an approved case must say degraded false and awaiting_review false, got \${JSON.stringify(done)}\`);
  assert(asked.degraded === false && asked.awaiting_review === true, \`a case the vendor itself sent to manual review must say degraded false (the case's own flag) and awaiting_review true, got \${JSON.stringify(asked)}\`);
  assert(rejected.degraded === false && rejected.awaiting_review === false, \`a rejected case is decided: it must say degraded false and awaiting_review false, got \${JSON.stringify(rejected)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"kyc/cases"
	"kyc/storage"

	"leetbuild/harness"
)

var (
	hReadBg = context.Background()
	hDocs   = []cases.Document{
		{Type: "passport", Ref: "documents/t-a/passport-1.jpg", Digest: "sha256:5e1f0c"},
		{Type: "drivers_license", Ref: "documents/t-a/license-1.jpg", Digest: "sha256:77ab02"},
	}
)

type hStatusBody struct {
	CaseID         string   \`json:"case_id"\`
	Status         string   \`json:"status"\`
	Reasons        []string \`json:"reasons"\`
	Degraded       *bool    \`json:"degraded"\`
	AwaitingReview *bool    \`json:"awaiting_review"\`
	Documents      []struct {
		Type      string \`json:"type"\`
		URL       string \`json:"url"\`
		ExpiresAt int64  \`json:"expires_at"\`
	} \`json:"documents"\`
}

// hFlags reports whether the body says degraded and awaiting_review exactly as wanted (both present).
func (b hStatusBody) hFlags(degraded, awaiting bool) bool {
	return b.Degraded != nil && *b.Degraded == degraded && b.AwaitingReview != nil && *b.AwaitingReview == awaiting
}

func hAPI(ctx *harness.Ctx) *harness.HTTP {
	for _, d := range hDocs {
		storage.Put(hReadBg, d.Ref, "<scan>", d.Digest)
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func hOpenCase(tenant, applicant, status string, reasons []string, degraded bool) string {
	caseID := cases.Create(hReadBg, cases.NewID(hReadBg), tenant, applicant, hDocs).CaseID
	if status != "" {
		cases.Decide(hReadBg, caseID, status, reasons, degraded)
	}
	return caseID
}

func hReadAs(c *harness.HTTP, tenant, applicant string) (*harness.Response, hStatusBody) {
	path := "/v1/applicants/" + applicant + "/status"
	var r *harness.Response
	if tenant == "" {
		r = c.Get(path)
	} else {
		r = c.Get(path, "X-Tenant-Id", tenant)
	}
	var body hStatusBody
	if r.Status == 200 {
		r.Decode(&body)
	}
	return r, body
}

func CheckRoute(ctx *harness.Ctx) {
	caseID := hOpenCase("t-a", "a-1", "approved", nil, false)
	r, body := hReadAs(hAPI(ctx), "t-a", "a-1")
	ctx.Equal(r.Status, 200, "GET /v1/applicants/a-1/status (%s)", r.Text())
	ctx.Assert(body.Status == "approved" && body.CaseID == caseID, "the read must answer a-1's case %s as approved, got %s", caseID, r.Text())
}

func CheckTenantScope(ctx *harness.Ctx) {
	mine := hOpenCase("t-a", "a-1", "approved", nil, false)
	theirs := hOpenCase("t-b", "a-1", "rejected", []string{"DOC_EXPIRED"}, false)
	foreignCase := hOpenCase("t-b", "a-9", "approved", nil, false)
	c := hAPI(ctx)
	foreign, _ := hReadAs(c, "t-a", "a-9")
	ctx.Equal(foreign.Status, 404, "tenant t-a reading t-b's applicant a-9 (%s): another tenant's applicant is 404", foreign.Text())
	shared, body := hReadAs(c, "t-a", "a-1")
	ctx.Assert(shared.Status == 200 && body.CaseID == mine, "a-1 exists in t-a (%s) and in t-b; t-a was answered %s: look the case up under the caller's tenant", mine, shared.Text())
	for _, read := range [][2]string{{"a-9", foreignCase}, {"a-1", theirs}} {
		anonymous, _ := hReadAs(c, "", read[0])
		ctx.Assert(anonymous.Status != 200 && !strings.Contains(anonymous.Text(), read[1]), "a read of %s without X-Tenant-Id answered %d: %s. Without a tenant there is no case to show", read[0], anonymous.Status, anonymous.Text())
	}
}

func CheckPublicReasons(ctx *harness.Ctx) {
	hOpenCase("t-a", "a-1", "rejected", []string{"DOC_EXPIRED", "WATCHLIST_FUZZY_47", "SANCTIONS_LIST_3", "FACE_MISMATCH"}, false)
	r, body := hReadAs(hAPI(ctx), "t-a", "a-1")
	ctx.Assert(!strings.Contains(r.Text(), "WATCHLIST"), "the response carries the vendor's watchlist code: %s. Map codes through publicReasons and drop the rest", r.Text())
	ctx.Equal(body.Reasons, []string{"document_expired", "selfie_mismatch"}, "stored DOC_EXPIRED, WATCHLIST_FUZZY_47, SANCTIONS_LIST_3 and FACE_MISMATCH must go out as the public codes (a code publicReasons does not list stays inside)")
}

func CheckSignedLink(ctx *harness.Ctx) {
	hOpenCase("t-a", "a-1", "approved", nil, false)
	r, body := hReadAs(hAPI(ctx), "t-a", "a-1")
	ctx.Equal(len(body.Documents), 2, "the response must list both documents (%s)", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), storage.Base+"/o/"), "the response carries a permanent storage URL: %s. Hand out only the signed links", r.Text())
	now := ctx.Clock.Now() / 1000
	for i, d := range body.Documents {
		ref, ok := storage.Resolve(hReadBg, d.URL)
		ctx.Assert(ok && ref == hDocs[i].Ref, "the link %q does not open %s", d.URL, hDocs[i].Ref)
	}
	ctx.Clock.Advance(299)
	for i, d := range body.Documents {
		ref, ok := storage.Resolve(hReadBg, d.URL)
		ctx.Assert(ok && ref == hDocs[i].Ref, "299 s after the read the link %q no longer opens %s: links last linkTTLS = 300 s", d.URL, hDocs[i].Ref)
	}
	ctx.Clock.Advance(2)
	for _, d := range body.Documents {
		_, ok := storage.Resolve(hReadBg, d.URL)
		ctx.Assert(!ok, "301 s later %s still opens the scan: hand out storage.Sign links that expire, not the permanent URL", d.URL)
	}
	for _, d := range body.Documents {
		ctx.Assert(d.ExpiresAt >= now+298 && d.ExpiresAt <= now+302, "expires_at must be 300 s from the read (%d), got %d", now+300, d.ExpiresAt)
	}
}

func CheckReviewFlags(ctx *harness.Ctx) {
	hOpenCase("t-a", "a-1", "manual_review", nil, true)
	hOpenCase("t-a", "a-2", "approved", nil, false)
	hOpenCase("t-a", "a-3", "manual_review", []string{"FACE_MISMATCH"}, false)
	hOpenCase("t-a", "a-4", "rejected", []string{"DOC_EXPIRED"}, false)
	c := hAPI(ctx)
	rw, waiting := hReadAs(c, "t-a", "a-1")
	rd, done := hReadAs(c, "t-a", "a-2")
	ra, asked := hReadAs(c, "t-a", "a-3")
	rr, rejected := hReadAs(c, "t-a", "a-4")
	ctx.Assert(waiting.hFlags(true, true), "a case in manual review after a vendor failure must say degraded and awaiting_review, got %s", rw.Text())
	ctx.Assert(done.hFlags(false, false), "an approved case must say degraded false and awaiting_review false, got %s", rd.Text())
	ctx.Assert(asked.hFlags(false, true), "a case the vendor itself sent to manual review must say degraded false (the case's own flag) and awaiting_review true, got %s", ra.Text())
	ctx.Assert(rejected.hFlags(false, false), "a rejected case is decided: it must say degraded false and awaiting_review false, got %s", rr.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

#include "kyc/cases.h"
#include "kyc/storage.h"

namespace {

using HJson = nlohmann::json;

const std::vector<cases::Document> hDocs = {{"passport", "documents/t-a/passport-1.jpg", "sha256:5e1f0c"},
                                            {"drivers_license", "documents/t-a/license-1.jpg", "sha256:77ab02"}};

harness::HTTP hApi(harness::Ctx& ctx) {
  for (const cases::Document& d : hDocs) storage::put(d.ref, "<scan>", d.digest);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string hOpenCase(const std::string& tenant, const std::string& applicant, const std::string& status, const std::vector<std::string>& reasons, bool degraded) {
  const std::string case_id = cases::create(cases::newId(), tenant, applicant, hDocs).case_id;
  if (!status.empty()) cases::decide(case_id, status, reasons, degraded);
  return case_id;
}

harness::Response hReadAs(harness::HTTP& c, const std::string& tenant, const std::string& applicant) {
  if (tenant.empty()) return c.Get("/v1/applicants/" + applicant + "/status");
  return c.Get("/v1/applicants/" + applicant + "/status", "X-Tenant-Id", tenant);
}

HJson hBodyOf(const harness::Response& r) { return r.Status == 200 ? HJson::parse(r.Text(), nullptr, false) : HJson::object(); }

// Whether the body says degraded and awaiting_review exactly as wanted (both present, both booleans).
bool hFlags(const HJson& b, bool degraded, bool awaiting) {
  return b.is_object() && b.contains("degraded") && b["degraded"].is_boolean() && b["degraded"].get<bool>() == degraded && b.contains("awaiting_review") &&
         b["awaiting_review"].is_boolean() && b["awaiting_review"].get<bool>() == awaiting;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string case_id = hOpenCase("t-a", "a-1", "approved", {}, false);
  auto c = hApi(ctx);
  const auto r = hReadAs(c, "t-a", "a-1");
  ctx.Equal(r.Status, 200, "GET /v1/applicants/a-1/status (%s)", r.Text());
  const HJson body = hBodyOf(r);
  ctx.Assert(body.value("status", "") == "approved" && body.value("case_id", "") == case_id, "the read must answer a-1's case %s as approved, got %s", case_id, r.Text());
}

void CheckTenantScope(harness::Ctx& ctx) {
  const std::string mine = hOpenCase("t-a", "a-1", "approved", {}, false);
  const std::string theirs = hOpenCase("t-b", "a-1", "rejected", {"DOC_EXPIRED"}, false);
  const std::string foreignCase = hOpenCase("t-b", "a-9", "approved", {}, false);
  auto c = hApi(ctx);
  const auto foreign = hReadAs(c, "t-a", "a-9");
  ctx.Equal(foreign.Status, 404, "tenant t-a reading t-b's applicant a-9 (%s): another tenant's applicant is 404", foreign.Text());
  const auto shared = hReadAs(c, "t-a", "a-1");
  ctx.Assert(shared.Status == 200 && hBodyOf(shared).value("case_id", "") == mine, "a-1 exists in t-a (%s) and in t-b; t-a was answered %s: look the case up under the caller's tenant", mine, shared.Text());
  for (const auto& [applicant, case_id] : std::vector<std::pair<std::string, std::string>>{{"a-9", foreignCase}, {"a-1", theirs}}) {
    const auto anonymous = hReadAs(c, "", applicant);
    ctx.Assert(anonymous.Status != 200 && anonymous.Text().find(case_id) == std::string::npos, "a read of %s without X-Tenant-Id answered %d: %s. Without a tenant there is no case to show", applicant, anonymous.Status, anonymous.Text());
  }
}

void CheckPublicReasons(harness::Ctx& ctx) {
  hOpenCase("t-a", "a-1", "rejected", {"DOC_EXPIRED", "WATCHLIST_FUZZY_47", "SANCTIONS_LIST_3", "FACE_MISMATCH"}, false);
  auto c = hApi(ctx);
  const auto r = hReadAs(c, "t-a", "a-1");
  ctx.Assert(r.Text().find("WATCHLIST") == std::string::npos, "the response carries the vendor's watchlist code: %s. Map codes through kPublicReasons and drop the rest", r.Text());
  ctx.Assert(hBodyOf(r).value("reasons", HJson::array()) == HJson::array({"document_expired", "selfie_mismatch"}),
             "stored DOC_EXPIRED, WATCHLIST_FUZZY_47, SANCTIONS_LIST_3 and FACE_MISMATCH must go out as the public codes [document_expired, selfie_mismatch], got %s: a code kPublicReasons does not list stays inside", r.Text());
}

void CheckSignedLink(harness::Ctx& ctx) {
  hOpenCase("t-a", "a-1", "approved", {}, false);
  auto c = hApi(ctx);
  const auto r = hReadAs(c, "t-a", "a-1");
  const HJson documents = hBodyOf(r).value("documents", HJson::array());
  ctx.Equal(documents.size(), 2, "the response must list both documents (%s)", r.Text());
  ctx.Assert(r.Text().find(storage::kBase + "/o/") == std::string::npos, "the response carries a permanent storage url: %s. Hand out only the signed links", r.Text());
  const long long now = ctx.Clock.Now() / 1000;
  for (size_t i = 0; i < documents.size(); i++) {
    const std::string url = documents[i].value("url", "");
    ctx.Assert(storage::resolve(url).value_or("") == hDocs[i].ref, "the link %q does not open %s", url, hDocs[i].ref);
  }
  ctx.Clock.Advance(299);
  for (size_t i = 0; i < documents.size(); i++) {
    const std::string url = documents[i].value("url", "");
    ctx.Assert(storage::resolve(url).value_or("") == hDocs[i].ref, "299 s after the read the link %q no longer opens %s: links last kLinkTtlS = 300 s", url, hDocs[i].ref);
  }
  ctx.Clock.Advance(2);
  for (const HJson& d : documents) {
    ctx.Assert(!storage::resolve(d.value("url", "")), "301 s later %s still opens the scan: hand out storage::sign links that expire, not the permanent url", d.value("url", ""));
  }
  for (const HJson& d : documents) {
    const long long expires_at = d.value("expires_at", 0LL);
    ctx.Assert(std::llabs(expires_at - (now + 300)) <= 2, "expires_at must be 300 s from the read (%d), got %d", now + 300, expires_at);
  }
}

void CheckReviewFlags(harness::Ctx& ctx) {
  hOpenCase("t-a", "a-1", "manual_review", {}, true);
  hOpenCase("t-a", "a-2", "approved", {}, false);
  hOpenCase("t-a", "a-3", "manual_review", {"FACE_MISMATCH"}, false);
  hOpenCase("t-a", "a-4", "rejected", {"DOC_EXPIRED"}, false);
  auto c = hApi(ctx);
  const auto rw = hReadAs(c, "t-a", "a-1");
  const auto rd = hReadAs(c, "t-a", "a-2");
  const auto ra = hReadAs(c, "t-a", "a-3");
  const auto rr = hReadAs(c, "t-a", "a-4");
  ctx.Assert(hFlags(hBodyOf(rw), true, true), "a case in manual review after a vendor failure must say degraded and awaiting_review, got %s", rw.Text());
  ctx.Assert(hFlags(hBodyOf(rd), false, false), "an approved case must say degraded false and awaiting_review false, got %s", rd.Text());
  ctx.Assert(hFlags(hBodyOf(ra), false, true), "a case the vendor itself sent to manual review must say degraded false (the case's own flag) and awaiting_review true, got %s", ra.Text());
  ctx.Assert(hFlags(hBodyOf(rr), false, false), "a rejected case is decided: it must say degraded false and awaiting_review false, got %s", rr.Text());
}
`,
  },
  hints: [
    'Read an applicant reference another tenant uses and you get their case. A rejection shows the vendor’s watchlist code, and a document URL from last week still opens the passport scan.',
    '`lookup_any` searches every tenant; the stored codes go out unmapped; `storage.url` is the object’s permanent address; and the body has no field that says a person is still deciding.',
    'Use `cases.lookup(tenant, applicant_id)` (404 when None), map `reasons` through `PUBLIC_REASONS` dropping the rest, sign each ref with `storage.sign(ref, LINK_TTL_S)`, and add `degraded` and `awaiting_review`.',
  ],
  debrief: `Every field of this read is a decision about who may see what. The tenant scope is in the lookup, not a filter after it, so a foreign applicant is the same 404 as an absent one and the response cannot confirm someone exists. Public reasons are an allowlist because the vendor's vocabulary grows, and a new internal code must stay inside by default. Signed links bound how long a leaked URL works; five minutes covers a page view. Production systems also log every signed link with the caller who asked for it, shorten the TTL for support staff, and return \`Cache-Control: no-store\` so the status of an identity check never lands in a shared cache.`,
};
