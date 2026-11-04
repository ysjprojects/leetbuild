import type {Step} from '@/lib/types';

export const rerankEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/rerank: caps, truncation and a deterministic order',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'reranker'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/rerank\`: it answers 401 without \`X-Tenant-Id\`,
reads \`{"query", "candidates": [{"passage_id", "text"}]}\`, scores each candidate's first 4096
characters with the provided in-process model (\`rerank.model.score\`; step 3 puts the gRPC client in
its place) and answers \`{"results": [{"passage_id", "score"}]}\` in the order the client sent. It
serves the demo and hides 4 flaws.

**Failure mode the checks target.** One caller with a huge query or thousands of candidates sets
the model bill; a passage clipped before scoring comes back with a score of text the model never saw,
and nothing says so; equal scores follow the client's order, so one request yields two lists.

- \`MAX_QUERY_BYTES\` (the stack's spelling: \`maxQueryBytes\`, \`kMaxQueryBytes\`) is 2 KiB of UTF-8: a
  longer query is **413**.
- \`MAX_CANDIDATES\` is 200: more is **400**, before anything is scored.
- \`MAX_PASSAGE_BYTES\` is 4 KiB: a longer text is cut to that many bytes on a character boundary and
  scored cut; every result carries \`truncated\`, \`true\` for a cut passage.
- Results are sorted by score descending, ties by \`passage_id\` ascending.`,
  sequence: {
    participants: ['Client', 'Rerank API', 'Reranker model'],
    messages: [
      {from: 'Client', to: 'Rerank API', label: 'POST /v1/rerank · query · candidates', kind: 'sync'},
      {from: 'Rerank API', to: 'Rerank API', label: 'tenant · query bytes → 413 · count → 400', kind: 'sync'},
      {from: 'Rerank API', to: 'Reranker model', label: 'score(query, text cut to 4 KiB)', kind: 'sync'},
      {from: 'Reranker model', to: 'Rerank API', label: 'scores', kind: 'reply'},
      {from: 'Rerank API', to: 'Rerank API', label: 'sort by score, then passage_id', kind: 'sync'},
      {from: 'Rerank API', to: 'Client', label: '200 {results: [passage_id, score, truncated]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves POST /v1/rerank for a tenant',
      detail: '`POST /v1/rerank` answers 200 with one result per candidate and 401 without `X-Tenant-Id`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/rerank["']/, /\b401\b/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/rerank['"]/, /\b401\b/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/rerank"/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"rerank"\s*\)/, /Unauthorized/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/rerank"/, /\b401\b/]},
      },
    },
    {
      id: 'query-cap',
      title: 'Answers 413 for a query over 2 KiB of UTF-8',
      detail:
        'A query longer than `MAX_QUERY_BYTES` (2048 bytes of UTF-8, so 1100 accented letters are over it) answers **413**; exactly 2048 bytes is served. The starter passes any query to the model.',
      match: {
        python: {all: [/MAX_QUERY_BYTES/, /\b413\b/, /\.encode\(/]},
        typescript: {all: [/MAX_QUERY_BYTES/, /\b413\b/, /TextEncoder|Buffer\.byteLength/]},
        go: {all: [/maxQueryBytes/, /StatusRequestEntityTooLarge|\b413\b/]},
        scala: {all: [/MaxQueryBytes/, /PayloadTooLarge|RequestEntityTooLarge|\b413\b/, /getBytes\(/]},
        cpp: {all: [/kMaxQueryBytes/, /\b413\b/]},
      },
    },
    {
      id: 'candidate-cap',
      title: 'Answers 400 for more than 200 candidates',
      detail:
        'More than `MAX_CANDIDATES` (200) candidates answers **400**, checked before the scoring loop; 200 are served. The starter scores whatever it is sent.',
      match: {
        python: {all: [/MAX_CANDIDATES/, /\b400\b/], order: [/>\s*MAX_CANDIDATES/, /\bscore\(/]},
        typescript: {all: [/MAX_CANDIDATES/, /\b400\b/], order: [/>\s*MAX_CANDIDATES/, /\bscore\(/]},
        go: {all: [/maxCandidates/, /StatusBadRequest|\b400\b/], order: [/>\s*maxCandidates/, /model\.Score\(/]},
        scala: {all: [/MaxCandidates/, /BadRequest/], order: [/>\s*MaxCandidates/, /Model\.score\(/]},
        cpp: {all: [/kMaxCandidates/, /\b400\b/], order: [/>\s*kMaxCandidates/, /model::score\(/]},
      },
    },
    {
      id: 'truncation-reported',
      title: 'Cuts a passage at 4 KiB of UTF-8 and reports it',
      detail:
        'A text over `MAX_PASSAGE_BYTES` (4096 bytes, counted in UTF-8: 2500 accented letters are over it) is scored cut and its result says `truncated: true`; every other result says `false`. The starter cuts 4096 characters and says nothing.',
      match: {
        python: {all: [/MAX_PASSAGE_BYTES/, /["']truncated["']/]},
        typescript: {all: [/MAX_PASSAGE_BYTES/, /truncated/]},
        go: {all: [/maxPassageBytes/, /json:"truncated"/]},
        scala: {all: [/MaxPassageBytes/, /"truncated"/]},
        cpp: {all: [/kMaxPassageBytes/, /"truncated"/]},
      },
    },
    {
      id: 'tie-break',
      title: 'Sorts by score, ties by passage id',
      detail:
        'Results come back by score descending and equal scores by `passage_id` ascending, whatever order the candidates were sent in. The starter answers in input order.',
      match: {
        python: {all: [/sort(ed)?\([\s\S]{0,200}?passage_id/]},
        typescript: {all: [/\.sort\([\s\S]{0,200}?passage_id/]},
        go: {all: [/sort\.(Slice|SliceStable)\([\s\S]{0,300}?PassageID|slices\.SortFunc\([\s\S]{0,300}?PassageID/]},
        scala: {all: [/sort(By|With)\([\s\S]{0,200}?passageId/]},
        cpp: {all: [/std::(stable_)?sort\([\s\S]{0,300}?passage_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from rerank.model import score  # the cross-encoder stand-in, in process — provided

app = FastAPI()


@app.post("/v1/rerank")
async def rerank(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if not request.headers.get("x-tenant-id"):
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    body = await request.json()
    query = body.get("query", "")
    results = []
    for candidate in body.get("candidates", []):
        text = candidate["text"][:4096]
        results.append({"passage_id": candidate["passage_id"], "score": score(query, text)})
    return JSONResponse({"results": results})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from rerank.model import score  # the cross-encoder stand-in, in process — provided

app = FastAPI()

MAX_QUERY_BYTES = 2 * 1024
MAX_CANDIDATES = 200
MAX_PASSAGE_BYTES = 4 * 1024


def clip(text: str, limit: int) -> tuple[str, bool]:
    """The text cut to at most limit UTF-8 bytes on a character boundary, and whether it was cut."""
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text, False
    return raw[:limit].decode("utf-8", "ignore"), True


@app.post("/v1/rerank")
async def rerank(request: Request) -> JSONResponse:
    if not request.headers.get("x-tenant-id"):
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    body = await request.json()
    query = body.get("query", "")
    candidates = body.get("candidates", [])
    # The caps run before the model: a refused request costs a parse, not a model call.
    if len(query.encode("utf-8")) > MAX_QUERY_BYTES:
        return JSONResponse({"error": "query exceeds 2 KiB"}, status_code=413)
    if len(candidates) > MAX_CANDIDATES:
        return JSONResponse({"error": "more than 200 candidates"}, status_code=400)
    results = []
    for candidate in candidates:
        text, truncated = clip(candidate["text"], MAX_PASSAGE_BYTES)
        results.append({"passage_id": candidate["passage_id"], "score": score(query, text), "truncated": truncated})
    results.sort(key=lambda r: (-r["score"], r["passage_id"]))
    return JSONResponse({"results": results})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {score} from 'rerank/model'; // the cross-encoder stand-in, in process — provided

export const app = Fastify();

interface RerankBody {
  query: string;
  candidates: {passage_id: string; text: string}[];
}

app.post('/v1/rerank', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {query, candidates} = request.body as RerankBody;
  const results = candidates.map(c => ({passage_id: c.passage_id, score: score(query, c.text.slice(0, 4096))}));
  return {results};
});
`,
      solution: `import Fastify from 'fastify';

import {score} from 'rerank/model'; // the cross-encoder stand-in, in process — provided

export const app = Fastify();

const MAX_QUERY_BYTES = 2 * 1024;
const MAX_CANDIDATES = 200;
const MAX_PASSAGE_BYTES = 4 * 1024;

interface RerankBody {
  query: string;
  candidates: {passage_id: string; text: string}[];
}

const utf8 = new TextEncoder();

/** The text cut to at most limit UTF-8 bytes on a character boundary, and whether it was cut. */
function clip(text: string, limit: number): [string, boolean] {
  const raw = utf8.encode(text);
  if (raw.length <= limit) return [text, false];
  let end = limit;
  while (end > 0 && (raw[end] & 0xc0) === 0x80) end -= 1; // a continuation byte: step back to the character's start
  return [new TextDecoder().decode(raw.subarray(0, end)), true];
}

app.post('/v1/rerank', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {query, candidates} = request.body as RerankBody;
  // The caps run before the model: a refused request costs a parse, not a model call.
  if (utf8.encode(query).length > MAX_QUERY_BYTES) return reply.code(413).send({error: 'query exceeds 2 KiB'});
  if (candidates.length > MAX_CANDIDATES) return reply.code(400).send({error: 'more than 200 candidates'});
  const results = candidates.map(c => {
    const [text, truncated] = clip(c.text, MAX_PASSAGE_BYTES);
    return {passage_id: c.passage_id, score: score(query, text), truncated};
  });
  results.sort((a, b) => b.score - a.score || (a.passage_id < b.passage_id ? -1 : a.passage_id > b.passage_id ? 1 : 0));
  return {results};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"rerank/model" // model.Score(query, passage): the cross-encoder stand-in, in process — provided
)

type candidate struct {
	PassageID string \`json:"passage_id"\`
	Text      string \`json:"text"\`
}

type rerankRequest struct {
	Query      string      \`json:"query"\`
	Candidates []candidate \`json:"candidates"\`
}

type result struct {
	PassageID string  \`json:"passage_id"\`
	Score     float64 \`json:"score"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func rerank(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	if r.Header.Get("X-Tenant-Id") == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body rerankRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "body must be JSON"})
		return
	}
	results := make([]result, 0, len(body.Candidates))
	for _, c := range body.Candidates {
		text := c.Text
		if len(text) > 4096 {
			text = text[:4096]
		}
		results = append(results, result{PassageID: c.PassageID, Score: model.Score(body.Query, text)})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"results": results})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/rerank", rerank)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"unicode/utf8"

	"rerank/model" // model.Score(query, passage): the cross-encoder stand-in, in process — provided
)

const (
	maxQueryBytes   = 2 * 1024
	maxCandidates   = 200
	maxPassageBytes = 4 * 1024
)

type candidate struct {
	PassageID string \`json:"passage_id"\`
	Text      string \`json:"text"\`
}

type rerankRequest struct {
	Query      string      \`json:"query"\`
	Candidates []candidate \`json:"candidates"\`
}

type result struct {
	PassageID string  \`json:"passage_id"\`
	Score     float64 \`json:"score"\`
	Truncated bool    \`json:"truncated"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// clip cuts text to at most limit bytes on a character boundary and reports whether it cut.
func clip(text string, limit int) (string, bool) {
	if len(text) <= limit {
		return text, false
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end], true
}

func rerank(rw http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Tenant-Id") == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body rerankRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "body must be JSON"})
		return
	}
	// The caps run before the model: a refused request costs a parse, not a model call.
	if len(body.Query) > maxQueryBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "query exceeds 2 KiB"})
		return
	}
	if len(body.Candidates) > maxCandidates {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "more than 200 candidates"})
		return
	}
	results := make([]result, 0, len(body.Candidates))
	for _, c := range body.Candidates {
		text, truncated := clip(c.Text, maxPassageBytes)
		results = append(results, result{PassageID: c.PassageID, Score: model.Score(body.Query, text), Truncated: truncated})
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		return results[i].PassageID < results[j].PassageID
	})
	writeJSON(rw, http.StatusOK, map[string]any{"results": results})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/rerank", rerank)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import rerank.Model // Model.score(query, passage): the cross-encoder stand-in, in process — provided

object RerankApi {
  private def json(status: StatusCode, body: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))

  val route: Route = path("v1" / "rerank") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id")))
        case Some(_) =>
          entity(as[String]) { raw =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val body = ujson.read(raw)
            val query = body("query").str
            val results = body("candidates").arr.toSeq.map { c =>
              ujson.Obj("passage_id" -> c("passage_id").str, "score" -> Model.score(query, c("text").str.take(4096)))
            }
            complete(json(StatusCodes.OK, ujson.Obj("results" -> ujson.Arr.from(results))))
          }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import rerank.Model // Model.score(query, passage): the cross-encoder stand-in, in process — provided

object RerankApi {
  val MaxQueryBytes = 2 * 1024
  val MaxCandidates = 200
  val MaxPassageBytes = 4 * 1024

  private def json(status: StatusCode, body: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))

  /** The text cut to at most limit UTF-8 bytes on a character boundary, and whether it was cut. */
  private def clip(text: String, limit: Int): (String, Boolean) = {
    val raw = text.getBytes(UTF_8)
    if (raw.length <= limit) (text, false)
    else {
      var end = limit
      while (end > 0 && (raw(end) & 0xc0) == 0x80) end -= 1 // a continuation byte: step back to the character's start
      (new String(raw, 0, end, UTF_8), true)
    }
  }

  private final case class Scored(passageId: String, score: Double, truncated: Boolean)

  val route: Route = path("v1" / "rerank") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id")))
        case Some(_) =>
          entity(as[String]) { raw =>
            val body = ujson.read(raw)
            val query = body("query").str
            val candidates = body("candidates").arr.toSeq
            // The caps run before the model: a refused request costs a parse, not a model call.
            if (query.getBytes(UTF_8).length > MaxQueryBytes)
              complete(json(StatusCodes.PayloadTooLarge, ujson.Obj("error" -> "query exceeds 2 KiB")))
            else if (candidates.length > MaxCandidates)
              complete(json(StatusCodes.BadRequest, ujson.Obj("error" -> "more than 200 candidates")))
            else {
              val scored = candidates.map { c =>
                val (text, truncated) = clip(c("text").str, MaxPassageBytes)
                Scored(c("passage_id").str, Model.score(query, text), truncated)
              }
              val results = scored.sortBy(r => (-r.score, r.passageId)).map { r =>
                ujson.Obj("passage_id" -> r.passageId, "score" -> r.score, "truncated" -> r.truncated)
              }
              complete(json(StatusCodes.OK, ujson.Obj("results" -> ujson.Arr.from(results))))
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

#include "rerank/model.h"  // model::score(query, passage): the cross-encoder stand-in, in process — provided

using json = nlohmann::json;

void rerank(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  if (req.get_header_value("X-Tenant-Id").empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content(R"({"error":"body must be JSON"})", "application/json");
    return;
  }
  const std::string query = body.value("query", "");
  json results = json::array();
  for (const json& c : body.value("candidates", json::array())) {
    const std::string text = c.value("text", "").substr(0, 4096);
    results.push_back({{"passage_id", c.value("passage_id", "")}, {"score", model::score(query, text)}});
  }
  res.set_content(json{{"results", results}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/rerank", rerank); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "rerank/model.h"  // model::score(query, passage): the cross-encoder stand-in, in process — provided

using json = nlohmann::json;

constexpr size_t kMaxQueryBytes = 2 * 1024;
constexpr size_t kMaxCandidates = 200;
constexpr size_t kMaxPassageBytes = 4 * 1024;

struct Scored {
  std::string passage_id;
  double score = 0;
  bool truncated = false;
};

// The text cut to at most limit bytes on a character boundary, and whether it was cut.
std::pair<std::string, bool> clip(const std::string& text, size_t limit) {
  if (text.size() <= limit) return {text, false};
  size_t end = limit;
  while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xc0) == 0x80) end--;  // a continuation byte
  return {text.substr(0, end), true};
}

void rerank(const httplib::Request& req, httplib::Response& res) {
  if (req.get_header_value("X-Tenant-Id").empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content(R"({"error":"body must be JSON"})", "application/json");
    return;
  }
  const std::string query = body.value("query", "");
  const json candidates = body.value("candidates", json::array());
  // The caps run before the model: a refused request costs a parse, not a model call.
  if (query.size() > kMaxQueryBytes) {
    res.status = 413;
    res.set_content(R"({"error":"query exceeds 2 KiB"})", "application/json");
    return;
  }
  if (candidates.size() > kMaxCandidates) {
    res.status = 400;
    res.set_content(R"({"error":"more than 200 candidates"})", "application/json");
    return;
  }
  std::vector<Scored> scored;
  for (const json& c : candidates) {
    const auto [text, truncated] = clip(c.value("text", ""), kMaxPassageBytes);
    scored.push_back({c.value("passage_id", ""), model::score(query, text), truncated});
  }
  std::sort(scored.begin(), scored.end(), [](const Scored& a, const Scored& b) {
    return a.score != b.score ? a.score > b.score : a.passage_id < b.passage_id;
  });
  json results = json::array();
  for (const Scored& r : scored) {
    results.push_back({{"passage_id", r.passage_id}, {"score", r.score}, {"truncated", r.truncated}});
  }
  res.set_content(json{{"results", results}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/rerank", rerank); }
`,
    },
  },
  harness: {
    python: `TENANT = {"X-Tenant-Id": "t-acme"}
QUERY = "solar panel efficiency"


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _rerank(c, query, candidates, headers=TENANT):
    return await c.post("/v1/rerank", json={"query": query, "candidates": candidates}, headers=headers)


def _cand(passage_id, text):
    return {"passage_id": passage_id, "text": text}


def _by_id(r):
    return {item.get("passage_id"): item for item in r.json().get("results", [])}


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _rerank(c, QUERY, [_cand("p-1", "solar panel efficiency in winter"), _cand("p-2", "wind turbines")])
        assert r.status_code == 200, f"POST /v1/rerank answered {r.status_code}: {r.text}"
        results = r.json().get("results")
        assert isinstance(results, list) and len(results) == 2, f"two candidates must answer two results, got {r.text}"
        scores = {item.get("passage_id"): item.get("score") for item in results}
        assert abs(scores.get("p-1", -1) - 1.0) < 1e-6 and abs(scores.get("p-2", -1)) < 1e-6, f"the scores must be the model's (p-1 1.0, p-2 0.0), got {scores}"
        none = await _rerank(c, QUERY, [_cand("p-1", "solar")], headers={})
    assert none.status_code == 401, f"a request without X-Tenant-Id answered {none.status_code}, expected 401"


async def check_query_cap(ctx):
    async with _api(ctx) as c:
        long = await _rerank(c, "solar " * 400, [_cand("p-1", "solar")])
        assert long.status_code == 413, f"a 2400-byte query answered {long.status_code}, expected 413: the query goes to the model whole"
        wide = await _rerank(c, "\\u00e9" * 1100, [_cand("p-1", "solar")])
        assert wide.status_code == 413, f"a query of 1100 accented letters (2200 bytes of UTF-8) answered {wide.status_code}, expected 413: the cap counts bytes, not characters"
        edge = await _rerank(c, "a" * 2048, [_cand("p-1", "solar")])
    assert edge.status_code == 200, f"a query of exactly 2048 bytes answered {edge.status_code}, expected 200"


async def check_candidate_cap(ctx):
    async with _api(ctx) as c:
        over = await _rerank(c, QUERY, [_cand(f"p-{i:03d}", "solar panel") for i in range(201)])
        assert over.status_code == 400, f"201 candidates answered {over.status_code}, expected 400: one caller sets the model bill"
        edge = await _rerank(c, QUERY, [_cand(f"p-{i:03d}", "solar panel") for i in range(200)])
    assert edge.status_code == 200, f"200 candidates answered {edge.status_code}, expected 200"
    assert len(edge.json().get("results", [])) == 200, "200 candidates must answer 200 results"


async def check_truncation_reported(ctx):
    async with _api(ctx) as c:
        r = await _rerank(c, "solar", [
            _cand("long", "panel " * 1000 + "solar"),
            _cand("exact", "y" * 4096),
            _cand("wide", "\\u00e9" * 2500),
            _cand("short", "solar power"),
        ])
    assert r.status_code == 200, f"POST /v1/rerank answered {r.status_code}: {r.text}"
    results = _by_id(r)
    flags = {pid: item.get("truncated") for pid, item in results.items()}
    assert flags.get("long") is True, f"a 6005-byte passage must come back truncated: true, got {flags}"
    assert flags.get("wide") is True, f"2500 accented letters are 5000 bytes of UTF-8 and must come back truncated: true, got {flags}: the cap counts bytes, not characters"
    assert flags.get("exact") is False and flags.get("short") is False, f"passages within 4096 bytes must say truncated: false, got {flags}"
    assert abs(results["long"].get("score", -1)) < 1e-6, f"the long passage's only 'solar' sits past 4 KiB: scored cut, its score is 0.0, got {results['long']}"


async def check_tie_break(ctx):
    candidates = [
        _cand("p-4", "unrelated text"),
        _cand("p-2", "solar output"),
        _cand("p-1", "panel cost"),
        _cand("p-3", "solar panel efficiency"),
    ]
    async with _api(ctx) as c:
        first = await _rerank(c, QUERY, candidates)
        second = await _rerank(c, QUERY, list(reversed(candidates)))
    order = [item.get("passage_id") for item in first.json().get("results", [])]
    assert order == ["p-3", "p-1", "p-2", "p-4"], f"expected score descending, ties by passage_id (p-3, p-1, p-2, p-4), got {order}"
    again = [item.get("passage_id") for item in second.json().get("results", [])]
    assert again == order, f"the same candidates sent in another order came back as {again}, first as {order}: a tie must not follow the client's order"
`,
    typescript: `const TENANT = {'X-Tenant-Id': 't-acme'};
const QUERY = 'solar panel efficiency';

const cand = (passage_id: string, text: string) => ({passage_id, text});

function api(ctx) {
  return ctx.client(ctx.load('api').app);
}

const rerank = (c, query: string, candidates, headers: Record<string, string> = TENANT) => c.post('/v1/rerank', {json: {query, candidates}, headers});

const byId = r => Object.fromEntries((r.json().results ?? []).map(item => [item.passage_id, item]));

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await rerank(c, QUERY, [cand('p-1', 'solar panel efficiency in winter'), cand('p-2', 'wind turbines')]);
  assert.equal(r.status, 200, \`POST /v1/rerank answered \${r.status}: \${r.text}\`);
  const results = r.json().results;
  assert(Array.isArray(results) && results.length === 2, \`two candidates must answer two results, got \${r.text}\`);
  const scores = Object.fromEntries(results.map(item => [item.passage_id, item.score]));
  assert(Math.abs(scores['p-1'] - 1) < 1e-6 && Math.abs(scores['p-2']) < 1e-6, \`the scores must be the model's (p-1 1.0, p-2 0.0), got \${JSON.stringify(scores)}\`);
  const none = await rerank(c, QUERY, [cand('p-1', 'solar')], {});
  assert.equal(none.status, 401, \`a request without X-Tenant-Id answered \${none.status}, expected 401\`);
}

export async function check_query_cap(ctx) {
  const c = api(ctx);
  const long = await rerank(c, 'solar '.repeat(400), [cand('p-1', 'solar')]);
  assert.equal(long.status, 413, \`a 2400-byte query answered \${long.status}, expected 413: the query goes to the model whole\`);
  const wide = await rerank(c, '\\u00e9'.repeat(1100), [cand('p-1', 'solar')]);
  assert.equal(wide.status, 413, \`a query of 1100 accented letters (2200 bytes of UTF-8) answered \${wide.status}, expected 413: the cap counts bytes, not characters\`);
  const edge = await rerank(c, 'a'.repeat(2048), [cand('p-1', 'solar')]);
  assert.equal(edge.status, 200, \`a query of exactly 2048 bytes answered \${edge.status}, expected 200\`);
}

export async function check_candidate_cap(ctx) {
  const c = api(ctx);
  const many = (n: number) => Array.from({length: n}, (_, i) => cand(\`p-\${String(i).padStart(3, '0')}\`, 'solar panel'));
  const over = await rerank(c, QUERY, many(201));
  assert.equal(over.status, 400, \`201 candidates answered \${over.status}, expected 400: one caller sets the model bill\`);
  const edge = await rerank(c, QUERY, many(200));
  assert.equal(edge.status, 200, \`200 candidates answered \${edge.status}, expected 200\`);
  assert.equal((edge.json().results ?? []).length, 200, '200 candidates must answer 200 results');
}

export async function check_truncation_reported(ctx) {
  const c = api(ctx);
  const r = await rerank(c, 'solar', [
    cand('long', 'panel '.repeat(1000) + 'solar'),
    cand('exact', 'y'.repeat(4096)),
    cand('wide', '\\u00e9'.repeat(2500)),
    cand('short', 'solar power'),
  ]);
  assert.equal(r.status, 200, \`POST /v1/rerank answered \${r.status}: \${r.text}\`);
  const results = byId(r);
  const flags = Object.fromEntries(Object.entries(results).map(([id, item]) => [id, (item as {truncated?: boolean}).truncated]));
  assert.equal(flags.long, true, \`a 6005-byte passage must come back truncated: true, got \${JSON.stringify(flags)}\`);
  assert.equal(flags.wide, true, \`2500 accented letters are 5000 bytes of UTF-8 and must come back truncated: true, got \${JSON.stringify(flags)}: the cap counts bytes, not characters\`);
  assert(flags.exact === false && flags.short === false, \`passages within 4096 bytes must say truncated: false, got \${JSON.stringify(flags)}\`);
  assert(Math.abs(results.long.score) < 1e-6, \`the long passage's only 'solar' sits past 4 KiB: scored cut, its score is 0, got \${JSON.stringify(results.long)}\`);
}

export async function check_tie_break(ctx) {
  const c = api(ctx);
  const candidates = [cand('p-4', 'unrelated text'), cand('p-2', 'solar output'), cand('p-1', 'panel cost'), cand('p-3', 'solar panel efficiency')];
  const first = await rerank(c, QUERY, candidates);
  const second = await rerank(c, QUERY, [...candidates].reverse());
  const order = (first.json().results ?? []).map(item => item.passage_id);
  assert.deepEqual(order, ['p-3', 'p-1', 'p-2', 'p-4'], \`expected score descending, ties by passage_id (p-3, p-1, p-2, p-4), got \${JSON.stringify(order)}\`);
  const again = (second.json().results ?? []).map(item => item.passage_id);
  assert.deepEqual(again, order, \`the same candidates sent in another order came back as \${JSON.stringify(again)}: a tie must not follow the client's order\`);
}
`,
    go: `package main

import (
	"fmt"
	"math"
	"net/http"
	"strings"

	"leetbuild/harness"
)

const apiQuery = "solar panel efficiency"

type apiResult struct {
	PassageID string   \`json:"passage_id"\`
	Score     float64  \`json:"score"\`
	Truncated *bool    \`json:"truncated"\`
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiCand(id, text string) map[string]string { return map[string]string{"passage_id": id, "text": text} }

func apiRerank(c *harness.HTTP, query string, candidates []map[string]string, header ...string) *harness.Response {
	if header == nil {
		header = []string{"X-Tenant-Id", "t-acme"}
	}
	return c.Post("/v1/rerank", map[string]any{"query": query, "candidates": candidates}, header...)
}

func apiResults(r *harness.Response) []apiResult {
	var body struct {
		Results []apiResult \`json:"results"\`
	}
	r.Decode(&body)
	return body.Results
}

func apiByID(r *harness.Response) map[string]apiResult {
	out := map[string]apiResult{}
	for _, item := range apiResults(r) {
		out[item.PassageID] = item
	}
	return out
}

func apiFlag(item apiResult) string {
	if item.Truncated == nil {
		return "missing"
	}
	return fmt.Sprint(*item.Truncated)
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiRerank(c, apiQuery, []map[string]string{apiCand("p-1", "solar panel efficiency in winter"), apiCand("p-2", "wind turbines")})
	ctx.Equal(r.Status, 200, "POST /v1/rerank (%s)", r.Text())
	results := apiByID(r)
	ctx.Equal(len(results), 2, "two candidates must answer two results (%s)", r.Text())
	ctx.Assert(math.Abs(results["p-1"].Score-1) < 1e-6 && math.Abs(results["p-2"].Score) < 1e-6, "the scores must be the model's (p-1 1.0, p-2 0.0), got %s", r.Text())
	none := apiRerank(c, apiQuery, []map[string]string{apiCand("p-1", "solar")}, "X-Request-Id", "r-1")
	ctx.Equal(none.Status, 401, "a request without X-Tenant-Id")
}

func CheckQueryCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	one := []map[string]string{apiCand("p-1", "solar")}
	long := apiRerank(c, strings.Repeat("solar ", 400), one)
	ctx.Equal(long.Status, 413, "a 2400-byte query must be refused before the model sees it; the status")
	wide := apiRerank(c, strings.Repeat("\\u00e9", 1100), one)
	ctx.Equal(wide.Status, 413, "a query of 1100 accented letters (2200 bytes of UTF-8): the cap counts bytes; the status")
	edge := apiRerank(c, strings.Repeat("a", 2048), one)
	ctx.Equal(edge.Status, 200, "a query of exactly 2048 bytes (%s)", edge.Text())
}

func CheckCandidateCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	many := func(n int) []map[string]string {
		out := make([]map[string]string, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, apiCand(fmt.Sprintf("p-%03d", i), "solar panel"))
		}
		return out
	}
	over := apiRerank(c, apiQuery, many(201))
	ctx.Equal(over.Status, 400, "201 candidates must be refused (one caller sets the model bill); the status")
	edge := apiRerank(c, apiQuery, many(200))
	ctx.Equal(edge.Status, 200, "200 candidates (%s)", edge.Text())
	ctx.Equal(len(apiResults(edge)), 200, "200 candidates must answer 200 results")
}

func CheckTruncationReported(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiRerank(c, "solar", []map[string]string{
		apiCand("long", strings.Repeat("panel ", 1000)+"solar"),
		apiCand("exact", strings.Repeat("y", 4096)),
		apiCand("wide", strings.Repeat("\\u00e9", 2500)),
		apiCand("short", "solar power"),
	})
	ctx.Equal(r.Status, 200, "POST /v1/rerank (%s)", r.Text())
	results := apiByID(r)
	ctx.Equal(apiFlag(results["long"]), "true", "a 6005-byte passage must come back truncated: true; truncated")
	ctx.Equal(apiFlag(results["wide"]), "true", "2500 accented letters are 5000 bytes of UTF-8 and must come back truncated: true; truncated")
	ctx.Assert(apiFlag(results["exact"]) == "false" && apiFlag(results["short"]) == "false", "passages within 4096 bytes must say truncated: false, got exact %s, short %s", apiFlag(results["exact"]), apiFlag(results["short"]))
	ctx.Assert(math.Abs(results["long"].Score) < 1e-6, "the long passage's only 'solar' sits past 4 KiB: scored cut, its score is 0, got %v", results["long"].Score)
}

func CheckTieBreak(ctx *harness.Ctx) {
	c := apiClient(ctx)
	candidates := []map[string]string{apiCand("p-4", "unrelated text"), apiCand("p-2", "solar output"), apiCand("p-1", "panel cost"), apiCand("p-3", "solar panel efficiency")}
	reversed := []map[string]string{candidates[3], candidates[2], candidates[1], candidates[0]}
	ids := func(r *harness.Response) []string {
		out := []string{}
		for _, item := range apiResults(r) {
			out = append(out, item.PassageID)
		}
		return out
	}
	order := ids(apiRerank(c, apiQuery, candidates))
	ctx.Equal(order, []string{"p-3", "p-1", "p-2", "p-4"}, "score descending, ties by passage_id; the order")
	ctx.Equal(ids(apiRerank(c, apiQuery, reversed)), order, "the same candidates sent in another order (a tie must not follow the client's order); the order")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace {

const std::string kQuery = "solar panel efficiency";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json cand(const std::string& id, const std::string& text) { return {{"passage_id", id}, {"text", text}}; }

std::string repeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}

harness::Response rerankWith(harness::HTTP& c, const std::string& query, const nlohmann::json& candidates, bool tenant = true) {
  const std::string body = nlohmann::json{{"query", query}, {"candidates", candidates}}.dump();
  if (!tenant) return c.Post("/v1/rerank", body, "Content-Type", "application/json");
  return c.Post("/v1/rerank", body, "Content-Type", "application/json", "X-Tenant-Id", "t-acme");
}

nlohmann::json resultsOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() && body.contains("results") && body["results"].is_array() ? body["results"] : nlohmann::json::array();
}

std::map<std::string, nlohmann::json> byId(const harness::Response& r) {
  std::map<std::string, nlohmann::json> out;
  for (const auto& item : resultsOf(r)) out[item.value("passage_id", "")] = item;
  return out;
}

std::string flag(const nlohmann::json& item) {
  if (!item.is_object() || !item.contains("truncated") || !item["truncated"].is_boolean()) return "missing";
  return item["truncated"].get<bool>() ? "true" : "false";
}

std::vector<std::string> ids(const harness::Response& r) {
  std::vector<std::string> out;
  for (const auto& item : resultsOf(r)) out.push_back(item.value("passage_id", ""));
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = rerankWith(c, kQuery, nlohmann::json::array({cand("p-1", "solar panel efficiency in winter"), cand("p-2", "wind turbines")}));
  ctx.Equal(r.Status, 200, "POST /v1/rerank (%s)", r.Text());
  auto results = byId(r);
  ctx.Equal(results.size(), 2, "two candidates must answer two results (%s)", r.Text());
  ctx.Assert(std::fabs(results["p-1"].value("score", -1.0) - 1) < 1e-6 && std::fabs(results["p-2"].value("score", -1.0)) < 1e-6,
             "the scores must be the model's (p-1 1.0, p-2 0.0), got %s", r.Text());
  const auto none = rerankWith(c, kQuery, nlohmann::json::array({cand("p-1", "solar")}), false);
  ctx.Equal(none.Status, 401, "a request without X-Tenant-Id");
}

void CheckQueryCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto one = nlohmann::json::array({cand("p-1", "solar")});
  ctx.Equal(rerankWith(c, repeat("solar ", 400), one).Status, 413, "a 2400-byte query must be refused before the model sees it; the status");
  ctx.Equal(rerankWith(c, repeat("\\xc3\\xa9", 1100), one).Status, 413, "a query of 1100 accented letters (2200 bytes of UTF-8): the cap counts bytes; the status");
  const auto edge = rerankWith(c, repeat("a", 2048), one);
  ctx.Equal(edge.Status, 200, "a query of exactly 2048 bytes (%s)", edge.Text());
}

void CheckCandidateCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto many = [](int n) {
    nlohmann::json out = nlohmann::json::array();
    char id[16];
    for (int i = 0; i < n; i++) {
      std::snprintf(id, sizeof id, "p-%03d", i);
      out.push_back(cand(id, "solar panel"));
    }
    return out;
  };
  ctx.Equal(rerankWith(c, kQuery, many(201)).Status, 400, "201 candidates must be refused (one caller sets the model bill); the status");
  const auto edge = rerankWith(c, kQuery, many(200));
  ctx.Equal(edge.Status, 200, "200 candidates");
  ctx.Equal(resultsOf(edge).size(), 200, "200 candidates must answer 200 results");
}

void CheckTruncationReported(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = rerankWith(c, "solar", nlohmann::json::array({cand("long", repeat("panel ", 1000) + "solar"), cand("exact", repeat("y", 4096)),
                                                               cand("wide", repeat("\\xc3\\xa9", 2500)), cand("short", "solar power")}));
  ctx.Equal(r.Status, 200, "POST /v1/rerank");
  auto results = byId(r);
  ctx.Equal(flag(results["long"]), "true", "a 6005-byte passage must come back truncated: true; truncated");
  ctx.Equal(flag(results["wide"]), "true", "2500 accented letters are 5000 bytes of UTF-8 and must come back truncated: true; truncated");
  ctx.Assert(flag(results["exact"]) == "false" && flag(results["short"]) == "false", "passages within 4096 bytes must say truncated: false, got exact %s, short %s",
             flag(results["exact"]), flag(results["short"]));
  ctx.Assert(std::fabs(results["long"].value("score", -1.0)) < 1e-6, "the long passage's only 'solar' sits past 4 KiB: scored cut, its score is 0, got %s",
             results["long"].dump());
}

void CheckTieBreak(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto candidates = nlohmann::json::array({cand("p-4", "unrelated text"), cand("p-2", "solar output"), cand("p-1", "panel cost"), cand("p-3", "solar panel efficiency")});
  const auto reversed = nlohmann::json::array({candidates[3], candidates[2], candidates[1], candidates[0]});
  const auto order = ids(rerankWith(c, kQuery, candidates));
  ctx.Equal(order, std::vector<std::string>{"p-3", "p-1", "p-2", "p-4"}, "score descending, ties by passage_id; the order");
  ctx.Equal(ids(rerankWith(c, kQuery, reversed)), order, "the same candidates sent in another order (a tie must not follow the client's order); the order");
}
`,
  },
  hints: [
    'Send a 3 KB query or 201 candidates and the service scores them all; send a 5 KB passage and its score comes back unmarked; send three tied passages in two orders and get two different lists.',
    'No limit runs before the scoring loop; `text[:4096]` cuts characters, not bytes, and the cut is not reported; the results keep input order, so a tie follows whoever built the request.',
    'Before scoring: query bytes over `MAX_QUERY_BYTES` → 413, more than `MAX_CANDIDATES` → 400. Cut each text to `MAX_PASSAGE_BYTES` UTF-8 bytes, return `truncated`, then sort by `(-score, passage_id)`.',
  ],
  debrief: `The caps sit in front of the scoring loop because the model is where the money goes: a refused request costs a parse. They count UTF-8 bytes because the model's budget is bytes (tokens, really), and an accented query is twice its character count. The cut is reported rather than logged because only the caller knows whether the first 4 KiB is enough for its use. The tie-break is part of the sort key: input order belongs to the retriever and changes between runs, so a stable sort would only preserve someone else's noise. A production endpoint counts tokens with the model's own tokenizer, and budgets candidates per tenant over a window, so one caller cannot spend the fleet's capacity in many small requests.`,
};
