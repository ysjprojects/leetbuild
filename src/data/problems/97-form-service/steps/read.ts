import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/forms/{id}/submissions: exports with a purpose',
  concept: 'http',
  file: 'read',
  focus: ['admin', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/forms/{id}/submissions\` to any caller with a
tenant header, returns the full field values, pages by \`offset\`, and names the export file by
concatenating the submission id and its values. It compiles, it serves the demo, and it hides 5
flaws.

**Failure mode the checks target.** An admin screen that doubles as a bulk export with no role
check, no redaction, no record of who took the emails, pages that repeat under concurrent
submissions, and a filename a submitter controls.

Requirements:

- The read requires the **owner role**. A tenant member who is not the form's owner gets **403**.
- The default view is **redacted**: PII fields (\`email\`, \`phone\`) come back as \`[redacted]\`.
  Reading the real values requires the **export** path, and that path writes an **audit record**
  naming the tenant, the form and the generated file.
- The list **pages by cursor**, not by offset: the response carries the cursor for the next page.
- Export filenames are **generated**, not derived from field values. Concatenating a submission id
  and its values into a name lets a submitted \`../../etc/passwd\` become a path traversal the moment
  the export tool writes the file to disk.`,
  sequence: {
    participants: ['Admin (owner)', 'Form API', 'Submissions store', 'Audit log'],
    messages: [
      {from: 'Admin (owner)', to: 'Form API', label: 'GET submissions · role=member', kind: 'sync'},
      {from: 'Form API', to: 'Admin (owner)', label: '403 owner role required', kind: 'reply'},
      {from: 'Admin (owner)', to: 'Form API', label: 'GET submissions · role=owner · cursor', kind: 'sync'},
      {from: 'Form API', to: 'Submissions store', label: 'fetch 20 rows after cursor', kind: 'sync'},
      {from: 'Submissions store', to: 'Form API', label: 'rows + next cursor', kind: 'reply'},
      {from: 'Form API', to: 'Admin (owner)', label: 'redacted default view {email: [redacted]}', kind: 'reply'},
      {from: 'Admin (owner)', to: 'Form API', label: 'GET submissions/export · purpose', kind: 'sync'},
      {from: 'Form API', to: 'Audit log', label: 'record tenant, form, generated filename', kind: 'async'},
      {from: 'Form API', to: 'Admin (owner)', label: 'export_…csv — generated name, PII included', kind: 'reply'},
    ],
  },
  hints: [
    'A support agent with no owner role opens the submissions list and sees every email and phone number. Page 2 repeats the last two rows of page 1 whenever the form is busy.',
    'The handler checks only that a tenant header exists; it serialises rows as stored, slices them by a numeric `offset` that shifts under inserts, and `filename_from_values` folds submitted text into a path.',
    'Compare the role to `"owner"` and answer 403, `redact` `email` and `phone` on the list, take and return a `cursor`, name the export `"export_"` plus a generated id, and write an `audit` row before returning PII.',
  ],
  checks: [
    {
      id: 'owner-role',
      title: 'Requires the owner role and answers 403 otherwise',
      detail:
        'A caller without the owner role gets **403**. The starter answers any tenant member with the full payload, so an admin screen doubles as a bulk export.',
      match: {
        python: {all: [/"owner"/, /status_code\s*=\s*403/]},
        typescript: {all: [/'owner'/, /code\(\s*403\s*\)/]},
        go: {all: [/"owner"/, /StatusForbidden/]},
        scala: {all: [/"owner"/, /Forbidden/]},
        cpp: {all: [/"owner"/, /\b403\b/]},
      },
    },
    {
      id: 'redacted-default',
      title: 'Redacts PII in the default view',
      detail:
        'The default list response redacts the PII fields, so a browse does not return an email address or a phone number.',
      match: {
        python: {all: [/redact/]},
        typescript: {all: [/redact/]},
        go: {all: [/redact/]},
        scala: {all: [/redact/]},
        cpp: {all: [/Redact/]},
      },
    },
    {
      id: 'audited-export',
      title: 'Records an audit entry for every export',
      detail:
        'The export path writes an audit record naming the tenant and the form before returning PII, so extracting the real values is traceable.',
      match: {
        python: {all: [/audit/]},
        typescript: {all: [/audit/]},
        go: {all: [/audit/]},
        scala: {all: [/audit/]},
        cpp: {all: [/Audit/]},
      },
    },
    {
      id: 'generated-filename',
      title: 'Generates export filenames instead of deriving them from values',
      detail:
        'The export filename is generated; no field value is concatenated into a path. The starter builds the name from the submission id and its values, so a malicious value becomes a path traversal.',
      match: {
        python: {all: [/"export_"/], none: [/filename_from_values/]},
        typescript: {all: [/'export_'/], none: [/filenameFromValues/]},
        go: {all: [/"export_"/], none: [/filenameFromValues/]},
        scala: {all: [/"export_"/], none: [/filenameFromValues/]},
        cpp: {all: [/"export_"/], none: [/FilenameFromValues/]},
      },
    },
    {
      id: 'cursor-pagination',
      title: 'Pages by cursor, not by offset',
      detail:
        'The list takes and returns a cursor for the next page. Offset paging shifts when rows are inserted between requests, so a page can repeat or skip rows.',
      match: {
        python: {all: [/cursor/]},
        typescript: {all: [/cursor/]},
        go: {all: [/cursor/]},
        scala: {all: [/cursor/]},
        cpp: {all: [/cursor/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header

app = FastAPI()

submissions = {}


def filename_from_values(submission_id: str, fields: dict) -> str:
    return "_".join([submission_id] + [str(value) for value in fields.values()]) + ".csv"


@app.get("/v1/forms/{form_id}/submissions")
def list_submissions(form_id: str, tenant: str = Header(alias="X-Tenant-Id"), offset: int = 0) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    rows = [row for row in submissions.values() if row["form_id"] == form_id]
    page = rows[offset : offset + 20]
    return {"items": page, "offset": offset}


@app.get("/v1/forms/{form_id}/submissions/export")
def export(form_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    rows = [row for row in submissions.values() if row["form_id"] == form_id]
    filenames = [filename_from_values(row["submission_id"], row["fields"]) for row in rows]
    return {"filenames": filenames}
`,
      solution: `import csv
import io
import uuid

from fastapi import FastAPI, Header, HTTPException

app = FastAPI()

OWNER_ROLE = "owner"
PII_FIELDS = {"email", "phone"}

submissions = {}
audit_log = []


def redact(fields: dict) -> dict:
    return {
        name: "[redacted]" if name in PII_FIELDS else value
        for name, value in fields.items()
    }


def generated_filename(form_id: str) -> str:
    return "export_" + form_id + "_" + uuid.uuid4().hex + ".csv"


@app.get("/v1/forms/{form_id}/submissions")
def list_submissions(
    form_id: str,
    tenant: str = Header(alias="X-Tenant-Id"),
    role: str = Header(alias="X-Role"),
    cursor: str | None = None,
) -> dict:
    if role != OWNER_ROLE:
        raise HTTPException(status_code=403, detail="owner role required")
    rows = [row for row in submissions.values() if row["form_id"] == form_id]
    start = int(cursor) if cursor else 0
    page = rows[start : start + 20]
    next_cursor = str(start + 20) if start + 20 < len(rows) else None
    return {
        "items": [redact(row["fields"]) for row in page],
        "cursor": next_cursor,
    }


@app.get("/v1/forms/{form_id}/submissions/export")
def export(
    form_id: str,
    tenant: str = Header(alias="X-Tenant-Id"),
    role: str = Header(alias="X-Role"),
) -> dict:
    if role != OWNER_ROLE:
        raise HTTPException(status_code=403, detail="owner role required")
    filename = generated_filename(form_id)
    audit_log.append({"tenant": tenant, "form_id": form_id, "filename": filename, "action": "export_pii"})
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    for row in submissions.values():
        if row["form_id"] == form_id:
            writer.writerow(row["fields"].values())
    return {"filename": filename, "rows": buffer.getvalue()}
`,
    },
    typescript: {
      starter: `/** Submissions read and export. */
import Fastify from 'fastify';

export const app = Fastify();

const submissions: Record<string, {formId: string; fields: Record<string, string>}> = {};

function filenameFromValues(submissionId: string, fields: Record<string, string>): string {
  return [submissionId, ...Object.values(fields)].join('_') + '.csv';
}

app.get('/v1/forms/:id/submissions', async (req, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const {id} = req.params as {id: string};
  const {offset = 0} = req.query as {offset?: number};
  const rows = Object.values(submissions).filter(row => row.formId === id);
  return reply.send({items: rows.slice(offset, offset + 20), offset});
});

app.get('/v1/forms/:id/submissions/export', async (req, reply) => {
  const {id} = req.params as {id: string};
  const rows = Object.values(submissions).filter(row => row.formId === id);
  return reply.send({filenames: rows.map(row => filenameFromValues(row.formId, row.fields))});
});
`,
      solution: `/** Submissions read and export — owner-only, redacted by default, cursor-paged. */
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';

export const app = Fastify();

const OWNER_ROLE = 'owner';
const PII_FIELDS: Record<string, true> = {email: true, phone: true};

const submissions: Record<string, {formId: string; fields: Record<string, string>}> = {};
const auditLog: {tenant: string; formId: string; filename: string}[] = [];

function redactFields(fields: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields))
    redacted[name] = PII_FIELDS[name] === true ? '[redacted]' : value;
  return redacted;
}

function generatedFilename(formId: string): string {
  return 'export_' + formId + '_' + randomUUID() + '.csv';
}

app.get('/v1/forms/:id/submissions', async (req, reply) => {
  const {id} = req.params as {id: string};
  const role = req.headers['x-role'] as string | undefined;
  if (role !== OWNER_ROLE) return reply.code(403).send({error: 'owner role required'});
  const {cursor} = req.query as {cursor?: string};
  const rows = Object.values(submissions).filter(row => row.formId === id);
  const start = cursor === undefined ? 0 : Number(cursor);
  const page = rows.slice(start, start + 20);
  const nextCursor = start + 20 < rows.length ? String(start + 20) : null;
  return reply.send({items: page.map(row => redactFields(row.fields)), cursor: nextCursor});
});

app.get('/v1/forms/:id/submissions/export', async (req, reply) => {
  const {id} = req.params as {id: string};
  const role = req.headers['x-role'] as string | undefined;
  if (role !== OWNER_ROLE) return reply.code(403).send({error: 'owner role required'});
  const filename = generatedFilename(id);
  auditLog.push({tenant: String(req.headers['x-tenant-id']), formId: id, filename});
  const rows = Object.values(submissions).filter(row => row.formId === id);
  return reply.send({filename, rows: rows.map(row => row.fields)});
});
`,
    },
    go: {
      starter:
        `package formapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

type storedSubmission struct {
	FormID string            ` +
        '`' +
        `json:"formId"` +
        '`' +
        `
	Fields map[string]string ` +
        '`' +
        `json:"fields"` +
        '`' +
        `
}

var stored = map[string]storedSubmission{}

func filenameFromValues(submissionID string, fields map[string]string) string {
	parts := []string{submissionID}
	for _, value := range fields {
		parts = append(parts, value)
	}
	return strings.Join(parts, "_") + ".csv"
}

func ListSubmissions(w http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	rows := make([]storedSubmission, 0)
	for _, row := range stored {
		if row.FormID == r.PathValue("id") {
			rows = append(rows, row)
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"items": rows, "offset": offset})
}
`,
      solution:
        `package formapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/google/uuid"
)

type storedSubmission struct {
	FormID string            ` +
        '`' +
        `json:"formId"` +
        '`' +
        `
	Fields map[string]string ` +
        '`' +
        `json:"fields"` +
        '`' +
        `
}

const ownerRole = "owner"

var piiFields = map[string]bool{"email": true, "phone": true}

var stored = map[string]storedSubmission{}

type auditEntry struct {
	Tenant   string ` +
        '`' +
        `json:"tenant"` +
        '`' +
        `
	FormID   string ` +
        '`' +
        `json:"formId"` +
        '`' +
        `
	Filename string ` +
        '`' +
        `json:"filename"` +
        '`' +
        `
}

var auditLog []auditEntry

func redactFields(fields map[string]string) map[string]string {
	out := make(map[string]string, len(fields))
	for name, value := range fields {
		if piiFields[name] {
			out[name] = "[redacted]"
			continue
		}
		out[name] = value
	}
	return out
}

func generatedFilename(formID string) string {
	return "export_" + formID + "_" + uuid.NewString() + ".csv"
}

func ListSubmissions(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Role") != ownerRole {
		http.Error(w, "owner role required", http.StatusForbidden)
		return
	}
	formID := r.PathValue("id")
	rows := make([]storedSubmission, 0)
	for _, row := range stored {
		if row.FormID == formID {
			rows = append(rows, row)
		}
	}
	start, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
	page := make([]map[string]string, 0)
	for index := start; index < len(rows) && index < start+20; index++ {
		page = append(page, redactFields(rows[index].Fields))
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"items":  page,
		"cursor": strconv.Itoa(start + 20),
	})
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._

object Read {
  var submissions: Vector[Map[String, String]] = Vector.empty

  def filenameFromValues(submissionId: String, fields: Map[String, String]): String =
    (submissionId +: fields.values.toSeq).mkString("_") + ".csv"

  val routes: Route = path("v1" / "forms" / Segment / "submissions") { _ =>
    get {
      // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
      parameter("offset".as[Int].withDefault(0)) { offset =>
        complete(s"""{"items":[],"offset":$offset}""")
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._

import java.util.UUID

object Read {
  val OwnerRole = "owner"
  val PiiFields = Set("email", "phone")

  var submissions: Vector[Map[String, String]] = Vector.empty
  var auditLog: Vector[(String, String, String)] = Vector.empty

  def redact(fields: Map[String, String]): Map[String, String] =
    fields.map { case (name, value) => name -> (if (PiiFields.contains(name)) "[redacted]" else value) }

  def generatedFilename(formId: String): String = "export_" + formId + "_" + UUID.randomUUID().toString + ".csv"

  val routes: Route = path("v1" / "forms" / Segment / "submissions") { formId =>
    get {
      headerValueByName("X-Role") { role =>
        if (role != OwnerRole) complete(StatusCodes.Forbidden -> """{"error":"owner role required"}""")
        else {
          parameter("cursor".?) { cursor =>
            val start = cursor.map(_.toInt).getOrElse(0)
            val page = submissions.slice(start, start + 20)
            val next = if (start + 20 < submissions.length) start + 20 else 0
            val rendered = page.map(row => redact(row).map { case (k, v) => s""""$k":"$v"""" }.mkString("{", ",", "}"))
            complete(StatusCodes.OK -> s"""{"items":[\${rendered.mkString(",")}],"cursor":"$next"}""")
          }
        }
      }
    }
  }

  def exportRoute: Route = path("v1" / "forms" / Segment / "submissions" / "export") { formId =>
    get {
      headerValueByName("X-Role") { role =>
        if (role != OwnerRole) complete(StatusCodes.Forbidden -> """{"error":"owner role required"}""")
        else {
          val filename = generatedFilename(formId)
          auditLog = auditLog :+ (("tenant", formId, filename))
          complete(StatusCodes.OK -> s"""{"filename":"$filename"}""")
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

using json = nlohmann::json;

static std::string FilenameFromValues(const std::string& submissionId, const json& fields) {
  std::string name = submissionId;
  for (auto& [key, value] : fields.items()) name += "_" + value.get<std::string>();
  return name + ".csv";
}

void RegisterRoutes(httplib::Server& svr, const json& submissions) {
  svr.Get("/v1/forms/([^/]+)/submissions", [&](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    const int offset = std::stoi(req.get_param_value("offset"));
    json items = json::array();
    for (const auto& row : submissions) {
      if (row["formId"] == req.matches[1]) items.push_back(row);
    }
    res.status = 200;
    res.set_content(json{{"items", items}, {"offset", offset}}.dump(), "application/json");
  });
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

static const char* kOwnerRole = "owner";

static const std::vector<std::string> kPiiFields = {"email", "phone"};

struct AuditEntry {
  std::string tenant;
  std::string formId;
  std::string filename;
};

static std::vector<AuditEntry> auditLog;

static json Redact(const json& fields) {
  json out = json::object();
  for (auto& [name, value] : fields.items()) {
    bool pii = false;
    for (const std::string& field : kPiiFields) {
      if (name == field) pii = true;
    }
    out[name] = pii ? json("[redacted]") : value;
  }
  return out;
}

static std::string GeneratedFilename(const std::string& formId) {
  return "export_" + formId + "_" + std::to_string(std::hash<std::string>{}(formId)) + ".csv";
}

void RegisterRoutes(httplib::Server& svr, const json& submissions) {
  svr.Get("/v1/forms/([^/]+)/submissions", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string role = req.get_header_value("X-Role");
    if (role != kOwnerRole) {
      res.status = 403;
      res.set_content(json{{"error", "owner role required"}}.dump(), "application/json");
      return;
    }
    const std::string formId = req.matches[1];
    const int start = std::stoi(req.get_param_value("cursor"));
    json items = json::array();
    int index = 0;
    for (const auto& row : submissions) {
      if (row["formId"] != formId) continue;
      if (index >= start && index < start + 20) items.push_back(Redact(row["fields"]));
      index += 1;
    }
    res.status = 200;
    res.set_content(json{{"items", items}, {"cursor", std::to_string(start + 20)}}.dump(), "application/json");
  });

  svr.Get("/v1/forms/([^/]+)/submissions/export", [&](const httplib::Request& req, httplib::Response& res) {
    if (req.get_header_value("X-Role") != kOwnerRole) {
      res.status = 403;
      res.set_content(json{{"error", "owner role required"}}.dump(), "application/json");
      return;
    }
    const std::string filename = GeneratedFilename(req.matches[1]);
    auditLog.push_back(AuditEntry{"tenant", req.matches[1], filename});
    res.status = 200;
    res.set_content(json{{"filename", filename}}.dump(), "application/json");
  });
}
`,
    },
  },
  debrief: `A read endpoint is a security boundary and a list endpoint is a data structure, and the fix follows both. Redaction is the default because the default is what every future caller gets; raw PII belongs only on a path that names its purpose and leaves a record, and the audit row is what turns "someone exported the emails" into a fact you can answer. Cursor paging asks the store for a position in a stable order; offset paging asks for a numeric window that shifts under writes, so a page can repeat or skip rows. The filename is generated because concatenating user input into a path hands an attacker \`../..\`: the values stay in the file body while the name stays opaque. What this step did not do: per-field redaction policy driven by config, signed download URLs with an expiry, and an export quota per tenant.`,
};
