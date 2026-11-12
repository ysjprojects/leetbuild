import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET submissions and exports: owner only, redacted, cursor-paged, audited',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['admin', 'api', 'db', 'outbox'],
  task: `## Task

**Starting point.** The starter serves the owner's side of formd on the form store: \`GET
/v1/forms/{id}/submissions?offset=&limit=\` answers \`{items: [{submission_id, values}], next_offset}\`
from \`store.page_by_offset\` (newest first) to any caller with an \`X-User-Id\`, and \`POST
/v1/forms/{id}/exports\` answers \`{file, rows}\` with the file named after the newest submission's
id and name. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** Any signed-in user reads every submission, emails and phone
numbers included, on a screen that doubles as a bulk export nobody records; a page shifts when
someone submits and the next page repeats a row; and a submitter who types \`../../etc/passwd\` as
a name chooses where the export tool writes.

- Only the form's owner (\`store.owner_of\`) reads or exports: anyone else is **403**, no
  \`X-User-Id\` is **401**.
- The list is **redacted**: \`PII_FIELDS\` (\`email\`, \`phone\`) read \`[redacted]\`. The export has
  the real values and writes an audit row: \`store.record_audit(user, form_id, file)\`.
- The list pages by **cursor**: \`store.page_before(form_id, cursor, limit)\`, and \`next_cursor\` is
  the last item's \`seq\` (null on the last page).
- The export file name is **generated** (\`export-{random}.csv\`), never built from submitted values.`,
  sequence: {
    participants: ['Form owner', 'Form API', 'Form store'],
    messages: [
      {from: 'Form owner', to: 'Form API', label: 'GET /v1/forms/{id}/submissions?cursor= · X-User-Id', kind: 'sync'},
      {from: 'Form API', to: 'Form store', label: 'owner_of(form) → 403 unless the caller', kind: 'sync'},
      {from: 'Form API', to: 'Form store', label: 'page_before(form, cursor, limit)', kind: 'sync'},
      {from: 'Form API', to: 'Form owner', label: 'items with email, phone [redacted] · next_cursor', kind: 'reply'},
      {from: 'Form owner', to: 'Form API', label: 'POST /v1/forms/{id}/exports', kind: 'sync'},
      {from: 'Form API', to: 'Form store', label: 'record_audit(user, form, export-{random}.csv)', kind: 'sync'},
      {from: 'Form API', to: 'Form owner', label: '{file, rows} with the real values', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'owner-role',
      title: 'Only the form’s owner reads or exports',
      detail:
        'Both routes compare `X-User-Id` with `owner_of`/`ownerOf` and answer **403** to anyone else (**401** without the header). The starter serves any caller with a header.',
      match: {
        python: {all: [/store\.owner_of\(/, /\b403\b/]},
        typescript: {all: [/\bownerOf\(/, /\b403\b/]},
        go: {all: [/store\.OwnerOf\(/, /StatusForbidden|\b403\b/]},
        scala: {all: [/Store\.ownerOf\(/, /Forbidden/]},
        cpp: {all: [/store::ownerOf\(/, /\b403\b/]},
      },
    },
    {
      id: 'redacted-default',
      title: 'The list redacts PII fields',
      detail:
        'In the list, every field in `PII_FIELDS` (`email`, `phone`) reads `[redacted]`; other fields are shown. The starter returns every value as stored.',
      match: {
        python: {all: [/PII_FIELDS/, /\[redacted\]/]},
        typescript: {all: [/PII_FIELDS/, /\[redacted\]/]},
        go: {all: [/piiFields/, /\[redacted\]/]},
        scala: {all: [/PiiFields/, /\[redacted\]/]},
        cpp: {all: [/kPiiFields/, /\[redacted\]/]},
      },
    },
    {
      id: 'audited-export',
      title: 'An export writes an audit row',
      detail:
        'The export, the one path with real values, records who took which form’s submissions into which file (`record_audit`/`recordAudit`). The starter records nothing.',
      match: {
        python: {all: [/store\.record_audit\(/]},
        typescript: {all: [/\brecordAudit\(/]},
        go: {all: [/store\.RecordAudit\(/]},
        scala: {all: [/Store\.recordAudit\(/]},
        cpp: {all: [/store::recordAudit\(/]},
      },
    },
    {
      id: 'generated-filename',
      title: 'Export file names are generated',
      detail:
        'The file name comes from a random source (`uuid4`, `randomUUID`, `crypto/rand`, `random_device`) and holds no submitted value, so `../../etc/passwd` in a name field stays data. The starter names the file after the newest submission.',
      match: {
        python: {all: [/uuid4\(|token_hex\(|token_urlsafe\(/], none: [/file\s*=\s*[^\n]*\bvalues\b/]},
        typescript: {all: [/randomUUID\(|randomBytes\(/], none: [/file\s*=\s*[^\n]*\bvalues\b/]},
        go: {all: [/rand\.Read\(|rand\.Text\(/], none: [/file\s*:?=\s*[^\n]*Values/]},
        scala: {all: [/UUID\.randomUUID\(/], none: [/file\s*=\s*[^\n]*values/]},
        cpp: {all: [/random_device/], none: [/file\s*=\s*[^\n]*values/]},
      },
    },
    {
      id: 'cursor-pagination',
      title: 'Pages by cursor, not offset',
      detail:
        'The list reads `page_before(form_id, cursor, limit)` and answers `next_cursor`, the last item’s `seq`, so a submission arriving between two pages shifts nothing. The starter pages by offset: a new submission pushes a row from page one onto page two.',
      match: {
        python: {all: [/store\.page_before\(/, /next_cursor/], none: [/store\.page_by_offset\(/]},
        typescript: {all: [/\bpageBefore\(/, /next_cursor/], none: [/\bpageByOffset\(/]},
        go: {all: [/store\.PageBefore\(/, /next_cursor/], none: [/store\.PageByOffset\(/]},
        scala: {all: [/Store\.pageBefore\(/, /next_cursor/], none: [/Store\.pageByOffset\(/]},
        cpp: {all: [/store::pageBefore\(/, /next_cursor/], none: [/store::pageByOffset\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from forms import store  # owner_of, page_by_offset, page_before, record_audit

app = FastAPI()

PAGE_SIZE = 50
EXPORT_LIMIT = 1000


def caller(request: Request) -> str:
    user = request.headers.get("x-user-id", "")
    if not user:
        raise HTTPException(status_code=401, detail="X-User-Id is required")
    return user


@app.get("/v1/forms/{form_id}/submissions")
def list_submissions(form_id: str, request: Request) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    caller(request)
    offset = int(request.query_params.get("offset") or 0)
    limit = int(request.query_params.get("limit") or PAGE_SIZE)
    rows = store.page_by_offset(form_id, offset, limit)
    items = [{"submission_id": row["submission_id"], "values": row["values"]} for row in rows]
    return {"items": items, "next_offset": offset + len(rows)}


@app.post("/v1/forms/{form_id}/exports")
def export_submissions(form_id: str, request: Request) -> dict:
    caller(request)
    rows = store.page_by_offset(form_id, 0, EXPORT_LIMIT)
    newest = rows[0] if rows else {"submission_id": "empty", "values": {}}
    file = f"{newest['submission_id']}-{newest['values'].get('name', '')}.csv"
    return {"file": file, "rows": [{"submission_id": row["submission_id"], "values": row["values"]} for row in rows]}
`,
      solution: `import uuid

from fastapi import FastAPI, HTTPException, Request

from forms import store  # owner_of, page_by_offset, page_before, record_audit

app = FastAPI()

PAGE_SIZE = 50
EXPORT_LIMIT = 1000
PII_FIELDS = ("email", "phone")


def owner(form_id: str, request: Request) -> str:
    """The caller, if they own the form."""
    user = request.headers.get("x-user-id", "")
    if not user:
        raise HTTPException(status_code=401, detail="X-User-Id is required")
    if store.owner_of(form_id) != user:
        raise HTTPException(status_code=403, detail="only the form's owner reads its submissions")
    return user


def redacted(values: dict) -> dict:
    return {name: "[redacted]" if name in PII_FIELDS else value for name, value in values.items()}


@app.get("/v1/forms/{form_id}/submissions")
def list_submissions(form_id: str, request: Request) -> dict:
    owner(form_id, request)
    cursor = int(request.query_params.get("cursor") or 0)
    limit = int(request.query_params.get("limit") or PAGE_SIZE)
    # A cursor is a position in the data, not in the list: new submissions cannot shift it.
    rows = store.page_before(form_id, cursor, limit)
    items = [{"submission_id": row["submission_id"], "values": redacted(row["values"])} for row in rows]
    next_cursor = str(rows[-1]["seq"]) if len(rows) == limit else None
    return {"items": items, "next_cursor": next_cursor}


@app.post("/v1/forms/{form_id}/exports")
def export_submissions(form_id: str, request: Request) -> dict:
    user = owner(form_id, request)
    rows = store.page_before(form_id, 0, EXPORT_LIMIT)
    # The name is ours, not the submitter's: no value can become a path.
    file = f"export-{uuid.uuid4().hex}.csv"
    store.record_audit(user, form_id, file)
    return {"file": file, "rows": [{"submission_id": row["submission_id"], "values": row["values"]} for row in rows]}
`,
    },
    typescript: {
      starter: `import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';

import {type Submission, ownerOf, pageBefore, pageByOffset, recordAudit} from 'forms/store';

export const app = Fastify();

export const PAGE_SIZE = 50;
export const EXPORT_LIMIT = 1000;

/** The caller's user id, or null once a 401 is sent. */
function caller(request: FastifyRequest, reply: FastifyReply): string | null {
  const user = request.headers['x-user-id'];
  if (typeof user === 'string' && user !== '') return user;
  void reply.code(401).send({error: 'X-User-Id is required'});
  return null;
}

app.get('/v1/forms/:formId/submissions', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  if (caller(request, reply) === null) return reply;
  const {formId} = request.params as {formId: string};
  const query = request.query as {offset?: string; limit?: string};
  const offset = Number(query.offset ?? 0);
  const rows = await pageByOffset(formId, offset, Number(query.limit ?? PAGE_SIZE));
  return {items: rows.map(row => ({submission_id: row.submission_id, values: row.values})), next_offset: offset + rows.length};
});

app.post('/v1/forms/:formId/exports', async (request, reply) => {
  if (caller(request, reply) === null) return reply;
  const {formId} = request.params as {formId: string};
  const rows: Submission[] = await pageByOffset(formId, 0, EXPORT_LIMIT);
  const newest = rows[0];
  const file = newest === undefined ? 'empty.csv' : \`\${newest.submission_id}-\${newest.values.name ?? ''}.csv\`;
  return {file, rows: rows.map(row => ({submission_id: row.submission_id, values: row.values}))};
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';

import {ownerOf, pageBefore, pageByOffset, recordAudit} from 'forms/store';

export const app = Fastify();

export const PAGE_SIZE = 50;
export const EXPORT_LIMIT = 1000;
export const PII_FIELDS = ['email', 'phone'];

/** The caller, if they own the form; null once a 401 or 403 is sent. */
async function owner(formId: string, request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') {
    void reply.code(401).send({error: 'X-User-Id is required'});
    return null;
  }
  if ((await ownerOf(formId)) !== user) {
    void reply.code(403).send({error: "only the form's owner reads its submissions"});
    return null;
  }
  return user;
}

const redacted = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, PII_FIELDS.includes(name) ? '[redacted]' : value]));

app.get('/v1/forms/:formId/submissions', async (request, reply) => {
  const {formId} = request.params as {formId: string};
  if ((await owner(formId, request, reply)) === null) return reply;
  const query = request.query as {cursor?: string; limit?: string};
  const limit = Number(query.limit ?? PAGE_SIZE);
  // A cursor is a position in the data, not in the list: new submissions cannot shift it.
  const rows = await pageBefore(formId, Number(query.cursor ?? 0), limit);
  const next_cursor = rows.length === limit ? String(rows[rows.length - 1].seq) : null;
  return {items: rows.map(row => ({submission_id: row.submission_id, values: redacted(row.values)})), next_cursor};
});

app.post('/v1/forms/:formId/exports', async (request, reply) => {
  const {formId} = request.params as {formId: string};
  const user = await owner(formId, request, reply);
  if (user === null) return reply;
  const rows = await pageBefore(formId, 0, EXPORT_LIMIT);
  // The name is ours, not the submitter's: no value can become a path.
  const file = \`export-\${randomUUID()}.csv\`;
  await recordAudit(user, formId, file);
  return {file, rows: rows.map(row => ({submission_id: row.submission_id, values: row.values}))};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"forms/store" // store.OwnerOf, PageByOffset, PageBefore, RecordAudit
)

const (
	pageSize    = 50
	exportLimit = 1000
)

type item struct {
	SubmissionID string            \`json:"submission_id"\`
	Values       map[string]string \`json:"values"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// caller is the caller's user id, or "" once a 401 is written.
func caller(rw http.ResponseWriter, r *http.Request) string {
	user := r.Header.Get("X-User-Id")
	if user == "" {
		http.Error(rw, "X-User-Id is required", http.StatusUnauthorized)
	}
	return user
}

func intParam(r *http.Request, name string, fallback int) int {
	if n, err := strconv.Atoi(r.URL.Query().Get(name)); err == nil {
		return n
	}
	return fallback
}

func listSubmissions(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	if caller(rw, r) == "" {
		return
	}
	offset := intParam(r, "offset", 0)
	rows := store.PageByOffset(r.Context(), r.PathValue("id"), offset, intParam(r, "limit", pageSize))
	items := []item{}
	for _, row := range rows {
		items = append(items, item{row.SubmissionID, row.Values})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"items": items, "next_offset": offset + len(rows)})
}

func exportSubmissions(rw http.ResponseWriter, r *http.Request) {
	if caller(rw, r) == "" {
		return
	}
	rows := store.PageByOffset(r.Context(), r.PathValue("id"), 0, exportLimit)
	file := "empty.csv"
	if len(rows) > 0 {
		file = rows[0].SubmissionID + "-" + rows[0].Values["name"] + ".csv"
	}
	items := []item{}
	for _, row := range rows {
		items = append(items, item{row.SubmissionID, row.Values})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"file": file, "rows": items})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/forms/{id}/submissions", listSubmissions)
	mux.HandleFunc("POST /v1/forms/{id}/exports", exportSubmissions)
}
`,
      solution: `package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"

	"forms/store" // store.OwnerOf, PageByOffset, PageBefore, RecordAudit
)

const (
	pageSize    = 50
	exportLimit = 1000
)

var piiFields = []string{"email", "phone"}

type item struct {
	SubmissionID string            \`json:"submission_id"\`
	Values       map[string]string \`json:"values"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// owner is the caller, if they own the form, or "" once a 401 or 403 is written.
func owner(rw http.ResponseWriter, r *http.Request) string {
	user := r.Header.Get("X-User-Id")
	if user == "" {
		http.Error(rw, "X-User-Id is required", http.StatusUnauthorized)
		return ""
	}
	if store.OwnerOf(r.Context(), r.PathValue("id")) != user {
		http.Error(rw, "only the form's owner reads its submissions", http.StatusForbidden)
		return ""
	}
	return user
}

func redacted(values map[string]string) map[string]string {
	out := map[string]string{}
	for name, value := range values {
		if slices.Contains(piiFields, name) {
			value = "[redacted]"
		}
		out[name] = value
	}
	return out
}

func intParam(r *http.Request, name string, fallback int) int {
	if n, err := strconv.Atoi(r.URL.Query().Get(name)); err == nil {
		return n
	}
	return fallback
}

func listSubmissions(rw http.ResponseWriter, r *http.Request) {
	if owner(rw, r) == "" {
		return
	}
	limit := intParam(r, "limit", pageSize)
	// A cursor is a position in the data, not in the list: new submissions cannot shift it.
	rows := store.PageBefore(r.Context(), r.PathValue("id"), int64(intParam(r, "cursor", 0)), limit)
	items := []item{}
	for _, row := range rows {
		items = append(items, item{row.SubmissionID, redacted(row.Values)})
	}
	var next *string
	if len(rows) == limit {
		cursor := strconv.FormatInt(rows[len(rows)-1].Seq, 10)
		next = &cursor
	}
	writeJSON(rw, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}

func exportSubmissions(rw http.ResponseWriter, r *http.Request) {
	user := owner(rw, r)
	if user == "" {
		return
	}
	formID := r.PathValue("id")
	rows := store.PageBefore(r.Context(), formID, 0, exportLimit)
	// The name is ours, not the submitter's: no value can become a path.
	random := make([]byte, 16)
	rand.Read(random)
	file := "export-" + hex.EncodeToString(random) + ".csv"
	if err := store.RecordAudit(r.Context(), user, formID, file); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	items := []item{}
	for _, row := range rows {
		items = append(items, item{row.SubmissionID, row.Values})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"file": file, "rows": items})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/forms/{id}/submissions", listSubmissions)
	mux.HandleFunc("POST /v1/forms/{id}/exports", exportSubmissions)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import forms.Store // Store.ownerOf, pageByOffset, pageBefore, recordAudit

object ReadApi {
  val PageSize = 50
  val ExportLimit = 1000

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def item(row: Store.Submission): JsObject =
    JsObject("submission_id" -> JsString(row.submissionId), "values" -> JsObject(row.values.map { case (k, v) => k -> JsString(v) }))

  val route: Route = concat(
    path("v1" / "forms" / Segment / "submissions") { formId =>
      get {
        optionalHeaderValueByName("X-User-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-User-Id is required")
          case Some(_) =>
            parameters("offset".optional, "limit".optional) { (offsetParam, limitParam) =>
              // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
              val offset = offsetParam.map(_.toInt).getOrElse(0)
              val rows = Store.pageByOffset(formId, offset, limitParam.map(_.toInt).getOrElse(PageSize))
              complete(json(JsObject("items" -> JsArray(rows.map(item).toVector), "next_offset" -> JsNumber(offset + rows.size))))
            }
        }
      }
    },
    path("v1" / "forms" / Segment / "exports") { formId =>
      post {
        optionalHeaderValueByName("X-User-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-User-Id is required")
          case Some(_) =>
            val rows = Store.pageByOffset(formId, 0, ExportLimit)
            val file = rows.headOption.map(newest => s"\${newest.submissionId}-\${newest.values.getOrElse("name", "")}.csv").getOrElse("empty.csv")
            complete(json(JsObject("file" -> JsString(file), "rows" -> JsArray(rows.map(item).toVector))))
        }
      }
    }
  )
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.{Directive1, Route}
import spray.json._

import forms.Store // Store.ownerOf, pageByOffset, pageBefore, recordAudit

object ReadApi {
  val PageSize = 50
  val ExportLimit = 1000
  val PiiFields: Set[String] = Set("email", "phone")

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def item(row: Store.Submission, values: Map[String, String]): JsObject =
    JsObject("submission_id" -> JsString(row.submissionId), "values" -> JsObject(values.map { case (k, v) => k -> JsString(v) }))

  private def redacted(values: Map[String, String]): Map[String, String] =
    values.map { case (name, value) => name -> (if (PiiFields.contains(name)) "[redacted]" else value) }

  /** The caller, if they own the form. */
  private def owner(formId: String): Directive1[String] =
    optionalHeaderValueByName("X-User-Id").flatMap {
      case None | Some("") => complete(StatusCodes.Unauthorized -> "X-User-Id is required")
      case Some(user) if !Store.ownerOf(formId).contains(user) => complete(StatusCodes.Forbidden -> "only the form's owner reads its submissions")
      case Some(user) => provide(user)
    }

  val route: Route = concat(
    path("v1" / "forms" / Segment / "submissions") { formId =>
      get {
        owner(formId) { _ =>
          parameters("cursor".optional, "limit".optional) { (cursorParam, limitParam) =>
            val limit = limitParam.map(_.toInt).getOrElse(PageSize)
            // A cursor is a position in the data, not in the list: new submissions cannot shift it.
            val rows = Store.pageBefore(formId, cursorParam.map(_.toLong).getOrElse(0L), limit)
            val next = if (rows.size == limit) JsString(rows.last.seq.toString) else JsNull
            complete(json(JsObject("items" -> JsArray(rows.map(row => item(row, redacted(row.values))).toVector), "next_cursor" -> next)))
          }
        }
      }
    },
    path("v1" / "forms" / Segment / "exports") { formId =>
      post {
        owner(formId) { user =>
          val rows = Store.pageBefore(formId, 0L, ExportLimit)
          // The name is ours, not the submitter's: no value can become a path.
          val file = s"export-\${UUID.randomUUID()}.csv"
          Store.recordAudit(user, formId, file)
          complete(json(JsObject("file" -> JsString(file), "rows" -> JsArray(rows.map(row => item(row, row.values)).toVector))))
        }
      }
    }
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "forms/store.h"  // store::ownerOf, pageByOffset, pageBefore, recordAudit

using json = nlohmann::json;

constexpr long long kPageSize = 50;
constexpr long long kExportLimit = 1000;

json item(const store::Submission& row) { return json{{"submission_id", row.submission_id}, {"values", row.values}}; }

long long intParam(const httplib::Request& req, const std::string& name, long long fallback) {
  return req.has_param(name) ? std::stoll(req.get_param_value(name)) : fallback;
}

// Whether the caller sent a user id; a 401 is written when not.
bool signedIn(const httplib::Request& req, httplib::Response& res) {
  if (!req.get_header_value("X-User-Id").empty()) return true;
  res.status = 401;
  res.set_content("X-User-Id is required", "text/plain");
  return false;
}

void list_submissions(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  if (!signedIn(req, res)) return;
  const long long offset = intParam(req, "offset", 0);
  const auto rows = store::pageByOffset(req.matches[1], offset, intParam(req, "limit", kPageSize));
  json items = json::array();
  for (const auto& row : rows) items.push_back(item(row));
  res.set_content(json{{"items", items}, {"next_offset", offset + static_cast<long long>(rows.size())}}.dump(), "application/json");
}

void export_submissions(const httplib::Request& req, httplib::Response& res) {
  if (!signedIn(req, res)) return;
  const auto rows = store::pageByOffset(req.matches[1], 0, kExportLimit);
  std::string file = "empty.csv";
  if (!rows.empty()) file = rows.front().submission_id + "-" + (rows.front().values.count("name") ? rows.front().values.at("name") : "") + ".csv";
  json items = json::array();
  for (const auto& row : rows) items.push_back(item(row));
  res.set_content(json{{"file", file}, {"rows", items}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/forms/([\\w-]+)/submissions)", list_submissions);
  svr.Post(R"(/v1/forms/([\\w-]+)/exports)", export_submissions);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstdio>
#include <map>
#include <random>
#include <set>
#include <string>

#include "forms/store.h"  // store::ownerOf, pageByOffset, pageBefore, recordAudit

using json = nlohmann::json;

constexpr long long kPageSize = 50;
constexpr long long kExportLimit = 1000;
const std::set<std::string> kPiiFields = {"email", "phone"};

json item(const store::Submission& row, const std::map<std::string, std::string>& values) {
  return json{{"submission_id", row.submission_id}, {"values", values}};
}

std::map<std::string, std::string> redacted(const std::map<std::string, std::string>& values) {
  std::map<std::string, std::string> out;
  for (const auto& [name, value] : values) out[name] = kPiiFields.count(name) ? "[redacted]" : value;
  return out;
}

long long intParam(const httplib::Request& req, const std::string& name, long long fallback) {
  return req.has_param(name) ? std::stoll(req.get_param_value(name)) : fallback;
}

// The caller, if they own the form; "" once a 401 or 403 is written.
std::string owner(const httplib::Request& req, httplib::Response& res) {
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) {
    res.status = 401;
    res.set_content("X-User-Id is required", "text/plain");
    return "";
  }
  if (store::ownerOf(req.matches[1]) != user) {
    res.status = 403;
    res.set_content("only the form's owner reads its submissions", "text/plain");
    return "";
  }
  return user;
}

// The name is ours, not the submitter's: no value can become a path.
std::string exportName() {
  static std::mt19937_64 random{std::random_device{}()};
  char hex[17];
  std::snprintf(hex, sizeof hex, "%016llx", static_cast<unsigned long long>(random()));
  return std::string("export-") + hex + ".csv";
}

void list_submissions(const httplib::Request& req, httplib::Response& res) {
  if (owner(req, res).empty()) return;
  const long long limit = intParam(req, "limit", kPageSize);
  // A cursor is a position in the data, not in the list: new submissions cannot shift it.
  const auto rows = store::pageBefore(req.matches[1], intParam(req, "cursor", 0), limit);
  json items = json::array();
  for (const auto& row : rows) items.push_back(item(row, redacted(row.values)));
  const json next_cursor = static_cast<long long>(rows.size()) == limit ? json(std::to_string(rows.back().seq)) : json(nullptr);
  res.set_content(json{{"items", items}, {"next_cursor", next_cursor}}.dump(), "application/json");
}

void export_submissions(const httplib::Request& req, httplib::Response& res) {
  const std::string user = owner(req, res);
  if (user.empty()) return;
  const std::string form_id = req.matches[1];
  const auto rows = store::pageBefore(form_id, 0, kExportLimit);
  const std::string file = exportName();
  store::recordAudit(user, form_id, file);
  json items = json::array();
  for (const auto& row : rows) items.push_back(item(row, row.values));
  res.set_content(json{{"file", file}, {"rows", items}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/forms/([\\w-]+)/submissions)", list_submissions);
  svr.Post(R"(/v1/forms/([\\w-]+)/exports)", export_submissions);
}
`,
    },
  },
  harness: {
    python: `import json

from forms import store

SCHEMA = {"name": 80, "email": 80, "phone": 20, "message": 200}
OWNER = {"X-User-Id": "u-owner"}
MEMBER = {"X-User-Id": "u-member"}


def _setup(ctx, n=3, name=None):
    store.define_form("f-1", "u-owner", SCHEMA, SCHEMA)
    for i in range(1, n + 1):
        _add(i, name)
    return ctx.client(ctx.load("read").app)


def _add(i, name=None):
    return store.insert_submission("f-1", {"name": name or f"Person {i}", "email": f"p{i}@example.com", "phone": f"555-010{i}", "message": "Hello"})


def _audit(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("audit", 0, -1)]


async def check_owner_role(ctx):
    async with _setup(ctx) as c:
        r = await c.get("/v1/forms/f-1/submissions", headers=MEMBER)
        assert r.status_code == 403, f"a user who does not own form f-1 listed its submissions: {r.status_code}, expected 403"
        r = await c.post("/v1/forms/f-1/exports", headers=MEMBER)
        assert r.status_code == 403, f"a user who does not own form f-1 exported its submissions: {r.status_code}, expected 403"
        r = await c.get("/v1/forms/f-1/submissions")
        assert r.status_code == 401, f"a list without X-User-Id answered {r.status_code}, expected 401"
        r = await c.get("/v1/forms/f-1/submissions", headers=OWNER)
    assert r.status_code == 200 and len(r.json().get("items", [])) == 3, f"the owner's list answered {r.status_code} {r.text}, expected the 3 submissions"


async def check_redacted_default(ctx):
    async with _setup(ctx) as c:
        r = await c.get("/v1/forms/f-1/submissions", headers=OWNER)
    assert r.status_code == 200, f"the owner's list answered {r.status_code}: {r.text}"
    items = r.json().get("items", [])
    assert items, f"the list is empty: {r.text}"
    for entry in items:
        values = entry.get("values", {})
        assert values.get("email") == "[redacted]" and values.get("phone") == "[redacted]", f"the list shows {values}: email and phone must read [redacted] outside the audited export"
        assert values.get("name", "").startswith("Person"), f"the list hides fields that are not PII: {values}"
    assert "@example.com" not in r.text, "an email address is still in the list response"


async def check_audited_export(ctx):
    async with _setup(ctx) as c:
        r = await c.post("/v1/forms/f-1/exports", headers=OWNER)
    assert r.status_code == 200, f"the owner's export answered {r.status_code}: {r.text}"
    body = r.json()
    emails = sorted(row.get("values", {}).get("email") for row in body.get("rows", []))
    assert emails == ["p1@example.com", "p2@example.com", "p3@example.com"], f"the export carries emails {emails}: the export is the path with the real values"
    rows = _audit(ctx)
    assert rows == [{"actor": "u-owner", "form_id": "f-1", "file": body.get("file")}], f"the audit log holds {rows} after an export: nobody can tell who took the emails. Record the user, the form and the file"


async def check_generated_filename(ctx):
    async with _setup(ctx, n=1, name="../../etc/passwd") as c:
        first = await c.post("/v1/forms/f-1/exports", headers=OWNER)
        second = await c.post("/v1/forms/f-1/exports", headers=OWNER)
    assert first.status_code == 200, f"the owner's export answered {first.status_code}: {first.text}"
    file = first.json().get("file", "")
    assert "/" not in file and "\\\\" not in file and ".." not in file, f"the export file is named {file!r}: a submitted name chose a path for the export tool"
    assert "passwd" not in file and "Person" not in file, f"the export file name {file!r} is built from submitted values"
    assert file != second.json().get("file"), f"two exports got the same file name {file!r}: generate one per export"


async def check_cursor_pagination(ctx):
    async with _setup(ctx, n=5) as c:
        first = await c.get("/v1/forms/f-1/submissions?limit=2", headers=OWNER)
        page = first.json()
        assert [i["submission_id"] for i in page.get("items", [])] == ["sub-5", "sub-4"], f"the first page is {page}, expected the newest two, sub-5 and sub-4"
        cursor = page.get("next_cursor")
        assert cursor, f"the first page carries no next_cursor: {page}. A list that pages by offset repeats rows when someone submits between two pages"
        _add(6)  # someone submits while the owner reads
        second = (await c.get(f"/v1/forms/f-1/submissions?limit=2&cursor={cursor}", headers=OWNER)).json()
        assert [i["submission_id"] for i in second.get("items", [])] == ["sub-3", "sub-2"], f"after a new submission the second page is {second}, expected sub-3 and sub-2"
        third = (await c.get(f"/v1/forms/f-1/submissions?limit=2&cursor={second.get('next_cursor')}", headers=OWNER)).json()
    assert [i["submission_id"] for i in third.get("items", [])] == ["sub-1"] and not third.get("next_cursor"), f"the last page is {third}, expected sub-1 and no next_cursor"
`,
    typescript: `const SCHEMA = {name: 80, email: 80, phone: 20, message: 200};
const OWNER = {'X-User-Id': 'u-owner'};
const MEMBER = {'X-User-Id': 'u-member'};

async function setup(ctx, n = 3, name: string | null = null) {
  const store = ctx.load('/support/forms/store.ts');
  await store.defineForm('f-1', 'u-owner', SCHEMA, SCHEMA);
  const add = (i: number) =>
    store.insertSubmission('f-1', {name: name ?? \`Person \${i}\`, email: \`p\${i}@example.com\`, phone: \`555-010\${i}\`, message: 'Hello'});
  for (let i = 1; i <= n; i++) await add(i);
  return {c: ctx.client(ctx.load('read').app), add};
}

const ids = page => (page.items ?? []).map(i => i.submission_id);

export async function check_owner_role(ctx) {
  const {c} = await setup(ctx);
  let r = await c.get('/v1/forms/f-1/submissions', {headers: MEMBER});
  assert.equal(r.status, 403, \`a user who does not own form f-1 listed its submissions: \${r.status}, expected 403\`);
  r = await c.post('/v1/forms/f-1/exports', {headers: MEMBER});
  assert.equal(r.status, 403, \`a user who does not own form f-1 exported its submissions: \${r.status}, expected 403\`);
  r = await c.get('/v1/forms/f-1/submissions');
  assert.equal(r.status, 401, \`a list without X-User-Id answered \${r.status}, expected 401\`);
  r = await c.get('/v1/forms/f-1/submissions', {headers: OWNER});
  assert(r.status === 200 && r.json().items?.length === 3, \`the owner's list answered \${r.status} \${r.text}, expected the 3 submissions\`);
}

export async function check_redacted_default(ctx) {
  const {c} = await setup(ctx);
  const r = await c.get('/v1/forms/f-1/submissions', {headers: OWNER});
  assert.equal(r.status, 200, \`the owner's list answered \${r.status}: \${r.text}\`);
  const items = r.json().items ?? [];
  assert(items.length > 0, \`the list is empty: \${r.text}\`);
  for (const entry of items) {
    const values = entry.values ?? {};
    assert(values.email === '[redacted]' && values.phone === '[redacted]', \`the list shows \${JSON.stringify(values)}: email and phone must read [redacted] outside the audited export\`);
    assert(String(values.name ?? '').startsWith('Person'), \`the list hides fields that are not PII: \${JSON.stringify(values)}\`);
  }
  assert(!r.text.includes('@example.com'), 'an email address is still in the list response');
}

export async function check_audited_export(ctx) {
  const {c} = await setup(ctx);
  const r = await c.post('/v1/forms/f-1/exports', {headers: OWNER});
  assert.equal(r.status, 200, \`the owner's export answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const emails = (body.rows ?? []).map(row => row.values?.email).sort();
  assert.deepEqual(emails, ['p1@example.com', 'p2@example.com', 'p3@example.com'], \`the export carries emails \${JSON.stringify(emails)}: the export is the path with the real values\`);
  const rows = (ctx.redis.lrange('audit', 0, -1) as string[]).map(row => JSON.parse(row));
  assert.deepEqual(rows, [{actor: 'u-owner', form_id: 'f-1', file: body.file}], \`the audit log holds \${JSON.stringify(rows)} after an export: nobody can tell who took the emails. Record the user, the form and the file\`);
}

export async function check_generated_filename(ctx) {
  const {c} = await setup(ctx, 1, '../../etc/passwd');
  const first = await c.post('/v1/forms/f-1/exports', {headers: OWNER});
  const second = await c.post('/v1/forms/f-1/exports', {headers: OWNER});
  assert.equal(first.status, 200, \`the owner's export answered \${first.status}: \${first.text}\`);
  const file = String(first.json().file ?? '');
  assert(!file.includes('/') && !file.includes('\\\\') && !file.includes('..'), \`the export file is named \${JSON.stringify(file)}: a submitted name chose a path for the export tool\`);
  assert(!file.includes('passwd'), \`the export file name \${JSON.stringify(file)} is built from submitted values\`);
  assert.notEqual(file, second.json().file, \`two exports got the same file name \${JSON.stringify(file)}: generate one per export\`);
}

export async function check_cursor_pagination(ctx) {
  const {c, add} = await setup(ctx, 5);
  const page = (await c.get('/v1/forms/f-1/submissions?limit=2', {headers: OWNER})).json();
  assert.deepEqual(ids(page), ['sub-5', 'sub-4'], \`the first page is \${JSON.stringify(page)}, expected the newest two, sub-5 and sub-4\`);
  const cursor = page.next_cursor;
  assert(cursor, \`the first page carries no next_cursor: \${JSON.stringify(page)}. A list that pages by offset repeats rows when someone submits between two pages\`);
  await add(6); // someone submits while the owner reads
  const second = (await c.get(\`/v1/forms/f-1/submissions?limit=2&cursor=\${cursor}\`, {headers: OWNER})).json();
  assert.deepEqual(ids(second), ['sub-3', 'sub-2'], \`after a new submission the second page is \${JSON.stringify(second)}, expected sub-3 and sub-2\`);
  const third = (await c.get(\`/v1/forms/f-1/submissions?limit=2&cursor=\${second.next_cursor}\`, {headers: OWNER})).json();
  assert(JSON.stringify(ids(third)) === '["sub-1"]' && !third.next_cursor, \`the last page is \${JSON.stringify(third)}, expected sub-1 and no next_cursor\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"forms/store"

	"leetbuild/harness"
)

var readSchema = store.Schema{"name": 80, "email": 80, "phone": 20, "message": 200}

type readPage struct {
	Items []struct {
		SubmissionID string            \`json:"submission_id"\`
		Values       map[string]string \`json:"values"\`
	} \`json:"items"\`
	NextCursor *string \`json:"next_cursor"\`
}

type readExport struct {
	File string \`json:"file"\`
	Rows []struct {
		SubmissionID string            \`json:"submission_id"\`
		Values       map[string]string \`json:"values"\`
	} \`json:"rows"\`
}

func readAdd(ctx *harness.Ctx, i int, name string) {
	if name == "" {
		name = fmt.Sprintf("Person %d", i)
	}
	_, err := store.InsertSubmission(context.Background(), "f-1", map[string]string{"name": name, "email": fmt.Sprintf("p%d@example.com", i), "phone": fmt.Sprintf("555-010%d", i), "message": "Hello"})
	ctx.NoError(err, "InsertSubmission")
}

func readSetup(ctx *harness.Ctx, n int, name string) *harness.HTTP {
	ctx.NoError(store.DefineForm(context.Background(), "f-1", "u-owner", readSchema, readSchema), "DefineForm")
	for i := 1; i <= n; i++ {
		readAdd(ctx, i, name)
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readIDs(p readPage) []string {
	ids := []string{}
	for _, item := range p.Items {
		ids = append(ids, item.SubmissionID)
	}
	return ids
}

func CheckOwnerRole(ctx *harness.Ctx) {
	c := readSetup(ctx, 3, "")
	r := c.Get("/v1/forms/f-1/submissions", "X-User-Id", "u-member")
	ctx.Equal(r.Status, 403, "a user who does not own form f-1 listed its submissions")
	r = c.Post("/v1/forms/f-1/exports", nil, "X-User-Id", "u-member")
	ctx.Equal(r.Status, 403, "a user who does not own form f-1 exported its submissions")
	r = c.Get("/v1/forms/f-1/submissions")
	ctx.Equal(r.Status, 401, "a list without X-User-Id")
	r = c.Get("/v1/forms/f-1/submissions", "X-User-Id", "u-owner")
	var page readPage
	r.Decode(&page)
	ctx.Assert(r.Status == 200 && len(page.Items) == 3, "the owner's list answered %d %s, expected the 3 submissions", r.Status, r.Text())
}

func CheckRedactedDefault(ctx *harness.Ctx) {
	c := readSetup(ctx, 3, "")
	r := c.Get("/v1/forms/f-1/submissions", "X-User-Id", "u-owner")
	ctx.Equal(r.Status, 200, "the owner's list (%s)", r.Text())
	var page readPage
	r.Decode(&page)
	ctx.Assert(len(page.Items) > 0, "the list is empty: %s", r.Text())
	for _, item := range page.Items {
		ctx.Assert(item.Values["email"] == "[redacted]" && item.Values["phone"] == "[redacted]", "the list shows %v: email and phone must read [redacted] outside the audited export", item.Values)
		ctx.Assert(strings.HasPrefix(item.Values["name"], "Person"), "the list hides fields that are not PII: %v", item.Values)
	}
	ctx.Assert(!strings.Contains(r.Text(), "@example.com"), "an email address is still in the list response")
}

func CheckAuditedExport(ctx *harness.Ctx) {
	c := readSetup(ctx, 3, "")
	r := c.Post("/v1/forms/f-1/exports", nil, "X-User-Id", "u-owner")
	ctx.Equal(r.Status, 200, "the owner's export (%s)", r.Text())
	var body readExport
	r.Decode(&body)
	emails := []string{}
	for _, row := range body.Rows {
		emails = append(emails, row.Values["email"])
	}
	sort.Strings(emails)
	ctx.Equal(emails, []string{"p1@example.com", "p2@example.com", "p3@example.com"}, "the export is the path with the real values; its emails")
	var rows []map[string]string
	for _, text := range ctx.Redis.LRange("audit", 0, -1) {
		var row map[string]string
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an audit row must be JSON")
		rows = append(rows, row)
	}
	ctx.Equal(rows, []map[string]string{{"actor": "u-owner", "form_id": "f-1", "file": body.File}}, "after an export the audit log must say who took which form's submissions into which file; the audit rows")
}

func CheckGeneratedFilename(ctx *harness.Ctx) {
	c := readSetup(ctx, 1, "../../etc/passwd")
	first := c.Post("/v1/forms/f-1/exports", nil, "X-User-Id", "u-owner")
	second := c.Post("/v1/forms/f-1/exports", nil, "X-User-Id", "u-owner")
	ctx.Equal(first.Status, 200, "the owner's export (%s)", first.Text())
	var a, b readExport
	first.Decode(&a)
	second.Decode(&b)
	ctx.Assert(!strings.ContainsAny(a.File, "/\\\\") && !strings.Contains(a.File, ".."), "the export file is named %q: a submitted name chose a path for the export tool", a.File)
	ctx.Assert(!strings.Contains(a.File, "passwd"), "the export file name %q is built from submitted values", a.File)
	ctx.Assert(a.File != b.File, "two exports got the same file name %q: generate one per export", a.File)
}

func CheckCursorPagination(ctx *harness.Ctx) {
	c := readSetup(ctx, 5, "")
	var page readPage
	c.Get("/v1/forms/f-1/submissions?limit=2", "X-User-Id", "u-owner").Decode(&page)
	ctx.Equal(readIDs(page), []string{"sub-5", "sub-4"}, "the first page must hold the newest two")
	ctx.Assert(page.NextCursor != nil && *page.NextCursor != "", "the first page carries no next_cursor: a list that pages by offset repeats rows when someone submits between two pages")
	readAdd(ctx, 6, "") // someone submits while the owner reads
	var second readPage
	c.Get("/v1/forms/f-1/submissions?limit=2&cursor="+*page.NextCursor, "X-User-Id", "u-owner").Decode(&second)
	ctx.Equal(readIDs(second), []string{"sub-3", "sub-2"}, "after a new submission, the second page")
	ctx.Assert(second.NextCursor != nil, "the second page carries no next_cursor")
	var third readPage
	c.Get("/v1/forms/f-1/submissions?limit=2&cursor="+*second.NextCursor, "X-User-Id", "u-owner").Decode(&third)
	ctx.Equal(readIDs(third), []string{"sub-1"}, "the last page")
	ctx.Assert(third.NextCursor == nil || *third.NextCursor == "", "the last page must carry no next_cursor, got %s", harness.Show(third.NextCursor))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "forms/store.h"

using json = nlohmann::json;

namespace {

const store::Schema kSchema = {{"name", 80}, {"email", 80}, {"phone", 20}, {"message", 200}};

void add(int i, const std::string& name = "") {
  store::insertSubmission("f-1", {{"name", name.empty() ? "Person " + std::to_string(i) : name},
                                  {"email", "p" + std::to_string(i) + "@example.com"},
                                  {"phone", "555-010" + std::to_string(i)},
                                  {"message", "Hello"}});
}

harness::HTTP setup(harness::Ctx& ctx, int n = 3, const std::string& name = "") {
  store::defineForm("f-1", "u-owner", kSchema, kSchema);
  for (int i = 1; i <= n; i++) add(i, name);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json body(const harness::Response& r) {
  const json j = json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : json::object();
}

std::vector<std::string> ids(const json& page) {
  std::vector<std::string> out;
  if (page.contains("items") && page["items"].is_array()) {
    for (const auto& item : page["items"]) out.push_back(item.value("submission_id", ""));
  }
  return out;
}

std::string cursorOf(const json& page) {
  return page.contains("next_cursor") && page["next_cursor"].is_string() ? page["next_cursor"].get<std::string>() : "";
}

}  // namespace

void CheckOwnerRole(harness::Ctx& ctx) {
  auto c = setup(ctx);
  auto r = c.Get("/v1/forms/f-1/submissions", "X-User-Id", "u-member");
  ctx.Equal(r.Status, 403, "a user who does not own form f-1 listed its submissions");
  r = c.Post("/v1/forms/f-1/exports", "", "X-User-Id", "u-member");
  ctx.Equal(r.Status, 403, "a user who does not own form f-1 exported its submissions");
  r = c.Get("/v1/forms/f-1/submissions");
  ctx.Equal(r.Status, 401, "a list without X-User-Id");
  r = c.Get("/v1/forms/f-1/submissions", "X-User-Id", "u-owner");
  ctx.Assert(r.Status == 200 && ids(body(r)).size() == 3, "the owner's list answered %d %s, expected the 3 submissions", r.Status, r.Text());
}

void CheckRedactedDefault(harness::Ctx& ctx) {
  auto c = setup(ctx);
  const auto r = c.Get("/v1/forms/f-1/submissions", "X-User-Id", "u-owner");
  ctx.Equal(r.Status, 200, "the owner's list (%s)", r.Text());
  const json page = body(r);
  ctx.Assert(!ids(page).empty(), "the list is empty: %s", r.Text());
  for (const auto& item : page["items"]) {
    const json values = item.value("values", json::object());
    ctx.Assert(values.value("email", "") == "[redacted]" && values.value("phone", "") == "[redacted]", "the list shows %s: email and phone must read [redacted] outside the audited export", values.dump());
    ctx.Assert(values.value("name", "").rfind("Person", 0) == 0, "the list hides fields that are not PII: %s", values.dump());
  }
  ctx.Assert(r.Text().find("@example.com") == std::string::npos, "an email address is still in the list response");
}

void CheckAuditedExport(harness::Ctx& ctx) {
  auto c = setup(ctx);
  const auto r = c.Post("/v1/forms/f-1/exports", "", "X-User-Id", "u-owner");
  ctx.Equal(r.Status, 200, "the owner's export (%s)", r.Text());
  const json exported = body(r);
  std::vector<std::string> emails;
  if (exported.contains("rows")) {
    for (const auto& row : exported["rows"]) emails.push_back(row.value("values", json::object()).value("email", ""));
  }
  std::sort(emails.begin(), emails.end());
  ctx.Equal(emails, std::vector<std::string>{"p1@example.com", "p2@example.com", "p3@example.com"}, "the export is the path with the real values; its emails");
  std::vector<json> rows;
  for (const auto& text : ctx.Redis.LRange("audit", 0, -1)) rows.push_back(json::parse(text, nullptr, false));
  ctx.Equal(rows, std::vector<json>{json{{"actor", "u-owner"}, {"form_id", "f-1"}, {"file", exported.value("file", "")}}},
            "after an export the audit log must say who took which form's submissions into which file; the audit rows");
}

void CheckGeneratedFilename(harness::Ctx& ctx) {
  auto c = setup(ctx, 1, "../../etc/passwd");
  const auto first = c.Post("/v1/forms/f-1/exports", "", "X-User-Id", "u-owner");
  const auto second = c.Post("/v1/forms/f-1/exports", "", "X-User-Id", "u-owner");
  ctx.Equal(first.Status, 200, "the owner's export (%s)", first.Text());
  const std::string file = body(first).value("file", "");
  ctx.Assert(file.find_first_of("/\\\\") == std::string::npos && file.find("..") == std::string::npos, "the export file is named %q: a submitted name chose a path for the export tool", file);
  ctx.Assert(file.find("passwd") == std::string::npos, "the export file name %q is built from submitted values", file);
  ctx.Assert(file != body(second).value("file", ""), "two exports got the same file name %q: generate one per export", file);
}

void CheckCursorPagination(harness::Ctx& ctx) {
  auto c = setup(ctx, 5);
  const json page = body(c.Get("/v1/forms/f-1/submissions?limit=2", "X-User-Id", "u-owner"));
  ctx.Equal(ids(page), std::vector<std::string>{"sub-5", "sub-4"}, "the first page must hold the newest two");
  const std::string cursor = cursorOf(page);
  ctx.Assert(!cursor.empty(), "the first page carries no next_cursor: %s. A list that pages by offset repeats rows when someone submits between two pages", page.dump());
  add(6);  // someone submits while the owner reads
  const json second = body(c.Get("/v1/forms/f-1/submissions?limit=2&cursor=" + cursor, "X-User-Id", "u-owner"));
  ctx.Equal(ids(second), std::vector<std::string>{"sub-3", "sub-2"}, "after a new submission, the second page");
  const json third = body(c.Get("/v1/forms/f-1/submissions?limit=2&cursor=" + cursorOf(second), "X-User-Id", "u-owner"));
  ctx.Equal(ids(third), std::vector<std::string>{"sub-1"}, "the last page");
  ctx.Assert(cursorOf(third).empty(), "the last page must carry no next_cursor, got %s", third.dump());
}
`,
  },
  hints: [
    'Sign in as anyone and open a form: every email and phone number is there, and the export downloads it all with no trace. Page through while someone submits: page two repeats a row. Name yourself `../../etc/passwd` and export.',
    'Nothing compares the caller with `owner_of`; values are returned as stored; an offset counts rows from the newest, so a new row shifts every page; and the file name is concatenated from what a submitter typed.',
    'Check `owner_of(form) == X-User-Id` (403), map `PII_FIELDS` to `[redacted]` in the list, page with `page_before(form, cursor, limit)` and the last `seq` as `next_cursor`, name the export `export-{uuid4}.csv` and `record_audit` it.',
  ],
  debrief: `The read side decides who sees what strangers wrote, so the checks sit on the read: ownership before anything is loaded, redaction as the default view, and one path, audited, for the real values. A cursor names a place in the data (the last seq seen), so rows arriving at the head of the list cannot shift what the next page returns; an offset names a place in the list, which moves with every submission. The file name is generated because anything derived from submitted text is attacker input the moment a tool writes it to disk. A production read path also scopes the export to a time range, expires the file it writes, and lets a reviewer approve exports of forms with sensitive fields.`,
};
