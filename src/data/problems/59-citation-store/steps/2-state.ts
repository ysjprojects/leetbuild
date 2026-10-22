import type {Step} from '@/lib/types';

export const citationStateStep: Step = {
  id: 'state',
  title: 'Redis span cache with version-scoped keys',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'docstore'],
  task: `## Task

The starter is a plausible model-generated draft: a span resolves and the second request is fast, so
the demo looks cached. The key is wrong in two ways and the entry never expires. Find the flaws, fix
them, and prove the fix.

Implement the span cache used by every resolution, exposed as
\`GET /v1/spans?document_id=doc-7&version=3&start=412&end=447\`:

- The cache key names the **immutable version**: \`span:{document_id}:{version}:{start}:{end}\`.
  A key without the version serves one version's text for another version's request — after a
  document update every cached span is silently wrong.
- Offsets in the key are **normalized integers** (\`10\`, never the raw query string \`010\`): string
  offsets make two requests for the same span different keys, and one span of one version end up
  cached several times.
- The entry gets a **long TTL** on write (\`SPAN_TTL_S\`, seven days) because an immutable version
  cannot change: the TTL is the only eviction a span cache needs.
- A cached payload carries **its version** and a hit whose version is not the requested one is never
  served — the version in the key is the contract, the version in the payload is the proof.
- A write to a document invalidates **nothing**: no \`DEL\` on update, no key sweep. Nothing about an
  immutable version can go stale.
- A missing \`X-Tenant-Id\` is **401** and \`version < 1\`, \`start < 0\` or \`end <= start\` is
  **400**; an unknown version is **404**.

**Failure mode the checks target.** The draft’s key is \`span:{document_id}:{start}:{end}\` with the
raw query strings, written without a TTL and deleted whenever a document is updated. Each mistake is
invisible on a document that is never edited and never re-read with padded offsets — the two things
a real corpus does constantly.`,
  sequence: {
    participants: ['Client', 'Citation API', 'Redis', 'document store'],
    messages: [
      {from: 'Client', to: 'Citation API', label: 'GET /v1/spans · doc, version, start, end', kind: 'sync'},
      {from: 'Citation API', to: 'Redis', label: 'GET span:{doc}:{version}:{start}:{end}', kind: 'sync'},
      {from: 'Redis', to: 'Citation API', label: 'payload{version, text} / nil', kind: 'reply'},
      {from: 'Citation API', to: 'document store', label: 'getVersion(doc, version) on a miss', kind: 'sync'},
      {from: 'document store', to: 'Citation API', label: 'immutable version text', kind: 'reply'},
      {from: 'Citation API', to: 'Redis', label: 'SETEX span:{doc}:{version}:{start}:{end} · TTL 7 d', kind: 'sync'},
      {from: 'Citation API', to: 'Client', label: '200 {version, text, cached}', kind: 'reply'},
    ],
  },
  hints: [
    'The key is the identity of the thing you cache. A cached span is the text at a range of one immutable version, so all three parts — document, version, range — belong in the key. Anything less and two different spans share one entry.',
    'Normalize before you key: the query arrives as strings, so cast the offsets to integers once, at the edge, and build the key from the numbers. `010` and `10` are the same offset, and a cache that treats them as different loses its hits.',
    'Immutability is what buys the TTL: because a version never changes, `SETEX`/`SET … EX`/`Expire` is the whole eviction story, and the `DEL` in the update path is dead weight that can only race with a reader. Keep the version inside the payload too, so a hand-written or migrated key can never serve the wrong version.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/spans',
      detail: 'Register the span resolution route on `GET /v1/spans`.',
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
        'The key is `span:{document_id}:{version}:{start}:{end}`. The draft keys by document id and offsets, so after a document update one version’s cached text answers another version’s request.',
      match: {
        python: {all: [/span_key\(/, /span:\{document_id\}:\{version\}/]},
        typescript: {all: [/spanKey\(/, /span:\$\{documentId\}:\$\{version\}/]},
        go: {all: [/spanKey\(/, /span:%s:%d/]},
        scala: {all: [/spanKey\(/, /span:\$documentId:\$version/]},
        cpp: {all: [/spanKey\(/, /"span:" \+ documentId \+ ":" \+ std::to_string\(version\)/]},
      },
    },
    {
      id: 'numeric-offsets',
      title: 'Offsets are normalized to integers in the key',
      detail:
        'The offsets are cast to integers before they are keyed, so `10` and `010` are one key. The draft pastes the raw query strings into the key, so the same span is cached under several keys.',
      match: {
        python: {all: [/span_key\(/, /int\(start\)/, /int\(end\)/]},
        typescript: {all: [/Math\.trunc\(start\)/, /Math\.trunc\(end\)/]},
        go: {all: [/strconv\.FormatInt\(start/, /strconv\.FormatInt\(end/]},
        scala: {all: [/start\.toString/, /end\.toString/]},
        cpp: {all: [/std::to_string\(start\)/, /std::to_string\(end\)/]},
      },
    },
    {
      id: 'long-ttl',
      title: 'Span entries carry a long TTL',
      detail:
        'The entry is written with `SPAN_TTL_S`, a long TTL that matches the immutability of the version. The draft writes span keys with no expiry at all, so every span a tenant ever resolves is kept forever.',
      match: {
        python: {all: [/SPAN_TTL_S/, /ex=SPAN_TTL_S/]},
        typescript: {all: [/SPAN_TTL_S/, /'EX',\s*SPAN_TTL_S/]},
        go: {all: [/spanTtlS/, /spanTtlS\s*\*\s*time\.Second/]},
        scala: {all: [/SpanTtlS/, /setex\(/]},
        cpp: {all: [/kSpanTtlS/, /std::chrono::seconds\(kSpanTtlS\)/]},
      },
    },
    {
      id: 'hit-scope',
      title: 'A hit for one version never serves another',
      detail:
        'The cached payload carries its version and a hit whose version differs from the requested one is refused, so a stale or migrated key cannot answer for the wrong version. Nothing deletes span keys — an immutable version is never invalidated (`DEL` on update is dead weight).',
      match: {
        python: {all: [/cached\["version"\]\s*!=\s*version/], none: [/\.delete\(/]},
        typescript: {all: [/cached\.version\s*!==?\s*version/], none: [/\.del\(/]},
        go: {all: [/cached\.Version\s*!=\s*version/], none: [/\.Del\(/]},
        scala: {all: [/cached\.version\s*!=\s*version/], none: [/\.del\(/]},
        cpp: {all: [/cached\.value\("version",\s*0\)\s*!=\s*version/], none: [/\.del\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def cache_key(document_id: str, start: str, end: str) -> str:
    # Offsets arrive as query strings, so "10" and "010" key differently, and the version is not
    # part of the key at all.
    return f"span:{document_id}:{start}:{end}"


@app.get("/v1/spans")
def get_span(
    document_id: str,
    version: int,
    start: str,
    end: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: the draft keys the cache by document id and the raw offset strings instead of the
    # immutable version, writes the entry with no TTL, and deletes keys when a document is updated.
    # Key by (document_id, version, start, end) with numeric offsets and a long TTL.
    raw = r.get(cache_key(document_id, start, end))
    if raw is not None:
        return JSONResponse({"text": raw, "cached": True}, status_code=200)
    text = documents.latest(document_id)[int(start) : int(end)]
    r.set(cache_key(document_id, start, end), text)
    return JSONResponse({"text": text, "cached": False}, status_code=200)


def on_document_updated(document_id: str) -> None:
    r.delete(f"span:{document_id}")
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# A version is immutable, so a cached span can live for a long time and never needs invalidating.
SPAN_TTL_S = 7 * 24 * 3600


def span_key(document_id: str, version: int, start: int, end: int) -> str:
    """The one key for one span of one immutable version: numeric offsets, version included."""
    return f"span:{document_id}:{version}:{int(start)}:{int(end)}"


def cached_span(document_id: str, version: int, start: int, end: int) -> str | None:
    raw = r.get(span_key(document_id, version, start, end))
    if raw is None:
        return None
    cached = json.loads(raw)
    if cached["version"] != version:
        return None
    return cached["text"]


def cache_span(document_id: str, version: int, start: int, end: int, text: str) -> None:
    payload = json.dumps({"version": version, "text": text})
    r.set(span_key(document_id, version, start, end), payload, ex=SPAN_TTL_S)


@app.get("/v1/spans")
def get_span(
    document_id: str,
    version: int,
    start: int,
    end: int,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if document_id == "" or version < 1 or start < 0 or end <= start:
        raise HTTPException(status_code=400, detail="invalid span")

    hit = cached_span(document_id, version, start, end)
    if hit is not None:
        return JSONResponse(
            {"document_id": document_id, "version": version, "start": start, "end": end, "text": hit, "cached": True},
            status_code=200,
        )

    text = documents.get_version(document_id, version)
    if text is None:
        raise HTTPException(status_code=404, detail="unknown document version")
    span = text[start:end]
    cache_span(document_id, version, start, end, span)
    return JSONResponse(
        {"document_id": document_id, "version": version, "start": start, "end": end, "text": span, "cached": False},
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/spans: a model-generated draft that caches by document id and string offsets. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {documents} from './store';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

function cacheKey(documentId: string, start: string, end: string): string {
  // The version is missing and the offsets come straight from the query string.
  return \`span:\${documentId}:\${start}:\${end}\`;
}

app.get('/v1/spans', async (request, reply) => {
  // TODO: the draft keys the cache by document id and the raw offset strings instead of the
  // immutable version, writes the entry with no TTL, and deletes keys when a document is updated.
  // Key by (document_id, version, start, end) with numeric offsets and a long TTL.
  const query = request.query as {document_id: string; version: string; start: string; end: string};
  const cached = await r.get(cacheKey(query.document_id, query.start, query.end));
  if (cached !== null) return reply.code(200).send({text: cached, cached: true});
  const text = documents.getLatest(query.document_id).slice(Number(query.start), Number(query.end));
  await r.set(cacheKey(query.document_id, query.start, query.end), text);
  return reply.code(200).send({text, cached: false});
});

/** Called when a document is updated. */
export async function onDocumentUpdated(documentId: string): Promise<void> {
  await r.del(\`span:\${documentId}\`);
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/spans: cache resolved span text under its immutable version. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {documents} from './store';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

// A version is immutable, so a cached span can live for a long time and never needs invalidating.
const SPAN_TTL_S = 7 * 24 * 3600;

function spanKey(documentId: string, version: number, start: number, end: number): string {
  return \`span:\${documentId}:\${version}:\${Math.trunc(start)}:\${Math.trunc(end)}\`;
}

async function cachedSpan(
  documentId: string,
  version: number,
  start: number,
  end: number,
): Promise<string | null> {
  const raw = await r.get(spanKey(documentId, version, start, end));
  if (raw === null) return null;
  const cached = JSON.parse(raw) as {version: number; text: string};
  if (cached.version !== version) return null;
  return cached.text;
}

async function cacheSpan(
  documentId: string,
  version: number,
  start: number,
  end: number,
  text: string,
): Promise<void> {
  await r.set(spanKey(documentId, version, start, end), JSON.stringify({version, text}), 'EX', SPAN_TTL_S);
}

app.get('/v1/spans', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const query = request.query as {document_id?: string; version?: string; start?: string; end?: string};
  const version = Number(query.version);
  const start = Number(query.start);
  const end = Number(query.end);
  if (
    typeof query.document_id !== 'string' ||
    query.document_id === '' ||
    !Number.isInteger(version) ||
    version < 1 ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  )
    return reply.code(400).send({error: 'invalid span'});

  const hit = await cachedSpan(query.document_id, version, start, end);
  if (hit !== null)
    return reply
      .code(200)
      .send({document_id: query.document_id, version, start, end, text: hit, cached: true});

  const text = documents.getVersion(query.document_id, version);
  if (text === null) return reply.code(404).send({error: 'unknown document version'});
  const span = text.slice(start, end);
  await cacheSpan(query.document_id, version, start, end, span);
  return reply.code(200).send({document_id: query.document_id, version, start, end, text: span, cached: false});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type DocumentStore struct{}

func (s *DocumentStore) Latest(documentID string) (string, bool) {
	return "", false
}

var documents = &DocumentStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func cacheKey(documentID, start, end string) string {
	// The version is missing and the offsets are the raw query strings.
	return "span:" + documentID + ":" + start + ":" + end
}

func getSpan(rw http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	documentID := query.Get("document_id")
	version := query.Get("version")
	start := query.Get("start")
	end := query.Get("end")
	// TODO: the draft keys the cache by document id and the raw offset strings instead of the
	// immutable version, writes the entry with no TTL, and deletes keys when a document is updated.
	// Key by (document_id, version, start, end) with numeric offsets and a long TTL.
	if raw, err := rdb.Get(r.Context(), cacheKey(documentID, start, end)).Result(); err == nil {
		writeJSON(rw, http.StatusOK, map[string]any{"text": raw, "cached": true})
		return
	}
	text, _ := documents.Latest(documentID)
	startInt, _ := strconv.Atoi(start)
	endInt, _ := strconv.Atoi(end)
	span := text[startInt:endInt]
	rdb.Set(r.Context(), cacheKey(documentID, start, end), span, 0)
	writeJSON(rw, http.StatusOK, map[string]any{"version": version, "text": span, "cached": false})
}

func onDocumentUpdated(ctx context.Context, documentID string) {
	rdb.Del(ctx, "span:"+documentID)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// A version is immutable, so a cached span can live for a long time and never needs invalidating.
const spanTtlS = 7 * 24 * 3600

var rdb *redis.Client

type DocumentStore struct{}

func (s *DocumentStore) GetVersion(documentID string, version int) (string, bool) {
	return "", false
}

var documents = &DocumentStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

type cachedSpanPayload struct {
	Version int    \`json:"version"\`
	Text    string \`json:"text"\`
}

func spanKey(documentID string, version int, start, end int64) string {
	return fmt.Sprintf("span:%s:%d:%s:%s", documentID, version, strconv.FormatInt(start, 10), strconv.FormatInt(end, 10))
}

func cachedSpan(ctx context.Context, documentID string, version int, start, end int64) (string, bool) {
	raw, err := rdb.Get(ctx, spanKey(documentID, version, start, end)).Result()
	if err != nil {
		return "", false
	}
	var cached cachedSpanPayload
	if err := json.Unmarshal([]byte(raw), &cached); err != nil {
		return "", false
	}
	if cached.Version != version {
		return "", false
	}
	return cached.Text, true
}

func cacheSpan(ctx context.Context, documentID string, version int, start, end int64, text string) {
	payload, _ := json.Marshal(cachedSpanPayload{Version: version, Text: text})
	rdb.Set(ctx, spanKey(documentID, version, start, end), payload, spanTtlS*time.Second)
}

func getSpan(rw http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Tenant-Id") == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	query := r.URL.Query()
	documentID := query.Get("document_id")
	version, errVersion := strconv.Atoi(query.Get("version"))
	start, errStart := strconv.ParseInt(query.Get("start"), 10, 64)
	end, errEnd := strconv.ParseInt(query.Get("end"), 10, 64)
	if documentID == "" || errVersion != nil || version < 1 || errStart != nil || errEnd != nil || start < 0 || end <= start {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid span"})
		return
	}

	if hit, ok := cachedSpan(r.Context(), documentID, version, start, end); ok {
		writeJSON(rw, http.StatusOK, map[string]any{
			"document_id": documentID,
			"version":     version,
			"start":       start,
			"end":         end,
			"text":        hit,
			"cached":      true,
		})
		return
	}

	text, ok := documents.GetVersion(documentID, version)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown document version"})
		return
	}
	span := text[start:end]
	cacheSpan(r.Context(), documentID, version, start, end, span)
	writeJSON(rw, http.StatusOK, map[string]any{
		"document_id": documentID,
		"version":     version,
		"start":       start,
		"end":         end,
		"text":        span,
		"cached":      false,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/spans", getSpan)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
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

object SpanApi {
  implicit val system: ActorSystem = ActorSystem("citation-store")

  val jedis = new Jedis("redis", 6379)

  def cacheKey(documentId: String, start: String, end: String): String =
    // The version is missing and the offsets are the raw query strings.
    s"span:$documentId:$start:$end"

  val route: Route =
    path("v1" / "spans") {
      get {
        parameters("document_id", "version", "start", "end") { (documentId, version, start, end) =>
          // TODO: the draft keys the cache by document id and the raw offset strings instead of the
          // immutable version, writes the entry with no TTL, and deletes keys when a document is
          // updated. Key by (document_id, version, start, end) with numeric offsets and a long TTL.
          Option(jedis.get(cacheKey(documentId, start, end))) match {
            case Some(text) =>
              complete(StatusCodes.OK, s"""{"text":"$text","cached":true}""")
            case None =>
              val text = documents.latest(documentId).substring(start.toInt, end.toInt)
              jedis.set(cacheKey(documentId, start, end), text)
              complete(StatusCodes.OK, s"""{"text":"$text","cached":false}""")
          }
        }
      }
    }

  def onDocumentUpdated(documentId: String): Unit = {
    jedis.del(s"span:$documentId")
    ()
  }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CachedSpan(version: Int, text: String)

object SpanApi {
  implicit val system: ActorSystem = ActorSystem("citation-store")
  implicit val cachedFormat: RootJsonFormat[CachedSpan] = jsonFormat2(CachedSpan)

  // A version is immutable, so a cached span can live for a long time and never needs invalidating.
  val SpanTtlS = 7 * 24 * 3600
  val jedis = new Jedis("redis", 6379)

  def spanKey(documentId: String, version: Int, start: Long, end: Long): String =
    s"span:$documentId:$version:\${start.toString}:\${end.toString}"

  def cachedSpan(documentId: String, version: Int, start: Long, end: Long): Option[String] =
    Option(jedis.get(spanKey(documentId, version, start, end))).flatMap { raw =>
      val cached = raw.parseJson.convertTo[CachedSpan]
      if (cached.version != version) None else Some(cached.text)
    }

  def cacheSpan(documentId: String, version: Int, start: Long, end: Long, text: String): Unit = {
    val payload = CachedSpan(version, text).toJson.compactPrint
    jedis.setex(spanKey(documentId, version, start, end), SpanTtlS, payload)
  }

  val route: Route =
    path("v1" / "spans") {
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameters("document_id", "version".as[Int], "start".as[Long], "end".as[Long]) {
            (documentId, version, start, end) =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (documentId.isEmpty || version < 1 || start < 0 || end <= start) {
                complete(StatusCodes.BadRequest, """{"error":"invalid span"}""")
              } else {
                cachedSpan(documentId, version, start, end) match {
                  case Some(hit) =>
                    complete(
                      StatusCodes.OK,
                      s"""{"document_id":"$documentId","version":$version,"start":$start,"end":$end,"text":"$hit","cached":true}"""
                    )
                  case None =>
                    documents.getVersion(documentId, version) match {
                      case None =>
                        complete(StatusCodes.NotFound, """{"error":"unknown document version"}""")
                      case Some(text) =>
                        val span = text.substring(start.toInt, end.toInt)
                        cacheSpan(documentId, version, start, end, span)
                        complete(
                          StatusCodes.OK,
                          s"""{"document_id":"$documentId","version":$version,"start":$start,"end":$end,"text":"$span","cached":false}"""
                        )
                    }
                }
              }
          }
        }
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
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

struct DocumentStore {
  std::string latest(const std::string& documentId) const;
};

DocumentStore documents;

std::string cacheKey(const std::string& documentId, const std::string& start, const std::string& end) {
  // The version is missing and the offsets are the raw query strings.
  return "span:" + documentId + ":" + start + ":" + end;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/spans", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto documentId = req.get_param_value("document_id");
    const auto start = req.get_param_value("start");
    const auto end = req.get_param_value("end");
    // TODO: the draft keys the cache by document id and the raw offset strings instead of the
    // immutable version, writes the entry with no TTL, and deletes keys when a document is updated.
    // Key by (document_id, version, start, end) with numeric offsets and a long TTL.
    if (const auto raw = redis.get(cacheKey(documentId, start, end))) {
      res.status = 200;
      res.set_content(json{{"text", *raw}, {"cached", true}}.dump(), "application/json");
      return;
    }
    const auto text = documents.latest(documentId).substr(std::stoll(start), std::stoll(end) - std::stoll(start));
    redis.set(cacheKey(documentId, start, end), text);
    res.status = 200;
    res.set_content(json{{"text", text}, {"cached", false}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}

void onDocumentUpdated(sw::redis::Redis& redis, const std::string& documentId) {
  redis.del("span:" + documentId);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

using json = nlohmann::json;

// A version is immutable, so a cached span can live for a long time and never needs invalidating.
constexpr long long kSpanTtlS = 7 * 24 * 3600;

struct DocumentStore {
  std::optional<std::string> getVersion(const std::string& documentId, int version) const;
};

DocumentStore documents;

std::string spanKey(const std::string& documentId, int version, long long start, long long end) {
  return "span:" + documentId + ":" + std::to_string(version) + ":" + std::to_string(start) + ":" +
         std::to_string(end);
}

std::optional<std::string> cachedSpan(
    sw::redis::Redis& redis,
    const std::string& documentId,
    int version,
    long long start,
    long long end) {
  const auto raw = redis.get(spanKey(documentId, version, start, end));
  if (!raw) return std::nullopt;
  const json cached = json::parse(*raw, nullptr, false);
  if (!cached.is_object() || cached.value("version", 0) != version) return std::nullopt;
  return cached.value("text", std::string());
}

void cacheSpan(
    sw::redis::Redis& redis,
    const std::string& documentId,
    int version,
    long long start,
    long long end,
    const std::string& text) {
  const json payload = {{"version", version}, {"text", text}};
  redis.set(spanKey(documentId, version, start, end), payload.dump(), std::chrono::seconds(kSpanTtlS));
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/spans", [&redis](const httplib::Request& req, httplib::Response& res) {
    if (req.get_header_value("X-Tenant-Id").empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto documentId = req.get_param_value("document_id");
    const auto versionText = req.get_param_value("version");
    const auto startText = req.get_param_value("start");
    const auto endText = req.get_param_value("end");
    const int version = versionText.empty() ? 0 : std::stoi(versionText);
    const long long start = startText.empty() ? -1 : std::stoll(startText);
    const long long end = endText.empty() ? -1 : std::stoll(endText);
    if (documentId.empty() || version < 1 || start < 0 || end <= start) {
      res.status = 400;
      res.set_content(R"({"error":"invalid span"})", "application/json");
      return;
    }

    if (const auto hit = cachedSpan(redis, documentId, version, start, end)) {
      res.status = 200;
      res.set_content(
          json{{"document_id", documentId}, {"version", version}, {"start", start}, {"end", end},
               {"text", *hit}, {"cached", true}}
              .dump(),
          "application/json");
      return;
    }

    const auto text = documents.getVersion(documentId, version);
    if (!text) {
      res.status = 404;
      res.set_content(R"({"error":"unknown document version"})", "application/json");
      return;
    }
    const auto span = text->substr(static_cast<std::size_t>(start), static_cast<std::size_t>(end - start));
    cacheSpan(redis, documentId, version, start, end, span);
    res.status = 200;
    res.set_content(
        json{{"document_id", documentId}, {"version", version}, {"start", start}, {"end", end},
             {"text", span}, {"cached", false}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question is what a cache key has to contain. A cache hit is a claim about a specific thing, so the key has to name that thing completely: the document, the version and the exact offset range. Leaving the version out is the subtle bug, because it passes every test written against one document revision and fails the moment the document is updated — the entry then answers one version with another version's text. The offset strings are the second trap: a query string is not an offset, and keying \`010\` beside \`10\` quietly destroys the hit rate. The TTL is the third: immutability is what lets the entry be long-lived, and it also means the \`DEL\` on update is dead weight that can race with a reader mid-request. Real span caches add a payload version stamp (a key can outlive a refactor), a size cap per document, and a background warmer for the versions a corpus reads most.`,
};
