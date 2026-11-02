import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/moderation/items/{id}: the case file, scoped',
  concept: 'http',
  file: 'read',
  focus: ['api', 'db', 'console'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/moderation/items/{case_id}\`, reads the tenant
from \`X-Tenant-Id\`, fetches the case by id and returns its status, reporter id and detail as
stored. It compiles, serves the demo and hides 4 flaws.

**Failure mode the checks target.** A case file is a dossier that names the person who reported
someone else, so it is the most sensitive read in the service. The starter fails on authorisation
(the case id is not an access token), on data minimisation (reporter identity for everyone), and on
output handling (raw, unbounded free text straight back to the caller). The demo fetches its own
case from a trusted console, so none of this shows.

Requirements:

- The case is scoped to the **content owner's tenant**: resolve the case's tenant from the catalogue
  and answer **404**, not 403, when it belongs to someone else or does not exist.
- The body carries the status, the action history and links to the moderated content. The
  **reporter's identity is included only for the \`surveyor\` role**; for every other role it is
  absent, not blanked, not hashed.
- The free-text **detail is truncated** to \`MAX_DETAIL_CHARS\` and **escaped** before it is returned,
  so the case file is not a stored-XSS payload and not an unbounded copy of a private statement.
- A missing tenant is **401**.`,
  sequence: {
    participants: ['Moderator console', 'Moderation API', 'case store'],
    messages: [
      {
        from: 'Moderator console',
        to: 'Moderation API',
        label: 'GET /v1/moderation/items/{id} · X-Tenant-Id · X-Reviewer-Role',
        kind: 'sync',
      },
      {from: 'Moderation API', to: 'case store', label: 'case tenant == caller tenant?', kind: 'sync'},
      {from: 'case store', to: 'Moderation API', label: 'record / 404 for a foreign case', kind: 'reply'},
      {
        from: 'Moderation API',
        to: 'Moderation API',
        label: 'truncate + escape detail · include reporter only for surveyors',
        kind: 'sync',
      },
      {from: 'Moderation API', to: 'Moderator console', label: '200 {status, actions, content, detail}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/moderation/items/{id}',
      detail: 'Register the case read on `GET /v1/moderation/items/{case_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/moderation\/items\//]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/moderation\/items\//]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/moderation\/items\//]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"moderation"\s*\/\s*"items"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/moderation\/items\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Hides a case that belongs to another tenant',
      detail:
        'The case’s tenant is resolved from the catalogue and a mismatch is **404** — indistinguishable from a case that does not exist. The starter returns any case by id, so a guessed id leaks another tenant’s reports.',
      match: {
        python: {all: [/CASE_TENANT/, /status_code\s*=\s*404/]},
        typescript: {all: [/CASE_TENANT/, /code\(\s*404\s*\)/]},
        go: {all: [/caseTenant/, /StatusNotFound/]},
        scala: {all: [/CaseTenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/kCaseTenant/, /\b404\b/]},
      },
    },
    {
      id: 'surveyor-only',
      title: 'Shows reporter identity only to the surveyor role',
      detail:
        'The reporter’s identity is added to the body only when the caller’s role is `surveyor`. The starter includes it for every caller, handing the reported user the name of the person who reported them.',
      match: {
        python: {all: [/SURVEYOR_ROLE/, /reporter_id/]},
        typescript: {all: [/SURVEYOR_ROLE/, /reporter_id/]},
        go: {all: [/surveyorRole/, /ReporterID/]},
        scala: {all: [/SurveyorRole/, /reporterId/]},
        cpp: {all: [/kSurveyorRole/, /reporter_id/]},
      },
    },
    {
      id: 'detail-truncated',
      title: 'Truncates the free-text detail',
      detail:
        'The detail is cut to `MAX_DETAIL_CHARS` before it is returned. The starter echoes the whole field, so one report can carry a wall of private text into every case-file view.',
      match: {
        python: {all: [/MAX_DETAIL_CHARS/]},
        typescript: {all: [/MAX_DETAIL_CHARS/]},
        go: {all: [/maxDetailChars/]},
        scala: {all: [/MaxDetailChars/]},
        cpp: {all: [/kMaxDetailChars/]},
      },
    },
    {
      id: 'detail-escaped',
      title: 'Escapes the free-text detail',
      detail:
        'The detail is HTML-escaped before it is returned, so a report cannot store markup that executes in the reviewer’s console. The starter echoes it raw.',
      match: {
        python: {all: [/html\.escape/]},
        typescript: {all: [/escapeHtml/]},
        go: {all: [/html\.EscapeString/]},
        scala: {all: [/escapeHtml/]},
        cpp: {all: [/escapeHtml/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

cases = CaseStore()


@app.get("/v1/moderation/items/{case_id}")
def read_case(case_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    record = cases.get(case_id)
    return JSONResponse(
        {
            "case_id": case_id,
            "status": record["status"],
            "reporter_id": record["reporter_id"],
            "detail": record["detail"],
        },
        status_code=200,
    )
`,
      solution: `import html

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

MAX_DETAIL_CHARS = 280
SURVEYOR_ROLE = "surveyor"
CASE_TENANT = {"case_5d21": "acme", "case_9b07": "globex"}


class CaseStore:
    def get(self, case_id: str) -> dict | None:
        """The case record, or None when it does not exist."""
        raise NotImplementedError

    def actions(self, case_id: str) -> list[dict]:
        """The action history for the case, oldest first."""
        raise NotImplementedError


cases = CaseStore()


def redact(text: str) -> str:
    escaped = html.escape(text or "", quote=True)
    if len(escaped) <= MAX_DETAIL_CHARS:
        return escaped
    return escaped[:MAX_DETAIL_CHARS] + "…"


@app.get("/v1/moderation/items/{case_id}")
def read_case(
    case_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    role: str | None = Header(default=None, alias="X-Reviewer-Role"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if CASE_TENANT.get(case_id) != tenant:
        raise HTTPException(status_code=404, detail="unknown case")
    record = cases.get(case_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown case")

    body = {
        "case_id": case_id,
        "status": record["status"],
        "content": {"id": record["content_id"], "url": record["content_url"]},
        "actions": [
            {"action": action["action"], "rule": action["rule"], "reviewer_role": action["reviewer_role"]}
            for action in cases.actions(case_id)
        ],
        "detail": redact(record["detail"]),
    }
    if role == SURVEYOR_ROLE:
        body["reporter_id"] = record["reporter_id"]
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/moderation/items/{id}: flawed code that treats the case id as access. */
import Fastify from 'fastify';

export const app = Fastify();

app.get('/v1/moderation/items/:caseId', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {caseId} = request.params as {caseId: string};
  const record = await cases.get(caseId);
  return reply.code(200).send({
    case_id: caseId,
    status: record.status,
    reporter_id: record.reporter_id,
    detail: record.detail,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/moderation/items/{id}: the case file, scoped, redacted and escaped. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_DETAIL_CHARS = 280;
const SURVEYOR_ROLE = 'surveyor';
const CASE_TENANT: Record<string, string> = {case_5d21: 'acme', case_9b07: 'globex'};

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function redact(text: string | undefined): string {
  const escaped = escapeHtml(text ?? '');
  if (escaped.length <= MAX_DETAIL_CHARS) return escaped;
  return escaped.slice(0, MAX_DETAIL_CHARS) + '...';
}

app.get('/v1/moderation/items/:caseId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {caseId} = request.params as {caseId: string};
  if (CASE_TENANT[caseId] !== tenant) return reply.code(404).send({error: 'unknown case'});
  const record = await cases.get(caseId);
  if (record === null) return reply.code(404).send({error: 'unknown case'});

  const body: Record<string, unknown> = {
    case_id: caseId,
    status: record.status,
    content: {id: record.content_id, url: record.content_url},
    actions: await cases.actions(caseId),
    detail: redact(record.detail),
  };
  if (request.headers['x-reviewer-role'] === SURVEYOR_ROLE) body.reporter_id = record.reporter_id;
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"log"
	"net/http"
)

func readCase(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	caseID := r.PathValue("case_id")
	record, _ := cases.Get(caseID)
	if record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown case"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"case_id":     caseID,
		"status":      record.Status,
		"reporter_id": record.ReporterID,
		"detail":      record.Detail,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/moderation/items/{case_id}", readCase)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"html"
	"log"
	"net/http"
)

const maxDetailChars = 280
const surveyorRole = "surveyor"

var caseTenant = map[string]string{"case_5d21": "acme", "case_9b07": "globex"}

type CaseRecord struct {
	Status     string
	ContentID  string
	ContentURL string
	ReporterID string
	Detail     string
}

type CaseStore struct{}

func (s *CaseStore) Get(caseID string) (*CaseRecord, error) { return nil, nil }

func (s *CaseStore) Actions(caseID string) ([]map[string]any, error) { return nil, nil }

var cases = &CaseStore{}

func redact(text string) string {
	escaped := html.EscapeString(text)
	runes := []rune(escaped)
	if len(runes) <= maxDetailChars {
		return escaped
	}
	return string(runes[:maxDetailChars]) + "..."
}

func readCase(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	caseID := r.PathValue("case_id")
	if caseTenant[caseID] != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown case"})
		return
	}
	record, err := cases.Get(caseID)
	if err != nil || record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown case"})
		return
	}
	actions, _ := cases.Actions(caseID)
	body := map[string]any{
		"case_id": caseID,
		"status":  record.Status,
		"content": map[string]any{"id": record.ContentID, "url": record.ContentURL},
		"actions": actions,
		"detail":  redact(record.Detail),
	}
	if r.Header.Get("X-Reviewer-Role") == surveyorRole {
		body["reporter_id"] = record.ReporterID
	}
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/moderation/items/{case_id}", readCase)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object CaseFileApi {
  implicit val system: ActorSystem = ActorSystem("moderation")

  val cases = CaseStore.open()

  val route: Route =
    path("v1" / "moderation" / "items" / Segment) { caseId =>
      get {
        // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
        cases.get(caseId) match {
          case None => complete(StatusCodes.NotFound, """{"error":"unknown case"}""")
          case Some(record) =>
            complete(
              StatusCodes.OK,
              s"""{"case_id":"$caseId","status":"\${record.status}","reporter_id":"\${record.reporterId}","detail":"\${record.detail}"}"""
            )
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

object CaseFileApi {
  implicit val system: ActorSystem = ActorSystem("moderation")

  val MaxDetailChars = 280
  val SurveyorRole = "surveyor"
  val CaseTenant = Map("case_5d21" -> "acme", "case_9b07" -> "globex")

  val cases = CaseStore.open()

  def escapeHtml(text: String): String =
    text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\\"", "&quot;")

  def redact(text: String): String = {
    val escaped = escapeHtml(text)
    if (escaped.length <= MaxDetailChars) escaped
    else escaped.take(MaxDetailChars) + "..."
  }

  val route: Route =
    path("v1" / "moderation" / "items" / Segment) { caseId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else if (!CaseTenant.get(caseId).contains(tenantOpt.get)) {
            complete(StatusCodes.NotFound, """{"error":"unknown case"}""")
          } else {
            cases.get(caseId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown case"}""")
              case Some(record) =>
                optionalHeaderValueByName("X-Reviewer-Role") { roleOpt =>
                  val base =
                    s"""{"case_id":"$caseId","status":"\${record.status}","detail":"\${redact(record.detail)}"}"""
                  val body =
                    if (roleOpt.contains(SurveyorRole))
                      base.dropRight(1) + s""","reporter_id":"\${record.reporterId}"}"""
                    else base
                  complete(StatusCodes.OK, body)
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

#include <string>

using json = nlohmann::json;

struct CaseStore {
  json get(const std::string& caseId);
};

CaseStore cases;

int main() {
  httplib::Server svr;

  svr.Get("/v1/moderation/items/([A-Za-z0-9_]+)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto caseId = req.matches[1];
    const json record = cases.get(caseId);
    res.status = 200;
    res.set_content(
        json{{"case_id", caseId},
             {"status", record.value("status", std::string())},
             {"reporter_id", record.value("reporter_id", std::string())},
             {"detail", record.value("detail", std::string())}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstddef>
#include <map>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxDetailChars = 280;
const std::string kSurveyorRole = "surveyor";
const std::map<std::string, std::string> kCaseTenant = {{"case_5d21", "acme"}, {"case_9b07", "globex"}};

struct CaseStore {
  std::optional<json> get(const std::string& caseId);
  json actions(const std::string& caseId);
};

CaseStore cases;

std::string escapeHtml(const std::string& text) {
  std::string out;
  for (const char c : text) {
    switch (c) {
      case '&':
        out += "&amp;";
        break;
      case '<':
        out += "&lt;";
        break;
      case '>':
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      default:
        out += c;
    }
  }
  return out;
}

std::string redact(const std::string& text) {
  const auto escaped = escapeHtml(text);
  if (escaped.size() <= kMaxDetailChars) return escaped;
  return escaped.substr(0, kMaxDetailChars) + "...";
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/moderation/items/([A-Za-z0-9_]+)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto caseId = req.matches[1];
    if (kCaseTenant.count(caseId) == 0 || kCaseTenant.at(caseId) != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown case"})", "application/json");
      return;
    }
    const auto record = cases.get(caseId);
    if (!record) {
      res.status = 404;
      res.set_content(R"({"error":"unknown case"})", "application/json");
      return;
    }
    json body = {
        {"case_id", caseId},
        {"status", record->value("status", std::string())},
        {"content", json{{"id", record->value("content_id", std::string())},
                         {"url", record->value("content_url", std::string())}}},
        {"actions", cases.actions(caseId)},
        {"detail", redact(record->value("detail", std::string()))},
    };
    if (req.get_header_value("X-Reviewer-Role") == kSurveyorRole) {
      body["reporter_id"] = record->value("reporter_id", std::string());
    }
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    "A reported user who guesses a case id reads who reported them, a tenant can browse another tenant's cases, and a report containing `<script>` runs in the moderator console.",
    'The handler does `cases.get(case_id)` with no tenant comparison, builds the body with `reporter_id` unconditionally, and copies `record["detail"]` into the response without escaping or bounding it.',
    'Compare `CASE_TENANT[case_id]` to the header (404 on mismatch), add `reporter_id` only when the role is `SURVEYOR_ROLE`, and return `html.escape(detail)` cut to `MAX_DETAIL_CHARS`.',
  ],
  debrief: `The read side needs the same care as the write side because an opaque id is not an access token. The tenant check uses the same catalogue as the report intake and answers 404 rather than 403 so a probe cannot learn that a case exists. The body is built without the reporter and the identity is added only inside the surveyor branch, which is easier to audit than blanking fields later. Escaping happens before truncation so a cut cannot split an entity, and the cap keeps the case file a summary rather than a copy of a private statement. Production case systems also log every view per case, require a recorded reason when a surveyor unmasks a reporter, and seal the raw detail under its own retention policy apart from the case metadata.`,
};
