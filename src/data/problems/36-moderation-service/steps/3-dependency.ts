import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Classifier triage that never auto-acts on weak evidence',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'classifier', 'queue'],
  task: `## Task

The starter is a plausible model-generated draft: the classifier answers, the item gets a route, the
demo passes. The draft treats the model as an authority it is not. Fix the evidence bar, the
deadline and the retry set, and prove the fix.

Implement the classifier call that decides between an automatic action and the human queue:

- The call runs under a **400 ms** deadline (\`DEADLINE_MS = 400\`). The draft calls with no deadline,
  so a slow classifier holds the request until the client gives up.
- Retry only on \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`. \`REFUSED\` and every other code is terminal
  and must **not** be retried — the draft loops on \`REFUSED\`, turning a policy refusal into a hot
  loop.
- An automatic removal requires **both** a confidence of at least **0.98**
  (\`AUTO_REMOVE_CONFIDENCE\`) **and** a second, independent corroborating signal
  (\`corroborates(signal)\`). The draft auto-removes at **0.6** with nothing else behind it, so
  borderline content vanishes on a weak score.
- Everything weaker goes to the human queue: a score below the bar, a missing second signal, and
  critically a **timeout or an unavailable classifier** — a failure to classify is never a licence
  to publish or to remove, so it lands in the queue rather than an \`allow\`.
- Every automatic removal **records its evidence** (score, signal and model version) before it
  returns, so the decision can be audited after the model changes.

**Failure mode the checks target.** A classifier is advice under a deadline, not a judge. The draft
fails three ways: a threshold so low it acts on noise, a retry set that includes a terminal code,
and a "safe on error" path that lets unclassified content through. Each one is the kind of defect
that only shows up when the model is wrong or slow.`,
  sequence: {
    participants: ['Moderation API', 'Classifier', 'Human queue'],
    messages: [
      {from: 'Moderation API', to: 'Classifier', label: 'Classify · deadline 400 ms', kind: 'sync'},
      {from: 'Classifier', to: 'Moderation API', label: '{label, confidence, rule, model_version}', kind: 'reply'},
      {from: 'Moderation API', to: 'Moderation API', label: 'confidence ≥ 0.98 · second signal present?', kind: 'sync'},
      {
        from: 'Moderation API',
        to: 'Human queue',
        label: 'queue(content_id, weak_evidence | classifier_unavailable)',
        kind: 'async',
      },
      {from: 'Moderation API', to: 'Moderation API', label: 'auto_remove only with recorded evidence', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the classifier under a 400 ms deadline',
      detail:
        'Every `Classify` runs under a **400 ms** deadline (`DEADLINE_MS` / `deadlineMS`). The draft calls with no deadline at all, so a wedged classifier holds the request open until the caller times out.',
      match: {
        python: {all: [/DEADLINE_MS/, /timeout=/]},
        typescript: {all: [/DEADLINE_MS/, /deadline/]},
        go: {all: [/deadlineMS/, /context\.WithTimeout/]},
        scala: {all: [/DeadlineMs/, /Deadline/]},
        cpp: {all: [/kDeadlineMs/, /set_deadline/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        'The retry set is exactly `UNAVAILABLE` and `DEADLINE_EXCEEDED`; `REFUSED` is terminal and is never retried. The draft retries `REFUSED`, so a policy refusal becomes an infinite loop.',
      match: {
        python: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/REFUSED/]},
        typescript: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/REFUSED/]},
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/], none: [/codes\.Refused/]},
        scala: {all: [/Status\.UNAVAILABLE/, /Status\.DEADLINE_EXCEEDED/], none: [/Status\.REFUSED/]},
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/REFUSED/]},
      },
    },
    {
      id: 'auto-threshold',
      title: 'Requires 0.98 confidence to act',
      detail:
        'An automatic action needs `AUTO_REMOVE_CONFIDENCE = 0.98`. The draft acts at **0.6**, which is inside the classifier’s noise band, so ordinary posts get removed.',
      match: {
        python: {all: [/AUTO_REMOVE_CONFIDENCE/, /0\.98/]},
        typescript: {all: [/AUTO_REMOVE_CONFIDENCE/, /0\.98/]},
        go: {all: [/autoRemoveConfidence/, /0\.98/]},
        scala: {all: [/AutoRemoveConfidence/, /0\.98/]},
        cpp: {all: [/kAutoRemoveConfidence/, /0\.98/]},
      },
    },
    {
      id: 'corroboration',
      title: 'Acts only with a second signal, and records the evidence',
      detail:
        '`corroborates(signal)` must confirm a second, independent signal before an automatic removal, and the removal records its `evidence` (score, signal, model version). The draft removes on the score alone and keeps no evidence.',
      match: {
        python: {all: [/SECOND_SIGNAL/, /corroborates\(/, /evidence/]},
        typescript: {all: [/SECOND_SIGNAL/, /corroborates\(/, /evidence/]},
        go: {all: [/secondSignal/, /corroborates\(/, /evidence/]},
        scala: {all: [/SecondSignal/, /corroborates\(/, /evidence/]},
        cpp: {all: [/kSecondSignal/, /corroborates\(/, /evidence/]},
      },
    },
    {
      id: 'timeout-safe',
      title: 'Routes a classifier failure to humans, never to allow',
      detail:
        'A timeout or an unavailable classifier returns the human queue, not an `allow`. The draft treats the error as safe and publishes the content unclassified.',
      match: {
        python: {all: [/except grpc\.RpcError/, /queue_for_human\(/]},
        typescript: {all: [/catch\s*\(\s*err/, /queueForHuman\(/]},
        go: {all: [/if err != nil/, /queueForHuman\(/]},
        scala: {all: [/StatusRuntimeException/, /queueForHuman\(/]},
        cpp: {all: [/!status\.ok\(\)/, /queueForHuman\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import classifier_pb2
import classifier_pb2_grpc

AUTO_REMOVE_CONFIDENCE = 0.6
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.REFUSED)

channel = grpc.insecure_channel("classifier:9000")
classifier = classifier_pb2_grpc.ClassifierStub(channel)


def triage(content_id: str, text: str, signal: str) -> dict:
    # TODO: this draft auto-removes at 0.6, retries REFUSED calls, and treats a timeout as safe,
    # so borderline content is removed on noise and unclassified content is published.
    try:
        request = classifier_pb2.ClassifyRequest(content_id=content_id, text=text)
        score = classifier.Classify(request)
    except grpc.RpcError as err:
        if err.code() in RETRYABLE:
            return triage(content_id, text, signal)
        return {"content_id": content_id, "route": "auto_allow"}
    if score.confidence >= AUTO_REMOVE_CONFIDENCE:
        return {"content_id": content_id, "route": "auto_remove", "rule": score.rule}
    return {"content_id": content_id, "route": "auto_allow"}
`,
      solution: `import logging

import grpc

import classifier_pb2
import classifier_pb2_grpc

logger = logging.getLogger("moderation")

DEADLINE_MS = 400
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
AUTO_REMOVE_CONFIDENCE = 0.98
SECOND_SIGNAL = {"reporter_trust", "duplicate_velocity"}

channel = grpc.insecure_channel("classifier:9000")
classifier = classifier_pb2_grpc.ClassifierStub(channel)


def classify(content_id: str, text: str):
    request = classifier_pb2.ClassifyRequest(content_id=content_id, text=text)
    return classifier.Classify(request, timeout=DEADLINE_MS / 1000)


def corroborates(signal: str) -> bool:
    return signal in SECOND_SIGNAL


def queue_for_human(content_id: str, **fields) -> dict:
    return {"content_id": content_id, "route": "human_queue", **fields}


def record_evidence(content_id: str, evidence: dict) -> None:
    """Persist the score, signal and model version behind an automatic removal."""
    raise NotImplementedError


def triage(content_id: str, text: str, signal: str) -> dict:
    try:
        score = classify(content_id, text)
    except grpc.RpcError as err:
        if err.code() not in RETRYABLE:
            raise
        logger.warning("classifier unavailable content=%s code=%s", content_id, err.code().name)
        return queue_for_human(content_id, reason="classifier_unavailable")

    if score.label == "remove" and score.confidence >= AUTO_REMOVE_CONFIDENCE and corroborates(signal):
        evidence = {"score": score.confidence, "signal": signal, "model": score.model_version}
        record_evidence(content_id, evidence)
        return {"content_id": content_id, "route": "auto_remove", "rule": score.rule, "evidence": evidence}
    return queue_for_human(content_id, reason="weak_evidence", score=score.confidence)
`,
    },
    typescript: {
      starter: `/** Classifier triage: a model-generated draft that acts on noise and retries refusals. */
import * as grpc from '@grpc/grpc-js';

import {classifier} from './classifier';

const AUTO_REMOVE_CONFIDENCE = 0.6;
const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.REFUSED]);

function classify(contentId: string, text: string): Promise<{confidence: number; rule: string}> {
  return new Promise((resolve, reject) => {
    classifier.Classify({content_id: contentId, text}, (err, score) => (err ? reject(err) : resolve(score)));
  });
}

export async function triage(contentId: string, text: string, signal: string): Promise<Record<string, unknown>> {
  // TODO: this draft auto-removes at 0.6, retries REFUSED calls, and treats a timeout as safe,
  // so borderline content is removed on noise and unclassified content is published.
  try {
    const score = await classify(contentId, text);
    if (score.confidence >= AUTO_REMOVE_CONFIDENCE)
      return {content_id: contentId, route: 'auto_remove', rule: score.rule};
    return {content_id: contentId, route: 'auto_allow'};
  } catch (err) {
    if (RETRYABLE.has((err as grpc.ServiceError).code)) return triage(contentId, text, signal);
    return {content_id: contentId, route: 'auto_allow'};
  }
}
`,
      solution: `/** Classifier triage: a model may auto-act only on strong, corroborated evidence. */
import * as grpc from '@grpc/grpc-js';

import {classifier} from './classifier';

const DEADLINE_MS = 400;
const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);
const AUTO_REMOVE_CONFIDENCE = 0.98;
const SECOND_SIGNAL = new Set(['reporter_trust', 'duplicate_velocity']);

interface Score {
  label: string;
  confidence: number;
  rule: string;
  model_version: string;
}

function corroborates(signal: string): boolean {
  return SECOND_SIGNAL.has(signal);
}

export function queueForHuman(contentId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {content_id: contentId, route: 'human_queue', ...fields};
}

function recordEvidence(contentId: string, evidence: Record<string, unknown>): void {
  // Persist score, signal and model version behind the automatic removal.
}

function classify(contentId: string, text: string): Promise<Score> {
  return new Promise((resolve, reject) => {
    classifier.Classify({content_id: contentId, text}, {deadline: Date.now() + DEADLINE_MS}, (err, score) => {
      if (err) reject(err);
      else resolve(score as Score);
    });
  });
}

export async function triage(
  contentId: string,
  text: string,
  signal: string,
): Promise<Record<string, unknown>> {
  let score: Score;
  try {
    score = await classify(contentId, text);
  } catch (err) {
    if (!RETRYABLE.has((err as grpc.ServiceError).code)) throw err;
    return queueForHuman(contentId, {reason: 'classifier_unavailable'});
  }

  if (score.label === 'remove' && score.confidence >= AUTO_REMOVE_CONFIDENCE && corroborates(signal)) {
    const evidence = {score: score.confidence, signal, model: score.model_version};
    recordEvidence(contentId, evidence);
    return {content_id: contentId, route: 'auto_remove', rule: score.rule, evidence};
  }
  return queueForHuman(contentId, {reason: 'weak_evidence', score: score.confidence});
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	classifierv1 "moderation/classifier"
)

const autoRemoveConfidence = 0.6

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.Refused: true}

func triage(ctx context.Context, client classifierv1.ClassifierClient, contentID, text, signal string) (map[string]any, error) {
	// TODO: this draft auto-removes at 0.6, retries REFUSED calls, and treats a timeout as safe,
	// so borderline content is removed on noise and unclassified content is published.
	score, err := client.Classify(ctx, &classifierv1.ClassifyRequest{ContentId: contentID, Text: text})
	if err != nil {
		if retryable[status.Code(err)] {
			return triage(ctx, client, contentID, text, signal)
		}
		return map[string]any{"content_id": contentID, "route": "auto_allow"}, nil
	}
	if score.Confidence >= autoRemoveConfidence {
		return map[string]any{"content_id": contentID, "route": "auto_remove", "rule": score.Rule}, nil
	}
	return map[string]any{"content_id": contentID, "route": "auto_allow"}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	classifierv1 "moderation/classifier"
)

const (
	deadlineMS           = 400
	autoRemoveConfidence = 0.98
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}
var secondSignal = map[string]bool{"reporter_trust": true, "duplicate_velocity": true}

func corroborates(signal string) bool { return secondSignal[signal] }

func queueForHuman(contentID string, fields map[string]any) map[string]any {
	out := map[string]any{"content_id": contentID, "route": "human_queue"}
	for key, value := range fields {
		out[key] = value
	}
	return out
}

func recordEvidence(contentID string, evidence map[string]any) {
	// Persist score, signal and model version behind the automatic removal.
}

func triage(ctx context.Context, client classifierv1.ClassifierClient, contentID, text, signal string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	score, err := client.Classify(ctx, &classifierv1.ClassifyRequest{ContentId: contentID, Text: text})
	if err != nil {
		if !retryable[status.Code(err)] {
			return nil, err
		}
		log.Printf("classifier unavailable content=%s code=%s", contentID, status.Code(err))
		return queueForHuman(contentID, map[string]any{"reason": "classifier_unavailable"}), nil
	}
	if score.Label == "remove" && score.Confidence >= autoRemoveConfidence && corroborates(signal) {
		evidence := map[string]any{"score": score.Confidence, "signal": signal, "model": score.ModelVersion}
		recordEvidence(contentID, evidence)
		return map[string]any{"content_id": contentID, "route": "auto_remove", "rule": score.Rule, "evidence": evidence}, nil
	}
	return queueForHuman(contentID, map[string]any{"reason": "weak_evidence", "score": score.Confidence}), nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import scala.jdk.CollectionConverters._

object Triage {
  val AutoRemoveConfidence = 0.6
  val Retryable = Set(Status.UNAVAILABLE, Status.REFUSED)

  def triage(client: ClassifierGrpc.ClassifierBlockingStub, contentId: String, text: String, signal: String): Map[String, Any] = {
    // TODO: this draft auto-removes at 0.6, retries REFUSED calls, and treats a timeout as safe,
    // so borderline content is removed on noise and unclassified content is published.
    try {
      val score = client.classify(ClassifyRequest(contentId, text))
      if (score.confidence >= AutoRemoveConfidence)
        Map("content_id" -> contentId, "route" -> "auto_remove", "rule" -> score.rule)
      else Map("content_id" -> contentId, "route" -> "auto_allow")
    } catch {
      case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) =>
        triage(client, contentId, text, signal)
      case _: StatusRuntimeException =>
        Map("content_id" -> contentId, "route" -> "auto_allow")
    }
  }
}
`,
      solution: `import io.grpc.{Status, StatusRuntimeException}

import java.util.concurrent.TimeUnit

object Triage {
  val DeadlineMs = 400
  val AutoRemoveConfidence = 0.98
  val SecondSignal = Set("reporter_trust", "duplicate_velocity")

  val Retryable = Set(Status.UNAVAILABLE, Status.DEADLINE_EXCEEDED)

  def corroborates(signal: String): Boolean = SecondSignal.contains(signal)

  def queueForHuman(contentId: String, fields: Map[String, Any]): Map[String, Any] =
    Map("content_id" -> contentId, "route" -> "human_queue") ++ fields

  def recordEvidence(contentId: String, evidence: Map[String, Any]): Unit = {
    // Persist score, signal and model version behind the automatic removal.
  }

  def triage(
      client: ClassifierGrpc.ClassifierBlockingStub,
      contentId: String,
      text: String,
      signal: String
  ): Map[String, Any] = {
    val stub = client.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
    val score =
      try stub.classify(ClassifyRequest(contentId, text))
      catch {
        case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) =>
          return queueForHuman(contentId, Map("reason" -> "classifier_unavailable"))
        case e: StatusRuntimeException =>
          throw e
      }
    if (score.label == "remove" && score.confidence >= AutoRemoveConfidence && corroborates(signal)) {
      val evidence = Map("score" -> score.confidence, "signal" -> signal, "model" -> score.modelVersion)
      recordEvidence(contentId, evidence)
      Map("content_id" -> contentId, "route" -> "auto_remove", "rule" -> score.rule, "evidence" -> evidence)
    } else {
      queueForHuman(contentId, Map("reason" -> "weak_evidence", "score" -> score.confidence))
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <string>

#include "classifier.grpc.pb.h"

constexpr double kAutoRemoveConfidence = 0.6;

using Fields = std::map<std::string, std::string>;

Fields triage(Classifier::Stub& stub, const std::string& contentId, const std::string& text,
              const std::string& signal) {
  // TODO: this draft auto-removes at 0.6, retries REFUSED calls, and treats a timeout as safe,
  // so borderline content is removed on noise and unclassified content is published.
  grpc::ClientContext ctx;
  ClassifyRequest request;
  request.set_content_id(contentId);
  request.set_text(text);
  ClassifyReply score;
  const auto status = stub.Classify(&ctx, request, &score);
  if (!status.ok()) {
    const auto code = status.error_code();
    if (code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::REFUSED) {
      return triage(stub, contentId, text, signal);
    }
    return {{"content_id", contentId}, {"route", "auto_allow"}};
  }
  if (score.confidence() >= kAutoRemoveConfidence) {
    return {{"content_id", contentId}, {"route", "auto_remove"}, {"rule", score.rule()}};
  }
  return {{"content_id", contentId}, {"route", "auto_allow"}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "classifier.grpc.pb.h"

constexpr int kDeadlineMs = 400;
constexpr double kAutoRemoveConfidence = 0.98;
const std::vector<std::string> kSecondSignal = {"reporter_trust", "duplicate_velocity"};

using Fields = std::map<std::string, std::string>;

bool corroborates(const std::string& signal) {
  for (const auto& candidate : kSecondSignal) {
    if (candidate == signal) return true;
  }
  return false;
}

Fields queueForHuman(const std::string& contentId, const std::string& reason) {
  return {{"content_id", contentId}, {"route", "human_queue"}, {"reason", reason}};
}

void recordEvidence(const std::string& contentId, const std::string& evidence) {
  // Persist score, signal and model version behind the automatic removal.
}

Fields triage(Classifier::Stub& stub, const std::string& contentId, const std::string& text,
              const std::string& signal) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  ClassifyRequest request;
  request.set_content_id(contentId);
  request.set_text(text);
  ClassifyReply score;
  const auto status = stub.Classify(&ctx, request, &score);
  if (!status.ok()) {
    const auto code = status.error_code();
    if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED) {
      throw std::runtime_error(status.error_message());
    }
    return queueForHuman(contentId, "classifier_unavailable");
  }
  if (score.label() == "remove" && score.confidence() >= kAutoRemoveConfidence && corroborates(signal)) {
    const auto evidence = "score=" + std::to_string(score.confidence()) + " signal=" + signal;
    recordEvidence(contentId, evidence);
    return {{"content_id", contentId}, {"route", "auto_remove"}, {"rule", score.rule()}, {"evidence", evidence}};
  }
  return queueForHuman(contentId, "weak_evidence");
}
`,
    },
  },
  hints: [
    'Order the branches by trust: call under the deadline, then decide. The error branch is not an afterthought — a timeout, an unavailable classifier or any non-retryable code is a *failure to classify*, so it goes to the human queue. Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are worth another attempt, and a single retry is enough.',
    'An automatic action takes two independent facts: a very high confidence and a corroborating signal. Write the bar as a named constant (`AUTO_REMOVE_CONFIDENCE = 0.98`) and require `corroborates(signal)` alongside it. A confidence of 0.6 is the model saying “probably”, which is a reason to queue, not to remove.',
    'Record the evidence before you return the removal. Score, signal and model version are what let an auditor answer “why was this removed?” six months later, when the model has already been replaced and the score cannot be reproduced.',
  ],
  debrief: `The interviewer is testing whether you treat a classifier as a bounded, fallible dependency rather than an oracle. The draft reads fine because the demo sends clear-cut content to a healthy model. Three defects are being checked: the failure path (a timeout must route to humans, not allow), the retry set (a \`REFUSED\` is a decision, not a transient fault — retrying it is a hot loop), and the evidence bar (a low threshold plus no corroboration means the model alone removes content). Real systems add a canary that shadows auto-actions before they take effect, a per-rule precision dashboard, a review of deleted decisions after a model upgrade, and a hard cap on how much content any single model version may remove.`,
};
