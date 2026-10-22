import type {Step} from '@/lib/types';

export const fimCallStep: Step = {
  id: 'fim-call',
  title: 'Complete: fill-in-the-middle under a 300 ms deadline, n generated, ≤ n shown',
  concept: 'grpc',
  file: 'fim_call',
  focus: ['api', 'model'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the model service is
healthy it returns a completion, so the demo passes. It hides four flaws: the prompt it builds, the
call it makes, the way it retries, and what it shows. Review it, fix it, and prove the fix.

Implement \`complete(prefix, suffix, snippets, language)\` for the model service at \`model:9000\`:

- **Fill-in-the-middle.** The request carries \`prefix\` and \`suffix\` as **separate fields** —
  the model is told which side of the cursor each piece is on and generates what goes between
  them. Gluing the suffix onto the prefix hands the model a document with the cursor at the end
  and loses the code after it, which is the 10 % of acceptance FIM bought.
- Every attempt carries a **300 ms** deadline (\`DEADLINE_MS\`): a completion that arrives after
  the developer typed the next character is thrown away by the editor anyway.
- At most **2 attempts** (\`MAX_ATTEMPTS\`), and only \`UNAVAILABLE\` is retried; every other
  status is returned to the caller at once. A model that answered \`INVALID_ARGUMENT\` will answer
  it again, and five attempts at 300 ms is a 1.5 s keystroke.
- Ask for **3 candidates** (\`N_CANDIDATES\`) and show at most 3: \`filter_candidates\` drops
  empty or whitespace-only text, candidates the model marked \`truncated\` (cut by the token
  limit mid-statement), and duplicates after trimming, keeping the model's order.

**Failure mode the checks target.** The glued prompt is a silent quality regression nobody files
a bug for; the missing deadline lets one slow model call hold a worker while the editor has moved
on; the retry-everything loop multiplies a bad request by five; and showing the raw first candidate
puts an empty or half-finished line in front of the developer.`,
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
    'The proto has a field for each side of the cursor: set `prefix` and `suffix` separately and leave the assembly to the model. Any `prefix + suffix` in this file is the bug.',
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`). Bound the attempts with `MAX_ATTEMPTS = 2` and compare the status code against `UNAVAILABLE` before looping; anything else is raised immediately.',
    'Request `n = N_CANDIDATES` and post-process: trim, skip empty, skip `truncated`, skip anything already seen, keep the order. The result is a list of at most n — never a bare `candidates[0]`.',
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
        'Attempts are bounded by `MAX_ATTEMPTS = 2` and only `UNAVAILABLE` is retried; every other status is returned immediately. The draft retries every error five times.',
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
        'The request sets `prefix` and `suffix` separately so the model fills in the middle. The draft concatenates `prefix + suffix` into the prefix field and sends an empty suffix.',
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
        'The request asks for `N_CANDIDATES = 3`; `filter_candidates` drops empty, `truncated` and duplicate candidates and returns at most n in the model’s order. The draft asks for one and shows it unchecked.',
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
    # TODO: this draft glues the suffix onto the prefix so the model cannot fill in the middle,
    # calls without a deadline, retries every failure five times, and shows the first candidate
    # even when it is empty or cut off. Review all four.
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
      starter: `/** Model call: a model-generated draft that glues the suffix onto the prefix and retries everything. */
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
  // TODO: this draft glues the suffix onto the prefix so the model cannot fill in the middle,
  // calls without a deadline, retries every failure five times, and shows the first candidate
  // even when it is empty or cut off. Review all four.
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

// TODO: this draft glues the suffix onto the prefix so the model cannot fill in the middle,
// calls without a deadline, retries every failure five times, and shows the first candidate
// even when it is empty or cut off. Review all four.
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

  // TODO: this draft glues the suffix onto the prefix so the model cannot fill in the middle,
  // calls without a deadline, retries every failure five times, and shows the first candidate
  // even when it is empty or cut off. Review all four.
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

// TODO: this draft glues the suffix onto the prefix so the model cannot fill in the middle,
// calls without a deadline, retries every failure five times, and shows the first candidate
// even when it is empty or cut off. Review all four.
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
  debrief: `The interviewer is probing two things at once: do you know what the model call is for, and what its worst case is. The FIM flaw is the first: GitHub's post explains that telling the model which side of the cursor is which, instead of feeding it a document that ends at the cursor, raised acceptance by 10 %, and the draft quietly undoes it. The deadline, the bounded retry and the retryable set are the worst-case answers: one attempt is bounded at 300 ms, the call at two attempts, and only a model that says it is unavailable is asked again. The filter is the product answer from the same diagram — n completions are generated and at most n are shown — and it is where real systems put the contextual filter model and the public-code filter. Production clients add jittered backoff, a breaker per model deployment, and a cache keyed by a hash of the prompt so the same window never pays for the same completion twice.`,
};
