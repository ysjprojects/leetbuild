import type {Step} from '@/lib/types';

export const taskEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/tasks: a labeling task with a real spec',
  concept: 'http',
  file: 'api',
  focus: ['client', 'service', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and answers \`201\` with a fresh task id. It compiles, the demo posts a handful of items
under one spec and never retries, and it queues exactly what the caller sent — so the cohort that
reaches the reviewers is not the cohort anyone agreed to pay for. Review it like the service owner,
fix it, and prove the fix with the checks below.

Implement \`POST /v1/tasks\` with body
\`{"items": ["…", …], "spec_version": "2024-05-01", "reviewers": 3}\` — an item is the raw item
payload string in this exercise.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing). The created task is stored under
  \`(tenant, key)\` and a replay of the same create returns the stored task with **200** instead of
  creating a second one.
- \`spec_version\` is required and must be a non-empty string (missing or blank → **400**). The task
  record is **pinned** to it, so reviewers never see "whatever spec is current".
- \`items\` is a non-empty list of at most \`MAX_BATCH_ITEMS = 200\` non-empty strings (**400**
  otherwise). An unbounded batch lets one request enqueue a million items.
- \`reviewers\` is an integer from \`MIN_REVIEWERS = 1\` to \`MAX_REVIEWERS = 5\` (**400**
  otherwise).
- Dedup by content hash: \`content_hash(item)\` is the sha256 hex of the item's UTF-8 bytes. Items
  whose hash already exists under the same spec (in the store) and items that repeat inside the
  batch are dropped from the batch and counted in the response's \`deduped\`; when nothing new
  remains the answer is **409** \`{"error": "no_new_items"}\`. Dedup happens **before** assignment.
- **201** response: \`{"task_id", "spec_version", "reviewers", "accepted", "deduped"}\`.

**Failure mode the checks target.** The draft computes no content hash, so a retried or overlapping
batch queues the same item twice — a second payment for the same answer; it never reads or stores
\`spec_version\`, so the labels a reviewer submits get compared against whatever taxonomy is current
weeks later; it accepts unbounded batches and any reviewer count, so one fat request is an unbounded
cohort; and it ignores \`Idempotency-Key\`, so the retry every client does creates a competing cohort
over the same items.`,
  sequence: {
    participants: ['Client', 'labeld', 'task store'],
    messages: [
      {
        from: 'Client',
        to: 'labeld',
        label: 'POST /v1/tasks · X-Tenant-Id · Idempotency-Key · {items, spec_version, reviewers}',
        kind: 'sync',
      },
      {
        from: 'labeld',
        to: 'labeld',
        label: 'validate tenant · spec_version · items ≤ 200 · reviewers 1..5',
        kind: 'sync',
      },
      {from: 'labeld', to: 'task store', label: 'get_by_key(tenant, Idempotency-Key)', kind: 'sync'},
      {from: 'task store', to: 'labeld', label: 'stored task / none', kind: 'reply'},
      {
        from: 'labeld',
        to: 'labeld',
        label: 'content_hash(item) · drop hashes already queued under spec_version',
        kind: 'sync',
      },
      {
        from: 'labeld',
        to: 'task store',
        label: 'put(tenant, key, task pinned to spec_version, new hashes)',
        kind: 'async',
      },
      {from: 'labeld', to: 'Client', label: '201 {task_id, spec_version, reviewers, accepted, deduped}', kind: 'reply'},
      {from: 'Client', to: 'labeld', label: 'POST /v1/tasks · same Idempotency-Key (retry)', kind: 'sync'},
      {from: 'labeld', to: 'Client', label: '200 stored task — no second cohort', kind: 'reply'},
      {
        from: 'labeld',
        to: 'Client',
        label: '409 {error: no_new_items} when every hash is already queued',
        kind: 'reply',
      },
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
        'A create without a non-blank `spec_version` is **400**, and the stored task record carries the version it was created under so every reviewer answers the same frozen question. The draft never reads the field and never pins it, so the cohort silently follows whatever spec is current.',
      match: {
        python: {
          all: [/spec_version/, /status_code\s*=\s*400/, /"spec_version":\s*body\.spec_version/],
        },
        typescript: {all: [/spec_version/, /code\(\s*400\s*\)/, /spec_version:\s*specVersion/]},
        go: {all: [/SpecVersion/, /StatusBadRequest/, /"spec_version":\s*body\.SpecVersion/]},
        scala: {all: [/Task\([^;]*body\.spec_version/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/spec_version/, /\b400\b/, /\{"spec_version",\s*specVersion\}/]},
      },
    },
    {
      id: 'batch-bounds',
      title: 'Bounds the batch size and the reviewer count',
      detail:
        '`items` is 1..`MAX_BATCH_ITEMS = 200` non-empty strings and `reviewers` is `MIN_REVIEWERS`..`MAX_REVIEWERS`, both **400** outside the range. The draft carries no caps and no named limits at all, so one request can enqueue a million items or ask for a cohort of zero reviewers.',
      match: {
        python: {
          all: [/MAX_BATCH_ITEMS\s*=\s*200/, /MIN_REVIEWERS\s*=\s*1/, /MAX_REVIEWERS\s*=\s*5/, /status_code\s*=\s*400/],
        },
        typescript: {
          all: [/MAX_BATCH_ITEMS\s*=\s*200/, /MIN_REVIEWERS\s*=\s*1/, /MAX_REVIEWERS\s*=\s*5/, /code\(\s*400\s*\)/],
        },
        go: {
          all: [/maxBatchItems\s*=\s*200/, /minReviewers\s*=\s*1/, /maxReviewers\s*=\s*5/, /StatusBadRequest/],
        },
        scala: {
          all: [/MaxBatchItems\s*=\s*200/, /MinReviewers\s*=\s*1/, /MaxReviewers\s*=\s*5/, /StatusCodes\.BadRequest/],
        },
        cpp: {
          all: [/kMaxBatchItems\s*=\s*200/, /kMinReviewers\s*=\s*1/, /kMaxReviewers\s*=\s*5/, /\b400\b/],
        },
      },
    },
    {
      id: 'content-dedupe',
      title: 'Dedupes items by content hash under the spec',
      detail:
        'Items are hashed with `content_hash` (sha256 hex of the UTF-8 bytes) and dropped when the spec already queued that hash or the batch repeats it; every drop is counted in `deduped` and an all-duplicate batch answers **409 `{"error": "no_new_items"}`** before anything is written. The draft computes no hash, so a retry re-queues every item.',
      match: {
        python: {
          all: [/def content_hash\(/, /hashlib\.sha256/, /seen_hashes\(/, /no_new_items/, /status_code\s*=\s*409/],
        },
        typescript: {
          all: [
            /function contentHash\(/,
            /createHash\(\s*'sha256'\s*\)/,
            /seenHashes\(/,
            /no_new_items/,
            /code\(\s*409\s*\)/,
          ],
        },
        go: {
          all: [/func contentHash\(/, /sha256\.Sum256/, /SeenHashes\(/, /no_new_items/, /StatusConflict/],
        },
        scala: {
          all: [
            /def contentHash\(/,
            /MessageDigest\.getInstance\("SHA-256"\)/,
            /seenHashes\(/,
            /no_new_items/,
            /StatusCodes\.Conflict/,
          ],
        },
        cpp: {all: [/content_hash\(/, /sha256_hex\(/, /seenHashes\(/, /no_new_items/, /\b409\b/]},
      },
    },
    {
      id: 'idempotent-create',
      title: 'A replayed create reuses the task',
      detail:
        '`Idempotency-Key` is required (**400** when missing); the task is stored under `(tenant, key)` and a replay returns the stored task with **200** instead of creating a competing cohort over the same items. The draft ignores the header entirely, so every client retry queues a second task.',
      match: {
        python: {
          all: [/Idempotency-Key/, /store\.get_by_key\(tenant, idem_key\)/, /store\.put\(/, /status_code\s*=\s*200/],
        },
        typescript: {
          all: [/Idempotency-Key/, /store\.getByKey\(tenant, idemKey\)/, /store\.put\(/, /code\(\s*200\s*\)/],
        },
        go: {
          all: [/Idempotency-Key/, /store\.GetByKey\(ctx, tenant, idemKey\)/, /store\.Put\(/, /StatusOK/],
        },
        scala: {all: [/Idempotency-Key/, /getByKey\(tenant, idemKey\)/, /store\.put\(/, /StatusCodes\.OK/]},
        cpp: {all: [/Idempotency-Key/, /getByKey\(tenant, idemKey\)/, /store\.put\(/, /\b200\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()


class TaskRequest(BaseModel):
    items: list[str] = []
    spec_version: str = ""
    reviewers: int = 0


def assign(tenant: str, task_id: str, items: list[str]) -> None:
    """Hand the items to the reviewers; a rejected request must never reach this."""
    raise NotImplementedError


@app.post("/v1/tasks")
def create_task(body: TaskRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft accepts unbounded batches and any reviewer count, never reads or stores
    # spec_version (so reviewers see the current spec), computes no content hash (so a retry
    # re-queues every item), and ignores Idempotency-Key entirely.
    task_id = str(uuid.uuid4())
    assign(tenant, task_id, body.items)
    return {"task_id": task_id, "reviewers": body.reviewers, "accepted": len(body.items)}
`,
      solution: `import hashlib
import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("labeld")

MAX_BATCH_ITEMS = 200
MIN_REVIEWERS = 1
MAX_REVIEWERS = 5


class TaskRequest(BaseModel):
    """An item is the raw payload string; it never reaches the response or the logs."""

    items: list[str] = []
    spec_version: str = ""
    reviewers: int = 0


class TaskStore:
    def get_by_key(self, tenant: str, idem_key: str) -> dict | None:
        """The task stored under (tenant, key), if any."""
        raise NotImplementedError

    def seen_hashes(self, spec_version: str) -> set[str]:
        """Content hashes already queued under this spec version."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, task: dict, hashes: list[str]) -> None:
        """Store the task under (tenant, key) and register its item hashes under the spec."""
        raise NotImplementedError


store = TaskStore()


def content_hash(item: str) -> str:
    return hashlib.sha256(item.encode("utf-8")).hexdigest()


def validate(body: TaskRequest) -> None:
    if body.spec_version.strip() == "":
        raise HTTPException(status_code=400, detail="spec_version must be a non-empty string")
    if not body.items or len(body.items) > MAX_BATCH_ITEMS or any(item == "" for item in body.items):
        raise HTTPException(status_code=400, detail="items must be 1..200 non-empty strings")
    if not MIN_REVIEWERS <= body.reviewers <= MAX_REVIEWERS:
        raise HTTPException(status_code=400, detail="reviewers must be 1..5")


@app.post("/v1/tasks")
def create_task(
    body: TaskRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    validate(body)

    stored = store.get_by_key(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    seen = store.seen_hashes(body.spec_version)
    accepted: list[str] = []
    hashes: list[str] = []
    deduped = 0
    for item in body.items:
        digest = content_hash(item)
        if digest in seen:
            deduped += 1
            continue
        seen.add(digest)
        accepted.append(item)
        hashes.append(digest)
    if not accepted:
        return JSONResponse({"error": "no_new_items"}, status_code=409)

    task = {
        "task_id": str(uuid.uuid4()),
        "spec_version": body.spec_version,
        "reviewers": body.reviewers,
        "accepted": len(accepted),
        "deduped": deduped,
    }
    store.put(tenant, idem_key, task, hashes)
    logger.info("task created tenant=%s task_id=%s spec=%s", tenant, task["task_id"], body.spec_version)
    return JSONResponse(task, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/tasks: a model-generated draft that queues whatever batch the caller sends. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface TaskBody {
  items: string[];
  spec_version?: string;
  reviewers?: number;
}

async function assign(tenant: string, taskId: string, items: string[]): Promise<void> {
  void tenant;
  void taskId;
  void items;
}

app.post('/v1/tasks', async (request, reply) => {
  // TODO: this draft accepts unbounded batches and any reviewer count, never reads or stores
  // spec_version (so reviewers see the current spec), computes no content hash (so a retry
  // re-queues every item), and ignores Idempotency-Key entirely.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as TaskBody;
  const taskId = randomUUID();
  await assign(tenant, taskId, body.items);
  return reply.code(201).send({task_id: taskId, reviewers: body.reviewers, accepted: body.items.length});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/tasks: one validated, idempotent labeling task per (tenant, key). */
import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_BATCH_ITEMS = 200;
const MIN_REVIEWERS = 1;
const MAX_REVIEWERS = 5;

interface TaskBody {
  items?: string[];
  spec_version?: string;
  reviewers?: number;
}

interface Task {
  task_id: string;
  spec_version: string;
  reviewers: number;
  accepted: number;
  deduped: number;
}

class TaskStore {
  async getByKey(tenant: string, idemKey: string): Promise<Task | null> {
    throw new Error('task store not configured');
  }

  async seenHashes(specVersion: string): Promise<Set<string>> {
    throw new Error('task store not configured');
  }

  async put(tenant: string, idemKey: string, task: Task, hashes: string[]): Promise<void> {
    throw new Error('task store not configured');
  }
}

const store = new TaskStore();

function contentHash(item: string): string {
  return createHash('sha256').update(item, 'utf8').digest('hex');
}

app.post('/v1/tasks', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<TaskBody> | null;
  const specVersion = body?.spec_version;
  if (typeof specVersion !== 'string' || specVersion.trim() === '')
    return reply.code(400).send({error: 'spec_version must be a non-empty string'});
  const items = body?.items;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > MAX_BATCH_ITEMS ||
    items.some((item: string) => typeof item !== 'string' || item === '')
  )
    return reply.code(400).send({error: 'items must be 1..200 non-empty strings'});
  const reviewers = body?.reviewers;
  if (
    typeof reviewers !== 'number' ||
    !Number.isInteger(reviewers) ||
    reviewers < MIN_REVIEWERS ||
    reviewers > MAX_REVIEWERS
  )
    return reply.code(400).send({error: 'reviewers must be 1..5'});

  const stored = await store.getByKey(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const seen = await store.seenHashes(specVersion);
  const accepted: string[] = [];
  const hashes: string[] = [];
  let deduped = 0;
  for (const item of items) {
    const digest = contentHash(item);
    if (seen.has(digest)) {
      deduped += 1;
      continue;
    }
    seen.add(digest);
    accepted.push(item);
    hashes.push(digest);
  }
  if (accepted.length === 0) return reply.code(409).send({error: 'no_new_items'});

  const task: Task = {
    task_id: randomUUID(),
    spec_version: specVersion,
    reviewers,
    accepted: accepted.length,
    deduped,
  };
  await store.put(tenant, idemKey, task, hashes);
  request.log.info({tenant, task_id: task.task_id, spec: specVersion}, 'task created');
  return reply.code(201).send(task);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type TaskRequest struct {
	Items       []string \`json:"items"\`
	SpecVersion string   \`json:"spec_version"\`
	Reviewers   int      \`json:"reviewers"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func assign(tenant, taskID string, items []string) {}

func createTask(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body TaskRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts unbounded batches and any reviewer count, never reads or stores
	// SpecVersion (so reviewers see the current spec), computes no content hash (so a retry
	// re-queues every item), and ignores Idempotency-Key entirely.
	taskID := uuid.NewString()
	assign(tenant, taskID, body.Items)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"task_id":   taskID,
		"reviewers": body.Reviewers,
		"accepted":  len(body.Items),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tasks", createTask)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

const (
	maxBatchItems = 200
	minReviewers  = 1
	maxReviewers  = 5
)

type TaskRequest struct {
	Items       []string \`json:"items"\`
	SpecVersion string   \`json:"spec_version"\`
	Reviewers   int      \`json:"reviewers"\`
}

type TaskStore struct{}

func (s *TaskStore) GetByKey(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *TaskStore) SeenHashes(ctx context.Context, specVersion string) (map[string]bool, error) {
	return nil, nil
}

func (s *TaskStore) Put(ctx context.Context, tenant, idemKey string, task map[string]any, hashes []string) error {
	return nil
}

var store = &TaskStore{}

func contentHash(item string) string {
	sum := sha256.Sum256([]byte(item))
	return hex.EncodeToString(sum[:])
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createTask(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body TaskRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.SpecVersion) == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "spec_version must be a non-empty string"})
		return
	}
	if len(body.Items) < 1 || len(body.Items) > maxBatchItems {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "items must be 1..200 non-empty strings"})
		return
	}
	for _, item := range body.Items {
		if item == "" {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "items must be 1..200 non-empty strings"})
			return
		}
	}
	if body.Reviewers < minReviewers || body.Reviewers > maxReviewers {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "reviewers must be 1..5"})
		return
	}
	ctx := r.Context()
	stored, err := store.GetByKey(ctx, tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	seen, err := store.SeenHashes(ctx, body.SpecVersion)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	accepted := make([]string, 0, len(body.Items))
	hashes := make([]string, 0, len(body.Items))
	deduped := 0
	for _, item := range body.Items {
		digest := contentHash(item)
		if seen[digest] {
			deduped++
			continue
		}
		seen[digest] = true
		accepted = append(accepted, item)
		hashes = append(hashes, digest)
	}
	if len(accepted) == 0 {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "no_new_items"})
		return
	}
	task := map[string]any{
		"task_id":      uuid.NewString(),
		"spec_version": body.SpecVersion,
		"reviewers":    body.Reviewers,
		"accepted":     len(accepted),
		"deduped":      deduped,
	}
	if err := store.Put(ctx, tenant, idemKey, task, hashes); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("task created tenant=%s task_id=%s spec=%s", tenant, task["task_id"], body.SpecVersion)
	writeJSON(rw, http.StatusCreated, task)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/tasks", createTask)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TaskRequest(items: List[String], spec_version: String, reviewers: Int)

object LabelApi {
  implicit val system: ActorSystem = ActorSystem("labeld")
  implicit val requestFormat: RootJsonFormat[TaskRequest] = jsonFormat3(TaskRequest)

  def assign(tenant: String, taskId: String, items: List[String]): Unit = ()

  val route: Route =
    path("v1" / "tasks") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[TaskRequest]) { body =>
            // TODO: this draft accepts unbounded batches and any reviewer count, never reads or
            // stores spec_version (so reviewers see the current spec), computes no content hash
            // (so a retry re-queues every item), and ignores Idempotency-Key entirely.
            val taskId = UUID.randomUUID().toString
            assign(tenant, taskId, body.items)
            complete(
              StatusCodes.Created,
              s"""{"task_id":"$taskId","reviewers":\${body.reviewers},"accepted":\${body.items.size}}"""
            )
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
import java.security.MessageDigest
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class TaskRequest(items: List[String], spec_version: String, reviewers: Int)
final case class Task(task_id: String, spec_version: String, reviewers: Int, accepted: Int, deduped: Int)

object TaskStore {
  def getByKey(tenant: String, idemKey: String): Option[String] = None
  def seenHashes(specVersion: String): Set[String] = Set.empty
  def put(tenant: String, idemKey: String, task: String, hashes: Set[String]): Unit = ()
}

object LabelApi {
  implicit val system: ActorSystem = ActorSystem("labeld")
  implicit val requestFormat: RootJsonFormat[TaskRequest] = jsonFormat3(TaskRequest)
  implicit val taskFormat: RootJsonFormat[Task] = jsonFormat5(Task)

  val MaxBatchItems = 200
  val MinReviewers = 1
  val MaxReviewers = 5

  val store = TaskStore

  def contentHash(item: String): String =
    MessageDigest.getInstance("SHA-256").digest(item.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  def dedupe(items: List[String], seen: Set[String]): (List[String], Int, Set[String]) = {
    var accepted = List.empty[String]
    var hashes = Set.empty[String]
    var deduped = 0
    items.foreach { item =>
      val digest = contentHash(item)
      if (seen.contains(digest) || hashes.contains(digest)) {
        deduped += 1
      } else {
        hashes += digest
        accepted = accepted :+ item
      }
    }
    (accepted, deduped, hashes)
  }

  val route: Route =
    path("v1" / "tasks") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[TaskRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.spec_version.trim.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"spec_version must be a non-empty string"}""")
              } else if (body.items.isEmpty || body.items.length > MaxBatchItems || body.items.exists(_.isEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"items must be 1..200 non-empty strings"}""")
              } else if (body.reviewers < MinReviewers || body.reviewers > MaxReviewers) {
                complete(StatusCodes.BadRequest, """{"error":"reviewers must be 1..5"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.getByKey(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val (accepted, deduped, hashes) = dedupe(body.items, store.seenHashes(body.spec_version))
                    if (accepted.isEmpty) {
                      complete(StatusCodes.Conflict, """{"error":"no_new_items"}""")
                    } else {
                      val task = Task(UUID.randomUUID().toString, body.spec_version, body.reviewers, accepted.size, deduped)
                      store.put(tenant, idemKey, task.toJson.compactPrint, hashes)
                      system.log.info(s"task created tenant=$tenant task_id=\${task.task_id} spec=\${task.spec_version}")
                      complete(StatusCodes.Created, task)
                    }
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

void assign(const std::string& tenant, const std::string& taskId, const json& items) {}

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/tasks", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts unbounded batches and any reviewer count, never reads or stores
    // spec_version (so reviewers see the current spec), computes no content hash (so a retry
    // re-queues every item), and ignores Idempotency-Key entirely.
    const auto taskId = uuidString();
    assign(tenant, taskId, body.value("items", json::array()));
    res.status = 201;
    res.set_content(
        json{{"task_id", taskId},
             {"reviewers", body.value("reviewers", 0)},
             {"accepted", body.value("items", json::array()).size()}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

using json = nlohmann::json;

constexpr std::size_t kMaxBatchItems = 200;
constexpr int kMinReviewers = 1;
constexpr int kMaxReviewers = 5;

struct TaskStore {
  std::optional<json> getByKey(const std::string& tenant, const std::string& idemKey);
  std::set<std::string> seenHashes(const std::string& specVersion);
  void put(const std::string& tenant, const std::string& idemKey, const json& task, const std::set<std::string>& hashes);
};

TaskStore store;
std::string uuidString();

std::string content_hash(const std::string& item) { return sha256_hex(item); }

int main() {
  httplib::Server svr;

  svr.Post("/v1/tasks", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto specVersion = body.value("spec_version", std::string());
    if (specVersion.find_first_not_of(" \\t\\r\\n") == std::string::npos) {
      res.status = 400;
      res.set_content(R"({"error":"spec_version must be a non-empty string"})", "application/json");
      return;
    }
    if (!body.contains("items") || !body["items"].is_array() || body["items"].empty() ||
        body["items"].size() > kMaxBatchItems) {
      res.status = 400;
      res.set_content(R"({"error":"items must be 1..200 non-empty strings"})", "application/json");
      return;
    }
    std::vector<std::string> batch;
    for (const auto& item : body["items"]) {
      if (!item.is_string() || item.get<std::string>().empty()) {
        res.status = 400;
        res.set_content(R"({"error":"items must be 1..200 non-empty strings"})", "application/json");
        return;
      }
      batch.push_back(item.get<std::string>());
    }
    const int reviewers = body.value("reviewers", 0);
    if (reviewers < kMinReviewers || reviewers > kMaxReviewers) {
      res.status = 400;
      res.set_content(R"({"error":"reviewers must be 1..5"})", "application/json");
      return;
    }
    const auto stored = store.getByKey(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const auto seen = store.seenHashes(specVersion);
    std::vector<std::string> accepted;
    std::set<std::string> hashes;
    int deduped = 0;
    for (const auto& item : batch) {
      const auto digest = content_hash(item);
      if (seen.count(digest) > 0 || hashes.count(digest) > 0) {
        ++deduped;
        continue;
      }
      hashes.insert(digest);
      accepted.push_back(item);
    }
    if (accepted.empty()) {
      res.status = 409;
      res.set_content(R"({"error":"no_new_items"})", "application/json");
      return;
    }
    const json task = {
        {"task_id", uuidString()},
        {"spec_version", specVersion},
        {"reviewers", reviewers},
        {"accepted", accepted.size()},
        {"deduped", deduped},
    };
    store.put(tenant, idemKey, task, hashes);
    std::cerr << "task created tenant=" << tenant << " task_id=" << task["task_id"] << " spec=" << specVersion
              << "\\n";
    res.status = 201;
    res.set_content(task.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guards in cost order: tenant (**401**), `Idempotency-Key` (**400**), `spec_version`, `items`, `reviewers`. Every one of them returns before the store is touched, so a rejected create leaves no half-built task behind — and the `(tenant, key)` lookup happens before a new task id is minted.',
    'The dedupe set is seeded from the store for that `spec_version` and extended while you walk the items, so a hash that repeats inside the batch is dropped too; every drop is counted in `deduped`. When nothing is left, answer **409 `{"error": "no_new_items"}`** rather than a **201** with `accepted: 0`: an empty task is a task no reviewer can ever finish, and it hides a double-submitted batch.',
    'Pinning is one field on the task record: store the `spec_version` the caller sent and answer with it. A task that resolves "the current spec" at assignment time silently re-labels work that was already paid for under the taxonomy in force when it was created — the labels are comparable only within one spec version.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary, where a wrong acceptance is expensive rather than slow. The draft reads fine because the demo posts five items under one spec, asks for three reviewers and never retries. Four defects are being checked: the spec pin (a labeling task is a promise about *which* question is being asked, so the version is stored with the task, never resolved later — this is the field that makes the agreement math in step 5 meaningful), the caps (a cheap rejection before an expensive cohort exists), content dedupe (the item's bytes are the identity of the label, so hashing them under the spec is what stops paying twice for one answer), and idempotency keyed by tenant so the retry every client does cannot create a competing cohort over the same items. Real labeling services add a request fingerprint so two different batches under one key are rejected instead of silently replaying the first, per-tenant quotas, and a queue whose depth is reported back — the next step of this course hands these items to reviewers with a lease instead of a flag.`,
};
