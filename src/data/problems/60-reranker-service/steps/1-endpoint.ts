import type {Step} from '@/lib/types';

export const rerankEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/rerank: candidates with a hard cap',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'reranker'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a scored list. It compiles, it serves the demo, and it hides four production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/rerank\` with body \`{"query": "…", "candidates": [{"passage_id": "…", "text": "…"}]}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`query\` is a non-empty string of at most **2 KiB** (\`2 * 1024\` bytes) of UTF-8; a larger query
  is **413**.
- \`candidates\` holds at most **200** entries (**400** above that), so one request can never push an
  unbounded amount of text through the model.
- Each \`text\` is at most **4 KiB**. A longer passage is clipped for scoring, and the result for that
  passage carries \`truncated: true\` so a score of clipped text is never presented as a score of the
  full passage.
- Results are ordered by score descending and broken by \`passage_id\` ascending, so equal scores
  always come out in the same order.
- Log the decision with tenant and candidate count — never the query or passage text.

**Failure mode the checks target.** The draft scores every candidate it is handed, clips long
passages silently, and returns input order. Unbounded candidates let one request set the budget;
silent clipping makes a score describe text the model never saw; input order makes ties
irreproducible for a client that wants to cache or diff the list.`,
  sequence: {
    participants: ['Client', 'Rerank API', 'Reranker model'],
    messages: [
      {from: 'Client', to: 'Rerank API', label: 'POST /v1/rerank · query · candidates', kind: 'sync'},
      {from: 'Rerank API', to: 'Rerank API', label: 'validate tenant · query bytes · candidate count', kind: 'sync'},
      {from: 'Rerank API', to: 'Reranker model', label: 'score clipped passages', kind: 'sync'},
      {from: 'Reranker model', to: 'Rerank API', label: 'scores', kind: 'reply'},
      {from: 'Rerank API', to: 'Rerank API', label: 'sort by score, then passage_id', kind: 'sync'},
      {from: 'Rerank API', to: 'Client', label: '200 {results, truncated}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/rerank',
      detail: 'Register the rerank route on `POST /v1/rerank`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/rerank["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/rerank['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/rerank"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"rerank"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/rerank"/]},
      },
    },
    {
      id: 'candidate-cap',
      title: 'Enforces the 200-candidate cap',
      detail:
        'A request with more than `200` candidates is rejected with **400** before any scoring work. The draft scores whatever it is handed, so one request can set the cost.',
      match: {
        python: {all: [/MAX_CANDIDATES/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_CANDIDATES/, /code\(\s*400\s*\)/]},
        go: {all: [/maxCandidates/, /StatusBadRequest/]},
        scala: {all: [/MaxCandidates/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxCandidates/, /\b400\b/]},
      },
    },
    {
      id: 'query-cap',
      title: 'Enforces the 2 KiB query cap',
      detail:
        'A query over `2 * 1024` bytes is rejected with **413**. The draft passes any query straight to the model.',
      match: {
        python: {all: [/MAX_QUERY_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_QUERY_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxQueryBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxQueryBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxQueryBytes/, /\b413\b/]},
      },
    },
    {
      id: 'truncation-reported',
      title: 'Reports truncation per passage',
      detail:
        'A passage over `4 KiB` is clipped and the response marks that passage `truncated`, so a score of clipped text is never read as the score of the full passage. The draft clips silently.',
      match: {
        python: {all: [/MAX_PASSAGE_BYTES/, /truncated/]},
        typescript: {all: [/MAX_PASSAGE_BYTES/, /truncated/]},
        go: {all: [/maxPassageBytes/, /Truncated/]},
        scala: {all: [/MaxPassageBytes/, /truncated/i]},
        cpp: {all: [/kMaxPassageBytes/, /truncated/]},
      },
    },
    {
      id: 'tie-break',
      title: 'Returns a deterministic order under ties',
      detail:
        'Results are sorted by score and then by passage id, so equal scores always come out in the same order. The draft returns input order.',
      match: {
        python: {all: [/\.sort\(/, /passage_id/]},
        typescript: {all: [/\.sort\(/, /passageId/]},
        go: {all: [/sort\.Slice/, /PassageID/]},
        scala: {all: [/sortBy|sortWith/, /passageId/]},
        cpp: {all: [/std::sort/, /passage_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("rerank")


class Candidate(BaseModel):
    passage_id: str
    text: str


class RerankRequest(BaseModel):
    query: str
    candidates: list[Candidate]


def score_passage(query: str, text: str) -> float:
    """The cross-encoder call; a real deployment batches this over gRPC."""
    return 0.0


@app.post("/v1/rerank")
def rerank(body: RerankRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft scores every candidate it is handed, clips long passages without
    # reporting it, and returns input order. Review the caps, the clipping and the ordering.
    results = []
    for candidate in body.candidates:
        clipped = candidate.text[:4096]
        results.append({"passage_id": candidate.passage_id, "score": score_passage(body.query, clipped)})
    logger.info("rerank tenant=%s candidates=%d", tenant, len(body.candidates))
    return JSONResponse({"results": results}, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("rerank")

MAX_QUERY_BYTES = 2 * 1024
MAX_CANDIDATES = 200
MAX_PASSAGE_BYTES = 4 * 1024


class Candidate(BaseModel):
    passage_id: str
    text: str


class RerankRequest(BaseModel):
    query: str
    candidates: list[Candidate]


def clip_utf8(text: str, limit: int) -> tuple[str, bool]:
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text, False
    return raw[:limit].decode("utf-8", "ignore"), True


def score_passage(query: str, text: str) -> float:
    """The cross-encoder call; a real deployment batches this over gRPC."""
    return 0.0


@app.post("/v1/rerank")
def rerank(body: RerankRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    if len(body.query.encode("utf-8")) > MAX_QUERY_BYTES:
        return JSONResponse({"error": "query exceeds 2 KiB"}, status_code=413)
    if len(body.candidates) > MAX_CANDIDATES:
        return JSONResponse({"error": "candidates exceed 200"}, status_code=400)
    results = []
    for candidate in body.candidates:
        text, truncated = clip_utf8(candidate.text, MAX_PASSAGE_BYTES)
        results.append(
            {
                "passage_id": candidate.passage_id,
                "score": score_passage(body.query, text),
                "truncated": truncated,
            }
        )
    results.sort(key=lambda r: (-r["score"], r["passage_id"]))
    logger.info("rerank tenant=%s candidates=%d", tenant, len(body.candidates))
    return JSONResponse({"results": results}, status_code=200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

const app = Fastify();

interface Candidate {
  passage_id: string;
  text: string;
}

interface RerankBody {
  query: string;
  candidates: Candidate[];
}

function scorePassage(query: string, text: string): number {
  // The cross-encoder call; a real deployment batches this over gRPC.
  return 0;
}

app.post('/v1/rerank', async (request, reply) => {
  // TODO: this draft scores every candidate it is handed, clips long passages without
  // reporting it, and returns input order. Review the caps, the clipping and the ordering.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RerankBody;
  const results = body.candidates.map(candidate => ({
    passage_id: candidate.passage_id,
    score: scorePassage(body.query, candidate.text.slice(0, 4096)),
  }));
  app.log.info({tenant, candidates: results.length}, 'rerank');
  return reply.code(200).send({results});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `import Fastify from 'fastify';

const app = Fastify();

const MAX_QUERY_BYTES = 2 * 1024;
const MAX_CANDIDATES = 200;
const MAX_PASSAGE_BYTES = 4 * 1024;

interface Candidate {
  passage_id: string;
  text: string;
}

interface RerankBody {
  query: string;
  candidates: Candidate[];
}

function clipUtf8(text: string, limit: number): [string, boolean] {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length <= limit) return [text, false];
  return [raw.subarray(0, limit).toString('utf8'), true];
}

function scorePassage(query: string, text: string): number {
  // The cross-encoder call; a real deployment batches this over gRPC.
  return 0;
}

app.post('/v1/rerank', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') {
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  }
  const body = request.body as RerankBody;
  if (Buffer.byteLength(body.query, 'utf8') > MAX_QUERY_BYTES) {
    return reply.code(413).send({error: 'query exceeds 2 KiB'});
  }
  if (body.candidates.length > MAX_CANDIDATES) {
    return reply.code(400).send({error: 'candidates exceed 200'});
  }
  const results = body.candidates.map(candidate => {
    const [text, truncated] = clipUtf8(candidate.text, MAX_PASSAGE_BYTES);
    return {passageId: candidate.passage_id, score: scorePassage(body.query, text), truncated};
  });
  results.sort((a, b) => b.score - a.score || a.passageId.localeCompare(b.passageId));
  app.log.info({tenant, candidates: results.length}, 'rerank');
  return reply.code(200).send({results});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type Candidate struct {
	PassageID string \`json:"passage_id"\`
	Text      string \`json:"text"\`
}

type RerankBody struct {
	Query      string      \`json:"query"\`
	Candidates []Candidate \`json:"candidates"\`
}

func scorePassage(query, text string) float64 {
	return 0
}

func rerank(w http.ResponseWriter, r *http.Request) {
	// TODO: this draft scores every candidate it is handed, clips long passages without
	// reporting it, and returns input order. Review the caps, the clipping and the ordering.
	var body RerankBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	type result struct {
		PassageID string  \`json:"passage_id"\`
		Score     float64 \`json:"score"\`
	}
	results := make([]result, 0, len(body.Candidates))
	for _, c := range body.Candidates {
		text := c.Text
		if len(text) > 4096 {
			text = text[:4096]
		}
		results = append(results, result{PassageID: c.PassageID, Score: scorePassage(body.Query, text)})
	}
	log.Printf("rerank tenant=%s candidates=%d", r.Header.Get("X-Tenant-Id"), len(results))
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{"results": results})
}

func main() {
	http.HandleFunc("POST /v1/rerank", rerank)
	log.Fatal(http.ListenAndServe(":8443", nil))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
)

const (
	maxQueryBytes   = 2 * 1024
	maxCandidates   = 200
	maxPassageBytes = 4 * 1024
)

type Candidate struct {
	PassageID string \`json:"passage_id"\`
	Text      string \`json:"text"\`
}

type RerankBody struct {
	Query      string      \`json:"query"\`
	Candidates []Candidate \`json:"candidates"\`
}

func scorePassage(query, text string) float64 {
	return 0
}

func clipUTF8(text string, limit int) (string, bool) {
	if len(text) <= limit {
		return text, false
	}
	return text[:limit], true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func rerank(w http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing X-Tenant-Id"})
		return
	}
	var body RerankBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if len(body.Query) > maxQueryBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "query exceeds 2 KiB"})
		return
	}
	if len(body.Candidates) > maxCandidates {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "candidates exceed 200"})
		return
	}
	type result struct {
		PassageID string  \`json:"passage_id"\`
		Score     float64 \`json:"score"\`
		Truncated bool    \`json:"truncated"\`
	}
	results := make([]result, 0, len(body.Candidates))
	for _, c := range body.Candidates {
		text, truncated := clipUTF8(c.Text, maxPassageBytes)
		results = append(results, result{PassageID: c.PassageID, Score: scorePassage(body.Query, text), Truncated: truncated})
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		return results[i].PassageID < results[j].PassageID
	})
	log.Printf("rerank tenant=%s candidates=%d", tenant, len(results))
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

func main() {
	http.HandleFunc("POST /v1/rerank", rerank)
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

case class Candidate(passageId: String, text: String)
case class RerankBody(query: String, candidates: List[Candidate])

trait ScoreModel {
  def score(query: String, text: String): Double = 0.0
}

object RerankApi extends DefaultJsonProtocol {
  implicit val candidateFormat: RootJsonFormat[Candidate] = jsonFormat2(Candidate)
  implicit val rerankBodyFormat: RootJsonFormat[RerankBody] = jsonFormat2(RerankBody)

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("rerank")
    val model = new ScoreModel {}

    val route =
      path("v1" / "rerank") {
        post {
          entity(as[String]) { raw =>
            // TODO: this draft scores every candidate it is handed, clips long passages without
            // reporting it, and returns input order. Review the caps, the clipping and the ordering.
            val body = raw.parseJson.convertTo[RerankBody]
            val results = body.candidates.map { candidate =>
              JsObject(
                "passage_id" -> JsString(candidate.passageId),
                "score" -> JsNumber(model.score(body.query, candidate.text.take(4096)))
              )
            }
            complete(StatusCodes.OK, JsObject("results" -> JsArray(results.toVector)).compactPrint)
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

case class Candidate(passageId: String, text: String)
case class RerankBody(query: String, candidates: List[Candidate])

trait ScoreModel {
  def score(query: String, text: String): Double = 0.0
}

object RerankApi extends DefaultJsonProtocol {
  implicit val candidateFormat: RootJsonFormat[Candidate] = jsonFormat2(Candidate)
  implicit val rerankBodyFormat: RootJsonFormat[RerankBody] = jsonFormat2(RerankBody)

  val MaxQueryBytes = 2 * 1024
  val MaxCandidates = 200
  val MaxPassageBytes = 4 * 1024

  def clip(text: String, limit: Int): (String, Boolean) =
    if (text.getBytes("UTF-8").length <= limit) (text, false) else (text.take(limit), true)

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("rerank")
    val model = new ScoreModel {}

    val route =
      path("v1" / "rerank") {
        post {
          optionalHeaderValueByName("X-Tenant-Id") { tenant =>
            entity(as[String]) { raw =>
              tenant match {
                case None => complete(StatusCodes.Unauthorized, "missing X-Tenant-Id")
                case Some(id) =>
                  val body = raw.parseJson.convertTo[RerankBody]
                  if (body.query.getBytes("UTF-8").length > MaxQueryBytes) {
                    complete(StatusCodes.RequestEntityTooLarge, "query exceeds 2 KiB")
                  } else if (body.candidates.length > MaxCandidates) {
                    complete(StatusCodes.BadRequest, "candidates exceed 200")
                  } else {
                    val results = body.candidates.map { candidate =>
                      val (text, truncated) = clip(candidate.text, MaxPassageBytes)
                      JsObject(
                        "passage_id" -> JsString(candidate.passageId),
                        "score" -> JsNumber(model.score(body.query, text)),
                        "truncated" -> JsBoolean(truncated)
                      )
                    }
                    val ordered = results.sortBy { r =>
                      (-r.fields("score").asInstanceOf[JsNumber].value.toDouble, r.fields("passage_id").asInstanceOf[JsString].value)
                    }
                    complete(StatusCodes.OK, JsObject("results" -> JsArray(ordered.toVector)).compactPrint)
                  }
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

static double scorePassage(const std::string& query, const std::string& text) { return 0.0; }

int main() {
  httplib::Server svr;

  svr.Post("/v1/rerank", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft scores every candidate it is handed, clips long passages without
    // reporting it, and returns input order. Review the caps, the clipping and the ordering.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"invalid json\\"}", "application/json");
      return;
    }
    json results = json::array();
    for (const auto& candidate : body.value("candidates", json::array())) {
      std::string text = candidate.value("text", std::string());
      if (text.size() > 4096) text = text.substr(0, 4096);
      results.push_back(json{{"passage_id", candidate.value("passage_id", std::string())},
                             {"score", scorePassage(body.value("query", std::string()), text)}});
    }
    res.status = 200;
    res.set_content(json{{"results", results}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxQueryBytes = 2 * 1024;
constexpr std::size_t kMaxCandidates = 200;
constexpr std::size_t kMaxPassageBytes = 4 * 1024;

static double scorePassage(const std::string& query, const std::string& text) { return 0.0; }

static std::pair<std::string, bool> clip(const std::string& text) {
  if (text.size() <= kMaxPassageBytes) return {text, false};
  return {text.substr(0, kMaxPassageBytes), true};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/rerank", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content("{\\"error\\":\\"missing X-Tenant-Id\\"}", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"invalid json\\"}", "application/json");
      return;
    }
    const auto query = body.value("query", std::string());
    if (query.size() > kMaxQueryBytes) {
      res.status = 413;
      res.set_content("{\\"error\\":\\"query exceeds 2 KiB\\"}", "application/json");
      return;
    }
    const auto candidates = body.value("candidates", json::array());
    if (candidates.size() > kMaxCandidates) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"candidates exceed 200\\"}", "application/json");
      return;
    }
    std::vector<json> results;
    for (const auto& candidate : candidates) {
      const auto clipped = clip(candidate.value("text", std::string()));
      results.push_back(json{{"passage_id", candidate.value("passage_id", std::string())},
                             {"score", scorePassage(query, clipped.first)},
                             {"truncated", clipped.second}});
    }
    std::sort(results.begin(), results.end(), [](const json& a, const json& b) {
      const double sa = a.value("score", 0.0);
      const double sb = b.value("score", 0.0);
      if (sa != sb) return sa > sb;
      return a.value("passage_id", std::string()) < b.value("passage_id", std::string());
    });
    res.status = 200;
    res.set_content(json{{"results", results}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the caps first, in cost order: tenant, query bytes, candidate count. Every one returns before the model call, so a malformed request can never spend money.',
    'The truncation flag is part of the response contract, not a log line. Return `truncated` per passage and let the caller decide whether a clipped comparison is acceptable.',
    'Scores tie constantly with a small model. Sort by `(-score, passage_id)` so the same input always produces the same order and a client can cache or diff the list.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler on top of an expensive
dependency. The draft reads fine because the demo sends a short query and short passages from one
caller. Four defects are being checked: the candidate cap (a cheap rejection before any model work),
the query cap, per-passage truncation reported as data rather than hidden, and a deterministic order
under ties. The trust boundary matters here because the model call — not the handler — is what costs
money, so every cap has to run before it. Real rerankers add a token budget instead of a byte budget,
per-tenant candidate caps, and a passage fingerprint so a clipped passage can be re-fetched on
demand.`,
};
