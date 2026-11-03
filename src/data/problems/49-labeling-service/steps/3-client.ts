import type {Step} from '@/lib/types';

export const prelabelClientStep: Step = {
  id: 'dependency',
  title: 'Pre-label calls that degrade to an unlabeled item',
  concept: 'grpc',
  file: 'client',
  focus: ['service', 'model'],
  task: `## Task

**Starting point.** The starter is the pre-label call labeld makes before an item reaches an
annotator: \`prelabel_item(item_id, text, spec_version)\` calls \`Prelabel.Predict\` up to
\`MAX_ATTEMPTS\` = 3 times, retrying any error, answers
\`{item_id, status: "prelabeled", labels, error: ""}\` on the first reply and raises \`RuntimeError\`
after the last failure. It serves the demo and hides three flaws.

**Failure mode the checks target.** A model that hangs holds the annotator's next item for as long
as it hangs; an item the model refuses is sent three times although the answer cannot change; and a
model outage becomes an error page instead of an item labeled by hand.

\`\`\`proto
service Prelabel { rpc Predict(PredictRequest) returns (PredictResponse); }  // INVALID_ARGUMENT: refused
\`\`\`

- Every call carries a \`DEADLINE_S\` = 2 s deadline.
- At most \`MAX_ATTEMPTS\` = 2 calls, and only \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\` is retried; any
  other status is final.
- \`prelabel_item\` does not raise: a failure answers
  \`{item_id, status: "unlabeled", labels: [], error: "<STATUS>: <details>"}\` with the last status.`,
  sequence: {
    participants: ['labeld', 'Pre-label model'],
    messages: [
      {
        from: 'labeld',
        to: 'Pre-label model',
        label: 'Predict(item_id, text, spec_version) · deadline 2 s',
        kind: 'sync',
      },
      {from: 'Pre-label model', to: 'labeld', label: 'labels, model_version → prelabeled', kind: 'reply'},
      {
        from: 'Pre-label model',
        to: 'labeld',
        label: 'UNAVAILABLE · DEADLINE_EXCEEDED → one more attempt',
        kind: 'reply',
      },
      {from: 'Pre-label model', to: 'labeld', label: 'INVALID_ARGUMENT → final', kind: 'reply'},
      {from: 'labeld', to: 'labeld', label: 'status unlabeled · error "<STATUS>: <details>"', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every pre-label call carries a 2-second deadline',
      detail:
        'Each `Predict` call is made with `DEADLINE_S` (2 s), so a hung model costs at most two deadlines. The starter sets none and waits for as long as the model takes.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*2\b/, /Predict\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*2000\b/, /Predict\([\s\S]{0,300}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*2L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{2\}|kDeadline\(2\)/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'retry-transient',
      title: 'Retries only a transient status, at most twice',
      detail:
        'At most `MAX_ATTEMPTS` = 2 calls, and only `UNAVAILABLE` or `DEADLINE_EXCEEDED` earns the second one; a refusal such as `INVALID_ARGUMENT` is final. The starter retries every error three times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/MAX_ATTEMPTS\s*=\s*3\b/]},
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*2\b/, /status\.UNAVAILABLE/, /status\.DEADLINE_EXCEEDED/],
          none: [/MAX_ATTEMPTS\s*=\s*3\b/],
        },
        go: {
          all: [/maxAttempts\s*=\s*2\b/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/maxAttempts\s*=\s*3\b/],
        },
        scala: {all: [/MaxAttempts\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/MaxAttempts\s*=\s*3\b/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/kMaxAttempts\s*=\s*3\b/]},
      },
    },
    {
      id: 'degrade-unlabeled',
      title: 'A model failure answers an unlabeled item',
      detail:
        'When the model fails, the call answers `status: "unlabeled"` with no labels and the last status in `error`, so the annotator labels the item by hand. The starter raises, and the queue stops at the first outage.',
      match: {
        python: {all: [/["']unlabeled["']/], none: [/\braise\b/]},
        typescript: {all: [/['"]unlabeled['"]/], none: [/\bthrow\b/]},
        go: {all: [/"unlabeled"/], none: [/\bErrorf\(|errors\.New\(/]},
        scala: {all: [/"unlabeled"/], none: [/\bthrow\b/]},
        cpp: {all: [/"unlabeled"/], none: [/\bthrow\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import labeling_service_pb2
import labeling_service_pb2_grpc

MAX_ATTEMPTS = 3

model = labeling_service_pb2_grpc.PrelabelStub(grpc.insecure_channel("prelabel:9000"))


def prelabel_item(item_id: str, text: str, spec_version: str) -> dict:
    """The model's suggested labels for one item: {item_id, status, labels, error}."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    last = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = model.Predict(labeling_service_pb2.PredictRequest(item_id=item_id, text=text, spec_version=spec_version))
            return {"item_id": item_id, "status": "prelabeled", "labels": list(reply.labels), "error": ""}
        except grpc.RpcError as exc:
            last = exc  # the model is flaky: try again
    raise RuntimeError(f"pre-label failed: {last.code().name}")
`,
      solution: `import grpc

import labeling_service_pb2
import labeling_service_pb2_grpc

DEADLINE_S = 2
MAX_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

model = labeling_service_pb2_grpc.PrelabelStub(grpc.insecure_channel("prelabel:9000"))


def prelabel_item(item_id: str, text: str, spec_version: str) -> dict:
    """The model's suggested labels for one item: {item_id, status, labels, error}."""
    error = ""
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = model.Predict(
                labeling_service_pb2.PredictRequest(item_id=item_id, text=text, spec_version=spec_version),
                timeout=DEADLINE_S,
            )
            return {"item_id": item_id, "status": "prelabeled", "labels": list(reply.labels), "error": ""}
        except grpc.RpcError as exc:
            error = f"{exc.code().name}: {exc.details()}"
            if exc.code() not in RETRYABLE:
                break  # a refusal answers the same way every time
    # The annotator labels from scratch: a model failure costs a suggestion, not the item.
    return {"item_id": item_id, "status": "unlabeled", "labels": [], "error": error}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const MAX_ATTEMPTS = 3;

interface PredictRequest {
  item_id: string;
  text: string;
  spec_version: string;
}

export interface Prelabel {
  item_id: string;
  status: 'prelabeled' | 'unlabeled';
  labels: string[];
  error: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('labeling_service.proto')) as unknown as {
  labeld: {Prelabel: grpc.ServiceClientConstructor};
};
const model = new pkg.labeld.Prelabel('prelabel:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Predict(request: PredictRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{labels: string[]; model_version: string}>;
};

/** The model's suggested labels for one item. */
export async function prelabelItem(itemId: string, text: string, specVersion: string): Promise<Prelabel> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  let last: grpc.ServiceError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await model.Predict({item_id: itemId, text, spec_version: specVersion}, new grpc.Metadata(), {});
      return {item_id: itemId, status: 'prelabeled', labels: [...reply.labels], error: ''};
    } catch (e) {
      last = e as grpc.ServiceError; // the model is flaky: try again
    }
  }
  throw new Error(\`pre-label failed: \${last === undefined ? 'unknown' : grpc.status[last.code]}\`);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEADLINE_MS = 2000;
export const MAX_ATTEMPTS = 2;
const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface PredictRequest {
  item_id: string;
  text: string;
  spec_version: string;
}

export interface Prelabel {
  item_id: string;
  status: 'prelabeled' | 'unlabeled';
  labels: string[];
  error: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('labeling_service.proto')) as unknown as {
  labeld: {Prelabel: grpc.ServiceClientConstructor};
};
const model = new pkg.labeld.Prelabel('prelabel:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Predict(request: PredictRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{labels: string[]; model_version: string}>;
};

/** The model's suggested labels for one item. */
export async function prelabelItem(itemId: string, text: string, specVersion: string): Promise<Prelabel> {
  let error = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await model.Predict(
        {item_id: itemId, text, spec_version: specVersion},
        new grpc.Metadata(),
        {deadline: Date.now() + DEADLINE_MS},
      );
      return {item_id: itemId, status: 'prelabeled', labels: [...reply.labels], error: ''};
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      const name = Object.keys(grpc.status).find(key => grpc.status[key as keyof typeof grpc.status] === code) ?? String(code);
      error = \`\${name}: \${details}\`;
      if (!RETRYABLE.has(code)) break; // a refusal answers the same way every time
    }
  }
  // The annotator labels from scratch: a model failure costs a suggestion, not the item.
  return {item_id: itemId, status: 'unlabeled', labels: [], error};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "labeld/gen/labeling_service"
)

const maxAttempts = 3

var (
	modelConn, _ = grpc.NewClient("prelabel:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	model        = pb.NewPrelabelClient(modelConn)
)

// Prelabel is the model's suggestion for one item: status "prelabeled" or "unlabeled".
type Prelabel struct {
	ItemID string   \`json:"item_id"\`
	Status string   \`json:"status"\`
	Labels []string \`json:"labels"\`
	Error  string   \`json:"error"\`
}

// prelabelItem asks the model for one item's suggested labels.
func prelabelItem(ctx context.Context, itemID, text, specVersion string) (Prelabel, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	var last error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reply, err := model.Predict(ctx, &pb.PredictRequest{ItemId: itemID, Text: text, SpecVersion: specVersion})
		if err == nil {
			return Prelabel{ItemID: itemID, Status: "prelabeled", Labels: reply.GetLabels()}, nil
		}
		last = err // the model is flaky: try again
	}
	return Prelabel{}, fmt.Errorf("pre-label failed: %v", status.Code(last))
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "labeld/gen/labeling_service"
)

const (
	deadline    = 2 * time.Second
	maxAttempts = 2
)

var (
	modelConn, _ = grpc.NewClient("prelabel:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	model        = pb.NewPrelabelClient(modelConn)
)

// Prelabel is the model's suggestion for one item: status "prelabeled" or "unlabeled".
type Prelabel struct {
	ItemID string   \`json:"item_id"\`
	Status string   \`json:"status"\`
	Labels []string \`json:"labels"\`
	Error  string   \`json:"error"\`
}

// prelabelItem asks the model for one item's suggested labels.
func prelabelItem(ctx context.Context, itemID, text, specVersion string) (Prelabel, error) {
	lastError := ""
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := model.Predict(callCtx, &pb.PredictRequest{ItemId: itemID, Text: text, SpecVersion: specVersion})
		cancel()
		if err == nil {
			return Prelabel{ItemID: itemID, Status: "prelabeled", Labels: reply.GetLabels()}, nil
		}
		code := status.Code(err)
		lastError = fmt.Sprintf("%s: %s", grpcName(code), status.Convert(err).Message())
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			break // a refusal answers the same way every time
		}
	}
	// The annotator labels from scratch: a model failure costs a suggestion, not the item.
	return Prelabel{ItemID: itemID, Status: "unlabeled", Labels: []string{}, Error: lastError}, nil
}

// grpcName is a status code as the protocol spells it (UNAVAILABLE, INVALID_ARGUMENT, ...).
func grpcName(code codes.Code) string {
	names := map[codes.Code]string{
		codes.Unavailable: "UNAVAILABLE", codes.DeadlineExceeded: "DEADLINE_EXCEEDED",
		codes.InvalidArgument: "INVALID_ARGUMENT", codes.FailedPrecondition: "FAILED_PRECONDITION",
		codes.PermissionDenied: "PERMISSION_DENIED", codes.Internal: "INTERNAL",
	}
	if name, ok := names[code]; ok {
		return name
	}
	return code.String()
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import labeld.labeling_service.{PredictRequest, PrelabelGrpc}

/** The model's suggestion for one item: status "prelabeled" or "unlabeled". */
final case class Prelabel(itemId: String, status: String, labels: Seq[String], error: String)

object Client {
  val MaxAttempts = 3

  private val model = PrelabelGrpc.blockingStub(ManagedChannelBuilder.forAddress("prelabel", 9000).usePlaintext().build())

  /** The model's suggested labels for one item. */
  def prelabelItem(itemId: String, text: String, specVersion: String): Prelabel = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    var last: StatusRuntimeException = null
    for (_ <- 1 to MaxAttempts) {
      try {
        val reply = model.predict(PredictRequest(itemId, text, specVersion))
        return Prelabel(itemId, "prelabeled", reply.labels, "")
      } catch { case e: StatusRuntimeException => last = e } // the model is flaky: try again
    }
    throw new RuntimeException(s"pre-label failed: \${last.getStatus.getCode}")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import labeld.labeling_service.{PredictRequest, PrelabelGrpc}

/** The model's suggestion for one item: status "prelabeled" or "unlabeled". */
final case class Prelabel(itemId: String, status: String, labels: Seq[String], error: String)

object Client {
  val DeadlineSeconds = 2L
  val MaxAttempts = 2
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val model = PrelabelGrpc.blockingStub(ManagedChannelBuilder.forAddress("prelabel", 9000).usePlaintext().build())

  /** The model's suggested labels for one item. */
  def prelabelItem(itemId: String, text: String, specVersion: String): Prelabel = {
    var error = ""
    var attempt = 0
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        val reply = model.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).predict(PredictRequest(itemId, text, specVersion))
        return Prelabel(itemId, "prelabeled", reply.labels, "")
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          error = s"\${code.name}: \${Option(e.getStatus.getDescription).getOrElse("")}"
          if (!Retryable.contains(code)) attempt = MaxAttempts // a refusal answers the same way every time
      }
    }
    // The annotator labels from scratch: a model failure costs a suggestion, not the item.
    Prelabel(itemId, "unlabeled", Seq.empty, error)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>
#include <vector>

#include "labeling_service.grpc.pb.h"

constexpr int kMaxAttempts = 3;

auto model = labeld::Prelabel::NewStub(grpc::CreateChannel("prelabel:9000", grpc::InsecureChannelCredentials()));

// The model's suggestion for one item: status "prelabeled" or "unlabeled".
struct Prelabel {
  std::string item_id;
  std::string status;
  std::vector<std::string> labels;
  std::string error;
};

// The model's suggested labels for one item.
Prelabel prelabelItem(const std::string& item_id, const std::string& text, const std::string& spec_version) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  labeld::PredictRequest request;
  request.set_item_id(item_id);
  request.set_text(text);
  request.set_spec_version(spec_version);
  std::string last;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    labeld::PredictResponse reply;
    const grpc::Status status = model->Predict(&ctx, request, &reply);
    if (status.ok()) {
      std::vector<std::string> labels;
      for (int i = 0; i < reply.labels_size(); i++) labels.push_back(reply.labels(i));
      return Prelabel{item_id, "prelabeled", labels, ""};
    }
    last = status.error_message();  // the model is flaky: try again
  }
  throw std::runtime_error("pre-label failed: " + last);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <vector>

#include "labeling_service.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{2};
constexpr int kMaxAttempts = 2;

auto model = labeld::Prelabel::NewStub(grpc::CreateChannel("prelabel:9000", grpc::InsecureChannelCredentials()));

// The model's suggestion for one item: status "prelabeled" or "unlabeled".
struct Prelabel {
  std::string item_id;
  std::string status;
  std::vector<std::string> labels;
  std::string error;
};

// A status code as the protocol spells it (UNAVAILABLE, INVALID_ARGUMENT, ...).
std::string codeName(grpc::StatusCode code) {
  switch (code) {
    case grpc::StatusCode::UNAVAILABLE:
      return "UNAVAILABLE";
    case grpc::StatusCode::DEADLINE_EXCEEDED:
      return "DEADLINE_EXCEEDED";
    case grpc::StatusCode::INVALID_ARGUMENT:
      return "INVALID_ARGUMENT";
    case grpc::StatusCode::FAILED_PRECONDITION:
      return "FAILED_PRECONDITION";
    default:
      return "code " + std::to_string(static_cast<int>(code));
  }
}

// The model's suggested labels for one item.
Prelabel prelabelItem(const std::string& item_id, const std::string& text, const std::string& spec_version) {
  labeld::PredictRequest request;
  request.set_item_id(item_id);
  request.set_text(text);
  request.set_spec_version(spec_version);
  std::string error;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    labeld::PredictResponse reply;
    const grpc::Status status = model->Predict(&ctx, request, &reply);
    if (status.ok()) {
      std::vector<std::string> labels;
      for (int i = 0; i < reply.labels_size(); i++) labels.push_back(reply.labels(i));
      return Prelabel{item_id, "prelabeled", labels, ""};
    }
    error = codeName(status.error_code()) + ": " + status.error_message();
    const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE || status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable) break;  // a refusal answers the same way every time
  }
  // The annotator labels from scratch: a model failure costs a suggestion, not the item.
  return Prelabel{item_id, "unlabeled", {}, error};
}
`,
    },
  },
  harness: {
    python: `import grpc

import labeling_service_pb2
import labeling_service_pb2_grpc


class Model(labeling_service_pb2_grpc.PrelabelServicer):
    """Labels every item "cat", except: refuse:… is INVALID_ARGUMENT, down:… is UNAVAILABLE, flaky:… is UNAVAILABLE on its first call."""

    def __init__(self):
        self.seen = {}

    def Predict(self, request, context):
        n = self.seen[request.item_id] = self.seen.get(request.item_id, 0) + 1
        if request.text.startswith("refuse:"):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "the item is outside the label spec")
        if request.text.startswith("down:") or (request.text.startswith("flaky:") and n == 1):
            context.abort(grpc.StatusCode.UNAVAILABLE, "the model is restarting")
        return labeling_service_pb2.PredictResponse(labels=["cat"], model_version="m-7")


def _client(ctx):
    ctx.grpc.serve(labeling_service_pb2_grpc.add_PrelabelServicer_to_server, Model())
    return ctx.load("client")


def _call(m, item_id, text):
    try:
        return m.prelabel_item(item_id, text, "2026-10")
    except Exception as exc:  # the checks below count calls and time whatever the call did
        return exc


def _calls(ctx, item_id):
    return len([c for c in ctx.grpc.calls_to("Predict") if c.request.item_id == item_id])


def check_deadline(ctx):
    m = _client(ctx)
    _call(m, "i-1", "a cat on a mat")
    calls = ctx.grpc.calls_to("Predict")
    assert calls, "no Predict call reached the model"
    for call in calls:
        assert call.timeout is not None, "a Predict call carries no deadline: a model that hangs holds the annotator's next item with it"
        assert 1.5 <= call.timeout <= 2.5, f"a Predict call carries a {call.timeout} s deadline, expected DEADLINE_S = 2"
    ctx.grpc.set_latency("Predict", 30.0)
    before = ctx.clock.time()
    _call(m, "i-2", "a dog in the fog")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"with the model hanging, prelabel_item took {waited:.0f} s: at most two calls of DEADLINE_S = 2 s each"


def check_retry_transient(ctx):
    m = _client(ctx)
    _call(m, "i-1", "refuse: a cat")
    assert _calls(ctx, "i-1") == 1, f"the model refused i-1 (INVALID_ARGUMENT) and was asked {_calls(ctx, 'i-1')} times: a refusal answers the same way every time, call once"
    _call(m, "i-2", "down: a dog")
    assert _calls(ctx, "i-2") == 2, f"with the model UNAVAILABLE, i-2 was sent {_calls(ctx, 'i-2')} times, expected MAX_ATTEMPTS = 2"
    result = _call(m, "i-3", "flaky: a bird")
    assert _calls(ctx, "i-3") == 2, f"i-3 failed UNAVAILABLE once: it must be sent a second time, it was sent {_calls(ctx, 'i-3')} times"
    assert isinstance(result, dict) and result.get("status") == "prelabeled", f"the second attempt for i-3 succeeded, prelabel_item answered {result!r}"


def check_degrade_unlabeled(ctx):
    m = _client(ctx)
    for item_id, text, code in (("i-1", "down: a dog", "UNAVAILABLE"), ("i-2", "refuse: a cat", "INVALID_ARGUMENT")):
        result = _call(m, item_id, text)
        assert isinstance(result, dict), f"with the model failing {code}, prelabel_item raised {type(result).__name__}: {result}. Answer an unlabeled item so the annotator labels it by hand"
        assert result.get("status") == "unlabeled" and result.get("labels") == [], f"a failed pre-label answered {result}, expected status unlabeled with no labels"
        assert code in (result.get("error") or ""), f"the unlabeled item's error is {result.get('error')!r}, expected the last status {code}"
        assert result.get("item_id") == item_id, f"the answer names item {result.get('item_id')!r}, expected {item_id}"
    ok = _call(m, "i-3", "a cat on a mat")
    assert isinstance(ok, dict) and ok.get("status") == "prelabeled" and ok.get("labels") == ["cat"], f"a healthy model's answer must come back prelabeled with its labels, got {ok!r}"
`,
    typescript: `function client(ctx) {
  const pkg = ctx.proto('labeling_service.proto');
  const seen = new Map<string, number>();
  // Labels every item "cat", except: refuse:… is INVALID_ARGUMENT, down:… is UNAVAILABLE, flaky:… is UNAVAILABLE on its first call.
  ctx.grpc.serve(pkg.labeld.Prelabel.service, {
    Predict(call, callback) {
      const {item_id, text} = call.request;
      const n = (seen.get(item_id) ?? 0) + 1;
      seen.set(item_id, n);
      if (text.startsWith('refuse:')) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: 'the item is outside the label spec'});
      if (text.startsWith('down:') || (text.startsWith('flaky:') && n === 1)) return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'the model is restarting'});
      callback(null, {labels: ['cat'], model_version: 'm-7'});
    },
  });
  return ctx.load('client');
}

async function call(m, itemId: string, text: string) {
  try {
    return await m.prelabelItem(itemId, text, '2026-10');
  } catch (e) {
    return e as Error; // the checks below count calls and time whatever the call did
  }
}

const calls = (ctx, itemId: string): number => ctx.grpc.callsTo('Predict').filter(c => c.request.item_id === itemId).length;

export async function check_deadline(ctx) {
  const m = client(ctx);
  await call(m, 'i-1', 'a cat on a mat');
  const made = ctx.grpc.callsTo('Predict');
  assert(made.length > 0, 'no Predict call reached the model');
  for (const c of made) {
    assert(c.timeout !== null, "a Predict call carries no deadline: a model that hangs holds the annotator's next item with it");
    assert(1.5 <= c.timeout && c.timeout <= 2.5, \`a Predict call carries a \${c.timeout} s deadline, expected DEADLINE_MS = 2000\`);
  }
  ctx.grpc.setLatency('Predict', 30.0);
  const before = ctx.clock.now();
  await call(m, 'i-2', 'a dog in the fog');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`with the model hanging, prelabelItem took \${waited.toFixed(0)} s: at most two calls of 2 s each\`);
}

export async function check_retry_transient(ctx) {
  const m = client(ctx);
  await call(m, 'i-1', 'refuse: a cat');
  assert.equal(calls(ctx, 'i-1'), 1, \`the model refused i-1 (INVALID_ARGUMENT) and was asked \${calls(ctx, 'i-1')} times: a refusal answers the same way every time, call once\`);
  await call(m, 'i-2', 'down: a dog');
  assert.equal(calls(ctx, 'i-2'), 2, \`with the model UNAVAILABLE, i-2 was sent \${calls(ctx, 'i-2')} times, expected MAX_ATTEMPTS = 2\`);
  const result = await call(m, 'i-3', 'flaky: a bird');
  assert.equal(calls(ctx, 'i-3'), 2, \`i-3 failed UNAVAILABLE once: it must be sent a second time, it was sent \${calls(ctx, 'i-3')} times\`);
  assert(!(result instanceof Error) && result.status === 'prelabeled', \`the second attempt for i-3 succeeded, prelabelItem answered \${result instanceof Error ? result.message : JSON.stringify(result)}\`);
}

export async function check_degrade_unlabeled(ctx) {
  const m = client(ctx);
  for (const [itemId, text, code] of [['i-1', 'down: a dog', 'UNAVAILABLE'], ['i-2', 'refuse: a cat', 'INVALID_ARGUMENT']]) {
    const result = await call(m, itemId, text);
    assert(!(result instanceof Error), \`with the model failing \${code}, prelabelItem threw: \${result instanceof Error ? result.message : ''}. Answer an unlabeled item so the annotator labels it by hand\`);
    assert(result.status === 'unlabeled' && result.labels.length === 0, \`a failed pre-label answered \${JSON.stringify(result)}, expected status unlabeled with no labels\`);
    assert(String(result.error).includes(code), \`the unlabeled item's error is \${JSON.stringify(result.error)}, expected the last status \${code}\`);
    assert.equal(result.item_id, itemId, 'the answer must name the item');
  }
  const ok = await call(m, 'i-3', 'a cat on a mat');
  assert(!(ok instanceof Error) && ok.status === 'prelabeled' && JSON.stringify(ok.labels) === '["cat"]', \`a healthy model's answer must come back prelabeled with its labels, got \${ok instanceof Error ? ok.message : JSON.stringify(ok)}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "labeld/gen/labeling_service"

	"leetbuild/harness"
)

var clientBg = context.Background()

// modelPeer labels every item "cat", except: refuse:… is INVALID_ARGUMENT, down:… is UNAVAILABLE,
// flaky:… is UNAVAILABLE on its first call.
type modelPeer struct {
	pb.UnimplementedPrelabelServer
	seen map[string]int
}

func (m *modelPeer) Predict(_ context.Context, req *pb.PredictRequest) (*pb.PredictResponse, error) {
	m.seen[req.GetItemId()]++
	text := req.GetText()
	if strings.HasPrefix(text, "refuse:") {
		return nil, status.Error(codes.InvalidArgument, "the item is outside the label spec")
	}
	if strings.HasPrefix(text, "down:") || (strings.HasPrefix(text, "flaky:") && m.seen[req.GetItemId()] == 1) {
		return nil, status.Error(codes.Unavailable, "the model is restarting")
	}
	return &pb.PredictResponse{Labels: []string{"cat"}, ModelVersion: "m-7"}, nil
}

func serveModel(ctx *harness.Ctx) {
	pb.RegisterPrelabelServer(ctx.GRPC.Server(""), &modelPeer{seen: map[string]int{}})
}

func callsFor(ctx *harness.Ctx, itemID string) int {
	n := 0
	for _, c := range ctx.GRPC.CallsTo("Predict", "") {
		if c.Request.(*pb.PredictRequest).GetItemId() == itemID {
			n++
		}
	}
	return n
}

func CheckDeadline(ctx *harness.Ctx) {
	serveModel(ctx)
	prelabelItem(clientBg, "i-1", "a cat on a mat", "2026-10")
	calls := ctx.GRPC.CallsTo("Predict", "")
	ctx.Assert(len(calls) > 0, "no Predict call reached the model")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Predict call carries no deadline: a model that hangs holds the annotator's next item with it")
		ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "a Predict call carries a %v deadline, expected 2 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Predict", 30.0, "")
	before := ctx.Clock.Now()
	prelabelItem(clientBg, "i-2", "a dog in the fog", "2026-10")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "with the model hanging, prelabelItem took %.0f s: at most two calls of 2 s each", waited)
}

func CheckRetryTransient(ctx *harness.Ctx) {
	serveModel(ctx)
	prelabelItem(clientBg, "i-1", "refuse: a cat", "2026-10")
	ctx.Equal(callsFor(ctx, "i-1"), 1, "the model refused i-1 (INVALID_ARGUMENT): a refusal answers the same way every time, call once; the calls")
	prelabelItem(clientBg, "i-2", "down: a dog", "2026-10")
	ctx.Equal(callsFor(ctx, "i-2"), 2, "with the model UNAVAILABLE, the calls for i-2 (maxAttempts = 2)")
	result, err := prelabelItem(clientBg, "i-3", "flaky: a bird", "2026-10")
	ctx.Equal(callsFor(ctx, "i-3"), 2, "i-3 failed UNAVAILABLE once: it must be sent a second time; the calls")
	ctx.Assert(err == nil && result.Status == "prelabeled", "the second attempt for i-3 succeeded, prelabelItem answered %+v, %v", result, err)
}

func CheckDegradeUnlabeled(ctx *harness.Ctx) {
	serveModel(ctx)
	cases := [][3]string{{"i-1", "down: a dog", "UNAVAILABLE"}, {"i-2", "refuse: a cat", "INVALID_ARGUMENT"}}
	for _, tc := range cases {
		result, err := prelabelItem(clientBg, tc[0], tc[1], "2026-10")
		ctx.Assert(err == nil, "with the model failing %s, prelabelItem returned the error %v. Answer an unlabeled item so the annotator labels it by hand", tc[2], err)
		ctx.Assert(result.Status == "unlabeled" && len(result.Labels) == 0, "a failed pre-label answered %+v, expected status unlabeled with no labels", result)
		ctx.Assert(strings.Contains(result.Error, tc[2]), "the unlabeled item's error is %q, expected the last status %s", result.Error, tc[2])
		ctx.Equal(result.ItemID, tc[0], "the answer must name the item")
	}
	ok, err := prelabelItem(clientBg, "i-3", "a cat on a mat", "2026-10")
	ctx.Assert(err == nil && ok.Status == "prelabeled" && len(ok.Labels) == 1 && ok.Labels[0] == "cat", "a healthy model's answer must come back prelabeled with its labels, got %+v, %v", ok, err)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <optional>
#include <string>

namespace {

// Labels every item "cat", except: refuse:… is INVALID_ARGUMENT, down:… is UNAVAILABLE, flaky:… is
// UNAVAILABLE on its first call.
class ModelPeer final : public labeld::Prelabel::Service {
 public:
  std::map<std::string, int> seen;
  grpc::Status Predict(grpc::ServerContext*, const labeld::PredictRequest* req, labeld::PredictResponse* out) override {
    const int n = ++seen[req->item_id()];
    const std::string& text = req->text();
    if (text.rfind("refuse:", 0) == 0) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "the item is outside the label spec");
    if (text.rfind("down:", 0) == 0 || (text.rfind("flaky:", 0) == 0 && n == 1)) {
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "the model is restarting");
    }
    out->add_labels("cat");
    out->set_model_version("m-7");
    return grpc::Status::OK;
  }
};

void serveModel(harness::Ctx& ctx) {
  static ModelPeer* peer = nullptr;
  delete peer;
  peer = new ModelPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

// What prelabelItem answered, or what it threw.
struct Outcome {
  std::optional<Prelabel> result;
  std::string thrown;
};

Outcome call(const std::string& item_id, const std::string& text) {
  try {
    return {prelabelItem(item_id, text, "2026-10"), ""};
  } catch (const std::exception& e) {
    return {std::nullopt, e.what()};
  }
}

int callsFor(harness::Ctx& ctx, const std::string& item_id) {
  int n = 0;
  for (const auto& c : ctx.GRPC.CallsTo("Predict")) {
    if (c.Request<labeld::PredictRequest>().item_id() == item_id) n++;
  }
  return n;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  serveModel(ctx);
  call("i-1", "a cat on a mat");
  const auto calls = ctx.GRPC.CallsTo("Predict");
  ctx.Assert(!calls.empty(), "no Predict call reached the model");
  for (const auto& c : calls) {
    ctx.Assert(c.HasDeadline(), "a Predict call carries no deadline: a model that hangs holds the annotator's next item with it");
    ctx.Assert(1.5 <= c.TimeoutSeconds() && c.TimeoutSeconds() <= 2.5, "a Predict call carries a %v s deadline, expected kDeadline = 2 s", c.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Predict", 30.0);
  const int64_t before = ctx.Clock.Now();
  call("i-2", "a dog in the fog");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "with the model hanging, prelabelItem took %.0f s: at most two calls of 2 s each", waited);
}

void CheckRetryTransient(harness::Ctx& ctx) {
  serveModel(ctx);
  call("i-1", "refuse: a cat");
  ctx.Equal(callsFor(ctx, "i-1"), 1, "the model refused i-1 (INVALID_ARGUMENT): a refusal answers the same way every time, call once; the calls");
  call("i-2", "down: a dog");
  ctx.Equal(callsFor(ctx, "i-2"), 2, "with the model UNAVAILABLE, the calls for i-2 (kMaxAttempts = 2)");
  const Outcome flaky = call("i-3", "flaky: a bird");
  ctx.Equal(callsFor(ctx, "i-3"), 2, "i-3 failed UNAVAILABLE once: it must be sent a second time; the calls");
  ctx.Assert(flaky.result && flaky.result->status == "prelabeled", "the second attempt for i-3 succeeded, prelabelItem answered %s", flaky.result ? flaky.result->status : "an exception: " + flaky.thrown);
}

void CheckDegradeUnlabeled(harness::Ctx& ctx) {
  serveModel(ctx);
  const std::vector<std::vector<std::string>> cases = {{"i-1", "down: a dog", "UNAVAILABLE"}, {"i-2", "refuse: a cat", "INVALID_ARGUMENT"}};
  for (const auto& tc : cases) {
    const Outcome o = call(tc[0], tc[1]);
    ctx.Assert(o.result.has_value(), "with the model failing %s, prelabelItem threw: %s. Answer an unlabeled item so the annotator labels it by hand", tc[2], o.thrown);
    ctx.Assert(o.result->status == "unlabeled" && o.result->labels.empty(), "a failed pre-label answered status %q with %d labels, expected status unlabeled with no labels", o.result->status, o.result->labels.size());
    ctx.Assert(o.result->error.find(tc[2]) != std::string::npos, "the unlabeled item's error is %q, expected the last status %s", o.result->error, tc[2]);
    ctx.Equal(o.result->item_id, tc[0], "the answer must name the item");
  }
  const Outcome ok = call("i-3", "a cat on a mat");
  ctx.Assert(ok.result && ok.result->status == "prelabeled" && ok.result->labels == std::vector<std::string>{"cat"}, "a healthy model's answer must come back prelabeled with its labels, got %s", ok.result ? ok.result->status : "an exception: " + ok.thrown);
}
`,
  },
  hints: [
    'Make the model hang and the annotator waits as long as it does; make it refuse an item and it is asked three times; take it down and the annotator gets an error instead of an item.',
    'The call has no deadline, the loop treats a refusal like a restart, and after the last attempt the function raises, so the caller has nothing to show the annotator.',
    'Pass `timeout=DEADLINE_S` on every `Predict`; loop `MAX_ATTEMPTS = 2` times, break unless the code is `UNAVAILABLE` or `DEADLINE_EXCEEDED`; after the loop answer status `unlabeled`, no labels, `error` = "<STATUS>: <details>".',
  ],
  debrief: `A pre-label is a suggestion, so the client's job is to keep its cost bounded: one deadline per attempt, a second attempt only for a status that says the model might answer next time, and an unlabeled item when it does not. The status codes already separate a refusal from an outage; retrying a refusal only spends the deadline twice. Returning an unlabeled item instead of raising is what turns a model outage into slower labeling rather than a stopped queue. Production services add a circuit breaker so a dead model is skipped for a while instead of costing every item two deadlines, record which model version suggested which labels, and hide the suggestion from a share of annotators to measure how much it anchors them.`,
};
