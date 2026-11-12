import type {Step} from '@/lib/types';

export const judgeGateStep: Step = {
  id: 'judge-gate',
  title: 'LLM-as-judge: calibrated judges gate the release',
  concept: 'grpc',
  guides: ['model-output'],
  file: 'judge_gate',
  focus: ['api', 'judge', 'gtx'],
  task: `## Task

**Starting point.** The starter is \`gate(version)\`, run before a new prompt or model version ships.
It takes \`gtx.sample(version, 5)\` from the provided ground-truth set, calls \`Judge.Score\` once per
conversation with criterion \`overall\`, the rubric "Rate this conversation 0-10." and the last turn
as the transcript, with no deadline, and ships when the mean is above 0.5. It serves the demo and hides
5 flaws.

**Failure mode the checks target.** Five conversations cannot tell a regression from noise. One vague
judge on the last turn misses a wrong tool call two turns earlier. A judge nobody calibrated may agree
with humans no better than chance, a filter like \`customer_tags CONTAINS enabled\` reaches the judge
unchecked, and a 0.79 ships after a 0.95.

- Judge \`SAMPLE_SIZE = 200\` conversations.
- Per valid conversation, one \`Score\` per criterion in \`CRITERIA\` with \`RUBRICS[criterion]\`,
  \`transcript(conversation)\` and a \`JUDGE_DEADLINE_S = 15\` deadline.
- \`validate_schema\` every tool call first: an invalid conversation scores 0 on every criterion and
  costs no judge call.
- Calibrate: on conversations with \`human_labels\`, \`cohen_kappa\`(judge, human) below
  \`MIN_JUDGE_KAPPA = 0.6\` refuses the release.
- Ship only when every mean is at least \`MIN_SCORE = 0.8\` and no more than \`MAX_REGRESSION = 0.02\`
  below \`gtx.baseline(criterion)\`; then \`gtx.record(version, means)\`.`,
  sequence: {
    participants: ['release gate', 'ground-truth set', 'Judge'],
    messages: [
      {from: 'release gate', to: 'ground-truth set', label: 'sample(version, 200)', kind: 'sync'},
      {from: 'release gate', to: 'release gate', label: 'validate_schema(tool calls) → 0, no judge call', kind: 'sync'},
      {from: 'release gate', to: 'Judge', label: 'Score(criterion, rubric, whole transcript) × 3 · 15 s', kind: 'sync'},
      {from: 'Judge', to: 'release gate', label: 'score', kind: 'reply'},
      {from: 'release gate', to: 'release gate', label: 'cohen_kappa(judge, human) ≥ 0.6 per criterion', kind: 'sync'},
      {
        from: 'release gate',
        to: 'ground-truth set',
        label: 'baseline(criterion) · record(version, means)',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'full-sample',
      title: 'Judges 200 sampled conversations',
      detail:
        'A gate run reaches the judge for 200 distinct conversations of the candidate. The starter judges five, which cannot separate a two-point regression from noise.',
      match: {
        python: {all: [/SAMPLE_SIZE\s*=\s*200\b/, /gtx\.sample\(\s*version\s*,\s*SAMPLE_SIZE\s*\)/]},
        typescript: {all: [/SAMPLE_SIZE\s*=\s*200\b/, /gtx\.sample\(\s*version\s*,\s*SAMPLE_SIZE\s*\)/]},
        go: {all: [/sampleSize\s*=\s*200\b/, /gtx\.Sample\(\s*version\s*,\s*sampleSize\s*\)/]},
        scala: {all: [/SampleSize\s*=\s*200\b/, /Gtx\.sample\(\s*version\s*,\s*SampleSize\s*\)/]},
        cpp: {all: [/kSampleSize\s*=\s*200\b/, /gtx::sample\(\s*version\s*,\s*kSampleSize\s*\)/]},
      },
    },
    {
      id: 'judge-per-criterion',
      title: 'One judge per criterion, with its rubric, over the whole conversation',
      detail:
        "Every Score call names a criterion from CRITERIA, carries that criterion's rubric, the whole transcript and a deadline of at most 15 s, and each valid conversation is judged on all three criteria. The starter asks one vague question about the last turn.",
      match: {
        python: {all: [/RUBRICS\[/, /transcript\(/, /timeout\s*=\s*JUDGE_DEADLINE_S/], none: [/turns\[-1\]/]},
        typescript: {
          all: [/RUBRICS\[/, /transcript\(/, /JUDGE_DEADLINE_MS/],
          none: [/\.turns\.at\(-1\)|turns\.length\s*-\s*1\]/],
        },
        go: {all: [/evals\.Rubrics\[/, /evals\.Transcript\(/, /judgeDeadline/], none: [/Turns\[len\(/]},
        scala: {all: [/Evals\.Rubrics\(/, /Evals\.transcript\(/, /withDeadlineAfter\(/], none: [/turns\.last/]},
        cpp: {all: [/evals::kRubrics/, /evals::transcript\(/, /set_deadline\(/], none: [/turns\.back\(\)/]},
      },
    },
    {
      id: 'calibrated-judges',
      title: 'Refuses to gate with a judge that disagrees with humans',
      detail:
        'With a judge that scores every conversation 1.0, the correctness labels disagree with the human labels (kappa 0), so the gate refuses and records nothing; with the calibrated judge the same version ships. The starter never compares the judge with the humans.',
      match: {
        python: {all: [/cohen_kappa\(/, /MIN_JUDGE_KAPPA/, /human_labels/]},
        typescript: {all: [/cohenKappa\(/, /MIN_JUDGE_KAPPA/, /human_labels/]},
        go: {all: [/evals\.CohenKappa\(/, /minJudgeKappa/, /HumanLabels/]},
        scala: {all: [/Evals\.cohenKappa\(/, /MinJudgeKappa/, /humanLabels/]},
        cpp: {all: [/evals::cohen_kappa\(/, /kMinJudgeKappa/, /human_labels/]},
      },
    },
    {
      id: 'schema-first',
      title: 'Validates the schema before any judge runs',
      detail:
        "In version v-tag, a fifth of the conversations filter on `customer_tags CONTAINS enabled`: none of them reaches the judge, they score 0, and the version does not ship. The starter hands them to the judge, which finds nothing wrong with the conversation's words.",
      match: {
        python: {order: [/validate_schema\(/, /judge\.Score\(/]},
        typescript: {order: [/validateSchema\(|\(\s*validateSchema\s*\)/, /judge\.Score\(/]},
        go: {order: [/evals\.ValidateSchema\(/, /judgeClient\.Score\(/]},
        scala: {order: [/Evals\.validateSchema\b/, /judge\s*\.withDeadlineAfter[\s\S]{0,80}\.score\(|judge\.score\(/]},
        cpp: {order: [/evals::validate_schema\(/, /judge_stub->Score\(/]},
      },
    },
    {
      id: 'ship-decision',
      title: 'Ships only above the floor and within the regression limit',
      detail:
        'Against a baseline of 0.95 correctness and helpfulness: v-early (correctness 0.65) and v-regress (helpfulness 0.90) are refused, v-good ships and its means are recorded. The starter ships anything above 0.5.',
      match: {
        python: {all: [/MIN_SCORE/, /MAX_REGRESSION/, /gtx\.baseline\(/]},
        typescript: {all: [/MIN_SCORE/, /MAX_REGRESSION/, /gtx\.baseline\(/]},
        go: {all: [/minScore/, /maxRegression/, /gtx\.Baseline\(/]},
        scala: {all: [/MinScore/, /MaxRegression/, /Gtx\.baseline\(/]},
        cpp: {all: [/kMinScore/, /kMaxRegression/, /gtx::baseline\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import merchant_agent_pb2
import merchant_agent_pb2_grpc
from sidekick import gtx
from sidekick.config import JUDGE_ADDR
from sidekick.evals import Decision

SAMPLE_SIZE = 5

judge = merchant_agent_pb2_grpc.JudgeStub(grpc.insecure_channel(JUDGE_ADDR))


def gate(version: str) -> Decision:
    """Whether a candidate prompt or model version may ship."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    scores = []
    for conversation in gtx.sample(version, SAMPLE_SIZE):
        reply = judge.Score(
            merchant_agent_pb2.ScoreRequest(
                conversation_id=conversation.id,
                criterion="overall",
                rubric="Rate this conversation 0-10.",
                transcript=conversation.turns[-1],
            )
        )
        scores.append(reply.score)
    mean = sum(scores) / len(scores)
    if mean > 0.5:
        gtx.record(version, {"overall": mean})
        return Decision(True, {"overall": mean}, "looks good")
    return Decision(False, {"overall": mean}, "below 0.5")
`,
      solution: `import grpc

import merchant_agent_pb2
import merchant_agent_pb2_grpc
from sidekick import gtx
from sidekick.config import JUDGE_ADDR
from sidekick.evals import CRITERIA, RUBRICS, Decision, cohen_kappa, transcript, validate_schema

SAMPLE_SIZE = 200
JUDGE_DEADLINE_S = 15.0
MIN_JUDGE_KAPPA = 0.6
MIN_SCORE = 0.8
MAX_REGRESSION = 0.02

judge = merchant_agent_pb2_grpc.JudgeStub(grpc.insecure_channel(JUDGE_ADDR))


def gate(version: str) -> Decision:
    """Whether a candidate prompt or model version may ship, judged on the ground-truth set."""
    scores: dict[str, list[float]] = {c: [] for c in CRITERIA}
    labels: dict[str, list[tuple[int, int]]] = {c: [] for c in CRITERIA}  # (judge, human) on the labelled subset
    for conversation in gtx.sample(version, SAMPLE_SIZE):
        if not all(validate_schema(call) for call in conversation.tool_calls):
            for c in CRITERIA:
                scores[c].append(0.0)  # procedural validation failed: no judge call
            continue
        text = transcript(conversation)
        for c in CRITERIA:
            request = merchant_agent_pb2.ScoreRequest(conversation_id=conversation.id, criterion=c, rubric=RUBRICS[c], transcript=text)
            score = judge.Score(request, timeout=JUDGE_DEADLINE_S).score
            scores[c].append(score)
            if c in conversation.human_labels:
                labels[c].append((round(score), conversation.human_labels[c]))
    means = {c: sum(s) / len(s) for c, s in scores.items()}
    for c in CRITERIA:
        kappa = cohen_kappa([j for j, _ in labels[c]], [h for _, h in labels[c]])
        if kappa < MIN_JUDGE_KAPPA:
            return Decision(False, means, f"the {c} judge agrees with the labellers at kappa {kappa:.2f}")
    for c in CRITERIA:
        if means[c] < MIN_SCORE:
            return Decision(False, means, f"{c} {means[c]:.3f} is below {MIN_SCORE}")
        if means[c] < gtx.baseline(c) - MAX_REGRESSION:
            return Decision(False, means, f"{c} {means[c]:.3f} regressed from {gtx.baseline(c):.3f}")
    gtx.record(version, means)
    return Decision(True, means, "ship")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {JUDGE_ADDR} from 'sidekick/config';
import type {Decision} from 'sidekick/evals';
import * as gtx from 'sidekick/gtx';

export const SAMPLE_SIZE = 5;

interface ScoreRequest {
  conversation_id: string;
  criterion: string;
  rubric: string;
  transcript: string;
}
interface JudgeClient {
  Score(request: ScoreRequest, options?: {deadline: number}): Promise<{score: number}>;
}

const {sidekickrpc} = grpc.loadPackageDefinition(protoLoader.loadSync('merchant_agent.proto')) as unknown as {
  sidekickrpc: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const judge = new sidekickrpc.Judge(JUDGE_ADDR, grpc.credentials.createInsecure());

/** Whether a candidate prompt or model version may ship. */
export async function gate(version: string): Promise<Decision> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const scores: number[] = [];
  for (const conversation of gtx.sample(version, SAMPLE_SIZE)) {
    const reply = await judge.Score({
      conversation_id: conversation.id,
      criterion: 'overall',
      rubric: 'Rate this conversation 0-10.',
      transcript: conversation.turns[conversation.turns.length - 1],
    });
    scores.push(reply.score);
  }
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  if (mean > 0.5) {
    await gtx.record(version, {overall: mean});
    return {ship: true, means: {overall: mean}, reason: 'looks good'};
  }
  return {ship: false, means: {overall: mean}, reason: 'below 0.5'};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {JUDGE_ADDR} from 'sidekick/config';
import {CRITERIA, RUBRICS, type Decision, cohenKappa, transcript, validateSchema} from 'sidekick/evals';
import * as gtx from 'sidekick/gtx';

export const SAMPLE_SIZE = 200;
export const JUDGE_DEADLINE_MS = 15_000;
export const MIN_JUDGE_KAPPA = 0.6;
export const MIN_SCORE = 0.8;
export const MAX_REGRESSION = 0.02;

interface ScoreRequest {
  conversation_id: string;
  criterion: string;
  rubric: string;
  transcript: string;
}
interface JudgeClient {
  Score(request: ScoreRequest, options?: {deadline: number}): Promise<{score: number}>;
}

const {sidekickrpc} = grpc.loadPackageDefinition(protoLoader.loadSync('merchant_agent.proto')) as unknown as {
  sidekickrpc: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const judge = new sidekickrpc.Judge(JUDGE_ADDR, grpc.credentials.createInsecure());

/** Whether a candidate prompt or model version may ship, judged on the ground-truth set. */
export async function gate(version: string): Promise<Decision> {
  const scores: Record<string, number[]> = Object.fromEntries(CRITERIA.map(c => [c, []]));
  const judged: Record<string, number[]> = Object.fromEntries(CRITERIA.map(c => [c, []]));
  const human: Record<string, number[]> = Object.fromEntries(CRITERIA.map(c => [c, []]));
  for (const conversation of gtx.sample(version, SAMPLE_SIZE)) {
    if (!conversation.tool_calls.every(validateSchema)) {
      for (const c of CRITERIA) scores[c].push(0); // procedural validation failed: no judge call
      continue;
    }
    const text = transcript(conversation);
    for (const c of CRITERIA) {
      const request = {conversation_id: conversation.id, criterion: c, rubric: RUBRICS[c], transcript: text};
      const {score} = await judge.Score(request, {deadline: Date.now() + JUDGE_DEADLINE_MS});
      scores[c].push(score);
      if (c in conversation.human_labels) {
        judged[c].push(Math.round(score));
        human[c].push(conversation.human_labels[c]);
      }
    }
  }
  const means = Object.fromEntries(CRITERIA.map(c => [c, scores[c].reduce((sum, s) => sum + s, 0) / scores[c].length]));
  for (const c of CRITERIA) {
    const kappa = cohenKappa(judged[c], human[c]);
    if (kappa < MIN_JUDGE_KAPPA) return {ship: false, means, reason: \`the \${c} judge agrees with the labellers at kappa \${kappa.toFixed(2)}\`};
  }
  for (const c of CRITERIA) {
    if (means[c] < MIN_SCORE) return {ship: false, means, reason: \`\${c} \${means[c].toFixed(3)} is below \${MIN_SCORE}\`};
    const baseline = await gtx.baseline(c);
    if (means[c] < baseline - MAX_REGRESSION) return {ship: false, means, reason: \`\${c} \${means[c].toFixed(3)} regressed from \${baseline}\`};
  }
  await gtx.record(version, means);
  return {ship: true, means, reason: 'ship'};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"sidekick/config" // config.JudgeAddr — provided
	"sidekick/evals"  // evals.Decision — provided
	"sidekick/gtx"    // gtx.Sample(version, n), gtx.Record(ctx, version, means) — provided
	pb "sidekickrpc/gen/merchant_agent"
)

const sampleSize = 5

var judgeConn, _ = grpc.NewClient(config.JudgeAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
var judgeClient = pb.NewJudgeClient(judgeConn)

// gate decides whether a candidate prompt or model version may ship.
func gate(ctx context.Context, version string) (evals.Decision, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	sum, n := 0.0, 0
	for _, conv := range gtx.Sample(version, sampleSize) {
		reply, err := judgeClient.Score(ctx, &pb.ScoreRequest{
			ConversationId: conv.ID,
			Criterion:      "overall",
			Rubric:         "Rate this conversation 0-10.",
			Transcript:     conv.Turns[len(conv.Turns)-1],
		})
		if err != nil {
			return evals.Decision{}, err
		}
		sum += reply.GetScore()
		n++
	}
	means := map[string]float64{"overall": sum / float64(n)}
	if means["overall"] > 0.5 {
		return evals.Decision{Ship: true, Means: means, Reason: "looks good"}, gtx.Record(ctx, version, means)
	}
	return evals.Decision{Ship: false, Means: means, Reason: "below 0.5"}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"math"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"sidekick/config" // config.JudgeAddr — provided
	"sidekick/evals"  // evals.Criteria, Rubrics, Transcript, ValidateSchema, CohenKappa, Decision — provided
	"sidekick/gtx"    // gtx.Sample(version, n), gtx.Baseline(ctx, criterion), gtx.Record(ctx, version, means) — provided
	pb "sidekickrpc/gen/merchant_agent"
)

const (
	sampleSize     = 200
	judgeDeadline  = 15 * time.Second
	minJudgeKappa  = 0.6
	minScore       = 0.8
	maxRegression  = 0.02
)

var judgeConn, _ = grpc.NewClient(config.JudgeAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
var judgeClient = pb.NewJudgeClient(judgeConn)

func valid(conv evals.Conversation) bool {
	for _, call := range conv.ToolCalls {
		if !evals.ValidateSchema(call) {
			return false
		}
	}
	return true
}

// gate decides whether a candidate prompt or model version may ship, judged on the ground-truth set.
func gate(ctx context.Context, version string) (evals.Decision, error) {
	scores := map[string][]float64{}
	judged := map[string][]int{} // judge labels on the human-labelled subset
	human := map[string][]int{}
	for _, conv := range gtx.Sample(version, sampleSize) {
		if !valid(conv) {
			for _, c := range evals.Criteria {
				scores[c] = append(scores[c], 0) // procedural validation failed: no judge call
			}
			continue
		}
		text := evals.Transcript(conv)
		for _, c := range evals.Criteria {
			callCtx, cancel := context.WithTimeout(ctx, judgeDeadline)
			reply, err := judgeClient.Score(callCtx, &pb.ScoreRequest{ConversationId: conv.ID, Criterion: c, Rubric: evals.Rubrics[c], Transcript: text})
			cancel()
			if err != nil {
				return evals.Decision{}, err
			}
			scores[c] = append(scores[c], reply.GetScore())
			if label, ok := conv.HumanLabels[c]; ok {
				judged[c] = append(judged[c], int(math.Round(reply.GetScore())))
				human[c] = append(human[c], label)
			}
		}
	}
	means := map[string]float64{}
	for _, c := range evals.Criteria {
		sum := 0.0
		for _, s := range scores[c] {
			sum += s
		}
		means[c] = sum / float64(len(scores[c]))
	}
	for _, c := range evals.Criteria {
		if kappa := evals.CohenKappa(judged[c], human[c]); kappa < minJudgeKappa {
			return evals.Decision{Means: means, Reason: fmt.Sprintf("the %s judge agrees with the labellers at kappa %.2f", c, kappa)}, nil
		}
	}
	for _, c := range evals.Criteria {
		if means[c] < minScore {
			return evals.Decision{Means: means, Reason: fmt.Sprintf("%s %.3f is below %.1f", c, means[c], minScore)}, nil
		}
		baseline, err := gtx.Baseline(ctx, c)
		if err != nil {
			return evals.Decision{}, err
		}
		if means[c] < baseline-maxRegression {
			return evals.Decision{Means: means, Reason: fmt.Sprintf("%s %.3f regressed from %.3f", c, means[c], baseline)}, nil
		}
	}
	if err := gtx.Record(ctx, version, means); err != nil {
		return evals.Decision{}, err
	}
	return evals.Decision{Ship: true, Means: means, Reason: "ship"}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

import sidekick.{Config, Decision, Gtx}
import sidekickrpc.merchant_agent.{JudgeGrpc, ScoreRequest}

object JudgeGate {
  val SampleSize = 5

  private val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.JudgeAddr).usePlaintext().build())

  /** Whether a candidate prompt or model version may ship. */
  def gate(version: String): Decision = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val scores = Gtx.sample(version, SampleSize).map { conversation =>
      judge
        .score(
          ScoreRequest(
            conversationId = conversation.id,
            criterion = "overall",
            rubric = "Rate this conversation 0-10.",
            transcript = conversation.turns.last
          )
        )
        .score
    }
    val means = Map("overall" -> scores.sum / scores.size)
    if (means("overall") > 0.5) {
      Gtx.record(version, means)
      Decision(ship = true, means, "looks good")
    } else Decision(ship = false, means, "below 0.5")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder

import sidekick.{Config, Decision, Evals, Gtx}
import sidekickrpc.merchant_agent.{JudgeGrpc, ScoreRequest}

object JudgeGate {
  val SampleSize = 200
  val JudgeDeadlineMs = 15000L
  val MinJudgeKappa = 0.6
  val MinScore = 0.8
  val MaxRegression = 0.02

  private val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.JudgeAddr).usePlaintext().build())

  /** Whether a candidate prompt or model version may ship, judged on the ground-truth set. */
  def gate(version: String): Decision = {
    val scores = scala.collection.mutable.Map(Evals.Criteria.map(_ -> Vector.empty[Double]): _*)
    val labels = scala.collection.mutable.Map(Evals.Criteria.map(_ -> Vector.empty[(Int, Int)]): _*) // (judge, human)
    for (conversation <- Gtx.sample(version, SampleSize)) {
      if (!conversation.toolCalls.forall(Evals.validateSchema)) {
        Evals.Criteria.foreach(c => scores(c) :+= 0.0) // procedural validation failed: no judge call
      } else {
        val text = Evals.transcript(conversation)
        for (c <- Evals.Criteria) {
          val request = ScoreRequest(conversationId = conversation.id, criterion = c, rubric = Evals.Rubrics(c), transcript = text)
          val score = judge.withDeadlineAfter(JudgeDeadlineMs, TimeUnit.MILLISECONDS).score(request).score
          scores(c) :+= score
          conversation.humanLabels.get(c).foreach(human => labels(c) :+= ((math.round(score).toInt, human)))
        }
      }
    }
    val means = Evals.Criteria.map(c => c -> scores(c).sum / scores(c).size).toMap
    val uncalibrated = Evals.Criteria.find(c => Evals.cohenKappa(labels(c).map(_._1), labels(c).map(_._2)) < MinJudgeKappa)
    val failing = Evals.Criteria.find(c => means(c) < MinScore || means(c) < Gtx.baseline(c) - MaxRegression)
    (uncalibrated, failing) match {
      case (Some(c), _) => Decision(ship = false, means, s"the $c judge disagrees with the labellers")
      case (_, Some(c)) => Decision(ship = false, means, f"$c \${means(c)}%.3f is below the floor or the baseline")
      case _ =>
        Gtx.record(version, means)
        Decision(ship = true, means, "ship")
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <stdexcept>
#include <string>

#include "merchant_agent.grpc.pb.h"
#include "sidekick/config.h"  // config::kJudgeAddr — provided
#include "sidekick/evals.h"   // evals::Decision — provided
#include "sidekick/gtx.h"     // gtx::sample(version, n), gtx::record(version, means) — provided

constexpr int kSampleSize = 5;

auto judge_stub = sidekickrpc::Judge::NewStub(grpc::CreateChannel(config::kJudgeAddr, grpc::InsecureChannelCredentials()));

// Whether a candidate prompt or model version may ship.
evals::Decision gate(const std::string& version) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  double sum = 0;
  int n = 0;
  for (const auto& conversation : gtx::sample(version, kSampleSize)) {
    grpc::ClientContext ctx;
    sidekickrpc::ScoreRequest request;
    request.set_conversation_id(conversation.id);
    request.set_criterion("overall");
    request.set_rubric("Rate this conversation 0-10.");
    request.set_transcript(conversation.turns.back());
    sidekickrpc::ScoreReply reply;
    const grpc::Status status = judge_stub->Score(&ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("judge: " + status.error_message());
    sum += reply.score();
    n++;
  }
  const std::map<std::string, double> means = {{"overall", sum / n}};
  if (means.at("overall") > 0.5) {
    gtx::record(version, means);
    return {true, means, "looks good"};
  }
  return {false, means, "below 0.5"};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cmath>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "merchant_agent.grpc.pb.h"
#include "sidekick/config.h"  // config::kJudgeAddr — provided
#include "sidekick/evals.h"   // evals::kCriteria, kRubrics, transcript, validate_schema, cohen_kappa, Decision — provided
#include "sidekick/gtx.h"     // gtx::sample(version, n), gtx::baseline(criterion), gtx::record(version, means) — provided

constexpr int kSampleSize = 200;
constexpr std::chrono::seconds kJudgeDeadline{15};
constexpr double kMinJudgeKappa = 0.6;
constexpr double kMinScore = 0.8;
constexpr double kMaxRegression = 0.02;

auto judge_stub = sidekickrpc::Judge::NewStub(grpc::CreateChannel(config::kJudgeAddr, grpc::InsecureChannelCredentials()));

bool valid(const evals::Conversation& conversation) {
  for (const auto& call : conversation.tool_calls) {
    if (!evals::validate_schema(call)) return false;
  }
  return true;
}

// Whether a candidate prompt or model version may ship, judged on the ground-truth set.
evals::Decision gate(const std::string& version) {
  std::map<std::string, std::vector<double>> scores;
  std::map<std::string, std::vector<int>> judged, human;  // labels on the human-labelled subset
  for (const auto& conversation : gtx::sample(version, kSampleSize)) {
    if (!valid(conversation)) {
      for (const auto& c : evals::kCriteria) scores[c].push_back(0);  // procedural validation failed: no judge call
      continue;
    }
    const std::string text = evals::transcript(conversation);
    for (const auto& c : evals::kCriteria) {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + kJudgeDeadline);
      sidekickrpc::ScoreRequest request;
      request.set_conversation_id(conversation.id);
      request.set_criterion(c);
      request.set_rubric(evals::kRubrics.at(c));
      request.set_transcript(text);
      sidekickrpc::ScoreReply reply;
      const grpc::Status status = judge_stub->Score(&ctx, request, &reply);
      if (!status.ok()) throw std::runtime_error("judge: " + status.error_message());
      scores[c].push_back(reply.score());
      if (const auto label = conversation.human_labels.find(c); label != conversation.human_labels.end()) {
        judged[c].push_back(static_cast<int>(std::lround(reply.score())));
        human[c].push_back(label->second);
      }
    }
  }
  std::map<std::string, double> means;
  for (const auto& c : evals::kCriteria) {
    double sum = 0;
    for (double s : scores[c]) sum += s;
    means[c] = sum / scores[c].size();
  }
  for (const auto& c : evals::kCriteria) {
    if (evals::cohen_kappa(judged[c], human[c]) < kMinJudgeKappa) return {false, means, "the " + c + " judge disagrees with the labellers"};
  }
  for (const auto& c : evals::kCriteria) {
    if (means[c] < kMinScore) return {false, means, c + " is below the floor"};
    if (means[c] < gtx::baseline(c) - kMaxRegression) return {false, means, c + " regressed from the baseline"};
  }
  gtx::record(version, means);
  return {true, means, "ship"};
}
`,
    },
  },
  harness: {
    python: `import merchant_agent_pb2
import merchant_agent_pb2_grpc
from sidekick import config, evals, judge

BASELINE = {"correctness": "0.95", "schema_compliance": "1.0", "helpfulness": "0.95"}


class JudgePeer(merchant_agent_pb2_grpc.JudgeServicer):
    """The stand-in judges (sidekick.judge); rubber_stamp makes them score everything 1.0."""

    def __init__(self):
        self.rubber_stamp = False

    def Score(self, request, context):
        if self.rubber_stamp:
            return merchant_agent_pb2.ScoreReply(score=1.0)
        return merchant_agent_pb2.ScoreReply(score=judge.score(request.criterion, request.rubric, request.transcript))


def _world(ctx):
    peer = JudgePeer()
    ctx.grpc.serve(merchant_agent_pb2_grpc.add_JudgeServicer_to_server, peer, config.JUDGE_ADDR)
    ctx.redis.hset("gtx:baseline", mapping=BASELINE)
    return ctx.load("judge_gate"), peer


def _scored(ctx):
    return [call.request for call in ctx.grpc.calls_to("Score")]


def check_full_sample(ctx):
    m, _ = _world(ctx)
    m.gate("v-good")
    ids = {r.conversation_id for r in _scored(ctx)}
    assert len(ids) == 200, f"the gate judged {len(ids)} conversations: five cannot tell a two-point regression from noise; judge SAMPLE_SIZE = 200"


def check_judge_per_criterion(ctx):
    m, _ = _world(ctx)
    m.gate("v-good")
    requests = _scored(ctx)
    assert requests, "the gate never called the judge"
    for r in requests:
        assert r.criterion in evals.CRITERIA, f"Score was called with criterion {r.criterion!r}: one judge per criterion in {evals.CRITERIA}"
        assert r.rubric == evals.RUBRICS[r.criterion], f"the {r.criterion} judge got the rubric {r.rubric!r}, not RUBRICS[{r.criterion!r}]"
        assert r.transcript.startswith("merchant:") and r.transcript.count("\\n") >= 3, f"the judge saw {r.transcript!r}: it must read the whole conversation, where a wrong tool call two turns back shows"
    per_conversation = {}
    for r in requests:
        per_conversation.setdefault(r.conversation_id, set()).add(r.criterion)
    partial = [cid for cid, seen in per_conversation.items() if seen != set(evals.CRITERIA)]
    assert not partial, f"conversations judged on fewer than all three criteria: {partial[:3]}"
    timeouts = {call.timeout for call in ctx.grpc.calls_to("Score")}
    assert None not in timeouts and max(timeouts) <= 15.5, f"every Score call carries a deadline of at most 15 s, saw {sorted(timeouts, key=str)[:3]}"


def check_calibrated_judges(ctx):
    m, peer = _world(ctx)
    peer.rubber_stamp = True
    decision = m.gate("v-good")
    assert decision.ship is False, f"a judge that scores everything 1.0 disagrees with the labellers on correctness (kappa 0) and the gate shipped anyway: {decision}"
    assert not ctx.redis.exists("gtx:release:v-good"), "a refused release must record nothing"
    peer.rubber_stamp = False
    decision = m.gate("v-good")
    assert decision.ship is True, f"with judges that agree with the labellers v-good ships: {decision}"


def check_schema_first(ctx):
    m, _ = _world(ctx)
    decision = m.gate("v-tag")
    tagged = sorted({r.conversation_id for r in _scored(ctx) if int(r.conversation_id.rsplit("-", 1)[1]) % 20 in (4, 8, 12, 16)})
    assert not tagged, f"conversations that filter on customer_tags CONTAINS enabled reached the judge ({tagged[:3]}…): validate_schema runs first and they score 0"
    assert decision.ship is False, f"a fifth of v-tag's segments use a tag as a status and v-tag shipped: {decision}"


def check_ship_decision(ctx):
    m, _ = _world(ctx)
    early = m.gate("v-early")
    assert early.ship is False, f"v-early's correctness is 0.65, under MIN_SCORE = 0.8, and it shipped: {early}"
    regress = m.gate("v-regress")
    assert regress.ship is False, f"v-regress's helpfulness is 0.90 against a baseline of 0.95 (MAX_REGRESSION = 0.02) and it shipped: {regress}"
    good = m.gate("v-good")
    assert good.ship is True, f"v-good matches the baseline and must ship: {good}"
    recorded = ctx.redis.hgetall("gtx:release:v-good")
    assert set(recorded) == set(evals.CRITERIA) and abs(float(recorded["correctness"]) - 0.95) < 1e-6, f"a shipped version records its mean per criterion: {recorded}"
    assert not ctx.redis.exists("gtx:release:v-early") and not ctx.redis.exists("gtx:release:v-regress"), "a refused version must record nothing"
`,
    typescript: `const BASELINE = {correctness: '0.95', schema_compliance: '1.0', helpfulness: '0.95'};

/** The stand-in judges (sidekick/judge), the baseline seeded, the learner's module. */
function world(ctx) {
  const {sidekickrpc} = ctx.proto('merchant_agent.proto');
  const config = ctx.load('/support/sidekick/config.ts');
  const judge = ctx.load('/support/sidekick/judge.ts');
  const evals = ctx.load('/support/sidekick/evals.ts');
  const peer = {rubberStamp: false};
  ctx.grpc.serve(sidekickrpc.Judge.service, {
    Score(call, callback) {
      if (peer.rubberStamp) return callback(null, {score: 1});
      return callback(null, {score: judge.score(call.request.criterion, call.request.rubric, call.request.transcript)});
    },
  }, config.JUDGE_ADDR);
  ctx.redis.hset('gtx:baseline', BASELINE);
  return {m: ctx.load('judge_gate'), peer, evals};
}

const scored = ctx => ctx.grpc.callsTo('Score').map(call => call.request);

export async function check_full_sample(ctx) {
  const {m} = world(ctx);
  await m.gate('v-good');
  const ids = new Set(scored(ctx).map(r => r.conversation_id));
  assert.equal(ids.size, 200, \`the gate judged \${ids.size} conversations: five cannot tell a two-point regression from noise; judge SAMPLE_SIZE = 200\`);
}

export async function check_judge_per_criterion(ctx) {
  const {m, evals} = world(ctx);
  await m.gate('v-good');
  const requests = scored(ctx);
  assert(requests.length > 0, 'the gate never called the judge');
  for (const r of requests) {
    assert(evals.CRITERIA.includes(r.criterion), \`Score was called with criterion \${JSON.stringify(r.criterion)}: one judge per criterion in \${JSON.stringify(evals.CRITERIA)}\`);
    assert.equal(r.rubric, evals.RUBRICS[r.criterion], \`the \${r.criterion} judge got the rubric \${JSON.stringify(r.rubric)}, not RUBRICS[\${r.criterion}]\`);
    assert(r.transcript.startsWith('merchant:') && r.transcript.split('\\n').length >= 4, \`the judge saw \${JSON.stringify(r.transcript)}: it must read the whole conversation, where a wrong tool call two turns back shows\`);
  }
  const seen: Record<string, string[]> = {};
  for (const r of requests) (seen[r.conversation_id] ??= []).push(r.criterion);
  const partial = Object.entries(seen).filter(([, cs]) => new Set(cs).size !== evals.CRITERIA.length).map(([id]) => id);
  assert.deepEqual(partial, [], \`conversations judged on fewer than all three criteria: \${JSON.stringify(partial.slice(0, 3))}\`);
  const timeouts = ctx.grpc.callsTo('Score').map(call => call.timeout);
  assert(timeouts.every(t => t !== null && t <= 15.5), \`every Score call carries a deadline of at most 15 s, saw \${JSON.stringify(timeouts.slice(0, 3))}\`);
}

export async function check_calibrated_judges(ctx) {
  const {m, peer} = world(ctx);
  peer.rubberStamp = true;
  let decision = await m.gate('v-good');
  assert.equal(decision.ship, false, \`a judge that scores everything 1.0 disagrees with the labellers on correctness (kappa 0) and the gate shipped anyway: \${JSON.stringify(decision)}\`);
  assert.equal(ctx.redis.exists('gtx:release:v-good'), 0, 'a refused release must record nothing');
  peer.rubberStamp = false;
  decision = await m.gate('v-good');
  assert.equal(decision.ship, true, \`with judges that agree with the labellers v-good ships: \${JSON.stringify(decision)}\`);
}

export async function check_schema_first(ctx) {
  const {m} = world(ctx);
  const decision = await m.gate('v-tag');
  const tagged = [...new Set(scored(ctx).map(r => r.conversation_id))].filter(id => [4, 8, 12, 16].includes(Number(id.split('-').pop()) % 20));
  assert.deepEqual(tagged, [], \`conversations that filter on customer_tags CONTAINS enabled reached the judge (\${JSON.stringify(tagged.slice(0, 3))}…): validateSchema runs first and they score 0\`);
  assert.equal(decision.ship, false, \`a fifth of v-tag's segments use a tag as a status and v-tag shipped: \${JSON.stringify(decision)}\`);
}

export async function check_ship_decision(ctx) {
  const {m, evals} = world(ctx);
  const early = await m.gate('v-early');
  assert.equal(early.ship, false, \`v-early's correctness is 0.65, under MIN_SCORE = 0.8, and it shipped: \${JSON.stringify(early)}\`);
  const regress = await m.gate('v-regress');
  assert.equal(regress.ship, false, \`v-regress's helpfulness is 0.90 against a baseline of 0.95 (MAX_REGRESSION = 0.02) and it shipped: \${JSON.stringify(regress)}\`);
  const good = await m.gate('v-good');
  assert.equal(good.ship, true, \`v-good matches the baseline and must ship: \${JSON.stringify(good)}\`);
  const recorded = ctx.redis.hgetall('gtx:release:v-good');
  assert(Object.keys(recorded).sort().join() === [...evals.CRITERIA].sort().join() && Math.abs(Number(recorded.correctness) - 0.95) < 1e-6, \`a shipped version records its mean per criterion: \${JSON.stringify(recorded)}\`);
  assert(ctx.redis.exists('gtx:release:v-early') === 0 && ctx.redis.exists('gtx:release:v-regress') === 0, 'a refused version must record nothing');
}
`,
    go: `package main

import (
	"context"
	"math"
	"sort"
	"strconv"
	"strings"

	"sidekick/config"
	"sidekick/evals"
	"sidekick/judge"
	pb "sidekickrpc/gen/merchant_agent"

	"leetbuild/harness"
)

// gatePeer is the stand-in judges (sidekick/judge); rubberStamp makes them score everything 1.0.
type gatePeer struct {
	pb.UnimplementedJudgeServer
	rubberStamp bool
}

func (p *gatePeer) Score(_ context.Context, req *pb.ScoreRequest) (*pb.ScoreReply, error) {
	if p.rubberStamp {
		return &pb.ScoreReply{Score: 1}, nil
	}
	return &pb.ScoreReply{Score: judge.Score(req.GetCriterion(), req.GetRubric(), req.GetTranscript())}, nil
}

func gateWorld(ctx *harness.Ctx) *gatePeer {
	peer := &gatePeer{}
	pb.RegisterJudgeServer(ctx.GRPC.Server(config.JudgeAddr), peer)
	ctx.Redis.Do("HSET", "gtx:baseline", "correctness", "0.95", "schema_compliance", "1.0", "helpfulness", "0.95")
	return peer
}

func gateRun(ctx *harness.Ctx, version string) evals.Decision {
	d, err := gate(context.Background(), version)
	ctx.NoError(err, "gate(%q)", version)
	return d
}

func gateScored(ctx *harness.Ctx) []*pb.ScoreRequest {
	out := []*pb.ScoreRequest{}
	for _, c := range ctx.GRPC.CallsTo("Score", "") {
		req, _ := c.Request.(*pb.ScoreRequest)
		out = append(out, req)
	}
	return out
}

func CheckFullSample(ctx *harness.Ctx) {
	gateWorld(ctx)
	gateRun(ctx, "v-good")
	ids := map[string]bool{}
	for _, r := range gateScored(ctx) {
		ids[r.GetConversationId()] = true
	}
	ctx.Equal(len(ids), 200, "five conversations cannot tell a two-point regression from noise; judge sampleSize = 200; conversations judged")
}

func CheckJudgePerCriterion(ctx *harness.Ctx) {
	gateWorld(ctx)
	gateRun(ctx, "v-good")
	requests := gateScored(ctx)
	ctx.Assert(len(requests) > 0, "the gate never called the judge")
	seen := map[string]map[string]bool{}
	for _, r := range requests {
		rubric, known := evals.Rubrics[r.GetCriterion()]
		ctx.Assert(known, "Score was called with criterion %q: one judge per criterion in %v", r.GetCriterion(), evals.Criteria)
		ctx.Equal(r.GetRubric(), rubric, "the %s judge's rubric must be evals.Rubrics[%q]", r.GetCriterion(), r.GetCriterion())
		ctx.Assert(strings.HasPrefix(r.GetTranscript(), "merchant:") && strings.Count(r.GetTranscript(), "\\n") >= 3, "the judge saw %q: it must read the whole conversation, where a wrong tool call two turns back shows", r.GetTranscript())
		if seen[r.GetConversationId()] == nil {
			seen[r.GetConversationId()] = map[string]bool{}
		}
		seen[r.GetConversationId()][r.GetCriterion()] = true
	}
	for id, cs := range seen {
		ctx.Equal(len(cs), len(evals.Criteria), "conversation %s must be judged on every criterion; criteria", id)
	}
	for _, c := range ctx.GRPC.CallsTo("Score", "") {
		ctx.Assert(c.HasDeadline() && c.Timeout.Seconds() <= 15.5, "every Score call carries a deadline of at most 15 s, one carried %v", c.Timeout)
	}
}

func CheckCalibratedJudges(ctx *harness.Ctx) {
	peer := gateWorld(ctx)
	peer.rubberStamp = true
	d := gateRun(ctx, "v-good")
	ctx.Assert(!d.Ship, "a judge that scores everything 1.0 disagrees with the labellers on correctness (kappa 0) and the gate shipped anyway: %+v", d)
	ctx.Equal(ctx.Redis.Exists("gtx:release:v-good"), int64(0), "a refused release must record nothing; gtx:release:v-good exists")
	peer.rubberStamp = false
	d = gateRun(ctx, "v-good")
	ctx.Assert(d.Ship, "with judges that agree with the labellers v-good ships: %+v", d)
}

func CheckSchemaFirst(ctx *harness.Ctx) {
	gateWorld(ctx)
	d := gateRun(ctx, "v-tag")
	tagged := []string{}
	for _, r := range gateScored(ctx) {
		parts := strings.Split(r.GetConversationId(), "-")
		i, _ := strconv.Atoi(parts[len(parts)-1])
		if p := i % 20; p == 4 || p == 8 || p == 12 || p == 16 {
			tagged = append(tagged, r.GetConversationId())
		}
	}
	sort.Strings(tagged)
	ctx.Equal(len(tagged), 0, "conversations that filter on customer_tags CONTAINS enabled reached the judge (%v): evals.ValidateSchema runs first and they score 0", tagged)
	ctx.Assert(!d.Ship, "a fifth of v-tag's segments use a tag as a status and v-tag shipped: %+v", d)
}

func CheckShipDecision(ctx *harness.Ctx) {
	gateWorld(ctx)
	early := gateRun(ctx, "v-early")
	ctx.Assert(!early.Ship, "v-early's correctness is 0.65, under minScore = 0.8, and it shipped: %+v", early)
	regress := gateRun(ctx, "v-regress")
	ctx.Assert(!regress.Ship, "v-regress's helpfulness is 0.90 against a baseline of 0.95 (maxRegression = 0.02) and it shipped: %+v", regress)
	good := gateRun(ctx, "v-good")
	ctx.Assert(good.Ship, "v-good matches the baseline and must ship: %+v", good)
	recorded := ctx.Redis.HGetAll("gtx:release:v-good")
	correctness, _ := strconv.ParseFloat(recorded["correctness"], 64)
	ctx.Assert(len(recorded) == len(evals.Criteria) && math.Abs(correctness-0.95) < 1e-6, "a shipped version records its mean per criterion: %v", recorded)
	ctx.Assert(ctx.Redis.Exists("gtx:release:v-early", "gtx:release:v-regress") == 0, "a refused version must record nothing")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "merchant_agent.grpc.pb.h"
#include "sidekick/config.h"
#include "sidekick/evals.h"
#include "sidekick/judge.h"

namespace {

// The stand-in judges (sidekick/judge.h); rubber_stamp makes them score everything 1.0.
class GatePeer final : public sidekickrpc::Judge::Service {
 public:
  bool rubber_stamp = false;
  grpc::Status Score(grpc::ServerContext*, const sidekickrpc::ScoreRequest* req, sidekickrpc::ScoreReply* reply) override {
    reply->set_score(rubber_stamp ? 1.0 : judge::score(req->criterion(), req->rubric(), req->transcript()));
    return grpc::Status::OK;
  }
};

GatePeer& gateWorld(harness::Ctx& ctx) {
  static GatePeer* peer = nullptr;
  delete peer;
  peer = new GatePeer;
  ctx.GRPC.Server(config::kJudgeAddr)->RegisterService(peer);
  ctx.Redis.Do("HSET", "gtx:baseline", "correctness", "0.95", "schema_compliance", "1.0", "helpfulness", "0.95");
  return *peer;
}

std::vector<sidekickrpc::ScoreRequest> gateScored(harness::Ctx& ctx) {
  std::vector<sidekickrpc::ScoreRequest> out;
  for (const auto& c : ctx.GRPC.CallsTo("Score")) out.push_back(c.Request<sidekickrpc::ScoreRequest>());
  return out;
}

}  // namespace

void CheckFullSample(harness::Ctx& ctx) {
  gateWorld(ctx);
  gate("v-good");
  std::set<std::string> ids;
  for (const auto& r : gateScored(ctx)) ids.insert(r.conversation_id());
  ctx.Equal(ids.size(), 200, "five conversations cannot tell a two-point regression from noise; judge kSampleSize = 200; conversations judged");
}

void CheckJudgePerCriterion(harness::Ctx& ctx) {
  gateWorld(ctx);
  gate("v-good");
  const auto requests = gateScored(ctx);
  ctx.Assert(!requests.empty(), "the gate never called the judge");
  std::map<std::string, std::set<std::string>> seen;
  for (const auto& r : requests) {
    const auto rubric = evals::kRubrics.find(r.criterion());
    ctx.Assert(rubric != evals::kRubrics.end(), "Score was called with criterion %q: one judge per criterion in %v", r.criterion(), evals::kCriteria);
    ctx.Equal(r.rubric(), rubric->second, "the %s judge's rubric must be evals::kRubrics.at(%q)", r.criterion(), r.criterion());
    const auto lines = std::count(r.transcript().begin(), r.transcript().end(), '\\n');
    ctx.Assert(r.transcript().rfind("merchant:", 0) == 0 && lines >= 3, "the judge saw %q: it must read the whole conversation, where a wrong tool call two turns back shows", r.transcript());
    seen[r.conversation_id()].insert(r.criterion());
  }
  for (const auto& [id, criteria] : seen) ctx.Equal(criteria.size(), evals::kCriteria.size(), "conversation %s must be judged on every criterion; criteria", id);
  for (const auto& c : ctx.GRPC.CallsTo("Score")) {
    ctx.Assert(c.HasDeadline() && c.TimeoutSeconds() <= 15.5, "every Score call carries a deadline of at most 15 s, one carried %vs", c.TimeoutSeconds());
  }
}

void CheckCalibratedJudges(harness::Ctx& ctx) {
  auto& peer = gateWorld(ctx);
  peer.rubber_stamp = true;
  auto d = gate("v-good");
  ctx.Assert(!d.ship, "a judge that scores everything 1.0 disagrees with the labellers on correctness (kappa 0) and the gate shipped anyway (%s)", d.reason);
  ctx.Equal(ctx.Redis.Exists("gtx:release:v-good"), 0, "a refused release must record nothing; gtx:release:v-good exists");
  peer.rubber_stamp = false;
  d = gate("v-good");
  ctx.Assert(d.ship, "with judges that agree with the labellers v-good ships (%s)", d.reason);
}

void CheckSchemaFirst(harness::Ctx& ctx) {
  gateWorld(ctx);
  const auto d = gate("v-tag");
  std::vector<std::string> tagged;
  for (const auto& r : gateScored(ctx)) {
    const std::string& id = r.conversation_id();
    const int p = std::atoi(id.substr(id.rfind('-') + 1).c_str()) % 20;
    if (p == 4 || p == 8 || p == 12 || p == 16) tagged.push_back(id);
  }
  ctx.Equal(tagged.size(), 0, "conversations that filter on customer_tags CONTAINS enabled reached the judge (%v): evals::validate_schema runs first and they score 0", tagged);
  ctx.Assert(!d.ship, "a fifth of v-tag's segments use a tag as a status and v-tag shipped (%s)", d.reason);
}

void CheckShipDecision(harness::Ctx& ctx) {
  gateWorld(ctx);
  const auto early = gate("v-early");
  ctx.Assert(!early.ship, "v-early's correctness is 0.65, under kMinScore = 0.8, and it shipped (%s)", early.reason);
  const auto regress = gate("v-regress");
  ctx.Assert(!regress.ship, "v-regress's helpfulness is 0.90 against a baseline of 0.95 (kMaxRegression = 0.02) and it shipped (%s)", regress.reason);
  const auto good = gate("v-good");
  ctx.Assert(good.ship, "v-good matches the baseline and must ship (%s)", good.reason);
  const auto recorded = ctx.Redis.HGetAll("gtx:release:v-good");
  const auto correctness = recorded.find("correctness");
  ctx.Assert(recorded.size() == evals::kCriteria.size() && correctness != recorded.end() && std::fabs(std::strtod(correctness->second.c_str(), nullptr) - 0.95) < 1e-6,
             "a shipped version records its mean per criterion: %v", recorded);
  ctx.Equal(ctx.Redis.Exists("gtx:release:v-early", "gtx:release:v-regress"), 0, "a refused version must record nothing; refused releases recorded");
}
`,
  },
  hints: [
    'Symptom: a prompt change that broke one tool in five shipped on a green gate, and the gate is just as green when the judge prompt is replaced by "score everything 1".',
    'Mechanism: five conversations, one judge asked a 0-10 question about the last turn, no comparison with the human labels, no schema check before the judge, and a threshold of 0.5 with no baseline.',
    'Change: `gtx.sample(version, SAMPLE_SIZE)` with 200; per valid conversation one `Score` per criterion with `RUBRICS[c]`, `transcript(conversation)` and `timeout=JUDGE_DEADLINE_S`; score invalid ones 0; `cohen_kappa` per criterion before trusting means; floor plus baseline regression.',
  ],
  debrief: `The gate is only as trustworthy as its weakest measurement, so each fix removes one way to be fooled. Two hundred conversations make a two-point drop visible; a judge per criterion with its own rubric turns "looks fine" into three questions a human labeller also answered; kappa against those labels is the evidence that the judge's 0.95 means what a person's would. Validating the schema first is cheap and catches the failure the judge reads past, a tag used as a status. The regression limit compares with the last release, not with an absolute bar. A production gate also replays conversations through a merchant simulator, stratifies the sample by page and tool, and re-measures kappa whenever the judge prompt or model changes.`,
};
