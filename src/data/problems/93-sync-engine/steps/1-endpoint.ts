import type {Step} from '@/lib/types';

export const pushEndpointStep: Step = {
  id: 'endpoint',
  concept: 'http',
  file: 'api',
  title: 'POST /v1/sync/push: changes against a base revision',
  focus: ['device', 'sync', 'revisions'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the push route,
parses the body and returns an applied count. It compiles, it syncs the demo laptop, and it hides
three production flaws. Review it like the service owner, fix it, and prove the fix with the checks
below.

Implement \`POST /v1/sync/push\` with body
\`{"device_id": "…", "base_revision": 412, "changes": [{"doc_id": "…", "content_hash": "…", "body": "…"}]}\`.

- The device is authenticated by the \`X-Device-Id\` header; a missing device is **401**.
- \`changes\` is a non-empty list of at most **500** entries (\`MAX_CHANGES\`); a longer list is
  **413** before a single change is applied.
- Every change names its document (\`doc_id\`) and its content hash, and the hash must be 64
  lowercase hex characters — a malformed hash is **400**, and it is rejected in the validation pass,
  before any apply runs.
- \`base_revision\` must be a revision the server actually issued (\`store.issued(base_revision)\`).
  When it is not — the laptop that was offline for a month — the push is stale: answer **409** with
  the per-document \`conflicts\` list and apply nothing, because the device's edits are real but its
  base is not the head it thinks it is. A stale base must never overwrite a newer document.
- When the base is current, apply the batch (\`store.apply_batch\`), record the revision
  (\`store.record_revision\`) and answer with \`applied\`, the \`conflicts\` the apply produced, and the
  newly issued \`revision\`.

**Failure mode the checks target.** The draft applies every change blindly, so a device that was
offline overwrites a month of edits from another device and nobody is told. It accepts a change list
of unbounded size, so one push can hold a worker for minutes while it applies a million documents.
And it never looks at a content hash, so a truncated or corrupted change reaches storage as if it
were the device's edit.`,
  sequence: {
    participants: ['Device', 'Sync Engine', 'revisions'],
    messages: [
      {from: 'Device', to: 'Sync Engine', label: 'POST /v1/sync/push · X-Device-Id · base_revision', kind: 'sync'},
      {from: 'Sync Engine', to: 'Sync Engine', label: 'device · change cap · hash shape', kind: 'sync'},
      {from: 'Sync Engine', to: 'revisions', label: 'issued(base_revision)?', kind: 'sync'},
      {from: 'revisions', to: 'Sync Engine', label: 'true / false', kind: 'reply'},
      {from: 'Sync Engine', to: 'revisions', label: 'apply_batch · record_revision', kind: 'async'},
      {from: 'Sync Engine', to: 'Device', label: '200 {applied, conflicts, revision} · 409 {conflicts}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/sync/push',
      detail: 'Register the push route on `POST /v1/sync/push`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/sync\/push["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/sync\/push['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/sync\/push"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"sync"\s*\/\s*"push"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/sync\/push"/]},
      },
    },
    {
      id: 'base-revision',
      title: 'Checks the base revision against the revisions the server issued',
      detail:
        'The base revision is verified with `store.issued(...)` before anything is applied: a base the server never issued is stale. The draft ignores `base_revision` and applies the batch anyway.',
      match: {
        python: {all: [/store\.issued\(/, /body\.base_revision/]},
        typescript: {all: [/store\.issued\(/, /body\.base_revision/]},
        go: {all: [/store\.Issued\(/, /body\.BaseRevision/]},
        scala: {all: [/store\.issued\(/, /body\.base_revision/]},
        cpp: {all: [/store\.issued\(/, /base_revision/]},
      },
    },
    {
      id: 'changes-cap',
      title: 'Bounds the change list at 500 entries',
      detail:
        'A push with more than `MAX_CHANGES` (500) changes is rejected with **413** before any apply. The draft accepts a change list of unbounded size and applies all of it.',
      match: {
        python: {all: [/MAX_CHANGES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_CHANGES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxChanges/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxChanges/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxChanges/, /\b413\b/]},
      },
    },
    {
      id: 'hash-validation',
      title: 'Rejects a malformed content hash before any apply',
      detail:
        'Every change’s `content_hash` is matched against the 64-hex-character shape and a bad one is **400**, in the validation pass that runs before the apply. The draft never inspects the hash.',
      match: {
        python: {all: [/HASH_RE/, /status_code\s*=\s*400/], order: [/HASH_RE\.match\(/, /store\.apply_batch\(/]},
        typescript: {
          all: [/HASH_PATTERN/, /code\(\s*400\s*\)/],
          order: [/HASH_PATTERN\.test\(/, /store\.applyBatch\(/],
        },
        go: {all: [/hashPattern/, /StatusBadRequest/], order: [/hashPattern\.MatchString\(/, /store\.ApplyBatch\(/]},
        scala: {
          all: [/HashPattern/, /StatusCodes\.BadRequest/],
          order: [/HashPattern\.findFirstIn\(/, /store\.applyBatch\(/],
        },
        cpp: {
          all: [/kHashPattern/, /std::regex_match\(/, /\b400\b/],
          order: [/std::regex_match\(/, /store\.applyBatch\(/],
        },
      },
    },
    {
      id: 'per-document-conflicts',
      title: 'A stale base yields per-document conflicts, not silent overwrites',
      detail:
        'A stale base is answered with **409** and one entry per change in `conflicts`; nothing is applied blindly (no `applyAll`-style path). The draft’s only outcome is a blind apply.',
      match: {
        python: {all: [/conflicts/, /"applied"/], none: [/store\.apply_all\(/]},
        typescript: {all: [/conflicts/, /applied:/], none: [/store\.applyAll\(/]},
        go: {all: [/conflicts/, /StatusConflict/], none: [/store\.ApplyAll\(/]},
        scala: {all: [/conflicts/, /StatusCodes\.Conflict/], none: [/store\.applyAll\(/]},
        cpp: {all: [/conflicts/, /\b409\b/], none: [/store\.applyAll\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class Change(BaseModel):
    doc_id: str
    content_hash: str
    body: str = ""


class PushRequest(BaseModel):
    base_revision: int
    changes: list[Change]


class RevisionStore:
    def issued(self, revision: int) -> bool:
        """True when the server actually issued this revision."""
        raise NotImplementedError

    def apply_all(self, device: str, changes: list[dict]) -> dict:
        """Apply every change and return {applied, revision}."""
        raise NotImplementedError


store = RevisionStore()


@app.post("/v1/sync/push")
def push(body: PushRequest, device: str = Header(alias="X-Device-Id")) -> JSONResponse:
    # TODO: this draft ignores base_revision and applies every change blindly, accepts a change
    # list of unbounded size, and never validates a change's content hash. Review all three.
    outcome = store.apply_all(device, [change.model_dump() for change in body.changes])
    return JSONResponse({"applied": outcome["applied"], "revision": outcome["revision"]}, status_code=200)
`,
      solution: `import re

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_CHANGES = 500
HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class Change(BaseModel):
    doc_id: str
    content_hash: str
    body: str = ""


class PushRequest(BaseModel):
    base_revision: int
    changes: list[Change]


class RevisionStore:
    def issued(self, revision: int) -> bool:
        """True when the server actually issued this revision."""
        raise NotImplementedError

    def apply_batch(self, device: str, changes: list[dict]) -> dict:
        """Apply the batch against the current head and report per-document outcomes."""
        raise NotImplementedError

    def record_revision(self, device: str) -> int:
        """Persist the applied batch and issue the next revision for this device."""
        raise NotImplementedError


store = RevisionStore()


@app.post("/v1/sync/push")
def push(
    body: PushRequest,
    device: str | None = Header(default=None, alias="X-Device-Id"),
) -> JSONResponse:
    if device is None or device == "":
        raise HTTPException(status_code=401, detail="missing X-Device-Id")
    if not body.changes:
        raise HTTPException(status_code=400, detail="changes must not be empty")
    if len(body.changes) > MAX_CHANGES:
        raise HTTPException(status_code=413, detail="at most 500 changes in one push")
    for change in body.changes:
        if HASH_RE.match(change.content_hash) is None:
            raise HTTPException(status_code=400, detail="malformed content_hash")

    if not store.issued(body.base_revision):
        # A base the server never issued is stale. The device's edits are still real, so they come
        # back as per-document conflicts instead of overwriting documents it never saw.
        return JSONResponse(
            {
                "applied": [],
                "conflicts": [change.doc_id for change in body.changes],
                "revision": body.base_revision,
            },
            status_code=409,
        )

    outcome = store.apply_batch(device, [change.model_dump() for change in body.changes])
    revision = store.record_revision(device)
    return JSONResponse(
        {"applied": outcome["applied"], "conflicts": outcome["conflicts"], "revision": revision},
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/sync/push: a model-generated draft that applies every change it is given. */
import Fastify from 'fastify';

import {store} from './revisions';

export const app = Fastify();

interface Change {
  doc_id: string;
  content_hash: string;
  body?: string;
}

interface PushBody {
  base_revision: number;
  changes: Change[];
}

app.post('/v1/sync/push', async (request, reply) => {
  // TODO: this draft ignores base_revision and applies every change blindly, accepts a change
  // list of unbounded size, and never validates a change's content hash. Review all three.
  const device = request.headers['x-device-id'] as string;
  const body = request.body as PushBody;
  const outcome = await store.applyAll(device, body.changes);
  return reply.code(200).send({applied: outcome.applied, revision: outcome.revision});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/sync/push: validate the batch, then apply it against the issued base revision. */
import Fastify from 'fastify';

import {store} from './revisions';

export const app = Fastify();

const MAX_CHANGES = 500;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

interface Change {
  doc_id: string;
  content_hash: string;
  body?: string;
}

interface PushBody {
  base_revision: number;
  changes: Change[];
}

app.post('/v1/sync/push', async (request, reply) => {
  const device = request.headers['x-device-id'];
  if (typeof device !== 'string' || device === '')
    return reply.code(401).send({error: 'missing X-Device-Id'});

  const body = request.body as Partial<PushBody> | null;
  if (body === null || typeof body !== 'object' || !Array.isArray(body.changes))
    return reply.code(400).send({error: 'changes must be a list'});
  if (body.changes.length === 0) return reply.code(400).send({error: 'changes must not be empty'});
  if (body.changes.length > MAX_CHANGES)
    return reply.code(413).send({error: 'at most ' + MAX_CHANGES + ' changes in one push'});
  for (const change of body.changes) {
    if (typeof change.content_hash !== 'string' || !HASH_PATTERN.test(change.content_hash))
      return reply.code(400).send({error: 'malformed content_hash'});
  }

  if (!Number.isInteger(body.base_revision) || !(await store.issued(body.base_revision)))
    return reply.code(409).send({
      applied: [],
      conflicts: body.changes.map(change => change.doc_id),
      revision: body.base_revision,
    });

  const outcome = await store.applyBatch(device, body.changes);
  const revision = await store.recordRevision(device);
  return reply.code(200).send({applied: outcome.applied, conflicts: outcome.conflicts, revision});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type Change struct {
	DocumentID  string \`json:"doc_id"\`
	ContentHash string \`json:"content_hash"\`
	Body        string \`json:"body"\`
}

type PushRequest struct {
	BaseRevision int64    \`json:"base_revision"\`
	Changes      []Change \`json:"changes"\`
}

type RevisionStore struct{}

func (s *RevisionStore) Issued(ctx context.Context, revision int64) (bool, error) { return true, nil }

func (s *RevisionStore) ApplyAll(ctx context.Context, device string, changes []Change) (map[string]any, error) {
	return nil, nil
}

var store = &RevisionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func push(rw http.ResponseWriter, r *http.Request) {
	device := r.Header.Get("X-Device-Id")
	var body PushRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft ignores base_revision and applies every change blindly, accepts a change
	// list of unbounded size, and never validates a change's content hash. Review all three.
	outcome, _ := store.ApplyAll(r.Context(), device, body.Changes)
	log.Printf("push device=%s changes=%d", device, len(body.Changes))
	writeJSON(rw, http.StatusOK, map[string]any{"applied": outcome["applied"], "revision": outcome["revision"]})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sync/push", push)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
)

const maxChanges = 500

var hashPattern = regexp.MustCompile("^[0-9a-f]{64}$")

type Change struct {
	DocumentID  string \`json:"doc_id"\`
	ContentHash string \`json:"content_hash"\`
	Body        string \`json:"body"\`
}

type PushRequest struct {
	BaseRevision int64    \`json:"base_revision"\`
	Changes      []Change \`json:"changes"\`
}

type RevisionStore struct{}

func (s *RevisionStore) Issued(ctx context.Context, revision int64) (bool, error) { return false, nil }

func (s *RevisionStore) ApplyBatch(ctx context.Context, device string, changes []Change) (map[string]any, error) {
	return nil, nil
}

func (s *RevisionStore) RecordRevision(ctx context.Context, device string) (int64, error) { return 0, nil }

var store = &RevisionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func push(rw http.ResponseWriter, r *http.Request) {
	device := r.Header.Get("X-Device-Id")
	if device == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Device-Id"})
		return
	}
	var body PushRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Changes) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "changes must not be empty"})
		return
	}
	if len(body.Changes) > maxChanges {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "too many changes in one push"})
		return
	}
	for _, change := range body.Changes {
		if !hashPattern.MatchString(change.ContentHash) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "malformed content_hash"})
			return
		}
	}
	issued, err := store.Issued(r.Context(), body.BaseRevision)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !issued {
		// The device's base is stale: its changes are real, but they may not overwrite documents it
		// has never seen. Report per-document conflicts and apply nothing.
		conflicts := make([]string, 0, len(body.Changes))
		for _, change := range body.Changes {
			conflicts = append(conflicts, change.DocumentID)
		}
		writeJSON(rw, http.StatusConflict, map[string]any{
			"applied":   []string{},
			"conflicts": conflicts,
			"revision":  body.BaseRevision,
		})
		return
	}
	outcome, err := store.ApplyBatch(r.Context(), device, body.Changes)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	revision, err := store.RecordRevision(r.Context(), device)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"applied":   outcome["applied"],
		"conflicts": outcome["conflicts"],
		"revision":  revision,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sync/push", push)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Change(doc_id: String, content_hash: String, body: String)
final case class PushRequest(base_revision: Long, changes: List[Change])

object SyncApi {
  implicit val system: ActorSystem = ActorSystem("sync-engine")
  implicit val changeFormat: RootJsonFormat[Change] = jsonFormat3(Change)
  implicit val pushFormat: RootJsonFormat[PushRequest] = jsonFormat2(PushRequest)

  val store = RevisionStore.open()

  val route: Route =
    path("v1" / "sync" / "push") {
      post {
        headerValueByName("X-Device-Id") { device =>
          entity(as[PushRequest]) { body =>
            // TODO: this draft ignores base_revision and applies every change blindly, accepts a
            // change list of unbounded size, and never validates a change's content hash.
            val outcome = store.applyAll(device, body.changes)
            system.log.info(s"push device=$device changes=\${body.changes.size}")
            complete(StatusCodes.OK, s"""{"applied":\${outcome.applied},"revision":\${outcome.revision}}""")
          }
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Change(doc_id: String, content_hash: String, body: String)
final case class PushRequest(base_revision: Long, changes: List[Change])

object SyncApi {
  implicit val system: ActorSystem = ActorSystem("sync-engine")
  implicit val changeFormat: RootJsonFormat[Change] = jsonFormat3(Change)
  implicit val pushFormat: RootJsonFormat[PushRequest] = jsonFormat2(PushRequest)

  val MaxChanges = 500
  val HashPattern = "^[0-9a-f]{64}$".r

  val store = RevisionStore.open()

  val route: Route =
    path("v1" / "sync" / "push") {
      post {
        optionalHeaderValueByName("X-Device-Id") { deviceOpt =>
          entity(as[PushRequest]) { body =>
            if (!deviceOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Device-Id"}""")
            } else if (body.changes.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"changes must not be empty"}""")
            } else if (body.changes.size > MaxChanges) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"too many changes in one push"}""")
            } else if (body.changes.exists(change => HashPattern.findFirstIn(change.content_hash).isEmpty)) {
              complete(StatusCodes.BadRequest, """{"error":"malformed content_hash"}""")
            } else if (!store.issued(body.base_revision)) {
              // A base the server never issued is stale: report the changes as per-document
              // conflicts rather than applying them over documents the device never saw.
              val conflicts = body.changes.map(change => "\\"" + change.doc_id + "\\"").mkString("[", ",", "]")
              complete(
                StatusCodes.Conflict,
                s"""{"applied":[],"conflicts":$conflicts,"revision":\${body.base_revision}}"""
              )
            } else {
              val device = deviceOpt.get
              val outcome = store.applyBatch(device, body.changes)
              val revision = store.recordRevision(device)
              complete(
                StatusCodes.OK,
                s"""{"applied":\${outcome.applied},"conflicts":\${outcome.conflicts},"revision":$revision}"""
              )
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

struct RevisionStore {
  bool issued(long long revision);
  json applyAll(const std::string& device, const json& changes);
};

RevisionStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/sync/push", [](const httplib::Request& req, httplib::Response& res) {
    const auto device = req.get_header_value("X-Device-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft ignores base_revision and applies every change blindly, accepts a change
    // list of unbounded size, and never validates a change's content hash. Review all three.
    const auto outcome = store.applyAll(device, body.value("changes", json::array()));
    std::cerr << "push device=" << device << " changes=" << body.value("changes", json::array()).size() << "\\n";
    res.status = 200;
    res.set_content(
        json{{"applied", outcome["applied"]}, {"revision", outcome["revision"]}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <regex>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxChanges = 500;
const std::regex kHashPattern("^[0-9a-f]{64}$");

struct RevisionStore {
  bool issued(long long revision);
  json applyBatch(const std::string& device, const json& changes);
  long long recordRevision(const std::string& device);
};

RevisionStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/sync/push", [](const httplib::Request& req, httplib::Response& res) {
    const auto device = req.get_header_value("X-Device-Id");
    if (device.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Device-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("changes") || !body["changes"].is_array()) {
      res.status = 400;
      res.set_content(R"({"error":"changes must be a list"})", "application/json");
      return;
    }
    const auto& changes = body["changes"];
    if (changes.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"changes must not be empty"})", "application/json");
      return;
    }
    if (changes.size() > kMaxChanges) {
      res.status = 413;
      res.set_content(R"({"error":"too many changes in one push"})", "application/json");
      return;
    }
    for (const auto& change : changes) {
      if (!change.contains("content_hash") || !change["content_hash"].is_string() ||
          !std::regex_match(change["content_hash"].get<std::string>(), kHashPattern)) {
        res.status = 400;
        res.set_content(R"({"error":"malformed content_hash"})", "application/json");
        return;
      }
    }
    const long long baseRevision = body.value("base_revision", -1LL);
    if (!store.issued(baseRevision)) {
      // A base the server never issued is stale: the changes come back as per-document conflicts
      // instead of landing on top of documents this device has never seen.
      json conflicts = json::array();
      for (const auto& change : changes) conflicts.push_back(change.value("doc_id", std::string()));
      res.status = 409;
      res.set_content(
          json{{"applied", json::array()}, {"conflicts", conflicts}, {"revision", baseRevision}}.dump(),
          "application/json");
      return;
    }
    const auto outcome = store.applyBatch(device, changes);
    const auto revision = store.recordRevision(device);
    res.status = 200;
    res.set_content(
        json{{"applied", outcome["applied"]}, {"conflicts", outcome["conflicts"]}, {"revision", revision}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate in cost order and return early: device, empty list, cap, hash shape. Every one of those is a cheap rejection that runs before `apply_batch`, so a malformed or oversized push never touches a document.',
    'The base revision is the whole point of the endpoint. `store.issued(base_revision)` answers whether the server really handed that revision to a device; when it did not, the device has been away and its base is behind the head. The answer is 409, not a warning in the log line — the client has to see which documents conflicted so it can fetch and merge them.',
    "The conflict list is per document, built from the changes in this push: `[change.doc_id for change in body.changes]`. An empty `applied` list and a populated `conflicts` list is the honest answer for a stale base — the device's work is kept, nothing is overwritten, and the client knows exactly what to re-merge.",
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary of a sync protocol. The draft reads fine because the demo pushes from one device with a fresh base and never sends a large batch. Three defects are being checked. The base revision: applying a change without proving the base is a revision the server issued is how a returning laptop destroys a month of another device's edits — the fix is not to reject the device, but to surface per-document conflicts. The cap: a change list is attacker-controlled and unbounded, so the limit belongs in validation, before any write. The hash: the content hash is the device's claim about what it is uploading, and a malformed one means the change is not what the client thinks it is, so it is 400 in the same validation pass. Real sync layers add a snapshot path for devices whose base is so far behind that conflict-per-document is useless, a per-device rate limit, and a server-side revision per document rather than per batch.`,
};
