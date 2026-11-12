import type {Step} from '@/lib/types';

export const summarizerClientStep: Step = {
  id: 'dependency',
  title: 'The model call: a deadline, terminal refusals and a labelled extract',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'model', 'extract'],
  task: `## Task

**Starting point.** The starter is the model call the summarizer makes for a source:
\`summarize(source_hash, content, target_words)\` calls \`SummaryModel.Summarize\` over gRPC up to five
times, a second apart, and answers \`{kind: "abstractive", summary, model_version}\`; when every
attempt fails it answers the first 400 characters of the source, or \`summary unavailable\`, under
the same label. With the model healthy it works, and it hides four flaws.

**Failure mode the checks target.** A hung model holds the request open with no end; a refusal is
asked again and gets the same answer; an outage costs five attempts; and a reader takes a raw slice
of the source for the model's summary.

\`\`\`proto
service SummaryModel { rpc Summarize(SummarizeRequest) returns (SummarizeReply); }  // FAILED_PRECONDITION: refused
\`\`\`

- Every attempt carries a \`DEADLINE_S\` = 5 s deadline.
- Only \`RETRYABLE_CODES\` (\`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`) are retried, at most
  \`MAX_ATTEMPTS\` = 3 attempts in all; a refusal or \`INVALID_ARGUMENT\` ends the call.
- Without a model summary, answer \`{kind: "extractive", summary: text.lead(content, target_words),
  model_version: ""}\`: the source's own sentences, cut to the band.`,
  sequence: {
    participants: ['Summarizer', 'Summary model', 'Extractive lead'],
    messages: [
      {
        from: 'Summarizer',
        to: 'Summary model',
        label: 'Summarize(source_hash, text, target_words) · 5 s',
        kind: 'sync',
      },
      {
        from: 'Summary model',
        to: 'Summarizer',
        label: 'UNAVAILABLE · DEADLINE_EXCEEDED → retry (3 in all)',
        kind: 'reply',
      },
      {from: 'Summary model', to: 'Summarizer', label: 'FAILED_PRECONDITION refused → stop', kind: 'reply'},
      {from: 'Summarizer', to: 'Extractive lead', label: 'text.lead(content, target_words)', kind: 'sync'},
      {
        from: 'Extractive lead',
        to: 'Summarizer',
        label: '{kind: extractive, summary, model_version: ""}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 5-second deadline',
      detail:
        'Each `Summarize` call is made with `DEADLINE_S` (5 s), so a hung model costs at most three deadlines before the extract is served; the starter sets none.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*5\b/, /Summarize\([^)]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*5000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*5L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{5\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'terminal-refusal',
      title: 'Retries only on UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        'The status of a failed call decides: `RETRYABLE_CODES` are retried, a refusal (`FAILED_PRECONDITION`) or `INVALID_ARGUMENT` ends the call at once. The starter retries whatever failed.',
      match: {
        python: {all: [/RETRYABLE_CODES\s*=/, /\.code\(\)\s+(not\s+)?in\s+RETRYABLE_CODES/]},
        typescript: {all: [/RETRYABLE_CODES\s*=/, /RETRYABLE_CODES\.includes\(/]},
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /status\.Code\(err\)/]},
        scala: {all: [/RetryableCodes\s*[:=]/, /RetryableCodes\.contains\(/]},
        cpp: {all: [/kRetryableCodes\s*=/, /kRetryableCodes\.count\(|kRetryableCodes\.find\(/]},
      },
    },
    {
      id: 'retry-budget',
      title: 'Makes at most three attempts',
      detail: 'An outage costs `MAX_ATTEMPTS` = 3 calls in all, then the extract is served; the starter makes five.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /range\(\s*MAX_ATTEMPTS\s*\)/], none: [/range\(\s*5\s*\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /<\s*MAX_ATTEMPTS/], none: [/<\s*5\b/]},
        go: {all: [/maxAttempts\s*=\s*3\b/, /<\s*maxAttempts/], none: [/<\s*5\b/]},
        scala: {all: [/MaxAttempts\s*=\s*3\b/, /<\s*MaxAttempts/], none: [/<\s*5\b/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3\b/, /<\s*kMaxAttempts/], none: [/<\s*5\b/]},
      },
    },
    {
      id: 'labelled-fallback',
      title: 'Serves the extractive lead, labelled extractive',
      detail:
        'Without a model summary the answer is `text.lead(content, target_words)` with `kind: "extractive"` and no model version, never a character slice or a placeholder sentence under the `abstractive` label.',
      match: {
        python: {all: [/text\.lead\(/, /["']extractive["']/], none: [/summary unavailable/i, /content\[:\s*\d+\]/]},
        typescript: {all: [/\blead\(/, /['"]extractive['"]/], none: [/summary unavailable/i, /\.slice\(0,\s*\d+\)/]},
        go: {all: [/text\.Lead\(/, /"extractive"/], none: [/summary unavailable/i, /content\[:\d+\]/]},
        scala: {all: [/Text\.lead\(/, /"extractive"/], none: [/summary unavailable/i, /\.take\(\d+\)/]},
        cpp: {all: [/text::lead\(/, /"extractive"/], none: [/summary unavailable/i, /substr\(0,\s*\d+\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import summarizer_service_pb2
import summarizer_service_pb2_grpc
from summarizer import text  # lead

model = summarizer_service_pb2_grpc.SummaryModelStub(grpc.insecure_channel("model:9000"))


def summarize(source_hash: str, content: str, target_words: int) -> dict:
    """The summary of a source: {kind, summary, model_version}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    request = summarizer_service_pb2.SummarizeRequest(source_hash=source_hash, text=content, target_words=target_words)
    for attempt in range(5):
        try:
            reply = model.Summarize(request)
            return {"kind": "abstractive", "summary": reply.summary, "model_version": reply.model_version}
        except grpc.RpcError:
            time.sleep(1.0)  # the model is flaky: try again
    return {"kind": "abstractive", "summary": content[:400] or "summary unavailable", "model_version": ""}
`,
      solution: `import grpc

import summarizer_service_pb2
import summarizer_service_pb2_grpc
from summarizer import text  # lead

DEADLINE_S = 5
MAX_ATTEMPTS = 3
RETRYABLE_CODES = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

model = summarizer_service_pb2_grpc.SummaryModelStub(grpc.insecure_channel("model:9000"))


def summarize(source_hash: str, content: str, target_words: int) -> dict:
    """The summary of a source: {kind, summary, model_version}."""
    request = summarizer_service_pb2.SummarizeRequest(source_hash=source_hash, text=content, target_words=target_words)
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = model.Summarize(request, timeout=DEADLINE_S)
            return {"kind": "abstractive", "summary": reply.summary, "model_version": reply.model_version}
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE_CODES:
                break  # a refusal or a bad request: asking again gets the same answer
    # The source's own sentences, cut to the band, and labelled as such.
    return {"kind": "extractive", "summary": text.lead(content, target_words), "model_version": ""}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {lead} from 'summarizer/text';

export interface Summarized {
  kind: string;
  summary: string;
  model_version: string;
}

interface SummarizeRequest {
  source_hash: string;
  text: string;
  target_words: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('summarizer_service.proto')) as unknown as {
  summarizerd: {SummaryModel: grpc.ServiceClientConstructor};
};
const model = new pkg.summarizerd.SummaryModel('model:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Summarize(request: SummarizeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{summary: string; model_version: string}>;
};

/** The summary of a source. */
export async function summarize(sourceHash: string, content: string, targetWords: number): Promise<Summarized> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const request = {source_hash: sourceHash, text: content, target_words: targetWords};
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reply = await model.Summarize(request, new grpc.Metadata(), {});
      return {kind: 'abstractive', summary: reply.summary, model_version: reply.model_version};
    } catch {
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, 1000); // the model is flaky: try again
      await promise;
    }
  }
  return {kind: 'abstractive', summary: content.slice(0, 400) || 'summary unavailable', model_version: ''};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {lead} from 'summarizer/text';

export const DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;
export const RETRYABLE_CODES = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

export interface Summarized {
  kind: string;
  summary: string;
  model_version: string;
}

interface SummarizeRequest {
  source_hash: string;
  text: string;
  target_words: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('summarizer_service.proto')) as unknown as {
  summarizerd: {SummaryModel: grpc.ServiceClientConstructor};
};
const model = new pkg.summarizerd.SummaryModel('model:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Summarize(request: SummarizeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{summary: string; model_version: string}>;
};

/** The summary of a source. */
export async function summarize(sourceHash: string, content: string, targetWords: number): Promise<Summarized> {
  const request = {source_hash: sourceHash, text: content, target_words: targetWords};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await model.Summarize(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return {kind: 'abstractive', summary: reply.summary, model_version: reply.model_version};
    } catch (e) {
      // A refusal or a bad request: asking again gets the same answer.
      if (!RETRYABLE_CODES.includes((e as grpc.ServiceError).code)) break;
    }
  }
  // The source's own sentences, cut to the band, and labelled as such.
  return {kind: 'extractive', summary: lead(content, targetWords), model_version: ''};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "summarizer/gen/summarizer_service"
	"summarizer/text" // text.Lead
)

var (
	modelConn, _ = grpc.NewClient("model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	model        = pb.NewSummaryModelClient(modelConn)
)

// Summarized is the summary of a source.
type Summarized struct {
	Kind         string \`json:"kind"\`
	Summary      string \`json:"summary"\`
	ModelVersion string \`json:"model_version"\`
}

// summarize is the summary of a source.
func summarize(ctx context.Context, sourceHash, content string, targetWords int) Summarized {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	request := &pb.SummarizeRequest{SourceHash: sourceHash, Text: content, TargetWords: int32(targetWords)}
	for attempt := 0; attempt < 5; attempt++ {
		reply, err := model.Summarize(ctx, request)
		if err == nil {
			return Summarized{Kind: "abstractive", Summary: reply.GetSummary(), ModelVersion: reply.GetModelVersion()}
		}
		time.Sleep(time.Second) // the model is flaky: try again
	}
	excerpt := content
	if len(excerpt) > 400 {
		excerpt = excerpt[:400]
	}
	if excerpt == "" {
		excerpt = "summary unavailable"
	}
	return Summarized{Kind: "abstractive", Summary: excerpt}
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

	pb "summarizer/gen/summarizer_service"
	"summarizer/text" // text.Lead
)

const (
	deadline    = 5 * time.Second
	maxAttempts = 3
)

var (
	modelConn, _ = grpc.NewClient("model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	model        = pb.NewSummaryModelClient(modelConn)
)

// Summarized is the summary of a source.
type Summarized struct {
	Kind         string \`json:"kind"\`
	Summary      string \`json:"summary"\`
	ModelVersion string \`json:"model_version"\`
}

// summarize is the summary of a source.
func summarize(ctx context.Context, sourceHash, content string, targetWords int) Summarized {
	request := &pb.SummarizeRequest{SourceHash: sourceHash, Text: content, TargetWords: int32(targetWords)}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := model.Summarize(callCtx, request)
		cancel()
		if err == nil {
			return Summarized{Kind: "abstractive", Summary: reply.GetSummary(), ModelVersion: reply.GetModelVersion()}
		}
		if code := status.Code(err); code != codes.Unavailable && code != codes.DeadlineExceeded {
			break // a refusal or a bad request: asking again gets the same answer
		}
	}
	// The source's own sentences, cut to the band, and labelled as such.
	return Summarized{Kind: "extractive", Summary: text.Lead(content, targetWords)}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import summarizer.Text // Text.lead
import summarizerd.summarizer_service.{SummarizeRequest, SummaryModelGrpc}

final case class Summarized(kind: String, summary: String, modelVersion: String)

object Client {
  private val model = SummaryModelGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())

  /** The summary of a source. */
  def summarize(sourceHash: String, content: String, targetWords: Int): Summarized = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val request = SummarizeRequest(sourceHash, content, targetWords)
    var attempt = 0
    var result: Option[Summarized] = None
    while (result.isEmpty && attempt < 5) {
      attempt += 1
      try {
        val reply = model.summarize(request)
        result = Some(Summarized("abstractive", reply.summary, reply.modelVersion))
      } catch {
        case _: StatusRuntimeException => Thread.sleep(1000) // the model is flaky: try again
      }
    }
    result.getOrElse(Summarized("abstractive", if (content.isEmpty) "summary unavailable" else content.take(400), ""))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import summarizer.Text // Text.lead
import summarizerd.summarizer_service.{SummarizeRequest, SummaryModelGrpc}

final case class Summarized(kind: String, summary: String, modelVersion: String)

object Client {
  val DeadlineSeconds = 5L
  val MaxAttempts = 3
  val RetryableCodes: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val model = SummaryModelGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())

  /** The summary of a source. */
  def summarize(sourceHash: String, content: String, targetWords: Int): Summarized = {
    val request = SummarizeRequest(sourceHash, content, targetWords)
    var attempt = 0
    var retry = true
    var result: Option[Summarized] = None
    while (result.isEmpty && retry && attempt < MaxAttempts) {
      attempt += 1
      try {
        val reply = model.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).summarize(request)
        result = Some(Summarized("abstractive", reply.summary, reply.modelVersion))
      } catch {
        // A refusal or a bad request: asking again gets the same answer.
        case e: StatusRuntimeException => retry = RetryableCodes.contains(e.getStatus.getCode)
      }
    }
    // The source's own sentences, cut to the band, and labelled as such.
    result.getOrElse(Summarized("extractive", Text.lead(content, targetWords), ""))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>

#include "summarizer/text.h"  // summarizer::text::lead
#include "summarizer_service.grpc.pb.h"

namespace text = summarizer::text;

auto model = summarizerd::SummaryModel::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));

// The summary of a source.
struct Summarized {
  std::string kind;
  std::string summary;
  std::string model_version;
};

Summarized summarize(const std::string& source_hash, const std::string& content, long target_words) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  summarizerd::SummarizeRequest request;
  request.set_source_hash(source_hash);
  request.set_text(content);
  request.set_target_words(static_cast<int>(target_words));
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    summarizerd::SummarizeReply reply;
    if (model->Summarize(&ctx, request, &reply).ok()) return {"abstractive", reply.summary(), reply.model_version()};
    std::this_thread::sleep_for(std::chrono::seconds{1});  // the model is flaky: try again
  }
  return {"abstractive", content.empty() ? std::string("summary unavailable") : content.substr(0, 400), ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <string>

#include "summarizer/text.h"  // summarizer::text::lead
#include "summarizer_service.grpc.pb.h"

namespace text = summarizer::text;

constexpr std::chrono::seconds kDeadline{5};
constexpr int kMaxAttempts = 3;
const std::set<grpc::StatusCode> kRetryableCodes = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

auto model = summarizerd::SummaryModel::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));

// The summary of a source.
struct Summarized {
  std::string kind;
  std::string summary;
  std::string model_version;
};

Summarized summarize(const std::string& source_hash, const std::string& content, long target_words) {
  summarizerd::SummarizeRequest request;
  request.set_source_hash(source_hash);
  request.set_text(content);
  request.set_target_words(static_cast<int>(target_words));
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    summarizerd::SummarizeReply reply;
    const grpc::Status status = model->Summarize(&ctx, request, &reply);
    if (status.ok()) return {"abstractive", reply.summary(), reply.model_version()};
    if (!kRetryableCodes.count(status.error_code())) break;  // a refusal or a bad request: asking again gets the same answer
  }
  // The source's own sentences, cut to the band, and labelled as such.
  return {"extractive", text::lead(content, target_words), ""};
}
`,
    },
  },
  harness: {
    python: `import grpc

import summarizer_service_pb2
import summarizer_service_pb2_grpc
from summarizer import text

SOURCE = "The board met on 3 March. Revenue rose four percent in the quarter. The audit committee approved the accounts.\\n\\nTwo directors stepped down. A new chair takes over in May."
HASH = "c" * 64


class Model(summarizer_service_pb2_grpc.SummaryModelServicer):
    def Summarize(self, request, context):
        return summarizer_service_pb2.SummarizeReply(summary=f"A {len(request.text.split())}-word source in {request.target_words} words.", model_version="sm-7")


def _client(ctx):
    ctx.grpc.serve(summarizer_service_pb2_grpc.add_SummaryModelServicer_to_server, Model())
    return ctx.load("client")


def _calls(ctx):
    return len(ctx.grpc.calls_to("Summarize"))


def check_deadline(ctx):
    m = _client(ctx)
    ok = m.summarize(HASH, SOURCE, 20)
    assert ok.get("kind") == "abstractive" and ok.get("model_version") == "sm-7", f"with the model healthy summarize answered {ok}"
    for call in ctx.grpc.calls_to("Summarize"):
        assert call.timeout is not None, "a Summarize call carries no deadline: a hung model holds the request until its caller gives up"
        assert 4.5 <= call.timeout <= 5.5, f"a Summarize call carries a {call.timeout} s deadline, expected DEADLINE_S = 5"
    ctx.grpc.set_latency("Summarize", 30.0)
    before = ctx.clock.time()
    slow = m.summarize(HASH, SOURCE, 20)
    waited = ctx.clock.time() - before
    assert waited <= 16, f"with the model hung summarize took {waited:.0f} s: each attempt must give up after 5 s"
    assert slow.get("kind") == "extractive", f"with the model hung summarize answered {slow}, expected the extractive lead"


def check_terminal_refusal(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Summarize", grpc.StatusCode.FAILED_PRECONDITION, "refused: the source asks for a diagnosis", times=1)
    refused = m.summarize(HASH, SOURCE, 20)
    assert _calls(ctx) == 1, f"a refusal was sent to the model {_calls(ctx)} times: the model answers the same text the same way, so a refusal ends the call"
    assert ctx.clock.sleeps == 0, "a refusal must not be slept on and retried"
    assert refused.get("kind") == "extractive", f"after a refusal summarize answered {refused}, expected the extractive lead"
    ctx.grpc.fail("Summarize", grpc.StatusCode.INVALID_ARGUMENT, "target_words out of range", times=1)
    m.summarize(HASH, SOURCE, 20)
    assert _calls(ctx) == 2, f"INVALID_ARGUMENT was retried ({_calls(ctx) - 1} calls for one request): only UNAVAILABLE and DEADLINE_EXCEEDED may be"


def check_retry_budget(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Summarize", grpc.StatusCode.UNAVAILABLE, "model restarting", times=3)
    down = m.summarize(HASH, SOURCE, 20)
    assert _calls(ctx) == 3, f"with the model down summarize made {_calls(ctx)} calls, expected MAX_ATTEMPTS = 3"
    assert down.get("kind") == "extractive", f"after three UNAVAILABLE answers summarize answered {down}, expected the extractive lead"
    ctx.grpc.fail("Summarize", grpc.StatusCode.UNAVAILABLE, "model restarting", times=1)
    back = m.summarize(HASH, SOURCE, 20)
    assert _calls(ctx) == 5 and back.get("kind") == "abstractive", f"one UNAVAILABLE then a healthy model: expected a retry and the model's summary, got {back} after {_calls(ctx) - 3} calls"


def check_labelled_fallback(ctx):
    m = _client(ctx)
    ok = m.summarize(HASH, SOURCE, 20)
    assert ok.get("kind") == "abstractive" and ok.get("summary") == "A 30-word source in 20 words.", f"with the model healthy summarize answered {ok}"
    ctx.grpc.fail("Summarize", grpc.StatusCode.FAILED_PRECONDITION, "refused", times=5)
    fallback = m.summarize(HASH, SOURCE, 20)
    expected = text.lead(SOURCE, 20)
    assert fallback.get("kind") == "extractive", f"when the model gave no summary the answer was labelled {fallback.get('kind')!r}: a reader takes it for the model's summary. Label it extractive"
    assert fallback.get("summary") == expected, f"the fallback must be the source's own lead cut to 20 words ({expected!r}), got {fallback.get('summary')!r}"
    assert fallback.get("model_version") == "", f"an extract has no model version, got {fallback.get('model_version')!r}"
`,
    typescript: `const SOURCE = 'The board met on 3 March. Revenue rose four percent in the quarter. The audit committee approved the accounts.\\n\\nTwo directors stepped down. A new chair takes over in May.';
const HASH = 'c'.repeat(64);

function client(ctx) {
  const pkg = ctx.proto('summarizer_service.proto');
  ctx.grpc.serve(pkg.summarizerd.SummaryModel.service, {
    Summarize(call, callback) {
      const {text, target_words} = call.request;
      callback(null, {summary: \`A \${text.split(/\\s+/).filter(w => w !== '').length}-word source in \${target_words} words.\`, model_version: 'sm-7'});
    },
  });
  return {m: ctx.load('client'), text: ctx.load('/support/summarizer/text.ts')};
}

const calls = ctx => ctx.grpc.callsTo('Summarize').length;

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const ok = await m.summarize(HASH, SOURCE, 20);
  assert(ok.kind === 'abstractive' && ok.model_version === 'sm-7', \`with the model healthy summarize answered \${JSON.stringify(ok)}\`);
  for (const call of ctx.grpc.callsTo('Summarize')) {
    assert(call.timeout !== null, 'a Summarize call carries no deadline: a hung model holds the request until its caller gives up');
    assert(4.5 <= call.timeout && call.timeout <= 5.5, \`a Summarize call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 5000\`);
  }
  ctx.grpc.setLatency('Summarize', 30);
  const before = ctx.clock.now();
  const slow = await m.summarize(HASH, SOURCE, 20);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 16, \`with the model hung summarize took \${waited.toFixed(0)} s: each attempt must give up after 5 s\`);
  assert.equal(slow.kind, 'extractive', \`with the model hung summarize answered \${JSON.stringify(slow)}, expected the extractive lead\`);
}

export async function check_terminal_refusal(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Summarize', ctx.grpc.status.FAILED_PRECONDITION, 'refused: the source asks for a diagnosis', 1);
  const refused = await m.summarize(HASH, SOURCE, 20);
  assert.equal(calls(ctx), 1, \`a refusal was sent to the model \${calls(ctx)} times: the model answers the same text the same way, so a refusal ends the call\`);
  assert.equal(ctx.clock.sleeps, 0, 'a refusal must not be slept on and retried');
  assert.equal(refused.kind, 'extractive', \`after a refusal summarize answered \${JSON.stringify(refused)}, expected the extractive lead\`);
  ctx.grpc.fail('Summarize', ctx.grpc.status.INVALID_ARGUMENT, 'target_words out of range', 1);
  await m.summarize(HASH, SOURCE, 20);
  assert.equal(calls(ctx), 2, \`INVALID_ARGUMENT was retried (\${calls(ctx) - 1} calls for one request): only UNAVAILABLE and DEADLINE_EXCEEDED may be\`);
}

export async function check_retry_budget(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Summarize', ctx.grpc.status.UNAVAILABLE, 'model restarting', 3);
  const down = await m.summarize(HASH, SOURCE, 20);
  assert.equal(calls(ctx), 3, \`with the model down summarize made \${calls(ctx)} calls, expected MAX_ATTEMPTS = 3\`);
  assert.equal(down.kind, 'extractive', \`after three UNAVAILABLE answers summarize answered \${JSON.stringify(down)}, expected the extractive lead\`);
  ctx.grpc.fail('Summarize', ctx.grpc.status.UNAVAILABLE, 'model restarting', 1);
  const back = await m.summarize(HASH, SOURCE, 20);
  assert(calls(ctx) === 5 && back.kind === 'abstractive', \`one UNAVAILABLE then a healthy model: expected a retry and the model's summary, got \${JSON.stringify(back)} after \${calls(ctx) - 3} calls\`);
}

export async function check_labelled_fallback(ctx) {
  const {m, text} = client(ctx);
  const ok = await m.summarize(HASH, SOURCE, 20);
  assert(ok.kind === 'abstractive' && ok.summary === 'A 30-word source in 20 words.', \`with the model healthy summarize answered \${JSON.stringify(ok)}\`);
  ctx.grpc.fail('Summarize', ctx.grpc.status.FAILED_PRECONDITION, 'refused', 5);
  const fallback = await m.summarize(HASH, SOURCE, 20);
  const expected = text.lead(SOURCE, 20);
  assert.equal(fallback.kind, 'extractive', \`when the model gave no summary the answer was labelled \${JSON.stringify(fallback.kind)}: a reader takes it for the model's summary. Label it extractive\`);
  assert.equal(fallback.summary, expected, \`the fallback must be the source's own lead cut to 20 words (\${JSON.stringify(expected)}), got \${JSON.stringify(fallback.summary)}\`);
  assert.equal(fallback.model_version, '', \`an extract has no model version, got \${JSON.stringify(fallback.model_version)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	pb "summarizer/gen/summarizer_service"
	"summarizer/text"

	"leetbuild/harness"
)

const (
	clientSource = "The board met on 3 March. Revenue rose four percent in the quarter. The audit committee approved the accounts.\\n\\nTwo directors stepped down. A new chair takes over in May."
	clientHash   = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

type modelPeer struct {
	pb.UnimplementedSummaryModelServer
}

func (modelPeer) Summarize(_ context.Context, req *pb.SummarizeRequest) (*pb.SummarizeReply, error) {
	summary := fmt.Sprintf("A %d-word source in %d words.", len(strings.Fields(req.GetText())), req.GetTargetWords())
	return &pb.SummarizeReply{Summary: summary, ModelVersion: "sm-7"}, nil
}

func clientPeer(ctx *harness.Ctx) {
	pb.RegisterSummaryModelServer(ctx.GRPC.Server(""), modelPeer{})
}

func clientCall() Summarized { return summarize(context.Background(), clientHash, clientSource, 20) }

func clientCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Summarize", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	clientPeer(ctx)
	ok := clientCall()
	ctx.Assert(ok.Kind == "abstractive" && ok.ModelVersion == "sm-7", "with the model healthy summarize answered %+v", ok)
	for _, call := range ctx.GRPC.CallsTo("Summarize", "") {
		ctx.Assert(call.HasDeadline(), "a Summarize call carries no deadline: a hung model holds the request until its caller gives up")
		ctx.Assert(4500*time.Millisecond <= call.Timeout && call.Timeout <= 5500*time.Millisecond, "a Summarize call carries a %v deadline, expected 5 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Summarize", 30, "")
	before := ctx.Clock.Now()
	slow := clientCall()
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 16, "with the model hung summarize took %.0f s: each attempt must give up after 5 s", waited)
	ctx.Equal(slow.Kind, "extractive", "with the model hung, the kind of the answer")
}

func CheckTerminalRefusal(ctx *harness.Ctx) {
	clientPeer(ctx)
	ctx.GRPC.Fail("Summarize", codes.FailedPrecondition, "refused: the source asks for a diagnosis", 1, "")
	refused := clientCall()
	ctx.Equal(clientCalls(ctx), 1, "a refusal ends the call (the model answers the same text the same way); the Summarize calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a refusal must not be slept on and retried; the sleeps")
	ctx.Equal(refused.Kind, "extractive", "after a refusal, the kind of the answer")
	ctx.GRPC.Fail("Summarize", codes.InvalidArgument, "target_words out of range", 1, "")
	clientCall()
	ctx.Equal(clientCalls(ctx), 2, "INVALID_ARGUMENT must not be retried (only UNAVAILABLE and DEADLINE_EXCEEDED may be); the Summarize calls")
}

func CheckRetryBudget(ctx *harness.Ctx) {
	clientPeer(ctx)
	ctx.GRPC.Fail("Summarize", codes.Unavailable, "model restarting", 3, "")
	down := clientCall()
	ctx.Equal(clientCalls(ctx), 3, "with the model down, the Summarize calls (MAX_ATTEMPTS = 3)")
	ctx.Equal(down.Kind, "extractive", "after three UNAVAILABLE answers, the kind of the answer")
	ctx.GRPC.Fail("Summarize", codes.Unavailable, "model restarting", 1, "")
	back := clientCall()
	ctx.Assert(clientCalls(ctx) == 5 && back.Kind == "abstractive", "one UNAVAILABLE then a healthy model: expected a retry and the model's summary, got %+v after %d calls", back, clientCalls(ctx)-3)
}

func CheckLabelledFallback(ctx *harness.Ctx) {
	clientPeer(ctx)
	ok := clientCall()
	ctx.Assert(ok.Kind == "abstractive" && ok.Summary == "A 30-word source in 20 words.", "with the model healthy summarize answered %+v", ok)
	ctx.GRPC.Fail("Summarize", codes.FailedPrecondition, "refused", 5, "")
	fallback := clientCall()
	ctx.Equal(fallback.Kind, "extractive", "when the model gave no summary a reader takes an unlabelled answer for the model's; the kind")
	ctx.Equal(fallback.Summary, text.Lead(clientSource, 20), "the fallback must be the source's own lead cut to 20 words")
	ctx.Equal(fallback.ModelVersion, "", "an extract has no model version")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "summarizer/text.h"
#include "summarizer_service.grpc.pb.h"

namespace {

const std::string kSource =
    "The board met on 3 March. Revenue rose four percent in the quarter. The audit committee approved the accounts.\\n\\nTwo directors stepped down. A new chair takes over in May.";
const std::string kHash(64, 'c');

class ModelPeer final : public summarizerd::SummaryModel::Service {
 public:
  grpc::Status Summarize(grpc::ServerContext*, const summarizerd::SummarizeRequest* req, summarizerd::SummarizeReply* out) override {
    out->set_summary("A " + std::to_string(summarizer::text::words(req->text()).size()) + "-word source in " + std::to_string(req->target_words()) + " words.");
    out->set_model_version("sm-7");
    return grpc::Status::OK;
  }
};

void clientPeer(harness::Ctx& ctx) {
  static ModelPeer* peer = nullptr;
  delete peer;
  peer = new ModelPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

Summarized clientCall() { return summarize(kHash, kSource, 20); }

size_t clientCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Summarize").size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientPeer(ctx);
  const Summarized ok = clientCall();
  ctx.Assert(ok.kind == "abstractive" && ok.model_version == "sm-7", "with the model healthy summarize answered kind %q, model %q", ok.kind, ok.model_version);
  for (const auto& call : ctx.GRPC.CallsTo("Summarize")) {
    ctx.Assert(call.HasDeadline(), "a Summarize call carries no deadline: a hung model holds the request until its caller gives up");
    ctx.Assert(4.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 5.5, "a Summarize call carries a %v s deadline, expected kDeadline = 5 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Summarize", 30.0);
  const int64_t before = ctx.Clock.Now();
  const Summarized slow = clientCall();
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 16, "with the model hung summarize took %.0f s: each attempt must give up after 5 s", waited);
  ctx.Equal(slow.kind, "extractive", "with the model hung, the kind of the answer");
}

void CheckTerminalRefusal(harness::Ctx& ctx) {
  clientPeer(ctx);
  ctx.GRPC.Fail("Summarize", grpc::StatusCode::FAILED_PRECONDITION, "refused: the source asks for a diagnosis", 1);
  const Summarized refused = clientCall();
  ctx.Equal(clientCalls(ctx), 1, "a refusal ends the call (the model answers the same text the same way); the Summarize calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a refusal must not be slept on and retried; the sleeps");
  ctx.Equal(refused.kind, "extractive", "after a refusal, the kind of the answer");
  ctx.GRPC.Fail("Summarize", grpc::StatusCode::INVALID_ARGUMENT, "target_words out of range", 1);
  clientCall();
  ctx.Equal(clientCalls(ctx), 2, "INVALID_ARGUMENT must not be retried (only UNAVAILABLE and DEADLINE_EXCEEDED may be); the Summarize calls");
}

void CheckRetryBudget(harness::Ctx& ctx) {
  clientPeer(ctx);
  ctx.GRPC.Fail("Summarize", grpc::StatusCode::UNAVAILABLE, "model restarting", 3);
  const Summarized down = clientCall();
  ctx.Equal(clientCalls(ctx), 3, "with the model down, the Summarize calls (kMaxAttempts = 3)");
  ctx.Equal(down.kind, "extractive", "after three UNAVAILABLE answers, the kind of the answer");
  ctx.GRPC.Fail("Summarize", grpc::StatusCode::UNAVAILABLE, "model restarting", 1);
  const Summarized back = clientCall();
  ctx.Assert(clientCalls(ctx) == 5 && back.kind == "abstractive", "one UNAVAILABLE then a healthy model: expected a retry and the model's summary, got kind %q after %d calls", back.kind, clientCalls(ctx) - 3);
}

void CheckLabelledFallback(harness::Ctx& ctx) {
  clientPeer(ctx);
  const Summarized ok = clientCall();
  ctx.Assert(ok.kind == "abstractive" && ok.summary == "A 30-word source in 20 words.", "with the model healthy summarize answered kind %q, %q", ok.kind, ok.summary);
  ctx.GRPC.Fail("Summarize", grpc::StatusCode::FAILED_PRECONDITION, "refused", 5);
  const Summarized fallback = clientCall();
  ctx.Equal(fallback.kind, "extractive", "when the model gave no summary a reader takes an unlabelled answer for the model's; the kind");
  ctx.Equal(fallback.summary, summarizer::text::lead(kSource, 20), "the fallback must be the source's own lead cut to 20 words");
  ctx.Equal(fallback.model_version, "", "an extract has no model version");
}
`,
  },
  hints: [
    "Hang the model and the request never returns; have it refuse a source and it is asked five times; when it is down the answer is the first 400 characters of the source, labelled as the model's.",
    'The call sets no deadline, the `except` treats a refusal like an outage, the loop runs five times, and the fallback slices characters and reuses the `abstractive` label.',
    'Pass `timeout=DEADLINE_S`, loop `MAX_ATTEMPTS` times, `break` unless `exc.code()` is in `RETRYABLE_CODES`, and answer `{"kind": "extractive", "summary": text.lead(content, target_words), "model_version": ""}` after the loop.',
  ],
  debrief: `The status code is the only thing that says whether asking again can help: an outage or a timeout may clear, a refusal is the model's answer to this text and will be the same next time. Three attempts at five seconds put a ceiling of fifteen seconds on the worst case, which is what lets the caller set its own timeout sensibly. The fallback is the extractive lead because it is made of the source's sentences, so a reader can trust every word of it, and the label tells them that is what they are reading. A production client adds jittered backoff between attempts, a circuit breaker so an outage stops costing three deadlines per request, and a metric on the share of extractive answers.`,
};
