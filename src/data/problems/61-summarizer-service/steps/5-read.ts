import type {Step} from '@/lib/types';

export const summarizerReadStep: Step = {
  id: 'read',
  title: 'GET /v1/summaries/{id}: scoped to the tenant, citations that know when they are stale',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/summaries/{summary_id}\`: it loads the record with
\`store.find_summary(summary_id)\` (**404** when there is none), reads the source as it is now
(\`store.current_source\`), and answers the summary with each citation's \`quote\` sliced from the
current chunk at the stored offsets. It serves the demo and hides three flaws.

**Failure mode the checks target.** Any caller with a guessed id reads another tenant's summary;
after the source is edited the response still presents the summary as current; and a citation into
an edited chunk quotes text the summary never saw.

- \`X-Tenant-Id\` is required (**401**) and the record is loaded with
  \`store.load_summary(tenant, summary_id)\`: another tenant's id is **404**, the same as an unknown
  one. \`find_summary\` is the support console's lookup.
- \`stale\` is true when the current \`source_hash\` differs from the summary's; \`stale_chunks\` lists,
  sorted, the cited chunks whose current hash differs from the citation's \`chunk_hash\`.
- Each citation carries \`stale\` and a \`quote\`: the cited text when its chunk is unchanged, \`null\`
  when it changed.`,
  sequence: {
    participants: ['Reader', 'Summarizer', 'Summary store'],
    messages: [
      {from: 'Reader', to: 'Summarizer', label: 'GET /v1/summaries/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Summarizer', to: 'Summary store', label: 'load_summary(tenant, id) → record · or 404', kind: 'sync'},
      {from: 'Summarizer', to: 'Summary store', label: 'current_source(tenant, source_ref)', kind: 'sync'},
      {from: 'Summarizer', to: 'Summarizer', label: 'chunk_hash per citation → quote · or stale', kind: 'sync'},
      {from: 'Summarizer', to: 'Reader', label: '200 {summary, stale, stale_chunks, citations}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/summaries/{id} with quoted citations',
      detail:
        'Register `GET /v1/summaries/{summary_id}`; each citation of an unchanged source quotes the sentence it points at, and an unknown id is **404**.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/summaries\/\{summary_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/summaries\/:summary_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/summaries\/\{summary_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"summaries"\s*\/\s*Segment\s*\)/, /\bget\b/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/summaries\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Another tenant's id is 404",
      detail:
        "`X-Tenant-Id` is required and the record is loaded with `load_summary(tenant, id)`, so a foreign id answers **404** like a missing one; the starter's `find_summary` finds it whoever owns it.",
      match: {
        python: {all: [/x-tenant-id/i, /store\.load_summary\(\s*tenant/], none: [/find_summary\(/]},
        typescript: {all: [/x-tenant-id/i, /loadSummary\(\s*tenant/], none: [/findSummary\(/]},
        go: {all: [/X-Tenant-Id/i, /store\.LoadSummary\([^\n]*\btenant\b/], none: [/FindSummary\(/]},
        scala: {all: [/X-Tenant-Id/i, /Store\.loadSummary\(\s*tenant/], none: [/findSummary\(/]},
        cpp: {all: [/X-Tenant-Id/i, /store::loadSummary\(\s*tenant/], none: [/findSummary\(/]},
      },
    },
    {
      id: 'stale-flag',
      title: 'Marks a summary of an edited source stale',
      detail:
        "The response compares the current `source_hash` with the summary's (`stale`) and lists the cited chunks that changed (`stale_chunks`); the starter compares nothing.",
      match: {
        python: {all: [/stale_chunks/, /source_hash["']\]\s*!=/]},
        typescript: {all: [/stale_chunks/, /source_hash\s*!==/]},
        go: {all: [/stale_chunks/, /SourceHash\s*!=/]},
        scala: {all: [/stale_chunks/, /sourceHash\s*!=/]},
        cpp: {all: [/stale_chunks/, /at\("source_hash"\)\s*!=/]},
      },
    },
    {
      id: 'citation-quotes',
      title: 'Quotes a citation only while its chunk is unchanged',
      detail:
        "Each citation compares its `chunk_hash` with the chunk's current hash: unchanged, it quotes the text at its offsets; changed, `quote` is null and `stale` true. The starter slices the current chunk at the old offsets, which quotes text the summary never saw.",
      match: {
        python: {all: [/chunk_hashes/, /["']chunk_hash["']\]/, /["']quote["']/]},
        typescript: {all: [/chunk_hashes/, /\.chunk_hash\b/, /quote/]},
        go: {all: [/ChunkHashes/, /\.ChunkHash\b/, /"quote"/]},
        scala: {all: [/chunkHashes/, /\.chunkHash\b/, /"quote"/]},
        cpp: {all: [/chunk_hashes/, /"chunk_hash"/, /"quote"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from summarizer import store  # load_summary, find_summary, current_source

app = FastAPI()


@app.get("/v1/summaries/{summary_id}")
def read_summary(summary_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    record = store.find_summary(summary_id)
    if record is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    current = store.current_source(record["tenant"], record["source_ref"])
    chunks = current["chunks"] if current else []
    citations = []
    for c in record["citations"]:
        chunk = chunks[c["chunk_index"]] if c["chunk_index"] < len(chunks) else ""
        citations.append({**c, "quote": chunk[c["char_start"] : c["char_end"]]})
    fields = ("summary_id", "source_ref", "source_hash", "band", "kind", "summary")
    return JSONResponse({**{name: record[name] for name in fields}, "citations": citations})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from summarizer import store  # load_summary, find_summary, current_source

app = FastAPI()


@app.get("/v1/summaries/{summary_id}")
def read_summary(summary_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    # Scoped to the caller: another tenant's id is as absent as an id nobody minted.
    record = store.load_summary(tenant, summary_id)
    if record is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    current = store.current_source(tenant, record["source_ref"])
    chunks = current["chunks"] if current else []
    hashes = current["chunk_hashes"] if current else []
    citations, stale_chunks = [], set()
    for c in record["citations"]:
        i = c["chunk_index"]
        fresh = i < len(hashes) and hashes[i] == c["chunk_hash"]
        if not fresh:
            stale_chunks.add(i)  # the text this citation points at is gone
        citations.append({**c, "stale": not fresh, "quote": chunks[i][c["char_start"] : c["char_end"]] if fresh else None})
    fields = ("summary_id", "source_ref", "source_hash", "band", "kind", "summary")
    return JSONResponse({
        **{name: record[name] for name in fields},
        "stale": current is None or current["source_hash"] != record["source_hash"],
        "stale_chunks": sorted(stale_chunks),
        "citations": citations,
    })
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {currentSource, findSummary, loadSummary} from 'summarizer/store';

export const app = Fastify();

app.get('/v1/summaries/:summary_id', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {summary_id} = request.params as {summary_id: string};
  const record = await findSummary(summary_id);
  if (record === null) return reply.code(404).send({error: 'not found'});
  const current = await currentSource(record.tenant, record.source_ref);
  const chunks = current?.chunks ?? [];
  const citations = record.citations.map(c => ({...c, quote: (chunks[c.chunk_index] ?? '').slice(c.char_start, c.char_end)}));
  const {source_ref, source_hash, band, kind, summary} = record;
  return {summary_id, source_ref, source_hash, band, kind, summary, citations};
});
`,
      solution: `import Fastify from 'fastify';

import {currentSource, findSummary, loadSummary} from 'summarizer/store';

export const app = Fastify();

app.get('/v1/summaries/:summary_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {summary_id} = request.params as {summary_id: string};
  // Scoped to the caller: another tenant's id is as absent as an id nobody minted.
  const record = await loadSummary(tenant, summary_id);
  if (record === null) return reply.code(404).send({error: 'not found'});
  const current = await currentSource(tenant, record.source_ref);
  const chunks = current?.chunks ?? [];
  const hashes = current?.chunk_hashes ?? [];
  const staleChunks = new Set<number>();
  const citations = record.citations.map(c => {
    const fresh = hashes[c.chunk_index] === c.chunk_hash;
    if (!fresh) staleChunks.add(c.chunk_index); // the text this citation points at is gone
    return {...c, stale: !fresh, quote: fresh ? chunks[c.chunk_index].slice(c.char_start, c.char_end) : null};
  });
  const {source_ref, source_hash, band, kind, summary} = record;
  return {
    summary_id,
    source_ref,
    source_hash,
    band,
    kind,
    summary,
    stale: current === null || current.source_hash !== record.source_hash,
    stale_chunks: [...staleChunks].sort((a, b) => a - b),
    citations,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"summarizer/store" // store.LoadSummary, FindSummary, CurrentSource
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readSummary(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	record := store.FindSummary(r.Context(), r.PathValue("summary_id"))
	if record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	var chunks []string
	if current := store.CurrentSource(r.Context(), record.Tenant, record.SourceRef); current != nil {
		chunks = current.Chunks
	}
	citations := []map[string]any{}
	for _, c := range record.Citations {
		quote := ""
		if c.ChunkIndex < len(chunks) && c.CharEnd <= len(chunks[c.ChunkIndex]) {
			quote = chunks[c.ChunkIndex][c.CharStart:c.CharEnd]
		}
		citations = append(citations, map[string]any{
			"sentence": c.Sentence, "chunk_index": c.ChunkIndex, "char_start": c.CharStart, "char_end": c.CharEnd, "chunk_hash": c.ChunkHash, "quote": quote,
		})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"summary_id": record.SummaryID, "source_ref": record.SourceRef, "source_hash": record.SourceHash, "band": record.Band,
		"kind": record.Kind, "summary": record.Summary, "citations": citations,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/summaries/{summary_id}", readSummary)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"

	"summarizer/store" // store.LoadSummary, FindSummary, CurrentSource
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readSummary(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	// Scoped to the caller: another tenant's id is as absent as an id nobody minted.
	record := store.LoadSummary(r.Context(), tenant, r.PathValue("summary_id"))
	if record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	current := store.CurrentSource(r.Context(), tenant, record.SourceRef)
	var chunks, hashes []string
	if current != nil {
		chunks = current.Chunks
		hashes = current.ChunkHashes
	}
	citations := []map[string]any{}
	staleChunks := []int{}
	seen := map[int]bool{}
	for _, c := range record.Citations {
		fresh := c.ChunkIndex < len(hashes) && hashes[c.ChunkIndex] == c.ChunkHash
		var quote any
		if fresh {
			quote = chunks[c.ChunkIndex][c.CharStart:c.CharEnd]
		} else if !seen[c.ChunkIndex] {
			seen[c.ChunkIndex] = true // the text this citation points at is gone
			staleChunks = append(staleChunks, c.ChunkIndex)
		}
		citations = append(citations, map[string]any{
			"sentence": c.Sentence, "chunk_index": c.ChunkIndex, "char_start": c.CharStart, "char_end": c.CharEnd, "chunk_hash": c.ChunkHash,
			"stale": !fresh, "quote": quote,
		})
	}
	sort.Ints(staleChunks)
	writeJSON(rw, http.StatusOK, map[string]any{
		"summary_id": record.SummaryID, "source_ref": record.SourceRef, "source_hash": record.SourceHash, "band": record.Band,
		"kind": record.Kind, "summary": record.Summary,
		"stale":        current == nil || current.SourceHash != record.SourceHash,
		"stale_chunks": staleChunks,
		"citations":    citations,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/summaries/{summary_id}", readSummary)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import summarizer.Store // Store.loadSummary, findSummary, currentSource

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def respond(summaryId: String): HttpResponse = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    Store.findSummary(summaryId) match {
      case None => json(StatusCodes.NotFound, JsObject("error" -> JsString("not found")))
      case Some(record) =>
        val chunks = Store.currentSource(record.tenant, record.sourceRef).map(_.chunks).getOrElse(Vector.empty)
        val citations = record.citations.map { c =>
          val chunk = chunks.lift(c.chunkIndex).getOrElse("")
          JsObject(Store.citationJson(c).fields + ("quote" -> JsString(chunk.slice(c.charStart, c.charEnd))))
        }
        val view = Store.toJson(record).fields.filter { case (name, _) => Set("summary_id", "source_ref", "source_hash", "band", "kind", "summary")(name) }
        json(StatusCodes.OK, JsObject(view + ("citations" -> JsArray(citations))))
    }
  }

  val route: Route = path("v1" / "summaries" / Segment) { summaryId =>
    get {
      complete(respond(summaryId))
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import summarizer.Store // Store.loadSummary, findSummary, currentSource

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def respond(tenant: String, summaryId: String): HttpResponse =
    if (tenant.isEmpty) json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required")))
    else
      // Scoped to the caller: another tenant's id is as absent as an id nobody minted.
      Store.loadSummary(tenant, summaryId) match {
        case None => json(StatusCodes.NotFound, JsObject("error" -> JsString("not found")))
        case Some(record) =>
          val current = Store.currentSource(tenant, record.sourceRef)
          val chunks = current.map(_.chunks).getOrElse(Vector.empty)
          val hashes = current.map(_.chunkHashes).getOrElse(Vector.empty)
          val fresh = record.citations.map(c => hashes.lift(c.chunkIndex).contains(c.chunkHash))
          val citations = record.citations.zip(fresh).map { case (c, ok) =>
            val quote = if (ok) JsString(chunks(c.chunkIndex).substring(c.charStart, c.charEnd)) else JsNull
            JsObject(Store.citationJson(c).fields ++ Map("stale" -> JsBoolean(!ok), "quote" -> quote))
          }
          // The cited chunks whose text is gone.
          val staleChunks = record.citations.zip(fresh).collect { case (c, false) => c.chunkIndex }.distinct.sorted
          val view = Store.toJson(record).fields.filter { case (name, _) => Set("summary_id", "source_ref", "source_hash", "band", "kind", "summary")(name) }
          json(StatusCodes.OK, JsObject(view ++ Map(
            "stale" -> JsBoolean(current.forall(_.sourceHash != record.sourceHash)),
            "stale_chunks" -> JsArray(staleChunks.map(i => JsNumber(i))),
            "citations" -> JsArray(citations))))
      }

  val route: Route = path("v1" / "summaries" / Segment) { summaryId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        complete(respond(tenant.getOrElse(""), summaryId))
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

#include "summarizer/store.h"  // summarizer::store::loadSummary, findSummary, currentSource

using json = nlohmann::json;
namespace store = summarizer::store;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_summary(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string summary_id = req.matches[1];
  const auto record = store::findSummary(summary_id);
  if (!record) return reply(res, 404, {{"error", "not found"}});
  const auto current = store::currentSource(record->at("tenant").get<std::string>(), record->at("source_ref").get<std::string>());
  const json chunks = current ? current->at("chunks") : json::array();
  json citations = json::array();
  for (json c : record->at("citations")) {
    const size_t i = c.at("chunk_index").get<size_t>();
    const std::string chunk = i < chunks.size() ? chunks[i].get<std::string>() : "";
    const size_t start = c.at("char_start").get<size_t>();
    c["quote"] = start < chunk.size() ? chunk.substr(start, c.at("char_end").get<size_t>() - start) : "";
    citations.push_back(c);
  }
  json body = json::object();
  for (const char* name : {"summary_id", "source_ref", "source_hash", "band", "kind", "summary"}) body[name] = record->at(name);
  body["citations"] = citations;
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/summaries/([\\w-]+))", read_summary); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "summarizer/store.h"  // summarizer::store::loadSummary, findSummary, currentSource

using json = nlohmann::json;
namespace store = summarizer::store;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_summary(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string summary_id = req.matches[1];
  // Scoped to the caller: another tenant's id is as absent as an id nobody minted.
  const auto record = store::loadSummary(tenant, summary_id);
  if (!record) return reply(res, 404, {{"error", "not found"}});
  const auto current = store::currentSource(tenant, record->at("source_ref").get<std::string>());
  const json chunks = current ? current->at("chunks") : json::array();
  const json chunk_hashes = current ? current->at("chunk_hashes") : json::array();
  json citations = json::array();
  std::set<long> stale_chunks;
  for (json c : record->at("citations")) {
    const size_t i = c.at("chunk_index").get<size_t>();
    const bool fresh = i < chunk_hashes.size() && chunk_hashes[i] == c.at("chunk_hash");
    if (!fresh) stale_chunks.insert(static_cast<long>(i));  // the text this citation points at is gone
    const size_t start = c.at("char_start").get<size_t>();
    c["stale"] = !fresh;
    c["quote"] = fresh ? json(chunks[i].get<std::string>().substr(start, c.at("char_end").get<size_t>() - start)) : json(nullptr);
    citations.push_back(c);
  }
  json body = json::object();
  for (const char* name : {"summary_id", "source_ref", "source_hash", "band", "kind", "summary"}) body[name] = record->at(name);
  body["stale"] = !current || current->at("source_hash") != record->at("source_hash");
  body["stale_chunks"] = stale_chunks;
  body["citations"] = citations;
  reply(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/summaries/([\\w-]+))", read_summary); }
`,
    },
  },
  harness: {
    python: `from summarizer import store

DOC = "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee approved the accounts. Two directors stepped down."
EDITED = "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee rejected the accounts. Three directors resigned."
SENTENCES = ["The board met on 3 March.", "Revenue rose four percent in the quarter.", "The audit committee approved the accounts.", "Two directors stepped down."]


def _seed():
    return store.create_summary("t1", "doc-1", DOC, "medium", 250)["summary_id"]


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, summary_id, tenant="t1"):
    return await c.get(f"/v1/summaries/{summary_id}", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route(ctx):
    summary_id = _seed()
    async with _api(ctx) as c:
        r = await _get(c, summary_id)
        assert r.status_code == 200, f"GET /v1/summaries/{summary_id} answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("summary") == " ".join(SENTENCES), f"the response must carry the stored summary, got {body.get('summary')!r}"
        quotes = [c.get("quote") for c in body.get("citations", [])]
        assert quotes == SENTENCES, f"each citation must quote the sentence it points at, got {quotes}"
        missing = await _get(c, "s-99")
    assert missing.status_code == 404, f"an unknown id answered {missing.status_code}, expected 404"


async def check_tenant_scope(ctx):
    summary_id = _seed()
    async with _api(ctx) as c:
        foreign = await _get(c, summary_id, tenant="t2")
        assert foreign.status_code == 404, f"tenant t2 reading t1's summary {summary_id} answered {foreign.status_code}: the lookup must be scoped to the caller's tenant, expected 404"
        assert "board" not in foreign.text, f"the answer to t2 carries t1's text: {foreign.text[:200]}"
        anon = await _get(c, summary_id, tenant=None)
    assert anon.status_code == 401, f"a read without X-Tenant-Id answered {anon.status_code}, expected 401"


async def check_stale_flag(ctx):
    summary_id = _seed()
    async with _api(ctx) as c:
        fresh = (await _get(c, summary_id)).json()
        assert fresh.get("stale") is False and fresh.get("stale_chunks") == [], f"before any edit the summary must be stale false with no stale_chunks, got stale={fresh.get('stale')!r} stale_chunks={fresh.get('stale_chunks')!r}"
        store.put_source("t1", "doc-1", EDITED)
        edited = (await _get(c, summary_id)).json()
    assert edited.get("stale") is True, f"after the source was edited the summary answered stale={edited.get('stale')!r}: a reader takes a summary of text that no longer exists for the current one"
    assert edited.get("stale_chunks") == [1], f"only chunk 1 changed, stale_chunks is {edited.get('stale_chunks')!r}"


async def check_citation_quotes(ctx):
    summary_id = _seed()
    store.put_source("t1", "doc-1", EDITED)
    async with _api(ctx) as c:
        body = (await _get(c, summary_id)).json()
    citations = body.get("citations", [])
    assert len(citations) == 4, f"the summary has four cited sentences, the response carries {len(citations)} citations"
    for cite, sentence in zip(citations, SENTENCES):
        if cite.get("chunk_index") == 0:
            assert cite.get("quote") == sentence and cite.get("stale") is False, f"a citation into the unchanged chunk 0 must quote {sentence!r} and be stale false, got {cite}"
        else:
            assert cite.get("quote") is None and cite.get("stale") is True, f"a citation into the edited chunk 1 answered quote {cite.get('quote')!r}, stale {cite.get('stale')!r}: the old offsets now slice text the summary never saw. Expected quote null, stale true"
`,
    typescript: `const DOC = 'The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee approved the accounts. Two directors stepped down.';
const EDITED = 'The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee rejected the accounts. Three directors resigned.';
const SENTENCES = ['The board met on 3 March.', 'Revenue rose four percent in the quarter.', 'The audit committee approved the accounts.', 'Two directors stepped down.'];

async function read(ctx) {
  const store = ctx.load('/support/summarizer/store.ts');
  const {summary_id} = await store.createSummary('t1', 'doc-1', DOC, 'medium', 250);
  const c = ctx.client(ctx.load('read').app);
  const get = (id: string, tenant: string | null = 't1') => c.get(\`/v1/summaries/\${id}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});
  return {store, summaryId: summary_id as string, get};
}

export async function check_route(ctx) {
  const {summaryId, get} = await read(ctx);
  const r = await get(summaryId);
  assert.equal(r.status, 200, \`GET /v1/summaries/\${summaryId} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.summary, SENTENCES.join(' '), \`the response must carry the stored summary, got \${JSON.stringify(body.summary)}\`);
  const quotes = (body.citations ?? []).map(c => c.quote);
  assert.deepStrictEqual(quotes, SENTENCES, \`each citation must quote the sentence it points at, got \${JSON.stringify(quotes)}\`);
  const missing = await get('s-99');
  assert.equal(missing.status, 404, \`an unknown id answered \${missing.status}, expected 404\`);
}

export async function check_tenant_scope(ctx) {
  const {summaryId, get} = await read(ctx);
  const foreign = await get(summaryId, 't2');
  assert.equal(foreign.status, 404, \`tenant t2 reading t1's summary \${summaryId} answered \${foreign.status}: the lookup must be scoped to the caller's tenant, expected 404\`);
  assert(!foreign.text.includes('board'), \`the answer to t2 carries t1's text: \${foreign.text.slice(0, 200)}\`);
  const anon = await get(summaryId, null);
  assert.equal(anon.status, 401, \`a read without X-Tenant-Id answered \${anon.status}, expected 401\`);
}

export async function check_stale_flag(ctx) {
  const {store, summaryId, get} = await read(ctx);
  const fresh = (await get(summaryId)).json();
  assert(fresh.stale === false && JSON.stringify(fresh.stale_chunks) === '[]', \`before any edit the summary must be stale false with no stale_chunks, got stale=\${JSON.stringify(fresh.stale)} stale_chunks=\${JSON.stringify(fresh.stale_chunks)}\`);
  await store.putSource('t1', 'doc-1', EDITED);
  const edited = (await get(summaryId)).json();
  assert.equal(edited.stale, true, \`after the source was edited the summary answered stale=\${JSON.stringify(edited.stale)}: a reader takes a summary of text that no longer exists for the current one\`);
  assert.deepStrictEqual(edited.stale_chunks, [1], \`only chunk 1 changed, stale_chunks is \${JSON.stringify(edited.stale_chunks)}\`);
}

export async function check_citation_quotes(ctx) {
  const {store, summaryId, get} = await read(ctx);
  await store.putSource('t1', 'doc-1', EDITED);
  const citations = (await get(summaryId)).json().citations ?? [];
  assert.equal(citations.length, 4, \`the summary has four cited sentences, the response carries \${citations.length} citations\`);
  citations.forEach((cite, i) => {
    if (cite.chunk_index === 0) {
      assert(cite.quote === SENTENCES[i] && cite.stale === false, \`a citation into the unchanged chunk 0 must quote \${JSON.stringify(SENTENCES[i])} and be stale false, got \${JSON.stringify(cite)}\`);
    } else {
      assert(cite.quote === null && cite.stale === true, \`a citation into the edited chunk 1 answered quote \${JSON.stringify(cite.quote)}, stale \${JSON.stringify(cite.stale)}: the old offsets now slice text the summary never saw. Expected quote null, stale true\`);
    }
  });
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"summarizer/store"

	"leetbuild/harness"
)

const (
	readDoc    = "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee approved the accounts. Two directors stepped down."
	readEdited = "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee rejected the accounts. Three directors resigned."
)

var readSentences = []string{"The board met on 3 March.", "Revenue rose four percent in the quarter.", "The audit committee approved the accounts.", "Two directors stepped down."}

type readCitation struct {
	ChunkIndex int     \`json:"chunk_index"\`
	Stale      *bool   \`json:"stale"\`
	Quote      *string \`json:"quote"\`
}

type readBody struct {
	Summary     string         \`json:"summary"\`
	Stale       *bool          \`json:"stale"\`
	StaleChunks []int          \`json:"stale_chunks"\`
	Citations   []readCitation \`json:"citations"\`
}

func readSetup(ctx *harness.Ctx) (*harness.HTTP, string) {
	record := store.CreateSummary(context.Background(), "t1", "doc-1", readDoc, "medium", 250)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), record.SummaryID
}

func readGet(c *harness.HTTP, summaryID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/summaries/" + summaryID)
	}
	return c.Get("/v1/summaries/"+summaryID, "X-Tenant-Id", tenant)
}

func readDecode(r *harness.Response) readBody {
	var b readBody
	r.Decode(&b)
	return b
}

func show(p any) string {
	switch v := p.(type) {
	case *bool:
		if v != nil {
			if *v {
				return "true"
			}
			return "false"
		}
	case *string:
		if v != nil {
			return "\\"" + *v + "\\""
		}
	}
	return "null"
}

func CheckRoute(ctx *harness.Ctx) {
	c, summaryID := readSetup(ctx)
	r := readGet(c, summaryID, "t1")
	ctx.Equal(r.Status, 200, "GET /v1/summaries/%s (%s)", summaryID, r.Text())
	body := readDecode(r)
	ctx.Equal(body.Summary, strings.Join(readSentences, " "), "the response must carry the stored summary")
	var quotes []string
	for _, cite := range body.Citations {
		if cite.Quote != nil {
			quotes = append(quotes, *cite.Quote)
		}
	}
	ctx.Equal(quotes, readSentences, "each citation must quote the sentence it points at")
	ctx.Equal(readGet(c, "s-99", "t1").Status, 404, "an unknown id")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c, summaryID := readSetup(ctx)
	foreign := readGet(c, summaryID, "t2")
	ctx.Equal(foreign.Status, 404, "tenant t2 reading t1's summary %s (the lookup must be scoped to the caller's tenant)", summaryID)
	ctx.Assert(!strings.Contains(foreign.Text(), "board"), "the answer to t2 carries t1's text: %.200s", foreign.Text())
	ctx.Equal(readGet(c, summaryID, "").Status, 401, "a read without X-Tenant-Id")
}

func CheckStaleFlag(ctx *harness.Ctx) {
	c, summaryID := readSetup(ctx)
	fresh := readDecode(readGet(c, summaryID, "t1"))
	ctx.Assert(fresh.Stale != nil && !*fresh.Stale && fresh.StaleChunks != nil && len(fresh.StaleChunks) == 0, "before any edit the summary must be stale false with no stale_chunks, got stale=%s stale_chunks=%v", show(fresh.Stale), fresh.StaleChunks)
	store.PutSource(context.Background(), "t1", "doc-1", readEdited)
	edited := readDecode(readGet(c, summaryID, "t1"))
	ctx.Assert(edited.Stale != nil && *edited.Stale, "after the source was edited the summary answered stale=%s: a reader takes a summary of text that no longer exists for the current one", show(edited.Stale))
	ctx.Equal(edited.StaleChunks, []int{1}, "only chunk 1 changed; stale_chunks")
}

func CheckCitationQuotes(ctx *harness.Ctx) {
	c, summaryID := readSetup(ctx)
	store.PutSource(context.Background(), "t1", "doc-1", readEdited)
	citations := readDecode(readGet(c, summaryID, "t1")).Citations
	ctx.Equal(len(citations), 4, "the summary has four cited sentences; the citations")
	for i, cite := range citations {
		if cite.ChunkIndex == 0 {
			ctx.Assert(cite.Quote != nil && *cite.Quote == readSentences[i] && cite.Stale != nil && !*cite.Stale, "a citation into the unchanged chunk 0 must quote %q and be stale false, got quote %s stale %s", readSentences[i], show(cite.Quote), show(cite.Stale))
		} else {
			ctx.Assert(cite.Quote == nil && cite.Stale != nil && *cite.Stale, "a citation into the edited chunk 1 answered quote %s, stale %s: the old offsets now slice text the summary never saw. Expected quote null, stale true", show(cite.Quote), show(cite.Stale))
		}
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "summarizer/store.h"

namespace {

const std::string kReadDoc =
    "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee approved the accounts. Two directors stepped down.";
const std::string kReadEdited =
    "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee rejected the accounts. Three directors resigned.";
const std::vector<std::string> kSentences = {"The board met on 3 March.", "Revenue rose four percent in the quarter.", "The audit committee approved the accounts.",
                                             "Two directors stepped down."};

struct ReadSetup {
  harness::HTTP c;
  std::string summary_id;
};

ReadSetup readSetup(harness::Ctx& ctx) {
  const auto record = summarizer::store::createSummary("t1", "doc-1", kReadDoc, "medium", 250);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return {ctx.HTTP(*svr), record.at("summary_id").get<std::string>()};
}

harness::Response readGet(harness::HTTP& c, const std::string& summary_id, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/summaries/" + summary_id);
  return c.Get("/v1/summaries/" + summary_id, "X-Tenant-Id", tenant);
}

nlohmann::json readBody(harness::Ctx& ctx, const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the response is not a JSON object: %d %.200s", r.Status, r.Text());
  return body;
}

std::string show(const nlohmann::json& body, const char* name) { return body.contains(name) ? body[name].dump() : "absent"; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto [c, summary_id] = readSetup(ctx);
  const auto r = readGet(c, summary_id, "t1");
  ctx.Equal(r.Status, 200, "GET /v1/summaries/%s (%s)", summary_id, r.Text());
  const auto body = readBody(ctx, r);
  ctx.Equal(body.value("summary", ""), kSentences[0] + " " + kSentences[1] + " " + kSentences[2] + " " + kSentences[3], "the response must carry the stored summary");
  std::vector<std::string> quotes;
  for (const auto& cite : body.value("citations", nlohmann::json::array())) {
    if (cite.contains("quote") && cite["quote"].is_string()) quotes.push_back(cite["quote"].get<std::string>());
  }
  ctx.Equal(quotes, kSentences, "each citation must quote the sentence it points at");
  ctx.Equal(readGet(c, "s-99", "t1").Status, 404, "an unknown id");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto [c, summary_id] = readSetup(ctx);
  const auto foreign = readGet(c, summary_id, "t2");
  ctx.Equal(foreign.Status, 404, "tenant t2 reading t1's summary %s (the lookup must be scoped to the caller's tenant)", summary_id);
  ctx.Assert(foreign.Text().find("board") == std::string::npos, "the answer to t2 carries t1's text: %.200s", foreign.Text());
  ctx.Equal(readGet(c, summary_id, "").Status, 401, "a read without X-Tenant-Id");
}

void CheckStaleFlag(harness::Ctx& ctx) {
  auto [c, summary_id] = readSetup(ctx);
  const auto fresh = readBody(ctx, readGet(c, summary_id, "t1"));
  ctx.Assert(fresh.value("stale", nlohmann::json()) == false && fresh.value("stale_chunks", nlohmann::json()) == nlohmann::json::array(),
             "before any edit the summary must be stale false with no stale_chunks, got stale=%s stale_chunks=%s", show(fresh, "stale"), show(fresh, "stale_chunks"));
  summarizer::store::putSource("t1", "doc-1", kReadEdited);
  const auto edited = readBody(ctx, readGet(c, summary_id, "t1"));
  ctx.Assert(edited.value("stale", nlohmann::json()) == true, "after the source was edited the summary answered stale=%s: a reader takes a summary of text that no longer exists for the current one", show(edited, "stale"));
  ctx.Equal(edited.value("stale_chunks", nlohmann::json()), nlohmann::json::array({1}), "only chunk 1 changed; stale_chunks");
}

void CheckCitationQuotes(harness::Ctx& ctx) {
  auto [c, summary_id] = readSetup(ctx);
  summarizer::store::putSource("t1", "doc-1", kReadEdited);
  const auto citations = readBody(ctx, readGet(c, summary_id, "t1")).value("citations", nlohmann::json::array());
  ctx.Equal(citations.size(), 4, "the summary has four cited sentences; the citations");
  for (size_t i = 0; i < citations.size(); i++) {
    const auto& cite = citations[i];
    if (cite.value("chunk_index", -1L) == 0) {
      ctx.Assert(cite.value("quote", nlohmann::json()) == kSentences[i] && cite.value("stale", nlohmann::json()) == false,
                 "a citation into the unchanged chunk 0 must quote %q and be stale false, got %s", kSentences[i], cite.dump());
    } else {
      ctx.Assert(cite.value("quote", nlohmann::json(0)).is_null() && cite.value("stale", nlohmann::json()) == true,
                 "a citation into the edited chunk 1 answered quote %s, stale %s: the old offsets now slice text the summary never saw. Expected quote null, stale true", show(cite, "quote"), show(cite, "stale"));
    }
  }
}
`,
  },
  hints: [
    "Read a summary with another tenant's header and it comes back in full; edit the source and the summary still reads as current, with a citation quoting words the summary never used.",
    'The lookup is `find_summary`, which ignores the tenant. Nothing compares the stored hashes with the current source, and the quote slices whatever text now sits at the old offsets.',
    'Require `X-Tenant-Id`, load with `store.load_summary(tenant, id)`, compare `current["source_hash"]` for `stale`, and per citation compare `chunk_hashes[i]` with `chunk_hash`: quote when equal, `None` plus `stale` and an entry in `stale_chunks` otherwise.',
  ],
  debrief: `Scoping the lookup to the tenant and answering 404 for a foreign id means the endpoint never confirms that someone else's summary exists. The chunk hash stored with each citation is what lets the read tell an unchanged sentence from one whose text moved: offsets alone point at bytes, the hash says whether they are still the bytes the summary was written from. Marking stale per citation keeps the parts that still hold usable instead of discarding the whole summary. A production read also re-summarizes stale chunks in the background, records which summary version a reader saw, and lets the console's cross-tenant lookup exist only behind an audited support role.`,
};
