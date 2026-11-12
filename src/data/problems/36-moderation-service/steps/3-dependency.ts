import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Classifier triage that only auto-acts on strong, corroborated evidence',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'model-output', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'classifier', 'redis'],
  task: `## Task

**Starting point.** The starter is the triage a new case goes through:
\`triage(case_id, content_id, text, signals)\` asks the gRPC classifier for a verdict (\`label\`,
\`confidence\`, \`model_version\`), up to three times when a call fails, removes automatically when the
confidence clears \`AUTO_REMOVE_CONFIDENCE\`, queues the case for people (\`queue.enqueue\`) otherwise,
and answers \`no_action\` when the classifier never answers. A decision is
\`{case_id, route, reason, label, confidence, model_version}\`. It serves the demo and hides five
flaws.

\`\`\`proto
service Classifier { rpc Classify(ClassifyRequest) returns (Verdict); }
\`\`\`

**Failure mode the checks target.** A stalled classifier holds every report open; a malformed
request is sent three times; an ordinary post scoring 0.6 is removed; a confident score with
nothing to back it is removed; and an outage lets reported content through untouched.

- Every call carries a **\`DEADLINE_S\` = 0.4 s** deadline.
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried, **\`MAX_ATTEMPTS\` = 2** calls in all.
- \`auto_remove\` needs a confidence of at least **0.98** and one of \`CORROBORATING_SIGNALS\`
  (\`hash_match\`, \`trusted_flagger\`) in \`signals\`.
- Everything else is \`human_review\` and goes to \`queue.enqueue(case_id)\`, including a classifier that
  did not answer (reason \`classifier_unavailable\`).`,
  sequence: {
    participants: ['Moderation API', 'Classifier', 'Review queue'],
    messages: [
      {from: 'Moderation API', to: 'Classifier', label: 'Classify · deadline 400 ms', kind: 'sync'},
      {
        from: 'Classifier',
        to: 'Moderation API',
        label: 'UNAVAILABLE → one retry · INVALID_ARGUMENT → final',
        kind: 'reply',
      },
      {from: 'Classifier', to: 'Moderation API', label: 'Verdict {label, confidence, model_version}', kind: 'reply'},
      {
        from: 'Moderation API',
        to: 'Moderation API',
        label: 'confidence ≥ 0.98 and a corroborating signal?',
        kind: 'sync',
      },
      {
        from: 'Moderation API',
        to: 'Review queue',
        label: 'enqueue(case_id) · weak evidence or no answer',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the classifier under a 400 ms deadline',
      detail:
        'Every `Classify` carries `DEADLINE_S` (0.4 s); the starter sets none, so a stalled classifier holds the report for as long as it stalls.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.4\b/, /Classify\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*400\b/, /Classify\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*400\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineMs\s*=\s*400L?\b/, /withDeadlineAfter\(\s*DeadlineMs/]},
        cpp: {all: [/kDeadline\{400\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED, twice in all',
      detail:
        'A transient code (`UNAVAILABLE`, `DEADLINE_EXCEEDED`) is retried up to `MAX_ATTEMPTS` = 2 calls; any other code is final. The starter retries every failure three times, so a request the classifier rejects is sent again unchanged.',
      match: {
        python: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_ATTEMPTS\s*=\s*2\b/], none: [/\n\s*continue\b/]},
        typescript: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MAX_ATTEMPTS\s*=\s*2\b/], none: [/\bcontinue;/]},
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /maxAttempts\s*=\s*2\b/], none: [/\bcontinue\b/]},
        scala: {
          all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /MaxAttempts\s*=\s*2\b/],
          none: [/case _: StatusRuntimeException\s*=>\s*attempt\s*\+=/],
        },
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /kMaxAttempts\s*=\s*2\b/], none: [/\bcontinue;/]},
      },
    },
    {
      id: 'auto-threshold',
      title: 'Requires 0.98 confidence to act alone',
      detail:
        'An automatic removal needs a confidence of at least `AUTO_REMOVE_CONFIDENCE` = 0.98; the starter acts at 0.6, inside the classifier’s noise, so ordinary posts are removed.',
      match: {
        python: {all: [/AUTO_REMOVE_CONFIDENCE\s*=\s*0\.98\b/], none: [/0\.6\b/]},
        typescript: {all: [/AUTO_REMOVE_CONFIDENCE\s*=\s*0\.98\b/], none: [/0\.6\b/]},
        go: {all: [/autoRemoveConfidence\s*=\s*0\.98\b/], none: [/0\.6\b/]},
        scala: {all: [/AutoRemoveConfidence\s*=\s*0\.98\b/], none: [/0\.6\b/]},
        cpp: {all: [/kAutoRemoveConfidence\s*=\s*0\.98\b/], none: [/0\.6\b/]},
      },
    },
    {
      id: 'corroboration',
      title: 'Acts only with a corroborating signal',
      detail:
        'An automatic removal also needs one of `CORROBORATING_SIGNALS` among the case’s signals; the starter declares the list and does not consult it.',
      match: {
        python: {all: [/\w+ in CORROBORATING_SIGNALS|CORROBORATING_SIGNALS\.(intersection|isdisjoint)\(/]},
        typescript: {all: [/CORROBORATING_SIGNALS\.(includes|has)\(/]},
        go: {all: [/corroboratingSignals\[/]},
        scala: {all: [/CorroboratingSignals\.contains|CorroboratingSignals\.exists|exists\(CorroboratingSignals/]},
        cpp: {all: [/kCorroboratingSignals\.(count|find|contains)\(/]},
      },
    },
    {
      id: 'unavailable-to-human',
      title: 'Routes a classifier failure to people',
      detail:
        'When no verdict comes back the case is queued (`queue.enqueue`) as `human_review` with reason `classifier_unavailable`; the starter answers `no_action` and the reported content stays up unexamined.',
      match: {
        python: {
          all: [/except grpc\.RpcError/, /["']classifier_unavailable["']/, /queue\.enqueue\(/],
          none: [/["']no_action["']/],
        },
        typescript: {all: [/catch\b/, /['"]classifier_unavailable['"]/, /enqueue\(/], none: [/['"]no_action['"]/]},
        go: {all: [/err != nil/, /"classifier_unavailable"/, /queue\.Enqueue\(/], none: [/"no_action"/]},
        scala: {all: [/StatusRuntimeException/, /"classifier_unavailable"/, /Queue\.enqueue\(/], none: [/"no_action"/]},
        cpp: {all: [/"classifier_unavailable"/, /queue::enqueue\(/], none: [/"no_action"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import moderation_service_pb2
import moderation_service_pb2_grpc
from moderation import queue  # queue.enqueue(case_id)

ATTEMPTS = 3
AUTO_REMOVE_CONFIDENCE = 0.6
CORROBORATING_SIGNALS = ("hash_match", "trusted_flagger")

classifier = moderation_service_pb2_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))


def decision(case_id: str, route: str, reason: str, verdict=None) -> dict:
    return {
        "case_id": case_id,
        "route": route,
        "reason": reason,
        "label": verdict.label if verdict else "",
        "confidence": verdict.confidence if verdict else 0.0,
        "model_version": verdict.model_version if verdict else "",
    }


def triage(case_id: str, content_id: str, text: str, signals: list[str]) -> dict:
    """Route a reported item: an automatic removal, or the human review queue."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    verdict = None
    for attempt in range(ATTEMPTS):
        try:
            verdict = classifier.Classify(moderation_service_pb2.ClassifyRequest(content_id=content_id, text=text))
            break
        except grpc.RpcError:
            continue  # the classifier is flaky: ask again
    if verdict is None:
        return decision(case_id, "no_action", "classifier_unavailable")
    if verdict.confidence >= AUTO_REMOVE_CONFIDENCE:
        return decision(case_id, "auto_remove", "confident", verdict)
    queue.enqueue(case_id)
    return decision(case_id, "human_review", "below_threshold", verdict)
`,
      solution: `import grpc

import moderation_service_pb2
import moderation_service_pb2_grpc
from moderation import queue  # queue.enqueue(case_id)

DEADLINE_S = 0.4
MAX_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
AUTO_REMOVE_CONFIDENCE = 0.98
CORROBORATING_SIGNALS = ("hash_match", "trusted_flagger")

classifier = moderation_service_pb2_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))


def decision(case_id: str, route: str, reason: str, verdict=None) -> dict:
    return {
        "case_id": case_id,
        "route": route,
        "reason": reason,
        "label": verdict.label if verdict else "",
        "confidence": verdict.confidence if verdict else 0.0,
        "model_version": verdict.model_version if verdict else "",
    }


def classify(content_id: str, text: str):
    """One verdict: a transient failure is asked again, once; any other code is final."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return classifier.Classify(moderation_service_pb2.ClassifyRequest(content_id=content_id, text=text), timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS:
                raise


def triage(case_id: str, content_id: str, text: str, signals: list[str]) -> dict:
    """Route a reported item: an automatic removal, or the human review queue."""
    try:
        verdict = classify(content_id, text)
    except grpc.RpcError:
        # No verdict is not an all-clear: someone reported this, so a person looks at it.
        queue.enqueue(case_id)
        return decision(case_id, "human_review", "classifier_unavailable")
    if verdict.confidence < AUTO_REMOVE_CONFIDENCE:
        queue.enqueue(case_id)
        return decision(case_id, "human_review", "below_threshold", verdict)
    if not any(signal in CORROBORATING_SIGNALS for signal in signals):
        queue.enqueue(case_id)
        return decision(case_id, "human_review", "uncorroborated", verdict)
    return decision(case_id, "auto_remove", "corroborated", verdict)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {enqueue} from 'moderation/queue';

export const ATTEMPTS = 3;
export const AUTO_REMOVE_CONFIDENCE = 0.6;
export const CORROBORATING_SIGNALS = ['hash_match', 'trusted_flagger'];

interface Verdict {
  label: string;
  confidence: number;
  model_version: string;
}

export interface Decision {
  case_id: string;
  route: string;
  reason: string;
  label: string;
  confidence: number;
  model_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('moderation_service.proto')) as unknown as {
  moderated: {Classifier: grpc.ServiceClientConstructor};
};
const classifier = new pkg.moderated.Classifier('classifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: {content_id: string; text: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Verdict>;
};

function decision(caseId: string, route: string, reason: string, verdict: Verdict | null = null): Decision {
  return {
    case_id: caseId,
    route,
    reason,
    label: verdict?.label ?? '',
    confidence: verdict?.confidence ?? 0,
    model_version: verdict?.model_version ?? '',
  };
}

/** Route a reported item: an automatic removal, or the human review queue. */
export async function triage(caseId: string, contentId: string, text: string, signals: string[]): Promise<Decision> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  let verdict: Verdict | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      verdict = await classifier.Classify({content_id: contentId, text}, new grpc.Metadata(), {});
      break;
    } catch {
      continue; // the classifier is flaky: ask again
    }
  }
  if (verdict === null) return decision(caseId, 'no_action', 'classifier_unavailable');
  if (verdict.confidence >= AUTO_REMOVE_CONFIDENCE) return decision(caseId, 'auto_remove', 'confident', verdict);
  await enqueue(caseId);
  return decision(caseId, 'human_review', 'below_threshold', verdict);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {enqueue} from 'moderation/queue';

export const DEADLINE_MS = 400;
export const MAX_ATTEMPTS = 2;
export const RETRYABLE: grpc.status[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];
export const AUTO_REMOVE_CONFIDENCE = 0.98;
export const CORROBORATING_SIGNALS = ['hash_match', 'trusted_flagger'];

interface Verdict {
  label: string;
  confidence: number;
  model_version: string;
}

export interface Decision {
  case_id: string;
  route: string;
  reason: string;
  label: string;
  confidence: number;
  model_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('moderation_service.proto')) as unknown as {
  moderated: {Classifier: grpc.ServiceClientConstructor};
};
const classifier = new pkg.moderated.Classifier('classifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: {content_id: string; text: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Verdict>;
};

function decision(caseId: string, route: string, reason: string, verdict: Verdict | null = null): Decision {
  return {
    case_id: caseId,
    route,
    reason,
    label: verdict?.label ?? '',
    confidence: verdict?.confidence ?? 0,
    model_version: verdict?.model_version ?? '',
  };
}

/** One verdict: a transient failure is asked again, once; any other code is final. */
async function classify(contentId: string, text: string): Promise<Verdict> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await classifier.Classify({content_id: contentId, text}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      if (!RETRYABLE.includes((e as grpc.ServiceError).code) || attempt === MAX_ATTEMPTS) throw e;
    }
  }
}

/** Route a reported item: an automatic removal, or the human review queue. */
export async function triage(caseId: string, contentId: string, text: string, signals: string[]): Promise<Decision> {
  let verdict: Verdict;
  try {
    verdict = await classify(contentId, text);
  } catch {
    // No verdict is not an all-clear: someone reported this, so a person looks at it.
    await enqueue(caseId);
    return decision(caseId, 'human_review', 'classifier_unavailable');
  }
  if (verdict.confidence < AUTO_REMOVE_CONFIDENCE) {
    await enqueue(caseId);
    return decision(caseId, 'human_review', 'below_threshold', verdict);
  }
  if (!signals.some(signal => CORROBORATING_SIGNALS.includes(signal))) {
    await enqueue(caseId);
    return decision(caseId, 'human_review', 'uncorroborated', verdict);
  }
  return decision(caseId, 'auto_remove', 'corroborated', verdict);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "moderation/gen/moderation_service"
	"moderation/queue" // queue.Enqueue(ctx, caseID)
)

const (
	attempts             = 3
	autoRemoveConfidence = 0.6
)

var corroboratingSignals = map[string]bool{"hash_match": true, "trusted_flagger": true}

var (
	classifierConn, _ = grpc.NewClient("classifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	classifier        = pb.NewClassifierClient(classifierConn)
)

// Decision is where a reported item goes and the evidence behind it.
type Decision struct {
	CaseID       string  \`json:"case_id"\`
	Route        string  \`json:"route"\`
	Reason       string  \`json:"reason"\`
	Label        string  \`json:"label"\`
	Confidence   float64 \`json:"confidence"\`
	ModelVersion string  \`json:"model_version"\`
}

func decide(caseID, route, reason string, verdict *pb.Verdict) Decision {
	d := Decision{CaseID: caseID, Route: route, Reason: reason}
	if verdict != nil {
		d.Label, d.Confidence, d.ModelVersion = verdict.Label, verdict.Confidence, verdict.ModelVersion
	}
	return d
}

// triage routes a reported item: an automatic removal, or the human review queue.
func triage(ctx context.Context, caseID, contentID, text string, signals []string) Decision {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	var verdict *pb.Verdict
	for attempt := 0; attempt < attempts; attempt++ {
		v, err := classifier.Classify(ctx, &pb.ClassifyRequest{ContentId: contentID, Text: text})
		if err != nil {
			continue // the classifier is flaky: ask again
		}
		verdict = v
		break
	}
	if verdict == nil {
		return decide(caseID, "no_action", "classifier_unavailable", nil)
	}
	if verdict.Confidence >= autoRemoveConfidence {
		return decide(caseID, "auto_remove", "confident", verdict)
	}
	queue.Enqueue(ctx, caseID)
	return decide(caseID, "human_review", "below_threshold", verdict)
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

	pb "moderation/gen/moderation_service"
	"moderation/queue" // queue.Enqueue(ctx, caseID)
)

const (
	deadline             = 400 * time.Millisecond
	maxAttempts          = 2
	autoRemoveConfidence = 0.98
)

var corroboratingSignals = map[string]bool{"hash_match": true, "trusted_flagger": true}

var (
	classifierConn, _ = grpc.NewClient("classifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	classifier        = pb.NewClassifierClient(classifierConn)
)

// Decision is where a reported item goes and the evidence behind it.
type Decision struct {
	CaseID       string  \`json:"case_id"\`
	Route        string  \`json:"route"\`
	Reason       string  \`json:"reason"\`
	Label        string  \`json:"label"\`
	Confidence   float64 \`json:"confidence"\`
	ModelVersion string  \`json:"model_version"\`
}

func decide(caseID, route, reason string, verdict *pb.Verdict) Decision {
	d := Decision{CaseID: caseID, Route: route, Reason: reason}
	if verdict != nil {
		d.Label, d.Confidence, d.ModelVersion = verdict.Label, verdict.Confidence, verdict.ModelVersion
	}
	return d
}

// classify gets one verdict: a transient failure is asked again, once; any other code is final.
func classify(ctx context.Context, contentID, text string) (*pb.Verdict, error) {
	var err error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		verdict, callErr := classifier.Classify(callCtx, &pb.ClassifyRequest{ContentId: contentID, Text: text})
		cancel()
		if callErr == nil {
			return verdict, nil
		}
		err = callErr
		if code := status.Code(callErr); code != codes.Unavailable && code != codes.DeadlineExceeded {
			break
		}
	}
	return nil, err
}

func corroborated(signals []string) bool {
	for _, signal := range signals {
		if corroboratingSignals[signal] {
			return true
		}
	}
	return false
}

// triage routes a reported item: an automatic removal, or the human review queue.
func triage(ctx context.Context, caseID, contentID, text string, signals []string) Decision {
	verdict, err := classify(ctx, contentID, text)
	if err != nil {
		// No verdict is not an all-clear: someone reported this, so a person looks at it.
		queue.Enqueue(ctx, caseID)
		return decide(caseID, "human_review", "classifier_unavailable", nil)
	}
	if verdict.Confidence < autoRemoveConfidence {
		queue.Enqueue(ctx, caseID)
		return decide(caseID, "human_review", "below_threshold", verdict)
	}
	if !corroborated(signals) {
		queue.Enqueue(ctx, caseID)
		return decide(caseID, "human_review", "uncorroborated", verdict)
	}
	return decide(caseID, "auto_remove", "corroborated", verdict)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import moderation.Queue // Queue.enqueue(caseId)
import moderated.moderation_service.{ClassifierGrpc, ClassifyRequest, Verdict}

/** Where a reported item goes and the evidence behind it. */
final case class Decision(caseId: String, route: String, reason: String, label: String, confidence: Double, modelVersion: String)

object Client {
  val Attempts = 3
  val AutoRemoveConfidence = 0.6
  val CorroboratingSignals: Set[String] = Set("hash_match", "trusted_flagger")

  private val classifier = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())

  private def decision(caseId: String, route: String, reason: String, verdict: Option[Verdict] = None): Decision =
    Decision(caseId, route, reason, verdict.map(_.label).getOrElse(""), verdict.map(_.confidence).getOrElse(0.0), verdict.map(_.modelVersion).getOrElse(""))

  /** Route a reported item: an automatic removal, or the human review queue. */
  def triage(caseId: String, contentId: String, text: String, signals: Seq[String]): Decision = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    var verdict: Option[Verdict] = None
    var attempt = 0
    while (verdict.isEmpty && attempt < Attempts) {
      try verdict = Some(classifier.classify(ClassifyRequest(contentId, text)))
      catch { case _: StatusRuntimeException => attempt += 1 } // the classifier is flaky: ask again
    }
    verdict match {
      case None => decision(caseId, "no_action", "classifier_unavailable")
      case Some(v) if v.confidence >= AutoRemoveConfidence => decision(caseId, "auto_remove", "confident", Some(v))
      case Some(v) =>
        Queue.enqueue(caseId)
        decision(caseId, "human_review", "below_threshold", Some(v))
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import moderation.Queue // Queue.enqueue(caseId)
import moderated.moderation_service.{ClassifierGrpc, ClassifyRequest, Verdict}

/** Where a reported item goes and the evidence behind it. */
final case class Decision(caseId: String, route: String, reason: String, label: String, confidence: Double, modelVersion: String)

object Client {
  val DeadlineMs = 400L
  val MaxAttempts = 2
  val AutoRemoveConfidence = 0.98
  val CorroboratingSignals: Set[String] = Set("hash_match", "trusted_flagger")
  private val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val classifier = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())

  private def decision(caseId: String, route: String, reason: String, verdict: Option[Verdict] = None): Decision =
    Decision(caseId, route, reason, verdict.map(_.label).getOrElse(""), verdict.map(_.confidence).getOrElse(0.0), verdict.map(_.modelVersion).getOrElse(""))

  /** One verdict: a transient failure is asked again, once; any other code is final. */
  private def classify(contentId: String, text: String, attempt: Int = 1): Verdict =
    try classifier.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).classify(ClassifyRequest(contentId, text))
    catch {
      case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) && attempt < MaxAttempts =>
        classify(contentId, text, attempt + 1)
    }

  /** Route a reported item: an automatic removal, or the human review queue. */
  def triage(caseId: String, contentId: String, text: String, signals: Seq[String]): Decision = {
    val verdict =
      try Some(classify(contentId, text))
      catch { case _: StatusRuntimeException => None }
    verdict match {
      case None =>
        // No verdict is not an all-clear: someone reported this, so a person looks at it.
        Queue.enqueue(caseId)
        decision(caseId, "human_review", "classifier_unavailable")
      case Some(v) if v.confidence < AutoRemoveConfidence =>
        Queue.enqueue(caseId)
        decision(caseId, "human_review", "below_threshold", Some(v))
      case Some(v) if !signals.exists(CorroboratingSignals.contains) =>
        Queue.enqueue(caseId)
        decision(caseId, "human_review", "uncorroborated", Some(v))
      case Some(v) => decision(caseId, "auto_remove", "corroborated", Some(v))
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <optional>
#include <set>
#include <string>
#include <vector>

#include "moderation_service.grpc.pb.h"
#include "moderation/queue.h"  // queue::enqueue(case_id)

constexpr int kAttempts = 3;
constexpr double kAutoRemoveConfidence = 0.6;
const std::set<std::string> kCorroboratingSignals = {"hash_match", "trusted_flagger"};

auto classifier = moderated::Classifier::NewStub(grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials()));

// Where a reported item goes and the evidence behind it.
struct Decision {
  std::string case_id;
  std::string route;
  std::string reason;
  std::string label;
  double confidence = 0;
  std::string model_version;
};

Decision decide(const std::string& case_id, const std::string& route, const std::string& reason,
                const std::optional<moderated::Verdict>& verdict = std::nullopt) {
  Decision d{case_id, route, reason};
  if (verdict) {
    d.label = verdict->label();
    d.confidence = verdict->confidence();
    d.model_version = verdict->model_version();
  }
  return d;
}

// Route a reported item: an automatic removal, or the human review queue.
Decision triage(const std::string& case_id, const std::string& content_id, const std::string& text, const std::vector<std::string>& signals) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  std::optional<moderated::Verdict> verdict;
  for (int attempt = 0; attempt < kAttempts; attempt++) {
    grpc::ClientContext ctx;
    moderated::ClassifyRequest request;
    request.set_content_id(content_id);
    request.set_text(text);
    moderated::Verdict answer;
    if (!classifier->Classify(&ctx, request, &answer).ok()) continue;  // the classifier is flaky: ask again
    verdict = answer;
    break;
  }
  if (!verdict) return decide(case_id, "no_action", "classifier_unavailable");
  if (verdict->confidence() >= kAutoRemoveConfidence) return decide(case_id, "auto_remove", "confident", verdict);
  queue::enqueue(case_id);
  return decide(case_id, "human_review", "below_threshold", verdict);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "moderation_service.grpc.pb.h"
#include "moderation/queue.h"  // queue::enqueue(case_id)

constexpr std::chrono::milliseconds kDeadline{400};
constexpr int kMaxAttempts = 2;
constexpr double kAutoRemoveConfidence = 0.98;
const std::set<std::string> kCorroboratingSignals = {"hash_match", "trusted_flagger"};

auto classifier = moderated::Classifier::NewStub(grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials()));

// Where a reported item goes and the evidence behind it.
struct Decision {
  std::string case_id;
  std::string route;
  std::string reason;
  std::string label;
  double confidence = 0;
  std::string model_version;
};

Decision decide(const std::string& case_id, const std::string& route, const std::string& reason,
                const std::optional<moderated::Verdict>& verdict = std::nullopt) {
  Decision d{case_id, route, reason};
  if (verdict) {
    d.label = verdict->label();
    d.confidence = verdict->confidence();
    d.model_version = verdict->model_version();
  }
  return d;
}

// One verdict: a transient failure is asked again, once; any other code is final.
std::optional<moderated::Verdict> classify(const std::string& content_id, const std::string& text) {
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    moderated::ClassifyRequest request;
    request.set_content_id(content_id);
    request.set_text(text);
    moderated::Verdict verdict;
    const grpc::Status status = classifier->Classify(&ctx, request, &verdict);
    if (status.ok()) return verdict;
    const grpc::StatusCode code = status.error_code();
    if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED) break;
  }
  return std::nullopt;
}

bool corroborated(const std::vector<std::string>& signals) {
  for (const std::string& signal : signals) {
    if (kCorroboratingSignals.count(signal)) return true;
  }
  return false;
}

// Route a reported item: an automatic removal, or the human review queue.
Decision triage(const std::string& case_id, const std::string& content_id, const std::string& text, const std::vector<std::string>& signals) {
  const auto verdict = classify(content_id, text);
  if (!verdict) {
    // No verdict is not an all-clear: someone reported this, so a person looks at it.
    queue::enqueue(case_id);
    return decide(case_id, "human_review", "classifier_unavailable");
  }
  if (verdict->confidence() < kAutoRemoveConfidence) {
    queue::enqueue(case_id);
    return decide(case_id, "human_review", "below_threshold", verdict);
  }
  if (!corroborated(signals)) {
    queue::enqueue(case_id);
    return decide(case_id, "human_review", "uncorroborated", verdict);
  }
  return decide(case_id, "auto_remove", "corroborated", verdict);
}
`,
    },
  },
  harness: {
    python: `import grpc

import moderation_service_pb2
import moderation_service_pb2_grpc

PENDING = "moderation:pending"


class Classifier(moderation_service_pb2_grpc.ClassifierServicer):
    """Labels everything spam, with the confidence the check set per content id (0.5 by default)."""

    def __init__(self):
        self.scores = {}

    def Classify(self, request, context):
        return moderation_service_pb2.Verdict(label="spam", confidence=self.scores.get(request.content_id, 0.5), model_version="clf-2026-10")


def _client(ctx):
    peer = Classifier()
    ctx.grpc.serve(moderation_service_pb2_grpc.add_ClassifierServicer_to_server, peer)
    return ctx.load("client"), peer


def _queued(ctx):
    return ctx.redis.zrange(PENDING, 0, -1)


def check_deadline(ctx):
    m, _ = _client(ctx)
    m.triage("case-1", "c-1", "Buy followers now", [])
    calls = ctx.grpc.calls_to("Classify")
    assert calls, "no Classify call was made"
    for call in calls:
        assert call.timeout is not None, "a Classify call carries no deadline: a stalled classifier holds the report open as long as it stalls"
        assert 0.35 <= call.timeout <= 0.45, f"a Classify call carries a {call.timeout} s deadline, expected DEADLINE_S = 0.4"
    ctx.grpc.set_latency("Classify", 5.0)
    d = m.triage("case-2", "c-2", "Buy followers now", ["hash_match"])
    assert d["route"] == "human_review" and d["reason"] == "classifier_unavailable", f"with the classifier taking 5 s triage answered {d}, expected human_review for classifier_unavailable"


def check_retry_policy(ctx):
    m, peer = _client(ctx)
    ctx.grpc.fail("Classify", grpc.StatusCode.INVALID_ARGUMENT, "text is empty")
    d = m.triage("case-1", "c-1", "", [])
    calls = len(ctx.grpc.calls_to("Classify"))
    assert calls == 1, f"a request the classifier answered INVALID_ARGUMENT was sent {calls} times: the code says the request is wrong, a retry gets the same answer"
    assert d["route"] == "human_review", f"an unclassifiable item was routed {d['route']}, expected human_review"
    peer.scores["c-2"] = 0.3
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE)
    d = m.triage("case-2", "c-2", "hello", [])
    calls = len(ctx.grpc.calls_to("Classify"))
    assert calls == 3, f"one UNAVAILABLE must be retried once: {calls - 1} calls were made for case-2, expected 2"
    assert d["confidence"] == 0.3 and d["reason"] == "below_threshold", f"the retry's verdict must decide case-2, got {d}"
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE, times=5)
    m.triage("case-3", "c-3", "hello", [])
    calls = len(ctx.grpc.calls_to("Classify"))
    assert calls == 5, f"a classifier that stays unavailable must be asked MAX_ATTEMPTS = 2 times, it was asked {calls - 3}"


def check_auto_threshold(ctx):
    m, peer = _client(ctx)
    peer.scores.update({"c-1": 0.9, "c-2": 0.985})
    d = m.triage("case-1", "c-1", "Buy followers now", ["hash_match"])
    assert d["route"] == "human_review", f"a 0.9 score with a hash match was routed {d['route']}: an automatic removal needs at least 0.98"
    assert _queued(ctx) == ["case-1"], f"case-1 must wait for a person, moderation:pending holds {_queued(ctx)}"
    d = m.triage("case-2", "c-2", "Buy followers now", ["hash_match"])
    assert d["route"] == "auto_remove", f"a 0.985 score with a hash match was routed {d['route']}, expected auto_remove"
    assert (d["label"], d["confidence"], d["model_version"]) == ("spam", 0.985, "clf-2026-10"), f"an automatic removal must carry the verdict as its evidence, got {d}"
    assert _queued(ctx) == ["case-1"], f"an automatic removal must not also be queued, moderation:pending holds {_queued(ctx)}"


def check_corroboration(ctx):
    m, peer = _client(ctx)
    peer.scores["c-1"] = 0.99
    alone = m.triage("case-1", "c-1", "Buy followers now", [])
    weak = m.triage("case-2", "c-1", "Buy followers now", ["user_report"])
    backed = m.triage("case-3", "c-1", "Buy followers now", ["user_report", "trusted_flagger"])
    assert alone["route"] == "human_review", f"a 0.99 score with no signal was routed {alone['route']}: an automatic removal needs a corroborating signal"
    assert weak["route"] == "human_review", f"a 0.99 score with only a user report was routed {weak['route']}: user_report is not in CORROBORATING_SIGNALS"
    assert backed["route"] == "auto_remove", f"a 0.99 score with a trusted flagger was routed {backed['route']}, expected auto_remove"
    assert _queued(ctx) == ["case-1", "case-2"], f"moderation:pending holds {_queued(ctx)}, expected the two uncorroborated cases"


def check_unavailable_to_human(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE, times=10)
    d = m.triage("case-1", "c-1", "Buy followers now", ["hash_match"])
    assert d["route"] == "human_review" and d["reason"] == "classifier_unavailable", f"with the classifier down triage answered {d}: a report nobody classified must go to a person"
    assert _queued(ctx) == ["case-1"], f"moderation:pending holds {_queued(ctx)}, expected case-1"
    assert ctx.redis.hget("moderation:counters", "pending") == "1", "the queued case must be counted as pending"
`,
    typescript: `const PENDING = 'moderation:pending';

/** The classifier labels everything spam, with the confidence the check set per content id (0.5 by default). */
function client(ctx) {
  const pkg = ctx.proto('moderation_service.proto');
  const scores = new Map<string, number>();
  ctx.grpc.serve(pkg.moderated.Classifier.service, {
    Classify(call, callback) {
      callback(null, {label: 'spam', confidence: scores.get(call.request.content_id) ?? 0.5, model_version: 'clf-2026-10'});
    },
  });
  return {m: ctx.load('client'), scores};
}

const queued = (ctx): string[] => ctx.redis.zrange(PENDING, 0, -1);

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  await m.triage('case-1', 'c-1', 'Buy followers now', []);
  const calls = ctx.grpc.callsTo('Classify');
  assert(calls.length > 0, 'no Classify call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'a Classify call carries no deadline: a stalled classifier holds the report open as long as it stalls');
    assert(0.35 <= call.timeout && call.timeout <= 0.45, \`a Classify call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 400\`);
  }
  ctx.grpc.setLatency('Classify', 5.0);
  const d = await m.triage('case-2', 'c-2', 'Buy followers now', ['hash_match']);
  assert(d.route === 'human_review' && d.reason === 'classifier_unavailable', \`with the classifier taking 5 s triage answered \${JSON.stringify(d)}, expected human_review for classifier_unavailable\`);
}

export async function check_retry_policy(ctx) {
  const {m, scores} = client(ctx);
  ctx.grpc.fail('Classify', ctx.grpc.status.INVALID_ARGUMENT, 'text is empty');
  let d = await m.triage('case-1', 'c-1', '', []);
  let calls = ctx.grpc.callsTo('Classify').length;
  assert.equal(calls, 1, \`a request the classifier answered INVALID_ARGUMENT was sent \${calls} times: the code says the request is wrong, a retry gets the same answer\`);
  assert.equal(d.route, 'human_review', \`an unclassifiable item was routed \${d.route}, expected human_review\`);
  scores.set('c-2', 0.3);
  ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE);
  d = await m.triage('case-2', 'c-2', 'hello', []);
  calls = ctx.grpc.callsTo('Classify').length;
  assert.equal(calls, 3, \`one UNAVAILABLE must be retried once: \${calls - 1} calls were made for case-2, expected 2\`);
  assert(d.confidence === 0.3 && d.reason === 'below_threshold', \`the retry's verdict must decide case-2, got \${JSON.stringify(d)}\`);
  ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE, '', 5);
  await m.triage('case-3', 'c-3', 'hello', []);
  calls = ctx.grpc.callsTo('Classify').length;
  assert.equal(calls, 5, \`a classifier that stays unavailable must be asked MAX_ATTEMPTS = 2 times, it was asked \${calls - 3}\`);
}

export async function check_auto_threshold(ctx) {
  const {m, scores} = client(ctx);
  scores.set('c-1', 0.9);
  scores.set('c-2', 0.985);
  let d = await m.triage('case-1', 'c-1', 'Buy followers now', ['hash_match']);
  assert.equal(d.route, 'human_review', \`a 0.9 score with a hash match was routed \${d.route}: an automatic removal needs at least 0.98\`);
  assert.deepStrictEqual(queued(ctx), ['case-1'], \`case-1 must wait for a person, moderation:pending holds \${JSON.stringify(queued(ctx))}\`);
  d = await m.triage('case-2', 'c-2', 'Buy followers now', ['hash_match']);
  assert.equal(d.route, 'auto_remove', \`a 0.985 score with a hash match was routed \${d.route}, expected auto_remove\`);
  assert(d.label === 'spam' && d.confidence === 0.985 && d.model_version === 'clf-2026-10', \`an automatic removal must carry the verdict as its evidence, got \${JSON.stringify(d)}\`);
  assert.deepStrictEqual(queued(ctx), ['case-1'], \`an automatic removal must not also be queued, moderation:pending holds \${JSON.stringify(queued(ctx))}\`);
}

export async function check_corroboration(ctx) {
  const {m, scores} = client(ctx);
  scores.set('c-1', 0.99);
  const alone = await m.triage('case-1', 'c-1', 'Buy followers now', []);
  const weak = await m.triage('case-2', 'c-1', 'Buy followers now', ['user_report']);
  const backed = await m.triage('case-3', 'c-1', 'Buy followers now', ['user_report', 'trusted_flagger']);
  assert.equal(alone.route, 'human_review', \`a 0.99 score with no signal was routed \${alone.route}: an automatic removal needs a corroborating signal\`);
  assert.equal(weak.route, 'human_review', \`a 0.99 score with only a user report was routed \${weak.route}: user_report is not in CORROBORATING_SIGNALS\`);
  assert.equal(backed.route, 'auto_remove', \`a 0.99 score with a trusted flagger was routed \${backed.route}, expected auto_remove\`);
  assert.deepStrictEqual(queued(ctx), ['case-1', 'case-2'], \`moderation:pending holds \${JSON.stringify(queued(ctx))}, expected the two uncorroborated cases\`);
}

export async function check_unavailable_to_human(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE, '', 10);
  const d = await m.triage('case-1', 'c-1', 'Buy followers now', ['hash_match']);
  assert(d.route === 'human_review' && d.reason === 'classifier_unavailable', \`with the classifier down triage answered \${JSON.stringify(d)}: a report nobody classified must go to a person\`);
  assert.deepStrictEqual(queued(ctx), ['case-1'], \`moderation:pending holds \${JSON.stringify(queued(ctx))}, expected case-1\`);
  assert.equal(ctx.redis.hget('moderation:counters', 'pending'), '1', 'the queued case must be counted as pending');
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	pb "moderation/gen/moderation_service"

	"leetbuild/harness"
)

var clientBg = context.Background()

// classifierPeer labels everything spam, with the confidence the check set per content id (0.5 by default).
type classifierPeer struct {
	pb.UnimplementedClassifierServer
	scores map[string]float64
}

func (p *classifierPeer) Classify(_ context.Context, req *pb.ClassifyRequest) (*pb.Verdict, error) {
	score, ok := p.scores[req.GetContentId()]
	if !ok {
		score = 0.5
	}
	return &pb.Verdict{Label: "spam", Confidence: score, ModelVersion: "clf-2026-10"}, nil
}

func clientPeer(ctx *harness.Ctx) *classifierPeer {
	peer := &classifierPeer{scores: map[string]float64{}}
	pb.RegisterClassifierServer(ctx.GRPC.Server(""), peer)
	return peer
}

func clientQueued(ctx *harness.Ctx) []string {
	var out []string
	for _, z := range ctx.Redis.ZRangeWithScores("moderation:pending", 0, -1) {
		out = append(out, z.Member)
	}
	return out
}

func CheckDeadline(ctx *harness.Ctx) {
	clientPeer(ctx)
	triage(clientBg, "case-1", "c-1", "Buy followers now", nil)
	calls := ctx.GRPC.CallsTo("Classify", "")
	ctx.Assert(len(calls) > 0, "no Classify call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Classify call carries no deadline: a stalled classifier holds the report open as long as it stalls")
		ctx.Assert(350*time.Millisecond <= call.Timeout && call.Timeout <= 450*time.Millisecond, "a Classify call carries a %v deadline, expected 400 ms", call.Timeout)
	}
	ctx.GRPC.SetLatency("Classify", 5.0, "")
	d := triage(clientBg, "case-2", "c-2", "Buy followers now", []string{"hash_match"})
	ctx.Assert(d.Route == "human_review" && d.Reason == "classifier_unavailable", "with the classifier taking 5 s triage answered %+v, expected human_review for classifier_unavailable", d)
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	peer := clientPeer(ctx)
	ctx.GRPC.Fail("Classify", codes.InvalidArgument, "text is empty", 1, "")
	d := triage(clientBg, "case-1", "c-1", "", nil)
	calls := len(ctx.GRPC.CallsTo("Classify", ""))
	ctx.Equal(calls, 1, "a request the classifier answered INVALID_ARGUMENT must be sent once: the code says the request is wrong, a retry gets the same answer; the calls")
	ctx.Equal(d.Route, "human_review", "an unclassifiable item's route")
	peer.scores["c-2"] = 0.3
	ctx.GRPC.Fail("Classify", codes.Unavailable, "", 1, "")
	d = triage(clientBg, "case-2", "c-2", "hello", nil)
	calls = len(ctx.GRPC.CallsTo("Classify", ""))
	ctx.Equal(calls-1, 2, "one UNAVAILABLE must be retried once; the calls for case-2")
	ctx.Assert(d.Confidence == 0.3 && d.Reason == "below_threshold", "the retry's verdict must decide case-2, got %+v", d)
	ctx.GRPC.Fail("Classify", codes.Unavailable, "", 5, "")
	triage(clientBg, "case-3", "c-3", "hello", nil)
	calls = len(ctx.GRPC.CallsTo("Classify", ""))
	ctx.Equal(calls-3, 2, "a classifier that stays unavailable must be asked maxAttempts = 2 times; the calls for case-3")
}

func CheckAutoThreshold(ctx *harness.Ctx) {
	peer := clientPeer(ctx)
	peer.scores["c-1"] = 0.9
	peer.scores["c-2"] = 0.985
	d := triage(clientBg, "case-1", "c-1", "Buy followers now", []string{"hash_match"})
	ctx.Equal(d.Route, "human_review", "a 0.9 score with a hash match: an automatic removal needs at least 0.98; the route")
	ctx.Equal(clientQueued(ctx), []string{"case-1"}, "case-1 must wait for a person; moderation:pending")
	d = triage(clientBg, "case-2", "c-2", "Buy followers now", []string{"hash_match"})
	ctx.Equal(d.Route, "auto_remove", "a 0.985 score with a hash match; the route")
	ctx.Assert(d.Label == "spam" && d.Confidence == 0.985 && d.ModelVersion == "clf-2026-10", "an automatic removal must carry the verdict as its evidence, got %+v", d)
	ctx.Equal(clientQueued(ctx), []string{"case-1"}, "an automatic removal must not also be queued; moderation:pending")
}

func CheckCorroboration(ctx *harness.Ctx) {
	peer := clientPeer(ctx)
	peer.scores["c-1"] = 0.99
	alone := triage(clientBg, "case-1", "c-1", "Buy followers now", nil)
	weak := triage(clientBg, "case-2", "c-1", "Buy followers now", []string{"user_report"})
	backed := triage(clientBg, "case-3", "c-1", "Buy followers now", []string{"user_report", "trusted_flagger"})
	ctx.Equal(alone.Route, "human_review", "a 0.99 score with no signal: an automatic removal needs a corroborating signal; the route")
	ctx.Equal(weak.Route, "human_review", "a 0.99 score with only a user report (user_report is not in corroboratingSignals); the route")
	ctx.Equal(backed.Route, "auto_remove", "a 0.99 score with a trusted flagger; the route")
	ctx.Equal(clientQueued(ctx), []string{"case-1", "case-2"}, "moderation:pending must hold the two uncorroborated cases")
}

func CheckUnavailableToHuman(ctx *harness.Ctx) {
	clientPeer(ctx)
	ctx.GRPC.Fail("Classify", codes.Unavailable, "", 10, "")
	d := triage(clientBg, "case-1", "c-1", "Buy followers now", []string{"hash_match"})
	ctx.Assert(d.Route == "human_review" && d.Reason == "classifier_unavailable", "with the classifier down triage answered %+v: a report nobody classified must go to a person", d)
	ctx.Equal(clientQueued(ctx), []string{"case-1"}, "moderation:pending")
	pending, _ := ctx.Redis.HGet("moderation:counters", "pending")
	ctx.Equal(pending, "1", "the queued case must be counted as pending")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

namespace {

// Labels everything spam, with the confidence the check set per content id (0.5 by default).
class ClassifierPeer final : public moderated::Classifier::Service {
 public:
  std::map<std::string, double> scores;
  grpc::Status Classify(grpc::ServerContext*, const moderated::ClassifyRequest* req, moderated::Verdict* out) override {
    out->set_label("spam");
    out->set_confidence(scores.count(req->content_id()) ? scores.at(req->content_id()) : 0.5);
    out->set_model_version("clf-2026-10");
    return grpc::Status::OK;
  }
};

ClassifierPeer& clientPeer(harness::Ctx& ctx) {
  static ClassifierPeer* peer = nullptr;
  delete peer;
  peer = new ClassifierPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::vector<std::string> clientQueued(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& z : ctx.Redis.ZRangeWithScores("moderation:pending", 0, -1)) out.push_back(z.Member);
  return out;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientPeer(ctx);
  triage("case-1", "c-1", "Buy followers now", {});
  const auto calls = ctx.GRPC.CallsTo("Classify");
  ctx.Assert(!calls.empty(), "no Classify call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Classify call carries no deadline: a stalled classifier holds the report open as long as it stalls");
    ctx.Assert(0.35 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.45, "a Classify call carries a %v s deadline, expected kDeadline = 400 ms", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Classify", 5.0);
  const Decision d = triage("case-2", "c-2", "Buy followers now", {"hash_match"});
  ctx.Assert(d.route == "human_review" && d.reason == "classifier_unavailable",
             "with the classifier taking 5 s triage answered route %q reason %q, expected human_review for classifier_unavailable", d.route, d.reason);
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  ClassifierPeer& peer = clientPeer(ctx);
  ctx.GRPC.Fail("Classify", grpc::StatusCode::INVALID_ARGUMENT, "text is empty");
  Decision d = triage("case-1", "c-1", "", {});
  size_t calls = ctx.GRPC.CallsTo("Classify").size();
  ctx.Equal(calls, 1, "a request the classifier answered INVALID_ARGUMENT must be sent once: the code says the request is wrong, a retry gets the same answer; the calls");
  ctx.Equal(d.route, "human_review", "an unclassifiable item's route");
  peer.scores["c-2"] = 0.3;
  ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE);
  d = triage("case-2", "c-2", "hello", {});
  calls = ctx.GRPC.CallsTo("Classify").size();
  ctx.Equal(calls - 1, 2, "one UNAVAILABLE must be retried once; the calls for case-2");
  ctx.Assert(d.confidence == 0.3 && d.reason == "below_threshold", "the retry's verdict must decide case-2, got confidence %v reason %q", d.confidence, d.reason);
  ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE, "", 5);
  triage("case-3", "c-3", "hello", {});
  calls = ctx.GRPC.CallsTo("Classify").size();
  ctx.Equal(calls - 3, 2, "a classifier that stays unavailable must be asked kMaxAttempts = 2 times; the calls for case-3");
}

void CheckAutoThreshold(harness::Ctx& ctx) {
  ClassifierPeer& peer = clientPeer(ctx);
  peer.scores["c-1"] = 0.9;
  peer.scores["c-2"] = 0.985;
  Decision d = triage("case-1", "c-1", "Buy followers now", {"hash_match"});
  ctx.Equal(d.route, "human_review", "a 0.9 score with a hash match: an automatic removal needs at least 0.98; the route");
  ctx.Equal(clientQueued(ctx), std::vector<std::string>{"case-1"}, "case-1 must wait for a person; moderation:pending");
  d = triage("case-2", "c-2", "Buy followers now", {"hash_match"});
  ctx.Equal(d.route, "auto_remove", "a 0.985 score with a hash match; the route");
  ctx.Assert(d.label == "spam" && d.confidence == 0.985 && d.model_version == "clf-2026-10",
             "an automatic removal must carry the verdict as its evidence, got label %q confidence %v model %q", d.label, d.confidence, d.model_version);
  ctx.Equal(clientQueued(ctx), std::vector<std::string>{"case-1"}, "an automatic removal must not also be queued; moderation:pending");
}

void CheckCorroboration(harness::Ctx& ctx) {
  ClassifierPeer& peer = clientPeer(ctx);
  peer.scores["c-1"] = 0.99;
  const Decision alone = triage("case-1", "c-1", "Buy followers now", {});
  const Decision weak = triage("case-2", "c-1", "Buy followers now", {"user_report"});
  const Decision backed = triage("case-3", "c-1", "Buy followers now", {"user_report", "trusted_flagger"});
  ctx.Equal(alone.route, "human_review", "a 0.99 score with no signal: an automatic removal needs a corroborating signal; the route");
  ctx.Equal(weak.route, "human_review", "a 0.99 score with only a user report (user_report is not in kCorroboratingSignals); the route");
  ctx.Equal(backed.route, "auto_remove", "a 0.99 score with a trusted flagger; the route");
  ctx.Equal(clientQueued(ctx), std::vector<std::string>{"case-1", "case-2"}, "moderation:pending must hold the two uncorroborated cases");
}

void CheckUnavailableToHuman(harness::Ctx& ctx) {
  clientPeer(ctx);
  ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE, "", 10);
  const Decision d = triage("case-1", "c-1", "Buy followers now", {"hash_match"});
  ctx.Assert(d.route == "human_review" && d.reason == "classifier_unavailable",
             "with the classifier down triage answered route %q reason %q: a report nobody classified must go to a person", d.route, d.reason);
  ctx.Equal(clientQueued(ctx), std::vector<std::string>{"case-1"}, "moderation:pending");
  ctx.Equal(ctx.Redis.HGet("moderation:counters", "pending").value_or(""), "1", "the queued case must be counted as pending");
}
`,
  },
  hints: [
    'Make the classifier slow: triage waits as long as it takes. Take it down: the reported post gets `no_action` and stays up. Score a post 0.7: it is removed without anyone looking.',
    'The call has no deadline; the loop retries every error alike, including codes that say the request itself is wrong; the bar sits in the classifier’s noise and nothing reads `signals`; the failure branch returns instead of queueing.',
    'Pass `timeout=DEADLINE_S`; retry only when `exc.code()` is in `(UNAVAILABLE, DEADLINE_EXCEEDED)`, at most `MAX_ATTEMPTS` calls; set the bar to 0.98 and require a signal in `CORROBORATING_SIGNALS`; on failure `queue.enqueue(case_id)` and answer `human_review`.',
  ],
  debrief: `The classifier is advice under a deadline, so the client bounds the wait and knows which failures deserve a second call: \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` say nothing about the request, while \`INVALID_ARGUMENT\` will say the same thing again. An automatic removal acts on someone's post with no person involved, so it takes a score far outside the model's noise and an independent signal, such as a hash match against known material. When the model cannot answer, the default is a person: the report already says someone saw a problem. Production triage stores the model version and score with every decision so removals can be audited after a model change, and tunes the bar per policy area, since a spam miss and a self-harm miss cost differently.`,
};
