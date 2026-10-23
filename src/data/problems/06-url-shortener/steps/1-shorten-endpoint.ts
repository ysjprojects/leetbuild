import type {Step} from '@/lib/types';

export const shortenEndpointStep: Step = {
  id: 'shorten-endpoint',
  title: 'POST /shorten: validate, alias, create',
  concept: 'http',
  file: 'shorten_api',
  focus: ['client', 'api', 'db'],
  task: `## Task

Implement \`POST /shorten\` with body \`{"url": "…", "alias": "…"}\` (\`alias\` optional). The links table
is provided as \`store\` — \`store.exists(code)\` and \`store.save(code, url)\` — and so is \`next_code()\`
(you build it in step 2).

- The URL must parse with scheme **http** or **https** and be at most **2048** characters;
  anything else is a **400**.
- A custom alias must match \`^[A-Za-z0-9_-]{4,32}$\` (**400**) and must not already exist
  (**409** — the client asked for a name somebody else has, not a server problem).
- Without an alias, take a code from \`next_code()\`.
- Save the pair, answer **201** with \`{"code": …, "short_url": …}\` and a \`Location\` header pointing at
  the short URL — 201 says "created", and \`Location\` says where.

:::widget status-codes {}

> Cheap checks first: a malformed URL costs nothing, an alias collision costs a lookup, a fresh code
> may cost a gRPC call. Every rejection returns before the next, more expensive step.

:::widget http-lifecycle {}`,
  sequence: {
    participants: ['Client', 'sho.rt', 'links'],
    messages: [
      {from: 'Client', to: 'sho.rt', label: 'POST /shorten {url, alias: "launch"}', kind: 'sync'},
      {from: 'sho.rt', to: 'sho.rt', label: 'validate url · alias format', kind: 'sync'},
      {from: 'sho.rt', to: 'links', label: 'exists("launch")', kind: 'sync'},
      {from: 'links', to: 'sho.rt', label: 'false', kind: 'reply'},
      {from: 'sho.rt', to: 'links', label: 'save("launch", url)', kind: 'sync'},
      {from: 'sho.rt', to: 'Client', label: '201 {code, short_url} · Location', kind: 'reply'},
    ],
  },
  hints: [
    'Parse the URL with the standard library and inspect the scheme and host; do not write your own regex for URLs. The length check is a plain comparison against the constant.',
    'Two different 4xx codes for the alias: 400 when the *format* is wrong (the client can never succeed with that string), 409 when the *name is taken* (the client can succeed with another one).',
    'Decide the code first — the alias or `next_code()` — then one `store.save(code, url)`, then build `short_url` from `BASE_URL` and use it for both the body and the `Location` header.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /shorten',
      detail: 'A handler must be registered for `POST` on the `/shorten` path.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/shorten["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/shorten['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/shorten"/]},
        scala: {all: [/path\(\s*"shorten"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/shorten"/]},
      },
    },
    {
      id: 'validate-url',
      title: 'Rejects non-http(s) or over-long URLs with 400',
      detail:
        'Parse the URL, accept only the `http` and `https` schemes, and cap the length at `MAX_URL_LEN`; answer `400 Bad Request` otherwise.',
      match: {
        python: {all: [/urlparse\(|urlsplit\(/, /\.scheme/, /MAX_URL_LEN|\b2048\b/, /status_code\s*=\s*400|HTTP_400/]},
        typescript: {
          all: [
            /new URL\(/,
            /\.protocol/,
            /MAX_URL_LEN|\b2048\b/,
            /code\(\s*400\s*\)|status\(\s*400\s*\)|statusCode:\s*400/,
          ],
        },
        go: {all: [/url\.Parse(RequestURI)?\(/, /\.Scheme/, /maxURLLen|\b2048\b/, /http\.StatusBadRequest|\b400\b/]},
        scala: {
          all: [/new URI\(|Uri\(/, /getScheme|\.scheme/, /MaxUrlLen|\b2048\b/, /StatusCodes\.BadRequest|\b400\b/],
        },
        cpp: {all: [/"https:\/\/"|https\?:/, /"http:\/\/"|https\?:/, /kMaxUrlLen|\b2048\b/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'alias-format',
      title: 'Rejects a malformed alias with 400',
      detail: 'A custom alias must match the provided `ALIAS_RE` (`^[A-Za-z0-9_-]{4,32}$`); otherwise `400`.',
      match: {
        python: {all: [/ALIAS_RE\.(fullmatch|match)\(/, /status_code\s*=\s*400|HTTP_400/]},
        typescript: {all: [/ALIAS_RE\.test\(/, /code\(\s*400\s*\)|status\(\s*400\s*\)|statusCode:\s*400/]},
        go: {all: [/aliasRe\.MatchString\(/, /http\.StatusBadRequest|\b400\b/]},
        scala: {
          all: [/AliasRe\.(matches|findFirstIn|unapplySeq)\(|matches\(\s*AliasRe/, /StatusCodes\.BadRequest|\b400\b/],
        },
        cpp: {all: [/std::regex_match\([^\n]*kAliasRe/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'alias-taken',
      title: 'Answers 409 when the alias already exists',
      detail:
        'Ask the store whether the alias is taken (`store.exists`) and answer `409 Conflict`: the request was well-formed, the name is just not free.',
      match: {
        python: {all: [/store\.exists\(/, /status_code\s*=\s*409/]},
        typescript: {all: [/store\.exists\(/, /code\(\s*409\s*\)|status\(\s*409\s*\)|statusCode:\s*409/]},
        go: {all: [/store\.Exists\(/, /http\.StatusConflict|\b409\b/]},
        scala: {all: [/store\.exists\(/, /StatusCodes\.Conflict|\b409\b/]},
        cpp: {all: [/store\.exists\(/, /status\s*=\s*409/]},
      },
    },
    {
      id: 'created',
      title: 'Saves the link and answers 201 with Location',
      detail:
        'Without an alias the code comes from `next_code()`; the pair is saved with `store.save`, then `201 Created` carries `{code, short_url}` and a `Location` header.',
      match: {
        python: {
          all: [/(?<!def )next_code\(\)/, /Location/, /short_url/],
          order: [/store\.save\(/, /status_code\s*=\s*201/],
        },
        typescript: {
          all: [/keys\.nextCode\(\)/, /Location/, /short_url/],
          order: [/store\.save\(/, /code\(\s*201\s*\)|status\(\s*201\s*\)/],
        },
        go: {
          all: [/(?<!func )nextCode\(/, /Location/, /short_url/],
          order: [/store\.Save\(/, /http\.StatusCreated|\b201\b/],
        },
        scala: {
          all: [/(?<!def )nextCode\(\)/, /Location/, /short_url/],
          order: [/store\.save\(/, /StatusCodes\.Created|\b201\b/],
        },
        cpp: {
          all: [/(?<!string )next_code\(\)/, /Location/, /short_url/],
          order: [/store\.save\(/, /status\s*=\s*201/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import re
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

BASE_URL = "https://sho.rt/"
MAX_URL_LEN = 2048
ALIAS_RE = re.compile(r"^[A-Za-z0-9_-]{4,32}$")


class Store:
    """Links table (provided)."""

    def exists(self, code: str) -> bool:
        raise NotImplementedError

    def save(self, code: str, url: str) -> None:
        raise NotImplementedError


store = Store()


def next_code() -> str:
    """A fresh short code from the key service (built in step 2)."""
    raise NotImplementedError


class ShortenRequest(BaseModel):
    url: str = ""
    alias: str | None = None


@app.post("/shorten")
def shorten(body: ShortenRequest) -> JSONResponse:
    # TODO: 400 unless the url parses with scheme http/https and len <= MAX_URL_LEN
    # TODO: alias given → 400 unless ALIAS_RE matches; 409 when store.exists(alias)
    # TODO: no alias → next_code()
    # TODO: store.save(code, url); 201 {code, short_url} with a Location header
    raise HTTPException(status_code=501)


# uvicorn shorten_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import re
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

BASE_URL = "https://sho.rt/"
MAX_URL_LEN = 2048
ALIAS_RE = re.compile(r"^[A-Za-z0-9_-]{4,32}$")


class Store:
    """Links table (provided)."""

    def exists(self, code: str) -> bool:
        raise NotImplementedError

    def save(self, code: str, url: str) -> None:
        raise NotImplementedError


store = Store()


def next_code() -> str:
    """A fresh short code from the key service (built in step 2)."""
    raise NotImplementedError


class ShortenRequest(BaseModel):
    url: str = ""
    alias: str | None = None


@app.post("/shorten")
def shorten(body: ShortenRequest) -> JSONResponse:
    parsed = urlparse(body.url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or len(body.url) > MAX_URL_LEN:
        raise HTTPException(status_code=400, detail="url must be http(s) and at most 2048 characters")
    if body.alias is not None:
        if not ALIAS_RE.fullmatch(body.alias):
            raise HTTPException(status_code=400, detail="alias must match [A-Za-z0-9_-]{4,32}")
        if store.exists(body.alias):
            raise HTTPException(status_code=409, detail="alias already taken")
        code = body.alias
    else:
        code = next_code()
    store.save(code, body.url)
    short_url = BASE_URL + code
    return JSONResponse({"code": code, "short_url": short_url}, status_code=201, headers={"Location": short_url})


# uvicorn shorten_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

export const app = Fastify();

export const BASE_URL = 'https://sho.rt/';
export const MAX_URL_LEN = 2048;
export const ALIAS_RE = /^[A-Za-z0-9_-]{4,32}$/;

/** Links table (provided). */
export const store = {
  async exists(code: string): Promise<boolean> {
    throw new Error('not implemented');
  },
  async save(code: string, url: string): Promise<void> {
    throw new Error('not implemented');
  },
};

/** The key service client (provided; you build it in step 2). */
export const keys = {
  async nextCode(): Promise<string> {
    throw new Error('not implemented');
  },
};

interface ShortenRequest {
  url?: string;
  alias?: string | null;
}

app.post('/shorten', async (request, reply) => {
  const body = (request.body ?? {}) as ShortenRequest;
  const url = body.url ?? '';
  // TODO: 400 unless the url parses (new URL) with protocol http:/https: and url.length <= MAX_URL_LEN
  // TODO: alias given → 400 unless ALIAS_RE matches; 409 when store.exists(alias)
  // TODO: no alias → keys.nextCode()
  // TODO: store.save(code, url); 201 {code, short_url} with a Location header
  return reply.code(501).send({error: 'not implemented', url});
});

// node --env-file .env dist/shorten_api.js  (TLS terminates at the edge proxy on :8443)
`,
      solution: `import Fastify from 'fastify';

export const app = Fastify();

export const BASE_URL = 'https://sho.rt/';
export const MAX_URL_LEN = 2048;
export const ALIAS_RE = /^[A-Za-z0-9_-]{4,32}$/;

/** Links table (provided). */
export const store = {
  async exists(code: string): Promise<boolean> {
    throw new Error('not implemented');
  },
  async save(code: string, url: string): Promise<void> {
    throw new Error('not implemented');
  },
};

/** The key service client (provided; you build it in step 2). */
export const keys = {
  async nextCode(): Promise<string> {
    throw new Error('not implemented');
  },
};

interface ShortenRequest {
  url?: string;
  alias?: string | null;
}

function validUrl(url: string): boolean {
  if (url.length > MAX_URL_LEN) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== '';
  } catch {
    return false;
  }
}

app.post('/shorten', async (request, reply) => {
  const body = (request.body ?? {}) as ShortenRequest;
  const url = body.url ?? '';
  if (!validUrl(url)) return reply.code(400).send({error: 'url must be http(s) and at most 2048 characters'});
  let code: string;
  if (body.alias !== undefined && body.alias !== null) {
    if (!ALIAS_RE.test(body.alias)) return reply.code(400).send({error: 'alias must match [A-Za-z0-9_-]{4,32}'});
    if (await store.exists(body.alias)) return reply.code(409).send({error: 'alias already taken'});
    code = body.alias;
  } else {
    code = await keys.nextCode();
  }
  await store.save(code, url);
  const shortUrl = BASE_URL + code;
  return reply.code(201).header('Location', shortUrl).send({code, short_url: shortUrl});
});

// node --env-file .env dist/shorten_api.js  (TLS terminates at the edge proxy on :8443)
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"regexp"

	"shortener/links"
)

const (
	baseURL   = "https://sho.rt/"
	maxURLLen = 2048
)

var aliasRe = regexp.MustCompile(\`^[A-Za-z0-9_-]{4,32}$\`)

// store is the links table (provided): Exists(ctx, code) (bool, error) · Save(ctx, code, url) error.
var store = links.Open("postgres://links")

// nextCode returns a fresh short code from the key service (built in step 2).
var nextCode = func(ctx context.Context) (string, error) { panic("not implemented") }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func shorten(rw http.ResponseWriter, r *http.Request) {
	var req struct {
		URL   string \`json:"url"\`
		Alias string \`json:"alias"\`
	}
	err := json.NewDecoder(r.Body).Decode(&req)
	// TODO: 400 unless err == nil, url.Parse succeeds with Scheme http/https and len <= maxURLLen
	// TODO: Alias given → 400 unless aliasRe matches; 409 when store.Exists
	// TODO: no alias → nextCode(ctx)
	// TODO: store.Save(ctx, code, url); 201 {code, short_url} with a Location header
	_ = err
	_ = url.Parse
	_ = aliasRe.MatchString
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /shorten", shorten)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"regexp"

	"shortener/links"
)

const (
	baseURL   = "https://sho.rt/"
	maxURLLen = 2048
)

var aliasRe = regexp.MustCompile(\`^[A-Za-z0-9_-]{4,32}$\`)

// store is the links table (provided): Exists(ctx, code) (bool, error) · Save(ctx, code, url) error.
var store = links.Open("postgres://links")

// nextCode returns a fresh short code from the key service (built in step 2).
var nextCode = func(ctx context.Context) (string, error) { panic("not implemented") }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func shorten(rw http.ResponseWriter, r *http.Request) {
	var req struct {
		URL   string \`json:"url"\`
		Alias string \`json:"alias"\`
	}
	err := json.NewDecoder(r.Body).Decode(&req)
	u, perr := url.Parse(req.URL)
	if err != nil || perr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(req.URL) > maxURLLen {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "url must be http(s) and at most 2048 characters"})
		return
	}
	ctx := r.Context()
	code := req.Alias
	if code != "" {
		if !aliasRe.MatchString(code) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "alias must match [A-Za-z0-9_-]{4,32}"})
			return
		}
		taken, err := store.Exists(ctx, code)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		if taken {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": "alias already taken"})
			return
		}
	} else if code, err = nextCode(ctx); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := store.Save(ctx, code, req.URL); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	short := baseURL + code
	rw.Header().Set("Location", short)
	writeJSON(rw, http.StatusCreated, map[string]string{"code": code, "short_url": short})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /shorten", shorten)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.net.URI

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.Location
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import shortener.{LinkStore, Tls} // LinkStore: exists(code): Boolean · save(code, url): Unit; Tls.serverContext — provided
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ShortenRequest(url: String, alias: Option[String])

object ShortenApi {
  val BaseUrl = "https://sho.rt/"
  val MaxUrlLen = 2048
  val AliasRe = "^[A-Za-z0-9_-]{4,32}$".r
  val store = LinkStore.open()

  implicit val shortenFormat: RootJsonFormat[ShortenRequest] = jsonFormat2(ShortenRequest)

  /** A fresh short code from the key service (built in step 2). */
  def nextCode(): String = ???

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("shorten") {
      post {
        entity(as[ShortenRequest]) { req =>
          // TODO: 400 unless the url parses (new URI) with scheme http/https and length <= MaxUrlLen
          // TODO: alias given → 400 unless AliasRe matches; 409 when store.exists(alias)
          // TODO: no alias → nextCode()
          // TODO: store.save(code, url); 201 {code, short_url} with a Location header
          json(StatusCodes.NotImplemented, """{"error":"not implemented"}""")
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
      solution: `import java.net.URI

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.Location
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import shortener.{LinkStore, Tls} // LinkStore: exists(code): Boolean · save(code, url): Unit; Tls.serverContext — provided
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ShortenRequest(url: String, alias: Option[String])

object ShortenApi {
  val BaseUrl = "https://sho.rt/"
  val MaxUrlLen = 2048
  val AliasRe = "^[A-Za-z0-9_-]{4,32}$".r
  val store = LinkStore.open()

  implicit val shortenFormat: RootJsonFormat[ShortenRequest] = jsonFormat2(ShortenRequest)

  /** A fresh short code from the key service (built in step 2). */
  def nextCode(): String = ???

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  private def validUrl(url: String): Boolean =
    url.length <= MaxUrlLen && scala.util.Try(new URI(url)).toOption.exists { u =>
      (u.getScheme == "http" || u.getScheme == "https") && u.getHost != null
    }

  val route: Route =
    path("shorten") {
      post {
        entity(as[ShortenRequest]) { req =>
          if (!validUrl(req.url)) json(StatusCodes.BadRequest, """{"error":"url must be http(s) and at most 2048 characters"}""")
          else
            req.alias match {
              case Some(alias) if !AliasRe.matches(alias) =>
                json(StatusCodes.BadRequest, """{"error":"alias must match [A-Za-z0-9_-]{4,32}"}""")
              case Some(alias) if store.exists(alias) =>
                json(StatusCodes.Conflict, """{"error":"alias already taken"}""")
              case maybeAlias =>
                val code = maybeAlias.getOrElse(nextCode())
                store.save(code, req.url)
                val short = BaseUrl + code
                json(StatusCodes.Created, s"""{"code":"$code","short_url":"$short"}""", List(Location(Uri(short))))
            }
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
#include <nlohmann/json.hpp>

#include <cstring>
#include <regex>
#include <string>

#include "links.h"  // Store: bool exists(const std::string& code); void save(const std::string& code, const std::string& url)

using json = nlohmann::json;

const std::string kBaseUrl = "https://sho.rt/";
constexpr std::size_t kMaxUrlLen = 2048;
const std::regex kAliasRe(R"(^[A-Za-z0-9_-]{4,32}$)");

Store store;  // the links table (provided)

// A fresh short code from the key service (built in step 2).
std::string next_code();

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/shorten", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const std::string url = body.value("url", "");
    const std::string alias = body.value("alias", "");
    // TODO: 400 unless url starts with "http://" or "https://" and url.size() <= kMaxUrlLen
    // TODO: alias given → 400 unless std::regex_match(alias, kAliasRe); 409 when store.exists(alias)
    // TODO: no alias → next_code()
    // TODO: store.save(code, url); 201 {code, short_url} with a Location header
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstring>
#include <regex>
#include <string>

#include "links.h"  // Store: bool exists(const std::string& code); void save(const std::string& code, const std::string& url)

using json = nlohmann::json;

const std::string kBaseUrl = "https://sho.rt/";
constexpr std::size_t kMaxUrlLen = 2048;
const std::regex kAliasRe(R"(^[A-Za-z0-9_-]{4,32}$)");

Store store;  // the links table (provided)

// A fresh short code from the key service (built in step 2).
std::string next_code();

static bool valid_url(const std::string& url) {
  if (url.size() > kMaxUrlLen) return false;
  for (const char* scheme : {"http://", "https://"}) {
    const std::size_t n = std::strlen(scheme);
    if (url.compare(0, n, scheme) == 0 && url.size() > n) return true;
  }
  return false;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/shorten", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const std::string url = body.value("url", "");
    const std::string alias = body.value("alias", "");
    if (!valid_url(url)) {
      res.status = 400;
      res.set_content(R"({"error":"url must be http(s) and at most 2048 characters"})", "application/json");
      return;
    }
    std::string code = alias;
    if (!alias.empty()) {
      if (!std::regex_match(alias, kAliasRe)) {
        res.status = 400;
        res.set_content(R"({"error":"alias must match [A-Za-z0-9_-]{4,32}"})", "application/json");
        return;
      }
      if (store.exists(alias)) {
        res.status = 409;
        res.set_content(R"({"error":"alias already taken"})", "application/json");
        return;
      }
    } else {
      code = next_code();
    }
    store.save(code, url);
    const std::string short_url = kBaseUrl + code;
    res.status = 201;
    res.set_header("Location", short_url);
    res.set_content(json{{"code", code}, {"short_url", short_url}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `class FakeStore:
    """The links table: remembers what was saved and which names are taken."""

    def __init__(self, taken=()):
        self.taken = set(taken)
        self.saved = []
        self.exists_calls = []

    def exists(self, code):
        self.exists_calls.append(code)
        return code in self.taken

    def save(self, code, url):
        self.saved.append((code, url))
        self.taken.add(code)


def _api(ctx, taken=()):
    m = ctx.load("shorten_api")
    m.store = FakeStore(taken)
    m.codes = []

    def next_code():
        m.codes.append("g9Xc")
        return "g9Xc"

    m.next_code = next_code
    return m


URL = "https://example.com/launch"


async def check_route(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/shorten", json={"url": URL})
    assert r.status_code not in (404, 405), f"POST /shorten answered {r.status_code}: no handler is registered for it"
    assert r.status_code == 201, f"POST /shorten with a valid url answered {r.status_code}, expected 201"


async def check_validate_url(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        for bad in ("ftp://example.com/file", "example.com/no-scheme", "javascript:alert(1)", ""):
            r = await c.post("/shorten", json={"url": bad})
            assert r.status_code == 400, f"url {bad!r} is not http(s): expected 400, got {r.status_code}"
        too_long = "https://example.com/" + "a" * (2049 - len("https://example.com/"))
        r = await c.post("/shorten", json={"url": too_long})
        assert r.status_code == 400, f"a {len(too_long)}-character url is over MAX_URL_LEN: expected 400, got {r.status_code}"
        assert m.store.saved == [] and m.codes == [], "a rejected url must be refused before any code is taken or anything is saved"
        limit = "https://example.com/" + "a" * (2048 - len("https://example.com/"))
        r = await c.post("/shorten", json={"url": limit})
        assert r.status_code == 201, f"a url of exactly 2048 characters is allowed: expected 201, got {r.status_code}"
        r = await c.post("/shorten", json={"url": "http://example.com/plain"})
        assert r.status_code == 201, f"plain http is allowed: expected 201, got {r.status_code}"


async def check_alias_format(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        for bad in ("abc", "has space", "a" * 33, "dots.are.out", "sl/ash"):
            r = await c.post("/shorten", json={"url": URL, "alias": bad})
            assert r.status_code == 400, f"alias {bad!r} does not match ALIAS_RE: expected 400, got {r.status_code}"
        assert m.store.exists_calls == [], "a malformed alias is rejected before the store is asked whether it exists"
        assert m.store.saved == [], "a malformed alias must not be saved"
        r = await c.post("/shorten", json={"url": URL, "alias": "launch_2026-v1"})
        assert r.status_code == 201, f"alias 'launch_2026-v1' is valid: expected 201, got {r.status_code}"
        assert r.json().get("code") == "launch_2026-v1", f"the custom alias must become the code, got {r.json()}"


async def check_alias_taken(ctx):
    m = _api(ctx, taken=["launch"])
    async with ctx.client(m.app) as c:
        r = await c.post("/shorten", json={"url": URL, "alias": "launch"})
        assert r.status_code == 409, f"alias 'launch' already exists: expected 409, got {r.status_code}"
        assert m.store.saved == [], "a taken alias must not be overwritten"
        assert m.codes == [], "a taken alias is a client error: no code from next_code() is spent on it"
        r = await c.post("/shorten", json={"url": URL, "alias": "launch2"})
        assert r.status_code == 201, f"a free alias must be accepted: expected 201, got {r.status_code}"
        assert ("launch2", URL) in m.store.saved, f"expected ('launch2', url) to be saved, saved: {m.store.saved}"


async def check_created(ctx):
    m = _api(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/shorten", json={"url": URL})
    assert r.status_code == 201, f"expected 201 Created, got {r.status_code}"
    assert m.codes == ["g9Xc"], "without an alias the code must come from next_code()"
    assert m.store.saved == [("g9Xc", URL)], f"expected store.save('g9Xc', url), saved: {m.store.saved}"
    body = r.json()
    assert body.get("code") == "g9Xc", f"the body must carry the code, got {body}"
    assert body.get("short_url") == m.BASE_URL + "g9Xc", f"short_url must be BASE_URL + code, got {body.get('short_url')!r}"
    assert r.headers.get("location") == body["short_url"], f"Location must point at the short url, got {r.headers.get('location')!r}"
`,
    typescript: `const URL_ = 'https://example.com/launch';

/** The links table and the key service: remember what was saved, which names are taken, which codes were minted. */
function api(ctx, taken: string[] = []) {
  const m = ctx.load('shorten_api');
  const takenSet = new Set(taken);
  const saved: [string, string][] = [];
  const existsCalls: string[] = [];
  const codes: string[] = [];
  m.store.exists = async (code: string) => {
    existsCalls.push(code);
    return takenSet.has(code);
  };
  m.store.save = async (code: string, url: string) => {
    saved.push([code, url]);
    takenSet.add(code);
  };
  m.keys.nextCode = async () => {
    codes.push('g9Xc');
    return 'g9Xc';
  };
  return {m, saved, existsCalls, codes};
}

export async function check_route(ctx) {
  const {m} = api(ctx);
  const r = await ctx.client(m.app).post('/shorten', {json: {url: URL_}});
  assert(![404, 405].includes(r.status), \`POST /shorten answered \${r.status}: no handler is registered for it\`);
  assert.equal(r.status, 201, \`POST /shorten with a valid url answered \${r.status}, expected 201\`);
}

export async function check_validate_url(ctx) {
  const {m, saved, codes} = api(ctx);
  const c = ctx.client(m.app);
  for (const bad of ['ftp://example.com/file', 'example.com/no-scheme', 'javascript:alert(1)', '']) {
    const r = await c.post('/shorten', {json: {url: bad}});
    assert.equal(r.status, 400, \`url \${JSON.stringify(bad)} is not http(s): expected 400, got \${r.status}\`);
  }
  const tooLong = 'https://example.com/' + 'a'.repeat(2049 - 'https://example.com/'.length);
  let r = await c.post('/shorten', {json: {url: tooLong}});
  assert.equal(r.status, 400, \`a \${tooLong.length}-character url is over MAX_URL_LEN: expected 400, got \${r.status}\`);
  assert(saved.length === 0 && codes.length === 0, 'a rejected url must be refused before any code is taken or anything is saved');
  const limit = 'https://example.com/' + 'a'.repeat(2048 - 'https://example.com/'.length);
  r = await c.post('/shorten', {json: {url: limit}});
  assert.equal(r.status, 201, \`a url of exactly 2048 characters is allowed: expected 201, got \${r.status}\`);
  r = await c.post('/shorten', {json: {url: 'http://example.com/plain'}});
  assert.equal(r.status, 201, \`plain http is allowed: expected 201, got \${r.status}\`);
}

export async function check_alias_format(ctx) {
  const {m, saved, existsCalls} = api(ctx);
  const c = ctx.client(m.app);
  for (const bad of ['abc', 'has space', 'a'.repeat(33), 'dots.are.out', 'sl/ash']) {
    const r = await c.post('/shorten', {json: {url: URL_, alias: bad}});
    assert.equal(r.status, 400, \`alias \${JSON.stringify(bad)} does not match ALIAS_RE: expected 400, got \${r.status}\`);
  }
  assert.deepEqual(existsCalls, [], 'a malformed alias is rejected before the store is asked whether it exists');
  assert.deepEqual(saved, [], 'a malformed alias must not be saved');
  const r = await c.post('/shorten', {json: {url: URL_, alias: 'launch_2026-v1'}});
  assert.equal(r.status, 201, \`alias 'launch_2026-v1' is valid: expected 201, got \${r.status}\`);
  assert.equal(r.json().code, 'launch_2026-v1', \`the custom alias must become the code, got \${r.text}\`);
}

export async function check_alias_taken(ctx) {
  const {m, saved, codes} = api(ctx, ['launch']);
  const c = ctx.client(m.app);
  let r = await c.post('/shorten', {json: {url: URL_, alias: 'launch'}});
  assert.equal(r.status, 409, \`alias 'launch' already exists: expected 409, got \${r.status}\`);
  assert.deepEqual(saved, [], 'a taken alias must not be overwritten');
  assert.deepEqual(codes, [], 'a taken alias is a client error: no code from keys.nextCode() is spent on it');
  r = await c.post('/shorten', {json: {url: URL_, alias: 'launch2'}});
  assert.equal(r.status, 201, \`a free alias must be accepted: expected 201, got \${r.status}\`);
  assert(saved.some(([code, url]) => code === 'launch2' && url === URL_), \`expected ['launch2', url] to be saved, saved: \${JSON.stringify(saved)}\`);
}

export async function check_created(ctx) {
  const {m, saved, codes} = api(ctx);
  const r = await ctx.client(m.app).post('/shorten', {json: {url: URL_}});
  assert.equal(r.status, 201, \`expected 201 Created, got \${r.status}\`);
  assert.deepEqual(codes, ['g9Xc'], 'without an alias the code must come from keys.nextCode()');
  assert.deepEqual(saved, [['g9Xc', URL_]], \`expected store.save('g9Xc', url), saved: \${JSON.stringify(saved)}\`);
  const body = r.json();
  assert.equal(body.code, 'g9Xc', \`the body must carry the code, got \${r.text}\`);
  assert.equal(body.short_url, m.BASE_URL + 'g9Xc', \`short_url must be BASE_URL + code, got \${JSON.stringify(body.short_url)}\`);
  assert.equal(r.headers['location'], body.short_url, \`Location must point at the short url, got \${JSON.stringify(r.headers['location'])}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"

	"leetbuild/harness"
)

const longURL = "https://example.com/launch"

// fakeStore is the links table: what was saved, which names are taken, which were asked about.
type fakeStore struct {
	taken       map[string]bool
	saved       [][2]string
	existsCalls []string
}

func (s *fakeStore) Exists(_ context.Context, code string) (bool, error) {
	s.existsCalls = append(s.existsCalls, code)
	return s.taken[code], nil
}

func (s *fakeStore) Save(_ context.Context, code, url string) error {
	s.saved = append(s.saved, [2]string{code, url})
	s.taken[code] = true
	return nil
}

func (s *fakeStore) Lookup(_ context.Context, code string) (string, error) {
	for _, pair := range s.saved {
		if pair[0] == code {
			return pair[1], nil
		}
	}
	return "", nil
}

func (s *fakeStore) has(code, url string) bool {
	for _, pair := range s.saved {
		if pair[0] == code && pair[1] == url {
			return true
		}
	}
	return false
}

// api is the learner's server with the links table and the key service stood in for.
type api struct {
	store *fakeStore
	codes []string
	http  *harness.HTTP
}

func newAPI(ctx *harness.Ctx, taken ...string) *api {
	a := &api{store: &fakeStore{taken: map[string]bool{}}}
	for _, code := range taken {
		a.store.taken[code] = true
	}
	store = a.store
	nextCode = func(context.Context) (string, error) {
		a.codes = append(a.codes, "g9Xc")
		return "g9Xc", nil
	}
	a.http = ctx.Main(main).HTTP()
	return a
}

func (a *api) shorten(body map[string]any) *harness.Response { return a.http.Post("/shorten", body) }

func CheckRoute(ctx *harness.Ctx) {
	a := newAPI(ctx)
	r := a.shorten(map[string]any{"url": longURL})
	ctx.Assert(r.Status != 404 && r.Status != 405, "POST /shorten answered %d: no handler is registered for it", r.Status)
	ctx.Equal(r.Status, 201, "POST /shorten with a valid url")
}

func CheckValidateUrl(ctx *harness.Ctx) {
	a := newAPI(ctx)
	for _, bad := range []string{"ftp://example.com/file", "example.com/no-scheme", "javascript:alert(1)", ""} {
		r := a.shorten(map[string]any{"url": bad})
		ctx.Equal(r.Status, 400, "url %q is not http(s)", bad)
	}
	tooLong := "https://example.com/" + strings.Repeat("a", 2049-len("https://example.com/"))
	r := a.shorten(map[string]any{"url": tooLong})
	ctx.Equal(r.Status, 400, "a %d-character url is over maxURLLen", len(tooLong))
	ctx.Assert(len(a.store.saved) == 0 && len(a.codes) == 0, "a rejected url must be refused before any code is taken or anything is saved")
	limit := "https://example.com/" + strings.Repeat("a", 2048-len("https://example.com/"))
	r = a.shorten(map[string]any{"url": limit})
	ctx.Equal(r.Status, 201, "a url of exactly 2048 characters is allowed")
	r = a.shorten(map[string]any{"url": "http://example.com/plain"})
	ctx.Equal(r.Status, 201, "plain http is allowed")
}

func CheckAliasFormat(ctx *harness.Ctx) {
	a := newAPI(ctx)
	for _, bad := range []string{"abc", "has space", strings.Repeat("a", 33), "dots.are.out", "sl/ash"} {
		r := a.shorten(map[string]any{"url": longURL, "alias": bad})
		ctx.Equal(r.Status, 400, "alias %q does not match aliasRe", bad)
	}
	ctx.Equal(a.store.existsCalls, []string(nil), "a malformed alias is rejected before the store is asked whether it exists")
	ctx.Equal(len(a.store.saved), 0, "a malformed alias must not be saved")
	r := a.shorten(map[string]any{"url": longURL, "alias": "launch_2026-v1"})
	ctx.Equal(r.Status, 201, "alias \\"launch_2026-v1\\" is valid")
	var body struct {
		Code string \`json:"code"\`
	}
	r.Decode(&body)
	ctx.Equal(body.Code, "launch_2026-v1", "the custom alias must become the code")
}

func CheckAliasTaken(ctx *harness.Ctx) {
	a := newAPI(ctx, "launch")
	r := a.shorten(map[string]any{"url": longURL, "alias": "launch"})
	ctx.Equal(r.Status, 409, "alias \\"launch\\" already exists")
	ctx.Equal(len(a.store.saved), 0, "a taken alias must not be overwritten")
	ctx.Equal(len(a.codes), 0, "a taken alias is a client error: no code from nextCode is spent on it")
	r = a.shorten(map[string]any{"url": longURL, "alias": "launch2"})
	ctx.Equal(r.Status, 201, "a free alias must be accepted")
	ctx.Assert(a.store.has("launch2", longURL), "expected store.Save(ctx, \\"launch2\\", url), saved: %v", a.store.saved)
}

func CheckCreated(ctx *harness.Ctx) {
	a := newAPI(ctx)
	r := a.shorten(map[string]any{"url": longURL})
	ctx.Equal(r.Status, 201, "a valid url without an alias")
	ctx.Equal(a.codes, []string{"g9Xc"}, "without an alias the code must come from nextCode")
	ctx.Assert(len(a.store.saved) == 1 && a.store.has("g9Xc", longURL), "expected one store.Save(ctx, \\"g9Xc\\", url), saved: %v", a.store.saved)
	var body struct {
		Code     string \`json:"code"\`
		ShortURL string \`json:"short_url"\`
	}
	r.Decode(&body)
	ctx.Equal(body.Code, "g9Xc", "the body must carry the code")
	ctx.Equal(body.ShortURL, baseURL+"g9Xc", "short_url must be baseURL + code")
	ctx.Equal(r.Header.Get("Location"), body.ShortURL, "Location must point at the short url")
}
`,
  },
  debrief: `The endpoint is a funnel: free checks first (scheme, length, alias format), then one store lookup, then — only for the requests that earned it — a code and a write. The two alias failures get different codes because the client can act on them differently: a 400 means "never send that", a 409 means "pick another". Real shorteners add authentication and per-user quotas, screen the target against malware lists before saving, and return the same short link for the same URL from the same user instead of minting a new one.`,
};
