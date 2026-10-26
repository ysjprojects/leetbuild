import type {Step} from '@/lib/types';

export const redirectCacheStep: Step = {
  id: 'redirect-cache',
  title: 'GET /{code}: the redirect as one cache hit',
  concept: 'redis',
  file: 'redirect',
  focus: ['client', 'api', 'redis', 'db'],
  task: `## Task

Implement \`resolve(code)\` as a **cache-aside** lookup and the \`GET /{code}\` handler on top of it.
\`store.lookup(code)\` is provided: the long URL from the links table, or nothing for an unknown code.

- The key is \`url:{code}\`. Read Redis first; a hit is the whole request.
- On a miss, ask the store and \`SET\` the result with a **TTL of 86400 s**.
- Unknown code → store a short-lived sentinel (**60 s**) so a typo or a scanner does not hit the
  database on every try (**negative caching**), and answer **404**.
- Found → **302** with \`Location\` and \`Cache-Control: private, max-age=0\`. Not 301: a permanent
  redirect is cached by the browser, and every later click would bypass you — and the analytics of
  the next step — entirely.

:::widget cache-aside {}`,
  sequence: {
    participants: ['Browser', 'sho.rt', 'Redis', 'links'],
    messages: [
      {from: 'Browser', to: 'sho.rt', label: 'GET /g9Xc', kind: 'sync'},
      {from: 'sho.rt', to: 'Redis', label: 'GET url:g9Xc', kind: 'sync'},
      {from: 'Redis', to: 'sho.rt', label: '(nil)', kind: 'reply'},
      {from: 'sho.rt', to: 'links', label: 'lookup("g9Xc")', kind: 'sync'},
      {from: 'links', to: 'sho.rt', label: 'https://example.com/launch', kind: 'reply'},
      {from: 'sho.rt', to: 'Redis', label: 'SET url:g9Xc <url> EX 86400', kind: 'sync'},
      {from: 'sho.rt', to: 'Browser', label: '302 · Location · Cache-Control: private, max-age=0', kind: 'reply'},
    ],
  },
  hints: [
    'Three outcomes of the cache read: a URL (return it), the sentinel (return nothing), nil (go to the store). Write the hit branch first; it is the one that runs almost every time.',
    'Both writes are the same SET with an expiry — only the value and the TTL differ: the URL for 86400 s, the sentinel for 60 s.',
    'The handler is two lines of policy: nothing → 404; a URL → 302 with the two headers. Keep the status a 302 (or 307): the browser must come back for every click.',
  ],
  checks: [
    {
      id: 'key',
      title: 'Cache key is url:{code}',
      detail: 'Use `url:{code}` so the redirect is one GET on a key derived from the path.',
      match: {
        python: {all: [/f["']url:\{code\}["']|["']url:["']\s*\+\s*code/]},
        typescript: {all: [/`url:\$\{code\}`|['"]url:['"]\s*\+\s*code/]},
        go: {all: [/"url:"\s*\+\s*code|"url:%s"/]},
        scala: {all: [/s"url:\$\{?code\}?"|"url:"\s*\+\s*code/]},
        cpp: {all: [/"url:"\s*\+\s*code/]},
      },
    },
    {
      id: 'read-first',
      title: 'Reads the cache before the store',
      detail: 'Cache-aside means GET first and only `store.lookup` on a miss.',
      match: {
        python: {order: [/\br\.get\(/, /store\.lookup\(/]},
        typescript: {order: [/\bredis\.get\(/, /store\.lookup\(/]},
        go: {order: [/rdb\.Get\(/, /store\.Lookup\(/]},
        scala: {order: [/jedis\.get\(/, /store\.lookup\(/]},
        cpp: {order: [/redis\.get\(/, /store\.lookup\(/]},
      },
    },
    {
      id: 'ttl',
      title: 'Cached URLs expire',
      detail: 'Store the URL with an expiry (`TTL_S`, 86400 s); a cache without TTLs only grows.',
      match: {
        python: {all: [/\.set\([^\n]*ex\s*=\s*(TTL_S|86400)|\.setex\([^\n]*(TTL_S|86400)/]},
        typescript: {all: [/\.set\([^\n]*['"]EX['"]\s*,\s*(TTL_S|86400)|\.setex\([^\n]*(TTL_S|86400)/]},
        go: {all: [/rdb\.Set\([^\n]*,\s*(ttl|24\s*\*\s*time\.Hour)\s*\)/]},
        scala: {all: [/jedis\.setex\([^\n]*(TtlSeconds|86400)/]},
        cpp: {all: [/redis\.set\([^\n]*(kTtl|86400)|redis\.setex\([^\n]*(kTtl|86400)/]},
      },
    },
    {
      id: 'negative',
      title: 'Caches unknown codes briefly and answers 404',
      detail:
        'An unknown code is stored as the `MISSING` sentinel with a short TTL (60 s) and answered with `404 Not Found`; a hit on the sentinel never touches the store.',
      match: {
        python: {all: [/MISSING_TTL_S|\b60\b/, /==\s*MISSING/, /status_code\s*=\s*404|HTTP_404/]},
        typescript: {
          all: [/MISSING_TTL_S|\b60\b/, /===?\s*MISSING/, /code\(\s*404\s*\)|status\(\s*404\s*\)|statusCode:\s*404/],
        },
        go: {all: [/missingTTL|time\.Minute/, /==\s*missing/, /http\.StatusNotFound|\b404\b/]},
        scala: {all: [/MissingTtlSeconds|\b60L?\b/, /==\s*Missing/, /StatusCodes\.NotFound|\b404\b/]},
        cpp: {all: [/kMissingTtl|\b60\b/, /==\s*kMissing/, /status\s*=\s*404/]},
      },
    },
    {
      id: 'redirect',
      title: 'Answers 302 with Location and a private, no-store cache policy',
      detail:
        'The redirect is a `302` (never `301`) carrying `Location` and `Cache-Control: private, max-age=0`, so the browser comes back on every click.',
      match: {
        python: {
          all: [/status_code\s*=\s*30[27]/, /Location|RedirectResponse\(/, /private, max-age=0/],
          none: [/status_code\s*=\s*30[18]/],
        },
        typescript: {
          all: [
            /redirect\([^\n]*30[27]|code\(\s*30[27]\s*\)|status\(\s*30[27]\s*\)/,
            /Location|redirect\(/,
            /private, max-age=0/,
          ],
          none: [/redirect\([^\n]*30[18]|code\(\s*30[18]\s*\)/],
        },
        go: {
          all: [
            /http\.StatusFound|http\.StatusTemporaryRedirect|\b30[27]\b/,
            /Location|http\.Redirect\(/,
            /private, max-age=0/,
          ],
          none: [/StatusMovedPermanently|StatusPermanentRedirect|\b30[18]\b/],
        },
        scala: {
          all: [/StatusCodes\.(Found|TemporaryRedirect)|\b30[27]\b/, /Location\(|redirect\(/, /private, max-age=0/],
          none: [/MovedPermanently|PermanentRedirect|\b30[18]\b/],
        },
        cpp: {
          all: [/set_redirect\([^\n]*30[27]\s*\)|status\s*=\s*30[27]/, /Location|set_redirect\(/, /private, max-age=0/],
          none: [/\b30[18]\b/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, HTTPException
from fastapi.responses import RedirectResponse, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 86400
MISSING_TTL_S = 60
MISSING = "__missing__"


class Store:
    """Links table (provided)."""

    def lookup(self, code: str) -> str | None:
        raise NotImplementedError


store = Store()


def resolve(code: str) -> str | None:
    key = ...  # TODO: url:{code}
    # TODO: GET first; a hit returns the URL (or None when it is the MISSING sentinel)
    # TODO: miss → store.lookup(); None → SET MISSING with MISSING_TTL_S; URL → SET with TTL_S
    raise NotImplementedError


@app.get("/{code}")
def redirect(code: str) -> Response:
    url = resolve(code)
    # TODO: None → 404; otherwise 302 with Location and Cache-Control: private, max-age=0
    raise HTTPException(status_code=501)
`,
      solution: `import redis
from fastapi import FastAPI, HTTPException
from fastapi.responses import RedirectResponse, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 86400
MISSING_TTL_S = 60
MISSING = "__missing__"


class Store:
    """Links table (provided)."""

    def lookup(self, code: str) -> str | None:
        raise NotImplementedError


store = Store()


def resolve(code: str) -> str | None:
    key = f"url:{code}"
    cached = r.get(key)
    if cached is not None:
        return None if cached == MISSING else cached
    url = store.lookup(code)
    if url is None:
        r.set(key, MISSING, ex=MISSING_TTL_S)
        return None
    r.set(key, url, ex=TTL_S)
    return url


@app.get("/{code}")
def redirect(code: str) -> Response:
    url = resolve(code)
    if url is None:
        raise HTTPException(status_code=404, detail="no such link")
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "private, max-age=0"})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 86400;
export const MISSING_TTL_S = 60;
export const MISSING = '__missing__';

/** Links table (provided). */
export const store = {
  async lookup(code: string): Promise<string | null> {
    throw new Error('not implemented');
  },
};

export async function resolve(code: string): Promise<string | null> {
  const key = ''; // TODO: url:{code}
  // TODO: GET first; a hit returns the URL (or null when it is the MISSING sentinel)
  // TODO: miss → store.lookup(); null → SET MISSING with MISSING_TTL_S; URL → SET with TTL_S
  throw new Error('not implemented');
}

app.get('/:code', async (request, reply) => {
  const {code} = request.params as {code: string};
  const url = await resolve(code);
  // TODO: null → 404; otherwise 302 with Location and Cache-Control: private, max-age=0
  return reply.code(501).send();
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const TTL_S = 86400;
export const MISSING_TTL_S = 60;
export const MISSING = '__missing__';

/** Links table (provided). */
export const store = {
  async lookup(code: string): Promise<string | null> {
    throw new Error('not implemented');
  },
};

export async function resolve(code: string): Promise<string | null> {
  const key = \`url:\${code}\`;
  const cached = await redis.get(key);
  if (cached !== null) return cached === MISSING ? null : cached;
  const url = await store.lookup(code);
  if (url === null) {
    await redis.set(key, MISSING, 'EX', MISSING_TTL_S);
    return null;
  }
  await redis.set(key, url, 'EX', TTL_S);
  return url;
}

app.get('/:code', async (request, reply) => {
  const {code} = request.params as {code: string};
  const url = await resolve(code);
  if (url === null) return reply.code(404).send({error: 'no such link'});
  return reply.header('Cache-Control', 'private, max-age=0').redirect(url, 302);
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"shortener/links"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	ttl        = 24 * time.Hour
	missingTTL = time.Minute
	missing    = "__missing__"
)

// store is the links table (provided): Lookup(ctx, code) returns "", nil for an unknown code.
var store = links.Open("postgres://links")

func resolve(ctx context.Context, code string) (string, error) {
	key := "" // TODO: url:{code}
	// TODO: GET first; a hit returns the URL (or "" when it is the missing sentinel)
	// TODO: miss → store.Lookup(); "" → SET missing with missingTTL; URL → SET with ttl
	_ = key
	_ = errors.Is
	return "", errors.New("not implemented")
}

func redirect(rw http.ResponseWriter, r *http.Request) {
	target, err := resolve(r.Context(), r.PathValue("code"))
	if err != nil {
		http.Error(rw, "try again", http.StatusServiceUnavailable)
		return
	}
	// TODO: "" → 404; otherwise 302 with Location and Cache-Control: private, max-age=0
	_ = target
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{code}", redirect)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"shortener/links"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	ttl        = 24 * time.Hour
	missingTTL = time.Minute
	missing    = "__missing__"
)

// store is the links table (provided): Lookup(ctx, code) returns "", nil for an unknown code.
var store = links.Open("postgres://links")

func resolve(ctx context.Context, code string) (string, error) {
	key := "url:" + code
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		if cached == missing {
			return "", nil
		}
		return cached, nil
	}
	if !errors.Is(err, redis.Nil) {
		return "", err
	}
	target, err := store.Lookup(ctx, code)
	if err != nil {
		return "", err
	}
	if target == "" {
		rdb.Set(ctx, key, missing, missingTTL)
		return "", nil
	}
	rdb.Set(ctx, key, target, ttl)
	return target, nil
}

func redirect(rw http.ResponseWriter, r *http.Request) {
	target, err := resolve(r.Context(), r.PathValue("code"))
	if err != nil {
		http.Error(rw, "try again", http.StatusServiceUnavailable)
		return
	}
	if target == "" {
		http.Error(rw, "no such link", http.StatusNotFound)
		return
	}
	rw.Header().Set("Cache-Control", "private, max-age=0")
	http.Redirect(rw, r, target, http.StatusFound)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{code}", redirect)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.{Location, RawHeader}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import shortener.{LinkStore, Tls} // LinkStore: lookup(code): Option[String]; Tls.serverContext — provided

object Redirect {
  val jedis = new JedisPooled("redis", 6379)
  val store = LinkStore.open()

  val TtlSeconds = 86400L
  val MissingTtlSeconds = 60L
  val Missing = "__missing__"

  def resolve(code: String): Option[String] = {
    val key: String = ??? // TODO: url:{code}
    // TODO: GET first; a hit returns the URL (or None when it is the Missing sentinel)
    // TODO: miss → store.lookup(); None → SETEX Missing with MissingTtlSeconds; URL → SETEX with TtlSeconds
    None
  }

  val route: Route =
    path(Segment) { code =>
      get {
        // TODO: None → 404; otherwise 302 with Location and Cache-Control: private, max-age=0
        complete(StatusCodes.NotImplemented)
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("shortener")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.{Location, RawHeader}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import shortener.{LinkStore, Tls} // LinkStore: lookup(code): Option[String]; Tls.serverContext — provided

object Redirect {
  val jedis = new JedisPooled("redis", 6379)
  val store = LinkStore.open()

  val TtlSeconds = 86400L
  val MissingTtlSeconds = 60L
  val Missing = "__missing__"

  def resolve(code: String): Option[String] = {
    val key = s"url:$code"
    Option(jedis.get(key)) match {
      case Some(cached) => if (cached == Missing) None else Some(cached)
      case None =>
        store.lookup(code) match {
          case Some(url) =>
            jedis.setex(key, TtlSeconds, url)
            Some(url)
          case None =>
            jedis.setex(key, MissingTtlSeconds, Missing)
            None
        }
    }
  }

  val route: Route =
    path(Segment) { code =>
      get {
        resolve(code) match {
          case None => complete(StatusCodes.NotFound -> "no such link")
          case Some(url) =>
            val headers = List(Location(Uri(url)), RawHeader("Cache-Control", "private, max-age=0"))
            complete(HttpResponse(StatusCodes.Found, headers = headers))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("shortener")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "links.h"  // Store: std::optional<std::string> lookup(const std::string& code)

sw::redis::Redis redis("tcp://redis:6379");
Store store;  // the links table (provided)

constexpr std::chrono::seconds kTtl{86400};
constexpr std::chrono::seconds kMissingTtl{60};
const std::string kMissing = "__missing__";

std::optional<std::string> resolve(const std::string& code) {
  const std::string key = "";  // TODO: url:{code}
  // TODO: GET first; a hit returns the URL (or nullopt when it is the kMissing sentinel)
  // TODO: miss → store.lookup(); nullopt → SET kMissing with kMissingTtl; URL → SET with kTtl
  return std::nullopt;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto url = resolve(req.matches[1]);
    // TODO: nullopt → 404; otherwise 302 with Location and Cache-Control: private, max-age=0
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "links.h"  // Store: std::optional<std::string> lookup(const std::string& code)

sw::redis::Redis redis("tcp://redis:6379");
Store store;  // the links table (provided)

constexpr std::chrono::seconds kTtl{86400};
constexpr std::chrono::seconds kMissingTtl{60};
const std::string kMissing = "__missing__";

std::optional<std::string> resolve(const std::string& code) {
  const std::string key = "url:" + code;
  if (const auto cached = redis.get(key)) {
    if (*cached == kMissing) return std::nullopt;
    return cached;
  }
  const auto url = store.lookup(code);
  if (!url) {
    redis.set(key, kMissing, kMissingTtl);
    return std::nullopt;
  }
  redis.set(key, *url, kTtl);
  return url;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Get(R"(/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto url = resolve(req.matches[1]);
    if (!url) {
      res.status = 404;
      res.set_content("no such link", "text/plain");
      return;
    }
    res.set_header("Cache-Control", "private, max-age=0");
    res.set_redirect(*url, 302);
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `URL = "https://example.com/launch"


class FakeStore:
    """The links table: knows g9Xc, records every lookup."""

    def __init__(self):
        self.links = {"g9Xc": URL}
        self.lookups = []

    def lookup(self, code):
        self.lookups.append(code)
        return self.links.get(code)


def _redirect(ctx):
    m = ctx.load("redirect")
    m.store = FakeStore()
    return m


def check_key(ctx):
    m = _redirect(ctx)
    assert m.resolve("g9Xc") == URL, "resolve must return the long url the store knows"
    assert ctx.redis.get("url:g9Xc") == URL, f"after a miss the url must be cached under url:g9Xc, keys are {ctx.redis.keys()}"
    ctx.redis.set("url:abcd", "https://example.com/cached")
    assert m.resolve("abcd") == "https://example.com/cached", "a value cached under url:{code} must be returned as the long url"


def check_read_first(ctx):
    m = _redirect(ctx)
    ctx.redis.set("url:g9Xc", URL)
    assert m.resolve("g9Xc") == URL
    assert m.store.lookups == [], f"a cache hit is the whole request: the store was asked for {m.store.lookups}"
    m.store.links["zz12"] = "https://example.com/z"
    assert m.resolve("zz12") == "https://example.com/z", "a miss must fall through to the store"
    assert m.store.lookups == ["zz12"], f"the store must be asked once on a miss, lookups: {m.store.lookups}"
    assert m.resolve("zz12") == "https://example.com/z"
    assert m.store.lookups == ["zz12"], "the second resolve must be served from the cache, not the store again"


def check_ttl(ctx):
    m = _redirect(ctx)
    m.resolve("g9Xc")
    ttl = ctx.redis.ttl("url:g9Xc")
    assert ttl > 0, "url:g9Xc was cached without an expiry (TTL -1): the cache would only grow"
    assert 86000 <= ttl <= 86400, f"url:g9Xc expires in {ttl} s, expected 86400"
    ctx.clock.advance(86401)
    assert ctx.redis.get("url:g9Xc") is None
    assert m.resolve("g9Xc") == URL
    assert m.store.lookups == ["g9Xc", "g9Xc"], "once the entry has expired the next resolve goes back to the store"


async def check_negative(ctx):
    m = _redirect(ctx)
    assert m.resolve("ghost") is None, "an unknown code resolves to nothing"
    assert m.store.lookups == ["ghost"]
    sentinel = ctx.redis.get("url:ghost")
    assert sentinel is not None, "an unknown code must be cached as the MISSING sentinel"
    assert sentinel == m.MISSING, f"url:ghost holds {sentinel!r}, expected the MISSING sentinel"
    ttl = ctx.redis.ttl("url:ghost")
    assert 1 <= ttl <= 60, f"the sentinel expires in {ttl} s, expected 60"
    assert m.resolve("ghost") is None
    assert m.store.lookups == ["ghost"], "a hit on the sentinel must not touch the store"
    async with ctx.client(m.app) as c:
        r = await c.get("/ghost")
    assert r.status_code == 404, f"GET /ghost answered {r.status_code}, expected 404"
    assert m.store.lookups == ["ghost"], "the 404 is answered from the sentinel, not from a store lookup"
    ctx.clock.advance(61)
    assert m.resolve("ghost") is None
    assert m.store.lookups == ["ghost", "ghost"], "after 60 s the sentinel is gone and the store is asked again"


async def check_redirect(ctx):
    m = _redirect(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get("/g9Xc")
    assert r.status_code not in (301, 308), f"GET /g9Xc answered {r.status_code}: a permanent redirect is cached by the browser and later clicks never come back"
    assert r.status_code in (302, 307), f"GET /g9Xc answered {r.status_code}, expected 302"
    assert r.headers.get("location") == URL, f"Location is {r.headers.get('location')!r}, expected the long url"
    cache_control = r.headers.get("cache-control", "")
    assert "private" in cache_control and "max-age=0" in cache_control, f"Cache-Control is {cache_control!r}, expected 'private, max-age=0'"
`,
    typescript: `const URL_ = 'https://example.com/launch';

/** The links table: knows g9Xc, records every lookup. Swapped onto the learner's provided store object. */
function redirect(ctx) {
  const m = ctx.load('redirect');
  const links: Record<string, string> = {g9Xc: URL_};
  const lookups: string[] = [];
  m.store.lookup = async (code: string) => {
    lookups.push(code);
    return links[code] ?? null;
  };
  return {m, links, lookups};
}

export async function check_key(ctx) {
  const {m} = redirect(ctx);
  assert.equal(await m.resolve('g9Xc'), URL_, 'resolve must return the long url the store knows');
  assert.equal(ctx.redis.get('url:g9Xc'), URL_, \`after a miss the url must be cached under url:g9Xc, keys are \${JSON.stringify(ctx.redis.keys('*'))}\`);
  ctx.redis.set('url:abcd', 'https://example.com/cached');
  assert.equal(await m.resolve('abcd'), 'https://example.com/cached', 'a value cached under url:{code} must be returned as the long url');
}

export async function check_read_first(ctx) {
  const {m, links, lookups} = redirect(ctx);
  ctx.redis.set('url:g9Xc', URL_);
  assert.equal(await m.resolve('g9Xc'), URL_);
  assert.deepEqual(lookups, [], \`a cache hit is the whole request: the store was asked for \${JSON.stringify(lookups)}\`);
  links.zz12 = 'https://example.com/z';
  assert.equal(await m.resolve('zz12'), 'https://example.com/z', 'a miss must fall through to the store');
  assert.deepEqual(lookups, ['zz12'], \`the store must be asked once on a miss, lookups: \${JSON.stringify(lookups)}\`);
  assert.equal(await m.resolve('zz12'), 'https://example.com/z');
  assert.deepEqual(lookups, ['zz12'], 'the second resolve must be served from the cache, not the store again');
}

export async function check_ttl(ctx) {
  const {m, lookups} = redirect(ctx);
  await m.resolve('g9Xc');
  const ttl = ctx.redis.ttl('url:g9Xc');
  assert(ttl > 0, 'url:g9Xc was cached without an expiry (TTL -1): the cache would only grow');
  assert(86000 <= ttl && ttl <= 86400, \`url:g9Xc expires in \${ttl} s, expected 86400\`);
  ctx.clock.advance(86401);
  assert.equal(ctx.redis.get('url:g9Xc'), null);
  assert.equal(await m.resolve('g9Xc'), URL_);
  assert.deepEqual(lookups, ['g9Xc', 'g9Xc'], 'once the entry has expired the next resolve goes back to the store');
}

export async function check_negative(ctx) {
  const {m, lookups} = redirect(ctx);
  assert.equal(await m.resolve('ghost'), null, 'an unknown code resolves to nothing');
  assert.deepEqual(lookups, ['ghost']);
  const sentinel = ctx.redis.get('url:ghost');
  assert(sentinel !== null, 'an unknown code must be cached as the MISSING sentinel');
  assert.equal(sentinel, m.MISSING, \`url:ghost holds \${JSON.stringify(sentinel)}, expected the MISSING sentinel\`);
  const ttl = ctx.redis.ttl('url:ghost');
  assert(1 <= ttl && ttl <= 60, \`the sentinel expires in \${ttl} s, expected 60\`);
  assert.equal(await m.resolve('ghost'), null);
  assert.deepEqual(lookups, ['ghost'], 'a hit on the sentinel must not touch the store');
  const r = await ctx.client(m.app).get('/ghost');
  assert.equal(r.status, 404, \`GET /ghost answered \${r.status}, expected 404\`);
  assert.deepEqual(lookups, ['ghost'], 'the 404 is answered from the sentinel, not from a store lookup');
  ctx.clock.advance(61);
  assert.equal(await m.resolve('ghost'), null);
  assert.deepEqual(lookups, ['ghost', 'ghost'], 'after 60 s the sentinel is gone and the store is asked again');
}

export async function check_redirect(ctx) {
  const {m} = redirect(ctx);
  const r = await ctx.client(m.app).get('/g9Xc');
  assert(![301, 308].includes(r.status), \`GET /g9Xc answered \${r.status}: a permanent redirect is cached by the browser and later clicks never come back\`);
  assert([302, 307].includes(r.status), \`GET /g9Xc answered \${r.status}, expected 302\`);
  assert.equal(r.headers['location'], URL_, \`Location is \${JSON.stringify(r.headers['location'])}, expected the long url\`);
  const cacheControl = r.headers['cache-control'] ?? '';
  assert(cacheControl.includes('private') && cacheControl.includes('max-age=0'), \`Cache-Control is \${JSON.stringify(cacheControl)}, expected 'private, max-age=0'\`);
}
`,
    go: `package main

import (
	"context"
	"strings"

	"leetbuild/harness"
)

const longURL = "https://example.com/launch"

// fakeLinks is the links table: knows g9Xc, records every lookup. Assigned to the learner's store.
type fakeLinks struct {
	urls    map[string]string
	lookups []string
}

func (f *fakeLinks) Exists(_ context.Context, code string) (bool, error) {
	_, ok := f.urls[code]
	return ok, nil
}

func (f *fakeLinks) Save(_ context.Context, code, url string) error {
	f.urls[code] = url
	return nil
}

func (f *fakeLinks) Lookup(_ context.Context, code string) (string, error) {
	f.lookups = append(f.lookups, code)
	return f.urls[code], nil
}

func standInLinks() *fakeLinks {
	f := &fakeLinks{urls: map[string]string{"g9Xc": longURL}}
	store = f
	return f
}

// resolveOK is resolve(code); an error fails the check.
func resolveOK(ctx *harness.Ctx, code string) string {
	target, err := resolve(context.Background(), code)
	ctx.NoError(err, "resolve(ctx, %q)", code)
	return target
}

func CheckKey(ctx *harness.Ctx) {
	standInLinks()
	ctx.Equal(resolveOK(ctx, "g9Xc"), longURL, "resolve must return the long url the store knows")
	cached, _ := ctx.Redis.Get("url:g9Xc")
	ctx.Equal(cached, longURL, "after a miss the url must be cached under url:g9Xc (keys are %q)", ctx.Redis.Keys("*"))
	ctx.Redis.Set("url:abcd", "https://example.com/cached")
	ctx.Equal(resolveOK(ctx, "abcd"), "https://example.com/cached", "a value cached under url:{code} must be returned as the long url")
}

func CheckReadFirst(ctx *harness.Ctx) {
	links := standInLinks()
	ctx.Redis.Set("url:g9Xc", longURL)
	ctx.Equal(resolveOK(ctx, "g9Xc"), longURL, "resolve of a cached code")
	ctx.Equal(links.lookups, []string(nil), "a cache hit is the whole request: the store was asked")
	links.urls["zz12"] = "https://example.com/z"
	ctx.Equal(resolveOK(ctx, "zz12"), "https://example.com/z", "a miss must fall through to the store")
	ctx.Equal(links.lookups, []string{"zz12"}, "the store must be asked once on a miss")
	ctx.Equal(resolveOK(ctx, "zz12"), "https://example.com/z", "resolve of a code cached by the previous miss")
	ctx.Equal(links.lookups, []string{"zz12"}, "the second resolve must be served from the cache, not the store again")
}

func CheckTtl(ctx *harness.Ctx) {
	links := standInLinks()
	resolveOK(ctx, "g9Xc")
	ttl := ctx.Redis.TTL("url:g9Xc")
	ctx.Assert(ttl > 0, "url:g9Xc was cached without an expiry (TTL %d): the cache would only grow", ttl)
	ctx.Assert(86000 <= ttl && ttl <= 86400, "url:g9Xc expires in %d s, expected 86400", ttl)
	ctx.Clock.Advance(86401)
	_, ok := ctx.Redis.Get("url:g9Xc")
	ctx.Assert(!ok, "url:g9Xc must be gone once its TTL has passed")
	ctx.Equal(resolveOK(ctx, "g9Xc"), longURL, "resolve after the entry expired")
	ctx.Equal(links.lookups, []string{"g9Xc", "g9Xc"}, "once the entry has expired the next resolve goes back to the store")
}

func CheckNegative(ctx *harness.Ctx) {
	links := standInLinks()
	ctx.Equal(resolveOK(ctx, "ghost"), "", "an unknown code resolves to nothing")
	ctx.Equal(links.lookups, []string{"ghost"}, "the store lookups")
	sentinel, ok := ctx.Redis.Get("url:ghost")
	ctx.Assert(ok, "an unknown code must be cached as the missing sentinel")
	ctx.Equal(sentinel, missing, "url:ghost must hold the missing sentinel")
	ttl := ctx.Redis.TTL("url:ghost")
	ctx.Assert(1 <= ttl && ttl <= 60, "the sentinel expires in %d s, expected 60", ttl)
	ctx.Equal(resolveOK(ctx, "ghost"), "", "an unknown code resolves to nothing")
	ctx.Equal(links.lookups, []string{"ghost"}, "a hit on the sentinel must not touch the store")
	r := ctx.Main(main).HTTP().Get("/ghost")
	ctx.Equal(r.Status, 404, "GET /ghost")
	ctx.Equal(links.lookups, []string{"ghost"}, "the 404 is answered from the sentinel, not from a store lookup")
	ctx.Clock.Advance(61)
	ctx.Equal(resolveOK(ctx, "ghost"), "", "an unknown code resolves to nothing")
	ctx.Equal(links.lookups, []string{"ghost", "ghost"}, "after 60 s the sentinel is gone and the store is asked again")
}

func CheckRedirect(ctx *harness.Ctx) {
	standInLinks()
	r := ctx.Main(main).HTTP().Get("/g9Xc")
	ctx.Assert(r.Status != 301 && r.Status != 308, "GET /g9Xc answered %d: a permanent redirect is cached by the browser and later clicks never come back", r.Status)
	ctx.Assert(r.Status == 302 || r.Status == 307, "GET /g9Xc answered %d, expected 302", r.Status)
	ctx.Equal(r.Header.Get("Location"), longURL, "Location must be the long url")
	cacheControl := r.Header.Get("Cache-Control")
	ctx.Assert(strings.Contains(cacheControl, "private") && strings.Contains(cacheControl, "max-age=0"), "Cache-Control is %q, expected %q", cacheControl, "private, max-age=0")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string longURL = "https://example.com/launch";

// fakeLinks is the links table: knows g9Xc, records every lookup. It takes the place of
// links::table, which every Store goes through (Go assigns it to the learner's store).
class fakeLinks : public links::Table {
 public:
  std::map<std::string, std::string> urls{{"g9Xc", longURL}};
  std::vector<std::string> lookups;

  bool exists(const std::string& code) override { return urls.count(code) > 0; }

  void save(const std::string& code, const std::string& url) override { urls[code] = url; }

  std::optional<std::string> lookup(const std::string& code) override {
    lookups.push_back(code);
    const auto it = urls.find(code);
    if (it == urls.end()) return std::nullopt;
    return it->second;
  }
};

fakeLinks& standInLinks() {
  auto* f = new fakeLinks();  // lives for the check: the program's threads may still use it
  links::table = f;
  return *f;
}

// resolveOK is resolve(code), "" for no link (Go's resolve returns ""); an exception fails the check.
std::string resolveOK(harness::Ctx& ctx, const std::string& code) {
  try {
    return resolve(code).value_or("");
  } catch (const std::exception& e) {
    ctx.Fatalf("resolve(%q): %s", code, e.what());
  }
}

}  // namespace

void CheckKey(harness::Ctx& ctx) {
  standInLinks();
  ctx.Equal(resolveOK(ctx, "g9Xc"), longURL, "resolve must return the long url the store knows");
  const std::string cached = ctx.Redis.Get("url:g9Xc").value_or("");
  ctx.Equal(cached, longURL, "after a miss the url must be cached under url:g9Xc (keys are %q)", ctx.Redis.Keys("*"));
  ctx.Redis.Set("url:abcd", "https://example.com/cached");
  ctx.Equal(resolveOK(ctx, "abcd"), "https://example.com/cached", "a value cached under url:{code} must be returned as the long url");
}

void CheckReadFirst(harness::Ctx& ctx) {
  fakeLinks& links = standInLinks();
  ctx.Redis.Set("url:g9Xc", longURL);
  ctx.Equal(resolveOK(ctx, "g9Xc"), longURL, "resolve of a cached code");
  ctx.Equal(links.lookups, std::vector<std::string>{}, "a cache hit is the whole request: the store was asked");
  links.urls["zz12"] = "https://example.com/z";
  ctx.Equal(resolveOK(ctx, "zz12"), "https://example.com/z", "a miss must fall through to the store");
  ctx.Equal(links.lookups, std::vector<std::string>{"zz12"}, "the store must be asked once on a miss");
  ctx.Equal(resolveOK(ctx, "zz12"), "https://example.com/z", "resolve of a code cached by the previous miss");
  ctx.Equal(links.lookups, std::vector<std::string>{"zz12"}, "the second resolve must be served from the cache, not the store again");
}

void CheckTtl(harness::Ctx& ctx) {
  fakeLinks& links = standInLinks();
  resolveOK(ctx, "g9Xc");
  const long long ttl = ctx.Redis.TTL("url:g9Xc");
  ctx.Assert(ttl > 0, "url:g9Xc was cached without an expiry (TTL %d): the cache would only grow", ttl);
  ctx.Assert(86000 <= ttl && ttl <= 86400, "url:g9Xc expires in %d s, expected 86400", ttl);
  ctx.Clock.Advance(86401);
  ctx.Assert(!ctx.Redis.Get("url:g9Xc").has_value(), "url:g9Xc must be gone once its TTL has passed");
  ctx.Equal(resolveOK(ctx, "g9Xc"), longURL, "resolve after the entry expired");
  ctx.Equal(links.lookups, std::vector<std::string>{"g9Xc", "g9Xc"}, "once the entry has expired the next resolve goes back to the store");
}

void CheckNegative(harness::Ctx& ctx) {
  fakeLinks& links = standInLinks();
  ctx.Equal(resolveOK(ctx, "ghost"), "", "an unknown code resolves to nothing");
  ctx.Equal(links.lookups, std::vector<std::string>{"ghost"}, "the store lookups");
  const auto sentinel = ctx.Redis.Get("url:ghost");
  ctx.Assert(sentinel.has_value(), "an unknown code must be cached as the missing sentinel");
  ctx.Equal(*sentinel, kMissing, "url:ghost must hold the missing sentinel");
  const long long ttl = ctx.Redis.TTL("url:ghost");
  ctx.Assert(1 <= ttl && ttl <= 60, "the sentinel expires in %d s, expected 60", ttl);
  ctx.Equal(resolveOK(ctx, "ghost"), "", "an unknown code resolves to nothing");
  ctx.Equal(links.lookups, std::vector<std::string>{"ghost"}, "a hit on the sentinel must not touch the store");
  const auto r = ctx.Main().HTTP().Get("/ghost");
  ctx.Equal(r.Status, 404, "GET /ghost");
  ctx.Equal(links.lookups, std::vector<std::string>{"ghost"}, "the 404 is answered from the sentinel, not from a store lookup");
  ctx.Clock.Advance(61);
  ctx.Equal(resolveOK(ctx, "ghost"), "", "an unknown code resolves to nothing");
  ctx.Equal(links.lookups, std::vector<std::string>{"ghost", "ghost"}, "after 60 s the sentinel is gone and the store is asked again");
}

void CheckRedirect(harness::Ctx& ctx) {
  standInLinks();
  const auto r = ctx.Main().HTTP().Get("/g9Xc");
  ctx.Assert(r.Status != 301 && r.Status != 308, "GET /g9Xc answered %d: a permanent redirect is cached by the browser and later clicks never come back", r.Status);
  ctx.Assert(r.Status == 302 || r.Status == 307, "GET /g9Xc answered %d, expected 302", r.Status);
  ctx.Equal(r.HeaderValue("Location"), longURL, "Location must be the long url");
  const std::string cacheControl = r.HeaderValue("Cache-Control");
  ctx.Assert(cacheControl.find("private") != std::string::npos && cacheControl.find("max-age=0") != std::string::npos,
             "Cache-Control is %q, expected %q", cacheControl, "private, max-age=0");
}
`,
  },
  debrief: `The redirect is the hot path of a shortener — reads outnumber writes by a hundred to one — so it is shaped to be one Redis round trip and nothing else. Negative caching matters more here than in most caches: unknown codes are *the* abuse pattern (scanners walking the key space), and each one would otherwise be a database query. The 302 is deliberate: a 301 would be cached by the browser forever and the next step would never see the click. Real shorteners add a local in-process cache in front of Redis for the top links, and jitter the TTL so a popular link's entry does not expire on every replica at once.`,
};
