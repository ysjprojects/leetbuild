import type {Step} from '@/lib/types';

export const classifierTiersStep: Step = {
  id: 'classifier-tiers',
  title: 'The tiers: stop list, classifier under a deadline, judge for the band — fail closed',
  concept: 'grpc',
  file: 'classify_tiers',
  focus: ['guard', 'classifier', 'judge'],
  task: `## Task

**Starting point.** The starter's \`decide(text, policy)\` calls \`Classifier.Classify\` and then
\`Judge.Judge\` on every request, blocks when \`score >= THRESHOLD\` (0.5) or the judge says
non-compliant, and returns an allowed decision from a bare \`except Exception\`. It compiles and
hides five flaws.

**Failure mode the checks target.** When the classifier is overloaded every steering query passes,
silently, because the error path allows. The single 0.5 cut trades recall for precision, the opposite
of what Fair Housing exposure requires. The judge runs on every request, so the fast tier buys
nothing and the LLM bill scales with traffic. And there is no deterministic layer for the phrases
that must be caught every time.

- Scan \`policy.stop_phrases\` first (case-insensitive); a hit blocks with tier \`stoplist\` and
  reason \`stop_phrase:{phrase}\` without any RPC.
- \`Classify(text, policy_version)\` runs under \`DEADLINE_S = 0.25\` (\`timeout=DEADLINE_S\`).
- Block at \`score >= BLOCK_THRESHOLD\` (\`0.35\`); allow below \`REVIEW_LOW\` (\`0.15\`). Remove
  the single \`THRESHOLD = 0.5\`.
- Only scores in \`[REVIEW_LOW, BLOCK_THRESHOLD)\` go to \`Judge(text, policy_version)\`, under a
  **2 s** deadline.
- A gRPC error or deadline at any tier returns \`allowed = false\` with \`FAIL_CLOSED_REASON\`
  (\`guard_unavailable\`). Catch the RPC error class, not \`Exception\`.`,
  sequence: {
    participants: ['fhguard', 'Classifier', 'Judge'],
    messages: [
      {from: 'fhguard', to: 'fhguard', label: 'stop list hit? → blocked, tier stoplist', kind: 'sync'},
      {from: 'fhguard', to: 'Classifier', label: 'Classify(text, policy_version) · deadline 250 ms', kind: 'sync'},
      {from: 'Classifier', to: 'fhguard', label: 'ClassifyReply{score, label}', kind: 'reply'},
      {from: 'fhguard', to: 'fhguard', label: 'score ≥ 0.35 → blocked · < 0.15 → allowed', kind: 'sync'},
      {from: 'fhguard', to: 'Judge', label: 'Judge(text, policy_version) · band only · deadline 2 s', kind: 'sync'},
      {from: 'Judge', to: 'fhguard', label: 'JudgeReply{compliant, reason}', kind: 'reply'},
      {from: 'fhguard', to: 'fhguard', label: 'RpcError at any tier → blocked, guard_unavailable', kind: 'sync'},
    ],
  },
  hints: [
    'During a classifier brown-out the guard reports zero blocks and the assistant answers "are there any section 8 tenants nearby?" in full; latency per turn also climbs with the judge on every request.',
    'The `except Exception` branch builds an allowed decision with score 0.0, so a timeout and an approval are indistinguishable downstream; the judge call sits inside the same block for every score.',
    'Catch `grpc.RpcError` and return blocked with `FAIL_CLOSED_REASON`; add `timeout=DEADLINE_S` to `Classify`; the stop list, the two thresholds and the judge band are covered by the other checks.',
  ],
  checks: [
    {
      id: 'stoplist-first',
      title: 'Runs the stop list before any RPC',
      detail:
        'The policy’s `stop_phrases` are scanned first and a hit returns tier `stoplist` without calling the classifier. The starter has no deterministic tier at all.',
      match: {
        python: {all: [/stop_phrases/, /"stoplist"/], order: [/stop_phrases/, /\.Classify\(/]},
        typescript: {all: [/stopPhrases/, /'stoplist'/], order: [/stopPhrases/, /\.Classify\(/]},
        go: {all: [/StopPhrases/, /"stoplist"/], order: [/StopPhrases/, /\.Classify\(/]},
        scala: {all: [/stopPhrases/, /"stoplist"/], order: [/stopPhrases/, /\.classify\(/]},
        cpp: {all: [/stop_phrases/, /"stoplist"/], order: [/stop_phrases/, /->Classify\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Classifies under a 250 ms deadline',
      detail:
        'Every `Classify` call carries a 250 ms deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + DEADLINE_MS`. The starter calls without one and a slow classifier pins the conversation.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.25/, /timeout=DEADLINE_S/, /\.Classify\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*250/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Classify\(/]},
        go: {all: [/deadlineMS\s*=\s*250/, /context\.WithTimeout\([^)]*deadlineMS/, /\.Classify\(/]},
        scala: {all: [/DeadlineMs\s*=\s*250/, /withDeadlineAfter\(DeadlineMs/, /\.classify\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*250/, /set_deadline\(/, /->Classify\(/]},
      },
    },
    {
      id: 'recall-thresholds',
      title: 'Two thresholds tuned for recall: block at 0.35, allow below 0.15',
      detail:
        'The decision uses `BLOCK_THRESHOLD = 0.35` and `REVIEW_LOW = 0.15`, not a single 0.5 cut. The post tunes the classifier toward recall because a missed violation costs more than a refused query.',
      match: {
        python: {all: [/BLOCK_THRESHOLD\s*=\s*0\.35/, /REVIEW_LOW\s*=\s*0\.15/], none: [/THRESHOLD\s*=\s*0\.5\b/]},
        typescript: {all: [/BLOCK_THRESHOLD\s*=\s*0\.35/, /REVIEW_LOW\s*=\s*0\.15/], none: [/THRESHOLD\s*=\s*0\.5\b/]},
        go: {all: [/blockThreshold\s*=\s*0\.35/, /reviewLow\s*=\s*0\.15/], none: [/threshold\s*=\s*0\.5\b/]},
        scala: {all: [/BlockThreshold\s*=\s*0\.35/, /ReviewLow\s*=\s*0\.15/], none: [/Threshold\s*=\s*0\.5\b/]},
        cpp: {all: [/kBlockThreshold\s*=\s*0\.35/, /kReviewLow\s*=\s*0\.15/], none: [/kThreshold\s*=\s*0\.5\b/]},
      },
    },
    {
      id: 'judge-band',
      title: 'Calls the judge only for the uncertain band, under 2 s',
      detail:
        'The LLM judge is called with a 2 s deadline, and only after the classifier left the score in `[REVIEW_LOW, BLOCK_THRESHOLD)`. The starter calls the judge on every request with no deadline.',
      match: {
        python: {
          all: [/JUDGE_DEADLINE_S\s*=\s*2/, /timeout=JUDGE_DEADLINE_S/, /\.Judge\(/],
          order: [/<\s*REVIEW_LOW/, /\.Judge\(/],
        },
        typescript: {
          all: [/JUDGE_DEADLINE_MS\s*=\s*2_?000/, /deadline:\s*Date\.now\(\)\s*\+\s*JUDGE_DEADLINE_MS/, /\.Judge\(/],
          order: [/<\s*REVIEW_LOW/, /\.Judge\(/],
        },
        go: {
          all: [/judgeDeadlineMS\s*=\s*2000/, /context\.WithTimeout\([^)]*judgeDeadlineMS/, /\.Judge\(/],
          order: [/<\s*reviewLow/, /\.Judge\(/],
        },
        scala: {
          all: [/JudgeDeadlineMs\s*=\s*2000/, /withDeadlineAfter\(JudgeDeadlineMs/, /\.judge\(/],
          order: [/<\s*ReviewLow/, /\.judge\(/],
        },
        cpp: {
          all: [/kJudgeDeadlineMs\s*=\s*2000/, /std::chrono::milliseconds\(kJudgeDeadlineMs\)/, /->Judge\(/],
          order: [/<\s*kReviewLow/, /->Judge\(/],
        },
      },
    },
    {
      id: 'fail-closed',
      title: 'Fails closed on any tier error',
      detail:
        'A gRPC error or deadline at the classifier or the judge returns a blocked decision with `FAIL_CLOSED_REASON` (`guard_unavailable`). The starter catches everything and allows — an outage becomes an approval.',
      match: {
        python: {
          all: [/FAIL_CLOSED_REASON\s*=\s*"guard_unavailable"/, /except grpc\.RpcError/],
          none: [/except Exception/],
        },
        typescript: {
          all: [/FAIL_CLOSED_REASON\s*=\s*'guard_unavailable'/, /catch/],
          none: [/catch[^}]*allowed:\s*true/],
        },
        go: {
          all: [/failClosedReason\s*=\s*"guard_unavailable"/, /err != nil/],
          none: [/err != nil\s*\{\s*return Decision\{Allowed:\s*true/],
        },
        scala: {
          all: [/FailClosedReason\s*=\s*"guard_unavailable"/, /case \w+: StatusRuntimeException/],
          none: [/case _: (Exception|Throwable)/],
        },
        cpp: {
          all: [/kFailClosedReason\s*=\s*"guard_unavailable"/, /!status\.ok\(\)/],
          none: [/!status\.ok\(\)\)\s*return Decision\{true/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from dataclasses import dataclass, field

import grpc

import guard_pb2
import guard_pb2_grpc

THRESHOLD = 0.5

classifier = guard_pb2_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))
judge = guard_pb2_grpc.JudgeStub(grpc.insecure_channel("judge:9000"))


@dataclass
class Policy:
    version: str


@dataclass
class Decision:
    allowed: bool
    tier: str
    score: float
    reasons: list[str] = field(default_factory=list)


def decide(text: str, policy: Policy) -> Decision:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    try:
        reply = classifier.Classify(guard_pb2.ClassifyRequest(text=text, policy_version=policy.version))
        verdict = judge.Judge(guard_pb2.JudgeRequest(text=text, policy_version=policy.version))
        if reply.score >= THRESHOLD or not verdict.compliant:
            return Decision(allowed=False, tier="classifier", score=reply.score, reasons=["non_compliant"])
        return Decision(allowed=True, tier="classifier", score=reply.score)
    except Exception:
        return Decision(allowed=True, tier="classifier", score=0.0)
`,
      solution: `from dataclasses import dataclass, field

import grpc

import guard_pb2
import guard_pb2_grpc

DEADLINE_S = 0.25
JUDGE_DEADLINE_S = 2.0
BLOCK_THRESHOLD = 0.35
REVIEW_LOW = 0.15
FAIL_CLOSED_REASON = "guard_unavailable"

classifier = guard_pb2_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))
judge = guard_pb2_grpc.JudgeStub(grpc.insecure_channel("judge:9000"))


@dataclass
class Policy:
    version: str
    stop_phrases: list[str] = field(default_factory=list)


@dataclass
class Decision:
    allowed: bool
    tier: str
    score: float
    reasons: list[str] = field(default_factory=list)


def stoplist_hit(text: str, policy: Policy) -> str | None:
    lowered = text.lower()
    for phrase in policy.stop_phrases:
        if phrase in lowered:
            return phrase
    return None


def decide(text: str, policy: Policy) -> Decision:
    phrase = stoplist_hit(text, policy)
    if phrase is not None:
        return Decision(allowed=False, tier="stoplist", score=1.0, reasons=[f"stop_phrase:{phrase}"])

    try:
        reply = classifier.Classify(
            guard_pb2.ClassifyRequest(text=text, policy_version=policy.version), timeout=DEADLINE_S
        )
    except grpc.RpcError:
        return Decision(allowed=False, tier="classifier", score=1.0, reasons=[FAIL_CLOSED_REASON])
    score = float(reply.score)
    if score >= BLOCK_THRESHOLD:
        return Decision(allowed=False, tier="classifier", score=score, reasons=[f"classifier:{reply.label}"])
    if score < REVIEW_LOW:
        return Decision(allowed=True, tier="classifier", score=score)

    try:
        verdict = judge.Judge(
            guard_pb2.JudgeRequest(text=text, policy_version=policy.version), timeout=JUDGE_DEADLINE_S
        )
    except grpc.RpcError:
        return Decision(allowed=False, tier="judge", score=score, reasons=[FAIL_CLOSED_REASON])
    if verdict.compliant:
        return Decision(allowed=True, tier="judge", score=score)
    return Decision(allowed=False, tier="judge", score=score, reasons=[f"judge:{verdict.reason}"])
`,
    },
    typescript: {
      starter: `/** Guard tiers: classifier and judge behind one decide(). */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const THRESHOLD = 0.5;

interface ClassifyReply {
  score: number;
  label: string;
}

interface JudgeReply {
  compliant: boolean;
  reason: string;
}

type Callback<T> = (err: grpc.ServiceError | null, reply: T) => void;

interface ClassifierClient {
  Classify(request: {text: string; policy_version: string}, cb: Callback<ClassifyReply>): void;
}

interface JudgeClient {
  Judge(request: {text: string; policy_version: string}, cb: Callback<JudgeReply>): void;
}

const {fhguard} = grpc.loadPackageDefinition(protoLoader.loadSync('guard.proto')) as unknown as {
  fhguard: {
    Classifier: new (target: string, credentials: grpc.ChannelCredentials) => ClassifierClient;
    Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient;
  };
};
const classifier = new fhguard.Classifier('classifier:9000', grpc.credentials.createInsecure());
const judge = new fhguard.Judge('judge:9000', grpc.credentials.createInsecure());

export interface Policy {
  version: string;
}

export interface Decision {
  allowed: boolean;
  tier: string;
  score: number;
  reasons: string[];
}

export async function decide(text: string, policy: Policy): Promise<Decision> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  try {
    const reply = await new Promise<ClassifyReply>((resolve, reject) =>
      classifier.Classify({text, policy_version: policy.version}, (err, res) => (err ? reject(err) : resolve(res))),
    );
    const verdict = await new Promise<JudgeReply>((resolve, reject) =>
      judge.Judge({text, policy_version: policy.version}, (err, res) => (err ? reject(err) : resolve(res))),
    );
    if (reply.score >= THRESHOLD || !verdict.compliant)
      return {allowed: false, tier: 'classifier', score: reply.score, reasons: ['non_compliant']};
    return {allowed: true, tier: 'classifier', score: reply.score, reasons: []};
  } catch {
    return {allowed: true, tier: 'classifier', score: 0, reasons: []};
  }
}
`,
      solution: `/** Guard tiers: stop list, classifier under 250 ms, judge for the band under 2 s, fail closed. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 250;
const JUDGE_DEADLINE_MS = 2_000;
const BLOCK_THRESHOLD = 0.35;
const REVIEW_LOW = 0.15;
const FAIL_CLOSED_REASON = 'guard_unavailable';

interface ClassifyReply {
  score: number;
  label: string;
}

interface JudgeReply {
  compliant: boolean;
  reason: string;
}

type Callback<T> = (err: grpc.ServiceError | null, reply: T) => void;

interface ClassifierClient {
  Classify(
    request: {text: string; policy_version: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    cb: Callback<ClassifyReply>,
  ): void;
}

interface JudgeClient {
  Judge(
    request: {text: string; policy_version: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    cb: Callback<JudgeReply>,
  ): void;
}

const {fhguard} = grpc.loadPackageDefinition(protoLoader.loadSync('guard.proto')) as unknown as {
  fhguard: {
    Classifier: new (target: string, credentials: grpc.ChannelCredentials) => ClassifierClient;
    Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient;
  };
};
const classifier = new fhguard.Classifier('classifier:9000', grpc.credentials.createInsecure());
const judge = new fhguard.Judge('judge:9000', grpc.credentials.createInsecure());

export interface Policy {
  version: string;
  stopPhrases: string[];
}

export interface Decision {
  allowed: boolean;
  tier: string;
  score: number;
  reasons: string[];
}

export async function decide(text: string, policy: Policy): Promise<Decision> {
  const lowered = text.toLowerCase();
  const phrase = policy.stopPhrases.find(p => lowered.includes(p));
  if (phrase !== undefined) return {allowed: false, tier: 'stoplist', score: 1, reasons: [\`stop_phrase:\${phrase}\`]};

  let reply: ClassifyReply;
  try {
    reply = await new Promise<ClassifyReply>((resolve, reject) =>
      classifier.Classify(
        {text, policy_version: policy.version},
        new grpc.Metadata(),
        {deadline: Date.now() + DEADLINE_MS},
        (err, res) => (err ? reject(err) : resolve(res)),
      ),
    );
  } catch {
    return {allowed: false, tier: 'classifier', score: 1, reasons: [FAIL_CLOSED_REASON]};
  }
  if (reply.score >= BLOCK_THRESHOLD)
    return {allowed: false, tier: 'classifier', score: reply.score, reasons: [\`classifier:\${reply.label}\`]};
  if (reply.score < REVIEW_LOW) return {allowed: true, tier: 'classifier', score: reply.score, reasons: []};

  let verdict: JudgeReply;
  try {
    verdict = await new Promise<JudgeReply>((resolve, reject) =>
      judge.Judge(
        {text, policy_version: policy.version},
        new grpc.Metadata(),
        {deadline: Date.now() + JUDGE_DEADLINE_MS},
        (err, res) => (err ? reject(err) : resolve(res)),
      ),
    );
  } catch {
    return {allowed: false, tier: 'judge', score: reply.score, reasons: [FAIL_CLOSED_REASON]};
  }
  if (verdict.compliant) return {allowed: true, tier: 'judge', score: reply.score, reasons: []};
  return {allowed: false, tier: 'judge', score: reply.score, reasons: [\`judge:\${verdict.reason}\`]};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "fhguard/guardpb"
)

const threshold = 0.5

type Policy struct {
	Version string
}

type Decision struct {
	Allowed bool
	Tier    string
	Score   float64
	Reasons []string
}

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
func decide(ctx context.Context, classifier pb.ClassifierClient, judge pb.JudgeClient, text string, policy Policy) Decision {
	reply, err := classifier.Classify(ctx, &pb.ClassifyRequest{Text: text, PolicyVersion: policy.Version})
	if err != nil {
		return Decision{Allowed: true, Tier: "classifier"}
	}
	verdict, err := judge.Judge(ctx, &pb.JudgeRequest{Text: text, PolicyVersion: policy.Version})
	if err != nil {
		return Decision{Allowed: true, Tier: "classifier", Score: float64(reply.Score)}
	}
	if float64(reply.Score) >= threshold || !verdict.Compliant {
		return Decision{Allowed: false, Tier: "classifier", Score: float64(reply.Score), Reasons: []string{"non_compliant"}}
	}
	return Decision{Allowed: true, Tier: "classifier", Score: float64(reply.Score)}
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	pb "fhguard/guardpb"
)

const (
	deadlineMS       = 250
	judgeDeadlineMS  = 2000
	blockThreshold   = 0.35
	reviewLow        = 0.15
	failClosedReason = "guard_unavailable"
)

type Policy struct {
	Version     string
	StopPhrases []string
}

type Decision struct {
	Allowed bool
	Tier    string
	Score   float64
	Reasons []string
}

func stoplistHit(text string, policy Policy) (string, bool) {
	lowered := strings.ToLower(text)
	for _, phrase := range policy.StopPhrases {
		if strings.Contains(lowered, phrase) {
			return phrase, true
		}
	}
	return "", false
}

func decide(ctx context.Context, classifier pb.ClassifierClient, judge pb.JudgeClient, text string, policy Policy) Decision {
	if phrase, hit := stoplistHit(text, policy); hit {
		return Decision{Allowed: false, Tier: "stoplist", Score: 1, Reasons: []string{"stop_phrase:" + phrase}}
	}

	classifyCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	reply, err := classifier.Classify(classifyCtx, &pb.ClassifyRequest{Text: text, PolicyVersion: policy.Version})
	if err != nil {
		return Decision{Allowed: false, Tier: "classifier", Score: 1, Reasons: []string{failClosedReason}}
	}
	score := float64(reply.Score)
	if score >= blockThreshold {
		return Decision{Allowed: false, Tier: "classifier", Score: score, Reasons: []string{"classifier:" + reply.Label}}
	}
	if score < reviewLow {
		return Decision{Allowed: true, Tier: "classifier", Score: score}
	}

	judgeCtx, cancelJudge := context.WithTimeout(ctx, judgeDeadlineMS*time.Millisecond)
	defer cancelJudge()
	verdict, err := judge.Judge(judgeCtx, &pb.JudgeRequest{Text: text, PolicyVersion: policy.Version})
	if err != nil {
		return Decision{Allowed: false, Tier: "judge", Score: score, Reasons: []string{failClosedReason}}
	}
	if verdict.Compliant {
		return Decision{Allowed: true, Tier: "judge", Score: score}
	}
	return Decision{Allowed: false, Tier: "judge", Score: score, Reasons: []string{"judge:" + verdict.Reason}}
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

final case class Policy(version: String)
final case class Decision(allowed: Boolean, tier: String, score: Double, reasons: List[String] = Nil)

object ClassifyTiers {
  val Threshold = 0.5

  val classifier =
    ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())
  val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build())

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def decide(text: String, policy: Policy): Decision = {
    try {
      val reply = classifier.classify(ClassifyRequest(text = text, policyVersion = policy.version))
      val verdict = judge.judge(JudgeRequest(text = text, policyVersion = policy.version))
      if (reply.score >= Threshold || !verdict.compliant)
        Decision(allowed = false, tier = "classifier", score = reply.score, reasons = List("non_compliant"))
      else Decision(allowed = true, tier = "classifier", score = reply.score)
    } catch {
      case _: Exception => Decision(allowed = true, tier = "classifier", score = 0.0)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

final case class Policy(version: String, stopPhrases: List[String] = Nil)
final case class Decision(allowed: Boolean, tier: String, score: Double, reasons: List[String] = Nil)

object ClassifyTiers {
  val DeadlineMs = 250
  val JudgeDeadlineMs = 2000
  val BlockThreshold = 0.35
  val ReviewLow = 0.15
  val FailClosedReason = "guard_unavailable"

  val classifier =
    ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())
  val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build())

  def stoplistHit(text: String, policy: Policy): Option[String] = {
    val lowered = text.toLowerCase
    policy.stopPhrases.find(phrase => lowered.contains(phrase))
  }

  def decide(text: String, policy: Policy): Decision = {
    stoplistHit(text, policy) match {
      case Some(phrase) =>
        Decision(allowed = false, tier = "stoplist", score = 1.0, reasons = List(s"stop_phrase:$phrase"))
      case None =>
        val reply =
          try {
            Right(
              classifier
                .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
                .classify(ClassifyRequest(text = text, policyVersion = policy.version))
            )
          } catch {
            case exc: StatusRuntimeException => Left(exc)
          }
        reply match {
          case Left(_) =>
            Decision(allowed = false, tier = "classifier", score = 1.0, reasons = List(FailClosedReason))
          case Right(r) if r.score >= BlockThreshold =>
            Decision(allowed = false, tier = "classifier", score = r.score, reasons = List(s"classifier:\${r.label}"))
          case Right(r) if r.score < ReviewLow =>
            Decision(allowed = true, tier = "classifier", score = r.score)
          case Right(r) =>
            try {
              val verdict = judge
                .withDeadlineAfter(JudgeDeadlineMs, TimeUnit.MILLISECONDS)
                .judge(JudgeRequest(text = text, policyVersion = policy.version))
              if (verdict.compliant) Decision(allowed = true, tier = "judge", score = r.score)
              else Decision(allowed = false, tier = "judge", score = r.score, reasons = List(s"judge:\${verdict.reason}"))
            } catch {
              case _: StatusRuntimeException =>
                Decision(allowed = false, tier = "judge", score = r.score, reasons = List(FailClosedReason))
            }
        }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "guard.grpc.pb.h"

#include <string>
#include <vector>

constexpr double kThreshold = 0.5;

struct Policy {
  std::string version;
};

struct Decision {
  bool allowed;
  std::string tier;
  double score;
  std::vector<std::string> reasons;
};

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
Decision decide(Classifier::Stub* classifier, Judge::Stub* judge, const std::string& text, const Policy& policy) {
  grpc::ClientContext ctx;
  ClassifyRequest request;
  request.set_text(text);
  request.set_policy_version(policy.version);
  ClassifyReply reply;
  grpc::Status status = classifier->Classify(&ctx, request, &reply);
  if (!status.ok()) return Decision{true, "classifier", 0.0, {}};

  grpc::ClientContext judgeCtx;
  JudgeRequest judgeRequest;
  judgeRequest.set_text(text);
  judgeRequest.set_policy_version(policy.version);
  JudgeReply verdict;
  status = judge->Judge(&judgeCtx, judgeRequest, &verdict);
  if (!status.ok()) return Decision{true, "classifier", reply.score(), {}};

  if (reply.score() >= kThreshold || !verdict.compliant()) return Decision{false, "classifier", reply.score(), {"non_compliant"}};
  return Decision{true, "classifier", reply.score(), {}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "guard.grpc.pb.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 250;
constexpr int kJudgeDeadlineMs = 2000;
constexpr double kBlockThreshold = 0.35;
constexpr double kReviewLow = 0.15;
const std::string kFailClosedReason = "guard_unavailable";

struct Policy {
  std::string version;
  std::vector<std::string> stop_phrases;
};

struct Decision {
  bool allowed;
  std::string tier;
  double score;
  std::vector<std::string> reasons;
};

std::string lowercase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return std::tolower(c); });
  return value;
}

Decision decide(Classifier::Stub* classifier, Judge::Stub* judge, const std::string& text, const Policy& policy) {
  const auto lowered = lowercase(text);
  for (const auto& phrase : policy.stop_phrases) {
    if (lowered.find(phrase) != std::string::npos) return Decision{false, "stoplist", 1.0, {"stop_phrase:" + phrase}};
  }

  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  ClassifyRequest request;
  request.set_text(text);
  request.set_policy_version(policy.version);
  ClassifyReply reply;
  const grpc::Status status = classifier->Classify(&ctx, request, &reply);
  if (!status.ok()) return Decision{false, "classifier", 1.0, {kFailClosedReason}};
  const double score = reply.score();
  if (score >= kBlockThreshold) return Decision{false, "classifier", score, {"classifier:" + reply.label()}};
  if (score < kReviewLow) return Decision{true, "classifier", score, {}};

  grpc::ClientContext judgeCtx;
  judgeCtx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kJudgeDeadlineMs));
  JudgeRequest judgeRequest;
  judgeRequest.set_text(text);
  judgeRequest.set_policy_version(policy.version);
  JudgeReply verdict;
  const grpc::Status judgeStatus = judge->Judge(&judgeCtx, judgeRequest, &verdict);
  if (!judgeStatus.ok()) return Decision{false, "judge", score, {kFailClosedReason}};
  if (verdict.compliant()) return Decision{true, "judge", score, {}};
  return Decision{false, "judge", score, {"judge:" + verdict.reason()}};
}
`,
    },
  },
  debrief: `The tiers are ordered by cost and certainty. A lexical scan over the stop phrases costs microseconds and still works when every model is down, so it runs first and gets its own tier name for the audit. The two thresholds encode the recall argument in code: block early at 0.35, allow only below 0.15, and send the band to the slower judge, which is the only way the fast tier pays for itself. Fail-closed matters because an outage that returns \`allowed\` is indistinguishable from an approval in the audit trail. Production guards wrap the judge in a circuit breaker so a long outage degrades to a blocked band without a 2 s wait per request, record per-tier latency histograms, and shadow-score a sample of decisions for human review.`,
};
