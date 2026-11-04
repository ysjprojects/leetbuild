import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/flags: a flag is a rule set with a schema',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/flags\` with body \`{"key": "checkout", "default":
false, "rules": [{"attribute": "country", "operator": "eq", "value": "US"}], "rollout": 25}\`: it checks
the key pattern and the rollout range, stores the flag through \`store.save\` (\`flags.store\`,
provided) and answers **201** \`{key, version}\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** A rule on an attribute the registry does not know, or with an
operator its type does not have, is stored and silently never matches. A flag created without a
default serves \`false\` to everyone without anyone choosing it. A client that times out and retries
its create forks the flag into a second version.

- Every rule passes \`registry.rule_error(rule)\` (\`flags.registry\`); a refused rule is **422** with
  the reason, which names the attribute.
- \`default\` is required: a body without it is **422** naming \`default\`.
- \`Idempotency-Key\` is required (**400** without it). Look \`(key, Idempotency-Key)\` up in
  \`store.create_result\` before saving and answer the recorded result on a replay; record a fresh
  result with \`store.record_create\`. A new key on an existing flag saves its next version.`,
  sequence: {
    participants: ['Admin', 'flagsvc', 'flags.registry', 'flags.store'],
    messages: [
      {from: 'Admin', to: 'flagsvc', label: 'POST /v1/flags · Idempotency-Key: k-1', kind: 'sync'},
      {from: 'flagsvc', to: 'flags.store', label: 'create_result(checkout, k-1)', kind: 'sync'},
      {from: 'flags.store', to: 'flagsvc', label: 'recorded answer · or none', kind: 'reply'},
      {from: 'flagsvc', to: 'flags.registry', label: 'rule_error(rule) for every rule', kind: 'sync'},
      {from: 'flags.registry', to: 'flagsvc', label: 'None · or "unknown attribute …" → 422', kind: 'reply'},
      {from: 'flagsvc', to: 'flags.store', label: 'save(definition) · record_create(…)', kind: 'sync'},
      {from: 'flagsvc', to: 'Admin', label: '201 {key, version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/flags and stores the flag',
      detail:
        'Register `POST /v1/flags`; a first create answers **201** `{key, version: 1}` and the store holds the definition.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/flags["']/, /store\.save\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/flags['"]/, /\bsave\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/flags"/, /store\.Save\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"flags"\s*\)/, /\bpost\s*\{/, /Store\.save\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/flags"/, /store::save\(/]},
      },
    },
    {
      id: 'registry',
      title: 'Refuses a rule the schema registry does not accept',
      detail:
        'Every rule goes through `rule_error`/`ruleError` (or the registry tables) before the save, and a refused rule answers **422**; the starter stores any attribute and operator, so a typo is a rule that never matches.',
      match: {
        python: {
          all: [/registry\.rule_error\(|registry\.ATTRIBUTES\[/],
          order: [/registry\.rule_error\(|registry\.ATTRIBUTES\[/, /store\.save\(/],
        },
        typescript: {all: [/\bruleError\(|ATTRIBUTES\[/], order: [/\bruleError\(|ATTRIBUTES\[/, /\bsave\(/]},
        go: {
          all: [/registry\.RuleError\(|registry\.Attributes\[/],
          order: [/registry\.RuleError\(|registry\.Attributes\[/, /store\.Save\(/],
        },
        scala: {
          all: [/Registry\.ruleError\(|Registry\.Attributes/],
          order: [/Registry\.ruleError\(|Registry\.Attributes/, /Store\.save\(/],
        },
        cpp: {
          all: [/registry::ruleError\(|registry::kAttributes/],
          order: [/registry::ruleError\(|registry::kAttributes/, /store::save\(/],
        },
      },
    },
    {
      id: 'default',
      title: 'A create without a default is 422',
      detail:
        'An absent `default` is a 422 naming it, not a `false` nobody chose: the starter gives the field a `false` fallback (`= False`, `?? false`, a plain `bool`, `value("default", false)`, `getOrElse(false)`).',
      match: {
        python: {all: [/body\.default is None|["']default["'] not in/], none: [/default:\s*bool\s*=\s*False/]},
        typescript: {
          all: [/typeof body\.default !== ['"]boolean['"]|body\.default === undefined/],
          none: [/default\s*\?\?\s*false/],
        },
        go: {all: [/Default\s+\*bool/, /Default == nil/]},
        scala: {all: [/"default"/], none: [/getOrElse\(false\)/]},
        cpp: {
          all: [/contains\(\s*"default"\s*\)|\["default"\]\.is_boolean\(\)/],
          none: [/value\(\s*"default",\s*false\s*\)/],
        },
      },
    },
    {
      id: 'idempotency',
      title: 'Keys a create by (key, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is read (a missing one is 400) and the recorded answer is looked up (`create_result`/`createResult`) before the save; a replay answers it, and a fresh create records its result.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.create_result\(/, /store\.record_create\(/, /\b400\b/],
          order: [/store\.create_result\(/, /store\.save\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /createResult\(/, /recordCreate\(/, /\b400\b/],
          order: [/createResult\(/, /\bsave\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.CreateResult\(/, /store\.RecordCreate\(/, /StatusBadRequest|\b400\b/],
          order: [/store\.CreateResult\(/, /store\.Save\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.createResult\(/, /Store\.recordCreate\(/, /BadRequest|\b400\b/],
          order: [/Store\.createResult\(/, /Store\.save\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::createResult\(/, /store::recordCreate\(/, /\b400\b/],
          order: [/store::createResult\(/, /store::save\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import re
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from flags import registry, store  # registry.rule_error; store.save, load, create_result, record_create

app = FastAPI()

KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")


class Rule(BaseModel):
    attribute: str
    operator: str
    value: Any


class FlagCreate(BaseModel):
    key: str
    default: bool = False
    rules: list[Rule] = []
    rollout: int = 0


@app.post("/v1/flags", status_code=201)
def create_flag(body: FlagCreate, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    if not KEY_PATTERN.match(body.key) or not 0 <= body.rollout <= 100:
        raise HTTPException(status_code=422, detail="key or rollout out of range")
    rules = [rule.model_dump() for rule in body.rules]
    saved = store.save({"key": body.key, "default": body.default, "rules": rules, "rollout": body.rollout})
    return {"key": saved["key"], "version": saved["version"]}
`,
      solution: `import re
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from flags import registry, store  # registry.rule_error; store.save, load, create_result, record_create

app = FastAPI()

KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")


class Rule(BaseModel):
    attribute: str
    operator: str
    value: Any


class FlagCreate(BaseModel):
    key: str
    default: bool | None = None
    rules: list[Rule] = []
    rollout: int = 0


@app.post("/v1/flags", status_code=201)
def create_flag(body: FlagCreate, request: Request) -> dict:
    idempotency_key = request.headers.get("idempotency-key", "")
    if not idempotency_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    recorded = store.create_result(body.key, idempotency_key)
    if recorded is not None:
        return recorded  # a replay answers what the first attempt answered
    if not KEY_PATTERN.match(body.key) or not 0 <= body.rollout <= 100:
        raise HTTPException(status_code=422, detail="key or rollout out of range")
    if body.default is None:
        raise HTTPException(status_code=422, detail="default is required")
    rules = [rule.model_dump() for rule in body.rules]
    for rule in rules:
        error = registry.rule_error(rule)
        if error is not None:
            raise HTTPException(status_code=422, detail=error)
    saved = store.save({"key": body.key, "default": body.default, "rules": rules, "rollout": body.rollout})
    result = {"key": saved["key"], "version": saved["version"]}
    store.record_create(body.key, idempotency_key, result)
    return result
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Rule, ruleError} from 'flags/registry';
import {createResult, recordCreate, save} from 'flags/store';

export const app = Fastify();

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

interface FlagCreate {
  key: string;
  default?: boolean;
  rules?: Rule[];
  rollout?: number;
}

app.post('/v1/flags', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const body = request.body as FlagCreate;
  const rollout = body.rollout ?? 0;
  if (!KEY_PATTERN.test(body.key ?? '') || rollout < 0 || rollout > 100) return reply.code(422).send({error: 'key or rollout out of range'});
  const saved = await save({key: body.key, default: body.default ?? false, rules: body.rules ?? [], rollout});
  return reply.code(201).send({key: saved.key, version: saved.version});
});
`,
      solution: `import Fastify from 'fastify';

import {type Rule, ruleError} from 'flags/registry';
import {createResult, recordCreate, save} from 'flags/store';

export const app = Fastify();

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

interface FlagCreate {
  key: string;
  default?: boolean;
  rules?: Rule[];
  rollout?: number;
}

app.post('/v1/flags', async (request, reply) => {
  const body = request.body as FlagCreate;
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await createResult(body.key, idempotencyKey);
  if (recorded !== null) return reply.code(201).send(recorded); // a replay answers what the first attempt answered
  const rollout = body.rollout ?? 0;
  if (!KEY_PATTERN.test(body.key ?? '') || rollout < 0 || rollout > 100) return reply.code(422).send({error: 'key or rollout out of range'});
  if (typeof body.default !== 'boolean') return reply.code(422).send({error: 'default is required'});
  const rules = body.rules ?? [];
  for (const rule of rules) {
    const error = ruleError(rule);
    if (error !== null) return reply.code(422).send({error});
  }
  const saved = await save({key: body.key, default: body.default, rules, rollout});
  const result = {key: saved.key, version: saved.version};
  await recordCreate(body.key, idempotencyKey, result);
  return reply.code(201).send(result);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"flags/registry" // registry.Rule, RuleError
	"flags/store"    // store.Save, Load, CreateResult, RecordCreate
)

var keyPattern = regexp.MustCompile(\`^[a-z0-9][a-z0-9-]{0,127}$\`)

type flagCreate struct {
	Key     string          \`json:"key"\`
	Default bool            \`json:"default"\`
	Rules   []registry.Rule \`json:"rules"\`
	Rollout int             \`json:"rollout"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createFlag(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	var body flagCreate
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	if !keyPattern.MatchString(body.Key) || body.Rollout < 0 || body.Rollout > 100 {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "key or rollout out of range"})
		return
	}
	saved, err := store.Save(r.Context(), store.Definition{Key: body.Key, Default: body.Default, Rules: body.Rules, Rollout: body.Rollout})
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"key": saved.Key, "version": saved.Version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/flags", createFlag)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"flags/registry" // registry.Rule, RuleError
	"flags/store"    // store.Save, Load, CreateResult, RecordCreate
)

var keyPattern = regexp.MustCompile(\`^[a-z0-9][a-z0-9-]{0,127}$\`)

type flagCreate struct {
	Key     string          \`json:"key"\`
	Default *bool           \`json:"default"\`
	Rules   []registry.Rule \`json:"rules"\`
	Rollout int             \`json:"rollout"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createFlag(rw http.ResponseWriter, r *http.Request) {
	var body flagCreate
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	idempotencyKey := r.Header.Get("Idempotency-Key")
	if idempotencyKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	if recorded := store.CreateResult(r.Context(), body.Key, idempotencyKey); recorded != nil {
		writeJSON(rw, http.StatusCreated, recorded) // a replay answers what the first attempt answered
		return
	}
	if !keyPattern.MatchString(body.Key) || body.Rollout < 0 || body.Rollout > 100 {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "key or rollout out of range"})
		return
	}
	if body.Default == nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "default is required"})
		return
	}
	for _, rule := range body.Rules {
		if reason := registry.RuleError(rule); reason != "" {
			writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": reason})
			return
		}
	}
	saved, err := store.Save(r.Context(), store.Definition{Key: body.Key, Default: *body.Default, Rules: body.Rules, Rollout: body.Rollout})
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	result := map[string]any{"key": saved.Key, "version": saved.Version}
	store.RecordCreate(r.Context(), body.Key, idempotencyKey, result)
	writeJSON(rw, http.StatusCreated, result)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/flags", createFlag)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import flags.{Registry, Store} // Registry.ruleError; Store.save, load, createResult, recordCreate

object Api {
  val KeyPattern = "^[a-z0-9][a-z0-9-]{0,127}$".r

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "flags") {
      post {
        entity(as[String]) { raw =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          val fields = raw.parseJson.asJsObject.fields
          val key = fields.get("key").collect { case JsString(s) => s }.getOrElse("")
          val default = fields.get("default").collect { case JsBoolean(b) => b }.getOrElse(false)
          val rules = fields.get("rules").collect { case JsArray(rs) => rs }.getOrElse(Vector.empty)
          val rollout = fields.get("rollout").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
          if (KeyPattern.findFirstIn(key).isEmpty || rollout < 0 || rollout > 100) complete(error(StatusCodes.UnprocessableEntity, "key or rollout out of range"))
          else {
            val saved = Store.save(JsObject("key" -> JsString(key), "default" -> JsBoolean(default), "rules" -> JsArray(rules), "rollout" -> JsNumber(rollout)))
            complete(json(StatusCodes.Created, JsObject("key" -> saved.fields("key"), "version" -> saved.fields("version"))))
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

import flags.{Registry, Store} // Registry.ruleError; Store.save, load, createResult, recordCreate

object Api {
  val KeyPattern = "^[a-z0-9][a-z0-9-]{0,127}$".r

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "flags") {
      post {
        optionalHeaderValueByName("Idempotency-Key") {
          case None | Some("") => complete(error(StatusCodes.BadRequest, "Idempotency-Key is required"))
          case Some(idempotencyKey) =>
            entity(as[String]) { raw =>
              val fields = raw.parseJson.asJsObject.fields
              val key = fields.get("key").collect { case JsString(s) => s }.getOrElse("")
              Store.createResult(key, idempotencyKey) match {
                case Some(recorded) => complete(json(StatusCodes.Created, recorded)) // a replay answers what the first attempt answered
                case None => complete(create(fields, idempotencyKey))
              }
            }
        }
      }
    }

  /** The stored answer of a valid create, or the 422 that refuses it. */
  private def create(fields: Map[String, JsValue], idempotencyKey: String): HttpResponse = {
    val key = fields.get("key").collect { case JsString(s) => s }.getOrElse("")
    val rules = fields.get("rules").collect { case JsArray(rs) => rs }.getOrElse(Vector.empty)
    val rollout = fields.get("rollout").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
    val refused = rules.flatMap(rule => Registry.ruleError(rule.asJsObject)).headOption
    fields.get("default") match {
      case _ if KeyPattern.findFirstIn(key).isEmpty || rollout < 0 || rollout > 100 => error(StatusCodes.UnprocessableEntity, "key or rollout out of range")
      case Some(JsBoolean(default)) =>
        refused match {
          case Some(reason) => error(StatusCodes.UnprocessableEntity, reason)
          case None =>
            val saved = Store.save(JsObject("key" -> JsString(key), "default" -> JsBoolean(default), "rules" -> JsArray(rules), "rollout" -> JsNumber(rollout)))
            val result = JsObject("key" -> saved.fields("key"), "version" -> saved.fields("version"))
            Store.recordCreate(key, idempotencyKey, result)
            json(StatusCodes.Created, result)
        }
      case _ => error(StatusCodes.UnprocessableEntity, "default is required")
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <string>

#include "flags/registry.h"  // registry::ruleError
#include "flags/store.h"     // store::save, load, createResult, recordCreate

using json = nlohmann::json;

const std::regex kKeyPattern("^[a-z0-9][a-z0-9-]{0,127}$");

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_flag(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 422, json{{"error", "body must be a JSON object"}});
  const std::string key = body.value("key", "");
  const int rollout = body.value("rollout", 0);
  if (!std::regex_match(key, kKeyPattern) || rollout < 0 || rollout > 100) return reply(res, 422, json{{"error", "key or rollout out of range"}});
  const json saved = store::save(json{{"key", key},
                                      {"default", body.value("default", false)},
                                      {"rules", body.value("rules", json::array())},
                                      {"rollout", rollout}});
  reply(res, 201, json{{"key", saved["key"]}, {"version", saved["version"]}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/flags", create_flag);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <string>

#include "flags/registry.h"  // registry::ruleError
#include "flags/store.h"     // store::save, load, createResult, recordCreate

using json = nlohmann::json;

const std::regex kKeyPattern("^[a-z0-9][a-z0-9-]{0,127}$");

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_flag(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 422, json{{"error", "body must be a JSON object"}});
  const std::string idempotency_key = req.get_header_value("Idempotency-Key");
  if (idempotency_key.empty()) return reply(res, 400, json{{"error", "Idempotency-Key is required"}});
  const std::string key = body.value("key", "");
  if (const auto recorded = store::createResult(key, idempotency_key)) return reply(res, 201, *recorded);  // a replay answers what the first attempt answered
  const int rollout = body.value("rollout", 0);
  if (!std::regex_match(key, kKeyPattern) || rollout < 0 || rollout > 100) return reply(res, 422, json{{"error", "key or rollout out of range"}});
  if (!body.contains("default") || !body["default"].is_boolean()) return reply(res, 422, json{{"error", "default is required"}});
  const json rules = body.value("rules", json::array());
  for (const auto& rule : rules) {
    const std::string reason = registry::ruleError(rule);
    if (!reason.empty()) return reply(res, 422, json{{"error", reason}});
  }
  const json saved = store::save(json{{"key", key}, {"default", body["default"]}, {"rules", rules}, {"rollout", rollout}});
  const json result = {{"key", saved["key"]}, {"version", saved["version"]}};
  store::recordCreate(key, idempotency_key, result);
  reply(res, 201, result);
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/flags", create_flag);
}
`,
    },
  },
  harness: {
    python: `from flags import store

RULES = [{"attribute": "country", "operator": "eq", "value": "US"}]
BODY = {"key": "checkout", "default": False, "rules": RULES, "rollout": 25}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _create(c, body, key="k-1"):
    return await c.post("/v1/flags", json=body, headers={"Idempotency-Key": key})


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _create(c, BODY)
    assert r.status_code == 201, f"POST /v1/flags answered {r.status_code}: {r.text}"
    assert r.json() == {"key": "checkout", "version": 1}, f"a first create must answer the key and version 1, got {r.json()}"
    stored = store.load("checkout")
    assert stored is not None and stored["version"] == 1, f"after the create the store holds {stored}"
    assert stored["rules"] == RULES and stored["rollout"] == 25 and stored["default"] is False, f"the store holds {stored}, expected the posted definition"


async def check_registry(ctx):
    async with _api(ctx) as c:
        r = await _create(c, {**BODY, "key": "plan-gate", "rules": [{"attribute": "plan_tier", "operator": "eq", "value": "gold"}]})
        assert r.status_code == 422, f"a rule on plan_tier, an attribute the registry does not know, answered {r.status_code}: stored, it never matches anyone. Expected 422"
        assert "plan_tier" in r.text, f"the 422 must name the refused attribute, got {r.text}"
        assert store.load("plan-gate") is None, f"a flag with a refused rule was stored: {store.load('plan-gate')}"
        r = await _create(c, {**BODY, "key": "country-gt", "rules": [{"attribute": "country", "operator": "gt", "value": "US"}]}, "k-2")
        assert r.status_code == 422, f"gt on the string attribute country answered {r.status_code}, expected 422: the registry has no gt for strings"
        r = await _create(c, {**BODY, "key": "new-app", "rules": [{"attribute": "app_version", "operator": "gt", "value": 5}]}, "k-3")
    assert r.status_code == 201, f"gt on the number attribute app_version is registered, yet the create answered {r.status_code}: {r.text}"


async def check_default(ctx):
    async with _api(ctx) as c:
        r = await _create(c, {name: value for name, value in BODY.items() if name != "default"})
        assert r.status_code == 422, f"a create with no default answered {r.status_code}: the flag would serve false to everyone without anyone choosing it. Expected 422"
        assert "default" in r.text, f"the 422 must name default, got {r.text}"
        assert store.load("checkout") is None, f"a flag with no default was stored: {store.load('checkout')}"
        r = await _create(c, {**BODY, "default": True}, "k-2")
    assert r.status_code == 201, f"a create with default true answered {r.status_code}: {r.text}"
    assert store.load("checkout")["default"] is True, f"the store holds {store.load('checkout')}, expected default true"


async def check_idempotency(ctx):
    async with _api(ctx) as c:
        first = await _create(c, BODY, "k-1")
        assert first.status_code == 201, f"the first create answered {first.status_code}: {first.text}"
        replay = await _create(c, BODY, "k-1")
        assert replay.status_code == 201 and replay.json() == first.json(), f"a replay of Idempotency-Key k-1 must answer the first result {first.json()}, got {replay.status_code} {replay.text}"
        stored = store.load("checkout")
        assert stored["version"] == 1, f"the replay saved version {stored['version']}: a client retry forked the flag"
        fresh = await _create(c, {**BODY, "rollout": 50}, "k-2")
        assert fresh.status_code == 201 and fresh.json().get("version") == 2, f"a create with a new Idempotency-Key must save version 2, got {fresh.status_code} {fresh.text}"
        missing = await c.post("/v1/flags", json=BODY)
    assert missing.status_code == 400, f"a create without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `const RULES = [{attribute: 'country', operator: 'eq', value: 'US'}];
const BODY = {key: 'checkout', default: false, rules: RULES, rollout: 25};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/flags/store.ts')};
}

const create = (c, body, key = 'k-1') => c.post('/v1/flags', {json: body, headers: {'Idempotency-Key': key}});

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await create(c, BODY);
  assert.equal(r.status, 201, \`POST /v1/flags answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json(), {key: 'checkout', version: 1}, \`a first create must answer the key and version 1, got \${r.text}\`);
  const stored = await store.load('checkout');
  assert(stored !== null && stored.version === 1, \`after the create the store holds \${JSON.stringify(stored)}\`);
  assert(JSON.stringify(stored.rules) === JSON.stringify(RULES) && stored.rollout === 25 && stored.default === false, \`the store holds \${JSON.stringify(stored)}, expected the posted definition\`);
}

export async function check_registry(ctx) {
  const {c, store} = api(ctx);
  let r = await create(c, {...BODY, key: 'plan-gate', rules: [{attribute: 'plan_tier', operator: 'eq', value: 'gold'}]});
  assert.equal(r.status, 422, \`a rule on plan_tier, an attribute the registry does not know, answered \${r.status}: stored, it never matches anyone. Expected 422\`);
  assert(r.text.includes('plan_tier'), \`the 422 must name the refused attribute, got \${r.text}\`);
  assert.equal(await store.load('plan-gate'), null, 'a flag with a refused rule was stored');
  r = await create(c, {...BODY, key: 'country-gt', rules: [{attribute: 'country', operator: 'gt', value: 'US'}]}, 'k-2');
  assert.equal(r.status, 422, \`gt on the string attribute country answered \${r.status}, expected 422: the registry has no gt for strings\`);
  r = await create(c, {...BODY, key: 'new-app', rules: [{attribute: 'app_version', operator: 'gt', value: 5}]}, 'k-3');
  assert.equal(r.status, 201, \`gt on the number attribute app_version is registered, yet the create answered \${r.status}: \${r.text}\`);
}

export async function check_default(ctx) {
  const {c, store} = api(ctx);
  const {default: _, ...noDefault} = BODY;
  let r = await create(c, noDefault);
  assert.equal(r.status, 422, \`a create with no default answered \${r.status}: the flag would serve false to everyone without anyone choosing it. Expected 422\`);
  assert(r.text.includes('default'), \`the 422 must name default, got \${r.text}\`);
  assert.equal(await store.load('checkout'), null, 'a flag with no default was stored');
  r = await create(c, {...BODY, default: true}, 'k-2');
  assert.equal(r.status, 201, \`a create with default true answered \${r.status}: \${r.text}\`);
  assert.equal((await store.load('checkout')).default, true, 'the stored default must be true');
}

export async function check_idempotency(ctx) {
  const {c, store} = api(ctx);
  const first = await create(c, BODY, 'k-1');
  assert.equal(first.status, 201, \`the first create answered \${first.status}: \${first.text}\`);
  const replay = await create(c, BODY, 'k-1');
  assert(replay.status === 201 && JSON.stringify(replay.json()) === JSON.stringify(first.json()), \`a replay of Idempotency-Key k-1 must answer the first result \${first.text}, got \${replay.status} \${replay.text}\`);
  const stored = await store.load('checkout');
  assert.equal(stored.version, 1, \`the replay saved version \${stored.version}: a client retry forked the flag\`);
  const fresh = await create(c, {...BODY, rollout: 50}, 'k-2');
  assert(fresh.status === 201 && fresh.json().version === 2, \`a create with a new Idempotency-Key must save version 2, got \${fresh.status} \${fresh.text}\`);
  const missing = await c.post('/v1/flags', {json: BODY});
  assert.equal(missing.status, 400, \`a create without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"flags/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

func apiBody(key string, deflt any, rules []map[string]any, rollout int) map[string]any {
	body := map[string]any{"key": key, "rules": rules, "rollout": rollout}
	if deflt != nil {
		body["default"] = deflt
	}
	return body
}

var usRules = []map[string]any{{"attribute": "country", "operator": "eq", "value": "US"}}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiCreate(c *harness.HTTP, body map[string]any, key string) *harness.Response {
	return c.Post("/v1/flags", body, "Idempotency-Key", key)
}

func apiVersion(r *harness.Response) float64 {
	m, _ := r.JSON().(map[string]any)
	v, _ := m["version"].(float64)
	return v
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiCreate(c, apiBody("checkout", false, usRules, 25), "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/flags (%s)", r.Text())
	m, _ := r.JSON().(map[string]any)
	ctx.Assert(m["key"] == "checkout" && apiVersion(r) == 1, "a first create must answer the key and version 1, got %s", r.Text())
	stored := store.Load(apiBg, "checkout")
	ctx.Assert(stored != nil && stored.Version == 1, "after the create the store holds %+v", stored)
	ctx.Assert(len(stored.Rules) == 1 && stored.Rules[0].Attribute == "country" && stored.Rollout == 25 && !stored.Default, "the store holds %+v, expected the posted definition", stored)
}

func CheckRegistry(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiCreate(c, apiBody("plan-gate", false, []map[string]any{{"attribute": "plan_tier", "operator": "eq", "value": "gold"}}, 25), "k-1")
	ctx.Equal(r.Status, 422, "a rule on plan_tier, an attribute the registry does not know, is stored and never matches anyone (%s); the status", r.Text())
	ctx.Assert(strings.Contains(r.Text(), "plan_tier"), "the 422 must name the refused attribute, got %s", r.Text())
	ctx.Assert(store.Load(apiBg, "plan-gate") == nil, "a flag with a refused rule was stored")
	r = apiCreate(c, apiBody("country-gt", false, []map[string]any{{"attribute": "country", "operator": "gt", "value": "US"}}, 25), "k-2")
	ctx.Equal(r.Status, 422, "gt on the string attribute country: the registry has no gt for strings; the status")
	r = apiCreate(c, apiBody("new-app", false, []map[string]any{{"attribute": "app_version", "operator": "gt", "value": 5}}, 25), "k-3")
	ctx.Equal(r.Status, 201, "gt on the number attribute app_version is registered (%s); the status", r.Text())
}

func CheckDefault(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiCreate(c, apiBody("checkout", nil, usRules, 25), "k-1")
	ctx.Equal(r.Status, 422, "a create with no default would serve false to everyone without anyone choosing it (%s); the status", r.Text())
	ctx.Assert(strings.Contains(r.Text(), "default"), "the 422 must name default, got %s", r.Text())
	ctx.Assert(store.Load(apiBg, "checkout") == nil, "a flag with no default was stored")
	r = apiCreate(c, apiBody("checkout", true, usRules, 25), "k-2")
	ctx.Equal(r.Status, 201, "a create with default true (%s)", r.Text())
	ctx.Equal(store.Load(apiBg, "checkout").Default, true, "the stored default")
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := apiCreate(c, apiBody("checkout", false, usRules, 25), "k-1")
	ctx.Equal(first.Status, 201, "the first create (%s)", first.Text())
	replay := apiCreate(c, apiBody("checkout", false, usRules, 25), "k-1")
	ctx.Assert(replay.Status == 201 && apiVersion(replay) == apiVersion(first), "a replay of Idempotency-Key k-1 must answer the first result %s, got %d %s", first.Text(), replay.Status, replay.Text())
	ctx.Equal(store.Load(apiBg, "checkout").Version, int64(1), "a client retry must not fork the flag; the stored version")
	fresh := apiCreate(c, apiBody("checkout", false, usRules, 50), "k-2")
	ctx.Assert(fresh.Status == 201 && apiVersion(fresh) == 2, "a create with a new Idempotency-Key must save version 2, got %d %s", fresh.Status, fresh.Text())
	missing := c.Post("/v1/flags", apiBody("checkout", false, usRules, 25))
	ctx.Equal(missing.Status, 400, "a create without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "flags/store.h"

namespace {

const nlohmann::json kUsRules = nlohmann::json::parse(R"([{"attribute": "country", "operator": "eq", "value": "US"}])");

nlohmann::json apiBody(const std::string& key, const nlohmann::json& rules, int rollout) {
  return nlohmann::json{{"key", key}, {"default", false}, {"rules", rules}, {"rollout", rollout}};
}

harness::HTTP apiClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response apiCreate(harness::HTTP& c, const nlohmann::json& body, const std::string& key) {
  return c.Post("/v1/flags", body.dump(), "Content-Type", "application/json", "Idempotency-Key", key);
}

long apiVersion(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j.value("version", 0L) : 0L;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto r = apiCreate(c, apiBody("checkout", kUsRules, 25), "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/flags (%s)", r.Text());
  ctx.Assert(r.Text().find("checkout") != std::string::npos && apiVersion(r) == 1, "a first create must answer the key and version 1, got %s", r.Text());
  const auto stored = store::load("checkout");
  ctx.Assert(stored && stored->value("version", 0L) == 1, "after the create the store holds %s", stored ? stored->dump() : "nothing");
  ctx.Assert(stored->at("rules") == kUsRules && stored->value("rollout", 0) == 25 && stored->value("default", true) == false, "the store holds %s, expected the posted definition", stored->dump());
}

void CheckRegistry(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto r = apiCreate(c, apiBody("plan-gate", nlohmann::json::parse(R"([{"attribute": "plan_tier", "operator": "eq", "value": "gold"}])"), 25), "k-1");
  ctx.Equal(r.Status, 422, "a rule on plan_tier, an attribute the registry does not know, is stored and never matches anyone (%s); the status", r.Text());
  ctx.Assert(r.Text().find("plan_tier") != std::string::npos, "the 422 must name the refused attribute, got %s", r.Text());
  ctx.Assert(!store::load("plan-gate"), "a flag with a refused rule was stored");
  r = apiCreate(c, apiBody("country-gt", nlohmann::json::parse(R"([{"attribute": "country", "operator": "gt", "value": "US"}])"), 25), "k-2");
  ctx.Equal(r.Status, 422, "gt on the string attribute country: the registry has no gt for strings; the status");
  r = apiCreate(c, apiBody("new-app", nlohmann::json::parse(R"([{"attribute": "app_version", "operator": "gt", "value": 5}])"), 25), "k-3");
  ctx.Equal(r.Status, 201, "gt on the number attribute app_version is registered (%s); the status", r.Text());
}

void CheckDefault(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  nlohmann::json body = apiBody("checkout", kUsRules, 25);
  body.erase("default");
  auto r = apiCreate(c, body, "k-1");
  ctx.Equal(r.Status, 422, "a create with no default would serve false to everyone without anyone choosing it (%s); the status", r.Text());
  ctx.Assert(r.Text().find("default") != std::string::npos, "the 422 must name default, got %s", r.Text());
  ctx.Assert(!store::load("checkout"), "a flag with no default was stored");
  body["default"] = true;
  r = apiCreate(c, body, "k-2");
  ctx.Equal(r.Status, 201, "a create with default true (%s)", r.Text());
  ctx.Equal(store::load("checkout")->value("default", false), true, "the stored default");
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto first = apiCreate(c, apiBody("checkout", kUsRules, 25), "k-1");
  ctx.Equal(first.Status, 201, "the first create (%s)", first.Text());
  const auto replay = apiCreate(c, apiBody("checkout", kUsRules, 25), "k-1");
  ctx.Assert(replay.Status == 201 && apiVersion(replay) == apiVersion(first), "a replay of Idempotency-Key k-1 must answer the first result %s, got %d %s", first.Text(), replay.Status, replay.Text());
  ctx.Equal(store::load("checkout")->value("version", 0L), 1L, "a client retry must not fork the flag; the stored version");
  const auto fresh = apiCreate(c, apiBody("checkout", kUsRules, 50), "k-2");
  ctx.Assert(fresh.Status == 201 && apiVersion(fresh) == 2, "a create with a new Idempotency-Key must save version 2, got %d %s", fresh.Status, fresh.Text());
  const auto missing = c.Post("/v1/flags", apiBody("checkout", kUsRules, 25).dump(), "Content-Type", "application/json");
  ctx.Equal(missing.Status, 400, "a create without Idempotency-Key");
}
`,
  },
  hints: [
    'Create a flag targeting `plan_tier`, then evaluate it: nobody ever matches. Create one without `default`: it serves `false`. Retry a create after a timeout: the flag is at version 2.',
    'The starter stores rules without asking the registry, its body model fills an absent `default` with `false`, and it never reads `Idempotency-Key`, so every retry is a fresh `store.save`.',
    'Read `Idempotency-Key` (400 if absent) and answer `store.create_result` when recorded; 422 on a missing `default` and on the first `registry.rule_error`; after `store.save`, `store.record_create` the answer.',
  ],
  debrief: `The checks sit at creation because everything downstream trusts what this handler stored: a rule on an unknown attribute evaluates without error and matches nobody, so the only cheap moment to catch it is before the save. Checking presence rather than value is what turns a forgotten default into a 422 instead of a decision nobody made. The idempotency record lives beside the versions, keyed by the flag and the client's key, so a retry reads the first answer instead of saving again. Production flag services also give the record an expiry, check that \`default\` matches the flag's variation type, and keep an audit row of who created which version.`,
};
