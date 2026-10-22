import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Ranking model call with a popularity fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['recsvc', 'ranker', 'popularity'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: while the ranker is healthy
every request comes back with an ordered list and the demo looks right. Every failure path in it is
wrong. Find them, fix them, and prove the fix with the checks below.

Implement \`rank(tenant, user, candidate_ids)\`, the client recsvc calls for the ranking model. It
returns the ordered item ids together with a degraded marker and the model version.

- Each attempt carries a **500 ms** deadline (\`timeout=\`, \`deadline:\`, \`WithTimeout\`,
  \`withDeadlineAfter\`, \`set_deadline\`). Without one a single slow ranker holds the recommendation
  request open for as long as it likes.
- Attempts are bounded to **3** and only \`UNAVAILABLE\` is retried. \`INVALID_ARGUMENT\` — a
  malformed candidate payload — is our bug, not a transient one: it fails fast. Retrying the same
  bad payload three times spends load on the ranker’s hottest path and still fails.
- \`DEADLINE_EXCEEDED\` is not retried either: the ranker has just told us it cannot answer inside
  the budget, so the next attempt is another 500 ms spent on a service that is already failing us.
- When the attempt budget is gone, or the deadline was missed, degrade to the **popularity order**
  over the same candidates (\`popularity_order(candidate_ids)\`, provided) instead of an empty list:
  an empty list looks like a bug, and a popularity list is a real answer for the user.
- The degraded result is tagged — \`"fallback": true\` in Python, \`fallback: true\`, \`Fallback: true\`,
  \`fallback = true\` in the other languages — and stamped with the **popularity model version**, and
  both travel out of the client on the returned result, so the impression event for that response can
  record that the list was degraded. An unmarked fallback silently corrupts every offline comparison
  built from those events.
- Log the outcome with tenant, user, item count and the fallback flag — never feature values.

**Failure mode the checks target.** The draft gets all four failure paths wrong. It calls without a
deadline, so one stuck ranker pins the request. It answers an empty list on a timeout, so a degraded
response is indistinguishable from “no candidates” and the user sees nothing. It never tags the
fallback, so the A/B analysis counts a popularity list as a model win and nobody can tell whether the
last change helped or the ranker was simply down. And its retry loop re-sends a malformed candidate
payload, spending the ranker’s capacity on a request that can never succeed. All four are invisible
against a healthy demo ranker and loud in production.`,
  sequence: {
    participants: ['Recommendation API', 'Ranking model', 'Popularity order'],
    messages: [
      {
        from: 'Recommendation API',
        to: 'Ranking model',
        label: 'Rank(tenant, user, candidate_ids) · deadline 500 ms · attempt ≤ 3',
        kind: 'sync',
      },
      {from: 'Ranking model', to: 'Recommendation API', label: 'items + model_version', kind: 'reply'},
      {
        from: 'Recommendation API',
        to: 'Recommendation API',
        label: 'retry only UNAVAILABLE · INVALID_ARGUMENT fails fast',
        kind: 'sync',
      },
      {from: 'Recommendation API', to: 'Ranking model', label: 'Rank · last attempt · deadline 500 ms', kind: 'sync'},
      {from: 'Ranking model', to: 'Recommendation API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Recommendation API', to: 'Popularity order', label: 'popularity_order(candidate_ids)', kind: 'sync'},
      {
        from: 'Popularity order',
        to: 'Recommendation API',
        label: 'the same candidates, precomputed order',
        kind: 'reply',
      },
      {
        from: 'Recommendation API',
        to: 'Recommendation API',
        label: '{items, fallback: true, model_version} → impression event',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 500 ms deadline',
      detail:
        'The call is created with a 500 ms deadline — a call timeout (`timeout=`), `deadline: Date.now() + RANK_TIMEOUT_MS`, a context with timeout, `withDeadlineAfter` or `set_deadline`. Without it one slow ranker holds the recommendation request open indefinitely.',
      match: {
        python: {all: [/RANK_TIMEOUT_S\s*=\s*0\.5/, /timeout=RANK_TIMEOUT_S/, /\.Rank\(/]},
        typescript: {
          all: [/RANK_TIMEOUT_MS\s*=\s*500/, /deadline:\s*Date\.now\(\)\s*\+\s*RANK_TIMEOUT_MS/, /\.Rank\(/],
        },
        go: {all: [/rankTimeoutMS\s*=\s*500/, /context\.WithTimeout/, /\.Rank\(/]},
        scala: {all: [/RankTimeoutMs\s*=\s*500/, /withDeadlineAfter/, /\.rank\(/]},
        cpp: {all: [/kRankTimeoutMs\s*=\s*500/, /set_deadline\(/, /->Rank\(/]},
      },
    },
    {
      id: 'fallback-on-timeout',
      title: 'A DEADLINE_EXCEEDED returns the popularity order, never an empty list',
      detail:
        'A ranker that misses the deadline is replaced by the same candidates in the precomputed popularity order (`popularity_order(candidate_ids)`), not by an empty list — “no candidates” and “the ranker is slow” must not look the same. The draft answers an empty list on the timeout.',
      match: {
        python: {all: [/StatusCode\.DEADLINE_EXCEEDED/, /(?<!def )\bpopularity_order\(/], none: [/items\s*=\s*\[\]/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /\bpopularityOrder\(/], none: [/items:\s*\[\]/]},
        go: {all: [/codes\.DeadlineExceeded/, /(?<!func )\bpopularityOrder\(/], none: [/Items:\s*\[\]string\{\}/]},
        scala: {
          all: [/Status\.Code\.DEADLINE_EXCEEDED/, /(?<!def )\bpopularityOrder\(/],
          none: [/items\s*=\s*Seq\.empty/],
        },
        cpp: {all: [/StatusCode::DEADLINE_EXCEEDED/, /\bpopularity_order\(/], none: [/return RankingResult\{\}/]},
      },
    },
    {
      id: 'fallback-tag',
      title: 'The degraded list is tagged',
      detail:
        'The popularity result is explicitly marked (`fallback = True` / `fallback: true` / `Fallback: true`) right where the popularity order is put into the result, so metrics and A/B analysis can count degraded responses instead of averaging them in with real ranking. The draft marks nothing.',
      match: {
        python: {all: [/fallback\s*=\s*True/], order: [/\bpopularity_order\(/, /fallback\s*=\s*True/]},
        typescript: {all: [/fallback:\s*true/], order: [/\bpopularityOrder\(/, /fallback:\s*true/]},
        go: {all: [/Fallback:\s*true/], order: [/\bpopularityOrder\(/, /Fallback:\s*true/]},
        scala: {all: [/fallback\s*=\s*true/], order: [/\bpopularityOrder\(/, /fallback\s*=\s*true/]},
        cpp: {all: [/\.fallback\s*=\s*true/], order: [/\bpopularity_order\(/, /\.fallback\s*=\s*true/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Three bounded attempts, and only UNAVAILABLE is retried',
      detail:
        'Attempts are bounded by `RANK_MAX_ATTEMPTS = 3` and only `UNAVAILABLE` earns another one; `INVALID_ARGUMENT` is recognized and re-raised at once, because a malformed candidate payload will never rank on a retry, and there is no blanket handler that swallows every failure and loops. The draft retries every error, malformed payloads included.',
      match: {
        python: {
          all: [
            /RANK_MAX_ATTEMPTS\s*=\s*3/,
            /range\(RANK_MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.INVALID_ARGUMENT/,
          ],
          none: [/except\s+Exception\s*:/, /while\s+True/],
        },
        typescript: {
          all: [/RANK_MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*RANK_MAX_ATTEMPTS/, /UNAVAILABLE/, /INVALID_ARGUMENT/],
          none: [/catch\s*\{\s*continue/, /while\s*\(\s*true\s*\)/],
        },
        go: {
          all: [
            /rankMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*rankMaxAttempts/,
            /codes\.Unavailable/,
            /codes\.InvalidArgument/,
          ],
          none: [/if err != nil\s*\{\s*continue/, /for\s*\{/],
        },
        scala: {
          all: [
            /RankMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*RankMaxAttempts/,
            /Status\.Code\.UNAVAILABLE/,
            /Status\.Code\.INVALID_ARGUMENT/,
          ],
          none: [/case _:\s*Throwable/, /while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kRankMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kRankMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::INVALID_ARGUMENT/,
          ],
          none: [/catch\s*\(\s*\.\.\.\s*\)/, /while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'tag-survives',
      title: 'The tag and the popularity model version leave the client on the result',
      detail:
        'The result `rank` returns carries both the fallback tag and the popularity model version, so the impression event built from it records which list the user actually saw. The draft returns a bare list and drops the tag inside the client, where no downstream reader can see it.',
      match: {
        python: {all: [/fallback\s*=\s*True/, /model_version\s*=\s*POPULARITY_MODEL_VERSION/]},
        typescript: {all: [/fallback:\s*true/, /model_version:\s*POPULARITY_MODEL_VERSION/]},
        go: {all: [/Fallback:\s*true/, /ModelVersion:\s*popularityModelVersion/]},
        scala: {all: [/fallback\s*=\s*true/, /model_version\s*=\s*PopularityModelVersion/]},
        cpp: {all: [/\.fallback\s*=\s*true/, /\.model_version\s*=\s*kPopularityModelVersion/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
from dataclasses import dataclass

import grpc

import ranker_pb2
import ranker_pb2_grpc
from popularity import popularity_order  # provided: the precomputed popularity order over these candidates

logger = logging.getLogger("recsvc.ranker")

RANK_MAX_ATTEMPTS = 3

channel = grpc.insecure_channel("ranker:9000")
stub = ranker_pb2_grpc.RankerStub(channel)


@dataclass
class Ranking:
    """What the caller gets: item ids in rank order, whether the list is degraded, and its version."""

    items: list[str]
    fallback: bool
    model_version: str


def rank(tenant: str, user: str, candidate_ids: list[str]) -> Ranking:
    # TODO: the call carries no 500 ms deadline; a DEADLINE_EXCEEDED returns an empty list instead of
    # the popularity order; the fallback is never tagged; and this loop retries INVALID_ARGUMENT
    # candidate payloads. Review all four.
    for _ in range(RANK_MAX_ATTEMPTS):
        try:
            request = ranker_pb2.RankRequest(tenant=tenant, user=user, candidate_ids=candidate_ids)
            reply = stub.Rank(request)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                return Ranking(items=[], fallback=False, model_version="")
            continue
        ranking = Ranking([item.id for item in reply.items], fallback=False, model_version=reply.model_version)
        logger.info("ranked tenant=%s user=%s items=%d fallback=%s", tenant, user, len(ranking.items), ranking.fallback)
        return ranking
    return Ranking(items=[], fallback=False, model_version="")
`,
      solution: `import logging
from dataclasses import dataclass

import grpc

import ranker_pb2
import ranker_pb2_grpc
from popularity import popularity_order  # provided: the precomputed popularity order over these candidates

logger = logging.getLogger("recsvc.ranker")

RANK_TIMEOUT_S = 0.5
RANK_MAX_ATTEMPTS = 3
POPULARITY_MODEL_VERSION = "popularity-order-v1"

channel = grpc.insecure_channel("ranker:9000")
stub = ranker_pb2_grpc.RankerStub(channel)


@dataclass
class Ranking:
    """What the caller gets: item ids in rank order, whether the list is degraded, and its version."""

    items: list[str]
    fallback: bool
    model_version: str


def rank(tenant: str, user: str, candidate_ids: list[str]) -> Ranking:
    for _ in range(RANK_MAX_ATTEMPTS):
        try:
            request = ranker_pb2.RankRequest(tenant=tenant, user=user, candidate_ids=candidate_ids)
            reply = stub.Rank(request, timeout=RANK_TIMEOUT_S)
        except grpc.RpcError as exc:
            code = exc.code()
            if code == grpc.StatusCode.INVALID_ARGUMENT:
                raise  # a malformed candidate payload will never rank on a retry
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                break  # the ranker just spent the deadline: do not spend a second 500 ms on it
            if code != grpc.StatusCode.UNAVAILABLE:
                raise
            continue  # only UNAVAILABLE earns another attempt, bounded by RANK_MAX_ATTEMPTS
        ranking = Ranking([item.id for item in reply.items], fallback=False, model_version=reply.model_version)
        logger.info("ranked tenant=%s user=%s items=%d fallback=%s", tenant, user, len(ranking.items), ranking.fallback)
        return ranking
    ranking = Ranking(items=popularity_order(candidate_ids), fallback=True, model_version=POPULARITY_MODEL_VERSION)
    logger.info("ranked tenant=%s user=%s items=%d fallback=%s", tenant, user, len(ranking.items), ranking.fallback)
    return ranking
`,
    },
    typescript: {
      starter: `/** rank: the ranking client recsvc calls; a model-generated draft with four wrong failure paths. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {popularityOrder} from 'popularity'; // provided: the precomputed popularity order over these candidates

const RANK_MAX_ATTEMPTS = 3;

/** What the caller gets: item ids in rank order, whether the list is degraded, and its version. */
export interface RankingResult {
  items: string[];
  fallback: boolean;
  model_version: string;
}

interface RankerClient {
  Rank(
    request: {tenant: string; user: string; candidate_ids: string[]},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {items: {id: string}[]; model_version: string}) => void,
  ): grpc.ClientUnaryCall;
}

const {ranker: rankerPackage} = grpc.loadPackageDefinition(protoLoader.loadSync('ranker.proto')) as unknown as {
  ranker: {Ranker: new (target: string, credentials: grpc.ChannelCredentials) => RankerClient};
};
const ranker = new rankerPackage.Ranker('ranker:9000', grpc.credentials.createInsecure());

export async function rank(tenant: string, user: string, candidateIds: string[]): Promise<RankingResult> {
  // TODO: the call carries no 500 ms deadline; a DEADLINE_EXCEEDED returns an empty list instead of
  // the popularity order; the fallback is never tagged; and this loop retries INVALID_ARGUMENT
  // candidate payloads. Review all four.
  for (let attempt = 0; attempt < RANK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await new Promise<{items: {id: string}[]; model_version: string}>((resolve, reject) => {
        ranker.Rank(
          {tenant, user, candidate_ids: candidateIds},
          {},
          (error, value) => (error === null ? resolve(value) : reject(error)),
        );
      });
      return {items: reply.items.map(item => item.id), fallback: false, model_version: reply.model_version};
    } catch (error) {
      if ((error as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
        return {items: [], fallback: false, model_version: ''};
      }
      continue;
    }
  }
  return {items: [], fallback: false, model_version: ''};
}
`,
      solution: `/** rank: a 500 ms deadline per attempt, three bounded attempts, and a tagged popularity fallback. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {popularityOrder} from 'popularity'; // provided: the precomputed popularity order over these candidates

const RANK_TIMEOUT_MS = 500;
const RANK_MAX_ATTEMPTS = 3;
const POPULARITY_MODEL_VERSION = 'popularity-order-v1';

/** What the caller gets: item ids in rank order, whether the list is degraded, and its version. */
export interface RankingResult {
  items: string[];
  fallback: boolean;
  model_version: string;
}

interface RankerClient {
  Rank(
    request: {tenant: string; user: string; candidate_ids: string[]},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {items: {id: string}[]; model_version: string}) => void,
  ): grpc.ClientUnaryCall;
}

const {ranker: rankerPackage} = grpc.loadPackageDefinition(protoLoader.loadSync('ranker.proto')) as unknown as {
  ranker: {Ranker: new (target: string, credentials: grpc.ChannelCredentials) => RankerClient};
};
const ranker = new rankerPackage.Ranker('ranker:9000', grpc.credentials.createInsecure());

export async function rank(tenant: string, user: string, candidateIds: string[]): Promise<RankingResult> {
  for (let attempt = 0; attempt < RANK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await new Promise<{items: {id: string}[]; model_version: string}>((resolve, reject) => {
        ranker.Rank(
          {tenant, user, candidate_ids: candidateIds},
          {deadline: Date.now() + RANK_TIMEOUT_MS},
          (error, value) => (error === null ? resolve(value) : reject(error)),
        );
      });
      const items = reply.items.map(item => item.id);
      return {items, fallback: false, model_version: reply.model_version};
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (code === grpc.status.INVALID_ARGUMENT) throw error; // a malformed candidate payload never ranks
      if (code === grpc.status.DEADLINE_EXCEEDED) break; // the ranker just spent the deadline: do not spend another
      if (code !== grpc.status.UNAVAILABLE) throw error; // only UNAVAILABLE earns another attempt
    }
  }
  return {items: popularityOrder(candidateIds), fallback: true, model_version: POPULARITY_MODEL_VERSION};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const rankMaxAttempts = 3

// Provided (popularity.go): popularityOrder returns the candidates in precomputed popularity order.
func popularityOrder(candidateIDs []string) []string { panic("not implemented") }

// RankingResult is what the caller gets: item ids in rank order, whether the list is degraded, and its version.
type RankingResult struct {
	Items        []string \`json:"items"\`
	Fallback     bool     \`json:"fallback"\`
	ModelVersion string   \`json:"model_version"\`
}

var ranker pb.RankerClient

func rank(tenant, user string, candidateIDs []string) (RankingResult, error) {
	// TODO: the call carries no 500 ms deadline; a DEADLINE_EXCEEDED returns an empty list instead of
	// the popularity order; the fallback is never tagged; and this loop retries INVALID_ARGUMENT
	// candidate payloads. Review all four.
	for attempt := 0; attempt < rankMaxAttempts; attempt++ {
		reply, err := ranker.Rank(context.Background(), &pb.RankRequest{
			Tenant:       tenant,
			User:         user,
			CandidateIds: candidateIDs,
		})
		if err == nil {
			items := make([]string, 0, len(reply.Items))
			for _, item := range reply.Items {
				items = append(items, item.Id)
			}
			return RankingResult{Items: items, Fallback: false, ModelVersion: reply.ModelVersion}, nil
		}
		if status.Code(err) == codes.DeadlineExceeded {
			return RankingResult{Items: []string{}, Fallback: false, ModelVersion: ""}, nil
		}
	}
	return RankingResult{Items: []string{}, Fallback: false, ModelVersion: ""}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	rankTimeoutMS          = 500
	rankMaxAttempts        = 3
	popularityModelVersion = "popularity-order-v1"
)

// Provided (popularity.go): popularityOrder returns the candidates in precomputed popularity order.
func popularityOrder(candidateIDs []string) []string { panic("not implemented") }

// RankingResult is what the caller gets: item ids in rank order, whether the list is degraded, and its version.
type RankingResult struct {
	Items        []string \`json:"items"\`
	Fallback     bool     \`json:"fallback"\`
	ModelVersion string   \`json:"model_version"\`
}

var ranker pb.RankerClient

func rank(tenant, user string, candidateIDs []string) (RankingResult, error) {
	for attempt := 0; attempt < rankMaxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), rankTimeoutMS*time.Millisecond)
		reply, err := ranker.Rank(ctx, &pb.RankRequest{
			Tenant:       tenant,
			User:         user,
			CandidateIds: candidateIDs,
		})
		cancel()
		if err == nil {
			items := make([]string, 0, len(reply.Items))
			for _, item := range reply.Items {
				items = append(items, item.Id)
			}
			log.Printf("ranked tenant=%s user=%s items=%d fallback=false", tenant, user, len(items))
			return RankingResult{Items: items, Fallback: false, ModelVersion: reply.ModelVersion}, nil
		}
		code := status.Code(err)
		if code == codes.InvalidArgument {
			return RankingResult{}, err // a malformed candidate payload will never rank on a retry
		}
		if code == codes.DeadlineExceeded {
			break // the ranker just spent the deadline: do not spend a second 500 ms on it
		}
		if code != codes.Unavailable {
			return RankingResult{}, err
		}
	}
	items := popularityOrder(candidateIDs)
	log.Printf("ranked tenant=%s user=%s items=%d fallback=true", tenant, user, len(items))
	return RankingResult{Items: items, Fallback: true, ModelVersion: popularityModelVersion}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class RankingResult(items: Seq[String], fallback: Boolean, model_version: String)

object RankingClient {
  val RankMaxAttempts = 3

  val ranker = RankerGrpc.blockingStub(ManagedChannelBuilder.forAddress("ranker", 9000).usePlaintext().build())

  /** Provided (Popularity): the candidates in the precomputed popularity order. */
  def popularityOrder(candidateIds: Seq[String]): Seq[String] = ???

  def rank(tenant: String, user: String, candidateIds: Seq[String]): RankingResult = {
    // TODO: the call carries no 500 ms deadline; a DEADLINE_EXCEEDED returns an empty list instead of
    // the popularity order; the fallback is never tagged; and this loop retries INVALID_ARGUMENT
    // candidate payloads. Review all four.
    var attempt = 0
    while (attempt < RankMaxAttempts) {
      try {
        val reply = ranker.rank(RankRequest(tenant = tenant, user = user, candidate_ids = candidateIds))
        return RankingResult(items = reply.items.map(_.id), fallback = false, model_version = reply.model_version)
      } catch {
        case e: StatusRuntimeException =>
          if (e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED) {
            return RankingResult(items = Seq.empty, fallback = false, model_version = "")
          }
      }
      attempt += 1
    }
    RankingResult(items = Seq.empty, fallback = false, model_version = "")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class RankingResult(items: Seq[String], fallback: Boolean, model_version: String)

object RankingClient {
  val RankTimeoutMs = 500L
  val RankMaxAttempts = 3
  val PopularityModelVersion = "popularity-order-v1"

  val ranker = RankerGrpc.blockingStub(ManagedChannelBuilder.forAddress("ranker", 9000).usePlaintext().build())

  /** Provided (Popularity): the candidates in the precomputed popularity order. */
  def popularityOrder(candidateIds: Seq[String]): Seq[String] = ???

  def rank(tenant: String, user: String, candidateIds: Seq[String]): RankingResult = {
    var attempt = 0
    var degrade = false
    while (attempt < RankMaxAttempts && !degrade) {
      try {
        val reply = ranker
          .withDeadlineAfter(RankTimeoutMs, TimeUnit.MILLISECONDS)
          .rank(RankRequest(tenant = tenant, user = user, candidate_ids = candidateIds))
        return RankingResult(items = reply.items.map(_.id), fallback = false, model_version = reply.model_version)
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (code == Status.Code.INVALID_ARGUMENT) throw e // a malformed candidate payload never ranks
          else if (code == Status.Code.DEADLINE_EXCEEDED) degrade = true // do not spend a second 500 ms
          else if (code != Status.Code.UNAVAILABLE) throw e // only UNAVAILABLE earns another attempt
      }
      attempt += 1
    }
    RankingResult(items = popularityOrder(candidateIds), fallback = true, model_version = PopularityModelVersion)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>
#include <vector>

#include "popularity.h"  // std::vector<std::string> popularity_order(const std::vector<std::string>& candidate_ids);
#include "ranker.grpc.pb.h"

constexpr int kRankMaxAttempts = 3;

std::unique_ptr<Ranker::Stub> ranker;

// What the caller gets: item ids in rank order, whether the list is degraded, and its version.
struct RankingResult {
  std::vector<std::string> items;
  bool fallback = false;
  std::string model_version;
};

RankingResult rank(const std::string& tenant, const std::string& user, const std::vector<std::string>& candidate_ids) {
  // TODO: the call carries no 500 ms deadline; a DEADLINE_EXCEEDED returns an empty result instead of
  // the popularity order; the fallback is never tagged; and this loop retries INVALID_ARGUMENT
  // candidate payloads. Review all four.
  for (int attempt = 0; attempt < kRankMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    RankRequest request;
    request.set_tenant(tenant);
    request.set_user(user);
    for (const auto& candidate_id : candidate_ids) request.add_candidate_ids(candidate_id);
    RankReply reply;
    const grpc::Status status = ranker->Rank(&ctx, request, &reply);
    if (status.ok()) {
      RankingResult result;
      for (const auto& item : reply.items()) result.items.push_back(item.id());
      result.model_version = reply.model_version();
      return result;
    }
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) return RankingResult{};
  }
  return RankingResult{};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "popularity.h"  // std::vector<std::string> popularity_order(const std::vector<std::string>& candidate_ids);
#include "ranker.grpc.pb.h"

constexpr int kRankTimeoutMs = 500;
constexpr int kRankMaxAttempts = 3;
constexpr char kPopularityModelVersion[] = "popularity-order-v1";

std::unique_ptr<Ranker::Stub> ranker;

// What the caller gets: item ids in rank order, whether the list is degraded, and its version.
struct RankingResult {
  std::vector<std::string> items;
  bool fallback = false;
  std::string model_version;
};

RankingResult rank(const std::string& tenant, const std::string& user, const std::vector<std::string>& candidate_ids) {
  for (int attempt = 0; attempt < kRankMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kRankTimeoutMs));
    RankRequest request;
    request.set_tenant(tenant);
    request.set_user(user);
    for (const auto& candidate_id : candidate_ids) request.add_candidate_ids(candidate_id);
    RankReply reply;
    const grpc::Status status = ranker->Rank(&ctx, request, &reply);
    if (status.ok()) {
      RankingResult result;
      for (const auto& item : reply.items()) result.items.push_back(item.id());
      result.model_version = reply.model_version();
      std::cerr << "ranked tenant=" << tenant << " user=" << user << " items=" << result.items.size()
                << " fallback=false\\n";
      return result;
    }
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) {
      throw std::invalid_argument("malformed candidate payload: " + status.error_message());
    }
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) break;  // do not spend a second 500 ms
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) {
      throw std::runtime_error("ranker: " + status.error_message());
    }
  }
  RankingResult degraded;
  degraded.items = popularity_order(candidate_ids);
  degraded.fallback = true;  // the list is the popularity order: metrics and A/B analysis must see it
  degraded.model_version = kPopularityModelVersion;
  std::cerr << "ranked tenant=" << tenant << " user=" << user << " items=" << degraded.items.size()
            << " fallback=true\\n";
  return degraded;
}
`,
    },
  },
  hints: [
    'The deadline belongs on the call itself — `timeout=`, `deadline: Date.now() + RANK_TIMEOUT_MS`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline` — not on a timer around it. Bound the attempts with a named constant and a counted loop: the draft’s retry loop has no exit for a payload that will never rank.',
    'Retryability is a property of the status, not of “it threw”: capture the error, look at its code, and grant another attempt only to `UNAVAILABLE`, only while the attempt budget lasts. `DEADLINE_EXCEEDED` sends you straight to the fallback — the ranker has already told you it is slow — and `INVALID_ARGUMENT` is re-raised on the spot, because a malformed candidate list cannot become valid between attempts.',
    'The fallback is the popularity order over the *same* candidate ids, and it is only honest when it is marked: the result you return carries `fallback = true` beside `model_version = POPULARITY_MODEL_VERSION` (names in the language at hand), so the metrics, the A/B analysis and the impression event can all tell a degraded list from a ranked one.',
  ],
  debrief: `The interview question is failure policy on a dependency you do not control: what does the user see when the ranker is slow or gone? The draft answers “nothing” — an empty list — and hides the outage inside a response that looks successful. Four contracts make the answer correct. A deadline per attempt bounds one call; a bounded attempt count over a status whitelist bounds the whole call; a popularity fallback guarantees the surface still recommends, because a worse-but-real list beats no list; and the fallback tag plus the popularity model version keep the degradation honest all the way into the impression stream, so offline evaluation can exclude or re-weight it instead of crediting popularity with a win. The subtle waste is \`INVALID_ARGUMENT\`: a malformed candidate payload cannot become valid between attempts, so every retry is load spent on the ranker’s most contended path, and a blanket handler that retries anything is how a bad payload turns into a hot loop. Real clients propagate the caller’s deadline instead of inventing one, add jittered backoff between \`UNAVAILABLE\` attempts, cap the fallback share per surface (a surface degrading on most requests should page, not serve popularity forever), and record why they degraded, so “slow” and “gone” stay distinguishable after the fact.`,
};
