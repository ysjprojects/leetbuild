import type {Step} from '@/lib/types';

// ---- 5. Short response cache -----------------------------------------------------------------------
export const responseCacheStep: Step = {
  id: 'response-cache',
  title: 'Cache 200 responses for ten seconds',
  concept: 'redis',
  file: 'response_cache',
  focus: ['gateway', 'redis', 'catalog'],
  task: `## Task

The same items are asked for thousands of times a minute. Put a **10 s response cache** in front of the
proxy. \`upstream(request)\` is provided: it is the step-3 proxy and returns status, content type and body.

- The key is \`resp:{sha256(path?query)}\` — the hash keeps keys short and safe whatever the query holds.
- On a hit, answer from Redis with the stored content type and \`X-Cache: HIT\`.
- On a miss, call \`upstream\`, answer with \`X-Cache: MISS\`, and store **body and content type together**
  (a JSON document or a small hash) with **\`EX 10\`** — but **only when the status is 200**. A 404 or a
  503 must never be served from cache.
- A request with \`Cache-Control: no-cache\` **bypasses the lookup** (it still refreshes the entry).

:::widget cache-aside {}

> Ten seconds sounds short. At 2 000 requests/s for one hot item it turns 20 000 gRPC calls into one.`,
  sequence: {
    participants: ['Client', 'gateway', 'Redis', 'Catalog'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'GET /items/42', kind: 'sync'},
      {from: 'gateway', to: 'Redis', label: 'GET resp:sha256(/items/42)', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '(nil)', kind: 'reply'},
      {from: 'gateway', to: 'Catalog', label: 'GetItem{42}', kind: 'sync'},
      {from: 'Catalog', to: 'gateway', label: '200 · Item', kind: 'reply'},
      {from: 'gateway', to: 'Redis', label: 'SET resp:… {content_type, body} EX 10', kind: 'sync'},
      {from: 'gateway', to: 'Client', label: '200 · X-Cache: MISS', kind: 'reply'},
    ],
  },
  hints: [
    'Same shape as any cache-aside: compute the key, look it up unless the client said `no-cache`, and on a miss fetch and store. The only new rule is the status guard around the store.',
    'The cache entry needs two things to reproduce a response: the body and its content type. Serialize both into one value (JSON with two fields, or `content_type\\nbody`) so a single `GET` restores the whole response.',
    'Order on the miss path: call `upstream`, set `X-Cache: MISS`, then `if status == 200: SET key entry EX 10`. Non-200 responses are returned as-is and never touch Redis.',
  ],
  checks: [
    {
      id: 'key-hash',
      title: 'Keys by resp: plus the SHA-256 of path and query',
      detail:
        'The key is `resp:{sha256(path?query)}`: a fixed-length key that cannot collide across query strings or contain unsafe characters.',
      match: {
        python: {all: [/["']resp:["']\s*\+|f["']resp:\{/, /hashlib\.sha256\(/]},
        typescript: {all: [/['"]resp:['"]\s*\+|`resp:\$\{/, /createHash\(\s*['"]sha256['"]\s*\)/]},
        go: {all: [/"resp:"\s*\+|"resp:%x"/, /sha256\.Sum256\(/]},
        scala: {all: [/"resp:"\s*\+/, /"SHA-256"/]},
        cpp: {all: [/"resp:"\s*\+/, /sha256_hex\(/]},
      },
    },
    {
      id: 'bypass',
      title: 'Cache-Control: no-cache skips the lookup',
      detail:
        'A client sending `Cache-Control: no-cache` must reach the upstream; check the request header before reading Redis.',
      match: {
        python: {all: [/cache-control/i, /no-cache/]},
        typescript: {all: [/cache-control/i, /no-cache/]},
        go: {all: [/cache-control/i, /no-cache/]},
        scala: {all: [/cache-control/i, /no-cache/]},
        cpp: {all: [/cache-control/i, /no-cache/]},
      },
    },
    {
      id: 'ttl',
      title: 'Entries expire after 10 s',
      detail:
        'Store the entry with `EX 10` (`SET key value EX ttl` / `SETEX`, using the file’s 10 s TTL constant); a response cache without expiry serves stale prices forever.',
      match: {
        python: {all: [/\.set\(\s*key\s*,[^\n]*ex\s*=\s*(TTL_S|10)\s*\)|\.setex\(\s*key\s*,\s*(TTL_S|10)\s*,/]},
        typescript: {
          all: [/\.set\(\s*key\s*,[^\n]*['"]EX['"]\s*,\s*(TTL_S|10)\s*\)|\.setex\(\s*key\s*,\s*(TTL_S|10)\s*,/],
        },
        go: {all: [/rdb\.Set(Ex|EX)?\(\s*ctx\s*,\s*key\s*,[^\n]*,\s*(ttl|10\s*\*\s*time\.Second)\s*\)/]},
        scala: {all: [/jedis\.setex\(\s*key\s*,\s*(TtlSeconds|10L?)\s*,/]},
        cpp: {
          all: [
            /redis\.set\(\s*key\s*,[^\n]*,\s*(kTtl|std::chrono::seconds[({]\s*10\s*[)}]|10s)\s*\)|redis\.setex\(\s*key\s*,\s*(kTtl|10)\b/,
          ],
        },
      },
    },
    {
      id: 'only-200',
      title: 'Never caches a non-200 response',
      detail:
        'The store must be guarded by a status check (`== 200`) that comes before the `SET`; caching a 404 or 503 makes an outage last the TTL.',
      match: {
        python: {order: [/status_code\s*==\s*200/, /\.set(ex)?\(\s*key/]},
        typescript: {order: [/status\s*===?\s*200/, /\.set(ex)?\(\s*key/]},
        go: {order: [/StatusCode\s*==\s*(http\.StatusOK|200)/, /rdb\.Set(Ex|EX)?\(\s*ctx\s*,\s*key/]},
        scala: {order: [/status\s*==\s*StatusCodes\.OK|intValue\s*==\s*200/, /jedis\.setex\(\s*key/]},
        cpp: {order: [/status\s*==\s*200/, /redis\.set(ex)?\(\s*key/]},
      },
    },
    {
      id: 'x-cache',
      title: 'Reports HIT or MISS in X-Cache',
      detail:
        'Every response carries `X-Cache: HIT` or `X-Cache: MISS` so operators (and curl) can see what the cache is doing.',
      match: {
        python: {all: [/X-Cache/, /"HIT"/, /"MISS"/]},
        typescript: {all: [/X-Cache/, /['"]HIT['"]/, /['"]MISS['"]/]},
        go: {all: [/X-Cache/, /"HIT"/, /"MISS"/]},
        scala: {all: [/X-Cache/, /"HIT"/, /"MISS"/]},
        cpp: {all: [/X-Cache/, /"HIT"/, /"MISS"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json

import redis
from fastapi import FastAPI, Request, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

TTL_S = 10


def upstream(request: Request) -> Response:
    """The gRPC proxy from step 3: status_code, media_type and body for this request."""
    raise NotImplementedError


def cache_key(request: Request) -> str:
    # TODO: "resp:" + sha256 of path?query
    raise NotImplementedError


@app.get("/items/{item_id}")
def get_item(item_id: str, request: Request) -> Response:
    key = cache_key(request)
    # TODO: unless Cache-Control: no-cache, GET key → hit: stored body + media type, X-Cache: HIT
    # TODO: miss → upstream(); X-Cache: MISS; when status_code == 200 SET {content_type, body} EX TTL_S
    return upstream(request)
`,
      solution: `import hashlib
import json

import redis
from fastapi import FastAPI, Request, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

TTL_S = 10


def upstream(request: Request) -> Response:
    """The gRPC proxy from step 3: status_code, media_type and body for this request."""
    raise NotImplementedError


def cache_key(request: Request) -> str:
    target = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    return "resp:" + hashlib.sha256(target.encode()).hexdigest()


@app.get("/items/{item_id}")
def get_item(item_id: str, request: Request) -> Response:
    key = cache_key(request)
    bypass = "no-cache" in request.headers.get("cache-control", "")
    if not bypass and (hit := r.get(key)) is not None:
        entry = json.loads(hit)
        return Response(content=entry["body"], media_type=entry["content_type"], headers={"X-Cache": "HIT"})
    response = upstream(request)
    response.headers["X-Cache"] = "MISS"
    if response.status_code == 200:
        entry = json.dumps({"content_type": response.media_type, "body": response.body.decode()})
        r.set(key, entry, ex=TTL_S)
    return response
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';
import Fastify, {type FastifyRequest} from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 10;

export interface Upstream {
  status: number;
  contentType: string;
  body: string;
}

/** The gRPC proxy from step 3 (provided): status, content type and body for this request. */
export const proxy = {
  async upstream(request: FastifyRequest): Promise<Upstream> {
    throw new Error('not implemented');
  },
};

export function cacheKey(request: FastifyRequest): string {
  // TODO: 'resp:' + sha256 hex of path?query (request.url)
  throw new Error('not implemented');
}

app.get('/items/:id', async (request, reply) => {
  const key = cacheKey(request);
  // TODO: unless the request says no-cache, GET key → hit: stored body + content type, X-Cache: HIT
  // TODO: miss → proxy.upstream(); X-Cache: MISS; when status is 200 SET {content_type, body} EX TTL_S
  const response = await proxy.upstream(request);
  return reply.code(response.status).type(response.contentType).send(response.body);
});
`,
      solution: `import {createHash} from 'node:crypto';
import Fastify, {type FastifyRequest} from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 10;

export interface Upstream {
  status: number;
  contentType: string;
  body: string;
}

/** The gRPC proxy from step 3 (provided): status, content type and body for this request. */
export const proxy = {
  async upstream(request: FastifyRequest): Promise<Upstream> {
    throw new Error('not implemented');
  },
};

export function cacheKey(request: FastifyRequest): string {
  // request.url is path?query as the client sent it
  return 'resp:' + createHash('sha256').update(request.url).digest('hex');
}

app.get('/items/:id', async (request, reply) => {
  const key = cacheKey(request);
  const bypass = (request.headers['cache-control'] ?? '').includes('no-cache');
  if (!bypass) {
    const hit = await redis.get(key);
    if (hit !== null) {
      const entry = JSON.parse(hit) as {content_type: string; body: string};
      return reply.header('X-Cache', 'HIT').type(entry.content_type).send(entry.body);
    }
  }
  const response = await proxy.upstream(request);
  reply.header('X-Cache', 'MISS');
  if (response.status === 200) {
    const entry = JSON.stringify({content_type: response.contentType, body: response.body});
    await redis.set(key, entry, 'EX', TTL_S);
  }
  return reply.code(response.status).type(response.contentType).send(response.body);
});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ttl = 10 * time.Second

// upstreamResponse is what the step-3 proxy produces; Body is base64 in JSON, which keeps it binary-safe.
type upstreamResponse struct {
	StatusCode  int    \`json:"-"\`
	ContentType string \`json:"content_type"\`
	Body        []byte \`json:"body"\`
}

func upstream(r *http.Request) upstreamResponse {
	panic("not implemented")
}

func cacheKey(r *http.Request) string {
	// TODO: "resp:" + hex sha256 of r.URL.RequestURI() (path plus query)
	_ = sha256.Sum256
	_ = hex.EncodeToString
	return ""
}

func getItem(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := cacheKey(r)
	// TODO: unless Cache-Control: no-cache, GET key → hit: stored body + content type, X-Cache: HIT
	// TODO: miss → upstream(); X-Cache: MISS; when StatusCode == 200 SET the JSON entry with ttl
	_, _ = ctx, key
	_ = strings.Contains
	_ = json.Marshal
	resp := upstream(r)
	rw.Header().Set("Content-Type", resp.ContentType)
	rw.WriteHeader(resp.StatusCode)
	rw.Write(resp.Body)
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ttl = 10 * time.Second

// upstreamResponse is what the step-3 proxy produces; Body is base64 in JSON, which keeps it binary-safe.
type upstreamResponse struct {
	StatusCode  int    \`json:"-"\`
	ContentType string \`json:"content_type"\`
	Body        []byte \`json:"body"\`
}

func upstream(r *http.Request) upstreamResponse {
	panic("not implemented")
}

func cacheKey(r *http.Request) string {
	sum := sha256.Sum256([]byte(r.URL.RequestURI()))
	return "resp:" + hex.EncodeToString(sum[:])
}

func getItem(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := cacheKey(r)
	bypass := strings.Contains(r.Header.Get("Cache-Control"), "no-cache")
	if !bypass {
		if raw, err := rdb.Get(ctx, key).Bytes(); err == nil {
			var entry upstreamResponse
			if json.Unmarshal(raw, &entry) == nil {
				rw.Header().Set("Content-Type", entry.ContentType)
				rw.Header().Set("X-Cache", "HIT")
				rw.Write(entry.Body)
				return
			}
		}
	}
	resp := upstream(r)
	if resp.StatusCode == http.StatusOK {
		entry, _ := json.Marshal(resp)
		rdb.Set(ctx, key, entry, ttl)
	}
	rw.Header().Set("Content-Type", resp.ContentType)
	rw.Header().Set("X-Cache", "MISS")
	rw.WriteHeader(resp.StatusCode)
	rw.Write(resp.Body)
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.{\`Cache-Control\`, CacheDirectives, RawHeader}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

object ResponseCache {
  val jedis = new JedisPooled("redis", 6379)
  val TtlSeconds = 10L

  /** The gRPC proxy from step 3: status, content type and body for this request. */
  def upstream(request: HttpRequest): (StatusCode, String, String) = ???

  private def respond(status: StatusCode, contentType: String, body: String, cache: String): Route = {
    val ct = ContentType.parse(contentType).getOrElse(ContentTypes.\`application/json\`)
    complete(HttpResponse(status, headers = List(RawHeader("X-Cache", cache)), entity = HttpEntity(ct, body)))
  }

  private def cacheKey(request: HttpRequest): String = {
    val target = request.uri.toRelative.toString // path plus query
    ??? // TODO: "resp:" + hex SHA-256 of target
  }

  val route: Route =
    (get & path("items" / Segment) & extractRequest) { (_, request) =>
      val key = cacheKey(request)
      // TODO: unless Cache-Control: no-cache, jedis.get(key) → hit: stored content type + body, "HIT"
      // TODO: miss → upstream(); "MISS"; when status == StatusCodes.OK SETEX key TtlSeconds "contentType\\nbody"
      val (status, contentType, body) = upstream(request)
      respond(status, contentType, body, "NONE")
    }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.{\`Cache-Control\`, CacheDirectives, RawHeader}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

object ResponseCache {
  val jedis = new JedisPooled("redis", 6379)
  val TtlSeconds = 10L

  /** The gRPC proxy from step 3: status, content type and body for this request. */
  def upstream(request: HttpRequest): (StatusCode, String, String) = ???

  private def respond(status: StatusCode, contentType: String, body: String, cache: String): Route = {
    val ct = ContentType.parse(contentType).getOrElse(ContentTypes.\`application/json\`)
    complete(HttpResponse(status, headers = List(RawHeader("X-Cache", cache)), entity = HttpEntity(ct, body)))
  }

  private def cacheKey(request: HttpRequest): String = {
    val target = request.uri.toRelative.toString // path plus query
    "resp:" + MessageDigest.getInstance("SHA-256").digest(target.getBytes).map("%02x".format(_)).mkString
  }

  val route: Route =
    (get & path("items" / Segment) & extractRequest) { (_, request) =>
      val key = cacheKey(request)
      val bypass = request.header[\`Cache-Control\`].exists(_.directives.contains(CacheDirectives.\`no-cache\`))
      Option(if (bypass) null else jedis.get(key)) match {
        case Some(hit) =>
          val Array(contentType, body) = hit.split("\\n", 2) // content types never contain a newline
          respond(StatusCodes.OK, contentType, body, "HIT")
        case None =>
          val (status, contentType, body) = upstream(request)
          if (status == StatusCodes.OK) jedis.setex(key, TtlSeconds, contentType + "\\n" + body)
          respond(status, contentType, body, "MISS")
      }
    }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{10};

struct Upstream {
  int status;
  std::string content_type;
  std::string body;
};

// The gRPC proxy from step 3.
Upstream upstream(const httplib::Request& req);

std::string cache_key(const httplib::Request& req) {
  // TODO: "resp:" + sha256 of req.target (path plus query)
  return "";
}

void get_item(const httplib::Request& req, httplib::Response& res) {
  const std::string key = cache_key(req);
  // TODO: unless Cache-Control: no-cache, redis.get(key) → hit: stored content type + body, X-Cache: HIT
  // TODO: miss → upstream(); X-Cache: MISS; when status == 200 SET key "content_type\\nbody" with kTtl
  const Upstream up = upstream(req);
  res.status = up.status;
  res.set_content(up.body, up.content_type);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "sha256.h"  // std::string sha256_hex(const std::string&)

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kTtl{10};

struct Upstream {
  int status;
  std::string content_type;
  std::string body;
};

// The gRPC proxy from step 3.
Upstream upstream(const httplib::Request& req);

std::string cache_key(const httplib::Request& req) {
  return "resp:" + sha256_hex(req.target);  // target is the path plus the query string
}

void get_item(const httplib::Request& req, httplib::Response& res) {
  const std::string key = cache_key(req);
  const bool bypass = req.get_header_value("Cache-Control").find("no-cache") != std::string::npos;
  if (!bypass) {
    if (const auto hit = redis.get(key)) {
      const auto nl = hit->find('\\n');  // content types never contain a newline
      res.set_header("X-Cache", "HIT");
      res.set_content(hit->substr(nl + 1), hit->substr(0, nl));
      return;
    }
  }
  const Upstream up = upstream(req);
  if (up.status == 200) redis.set(key, up.content_type + "\\n" + up.body, kTtl);
  res.status = up.status;
  res.set_header("X-Cache", "MISS");
  res.set_content(up.body, up.content_type);
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

from fastapi import Response


def _cache(ctx):
    m = ctx.load("response_cache")
    m.calls = []

    def upstream(request):
        target = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        m.calls.append(target)
        item_id = request.path_params["item_id"]
        if item_id == "ghost":
            return Response(content='{"error": "no such item"}', status_code=404, media_type="application/json")
        if item_id == "down":
            return Response(content="catalog unavailable", status_code=503, media_type="text/plain")
        if item_id == "plain":
            return Response(content=f"plain item, fetch {len(m.calls)}", media_type="text/plain")
        body = json.dumps({"id": item_id, "name": "Kettle", "price_cents": 3499, "fetch": len(m.calls)})
        return Response(content=body, media_type="application/json")

    m.upstream = upstream
    return m


def _key(target):
    return "resp:" + hashlib.sha256(target.encode()).hexdigest()


async def check_key_hash(ctx):
    m = _cache(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get("/items/42?fields=name")
        assert r.status_code == 200, f"GET /items/42?fields=name answered {r.status_code}"
        await c.get("/items/42")
    keys = sorted(ctx.redis.keys("*"))
    for target in ("/items/42?fields=name", "/items/42"):
        assert ctx.redis.exists(_key(target)), f"no entry under resp:sha256({target!r}) = {_key(target)!r}; Redis holds {keys}"
    assert len(keys) == 2, f"two distinct targets must make two distinct keys, Redis holds {keys}"


async def check_bypass(ctx):
    m = _cache(ctx)
    async with ctx.client(m.app) as c:
        first = await c.get("/items/42")
        second = await c.get("/items/42")
        assert second.headers.get("x-cache") == "HIT" and len(m.calls) == 1, "a second request within the TTL must be served from the cache"
        bypass = await c.get("/items/42", headers={"Cache-Control": "no-cache"})
        assert len(m.calls) == 2, "Cache-Control: no-cache must reach the upstream, not the cached entry"
        assert bypass.headers.get("x-cache") == "MISS", f"a bypassed request reports X-Cache {bypass.headers.get('x-cache')!r}, expected MISS"
        assert bypass.json().get("fetch") == 2, "the bypassed request must answer with the fresh upstream response"
        after = await c.get("/items/42")
    assert after.headers.get("x-cache") == "HIT" and len(m.calls) == 2, "the bypassed request still refreshes the entry: the next plain request is a hit"
    assert after.json().get("fetch") == 2, f"the entry was not refreshed by the bypassed request: served fetch {after.json().get('fetch')}, expected 2"


async def check_ttl(ctx):
    m = _cache(ctx)
    async with ctx.client(m.app) as c:
        await c.get("/items/42")
        ttl = ctx.redis.ttl(_key("/items/42"))
        assert ttl == 10, f"the entry's TTL is {ttl} (-1 means no expiry), expected EX 10"
        ctx.clock.advance(9.0)
        warm = await c.get("/items/42")
        assert warm.headers.get("x-cache") == "HIT" and len(m.calls) == 1, "9 s after the store the entry is still fresh"
        ctx.clock.advance(2.0)
        cold = await c.get("/items/42")
    assert cold.headers.get("x-cache") == "MISS" and len(m.calls) == 2, "11 s after the store the entry has expired: the upstream must be asked again"


async def check_only_200(ctx):
    m = _cache(ctx)
    async with ctx.client(m.app) as c:
        ghost = await c.get("/items/ghost")
        assert ghost.status_code == 404, f"a 404 from the upstream answered {ghost.status_code}"
        assert ctx.redis.keys("*") == [], f"a 404 was stored: {ctx.redis.keys('*')}"
        again = await c.get("/items/ghost")
        assert again.status_code == 404 and len(m.calls) == 2, "a 404 must be asked upstream again, never served from cache"
        down = await c.get("/items/down")
        assert down.status_code == 503, f"a 503 from the upstream answered {down.status_code}"
        assert ctx.redis.keys("*") == [], f"a 503 was stored: {ctx.redis.keys('*')}"
        ok = await c.get("/items/42")
    assert ok.status_code == 200 and ctx.redis.exists(_key("/items/42")), "a 200 must still be stored"


async def check_x_cache(ctx):
    m = _cache(ctx)
    async with ctx.client(m.app) as c:
        miss = await c.get("/items/42")
        hit = await c.get("/items/42")
        plain_miss = await c.get("/items/plain")
        plain_hit = await c.get("/items/plain")
    assert miss.headers.get("x-cache") == "MISS", f"the first request reports X-Cache {miss.headers.get('x-cache')!r}, expected MISS"
    assert hit.headers.get("x-cache") == "HIT", f"the second request reports X-Cache {hit.headers.get('x-cache')!r}, expected HIT"
    assert len(m.calls) == 2, f"the upstream was called {len(m.calls)} times for four requests, expected 2 (one per distinct target)"
    assert hit.status_code == 200 and hit.content == miss.content, "a hit must replay the stored body"
    assert hit.headers.get("content-type", "").startswith("application/json"), f"a hit must replay the stored content type, got {hit.headers.get('content-type')!r}"
    assert plain_hit.headers.get("x-cache") == "HIT" and plain_hit.content == plain_miss.content, "text responses are cached like any other 200"
    assert plain_hit.headers.get("content-type", "").startswith("text/plain"), f"the hit for a text/plain upstream answered Content-Type {plain_hit.headers.get('content-type')!r}: store the content type with the body"
`,
    typescript: `import {createHash} from 'node:crypto';

/** The step-3 proxy, swapped onto the learner's provided proxy object: counts every fetch, answers per item id. */
function cache(ctx) {
  const m = ctx.load('response_cache');
  const calls: string[] = [];
  m.proxy.upstream = async request => {
    calls.push(request.url);
    const {id} = request.params as {id: string};
    if (id === 'ghost') return {status: 404, contentType: 'application/json', body: '{"error": "no such item"}'};
    if (id === 'down') return {status: 503, contentType: 'text/plain', body: 'catalog unavailable'};
    if (id === 'plain') return {status: 200, contentType: 'text/plain', body: \`plain item, fetch \${calls.length}\`};
    const body = JSON.stringify({id, name: 'Kettle', price_cents: 3499, fetch: calls.length});
    return {status: 200, contentType: 'application/json', body};
  };
  return {m, calls, c: ctx.client(m.app)};
}

const key = (target: string): string => 'resp:' + createHash('sha256').update(target).digest('hex');

export async function check_key_hash(ctx) {
  const {c} = cache(ctx);
  const r = await c.get('/items/42?fields=name');
  assert.equal(r.status, 200, \`GET /items/42?fields=name answered \${r.status}\`);
  await c.get('/items/42');
  const keys = ctx.redis.keys('*').sort();
  for (const target of ['/items/42?fields=name', '/items/42']) {
    assert(ctx.redis.exists(key(target)), \`no entry under resp:sha256(\${JSON.stringify(target)}) = \${JSON.stringify(key(target))}; Redis holds \${JSON.stringify(keys)}\`);
  }
  assert.equal(keys.length, 2, \`two distinct targets must make two distinct keys, Redis holds \${JSON.stringify(keys)}\`);
}

export async function check_bypass(ctx) {
  const {c, calls} = cache(ctx);
  await c.get('/items/42');
  const second = await c.get('/items/42');
  assert(second.headers['x-cache'] === 'HIT' && calls.length === 1, 'a second request within the TTL must be served from the cache');
  const bypass = await c.get('/items/42', {headers: {'Cache-Control': 'no-cache'}});
  assert.equal(calls.length, 2, 'Cache-Control: no-cache must reach the upstream, not the cached entry');
  assert.equal(bypass.headers['x-cache'], 'MISS', \`a bypassed request reports X-Cache \${JSON.stringify(bypass.headers['x-cache'])}, expected MISS\`);
  assert.equal(bypass.json().fetch, 2, 'the bypassed request must answer with the fresh upstream response');
  const after = await c.get('/items/42');
  assert(after.headers['x-cache'] === 'HIT' && calls.length === 2, 'the bypassed request still refreshes the entry: the next plain request is a hit');
  assert.equal(after.json().fetch, 2, \`the entry was not refreshed by the bypassed request: served fetch \${after.json().fetch}, expected 2\`);
}

export async function check_ttl(ctx) {
  const {c, calls} = cache(ctx);
  await c.get('/items/42');
  const ttl = ctx.redis.ttl(key('/items/42'));
  assert(1 <= ttl && ttl <= 10, \`the entry's TTL is \${ttl} (-1 means no expiry), expected EX 10\`);
  ctx.clock.advance(9.0);
  const warm = await c.get('/items/42');
  assert(warm.headers['x-cache'] === 'HIT' && calls.length === 1, '9 s after the store the entry is still fresh');
  ctx.clock.advance(2.0);
  const cold = await c.get('/items/42');
  assert(cold.headers['x-cache'] === 'MISS' && calls.length === 2, '11 s after the store the entry has expired: the upstream must be asked again');
}

export async function check_only_200(ctx) {
  const {c, calls} = cache(ctx);
  const ghost = await c.get('/items/ghost');
  assert.equal(ghost.status, 404, \`a 404 from the upstream answered \${ghost.status}\`);
  assert.deepEqual(ctx.redis.keys('*'), [], \`a 404 was stored: \${JSON.stringify(ctx.redis.keys('*'))}\`);
  const again = await c.get('/items/ghost');
  assert(again.status === 404 && calls.length === 2, 'a 404 must be asked upstream again, never served from cache');
  const down = await c.get('/items/down');
  assert.equal(down.status, 503, \`a 503 from the upstream answered \${down.status}\`);
  assert.deepEqual(ctx.redis.keys('*'), [], \`a 503 was stored: \${JSON.stringify(ctx.redis.keys('*'))}\`);
  const ok = await c.get('/items/42');
  assert(ok.status === 200 && ctx.redis.exists(key('/items/42')), 'a 200 must still be stored');
}

export async function check_x_cache(ctx) {
  const {c, calls} = cache(ctx);
  const miss = await c.get('/items/42');
  const hit = await c.get('/items/42');
  const plainMiss = await c.get('/items/plain');
  const plainHit = await c.get('/items/plain');
  assert.equal(miss.headers['x-cache'], 'MISS', \`the first request reports X-Cache \${JSON.stringify(miss.headers['x-cache'])}, expected MISS\`);
  assert.equal(hit.headers['x-cache'], 'HIT', \`the second request reports X-Cache \${JSON.stringify(hit.headers['x-cache'])}, expected HIT\`);
  assert.equal(calls.length, 2, \`the upstream was called \${calls.length} times for four requests, expected 2 (one per distinct target)\`);
  assert(hit.status === 200 && hit.text === miss.text, 'a hit must replay the stored body');
  assert((hit.headers['content-type'] ?? '').startsWith('application/json'), \`a hit must replay the stored content type, got \${JSON.stringify(hit.headers['content-type'])}\`);
  assert(plainHit.headers['x-cache'] === 'HIT' && plainHit.text === plainMiss.text, 'text responses are cached like any other 200');
  assert((plainHit.headers['content-type'] ?? '').startsWith('text/plain'), \`the hit for a text/plain upstream answered Content-Type \${JSON.stringify(plainHit.headers['content-type'])}: store the content type with the body\`);
}
`,
  },
  debrief: `A response cache is cache-aside applied to whole HTTP responses, which is why the entry has to carry its content type and why the status guard matters: a cached error is an outage that outlives its cause. Ten seconds is a *micro-cache* — it flattens hot-key bursts without making anyone see stale data for long. Real gateways honour \`Vary\` (per-\`Accept\`, per-tenant keys), respect the upstream's own \`Cache-Control\`, add stale-while-revalidate so a hot key is refreshed in the background, and single-flight concurrent misses as in the stampede step of the image cache.`,
};
