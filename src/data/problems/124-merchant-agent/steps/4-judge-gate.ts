import type {Step} from '@/lib/types';

export const judgeGateStep: Step = {
  id: 'judge-gate',
  title: 'LLM-as-judge: calibrated judges gate the release',
  concept: 'grpc',
  file: 'judge_gate',
  focus: ['api', 'judge', 'gtx'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the release gate: before a
new prompt or model version ships, it scores a few conversations with a judge model and returns a
verdict. It runs, it prints a number, and it is exactly what Sidekick's team calls vibe testing. It
hides five flaws. Review it, fix it, and prove the fix.

Implement \`gate(version)\` over \`Judge.Score\` (\`turns\`, \`criterion\`, \`rubric\` → \`score\`
in 0..1) and the ground-truth set:

- **Ground-truth set, not a golden file**: sample **\`SAMPLE_SIZE = 200\`** conversations replayed
  through the candidate version (\`gtx.sample(version, SAMPLE_SIZE)\`); the set reflects what
  merchants actually ask. Every judge call carries a **15 s** deadline.
- **One judge per criterion** with a written rubric: \`CRITERIA\` are \`correctness\`,
  \`schema_compliance\` and \`helpfulness\`, each scored over the **whole conversation**, not the last
  message. There is no "rate this 0–10" judge.
- **Calibrate before trusting**: on the human-labelled subset, compare each judge's labels with the
  human labels with **Cohen's kappa** and refuse to gate when a judge's kappa is below
  **\`MIN_JUDGE_KAPPA = 0.6\`** — the source's judges went from 0.02 to 0.61 against a human
  baseline of 0.69, and a judge below that bar is not evidence.
- **Procedural validation first**: every tool call's arguments are checked against the tool's
  schema (\`validate_schema\`) before any judge runs; a conversation with an invalid filter such as
  \`customer_tags CONTAINS 'enabled'\` scores 0 on every criterion without spending a judge call.
- **The gate**: a version ships only when every criterion's mean is at least
  **\`MIN_SCORE = 0.8\`** and no criterion regresses more than **\`MAX_REGRESSION = 0.02\`** below
  the recorded baseline of the version in production. Record the scores on success.

**Failure mode the checks target.** Five conversations and a 0–10 vibe score cannot tell a
regression from noise; a judge nobody calibrated may agree with humans no better than a coin
flip; judging the last message hides a wrong tool call three turns earlier; and a gate that never
compares against the baseline ships a 0.79 over a 0.91 because both "looked fine".`,
  sequence: {
    participants: ['Release gate', 'ground-truth set', 'Judge'],
    messages: [
      {from: 'Release gate', to: 'ground-truth set', label: 'labelled() · human labels per criterion', kind: 'sync'},
      {
        from: 'Release gate',
        to: 'Judge',
        label: 'Score(turns, criterion, rubric) · 15 s · per labelled conversation',
        kind: 'sync',
      },
      {from: 'Judge', to: 'Release gate', label: 'score', kind: 'reply'},
      {from: 'Release gate', to: 'Release gate', label: 'cohen_kappa(human, judge) ≥ 0.6 or refuse', kind: 'sync'},
      {from: 'Release gate', to: 'ground-truth set', label: 'sample(version, 200)', kind: 'sync'},
      {
        from: 'Release gate',
        to: 'Release gate',
        label: 'validate_schema(tool calls) → 0 without a judge call',
        kind: 'sync',
      },
      {from: 'Release gate', to: 'Judge', label: 'Score(whole conversation, criterion, rubric) × 3', kind: 'sync'},
      {
        from: 'Release gate',
        to: 'ground-truth set',
        label: 'baseline(criterion) · record(version, means)',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'Three constants fix three flaws: `SAMPLE_SIZE = 200` on the sample, `JUDGE_DEADLINE_S` on every `Score` call, and a `CRITERIA` tuple with a `RUBRICS` entry each. Send `conversation.turns` whole — the judge needs the tool calls, not just the final sentence.',
    'Calibration is a comparison, not a prompt: for each criterion, score the labelled conversations, binarise the judge’s score at 0.5, and compute `cohen_kappa(human, judge)`. Below `MIN_JUDGE_KAPPA` the judge is not evidence, so the gate refuses rather than guesses.',
    'Run `validate_schema` on the conversation’s tool calls before the first judge call: an invalid filter is a 0 on every criterion and no judge is spent on it. Then gate on both `MIN_SCORE` and `baseline(criterion) - MAX_REGRESSION`, and `record` the means only when the version passes.',
  ],
  checks: [
    {
      id: 'calibrate',
      title: 'Calibrates each judge against human labels with Cohen’s kappa',
      detail:
        'The judge’s labels on the human-labelled subset are compared with `human_labels` using `cohen_kappa`, and the gate refuses when kappa is below `MIN_JUDGE_KAPPA = 0.6`. The draft trusts the judge without ever checking it against a person.',
      match: {
        python: {all: [/cohen_kappa\(/, /MIN_JUDGE_KAPPA\s*=\s*0\.6/, /human_labels/]},
        typescript: {all: [/cohenKappa\(/, /MIN_JUDGE_KAPPA\s*=\s*0\.6/, /humanLabels/]},
        go: {all: [/cohenKappa\(/, /minJudgeKappa\s*=\s*0\.6/, /HumanLabels/]},
        scala: {all: [/cohenKappa\(/, /MinJudgeKappa\s*=\s*0\.6/, /humanLabels/]},
        cpp: {all: [/cohenKappa\(/, /kMinJudgeKappa\s*=\s*0\.6/, /humanLabels/]},
      },
    },
    {
      id: 'rubric-per-criterion',
      title: 'One judge per criterion with a rubric, over the whole conversation',
      detail:
        'Scores come from `CRITERIA` × `RUBRICS[criterion]` and every `Score` request carries the full `turns`; there is no "Rate this" vibe judge. The draft asks one judge for a 0–10 number on the last message.',
      match: {
        python: {all: [/CRITERIA/, /rubric\s*=\s*RUBRICS\[/], none: [/Rate this/, /turns\[-1:\]/]},
        typescript: {all: [/CRITERIA/, /rubric:\s*RUBRICS\[/], none: [/Rate this/, /\.slice\(-1\)/]},
        go: {all: [/\bcriteria\b/, /Rubric:\s*rubrics\[/], none: [/Rate this/, /Turns\[len\(/]},
        scala: {all: [/Criteria/, /rubric\s*=\s*Rubrics\(/], none: [/Rate this/, /\.takeRight\(1\)/]},
        cpp: {all: [/kCriteria/, /set_rubric\(\s*kRubrics\.at\(/], none: [/Rate this/, /\.back\(\)/]},
      },
    },
    {
      id: 'sample-deadline',
      title: 'Samples 200 conversations and bounds every judge call',
      detail:
        'The candidate is scored on `SAMPLE_SIZE = 200` conversations from the ground-truth set and each `Score` call carries `JUDGE_DEADLINE_S` (15 s). Five conversations cannot separate a regression from noise, and an unbounded judge call pins the release pipeline.',
      match: {
        python: {all: [/SAMPLE_SIZE\s*=\s*200/, /JUDGE_DEADLINE_S\s*=\s*15/, /timeout\s*=\s*JUDGE_DEADLINE_S/]},
        typescript: {
          all: [
            /SAMPLE_SIZE\s*=\s*200/,
            /JUDGE_DEADLINE_MS\s*=\s*15_?000/,
            /deadline:\s*Date\.now\(\)\s*\+\s*JUDGE_DEADLINE_MS/,
          ],
        },
        go: {all: [/sampleSize\s*=\s*200/, /judgeDeadline\s*=\s*15\s*\*\s*time\.Second/, /context\.WithTimeout/]},
        scala: {all: [/SampleSize\s*=\s*200/, /JudgeDeadlineMs\s*=\s*15000/, /withDeadlineAfter\(\s*JudgeDeadlineMs/]},
        cpp: {all: [/kSampleSize\s*=\s*200/, /kJudgeDeadlineMs\s*=\s*15000/, /set_deadline\(/]},
      },
    },
    {
      id: 'schema-first',
      title: 'Validates tool-call schemas before any judge call',
      detail:
        '`validate_schema` runs on the conversation’s tool calls before the judge is asked; an invalid call scores 0 on every criterion and spends no judge call. The draft has no procedural check at all — the source’s tag-hacking filters would pass.',
      match: {
        python: {all: [/validate_schema\(/], order: [/validate_schema\(/, /judge\.Score\(/]},
        typescript: {all: [/validateSchema\(/], order: [/validateSchema\(/, /judge\.Score\(/]},
        go: {all: [/validateSchema\(/], order: [/validateSchema\(/, /judge\.Score\(/]},
        scala: {all: [/validateSchema\(/], order: [/validateSchema\(/, /\.score\(/]},
        cpp: {all: [/validateSchema\(/], order: [/validateSchema\(/, /judge->Score\(/]},
      },
    },
    {
      id: 'gate',
      title: 'Ships only above the floor and within regression of the baseline',
      detail:
        'Every criterion’s mean must reach `MIN_SCORE = 0.8` and stay within `MAX_REGRESSION = 0.02` of `baseline(criterion)`; the means are recorded only on success. The draft returns true whenever the average looks acceptable.',
      match: {
        python: {all: [/MIN_SCORE\s*=\s*0\.8/, /MAX_REGRESSION\s*=\s*0\.02/, /\.baseline\(/, /\.record\(/]},
        typescript: {all: [/MIN_SCORE\s*=\s*0\.8/, /MAX_REGRESSION\s*=\s*0\.02/, /\.baseline\(/, /\.record\(/]},
        go: {all: [/minScore\s*=\s*0\.8/, /maxRegression\s*=\s*0\.02/, /\.Baseline\(/, /\.Record\(/]},
        scala: {all: [/MinScore\s*=\s*0\.8/, /MaxRegression\s*=\s*0\.02/, /\.baseline\(/, /\.record\(/]},
        cpp: {all: [/kMinScore\s*=\s*0\.8/, /kMaxRegression\s*=\s*0\.02/, /\.baseline\(/, /\.record\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from dataclasses import dataclass, field

import grpc

import sidekick_pb2
import sidekick_pb2_grpc

judge = sidekick_pb2_grpc.JudgeStub(grpc.insecure_channel("judge:9000"))


@dataclass
class Conversation:
    id: str
    turns: list[sidekick_pb2.Message]
    tool_calls: list[tuple[str, str]] = field(default_factory=list)
    human_labels: dict[str, int] | None = None


class GroundTruthSet:
    def sample(self, version: str, n: int) -> list[Conversation]:
        """Real merchant conversations, replayed through the candidate version."""
        raise NotImplementedError

    def labelled(self) -> list[Conversation]:
        """The subset at least three product experts labelled per criterion (1 = acceptable)."""
        raise NotImplementedError


class ReleaseStore:
    def baseline(self, criterion: str) -> float:
        """Mean score of the version in production."""
        raise NotImplementedError

    def record(self, version: str, means: dict[str, float]) -> None:
        raise NotImplementedError


gtx = GroundTruthSet()
releases = ReleaseStore()


def gate(version: str) -> bool:
    # TODO: this draft scores five conversations with one "rate this 0-10" judge on the last
    # message, never calibrates the judge against human labels, skips schema validation of the
    # tool calls, sets no deadline, and ships without comparing against the baseline.
    sample = gtx.sample(version, 5)
    total = 0.0
    for conversation in sample:
        reply = judge.Score(
            sidekick_pb2.ScoreRequest(
                turns=conversation.turns[-1:],
                criterion="overall",
                rubric="Rate this conversation 0-10.",
            )
        )
        total += reply.score / 10
    return total / len(sample) >= 0.5
`,
      solution: `import json
from dataclasses import dataclass, field

import grpc

import sidekick_pb2
import sidekick_pb2_grpc

SAMPLE_SIZE = 200
JUDGE_DEADLINE_S = 15.0
MIN_JUDGE_KAPPA = 0.6
MIN_SCORE = 0.8
MAX_REGRESSION = 0.02

CRITERIA = ("correctness", "schema_compliance", "helpfulness")
RUBRICS = {
    "correctness": "1 when every fact and figure in the assistant's replies follows from the tool results; 0 otherwise.",
    "schema_compliance": "1 when every filter uses the documented customer, order and product fields with valid "
    "enum values (customer_account_status = 'ENABLED', never a tag as a catch-all); 0 otherwise.",
    "helpfulness": "1 when the merchant's request was completed or a precise reason was given; 0 when the "
    "assistant opted out of a task it had the tools for.",
}
FILTER_FIELDS = {"customer_account_status", "default_address.city", "total_spent", "orders_count", "tags"}

judge = sidekick_pb2_grpc.JudgeStub(grpc.insecure_channel("judge:9000"))


@dataclass
class Conversation:
    id: str
    turns: list[sidekick_pb2.Message]
    tool_calls: list[tuple[str, str]] = field(default_factory=list)
    human_labels: dict[str, int] | None = None


class GroundTruthSet:
    def sample(self, version: str, n: int) -> list[Conversation]:
        """Real merchant conversations, replayed through the candidate version."""
        raise NotImplementedError

    def labelled(self) -> list[Conversation]:
        """The subset at least three product experts labelled per criterion (1 = acceptable)."""
        raise NotImplementedError


class ReleaseStore:
    def baseline(self, criterion: str) -> float:
        """Mean score of the version in production."""
        raise NotImplementedError

    def record(self, version: str, means: dict[str, float]) -> None:
        raise NotImplementedError


gtx = GroundTruthSet()
releases = ReleaseStore()


class JudgeNotTrusted(Exception):
    pass


def validate_schema(tool_calls: list[tuple[str, str]]) -> bool:
    """Procedural stage: every filter names a documented field, and status is the enum, not a tag."""
    for _, args_json in tool_calls:
        try:
            args = json.loads(args_json)
        except ValueError:
            return False
        for clause in args.get("filters", []):
            if clause.get("field") not in FILTER_FIELDS:
                return False
            if clause.get("field") == "tags" and str(clause.get("value", "")).lower() in {"enabled", "disabled"}:
                return False
    return True


def judge_score(conversation: Conversation, criterion: str) -> float:
    request = sidekick_pb2.ScoreRequest(
        turns=conversation.turns,
        criterion=criterion,
        rubric=RUBRICS[criterion],
    )
    return judge.Score(request, timeout=JUDGE_DEADLINE_S).score


def cohen_kappa(human: list[int], judged: list[int]) -> float:
    n = len(human)
    observed = sum(1 for h, j in zip(human, judged) if h == j) / n
    p_human = sum(human) / n
    p_judge = sum(judged) / n
    expected = p_human * p_judge + (1 - p_human) * (1 - p_judge)
    return 1.0 if expected == 1.0 else (observed - expected) / (1 - expected)


def calibrate(criterion: str) -> float:
    labelled = [c for c in gtx.labelled() if c.human_labels is not None and criterion in c.human_labels]
    human = [c.human_labels[criterion] for c in labelled]
    judged = [1 if judge_score(c, criterion) >= 0.5 else 0 for c in labelled]
    return cohen_kappa(human, judged)


def evaluate(version: str) -> dict[str, float]:
    sample = gtx.sample(version, SAMPLE_SIZE)
    scores: dict[str, list[float]] = {criterion: [] for criterion in CRITERIA}
    for conversation in sample:
        if not validate_schema(conversation.tool_calls):
            for criterion in CRITERIA:
                scores[criterion].append(0.0)
            continue
        for criterion in CRITERIA:
            scores[criterion].append(judge_score(conversation, criterion))
    return {criterion: sum(values) / len(values) for criterion, values in scores.items()}


def gate(version: str) -> bool:
    for criterion in CRITERIA:
        kappa = calibrate(criterion)
        if kappa < MIN_JUDGE_KAPPA:
            raise JudgeNotTrusted(f"{criterion} judge kappa {kappa:.2f} < {MIN_JUDGE_KAPPA}")
    means = evaluate(version)
    for criterion, mean in means.items():
        if mean < MIN_SCORE or mean < releases.baseline(criterion) - MAX_REGRESSION:
            return False
    releases.record(version, means)
    return True
`,
    },
    typescript: {
      starter: `/** Release gate: a model-generated draft that judges five conversations on vibes. */
import {judge, type Message} from './clients';
import {gtx, releases} from './stores';

export interface Conversation {
  id: string;
  turns: Message[];
  toolCalls: Array<{name: string; argsJson: string}>;
  humanLabels?: Record<string, number>;
}

export async function gate(version: string): Promise<boolean> {
  // TODO: this draft scores five conversations with one "rate this 0-10" judge on the last
  // message, never calibrates the judge against human labels, skips schema validation of the
  // tool calls, sets no deadline, and ships without comparing against the baseline.
  const sample = await gtx.sample(version, 5);
  let total = 0;
  for (const conversation of sample) {
    const reply = await judge.Score({
      turns: conversation.turns.slice(-1),
      criterion: 'overall',
      rubric: 'Rate this conversation 0-10.',
    });
    total += reply.score / 10;
  }
  return total / sample.length >= 0.5;
}
`,
      solution: `/** Release gate: calibrated per-criterion judges over a ground-truth sample, schema first, baseline-compared. */
import {judge, type Message} from './clients';
import {gtx, releases} from './stores';

const SAMPLE_SIZE = 200;
const JUDGE_DEADLINE_MS = 15_000;
const MIN_JUDGE_KAPPA = 0.6;
const MIN_SCORE = 0.8;
const MAX_REGRESSION = 0.02;

const CRITERIA = ['correctness', 'schema_compliance', 'helpfulness'] as const;
type Criterion = (typeof CRITERIA)[number];

const RUBRICS: Record<Criterion, string> = {
  correctness: "1 when every fact and figure in the assistant's replies follows from the tool results; 0 otherwise.",
  schema_compliance:
    '1 when every filter uses the documented customer, order and product fields with valid enum values ' +
    "(customer_account_status = 'ENABLED', never a tag as a catch-all); 0 otherwise.",
  helpfulness:
    "1 when the merchant's request was completed or a precise reason was given; 0 when the assistant " +
    'opted out of a task it had the tools for.',
};
const FILTER_FIELDS: Record<string, true> = {
  customer_account_status: true,
  'default_address.city': true,
  total_spent: true,
  orders_count: true,
  tags: true,
};

export interface Conversation {
  id: string;
  turns: Message[];
  toolCalls: Array<{name: string; argsJson: string}>;
  humanLabels?: Record<string, number>;
}

export class JudgeNotTrusted extends Error {}

/** Procedural stage: every filter names a documented field, and status is the enum, not a tag. */
function validateSchema(toolCalls: Conversation['toolCalls']): boolean {
  for (const call of toolCalls) {
    let args: {filters?: Array<{field?: string; value?: unknown}>};
    try {
      args = JSON.parse(call.argsJson) as {filters?: Array<{field?: string; value?: unknown}>};
    } catch {
      return false;
    }
    for (const clause of args.filters ?? []) {
      if (clause.field === undefined || FILTER_FIELDS[clause.field] !== true) return false;
      const value = String(clause.value ?? '').toLowerCase();
      if (clause.field === 'tags' && (value === 'enabled' || value === 'disabled')) return false;
    }
  }
  return true;
}

async function judgeScore(conversation: Conversation, criterion: Criterion): Promise<number> {
  const reply = await judge.Score(
    {turns: conversation.turns, criterion, rubric: RUBRICS[criterion]},
    {deadline: Date.now() + JUDGE_DEADLINE_MS},
  );
  return reply.score;
}

function cohenKappa(human: number[], judged: number[]): number {
  const n = human.length;
  const observed = human.filter((h, i) => h === judged[i]).length / n;
  const pHuman = human.reduce((a, b) => a + b, 0) / n;
  const pJudge = judged.reduce((a, b) => a + b, 0) / n;
  const expected = pHuman * pJudge + (1 - pHuman) * (1 - pJudge);
  return expected === 1 ? 1 : (observed - expected) / (1 - expected);
}

async function calibrate(criterion: Criterion): Promise<number> {
  const labelled = (await gtx.labelled()).filter(c => c.humanLabels !== undefined && criterion in c.humanLabels);
  const human = labelled.map(c => c.humanLabels![criterion]);
  const judged: number[] = [];
  for (const conversation of labelled) judged.push((await judgeScore(conversation, criterion)) >= 0.5 ? 1 : 0);
  return cohenKappa(human, judged);
}

async function evaluate(version: string): Promise<Record<Criterion, number>> {
  const sample = await gtx.sample(version, SAMPLE_SIZE);
  const sums: Record<Criterion, number> = {correctness: 0, schema_compliance: 0, helpfulness: 0};
  for (const conversation of sample) {
    if (!validateSchema(conversation.toolCalls)) continue;
    for (const criterion of CRITERIA) sums[criterion] += await judgeScore(conversation, criterion);
  }
  return {
    correctness: sums.correctness / sample.length,
    schema_compliance: sums.schema_compliance / sample.length,
    helpfulness: sums.helpfulness / sample.length,
  };
}

export async function gate(version: string): Promise<boolean> {
  for (const criterion of CRITERIA) {
    const kappa = await calibrate(criterion);
    if (kappa < MIN_JUDGE_KAPPA) throw new JudgeNotTrusted(\`\${criterion} judge kappa \${kappa.toFixed(2)} < \${MIN_JUDGE_KAPPA}\`);
  }
  const means = await evaluate(version);
  for (const criterion of CRITERIA) {
    const baseline = await releases.baseline(criterion);
    if (means[criterion] < MIN_SCORE || means[criterion] < baseline - MAX_REGRESSION) return false;
  }
  await releases.record(version, means);
  return true;
}
`,
    },
    go: {
      starter: `package judge

import (
	"context"

	pb "sidekick/sidekickpb"
)

type ToolCall struct {
	Name     string
	ArgsJSON string
}

type Conversation struct {
	ID          string
	Turns       []*pb.Message
	ToolCalls   []ToolCall
	HumanLabels map[string]int
}

type GroundTruthSet interface {
	// Sample is real merchant conversations, replayed through the candidate version.
	Sample(ctx context.Context, version string, n int) ([]Conversation, error)
	// Labelled is the subset at least three product experts labelled per criterion (1 = acceptable).
	Labelled(ctx context.Context) ([]Conversation, error)
}

type ReleaseStore interface {
	Baseline(ctx context.Context, criterion string) (float64, error)
	Record(ctx context.Context, version string, means map[string]float64) error
}

var (
	judge    pb.JudgeClient
	gtx      GroundTruthSet
	releases ReleaseStore
)

// TODO: this draft scores five conversations with one "rate this 0-10" judge on the last message,
// never calibrates the judge against human labels, skips schema validation of the tool calls, sets
// no deadline, and ships without comparing against the baseline.
func Gate(ctx context.Context, version string) (bool, error) {
	sample, err := gtx.Sample(ctx, version, 5)
	if err != nil {
		return false, err
	}
	total := 0.0
	for _, conversation := range sample {
		reply, err := judge.Score(ctx, &pb.ScoreRequest{
			Turns:     conversation.Turns[len(conversation.Turns)-1:],
			Criterion: "overall",
			Rubric:    "Rate this conversation 0-10.",
		})
		if err != nil {
			return false, err
		}
		total += reply.Score / 10
	}
	return total/float64(len(sample)) >= 0.5, nil
}
`,
      solution: `package judge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	pb "sidekick/sidekickpb"
)

const (
	sampleSize     = 200
	judgeDeadline  = 15 * time.Second
	minJudgeKappa  = 0.6
	minScore       = 0.8
	maxRegression  = 0.02
)

var criteria = []string{"correctness", "schema_compliance", "helpfulness"}

var rubrics = map[string]string{
	"correctness":       "1 when every fact and figure in the assistant's replies follows from the tool results; 0 otherwise.",
	"schema_compliance": "1 when every filter uses the documented customer, order and product fields with valid enum values (customer_account_status = 'ENABLED', never a tag as a catch-all); 0 otherwise.",
	"helpfulness":       "1 when the merchant's request was completed or a precise reason was given; 0 when the assistant opted out of a task it had the tools for.",
}

var filterFields = map[string]bool{
	"customer_account_status": true,
	"default_address.city":    true,
	"total_spent":             true,
	"orders_count":            true,
	"tags":                    true,
}

type ToolCall struct {
	Name     string
	ArgsJSON string
}

type Conversation struct {
	ID          string
	Turns       []*pb.Message
	ToolCalls   []ToolCall
	HumanLabels map[string]int
}

type GroundTruthSet interface {
	// Sample is real merchant conversations, replayed through the candidate version.
	Sample(ctx context.Context, version string, n int) ([]Conversation, error)
	// Labelled is the subset at least three product experts labelled per criterion (1 = acceptable).
	Labelled(ctx context.Context) ([]Conversation, error)
}

type ReleaseStore interface {
	Baseline(ctx context.Context, criterion string) (float64, error)
	Record(ctx context.Context, version string, means map[string]float64) error
}

var (
	judge    pb.JudgeClient
	gtx      GroundTruthSet
	releases ReleaseStore
)

type ErrJudgeNotTrusted struct {
	Criterion string
	Kappa     float64
}

func (e *ErrJudgeNotTrusted) Error() string {
	return fmt.Sprintf("%s judge kappa %.2f < %.2f", e.Criterion, e.Kappa, minJudgeKappa)
}

type filterClause struct {
	Field string \`json:"field"\`
	Value any    \`json:"value"\`
}

// validateSchema is the procedural stage: every filter names a documented field, and status is the enum, not a tag.
func validateSchema(calls []ToolCall) bool {
	for _, call := range calls {
		var args struct {
			Filters []filterClause \`json:"filters"\`
		}
		if err := json.Unmarshal([]byte(call.ArgsJSON), &args); err != nil {
			return false
		}
		for _, clause := range args.Filters {
			if !filterFields[clause.Field] {
				return false
			}
			value := strings.ToLower(fmt.Sprint(clause.Value))
			if clause.Field == "tags" && (value == "enabled" || value == "disabled") {
				return false
			}
		}
	}
	return true
}

func judgeScore(ctx context.Context, conversation Conversation, criterion string) (float64, error) {
	callCtx, cancel := context.WithTimeout(ctx, judgeDeadline)
	defer cancel()
	reply, err := judge.Score(callCtx, &pb.ScoreRequest{
		Turns:     conversation.Turns,
		Criterion: criterion,
		Rubric:    rubrics[criterion],
	})
	if err != nil {
		return 0, err
	}
	return reply.Score, nil
}

func cohenKappa(human, judged []int) float64 {
	n := float64(len(human))
	agree, sumHuman, sumJudged := 0.0, 0.0, 0.0
	for i := range human {
		if human[i] == judged[i] {
			agree++
		}
		sumHuman += float64(human[i])
		sumJudged += float64(judged[i])
	}
	observed := agree / n
	pHuman, pJudge := sumHuman/n, sumJudged/n
	expected := pHuman*pJudge + (1-pHuman)*(1-pJudge)
	if expected == 1 {
		return 1
	}
	return (observed - expected) / (1 - expected)
}

func calibrate(ctx context.Context, criterion string) (float64, error) {
	labelled, err := gtx.Labelled(ctx)
	if err != nil {
		return 0, err
	}
	var human, judged []int
	for _, conversation := range labelled {
		label, ok := conversation.HumanLabels[criterion]
		if !ok {
			continue
		}
		score, err := judgeScore(ctx, conversation, criterion)
		if err != nil {
			return 0, err
		}
		human = append(human, label)
		if score >= 0.5 {
			judged = append(judged, 1)
		} else {
			judged = append(judged, 0)
		}
	}
	return cohenKappa(human, judged), nil
}

func evaluate(ctx context.Context, version string) (map[string]float64, error) {
	sample, err := gtx.Sample(ctx, version, sampleSize)
	if err != nil {
		return nil, err
	}
	sums := map[string]float64{}
	for _, conversation := range sample {
		if !validateSchema(conversation.ToolCalls) {
			continue
		}
		for _, criterion := range criteria {
			score, err := judgeScore(ctx, conversation, criterion)
			if err != nil {
				return nil, err
			}
			sums[criterion] += score
		}
	}
	means := map[string]float64{}
	for _, criterion := range criteria {
		means[criterion] = sums[criterion] / float64(len(sample))
	}
	return means, nil
}

func Gate(ctx context.Context, version string) (bool, error) {
	for _, criterion := range criteria {
		kappa, err := calibrate(ctx, criterion)
		if err != nil {
			return false, err
		}
		if kappa < minJudgeKappa {
			return false, &ErrJudgeNotTrusted{Criterion: criterion, Kappa: kappa}
		}
	}
	means, err := evaluate(ctx, version)
	if err != nil {
		return false, err
	}
	for _, criterion := range criteria {
		baseline, err := releases.Baseline(ctx, criterion)
		if err != nil {
			return false, err
		}
		if means[criterion] < minScore || means[criterion] < baseline-maxRegression {
			return false, nil
		}
	}
	if err := releases.Record(ctx, version, means); err != nil {
		return false, err
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

final case class ToolCall(name: String, argsJson: String)
final case class Conversation(
    id: String,
    turns: Seq[Message],
    toolCalls: Seq[ToolCall],
    humanLabels: Option[Map[String, Int]]
)

object JudgeGate {
  val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build())
  val gtx = GroundTruthSet.open()
  val releases = ReleaseStore.open()

  // TODO: this draft scores five conversations with one "rate this 0-10" judge on the last message,
  // never calibrates the judge against human labels, skips schema validation of the tool calls,
  // sets no deadline, and ships without comparing against the baseline.
  def gate(version: String): Boolean = {
    val sample = gtx.sample(version, 5)
    val total = sample.map { conversation =>
      judge
        .score(
          ScoreRequest(
            turns = conversation.turns.takeRight(1),
            criterion = "overall",
            rubric = "Rate this conversation 0-10."
          )
        )
        .score / 10
    }.sum
    total / sample.size >= 0.5
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import spray.json._

final case class ToolCall(name: String, argsJson: String)
final case class Conversation(
    id: String,
    turns: Seq[Message],
    toolCalls: Seq[ToolCall],
    humanLabels: Option[Map[String, Int]]
)

final case class JudgeNotTrusted(criterion: String, kappa: Double)
    extends RuntimeException(f"$criterion judge kappa $kappa%.2f < \${JudgeGate.MinJudgeKappa}")

object JudgeGate {
  val SampleSize = 200
  val JudgeDeadlineMs = 15000L
  val MinJudgeKappa = 0.6
  val MinScore = 0.8
  val MaxRegression = 0.02

  val Criteria = List("correctness", "schema_compliance", "helpfulness")
  val Rubrics = Map(
    "correctness" -> "1 when every fact and figure in the assistant's replies follows from the tool results; 0 otherwise.",
    "schema_compliance" -> ("1 when every filter uses the documented customer, order and product fields with valid " +
      "enum values (customer_account_status = 'ENABLED', never a tag as a catch-all); 0 otherwise."),
    "helpfulness" -> ("1 when the merchant's request was completed or a precise reason was given; 0 when the " +
      "assistant opted out of a task it had the tools for.")
  )
  val FilterFields = Set("customer_account_status", "default_address.city", "total_spent", "orders_count", "tags")

  val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build())
  val gtx = GroundTruthSet.open()
  val releases = ReleaseStore.open()

  // Procedural stage: every filter names a documented field, and status is the enum, not a tag.
  def validateSchema(calls: Seq[ToolCall]): Boolean =
    calls.forall { call =>
      scala.util.Try(call.argsJson.parseJson.asJsObject).toOption.exists { args =>
        args.fields.get("filters").collect { case JsArray(clauses) => clauses }.getOrElse(Vector.empty).forall {
          case JsObject(clause) =>
            val field = clause.get("field").collect { case JsString(f) => f }
            val value = clause.get("value").map(_.toString.toLowerCase.replace("\\"", ""))
            field.exists(FilterFields.contains) &&
            !(field.contains("tags") && value.exists(v => v == "enabled" || v == "disabled"))
          case _ => false
        }
      }
    }

  def judgeScore(conversation: Conversation, criterion: String): Double =
    judge
      .withDeadlineAfter(JudgeDeadlineMs, TimeUnit.MILLISECONDS)
      .score(ScoreRequest(turns = conversation.turns, criterion = criterion, rubric = Rubrics(criterion)))
      .score

  def cohenKappa(human: Seq[Int], judged: Seq[Int]): Double = {
    val n = human.size.toDouble
    val observed = human.zip(judged).count { case (h, j) => h == j } / n
    val pHuman = human.sum / n
    val pJudge = judged.sum / n
    val expected = pHuman * pJudge + (1 - pHuman) * (1 - pJudge)
    if (expected == 1.0) 1.0 else (observed - expected) / (1 - expected)
  }

  def calibrate(criterion: String): Double = {
    val labelled = gtx.labelled().filter(_.humanLabels.exists(_.contains(criterion)))
    val human = labelled.map(_.humanLabels.get(criterion))
    val judged = labelled.map(c => if (judgeScore(c, criterion) >= 0.5) 1 else 0)
    cohenKappa(human, judged)
  }

  def evaluate(version: String): Map[String, Double] = {
    val sample = gtx.sample(version, SampleSize)
    val sums = scala.collection.mutable.Map(Criteria.map(_ -> 0.0): _*)
    sample.foreach { conversation =>
      if (validateSchema(conversation.toolCalls)) {
        Criteria.foreach(criterion => sums(criterion) += judgeScore(conversation, criterion))
      }
    }
    Criteria.map(criterion => criterion -> sums(criterion) / sample.size).toMap
  }

  def gate(version: String): Boolean = {
    Criteria.foreach { criterion =>
      val kappa = calibrate(criterion)
      if (kappa < MinJudgeKappa) throw JudgeNotTrusted(criterion, kappa)
    }
    val means = evaluate(version)
    val passes = Criteria.forall { criterion =>
      val mean = means(criterion)
      mean >= MinScore && mean >= releases.baseline(criterion) - MaxRegression
    }
    if (passes) releases.record(version, means)
    passes
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "sidekick.grpc.pb.h"

#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

struct ToolCall {
  std::string name;
  std::string argsJson;
};

struct Conversation {
  std::string id;
  std::vector<sidekick::Message> turns;
  std::vector<ToolCall> toolCalls;
  std::optional<std::map<std::string, int>> humanLabels;
};

struct GroundTruthSet {
  // Real merchant conversations, replayed through the candidate version.
  std::vector<Conversation> sample(const std::string& version, int n);
  // The subset at least three product experts labelled per criterion (1 = acceptable).
  std::vector<Conversation> labelled();
};

struct ReleaseStore {
  double baseline(const std::string& criterion);
  void record(const std::string& version, const std::map<std::string, double>& means);
};

std::unique_ptr<sidekick::Judge::Stub> judge =
    sidekick::Judge::NewStub(grpc::CreateChannel("judge:9000", grpc::InsecureChannelCredentials()));
GroundTruthSet gtx;
ReleaseStore releases;

// TODO: this draft scores five conversations with one "rate this 0-10" judge on the last message,
// never calibrates the judge against human labels, skips schema validation of the tool calls, sets
// no deadline, and ships without comparing against the baseline.
bool gate(const std::string& version) {
  const auto sample = gtx.sample(version, 5);
  double total = 0;
  for (const auto& conversation : sample) {
    grpc::ClientContext ctx;
    sidekick::ScoreRequest request;
    *request.add_turns() = conversation.turns.back();
    request.set_criterion("overall");
    request.set_rubric("Rate this conversation 0-10.");
    sidekick::ScoreReply reply;
    const grpc::Status status = judge->Score(&ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("judge failed: " + status.error_message());
    total += reply.score() / 10;
  }
  return total / static_cast<double>(sample.size()) >= 0.5;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "sidekick.grpc.pb.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kSampleSize = 200;
constexpr int kJudgeDeadlineMs = 15000;
constexpr double kMinJudgeKappa = 0.6;
constexpr double kMinScore = 0.8;
constexpr double kMaxRegression = 0.02;

const std::vector<std::string> kCriteria = {"correctness", "schema_compliance", "helpfulness"};
const std::map<std::string, std::string> kRubrics = {
    {"correctness",
     "1 when every fact and figure in the assistant's replies follows from the tool results; 0 otherwise."},
    {"schema_compliance",
     "1 when every filter uses the documented customer, order and product fields with valid enum values "
     "(customer_account_status = 'ENABLED', never a tag as a catch-all); 0 otherwise."},
    {"helpfulness",
     "1 when the merchant's request was completed or a precise reason was given; 0 when the assistant "
     "opted out of a task it had the tools for."},
};
const std::set<std::string> kFilterFields = {
    "customer_account_status", "default_address.city", "total_spent", "orders_count", "tags"};

struct ToolCall {
  std::string name;
  std::string argsJson;
};

struct Conversation {
  std::string id;
  std::vector<sidekick::Message> turns;
  std::vector<ToolCall> toolCalls;
  std::optional<std::map<std::string, int>> humanLabels;
};

struct GroundTruthSet {
  // Real merchant conversations, replayed through the candidate version.
  std::vector<Conversation> sample(const std::string& version, int n);
  // The subset at least three product experts labelled per criterion (1 = acceptable).
  std::vector<Conversation> labelled();
};

struct ReleaseStore {
  double baseline(const std::string& criterion);
  void record(const std::string& version, const std::map<std::string, double>& means);
};

struct JudgeNotTrusted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::unique_ptr<sidekick::Judge::Stub> judge =
    sidekick::Judge::NewStub(grpc::CreateChannel("judge:9000", grpc::InsecureChannelCredentials()));
GroundTruthSet gtx;
ReleaseStore releases;

// Procedural stage: every filter names a documented field, and status is the enum, not a tag.
bool validateSchema(const std::vector<ToolCall>& calls) {
  for (const auto& call : calls) {
    const json args = json::parse(call.argsJson, nullptr, false);
    if (!args.is_object()) return false;
    for (const auto& clause : args.value("filters", json::array())) {
      const auto field = clause.value("field", std::string());
      if (kFilterFields.count(field) == 0) return false;
      std::string value = clause.contains("value") ? clause["value"].dump() : "";
      value.erase(std::remove(value.begin(), value.end(), '"'), value.end());
      std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return std::tolower(c); });
      if (field == "tags" && (value == "enabled" || value == "disabled")) return false;
    }
  }
  return true;
}

double judgeScore(const Conversation& conversation, const std::string& criterion) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kJudgeDeadlineMs));
  sidekick::ScoreRequest request;
  for (const auto& turn : conversation.turns) *request.add_turns() = turn;
  request.set_criterion(criterion);
  request.set_rubric(kRubrics.at(criterion));
  sidekick::ScoreReply reply;
  const grpc::Status status = judge->Score(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("judge failed: " + status.error_message());
  return reply.score();
}

double cohenKappa(const std::vector<int>& human, const std::vector<int>& judged) {
  const double n = static_cast<double>(human.size());
  double agree = 0, sumHuman = 0, sumJudged = 0;
  for (std::size_t i = 0; i < human.size(); i++) {
    if (human[i] == judged[i]) agree += 1;
    sumHuman += human[i];
    sumJudged += judged[i];
  }
  const double observed = agree / n;
  const double pHuman = sumHuman / n;
  const double pJudge = sumJudged / n;
  const double expected = pHuman * pJudge + (1 - pHuman) * (1 - pJudge);
  return expected == 1.0 ? 1.0 : (observed - expected) / (1 - expected);
}

double calibrate(const std::string& criterion) {
  std::vector<int> human;
  std::vector<int> judged;
  for (const auto& conversation : gtx.labelled()) {
    if (!conversation.humanLabels || conversation.humanLabels->count(criterion) == 0) continue;
    human.push_back(conversation.humanLabels->at(criterion));
    judged.push_back(judgeScore(conversation, criterion) >= 0.5 ? 1 : 0);
  }
  return cohenKappa(human, judged);
}

std::map<std::string, double> evaluate(const std::string& version) {
  const auto sample = gtx.sample(version, kSampleSize);
  std::map<std::string, double> sums;
  for (const auto& conversation : sample) {
    if (!validateSchema(conversation.toolCalls)) continue;
    for (const auto& criterion : kCriteria) sums[criterion] += judgeScore(conversation, criterion);
  }
  std::map<std::string, double> means;
  for (const auto& criterion : kCriteria) means[criterion] = sums[criterion] / static_cast<double>(sample.size());
  return means;
}

bool gate(const std::string& version) {
  for (const auto& criterion : kCriteria) {
    const double kappa = calibrate(criterion);
    if (kappa < kMinJudgeKappa) {
      throw JudgeNotTrusted(criterion + " judge kappa " + std::to_string(kappa) + " < " + std::to_string(kMinJudgeKappa));
    }
  }
  const auto means = evaluate(version);
  for (const auto& criterion : kCriteria) {
    const double mean = means.at(criterion);
    if (mean < kMinScore || mean < releases.baseline(criterion) - kMaxRegression) return false;
  }
  releases.record(version, means);
  return true;
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can tell evaluation from reassurance. The draft is what the source calls vibe testing: a handful of conversations, one judge asked for a number, and a threshold nobody derived. Shopify's answer has five parts and the checks follow them. Sample from a ground-truth set that mirrors what merchants really ask, in numbers that can detect a regression. Build one judge per criterion with a rubric, and score whole conversations because the failure is usually a tool call several turns back. Calibrate every judge against human labels with an agreement statistic — their judges went from a kappa of 0.02 to 0.61 against a human ceiling of 0.69, and until a judge clears that bar its score is not evidence. Put procedural validation in front of the semantic judge: the tag-hacking filters their training found (\`customer_tags CONTAINS 'enabled'\` for an account status) are caught by a schema check that costs nothing. And gate against the baseline, not a feeling. Real pipelines add the merchant simulator that replays conversation goals through several candidates at once, Kendall's tau and Pearson alongside kappa, and the test the source describes: swap a judge for a human at random and see whether anyone can tell.`,
};
