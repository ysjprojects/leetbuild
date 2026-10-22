import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls with a rules fallback and no silent safe label',
  concept: 'grpc',
  file: 'client',
  focus: ['classifier', 'model', 'rules'],
  task: `## Task

The starter is a plausible model-generated draft: when the model is healthy it returns labels, so the
demo passes. Every failure path is wrong. Find the flaws, fix them, and prove the fix.

Implement \`classify(text, taxonomy_version)\` for the classifier's model layer:

- Each model call carries a **700 ms** deadline — a call timeout, a context with timeout,
  \`withDeadlineAfter\`, \`set_deadline\` or \`deadline: Date.now() + DEADLINE_MS\`. A call without one
  lets one stuck model pin the worker indefinitely.
- At most **3 attempts**, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` may be retried. A
  **refusal** is a decision, not a failure: it is **terminal** and must never be retried to the
  deadline.
- When the model cannot answer, classify with the **deterministic keyword rules** instead of passing
  the outage through, and mark the result with its **provenance** (\`model\` or \`fallback\`).
- **Never** return a safe label with no evidence behind it. A rules pass that matches no rule
  produces the **review** bucket, not an unexamined classification the pipeline downstream treats as
  real.
- Metrics count the fallback path **separately** from real classifications
  (\`classifier_fallback_total\`), so a model outage is visible as a spike and not as a quiet drop in
  quality.

**Failure mode the checks target.** Catching every failure and answering \`safe\` launders an outage
past review: nothing downstream can tell a real classification from a shrug. Retrying a refusal
wastes the deadline on a decision that will not change. And a fallback result without provenance
makes a rules guess indistinguishable from a model answer in the data, so nobody can ever measure
whether the fallback is any good.`,
  sequence: {
    participants: ['Content Classifier', 'Model', 'Rules fallback', 'metrics'],
    messages: [
      {
        from: 'Content Classifier',
        to: 'Content Classifier',
        label: 'bounded attempts · only UNAVAILABLE / DEADLINE_EXCEEDED retried',
        kind: 'sync',
      },
      {from: 'Content Classifier', to: 'Model', label: 'Classify(text) · deadline 700 ms · attempt ≤ 3', kind: 'sync'},
      {from: 'Model', to: 'Content Classifier', label: 'labels / REFUSED / UNAVAILABLE', kind: 'reply'},
      {
        from: 'Content Classifier',
        to: 'Content Classifier',
        label: 'refusal is terminal → fallback now, do not retry',
        kind: 'sync',
      },
      {from: 'Content Classifier', to: 'Rules fallback', label: 'rulesClassify(text) · deterministic', kind: 'sync'},
      {from: 'Rules fallback', to: 'Content Classifier', label: 'keyword labels or review bucket', kind: 'reply'},
      {from: 'Content Classifier', to: 'metrics', label: 'classifier_fallback_total + 1', kind: 'async'},
      {
        from: 'Content Classifier',
        to: 'Content Classifier',
        label: 'result carries provenance: model / fallback',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every model call carries a 700 ms deadline',
      detail:
        'The call is created with a 700 ms deadline — `timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`. Without it a stuck model holds the request open indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.7/, /timeout=DEADLINE_S/, /\.Classify\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*700/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Classify\(/]},
        go: {all: [/deadlineMS\s*=\s*700/, /context\.WithTimeout/, /\.Classify\(/]},
        scala: {all: [/DeadlineMs\s*=\s*700/, /withDeadlineAfter/, /\.classify\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*700/, /set_deadline\(/, /->Classify\(/]},
      },
    },
    {
      id: 'provenance',
      title: 'Fallback results carry their provenance and count separately',
      detail:
        'A result is labelled `model` or `fallback`, and the fallback path increments `classifier_fallback_total`. Without the marker a rules guess is indistinguishable from a model answer; without the counter the outage is invisible.',
      match: {
        python: {all: [/PROVENANCE_MODEL/, /PROVENANCE_FALLBACK/, /FALLBACK_METRIC/]},
        typescript: {all: [/PROVENANCE_MODEL/, /PROVENANCE_FALLBACK/, /FALLBACK_METRIC/]},
        go: {all: [/provenanceModel/, /provenanceFallback/, /fallbackMetric/]},
        scala: {all: [/ProvenanceModel/, /ProvenanceFallback/, /FallbackMetric/]},
        cpp: {all: [/kProvenanceModel/, /kProvenanceFallback/, /kFallbackMetric/]},
      },
    },
    {
      id: 'rules-fallback',
      title: 'Falls back to the deterministic keyword rules',
      detail:
        'When the model cannot answer, a keyword rules pass produces the labels instead of the failure propagating. The draft has nothing to fall back to and answers a constant.',
      match: {
        python: {all: [/def rules_classify\(/, /KEYWORD_RULES/]},
        typescript: {all: [/function rulesClassify\(/, /KEYWORD_RULES/]},
        go: {all: [/func rulesClassify\(/, /keywordRules/]},
        scala: {all: [/def rulesClassify\(/, /KeywordRules/]},
        cpp: {all: [/rulesClassify\(/, /kKeywordRules/]},
      },
    },
    {
      id: 'refusal-terminal',
      title: 'A refusal is terminal, attempts are bounded',
      detail:
        'A refusal stops the retry loop immediately and only `UNAVAILABLE`/`DEADLINE_EXCEEDED` are attempted again, bounded by `MAX_ATTEMPTS = 3`. The draft retries a refusal until the deadline.',
      match: {
        python: {all: [/REFUSAL/, /MAX_ATTEMPTS\s*=\s*3/], none: [/while\s+True/]},
        typescript: {all: [/REFUSAL/, /MAX_ATTEMPTS\s*=\s*3/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/refusal/, /maxAttempts\s*=\s*3/, /status\.FromError\(/], none: [/for\s*\{/]},
        scala: {all: [/Refusal/, /MaxAttempts\s*=\s*3/], none: [/while\s*\(/]},
        cpp: {all: [/kRefusal/, /kMaxAttempts\s*=\s*3/], none: [/while\s*\(true\)/]},
      },
    },
    {
      id: 'no-safe-default',
      title: 'Never answers a safe label with no evidence',
      detail:
        'A failure never produces an unevidenced constant: the rules pass returns real keyword labels or the review bucket. The draft answers `safe` and the pipeline treats it as a real classification.',
      match: {
        python: {all: [/REVIEW_LABEL/], none: [/["']safe["']/]},
        typescript: {all: [/REVIEW_LABEL/], none: [/['"]safe['"]/]},
        go: {all: [/reviewLabel/], none: [/"safe"/]},
        scala: {all: [/ReviewLabel/], none: [/"safe"/]},
        cpp: {all: [/kReviewLabel/], none: [/"safe"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import providers_pb2
import providers_pb2_grpc

channel = grpc.insecure_channel("models:9000")
models = providers_pb2_grpc.ClassifierStub(channel)


def classify(text: str, taxonomy_version: str) -> dict:
    # TODO: this draft retries a refusal until the deadline and maps every failure to the label
    # "safe" with no provenance, so an outage launders everything past review. It also calls the
    # model with no deadline at all. Review it.
    while True:
        try:
            reply = models.Classify(providers_pb2.ClassifyRequest(text=text))
            return {"labels": list(reply.labels), "provenance": "model", "model_version": reply.model_version}
        except grpc.RpcError:
            return {"labels": ["safe"], "provenance": "model", "model_version": "none"}
`,
      solution: `import grpc

import providers_pb2
import providers_pb2_grpc

channel = grpc.insecure_channel("models:9000")
models = providers_pb2_grpc.ClassifierStub(channel)

DEADLINE_S = 0.7
MAX_ATTEMPTS = 3
REFUSAL = "REFUSED"
RETRYABLE = ("UNAVAILABLE", "DEADLINE_EXCEEDED")
PROVENANCE_MODEL = "model"
PROVENANCE_FALLBACK = "fallback"
FALLBACK_METRIC = "classifier_fallback_total"
REVIEW_LABEL = "review"

KEYWORD_RULES = {
    "billing": ("invoice", "refund", "charge"),
    "support": ("broken", "error", "crash"),
    "security": ("password", "breach", "phishing"),
}


def rules_classify(text: str) -> list[str]:
    """Deterministic fallback: keyword evidence only, never a label without support behind it."""
    lowered = text.lower()
    labels = [label for label, keywords in KEYWORD_RULES.items() if any(word in lowered for word in keywords)]
    return labels or [REVIEW_LABEL]


def classify(text: str, taxonomy_version: str) -> dict:
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = models.Classify(providers_pb2.ClassifyRequest(text=text), timeout=DEADLINE_S)
            return {
                "labels": list(reply.labels),
                "provenance": PROVENANCE_MODEL,
                "model_version": reply.model_version,
                "taxonomy_version": taxonomy_version,
            }
        except grpc.RpcError as err:
            status = err.code().name if err.code() is not None else "UNKNOWN"
            if status == REFUSAL:
                break  # terminal: a refusal is the model's answer, retrying it only burns the deadline
            if status not in RETRYABLE:
                break
    metrics.inc(FALLBACK_METRIC)
    return {
        "labels": rules_classify(text),
        "provenance": PROVENANCE_FALLBACK,
        "model_version": "rules",
        "taxonomy_version": taxonomy_version,
    }
`,
    },
    typescript: {
      starter: `/** gRPC model client: a model-generated draft that hides outages behind a constant label. */
import * as grpc from '@grpc/grpc-js';

import {ClassifierClient} from './gen/classifier_grpc_pb';
import {ClassifyRequest} from './gen/classifier_pb';

const client = new ClassifierClient('models:9000', grpc.credentials.createInsecure());

// TODO: this draft retries a refusal until the deadline and maps every failure to the label "safe"
// with no provenance, so an outage launders everything past review. It also calls the model with
// no deadline at all. Review it.
export async function classify(text: string, taxonomyVersion: string): Promise<Result> {
  while (true) {
    try {
      const reply = await new Promise<ClassifyReply>((resolve, reject) => {
        client.Classify(new ClassifyRequest().setText(text), (err, value) => (err ? reject(err) : resolve(value)));
      });
      return {labels: reply.getLabelsList(), provenance: 'model', modelVersion: reply.getModelVersion()};
    } catch (err) {
      return {labels: ['safe'], provenance: 'model', modelVersion: 'none'};
    }
  }
}
`,
      solution: `/** gRPC model client: a 700 ms deadline, a terminal refusal and a deterministic rules fallback. */
import * as grpc from '@grpc/grpc-js';

import {ClassifierClient} from './gen/classifier_grpc_pb';
import {ClassifyRequest} from './gen/classifier_pb';
import {metrics} from './metrics';

const client = new ClassifierClient('models:9000', grpc.credentials.createInsecure());

const DEADLINE_MS = 700;
const MAX_ATTEMPTS = 3;
const REFUSAL = 'REFUSED';
const PROVENANCE_MODEL = 'model';
const PROVENANCE_FALLBACK = 'fallback';
const FALLBACK_METRIC = 'classifier_fallback_total';
const REVIEW_LABEL = 'review';
const RETRYABLE = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED']);

const KEYWORD_RULES: Record<string, string[]> = {
  billing: ['invoice', 'refund', 'charge'],
  support: ['broken', 'error', 'crash'],
  security: ['password', 'breach', 'phishing'],
};

/** Deterministic fallback: keyword evidence only, never a label without support behind it. */
export function rulesClassify(text: string): string[] {
  const lowered = text.toLowerCase();
  const labels = Object.entries(KEYWORD_RULES)
    .filter(([, keywords]) => keywords.some(word => lowered.includes(word)))
    .map(([label]) => label);
  return labels.length > 0 ? labels : [REVIEW_LABEL];
}

export async function classify(text: string, taxonomyVersion: string): Promise<Result> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await new Promise<ClassifyReply>((resolve, reject) => {
        client.Classify(
          new ClassifyRequest().setText(text),
          new grpc.Metadata(),
          {deadline: Date.now() + DEADLINE_MS},
          (err, value) => (err ? reject(err) : resolve(value)),
        );
      });
      return {
        labels: reply.getLabelsList(),
        provenance: PROVENANCE_MODEL,
        modelVersion: reply.getModelVersion(),
        taxonomyVersion,
      };
    } catch (err) {
      const code = (err as grpc.ServiceError).code;
      const status = grpc.status[code] as string;
      // A refusal is the model's answer, and a permanent error will not change: both are terminal.
      if (status === REFUSAL || !RETRYABLE.has(status)) break;
    }
  }
  metrics.increment(FALLBACK_METRIC);
  return {
    labels: rulesClassify(text),
    provenance: PROVENANCE_FALLBACK,
    modelVersion: 'rules',
    taxonomyVersion,
  };
}
`,
    },
    go: {
      starter: `package classification

import (
	"context"

	"google.golang.org/grpc"

	classifierv1 "example.com/gen/classifierv1"
)

var conn, _ = grpc.Dial("models:9000", grpc.WithInsecure())

var models = classifierv1.NewClassifierClient(conn)

// TODO: this draft retries a refusal until the deadline and maps every failure to the label "safe"
// with no provenance, so an outage launders everything past review. It also calls the model with
// no deadline at all. Review it.
func Classify(ctx context.Context, text, taxonomyVersion string) (Result, error) {
	for {
		reply, err := models.Classify(ctx, &classifierv1.ClassifyRequest{Text: text})
		if err != nil {
			return Result{Labels: []string{"safe"}, Provenance: "model", ModelVersion: "none"}, nil
		}
		return Result{Labels: reply.Labels, Provenance: "model", ModelVersion: reply.ModelVersion}, nil
	}
}
`,
      solution: `package classification

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	classifierv1 "example.com/gen/classifierv1"
)

const (
	deadlineMS  = 700
	maxAttempts = 3
	refusal     = "REFUSED"
)

const (
	provenanceModel    = "model"
	provenanceFallback = "fallback"
	fallbackMetric     = "classifier_fallback_total"
	reviewLabel        = "review"
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var keywordRules = map[string][]string{
	"billing":  {"invoice", "refund", "charge"},
	"support":  {"broken", "error", "crash"},
	"security": {"password", "breach", "phishing"},
}

var conn, _ = grpc.Dial("models:9000", grpc.WithInsecure())

var models = classifierv1.NewClassifierClient(conn)

// rulesClassify is deterministic: keyword evidence only, never a label without support behind it.
func rulesClassify(text string) []string {
	lowered := strings.ToLower(text)
	labels := []string{}
	for label, keywords := range keywordRules {
		for _, word := range keywords {
			if strings.Contains(lowered, word) {
				labels = append(labels, label)
				break
			}
		}
	}
	if len(labels) == 0 {
		return []string{reviewLabel}
	}
	return labels
}

func Classify(ctx context.Context, text, taxonomyVersion string) (Result, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reply, err := models.Classify(callCtx, &classifierv1.ClassifyRequest{Text: text})
		if err == nil {
			return Result{
				Labels:          reply.Labels,
				Provenance:      provenanceModel,
				ModelVersion:    reply.ModelVersion,
				TaxonomyVersion: taxonomyVersion,
			}, nil
		}
		st, _ := status.FromError(err)
		if st.Message() == refusal || !retryable[st.Code()] {
			break // a refusal is the model's answer, and a permanent error is terminal
		}
	}
	metrics.Incr(fallbackMetric)
	return Result{
		Labels:          rulesClassify(text),
		Provenance:      provenanceFallback,
		ModelVersion:    "rules",
		TaxonomyVersion: taxonomyVersion,
	}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

import classifierv1.classifier.{ClassifyRequest, ClassifierGrpc}

object ModelClient {
  val channel = ManagedChannelBuilder.forAddress("models", 9000).usePlaintext().build()
  val models: ClassifierGrpc.ClassifierBlockingStub = ClassifierGrpc.blockingStub(channel)

  // TODO: this draft retries a refusal until the deadline and maps every failure to the label
  // "safe" with no provenance, so an outage launders everything past review. It also calls the
  // model with no deadline at all. Review it.
  def classify(text: String, taxonomyVersion: String): Result = {
    var done = false
    var result: Result = null
    while (!done) {
      try {
        val reply = models.classify(ClassifyRequest(text = text))
        result = Result(labels = reply.labels, provenance = "model", modelVersion = reply.modelVersion)
        done = true
      } catch {
        case _: io.grpc.StatusRuntimeException =>
          result = Result(labels = Seq("safe"), provenance = "model", modelVersion = "none")
          done = true
      }
    }
    result
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder

import classifierv1.classifier.{ClassifyRequest, ClassifierGrpc}

object ModelClient {
  val channel = ManagedChannelBuilder.forAddress("models", 9000).usePlaintext().build()
  val models: ClassifierGrpc.ClassifierBlockingStub = ClassifierGrpc.blockingStub(channel)

  val DeadlineMs = 700
  val MaxAttempts = 3
  val Refusal = "REFUSED"
  val Retryable = Set("UNAVAILABLE", "DEADLINE_EXCEEDED")
  val ProvenanceModel = "model"
  val ProvenanceFallback = "fallback"
  val FallbackMetric = "classifier_fallback_total"
  val ReviewLabel = "review"

  val KeywordRules = Map(
    "billing" -> Seq("invoice", "refund", "charge"),
    "support" -> Seq("broken", "error", "crash"),
    "security" -> Seq("password", "breach", "phishing")
  )

  /** Deterministic fallback: keyword evidence only, never a label without support behind it. */
  def rulesClassify(text: String): Seq[String] = {
    val lowered = text.toLowerCase
    val labels = KeywordRules.collect { case (label, keywords) if keywords.exists(lowered.contains) => label }.toSeq
    if (labels.isEmpty) Seq(ReviewLabel) else labels
  }

  def classify(text: String, taxonomyVersion: String): Result = {
    val stub = models.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
    for (_ <- 0 until MaxAttempts) {
      try {
        val reply = stub.classify(ClassifyRequest(text = text))
        return Result(labels = reply.labels, provenance = ProvenanceModel, modelVersion = reply.modelVersion)
      } catch {
        case e: io.grpc.StatusRuntimeException =>
          val code = e.getStatus.getCode.name()
          // A refusal is the model's answer, and a permanent code will not change: both are terminal.
          if (code == Refusal || !Retryable.contains(code)) {
            return fallback(text, taxonomyVersion)
          }
      }
    }
    fallback(text, taxonomyVersion)
  }

  private def fallback(text: String, taxonomyVersion: String): Result = {
    Metrics.counter(FallbackMetric).inc()
    Result(labels = rulesClassify(text), provenance = ProvenanceFallback, modelVersion = "rules")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>
#include <vector>

#include "classifier.grpc.pb.h"

// TODO: this draft retries a refusal until the deadline and maps every failure to the label "safe"
// with no provenance, so an outage launders everything past review. It also calls the model with
// no deadline at all. Review it.
Result Classify(const std::string& text, const std::string& taxonomyVersion) {
  while (true) {
    grpc::ClientContext ctx;
    classifierv1::ClassifyRequest request;
    request.set_text(text);
    classifierv1::ClassifyReply reply;
    const auto status = models->Classify(&ctx, request, &reply);
    if (status.ok()) {
      return {std::vector<std::string>(reply.labels().begin(), reply.labels().end()), "model", reply.model_version()};
    }
    return {std::vector<std::string>{"safe"}, "model", "none"};
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <string>
#include <utility>
#include <vector>

#include "classifier.grpc.pb.h"

namespace {
constexpr int kDeadlineMs = 700;
constexpr int kMaxAttempts = 3;
const std::string kRefusal = "REFUSED";
const std::string kProvenanceModel = "model";
const std::string kProvenanceFallback = "fallback";
const std::string kFallbackMetric = "classifier_fallback_total";
const std::string kReviewLabel = "review";

const std::vector<std::pair<std::string, std::vector<std::string>>> kKeywordRules = {
    {"billing", {"invoice", "refund", "charge"}},
    {"support", {"broken", "error", "crash"}},
    {"security", {"password", "breach", "phishing"}},
};
}  // namespace

// Deterministic fallback: keyword evidence only, never a label without support behind it.
std::vector<std::string> rulesClassify(const std::string& text) {
  std::string lowered = text;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  std::vector<std::string> labels;
  for (const auto& [label, keywords] : kKeywordRules) {
    for (const auto& word : keywords) {
      if (lowered.find(word) != std::string::npos) {
        labels.push_back(label);
        break;
      }
    }
  }
  if (labels.empty()) labels.push_back(kReviewLabel);
  return labels;
}

Result Classify(const std::string& text, const std::string& taxonomyVersion) {
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    classifierv1::ClassifyRequest request;
    request.set_text(text);
    classifierv1::ClassifyReply reply;
    const auto status = models->Classify(&ctx, request, &reply);
    if (status.ok()) {
      return {std::vector<std::string>(reply.labels().begin(), reply.labels().end()), kProvenanceModel,
              reply.model_version()};
    }
    const std::string code = grpcStatusCodeName(status.error_code());
    // A refusal is the model's answer, and a permanent code will not change: both are terminal.
    if (code == kRefusal || (code != "UNAVAILABLE" && code != "DEADLINE_EXCEEDED")) break;
  }
  Metrics::Incr(kFallbackMetric);
  return {rulesClassify(text), kProvenanceFallback, "rules"};
}
`,
    },
  },
  hints: [
    'The deadline is an argument on the call itself: `timeout=`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`. Wrapping the call in a timeout helper does not reach the wire, and an unbounded call turns a slow provider into a queue that never drains.',
    'Retryability is a property of the status, not of “it threw”: read the status code, retry only `UNAVAILABLE` and `DEADLINE_EXCEEDED` up to three times, and treat a refusal like any other decision — return it now, because the model will answer the same way on the next attempt.',
    'The fallback is a real classifier, not a placeholder: run the keyword rules, and when nothing matches return the review bucket. Tag the result with provenance and increment a fallback counter, so the outage shows up as a metric spike instead of an unexplained drop in label quality.',
  ],
  debrief: `The interviewer is testing whether you can review a generated dependency layer where the failure policy is the deliverable. Three defects are being checked: the deadline (a call without one converts a slow dependency into an outage of your own service), the retry policy (retrying a terminal refusal burns the deadline on an answer that will not change), and the failure representation (a constant label with no provenance is a silent data-quality bug — nothing downstream, and no metric, can tell it apart from a real classification). The fallback itself is the fourth idea: when the model is gone, the service must still produce evidence-based labels, which is exactly what a small deterministic rules pass gives you. Real classifiers add a per-label confidence, a sampled human review of fallback results, and a circuit breaker so a hard-down model is not called three times per request forever.`,
};
