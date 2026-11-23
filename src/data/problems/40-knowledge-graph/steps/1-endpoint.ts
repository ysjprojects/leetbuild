import type {Step} from '@/lib/types';

export const entityUpsertStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/entities: the server decides what merges',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/entities\` on the graph store (\`graph.store\`,
provided). The tenant comes from \`X-Tenant-Id\` (401 without it) and the body is
\`{"type", "name", "aliases"}\`. When the body names \`merge_into\`, or one of its aliases is claimed
in the tenant, the starter adds the aliases to that entity (200, \`merged: true\`); otherwise it
creates one (201). It serves the demo and hides three flaws.

**Failure mode the checks target.** A caller folds two people into one by naming a target; a
\`company\` that shares an alias with a \`person\` disappears into the person; and a client that times
out and retries creates a second copy of the entity.

- \`AUTHORITY_FIELDS\` (\`merge_into\`, \`force\`, \`merge_policy\`) are the server's to decide: a body
  carrying any of them, whatever its value, is **400** naming the field, and nothing is written.
- Any alias claimed by an entity of a **different type** is **409** with both candidates under
  \`candidates\` (the claimant's id and type, and the proposed type); nothing is written, even when
  another alias is claimed by the same type. An alias of the same type still extends that entity.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with \`store.idem_result\` before
  any write, answer the recorded status and body on a replay, and record a fresh result with
  \`store.record_idem\`.`,
  sequence: {
    participants: ['Client', 'graph-api', 'Graph store'],
    messages: [
      {from: 'Client', to: 'graph-api', label: 'POST /v1/entities · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'graph-api', to: 'Graph store', label: 'idem_result(tenant, key) → recorded / none', kind: 'sync'},
      {from: 'graph-api', to: 'graph-api', label: 'AUTHORITY_FIELDS in body → 400', kind: 'sync'},
      {from: 'graph-api', to: 'Graph store', label: 'find_alias(tenant, alias) per alias', kind: 'sync'},
      {from: 'Graph store', to: 'graph-api', label: 'claimants with their types', kind: 'reply'},
      {from: 'graph-api', to: 'Client', label: '409 candidates when a type differs', kind: 'reply'},
      {from: 'graph-api', to: 'Graph store', label: 'add_aliases / create_entity · record_idem', kind: 'sync'},
      {from: 'graph-api', to: 'Client', label: '200 merged / 201 created', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/entities for a tenant',
      detail:
        'Register `POST /v1/entities`, read the tenant from `X-Tenant-Id` (401 without it), create an entity (201) and extend the same-type entity that already claims an alias (200).',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/entities["']/, /x-tenant-id/i]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/entities['"]/, /x-tenant-id/i]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/entities"/, /X-Tenant-Id/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/entities"/, /X-Tenant-Id/]},
      },
    },
    {
      id: 'merge-policy',
      title: 'Refuses a caller-supplied merge decision',
      detail:
        'A body carrying any of `AUTHORITY_FIELDS` (`merge_into`, `force`, `merge_policy`), whatever its value, is 400 naming the field and writes nothing; the starter reads `merge_into` and adds the aliases to that entity.',
      match: {
        python: {all: [/AUTHORITY_FIELDS/], none: [/get\(\s*["']merge_into["']|\[\s*["']merge_into["']\s*\]/]},
        typescript: {all: [/AUTHORITY_FIELDS/], none: [/\.merge_into\b|\[\s*['"]merge_into['"]\s*\]/]},
        go: {all: [/authorityFields/], none: [/body\[\s*"merge_into"\s*\]/]},
        cpp: {all: [/kAuthorityFields/], none: [/value\(\s*"merge_into"|\[\s*"merge_into"\s*\]/]},
      },
    },
    {
      id: 'cross-type-409',
      title: 'A cross-type alias collision is 409 with both candidates',
      detail:
        'When any of the aliases is claimed by an entity of another type, even after one claimed by the same type, the answer is 409 with `candidates` naming the claimant and the proposed type, and nothing is written; the starter merges whatever claims the alias.',
      match: {
        python: {all: [/\b409\b/, /candidates/]},
        typescript: {all: [/code\(\s*409\s*\)/, /candidates/]},
        go: {all: [/StatusConflict|\b409\b/, /candidates/]},
        cpp: {all: [/\b409\b/, /candidates/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Keys an upsert by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required (400) and looked up with `idem_result`/`idemResult` before any write; a replay answers the recorded result and a fresh upsert records its own.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.idem_result\(/, /store\.record_idem\(/],
          order: [/store\.idem_result\(/, /store\.(create_entity|add_aliases)\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /idemResult\(/, /recordIdem\(/],
          order: [/await idemResult\(/, /await (createEntity|addAliases)\(/],
        },
        go: {
          all: [/Idempotency-Key/, /store\.IdemResult\(/, /store\.RecordIdem\(/],
          order: [/store\.IdemResult\(/, /store\.(CreateEntity|AddAliases)\(/],
        },
        cpp: {
          all: [/Idempotency-Key/, /store::idemResult\(/, /store::recordIdem\(/],
          order: [/store::idemResult\(/, /store::(createEntity|addAliases)\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from graph import store  # create_entity, find_alias, add_aliases, get_entity, idem_result, record_idem

app = FastAPI()


def view(entity: dict) -> dict:
    return {"id": entity["id"], "type": entity["type"], "name": entity["name"], "aliases": entity["aliases"]}


@app.post("/v1/entities")
async def upsert_entity(request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    body = await request.json()
    entity_type, name, aliases = body.get("type"), body.get("name"), body.get("aliases", [])
    if not entity_type or not name:
        return JSONResponse({"error": "type and name are required"}, status_code=400)
    owner = store.get_entity(body["merge_into"]) if body.get("merge_into") else None
    for alias in aliases:
        if owner is not None:
            break
        owner = store.find_alias(tenant, alias)
    if owner is not None:
        entity = store.add_aliases(owner["id"], aliases)
        return JSONResponse({**view(entity), "merged": True})
    entity = store.create_entity(tenant, entity_type, name, aliases)
    return JSONResponse({**view(entity), "merged": False}, status_code=201)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from graph import store  # create_entity, find_alias, add_aliases, get_entity, idem_result, record_idem

app = FastAPI()

# Fields a caller may not send: whether two entities become one is the server's decision.
AUTHORITY_FIELDS = ("merge_into", "force", "merge_policy")


def view(entity: dict) -> dict:
    return {"id": entity["id"], "type": entity["type"], "name": entity["name"], "aliases": entity["aliases"]}


@app.post("/v1/entities")
async def upsert_entity(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    key = request.headers.get("idempotency-key", "")
    if not key:
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    recorded = store.idem_result(tenant, key)
    if recorded is not None:
        return JSONResponse(recorded["body"], status_code=recorded["status"])  # a replay answers what the first call answered
    body = await request.json()
    forced = [field for field in AUTHORITY_FIELDS if field in body]
    if forced:
        return JSONResponse({"error": "merge decisions belong to the server", "field": forced[0]}, status_code=400)
    entity_type, name, aliases = body.get("type"), body.get("name"), body.get("aliases", [])
    if not entity_type or not name:
        return JSONResponse({"error": "type and name are required"}, status_code=400)
    owners = [owner for owner in (store.find_alias(tenant, alias) for alias in aliases) if owner is not None]
    clash = next((owner for owner in owners if owner["type"] != entity_type), None)
    if clash is not None:
        # One alias, two kinds of thing: the caller settles it, nothing is written.
        candidates = [view(clash), {"id": None, "type": entity_type, "name": name}]
        return JSONResponse({"error": "alias claimed by an entity of another type", "candidates": candidates}, status_code=409)
    if owners:
        status, entity = 200, store.add_aliases(owners[0]["id"], aliases)
    else:
        status, entity = 201, store.create_entity(tenant, entity_type, name, aliases)
    result = {**view(entity), "merged": status == 200}
    store.record_idem(tenant, key, status, result)
    return JSONResponse(result, status_code=status)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Entity, addAliases, createEntity, findAlias, getEntity, idemResult, recordIdem} from 'graph/store';

export const app = Fastify();

interface UpsertBody {
  type?: string;
  name?: string;
  aliases?: string[];
  merge_into?: string;
}

const view = (entity: Entity) => ({id: entity.id, type: entity.type, name: entity.name, aliases: entity.aliases});

app.post('/v1/entities', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as UpsertBody;
  const {type, name, aliases = []} = body;
  if (!type || !name) return reply.code(400).send({error: 'type and name are required'});
  let owner = body.merge_into ? await getEntity(body.merge_into) : null;
  for (const alias of aliases) {
    if (owner !== null) break;
    owner = await findAlias(tenant, alias);
  }
  if (owner !== null) {
    const entity = await addAliases(owner.id, aliases);
    return {...view(entity), merged: true};
  }
  const entity = await createEntity(tenant, type, name, aliases);
  return reply.code(201).send({...view(entity), merged: false});
});
`,
      solution: `import Fastify from 'fastify';

import {type Entity, addAliases, createEntity, findAlias, getEntity, idemResult, recordIdem} from 'graph/store';

export const app = Fastify();

/** Fields a caller may not send: whether two entities become one is the server's decision. */
const AUTHORITY_FIELDS = ['merge_into', 'force', 'merge_policy'];

interface UpsertBody {
  type?: string;
  name?: string;
  aliases?: string[];
}

const view = (entity: Entity) => ({id: entity.id, type: entity.type, name: entity.name, aliases: entity.aliases});

app.post('/v1/entities', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await idemResult(tenant, key);
  if (recorded !== null) return reply.code(recorded.status).send(recorded.body); // a replay answers what the first call answered
  const body = request.body as UpsertBody;
  const forced = AUTHORITY_FIELDS.find(field => field in body);
  if (forced !== undefined) return reply.code(400).send({error: 'merge decisions belong to the server', field: forced});
  const {type, name, aliases = []} = body;
  if (!type || !name) return reply.code(400).send({error: 'type and name are required'});
  const owners: Entity[] = [];
  for (const alias of aliases) {
    const owner = await findAlias(tenant, alias);
    if (owner !== null) owners.push(owner);
  }
  const clash = owners.find(owner => owner.type !== type);
  if (clash !== undefined) {
    // One alias, two kinds of thing: the caller settles it, nothing is written.
    const candidates = [view(clash), {id: null, type, name}];
    return reply.code(409).send({error: 'alias claimed by an entity of another type', candidates});
  }
  const merged = owners.length > 0;
  const entity = merged ? await addAliases(owners[0].id, aliases) : await createEntity(tenant, type, name, aliases);
  const status = merged ? 200 : 201;
  const result = {...view(entity), merged};
  await recordIdem(tenant, key, status, result);
  return reply.code(status).send(result);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"graph/store" // store.CreateEntity, FindAlias, AddAliases, GetEntity, IdemResult, RecordIdem
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func view(e *store.Entity) map[string]any {
	return map[string]any{"id": e.ID, "type": e.Type, "name": e.Name, "aliases": e.Aliases}
}

func stringsOf(v any) []string {
	out := []string{}
	if list, ok := v.([]any); ok {
		for _, item := range list {
			if s, isString := item.(string); isString {
				out = append(out, s)
			}
		}
	}
	return out
}

func upsertEntity(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	body := map[string]any{}
	json.NewDecoder(r.Body).Decode(&body)
	entityType, _ := body["type"].(string)
	name, _ := body["name"].(string)
	aliases := stringsOf(body["aliases"])
	if entityType == "" || name == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "type and name are required"})
		return
	}
	var owner *store.Entity
	if target, ok := body["merge_into"].(string); ok && target != "" {
		owner = store.GetEntity(r.Context(), target)
	}
	for _, alias := range aliases {
		if owner != nil {
			break
		}
		owner = store.FindAlias(r.Context(), tenant, alias)
	}
	if owner != nil {
		entity, err := store.AddAliases(r.Context(), owner.ID, aliases)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusNotFound)
			return
		}
		result := view(entity)
		result["merged"] = true
		writeJSON(rw, http.StatusOK, result)
		return
	}
	result := view(store.CreateEntity(r.Context(), tenant, entityType, name, aliases))
	result["merged"] = false
	writeJSON(rw, http.StatusCreated, result)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/entities", upsertEntity)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"graph/store" // store.CreateEntity, FindAlias, AddAliases, GetEntity, IdemResult, RecordIdem
)

// authorityFields a caller may not send: whether two entities become one is the server's decision.
var authorityFields = []string{"merge_into", "force", "merge_policy"}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func view(e *store.Entity) map[string]any {
	return map[string]any{"id": e.ID, "type": e.Type, "name": e.Name, "aliases": e.Aliases}
}

func stringsOf(v any) []string {
	out := []string{}
	if list, ok := v.([]any); ok {
		for _, item := range list {
			if s, isString := item.(string); isString {
				out = append(out, s)
			}
		}
	}
	return out
}

func upsertEntity(rw http.ResponseWriter, r *http.Request) {
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
	if recorded := store.IdemResult(r.Context(), tenant, key); recorded != nil {
		writeJSON(rw, recorded.Status, recorded.Body) // a replay answers what the first call answered
		return
	}
	body := map[string]any{}
	json.NewDecoder(r.Body).Decode(&body)
	for _, field := range authorityFields {
		if _, forced := body[field]; forced {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "merge decisions belong to the server", "field": field})
			return
		}
	}
	entityType, _ := body["type"].(string)
	name, _ := body["name"].(string)
	aliases := stringsOf(body["aliases"])
	if entityType == "" || name == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "type and name are required"})
		return
	}
	owners := []*store.Entity{}
	for _, alias := range aliases {
		if owner := store.FindAlias(r.Context(), tenant, alias); owner != nil {
			owners = append(owners, owner)
		}
	}
	for _, owner := range owners {
		if owner.Type != entityType {
			// One alias, two kinds of thing: the caller settles it, nothing is written.
			candidates := []any{view(owner), map[string]any{"id": nil, "type": entityType, "name": name}}
			writeJSON(rw, http.StatusConflict, map[string]any{"error": "alias claimed by an entity of another type", "candidates": candidates})
			return
		}
	}
	status := http.StatusCreated
	entity := &store.Entity{}
	if len(owners) > 0 {
		grown, err := store.AddAliases(r.Context(), owners[0].ID, aliases)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusNotFound)
			return
		}
		entity = grown
		status = http.StatusOK
	} else {
		entity = store.CreateEntity(r.Context(), tenant, entityType, name, aliases)
	}
	result := view(entity)
	result["merged"] = status == http.StatusOK
	store.RecordIdem(r.Context(), tenant, key, status, result)
	writeJSON(rw, status, result)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/entities", upsertEntity)
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "graph/store.h"  // store::createEntity, findAlias, addAliases, getEntity, idemResult, recordIdem

using json = nlohmann::json;

json view(const store::Entity& e) { return json{{"id", e.id}, {"type", e.type}, {"name", e.name}, {"aliases", e.aliases}}; }

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void upsert_entity(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, json{{"error", "the body must be a JSON object"}});
  const std::string type = body.value("type", "");
  const std::string name = body.value("name", "");
  const std::vector<std::string> aliases = body.value("aliases", std::vector<std::string>{});
  if (type.empty() || name.empty()) return reply(res, 400, json{{"error", "type and name are required"}});
  std::optional<store::Entity> owner;
  const std::string target = body.value("merge_into", "");
  if (!target.empty()) owner = store::getEntity(target);
  for (const std::string& alias : aliases) {
    if (owner) break;
    owner = store::findAlias(tenant, alias);
  }
  if (owner) {
    json result = view(store::addAliases(owner->id, aliases));
    result["merged"] = true;
    return reply(res, 200, result);
  }
  json result = view(store::createEntity(tenant, type, name, aliases));
  result["merged"] = false;
  reply(res, 201, result);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/entities", upsert_entity); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "graph/store.h"  // store::createEntity, findAlias, addAliases, getEntity, idemResult, recordIdem

using json = nlohmann::json;

// Fields a caller may not send: whether two entities become one is the server's decision.
const std::vector<std::string> kAuthorityFields = {"merge_into", "force", "merge_policy"};

json view(const store::Entity& e) { return json{{"id", e.id}, {"type", e.type}, {"name", e.name}, {"aliases", e.aliases}}; }

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void upsert_entity(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, json{{"error", "Idempotency-Key is required"}});
  if (const auto recorded = store::idemResult(tenant, key)) {
    return reply(res, recorded->value("status", 200), recorded->at("body"));  // a replay answers what the first call answered
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, json{{"error", "the body must be a JSON object"}});
  for (const std::string& field : kAuthorityFields) {
    if (body.contains(field)) return reply(res, 400, json{{"error", "merge decisions belong to the server"}, {"field", field}});
  }
  const std::string type = body.value("type", "");
  const std::string name = body.value("name", "");
  const std::vector<std::string> aliases = body.value("aliases", std::vector<std::string>{});
  if (type.empty() || name.empty()) return reply(res, 400, json{{"error", "type and name are required"}});
  std::vector<store::Entity> owners;
  for (const std::string& alias : aliases) {
    if (const auto owner = store::findAlias(tenant, alias)) owners.push_back(*owner);
  }
  for (const store::Entity& owner : owners) {
    if (owner.type == type) continue;
    // One alias, two kinds of thing: the caller settles it, nothing is written.
    const json candidates = json::array({view(owner), json{{"id", nullptr}, {"type", type}, {"name", name}}});
    return reply(res, 409, json{{"error", "alias claimed by an entity of another type"}, {"candidates", candidates}});
  }
  const bool merged = !owners.empty();
  const store::Entity entity = merged ? store::addAliases(owners[0].id, aliases) : store::createEntity(tenant, type, name, aliases);
  const int status = merged ? 200 : 201;
  json result = view(entity);
  result["merged"] = merged;
  store::recordIdem(tenant, key, status, result);
  reply(res, status, result);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/entities", upsert_entity); }
`,
    },
  },
  harness: {
    python: `from graph import store


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _headers(key, tenant="t1"):
    return {"X-Tenant-Id": tenant, "Idempotency-Key": key}


async def _create(c, key, body):
    r = await c.post("/v1/entities", json=body, headers=_headers(key))
    assert r.status_code == 201, f"POST /v1/entities {body} answered {r.status_code}: {r.text}"
    return r.json()["id"]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/entities", json={"type": "person", "name": "Ada Lovelace", "aliases": ["Ada", "A. Lovelace"]}, headers=_headers("k-1"))
        assert r.status_code == 201, f"POST /v1/entities answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("merged") is False and body.get("aliases") == ["a. lovelace", "ada"], f"a new entity must answer merged false with its aliases, got {body}"
        stored = store.get_entity(body["id"])
        assert stored is not None and stored["tenant"] == "t1" and stored["type"] == "person", f"the store holds {stored} for {body['id']}"
        r = await c.post("/v1/entities", json={"type": "person", "name": "Augusta Ada King", "aliases": ["ada", "Augusta King"]}, headers=_headers("k-2"))
        assert r.status_code == 200 and r.json().get("id") == body["id"] and r.json().get("merged") is True, f"an alias the same person already claims must extend that entity (200, merged true), got {r.status_code} {r.text}"
        assert "augusta king" in store.get_entity(body["id"])["aliases"], f"the new alias must be claimed by {body['id']}: {store.get_entity(body['id'])}"
        r = await c.post("/v1/entities", json={"type": "person", "name": "Grace Hopper"}, headers={"Idempotency-Key": "k-3"})
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_merge_policy(ctx):
    async with _api(ctx) as c:
        ada = await _create(c, "k-1", {"type": "person", "name": "Ada Lovelace", "aliases": ["ada"]})
        r = await c.post("/v1/entities", json={"type": "person", "name": "Grace Hopper", "aliases": ["grace"], "merge_into": ada}, headers=_headers("k-2"))
        assert r.status_code == 400, f"a body naming merge_into answered {r.status_code} {r.text}: the caller folded Grace Hopper into Ada Lovelace. Whether two entities become one is the server's decision; refuse the field with 400"
        assert "merge_into" in r.text, f"the 400 must name the refused field, got {r.text}"
        assert store.get_entity(ada)["aliases"] == ["ada"], f"the refused request changed {ada}: {store.get_entity(ada)}"
        assert store.find_alias("t1", "grace") is None, "the refused request must write nothing, yet the alias grace is claimed"
        r = await c.post("/v1/entities", json={"type": "person", "name": "Grace Hopper", "aliases": ["grace"], "force": True}, headers=_headers("k-3"))
        assert r.status_code == 400, f"a body carrying force answered {r.status_code}, expected 400"
        r = await c.post("/v1/entities", json={"type": "person", "name": "Grace Hopper", "aliases": ["grace"], "merge_policy": "auto"}, headers=_headers("k-5"))
        assert r.status_code == 400 and "merge_policy" in r.text, f"a body carrying merge_policy answered {r.status_code} {r.text}, expected 400 naming merge_policy: every AUTHORITY_FIELDS key is refused"
        r = await c.post("/v1/entities", json={"type": "person", "name": "Grace Hopper", "aliases": ["grace"], "force": False}, headers=_headers("k-6"))
        assert r.status_code == 400, f"a body carrying force false answered {r.status_code} {r.text}, expected 400: a body carrying the field is refused whatever its value"
        assert store.find_alias("t1", "grace") is None, "a refused request must write nothing, yet the alias grace is claimed"
        r = await c.post("/v1/entities", json={"type": "person", "name": "Grace Hopper", "aliases": ["grace"]}, headers=_headers("k-4"))
    assert r.status_code == 201, f"the same entity without authority fields answered {r.status_code}: {r.text}"


async def check_cross_type_409(ctx):
    async with _api(ctx) as c:
        person = await _create(c, "k-1", {"type": "person", "name": "Jordan Reyes", "aliases": ["jordan"]})
        r = await c.post("/v1/entities", json={"type": "company", "name": "Jordan Ltd", "aliases": ["Jordan", "Jordan Ltd"]}, headers=_headers("k-2"))
        assert r.status_code == 409, f"a company claiming the alias of a person answered {r.status_code} {r.text}: the company was folded into the person. A cross-type collision is 409"
        candidates = r.json().get("candidates") or []
        assert person in [c.get("id") for c in candidates] and sorted(c.get("type") for c in candidates) == ["company", "person"], f"the 409 must name both candidates (the person {person} and the proposed company), got {r.text}"
    stored = store.get_entity(person)
    assert stored["aliases"] == ["jordan"] and stored["type"] == "person", f"the 409 must write nothing, yet {person} is now {stored}"
    assert store.find_alias("t1", "jordan ltd") is None, "the 409 must write nothing, yet the alias jordan ltd is claimed"
    assert ctx.redis.get("entity:seq") == "1", f"the 409 must create nothing, yet {ctx.redis.get('entity:seq')} entities exist"
    async with _api(ctx) as c:
        acme = await _create(c, "k-3", {"type": "company", "name": "Acme", "aliases": ["acme"]})
        r = await c.post("/v1/entities", json={"type": "company", "name": "Acme Jordan", "aliases": ["Acme", "Jordan"]}, headers=_headers("k-4"))
    assert r.status_code == 409, f"a company whose first alias belongs to a company and whose second belongs to a person answered {r.status_code} {r.text}: every alias is checked, a cross-type claimant on any of them is 409"
    assert store.get_entity(acme)["aliases"] == ["acme"] and store.find_alias("t1", "jordan")["id"] == person, f"the 409 must write nothing, yet {acme} holds {store.get_entity(acme)['aliases']} and jordan is claimed by {store.find_alias('t1', 'jordan')['id']}"


async def check_idempotency(ctx):
    async with _api(ctx) as c:
        body = {"type": "person", "name": "Ada Lovelace"}
        first = await c.post("/v1/entities", json=body, headers=_headers("k-1"))
        assert first.status_code == 201, f"the first upsert answered {first.status_code}: {first.text}"
        replay = await c.post("/v1/entities", json=body, headers=_headers("k-1"))
        assert replay.status_code == 201 and replay.json() == first.json(), f"a replay of Idempotency-Key k-1 must answer what the first call answered: first {first.status_code} {first.text}, replay {replay.status_code} {replay.text}"
        assert ctx.redis.get("entity:seq") == "1", f"a retried upsert created {ctx.redis.get('entity:seq')} entities: look (tenant, key) up before writing"
        other = await c.post("/v1/entities", json=body, headers=_headers("k-1", tenant="t2"))
        assert other.status_code == 201 and other.json().get("id") != first.json().get("id"), f"the same key from another tenant is another request, got {other.status_code} {other.text}"
        none = await c.post("/v1/entities", json=body, headers={"X-Tenant-Id": "t1"})
    assert none.status_code == 400, f"an upsert without Idempotency-Key answered {none.status_code}, expected 400"
`,
    typescript: `function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/graph/store.ts')};
}

const headers = (key: string, tenant = 't1') => ({'X-Tenant-Id': tenant, 'Idempotency-Key': key});

async function create(c, key: string, body): Promise<string> {
  const r = await c.post('/v1/entities', {json: body, headers: headers(key)});
  assert.equal(r.status, 201, \`POST /v1/entities \${JSON.stringify(body)} answered \${r.status}: \${r.text}\`);
  return r.json().id;
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  let r = await c.post('/v1/entities', {json: {type: 'person', name: 'Ada Lovelace', aliases: ['Ada', 'A. Lovelace']}, headers: headers('k-1')});
  assert.equal(r.status, 201, \`POST /v1/entities answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.merged === false && JSON.stringify(body.aliases) === '["a. lovelace","ada"]', \`a new entity must answer merged false with its aliases, got \${r.text}\`);
  const stored = await store.getEntity(body.id);
  assert(stored !== null && stored.tenant === 't1' && stored.type === 'person', \`the store holds \${JSON.stringify(stored)} for \${body.id}\`);
  r = await c.post('/v1/entities', {json: {type: 'person', name: 'Augusta Ada King', aliases: ['ada', 'Augusta King']}, headers: headers('k-2')});
  assert(r.status === 200 && r.json().id === body.id && r.json().merged === true, \`an alias the same person already claims must extend that entity (200, merged true), got \${r.status} \${r.text}\`);
  assert((await store.getEntity(body.id)).aliases.includes('augusta king'), \`the new alias must be claimed by \${body.id}\`);
  r = await c.post('/v1/entities', {json: {type: 'person', name: 'Grace Hopper'}, headers: {'Idempotency-Key': 'k-3'}});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_merge_policy(ctx) {
  const {c, store} = api(ctx);
  const ada = await create(c, 'k-1', {type: 'person', name: 'Ada Lovelace', aliases: ['ada']});
  let r = await c.post('/v1/entities', {json: {type: 'person', name: 'Grace Hopper', aliases: ['grace'], merge_into: ada}, headers: headers('k-2')});
  assert.equal(r.status, 400, \`a body naming merge_into answered \${r.status} \${r.text}: the caller folded Grace Hopper into Ada Lovelace. Whether two entities become one is the server's decision; refuse the field with 400\`);
  assert(r.text.includes('merge_into'), \`the 400 must name the refused field, got \${r.text}\`);
  assert.deepEqual((await store.getEntity(ada)).aliases, ['ada'], \`the refused request changed \${ada}\`);
  assert.equal(await store.findAlias('t1', 'grace'), null, 'the refused request must write nothing, yet the alias grace is claimed');
  r = await c.post('/v1/entities', {json: {type: 'person', name: 'Grace Hopper', aliases: ['grace'], force: true}, headers: headers('k-3')});
  assert.equal(r.status, 400, \`a body carrying force answered \${r.status}, expected 400\`);
  r = await c.post('/v1/entities', {json: {type: 'person', name: 'Grace Hopper', aliases: ['grace'], merge_policy: 'auto'}, headers: headers('k-5')});
  assert(r.status === 400 && r.text.includes('merge_policy'), \`a body carrying merge_policy answered \${r.status} \${r.text}, expected 400 naming merge_policy: every AUTHORITY_FIELDS key is refused\`);
  r = await c.post('/v1/entities', {json: {type: 'person', name: 'Grace Hopper', aliases: ['grace'], force: false}, headers: headers('k-6')});
  assert.equal(r.status, 400, \`a body carrying force false answered \${r.status} \${r.text}, expected 400: a body carrying the field is refused whatever its value\`);
  assert.equal(await store.findAlias('t1', 'grace'), null, 'a refused request must write nothing, yet the alias grace is claimed');
  r = await c.post('/v1/entities', {json: {type: 'person', name: 'Grace Hopper', aliases: ['grace']}, headers: headers('k-4')});
  assert.equal(r.status, 201, \`the same entity without authority fields answered \${r.status}: \${r.text}\`);
}

export async function check_cross_type_409(ctx) {
  const {c, store} = api(ctx);
  const person = await create(c, 'k-1', {type: 'person', name: 'Jordan Reyes', aliases: ['jordan']});
  const r = await c.post('/v1/entities', {json: {type: 'company', name: 'Jordan Ltd', aliases: ['Jordan', 'Jordan Ltd']}, headers: headers('k-2')});
  assert.equal(r.status, 409, \`a company claiming the alias of a person answered \${r.status} \${r.text}: the company was folded into the person. A cross-type collision is 409\`);
  const candidates = r.json().candidates ?? [];
  const types = candidates.map(c => c.type).sort();
  assert(candidates.some(c => c.id === person) && JSON.stringify(types) === '["company","person"]', \`the 409 must name both candidates (the person \${person} and the proposed company), got \${r.text}\`);
  const stored = await store.getEntity(person);
  assert(JSON.stringify(stored.aliases) === '["jordan"]' && stored.type === 'person', \`the 409 must write nothing, yet \${person} is now \${JSON.stringify(stored)}\`);
  assert.equal(await store.findAlias('t1', 'jordan ltd'), null, 'the 409 must write nothing, yet the alias jordan ltd is claimed');
  assert.equal(ctx.redis.get('entity:seq'), '1', \`the 409 must create nothing, yet \${ctx.redis.get('entity:seq')} entities exist\`);
  const acme = await create(c, 'k-3', {type: 'company', name: 'Acme', aliases: ['acme']});
  const mixed = await c.post('/v1/entities', {json: {type: 'company', name: 'Acme Jordan', aliases: ['Acme', 'Jordan']}, headers: headers('k-4')});
  assert.equal(mixed.status, 409, \`a company whose first alias belongs to a company and whose second belongs to a person answered \${mixed.status} \${mixed.text}: every alias is checked, a cross-type claimant on any of them is 409\`);
  const acmeAliases = (await store.getEntity(acme)).aliases;
  const jordan = (await store.findAlias('t1', 'jordan'))?.id;
  assert(JSON.stringify(acmeAliases) === '["acme"]' && jordan === person, \`the 409 must write nothing, yet \${acme} holds \${JSON.stringify(acmeAliases)} and jordan is claimed by \${jordan}\`);
}

export async function check_idempotency(ctx) {
  const {c} = api(ctx);
  const body = {type: 'person', name: 'Ada Lovelace'};
  const first = await c.post('/v1/entities', {json: body, headers: headers('k-1')});
  assert.equal(first.status, 201, \`the first upsert answered \${first.status}: \${first.text}\`);
  const replay = await c.post('/v1/entities', {json: body, headers: headers('k-1')});
  assert(replay.status === 201 && JSON.stringify(replay.json()) === JSON.stringify(first.json()), \`a replay of Idempotency-Key k-1 must answer what the first call answered: first \${first.status} \${first.text}, replay \${replay.status} \${replay.text}\`);
  assert.equal(ctx.redis.get('entity:seq'), '1', \`a retried upsert created \${ctx.redis.get('entity:seq')} entities: look (tenant, key) up before writing\`);
  const other = await c.post('/v1/entities', {json: body, headers: headers('k-1', 't2')});
  assert(other.status === 201 && other.json().id !== first.json().id, \`the same key from another tenant is another request, got \${other.status} \${other.text}\`);
  const none = await c.post('/v1/entities', {json: body, headers: {'X-Tenant-Id': 't1'}});
  assert.equal(none.status, 400, \`an upsert without Idempotency-Key answered \${none.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"graph/store"

	"leetbuild/harness"
)

var hApiBg = context.Background()

type HUpserted struct {
	ID      string   \`json:"id"\`
	Type    string   \`json:"type"\`
	Aliases []string \`json:"aliases"\`
	Merged  bool     \`json:"merged"\`
	Error   string   \`json:"error"\`
	Candidates []struct {
		ID   any    \`json:"id"\`
		Type string \`json:"type"\`
	} \`json:"candidates"\`
}

func hApi(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func hUpsert(c *harness.HTTP, key string, body map[string]any) *harness.Response {
	return c.Post("/v1/entities", body, "X-Tenant-Id", "t1", "Idempotency-Key", key)
}

func hDecoded(r *harness.Response) HUpserted {
	out := HUpserted{}
	r.Decode(&out)
	return out
}

func hCreate(ctx *harness.Ctx, c *harness.HTTP, key string, body map[string]any) string {
	r := hUpsert(c, key, body)
	ctx.Equal(r.Status, 201, "POST /v1/entities %v (%s)", body, r.Text())
	return hDecoded(r).ID
}

func hSeq(ctx *harness.Ctx) string {
	n, _ := ctx.Redis.Get("entity:seq")
	return n
}

func CheckRoute(ctx *harness.Ctx) {
	c := hApi(ctx)
	r := hUpsert(c, "k-1", map[string]any{"type": "person", "name": "Ada Lovelace", "aliases": []string{"Ada", "A. Lovelace"}})
	ctx.Equal(r.Status, 201, "POST /v1/entities (%s)", r.Text())
	first := hDecoded(r)
	ctx.Assert(!first.Merged && strings.Join(first.Aliases, ",") == "a. lovelace,ada", "a new entity must answer merged false with its aliases, got %s", r.Text())
	stored := store.GetEntity(hApiBg, first.ID)
	ctx.Assert(stored != nil && stored.Tenant == "t1" && stored.Type == "person", "the store holds %+v for %s", stored, first.ID)
	r = hUpsert(c, "k-2", map[string]any{"type": "person", "name": "Augusta Ada King", "aliases": []string{"ada", "Augusta King"}})
	again := hDecoded(r)
	ctx.Assert(r.Status == 200 && again.ID == first.ID && again.Merged, "an alias the same person already claims must extend that entity (200, merged true), got %d %s", r.Status, r.Text())
	ctx.Assert(strings.Contains(strings.Join(store.GetEntity(hApiBg, first.ID).Aliases, ","), "augusta king"), "the new alias must be claimed by %s", first.ID)
	r = c.Post("/v1/entities", map[string]any{"type": "person", "name": "Grace Hopper"}, "Idempotency-Key", "k-3")
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
}

func CheckMergePolicy(ctx *harness.Ctx) {
	c := hApi(ctx)
	ada := hCreate(ctx, c, "k-1", map[string]any{"type": "person", "name": "Ada Lovelace", "aliases": []string{"ada"}})
	r := hUpsert(c, "k-2", map[string]any{"type": "person", "name": "Grace Hopper", "aliases": []string{"grace"}, "merge_into": ada})
	ctx.Assert(r.Status == 400, "a body naming merge_into answered %d %s: the caller folded Grace Hopper into Ada Lovelace. Whether two entities become one is the server's decision; refuse the field with 400", r.Status, r.Text())
	ctx.Assert(strings.Contains(r.Text(), "merge_into"), "the 400 must name the refused field, got %s", r.Text())
	ctx.Equal(store.GetEntity(hApiBg, ada).Aliases, []string{"ada"}, "the refused request must not change %s; its aliases", ada)
	ctx.Assert(store.FindAlias(hApiBg, "t1", "grace") == nil, "the refused request must write nothing, yet the alias grace is claimed")
	r = hUpsert(c, "k-3", map[string]any{"type": "person", "name": "Grace Hopper", "aliases": []string{"grace"}, "force": true})
	ctx.Equal(r.Status, 400, "a body carrying force")
	r = hUpsert(c, "k-5", map[string]any{"type": "person", "name": "Grace Hopper", "aliases": []string{"grace"}, "merge_policy": "auto"})
	ctx.Assert(r.Status == 400 && strings.Contains(r.Text(), "merge_policy"), "a body carrying merge_policy answered %d %s, expected 400 naming merge_policy: every authorityFields key is refused", r.Status, r.Text())
	r = hUpsert(c, "k-6", map[string]any{"type": "person", "name": "Grace Hopper", "aliases": []string{"grace"}, "force": false})
	ctx.Assert(r.Status == 400, "a body carrying force false answered %d %s, expected 400: a body carrying the field is refused whatever its value", r.Status, r.Text())
	ctx.Assert(store.FindAlias(hApiBg, "t1", "grace") == nil, "a refused request must write nothing, yet the alias grace is claimed")
	r = hUpsert(c, "k-4", map[string]any{"type": "person", "name": "Grace Hopper", "aliases": []string{"grace"}})
	ctx.Equal(r.Status, 201, "the same entity without authority fields (%s)", r.Text())
}

func CheckCrossType409(ctx *harness.Ctx) {
	c := hApi(ctx)
	person := hCreate(ctx, c, "k-1", map[string]any{"type": "person", "name": "Jordan Reyes", "aliases": []string{"jordan"}})
	r := hUpsert(c, "k-2", map[string]any{"type": "company", "name": "Jordan Ltd", "aliases": []string{"Jordan", "Jordan Ltd"}})
	ctx.Assert(r.Status == 409, "a company claiming the alias of a person answered %d %s: the company was folded into the person. A cross-type collision is 409", r.Status, r.Text())
	named, types := false, []string{}
	for _, candidate := range hDecoded(r).Candidates {
		if id, ok := candidate.ID.(string); ok && id == person {
			named = true
		}
		types = append(types, candidate.Type)
	}
	ctx.Assert(named && len(types) == 2 && ((types[0] == "person" && types[1] == "company") || (types[0] == "company" && types[1] == "person")), "the 409 must name both candidates (the person %s and the proposed company), got %s", person, r.Text())
	stored := store.GetEntity(hApiBg, person)
	ctx.Assert(strings.Join(stored.Aliases, ",") == "jordan" && stored.Type == "person", "the 409 must write nothing, yet %s is now %+v", person, stored)
	ctx.Assert(store.FindAlias(hApiBg, "t1", "jordan ltd") == nil, "the 409 must write nothing, yet the alias jordan ltd is claimed")
	ctx.Equal(hSeq(ctx), "1", "the 409 must create nothing; the entities that exist")
	acme := hCreate(ctx, c, "k-3", map[string]any{"type": "company", "name": "Acme", "aliases": []string{"acme"}})
	r = hUpsert(c, "k-4", map[string]any{"type": "company", "name": "Acme Jordan", "aliases": []string{"Acme", "Jordan"}})
	ctx.Assert(r.Status == 409, "a company whose first alias belongs to a company and whose second belongs to a person answered %d %s: every alias is checked, a cross-type claimant on any of them is 409", r.Status, r.Text())
	acmeAliases := strings.Join(store.GetEntity(hApiBg, acme).Aliases, ",")
	jordan := ""
	if claimant := store.FindAlias(hApiBg, "t1", "jordan"); claimant != nil {
		jordan = claimant.ID
	}
	ctx.Assert(acmeAliases == "acme" && jordan == person, "the 409 must write nothing, yet %s holds %s and jordan is claimed by %s", acme, acmeAliases, jordan)
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := hApi(ctx)
	body := map[string]any{"type": "person", "name": "Ada Lovelace"}
	first := hUpsert(c, "k-1", body)
	ctx.Equal(first.Status, 201, "the first upsert (%s)", first.Text())
	replay := hUpsert(c, "k-1", body)
	ctx.Assert(replay.Status == 201 && hDecoded(replay).ID == hDecoded(first).ID, "a replay of Idempotency-Key k-1 must answer what the first call answered: first %d %s, replay %d %s", first.Status, first.Text(), replay.Status, replay.Text())
	ctx.Equal(hSeq(ctx), "1", "a retried upsert must not create a second entity (look (tenant, key) up before writing); the entities that exist")
	other := c.Post("/v1/entities", body, "X-Tenant-Id", "t2", "Idempotency-Key", "k-1")
	ctx.Assert(other.Status == 201 && hDecoded(other).ID != hDecoded(first).ID, "the same key from another tenant is another request, got %d %s", other.Status, other.Text())
	none := c.Post("/v1/entities", body, "X-Tenant-Id", "t1")
	ctx.Equal(none.Status, 400, "an upsert without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

namespace {

harness::HTTP hApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response hUpsert(harness::HTTP& c, const std::string& key, const nlohmann::json& body, const std::string& tenant = "t1") {
  return c.Post("/v1/entities", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json hBodyOf(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::string hIdOf(const harness::Response& r) {
  const auto body = hBodyOf(r);
  return body.is_object() && body.contains("id") && body["id"].is_string() ? body["id"].get<std::string>() : "";
}

std::string hCreate(harness::Ctx& ctx, harness::HTTP& c, const std::string& key, const nlohmann::json& body) {
  const auto r = hUpsert(c, key, body);
  ctx.Equal(r.Status, 201, "POST /v1/entities %s (%s)", body.dump(), r.Text());
  return hIdOf(r);
}

std::string hJoined(const std::vector<std::string>& items) {
  std::string out;
  for (const auto& item : items) out += (out.empty() ? "" : ",") + item;
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  auto r = hUpsert(c, "k-1", {{"type", "person"}, {"name", "Ada Lovelace"}, {"aliases", {"Ada", "A. Lovelace"}}});
  ctx.Equal(r.Status, 201, "POST /v1/entities (%s)", r.Text());
  const auto first = hBodyOf(r);
  ctx.Assert(first.value("merged", true) == false && first.value("aliases", std::vector<std::string>{}) == std::vector<std::string>{"a. lovelace", "ada"},
             "a new entity must answer merged false with its aliases, got %s", r.Text());
  const std::string id = hIdOf(r);
  const auto stored = store::getEntity(id);
  ctx.Assert(stored && stored->tenant == "t1" && stored->type == "person", "the store must hold %s as a person of t1", id);
  r = hUpsert(c, "k-2", {{"type", "person"}, {"name", "Augusta Ada King"}, {"aliases", {"ada", "Augusta King"}}});
  ctx.Assert(r.Status == 200 && hIdOf(r) == id && hBodyOf(r).value("merged", false), "an alias the same person already claims must extend that entity (200, merged true), got %d %s", r.Status, r.Text());
  const auto aliases = store::getEntity(id)->aliases;
  ctx.Assert(std::find(aliases.begin(), aliases.end(), "augusta king") != aliases.end(), "the new alias must be claimed by %s, it holds %s", id, hJoined(aliases));
  r = c.Post("/v1/entities", R"({"type": "person", "name": "Grace Hopper"})", "Content-Type", "application/json", "Idempotency-Key", "k-3");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
}

void CheckMergePolicy(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const std::string ada = hCreate(ctx, c, "k-1", {{"type", "person"}, {"name", "Ada Lovelace"}, {"aliases", {"ada"}}});
  auto r = hUpsert(c, "k-2", {{"type", "person"}, {"name", "Grace Hopper"}, {"aliases", {"grace"}}, {"merge_into", ada}});
  ctx.Assert(r.Status == 400, "a body naming merge_into answered %d %s: the caller folded Grace Hopper into Ada Lovelace. Whether two entities become one is the server's decision; refuse the field with 400", r.Status, r.Text());
  ctx.Assert(r.Text().find("merge_into") != std::string::npos, "the 400 must name the refused field, got %s", r.Text());
  ctx.Equal(hJoined(store::getEntity(ada)->aliases), "ada", "the refused request must not change %s; its aliases", ada);
  ctx.Assert(!store::findAlias("t1", "grace"), "the refused request must write nothing, yet the alias grace is claimed");
  r = hUpsert(c, "k-3", {{"type", "person"}, {"name", "Grace Hopper"}, {"aliases", {"grace"}}, {"force", true}});
  ctx.Equal(r.Status, 400, "a body carrying force");
  r = hUpsert(c, "k-5", {{"type", "person"}, {"name", "Grace Hopper"}, {"aliases", {"grace"}}, {"merge_policy", "auto"}});
  ctx.Assert(r.Status == 400 && r.Text().find("merge_policy") != std::string::npos, "a body carrying merge_policy answered %d %s, expected 400 naming merge_policy: every kAuthorityFields key is refused", r.Status, r.Text());
  r = hUpsert(c, "k-6", {{"type", "person"}, {"name", "Grace Hopper"}, {"aliases", {"grace"}}, {"force", false}});
  ctx.Assert(r.Status == 400, "a body carrying force false answered %d %s, expected 400: a body carrying the field is refused whatever its value", r.Status, r.Text());
  ctx.Assert(!store::findAlias("t1", "grace"), "a refused request must write nothing, yet the alias grace is claimed");
  r = hUpsert(c, "k-4", {{"type", "person"}, {"name", "Grace Hopper"}, {"aliases", {"grace"}}});
  ctx.Equal(r.Status, 201, "the same entity without authority fields (%s)", r.Text());
}

void CheckCrossType409(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const std::string person = hCreate(ctx, c, "k-1", {{"type", "person"}, {"name", "Jordan Reyes"}, {"aliases", {"jordan"}}});
  const auto r = hUpsert(c, "k-2", {{"type", "company"}, {"name", "Jordan Ltd"}, {"aliases", {"Jordan", "Jordan Ltd"}}});
  ctx.Assert(r.Status == 409, "a company claiming the alias of a person answered %d %s: the company was folded into the person. A cross-type collision is 409", r.Status, r.Text());
  const auto body = hBodyOf(r);
  bool named = false;
  std::vector<std::string> types;
  if (body.is_object() && body.contains("candidates") && body["candidates"].is_array()) {
    for (const auto& candidate : body["candidates"]) {
      if (candidate.contains("id") && candidate["id"].is_string() && candidate["id"].get<std::string>() == person) named = true;
      types.push_back(candidate.value("type", ""));
    }
  }
  std::sort(types.begin(), types.end());
  ctx.Assert(named && types == std::vector<std::string>{"company", "person"}, "the 409 must name both candidates (the person %s and the proposed company), got %s", person, r.Text());
  const auto stored = store::getEntity(person);
  ctx.Assert(hJoined(stored->aliases) == "jordan" && stored->type == "person", "the 409 must write nothing, yet %s now holds the aliases %s as a %s", person, hJoined(stored->aliases), stored->type);
  ctx.Assert(!store::findAlias("t1", "jordan ltd"), "the 409 must write nothing, yet the alias jordan ltd is claimed");
  ctx.Equal(ctx.Redis.Get("entity:seq").value_or(""), "1", "the 409 must create nothing; the entities that exist");
  const std::string acme = hCreate(ctx, c, "k-3", {{"type", "company"}, {"name", "Acme"}, {"aliases", {"acme"}}});
  const auto mixed = hUpsert(c, "k-4", {{"type", "company"}, {"name", "Acme Jordan"}, {"aliases", {"Acme", "Jordan"}}});
  ctx.Assert(mixed.Status == 409, "a company whose first alias belongs to a company and whose second belongs to a person answered %d %s: every alias is checked, a cross-type claimant on any of them is 409", mixed.Status, mixed.Text());
  const std::string acmeAliases = hJoined(store::getEntity(acme)->aliases);
  const auto claimant = store::findAlias("t1", "jordan");
  const std::string jordan = claimant ? claimant->id : "";
  ctx.Assert(acmeAliases == "acme" && jordan == person, "the 409 must write nothing, yet %s holds %s and jordan is claimed by %s", acme, acmeAliases, jordan);
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = hApi(ctx);
  const nlohmann::json body = {{"type", "person"}, {"name", "Ada Lovelace"}};
  const auto first = hUpsert(c, "k-1", body);
  ctx.Equal(first.Status, 201, "the first upsert (%s)", first.Text());
  const auto replay = hUpsert(c, "k-1", body);
  ctx.Assert(replay.Status == 201 && hBodyOf(replay) == hBodyOf(first), "a replay of Idempotency-Key k-1 must answer what the first call answered: first %d %s, replay %d %s", first.Status, first.Text(), replay.Status, replay.Text());
  ctx.Equal(ctx.Redis.Get("entity:seq").value_or(""), "1", "a retried upsert must not create a second entity (look (tenant, key) up before writing); the entities that exist");
  const auto other = hUpsert(c, "k-1", body, "t2");
  ctx.Assert(other.Status == 201 && hIdOf(other) != hIdOf(first), "the same key from another tenant is another request, got %d %s", other.Status, other.Text());
  const auto none = c.Post("/v1/entities", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(none.Status, 400, "an upsert without Idempotency-Key");
}
`,
  },
  hints: [
    'Send a person with `merge_into` naming another person, then a company that shares an alias with a person, then the same create twice with one key: each call changes the graph in a way nobody approved.',
    'The starter trusts the body to pick a merge target, treats any alias hit as the same entity whatever its type, and never reads `Idempotency-Key`, so each retry runs the create again.',
    'Answer 400 when the body has any `AUTHORITY_FIELDS` key; 409 with `candidates` when an alias owner has another type; read `store.idem_result(tenant, key)` first, answer it when present, else write and `store.record_idem`.',
  ],
  debrief: `Moving the merge decision to the server is a trust boundary: the body describes an entity, and only evidence the server can check (an alias the same kind of entity already claims) folds it into another. The type check is the cheapest evidence there is, and a 409 that names both candidates hands the ambiguous case to someone who can settle it instead of guessing. The idempotency record is keyed by tenant so one tenant's key cannot answer another's request. A production graph keeps the recorded answer next to a hash of the request body so a reused key with a different body is refused, and logs every merge with the evidence that triggered it so a bad one can be split again.`,
};
