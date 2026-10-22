import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/dedupe/check: candidate checks scoped to the tenant',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a match. It compiles, it serves the demo, and it hides four production flaws.
Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/dedupe/check\` with body \`{"keys": [{"type": "email_hash", "value": "…"}], "fuzzy": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`keys\` is a non-empty array; each \`type\` must be one of \`email_hash\`, \`content_hash\`,
  \`phone_hash\` (**400** for anything else), and each \`value\` must be a 64-character lowercase
  SHA-256 hex digest (**400** otherwise).
- \`fuzzy\` is optional and, when present, at most 512 characters (**400** otherwise).
- The comparison runs inside the caller's tenant only: the index namespace is derived from the tenant
  (\`t:{tenant}\`) and the fuzzy lookup is scoped the same way. A check must never read a global
  index shared across tenants.
- A hit is a record of the caller's tenant; the response returns its \`record_id\` and the matching
  \`key_type\`. It never returns another tenant's record id or tenant id.
- A check with no \`fuzzy\` text is an exact-only check and says so in the response.

**Failure mode the checks target.** Querying a global similarity index lets one tenant's check
confirm — and name — another tenant's record, which is a cross-tenant data leak dressed up as a
duplicate. The draft does exactly that, and it validates neither the key type nor the hash shape, so a
raw value can reach the index and a typo in a key type silently becomes "no match".`,
  sequence: {
    participants: ['Client', 'Dedupe API', 'Redis', 'record store'],
    messages: [
      {from: 'Client', to: 'Dedupe API', label: 'POST /v1/dedupe/check · X-Tenant-Id', kind: 'sync'},
      {from: 'Dedupe API', to: 'Dedupe API', label: 'validate tenant · key types · hashes', kind: 'sync'},
      {from: 'Dedupe API', to: 'Redis', label: 'lookup(scope=t:{tenant}, key)', kind: 'sync'},
      {from: 'Redis', to: 'Dedupe API', label: 'hit / miss', kind: 'reply'},
      {from: 'Dedupe API', to: 'record store', label: 'load(record_id) on hit', kind: 'sync'},
      {from: 'Dedupe API', to: 'Client', label: '200 {match, exact_only}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/dedupe/check',
      detail: 'Register the check route on `POST /v1/dedupe/check`.',
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
      title: 'Whitelists the key types',
      detail:
        'Each key `type` must be one of `email_hash`/`content_hash`/`phone_hash` and anything else is **400**. The draft accepts any string as a key type, so a typo silently becomes "no match".',
      match: {
        python: {all: [/ALLOWED_KEY_TYPES/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_KEY_TYPES/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedKeyTypes/, /StatusBadRequest/]},
        scala: {all: [/AllowedKeyTypes/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedKeyTypes/, /\b400\b/]},
      },
    },
    {
      id: 'validate',
      title: 'Requires 64-hex SHA-256 key values',
      detail:
        'Every key `value` must be a 64-character lowercase hex digest (**400** otherwise), so a raw value never reaches the index. The draft validates neither the key nor the hash.',
      match: {
        python: {all: [/HASH_RE/, /\b64\b/]},
        typescript: {all: [/HASH_RE/, /\b64\b/]},
        go: {all: [/hashRe/, /\b64\b/]},
        scala: {all: [/HashRe/, /\b64\b/]},
        cpp: {all: [/kHashRe/, /\b64\b/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the comparison to the tenant',
      detail:
        "The index namespace is derived from the tenant (`t:{tenant}`) before any lookup or fuzzy comparison, so a check cannot read another tenant's corpus. The draft queries a global similarity index shared by every tenant.",
      match: {
        python: {all: [/tenant_scope\(/], none: [/global_?similarity/i]},
        typescript: {all: [/tenantScope\(/], none: [/global_?similarity/i]},
        go: {all: [/tenantScope\(/], none: [/global_?similarity/i]},
        scala: {all: [/tenantScope\(/], none: [/global_?similarity/i]},
        cpp: {all: [/tenant_scope\(/], none: [/global_?similarity/i]},
      },
    },
    {
      id: 'no-foreign-id',
      title: "Never names another tenant's record",
      detail:
        "The hit returned is the caller's `record_id` and its `key_type`; a foreign tenant id is never echoed in the response. The draft returns the matched record's tenant id, confirming the existence of another tenant's record.",
      match: {
        python: {all: [/record_id/], none: [/\btenant_id\b/]},
        typescript: {all: [/record_id/], none: [/\btenant_id\b/]},
        go: {all: [/record_id|RecordID/], none: [/\btenant_id\b/]},
        scala: {all: [/record_id|recordId/], none: [/\btenant_id\b/]},
        cpp: {all: [/record_id/], none: [/\btenant_id\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class ExactKey(BaseModel):
    type: str
    value: str


class CheckRequest(BaseModel):
    keys: list[ExactKey]
    fuzzy: str | None = None


class GlobalSimilarityIndex:
    def search(self, candidate: str) -> dict:
        """Index shared by every tenant."""
        raise NotImplementedError


GLOBAL_SIMILARITY_INDEX = GlobalSimilarityIndex()


@app.post("/v1/dedupe/check")
def check(body: CheckRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft compares the candidate against a global similarity index, returns the matched
    # tenant's record id, and validates neither the key type nor the hash. Review all three.
    candidate = " ".join(key.value for key in body.keys)
    hit = GLOBAL_SIMILARITY_INDEX.search(candidate)
    if hit is None:
        return JSONResponse({"match": None}, status_code=200)
    return JSONResponse(
        {"match": {"record_id": hit["record_id"], "tenant_id": hit["tenant_id"]}},
        status_code=200,
    )
`,
      solution: `import re
from typing import Any

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

ALLOWED_KEY_TYPES = {"email_hash", "content_hash", "phone_hash"}
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_FUZZY_CHARS = 512


class ExactKey(BaseModel):
    type: str
    value: str


class CheckRequest(BaseModel):
    keys: list[ExactKey]
    fuzzy: str | None = None


def tenant_scope(tenant: str) -> str:
    """Namespace for one tenant's corpus; never shared across tenants."""
    return f"t:{tenant}"


def resolve_similarity(scope: str, candidate: dict) -> dict:
    """Similarity lookup constrained to one tenant's scope."""
    raise NotImplementedError


class TenantCorpus:
    def lookup(self, scope: str, key: ExactKey) -> dict[str, Any] | None:
        """Look up one exact key inside a tenant's scope only."""
        raise NotImplementedError


key_sets = TenantCorpus()


@app.post("/v1/dedupe/check")
def check(body: CheckRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    if not body.keys:
        return JSONResponse({"error": "keys must not be empty"}, status_code=400)
    for key in body.keys:
        if key.type not in ALLOWED_KEY_TYPES:
            return JSONResponse({"error": "unknown key type"}, status_code=400)
        if HASH_RE.match(key.value) is None:
            return JSONResponse({"error": "keys must be sha-256 hex"}, status_code=400)
    if body.fuzzy is not None and len(body.fuzzy) > MAX_FUZZY_CHARS:
        return JSONResponse({"error": "fuzzy text too long"}, status_code=400)

    scope = tenant_scope(tenant)
    for key in body.keys:
        hit = key_sets.lookup(scope, key)
        if hit is not None:
            # The hit belongs to the caller's tenant; a foreign tenant id is never echoed.
            return JSONResponse(
                {"match": {"record_id": hit["record_id"], "key_type": key.type}, "exact_only": True},
                status_code=200,
            )
    if body.fuzzy is None:
        return JSONResponse({"match": None, "exact_only": True}, status_code=200)
    # The fuzzy search runs over the same tenant's candidates, never a global index.
    candidate = {"keys": [k.value for k in body.keys], "fuzzy": body.fuzzy}
    resolution = resolve_similarity(scope, candidate)
    return JSONResponse(
        {"match": resolution, "exact_only": resolution.get("exact_only", False)},
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

const app = Fastify({logger: true});

interface ExactKey {
  type: string;
  value: string;
}

interface CheckBody {
  keys: ExactKey[];
  fuzzy?: string;
}

class GlobalSimilarityIndex {
  async search(candidate: string): Promise<{record_id: string; tenant_id: string} | null> {
    return null;
  }
}

const GLOBAL_SIMILARITY_INDEX = new GlobalSimilarityIndex();

app.post('/v1/dedupe/check', async (request, reply) => {
  // TODO: this draft compares the candidate against a global similarity index, returns the matched
  // tenant's record id, and validates neither the key type nor the hash. Review all three.
  const body = request.body as CheckBody;
  const candidate = body.keys.map(k => k.value).join(' ');
  const hit = await GLOBAL_SIMILARITY_INDEX.search(candidate);
  if (hit === null) return reply.code(200).send({match: null});
  return reply.code(200).send({match: {record_id: hit.record_id, tenant_id: hit.tenant_id}});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `import Fastify from 'fastify';

const app = Fastify({logger: true});

const ALLOWED_KEY_TYPES: Record<string, true> = {email_hash: true, content_hash: true, phone_hash: true};
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_FUZZY_CHARS = 512;

interface ExactKey {
  type: string;
  value: string;
}

interface CheckBody {
  keys: ExactKey[];
  fuzzy?: string;
}

interface Hit {
  record_id: string;
  key_type: string;
}

function tenantScope(tenant: string): string {
  // Namespace for one tenant's corpus; never shared across tenants.
  return 't:' + tenant;
}

class TenantCorpus {
  async lookup(scope: string, key: ExactKey): Promise<Hit | null> {
    return null;
  }
}

const keySets = new TenantCorpus();

app.post('/v1/dedupe/check', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as CheckBody;
  if (!Array.isArray(body.keys) || body.keys.length === 0)
    return reply.code(400).send({error: 'keys must not be empty'});
  for (const key of body.keys) {
    if (ALLOWED_KEY_TYPES[key.type] !== true)
      return reply.code(400).send({error: 'unknown key type'});
    if (!HASH_RE.test(key.value))
      return reply.code(400).send({error: 'keys must be sha-256 hex'});
  }
  if (body.fuzzy !== undefined && body.fuzzy.length > MAX_FUZZY_CHARS)
    return reply.code(400).send({error: 'fuzzy text too long'});

  const scope = tenantScope(tenant);
  for (const key of body.keys) {
    const hit = await keySets.lookup(scope, key);
    if (hit !== null)
      return reply.code(200).send({match: {record_id: hit.record_id, key_type: key.type}, exact_only: true});
  }
  if (body.fuzzy === undefined)
    return reply.code(200).send({match: null, exact_only: true});
  const resolution = await resolveSimilarity(scope, {keys: body.keys.map(k => k.value), fuzzy: body.fuzzy});
  return reply.code(200).send({match: resolution, exact_only: false});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

type ExactKey struct {
	Type  string \`json:"type"\`
	Value string \`json:"value"\`
}

type CheckBody struct {
	Keys []ExactKey \`json:"keys"\`
}

type GlobalSimilarityIndex struct{}

func (g *GlobalSimilarityIndex) Search(candidate string) (map[string]string, error) {
	return nil, nil
}

var globalSimilarityIndex = &GlobalSimilarityIndex{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func check(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft compares the candidate against a global similarity index, returns the matched
	// tenant's record id, and validates neither the key type nor the hash. Review all three.
	var body CheckBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	candidate := ""
	for _, key := range body.Keys {
		candidate += key.Value + " "
	}
	hit, _ := globalSimilarityIndex.Search(candidate)
	if hit == nil {
		writeJSON(rw, http.StatusOK, map[string]any{"match": nil})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"match": map[string]any{"record_id": hit["record_id"], "tenant_id": hit["tenant_id"]},
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/dedupe/check", check)
	http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"
)

const maxFuzzyChars = 512

var (
	allowedKeyTypes = map[string]bool{"email_hash": true, "content_hash": true, "phone_hash": true}
	hashRe          = regexp.MustCompile("^[0-9a-f]{64}$")
)

type ExactKey struct {
	Type  string \`json:"type"\`
	Value string \`json:"value"\`
}

type CheckBody struct {
	Keys  []ExactKey \`json:"keys"\`
	Fuzzy *string    \`json:"fuzzy"\`
}

type Hit struct {
	RecordID string \`json:"record_id"\`
	KeyType  string \`json:"key_type"\`
}

func tenantScope(tenant string) string {
	// Namespace for one tenant's corpus; never shared across tenants.
	return "t:" + tenant
}

type TenantCorpus struct{}

func (c *TenantCorpus) Lookup(scope string, key ExactKey) (*Hit, error) {
	return nil, nil
}

var keySets = &TenantCorpus{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func check(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body CheckBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Keys) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "keys must not be empty"})
		return
	}
	for _, key := range body.Keys {
		if !allowedKeyTypes[key.Type] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown key type"})
			return
		}
		if !hashRe.MatchString(key.Value) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "keys must be sha-256 hex"})
			return
		}
	}
	if body.Fuzzy != nil && len(*body.Fuzzy) > maxFuzzyChars {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "fuzzy text too long"})
		return
	}
	scope := tenantScope(tenant)
	for _, key := range body.Keys {
		hit, err := keySets.Lookup(scope, key)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		if hit != nil {
			writeJSON(rw, http.StatusOK, map[string]any{
				"match":      map[string]any{"record_id": hit.RecordID, "key_type": key.Type},
				"exact_only": true,
			})
			return
		}
	}
	if body.Fuzzy == nil {
		writeJSON(rw, http.StatusOK, map[string]any{"match": nil, "exact_only": true})
		return
	}
	resolution := resolveSimilarity(scope, *body.Fuzzy)
	writeJSON(rw, http.StatusOK, map[string]any{"match": resolution, "exact_only": false})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/dedupe/check", check)
	http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ExactKey(\`type\`: String, value: String)
final case class CheckRequest(keys: List[ExactKey], fuzzy: Option[String])
final case class Hit(record_id: String, tenant_id: String)

trait GlobalSimilarityIndex {
  def search(candidate: String): Option[Hit]
}

object DedupeApi {
  implicit val system: ActorSystem = ActorSystem("dedupe-service")
  implicit val keyFormat: RootJsonFormat[ExactKey] = jsonFormat2(ExactKey)
  implicit val checkFormat: RootJsonFormat[CheckRequest] = jsonFormat2(CheckRequest)

  val GlobalSimilarity = new GlobalSimilarityIndex {
    def search(candidate: String): Option[Hit] = None
  }

  val route: Route =
    path("v1" / "dedupe" / "check") {
      post {
        entity(as[CheckRequest]) { body =>
          // TODO: this draft compares the candidate against a global similarity index, returns the
          // matched tenant's record id, and validates neither the key type nor the hash.
          val candidate = body.keys.map(_.value).mkString(" ")
          GlobalSimilarity.search(candidate) match {
            case Some(hit) =>
              complete(
                StatusCodes.OK,
                s"""{"match":{"record_id":"\${hit.record_id}","tenant_id":"\${hit.tenant_id}"}}""")
            case None =>
              complete(StatusCodes.OK, """{"match":null}""")
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ExactKey(\`type\`: String, value: String)
final case class CheckRequest(keys: List[ExactKey], fuzzy: Option[String])
final case class Hit(record_id: String, key_type: String)

trait TenantCorpus {
  def lookup(scope: String, key: ExactKey): Option[Hit]
}

object DedupeApi {
  implicit val system: ActorSystem = ActorSystem("dedupe-service")
  implicit val keyFormat: RootJsonFormat[ExactKey] = jsonFormat2(ExactKey)
  implicit val checkFormat: RootJsonFormat[CheckRequest] = jsonFormat2(CheckRequest)

  val AllowedKeyTypes = Set("email_hash", "content_hash", "phone_hash")
  val HashRe = "^[0-9a-f]{64}$".r
  val MaxFuzzyChars = 512

  def tenantScope(tenant: String): String =
    "t:" + tenant

  val keySets = new TenantCorpus {
    def lookup(scope: String, key: ExactKey): Option[Hit] = None
  }

  val route: Route =
    path("v1" / "dedupe" / "check") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[CheckRequest]) { body =>
            val tenant = tenantOpt.filter(_.nonEmpty)
            if (tenant.isEmpty) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (body.keys.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"keys must not be empty"}""")
            } else if (body.keys.exists(k => !AllowedKeyTypes.contains(k.\`type\`))) {
              complete(StatusCodes.BadRequest, """{"error":"unknown key type"}""")
            } else if (body.keys.exists(k => HashRe.findFirstIn(k.value).isEmpty)) {
              complete(StatusCodes.BadRequest, """{"error":"keys must be sha-256 hex"}""")
            } else if (body.fuzzy.exists(_.length > MaxFuzzyChars)) {
              complete(StatusCodes.BadRequest, """{"error":"fuzzy text too long"}""")
            } else {
              val scope = tenantScope(tenant.get)
              body.keys.iterator
                .map(key => keySets.lookup(scope, key))
                .collectFirst { case Some(hit) => hit } match {
                case Some(hit) =>
                  complete(
                    StatusCodes.OK,
                    s"""{"match":{"record_id":"\${hit.record_id}","key_type":"\${hit.key_type}"},"exact_only":true}""")
                case None =>
                  complete(StatusCodes.OK, """{"match":null,"exact_only":true}""")
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

#include <string>

using json = nlohmann::json;

struct GlobalSimilarityIndex {
  json search(const std::string& candidate);
};

GlobalSimilarityIndex GLOBAL_SIMILARITY_INDEX;

int main() {
  httplib::Server svr;

  svr.Post("/v1/dedupe/check", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft compares the candidate against a global similarity index, returns the
    // matched tenant's record id, and validates neither the key type nor the hash. Review all three.
    json body = json::parse(req.body, nullptr, false);
    std::string candidate;
    for (const auto& key : body.value("keys", json::array())) {
      candidate += key.value("value", std::string()) + " ";
    }
    const json hit = GLOBAL_SIMILARITY_INDEX.search(candidate);
    if (hit.is_null()) {
      res.status = 200;
      res.set_content(R"({"match":null})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(
        json{{"match", json{{"record_id", hit["record_id"]}, {"tenant_id", hit["tenant_id"]}}}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kAllowedKeyTypes = {"email_hash", "content_hash", "phone_hash"};
const std::regex kHashRe("^[0-9a-f]{64}$");
constexpr std::size_t kMaxFuzzyChars = 512;

std::string tenant_scope(const std::string& tenant) {
  // Namespace for one tenant's corpus; never shared across tenants.
  return "t:" + tenant;
}

json resolve_similarity(const std::string& scope, const json& candidate);
json find_exact(const std::string& scope, const json& body);

int main() {
  httplib::Server svr;

  svr.Post("/v1/dedupe/check", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("keys") || !body["keys"].is_array() || body["keys"].empty()) {
      res.status = 400;
      res.set_content(R"({"error":"keys must not be empty"})", "application/json");
      return;
    }
    for (const auto& key : body["keys"]) {
      const auto keyType = key.value("type", std::string());
      if (kAllowedKeyTypes.count(keyType) == 0) {
        res.status = 400;
        res.set_content(R"({"error":"unknown key type"})", "application/json");
        return;
      }
      const auto value = key.value("value", std::string());
      if (!std::regex_match(value, kHashRe)) {
        res.status = 400;
        res.set_content(R"({"error":"keys must be sha-256 hex"})", "application/json");
        return;
      }
    }
    if (body.contains("fuzzy") && body["fuzzy"].is_string() &&
        body["fuzzy"].get<std::string>().size() > kMaxFuzzyChars) {
      res.status = 400;
      res.set_content(R"({"error":"fuzzy text too long"})", "application/json");
      return;
    }
    const auto scope = tenant_scope(tenant);
    const json hit = find_exact(scope, body);
    if (!hit.is_null()) {
      res.status = 200;
      res.set_content(
          json{{"match", json{{"record_id", hit["record_id"]}, {"key_type", hit["key_type"]}}},
               {"exact_only", true}}
              .dump(),
          "application/json");
      return;
    }
    if (!body.contains("fuzzy")) {
      res.status = 200;
      res.set_content(R"({"match":null,"exact_only":true})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"match", resolve_similarity(scope, body)}, {"exact_only", false}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Scope the comparison first: derive the index namespace from the tenant (`t:{tenant}`) and pass it to every lookup and to the similarity call. A check that reads a shared index is a cross-tenant read, however fast it is.',
    'Validate before you compare: whitelist the key types and require a 64-hex digest per value. A raw value in the index is both a privacy leak and a silent miss when the next request sends the hash.',
    "The response is part of the contract: return the caller's `record_id` and the matching `key_type`, and never echo a tenant id. If you want the tenant in the payload for debugging, you already have it in the header.",
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the isolation boundary. The draft reads fine because the demo has one tenant and well-formed keys. Four defects are being checked: the comparison scope (a global index leaks across tenants), key-type validation (a typo silently becomes "no match"), hash validation (raw values reach the index), and the response payload (returning another tenant's record id confirms its existence). The fix is small but the reasoning is the interview: dedupe is a read over other people's data, so the search space is part of the security boundary. Real services add per-tenant key-type registries, constant-time lookups to avoid timing leaks, and an audit log of which tenant ran which check — without ever logging the values.`,
};
