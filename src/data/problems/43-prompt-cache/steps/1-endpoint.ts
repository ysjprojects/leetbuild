import type {Step} from '@/lib/types';

export const cacheEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/completions/cached: cache key that cannot leak',
  concept: 'http',
  file: 'api',
  focus: ['client', 'cache', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it hashes the prefix, looks the
hash up, and returns a completion the moment it finds one. The demo never shows the bug because the
demo has one tenant and one prompt version. Three things are missing from the key — the tenant, the
prompt version and the raw text's exclusion — and each of them is a leak on its own. Review the draft
as the owner of the cache, fix it, and prove the fix.

Implement \`POST /v1/completions/cached\` with body
\`{"prefix": "…", "prompt_version": 7, "temperature": 0}\`.

- The tenant comes from the authenticated request, not the body: read the \`x-tenant-id\` header and
  answer **401** with \`{"error": "tenant_required"}\` when it is absent. A tenant taken from the body
  is a tenant the caller can choose, which is the same as having no tenant at all.
- \`prefix\` is a non-empty UTF-8 string of at most **8 KiB** (\`8 * 1024\` bytes); a larger prefix is
  **413** and the error body must **never** echo a slice of the prefix — an error body is copied into
  logs, traces and client crash reports.
- The cache key is \`pc:{tenant}:{version}:{digest}\` where \`digest\` is a **SHA-256** hex digest of
  the prefix. Build it with one helper, \`cache_key(tenant, version, prefix)\`, so every caller of the
  cache has to pass all three. The draft builds \`cache:{sha256(prefix)}\` — a prefix hash alone — so
  two tenants that both send \`"You are a helpful assistant…"\` share one entry, and a prompt-template
  change keeps serving completions produced by the old template.
- A hit is returned **only when all three match**. Re-read the stored record's \`tenant\` and
  \`version\` and compare them with the caller's before answering \`"hit"\`; a stored record whose tenant
  or version disagrees is a **miss**. The key already scopes the entry, and the re-check is what keeps
  a stale or hand-seeded value from crossing the boundary anyway.
- A version bump must invalidate the whole namespace **without a manual purge**: because the version
  is part of the key, version 8 simply has no entries yet. Never scan, \`KEYS\` or \`SCAN\`-and-delete to
  invalidate — that is an outage waiting for a big keyspace.
- The response is \`{"status", "completion"}\` with \`status\` one of \`"hit"\` or \`"miss"\`. Log the
  **key**, never the prefix.

**Failure mode the checks target.** The draft's key is a function of the prompt only, so the cache
boundary is the prompt's popularity instead of the tenant's identity: the first tenant to warm a
popular prefix serves everybody, and old-template output never expires. A cache key is a security
boundary, and it must be built from every dimension the answer depends on.`,
  sequence: {
    participants: ['Client', 'Prompt Cache', 'Redis'],
    messages: [
      {from: 'Client', to: 'Prompt Cache', label: 'POST /v1/completions/cached · x-tenant-id, prefix', kind: 'sync'},
      {
        from: 'Prompt Cache',
        to: 'Prompt Cache',
        label: 'cache_key(tenant, prompt_version, sha256(prefix))',
        kind: 'sync',
      },
      {from: 'Prompt Cache', to: 'Redis', label: 'GET pc:{tenant}:{version}:{digest}', kind: 'sync'},
      {from: 'Redis', to: 'Prompt Cache', label: 'record | nil', kind: 'reply'},
      {from: 'Prompt Cache', to: 'Prompt Cache', label: 'tenant and version must match, else miss', kind: 'sync'},
      {from: 'Prompt Cache', to: 'Client', label: '200 {status: "hit" | "miss"}', kind: 'reply'},
    ],
  },
  hints: [
    'Write the key as one format string — `pc:{tenant}:{version}:{digest}` — and one helper that fills all three parts. If a cache key can be built by passing only a prefix, someone eventually will. The digest is `sha256(prefix)`, never the prefix itself: keys show up in `MONITOR`, in slow logs and in dashboards.',
    'The tenant is the authenticated identity, so it comes from the header, and a missing header is a 401 rather than a default. A version that is not part of the key cannot be invalidated except by a purge, and a purge is a self-inflicted outage; making the prompt version part of the key turns "bump the template" into "write a new namespace".',
    'Cheap belt-and-braces: even though the key is scoped, compare the stored record’s `tenant` and `version` before you call it a hit. Hand-seeded entries, a migration that rewrote keys and a bug in a future refactor all produce records that the key alone would trust.',
  ],
  checks: [
    {
      id: 'tenant-auth',
      title: 'Tenant comes from the authenticated header, missing tenant is 401',
      detail:
        'The tenant is read from the `x-tenant-id` request header and an absent tenant is `401 {"error": "tenant_required"}`. The draft reads `tenant` out of the JSON body, so the caller chooses its own identity and a request without the field crashes or defaults.',
      match: {
        python: {all: [/x-tenant-id/, /\b401\b/], none: [/payload\[["']tenant["']\]/]},
        typescript: {all: [/x-tenant-id/, /\.code\(\s*401\s*\)|\b401\b/], none: [/body\.tenant\b/]},
        go: {all: [/x-tenant-id/, /StatusUnauthorized/], none: [/body\.Tenant\b/]},
        scala: {all: [/x-tenant-id/, /Unauthorized|\b401\b/], none: [/body\.tenant\b/]},
        cpp: {all: [/x-tenant-id/, /\b401\b/], none: [/body\.at\("tenant"\)/]},
      },
    },
    {
      id: 'version-in-key',
      title: 'Key is pc:{tenant}:{version}:{digest} built by one helper',
      detail:
        'The key carries the tenant **and** the prompt version, and it is built by a single helper that takes all three parts. The draft keys by `cache:{sha256(prefix)}`, so the version never reaches the key and a template change keeps serving the old completion.',
      match: {
        python: {
          all: [/def cache_key\(tenant: str, version: int, prefix: str\)/, /pc:\{tenant\}:\{version\}:\{digest\}/],
        },
        typescript: {
          all: [
            /function cacheKey\(tenant: string, version: number, prefix: string\)/,
            /pc:\$\{tenant\}:\$\{version\}:\$\{digest\}/,
          ],
        },
        go: {all: [/func cacheKey\(tenant string, version int, prefix string\) string/, /"pc:%s:%d:%s"/]},
        scala: {
          all: [/def cacheKey\(tenant: String, version: Int, prefix: String\): String/, /s"pc:\$tenant:\$version/],
        },
        cpp: {
          all: [
            /std::string cache_key\(const std::string& tenant, int version, const std::string& prefix\)/,
            /"pc:" \+ tenant/,
          ],
        },
      },
    },
    {
      id: 'digest-only',
      title: 'Only a digest of the prefix enters the key or a log line',
      detail:
        'The prefix is hashed with SHA-256 and the raw text is never part of the key, a log line or a response field. The draft logs `prefix=%s` on every lookup, writing customer prompt text into log retention.',
      match: {
        python: {all: [/hashlib\.sha256/], none: [/log\.\w+\([^)]*\bprefix\b/, /["']prefix["']\s*:/]},
        typescript: {
          all: [/createHash\(['"]sha256['"]\)/],
          none: [/log\.(?:info|debug|warn)\([^)]*\bprefix\b/, /["']prefix["']\s*:/],
        },
        go: {all: [/sha256\.Sum256/], none: [/log\.Print\w*\([^)]*\bprefix\b/, /"prefix"\s*:/]},
        scala: {
          all: [/MessageDigest\.getInstance\("SHA-256"\)/],
          none: [/println\([^)]*\bprefix\b/, /"prefix"\s*:/],
        },
        cpp: {all: [/sha256_hex/], none: [/std::cerr[^;]*\bprefix\b/, /"prefix"\s*:/]},
      },
    },
    {
      id: 'three-way-match',
      title: 'A hit requires the stored tenant and version to match',
      detail:
        'Before answering `"hit"`, the stored record’s `tenant` and `version` are compared with the caller’s. The draft trusts whatever the prefix hash found, so a record written for one tenant — or by an older template — is served as a hit.',
      match: {
        python: {all: [/\["tenant"\] == tenant/, /\["version"\] == version/]},
        typescript: {all: [/\.tenant === tenant/, /\.version === body\.prompt_version/]},
        go: {all: [/\.Tenant == tenant/, /\.Version == body\.PromptVersion/]},
        scala: {all: [/\.tenant == tenant/, /\.version == body\.promptVersion/]},
        cpp: {all: [/\["tenant"\] == tenant/, /\["version"\] == version/]},
      },
    },
    {
      id: 'prefix-cap',
      title: 'Prefix over 8 KiB is a 413 that does not echo the prefix',
      detail:
        'The prefix cap is `8 * 1024` bytes and the over-cap answer is `413` with a body that carries an error code, not a slice of the rejected text. The draft returns `sample: prefix[:64]`, putting prompt text into every error log and client report.',
      match: {
        python: {all: [/8 \* 1024/, /\b413\b/], none: [/prefix\[:\s*64\]/]},
        typescript: {all: [/8 \* 1024/, /\.code\(\s*413\s*\)|\b413\b/], none: [/prefix\.slice\(0,\s*64\)/]},
        go: {all: [/8 \* 1024/, /StatusRequestEntityTooLarge/], none: [/prefix\[:\s*64\]/]},
        scala: {all: [/8 \* 1024/, /RequestEntityTooLarge|\b413\b/], none: [/prefix\.take\(64\)/]},
        cpp: {all: [/8 \* 1024/, /\b413\b/], none: [/prefix\.substr\(0,\s*64\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from redis.asyncio import Redis

log = logging.getLogger("prompt-cache")
app = FastAPI()
store = Redis.from_url("redis://cache:6379/0")


@app.post("/v1/completions/cached")
async def completions_cached(request: Request) -> JSONResponse:
    # TODO: the draft keys by the prefix digest alone, so the same prefix serves every tenant and a
    # prompt-version bump keeps serving the old completion. It also logs the raw prefix and echoes a
    # slice of it in the 413 body.
    payload = await request.json()
    tenant = payload["tenant"]
    prefix = payload["prefix"]
    version = payload["prompt_version"]
    if len(prefix.encode("utf-8")) > 8 * 1024:
        return JSONResponse({"error": "prefix_too_large", "sample": prefix[:64]}, status_code=413)
    key = f"cache:{hashlib.sha256(prefix.encode('utf-8')).hexdigest()}"
    log.info("cache lookup prefix=%s key=%s", prefix, key)
    entry = await store.get(key)
    if entry is not None:
        record = json.loads(entry)
        return JSONResponse({"status": "hit", "cache_key": key, "completion": record["completion"]})
    completion = await fill_completion(tenant, version, prefix)
    return JSONResponse({"status": "miss", "cache_key": key, "completion": completion})
`,
      solution: `import hashlib
import json
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from redis.asyncio import Redis

log = logging.getLogger("prompt-cache")
app = FastAPI()
store = Redis.from_url("redis://cache:6379/0")

PREFIX_LIMIT = 8 * 1024
KEY_TEMPLATE = "pc:{tenant}:{version}:{digest}"


def cache_key(tenant: str, version: int, prefix: str) -> str:
    """The three things a completion depends on: a tenant, a prompt version and a prefix digest."""
    digest = hashlib.sha256(prefix.encode("utf-8")).hexdigest()
    return KEY_TEMPLATE.format(tenant=tenant, version=version, digest=digest)


@app.post("/v1/completions/cached")
async def completions_cached(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        return JSONResponse({"error": "tenant_required"}, status_code=401)
    payload = await request.json()
    prefix = payload.get("prefix")
    version = payload.get("prompt_version")
    if not isinstance(prefix, str) or prefix == "":
        return JSONResponse({"error": "prefix_required"}, status_code=400)
    if not isinstance(version, int):
        return JSONResponse({"error": "prompt_version_required"}, status_code=400)
    if len(prefix.encode("utf-8")) > PREFIX_LIMIT:
        return JSONResponse({"error": "prefix_too_large"}, status_code=413)
    key = cache_key(tenant, version, prefix)
    entry = await store.get(key)
    if entry is not None:
        record = json.loads(entry)
        # The key scopes the entry; the record must agree before it counts as a hit.
        if record["tenant"] == tenant and record["version"] == version:
            log.info("cache lookup key=%s decision=hit", key)
            return JSONResponse({"status": "hit", "completion": record["completion"]})
    log.info("cache lookup key=%s decision=miss", key)
    completion = await fill_completion(tenant, version, prefix, key)
    return JSONResponse({"status": "miss", "completion": completion})
`,
    },
    typescript: {
      starter: `/** POST /v1/completions/cached: a model-generated draft whose key is the prompt digest alone. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const store = new Redis('redis://cache:6379');

interface CompletionBody {
  tenant: string;
  prefix: string;
  prompt_version: number;
}

app.post('/v1/completions/cached', async (request, reply) => {
  // TODO: the draft keys by the prefix digest alone, so the same prefix serves every tenant and a
  // prompt-version bump keeps serving the old completion. It also logs the raw prefix and echoes a
  // slice of it in the 413 body.
  const body = request.body as CompletionBody;
  if (Buffer.byteLength(body.prefix, 'utf8') > 8 * 1024) {
    return reply.code(413).send({error: 'prefix_too_large', sample: body.prefix.slice(0, 64)});
  }
  const key = \`cache:\${createHash('sha256').update(body.prefix).digest('hex')}\`;
  request.log.info({prefix: body.prefix}, 'cache lookup');
  const entry = await store.get(key);
  if (entry !== null) {
    const record = JSON.parse(entry) as {tenant: string; version: number; completion: string};
    return reply.code(200).send({status: 'hit', cache_key: key, completion: record.completion});
  }
  const completion = await fillCompletion(body.tenant, body.prompt_version, body.prefix);
  return reply.code(200).send({status: 'miss', cache_key: key, completion});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/completions/cached: a key a tenant and a prompt version cannot cross. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const store = new Redis('redis://cache:6379');

const PREFIX_LIMIT = 8 * 1024;

/** The three things a completion depends on: a tenant, a prompt version and a prefix digest. */
export function cacheKey(tenant: string, version: number, prefix: string): string {
  const digest = createHash('sha256').update(prefix, 'utf8').digest('hex');
  return \`pc:\${tenant}:\${version}:\${digest}\`;
}

interface CacheRecord {
  tenant: string;
  version: number;
  completion: string;
}

app.post('/v1/completions/cached', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') {
    return reply.code(401).send({error: 'tenant_required'});
  }
  const body = request.body as {prefix: string; prompt_version: number};
  if (Buffer.byteLength(body.prefix ?? '', 'utf8') > PREFIX_LIMIT) {
    return reply.code(413).send({error: 'prefix_too_large'});
  }
  const key = cacheKey(tenant, body.prompt_version, body.prefix);
  const entry = await store.get(key);
  if (entry !== null) {
    const record = JSON.parse(entry) as CacheRecord;
    // The key scopes the entry; the record must agree before it counts as a hit.
    if (record.tenant === tenant && record.version === body.prompt_version) {
      request.log.info({cache_key: key}, 'cache lookup');
      return reply.code(200).send({status: 'hit', completion: record.completion});
    }
  }
  const completion = await fillCompletion(tenant, body.prompt_version, body.prefix, key);
  return reply.code(200).send({status: 'miss', completion});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

var store = newRedisStore()

type completionBody struct {
	Tenant        string \`json:"tenant"\`
	Prefix        string \`json:"prefix"\`
	PromptVersion int    \`json:"prompt_version"\`
}

// TODO: the draft keys by the prefix digest alone, so the same prefix serves every tenant and a
// prompt-version bump keeps serving the old completion. It also logs the raw prefix and echoes a
// slice of it in the 413 body.
func completionsCached(w http.ResponseWriter, r *http.Request) {
	var body completionBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	if len([]byte(body.Prefix)) > 8*1024 {
		writeJSON(w, 413, map[string]any{"error": "prefix_too_large", "sample": body.Prefix[:64]})
		return
	}
	key := cacheKeyOfPrefix(body.Prefix)
	log.Printf("cache lookup prefix=%s key=%s", body.Prefix, key)
	raw, ok := store.Get(key)
	if ok {
		var record cacheRecord
		_ = json.Unmarshal(raw, &record)
		writeJSON(w, 200, map[string]any{"status": "hit", "cache_key": key, "completion": record.Completion})
		return
	}
	completion := fillCompletion(r.Context(), body.Tenant, body.PromptVersion, body.Prefix)
	writeJSON(w, 200, map[string]any{"status": "miss", "cache_key": key, "completion": completion})
}

func cacheKeyOfPrefix(prefix string) string {
	sum := sha256.Sum256([]byte(prefix))
	return "cache:" + hex.EncodeToString(sum[:])
}

var _ = fmt.Sprintf
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
)

var store = newRedisStore()

const prefixLimit = 8 * 1024

type cacheRecord struct {
	Tenant     string \`json:"tenant"\`
	Version    int    \`json:"version"\`
	Completion string \`json:"completion"\`
}

// cacheKey is the three things a completion depends on: a tenant, a prompt version and a digest.
func cacheKey(tenant string, version int, prefix string) string {
	sum := sha256.Sum256([]byte(prefix))
	return fmt.Sprintf("pc:%s:%d:%s", tenant, version, hex.EncodeToString(sum[:]))
}

func completionsCached(w http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("x-tenant-id")
	if tenant == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "tenant_required"})
		return
	}
	var body struct {
		Prefix        string \`json:"prefix"\`
		PromptVersion int    \`json:"prompt_version"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_body"})
		return
	}
	if len([]byte(body.Prefix)) > prefixLimit {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "prefix_too_large"})
		return
	}
	key := cacheKey(tenant, body.PromptVersion, body.Prefix)
	if raw, ok := store.Get(key); ok {
		var record cacheRecord
		// The key scopes the entry; the record must agree before it counts as a hit.
		if json.Unmarshal(raw, &record) == nil && record.Tenant == tenant && record.Version == body.PromptVersion {
			writeJSON(w, 200, map[string]any{"status": "hit", "completion": record.Completion})
			return
		}
	}
	completion := fillCompletion(r.Context(), tenant, body.PromptVersion, body.Prefix, key)
	writeJSON(w, 200, map[string]any{"status": "miss", "completion": completion})
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object PromptCacheApi {
  // TODO: the draft keys by the prefix digest alone, so the same prefix serves every tenant and a
  // prompt-version bump keeps serving the old completion. It also logs the raw prefix and echoes a
  // slice of it in the 413 body.
  val routes: Route = post {
    path("v1" / "completions" / "cached") {
      entity(as[CompletionBody]) { body =>
        complete {
          if (body.prefix.getBytes("UTF-8").length > 8 * 1024) {
            (StatusCodes.PayloadTooLarge, s"""{"error":"prefix_too_large","sample":"\${body.prefix.take(64)}"}""")
          } else {
            val key = s"cache:\${sha256Hex(body.prefix)}"
            println(s"cache lookup prefix=\${body.prefix} key=$key")
            Store.get(key) match {
              case Some(record) => (StatusCodes.OK, s"""{"status":"hit","cache_key":"$key"}""")
              case None         => (StatusCodes.OK, fillCompletion(body.tenant, body.promptVersion, body.prefix))
            }
          }
        }
      }
    }
  }

  def sha256Hex(value: String): String = {
    val md = MessageDigest.getInstance("SHA-256")
    md.digest(value.getBytes("UTF-8")).map("%02x".format(_)).mkString
  }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object PromptCacheApi {
  private val PrefixLimit = 8 * 1024

  final case class CacheRecord(tenant: String, version: Int, completion: String)

  val routes: Route = post {
    path("v1" / "completions" / "cached") {
      optionalHeaderValueByName("x-tenant-id") { header =>
        entity(as[CompletionBody]) { body =>
          header match {
            case None => complete((StatusCodes.Unauthorized, """{"error":"tenant_required"}"""))
            case Some(tenant) if body.prefix.getBytes("UTF-8").length > PrefixLimit =>
              complete((StatusCodes.RequestEntityTooLarge, """{"error":"prefix_too_large"}"""))
            case Some(tenant) =>
              val key = cacheKey(tenant, body.promptVersion, body.prefix)
              Store.get(key) match {
                case Some(record) if record.tenant == tenant && record.version == body.promptVersion =>
                  // The key scopes the entry; the record must agree before it counts as a hit.
                  complete((StatusCodes.OK, s"""{"status":"hit","completion":\${record.completion}}"""))
                case _ =>
                  val completion = fillCompletion(tenant, body.promptVersion, body.prefix, key)
                  complete((StatusCodes.OK, s"""{"status":"miss","completion":"$completion"}"""))
              }
          }
        }
      }
    }
  }

  /** The three things a completion depends on: a tenant, a prompt version and a prefix digest. */
  def cacheKey(tenant: String, version: Int, prefix: String): String =
    s"pc:$tenant:$version:\${sha256Hex(prefix)}"

  def sha256Hex(value: String): String = {
    val md = MessageDigest.getInstance("SHA-256")
    md.digest(value.getBytes("UTF-8")).map("%02x".format(_)).mkString
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

std::string sha256_hex(const std::string& value);

// TODO: the draft keys by the prefix digest alone, so the same prefix serves every tenant and a
// prompt-version bump keeps serving the old completion. It also logs the raw prefix and echoes a
// slice of it in the 413 body.
void register_cached_completions(httplib::Server& server) {
  server.Post("/v1/completions/cached", [](const httplib::Request& request, httplib::Response& response) {
    const json body = json::parse(request.body);
    const std::string tenant = body.at("tenant");
    const std::string prefix = body.at("prefix");
    const int version = body.at("prompt_version");
    if (prefix.size() > 8 * 1024) {
      response.status = 413;
      response.set_content(json{{"error", "prefix_too_large"}, {"sample", prefix.substr(0, 64)}}.dump(), "application/json");
      return;
    }
    const std::string key = "pc:" + sha256_hex(prefix);
    std::cerr << "cache lookup prefix=" << prefix << " key=" << key << std::endl;
    if (auto entry = cache_get(key)) {
      response.set_content(json{{"status", "hit"}, {"cache_key", key}}.dump(), "application/json");
      return;
    }
    const std::string completion = fill_completion(tenant, version, prefix);
    response.set_content(json{{"status", "miss"}, {"cache_key", key}, {"completion", completion}}.dump(), "application/json");
  });
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

std::string sha256_hex(const std::string& value);

// cache_key is the three things a completion depends on: a tenant, a prompt version and a digest.
std::string cache_key(const std::string& tenant, int version, const std::string& prefix) {
  return "pc:" + tenant + ":" + std::to_string(version) + ":" + sha256_hex(prefix);
}

void register_cached_completions(httplib::Server& server) {
  server.Post("/v1/completions/cached", [](const httplib::Request& request, httplib::Response& response) {
    const std::string tenant = request.get_header_value("x-tenant-id");
    if (tenant.empty()) {
      response.status = 401;
      response.set_content(json{{"error", "tenant_required"}}.dump(), "application/json");
      return;
    }
    const json body = json::parse(request.body);
    const std::string prefix = body.at("prefix");
    const int version = body.at("prompt_version");
    if (prefix.size() > 8 * 1024) {
      response.status = 413;
      response.set_content(json{{"error", "prefix_too_large"}}.dump(), "application/json");
      return;
    }
    const std::string key = cache_key(tenant, version, prefix);
    if (auto entry = cache_get(key)) {
      // The key scopes the entry; the record must agree before it counts as a hit.
      if ((*entry)["tenant"] == tenant && (*entry)["version"] == version) {
        std::cout << "cache lookup key=" << key << " decision=hit" << std::endl;
        response.set_content(json{{"status", "hit"}, {"completion", (*entry)["completion"]}}.dump(), "application/json");
        return;
      }
    }
    const std::string completion = fill_completion(tenant, version, prefix, key);
    response.set_content(json{{"status", "miss"}, {"completion", completion}}.dump(), "application/json");
  });
}
`,
    },
  },
  debrief: `The interviewer is testing whether you understand that a cache key is an isolation boundary, not an optimisation detail. The draft’s key hashes the prompt and nothing else, so the entry that a hit selects is "whoever asked this prefix first" — which is a cross-tenant leak the moment a shared system prompt makes prefixes identical, and a stale-template bug the moment a prompt version bumps without a purge. Naming the three dimensions (tenant, version, prefix digest) and building the key in exactly one helper is what makes the boundary auditable: nobody can add a fourth call site that forgets a dimension when there is only one call site. The digest instead of the text keeps the boundary out of \`MONITOR\` output and slow logs, the header instead of the body keeps the tenant out of the caller’s reach, and the record re-check is the cheap belt to the key’s braces.`,
};
