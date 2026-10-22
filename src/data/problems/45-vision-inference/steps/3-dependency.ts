import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls with a downgrade, not a default answer',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'model', 'small'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the large model is healthy
it returns a real classification and the demo passes. Every failure path invents an answer. Find the
flaws, fix them, and prove the fix.

Implement \`infer(image_key, task)\`, the worker's model layer:

- Every call carries a **2-second deadline** (\`DEADLINE_MS = 2000\`). A call without a deadline lets
  one overloaded model pin the worker for as long as the provider feels like.
- At most **\`MAX_ATTEMPTS = 3\`** attempts against the large model, and **only**
  \`UNAVAILABLE\` / \`DEADLINE_EXCEEDED\` are retryable (see \`RETRYABLE_CODES\`). A validation
  rejection is terminal: it is returned to the caller immediately, because retrying it just repeats
  the same rejection.
- When the large model's attempts are exhausted, **downgrade to the small model** and answer from it
  — with the downgrade **recorded** in the response (\`downgraded: true\` and a
  \`downgrade_reason\`). A timeout is never turned into a prediction: never return a default label
  (a literal \`"unknown"\`) as if the model had produced it.
- Every result names the **exact model version** that produced it (\`model_version\`), including the
  downgraded one.

**Failure mode the checks target.** The draft maps a timeout to \`{"label": "unknown", "confidence":
0.0}\` with a 200, so downstream consumers train on a label nobody predicted; it retries every error,
including permanent rejections; and it picks a model per attempt with no provenance, so no one can
tell which model version a stored prediction came from.`,
  sequence: {
    participants: ['Inference worker', 'Large model', 'Small model'],
    messages: [
      {from: 'Inference worker', to: 'Large model', label: 'Predict · deadline 2 s · attempt ≤ 3', kind: 'sync'},
      {from: 'Large model', to: 'Inference worker', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {
        from: 'Inference worker',
        to: 'Inference worker',
        label: 'retryable → retry · rejection → fail now',
        kind: 'sync',
      },
      {from: 'Inference worker', to: 'Small model', label: 'Predict · downgrade path', kind: 'sync'},
      {from: 'Small model', to: 'Inference worker', label: 'label · confidence · model version', kind: 'reply'},
      {from: 'Inference worker', to: 'Inference worker', label: 'record downgraded = true + reason', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 2-second deadline',
      detail:
        'The call itself is created with a 2000 ms deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, a context with timeout, `withDeadlineAfter`, `set_deadline`. The draft passes no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*2/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*2000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadlineMS\s*=\s*2000/, /context\.WithTimeout/]},
        scala: {all: [/DeadlineMs\s*=\s*2000/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineMs\s*=\s*2000/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Bounds the attempts and only retries the retryable codes',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS` and gated on `RETRYABLE_CODES` (`UNAVAILABLE`, `DEADLINE_EXCEEDED`); a validation rejection is not retried. The draft retries every error five times.',
      match: {
        python: {all: [/RETRYABLE_CODES/, /range\(MAX_ATTEMPTS\)/], none: [/INVALID_ARGUMENT/]},
        typescript: {all: [/RETRYABLE_CODES/, /attempt\s*<\s*MAX_ATTEMPTS/], none: [/INVALID_ARGUMENT/]},
        go: {all: [/retryableCodes/, /attempt\s*<\s*maxAttempts/], none: [/InvalidArgument/]},
        scala: {all: [/RetryableCodes/, /attempt\s*<\s*MaxAttempts/], none: [/INVALID_ARGUMENT/]},
        cpp: {all: [/kRetryableCodes/, /attempt\s*<\s*kMaxAttempts/], none: [/INVALID_ARGUMENT/]},
      },
    },
    {
      id: 'downgrade',
      title: 'Downgrades to the small model and records it',
      detail:
        'After the large model is exhausted the small model answers, and the response marks the downgrade (`downgraded: true` plus a reason) instead of hiding it. The draft alternates models silently.',
      match: {
        python: {all: [/downgraded/, /SMALL_MODEL_VERSION/, /downgrade_reason/]},
        typescript: {all: [/downgraded/, /SMALL_MODEL_VERSION/, /downgrade_reason/]},
        go: {all: [/Downgraded/, /smallModelVersion/, /DowngradeReason/]},
        scala: {all: [/downgraded/, /SmallModelVersion/, /downgrade_reason/]},
        cpp: {all: [/downgraded/, /kSmallModelVersion/, /downgrade_reason/]},
      },
    },
    {
      id: 'no-default-label',
      title: 'Never returns a default label as a prediction',
      detail:
        'There is no `"unknown"` fallback label: the response only ever carries a label the model produced, together with its confidence. The draft answers timeouts with a fabricated `unknown`.',
      match: {
        python: {all: [/confidence/], none: [/["']unknown["']/]},
        typescript: {all: [/confidence/], none: [/["']unknown["']/]},
        go: {all: [/confidence/], none: [/["']unknown["']/]},
        scala: {all: [/confidence/], none: [/["']unknown["']/]},
        cpp: {all: [/confidence/], none: [/["']unknown["']/]},
      },
    },
    {
      id: 'provenance',
      title: 'Names the exact model version on every result',
      detail:
        'Every prediction carries `model_version` with the concrete version constant that produced it (large or small). The draft records nothing, so a stored prediction cannot be traced back to a version.',
      match: {
        python: {all: [/model_version/, /LARGE_MODEL_VERSION/, /SMALL_MODEL_VERSION/]},
        typescript: {all: [/model_version/, /LARGE_MODEL_VERSION/, /SMALL_MODEL_VERSION/]},
        go: {all: [/model_version/, /largeModelVersion/, /smallModelVersion/]},
        scala: {all: [/model_version/, /LargeModelVersion/, /SmallModelVersion/]},
        cpp: {all: [/model_version/, /kLargeModelVersion/, /kSmallModelVersion/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Model calls: a model-generated draft that answers unknown when the model times out."""
import grpc

import vision_pb2
import vision_pb2_grpc

channel = grpc.insecure_channel("models:9000")
predictor = vision_pb2_grpc.PredictorStub(channel)

MODEL_VERSIONS = ["vision-large-3.1.0", "vision-small-1.7.2"]


def infer(image_key: str, task: str) -> dict:
    # TODO: this draft retries every error — a validation rejection included — calls the models with
    # no deadline, alternates between them with no recorded provenance, and answers a timeout with
    # the label "unknown" as if the model had predicted it. Review all four.
    for attempt in range(5):
        model_version = MODEL_VERSIONS[attempt % len(MODEL_VERSIONS)]
        request = vision_pb2.PredictRequest(
            model_version=model_version, task=task, image_key=image_key
        )
        try:
            reply = predictor.Predict(request)
            return {"label": reply.label, "confidence": reply.confidence}
        except grpc.RpcError:
            continue
    return {"label": "unknown", "confidence": 0.0}
`,
      solution: `"""Model calls: a 2-second deadline, an explicit downgrade, and provenance on every result."""
import grpc

import vision_pb2
import vision_pb2_grpc

channel = grpc.insecure_channel("models:9000")
predictor = vision_pb2_grpc.PredictorStub(channel)

DEADLINE_S = 2.0
MAX_ATTEMPTS = 3
LARGE_MODEL_VERSION = "vision-large-3.1.0"
SMALL_MODEL_VERSION = "vision-small-1.7.2"
RETRYABLE_CODES = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}


def infer(image_key: str, task: str) -> dict:
    reason = "UNAVAILABLE"
    for attempt in range(MAX_ATTEMPTS):
        request = vision_pb2.PredictRequest(
            model_version=LARGE_MODEL_VERSION, task=task, image_key=image_key
        )
        try:
            reply = predictor.Predict(request, timeout=DEADLINE_S)
            return {
                "label": reply.label,
                "confidence": reply.confidence,
                "model_version": LARGE_MODEL_VERSION,
                "downgraded": False,
            }
        except grpc.RpcError as error:
            if error.code() not in RETRYABLE_CODES:
                # A rejection from the model is terminal: retrying it repeats the same rejection.
                raise
            reason = error.code().name

    # The large model is overloaded: answer from the small one, and say so.
    request = vision_pb2.PredictRequest(
        model_version=SMALL_MODEL_VERSION, task=task, image_key=image_key
    )
    reply = predictor.Predict(request, timeout=DEADLINE_S)
    return {
        "label": reply.label,
        "confidence": reply.confidence,
        "model_version": SMALL_MODEL_VERSION,
        "downgraded": True,
        "downgrade_reason": reason,
    }
`,
    },
    typescript: {
      starter: `/** Model calls: a model-generated draft that answers unknown when the model times out. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface PredictorClient {
  Predict(
    request: {model_version: string; task: string; image_key: string},
    callback: (error: grpc.ServiceError | null, reply: {label: string; confidence: number}) => void,
  ): void;
}

const {vision} = grpc.loadPackageDefinition(protoLoader.loadSync('vision.proto')) as unknown as {
  vision: {Predictor: new (target: string, credentials: grpc.ChannelCredentials) => PredictorClient};
};
const predictor = new vision.Predictor('models:9000', grpc.credentials.createInsecure());

const MODEL_VERSIONS = ['vision-large-3.1.0', 'vision-small-1.7.2'];

export async function infer(imageKey: string, task: string): Promise<Record<string, unknown>> {
  // TODO: this draft retries every error — a validation rejection included — calls the models with
  // no deadline, alternates between them with no recorded provenance, and answers a timeout with
  // the label "unknown" as if the model had predicted it. Review all four.
  for (let attempt = 0; attempt < 5; attempt++) {
    const modelVersion = MODEL_VERSIONS[attempt % MODEL_VERSIONS.length];
    try {
      const {promise, resolve, reject} = Promise.withResolvers<{label: string; confidence: number}>();
      predictor.Predict({model_version: modelVersion, task, image_key: imageKey}, (error, value) =>
        error === null ? resolve(value) : reject(error),
      );
      const reply = await promise;
      return {label: reply.label, confidence: reply.confidence};
    } catch {
      continue;
    }
  }
  return {label: 'unknown', confidence: 0};
}
`,
      solution: `/** Model calls: a 2-second deadline, an explicit downgrade, and provenance on every result. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface PredictorClient {
  Predict(
    request: {model_version: string; task: string; image_key: string},
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: {label: string; confidence: number}) => void,
  ): void;
}

const {vision} = grpc.loadPackageDefinition(protoLoader.loadSync('vision.proto')) as unknown as {
  vision: {Predictor: new (target: string, credentials: grpc.ChannelCredentials) => PredictorClient};
};
const predictor = new vision.Predictor('models:9000', grpc.credentials.createInsecure());

const DEADLINE_MS = 2000;
const MAX_ATTEMPTS = 3;
const LARGE_MODEL_VERSION = 'vision-large-3.1.0';
const SMALL_MODEL_VERSION = 'vision-small-1.7.2';
const RETRYABLE_CODES: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};
const CODE_NAMES: Record<number, string> = {
  [grpc.status.UNAVAILABLE]: 'UNAVAILABLE',
  [grpc.status.DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
};

export interface Prediction {
  label: string;
  confidence: number;
  model_version: string;
  downgraded: boolean;
  downgrade_reason?: string;
}

function predict(modelVersion: string, imageKey: string, task: string): Promise<{label: string; confidence: number}> {
  const {promise, resolve, reject} = Promise.withResolvers<{label: string; confidence: number}>();
  predictor.Predict(
    {model_version: modelVersion, task, image_key: imageKey},
    {deadline: Date.now() + DEADLINE_MS},
    (error, value) => (error === null ? resolve(value) : reject(error)),
  );
  return promise;
}

export async function infer(imageKey: string, task: string): Promise<Prediction> {
  let reason = 'UNAVAILABLE';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await predict(LARGE_MODEL_VERSION, imageKey, task);
      return {
        label: reply.label,
        confidence: reply.confidence,
        model_version: LARGE_MODEL_VERSION,
        downgraded: false,
      };
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (RETRYABLE_CODES[code] !== true) {
        // A rejection from the model is terminal: retrying it repeats the same rejection.
        throw error;
      }
      reason = CODE_NAMES[code] ?? 'UNAVAILABLE';
    }
  }

  // The large model is overloaded: answer from the small one, and say so.
  const reply = await predict(SMALL_MODEL_VERSION, imageKey, task);
  return {
    label: reply.label,
    confidence: reply.confidence,
    model_version: SMALL_MODEL_VERSION,
    downgraded: true,
    downgrade_reason: reason,
  };
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "vision/predictpb"
)

var modelVersions = []string{"vision-large-3.1.0", "vision-small-1.7.2"}

func Infer(ctx context.Context, client pb.PredictorClient, req *pb.PredictRequest) (map[string]any, error) {
	// TODO: this draft retries every error — a validation rejection included — calls the models with
	// no deadline, alternates between them with no recorded provenance, and answers a timeout with
	// the label "unknown" as if the model had predicted it. Review all four.
	for attempt := 0; attempt < 5; attempt++ {
		req.ModelVersion = modelVersions[attempt%len(modelVersions)]
		reply, err := client.Predict(ctx, req)
		if err == nil {
			return map[string]any{"label": reply.Label, "confidence": reply.Confidence}, nil
		}
	}
	return map[string]any{"label": "unknown", "confidence": 0.0}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "vision/predictpb"
)

const (
	deadlineMS        = 2000
	maxAttempts       = 3
	largeModelVersion = "vision-large-3.1.0"
	smallModelVersion = "vision-small-1.7.2"
)

var retryableCodes = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type Prediction struct {
	Label           string  \`json:"label"\`
	Confidence      float64 \`json:"confidence"\`
	ModelVersion    string  \`json:"model_version"\`
	Downgraded      bool    \`json:"downgraded"\`
	DowngradeReason string  \`json:"downgrade_reason,omitempty"\`
}

func predict(ctx context.Context, client pb.PredictorClient, modelVersion string, req *pb.PredictRequest) (*pb.PredictReply, error) {
	ctx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	scoped := &pb.PredictRequest{ModelVersion: modelVersion, Task: req.Task, ImageKey: req.ImageKey}
	return client.Predict(ctx, scoped)
}

func Infer(ctx context.Context, client pb.PredictorClient, req *pb.PredictRequest) (Prediction, error) {
	reason := "UNAVAILABLE"
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reply, err := predict(ctx, client, largeModelVersion, req)
		if err == nil {
			return Prediction{
				Label:        reply.Label,
				Confidence:   reply.Confidence,
				ModelVersion: largeModelVersion,
			}, nil
		}
		if !retryableCodes[status.Code(err)] {
			// A rejection from the model is terminal: retrying it repeats the same rejection.
			return Prediction{}, err
		}
		reason = status.Code(err).String()
	}

	// The large model is overloaded: answer from the small one, and say so.
	reply, err := predict(ctx, client, smallModelVersion, req)
	if err != nil {
		return Prediction{}, err
	}
	return Prediction{
		Label:           reply.Label,
		Confidence:      reply.Confidence,
		ModelVersion:    smallModelVersion,
		Downgraded:      true,
		DowngradeReason: reason,
	}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import io.grpc.StatusRuntimeException

import vision.Vision.{PredictRequest, PredictorGrpc}

object ModelClient {
  val ModelVersions = List("vision-large-3.1.0", "vision-small-1.7.2")

  private val channel = ManagedChannelBuilder.forAddress("models", 9000).usePlaintext().build()
  private val blocking = PredictorGrpc.newBlockingStub(channel)

  def infer(request: PredictRequest): Map[String, Any] = {
    // TODO: this draft retries every error — a validation rejection included — calls the models with
    // no deadline, alternates between them with no recorded provenance, and answers a timeout with
    // the label "unknown" as if the model had predicted it. Review all four.
    var attempt = 0
    while (attempt < 5) {
      val modelVersion = ModelVersions(attempt % ModelVersions.size)
      try {
        val reply = blocking.predict(request.toBuilder.setModelVersion(modelVersion).build())
        return Map("label" -> reply.getLabel, "confidence" -> reply.getConfidence)
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    Map("label" -> "unknown", "confidence" -> 0.0)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import io.grpc.Status
import io.grpc.StatusRuntimeException

import vision.Vision.{PredictReply, PredictRequest, PredictorGrpc}

object ModelClient {
  val DeadlineMs = 2000
  val MaxAttempts = 3
  val LargeModelVersion = "vision-large-3.1.0"
  val SmallModelVersion = "vision-small-1.7.2"
  val RetryableCodes: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  /** \`model_version\` is the field name on the wire: it names the version that produced the label. */
  final case class Prediction(
      label: String,
      confidence: Double,
      model_version: String,
      downgraded: Boolean,
      downgrade_reason: Option[String]
  )

  private val channel = ManagedChannelBuilder.forAddress("models", 9000).usePlaintext().build()
  private val blocking = PredictorGrpc.newBlockingStub(channel)

  private def predict(modelVersion: String, request: PredictRequest): PredictReply =
    blocking
      .withDeadlineAfter(DeadlineMs.toLong, TimeUnit.MILLISECONDS)
      .predict(request.toBuilder.setModelVersion(modelVersion).build())

  def infer(request: PredictRequest): Prediction = {
    var reason = "UNAVAILABLE"
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val reply = predict(LargeModelVersion, request)
        return Prediction(reply.getLabel, reply.getConfidence, LargeModelVersion, downgraded = false, None)
      } catch {
        case error: StatusRuntimeException =>
          if (!RetryableCodes.contains(error.getStatus.getCode)) {
            // A rejection from the model is terminal: retrying it repeats the same rejection.
            throw error
          }
          reason = error.getStatus.getCode.name()
      }
      attempt += 1
    }

    // The large model is overloaded: answer from the small one, and say so.
    val reply = predict(SmallModelVersion, request)
    Prediction(reply.getLabel, reply.getConfidence, SmallModelVersion, downgraded = true, Some(reason))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <string>
#include <vector>

#include "vision.grpc.pb.h"

using grpc::ClientContext;

const std::vector<std::string> kModelVersions{"vision-large-3.1.0", "vision-small-1.7.2"};

std::map<std::string, std::string> infer(std::unique_ptr<vision::Predictor::Stub>& predictor,
                                         const vision::PredictRequest& request) {
  // TODO: this draft retries every error — a validation rejection included — calls the models with
  // no deadline, alternates between them with no recorded provenance, and answers a timeout with
  // the label "unknown" as if the model had predicted it. Review all four.
  for (int attempt = 0; attempt < 5; ++attempt) {
    ClientContext context;
    vision::PredictRequest scoped = request;
    scoped.set_model_version(kModelVersions[attempt % kModelVersions.size()]);
    vision::PredictReply reply;
    if (predictor->Predict(&context, scoped, &reply).ok()) {
      return {{"label", reply.label()}, {"confidence", std::to_string(reply.confidence())}};
    }
  }
  return {{"label", "unknown"}, {"confidence", "0"}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <stdexcept>
#include <string>

#include "vision.grpc.pb.h"

using grpc::ClientContext;
using grpc::Status;
using grpc::StatusCode;

constexpr int kDeadlineMs = 2000;
constexpr int kMaxAttempts = 3;
const std::string kLargeModelVersion = "vision-large-3.1.0";
const std::string kSmallModelVersion = "vision-small-1.7.2";
const std::set<StatusCode> kRetryableCodes = {StatusCode::UNAVAILABLE, StatusCode::DEADLINE_EXCEEDED};

struct Prediction {
  std::string label;
  double confidence;
  std::string model_version;
  bool downgraded;
  std::string downgrade_reason;
};

// One attempt against the named model version, under the deadline every call must carry.
Status predict(vision::Predictor::Stub* predictor, const std::string& modelVersion,
               const vision::PredictRequest& request, vision::PredictReply* reply) {
  ClientContext context;
  context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  vision::PredictRequest scoped = request;
  scoped.set_model_version(modelVersion);
  return predictor->Predict(&context, scoped, reply);
}

Prediction infer(vision::Predictor::Stub* predictor, const vision::PredictRequest& request) {
  std::string reason = "UNAVAILABLE";
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    vision::PredictReply reply;
    const auto status = predict(predictor, kLargeModelVersion, request, &reply);
    if (status.ok()) {
      return Prediction{reply.label(), reply.confidence(), kLargeModelVersion, false, ""};
    }
    if (kRetryableCodes.count(status.error_code()) == 0) {
      // A rejection from the model is terminal: retrying it repeats the same rejection.
      throw std::runtime_error("model rejected the request");
    }
    reason = status.error_message();
  }

  // The large model is overloaded: answer from the small one, and say so.
  vision::PredictReply reply;
  const auto status = predict(predictor, kSmallModelVersion, request, &reply);
  if (!status.ok()) throw std::runtime_error("vision models unavailable");
  return Prediction{reply.label(), reply.confidence(), kSmallModelVersion, true, reason};
}
`,
    },
  },
  hints: [
    'The deadline belongs to the call: `timeout=DEADLINE_S`, `{deadline: Date.now() + DEADLINE_MS}`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`. Bounding attempts with `range(MAX_ATTEMPTS)` is what turns a stuck model into a bounded delay instead of an unbounded one.',
    'Retryability is a property of the status, not of “it threw”: capture the error, compare its code against `RETRYABLE_CODES`, and re-raise anything else immediately. A rejection will be rejected again — retrying it only spends the tenant’s latency budget.',
    'The downgrade is data, not a footnote: return the small model’s label with `downgraded: true` and the reason, and put the concrete `model_version` on every path. Never synthesise a label: a fabricated `unknown` is indistinguishable downstream from a real prediction.',
  ],
  debrief: `The interviewer is testing honest degradation. The draft is dangerous precisely because it always
answers: a timeout becomes a 200 with a plausible-looking label, so the metric dashboard stays green
while the training set fills with labels no model produced. Three fixes are being checked — a deadline
per attempt, a retry policy keyed on the status code, and a downgrade that is *recorded* rather than
hidden — plus provenance, because on a multi-version model a prediction without a version cannot be
audited or reproduced. Real systems add a per-model circuit breaker, a separate confidence signal for
downgraded results, and a rule for which tasks may downgrade at all (an embedding usually may, a
safety-critical detection usually may not).`,
};
