import type {Step} from '@/lib/types';

export const citationStateStep: Step = {
  id: 'state',
  title: 'Redis span cache with version-scoped keys',
  concept: 'redis',
  guides: ['keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/spans?document_id=doc-7&version=3&start=412&end=447\`,
the read a citation UI calls to highlight a span: it looks the span up in Redis under
\`span_key(document_id, start, end)\`, on a miss slices \`documents.get_version(document_id, version)\`
and writes the slice back, answering \`{document_id, version, start, end, text, cached}\`. It serves
the demo and hides four flaws.

**Failure mode the checks target.** After version 2 of a document is published, a request for
version 2 is answered with version 1's text; \`start=010\` and \`start=10\` are cached twice; the
cache only ever grows; and a version that does not exist yet answers an empty span that is still
served after the version appears.

- The key names the **immutable version**: \`span:{document_id}:{version}:{start}:{end}\`.
- The version and the offsets in the key are **integers** parsed from the query, so \`010\` and
  \`10\` are one key.
- An entry is written with a **long TTL** in the same command, \`SPAN_TTL_S\` = 7 days: the version
  never changes, so the TTL only bounds memory.
- An **unknown version is 404** and nothing is cached for it.`,
  sequence: {
    participants: ['Citation UI', 'Citation API', 'Redis', 'documents'],
    messages: [
      {from: 'Citation UI', to: 'Citation API', label: 'GET /v1/spans · doc, version, start, end', kind: 'sync'},
      {from: 'Citation API', to: 'Redis', label: 'GET span:{doc}:{version}:{start}:{end}', kind: 'sync'},
      {from: 'Redis', to: 'Citation API', label: 'text / nil', kind: 'reply'},
      {from: 'Citation API', to: 'documents', label: 'get_version(doc, version) on a miss', kind: 'sync'},
      {from: 'documents', to: 'Citation API', label: 'immutable text · none → 404, nothing cached', kind: 'reply'},
      {from: 'Citation API', to: 'Redis', label: 'SET … EX SPAN_TTL_S (7 days)', kind: 'sync'},
      {from: 'Citation API', to: 'Citation UI', label: '200 {version, start, end, text, cached}', kind: 'reply'},
    ],
  },
  hints: [
    'Publish version 2 of a document, then ask for the same offsets in version 2: the answer is version 1’s text, flagged as cached. Ask for a version that does not exist yet: 200 with an empty text.',
    'The key is built from the document id and the raw query strings, so the version is not part of the span’s identity and `010` is not `10`; the entry has no expiry, and a missing version is sliced as an empty string and cached.',
    'Parse the offsets to integers, key `span:{document_id}:{version}:{start}:{end}`, write with `ex=SPAN_TTL_S`, and answer 404 without writing when `get_version` returns nothing.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/spans',
      detail: 'Register `GET /v1/spans`, answering the text at the offsets and whether it came from the cache.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/spans["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/spans['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/spans"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"spans"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/spans"/]},
      },
    },
    {
      id: 'version-key',
      title: 'The cache key names the immutable version',
      detail:
        'The key is `span:{document_id}:{version}:{start}:{end}` with the version as the integer it parses to, so version 2’s span is never answered from version 1’s entry and `version=02` reads version 2’s. The starter keys by document id and offsets only.',
      match: {
        python: {all: [/span:\{document_id\}:\{version\}:\{start\}:\{end\}/]},
        typescript: {all: [/span:\$\{documentId\}:\$\{version\}:\$\{start\}:\$\{end\}/]},
        go: {all: [/"span:%s:%d:%d:%d"/]},
        scala: {all: [/span:\$documentId:\$version:\$start:\$end/]},
        cpp: {all: [/"span:" \+ document_id \+ ":" \+ std::to_string\(version\)/]},
      },
    },
    {
      id: 'numeric-offsets',
      title: 'Offsets are integers in the key',
      detail:
        'The offsets are parsed from the query before they are keyed, so `start=010` and `start=10` are one entry and `start=00` is keyed `0`. The starter pastes the raw query strings into the key.',
      match: {
        python: {
          all: [/int\(\s*q\[["']start["']\]\s*\)/, /int\(\s*q\[["']end["']\]\s*\)/],
          none: [/span_key\([^)\n]*q\[/],
        },
        typescript: {
          all: [/Number\(\s*q\.start\s*\)/, /Number\(\s*q\.end\s*\)/],
          none: [/spanKey\([^)\n]*q\.(start|end)/],
        },
        go: {
          all: [/strconv\.Atoi\(\s*q\.Get\("start"\)\s*\)/, /strconv\.Atoi\(\s*q\.Get\("end"\)\s*\)/],
          none: [/spanKey\([^)\n]*q\.Get\(/],
        },
        scala: {all: [/"start"\.as\[(Long|Int)\]/, /"end"\.as\[(Long|Int)\]/]},
        cpp: {
          all: [
            /std::stol\(\s*req\.get_param_value\("start"\)\s*\)/,
            /std::stol\(\s*req\.get_param_value\("end"\)\s*\)/,
          ],
          none: [/spanKey\([^)\n]*get_param_value/],
        },
      },
    },
    {
      id: 'long-ttl',
      title: 'Span entries carry a long TTL',
      detail:
        'The entry is written with `SPAN_TTL_S` (7 days) in the same command, long because the version is immutable, finite so the cache does not hold every span ever read; an expiry set by a second command leaves an entry that never expires if the service dies in between. The starter writes with no expiry.',
      match: {
        python: {all: [/SPAN_TTL_S\s*=/, /ex\s*=\s*SPAN_TTL_S|setex\(/]},
        typescript: {all: [/SPAN_TTL_S\s*=/, /['"]EX['"],\s*SPAN_TTL_S|setex\(/]},
        go: {all: [/spanTTL\s*=/, /\.Set\([^\n]*spanTTL\)|SetEx\(/]},
        scala: {all: [/SpanTtlS(:\s*\w+)?\s*=/, /setex\([^\n]*SpanTtlS/]},
        cpp: {all: [/kSpanTtlS\s*=/, /seconds\(kSpanTtlS\)/]},
      },
    },
    {
      id: 'unknown-version',
      title: 'An unknown version is 404 and is not cached',
      detail:
        'When the document has no such version the read answers **404** and writes nothing, so the version is served once it is published. The starter slices an empty text and caches it.',
      match: {
        python: {all: [/\b404\b/], none: [/get_version\([^)\n]*\)\s*or\s*["']/]},
        typescript: {all: [/code\(\s*404\s*\)/], none: [/getVersion\([^)\n]*\)\)\s*\?\?/]},
        go: {all: [/StatusNotFound|\b404\b/], none: [/_\s*:=\s*documents\.GetVersion\(/]},
        scala: {all: [/NotFound|\b404\b/], none: [/getVersion\([^)\n]*\)\.getOrElse/]},
        cpp: {all: [/\b404\b/], none: [/getVersion\([^)\n]*\)\.value_or/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from citations import documents  # documents.get_version(document_id, version)

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def span_key(document_id, start, end) -> str:
    return f"span:{document_id}:{start}:{end}"


@app.get("/v1/spans")
def get_span(request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    q = request.query_params
    document_id, version = q["document_id"], int(q["version"])
    key = span_key(document_id, q["start"], q["end"])
    start, end = int(q["start"]), int(q["end"])
    view = {"document_id": document_id, "version": version, "start": start, "end": end}
    cached = r.get(key)
    if cached is not None:
        return JSONResponse({**view, "text": cached, "cached": True})
    text = documents.get_version(document_id, version) or ""
    span = text[start:end]
    r.set(key, span)
    return JSONResponse({**view, "text": span, "cached": False})
`,
      solution: `import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from citations import documents  # documents.get_version(document_id, version)

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# A version never changes, so an entry is never stale: the TTL only bounds what the cache holds.
SPAN_TTL_S = 7 * 24 * 3600


def span_key(document_id: str, version: int, start: int, end: int) -> str:
    return f"span:{document_id}:{version}:{start}:{end}"


@app.get("/v1/spans")
def get_span(request: Request) -> JSONResponse:
    q = request.query_params
    document_id, version = q["document_id"], int(q["version"])
    start, end = int(q["start"]), int(q["end"])
    key = span_key(document_id, version, start, end)
    view = {"document_id": document_id, "version": version, "start": start, "end": end}
    cached = r.get(key)
    if cached is not None:
        return JSONResponse({**view, "text": cached, "cached": True})
    text = documents.get_version(document_id, version)
    if text is None:
        # Nothing is cached: the version may be published later, and a cached miss would outlive that.
        return JSONResponse({"error": "no such document version"}, status_code=404)
    span = text[start:end]
    r.set(key, span, ex=SPAN_TTL_S)
    return JSONResponse({**view, "text": span, "cached": False})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {getVersion} from 'citations/documents';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const spanKey = (documentId: string, start: string, end: string): string => \`span:\${documentId}:\${start}:\${end}\`;

app.get('/v1/spans', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const q = request.query as Record<string, string>;
  const documentId = q.document_id;
  const version = Number(q.version);
  const key = spanKey(documentId, q.start, q.end);
  const start = Number(q.start);
  const end = Number(q.end);
  const view = {document_id: documentId, version, start, end};
  const cached = await redis.get(key);
  if (cached !== null) return {...view, text: cached, cached: true};
  const text = (await getVersion(documentId, version)) ?? '';
  const span = text.slice(start, end);
  await redis.set(key, span);
  return {...view, text: span, cached: false};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {getVersion} from 'citations/documents';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

// A version never changes, so an entry is never stale: the TTL only bounds what the cache holds.
export const SPAN_TTL_S = 7 * 24 * 3600;

export const spanKey = (documentId: string, version: number, start: number, end: number): string =>
  \`span:\${documentId}:\${version}:\${start}:\${end}\`;

app.get('/v1/spans', async (request, reply) => {
  const q = request.query as Record<string, string>;
  const documentId = q.document_id;
  const version = Number(q.version);
  const start = Number(q.start);
  const end = Number(q.end);
  const key = spanKey(documentId, version, start, end);
  const view = {document_id: documentId, version, start, end};
  const cached = await redis.get(key);
  if (cached !== null) return {...view, text: cached, cached: true};
  const text = await getVersion(documentId, version);
  // Nothing is cached: the version may be published later, and a cached miss would outlive that.
  if (text === null) return reply.code(404).send({error: 'no such document version'});
  const span = text.slice(start, end);
  await redis.set(key, span, 'EX', SPAN_TTL_S);
  return {...view, text: span, cached: false};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"citations/documents" // documents.GetVersion(ctx, documentID, version) (string, bool)
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type spanView struct {
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int    \`json:"start"\`
	End        int    \`json:"end"\`
	Text       string \`json:"text"\`
	Cached     bool   \`json:"cached"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// span is text[start:end], clamped to the text.
func span(text string, start, end int) string {
	start, end = max(start, 0), min(end, len(text))
	if start >= end {
		return ""
	}
	return text[start:end]
}

func spanKey(documentID, start, end string) string {
	return "span:" + documentID + ":" + start + ":" + end
}

func getSpan(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	q := r.URL.Query()
	documentID := q.Get("document_id")
	version, _ := strconv.Atoi(q.Get("version"))
	key := spanKey(documentID, q.Get("start"), q.Get("end"))
	start, _ := strconv.Atoi(q.Get("start"))
	end, _ := strconv.Atoi(q.Get("end"))
	view := spanView{DocumentID: documentID, Version: version, Start: start, End: end}
	if cached, err := rdb.Get(r.Context(), key).Result(); err == nil {
		view.Text = cached
		view.Cached = true
		writeJSON(rw, http.StatusOK, view)
		return
	}
	text, _ := documents.GetVersion(r.Context(), documentID, version)
	view.Text = span(text, start, end)
	rdb.Set(r.Context(), key, view.Text, 0)
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/spans", getSpan)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"citations/documents" // documents.GetVersion(ctx, documentID, version) (string, bool)
)

// A version never changes, so an entry is never stale: the TTL only bounds what the cache holds.
const spanTTL = 7 * 24 * time.Hour

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type spanView struct {
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int    \`json:"start"\`
	End        int    \`json:"end"\`
	Text       string \`json:"text"\`
	Cached     bool   \`json:"cached"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// span is text[start:end], clamped to the text.
func span(text string, start, end int) string {
	start, end = max(start, 0), min(end, len(text))
	if start >= end {
		return ""
	}
	return text[start:end]
}

func spanKey(documentID string, version, start, end int) string {
	return fmt.Sprintf("span:%s:%d:%d:%d", documentID, version, start, end)
}

func getSpan(rw http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	documentID := q.Get("document_id")
	version, _ := strconv.Atoi(q.Get("version"))
	start, _ := strconv.Atoi(q.Get("start"))
	end, _ := strconv.Atoi(q.Get("end"))
	key := spanKey(documentID, version, start, end)
	view := spanView{DocumentID: documentID, Version: version, Start: start, End: end}
	if cached, err := rdb.Get(r.Context(), key).Result(); err == nil {
		view.Text = cached
		view.Cached = true
		writeJSON(rw, http.StatusOK, view)
		return
	}
	text, ok := documents.GetVersion(r.Context(), documentID, version)
	if !ok {
		// Nothing is cached: the version may be published later, and a cached miss would outlive that.
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such document version"})
		return
	}
	view.Text = span(text, start, end)
	rdb.Set(r.Context(), key, view.Text, spanTTL)
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/spans", getSpan)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import citations.Documents // Documents.getVersion(documentId, version): Option[String]

object State {
  private val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def view(documentId: String, version: Long, start: Long, end: Long, text: String, cached: Boolean): JsObject =
    JsObject(
      "document_id" -> JsString(documentId),
      "version" -> JsNumber(version),
      "start" -> JsNumber(start),
      "end" -> JsNumber(end),
      "text" -> JsString(text),
      "cached" -> JsBoolean(cached)
    )

  def spanKey(documentId: String, start: String, end: String): String = s"span:$documentId:$start:$end"

  val route: Route =
    path("v1" / "spans") {
      get {
        parameters("document_id", "version".as[Long], "start", "end") { (documentId, version, rawStart, rawEnd) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val key = spanKey(documentId, rawStart, rawEnd)
          val (start, end) = (rawStart.toLong, rawEnd.toLong)
          Option(jedis.get(key)) match {
            case Some(cached) => complete(json(StatusCodes.OK, view(documentId, version, start, end, cached, cached = true)))
            case None =>
              val text = Documents.getVersion(documentId, version).getOrElse("")
              val span = text.slice(start.toInt, end.toInt)
              jedis.set(key, span)
              complete(json(StatusCodes.OK, view(documentId, version, start, end, span, cached = false)))
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import citations.Documents // Documents.getVersion(documentId, version): Option[String]

object State {
  /** A version never changes, so an entry is never stale: the TTL only bounds what the cache holds. */
  val SpanTtlS: Long = 7L * 24 * 3600

  private val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def view(documentId: String, version: Long, start: Long, end: Long, text: String, cached: Boolean): JsObject =
    JsObject(
      "document_id" -> JsString(documentId),
      "version" -> JsNumber(version),
      "start" -> JsNumber(start),
      "end" -> JsNumber(end),
      "text" -> JsString(text),
      "cached" -> JsBoolean(cached)
    )

  def spanKey(documentId: String, version: Long, start: Long, end: Long): String = s"span:$documentId:$version:$start:$end"

  val route: Route =
    path("v1" / "spans") {
      get {
        parameters("document_id", "version".as[Long], "start".as[Long], "end".as[Long]) { (documentId, version, start, end) =>
          val key = spanKey(documentId, version, start, end)
          Option(jedis.get(key)) match {
            case Some(cached) => complete(json(StatusCodes.OK, view(documentId, version, start, end, cached, cached = true)))
            case None =>
              Documents.getVersion(documentId, version) match {
                // Nothing is cached: the version may be published later, and a cached miss would outlive that.
                case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such document version"))))
                case Some(text) =>
                  val span = text.slice(start.toInt, end.toInt)
                  jedis.setex(key, SpanTtlS, span)
                  complete(json(StatusCodes.OK, view(documentId, version, start, end, span, cached = false)))
              }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <string>

#include "citations/documents.h"  // documents::getVersion(document_id, version) -> std::optional<std::string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// text[start, end), clamped to the text.
std::string span(const std::string& text, long start, long end) {
  start = std::max(start, 0L);
  end = std::min(end, static_cast<long>(text.size()));
  return start >= end ? "" : text.substr(start, end - start);
}

std::string spanKey(const std::string& document_id, const std::string& start, const std::string& end) {
  return "span:" + document_id + ":" + start + ":" + end;
}

void get_span(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string document_id = req.get_param_value("document_id");
  const long version = std::stol(req.get_param_value("version"));
  const std::string key = spanKey(document_id, req.get_param_value("start"), req.get_param_value("end"));
  const long start = std::stol(req.get_param_value("start"));
  const long end = std::stol(req.get_param_value("end"));
  json view = {{"document_id", document_id}, {"version", version}, {"start", start}, {"end", end}};
  if (const auto cached = redis.get(key)) {
    view["text"] = *cached;
    view["cached"] = true;
    res.set_content(view.dump(), "application/json");
    return;
  }
  const std::string text = span(documents::getVersion(document_id, version).value_or(""), start, end);
  redis.set(key, text);
  view["text"] = text;
  view["cached"] = false;
  res.set_content(view.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get("/v1/spans", get_span);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>

#include "citations/documents.h"  // documents::getVersion(document_id, version) -> std::optional<std::string>

using json = nlohmann::json;

// A version never changes, so an entry is never stale: the TTL only bounds what the cache holds.
constexpr long kSpanTtlS = 7L * 24 * 3600;

sw::redis::Redis redis("tcp://redis:6379");

// text[start, end), clamped to the text.
std::string span(const std::string& text, long start, long end) {
  start = std::max(start, 0L);
  end = std::min(end, static_cast<long>(text.size()));
  return start >= end ? "" : text.substr(start, end - start);
}

std::string spanKey(const std::string& document_id, long version, long start, long end) {
  return "span:" + document_id + ":" + std::to_string(version) + ":" + std::to_string(start) + ":" + std::to_string(end);
}

void get_span(const httplib::Request& req, httplib::Response& res) {
  const std::string document_id = req.get_param_value("document_id");
  const long version = std::stol(req.get_param_value("version"));
  const long start = std::stol(req.get_param_value("start"));
  const long end = std::stol(req.get_param_value("end"));
  const std::string key = spanKey(document_id, version, start, end);
  json view = {{"document_id", document_id}, {"version", version}, {"start", start}, {"end", end}};
  if (const auto cached = redis.get(key)) {
    view["text"] = *cached;
    view["cached"] = true;
    res.set_content(view.dump(), "application/json");
    return;
  }
  const auto version_text = documents::getVersion(document_id, version);
  if (!version_text) {
    // Nothing is cached: the version may be published later, and a cached miss would outlive that.
    res.status = 404;
    res.set_content(json{{"error", "no such document version"}}.dump(), "application/json");
    return;
  }
  const std::string text = span(*version_text, start, end);
  redis.set(key, text, std::chrono::seconds(kSpanTtlS));
  view["text"] = text;
  view["cached"] = false;
  res.set_content(view.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get("/v1/spans", get_span);
}
`,
    },
  },
  harness: {
    python: `from citations import documents

V1 = "Ada Lovelace wrote the first program in 1843."
V2 = "Ada Lovelace published the first program in 1843."
WEEK = 7 * 24 * 3600


def _api(ctx):
    return ctx.client(ctx.load("state").app)


async def _span(c, version, start, end):
    return await c.get(f"/v1/spans?document_id=doc-7&version={version}&start={start}&end={end}")


def _spans(ctx):
    return sorted(ctx.redis.keys("span:*"))


def _ttl_when_written(ctx, key):
    """The key's TTL right after the command that first creates it (a read that misses touches it first)."""
    seen = {}

    def arm():
        ctx.redis_after(key, snapshot)

    def snapshot():
        ttl = ctx.redis.ttl(key)
        if ttl == -2:
            arm()
        else:
            seen["ttl"] = ttl

    arm()
    return seen


async def check_route(ctx):
    documents.add_version("doc-7", V1)
    async with _api(ctx) as c:
        first = await _span(c, 1, 0, 12)
        again = await _span(c, 1, 0, 12)
    assert first.status_code == 200 and first.json().get("text") == "Ada Lovelace", f"GET /v1/spans for [0, 12) of version 1 answered {first.status_code} {first.text}, expected the text Ada Lovelace"
    assert first.json().get("cached") is False and again.json().get("cached") is True, f"the first read must be a miss and the second a hit, got cached={first.json().get('cached')} then {again.json().get('cached')}"


async def check_version_key(ctx):
    documents.add_version("doc-7", V1)
    documents.add_version("doc-7", V2)
    async with _api(ctx) as c:
        await _span(c, 1, 13, 18)
        r = await _span(c, 2, 13, 18)
        padded = await _span(c, "02", 13, 18)
    body = r.json()
    assert body.get("text") == "publi", f"[13, 18) of version 2 answered {body.get('text')!r} (cached={body.get('cached')}), expected 'publi': version 1's entry answered a request for version 2"
    assert ctx.redis.exists("span:doc-7:2:13:18"), f"no entry span:doc-7:2:13:18; the cache holds {_spans(ctx)}"
    assert padded.json().get("text") == "publi" and padded.json().get("cached") is True, f"version=02 after version=2 answered {padded.text}: the version in the key is the integer, so it is one entry ({_spans(ctx)})"


async def check_numeric_offsets(ctx):
    documents.add_version("doc-7", V1)
    async with _api(ctx) as c:
        padded = await _span(c, 1, "013", "018")
        plain = await _span(c, 1, 13, 18)
        zero = await _span(c, 1, "00", "012")
    assert padded.json().get("text") == "wrote" and plain.json().get("text") == "wrote", f"start=013&end=018 answered {padded.text}, start=13&end=18 answered {plain.text}"
    assert plain.json().get("cached") is True, f"start=13 after start=013 was a miss: one span is cached twice ({_spans(ctx)})"
    keys = _spans(ctx)
    assert len(keys) == 2, f"[13, 18) and [0, 12) are cached under {keys}, expected one key each"
    want = [k for k in keys if k.endswith(":13:18")]
    assert zero.json().get("text") == "Ada Lovelace" and want and want[0][: -len(":13:18")] + ":0:12" in keys, f"start=00&end=012 answered {zero.text} and the cache holds {keys}: the offsets in the key are the integers 0 and 12"


async def check_long_ttl(ctx):
    documents.add_version("doc-7", V1)
    async with _api(ctx) as c:
        await _span(c, 1, 13, 18)
        keys = _spans(ctx)
        assert len(keys) == 1, f"one read cached {keys}"
        ttl = ctx.redis.ttl(keys[0])
        assert ttl > 0, f"{keys[0]} has no expiry (TTL {ttl}): every span ever read stays in Redis"
        assert WEEK - 60 <= ttl <= WEEK, f"{keys[0]} expires in {ttl} s, expected SPAN_TTL_S = 7 days ({WEEK} s)"
        ctx.redis.delete(keys[0])
        seen = _ttl_when_written(ctx, keys[0])
        await _span(c, 1, 13, 18)
    assert "ttl" in seen, f"reading [13, 18) again after its entry was evicted never wrote {keys[0]}"
    assert WEEK - 60 <= seen["ttl"] <= WEEK, f"right after {keys[0]} was written its TTL was {seen['ttl']}: the entry and its expiry are one command (SET … EX), or a crash between two leaves an entry that never expires"


async def check_unknown_version(ctx):
    documents.add_version("doc-7", V1)
    async with _api(ctx) as c:
        r = await _span(c, 2, 13, 18)
        assert r.status_code == 404, f"version 2 does not exist yet and the read answered {r.status_code} {r.text}, expected 404"
        assert _spans(ctx) == [], f"a read of a missing version cached {_spans(ctx)}"
        documents.add_version("doc-7", V2)
        r = await _span(c, 2, 13, 18)
    assert r.status_code == 200 and r.json().get("text") == "publi", f"once version 2 is published the read answered {r.status_code} {r.text}, expected 'publi'"
`,
    typescript: `const V1 = 'Ada Lovelace wrote the first program in 1843.';
const V2 = 'Ada Lovelace published the first program in 1843.';
const WEEK = 7 * 24 * 3600;

function api(ctx) {
  return {c: ctx.client(ctx.load('state').app), documents: ctx.load('/support/citations/documents.ts')};
}

const span = (c, version, start, end) => c.get(\`/v1/spans?document_id=doc-7&version=\${version}&start=\${start}&end=\${end}\`);

const spans = ctx => (ctx.redis.keys('span:*') as string[]).sort();

/** The key's TTL right after the command that first creates it (a read that misses touches it first). */
function ttlWhenWritten(ctx, key: string): {ttl?: number} {
  const seen: {ttl?: number} = {};
  const arm = () =>
    ctx.redisAfter(key, () => {
      const ttl = ctx.redis.ttl(key);
      if (ttl === -2) arm();
      else seen.ttl = ttl;
    });
  arm();
  return seen;
}

export async function check_route(ctx) {
  const {c, documents} = api(ctx);
  await documents.addVersion('doc-7', V1);
  const first = await span(c, 1, 0, 12);
  const again = await span(c, 1, 0, 12);
  assert(first.status === 200 && first.json().text === 'Ada Lovelace', \`GET /v1/spans for [0, 12) of version 1 answered \${first.status} \${first.text}, expected the text Ada Lovelace\`);
  assert(first.json().cached === false && again.json().cached === true, \`the first read must be a miss and the second a hit, got cached=\${first.json().cached} then \${again.json().cached}\`);
}

export async function check_version_key(ctx) {
  const {c, documents} = api(ctx);
  await documents.addVersion('doc-7', V1);
  await documents.addVersion('doc-7', V2);
  await span(c, 1, 13, 18);
  const r = await span(c, 2, 13, 18);
  const padded = await span(c, '02', 13, 18);
  assert.equal(r.json().text, 'publi', \`[13, 18) of version 2 answered \${r.text}, expected 'publi': version 1's entry answered a request for version 2\`);
  assert.equal(ctx.redis.exists('span:doc-7:2:13:18'), 1, \`no entry span:doc-7:2:13:18; the cache holds \${JSON.stringify(spans(ctx))}\`);
  assert(padded.json().text === 'publi' && padded.json().cached === true, \`version=02 after version=2 answered \${padded.text}: the version in the key is the integer, so it is one entry (\${JSON.stringify(spans(ctx))})\`);
}

export async function check_numeric_offsets(ctx) {
  const {c, documents} = api(ctx);
  await documents.addVersion('doc-7', V1);
  const padded = await span(c, 1, '013', '018');
  const plain = await span(c, 1, 13, 18);
  const zero = await span(c, 1, '00', '012');
  assert(padded.json().text === 'wrote' && plain.json().text === 'wrote', \`start=013&end=018 answered \${padded.text}, start=13&end=18 answered \${plain.text}\`);
  assert.equal(plain.json().cached, true, \`start=13 after start=013 was a miss: one span is cached twice (\${JSON.stringify(spans(ctx))})\`);
  const keys = spans(ctx);
  assert.equal(keys.length, 2, \`[13, 18) and [0, 12) are cached under \${JSON.stringify(keys)}, expected one key each\`);
  const want = keys.find(k => k.endsWith(':13:18'));
  assert(zero.json().text === 'Ada Lovelace' && want !== undefined && keys.includes(want.slice(0, -':13:18'.length) + ':0:12'), \`start=00&end=012 answered \${zero.text} and the cache holds \${JSON.stringify(keys)}: the offsets in the key are the integers 0 and 12\`);
}

export async function check_long_ttl(ctx) {
  const {c, documents} = api(ctx);
  await documents.addVersion('doc-7', V1);
  await span(c, 1, 13, 18);
  const keys = spans(ctx);
  assert.equal(keys.length, 1, \`one read cached \${JSON.stringify(keys)}\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(ttl > 0, \`\${keys[0]} has no expiry (TTL \${ttl}): every span ever read stays in Redis\`);
  assert(WEEK - 60 <= ttl && ttl <= WEEK, \`\${keys[0]} expires in \${ttl} s, expected SPAN_TTL_S = 7 days (\${WEEK} s)\`);
  ctx.redis.del(keys[0]);
  const seen = ttlWhenWritten(ctx, keys[0]);
  await span(c, 1, 13, 18);
  assert(seen.ttl !== undefined, \`reading [13, 18) again after its entry was evicted never wrote \${keys[0]}\`);
  assert(WEEK - 60 <= seen.ttl && seen.ttl <= WEEK, \`right after \${keys[0]} was written its TTL was \${seen.ttl}: the entry and its expiry are one command (SET … EX), or a crash between two leaves an entry that never expires\`);
}

export async function check_unknown_version(ctx) {
  const {c, documents} = api(ctx);
  await documents.addVersion('doc-7', V1);
  let r = await span(c, 2, 13, 18);
  assert.equal(r.status, 404, \`version 2 does not exist yet and the read answered \${r.status} \${r.text}, expected 404\`);
  assert.deepStrictEqual(spans(ctx), [], \`a read of a missing version cached \${JSON.stringify(spans(ctx))}\`);
  await documents.addVersion('doc-7', V2);
  r = await span(c, 2, 13, 18);
  assert(r.status === 200 && r.json().text === 'publi', \`once version 2 is published the read answered \${r.status} \${r.text}, expected 'publi'\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"citations/documents"

	"leetbuild/harness"
)

const (
	hStateV1 = "Ada Lovelace wrote the first program in 1843."
	hStateV2 = "Ada Lovelace published the first program in 1843."
	hWeek    = 7 * 24 * 3600
)

var hStateBg = context.Background()

func hSpansAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func hReadSpan(c *harness.HTTP, version, start, end string) (*harness.Response, map[string]any) {
	r := c.Get(fmt.Sprintf("/v1/spans?document_id=doc-7&version=%s&start=%s&end=%s", version, start, end))
	body, _ := r.JSON().(map[string]any)
	return r, body
}

// hTTLSeen is a key's TTL right after the command that first created it.
type hTTLSeen struct {
	written bool
	ttl     int64
}

// hTTLWhenWritten records the key's TTL right after the command that first creates it (a read that misses touches it first).
func hTTLWhenWritten(ctx *harness.Ctx, key string) *hTTLSeen {
	seen := &hTTLSeen{}
	var arm func()
	arm = func() {
		ctx.Redis.After(key, func() any {
			if ttl := ctx.Redis.TTL(key); ttl == -2 {
				arm()
			} else {
				seen.written, seen.ttl = true, ttl
			}
			return nil
		})
	}
	arm()
	return seen
}

func CheckRoute(ctx *harness.Ctx) {
	documents.AddVersion(hStateBg, "doc-7", hStateV1)
	c := hSpansAPI(ctx)
	first, fb := hReadSpan(c, "1", "0", "12")
	_, ab := hReadSpan(c, "1", "0", "12")
	ctx.Assert(first.Status == 200 && fb["text"] == "Ada Lovelace", "GET /v1/spans for [0, 12) of version 1 answered %d %s, expected the text Ada Lovelace", first.Status, first.Text())
	ctx.Assert(fb["cached"] == false && ab["cached"] == true, "the first read must be a miss and the second a hit, got cached=%v then %v", fb["cached"], ab["cached"])
}

func CheckVersionKey(ctx *harness.Ctx) {
	documents.AddVersion(hStateBg, "doc-7", hStateV1)
	documents.AddVersion(hStateBg, "doc-7", hStateV2)
	c := hSpansAPI(ctx)
	hReadSpan(c, "1", "13", "18")
	r, b := hReadSpan(c, "2", "13", "18")
	padded, pb := hReadSpan(c, "02", "13", "18")
	ctx.Assert(b["text"] == "publi", "[13, 18) of version 2 answered %s, expected 'publi': version 1's entry answered a request for version 2", r.Text())
	ctx.Equal(ctx.Redis.Exists("span:doc-7:2:13:18"), int64(1), "the entry span:doc-7:2:13:18 (the cache holds %q)", ctx.Redis.Keys("span:*"))
	ctx.Assert(pb["text"] == "publi" && pb["cached"] == true, "version=02 after version=2 answered %s: the version in the key is the integer, so it is one entry (%q)", padded.Text(), ctx.Redis.Keys("span:*"))
}

func CheckNumericOffsets(ctx *harness.Ctx) {
	documents.AddVersion(hStateBg, "doc-7", hStateV1)
	c := hSpansAPI(ctx)
	padded, pb := hReadSpan(c, "1", "013", "018")
	plain, b := hReadSpan(c, "1", "13", "18")
	zero, zb := hReadSpan(c, "1", "00", "012")
	ctx.Assert(pb["text"] == "wrote" && b["text"] == "wrote", "start=013&end=018 answered %s, start=13&end=18 answered %s", padded.Text(), plain.Text())
	ctx.Assert(b["cached"] == true, "start=13 after start=013 was a miss: one span is cached twice (%q)", ctx.Redis.Keys("span:*"))
	keys := ctx.Redis.Keys("span:*")
	ctx.Equal(len(keys), 2, "[13, 18) and [0, 12) must be cached under one key each (%q); the keys", keys)
	found := false
	for _, k := range keys {
		for _, other := range keys {
			found = found || (strings.HasSuffix(k, ":13:18") && other == strings.TrimSuffix(k, ":13:18")+":0:12")
		}
	}
	ctx.Assert(zb["text"] == "Ada Lovelace" && found, "start=00&end=012 answered %s and the cache holds %q: the offsets in the key are the integers 0 and 12", zero.Text(), keys)
}

func CheckLongTtl(ctx *harness.Ctx) {
	documents.AddVersion(hStateBg, "doc-7", hStateV1)
	c := hSpansAPI(ctx)
	hReadSpan(c, "1", "13", "18")
	keys := ctx.Redis.Keys("span:*")
	ctx.Equal(len(keys), 1, "one read must cache one key (%q); the keys", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): every span ever read stays in Redis", keys[0], ttl)
	ctx.Assert(hWeek-60 <= ttl && ttl <= hWeek, "%s expires in %d s, expected SPAN_TTL_S = 7 days (%d s)", keys[0], ttl, hWeek)
	ctx.Redis.Del(keys[0])
	seen := hTTLWhenWritten(ctx, keys[0])
	hReadSpan(c, "1", "13", "18")
	ctx.Assert(seen.written, "reading [13, 18) again after its entry was evicted never wrote %s", keys[0])
	ctx.Assert(hWeek-60 <= seen.ttl && seen.ttl <= hWeek, "right after %s was written its TTL was %d: the entry and its expiry are one command (SET … EX), or a crash between two leaves an entry that never expires", keys[0], seen.ttl)
}

func CheckUnknownVersion(ctx *harness.Ctx) {
	documents.AddVersion(hStateBg, "doc-7", hStateV1)
	c := hSpansAPI(ctx)
	r, _ := hReadSpan(c, "2", "13", "18")
	ctx.Equal(r.Status, 404, "version 2 does not exist yet (%s)", r.Text())
	ctx.Equal(len(ctx.Redis.Keys("span:*")), 0, "a read of a missing version must cache nothing (%q); the keys", ctx.Redis.Keys("span:*"))
	documents.AddVersion(hStateBg, "doc-7", hStateV2)
	r, b := hReadSpan(c, "2", "13", "18")
	ctx.Assert(r.Status == 200 && b["text"] == "publi", "once version 2 is published the read answered %d %s, expected 'publi'", r.Status, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <functional>
#include <memory>
#include <string>

#include "citations/documents.h"

using json = nlohmann::json;

namespace {

const std::string hStateV1 = "Ada Lovelace wrote the first program in 1843.";
const std::string hStateV2 = "Ada Lovelace published the first program in 1843.";
constexpr long long hWeek = 7LL * 24 * 3600;

harness::HTTP hSpansAPI(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response hReadSpan(harness::HTTP& c, const std::string& version, const std::string& start, const std::string& end) {
  return c.Get("/v1/spans?document_id=doc-7&version=" + version + "&start=" + start + "&end=" + end);
}

json hBodyOf(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : json::object();
}

// A key's TTL right after the command that first created it.
struct HTTLSeen {
  bool written = false;
  long long ttl = 0;
};

// Records the key's TTL right after the command that first creates it (a read that misses touches it first).
std::shared_ptr<HTTLSeen> hTTLWhenWritten(harness::Ctx& ctx, const std::string& key) {
  auto seen = std::make_shared<HTTLSeen>();
  auto arm = std::make_shared<std::function<void()>>();
  *arm = [&ctx, key, seen, arm] {
    ctx.Redis.After(key, [&ctx, key, seen, arm] {
      const long long ttl = ctx.Redis.TTL(key);
      if (ttl == -2) {
        (*arm)();
      } else {
        seen->written = true;
        seen->ttl = ttl;
      }
    });
  };
  (*arm)();
  return seen;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  documents::addVersion("doc-7", hStateV1);
  auto c = hSpansAPI(ctx);
  const auto first = hReadSpan(c, "1", "0", "12");
  const auto again = hReadSpan(c, "1", "0", "12");
  ctx.Assert(first.Status == 200 && hBodyOf(first).value("text", "") == "Ada Lovelace", "GET /v1/spans for [0, 12) of version 1 answered %d %s, expected the text Ada Lovelace", first.Status, first.Text());
  ctx.Assert(hBodyOf(first).value("cached", true) == false && hBodyOf(again).value("cached", false) == true, "the first read must be a miss and the second a hit, got %s then %s", first.Text(), again.Text());
}

void CheckVersionKey(harness::Ctx& ctx) {
  documents::addVersion("doc-7", hStateV1);
  documents::addVersion("doc-7", hStateV2);
  auto c = hSpansAPI(ctx);
  hReadSpan(c, "1", "13", "18");
  const auto r = hReadSpan(c, "2", "13", "18");
  const auto padded = hReadSpan(c, "02", "13", "18");
  ctx.Assert(hBodyOf(r).value("text", "") == "publi", "[13, 18) of version 2 answered %s, expected 'publi': version 1's entry answered a request for version 2", r.Text());
  ctx.Equal(ctx.Redis.Exists("span:doc-7:2:13:18"), 1, "the entry span:doc-7:2:13:18 (the cache holds %q)", ctx.Redis.Keys("span:*"));
  ctx.Assert(hBodyOf(padded).value("text", "") == "publi" && hBodyOf(padded).value("cached", false) == true,
             "version=02 after version=2 answered %s: the version in the key is the integer, so it is one entry (%q)", padded.Text(), ctx.Redis.Keys("span:*"));
}

void CheckNumericOffsets(harness::Ctx& ctx) {
  documents::addVersion("doc-7", hStateV1);
  auto c = hSpansAPI(ctx);
  const auto padded = hReadSpan(c, "1", "013", "018");
  const auto plain = hReadSpan(c, "1", "13", "18");
  const auto zero = hReadSpan(c, "1", "00", "012");
  ctx.Assert(hBodyOf(padded).value("text", "") == "wrote" && hBodyOf(plain).value("text", "") == "wrote", "start=013&end=018 answered %s, start=13&end=18 answered %s", padded.Text(), plain.Text());
  ctx.Assert(hBodyOf(plain).value("cached", false) == true, "start=13 after start=013 was a miss: one span is cached twice (%q)", ctx.Redis.Keys("span:*"));
  const auto keys = ctx.Redis.Keys("span:*");
  ctx.Equal(keys.size(), 2, "[13, 18) and [0, 12) must be cached under one key each (%q); the keys", keys);
  const std::string suffix = ":13:18";
  bool found = false;
  for (const auto& k : keys) {
    if (k.size() < suffix.size() || k.compare(k.size() - suffix.size(), suffix.size(), suffix) != 0) continue;
    const std::string want = k.substr(0, k.size() - suffix.size()) + ":0:12";
    for (const auto& other : keys) found = found || other == want;
  }
  ctx.Assert(hBodyOf(zero).value("text", "") == "Ada Lovelace" && found, "start=00&end=012 answered %s and the cache holds %q: the offsets in the key are the integers 0 and 12", zero.Text(), keys);
}

void CheckLongTtl(harness::Ctx& ctx) {
  documents::addVersion("doc-7", hStateV1);
  auto c = hSpansAPI(ctx);
  hReadSpan(c, "1", "13", "18");
  const auto keys = ctx.Redis.Keys("span:*");
  ctx.Equal(keys.size(), 1, "one read must cache one key (%q); the keys", keys);
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): every span ever read stays in Redis", keys[0], ttl);
  ctx.Assert(hWeek - 60 <= ttl && ttl <= hWeek, "%s expires in %d s, expected SPAN_TTL_S = 7 days (%d s)", keys[0], ttl, hWeek);
  ctx.Redis.Del(keys[0]);
  const auto seen = hTTLWhenWritten(ctx, keys[0]);
  hReadSpan(c, "1", "13", "18");
  ctx.Assert(seen->written, "reading [13, 18) again after its entry was evicted never wrote %s", keys[0]);
  ctx.Assert(hWeek - 60 <= seen->ttl && seen->ttl <= hWeek,
             "right after %s was written its TTL was %d: the entry and its expiry are one command (SET … EX), or a crash between two leaves an entry that never expires", keys[0], seen->ttl);
}

void CheckUnknownVersion(harness::Ctx& ctx) {
  documents::addVersion("doc-7", hStateV1);
  auto c = hSpansAPI(ctx);
  auto r = hReadSpan(c, "2", "13", "18");
  ctx.Equal(r.Status, 404, "version 2 does not exist yet (%s)", r.Text());
  ctx.Equal(ctx.Redis.Keys("span:*").size(), 0, "a read of a missing version must cache nothing (%q); the keys", ctx.Redis.Keys("span:*"));
  documents::addVersion("doc-7", hStateV2);
  r = hReadSpan(c, "2", "13", "18");
  ctx.Assert(r.Status == 200 && hBodyOf(r).value("text", "") == "publi", "once version 2 is published the read answered %d %s, expected 'publi'", r.Status, r.Text());
}
`,
  },
  debrief: `Everything follows from the version being immutable: once it is part of the key an entry can never be wrong, so the cache needs no invalidation, only a TTL that bounds memory. Parsing the offsets before keying makes the key a function of the span rather than of how a client spelled it. Refusing to cache a miss is the same idea in reverse: the only thing that can change about a version is that it starts to exist. Production span caches also store a hash of the version's bytes beside the text, to catch a document store that broke immutability, and warm the spans of a new version before the answers citing it go out.`,
};
