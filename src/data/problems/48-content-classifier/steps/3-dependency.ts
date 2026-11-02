import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls with a rules fallback and no silent safe label',
  concept: 'grpc',
  file: 'client',
  focus: ['classifier', 'model', 'rules'],
  task: `## Task

**Starting point.** \`classify(text, taxonomy_version)\` calls the model's \`Classify\` RPC inside a
\`while True\` loop with no deadline and returns its labels with provenance \`model\`; on any gRPC
error it answers \`["safe"]\`, also marked \`model\`. When the model is healthy it serves the demo.
It hides 5 flaws.

**Failure mode the checks target.** Catching every failure and answering \`safe\` launders an outage
past review: nothing downstream can tell a real classification from a shrug. A loop with no attempt
cap and no status check wastes the deadline on a refusal that will not change. And a fallback
without provenance makes a rules guess indistinguishable from a model answer in the data, so nobody
can measure whether the fallback is any good.

Requirements:

- Each model call carries a **700 ms** deadline on the call itself (\`timeout=\`, a context with
  timeout, \`withDeadlineAfter\`, \`set_deadline\`, \`deadline: Date.now() + DEADLINE_MS\`).
- At most **3 attempts** (\`MAX_ATTEMPTS = 3\`), and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retried. A **refusal** is a decision, not a failure: it is terminal.
- When the model cannot answer, classify with the **deterministic keyword rules** and mark the
  result's **provenance** (\`model\` or \`fallback\`).
- No safe label without evidence: a rules pass that matches nothing produces the **review** bucket.
- The fallback path is counted separately (\`classifier_fallback_total\`), so an outage shows as a
  spike rather than a quiet drop in quality.`,
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
        'When the model cannot answer, a keyword rules pass produces the labels instead of the failure propagating. The starter has nothing to fall back to and answers a constant.',
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
        'A refusal stops the retry loop immediately and only `UNAVAILABLE`/`DEADLINE_EXCEEDED` are attempted again, bounded by `MAX_ATTEMPTS = 3`. The starter retries a refusal until the deadline.',
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
        'A failure never produces an unevidenced constant: the rules pass returns real keyword labels or the review bucket. The starter answers `safe` and the pipeline treats it as a real classification.',
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
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** gRPC model client: flawed code that hides outages behind a constant label. */
import * as grpc from '@grpc/grpc-js';

import {ClassifierClient} from './gen/classifier_grpc_pb';
import {ClassifyRequest} from './gen/classifier_pb';

const client = new ClassifierClient('models:9000', grpc.credentials.createInsecure());

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    'During a model outage every document comes back `safe`, the fallback dashboard stays flat, and when the model hangs the worker hangs with it.',
    'The call has no deadline, the loop has no attempt cap and reads no status code, and the `except` turns every error into the same constant with the same provenance as a real answer.',
    'Pass `timeout=DEADLINE_S` on the call; loop to `MAX_ATTEMPTS`, retry only UNAVAILABLE/DEADLINE_EXCEEDED, return a REFUSAL at once; otherwise `rules_classify` with `PROVENANCE_FALLBACK`, `REVIEW_LABEL` when nothing matches, and bump `FALLBACK_METRIC`.',
  ],
  debrief: `The deadline sits on the RPC because that is the only place it reaches the wire; a timeout wrapper around a blocking stub leaves the connection open. Retry decisions read the status code because retryability belongs to the failure, not to the fact that something threw: UNAVAILABLE may clear, a refusal is the model's answer and will repeat. The fallback is a real classifier with its own provenance and counter because the alternative, a constant labelled as a model answer, is a data-quality bug nobody can see until the outage shows up as a quality dip weeks later. Production clients go further: a circuit breaker stops attempts while the model is known down, and fallback results are sampled into review so the rules get measured against the model they stand in for.`,
};
