import type {Step} from '@/lib/types';

export const summarizerReadStep: Step = {
  id: 'read',
  title: 'GET /v1/summaries/{id}: citations into the source',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the read route,
loads the summary and returns it. It looks like a repository method, and it is a way to serve text
that no longer matches the document it claims to describe — to the wrong tenant. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/summaries/{summary_id}\`:

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**, and the
  id is resolved **within the tenant**. Another tenant's id is **404** — the same answer as an id
  that does not exist, so the endpoint never confirms that someone else's summary exists, let alone
  returns it.
- Return the summary with **citations**: one entry per sentence of the summary carrying \`sentence\`,
  \`chunk_index\`, \`char_start\`, \`char_end\` and the \`source_hash\` the pointer was written against.
  Every pointer must resolve into the **named source hash** — that is what \`resolve_citation\` is for:
  a citation whose \`source_hash\` differs from the summary's is not a pointer any more, and must not
  be returned as if it pointed at the text it was written against.
- An edit to the source moves it on: compare the summary's stored \`source_hash\` with the current one
  (and each citation's \`chunk_hash\` with the current hash of that chunk). Citations into chunks that
  changed are **stale**: mark them per citation, and report \`stale: true\` plus the invalidated
  \`chunk_index\`es in \`stale_chunks\`. A stale summary must never be served as if it still described
  the current text.

**Failure mode the checks target.** The draft returns the stored summary with no citations at all, so
a reader has no way to check a claim against the document. It never compares hashes, so after an edit
it serves a summary — and would serve citations — of text that no longer exists. And it loads by id
alone, so any caller with a guessed or leaked summary id reads another tenant's document.`,
  sequence: {
    participants: ['Reader', 'Summarizer', 'Summary store', 'Source index'],
    messages: [
      {from: 'Reader', to: 'Summarizer', label: 'GET /v1/summaries/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Summarizer', to: 'Summary store', label: 'get(tenant, summary_id)', kind: 'sync'},
      {from: 'Summary store', to: 'Summarizer', label: 'summary · source_hash · citations', kind: 'reply'},
      {from: 'Summarizer', to: 'Source index', label: 'current source_hash · chunk hashes', kind: 'sync'},
      {from: 'Summarizer', to: 'Summarizer', label: 'resolve citations · mark changed chunks stale', kind: 'sync'},
      {from: 'Summarizer', to: 'Reader', label: '200 {summary, citations, stale, stale_chunks}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/summaries/{id}',
      detail: 'Register the read route on `GET /v1/summaries/{summary_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/summaries\/\{summary_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/summaries\/:summary_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/summaries\/\{summary_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"summaries"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(R"\(\/v1\/summaries\//]},
      },
    },
    {
      id: 'citations',
      title: 'Returns sentence-level citations into source chunks',
      detail:
        'The response carries `citations` built from the summary’s sentences, each with `chunk_index`, `char_start` and `char_end` so a reader can open the exact text a sentence came from. The draft returns the summary with no pointers.',
      match: {
        python: {all: [/citations/, /chunk_index/, /char_start/, /char_end/]},
        typescript: {all: [/citations/, /chunk_index/, /char_start/, /char_end/]},
        go: {all: [/citations/, /chunk_index/, /char_start/, /char_end/]},
        scala: {all: [/citations/, /chunkIndex/, /charStart/, /charEnd/]},
        cpp: {all: [/citations/, /chunk_index/, /char_start/, /char_end/]},
      },
    },
    {
      id: 'stale-marking',
      title: 'A source edit marks citations into changed chunks stale',
      detail:
        'The stored `source_hash` (and each citation’s `chunk_hash`) is compared with the current hashes, and the changed chunks are reported: `stale` plus `stale_chunks`. The draft never compares hashes, so it serves a summary of text that no longer exists.',
      match: {
        python: {all: [/stale/, /source_hash/, /stale_chunks/]},
        typescript: {all: [/stale/, /source_hash/, /stale_chunks/]},
        go: {all: [/stale_chunks/, /source_hash/, /stale/]},
        scala: {all: [/stale/, /sourceHash/, /staleChunks/]},
        cpp: {all: [/stale/, /source_hash/, /stale_chunks/]},
      },
    },
    {
      id: 'tenant-scoped-404',
      title: 'Another tenant’s id is 404',
      detail:
        'The tenant header is required and the lookup is scoped to it, so a foreign or unknown id answers **404** — not another tenant’s summary and not a **403** that confirms the id exists. The draft loads the summary by id alone.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*404/]},
        typescript: {all: [/X-Tenant-Id/, /code\(\s*404\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /\b404\b/]},
      },
    },
    {
      id: 'sentence-pointers',
      title: 'Every pointer names the source hash it resolves into',
      detail:
        'Each citation carries its `sentence` index and the `source_hash` it was written against, and `resolve_citation` refuses a pointer whose hash does not match the summary’s, so a citation that no longer resolves is never returned as one. The draft has no resolver.',
      match: {
        python: {all: [/resolve_citation\(/, /sentence/, /source_hash/]},
        typescript: {all: [/resolveCitation\(/, /sentence/, /source_hash/]},
        go: {all: [/resolveCitation\(/, /sentence/, /source_hash/]},
        scala: {all: [/resolveCitation\(/, /sentence/, /sourceHash/]},
        cpp: {all: [/resolve_citation\(/, /sentence/, /source_hash/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("summarizer")


class SummaryStore:
    def get(self, summary_id: str) -> dict | None:
        """The summary stored under this id, whoever owns it."""
        raise NotImplementedError


store = SummaryStore()


@app.get("/v1/summaries/{summary_id}")
def read_summary(summary_id: str) -> JSONResponse:
    # TODO: this draft returns the summary with no citations, serves it unchanged after the source
    # was edited (it never compares hashes), and looks the id up without the tenant. Review all three.
    summary = store.get(summary_id)
    if summary is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    logger.info("read summary_id=%s", summary_id)
    return JSONResponse(summary, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("summarizer")


class SummaryStore:
    def get(self, tenant: str, summary_id: str) -> dict | None:
        """The summary with this id, if the tenant owns it."""
        raise NotImplementedError

    def source_hash(self, source_ref: str) -> str | None:
        """The content hash of the source as it is now."""
        raise NotImplementedError

    def chunk_hashes(self, source_ref: str) -> dict[int, str]:
        """The current content hash of every chunk of the source."""
        raise NotImplementedError


store = SummaryStore()


def resolve_citation(citation: dict, source_hash: str) -> dict | None:
    """A citation only points into the source hash it was written against."""
    if citation["source_hash"] != source_hash:
        return None
    return {
        "sentence": citation["sentence"],
        "chunk_index": citation["chunk_index"],
        "char_start": citation["char_start"],
        "char_end": citation["char_end"],
        "source_hash": source_hash,
    }


@app.get("/v1/summaries/{summary_id}")
def read_summary(
    summary_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")

    summary = store.get(tenant, summary_id)
    if summary is None:
        # Another tenant's id is indistinguishable from an id that does not exist.
        raise HTTPException(status_code=404, detail="summary not found")

    current_hash = store.source_hash(summary["source_ref"])
    current_chunks = store.chunk_hashes(summary["source_ref"])
    stale_chunks: list[int] = []
    citations = []
    for citation in summary["citations"]:
        stale = (
            citation["source_hash"] != current_hash
            or current_chunks.get(citation["chunk_index"]) != citation["chunk_hash"]
        )
        if stale:
            stale_chunks.append(citation["chunk_index"])
        citations.append(
            {
                **citation,
                "resolved": resolve_citation(citation, summary["source_hash"]) is not None,
                "stale": stale,
            }
        )

    logger.info("read tenant=%s summary_id=%s stale_chunks=%s", tenant, summary_id, stale_chunks)
    return JSONResponse(
        {
            "summary_id": summary_id,
            "source_ref": summary["source_ref"],
            "source_hash": summary["source_hash"],
            "summary": summary["summary"],
            "kind": summary["kind"],
            "citations": citations,
            "stale": len(stale_chunks) > 0,
            "stale_chunks": stale_chunks,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/summaries/{id}: a model-generated draft that returns whatever it loads. */
import Fastify from 'fastify';

export const app = Fastify();

interface Summary {
  summary_id: string;
  source_ref: string;
  source_hash: string;
  summary: string;
  kind: string;
  citations: unknown[];
}

const store = {
  async get(_summaryId: string): Promise<Summary | null> {
    throw new Error('summary store not wired');
  },
};

app.get('/v1/summaries/:summary_id', async (request, reply) => {
  // TODO: this draft returns the summary with no citations, serves it unchanged after the source
  // was edited (it never compares hashes), and looks the id up without the tenant. Review all three.
  const {summary_id: summaryId} = request.params as {summary_id: string};
  const summary = await store.get(summaryId);
  if (summary === null) return reply.code(404).send({error: 'not found'});
  request.log.info({summary_id: summaryId}, 'read summary');
  return reply.code(200).send(summary);
});
`,
      solution: `/** GET /v1/summaries/{id}: the summary with citations into the source it came from. */
import Fastify from 'fastify';

export const app = Fastify();

interface Citation {
  sentence: number;
  chunk_index: number;
  char_start: number;
  char_end: number;
  source_hash: string;
  chunk_hash: string;
}

interface Summary {
  summary_id: string;
  source_ref: string;
  source_hash: string;
  summary: string;
  kind: string;
  citations: Citation[];
}

const store = {
  async get(_tenant: string, _summaryId: string): Promise<Summary | null> {
    throw new Error('summary store not wired');
  },
  async sourceHash(_sourceRef: string): Promise<string | null> {
    throw new Error('source index not wired');
  },
  async chunkHashes(_sourceRef: string): Promise<Record<number, string>> {
    throw new Error('source index not wired');
  },
};

/** A citation only points into the source hash it was written against. */
function resolveCitation(citation: Citation, source_hash: string): Citation | null {
  return citation.source_hash === source_hash ? citation : null;
}

app.get('/v1/summaries/:summary_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const {summary_id: summaryId} = request.params as {summary_id: string};
  const summary = await store.get(tenant, summaryId);
  // Another tenant's id is indistinguishable from an id that does not exist.
  if (summary === null) return reply.code(404).send({error: 'summary not found'});

  const currentHash = await store.sourceHash(summary.source_ref);
  const currentChunks = await store.chunkHashes(summary.source_ref);
  const staleChunks: number[] = [];
  const citations = summary.citations.map(citation => {
    const stale =
      citation.source_hash !== currentHash || currentChunks[citation.chunk_index] !== citation.chunk_hash;
    if (stale) staleChunks.push(citation.chunk_index);
    return {...citation, resolved: resolveCitation(citation, summary.source_hash) !== null, stale};
  });

  request.log.info({tenant, summary_id: summaryId, stale_chunks: staleChunks}, 'read summary');
  return reply.code(200).send({
    summary_id: summaryId,
    source_ref: summary.source_ref,
    source_hash: summary.source_hash,
    summary: summary.summary,
    kind: summary.kind,
    citations,
    stale: staleChunks.length > 0,
    stale_chunks: staleChunks,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type Summary struct {
	SummaryID  string \`json:"summary_id"\`
	SourceRef  string \`json:"source_ref"\`
	SourceHash string \`json:"source_hash"\`
	Summary    string \`json:"summary"\`
	Kind       string \`json:"kind"\`
}

type SummaryStore interface {
	Get(summaryID string) *Summary
}

type unimplementedStore struct{}

func newSummaryStore() SummaryStore { return unimplementedStore{} }

func (unimplementedStore) Get(summaryID string) *Summary { panic("summary store not wired") }

func handleReadSummary(store SummaryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// TODO: this draft returns the summary with no citations, serves it unchanged after the
		// source was edited (it never compares hashes), and looks the id up without the tenant.
		// Review all three.
		summary := store.Get(r.PathValue("summary_id"))
		if summary == nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
			return
		}
		log.Printf("read summary_id=%s", summary.SummaryID)
		writeJSON(w, http.StatusOK, summary)
	}
}

func main() {
	store := newSummaryStore()
	http.HandleFunc("GET /v1/summaries/{summary_id}", handleReadSummary(store))
	log.Fatal(http.ListenAndServe(":8443", nil))
}
`,
      solution: `package main

import (
	"log"
	"net/http"
)

type Citation struct {
	Sentence   int    \`json:"sentence"\`
	ChunkIndex int    \`json:"chunk_index"\`
	CharStart  int    \`json:"char_start"\`
	CharEnd    int    \`json:"char_end"\`
	SourceHash string \`json:"source_hash"\`
	ChunkHash  string \`json:"chunk_hash"\`
}

type Summary struct {
	SummaryID  string     \`json:"summary_id"\`
	SourceRef  string     \`json:"source_ref"\`
	SourceHash string     \`json:"source_hash"\`
	Summary    string     \`json:"summary"\`
	Kind       string     \`json:"kind"\`
	Citations  []Citation \`json:"citations"\`
}

type SummaryStore interface {
	Get(tenant, summaryID string) *Summary
	SourceHash(sourceRef string) (string, bool)
	ChunkHashes(sourceRef string) map[int]string
}

// resolveCitation: a citation only points into the source hash it was written against.
func resolveCitation(citation Citation, sourceHash string) *Citation {
	if citation.SourceHash != sourceHash {
		return nil
	}
	return &citation
}

func handleReadSummary(store SummaryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant := r.Header.Get("X-Tenant-Id")
		if tenant == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing X-Tenant-Id"})
			return
		}
		summaryID := r.PathValue("summary_id")
		summary := store.Get(tenant, summaryID)
		// Another tenant's id is indistinguishable from an id that does not exist.
		if summary == nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "summary not found"})
			return
		}
		currentHash, current := store.SourceHash(summary.SourceRef)
		currentChunks := store.ChunkHashes(summary.SourceRef)
		staleChunks := []int{}
		citations := make([]map[string]any, 0, len(summary.Citations))
		for _, citation := range summary.Citations {
			stale := !current || citation.SourceHash != currentHash || currentChunks[citation.ChunkIndex] != citation.ChunkHash
			if stale {
				staleChunks = append(staleChunks, citation.ChunkIndex)
			}
			citations = append(citations, map[string]any{
				"sentence":    citation.Sentence,
				"chunk_index": citation.ChunkIndex,
				"char_start":  citation.CharStart,
				"char_end":    citation.CharEnd,
				"source_hash": citation.SourceHash,
				"resolved":    resolveCitation(citation, summary.SourceHash) != nil,
				"stale":       stale,
			})
		}
		log.Printf("read tenant=%s summary_id=%s stale_chunks=%d", tenant, summaryID, len(staleChunks))
		writeJSON(w, http.StatusOK, map[string]any{
			"summary_id":   summaryID,
			"source_ref":   summary.SourceRef,
			"source_hash":  summary.SourceHash,
			"summary":      summary.Summary,
			"kind":         summary.Kind,
			"citations":    citations,
			"stale":        len(staleChunks) > 0,
			"stale_chunks": staleChunks,
		})
	}
}

func main() {
	store := newSummaryStore()
	http.HandleFunc("GET /v1/summaries/{summary_id}", handleReadSummary(store))
	log.Fatal(http.ListenAndServe(":8443", nil))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import spray.json._

case class Summary(summaryId: String, sourceRef: String, sourceHash: String, summary: String, kind: String)

trait SummaryStore {
  def get(summaryId: String): Option[Summary]
}

object SummaryReadApi extends DefaultJsonProtocol {
  implicit val summaryFormat: RootJsonFormat[Summary] = jsonFormat5(Summary)

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("summarizer")
    val store: SummaryStore = new SummaryStore {
      def get(summaryId: String): Option[Summary] = throw new NotImplementedError("store")
    }

    val route =
      path("v1" / "summaries" / Segment) { summaryId =>
        get {
          // TODO: this draft returns the summary with no citations, serves it unchanged after the
          // source was edited (it never compares hashes), and looks the id up without the tenant.
          // Review all three.
          store.get(summaryId) match {
            case None        => complete(StatusCodes.NotFound, "not found")
            case Some(value) => complete(StatusCodes.OK, value.toJson.compactPrint)
          }
        }
      }

    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import spray.json._

case class Citation(sentence: Int, chunkIndex: Int, charStart: Int, charEnd: Int, sourceHash: String, chunkHash: String)
case class Summary(
    summaryId: String,
    sourceRef: String,
    sourceHash: String,
    summary: String,
    kind: String,
    citations: List[Citation]
)

trait SummaryStore {
  def get(tenant: String, summaryId: String): Option[Summary]
  def sourceHash(sourceRef: String): Option[String]
  def chunkHashes(sourceRef: String): Map[Int, String]
}

object SummaryReadApi extends DefaultJsonProtocol {
  implicit val citationFormat: RootJsonFormat[Citation] = jsonFormat6(Citation)
  implicit val summaryFormat: RootJsonFormat[Summary] = jsonFormat6(Summary)

  /** A citation only points into the source hash it was written against. */
  def resolveCitation(citation: Citation, sourceHash: String): Option[Citation] =
    if (citation.sourceHash == sourceHash) Some(citation) else None

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("summarizer")
    val store: SummaryStore = new SummaryStore {
      def get(tenant: String, summaryId: String): Option[Summary] = throw new NotImplementedError("store")
      def sourceHash(sourceRef: String): Option[String] = throw new NotImplementedError("source index")
      def chunkHashes(sourceRef: String): Map[Int, String] = throw new NotImplementedError("source index")
    }

    val route =
      path("v1" / "summaries" / Segment) { summaryId =>
        get {
          optionalHeaderValueByName("X-Tenant-Id") { tenant =>
            tenant match {
              case None => complete(StatusCodes.Unauthorized, "missing X-Tenant-Id")
              case Some(id) =>
                store.get(id, summaryId) match {
                  case None =>
                    // Another tenant's id is indistinguishable from an id that does not exist.
                    complete(StatusCodes.NotFound, "summary not found")
                  case Some(summary) =>
                    val currentHash = store.sourceHash(summary.sourceRef)
                    val currentChunks = store.chunkHashes(summary.sourceRef)
                    val staleChunks = summary.citations
                      .filter { citation =>
                        !currentHash.contains(citation.sourceHash) ||
                        !currentChunks.get(citation.chunkIndex).contains(citation.chunkHash)
                      }
                      .map(_.chunkIndex)
                    val citations = summary.citations.map { citation =>
                      JsObject(
                        "sentence" -> JsNumber(citation.sentence),
                        "chunk_index" -> JsNumber(citation.chunkIndex),
                        "char_start" -> JsNumber(citation.charStart),
                        "char_end" -> JsNumber(citation.charEnd),
                        "source_hash" -> JsString(citation.sourceHash),
                        "resolved" -> JsBoolean(resolveCitation(citation, summary.sourceHash).isDefined),
                        "stale" -> JsBoolean(staleChunks.contains(citation.chunkIndex))
                      )
                    }
                    complete(
                      StatusCodes.OK,
                      JsObject(
                        "summary_id" -> JsString(summaryId),
                        "source_ref" -> JsString(summary.sourceRef),
                        "source_hash" -> JsString(summary.sourceHash),
                        "summary" -> JsString(summary.summary),
                        "kind" -> JsString(summary.kind),
                        "citations" -> JsArray(citations.toVector),
                        "stale" -> JsBoolean(staleChunks.nonEmpty),
                        "stale_chunks" -> JsArray(staleChunks.distinct.sorted.map(JsNumber(_)).toVector)
                      ).compactPrint
                    )
                }
            }
          }
        }
      }

    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

struct SummaryStore {
  virtual json get(const std::string& summary_id) = 0;
};

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/summaries/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft returns the summary with no citations, serves it unchanged after the source
    // was edited (it never compares hashes), and looks the id up without the tenant. Review all three.
    static SummaryStore& store = *static_cast<SummaryStore*>(nullptr);
    const json summary = store.get(req.matches[1]);
    if (summary.is_null()) {
      res.status = 404;
      res.set_content(json{{"error", "not found"}}.dump(), "application/json");
      return;
    }
    res.status = 200;
    res.set_content(summary.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

struct Citation {
  int sentence = 0;
  int chunk_index = 0;
  int char_start = 0;
  int char_end = 0;
  std::string source_hash;
  std::string chunk_hash;
};

struct Summary {
  std::string summary_id;
  std::string source_ref;
  std::string source_hash;
  std::string summary;
  std::string kind;
  std::vector<Citation> citations;
};

/// The summary store, scoped by tenant; the source index answers what the source looks like now.
struct SummaryStore {
  virtual json get(const std::string& tenant, const std::string& summary_id) = 0;
  virtual std::string source_hash(const std::string& source_ref) = 0;
  virtual std::map<int, std::string> chunk_hashes(const std::string& source_ref) = 0;
};

/** Placeholder for the store the service is started with. */
struct PostgresSummaryStore : SummaryStore {
  json get(const std::string&, const std::string&) override { throw std::logic_error("summary store not wired"); }
  std::string source_hash(const std::string&) override { throw std::logic_error("source index not wired"); }
  std::map<int, std::string> chunk_hashes(const std::string&) override {
    throw std::logic_error("source index not wired");
  }
};

static PostgresSummaryStore store;

/// A citation only points into the source hash it was written against.
static bool resolve_citation(const Citation& citation, const std::string& source_hash) {
  return citation.source_hash == source_hash;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/summaries/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(json{{"error", "missing X-Tenant-Id"}}.dump(), "application/json");
      return;
    }
    const auto summary_id = req.matches[1];
    const json summary = store.get(tenant, summary_id);
    // Another tenant's id is indistinguishable from an id that does not exist.
    if (summary.is_null()) {
      res.status = 404;
      res.set_content(json{{"error", "summary not found"}}.dump(), "application/json");
      return;
    }
    const auto source_ref = summary.value("source_ref", std::string());
    const auto current_hash = store.source_hash(source_ref);
    const auto current_chunks = store.chunk_hashes(source_ref);
    std::vector<int> stale_chunks;
    json citations = json::array();
    for (const auto& item : summary.value("citations", json::array())) {
      const Citation citation{item.value("sentence", 0),   item.value("chunk_index", 0), item.value("char_start", 0),
                              item.value("char_end", 0),   item.value("source_hash", std::string()),
                              item.value("chunk_hash", std::string())};
      const auto current = current_chunks.find(citation.chunk_index);
      const bool stale = citation.source_hash != current_hash ||
                         current == current_chunks.end() || current->second != citation.chunk_hash;
      if (stale) stale_chunks.push_back(citation.chunk_index);
      citations.push_back(json{{"sentence", citation.sentence},
                               {"chunk_index", citation.chunk_index},
                               {"char_start", citation.char_start},
                               {"char_end", citation.char_end},
                               {"source_hash", citation.source_hash},
                               {"resolved", resolve_citation(citation, summary.value("source_hash", std::string()))},
                               {"stale", stale}});
    }
    res.status = 200;
    res.set_content(json{{"summary_id", summary_id},
                         {"source_ref", source_ref},
                         {"source_hash", summary.value("source_hash", std::string())},
                         {"summary", summary.value("summary", std::string())},
                         {"kind", summary.value("kind", std::string())},
                         {"citations", citations},
                         {"stale", !stale_chunks.empty()},
                         {"stale_chunks", stale_chunks}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Resolve the id inside the tenant, and answer the same `404` for "another tenant’s summary" and "no such summary". A `403` here is an oracle: it tells a caller that the id they guessed is real.',
    'A citation is a claim about a specific text: `sentence`, `chunk_index`, `char_start`, `char_end` and the `source_hash` it was written against. Return the pointers, and let `resolve_citation` decide whether a pointer still points anywhere.',
    'Staleness is a hash comparison, not a timestamp: compare the stored `source_hash` and each citation’s `chunk_hash` with the current ones, mark the changed chunks, and report `stale` plus `stale_chunks` so a reader knows exactly which claims moved.',
  ],
  debrief: `The interview question behind this step is whether a summary is a statement you can check. The draft
answers no: it returns text with no way to find the sentences it compressed and no way to notice that
the document changed underneath it. Citations are what make a summary auditable — sentence to chunk,
with character offsets and the source hash the pointer was written against — and the hash is what
makes them survive edits: an edit produces a new content hash, so the pointers into the chunks that
changed are known to be stale and can be marked, re-summarized or hidden instead of silently
misleading a reader. The tenant scoping is the security half of the same idea: a summary is derived
from someone's document, so an id alone must never be enough to read it, and a foreign id must be
indistinguishable from a missing one. Real systems add re-summarization jobs on stale summaries,
citation de-duplication across versions, a signed pointer so a citation can be validated outside the
service, and an audit log of who read which summary.`,
};
