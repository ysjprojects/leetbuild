import type {Step} from '@/lib/types';

export const fimCallStep: Step = {
  id: 'fim-call',
  title: 'Complete: fill-in-the-middle under a 300 ms deadline, n generated, ≤ n shown',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'fim_call',
  focus: ['api', 'model'],
  task: `## Task

**Starting point.** The starter implements \`complete(prefix, suffix, snippets, language)\`, the
call the endpoint makes: it glues the snippets, the prefix and the suffix into one \`prefix\` field,
calls \`Complete\` on the model service at \`model:9000\` with an empty \`suffix\` and \`n: 1\`, retries
any error up to five times and returns the first candidate's text. When the model is healthy it
serves the demo. It hides four flaws.

**Failure mode the checks target.** The glued prompt makes the model complete the end of the file
instead of the gap at the cursor; with no deadline a slow model holds the request long after the
editor moved on; retrying every status multiplies a bad request; the raw first candidate can be
empty or cut off.

- Send \`prefix\`, \`suffix\` and \`snippets\` as **separate fields** (fill-in-the-middle).
- Every attempt carries its own full **300 ms** deadline (\`DEADLINE_MS\`), the retry included.
- At most **2 attempts** (\`MAX_ATTEMPTS\`), the second only after \`UNAVAILABLE\`; any other failure
  returns \`[]\` (no ghost text this keystroke).
- Ask for **3 candidates** (\`N_CANDIDATES\`); \`filter_candidates\` drops empty or whitespace-only
  text, \`truncated\` candidates and duplicates after trimming both ends, in the model's order.`,
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
    'Suggestions ignore the code below the cursor, a slow model keeps requests open for seconds, a rejected request is sent five times, and the ghost text is sometimes empty or cut off.',
    'The request puts `prefix + suffix` in one field with an empty suffix, the call has no deadline, the loop catches every `RpcError`, and the return is `candidates[0]` unchecked with `n=1`.',
    'Build `CompleteRequest(prefix=prefix, suffix=suffix, snippets=snippets, n=N_CANDIDATES)`, call with `timeout=DEADLINE_S`, loop `MAX_ATTEMPTS = 2` retrying only `UNAVAILABLE`, and return `filter_candidates(reply.candidates)`.',
  ],
  checks: [
    {
      id: 'fim-order',
      title: 'Sends prefix and suffix as separate fields',
      detail:
        'The request carries the code before the cursor in `prefix`, the code after it in `suffix` and the snippets in `snippets`, so the model fills the gap. The starter glues everything into `prefix` and sends an empty suffix.',
      match: {
        python: {
          all: [/prefix\s*=\s*prefix/, /suffix\s*=\s*suffix/, /snippets\s*=\s*snippets/],
          none: [/prefix\s*\+\s*suffix/],
        },
        typescript: {all: [/\{\s*prefix,\s*suffix,\s*snippets/], none: [/prefix\s*\+\s*suffix/]},
        go: {all: [/Prefix:\s*prefix/, /Suffix:\s*suffix/, /Snippets:\s*snippets/], none: [/prefix\s*\+\s*suffix/]},
        cpp: {
          all: [/set_prefix\(\s*prefix\s*\)/, /set_suffix\(\s*suffix\s*\)/, /add_snippets\(/],
          none: [/prefix\s*\+\s*suffix/],
        },
      },
    },
    {
      id: 'deadline',
      title: 'Every attempt carries a 300 ms deadline',
      detail:
        'Each `Complete` call is made with its own 300 ms deadline, the retry after a late `UNAVAILABLE` included, so a slow model ends in `DEADLINE_EXCEEDED` and no ghost text instead of holding the request after the editor moved on. The starter calls with no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.3/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*300/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*300\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^)]*deadline\)/]},
        cpp: {all: [/kDeadline\{300\}|kDeadline\s*=\s*std::chrono::milliseconds\(300\)/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-once',
      title: 'At most two attempts, only after UNAVAILABLE',
      detail:
        'A call is retried once, and only when it ended `UNAVAILABLE`; a deadline or any other status (`INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`, `INTERNAL`, `UNKNOWN`, `PERMISSION_DENIED` are checked) returns `[]` at once. The starter retries every error up to five times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2/, /StatusCode\.UNAVAILABLE/], none: [/range\(\s*5\s*\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2/, /status\.UNAVAILABLE/], none: [/attempt\s*<\s*5/]},
        go: {all: [/maxAttempts\s*=\s*2/, /codes\.Unavailable/], none: [/attempt\s*<\s*5/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2/, /StatusCode::UNAVAILABLE/], none: [/attempt\s*<\s*5/]},
      },
    },
    {
      id: 'filter',
      title: 'Generates 3 candidates and shows the ones worth showing',
      detail:
        "The request asks for `N_CANDIDATES = 3`; `filter_candidates` drops empty or whitespace-only, `truncated` and duplicate candidates (compared after trimming both ends; a dropped truncated one does not hide a later complete copy) and keeps the model's order. The starter asks for one and shows it unchecked.",
      match: {
        python: {all: [/N_CANDIDATES\s*=\s*3/, /def filter_candidates\(/, /\.truncated/], none: [/candidates\[0\]/]},
        typescript: {
          all: [/N_CANDIDATES\s*=\s*3/, /function filterCandidates\(/, /\.truncated/],
          none: [/candidates\[0\]/],
        },
        go: {
          all: [/nCandidates\s*=\s*3/, /func filterCandidates\(/, /GetTruncated\(\)/],
          none: [/Candidates\(\)\[0\]|Candidates\[0\]/],
        },
        cpp: {all: [/kNCandidates\s*=\s*3/, /filterCandidates\(/, /\.truncated\(\)/], none: [/candidates\(0\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import copilot_context_pb2
import copilot_context_pb2_grpc

stub = copilot_context_pb2_grpc.ModelStub(grpc.insecure_channel("model:9000"))


def complete(prefix: str, suffix: str, snippets: list[str], language: str) -> list[str]:
    """The candidates to show as ghost text; [] when the model gives none."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    prompt = "\\n".join(snippets) + "\\n" + prefix + suffix
    request = copilot_context_pb2.CompleteRequest(prefix=prompt, suffix="", language=language, n=1)
    for _ in range(5):
        try:
            reply = stub.Complete(request)
        except grpc.RpcError:
            continue
        return [reply.candidates[0].text]
    return []
`,
      solution: `import logging

import grpc

import copilot_context_pb2
import copilot_context_pb2_grpc

logger = logging.getLogger("completiond.model")

DEADLINE_S = 0.3
MAX_ATTEMPTS = 2
N_CANDIDATES = 3

stub = copilot_context_pb2_grpc.ModelStub(grpc.insecure_channel("model:9000"))


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
    """The candidates to show as ghost text; [] when the model gives none."""
    request = copilot_context_pb2.CompleteRequest(
        prefix=prefix, suffix=suffix, snippets=snippets, language=language, n=N_CANDIDATES
    )
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Complete(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.UNAVAILABLE and attempt < MAX_ATTEMPTS:
                continue
            logger.warning("model call failed code=%s attempt=%d", exc.code().name, attempt)
            return []
        return filter_candidates(reply.candidates)
    return []
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface Candidate {
  text: string;
  truncated: boolean;
}
interface CompleteRequest {
  prefix: string;
  suffix: string;
  snippets: string[];
  language: string;
  n: number;
}
interface ModelClient {
  Complete(request: CompleteRequest, options?: {deadline: number}): Promise<{candidates: Candidate[]}>;
}

const {copilotctx} = grpc.loadPackageDefinition(protoLoader.loadSync('copilot_context.proto')) as unknown as {
  copilotctx: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new copilotctx.Model('model:9000', grpc.credentials.createInsecure());

/** The candidates to show as ghost text; [] when the model gives none. */
export async function complete(prefix: string, suffix: string, snippets: string[], language: string): Promise<string[]> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const prompt = snippets.join('\\n') + '\\n' + prefix + suffix;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reply = await stub.Complete({prefix: prompt, suffix: '', snippets: [], language, n: 1});
      return [reply.candidates[0].text];
    } catch {
      continue;
    }
  }
  return [];
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEADLINE_MS = 300;
export const MAX_ATTEMPTS = 2;
export const N_CANDIDATES = 3;

interface Candidate {
  text: string;
  truncated: boolean;
}
interface CompleteRequest {
  prefix: string;
  suffix: string;
  snippets: string[];
  language: string;
  n: number;
}
interface ModelClient {
  Complete(request: CompleteRequest, options?: {deadline: number}): Promise<{candidates: Candidate[]}>;
}

const {copilotctx} = grpc.loadPackageDefinition(protoLoader.loadSync('copilot_context.proto')) as unknown as {
  copilotctx: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new copilotctx.Model('model:9000', grpc.credentials.createInsecure());

/** n generated, at most n shown: drop empty, truncated and duplicate candidates, keep the order. */
export function filterCandidates(candidates: Candidate[]): string[] {
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

/** The candidates to show as ghost text; [] when the model gives none. */
export async function complete(prefix: string, suffix: string, snippets: string[], language: string): Promise<string[]> {
  const request = {prefix, suffix, snippets, language, n: N_CANDIDATES};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await stub.Complete(request, {deadline: Date.now() + DEADLINE_MS});
      return filterCandidates(reply.candidates ?? []);
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE && attempt < MAX_ATTEMPTS) continue;
      console.warn(\`model call failed code=\${code} attempt=\${attempt}\`);
      return [];
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

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "copilot/gen/copilot_context"
)

var conn, _ = grpc.NewClient("model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// complete is the candidates to show as ghost text; none when the model gives none.
func complete(ctx context.Context, prefix, suffix string, snippets []string, language string) []string {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	prompt := strings.Join(snippets, "\\n") + "\\n" + prefix + suffix
	req := &pb.CompleteRequest{Prefix: prompt, Suffix: "", Language: language, N: 1}
	for attempt := 0; attempt < 5; attempt++ {
		reply, err := stub.Complete(ctx, req)
		if err != nil {
			continue
		}
		return []string{reply.GetCandidates()[0].GetText()}
	}
	return []string{}
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
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "copilot/gen/copilot_context"
)

const (
	deadline    = 300 * time.Millisecond
	maxAttempts = 2
	nCandidates = 3
)

var conn, _ = grpc.NewClient("model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// filterCandidates is n generated, at most n shown: empty, truncated and duplicate candidates dropped, the order kept.
func filterCandidates(candidates []*pb.Candidate) []string {
	shown := []string{}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		key := strings.TrimSpace(candidate.GetText())
		if key == "" || candidate.GetTruncated() || seen[key] {
			continue
		}
		seen[key] = true
		shown = append(shown, candidate.GetText())
	}
	return shown
}

// complete is the candidates to show as ghost text; none when the model gives none.
func complete(ctx context.Context, prefix, suffix string, snippets []string, language string) []string {
	req := &pb.CompleteRequest{Prefix: prefix, Suffix: suffix, Snippets: snippets, Language: language, N: nCandidates}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Complete(callCtx, req)
		cancel()
		if err == nil {
			return filterCandidates(reply.GetCandidates())
		}
		if status.Code(err) == codes.Unavailable && attempt < maxAttempts {
			continue
		}
		log.Printf("model call failed code=%s attempt=%d", status.Code(err), attempt)
		return []string{}
	}
	return []string{}
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <memory>
#include <string>
#include <vector>

#include "copilot_context.grpc.pb.h"

auto stub = copilotctx::Model::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));

// The candidates to show as ghost text; none when the model gives none.
std::vector<std::string> complete(const std::string& prefix, const std::string& suffix, const std::vector<std::string>& snippets,
                                  const std::string& language) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  std::string prompt;
  for (const std::string& snippet : snippets) prompt += snippet + "\\n";
  prompt += prefix + suffix;
  copilotctx::CompleteRequest request;
  request.set_prefix(prompt);
  request.set_suffix("");
  request.set_language(language);
  request.set_n(1);
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    copilotctx::CompleteReply reply;
    if (!stub->Complete(&ctx, request, &reply).ok()) continue;
    return {reply.candidates(0).text()};
  }
  return {};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "copilot_context.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{300};
constexpr int kMaxAttempts = 2;
constexpr int kNCandidates = 3;

auto stub = copilotctx::Model::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));

// n generated, at most n shown: empty, truncated and duplicate candidates dropped, the order kept.
std::vector<std::string> filterCandidates(const copilotctx::CompleteReply& reply) {
  std::vector<std::string> shown;
  std::set<std::string> seen;
  for (const auto& candidate : reply.candidates()) {
    const std::string& text = candidate.text();
    const auto first = text.find_first_not_of(" \\t\\r\\n");
    if (first == std::string::npos || candidate.truncated()) continue;
    const std::string key = text.substr(first, text.find_last_not_of(" \\t\\r\\n") - first + 1);
    if (!seen.insert(key).second) continue;
    shown.push_back(text);
  }
  return shown;
}

// The candidates to show as ghost text; none when the model gives none.
std::vector<std::string> complete(const std::string& prefix, const std::string& suffix, const std::vector<std::string>& snippets,
                                  const std::string& language) {
  copilotctx::CompleteRequest request;
  request.set_prefix(prefix);
  request.set_suffix(suffix);
  for (const std::string& snippet : snippets) request.add_snippets(snippet);
  request.set_language(language);
  request.set_n(kNCandidates);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    copilotctx::CompleteReply reply;
    const grpc::Status status = stub->Complete(&ctx, request, &reply);
    if (status.ok()) return filterCandidates(reply);
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE && attempt < kMaxAttempts) continue;
    std::cerr << "model call failed code=" << status.error_code() << " attempt=" << attempt << "\\n";
    return {};
  }
  return {};
}
`,
    },
  },
  harness: {
    python: `import grpc

import copilot_context_pb2 as pb
import copilot_context_pb2_grpc as pb_grpc

TARGET = "model:9000"
PREFIX = "def load_user(conn, user_id):\\n    row = "
SUFFIX = "\\n    return User.from_row(row)\\n"
SNIPPETS = ["class User:\\n    user_id: int\\n"]
HEALTHY = [("cursor.fetchone()", False), ("cursor.fetchall()[0]", False), ("next(cursor)", False)]


class ModelPeer(pb_grpc.ModelServicer):
    """The stand-in model service: records every request, answers the candidates it was given, and can fail one call late (UNAVAILABLE after a stall)."""

    def __init__(self, ctx, candidates):
        self.ctx = ctx
        self.candidates = candidates
        self.requests = []
        self.stall = None

    def Complete(self, request, context):
        self.requests.append(request)
        if self.stall is not None:
            stall, self.stall = self.stall, None
            self.ctx.clock.advance(stall)  # the model restarts under the call
            context.abort(grpc.StatusCode.UNAVAILABLE, "model restarting")
        return pb.CompleteReply(candidates=[pb.Candidate(text=text, truncated=cut) for text, cut in self.candidates])


def _world(ctx, candidates=HEALTHY):
    peer = ModelPeer(ctx, candidates)
    ctx.grpc.serve(pb_grpc.add_ModelServicer_to_server, peer, TARGET)
    return ctx.load("fim_call"), peer


def _calls(ctx):
    return ctx.grpc.calls_to("Complete")


def check_fim_order(ctx):
    m, peer = _world(ctx)
    m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
    assert len(peer.requests) == 1, f"one Complete call expected, saw {len(peer.requests)}"
    sent = peer.requests[0]
    assert sent.prefix == PREFIX, f"the model's prefix must be the code before the cursor, got {sent.prefix!r}"
    assert sent.suffix == SUFFIX, f"the model's suffix must be the code after the cursor, got {sent.suffix!r}: glued into the prefix, the model completes the end of the file"
    assert list(sent.snippets) == SNIPPETS and sent.language == "python", f"snippets and language travel in their own fields, got {list(sent.snippets)} and {sent.language!r}"


def check_deadline(ctx):
    m, peer = _world(ctx)
    m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
    call = _calls(ctx)[0]
    assert call.timeout is not None, "the Complete call carries no deadline: a slow model holds the request after the editor moved on"
    assert 0.25 <= call.timeout <= 0.35, f"the deadline must be 300 ms, got {call.timeout} s"
    peer.stall = 0.2  # the first attempt fails UNAVAILABLE after 200 ms, the retry answers at once
    shown = m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
    calls = _calls(ctx)
    assert len(calls) == 3 and shown, f"an UNAVAILABLE after 200 ms earns one retry that succeeds: saw {len(calls) - 1} calls and {shown}"
    assert calls[2].timeout is not None and 0.25 <= calls[2].timeout <= 0.35, f"the retry must carry its own 300 ms deadline, got {calls[2].timeout} s: a deadline shared by both attempts leaves the retry what the first one did not use"
    ctx.grpc.set_latency("Complete", 2.0, TARGET)
    started = ctx.clock.offset
    shown = m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
    waited = ctx.clock.offset - started
    assert shown == [], f"a model that answers after the deadline must give no ghost text, got {shown}"
    assert waited <= 0.4, f"complete waited {waited:.2f} s on a model that takes 2 s: the deadline must cut it at 300 ms"
    assert len(_calls(ctx)) == 4 and _calls(ctx)[3].code == grpc.StatusCode.DEADLINE_EXCEEDED, f"the slow call must end DEADLINE_EXCEEDED and not be retried: {len(_calls(ctx)) - 3} calls"


def check_retry_once(ctx):
    m, peer = _world(ctx)
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, "model restarting", times=1, target=TARGET)
    shown = m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
    assert len(_calls(ctx)) == 2 and shown, f"one UNAVAILABLE earns one retry that succeeds: saw {len(_calls(ctx))} calls and {shown}"
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, "model down", times=2, target=TARGET)
    shown = m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
    assert len(_calls(ctx)) == 4, f"a model that stays UNAVAILABLE gets MAX_ATTEMPTS = 2 calls, saw {len(_calls(ctx)) - 2}"
    assert shown == [], f"after two UNAVAILABLE the keystroke gets no ghost text, got {shown}"
    ctx.grpc.fail("Complete", grpc.StatusCode.INVALID_ARGUMENT, "prompt too long", times=1, target=TARGET)
    shown = m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
    assert len(_calls(ctx)) == 5, f"INVALID_ARGUMENT is not transient: one call, no retry; saw {len(_calls(ctx)) - 4}"
    assert shown == [], f"a rejected request gives no ghost text, got {shown}"
    for code in (grpc.StatusCode.RESOURCE_EXHAUSTED, grpc.StatusCode.INTERNAL, grpc.StatusCode.UNKNOWN, grpc.StatusCode.PERMISSION_DENIED):
        before = len(_calls(ctx))
        ctx.grpc.fail("Complete", code, "refused", times=1, target=TARGET)
        shown = m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
        assert len(_calls(ctx)) - before == 1, f"{code.name} is not UNAVAILABLE: one call, no retry; saw {len(_calls(ctx)) - before}"
        assert shown == [], f"a call that ended {code.name} gives no ghost text, got {shown}"


def check_filter(ctx):
    candidates = [
        ("", False),
        ("   ", False),
        ("\\n\\t", False),
        ("cursor.fetchone()", False),
        ("cursor.fetchone()  ", False),
        ("cursor.close()", True),
        ("next(cursor)", False),
        ("\\tnext(cursor)", False),
        ("cursor.close()", False),
    ]
    m, peer = _world(ctx, candidates)
    shown = m.complete(PREFIX, SUFFIX, SNIPPETS, "python")
    assert peer.requests[0].n == 3, f"the request asked for {peer.requests[0].n} candidates, expected N_CANDIDATES = 3"
    assert shown == ["cursor.fetchone()", "next(cursor)", "cursor.close()"], f"empty or whitespace-only, truncated and duplicate (after trimming both ends) candidates must be dropped in the model's order; a truncated candidate does not hide a later complete one. Got {shown}"
`,
    typescript: `const TARGET = 'model:9000';
const PREFIX = 'def load_user(conn, user_id):\\n    row = ';
const SUFFIX = '\\n    return User.from_row(row)\\n';
const SNIPPETS = ['class User:\\n    user_id: int\\n'];
const HEALTHY = [{text: 'cursor.fetchone()', truncated: false}, {text: 'cursor.fetchall()[0]', truncated: false}, {text: 'next(cursor)', truncated: false}];

/** The stand-in model service at model:9000 (records every request, answers the candidates it was given, can fail one call late: UNAVAILABLE after a stall) and the learner's module. */
function world(ctx, candidates = HEALTHY) {
  const {copilotctx} = ctx.proto('copilot_context.proto');
  const requests = [];
  const late: {stall: number | null} = {stall: null};
  ctx.grpc.serve(
    copilotctx.Model.service,
    {
      Complete(call, callback) {
        requests.push(call.request);
        if (late.stall !== null) {
          ctx.clock.advance(late.stall); // the model restarts under the call
          late.stall = null;
          callback({code: ctx.grpc.status.UNAVAILABLE, details: 'model restarting'});
          return;
        }
        callback(null, {candidates});
      },
    },
    TARGET,
  );
  return {m: ctx.load('fim_call'), requests, late};
}

const calls = ctx => ctx.grpc.callsTo('Complete');

export async function check_fim_order(ctx) {
  const {m, requests} = world(ctx);
  await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
  assert.equal(requests.length, 1, \`one Complete call expected, saw \${requests.length}\`);
  const sent = requests[0];
  assert.equal(sent.prefix, PREFIX, \`the model's prefix must be the code before the cursor, got \${JSON.stringify(sent.prefix)}\`);
  assert.equal(sent.suffix, SUFFIX, \`the model's suffix must be the code after the cursor, got \${JSON.stringify(sent.suffix)}: glued into the prefix, the model completes the end of the file\`);
  assert(JSON.stringify(sent.snippets) === JSON.stringify(SNIPPETS) && sent.language === 'python', \`snippets and language travel in their own fields, got \${JSON.stringify(sent.snippets)} and \${sent.language}\`);
}

export async function check_deadline(ctx) {
  const {m, late} = world(ctx);
  await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
  const call = calls(ctx)[0];
  assert(call.timeout !== null, 'the Complete call carries no deadline: a slow model holds the request after the editor moved on');
  assert(call.timeout >= 0.25 && call.timeout <= 0.35, \`the deadline must be 300 ms, got \${call.timeout} s\`);
  late.stall = 0.2; // the first attempt fails UNAVAILABLE after 200 ms, the retry answers at once
  let shown = await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
  assert(calls(ctx).length === 3 && shown.length > 0, \`an UNAVAILABLE after 200 ms earns one retry that succeeds: saw \${calls(ctx).length - 1} calls and \${JSON.stringify(shown)}\`);
  const retry = calls(ctx)[2];
  assert(retry.timeout !== null && retry.timeout >= 0.25 && retry.timeout <= 0.35, \`the retry must carry its own 300 ms deadline, got \${retry.timeout} s: a deadline shared by both attempts leaves the retry what the first one did not use\`);
  ctx.grpc.setLatency('Complete', 2.0, TARGET);
  const started = ctx.clock.now();
  shown = await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
  const waited = (ctx.clock.now() - started) / 1000;
  assert.deepEqual(shown, [], \`a model that answers after the deadline must give no ghost text, got \${JSON.stringify(shown)}\`);
  assert(waited <= 0.4, \`complete waited \${waited.toFixed(2)} s on a model that takes 2 s: the deadline must cut it at 300 ms\`);
  assert(calls(ctx).length === 4 && calls(ctx)[3].code === ctx.grpc.status.DEADLINE_EXCEEDED, \`the slow call must end DEADLINE_EXCEEDED and not be retried: \${calls(ctx).length - 3} calls\`);
}

export async function check_retry_once(ctx) {
  const {m} = world(ctx);
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, 'model restarting', 1, TARGET);
  let shown = await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
  assert(calls(ctx).length === 2 && shown.length > 0, \`one UNAVAILABLE earns one retry that succeeds: saw \${calls(ctx).length} calls and \${JSON.stringify(shown)}\`);
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, 'model down', 2, TARGET);
  shown = await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
  assert.equal(calls(ctx).length, 4, \`a model that stays UNAVAILABLE gets MAX_ATTEMPTS = 2 calls, saw \${calls(ctx).length - 2}\`);
  assert.deepEqual(shown, [], \`after two UNAVAILABLE the keystroke gets no ghost text, got \${JSON.stringify(shown)}\`);
  ctx.grpc.fail('Complete', ctx.grpc.status.INVALID_ARGUMENT, 'prompt too long', 1, TARGET);
  shown = await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
  assert.equal(calls(ctx).length, 5, \`INVALID_ARGUMENT is not transient: one call, no retry; saw \${calls(ctx).length - 4}\`);
  assert.deepEqual(shown, [], \`a rejected request gives no ghost text, got \${JSON.stringify(shown)}\`);
  for (const name of ['RESOURCE_EXHAUSTED', 'INTERNAL', 'UNKNOWN', 'PERMISSION_DENIED']) {
    const before = calls(ctx).length;
    ctx.grpc.fail('Complete', ctx.grpc.status[name], 'refused', 1, TARGET);
    shown = await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
    assert.equal(calls(ctx).length - before, 1, \`\${name} is not UNAVAILABLE: one call, no retry; saw \${calls(ctx).length - before}\`);
    assert.deepEqual(shown, [], \`a call that ended \${name} gives no ghost text, got \${JSON.stringify(shown)}\`);
  }
}

export async function check_filter(ctx) {
  const candidates = [
    {text: '', truncated: false},
    {text: '   ', truncated: false},
    {text: '\\n\\t', truncated: false},
    {text: 'cursor.fetchone()', truncated: false},
    {text: 'cursor.fetchone()  ', truncated: false},
    {text: 'cursor.close()', truncated: true},
    {text: 'next(cursor)', truncated: false},
    {text: '\\tnext(cursor)', truncated: false},
    {text: 'cursor.close()', truncated: false},
  ];
  const {m, requests} = world(ctx, candidates);
  const shown = await m.complete(PREFIX, SUFFIX, SNIPPETS, 'python');
  assert.equal(requests[0].n, 3, \`the request asked for \${requests[0].n} candidates, expected N_CANDIDATES = 3\`);
  assert.deepEqual(shown, ['cursor.fetchone()', 'next(cursor)', 'cursor.close()'], \`empty or whitespace-only, truncated and duplicate (after trimming both ends) candidates must be dropped in the model's order; a truncated candidate does not hide a later complete one. Got \${JSON.stringify(shown)}\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	hstatus "google.golang.org/grpc/status"

	pb "copilot/gen/copilot_context"

	"leetbuild/harness"
)

const (
	kHFimTarget = "model:9000"
	kHFimPrefix = "def load_user(conn, user_id):\\n    row = "
	kHFimSuffix = "\\n    return User.from_row(row)\\n"
)

var hFimSnippets = []string{"class User:\\n    user_id: int\\n"}

// fimModel is the stand-in model service: records every request, answers the candidates it was given,
// and can fail one call late (UNAVAILABLE after a stall).
type HFimModel struct {
	pb.UnimplementedModelServer
	ctx        *harness.Ctx
	candidates []*pb.Candidate
	requests   []*pb.CompleteRequest
	stall      float64
}

func (m *HFimModel) Complete(_ context.Context, req *pb.CompleteRequest) (*pb.CompleteReply, error) {
	m.requests = append(m.requests, req)
	if m.stall > 0 {
		m.ctx.Clock.Advance(m.stall) // the model restarts under the call
		m.stall = 0
		return nil, hstatus.Error(codes.Unavailable, "model restarting")
	}
	return &pb.CompleteReply{Candidates: m.candidates}, nil
}

func hFimWorld(ctx *harness.Ctx, candidates []*pb.Candidate) *HFimModel {
	if candidates == nil {
		candidates = []*pb.Candidate{{Text: "cursor.fetchone()"}, {Text: "cursor.fetchall()[0]"}, {Text: "next(cursor)"}}
	}
	peer := &HFimModel{ctx: ctx, candidates: candidates}
	pb.RegisterModelServer(ctx.GRPC.Server(kHFimTarget), peer)
	return peer
}

func hFimCall() []string {
	return complete(context.Background(), kHFimPrefix, kHFimSuffix, hFimSnippets, "python")
}

func hFimCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Complete", "") }

func CheckFimOrder(ctx *harness.Ctx) {
	peer := hFimWorld(ctx, nil)
	hFimCall()
	ctx.Equal(len(peer.requests), 1, "one Complete call expected; calls")
	sent := peer.requests[0]
	ctx.Equal(sent.GetPrefix(), kHFimPrefix, "the model's prefix must be the code before the cursor")
	ctx.Equal(sent.GetSuffix(), kHFimSuffix, "the model's suffix must be the code after the cursor (glued into the prefix, the model completes the end of the file)")
	ctx.Assert(len(sent.GetSnippets()) == 1 && sent.GetSnippets()[0] == hFimSnippets[0] && sent.GetLanguage() == "python", "snippets and language travel in their own fields, got %q and %q", sent.GetSnippets(), sent.GetLanguage())
}

func CheckDeadline(ctx *harness.Ctx) {
	peer := hFimWorld(ctx, nil)
	hFimCall()
	call := hFimCalls(ctx)[0]
	ctx.Assert(call.HasDeadline(), "the Complete call carries no deadline: a slow model holds the request after the editor moved on")
	ctx.Assert(call.Timeout >= 250*time.Millisecond && call.Timeout <= 350*time.Millisecond, "the deadline must be 300 ms, got %v", call.Timeout)
	peer.stall = 0.2 // the first attempt fails UNAVAILABLE after 200 ms, the retry answers at once
	shown := hFimCall()
	calls := hFimCalls(ctx)
	ctx.Assert(len(calls) == 3 && len(shown) > 0, "an UNAVAILABLE after 200 ms earns one retry that succeeds: saw %d calls and %q", len(calls)-1, shown)
	ctx.Assert(len(calls) == 3 && calls[2].HasDeadline() && calls[2].Timeout >= 250*time.Millisecond && calls[2].Timeout <= 350*time.Millisecond, "the retry must carry its own 300 ms deadline, got %v: a deadline shared by both attempts leaves the retry what the first one did not use", calls[len(calls)-1].Timeout)
	ctx.GRPC.SetLatency("Complete", 2.0, kHFimTarget)
	started := ctx.Clock.Now()
	shown = hFimCall()
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Equal(len(shown), 0, "a model that answers after the deadline must give no ghost text; candidates shown")
	ctx.Assert(waited <= 0.4, "complete waited %.2f s on a model that takes 2 s: the deadline must cut it at 300 ms", waited)
	calls = hFimCalls(ctx)
	ctx.Assert(len(calls) == 4 && calls[3].Code == codes.DeadlineExceeded, "the slow call must end DEADLINE_EXCEEDED and not be retried: %d calls", len(calls)-3)
}

func CheckRetryOnce(ctx *harness.Ctx) {
	hFimWorld(ctx, nil)
	ctx.GRPC.Fail("Complete", codes.Unavailable, "model restarting", 1, kHFimTarget)
	shown := hFimCall()
	ctx.Assert(len(hFimCalls(ctx)) == 2 && len(shown) > 0, "one UNAVAILABLE earns one retry that succeeds: saw %d calls and %q", len(hFimCalls(ctx)), shown)
	ctx.GRPC.Fail("Complete", codes.Unavailable, "model down", 2, kHFimTarget)
	shown = hFimCall()
	ctx.Equal(len(hFimCalls(ctx)), 4, "a model that stays UNAVAILABLE gets maxAttempts = 2 calls; calls so far")
	ctx.Equal(len(shown), 0, "after two UNAVAILABLE the keystroke gets no ghost text; candidates shown")
	ctx.GRPC.Fail("Complete", codes.InvalidArgument, "prompt too long", 1, kHFimTarget)
	shown = hFimCall()
	ctx.Equal(len(hFimCalls(ctx)), 5, "INVALID_ARGUMENT is not transient: one call, no retry; calls so far")
	ctx.Equal(len(shown), 0, "a rejected request gives no ghost text; candidates shown")
	for _, code := range []codes.Code{codes.ResourceExhausted, codes.Internal, codes.Unknown, codes.PermissionDenied} {
		before := len(hFimCalls(ctx))
		ctx.GRPC.Fail("Complete", code, "refused", 1, kHFimTarget)
		shown = hFimCall()
		ctx.Equal(len(hFimCalls(ctx))-before, 1, "%v is not UNAVAILABLE: one call, no retry; calls", code)
		ctx.Equal(len(shown), 0, "a call that ended %v gives no ghost text; candidates shown", code)
	}
}

func CheckFilter(ctx *harness.Ctx) {
	peer := hFimWorld(ctx, []*pb.Candidate{
		{Text: ""}, {Text: "   "}, {Text: "\\n\\t"}, {Text: "cursor.fetchone()"}, {Text: "cursor.fetchone()  "}, {Text: "cursor.close()", Truncated: true},
		{Text: "next(cursor)"}, {Text: "\\tnext(cursor)"}, {Text: "cursor.close()"},
	})
	shown := hFimCall()
	ctx.Equal(peer.requests[0].GetN(), int32(3), "the request must ask for nCandidates = 3")
	ctx.Equal(shown, []string{"cursor.fetchone()", "next(cursor)", "cursor.close()"}, "empty or whitespace-only, truncated and duplicate (after trimming both ends) candidates must be dropped in the model's order; a truncated candidate does not hide a later complete one")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "copilot_context.grpc.pb.h"

namespace {

const std::string kHFimTarget = "model:9000";
const std::string kHFimPrefix = "def load_user(conn, user_id):\\n    row = ";
const std::string kHFimSuffix = "\\n    return User.from_row(row)\\n";
const std::vector<std::string> kHFimSnippets = {"class User:\\n    user_id: int\\n"};

// The stand-in model service: records every request, answers the candidates it was given, and can fail one call late (UNAVAILABLE after a stall).
class HFimModel final : public copilotctx::Model::Service {
 public:
  harness::Ctx* ctx = nullptr;
  double stall = 0;
  std::vector<std::pair<std::string, bool>> candidates;
  std::vector<copilotctx::CompleteRequest> requests;
  grpc::Status Complete(grpc::ServerContext*, const copilotctx::CompleteRequest* req, copilotctx::CompleteReply* reply) override {
    requests.push_back(*req);
    if (stall > 0) {
      ctx->Clock.Advance(stall);  // the model restarts under the call
      stall = 0;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "model restarting");
    }
    for (const auto& [text, truncated] : candidates) {
      auto* c = reply->add_candidates();
      c->set_text(text);
      c->set_truncated(truncated);
    }
    return grpc::Status::OK;
  }
};

HFimModel& hFimWorld(harness::Ctx& ctx, std::vector<std::pair<std::string, bool>> candidates = {
                                          {"cursor.fetchone()", false}, {"cursor.fetchall()[0]", false}, {"next(cursor)", false}}) {
  static HFimModel* peer = nullptr;
  delete peer;
  peer = new HFimModel();
  peer->ctx = &ctx;
  peer->candidates = std::move(candidates);
  ctx.GRPC.Server(kHFimTarget)->RegisterService(peer);
  return *peer;
}

std::vector<std::string> hFimCall() { return complete(kHFimPrefix, kHFimSuffix, kHFimSnippets, "python"); }

}  // namespace

void CheckFimOrder(harness::Ctx& ctx) {
  auto& peer = hFimWorld(ctx);
  hFimCall();
  ctx.Equal(peer.requests.size(), 1, "one Complete call expected; calls");
  const auto& sent = peer.requests[0];
  ctx.Equal(sent.prefix(), kHFimPrefix, "the model's prefix must be the code before the cursor");
  ctx.Equal(sent.suffix(), kHFimSuffix, "the model's suffix must be the code after the cursor (glued into the prefix, the model completes the end of the file)");
  ctx.Assert(sent.snippets_size() == 1 && sent.snippets(0) == kHFimSnippets[0] && sent.language() == "python",
             "snippets and language travel in their own fields, got %d snippets and %q", sent.snippets_size(), sent.language());
}

void CheckDeadline(harness::Ctx& ctx) {
  auto& peer = hFimWorld(ctx);
  hFimCall();
  const auto first = ctx.GRPC.CallsTo("Complete")[0];
  ctx.Assert(first.HasDeadline(), "the Complete call carries no deadline: a slow model holds the request after the editor moved on");
  ctx.Assert(first.TimeoutSeconds() >= 0.25 && first.TimeoutSeconds() <= 0.35, "the deadline must be 300 ms, got %vs", first.TimeoutSeconds());
  peer.stall = 0.2;  // the first attempt fails UNAVAILABLE after 200 ms, the retry answers at once
  auto shown = hFimCall();
  auto calls = ctx.GRPC.CallsTo("Complete");
  ctx.Assert(calls.size() == 3 && !shown.empty(), "an UNAVAILABLE after 200 ms earns one retry that succeeds: saw %d calls and %d candidates", calls.size() - 1, shown.size());
  const double retry_timeout = calls.back().HasDeadline() ? calls.back().TimeoutSeconds() : -1;
  ctx.Assert(calls.size() == 3 && retry_timeout >= 0.25 && retry_timeout <= 0.35, "the retry must carry its own 300 ms deadline, got %vs: a deadline shared by both attempts leaves the retry what the first one did not use", retry_timeout);
  ctx.GRPC.SetLatency("Complete", 2.0, kHFimTarget);
  const int64_t started = ctx.Clock.Now();
  shown = hFimCall();
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Equal(shown.size(), 0, "a model that answers after the deadline must give no ghost text; candidates shown");
  ctx.Assert(waited <= 0.4, "complete waited %.2f s on a model that takes 2 s: the deadline must cut it at 300 ms", waited);
  calls = ctx.GRPC.CallsTo("Complete");
  ctx.Assert(calls.size() == 4 && calls[3].Code == grpc::StatusCode::DEADLINE_EXCEEDED, "the slow call must end DEADLINE_EXCEEDED and not be retried: %d calls", calls.size() - 3);
}

void CheckRetryOnce(harness::Ctx& ctx) {
  hFimWorld(ctx);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "model restarting", 1, kHFimTarget);
  auto shown = hFimCall();
  ctx.Assert(ctx.GRPC.CallsTo("Complete").size() == 2 && !shown.empty(), "one UNAVAILABLE earns one retry that succeeds: saw %d calls and %d candidates", ctx.GRPC.CallsTo("Complete").size(), shown.size());
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "model down", 2, kHFimTarget);
  shown = hFimCall();
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 4, "a model that stays UNAVAILABLE gets kMaxAttempts = 2 calls; calls so far");
  ctx.Equal(shown.size(), 0, "after two UNAVAILABLE the keystroke gets no ghost text; candidates shown");
  ctx.GRPC.Fail("Complete", grpc::StatusCode::INVALID_ARGUMENT, "prompt too long", 1, kHFimTarget);
  shown = hFimCall();
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 5, "INVALID_ARGUMENT is not transient: one call, no retry; calls so far");
  ctx.Equal(shown.size(), 0, "a rejected request gives no ghost text; candidates shown");
  for (const auto& [code, name] : std::vector<std::pair<grpc::StatusCode, std::string>>{
           {grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"}, {grpc::StatusCode::INTERNAL, "INTERNAL"}, {grpc::StatusCode::UNKNOWN, "UNKNOWN"}, {grpc::StatusCode::PERMISSION_DENIED, "PERMISSION_DENIED"}}) {
    const std::size_t before = ctx.GRPC.CallsTo("Complete").size();
    ctx.GRPC.Fail("Complete", code, "refused", 1, kHFimTarget);
    shown = hFimCall();
    ctx.Equal(ctx.GRPC.CallsTo("Complete").size() - before, 1, "%s is not UNAVAILABLE: one call, no retry; calls", name);
    ctx.Equal(shown.size(), 0, "a call that ended %s gives no ghost text; candidates shown", name);
  }
}

void CheckFilter(harness::Ctx& ctx) {
  auto& peer = hFimWorld(ctx, {{"", false}, {"   ", false}, {"\\n\\t", false}, {"cursor.fetchone()", false}, {"cursor.fetchone()  ", false}, {"cursor.close()", true},
                              {"next(cursor)", false}, {"\\tnext(cursor)", false}, {"cursor.close()", false}});
  const auto shown = hFimCall();
  ctx.Equal(peer.requests[0].n(), 3, "the request must ask for kNCandidates = 3");
  ctx.Equal(shown, {"cursor.fetchone()", "next(cursor)", "cursor.close()"}, "empty or whitespace-only, truncated and duplicate (after trimming both ends) candidates must be dropped in the model's order; a truncated candidate does not hide a later complete one");
}
`,
  },
  debrief: `Fill-in-the-middle is a request shape, not a prompt trick: the model was trained to complete the gap between a prefix and a suffix, so the two have to arrive in their own fields. The deadline sits on each attempt because nothing outside the call can end it, and 300 ms is roughly the pause before the next keystroke makes the answer useless. Only \`UNAVAILABLE\` is worth a second try: a deadline means the budget is spent, and a rejection will be rejected again. Filtering is where n generated becomes at most n shown. GitHub found that generating many candidates when most developers take the first wastes compute, which is why \`n\` stays small.`,
};
