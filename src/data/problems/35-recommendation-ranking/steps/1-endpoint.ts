import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/recommendations: candidates in, ranked list out',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'api', 'ranker'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/recommendations\` with body \`{surface, candidate_ids}\`
and the \`X-Tenant-Id\` and \`X-User-Id\` headers: it takes the user from the body's \`user_id\` when one
is sent, else from the header, passes every candidate to \`rank(tenant, user_id, surface,
candidate_ids)\` (step 3), and answers \`{items}\` with every ranked item. It serves the demo and hides
four flaws.

**Failure mode the checks target.** One caller gets another user's personalized list by putting that
user's id in the body; a request with thousands of candidates, or none, goes straight to the ranker;
the response grows with the request and says nothing about where each item sits; and a list from the
popularity fallback looks the same as the model's.

- The user is the authenticated \`X-User-Id\` header only; a missing \`X-Tenant-Id\` or \`X-User-Id\` is
  **401** before anything is ranked.
- \`candidate_ids\` holds 1 to \`MAX_CANDIDATES\` = 500 ids; otherwise **400**, before the ranker is
  called.
- Answer at most \`MAX_ITEMS\` = 30 items, the top of the ranked order, each \`{id, score, position}\`
  with its zero-based position.
- The response carries the result's \`model_version\` and \`fallback\`.`,
  sequence: {
    participants: ['Client', 'Recommendation API', 'rank (step 3)'],
    messages: [
      {
        from: 'Client',
        to: 'Recommendation API',
        label: 'POST /v1/recommendations · X-Tenant-Id · X-User-Id',
        kind: 'sync',
      },
      {
        from: 'Recommendation API',
        to: 'Recommendation API',
        label: 'user from X-User-Id · 1 to 500 candidates or 400',
        kind: 'sync',
      },
      {
        from: 'Recommendation API',
        to: 'rank (step 3)',
        label: 'rank(tenant, user_id, surface, candidate_ids)',
        kind: 'sync',
      },
      {from: 'rank (step 3)', to: 'Recommendation API', label: '{items, model_version, fallback}', kind: 'reply'},
      {
        from: 'Recommendation API',
        to: 'Client',
        label: '200 {items: top 30 with positions, model_version, fallback}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Ranks on POST /v1/recommendations',
      detail: 'Register `POST /v1/recommendations` and answer the candidates in the order `rank` returns.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/recommendations["']/, /\brank\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/recommendations['"]/, /\brank\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/recommendations"/, /\brank\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"recommendations"\s*\)/, /\bpost\s*\{/, /Client\.rank\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/recommendations"/, /\brank\(/]},
      },
    },
    {
      id: 'auth-user',
      title: 'Ranks for the X-User-Id caller, never a body user',
      detail:
        'The user comes from the authenticated `X-User-Id` header and a missing header is **401**; the starter prefers a `user_id` in the body, so any caller can request any user’s personalized list.',
      match: {
        python: {all: [/x-user-id/i, /\b401\b/], none: [/body\.user_id/]},
        typescript: {all: [/x-user-id/i, /code\(\s*401\s*\)/], none: [/body\.user_id/]},
        go: {all: [/X-User-Id/, /StatusUnauthorized/], none: [/body\.UserID/]},
        scala: {all: [/X-User-Id/, /Unauthorized/], none: [/fields\.get\(\s*"user_id"\s*\)/]},
        cpp: {all: [/X-User-Id/, /\b401\b/], none: [/body\.value\(\s*"user_id"/]},
      },
    },
    {
      id: 'candidate-cap',
      title: 'Rejects an empty or oversized candidate list',
      detail:
        '`candidate_ids` must hold 1 to `MAX_CANDIDATES` = 500 ids; anything else is **400** before the ranker is called. The starter passes a list of any size, so one request can tie up the ranking pool.',
      match: {
        python: {all: [/MAX_CANDIDATES\s*=\s*500\b/, /len\(body\.candidate_ids\)\s*>\s*MAX_CANDIDATES/, /\b400\b/]},
        typescript: {all: [/MAX_CANDIDATES\s*=\s*500\b/, /length\s*>\s*MAX_CANDIDATES/, /code\(\s*400\s*\)/]},
        go: {all: [/maxCandidates\s*=\s*500\b/, /len\(body\.CandidateIDs\)\s*>\s*maxCandidates/, /StatusBadRequest/]},
        scala: {all: [/MaxCandidates\s*=\s*500\b/, /size\s*>\s*MaxCandidates/, /BadRequest/]},
        cpp: {all: [/kMaxCandidates\s*=\s*500\b/, /size\(\)\s*>\s*kMaxCandidates/, /\b400\b/]},
      },
    },
    {
      id: 'top-k',
      title: 'Answers at most 30 items, each with its position',
      detail:
        'The ranked order is cut to `MAX_ITEMS` = 30 and every item carries `id`, `score` and its zero-based `position`; the starter answers every ranked item, so a 500-candidate request becomes a 500-item payload.',
      match: {
        python: {all: [/MAX_ITEMS\s*=\s*30\b/, /\[:\s*MAX_ITEMS\s*\]/, /"position":\s*position/]},
        typescript: {all: [/MAX_ITEMS\s*=\s*30\b/, /slice\(\s*0,\s*MAX_ITEMS\s*\)/, /\bposition\b/]},
        go: {
          all: [
            /maxItems\s*=\s*30\b/,
            /position\s*==\s*maxItems|\[:\s*maxItems\]|min\([^\n]*maxItems/,
            /json:"position"/,
          ],
        },
        scala: {all: [/MaxItems\s*=\s*30\b/, /take\(\s*MaxItems\s*\)/, /"position"\s*->/]},
        cpp: {all: [/kMaxItems\s*=\s*30\b/, /position\s*<\s*kMaxItems/, /\{"position",\s*position\}/]},
      },
    },
    {
      id: 'model-version',
      title: 'Stamps the response with the version and the fallback flag',
      detail:
        'The response carries `model_version` and `fallback` from the `rank` result, so a client, a log line or an A/B read can tell which model ordered the list and whether it was the popularity fallback; the starter answers the items alone.',
      match: {
        python: {all: [/"model_version":\s*result\["model_version"\]/, /"fallback":\s*result\["fallback"\]/]},
        typescript: {all: [/model_version:\s*result\.model_version/, /fallback:\s*result\.fallback/]},
        go: {all: [/"model_version":\s*result\.ModelVersion/, /"fallback":\s*result\.Fallback/]},
        scala: {
          all: [
            /"model_version"\s*->\s*JsString\(result\.modelVersion\)/,
            /"fallback"\s*->\s*JsBoolean\(result\.fallback\)/,
          ],
        },
        cpp: {all: [/\{"model_version",\s*result\.model_version\}/, /\{"fallback",\s*result\.fallback\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from client import rank  # step 3: rank(tenant, user_id, surface, candidate_ids) -> {items, model_version, fallback}

app = FastAPI()


class RecommendRequest(BaseModel):
    surface: str
    candidate_ids: list[str]
    user_id: str | None = None


@app.post("/v1/recommendations")
def recommend(body: RecommendRequest, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    user_id = body.user_id or request.headers.get("x-user-id", "")
    result = rank(tenant, user_id, body.surface, body.candidate_ids)
    return {"items": result["items"]}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from client import rank  # step 3: rank(tenant, user_id, surface, candidate_ids) -> {items, model_version, fallback}

app = FastAPI()

MAX_CANDIDATES = 500
MAX_ITEMS = 30


class RecommendRequest(BaseModel):
    surface: str
    candidate_ids: list[str]


@app.post("/v1/recommendations")
def recommend(body: RecommendRequest, request: Request) -> dict:
    # Both from the authenticated headers: the list is personal to the caller.
    tenant = request.headers.get("x-tenant-id", "")
    user_id = request.headers.get("x-user-id", "")
    if not tenant or not user_id:
        raise HTTPException(status_code=401, detail="X-Tenant-Id and X-User-Id are required")
    if not body.candidate_ids or len(body.candidate_ids) > MAX_CANDIDATES:
        raise HTTPException(status_code=400, detail=f"candidate_ids must hold 1 to {MAX_CANDIDATES} ids")
    result = rank(tenant, user_id, body.surface, body.candidate_ids)
    items = [{"id": item["id"], "score": item["score"], "position": position} for position, item in enumerate(result["items"][:MAX_ITEMS])]
    return {"items": items, "model_version": result["model_version"], "fallback": result["fallback"]}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {rank} from './client'; // step 3: rank(tenant, userId, surface, candidateIds) -> {items, model_version, fallback}

export const app = Fastify();

interface RecommendBody {
  surface: string;
  candidate_ids: string[];
  user_id?: string;
}

app.post('/v1/recommendations', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as RecommendBody;
  const userId = body.user_id ?? String(request.headers['x-user-id'] ?? '');
  const result = await rank(tenant, userId, body.surface, body.candidate_ids);
  return {items: result.items};
});
`,
      solution: `import Fastify from 'fastify';

import {rank} from './client'; // step 3: rank(tenant, userId, surface, candidateIds) -> {items, model_version, fallback}

export const app = Fastify();

export const MAX_CANDIDATES = 500;
export const MAX_ITEMS = 30;

interface RecommendBody {
  surface: string;
  candidate_ids?: string[];
}

app.post('/v1/recommendations', async (request, reply) => {
  // Both from the authenticated headers: the list is personal to the caller.
  const tenant = request.headers['x-tenant-id'];
  const userId = request.headers['x-user-id'];
  if (typeof tenant !== 'string' || tenant === '' || typeof userId !== 'string' || userId === '') {
    return reply.code(401).send({error: 'X-Tenant-Id and X-User-Id are required'});
  }
  const {surface, candidate_ids: candidateIds = []} = request.body as RecommendBody;
  if (candidateIds.length === 0 || candidateIds.length > MAX_CANDIDATES) {
    return reply.code(400).send({error: \`candidate_ids must hold 1 to \${MAX_CANDIDATES} ids\`});
  }
  const result = await rank(tenant, userId, surface, candidateIds);
  const items = result.items.slice(0, MAX_ITEMS).map(({id, score}, position) => ({id, score, position}));
  return {items, model_version: result.model_version, fallback: result.fallback};
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"recs/types"
)

// Built in step 3 (client.go): the candidates ranked for the user, best first. Until the steps are
// wired together it ranks nothing; the checks wire their own.
var rank = func(ctx context.Context, tenant, userID, surface string, candidateIDs []string) types.Ranked {
	return types.Ranked{}
}

type recommendRequest struct {
	Surface      string   \`json:"surface"\`
	CandidateIDs []string \`json:"candidate_ids"\`
	UserID       string   \`json:"user_id"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func recommend(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body recommendRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid body", http.StatusBadRequest)
		return
	}
	userID := body.UserID
	if userID == "" {
		userID = r.Header.Get("X-User-Id")
	}
	result := rank(r.Context(), tenant, userID, body.Surface, body.CandidateIDs)
	writeJSON(rw, http.StatusOK, map[string]any{"items": result.Items})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/recommendations", recommend)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"recs/types"
)

const (
	maxCandidates = 500
	maxItems      = 30
)

// Built in step 3 (client.go): the candidates ranked for the user, best first. Until the steps are
// wired together it ranks nothing; the checks wire their own.
var rank = func(ctx context.Context, tenant, userID, surface string, candidateIDs []string) types.Ranked {
	return types.Ranked{}
}

type recommendRequest struct {
	Surface      string   \`json:"surface"\`
	CandidateIDs []string \`json:"candidate_ids"\`
}

type rankedItem struct {
	ID       string  \`json:"id"\`
	Score    float64 \`json:"score"\`
	Position int     \`json:"position"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func recommend(rw http.ResponseWriter, r *http.Request) {
	// Both from the authenticated headers: the list is personal to the caller.
	tenant, userID := r.Header.Get("X-Tenant-Id"), r.Header.Get("X-User-Id")
	if tenant == "" || userID == "" {
		http.Error(rw, "X-Tenant-Id and X-User-Id are required", http.StatusUnauthorized)
		return
	}
	var body recommendRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid body", http.StatusBadRequest)
		return
	}
	if len(body.CandidateIDs) == 0 || len(body.CandidateIDs) > maxCandidates {
		http.Error(rw, "candidate_ids must hold 1 to 500 ids", http.StatusBadRequest)
		return
	}
	result := rank(r.Context(), tenant, userID, body.Surface, body.CandidateIDs)
	items := []rankedItem{}
	for position, item := range result.Items {
		if position == maxItems {
			break
		}
		items = append(items, rankedItem{ID: item.ID, Score: item.Score, Position: position})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"items": items, "model_version": result.ModelVersion, "fallback": result.Fallback})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/recommendations", recommend)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

object Api {
  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route =
    path("v1" / "recommendations") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          optionalHeaderValueByName("X-User-Id") { headerUser =>
            entity(as[String]) { raw =>
              // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
              val fields = raw.parseJson.asJsObject.fields
              val surface = fields.get("surface").map(_.convertTo[String]).getOrElse("")
              val candidateIds = fields.get("candidate_ids").map(_.convertTo[Vector[String]]).getOrElse(Vector.empty)
              val userId = fields.get("user_id").map(_.convertTo[String]).orElse(headerUser).getOrElse("")
              tenant.filter(_.nonEmpty) match {
                case None => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
                case Some(t) =>
                  val result = Client.rank(t, userId, surface, candidateIds) // step 3
                  val items = result.items.map(item => JsObject("id" -> JsString(item.id), "score" -> JsNumber(item.score)))
                  complete(json(JsObject("items" -> JsArray(items.toVector))))
              }
            }
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

object Api {
  val MaxCandidates = 500
  val MaxItems = 30

  private def json(body: JsObject): HttpResponse =
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route =
    path("v1" / "recommendations") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          optionalHeaderValueByName("X-User-Id") { headerUser =>
            entity(as[String]) { raw =>
              // Both from the authenticated headers: the list is personal to the caller.
              (tenant.filter(_.nonEmpty), headerUser.filter(_.nonEmpty)) match {
                case (Some(t), Some(userId)) =>
                  val fields = raw.parseJson.asJsObject.fields
                  val surface = fields.get("surface").map(_.convertTo[String]).getOrElse("")
                  val candidateIds = fields.get("candidate_ids").map(_.convertTo[Vector[String]]).getOrElse(Vector.empty)
                  if (candidateIds.isEmpty || candidateIds.size > MaxCandidates)
                    complete(StatusCodes.BadRequest -> s"candidate_ids must hold 1 to $MaxCandidates ids")
                  else {
                    val result = Client.rank(t, userId, surface, candidateIds) // step 3
                    val items = result.items.take(MaxItems).zipWithIndex.map { case (item, position) =>
                      JsObject("id" -> JsString(item.id), "score" -> JsNumber(item.score), "position" -> JsNumber(position))
                    }
                    complete(json(JsObject(
                      "items" -> JsArray(items.toVector),
                      "model_version" -> JsString(result.modelVersion),
                      "fallback" -> JsBoolean(result.fallback)
                    )))
                  }
                case _ => complete(StatusCodes.Unauthorized -> "X-Tenant-Id and X-User-Id are required")
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

#include "recs/types.h"

using json = nlohmann::json;

// Built in step 3 (client.cpp): the candidates ranked for the user, best first.
recs::Ranked rank(const std::string& tenant, const std::string& user_id, const std::string& surface,
                  const std::vector<std::string>& candidate_ids);

void recommend(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content("invalid body", "text/plain");
    return;
  }
  const std::string user_id = body.value("user_id", req.get_header_value("X-User-Id"));
  const recs::Ranked result = rank(tenant, user_id, body.value("surface", ""), body.value("candidate_ids", std::vector<std::string>{}));
  json items = json::array();
  for (const auto& item : result.items) items.push_back(json{{"id", item.id}, {"score", item.score}});
  res.set_content(json{{"items", items}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/recommendations", recommend); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "recs/types.h"

using json = nlohmann::json;

constexpr size_t kMaxCandidates = 500;
constexpr size_t kMaxItems = 30;

// Built in step 3 (client.cpp): the candidates ranked for the user, best first.
recs::Ranked rank(const std::string& tenant, const std::string& user_id, const std::string& surface,
                  const std::vector<std::string>& candidate_ids);

void recommend(const httplib::Request& req, httplib::Response& res) {
  // Both from the authenticated headers: the list is personal to the caller.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string user_id = req.get_header_value("X-User-Id");
  if (tenant.empty() || user_id.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id and X-User-Id are required", "text/plain");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content("invalid body", "text/plain");
    return;
  }
  const auto candidate_ids = body.value("candidate_ids", std::vector<std::string>{});
  if (candidate_ids.empty() || candidate_ids.size() > kMaxCandidates) {
    res.status = 400;
    res.set_content("candidate_ids must hold 1 to 500 ids", "text/plain");
    return;
  }
  const recs::Ranked result = rank(tenant, user_id, body.value("surface", ""), candidate_ids);
  json items = json::array();
  for (size_t position = 0; position < result.items.size() && position < kMaxItems; position++) {
    items.push_back(json{{"id", result.items[position].id}, {"score", result.items[position].score}, {"position", position}});
  }
  res.set_content(json{{"items", items}, {"model_version", result.model_version}, {"fallback", result.fallback}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/recommendations", recommend); }
`,
    },
  },
  harness: {
    python: `import grpc

import ranking_pb2
import ranking_pb2_grpc


def _score(item_id):
    return int(item_id.split("-")[1]) * 37 % 101 / 100


class Ranker(ranking_pb2_grpc.RankerServicer):
    def Rank(self, request, context):
        items = sorted(request.candidate_ids, key=lambda c: -_score(c))
        return ranking_pb2.RankResponse(items=[ranking_pb2.ScoredItem(id=c, score=_score(c)) for c in items], model_version="ranker-v7")


class FeatureService(ranking_pb2_grpc.FeatureServiceServicer):
    def UserFeatures(self, request, context):
        return ranking_pb2.FeatureVector(values=[0.5])


def _api(ctx):
    ctx.grpc.serve(ranking_pb2_grpc.add_RankerServicer_to_server, Ranker())
    ctx.grpc.serve(ranking_pb2_grpc.add_FeatureServiceServicer_to_server, FeatureService())
    return ctx.client(ctx.load("api").app)


def _candidates(n):
    return [f"c-{i}" for i in range(1, n + 1)]


def _model_order(ids):
    return sorted(ids, key=lambda c: -_score(c))


async def _post(c, body, user="u-1", tenant="t1"):
    headers = {}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    if user:
        headers["X-User-Id"] = user
    return await c.post("/v1/recommendations", json=body, headers=headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {"surface": "home", "candidate_ids": _candidates(5)})
    assert r.status_code == 200, f"POST /v1/recommendations answered {r.status_code}: {r.text}"
    ids = [item.get("id") for item in r.json().get("items", [])]
    assert ids == _model_order(_candidates(5)), f"the response lists {ids}, expected the ranker's order {_model_order(_candidates(5))}"


async def check_auth_user(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {"surface": "home", "candidate_ids": _candidates(5), "user_id": "u-2"}, user="u-1")
        assert r.status_code == 200, f"a request from u-1 answered {r.status_code}: {r.text}"
        ranked_for = [call.request.user_id for call in ctx.grpc.calls_to("Rank")]
        assert ranked_for == ["u-1"], f"the list was ranked for {ranked_for}: the body's user_id chose whose personalization came back. The user is the authenticated X-User-Id"
        r = await _post(c, {"surface": "home", "candidate_ids": _candidates(5)}, user=None)
        assert r.status_code == 401, f"a request without X-User-Id answered {r.status_code}, expected 401"
        assert len(ctx.grpc.calls_to("Rank")) == 1, "a request without X-User-Id reached the ranker"


async def check_candidate_cap(ctx):
    async with _api(ctx) as c:
        for n in (501, 0):
            r = await _post(c, {"surface": "home", "candidate_ids": _candidates(n)})
            assert r.status_code == 400, f"a request with {n} candidates answered {r.status_code}, expected 400: candidate_ids holds 1 to 500 ids"
        assert not ctx.grpc.calls_to("Rank"), f"a rejected request reached the ranker ({len(ctx.grpc.calls_to('Rank'))} Rank calls)"
        r = await _post(c, {"surface": "home", "candidate_ids": _candidates(500)})
    assert r.status_code == 200, f"a request with 500 candidates answered {r.status_code}: {r.text}"


async def check_top_k(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {"surface": "home", "candidate_ids": _candidates(100)})
    assert r.status_code == 200, f"POST /v1/recommendations answered {r.status_code}: {r.text}"
    items = r.json().get("items", [])
    assert len(items) == 30, f"a request with 100 candidates answered {len(items)} items: the response grows with the request. Answer the top MAX_ITEMS = 30"
    assert [item.get("id") for item in items] == _model_order(_candidates(100))[:30], "the 30 items must be the top of the ranked order"
    positions = [item.get("position") for item in items]
    assert positions == list(range(30)), f"the items carry positions {positions[:5]}…, expected 0, 1, 2, … in served order"


async def check_model_version(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {"surface": "home", "candidate_ids": _candidates(5)})
        body = r.json()
        assert body.get("model_version") == "ranker-v7" and body.get("fallback") is False, f"the response is stamped model_version {body.get('model_version')!r}, fallback {body.get('fallback')!r}: expected the ranker's ranker-v7 and false"
        ctx.grpc.fail("Rank", grpc.StatusCode.UNAVAILABLE, "every replica restarting", times=3)
        r = await _post(c, {"surface": "home", "candidate_ids": _candidates(5)})
    body = r.json()
    assert body.get("model_version") == "popularity-v1" and body.get("fallback") is True, f"with the ranker down the response is stamped model_version {body.get('model_version')!r}, fallback {body.get('fallback')!r}: expected the popularity fallback's popularity-v1 and true"
`,
    typescript: `const score = (id: string): number => ((Number(id.split('-')[1]) * 37) % 101) / 100;
const candidates = (n: number): string[] => Array.from({length: n}, (_, i) => \`c-\${i + 1}\`);
const modelOrder = (ids: string[]): string[] => [...ids].sort((a, b) => score(b) - score(a));

function api(ctx) {
  const pkg = ctx.proto('ranking.proto');
  ctx.grpc.serve(pkg.recsys.Ranker.service, {
    Rank(call, callback) {
      const items = modelOrder(call.request.candidate_ids).map(id => ({id, score: score(id)}));
      callback(null, {items, model_version: 'ranker-v7'});
    },
  });
  ctx.grpc.serve(pkg.recsys.FeatureService.service, {
    UserFeatures(call, callback) {
      callback(null, {values: [0.5]});
    },
  });
  return ctx.client(ctx.load('api').app);
}

function post(c, body, user: string | null = 'u-1') {
  const headers: Record<string, string> = {'X-Tenant-Id': 't1'};
  if (user !== null) headers['X-User-Id'] = user;
  return c.post('/v1/recommendations', {json: body, headers});
}

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, {surface: 'home', candidate_ids: candidates(5)});
  assert.equal(r.status, 200, \`POST /v1/recommendations answered \${r.status}: \${r.text}\`);
  const ids = (r.json().items ?? []).map(item => item.id);
  assert.deepStrictEqual(ids, modelOrder(candidates(5)), \`the response lists \${JSON.stringify(ids)}, expected the ranker's order\`);
}

export async function check_auth_user(ctx) {
  const c = api(ctx);
  let r = await post(c, {surface: 'home', candidate_ids: candidates(5), user_id: 'u-2'}, 'u-1');
  assert.equal(r.status, 200, \`a request from u-1 answered \${r.status}: \${r.text}\`);
  const rankedFor = ctx.grpc.callsTo('Rank').map(call => call.request.user_id);
  assert.deepStrictEqual(rankedFor, ['u-1'], \`the list was ranked for \${JSON.stringify(rankedFor)}: the body's user_id chose whose personalization came back. The user is the authenticated X-User-Id\`);
  r = await post(c, {surface: 'home', candidate_ids: candidates(5)}, null);
  assert.equal(r.status, 401, \`a request without X-User-Id answered \${r.status}, expected 401\`);
  assert.equal(ctx.grpc.callsTo('Rank').length, 1, 'a request without X-User-Id reached the ranker');
}

export async function check_candidate_cap(ctx) {
  const c = api(ctx);
  for (const n of [501, 0]) {
    const r = await post(c, {surface: 'home', candidate_ids: candidates(n)});
    assert.equal(r.status, 400, \`a request with \${n} candidates answered \${r.status}, expected 400: candidate_ids holds 1 to 500 ids\`);
  }
  assert.equal(ctx.grpc.callsTo('Rank').length, 0, \`a rejected request reached the ranker (\${ctx.grpc.callsTo('Rank').length} Rank calls)\`);
  const r = await post(c, {surface: 'home', candidate_ids: candidates(500)});
  assert.equal(r.status, 200, \`a request with 500 candidates answered \${r.status}: \${r.text}\`);
}

export async function check_top_k(ctx) {
  const c = api(ctx);
  const r = await post(c, {surface: 'home', candidate_ids: candidates(100)});
  assert.equal(r.status, 200, \`POST /v1/recommendations answered \${r.status}: \${r.text}\`);
  const items = r.json().items ?? [];
  assert.equal(items.length, 30, \`a request with 100 candidates answered \${items.length} items: the response grows with the request. Answer the top MAX_ITEMS = 30\`);
  assert.deepStrictEqual(items.map(item => item.id), modelOrder(candidates(100)).slice(0, 30), 'the 30 items must be the top of the ranked order');
  const positions = items.map(item => item.position);
  assert.deepStrictEqual(positions, Array.from({length: 30}, (_, i) => i), \`the items carry positions \${JSON.stringify(positions.slice(0, 5))}…, expected 0, 1, 2, … in served order\`);
}

export async function check_model_version(ctx) {
  const c = api(ctx);
  let body = (await post(c, {surface: 'home', candidate_ids: candidates(5)})).json();
  assert(body.model_version === 'ranker-v7' && body.fallback === false, \`the response is stamped model_version \${JSON.stringify(body.model_version)}, fallback \${JSON.stringify(body.fallback)}: expected the ranker's ranker-v7 and false\`);
  ctx.grpc.fail('Rank', ctx.grpc.status.UNAVAILABLE, 'every replica restarting', 3);
  body = (await post(c, {surface: 'home', candidate_ids: candidates(5)})).json();
  assert(body.model_version === 'popularity-v1' && body.fallback === true, \`with the ranker down the response is stamped model_version \${JSON.stringify(body.model_version)}, fallback \${JSON.stringify(body.fallback)}: expected the popularity fallback's popularity-v1 and true\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"recs/types"

	"leetbuild/harness"
)

// rank as step 3 builds it, without the network: the model scores a candidate by its number; with
// the ranker down the candidates come back in their own order, stamped as the popularity fallback.
var (
	rankedFor  []string
	rankerDown bool
)

func modelScore(id string) float64 {
	n, _ := strconv.Atoi(strings.TrimPrefix(id, "c-"))
	return float64(n*37%101) / 100
}

func candidates(n int) []string {
	out := []string{}
	for i := 1; i <= n; i++ {
		out = append(out, fmt.Sprintf("c-%d", i))
	}
	return out
}

func modelOrder(ids []string) []string {
	out := append([]string{}, ids...)
	sort.SliceStable(out, func(i, j int) bool { return modelScore(out[i]) > modelScore(out[j]) })
	return out
}

func api(ctx *harness.Ctx) *harness.HTTP {
	rankedFor = []string{}
	rankerDown = false
	rank = func(_ context.Context, tenant, userID, surface string, candidateIDs []string) types.Ranked {
		rankedFor = append(rankedFor, userID)
		ids := candidateIDs
		if !rankerDown {
			ids = modelOrder(candidateIDs)
		}
		items := []types.Item{}
		for _, id := range ids {
			items = append(items, types.Item{ID: id, Score: modelScore(id)})
		}
		if rankerDown {
			return types.Ranked{Items: items, ModelVersion: "popularity-v1", Fallback: true}
		}
		return types.Ranked{Items: items, ModelVersion: "ranker-v7"}
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type servedItem struct {
	ID       string  \`json:"id"\`
	Score    float64 \`json:"score"\`
	Position *int    \`json:"position"\`
}

type recommendation struct {
	Items        []servedItem \`json:"items"\`
	ModelVersion string       \`json:"model_version"\`
	Fallback     *bool        \`json:"fallback"\`
}

func recommendFor(c *harness.HTTP, userID string, body map[string]any) (*harness.Response, recommendation) {
	headers := []string{"X-Tenant-Id", "t1"}
	if userID != "" {
		headers = append(headers, "X-User-Id", userID)
	}
	r := c.Post("/v1/recommendations", body, headers...)
	var out recommendation
	if r.Status == 200 {
		r.Decode(&out)
	}
	return r, out
}

func idsOf(rec recommendation) []string {
	out := []string{}
	for _, item := range rec.Items {
		out = append(out, item.ID)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r, rec := recommendFor(c, "u-1", map[string]any{"surface": "home", "candidate_ids": candidates(5)})
	ctx.Equal(r.Status, 200, "POST /v1/recommendations (%s)", r.Text())
	ctx.Equal(idsOf(rec), modelOrder(candidates(5)), "the response must list the ranker's order; it lists")
}

func CheckAuthUser(ctx *harness.Ctx) {
	c := api(ctx)
	r, _ := recommendFor(c, "u-1", map[string]any{"surface": "home", "candidate_ids": candidates(5), "user_id": "u-2"})
	ctx.Equal(r.Status, 200, "a request from u-1 (%s)", r.Text())
	ctx.Equal(rankedFor, []string{"u-1"}, "the body's user_id must not choose whose personalization comes back (the user is the authenticated X-User-Id); the list was ranked for")
	r, _ = recommendFor(c, "", map[string]any{"surface": "home", "candidate_ids": candidates(5)})
	ctx.Equal(r.Status, 401, "a request without X-User-Id")
	ctx.Equal(len(rankedFor), 1, "a request without X-User-Id must not reach the ranker; the rank calls")
}

func CheckCandidateCap(ctx *harness.Ctx) {
	c := api(ctx)
	for _, n := range []int{501, 0} {
		r, _ := recommendFor(c, "u-1", map[string]any{"surface": "home", "candidate_ids": candidates(n)})
		ctx.Equal(r.Status, 400, "a request with %d candidates (candidate_ids holds 1 to 500 ids)", n)
	}
	ctx.Equal(len(rankedFor), 0, "a rejected request must not reach the ranker; the rank calls")
	r, _ := recommendFor(c, "u-1", map[string]any{"surface": "home", "candidate_ids": candidates(500)})
	ctx.Equal(r.Status, 200, "a request with 500 candidates (%s)", r.Text())
}

func CheckTopK(ctx *harness.Ctx) {
	c := api(ctx)
	r, rec := recommendFor(c, "u-1", map[string]any{"surface": "home", "candidate_ids": candidates(100)})
	ctx.Equal(r.Status, 200, "POST /v1/recommendations (%s)", r.Text())
	ctx.Equal(len(rec.Items), 30, "a request with 100 candidates must answer the top maxItems = 30, not grow with the request; the items")
	ctx.Equal(idsOf(rec), modelOrder(candidates(100))[:30], "the 30 items must be the top of the ranked order; they are")
	for i, item := range rec.Items {
		ctx.Assert(item.Position != nil && *item.Position == i, "item %d (%s) carries position %v, expected %d: each item carries its zero-based position in served order", i, item.ID, item.Position, i)
	}
}

func CheckModelVersion(ctx *harness.Ctx) {
	c := api(ctx)
	_, rec := recommendFor(c, "u-1", map[string]any{"surface": "home", "candidate_ids": candidates(5)})
	ctx.Assert(rec.ModelVersion == "ranker-v7" && rec.Fallback != nil && !*rec.Fallback, "the response is stamped model_version %q, fallback %v: expected the ranker's ranker-v7 and false", rec.ModelVersion, rec.Fallback)
	rankerDown = true
	_, rec = recommendFor(c, "u-1", map[string]any{"surface": "home", "candidate_ids": candidates(5)})
	ctx.Assert(rec.ModelVersion == "popularity-v1" && rec.Fallback != nil && *rec.Fallback, "with the ranker down the response is stamped model_version %q, fallback %v: expected the popularity fallback's popularity-v1 and true", rec.ModelVersion, rec.Fallback)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

namespace {

// rank as step 3 builds it, without the network: the model scores a candidate by its number; with
// the ranker down the candidates come back in their own order, stamped as the popularity fallback.
std::vector<std::string> rankedFor;
bool rankerDown = false;

double modelScore(const std::string& id) { return static_cast<double>(std::stoi(id.substr(2)) * 37 % 101) / 100; }

std::vector<std::string> candidates(int n) {
  std::vector<std::string> out;
  for (int i = 1; i <= n; i++) out.push_back("c-" + std::to_string(i));
  return out;
}

std::vector<std::string> modelOrder(std::vector<std::string> ids) {
  std::stable_sort(ids.begin(), ids.end(), [](const std::string& a, const std::string& b) { return modelScore(a) > modelScore(b); });
  return ids;
}

harness::HTTP api(harness::Ctx& ctx) {
  rankedFor.clear();
  rankerDown = false;
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body, const std::string& user_id = "u-1") {
  if (user_id.empty()) return c.Post("/v1/recommendations", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
  return c.Post("/v1/recommendations", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1", "X-User-Id", user_id);
}

nlohmann::json parsed(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

std::vector<std::string> idsOf(const nlohmann::json& body) {
  std::vector<std::string> out;
  if (body.contains("items") && body["items"].is_array()) {
    for (const auto& item : body["items"]) out.push_back(item.value("id", ""));
  }
  return out;
}

}  // namespace

recs::Ranked rank(const std::string&, const std::string& user_id, const std::string&, const std::vector<std::string>& candidate_ids) {
  rankedFor.push_back(user_id);
  recs::Ranked out;
  for (const auto& id : rankerDown ? candidate_ids : modelOrder(candidate_ids)) out.items.push_back(recs::Item{id, modelScore(id)});
  out.model_version = rankerDown ? "popularity-v1" : "ranker-v7";
  out.fallback = rankerDown;
  return out;
}

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, {{"surface", "home"}, {"candidate_ids", candidates(5)}});
  ctx.Equal(r.Status, 200, "POST /v1/recommendations (%s)", r.Text());
  ctx.Equal(idsOf(parsed(r)), modelOrder(candidates(5)), "the response must list the ranker's order; it lists");
}

void CheckAuthUser(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, {{"surface", "home"}, {"candidate_ids", candidates(5)}, {"user_id", "u-2"}}, "u-1");
  ctx.Equal(r.Status, 200, "a request from u-1 (%s)", r.Text());
  ctx.Equal(rankedFor, {"u-1"}, "the body's user_id must not choose whose personalization comes back (the user is the authenticated X-User-Id); the list was ranked for");
  r = post(c, {{"surface", "home"}, {"candidate_ids", candidates(5)}}, "");
  ctx.Equal(r.Status, 401, "a request without X-User-Id");
  ctx.Equal(rankedFor.size(), 1, "a request without X-User-Id must not reach the ranker; the rank calls");
}

void CheckCandidateCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const int n : {501, 0}) {
    const auto r = post(c, {{"surface", "home"}, {"candidate_ids", candidates(n)}});
    ctx.Equal(r.Status, 400, "a request with %d candidates (candidate_ids holds 1 to 500 ids)", n);
  }
  ctx.Equal(rankedFor.size(), 0, "a rejected request must not reach the ranker; the rank calls");
  const auto r = post(c, {{"surface", "home"}, {"candidate_ids", candidates(500)}});
  ctx.Equal(r.Status, 200, "a request with 500 candidates (%s)", r.Text());
}

void CheckTopK(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, {{"surface", "home"}, {"candidate_ids", candidates(100)}});
  ctx.Equal(r.Status, 200, "POST /v1/recommendations (%s)", r.Text());
  const auto body = parsed(r);
  const auto ids = idsOf(body);
  ctx.Equal(ids.size(), 30, "a request with 100 candidates must answer the top kMaxItems = 30, not grow with the request; the items");
  const auto order = modelOrder(candidates(100));
  ctx.Equal(ids, std::vector<std::string>(order.begin(), order.begin() + 30), "the 30 items must be the top of the ranked order; they are");
  for (size_t i = 0; i < body["items"].size(); i++) {
    const auto& item = body["items"][i];
    ctx.Assert(item.contains("position") && item["position"] == i, "item %d carries %s, expected position %d: each item carries its zero-based position in served order", i, item.dump(), i);
  }
}

void CheckModelVersion(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto body = parsed(post(c, {{"surface", "home"}, {"candidate_ids", candidates(5)}}));
  ctx.Assert(body.value("model_version", "") == "ranker-v7" && body.contains("fallback") && body["fallback"] == false, "the response is %s: expected model_version ranker-v7 and fallback false", body.dump());
  rankerDown = true;
  body = parsed(post(c, {{"surface", "home"}, {"candidate_ids", candidates(5)}}));
  ctx.Assert(body.value("model_version", "") == "popularity-v1" && body.contains("fallback") && body["fallback"] == true, "with the ranker down the response is %s: expected model_version popularity-v1 and fallback true", body.dump());
}
`,
  },
  hints: [
    "Send a body with another user's `user_id` and you get their personalized list; send 100 candidates and 100 items come back with no positions and no version.",
    "The handler prefers the body's user over the authenticated header, checks nothing about the candidate list, and returns the ranker's whole result without the version or the fallback flag it carries.",
    'Read the user from `X-User-Id` only (401 when missing); 400 unless `1 <= len(candidate_ids) <= MAX_CANDIDATES`; answer `result["items"][:MAX_ITEMS]` with `position` from `enumerate`, plus `model_version` and `fallback`.',
  ],
  debrief: `Identity comes from the request's authentication and never from its body, because a personalized list is data about one user and the body is whatever the caller typed. The candidate bound protects the ranker, whose cost grows with the list, and the 30-item cut protects the client from a payload that grows with the request; both are checked before any work is done. The position travels with each item because clicks depend on the slot as much as on relevance, and the version and fallback flag travel with the list so every reader can attribute it. Production endpoints take the user from a verified token rather than a header, rate-limit per user, and add an impression id the click event can carry back.`,
};
