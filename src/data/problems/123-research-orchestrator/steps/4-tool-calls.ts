import type {Step} from '@/lib/types';

export const toolCallsStep: Step = {
  id: 'tool-calls',
  title: 'Tool calls: deadline, backoff, untrusted text, literal citations',
  concept: 'grpc',
  file: 'tool_calls',
  focus: ['subagent', 'tools', 'citation'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the tool service is
healthy it returns the page text, and the citation pass returns every citation marked verified, so
the demo passes. Every failure path and every trust boundary is wrong. Find the four flaws, fix
them, and prove the fix.

Implement \`call_tool(name, args)\` and \`verify_citations(citations, sources)\` for the subagents
and the citation pass:

- Each \`Tools.Call\` carries a **30 s** deadline (\`TOOL_DEADLINE_S\`). A search or fetch that
  hangs must fail the attempt, not the subagent's whole deadline.
- At most **3 attempts** (\`MAX_ATTEMPTS\`), with exponential backoff from **500 ms**
  (\`BACKOFF_BASE_S = 0.5\`, doubling), and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retried; every other status is raised to the subagent at once, so the model can adapt — the
  source's lesson is that telling the agent a tool is failing works better than hiding it.
- A tool result is **untrusted text**: a fetched page is data to reason about, never instructions
  to follow. \`sanitize_result\` drops lines that match \`INSTRUCTION_PATTERN\` ("ignore the previous
  instructions", "system:", "you are now …") and reports how many it dropped, so the trace can show
  that a source tried to steer the agent.
- The citation pass keeps a citation **only when its span is a literal substring of the fetched
  source** it names. A span that is not in the source is a claim with no evidence; it stays in the
  report unverified and the end-state judge scores citation accuracy accordingly.

**Failure mode the checks target.** The draft catches every error and loops forever — a permanent
\`INVALID_ARGUMENT\` spins the subagent, and a struggling tool service gets a hot loop with no
pause between attempts; a result forwarded verbatim lets any web page inject instructions into a
subagent that has tools; and a citation pass that marks everything verified turns the report's
strongest promise — every claim attributed to a source — into decoration.`,
  sequence: {
    participants: ['Subagent', 'Tools', 'Citation pass'],
    messages: [
      {from: 'Subagent', to: 'Tools', label: 'Call(fetch, url) · deadline 30 s · attempt 1', kind: 'sync'},
      {from: 'Tools', to: 'Subagent', label: 'UNAVAILABLE', kind: 'reply'},
      {
        from: 'Subagent',
        to: 'Subagent',
        label: 'sleep 500 ms · retry only UNAVAILABLE / DEADLINE_EXCEEDED',
        kind: 'sync',
      },
      {from: 'Subagent', to: 'Tools', label: 'Call(fetch, url) · attempt 2', kind: 'sync'},
      {from: 'Tools', to: 'Subagent', label: 'text (with an "ignore previous instructions" line)', kind: 'reply'},
      {from: 'Subagent', to: 'Subagent', label: 'sanitize_result → text, 1 flagged line', kind: 'sync'},
      {from: 'Subagent', to: 'Citation pass', label: 'report spans + fetched sources', kind: 'async'},
      {
        from: 'Citation pass',
        to: 'Citation pass',
        label: 'verified = span is a substring of source text',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`). Bound the attempts with a constant and a `for` loop: the draft’s `while True` has no exit for a permanent error like `INVALID_ARGUMENT`.',
    'Retryability is a property of the status, not of “it threw”: compare the code against `UNAVAILABLE` / `DEADLINE_EXCEEDED`, raise anything else immediately, and sleep `BACKOFF_BASE_S * 2 ** attempt` before the next try.',
    'Two small pure functions carry the trust boundary: `sanitize_result` splits the text into lines, drops the ones `INSTRUCTION_PATTERN` matches and counts them; `verify_citations` sets `verified` to whether the span is a substring (`in`, `includes`, `strings.Contains`, `contains`, `find`) of the named source’s text.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every Tools.Call carries a 30 s deadline',
      detail:
        'The call is created with `TOOL_DEADLINE_S = 30` — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + TOOL_DEADLINE_MS`. Without it a hung fetch holds the subagent for its whole deadline.',
      match: {
        python: {all: [/TOOL_DEADLINE_S\s*=\s*30/, /timeout=TOOL_DEADLINE_S/, /\.Call\(/]},
        typescript: {
          all: [/TOOL_DEADLINE_MS\s*=\s*30_?000/, /deadline:\s*Date\.now\(\)\s*\+\s*TOOL_DEADLINE_MS/, /\.Call\(/],
        },
        go: {all: [/toolDeadlineS\s*=\s*30/, /context\.WithTimeout/, /\.Call\(/]},
        scala: {all: [/ToolDeadlineS\s*=\s*30/, /withDeadlineAfter/, /\.call\(/]},
        cpp: {all: [/kToolDeadlineS\s*=\s*30/, /set_deadline\(/, /->Call\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'At most three attempts, only the two retryable codes',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 3` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; there is no unbounded retry loop. The draft retries every error forever.',
      match: {
        python: {
          all: [
            /MAX_ATTEMPTS\s*=\s*3/,
            /range\(MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/, /for\s*\{/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'backoff',
      title: 'Backs off exponentially from 500 ms between attempts',
      detail:
        'A retry waits `BACKOFF_BASE_S = 0.5` seconds doubled per attempt before the next call. The draft retries immediately, turning a struggling tool service into a hot loop.',
      match: {
        python: {all: [/BACKOFF_BASE_S\s*=\s*0\.5/, /sleep\(/]},
        typescript: {all: [/BACKOFF_BASE_MS\s*=\s*500/, /setTimeout\(/]},
        go: {all: [/backoffBase\s*=\s*500\s*\*\s*time\.Millisecond/, /time\.Sleep\(/]},
        scala: {all: [/BackoffBaseMs\s*=\s*500/, /Thread\.sleep\(/]},
        cpp: {all: [/kBackoffBaseMs\s*=\s*500/, /sleep_for\(/]},
      },
    },
    {
      id: 'untrusted-text',
      title: 'Strips and counts instruction-like lines from tool results',
      detail:
        '`sanitize_result` drops every line matching `INSTRUCTION_PATTERN` and returns the count, so a page that says "ignore the previous instructions" never reaches the model as text it might follow. The draft forwards the result verbatim.',
      match: {
        python: {all: [/INSTRUCTION_PATTERN/, /sanitize_result\(/]},
        typescript: {all: [/INSTRUCTION_PATTERN/, /sanitizeResult\(/]},
        go: {all: [/instructionPattern/, /sanitizeResult\(/]},
        scala: {all: [/InstructionPattern/, /sanitizeResult\(/]},
        cpp: {all: [/kInstructionPattern/, /sanitizeResult\(/]},
      },
    },
    {
      id: 'literal-citation',
      title: 'Verifies a citation only when its span is in the fetched source',
      detail:
        '`verify_citations` marks a citation verified only when `span` is a literal substring of the named source’s text. The draft marks every citation verified without looking.',
      match: {
        python: {all: [/def verify_citations\(/, /\.span\s+in\s+/]},
        typescript: {all: [/function verifyCitations\(/, /\.includes\(/]},
        go: {all: [/func verifyCitations\(/, /strings\.Contains\(/]},
        scala: {all: [/def verifyCitations\(/, /\.contains\(/]},
        cpp: {all: [/verifyCitations\(/, /\.find\(/, /npos/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from dataclasses import dataclass

import grpc

import tools_pb2
import tools_pb2_grpc

channel = grpc.insecure_channel("tools:9000")
tools = tools_pb2_grpc.ToolsStub(channel)


@dataclass
class ToolResult:
    text: str
    source_id: str
    flagged_lines: int = 0


@dataclass
class Citation:
    span: str
    source_id: str
    verified: bool = False


def call_tool(name: str, args: dict) -> ToolResult:
    # TODO: add the 30 s deadline, bound the attempts to 3 with backoff and retry only
    # UNAVAILABLE / DEADLINE_EXCEEDED, treat the result as untrusted text, and make the citation
    # pass check the span against the source. Review all four.
    while True:
        try:
            reply = tools.Call(tools_pb2.CallRequest(name=name, args=args))
            return ToolResult(text=reply.text, source_id=reply.source_id)
        except grpc.RpcError:
            continue


def verify_citations(citations: list[Citation], sources: dict[str, str]) -> list[Citation]:
    return [Citation(citation.span, citation.source_id, True) for citation in citations]
`,
      solution: `import re
import time
from dataclasses import dataclass

import grpc

import tools_pb2
import tools_pb2_grpc

TOOL_DEADLINE_S = 30
MAX_ATTEMPTS = 3
BACKOFF_BASE_S = 0.5
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
INSTRUCTION_PATTERN = re.compile(
    r"^\\s*(ignore|disregard|forget)\\b.*\\b(previous|prior|above|all)\\b|^\\s*(system|assistant)\\s*:|\\byou are now\\b",
    re.IGNORECASE,
)

channel = grpc.insecure_channel("tools:9000")
tools = tools_pb2_grpc.ToolsStub(channel)


@dataclass
class ToolResult:
    text: str
    source_id: str
    flagged_lines: int = 0


@dataclass
class Citation:
    span: str
    source_id: str
    verified: bool = False


def sanitize_result(text: str) -> tuple[str, int]:
    """The result without instruction-like lines, and how many were dropped."""
    kept: list[str] = []
    flagged = 0
    for line in text.splitlines():
        if INSTRUCTION_PATTERN.search(line):
            flagged += 1
        else:
            kept.append(line)
    return "\\n".join(kept), flagged


def call_tool(name: str, args: dict) -> ToolResult:
    last_error: grpc.RpcError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = tools.Call(tools_pb2.CallRequest(name=name, args=args), timeout=TOOL_DEADLINE_S)
            text, flagged = sanitize_result(reply.text)
            return ToolResult(text=text, source_id=reply.source_id, flagged_lines=flagged)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                raise
            last_error = exc
            time.sleep(BACKOFF_BASE_S * (2**attempt))
    raise last_error or RuntimeError("tool unavailable")


def verify_citations(citations: list[Citation], sources: dict[str, str]) -> list[Citation]:
    """Each citation marked verified only when its span is literally in the fetched source."""
    return [
        Citation(citation.span, citation.source_id, citation.span in sources.get(citation.source_id, ""))
        for citation in citations
    ]
`,
    },
    typescript: {
      starter: `/** Tool calls: a model-generated draft that retries forever and trusts every result and citation. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface CallReply {
  text: string;
  source_id: string;
}

interface ToolsClient {
  Call(
    request: {name: string; args: Record<string, string>},
    callback: (error: grpc.ServiceError | null, reply: CallReply) => void,
  ): void;
}

const {tools} = grpc.loadPackageDefinition(protoLoader.loadSync('tools.proto')) as unknown as {
  tools: {Tools: new (target: string, credentials: grpc.ChannelCredentials) => ToolsClient};
};
const client = new tools.Tools('tools:9000', grpc.credentials.createInsecure());

export interface ToolResult {
  text: string;
  sourceId: string;
  flaggedLines: number;
}

export interface Citation {
  span: string;
  sourceId: string;
  verified: boolean;
}

export async function callTool(name: string, args: Record<string, string>): Promise<ToolResult> {
  // TODO: add the 30 s deadline, bound the attempts to 3 with backoff and retry only
  // UNAVAILABLE / DEADLINE_EXCEEDED, treat the result as untrusted text, and make the citation
  // pass check the span against the source. Review all four.
  for (;;) {
    try {
      const reply = await new Promise<CallReply>((resolve, reject) => {
        client.Call({name, args}, (error, result) => {
          if (error !== null) reject(error);
          else resolve(result);
        });
      });
      return {text: reply.text, sourceId: reply.source_id, flaggedLines: 0};
    } catch {
      continue;
    }
  }
}

export function verifyCitations(citations: Citation[], sources: Record<string, string>): Citation[] {
  return citations.map(citation => ({...citation, verified: true}));
}
`,
      solution: `/** Tool calls: 30 s deadline, three attempts with backoff, untrusted results, literal citations. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const TOOL_DEADLINE_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};
const INSTRUCTION_PATTERN = /^\\s*(ignore|disregard|forget)\\b.*\\b(previous|prior|above|all)\\b|^\\s*(system|assistant)\\s*:|\\byou are now\\b/i;

interface CallReply {
  text: string;
  source_id: string;
}

interface ToolsClient {
  Call(
    request: {name: string; args: Record<string, string>},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: CallReply) => void,
  ): void;
}

const {tools} = grpc.loadPackageDefinition(protoLoader.loadSync('tools.proto')) as unknown as {
  tools: {Tools: new (target: string, credentials: grpc.ChannelCredentials) => ToolsClient};
};
const client = new tools.Tools('tools:9000', grpc.credentials.createInsecure());

export interface ToolResult {
  text: string;
  sourceId: string;
  flaggedLines: number;
}

export interface Citation {
  span: string;
  sourceId: string;
  verified: boolean;
}

/** The result without instruction-like lines, and how many were dropped. */
function sanitizeResult(text: string): {text: string; flagged: number} {
  const kept: string[] = [];
  let flagged = 0;
  for (const line of text.split('\\n')) {
    if (INSTRUCTION_PATTERN.test(line)) flagged += 1;
    else kept.push(line);
  }
  return {text: kept.join('\\n'), flagged};
}

export async function callTool(name: string, args: Record<string, string>): Promise<ToolResult> {
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await new Promise<CallReply>((resolve, reject) => {
        client.Call({name, args}, new grpc.Metadata(), {deadline: Date.now() + TOOL_DEADLINE_MS}, (error, result) => {
          if (error !== null) reject(error);
          else resolve(result);
        });
      });
      const clean = sanitizeResult(reply.text);
      return {text: clean.text, sourceId: reply.source_id, flaggedLines: clean.flagged};
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (RETRYABLE[serviceError.code] !== true) throw serviceError;
      lastError = serviceError;
      await new Promise(resolve => setTimeout(resolve, BACKOFF_BASE_MS * 2 ** attempt));
    }
  }
  throw lastError ?? new Error('tool unavailable');
}

/** Each citation marked verified only when its span is literally in the fetched source. */
export function verifyCitations(citations: Citation[], sources: Record<string, string>): Citation[] {
  return citations.map(citation => ({
    ...citation,
    verified: (sources[citation.sourceId] ?? '').includes(citation.span),
  }));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "researchd/toolspb"
)

type ToolResult struct {
	Text         string
	SourceID     string
	FlaggedLines int
}

type Citation struct {
	Span     string
	SourceID string
	Verified bool
}

// TODO: add the 30 s deadline, bound the attempts to 3 with backoff and retry only
// UNAVAILABLE / DEADLINE_EXCEEDED, treat the result as untrusted text, and make the citation
// pass check the span against the source. Review all four.
func callTool(ctx context.Context, client pb.ToolsClient, name string, args map[string]string) (ToolResult, error) {
	for {
		reply, err := client.Call(ctx, &pb.CallRequest{Name: name, Args: args})
		if err != nil {
			continue
		}
		return ToolResult{Text: reply.Text, SourceID: reply.SourceId}, nil
	}
}

func verifyCitations(citations []Citation, sources map[string]string) []Citation {
	out := make([]Citation, 0, len(citations))
	for _, citation := range citations {
		citation.Verified = true
		out = append(out, citation)
	}
	return out
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "researchd/toolspb"
)

const (
	toolDeadlineS = 30
	maxAttempts   = 3
	backoffBase   = 500 * time.Millisecond
)

var (
	retryable          = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}
	instructionPattern = regexp.MustCompile(\`(?i)^\\s*(ignore|disregard|forget)\\b.*\\b(previous|prior|above|all)\\b|^\\s*(system|assistant)\\s*:|\\byou are now\\b\`)
)

type ToolResult struct {
	Text         string
	SourceID     string
	FlaggedLines int
}

type Citation struct {
	Span     string
	SourceID string
	Verified bool
}

// sanitizeResult returns the result without instruction-like lines, and how many were dropped.
func sanitizeResult(text string) (string, int) {
	var kept []string
	flagged := 0
	for _, line := range strings.Split(text, "\\n") {
		if instructionPattern.MatchString(line) {
			flagged++
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\\n"), flagged
}

func callOnce(ctx context.Context, client pb.ToolsClient, name string, args map[string]string) (*pb.CallReply, error) {
	callCtx, cancel := context.WithTimeout(ctx, toolDeadlineS*time.Second)
	defer cancel()
	return client.Call(callCtx, &pb.CallRequest{Name: name, Args: args})
}

func callTool(ctx context.Context, client pb.ToolsClient, name string, args map[string]string) (ToolResult, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reply, err := callOnce(ctx, client, name, args)
		if err == nil {
			text, flagged := sanitizeResult(reply.Text)
			return ToolResult{Text: text, SourceID: reply.SourceId, FlaggedLines: flagged}, nil
		}
		if !retryable[status.Code(err)] {
			return ToolResult{}, err
		}
		lastErr = err
		time.Sleep(backoffBase * (1 << attempt))
	}
	if lastErr == nil {
		lastErr = errors.New("tool unavailable")
	}
	return ToolResult{}, lastErr
}

// verifyCitations marks a citation verified only when its span is literally in the fetched source.
func verifyCitations(citations []Citation, sources map[string]string) []Citation {
	out := make([]Citation, 0, len(citations))
	for _, citation := range citations {
		citation.Verified = strings.Contains(sources[citation.SourceID], citation.Span)
		out = append(out, citation)
	}
	return out
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

final case class ToolResult(text: String, sourceId: String, flaggedLines: Int = 0)
final case class Citation(span: String, sourceId: String, verified: Boolean = false)

object ToolCalls {
  val stub = ToolsGrpc.blockingStub(ManagedChannelBuilder.forAddress("tools", 9000).usePlaintext().build())

  // TODO: add the 30 s deadline, bound the attempts to 3 with backoff and retry only
  // UNAVAILABLE / DEADLINE_EXCEEDED, treat the result as untrusted text, and make the citation
  // pass check the span against the source. Review all four.
  def callTool(name: String, args: Map[String, String]): ToolResult = {
    var result: Option[ToolResult] = None
    while (result.isEmpty) {
      try {
        val reply = stub.call(CallRequest(name = name, args = args))
        result = Some(ToolResult(reply.text, reply.sourceId))
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    result.get
  }

  def verifyCitations(citations: List[Citation], sources: Map[String, String]): List[Citation] =
    citations.map(_.copy(verified = true))
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class ToolResult(text: String, sourceId: String, flaggedLines: Int = 0)
final case class Citation(span: String, sourceId: String, verified: Boolean = false)

object ToolCalls {
  val ToolDeadlineS = 30L
  val MaxAttempts = 3
  val BackoffBaseMs = 500L
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val InstructionPattern =
    "(?i)^\\\\s*(ignore|disregard|forget)\\\\b.*\\\\b(previous|prior|above|all)\\\\b|^\\\\s*(system|assistant)\\\\s*:|\\\\byou are now\\\\b".r

  val stub = ToolsGrpc.blockingStub(ManagedChannelBuilder.forAddress("tools", 9000).usePlaintext().build())

  /** The result without instruction-like lines, and how many were dropped. */
  def sanitizeResult(text: String): (String, Int) = {
    val (flagged, kept) = text.split("\\n", -1).partition(line => InstructionPattern.findFirstIn(line).isDefined)
    (kept.mkString("\\n"), flagged.length)
  }

  def callTool(name: String, args: Map[String, String]): ToolResult = {
    var lastError: Option[StatusRuntimeException] = None
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(ToolDeadlineS, TimeUnit.SECONDS).call(CallRequest(name = name, args = args))
        val (text, flagged) = sanitizeResult(reply.text)
        return ToolResult(text, reply.sourceId, flagged)
      } catch {
        case exc: StatusRuntimeException =>
          if (!Retryable.contains(exc.getStatus.getCode)) throw exc
          lastError = Some(exc)
          Thread.sleep(BackoffBaseMs * (1L << attempt))
      }
      attempt += 1
    }
    throw lastError.getOrElse(new RuntimeException("tool unavailable"))
  }

  /** Each citation marked verified only when its span is literally in the fetched source. */
  def verifyCitations(citations: List[Citation], sources: Map[String, String]): List[Citation] =
    citations.map(citation => citation.copy(verified = sources.getOrElse(citation.sourceId, "").contains(citation.span)))
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "tools.grpc.pb.h"

#include <map>
#include <string>
#include <vector>

struct ToolResult {
  std::string text;
  std::string source_id;
  int flagged_lines = 0;
};

struct Citation {
  std::string span;
  std::string source_id;
  bool verified = false;
};

// TODO: add the 30 s deadline, bound the attempts to 3 with backoff and retry only
// UNAVAILABLE / DEADLINE_EXCEEDED, treat the result as untrusted text, and make the citation
// pass check the span against the source. Review all four.
ToolResult callTool(Tools::Stub* stub, const std::string& name, const std::map<std::string, std::string>& args) {
  while (true) {
    grpc::ClientContext ctx;
    CallRequest request;
    request.set_name(name);
    for (const auto& [key, value] : args) (*request.mutable_args())[key] = value;
    CallReply reply;
    const grpc::Status status = stub->Call(&ctx, request, &reply);
    if (status.ok()) return ToolResult{reply.text(), reply.source_id(), 0};
  }
}

std::vector<Citation> verifyCitations(const std::vector<Citation>& citations, const std::map<std::string, std::string>& sources) {
  std::vector<Citation> out;
  for (const auto& citation : citations) out.push_back(Citation{citation.span, citation.source_id, true});
  return out;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "tools.grpc.pb.h"

#include <chrono>
#include <map>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

constexpr int kToolDeadlineS = 30;
constexpr int kMaxAttempts = 3;
constexpr int kBackoffBaseMs = 500;
const std::regex kInstructionPattern(
    R"(^\\s*(ignore|disregard|forget)\\b.*\\b(previous|prior|above|all)\\b|^\\s*(system|assistant)\\s*:|\\byou are now\\b)",
    std::regex::icase);

struct ToolResult {
  std::string text;
  std::string source_id;
  int flagged_lines = 0;
};

struct Citation {
  std::string span;
  std::string source_id;
  bool verified = false;
};

bool retryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::UNAVAILABLE ||
         status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// The result without instruction-like lines, and how many were dropped.
std::pair<std::string, int> sanitizeResult(const std::string& text) {
  std::istringstream in(text);
  std::string line;
  std::string kept;
  int flagged = 0;
  while (std::getline(in, line)) {
    if (std::regex_search(line, kInstructionPattern)) {
      flagged++;
      continue;
    }
    if (!kept.empty()) kept += "\\n";
    kept += line;
  }
  return {kept, flagged};
}

ToolResult callTool(Tools::Stub* stub, const std::string& name, const std::map<std::string, std::string>& args) {
  grpc::Status last_status;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kToolDeadlineS));
    CallRequest request;
    request.set_name(name);
    for (const auto& [key, value] : args) (*request.mutable_args())[key] = value;
    CallReply reply;
    const grpc::Status status = stub->Call(&ctx, request, &reply);
    if (status.ok()) {
      auto [text, flagged] = sanitizeResult(reply.text());
      return ToolResult{text, reply.source_id(), flagged};
    }
    if (!retryable(status)) throw std::runtime_error("tool failed: " + status.error_message());
    last_status = status;
    std::this_thread::sleep_for(std::chrono::milliseconds(kBackoffBaseMs * (1 << attempt)));
  }
  throw std::runtime_error("tool unavailable: " + last_status.error_message());
}

// Each citation marked verified only when its span is literally in the fetched source.
std::vector<Citation> verifyCitations(const std::vector<Citation>& citations, const std::map<std::string, std::string>& sources) {
  std::vector<Citation> out;
  for (const auto& citation : citations) {
    const auto source = sources.find(citation.source_id);
    const bool verified = source != sources.end() && source->second.find(citation.span) != std::string::npos;
    out.push_back(Citation{citation.span, citation.source_id, verified});
  }
  return out;
}
`,
    },
  },
  debrief: `The interviewer is probing two boundaries at once. The first is the worst case of a call: a deadline bounds one attempt, the attempt count bounds the call, the retryable set decides which failures are worth another try, and the backoff keeps three subagents retrying in step from becoming a hot loop against the tool service. The source's advice — tell the agent a tool is failing and let it adapt — only works if a permanent error reaches it instead of being swallowed by a retry loop. The second is trust: a tool result is text from the outside world, and a subagent with tools will act on instructions it reads unless the system makes the distinction for it. Stripping and counting instruction-like lines is a crude filter, and that is the point — it is deterministic, traceable and testable, where "the model will know" is none of those. The literal-substring citation check is the same idea applied to the output: the report's promise that every claim is attributed is only worth something if attribution is verified against what was actually fetched. Real systems add jitter to the backoff, per-tool concurrency limits, a content-type allowlist on fetches, and a citation pass that also normalises whitespace and quotes before comparing.`,
};
