import type {Step} from '@/lib/types';

export const taskEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/tasks: a labeling task pinned to a spec',
  concept: 'http',
  file: 'api',
  focus: ['client', 'service', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/tasks\` on the task store (\`labeling.store\`,
provided): it reads the tenant from \`X-Tenant-Id\` (401 without it), takes
\`{"items": ["…"], "spec_version": "2026-10", "overlap": 3}\`, calls \`store.create_task\` and answers
201 \`{task_id, spec_version, overlap, accepted, deduped}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A client that times out and retries gets a second task over the
same items; a create without a spec version is pinned to \`latest\`, whatever that means next week;
one request queues an empty batch, ten thousand items or an overlap of zero; and an item already
queued under the spec is queued again, so annotators are paid twice for one answer.

- \`Idempotency-Key\` is required (400). When \`store.create_result(tenant, key)\` holds an answer,
  reply with it and 200; record a fresh 201 answer with \`store.record_create\`.
- \`spec_version\` is required and not blank (400); the task is pinned to it.
- \`items\` is 1..\`MAX_BATCH_ITEMS\` = 200 non-empty strings, \`overlap\` 1..\`MAX_OVERLAP\` = 5 (400).
- \`content_hash(item)\` is the SHA-256 hex of the UTF-8 bytes. Drop items whose hash
  \`store.seen_hashes(spec_version)\` holds or the batch repeats, count them in \`deduped\` and register
  the new ones with \`store.add_hashes\`; when nothing new is left, answer 409
  \`{"error": "no_new_items"}\`.`,
  sequence: {
    participants: ['Client', 'labeld', 'task store'],
    messages: [
      {from: 'Client', to: 'labeld', label: 'POST /v1/tasks · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'labeld', to: 'task store', label: 'create_result(tenant, key) → recorded answer / none', kind: 'sync'},
      {from: 'labeld', to: 'labeld', label: 'spec_version · items 1..200 · overlap 1..5 → 400', kind: 'sync'},
      {
        from: 'labeld',
        to: 'task store',
        label: 'seen_hashes(spec_version) · drop repeats → 409 no_new_items',
        kind: 'sync',
      },
      {from: 'labeld', to: 'task store', label: 'create_task · add_hashes · record_create', kind: 'sync'},
      {from: 'labeld', to: 'Client', label: '201 {task_id, spec_version, overlap, accepted, deduped}', kind: 'reply'},
      {from: 'Client', to: 'labeld', label: 'retry · same Idempotency-Key', kind: 'sync'},
      {from: 'labeld', to: 'Client', label: '200 the recorded answer, no second task', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/tasks',
      detail: 'Register the task-creation route on `POST /v1/tasks`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/tasks["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/tasks['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/tasks"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tasks"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/tasks"/]},
      },
    },
    {
      id: 'spec-pinned',
      title: 'Requires and pins the label spec version',
      detail:
        'A create without a non-blank `spec_version` is **400** and leaves no task; the stored task carries the version it was created under. The starter falls back to `latest`, so the cohort answers whatever the spec says next week.',
      match: {
        python: {all: [/spec_version\.strip\(\)|spec_version\.isspace\(\)/], none: [/["']latest["']/]},
        typescript: {all: [/spec_version\.trim\(\)/], none: [/['"]latest['"]/]},
        go: {all: [/strings\.TrimSpace\([^)\n]*SpecVersion/], none: [/"latest"/]},
        scala: {all: [/\.trim\.isEmpty|\.isBlank/], none: [/"latest"/]},
        cpp: {all: [/find_first_not_of\(/], none: [/"latest"/]},
      },
    },
    {
      id: 'batch-bounds',
      title: 'Bounds the batch size and the overlap',
      detail:
        '`items` is 1..`MAX_BATCH_ITEMS` (200) non-empty strings and `overlap` 1..`MAX_OVERLAP` (5), both **400** outside the range with no task written. The starter takes any size, so one request can queue an empty task or ask for zero annotators per item.',
      match: {
        python: {
          all: [/MAX_BATCH_ITEMS\s*=\s*200/, /MAX_OVERLAP\s*=\s*5/, /[<>]=?\s*MAX_BATCH_ITEMS/, /[<>]=?\s*MAX_OVERLAP/],
        },
        typescript: {
          all: [/MAX_BATCH_ITEMS\s*=\s*200/, /MAX_OVERLAP\s*=\s*5/, /[<>]=?\s*MAX_BATCH_ITEMS/, /[<>]=?\s*MAX_OVERLAP/],
        },
        go: {all: [/maxBatchItems\s*=\s*200/, /maxOverlap\s*=\s*5/, /[<>]=?\s*maxBatchItems/, /[<>]=?\s*maxOverlap/]},
        scala: {
          all: [/MaxBatchItems\s*=\s*200/, /MaxOverlap\s*=\s*5/, /[<>]=?\s*MaxBatchItems/, /[<>]=?\s*MaxOverlap/],
        },
        cpp: {
          all: [/kMaxBatchItems\s*=\s*200/, /kMaxOverlap\s*=\s*5/, /[<>]=?\s*kMaxBatchItems/, /[<>]=?\s*kMaxOverlap/],
        },
      },
    },
    {
      id: 'content-dedupe',
      title: 'Dedupes items by content hash under the spec',
      detail:
        'Items are hashed (SHA-256 hex of the UTF-8 bytes) and dropped when `seen_hashes` holds the hash or the batch repeats it; drops are counted in `deduped`, the new hashes registered with `add_hashes`, and a batch with nothing new answers **409 `{"error": "no_new_items"}`**. The starter hashes nothing, so every retry and overlapping batch is queued again.',
      match: {
        python: {all: [/hashlib\.sha256\(/, /store\.seen_hashes\(/, /store\.add_hashes\(/, /no_new_items/, /\b409\b/]},
        typescript: {
          all: [/createHash\(\s*['"]sha256['"]\s*\)/, /seenHashes\(/, /addHashes\(/, /no_new_items/, /\b409\b/],
        },
        go: {
          all: [
            /sha256\.Sum256\(/,
            /store\.SeenHashes\(/,
            /store\.AddHashes\(/,
            /no_new_items/,
            /StatusConflict|\b409\b/,
          ],
        },
        scala: {
          all: [
            /MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/,
            /Store\.seenHashes\(/,
            /Store\.addHashes\(/,
            /no_new_items/,
            /Conflict|\b409\b/,
          ],
        },
        cpp: {all: [/SHA256\(/, /store::seenHashes\(/, /store::addHashes\(/, /no_new_items/, /\b409\b/]},
      },
    },
    {
      id: 'idempotent-create',
      title: 'A retried create answers the recorded task',
      detail:
        '`Idempotency-Key` is required (**400**); the answer recorded for `(tenant, key)` is looked up before a task is created and replayed with **200**, and a fresh create records its answer. The starter ignores the header, so every client retry queues a second task.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.create_result\(/, /store\.record_create\(/],
          order: [/store\.create_result\(/, /store\.create_task\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /createResult\(/, /recordCreate\(/],
          order: [/createResult\(/, /createTask\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.CreateResult\(/, /store\.RecordCreate\(/],
          order: [/store\.CreateResult\(/, /store\.CreateTask\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.createResult\(/, /Store\.recordCreate\(/],
          order: [/Store\.createResult\(/, /Store\.createTask\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::createResult\(/, /store::recordCreate\(/],
          order: [/store::createResult\(/, /store::createTask\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from labeling import store  # create_task, seen_hashes, add_hashes, create_result, record_create

app = FastAPI()


class TaskCreate(BaseModel):
    items: list[str] = []
    spec_version: str = ""
    overlap: int = 1


@app.post("/v1/tasks", status_code=201)
def create_task(body: TaskCreate, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    spec_version = body.spec_version or "latest"
    task = store.create_task(tenant, spec_version, body.overlap, body.items)
    return {
        "task_id": task["task_id"],
        "spec_version": task["spec_version"],
        "overlap": task["overlap"],
        "accepted": len(body.items),
        "deduped": 0,
    }
`,
      solution: `import hashlib

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from labeling import store  # create_task, seen_hashes, add_hashes, create_result, record_create

app = FastAPI()

MAX_BATCH_ITEMS = 200
MAX_OVERLAP = 5


class TaskCreate(BaseModel):
    items: list[str] = []
    spec_version: str = ""
    overlap: int = 1


def content_hash(item: str) -> str:
    return hashlib.sha256(item.encode("utf-8")).hexdigest()


@app.post("/v1/tasks", status_code=201)
def create_task(body: TaskCreate, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    recorded = store.create_result(tenant, key)
    if recorded is not None:
        return JSONResponse(recorded, status_code=200)  # a retry answers what the first attempt answered
    if not body.spec_version.strip():
        raise HTTPException(status_code=400, detail="spec_version is required")
    if not 1 <= len(body.items) <= MAX_BATCH_ITEMS or "" in body.items:
        raise HTTPException(status_code=400, detail=f"items must be 1..{MAX_BATCH_ITEMS} non-empty strings")
    if not 1 <= body.overlap <= MAX_OVERLAP:
        raise HTTPException(status_code=400, detail=f"overlap must be 1..{MAX_OVERLAP}")
    # The bytes are the question: an item already queued under this spec, or repeated here, is dropped.
    seen = store.seen_hashes(body.spec_version)
    fresh, hashes = [], []
    for item in body.items:
        digest = content_hash(item)
        if digest in seen:
            continue
        seen.add(digest)
        fresh.append(item)
        hashes.append(digest)
    if not fresh:
        return JSONResponse({"error": "no_new_items"}, status_code=409)
    task = store.create_task(tenant, body.spec_version, body.overlap, fresh)
    store.add_hashes(body.spec_version, hashes)
    result = {
        "task_id": task["task_id"],
        "spec_version": task["spec_version"],
        "overlap": task["overlap"],
        "accepted": len(fresh),
        "deduped": len(body.items) - len(fresh),
    }
    store.record_create(tenant, key, result)
    return JSONResponse(result, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {addHashes, createResult, createTask, recordCreate, seenHashes} from 'labeling/store';

export const app = Fastify();

interface TaskCreate {
  items?: string[];
  spec_version?: string;
  overlap?: number;
}

app.post('/v1/tasks', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as TaskCreate;
  const items = body.items ?? [];
  const specVersion = body.spec_version || 'latest';
  const task = await createTask(tenant, specVersion, body.overlap ?? 1, items);
  return reply.code(201).send({
    task_id: task.task_id,
    spec_version: task.spec_version,
    overlap: task.overlap,
    accepted: items.length,
    deduped: 0,
  });
});
`,
      solution: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {addHashes, createResult, createTask, recordCreate, seenHashes} from 'labeling/store';

export const app = Fastify();

export const MAX_BATCH_ITEMS = 200;
export const MAX_OVERLAP = 5;

interface TaskCreate {
  items?: unknown[];
  spec_version?: unknown;
  overlap?: number;
}

export const contentHash = (item: string): string => createHash('sha256').update(item, 'utf8').digest('hex');

app.post('/v1/tasks', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await createResult(tenant, key);
  if (recorded !== null) return reply.code(200).send(recorded); // a retry answers what the first attempt answered
  const body = (request.body ?? {}) as TaskCreate;
  if (typeof body.spec_version !== 'string' || body.spec_version.trim() === '') {
    return reply.code(400).send({error: 'spec_version is required'});
  }
  const specVersion = body.spec_version;
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length < 1 || items.length > MAX_BATCH_ITEMS || items.some(item => typeof item !== 'string' || item === '')) {
    return reply.code(400).send({error: \`items must be 1..\${MAX_BATCH_ITEMS} non-empty strings\`});
  }
  const overlap = body.overlap ?? 1;
  if (!Number.isInteger(overlap) || overlap < 1 || overlap > MAX_OVERLAP) {
    return reply.code(400).send({error: \`overlap must be 1..\${MAX_OVERLAP}\`});
  }
  // The bytes are the question: an item already queued under this spec, or repeated here, is dropped.
  const seen = await seenHashes(specVersion);
  const fresh: string[] = [];
  const hashes: string[] = [];
  for (const item of items as string[]) {
    const digest = contentHash(item);
    if (seen.has(digest)) continue;
    seen.add(digest);
    fresh.push(item);
    hashes.push(digest);
  }
  if (fresh.length === 0) return reply.code(409).send({error: 'no_new_items'});
  const task = await createTask(tenant, specVersion, overlap, fresh);
  await addHashes(specVersion, hashes);
  const result = {
    task_id: task.task_id,
    spec_version: task.spec_version,
    overlap: task.overlap,
    accepted: fresh.length,
    deduped: items.length - fresh.length,
  };
  await recordCreate(tenant, key, result);
  return reply.code(201).send(result);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"labeling/store" // store.CreateTask, SeenHashes, AddHashes, CreateResult, RecordCreate
)

type taskCreate struct {
	Items       []string \`json:"items"\`
	SpecVersion string   \`json:"spec_version"\`
	Overlap     int      \`json:"overlap"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createTask(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	body := taskCreate{Overlap: 1}
	json.NewDecoder(r.Body).Decode(&body)
	specVersion := body.SpecVersion
	if specVersion == "" {
		specVersion = "latest"
	}
	task := store.CreateTask(r.Context(), tenant, specVersion, body.Overlap, body.Items)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"task_id": task.TaskID, "spec_version": task.SpecVersion, "overlap": task.Overlap, "accepted": len(body.Items), "deduped": 0,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/tasks", createTask)
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"labeling/store" // store.CreateTask, SeenHashes, AddHashes, CreateResult, RecordCreate
)

const (
	maxBatchItems = 200
	maxOverlap    = 5
)

type taskCreate struct {
	Items       []string \`json:"items"\`
	SpecVersion string   \`json:"spec_version"\`
	Overlap     int      \`json:"overlap"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func contentHash(item string) string {
	sum := sha256.Sum256([]byte(item))
	return hex.EncodeToString(sum[:])
}

func validItems(items []string) bool {
	if len(items) < 1 || len(items) > maxBatchItems {
		return false
	}
	for _, item := range items {
		if item == "" {
			return false
		}
	}
	return true
}

func createTask(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	if recorded := store.CreateResult(r.Context(), tenant, key); recorded != nil {
		writeJSON(rw, http.StatusOK, recorded) // a retry answers what the first attempt answered
		return
	}
	body := taskCreate{Overlap: 1}
	json.NewDecoder(r.Body).Decode(&body)
	if strings.TrimSpace(body.SpecVersion) == "" {
		http.Error(rw, "spec_version is required", http.StatusBadRequest)
		return
	}
	if !validItems(body.Items) {
		http.Error(rw, fmt.Sprintf("items must be 1..%d non-empty strings", maxBatchItems), http.StatusBadRequest)
		return
	}
	if body.Overlap < 1 || body.Overlap > maxOverlap {
		http.Error(rw, fmt.Sprintf("overlap must be 1..%d", maxOverlap), http.StatusBadRequest)
		return
	}
	// The bytes are the question: an item already queued under this spec, or repeated here, is dropped.
	seen := store.SeenHashes(r.Context(), body.SpecVersion)
	var fresh, hashes []string
	for _, item := range body.Items {
		digest := contentHash(item)
		if seen[digest] {
			continue
		}
		seen[digest] = true
		fresh = append(fresh, item)
		hashes = append(hashes, digest)
	}
	if len(fresh) == 0 {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "no_new_items"})
		return
	}
	task := store.CreateTask(r.Context(), tenant, body.SpecVersion, body.Overlap, fresh)
	store.AddHashes(r.Context(), body.SpecVersion, hashes)
	result := map[string]any{
		"task_id": task.TaskID, "spec_version": task.SpecVersion, "overlap": task.Overlap,
		"accepted": len(fresh), "deduped": len(body.Items) - len(fresh),
	}
	store.RecordCreate(r.Context(), tenant, key, result)
	writeJSON(rw, http.StatusCreated, result)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/tasks", createTask)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import labeling.Store // Store.createTask, seenHashes, addHashes, createResult, recordCreate

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route =
    path("v1" / "tasks") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            entity(as[String]) { raw =>
              // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
              val fields = raw.parseJson.asJsObject.fields
              val items = fields.get("items").collect { case JsArray(xs) => xs.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
              val specVersion = fields.get("spec_version").collect { case JsString(s) if s.nonEmpty => s }.getOrElse("latest")
              val overlap = fields.get("overlap").collect { case JsNumber(n) => n.toInt }.getOrElse(1)
              val task = Store.createTask(tenant, specVersion, overlap, items)
              complete(json(StatusCodes.Created, JsObject(
                "task_id" -> JsString(task.taskId), "spec_version" -> JsString(task.specVersion), "overlap" -> JsNumber(task.overlap),
                "accepted" -> JsNumber(items.size), "deduped" -> JsNumber(0))))
            }
        }
      }
    }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import labeling.Store // Store.createTask, seenHashes, addHashes, createResult, recordCreate

object Api {
  val MaxBatchItems = 200
  val MaxOverlap = 5

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  def contentHash(item: String): String =
    MessageDigest.getInstance("SHA-256").digest(item.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  val route: Route =
    path("v1" / "tasks") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            optionalHeaderValueByName("Idempotency-Key") {
              case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
              case Some(key) =>
                Store.createResult(tenant, key) match {
                  case Some(recorded) => complete(json(StatusCodes.OK, recorded)) // a retry answers what the first attempt answered
                  case None => entity(as[String])(raw => complete(create(tenant, key, raw)))
                }
            }
        }
      }
    }

  private def create(tenant: String, key: String, raw: String): HttpResponse = {
    val fields = raw.parseJson.asJsObject.fields
    val specVersion = fields.get("spec_version").collect { case JsString(s) => s }.getOrElse("")
    val rawItems = fields.get("items").collect { case JsArray(xs) => xs }.getOrElse(Vector.empty)
    val items = rawItems.collect { case JsString(s) if s.nonEmpty => s }
    val overlap = fields.get("overlap").collect { case JsNumber(n) => n.toInt }.getOrElse(1)
    if (specVersion.trim.isEmpty) json(StatusCodes.BadRequest, JsObject("error" -> JsString("spec_version is required")))
    else if (rawItems.isEmpty || rawItems.size > MaxBatchItems || items.size != rawItems.size)
      json(StatusCodes.BadRequest, JsObject("error" -> JsString(s"items must be 1..$MaxBatchItems non-empty strings")))
    else if (overlap < 1 || overlap > MaxOverlap) json(StatusCodes.BadRequest, JsObject("error" -> JsString(s"overlap must be 1..$MaxOverlap")))
    else {
      // The bytes are the question: an item already queued under this spec, or repeated here, is dropped.
      val seen = scala.collection.mutable.Set.from(Store.seenHashes(specVersion))
      val fresh = items.map(item => item -> contentHash(item)).filter { case (_, digest) => seen.add(digest) }
      if (fresh.isEmpty) json(StatusCodes.Conflict, JsObject("error" -> JsString("no_new_items")))
      else {
        val task = Store.createTask(tenant, specVersion, overlap, fresh.map(_._1))
        Store.addHashes(specVersion, fresh.map(_._2))
        val result = JsObject(
          "task_id" -> JsString(task.taskId), "spec_version" -> JsString(task.specVersion), "overlap" -> JsNumber(task.overlap),
          "accepted" -> JsNumber(fresh.size), "deduped" -> JsNumber(items.size - fresh.size))
        Store.recordCreate(tenant, key, result)
        json(StatusCodes.Created, result)
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

#include "labeling/store.h"  // store::createTask, seenHashes, addHashes, createResult, recordCreate

using json = nlohmann::json;

void create_task(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  std::vector<std::string> items;
  for (const auto& item : body.value("items", json::array())) items.push_back(item.get<std::string>());
  std::string spec_version = body.value("spec_version", "");
  if (spec_version.empty()) spec_version = "latest";
  const store::Task task = store::createTask(tenant, spec_version, body.value("overlap", 1L), items);
  res.status = 201;
  res.set_content(json{{"task_id", task.task_id}, {"spec_version", task.spec_version}, {"overlap", task.overlap},
                       {"accepted", items.size()}, {"deduped", 0}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/tasks", create_task); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <cstdio>
#include <string>
#include <vector>

#include "labeling/store.h"  // store::createTask, seenHashes, addHashes, createResult, recordCreate

using json = nlohmann::json;

constexpr long kMaxBatchItems = 200;
constexpr long kMaxOverlap = 5;

std::string content_hash(const std::string& item) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(item.data()), item.size(), digest);
  std::string hex;
  char byte[3];
  for (unsigned char b : digest) {
    std::snprintf(byte, sizeof byte, "%02x", b);
    hex += byte;
  }
  return hex;
}

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json{{"error", error}}.dump(), "application/json");
}

void create_task(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reject(res, 400, "Idempotency-Key is required");
  if (const auto recorded = store::createResult(tenant, key)) {
    res.set_content(recorded->dump(), "application/json");  // a retry answers what the first attempt answered
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "the body must be a JSON object");
  const std::string spec_version = body.contains("spec_version") && body["spec_version"].is_string() ? body["spec_version"].get<std::string>() : "";
  if (spec_version.find_first_not_of(" \\t\\n") == std::string::npos) return reject(res, 400, "spec_version is required");
  const json raw_items = body.value("items", json::array());
  std::vector<std::string> items;
  for (const auto& item : raw_items) {
    if (item.is_string() && !item.get<std::string>().empty()) items.push_back(item.get<std::string>());
  }
  const long n = static_cast<long>(raw_items.size());
  if (n < 1 || n > kMaxBatchItems || static_cast<long>(items.size()) != n) {
    return reject(res, 400, "items must be 1.." + std::to_string(kMaxBatchItems) + " non-empty strings");
  }
  const long overlap = body.value("overlap", 1L);
  if (overlap < 1 || overlap > kMaxOverlap) return reject(res, 400, "overlap must be 1.." + std::to_string(kMaxOverlap));
  // The bytes are the question: an item already queued under this spec, or repeated here, is dropped.
  std::set<std::string> seen = store::seenHashes(spec_version);
  std::vector<std::string> fresh, hashes;
  for (const std::string& item : items) {
    const std::string digest = content_hash(item);
    if (!seen.insert(digest).second) continue;
    fresh.push_back(item);
    hashes.push_back(digest);
  }
  if (fresh.empty()) return reject(res, 409, "no_new_items");
  const store::Task task = store::createTask(tenant, spec_version, overlap, fresh);
  store::addHashes(spec_version, hashes);
  const json result = {{"task_id", task.task_id}, {"spec_version", task.spec_version}, {"overlap", task.overlap},
                       {"accepted", fresh.size()}, {"deduped", items.size() - fresh.size()}};
  store::recordCreate(tenant, key, result);
  res.status = 201;
  res.set_content(result.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/tasks", create_task); }
`,
    },
  },
  harness: {
    python: `from labeling import store

BODY = {"items": ["a cat on a mat", "a dog in the fog"], "spec_version": "2026-10", "overlap": 3}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _create(c, body, key="k-1", tenant="t1"):
    return await c.post("/v1/tasks", json=body, headers={"X-Tenant-Id": tenant, "Idempotency-Key": key})


def _tasks(ctx):
    return sorted(ctx.redis.keys("task:t-*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _create(c, BODY)
    assert r.status_code == 201, f"POST /v1/tasks answered {r.status_code}: {r.text}"
    body = r.json()
    task = store.get_task(body.get("task_id", ""))
    assert task is not None, f"the create answered {body} but the store holds no task {body.get('task_id')!r}"
    assert task["tenant"] == "t1" and task["total_items"] == 2, f"the store holds {task}, expected tenant t1 with 2 items"
    assert body.get("accepted") == 2, f"two new items must be accepted, the create answered {body}"


async def check_spec_pinned(ctx):
    async with _api(ctx) as c:
        for n, spec in enumerate((None, "", "   ")):
            body = {k: v for k, v in BODY.items() if k != "spec_version"}
            if spec is not None:
                body["spec_version"] = spec
            r = await _create(c, body, f"k-{n}")
            assert r.status_code == 400, f"a create with spec_version {spec!r} answered {r.status_code}: {r.text}. A task must be pinned to a named spec version: 400"
        assert _tasks(ctx) == [], f"the rejected creates left tasks behind: {_tasks(ctx)}"
        r = await _create(c, BODY, "k-9")
    assert r.status_code == 201, f"a create with spec_version 2026-10 answered {r.status_code}: {r.text}"
    assert r.json().get("spec_version") == "2026-10", f"the create answered {r.json()}, expected spec_version 2026-10"
    task = store.get_task(r.json()["task_id"])
    assert task["spec_version"] == "2026-10", f"the stored task is pinned to {task['spec_version']!r}, expected 2026-10"


async def check_batch_bounds(ctx):
    cases = [
        ({"items": []}, "an empty batch"),
        ({"items": [f"item {n}" for n in range(201)]}, "a batch of 201 items"),
        ({"items": ["a cat", ""]}, "a batch with an empty item"),
        ({"overlap": 0}, "overlap 0"),
        ({"overlap": 6}, "overlap 6"),
    ]
    async with _api(ctx) as c:
        for n, (change, what) in enumerate(cases):
            r = await _create(c, {**BODY, **change}, f"k-{n}")
            assert r.status_code == 400, f"{what} answered {r.status_code}: {r.text}. Items are 1..MAX_BATCH_ITEMS = 200 non-empty strings and overlap 1..MAX_OVERLAP = 5: 400"
        assert _tasks(ctx) == [], f"the rejected creates left tasks behind: {_tasks(ctx)}"
        r = await _create(c, {**BODY, "items": [f"item {n}" for n in range(200)], "overlap": 5}, "k-ok")
    assert r.status_code == 201, f"200 items with overlap 5 are within bounds, the create answered {r.status_code}: {r.text}"


async def check_content_dedupe(ctx):
    async with _api(ctx) as c:
        r = await _create(c, {**BODY, "items": ["a cat", "a dog", "a cat"]}, "k-1")
        assert r.status_code == 201, f"the first create answered {r.status_code}: {r.text}"
        first = r.json()
        assert first.get("accepted") == 2 and first.get("deduped") == 1, f"a batch repeating 'a cat' answered {first}: the repeat must be dropped and counted (accepted 2, deduped 1)"
        assert store.get_task(first["task_id"])["total_items"] == 2, f"the task holds {store.get_task(first['task_id'])['total_items']} items, expected 2"
        r = await _create(c, {**BODY, "items": ["a dog", "a bird"]}, "k-2")
        second = r.json()
        assert r.status_code == 201 and second.get("accepted") == 1 and second.get("deduped") == 1, f"'a dog' is already queued under 2026-10: the second batch answered {r.status_code} {second}, expected accepted 1, deduped 1"
        r = await _create(c, {**BODY, "items": ["a cat", "a bird"]}, "k-3")
        assert r.status_code == 409 and r.json().get("error") == "no_new_items", f"a batch whose items are all queued answered {r.status_code} {r.text}, expected 409 {{'error': 'no_new_items'}}"
        assert len(_tasks(ctx)) == 2, f"the all-duplicate batch left a task: {_tasks(ctx)}"
        r = await _create(c, {**BODY, "spec_version": "2026-11", "items": ["a cat"]}, "k-4")
    assert r.status_code == 201 and r.json().get("accepted") == 1, f"under another spec the same item is a new question: answered {r.status_code} {r.text}"


async def check_idempotent_create(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/tasks", json=BODY, headers={"X-Tenant-Id": "t1"})
        assert r.status_code == 400, f"a create without Idempotency-Key answered {r.status_code}, expected 400"
        assert _tasks(ctx) == [], f"a create without Idempotency-Key left {_tasks(ctx)}"
        first = await _create(c, BODY, "k-1")
        assert first.status_code == 201, f"the first create answered {first.status_code}: {first.text}"
        replay = await _create(c, BODY, "k-1")
        assert replay.status_code == 200 and replay.json() == first.json(), f"a retry with the same Idempotency-Key answered {replay.status_code} {replay.text}, expected 200 and the first answer {first.text}"
        assert len(_tasks(ctx)) == 1, f"a retried create made a second task: {_tasks(ctx)}"
        other = await _create(c, {**BODY, "items": ["a bird"]}, "k-1", tenant="t2")
    assert other.status_code == 201 and other.json().get("task_id") != first.json()["task_id"], f"key k-1 of tenant t2 is another create, it answered {other.status_code} {other.text}"
`,
    typescript: `const BODY = {items: ['a cat on a mat', 'a dog in the fog'], spec_version: '2026-10', overlap: 3};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/labeling/store.ts')};
}

const create = (c, body, key = 'k-1', tenant = 't1') => c.post('/v1/tasks', {json: body, headers: {'X-Tenant-Id': tenant, 'Idempotency-Key': key}});

const tasks = ctx => (ctx.redis.keys('task:t-*') as string[]).sort();

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await create(c, BODY);
  assert.equal(r.status, 201, \`POST /v1/tasks answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const task = await store.getTask(body.task_id ?? '');
  assert(task !== null, \`the create answered \${r.text} but the store holds no task \${body.task_id}\`);
  assert(task.tenant === 't1' && task.total_items === 2, \`the store holds \${JSON.stringify(task)}, expected tenant t1 with 2 items\`);
  assert.equal(body.accepted, 2, \`two new items must be accepted, the create answered \${r.text}\`);
}

export async function check_spec_pinned(ctx) {
  const {c, store} = api(ctx);
  for (const [n, spec] of [undefined, '', '   '].entries()) {
    const body: Record<string, unknown> = {items: BODY.items, overlap: BODY.overlap};
    if (spec !== undefined) body.spec_version = spec;
    const r = await create(c, body, \`k-\${n}\`);
    assert.equal(r.status, 400, \`a create with spec_version \${JSON.stringify(spec)} answered \${r.status}: \${r.text}. A task must be pinned to a named spec version: 400\`);
  }
  assert.deepEqual(tasks(ctx), [], \`the rejected creates left tasks behind: \${JSON.stringify(tasks(ctx))}\`);
  const r = await create(c, BODY, 'k-9');
  assert.equal(r.status, 201, \`a create with spec_version 2026-10 answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().spec_version, '2026-10', \`the create answered \${r.text}, expected spec_version 2026-10\`);
  const task = await store.getTask(r.json().task_id);
  assert.equal(task.spec_version, '2026-10', \`the stored task is pinned to \${JSON.stringify(task.spec_version)}, expected 2026-10\`);
}

export async function check_batch_bounds(ctx) {
  const {c} = api(ctx);
  const cases: [Record<string, unknown>, string][] = [
    [{items: []}, 'an empty batch'],
    [{items: Array.from({length: 201}, (_, n) => \`item \${n}\`)}, 'a batch of 201 items'],
    [{items: ['a cat', '']}, 'a batch with an empty item'],
    [{overlap: 0}, 'overlap 0'],
    [{overlap: 6}, 'overlap 6'],
  ];
  for (const [n, [change, what]] of cases.entries()) {
    const r = await create(c, {...BODY, ...change}, \`k-\${n}\`);
    assert.equal(r.status, 400, \`\${what} answered \${r.status}: \${r.text}. Items are 1..MAX_BATCH_ITEMS = 200 non-empty strings and overlap 1..MAX_OVERLAP = 5: 400\`);
  }
  assert.deepEqual(tasks(ctx), [], \`the rejected creates left tasks behind: \${JSON.stringify(tasks(ctx))}\`);
  const r = await create(c, {...BODY, items: Array.from({length: 200}, (_, n) => \`item \${n}\`), overlap: 5}, 'k-ok');
  assert.equal(r.status, 201, \`200 items with overlap 5 are within bounds, the create answered \${r.status}: \${r.text}\`);
}

export async function check_content_dedupe(ctx) {
  const {c, store} = api(ctx);
  let r = await create(c, {...BODY, items: ['a cat', 'a dog', 'a cat']}, 'k-1');
  assert.equal(r.status, 201, \`the first create answered \${r.status}: \${r.text}\`);
  const first = r.json();
  assert(first.accepted === 2 && first.deduped === 1, \`a batch repeating 'a cat' answered \${r.text}: the repeat must be dropped and counted (accepted 2, deduped 1)\`);
  assert.equal((await store.getTask(first.task_id)).total_items, 2, 'the task must hold the 2 distinct items');
  r = await create(c, {...BODY, items: ['a dog', 'a bird']}, 'k-2');
  assert(r.status === 201 && r.json().accepted === 1 && r.json().deduped === 1, \`'a dog' is already queued under 2026-10: the second batch answered \${r.status} \${r.text}, expected accepted 1, deduped 1\`);
  r = await create(c, {...BODY, items: ['a cat', 'a bird']}, 'k-3');
  assert(r.status === 409 && r.json().error === 'no_new_items', \`a batch whose items are all queued answered \${r.status} \${r.text}, expected 409 {"error": "no_new_items"}\`);
  assert.equal(tasks(ctx).length, 2, \`the all-duplicate batch left a task: \${JSON.stringify(tasks(ctx))}\`);
  r = await create(c, {...BODY, spec_version: '2026-11', items: ['a cat']}, 'k-4');
  assert(r.status === 201 && r.json().accepted === 1, \`under another spec the same item is a new question: answered \${r.status} \${r.text}\`);
}

export async function check_idempotent_create(ctx) {
  const {c} = api(ctx);
  const none = await c.post('/v1/tasks', {json: BODY, headers: {'X-Tenant-Id': 't1'}});
  assert.equal(none.status, 400, \`a create without Idempotency-Key answered \${none.status}, expected 400\`);
  assert.deepEqual(tasks(ctx), [], \`a create without Idempotency-Key left \${JSON.stringify(tasks(ctx))}\`);
  const first = await create(c, BODY, 'k-1');
  assert.equal(first.status, 201, \`the first create answered \${first.status}: \${first.text}\`);
  const replay = await create(c, BODY, 'k-1');
  assert(replay.status === 200 && JSON.stringify(replay.json()) === JSON.stringify(first.json()), \`a retry with the same Idempotency-Key answered \${replay.status} \${replay.text}, expected 200 and the first answer \${first.text}\`);
  assert.equal(tasks(ctx).length, 1, \`a retried create made a second task: \${JSON.stringify(tasks(ctx))}\`);
  const other = await create(c, {...BODY, items: ['a bird']}, 'k-1', 't2');
  assert(other.status === 201 && other.json().task_id !== first.json().task_id, \`key k-1 of tenant t2 is another create, it answered \${other.status} \${other.text}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"labeling/store"

	"leetbuild/harness"
)

var apiBody = map[string]any{"items": []string{"a cat on a mat", "a dog in the fog"}, "spec_version": "2026-10", "overlap": 3}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func with(change map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range apiBody {
		out[k] = v
	}
	for k, v := range change {
		if v == nil {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out
}

func create(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	return c.Post("/v1/tasks", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func answer(ctx *harness.Ctx, r *harness.Response) map[string]any {
	m, _ := r.JSON().(map[string]any)
	ctx.Assert(m != nil, "the response body is not a JSON object: %s", r.Text())
	return m
}

func items(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("item %d", i)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := create(c, apiBody, "k-1", "t1")
	ctx.Equal(r.Status, 201, "POST /v1/tasks (%s)", r.Text())
	body := answer(ctx, r)
	taskID, _ := body["task_id"].(string)
	task := store.GetTask(context.Background(), taskID)
	ctx.Assert(task != nil, "the create answered %s but the store holds no task %q", r.Text(), taskID)
	ctx.Assert(task.Tenant == "t1" && task.TotalItems == 2, "the store holds %+v, expected tenant t1 with 2 items", task)
	ctx.Equal(body["accepted"], float64(2), "two new items must be accepted; accepted")
}

func CheckSpecPinned(ctx *harness.Ctx) {
	c := api(ctx)
	for n, spec := range []any{nil, "", "   "} {
		body := with(map[string]any{"spec_version": nil})
		if spec != nil {
			body["spec_version"] = spec
		}
		r := create(c, body, fmt.Sprintf("k-%d", n), "t1")
		ctx.Equal(r.Status, 400, "a create with spec_version %v answered %s. A task must be pinned to a named spec version; the status", spec, r.Text())
	}
	ctx.Equal(len(ctx.Redis.Keys("task:t-*")), 0, "the rejected creates must leave no task; tasks")
	r := create(c, apiBody, "k-9", "t1")
	ctx.Equal(r.Status, 201, "a create with spec_version 2026-10 (%s)", r.Text())
	body := answer(ctx, r)
	ctx.Equal(body["spec_version"], "2026-10", "the create's spec_version")
	taskID, _ := body["task_id"].(string)
	ctx.Equal(store.GetTask(context.Background(), taskID).SpecVersion, "2026-10", "the spec version the stored task is pinned to")
}

func CheckBatchBounds(ctx *harness.Ctx) {
	c := api(ctx)
	cases := []struct {
		change map[string]any
		what   string
	}{
		{map[string]any{"items": []string{}}, "an empty batch"},
		{map[string]any{"items": items(201)}, "a batch of 201 items"},
		{map[string]any{"items": []string{"a cat", ""}}, "a batch with an empty item"},
		{map[string]any{"overlap": 0}, "overlap 0"},
		{map[string]any{"overlap": 6}, "overlap 6"},
	}
	for n, tc := range cases {
		r := create(c, with(tc.change), fmt.Sprintf("k-%d", n), "t1")
		ctx.Equal(r.Status, 400, "%s answered %s. Items are 1..maxBatchItems = 200 non-empty strings and overlap 1..maxOverlap = 5; the status", tc.what, r.Text())
	}
	ctx.Equal(len(ctx.Redis.Keys("task:t-*")), 0, "the rejected creates must leave no task; tasks")
	r := create(c, with(map[string]any{"items": items(200), "overlap": 5}), "k-ok", "t1")
	ctx.Equal(r.Status, 201, "200 items with overlap 5 are within bounds (%s)", r.Text())
}

func CheckContentDedupe(ctx *harness.Ctx) {
	c := api(ctx)
	r := create(c, with(map[string]any{"items": []string{"a cat", "a dog", "a cat"}}), "k-1", "t1")
	ctx.Equal(r.Status, 201, "the first create (%s)", r.Text())
	first := answer(ctx, r)
	ctx.Assert(first["accepted"] == float64(2) && first["deduped"] == float64(1), "a batch repeating 'a cat' answered %s: the repeat must be dropped and counted (accepted 2, deduped 1)", r.Text())
	taskID, _ := first["task_id"].(string)
	ctx.Equal(store.GetTask(context.Background(), taskID).TotalItems, 2, "the task must hold the 2 distinct items; its items")
	r = create(c, with(map[string]any{"items": []string{"a dog", "a bird"}}), "k-2", "t1")
	second := answer(ctx, r)
	ctx.Assert(r.Status == 201 && second["accepted"] == float64(1) && second["deduped"] == float64(1), "'a dog' is already queued under 2026-10: the second batch answered %d %s, expected accepted 1, deduped 1", r.Status, r.Text())
	r = create(c, with(map[string]any{"items": []string{"a cat", "a bird"}}), "k-3", "t1")
	ctx.Assert(r.Status == 409 && answer(ctx, r)["error"] == "no_new_items", "a batch whose items are all queued answered %d %s, expected 409 {\\"error\\": \\"no_new_items\\"}", r.Status, r.Text())
	ctx.Equal(len(ctx.Redis.Keys("task:t-*")), 2, "the all-duplicate batch must leave no task; tasks")
	r = create(c, with(map[string]any{"spec_version": "2026-11", "items": []string{"a cat"}}), "k-4", "t1")
	ctx.Assert(r.Status == 201 && answer(ctx, r)["accepted"] == float64(1), "under another spec the same item is a new question: answered %d %s", r.Status, r.Text())
}

func CheckIdempotentCreate(ctx *harness.Ctx) {
	c := api(ctx)
	none := c.Post("/v1/tasks", apiBody, "X-Tenant-Id", "t1")
	ctx.Equal(none.Status, 400, "a create without Idempotency-Key")
	ctx.Equal(len(ctx.Redis.Keys("task:t-*")), 0, "a create without Idempotency-Key must leave no task; tasks")
	first := create(c, apiBody, "k-1", "t1")
	ctx.Equal(first.Status, 201, "the first create (%s)", first.Text())
	replay := create(c, apiBody, "k-1", "t1")
	ctx.Equal(replay.Status, 200, "a retry with the same Idempotency-Key (%s)", replay.Text())
	ctx.Equal(answer(ctx, replay), answer(ctx, first), "a retry with the same Idempotency-Key must answer the first answer")
	ctx.Equal(len(ctx.Redis.Keys("task:t-*")), 1, "a retried create must not make a second task; tasks")
	other := create(c, with(map[string]any{"items": []string{"a bird"}}), "k-1", "t2")
	ctx.Assert(other.Status == 201 && answer(ctx, other)["task_id"] != answer(ctx, first)["task_id"], "key k-1 of tenant t2 is another create, it answered %d %s", other.Status, other.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

const json kBody = {{"items", {"a cat on a mat", "a dog in the fog"}}, {"spec_version", "2026-10"}, {"overlap", 3}};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json with(const json& change) {
  json out = kBody;
  for (const auto& [k, v] : change.items()) {
    if (v.is_null()) {
      out.erase(k);
    } else {
      out[k] = v;
    }
  }
  return out;
}

harness::Response create(harness::HTTP& c, const json& body, const std::string& key, const std::string& tenant = "t1") {
  return c.Post("/v1/tasks", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

json answer(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the response body is not a JSON object: %s", r.Text());
  return body;
}

json items(int n) {
  json out = json::array();
  for (int i = 0; i < n; i++) out.push_back("item " + std::to_string(i));
  return out;
}

size_t taskCount(harness::Ctx& ctx) { return ctx.Redis.Keys("task:t-*").size(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = create(c, kBody, "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/tasks (%s)", r.Text());
  const json body = answer(ctx, r);
  const std::string task_id = body.value("task_id", "");
  const auto task = store::getTask(task_id);
  ctx.Assert(task.has_value(), "the create answered %s but the store holds no task %q", r.Text(), task_id);
  ctx.Assert(task->tenant == "t1" && task->total_items == 2, "the store holds tenant %q with %d items, expected tenant t1 with 2 items", task->tenant, task->total_items);
  ctx.Equal(body.value("accepted", 0L), 2L, "two new items must be accepted; accepted");
}

void CheckSpecPinned(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<json> specs = {json(), json(""), json("   ")};
  for (size_t n = 0; n < specs.size(); n++) {
    json body = with(json{{"spec_version", nullptr}});
    if (!specs[n].is_null()) body["spec_version"] = specs[n];
    const auto r = create(c, body, "k-" + std::to_string(n));
    ctx.Equal(r.Status, 400, "a create with spec_version %s answered %s. A task must be pinned to a named spec version; the status", specs[n].dump(), r.Text());
  }
  ctx.Equal(taskCount(ctx), 0, "the rejected creates must leave no task; tasks");
  const auto r = create(c, kBody, "k-9");
  ctx.Equal(r.Status, 201, "a create with spec_version 2026-10 (%s)", r.Text());
  const json body = answer(ctx, r);
  ctx.Equal(body.value("spec_version", ""), "2026-10", "the create's spec_version");
  ctx.Equal(store::getTask(body.value("task_id", ""))->spec_version, "2026-10", "the spec version the stored task is pinned to");
}

void CheckBatchBounds(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::pair<json, std::string>> cases = {
      {json{{"items", json::array()}}, "an empty batch"},
      {json{{"items", items(201)}}, "a batch of 201 items"},
      {json{{"items", {"a cat", ""}}}, "a batch with an empty item"},
      {json{{"overlap", 0}}, "overlap 0"},
      {json{{"overlap", 6}}, "overlap 6"},
  };
  for (size_t n = 0; n < cases.size(); n++) {
    const auto r = create(c, with(cases[n].first), "k-" + std::to_string(n));
    ctx.Equal(r.Status, 400, "%s answered %s. Items are 1..kMaxBatchItems = 200 non-empty strings and overlap 1..kMaxOverlap = 5; the status", cases[n].second, r.Text());
  }
  ctx.Equal(taskCount(ctx), 0, "the rejected creates must leave no task; tasks");
  const auto r = create(c, with(json{{"items", items(200)}, {"overlap", 5}}), "k-ok");
  ctx.Equal(r.Status, 201, "200 items with overlap 5 are within bounds (%s)", r.Text());
}

void CheckContentDedupe(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = create(c, with(json{{"items", {"a cat", "a dog", "a cat"}}}), "k-1");
  ctx.Equal(r.Status, 201, "the first create (%s)", r.Text());
  const json first = answer(ctx, r);
  ctx.Assert(first.value("accepted", 0L) == 2 && first.value("deduped", 0L) == 1, "a batch repeating 'a cat' answered %s: the repeat must be dropped and counted (accepted 2, deduped 1)", r.Text());
  ctx.Equal(store::getTask(first.value("task_id", ""))->total_items, 2L, "the task must hold the 2 distinct items; its items");
  r = create(c, with(json{{"items", {"a dog", "a bird"}}}), "k-2");
  const json second = answer(ctx, r);
  ctx.Assert(r.Status == 201 && second.value("accepted", 0L) == 1 && second.value("deduped", 0L) == 1, "'a dog' is already queued under 2026-10: the second batch answered %d %s, expected accepted 1, deduped 1", r.Status, r.Text());
  r = create(c, with(json{{"items", {"a cat", "a bird"}}}), "k-3");
  ctx.Assert(r.Status == 409 && answer(ctx, r).value("error", "") == "no_new_items", "a batch whose items are all queued answered %d %s, expected 409 {\\"error\\": \\"no_new_items\\"}", r.Status, r.Text());
  ctx.Equal(taskCount(ctx), 2, "the all-duplicate batch must leave no task; tasks");
  r = create(c, with(json{{"spec_version", "2026-11"}, {"items", {"a cat"}}}), "k-4");
  ctx.Assert(r.Status == 201 && answer(ctx, r).value("accepted", 0L) == 1, "under another spec the same item is a new question: answered %d %s", r.Status, r.Text());
}

void CheckIdempotentCreate(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto none = c.Post("/v1/tasks", kBody.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(none.Status, 400, "a create without Idempotency-Key");
  ctx.Equal(taskCount(ctx), 0, "a create without Idempotency-Key must leave no task; tasks");
  const auto first = create(c, kBody, "k-1");
  ctx.Equal(first.Status, 201, "the first create (%s)", first.Text());
  const auto replay = create(c, kBody, "k-1");
  ctx.Equal(replay.Status, 200, "a retry with the same Idempotency-Key (%s)", replay.Text());
  ctx.Equal(answer(ctx, replay), answer(ctx, first), "a retry with the same Idempotency-Key must answer the first answer");
  ctx.Equal(taskCount(ctx), 1, "a retried create must not make a second task; tasks");
  const auto other = create(c, with(json{{"items", {"a bird"}}}), "k-1", "t2");
  ctx.Assert(other.Status == 201 && answer(ctx, other).value("task_id", "") != answer(ctx, first).value("task_id", ""), "key k-1 of tenant t2 is another create, it answered %d %s", other.Status, other.Text());
}
`,
  },
  hints: [
    'A client that times out and retries its create gets two task ids over the same items, and a create with no `spec_version` comes back pinned to `latest`; an empty batch makes an empty task.',
    'The handler never reads `Idempotency-Key`, so each retry is a fresh create; nothing hashes an item or compares a count with a limit, and the spec version has a fallback instead of a check.',
    'Require the key and answer `store.create_result(tenant, key)` with 200 when it exists; 400 a blank spec, bad item counts or overlap; hash with SHA-256 against `seen_hashes` and the batch, 409 when nothing is new, then `create_task`, `add_hashes`, `record_create`.',
  ],
  debrief: `The recorded answer is looked up before anything is validated or written, so a retry costs one read and can never race its original into a second task. Hashing under the spec makes an item's bytes its identity: the same text under another spec is a different question and is queued again, while a repeat under the same spec would pay two annotators for one answer. Pinning the spec version is a single stored field, but it is what makes the agreement numbers of step 5 comparable across a week of work. Production services also fingerprint the request body so that two different batches under one key are refused instead of replayed, expire the recorded answers after a day, and meter items per tenant.`,
};
