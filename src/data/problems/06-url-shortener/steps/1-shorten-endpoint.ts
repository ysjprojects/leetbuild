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
func nextCode(ctx context.Context) (string, error) { panic("not implemented") }

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
func nextCode(ctx context.Context) (string, error) { panic("not implemented") }

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
  debrief: `The endpoint is a funnel: free checks first (scheme, length, alias format), then one store lookup, then — only for the requests that earned it — a code and a write. The two alias failures get different codes because the client can act on them differently: a 400 means "never send that", a 409 means "pick another". Real shorteners add authentication and per-user quotas, screen the target against malware lists before saving, and return the same short link for the same URL from the same user instead of minting a new one.`,
};
