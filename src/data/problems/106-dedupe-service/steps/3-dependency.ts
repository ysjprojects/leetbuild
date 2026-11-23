import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Fuzzy matches under a 200 ms deadline that degrade to exact-only',
  concept: 'grpc',
  guides: ['failing-dependencies', 'deadlines-and-retries', 'request-boundaries'],
  file: 'client',
  focus: ['api', 'similarity'],
  task: `## Task

**Starting point.** The starter is the fuzzy pass the check endpoint runs for free text:
\`fuzzy_match(tenant, text)\` calls \`Similarity.Resolve\` over gRPC and answers
\`{"match": {"record_id", "score"} | None, "exact_only": bool}\`. It calls with no deadline, tries up
to three times when a call fails, and answers the first candidate, whatever its score. With a
healthy service it finds the duplicate, and it hides four flaws.

**Failure mode the checks target.** A stalled similarity service holds every check open; a failing
one is called three times per check; a check whose fuzzy pass never ran answers as if it had; and a
0.62 look-alike is reported as a duplicate.

\`\`\`proto
service Similarity { rpc Resolve(ResolveRequest) returns (ResolveReply); }  // candidates, best first
\`\`\`

- The call carries a **\`DEADLINE_S\` = 0.2 s** deadline.
- One attempt per check: a failed or timed-out call is not retried in the request.
- A failed call answers \`{"match": None, "exact_only": True}\`: the caller learns the fuzzy pass did
  not run. A pass that ran says \`"exact_only": False\`.
- Only a candidate scoring at least **\`MATCH_THRESHOLD\` = 0.9** is a match.`,
  sequence: {
    participants: ['Dedupe API', 'Similarity service'],
    messages: [
      {from: 'Dedupe API', to: 'Similarity service', label: 'Resolve(tenant, text) · deadline 200 ms', kind: 'sync'},
      {from: 'Similarity service', to: 'Dedupe API', label: 'candidates, best first', kind: 'reply'},
      {from: 'Dedupe API', to: 'Dedupe API', label: 'best ≥ 0.9 → match · else none', kind: 'sync'},
      {
        from: 'Similarity service',
        to: 'Dedupe API',
        label: 'UNAVAILABLE · DEADLINE_EXCEEDED → exact_only',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'call',
      title: "Resolves the text in the caller's tenant",
      detail:
        '`fuzzy_match` calls `Similarity.Resolve` with the tenant and the text and answers the strong candidate as the match.',
      match: {
        python: {all: [/\.Resolve\(/]},
        typescript: {all: [/\.Resolve\(/]},
        go: {all: [/similarity\.Resolve\(/]},
        cpp: {all: [/->Resolve\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Bounds the call with a 200 ms deadline',
      detail:
        'The call carries `DEADLINE_S` (0.2 s), so a similarity service that stalls costs a check one call of about 200 ms, not as long as the service takes. The starter calls with no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0?\.2\b/, /Resolve\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*200\b/, /Resolve\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*200\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        cpp: {all: [/kDeadline\{200\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'no-retry',
      title: 'Makes one attempt per check',
      detail:
        'A failed call is answered at once, not retried inside the request, whatever its status code (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`, `RESOURCE_EXHAUSTED`): a retry spends the latency the deadline protects and triples the load on a struggling service. The starter tries three times.',
      match: {
        python: {all: [/except grpc\.RpcError/], none: [/for attempt in/, /while True/]},
        typescript: {all: [/catch/], none: [/for \(let attempt/, /while \(true\)/]},
        go: {all: [/similarity\.Resolve\(/], none: [/for attempt :=/]},
        cpp: {all: [/->Resolve\(/], none: [/for \(int attempt/, /while \(true\)/]},
      },
    },
    {
      id: 'exact-only',
      title: 'Marks a check whose fuzzy pass failed as exact-only',
      detail:
        'Any failed call, whatever its status code, answers `{"match": None, "exact_only": True}`, so the caller can tell "no fuzzy duplicate" from "the fuzzy pass did not run". The starter answers a plain miss.',
      match: {
        python: {all: [/["']exact_only["']\s*:\s*True/]},
        typescript: {all: [/exact_only:\s*true/]},
        go: {all: [/ExactOnly:\s*true/]},
        cpp: {all: [/FuzzyResult\{std::nullopt,\s*true\}/]},
      },
    },
    {
      id: 'threshold',
      title: 'Counts only a candidate at or above 0.9',
      detail:
        'The best candidate is a match only when its score reaches `MATCH_THRESHOLD` (0.9): a candidate at exactly 0.9 is a match, a 0.89 or a 0.62 look-alike is not. The starter answers the first candidate whatever its score.',
      match: {
        python: {all: [/MATCH_THRESHOLD\s*=\s*0?\.9\b/, /[<>]=?\s*MATCH_THRESHOLD/]},
        typescript: {all: [/MATCH_THRESHOLD\s*=\s*0?\.9\b/, /[<>]=?\s*MATCH_THRESHOLD/]},
        go: {all: [/matchThreshold\s*=\s*0?\.9\b/, /[<>]=?\s*matchThreshold/]},
        cpp: {all: [/kMatchThreshold\s*=\s*0?\.9\b/, /[<>]=?\s*kMatchThreshold/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import dedupe_service_pb2
import dedupe_service_pb2_grpc

similarity = dedupe_service_pb2_grpc.SimilarityStub(grpc.insecure_channel("similarity:9000"))


def fuzzy_match(tenant: str, text: str) -> dict:
    """The tenant's record the text most resembles: {"match": {"record_id", "score"} | None, "exact_only": bool}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for attempt in range(3):
        try:
            reply = similarity.Resolve(dedupe_service_pb2.ResolveRequest(tenant=tenant, text=text, limit=5))
        except grpc.RpcError:
            continue
        if not reply.candidates:
            return {"match": None, "exact_only": False}
        best = reply.candidates[0]
        return {"match": {"record_id": best.record_id, "score": best.score}, "exact_only": False}
    return {"match": None, "exact_only": False}
`,
      solution: `import grpc

import dedupe_service_pb2
import dedupe_service_pb2_grpc

DEADLINE_S = 0.2
MATCH_THRESHOLD = 0.9

similarity = dedupe_service_pb2_grpc.SimilarityStub(grpc.insecure_channel("similarity:9000"))


def fuzzy_match(tenant: str, text: str) -> dict:
    """The tenant's record the text most resembles: {"match": {"record_id", "score"} | None, "exact_only": bool}."""
    try:
        reply = similarity.Resolve(dedupe_service_pb2.ResolveRequest(tenant=tenant, text=text, limit=5), timeout=DEADLINE_S)
    except grpc.RpcError:
        # The fuzzy pass did not run: answer from the exact keys alone, and say so. No retry in the request.
        return {"match": None, "exact_only": True}
    best = max(reply.candidates, key=lambda c: c.score, default=None)
    if best is None or best.score < MATCH_THRESHOLD:
        return {"match": None, "exact_only": False}
    return {"match": {"record_id": best.record_id, "score": best.score}, "exact_only": False}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface Candidate {
  record_id: string;
  score: number;
}

export interface FuzzyResult {
  match: Candidate | null;
  exact_only: boolean;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('dedupe_service.proto')) as unknown as {
  dedupd: {Similarity: grpc.ServiceClientConstructor};
};
const similarity = new pkg.dedupd.Similarity('similarity:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Resolve(request: {tenant: string; text: string; limit: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{candidates: Candidate[]}>;
};

/** The tenant's record the text most resembles. */
export async function fuzzyMatch(tenant: string, text: string): Promise<FuzzyResult> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < 3; attempt++) {
    let reply: {candidates: Candidate[]};
    try {
      reply = await similarity.Resolve({tenant, text, limit: 5}, new grpc.Metadata(), {});
    } catch {
      continue;
    }
    if (reply.candidates.length === 0) return {match: null, exact_only: false};
    const best = reply.candidates[0];
    return {match: {record_id: best.record_id, score: best.score}, exact_only: false};
  }
  return {match: null, exact_only: false};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEADLINE_MS = 200;
export const MATCH_THRESHOLD = 0.9;

interface Candidate {
  record_id: string;
  score: number;
}

export interface FuzzyResult {
  match: Candidate | null;
  exact_only: boolean;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('dedupe_service.proto')) as unknown as {
  dedupd: {Similarity: grpc.ServiceClientConstructor};
};
const similarity = new pkg.dedupd.Similarity('similarity:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Resolve(request: {tenant: string; text: string; limit: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{candidates: Candidate[]}>;
};

/** The tenant's record the text most resembles. */
export async function fuzzyMatch(tenant: string, text: string): Promise<FuzzyResult> {
  let reply: {candidates: Candidate[]};
  try {
    reply = await similarity.Resolve({tenant, text, limit: 5}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  } catch {
    // The fuzzy pass did not run: answer from the exact keys alone, and say so. No retry in the request.
    return {match: null, exact_only: true};
  }
  const best = reply.candidates.reduce<Candidate | null>((top, c) => (top === null || c.score > top.score ? c : top), null);
  if (best === null || best.score < MATCH_THRESHOLD) return {match: null, exact_only: false};
  return {match: {record_id: best.record_id, score: best.score}, exact_only: false};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "dedupe/gen/dedupe_service"
)

var (
	similarityConn, _ = grpc.NewClient("similarity:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	similarity        = pb.NewSimilarityClient(similarityConn)
)

// candidateMatch is the record a text resembles and how much.
type candidateMatch struct {
	RecordID string  \`json:"record_id"\`
	Score    float64 \`json:"score"\`
}

// fuzzyResult is the fuzzy pass's answer: Match is nil when there is none.
type fuzzyResult struct {
	Match     *candidateMatch \`json:"match"\`
	ExactOnly bool            \`json:"exact_only"\`
}

// fuzzyMatch is the tenant's record the text most resembles.
func fuzzyMatch(ctx context.Context, tenant, text string) fuzzyResult {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < 3; attempt++ {
		reply, err := similarity.Resolve(ctx, &pb.ResolveRequest{Tenant: tenant, Text: text, Limit: 5})
		if err != nil {
			continue
		}
		if len(reply.GetCandidates()) == 0 {
			return fuzzyResult{}
		}
		best := reply.GetCandidates()[0]
		return fuzzyResult{Match: &candidateMatch{RecordID: best.GetRecordId(), Score: best.GetScore()}}
	}
	return fuzzyResult{}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "dedupe/gen/dedupe_service"
)

const (
	deadline       = 200 * time.Millisecond
	matchThreshold = 0.9
)

var (
	similarityConn, _ = grpc.NewClient("similarity:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	similarity        = pb.NewSimilarityClient(similarityConn)
)

// candidateMatch is the record a text resembles and how much.
type candidateMatch struct {
	RecordID string  \`json:"record_id"\`
	Score    float64 \`json:"score"\`
}

// fuzzyResult is the fuzzy pass's answer: Match is nil when there is none.
type fuzzyResult struct {
	Match     *candidateMatch \`json:"match"\`
	ExactOnly bool            \`json:"exact_only"\`
}

// fuzzyMatch is the tenant's record the text most resembles.
func fuzzyMatch(ctx context.Context, tenant, text string) fuzzyResult {
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := similarity.Resolve(callCtx, &pb.ResolveRequest{Tenant: tenant, Text: text, Limit: 5})
	if err != nil {
		// The fuzzy pass did not run: answer from the exact keys alone, and say so. No retry in the request.
		return fuzzyResult{ExactOnly: true}
	}
	var best *pb.Candidate
	for _, c := range reply.GetCandidates() {
		if best == nil || c.GetScore() > best.GetScore() {
			best = c
		}
	}
	if best == nil || best.GetScore() < matchThreshold {
		return fuzzyResult{}
	}
	return fuzzyResult{Match: &candidateMatch{RecordID: best.GetRecordId(), Score: best.GetScore()}}
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <optional>
#include <string>

#include "dedupe_service.grpc.pb.h"

auto similarity = dedupd::Similarity::NewStub(grpc::CreateChannel("similarity:9000", grpc::InsecureChannelCredentials()));

// The record a text resembles and how much.
struct FuzzyMatch {
  std::string record_id;
  double score = 0;
};

// The fuzzy pass's answer: no match when there is none.
struct FuzzyResult {
  std::optional<FuzzyMatch> match;
  bool exact_only = false;
};

// The tenant's record the text most resembles.
FuzzyResult fuzzyMatch(const std::string& tenant, const std::string& text) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  dedupd::ResolveRequest request;
  request.set_tenant(tenant);
  request.set_text(text);
  request.set_limit(5);
  for (int attempt = 0; attempt < 3; attempt++) {
    grpc::ClientContext ctx;
    dedupd::ResolveReply reply;
    if (!similarity->Resolve(&ctx, request, &reply).ok()) continue;
    if (reply.candidates().empty()) return FuzzyResult{std::nullopt, false};
    const dedupd::Candidate& best = reply.candidates(0);
    return FuzzyResult{FuzzyMatch{best.record_id(), best.score()}, false};
  }
  return FuzzyResult{std::nullopt, false};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <string>

#include "dedupe_service.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{200};
constexpr double kMatchThreshold = 0.9;

auto similarity = dedupd::Similarity::NewStub(grpc::CreateChannel("similarity:9000", grpc::InsecureChannelCredentials()));

// The record a text resembles and how much.
struct FuzzyMatch {
  std::string record_id;
  double score = 0;
};

// The fuzzy pass's answer: no match when there is none.
struct FuzzyResult {
  std::optional<FuzzyMatch> match;
  bool exact_only = false;
};

// The tenant's record the text most resembles.
FuzzyResult fuzzyMatch(const std::string& tenant, const std::string& text) {
  dedupd::ResolveRequest request;
  request.set_tenant(tenant);
  request.set_text(text);
  request.set_limit(5);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  dedupd::ResolveReply reply;
  // The fuzzy pass did not run: answer from the exact keys alone, and say so. No retry in the request.
  if (!similarity->Resolve(&ctx, request, &reply).ok()) return FuzzyResult{std::nullopt, true};
  const dedupd::Candidate* best = nullptr;
  for (const dedupd::Candidate& c : reply.candidates()) {
    if (best == nullptr || c.score() > best->score()) best = &c;
  }
  if (best == nullptr || best->score() < kMatchThreshold) return FuzzyResult{std::nullopt, false};
  return FuzzyResult{FuzzyMatch{best->record_id(), best->score()}, false};
}
`,
    },
  },
  harness: {
    python: `import grpc

import dedupe_service_pb2
import dedupe_service_pb2_grpc

TEXT = "Jane Doe, 1 Main St, Springfield"


class Similarity(dedupe_service_pb2_grpc.SimilarityServicer):
    """Answers the candidates registered for (tenant, text), best first; none for anything else."""

    def __init__(self):
        self.answers = {}

    def Resolve(self, request, context):
        found = self.answers.get((request.tenant, request.text), [])
        return dedupe_service_pb2.ResolveReply(candidates=[dedupe_service_pb2.Candidate(record_id=r, score=s) for r, s in found])


def _client(ctx):
    peer = Similarity()
    ctx.grpc.serve(dedupe_service_pb2_grpc.add_SimilarityServicer_to_server, peer)
    return ctx.load("client"), peer


def check_call(ctx):
    m, peer = _client(ctx)
    peer.answers[("acme", TEXT)] = [("r-1", 0.96)]
    got = m.fuzzy_match("acme", TEXT)
    assert got == {"match": {"record_id": "r-1", "score": 0.96}, "exact_only": False}, f"with r-1 scoring 0.96 fuzzy_match answered {got}"
    calls = ctx.grpc.calls_to("Resolve")
    assert calls and calls[0].request.tenant == "acme" and calls[0].request.text == TEXT, f"Resolve must be asked about acme's text, the calls were {calls}"


FAILURES = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.INTERNAL, grpc.StatusCode.RESOURCE_EXHAUSTED)


def check_deadline(ctx):
    m, peer = _client(ctx)
    peer.answers[("acme", TEXT)] = [("r-1", 0.96)]
    m.fuzzy_match("acme", TEXT)
    call = ctx.grpc.calls_to("Resolve")[0]
    assert call.timeout is not None, "the Resolve call carries no deadline: a stalled similarity service holds every check open"
    assert 0.15 <= call.timeout <= 0.25, f"the Resolve call carries a {call.timeout} s deadline, expected DEADLINE_S = 0.2"
    ctx.grpc.set_latency("Resolve", 5.0)  # the similarity service stalls
    before, calls_before = ctx.clock.time(), len(ctx.grpc.calls_to("Resolve"))
    got = m.fuzzy_match("acme", TEXT)
    waited = ctx.clock.time() - before
    calls = len(ctx.grpc.calls_to("Resolve")) - calls_before
    assert calls == 1, f"a check called the stalled similarity service {calls} times, expected one call that times out"
    assert waited <= 0.3, f"a check waited {waited:.2f} s on a stalled similarity service, expected about 0.2 s"
    assert got == {"match": None, "exact_only": True}, f"a call that ran out of time answered {got}, expected no match, exact_only"


def check_no_retry(ctx):
    m, peer = _client(ctx)
    peer.answers[("acme", TEXT)] = [("r-1", 0.96)]
    for code in FAILURES:
        ctx.grpc.failures.clear()
        ctx.grpc.fail("Resolve", code, "similarity is failing", times=3)
        before = len(ctx.grpc.calls_to("Resolve"))
        m.fuzzy_match("acme", TEXT)
        calls = len(ctx.grpc.calls_to("Resolve")) - before
        assert calls == 1, f"one check called Resolve {calls} times on a service failing with {code.name}: a retry in the request spends the latency the deadline protects and multiplies the load. Make one attempt"


def check_exact_only(ctx):
    m, peer = _client(ctx)
    peer.answers[("acme", TEXT)] = [("r-1", 0.96)]
    for code in FAILURES:
        ctx.grpc.failures.clear()
        ctx.grpc.fail("Resolve", code, "similarity is failing", times=3)
        got = m.fuzzy_match("acme", TEXT)
        assert got == {"match": None, "exact_only": True}, f"Resolve failed with {code.name} and fuzzy_match answered {got}: the caller cannot tell 'no fuzzy duplicate' from 'the fuzzy pass did not run'. Expected exact_only True for any failed call"
    ctx.grpc.failures.clear()
    got = m.fuzzy_match("acme", "Somebody Else")
    assert got == {"match": None, "exact_only": False}, f"a fuzzy pass that ran and found nothing answered {got}, expected exact_only False"


def check_threshold(ctx):
    m, peer = _client(ctx)
    for score in (0.62, 0.89):
        peer.answers[("acme", TEXT)] = [("r-9", score)]
        got = m.fuzzy_match("acme", TEXT)
        assert got == {"match": None, "exact_only": False}, f"the best candidate scores {score} and fuzzy_match answered {got}: a look-alike below MATCH_THRESHOLD = 0.9 is not a duplicate"
    peer.answers[("acme", TEXT)] = [("r-5", 0.9)]
    got = m.fuzzy_match("acme", TEXT)
    assert got == {"match": {"record_id": "r-5", "score": 0.9}, "exact_only": False}, f"r-5 scores exactly 0.9 and fuzzy_match answered {got}: a candidate at MATCH_THRESHOLD is a match"
    peer.answers[("acme", TEXT)] = [("r-3", 0.91), ("r-4", 0.5)]
    got = m.fuzzy_match("acme", TEXT)
    assert got == {"match": {"record_id": "r-3", "score": 0.91}, "exact_only": False}, f"r-3 scores 0.91 and fuzzy_match answered {got}"
`,
    typescript: `const TEXT = 'Jane Doe, 1 Main St, Springfield';

/** The similarity service: the candidates registered for (tenant, text), best first; none for anything else. */
function client(ctx) {
  const pkg = ctx.proto('dedupe_service.proto');
  const answers = new Map<string, [string, number][]>();
  ctx.grpc.serve(pkg.dedupd.Similarity.service, {
    Resolve(call, callback) {
      const found = answers.get(\`\${call.request.tenant}/\${call.request.text}\`) ?? [];
      callback(null, {candidates: found.map(([record_id, score]) => ({record_id, score}))});
    },
  });
  return {m: ctx.load('client'), answers};
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function check_call(ctx) {
  const {m, answers} = client(ctx);
  answers.set(\`acme/\${TEXT}\`, [['r-1', 0.96]]);
  const got = await m.fuzzyMatch('acme', TEXT);
  assert(same(got, {match: {record_id: 'r-1', score: 0.96}, exact_only: false}), \`with r-1 scoring 0.96 fuzzyMatch answered \${JSON.stringify(got)}\`);
  const calls = ctx.grpc.callsTo('Resolve');
  assert(calls.length > 0 && calls[0].request.tenant === 'acme' && calls[0].request.text === TEXT, "Resolve must be asked about acme's text");
}

export async function check_deadline(ctx) {
  const {m, answers} = client(ctx);
  answers.set(\`acme/\${TEXT}\`, [['r-1', 0.96]]);
  await m.fuzzyMatch('acme', TEXT);
  const call = ctx.grpc.callsTo('Resolve')[0];
  assert(call.timeout !== null, 'the Resolve call carries no deadline: a stalled similarity service holds every check open');
  assert(0.15 <= call.timeout && call.timeout <= 0.25, \`the Resolve call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 200\`);
  ctx.grpc.setLatency('Resolve', 5.0); // the similarity service stalls
  const before = ctx.clock.now();
  const callsBefore = ctx.grpc.callsTo('Resolve').length;
  const got = await m.fuzzyMatch('acme', TEXT);
  const waited = (ctx.clock.now() - before) / 1000;
  const calls = ctx.grpc.callsTo('Resolve').length - callsBefore;
  assert.equal(calls, 1, \`a check called the stalled similarity service \${calls} times, expected one call that times out\`);
  assert(waited <= 0.3, \`a check waited \${waited.toFixed(2)} s on a stalled similarity service, expected about 0.2 s\`);
  assert(same(got, {match: null, exact_only: true}), \`a call that ran out of time answered \${JSON.stringify(got)}, expected no match, exact_only\`);
}

const FAILURES = ['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL', 'RESOURCE_EXHAUSTED'];

export async function check_no_retry(ctx) {
  const {m, answers} = client(ctx);
  answers.set(\`acme/\${TEXT}\`, [['r-1', 0.96]]);
  for (const code of FAILURES) {
    ctx.grpc.clearFailures();
    ctx.grpc.fail('Resolve', ctx.grpc.status[code], 'similarity is failing', 3);
    const before = ctx.grpc.callsTo('Resolve').length;
    await m.fuzzyMatch('acme', TEXT);
    const calls = ctx.grpc.callsTo('Resolve').length - before;
    assert.equal(calls, 1, \`one check called Resolve \${calls} times on a service failing with \${code}: a retry in the request spends the latency the deadline protects and multiplies the load. Make one attempt\`);
  }
}

export async function check_exact_only(ctx) {
  const {m, answers} = client(ctx);
  answers.set(\`acme/\${TEXT}\`, [['r-1', 0.96]]);
  for (const code of FAILURES) {
    ctx.grpc.clearFailures();
    ctx.grpc.fail('Resolve', ctx.grpc.status[code], 'similarity is failing', 3);
    const got = await m.fuzzyMatch('acme', TEXT);
    assert(same(got, {match: null, exact_only: true}), \`Resolve failed with \${code} and fuzzyMatch answered \${JSON.stringify(got)}: the caller cannot tell "no fuzzy duplicate" from "the fuzzy pass did not run". Expected exact_only true for any failed call\`);
  }
  ctx.grpc.clearFailures();
  const got = await m.fuzzyMatch('acme', 'Somebody Else');
  assert(same(got, {match: null, exact_only: false}), \`a fuzzy pass that ran and found nothing answered \${JSON.stringify(got)}, expected exact_only false\`);
}

export async function check_threshold(ctx) {
  const {m, answers} = client(ctx);
  for (const score of [0.62, 0.89]) {
    answers.set(\`acme/\${TEXT}\`, [['r-9', score]]);
    const got = await m.fuzzyMatch('acme', TEXT);
    assert(same(got, {match: null, exact_only: false}), \`the best candidate scores \${score} and fuzzyMatch answered \${JSON.stringify(got)}: a look-alike below MATCH_THRESHOLD = 0.9 is not a duplicate\`);
  }
  answers.set(\`acme/\${TEXT}\`, [['r-5', 0.9]]);
  let got = await m.fuzzyMatch('acme', TEXT);
  assert(same(got, {match: {record_id: 'r-5', score: 0.9}, exact_only: false}), \`r-5 scores exactly 0.9 and fuzzyMatch answered \${JSON.stringify(got)}: a candidate at MATCH_THRESHOLD is a match\`);
  answers.set(\`acme/\${TEXT}\`, [['r-3', 0.91], ['r-4', 0.5]]);
  got = await m.fuzzyMatch('acme', TEXT);
  assert(same(got, {match: {record_id: 'r-3', score: 0.91}, exact_only: false}), \`r-3 scores 0.91 and fuzzyMatch answered \${JSON.stringify(got)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc/codes"

	pb "dedupe/gen/dedupe_service"

	"leetbuild/harness"
)

const kHClientText = "Jane Doe, 1 Main St, Springfield"

type hScored struct {
	recordID string
	score    float64
}

// hSimilarityPeer answers the candidates registered for tenant/text, best first; none for anything else.
type hSimilarityPeer struct {
	pb.UnimplementedSimilarityServer
	answers map[string][]hScored
}

func (p *hSimilarityPeer) Resolve(_ context.Context, req *pb.ResolveRequest) (*pb.ResolveReply, error) {
	reply := &pb.ResolveReply{}
	for _, s := range p.answers[req.GetTenant()+"/"+req.GetText()] {
		reply.Candidates = append(reply.Candidates, &pb.Candidate{RecordId: s.recordID, Score: s.score})
	}
	return reply, nil
}

func hPeer(ctx *harness.Ctx) *hSimilarityPeer {
	p := &hSimilarityPeer{answers: map[string][]hScored{}}
	pb.RegisterSimilarityServer(ctx.GRPC.Server(""), p)
	return p
}

func hShow(r fuzzyResult) string {
	raw, _ := json.Marshal(r)
	return string(raw)
}

var hFailures = []codes.Code{codes.Unavailable, codes.DeadlineExceeded, codes.Internal, codes.ResourceExhausted}

func CheckCall(ctx *harness.Ctx) {
	p := hPeer(ctx)
	p.answers["acme/"+kHClientText] = []hScored{{"r-1", 0.96}}
	got := fuzzyMatch(context.Background(), "acme", kHClientText)
	ctx.Equal(hShow(got), \`{"match":{"record_id":"r-1","score":0.96},"exact_only":false}\`, "with r-1 scoring 0.96, fuzzyMatch")
	calls := ctx.GRPC.CallsTo("Resolve", "")
	ctx.Assert(len(calls) > 0, "no Resolve call was made")
	req := calls[0].Request.(*pb.ResolveRequest)
	ctx.Assert(req.GetTenant() == "acme" && req.GetText() == kHClientText, "Resolve must be asked about acme's text, it was asked about %s/%q", req.GetTenant(), req.GetText())
}

func CheckDeadline(ctx *harness.Ctx) {
	p := hPeer(ctx)
	p.answers["acme/"+kHClientText] = []hScored{{"r-1", 0.96}}
	fuzzyMatch(context.Background(), "acme", kHClientText)
	call := ctx.GRPC.CallsTo("Resolve", "")[0]
	ctx.Assert(call.HasDeadline(), "the Resolve call carries no deadline: a stalled similarity service holds every check open")
	ctx.Assert(150*time.Millisecond <= call.Timeout && call.Timeout <= 250*time.Millisecond, "the Resolve call carries a %v deadline, expected 200 ms", call.Timeout)
	ctx.GRPC.SetLatency("Resolve", 5.0, "") // the similarity service stalls
	before, callsBefore := ctx.Clock.Now(), len(ctx.GRPC.CallsTo("Resolve", ""))
	got := fuzzyMatch(context.Background(), "acme", kHClientText)
	waited := float64(ctx.Clock.Now()-before) / 1000
	calls := len(ctx.GRPC.CallsTo("Resolve", "")) - callsBefore
	ctx.Assert(calls == 1, "a check called the stalled similarity service %d times, expected one call that times out", calls)
	ctx.Assert(waited <= 0.3, "a check waited %.2f s on a stalled similarity service, expected about 0.2 s", waited)
	ctx.Equal(hShow(got), \`{"match":null,"exact_only":true}\`, "a call that ran out of time must answer no match, exact_only")
}

func CheckNoRetry(ctx *harness.Ctx) {
	p := hPeer(ctx)
	p.answers["acme/"+kHClientText] = []hScored{{"r-1", 0.96}}
	for _, code := range hFailures {
		ctx.GRPC.ClearFailures()
		ctx.GRPC.Fail("Resolve", code, "similarity is failing", 3, "")
		before := len(ctx.GRPC.CallsTo("Resolve", ""))
		fuzzyMatch(context.Background(), "acme", kHClientText)
		calls := len(ctx.GRPC.CallsTo("Resolve", "")) - before
		ctx.Assert(calls == 1, "one check called Resolve %d times on a service failing with %v: a retry in the request spends the latency the deadline protects and multiplies the load. Make one attempt", calls, code)
	}
}

func CheckExactOnly(ctx *harness.Ctx) {
	p := hPeer(ctx)
	p.answers["acme/"+kHClientText] = []hScored{{"r-1", 0.96}}
	for _, code := range hFailures {
		ctx.GRPC.ClearFailures()
		ctx.GRPC.Fail("Resolve", code, "similarity is failing", 3, "")
		got := fuzzyMatch(context.Background(), "acme", kHClientText)
		ctx.Assert(hShow(got) == \`{"match":null,"exact_only":true}\`, "Resolve failed with %v and fuzzyMatch answered %s: the caller cannot tell \\"no fuzzy duplicate\\" from \\"the fuzzy pass did not run\\". Expected exact_only true for any failed call", code, hShow(got))
	}
	ctx.GRPC.ClearFailures()
	got := fuzzyMatch(context.Background(), "acme", "Somebody Else")
	ctx.Equal(hShow(got), \`{"match":null,"exact_only":false}\`, "a fuzzy pass that ran and found nothing")
}

func CheckThreshold(ctx *harness.Ctx) {
	p := hPeer(ctx)
	for _, score := range []float64{0.62, 0.89} {
		p.answers["acme/"+kHClientText] = []hScored{{"r-9", score}}
		got := fuzzyMatch(context.Background(), "acme", kHClientText)
		ctx.Assert(hShow(got) == \`{"match":null,"exact_only":false}\`, "the best candidate scores %v and fuzzyMatch answered %s: a look-alike below matchThreshold = 0.9 is not a duplicate", score, hShow(got))
	}
	p.answers["acme/"+kHClientText] = []hScored{{"r-5", 0.9}}
	got := fuzzyMatch(context.Background(), "acme", kHClientText)
	ctx.Equal(hShow(got), \`{"match":{"record_id":"r-5","score":0.9},"exact_only":false}\`, "r-5 scores exactly 0.9, and a candidate at matchThreshold is a match; fuzzyMatch")
	p.answers["acme/"+kHClientText] = []hScored{{"r-3", 0.91}, {"r-4", 0.5}}
	got = fuzzyMatch(context.Background(), "acme", kHClientText)
	ctx.Equal(hShow(got), \`{"match":{"record_id":"r-3","score":0.91},"exact_only":false}\`, "r-3 scores 0.91; fuzzyMatch")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <utility>
#include <vector>

namespace {

const std::string kHText = "Jane Doe, 1 Main St, Springfield";

// Answers the candidates registered for tenant/text, best first; none for anything else.
class HSimilarityPeer final : public dedupd::Similarity::Service {
 public:
  std::map<std::string, std::vector<std::pair<std::string, double>>> answers;
  grpc::Status Resolve(grpc::ServerContext*, const dedupd::ResolveRequest* req, dedupd::ResolveReply* out) override {
    const auto found = answers.find(req->tenant() + "/" + req->text());
    if (found == answers.end()) return grpc::Status::OK;
    for (const auto& [record_id, score] : found->second) {
      dedupd::Candidate* c = out->add_candidates();
      c->set_record_id(record_id);
      c->set_score(score);
    }
    return grpc::Status::OK;
  }
};

HSimilarityPeer& h_peer(harness::Ctx& ctx) {
  static HSimilarityPeer* p = nullptr;
  delete p;
  p = new HSimilarityPeer;
  ctx.GRPC.Server("")->RegisterService(p);
  return *p;
}

std::string h_show(const FuzzyResult& r) {
  nlohmann::json out = {{"match", nullptr}, {"exact_only", r.exact_only}};
  if (r.match) out["match"] = {{"record_id", r.match->record_id}, {"score", r.match->score}};
  return out.dump();
}

const std::vector<std::pair<grpc::StatusCode, std::string>> kHFailures = {
    {grpc::StatusCode::UNAVAILABLE, "UNAVAILABLE"},
    {grpc::StatusCode::DEADLINE_EXCEEDED, "DEADLINE_EXCEEDED"},
    {grpc::StatusCode::INTERNAL, "INTERNAL"},
    {grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"}};

}  // namespace

void CheckCall(harness::Ctx& ctx) {
  HSimilarityPeer& p = h_peer(ctx);
  p.answers["acme/" + kHText] = {{"r-1", 0.96}};
  const FuzzyResult got = fuzzyMatch("acme", kHText);
  ctx.Assert(got.match && got.match->record_id == "r-1" && got.match->score == 0.96 && !got.exact_only, "with r-1 scoring 0.96 fuzzyMatch answered %s", h_show(got));
  const auto calls = ctx.GRPC.CallsTo("Resolve");
  ctx.Assert(!calls.empty(), "no Resolve call was made");
  const auto req = calls[0].Request<dedupd::ResolveRequest>();
  ctx.Assert(req.tenant() == "acme" && req.text() == kHText, "Resolve must be asked about acme's text, it was asked about %s/%q", req.tenant(), req.text());
}

void CheckDeadline(harness::Ctx& ctx) {
  HSimilarityPeer& p = h_peer(ctx);
  p.answers["acme/" + kHText] = {{"r-1", 0.96}};
  fuzzyMatch("acme", kHText);
  const auto call = ctx.GRPC.CallsTo("Resolve")[0];
  ctx.Assert(call.HasDeadline(), "the Resolve call carries no deadline: a stalled similarity service holds every check open");
  ctx.Assert(0.15 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.25, "the Resolve call carries a %v s deadline, expected kDeadline = 200 ms", call.TimeoutSeconds());
  ctx.GRPC.SetLatency("Resolve", 5.0);  // the similarity service stalls
  const int64_t before = ctx.Clock.Now();
  const size_t calls_before = ctx.GRPC.CallsTo("Resolve").size();
  const FuzzyResult got = fuzzyMatch("acme", kHText);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  const size_t calls = ctx.GRPC.CallsTo("Resolve").size() - calls_before;
  ctx.Assert(calls == 1, "a check called the stalled similarity service %d times, expected one call that times out", calls);
  ctx.Assert(waited <= 0.3, "a check waited %.2f s on a stalled similarity service, expected about 0.2 s", waited);
  ctx.Assert(!got.match && got.exact_only, "a call that ran out of time answered %s, expected no match, exact_only", h_show(got));
}

void CheckNoRetry(harness::Ctx& ctx) {
  HSimilarityPeer& p = h_peer(ctx);
  p.answers["acme/" + kHText] = {{"r-1", 0.96}};
  for (const auto& [code, name] : kHFailures) {
    ctx.GRPC.ClearFailures();
    ctx.GRPC.Fail("Resolve", code, "similarity is failing", 3);
    const size_t before = ctx.GRPC.CallsTo("Resolve").size();
    fuzzyMatch("acme", kHText);
    const size_t calls = ctx.GRPC.CallsTo("Resolve").size() - before;
    ctx.Assert(calls == 1, "one check called Resolve %d times on a service failing with %s: a retry in the request spends the latency the deadline protects and multiplies the load. Make one attempt", calls, name);
  }
}

void CheckExactOnly(harness::Ctx& ctx) {
  HSimilarityPeer& p = h_peer(ctx);
  p.answers["acme/" + kHText] = {{"r-1", 0.96}};
  for (const auto& [code, name] : kHFailures) {
    ctx.GRPC.ClearFailures();
    ctx.GRPC.Fail("Resolve", code, "similarity is failing", 3);
    const FuzzyResult got = fuzzyMatch("acme", kHText);
    ctx.Assert(!got.match && got.exact_only, "Resolve failed with %s and fuzzyMatch answered %s: the caller cannot tell \\"no fuzzy duplicate\\" from \\"the fuzzy pass did not run\\". Expected exact_only true for any failed call", name, h_show(got));
  }
  ctx.GRPC.ClearFailures();
  const FuzzyResult got = fuzzyMatch("acme", "Somebody Else");
  ctx.Assert(!got.match && !got.exact_only, "a fuzzy pass that ran and found nothing answered %s, expected exact_only false", h_show(got));
}

void CheckThreshold(harness::Ctx& ctx) {
  HSimilarityPeer& p = h_peer(ctx);
  for (const double score : {0.62, 0.89}) {
    p.answers["acme/" + kHText] = {{"r-9", score}};
    const FuzzyResult got = fuzzyMatch("acme", kHText);
    ctx.Assert(!got.match && !got.exact_only, "the best candidate scores %v and fuzzyMatch answered %s: a look-alike below kMatchThreshold = 0.9 is not a duplicate", score, h_show(got));
  }
  p.answers["acme/" + kHText] = {{"r-5", 0.9}};
  FuzzyResult got = fuzzyMatch("acme", kHText);
  ctx.Assert(got.match && got.match->record_id == "r-5" && !got.exact_only, "r-5 scores exactly 0.9 and fuzzyMatch answered %s: a candidate at kMatchThreshold is a match", h_show(got));
  p.answers["acme/" + kHText] = {{"r-3", 0.91}, {"r-4", 0.5}};
  got = fuzzyMatch("acme", kHText);
  ctx.Assert(got.match && got.match->record_id == "r-3" && !got.exact_only, "r-3 scores 0.91 and fuzzyMatch answered %s", h_show(got));
}
`,
  },
  hints: [
    'Stall the similarity service: every check takes as long as the stall, and when it fails outright the check is slower still and answers "no duplicate". A 0.62 look-alike comes back as the duplicate.',
    'The call has no deadline, so it waits as long as the server does; the loop tries three times; the final miss looks like a pass that ran; and `candidates[0]` is taken without reading its score.',
    'Call once with `timeout=DEADLINE_S` (0.2); on `grpc.RpcError` answer `{"match": None, "exact_only": True}`; otherwise take the best candidate and answer it only when its score is at least `MATCH_THRESHOLD`.',
  ],
  debrief: `The deadline and the single attempt belong together: the deadline caps what one check spends on the fuzzy pass, and a retry in the request would spend that budget again, on a service that is already failing. Once the call can fail fast, the answer has to say that it did, because a caller that merges or refuses on "no duplicate" cannot tell a thorough miss from a skipped one. The score floor is the matcher's half of the contract: a candidate list is ranked, not filtered. Production systems put a circuit breaker in front of the similarity service so a dead dependency costs nothing, and re-run the skipped fuzzy pass from a queue once it recovers.`,
};
