import type {Step} from '@/lib/types';

export const prelabelClientStep: Step = {
  id: 'dependency',
  title: 'Pre-label calls that degrade to idleness, not silence',
  concept: 'grpc',
  file: 'client',
  focus: ['client', 'service', 'model'],
  task: `## Task

**Starting point.** The starter is the pre-label client called before an item reaches a human: it
builds the \`PrelabelService\` stub, loops \`MAX_ATTEMPTS\` times over
\`stub.Predict(PredictRequest{item_id, item_text, spec_version})\`, returns the label values on
success, continues on any exception and raises \`RuntimeError\` after the last attempt. It serves
the demo and hides 4 flaws.

**Failure mode the checks target.** The demo model answers in milliseconds and does not fail, so
the failure policy, the whole subject of this step, is invisible. The starter treats the model as if
it always answers: a hung call freezes the assignment, a refusal is retried although it will answer
the same way, and a model outage becomes a work stoppage instead of an unlabeled item.

- \`Predict\` returns \`PredictResponse{label_values, model_version}\`.
- \`PRELABEL_DEADLINE_S = 2\`: every attempt runs under a 2-second deadline passed as an argument
  on the call itself.
- \`MAX_ATTEMPTS = 2\`: at most two attempts per item.
- Retry only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`. A refusal (\`INVALID_ARGUMENT\`,
  \`PERMISSION_DENIED\`, \`FAILED_PRECONDITION\`) returns immediately.
- \`prelabel_item(item, spec_version)\` must not raise. Success returns the label values with
  \`prelabel_status = STATUS_PRELABELED\`; any failure returns \`STATUS_UNLABELED\`,
  \`prelabel = None\` and \`prelabel_error\` with the status and message of the last failure.
- Declare \`STATUS_PRELABELED\`, \`STATUS_UNLABELED\` and a helper that builds the unlabeled result.`,
  sequence: {
    participants: ['Annotator', 'Labeling Service', 'Pre-label model'],
    messages: [
      {from: 'Annotator', to: 'Labeling Service', label: 'next item · claim with lease', kind: 'sync'},
      {
        from: 'Labeling Service',
        to: 'Pre-label model',
        label: 'Predict(item_id, item_text, spec_version) · 2 s deadline',
        kind: 'sync',
      },
      {from: 'Pre-label model', to: 'Labeling Service', label: 'label_values, model_version', kind: 'reply'},
      {
        from: 'Pre-label model',
        to: 'Labeling Service',
        label: 'UNAVAILABLE · DEADLINE_EXCEEDED — retry once, then degrade',
        kind: 'reply',
      },
      {
        from: 'Pre-label model',
        to: 'Labeling Service',
        label: 'INVALID_ARGUMENT · FAILED_PRECONDITION — a refusal, never retried',
        kind: 'reply',
      },
      {
        from: 'Labeling Service',
        to: 'Labeling Service',
        label: 'prelabel_status: prelabeled | unlabeled + prelabel_error',
        kind: 'sync',
      },
      {
        from: 'Labeling Service',
        to: 'Annotator',
        label: 'the item — with label_values, or unlabeled and the reason',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every pre-label attempt runs under a 2-second deadline',
      detail:
        'Each `Predict` attempt is issued with a 2-second deadline — `timeout=PRELABEL_DEADLINE_S`, `{deadline: Date.now() + …}`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline` — so no single attempt can outlive it. The starter defines the deadline constant and never passes it: a bounded loop around an unbounded call is still an unbounded wait, and one hung model freezes the assignment it is pre-labeling.',
      match: {
        python: {all: [/PRELABEL_DEADLINE_S\s*=\s*2\b/, /stub\.Predict\([^\n]*timeout\s*=\s*PRELABEL_DEADLINE_S/]},
        typescript: {
          all: [/PRELABEL_DEADLINE_S\s*=\s*2\b/, /deadline:\s*Date\.now\(\)\s*\+\s*PRELABEL_DEADLINE_S\s*\*\s*1_000/],
        },
        go: {
          all: [
            /prelabelDeadlineS\s*=\s*2\b/,
            /context\.WithTimeout\(\s*ctx\s*,\s*prelabelDeadlineS\s*\*\s*time\.Second\s*\)/,
          ],
        },
        scala: {
          all: [/PrelabelDeadlineS\s*=\s*2\b/, /withDeadlineAfter\(\s*PrelabelDeadlineS\s*,\s*TimeUnit\.SECONDS\s*\)/],
        },
        cpp: {all: [/kPrelabelDeadlineS\s*=\s*2\b/, /set_deadline\([^\n]*kPrelabelDeadlineS/]},
      },
    },
    {
      id: 'no-retry-refusal',
      title: 'A refusal is not retried',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retryable; an `INVALID_ARGUMENT`, `PERMISSION_DENIED` or `FAILED_PRECONDITION` returns immediately, because the second attempt would answer the same way. The starter catches every error and loops, so a refusal costs the item its whole deadline and still ends without a result.',
      match: {
        python: {
          all: [
            /RETRYABLE\s*=\s*\{[^}]*StatusCode\.UNAVAILABLE[^}]*StatusCode\.DEADLINE_EXCEEDED/,
            /exc\.code\(\)\s+not\s+in\s+RETRYABLE/,
          ],
        },
        typescript: {
          all: [
            /\[grpc\.status\.UNAVAILABLE\]:\s*true/,
            /\[grpc\.status\.DEADLINE_EXCEEDED\]:\s*true/,
            /RETRYABLE\[serviceError\.code\]\s*!==\s*true/,
          ],
        },
        go: {
          all: [/codes\.Unavailable:\s*true/, /codes\.DeadlineExceeded:\s*true/, /!retryable\[status\.Code\(err\)\]/],
        },
        scala: {
          all: [
            /Retryable\s*=\s*Set\(Status\.Code\.UNAVAILABLE,\s*Status\.Code\.DEADLINE_EXCEEDED\)/,
            /!Retryable\.contains\(exc\.getStatus\.getCode\)/,
          ],
        },
        cpp: {all: [/StatusCode::UNAVAILABLE/, /StatusCode::DEADLINE_EXCEEDED/, /!retryable\(status\)/]},
      },
    },
    {
      id: 'degrade-unlabeled',
      title: 'An outage yields an unlabeled item, not a blocked assignment',
      detail:
        'The failure path returns the shared unlabeled result — `prelabel_status: STATUS_UNLABELED`, `prelabel: null` — instead of raising, so the caller gets an assignment either way. The starter throws the last RPC error out to the caller: the item is neither labeled nor queued, and the queue stops on a model error.',
      match: {
        python: {
          all: [/STATUS_UNLABELED\s*=\s*"unlabeled"/, /"prelabel_status":\s*STATUS_UNLABELED/, /"prelabel":\s*None/],
          none: [/\braise\b/],
        },
        typescript: {
          all: [/STATUS_UNLABELED\s*=\s*'unlabeled'/, /prelabel_status:\s*STATUS_UNLABELED/, /prelabel:\s*null/],
          none: [/\bthrow\b/],
        },
        go: {
          all: [/statusUnlabeled\s*=\s*"unlabeled"/, /PrelabelStatus:\s*statusUnlabeled/, /Prelabel:\s*nil/],
          none: [/\(\s*AssignmentResult\s*,\s*error\s*\)/],
        },
        scala: {
          all: [/StatusUnlabeled\s*=\s*"unlabeled"/, /prelabelStatus\s*=\s*StatusUnlabeled/, /prelabel\s*=\s*None/],
          none: [/\bthrow\b/],
        },
        cpp: {
          all: [
            /kStatusUnlabeled\s*=\s*"unlabeled"/,
            /AssignmentResult\{item_id,\s*kStatusUnlabeled,\s*\{\},\s*reason\}/,
          ],
          none: [/\bthrow\b/],
        },
      },
    },
    {
      id: 'reason-recorded',
      title: 'The failure reason is recorded on the item',
      detail:
        'The unlabeled result carries `prelabel_error` with the status code and the message of the last failure — `exc.code().name`/`exc.details()`, `grpc.status[...]`/`details`, `status.Code`/`status.Convert(err).Message()`, `getStatus.getCode`/`getStatus.getDescription`, `error_code()`/`error_message()` — so an operator can tell a refusal from an outage. The starter discards the exception and raises a bare `RuntimeError("prelabel failed")` with no reason at all.',
      match: {
        python: {all: [/prelabel_error/, /exc\.code\(\)\.name/, /exc\.details\(\)/]},
        typescript: {
          all: [/prelabel_error/, /grpc\.status\[serviceError\.code\]/, /serviceError\.details/],
        },
        go: {all: [/json:"prelabel_error"/, /status\.Code\(err\)/, /status\.Convert\(err\)\.Message\(\)/]},
        scala: {all: [/prelabelError\s*=\s*Some\(reason\)/, /getStatus\.getCode/, /getStatus\.getDescription/]},
        cpp: {all: [/prelabel_error/, /error_code\(\)/, /error_message\(\)/]},
      },
    },
    {
      id: 'attempts-bounded',
      title: 'At most two attempts per item',
      detail:
        '`MAX_ATTEMPTS = 2` bounds the loop to at most two `Predict` calls per item. This is the one habit the starter keeps — the loop is written against the constant — and the fix must keep it: two attempts, each under its own deadline, is the worst an assignment can ever wait before it degrades to unlabeled.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /for\s+\w+\s+in\s+range\(MAX_ATTEMPTS\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /attempt\s*<\s*MAX_ATTEMPTS/]},
        go: {all: [/maxAttempts\s*=\s*2\b/, /attempt\s*<\s*maxAttempts/]},
        scala: {all: [/MaxAttempts\s*=\s*2\b/, /attempt\s*<\s*MaxAttempts/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /attempt\s*<\s*kMaxAttempts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import prelabel_pb2
import prelabel_pb2_grpc

PRELABEL_DEADLINE_S = 2
MAX_ATTEMPTS = 2

channel = grpc.insecure_channel("prelabel:9000")
stub = prelabel_pb2_grpc.PrelabelServiceStub(channel)


def prelabel_item(item: dict, spec_version: str) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    request = prelabel_pb2.PredictRequest(
        item_id=item["item_id"],
        item_text=item["text"],
        spec_version=spec_version,
    )
    for _ in range(MAX_ATTEMPTS):
        try:
            return {"prelabel_status": "prelabeled", "prelabel": stub.Predict(request)}
        except Exception:
            continue
    raise RuntimeError("prelabel failed")
`,
      solution: `import grpc

import prelabel_pb2
import prelabel_pb2_grpc

PRELABEL_DEADLINE_S = 2
MAX_ATTEMPTS = 2
STATUS_PRELABELED = "prelabeled"
STATUS_UNLABELED = "unlabeled"
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("prelabel:9000")
stub = prelabel_pb2_grpc.PrelabelServiceStub(channel)


def unlabeled(item_id: int, error: str) -> dict:
    """Every failure path returns this: the item still reaches an annotator."""
    return {
        "item_id": item_id,
        "prelabel_status": STATUS_UNLABELED,
        "prelabel": None,
        "prelabel_error": error,
    }


def prelabel_item(item: dict, spec_version: str) -> dict:
    request = prelabel_pb2.PredictRequest(
        item_id=item["item_id"],
        item_text=item["text"],
        spec_version=spec_version,
    )
    last_error = "prelabel model did not answer"
    for _ in range(MAX_ATTEMPTS):
        try:
            response = stub.Predict(request, timeout=PRELABEL_DEADLINE_S)
        except grpc.RpcError as exc:
            last_error = f"{exc.code().name}: {exc.details()}"
            if exc.code() not in RETRYABLE:
                break  # a refusal answers the same way on the second attempt
            continue
        return {
            "item_id": item["item_id"],
            "prelabel_status": STATUS_PRELABELED,
            "prelabel": list(response.label_values),
            "prelabel_error": None,
        }
    return unlabeled(item["item_id"], last_error)
`,
    },
    typescript: {
      starter: `/** Pre-label client. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PRELABEL_DEADLINE_S = 2;
const MAX_ATTEMPTS = 2;

interface PredictRequest {
  item_id: string;
  item_text: string;
  spec_version: string;
}

interface PredictResponse {
  label_values: string[];
  model_version: string;
}

interface PrelabelClient {
  Predict(
    request: PredictRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, response?: PredictResponse) => void,
  ): grpc.ClientUnaryCall;
}

const {prelabel} = grpc.loadPackageDefinition(protoLoader.loadSync('prelabel.proto')) as unknown as {
  prelabel: {PrelabelService: new (target: string, credentials: grpc.ChannelCredentials) => PrelabelClient};
};
const client = new prelabel.PrelabelService('prelabel:9000', grpc.credentials.createInsecure());

function predict(request: PredictRequest): Promise<PredictResponse> {
  const {promise, resolve, reject} = Promise.withResolvers<PredictResponse>();
  client.Predict(request, new grpc.Metadata(), {}, (error, response) => {
    if (error === null) resolve(response as PredictResponse);
    else reject(error);
  });
  return promise;
}

export async function prelabelItem(
  item: {item_id: string; text: string},
  specVersion: string,
): Promise<{prelabel_status: string; prelabel: string[]}> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const request: PredictRequest = {item_id: item.item_id, item_text: item.text, spec_version: specVersion};
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await predict(request);
      return {prelabel_status: 'prelabeled', prelabel: response.label_values};
    } catch (error) {
      lastError = error as grpc.ServiceError;
    }
  }
  throw lastError;
}
`,
      solution: `/** Pre-label client: 2 s per attempt, two attempts, and a degrade to unlabeled. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PRELABEL_DEADLINE_S = 2;
const MAX_ATTEMPTS = 2;
const STATUS_PRELABELED = 'prelabeled';
const STATUS_UNLABELED = 'unlabeled';
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface PredictRequest {
  item_id: string;
  item_text: string;
  spec_version: string;
}

interface PredictResponse {
  label_values: string[];
  model_version: string;
}

interface AssignmentResult {
  item_id: string;
  prelabel_status: string;
  prelabel: string[] | null;
  prelabel_error: string | null;
}

interface PrelabelClient {
  Predict(
    request: PredictRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, response?: PredictResponse) => void,
  ): grpc.ClientUnaryCall;
}

const {prelabel} = grpc.loadPackageDefinition(protoLoader.loadSync('prelabel.proto')) as unknown as {
  prelabel: {PrelabelService: new (target: string, credentials: grpc.ChannelCredentials) => PrelabelClient};
};
const client = new prelabel.PrelabelService('prelabel:9000', grpc.credentials.createInsecure());

function predictOnce(request: PredictRequest): Promise<PredictResponse> {
  const {promise, resolve, reject} = Promise.withResolvers<PredictResponse>();
  client.Predict(
    request,
    new grpc.Metadata(),
    {deadline: Date.now() + PRELABEL_DEADLINE_S * 1_000},
    (error, response) => {
      if (error === null) resolve(response as PredictResponse);
      else reject(error);
    },
  );
  return promise;
}

export function unlabeled(itemId: string, error: string): AssignmentResult {
  // Every failure path returns this: the item still reaches an annotator.
  return {item_id: itemId, prelabel_status: STATUS_UNLABELED, prelabel: null, prelabel_error: error};
}

export async function prelabelItem(
  item: {item_id: string; text: string},
  specVersion: string,
): Promise<AssignmentResult> {
  const request: PredictRequest = {item_id: item.item_id, item_text: item.text, spec_version: specVersion};
  let reason = 'prelabel model did not answer';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: PredictResponse;
    try {
      response = await predictOnce(request);
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      reason = \`\${grpc.status[serviceError.code]}: \${serviceError.details}\`;
      if (RETRYABLE[serviceError.code] !== true) break; // a refusal answers the same way next time
      continue;
    }
    return {
      item_id: item.item_id,
      prelabel_status: STATUS_PRELABELED,
      prelabel: response.label_values,
      prelabel_error: null,
    };
  }
  return unlabeled(item.item_id, reason);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	pb "labeling/prelabelpb"
)

const (
	prelabelDeadlineS = 2
	maxAttempts       = 2
)

type AssignmentResult struct {
	ItemID         string   \`json:"item_id"\`
	PrelabelStatus string   \`json:"prelabel_status"\`
	Prelabel       []string \`json:"prelabel"\`
	PrelabelError  *string  \`json:"prelabel_error"\`
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
func PrelabelItem(ctx context.Context, client pb.PrelabelServiceClient, itemID, itemText, specVersion string) (AssignmentResult, error) {
	request := &pb.PredictRequest{ItemId: itemID, ItemText: itemText, SpecVersion: specVersion}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		response, err := client.Predict(ctx, request)
		if err == nil {
			return AssignmentResult{
				ItemID:         itemID,
				PrelabelStatus: "prelabeled",
				Prelabel:       response.GetLabelValues(),
			}, nil
		}
	}
	return AssignmentResult{}, errors.New("prelabel failed")
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "labeling/prelabelpb"
)

const (
	prelabelDeadlineS = 2
	maxAttempts       = 2
	statusPrelabeled  = "prelabeled"
	statusUnlabeled   = "unlabeled"
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type AssignmentResult struct {
	ItemID         string   \`json:"item_id"\`
	PrelabelStatus string   \`json:"prelabel_status"\`
	Prelabel       []string \`json:"prelabel"\`
	PrelabelError  *string  \`json:"prelabel_error"\`
}

// unlabeledResult is what every failure path returns: the item still reaches an annotator.
func unlabeledResult(itemID, reason string) AssignmentResult {
	return AssignmentResult{ItemID: itemID, PrelabelStatus: statusUnlabeled, Prelabel: nil, PrelabelError: &reason}
}

func PrelabelItem(ctx context.Context, client pb.PrelabelServiceClient, itemID, itemText, specVersion string) AssignmentResult {
	request := &pb.PredictRequest{ItemId: itemID, ItemText: itemText, SpecVersion: specVersion}
	reason := "prelabel model did not answer"
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, prelabelDeadlineS*time.Second)
		response, err := client.Predict(callCtx, request)
		cancel()
		if err == nil {
			return AssignmentResult{
				ItemID:         itemID,
				PrelabelStatus: statusPrelabeled,
				Prelabel:       response.GetLabelValues(),
			}
		}
		reason = fmt.Sprintf("%s: %s", status.Code(err), status.Convert(err).Message())
		if !retryable[status.Code(err)] {
			break // a refusal answers the same way on the second attempt
		}
	}
	return unlabeledResult(itemID, reason)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object PrelabelClient {
  val PrelabelDeadlineS = 2
  val MaxAttempts = 2

  val stub = PrelabelServiceGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("prelabel", 9000).usePlaintext().build()
  )

  case class AssignmentResult(
      itemId: String,
      prelabelStatus: String,
      prelabel: Option[Seq[String]],
      prelabelError: Option[String])

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  def prelabelItem(itemId: String, itemText: String, specVersion: String): AssignmentResult = {
    val request = PredictRequest(itemId = itemId, itemText = itemText, specVersion = specVersion)
    var last: Option[StatusRuntimeException] = None
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val response = stub.predict(request)
        return AssignmentResult(itemId, "prelabeled", Some(response.labelValues), None)
      } catch {
        case exc: StatusRuntimeException => last = Some(exc)
      }
      attempt += 1
    }
    throw last.getOrElse(new RuntimeException("prelabel failed"))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object PrelabelClient {
  val PrelabelDeadlineS = 2
  val MaxAttempts = 2
  val StatusPrelabeled = "prelabeled"
  val StatusUnlabeled = "unlabeled"
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val stub = PrelabelServiceGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("prelabel", 9000).usePlaintext().build()
  )

  case class AssignmentResult(
      itemId: String,
      prelabelStatus: String,
      prelabel: Option[Seq[String]],
      prelabelError: Option[String])

  def unlabeled(itemId: String, reason: String): AssignmentResult =
    // Every failure path returns this: the item still reaches an annotator.
    AssignmentResult(itemId, prelabelStatus = StatusUnlabeled, prelabel = None, prelabelError = Some(reason))

  def prelabelItem(itemId: String, itemText: String, specVersion: String): AssignmentResult = {
    val request = PredictRequest(itemId = itemId, itemText = itemText, specVersion = specVersion)
    var reason = "prelabel model did not answer"
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val response = stub
          .withDeadlineAfter(PrelabelDeadlineS, TimeUnit.SECONDS)
          .predict(request)
        return AssignmentResult(
          itemId,
          prelabelStatus = StatusPrelabeled,
          prelabel = Some(response.labelValues),
          prelabelError = None)
      } catch {
        case exc: StatusRuntimeException =>
          reason = s"\${exc.getStatus.getCode}: \${exc.getStatus.getDescription}"
          if (!Retryable.contains(exc.getStatus.getCode)) return unlabeled(itemId, reason)
      }
      attempt += 1
    }
    unlabeled(itemId, reason)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "prelabel.grpc.pb.h"

#include <stdexcept>
#include <string>
#include <vector>

constexpr int kPrelabelDeadlineS = 2;
constexpr int kMaxAttempts = 2;

struct AssignmentResult {
  std::string item_id;
  std::string prelabel_status;
  std::vector<std::string> prelabel;
  std::string prelabel_error;
};

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
AssignmentResult prelabel_item(PrelabelService::Stub* stub, const std::string& item_id,
                               const std::string& item_text, const std::string& spec_version) {
  PredictRequest request;
  request.set_item_id(item_id);
  request.set_item_text(item_text);
  request.set_spec_version(spec_version);
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    PredictResponse response;
    if (stub->Predict(&ctx, request, &response).ok()) {
      return AssignmentResult{
          item_id,
          "prelabeled",
          {response.label_values().begin(), response.label_values().end()},
          "",
      };
    }
  }
  throw std::runtime_error("prelabel failed");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "prelabel.grpc.pb.h"

#include <chrono>
#include <string>
#include <vector>

constexpr int kPrelabelDeadlineS = 2;
constexpr int kMaxAttempts = 2;
constexpr const char* kStatusPrelabeled = "prelabeled";
constexpr const char* kStatusUnlabeled = "unlabeled";

struct AssignmentResult {
  std::string item_id;
  std::string prelabel_status;
  std::vector<std::string> prelabel;
  std::string prelabel_error;
};

bool retryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::UNAVAILABLE ||
         status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// unlabeled_result is what every failure path returns: the item still reaches an annotator.
AssignmentResult unlabeled_result(const std::string& item_id, const std::string& reason) {
  return AssignmentResult{item_id, kStatusUnlabeled, {}, reason};
}

AssignmentResult prelabel_item(PrelabelService::Stub* stub, const std::string& item_id,
                               const std::string& item_text, const std::string& spec_version) {
  PredictRequest request;
  request.set_item_id(item_id);
  request.set_item_text(item_text);
  request.set_spec_version(spec_version);
  std::string reason = "prelabel model did not answer";
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kPrelabelDeadlineS));
    PredictResponse response;
    const grpc::Status status = stub->Predict(&ctx, request, &response);
    if (status.ok()) {
      return AssignmentResult{
          item_id,
          kStatusPrelabeled,
          {response.label_values().begin(), response.label_values().end()},
          "",
      };
    }
    reason = "code " + std::to_string(static_cast<int>(status.error_code())) + ": " + status.error_message();
    if (!retryable(status)) break;  // a refusal answers the same way on the second attempt
  }
  return unlabeled_result(item_id, reason);
}
`,
    },
  },
  hints: [
    'During a model outage the next-item button spins, then shows an error page; the logs say only `prelabel failed`, no status code; a stale spec takes two full timeouts to fail.',
    'The deadline constant is defined but not passed to `Predict`, so an attempt can hang; the loop retries on any exception, including refusals; the last error becomes a bare `RuntimeError` that escapes to the caller.',
    "Pass `timeout=PRELABEL_DEADLINE_S` on the call, retry only `UNAVAILABLE`/`DEADLINE_EXCEEDED`, and on failure return the helper's unlabeled result with `prelabel_error` set to `code: details` instead of raising.",
  ],
  debrief: `The deadline bounds a single attempt, \`MAX_ATTEMPTS\` bounds the whole call, the retryable set decides which failures deserve a second attempt, and the degrade path decides what the annotator sees. The deadline belongs on the call rather than around the loop because a bounded loop around an unbounded call is still an unbounded wait. A retried refusal is the subtle flaw: the code looks resilient, but \`FAILED_PRECONDITION\` from a stale spec fails identically the second time, so the retry only spends the deadline. Raising turns a cheap model's outage into idle time for the expensive human queue. Production clients also record \`model_version\` on every pre-label so agreement can be audited per model, keep a circuit breaker per model, and chart the unlabeled rate.`,
};
