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
  debrief: `The redirect is the hot path of a shortener — reads outnumber writes by a hundred to one — so it is shaped to be one Redis round trip and nothing else. Negative caching matters more here than in most caches: unknown codes are *the* abuse pattern (scanners walking the key space), and each one would otherwise be a database query. The 302 is deliberate: a 301 would be cached by the browser forever and the next step would never see the click. Real shorteners add a local in-process cache in front of Redis for the top links, and jitter the TTL so a popular link's entry does not expire on every replica at once.`,
};
