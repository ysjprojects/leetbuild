import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/flags: a flag is a rule set with a schema',
  concept: 'http',
  file: 'api',
  focus: ['api', 'schema', 'store'],
  task: `## Task

A flag is not a boolean in a config file; it is a rule set with a schema. \`POST /v1/flags\` creates one,
and the schema registry decides what a valid rule may say. The starter is the model-generated draft:
it parses the body and echoes it back. It compiles, it serves the demo, and it hides three flaws.

Implement \`POST /v1/flags\` for body \`{"key": "checkout-redesign", "type": "boolean", "default": false,
"rules": [{"attribute": "country", "operator": "eq", "value": "US"}]}\`.

- \`key\` is non-empty, at most **128** characters, matching \`^[a-z0-9][a-z0-9-]*$\` (**422** otherwise).
- \`type\` is one of \`boolean\`, \`string\`, \`number\`, \`json\` (**422** otherwise).
- \`default\` must be **present** and type-consistent with \`type\` (**422** when it is absent). An absent
  default is not a default of \`false\`.
- Every rule's \`attribute\` must be a **registered** user attribute and its \`operator\` must exist for
  the flag's type (**422** otherwise). A rule on \`plan_tier\`, when the registry only provides
  \`country\`, \`user_id\`, \`app_version\` and \`email_domain\`, is dead — it looks configured and never
  matches.
- \`Idempotency-Key\` is required (**400** when missing). A replay with the same \`(key,
  Idempotency-Key)\` returns the original flag **and its original version**.
- A successful create returns **201** with \`{"key": …, "version": 1, "default": …, "rules": […]}\`.

**The subtle flaw.** The draft silently turns a missing default into \`false\`, accepts any attribute
name so an unknown attribute becomes a dead rule, and writes a fresh version on every retry. The dead
rule is the quiet one: nothing errors, and the flag simply behaves as if the rule were not there.`,
  sequence: {
    participants: ['Client', 'Flag API', 'Schema Registry', 'Flag Store'],
    messages: [
      {from: 'Client', to: 'Flag API', label: 'POST /v1/flags · Idempotency-Key', kind: 'sync'},
      {from: 'Flag API', to: 'Schema Registry', label: 'resolve(attribute, operator, type)', kind: 'sync'},
      {from: 'Schema Registry', to: 'Flag API', label: 'known / unknown', kind: 'reply'},
      {from: 'Flag API', to: 'Flag Store', label: 'get(key, idempotency key)', kind: 'sync'},
      {from: 'Flag Store', to: 'Flag API', label: 'stored flag / none', kind: 'reply'},
      {from: 'Flag API', to: 'Flag Store', label: 'put(key, idempotency key, flag, version)', kind: 'async'},
      {from: 'Flag API', to: 'Client', label: '201 {key, version, default, rules}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/flags',
      detail: 'Register the create route on `POST /v1/flags`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/flags["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/flags['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/flags"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"flags"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/flags"/]},
      },
    },
    {
      id: 'registry',
      title: 'Validates rules against the schema registry',
      detail:
        'A rule attribute must be a registered user attribute and its operator must exist for the flag type; an unknown attribute is **422**. The draft accepts any attribute name, so an unknown attribute silently never matches.',
      match: {
        python: {all: [/ATTRIBUTES/, /OPERATORS/]},
        typescript: {all: [/ATTRIBUTES/, /OPERATORS/]},
        go: {all: [/Attributes/, /Operators/]},
        scala: {all: [/attributes/, /operators/]},
        cpp: {all: [/attributes/, /operators/]},
      },
    },
    {
      id: 'default',
      title: 'Rejects a missing default',
      detail:
        'The default is mandatory: a create whose body carries no `default` is **422**, never a silent `false`. The draft reads an absent field as `false`.',
      match: {
        python: {all: [/model_fields_set/]},
        typescript: {all: [/hasOwnProperty\.call\(\s*body\s*,\s*['"]default['"]\s*\)/]},
        go: {all: [/body\.Default\s*==\s*nil/]},
        scala: {all: [/body\.default\.isEmpty/]},
        cpp: {all: [/body\.contains\(\s*"default"\s*\)/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Idempotency-Key makes a replay return the original version',
      detail:
        'A retry with the same `(key, Idempotency-Key)` returns the stored flag and its stored version. The draft has no idempotency, so a retry forks the flag.',
      match: {
        python: {all: [/Idempotency-Key/]},
        typescript: {all: [/idempotency-key/i]},
        go: {all: [/Idempotency-Key/]},
        scala: {all: [/Idempotency-Key/]},
        cpp: {all: [/Idempotency-Key/]},
      },
    },
    {
      id: 'created',
      title: 'Returns 201 with the flag and its version',
      detail: 'A successful create returns **201** with the key, version, default and rules.',
      match: {
        python: {all: [/status_code\s*=\s*201/]},
        typescript: {all: [/code\(\s*201\s*\)/]},
        go: {all: [/WriteHeader\(\s*201\s*\)/]},
        scala: {all: [/StatusCodes\.Created/]},
        cpp: {all: [/res\.status\s*=\s*201/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class Rule(BaseModel):
    attribute: str
    operator: str
    value: object


class FlagRequest(BaseModel):
    key: str
    type: str
    default: bool = False
    rules: list[Rule] = []


@app.post("/v1/flags")
def create(body: FlagRequest) -> JSONResponse:
    # TODO: this draft defaults to enabled when no rule matches, accepts rules that reference
    # attributes the system never provides, and writes a new version on every retry.
    return JSONResponse(
        {"key": body.key, "default": body.default, "rules": [r.model_dump() for r in body.rules]}
    )
`,
      solution: `import re

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

ATTRIBUTES = {"country", "user_id", "app_version", "email_domain"}
OPERATORS = {"eq", "neq", "in", "gt", "lt"}
TYPES = {"boolean", "string", "number", "json"}
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class Rule(BaseModel):
    attribute: str
    operator: str
    value: object


class FlagRequest(BaseModel):
    key: str
    type: str
    default: object | None = None
    rules: list[Rule] = []


class FlagStore:
    def get(self, key: str, idem_key: str):
        raise NotImplementedError

    def put(self, key: str, idem_key: str, flag: dict, version: int) -> None:
        raise NotImplementedError


store = FlagStore()


@app.post("/v1/flags")
def create(
    body: FlagRequest,
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if not KEY_RE.match(body.key):
        return JSONResponse({"error": "key"}, status_code=422)
    if body.type not in TYPES:
        return JSONResponse({"error": "type"}, status_code=422)
    if "default" not in body.model_fields_set:
        return JSONResponse({"error": "default"}, status_code=422)
    for rule in body.rules:
        if rule.attribute not in ATTRIBUTES:
            return JSONResponse({"error": "attribute"}, status_code=422)
        if rule.operator not in OPERATORS:
            return JSONResponse({"error": "operator"}, status_code=422)
    if idem_key is None:
        return JSONResponse({"error": "idempotency"}, status_code=400)
    existing = store.get(body.key, idem_key)
    if existing is not None:
        return JSONResponse(existing, status_code=201)
    flag = {
        "key": body.key,
        "type": body.type,
        "default": body.default,
        "rules": [r.model_dump() for r in body.rules],
        "version": 1,
    }
    store.put(body.key, idem_key, flag, 1)
    return JSONResponse(flag, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

const app = Fastify();

interface Rule {
  attribute: string;
  operator: string;
  value: unknown;
}

interface FlagRequest {
  key: string;
  type: string;
  default?: unknown;
  rules?: Rule[];
}

app.post('/v1/flags', async (req, reply) => {
  // TODO: this draft defaults to enabled when no rule matches, accepts rules that reference
  // attributes the system never provides, and writes a new version on every retry.
  const body = req.body as FlagRequest;
  return reply.code(200).send({
    key: body.key,
    default: body.default ?? false,
    rules: body.rules ?? [],
  });
});
`,
      solution: `import Fastify from 'fastify';

const app = Fastify();

const ATTRIBUTES: Record<string, true> = {
  country: true,
  user_id: true,
  app_version: true,
  email_domain: true,
};
const OPERATORS: Record<string, true> = {eq: true, neq: true, in: true, gt: true, lt: true};
const TYPES: Record<string, true> = {boolean: true, string: true, number: true, json: true};
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

interface Rule {
  attribute: string;
  operator: string;
  value: unknown;
}

interface FlagRequest {
  key: string;
  type: string;
  default?: unknown;
  rules?: Rule[];
}

const snapshots = new Map<string, unknown>();

app.post('/v1/flags', async (req, reply) => {
  const body = req.body as FlagRequest;
  const idemKey = req.headers['idempotency-key'] as string | undefined;
  if (!body.key || !KEY_RE.test(body.key)) return reply.code(422).send({error: 'key'});
  if (!TYPES[body.type]) return reply.code(422).send({error: 'type'});
  if (!Object.prototype.hasOwnProperty.call(body, 'default'))
    return reply.code(422).send({error: 'default'});
  for (const rule of body.rules ?? []) {
    if (!ATTRIBUTES[rule.attribute]) return reply.code(422).send({error: 'attribute'});
    if (!OPERATORS[rule.operator]) return reply.code(422).send({error: 'operator'});
  }
  if (!idemKey) return reply.code(400).send({error: 'idempotency'});
  const slot = \`\${body.key}/\${idemKey}\`;
  const existing = snapshots.get(slot);
  if (existing) return reply.code(201).send(existing);
  const flag = {
    key: body.key,
    type: body.type,
    default: body.default,
    rules: body.rules ?? [],
    version: 1,
  };
  snapshots.set(slot, flag);
  return reply.code(201).send(flag);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

type Rule struct {
	Attribute string      \`json:"attribute"\`
	Operator  string      \`json:"operator"\`
	Value     interface{} \`json:"value"\`
}

type FlagRequest struct {
	Key     string      \`json:"key"\`
	Type    string      \`json:"type"\`
	Default interface{} \`json:"default"\`
	Rules   []Rule      \`json:"rules"\`
}

func createFlag(w http.ResponseWriter, r *http.Request) {
	// TODO: this draft defaults to enabled when no rule matches, accepts rules that reference
	// attributes the system never provides, and writes a new version on every retry.
	var body FlagRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"key":     body.Key,
		"default": body.Default,
		"rules":   body.Rules,
	})
}

func main() {
	http.HandleFunc("POST /v1/flags", createFlag)
	_ = http.ListenAndServe(":8080", nil)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"
)

var Attributes = map[string]bool{"country": true, "user_id": true, "app_version": true, "email_domain": true}
var Operators = map[string]bool{"eq": true, "neq": true, "in": true, "gt": true, "lt": true}

var keyRe = regexp.MustCompile("^[a-z0-9][a-z0-9-]*$")

type Rule struct {
	Attribute string      \`json:"attribute"\`
	Operator  string      \`json:"operator"\`
	Value     interface{} \`json:"value"\`
}

type FlagRequest struct {
	Key     string      \`json:"key"\`
	Type    string      \`json:"type"\`
	Default interface{} \`json:"default"\`
	Rules   []Rule      \`json:"rules"\`
}

var store = map[string]map[string]interface{}{}

func createFlag(w http.ResponseWriter, r *http.Request) {
	var body FlagRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !keyRe.MatchString(body.Key) {
		w.WriteHeader(422)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "key"})
		return
	}
	if body.Type != "boolean" && body.Type != "string" && body.Type != "number" && body.Type != "json" {
		w.WriteHeader(422)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "type"})
		return
	}
	if body.Default == nil {
		w.WriteHeader(422)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "default"})
		return
	}
	for _, rule := range body.Rules {
		if !Attributes[rule.Attribute] {
			w.WriteHeader(422)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "attribute"})
			return
		}
		if !Operators[rule.Operator] {
			w.WriteHeader(422)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "operator"})
			return
		}
	}
	idem := r.Header.Get("Idempotency-Key")
	if idem == "" {
		w.WriteHeader(400)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "idempotency"})
		return
	}
	if existing, ok := store[body.Key][idem]; ok {
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(existing)
		return
	}
	flag := map[string]interface{}{
		"key":     body.Key,
		"type":    body.Type,
		"default": body.Default,
		"rules":   body.Rules,
		"version": 1,
	}
	if store[body.Key] == nil {
		store[body.Key] = map[string]interface{}{}
	}
	store[body.Key][idem] = flag
	w.WriteHeader(201)
	_ = json.NewEncoder(w).Encode(flag)
}

func main() {
	http.HandleFunc("POST /v1/flags", createFlag)
	_ = http.ListenAndServe(":8080", nil)
}
`,
    },
    scala: {
      starter: `import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.model.StatusCodes
import spray.json._

case class Rule(attribute: String, operator: String, value: JsValue)
case class FlagRequest(key: String, \`type\`: String, default: Option[JsValue], rules: List[Rule])

def createFlag: Route = path("v1" / "flags") {
  post {
    entity(as[FlagRequest]) { body =>
      // TODO: this draft defaults to enabled when no rule matches, accepts rules that reference
      // attributes the system never provides, and writes a new version on every retry.
      complete(Map(
        "key" -> body.key.toJson,
        "default" -> body.default.getOrElse(false.toJson),
        "rules" -> body.rules.toJson,
      ).toJson)
    }
  }
}
`,
      solution: `import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.model.StatusCodes
import spray.json._

object Schema {
  val attributes: Set[String] = Set("country", "user_id", "app_version", "email_domain")
  val operators: Set[String] = Set("eq", "neq", "in", "gt", "lt")
  val types: Set[String] = Set("boolean", "string", "number", "json")
  val keyRe = "^[a-z0-9][a-z0-9-]*$".r
}

case class Rule(attribute: String, operator: String, value: JsValue)
case class FlagRequest(key: String, \`type\`: String, default: Option[JsValue], rules: List[Rule])

object FlagStore {
  val flags = scala.collection.mutable.Map[(String, String), JsObject]()
  def get(key: String, idem: String): Option[JsObject] = flags.get((key, idem))
  def put(key: String, idem: String, flag: JsObject): Unit = flags.put((key, idem), flag)
}

def createFlag: Route = path("v1" / "flags") {
  post {
    headerValueByName("Idempotency-Key") { idem =>
      entity(as[FlagRequest]) { body =>
        if (Schema.keyRe.findFirstIn(body.key).isEmpty)
          complete(StatusCodes.UnprocessableEntity, Map("error" -> "key".toJson).toJson)
        else if (!Schema.types.contains(body.\`type\`))
          complete(StatusCodes.UnprocessableEntity, Map("error" -> "type".toJson).toJson)
        else if (body.default.isEmpty)
          complete(StatusCodes.UnprocessableEntity, Map("error" -> "default".toJson).toJson)
        else if (body.rules.exists(r => !Schema.attributes.contains(r.attribute)))
          complete(StatusCodes.UnprocessableEntity, Map("error" -> "attribute".toJson).toJson)
        else if (body.rules.exists(r => !Schema.operators.contains(r.operator)))
          complete(StatusCodes.UnprocessableEntity, Map("error" -> "operator".toJson).toJson)
        else
          FlagStore.get(body.key, idem) match {
            case Some(existing) => complete(StatusCodes.Created, existing)
            case None =>
              val flag = JsObject(
                "key" -> body.key.toJson,
                "type" -> body.\`type\`.toJson,
                "default" -> body.default.get,
                "rules" -> body.rules.toJson,
                "version" -> 1.toJson,
              )
              FlagStore.put(body.key, idem, flag)
              complete(StatusCodes.Created, flag)
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

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Post("/v1/flags", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft defaults to enabled when no rule matches, accepts rules that reference
    // attributes the system never provides, and writes a new version on every retry.
    json body = json::parse(req.body);
    json out = {
        {"key", body["key"]},
        {"default", body.value("default", false)},
        {"rules", body.value("rules", json::array())},
    };
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8080);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <map>
#include <regex>
#include <set>
#include <string>

using json = nlohmann::json;

static const std::set<std::string> attributes = {"country", "user_id", "app_version", "email_domain"};
static const std::set<std::string> operators = {"eq", "neq", "in", "gt", "lt"};
static const std::set<std::string> types = {"boolean", "string", "number", "json"};

static std::map<std::string, std::map<std::string, json>> store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/flags", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body);
    static const std::regex keyRe("^[a-z0-9][a-z0-9-]*$");
    std::string err;
    if (!body.contains("key") || !std::regex_match(body["key"].get<std::string>(), keyRe)) err = "key";
    else if (!types.count(body["type"].get<std::string>())) err = "type";
    else if (!body.contains("default")) err = "default";
    else {
      for (const auto& rule : body.value("rules", json::array())) {
        if (!attributes.count(rule["attribute"].get<std::string>())) { err = "attribute"; break; }
        if (!operators.count(rule["operator"].get<std::string>())) { err = "operator"; break; }
      }
    }
    if (!err.empty()) {
      res.status = 422;
      res.set_content(json{{"error", err}}.dump(), "application/json");
      return;
    }
    std::string idem = req.get_header_value("Idempotency-Key");
    if (idem.empty()) {
      res.status = 400;
      res.set_content(json{{"error", "idempotency"}}.dump(), "application/json");
      return;
    }
    auto& keyed = store[body["key"].get<std::string>()];
    if (keyed.count(idem)) {
      res.status = 201;
      res.set_content(keyed[idem].dump(), "application/json");
      return;
    }
    json flag = {
        {"key", body["key"]},
        {"type", body["type"]},
        {"default", body["default"]},
        {"rules", body.value("rules", json::array())},
        {"version", 1},
    };
    keyed[idem] = flag;
    res.status = 201;
    res.set_content(flag.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8080);
}
`,
    },
  },
  hints: [
    'A rule whose attribute is not in the registry is dead: the evaluator looks up a value that never exists. Reject unknown attributes and unknown operators with **422** before the flag is stored.',
    'An absent `default` is not `false`. Check whether the field was *provided*, not whether it is truthy — a flag with no default has no defined behavior when no rule matches.',
    'Idempotency is keyed by `(flag key, Idempotency-Key)`. On a replay return the stored flag **and its stored version**, so a client retry cannot fork the flag.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends a well-formed flag and never retries. Three defects are checked: schema validation (a dead attribute reference looks configured but never matches), an explicit default (an absent default must not silently become \`false\`), and idempotency keyed by flag so a retry cannot fork it. Real flag services add a schema-registry version, per-type operator sets, and a dry-run endpoint that evaluates a rule set against sample users before it is stored.`,
};
