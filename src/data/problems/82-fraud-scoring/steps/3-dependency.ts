import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls with a rules fallback instead of a zero',
  concept: 'grpc',
  file: 'client',
  focus: ['scorer', 'model', 'rules'],
  task: `## Task

**Starting point.** The starter is \`score_transaction(features)\`, the scorer's model client: it
sends \`Model.Score\` to \`MODEL_TARGET\` up to \`MAX_ATTEMPTS\` (3) times with no deadline,
\`continue\`s on any \`grpc.RpcError\`, answers \`{score, band, fallback: False, model_version}\` from
the first reply, and after the loop answers \`{"score": 0.0, "band": "approve", …}\`. With the model
healthy it scores; it hides four flaws.

**Failure mode the checks target.** A model outage is scored as a fleet of perfectly safe
transactions; a stuck model holds a payment open until the client gives up; and a vector the model
refuses every time costs three round trips and still ends approved.

\`\`\`proto
service Model { rpc Score(ScoreRequest) returns (ScoreReply); }  // INVALID_ARGUMENT: refused vector
\`\`\`

- Every attempt carries a **300 ms** deadline (\`DEADLINE_S\`).
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` (\`RETRYABLE\`) are retried; \`INVALID_ARGUMENT\` raises
  \`InvalidFeatures\` at once.
- When the attempts run out, answer the rules verdict: \`rules_score(features)\` from
  \`fraud.features\`, \`fallback: True\`, \`model_version: RULES_VERSION\`.
- A fallback score is raised to at least \`RULES_MIN_SCORE\` (0.45): a degraded decision lands in
  review or decline, never in approve.`,
  sequence: {
    participants: ['scorer', 'Fraud model', 'Rules engine'],
    messages: [
      {from: 'scorer', to: 'Fraud model', label: 'Score(vector) · deadline 300 ms · attempt ≤ 3', kind: 'sync'},
      {from: 'Fraud model', to: 'scorer', label: 'INVALID_ARGUMENT → InvalidFeatures, no retry', kind: 'reply'},
      {from: 'scorer', to: 'Fraud model', label: 'retry only UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'sync'},
      {from: 'Fraud model', to: 'scorer', label: 'UNAVAILABLE on the last attempt', kind: 'reply'},
      {from: 'scorer', to: 'Rules engine', label: 'rules_score(vector)', kind: 'sync'},
      {from: 'Rules engine', to: 'scorer', label: 'max(score, 0.45) · fallback · rules-7', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 300 ms deadline',
      detail:
        'Each `Score` call is made with `DEADLINE_S` (300 ms), so a stalled model costs at most three short attempts before the rules answer; the starter passes no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0?\.3\b/, /Score\([^)\n]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*300\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*300\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineMs\s*=\s*300L?\b/, /withDeadlineAfter\(\s*DeadlineMs/]},
        cpp: {all: [/kDeadline\{300\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries UNAVAILABLE, stops at INVALID_ARGUMENT',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; `INVALID_ARGUMENT` raises `InvalidFeatures` after one call, because every attempt would be refused the same way. The starter retries whatever fails.',
      match: {
        python: {all: [/RETRYABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /INVALID_ARGUMENT/, /raise InvalidFeatures/]},
        typescript: {
          all: [/RETRYABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /INVALID_ARGUMENT/, /throw new InvalidFeatures/],
        },
        go: {
          all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /codes\.InvalidArgument/, /errInvalidFeatures\)?[,:]/],
        },
        scala: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /INVALID_ARGUMENT/, /throw new InvalidFeatures/]},
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /INVALID_ARGUMENT/, /throw InvalidFeatures/]},
      },
    },
    {
      id: 'rules-fallback',
      title: 'An outage answers the rules verdict, marked as a fallback',
      detail:
        "When the attempts run out the verdict is the rules engine's (`rules_score`), with `fallback` true and `model_version` `RULES_VERSION`; the starter answers score 0 in the approve band.",
      match: {
        python: {all: [/rules_score\(/, /["']fallback["']:\s*True/], none: [/["']score["']:\s*0(\.0)?\s*[,}]/]},
        typescript: {all: [/rulesScore\(/, /fallback:\s*true/], none: [/score:\s*0(\.0)?\s*[,}]/]},
        go: {all: [/features\.RulesScore\(/, /Fallback:\s*true/], none: [/Score:\s*0(\.0)?\s*[,}]/]},
        scala: {all: [/Features\.rulesScore\(/, /fallback\s*=\s*true/], none: [/Verdict\(0(\.0)?\s*,/]},
        cpp: {all: [/features::rulesScore\(/, /features::kRulesVersion/], none: [/Verdict\{0(\.0)?\s*,/]},
      },
    },
    {
      id: 'rules-band',
      title: 'A fallback never lands in the approve band',
      detail:
        'The rules score is raised to at least `RULES_MIN_SCORE` (0.45), so a clean account scored during an outage goes to review instead of being approved on rules alone.',
      match: {
        python: {all: [/RULES_MIN_SCORE/, /max\(\s*rules_score\(/]},
        typescript: {all: [/RULES_MIN_SCORE/, /Math\.max\(\s*rulesScore\(/]},
        go: {all: [/rulesMinScore/, /<\s*rulesMinScore|math\.Max\(/]},
        scala: {all: [/RulesMinScore/, /math\.max\(\s*Features\.rulesScore\(/]},
        cpp: {all: [/kRulesMinScore/, /std::max\(\s*features::rulesScore\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import fraud_scoring_pb2
import fraud_scoring_pb2_grpc
from fraud.features import RULES_VERSION, band_for, rules_score

MODEL_TARGET = "fraud-model:9000"
MAX_ATTEMPTS = 3

stub = fraud_scoring_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL_TARGET))


class InvalidFeatures(Exception):
    """The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way."""


def score_transaction(features: dict) -> dict:
    """The verdict {score, band, fallback, model_version} for a feature vector."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    request = fraud_scoring_pb2.ScoreRequest(**features)
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = stub.Score(request)
        except grpc.RpcError:
            continue
        return {"score": reply.score, "band": band_for(reply.score), "fallback": False, "model_version": reply.model_version}
    return {"score": 0.0, "band": "approve", "fallback": False, "model_version": "none"}
`,
      solution: `import grpc

import fraud_scoring_pb2
import fraud_scoring_pb2_grpc
from fraud.features import RULES_VERSION, band_for, rules_score

MODEL_TARGET = "fraud-model:9000"
DEADLINE_S = 0.3
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
RULES_MIN_SCORE = 0.45

stub = fraud_scoring_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL_TARGET))


class InvalidFeatures(Exception):
    """The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way."""


def score_transaction(features: dict) -> dict:
    """The verdict {score, band, fallback, model_version} for a feature vector."""
    request = fraud_scoring_pb2.ScoreRequest(**features)
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = stub.Score(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                raise InvalidFeatures(exc.details()) from exc  # a property of the vector: no attempt will differ
            if exc.code() in RETRYABLE:
                continue
            break
        return {"score": reply.score, "band": band_for(reply.score), "fallback": False, "model_version": reply.model_version}
    # The model could not answer: the rules decide, and they never approve on their own.
    score = max(rules_score(features), RULES_MIN_SCORE)
    return {"score": score, "band": band_for(score), "fallback": True, "model_version": RULES_VERSION}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Features, RULES_VERSION, bandFor, rulesScore} from 'fraud/features';

export const MODEL_TARGET = 'fraud-model:9000';
export const MAX_ATTEMPTS = 3;

export interface Verdict {
  score: number;
  band: string;
  fallback: boolean;
  model_version: string;
}

interface ModelClient {
  Score(request: Features, options: {deadline?: number}): Promise<{score: number; model_version: string}>;
}

const {fraudscore} = grpc.loadPackageDefinition(protoLoader.loadSync('fraud_scoring.proto')) as unknown as {
  fraudscore: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new fraudscore.Model(MODEL_TARGET, grpc.credentials.createInsecure());

/** The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way. */
export class InvalidFeatures extends Error {}

/** The verdict for a feature vector. */
export async function scoreTransaction(features: Features): Promise<Verdict> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await stub.Score(features, {});
      return {score: reply.score, band: bandFor(reply.score), fallback: false, model_version: reply.model_version};
    } catch {
      continue;
    }
  }
  return {score: 0.0, band: 'approve', fallback: false, model_version: 'none'};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Features, RULES_VERSION, bandFor, rulesScore} from 'fraud/features';

export const MODEL_TARGET = 'fraud-model:9000';
export const DEADLINE_MS = 300;
export const MAX_ATTEMPTS = 3;
export const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];
export const RULES_MIN_SCORE = 0.45;

export interface Verdict {
  score: number;
  band: string;
  fallback: boolean;
  model_version: string;
}

interface ModelClient {
  Score(request: Features, options: {deadline?: number}): Promise<{score: number; model_version: string}>;
}

const {fraudscore} = grpc.loadPackageDefinition(protoLoader.loadSync('fraud_scoring.proto')) as unknown as {
  fraudscore: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new fraudscore.Model(MODEL_TARGET, grpc.credentials.createInsecure());

/** The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way. */
export class InvalidFeatures extends Error {}

/** The verdict for a feature vector. */
export async function scoreTransaction(features: Features): Promise<Verdict> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await stub.Score(features, {deadline: Date.now() + DEADLINE_MS});
      return {score: reply.score, band: bandFor(reply.score), fallback: false, model_version: reply.model_version};
    } catch (err) {
      const {code, details} = err as grpc.ServiceError;
      // A property of the vector: no attempt will differ.
      if (code === grpc.status.INVALID_ARGUMENT) throw new InvalidFeatures(details);
      if (RETRYABLE.includes(code)) continue;
      break;
    }
  }
  // The model could not answer: the rules decide, and they never approve on their own.
  const score = Math.max(rulesScore(features), RULES_MIN_SCORE);
  return {score, band: bandFor(score), fallback: true, model_version: RULES_VERSION};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"fraud/features" // features.Features, BandFor, RulesScore, RulesVersion
	pb "fraud/gen/fraud_scoring"
)

const (
	modelTarget = "fraud-model:9000"
	maxAttempts = 3
)

var conn, _ = grpc.NewClient(modelTarget, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// errInvalidFeatures: the model refused the vector, and every attempt would be refused the same way.
var errInvalidFeatures = errors.New("invalid features")

type verdict struct {
	Score        float64 \`json:"score"\`
	Band         string  \`json:"band"\`
	Fallback     bool    \`json:"fallback"\`
	ModelVersion string  \`json:"model_version"\`
}

// scoreTransaction is the verdict for a feature vector.
func scoreTransaction(ctx context.Context, f features.Features) (verdict, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	request := &pb.ScoreRequest{FeatureVersion: f.FeatureVersion, AccountAgeDays: f.AccountAgeDays, PriorChargebacks: f.PriorChargebacks, AmountCents: f.AmountCents}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		reply, err := stub.Score(ctx, request)
		if err != nil {
			continue
		}
		return verdict{Score: reply.GetScore(), Band: features.BandFor(reply.GetScore()), Fallback: false, ModelVersion: reply.GetModelVersion()}, nil
	}
	return verdict{Score: 0, Band: "approve", Fallback: false, ModelVersion: "none"}, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"fraud/features" // features.Features, BandFor, RulesScore, RulesVersion
	pb "fraud/gen/fraud_scoring"
)

const (
	modelTarget   = "fraud-model:9000"
	deadline      = 300 * time.Millisecond
	maxAttempts   = 3
	rulesMinScore = 0.45
)

var conn, _ = grpc.NewClient(modelTarget, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// errInvalidFeatures: the model refused the vector, and every attempt would be refused the same way.
var errInvalidFeatures = errors.New("invalid features")

type verdict struct {
	Score        float64 \`json:"score"\`
	Band         string  \`json:"band"\`
	Fallback     bool    \`json:"fallback"\`
	ModelVersion string  \`json:"model_version"\`
}

// scoreTransaction is the verdict for a feature vector.
func scoreTransaction(ctx context.Context, f features.Features) (verdict, error) {
	request := &pb.ScoreRequest{FeatureVersion: f.FeatureVersion, AccountAgeDays: f.AccountAgeDays, PriorChargebacks: f.PriorChargebacks, AmountCents: f.AmountCents}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Score(callCtx, request)
		cancel()
		if err == nil {
			return verdict{Score: reply.GetScore(), Band: features.BandFor(reply.GetScore()), Fallback: false, ModelVersion: reply.GetModelVersion()}, nil
		}
		code := status.Code(err)
		if code == codes.InvalidArgument {
			// A property of the vector: no attempt will differ.
			return verdict{}, fmt.Errorf("%w: %s", errInvalidFeatures, status.Convert(err).Message())
		}
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			break
		}
	}
	// The model could not answer: the rules decide, and they never approve on their own.
	score := features.RulesScore(f)
	if score < rulesMinScore {
		score = rulesMinScore
	}
	return verdict{Score: score, Band: features.BandFor(score), Fallback: true, ModelVersion: features.RulesVersion}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import fraud.{FeatureVector, Features, InvalidFeatures, Verdict} // Features.bandFor, rulesScore, RulesVersion
import fraudscore.fraud_scoring.{ModelGrpc, ScoreRequest}

object Client {
  val ModelTarget = "fraud-model:9000"
  val MaxAttempts = 3

  private val stub = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(ModelTarget).usePlaintext().build())

  /** The verdict for a feature vector; throws InvalidFeatures when the model refuses it. */
  def scoreTransaction(vector: FeatureVector): Verdict = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val request = ScoreRequest(vector.featureVersion, vector.accountAgeDays, vector.priorChargebacks, vector.amountCents)
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val reply = stub.score(request)
        return Verdict(reply.score, Features.bandFor(reply.score), fallback = false, reply.modelVersion)
      } catch {
        case _: StatusRuntimeException => attempt += 1
      }
    }
    Verdict(0.0, "approve", fallback = false, "none")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import fraud.{FeatureVector, Features, InvalidFeatures, Verdict} // Features.bandFor, rulesScore, RulesVersion
import fraudscore.fraud_scoring.{ModelGrpc, ScoreRequest}

object Client {
  val ModelTarget = "fraud-model:9000"
  val DeadlineMs = 300L
  val MaxAttempts = 3
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val RulesMinScore = 0.45

  private val stub = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(ModelTarget).usePlaintext().build())

  /** The verdict for a feature vector; throws InvalidFeatures when the model refuses it. */
  def scoreTransaction(vector: FeatureVector): Verdict = {
    val request = ScoreRequest(vector.featureVersion, vector.accountAgeDays, vector.priorChargebacks, vector.amountCents)
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).score(request)
        return Verdict(reply.score, Features.bandFor(reply.score), fallback = false, reply.modelVersion)
      } catch {
        // A property of the vector: no attempt will differ.
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
          throw new InvalidFeatures(Option(e.getStatus.getDescription).getOrElse("invalid features"))
        case e: StatusRuntimeException if Retryable(e.getStatus.getCode) => attempt += 1
        case _: StatusRuntimeException => attempt = MaxAttempts + 1
      }
    }
    // The model could not answer: the rules decide, and they never approve on their own.
    val score = math.max(Features.rulesScore(vector), RulesMinScore)
    Verdict(score, Features.bandFor(score), fallback = true, Features.RulesVersion)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "fraud/features.h"  // features::Features, bandFor, rulesScore, kRulesVersion
#include "fraud_scoring.grpc.pb.h"

const std::string kModelTarget = "fraud-model:9000";
constexpr int kMaxAttempts = 3;

struct Verdict {
  double score = 0;
  std::string band;
  bool fallback = false;
  std::string model_version;
};

// The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way.
struct InvalidFeatures : std::runtime_error {
  using std::runtime_error::runtime_error;
};

auto stub = fraudscore::Model::NewStub(grpc::CreateChannel(kModelTarget, grpc::InsecureChannelCredentials()));

// The verdict for a feature vector.
Verdict scoreTransaction(const features::Features& fx) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  fraudscore::ScoreRequest request;
  request.set_feature_version(fx.feature_version);
  request.set_account_age_days(fx.account_age_days);
  request.set_prior_chargebacks(fx.prior_chargebacks);
  request.set_amount_cents(fx.amount_cents);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    fraudscore::ScoreReply reply;
    if (!stub->Score(&ctx, request, &reply).ok()) continue;
    return Verdict{reply.score(), features::bandFor(reply.score()), false, reply.model_version()};
  }
  return Verdict{0.0, "approve", false, "none"};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <string>

#include "fraud/features.h"  // features::Features, bandFor, rulesScore, kRulesVersion
#include "fraud_scoring.grpc.pb.h"

const std::string kModelTarget = "fraud-model:9000";
constexpr std::chrono::milliseconds kDeadline{300};
constexpr int kMaxAttempts = 3;
constexpr double kRulesMinScore = 0.45;

struct Verdict {
  double score = 0;
  std::string band;
  bool fallback = false;
  std::string model_version;
};

// The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way.
struct InvalidFeatures : std::runtime_error {
  using std::runtime_error::runtime_error;
};

auto stub = fraudscore::Model::NewStub(grpc::CreateChannel(kModelTarget, grpc::InsecureChannelCredentials()));

// The verdict for a feature vector.
Verdict scoreTransaction(const features::Features& fx) {
  fraudscore::ScoreRequest request;
  request.set_feature_version(fx.feature_version);
  request.set_account_age_days(fx.account_age_days);
  request.set_prior_chargebacks(fx.prior_chargebacks);
  request.set_amount_cents(fx.amount_cents);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    fraudscore::ScoreReply reply;
    const grpc::Status status = stub->Score(&ctx, request, &reply);
    if (status.ok()) return Verdict{reply.score(), features::bandFor(reply.score()), false, reply.model_version()};
    const auto code = status.error_code();
    // A property of the vector: no attempt will differ.
    if (code == grpc::StatusCode::INVALID_ARGUMENT) throw InvalidFeatures(status.error_message());
    if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED) break;
  }
  // The model could not answer: the rules decide, and they never approve on their own.
  const double score = std::max(features::rulesScore(fx), kRulesMinScore);
  return Verdict{score, features::bandFor(score), true, features::kRulesVersion};
}
`,
    },
  },
  harness: {
    python: `import grpc

import fraud_scoring_pb2_grpc
from fraud.features import RULES_VERSION, rules_score
from fraud.risk_model import MODEL_VERSION, ModelPeer

ESTABLISHED = {"feature_version": "fx-3", "account_age_days": 400, "prior_chargebacks": 0, "amount_cents": 4200}
RISKY = {**ESTABLISHED, "account_age_days": 12, "prior_chargebacks": 2}


def _client(ctx):
    ctx.grpc.serve(fraud_scoring_pb2_grpc.add_ModelServicer_to_server, ModelPeer())
    return ctx.load("client")


def check_deadline(ctx):
    m = _client(ctx)
    verdict = m.score_transaction(ESTABLISHED)
    assert verdict.get("fallback") is False and verdict.get("model_version") == MODEL_VERSION, f"with the model healthy the verdict must be the model's, got {verdict}"
    for call in ctx.grpc.calls_to("Score"):
        assert call.timeout is not None, "a Score call carries no deadline: a stalled model holds the payment open"
        assert 0.25 <= call.timeout <= 0.35, f"a Score call carries a {call.timeout} s deadline, expected DEADLINE_S = 0.3"
    ctx.grpc.set_latency("Score", 5.0)
    started = ctx.clock.time()
    verdict = m.score_transaction(ESTABLISHED)
    waited = ctx.clock.time() - started
    assert waited <= 1.0, f"with the model stalled for 5 s one score took {waited:.2f} s: three attempts of 300 ms must end within 1 s"
    assert verdict.get("fallback") is True, f"a model that never answers in time must end in the rules verdict, got {verdict}"


def check_retry_policy(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, times=2)
    verdict = m.score_transaction(ESTABLISHED)
    calls = len(ctx.grpc.calls_to("Score"))
    assert calls == 3 and verdict.get("fallback") is False, f"two UNAVAILABLE answers then a healthy model must give the model's verdict on the third attempt, got {verdict} after {calls} calls"
    refused = {**ESTABLISHED, "feature_version": "fx-2"}
    try:
        got = m.score_transaction(refused)
    except m.InvalidFeatures:
        got = None
    assert got is None, f"the model refuses a vector at fx-2 with INVALID_ARGUMENT, and score_transaction answered {got}: raise InvalidFeatures"
    calls = len(ctx.grpc.calls_to("Score")) - 3
    assert calls == 1, f"a refused vector was sent {calls} times: INVALID_ARGUMENT is terminal, every attempt is refused the same way"


def check_rules_fallback(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, times=3)
    verdict = m.score_transaction(RISKY)
    expected = {"score": rules_score(RISKY), "band": "decline", "fallback": True, "model_version": RULES_VERSION}
    assert verdict == expected, f"with the model unavailable on all three attempts the verdict was {verdict}: answer the rules engine's verdict {expected}, not a zero"
    assert len(ctx.grpc.calls_to("Score")) == 3, f"an outage must cost exactly MAX_ATTEMPTS (3) calls, it cost {len(ctx.grpc.calls_to('Score'))}"


def check_rules_band(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, times=3)
    verdict = m.score_transaction(ESTABLISHED)
    assert verdict.get("fallback") is True and verdict.get("band") != "approve", f"during an outage the rules approved a transaction ({verdict}): a fallback decision must never approve"
    assert abs(verdict["score"] - 0.45) < 1e-9 and verdict["band"] == "review", f"a clean account during an outage must score RULES_MIN_SCORE (0.45) in review, got {verdict}"
`,
    typescript: `const ESTABLISHED = {feature_version: 'fx-3', account_age_days: 400, prior_chargebacks: 0, amount_cents: 4200};
const RISKY = {...ESTABLISHED, account_age_days: 12, prior_chargebacks: 2};

function client(ctx) {
  const {modelPeer, MODEL_VERSION} = ctx.load('/support/fraud/risk_model.ts');
  ctx.grpc.serve(ctx.proto('fraud_scoring.proto').fraudscore.Model.service, modelPeer);
  const features = ctx.load('/support/fraud/features.ts');
  return {m: ctx.load('client'), features, MODEL_VERSION};
}

export async function check_deadline(ctx) {
  const {m, MODEL_VERSION} = client(ctx);
  let verdict = await m.scoreTransaction(ESTABLISHED);
  assert(verdict.fallback === false && verdict.model_version === MODEL_VERSION, \`with the model healthy the verdict must be the model's, got \${JSON.stringify(verdict)}\`);
  for (const call of ctx.grpc.callsTo('Score')) {
    assert(call.timeout !== null, 'a Score call carries no deadline: a stalled model holds the payment open');
    assert(0.25 <= call.timeout && call.timeout <= 0.35, \`a Score call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 300\`);
  }
  ctx.grpc.setLatency('Score', 5.0);
  const started = ctx.clock.now();
  verdict = await m.scoreTransaction(ESTABLISHED);
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 1.0, \`with the model stalled for 5 s one score took \${waited} s: three attempts of 300 ms must end within 1 s\`);
  assert.equal(verdict.fallback, true, \`a model that never answers in time must end in the rules verdict, got \${JSON.stringify(verdict)}\`);
}

export async function check_retry_policy(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, '', 2);
  const verdict = await m.scoreTransaction(ESTABLISHED);
  let calls = ctx.grpc.callsTo('Score').length;
  assert(calls === 3 && verdict.fallback === false, \`two UNAVAILABLE answers then a healthy model must give the model's verdict on the third attempt, got \${JSON.stringify(verdict)} after \${calls} calls\`);
  let got: unknown = null;
  try {
    got = await m.scoreTransaction({...ESTABLISHED, feature_version: 'fx-2'});
  } catch (e) {
    assert(e instanceof m.InvalidFeatures, \`a refused vector must throw InvalidFeatures, it threw \${(e as Error).constructor.name}\`);
  }
  assert.equal(got, null, \`the model refuses a vector at fx-2 with INVALID_ARGUMENT, and scoreTransaction answered \${JSON.stringify(got)}: throw InvalidFeatures\`);
  calls = ctx.grpc.callsTo('Score').length - 3;
  assert.equal(calls, 1, \`a refused vector was sent \${calls} times: INVALID_ARGUMENT is terminal, every attempt is refused the same way\`);
}

export async function check_rules_fallback(ctx) {
  const {m, features} = client(ctx);
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, '', 3);
  const verdict = await m.scoreTransaction(RISKY);
  const expected = {score: features.rulesScore(RISKY), band: 'decline', fallback: true, model_version: features.RULES_VERSION};
  assert.deepStrictEqual(verdict, expected, \`with the model unavailable on all three attempts the verdict was \${JSON.stringify(verdict)}: answer the rules engine's verdict \${JSON.stringify(expected)}, not a zero\`);
  assert.equal(ctx.grpc.callsTo('Score').length, 3, 'an outage must cost exactly MAX_ATTEMPTS (3) calls');
}

export async function check_rules_band(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, '', 3);
  const verdict = await m.scoreTransaction(ESTABLISHED);
  assert(verdict.fallback === true && verdict.band !== 'approve', \`during an outage the rules approved a transaction (\${JSON.stringify(verdict)}): a fallback decision must never approve\`);
  assert(Math.abs(verdict.score - 0.45) < 1e-9 && verdict.band === 'review', \`a clean account during an outage must score RULES_MIN_SCORE (0.45) in review, got \${JSON.stringify(verdict)}\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"math"
	"time"

	"google.golang.org/grpc/codes"

	"fraud/features"
	"fraud/riskmodel"

	"leetbuild/harness"

	pbmodel "fraud/gen/fraud_scoring"
)

var (
	clientBg    = context.Background()
	established = features.Features{AccountAgeDays: 400, AmountCents: 4200, FeatureVersion: features.FeatureVersion, PriorChargebacks: 0}
	risky       = features.Features{AccountAgeDays: 12, AmountCents: 4200, FeatureVersion: features.FeatureVersion, PriorChargebacks: 2}
)

func serveModel(ctx *harness.Ctx) {
	pbmodel.RegisterModelServer(ctx.GRPC.Server(""), riskmodel.Peer{})
}

func mustScore(ctx *harness.Ctx, f features.Features, why string) verdict {
	v, err := scoreTransaction(clientBg, f)
	ctx.NoError(err, "%s: scoreTransaction failed", why)
	return v
}

func CheckDeadline(ctx *harness.Ctx) {
	serveModel(ctx)
	v := mustScore(ctx, established, "with the model healthy")
	ctx.Assert(!v.Fallback && v.ModelVersion == riskmodel.ModelVersion, "with the model healthy the verdict must be the model's, got %+v", v)
	for _, call := range ctx.GRPC.CallsTo("Score", "") {
		ctx.Assert(call.HasDeadline(), "a Score call carries no deadline: a stalled model holds the payment open")
		ctx.Assert(250*time.Millisecond <= call.Timeout && call.Timeout <= 350*time.Millisecond, "a Score call carries a %v deadline, expected 300 ms", call.Timeout)
	}
	ctx.GRPC.SetLatency("Score", 5.0, "")
	started := ctx.Clock.Now()
	v = mustScore(ctx, established, "with the model stalled")
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 1.0, "with the model stalled for 5 s one score took %v s: three attempts of 300 ms must end within 1 s", waited)
	ctx.Assert(v.Fallback, "a model that never answers in time must end in the rules verdict, got %+v", v)
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	serveModel(ctx)
	ctx.GRPC.Fail("Score", codes.Unavailable, "", 2, "")
	v := mustScore(ctx, established, "two UNAVAILABLE answers then a healthy model")
	calls := len(ctx.GRPC.CallsTo("Score", ""))
	ctx.Assert(calls == 3 && !v.Fallback, "two UNAVAILABLE answers then a healthy model must give the model's verdict on the third attempt, got %+v after %d calls", v, calls)
	refused := established
	refused.FeatureVersion = "fx-2"
	got, err := scoreTransaction(clientBg, refused)
	ctx.Assert(errors.Is(err, errInvalidFeatures), "the model refuses a vector at fx-2 with InvalidArgument, and scoreTransaction answered %+v, %v: return errInvalidFeatures", got, err)
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", ""))-3, 1, "a refused vector must be sent once: InvalidArgument is terminal, every attempt is refused the same way; the calls")
}

func CheckRulesFallback(ctx *harness.Ctx) {
	serveModel(ctx)
	ctx.GRPC.Fail("Score", codes.Unavailable, "", 3, "")
	v := mustScore(ctx, risky, "with the model unavailable")
	expected := verdict{Score: features.RulesScore(risky), Band: "decline", Fallback: true, ModelVersion: features.RulesVersion}
	ctx.Assert(v == expected, "with the model unavailable on all three attempts the verdict was %+v: answer the rules engine's verdict %+v, not a zero", v, expected)
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", "")), 3, "an outage must cost exactly maxAttempts (3) calls; the calls")
}

func CheckRulesBand(ctx *harness.Ctx) {
	serveModel(ctx)
	ctx.GRPC.Fail("Score", codes.Unavailable, "", 3, "")
	v := mustScore(ctx, established, "with the model unavailable")
	ctx.Assert(v.Fallback && v.Band != "approve", "during an outage the rules approved a transaction (%+v): a fallback decision must never approve", v)
	ctx.Assert(math.Abs(v.Score-0.45) < 1e-9 && v.Band == "review", "a clean account during an outage must score rulesMinScore (0.45) in review, got %+v", v)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <string>

#include "fraud/risk_model.h"
#include "fraud_scoring.grpc.pb.h"

namespace {

const features::Features kEstablished{features::kFeatureVersion, 400, 0, 4200};
const features::Features kRisky{features::kFeatureVersion, 12, 2, 4200};

void serveModel(harness::Ctx& ctx) {
  static riskmodel::Peer* peer = nullptr;
  delete peer;
  peer = new riskmodel::Peer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

Verdict mustScore(harness::Ctx& ctx, const features::Features& fx, const std::string& why) {
  try {
    return scoreTransaction(fx);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: scoreTransaction threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  serveModel(ctx);
  Verdict v = mustScore(ctx, kEstablished, "with the model healthy");
  ctx.Assert(!v.fallback && v.model_version == riskmodel::kModelVersion, "with the model healthy the verdict must be the model's, got %s fallback %t", v.model_version, v.fallback);
  for (const auto& call : ctx.GRPC.CallsTo("Score")) {
    ctx.Assert(call.HasDeadline(), "a Score call carries no deadline: a stalled model holds the payment open");
    ctx.Assert(0.25 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.35, "a Score call carries a %v s deadline, expected kDeadline = 300 ms", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Score", 5.0);
  const auto started = ctx.Clock.Now();
  v = mustScore(ctx, kEstablished, "with the model stalled");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 1.0, "with the model stalled for 5 s one score took %v s: three attempts of 300 ms must end within 1 s", waited);
  ctx.Assert(v.fallback, "a model that never answers in time must end in the rules verdict");
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  serveModel(ctx);
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "", 2);
  const Verdict v = mustScore(ctx, kEstablished, "two UNAVAILABLE answers then a healthy model");
  const size_t calls = ctx.GRPC.CallsTo("Score").size();
  ctx.Assert(calls == 3 && !v.fallback, "two UNAVAILABLE answers then a healthy model must give the model's verdict on the third attempt, got fallback %t after %d calls", v.fallback, calls);
  features::Features refused = kEstablished;
  refused.feature_version = "fx-2";
  bool threw = false;
  std::string answered;
  try {
    answered = scoreTransaction(refused).band;
  } catch (const InvalidFeatures&) {
    threw = true;
  }
  ctx.Assert(threw, "the model refuses a vector at fx-2 with INVALID_ARGUMENT, and scoreTransaction answered %s: throw InvalidFeatures", answered);
  ctx.Equal(ctx.GRPC.CallsTo("Score").size() - 3, 1, "a refused vector must be sent once: INVALID_ARGUMENT is terminal, every attempt is refused the same way; the calls");
}

void CheckRulesFallback(harness::Ctx& ctx) {
  serveModel(ctx);
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "", 3);
  const Verdict v = mustScore(ctx, kRisky, "with the model unavailable");
  ctx.Assert(v.score == features::rulesScore(kRisky) && v.band == "decline" && v.fallback && v.model_version == features::kRulesVersion,
             "with the model unavailable on all three attempts the verdict was score %v band %s fallback %t model %s: answer the rules engine's verdict (score %v, decline, fallback, %s), not a zero",
             v.score, v.band, v.fallback, v.model_version, features::rulesScore(kRisky), features::kRulesVersion);
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 3, "an outage must cost exactly kMaxAttempts (3) calls; the calls");
}

void CheckRulesBand(harness::Ctx& ctx) {
  serveModel(ctx);
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "", 3);
  const Verdict v = mustScore(ctx, kEstablished, "with the model unavailable");
  ctx.Assert(v.fallback && v.band != "approve", "during an outage the rules approved a transaction (score %v, band %s): a fallback decision must never approve", v.score, v.band);
  ctx.Assert(std::abs(v.score - 0.45) < 1e-9 && v.band == "review", "a clean account during an outage must score kRulesMinScore (0.45) in review, got %v %s", v.score, v.band);
}
`,
  },
  hints: [
    'Take the model down: every transaction comes back approved with score 0. Stall it for 5 seconds: each payment waits 5 seconds. Send a vector at `fx-2`: three calls, then an approval.',
    'The loop passes no `timeout=`, treats every `RpcError` as worth another try, and its exhausted path is a hard-coded approval. A refusal is a property of the vector, so retrying it changes nothing.',
    'Call with `timeout=DEADLINE_S`; on `INVALID_ARGUMENT` raise `InvalidFeatures`; `continue` only for codes in `RETRYABLE`; after the loop answer `max(rules_score(features), RULES_MIN_SCORE)` with `band_for`, `fallback: True` and `RULES_VERSION`.',
  ],
  debrief: `The status code is the retry policy: \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` say nothing about the vector, \`INVALID_ARGUMENT\` says everything, so retrying it only triples the latency of a request that will be refused anyway. The deadline caps the worst case at three 300 ms attempts, inside a card network's authorization budget. The fallback is the part that decides the money: a rules score raised to the review floor sends payments to review during an outage instead of approving them, and the \`fallback\` marker lets alerting tell an outage from a fraud wave. Production clients add jittered backoff between attempts and a circuit breaker that skips the model while it is down.`,
};
