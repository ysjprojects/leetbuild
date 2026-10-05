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
  debrief: `A response cache is cache-aside applied to whole HTTP responses, which is why the entry has to carry its content type and why the status guard matters: a cached error is an outage that outlives its cause. Ten seconds is a *micro-cache* — it flattens hot-key bursts without making anyone see stale data for long. Real gateways honour \`Vary\` (per-\`Accept\`, per-tenant keys), respect the upstream's own \`Cache-Control\`, add stale-while-revalidate so a hot key is refreshed in the background, and single-flight concurrent misses as in the stampede step of the image cache.`,
};
