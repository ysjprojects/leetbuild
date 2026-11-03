import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Ranking model call with a popularity fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'ranker', 'redis'],
  task: `## Task

**Starting point.** The starter is \`rank(tenant, user_id, surface, candidate_ids)\`, the ranking client
the endpoint (step 1) calls: it reads the user's features through \`load_features\` (step 2), calls
\`Ranker.Rank\` over gRPC with up to \`MAX_ATTEMPTS\` = 3 attempts, and returns
\`{items: [{id, score}], model_version, fallback}\`. With the ranker healthy it ranks, and it hides
four flaws.

**Failure mode the checks target.** A ranker replica that hangs holds the request open for as long
as it hangs; a request the model refuses is sent again; and when the ranker is down the user gets an
empty page, unmarked, so the impression stream cannot tell a degraded list from the model's.

\`\`\`proto
service Ranker { rpc Rank(RankRequest) returns (RankResponse); }  // UNAVAILABLE: a replica is restarting
\`\`\`

- Every attempt carries a **500 ms** deadline (\`RANK_DEADLINE_S\`).
- Retry only \`UNAVAILABLE\`, at most 3 attempts; \`DEADLINE_EXCEEDED\`, \`INVALID_ARGUMENT\` and every
  other status end the attempts at once.
- When the attempts end without an answer, return the popularity order,
  \`store.popularity_order(surface, candidate_ids)\`, stamped \`store.POPULARITY_VERSION\`
  (\`popularity-v1\`) with \`fallback: true\`; a model answer has \`fallback: false\`.`,
  sequence: {
    participants: ['Recommendation API', 'Feature cache', 'Ranker', 'Redis popularity'],
    messages: [
      {from: 'Recommendation API', to: 'Feature cache', label: 'load_features(t1, u-1)', kind: 'sync'},
      {from: 'Recommendation API', to: 'Ranker', label: 'Rank(candidates, features) · deadline 500 ms', kind: 'sync'},
      {from: 'Ranker', to: 'Recommendation API', label: 'UNAVAILABLE → retry, at most 3 attempts', kind: 'reply'},
      {from: 'Ranker', to: 'Recommendation API', label: 'DEADLINE_EXCEEDED · INVALID_ARGUMENT → stop', kind: 'reply'},
      {from: 'Recommendation API', to: 'Redis popularity', label: 'ZREVRANGE popularity:home', kind: 'sync'},
      {
        from: 'Redis popularity',
        to: 'Recommendation API',
        label: 'popularity order · popularity-v1 · fallback true',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Rank attempt carries a 500 ms deadline',
      detail:
        'Each `Rank` call is made with `RANK_DEADLINE_S` (500 ms) as its deadline; the starter sets none, so a replica that hangs holds the request, and the user, for as long as it hangs.',
      match: {
        python: {all: [/RANK_DEADLINE_S\s*=\s*0?\.5\b/, /\.Rank\([^)\n]*timeout\s*=\s*RANK_DEADLINE_S/]},
        typescript: {all: [/RANK_DEADLINE_MS\s*=\s*500\b/, /\.Rank\([^\n]*deadline:[^\n]*RANK_DEADLINE_MS/]},
        go: {all: [/rankDeadline\s*=\s*500\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*rankDeadline\)/]},
        scala: {all: [/RankDeadlineMs\s*=\s*500L?\b/, /withDeadlineAfter\(\s*RankDeadlineMs/]},
        cpp: {all: [/kRankDeadline\{500\}/, /set_deadline\([^\n]*kRankDeadline\)/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries only UNAVAILABLE, at most three attempts',
      detail:
        'An `UNAVAILABLE` answer is retried up to `MAX_ATTEMPTS` = 3; any other status (a missed deadline, a refused request) ends the attempts at once. The starter retries every error, so a request the model refuses is sent again.',
      match: {
        python: {all: [/\.code\(\)[^\n]*StatusCode\.UNAVAILABLE/], none: [/except grpc\.RpcError:\s*\n\s*continue/]},
        typescript: {all: [/\.code[^\n]*grpc\.status\.UNAVAILABLE/], none: [/catch\s*\{\s*\}/]},
        go: {all: [/status\.Code\(err\)[^\n]*codes\.Unavailable/], none: [/if err != nil \{\s*\n\s*continue/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/], none: [/case _: StatusRuntimeException => \(\)/]},
        cpp: {all: [/error_code\(\)[^\n]*StatusCode::UNAVAILABLE/], none: [/\.ok\(\)\)\s*continue;/]},
      },
    },
    {
      id: 'fallback-order',
      title: 'Falls back to the popularity order, not an empty list',
      detail:
        'When the attempts end without an answer the candidates come back in the popularity order (`popularity_order(surface, candidate_ids)`), so the page still fills; the starter returns an empty list.',
      match: {
        python: {all: [/store\.popularity_order\(\s*surface,\s*candidate_ids\s*\)/], none: [/"items":\s*\[\]/]},
        typescript: {all: [/popularityOrder\(\s*surface,\s*candidateIds\s*\)/], none: [/items:\s*\[\]/]},
        go: {
          all: [/store\.PopularityOrder\(\s*ctx,\s*surface,\s*candidateIDs\s*\)/],
          none: [/return types\.Ranked\{\}/],
        },
        scala: {all: [/Store\.popularityOrder\(\s*surface,\s*candidateIds\s*\)/], none: [/Ranked\(Seq\.empty/]},
        cpp: {all: [/store::popularityOrder\(\s*surface,\s*candidate_ids\s*\)/], none: [/return recs::Ranked\{\};/]},
      },
    },
    {
      id: 'fallback-tag',
      title: 'Marks the popularity order as the fallback',
      detail:
        'The fallback is stamped with the popularity version (`popularity-v1`) and `fallback: true`, so the response and the impression event carry it and an A/B read does not credit the popularity order to the model.',
      match: {
        python: {all: [/store\.POPULARITY_VERSION/, /"fallback":\s*True/]},
        typescript: {all: [/model_version:\s*POPULARITY_VERSION/, /fallback:\s*true/]},
        go: {all: [/ModelVersion:\s*store\.PopularityVersion/, /Fallback:\s*true/]},
        scala: {all: [/Store\.PopularityVersion,\s*fallback\s*=\s*true/]},
        cpp: {all: [/store::kPopularityVersion,\s*true\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import ranking_pb2
import ranking_pb2_grpc
from recs import store  # popularity_order(surface, candidate_ids), POPULARITY_VERSION
from state import load_features  # step 2: the user's feature vector, None when there is none

MAX_ATTEMPTS = 3

ranker = ranking_pb2_grpc.RankerStub(grpc.insecure_channel("ranker:9000"))


def rank(tenant: str, user_id: str, surface: str, candidate_ids: list[str]) -> dict:
    """The candidates ranked for the user: {items: [{id, score}] best first, model_version, fallback}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    features = load_features(tenant, user_id)
    request = ranking_pb2.RankRequest(
        tenant=tenant, user_id=user_id, surface=surface, candidate_ids=candidate_ids, features=features["values"] if features else []
    )
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = ranker.Rank(request)
        except grpc.RpcError:
            continue  # the ranker is flaky: try again
        return {"items": [{"id": item.id, "score": item.score} for item in reply.items], "model_version": reply.model_version, "fallback": False}
    return {"items": [], "model_version": "", "fallback": False}
`,
      solution: `import grpc

import ranking_pb2
import ranking_pb2_grpc
from recs import store  # popularity_order(surface, candidate_ids), POPULARITY_VERSION
from state import load_features  # step 2: the user's feature vector, None when there is none

MAX_ATTEMPTS = 3
RANK_DEADLINE_S = 0.5

ranker = ranking_pb2_grpc.RankerStub(grpc.insecure_channel("ranker:9000"))


def rank(tenant: str, user_id: str, surface: str, candidate_ids: list[str]) -> dict:
    """The candidates ranked for the user: {items: [{id, score}] best first, model_version, fallback}."""
    features = load_features(tenant, user_id)
    request = ranking_pb2.RankRequest(
        tenant=tenant, user_id=user_id, surface=surface, candidate_ids=candidate_ids, features=features["values"] if features else []
    )
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = ranker.Rank(request, timeout=RANK_DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.UNAVAILABLE:
                continue  # another replica may answer
            break  # a missed deadline or a refused request: another attempt will not change it
        return {"items": [{"id": item.id, "score": item.score} for item in reply.items], "model_version": reply.model_version, "fallback": False}
    # The page still fills, and the stamp keeps the popularity order from counting as the model's.
    return {"items": store.popularity_order(surface, candidate_ids), "model_version": store.POPULARITY_VERSION, "fallback": True}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {POPULARITY_VERSION, popularityOrder} from 'recs/store';
import type {Ranked} from 'recs/types';

import {loadFeatures} from './state'; // step 2: the user's feature vector, null when there is none

export const MAX_ATTEMPTS = 3;

interface RankRequest {
  tenant: string;
  user_id: string;
  surface: string;
  candidate_ids: string[];
  features: number[];
}

interface RankResponse {
  items: {id: string; score: number}[];
  model_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ranking.proto')) as unknown as {
  recsys: {Ranker: grpc.ServiceClientConstructor};
};
const ranker = new pkg.recsys.Ranker('ranker:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Rank(request: RankRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<RankResponse>;
};

/** The candidates ranked for the user: best first, stamped with the version that ordered them. */
export async function rank(tenant: string, userId: string, surface: string, candidateIds: string[]): Promise<Ranked> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const features = await loadFeatures(tenant, userId);
  const request = {tenant, user_id: userId, surface, candidate_ids: candidateIds, features: features?.values ?? []};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await ranker.Rank(request, new grpc.Metadata(), {});
      return {items: reply.items.map(({id, score}) => ({id, score})), model_version: reply.model_version, fallback: false};
    } catch {
      // the ranker is flaky: try again
    }
  }
  return {items: [], model_version: '', fallback: false};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {POPULARITY_VERSION, popularityOrder} from 'recs/store';
import type {Ranked} from 'recs/types';

import {loadFeatures} from './state'; // step 2: the user's feature vector, null when there is none

export const MAX_ATTEMPTS = 3;
export const RANK_DEADLINE_MS = 500;

interface RankRequest {
  tenant: string;
  user_id: string;
  surface: string;
  candidate_ids: string[];
  features: number[];
}

interface RankResponse {
  items: {id: string; score: number}[];
  model_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ranking.proto')) as unknown as {
  recsys: {Ranker: grpc.ServiceClientConstructor};
};
const ranker = new pkg.recsys.Ranker('ranker:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Rank(request: RankRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<RankResponse>;
};

/** The candidates ranked for the user: best first, stamped with the version that ordered them. */
export async function rank(tenant: string, userId: string, surface: string, candidateIds: string[]): Promise<Ranked> {
  const features = await loadFeatures(tenant, userId);
  const request = {tenant, user_id: userId, surface, candidate_ids: candidateIds, features: features?.values ?? []};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await ranker.Rank(request, new grpc.Metadata(), {deadline: Date.now() + RANK_DEADLINE_MS});
      return {items: reply.items.map(({id, score}) => ({id, score})), model_version: reply.model_version, fallback: false};
    } catch (e) {
      // UNAVAILABLE: another replica may answer. A missed deadline or a refused request will not change.
      if ((e as grpc.ServiceError).code !== grpc.status.UNAVAILABLE) break;
    }
  }
  // The page still fills, and the stamp keeps the popularity order from counting as the model's.
  return {items: await popularityOrder(surface, candidateIds), model_version: POPULARITY_VERSION, fallback: true};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "recs/gen/ranking"
	"recs/types"
)

const maxAttempts = 3

var (
	rankerConn, _ = grpc.NewClient("ranker:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	ranker        = pb.NewRankerClient(rankerConn)
)

// Built in step 2 (state.go): the user's feature vector, nil when there is none. Until the steps are
// wired together it gives none; the checks wire their own.
var loadFeatures = func(ctx context.Context, tenant, userID string) *types.Features { return nil }

func rankedFrom(reply *pb.RankResponse) types.Ranked {
	items := make([]types.Item, 0, len(reply.GetItems()))
	for _, item := range reply.GetItems() {
		items = append(items, types.Item{ID: item.GetId(), Score: item.GetScore()})
	}
	return types.Ranked{Items: items, ModelVersion: reply.GetModelVersion()}
}

// rank is the candidates ranked for the user: best first, stamped with the version that ordered them.
func rank(ctx context.Context, tenant, userID, surface string, candidateIDs []string) types.Ranked {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	request := &pb.RankRequest{Tenant: tenant, UserId: userID, Surface: surface, CandidateIds: candidateIDs}
	if features := loadFeatures(ctx, tenant, userID); features != nil {
		request.Features = features.Values
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reply, err := ranker.Rank(ctx, request)
		if err != nil {
			continue // the ranker is flaky: try again
		}
		return rankedFrom(reply)
	}
	return types.Ranked{}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "recs/gen/ranking"
	"recs/store" // store.PopularityOrder(ctx, surface, candidateIDs), store.PopularityVersion
	"recs/types"
)

const (
	maxAttempts  = 3
	rankDeadline = 500 * time.Millisecond
)

var (
	rankerConn, _ = grpc.NewClient("ranker:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	ranker        = pb.NewRankerClient(rankerConn)
)

// Built in step 2 (state.go): the user's feature vector, nil when there is none. Until the steps are
// wired together it gives none; the checks wire their own.
var loadFeatures = func(ctx context.Context, tenant, userID string) *types.Features { return nil }

func rankedFrom(reply *pb.RankResponse) types.Ranked {
	items := make([]types.Item, 0, len(reply.GetItems()))
	for _, item := range reply.GetItems() {
		items = append(items, types.Item{ID: item.GetId(), Score: item.GetScore()})
	}
	return types.Ranked{Items: items, ModelVersion: reply.GetModelVersion()}
}

// rank is the candidates ranked for the user: best first, stamped with the version that ordered them.
func rank(ctx context.Context, tenant, userID, surface string, candidateIDs []string) types.Ranked {
	request := &pb.RankRequest{Tenant: tenant, UserId: userID, Surface: surface, CandidateIds: candidateIDs}
	if features := loadFeatures(ctx, tenant, userID); features != nil {
		request.Features = features.Values
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, rankDeadline)
		reply, err := ranker.Rank(callCtx, request)
		cancel()
		if err == nil {
			return rankedFrom(reply)
		}
		if status.Code(err) != codes.Unavailable {
			break // a missed deadline or a refused request: another attempt will not change it
		}
	}
	// The page still fills, and the stamp keeps the popularity order from counting as the model's.
	return types.Ranked{Items: store.PopularityOrder(ctx, surface, candidateIDs), ModelVersion: store.PopularityVersion, Fallback: true}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import recs.{Ranked, ScoredItem}
import recsys.ranking.{RankRequest, RankResponse, RankerGrpc}

object Client {
  val MaxAttempts = 3

  private val ranker = RankerGrpc.blockingStub(ManagedChannelBuilder.forAddress("ranker", 9000).usePlaintext().build())

  private def rankedFrom(reply: RankResponse): Ranked =
    Ranked(reply.items.map(item => ScoredItem(item.id, item.score)), reply.modelVersion, fallback = false)

  /** The candidates ranked for the user: best first, stamped with the version that ordered them. */
  def rank(tenant: String, userId: String, surface: String, candidateIds: Seq[String]): Ranked = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val features = State.loadFeatures(tenant, userId).map(_.values).getOrElse(Seq.empty)
    val request = RankRequest(tenant, userId, surface, candidateIds, features)
    var result: Option[Ranked] = None
    var attempts = 0
    while (result.isEmpty && attempts < MaxAttempts) {
      attempts += 1
      try result = Some(rankedFrom(ranker.rank(request)))
      catch {
        case _: StatusRuntimeException => () // the ranker is flaky: try again
      }
    }
    result.getOrElse(Ranked(Seq.empty, "", fallback = false))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import recs.{Ranked, ScoredItem, Store}
import recsys.ranking.{RankRequest, RankResponse, RankerGrpc}

object Client {
  val MaxAttempts = 3
  val RankDeadlineMs = 500L

  private val ranker = RankerGrpc.blockingStub(ManagedChannelBuilder.forAddress("ranker", 9000).usePlaintext().build())

  private def rankedFrom(reply: RankResponse): Ranked =
    Ranked(reply.items.map(item => ScoredItem(item.id, item.score)), reply.modelVersion, fallback = false)

  /** The candidates ranked for the user: best first, stamped with the version that ordered them. */
  def rank(tenant: String, userId: String, surface: String, candidateIds: Seq[String]): Ranked = {
    val features = State.loadFeatures(tenant, userId).map(_.values).getOrElse(Seq.empty)
    val request = RankRequest(tenant, userId, surface, candidateIds, features)
    var result: Option[Ranked] = None
    var attempts = 0
    var retryable = true
    while (result.isEmpty && retryable && attempts < MaxAttempts) {
      attempts += 1
      try result = Some(rankedFrom(ranker.withDeadlineAfter(RankDeadlineMs, TimeUnit.MILLISECONDS).rank(request)))
      catch {
        // UNAVAILABLE: another replica may answer. A missed deadline or a refused request will not change.
        case e: StatusRuntimeException => retryable = e.getStatus.getCode == Status.Code.UNAVAILABLE
      }
    }
    // The page still fills, and the stamp keeps the popularity order from counting as the model's.
    result.getOrElse(Ranked(Store.popularityOrder(surface, candidateIds), Store.PopularityVersion, fallback = true))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <optional>
#include <string>
#include <vector>

#include "ranking.grpc.pb.h"
#include "recs/store.h"  // store::popularityOrder(surface, candidate_ids), store::kPopularityVersion
#include "recs/types.h"

constexpr int kMaxAttempts = 3;

auto ranker = recsys::Ranker::NewStub(grpc::CreateChannel("ranker:9000", grpc::InsecureChannelCredentials()));

// Built in step 2 (state.cpp): the user's feature vector, nothing when there is none.
std::optional<recs::Features> loadFeatures(const std::string& tenant, const std::string& user_id);

recs::Ranked rankedFrom(const recsys::RankResponse& reply) {
  recs::Ranked out;
  for (const auto& item : reply.items()) out.items.push_back(recs::Item{item.id(), item.score()});
  out.model_version = reply.model_version();
  return out;
}

// The candidates ranked for the user: best first, stamped with the version that ordered them.
recs::Ranked rank(const std::string& tenant, const std::string& user_id, const std::string& surface,
                  const std::vector<std::string>& candidate_ids) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  recsys::RankRequest request;
  request.set_tenant(tenant);
  request.set_user_id(user_id);
  request.set_surface(surface);
  for (const std::string& id : candidate_ids) request.add_candidate_ids(id);
  if (const auto features = loadFeatures(tenant, user_id)) {
    for (const double value : features->values) request.add_features(value);
  }
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    recsys::RankResponse reply;
    if (!ranker->Rank(&ctx, request, &reply).ok()) continue;  // the ranker is flaky: try again
    return rankedFrom(reply);
  }
  return recs::Ranked{};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "ranking.grpc.pb.h"
#include "recs/store.h"  // store::popularityOrder(surface, candidate_ids), store::kPopularityVersion
#include "recs/types.h"

constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kRankDeadline{500};

auto ranker = recsys::Ranker::NewStub(grpc::CreateChannel("ranker:9000", grpc::InsecureChannelCredentials()));

// Built in step 2 (state.cpp): the user's feature vector, nothing when there is none.
std::optional<recs::Features> loadFeatures(const std::string& tenant, const std::string& user_id);

recs::Ranked rankedFrom(const recsys::RankResponse& reply) {
  recs::Ranked out;
  for (const auto& item : reply.items()) out.items.push_back(recs::Item{item.id(), item.score()});
  out.model_version = reply.model_version();
  return out;
}

// The candidates ranked for the user: best first, stamped with the version that ordered them.
recs::Ranked rank(const std::string& tenant, const std::string& user_id, const std::string& surface,
                  const std::vector<std::string>& candidate_ids) {
  recsys::RankRequest request;
  request.set_tenant(tenant);
  request.set_user_id(user_id);
  request.set_surface(surface);
  for (const std::string& id : candidate_ids) request.add_candidate_ids(id);
  if (const auto features = loadFeatures(tenant, user_id)) {
    for (const double value : features->values) request.add_features(value);
  }
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kRankDeadline);
    recsys::RankResponse reply;
    const grpc::Status status = ranker->Rank(&ctx, request, &reply);
    if (status.ok()) return rankedFrom(reply);
    // UNAVAILABLE: another replica may answer. A missed deadline or a refused request will not change.
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) break;
  }
  // The page still fills, and the stamp keeps the popularity order from counting as the model's.
  return recs::Ranked{store::popularityOrder(surface, candidate_ids), store::kPopularityVersion, true};
}
`,
    },
  },
  harness: {
    python: `import grpc

import ranking_pb2
import ranking_pb2_grpc

CANDIDATES = ["c-1", "c-2", "c-3", "c-4"]
MODEL = ["c-2", "c-4", "c-1", "c-3"]  # the ranker's order
POPULAR = ["c-3", "c-1", "c-4", "c-2"]  # popularity:home; c-2 was never engaged with


def _score(item_id):
    return int(item_id.split("-")[1]) * 37 % 101 / 100


class Ranker(ranking_pb2_grpc.RankerServicer):
    def Rank(self, request, context):
        items = sorted(request.candidate_ids, key=lambda c: -_score(c))
        return ranking_pb2.RankResponse(items=[ranking_pb2.ScoredItem(id=c, score=_score(c)) for c in items], model_version="ranker-v7")


class FeatureService(ranking_pb2_grpc.FeatureServiceServicer):
    def UserFeatures(self, request, context):
        return ranking_pb2.FeatureVector(values=[0.5])


def _client(ctx):
    ctx.grpc.serve(ranking_pb2_grpc.add_RankerServicer_to_server, Ranker())
    ctx.grpc.serve(ranking_pb2_grpc.add_FeatureServiceServicer_to_server, FeatureService())
    ctx.redis.zadd("popularity:home", {"c-3": 40, "c-1": 25, "c-4": 10})
    return ctx.load("client")


def _ids(result):
    return [item["id"] for item in result["items"]]


def _rank_calls(ctx):
    return len(ctx.grpc.calls_to("Rank"))


def check_deadline(ctx):
    m = _client(ctx)
    result = m.rank("t1", "u-1", "home", CANDIDATES)
    assert _ids(result) == MODEL, f"with the ranker healthy rank answered {_ids(result)}, expected the model's order {MODEL}"
    for call in ctx.grpc.calls_to("Rank"):
        assert call.timeout is not None, "a Rank call carries no deadline: one ranker replica that hangs holds the request open as long as it hangs"
        assert 0.4 <= call.timeout <= 0.6, f"a Rank call carries a {call.timeout} s deadline, expected RANK_DEADLINE_S = 0.5"
    ctx.grpc.set_latency("Rank", 5.0)
    before = ctx.clock.time()
    m.rank("t1", "u-1", "home", CANDIDATES)
    waited = ctx.clock.time() - before
    assert waited <= 1.0, f"with the ranker answering in 5 s, rank took {waited:.1f} s: the deadline must end the call at 500 ms, and a missed deadline is not retried"


def check_retry_policy(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Rank", grpc.StatusCode.UNAVAILABLE, "replica restarting", times=2)
    result = m.rank("t1", "u-1", "home", CANDIDATES)
    calls = _rank_calls(ctx)
    assert calls == 3 and _ids(result) == MODEL, f"with two UNAVAILABLE answers and then a healthy replica, rank made {calls} calls and answered {_ids(result)}: UNAVAILABLE is retried, up to 3 attempts"
    ctx.grpc.fail("Rank", grpc.StatusCode.INVALID_ARGUMENT, "feature vector has the wrong width")
    m.rank("t1", "u-1", "home", CANDIDATES)
    sent = _rank_calls(ctx) - calls
    assert sent == 1, f"a request the ranker refused (INVALID_ARGUMENT) was sent {sent} times: it will be refused again, so end the attempts"
    before = _rank_calls(ctx)
    ctx.grpc.fail("Rank", grpc.StatusCode.UNAVAILABLE, "every replica restarting", times=5)
    m.rank("t1", "u-1", "home", CANDIDATES)
    sent = _rank_calls(ctx) - before
    assert sent == 3, f"with every replica UNAVAILABLE rank made {sent} attempts, expected MAX_ATTEMPTS = 3"


def check_fallback_order(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Rank", grpc.StatusCode.UNAVAILABLE, "every replica restarting", times=3)
    result = m.rank("t1", "u-1", "home", CANDIDATES)
    assert _ids(result) == POPULAR, f"with the ranker down rank answered {_ids(result)}: the page must still fill, in the popularity order {POPULAR}"
    ctx.grpc.set_latency("Rank", 5.0)
    result = m.rank("t1", "u-1", "home", CANDIDATES)
    assert _ids(result) == POPULAR, f"with the ranker past its deadline rank answered {_ids(result)}, expected the popularity order {POPULAR}"


def check_fallback_tag(ctx):
    m = _client(ctx)
    healthy = m.rank("t1", "u-1", "home", CANDIDATES)
    assert healthy["fallback"] is False and healthy["model_version"] == "ranker-v7", f"a model answer must be stamped ranker-v7 with fallback False, got {healthy}"
    ctx.grpc.fail("Rank", grpc.StatusCode.UNAVAILABLE, "every replica restarting", times=3)
    degraded = m.rank("t1", "u-1", "home", CANDIDATES)
    assert degraded["fallback"] is True, f"the list served with the ranker down came back with fallback {degraded['fallback']!r}: unmarked, its impressions count as the model's in every A/B read"
    assert degraded["model_version"] == "popularity-v1", f"the list served with the ranker down is stamped {degraded['model_version']!r}, expected popularity-v1"
`,
    typescript: `const CANDIDATES = ['c-1', 'c-2', 'c-3', 'c-4'];
const MODEL = ['c-2', 'c-4', 'c-1', 'c-3']; // the ranker's order
const POPULAR = ['c-3', 'c-1', 'c-4', 'c-2']; // popularity:home; c-2 was never engaged with

const score = (id: string): number => ((Number(id.split('-')[1]) * 37) % 101) / 100;

function client(ctx) {
  const pkg = ctx.proto('ranking.proto');
  ctx.grpc.serve(pkg.recsys.Ranker.service, {
    Rank(call, callback) {
      const items = [...call.request.candidate_ids].sort((a, b) => score(b) - score(a)).map(id => ({id, score: score(id)}));
      callback(null, {items, model_version: 'ranker-v7'});
    },
  });
  ctx.grpc.serve(pkg.recsys.FeatureService.service, {
    UserFeatures(call, callback) {
      callback(null, {values: [0.5]});
    },
  });
  ctx.redis.zadd('popularity:home', 40, 'c-3', 25, 'c-1', 10, 'c-4');
  return ctx.load('client');
}

const ids = (result): string[] => result.items.map(item => item.id);
const rankCalls = (ctx): number => ctx.grpc.callsTo('Rank').length;

export async function check_deadline(ctx) {
  const m = client(ctx);
  const result = await m.rank('t1', 'u-1', 'home', CANDIDATES);
  assert.deepStrictEqual(ids(result), MODEL, \`with the ranker healthy rank answered \${JSON.stringify(ids(result))}, expected the model's order\`);
  for (const call of ctx.grpc.callsTo('Rank')) {
    assert(call.timeout !== null && call.timeout !== undefined, 'a Rank call carries no deadline: one ranker replica that hangs holds the request open as long as it hangs');
    assert(call.timeout >= 0.4 && call.timeout <= 0.6, \`a Rank call carries a \${call.timeout} s deadline, expected RANK_DEADLINE_MS = 500\`);
  }
  ctx.grpc.setLatency('Rank', 5.0);
  const before = ctx.clock.now();
  await m.rank('t1', 'u-1', 'home', CANDIDATES);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 1.0, \`with the ranker answering in 5 s, rank took \${waited.toFixed(1)} s: the deadline must end the call at 500 ms, and a missed deadline is not retried\`);
}

export async function check_retry_policy(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('Rank', ctx.grpc.status.UNAVAILABLE, 'replica restarting', 2);
  const result = await m.rank('t1', 'u-1', 'home', CANDIDATES);
  const calls = rankCalls(ctx);
  assert(calls === 3 && JSON.stringify(ids(result)) === JSON.stringify(MODEL), \`with two UNAVAILABLE answers and then a healthy replica, rank made \${calls} calls and answered \${JSON.stringify(ids(result))}: UNAVAILABLE is retried, up to 3 attempts\`);
  ctx.grpc.fail('Rank', ctx.grpc.status.INVALID_ARGUMENT, 'feature vector has the wrong width');
  await m.rank('t1', 'u-1', 'home', CANDIDATES);
  let sent = rankCalls(ctx) - calls;
  assert.equal(sent, 1, \`a request the ranker refused (INVALID_ARGUMENT) was sent \${sent} times: it will be refused again, so end the attempts\`);
  const before = rankCalls(ctx);
  ctx.grpc.fail('Rank', ctx.grpc.status.UNAVAILABLE, 'every replica restarting', 5);
  await m.rank('t1', 'u-1', 'home', CANDIDATES);
  sent = rankCalls(ctx) - before;
  assert.equal(sent, 3, \`with every replica UNAVAILABLE rank made \${sent} attempts, expected MAX_ATTEMPTS = 3\`);
}

export async function check_fallback_order(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('Rank', ctx.grpc.status.UNAVAILABLE, 'every replica restarting', 3);
  let result = await m.rank('t1', 'u-1', 'home', CANDIDATES);
  assert.deepStrictEqual(ids(result), POPULAR, \`with the ranker down rank answered \${JSON.stringify(ids(result))}: the page must still fill, in the popularity order\`);
  ctx.grpc.setLatency('Rank', 5.0);
  result = await m.rank('t1', 'u-1', 'home', CANDIDATES);
  assert.deepStrictEqual(ids(result), POPULAR, \`with the ranker past its deadline rank answered \${JSON.stringify(ids(result))}, expected the popularity order\`);
}

export async function check_fallback_tag(ctx) {
  const m = client(ctx);
  const healthy = await m.rank('t1', 'u-1', 'home', CANDIDATES);
  assert(healthy.fallback === false && healthy.model_version === 'ranker-v7', \`a model answer must be stamped ranker-v7 with fallback false, got \${JSON.stringify(healthy)}\`);
  ctx.grpc.fail('Rank', ctx.grpc.status.UNAVAILABLE, 'every replica restarting', 3);
  const degraded = await m.rank('t1', 'u-1', 'home', CANDIDATES);
  assert.equal(degraded.fallback, true, \`the list served with the ranker down came back with fallback \${degraded.fallback}: unmarked, its impressions count as the model's in every A/B read\`);
  assert.equal(degraded.model_version, 'popularity-v1', \`the list served with the ranker down is stamped \${JSON.stringify(degraded.model_version)}, expected popularity-v1\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"google.golang.org/grpc/codes"

	pb "recs/gen/ranking"
	"recs/types"

	"leetbuild/harness"
)

var (
	clientBg   = context.Background()
	candidates = []string{"c-1", "c-2", "c-3", "c-4"}
	modelOrder = []string{"c-2", "c-4", "c-1", "c-3"} // the ranker's order
	popular    = []string{"c-3", "c-1", "c-4", "c-2"} // popularity:home; c-2 was never engaged with
)

func modelScore(id string) float64 {
	n, _ := strconv.Atoi(strings.TrimPrefix(id, "c-"))
	return float64(n*37%101) / 100
}

type rankerPeer struct {
	pb.UnimplementedRankerServer
}

func (rankerPeer) Rank(_ context.Context, req *pb.RankRequest) (*pb.RankResponse, error) {
	items := []*pb.ScoredItem{}
	for _, id := range req.GetCandidateIds() {
		items = append(items, &pb.ScoredItem{Id: id, Score: modelScore(id)})
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].Score > items[j].Score })
	return &pb.RankResponse{Items: items, ModelVersion: "ranker-v7"}, nil
}

func client(ctx *harness.Ctx) {
	pb.RegisterRankerServer(ctx.GRPC.Server(""), rankerPeer{})
	loadFeatures = func(context.Context, string, string) *types.Features { return &types.Features{Values: []float64{0.5}} }
	ctx.Redis.Do("ZADD", "popularity:home", 40, "c-3", 25, "c-1", 10, "c-4")
}

func ids(r types.Ranked) []string {
	out := []string{}
	for _, item := range r.Items {
		out = append(out, item.ID)
	}
	return out
}

func rankCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Rank", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	result := rank(clientBg, "t1", "u-1", "home", candidates)
	ctx.Equal(ids(result), modelOrder, "with the ranker healthy, the order rank answered")
	for _, call := range ctx.GRPC.CallsTo("Rank", "") {
		ctx.Assert(call.HasDeadline(), "a Rank call carries no deadline: one ranker replica that hangs holds the request open as long as it hangs")
		ctx.Assert(call.Timeout.Seconds() >= 0.4 && call.Timeout.Seconds() <= 0.6, "a Rank call carries a %v deadline, expected rankDeadline = 500 ms", call.Timeout)
	}
	ctx.GRPC.SetLatency("Rank", 5.0, "")
	before := ctx.Clock.Now()
	rank(clientBg, "t1", "u-1", "home", candidates)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 1.0, "with the ranker answering in 5 s, rank took %.1f s: the deadline must end the call at 500 ms, and a missed deadline is not retried", waited)
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("Rank", codes.Unavailable, "replica restarting", 2, "")
	result := rank(clientBg, "t1", "u-1", "home", candidates)
	calls := rankCalls(ctx)
	ctx.Assert(calls == 3 && fmt.Sprint(ids(result)) == fmt.Sprint(modelOrder), "with two UNAVAILABLE answers and then a healthy replica, rank made %d calls and answered %v: UNAVAILABLE is retried, up to 3 attempts", calls, ids(result))
	ctx.GRPC.Fail("Rank", codes.InvalidArgument, "feature vector has the wrong width", 1, "")
	rank(clientBg, "t1", "u-1", "home", candidates)
	sent := rankCalls(ctx) - calls
	ctx.Equal(sent, 1, "a request the ranker refused (INVALID_ARGUMENT) will be refused again, so end the attempts; the times it was sent")
	before := rankCalls(ctx)
	ctx.GRPC.Fail("Rank", codes.Unavailable, "every replica restarting", 5, "")
	rank(clientBg, "t1", "u-1", "home", candidates)
	ctx.Equal(rankCalls(ctx)-before, 3, "with every replica UNAVAILABLE rank must stop at maxAttempts = 3; the attempts")
}

func CheckFallbackOrder(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("Rank", codes.Unavailable, "every replica restarting", 3, "")
	result := rank(clientBg, "t1", "u-1", "home", candidates)
	ctx.Equal(ids(result), popular, "with the ranker down the page must still fill, in the popularity order; rank answered")
	ctx.GRPC.SetLatency("Rank", 5.0, "")
	result = rank(clientBg, "t1", "u-1", "home", candidates)
	ctx.Equal(ids(result), popular, "with the ranker past its deadline, the order rank answered")
}

func CheckFallbackTag(ctx *harness.Ctx) {
	client(ctx)
	healthy := rank(clientBg, "t1", "u-1", "home", candidates)
	ctx.Assert(!healthy.Fallback && healthy.ModelVersion == "ranker-v7", "a model answer must be stamped ranker-v7 with fallback false, got %+v", healthy)
	ctx.GRPC.Fail("Rank", codes.Unavailable, "every replica restarting", 3, "")
	degraded := rank(clientBg, "t1", "u-1", "home", candidates)
	ctx.Equal(degraded.Fallback, true, "the list served with the ranker down must be marked: unmarked, its impressions count as the model's in every A/B read; fallback")
	ctx.Equal(degraded.ModelVersion, "popularity-v1", "the list served with the ranker down; its model_version")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

// Step 2's feature read, as the checks wire it: every user has one feature.
std::optional<recs::Features> loadFeatures(const std::string&, const std::string&) { return recs::Features{{0.5}, false}; }

namespace {

const std::vector<std::string> kCandidates{"c-1", "c-2", "c-3", "c-4"};
const std::vector<std::string> kModelOrder{"c-2", "c-4", "c-1", "c-3"};  // the ranker's order
const std::vector<std::string> kPopular{"c-3", "c-1", "c-4", "c-2"};     // popularity:home; c-2 was never engaged with

double modelScore(const std::string& id) { return static_cast<double>(std::stoi(id.substr(2)) * 37 % 101) / 100; }

class RankerPeer final : public recsys::Ranker::Service {
 public:
  grpc::Status Rank(grpc::ServerContext*, const recsys::RankRequest* req, recsys::RankResponse* out) override {
    std::vector<std::string> ids(req->candidate_ids().begin(), req->candidate_ids().end());
    std::stable_sort(ids.begin(), ids.end(), [](const std::string& a, const std::string& b) { return modelScore(a) > modelScore(b); });
    for (const auto& id : ids) {
      auto* item = out->add_items();
      item->set_id(id);
      item->set_score(modelScore(id));
    }
    out->set_model_version("ranker-v7");
    return grpc::Status::OK;
  }
};

void client(harness::Ctx& ctx) {
  static RankerPeer* peer = nullptr;
  delete peer;
  peer = new RankerPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  ctx.Redis.Do("ZADD", "popularity:home", 40, "c-3", 25, "c-1", 10, "c-4");
}

std::vector<std::string> ids(const recs::Ranked& r) {
  std::vector<std::string> out;
  for (const auto& item : r.items) out.push_back(item.id);
  return out;
}

size_t rankCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Rank").size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  const auto result = rank("t1", "u-1", "home", kCandidates);
  ctx.Equal(ids(result), kModelOrder, "with the ranker healthy, the order rank answered");
  for (const auto& call : ctx.GRPC.CallsTo("Rank")) {
    ctx.Assert(call.HasDeadline(), "a Rank call carries no deadline: one ranker replica that hangs holds the request open as long as it hangs");
    ctx.Assert(call.TimeoutSeconds() >= 0.4 && call.TimeoutSeconds() <= 0.6, "a Rank call carries a %v s deadline, expected kRankDeadline = 500 ms", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Rank", 5.0);
  const int64_t before = ctx.Clock.Now();
  rank("t1", "u-1", "home", kCandidates);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 1.0, "with the ranker answering in 5 s, rank took %.1f s: the deadline must end the call at 500 ms, and a missed deadline is not retried", waited);
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("Rank", grpc::StatusCode::UNAVAILABLE, "replica restarting", 2);
  const auto result = rank("t1", "u-1", "home", kCandidates);
  const size_t calls = rankCalls(ctx);
  ctx.Assert(calls == 3 && ids(result) == kModelOrder, "with two UNAVAILABLE answers and then a healthy replica, rank made %d calls: UNAVAILABLE is retried, up to 3 attempts", calls);
  ctx.GRPC.Fail("Rank", grpc::StatusCode::INVALID_ARGUMENT, "feature vector has the wrong width");
  rank("t1", "u-1", "home", kCandidates);
  ctx.Equal(rankCalls(ctx) - calls, 1, "a request the ranker refused (INVALID_ARGUMENT) will be refused again, so end the attempts; the times it was sent");
  const size_t before = rankCalls(ctx);
  ctx.GRPC.Fail("Rank", grpc::StatusCode::UNAVAILABLE, "every replica restarting", 5);
  rank("t1", "u-1", "home", kCandidates);
  ctx.Equal(rankCalls(ctx) - before, 3, "with every replica UNAVAILABLE rank must stop at kMaxAttempts = 3; the attempts");
}

void CheckFallbackOrder(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("Rank", grpc::StatusCode::UNAVAILABLE, "every replica restarting", 3);
  auto result = rank("t1", "u-1", "home", kCandidates);
  ctx.Equal(ids(result), kPopular, "with the ranker down the page must still fill, in the popularity order; rank answered");
  ctx.GRPC.SetLatency("Rank", 5.0);
  result = rank("t1", "u-1", "home", kCandidates);
  ctx.Equal(ids(result), kPopular, "with the ranker past its deadline, the order rank answered");
}

void CheckFallbackTag(harness::Ctx& ctx) {
  client(ctx);
  const auto healthy = rank("t1", "u-1", "home", kCandidates);
  ctx.Assert(!healthy.fallback && healthy.model_version == "ranker-v7", "a model answer must be stamped ranker-v7 with fallback false, got %q fallback %t", healthy.model_version, healthy.fallback);
  ctx.GRPC.Fail("Rank", grpc::StatusCode::UNAVAILABLE, "every replica restarting", 3);
  const auto degraded = rank("t1", "u-1", "home", kCandidates);
  ctx.Equal(degraded.fallback, true, "the list served with the ranker down must be marked: unmarked, its impressions count as the model's in every A/B read; fallback");
  ctx.Equal(degraded.model_version, "popularity-v1", "the list served with the ranker down; its model_version");
}
`,
  },
  hints: [
    "Make the ranker hang and the request hangs with it; take it down and the user gets an empty page, which the impression stream records as the model's list.",
    'No attempt carries a deadline, every error is treated as worth another try, and when the attempts run out the function has nothing to return but an empty, unmarked list.',
    'Pass `timeout=RANK_DEADLINE_S` (0.5); in the `except`, `continue` only on `StatusCode.UNAVAILABLE`, else `break`; after the loop return `store.popularity_order(surface, candidate_ids)` with `store.POPULARITY_VERSION` and `fallback: True`.',
  ],
  debrief: `The status code decides the retry: \`UNAVAILABLE\` says a replica was restarting, so another attempt can land elsewhere, while a refused request or a missed deadline will fail the same way and only spends the user's latency. The deadline bounds the worst case at three times 500 ms instead of whatever a stuck replica does. The fallback is two decisions: the popularity order keeps the page full, and the stamp keeps that order out of the model's numbers, because an unmarked fallback during an outage reads as the new model losing. Production rankers budget the deadline from the request's own remaining time, hedge a second call to another replica, and trip a circuit breaker so a dead ranker costs nothing per request.`,
};
