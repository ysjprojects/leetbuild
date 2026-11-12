import type {Step} from '@/lib/types';

export const cacheEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/completions/cached: a key a tenant cannot cross',
  concept: 'http',
  guides: ['request-boundaries', 'keys-and-expiry'],
  file: 'api',
  focus: ['client', 'cache', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/completions/cached\` with body \`{"prefix",
"prompt_version", "temperature"}\` and the tenant in \`X-Tenant-Id\` (401 without one). It hashes the
prefix, asks step 2's \`lookup\` for the entry and answers \`{status: "hit", completion}\` when there is
one; otherwise it calls step 3's \`complete_miss\` and answers \`{status: "miss", completion}\`. Each
decision goes to step 4's \`emit_decision\`. A prefix over 8 KiB is 413. The demo misses, then hits. It
hides 4 flaws.

**Failure mode the checks target.** The key is a security boundary: built from the prefix alone, the
first tenant to warm a popular system prompt serves every tenant, and a version bump keeps serving the
old template's answers. The request is the other boundary: a tenant named in the body, a version that
defaults, a 413 that quotes the prompt into error logs.

- The tenant is \`X-Tenant-Id\` only; a \`tenant\` field in the body is ignored.
- Entries live under \`pc:{tenant}:{version}:{sha256(prefix) hex}\`.
- \`prompt_version\` is a required integer: **400** without it.
- Over 8 KiB of UTF-8 (\`8 * 1024\` bytes) is **413** \`{"error": "prefix_too_large", "limit_bytes":
  8192}\`, quoting none of the prefix.`,
  sequence: {
    participants: ['Client', 'Prompt Cache', 'Redis', 'Model server'],
    messages: [
      {from: 'Client', to: 'Prompt Cache', label: 'POST /v1/completions/cached · X-Tenant-Id: t1', kind: 'sync'},
      {from: 'Prompt Cache', to: 'Prompt Cache', label: 'key = pc:t1:7:sha256(prefix)', kind: 'sync'},
      {from: 'Prompt Cache', to: 'Redis', label: 'lookup(key)', kind: 'sync'},
      {from: 'Redis', to: 'Prompt Cache', label: 'nil', kind: 'reply'},
      {from: 'Prompt Cache', to: 'Model server', label: 'complete_miss(key, t1, 7, prefix, 0)', kind: 'sync'},
      {from: 'Model server', to: 'Prompt Cache', label: 'completion (filled)', kind: 'reply'},
      {from: 'Prompt Cache', to: 'Client', label: '200 {status: "miss", completion}', kind: 'reply'},
    ],
  },
  hints: [
    "A tenant sees completions that mention another company's product, last week's template keeps answering after a version bump, clients that forget the version get version 1, and prompt text shows up in the error tracker.",
    'The key is `pc:{sha256(prefix)}` with no tenant or version; a `tenant` in the body overrides the header; `prompt_version` defaults to 1; the 413 body carries `prefix[:64]`.',
    'Read the tenant from `X-Tenant-Id` only; build `pc:{tenant}:{version}:{digest}`; answer 400 when `prompt_version` is not an integer; drop the prefix from the 413 body.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Misses, fills, then hits',
      detail:
        "A first request for a prefix answers 200 status miss with the model's completion and a second one answers status hit with the same completion.",
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/completions\/cached["']/, /lookup\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/completions\/cached['"]/, /lookup\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/completions\/cached"/, /lookup\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"completions"\s*\/\s*"cached"\s*\)/, /EntryCache\.lookup\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/completions\/cached"/, /lookup\(/]},
      },
    },
    {
      id: 'tenant-header',
      title: 'The tenant is the header, never the body',
      detail:
        "A request without X-Tenant-Id is 401 even when the body names a tenant, and a body tenant cannot steer a request into another tenant's entries. The starter lets the body's tenant win.",
      match: {
        python: {all: [/x-tenant-id/i], none: [/body\.get\(\s*["']tenant["']/]},
        typescript: {all: [/x-tenant-id/i], none: [/body\.tenant\b/]},
        go: {all: [/X-Tenant-Id/], none: [/body\.Tenant\b/]},
        scala: {all: [/X-Tenant-Id/], none: [/get\("tenant"\)/]},
        cpp: {all: [/X-Tenant-Id/], none: [/body\.value\("tenant"/]},
      },
    },
    {
      id: 'scoped-key',
      title: 'Entries are keyed by tenant, version and digest',
      detail:
        "After t1 fills a prefix at version 7, t2 with the same prefix and t1 at version 8 both miss, and Redis holds pc:t1:7:{digest}, pc:t2:7:{digest} and pc:t1:8:{digest}. The starter keys by the digest alone and serves t1's entry to both.",
      match: {
        python: {all: [/f["']pc:\{tenant\}:\{version\}:/]},
        typescript: {all: [/pc:\$\{tenant\}:\$\{version\}:/]},
        go: {all: [/"pc:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*strconv\.Itoa\(\s*version\s*\)|"pc:%s:%d:%s"/]},
        scala: {all: [/s"pc:\$tenant:\$version:/]},
        cpp: {all: [/"pc:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*std::to_string\(\s*version\s*\)/]},
      },
    },
    {
      id: 'version-required',
      title: 'A request without a prompt version is 400',
      detail:
        'A body without an integer prompt_version is 400, with no lookup and no model call. The starter defaults it to 1, so an old client reads version 1 entries forever.',
      match: {
        python: {all: [/status_code\s*=\s*400/], none: [/["']prompt_version["']\s*,\s*1\s*\)/]},
        typescript: {all: [/code\(\s*400\s*\)/], none: [/prompt_version:\s*version\s*=\s*1\b/]},
        go: {all: [/StatusBadRequest/], none: [/version\s*:=\s*1\b/]},
        scala: {all: [/StatusCodes\.BadRequest/], none: [/getOrElse\(1\)/]},
        cpp: {all: [/\b400\b/], none: [/value\("prompt_version",\s*1\)/]},
      },
    },
    {
      id: 'no-echo',
      title: 'An oversized prefix is 413 without quoting it',
      detail:
        'A prefix over 8192 UTF-8 bytes is 413 with an error code and the limit, no prompt text, and no lookup or model call; exactly 8192 bytes is served. The starter puts the first 64 characters of the prompt in the 413 body.',
      match: {
        python: {all: [/8 \* 1024/, /status_code\s*=\s*413/], none: [/prefix\[:\s*64\]/]},
        typescript: {all: [/8 \* 1024/, /code\(\s*413\s*\)/], none: [/prefix\.slice\(\s*0,\s*64\s*\)/]},
        go: {all: [/8 \* 1024/, /StatusRequestEntityTooLarge/], none: [/Prefix\[:64\]/]},
        scala: {all: [/8 \* 1024/, /StatusCodes\.PayloadTooLarge/], none: [/take\(64\)/]},
        cpp: {all: [/8 \* 1024/, /\b413\b/], none: [/substr\(0,\s*64\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from cache import lookup  # step 2: the entry under a key, None on a miss
from events import emit_decision  # step 4: one decision event per lookup
from miss import complete_miss  # step 3: one model call, stored when cacheable

app = FastAPI()

PREFIX_LIMIT_BYTES = 8 * 1024


@app.post("/v1/completions/cached")
async def completions_cached(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    body = await request.json()
    if not isinstance(body, dict):
        body = {}
    tenant = body.get("tenant") or request.headers.get("x-tenant-id", "")
    if tenant == "":
        return JSONResponse({"error": "tenant_required"}, status_code=401)
    prefix = body.get("prefix")
    version = body.get("prompt_version", 1)
    temperature = body.get("temperature", 0)
    if not isinstance(prefix, str) or prefix == "" or type(version) is not int or not isinstance(temperature, (int, float)):
        return JSONResponse({"error": "invalid_body"}, status_code=400)
    if len(prefix.encode("utf-8")) > PREFIX_LIMIT_BYTES:
        return JSONResponse({"error": "prefix_too_large", "prefix": prefix[:64]}, status_code=413)
    started = time.monotonic()
    key = "pc:" + hashlib.sha256(prefix.encode("utf-8")).hexdigest()
    hit = lookup(key)
    if hit is not None:
        emit_decision(tenant, version, prefix, "hit", round((time.monotonic() - started) * 1000), hit["tokens"])
        return JSONResponse({"status": "hit", "completion": hit["completion"]})
    miss = complete_miss(key, tenant, version, prefix, float(temperature))
    emit_decision(tenant, version, prefix, "miss", round((time.monotonic() - started) * 1000), miss["tokens"])
    if miss["status"] == "error":
        return JSONResponse({"error": "model_unavailable"}, status_code=503)
    if miss["status"] == "refused":
        return JSONResponse({"error": "refused"}, status_code=422)
    return JSONResponse({"status": "miss", "completion": miss["completion"]})
`,
      solution: `import hashlib
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from cache import lookup  # step 2: the entry under a key, None on a miss
from events import emit_decision  # step 4: one decision event per lookup
from miss import complete_miss  # step 3: one model call, stored when cacheable

app = FastAPI()

PREFIX_LIMIT_BYTES = 8 * 1024


def cache_key(tenant: str, version: int, prefix: str) -> str:
    """Everything a completion depends on: the tenant, the prompt version, the prefix (as its digest)."""
    digest = hashlib.sha256(prefix.encode("utf-8")).hexdigest()
    return f"pc:{tenant}:{version}:{digest}"


@app.post("/v1/completions/cached")
async def completions_cached(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if tenant == "":
        return JSONResponse({"error": "tenant_required"}, status_code=401)
    body = await request.json()
    if not isinstance(body, dict):
        body = {}
    prefix = body.get("prefix")
    version = body.get("prompt_version")
    temperature = body.get("temperature", 0)
    if not isinstance(prefix, str) or prefix == "" or type(version) is not int or not isinstance(temperature, (int, float)):
        return JSONResponse({"error": "invalid_body"}, status_code=400)
    if len(prefix.encode("utf-8")) > PREFIX_LIMIT_BYTES:
        return JSONResponse({"error": "prefix_too_large", "limit_bytes": PREFIX_LIMIT_BYTES}, status_code=413)
    started = time.monotonic()
    key = cache_key(tenant, version, prefix)
    hit = lookup(key)
    if hit is not None:
        emit_decision(tenant, version, prefix, "hit", round((time.monotonic() - started) * 1000), hit["tokens"])
        return JSONResponse({"status": "hit", "completion": hit["completion"]})
    miss = complete_miss(key, tenant, version, prefix, float(temperature))
    emit_decision(tenant, version, prefix, "miss", round((time.monotonic() - started) * 1000), miss["tokens"])
    if miss["status"] == "error":
        return JSONResponse({"error": "model_unavailable"}, status_code=503)
    if miss["status"] == "refused":
        return JSONResponse({"error": "refused"}, status_code=422)
    return JSONResponse({"status": "miss", "completion": miss["completion"]})
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {lookup} from './cache'; // step 2: the entry under a key, null on a miss
import {emitDecision} from './events'; // step 4: one decision event per lookup
import {completeMiss} from './miss'; // step 3: one model call, stored when cacheable

export const app = Fastify();

export const PREFIX_LIMIT_BYTES = 8 * 1024;

interface CompletionBody {
  tenant?: unknown;
  prefix?: unknown;
  prompt_version?: unknown;
  temperature?: unknown;
}

app.post('/v1/completions/cached', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const body = (request.body ?? {}) as CompletionBody;
  const tenant = typeof body.tenant === 'string' ? body.tenant : request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'tenant_required'});
  const {prefix, prompt_version: version = 1, temperature = 0} = body;
  if (typeof prefix !== 'string' || prefix === '' || !Number.isInteger(version) || typeof temperature !== 'number')
    return reply.code(400).send({error: 'invalid_body'});
  if (new TextEncoder().encode(prefix).length > PREFIX_LIMIT_BYTES)
    return reply.code(413).send({error: 'prefix_too_large', prefix: prefix.slice(0, 64)});
  const started = Date.now();
  const key = \`pc:\${createHash('sha256').update(prefix, 'utf8').digest('hex')}\`;
  const hit = await lookup(key);
  if (hit !== null) {
    await emitDecision(tenant, version as number, prefix, 'hit', Date.now() - started, hit.tokens);
    return reply.code(200).send({status: 'hit', completion: hit.completion});
  }
  const miss = await completeMiss(key, tenant, version as number, prefix, temperature);
  await emitDecision(tenant, version as number, prefix, 'miss', Date.now() - started, miss.tokens);
  if (miss.status === 'error') return reply.code(503).send({error: 'model_unavailable'});
  if (miss.status === 'refused') return reply.code(422).send({error: 'refused'});
  return reply.code(200).send({status: 'miss', completion: miss.completion});
});
`,
      solution: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';

import {lookup} from './cache'; // step 2: the entry under a key, null on a miss
import {emitDecision} from './events'; // step 4: one decision event per lookup
import {completeMiss} from './miss'; // step 3: one model call, stored when cacheable

export const app = Fastify();

export const PREFIX_LIMIT_BYTES = 8 * 1024;

/** Everything a completion depends on: the tenant, the prompt version, the prefix (as its digest). */
export function cacheKey(tenant: string, version: number, prefix: string): string {
  const digest = createHash('sha256').update(prefix, 'utf8').digest('hex');
  return \`pc:\${tenant}:\${version}:\${digest}\`;
}

interface CompletionBody {
  prefix?: unknown;
  prompt_version?: unknown;
  temperature?: unknown;
}

app.post('/v1/completions/cached', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'tenant_required'});
  const body = (request.body ?? {}) as CompletionBody;
  const {prefix, prompt_version: version, temperature = 0} = body;
  if (typeof prefix !== 'string' || prefix === '' || !Number.isInteger(version) || typeof temperature !== 'number')
    return reply.code(400).send({error: 'invalid_body'});
  if (new TextEncoder().encode(prefix).length > PREFIX_LIMIT_BYTES)
    return reply.code(413).send({error: 'prefix_too_large', limit_bytes: PREFIX_LIMIT_BYTES});
  const started = Date.now();
  const key = cacheKey(tenant, version as number, prefix);
  const hit = await lookup(key);
  if (hit !== null) {
    await emitDecision(tenant, version as number, prefix, 'hit', Date.now() - started, hit.tokens);
    return reply.code(200).send({status: 'hit', completion: hit.completion});
  }
  const miss = await completeMiss(key, tenant, version as number, prefix, temperature);
  await emitDecision(tenant, version as number, prefix, 'miss', Date.now() - started, miss.tokens);
  if (miss.status === 'error') return reply.code(503).send({error: 'model_unavailable'});
  if (miss.status === 'refused') return reply.code(422).send({error: 'refused'});
  return reply.code(200).send({status: 'miss', completion: miss.completion});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"pcache/record" // record.Record, record.Miss — provided
)

const prefixLimitBytes = 8 * 1024

// Built in step 2 (cache.go): the entry under key, nil on a miss.
var lookup = func(ctx context.Context, key string) (*record.Record, error) {
	panic("lookup is built in step 2 (cache.go)")
}

// Built in step 3 (miss.go): one model call for a miss, stored when cacheable.
var completeMiss = func(ctx context.Context, key, tenant string, version int, prefix string, temperature float64) (record.Miss, error) {
	panic("completeMiss is built in step 3 (miss.go)")
}

// Built in step 4 (events.go): one decision event per lookup.
var emitDecision = func(ctx context.Context, tenant string, version int, prefix, decision string, latencyMs int64, tokens int) {
	panic("emitDecision is built in step 4 (events.go)")
}

type completionRequest struct {
	Tenant        string  \`json:"tenant"\`
	Prefix        string  \`json:"prefix"\`
	PromptVersion *int    \`json:"prompt_version"\`
	Temperature   float64 \`json:"temperature"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func completionsCached(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	var body completionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_body"})
		return
	}
	tenant := body.Tenant
	if tenant == "" {
		tenant = r.Header.Get("X-Tenant-Id")
	}
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "tenant_required"})
		return
	}
	if body.Prefix == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_body"})
		return
	}
	version := 1
	if body.PromptVersion != nil {
		version = *body.PromptVersion
	}
	if len(body.Prefix) > prefixLimitBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "prefix_too_large", "prefix": body.Prefix[:64]})
		return
	}
	started := time.Now()
	sum := sha256.Sum256([]byte(body.Prefix))
	key := "pc:" + hex.EncodeToString(sum[:])
	hit, err := lookup(r.Context(), key)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if hit != nil {
		emitDecision(r.Context(), tenant, version, body.Prefix, "hit", time.Since(started).Milliseconds(), hit.Tokens)
		writeJSON(rw, http.StatusOK, map[string]string{"status": "hit", "completion": hit.Completion})
		return
	}
	miss, err := completeMiss(r.Context(), key, tenant, version, body.Prefix, body.Temperature)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	emitDecision(r.Context(), tenant, version, body.Prefix, "miss", time.Since(started).Milliseconds(), miss.Tokens)
	if miss.Status == "error" {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "model_unavailable"})
		return
	}
	if miss.Status == "refused" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "refused"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]string{"status": "miss", "completion": miss.Completion})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/completions/cached", completionsCached)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"pcache/record" // record.Record, record.Miss — provided
)

const prefixLimitBytes = 8 * 1024

// Built in step 2 (cache.go): the entry under key, nil on a miss.
var lookup = func(ctx context.Context, key string) (*record.Record, error) {
	panic("lookup is built in step 2 (cache.go)")
}

// Built in step 3 (miss.go): one model call for a miss, stored when cacheable.
var completeMiss = func(ctx context.Context, key, tenant string, version int, prefix string, temperature float64) (record.Miss, error) {
	panic("completeMiss is built in step 3 (miss.go)")
}

// Built in step 4 (events.go): one decision event per lookup.
var emitDecision = func(ctx context.Context, tenant string, version int, prefix, decision string, latencyMs int64, tokens int) {
	panic("emitDecision is built in step 4 (events.go)")
}

type completionRequest struct {
	Prefix        string  \`json:"prefix"\`
	PromptVersion *int    \`json:"prompt_version"\`
	Temperature   float64 \`json:"temperature"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// cacheKey is everything a completion depends on: the tenant, the prompt version, the prefix (as its digest).
func cacheKey(tenant string, version int, prefix string) string {
	sum := sha256.Sum256([]byte(prefix))
	return "pc:" + tenant + ":" + strconv.Itoa(version) + ":" + hex.EncodeToString(sum[:])
}

func completionsCached(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "tenant_required"})
		return
	}
	var body completionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Prefix == "" || body.PromptVersion == nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_body"})
		return
	}
	if len(body.Prefix) > prefixLimitBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]any{"error": "prefix_too_large", "limit_bytes": prefixLimitBytes})
		return
	}
	version := *body.PromptVersion
	started := time.Now()
	key := cacheKey(tenant, version, body.Prefix)
	hit, err := lookup(r.Context(), key)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if hit != nil {
		emitDecision(r.Context(), tenant, version, body.Prefix, "hit", time.Since(started).Milliseconds(), hit.Tokens)
		writeJSON(rw, http.StatusOK, map[string]string{"status": "hit", "completion": hit.Completion})
		return
	}
	miss, err := completeMiss(r.Context(), key, tenant, version, body.Prefix, body.Temperature)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	emitDecision(r.Context(), tenant, version, body.Prefix, "miss", time.Since(started).Milliseconds(), miss.Tokens)
	if miss.Status == "error" {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "model_unavailable"})
		return
	}
	if miss.Status == "refused" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "refused"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]string{"status": "miss", "completion": miss.Completion})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/completions/cached", completionsCached)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import scala.util.Try

object CompletionsApi {
  implicit val system: ActorSystem = ActorSystem("prompt-cache")

  val PrefixLimitBytes: Int = 8 * 1024

  private def answer(status: StatusCode, body: ujson.Value): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  val route: Route =
    path("v1" / "completions" / "cached") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { headerTenant =>
          entity(as[String]) { raw =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val body = Try(ujson.read(raw)).toOption.flatMap(_.objOpt)
            val tenant = body.flatMap(_.get("tenant")).flatMap(_.strOpt).orElse(headerTenant).filter(_.nonEmpty)
            val prefix = body.flatMap(_.get("prefix")).flatMap(_.strOpt).filter(_.nonEmpty)
            val version = body.flatMap(_.get("prompt_version")).flatMap(_.numOpt).filter(n => n == n.toInt).map(_.toInt).getOrElse(1)
            val temperature = body.flatMap(_.get("temperature")).flatMap(_.numOpt).getOrElse(0.0)
            (tenant, prefix) match {
              case (None, _) => answer(StatusCodes.Unauthorized, ujson.Obj("error" -> "tenant_required"))
              case (_, None) => answer(StatusCodes.BadRequest, ujson.Obj("error" -> "invalid_body"))
              case (Some(t), Some(p)) if p.getBytes(StandardCharsets.UTF_8).length > PrefixLimitBytes =>
                answer(StatusCodes.PayloadTooLarge, ujson.Obj("error" -> "prefix_too_large", "prefix" -> p.take(64)))
              case (Some(t), Some(p)) =>
                val digest =
                  MessageDigest.getInstance("SHA-256").digest(p.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString
                serve(s"pc:$digest", t, version, p, temperature)
            }
          }
        }
      }
    }

  private def serve(key: String, tenant: String, version: Int, prefix: String, temperature: Double): Route = {
    val started = System.nanoTime()
    def elapsedMs: Long = (System.nanoTime() - started) / 1000000
    EntryCache.lookup(key) match {
      case Some(hit) =>
        CacheEvents.emitDecision(tenant, version, prefix, "hit", elapsedMs, hit.tokens)
        answer(StatusCodes.OK, ujson.Obj("status" -> "hit", "completion" -> hit.completion))
      case None =>
        val miss = MissPath.completeMiss(key, tenant, version, prefix, temperature)
        CacheEvents.emitDecision(tenant, version, prefix, "miss", elapsedMs, miss.tokens)
        if (miss.status == "error") answer(StatusCodes.ServiceUnavailable, ujson.Obj("error" -> "model_unavailable"))
        else if (miss.status == "refused") answer(StatusCodes.UnprocessableEntity, ujson.Obj("error" -> "refused"))
        else answer(StatusCodes.OK, ujson.Obj("status" -> "miss", "completion" -> miss.completion))
    }
  }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import scala.util.Try

object CompletionsApi {
  implicit val system: ActorSystem = ActorSystem("prompt-cache")

  val PrefixLimitBytes: Int = 8 * 1024

  /** Everything a completion depends on: the tenant, the prompt version, the prefix (as its digest). */
  def cacheKey(tenant: String, version: Int, prefix: String): String = {
    val digest =
      MessageDigest.getInstance("SHA-256").digest(prefix.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString
    s"pc:$tenant:$version:$digest"
  }

  private def answer(status: StatusCode, body: ujson.Value): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  val route: Route =
    path("v1" / "completions" / "cached") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { headerTenant =>
          entity(as[String]) { raw =>
            val body = Try(ujson.read(raw)).toOption.flatMap(_.objOpt)
            val prefix = body.flatMap(_.get("prefix")).flatMap(_.strOpt).filter(_.nonEmpty)
            val version = body.flatMap(_.get("prompt_version")).flatMap(_.numOpt).filter(n => n == n.toInt).map(_.toInt)
            val temperature = body.flatMap(_.get("temperature")).flatMap(_.numOpt).getOrElse(0.0)
            (headerTenant.filter(_.nonEmpty), prefix, version) match {
              case (None, _, _) => answer(StatusCodes.Unauthorized, ujson.Obj("error" -> "tenant_required"))
              case (Some(t), Some(p), Some(v)) =>
                if (p.getBytes(StandardCharsets.UTF_8).length > PrefixLimitBytes)
                  answer(StatusCodes.PayloadTooLarge, ujson.Obj("error" -> "prefix_too_large", "limit_bytes" -> PrefixLimitBytes))
                else serve(cacheKey(t, v, p), t, v, p, temperature)
              case _ => answer(StatusCodes.BadRequest, ujson.Obj("error" -> "invalid_body"))
            }
          }
        }
      }
    }

  private def serve(key: String, tenant: String, version: Int, prefix: String, temperature: Double): Route = {
    val started = System.nanoTime()
    def elapsedMs: Long = (System.nanoTime() - started) / 1000000
    EntryCache.lookup(key) match {
      case Some(hit) =>
        CacheEvents.emitDecision(tenant, version, prefix, "hit", elapsedMs, hit.tokens)
        answer(StatusCodes.OK, ujson.Obj("status" -> "hit", "completion" -> hit.completion))
      case None =>
        val miss = MissPath.completeMiss(key, tenant, version, prefix, temperature)
        CacheEvents.emitDecision(tenant, version, prefix, "miss", elapsedMs, miss.tokens)
        if (miss.status == "error") answer(StatusCodes.ServiceUnavailable, ujson.Obj("error" -> "model_unavailable"))
        else if (miss.status == "refused") answer(StatusCodes.UnprocessableEntity, ujson.Obj("error" -> "refused"))
        else answer(StatusCodes.OK, ujson.Obj("status" -> "miss", "completion" -> miss.completion))
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

#include <chrono>
#include <optional>
#include <string>

#include "digest.h"         // sha256_hex(bytes) — provided
#include "pcache/record.h"  // record::Record, record::Miss — provided

using json = nlohmann::json;

constexpr size_t kPrefixLimitBytes = 8 * 1024;

// Built in step 2 (cache.cpp): the entry under key, nothing on a miss.
std::optional<record::Record> lookup(const std::string& key);
// Built in step 3 (miss.cpp): one model call for a miss, stored when cacheable.
record::Miss complete_miss(const std::string& key, const std::string& tenant, int version, const std::string& prefix,
                           double temperature);
// Built in step 4 (events.cpp): one decision event per lookup.
void emit_decision(const std::string& tenant, int version, const std::string& prefix, const std::string& decision,
                   long long latency_ms, int tokens);

static void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void completions_cached(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, json{{"error", "invalid_body"}});
  const std::string tenant = body.value("tenant", req.get_header_value("X-Tenant-Id"));
  if (tenant.empty()) return reply(res, 401, json{{"error", "tenant_required"}});
  if (!body.contains("prefix") || !body["prefix"].is_string() || body["prefix"].get<std::string>().empty())
    return reply(res, 400, json{{"error", "invalid_body"}});
  const std::string prefix = body["prefix"];
  const int version = body.value("prompt_version", 1);
  const double temperature = body.value("temperature", 0.0);
  if (prefix.size() > kPrefixLimitBytes)
    return reply(res, 413, json{{"error", "prefix_too_large"}, {"prefix", prefix.substr(0, 64)}});
  const auto started = std::chrono::steady_clock::now();
  const auto elapsed_ms = [&] {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  };
  const std::string key = "pc:" + sha256_hex(prefix);
  if (const auto hit = lookup(key)) {
    emit_decision(tenant, version, prefix, "hit", elapsed_ms(), hit->tokens);
    return reply(res, 200, json{{"status", "hit"}, {"completion", hit->completion}});
  }
  const record::Miss miss = complete_miss(key, tenant, version, prefix, temperature);
  emit_decision(tenant, version, prefix, "miss", elapsed_ms(), miss.tokens);
  if (miss.status == "error") return reply(res, 503, json{{"error", "model_unavailable"}});
  if (miss.status == "refused") return reply(res, 422, json{{"error", "refused"}});
  reply(res, 200, json{{"status", "miss"}, {"completion", miss.completion}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/completions/cached", completions_cached); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <string>

#include "digest.h"         // sha256_hex(bytes) — provided
#include "pcache/record.h"  // record::Record, record::Miss — provided

using json = nlohmann::json;

constexpr size_t kPrefixLimitBytes = 8 * 1024;

// Built in step 2 (cache.cpp): the entry under key, nothing on a miss.
std::optional<record::Record> lookup(const std::string& key);
// Built in step 3 (miss.cpp): one model call for a miss, stored when cacheable.
record::Miss complete_miss(const std::string& key, const std::string& tenant, int version, const std::string& prefix,
                           double temperature);
// Built in step 4 (events.cpp): one decision event per lookup.
void emit_decision(const std::string& tenant, int version, const std::string& prefix, const std::string& decision,
                   long long latency_ms, int tokens);

// Everything a completion depends on: the tenant, the prompt version, the prefix (as its digest).
std::string cache_key(const std::string& tenant, int version, const std::string& prefix) {
  return "pc:" + tenant + ":" + std::to_string(version) + ":" + sha256_hex(prefix);
}

static void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void completions_cached(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "tenant_required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("prefix") || !body["prefix"].is_string() ||
      body["prefix"].get<std::string>().empty() || !body.contains("prompt_version") ||
      !body["prompt_version"].is_number_integer())
    return reply(res, 400, json{{"error", "invalid_body"}});
  const std::string prefix = body["prefix"];
  const int version = body["prompt_version"];
  const double temperature = body.value("temperature", 0.0);
  if (prefix.size() > kPrefixLimitBytes)
    return reply(res, 413, json{{"error", "prefix_too_large"}, {"limit_bytes", kPrefixLimitBytes}});
  const auto started = std::chrono::steady_clock::now();
  const auto elapsed_ms = [&] {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  };
  const std::string key = cache_key(tenant, version, prefix);
  if (const auto hit = lookup(key)) {
    emit_decision(tenant, version, prefix, "hit", elapsed_ms(), hit->tokens);
    return reply(res, 200, json{{"status", "hit"}, {"completion", hit->completion}});
  }
  const record::Miss miss = complete_miss(key, tenant, version, prefix, temperature);
  emit_decision(tenant, version, prefix, "miss", elapsed_ms(), miss.tokens);
  if (miss.status == "error") return reply(res, 503, json{{"error", "model_unavailable"}});
  if (miss.status == "refused") return reply(res, 422, json{{"error", "refused"}});
  reply(res, 200, json{{"status", "miss"}, {"completion", miss.completion}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/completions/cached", completions_cached); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import hashlib

import prompt_cache_pb2
import prompt_cache_pb2_grpc
from pcache import config, llm

PREFIX = "You are the support assistant for Acme Bank. Answer in two sentences: how do I reset my card PIN?"
DIGEST = hashlib.sha256(PREFIX.encode("utf-8")).hexdigest()


class ModelServicer(prompt_cache_pb2_grpc.ModelServicer):
    """The stand-in model server: answers from pcache.llm."""

    def Complete(self, request, context):
        text, reason, tokens = llm.complete(request.prefix, request.temperature)
        return prompt_cache_pb2.CompleteReply(text=text, finish_reason=reason, completion_tokens=tokens)


def _api(ctx):
    ctx.grpc.serve(prompt_cache_pb2_grpc.add_ModelServicer_to_server, ModelServicer(), config.MODEL)
    return ctx.client(ctx.load("api").app)


async def _post(c, body, tenant="t1"):
    headers = {} if tenant is None else {"X-Tenant-Id": tenant}
    return await c.post("/v1/completions/cached", json=body, headers=headers)


def _body(prefix=PREFIX, version=7, **extra):
    return {"prefix": prefix, "prompt_version": version, "temperature": 0, **extra}


def _model_calls(ctx):
    return len(ctx.grpc.calls_to("Complete"))


def _entries(ctx):
    return sorted(ctx.redis.keys("pc:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        first = await _post(c, _body())
        assert first.status_code == 200, f"a first request answered {first.status_code}: {first.text}"
        answer, _, _ = llm.complete(PREFIX, 0)
        assert first.json() == {"status": "miss", "completion": answer}, f"a first request is a miss with the model's completion, got {first.json()}"
        second = await _post(c, _body())
        assert second.status_code == 200 and second.json() == {"status": "hit", "completion": answer}, f"the same request again is a hit with the same completion, got {second.status_code} {second.text}"
        assert _model_calls(ctx) == 1, f"a hit must not call the model: saw {_model_calls(ctx)} Complete calls for two requests"


async def check_tenant_header(ctx):
    async with _api(ctx) as c:
        r = await _post(c, _body(tenant="t1"), tenant=None)
        assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code} because the body named a tenant: the body is the caller's claim, the header is its identity. Expected 401"
        assert (await _post(c, _body())).json().get("status") == "miss", "t1 warms the prefix"
        steered = await _post(c, _body(tenant="t1"), tenant="t2")
        assert steered.status_code == 200 and steered.json().get("status") == "miss", f"t2 naming tenant t1 in the body got {steered.json()}: it must be served as t2 (a miss), not from t1's entries"
        assert f"pc:t2:7:{DIGEST}" in _entries(ctx), f"t2's request must fill pc:t2:7:{{digest}}, found {_entries(ctx)}"


async def check_scoped_key(ctx):
    async with _api(ctx) as c:
        assert (await _post(c, _body(), tenant="t1")).json().get("status") == "miss", "t1's first request is a miss"
        other = await _post(c, _body(), tenant="t2")
        assert other.json().get("status") == "miss", f"t2 asked for the prefix t1 warmed and got {other.json()}: one tenant's completion served to another. The key must carry the tenant"
        bumped = await _post(c, _body(version=8), tenant="t1")
        assert bumped.json().get("status") == "miss", f"t1 at prompt version 8 got {bumped.json()}: a version bump must start a fresh namespace. The key must carry the version"
        want = sorted(f"pc:{t}:{v}:{DIGEST}" for t, v in (("t1", 7), ("t2", 7), ("t1", 8)))
        assert _entries(ctx) == want, f"the entries must be pc:{{tenant}}:{{version}}:{{sha256(prefix)}}, expected {want}, found {_entries(ctx)}"


async def check_version_required(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {"prefix": PREFIX, "temperature": 0})
        assert r.status_code == 400, f"a body without prompt_version answered {r.status_code}: {r.text[:200]}. A missing version must be 400, not version 1"
        r = await _post(c, _body(version="7"))
        assert r.status_code == 400, f"prompt_version '7' (a string) answered {r.status_code}, expected 400"
        assert _model_calls(ctx) == 0 and _entries(ctx) == [], f"a rejected request must not reach the model or the cache: {_model_calls(ctx)} calls, entries {_entries(ctx)}"


async def check_no_echo(ctx):
    secret = "ACME-INTERNAL-ESCALATION-POLICY "
    async with _api(ctx) as c:
        r = await _post(c, _body(prefix=secret * 300))
        assert r.status_code == 413, f"a {len(secret) * 300}-byte prefix answered {r.status_code}, expected 413"
        assert "ACME-INTERNAL" not in r.text, f"the 413 body quotes the prompt: {r.text[:200]}. Error bodies end up in logs and trackers; say the limit, not the text"
        assert r.json().get("error") == "prefix_too_large", f"the 413 body carries error prefix_too_large, got {r.text[:200]}"
        assert _model_calls(ctx) == 0 and _entries(ctx) == [], "an oversized prefix must not reach the model or the cache"
        exact = await _post(c, _body(prefix="a" * 8192))
        assert exact.status_code == 200, f"exactly 8192 bytes is within the cap, got {exact.status_code}"
        multibyte = await _post(c, _body(prefix="é" * 4097))
        assert multibyte.status_code == 413, f"4097 two-byte characters are 8194 bytes and must be 413, got {multibyte.status_code}"
`,
    typescript: `import {createHash} from 'node:crypto';

const PREFIX = 'You are the support assistant for Acme Bank. Answer in two sentences: how do I reset my card PIN?';
const DIGEST = createHash('sha256').update(PREFIX, 'utf8').digest('hex');

/** The stand-in model server at MODEL, the learner's app. */
function api(ctx) {
  const {pcache} = ctx.proto('prompt_cache.proto');
  const config = ctx.load('/support/pcache/config.ts');
  const llm = ctx.load('/support/pcache/llm.ts');
  ctx.grpc.serve(pcache.Model.service, {
    Complete(call, callback) {
      callback(null, llm.complete(call.request.prefix, call.request.temperature));
    },
  }, config.MODEL);
  return {c: ctx.client(ctx.load('api').app), llm};
}

const body = (extra: Record<string, unknown> = {}) => ({prefix: PREFIX, prompt_version: 7, temperature: 0, ...extra});

function post(c, json, tenant: string | null = 't1') {
  return c.post('/v1/completions/cached', {json, headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});
}

const modelCalls = ctx => ctx.grpc.callsTo('Complete').length;
const entries = ctx => ctx.redis.keys('pc:*').sort();

export async function check_route(ctx) {
  const {c, llm} = api(ctx);
  const answer = llm.complete(PREFIX, 0).text;
  const first = await post(c, body());
  assert.equal(first.status, 200, \`a first request answered \${first.status}: \${first.text}\`);
  assert.deepEqual(first.json(), {status: 'miss', completion: answer}, \`a first request is a miss with the model's completion, got \${first.text}\`);
  const second = await post(c, body());
  assert(second.status === 200 && JSON.stringify(second.json()) === JSON.stringify({status: 'hit', completion: answer}), \`the same request again is a hit with the same completion, got \${second.status} \${second.text}\`);
  assert.equal(modelCalls(ctx), 1, \`a hit must not call the model: saw \${modelCalls(ctx)} Complete calls for two requests\`);
}

export async function check_tenant_header(ctx) {
  const {c} = api(ctx);
  const r = await post(c, body({tenant: 't1'}), null);
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status} because the body named a tenant: the body is the caller's claim, the header is its identity. Expected 401\`);
  assert.equal((await post(c, body())).json().status, 'miss', 't1 warms the prefix');
  const steered = await post(c, body({tenant: 't1'}), 't2');
  assert(steered.status === 200 && steered.json().status === 'miss', \`t2 naming tenant t1 in the body got \${steered.text}: it must be served as t2 (a miss), not from t1's entries\`);
  assert(entries(ctx).includes(\`pc:t2:7:\${DIGEST}\`), \`t2's request must fill pc:t2:7:{digest}, found \${JSON.stringify(entries(ctx))}\`);
}

export async function check_scoped_key(ctx) {
  const {c} = api(ctx);
  assert.equal((await post(c, body(), 't1')).json().status, 'miss', "t1's first request is a miss");
  const other = await post(c, body(), 't2');
  assert.equal(other.json().status, 'miss', \`t2 asked for the prefix t1 warmed and got \${other.text}: one tenant's completion served to another. The key must carry the tenant\`);
  const bumped = await post(c, body({prompt_version: 8}), 't1');
  assert.equal(bumped.json().status, 'miss', \`t1 at prompt version 8 got \${bumped.text}: a version bump must start a fresh namespace. The key must carry the version\`);
  const want = [['t1', 7], ['t2', 7], ['t1', 8]].map(([t, v]) => \`pc:\${t}:\${v}:\${DIGEST}\`).sort();
  assert.deepEqual(entries(ctx), want, \`the entries must be pc:{tenant}:{version}:{sha256(prefix)}, found \${JSON.stringify(entries(ctx))}\`);
}

export async function check_version_required(ctx) {
  const {c} = api(ctx);
  let r = await post(c, {prefix: PREFIX, temperature: 0});
  assert.equal(r.status, 400, \`a body without prompt_version answered \${r.status}: \${r.text.slice(0, 200)}. A missing version must be 400, not version 1\`);
  r = await post(c, body({prompt_version: '7'}));
  assert.equal(r.status, 400, \`prompt_version '7' (a string) answered \${r.status}, expected 400\`);
  assert(modelCalls(ctx) === 0 && entries(ctx).length === 0, \`a rejected request must not reach the model or the cache: \${modelCalls(ctx)} calls, entries \${JSON.stringify(entries(ctx))}\`);
}

export async function check_no_echo(ctx) {
  const {c} = api(ctx);
  const secret = 'ACME-INTERNAL-ESCALATION-POLICY ';
  const r = await post(c, body({prefix: secret.repeat(300)}));
  assert.equal(r.status, 413, \`a \${secret.length * 300}-byte prefix answered \${r.status}, expected 413\`);
  assert(!r.text.includes('ACME-INTERNAL'), \`the 413 body quotes the prompt: \${r.text.slice(0, 200)}. Error bodies end up in logs and trackers; say the limit, not the text\`);
  assert.equal(r.json().error, 'prefix_too_large', \`the 413 body carries error prefix_too_large, got \${r.text.slice(0, 200)}\`);
  assert(modelCalls(ctx) === 0 && entries(ctx).length === 0, 'an oversized prefix must not reach the model or the cache');
  assert.equal((await post(c, body({prefix: 'a'.repeat(8192)}))).status, 200, 'exactly 8192 bytes is within the cap');
  assert.equal((await post(c, body({prefix: 'é'.repeat(4097)}))).status, 413, '4097 two-byte characters are 8194 bytes and must be 413');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"pcache/config"
	"pcache/llm"
	"pcache/record"

	"leetbuild/harness"
)

const apiPrefix = "You are the support assistant for Acme Bank. Answer in two sentences: how do I reset my card PIN?"

var apiModelCalls int

func apiDigest(prefix string) string {
	sum := sha256.Sum256([]byte(prefix))
	return hex.EncodeToString(sum[:])
}

// apiClient serves the learner's handler with steps 2-4 stood in over the harness's Redis.
func apiClient(ctx *harness.Ctx) *harness.HTTP {
	apiModelCalls = 0
	lookup = func(_ context.Context, key string) (*record.Record, error) {
		raw, ok := ctx.Redis.Get(key)
		if !ok {
			return nil, nil
		}
		var rec record.Record
		err := json.Unmarshal([]byte(raw), &rec)
		return &rec, err
	}
	completeMiss = func(_ context.Context, key, tenant string, version int, prefix string, temperature float64) (record.Miss, error) {
		apiModelCalls++
		text, _, tokens := llm.Complete(prefix, temperature)
		raw, _ := json.Marshal(record.Record{Tenant: tenant, Version: version, Completion: text, Tokens: tokens})
		ctx.Redis.Set(key, string(raw), "EX", config.VersionTTLSeconds, "NX")
		return record.Miss{Status: "cached", Completion: text, Tokens: tokens}, nil
	}
	emitDecision = func(context.Context, string, int, string, string, int64, int) {}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiBody(prefix string, version any) map[string]any {
	return map[string]any{"prefix": prefix, "prompt_version": version, "temperature": 0}
}

func apiStatus(ctx *harness.Ctx, r *harness.Response) string {
	var out map[string]any
	r.Decode(&out)
	status, _ := out["status"].(string)
	return status
}

func apiEntries(ctx *harness.Ctx) []string {
	keys := ctx.Redis.Keys("pc:*")
	sort.Strings(keys)
	return keys
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	answer, _, _ := llm.Complete(apiPrefix, 0)
	first := c.Post("/v1/completions/cached", apiBody(apiPrefix, 7), "X-Tenant-Id", "t1")
	ctx.Equal(first.Status, 200, "a first request (%s)", first.Text())
	ctx.Equal(first.JSON(), map[string]any{"status": "miss", "completion": answer}, "a first request is a miss with the model's completion")
	second := c.Post("/v1/completions/cached", apiBody(apiPrefix, 7), "X-Tenant-Id", "t1")
	ctx.Equal(second.JSON(), map[string]any{"status": "hit", "completion": answer}, "the same request again is a hit with the same completion")
	ctx.Equal(apiModelCalls, 1, "a hit must not call the model; model calls for two requests")
}

func CheckTenantHeader(ctx *harness.Ctx) {
	c := apiClient(ctx)
	claimed := apiBody(apiPrefix, 7)
	claimed["tenant"] = "t1"
	r := c.Post("/v1/completions/cached", claimed)
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id whose body names a tenant: the body is the caller's claim, the header is its identity")
	ctx.Equal(apiStatus(ctx, c.Post("/v1/completions/cached", apiBody(apiPrefix, 7), "X-Tenant-Id", "t1")), "miss", "t1 warms the prefix")
	steered := c.Post("/v1/completions/cached", claimed, "X-Tenant-Id", "t2")
	ctx.Equal(apiStatus(ctx, steered), "miss", "t2 naming tenant t1 in the body must be served as t2 (a miss), not from t1's entries (%s)", steered.Text())
	key := "pc:t2:7:" + apiDigest(apiPrefix)
	ctx.Assert(ctx.Redis.Exists(key) == 1, "t2's request must fill %s, found %v", key, apiEntries(ctx))
}

func CheckScopedKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	ctx.Equal(apiStatus(ctx, c.Post("/v1/completions/cached", apiBody(apiPrefix, 7), "X-Tenant-Id", "t1")), "miss", "t1's first request")
	other := c.Post("/v1/completions/cached", apiBody(apiPrefix, 7), "X-Tenant-Id", "t2")
	ctx.Equal(apiStatus(ctx, other), "miss", "t2 asked for the prefix t1 warmed (%s): one tenant's completion served to another. The key must carry the tenant", other.Text())
	bumped := c.Post("/v1/completions/cached", apiBody(apiPrefix, 8), "X-Tenant-Id", "t1")
	ctx.Equal(apiStatus(ctx, bumped), "miss", "t1 at prompt version 8 (%s): a version bump must start a fresh namespace. The key must carry the version", bumped.Text())
	d := apiDigest(apiPrefix)
	ctx.Equal(apiEntries(ctx), []string{"pc:t1:7:" + d, "pc:t1:8:" + d, "pc:t2:7:" + d}, "the entries must be pc:{tenant}:{version}:{sha256(prefix)}")
}

func CheckVersionRequired(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := c.Post("/v1/completions/cached", map[string]any{"prefix": apiPrefix, "temperature": 0}, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 400, "a body without prompt_version (%s): a missing version must be 400, not version 1", r.Text())
	r = c.Post("/v1/completions/cached", apiBody(apiPrefix, "7"), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 400, "prompt_version \\"7\\" (a string)")
	ctx.Assert(apiModelCalls == 0 && len(apiEntries(ctx)) == 0, "a rejected request must not reach the model or the cache: %d calls, entries %v", apiModelCalls, apiEntries(ctx))
}

func CheckNoEcho(ctx *harness.Ctx) {
	c := apiClient(ctx)
	secret := "ACME-INTERNAL-ESCALATION-POLICY "
	r := c.Post("/v1/completions/cached", apiBody(strings.Repeat(secret, 300), 7), "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 413, "a %d-byte prefix", len(secret)*300)
	ctx.Assert(!strings.Contains(r.Text(), "ACME-INTERNAL"), "the 413 body quotes the prompt: %.200s. Error bodies end up in logs and trackers; say the limit, not the text", r.Text())
	var out map[string]any
	r.Decode(&out)
	ctx.Equal(out["error"], "prefix_too_large", "the 413 body's error")
	ctx.Assert(apiModelCalls == 0 && len(apiEntries(ctx)) == 0, "an oversized prefix must not reach the model or the cache")
	ctx.Equal(c.Post("/v1/completions/cached", apiBody(strings.Repeat("a", 8192), 7), "X-Tenant-Id", "t1").Status, 200, "exactly 8192 bytes is within the cap")
	ctx.Equal(c.Post("/v1/completions/cached", apiBody(strings.Repeat("é", 4097), 7), "X-Tenant-Id", "t1").Status, 413, "4097 two-byte characters are 8194 bytes")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "pcache/config.h"
#include "pcache/llm.h"

namespace {

using json = nlohmann::json;

const std::string kPrefix = "You are the support assistant for Acme Bank. Answer in two sentences: how do I reset my card PIN?";

harness::Ctx* apiCtx = nullptr;
int apiModelCalls = 0;

}  // namespace

// Steps 2-4 stood in over the harness's Redis.
std::optional<record::Record> lookup(const std::string& key) {
  const auto raw = apiCtx->Redis.Get(key);
  if (!raw) return std::nullopt;
  return record::decode(*raw);
}

record::Miss complete_miss(const std::string& key, const std::string& tenant, int version, const std::string& prefix,
                           double temperature) {
  apiModelCalls++;
  const llm::Completion c = llm::complete(prefix, temperature);
  apiCtx->Redis.Set(key, record::encode({tenant, version, c.text, c.tokens}), "EX", config::kVersionTtlSeconds, "NX");
  return {"cached", c.text, c.tokens};
}

void emit_decision(const std::string&, int, const std::string&, const std::string&, long long, int) {}

namespace {

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    apiCtx = &ctx;
    apiModelCalls = 0;
    register_routes(svr);
  }

  harness::Response post(const json& body, const std::string& tenant = "t1") {
    return http.Post("/v1/completions/cached", body.dump(), "X-Tenant-Id", tenant);
  }
};

json apiBody(const std::string& prefix, const json& version) {
  return {{"prefix", prefix}, {"prompt_version", version}, {"temperature", 0}};
}

std::string apiStatus(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("status", "") : "";
}

std::vector<std::string> apiEntries(harness::Ctx& ctx) {
  auto keys = ctx.Redis.Keys("pc:*");
  std::sort(keys.begin(), keys.end());
  return keys;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const std::string answer = llm::complete(kPrefix, 0).text;
  const auto first = api.post(apiBody(kPrefix, 7));
  ctx.Equal(first.Status, 200, "a first request (%s)", first.Text());
  ctx.Assert(json::parse(first.Text(), nullptr, false) == json{{"status", "miss"}, {"completion", answer}}, "a first request is a miss with the model's completion, got %s", first.Text());
  const auto second = api.post(apiBody(kPrefix, 7));
  ctx.Assert(json::parse(second.Text(), nullptr, false) == json{{"status", "hit"}, {"completion", answer}}, "the same request again is a hit with the same completion, got %s", second.Text());
  ctx.Equal(apiModelCalls, 1, "a hit must not call the model; model calls for two requests");
}

void CheckTenantHeader(harness::Ctx& ctx) {
  Api api(ctx);
  json claimed = apiBody(kPrefix, 7);
  claimed["tenant"] = "t1";
  const auto r = api.http.Post("/v1/completions/cached", claimed.dump());
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id whose body names a tenant: the body is the caller's claim, the header is its identity");
  ctx.Equal(apiStatus(api.post(apiBody(kPrefix, 7))), "miss", "t1 warms the prefix");
  const auto steered = api.post(claimed, "t2");
  ctx.Equal(apiStatus(steered), "miss", "t2 naming tenant t1 in the body must be served as t2 (a miss), not from t1's entries (%s)", steered.Text());
  const std::string key = "pc:t2:7:" + sha256_hex(kPrefix);
  ctx.Assert(ctx.Redis.Exists(key) == 1, "t2's request must fill %s, found %v", key, apiEntries(ctx));
}

void CheckScopedKey(harness::Ctx& ctx) {
  Api api(ctx);
  ctx.Equal(apiStatus(api.post(apiBody(kPrefix, 7), "t1")), "miss", "t1's first request");
  const auto other = api.post(apiBody(kPrefix, 7), "t2");
  ctx.Equal(apiStatus(other), "miss", "t2 asked for the prefix t1 warmed (%s): one tenant's completion served to another. The key must carry the tenant", other.Text());
  const auto bumped = api.post(apiBody(kPrefix, 8), "t1");
  ctx.Equal(apiStatus(bumped), "miss", "t1 at prompt version 8 (%s): a version bump must start a fresh namespace. The key must carry the version", bumped.Text());
  const std::string d = sha256_hex(kPrefix);
  ctx.Equal(apiEntries(ctx), {"pc:t1:7:" + d, "pc:t1:8:" + d, "pc:t2:7:" + d}, "the entries must be pc:{tenant}:{version}:{sha256(prefix)}");
}

void CheckVersionRequired(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = api.post(json{{"prefix", kPrefix}, {"temperature", 0}});
  ctx.Equal(r.Status, 400, "a body without prompt_version (%s): a missing version must be 400, not version 1", r.Text());
  r = api.post(apiBody(kPrefix, "7"));
  ctx.Equal(r.Status, 400, "prompt_version \\"7\\" (a string)");
  ctx.Assert(apiModelCalls == 0 && apiEntries(ctx).empty(), "a rejected request must not reach the model or the cache: %d calls, entries %v", apiModelCalls, apiEntries(ctx));
}

void CheckNoEcho(harness::Ctx& ctx) {
  Api api(ctx);
  std::string big;
  for (int i = 0; i < 300; i++) big += "ACME-INTERNAL-ESCALATION-POLICY ";
  const auto r = api.post(apiBody(big, 7));
  ctx.Equal(r.Status, 413, "a %d-byte prefix", big.size());
  ctx.Assert(r.Text().find("ACME-INTERNAL") == std::string::npos, "the 413 body quotes the prompt: %s. Error bodies end up in logs and trackers; say the limit, not the text", r.Text().substr(0, 200));
  const json out = json::parse(r.Text(), nullptr, false);
  ctx.Assert(out.is_object() && out.value("error", "") == "prefix_too_large", "the 413 body carries error prefix_too_large, got %s", r.Text().substr(0, 200));
  ctx.Assert(apiModelCalls == 0 && apiEntries(ctx).empty(), "an oversized prefix must not reach the model or the cache");
  ctx.Equal(api.post(apiBody(std::string(8192, 'a'), 7)).Status, 200, "exactly 8192 bytes is within the cap");
  std::string wide;
  for (int i = 0; i < 4097; i++) wide += "\\u00e9";
  ctx.Equal(api.post(apiBody(wide, 7)).Status, 413, "4097 two-byte characters are 8194 bytes");
}
`,
  },
  debrief: `The key carries every input the answer depends on and nothing the caller can forge. The tenant comes from the authenticated header because a body field is the caller's claim, not its identity. The version is in the key so a template change starts a fresh namespace without a purge, and requiring it stops an old client from reading version 1 for ever. The digest keeps prompt text out of the key space, and the 413 states the limit instead of quoting the request, because error bodies land in logs and trackers with long retention. Production gateways sign the tenant into a token at the edge rather than trusting a plain header, and add the model id to the key once two versions can share a template.`,
};
