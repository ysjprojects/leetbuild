import type {Step} from '@/lib/types';

export const pushEndpointStep: Step = {
  id: 'endpoint',
  concept: 'http',
  file: 'api',
  title: 'POST /v1/sync/push: each change against the revision it edited',
  focus: ['device', 'sync', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/sync/push\` with \`X-Device-Id\` and
\`{"changes": [{"doc_id", "base_revision", "content_hash", "body"}]}\`: for each change it checks
that the hash is 64 hex characters, writes the body with \`store.overwrite\` and answers
\`{"applied": [{"doc_id", "revision"}], "conflicts": []}\`. It syncs the demo laptop and hides four
flaws.

**Failure mode the checks target.** A laptop back from a month offline pushes edits of revisions the
phone replaced long ago, and they land over the phone's text. A body cut short in transit arrives
with the hash of the whole one. A push of every note a device ever touched holds a worker, and a
client with no device id is accepted.

- Apply each change with \`apply_change(doc_id, base_revision, content_hash, body, device)\`
  (\`docsync.revisions\`). A \`conflict\` outcome goes into \`conflicts\` as
  \`{doc_id, base_revision, current_revision}\` and writes nothing; \`applied\` and \`unchanged\` go
  into \`applied\`.
- \`content_hash\` must equal \`store.content_hash(body)\`: a mismatch is **400** naming the
  \`doc_id\`, checked for every change before any is applied.
- More than \`MAX_CHANGES\` (500) changes is **413**, before any apply.
- A missing \`X-Device-Id\` is **401**.`,
  sequence: {
    participants: ['Device', 'syncd', 'Redis'],
    messages: [
      {from: 'Device', to: 'syncd', label: 'POST /v1/sync/push · X-Device-Id · changes', kind: 'sync'},
      {from: 'syncd', to: 'syncd', label: 'device → 401 · count → 413 · every hash → 400', kind: 'sync'},
      {from: 'syncd', to: 'Redis', label: 'apply_change(doc, base, hash, body, device)', kind: 'sync'},
      {from: 'Redis', to: 'syncd', label: 'applied · unchanged · conflict + head revision', kind: 'reply'},
      {from: 'syncd', to: 'Device', label: '200 {applied, conflicts}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/sync/push',
      detail:
        'Register `POST /v1/sync/push`: a push of new documents applies them and answers each one with its revision.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/sync\/push["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/sync\/push['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/sync\/push"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sync"\s*\/\s*"push"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/sync\/push"/]},
      },
    },
    {
      id: 'stale-base',
      title: 'A stale base is a per-document conflict, not an overwrite',
      detail:
        'Each change goes through `apply_change`/`applyChange`, which writes only against the revision the device edited; a `conflict` outcome is answered in `conflicts` with the head revision. Nothing calls `overwrite`, which writes the next revision whatever the device saw.',
      match: {
        python: {all: [/apply_change\(/, /current_revision/], none: [/store\.overwrite\(/]},
        typescript: {all: [/applyChange\(/, /current_revision/], none: [/\boverwrite\(/]},
        go: {all: [/revisions\.ApplyChange\(/, /current_revision/], none: [/store\.Overwrite\(/]},
        scala: {all: [/Revisions\.applyChange\(/, /current_revision/], none: [/Store\.overwrite\(/]},
        cpp: {all: [/revisions::applyChange\(/, /current_revision/], none: [/store::overwrite\(/]},
      },
    },
    {
      id: 'content-hash',
      title: 'Checks every body against its content hash before applying any',
      detail:
        'Each `content_hash` is compared with the hash of its body (`store.content_hash`/`contentHash`), for the whole batch, before the first apply; a mismatch is **400**. A hex pattern only checks the shape, which a truncated body keeps.',
      match: {
        python: {all: [/store\.content_hash\(/, /\b400\b/], order: [/store\.content_hash\(/, /apply_change\(/]},
        typescript: {all: [/contentHash\(/, /\b400\b/], order: [/contentHash\(/, /applyChange\(/]},
        go: {
          all: [/store\.ContentHash\(/, /StatusBadRequest|\b400\b/],
          order: [/store\.ContentHash\(/, /revisions\.ApplyChange\(/],
        },
        scala: {
          all: [/Store\.contentHash\(/, /BadRequest|\b400\b/],
          order: [/Store\.contentHash\(/, /Revisions\.applyChange\(/],
        },
        cpp: {all: [/store::contentHash\(/, /\b400\b/], order: [/store::contentHash\(/, /revisions::applyChange\(/]},
      },
    },
    {
      id: 'batch-cap',
      title: 'Refuses more than 500 changes with 413',
      detail: 'A push with more than `MAX_CHANGES` (500) changes is **413** before anything is applied.',
      match: {
        python: {all: [/MAX_CHANGES/, /\b413\b/]},
        typescript: {all: [/MAX_CHANGES/, /\b413\b/]},
        go: {all: [/maxChanges/, /StatusRequestEntityTooLarge|\b413\b/]},
        scala: {all: [/MaxChanges/, /PayloadTooLarge|RequestEntityTooLarge|\b413\b/]},
        cpp: {all: [/kMaxChanges/, /\b413\b/]},
      },
    },
    {
      id: 'device-auth',
      title: 'A push without X-Device-Id is 401',
      detail: 'The device is read from `X-Device-Id`; a push without it is **401** and writes nothing.',
      match: {
        python: {all: [/\b401\b/]},
        typescript: {all: [/\b401\b/]},
        go: {all: [/StatusUnauthorized|\b401\b/]},
        scala: {all: [/Unauthorized|\b401\b/]},
        cpp: {all: [/\b401\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import re

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from docsync import store  # head, content_hash, overwrite
from docsync.revisions import apply_change  # step 2: applies a change only against the revision it edited

app = FastAPI()

HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class Change(BaseModel):
    doc_id: str
    base_revision: int
    content_hash: str
    body: str


class Push(BaseModel):
    changes: list[Change]


@app.post("/v1/sync/push")
def push(body: Push, x_device_id: str = Header()) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    applied = []
    for change in body.changes:
        if not HASH_RE.match(change.content_hash):
            raise HTTPException(status_code=400, detail={"error": "bad_hash", "doc_id": change.doc_id})
        revision = store.overwrite(change.doc_id, change.content_hash, change.body, x_device_id)
        applied.append({"doc_id": change.doc_id, "revision": revision})
    return {"applied": applied, "conflicts": []}
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from docsync import store  # head, content_hash, overwrite
from docsync.revisions import apply_change  # step 2: applies a change only against the revision it edited

app = FastAPI()

MAX_CHANGES = 500


class Change(BaseModel):
    doc_id: str
    base_revision: int
    content_hash: str
    body: str


class Push(BaseModel):
    changes: list[Change]


@app.post("/v1/sync/push")
def push(body: Push, request: Request):
    device = request.headers.get("x-device-id", "")
    if not device:
        return JSONResponse({"error": "missing_device"}, status_code=401)
    if len(body.changes) > MAX_CHANGES:
        return JSONResponse({"error": "too_many_changes", "max": MAX_CHANGES}, status_code=413)
    # Every hash is checked before anything is written: a batch is accepted whole or not at all.
    for change in body.changes:
        if store.content_hash(change.body) != change.content_hash:
            return JSONResponse({"error": "hash_mismatch", "doc_id": change.doc_id}, status_code=400)
    applied, conflicts = [], []
    for change in body.changes:
        outcome = apply_change(change.doc_id, change.base_revision, change.content_hash, change.body, device)
        if outcome["status"] == "conflict":
            conflicts.append({"doc_id": change.doc_id, "base_revision": change.base_revision, "current_revision": outcome["revision"]})
        else:
            applied.append({"doc_id": change.doc_id, "revision": outcome["revision"]})
    return {"applied": applied, "conflicts": conflicts}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {applyChange} from 'docsync/revisions'; // step 2: applies a change only against the revision it edited
import {contentHash, overwrite} from 'docsync/store';

export const app = Fastify();

const HASH_PATTERN = /^[0-9a-f]{64}$/;

interface Change {
  doc_id: string;
  base_revision: number;
  content_hash: string;
  body: string;
}

app.post('/v1/sync/push', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const device = String(request.headers['x-device-id'] ?? '');
  const {changes} = request.body as {changes: Change[]};
  const applied: {doc_id: string; revision: number}[] = [];
  for (const change of changes) {
    if (!HASH_PATTERN.test(change.content_hash)) return reply.code(400).send({error: 'bad_hash', doc_id: change.doc_id});
    const revision = await overwrite(change.doc_id, change.content_hash, change.body, device);
    applied.push({doc_id: change.doc_id, revision});
  }
  return {applied, conflicts: []};
});
`,
      solution: `import Fastify from 'fastify';

import {applyChange} from 'docsync/revisions'; // step 2: applies a change only against the revision it edited
import {contentHash, overwrite} from 'docsync/store';

export const app = Fastify();

export const MAX_CHANGES = 500;

interface Change {
  doc_id: string;
  base_revision: number;
  content_hash: string;
  body: string;
}

app.post('/v1/sync/push', async (request, reply) => {
  const device = request.headers['x-device-id'];
  if (typeof device !== 'string' || device === '') return reply.code(401).send({error: 'missing_device'});
  const {changes} = request.body as {changes: Change[]};
  if (changes.length > MAX_CHANGES) return reply.code(413).send({error: 'too_many_changes', max: MAX_CHANGES});
  // Every hash is checked before anything is written: a batch is accepted whole or not at all.
  const corrupt = changes.find(change => contentHash(change.body) !== change.content_hash);
  if (corrupt !== undefined) return reply.code(400).send({error: 'hash_mismatch', doc_id: corrupt.doc_id});
  const applied: {doc_id: string; revision: number}[] = [];
  const conflicts: {doc_id: string; base_revision: number; current_revision: number}[] = [];
  for (const change of changes) {
    const outcome = await applyChange(change.doc_id, change.base_revision, change.content_hash, change.body, device);
    if (outcome.status === 'conflict') {
      conflicts.push({doc_id: change.doc_id, base_revision: change.base_revision, current_revision: outcome.revision});
    } else {
      applied.push({doc_id: change.doc_id, revision: outcome.revision});
    }
  }
  return {applied, conflicts};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"docsync/store" // store.Head, ContentHash, Overwrite; revisions.ApplyChange (step 2) applies a change only against the revision it edited
)

var hashPattern = regexp.MustCompile("^[0-9a-f]{64}$")

type change struct {
	DocID        string \`json:"doc_id"\`
	BaseRevision int64  \`json:"base_revision"\`
	ContentHash  string \`json:"content_hash"\`
	Body         string \`json:"body"\`
}

type applied struct {
	DocID    string \`json:"doc_id"\`
	Revision int64  \`json:"revision"\`
}

type conflict struct {
	DocID           string \`json:"doc_id"\`
	BaseRevision    int64  \`json:"base_revision"\`
	CurrentRevision int64  \`json:"current_revision"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func push(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	device := r.Header.Get("X-Device-Id")
	var body struct {
		Changes []change \`json:"changes"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "bad_body"})
		return
	}
	done := []applied{}
	for _, c := range body.Changes {
		if !hashPattern.MatchString(c.ContentHash) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "bad_hash", "doc_id": c.DocID})
			return
		}
		revision, err := store.Overwrite(r.Context(), c.DocID, c.ContentHash, c.Body, device)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
			return
		}
		done = append(done, applied{DocID: c.DocID, Revision: revision})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"applied": done, "conflicts": []conflict{}})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/sync/push", push)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"docsync/revisions" // revisions.ApplyChange: step 2, applies a change only against the revision it edited
	"docsync/store"     // store.Head, ContentHash, Overwrite
)

const maxChanges = 500

type change struct {
	DocID        string \`json:"doc_id"\`
	BaseRevision int64  \`json:"base_revision"\`
	ContentHash  string \`json:"content_hash"\`
	Body         string \`json:"body"\`
}

type applied struct {
	DocID    string \`json:"doc_id"\`
	Revision int64  \`json:"revision"\`
}

type conflict struct {
	DocID           string \`json:"doc_id"\`
	BaseRevision    int64  \`json:"base_revision"\`
	CurrentRevision int64  \`json:"current_revision"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func push(rw http.ResponseWriter, r *http.Request) {
	device := r.Header.Get("X-Device-Id")
	if device == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_device"})
		return
	}
	var body struct {
		Changes []change \`json:"changes"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "bad_body"})
		return
	}
	if len(body.Changes) > maxChanges {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]any{"error": "too_many_changes", "max": maxChanges})
		return
	}
	// Every hash is checked before anything is written: a batch is accepted whole or not at all.
	for _, c := range body.Changes {
		if store.ContentHash(c.Body) != c.ContentHash {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "hash_mismatch", "doc_id": c.DocID})
			return
		}
	}
	done, conflicts := []applied{}, []conflict{}
	for _, c := range body.Changes {
		outcome, err := revisions.ApplyChange(r.Context(), c.DocID, c.BaseRevision, c.ContentHash, c.Body, device)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
			return
		}
		if outcome.Status == "conflict" {
			conflicts = append(conflicts, conflict{DocID: c.DocID, BaseRevision: c.BaseRevision, CurrentRevision: outcome.Revision})
		} else {
			done = append(done, applied{DocID: c.DocID, Revision: outcome.Revision})
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"applied": done, "conflicts": conflicts})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/sync/push", push)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import docsync.{Revisions, Store} // Store.contentHash, overwrite; Revisions.applyChange (step 2) applies a change only against the revision it edited

object Api {
  final case class Change(docId: String, baseRevision: Long, contentHash: String, body: String)

  private val HashPattern = "^[0-9a-f]{64}$".r

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def changesOf(raw: String): Vector[Change] =
    raw.parseJson.asJsObject.fields.get("changes") match {
      case Some(JsArray(items)) =>
        items.map { item =>
          val fields = item.asJsObject.fields
          def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
          Change(text("doc_id"), fields.get("base_revision").collect { case JsNumber(n) => n.toLong }.getOrElse(0L), text("content_hash"), text("body"))
        }
      case _ => Vector.empty
    }

  val route: Route = path("v1" / "sync" / "push") {
    post {
      headerValueByName("X-Device-Id") { device =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val applied = Vector.newBuilder[JsObject]
          var badHash: Option[String] = None
          for (c <- changesOf(raw) if badHash.isEmpty) {
            if (HashPattern.findFirstIn(c.contentHash).isEmpty) badHash = Some(c.docId)
            else applied += JsObject("doc_id" -> JsString(c.docId), "revision" -> JsNumber(Store.overwrite(c.docId, c.contentHash, c.body, device)))
          }
          badHash match {
            case Some(docId) => complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("bad_hash"), "doc_id" -> JsString(docId))))
            case None => complete(json(StatusCodes.OK, JsObject("applied" -> JsArray(applied.result()), "conflicts" -> JsArray())))
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

import docsync.{Revisions, Store} // Store.contentHash, overwrite; Revisions.applyChange (step 2) applies a change only against the revision it edited

object Api {
  final case class Change(docId: String, baseRevision: Long, contentHash: String, body: String)

  val MaxChanges = 500

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def changesOf(raw: String): Vector[Change] =
    raw.parseJson.asJsObject.fields.get("changes") match {
      case Some(JsArray(items)) =>
        items.map { item =>
          val fields = item.asJsObject.fields
          def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
          Change(text("doc_id"), fields.get("base_revision").collect { case JsNumber(n) => n.toLong }.getOrElse(0L), text("content_hash"), text("body"))
        }
      case _ => Vector.empty
    }

  val route: Route = path("v1" / "sync" / "push") {
    post {
      optionalHeaderValueByName("X-Device-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing_device"))))
        case Some(device) =>
          entity(as[String]) { raw =>
            val changes = changesOf(raw)
            if (changes.size > MaxChanges) {
              complete(json(StatusCodes.PayloadTooLarge, JsObject("error" -> JsString("too_many_changes"), "max" -> JsNumber(MaxChanges))))
            } else {
              // Every hash is checked before anything is written: a batch is accepted whole or not at all.
              changes.find(c => Store.contentHash(c.body) != c.contentHash) match {
                case Some(corrupt) => complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("hash_mismatch"), "doc_id" -> JsString(corrupt.docId))))
                case None => complete(json(StatusCodes.OK, applyAll(changes, device)))
              }
            }
          }
      }
    }
  }

  private def applyAll(changes: Vector[Change], device: String): JsObject = {
    val outcomes = changes.map(c => c -> Revisions.applyChange(c.docId, c.baseRevision, c.contentHash, c.body, device))
    val applied = outcomes.collect { case (c, o) if o.status != "conflict" => JsObject("doc_id" -> JsString(c.docId), "revision" -> JsNumber(o.revision)) }
    val conflicts = outcomes.collect {
      case (c, o) if o.status == "conflict" =>
        JsObject("doc_id" -> JsString(c.docId), "base_revision" -> JsNumber(c.baseRevision), "current_revision" -> JsNumber(o.revision))
    }
    JsObject("applied" -> JsArray(applied), "conflicts" -> JsArray(conflicts))
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <string>

#include "docsync/revisions.h"  // revisions::applyChange (step 2): applies a change only against the revision it edited
#include "docsync/store.h"      // store::head, contentHash, overwrite

using json = nlohmann::json;

const std::regex kHashPattern("^[0-9a-f]{64}$");

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void push(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string device = req.get_header_value("X-Device-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("changes") || !body.at("changes").is_array()) return reply(res, 400, json{{"error", "bad_body"}});
  json applied = json::array();
  for (const json& change : body.at("changes")) {
    const std::string doc_id = change.value("doc_id", "");
    const std::string hash = change.value("content_hash", "");
    if (!std::regex_match(hash, kHashPattern)) return reply(res, 400, json{{"error", "bad_hash"}, {"doc_id", doc_id}});
    const long long revision = store::overwrite(doc_id, hash, change.value("body", ""), device);
    applied.push_back(json{{"doc_id", doc_id}, {"revision", revision}});
  }
  reply(res, 200, json{{"applied", applied}, {"conflicts", json::array()}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/sync/push", push);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "docsync/revisions.h"  // revisions::applyChange (step 2): applies a change only against the revision it edited
#include "docsync/store.h"      // store::head, contentHash, overwrite

using json = nlohmann::json;

constexpr size_t kMaxChanges = 500;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void push(const httplib::Request& req, httplib::Response& res) {
  const std::string device = req.get_header_value("X-Device-Id");
  if (device.empty()) return reply(res, 401, json{{"error", "missing_device"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("changes") || !body.at("changes").is_array()) return reply(res, 400, json{{"error", "bad_body"}});
  const json& changes = body.at("changes");
  if (changes.size() > kMaxChanges) return reply(res, 413, json{{"error", "too_many_changes"}, {"max", kMaxChanges}});
  // Every hash is checked before anything is written: a batch is accepted whole or not at all.
  for (const json& change : changes) {
    if (store::contentHash(change.value("body", "")) != change.value("content_hash", "")) {
      return reply(res, 400, json{{"error", "hash_mismatch"}, {"doc_id", change.value("doc_id", "")}});
    }
  }
  json applied = json::array();
  json conflicts = json::array();
  for (const json& change : changes) {
    const std::string doc_id = change.value("doc_id", "");
    const long long base = change.value("base_revision", 0LL);
    const store::Outcome outcome = revisions::applyChange(doc_id, base, change.value("content_hash", ""), change.value("body", ""), device);
    if (outcome.status == "conflict") {
      conflicts.push_back(json{{"doc_id", doc_id}, {"base_revision", base}, {"current_revision", outcome.revision}});
    } else {
      applied.push_back(json{{"doc_id", doc_id}, {"revision", outcome.revision}});
    }
  }
  reply(res, 200, json{{"applied", applied}, {"conflicts", conflicts}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/sync/push", push);
}
`,
    },
  },
  harness: {
    python: `from docsync import store


def _change(doc_id, base, body):
    return {"doc_id": doc_id, "base_revision": base, "content_hash": store.content_hash(body), "body": body}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _push(c, changes, device="laptop"):
    headers = {"X-Device-Id": device} if device else {}
    return await c.post("/v1/sync/push", json={"changes": changes}, headers=headers)


def _ok(r, what):
    assert r.status_code == 200, f"{what} answered {r.status_code}: {r.text}"
    return r.json()


async def check_route(ctx):
    async with _api(ctx) as c:
        body = _ok(await _push(c, [_change("d-1", 0, "groceries: milk"), _change("d-2", 0, "call the plumber")]), "a push of two new documents")
    applied = {a.get("doc_id"): a.get("revision") for a in body.get("applied", [])}
    assert set(applied) == {"d-1", "d-2"} and body.get("conflicts") == [], f"both new documents must be applied with no conflicts, got {body}"
    head = store.head("d-1")
    assert head is not None and head["body"] == "groceries: milk" and head["device"] == "laptop", f"d-1's head is {head}, expected the laptop's body"
    assert applied["d-1"] == head["revision"], f"the push answered revision {applied['d-1']} for d-1 while its head is at {head['revision']}"


async def check_stale_base(ctx):
    async with _api(ctx) as c:
        rev1 = _ok(await _push(c, [_change("d-1", 0, "draft agenda")]), "the laptop's first push")["applied"][0]["revision"]
        rev2 = _ok(await _push(c, [_change("d-1", rev1, "agenda: budget, hiring")], device="phone"), "the phone's edit of revision 1")["applied"][0]["revision"]
        # The laptop was offline: it still edits revision 1, and it brings a new note along.
        stale = _ok(await _push(c, [_change("d-1", rev1, "agenda: offsite"), _change("d-9", 0, "packing list")]), "the laptop's push of a stale edit")
    conflicts = stale.get("conflicts")
    assert conflicts == [{"doc_id": "d-1", "base_revision": rev1, "current_revision": rev2}], f"the laptop edited revision {rev1} of d-1 while its head is at {rev2}: the push must answer that conflict, got conflicts {conflicts}"
    head = store.head("d-1")
    assert head["body"] == "agenda: budget, hiring", f"the stale edit was written over the phone's: d-1 reads {head['body']!r}. Apply only against the revision the device edited"
    assert [a.get("doc_id") for a in stale.get("applied", [])] == ["d-9"], f"the rest of the batch must still apply, got applied {stale.get('applied')}"


async def check_content_hash(ctx):
    good = _change("d-1", 0, "meeting notes")
    cut = {**_change("d-2", 0, "budget 2026: final figures"), "body": "budget 2026: fin"}  # truncated in transit, the hash of the whole body
    async with _api(ctx) as c:
        r = await _push(c, [good, cut])
        assert r.status_code == 400, f"a change whose body does not match its content_hash answered {r.status_code}, expected 400: {r.text}"
        assert "d-2" in r.text, f"the 400 must name the change (d-2), got {r.text}"
        assert store.head("d-2") is None, f"the truncated body reached storage: {store.head('d-2')}"
        assert store.head("d-1") is None, "d-1 was written before d-2's hash was checked: check every change before applying any"
        r = await _push(c, [good])
    assert r.status_code == 200 and store.head("d-1") is not None, f"the intact change on its own must be applied, got {r.status_code}: {r.text}"


async def check_batch_cap(ctx):
    changes = [_change(f"d-{i}", 0, f"note {i}") for i in range(501)]
    async with _api(ctx) as c:
        r = await _push(c, changes)
        assert r.status_code == 413, f"a push of 501 changes answered {r.status_code}, expected 413 (MAX_CHANGES is 500)"
        written = ctx.redis.zcard("changes")
        assert written == 0, f"the refused push still wrote {written} documents: check the size before applying anything"
        r = await _push(c, changes[:500])
    assert r.status_code == 200 and len(r.json().get("applied", [])) == 500, f"a push of exactly 500 changes must be applied, got {r.status_code}"


async def check_device_auth(ctx):
    async with _api(ctx) as c:
        r = await _push(c, [_change("d-1", 0, "shopping list")], device=None)
    assert r.status_code == 401, f"a push without X-Device-Id answered {r.status_code}, expected 401: {r.text}"
    assert store.head("d-1") is None, "a push without a device must write nothing"
`,
    typescript: `function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), store: ctx.load('/support/docsync/store.ts')};
}

const change = (store, docId: string, base: number, body: string) => ({doc_id: docId, base_revision: base, content_hash: store.contentHash(body), body});

const push = (c, changes, device: string | null = 'laptop') =>
  c.post('/v1/sync/push', {json: {changes}, headers: device === null ? {} : {'X-Device-Id': device}});

function ok(r, what: string) {
  assert.equal(r.status, 200, \`\${what} answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const body = ok(await push(c, [change(store, 'd-1', 0, 'groceries: milk'), change(store, 'd-2', 0, 'call the plumber')]), 'a push of two new documents');
  const applied = Object.fromEntries((body.applied ?? []).map(a => [a.doc_id, a.revision]));
  assert(Object.keys(applied).sort().join() === 'd-1,d-2' && JSON.stringify(body.conflicts) === '[]', \`both new documents must be applied with no conflicts, got \${JSON.stringify(body)}\`);
  const head = await store.head('d-1');
  assert(head !== null && head.body === 'groceries: milk' && head.device === 'laptop', \`d-1's head is \${JSON.stringify(head)}, expected the laptop's body\`);
  assert.equal(applied['d-1'], head.revision, \`the push answered revision \${applied['d-1']} for d-1 while its head is at \${head.revision}\`);
}

export async function check_stale_base(ctx) {
  const {c, store} = api(ctx);
  const rev1 = ok(await push(c, [change(store, 'd-1', 0, 'draft agenda')]), "the laptop's first push").applied[0].revision;
  const rev2 = ok(await push(c, [change(store, 'd-1', rev1, 'agenda: budget, hiring')], 'phone'), "the phone's edit of revision 1").applied[0].revision;
  // The laptop was offline: it still edits revision 1, and it brings a new note along.
  const stale = ok(await push(c, [change(store, 'd-1', rev1, 'agenda: offsite'), change(store, 'd-9', 0, 'packing list')]), "the laptop's push of a stale edit");
  assert.deepStrictEqual(stale.conflicts, [{doc_id: 'd-1', base_revision: rev1, current_revision: rev2}], \`the laptop edited revision \${rev1} of d-1 while its head is at \${rev2}: the push must answer that conflict, got conflicts \${JSON.stringify(stale.conflicts)}\`);
  const head = await store.head('d-1');
  assert.equal(head.body, 'agenda: budget, hiring', \`the stale edit was written over the phone's: d-1 reads \${JSON.stringify(head.body)}. Apply only against the revision the device edited\`);
  assert.deepStrictEqual((stale.applied ?? []).map(a => a.doc_id), ['d-9'], \`the rest of the batch must still apply, got applied \${JSON.stringify(stale.applied)}\`);
}

export async function check_content_hash(ctx) {
  const {c, store} = api(ctx);
  const good = change(store, 'd-1', 0, 'meeting notes');
  const cut = {...change(store, 'd-2', 0, 'budget 2026: final figures'), body: 'budget 2026: fin'}; // truncated in transit, the hash of the whole body
  let r = await push(c, [good, cut]);
  assert.equal(r.status, 400, \`a change whose body does not match its content_hash answered \${r.status}, expected 400: \${r.text}\`);
  assert(r.text.includes('d-2'), \`the 400 must name the change (d-2), got \${r.text}\`);
  assert.equal(await store.head('d-2'), null, 'the truncated body reached storage');
  assert.equal(await store.head('d-1'), null, "d-1 was written before d-2's hash was checked: check every change before applying any");
  r = await push(c, [good]);
  assert(r.status === 200 && (await store.head('d-1')) !== null, \`the intact change on its own must be applied, got \${r.status}: \${r.text}\`);
}

export async function check_batch_cap(ctx) {
  const {c, store} = api(ctx);
  const changes = Array.from({length: 501}, (_, i) => change(store, \`d-\${i}\`, 0, \`note \${i}\`));
  let r = await push(c, changes);
  assert.equal(r.status, 413, \`a push of 501 changes answered \${r.status}, expected 413 (MAX_CHANGES is 500)\`);
  const written = ctx.redis.zcard('changes');
  assert.equal(written, 0, \`the refused push still wrote \${written} documents: check the size before applying anything\`);
  r = await push(c, changes.slice(0, 500));
  assert(r.status === 200 && r.json().applied.length === 500, \`a push of exactly 500 changes must be applied, got \${r.status}\`);
}

export async function check_device_auth(ctx) {
  const {c, store} = api(ctx);
  const r = await push(c, [change(store, 'd-1', 0, 'shopping list')], null);
  assert.equal(r.status, 401, \`a push without X-Device-Id answered \${r.status}, expected 401: \${r.text}\`);
  assert.equal(await store.head('d-1'), null, 'a push without a device must write nothing');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"docsync/store"

	"leetbuild/harness"
)

var pushBg = context.Background()

type pushReply struct {
	Applied []struct {
		DocID    string \`json:"doc_id"\`
		Revision int64  \`json:"revision"\`
	} \`json:"applied"\`
	Conflicts []struct {
		DocID           string \`json:"doc_id"\`
		BaseRevision    int64  \`json:"base_revision"\`
		CurrentRevision int64  \`json:"current_revision"\`
	} \`json:"conflicts"\`
}

func pushAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func pushChange(docID string, base int64, body string) map[string]any {
	return map[string]any{"doc_id": docID, "base_revision": base, "content_hash": store.ContentHash(body), "body": body}
}

func pushAs(c *harness.HTTP, device string, changes ...map[string]any) *harness.Response {
	payload := map[string]any{"changes": changes}
	if device == "" {
		return c.Post("/v1/sync/push", payload)
	}
	return c.Post("/v1/sync/push", payload, "X-Device-Id", device)
}

func pushOK(ctx *harness.Ctx, r *harness.Response, what string) pushReply {
	ctx.Equal(r.Status, 200, "%s (%s)", what, r.Text())
	var out pushReply
	r.Decode(&out)
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := pushAPI(ctx)
	out := pushOK(ctx, pushAs(c, "laptop", pushChange("d-1", 0, "groceries: milk"), pushChange("d-2", 0, "call the plumber")), "a push of two new documents")
	applied := map[string]int64{}
	for _, a := range out.Applied {
		applied[a.DocID] = a.Revision
	}
	ctx.Assert(len(applied) == 2 && applied["d-1"] > 0 && applied["d-2"] > 0 && len(out.Conflicts) == 0, "both new documents must be applied with no conflicts, got %+v", out)
	head := store.Head(pushBg, "d-1")
	ctx.Assert(head != nil && head.Body == "groceries: milk" && head.Device == "laptop", "d-1's head is %+v, expected the laptop's body", head)
	ctx.Equal(applied["d-1"], head.Revision, "the push must answer d-1's head revision; the answered revision")
}

func CheckStaleBase(ctx *harness.Ctx) {
	c := pushAPI(ctx)
	rev1 := pushOK(ctx, pushAs(c, "laptop", pushChange("d-1", 0, "draft agenda")), "the laptop's first push").Applied[0].Revision
	rev2 := pushOK(ctx, pushAs(c, "phone", pushChange("d-1", rev1, "agenda: budget, hiring")), "the phone's edit of revision 1").Applied[0].Revision
	// The laptop was offline: it still edits revision 1, and it brings a new note along.
	stale := pushOK(ctx, pushAs(c, "laptop", pushChange("d-1", rev1, "agenda: offsite"), pushChange("d-9", 0, "packing list")), "the laptop's push of a stale edit")
	ctx.Assert(len(stale.Conflicts) == 1 && stale.Conflicts[0].DocID == "d-1" && stale.Conflicts[0].BaseRevision == rev1 && stale.Conflicts[0].CurrentRevision == rev2,
		"the laptop edited revision %d of d-1 while its head is at %d: the push must answer that conflict, got conflicts %+v", rev1, rev2, stale.Conflicts)
	head := store.Head(pushBg, "d-1")
	ctx.Equal(head.Body, "agenda: budget, hiring", "the stale edit was written over the phone's (apply only against the revision the device edited); d-1's body")
	ctx.Assert(len(stale.Applied) == 1 && stale.Applied[0].DocID == "d-9", "the rest of the batch must still apply, got applied %+v", stale.Applied)
}

func CheckContentHash(ctx *harness.Ctx) {
	c := pushAPI(ctx)
	good := pushChange("d-1", 0, "meeting notes")
	cut := pushChange("d-2", 0, "budget 2026: final figures")
	cut["body"] = "budget 2026: fin" // truncated in transit, the hash of the whole body
	r := pushAs(c, "laptop", good, cut)
	ctx.Equal(r.Status, 400, "a change whose body does not match its content_hash (%s)", r.Text())
	ctx.Assert(strings.Contains(r.Text(), "d-2"), "the 400 must name the change (d-2), got %s", r.Text())
	ctx.Assert(store.Head(pushBg, "d-2") == nil, "the truncated body reached storage: %+v", store.Head(pushBg, "d-2"))
	ctx.Assert(store.Head(pushBg, "d-1") == nil, "d-1 was written before d-2's hash was checked: check every change before applying any")
	r = pushAs(c, "laptop", good)
	ctx.Assert(r.Status == 200 && store.Head(pushBg, "d-1") != nil, "the intact change on its own must be applied, got %d: %s", r.Status, r.Text())
}

func CheckBatchCap(ctx *harness.Ctx) {
	c := pushAPI(ctx)
	changes := make([]map[string]any, 501)
	for i := range changes {
		changes[i] = pushChange(fmt.Sprintf("d-%d", i), 0, fmt.Sprintf("note %d", i))
	}
	r := pushAs(c, "laptop", changes...)
	ctx.Equal(r.Status, 413, "a push of 501 changes (MAX_CHANGES is 500)")
	ctx.Equal(ctx.Redis.ZCard("changes"), int64(0), "the refused push must write nothing (check the size before applying anything); documents written")
	out := pushOK(ctx, pushAs(c, "laptop", changes[:500]...), "a push of exactly 500 changes")
	ctx.Equal(len(out.Applied), 500, "a push of exactly 500 changes must be applied; applied")
}

func CheckDeviceAuth(ctx *harness.Ctx) {
	c := pushAPI(ctx)
	r := pushAs(c, "", pushChange("d-1", 0, "shopping list"))
	ctx.Equal(r.Status, 401, "a push without X-Device-Id (%s)", r.Text())
	ctx.Assert(store.Head(pushBg, "d-1") == nil, "a push without a device must write nothing")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "docsync/store.h"

namespace {

using Json = nlohmann::json;

harness::HTTP pushApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

Json pushChange(const std::string& doc_id, long long base, const std::string& body) {
  return Json{{"doc_id", doc_id}, {"base_revision", base}, {"content_hash", store::contentHash(body)}, {"body", body}};
}

harness::Response pushAs(harness::HTTP& c, const Json& changes, const std::string& device = "laptop") {
  const std::string payload = Json{{"changes", changes}}.dump();
  if (device.empty()) return c.Post("/v1/sync/push", payload, "Content-Type", "application/json");
  return c.Post("/v1/sync/push", payload, "Content-Type", "application/json", "X-Device-Id", device);
}

Json pushOk(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  ctx.Equal(r.Status, 200, "%s (%s)", what, r.Text());
  return Json::parse(r.Text(), nullptr, false);
}

long long firstRevision(const Json& body) {
  return body.value("applied", Json::array()).empty() ? 0LL : body["applied"][0].value("revision", 0LL);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = pushApi(ctx);
  const Json body = pushOk(ctx, pushAs(c, Json::array({pushChange("d-1", 0, "groceries: milk"), pushChange("d-2", 0, "call the plumber")})), "a push of two new documents");
  long long d1 = 0;
  size_t count = 0;
  for (const Json& a : body.value("applied", Json::array())) {
    count++;
    if (a.value("doc_id", "") == "d-1") d1 = a.value("revision", 0LL);
  }
  ctx.Assert(count == 2 && d1 > 0 && body.value("conflicts", Json::array()).empty(), "both new documents must be applied with no conflicts, got %s", body.dump());
  const auto head = store::head("d-1");
  ctx.Assert(head && head->body == "groceries: milk" && head->device == "laptop", "d-1's head must hold the laptop's body, got %s", head ? head->body : "nothing");
  ctx.Equal(d1, head->revision, "the push must answer d-1's head revision; the answered revision");
}

void CheckStaleBase(harness::Ctx& ctx) {
  auto c = pushApi(ctx);
  const long long rev1 = firstRevision(pushOk(ctx, pushAs(c, Json::array({pushChange("d-1", 0, "draft agenda")})), "the laptop's first push"));
  const long long rev2 = firstRevision(pushOk(ctx, pushAs(c, Json::array({pushChange("d-1", rev1, "agenda: budget, hiring")}), "phone"), "the phone's edit of revision 1"));
  // The laptop was offline: it still edits revision 1, and it brings a new note along.
  const Json stale = pushOk(ctx, pushAs(c, Json::array({pushChange("d-1", rev1, "agenda: offsite"), pushChange("d-9", 0, "packing list")})), "the laptop's push of a stale edit");
  const Json want = Json::array({Json{{"doc_id", "d-1"}, {"base_revision", rev1}, {"current_revision", rev2}}});
  ctx.Assert(stale.value("conflicts", Json::array()) == want, "the laptop edited revision %d of d-1 while its head is at %d: the push must answer that conflict, got %s", rev1, rev2, stale.dump());
  ctx.Equal(store::head("d-1")->body, "agenda: budget, hiring", "the stale edit was written over the phone's (apply only against the revision the device edited); d-1's body");
  const Json applied = stale.value("applied", Json::array());
  ctx.Assert(applied.size() == 1 && applied[0].value("doc_id", "") == "d-9", "the rest of the batch must still apply, got applied %s", applied.dump());
}

void CheckContentHash(harness::Ctx& ctx) {
  auto c = pushApi(ctx);
  const Json good = pushChange("d-1", 0, "meeting notes");
  Json cut = pushChange("d-2", 0, "budget 2026: final figures");
  cut["body"] = "budget 2026: fin";  // truncated in transit, the hash of the whole body
  auto r = pushAs(c, Json::array({good, cut}));
  ctx.Equal(r.Status, 400, "a change whose body does not match its content_hash (%s)", r.Text());
  ctx.Assert(r.Text().find("d-2") != std::string::npos, "the 400 must name the change (d-2), got %s", r.Text());
  ctx.Assert(!store::head("d-2"), "the truncated body reached storage");
  ctx.Assert(!store::head("d-1"), "d-1 was written before d-2's hash was checked: check every change before applying any");
  r = pushAs(c, Json::array({good}));
  ctx.Assert(r.Status == 200 && store::head("d-1").has_value(), "the intact change on its own must be applied, got %d: %s", r.Status, r.Text());
}

void CheckBatchCap(harness::Ctx& ctx) {
  auto c = pushApi(ctx);
  Json changes = Json::array();
  for (int i = 0; i < 501; i++) changes.push_back(pushChange("d-" + std::to_string(i), 0, "note " + std::to_string(i)));
  auto r = pushAs(c, changes);
  ctx.Equal(r.Status, 413, "a push of 501 changes (MAX_CHANGES is 500)");
  ctx.Equal(ctx.Redis.ZCard("changes"), 0LL, "the refused push must write nothing (check the size before applying anything); documents written");
  changes.erase(changes.end() - 1);
  const Json body = pushOk(ctx, pushAs(c, changes), "a push of exactly 500 changes");
  ctx.Equal(body.value("applied", Json::array()).size(), size_t{500}, "a push of exactly 500 changes must be applied; applied");
}

void CheckDeviceAuth(harness::Ctx& ctx) {
  auto c = pushApi(ctx);
  const auto r = pushAs(c, Json::array({pushChange("d-1", 0, "shopping list")}), "");
  ctx.Equal(r.Status, 401, "a push without X-Device-Id (%s)", r.Text());
  ctx.Assert(!store::head("d-1"), "a push without a device must write nothing");
}
`,
  },
  hints: [
    "Push an edit of revision 1 from the laptop after the phone wrote revision 2: the phone's text is gone and the answer lists no conflicts. A body cut short in transit is stored as if it were whole.",
    '`overwrite` writes the next revision whatever revision the device edited. The hash check only looks at the shape of the string, and it runs inside the loop that writes, so the first changes of a bad batch are already stored.',
    'Read `X-Device-Id` from the request (401 without it), 413 above `MAX_CHANGES`, then one pass comparing `store.content_hash(body)` with each hash (400), then `apply_change` per change, sorting conflicts into `conflicts`.',
  ],
  debrief: `The base revision is the device's claim about what it edited, and only the server can check it against the head, which is why the push hands it to the apply instead of trusting the client's order of events. Conflicts are answered per document so the rest of the batch still lands: a laptop with forty edits and one conflict resends one. The body is compared with its hash rather than the hash with a pattern, because truncation keeps the hash's shape intact, and the whole batch is checked first so a refused push leaves nothing behind. A production sync service would also bind the device id to an authenticated user, deduplicate a retried push by a request id, and cap a batch by bytes as well as by count.`,
};
