import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/moderation/items/{id}: the case file, scoped',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['api', 'db', 'console'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/moderation/items/{case_id}\`, the case file a
moderator's console opens: it reads the tenant from \`X-Tenant-Id\` (missing is **401**), loads the
case (\`store.get_case\`, **404** when there is none) and answers its status, reason, report count,
the actions persisted on its content (\`store.actions_of\`), a link to the content, the reporter's id
and the report's detail as stored. It serves the demo and hides four flaws.

**Failure mode the checks target.** Another tenant reads a case by guessing its id; every moderator
who opens a case learns who reported it; a detail holding markup runs in the console; and a detail
of 5,000 characters fills every view.

- A case whose tenant is not the caller's answers exactly as a missing one, **404**.
- \`reporter_id\` is in the body only when \`X-Reviewer-Role\` is \`SURVEYOR_ROLE\` (\`surveyor\`);
  otherwise the field is absent.
- The detail is cut to its first \`MAX_DETAIL_CHARS\` = **280** characters, then HTML-escaped (\`&\`,
  \`<\`, \`>\`, quotes), so the cut never splits an entity.`,
  sequence: {
    participants: ['Moderator console', 'Moderation API', 'case store'],
    messages: [
      {
        from: 'Moderator console',
        to: 'Moderation API',
        label: 'GET /v1/moderation/items/{id} · X-Tenant-Id · X-Reviewer-Role',
        kind: 'sync',
      },
      {from: 'Moderation API', to: 'case store', label: 'get_case(id) · actions_of(content_id)', kind: 'sync'},
      {from: 'Moderation API', to: 'Moderation API', label: 'case tenant == caller? else 404', kind: 'sync'},
      {
        from: 'Moderation API',
        to: 'Moderation API',
        label: 'detail: first 280 characters, then escaped · reporter_id for surveyors',
        kind: 'sync',
      },
      {from: 'Moderation API', to: 'Moderator console', label: '200 {status, actions, links, detail}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/moderation/items/{id}',
      detail:
        'The case file answers the case’s status and the actions persisted on its content; a missing tenant is **401** and an unknown case **404**.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/moderation\/items\//]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/moderation\/items\//]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/moderation\/items\//]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"moderation"\s*\/\s*"items"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/v1\/moderation\/items\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Hides a case that belongs to another tenant',
      detail:
        'The case’s tenant is compared with the caller’s and a mismatch answers exactly as a missing case (**404**); the starter serves any case by id.',
      match: {
        python: {all: [/\[["']tenant["']\]\s*!=\s*tenant\b|\btenant\s*!=\s*\w+\[["']tenant["']\]/]},
        typescript: {all: [/\.tenant\s*!==?\s*tenant\b|\btenant\s*!==?\s*\w+\.tenant\b/]},
        go: {all: [/\.Tenant\s*!=\s*tenant\b|\btenant\s*!=\s*\w+\.Tenant\b/]},
        scala: {all: [/\.tenant\s*!=\s*tenant\b|\.tenant\s*==\s*tenant\b/]},
        cpp: {all: [/(->|\.)tenant\s*!=\s*tenant\b|\btenant\s*!=\s*\w+(->|\.)tenant\b/]},
      },
    },
    {
      id: 'surveyor-only',
      title: 'Shows the reporter only to the surveyor role',
      detail:
        '`reporter_id` is added to the body only when the caller’s role equals `SURVEYOR_ROLE`; a moderator, a caller with no role, `not-surveyor` and `surveyor-trainee` do not see it. The starter puts it in every answer.',
      match: {
        python: {all: [/SURVEYOR_ROLE\s*=\s*["']surveyor["']/, /==\s*SURVEYOR_ROLE|SURVEYOR_ROLE\s*==/]},
        typescript: {all: [/SURVEYOR_ROLE\s*=\s*['"]surveyor['"]/, /===?\s*SURVEYOR_ROLE|SURVEYOR_ROLE\s*===?/]},
        go: {all: [/surveyorRole\s*=\s*"surveyor"/, /==\s*surveyorRole|surveyorRole\s*==/]},
        scala: {all: [/SurveyorRole\s*=\s*"surveyor"/, /==\s*SurveyorRole|SurveyorRole\s*==|contains\(SurveyorRole\)/]},
        cpp: {all: [/kSurveyorRole\s*=\s*"surveyor"/, /==\s*kSurveyorRole|kSurveyorRole\s*==/]},
      },
    },
    {
      id: 'detail-escaped',
      title: 'Escapes the free-text detail',
      detail:
        'The detail is HTML-escaped before it is returned (`&`, `<`, `>` and both quotes, and it unescapes to what the reporter wrote), so a report cannot plant markup or close an attribute in a moderator’s console; the starter returns it raw.',
      match: {
        python: {all: [/html\.escape\(/]},
        typescript: {all: [/&lt;/]},
        go: {all: [/html\.EscapeString\(/]},
        scala: {all: [/&lt;/]},
        cpp: {all: [/&lt;/]},
      },
    },
    {
      id: 'detail-bounded',
      title: 'Cuts the detail to 280 characters before escaping it',
      detail:
        'The detail is cut to its first `MAX_DETAIL_CHARS` characters (code points: an emoji is one, and 200 `é` come back whole) and then escaped, so a cut cannot split `&lt;`; the starter returns the whole field.',
      match: {
        python: {
          all: [/MAX_DETAIL_CHARS\s*=\s*280\b/, /\[:\s*MAX_DETAIL_CHARS\s*\]/],
          none: [/escape\([^)\n]*\)\s*\[:/],
        },
        typescript: {
          all: [/MAX_DETAIL_CHARS\s*=\s*280\b/, /slice\(0,\s*MAX_DETAIL_CHARS\)/],
          none: [/escapeHtml\([^()\n]*\)\.slice\(/],
        },
        go: {all: [/maxDetailChars\s*=\s*280\b/, /\[:maxDetailChars\]/], none: [/EscapeString\([^)\n]*\)\[:/]},
        scala: {
          all: [
            /MaxDetailChars\s*=\s*280\b/,
            /\(\s*\w+\([^()\n]*,\s*MaxDetailChars\s*\)\s*\)|take\(MaxDetailChars\)|limit\(MaxDetailChars/,
          ],
          none: [/escapeHtml\([^)\n]*\)\.take\(/],
        },
        cpp: {all: [/kMaxDetailChars\s*=\s*280\b/, /\(\s*\w+\([^()\n]*,\s*kMaxDetailChars\s*\)\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from moderation import store  # get_case, actions_of

app = FastAPI()


@app.get("/v1/moderation/items/{case_id}")
def read_case(case_id: str, request: Request) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    case = store.get_case(case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="no such case")
    return {
        "case_id": case["case_id"],
        "content_id": case["content_id"],
        "status": case["status"],
        "reason": case["reason"],
        "reports": case["reports"],
        "actions": store.actions_of(case["content_id"]),
        "links": {"content": f"/v1/content/{case['content_id']}"},
        "reporter_id": case["reporter_id"],
        "detail": case["detail"],
    }
`,
      solution: `import html

from fastapi import FastAPI, HTTPException, Request

from moderation import store  # get_case, actions_of

app = FastAPI()

SURVEYOR_ROLE = "surveyor"
MAX_DETAIL_CHARS = 280


@app.get("/v1/moderation/items/{case_id}")
def read_case(case_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    role = request.headers.get("x-reviewer-role", "")
    case = store.get_case(case_id)
    # Another tenant's case answers exactly as a missing one: a case id is a name, not a permission.
    if case is None or case["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such case")
    body = {
        "case_id": case["case_id"],
        "content_id": case["content_id"],
        "status": case["status"],
        "reason": case["reason"],
        "reports": case["reports"],
        "actions": store.actions_of(case["content_id"]),
        "links": {"content": f"/v1/content/{case['content_id']}"},
        # Cut first, then escape: the cut never lands inside an entity.
        "detail": html.escape(case["detail"][:MAX_DETAIL_CHARS]),
    }
    if role == SURVEYOR_ROLE:
        body["reporter_id"] = case["reporter_id"]
    return body
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {actionsOf, getCase} from 'moderation/store';

export const app = Fastify();

app.get('/v1/moderation/items/:caseId', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {caseId} = request.params as {caseId: string};
  const found = await getCase(caseId);
  if (found === null) return reply.code(404).send({error: 'no such case'});
  return {
    case_id: found.case_id,
    content_id: found.content_id,
    status: found.status,
    reason: found.reason,
    reports: found.reports,
    actions: await actionsOf(found.content_id),
    links: {content: \`/v1/content/\${found.content_id}\`},
    reporter_id: found.reporter_id,
    detail: found.detail,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {actionsOf, getCase} from 'moderation/store';

export const app = Fastify();

export const SURVEYOR_ROLE = 'surveyor';
export const MAX_DETAIL_CHARS = 280;

const ESCAPES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ESCAPES[c]);

app.get('/v1/moderation/items/:caseId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const role = request.headers['x-reviewer-role'];
  const {caseId} = request.params as {caseId: string};
  const found = await getCase(caseId);
  // Another tenant's case answers exactly as a missing one: a case id is a name, not a permission.
  if (found === null || found.tenant !== tenant) return reply.code(404).send({error: 'no such case'});
  const body: Record<string, unknown> = {
    case_id: found.case_id,
    content_id: found.content_id,
    status: found.status,
    reason: found.reason,
    reports: found.reports,
    actions: await actionsOf(found.content_id),
    links: {content: \`/v1/content/\${found.content_id}\`},
    // Cut first (by characters, not UTF-16 units), then escape: the cut never lands inside an entity.
    detail: escapeHtml(Array.from(found.detail).slice(0, MAX_DETAIL_CHARS).join('')),
  };
  if (role === SURVEYOR_ROLE) body.reporter_id = found.reporter_id;
  return body;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"moderation/store" // store.GetCase, ActionsOf
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readCase(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	found := store.GetCase(r.Context(), r.PathValue("id"))
	if found == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such case"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"case_id":     found.CaseID,
		"content_id":  found.ContentID,
		"status":      found.Status,
		"reason":      found.Reason,
		"reports":     found.Reports,
		"actions":     store.ActionsOf(r.Context(), found.ContentID),
		"links":       map[string]string{"content": "/v1/content/" + found.ContentID},
		"reporter_id": found.ReporterID,
		"detail":      found.Detail,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/moderation/items/{id}", readCase)
}
`,
      solution: `package main

import (
	"encoding/json"
	"html"
	"net/http"

	"moderation/store" // store.GetCase, ActionsOf
)

const (
	surveyorRole   = "surveyor"
	maxDetailChars = 280
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readCase(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	found := store.GetCase(r.Context(), r.PathValue("id"))
	// Another tenant's case answers exactly as a missing one: a case id is a name, not a permission.
	if found == nil || found.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such case"})
		return
	}
	// Cut first (by characters, not bytes), then escape: the cut never lands inside an entity.
	detail := []rune(found.Detail)
	if len(detail) > maxDetailChars {
		detail = detail[:maxDetailChars]
	}
	body := map[string]any{
		"case_id":    found.CaseID,
		"content_id": found.ContentID,
		"status":     found.Status,
		"reason":     found.Reason,
		"reports":    found.Reports,
		"actions":    store.ActionsOf(r.Context(), found.ContentID),
		"links":      map[string]string{"content": "/v1/content/" + found.ContentID},
		"detail":     html.EscapeString(string(detail)),
	}
	if r.Header.Get("X-Reviewer-Role") == surveyorRole {
		body["reporter_id"] = found.ReporterID
	}
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/moderation/items/{id}", readCase)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import moderation.Store // Store.getCase, actionsOf

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def caseFile(tenant: String, caseId: String): HttpResponse = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    Store.getCase(caseId) match {
      case None => error(StatusCodes.NotFound, "no such case")
      case Some(found) =>
        json(
          StatusCodes.OK,
          JsObject(
            "case_id" -> JsString(found.caseId),
            "content_id" -> JsString(found.contentId),
            "status" -> JsString(found.status),
            "reason" -> JsString(found.reason),
            "reports" -> JsNumber(found.reports),
            "actions" -> JsArray(Store.actionsOf(found.contentId).toVector),
            "links" -> JsObject("content" -> JsString(s"/v1/content/\${found.contentId}")),
            "reporter_id" -> JsString(found.reporterId),
            "detail" -> JsString(found.detail)))
    }
  }

  val route: Route = path("v1" / "moderation" / "items" / Segment) { caseId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case Some(tenant) if tenant.nonEmpty => complete(caseFile(tenant, caseId))
        case _ => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import moderation.Store // Store.getCase, actionsOf

object Read {
  val SurveyorRole = "surveyor"
  val MaxDetailChars = 280

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def escapeHtml(text: String): String = text.flatMap {
    case '&' => "&amp;"
    case '<' => "&lt;"
    case '>' => "&gt;"
    case '"' => "&quot;"
    case '\\'' => "&#x27;"
    case c => c.toString
  }

  /** The first n characters (code points, not UTF-16 units) of the text. */
  private def firstChars(text: String, n: Int): String = {
    val points = text.codePoints().limit(n.toLong).toArray
    new String(points, 0, points.length)
  }

  private def caseFile(tenant: String, role: Option[String], caseId: String): HttpResponse =
    // Another tenant's case answers exactly as a missing one: a case id is a name, not a permission.
    Store.getCase(caseId).filter(_.tenant == tenant) match {
      case None => error(StatusCodes.NotFound, "no such case")
      case Some(found) =>
        val fields = Map(
          "case_id" -> JsString(found.caseId),
          "content_id" -> JsString(found.contentId),
          "status" -> JsString(found.status),
          "reason" -> JsString(found.reason),
          "reports" -> JsNumber(found.reports),
          "actions" -> JsArray(Store.actionsOf(found.contentId).toVector),
          "links" -> JsObject("content" -> JsString(s"/v1/content/\${found.contentId}")),
          // Cut first, then escape: the cut never lands inside an entity.
          "detail" -> JsString(escapeHtml(firstChars(found.detail, MaxDetailChars))))
        val reporter = if (role.contains(SurveyorRole)) Map("reporter_id" -> JsString(found.reporterId)) else Map.empty[String, JsValue]
        json(StatusCodes.OK, JsObject(fields ++ reporter))
    }

  val route: Route = path("v1" / "moderation" / "items" / Segment) { caseId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("X-Reviewer-Role") { role =>
          tenant.filter(_.nonEmpty) match {
            case Some(t) => complete(caseFile(t, role, caseId))
            case None => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
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

#include "moderation/store.h"  // store::getCase, actionsOf

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_case(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const auto found = store::getCase(req.matches[1]);
  if (!found) return reply(res, 404, {{"error", "no such case"}});
  reply(res, 200,
        {{"case_id", found->case_id},
         {"content_id", found->content_id},
         {"status", found->status},
         {"reason", found->reason},
         {"reports", found->reports},
         {"actions", store::actionsOf(found->content_id)},
         {"links", {{"content", "/v1/content/" + found->content_id}}},
         {"reporter_id", found->reporter_id},
         {"detail", found->detail}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/moderation/items/([\\w-]+))", read_case); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "moderation/store.h"  // store::getCase, actionsOf

using json = nlohmann::json;

const std::string kSurveyorRole = "surveyor";
constexpr size_t kMaxDetailChars = 280;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string escapeHtml(const std::string& text) {
  std::string out;
  for (const char c : text) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\\'': out += "&#x27;"; break;
      default: out += c;
    }
  }
  return out;
}

// The first n characters (code points, not bytes) of UTF-8 text.
std::string firstChars(const std::string& text, size_t n) {
  size_t end = 0;
  size_t chars = 0;
  for (; end < text.size(); end++) {
    if ((static_cast<unsigned char>(text[end]) & 0xC0) == 0x80) continue;  // inside a character
    if (chars == n) break;
    chars++;
  }
  return text.substr(0, end);
}

void read_case(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const auto found = store::getCase(req.matches[1]);
  // Another tenant's case answers exactly as a missing one: a case id is a name, not a permission.
  if (!found || found->tenant != tenant) return reply(res, 404, {{"error", "no such case"}});
  json body = {{"case_id", found->case_id},
               {"content_id", found->content_id},
               {"status", found->status},
               {"reason", found->reason},
               {"reports", found->reports},
               {"actions", store::actionsOf(found->content_id)},
               {"links", {{"content", "/v1/content/" + found->content_id}}},
               // Cut first, then escape: the cut never lands inside an entity.
               {"detail", escapeHtml(firstChars(found->detail, kMaxDetailChars))}};
  if (req.get_header_value("X-Reviewer-Role") == kSurveyorRole) body["reporter_id"] = found->reporter_id;
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/moderation/items/([\\w-]+))", read_case); }
`,
    },
  },
  harness: {
    python: `import html
import re

from moderation import store

MODERATOR = {"X-Tenant-Id": "acme", "X-Reviewer-Role": "moderator"}
SURVEYOR = {"X-Tenant-Id": "acme", "X-Reviewer-Role": "surveyor"}
QUOTED = "Tom & Jerry said \\"hi\\" & 'bye' &amp; <b>"
RAW_AMPERSAND = re.compile(r"&(?!(?:amp|lt|gt|quot|apos|#34|#39|#x27|#x22);)")


def _seed(detail="Spam link in bio", reporter="u-17"):
    case = store.insert_case("acme", "c-1", reporter, "spam", detail)
    store.put_action({"action_id": f"{case['case_id']}:remove", "case_id": case["case_id"], "content_id": "c-1", "tenant": "acme", "action": "remove", "label": "spam", "confidence": 0.99, "model_version": "clf-2026-10", "actor": "classifier"})
    return case["case_id"]


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def check_route(ctx):
    case_id = _seed()
    async with _api(ctx) as c:
        r = await c.get(f"/v1/moderation/items/{case_id}", headers=MODERATOR)
        missing = await c.get(f"/v1/moderation/items/{case_id}")
        unknown = await c.get("/v1/moderation/items/case-404", headers=MODERATOR)
    assert r.status_code == 200, f"GET /v1/moderation/items/{case_id} answered {r.status_code}: {r.text}"
    body = r.json()
    assert (body.get("case_id"), body.get("content_id"), body.get("status")) == (case_id, "c-1", "open"), f"the case file must carry the case id, the content id and the status: {body}"
    assert [a.get("action") for a in body.get("actions") or []] == ["remove"], f"the case file must list the actions persisted on c-1: {body.get('actions')}"
    assert missing.status_code == 401, f"a read without X-Tenant-Id answered {missing.status_code}, expected 401"
    assert unknown.status_code == 404, f"a read of an unknown case answered {unknown.status_code}, expected 404"


async def check_tenant_scope(ctx):
    case_id = _seed()
    globex = {"X-Tenant-Id": "globex", "X-Reviewer-Role": "surveyor"}
    async with _api(ctx) as c:
        foreign = await c.get(f"/v1/moderation/items/{case_id}", headers=globex)
        unknown = await c.get("/v1/moderation/items/case-404", headers=globex)
    assert foreign.status_code == 404, f"globex read acme's case {case_id} and got {foreign.status_code}: {foreign.text}"
    assert foreign.text == unknown.text, f"another tenant's case answered {foreign.text!r} and a missing one {unknown.text!r}: the difference tells globex the id exists"


async def check_surveyor_only(ctx):
    case_id = _seed()
    async with _api(ctx) as c:
        readers = [
            ("a moderator", await c.get(f"/v1/moderation/items/{case_id}", headers=MODERATOR)),
            ("a caller with no role", await c.get(f"/v1/moderation/items/{case_id}", headers={"X-Tenant-Id": "acme"})),
        ]
        for role in ("not-surveyor", "surveyor-trainee"):
            readers.append((f"the role {role!r}", await c.get(f"/v1/moderation/items/{case_id}", headers={"X-Tenant-Id": "acme", "X-Reviewer-Role": role})))
        surveyor = await c.get(f"/v1/moderation/items/{case_id}", headers=SURVEYOR)
    for who, r in readers:
        assert r.status_code == 200, f"{who} got {r.status_code}: {r.text}"
        assert "reporter_id" not in r.json() and "u-17" not in r.text, f"{who} was shown the reporter: {r.text}. Only the role equal to SURVEYOR_ROLE sees it"
    assert surveyor.status_code == 200 and surveyor.json().get("reporter_id") == "u-17", f"a surveyor must see reporter_id u-17, got {surveyor.text}"


async def check_detail_escaped(ctx):
    case_id = _seed(detail='<img src=x onerror="alert(1)">')
    quoted_case = _seed(detail=QUOTED, reporter="u-18")
    async with _api(ctx) as c:
        r = await c.get(f"/v1/moderation/items/{case_id}", headers=MODERATOR)
        quoted = (await c.get(f"/v1/moderation/items/{quoted_case}", headers=MODERATOR)).json().get("detail", "")
    detail = r.json().get("detail", "")
    assert "<img" not in detail, f"the case file returned the detail as markup: {detail!r}. It runs in the moderator's console"
    assert detail.startswith("&lt;img src=x onerror=") and detail.endswith("&gt;"), f"the detail must come back HTML-escaped, got {detail!r}"
    raw = [ch for ch in "<>\\"'" if ch in quoted]
    assert not raw and not RAW_AMPERSAND.search(quoted), f"the detail {QUOTED!r} came back as {quoted!r}: {raw or ['&']} left raw. Escape &, <, > and both quotes, or a quote closes the attribute the console puts it in"
    assert html.unescape(quoted) == QUOTED, f"the detail {QUOTED!r} came back as {quoted!r}, which does not unescape to what the reporter wrote"


async def check_detail_bounded(ctx):
    long_case = _seed(detail="a" * 279 + "<b>" + "x" * 5000)
    accented_case = _seed(detail="é" * 300, reporter="u-18")
    short_case = _seed(detail="é" * 200, reporter="u-19")
    emoji_case = _seed(detail="a" * 279 + "😀" + "b" * 10, reporter="u-20")
    async with _api(ctx) as c:
        long = (await c.get(f"/v1/moderation/items/{long_case}", headers=MODERATOR)).json().get("detail", "")
        accented = (await c.get(f"/v1/moderation/items/{accented_case}", headers=MODERATOR)).json().get("detail", "")
        short = await c.get(f"/v1/moderation/items/{short_case}", headers=MODERATOR)
        emoji = (await c.get(f"/v1/moderation/items/{emoji_case}", headers=MODERATOR)).json().get("detail", "")
    assert long == "a" * 279 + "&lt;", f"a 5282-character detail came back as {len(long)} characters ending {long[-12:]!r}, expected its first 280 characters escaped: 279 a's then &lt; (cut first, then escape)"
    assert accented == "é" * 280, f"300 accented characters came back as {len(accented)} characters, expected the first 280"
    assert short.status_code == 200 and short.json().get("detail") == "é" * 200, f"200 accented characters (400 bytes, under 280 characters) answered {short.status_code} with {len(short.json().get('detail', '')) if short.status_code == 200 else short.text}: a detail within the limit comes back whole"
    assert emoji == "a" * 279 + "😀", f"279 a's, an emoji and 10 b's came back ending {emoji[-4:]!r} ({len(emoji)} characters), expected the first 280 characters: the emoji is one character"
`,
    typescript: `const MODERATOR = {'X-Tenant-Id': 'acme', 'X-Reviewer-Role': 'moderator'};
const SURVEYOR = {'X-Tenant-Id': 'acme', 'X-Reviewer-Role': 'surveyor'};
const QUOTED = \`Tom & Jerry said "hi" & 'bye' &amp; <b>\`;
const RAW_AMPERSAND = /&(?!(?:amp|lt|gt|quot|apos|#34|#39|#x27|#x22);)/;
const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#34': '"', '#39': "'", '#x27': "'", '#x22': '"'};
const unescapeHtml = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos|#34|#39|#x27|#x22);/g, (_, name: string) => ENTITIES[name]);

async function read(ctx, detail = 'Spam link in bio', reporter = 'u-17') {
  const store = ctx.load('/support/moderation/store.ts');
  const created = await store.insertCase('acme', 'c-1', reporter, 'spam', detail);
  await store.putAction({action_id: \`\${created.case_id}:remove\`, case_id: created.case_id, content_id: 'c-1', tenant: 'acme', action: 'remove', label: 'spam', confidence: 0.99, model_version: 'clf-2026-10', actor: 'classifier'});
  return {c: ctx.client(ctx.load('read').app), caseId: created.case_id};
}

export async function check_route(ctx) {
  const {c, caseId} = await read(ctx);
  const r = await c.get(\`/v1/moderation/items/\${caseId}\`, {headers: MODERATOR});
  const missing = await c.get(\`/v1/moderation/items/\${caseId}\`);
  const unknown = await c.get('/v1/moderation/items/case-404', {headers: MODERATOR});
  assert.equal(r.status, 200, \`GET /v1/moderation/items/\${caseId} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.case_id === caseId && body.content_id === 'c-1' && body.status === 'open', \`the case file must carry the case id, the content id and the status: \${r.text}\`);
  assert.deepStrictEqual((body.actions ?? []).map(a => a.action), ['remove'], \`the case file must list the actions persisted on c-1: \${JSON.stringify(body.actions)}\`);
  assert.equal(missing.status, 401, \`a read without X-Tenant-Id answered \${missing.status}, expected 401\`);
  assert.equal(unknown.status, 404, \`a read of an unknown case answered \${unknown.status}, expected 404\`);
}

export async function check_tenant_scope(ctx) {
  const {c, caseId} = await read(ctx);
  const globex = {'X-Tenant-Id': 'globex', 'X-Reviewer-Role': 'surveyor'};
  const foreign = await c.get(\`/v1/moderation/items/\${caseId}\`, {headers: globex});
  const unknown = await c.get('/v1/moderation/items/case-404', {headers: globex});
  assert.equal(foreign.status, 404, \`globex read acme's case \${caseId} and got \${foreign.status}: \${foreign.text}\`);
  assert.equal(foreign.text, unknown.text, \`another tenant's case answered \${foreign.text} and a missing one \${unknown.text}: the difference tells globex the id exists\`);
}

export async function check_surveyor_only(ctx) {
  const {c, caseId} = await read(ctx);
  const readers: [string, any][] = [
    ['a moderator', await c.get(\`/v1/moderation/items/\${caseId}\`, {headers: MODERATOR})],
    ['a caller with no role', await c.get(\`/v1/moderation/items/\${caseId}\`, {headers: {'X-Tenant-Id': 'acme'}})],
  ];
  for (const role of ['not-surveyor', 'surveyor-trainee']) {
    readers.push([\`the role '\${role}'\`, await c.get(\`/v1/moderation/items/\${caseId}\`, {headers: {'X-Tenant-Id': 'acme', 'X-Reviewer-Role': role}})]);
  }
  const surveyor = await c.get(\`/v1/moderation/items/\${caseId}\`, {headers: SURVEYOR});
  for (const [who, r] of readers) {
    assert.equal(r.status, 200, \`\${who} got \${r.status}: \${r.text}\`);
    assert(!('reporter_id' in r.json()) && !r.text.includes('u-17'), \`\${who} was shown the reporter: \${r.text}. Only the role equal to SURVEYOR_ROLE sees it\`);
  }
  assert(surveyor.status === 200 && surveyor.json().reporter_id === 'u-17', \`a surveyor must see reporter_id u-17, got \${surveyor.text}\`);
}

export async function check_detail_escaped(ctx) {
  const {c, caseId} = await read(ctx, '<img src=x onerror="alert(1)">');
  const store = ctx.load('/support/moderation/store.ts');
  const quotedCase = (await store.insertCase('acme', 'c-1', 'u-18', 'spam', QUOTED)).case_id;
  const detail: string = (await c.get(\`/v1/moderation/items/\${caseId}\`, {headers: MODERATOR})).json().detail ?? '';
  const quoted: string = (await c.get(\`/v1/moderation/items/\${quotedCase}\`, {headers: MODERATOR})).json().detail ?? '';
  assert(!detail.includes('<img'), \`the case file returned the detail as markup: \${JSON.stringify(detail)}. It runs in the moderator's console\`);
  assert(detail.startsWith('&lt;img src=x onerror=') && detail.endsWith('&gt;'), \`the detail must come back HTML-escaped, got \${JSON.stringify(detail)}\`);
  const raw = [...'<>"\\''].filter(ch => quoted.includes(ch));
  assert(
    raw.length === 0 && !RAW_AMPERSAND.test(quoted),
    \`the detail \${JSON.stringify(QUOTED)} came back as \${JSON.stringify(quoted)}: \${JSON.stringify(raw.length ? raw : ['&'])} left raw. Escape &, <, > and both quotes, or a quote closes the attribute the console puts it in\`,
  );
  assert.equal(unescapeHtml(quoted), QUOTED, \`the detail \${JSON.stringify(QUOTED)} came back as \${JSON.stringify(quoted)}, which does not unescape to what the reporter wrote\`);
}

export async function check_detail_bounded(ctx) {
  const {c, caseId: longCase} = await read(ctx, 'a'.repeat(279) + '<b>' + 'x'.repeat(5000));
  const store = ctx.load('/support/moderation/store.ts');
  const accentedCase = (await store.insertCase('acme', 'c-1', 'u-18', 'spam', 'é'.repeat(300))).case_id;
  const shortCase = (await store.insertCase('acme', 'c-1', 'u-19', 'spam', 'é'.repeat(200))).case_id;
  const emojiCase = (await store.insertCase('acme', 'c-1', 'u-20', 'spam', 'a'.repeat(279) + '😀' + 'b'.repeat(10))).case_id;
  const long: string = (await c.get(\`/v1/moderation/items/\${longCase}\`, {headers: MODERATOR})).json().detail ?? '';
  const accented: string = (await c.get(\`/v1/moderation/items/\${accentedCase}\`, {headers: MODERATOR})).json().detail ?? '';
  const short = await c.get(\`/v1/moderation/items/\${shortCase}\`, {headers: MODERATOR});
  const emoji: string = (await c.get(\`/v1/moderation/items/\${emojiCase}\`, {headers: MODERATOR})).json().detail ?? '';
  assert.equal(long, 'a'.repeat(279) + '&lt;', \`a 5282-character detail came back as \${long.length} characters ending \${JSON.stringify(long.slice(-12))}, expected its first 280 characters escaped: 279 a's then &lt; (cut first, then escape)\`);
  assert.equal(accented, 'é'.repeat(280), \`300 accented characters came back as \${[...accented].length} characters, expected the first 280\`);
  assert(short.status === 200 && short.json().detail === 'é'.repeat(200), \`200 accented characters (400 bytes, under 280 characters) answered \${short.status} \${short.text.slice(0, 80)}: a detail within the limit comes back whole\`);
  assert.equal(emoji, 'a'.repeat(279) + '😀', \`279 a's, an emoji and 10 b's came back ending \${JSON.stringify(emoji.slice(-4))} (\${[...emoji].length} characters), expected the first 280 characters: the emoji is one character\`);
}
`,
    go: `package main

import (
	"context"
	"html"
	"net/http"
	"strings"
	"unicode/utf8"

	"moderation/store"

	"leetbuild/harness"
)

const readQuoted = \`Tom & Jerry said "hi" & 'bye' &amp; <b>\`

// readRawAmpersand reports whether s holds an & that starts no entity.
func readRawAmpersand(s string) bool {
	for i := strings.IndexByte(s, '&'); i >= 0; i = strings.IndexByte(s, '&') {
		s = s[i:]
		entity := false
		for _, e := range []string{"&amp;", "&lt;", "&gt;", "&quot;", "&apos;", "&#34;", "&#39;", "&#x27;", "&#x22;"} {
			entity = entity || strings.HasPrefix(s, e)
		}
		if !entity {
			return true
		}
		s = s[1:]
	}
	return false
}

var readBg = context.Background()

func readSeed(detail, reporter string) string {
	created := store.InsertCase(readBg, "acme", "c-1", reporter, "spam", detail)
	store.PutAction(readBg, map[string]any{"action_id": created.CaseID + ":remove", "case_id": created.CaseID, "content_id": "c-1", "tenant": "acme", "action": "remove", "label": "spam", "confidence": 0.99, "model_version": "clf-2026-10", "actor": "classifier"})
	return created.CaseID
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readBody(r *harness.Response) map[string]any {
	body, _ := r.JSON().(map[string]any)
	return body
}

func readDetail(c *harness.HTTP, caseID string) string {
	detail, _ := readBody(c.Get("/v1/moderation/items/"+caseID, "X-Tenant-Id", "acme", "X-Reviewer-Role", "moderator"))["detail"].(string)
	return detail
}

func CheckRoute(ctx *harness.Ctx) {
	caseID := readSeed("Spam link in bio", "u-17")
	c := readClient(ctx)
	r := c.Get("/v1/moderation/items/"+caseID, "X-Tenant-Id", "acme", "X-Reviewer-Role", "moderator")
	ctx.Equal(r.Status, 200, "GET /v1/moderation/items/%s (%s)", caseID, r.Text())
	body := readBody(r)
	ctx.Assert(body["case_id"] == caseID && body["content_id"] == "c-1" && body["status"] == "open", "the case file must carry the case id, the content id and the status: %s", r.Text())
	actions, _ := body["actions"].([]any)
	ctx.Assert(len(actions) == 1 && actions[0].(map[string]any)["action"] == "remove", "the case file must list the actions persisted on c-1: %v", body["actions"])
	ctx.Equal(c.Get("/v1/moderation/items/"+caseID).Status, 401, "a read without X-Tenant-Id")
	ctx.Equal(c.Get("/v1/moderation/items/case-404", "X-Tenant-Id", "acme").Status, 404, "a read of an unknown case")
}

func CheckTenantScope(ctx *harness.Ctx) {
	caseID := readSeed("Spam link in bio", "u-17")
	c := readClient(ctx)
	foreign := c.Get("/v1/moderation/items/"+caseID, "X-Tenant-Id", "globex", "X-Reviewer-Role", "surveyor")
	unknown := c.Get("/v1/moderation/items/case-404", "X-Tenant-Id", "globex", "X-Reviewer-Role", "surveyor")
	ctx.Equal(foreign.Status, 404, "globex read acme's case %s (%s)", caseID, foreign.Text())
	ctx.Equal(foreign.Text(), unknown.Text(), "another tenant's case must answer exactly as a missing one, or the difference tells globex the id exists; the foreign answer")
}

func CheckSurveyorOnly(ctx *harness.Ctx) {
	caseID := readSeed("Spam link in bio", "u-17")
	c := readClient(ctx)
	for who, r := range map[string]*harness.Response{
		"a moderator":                 c.Get("/v1/moderation/items/"+caseID, "X-Tenant-Id", "acme", "X-Reviewer-Role", "moderator"),
		"a caller with no role":       c.Get("/v1/moderation/items/"+caseID, "X-Tenant-Id", "acme"),
		"the role 'not-surveyor'":     c.Get("/v1/moderation/items/"+caseID, "X-Tenant-Id", "acme", "X-Reviewer-Role", "not-surveyor"),
		"the role 'surveyor-trainee'": c.Get("/v1/moderation/items/"+caseID, "X-Tenant-Id", "acme", "X-Reviewer-Role", "surveyor-trainee"),
	} {
		ctx.Equal(r.Status, 200, "%s (%s)", who, r.Text())
		_, shown := readBody(r)["reporter_id"]
		ctx.Assert(!shown && !strings.Contains(r.Text(), "u-17"), "%s was shown the reporter: %s. Only the role equal to surveyorRole sees it", who, r.Text())
	}
	surveyor := c.Get("/v1/moderation/items/"+caseID, "X-Tenant-Id", "acme", "X-Reviewer-Role", "surveyor")
	ctx.Assert(surveyor.Status == 200 && readBody(surveyor)["reporter_id"] == "u-17", "a surveyor must see reporter_id u-17, got %s", surveyor.Text())
}

func CheckDetailEscaped(ctx *harness.Ctx) {
	caseID := readSeed(\`<img src=x onerror="alert(1)">\`, "u-17")
	quotedCase := readSeed(readQuoted, "u-18")
	c := readClient(ctx)
	detail := readDetail(c, caseID)
	ctx.Assert(!strings.Contains(detail, "<img"), "the case file returned the detail as markup: %q. It runs in the moderator's console", detail)
	ctx.Assert(strings.HasPrefix(detail, "&lt;img src=x onerror=") && strings.HasSuffix(detail, "&gt;"), "the detail must come back HTML-escaped, got %q", detail)
	quoted := readDetail(c, quotedCase)
	ctx.Assert(!strings.ContainsAny(quoted, "<>\\"'") && !readRawAmpersand(quoted), "the detail %q came back as %q: a character is left raw. Escape &, <, > and both quotes, or a quote closes the attribute the console puts it in", readQuoted, quoted)
	ctx.Equal(html.UnescapeString(quoted), readQuoted, "the detail must unescape to what the reporter wrote (it came back as %q)", quoted)
}

func CheckDetailBounded(ctx *harness.Ctx) {
	longCase := readSeed(strings.Repeat("a", 279)+"<b>"+strings.Repeat("x", 5000), "u-17")
	accentedCase := readSeed(strings.Repeat("é", 300), "u-18")
	shortCase := readSeed(strings.Repeat("é", 200), "u-19")
	emojiCase := readSeed(strings.Repeat("a", 279)+"😀"+strings.Repeat("b", 10), "u-20")
	c := readClient(ctx)
	long := readDetail(c, longCase)
	ctx.Assert(long == strings.Repeat("a", 279)+"&lt;", "a 5282-character detail came back as %d characters ending %q, expected its first 280 characters escaped: 279 a's then &lt; (cut first, then escape)", utf8.RuneCountInString(long), long[max(0, len(long)-12):])
	accented := readDetail(c, accentedCase)
	ctx.Equal(accented, strings.Repeat("é", 280), "300 accented characters must come back as the first 280; got %d characters", utf8.RuneCountInString(accented))
	short := c.Get("/v1/moderation/items/"+shortCase, "X-Tenant-Id", "acme", "X-Reviewer-Role", "moderator")
	ctx.Equal(short.Status, 200, "200 accented characters (400 bytes, under 280 characters) must come back whole")
	whole, _ := readBody(short)["detail"].(string)
	ctx.Equal(whole, strings.Repeat("é", 200), "200 accented characters (400 bytes, under 280 characters) must come back whole; got %d characters", utf8.RuneCountInString(whole))
	emoji := readDetail(c, emojiCase)
	ctx.Equal(emoji, strings.Repeat("a", 279)+"😀", "279 a's, an emoji and 10 b's must come back as the first 280 characters (the emoji is one character); got %d characters", utf8.RuneCountInString(emoji))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

std::string readSeed(const std::string& detail, const std::string& reporter = "u-17") {
  const store::Case created = store::insertCase("acme", "c-1", reporter, "spam", detail);
  store::putAction({{"action_id", created.case_id + ":remove"}, {"case_id", created.case_id}, {"content_id", "c-1"}, {"tenant", "acme"}, {"action", "remove"},
                    {"label", "spam"}, {"confidence", 0.99}, {"model_version", "clf-2026-10"}, {"actor", "classifier"}});
  return created.case_id;
}

harness::HTTP readClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json readBody(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

std::string readDetail(harness::HTTP& c, const std::string& case_id) {
  return readBody(c.Get("/v1/moderation/items/" + case_id, "X-Tenant-Id", "acme", "X-Reviewer-Role", "moderator")).value("detail", "");
}

std::string repeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}

const std::string kQuoted = R"text(Tom & Jerry said "hi" & 'bye' &amp; <b>)text";
const std::vector<std::pair<std::string, std::string>> kEntities = {{"&amp;", "&"}, {"&lt;", "<"},  {"&gt;", ">"},   {"&quot;", "\\""}, {"&apos;", "'"},
                                                                    {"&#34;", "\\""}, {"&#39;", "'"}, {"&#x27;", "'"}, {"&#x22;", "\\""}};

// The text with every entity of kEntities decoded; nullopt when an & starts none of them.
std::optional<std::string> unescapeHtml(const std::string& text) {
  std::string out;
  for (size_t i = 0; i < text.size();) {
    if (text[i] != '&') {
      out += text[i++];
      continue;
    }
    bool entity = false;
    for (const auto& [name, ch] : kEntities) {
      if (text.compare(i, name.size(), name) == 0) {
        out += ch;
        i += name.size();
        entity = true;
        break;
      }
    }
    if (!entity) return std::nullopt;
  }
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string case_id = readSeed("Spam link in bio");
  auto c = readClient(ctx);
  const auto r = c.Get("/v1/moderation/items/" + case_id, "X-Tenant-Id", "acme", "X-Reviewer-Role", "moderator");
  ctx.Equal(r.Status, 200, "GET /v1/moderation/items/%s (%s)", case_id, r.Text());
  const auto body = readBody(r);
  ctx.Assert(body.value("case_id", "") == case_id && body.value("content_id", "") == "c-1" && body.value("status", "") == "open",
             "the case file must carry the case id, the content id and the status: %s", r.Text());
  const auto actions = body.value("actions", nlohmann::json::array());
  ctx.Assert(actions.is_array() && actions.size() == 1 && actions[0].value("action", "") == "remove", "the case file must list the actions persisted on c-1: %s", actions.dump());
  ctx.Equal(c.Get("/v1/moderation/items/" + case_id).Status, 401, "a read without X-Tenant-Id");
  ctx.Equal(c.Get("/v1/moderation/items/case-404", "X-Tenant-Id", "acme").Status, 404, "a read of an unknown case");
}

void CheckTenantScope(harness::Ctx& ctx) {
  const std::string case_id = readSeed("Spam link in bio");
  auto c = readClient(ctx);
  const auto foreign = c.Get("/v1/moderation/items/" + case_id, "X-Tenant-Id", "globex", "X-Reviewer-Role", "surveyor");
  const auto unknown = c.Get("/v1/moderation/items/case-404", "X-Tenant-Id", "globex", "X-Reviewer-Role", "surveyor");
  ctx.Equal(foreign.Status, 404, "globex read acme's case %s (%s)", case_id, foreign.Text());
  ctx.Equal(foreign.Text(), unknown.Text(), "another tenant's case must answer exactly as a missing one, or the difference tells globex the id exists; the foreign answer");
}

void CheckSurveyorOnly(harness::Ctx& ctx) {
  const std::string case_id = readSeed("Spam link in bio");
  auto c = readClient(ctx);
  std::vector<std::pair<std::string, harness::Response>> readers;
  readers.emplace_back("a moderator", c.Get("/v1/moderation/items/" + case_id, "X-Tenant-Id", "acme", "X-Reviewer-Role", "moderator"));
  readers.emplace_back("a caller with no role", c.Get("/v1/moderation/items/" + case_id, "X-Tenant-Id", "acme"));
  for (const std::string role : {"not-surveyor", "surveyor-trainee"}) {
    readers.emplace_back("the role '" + role + "'", c.Get("/v1/moderation/items/" + case_id, "X-Tenant-Id", "acme", "X-Reviewer-Role", role));
  }
  for (const auto& [who, r] : readers) {
    ctx.Equal(r.Status, 200, "%s (%s)", who, r.Text());
    ctx.Assert(!readBody(r).contains("reporter_id") && r.Text().find("u-17") == std::string::npos,
               "%s was shown the reporter: %s. Only the role equal to kSurveyorRole sees it", who, r.Text());
  }
  const auto surveyor = c.Get("/v1/moderation/items/" + case_id, "X-Tenant-Id", "acme", "X-Reviewer-Role", "surveyor");
  ctx.Assert(surveyor.Status == 200 && readBody(surveyor).value("reporter_id", "") == "u-17", "a surveyor must see reporter_id u-17, got %s", surveyor.Text());
}

void CheckDetailEscaped(harness::Ctx& ctx) {
  const std::string case_id = readSeed(R"html(<img src=x onerror="alert(1)">)html");
  const std::string quoted_case = readSeed(kQuoted, "u-18");
  auto c = readClient(ctx);
  const std::string detail = readDetail(c, case_id);
  ctx.Assert(detail.find("<img") == std::string::npos, "the case file returned the detail as markup: %q. It runs in the moderator's console", detail);
  ctx.Assert(detail.rfind("&lt;img src=x onerror=", 0) == 0 && detail.size() >= 4 && detail.substr(detail.size() - 4) == "&gt;",
             "the detail must come back HTML-escaped, got %q", detail);
  const std::string quoted = readDetail(c, quoted_case);
  const auto decoded = unescapeHtml(quoted);
  ctx.Assert(quoted.find_first_of("<>\\"'") == std::string::npos && decoded,
             "the detail %q came back as %q: a character is left raw. Escape &, <, > and both quotes, or a quote closes the attribute the console puts it in", kQuoted, quoted);
  ctx.Equal(decoded.value_or(""), kQuoted, "the detail must unescape to what the reporter wrote (it came back as %q)", quoted);
}

void CheckDetailBounded(harness::Ctx& ctx) {
  const std::string long_case = readSeed(repeat("a", 279) + "<b>" + repeat("x", 5000));
  const std::string accented_case = readSeed(repeat("é", 300), "u-18");
  const std::string short_case = readSeed(repeat("é", 200), "u-19");
  const std::string emoji_case = readSeed(repeat("a", 279) + "😀" + repeat("b", 10), "u-20");
  auto c = readClient(ctx);
  const std::string long_detail = readDetail(c, long_case);
  ctx.Assert(long_detail == repeat("a", 279) + "&lt;",
             "a 5282-character detail came back as %d bytes ending %q, expected its first 280 characters escaped: 279 a's then &lt; (cut first, then escape)",
             long_detail.size(), long_detail.substr(long_detail.size() > 12 ? long_detail.size() - 12 : 0));
  ctx.Equal(readDetail(c, accented_case), repeat("é", 280), "300 accented characters must come back as the first 280");
  const auto short_read = c.Get("/v1/moderation/items/" + short_case, "X-Tenant-Id", "acme", "X-Reviewer-Role", "moderator");
  ctx.Equal(short_read.Status, 200, "200 accented characters (400 bytes, under 280 characters) must come back whole");
  ctx.Equal(readBody(short_read).value("detail", ""), repeat("é", 200), "200 accented characters (400 bytes, under 280 characters) must come back whole");
  ctx.Equal(readDetail(c, emoji_case), repeat("a", 279) + "😀", "279 a's, an emoji and 10 b's must come back as the first 280 characters (the emoji is one character)");
}
`,
  },
  hints: [
    'Open acme’s case with `X-Tenant-Id: globex`: it answers. Open any case as a moderator: the reporter’s id is in the body. Store a detail of `<img onerror=…>`: the console runs it.',
    'The handler asks whether the case exists, not whose it is; the body carries `reporter_id` for every role; the detail goes out as stored, unbounded and unescaped, and escaping before cutting would split `&lt;` in half.',
    '404 when `case["tenant"] != tenant`; add `reporter_id` only when the role equals `SURVEYOR_ROLE`; answer `html.escape(case["detail"][:MAX_DETAIL_CHARS])`.',
  ],
  debrief: `A case id is a name, not a permission: the read compares the case's tenant with the caller's, and a foreign case gets the same 404 as a missing one so ids cannot be probed. The reporter's identity is the most sensitive field in the service, and leaving it out of the body for every role but surveyor means nothing downstream of the response can leak it. The detail is someone else's text, so it is escaped before it reaches a page, and cut first so the cut never lands inside an entity. Production case files log every view of a reporter's identity with the viewer and a stated reason, and show moderators the reported content behind a blur until they choose to look.`,
};
