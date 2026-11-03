import type {Step} from '@/lib/types';

export const fimCallStep: Step = {
  id: 'fim-call',
  title: 'Complete: fill-in-the-middle under a 300 ms deadline, n generated, ≤ n shown',
  concept: 'grpc',
  file: 'fim_call',
  focus: ['api', 'model'],
  task: `## Task

**Starting point.** The starter implements \`complete(prefix, suffix, snippets, language)\`: it
builds one prompt string, calls \`Complete\` on the model service at \`model:9000\`, loops on
failure and returns the first candidate's text. When the model service is healthy it serves the
demo. It hides four flaws.

**Failure mode the checks target.** The glued prompt is a silent quality regression; with no
deadline a slow call holds a worker after the editor moved on; retrying everything multiplies a bad
request; the raw first candidate can be empty or half-finished.

- Send \`prefix\` and \`suffix\` as **separate fields** (fill-in-the-middle).
- Every attempt carries a **300 ms** deadline (\`DEADLINE_MS\`).
- At most **2 attempts** (\`MAX_ATTEMPTS\`), retrying only \`UNAVAILABLE\`.
- Ask for **3 candidates** (\`N_CANDIDATES\`); \`filter_candidates\` drops empty or whitespace-only
  text, \`truncated\` candidates and duplicates after trimming, keeping the model's order.`,
  sequence: {
    participants: ['completiond', 'Model service'],
    messages: [
      {
        from: 'completiond',
        to: 'Model service',
        label: 'Complete{prefix, suffix, snippets, n: 3} · deadline 300 ms',
        kind: 'sync',
      },
      {from: 'Model service', to: 'completiond', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'completiond', to: 'Model service', label: 'Complete · attempt 2 of 2', kind: 'sync'},
      {from: 'Model service', to: 'completiond', label: '3 candidates · one truncated', kind: 'reply'},
      {from: 'completiond', to: 'completiond', label: 'filter_candidates → ≤ 3 shown', kind: 'sync'},
    ],
  },
  hints: [
    'Suggestions ignore the code below the cursor, a slow model pins a worker for seconds, a malformed request is sent five times, and ghost text sometimes shows an empty or half-cut line.',
    'The prompt is `prefix + suffix` in one field with an empty suffix, the call has no deadline, the loop retries any error up to five times, and the return is a bare `candidates[0]`.',
    'Set `prefix` and `suffix` separately, pass the 300 ms deadline on the call, loop at most `MAX_ATTEMPTS = 2` and only on `UNAVAILABLE`, request `N_CANDIDATES` and return `filter_candidates(...)`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 300 ms deadline',
      detail:
        'The call is created with a 300 ms deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, a context with timeout, `withDeadlineAfter`, `set_deadline`. Without it a slow model holds the worker long after the editor discarded the reply.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.3/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*300/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadlineMS\s*=\s*300/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineMs\s*=\s*300/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*300/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-once',
      title: 'At most two attempts, only on UNAVAILABLE',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 2` and only `UNAVAILABLE` is retried; every other status is returned immediately. The starter retries every error five times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2/, /StatusCode\.UNAVAILABLE/], none: [/range\(5\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2/, /status\.UNAVAILABLE/], none: [/attempt\s*<\s*5/]},
        go: {all: [/maxAttempts\s*=\s*2/, /codes\.Unavailable/], none: [/attempt\s*<\s*5/]},
        scala: {all: [/MaxAttempts\s*=\s*2/, /Code\.UNAVAILABLE/], none: [/attempt\s*<\s*5/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2/, /StatusCode::UNAVAILABLE/], none: [/attempt\s*<\s*5/]},
      },
    },
    {
      id: 'fim-order',
      title: 'Sends prefix and suffix as separate fields',
      detail:
        'The request sets `prefix` and `suffix` separately so the model fills in the middle. The starter concatenates `prefix + suffix` into the prefix field and sends an empty suffix.',
      match: {
        python: {all: [/prefix\s*=\s*prefix/, /suffix\s*=\s*suffix/], none: [/prefix\s*\+\s*suffix/]},
        typescript: {all: [/\{prefix,\s*suffix,/], none: [/prefix\s*\+\s*suffix/]},
        go: {all: [/Prefix:\s*prefix/, /Suffix:\s*suffix/], none: [/prefix\s*\+\s*suffix/]},
        scala: {all: [/prefix\s*=\s*prefix/, /suffix\s*=\s*suffix/], none: [/prefix\s*\+\s*suffix/]},
        cpp: {all: [/set_prefix\(prefix\)/, /set_suffix\(suffix\)/], none: [/prefix\s*\+\s*suffix/]},
      },
    },
    {
      id: 'filter',
      title: 'Generates 3 candidates and shows at most 3 after filtering',
      detail:
        'The request asks for `N_CANDIDATES = 3`; `filter_candidates` drops empty, `truncated` and duplicate candidates and returns at most n in the model’s order. The starter asks for one and shows it unchecked.',
      match: {
        python: {all: [/N_CANDIDATES\s*=\s*3/, /def filter_candidates\(/, /\.truncated/], none: [/candidates\[0\]/]},
        typescript: {
          all: [/N_CANDIDATES\s*=\s*3/, /function filterCandidates\(/, /\.truncated/],
          none: [/candidates\[0\]/],
        },
        go: {all: [/nCandidates\s*=\s*3/, /func filterCandidates\(/, /\.Truncated/], none: [/Candidates\[0\]/]},
        scala: {all: [/NCandidates\s*=\s*3/, /def filterCandidates\(/, /\.truncated/], none: [/candidates\.head/]},
        cpp: {all: [/kNCandidates\s*=\s*3/, /filterCandidates\(/, /\.truncated\(\)/], none: [/candidates\(0\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import completion_pb2
import completion_pb2_grpc

channel = grpc.insecure_channel("model:9000")
model = completion_pb2_grpc.CompletionStub(channel)


def complete(prefix: str, suffix: str, snippets: list[str], language: str) -> list[str]:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    prompt = "\\n".join(snippets) + "\\n" + prefix + suffix
    for _ in range(5):
        try:
            request = completion_pb2.CompleteRequest(prefix=prompt, suffix="", n=1, language=language)
            reply = model.Complete(request)
            return [reply.candidates[0].text]
        except grpc.RpcError:
            continue
    return []
`,
      solution: `import grpc

import completion_pb2
import completion_pb2_grpc

DEADLINE_S = 0.3
MAX_ATTEMPTS = 2
N_CANDIDATES = 3

channel = grpc.insecure_channel("model:9000")
model = completion_pb2_grpc.CompletionStub(channel)


def filter_candidates(candidates) -> list[str]:
    """n generated, at most n shown: drop empty, truncated and duplicate candidates, keep the order."""
    shown: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = candidate.text.strip()
        if key == "" or candidate.truncated or key in seen:
            continue
        seen.add(key)
        shown.append(candidate.text)
    return shown


def complete(prefix: str, suffix: str, snippets: list[str], language: str) -> list[str]:
    request = completion_pb2.CompleteRequest(
        prefix=prefix, suffix=suffix, snippets=snippets, n=N_CANDIDATES, language=language
    )
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = model.Complete(request, timeout=DEADLINE_S)
            return filter_candidates(reply.candidates)
        except grpc.RpcError as exc:
            if exc.code() != grpc.StatusCode.UNAVAILABLE or attempt == MAX_ATTEMPTS - 1:
                raise
    return []
`,
    },
    typescript: {
      starter: `/** Model call: the starter. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface Candidate {
  text: string;
  truncated: boolean;
}

interface CompleteRequest {
  prefix: string;
  suffix: string;
  snippets: string[];
  n: number;
  language: string;
}

interface CompletionClient {
  Complete(
    request: CompleteRequest,
    callback: (error: grpc.ServiceError | null, reply: {candidates: Candidate[]}) => void,
  ): void;
}

const {completion} = grpc.loadPackageDefinition(protoLoader.loadSync('completion.proto')) as unknown as {
  completion: {Completion: new (target: string, credentials: grpc.ChannelCredentials) => CompletionClient};
};
const model = new completion.Completion('model:9000', grpc.credentials.createInsecure());

export async function complete(prefix: string, suffix: string, snippets: string[], language: string): Promise<string[]> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const prompt = snippets.join('\\n') + '\\n' + prefix + suffix;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reply = await new Promise<{candidates: Candidate[]}>((resolve, reject) => {
        model.Complete({prefix: prompt, suffix: '', snippets: [], n: 1, language}, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });
      return [reply.candidates[0].text];
    } catch {
      continue;
    }
  }
  return [];
}
`,
      solution: `/** Model call: fill-in-the-middle under a 300 ms deadline, one retry on UNAVAILABLE, n generated, ≤ n shown. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 300;
const MAX_ATTEMPTS = 2;
const N_CANDIDATES = 3;

interface Candidate {
  text: string;
  truncated: boolean;
}

interface CompleteRequest {
  prefix: string;
  suffix: string;
  snippets: string[];
  n: number;
  language: string;
}

interface CompletionClient {
  Complete(
    request: CompleteRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: {candidates: Candidate[]}) => void,
  ): void;
}

const {completion} = grpc.loadPackageDefinition(protoLoader.loadSync('completion.proto')) as unknown as {
  completion: {Completion: new (target: string, credentials: grpc.ChannelCredentials) => CompletionClient};
};
const model = new completion.Completion('model:9000', grpc.credentials.createInsecure());

/** n generated, at most n shown: drop empty, truncated and duplicate candidates, keep the order. */
function filterCandidates(candidates: Candidate[]): string[] {
  const shown: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.text.trim();
    if (key === '' || candidate.truncated || seen.has(key)) continue;
    seen.add(key);
    shown.push(candidate.text);
  }
  return shown;
}

function callOnce(request: CompleteRequest): Promise<{candidates: Candidate[]}> {
  return new Promise((resolve, reject) => {
    model.Complete(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

export async function complete(prefix: string, suffix: string, snippets: string[], language: string): Promise<string[]> {
  const request: CompleteRequest = {prefix, suffix, snippets, n: N_CANDIDATES, language};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await callOnce(request);
      return filterCandidates(reply.candidates);
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (serviceError.code !== grpc.status.UNAVAILABLE || attempt === MAX_ATTEMPTS - 1) throw serviceError;
    }
  }
  return [];
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strings"

	pb "completiond/completionpb"
)

var model pb.CompletionClient

// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
func complete(ctx context.Context, prefix, suffix string, snippets []string, language string) ([]string, error) {
	prompt := strings.Join(snippets, "\\n") + "\\n" + prefix + suffix
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		var reply *pb.CompleteReply
		reply, err = model.Complete(ctx, &pb.CompleteRequest{Prefix: prompt, Suffix: "", N: 1, Language: language})
		if err != nil {
			continue
		}
		return []string{reply.Candidates[0].Text}, nil
	}
	return nil, err
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "completiond/completionpb"
)

const (
	deadlineMS  = 300
	maxAttempts = 2
	nCandidates = 3
)

var model pb.CompletionClient

// filterCandidates: n generated, at most n shown — drop empty, truncated and duplicate candidates, keep the order.
func filterCandidates(candidates []*pb.Candidate) []string {
	shown := make([]string, 0, len(candidates))
	seen := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		key := strings.TrimSpace(candidate.Text)
		if key == "" || candidate.Truncated || seen[key] {
			continue
		}
		seen[key] = true
		shown = append(shown, candidate.Text)
	}
	return shown
}

func complete(ctx context.Context, prefix, suffix string, snippets []string, language string) ([]string, error) {
	request := &pb.CompleteRequest{Prefix: prefix, Suffix: suffix, Snippets: snippets, N: nCandidates, Language: language}
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, callErr := model.Complete(callCtx, request)
		cancel()
		if callErr == nil {
			return filterCandidates(reply.Candidates), nil
		}
		err = callErr
		if status.Code(callErr) != codes.Unavailable {
			return nil, callErr
		}
	}
	return nil, err
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object FimCall {
  val stub = CompletionGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())

  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  def complete(prefix: String, suffix: String, snippets: Seq[String], language: String): List[String] = {
    val prompt = snippets.mkString("\\n") + "\\n" + prefix + suffix
    var attempt = 0
    var shown: List[String] = Nil
    var done = false
    while (attempt < 5 && !done) {
      try {
        val reply = stub.complete(CompleteRequest(prefix = prompt, suffix = "", n = 1, language = language))
        shown = List(reply.candidates.head.text)
        done = true
      } catch {
        case _: StatusRuntimeException => attempt += 1
      }
    }
    shown
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object FimCall {
  val DeadlineMs = 300L
  val MaxAttempts = 2
  val NCandidates = 3

  val stub = CompletionGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())

  /** n generated, at most n shown: drop empty, truncated and duplicate candidates, keep the order. */
  def filterCandidates(candidates: Seq[Candidate]): List[String] = {
    val seen = scala.collection.mutable.HashSet.empty[String]
    candidates.flatMap { candidate =>
      val key = candidate.text.trim
      if (key.isEmpty || candidate.truncated || !seen.add(key)) None else Some(candidate.text)
    }.toList
  }

  def complete(prefix: String, suffix: String, snippets: Seq[String], language: String): List[String] = {
    val request =
      CompleteRequest(prefix = prefix, suffix = suffix, snippets = snippets, n = NCandidates, language = language)
    var attempt = 0
    while (true) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).complete(request)
        return filterCandidates(reply.candidates)
      } catch {
        case exc: StatusRuntimeException =>
          attempt += 1
          if (exc.getStatus.getCode != Status.Code.UNAVAILABLE || attempt >= MaxAttempts) throw exc
      }
    }
    Nil
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "completion.grpc.pb.h"

#include <memory>
#include <string>
#include <vector>

std::unique_ptr<Completion::Stub> model;

// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
std::vector<std::string> complete(
    const std::string& prefix,
    const std::string& suffix,
    const std::vector<std::string>& snippets,
    const std::string& language) {
  std::string prompt;
  for (const auto& snippet : snippets) prompt += snippet + "\\n";
  prompt += prefix + suffix;
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    CompleteRequest request;
    request.set_prefix(prompt);
    request.set_suffix("");
    request.set_n(1);
    request.set_language(language);
    CompleteReply reply;
    const grpc::Status status = model->Complete(&ctx, request, &reply);
    if (status.ok()) return {reply.candidates(0).text()};
  }
  return {};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "completion.grpc.pb.h"

#include <chrono>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 300;
constexpr int kMaxAttempts = 2;
constexpr int kNCandidates = 3;

std::unique_ptr<Completion::Stub> model;

std::string trimmed(const std::string& text) {
  const auto first = text.find_first_not_of(" \\t\\r\\n");
  if (first == std::string::npos) return "";
  const auto last = text.find_last_not_of(" \\t\\r\\n");
  return text.substr(first, last - first + 1);
}

// n generated, at most n shown: drop empty, truncated and duplicate candidates, keep the order.
std::vector<std::string> filterCandidates(const CompleteReply& reply) {
  std::vector<std::string> shown;
  std::set<std::string> seen;
  for (const auto& candidate : reply.candidates()) {
    const auto key = trimmed(candidate.text());
    if (key.empty() || candidate.truncated() || !seen.insert(key).second) continue;
    shown.push_back(candidate.text());
  }
  return shown;
}

std::vector<std::string> complete(
    const std::string& prefix,
    const std::string& suffix,
    const std::vector<std::string>& snippets,
    const std::string& language) {
  CompleteRequest request;
  request.set_prefix(prefix);
  request.set_suffix(suffix);
  for (const auto& snippet : snippets) request.add_snippets(snippet);
  request.set_n(kNCandidates);
  request.set_language(language);
  grpc::Status last;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    CompleteReply reply;
    last = model->Complete(&ctx, request, &reply);
    if (last.ok()) return filterCandidates(reply);
    if (last.error_code() != grpc::StatusCode::UNAVAILABLE) break;
  }
  throw std::runtime_error("model call failed: " + last.error_message());
}
`,
    },
  },
  debrief: `The fix separates what the model is for from what its worst case costs. Prefix and suffix travel as two fields because GitHub's post reports that telling the model which side of the cursor each piece is on, instead of handing it a document that ends at the cursor, raised acceptance by 10 %; the glued prompt undoes that silently. The deadline, the two-attempt bound and the UNAVAILABLE-only retry set describe the worst case: one keystroke costs at most 600 ms of model time, and a request the model rejected is not sent again. The filter is the "n generated, at most n shown" rule from the same diagram, and in the real product that slot also holds the contextual filter model. Production clients add jittered backoff, a breaker per model deployment, and a prompt-hash cache so the same window does not pay twice.`,
};
