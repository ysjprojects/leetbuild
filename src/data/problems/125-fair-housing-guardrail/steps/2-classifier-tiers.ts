import type {Step} from '@/lib/types';

export const classifierTiersStep: Step = {
  id: 'classifier-tiers',
  title: 'The tiers: stop list, classifier under a deadline, judge for the band, fail closed',
  concept: 'grpc',
  file: 'classify_tiers',
  focus: ['guard', 'classifier', 'judge'],
  task: `## Task

**Starting point.** The starter is \`decide(text, policy)\`, the decision the guard routes run
(provided to the other steps as \`fhguard.tiers\`). It calls \`Classifier.Classify\` and then
\`Judge.Assess\` for every text, blocks when \`score >= THRESHOLD\` (0.5) or the judge says
non-compliant, and answers allowed from \`except Exception\`. It compiles and hides five flaws.

**Failure mode the checks target.** When the classifier is overloaded every steering query passes,
because the error path allows. The single 0.5 cut trades recall for precision, the opposite of what
Fair Housing exposure needs. The judge runs on every request, so the fast tier buys nothing. And the
phrases legal says must be caught every time depend on a probabilistic model.

\`\`\`proto
service Classifier { rpc Classify(ClassifyRequest) returns (ClassifyReply); }  // score, label
service Judge      { rpc Assess(AssessRequest) returns (Assessment); }         // compliant, reason
\`\`\`

- Scan \`policy.stop_phrases\` first, case-insensitively: a hit blocks with tier \`stoplist\` and
  reason \`stop_phrase:{phrase}\`, with no RPC.
- \`Classify\` runs under \`CLASSIFY_DEADLINE_S\` = 250 ms. Block at \`BLOCK_THRESHOLD\` = 0.35
  (reason \`classifier:{label}\`); allow below \`REVIEW_LOW\` = 0.15.
- Only the band between goes to \`Assess\`, under \`JUDGE_DEADLINE_S\` = 2 s; tier \`judge\`, reason
  \`judge:{reason}\` when it blocks.
- An RPC error or deadline at any tier blocks with \`FAIL_CLOSED_REASON\` (\`guard_unavailable\`).`,
  sequence: {
    participants: ['fhguard', 'Classifier', 'Judge'],
    messages: [
      {from: 'fhguard', to: 'fhguard', label: 'policy.stop_phrases hit? → blocked, tier stoplist', kind: 'sync'},
      {from: 'fhguard', to: 'Classifier', label: 'Classify(text, policy_version) · deadline 250 ms', kind: 'sync'},
      {from: 'Classifier', to: 'fhguard', label: 'ClassifyReply{score, label}', kind: 'reply'},
      {from: 'fhguard', to: 'fhguard', label: 'score ≥ 0.35 → blocked · < 0.15 → allowed', kind: 'sync'},
      {from: 'fhguard', to: 'Judge', label: 'Assess(text, policy_version) · band only · deadline 2 s', kind: 'sync'},
      {from: 'Judge', to: 'fhguard', label: 'Assessment{compliant, reason}', kind: 'reply'},
      {from: 'fhguard', to: 'fhguard', label: 'RPC error at any tier → blocked, guard_unavailable', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'stoplist-first',
      title: 'Runs the stop list before any RPC',
      detail:
        'The policy’s `stop_phrases` are scanned, case-insensitively, before the classifier is called; a hit answers tier `stoplist` with reason `stop_phrase:{phrase}` and makes no RPC.',
      match: {
        python: {all: [/"stoplist"/, /\.lower\(\)/], order: [/policy\.stop_phrases/, /\.Classify\(/]},
        typescript: {all: [/'stoplist'/, /toLowerCase\(\)/], order: [/policy\.stop_phrases/, /\.Classify\(/]},
        go: {
          all: [/"stoplist"/, /strings\.ToLower\(|strings\.EqualFold\(/],
          order: [/policy\.StopPhrases/, /\.Classify\(/],
        },
        scala: {all: [/"stoplist"/, /toLowerCase/], order: [/policy\.stopPhrases/, /\.classify\(/]},
        cpp: {all: [/"stoplist"/, /tolower/], order: [/policy\.stop_phrases/, /->Classify\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Classifies under a 250 ms deadline',
      detail:
        'Every `Classify` call carries a 250 ms deadline (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`); the starter calls with none, so a slow classifier holds the turn open.',
      match: {
        python: {
          all: [/CLASSIFY_DEADLINE_S\s*=\s*0\.25\b/, /Classify\([\s\S]{0,200}?timeout\s*=\s*CLASSIFY_DEADLINE_S/],
        },
        typescript: {
          all: [/CLASSIFY_DEADLINE_MS\s*=\s*250\b/, /Classify\([\s\S]{0,200}?deadline:[^\n]*CLASSIFY_DEADLINE_MS/],
        },
        go: {
          all: [
            /classifyDeadline\s*=\s*250\s*\*\s*time\.Millisecond/,
            /context\.WithTimeout\([^\n]*classifyDeadline\)/,
          ],
        },
        scala: {all: [/ClassifyDeadlineMs\s*=\s*250L?\b/, /withDeadlineAfter\(\s*ClassifyDeadlineMs/]},
        cpp: {all: [/kClassifyDeadline\{250\}/, /set_deadline\([^\n]*kClassifyDeadline\)/]},
      },
    },
    {
      id: 'recall-thresholds',
      title: 'Two thresholds tuned for recall: block at 0.35, allow below 0.15',
      detail:
        'A score of 0.35 or more blocks without asking the judge and a score under 0.15 allows; the starter’s single 0.5 cut lets a 0.40 through whenever the judge disagrees.',
      match: {
        python: {
          all: [/BLOCK_THRESHOLD\s*=\s*0\.35\b/, /REVIEW_LOW\s*=\s*0\.15\b/],
          none: [/\bTHRESHOLD\s*=\s*0\.5\b/],
        },
        typescript: {
          all: [/BLOCK_THRESHOLD\s*=\s*0\.35\b/, /REVIEW_LOW\s*=\s*0\.15\b/],
          none: [/\bTHRESHOLD\s*=\s*0\.5\b/],
        },
        go: {all: [/blockThreshold\s*=\s*0\.35\b/, /reviewLow\s*=\s*0\.15\b/], none: [/\bthreshold\s*=\s*0\.5\b/]},
        scala: {all: [/BlockThreshold\s*=\s*0\.35\b/, /ReviewLow\s*=\s*0\.15\b/], none: [/\bThreshold\s*=\s*0\.5\b/]},
        cpp: {all: [/kBlockThreshold\s*=\s*0\.35\b/, /kReviewLow\s*=\s*0\.15\b/], none: [/\bkThreshold\s*=\s*0\.5\b/]},
      },
    },
    {
      id: 'judge-band',
      title: 'Asks the judge only about the uncertain band, under 2 s',
      detail:
        '`Assess` is called only after the score fell in `[0.15, 0.35)`, with a 2 s deadline; the starter asks the judge about every text, with no deadline.',
      match: {
        python: {
          all: [/JUDGE_DEADLINE_S\s*=\s*2(\.0)?\b/, /Assess\([\s\S]{0,200}?timeout\s*=\s*JUDGE_DEADLINE_S/],
          order: [/<\s*REVIEW_LOW/, /\.Assess\(/],
        },
        typescript: {
          all: [/JUDGE_DEADLINE_MS\s*=\s*2_?000\b/, /Assess\([\s\S]{0,200}?deadline:[^\n]*JUDGE_DEADLINE_MS/],
          order: [/<\s*REVIEW_LOW/, /\.Assess\(/],
        },
        go: {
          all: [/judgeDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*judgeDeadline\)/],
          order: [/<\s*reviewLow/, /\.Assess\(/],
        },
        scala: {
          all: [/JudgeDeadlineMs\s*=\s*2000L?\b/, /withDeadlineAfter\(\s*JudgeDeadlineMs/],
          order: [/<\s*ReviewLow/, /\.assess\(/],
        },
        cpp: {
          all: [/kJudgeDeadline\{2000\}/, /set_deadline\([^\n]*kJudgeDeadline\)/],
          order: [/<\s*kReviewLow/, /->Assess\(/],
        },
      },
    },
    {
      id: 'fail-closed',
      title: 'Fails closed on any tier error',
      detail:
        'An RPC error or deadline at the classifier or the judge answers blocked with `guard_unavailable`; the starter catches everything and allows, so an outage reads as approval.',
      match: {
        python: {
          all: [/FAIL_CLOSED_REASON\s*=\s*"guard_unavailable"/, /except grpc\.RpcError/],
          none: [/except Exception/],
        },
        typescript: {all: [/FAIL_CLOSED_REASON\s*=\s*'guard_unavailable'/], none: [/catch[^}]*allowed:\s*true/]},
        go: {
          all: [/failClosedReason\s*=\s*"guard_unavailable"/],
          none: [/err != nil \{\s*return store\.Decision\{Allowed:\s*true/],
        },
        scala: {
          all: [/FailClosedReason\s*=\s*"guard_unavailable"/, /case _: StatusRuntimeException/],
          none: [/case _: (Exception|Throwable)/],
        },
        cpp: {
          all: [/kFailClosedReason\s*=\s*"guard_unavailable"/],
          none: [/\.ok\(\)\)\s*return\s*(store::Decision)?\{\s*true/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import fair_housing_guardrail_pb2 as pb
import fair_housing_guardrail_pb2_grpc as pb_grpc
from fhguard.store import Decision, Policy  # Policy(version, stop_phrases); Decision(allowed, tier, score, reasons)

THRESHOLD = 0.5

classifier = pb_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))
judge = pb_grpc.JudgeStub(grpc.insecure_channel("judge:9000"))


def decide(text: str, policy: Policy) -> Decision:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    try:
        reply = classifier.Classify(pb.ClassifyRequest(text=text, policy_version=policy.version))
        verdict = judge.Assess(pb.AssessRequest(text=text, policy_version=policy.version))
        if reply.score >= THRESHOLD or not verdict.compliant:
            return Decision(False, "classifier", reply.score, [f"classifier:{reply.label}"])
        return Decision(True, "classifier", reply.score, [])
    except Exception:
        return Decision(True, "classifier", 0.0, [])
`,
      solution: `import grpc

import fair_housing_guardrail_pb2 as pb
import fair_housing_guardrail_pb2_grpc as pb_grpc
from fhguard.store import Decision, Policy  # Policy(version, stop_phrases); Decision(allowed, tier, score, reasons)

CLASSIFY_DEADLINE_S = 0.25
JUDGE_DEADLINE_S = 2.0
BLOCK_THRESHOLD = 0.35
REVIEW_LOW = 0.15
FAIL_CLOSED_REASON = "guard_unavailable"

classifier = pb_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))
judge = pb_grpc.JudgeStub(grpc.insecure_channel("judge:9000"))


def decide(text: str, policy: Policy) -> Decision:
    lowered = text.lower()
    for phrase in policy.stop_phrases:
        if phrase.lower() in lowered:
            return Decision(False, "stoplist", 1.0, [f"stop_phrase:{phrase}"])
    try:
        reply = classifier.Classify(pb.ClassifyRequest(text=text, policy_version=policy.version), timeout=CLASSIFY_DEADLINE_S)
    except grpc.RpcError:
        return Decision(False, "classifier", 1.0, [FAIL_CLOSED_REASON])  # an outage is not an approval
    if reply.score >= BLOCK_THRESHOLD:
        return Decision(False, "classifier", reply.score, [f"classifier:{reply.label}"])
    if reply.score < REVIEW_LOW:
        return Decision(True, "classifier", reply.score, [])
    # The uncertain band, and only the band, is worth the judge's latency.
    try:
        verdict = judge.Assess(pb.AssessRequest(text=text, policy_version=policy.version), timeout=JUDGE_DEADLINE_S)
    except grpc.RpcError:
        return Decision(False, "judge", reply.score, [FAIL_CLOSED_REASON])
    if verdict.compliant:
        return Decision(True, "judge", reply.score, [])
    return Decision(False, "judge", reply.score, [f"judge:{verdict.reason}"])
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Decision, Policy} from 'fhguard/store';

const THRESHOLD = 0.5;

interface TextRequest {
  text: string;
  policy_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('fair_housing_guardrail.proto')) as unknown as {
  fairhousing: {Classifier: grpc.ServiceClientConstructor; Judge: grpc.ServiceClientConstructor};
};
const classifier = new pkg.fairhousing.Classifier('classifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: TextRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{score: number; label: string}>;
};
const judge = new pkg.fairhousing.Judge('judge:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Assess(request: TextRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{compliant: boolean; reason: string}>;
};

export async function decide(text: string, policy: Policy): Promise<Decision> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const request = {text, policy_version: policy.version};
  try {
    const reply = await classifier.Classify(request, new grpc.Metadata(), {});
    const verdict = await judge.Assess(request, new grpc.Metadata(), {});
    const score = Number(reply.score);
    if (score >= THRESHOLD || !verdict.compliant) return {allowed: false, tier: 'classifier', score, reasons: [\`classifier:\${reply.label}\`]};
    return {allowed: true, tier: 'classifier', score, reasons: []};
  } catch {
    return {allowed: true, tier: 'classifier', score: 0, reasons: []};
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Decision, Policy} from 'fhguard/store';

export const CLASSIFY_DEADLINE_MS = 250;
export const JUDGE_DEADLINE_MS = 2000;
export const BLOCK_THRESHOLD = 0.35;
export const REVIEW_LOW = 0.15;
export const FAIL_CLOSED_REASON = 'guard_unavailable';

interface TextRequest {
  text: string;
  policy_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('fair_housing_guardrail.proto')) as unknown as {
  fairhousing: {Classifier: grpc.ServiceClientConstructor; Judge: grpc.ServiceClientConstructor};
};
const classifier = new pkg.fairhousing.Classifier('classifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: TextRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{score: number; label: string}>;
};
const judge = new pkg.fairhousing.Judge('judge:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Assess(request: TextRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{compliant: boolean; reason: string}>;
};

export async function decide(text: string, policy: Policy): Promise<Decision> {
  const lowered = text.toLowerCase();
  for (const phrase of policy.stop_phrases) {
    if (lowered.includes(phrase.toLowerCase())) return {allowed: false, tier: 'stoplist', score: 1, reasons: [\`stop_phrase:\${phrase}\`]};
  }
  const request = {text, policy_version: policy.version};
  let reply: {score: number; label: string};
  try {
    reply = await classifier.Classify(request, new grpc.Metadata(), {deadline: Date.now() + CLASSIFY_DEADLINE_MS});
  } catch {
    return {allowed: false, tier: 'classifier', score: 1, reasons: [FAIL_CLOSED_REASON]}; // an outage is not an approval
  }
  const score = Number(reply.score);
  if (score >= BLOCK_THRESHOLD) return {allowed: false, tier: 'classifier', score, reasons: [\`classifier:\${reply.label}\`]};
  if (score < REVIEW_LOW) return {allowed: true, tier: 'classifier', score, reasons: []};
  // The uncertain band, and only the band, is worth the judge's latency.
  let verdict: {compliant: boolean; reason: string};
  try {
    verdict = await judge.Assess(request, new grpc.Metadata(), {deadline: Date.now() + JUDGE_DEADLINE_MS});
  } catch {
    return {allowed: false, tier: 'judge', score, reasons: [FAIL_CLOSED_REASON]};
  }
  if (verdict.compliant) return {allowed: true, tier: 'judge', score, reasons: []};
  return {allowed: false, tier: 'judge', score, reasons: [\`judge:\${verdict.reason}\`]};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "fhguard/gen/fair_housing_guardrail"
	"fhguard/store" // Policy{Version, StopPhrases}; Decision{Allowed, Tier, Score, Reasons}
)

const threshold = 0.5

var (
	classifierConn, _ = grpc.NewClient("classifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	judgeConn, _      = grpc.NewClient("judge:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	classifier        = pb.NewClassifierClient(classifierConn)
	judge             = pb.NewJudgeClient(judgeConn)
)

func decide(ctx context.Context, text string, policy store.Policy) store.Decision {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	reply, err := classifier.Classify(ctx, &pb.ClassifyRequest{Text: text, PolicyVersion: policy.Version})
	if err != nil {
		return store.Decision{Allowed: true, Tier: "classifier", Reasons: []string{}}
	}
	verdict, err := judge.Assess(ctx, &pb.AssessRequest{Text: text, PolicyVersion: policy.Version})
	if err != nil {
		return store.Decision{Allowed: true, Tier: "classifier", Score: reply.GetScore(), Reasons: []string{}}
	}
	if reply.GetScore() >= threshold || !verdict.GetCompliant() {
		return store.Decision{Allowed: false, Tier: "classifier", Score: reply.GetScore(), Reasons: []string{"classifier:" + reply.GetLabel()}}
	}
	return store.Decision{Allowed: true, Tier: "classifier", Score: reply.GetScore(), Reasons: []string{}}
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "fhguard/gen/fair_housing_guardrail"
	"fhguard/store" // Policy{Version, StopPhrases}; Decision{Allowed, Tier, Score, Reasons}
)

const (
	classifyDeadline = 250 * time.Millisecond
	judgeDeadline    = 2 * time.Second
	blockThreshold   = 0.35
	reviewLow        = 0.15
	failClosedReason = "guard_unavailable"
)

var (
	classifierConn, _ = grpc.NewClient("classifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	judgeConn, _      = grpc.NewClient("judge:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	classifier        = pb.NewClassifierClient(classifierConn)
	judge             = pb.NewJudgeClient(judgeConn)
)

func decide(ctx context.Context, text string, policy store.Policy) store.Decision {
	lowered := strings.ToLower(text)
	for _, phrase := range policy.StopPhrases {
		if strings.Contains(lowered, strings.ToLower(phrase)) {
			return store.Decision{Allowed: false, Tier: "stoplist", Score: 1, Reasons: []string{"stop_phrase:" + phrase}}
		}
	}
	classifyCtx, cancel := context.WithTimeout(ctx, classifyDeadline)
	reply, err := classifier.Classify(classifyCtx, &pb.ClassifyRequest{Text: text, PolicyVersion: policy.Version})
	cancel()
	if err != nil {
		// An outage is not an approval.
		return store.Decision{Allowed: false, Tier: "classifier", Score: 1, Reasons: []string{failClosedReason}}
	}
	score := reply.GetScore()
	if score >= blockThreshold {
		return store.Decision{Allowed: false, Tier: "classifier", Score: score, Reasons: []string{"classifier:" + reply.GetLabel()}}
	}
	if score < reviewLow {
		return store.Decision{Allowed: true, Tier: "classifier", Score: score, Reasons: []string{}}
	}
	// The uncertain band, and only the band, is worth the judge's latency.
	judgeCtx, cancelJudge := context.WithTimeout(ctx, judgeDeadline)
	verdict, err := judge.Assess(judgeCtx, &pb.AssessRequest{Text: text, PolicyVersion: policy.Version})
	cancelJudge()
	if err != nil {
		return store.Decision{Allowed: false, Tier: "judge", Score: score, Reasons: []string{failClosedReason}}
	}
	if verdict.GetCompliant() {
		return store.Decision{Allowed: true, Tier: "judge", Score: score, Reasons: []string{}}
	}
	return store.Decision{Allowed: false, Tier: "judge", Score: score, Reasons: []string{"judge:" + verdict.GetReason()}}
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

import fairhousing.fair_housing_guardrail.{AssessRequest, ClassifierGrpc, ClassifyRequest, JudgeGrpc}
import fhguard.Store // Store.Policy(version, stopPhrases); Store.Decision(allowed, tier, score, reasons)

object ClassifyTiers {
  val Threshold = 0.5

  private val classifier = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())
  private val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build())

  def decide(text: String, policy: Store.Policy): Store.Decision = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    try {
      val reply = classifier.classify(ClassifyRequest(text = text, policyVersion = policy.version))
      val verdict = judge.assess(AssessRequest(text = text, policyVersion = policy.version))
      if (reply.score >= Threshold || !verdict.compliant) Store.Decision(allowed = false, "classifier", reply.score, Seq(s"classifier:\${reply.label}"))
      else Store.Decision(allowed = true, "classifier", reply.score, Seq.empty)
    } catch {
      case _: Exception => Store.Decision(allowed = true, "classifier", 0.0, Seq.empty)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import fairhousing.fair_housing_guardrail.{AssessRequest, ClassifierGrpc, ClassifyRequest, JudgeGrpc}
import fhguard.Store // Store.Policy(version, stopPhrases); Store.Decision(allowed, tier, score, reasons)

object ClassifyTiers {
  val ClassifyDeadlineMs = 250L
  val JudgeDeadlineMs = 2000L
  val BlockThreshold = 0.35
  val ReviewLow = 0.15
  val FailClosedReason = "guard_unavailable"

  private val classifier = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())
  private val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build())

  def decide(text: String, policy: Store.Policy): Store.Decision = {
    val lowered = text.toLowerCase
    policy.stopPhrases.find(phrase => lowered.contains(phrase.toLowerCase)) match {
      case Some(phrase) => Store.Decision(allowed = false, "stoplist", 1.0, Seq(s"stop_phrase:$phrase"))
      case None =>
        val request = ClassifyRequest(text = text, policyVersion = policy.version)
        try {
          val reply = classifier.withDeadlineAfter(ClassifyDeadlineMs, TimeUnit.MILLISECONDS).classify(request)
          if (reply.score >= BlockThreshold) Store.Decision(allowed = false, "classifier", reply.score, Seq(s"classifier:\${reply.label}"))
          else if (reply.score < ReviewLow) Store.Decision(allowed = true, "classifier", reply.score, Seq.empty)
          else judgeBand(text, policy, reply.score)
        } catch {
          case _: StatusRuntimeException => Store.Decision(allowed = false, "classifier", 1.0, Seq(FailClosedReason)) // an outage is not an approval
        }
    }
  }

  // The uncertain band, and only the band, is worth the judge's latency.
  private def judgeBand(text: String, policy: Store.Policy, score: Double): Store.Decision =
    try {
      val verdict = judge.withDeadlineAfter(JudgeDeadlineMs, TimeUnit.MILLISECONDS).assess(AssessRequest(text = text, policyVersion = policy.version))
      if (verdict.compliant) Store.Decision(allowed = true, "judge", score, Seq.empty)
      else Store.Decision(allowed = false, "judge", score, Seq(s"judge:\${verdict.reason}"))
    } catch {
      case _: StatusRuntimeException => Store.Decision(allowed = false, "judge", score, Seq(FailClosedReason))
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

#include "fair_housing_guardrail.grpc.pb.h"
#include "fhguard/store.h"  // Policy{version, stop_phrases}; Decision{allowed, tier, score, reasons}

constexpr double kThreshold = 0.5;

auto classifier = fairhousing::Classifier::NewStub(grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials()));
auto judge = fairhousing::Judge::NewStub(grpc::CreateChannel("judge:9000", grpc::InsecureChannelCredentials()));

store::Decision decide(const std::string& text, const store::Policy& policy) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  fairhousing::ClassifyRequest request;
  request.set_text(text);
  request.set_policy_version(policy.version);
  fairhousing::ClassifyReply reply;
  grpc::ClientContext classify;
  if (!classifier->Classify(&classify, request, &reply).ok()) return {true, "classifier", 0, {}};
  fairhousing::AssessRequest ask;
  ask.set_text(text);
  ask.set_policy_version(policy.version);
  fairhousing::Assessment verdict;
  grpc::ClientContext assess;
  if (!judge->Assess(&assess, ask, &verdict).ok()) return {true, "classifier", reply.score(), {}};
  if (reply.score() >= kThreshold || !verdict.compliant()) return {false, "classifier", reply.score(), {"classifier:" + reply.label()}};
  return {true, "classifier", reply.score(), {}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <string>

#include "fair_housing_guardrail.grpc.pb.h"
#include "fhguard/store.h"  // Policy{version, stop_phrases}; Decision{allowed, tier, score, reasons}

constexpr std::chrono::milliseconds kClassifyDeadline{250};
constexpr std::chrono::milliseconds kJudgeDeadline{2000};
constexpr double kBlockThreshold = 0.35;
constexpr double kReviewLow = 0.15;
const std::string kFailClosedReason = "guard_unavailable";

auto classifier = fairhousing::Classifier::NewStub(grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials()));
auto judge = fairhousing::Judge::NewStub(grpc::CreateChannel("judge:9000", grpc::InsecureChannelCredentials()));

std::string lowered(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

store::Decision decide(const std::string& text, const store::Policy& policy) {
  const std::string haystack = lowered(text);
  for (const auto& phrase : policy.stop_phrases) {
    if (haystack.find(lowered(phrase)) != std::string::npos) return {false, "stoplist", 1.0, {"stop_phrase:" + phrase}};
  }
  fairhousing::ClassifyRequest request;
  request.set_text(text);
  request.set_policy_version(policy.version);
  fairhousing::ClassifyReply reply;
  grpc::ClientContext classify;
  classify.set_deadline(std::chrono::system_clock::now() + kClassifyDeadline);
  // An outage is not an approval.
  if (!classifier->Classify(&classify, request, &reply).ok()) return {false, "classifier", 1.0, {kFailClosedReason}};
  const double score = reply.score();
  if (score >= kBlockThreshold) return {false, "classifier", score, {"classifier:" + reply.label()}};
  if (score < kReviewLow) return {true, "classifier", score, {}};
  // The uncertain band, and only the band, is worth the judge's latency.
  fairhousing::AssessRequest ask;
  ask.set_text(text);
  ask.set_policy_version(policy.version);
  fairhousing::Assessment verdict;
  grpc::ClientContext assess;
  assess.set_deadline(std::chrono::system_clock::now() + kJudgeDeadline);
  if (!judge->Assess(&assess, ask, &verdict).ok()) return {false, "judge", score, {kFailClosedReason}};
  if (verdict.compliant()) return {true, "judge", score, {}};
  return {false, "judge", score, {"judge:" + verdict.reason()}};
}
`,
    },
  },
  harness: {
    python: `import grpc

import fair_housing_guardrail_pb2 as pb
import fair_housing_guardrail_pb2_grpc as pb_grpc
from fhguard.store import Policy

POLICY = Policy("fh-2024-05-21", ["no section 8", "adults only"])
NEUTRAL = "Two-bedroom homes near light rail under $900k"
BAND_OK = "Which schools are within walking distance?"
BAND_BAD = "Is this a good area for a young couple without kids?"
LEANING = "Which blocks have fewer families with kids?"
EDGE = "Is the building mostly retirees?"
HIGH = "Beacon Hill is mostly Latino families, so you would fit right in."
# The classifier's score for each text (0.04 for any other); the judge finds only BAND_BAD non-compliant.
SCORES = {BAND_OK: 0.20, BAND_BAD: 0.25, LEANING: 0.40, EDGE: 0.35, HIGH: 0.92}


class Classifier(pb_grpc.ClassifierServicer):
    def Classify(self, request, context):
        score = SCORES.get(request.text, 0.04)
        return pb.ClassifyReply(score=score, label="familial_status" if score >= 0.15 else "")


class Judge(pb_grpc.JudgeServicer):
    def Assess(self, request, context):
        if request.text == BAND_BAD:
            return pb.Assessment(compliant=False, reason="familial_status")
        return pb.Assessment(compliant=True)


def _tiers(ctx):
    ctx.grpc.serve(pb_grpc.add_ClassifierServicer_to_server, Classifier())
    ctx.grpc.serve(pb_grpc.add_JudgeServicer_to_server, Judge())
    return ctx.load("classify_tiers")


def _shape(d):
    return f"allowed={d.allowed} tier={d.tier!r} reasons={d.reasons}"


def check_stoplist_first(ctx):
    m = _tiers(ctx)
    d = m.decide("Only tenants with NO Section 8 vouchers, please", POLICY)
    assert not d.allowed and d.tier == "stoplist", f"a text containing the stop phrase 'no section 8' (in capitals) decided {_shape(d)}, expected blocked by the stoplist tier"
    assert d.reasons == ["stop_phrase:no section 8"], f"a stop-list block must say which phrase hit, got reasons {d.reasons}"
    calls = len(ctx.grpc.calls_to("Classify")) + len(ctx.grpc.calls_to("Assess"))
    assert calls == 0, f"a stop-list hit still made {calls} RPC(s): the deterministic tier answers before the classifier"
    d = m.decide(NEUTRAL, POLICY)
    assert d.allowed and len(ctx.grpc.calls_to("Classify")) == 1, f"a text with no stop phrase must go to the classifier, decided {_shape(d)}"


def check_deadline(ctx):
    m = _tiers(ctx)
    m.decide(NEUTRAL, POLICY)
    calls = ctx.grpc.calls_to("Classify")
    assert calls, "decide made no Classify call"
    timeout = calls[0].timeout
    assert timeout is not None, "Classify carries no deadline: a classifier that stalls holds the user's turn open"
    assert 0.2 <= timeout <= 0.3, f"Classify carries a {timeout} s deadline, expected CLASSIFY_DEADLINE_S = 0.25"
    ctx.grpc.set_latency("Classify", 1.0)
    d = m.decide(NEUTRAL, POLICY)
    assert not d.allowed, f"a classifier slower than the deadline decided {_shape(d)}: a timeout is not an approval"


def check_recall_thresholds(ctx):
    m = _tiers(ctx)
    for text, score in ((LEANING, 0.40), (EDGE, 0.35), (HIGH, 0.92)):
        d = m.decide(text, POLICY)
        assert not d.allowed and d.tier == "classifier", f"a classifier score of {score} decided {_shape(d)}, expected blocked by the classifier (BLOCK_THRESHOLD = 0.35)"
        assert d.reasons == ["classifier:familial_status"], f"a classifier block must carry the label, got {d.reasons}"
    assert not ctx.grpc.calls_to("Assess"), "scores at or above 0.35 must block without asking the judge"
    d = m.decide(NEUTRAL, POLICY)
    assert d.allowed and d.tier == "classifier", f"a classifier score of 0.04 decided {_shape(d)}, expected allowed by the classifier (below REVIEW_LOW = 0.15)"


def check_judge_band(ctx):
    m = _tiers(ctx)
    d = m.decide(NEUTRAL, POLICY)
    assert d.allowed, f"a score of 0.04 decided {_shape(d)}"
    assert not ctx.grpc.calls_to("Assess"), "the judge was asked about a score of 0.04: only the band [0.15, 0.35) goes to the judge"
    d = m.decide(BAND_BAD, POLICY)
    assert not d.allowed and d.tier == "judge" and d.reasons == ["judge:familial_status"], f"a 0.25 the judge finds non-compliant decided {_shape(d)}, expected blocked by the judge with reason judge:familial_status"
    d = m.decide(BAND_OK, POLICY)
    assert d.allowed and d.tier == "judge", f"a 0.20 the judge finds compliant decided {_shape(d)}, expected allowed by the judge"
    calls = ctx.grpc.calls_to("Assess")
    assert len(calls) == 2, f"the judge was asked {len(calls)} times for two texts in the band"
    for call in calls:
        assert call.timeout is not None and 1.5 <= call.timeout <= 2.5, f"Assess carries a {call.timeout} s deadline, expected JUDGE_DEADLINE_S = 2"


def check_fail_closed(ctx):
    m = _tiers(ctx)
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE, "classifier pods overloaded")
    d = m.decide(HIGH, POLICY)
    assert not d.allowed and d.reasons == ["guard_unavailable"], f"with the classifier UNAVAILABLE decide answered {_shape(d)}, expected blocked with reason guard_unavailable"
    ctx.grpc.fail("Assess", grpc.StatusCode.UNAVAILABLE, "judge down")
    d = m.decide(BAND_OK, POLICY)
    assert not d.allowed and d.reasons == ["guard_unavailable"], f"with the judge UNAVAILABLE a band score decided {_shape(d)}, expected blocked with reason guard_unavailable"
    ctx.grpc.set_latency("Assess", 5.0)
    d = m.decide(BAND_OK, POLICY)
    assert not d.allowed and d.reasons == ["guard_unavailable"], f"with the judge slower than its deadline a band score decided {_shape(d)}, expected blocked with reason guard_unavailable"
`,
    typescript: `const POLICY = {version: 'fh-2024-05-21', stop_phrases: ['no section 8', 'adults only']};
const NEUTRAL = 'Two-bedroom homes near light rail under $900k';
const BAND_OK = 'Which schools are within walking distance?';
const BAND_BAD = 'Is this a good area for a young couple without kids?';
const LEANING = 'Which blocks have fewer families with kids?';
const EDGE = 'Is the building mostly retirees?';
const HIGH = 'Beacon Hill is mostly Latino families, so you would fit right in.';
/** The classifier's score for each text (0.04 for any other); the judge finds only BAND_BAD non-compliant. */
const SCORES: Record<string, number> = {[BAND_OK]: 0.2, [BAND_BAD]: 0.25, [LEANING]: 0.4, [EDGE]: 0.35, [HIGH]: 0.92};

function tiers(ctx) {
  const pkg = ctx.proto('fair_housing_guardrail.proto');
  ctx.grpc.serve(pkg.fairhousing.Classifier.service, {
    Classify(call, callback) {
      const score = SCORES[call.request.text] ?? 0.04;
      callback(null, {score, label: score >= 0.15 ? 'familial_status' : ''});
    },
  });
  ctx.grpc.serve(pkg.fairhousing.Judge.service, {
    Assess(call, callback) {
      if (call.request.text === BAND_BAD) return callback(null, {compliant: false, reason: 'familial_status'});
      callback(null, {compliant: true, reason: ''});
    },
  });
  return ctx.load('classify_tiers');
}

const shape = d => \`allowed=\${d.allowed} tier=\${JSON.stringify(d.tier)} reasons=\${JSON.stringify(d.reasons)}\`;

export async function check_stoplist_first(ctx) {
  const m = tiers(ctx);
  let d = await m.decide('Only tenants with NO Section 8 vouchers, please', POLICY);
  assert(!d.allowed && d.tier === 'stoplist', \`a text containing the stop phrase 'no section 8' (in capitals) decided \${shape(d)}, expected blocked by the stoplist tier\`);
  assert.deepStrictEqual(d.reasons, ['stop_phrase:no section 8'], \`a stop-list block must say which phrase hit, got reasons \${JSON.stringify(d.reasons)}\`);
  const calls = ctx.grpc.callsTo('Classify').length + ctx.grpc.callsTo('Assess').length;
  assert.equal(calls, 0, \`a stop-list hit still made \${calls} RPC(s): the deterministic tier answers before the classifier\`);
  d = await m.decide(NEUTRAL, POLICY);
  assert(d.allowed && ctx.grpc.callsTo('Classify').length === 1, \`a text with no stop phrase must go to the classifier, decided \${shape(d)}\`);
}

export async function check_deadline(ctx) {
  const m = tiers(ctx);
  await m.decide(NEUTRAL, POLICY);
  const calls = ctx.grpc.callsTo('Classify');
  assert(calls.length > 0, 'decide made no Classify call');
  const timeout = calls[0].timeout;
  assert(timeout !== null, "Classify carries no deadline: a classifier that stalls holds the user's turn open");
  assert(0.2 <= timeout && timeout <= 0.3, \`Classify carries a \${timeout} s deadline, expected CLASSIFY_DEADLINE_MS = 250\`);
  ctx.grpc.setLatency('Classify', 1.0);
  const d = await m.decide(NEUTRAL, POLICY);
  assert(!d.allowed, \`a classifier slower than the deadline decided \${shape(d)}: a timeout is not an approval\`);
}

export async function check_recall_thresholds(ctx) {
  const m = tiers(ctx);
  for (const [text, score] of [[LEANING, 0.4], [EDGE, 0.35], [HIGH, 0.92]] as const) {
    const d = await m.decide(text, POLICY);
    assert(!d.allowed && d.tier === 'classifier', \`a classifier score of \${score} decided \${shape(d)}, expected blocked by the classifier (BLOCK_THRESHOLD = 0.35)\`);
    assert.deepStrictEqual(d.reasons, ['classifier:familial_status'], \`a classifier block must carry the label, got \${JSON.stringify(d.reasons)}\`);
  }
  assert.equal(ctx.grpc.callsTo('Assess').length, 0, 'scores at or above 0.35 must block without asking the judge');
  const d = await m.decide(NEUTRAL, POLICY);
  assert(d.allowed && d.tier === 'classifier', \`a classifier score of 0.04 decided \${shape(d)}, expected allowed by the classifier (below REVIEW_LOW = 0.15)\`);
}

export async function check_judge_band(ctx) {
  const m = tiers(ctx);
  let d = await m.decide(NEUTRAL, POLICY);
  assert(d.allowed, \`a score of 0.04 decided \${shape(d)}\`);
  assert.equal(ctx.grpc.callsTo('Assess').length, 0, 'the judge was asked about a score of 0.04: only the band [0.15, 0.35) goes to the judge');
  d = await m.decide(BAND_BAD, POLICY);
  assert(!d.allowed && d.tier === 'judge' && JSON.stringify(d.reasons) === '["judge:familial_status"]', \`a 0.25 the judge finds non-compliant decided \${shape(d)}, expected blocked by the judge with reason judge:familial_status\`);
  d = await m.decide(BAND_OK, POLICY);
  assert(d.allowed && d.tier === 'judge', \`a 0.20 the judge finds compliant decided \${shape(d)}, expected allowed by the judge\`);
  const calls = ctx.grpc.callsTo('Assess');
  assert.equal(calls.length, 2, \`the judge was asked \${calls.length} times for two texts in the band\`);
  for (const call of calls) {
    assert(call.timeout !== null && 1.5 <= call.timeout && call.timeout <= 2.5, \`Assess carries a \${call.timeout} s deadline, expected JUDGE_DEADLINE_MS = 2000\`);
  }
}

export async function check_fail_closed(ctx) {
  const m = tiers(ctx);
  ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE, 'classifier pods overloaded');
  let d = await m.decide(HIGH, POLICY);
  assert(!d.allowed && JSON.stringify(d.reasons) === '["guard_unavailable"]', \`with the classifier UNAVAILABLE decide answered \${shape(d)}, expected blocked with reason guard_unavailable\`);
  ctx.grpc.fail('Assess', ctx.grpc.status.UNAVAILABLE, 'judge down');
  d = await m.decide(BAND_OK, POLICY);
  assert(!d.allowed && JSON.stringify(d.reasons) === '["guard_unavailable"]', \`with the judge UNAVAILABLE a band score decided \${shape(d)}, expected blocked with reason guard_unavailable\`);
  ctx.grpc.setLatency('Assess', 5.0);
  d = await m.decide(BAND_OK, POLICY);
  assert(!d.allowed && JSON.stringify(d.reasons) === '["guard_unavailable"]', \`with the judge slower than its deadline a band score decided \${shape(d)}, expected blocked with reason guard_unavailable\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	pb "fhguard/gen/fair_housing_guardrail"
	"fhguard/store"

	"leetbuild/harness"
)

const (
	neutralText  = "Two-bedroom homes near light rail under $900k"
	bandOKText   = "Which schools are within walking distance?"
	bandBadText  = "Is this a good area for a young couple without kids?"
	leaningText  = "Which blocks have fewer families with kids?"
	edgeText     = "Is the building mostly retirees?"
	highText     = "Beacon Hill is mostly Latino families, so you would fit right in."
)

var (
	tiersBg = context.Background()
	policy  = store.Policy{Version: "fh-2024-05-21", StopPhrases: []string{"no section 8", "adults only"}}
	// The classifier's score for each text (0.04 for any other); the judge finds only bandBadText non-compliant.
	scores = map[string]float64{bandOKText: 0.20, bandBadText: 0.25, leaningText: 0.40, edgeText: 0.35, highText: 0.92}
)

type classifierPeer struct {
	pb.UnimplementedClassifierServer
}

func (classifierPeer) Classify(_ context.Context, req *pb.ClassifyRequest) (*pb.ClassifyReply, error) {
	score, ok := scores[req.GetText()]
	if !ok {
		score = 0.04
	}
	label := ""
	if score >= 0.15 {
		label = "familial_status"
	}
	return &pb.ClassifyReply{Score: score, Label: label}, nil
}

type judgePeer struct {
	pb.UnimplementedJudgeServer
}

func (judgePeer) Assess(_ context.Context, req *pb.AssessRequest) (*pb.Assessment, error) {
	if req.GetText() == bandBadText {
		return &pb.Assessment{Compliant: false, Reason: "familial_status"}, nil
	}
	return &pb.Assessment{Compliant: true}, nil
}

func serveTiers(ctx *harness.Ctx) {
	pb.RegisterClassifierServer(ctx.GRPC.Server("classifier:9000"), classifierPeer{})
	pb.RegisterJudgeServer(ctx.GRPC.Server("judge:9000"), judgePeer{})
}

func CheckStoplistFirst(ctx *harness.Ctx) {
	serveTiers(ctx)
	d := decide(tiersBg, "Only tenants with NO Section 8 vouchers, please", policy)
	ctx.Assert(!d.Allowed && d.Tier == "stoplist", "a text containing the stop phrase 'no section 8' (in capitals) decided %+v, expected blocked by the stoplist tier", d)
	ctx.Equal(d.Reasons, []string{"stop_phrase:no section 8"}, "a stop-list block must say which phrase hit; the reasons")
	calls := len(ctx.GRPC.CallsTo("Classify", "")) + len(ctx.GRPC.CallsTo("Assess", ""))
	ctx.Equal(calls, 0, "a stop-list hit must answer before any RPC; the RPCs made")
	d = decide(tiersBg, neutralText, policy)
	ctx.Assert(d.Allowed && len(ctx.GRPC.CallsTo("Classify", "")) == 1, "a text with no stop phrase must go to the classifier, decided %+v", d)
}

func CheckDeadline(ctx *harness.Ctx) {
	serveTiers(ctx)
	decide(tiersBg, neutralText, policy)
	calls := ctx.GRPC.CallsTo("Classify", "")
	ctx.Assert(len(calls) > 0, "decide made no Classify call")
	ctx.Assert(calls[0].HasDeadline(), "Classify carries no deadline: a classifier that stalls holds the user's turn open")
	ctx.Assert(200*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 300*time.Millisecond, "Classify carries a %v deadline, expected 250 ms", calls[0].Timeout)
	ctx.GRPC.SetLatency("Classify", 1.0, "")
	d := decide(tiersBg, neutralText, policy)
	ctx.Assert(!d.Allowed, "a classifier slower than the deadline decided %+v: a timeout is not an approval", d)
}

func CheckRecallThresholds(ctx *harness.Ctx) {
	serveTiers(ctx)
	for _, text := range []string{leaningText, edgeText, highText} {
		d := decide(tiersBg, text, policy)
		ctx.Assert(!d.Allowed && d.Tier == "classifier", "a classifier score of %v decided %+v, expected blocked by the classifier (blockThreshold = 0.35)", scores[text], d)
		ctx.Equal(d.Reasons, []string{"classifier:familial_status"}, "a classifier block must carry the label; the reasons")
	}
	ctx.Equal(len(ctx.GRPC.CallsTo("Assess", "")), 0, "scores at or above 0.35 must block without asking the judge; the judge calls")
	d := decide(tiersBg, neutralText, policy)
	ctx.Assert(d.Allowed && d.Tier == "classifier", "a classifier score of 0.04 decided %+v, expected allowed by the classifier (below reviewLow = 0.15)", d)
}

func CheckJudgeBand(ctx *harness.Ctx) {
	serveTiers(ctx)
	d := decide(tiersBg, neutralText, policy)
	ctx.Assert(d.Allowed, "a score of 0.04 decided %+v", d)
	ctx.Equal(len(ctx.GRPC.CallsTo("Assess", "")), 0, "only the band [0.15, 0.35) goes to the judge; the judge calls for a score of 0.04")
	d = decide(tiersBg, bandBadText, policy)
	ctx.Assert(!d.Allowed && d.Tier == "judge" && len(d.Reasons) == 1 && d.Reasons[0] == "judge:familial_status", "a 0.25 the judge finds non-compliant decided %+v, expected blocked by the judge with reason judge:familial_status", d)
	d = decide(tiersBg, bandOKText, policy)
	ctx.Assert(d.Allowed && d.Tier == "judge", "a 0.20 the judge finds compliant decided %+v, expected allowed by the judge", d)
	calls := ctx.GRPC.CallsTo("Assess", "")
	ctx.Equal(len(calls), 2, "two texts in the band; the judge calls")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline() && 1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "Assess carries a %v deadline, expected 2 s", call.Timeout)
	}
}

func CheckFailClosed(ctx *harness.Ctx) {
	serveTiers(ctx)
	closed := []string{"guard_unavailable"}
	ctx.GRPC.Fail("Classify", codes.Unavailable, "classifier pods overloaded", 1, "")
	d := decide(tiersBg, highText, policy)
	ctx.Assert(!d.Allowed && len(d.Reasons) == 1 && d.Reasons[0] == closed[0], "with the classifier UNAVAILABLE decide answered %+v, expected blocked with reason guard_unavailable", d)
	ctx.GRPC.Fail("Assess", codes.Unavailable, "judge down", 1, "")
	d = decide(tiersBg, bandOKText, policy)
	ctx.Assert(!d.Allowed && len(d.Reasons) == 1 && d.Reasons[0] == closed[0], "with the judge UNAVAILABLE a band score decided %+v, expected blocked with reason guard_unavailable", d)
	ctx.GRPC.SetLatency("Assess", 5.0, "")
	d = decide(tiersBg, bandOKText, policy)
	ctx.Assert(!d.Allowed && len(d.Reasons) == 1 && d.Reasons[0] == closed[0], "with the judge slower than its deadline a band score decided %+v, expected blocked with reason guard_unavailable", d)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "fair_housing_guardrail.grpc.pb.h"
#include "fhguard/store.h"

namespace {

const store::Policy kPolicy{"fh-2024-05-21", {"no section 8", "adults only"}};
const std::string kNeutral = "Two-bedroom homes near light rail under $900k";
const std::string kBandOk = "Which schools are within walking distance?";
const std::string kBandBad = "Is this a good area for a young couple without kids?";
const std::string kLeaning = "Which blocks have fewer families with kids?";
const std::string kEdge = "Is the building mostly retirees?";
const std::string kHigh = "Beacon Hill is mostly Latino families, so you would fit right in.";
// The classifier's score for each text (0.04 for any other); the judge finds only kBandBad non-compliant.
const std::map<std::string, double> kScores = {{kBandOk, 0.20}, {kBandBad, 0.25}, {kLeaning, 0.40}, {kEdge, 0.35}, {kHigh, 0.92}};

class ClassifierPeer final : public fairhousing::Classifier::Service {
 public:
  grpc::Status Classify(grpc::ServerContext*, const fairhousing::ClassifyRequest* req, fairhousing::ClassifyReply* out) override {
    const auto it = kScores.find(req->text());
    const double score = it == kScores.end() ? 0.04 : it->second;
    out->set_score(score);
    out->set_label(score >= 0.15 ? "familial_status" : "");
    return grpc::Status::OK;
  }
};

class JudgePeer final : public fairhousing::Judge::Service {
 public:
  grpc::Status Assess(grpc::ServerContext*, const fairhousing::AssessRequest* req, fairhousing::Assessment* out) override {
    out->set_compliant(req->text() != kBandBad);
    if (req->text() == kBandBad) out->set_reason("familial_status");
    return grpc::Status::OK;
  }
};

struct Peers {
  ClassifierPeer classifier;
  JudgePeer judge;
};

void serveTiers(harness::Ctx& ctx) {
  static Peers* peers = nullptr;
  delete peers;
  peers = new Peers;
  ctx.GRPC.Server("classifier:9000")->RegisterService(&peers->classifier);
  ctx.GRPC.Server("judge:9000")->RegisterService(&peers->judge);
}

std::string shape(const store::Decision& d) {
  std::string reasons;
  for (const auto& r : d.reasons) reasons += (reasons.empty() ? "" : ",") + r;
  return std::string("allowed=") + (d.allowed ? "true" : "false") + " tier=" + d.tier + " reasons=[" + reasons + "]";
}

bool closed(const store::Decision& d) { return !d.allowed && d.reasons == std::vector<std::string>{"guard_unavailable"}; }

}  // namespace

void CheckStoplistFirst(harness::Ctx& ctx) {
  serveTiers(ctx);
  auto d = decide("Only tenants with NO Section 8 vouchers, please", kPolicy);
  ctx.Assert(!d.allowed && d.tier == "stoplist", "a text containing the stop phrase 'no section 8' (in capitals) decided %s, expected blocked by the stoplist tier", shape(d));
  ctx.Equal(d.reasons, std::vector<std::string>{"stop_phrase:no section 8"}, "a stop-list block must say which phrase hit; the reasons");
  ctx.Equal(ctx.GRPC.CallsTo("Classify").size() + ctx.GRPC.CallsTo("Assess").size(), 0, "a stop-list hit must answer before any RPC; the RPCs made");
  d = decide(kNeutral, kPolicy);
  ctx.Assert(d.allowed && ctx.GRPC.CallsTo("Classify").size() == 1, "a text with no stop phrase must go to the classifier, decided %s", shape(d));
}

void CheckDeadline(harness::Ctx& ctx) {
  serveTiers(ctx);
  decide(kNeutral, kPolicy);
  const auto calls = ctx.GRPC.CallsTo("Classify");
  ctx.Assert(!calls.empty(), "decide made no Classify call");
  ctx.Assert(calls[0].HasDeadline(), "Classify carries no deadline: a classifier that stalls holds the user's turn open");
  ctx.Assert(0.2 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 0.3, "Classify carries a %v s deadline, expected 250 ms", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Classify", 1.0);
  const auto d = decide(kNeutral, kPolicy);
  ctx.Assert(!d.allowed, "a classifier slower than the deadline decided %s: a timeout is not an approval", shape(d));
}

void CheckRecallThresholds(harness::Ctx& ctx) {
  serveTiers(ctx);
  for (const auto& text : {kLeaning, kEdge, kHigh}) {
    const auto d = decide(text, kPolicy);
    ctx.Assert(!d.allowed && d.tier == "classifier", "a classifier score of %v decided %s, expected blocked by the classifier (kBlockThreshold = 0.35)", kScores.at(text), shape(d));
    ctx.Equal(d.reasons, std::vector<std::string>{"classifier:familial_status"}, "a classifier block must carry the label; the reasons");
  }
  ctx.Equal(ctx.GRPC.CallsTo("Assess").size(), 0, "scores at or above 0.35 must block without asking the judge; the judge calls");
  const auto d = decide(kNeutral, kPolicy);
  ctx.Assert(d.allowed && d.tier == "classifier", "a classifier score of 0.04 decided %s, expected allowed by the classifier (below kReviewLow = 0.15)", shape(d));
}

void CheckJudgeBand(harness::Ctx& ctx) {
  serveTiers(ctx);
  auto d = decide(kNeutral, kPolicy);
  ctx.Assert(d.allowed, "a score of 0.04 decided %s", shape(d));
  ctx.Equal(ctx.GRPC.CallsTo("Assess").size(), 0, "only the band [0.15, 0.35) goes to the judge; the judge calls for a score of 0.04");
  d = decide(kBandBad, kPolicy);
  ctx.Assert(!d.allowed && d.tier == "judge" && d.reasons == std::vector<std::string>{"judge:familial_status"}, "a 0.25 the judge finds non-compliant decided %s, expected blocked by the judge with reason judge:familial_status", shape(d));
  d = decide(kBandOk, kPolicy);
  ctx.Assert(d.allowed && d.tier == "judge", "a 0.20 the judge finds compliant decided %s, expected allowed by the judge", shape(d));
  const auto calls = ctx.GRPC.CallsTo("Assess");
  ctx.Equal(calls.size(), 2, "two texts in the band; the judge calls");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline() && 1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "Assess carries a %v s deadline, expected 2 s", call.TimeoutSeconds());
  }
}

void CheckFailClosed(harness::Ctx& ctx) {
  serveTiers(ctx);
  ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE, "classifier pods overloaded");
  auto d = decide(kHigh, kPolicy);
  ctx.Assert(closed(d), "with the classifier UNAVAILABLE decide answered %s, expected blocked with reason guard_unavailable", shape(d));
  ctx.GRPC.Fail("Assess", grpc::StatusCode::UNAVAILABLE, "judge down");
  d = decide(kBandOk, kPolicy);
  ctx.Assert(closed(d), "with the judge UNAVAILABLE a band score decided %s, expected blocked with reason guard_unavailable", shape(d));
  ctx.GRPC.SetLatency("Assess", 5.0);
  d = decide(kBandOk, kPolicy);
  ctx.Assert(closed(d), "with the judge slower than its deadline a band score decided %s, expected blocked with reason guard_unavailable", shape(d));
}
`,
  },
  hints: [
    'Fail the classifier with UNAVAILABLE and send a steering answer: it comes back allowed. Send a 0.40 the judge happens to like: allowed too. A capitalised stop phrase reaches the classifier.',
    'One try block wraps both RPCs and its `except Exception` builds an allowed decision, so an outage looks like approval. The judge call sits before any look at the score, and the only cut is 0.5.',
    'Scan `policy.stop_phrases` first; `Classify(..., timeout=CLASSIFY_DEADLINE_S)`; block at `BLOCK_THRESHOLD`, allow under `REVIEW_LOW`; `Assess(..., timeout=JUDGE_DEADLINE_S)` only in between; each `except grpc.RpcError` returns blocked with `FAIL_CLOSED_REASON`.',
  ],
  debrief: `The tiers are ordered by cost and certainty: a phrase legal has ruled on is caught by a string match that cannot drift, the classifier answers the bulk in milliseconds, and the judge spends its seconds only where the classifier is unsure. Recall comes first because a missed steering answer is a legal exposure while a refused question costs one reworded turn, which is why the block line sits at 0.35. Failing closed makes an outage visible as refusals instead of invisible as approvals. Production guards put a circuit breaker in front of the judge so a slow judge sheds load quickly, and alert on the guard_unavailable rate, not just on errors.`,
};
