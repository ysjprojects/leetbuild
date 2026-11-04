import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/review/items: only real, unique escalations',
  concept: 'http',
  file: 'api',
  focus: ['client', 'queue', 'items'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/review/items\` on the review store
(\`review.store\`, provided): it reads \`X-Tenant-Id\`, takes \`source_type\`, \`source_id\`,
\`priority\` and \`payload_text\` from the JSON body, stores a new item with \`store.create_item\`
and answers **201** \`{item_id, priority, deduped: false}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A request with no tenant still enqueues; a noisy integration
sends \`priority: p1\` on every style complaint; five workers escalating one blocked completion
enqueue five items; and user text lands in the queue's retained records.

- A missing or empty \`X-Tenant-Id\` is **401** and stores nothing.
- \`priority\` comes from \`SOURCE_PRIORITY\`: \`guardrail_block\` → \`p1\`, \`user_report\` → \`p2\`,
  \`model_output\` → \`p3\`. A caller's \`priority\` is ignored; another \`source_type\` is **400**, as is
  a \`source_id\` that is empty or longer than \`MAX_SOURCE_ID\` (128).
- Before creating, claim the source with \`store.claim_source(tenant, source_type, source_id,
  item_id)\`: when it names an existing item, answer **200** with that item and \`deduped: true\`.
- The body carries \`payload_ref\`, a pointer into the retention-managed payload store (**400** when
  missing or empty); the item stores that reference and no payload text.`,
  sequence: {
    participants: ['Source', 'Review Queue', 'Review store'],
    messages: [
      {from: 'Source', to: 'Review Queue', label: 'POST /v1/review/items · X-Tenant-Id', kind: 'sync'},
      {from: 'Review Queue', to: 'Review Queue', label: 'SOURCE_PRIORITY[source_type] · validate', kind: 'sync'},
      {from: 'Review Queue', to: 'Review store', label: 'claim_source(tenant, type, id, item_id)', kind: 'sync'},
      {from: 'Review store', to: 'Review Queue', label: 'new claim / existing item', kind: 'reply'},
      {from: 'Review Queue', to: 'Review store', label: 'create_item(… payload_ref)', kind: 'sync'},
      {from: 'Review Queue', to: 'Source', label: '201 {item_id, priority} · 200 deduped', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/review/items',
      detail:
        'Register the enqueue route on `POST /v1/review/items`; a valid escalation is stored as a queued item and answered 201.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/review\/items["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/review\/items['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/review\/items"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"review"\s*\/\s*"items"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/review\/items"/]},
      },
    },
    {
      id: 'tenant',
      title: 'A request without a tenant is 401',
      detail:
        'A missing or empty `X-Tenant-Id` answers **401** before anything is stored; the starter enqueues it under an empty tenant.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/]},
        typescript: {all: [/x-tenant-id/i, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Tenant-Id/i, /Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'source',
      title: 'Priority comes from the source type',
      detail:
        "The priority is `SOURCE_PRIORITY[source_type]`, never the body's `priority`; an unknown `source_type` or a `source_id` that is empty or over `MAX_SOURCE_ID` is **400**.",
      match: {
        python: {
          all: [/SOURCE_PRIORITY\s*=/, /SOURCE_PRIORITY\[|SOURCE_PRIORITY\.get\(/, /MAX_SOURCE_ID/, /\b400\b/],
          none: [/body\.get\(\s*["']priority/],
        },
        typescript: {
          all: [
            /SOURCE_PRIORITY\s*[:=]/,
            /SOURCE_PRIORITY\.get\(|SOURCE_PRIORITY\[/,
            /MAX_SOURCE_ID/,
            /code\(\s*400\s*\)/,
          ],
          none: [/body\.priority/],
        },
        go: {
          all: [/sourcePriority\s*=/, /sourcePriority\[/, /maxSourceID/, /StatusBadRequest|\b400\b/],
          none: [/json:"priority"/],
        },
        scala: {
          all: [/SourcePriority\s*[:=]/, /SourcePriority\.get\(|SourcePriority\(/, /MaxSourceId/, /BadRequest/],
          none: [/body,\s*"priority"/],
        },
        cpp: {
          all: [/kSourcePriority\s*=/, /kSourcePriority\.find\(|kSourcePriority\.at\(/, /kMaxSourceId/, /\b400\b/],
          none: [/body\.value\(\s*"priority"/],
        },
      },
    },
    {
      id: 'dedupe',
      title: 'One item per (tenant, source type, source id)',
      detail:
        'The source is claimed (`claim_source`/`claimSource`) before `create_item`; a claim that names an existing item answers 200 with `deduped: true` and creates nothing.',
      match: {
        python: {
          all: [/store\.claim_source\(/, /["']deduped["']\s*:\s*True/],
          order: [/store\.claim_source\(/, /store\.create_item\(/],
        },
        typescript: {all: [/claimSource\(/, /deduped:\s*true/], order: [/await claimSource\(/, /await createItem\(/]},
        go: {
          all: [/store\.ClaimSource\(/, /"deduped":\s*true/],
          order: [/store\.ClaimSource\(/, /store\.CreateItem\(/],
        },
        scala: {
          all: [/Store\.claimSource\(/, /JsBoolean\(true\)/],
          order: [/Store\.claimSource\(/, /Store\.createItem\(/],
        },
        cpp: {
          all: [/store::claimSource\(/, /"deduped",\s*true/],
          order: [/store::claimSource\(/, /store::createItem\(/],
        },
      },
    },
    {
      id: 'payload-ref',
      title: 'Stores a payload reference, not the payload',
      detail:
        'The item carries `payload_ref` (400 when it is missing) and no payload text: the payload store owns retention, and the queue must not be a second copy of user content.',
      match: {
        python: {all: [/payload_ref/], none: [/payload_text/]},
        typescript: {all: [/payload_ref/], none: [/payload_text/]},
        go: {all: [/PayloadRef/], none: [/PayloadText|payload_text/]},
        scala: {all: [/payload_ref/], none: [/payload_text/]},
        cpp: {all: [/payload_ref/], none: [/payload_text/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from review import store  # new_item_id, claim_source, create_item, get_item

app = FastAPI()


@app.post("/v1/review/items")
async def enqueue(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    body = await request.json()
    item_id = store.new_item_id()
    item = store.create_item(
        {
            "item_id": item_id,
            "tenant": tenant,
            "source_type": body.get("source_type", ""),
            "source_id": body.get("source_id", ""),
            "priority": body.get("priority", "p3"),
            "payload_text": body.get("payload_text", ""),
        }
    )
    return JSONResponse({"item_id": item_id, "priority": item["priority"], "deduped": False}, status_code=201)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from review import store  # new_item_id, claim_source, create_item, get_item

app = FastAPI()

# The platform's fairness rule: who escalated decides how urgent it is, not the caller.
SOURCE_PRIORITY = {"guardrail_block": "p1", "user_report": "p2", "model_output": "p3"}
MAX_SOURCE_ID = 128


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.post("/v1/review/items")
async def enqueue(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return _error(401, "X-Tenant-Id is required")
    body = await request.json()
    source_type = body.get("source_type")
    source_id = body.get("source_id")
    payload_ref = body.get("payload_ref")
    if source_type not in SOURCE_PRIORITY:
        return _error(400, f"unknown source_type {source_type!r}")
    if not isinstance(source_id, str) or not 1 <= len(source_id) <= MAX_SOURCE_ID:
        return _error(400, f"source_id must be 1 to {MAX_SOURCE_ID} characters")
    if not isinstance(payload_ref, str) or not payload_ref:
        return _error(400, "payload_ref is required")
    priority = SOURCE_PRIORITY[source_type]
    item_id = store.new_item_id()
    existing = store.claim_source(tenant, source_type, source_id, item_id)
    if existing is not None:
        # The same source escalated again: answer the item it already is.
        return JSONResponse({"item_id": existing, "priority": store.get_item(existing)["priority"], "deduped": True})
    store.create_item(
        {
            "item_id": item_id,
            "tenant": tenant,
            "source_type": source_type,
            "source_id": source_id,
            "priority": priority,
            "payload_ref": payload_ref,
        }
    )
    return JSONResponse({"item_id": item_id, "priority": priority, "deduped": False}, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {claimSource, createItem, getItem, newItemId} from 'review/store';

export const app = Fastify();

app.post('/v1/review/items', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const body = (request.body ?? {}) as Record<string, string | undefined>;
  const itemId = await newItemId();
  const item = await createItem({
    item_id: itemId,
    tenant,
    source_type: body.source_type ?? '',
    source_id: body.source_id ?? '',
    priority: body.priority ?? 'p3',
    payload_text: body.payload_text ?? '',
  });
  return reply.code(201).send({item_id: itemId, priority: item.priority, deduped: false});
});
`,
      solution: `import Fastify from 'fastify';

import {claimSource, createItem, getItem, newItemId} from 'review/store';

export const app = Fastify();

// The platform's fairness rule: who escalated decides how urgent it is, not the caller.
export const SOURCE_PRIORITY: Record<string, string> = {guardrail_block: 'p1', user_report: 'p2', model_output: 'p3'};
export const MAX_SOURCE_ID = 128;

app.post('/v1/review/items', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as Record<string, unknown>;
  const {source_type: sourceType, source_id: sourceId, payload_ref: payloadRef} = body;
  const priority = typeof sourceType === 'string' && Object.hasOwn(SOURCE_PRIORITY, sourceType) ? SOURCE_PRIORITY[sourceType] : undefined;
  if (typeof sourceType !== 'string' || priority === undefined) return reply.code(400).send({error: \`unknown source_type \${String(sourceType)}\`});
  if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > MAX_SOURCE_ID) {
    return reply.code(400).send({error: \`source_id must be 1 to \${MAX_SOURCE_ID} characters\`});
  }
  if (typeof payloadRef !== 'string' || payloadRef === '') return reply.code(400).send({error: 'payload_ref is required'});
  const itemId = await newItemId();
  const existing = await claimSource(tenant, sourceType, sourceId, itemId);
  if (existing !== null) {
    // The same source escalated again: answer the item it already is.
    const item = await getItem(existing);
    return reply.code(200).send({item_id: existing, priority: item?.priority ?? priority, deduped: true});
  }
  await createItem({item_id: itemId, tenant, source_type: sourceType, source_id: sourceId, priority, payload_ref: payloadRef});
  return reply.code(201).send({item_id: itemId, priority, deduped: false});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"review/store" // store.NewItemID, ClaimSource, CreateItem, GetItem
)

type escalation struct {
	SourceType  string \`json:"source_type"\`
	SourceID    string \`json:"source_id"\`
	Priority    string \`json:"priority"\`
	PayloadText string \`json:"payload_text"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func enqueue(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	var body escalation
	json.NewDecoder(r.Body).Decode(&body)
	if body.Priority == "" {
		body.Priority = "p3"
	}
	itemID := store.NewItemID(r.Context())
	item := store.CreateItem(r.Context(), map[string]string{
		"item_id":      itemID,
		"tenant":       r.Header.Get("X-Tenant-Id"),
		"source_type":  body.SourceType,
		"source_id":    body.SourceID,
		"priority":     body.Priority,
		"payload_text": body.PayloadText,
	})
	writeJSON(rw, http.StatusCreated, map[string]any{"item_id": itemID, "priority": item["priority"], "deduped": false})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/review/items", enqueue)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"review/store" // store.NewItemID, ClaimSource, CreateItem, GetItem
)

// sourcePriority is the platform's fairness rule: who escalated decides how urgent it is, not the caller.
var sourcePriority = map[string]string{"guardrail_block": "p1", "user_report": "p2", "model_output": "p3"}

const maxSourceID = 128

type escalation struct {
	SourceType string \`json:"source_type"\`
	SourceID   string \`json:"source_id"\`
	PayloadRef string \`json:"payload_ref"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func enqueue(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body escalation
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "the body must be a JSON escalation"})
		return
	}
	priority, known := sourcePriority[body.SourceType]
	if !known {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("unknown source_type %q", body.SourceType)})
		return
	}
	if body.SourceID == "" || len(body.SourceID) > maxSourceID {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("source_id must be 1 to %d characters", maxSourceID)})
		return
	}
	if body.PayloadRef == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "payload_ref is required"})
		return
	}
	itemID := store.NewItemID(r.Context())
	if existing := store.ClaimSource(r.Context(), tenant, body.SourceType, body.SourceID, itemID); existing != "" {
		// The same source escalated again: answer the item it already is.
		writeJSON(rw, http.StatusOK, map[string]any{"item_id": existing, "priority": store.GetItem(r.Context(), existing)["priority"], "deduped": true})
		return
	}
	store.CreateItem(r.Context(), map[string]string{
		"item_id":     itemID,
		"tenant":      tenant,
		"source_type": body.SourceType,
		"source_id":   body.SourceID,
		"priority":    priority,
		"payload_ref": body.PayloadRef,
	})
	writeJSON(rw, http.StatusCreated, map[string]any{"item_id": itemID, "priority": priority, "deduped": false})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/review/items", enqueue)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import review.Store // Store.newItemId, claimSource, createItem, getItem

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: Map[String, JsValue], name: String, default: String): String =
    body.get(name).collect { case JsString(s) => s }.getOrElse(default)

  val route: Route =
    path("v1" / "review" / "items") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { raw =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject.fields
            val itemId = Store.newItemId()
            val item = Store.createItem(Map(
              "item_id" -> itemId,
              "tenant" -> tenant.getOrElse(""),
              "source_type" -> text(body, "source_type", ""),
              "source_id" -> text(body, "source_id", ""),
              "priority" -> text(body, "priority", "p3"),
              "payload_text" -> text(body, "payload_text", "")))
            complete(json(StatusCodes.Created, JsObject("item_id" -> JsString(itemId), "priority" -> JsString(item("priority")), "deduped" -> JsBoolean(false))))
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

import review.Store // Store.newItemId, claimSource, createItem, getItem

object Api {
  /** The platform's fairness rule: who escalated decides how urgent it is, not the caller. */
  val SourcePriority: Map[String, String] = Map("guardrail_block" -> "p1", "user_report" -> "p2", "model_output" -> "p3")
  val MaxSourceId = 128

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(body: Map[String, JsValue], name: String, default: String): String =
    body.get(name).collect { case JsString(s) => s }.getOrElse(default)

  val route: Route =
    path("v1" / "review" / "items") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          case Some(tenant) =>
            entity(as[String]) { raw =>
              val body = raw.parseJson.asJsObject.fields
              val sourceType = text(body, "source_type", "")
              val sourceId = text(body, "source_id", "")
              val payloadRef = text(body, "payload_ref", "")
              SourcePriority.get(sourceType) match {
                case None => complete(error(StatusCodes.BadRequest, s"unknown source_type $sourceType"))
                case Some(_) if sourceId.isEmpty || sourceId.length > MaxSourceId =>
                  complete(error(StatusCodes.BadRequest, s"source_id must be 1 to $MaxSourceId characters"))
                case Some(_) if payloadRef.isEmpty => complete(error(StatusCodes.BadRequest, "payload_ref is required"))
                case Some(priority) =>
                  val itemId = Store.newItemId()
                  Store.claimSource(tenant, sourceType, sourceId, itemId) match {
                    case Some(existing) =>
                      // The same source escalated again: answer the item it already is.
                      val known = Store.getItem(existing).flatMap(_.get("priority")).getOrElse(priority)
                      complete(json(StatusCodes.OK, JsObject("item_id" -> JsString(existing), "priority" -> JsString(known), "deduped" -> JsBoolean(true))))
                    case None =>
                      Store.createItem(Map(
                        "item_id" -> itemId,
                        "tenant" -> tenant,
                        "source_type" -> sourceType,
                        "source_id" -> sourceId,
                        "priority" -> priority,
                        "payload_ref" -> payloadRef))
                      complete(json(StatusCodes.Created, JsObject("item_id" -> JsString(itemId), "priority" -> JsString(priority), "deduped" -> JsBoolean(false))))
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "review/store.h"  // store::newItemId, claimSource, createItem, getItem

using json = nlohmann::json;

void enqueue(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  const std::string item_id = store::newItemId();
  const store::Item item = store::createItem({
      {"item_id", item_id},
      {"tenant", req.get_header_value("X-Tenant-Id")},
      {"source_type", body.value("source_type", "")},
      {"source_id", body.value("source_id", "")},
      {"priority", body.value("priority", "p3")},
      {"payload_text", body.value("payload_text", "")},
  });
  res.status = 201;
  res.set_content(json{{"item_id", item_id}, {"priority", item.at("priority")}, {"deduped", false}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/review/items", enqueue);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "review/store.h"  // store::newItemId, claimSource, createItem, getItem

using json = nlohmann::json;

// The platform's fairness rule: who escalated decides how urgent it is, not the caller.
const std::map<std::string, std::string> kSourcePriority = {{"guardrail_block", "p1"}, {"user_report", "p2"}, {"model_output", "p3"}};
constexpr size_t kMaxSourceId = 128;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string text(const json& body, const char* name) {
  return body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : "";
}

void enqueue(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, json{{"error", "the body must be a JSON escalation"}});
  const std::string source_type = text(body, "source_type");
  const std::string source_id = text(body, "source_id");
  const std::string payload_ref = text(body, "payload_ref");
  const auto priority = kSourcePriority.find(source_type);
  if (priority == kSourcePriority.end()) return reply(res, 400, json{{"error", "unknown source_type " + source_type}});
  if (source_id.empty() || source_id.size() > kMaxSourceId) return reply(res, 400, json{{"error", "source_id must be 1 to 128 characters"}});
  if (payload_ref.empty()) return reply(res, 400, json{{"error", "payload_ref is required"}});
  const std::string item_id = store::newItemId();
  if (const auto existing = store::claimSource(tenant, source_type, source_id, item_id)) {
    // The same source escalated again: answer the item it already is.
    const auto item = store::getItem(*existing);
    const std::string known = item && item->count("priority") ? item->at("priority") : priority->second;
    return reply(res, 200, json{{"item_id", *existing}, {"priority", known}, {"deduped", true}});
  }
  store::createItem({
      {"item_id", item_id},
      {"tenant", tenant},
      {"source_type", source_type},
      {"source_id", source_id},
      {"priority", priority->second},
      {"payload_ref", payload_ref},
  });
  reply(res, 201, json{{"item_id", item_id}, {"priority", priority->second}, {"deduped", false}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/review/items", enqueue);
}
`,
    },
  },
  harness: {
    python: `from review import store

GOOD = {"source_type": "guardrail_block", "source_id": "cmp-1", "payload_ref": "blob://t1/cmp-1"}
T1 = {"X-Tenant-Id": "t1"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _enqueue(c, body, headers=T1):
    return await c.post("/v1/review/items", json=body, headers=headers)


def _items(ctx):
    return sorted(ctx.redis.keys("review:item:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _enqueue(c, GOOD)
    assert r.status_code == 201, f"POST /v1/review/items answered {r.status_code}: {r.text}"
    body = r.json()
    item_id = body.get("item_id")
    assert item_id and body.get("deduped") is False, f"a new escalation must answer its item_id and deduped false, got {body}"
    item = store.get_item(item_id)
    assert item is not None and item["state"] == "queued" and item["tenant"] == "t1", f"the store holds {item} for {item_id}, expected a queued item of tenant t1"
    queue = ctx.redis.lrange(f"review:queue:t1:{item['priority']}", 0, -1)
    assert item_id in queue, f"{item_id} is not in its queue review:queue:t1:{item['priority']} ({queue})"


async def check_tenant(ctx):
    async with _api(ctx) as c:
        for headers in ({}, {"X-Tenant-Id": ""}):
            r = await _enqueue(c, GOOD, headers)
            assert r.status_code == 401, f"an escalation with X-Tenant-Id {headers.get('X-Tenant-Id', 'missing')!r} answered {r.status_code}, expected 401"
        assert _items(ctx) == [], f"an escalation without a tenant was stored: {_items(ctx)}. Answer 401 before anything is written"
        r = await _enqueue(c, GOOD)
    assert r.status_code == 201, f"with X-Tenant-Id t1 the escalation answered {r.status_code}: {r.text}"


async def check_source(ctx):
    async with _api(ctx) as c:
        r = await _enqueue(c, {**GOOD, "source_type": "user_report", "source_id": "rep-1", "priority": "p1"})
        assert r.status_code == 201, f"a user_report answered {r.status_code}: {r.text}"
        item = store.get_item(r.json()["item_id"])
        assert item["priority"] == "p2", f"a user_report that asked for p1 was queued at {item['priority']}: the priority comes from SOURCE_PRIORITY (user_report → p2), not from the caller"
        assert r.json().get("priority") == "p2", f"the answer must carry the derived priority p2, got {r.json()}"
        r = await _enqueue(c, GOOD)
        assert store.get_item(r.json()["item_id"])["priority"] == "p1", "a guardrail_block must be queued at p1"
        for bad, why in (
            ({**GOOD, "source_type": "rumor", "source_id": "x-1"}, "an unknown source_type"),
            ({**GOOD, "source_id": ""}, "an empty source_id"),
            ({**GOOD, "source_id": "x" * 129}, "a 129-character source_id"),
        ):
            r = await _enqueue(c, bad)
            assert r.status_code == 400, f"{why} answered {r.status_code}, expected 400"
    assert len(_items(ctx)) == 2, f"rejected escalations were stored: the store holds {_items(ctx)}, expected the two valid items"


async def check_dedupe(ctx):
    async with _api(ctx) as c:
        first = await _enqueue(c, GOOD)
        assert first.status_code == 201, f"the first escalation answered {first.status_code}: {first.text}"
        again = await _enqueue(c, GOOD)
        assert again.status_code == 200, f"a second escalation of the same source answered {again.status_code}, expected 200 with the existing item"
        body = again.json()
        assert body.get("item_id") == first.json()["item_id"] and body.get("deduped") is True, f"the duplicate must answer the first item ({first.json()['item_id']}) with deduped true, got {body}"
        assert len(_items(ctx)) == 1, f"two escalations of one source left {len(_items(ctx))} items: {_items(ctx)}"
        other_type = await _enqueue(c, {**GOOD, "source_type": "user_report"})
        other_tenant = await _enqueue(c, GOOD, {"X-Tenant-Id": "t2"})
    assert other_type.status_code == 201, f"the same source_id under another source_type is another source, answered {other_type.status_code}"
    assert other_tenant.status_code == 201, f"the same source in another tenant is another source, answered {other_tenant.status_code}"
    assert len(_items(ctx)) == 3, f"the store holds {_items(ctx)}, expected 3 items"


async def check_payload_ref(ctx):
    async with _api(ctx) as c:
        r = await _enqueue(c, {**GOOD, "payload_text": "my card is 4242 4242 4242 4242"})
        assert r.status_code == 201, f"an escalation with payload_ref answered {r.status_code}: {r.text}"
        item = store.get_item(r.json()["item_id"])
        assert item.get("payload_ref") == "blob://t1/cmp-1", f"the item must carry payload_ref blob://t1/cmp-1, the store holds {item}"
        leaked = [name for name, value in item.items() if "4242" in value]
        assert not leaked, f"the item stores user text in {leaked}: the payload store owns the content, the queue keeps only the reference"
        r = await _enqueue(c, {"source_type": "guardrail_block", "source_id": "cmp-2", "payload_text": "hello"})
    assert r.status_code == 400, f"an escalation without payload_ref answered {r.status_code}, expected 400"
`,
    typescript: `const GOOD = {source_type: 'guardrail_block', source_id: 'cmp-1', payload_ref: 'blob://t1/cmp-1'};
const T1 = {'X-Tenant-Id': 't1'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/review/store.ts')};
}

const enqueue = (c, body, headers: Record<string, string> = T1) => c.post('/v1/review/items', {json: body, headers});
const items = ctx => (ctx.redis.keys('review:item:*') as string[]).sort();

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await enqueue(c, GOOD);
  assert.equal(r.status, 201, \`POST /v1/review/items answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.item_id && body.deduped === false, \`a new escalation must answer its item_id and deduped false, got \${r.text}\`);
  const item = await store.getItem(body.item_id);
  assert(item !== null && item.state === 'queued' && item.tenant === 't1', \`the store holds \${JSON.stringify(item)} for \${body.item_id}, expected a queued item of tenant t1\`);
  const queue = ctx.redis.lrange(\`review:queue:t1:\${item.priority}\`, 0, -1);
  assert(queue.includes(body.item_id), \`\${body.item_id} is not in its queue review:queue:t1:\${item.priority} (\${JSON.stringify(queue)})\`);
}

export async function check_tenant(ctx) {
  const {c} = api(ctx);
  for (const headers of [{}, {'X-Tenant-Id': ''}]) {
    const r = await enqueue(c, GOOD, headers);
    assert.equal(r.status, 401, \`an escalation with X-Tenant-Id \${JSON.stringify(headers['X-Tenant-Id'] ?? 'missing')} answered \${r.status}, expected 401\`);
  }
  assert.deepStrictEqual(items(ctx), [], \`an escalation without a tenant was stored: \${JSON.stringify(items(ctx))}. Answer 401 before anything is written\`);
  const r = await enqueue(c, GOOD);
  assert.equal(r.status, 201, \`with X-Tenant-Id t1 the escalation answered \${r.status}: \${r.text}\`);
}

export async function check_source(ctx) {
  const {c, store} = api(ctx);
  let r = await enqueue(c, {...GOOD, source_type: 'user_report', source_id: 'rep-1', priority: 'p1'});
  assert.equal(r.status, 201, \`a user_report answered \${r.status}: \${r.text}\`);
  const item = await store.getItem(r.json().item_id);
  assert.equal(item.priority, 'p2', \`a user_report that asked for p1 was queued at \${item.priority}: the priority comes from SOURCE_PRIORITY (user_report → p2), not from the caller\`);
  assert.equal(r.json().priority, 'p2', \`the answer must carry the derived priority p2, got \${r.text}\`);
  r = await enqueue(c, GOOD);
  assert.equal((await store.getItem(r.json().item_id)).priority, 'p1', 'a guardrail_block must be queued at p1');
  const bad: [Record<string, string>, string][] = [
    [{...GOOD, source_type: 'rumor', source_id: 'x-1'}, 'an unknown source_type'],
    [{...GOOD, source_id: ''}, 'an empty source_id'],
    [{...GOOD, source_id: 'x'.repeat(129)}, 'a 129-character source_id'],
  ];
  for (const [body, why] of bad) {
    const res = await enqueue(c, body);
    assert.equal(res.status, 400, \`\${why} answered \${res.status}, expected 400\`);
  }
  assert.equal(items(ctx).length, 2, \`rejected escalations were stored: the store holds \${JSON.stringify(items(ctx))}, expected the two valid items\`);
}

export async function check_dedupe(ctx) {
  const {c} = api(ctx);
  const first = await enqueue(c, GOOD);
  assert.equal(first.status, 201, \`the first escalation answered \${first.status}: \${first.text}\`);
  const again = await enqueue(c, GOOD);
  assert.equal(again.status, 200, \`a second escalation of the same source answered \${again.status}, expected 200 with the existing item\`);
  const body = again.json();
  assert(body.item_id === first.json().item_id && body.deduped === true, \`the duplicate must answer the first item (\${first.json().item_id}) with deduped true, got \${again.text}\`);
  assert.equal(items(ctx).length, 1, \`two escalations of one source left \${items(ctx).length} items: \${JSON.stringify(items(ctx))}\`);
  const otherType = await enqueue(c, {...GOOD, source_type: 'user_report'});
  const otherTenant = await enqueue(c, GOOD, {'X-Tenant-Id': 't2'});
  assert.equal(otherType.status, 201, \`the same source_id under another source_type is another source, answered \${otherType.status}\`);
  assert.equal(otherTenant.status, 201, \`the same source in another tenant is another source, answered \${otherTenant.status}\`);
  assert.equal(items(ctx).length, 3, \`the store holds \${JSON.stringify(items(ctx))}, expected 3 items\`);
}

export async function check_payload_ref(ctx) {
  const {c, store} = api(ctx);
  let r = await enqueue(c, {...GOOD, payload_text: 'my card is 4242 4242 4242 4242'});
  assert.equal(r.status, 201, \`an escalation with payload_ref answered \${r.status}: \${r.text}\`);
  const item = await store.getItem(r.json().item_id);
  assert.equal(item.payload_ref, 'blob://t1/cmp-1', \`the item must carry payload_ref blob://t1/cmp-1, the store holds \${JSON.stringify(item)}\`);
  const leaked = Object.keys(item).filter(name => String(item[name]).includes('4242'));
  assert.deepStrictEqual(leaked, [], \`the item stores user text in \${JSON.stringify(leaked)}: the payload store owns the content, the queue keeps only the reference\`);
  r = await enqueue(c, {source_type: 'guardrail_block', source_id: 'cmp-2', payload_text: 'hello'});
  assert.equal(r.status, 400, \`an escalation without payload_ref answered \${r.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"review/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

func good() map[string]any {
	return map[string]any{"source_type": "guardrail_block", "source_id": "cmp-1", "payload_ref": "blob://t1/cmp-1"}
}

func with(body map[string]any, key string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range body {
		out[k] = v
	}
	out[key] = value
	return out
}

type answer struct {
	ItemID   string \`json:"item_id"\`
	Priority string \`json:"priority"\`
	Deduped  bool   \`json:"deduped"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func decode(r *harness.Response) answer {
	var a answer
	r.Decode(&a)
	return a
}

func items(ctx *harness.Ctx) []string {
	keys := ctx.Redis.Keys("review:item:*")
	sort.Strings(keys)
	return keys
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/review/items", good(), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "POST /v1/review/items (%s)", r.Text())
	a := decode(r)
	ctx.Assert(a.ItemID != "" && !a.Deduped && strings.Contains(r.Text(), "deduped"), "a new escalation must answer its item_id and deduped false, got %s", r.Text())
	item := store.GetItem(apiBg, a.ItemID)
	ctx.Assert(item != nil && item["state"] == "queued" && item["tenant"] == "t1", "the store holds %v for %s, expected a queued item of tenant t1", item, a.ItemID)
	queue := ctx.Redis.LRange("review:queue:t1:"+item["priority"], 0, -1)
	found := false
	for _, id := range queue {
		found = found || id == a.ItemID
	}
	ctx.Assert(found, "%s is not in its queue review:queue:t1:%s (%v)", a.ItemID, item["priority"], queue)
}

func CheckTenant(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/review/items", good())
	ctx.Equal(r.Status, 401, "an escalation without X-Tenant-Id")
	r = c.Post("/v1/review/items", good(), "X-Tenant-Id", "")
	ctx.Equal(r.Status, 401, "an escalation with an empty X-Tenant-Id")
	ctx.Equal(len(items(ctx)), 0, "an escalation without a tenant was stored (%v); answer 401 before anything is written. The items", items(ctx))
	r = c.Post("/v1/review/items", good(), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "with X-Tenant-Id t1 the escalation (%s)", r.Text())
}

func CheckSource(ctx *harness.Ctx) {
	c := api(ctx)
	report := with(with(with(good(), "source_type", "user_report"), "source_id", "rep-1"), "priority", "p1")
	r := c.Post("/v1/review/items", report, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "a user_report (%s)", r.Text())
	a := decode(r)
	ctx.Equal(store.GetItem(apiBg, a.ItemID)["priority"], "p2", "a user_report that asked for p1 must be queued at p2 (the priority comes from sourcePriority, not from the caller); the stored priority")
	ctx.Equal(a.Priority, "p2", "the answer must carry the derived priority")
	r = c.Post("/v1/review/items", good(), "X-Tenant-Id", "t1")
	ctx.Equal(store.GetItem(apiBg, decode(r).ItemID)["priority"], "p1", "a guardrail_block's priority")
	bad := []struct {
		body map[string]any
		why  string
	}{
		{with(with(good(), "source_type", "rumor"), "source_id", "x-1"), "an unknown source_type"},
		{with(good(), "source_id", ""), "an empty source_id"},
		{with(good(), "source_id", strings.Repeat("x", 129)), "a 129-character source_id"},
	}
	for _, b := range bad {
		r := c.Post("/v1/review/items", b.body, "X-Tenant-Id", "t1")
		ctx.Equal(r.Status, 400, "%s", b.why)
	}
	ctx.Equal(len(items(ctx)), 2, "rejected escalations were stored (%v); the items", items(ctx))
}

func CheckDedupe(ctx *harness.Ctx) {
	c := api(ctx)
	first := c.Post("/v1/review/items", good(), "X-Tenant-Id", "t1")
	ctx.Equal(first.Status, 201, "the first escalation (%s)", first.Text())
	again := c.Post("/v1/review/items", good(), "X-Tenant-Id", "t1")
	ctx.Equal(again.Status, 200, "a second escalation of the same source must answer the existing item")
	a := decode(again)
	ctx.Assert(a.ItemID == decode(first).ItemID && a.Deduped, "the duplicate must answer the first item (%s) with deduped true, got %s", decode(first).ItemID, again.Text())
	ctx.Equal(len(items(ctx)), 1, "two escalations of one source must leave one item (%v); the items", items(ctx))
	otherType := c.Post("/v1/review/items", with(good(), "source_type", "user_report"), "X-Tenant-Id", "t1")
	otherTenant := c.Post("/v1/review/items", good(), "X-Tenant-Id", "t2")
	ctx.Equal(otherType.Status, 201, "the same source_id under another source_type is another source")
	ctx.Equal(otherTenant.Status, 201, "the same source in another tenant is another source")
	ctx.Equal(len(items(ctx)), 3, "the items in the store (%v)", items(ctx))
}

func CheckPayloadRef(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/review/items", with(good(), "payload_text", "my card is 4242 4242 4242 4242"), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 201, "an escalation with payload_ref (%s)", r.Text())
	item := store.GetItem(apiBg, decode(r).ItemID)
	ctx.Equal(item["payload_ref"], "blob://t1/cmp-1", "the item must carry payload_ref (the store holds %v)", item)
	for name, value := range item {
		ctx.Assert(!strings.Contains(value, "4242"), "the item stores user text in %s: the payload store owns the content, the queue keeps only the reference", name)
	}
	r = c.Post("/v1/review/items", map[string]any{"source_type": "guardrail_block", "source_id": "cmp-2", "payload_text": "hello"}, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 400, "an escalation without payload_ref")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "review/store.h"

using json = nlohmann::json;

namespace {

const json kGood = {{"source_type", "guardrail_block"}, {"source_id", "cmp-1"}, {"payload_ref", "blob://t1/cmp-1"}};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json with(json body, const std::string& key, const json& value) {
  body[key] = value;
  return body;
}

harness::Response enqueue(harness::HTTP& c, const json& body, const std::string& tenant = "t1") {
  return c.Post("/v1/review/items", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

json answer(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = enqueue(c, kGood);
  ctx.Equal(r.Status, 201, "POST /v1/review/items (%s)", r.Text());
  const json a = answer(r);
  const std::string item_id = a.value("item_id", "");
  ctx.Assert(!item_id.empty() && a.contains("deduped") && a["deduped"] == false, "a new escalation must answer its item_id and deduped false, got %s", r.Text());
  const auto item = store::getItem(item_id);
  ctx.Assert(item && item->at("state") == "queued" && item->at("tenant") == "t1", "the store holds %v for %s, expected a queued item of tenant t1", item.value_or(store::Item{}), item_id);
  const auto queue = ctx.Redis.LRange("review:queue:t1:" + item->at("priority"), 0, -1);
  bool found = false;
  for (const auto& id : queue) found = found || id == item_id;
  ctx.Assert(found, "%s is not in its queue review:queue:t1:%s (%v)", item_id, item->at("priority"), queue);
}

void CheckTenant(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = c.Post("/v1/review/items", kGood.dump(), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "an escalation without X-Tenant-Id");
  r = enqueue(c, kGood, "");
  ctx.Equal(r.Status, 401, "an escalation with an empty X-Tenant-Id");
  ctx.Equal(ctx.Redis.Keys("review:item:*").size(), 0, "an escalation without a tenant was stored; answer 401 before anything is written. The items");
  r = enqueue(c, kGood);
  ctx.Equal(r.Status, 201, "with X-Tenant-Id t1 the escalation (%s)", r.Text());
}

void CheckSource(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = enqueue(c, with(with(with(kGood, "source_type", "user_report"), "source_id", "rep-1"), "priority", "p1"));
  ctx.Equal(r.Status, 201, "a user_report (%s)", r.Text());
  const json a = answer(r);
  ctx.Equal(store::getItem(a.value("item_id", "")).value_or(store::Item{})["priority"], "p2",
            "a user_report that asked for p1 must be queued at p2 (the priority comes from kSourcePriority, not from the caller); the stored priority");
  ctx.Equal(a.value("priority", ""), "p2", "the answer must carry the derived priority");
  r = enqueue(c, kGood);
  ctx.Equal(store::getItem(answer(r).value("item_id", "")).value_or(store::Item{})["priority"], "p1", "a guardrail_block's priority");
  const std::vector<std::pair<json, std::string>> bad = {
      {with(with(kGood, "source_type", "rumor"), "source_id", "x-1"), "an unknown source_type"},
      {with(kGood, "source_id", ""), "an empty source_id"},
      {with(kGood, "source_id", std::string(129, 'x')), "a 129-character source_id"},
  };
  for (const auto& [body, why] : bad) ctx.Equal(enqueue(c, body).Status, 400, "%s", why);
  ctx.Equal(ctx.Redis.Keys("review:item:*").size(), 2, "rejected escalations were stored; the items");
}

void CheckDedupe(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = enqueue(c, kGood);
  ctx.Equal(first.Status, 201, "the first escalation (%s)", first.Text());
  const auto again = enqueue(c, kGood);
  ctx.Equal(again.Status, 200, "a second escalation of the same source must answer the existing item");
  const json a = answer(again);
  ctx.Assert(a.value("item_id", "") == answer(first).value("item_id", "") && a.value("deduped", false),
             "the duplicate must answer the first item with deduped true, got %s", again.Text());
  ctx.Equal(ctx.Redis.Keys("review:item:*").size(), 1, "two escalations of one source must leave one item; the items");
  ctx.Equal(enqueue(c, with(kGood, "source_type", "user_report")).Status, 201, "the same source_id under another source_type is another source");
  ctx.Equal(enqueue(c, kGood, "t2").Status, 201, "the same source in another tenant is another source");
  ctx.Equal(ctx.Redis.Keys("review:item:*").size(), 3, "the items in the store");
}

void CheckPayloadRef(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = enqueue(c, with(kGood, "payload_text", "my card is 4242 4242 4242 4242"));
  ctx.Equal(r.Status, 201, "an escalation with payload_ref (%s)", r.Text());
  const store::Item item = store::getItem(answer(r).value("item_id", "")).value_or(store::Item{});
  ctx.Equal(item.count("payload_ref") ? item.at("payload_ref") : "", "blob://t1/cmp-1", "the item must carry payload_ref (the store holds %v)", item);
  for (const auto& [name, value] : item) {
    ctx.Assert(value.find("4242") == std::string::npos, "the item stores user text in %s: the payload store owns the content, the queue keeps only the reference", name);
  }
  r = enqueue(c, json{{"source_type", "guardrail_block"}, {"source_id", "cmp-2"}, {"payload_text", "hello"}});
  ctx.Equal(r.Status, 400, "an escalation without payload_ref");
}
`,
  },
  hints: [
    'Send the same blocked completion twice with no tenant header and a `priority: p1` on a user report: both requests answer 201, two items sit in the queue, and the report jumps to p1.',
    'The handler copies the body into the item as sent: the caller picks the priority, nothing checks the tenant or the source, the text is stored inline, and nothing records which source already has an item.',
    'Answer 401 on an empty tenant; take the priority from `SOURCE_PRIORITY[source_type]` (400 otherwise, and for a bad `source_id`); require `payload_ref`; call `store.claim_source` before `create_item` and answer 200 `deduped: true` when it names an item.',
  ],
  debrief: `The fix moves every decision the caller used to make onto the server. Priority is a table the platform owns because it is the queue's fairness control: a convenience field becomes a starvation lever as soon as one integration gets noisy. The dedupe claim is one SET NX on the source, so two workers escalating at the same instant still get one item, and the claim is keyed by tenant and source type because the same id means different things in different systems. Production queues also fingerprint the payload so the same content under two sources merges, and sign the reference so only the queue can fetch it.`,
};
