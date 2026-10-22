import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls with a rules fallback, never a zero',
  concept: 'grpc',
  file: 'client',
  focus: ['scorer', 'model', 'rules'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the model is healthy the
scoring service answers, so the demo passes. Every failure path is wrong, and two of them are the
kind of bug that only shows up during an incident — when nobody is watching the code. Find them, fix
them, and prove the fix with the checks below.

Implement \`score_transaction(features)\`, the fraud scorer's model layer.

- Every attempt carries a **300 ms** deadline (\`DEADLINE_MS\`, a call timeout / \`context.WithTimeout\`
  / \`withDeadlineAfter\` / \`set_deadline\`). A call without one lets one stuck model hold a payment
  request open until the client gives up.
- At most **\`MAX_ATTEMPTS\` (3)** attempts, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retryable: \`RETRYABLE_CODES\` holds them, \`TERMINAL_CODES\` holds the ones that must not be retried.
  An \`INVALID_ARGUMENT\` — a malformed feature vector — is **terminal**: retrying it three times buys
  the same rejection three times and triples the latency of a request that was never going to work.
- When the attempts are exhausted, do **not** return zero risk. Score the transaction with
  \`rules_score(features)\` — a deterministic function over the feature vector — clamp it with
  \`clamp_rules_score\` to \`RULES_MAX_SCORE\`, and return a verdict marked \`fallback: true\` with
  \`model_version\` set to the rules version. A zero-risk verdict during an outage is an approval
  wave: the model being down must degrade the decision, never lower the risk.
- The rules band is the ceiling for degraded decisions: at \`RULES_MAX_SCORE\` a fallback verdict can
  at best land in the review band, so the approval rate during an outage can never exceed the band
  someone signed off on.

**Failure mode the checks target.** The draft has no deadline, catches every error, retries three
times whatever the status is, and after the loop returns \`{"score": 0.0, "band": "approve"}\` — which
means a model outage is scored as a fleet of perfectly safe transactions. The malformed-request retry
is the quieter half: three identical round trips for a vector that will be rejected identically every
time, with a reviewer later reading a latency spike that never had a cause.`,
  sequence: {
    participants: ['Fraud Scorer', 'Fraud model', 'Rules engine'],
    messages: [
      {from: 'Fraud Scorer', to: 'Fraud model', label: 'Score(features) · deadline 300 ms · attempt ≤ 3', kind: 'sync'},
      {from: 'Fraud model', to: 'Fraud Scorer', label: 'INVALID_ARGUMENT on a malformed vector', kind: 'reply'},
      {from: 'Fraud Scorer', to: 'Fraud Scorer', label: 'terminal: no retry, fail the request', kind: 'sync'},
      {from: 'Fraud Scorer', to: 'Fraud model', label: 'retry only UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'sync'},
      {from: 'Fraud model', to: 'Fraud Scorer', label: 'UNAVAILABLE after the last attempt', kind: 'reply'},
      {from: 'Fraud Scorer', to: 'Rules engine', label: 'rules_score(features) · clamp_rules_score', kind: 'sync'},
      {from: 'Rules engine', to: 'Fraud Scorer', label: '0.45 · review band', kind: 'reply'},
      {from: 'Fraud Scorer', to: 'Fraud Scorer', label: '{score 0.45, band review, fallback true}', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 300 ms deadline',
      detail:
        'The call is made with a 300 ms deadline — a call timeout, a `context.WithTimeout`, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + DEADLINE_MS`. Without it one stuck model holds a payment request open indefinitely.',
      match: {
        python: {all: [/DEADLINE_MS\s*=\s*300/, /timeout=DEADLINE_MS/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*300/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadlineMS\s*=\s*300/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineMs\s*=\s*300/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*300/, /set_deadline\(/]},
      },
    },
    {
      id: 'retryable-codes',
      title: 'Only UNAVAILABLE and DEADLINE_EXCEEDED are retried',
      detail:
        'The bounded loop retries a status only when it is in the retryable set (`RETRYABLE_CODES`, `retryableCodes`, `RetryableCodes`, `kRetryableCodes`). The draft retries whatever throws, so a permanent rejection is retried like a blip.',
      match: {
        python: {all: [/RETRYABLE_CODES/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_ATTEMPTS/]},
        typescript: {all: [/RETRYABLE_CODES/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_ATTEMPTS/]},
        go: {all: [/retryableCodes/, /codes\.Unavailable/, /codes\.DeadlineExceeded/, /maxAttempts/]},
        scala: {all: [/RetryableCodes/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MaxAttempts/]},
        cpp: {all: [/kRetryableCodes/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /kMaxAttempts/]},
      },
    },
    {
      id: 'terminal-invalid',
      title: 'A malformed feature vector is terminal',
      detail:
        '`INVALID_ARGUMENT` is not retried: the terminal statuses are declared (`TERMINAL_CODES`, `terminalCodes`, `TerminalCodes`, `kTerminalCodes`) and the retry predicate returns false for them. The draft loops over every exception, so a malformed vector costs three round trips and a confusing latency spike.',
      match: {
        python: {all: [/INVALID_ARGUMENT/, /TERMINAL_CODES/]},
        typescript: {all: [/INVALID_ARGUMENT/, /TERMINAL_CODES/]},
        go: {all: [/codes\.InvalidArgument/, /terminalCodes/]},
        scala: {all: [/INVALID_ARGUMENT/, /TerminalCodes/]},
        cpp: {all: [/INVALID_ARGUMENT/, /kTerminalCodes/]},
      },
    },
    {
      id: 'rules-fallback',
      title: 'A failure returns a rules verdict marked as a fallback, never a zero',
      detail:
        'The exhausted path returns `rules_score(features)` with `fallback: true` and the rules model version. The draft returns `{"score": 0.0, "band": "approve"}` — during a model outage that approves everything, which is how an availability incident becomes a fraud incident.',
      match: {
        python: {all: [/def rules_score\(/, /["']fallback["']:\s*True/], none: [/["']score["']\s*:\s*0(\.0)?\s*[,}]/]},
        typescript: {all: [/function rulesScore\(/, /fallback:\s*true/], none: [/score:\s*0(\.0)?\s*[,}]/]},
        go: {all: [/func rulesScore\(/, /Fallback:\s*true/], none: [/Score:\s*0(\.0)?\b/]},
        scala: {
          all: [/def rulesScore\(/, /,\s*true,\s*FallbackModelVersion/],
          none: [/Verdict\(0(\.0)?\s*,\s*"approve"/],
        },
        cpp: {all: [/rulesScore\(/, /\{"fallback",\s*true\}/], none: [/\{"score",\s*0(\.0)?\}/]},
      },
    },
    {
      id: 'rules-band',
      title: 'The fallback score is clamped to the rules band',
      detail:
        'The rules score is clamped by `clamp_rules_score`/`clampRulesScore` to `RULES_MAX_SCORE`, so a degraded verdict can never reach the approve band and the outage approval rate stays inside the configured rules band.',
      match: {
        python: {all: [/RULES_MAX_SCORE/, /clamp_rules_score\(/]},
        typescript: {all: [/RULES_MAX_SCORE/, /clampRulesScore\(/]},
        go: {all: [/rulesMaxScore/, /clampRulesScore\(/]},
        scala: {all: [/RulesMaxScore/, /clampRulesScore\(/]},
        cpp: {all: [/kRulesMaxScore/, /clampRulesScore\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

from model_pb2 import ScoreRequest

logger = logging.getLogger("model")


def band_for(score: float) -> str:
    if score <= 0.30:
        return "approve"
    if score <= 0.70:
        return "review"
    return "decline"


def score_transaction(stub, features: dict) -> dict:
    # TODO: the draft has no deadline, retries every status three times - including a malformed
    # feature vector - and maps an unreachable model to risk zero, which approves the outage.
    # Review all three.
    for _ in range(3):
        try:
            response = stub.Score(ScoreRequest(features=features))
        except grpc.RpcError:
            continue
        return {
            "score": response.score,
            "band": band_for(response.score),
            "fallback": False,
        }
    return {"score": 0.0, "band": "approve", "fallback": False}
`,
      solution: `import logging

import grpc

from model_pb2 import ScoreRequest

logger = logging.getLogger("model")

DEADLINE_MS = 300
MAX_ATTEMPTS = 3
APPROVE_BAND_MAX = 0.30
REVIEW_BAND_MAX = 0.70
# The rules band is the ceiling for a degraded decision: an outage may review, it may never approve.
RULES_MAX_SCORE = 0.55
FALLBACK_MODEL_VERSION = "rules-v1"
RETRYABLE_CODES = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
TERMINAL_CODES = {
    grpc.StatusCode.INVALID_ARGUMENT,
    grpc.StatusCode.PERMISSION_DENIED,
    grpc.StatusCode.FAILED_PRECONDITION,
}


class TerminalModelError(Exception):
    """The model rejected the request itself: retrying cannot change the answer."""


def band_for(score: float) -> str:
    if score <= APPROVE_BAND_MAX:
        return "approve"
    if score <= REVIEW_BAND_MAX:
        return "review"
    return "decline"


def clamp_rules_score(score: float) -> float:
    return max(0.0, min(score, RULES_MAX_SCORE))


def rules_score(features: dict) -> float:
    """Deterministic over the feature vector: no model, and never a zero."""
    score = 0.05
    if features.get("new_device"):
        score += 0.20
    score += min(int(features.get("prior_chargebacks", 0)), 3) * 0.10
    if features.get("amount_band") == "high":
        score += 0.15
    if int(features.get("account_age_days", 0)) < 7:
        score += 0.10
    return clamp_rules_score(round(score, 4))


def is_retryable(code: grpc.StatusCode) -> bool:
    """A second attempt is worth it only for a status that can answer differently."""
    if code in TERMINAL_CODES:
        return False
    return code in RETRYABLE_CODES


def fallback_verdict(features: dict, reason: str) -> dict:
    score = rules_score(features)
    return {
        "score": score,
        "band": band_for(score),
        "fallback": True,
        "model_version": FALLBACK_MODEL_VERSION,
        "reason": reason,
    }


def score_transaction(stub, features: dict) -> dict:
    last_error = None
    for _ in range(MAX_ATTEMPTS):
        try:
            response = stub.Score(ScoreRequest(features=features), timeout=DEADLINE_MS / 1000)
        except grpc.RpcError as exc:
            code = exc.code()
            if not is_retryable(code):
                logger.info("terminal model status %s", code)
                raise TerminalModelError(f"terminal model status {code}") from exc
            last_error = exc
            continue
        return {
            "score": response.score,
            "band": band_for(response.score),
            "fallback": False,
            "model_version": response.model_version,
        }
    logger.warning("model unavailable after %d attempts: %s", MAX_ATTEMPTS, last_error)
    return fallback_verdict(features, "model_unavailable")
`,
    },
    typescript: {
      starter: `/** The scorer's model layer — a model-generated draft. */
import * as grpc from '@grpc/grpc-js';

import {client} from './stubs';

export interface Verdict {
  score: number;
  band: string;
  fallback: boolean;
}

function bandFor(score: number): string {
  if (score <= 0.3) return 'approve';
  if (score <= 0.7) return 'review';
  return 'decline';
}

export async function scoreTransaction(features: Record<string, unknown>): Promise<Verdict> {
  // TODO: the draft has no deadline, retries every status three times - including a malformed
  // feature vector - and maps an unreachable model to risk zero, which approves the outage.
  // Review all three.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await client.score({features});
      return {score: response.score, band: bandFor(response.score), fallback: false};
    } catch {
      continue;
    }
  }
  return {score: 0, band: 'approve', fallback: false};
}
`,
      solution: `/** The scorer's model layer: a 300 ms deadline, bounded retries, and a rules fallback. */
import * as grpc from '@grpc/grpc-js';

import {client} from './stubs';

export interface FeatureVector {
  version: string;
  account_age_days: number;
  prior_chargebacks: number;
  amount_band: string;
  tx_ref: string;
  new_device?: boolean;
}

export interface Verdict {
  score: number;
  band: string;
  fallback: boolean;
  model_version: string;
  reason?: string;
}

export class TerminalModelError extends Error {}

const DEADLINE_MS = 300;
const MAX_ATTEMPTS = 3;
const APPROVE_BAND_MAX = 0.3;
const REVIEW_BAND_MAX = 0.7;
// The rules band is the ceiling for a degraded decision: an outage may review, it may never approve.
const RULES_MAX_SCORE = 0.55;
const FALLBACK_MODEL_VERSION = 'rules-v1';
const RETRYABLE_CODES = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);
const TERMINAL_CODES = new Set([
  grpc.status.INVALID_ARGUMENT,
  grpc.status.PERMISSION_DENIED,
  grpc.status.FAILED_PRECONDITION,
]);

function bandFor(score: number): string {
  if (score <= APPROVE_BAND_MAX) return 'approve';
  if (score <= REVIEW_BAND_MAX) return 'review';
  return 'decline';
}

function clampRulesScore(score: number): number {
  return Math.max(0, Math.min(score, RULES_MAX_SCORE));
}

/** Deterministic over the feature vector: no model, and never a zero. */
function rulesScore(features: FeatureVector): number {
  let score = 0.05;
  if (features.new_device === true) score += 0.2;
  score += Math.min(features.prior_chargebacks, 3) * 0.1;
  if (features.amount_band === 'high') score += 0.15;
  if (features.account_age_days < 7) score += 0.1;
  return clampRulesScore(Math.round(score * 10000) / 10000);
}

/** A second attempt is worth it only for a status that can answer differently. */
function isRetryable(code: grpc.status): boolean {
  if (TERMINAL_CODES.has(code)) return false;
  return RETRYABLE_CODES.has(code);
}

function fallbackVerdict(features: FeatureVector, reason: string): Verdict {
  const score = rulesScore(features);
  return {score, band: bandFor(score), fallback: true, model_version: FALLBACK_MODEL_VERSION, reason};
}

export async function scoreTransaction(features: FeatureVector): Promise<Verdict> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.score({features}, {deadline: Date.now() + DEADLINE_MS});
      return {
        score: response.score,
        band: bandFor(response.score),
        fallback: false,
        model_version: response.model_version,
      };
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (!isRetryable(code)) throw new TerminalModelError(\`terminal model status \${code}\`);
      lastError = error;
    }
  }
  console.warn('model unavailable after', MAX_ATTEMPTS, 'attempts:', lastError);
  return fallbackVerdict(features, 'model_unavailable');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	pb "scoring/modelpb"
)

type FeatureVector struct {
	Version          string
	AccountAgeDays   int
	PriorChargebacks int
	AmountBand       string
	TxRef            string
	NewDevice        bool
}

type Verdict struct {
	Score        float64 \`json:"score"\`
	Band         string  \`json:"band"\`
	Fallback     bool    \`json:"fallback"\`
	ModelVersion string  \`json:"model_version"\`
}

type ModelClient interface {
	Score(ctx context.Context, in *pb.ScoreRequest) (*pb.ScoreReply, error)
}

func bandFor(score float64) string {
	switch {
	case score <= 0.30:
		return "approve"
	case score <= 0.70:
		return "review"
	default:
		return "decline"
	}
}

func scoreTransaction(ctx context.Context, client ModelClient, features FeatureVector) (Verdict, error) {
	// TODO: the draft has no deadline, retries every status three times - including a malformed
	// feature vector - and maps an unreachable model to risk zero, which approves the outage.
	// Review all three.
	for attempt := 0; attempt < 3; attempt++ {
		response, err := client.Score(ctx, &pb.ScoreRequest{FeatureVersion: features.Version, TxRef: features.TxRef})
		if err != nil {
			continue
		}
		return Verdict{Score: response.Score, Band: bandFor(response.Score)}, nil
	}
	log.Printf("model unreachable, scoring zero risk")
	return Verdict{Score: 0, Band: "approve"}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "scoring/modelpb"
)

const (
	deadlineMS           = 300
	maxAttempts          = 3
	approveBandMax       = 0.30
	reviewBandMax        = 0.70
	// The rules band is the ceiling for a degraded decision: an outage may review, it may never
	// approve.
	rulesMaxScore        = 0.55
	fallbackModelVersion = "rules-v1"
)

var retryableCodes = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}
var terminalCodes = map[codes.Code]bool{
	codes.InvalidArgument:    true,
	codes.PermissionDenied:   true,
	codes.FailedPrecondition: true,
}

type FeatureVector struct {
	Version          string
	AccountAgeDays   int
	PriorChargebacks int
	AmountBand       string
	TxRef            string
	NewDevice        bool
}

type Verdict struct {
	Score        float64 \`json:"score"\`
	Band         string  \`json:"band"\`
	Fallback     bool    \`json:"fallback"\`
	ModelVersion string  \`json:"model_version"\`
	Reason       string  \`json:"reason,omitempty"\`
}

type ModelClient interface {
	Score(ctx context.Context, in *pb.ScoreRequest) (*pb.ScoreReply, error)
}

// TerminalModelError reports a status a retry cannot change.
type TerminalModelError struct {
	Code codes.Code
}

func (e *TerminalModelError) Error() string {
	return "terminal model status " + e.Code.String()
}

func bandFor(score float64) string {
	switch {
	case score <= approveBandMax:
		return "approve"
	case score <= reviewBandMax:
		return "review"
	default:
		return "decline"
	}
}

func clampRulesScore(score float64) float64 {
	if score < 0 {
		return 0
	}
	if score > rulesMaxScore {
		return rulesMaxScore
	}
	return score
}

// Deterministic over the feature vector: no model, and never a zero.
func rulesScore(features FeatureVector) float64 {
	score := 0.05
	if features.NewDevice {
		score += 0.20
	}
	chargebacks := features.PriorChargebacks
	if chargebacks > 3 {
		chargebacks = 3
	}
	score += float64(chargebacks) * 0.10
	if features.AmountBand == "high" {
		score += 0.15
	}
	if features.AccountAgeDays < 7 {
		score += 0.10
	}
	return clampRulesScore(score)
}

// A second attempt is worth it only for a status that can answer differently.
func isRetryable(code codes.Code) bool {
	if terminalCodes[code] {
		return false
	}
	return retryableCodes[code]
}

func fallbackVerdict(features FeatureVector, reason string) Verdict {
	score := rulesScore(features)
	return Verdict{Score: score, Band: bandFor(score), Fallback: true, ModelVersion: fallbackModelVersion, Reason: reason}
}

func scoreTransaction(ctx context.Context, client ModelClient, features FeatureVector) (Verdict, error) {
	var lastError error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		response, err := client.Score(callCtx, &pb.ScoreRequest{
			FeatureVersion:   features.Version,
			AccountAgeDays:   int32(features.AccountAgeDays),
			PriorChargebacks: int32(features.PriorChargebacks),
			AmountBand:       features.AmountBand,
			TxRef:            features.TxRef,
		})
		cancel()
		if err == nil {
			return Verdict{Score: response.Score, Band: bandFor(response.Score), ModelVersion: response.ModelVersion}, nil
		}
		st, ok := status.FromError(err)
		if !ok {
			lastError = err
			continue
		}
		if !isRetryable(st.Code()) {
			return Verdict{}, &TerminalModelError{Code: st.Code()}
		}
		lastError = err
	}
	if lastError != nil {
		log.Printf("model unavailable after %d attempts: %v", maxAttempts, lastError)
	}
	return fallbackVerdict(features, "model_unavailable"), nil
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException

object ModelClient {
  case class Verdict(score: Double, band: String, fallback: Boolean, modelVersion: String)

  case class ScoreRequest(features: Map[String, Any])
  case class ScoreReply(score: Double, modelVersion: String)

  trait ModelStub {
    def score(request: ScoreRequest): ScoreReply
  }

  def bandFor(score: Double): String =
    if (score <= 0.30) "approve" else if (score <= 0.70) "review" else "decline"

  // TODO: the draft has no deadline, retries every status three times - including a malformed
  // feature vector - and maps an unreachable model to risk zero, which approves the outage.
  // Review all three.
  def scoreTransaction(model: ModelStub, features: Map[String, Any]): Verdict = {
    var attempt = 0
    while (attempt < 3) {
      try {
        val reply = model.score(ScoreRequest(features))
        return Verdict(reply.score, bandFor(reply.score), false, reply.modelVersion)
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    Verdict(0.0, "approve", false, "none")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object ModelClient {
  val DeadlineMs = 300
  val MaxAttempts = 3
  val ApproveBandMax = 0.30
  val ReviewBandMax = 0.70
  // The rules band is the ceiling for a degraded decision: an outage may review, it may never
  // approve.
  val RulesMaxScore = 0.55
  val FallbackModelVersion = "rules-v1"
  val RetryableCodes = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val TerminalCodes = Set(Status.Code.INVALID_ARGUMENT, Status.Code.PERMISSION_DENIED, Status.Code.FAILED_PRECONDITION)

  case class Verdict(score: Double, band: String, fallback: Boolean, modelVersion: String, reason: String = "")

  case class ScoreRequest(features: Map[String, Any])
  case class ScoreReply(score: Double, modelVersion: String)

  trait ModelStub {
    def withDeadlineAfter(millis: Long, unit: TimeUnit): ModelStub
    def score(request: ScoreRequest): ScoreReply
  }

  class TerminalModelError(message: String) extends RuntimeException(message)

  def bandFor(score: Double): String =
    if (score <= ApproveBandMax) "approve" else if (score <= ReviewBandMax) "review" else "decline"

  def clampRulesScore(score: Double): Double = math.max(0.0, math.min(score, RulesMaxScore))

  // Deterministic over the feature vector: no model, and never a zero.
  def rulesScore(features: Map[String, Any]): Double = {
    var score = 0.05
    if (features.get("new_device").contains(true)) score += 0.20
    score += math.min(features.getOrElse("prior_chargebacks", 0).asInstanceOf[Int], 3) * 0.10
    if (features.get("amount_band").contains("high")) score += 0.15
    if (features.getOrElse("account_age_days", 0).asInstanceOf[Int] < 7) score += 0.10
    clampRulesScore(BigDecimal(score).setScale(4, BigDecimal.RoundingMode.HALF_UP).toDouble)
  }

  // A second attempt is worth it only for a status that can answer differently.
  def isRetryable(code: Status.Code): Boolean =
    if (TerminalCodes.contains(code)) false else RetryableCodes.contains(code)

  def fallbackVerdict(features: Map[String, Any], reason: String): Verdict = {
    val score = rulesScore(features)
    Verdict(score, bandFor(score), true, FallbackModelVersion, reason)
  }

  def scoreTransaction(model: ModelStub, features: Map[String, Any]): Verdict = {
    var lastError: Option[StatusRuntimeException] = None
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val reply = model.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).score(ScoreRequest(features))
        return Verdict(reply.score, bandFor(reply.score), false, reply.modelVersion)
      } catch {
        case exc: StatusRuntimeException =>
          if (!isRetryable(exc.getStatus.getCode)) {
            throw new TerminalModelError(s"terminal model status \${exc.getStatus.getCode}")
          }
          lastError = Some(exc)
      }
      attempt += 1
    }
    fallbackVerdict(features, lastError.map(_ => "model_unavailable").getOrElse("model_unavailable"))
  }
}
`,
    },
    cpp: {
      starter: `// The scorer's model layer — a model-generated draft.
#include <string>

#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "model.grpc.pb.h"

using json = nlohmann::json;

static std::string bandFor(double score) {
  if (score <= 0.30) return "approve";
  if (score <= 0.70) return "review";
  return "decline";
}

static json scoreTransaction(Model::Stub* stub, const json& features) {
  // TODO: the draft has no deadline, retries every status three times - including a malformed
  // feature vector - and maps an unreachable model to risk zero, which approves the outage.
  // Review all three.
  for (int attempt = 0; attempt < 3; ++attempt) {
    grpc::ClientContext ctx;
    ScoreReply reply;
    if (stub->Score(&ctx, ScoreRequest{}, &reply).ok()) {
      return json{{"score", reply.score()}, {"band", bandFor(reply.score())}, {"fallback", false}};
    }
  }
  return json{{"score", 0.0}, {"band", "approve"}, {"fallback", false}};
}
`,
      solution: `// The scorer's model layer: a 300 ms deadline, bounded retries, and a rules fallback.
#include <algorithm>
#include <chrono>
#include <map>
#include <stdexcept>
#include <string>

#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "model.grpc.pb.h"

using json = nlohmann::json;

constexpr int kDeadlineMs = 300;
constexpr int kMaxAttempts = 3;
constexpr double kApproveBandMax = 0.30;
constexpr double kReviewBandMax = 0.70;
// The rules band is the ceiling for a degraded decision: an outage may review, it may never approve.
constexpr double kRulesMaxScore = 0.55;
constexpr const char* kFallbackModelVersion = "rules-v1";

static const std::map<grpc::StatusCode, bool> kRetryableCodes = {
    {grpc::StatusCode::UNAVAILABLE, true},
    {grpc::StatusCode::DEADLINE_EXCEEDED, true},
};
static const std::map<grpc::StatusCode, bool> kTerminalCodes = {
    {grpc::StatusCode::INVALID_ARGUMENT, true},
    {grpc::StatusCode::PERMISSION_DENIED, true},
    {grpc::StatusCode::FAILED_PRECONDITION, true},
};

class TerminalModelError : public std::runtime_error {
 public:
  explicit TerminalModelError(const std::string& message) : std::runtime_error(message) {}
};

static std::string bandFor(double score) {
  if (score <= kApproveBandMax) return "approve";
  if (score <= kReviewBandMax) return "review";
  return "decline";
}

static double clampRulesScore(double score) {
  return std::max(0.0, std::min(score, kRulesMaxScore));
}

// Deterministic over the feature vector: no model, and never a zero.
static double rulesScore(const json& features) {
  double score = 0.05;
  if (features.value("new_device", false)) score += 0.20;
  score += std::min(features.value("prior_chargebacks", 0), 3) * 0.10;
  if (features.value("amount_band", std::string("unknown")) == "high") score += 0.15;
  if (features.value("account_age_days", 0) < 7) score += 0.10;
  return clampRulesScore(score);
}

// A second attempt is worth it only for a status that can answer differently.
static bool isRetryable(grpc::StatusCode code) {
  if (kTerminalCodes.count(code) > 0) return false;
  return kRetryableCodes.count(code) > 0;
}

static json fallbackVerdict(const json& features, const std::string& reason) {
  const double score = rulesScore(features);
  return json{{"score", score},
              {"band", bandFor(score)},
              {"fallback", true},
              {"model_version", kFallbackModelVersion},
              {"reason", reason}};
}

static json scoreTransaction(Model::Stub* stub, const json& features) {
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ScoreRequest request;
    ScoreReply reply;
    const grpc::Status status = stub->Score(&ctx, request, &reply);
    if (status.ok()) {
      return json{{"score", reply.score()},
                  {"band", bandFor(reply.score())},
                  {"fallback", false},
                  {"model_version", reply.model_version()}};
    }
    if (!isRetryable(status.error_code())) {
      throw TerminalModelError("terminal model status " + std::to_string(status.error_code()));
    }
  }
  return fallbackVerdict(features, "model_unavailable");
}
`,
    },
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`), not a wrapper around it. Bound the loop with `MAX_ATTEMPTS`; the draft’s `for _ in range(3)` is bounded but blind — it retries a rejection exactly like a blip.',
    'Retryability is a property of the status: capture the error, compare its code against `RETRYABLE_CODES`, and treat `TERMINAL_CODES` (starting with `INVALID_ARGUMENT`) as final. The terminal case should raise, not fall back: a malformed vector is a bug in the caller, and hiding it behind a rules verdict hides the bug.',
    'The fallback is where the outage is decided. `rules_score(features)` must be deterministic over the feature vector, clamped by `clamp_rules_score` to `RULES_MAX_SCORE`, and returned with `fallback: true` plus the rules version. A `0.0` here is not `no risk`, it is `no model` written as the lowest possible risk.',
  ],
  debrief: `The interviewer is testing how the scorer behaves when the model does not. Three defects are checked: the missing deadline (a stuck model is an unbounded request), the blanket retry (a permanent rejection is retried like a transient one), and the zero verdict (an outage that scores everything safe). The fallback is the interesting half of the step: a degraded verdict has to be inside a band someone approved, marked so downstream alerting can see it, and versioned so a disputed decision can be replayed. Real implementations add a circuit breaker in front of the attempts, jittered backoff, and a metric for the fallback rate — if the fallback rate is not zero and unknown, nobody knows what fraction of yesterday's approvals came from the rules.`,
};
