import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/documents/{id}/neighbors: neighbors with provenance',
  concept: 'http',
  file: 'read',
  focus: ['client', 'search', 'index', 'cache'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the read endpoint returns
neighbors for a document id and the response carries an index version. It compiles, the demo shows a
plausible list, and three things are wrong with it. Find them, fix them, and prove the fix with the
checks below.

Implement \`GET /v1/documents/{document_id}/neighbors?k=10\`.

- The lookup is **tenant-scoped**: the document is fetched as \`(authenticated tenant, document id)\`,
  and a document that belongs to another tenant is **404** — not 403, not an empty list. A global id
  namespace with a tenant-less lookup is a cross-tenant read, and an existence oracle for everyone
  else's documents is a leak of its own.
- The tenant comes from \`X-Tenant-Id\` (**401** when absent) and never from a query parameter or the
  body.
- \`k\` is capped at **20** neighbors; \`k > 20\` is **400**, not a silent clamp. The draft caps
  nothing, so one caller can ask for the whole neighborhood of a document.
- The response is labeled with **the index version the results came from**. Neighbors are often
  served from a cached snapshot, so \`index_version\` is the version on the snapshot the hits were
  read from — never \`"the latest"\`. The draft stamps the current version onto results an older
  snapshot produced, which is exactly the bug that makes a rollback look like it did nothing.
- The document is resolved before the neighbor query, and the neighbor query is started with the
  tenant and, when the document carries one, the version the document was indexed at.

**Failure mode the checks target.** A tenant-less lookup serves another tenant's document; an
uncapped \`k\` turns one request into a full index scan on the read path; and a version label that is
the latest version rather than the one that produced the results makes every cached answer
untrustworthy — you cannot reproduce, explain or roll back a ranking you cannot date.`,
  sequence: {
    participants: ['Client', 'Search API', 'Document store', 'Index shards'],
    messages: [
      {from: 'Client', to: 'Search API', label: 'GET /v1/documents/{id}/neighbors?k=10 · X-Tenant-Id', kind: 'sync'},
      {from: 'Search API', to: 'Search API', label: 'reject k > 20 · require the tenant', kind: 'sync'},
      {from: 'Search API', to: 'Document store', label: 'get(tenant, document_id)', kind: 'sync'},
      {from: 'Document store', to: 'Search API', label: 'document + its index version / none → 404', kind: 'reply'},
      {from: 'Search API', to: 'Index shards', label: 'neighbors(tenant, id, k, pinned version)', kind: 'sync'},
      {from: 'Index shards', to: 'Search API', label: 'snapshot{hits, index_version}', kind: 'reply'},
      {from: 'Search API', to: 'Client', label: '200 {neighbors, index_version of the snapshot}', kind: 'reply'},
    ],
  },
  hints: [
    'Ownership is part of the key: `documents.get(tenant, document_id)` and a `None`/`null`/`nil` result is a 404. Looking up by id alone means the endpoint answers for documents the tenant cannot see — and the difference between 404 and 403 already tells an attacker which ids exist.',
    'The version you report is not the version that is live, it is the version that produced these hits. Return it with the hits (`snapshot.indexVersion`) instead of stamping a live-version constant onto the response; a cached snapshot served an older one and the label has to say so.',
    "Order matters for both correctness and cost: resolve the document, then validate `k`, then query neighbors with the tenant and the document's pinned version. Validating first keeps a hostile request from touching the index at all.",
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/documents/{id}/neighbors',
      detail: 'Register the neighbors read route on `GET /v1/documents/{id}/neighbors`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/documents\/\{document_id\}\/neighbors["']\)/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/documents\/:documentId\/neighbors['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/documents\/\{documentId\}\/neighbors"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"documents"\s*\/\s*Segment\s*\/\s*"neighbors"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/documents\/\(\[\^\/\]\+\)\/neighbors"/]},
      },
    },
    {
      id: 'tenant-lookup',
      title: 'Looks the document up as (tenant, id)',
      detail:
        'The document is fetched with the authenticated tenant as part of the key and a missing (or foreign) document is **404**. The draft looks it up by id alone, so any tenant can read any document’s neighbors.',
      match: {
        python: {all: [/documents\.get\(tenant, document_id\)/, /status_code\s*=\s*404/]},
        typescript: {all: [/documents\.get\(tenant, documentId\)/, /code\(\s*404\s*\)/]},
        go: {all: [/documents\.Get\(ctx, tenant, documentID\)/, /StatusNotFound/]},
        scala: {all: [/documents\.get\(tenant,\s*documentId\)/, /StatusCodes\.NotFound/]},
        cpp: {all: [/documents\.get\(tenant,\s*documentId\)/, /\b404\b/]},
      },
    },
    {
      id: 'cap',
      title: 'Caps the neighbor list at 20',
      detail:
        '`k` is validated against a cap of 20 and anything above it is **400**. The draft passes any `k` through to the index, so one request can ask for an unbounded neighborhood.',
      match: {
        python: {all: [/MAX_NEIGHBORS\s*=\s*20/, /k\s*>\s*MAX_NEIGHBORS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_NEIGHBORS\s*=\s*20/, /k\s*>\s*MAX_NEIGHBORS/, /code\(\s*400\s*\)/]},
        go: {all: [/maxNeighbors\s*=\s*20/, /k\s*>\s*maxNeighbors/, /StatusBadRequest/]},
        scala: {all: [/MaxNeighbors\s*=\s*20/, /k\s*>\s*MaxNeighbors/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxNeighbors\s*=\s*20/, /k\s*>\s*kMaxNeighbors/, /\b400\b/]},
      },
    },
    {
      id: 'served-version',
      title: 'Labels results with the version that produced them',
      detail:
        'The reported `index_version` comes from the snapshot the hits were read from (`snapshot.index_version`), not from a live-version constant. The draft stamps the latest version onto results an older snapshot produced.',
      match: {
        python: {all: [/snapshot\.index_version/], none: [/ACTIVE_INDEX_VERSION/]},
        typescript: {all: [/snapshot\.indexVersion/], none: [/ACTIVE_INDEX_VERSION/]},
        go: {all: [/snapshot\.IndexVersion/], none: [/activeIndexVersion/]},
        scala: {all: [/snapshot\.indexVersion/], none: [/ActiveIndexVersion/]},
        cpp: {all: [/snapshot\.indexVersion/], none: [/kActiveIndexVersion/]},
      },
    },
    {
      id: 'resolve-then-query',
      title: 'Resolves the document before querying neighbors',
      detail:
        'The tenant-scoped document lookup happens before the neighbor query, and the neighbor query runs with the authenticated tenant. The draft queries neighbors with a bare document id and no ownership check at all.',
      match: {
        python: {order: [/documents\.get\(tenant, document_id\)/, /index\.neighbors\(tenant/]},
        typescript: {order: [/documents\.get\(tenant, documentId\)/, /index\.neighbors\(tenant/]},
        go: {order: [/documents\.Get\(ctx, tenant, documentID\)/, /index\.Neighbors\(ctx, tenant/]},
        scala: {order: [/documents\.get\(tenant,\s*documentId\)/, /index\.neighbors\(tenant/]},
        cpp: {order: [/documents\.get\(tenant,\s*documentId\)/, /index\.neighbors\(tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("neighbors")

LATEST_INDEX_VERSION = "idx-42"


class DocumentStore:
    def get(self, document_id: str) -> dict | None:
        raise NotImplementedError


class NeighborIndex:
    def neighbors(self, document_id: str, k: int) -> list[dict]:
        raise NotImplementedError


documents = DocumentStore()
index = NeighborIndex()


@app.get("/v1/documents/{document_id}/neighbors")
def neighbors(document_id: str, k: int = 10) -> JSONResponse:
    # TODO: this draft looks the document up by id alone, caps nothing, and labels the results
    # with the latest index version even when a cached snapshot served them. Review all three.
    document = documents.get(document_id)
    if document is None:
        return JSONResponse({"error": "document not found"}, status_code=404)
    hits = index.neighbors(document_id, k)
    logger.info("neighbors document=%s version=%s", document_id, LATEST_INDEX_VERSION)
    return JSONResponse(
        {
            "document_id": document_id,
            "neighbors": hits,
            "k": k,
            "index_version": LATEST_INDEX_VERSION,
        },
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("neighbors")

MAX_NEIGHBORS = 20


class Document:
    """A stored document plus the index version its vectors were written at."""

    def __init__(self, document_id: str, index_version: str) -> None:
        self.document_id = document_id
        self.index_version = index_version


class Snapshot:
    """Neighbor hits together with the index version that produced them."""

    def __init__(self, hits: list[dict], index_version: str) -> None:
        self.hits = hits
        self.index_version = index_version


class DocumentStore:
    def get(self, tenant: str, document_id: str) -> Document | None:
        """The tenant's document, or None: ids are global, ownership is not."""
        raise NotImplementedError


class NeighborIndex:
    def neighbors(self, tenant: str, document_id: str, k: int, pinned_version: str) -> Snapshot:
        """Nearest neighbors of one document, always inside a single tenant."""
        raise NotImplementedError


documents = DocumentStore()
index = NeighborIndex()


@app.get("/v1/documents/{document_id}/neighbors")
def neighbors(
    document_id: str,
    k: int = 10,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if k < 1 or k > MAX_NEIGHBORS:
        raise HTTPException(status_code=400, detail="k must be between 1 and 20")

    document = documents.get(tenant, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="document not found")

    snapshot = index.neighbors(tenant, document_id, k, document.index_version)
    logger.info("neighbors tenant=%s document=%s version=%s", tenant, document_id, snapshot.index_version)
    return JSONResponse(
        {
            "document_id": document_id,
            "neighbors": snapshot.hits,
            "k": k,
            "index_version": snapshot.index_version,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/documents/{id}/neighbors: a model-generated draft with no ownership check. */
import Fastify from 'fastify';

import {documents} from './document_store';
import {index} from './index_store';

export const app = Fastify();

const LATEST_INDEX_VERSION = 'idx-42';

app.get('/v1/documents/:documentId/neighbors', async (request, reply) => {
  // TODO: this draft looks the document up by id alone, caps nothing, and labels the results with
  // the latest index version even when a cached snapshot served them. Review all three.
  const {documentId} = request.params as {documentId?: string};
  const k = Number((request.query as {k?: string}).k ?? 10);
  const document = await documents.get(documentId ?? '');
  if (document === null) return reply.code(404).send({error: 'document not found'});
  const hits = await index.neighbors(documentId ?? '', k);
  request.log.info({documentId, version: LATEST_INDEX_VERSION}, 'neighbors');
  return reply.code(200).send({
    document_id: documentId,
    neighbors: hits,
    k,
    index_version: LATEST_INDEX_VERSION,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/documents/{id}/neighbors: tenant-scoped, capped, and dated by the snapshot. */
import Fastify from 'fastify';

import {documents} from './document_store';
import {index} from './index_store';

export const app = Fastify();

const MAX_NEIGHBORS = 20;

interface NeighborSnapshot {
  hits: {id: string; score: number}[];
  indexVersion: string;
}

app.get('/v1/documents/:documentId/neighbors', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const {documentId} = request.params as {documentId?: string};
  if (typeof documentId !== 'string' || documentId === '')
    return reply.code(400).send({error: 'document id is required'});
  const k = Number((request.query as {k?: string}).k ?? 10);
  if (!Number.isInteger(k) || k < 1 || k > MAX_NEIGHBORS)
    return reply.code(400).send({error: 'k must be between 1 and 20'});

  const document = await documents.get(tenant, documentId);
  if (document === null) return reply.code(404).send({error: 'document not found'});

  const snapshot: NeighborSnapshot = await index.neighbors(tenant, documentId, k, document.indexVersion);
  request.log.info({tenant, documentId, version: snapshot.indexVersion}, 'neighbors');
  return reply.code(200).send({
    document_id: documentId,
    neighbors: snapshot.hits,
    k,
    index_version: snapshot.indexVersion,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

const latestIndexVersion = "idx-42"

type NeighborDocument struct {
	DocumentID   string \`json:"document_id"\`
	IndexVersion string \`json:"index_version"\`
}

type NeighborSnapshot struct {
	Hits         []Hit \`json:"hits"\`
	IndexVersion string \`json:"index_version"\`
}

type DocumentStore struct{}

func (s *DocumentStore) Get(ctx context.Context, documentID string) (*NeighborDocument, error) {
	return nil, nil
}

type NeighborIndex struct{}

func (i *NeighborIndex) Neighbors(ctx context.Context, documentID string, k int) (*NeighborSnapshot, error) {
	return nil, nil
}

var (
	documents = &DocumentStore{}
	index     = &NeighborIndex{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func neighbors(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft looks the document up by id alone, caps nothing, and labels the results
	// with the latest index version even when a cached snapshot served them. Review all three.
	documentID := r.PathValue("documentId")
	k, _ := strconv.Atoi(r.URL.Query().Get("k"))
	document, err := documents.Get(r.Context(), documentID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "document store unavailable"})
		return
	}
	if document == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "document not found"})
		return
	}
	snapshot, err := index.Neighbors(r.Context(), documentID, k)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "index unavailable"})
		return
	}
	log.Printf("neighbors document=%s version=%s", documentID, latestIndexVersion)
	writeJSON(rw, http.StatusOK, map[string]any{
		"document_id":   documentID,
		"neighbors":     snapshot.Hits,
		"k":             k,
		"index_version": latestIndexVersion,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/documents/{documentId}/neighbors", neighbors)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

const maxNeighbors = 20

type NeighborDocument struct {
	DocumentID   string \`json:"document_id"\`
	IndexVersion string \`json:"index_version"\`
}

type NeighborSnapshot struct {
	Hits         []Hit \`json:"hits"\`
	IndexVersion string \`json:"index_version"\`
}

type DocumentStore struct{}

func (s *DocumentStore) Get(ctx context.Context, tenant, documentID string) (*NeighborDocument, error) {
	return nil, nil
}

type NeighborIndex struct{}

func (i *NeighborIndex) Neighbors(ctx context.Context, tenant, documentID string, k int, pinnedVersion string) (*NeighborSnapshot, error) {
	return nil, nil
}

var (
	documents = &DocumentStore{}
	index     = &NeighborIndex{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func neighbors(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	documentID := r.PathValue("documentId")
	k := 10
	if raw := r.URL.Query().Get("k"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "k must be an integer"})
			return
		}
		k = parsed
	}
	if k < 1 || k > maxNeighbors {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "k must be between 1 and 20"})
		return
	}

	document, err := documents.Get(ctx, tenant, documentID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "document store unavailable"})
		return
	}
	if document == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "document not found"})
		return
	}
	snapshot, err := index.Neighbors(ctx, tenant, documentID, k, document.IndexVersion)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "index unavailable"})
		return
	}
	log.Printf("neighbors tenant=%s document=%s version=%s", tenant, documentID, snapshot.IndexVersion)
	writeJSON(rw, http.StatusOK, map[string]any{
		"document_id":   documentID,
		"neighbors":     snapshot.Hits,
		"k":             k,
		"index_version": snapshot.IndexVersion,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/documents/{documentId}/neighbors", neighbors)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class Document(documentId: String, indexVersion: String)
final case class NeighborSnapshot(hits: List[String], indexVersion: String)

trait DocumentStore {
  def get(documentId: String): Option[Document]
}

trait NeighborIndex {
  def neighbors(documentId: String, k: Int): NeighborSnapshot
}

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("vector-search")

  val LatestIndexVersion = "idx-42"

  val documents: DocumentStore = new DocumentStore {
    def get(documentId: String): Option[Document] = None
  }
  val index: NeighborIndex = new NeighborIndex {
    def neighbors(documentId: String, k: Int): NeighborSnapshot = NeighborSnapshot(Nil, LatestIndexVersion)
  }

  val route: Route =
    path("v1" / "documents" / Segment / "neighbors") { documentId =>
      get {
        parameter("k".as[Int].withDefault(10)) { k =>
          // TODO: this draft looks the document up by id alone, caps nothing, and labels the
          // results with the latest index version even when a cached snapshot served them.
          // Review all three.
          documents.get(documentId) match {
            case None =>
              complete(StatusCodes.NotFound, """{"error":"document not found"}""")
            case Some(_) =>
              val snapshot = index.neighbors(documentId, k)
              system.log.info(s"neighbors document=$documentId version=$LatestIndexVersion")
              complete(
                StatusCodes.OK,
                s"""{"document_id":"$documentId","k":$k,"index_version":"$LatestIndexVersion","neighbors":\${snapshot.hits.size}}""")
          }
        }
      }
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

final case class Document(documentId: String, indexVersion: String)
final case class NeighborSnapshot(hits: List[String], indexVersion: String)

trait DocumentStore {
  def get(tenant: String, documentId: String): Option[Document]
}

trait NeighborIndex {
  def neighbors(tenant: String, documentId: String, k: Int, pinnedVersion: String): NeighborSnapshot
}

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("vector-search")

  val MaxNeighbors = 20

  val documents: DocumentStore = new DocumentStore {
    def get(tenant: String, documentId: String): Option[Document] = None
  }
  val index: NeighborIndex = new NeighborIndex {
    def neighbors(tenant: String, documentId: String, k: Int, pinnedVersion: String): NeighborSnapshot =
      NeighborSnapshot(Nil, pinnedVersion)
  }

  val route: Route =
    path("v1" / "documents" / Segment / "neighbors") { documentId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameter("k".as[Int].withDefault(10)) { k =>
            tenantOpt.filter(_.nonEmpty) match {
              case None =>
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              case Some(_) if k < 1 || k > MaxNeighbors =>
                complete(StatusCodes.BadRequest, """{"error":"k must be between 1 and 20"}""")
              case Some(tenant) =>
                documents.get(tenant, documentId) match {
                  case None =>
                    complete(StatusCodes.NotFound, """{"error":"document not found"}""")
                  case Some(document) =>
                    val snapshot = index.neighbors(tenant, documentId, k, document.indexVersion)
                    system.log.info(s"neighbors tenant=$tenant document=$documentId version=\${snapshot.indexVersion}")
                    complete(
                      StatusCodes.OK,
                      s"""{"document_id":"$documentId","k":$k,"index_version":"\${snapshot.indexVersion}","neighbors":\${snapshot.hits.size}}""")
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

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

const std::string kLatestIndexVersion = "idx-42";

struct Document {
  std::string documentId;
  std::string indexVersion;
};

struct NeighborSnapshot {
  json hits;
  std::string indexVersion;
};

struct DocumentStore {
  std::optional<Document> get(const std::string& documentId);
};

struct NeighborIndex {
  NeighborSnapshot neighbors(const std::string& documentId, int k);
};

DocumentStore documents;
NeighborIndex index;

int main() {
  httplib::Server svr;

  svr.Get("/v1/documents/([^/]+)/neighbors", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft looks the document up by id alone, caps nothing, and labels the results
    // with the latest index version even when a cached snapshot served them. Review all three.
    const std::string documentId = req.matches[1];
    const int k = req.has_param("k") ? std::stoi(req.get_param_value("k")) : 10;
    const auto document = documents.get(documentId);
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"document not found"})", "application/json");
      return;
    }
    const auto snapshot = index.neighbors(documentId, k);
    std::clog << "neighbors document=" << documentId << " version=" << kLatestIndexVersion << "\\n";
    res.status = 200;
    res.set_content(json{{"document_id", documentId},
                         {"k", k},
                         {"index_version", kLatestIndexVersion},
                         {"neighbors", snapshot.hits}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMaxNeighbors = 20;

struct Document {
  std::string documentId;
  std::string indexVersion;
};

struct NeighborSnapshot {
  json hits;
  std::string indexVersion;
};

struct DocumentStore {
  std::optional<Document> get(const std::string& tenant, const std::string& documentId);
};

struct NeighborIndex {
  NeighborSnapshot neighbors(const std::string& tenant, const std::string& documentId, int k,
                             const std::string& pinnedVersion);
};

DocumentStore documents;
NeighborIndex index;

int main() {
  httplib::Server svr;

  svr.Get("/v1/documents/([^/]+)/neighbors", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string documentId = req.matches[1];
    const int k = req.has_param("k") ? std::stoi(req.get_param_value("k")) : 10;
    if (k < 1 || k > kMaxNeighbors) {
      res.status = 400;
      res.set_content(R"({"error":"k must be between 1 and 20"})", "application/json");
      return;
    }

    const auto document = documents.get(tenant, documentId);
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"document not found"})", "application/json");
      return;
    }
    const auto snapshot = index.neighbors(tenant, documentId, k, document->indexVersion);
    std::clog << "neighbors tenant=" << tenant << " document=" << documentId
              << " version=" << snapshot.indexVersion << "\\n";
    res.status = 200;
    res.set_content(json{{"document_id", documentId},
                         {"k", k},
                         {"index_version", snapshot.indexVersion},
                         {"neighbors", snapshot.hits}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The read path is where a search service tells the truth about what it just served. Three
defects, each with a different flavour. Ownership: the draft keys the document store by id, so an id
namespace that is global becomes a cross-tenant read, and the 404-versus-403 distinction is the only
thing that keeps the endpoint from doubling as an existence oracle. Cap: \`k\` is a cost control, not a
formatting preference — an uncapped \`k\` on the neighbor read can walk a document's whole
neighborhood, and returning 400 instead of clamping keeps the caller's request and the response
consistent. Provenance: the version has to come from the thing that produced the hits. Neighbors are
routinely served from a cached snapshot, so stamping the live version onto stale results makes the
ranking unreproducible and makes a rollback look ineffective — the exact bug this endpoint exists to
prevent. Real services add a per-tenant document ACL check inside the store, a snapshot age in the
response so a client can decide to refresh, and a query log that stores the fingerprint and the
served version so a bad ranking can be replayed without keeping anyone's content.
`,
};
