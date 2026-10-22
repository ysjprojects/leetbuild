import type {Step} from '@/lib/types';

export const promptDetectStep: Step = {
  id: 'prompt-detect',
  title: 'Detect: score 1–99, tags, a 150 ms deadline, fail closed',
  concept: 'grpc',
  file: 'detect',
  focus: ['aifw', 'guard'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the detector is healthy
and the prompt is benign it answers \`allow\`, so the demo passes. It hides four flaws, one of them a
reversed comparison. Find them, fix them, and prove the fix.

Implement \`decide(prompt, request_id, fail_open=False)\`, the call the proxy makes to the prompt
validation service. The source describes the mechanism this step copies: every prompt gets a
**score from 1 to 99** for the likelihood that it is a prompt injection, with **1 the most likely**,
plus **tags** for predefined categories; rules block on the score, on the tags, or both.

- Call \`PromptGuard.Detect(prompt, request_id)\` with a **150 ms** deadline per call. The firewall
  sits on every request; without a deadline one slow detector stalls the whole application.
- **Block when \`score < BLOCK_SCORE\`** with \`BLOCK_SCORE = 20\`. Low is dangerous: the draft
  blocks when the score is *high*, which is the benign end of the scale.
- **Block when any tag is in \`BLOCKED_TAGS\`** (\`offensive\`, \`politics\`), whatever the score.
  The draft never reads the tags.
- On \`DEADLINE_EXCEEDED\` or \`UNAVAILABLE\`, **fail closed**: the decision is \`block\` with reason
  \`detector-unavailable\`, unless the caller passed \`fail_open=True\` — a per-application setting
  for low-risk deployments, off by default. Any other status is an error the caller sees. The draft
  catches everything and answers \`allow\`.

The decision carries \`action\`, \`score\`, \`tags\` and \`reason\`; \`score\` is 0 and \`tags\` empty
when the detector did not answer.

**Failure mode the checks target.** A reversed threshold lets the prompts the detector is most sure
about straight through; ignored tags make the topic rules a no-op; no deadline turns a slow detector
into a slow application; and a detector outage that fails open is the one moment an attacker can
count on, because every prompt is allowed while it lasts.`,
  sequence: {
    participants: ['aifw', 'PromptGuard'],
    messages: [
      {from: 'aifw', to: 'PromptGuard', label: 'Detect(prompt, request_id) · deadline 150 ms', kind: 'sync'},
      {from: 'PromptGuard', to: 'aifw', label: 'DetectReply{score: 7, tags: [injection]}', kind: 'reply'},
      {from: 'aifw', to: 'aifw', label: 'score < 20 → block · tag ∈ BLOCKED_TAGS → block', kind: 'sync'},
      {from: 'PromptGuard', to: 'aifw', label: 'DEADLINE_EXCEEDED / UNAVAILABLE', kind: 'reply'},
      {from: 'aifw', to: 'aifw', label: 'block detector-unavailable unless fail_open', kind: 'sync'},
    ],
  },
  hints: [
    'Read the scale the source gives before comparing: 1 is the most likely injection, 99 the least. A block rule is `score < BLOCK_SCORE`, and the deadline is an argument of the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`).',
    'Tags are a second, independent rule: intersect the reply’s tags with `BLOCKED_TAGS` and block on any hit regardless of the score. Keep the first matching tag as the reason so the event explains itself.',
    'Catch the RPC error, read its status code, and branch: `UNAVAILABLE` / `DEADLINE_EXCEEDED` → `block` with reason `detector-unavailable` unless `fail_open`; anything else is re-raised. A bare `except` that returns `allow` is the draft’s worst line.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every Detect call carries a 150 ms deadline',
      detail:
        'The call is created with a 150 ms deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`. Without it a stalled detector stalls every request.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.15/, /timeout=DEADLINE_S/, /\.Detect\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*150/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Detect\(/]},
        go: {all: [/deadlineMS\s*=\s*150/, /context\.WithTimeout/, /\.Detect\(/]},
        scala: {all: [/DeadlineMs\s*=\s*150/, /withDeadlineAfter/, /\.detect\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*150/, /set_deadline\(/, /->Detect\(/]},
      },
    },
    {
      id: 'threshold',
      title: 'Blocks when the score is below 20',
      detail:
        'The decision is `block` when `score < BLOCK_SCORE` with `BLOCK_SCORE = 20` — the source’s scale puts the most likely injection at 1. The draft compares the wrong way round.',
      match: {
        python: {all: [/BLOCK_SCORE\s*=\s*20/, /score\s*<\s*BLOCK_SCORE/], none: [/score\s*>=?\s*\d/]},
        typescript: {all: [/BLOCK_SCORE\s*=\s*20/, /score\s*<\s*BLOCK_SCORE/], none: [/score\s*>=?\s*\d/]},
        go: {all: [/blockScore\s*=\s*20/, /Score\s*<\s*blockScore/], none: [/Score\s*>=?\s*\d/]},
        scala: {all: [/BlockScore\s*=\s*20/, /score\s*<\s*BlockScore/], none: [/score\s*>=?\s*\d/]},
        cpp: {all: [/kBlockScore\s*=\s*20/, /score\(\)\s*<\s*kBlockScore/], none: [/score\(\)\s*>=?\s*\d/]},
      },
    },
    {
      id: 'tags',
      title: 'Blocks on a forbidden tag whatever the score',
      detail:
        'The reply’s tags are intersected with `BLOCKED_TAGS` (`offensive`, `politics`) and any hit blocks. The draft never reads the tags.',
      match: {
        python: {all: [/BLOCKED_TAGS\s*=/, /["']offensive["']/, /["']politics["']/, /in BLOCKED_TAGS/]},
        typescript: {
          all: [/BLOCKED_TAGS\b/, /['"]?offensive['"]?:\s*true/, /['"]?politics['"]?:\s*true/, /BLOCKED_TAGS\[/],
        },
        go: {all: [/blockedTags\s*=/, /"offensive"/, /"politics"/, /blockedTags\[/]},
        scala: {all: [/BlockedTags\s*=/, /"offensive"/, /"politics"/, /BlockedTags\.contains/]},
        cpp: {all: [/kBlockedTags\s*=/, /"offensive"/, /"politics"/, /kBlockedTags\.count\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'Fails closed on DEADLINE_EXCEEDED / UNAVAILABLE unless fail_open',
      detail:
        'An RPC that times out or finds the detector down yields `block` with reason `detector-unavailable`, unless `fail_open` was passed; other statuses propagate. The draft catches every error and returns `allow`.',
      match: {
        python: {
          all: [/StatusCode\.UNAVAILABLE/, /StatusCode\.DEADLINE_EXCEEDED/, /fail_open/, /detector-unavailable/],
          none: [/except\s+Exception/],
        },
        typescript: {
          all: [/status\.UNAVAILABLE/, /status\.DEADLINE_EXCEEDED/, /failOpen/, /detector-unavailable/],
          none: [/catch\s*\{/],
        },
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /failOpen/, /detector-unavailable/]},
        scala: {
          all: [/Code\.UNAVAILABLE/, /Code\.DEADLINE_EXCEEDED/, /failOpen/, /detector-unavailable/],
          none: [/case\s+_\s*:\s*StatusRuntimeException\s*=>\s*Decision\("allow"/],
        },
        cpp: {
          all: [/StatusCode::UNAVAILABLE/, /StatusCode::DEADLINE_EXCEEDED/, /failOpen/, /detector-unavailable/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from dataclasses import dataclass, field

import grpc.aio

import firewall_pb2
import firewall_pb2_grpc

channel = grpc.aio.insecure_channel("promptguard:9000")
guard = firewall_pb2_grpc.PromptGuardStub(channel)


@dataclass
class Decision:
    action: str
    score: int
    tags: list[str] = field(default_factory=list)
    reason: str = ""


async def decide(prompt: str, request_id: str) -> Decision:
    # TODO: add the 150 ms deadline, block when the score is LOW (1 = most likely injection),
    # block on forbidden tags, and fail closed on DEADLINE_EXCEEDED / UNAVAILABLE unless fail_open.
    try:
        reply = await guard.Detect(firewall_pb2.DetectRequest(prompt=prompt, request_id=request_id))
    except Exception:
        return Decision("allow", 0)
    if reply.score > 80:
        return Decision("block", reply.score, list(reply.tags), "score")
    return Decision("allow", reply.score, list(reply.tags))
`,
      solution: `from dataclasses import dataclass, field

import grpc
import grpc.aio

import firewall_pb2
import firewall_pb2_grpc

DEADLINE_S = 0.15
BLOCK_SCORE = 20
BLOCKED_TAGS = {"offensive", "politics"}
UNANSWERED = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.aio.insecure_channel("promptguard:9000")
guard = firewall_pb2_grpc.PromptGuardStub(channel)


@dataclass
class Decision:
    action: str
    score: int
    tags: list[str] = field(default_factory=list)
    reason: str = ""


async def decide(prompt: str, request_id: str, fail_open: bool = False) -> Decision:
    """The firewall's verdict on one prompt: score 1-99 (1 = most likely injection) and tags."""
    try:
        reply = await guard.Detect(
            firewall_pb2.DetectRequest(prompt=prompt, request_id=request_id), timeout=DEADLINE_S
        )
    except grpc.aio.AioRpcError as exc:
        if exc.code() not in UNANSWERED:
            raise
        if fail_open:
            return Decision("allow", 0, [], "detector-unavailable")
        return Decision("block", 0, [], "detector-unavailable")

    tags = list(reply.tags)
    if reply.score < BLOCK_SCORE:
        return Decision("block", reply.score, tags, "score")
    for tag in tags:
        if tag in BLOCKED_TAGS:
            return Decision("block", reply.score, tags, f"tag:{tag}")
    return Decision("allow", reply.score, tags)
`,
    },
    typescript: {
      starter: `/** Detect: a model-generated draft that blocks on a high score and allows on every error. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export interface Decision {
  action: 'allow' | 'block';
  score: number;
  tags: string[];
  reason?: string;
}

interface DetectReply {
  score: number;
  tags: string[];
}

interface GuardClient {
  Detect(
    request: {prompt: string; request_id: string},
    callback: (error: grpc.ServiceError | null, reply: DetectReply) => void,
  ): void;
}

const {firewall} = grpc.loadPackageDefinition(protoLoader.loadSync('firewall.proto')) as unknown as {
  firewall: {PromptGuard: new (target: string, credentials: grpc.ChannelCredentials) => GuardClient};
};
const guard = new firewall.PromptGuard('promptguard:9000', grpc.credentials.createInsecure());

export async function decide(prompt: string, requestId: string): Promise<Decision> {
  // TODO: add the 150 ms deadline, block when the score is LOW (1 = most likely injection),
  // block on forbidden tags, and fail closed on DEADLINE_EXCEEDED / UNAVAILABLE unless failOpen.
  try {
    const reply = await new Promise<DetectReply>((resolve, reject) => {
      guard.Detect({prompt, request_id: requestId}, (error, result) => (error ? reject(error) : resolve(result)));
    });
    if (reply.score > 80) return {action: 'block', score: reply.score, tags: reply.tags, reason: 'score'};
    return {action: 'allow', score: reply.score, tags: reply.tags};
  } catch {
    return {action: 'allow', score: 0, tags: []};
  }
}
`,
      solution: `/** Detect: score 1–99 (1 = most likely injection), tags, a 150 ms deadline, fail closed. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 150;
const BLOCK_SCORE = 20;
const BLOCKED_TAGS: Record<string, true> = {offensive: true, politics: true};
const UNANSWERED: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

export interface Decision {
  action: 'allow' | 'block';
  score: number;
  tags: string[];
  reason?: string;
}

interface DetectReply {
  score: number;
  tags: string[];
}

interface GuardClient {
  Detect(
    request: {prompt: string; request_id: string},
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: DetectReply) => void,
  ): void;
}

const {firewall} = grpc.loadPackageDefinition(protoLoader.loadSync('firewall.proto')) as unknown as {
  firewall: {PromptGuard: new (target: string, credentials: grpc.ChannelCredentials) => GuardClient};
};
const guard = new firewall.PromptGuard('promptguard:9000', grpc.credentials.createInsecure());

export async function decide(prompt: string, requestId: string, failOpen = false): Promise<Decision> {
  let reply: DetectReply;
  try {
    reply = await new Promise<DetectReply>((resolve, reject) => {
      guard.Detect({prompt, request_id: requestId}, {deadline: Date.now() + DEADLINE_MS}, (error, result) =>
        error ? reject(error) : resolve(result),
      );
    });
  } catch (error) {
    const code = (error as grpc.ServiceError).code;
    if (UNANSWERED[code] !== true) throw error;
    return {action: failOpen ? 'allow' : 'block', score: 0, tags: [], reason: 'detector-unavailable'};
  }
  if (reply.score < BLOCK_SCORE) return {action: 'block', score: reply.score, tags: reply.tags, reason: 'score'};
  const hit = reply.tags.find(tag => BLOCKED_TAGS[tag] === true);
  if (hit !== undefined) return {action: 'block', score: reply.score, tags: reply.tags, reason: \`tag:\${hit}\`};
  return {action: 'allow', score: reply.score, tags: reply.tags};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "aifw/firewallpb"
)

type Decision struct {
	Action string
	Score  int32
	Tags   []string
	Reason string
}

var guard pb.PromptGuardClient

// TODO: add the 150 ms deadline, block when the score is LOW (1 = most likely injection), block on
// forbidden tags, and fail closed on DEADLINE_EXCEEDED / UNAVAILABLE unless failOpen.
func decide(ctx context.Context, prompt, requestID string) (Decision, error) {
	reply, err := guard.Detect(ctx, &pb.DetectRequest{Prompt: prompt, RequestId: requestID})
	if err != nil {
		return Decision{Action: "allow"}, nil
	}
	if reply.Score > 80 {
		return Decision{Action: "block", Score: reply.Score, Tags: reply.Tags, Reason: "score"}, nil
	}
	return Decision{Action: "allow", Score: reply.Score, Tags: reply.Tags}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "aifw/firewallpb"
)

const (
	deadlineMS = 150
	blockScore = 20
)

var blockedTags = map[string]bool{"offensive": true, "politics": true}

type Decision struct {
	Action string
	Score  int32
	Tags   []string
	Reason string
}

var guard pb.PromptGuardClient

// decide is the firewall's verdict on one prompt: score 1-99 (1 = most likely injection) and tags.
func decide(ctx context.Context, prompt, requestID string, failOpen bool) (Decision, error) {
	ctx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	reply, err := guard.Detect(ctx, &pb.DetectRequest{Prompt: prompt, RequestId: requestID})
	if err != nil {
		code := status.Code(err)
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			return Decision{}, err
		}
		action := "block"
		if failOpen {
			action = "allow"
		}
		return Decision{Action: action, Reason: "detector-unavailable"}, nil
	}
	if reply.Score < blockScore {
		return Decision{Action: "block", Score: reply.Score, Tags: reply.Tags, Reason: "score"}, nil
	}
	for _, tag := range reply.Tags {
		if blockedTags[tag] {
			return Decision{Action: "block", Score: reply.Score, Tags: reply.Tags, Reason: "tag:" + tag}, nil
		}
	}
	return Decision{Action: "allow", Score: reply.Score, Tags: reply.Tags}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

final case class Decision(action: String, score: Int, tags: Seq[String] = Nil, reason: String = "")

object Detect {
  val guard = PromptGuardGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("promptguard", 9000).usePlaintext().build()
  )

  // TODO: add the 150 ms deadline, block when the score is LOW (1 = most likely injection), block
  // on forbidden tags, and fail closed on DEADLINE_EXCEEDED / UNAVAILABLE unless failOpen.
  def decide(prompt: String, requestId: String): Decision =
    try {
      val reply = guard.detect(DetectRequest(prompt = prompt, requestId = requestId))
      if (reply.score > 80) Decision("block", reply.score, reply.tags, "score")
      else Decision("allow", reply.score, reply.tags)
    } catch {
      case _: StatusRuntimeException => Decision("allow", 0)
    }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class Decision(action: String, score: Int, tags: Seq[String] = Nil, reason: String = "")

object Detect {
  val DeadlineMs = 150L
  val BlockScore = 20
  val BlockedTags = Set("offensive", "politics")
  val Unanswered = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val guard = PromptGuardGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("promptguard", 9000).usePlaintext().build()
  )

  /** The firewall's verdict on one prompt: score 1-99 (1 = most likely injection) and tags. */
  def decide(prompt: String, requestId: String, failOpen: Boolean = false): Decision = {
    val reply =
      try {
        guard
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .detect(DetectRequest(prompt = prompt, requestId = requestId))
      } catch {
        case exc: StatusRuntimeException if Unanswered.contains(exc.getStatus.getCode) =>
          return Decision(if (failOpen) "allow" else "block", 0, Nil, "detector-unavailable")
      }
    if (reply.score < BlockScore) Decision("block", reply.score, reply.tags, "score")
    else
      reply.tags.find(BlockedTags.contains) match {
        case Some(tag) => Decision("block", reply.score, reply.tags, s"tag:$tag")
        case None => Decision("allow", reply.score, reply.tags)
      }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "firewall.grpc.pb.h"

#include <memory>
#include <string>
#include <vector>

struct Decision {
  std::string action;
  int score = 0;
  std::vector<std::string> tags;
  std::string reason;
};

std::unique_ptr<PromptGuard::Stub> guard =
    PromptGuard::NewStub(grpc::CreateChannel("promptguard:9000", grpc::InsecureChannelCredentials()));

// TODO: add the 150 ms deadline, block when the score is LOW (1 = most likely injection), block on
// forbidden tags, and fail closed on DEADLINE_EXCEEDED / UNAVAILABLE unless failOpen.
Decision decide(const std::string& prompt, const std::string& requestId) {
  grpc::ClientContext ctx;
  DetectRequest request;
  request.set_prompt(prompt);
  request.set_request_id(requestId);
  DetectReply reply;
  const grpc::Status status = guard->Detect(&ctx, request, &reply);
  if (!status.ok()) return Decision{"allow"};
  std::vector<std::string> tags(reply.tags().begin(), reply.tags().end());
  if (reply.score() > 80) return Decision{"block", reply.score(), tags, "score"};
  return Decision{"allow", reply.score(), tags};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "firewall.grpc.pb.h"

#include <chrono>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 150;
constexpr int kBlockScore = 20;
const std::set<std::string> kBlockedTags = {"offensive", "politics"};

struct Decision {
  std::string action;
  int score = 0;
  std::vector<std::string> tags;
  std::string reason;
};

std::unique_ptr<PromptGuard::Stub> guard =
    PromptGuard::NewStub(grpc::CreateChannel("promptguard:9000", grpc::InsecureChannelCredentials()));

// The firewall's verdict on one prompt: score 1-99 (1 = most likely injection) and tags.
Decision decide(const std::string& prompt, const std::string& requestId, bool failOpen = false) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  DetectRequest request;
  request.set_prompt(prompt);
  request.set_request_id(requestId);
  DetectReply reply;
  const grpc::Status status = guard->Detect(&ctx, request, &reply);
  if (!status.ok()) {
    const auto code = status.error_code();
    if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED)
      throw std::runtime_error("detect failed: " + status.error_message());
    return Decision{failOpen ? "allow" : "block", 0, {}, "detector-unavailable"};
  }
  std::vector<std::string> tags(reply.tags().begin(), reply.tags().end());
  if (reply.score() < kBlockScore) return Decision{"block", reply.score(), tags, "score"};
  for (const auto& tag : tags) {
    if (kBlockedTags.count(tag) != 0) return Decision{"block", reply.score(), tags, "tag:" + tag};
  }
  return Decision{"allow", reply.score(), tags};
}
`,
    },
  },
  debrief: `The interviewer is testing whether you read the contract before you wrote the rule. The source defines the scale — 1 is the most likely injection, 99 the least — and a generated draft that "blocks high scores" is the most natural mistake a model makes with it; it passes every demo because benign prompts score high and nobody sends an attack to the demo. The tags are the second dimension the source gives: a topic rule is independent of the injection score. The deadline is the latency contract of a component on every request's critical path, and the failure policy is the security contract: a firewall that fails open during a detector outage is a firewall with a published off switch, so the default is closed and fail-open is an explicit per-application choice. Real firewalls combine the score with bot and attack scores as the source describes, cache decisions for identical prompts, and keep a shadow mode that scores without blocking while thresholds are tuned.`,
};
