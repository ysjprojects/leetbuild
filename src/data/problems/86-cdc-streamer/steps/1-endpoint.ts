import type {Step} from '@/lib/types';

export const subscriptionEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/subscriptions: only the tables and columns a tenant may stream',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'redis', 'pg'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/subscriptions\` with body \`{table, columns, sink}\` and
the tenant in \`X-Tenant-Id\` (401 without it). It looks the table up in the source schema
(\`store.table_columns\`), answers 400 for an unknown column, takes every column when none is named and
creates the subscription with \`store.create_subscription\` (201). It serves the demo and hides three
flaws.

**Failure mode the checks target.** A tenant streams \`auth_users\` because the table exists, a
subscription to \`customers\` ships every email address to the warehouse, and a client that retries
its create after a timeout opens a second replication slot.

- The table must be on the tenant's list (\`store.approved_tables\`); anything else is **403**, and no
  subscription is created.
- A requested column in \`store.sensitive_columns(table)\` is **400** naming it; with no columns
  named, the subscription takes the table's columns minus the sensitive ones.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with \`store.find_by_key\` first and
  answer that subscription on a replay; record a new one with \`store.record_key\`.`,
  sequence: {
    participants: ['Tenant app', 'cdcd', 'catalog', 'Redis'],
    messages: [
      {from: 'Tenant app', to: 'cdcd', label: 'POST /v1/subscriptions · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'cdcd', to: 'Redis', label: 'find_by_key(tenant, key) → replay / none', kind: 'sync'},
      {from: 'cdcd', to: 'catalog', label: 'approved_tables(tenant) → 403', kind: 'sync'},
      {from: 'cdcd', to: 'catalog', label: 'table_columns · sensitive_columns → 400', kind: 'sync'},
      {from: 'cdcd', to: 'Redis', label: 'create_subscription · record_key', kind: 'sync'},
      {from: 'cdcd', to: 'Tenant app', label: '201 {id, table, columns, slot}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Creates a subscription on POST /v1/subscriptions',
      detail:
        'A create from a tenant answers **201** with the subscription the store holds; a request without `X-Tenant-Id` is **401**.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/subscriptions["']/, /store\.create_subscription\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/subscriptions['"]/, /createSubscription\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/subscriptions"/, /store\.CreateSubscription\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"subscriptions"\s*\)/, /\bpost\s*\{/, /Store\.createSubscription\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/subscriptions"/, /store::createSubscription\(/]},
      },
    },
    {
      id: 'approved-table',
      title: 'Refuses a table the tenant may not stream with 403',
      detail:
        'The table is checked against `approved_tables(tenant)` and anything else is **403** before a subscription exists; the starter only checks that the table is in the source schema, so `auth_users` streams.',
      match: {
        python: {all: [/store\.approved_tables\(/, /\b403\b/]},
        typescript: {all: [/approvedTables\(\s*tenant/, /\b403\b/]},
        go: {all: [/store\.ApprovedTables\(/, /StatusForbidden|\b403\b/]},
        scala: {all: [/Store\.approvedTables\(/, /Forbidden|\b403\b/]},
        cpp: {all: [/store::approvedTables\(/, /\b403\b/]},
      },
    },
    {
      id: 'sensitive-columns',
      title: 'Keeps sensitive columns out of the stream',
      detail:
        'A requested column in `sensitive_columns(table)` is **400** naming it, and a subscription that names no columns takes the non-sensitive ones; the starter defaults to every column the schema lists.',
      match: {
        python: {all: [/store\.sensitive_columns\(/]},
        typescript: {all: [/sensitiveColumns\(\s*table/]},
        go: {all: [/store\.SensitiveColumns\(/]},
        scala: {all: [/Store\.sensitiveColumns\(/]},
        cpp: {all: [/store::sensitiveColumns\(/]},
      },
    },
    {
      id: 'idempotent-create',
      title: 'Keys the create by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required (**400**) and looked up with `find_by_key` before anything is created; a replay answers the first subscription and a new create is recorded with `record_key`. The starter ignores the header, so a retry opens a second slot.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.find_by_key\(/, /store\.record_key\(/],
          order: [/store\.find_by_key\(/, /store\.create_subscription\(/, /store\.record_key\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /findByKey\(\s*tenant/, /recordKey\(\s*tenant/],
          order: [/findByKey\(\s*tenant/, /createSubscription\(\s*tenant/, /recordKey\(\s*tenant/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.FindByKey\(/, /store\.RecordKey\(/],
          order: [/store\.FindByKey\(/, /store\.CreateSubscription\(/, /store\.RecordKey\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.findByKey\(/, /Store\.recordKey\(/],
          order: [/Store\.findByKey\(/, /Store\.createSubscription\(/, /Store\.recordKey\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::findByKey\(/, /store::recordKey\(/],
          order: [/store::findByKey\(/, /store::createSubscription\(/, /store::recordKey\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from cdc import store  # approved_tables, table_columns, sensitive_columns, create_subscription, find_by_key, record_key

app = FastAPI()


class SubscriptionCreate(BaseModel):
    table: str
    columns: list[str] = []
    sink: str


@app.post("/v1/subscriptions", status_code=201)
def create_subscription(body: SubscriptionCreate, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    columns = store.table_columns(body.table)
    if columns is None:
        raise HTTPException(status_code=404, detail=f"no table {body.table}")
    unknown = [name for name in body.columns if name not in columns]
    if unknown:
        raise HTTPException(status_code=400, detail={"unknown_columns": unknown})
    return store.create_subscription(tenant, body.table, body.columns or columns, body.sink)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from cdc import store  # approved_tables, table_columns, sensitive_columns, create_subscription, find_by_key, record_key

app = FastAPI()


class SubscriptionCreate(BaseModel):
    table: str
    columns: list[str] = []
    sink: str


@app.post("/v1/subscriptions")
def create_subscription(body: SubscriptionCreate, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    replay = store.find_by_key(tenant, key)
    if replay is not None:
        return JSONResponse(replay)  # the subscription the first attempt created
    # The tenant's agreement decides, not the schema: the replication user can read every table.
    if body.table not in store.approved_tables(tenant):
        raise HTTPException(status_code=403, detail=f"table {body.table} is not approved for {tenant}")
    columns = store.table_columns(body.table) or []
    unknown = [name for name in body.columns if name not in columns]
    if unknown:
        raise HTTPException(status_code=400, detail={"unknown_columns": unknown})
    sensitive = store.sensitive_columns(body.table)
    blocked = [name for name in body.columns if name in sensitive]
    if blocked:
        raise HTTPException(status_code=400, detail={"sensitive_columns": blocked})
    chosen = body.columns or [name for name in columns if name not in sensitive]
    subscription = store.create_subscription(tenant, body.table, chosen, body.sink)
    store.record_key(tenant, key, subscription["id"])
    return JSONResponse(subscription, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {approvedTables, createSubscription, findByKey, recordKey, sensitiveColumns, tableColumns} from 'cdc/store';

export const app = Fastify();

interface CreateBody {
  table: string;
  columns?: string[];
  sink: string;
}

app.post('/v1/subscriptions', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {table, columns: requested = [], sink} = request.body as CreateBody;
  const columns = tableColumns(table);
  if (columns === null) return reply.code(404).send({error: \`no table \${table}\`});
  const unknown = requested.filter(name => !columns.includes(name));
  if (unknown.length > 0) return reply.code(400).send({error: 'unknown columns', unknown_columns: unknown});
  return reply.code(201).send(await createSubscription(tenant, table, requested.length > 0 ? requested : columns, sink));
});
`,
      solution: `import Fastify from 'fastify';

import {approvedTables, createSubscription, findByKey, recordKey, sensitiveColumns, tableColumns} from 'cdc/store';

export const app = Fastify();

interface CreateBody {
  table: string;
  columns?: string[];
  sink: string;
}

app.post('/v1/subscriptions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const replay = await findByKey(tenant, key);
  if (replay !== null) return reply.code(200).send(replay); // the subscription the first attempt created
  const {table, columns: requested = [], sink} = request.body as CreateBody;
  // The tenant's agreement decides, not the schema: the replication user can read every table.
  if (!approvedTables(tenant).includes(table)) return reply.code(403).send({error: \`table \${table} is not approved for \${tenant}\`});
  const columns = tableColumns(table) ?? [];
  const unknown = requested.filter(name => !columns.includes(name));
  if (unknown.length > 0) return reply.code(400).send({error: 'unknown columns', unknown_columns: unknown});
  const sensitive = sensitiveColumns(table);
  const blocked = requested.filter(name => sensitive.includes(name));
  if (blocked.length > 0) return reply.code(400).send({error: 'sensitive columns', sensitive_columns: blocked});
  const chosen = requested.length > 0 ? requested : columns.filter(name => !sensitive.includes(name));
  const subscription = await createSubscription(tenant, table, chosen, sink);
  await recordKey(tenant, key, subscription.id);
  return reply.code(201).send(subscription);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"slices"

	"cdc/store" // store.ApprovedTables, TableColumns, SensitiveColumns, CreateSubscription, FindByKey, RecordKey
)

type createRequest struct {
	Table   string   \`json:"table"\`
	Columns []string \`json:"columns"\`
	Sink    string   \`json:"sink"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createSubscription(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body createRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	columns, exists := store.TableColumns(body.Table)
	if !exists {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no table " + body.Table})
		return
	}
	for _, name := range body.Columns {
		if !slices.Contains(columns, name) {
			writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "unknown columns", "unknown_columns": []string{name}})
			return
		}
	}
	chosen := body.Columns
	if len(chosen) == 0 {
		chosen = columns
	}
	sub, err := store.CreateSubscription(r.Context(), tenant, body.Table, chosen, body.Sink)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(rw, http.StatusCreated, sub)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/subscriptions", createSubscription)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"slices"

	"cdc/store" // store.ApprovedTables, TableColumns, SensitiveColumns, CreateSubscription, FindByKey, RecordKey
)

type createRequest struct {
	Table   string   \`json:"table"\`
	Columns []string \`json:"columns"\`
	Sink    string   \`json:"sink"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createSubscription(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	if replay := store.FindByKey(r.Context(), tenant, key); replay != nil {
		writeJSON(rw, http.StatusOK, replay) // the subscription the first attempt created
		return
	}
	var body createRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// The tenant's agreement decides, not the schema: the replication user can read every table.
	if !slices.Contains(store.ApprovedTables(tenant), body.Table) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "table " + body.Table + " is not approved for " + tenant})
		return
	}
	columns, _ := store.TableColumns(body.Table)
	sensitive := store.SensitiveColumns(body.Table)
	for _, name := range body.Columns {
		if !slices.Contains(columns, name) {
			writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "unknown columns", "unknown_columns": []string{name}})
			return
		}
		if slices.Contains(sensitive, name) {
			writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "sensitive columns", "sensitive_columns": []string{name}})
			return
		}
	}
	chosen := body.Columns
	if len(chosen) == 0 {
		for _, name := range columns {
			if !slices.Contains(sensitive, name) {
				chosen = append(chosen, name)
			}
		}
	}
	sub, err := store.CreateSubscription(r.Context(), tenant, body.Table, chosen, body.Sink)
	if err == nil {
		err = store.RecordKey(r.Context(), tenant, key, sub.ID)
	}
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(rw, http.StatusCreated, sub)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/subscriptions", createSubscription)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import cdc.Store // Store.approvedTables, tableColumns, sensitiveColumns, createSubscription, findByKey, recordKey

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  final case class CreateRequest(table: String, columns: Seq[String], sink: String)

  private def parse(raw: String): CreateRequest = {
    val fields = raw.parseJson.asJsObject.fields
    def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    val columns = fields.get("columns").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
    CreateRequest(text("table"), columns, text("sink"))
  }

  def create(tenant: String, raw: String): HttpResponse = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if (tenant.isEmpty) return error(StatusCodes.Unauthorized, "X-Tenant-Id is required")
    val body = parse(raw)
    Store.tableColumns(body.table) match {
      case None => error(StatusCodes.NotFound, s"no table \${body.table}")
      case Some(columns) =>
        val unknown = body.columns.filterNot(columns.contains)
        if (unknown.nonEmpty) error(StatusCodes.BadRequest, s"unknown columns \${unknown.mkString(", ")}")
        else {
          val chosen = if (body.columns.nonEmpty) body.columns else columns
          json(StatusCodes.Created, Store.toJson(Store.createSubscription(tenant, body.table, chosen, body.sink)))
        }
    }
  }

  val route: Route = path("v1" / "subscriptions") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          complete(create(tenant.getOrElse(""), raw))
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

import cdc.Store // Store.approvedTables, tableColumns, sensitiveColumns, createSubscription, findByKey, recordKey

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  final case class CreateRequest(table: String, columns: Seq[String], sink: String)

  private def parse(raw: String): CreateRequest = {
    val fields = raw.parseJson.asJsObject.fields
    def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    val columns = fields.get("columns").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Vector.empty)
    CreateRequest(text("table"), columns, text("sink"))
  }

  def create(tenant: String, key: String, raw: String): HttpResponse = {
    if (tenant.isEmpty) return error(StatusCodes.Unauthorized, "X-Tenant-Id is required")
    if (key.isEmpty) return error(StatusCodes.BadRequest, "Idempotency-Key is required")
    Store.findByKey(tenant, key) match {
      case Some(replay) => json(StatusCodes.OK, Store.toJson(replay)) // the subscription the first attempt created
      case None =>
        val body = parse(raw)
        // The tenant's agreement decides, not the schema: the replication user can read every table.
        if (!Store.approvedTables(tenant).contains(body.table)) return error(StatusCodes.Forbidden, s"table \${body.table} is not approved for $tenant")
        val columns = Store.tableColumns(body.table).getOrElse(Seq.empty)
        val sensitive = Store.sensitiveColumns(body.table)
        val unknown = body.columns.filterNot(columns.contains)
        val blocked = body.columns.filter(sensitive.contains)
        if (unknown.nonEmpty) error(StatusCodes.BadRequest, s"unknown columns \${unknown.mkString(", ")}")
        else if (blocked.nonEmpty) error(StatusCodes.BadRequest, s"sensitive columns \${blocked.mkString(", ")}")
        else {
          val chosen = if (body.columns.nonEmpty) body.columns else columns.filterNot(sensitive.contains)
          val subscription = Store.createSubscription(tenant, body.table, chosen, body.sink)
          Store.recordKey(tenant, key, subscription.id)
          json(StatusCodes.Created, Store.toJson(subscription))
        }
    }
  }

  val route: Route = path("v1" / "subscriptions") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("Idempotency-Key") { key =>
          entity(as[String]) { raw =>
            complete(create(tenant.getOrElse(""), key.getOrElse(""), raw))
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

#include <algorithm>
#include <string>
#include <vector>

#include "cdc/store.h"  // store::approvedTables, tableColumns, sensitiveColumns, createSubscription, findByKey, recordKey

using json = nlohmann::json;

bool listed(const std::vector<std::string>& names, const std::string& name) {
  return std::find(names.begin(), names.end(), name) != names.end();
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_subscription(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "the body must be a JSON object"}});
  const std::string table = body.value("table", "");
  const std::vector<std::string> requested = body.value("columns", std::vector<std::string>{});
  const auto columns = store::tableColumns(table);
  if (!columns) return reply(res, 404, {{"error", "no table " + table}});
  for (const std::string& name : requested) {
    if (!listed(*columns, name)) return reply(res, 400, {{"error", "unknown columns"}, {"unknown_columns", {name}}});
  }
  const std::vector<std::string> chosen = requested.empty() ? *columns : requested;
  reply(res, 201, store::toJson(store::createSubscription(tenant, table, chosen, body.value("sink", ""))));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/subscriptions", create_subscription); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "cdc/store.h"  // store::approvedTables, tableColumns, sensitiveColumns, createSubscription, findByKey, recordKey

using json = nlohmann::json;

bool listed(const std::vector<std::string>& names, const std::string& name) {
  return std::find(names.begin(), names.end(), name) != names.end();
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_subscription(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, {{"error", "Idempotency-Key is required"}});
  if (const auto replay = store::findByKey(tenant, key)) {
    return reply(res, 200, store::toJson(*replay));  // the subscription the first attempt created
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "the body must be a JSON object"}});
  const std::string table = body.value("table", "");
  const std::vector<std::string> requested = body.value("columns", std::vector<std::string>{});
  // The tenant's agreement decides, not the schema: the replication user can read every table.
  if (!listed(store::approvedTables(tenant), table)) {
    return reply(res, 403, {{"error", "table " + table + " is not approved for " + tenant}});
  }
  const std::vector<std::string> columns = store::tableColumns(table).value_or(std::vector<std::string>{});
  const std::vector<std::string> sensitive = store::sensitiveColumns(table);
  for (const std::string& name : requested) {
    if (!listed(columns, name)) return reply(res, 400, {{"error", "unknown columns"}, {"unknown_columns", {name}}});
    if (listed(sensitive, name)) return reply(res, 400, {{"error", "sensitive columns"}, {"sensitive_columns", {name}}});
  }
  std::vector<std::string> chosen = requested;
  if (chosen.empty()) {
    for (const std::string& name : columns) {
      if (!listed(sensitive, name)) chosen.push_back(name);
    }
  }
  const store::Subscription subscription = store::createSubscription(tenant, table, chosen, body.value("sink", ""));
  store::recordKey(tenant, key, subscription.id);
  reply(res, 201, store::toJson(subscription));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/subscriptions", create_subscription); }
`,
    },
  },
  harness: {
    python: `from cdc import store

ORDERS = {"table": "orders", "columns": ["id", "status"], "sink": "warehouse-1"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _headers(tenant="acme", key="k-1"):
    headers = {}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    if key:
        headers["Idempotency-Key"] = key
    return headers


def _subscriptions(ctx):
    return sorted(ctx.redis.keys("cdc:sub:sub-*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/subscriptions", json=ORDERS, headers=_headers())
        assert r.status_code == 201, f"POST /v1/subscriptions answered {r.status_code}: {r.text}"
        body = r.json()
        want = {"tenant": "acme", "table": "orders", "columns": ["id", "status"], "sink": "warehouse-1", "status": "active"}
        assert all(body.get(k) == v for k, v in want.items()), f"the create answered {body}, expected the subscription with {want}"
        stored = store.find_subscription(body.get("id", ""))
        assert stored == body, f"the response {body} is not the subscription the store holds ({stored})"
        r = await c.post("/v1/subscriptions", json=ORDERS, headers=_headers(tenant=None, key="k-2"))
    assert r.status_code == 401, f"a create without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_approved_table(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/subscriptions", json={"table": "auth_users", "columns": ["id"], "sink": "warehouse-1"}, headers=_headers(key="k-1"))
        assert r.status_code == 403, f"acme asked to stream auth_users and got {r.status_code}: the table exists in the source, but it is not on acme's list. Expected 403"
        assert _subscriptions(ctx) == [], f"a refused create left subscriptions behind: {_subscriptions(ctx)}"
        r = await c.post("/v1/subscriptions", json={"table": "customers", "sink": "crm"}, headers=_headers(tenant="globex", key="k-2"))
        assert r.status_code == 403, f"globex asked for customers, which only acme may stream, and got {r.status_code}, expected 403"
        r = await c.post("/v1/subscriptions", json={"table": "customers", "columns": ["id", "name"], "sink": "crm"}, headers=_headers(key="k-3"))
    assert r.status_code == 201, f"acme asked for customers, which is on its list, and got {r.status_code}: {r.text}"
    assert len(_subscriptions(ctx)) == 1, f"one approved create must leave one subscription, Redis holds {_subscriptions(ctx)}"


async def check_sensitive_columns(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/subscriptions", json={"table": "customers", "columns": ["id", "email"], "sink": "crm"}, headers=_headers(key="k-1"))
        assert r.status_code == 400, f"a subscription asking for customers.email answered {r.status_code}: the column is sensitive, expected 400"
        assert "email" in r.text, f"the 400 must name the sensitive column, got {r.text}"
        assert _subscriptions(ctx) == [], f"a refused create left subscriptions behind: {_subscriptions(ctx)}"
        r = await c.post("/v1/subscriptions", json={"table": "customers", "sink": "crm"}, headers=_headers(key="k-2"))
        assert r.status_code == 201, f"a subscription to customers naming no columns answered {r.status_code}: {r.text}"
        columns = r.json().get("columns")
        assert columns == ["id", "name", "country"], f"with no columns named the subscription streams {columns}: the default must leave out the sensitive email column"
        r = await c.post("/v1/subscriptions", json={"table": "orders", "columns": ["id", "nope"], "sink": "crm"}, headers=_headers(key="k-3"))
    assert r.status_code == 400, f"a column the table does not have answered {r.status_code}, expected 400"


async def check_idempotent_create(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/subscriptions", json=ORDERS, headers=_headers(key="k-1"))
        assert first.status_code == 201, f"the first create answered {first.status_code}: {first.text}"
        replay = await c.post("/v1/subscriptions", json=ORDERS, headers=_headers(key="k-1"))
        assert replay.status_code in (200, 201), f"a replay answered {replay.status_code}: {replay.text}"
        assert replay.json().get("id") == first.json().get("id"), f"a retry with the same Idempotency-Key created {replay.json().get('id')} next to {first.json().get('id')}: a second slot over the same table"
        assert len(_subscriptions(ctx)) == 1, f"after a create and its replay Redis holds {_subscriptions(ctx)}, expected one subscription"
        other = await c.post("/v1/subscriptions", json=ORDERS, headers=_headers(tenant="globex", key="k-1"))
        assert other.status_code == 201 and other.json().get("id") != first.json().get("id"), f"globex reusing acme's key k-1 must get its own subscription, got {other.status_code} {other.text}"
        missing = await c.post("/v1/subscriptions", json=ORDERS, headers=_headers(key=None))
    assert missing.status_code == 400, f"a create without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `const ORDERS = {table: 'orders', columns: ['id', 'status'], sink: 'warehouse-1'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/cdc/store.ts')};
}

function headers(tenant: string | null = 'acme', key: string | null = 'k-1'): Record<string, string> {
  const out: Record<string, string> = {};
  if (tenant) out['X-Tenant-Id'] = tenant;
  if (key) out['Idempotency-Key'] = key;
  return out;
}

const subscriptions = (ctx): string[] => [...ctx.redis.keys('cdc:sub:sub-*')].sort();

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  let r = await c.post('/v1/subscriptions', {json: ORDERS, headers: headers()});
  assert.equal(r.status, 201, \`POST /v1/subscriptions answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const want = {tenant: 'acme', table: 'orders', columns: ['id', 'status'], sink: 'warehouse-1', status: 'active'};
  for (const [k, v] of Object.entries(want)) assert.deepStrictEqual(body[k], v, \`the create answered \${r.text}, expected the subscription with \${JSON.stringify(want)}\`);
  const stored = await store.findSubscription(body.id ?? '');
  assert.deepStrictEqual(stored, body, \`the response \${r.text} is not the subscription the store holds (\${JSON.stringify(stored)})\`);
  r = await c.post('/v1/subscriptions', {json: ORDERS, headers: headers(null, 'k-2')});
  assert.equal(r.status, 401, \`a create without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_approved_table(ctx) {
  const {c} = api(ctx);
  let r = await c.post('/v1/subscriptions', {json: {table: 'auth_users', columns: ['id'], sink: 'warehouse-1'}, headers: headers('acme', 'k-1')});
  assert.equal(r.status, 403, \`acme asked to stream auth_users and got \${r.status}: the table exists in the source, but it is not on acme's list. Expected 403\`);
  assert.deepStrictEqual(subscriptions(ctx), [], \`a refused create left subscriptions behind: \${JSON.stringify(subscriptions(ctx))}\`);
  r = await c.post('/v1/subscriptions', {json: {table: 'customers', sink: 'crm'}, headers: headers('globex', 'k-2')});
  assert.equal(r.status, 403, \`globex asked for customers, which only acme may stream, and got \${r.status}, expected 403\`);
  r = await c.post('/v1/subscriptions', {json: {table: 'customers', columns: ['id', 'name'], sink: 'crm'}, headers: headers('acme', 'k-3')});
  assert.equal(r.status, 201, \`acme asked for customers, which is on its list, and got \${r.status}: \${r.text}\`);
  assert.equal(subscriptions(ctx).length, 1, \`one approved create must leave one subscription, Redis holds \${JSON.stringify(subscriptions(ctx))}\`);
}

export async function check_sensitive_columns(ctx) {
  const {c} = api(ctx);
  let r = await c.post('/v1/subscriptions', {json: {table: 'customers', columns: ['id', 'email'], sink: 'crm'}, headers: headers('acme', 'k-1')});
  assert.equal(r.status, 400, \`a subscription asking for customers.email answered \${r.status}: the column is sensitive, expected 400\`);
  assert(r.text.includes('email'), \`the 400 must name the sensitive column, got \${r.text}\`);
  assert.deepStrictEqual(subscriptions(ctx), [], \`a refused create left subscriptions behind: \${JSON.stringify(subscriptions(ctx))}\`);
  r = await c.post('/v1/subscriptions', {json: {table: 'customers', sink: 'crm'}, headers: headers('acme', 'k-2')});
  assert.equal(r.status, 201, \`a subscription to customers naming no columns answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json().columns, ['id', 'name', 'country'], \`with no columns named the subscription streams \${JSON.stringify(r.json().columns)}: the default must leave out the sensitive email column\`);
  r = await c.post('/v1/subscriptions', {json: {table: 'orders', columns: ['id', 'nope'], sink: 'crm'}, headers: headers('acme', 'k-3')});
  assert.equal(r.status, 400, \`a column the table does not have answered \${r.status}, expected 400\`);
}

export async function check_idempotent_create(ctx) {
  const {c} = api(ctx);
  const first = await c.post('/v1/subscriptions', {json: ORDERS, headers: headers('acme', 'k-1')});
  assert.equal(first.status, 201, \`the first create answered \${first.status}: \${first.text}\`);
  const replay = await c.post('/v1/subscriptions', {json: ORDERS, headers: headers('acme', 'k-1')});
  assert(replay.status === 200 || replay.status === 201, \`a replay answered \${replay.status}: \${replay.text}\`);
  assert.equal(replay.json().id, first.json().id, \`a retry with the same Idempotency-Key created \${replay.json().id} next to \${first.json().id}: a second slot over the same table\`);
  assert.equal(subscriptions(ctx).length, 1, \`after a create and its replay Redis holds \${JSON.stringify(subscriptions(ctx))}, expected one subscription\`);
  const other = await c.post('/v1/subscriptions', {json: ORDERS, headers: headers('globex', 'k-1')});
  assert(other.status === 201 && other.json().id !== first.json().id, \`globex reusing acme's key k-1 must get its own subscription, got \${other.status} \${other.text}\`);
  const missing = await c.post('/v1/subscriptions', {json: ORDERS, headers: headers('acme', null)});
  assert.equal(missing.status, 400, \`a create without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"cdc/store"

	"leetbuild/harness"
)

var orders = map[string]any{"table": "orders", "columns": []string{"id", "status"}, "sink": "warehouse-1"}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func headers(tenant, key string) []string {
	var out []string
	if tenant != "" {
		out = append(out, "X-Tenant-Id", tenant)
	}
	if key != "" {
		out = append(out, "Idempotency-Key", key)
	}
	return out
}

type created struct {
	ID      string   \`json:"id"\`
	Tenant  string   \`json:"tenant"\`
	Table   string   \`json:"table"\`
	Columns []string \`json:"columns"\`
	Sink    string   \`json:"sink"\`
	Slot    string   \`json:"slot"\`
	Status  string   \`json:"status"\`
}

func decode(r *harness.Response) created {
	var body created
	r.Decode(&body)
	return body
}

func subscriptions(ctx *harness.Ctx) []string { return ctx.Redis.Keys("cdc:sub:sub-*") }

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/subscriptions", orders, headers("acme", "k-1")...)
	ctx.Equal(r.Status, 201, "POST /v1/subscriptions (%s)", r.Text())
	body := decode(r)
	ctx.Assert(body.Tenant == "acme" && body.Table == "orders" && strings.Join(body.Columns, ",") == "id,status" && body.Sink == "warehouse-1" && body.Status == "active",
		"the create answered %s, expected the acme subscription to orders (id, status) into warehouse-1, active", r.Text())
	stored := store.FindSubscription(context.Background(), body.ID)
	ctx.Assert(stored != nil && stored.Slot == body.Slot && stored.Tenant == body.Tenant, "the response %s is not the subscription the store holds (%+v)", r.Text(), stored)
	r = c.Post("/v1/subscriptions", orders, headers("", "k-2")...)
	ctx.Equal(r.Status, 401, "a create without X-Tenant-Id")
}

func CheckApprovedTable(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/subscriptions", map[string]any{"table": "auth_users", "columns": []string{"id"}, "sink": "warehouse-1"}, headers("acme", "k-1")...)
	ctx.Equal(r.Status, 403, "acme asked to stream auth_users: the table exists in the source, but it is not on acme's list")
	ctx.Equal(len(subscriptions(ctx)), 0, "a refused create left subscriptions behind (%q); the subscriptions", subscriptions(ctx))
	r = c.Post("/v1/subscriptions", map[string]any{"table": "customers", "sink": "crm"}, headers("globex", "k-2")...)
	ctx.Equal(r.Status, 403, "globex asked for customers, which only acme may stream")
	r = c.Post("/v1/subscriptions", map[string]any{"table": "customers", "columns": []string{"id", "name"}, "sink": "crm"}, headers("acme", "k-3")...)
	ctx.Equal(r.Status, 201, "acme asked for customers, which is on its list (%s)", r.Text())
	ctx.Equal(len(subscriptions(ctx)), 1, "one approved create must leave one subscription (%q); the subscriptions", subscriptions(ctx))
}

func CheckSensitiveColumns(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/subscriptions", map[string]any{"table": "customers", "columns": []string{"id", "email"}, "sink": "crm"}, headers("acme", "k-1")...)
	ctx.Equal(r.Status, 400, "a subscription asking for customers.email (a sensitive column)")
	ctx.Assert(strings.Contains(r.Text(), "email"), "the 400 must name the sensitive column, got %s", r.Text())
	ctx.Equal(len(subscriptions(ctx)), 0, "a refused create left subscriptions behind (%q); the subscriptions", subscriptions(ctx))
	r = c.Post("/v1/subscriptions", map[string]any{"table": "customers", "sink": "crm"}, headers("acme", "k-2")...)
	ctx.Equal(r.Status, 201, "a subscription to customers naming no columns (%s)", r.Text())
	ctx.Equal(decode(r).Columns, []string{"id", "name", "country"}, "with no columns named the default must leave out the sensitive email column; the columns")
	r = c.Post("/v1/subscriptions", map[string]any{"table": "orders", "columns": []string{"id", "nope"}, "sink": "crm"}, headers("acme", "k-3")...)
	ctx.Equal(r.Status, 400, "a column the table does not have")
}

func CheckIdempotentCreate(ctx *harness.Ctx) {
	c := api(ctx)
	first := c.Post("/v1/subscriptions", orders, headers("acme", "k-1")...)
	ctx.Equal(first.Status, 201, "the first create (%s)", first.Text())
	replay := c.Post("/v1/subscriptions", orders, headers("acme", "k-1")...)
	ctx.Assert(replay.Status == 200 || replay.Status == 201, "a replay answered %d: %s", replay.Status, replay.Text())
	ctx.Equal(decode(replay).ID, decode(first).ID, "a retry with the same Idempotency-Key must answer the first subscription, not open a second slot; the id")
	ctx.Equal(len(subscriptions(ctx)), 1, "after a create and its replay Redis holds %q; the subscriptions", subscriptions(ctx))
	other := c.Post("/v1/subscriptions", orders, headers("globex", "k-1")...)
	ctx.Assert(other.Status == 201 && decode(other).ID != decode(first).ID, "globex reusing acme's key k-1 must get its own subscription, got %d %s", other.Status, other.Text())
	missing := c.Post("/v1/subscriptions", orders, headers("acme", "")...)
	ctx.Equal(missing.Status, 400, "a create without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "cdc/store.h"

namespace {

const std::string kOrders = R"({"table": "orders", "columns": ["id", "status"], "sink": "warehouse-1"})";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response create(harness::HTTP& c, const std::string& body, const std::string& tenant, const std::string& key) {
  std::vector<std::string> headers = {"Content-Type", "application/json"};
  if (!tenant.empty()) headers.insert(headers.end(), {"X-Tenant-Id", tenant});
  if (!key.empty()) headers.insert(headers.end(), {"Idempotency-Key", key});
  return c.Send("POST", "/v1/subscriptions", body, headers);
}

nlohmann::json parse(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

size_t subscriptions(harness::Ctx& ctx) { return ctx.Redis.Keys("cdc:sub:sub-*").size(); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = create(c, kOrders, "acme", "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/subscriptions (%s)", r.Text());
  const auto body = parse(r);
  ctx.Assert(body.value("tenant", "") == "acme" && body.value("table", "") == "orders" &&
                 body.value("columns", nlohmann::json()) == nlohmann::json({"id", "status"}) && body.value("sink", "") == "warehouse-1" &&
                 body.value("status", "") == "active",
             "the create answered %s, expected the acme subscription to orders (id, status) into warehouse-1, active", r.Text());
  const auto stored = store::findSubscription(body.value("id", ""));
  ctx.Assert(stored && store::toJson(*stored) == body, "the response %s is not the subscription the store holds", r.Text());
  r = create(c, kOrders, "", "k-2");
  ctx.Equal(r.Status, 401, "a create without X-Tenant-Id");
}

void CheckApprovedTable(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = create(c, R"({"table": "auth_users", "columns": ["id"], "sink": "warehouse-1"})", "acme", "k-1");
  ctx.Equal(r.Status, 403, "acme asked to stream auth_users: the table exists in the source, but it is not on acme's list");
  ctx.Equal(subscriptions(ctx), 0, "a refused create left subscriptions behind; the subscriptions");
  r = create(c, R"({"table": "customers", "sink": "crm"})", "globex", "k-2");
  ctx.Equal(r.Status, 403, "globex asked for customers, which only acme may stream");
  r = create(c, R"({"table": "customers", "columns": ["id", "name"], "sink": "crm"})", "acme", "k-3");
  ctx.Equal(r.Status, 201, "acme asked for customers, which is on its list (%s)", r.Text());
  ctx.Equal(subscriptions(ctx), 1, "one approved create must leave one subscription; the subscriptions");
}

void CheckSensitiveColumns(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = create(c, R"({"table": "customers", "columns": ["id", "email"], "sink": "crm"})", "acme", "k-1");
  ctx.Equal(r.Status, 400, "a subscription asking for customers.email (a sensitive column)");
  ctx.Assert(r.Text().find("email") != std::string::npos, "the 400 must name the sensitive column, got %s", r.Text());
  ctx.Equal(subscriptions(ctx), 0, "a refused create left subscriptions behind; the subscriptions");
  r = create(c, R"({"table": "customers", "sink": "crm"})", "acme", "k-2");
  ctx.Equal(r.Status, 201, "a subscription to customers naming no columns (%s)", r.Text());
  ctx.Equal(parse(r).value("columns", nlohmann::json()), nlohmann::json({"id", "name", "country"}),
            "with no columns named the default must leave out the sensitive email column; the columns");
  r = create(c, R"({"table": "orders", "columns": ["id", "nope"], "sink": "crm"})", "acme", "k-3");
  ctx.Equal(r.Status, 400, "a column the table does not have");
}

void CheckIdempotentCreate(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = create(c, kOrders, "acme", "k-1");
  ctx.Equal(first.Status, 201, "the first create (%s)", first.Text());
  const auto replay = create(c, kOrders, "acme", "k-1");
  ctx.Assert(replay.Status == 200 || replay.Status == 201, "a replay answered %d: %s", replay.Status, replay.Text());
  ctx.Equal(parse(replay).value("id", ""), parse(first).value("id", ""),
            "a retry with the same Idempotency-Key must answer the first subscription, not open a second slot; the id");
  ctx.Equal(subscriptions(ctx), 1, "after a create and its replay; the subscriptions");
  const auto other = create(c, kOrders, "globex", "k-1");
  ctx.Assert(other.Status == 201 && parse(other).value("id", "") != parse(first).value("id", ""),
             "globex reusing acme's key k-1 must get its own subscription, got %d %s", other.Status, other.Text());
  const auto missing = create(c, kOrders, "acme", "");
  ctx.Equal(missing.Status, 400, "a create without Idempotency-Key");
}
`,
  },
  hints: [
    'Ask for `auth_users` as acme: 201. Subscribe to `customers` without naming columns: the email column streams. Retry a create with the same Idempotency-Key and count the subscriptions: two, each with its own slot.',
    'The handler asks whether the table exists in the source schema, which every table does; it defaults to every column the schema lists; and it never reads the Idempotency-Key header, so each attempt creates.',
    'Read the key (400 when missing) and answer `find_by_key` when it is set; 403 unless the table is in `approved_tables(tenant)`; 400 for a requested column in `sensitive_columns`, default to the rest; `record_key` after `create_subscription`.',
  ],
  debrief: `Authorization is the tenant's agreement, not the database's catalog: a replication user can read every table, so the service is the one place that says which tables a tenant may stream. Sensitive columns are cut at subscription time because a change stream copies rows into systems with their own retention, and nothing downstream can unsend a column. The idempotency record is keyed by tenant and key, so a retry finds the first attempt's subscription instead of opening a second slot that holds WAL nobody reads. Production services write the key and the subscription atomically (a SET NX or one transaction), expire the key after a day, and refuse a replay whose body differs from the first attempt.`,
};
