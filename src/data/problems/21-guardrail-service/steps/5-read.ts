import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/guardrails/policies: the contract reviewers read',
  concept: 'http',
  file: 'read',
  focus: ['guardrail', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it returns the rule set the
caller asked for and it caches it, so the demo is fast and the JSON looks right. It answers whatever
version the query string names, it hands back an unbounded rule list, and its cache outlives the
promotion that should have changed the answer. Review it, fix it, and prove the fix with the checks
below.

Implement \`GET /v1/guardrails/policies\` — the read reviewers and audits use to see what is active.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`?version=\` selects history. A version that does not exist for that tenant is **404** — never the
  active set with the caller's version pasted on. The draft returns whatever version the query string
  names, so a reviewer can read a rule set that was never promoted under that tenant.
- The active read returns the **version number** and the **promotion time**, so a reviewer can prove
  which ruleset answered a request and when it went live.
- A large rule set is **capped and paged**: \`page_size\` defaults to 50 and may not exceed
  \`MAX_PAGE_SIZE = 200\`, and the response carries \`page\`, \`page_size\`, \`total\` and the page of
  \`rules\`. The draft returns every rule in one body, so one tenant with thousands of rules turns a
  policy read into a multi-megabyte response.
- The cache is keyed by tenant **and version**, and its entry **expires** (\`CACHE_TTL_S = 5\`,
  \`EX\`). A promotion **deletes** the cached active entry, so the very next read sees the new
  version instead of the previous release's rules. The draft caches the active set under a key with no
  version and no TTL, so a promotion is invisible until the process restarts.

**Failure mode the checks target.** The unknown version is the subtle one: pasting the requested
version into a response whose rules came from the active set is worse than an error, because it
misrepresents policy history during an audit. The stale cache is the loud one — a reviewer reads the
old rules and approves traffic that the new ruleset blocks — and the unbounded page is the quiet one
that only shows up on the tenant with the largest policy.`,
  sequence: {
    participants: ['Reviewer', 'Guardrail Service', 'Redis', 'Policy Store'],
    messages: [
      {from: 'Reviewer', to: 'Guardrail Service', label: 'GET /v1/guardrails/policies?version=…', kind: 'sync'},
      {from: 'Guardrail Service', to: 'Redis', label: 'GET guardrails:policies:{tenant}:{version}', kind: 'sync'},
      {from: 'Redis', to: 'Guardrail Service', label: 'hit → cached page · miss → read the store', kind: 'reply'},
      {from: 'Guardrail Service', to: 'Policy Store', label: 'getVersion(tenant, version) / getActive', kind: 'sync'},
      {
        from: 'Policy Store',
        to: 'Guardrail Service',
        label: 'nil → 404 · record → version + promoted_at',
        kind: 'reply',
      },
      {from: 'Guardrail Service', to: 'Redis', label: 'SET … EX 5 · DEL active key on promotion', kind: 'sync'},
    ],
  },
  hints: [
    'Resolve the version before you trust it: `get_version(tenant, version)` returns `None` for anything the tenant never promoted, and that is the **404** — the draft builds its answer from the active set and pastes the requested version on top.',
    'Page at the edge: a `MAX_PAGE_SIZE = 200` bound on `page_size`, a default of 50, and a slice with `page`, `page_size` and `total` in the body. The draft serialises the whole rule set, so the largest tenant decides the response size.',
    'A promotion must be visible on the next read: key the cache by `tenant` + `version`, give the entry a TTL, and `DEL` the active key when a version is promoted. The draft’s version-less, non-expiring key keeps serving the previous release.',
  ],
  checks: [
    {
      id: 'unknown-version',
      title: 'Answers 404 for a version the tenant never promoted',
      detail:
        'The version is resolved against the store (`get_version(` / `getVersion(` / `GetVersion(`) and a missing one is **404**. The draft pastes the requested version onto the active rule set.',
      match: {
        python: {all: [/status_code=404/, /get_version\(/]},
        typescript: {all: [/code\(404\)/, /getVersion\(/]},
        go: {all: [/StatusNotFound/, /GetVersion\(/]},
        scala: {all: [/StatusCodes\.NotFound/, /getVersion\(/]},
        cpp: {all: [/\b404\b/, /getVersion\(/]},
      },
    },
    {
      id: 'capped-page-size',
      title: 'Caps page_size at MAX_PAGE_SIZE = 200',
      detail:
        'A `MAX_PAGE_SIZE = 200` upper bound is enforced on the page size — `le=MAX_PAGE_SIZE`, `maximum: MAX_PAGE_SIZE`, a comparison, or `Math.min`/`std::min`. The draft accepts any page size and returns the whole rule set.',
      match: {
        python: {all: [/MAX_PAGE_SIZE\s*=\s*200/, /le=MAX_PAGE_SIZE/]},
        typescript: {all: [/MAX_PAGE_SIZE\s*=\s*200/, /maximum:\s*MAX_PAGE_SIZE/]},
        go: {all: [/maxPageSize\s*=\s*200/, /if pageSize > maxPageSize/]},
        scala: {all: [/MaxPageSize\s*=\s*200/, /\bMath\.min\([^)]*MaxPageSize\)/]},
        cpp: {all: [/kMaxPageSize\s*=\s*200/, /std::min\([^)]*kMaxPageSize\)/]},
      },
    },
    {
      id: 'paged-rules',
      title: 'Returns one page of rules with page metadata',
      detail:
        'The response carries `page`, `page_size`, `total` and only the requested slice of `rules`. The draft serialises every rule in one body with no metadata.',
      match: {
        python: {all: [/total/, /rules\[start\s*:\s*start\s*\+\s*page_size\]/]},
        typescript: {all: [/total/, /rules\.slice\(start,\s*start\s*\+\s*pageSize\)/]},
        go: {all: [/"total"/, /[Rr]ules\[start:end\]/]},
        scala: {all: [/total/, /rules\.slice\(start,\s*start\s*\+\s*pageSize\)/]},
        cpp: {all: [/total/, /start\s*\+\s*pageSize/]},
      },
    },
    {
      id: 'cache-bust-on-promotion',
      title: 'A promotion invalidates the cached active set',
      detail:
        'Promoting a version deletes the cached active entry (`promotePolicy(…)` + `.del(`/`.Del(`), so the next read resolves the new version. The draft has no promotion path and its cache key carries no version.',
      match: {
        python: {all: [/def promote_policy\(/, /\.delete\(/]},
        typescript: {all: [/function promotePolicy\(/, /cache\.del\(/]},
        go: {all: [/func promotePolicy\(/, /\.Del\(/]},
        scala: {all: [/def promotePolicy\(/, /\.del\(/]},
        cpp: {all: [/promotePolicy\(/, /\.del\(|->del\(/]},
      },
    },
    {
      id: 'cache-ttl',
      title: 'Cache entries expire',
      detail:
        'Every cached policy page is written with a TTL — `CACHE_TTL_S = 5` with `ex=`, `EX`, `expire`, or an expiration argument — so a missed invalidation cannot serve stale rules indefinitely. The draft’s key never expires.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*5/, /ex=CACHE_TTL_S/]},
        typescript: {all: [/CACHE_TTL_S\s*=\s*5/, /'EX',\s*CACHE_TTL_S/]},
        go: {all: [/cacheTtlS\s*=\s*5/, /cacheTtlS\s*\*\s*time\.Second/]},
        scala: {all: [/CacheTtlS\s*=\s*5/, /\bexpire\([^)]*CacheTtlS\)/]},
        cpp: {all: [/kCacheTtlS\s*=\s*5/, /\bexpire\([^)]*kCacheTtlS\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

logger = logging.getLogger("guardrail")

app = FastAPI()


@app.get("/v1/guardrails/policies")
def get_policies(tenant: str = Header(..., alias="X-Tenant-Id"), version: str | None = None):
    # TODO: 404 a version the tenant never promoted, cap and page the rule set, key the cache by
    # tenant and version with a TTL, and delete the active entry when a version is promoted.
    key = f"guardrails:policies:{tenant}"
    cached = cache.get(key)
    if cached is not None:
        logger.info("policies cache hit tenant=%s", tenant)
        return json.loads(cached)
    rules = store.rules_for(tenant, version)
    body = {"tenant": tenant, "version": version, "rules": rules}
    cache.set(key, json.dumps(body))
    return body
`,
      solution: `import json

from fastapi import FastAPI, Header, Query
from fastapi.responses import JSONResponse

MAX_PAGE_SIZE = 200
CACHE_TTL_S = 5

app = FastAPI()


def active_key(tenant: str) -> str:
    return f"guardrails:policies:{tenant}:active"


def version_key(tenant: str, version: str) -> str:
    return f"guardrails:policies:{tenant}:{version}"


@app.get("/v1/guardrails/policies")
def get_policies(
    tenant: str = Header(..., alias="X-Tenant-Id"),
    version: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=MAX_PAGE_SIZE),
):
    if tenant == "":
        return JSONResponse(status_code=401, content={"error": "missing X-Tenant-Id"})

    key = active_key(tenant) if version is None else version_key(tenant, version)
    cached = cache.get(key)
    if cached is not None:
        return json.loads(cached)

    record = store.get_active(tenant) if version is None else store.get_version(tenant, version)
    if record is None:
        # A version the tenant never promoted is a 404, never the active set relabelled.
        return JSONResponse(status_code=404, content={"error": "unknown policy version"})

    rules = record["rules"]
    start = (page - 1) * page_size
    body = {
        "tenant": tenant,
        "version": record["version"],
        "promoted_at": record["promoted_at"],
        "page": page,
        "page_size": page_size,
        "total": len(rules),
        "rules": rules[start : start + page_size],
    }
    cache.set(key, json.dumps(body), ex=CACHE_TTL_S)
    return body


def promote_policy(tenant: str, version: str) -> None:
    """Publish the new active version and drop the cached page so the next read sees it."""
    store.promote(tenant, version)
    cache.delete(active_key(tenant))
`,
    },
    typescript: {
      starter: `/** GET /v1/guardrails/policies: a model-generated draft that serves whatever version it is handed. */
import Fastify from 'fastify';
import Redis from 'ioredis';

const cache = new Redis({host: 'redis', port: 6379});

const app = Fastify();

app.get('/v1/guardrails/policies', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const version = (request.query as {version?: string}).version;
  // TODO: 404 a version the tenant never promoted, cap and page the rule set, key the cache by
  // tenant and version with a TTL, and delete the active entry when a version is promoted.
  const cacheKey = \`guardrails:policies:\${tenant}\`;
  const cached = await cache.get(cacheKey);
  if (cached !== null) return JSON.parse(cached);
  const rules = await store.rulesFor(tenant, version);
  const body = {tenant, version, rules};
  await cache.set(cacheKey, JSON.stringify(body));
  return body;
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/guardrails/policies: the versioned, paged, invalidated read reviewers use. */
import Fastify from 'fastify';
import Redis from 'ioredis';

const MAX_PAGE_SIZE = 200;
const CACHE_TTL_S = 5;

const cache = new Redis({host: 'redis', port: 6379});

const app = Fastify();

function activeKey(tenant: string): string {
  return \`guardrails:policies:\${tenant}:active\`;
}

function versionKey(tenant: string, version: string): string {
  return \`guardrails:policies:\${tenant}:\${version}\`;
}

app.get(
  '/v1/guardrails/policies',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          version: {type: 'string'},
          page: {type: 'integer', minimum: 1},
          page_size: {type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE},
        },
      },
    },
  },
  async (request, reply) => {
    const tenant = request.headers['x-tenant-id'];
    if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

    const query = request.query as {version?: string; page?: number; page_size?: number};
    const version = query.version;
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(query.page_size ?? 50, MAX_PAGE_SIZE);

    const cacheKey = version === undefined ? activeKey(tenant) : versionKey(tenant, version);
    const cached = await cache.get(cacheKey);
    if (cached !== null) return JSON.parse(cached);

    const record = version === undefined ? await store.getActive(tenant) : await store.getVersion(tenant, version);
    if (record === null) return reply.code(404).send({error: 'unknown policy version'});

    const start = (page - 1) * pageSize;
    const body = {
      tenant,
      version: record.version,
      promoted_at: record.promoted_at,
      page,
      page_size: pageSize,
      total: record.rules.length,
      rules: record.rules.slice(start, start + pageSize),
    };
    await cache.set(cacheKey, JSON.stringify(body), 'EX', CACHE_TTL_S);
    return body;
  },
);

/** Publish the new active version and drop the cached page so the next read sees it. */
export async function promotePolicy(tenant: string, version: string): Promise<void> {
  await store.promote(tenant, version);
  await cache.del(activeKey(tenant));
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

func policiesHandler(w http.ResponseWriter, r *http.Request, store PolicyStore) {
	tenant := r.Header.Get("X-Tenant-Id")
	// TODO: 404 a version the tenant never promoted, cap and page the rule set, key the cache by
	// tenant and version with a TTL, and delete the active entry when a version is promoted.
	key := "guardrails:policies:" + tenant
	if cached, err := rdb.Get(r.Context(), key).Bytes(); err == nil {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(cached)
		return
	}
	rules, _ := store.RulesFor(r.Context(), tenant)
	body := map[string]any{"tenant": tenant, "version": r.URL.Query().Get("version"), "rules": rules}
	payload, _ := json.Marshal(body)
	rdb.Set(r.Context(), key, payload)
	writeJSON(w, http.StatusOK, body)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

const (
	maxPageSize = 200
	cacheTtlS   = 5
)

func activeKey(tenant string) string  { return "guardrails:policies:" + tenant + ":active" }
func versionKey(tenant, version string) string {
	return "guardrails:policies:" + tenant + ":" + version
}

func policiesHandler(w http.ResponseWriter, r *http.Request, store PolicyStore) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}

	version := r.URL.Query().Get("version")
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if pageSize < 1 {
		pageSize = 50
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}

	key := activeKey(tenant)
	if version != "" {
		key = versionKey(tenant, version)
	}
	if cached, err := rdb.Get(r.Context(), key).Bytes(); err == nil {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(cached)
		return
	}

	var record *PolicyRecord
	var err error
	if version == "" {
		record, err = store.GetActive(r.Context(), tenant)
	} else {
		record, err = store.GetVersion(r.Context(), tenant, version)
	}
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "policy store unavailable"})
		return
	}
	if record == nil {
		// A version the tenant never promoted is a 404, never the active set relabelled.
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown policy version"})
		return
	}

	start := (page - 1) * pageSize
	end := start + pageSize
	if end > len(record.Rules) {
		end = len(record.Rules)
	}
	body := map[string]any{
		"tenant":      tenant,
		"version":     record.Version,
		"promoted_at": record.PromotedAt,
		"page":        page,
		"page_size":   pageSize,
		"total":       len(record.Rules),
		"rules":       record.Rules[start:end],
	}
	payload, _ := json.Marshal(body)
	rdb.Set(r.Context(), key, payload, cacheTtlS*time.Second)
	writeJSON(w, http.StatusOK, body)
}

// promotePolicy publishes the new active version and drops the cached page so the next read sees it.
func promotePolicy(ctx context.Context, tenant, version string, store PolicyStore) error {
	if err := store.Promote(ctx, tenant, version); err != nil {
		return err
	}
	return rdb.Del(ctx, activeKey(tenant)).Err()
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object GuardrailRead {
  implicit val system: ActorSystem = ActorSystem("guardrail-read")

  val redis = new Jedis("redis", 6379)

  val route: Route = (path("v1" / "guardrails" / "policies") & get) {
    optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
      val tenant = tenantOpt.getOrElse("")
      parameter("version".?) { versionOpt =>
        // TODO: 404 a version the tenant never promoted, cap and page the rule set, key the cache by
        // tenant and version with a TTL, and delete the active entry when a version is promoted.
        val key = s"guardrails:policies:${'$'}tenant"
        Option(redis.get(key)) match {
          case Some(cached) => complete(HttpEntity(ContentTypes.\`application/json\`, cached))
          case None =>
            val rules = store.rulesFor(tenant, versionOpt)
            val body = s"""{"tenant":"${'$'}tenant","version":"${'$'}{versionOpt.getOrElse("")}","rules":[${'$'}{rules.mkString(",")}]}"""
            redis.set(key, body)
            complete(HttpEntity(ContentTypes.\`application/json\`, body))
        }
      }
    }
  }

  Http().newServerAt("0.0.0.0", 8443).bind(route)
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object GuardrailRead {
  implicit val system: ActorSystem = ActorSystem("guardrail-read")

  val MaxPageSize = 200
  val CacheTtlS = 5

  val redis = new Jedis("redis", 6379)

  def activeKey(tenant: String): String = s"guardrails:policies:${'$'}tenant:active"
  def versionKey(tenant: String, version: String): String = s"guardrails:policies:${'$'}tenant:${'$'}version"

  def render(tenant: String, version: String, promotedAt: String, page: Int, pageSize: Int, rules: List[String]): String = {
    val start = (page - 1) * pageSize
    val pageRules = rules.slice(start, start + pageSize)
    val total = rules.size
    val quoted = pageRules.map(rule => "\\"" + rule + "\\"").mkString(",")
    s"""{"tenant":"${'$'}tenant","version":"${'$'}version","promoted_at":"${'$'}promotedAt","page":${'$'}page,"page_size":${'$'}pageSize,"total":${'$'}total,"rules":[${'$'}quoted]}"""
  }

  val route: Route = (path("v1" / "guardrails" / "policies") & get) {
    optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
      val tenant = tenantOpt.getOrElse("")
      if (tenant.isEmpty) complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
      else {
        parameter("version".?) { versionOpt =>
          parameter("page".as[Int].?(1)) { pageParam =>
            parameter("page_size".as[Int].?(50)) { sizeParam =>
              val page = Math.max(pageParam, 1)
              val pageSize = Math.min(sizeParam, MaxPageSize)
              val key = versionOpt match {
                case Some(version) => versionKey(tenant, version)
                case None          => activeKey(tenant)
              }
              Option(redis.get(key)) match {
                case Some(cached) => complete(HttpEntity(ContentTypes.\`application/json\`, cached))
                case None =>
                  val record = versionOpt match {
                    case Some(version) => store.getVersion(tenant, version)
                    case None          => store.getActive(tenant)
                  }
                  record match {
                    case None =>
                      complete(StatusCodes.NotFound, """{"error":"unknown policy version"}""")
                    case Some(found) =>
                      val body = render(tenant, found.version, found.promoted_at, page, pageSize, found.rules)
                      redis.set(key, body)
                      redis.expire(key, CacheTtlS)
                      complete(HttpEntity(ContentTypes.\`application/json\`, body))
                  }
              }
            }
          }
        }
      }
    }
  }

  /** Publish the new active version and drop the cached page so the next read sees it. */
  def promotePolicy(tenant: String, version: String): Unit = {
    store.promote(tenant, version)
    redis.del(activeKey(tenant))
  }

  Http().newServerAt("0.0.0.0", 8443).bind(route)
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

int main() {
  httplib::Server svr;

  svr.Get("/v1/guardrails/policies", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    // TODO: 404 a version the tenant never promoted, cap and page the rule set, key the cache by
    // tenant and version with a TTL, and delete the active entry when a version is promoted.
    const auto version = req.get_param_value("version");
    const auto key = "guardrails:policies:" + tenant;
    if (auto cached = redis.get(key)) {
      res.status = 200;
      res.set_content(*cached, "application/json");
      return;
    }
    const auto rules = store.rulesFor(tenant, version);
    const auto body = json{{"tenant", tenant}, {"version", version}, {"rules", rules}}.dump();
    redis.set(key, body);
    res.status = 200;
    res.set_content(body, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxPageSize = 200;
constexpr int kCacheTtlS = 5;

sw::redis::Redis redis("tcp://redis:6379");

std::string activeKey(const std::string& tenant) { return "guardrails:policies:" + tenant + ":active"; }
std::string versionKey(const std::string& tenant, const std::string& version) {
  return "guardrails:policies:" + tenant + ":" + version;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/guardrails/policies", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto version = req.get_param_value("version");
    const int page = std::max(req.has_param("page") ? std::stoi(req.get_param_value("page")) : 1, 1);
    const int requestedPageSize = req.has_param("page_size") ? std::stoi(req.get_param_value("page_size")) : 50;
    const int pageSize = std::min(requestedPageSize, kMaxPageSize);

    const auto key = version.empty() ? activeKey(tenant) : versionKey(tenant, version);
    if (auto cached = redis.get(key)) {
      res.status = 200;
      res.set_content(*cached, "application/json");
      return;
    }
    const std::optional<PolicyRecord> record =
        version.empty() ? store.getActive(tenant) : store.getVersion(tenant, version);
    if (!record.has_value()) {
      // A version the tenant never promoted is a 404, never the active set relabelled.
      res.status = 404;
      res.set_content(R"({"error":"unknown policy version"})", "application/json");
      return;
    }
    const int start = (page - 1) * pageSize;
    json pageRules = json::array();
    for (int i = start; i < start + pageSize && i < static_cast<int>(record->rules.size()); i++)
      pageRules.push_back(record->rules[i]);
    const auto body = json{{"tenant", tenant},
                           {"version", record->version},
                           {"promoted_at", record->promoted_at},
                           {"page", page},
                           {"page_size", pageSize},
                           {"total", record->rules.size()},
                           {"rules", pageRules}}
                          .dump();
    redis.set(key, body);
    redis.expire(key, kCacheTtlS);
    res.status = 200;
    res.set_content(body, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}

/** Publish the new active version and drop the cached page so the next read sees it. */
void promotePolicy(const std::string& tenant, const std::string& version, PolicyStore& store) {
  store.promote(tenant, version);
  redis.del(activeKey(tenant));
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a read endpoint as a contract rather than a JSON shape. Three habits separate this draft from a version a reviewer can trust. First, a version parameter is an input to validate, not a label to copy: resolving it against the tenant's promotions is what makes a **404** meaningful, and returning the active rules under the requested version is how an audit gets misled. Second, a read that can return a whole rule set needs a bound and a page, because the largest tenant decides the response size and the gateway timeout. Third, caching a policy is only safe while invalidation is real: keying by tenant and version, expiring the entry, and deleting the active key on promotion are what make "the next read sees the new rules" true instead of hopeful. Real systems add an ETag on the version so clients revalidate cheaply, a per-tenant cache size bound, and an audit log of who read which version when.`,
};
