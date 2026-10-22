import type {Step} from '@/lib/types';

export const summarizerClientStep: Step = {
  id: 'dependency',
  title: 'Model calls with a deadline and a no-fabrication fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'model', 'extract'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the summarizer, loops
until it gets something back, and returns *something* on failure. It compiles, it serves the happy
path, and it hides four production flaws. Review it like the service owner, fix it, and prove the fix
with the checks below.

Call the summary model over gRPC. The call is allowed to fail, but the answer it returns must never
pretend the model spoke when it did not.

- Every attempt carries a **5-second deadline** (\`DEADLINE_S\`) applied to the call itself
  (\`timeout\`/\`deadline\`, a per-attempt context or a client-context deadline) — never a wall-clock
  check after the fact, which leaves the call running while you look at your watch.
- A **refusal is terminal**. The provider declines a source with the \`REFUSED\` detail (and other
  non-retryable statuses are in \`TERMINAL_CODES\`); retrying a refusal spends the deadline to be
  refused again. Only \`RETRYABLE_CODES\` (\`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`) may be retried, at
  most \`MAX_ATTEMPTS = 3\`.
- When the call fails, return a **trimmed extract of the source** — \`trim_extract(source)\` bounded by
  \`EXTRACT_CHARS = 1200\` — marked \`OUTPUT_EXTRACTIVE\`. A trimmed extract is honest: it is the
  source's own words. A sentence like \`summary unavailable\` dressed up as a summary is not, because
  a caller (and a board deck) reads it as content.
- **Label the output type always**: every result carries \`kind\`, either \`OUTPUT_ABSTRACTIVE\` (the
  model wrote it) or \`OUTPUT_EXTRACTIVE\` (it is the source's text). A fallback labelled abstractive
  makes an extractive answer look generated, which is exactly the confusion the label exists to
  prevent.

**Failure mode the checks target.** The draft has no deadline and retries in an unbounded \`while\`
loop, treating a refusal as a transient hiccup and hammering the model until the caller gives up. On
failure it returns the first 400 characters of the source labelled \`abstractive\` — or the literal
sentence \`summary unavailable\` — so a caller cannot tell a generated summary from a truncated source
or from nothing at all.`,
  sequence: {
    participants: ['Summarizer', 'Summary model', 'Extractive fallback', 'Reader'],
    messages: [
      {from: 'Summarizer', to: 'Summary model', label: 'Summarize(chunk) · deadline 5 s', kind: 'sync'},
      {from: 'Summary model', to: 'Summarizer', label: 'REFUSED · or UNAVAILABLE', kind: 'reply'},
      {from: 'Summarizer', to: 'Summarizer', label: 'refusal terminal · retry only UNAVAILABLE/DEADLINE', kind: 'sync'},
      {from: 'Summarizer', to: 'Extractive fallback', label: 'trim_extract(source, EXTRACT_CHARS)', kind: 'sync'},
      {from: 'Extractive fallback', to: 'Summarizer', label: 'trimmed extract of the source', kind: 'reply'},
      {from: 'Summarizer', to: 'Reader', label: '200 {kind: extractive, summary, extractive_chars}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries the 5-second deadline',
      detail:
        '`DEADLINE_S = 5` is applied to the call (a per-attempt `timeout`/`deadline`, context or client-context deadline). The draft calls the model with no deadline at all, so one slow call can hold the request until the caller times out.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout=DEADLINE_S|wait_for/]},
        typescript: {all: [/DEADLINE_S/, /deadline:/]},
        go: {all: [/deadlineSeconds/, /WithTimeout/]},
        scala: {all: [/DeadlineSeconds/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineSeconds/, /set_deadline/]},
      },
    },
    {
      id: 'terminal-refusal',
      title: 'A refusal is terminal',
      detail:
        'A provider refusal (`REFUSED`) and the other non-retryable statuses in `TERMINAL_CODES` end the call immediately; they are never retried. The draft treats a refusal as transient and loops on it until the caller gives up.',
      match: {
        python: {all: [/TERMINAL_CODES/, /REFUSED/]},
        typescript: {all: [/TERMINAL_CODES/, /REFUSED/]},
        go: {all: [/terminalCodes/, /Refused/]},
        scala: {all: [/TerminalCodes/, /Refused/]},
        cpp: {all: [/kTerminalCodes/, /Refused/]},
      },
    },
    {
      id: 'retry-bounded',
      title: 'Only retryable failures are retried, at most three times',
      detail:
        '`RETRYABLE_CODES` (`UNAVAILABLE`, `DEADLINE_EXCEEDED`) is the whole retry surface and `MAX_ATTEMPTS = 3` bounds it. The draft retries every failure forever.',
      match: {
        python: {all: [/RETRYABLE_CODES/, /MAX_ATTEMPTS/]},
        typescript: {all: [/RETRYABLE_CODES/, /MAX_ATTEMPTS/]},
        go: {all: [/retryableCodes/, /maxAttempts/]},
        scala: {all: [/RetryableCodes/, /MaxAttempts/]},
        cpp: {all: [/kRetryableCodes/, /kMaxAttempts/]},
      },
    },
    {
      id: 'extractive-fallback',
      title: 'A failure yields a marked extractive fallback',
      detail:
        'Failure returns `trim_extract(source)` bounded by `EXTRACT_CHARS`, labelled `OUTPUT_EXTRACTIVE`, so the answer is the source’s own words and is marked as such. The draft returns a slice of the source with no trimming rule and no label.',
      match: {
        python: {all: [/trim_extract/, /EXTRACT_CHARS/, /OUTPUT_EXTRACTIVE/]},
        typescript: {all: [/trimExtract/, /EXTRACT_CHARS/, /OUTPUT_EXTRACTIVE/]},
        go: {all: [/trimExtract/, /extractChars/, /outputExtractive/]},
        scala: {all: [/trimExtract/, /ExtractChars/, /OutputExtractive/]},
        cpp: {all: [/trim_extract/, /kExtractChars/, /kOutputExtractive/]},
      },
    },
    {
      id: 'output-labelled',
      title: 'The output type is always labelled',
      detail:
        'Every result carries `kind`, one of `OUTPUT_ABSTRACTIVE` or `OUTPUT_EXTRACTIVE`, and no result is a placeholder sentence presented as a summary. The draft labels everything `abstractive` and can return `summary unavailable`.',
      match: {
        python: {all: [/OUTPUT_ABSTRACTIVE/, /OUTPUT_EXTRACTIVE/, /kind/], none: [/summary unavailable/i]},
        typescript: {all: [/OUTPUT_ABSTRACTIVE/, /OUTPUT_EXTRACTIVE/, /kind/], none: [/summary unavailable/i]},
        go: {all: [/outputAbstractive/, /outputExtractive/, /Kind|kind/], none: [/summary unavailable/i]},
        scala: {all: [/OutputAbstractive/, /OutputExtractive/, /kind/], none: [/summary unavailable/i]},
        cpp: {all: [/kOutputAbstractive/, /kOutputExtractive/, /kind/], none: [/summary unavailable/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

logger = logging.getLogger("summarizer")


class SummaryRequest:
    def __init__(self, content: str, band: str) -> None:
        self.content = content
        self.band = band


class SummaryModel:
    def Summarize(self, request: SummaryRequest, timeout: float | None = None):
        """The gRPC stub the provider serves."""
        raise NotImplementedError


def summarize_with_model(stub: SummaryModel, content: str, band: str) -> dict:
    # TODO: this draft calls the model with no deadline and retries every failure — refusals
    # included — in an unbounded loop, then returns a slice of the source labelled abstractive (or
    # the sentence "summary unavailable") as if it were a summary. Review all four.
    while True:
        try:
            reply = stub.Summarize(SummaryRequest(content=content, band=band))
            if reply.refused:
                continue
            return {"kind": "abstractive", "summary": reply.text}
        except grpc.RpcError as err:
            logger.warning("model call failed: %s", err)
            if "refused" in (err.details() or ""):
                continue
            break
    return {"kind": "abstractive", "summary": content[:400] or "summary unavailable"}
`,
      solution: `import logging

import grpc

logger = logging.getLogger("summarizer")

DEADLINE_S = 5
MAX_ATTEMPTS = 3
EXTRACT_CHARS = 1200
OUTPUT_ABSTRACTIVE = "abstractive"
OUTPUT_EXTRACTIVE = "extractive"
REFUSED = "REFUSED"
TERMINAL_CODES = {grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.PERMISSION_DENIED}
RETRYABLE_CODES = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}


class SummaryRequest:
    def __init__(self, content: str, band: str) -> None:
        self.content = content
        self.band = band


class SummaryModel:
    def Summarize(self, request: SummaryRequest, timeout: float | None = None):
        """The gRPC stub the provider serves; every call carries a deadline."""
        raise NotImplementedError


def trim_extract(content: str, chars: int = EXTRACT_CHARS) -> str:
    """The source's own words, cut at a sentence boundary when one is close enough."""
    head = content[:chars].strip()
    if len(content) <= chars:
        return head
    stop = max(head.rfind("."), head.rfind("!"), head.rfind("?"))
    return (head[: stop + 1] if stop > 0 else head) + "…"


def summarize_with_model(stub: SummaryModel, content: str, band: str) -> dict:
    """Abstractive when the model answers; a labelled extractive fallback when it cannot."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = stub.Summarize(SummaryRequest(content=content, band=band), timeout=DEADLINE_S)
            return {
                "kind": OUTPUT_ABSTRACTIVE,
                "summary": reply.text,
                "model_version": reply.model_version,
            }
        except grpc.RpcError as err:
            code = err.code()
            refused = REFUSED in (err.details() or "")
            if refused or code in TERMINAL_CODES:
                logger.info("model call terminal code=%s refused=%s; not retrying", code, refused)
                break
            if code not in RETRYABLE_CODES:
                logger.info("model call failed with %s; not retryable", code)
                break
            logger.warning("model attempt %d/%d failed: %s", attempt + 1, MAX_ATTEMPTS, code)

    # The model did not answer. Hand back the source's own words, clearly marked as an extract.
    return {
        "kind": OUTPUT_EXTRACTIVE,
        "summary": trim_extract(content),
        "extractive_chars": EXTRACT_CHARS,
        "model_version": None,
    }
`,
    },
    typescript: {
      starter: `/** Summarize over gRPC: a model-generated draft that loops until something comes back. */
import * as grpc from '@grpc/grpc-js';

import type {SummaryModelClient} from './client_pb';

export interface SummaryResult {
  kind: string;
  summary: string;
}

export async function summarizeWithModel(
  client: SummaryModelClient,
  content: string,
  band: string,
): Promise<SummaryResult> {
  // TODO: this draft calls the model with no deadline and retries every failure — refusals
  // included — in an unbounded loop, then returns a slice of the source labelled abstractive (or
  // the sentence "summary unavailable") as if it were a summary. Review all four.
  for (;;) {
    try {
      const reply = await client.summarize({content, band});
      if (reply.refused) continue;
      return {kind: 'abstractive', summary: reply.text};
    } catch (err) {
      const failure = err as grpc.ServiceError;
      if (String(failure.details).includes('refused')) continue;
      break;
    }
  }
  return {kind: 'abstractive', summary: content.slice(0, 400) || 'summary unavailable'};
}
`,
      solution: `/** Summarize over gRPC: a deadline, terminal refusals, and a labelled extractive fallback. */
import * as grpc from '@grpc/grpc-js';

import type {SummaryModelClient} from './client_pb';

const DEADLINE_S = 5;
const MAX_ATTEMPTS = 3;
const EXTRACT_CHARS = 1200;
const OUTPUT_ABSTRACTIVE = 'abstractive';
const OUTPUT_EXTRACTIVE = 'extractive';
const REFUSED = 'REFUSED';
const TERMINAL_CODES: Record<number, true> = {
  [grpc.status.INVALID_ARGUMENT]: true,
  [grpc.status.PERMISSION_DENIED]: true,
};
const RETRYABLE_CODES: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

export interface SummaryResult {
  kind: string;
  summary: string;
  extractive_chars?: number;
  model_version?: string | null;
}

/** The source's own words, cut at a sentence boundary when one is close enough. */
function trimExtract(content: string, chars: number = EXTRACT_CHARS): string {
  const head = content.slice(0, chars).trim();
  if (content.length <= chars) return head;
  const stop = Math.max(head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'));
  return (stop > 0 ? head.slice(0, stop + 1) : head) + '…';
}

/** Abstractive when the model answers; a labelled extractive fallback when it cannot. */
export async function summarizeWithModel(
  client: SummaryModelClient,
  content: string,
  band: string,
): Promise<SummaryResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await client.summarize({content, band}, {deadline: Date.now() + DEADLINE_S * 1000});
      return {kind: OUTPUT_ABSTRACTIVE, summary: reply.text, model_version: reply.modelVersion};
    } catch (err) {
      const failure = err as grpc.ServiceError;
      const refused = String(failure.details ?? '').includes(REFUSED);
      if (refused || TERMINAL_CODES[failure.code] === true) {
        console.info({code: failure.code, refused}, 'model call terminal; not retrying');
        break;
      }
      if (RETRYABLE_CODES[failure.code] !== true) break;
    }
  }
  return {kind: OUTPUT_EXTRACTIVE, summary: trimExtract(content), extractive_chars: EXTRACT_CHARS};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"google.golang.org/grpc"
	pb "summarizer/modelpb"
)

type Result struct {
	Kind    string \`json:"kind"\`
	Summary string \`json:"summary"\`
}

// summarizeWithModel asks the model for a summary. The model-generated draft loops until it gets one.
func summarizeWithModel(ctx context.Context, client pb.SummaryModelClient, content, band string) Result {
	// TODO: this draft calls the model with no deadline and retries every failure — refusals
	// included — in an unbounded loop, then returns a slice of the source labelled abstractive (or
	// the sentence "summary unavailable") as if it were a summary. Review all four.
	for {
		reply, err := client.Summarize(ctx, &pb.SummarizeRequest{Content: content, Band: band})
		if err == nil {
			if reply.Refused {
				continue
			}
			return Result{Kind: "abstractive", Summary: reply.Text}
		}
		log.Printf("model call failed: %v", err)
		if grpc.Code(err).String() == "Unavailable" {
			continue
		}
		break
	}
	if len(content) > 400 {
		return Result{Kind: "abstractive", Summary: content[:400]}
	}
	return Result{Kind: "abstractive", Summary: "summary unavailable"}
}
`,
      solution: `package main

import (
	"context"
	"log"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	pb "summarizer/modelpb"
)

const (
	deadlineSeconds = 5
	maxAttempts     = 3
	extractChars    = 1200
)

const (
	outputAbstractive = "abstractive"
	outputExtractive  = "extractive"
	Refused           = "REFUSED"
)

var terminalCodes = map[codes.Code]bool{codes.InvalidArgument: true, codes.PermissionDenied: true}
var retryableCodes = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type Result struct {
	Kind            string \`json:"kind"\`
	Summary         string \`json:"summary"\`
	ExtractiveChars int    \`json:"extractive_chars,omitempty"\`
	ModelVersion    string \`json:"model_version,omitempty"\`
}

// trimExtract cuts the source's own words at a sentence boundary when one is close enough.
func trimExtract(content string, chars int) string {
	head := strings.TrimSpace(content[:min(len(content), chars)])
	if len(content) <= chars {
		return head
	}
	stop := strings.LastIndexAny(head, ".!?")
	if stop > 0 {
		return head[:stop+1] + "…"
	}
	return head + "…"
}

// summarizeWithModel: abstractive when the model answers, a labelled extractive fallback when not.
func summarizeWithModel(ctx context.Context, client pb.SummaryModelClient, content, band string) Result {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, time.Duration(deadlineSeconds)*time.Second)
		reply, err := client.Summarize(attemptCtx, &pb.SummarizeRequest{Content: content, Band: band})
		cancel()
		if err == nil {
			if reply.Refused {
				log.Printf("model refused; terminal")
				break
			}
			return Result{Kind: outputAbstractive, Summary: reply.Text, ModelVersion: reply.ModelVersion}
		}
		code := status.Code(err)
		if strings.Contains(status.Convert(err).Message(), Refused) || terminalCodes[code] {
			log.Printf("model call terminal code=%s; not retrying", code)
			break
		}
		if !retryableCodes[code] {
			break
		}
		log.Printf("model attempt %d/%d failed: %s", attempt+1, maxAttempts, code)
	}
	return Result{Kind: outputExtractive, Summary: trimExtract(content, extractChars), ExtractiveChars: extractChars}
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannel

object SummaryClient {

  case class Result(kind: String, summary: String)

  /** Ask the model for a summary. The model-generated draft loops until it gets one. */
  def summarizeWithModel(stub: SummaryModelGrpc.SummaryModelStub, content: String, band: String): Result = {
    // TODO: this draft calls the model with no deadline and retries every failure — refusals
    // included — in an unbounded loop, then returns a slice of the source labelled abstractive (or
    // the sentence "summary unavailable") as if it were a summary. Review all four.
    var result: Option[Result] = None
    while (result.isEmpty) {
      try {
        val reply = stub.summarize(SummarizeRequest(content = content, band = band))
        if (!reply.refused) result = Some(Result("abstractive", reply.text))
      } catch {
        case err: io.grpc.StatusRuntimeException =>
          println(s"model call failed: \${err.getStatus}")
          if (!err.getStatus.getDescription.contains("refused")) {
            result = Some(Result("abstractive", "summary unavailable"))
          }
      }
    }
    result.get
  }
}
`,
      solution: `import io.grpc.StatusRuntimeException

import java.util.concurrent.TimeUnit
import scala.util.control.NonFatal

object SummaryClient {

  val DeadlineSeconds = 5L
  val MaxAttempts = 3
  val ExtractChars = 1200
  val OutputAbstractive = "abstractive"
  val OutputExtractive = "extractive"
  val Refused = "REFUSED"
  val TerminalCodes = Set(io.grpc.Status.Code.INVALID_ARGUMENT, io.grpc.Status.Code.PERMISSION_DENIED)
  val RetryableCodes = Set(io.grpc.Status.Code.UNAVAILABLE, io.grpc.Status.Code.DEADLINE_EXCEEDED)

  case class Result(kind: String, summary: String, extractiveChars: Option[Int], modelVersion: Option[String])

  /** The source's own words, cut at a sentence boundary when one is close enough. */
  def trimExtract(content: String, chars: Int = ExtractChars): String = {
    val head = content.take(chars).trim
    if (content.length <= chars) head
    else {
      val stop = List(head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?')).max
      (if (stop > 0) head.take(stop + 1) else head) + "…"
    }
  }

  /** Abstractive when the model answers; a labelled extractive fallback when it cannot. */
  def summarizeWithModel(stub: SummaryModelGrpc.SummaryModelStub, content: String, band: String): Result = {
    var attempt = 0
    var done = false
    var answer: Option[Result] = None
    while (attempt < MaxAttempts && !done) {
      attempt += 1
      try {
        val call = stub.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
        val reply = call.summarize(SummarizeRequest(content = content, band = band))
        if (reply.refused) {
          println("model refused; terminal")
          done = true
        } else {
          answer = Some(Result(OutputAbstractive, reply.text, None, Some(reply.modelVersion)))
          done = true
        }
      } catch {
        case err: StatusRuntimeException =>
          val refused = Option(err.getStatus.getDescription).exists(_.contains(Refused))
          if (refused || TerminalCodes.contains(err.getStatus.getCode)) done = true
          else if (!RetryableCodes.contains(err.getStatus.getCode)) done = true
          else println(s"model attempt $attempt/$MaxAttempts failed: \${err.getStatus.getCode}")
        case NonFatal(err) =>
          println(s"model call failed: $err")
          done = true
      }
    }
    answer.getOrElse(Result(OutputExtractive, trimExtract(content), Some(ExtractChars), None))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "model.grpc.pb.h"

#include <iostream>
#include <string>

struct Result {
  std::string kind;
  std::string summary;
};

// summarize_with_model asks the model for a summary. The model-generated draft loops until it gets one.
Result summarize_with_model(std::shared_ptr<SummaryModel::Stub> stub, const std::string& content, const std::string& band) {
  // TODO: this draft calls the model with no deadline and retries every failure — refusals
  // included — in an unbounded loop, then returns a slice of the source labelled abstractive (or
  // the sentence "summary unavailable") as if it were a summary. Review all four.
  while (true) {
    grpc::ClientContext context;
    SummarizeRequest request;
    request.set_content(content);
    request.set_band(band);
    SummarizeReply reply;
    const auto status = stub->Summarize(&context, request, &reply);
    if (status.ok()) {
      if (reply.refused()) continue;
      return Result{"abstractive", reply.text()};
    }
    std::clog << "model call failed: " << status.error_message() << "\\n";
    if (status.error_message().find("refused") != std::string::npos) continue;
    break;
  }
  return Result{"abstractive", content.substr(0, 400).empty() ? "summary unavailable" : content.substr(0, 400)};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "model.grpc.pb.h"

#include <chrono>
#include <iostream>
#include <set>
#include <string>

constexpr int kDeadlineSeconds = 5;
constexpr int kMaxAttempts = 3;
constexpr std::size_t kExtractChars = 1200;

const char* kOutputAbstractive = "abstractive";
const char* kOutputExtractive = "extractive";
const char* Refused = "REFUSED";

static const std::set<grpc::StatusCode> kTerminalCodes = {grpc::StatusCode::INVALID_ARGUMENT,
                                                          grpc::StatusCode::PERMISSION_DENIED};
static const std::set<grpc::StatusCode> kRetryableCodes = {grpc::StatusCode::UNAVAILABLE,
                                                           grpc::StatusCode::DEADLINE_EXCEEDED};

struct Result {
  std::string kind;
  std::string summary;
  std::size_t extractive_chars = 0;
};

/// The source's own words, cut at a sentence boundary when one is close enough.
static std::string trim_extract(const std::string& content) {
  const std::string head = content.substr(0, std::min(content.size(), kExtractChars));
  if (content.size() <= kExtractChars) return head;
  const auto stop = head.find_last_of(".!?");
  if (stop != std::string::npos && stop > 0) return head.substr(0, stop + 1) + "…";
  return head + "…";
}

/// Abstractive when the model answers; a labelled extractive fallback when it cannot.
Result summarize_with_model(const std::shared_ptr<SummaryModel::Stub>& stub, const std::string& content,
                            const std::string& band) {
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
    SummarizeRequest request;
    request.set_content(content);
    request.set_band(band);
    SummarizeReply reply;
    const auto status = stub->Summarize(&context, request, &reply);
    if (status.ok()) {
      if (reply.refused()) {
        std::clog << "model refused; terminal\\n";
        break;
      }
      return Result{kOutputAbstractive, reply.text(), 0};
    }
    const bool refused = status.error_message().find(Refused) != std::string::npos;
    if (refused || kTerminalCodes.count(status.error_code()) == 1) {
      std::clog << "model call terminal; not retrying\\n";
      break;
    }
    if (kRetryableCodes.count(status.error_code()) == 0) break;
    std::clog << "model attempt " << attempt + 1 << "/" << kMaxAttempts << " failed\\n";
  }
  return Result{kOutputExtractive, trim_extract(content), kExtractChars};
}
`,
    },
  },
  hints: [
    'Put a deadline on the call, not around it: a per-attempt timeout means a hung provider costs five seconds, while a wall-clock check leaves the call running and the connection occupied.',
    'A refusal is an answer, not a failure. Classify the status before you loop — `REFUSED`/terminal codes stop immediately, only `UNAVAILABLE`/`DEADLINE_EXCEEDED` are worth another attempt, and three attempts is the whole budget.',
    'The fallback must be honest in two ways: the text is a trimmed extract of the source (so nothing is invented), and `kind` says `extractive`. Never label an extract `abstractive`, and never return a placeholder sentence as a summary.',
  ],
  debrief: `The interview question behind this step is what a service owes its caller when the model does not
answer. Three answers are wrong in the same way: retrying a refusal (the provider already decided),
retrying forever (the request has a caller with a timeout), and returning a sentence that reads like
a summary but is not one. The right answer has two halves — a bounded failure policy and an output
contract. The deadline is the first half: five seconds per attempt, so a hung provider is a slow
response rather than a stuck worker. The classification is the second: terminal failures are
terminal, and only the two codes that mean "try again" get retried. The fallback is where the honesty
lives: the source's own words, trimmed to a known size, labelled extractive, so a reader knows the
model did not write that paragraph and a metrics dashboard can count how often it happens. Real
systems add per-provider breakers, a token-budget check before the call, extractive fallbacks ranked
by sentence salience, and a label on the summary record itself so a stored summary can never be
mistaken for a generated one.`,
};
