import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: "GET /v1/documents/{id}/neighbors: the tenant's document, in its own version",
  concept: 'http',
  file: 'read',
  focus: ['client', 'search', 'corpus'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/documents/{id}/neighbors?k=\` (\`k\` 1 to 20, default
10, under \`X-Tenant-Id\`): it loads the document with \`corpus.document_by_id\`, asks \`corpus.nearest\`
for the \`k\` documents closest to its vector in the tenant's namespace of the active version, and
answers \`{document_id, neighbors, index_version}\` labelled with the active version. It serves the
demo and hides three flaws.

**Failure mode the checks target.** acme asks for the neighbours of a globex document id and gets an
answer, which confirms the id exists and ranks acme's corpus against globex's vector; every
document's nearest neighbour is itself; and during a reindex a document embedded by the old model is
compared with vectors from the new one, while the answer claims the new version.

- The document is the tenant's (\`corpus.document(tenant, id)\`); another tenant's id is **404**, like a
  missing one.
- The document is not its own neighbour: the answer holds \`k\` other documents.
- The neighbours come from the version the document was embedded for (its \`version\`), and
  \`index_version\` names it.`,
  sequence: {
    participants: ['Client', 'searchd', 'Corpus'],
    messages: [
      {from: 'Client', to: 'searchd', label: 'GET /v1/documents/d1/neighbors?k=2 · X-Tenant-Id', kind: 'sync'},
      {from: 'searchd', to: 'Corpus', label: 'document(acme, d1)', kind: 'sync'},
      {from: 'Corpus', to: 'searchd', label: 'd1 · version idx-42 · vector / none → 404', kind: 'reply'},
      {from: 'searchd', to: 'Corpus', label: 'nearest(acme, idx-42, vector, k + 1)', kind: 'sync'},
      {from: 'searchd', to: 'searchd', label: 'drop d1 · keep k', kind: 'sync'},
      {from: 'searchd', to: 'Client', label: '200 {neighbors, index_version: idx-42}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Answers GET /v1/documents/{id}/neighbors',
      detail:
        'Register `GET /v1/documents/{id}/neighbors`: **401** without `X-Tenant-Id`, **400** for `k` outside 1 to 20, and `{document_id, neighbors, index_version}` from `nearest` otherwise.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/documents\/\{document_id\}\/neighbors["']/, /corpus\.nearest\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/documents\/:documentId\/neighbors['"]/, /nearest\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/documents\/\{id\}\/neighbors"/, /corpus\.Nearest\(/]},
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"documents"\s*\/\s*Segment\s*\/\s*"neighbors"\s*\)/,
            /\bget\b/,
            /Corpus\.nearest\(/,
          ],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/documents\//, /corpus::nearest\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Loads only the tenant's document",
      detail:
        "The document is loaded with `document(tenant, id)`, and another tenant's id answers **404** like a missing one, so the endpoint confirms nothing about other tenants. The starter uses `document_by_id`, which finds any tenant's document.",
      match: {
        python: {all: [/corpus\.document\(\s*tenant\s*,/], none: [/document_by_id\(/]},
        typescript: {all: [/\bdocument\(\s*tenant\s*,/], none: [/documentById\(/]},
        go: {all: [/corpus\.Document\(\s*r\.Context\(\)\s*,\s*tenant\s*,/], none: [/DocumentByID\(/]},
        scala: {all: [/Corpus\.document\(\s*tenant\s*,/], none: [/documentById\(/]},
        cpp: {all: [/corpus::document\(\s*tenant\s*,/], none: [/documentById\(/]},
      },
    },
    {
      id: 'excludes-self',
      title: 'A document is not its own neighbour',
      detail:
        "The search asks for `k + 1` and drops the document's own id, so the answer holds `k` other documents. The starter returns the document itself first, with the top score.",
      match: {
        python: {all: [/\bk\s*\+\s*1\b/, /!=\s*document_id\b/]},
        typescript: {all: [/\bk\s*\+\s*1\b/, /!==\s*documentId\b/]},
        go: {all: [/\bk\s*\+\s*1\b/, /!=\s*documentID\b/]},
        scala: {all: [/\bk\s*\+\s*1\b/, /!=\s*documentId\b/]},
        cpp: {all: [/\bk\s*\+\s*1\b/, /!=\s*document_id\b/]},
      },
    },
    {
      id: 'document-version',
      title: "Searches and labels the document's own version",
      detail:
        'The neighbours are searched in the version the document was embedded for and `index_version` names it; vectors from two embedding versions are not comparable. The starter searches and labels the active version.',
      match: {
        python: {all: [/doc\[["']version["']\]/], none: [/active_index\(/]},
        typescript: {all: [/doc\.version\b/], none: [/activeIndex\(/]},
        go: {all: [/doc\.Version\b/], none: [/ActiveIndex\(/]},
        scala: {all: [/doc\.version\b/], none: [/activeIndex\(/]},
        cpp: {all: [/doc->version\b/], none: [/activeIndex\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from search import corpus  # active_index, nearest, document, document_by_id

app = FastAPI()

MAX_NEIGHBORS = 20


@app.get("/v1/documents/{document_id}/neighbors")
def neighbors(document_id: str, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    raw_k = request.query_params.get("k", "10")
    if not raw_k.isdigit() or not 1 <= int(raw_k) <= MAX_NEIGHBORS:
        raise HTTPException(status_code=400, detail=f"k must be an integer from 1 to {MAX_NEIGHBORS}")
    k = int(raw_k)
    doc = corpus.document_by_id(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="no such document")
    version = corpus.active_index()["version"]
    hits = corpus.nearest(tenant, version, doc["vector"], k)
    return {"document_id": document_id, "neighbors": hits, "index_version": version}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from search import corpus  # active_index, nearest, document, document_by_id

app = FastAPI()

MAX_NEIGHBORS = 20


@app.get("/v1/documents/{document_id}/neighbors")
def neighbors(document_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    raw_k = request.query_params.get("k", "10")
    if not raw_k.isdigit() or not 1 <= int(raw_k) <= MAX_NEIGHBORS:
        raise HTTPException(status_code=400, detail=f"k must be an integer from 1 to {MAX_NEIGHBORS}")
    k = int(raw_k)
    # Another tenant's document is not found, the same as a missing one.
    doc = corpus.document(tenant, document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="no such document")
    # Its vector is only comparable with vectors of the version it was embedded for.
    hits = [h for h in corpus.nearest(tenant, doc["version"], doc["vector"], k + 1) if h["id"] != document_id][:k]
    return {"document_id": document_id, "neighbors": hits, "index_version": doc["version"]}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {activeIndex, documentById, nearest} from 'search/corpus';

export const app = Fastify();

const MAX_NEIGHBORS = 20;

app.get('/v1/documents/:documentId/neighbors', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {documentId} = request.params as {documentId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {k: rawK = '10'} = request.query as {k?: string};
  const k = Number(rawK);
  if (!Number.isInteger(k) || k < 1 || k > MAX_NEIGHBORS) return reply.code(400).send({error: \`k must be an integer from 1 to \${MAX_NEIGHBORS}\`});
  const doc = await documentById(documentId);
  if (doc === null) return reply.code(404).send({error: 'no such document'});
  const version = (await activeIndex()).version;
  const hits = await nearest(tenant, version, doc.vector, k);
  return {document_id: documentId, neighbors: hits, index_version: version};
});
`,
      solution: `import Fastify from 'fastify';

import {document, nearest} from 'search/corpus';

export const app = Fastify();

const MAX_NEIGHBORS = 20;

app.get('/v1/documents/:documentId/neighbors', async (request, reply) => {
  const {documentId} = request.params as {documentId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {k: rawK = '10'} = request.query as {k?: string};
  const k = Number(rawK);
  if (!Number.isInteger(k) || k < 1 || k > MAX_NEIGHBORS) return reply.code(400).send({error: \`k must be an integer from 1 to \${MAX_NEIGHBORS}\`});
  // Another tenant's document is not found, the same as a missing one.
  const doc = await document(tenant, documentId);
  if (doc === null) return reply.code(404).send({error: 'no such document'});
  // Its vector is only comparable with vectors of the version it was embedded for.
  const hits = (await nearest(tenant, doc.version, doc.vector, k + 1)).filter(h => h.id !== documentId).slice(0, k);
  return {document_id: documentId, neighbors: hits, index_version: doc.version};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"search/corpus" // corpus.ActiveIndex, Nearest, Document, DocumentByID
)

const maxNeighbors = 20

type neighborsResponse struct {
	DocumentID   string       \`json:"document_id"\`
	Neighbors    []corpus.Hit \`json:"neighbors"\`
	IndexVersion string       \`json:"index_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func neighbors(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	documentID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	k := 10
	if raw := r.URL.Query().Get("k"); raw != "" {
		k, _ = strconv.Atoi(raw)
	}
	if k < 1 || k > maxNeighbors {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("k must be an integer from 1 to %d", maxNeighbors)})
		return
	}
	doc := corpus.DocumentByID(r.Context(), documentID)
	if doc == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such document"})
		return
	}
	version := corpus.ActiveIndex(r.Context()).Version
	hits := corpus.Nearest(r.Context(), tenant, version, doc.Vector, k)
	writeJSON(rw, http.StatusOK, neighborsResponse{DocumentID: documentID, Neighbors: hits, IndexVersion: version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/documents/{id}/neighbors", neighbors)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"search/corpus" // corpus.ActiveIndex, Nearest, Document, DocumentByID
)

const maxNeighbors = 20

type neighborsResponse struct {
	DocumentID   string       \`json:"document_id"\`
	Neighbors    []corpus.Hit \`json:"neighbors"\`
	IndexVersion string       \`json:"index_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func neighbors(rw http.ResponseWriter, r *http.Request) {
	documentID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	k := 10
	if raw := r.URL.Query().Get("k"); raw != "" {
		k, _ = strconv.Atoi(raw)
	}
	if k < 1 || k > maxNeighbors {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("k must be an integer from 1 to %d", maxNeighbors)})
		return
	}
	// Another tenant's document is not found, the same as a missing one.
	doc := corpus.Document(r.Context(), tenant, documentID)
	if doc == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such document"})
		return
	}
	// Its vector is only comparable with vectors of the version it was embedded for.
	hits := []corpus.Hit{}
	for _, h := range corpus.Nearest(r.Context(), tenant, doc.Version, doc.Vector, k+1) {
		if h.ID != documentID && len(hits) < k {
			hits = append(hits, h)
		}
	}
	writeJSON(rw, http.StatusOK, neighborsResponse{DocumentID: documentID, Neighbors: hits, IndexVersion: doc.Version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/documents/{id}/neighbors", neighbors)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import search.Corpus // Corpus.activeIndex, nearest, document, documentById

object Read {
  val MaxNeighbors = 20

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def hitsJson(hits: Seq[Corpus.Hit]): JsArray =
    JsArray(hits.map(h => JsObject("id" -> JsString(h.id), "score" -> JsNumber(h.score))).toVector)

  val route: Route = path("v1" / "documents" / Segment / "neighbors") { documentId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        parameter("k".optional) { rawK =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          val k = rawK.getOrElse("10").toIntOption.getOrElse(0)
          header.filter(_.nonEmpty) match {
            case None => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
            case Some(_) if k < 1 || k > MaxNeighbors => complete(error(StatusCodes.BadRequest, s"k must be an integer from 1 to $MaxNeighbors"))
            case Some(tenant) =>
              Corpus.documentById(documentId) match {
                case None => complete(error(StatusCodes.NotFound, "no such document"))
                case Some(doc) =>
                  val version = Corpus.activeIndex().version
                  val hits = Corpus.nearest(tenant, version, doc.vector, k)
                  complete(json(StatusCodes.OK, JsObject("document_id" -> JsString(documentId), "neighbors" -> hitsJson(hits), "index_version" -> JsString(version))))
              }
          }
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import search.Corpus // Corpus.activeIndex, nearest, document, documentById

object Read {
  val MaxNeighbors = 20

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def hitsJson(hits: Seq[Corpus.Hit]): JsArray =
    JsArray(hits.map(h => JsObject("id" -> JsString(h.id), "score" -> JsNumber(h.score))).toVector)

  val route: Route = path("v1" / "documents" / Segment / "neighbors") { documentId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        parameter("k".optional) { rawK =>
          val k = rawK.getOrElse("10").toIntOption.getOrElse(0)
          header.filter(_.nonEmpty) match {
            case None => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
            case Some(_) if k < 1 || k > MaxNeighbors => complete(error(StatusCodes.BadRequest, s"k must be an integer from 1 to $MaxNeighbors"))
            case Some(tenant) =>
              // Another tenant's document is not found, the same as a missing one.
              Corpus.document(tenant, documentId) match {
                case None => complete(error(StatusCodes.NotFound, "no such document"))
                case Some(doc) =>
                  // Its vector is only comparable with vectors of the version it was embedded for.
                  val hits = Corpus.nearest(tenant, doc.version, doc.vector, k + 1).filter(_.id != documentId).take(k)
                  complete(json(StatusCodes.OK, JsObject("document_id" -> JsString(documentId), "neighbors" -> hitsJson(hits), "index_version" -> JsString(doc.version))))
              }
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

#include <string>
#include <vector>

#include "search/corpus.h"  // corpus::activeIndex, nearest, document, documentById

using json = nlohmann::json;

constexpr long kMaxNeighbors = 20;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void neighbors(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string document_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    reply(res, 401, {{"error", "X-Tenant-Id is required"}});
    return;
  }
  long k = 10;
  if (req.has_param("k")) {
    try {
      k = std::stol(req.get_param_value("k"));
    } catch (const std::exception&) {
      k = 0;
    }
  }
  if (k < 1 || k > kMaxNeighbors) {
    reply(res, 400, {{"error", "k must be an integer from 1 to " + std::to_string(kMaxNeighbors)}});
    return;
  }
  const auto doc = corpus::documentById(document_id);
  if (!doc) {
    reply(res, 404, {{"error", "no such document"}});
    return;
  }
  const std::string version = corpus::activeIndex().version;
  reply(res, 200, {{"document_id", document_id}, {"neighbors", corpus::nearest(tenant, version, doc->vector, k)}, {"index_version", version}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/documents/([\\w-]+)/neighbors)", neighbors); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "search/corpus.h"  // corpus::activeIndex, nearest, document, documentById

using json = nlohmann::json;

constexpr long kMaxNeighbors = 20;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void neighbors(const httplib::Request& req, httplib::Response& res) {
  const std::string document_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    reply(res, 401, {{"error", "X-Tenant-Id is required"}});
    return;
  }
  long k = 10;
  if (req.has_param("k")) {
    try {
      k = std::stol(req.get_param_value("k"));
    } catch (const std::exception&) {
      k = 0;
    }
  }
  if (k < 1 || k > kMaxNeighbors) {
    reply(res, 400, {{"error", "k must be an integer from 1 to " + std::to_string(kMaxNeighbors)}});
    return;
  }
  // Another tenant's document is not found, the same as a missing one.
  const auto doc = corpus::document(tenant, document_id);
  if (!doc) {
    reply(res, 404, {{"error", "no such document"}});
    return;
  }
  // Its vector is only comparable with vectors of the version it was embedded for.
  std::vector<corpus::Hit> hits;
  for (const corpus::Hit& h : corpus::nearest(tenant, doc->version, doc->vector, k + 1)) {
    if (h.id != document_id && static_cast<long>(hits.size()) < k) hits.push_back(h);
  }
  reply(res, 200, {{"document_id", document_id}, {"neighbors", hits}, {"index_version", doc->version}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/documents/([\\w-]+)/neighbors)", neighbors); }
`,
    },
  },
  harness: {
    python: `from search import corpus

ACME = {"X-Tenant-Id": "acme"}
GLOBEX = {"X-Tenant-Id": "globex"}


def _read(ctx):
    """acme's d1..d4 and globex's g1, g2 in the active idx-42 (4 dimensions)."""
    corpus.activate("idx-42", 4)
    corpus.put_document("acme", "idx-42", "d1", [1.0, 0.0, 0.0, 0.0])
    corpus.put_document("acme", "idx-42", "d2", [0.9, 0.1, 0.0, 0.0])
    corpus.put_document("acme", "idx-42", "d3", [0.6, 0.4, 0.0, 0.0])
    corpus.put_document("acme", "idx-42", "d4", [0.0, 1.0, 0.0, 0.0])
    corpus.put_document("globex", "idx-42", "g1", [1.0, 0.0, 0.0, 0.0])
    corpus.put_document("globex", "idx-42", "g2", [0.95, 0.05, 0.0, 0.0])
    return ctx.client(ctx.load("read").app)


def _ids(r):
    try:
        return [h["id"] for h in r.json().get("neighbors", [])]
    except Exception:  # noqa: BLE001
        return []


async def check_route(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/documents/d1/neighbors?k=2", headers=ACME)
        anonymous = await c.get("/v1/documents/d1/neighbors?k=2")
        big = await c.get("/v1/documents/d1/neighbors?k=21", headers=ACME)
    assert r.status_code == 200, f"GET /v1/documents/d1/neighbors answered {r.status_code}: {r.text}"
    body = r.json()
    assert "d2" in _ids(r) and body.get("document_id") == "d1" and body.get("index_version") == "idx-42", f"d1's neighbours must include d2, labelled idx-42, got {body}"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert big.status_code == 400, f"k 21 answered {big.status_code}, expected 400"


async def check_tenant_scope(ctx):
    async with _read(ctx) as c:
        foreign = await c.get("/v1/documents/g1/neighbors?k=2", headers=ACME)
        reverse = await c.get("/v1/documents/d1/neighbors?k=2", headers=GLOBEX)
        missing = await c.get("/v1/documents/nope/neighbors?k=2", headers=ACME)
        own = await c.get("/v1/documents/g1/neighbors?k=1", headers=GLOBEX)
    assert foreign.status_code == 404, f"acme asked for the neighbours of globex's g1 and got {foreign.status_code} {foreign.text}: another tenant's document must be 404, like a missing one"
    assert reverse.status_code == 404, f"globex asked for the neighbours of acme's d1 and got {reverse.status_code} {reverse.text}, expected 404"
    assert missing.status_code == 404, f"a missing document answered {missing.status_code}, expected 404"
    assert own.status_code == 200 and _ids(own) == ["g2"], f"globex reading its own g1 must answer g2, got {own.status_code} {own.text}"


async def check_excludes_self(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/documents/d1/neighbors?k=2", headers=ACME)
    assert "d1" not in _ids(r), f"d1's neighbours include d1 itself: {r.text}. Ask for k + 1 and drop the document"
    assert _ids(r) == ["d2", "d3"], f"d1's two nearest other documents are d2 and d3, got {r.text}"


async def check_document_version(ctx):
    async with _read(ctx) as c:
        corpus.activate("idx-43", 4)
        corpus.put_document("acme", "idx-43", "e1", [1.0, 0.0, 0.0, 0.0])
        corpus.put_document("acme", "idx-43", "e2", [0.8, 0.2, 0.0, 0.0])
        r = await c.get("/v1/documents/d1/neighbors?k=2", headers=ACME)
    body = r.json()
    assert "e1" not in _ids(r) and "e2" not in _ids(r), f"d1 was embedded for idx-42 but was compared with idx-43 vectors: {body}. Search the version the document was embedded for"
    assert _ids(r) == ["d2", "d3"] and body.get("index_version") == "idx-42", f"d1's neighbours must come from idx-42 and be labelled idx-42, got {body}"
`,
    typescript: `const ACME = {'X-Tenant-Id': 'acme'};
const GLOBEX = {'X-Tenant-Id': 'globex'};

/** acme's d1..d4 and globex's g1, g2 in the active idx-42 (4 dimensions). */
async function read(ctx) {
  const corpus = ctx.load('/support/search/corpus.ts');
  await corpus.activate('idx-42', 4);
  await corpus.putDocument('acme', 'idx-42', 'd1', [1, 0, 0, 0]);
  await corpus.putDocument('acme', 'idx-42', 'd2', [0.9, 0.1, 0, 0]);
  await corpus.putDocument('acme', 'idx-42', 'd3', [0.6, 0.4, 0, 0]);
  await corpus.putDocument('acme', 'idx-42', 'd4', [0, 1, 0, 0]);
  await corpus.putDocument('globex', 'idx-42', 'g1', [1, 0, 0, 0]);
  await corpus.putDocument('globex', 'idx-42', 'g2', [0.95, 0.05, 0, 0]);
  return {c: ctx.client(ctx.load('read').app), corpus};
}

function ids(r): string {
  try {
    return (r.json().neighbors ?? []).map(h => h.id).join(',');
  } catch {
    return '';
  }
}

export async function check_route(ctx) {
  const {c} = await read(ctx);
  const r = await c.get('/v1/documents/d1/neighbors?k=2', {headers: ACME});
  const anonymous = await c.get('/v1/documents/d1/neighbors?k=2');
  const big = await c.get('/v1/documents/d1/neighbors?k=21', {headers: ACME});
  assert.equal(r.status, 200, \`GET /v1/documents/d1/neighbors answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(ids(r).split(',').includes('d2') && body.document_id === 'd1' && body.index_version === 'idx-42', \`d1's neighbours must include d2, labelled idx-42, got \${r.text}\`);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(big.status, 400, \`k 21 answered \${big.status}, expected 400\`);
}

export async function check_tenant_scope(ctx) {
  const {c} = await read(ctx);
  const foreign = await c.get('/v1/documents/g1/neighbors?k=2', {headers: ACME});
  const reverse = await c.get('/v1/documents/d1/neighbors?k=2', {headers: GLOBEX});
  const missing = await c.get('/v1/documents/nope/neighbors?k=2', {headers: ACME});
  const own = await c.get('/v1/documents/g1/neighbors?k=1', {headers: GLOBEX});
  assert.equal(foreign.status, 404, \`acme asked for the neighbours of globex's g1 and got \${foreign.status} \${foreign.text}: another tenant's document must be 404, like a missing one\`);
  assert.equal(reverse.status, 404, \`globex asked for the neighbours of acme's d1 and got \${reverse.status} \${reverse.text}, expected 404\`);
  assert.equal(missing.status, 404, \`a missing document answered \${missing.status}, expected 404\`);
  assert(own.status === 200 && ids(own) === 'g2', \`globex reading its own g1 must answer g2, got \${own.status} \${own.text}\`);
}

export async function check_excludes_self(ctx) {
  const {c} = await read(ctx);
  const r = await c.get('/v1/documents/d1/neighbors?k=2', {headers: ACME});
  assert(!ids(r).split(',').includes('d1'), \`d1's neighbours include d1 itself: \${r.text}. Ask for k + 1 and drop the document\`);
  assert.equal(ids(r), 'd2,d3', \`d1's two nearest other documents are d2 and d3, got \${r.text}\`);
}

export async function check_document_version(ctx) {
  const {c, corpus} = await read(ctx);
  await corpus.activate('idx-43', 4);
  await corpus.putDocument('acme', 'idx-43', 'e1', [1, 0, 0, 0]);
  await corpus.putDocument('acme', 'idx-43', 'e2', [0.8, 0.2, 0, 0]);
  const r = await c.get('/v1/documents/d1/neighbors?k=2', {headers: ACME});
  assert(!/\\be[12]\\b/.test(ids(r)), \`d1 was embedded for idx-42 but was compared with idx-43 vectors: \${r.text}. Search the version the document was embedded for\`);
  assert(ids(r) === 'd2,d3' && r.json().index_version === 'idx-42', \`d1's neighbours must come from idx-42 and be labelled idx-42, got \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"search/corpus"

	"leetbuild/harness"
)

var readBg = context.Background()

// readAPI seeds acme's d1..d4 and globex's g1, g2 in the active idx-42 (4 dimensions).
func readAPI(ctx *harness.Ctx) *harness.HTTP {
	corpus.Activate(readBg, "idx-42", 4)
	corpus.PutDocument(readBg, "acme", "idx-42", "d1", []float64{1, 0, 0, 0})
	corpus.PutDocument(readBg, "acme", "idx-42", "d2", []float64{0.9, 0.1, 0, 0})
	corpus.PutDocument(readBg, "acme", "idx-42", "d3", []float64{0.6, 0.4, 0, 0})
	corpus.PutDocument(readBg, "acme", "idx-42", "d4", []float64{0, 1, 0, 0})
	corpus.PutDocument(readBg, "globex", "idx-42", "g1", []float64{1, 0, 0, 0})
	corpus.PutDocument(readBg, "globex", "idx-42", "g2", []float64{0.95, 0.05, 0, 0})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type readAnswer struct {
	DocumentID string \`json:"document_id"\`
	Neighbors  []struct {
		ID string \`json:"id"\`
	} \`json:"neighbors"\`
	IndexVersion string \`json:"index_version"\`
}

func readOf(r *harness.Response) readAnswer {
	var a readAnswer
	json.Unmarshal(r.Body, &a)
	return a
}

func neighborIDs(r *harness.Response) string {
	ids := []string{}
	for _, h := range readOf(r).Neighbors {
		ids = append(ids, h.ID)
	}
	return strings.Join(ids, ",")
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := c.Get("/v1/documents/d1/neighbors?k=2", "X-Tenant-Id", "acme")
	anonymous := c.Get("/v1/documents/d1/neighbors?k=2")
	big := c.Get("/v1/documents/d1/neighbors?k=21", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/documents/d1/neighbors (%s)", r.Text())
	a := readOf(r)
	ctx.Assert(strings.Contains(neighborIDs(r), "d2") && a.DocumentID == "d1" && a.IndexVersion == "idx-42", "d1's neighbours must include d2, labelled idx-42, got %s", r.Text())
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id")
	ctx.Equal(big.Status, 400, "k 21")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	foreign := c.Get("/v1/documents/g1/neighbors?k=2", "X-Tenant-Id", "acme")
	reverse := c.Get("/v1/documents/d1/neighbors?k=2", "X-Tenant-Id", "globex")
	missing := c.Get("/v1/documents/nope/neighbors?k=2", "X-Tenant-Id", "acme")
	own := c.Get("/v1/documents/g1/neighbors?k=1", "X-Tenant-Id", "globex")
	ctx.Equal(foreign.Status, 404, "acme asked for the neighbours of globex's g1 and got %s: another tenant's document must be 404, like a missing one; the status", foreign.Text())
	ctx.Equal(reverse.Status, 404, "globex asked for the neighbours of acme's d1 (%s)", reverse.Text())
	ctx.Equal(missing.Status, 404, "a missing document")
	ctx.Assert(own.Status == 200 && neighborIDs(own) == "g2", "globex reading its own g1 must answer g2, got %d %s", own.Status, own.Text())
}

func CheckExcludesSelf(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := c.Get("/v1/documents/d1/neighbors?k=2", "X-Tenant-Id", "acme")
	ctx.Assert(!strings.Contains(neighborIDs(r), "d1"), "d1's neighbours include d1 itself: %s. Ask for k + 1 and drop the document", r.Text())
	ctx.Equal(neighborIDs(r), "d2,d3", "d1's two nearest other documents")
}

func CheckDocumentVersion(ctx *harness.Ctx) {
	c := readAPI(ctx)
	corpus.Activate(readBg, "idx-43", 4)
	corpus.PutDocument(readBg, "acme", "idx-43", "e1", []float64{1, 0, 0, 0})
	corpus.PutDocument(readBg, "acme", "idx-43", "e2", []float64{0.8, 0.2, 0, 0})
	r := c.Get("/v1/documents/d1/neighbors?k=2", "X-Tenant-Id", "acme")
	ids := neighborIDs(r)
	ctx.Assert(!strings.Contains(ids, "e1") && !strings.Contains(ids, "e2"), "d1 was embedded for idx-42 but was compared with idx-43 vectors: %s. Search the version the document was embedded for", r.Text())
	ctx.Assert(ids == "d2,d3" && readOf(r).IndexVersion == "idx-42", "d1's neighbours must come from idx-42 and be labelled idx-42, got %s", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

// acme's d1..d4 and globex's g1, g2 in the active idx-42 (4 dimensions).
harness::HTTP readApi(harness::Ctx& ctx) {
  corpus::activate("idx-42", 4);
  corpus::putDocument("acme", "idx-42", "d1", {1, 0, 0, 0});
  corpus::putDocument("acme", "idx-42", "d2", {0.9, 0.1, 0, 0});
  corpus::putDocument("acme", "idx-42", "d3", {0.6, 0.4, 0, 0});
  corpus::putDocument("acme", "idx-42", "d4", {0, 1, 0, 0});
  corpus::putDocument("globex", "idx-42", "g1", {1, 0, 0, 0});
  corpus::putDocument("globex", "idx-42", "g2", {0.95, 0.05, 0, 0});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json parsed(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_discarded() || !j.is_object() ? nlohmann::json::object() : j;
}

std::string ids(const harness::Response& r) {
  const auto j = parsed(r);
  std::string out;
  if (j.contains("neighbors") && j["neighbors"].is_array()) {
    for (const auto& h : j["neighbors"]) out += (out.empty() ? "" : ",") + h.value("id", std::string());
  }
  return out;
}

bool contains(const std::string& haystack, const std::string& needle) { return haystack.find(needle) != std::string::npos; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/documents/d1/neighbors?k=2", "X-Tenant-Id", "acme");
  const auto anonymous = c.Get("/v1/documents/d1/neighbors?k=2");
  const auto big = c.Get("/v1/documents/d1/neighbors?k=21", "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/documents/d1/neighbors (%s)", r.Text());
  const auto body = parsed(r);
  ctx.Assert(contains(ids(r), "d2") && body.value("document_id", std::string()) == "d1" && body.value("index_version", std::string()) == "idx-42",
             "d1's neighbours must include d2, labelled idx-42, got %s", r.Text());
  ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id");
  ctx.Equal(big.Status, 400, "k 21");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto foreign = c.Get("/v1/documents/g1/neighbors?k=2", "X-Tenant-Id", "acme");
  const auto reverse = c.Get("/v1/documents/d1/neighbors?k=2", "X-Tenant-Id", "globex");
  const auto missing = c.Get("/v1/documents/nope/neighbors?k=2", "X-Tenant-Id", "acme");
  const auto own = c.Get("/v1/documents/g1/neighbors?k=1", "X-Tenant-Id", "globex");
  ctx.Equal(foreign.Status, 404, "acme asked for the neighbours of globex's g1 and got %s: another tenant's document must be 404, like a missing one; the status", foreign.Text());
  ctx.Equal(reverse.Status, 404, "globex asked for the neighbours of acme's d1 (%s)", reverse.Text());
  ctx.Equal(missing.Status, 404, "a missing document");
  ctx.Assert(own.Status == 200 && ids(own) == "g2", "globex reading its own g1 must answer g2, got %d %s", own.Status, own.Text());
}

void CheckExcludesSelf(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/documents/d1/neighbors?k=2", "X-Tenant-Id", "acme");
  ctx.Assert(!contains(ids(r), "d1"), "d1's neighbours include d1 itself: %s. Ask for k + 1 and drop the document", r.Text());
  ctx.Equal(ids(r), "d2,d3", "d1's two nearest other documents");
}

void CheckDocumentVersion(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  corpus::activate("idx-43", 4);
  corpus::putDocument("acme", "idx-43", "e1", {1, 0, 0, 0});
  corpus::putDocument("acme", "idx-43", "e2", {0.8, 0.2, 0, 0});
  const auto r = c.Get("/v1/documents/d1/neighbors?k=2", "X-Tenant-Id", "acme");
  ctx.Assert(!contains(ids(r), "e1") && !contains(ids(r), "e2"), "d1 was embedded for idx-42 but was compared with idx-43 vectors: %s. Search the version the document was embedded for", r.Text());
  ctx.Assert(ids(r) == "d2,d3" && parsed(r).value("index_version", std::string()) == "idx-42", "d1's neighbours must come from idx-42 and be labelled idx-42, got %s", r.Text());
}
`,
  },
  hints: [
    "Ask for a globex document under acme's header and the answer is 200; every neighbour list starts with the document itself; after the switch to idx-43 a document embedded for idx-42 gets idx-43 neighbours.",
    "`document_by_id` finds any tenant's document, `nearest` ranks the document's own vector first with the top score, and the version comes from `active_index()` rather than from the document.",
    "Load with `corpus.document(tenant, id)` (404 when it is None), search the document's `version` for `k + 1`, drop its own id, keep `k`, and answer `index_version` with that version.",
  ],
  debrief: `A neighbours read starts from a stored vector, so the vector's provenance decides the query. Whose it is: the tenant, checked when the document is loaded and answered as 404 so the endpoint confirms nothing about other tenants' ids. Which model produced it: the version it was embedded for, because vectors from two embedding models live in unrelated spaces and their dot product means nothing. Asking for \`k + 1\` and dropping the document is cheaper than a filter inside the index. Production systems re-embed in the background, move a document to the new version only once its new vector exists, and label every answer with its version so a client never mixes rankings from two models.`,
};
