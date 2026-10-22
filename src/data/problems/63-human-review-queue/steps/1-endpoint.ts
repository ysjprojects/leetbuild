import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/review/items: only real, unique escalations',
  concept: 'http',
  file: 'api',
  focus: ['client', 'queue', 'items'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns an item. It compiles, it serves the demo, and it hides three production flaws.
Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/review/items\` with body
\`{"source_type": "…", "source_id": "…", "payload_ref": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`source_type\` is one of \`guardrail_block\`, \`user_report\`, \`model_output\` (**400** otherwise).
- \`source_id\` is a non-empty string of at most **128** characters (**400** otherwise).
- \`payload_ref\` is a non-empty string (**400** otherwise): a pointer into the retention-managed
  payload store. The request body must **not** carry the payload text, and the queue row must store
  only the reference — model output and user text never land in the queue's retained records.
- \`priority\` is derived **server-side** from the platform's rules: \`guardrail_block\` → \`p1\`,
  \`user_report\` → \`p2\`, \`model_output\` → \`p3\`. A caller-supplied priority field is ignored.
- Enqueuing dedupes by \`(source_type, source_id)\`: a second escalation for the same source returns
  the existing item (**200**, \`deduped: true\`) instead of creating a duplicate; a new source is
  **201** with \`deduped: false\`.

**Failure mode the checks target.** Three defects are being tested. The draft trusts a caller-provided
\`priority\`, so a noisy integration can mark every style complaint \`p1\` and starve the guardrail
queue. It accepts duplicate escalations for one source, so five workers noticing the same blocked
completion create five review tasks. And it inlines the full payload into the queue record, so model
output and user text are copied into a store with the queue's retention instead of a pointer into the
payload store that owns its own retention.`,
  sequence: {
    participants: ['Source / client', 'Review Queue', 'Item store'],
    messages: [
      {from: 'Source / client', to: 'Review Queue', label: 'POST /v1/review/items · X-Tenant-Id', kind: 'sync'},
      {from: 'Review Queue', to: 'Review Queue', label: 'validate source · derive priority', kind: 'sync'},
      {from: 'Review Queue', to: 'Item store', label: 'get(dedupe_key)', kind: 'sync'},
      {from: 'Item store', to: 'Review Queue', label: 'existing item / none', kind: 'reply'},
      {from: 'Review Queue', to: 'Item store', label: 'put(dedupe_key, item · payload_ref)', kind: 'sync'},
      {from: 'Review Queue', to: 'Source / client', label: '201 {item_id, priority, deduped}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/review/items',
      detail: 'Register the enqueue route on `POST /v1/review/items`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/review\/items["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/review\/items['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/review\/items"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"review"\s*\/\s*"items"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/review\/items"/]},
      },
    },
    {
      id: 'priority',
      title: 'Derives priority server-side from the platform rules',
      detail:
        'Priority comes from a server-side table keyed by `source_type` (`guardrail_block` → p1, `user_report` → p2, `model_output` → p3), never from the request. The draft reads `priority` from the caller.',
      match: {
        python: {all: [/SOURCE_PRIORITY/, /def derive_priority\(/]},
        typescript: {all: [/SOURCE_PRIORITY/, /function derivePriority\(/]},
        go: {all: [/sourcePriority/, /func derivePriority\(/]},
        scala: {all: [/SourcePriority/, /def derivePriority\(/]},
        cpp: {all: [/kSourcePriority/, /derivePriority\(/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Dedupes by (source_type, source_id)',
      detail:
        'A duplicate source returns the existing item instead of a second one: the handler builds a stable `dedupe_key`, looks it up before inserting, and stores under it. The draft inserts unconditionally.',
      match: {
        python: {all: [/def dedupe_key\(/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/function dedupeKey\(/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/func dedupeKey\(/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/def dedupeKey\(/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/dedupeKey\(/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'payload-ref',
      title: 'Stores a payload reference, not the payload',
      detail:
        'The queue row carries `payload_ref`; the payload text never appears in the request model or the stored item. The draft inlines the full payload into the record.',
      match: {
        python: {all: [/payload_ref/], none: [/payload_text/]},
        typescript: {all: [/payload_ref/], none: [/payload_text/]},
        go: {all: [/PayloadRef/], none: [/PayloadText/]},
        scala: {all: [/payloadRef/], none: [/payloadText/]},
        cpp: {all: [/payload_ref/], none: [/payload_text/]},
      },
    },
    {
      id: 'auth',
      title: 'Requires the tenant',
      detail: 'A missing `X-Tenant-Id` is **401** before anything is enqueued. The draft trusts the header.',
      match: {
        python: {all: [/status_code\s*=\s*401/]},
        typescript: {all: [/code\(\s*401\s*\)/]},
        go: {all: [/StatusUnauthorized/]},
        scala: {all: [/StatusCodes\.Unauthorized/]},
        cpp: {all: [/\b401\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("reviewd")


class ReviewItem(BaseModel):
    source_type: str
    source_id: str
    priority: str = "p3"
    payload_text: str = ""


class ItemStore:
    def get(self, key: str):
        """The item stored under key, if any."""
        raise NotImplementedError

    def put(self, key: str, item: dict) -> None:
        """Store the item under key."""
        raise NotImplementedError


store = ItemStore()


@app.post("/v1/review/items")
def enqueue(body: ReviewItem, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft trusts the caller's priority, accepts duplicate escalations for one source
    # and inlines the full payload into the queue record. Review all three.
    item = {
        "item_id": body.source_id,
        "tenant": tenant,
        "source_type": body.source_type,
        "source_id": body.source_id,
        "priority": body.priority,
        "payload_text": body.payload_text,
    }
    store.put(body.source_id, item)
    logger.info("enqueued source=%s priority=%s", body.source_id, body.priority)
    return JSONResponse(item, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("reviewd")

SOURCE_PRIORITY = {"guardrail_block": "p1", "user_report": "p2", "model_output": "p3"}
MAX_SOURCE_ID = 128


class ReviewItem(BaseModel):
    source_type: str
    source_id: str
    payload_ref: str


class ItemStore:
    def get(self, key: str):
        """The item stored under key, if any."""
        raise NotImplementedError

    def put(self, key: str, item: dict) -> None:
        """Store the item under key."""
        raise NotImplementedError


store = ItemStore()


def dedupe_key(source_type: str, source_id: str) -> str:
    return f"{source_type}:{source_id}"


def derive_priority(source_type: str) -> str:
    return SOURCE_PRIORITY[source_type]


@app.post("/v1/review/items")
def enqueue(
    body: ReviewItem,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if body.source_type not in SOURCE_PRIORITY:
        raise HTTPException(status_code=400, detail="unknown source_type")
    if body.source_id == "" or len(body.source_id) > MAX_SOURCE_ID:
        raise HTTPException(status_code=400, detail="source_id must be 1..128 characters")
    if body.payload_ref == "":
        raise HTTPException(status_code=400, detail="payload_ref is required")

    key = dedupe_key(body.source_type, body.source_id)
    existing = store.get(key)
    if existing is not None:
        logger.info("deduped source=%s priority=%s", body.source_id, existing["priority"])
        return JSONResponse({**existing, "deduped": True}, status_code=200)

    item = {
        "item_id": str(uuid.uuid4()),
        "tenant": tenant,
        "source_type": body.source_type,
        "source_id": body.source_id,
        "priority": derive_priority(body.source_type),
        "payload_ref": body.payload_ref,
    }
    store.put(key, item)
    logger.info("enqueued source=%s priority=%s", body.source_id, item["priority"])
    return JSONResponse({**item, "deduped": False}, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/review/items: a model-generated draft that trusts the caller's priority. */
import Fastify from 'fastify';

export const app = Fastify();

interface ReviewBody {
  source_type: string;
  source_id: string;
  priority?: string;
  payload_text?: string;
}

const enqueued: unknown[] = [];

app.post('/v1/review/items', async (request, reply) => {
  // TODO: this draft trusts the caller's priority, accepts duplicate escalations for one source
  // and inlines the full payload into the queue record. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as ReviewBody;
  const item = {
    item_id: body.source_id,
    tenant,
    source_type: body.source_type,
    source_id: body.source_id,
    priority: body.priority ?? 'p3',
    payload_text: body.payload_text ?? '',
  };
  enqueued.push(item);
  request.log.info({source_id: body.source_id, priority: item.priority}, 'enqueued');
  return reply.code(201).send(item);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/review/items: deduped escalations with server-side priority and a payload reference. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const SOURCE_PRIORITY: Record<string, string> = {
  guardrail_block: 'p1',
  user_report: 'p2',
  model_output: 'p3',
};
const MAX_SOURCE_ID = 128;

interface ReviewBody {
  source_type: string;
  source_id: string;
  payload_ref: string;
}

interface Item {
  item_id: string;
  tenant: string;
  source_type: string;
  source_id: string;
  priority: string;
  payload_ref: string;
}

const rows = new Map<string, Item>();
const store = {
  async get(key: string): Promise<Item | undefined> {
    return rows.get(key);
  },
  async put(key: string, item: Item): Promise<void> {
    rows.set(key, item);
  },
};

function dedupeKey(sourceType: string, sourceId: string): string {
  return \`\${sourceType}:\${sourceId}\`;
}

function derivePriority(sourceType: string): string {
  return SOURCE_PRIORITY[sourceType];
}

app.post('/v1/review/items', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = request.body as Partial<ReviewBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.source_type !== 'string')
    return reply.code(400).send({error: 'source_type is required'});
  if (SOURCE_PRIORITY[body.source_type] === undefined)
    return reply.code(400).send({error: 'unknown source_type'});
  if (typeof body.source_id !== 'string' || body.source_id === '' || body.source_id.length > MAX_SOURCE_ID)
    return reply.code(400).send({error: 'source_id must be 1..128 characters'});
  if (typeof body.payload_ref !== 'string' || body.payload_ref === '')
    return reply.code(400).send({error: 'payload_ref is required'});

  const key = dedupeKey(body.source_type, body.source_id);
  const existing = await store.get(key);
  if (existing !== undefined) {
    request.log.info({source_id: body.source_id, priority: existing.priority}, 'deduped');
    return reply.code(200).send({...existing, deduped: true});
  }

  const item: Item = {
    item_id: randomUUID(),
    tenant,
    source_type: body.source_type,
    source_id: body.source_id,
    priority: derivePriority(body.source_type),
    payload_ref: body.payload_ref,
  };
  await store.put(key, item);
  request.log.info({source_id: body.source_id, priority: item.priority}, 'enqueued');
  return reply.code(201).send({...item, deduped: false});
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
)

type ReviewBody struct {
	SourceType  string \`json:"source_type"\`
	SourceID    string \`json:"source_id"\`
	Priority    string \`json:"priority"\`
	PayloadText string \`json:"payload_text"\`
}

var enqueued []map[string]any

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func enqueue(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body ReviewBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts the caller's priority, accepts duplicate escalations for one source
	// and inlines the full payload into the queue record. Review all three.
	item := map[string]any{
		"item_id":      body.SourceID,
		"tenant":       tenant,
		"source_type":  body.SourceType,
		"source_id":    body.SourceID,
		"priority":     body.Priority,
		"payload_text": body.PayloadText,
	}
	enqueued = append(enqueued, item)
	log.Printf("enqueued source=%s priority=%s", body.SourceID, body.Priority)
	writeJSON(rw, http.StatusCreated, item)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/review/items", enqueue)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/google/uuid"
)

var sourcePriority = map[string]string{
	"guardrail_block": "p1",
	"user_report":     "p2",
	"model_output":    "p3",
}

const maxSourceID = 128

type ReviewBody struct {
	SourceType string \`json:"source_type"\`
	SourceID   string \`json:"source_id"\`
	PayloadRef string \`json:"payload_ref"\`
}

type Item struct {
	ItemID     string \`json:"item_id"\`
	Tenant     string \`json:"tenant"\`
	SourceType string \`json:"source_type"\`
	SourceID   string \`json:"source_id"\`
	Priority   string \`json:"priority"\`
	PayloadRef string \`json:"payload_ref"\`
}

type ItemStore struct {
	rows map[string]Item
}

func (s *ItemStore) Get(ctx context.Context, key string) (Item, bool, error) {
	item, ok := s.rows[key]
	return item, ok, nil
}

func (s *ItemStore) Put(ctx context.Context, key string, item Item) error {
	s.rows[key] = item
	return nil
}

var store = &ItemStore{rows: map[string]Item{}}

func dedupeKey(sourceType, sourceID string) string {
	return fmt.Sprintf("%s:%s", sourceType, sourceID)
}

func derivePriority(sourceType string) string {
	return sourcePriority[sourceType]
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func enqueue(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body ReviewBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if _, ok := sourcePriority[body.SourceType]; !ok {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown source_type"})
		return
	}
	if body.SourceID == "" || len(body.SourceID) > maxSourceID {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "source_id must be 1..128 characters"})
		return
	}
	if body.PayloadRef == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "payload_ref is required"})
		return
	}

	key := dedupeKey(body.SourceType, body.SourceID)
	if existing, ok, _ := store.Get(r.Context(), key); ok {
		log.Printf("deduped source=%s priority=%s", body.SourceID, existing.Priority)
		existing.Priority = existing.Priority
		writeJSON(rw, http.StatusOK, map[string]any{"item_id": existing.ItemID, "priority": existing.Priority, "deduped": true})
		return
	}

	item := Item{
		ItemID:     uuid.NewString(),
		Tenant:     tenant,
		SourceType: body.SourceType,
		SourceID:   body.SourceID,
		Priority:   derivePriority(body.SourceType),
		PayloadRef: body.PayloadRef,
	}
	_ = store.Put(r.Context(), key, item)
	log.Printf("enqueued source=%s priority=%s", body.SourceID, item.Priority)
	writeJSON(rw, http.StatusCreated, map[string]any{"item_id": item.ItemID, "priority": item.Priority, "deduped": false})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/review/items", enqueue)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

import scala.collection.mutable

case class ReviewBody(sourceType: String, sourceId: String, priority: String, payloadText: String)

object Api {
  val items: mutable.Map[String, ReviewBody] = mutable.Map.empty

  def route: Route =
    path("v1" / "review" / "items") {
      post {
        // TODO: this draft trusts the caller's priority, accepts duplicate escalations for one
        // source and inlines the full payload into the queue record. Review all three.
        headerValueByName("X-Tenant-Id") { _ =>
          entity(as[ReviewBody]) { body =>
            items.put(body.sourceId, body)
            complete(StatusCodes.Created, body)
          }
        }
      }
    }
}
`,
      solution: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

import scala.collection.mutable

case class ReviewBody(sourceType: String, sourceId: String, payloadRef: String)

case class Item(itemId: String, tenant: String, sourceType: String, sourceId: String, priority: String, payloadRef: String)

object SourcePriority {
  val table: Map[String, String] =
    Map("guardrail_block" -> "p1", "user_report" -> "p2", "model_output" -> "p3")
}

object store {
  private val rows: mutable.Map[String, Item] = mutable.Map.empty

  def get(key: String): Option[Item] = rows.get(key)

  def put(key: String, item: Item): Unit = rows.update(key, item)
}

object Api {
  val MaxSourceId = 128

  def dedupeKey(sourceType: String, sourceId: String): String = s"$sourceType:$sourceId"

  def derivePriority(sourceType: String): String = SourcePriority.table(sourceType)

  def route: Route =
    path("v1" / "review" / "items") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[ReviewBody]) { body =>
            if (tenantOpt.isEmpty || tenantOpt.contains("")) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (!SourcePriority.table.contains(body.sourceType)) {
              complete(StatusCodes.BadRequest, "unknown source_type")
            } else if (body.sourceId.isEmpty || body.sourceId.length > MaxSourceId) {
              complete(StatusCodes.BadRequest, "source_id must be 1..128 characters")
            } else if (body.payloadRef.isEmpty) {
              complete(StatusCodes.BadRequest, "payload_ref is required")
            } else {
              val key = dedupeKey(body.sourceType, body.sourceId)
              store.get(key) match {
                case Some(existing) =>
                  complete(StatusCodes.OK, s"""{"item_id":"\${existing.itemId}","deduped":true}""")
                case None =>
                  val item = Item("item-1", tenant, body.sourceType, body.sourceId, derivePriority(body.sourceType), body.payloadRef)
                  store.put(key, item)
                  complete(StatusCodes.Created, s"""{"item_id":"\${item.itemId}","deduped":false}""")
              }
            }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <string>
#include <vector>
#include <map>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

struct ReviewBody {
  std::string source_type;
  std::string source_id;
  std::string priority;
  std::string payload_text;
};

std::vector<json> enqueued;

int main() {
  httplib::Server svr;
  svr.Post("/v1/review/items", [](const httplib::Request& req, httplib::Response& res) {
    auto body = json::parse(req.body);
    // TODO: this draft trusts the caller's priority, accepts duplicate escalations for one
    // source and inlines the full payload into the queue record. Review all three.
    json item = {
        {"item_id", body["source_id"]},
        {"tenant", req.get_header_value("X-Tenant-Id")},
        {"source_type", body["source_type"]},
        {"source_id", body["source_id"]},
        {"priority", body["priority"]},
        {"payload_text", body["payload_text"]},
    };
    enqueued.push_back(item);
    res.status = 201;
    res.set_content(item.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <string>
#include <map>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

const std::map<std::string, std::string> kSourcePriority = {
    {"guardrail_block", "p1"}, {"user_report", "p2"}, {"model_output", "p3"}};
const size_t kMaxSourceId = 128;

struct ReviewBody {
  std::string source_type;
  std::string source_id;
  std::string payload_ref;
};

struct Item {
  std::string item_id;
  std::string tenant;
  std::string source_type;
  std::string source_id;
  std::string priority;
  std::string payload_ref;
};

class ItemStore {
 public:
  bool get(const std::string& key, Item& out) const {
    auto it = rows_.find(key);
    if (it == rows_.end()) return false;
    out = it->second;
    return true;
  }

  void put(const std::string& key, const Item& item) { rows_[key] = item; }

 private:
  std::map<std::string, Item> rows_;
};

ItemStore store;

std::string dedupeKey(const std::string& source_type, const std::string& source_id) {
  return source_type + ":" + source_id;
}

std::string derivePriority(const std::string& source_type) { return kSourcePriority.at(source_type); }

int main() {
  httplib::Server svr;
  svr.Post("/v1/review/items", [](const httplib::Request& req, httplib::Response& res) {
    auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    auto body = json::parse(req.body);
    auto source_type = body["source_type"].get<std::string>();
    auto source_id = body["source_id"].get<std::string>();
    auto payload_ref = body["payload_ref"].get<std::string>();
    if (kSourcePriority.find(source_type) == kSourcePriority.end()) {
      res.status = 400;
      res.set_content(R"({"error":"unknown source_type"})", "application/json");
      return;
    }
    if (source_id.empty() || source_id.size() > kMaxSourceId) {
      res.status = 400;
      res.set_content(R"({"error":"source_id must be 1..128 characters"})", "application/json");
      return;
    }
    if (payload_ref.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"payload_ref is required"})", "application/json");
      return;
    }
    auto key = dedupeKey(source_type, source_id);
    Item existing;
    if (store.get(key, existing)) {
      json out = {{"item_id", existing.item_id}, {"priority", existing.priority}, {"deduped", true}};
      res.status = 200;
      res.set_content(out.dump(), "application/json");
      return;
    }
    Item item{"item-1", tenant, source_type, source_id, derivePriority(source_type), payload_ref};
    store.put(key, item);
    json out = {{"item_id", item.item_id}, {"priority", item.priority}, {"deduped", false}};
    res.status = 201;
    res.set_content(out.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Priority is a server-side decision. Map `source_type` to a priority in a table you own, and never read a `priority` field from the request body.',
    'Dedupe needs a stable key. Build one from `(source_type, source_id)`, look it up before you insert, and return the existing item instead of creating a second one.',
    'The queue row should carry `payload_ref` — a pointer into the retention-managed payload store — not the payload text itself. Reject requests that carry content.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends well-formed requests from one integration and never retries. Three separate defects are being checked: server-side priority derivation (the caller names a source, the platform names the priority — otherwise a noisy integration can starve the guardrail queue), dedupe by source so five workers noticing the same blocked completion create one task, and a payload reference instead of content so model output and user text never land in the queue's retained records. The subtle one candidates miss is the priority: it looks like a harmless convenience field, but it is the queue's fairness control. Real queues add per-tenant source allow-lists, a hashed payload fingerprint for dedupe across source types, and a signed reference so only the queue can fetch the payload.`,
};
