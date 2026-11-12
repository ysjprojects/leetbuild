import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/dedupe/check: exact keys looked up inside the tenant',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/dedupe/check\` with body
\`{"keys": [{"type", "value"}]}\` and answers \`{"duplicate", "match": {"record_id", "key_type"}}\`.
It takes the first key, looks it up with \`exact.lookup_global\` (the trust-and-safety job's scan of
every tenant's index, in the provided \`dedupe.exact\`) and copies the holder's tenant into the match.
It serves the demo and hides four flaws.

**Failure mode the checks target.** One tenant's check confirms, and names, a record another tenant
holds; a misspelled key type or a raw email reaches the index and comes back as "no duplicate"; a
record that matches on its second key is reported as new.

- The tenant is the \`X-Tenant-Id\` header; a check without it is **401**.
- Each \`type\` is one of \`ALLOWED_KEY_TYPES\` (\`email_hash\`, \`content_hash\`, \`phone_hash\`) and
  each \`value\` fully matches \`HASH_RE\`, a lowercase 64-character SHA-256 hex digest; anything else
  is **400**, before any lookup.
- Every key is looked up with \`exact.lookup(tenant, type, value)\`, in the caller's tenant only. The
  first hit answers \`{"record_id", "key_type"}\` and nothing about another tenant.`,
  sequence: {
    participants: ['Client', 'Dedupe API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Dedupe API', label: 'POST /v1/dedupe/check · X-Tenant-Id', kind: 'sync'},
      {from: 'Dedupe API', to: 'Dedupe API', label: 'tenant → 401 · key types, digests → 400', kind: 'sync'},
      {from: 'Dedupe API', to: 'Redis', label: 'HGET t:{tenant}:exact:{type} value, per key', kind: 'sync'},
      {from: 'Redis', to: 'Dedupe API', label: 'record id · nil', kind: 'reply'},
      {from: 'Dedupe API', to: 'Client', label: '200 {duplicate, match: {record_id, key_type}}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/dedupe/check',
      detail:
        'Register the check on `POST /v1/dedupe/check`: a key the tenant holds answers the record id, a key nobody holds answers no duplicate.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/dedupe\/check["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/dedupe\/check['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/dedupe\/check"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"dedupe"\s*\/\s*"check"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/dedupe\/check"/]},
      },
    },
    {
      id: 'key-type',
      title: 'Rejects an unknown key type with 400',
      detail:
        'A key whose `type` is not in `ALLOWED_KEY_TYPES` is **400** before any lookup. The starter looks a misspelled type up, finds nothing and answers "no duplicate".',
      match: {
        python: {all: [/ALLOWED_KEY_TYPES\s*=/, /not in ALLOWED_KEY_TYPES/, /\b400\b/]},
        typescript: {
          all: [
            /ALLOWED_KEY_TYPES\s*[:=]/,
            /ALLOWED_KEY_TYPES\.(has|includes)\(|Object\.hasOwn\(\s*ALLOWED_KEY_TYPES/,
            /code\(\s*400\s*\)/,
          ],
        },
        go: {all: [/allowedKeyTypes\s*=/, /allowedKeyTypes\[/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/AllowedKeyTypes\s*[:=]/, /AllowedKeyTypes\.contains\(/, /BadRequest/]},
        cpp: {all: [/kAllowedKeyTypes\s*=/, /kAllowedKeyTypes\.(count|find|contains)\(/, /\b400\b/]},
      },
    },
    {
      id: 'hash-shape',
      title: 'Requires a lowercase SHA-256 hex digest',
      detail:
        'Each `value` must fully match `HASH_RE` (64 lowercase hex characters) or the check is **400**, so a raw email or a SHA-1 cannot reach the index. The starter looks up whatever it is sent.',
      match: {
        python: {all: [/HASH_RE\s*=\s*re\.compile\(/, /\{64\}/, /HASH_RE\.(fullmatch|match)\(/]},
        typescript: {all: [/HASH_RE\s*=\s*\//, /\{64\}/, /HASH_RE\.test\(/]},
        go: {all: [/hashRe\s*=\s*regexp\.MustCompile\(/, /\{64\}/, /hashRe\.MatchString\(/]},
        scala: {all: [/HashRe\s*=/, /\{64\}/, /HashRe\.matches\(/]},
        cpp: {all: [/std::regex kHashRe/, /\{64\}/, /regex_match\([^\n]*kHashRe/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Looks up the caller's tenant only",
      detail:
        "The tenant comes from `X-Tenant-Id` (**401** without it) and every lookup is `exact.lookup(tenant, …)`; the answer names no other tenant. The starter scans every tenant's index with `lookup_global` and returns the holder's `tenant_id`.",
      match: {
        python: {all: [/exact\.lookup\(\s*tenant/, /\b401\b/], none: [/exact\.lookup_global\(/, /["']tenant_id["']/]},
        typescript: {all: [/\blookup\(\s*tenant/, /code\(\s*401\s*\)/], none: [/lookupGlobal\(/, /tenant_id/]},
        go: {
          all: [/exact\.Lookup\([^\n]*tenant/, /StatusUnauthorized|\b401\b/],
          none: [/exact\.LookupGlobal\(/, /"tenant_id"/],
        },
        scala: {all: [/Exact\.lookup\(\s*tenant/, /Unauthorized/], none: [/Exact\.lookupGlobal\(/, /"tenant_id"/]},
        cpp: {all: [/exact::lookup\(\s*tenant/, /\b401\b/], none: [/exact::lookupGlobal\(/, /"tenant_id"/]},
      },
    },
    {
      id: 'every-key',
      title: 'Looks up every key, not the first',
      detail:
        'A record that matches on its phone hash while the email hash is new is a duplicate: every key in the body is looked up. The starter reads `keys[0]` only.',
      match: {
        python: {all: [/exact\.lookup\(/], none: [/keys\[\s*0\s*\]/]},
        typescript: {all: [/\blookup\(/], none: [/keys\[\s*0\s*\]/]},
        go: {all: [/exact\.Lookup\(/], none: [/Keys\[\s*0\s*\]/]},
        scala: {all: [/Exact\.lookup\(/], none: [/headOption|\.head\b/]},
        cpp: {all: [/exact::lookup\(/], none: [/\["keys"\]\[0\]|\.front\(\)|\.at\(0\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from dedupe import exact  # exact.lookup, exact.lookup_global

app = FastAPI()


class ExactKey(BaseModel):
    type: str
    value: str


class CheckRequest(BaseModel):
    keys: list[ExactKey]


@app.post("/v1/dedupe/check")
def check_duplicates(body: CheckRequest, request: Request):
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if not body.keys:
        return JSONResponse({"error": "keys must not be empty"}, status_code=400)
    key = body.keys[0]
    hit = exact.lookup_global(key.type, key.value)
    if hit is None:
        return {"duplicate": False, "match": None}
    return {"duplicate": True, "match": {"record_id": hit["record_id"], "key_type": key.type, "tenant_id": hit["tenant"]}}
`,
      solution: `import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from dedupe import exact  # exact.lookup, exact.lookup_global

app = FastAPI()

ALLOWED_KEY_TYPES = ("email_hash", "content_hash", "phone_hash")
HASH_RE = re.compile(r"[0-9a-f]{64}")


class ExactKey(BaseModel):
    type: str
    value: str


class CheckRequest(BaseModel):
    keys: list[ExactKey]


@app.post("/v1/dedupe/check")
def check_duplicates(body: CheckRequest, request: Request):
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    if not body.keys:
        return JSONResponse({"error": "keys must not be empty"}, status_code=400)
    for key in body.keys:
        if key.type not in ALLOWED_KEY_TYPES:
            return JSONResponse({"error": f"unknown key type {key.type!r}"}, status_code=400)
        if not HASH_RE.fullmatch(key.value):
            return JSONResponse({"error": f"{key.type} must be a lowercase SHA-256 hex digest"}, status_code=400)
    # Every key, inside the caller's tenant only: another tenant's index is not ours to confirm.
    for key in body.keys:
        record_id = exact.lookup(tenant, key.type, key.value)
        if record_id is not None:
            return {"duplicate": True, "match": {"record_id": record_id, "key_type": key.type}}
    return {"duplicate": False, "match": None}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {lookup, lookupGlobal} from 'dedupe/exact';

export const app = Fastify();

interface ExactKey {
  type: string;
  value: string;
}

app.post('/v1/dedupe/check', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {keys} = request.body as {keys?: ExactKey[]};
  if (!Array.isArray(keys) || keys.length === 0) return reply.code(400).send({error: 'keys must not be empty'});
  const key = keys[0];
  const hit = await lookupGlobal(key.type, key.value);
  if (hit === null) return {duplicate: false, match: null};
  return {duplicate: true, match: {record_id: hit.record_id, key_type: key.type, tenant_id: hit.tenant}};
});
`,
      solution: `import Fastify from 'fastify';

import {lookup, lookupGlobal} from 'dedupe/exact';

export const app = Fastify();

export const ALLOWED_KEY_TYPES: Record<string, true> = {email_hash: true, content_hash: true, phone_hash: true};
export const HASH_RE = /^[0-9a-f]{64}$/;

interface ExactKey {
  type: string;
  value: string;
}

app.post('/v1/dedupe/check', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {keys} = request.body as {keys?: ExactKey[]};
  if (!Array.isArray(keys) || keys.length === 0) return reply.code(400).send({error: 'keys must not be empty'});
  for (const key of keys) {
    if (!Object.hasOwn(ALLOWED_KEY_TYPES, key.type)) return reply.code(400).send({error: \`unknown key type \${key.type}\`});
    if (typeof key.value !== 'string' || !HASH_RE.test(key.value)) {
      return reply.code(400).send({error: \`\${key.type} must be a lowercase SHA-256 hex digest\`});
    }
  }
  // Every key, inside the caller's tenant only: another tenant's index is not ours to confirm.
  for (const key of keys) {
    const recordId = await lookup(tenant, key.type, key.value);
    if (recordId !== null) return {duplicate: true, match: {record_id: recordId, key_type: key.type}};
  }
  return {duplicate: false, match: null};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"dedupe/exact" // exact.Lookup, exact.LookupGlobal
)

type exactKey struct {
	Type  string \`json:"type"\`
	Value string \`json:"value"\`
}

type checkRequest struct {
	Keys []exactKey \`json:"keys"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func checkDuplicates(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body checkRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Keys) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "keys must not be empty"})
		return
	}
	key := body.Keys[0]
	hit, err := exact.LookupGlobal(r.Context(), key.Type, key.Value)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if hit == nil {
		writeJSON(rw, http.StatusOK, map[string]any{"duplicate": false, "match": nil})
		return
	}
	match := map[string]string{"record_id": hit.RecordID, "key_type": key.Type, "tenant_id": hit.Tenant}
	writeJSON(rw, http.StatusOK, map[string]any{"duplicate": true, "match": match})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/dedupe/check", checkDuplicates)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"dedupe/exact" // exact.Lookup, exact.LookupGlobal
)

var allowedKeyTypes = map[string]bool{"email_hash": true, "content_hash": true, "phone_hash": true}

var hashRe = regexp.MustCompile(\`^[0-9a-f]{64}$\`)

type exactKey struct {
	Type  string \`json:"type"\`
	Value string \`json:"value"\`
}

type checkRequest struct {
	Keys []exactKey \`json:"keys"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func checkDuplicates(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body checkRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Keys) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "keys must not be empty"})
		return
	}
	for _, key := range body.Keys {
		if !allowedKeyTypes[key.Type] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown key type " + key.Type})
			return
		}
		if !hashRe.MatchString(key.Value) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": key.Type + " must be a lowercase SHA-256 hex digest"})
			return
		}
	}
	// Every key, inside the caller's tenant only: another tenant's index is not ours to confirm.
	for _, key := range body.Keys {
		recordID, err := exact.Lookup(r.Context(), tenant, key.Type, key.Value)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if recordID != "" {
			writeJSON(rw, http.StatusOK, map[string]any{"duplicate": true, "match": map[string]string{"record_id": recordID, "key_type": key.Type}})
			return
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"duplicate": false, "match": nil})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/dedupe/check", checkDuplicates)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import dedupe.Exact // Exact.lookup, Exact.lookupGlobal

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The keys of a request body, as (type, value) pairs. */
  private def keysOf(raw: String): Seq[(String, String)] =
    raw.parseJson.asJsObject.fields.get("keys").collect { case JsArray(items) => items }.getOrElse(Vector.empty).map { item =>
      val fields = item.asJsObject.fields
      def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
      (text("type"), text("value"))
    }

  val route: Route = path("v1" / "dedupe" / "check") {
    post {
      entity(as[String]) { raw =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        keysOf(raw).headOption match {
          case None => complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("keys must not be empty"))))
          case Some((keyType, value)) =>
            Exact.lookupGlobal(keyType, value) match {
              case None => complete(json(StatusCodes.OK, JsObject("duplicate" -> JsFalse, "match" -> JsNull)))
              case Some(hit) =>
                val matched = JsObject("record_id" -> JsString(hit.recordId), "key_type" -> JsString(keyType), "tenant_id" -> JsString(hit.tenant))
                complete(json(StatusCodes.OK, JsObject("duplicate" -> JsTrue, "match" -> matched)))
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

import dedupe.Exact // Exact.lookup, Exact.lookupGlobal

object Api {
  val AllowedKeyTypes: Set[String] = Set("email_hash", "content_hash", "phone_hash")
  val HashRe = "[0-9a-f]{64}".r

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** The keys of a request body, as (type, value) pairs. */
  private def keysOf(raw: String): Seq[(String, String)] =
    raw.parseJson.asJsObject.fields.get("keys").collect { case JsArray(items) => items }.getOrElse(Vector.empty).map { item =>
      val fields = item.asJsObject.fields
      def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
      (text("type"), text("value"))
    }

  val route: Route = path("v1" / "dedupe" / "check") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val keys = keysOf(raw)
            if (keys.isEmpty) complete(error(StatusCodes.BadRequest, "keys must not be empty"))
            else
              keys.collectFirst {
                case (keyType, _) if !AllowedKeyTypes.contains(keyType) => s"unknown key type $keyType"
                case (keyType, value) if !HashRe.matches(value) => s"$keyType must be a lowercase SHA-256 hex digest"
              } match {
                case Some(message) => complete(error(StatusCodes.BadRequest, message))
                case None =>
                  // Every key, inside the caller's tenant only: another tenant's index is not ours to confirm.
                  val hit = keys.iterator.flatMap { case (keyType, value) => Exact.lookup(tenant, keyType, value).map(keyType -> _) }.nextOption()
                  hit match {
                    case None => complete(json(StatusCodes.OK, JsObject("duplicate" -> JsFalse, "match" -> JsNull)))
                    case Some((keyType, recordId)) =>
                      val matched = JsObject("record_id" -> JsString(recordId), "key_type" -> JsString(keyType))
                      complete(json(StatusCodes.OK, JsObject("duplicate" -> JsTrue, "match" -> matched)))
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

#include "dedupe/exact.h"  // exact::lookup, exact::lookupGlobal

using json = nlohmann::json;

void check_duplicates(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("keys") || !body["keys"].is_array() || body["keys"].empty()) {
    res.status = 400;
    res.set_content(json{{"error", "keys must not be empty"}}.dump(), "application/json");
    return;
  }
  const json& key = body["keys"][0];
  const std::string type = key.value("type", "");
  const auto hit = exact::lookupGlobal(type, key.value("value", ""));
  if (!hit) {
    res.set_content(json{{"duplicate", false}, {"match", nullptr}}.dump(), "application/json");
    return;
  }
  const json match = {{"record_id", hit->record_id}, {"key_type", type}, {"tenant_id", hit->tenant}};
  res.set_content(json{{"duplicate", true}, {"match", match}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/dedupe/check", check_duplicates); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <set>
#include <string>

#include "dedupe/exact.h"  // exact::lookup, exact::lookupGlobal

using json = nlohmann::json;

const std::set<std::string> kAllowedKeyTypes = {"email_hash", "content_hash", "phone_hash"};
const std::regex kHashRe("[0-9a-f]{64}");

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json{{"error", error}}.dump(), "application/json");
}

void check_duplicates(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("keys") || !body["keys"].is_array() || body["keys"].empty()) {
    return reject(res, 400, "keys must not be empty");
  }
  for (const json& key : body["keys"]) {
    const std::string type = key.value("type", "");
    if (!kAllowedKeyTypes.count(type)) return reject(res, 400, "unknown key type " + type);
    if (!std::regex_match(key.value("value", ""), kHashRe)) return reject(res, 400, type + " must be a lowercase SHA-256 hex digest");
  }
  // Every key, inside the caller's tenant only: another tenant's index is not ours to confirm.
  for (const json& key : body["keys"]) {
    const std::string type = key.value("type", "");
    if (const auto record_id = exact::lookup(tenant, type, key.value("value", ""))) {
      res.set_content(json{{"duplicate", true}, {"match", {{"record_id", *record_id}, {"key_type", type}}}}.dump(), "application/json");
      return;
    }
  }
  res.set_content(json{{"duplicate", false}, {"match", nullptr}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/dedupe/check", check_duplicates); }
`,
    },
  },
  harness: {
    python: `from dedupe import exact

EMAIL = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d"
PHONE = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00"
OTHER = "86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d"
SHA1 = "0850a4cffb73cbc53fd33e8990c2184c915ff041"


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _key(key_type, value):
    return {"type": key_type, "value": value}


async def _check(c, keys, tenant="acme"):
    headers = {} if tenant is None else {"X-Tenant-Id": tenant}
    return await c.post("/v1/dedupe/check", json={"keys": keys}, headers=headers)


async def check_route(ctx):
    exact.claim("acme", "email_hash", EMAIL, "r-1")
    async with _api(ctx) as c:
        r = await _check(c, [_key("email_hash", EMAIL)])
        assert r.status_code == 200, f"POST /v1/dedupe/check answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("duplicate") is True and (body.get("match") or {}).get("record_id") == "r-1", f"acme holds this email hash as r-1 and the check answered {body}"
        r = await _check(c, [_key("email_hash", OTHER)])
    assert r.status_code == 200 and r.json().get("duplicate") is False and r.json().get("match") is None, f"a key nobody holds answered {r.status_code} {r.text}, expected 200 with duplicate false"


async def check_key_type(ctx):
    exact.claim("acme", "email_hash", EMAIL, "r-1")
    async with _api(ctx) as c:
        for bad in ("emial_hash", "ssn"):
            r = await _check(c, [_key(bad, OTHER)])
            assert r.status_code == 400, f"a key of type {bad!r} answered {r.status_code} {r.text}: an unknown type is a client bug, not 'no duplicate'. Expected 400"
        r = await _check(c, [_key("email_hash", EMAIL), _key("tax_id", OTHER)])
        assert r.status_code == 400, f"a body with an unknown key type after a valid one answered {r.status_code} {r.text}, expected 400 before any lookup"
        for good in ("email_hash", "content_hash", "phone_hash"):
            r = await _check(c, [_key(good, OTHER)])
            assert r.status_code == 200, f"a {good} key answered {r.status_code} {r.text}, expected 200"


async def check_hash_shape(ctx):
    exact.claim("acme", "email_hash", "jane@example.com", "r-1")
    async with _api(ctx) as c:
        for bad, what in (("jane@example.com", "a raw email"), (SHA1, "a 40-character SHA-1"), (EMAIL.upper(), "an uppercase digest"), (EMAIL[:63], "a 63-character value")):
            r = await _check(c, [_key("email_hash", bad)])
            assert r.status_code == 400, f"{what} as the email_hash value answered {r.status_code} {r.text}, expected 400: only a lowercase SHA-256 hex digest may reach the index"
        r = await _check(c, [_key("email_hash", EMAIL)])
    assert r.status_code == 200, f"a lowercase SHA-256 digest answered {r.status_code} {r.text}, expected 200"


async def check_tenant_scope(ctx):
    exact.claim("globex", "email_hash", EMAIL, "r-9")
    async with _api(ctx) as c:
        r = await _check(c, [_key("email_hash", EMAIL)], tenant="acme")
        assert r.status_code == 200, f"acme's check answered {r.status_code}: {r.text}"
        assert r.json().get("duplicate") is False and "r-9" not in r.text and "globex" not in r.text, f"acme's check answered {r.text}: it confirms, and names, a record globex holds. Look up the caller's tenant only"
        r = await _check(c, [_key("email_hash", EMAIL)], tenant=None)
        assert r.status_code == 401, f"a check without X-Tenant-Id answered {r.status_code} {r.text}, expected 401"
        exact.claim("acme", "email_hash", EMAIL, "r-1")
        r = await _check(c, [_key("email_hash", EMAIL)], tenant="acme")
    assert r.status_code == 200 and r.json().get("match") == {"record_id": "r-1", "key_type": "email_hash"}, f"acme's own duplicate answered {r.text}, expected the match {{record_id: r-1, key_type: email_hash}} and nothing about any tenant"


async def check_every_key(ctx):
    exact.claim("acme", "phone_hash", PHONE, "r-7")
    async with _api(ctx) as c:
        r = await _check(c, [_key("email_hash", OTHER), _key("phone_hash", PHONE)])
        assert r.status_code == 200, f"the check answered {r.status_code}: {r.text}"
        assert r.json().get("duplicate") is True and r.json().get("match") == {"record_id": "r-7", "key_type": "phone_hash"}, f"r-7 holds the phone hash of the second key and the check answered {r.text}: every key must be looked up, not the first"
        r = await _check(c, [_key("content_hash", OTHER), _key("email_hash", OTHER)])
    assert r.json().get("duplicate") is False, f"no key is held and the check answered {r.text}"
`,
    typescript: `const EMAIL = '8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d';
const PHONE = '602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00';
const OTHER = '86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d';
const SHA1 = '0850a4cffb73cbc53fd33e8990c2184c915ff041';

function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), exact: ctx.load('/support/dedupe/exact.ts')};
}

const key = (type: string, value: string) => ({type, value});

const check = (c, keys, tenant: string | null = 'acme') =>
  c.post('/v1/dedupe/check', {json: {keys}, headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const {c, exact} = api(ctx);
  await exact.claim('acme', 'email_hash', EMAIL, 'r-1');
  let r = await check(c, [key('email_hash', EMAIL)]);
  assert.equal(r.status, 200, \`POST /v1/dedupe/check answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.duplicate === true && body.match?.record_id === 'r-1', \`acme holds this email hash as r-1 and the check answered \${r.text}\`);
  r = await check(c, [key('email_hash', OTHER)]);
  assert(r.status === 200 && r.json().duplicate === false && r.json().match === null, \`a key nobody holds answered \${r.status} \${r.text}, expected 200 with duplicate false\`);
}

export async function check_key_type(ctx) {
  const {c, exact} = api(ctx);
  await exact.claim('acme', 'email_hash', EMAIL, 'r-1');
  for (const bad of ['emial_hash', 'ssn']) {
    const r = await check(c, [key(bad, OTHER)]);
    assert.equal(r.status, 400, \`a key of type \${bad} answered \${r.status} \${r.text}: an unknown type is a client bug, not "no duplicate". Expected 400\`);
  }
  const mixed = await check(c, [key('email_hash', EMAIL), key('tax_id', OTHER)]);
  assert.equal(mixed.status, 400, \`a body with an unknown key type after a valid one answered \${mixed.status} \${mixed.text}, expected 400 before any lookup\`);
  for (const good of ['email_hash', 'content_hash', 'phone_hash']) {
    const r = await check(c, [key(good, OTHER)]);
    assert.equal(r.status, 200, \`a \${good} key answered \${r.status} \${r.text}, expected 200\`);
  }
}

export async function check_hash_shape(ctx) {
  const {c, exact} = api(ctx);
  await exact.claim('acme', 'email_hash', 'jane@example.com', 'r-1');
  const bad: [string, string][] = [
    ['jane@example.com', 'a raw email'],
    [SHA1, 'a 40-character SHA-1'],
    [EMAIL.toUpperCase(), 'an uppercase digest'],
    [EMAIL.slice(0, 63), 'a 63-character value'],
  ];
  for (const [value, what] of bad) {
    const r = await check(c, [key('email_hash', value)]);
    assert.equal(r.status, 400, \`\${what} as the email_hash value answered \${r.status} \${r.text}, expected 400: only a lowercase SHA-256 hex digest may reach the index\`);
  }
  const r = await check(c, [key('email_hash', EMAIL)]);
  assert.equal(r.status, 200, \`a lowercase SHA-256 digest answered \${r.status} \${r.text}, expected 200\`);
}

export async function check_tenant_scope(ctx) {
  const {c, exact} = api(ctx);
  await exact.claim('globex', 'email_hash', EMAIL, 'r-9');
  let r = await check(c, [key('email_hash', EMAIL)], 'acme');
  assert.equal(r.status, 200, \`acme's check answered \${r.status}: \${r.text}\`);
  assert(r.json().duplicate === false && !r.text.includes('r-9') && !r.text.includes('globex'), \`acme's check answered \${r.text}: it confirms, and names, a record globex holds. Look up the caller's tenant only\`);
  r = await check(c, [key('email_hash', EMAIL)], null);
  assert.equal(r.status, 401, \`a check without X-Tenant-Id answered \${r.status} \${r.text}, expected 401\`);
  await exact.claim('acme', 'email_hash', EMAIL, 'r-1');
  r = await check(c, [key('email_hash', EMAIL)], 'acme');
  assert(r.status === 200 && JSON.stringify(r.json().match) === JSON.stringify({record_id: 'r-1', key_type: 'email_hash'}), \`acme's own duplicate answered \${r.text}, expected the match {record_id: r-1, key_type: email_hash} and nothing about any tenant\`);
}

export async function check_every_key(ctx) {
  const {c, exact} = api(ctx);
  await exact.claim('acme', 'phone_hash', PHONE, 'r-7');
  let r = await check(c, [key('email_hash', OTHER), key('phone_hash', PHONE)]);
  assert.equal(r.status, 200, \`the check answered \${r.status}: \${r.text}\`);
  assert(r.json().duplicate === true && JSON.stringify(r.json().match) === JSON.stringify({record_id: 'r-7', key_type: 'phone_hash'}), \`r-7 holds the phone hash of the second key and the check answered \${r.text}: every key must be looked up, not the first\`);
  r = await check(c, [key('content_hash', OTHER), key('email_hash', OTHER)]);
  assert.equal(r.json().duplicate, false, \`no key is held and the check answered \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"dedupe/exact"

	"leetbuild/harness"
)

const (
	apiEmail = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d"
	apiPhone = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00"
	apiOther = "86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d"
	apiSHA1  = "0850a4cffb73cbc53fd33e8990c2184c915ff041"
)

type checkReply struct {
	Duplicate bool              \`json:"duplicate"\`
	Match     map[string]string \`json:"match"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func seed(ctx *harness.Ctx, tenant, keyType, value, recordID string) {
	_, err := exact.Claim(context.Background(), tenant, keyType, value, recordID)
	ctx.NoError(err, "seeding the index")
}

func key(keyType, value string) map[string]string {
	return map[string]string{"type": keyType, "value": value}
}

func post(c *harness.HTTP, tenant string, keys ...map[string]string) *harness.Response {
	body := map[string]any{"keys": keys}
	if tenant == "" {
		return c.Post("/v1/dedupe/check", body)
	}
	return c.Post("/v1/dedupe/check", body, "X-Tenant-Id", tenant)
}

func reply(r *harness.Response) checkReply {
	var out checkReply
	r.Decode(&out)
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	seed(ctx, "acme", "email_hash", apiEmail, "r-1")
	r := post(c, "acme", key("email_hash", apiEmail))
	ctx.Equal(r.Status, 200, "POST /v1/dedupe/check (%s)", r.Text())
	got := reply(r)
	ctx.Assert(got.Duplicate && got.Match["record_id"] == "r-1", "acme holds this email hash as r-1 and the check answered %s", r.Text())
	r = post(c, "acme", key("email_hash", apiOther))
	got = reply(r)
	ctx.Assert(r.Status == 200 && !got.Duplicate && got.Match == nil, "a key nobody holds answered %d %s, expected 200 with duplicate false", r.Status, r.Text())
}

func CheckKeyType(ctx *harness.Ctx) {
	c := api(ctx)
	seed(ctx, "acme", "email_hash", apiEmail, "r-1")
	for _, bad := range []string{"emial_hash", "ssn"} {
		r := post(c, "acme", key(bad, apiOther))
		ctx.Equal(r.Status, 400, "a key of type %q answered %s: an unknown type is a client bug, not \\"no duplicate\\"; the status", bad, r.Text())
	}
	r := post(c, "acme", key("email_hash", apiEmail), key("tax_id", apiOther))
	ctx.Equal(r.Status, 400, "a body with an unknown key type after a valid one must be rejected before any lookup (%s); the status", r.Text())
	for _, good := range []string{"email_hash", "content_hash", "phone_hash"} {
		r := post(c, "acme", key(good, apiOther))
		ctx.Equal(r.Status, 200, "a %s key (%s); the status", good, r.Text())
	}
}

func CheckHashShape(ctx *harness.Ctx) {
	c := api(ctx)
	seed(ctx, "acme", "email_hash", "jane@example.com", "r-1")
	bad := [][2]string{
		{"jane@example.com", "a raw email"},
		{apiSHA1, "a 40-character SHA-1"},
		{strings.ToUpper(apiEmail), "an uppercase digest"},
		{apiEmail[:63], "a 63-character value"},
	}
	for _, b := range bad {
		r := post(c, "acme", key("email_hash", b[0]))
		ctx.Equal(r.Status, 400, "%s as the email_hash value answered %s: only a lowercase SHA-256 hex digest may reach the index; the status", b[1], r.Text())
	}
	r := post(c, "acme", key("email_hash", apiEmail))
	ctx.Equal(r.Status, 200, "a lowercase SHA-256 digest (%s); the status", r.Text())
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := api(ctx)
	seed(ctx, "globex", "email_hash", apiEmail, "r-9")
	r := post(c, "acme", key("email_hash", apiEmail))
	ctx.Equal(r.Status, 200, "acme's check (%s)", r.Text())
	ctx.Assert(!reply(r).Duplicate && !strings.Contains(r.Text(), "r-9") && !strings.Contains(r.Text(), "globex"), "acme's check answered %s: it confirms, and names, a record globex holds. Look up the caller's tenant only", r.Text())
	r = post(c, "", key("email_hash", apiEmail))
	ctx.Equal(r.Status, 401, "a check without X-Tenant-Id (%s); the status", r.Text())
	seed(ctx, "acme", "email_hash", apiEmail, "r-1")
	r = post(c, "acme", key("email_hash", apiEmail))
	ctx.Equal(r.Status, 200, "acme's own duplicate (%s); the status", r.Text())
	ctx.Equal(reply(r).Match, map[string]string{"record_id": "r-1", "key_type": "email_hash"}, "acme's own duplicate must answer the record id and the key type and nothing about any tenant; the match")
}

func CheckEveryKey(ctx *harness.Ctx) {
	c := api(ctx)
	seed(ctx, "acme", "phone_hash", apiPhone, "r-7")
	r := post(c, "acme", key("email_hash", apiOther), key("phone_hash", apiPhone))
	ctx.Equal(r.Status, 200, "the check (%s)", r.Text())
	got := reply(r)
	ctx.Assert(got.Duplicate, "r-7 holds the phone hash of the second key and the check answered %s: every key must be looked up, not the first", r.Text())
	ctx.Equal(got.Match, map[string]string{"record_id": "r-7", "key_type": "phone_hash"}, "the match for the second key")
	r = post(c, "acme", key("content_hash", apiOther), key("email_hash", apiOther))
	ctx.Assert(!reply(r).Duplicate, "no key is held and the check answered %s", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <cctype>
#include <utility>
#include <vector>

#include "dedupe/exact.h"

namespace {

const std::string kEmail = "8c87b489ce35cf2e2f39f80e282cb2e804932a56a213983eeeb428407d43b52d";
const std::string kPhone = "602cd7fbbe41688e2d90224bcac362db2f1ff2e2ba7487d8585c9ce226cb6d00";
const std::string kOther = "86e0b9e56c17cc4d12387e1949b85053fbe73bc3ce5a1188713a9d300cc6133d";
const std::string kSha1 = "0850a4cffb73cbc53fd33e8990c2184c915ff041";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json key(const std::string& type, const std::string& value) { return {{"type", type}, {"value", value}}; }

harness::Response post(harness::HTTP& c, const std::string& tenant, const std::vector<nlohmann::json>& keys) {
  const std::string body = nlohmann::json{{"keys", keys}}.dump();
  if (tenant.empty()) return c.Post("/v1/dedupe/check", body, "Content-Type", "application/json");
  return c.Post("/v1/dedupe/check", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

nlohmann::json reply(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

bool duplicate(const nlohmann::json& body) { return body.value("duplicate", false); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  exact::claim("acme", "email_hash", kEmail, "r-1");
  auto r = post(c, "acme", {key("email_hash", kEmail)});
  ctx.Equal(r.Status, 200, "POST /v1/dedupe/check (%s)", r.Text());
  auto body = reply(r);
  ctx.Assert(duplicate(body) && body["match"].is_object() && body["match"].value("record_id", "") == "r-1", "acme holds this email hash as r-1 and the check answered %s", r.Text());
  r = post(c, "acme", {key("email_hash", kOther)});
  body = reply(r);
  ctx.Assert(r.Status == 200 && !duplicate(body) && body.contains("match") && body["match"].is_null(), "a key nobody holds answered %d %s, expected 200 with duplicate false", r.Status, r.Text());
}

void CheckKeyType(harness::Ctx& ctx) {
  auto c = api(ctx);
  exact::claim("acme", "email_hash", kEmail, "r-1");
  for (const std::string bad : {"emial_hash", "ssn"}) {
    const auto r = post(c, "acme", {key(bad, kOther)});
    ctx.Equal(r.Status, 400, "a key of type %q answered %s: an unknown type is a client bug, not \\"no duplicate\\"; the status", bad, r.Text());
  }
  const auto mixed = post(c, "acme", {key("email_hash", kEmail), key("tax_id", kOther)});
  ctx.Equal(mixed.Status, 400, "a body with an unknown key type after a valid one must be rejected before any lookup (%s); the status", mixed.Text());
  for (const std::string good : {"email_hash", "content_hash", "phone_hash"}) {
    const auto r = post(c, "acme", {key(good, kOther)});
    ctx.Equal(r.Status, 200, "a %s key (%s); the status", good, r.Text());
  }
}

void CheckHashShape(harness::Ctx& ctx) {
  auto c = api(ctx);
  exact::claim("acme", "email_hash", "jane@example.com", "r-1");
  std::string upper = kEmail;
  for (char& ch : upper) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
  const std::vector<std::pair<std::string, std::string>> bad = {
      {"jane@example.com", "a raw email"}, {kSha1, "a 40-character SHA-1"}, {upper, "an uppercase digest"}, {kEmail.substr(0, 63), "a 63-character value"}};
  for (const auto& [value, what] : bad) {
    const auto r = post(c, "acme", {key("email_hash", value)});
    ctx.Equal(r.Status, 400, "%s as the email_hash value answered %s: only a lowercase SHA-256 hex digest may reach the index; the status", what, r.Text());
  }
  const auto r = post(c, "acme", {key("email_hash", kEmail)});
  ctx.Equal(r.Status, 200, "a lowercase SHA-256 digest (%s); the status", r.Text());
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  exact::claim("globex", "email_hash", kEmail, "r-9");
  auto r = post(c, "acme", {key("email_hash", kEmail)});
  ctx.Equal(r.Status, 200, "acme's check (%s)", r.Text());
  ctx.Assert(!duplicate(reply(r)) && r.Text().find("r-9") == std::string::npos && r.Text().find("globex") == std::string::npos,
             "acme's check answered %s: it confirms, and names, a record globex holds. Look up the caller's tenant only", r.Text());
  r = post(c, "", {key("email_hash", kEmail)});
  ctx.Equal(r.Status, 401, "a check without X-Tenant-Id (%s); the status", r.Text());
  exact::claim("acme", "email_hash", kEmail, "r-1");
  r = post(c, "acme", {key("email_hash", kEmail)});
  ctx.Equal(r.Status, 200, "acme's own duplicate (%s); the status", r.Text());
  ctx.Equal(reply(r)["match"], nlohmann::json{{"record_id", "r-1"}, {"key_type", "email_hash"}},
            "acme's own duplicate must answer the record id and the key type and nothing about any tenant; the match");
}

void CheckEveryKey(harness::Ctx& ctx) {
  auto c = api(ctx);
  exact::claim("acme", "phone_hash", kPhone, "r-7");
  auto r = post(c, "acme", {key("email_hash", kOther), key("phone_hash", kPhone)});
  ctx.Equal(r.Status, 200, "the check (%s)", r.Text());
  ctx.Assert(duplicate(reply(r)), "r-7 holds the phone hash of the second key and the check answered %s: every key must be looked up, not the first", r.Text());
  ctx.Equal(reply(r)["match"], nlohmann::json{{"record_id", "r-7"}, {"key_type", "phone_hash"}}, "the match for the second key");
  r = post(c, "acme", {key("content_hash", kOther), key("email_hash", kOther)});
  ctx.Assert(!duplicate(reply(r)), "no key is held and the check answered %s", r.Text());
}
`,
  },
  hints: [
    'Authenticated as acme, check an email hash only globex holds: the answer is a duplicate with globex\'s record id and tenant. Send `emial_hash`, or a raw address as the value, and the answer is "no duplicate".',
    "`lookup_global` scans every tenant's index and returns the first holder; the handler reads `keys[0]` and nothing else; and nothing checks the type or the digest first, so a bad key simply finds nothing.",
    'Read `X-Tenant-Id` (401 when absent); answer 400 for a type outside `ALLOWED_KEY_TYPES` or a value `HASH_RE` does not fully match; then call `exact.lookup(tenant, type, value)` for every key and answer `record_id` and `key_type` only.',
  ],
  debrief: `The tenant belongs in the lookup, not in a filter on the answer: a lookup that stays inside \`t:{tenant}:\` cannot confirm another tenant's customer however the response is shaped, which is why the fix swaps the call rather than deleting \`tenant_id\` from the reply. Validation runs before the lookup because an index answers "absent" for anything it was not given, so a misspelled type or a raw email can only surface as a 400. Every key is looked up because records rarely share every identifier: the phone matches when the email changed. Production services take the tenant from the authenticated principal rather than a header, and rate-limit checks per tenant so the endpoint cannot be used to enumerate digests.`,
};
