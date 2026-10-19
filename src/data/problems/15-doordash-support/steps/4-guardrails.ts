import type {Step} from '@/lib/types';

// ---- 4. The guardrail: two tiers between the model and the Dasher ---------------------------------
export const guardrailsStep: Step = {
  id: 'guardrails',
  title: 'Guard every answer: cheap checks first, a judge second, a person last',
  concept: 'grpc',
  file: 'guardrail',
  focus: ['judge'],
  task: `## Task

\`generate\` (previous step) returns whatever the model said. Nothing the model says reaches a Dasher
until the guardrail has passed it. The checks serve the LLM judge as a deterministic stand-in at
\`config.JUDGE\` (\`support.proto\`):

\`\`\`proto
service Judge { rpc Evaluate(EvaluateRequest) returns (Scores); }
message EvaluateRequest { string question = 1; string answer = 2; repeated string context_ids = 3; }
message Scores          { float groundedness = 1; float coherence = 2; float compliance = 3; bool pass = 4; }
\`\`\`

Implement \`check(question, answer, chunks)\` → \`{ok, groundedness, reasons}\` in two tiers:

- **Tier 1 — no RPC.** Every chunk the answer cites (\`assistant.prompt.cited_ids\` / \`citedIds\`)
  must be one of the retrieved \`chunks\`; and every sentence of the answer — split on \`.\`, \`!\`, \`?\`,
  the leading \`Based on [kb:…]:\` prefix belongs to the first sentence — must have
  \`embed.cosine\` ≥ \`config.MIN_SIMILARITY\` with at least one chunk's text. A failure returns
  \`ok=False\` with one reason per problem (name the stray id) and **does not call the judge**.
- **Tier 2 — the judge.** \`Judge.Evaluate(question, answer, context_ids=[the chunk ids])\` on
  \`config.JUDGE\` with a deadline of \`config.DEADLINE_S\`. \`ok = scores.pass\`, \`groundedness\` is the
  judge's score. A judge that cannot be reached (\`UNAVAILABLE\`, a deadline) is **not** a pass:
  no verdict is a failed verdict.

Implement \`answer_or_escalate(question, chunks, history)\` / \`answerOrEscalate\` →
\`{answer, sources, escalated, model, tokens}\`:

- \`generate.generate(question, chunks, history)\`, then \`check\`. A failed check earns the model
  **one** more generation and one more check.
- Still failing → \`{answer: config.HANDOFF_TEXT, sources: [], escalated: True, model, tokens: 0}\`.
  The rejected text never leaves this function — not in the answer, not in the sources.
- A pass → the answer, \`sources\` = the chunk ids it cites, in order, \`escalated: False\`, the model
  and token count \`generate\` reported.

:::widget status-codes {}

> DoorDash's two-layer guardrail cut hallucinations by 90% and compliance failures by 99%. The
> cheap layer catches most of it for free; the judge catches what rules cannot; the hand-off to a
> person is the floor under both.`,
  sequence: {
    participants: ['assistant', 'llm-large', 'judge', 'dasher'],
    messages: [
      {from: 'assistant', to: 'llm-large', label: 'Generate(prompt with [kb:pay-0] [kb:pay-1] …)', kind: 'sync'},
      {from: 'llm-large', to: 'assistant', label: '"… guaranteed [kb:policy-404]."', kind: 'reply'},
      {
        from: 'assistant',
        to: 'assistant',
        label: 'tier 1: policy-404 not retrieved · sentence cosine 0.08 < 0.3 → fail, no judge',
        kind: 'sync',
      },
      {from: 'assistant', to: 'llm-large', label: 'Generate(same prompt) · second and last try', kind: 'sync'},
      {
        from: 'llm-large',
        to: 'assistant',
        label: '"Based on [kb:pay-0][kb:pay-1]: Dasher earnings … Monday …"',
        kind: 'reply',
      },
      {from: 'assistant', to: 'assistant', label: 'tier 1: cites retrieved chunks · cosine 0.58 ≥ 0.3', kind: 'sync'},
      {
        from: 'assistant',
        to: 'judge',
        label: 'Evaluate(question, answer, context_ids [pay-0, pay-1, tips-0, referrals-1]) · deadline 2 s',
        kind: 'sync',
      },
      {from: 'judge', to: 'assistant', label: 'Scores{groundedness 1.0, compliance 1.0, pass true}', kind: 'reply'},
      {
        from: 'assistant',
        to: 'dasher',
        label: '{answer, sources [pay-0, pay-1], escalated false, model large}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Tier 1 is pure functions over strings: `cited_ids(answer)` against the set of chunk ids, then `embed.embed` of each sentence against `embed.embed` of each chunk text with `cosine`. Embed the chunks once, not once per sentence. Return the reasons as soon as there are any — the judge must not be called.',
    'Tier 2 is one unary call: `EvaluateRequest(question, answer, context_ids=[c["id"] for c in chunks])` with `timeout=DEADLINE_S` (`{deadline: Date.now() + DEADLINE_S * 1000}`). `pass` is a Python keyword: `getattr(scores, "pass")`. Wrap the call: an `RpcError` becomes `{ok: False, reasons: ["judge UNAVAILABLE"]}`, never an exception and never a pass.',
    '`answer_or_escalate` is a `for attempt in range(2)` around generate → check: return on the first pass with `cited_ids(answer)` as sources; after the loop, return the handoff with the last `model` and empty sources — the rejected answer is a local variable that never escapes.',
  ],
  checks: [
    {
      id: 'cited-chunks-only',
      title: 'Rejects a citation outside the retrieved chunks without asking the judge',
      detail:
        'An answer that cites `[kb:policy-404]` when only `pay-0`, `pay-1`, `tips-0` and `referrals-1` were retrieved fails tier 1: `ok` is false, a reason names the stray id, and `Judge.Evaluate` is never called.',
      match: {
        python: {all: [/cited_ids\(/, /"ok":\s*False/]},
        typescript: {all: [/citedIds\(/, /ok:\s*false/]},
        go: {all: [/prompt\.CitedIds\(/, /OK:\s*false/]},
        scala: {all: [/Prompt\.citedIds\(/, /ok = false/]},
        cpp: {all: [/assistant::cited_ids\(/, /Verdict\{false/]},
      },
    },
    {
      id: 'sentence-similarity',
      title: 'Rejects a sentence unlike every retrieved chunk',
      detail:
        'Every sentence must reach `MIN_SIMILARITY` (0.3) cosine with some chunk. A grounded answer with one invented sentence appended fails tier 1 with a reason, and the judge is not called.',
      match: {
        python: {all: [/embed\.cosine\(|\bcosine\(/, /MIN_SIMILARITY/]},
        typescript: {all: [/\bcosine\(/, /MIN_SIMILARITY/]},
        go: {all: [/embed\.Cosine\(/, /config\.MinSimilarity/]},
        scala: {all: [/Embed\.cosine\(/, /Config\.MinSimilarity/]},
        cpp: {all: [/assistant::cosine\(/, /config::kMinSimilarity/]},
      },
    },
    {
      id: 'judge-verdict',
      title: 'Passes a grounded answer through one Evaluate call with the chunk ids as context',
      detail:
        "The faithful answer clears tier 1 and goes to `Judge.Evaluate` exactly once, with the question, the answer and `context_ids` = the retrieved chunk ids, under a `DEADLINE_S` deadline; `ok` is the judge's `pass`, `groundedness` its score.",
      match: {
        python: {
          all: [/\.Evaluate\(/, /context_ids\s*=/, /timeout\s*=\s*(config\.)?DEADLINE_S/, /getattr\(\w+,\s*"pass"\)/],
        },
        typescript: {all: [/\.Evaluate\(/, /context_ids/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_S/, /\.pass\b/]},
        go: {all: [/\.Evaluate\(/, /ContextIds:/, /context\.WithTimeout\(/, /\.GetPass\(\)/]},
        scala: {all: [/\.evaluate\(/, /contextIds\s*=/, /withDeadlineAfter\(/, /\.pass\b/]},
        cpp: {all: [/->Evaluate\(/, /add_context_ids\(/, /set_deadline\(/, /\.pass\(\)/]},
      },
    },
    {
      id: 'judge-fails-closed',
      title: 'A judge that says no, or cannot be reached, fails the check',
      detail:
        'An answer that clears tier 1 but promises an outcome ("which we guarantee") is failed by the judge\'s compliance score: `ok` false, `groundedness` 1.0. With the judge down, `check` returns `ok` false instead of raising or passing: an unjudged answer is a failed answer.',
      match: {
        python: {all: [/except grpc\.RpcError/], order: [/cosine\(/, /\.Evaluate\(/]},
        typescript: {all: [/catch/, /ServiceError|\.code\b/], order: [/cosine\(/, /\.Evaluate\(/]},
        go: {all: [/err != nil/], order: [/embed\.Cosine\(/, /\.Evaluate\(/]},
        scala: {all: [/StatusRuntimeException/], order: [/Embed\.cosine\(/, /\.evaluate\(/]},
        cpp: {all: [/status\.ok\(\)/], order: [/assistant::cosine\(/, /->Evaluate\(/]},
      },
    },
    {
      id: 'escalate-after-retry',
      title: 'Generates once more after a failed check, then hands off',
      detail:
        'With a model that invents a policy, `answer_or_escalate` calls `Generate` exactly twice, never the judge, and returns `HANDOFF_TEXT` with `escalated: true`, empty `sources` and none of the invented text. With a faithful model: one `Generate`, one `Evaluate`, the answer with its cited ids as `sources`. With the judge down the answer is escalated, not let through.',
      match: {
        python: {all: [/HANDOFF_TEXT/, /"escalated":\s*True/, /for \w+ in range\(\s*2\s*\)/], none: [/while True/]},
        typescript: {
          all: [/HANDOFF_TEXT/, /escalated:\s*true/, /for \(let \w+ = 0; \w+ < 2; (\+\+\w+|\w+\+\+)\)/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/config\.HandoffText/, /Escalated:\s*true/, /for \w+ := 0; \w+ < 2; \w+\+\+/], none: [/for \{/]},
        scala: {all: [/Config\.HandoffText/, /escalated = true/, /\w+ < 2\b/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {
          all: [/config::kHandoffText/, /\{\},\s*true,/, /for \(int \w+ = 0; \w+ < 2; (\+\+\w+|\w+\+\+)\)/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import re

import grpc

import generate
import support_pb2
import support_pb2_grpc
from assistant import config, embed
from assistant.prompt import cited_ids

# A sentence ends at . ! or ? — a "Based on [kb:…]:" prefix has no terminator, so it stays in the first one.
_SENTENCE_END = re.compile(r"[.!?]")

judge = support_pb2_grpc.JudgeStub(grpc.aio.insecure_channel(config.JUDGE))


def sentences(text: str) -> list[str]:
    """The answer split on . ! ? — the pieces tier 1 compares with the chunks."""
    return [s.strip() for s in _SENTENCE_END.split(text) if s.strip()]


def tier1(answer: str, chunks: list[dict]) -> list[str]:
    """Why the answer fails the cheap checks (empty when it passes): a citation outside the chunks, a sentence unlike all of them."""
    # TODO: every id in cited_ids(answer) must be a chunk id — a reason naming the stray id otherwise
    # TODO: every sentence must have cosine >= config.MIN_SIMILARITY with at least one chunk's text
    raise NotImplementedError


async def check(question: str, answer: str, chunks: list[dict]) -> dict:
    """Tier 1 without an RPC, then the judge: {ok, groundedness, reasons}."""
    # TODO: tier1 reasons → {"ok": False, "groundedness": 0.0, "reasons": reasons} without calling the judge
    # TODO: EvaluateRequest(question, answer, context_ids = the chunk ids) on the judge with a deadline of config.DEADLINE_S
    # TODO: ok = the judge's pass (a keyword: getattr(scores, "pass")); a gRPC error is a failed check, not an exception
    raise NotImplementedError


async def answer_or_escalate(question: str, chunks: list[dict], history: list[dict] | None = None) -> dict:
    """The answer the Dasher may see: {answer, sources, escalated, model, tokens}. A rejected answer never leaves here."""
    # TODO: generate.generate → check; one more generation on failure; then the handoff
    # TODO: pass → sources = cited_ids(answer), escalated False; handoff → config.HANDOFF_TEXT, no sources, escalated True, tokens 0
    raise NotImplementedError
`,
      solution: `import re

import grpc

import generate
import support_pb2
import support_pb2_grpc
from assistant import config, embed
from assistant.prompt import cited_ids

# A sentence ends at . ! or ? — a "Based on [kb:…]:" prefix has no terminator, so it stays in the first one.
_SENTENCE_END = re.compile(r"[.!?]")

judge = support_pb2_grpc.JudgeStub(grpc.aio.insecure_channel(config.JUDGE))


def sentences(text: str) -> list[str]:
    """The answer split on . ! ? — the pieces tier 1 compares with the chunks."""
    return [s.strip() for s in _SENTENCE_END.split(text) if s.strip()]


def tier1(answer: str, chunks: list[dict]) -> list[str]:
    """Why the answer fails the cheap checks (empty when it passes): a citation outside the chunks, a sentence unlike all of them."""
    ids = {c["id"] for c in chunks}
    reasons = [f"cites [kb:{cid}], which was not retrieved" for cid in cited_ids(answer) if cid not in ids]
    vectors = [embed.embed(c["text"]) for c in chunks]
    for sentence in sentences(answer):
        best = max((embed.cosine(embed.embed(sentence), v) for v in vectors), default=0.0)
        if best < config.MIN_SIMILARITY:
            reasons.append(f"sentence unlike any retrieved chunk (cosine {best:.2f} < {config.MIN_SIMILARITY}): {sentence!r}")
    return reasons


async def check(question: str, answer: str, chunks: list[dict]) -> dict:
    """Tier 1 without an RPC, then the judge: {ok, groundedness, reasons}."""
    reasons = tier1(answer, chunks)
    if reasons:
        return {"ok": False, "groundedness": 0.0, "reasons": reasons}
    request = support_pb2.EvaluateRequest(question=question, answer=answer, context_ids=[c["id"] for c in chunks])
    try:
        scores = await judge.Evaluate(request, timeout=config.DEADLINE_S)
    except grpc.RpcError as e:
        # No verdict is a failed verdict: an answer nobody judged does not reach the Dasher.
        return {"ok": False, "groundedness": 0.0, "reasons": [f"judge {e.code().name}"]}
    ok = getattr(scores, "pass")
    reasons = [] if ok else [
        f"judge: groundedness {scores.groundedness:.2f}, coherence {scores.coherence:.2f}, compliance {scores.compliance:.2f}"
    ]
    return {"ok": ok, "groundedness": scores.groundedness, "reasons": reasons}


async def answer_or_escalate(question: str, chunks: list[dict], history: list[dict] | None = None) -> dict:
    """The answer the Dasher may see: {answer, sources, escalated, model, tokens}. A rejected answer never leaves here."""
    for attempt in range(2):
        result = await generate.generate(question, chunks, history)
        verdict = await check(question, result["answer"], chunks)
        if verdict["ok"]:
            return {
                "answer": result["answer"],
                "sources": cited_ids(result["answer"]),
                "escalated": False,
                "model": result["model"],
                "tokens": result["tokens"],
            }
    return {"answer": config.HANDOFF_TEXT, "sources": [], "escalated": True, "model": result["model"], "tokens": 0}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {DEADLINE_S, HANDOFF_TEXT, JUDGE, MIN_SIMILARITY} from 'assistant/config';
import {cosine, embed} from 'assistant/embed';
import {citedIds} from 'assistant/prompt';
import type {Chunk, Turn} from 'assistant/prompt';
import {generate} from './generate';

interface Scores {
  groundedness: number;
  coherence: number;
  compliance: number;
  pass: boolean;
}
interface JudgeClient {
  Evaluate(request: {question: string; answer: string; context_ids: string[]}, options: {deadline: number}): Promise<Scores>;
}

const {support} = grpc.loadPackageDefinition(protoLoader.loadSync('support.proto')) as unknown as {
  support: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const judge = new support.Judge(JUDGE, grpc.credentials.createInsecure());

export interface Verdict {
  ok: boolean;
  groundedness: number;
  reasons: string[];
}

/** What the Dasher may see: the answer or the handoff. */
export interface Outcome {
  answer: string;
  sources: string[];
  escalated: boolean;
  model: string;
  tokens: number;
}

/** The answer split on . ! ? — the pieces tier 1 compares with the chunks; a "Based on [kb:…]:" prefix stays in the first one. */
export const sentences = (text: string): string[] =>
  text
    .split(/[.!?]/)
    .map(s => s.trim())
    .filter(s => s !== '');

/** Why the answer fails the cheap checks (empty when it passes): a citation outside the chunks, a sentence unlike all of them. */
export function tier1(answer: string, chunks: Chunk[]): string[] {
  // TODO: every id in citedIds(answer) must be a chunk id — a reason naming the stray id otherwise
  // TODO: every sentence must have cosine >= MIN_SIMILARITY with at least one chunk's text
  throw new Error('not implemented');
}

/** Tier 1 without an RPC, then the judge. */
export async function check(question: string, answer: string, chunks: Chunk[]): Promise<Verdict> {
  // TODO: tier1 reasons → {ok: false, groundedness: 0, reasons} without calling the judge
  // TODO: {question, answer, context_ids: the chunk ids} to the judge with a deadline of DEADLINE_S from now
  // TODO: ok = the judge's pass; a gRPC error is a failed check, not an exception
  throw new Error('not implemented');
}

/** The answer the Dasher may see. A rejected answer never leaves here. */
export async function answerOrEscalate(question: string, chunks: Chunk[], history: Turn[] = []): Promise<Outcome> {
  // TODO: generate → check; one more generation on failure; then the handoff
  // TODO: pass → sources = citedIds(answer), escalated false; handoff → HANDOFF_TEXT, no sources, escalated true, tokens 0
  throw new Error('not implemented');
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {DEADLINE_S, HANDOFF_TEXT, JUDGE, MIN_SIMILARITY} from 'assistant/config';
import {cosine, embed} from 'assistant/embed';
import {citedIds} from 'assistant/prompt';
import type {Chunk, Turn} from 'assistant/prompt';
import {generate} from './generate';

interface Scores {
  groundedness: number;
  coherence: number;
  compliance: number;
  pass: boolean;
}
interface JudgeClient {
  Evaluate(request: {question: string; answer: string; context_ids: string[]}, options: {deadline: number}): Promise<Scores>;
}

const {support} = grpc.loadPackageDefinition(protoLoader.loadSync('support.proto')) as unknown as {
  support: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const judge = new support.Judge(JUDGE, grpc.credentials.createInsecure());

export interface Verdict {
  ok: boolean;
  groundedness: number;
  reasons: string[];
}

/** What the Dasher may see: the answer or the handoff. */
export interface Outcome {
  answer: string;
  sources: string[];
  escalated: boolean;
  model: string;
  tokens: number;
}

/** The answer split on . ! ? — the pieces tier 1 compares with the chunks; a "Based on [kb:…]:" prefix stays in the first one. */
export const sentences = (text: string): string[] =>
  text
    .split(/[.!?]/)
    .map(s => s.trim())
    .filter(s => s !== '');

/** Why the answer fails the cheap checks (empty when it passes): a citation outside the chunks, a sentence unlike all of them. */
export function tier1(answer: string, chunks: Chunk[]): string[] {
  const ids = new Set(chunks.map(c => c.id));
  const reasons = citedIds(answer)
    .filter(id => !ids.has(id))
    .map(id => \`cites [kb:\${id}], which was not retrieved\`);
  const vectors = chunks.map(c => embed(c.text));
  for (const sentence of sentences(answer)) {
    const v = embed(sentence);
    const best = vectors.reduce((m, w) => Math.max(m, cosine(v, w)), 0);
    if (best < MIN_SIMILARITY)
      reasons.push(\`sentence unlike any retrieved chunk (cosine \${best.toFixed(2)} < \${MIN_SIMILARITY}): \${JSON.stringify(sentence)}\`);
  }
  return reasons;
}

/** Tier 1 without an RPC, then the judge. */
export async function check(question: string, answer: string, chunks: Chunk[]): Promise<Verdict> {
  const reasons = tier1(answer, chunks);
  if (reasons.length > 0) return {ok: false, groundedness: 0, reasons};
  let scores: Scores;
  try {
    scores = await judge.Evaluate(
      {question, answer, context_ids: chunks.map(c => c.id)},
      {deadline: Date.now() + DEADLINE_S * 1000},
    );
  } catch (e) {
    // No verdict is a failed verdict: an answer nobody judged does not reach the Dasher.
    const code = (e as grpc.ServiceError).code;
    return {ok: false, groundedness: 0, reasons: [\`judge \${grpc.status[code] ?? code}\`]};
  }
  return {
    ok: scores.pass,
    groundedness: scores.groundedness,
    reasons: scores.pass
      ? []
      : [\`judge: groundedness \${scores.groundedness.toFixed(2)}, coherence \${scores.coherence.toFixed(2)}, compliance \${scores.compliance.toFixed(2)}\`],
  };
}

/** The answer the Dasher may see. A rejected answer never leaves here. */
export async function answerOrEscalate(question: string, chunks: Chunk[], history: Turn[] = []): Promise<Outcome> {
  let model = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await generate(question, chunks, history);
    model = result.model;
    const verdict = await check(question, result.answer, chunks);
    if (verdict.ok) return {answer: result.answer, sources: citedIds(result.answer), escalated: false, model, tokens: result.tokens};
  }
  return {answer: HANDOFF_TEXT, sources: [], escalated: true, model, tokens: 0};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"assistant/config" // config.Judge, config.DeadlineS, config.MinSimilarity, config.HandoffText — provided
	"assistant/embed"  // embed.Embed(text) []float64, embed.Cosine(a, b) float64 — provided
	"assistant/prompt" // prompt.CitedIds(answer) []string, prompt.Chunk, prompt.Turn — provided
	pb "assistant/gen/support"
)

// Verdict is what check returns: tier 1's reasons, or the judge's.
type Verdict struct {
	OK           bool
	Groundedness float64
	Reasons      []string
}

// Outcome is what the Dasher may see: the answer or the handoff.
type Outcome struct {
	Answer    string
	Sources   []string
	Escalated bool
	Model     string
	Tokens    int32
}

var judgeConn, _ = grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
var judge = pb.NewJudgeClient(judgeConn)

// sentences splits the answer on . ! ? — a "Based on [kb:…]:" prefix has no terminator, so it stays in the first one.
func sentences(text string) []string {
	var out []string
	for _, s := range strings.FieldsFunc(text, func(r rune) bool { return r == '.' || r == '!' || r == '?' }) {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// tier1 returns why the answer fails the cheap checks (nil when it passes).
func tier1(answer string, chunks []prompt.Chunk) []string {
	// TODO: every id in prompt.CitedIds(answer) must be a chunk id — a reason naming the stray id otherwise
	// TODO: every sentence must have embed.Cosine >= config.MinSimilarity with at least one chunk's text
	_ = fmt.Sprintf
	return []string{"not implemented"}
}

// check runs tier 1 without an RPC, then the judge.
func check(ctx context.Context, question, answer string, chunks []prompt.Chunk) Verdict {
	// TODO: tier1 reasons → Verdict{false, 0, reasons} without calling the judge
	// TODO: EvaluateRequest{question, answer, ContextIds: the chunk ids} with a context that expires after config.DeadlineS
	// TODO: OK = the judge's pass; an error is a failed check, not a panic
	_ = time.Second
	return Verdict{Reasons: []string{"not implemented"}}
}

// answerOrEscalate returns the answer the Dasher may see. A rejected answer never leaves here.
func answerOrEscalate(ctx context.Context, question string, chunks []prompt.Chunk, history []prompt.Turn) (Outcome, error) {
	// TODO: generate → check; one more generation on failure; then the handoff
	// TODO: pass → Sources = prompt.CitedIds(answer), Escalated false; handoff → config.HandoffText, no sources, Escalated true
	return Outcome{}, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"assistant/config" // config.Judge, config.DeadlineS, config.MinSimilarity, config.HandoffText — provided
	"assistant/embed"  // embed.Embed(text) []float64, embed.Cosine(a, b) float64 — provided
	"assistant/prompt" // prompt.CitedIds(answer) []string, prompt.Chunk, prompt.Turn — provided
	pb "assistant/gen/support"
)

// Verdict is what check returns: tier 1's reasons, or the judge's.
type Verdict struct {
	OK           bool
	Groundedness float64
	Reasons      []string
}

// Outcome is what the Dasher may see: the answer or the handoff.
type Outcome struct {
	Answer    string
	Sources   []string
	Escalated bool
	Model     string
	Tokens    int32
}

var judgeConn, _ = grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
var judge = pb.NewJudgeClient(judgeConn)

// sentences splits the answer on . ! ? — a "Based on [kb:…]:" prefix has no terminator, so it stays in the first one.
func sentences(text string) []string {
	var out []string
	for _, s := range strings.FieldsFunc(text, func(r rune) bool { return r == '.' || r == '!' || r == '?' }) {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// tier1 returns why the answer fails the cheap checks (nil when it passes).
func tier1(answer string, chunks []prompt.Chunk) []string {
	ids := make(map[string]bool, len(chunks))
	vectors := make([][]float64, 0, len(chunks))
	for _, c := range chunks {
		ids[c.ID] = true
		vectors = append(vectors, embed.Embed(c.Text))
	}
	var reasons []string
	for _, id := range prompt.CitedIds(answer) {
		if !ids[id] {
			reasons = append(reasons, fmt.Sprintf("cites [kb:%s], which was not retrieved", id))
		}
	}
	for _, sentence := range sentences(answer) {
		v := embed.Embed(sentence)
		best := 0.0
		for _, w := range vectors {
			if s := embed.Cosine(v, w); s > best {
				best = s
			}
		}
		if best < config.MinSimilarity {
			reasons = append(reasons, fmt.Sprintf("sentence unlike any retrieved chunk (cosine %.2f < %.2f): %q", best, config.MinSimilarity, sentence))
		}
	}
	return reasons
}

// check runs tier 1 without an RPC, then the judge.
func check(ctx context.Context, question, answer string, chunks []prompt.Chunk) Verdict {
	if reasons := tier1(answer, chunks); len(reasons) > 0 {
		return Verdict{OK: false, Groundedness: 0, Reasons: reasons}
	}
	ids := make([]string, 0, len(chunks))
	for _, c := range chunks {
		ids = append(ids, c.ID)
	}
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(config.DeadlineS*float64(time.Second)))
	defer cancel()
	scores, err := judge.Evaluate(callCtx, &pb.EvaluateRequest{Question: question, Answer: answer, ContextIds: ids})
	if err != nil {
		// No verdict is a failed verdict: an answer nobody judged does not reach the Dasher.
		return Verdict{OK: false, Groundedness: 0, Reasons: []string{"judge " + status.Code(err).String()}}
	}
	v := Verdict{OK: scores.GetPass(), Groundedness: float64(scores.GetGroundedness())}
	if !v.OK {
		v.Reasons = []string{fmt.Sprintf("judge: groundedness %.2f, coherence %.2f, compliance %.2f", scores.GetGroundedness(), scores.GetCoherence(), scores.GetCompliance())}
	}
	return v
}

// answerOrEscalate returns the answer the Dasher may see. A rejected answer never leaves here.
func answerOrEscalate(ctx context.Context, question string, chunks []prompt.Chunk, history []prompt.Turn) (Outcome, error) {
	model := ""
	for attempt := 0; attempt < 2; attempt++ {
		result, err := generate(ctx, question, chunks, history)
		if err != nil {
			return Outcome{}, err
		}
		model = result.Model
		if check(ctx, question, result.Answer, chunks).OK {
			return Outcome{Answer: result.Answer, Sources: prompt.CitedIds(result.Answer), Escalated: false, Model: model, Tokens: result.Tokens}, nil
		}
	}
	return Outcome{Answer: config.HandoffText, Sources: []string{}, Escalated: true, Model: model, Tokens: 0}, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import assistant.{Config, Embed, Prompt} // Config.Judge, DeadlineS, MinSimilarity, HandoffText · Embed.embed, Embed.cosine · Prompt.citedIds, Prompt.Chunk, Prompt.Turn
import support.support.{EvaluateRequest, JudgeGrpc}

/** What check returns: tier 1's reasons, or the judge's. */
final case class Verdict(ok: Boolean, groundedness: Double, reasons: Seq[String])

/** What the Dasher may see: the answer or the handoff. */
final case class Outcome(answer: String, sources: Seq[String], escalated: Boolean, model: String, tokens: Int)

object Guardrail {
  private val channel = ManagedChannelBuilder.forTarget(Config.Judge).usePlaintext().build()
  private val judge = JudgeGrpc.blockingStub(channel)

  /** The answer split on . ! ? — a "Based on [kb:…]:" prefix has no terminator, so it stays in the first one. */
  def sentences(text: String): Seq[String] = text.split("[.!?]").map(_.trim).filter(_.nonEmpty).toSeq

  /** Why the answer fails the cheap checks (empty when it passes). */
  def tier1(answer: String, chunks: Seq[Prompt.Chunk]): Seq[String] = {
    // TODO: every id in Prompt.citedIds(answer) must be a chunk id — a reason naming the stray id otherwise
    // TODO: every sentence must have Embed.cosine >= Config.MinSimilarity with at least one chunk's text
    ???
  }

  /** Tier 1 without an RPC, then the judge. */
  def check(question: String, answer: String, chunks: Seq[Prompt.Chunk]): Verdict = {
    // TODO: tier1 reasons → Verdict(false, 0, reasons) without calling the judge
    // TODO: EvaluateRequest(question, answer, contextIds = the chunk ids) with a deadline of Config.DeadlineS
    // TODO: ok = the judge's pass; a StatusRuntimeException is a failed check, not a throw
    ???
  }

  /** The answer the Dasher may see. A rejected answer never leaves here. */
  def answerOrEscalate(question: String, chunks: Seq[Prompt.Chunk], history: Seq[Prompt.Turn]): Outcome = {
    // TODO: Generate.generate → check; one more generation on failure; then the handoff
    // TODO: pass → sources = Prompt.citedIds(answer), escalated false; handoff → Config.HandoffText, no sources, escalated true
    ???
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import assistant.{Config, Embed, Prompt} // Config.Judge, DeadlineS, MinSimilarity, HandoffText · Embed.embed, Embed.cosine · Prompt.citedIds, Prompt.Chunk, Prompt.Turn
import support.support.{EvaluateRequest, JudgeGrpc}

/** What check returns: tier 1's reasons, or the judge's. */
final case class Verdict(ok: Boolean, groundedness: Double, reasons: Seq[String])

/** What the Dasher may see: the answer or the handoff. */
final case class Outcome(answer: String, sources: Seq[String], escalated: Boolean, model: String, tokens: Int)

object Guardrail {
  private val channel = ManagedChannelBuilder.forTarget(Config.Judge).usePlaintext().build()
  private val judge = JudgeGrpc.blockingStub(channel)

  /** The answer split on . ! ? — a "Based on [kb:…]:" prefix has no terminator, so it stays in the first one. */
  def sentences(text: String): Seq[String] = text.split("[.!?]").map(_.trim).filter(_.nonEmpty).toSeq

  /** Why the answer fails the cheap checks (empty when it passes). */
  def tier1(answer: String, chunks: Seq[Prompt.Chunk]): Seq[String] = {
    val ids = chunks.map(_.id).toSet
    val stray = Prompt.citedIds(answer).filterNot(ids).map(id => s"cites [kb:$id], which was not retrieved")
    val vectors = chunks.map(c => Embed.embed(c.text))
    val unlike = sentences(answer).flatMap { sentence =>
      val v = Embed.embed(sentence)
      val best = vectors.map(w => Embed.cosine(v, w)).foldLeft(0.0)(math.max)
      if (best < Config.MinSimilarity) Some(f"sentence unlike any retrieved chunk (cosine $best%.2f < \${Config.MinSimilarity}): $sentence") else None
    }
    stray ++ unlike
  }

  /** Tier 1 without an RPC, then the judge. */
  def check(question: String, answer: String, chunks: Seq[Prompt.Chunk]): Verdict = {
    val reasons = tier1(answer, chunks)
    if (reasons.nonEmpty) return Verdict(ok = false, groundedness = 0.0, reasons = reasons)
    try {
      val scores = judge
        .withDeadlineAfter((Config.DeadlineS * 1000).toLong, TimeUnit.MILLISECONDS)
        .evaluate(EvaluateRequest(question = question, answer = answer, contextIds = chunks.map(_.id)))
      val why =
        if (scores.pass) Seq.empty
        else Seq(f"judge: groundedness \${scores.groundedness}%.2f, coherence \${scores.coherence}%.2f, compliance \${scores.compliance}%.2f")
      Verdict(ok = scores.pass, groundedness = scores.groundedness, reasons = why)
    } catch {
      // No verdict is a failed verdict: an answer nobody judged does not reach the Dasher.
      case e: StatusRuntimeException => Verdict(ok = false, groundedness = 0.0, reasons = Seq("judge " + e.getStatus.getCode))
    }
  }

  /** The answer the Dasher may see. A rejected answer never leaves here. */
  def answerOrEscalate(question: String, chunks: Seq[Prompt.Chunk], history: Seq[Prompt.Turn]): Outcome = {
    var model = ""
    var attempt = 0
    while (attempt < 2) {
      val result = Generate.generate(question, chunks, history)
      model = result.model
      if (check(question, result.answer, chunks).ok)
        return Outcome(result.answer, Prompt.citedIds(result.answer), escalated = false, model, result.tokens)
      attempt += 1
    }
    Outcome(Config.HandoffText, Seq.empty, escalated = true, model, 0)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "assistant/config.h"  // config::kJudge, config::kDeadline, config::kMinSimilarity, config::kHandoffText
#include "assistant/embed.h"   // assistant::embed(text) -> std::vector<double>; assistant::cosine(a, b)
#include "assistant/prompt.h"  // assistant::cited_ids(answer) -> std::vector<std::string>; assistant::Chunk, assistant::Turn
#include "generate.h"          // Generated generate(question, chunks, history) — the previous step
#include "support.grpc.pb.h"

// What check returns: tier 1's reasons, or the judge's.
struct Verdict {
  bool ok;
  double groundedness;
  std::vector<std::string> reasons;
};

// What the Dasher may see: the answer or the handoff.
struct Outcome {
  std::string answer;
  std::vector<std::string> sources;
  bool escalated;
  std::string model;
  int tokens;
};

auto judge = support::Judge::NewStub(grpc::CreateChannel(config::kJudge, grpc::InsecureChannelCredentials()));

// The answer split on . ! ? — a "Based on [kb:…]:" prefix has no terminator, so it stays in the first one.
std::vector<std::string> sentences(const std::string& text) {
  std::vector<std::string> out;
  std::string current;
  for (const char ch : text) {
    if (ch == '.' || ch == '!' || ch == '?') {
      if (current.find_first_not_of(" \\t\\n") != std::string::npos) out.push_back(current);
      current.clear();
    } else {
      current += ch;
    }
  }
  if (current.find_first_not_of(" \\t\\n") != std::string::npos) out.push_back(current);
  return out;
}

// Why the answer fails the cheap checks (empty when it passes).
std::vector<std::string> tier1(const std::string& answer, const std::vector<assistant::Chunk>& chunks) {
  // TODO: every id in assistant::cited_ids(answer) must be a chunk id — a reason naming the stray id otherwise
  // TODO: every sentence must have assistant::cosine >= config::kMinSimilarity with at least one chunk's text
  return {"not implemented"};
}

// Tier 1 without an RPC, then the judge.
Verdict check(const std::string& question, const std::string& answer, const std::vector<assistant::Chunk>& chunks) {
  // TODO: tier1 reasons → Verdict{false, 0, reasons} without calling the judge
  // TODO: EvaluateRequest with question, answer and add_context_ids for every chunk; a ClientContext deadline of now + config::kDeadline
  // TODO: ok = the judge's pass; a non-ok status is a failed check, not a throw
  return Verdict{false, 0.0, {"not implemented"}};
}

// The answer the Dasher may see. A rejected answer never leaves here.
Outcome answer_or_escalate(const std::string& question, const std::vector<assistant::Chunk>& chunks,
                           const std::vector<assistant::Turn>& history) {
  // TODO: generate → check; one more generation on failure; then the handoff
  // TODO: pass → sources = assistant::cited_ids(answer), escalated false; handoff → config::kHandoffText, no sources, escalated true
  throw std::runtime_error("not implemented");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "assistant/config.h"  // config::kJudge, config::kDeadline, config::kMinSimilarity, config::kHandoffText
#include "assistant/embed.h"   // assistant::embed(text) -> std::vector<double>; assistant::cosine(a, b)
#include "assistant/prompt.h"  // assistant::cited_ids(answer) -> std::vector<std::string>; assistant::Chunk, assistant::Turn
#include "generate.h"          // Generated generate(question, chunks, history) — the previous step
#include "support.grpc.pb.h"

// What check returns: tier 1's reasons, or the judge's.
struct Verdict {
  bool ok;
  double groundedness;
  std::vector<std::string> reasons;
};

// What the Dasher may see: the answer or the handoff.
struct Outcome {
  std::string answer;
  std::vector<std::string> sources;
  bool escalated;
  std::string model;
  int tokens;
};

auto judge = support::Judge::NewStub(grpc::CreateChannel(config::kJudge, grpc::InsecureChannelCredentials()));

// The answer split on . ! ? — a "Based on [kb:…]:" prefix has no terminator, so it stays in the first one.
std::vector<std::string> sentences(const std::string& text) {
  std::vector<std::string> out;
  std::string current;
  for (const char ch : text) {
    if (ch == '.' || ch == '!' || ch == '?') {
      if (current.find_first_not_of(" \\t\\n") != std::string::npos) out.push_back(current);
      current.clear();
    } else {
      current += ch;
    }
  }
  if (current.find_first_not_of(" \\t\\n") != std::string::npos) out.push_back(current);
  return out;
}

// Why the answer fails the cheap checks (empty when it passes).
std::vector<std::string> tier1(const std::string& answer, const std::vector<assistant::Chunk>& chunks) {
  std::set<std::string> ids;
  std::vector<std::vector<double>> vectors;
  for (const auto& c : chunks) {
    ids.insert(c.id);
    vectors.push_back(assistant::embed(c.text));
  }
  std::vector<std::string> reasons;
  for (const auto& id : assistant::cited_ids(answer))
    if (ids.count(id) == 0) reasons.push_back("cites [kb:" + id + "], which was not retrieved");
  for (const auto& sentence : sentences(answer)) {
    const auto v = assistant::embed(sentence);
    double best = 0.0;
    for (const auto& w : vectors) best = std::max(best, assistant::cosine(v, w));
    if (best < config::kMinSimilarity) {
      std::ostringstream why;
      why << "sentence unlike any retrieved chunk (cosine " << best << " < " << config::kMinSimilarity << "): " << sentence;
      reasons.push_back(why.str());
    }
  }
  return reasons;
}

// Tier 1 without an RPC, then the judge.
Verdict check(const std::string& question, const std::string& answer, const std::vector<assistant::Chunk>& chunks) {
  auto reasons = tier1(answer, chunks);
  if (!reasons.empty()) return Verdict{false, 0.0, reasons};
  support::EvaluateRequest request;
  request.set_question(question);
  request.set_answer(answer);
  for (const auto& c : chunks) request.add_context_ids(c.id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + config::kDeadline);
  support::Scores scores;
  const grpc::Status status = judge->Evaluate(&ctx, request, &scores);
  // No verdict is a failed verdict: an answer nobody judged does not reach the Dasher.
  if (!status.ok()) return Verdict{false, 0.0, {"judge " + status.error_message()}};
  if (!scores.pass()) {
    std::ostringstream why;
    why << "judge: groundedness " << scores.groundedness() << ", coherence " << scores.coherence() << ", compliance " << scores.compliance();
    return Verdict{false, scores.groundedness(), {why.str()}};
  }
  return Verdict{true, scores.groundedness(), {}};
}

// The answer the Dasher may see. A rejected answer never leaves here.
Outcome answer_or_escalate(const std::string& question, const std::vector<assistant::Chunk>& chunks,
                           const std::vector<assistant::Turn>& history) {
  std::string model;
  for (int attempt = 0; attempt < 2; ++attempt) {
    const Generated result = generate(question, chunks, history);
    model = result.model;
    if (check(question, result.answer, chunks).ok)
      return Outcome{result.answer, assistant::cited_ids(result.answer), false, result.model, result.tokens};
  }
  return Outcome{config::kHandoffText, {}, true, model, 0};
}
`,
    },
  },
  harness: {
    python: `import inspect

import grpc

import support_pb2
import support_pb2_grpc
from assistant import chunk, config, kb, model, prompt

QUESTION = "My payout has not arrived, when is it paid?"
HISTORY = [{"role": "dasher", "text": "Hi, I dashed all of last week."}]


def _chunk(cid):
    """A real KB chunk, as kb_search would have returned it."""
    article, position = cid.rsplit("-", 1)
    return {"id": cid, "text": chunk.chunk(kb.article(article)["body"])[int(position)], "score": 0.5}


CHUNKS = [_chunk("pay-0"), _chunk("pay-1"), _chunk("tips-0"), _chunk("referrals-1")]
IDS = [c["id"] for c in CHUNKS]
PROMPT = prompt.build_prompt(QUESTION, CHUNKS, HISTORY)
# What the faithful model says for this prompt: "Based on [kb:pay-0][kb:pay-1]: Dasher earnings … depending on the bank."
FAITHFUL = model.complete(PROMPT, config.MAX_TOKENS)
# The same sentence, one citation swapped for a chunk that was never retrieved.
STRAY = FAITHFUL.replace("[kb:pay-1]", "[kb:policy-404]")
# The faithful answer plus a sentence of words the knowledge base never uses.
OFF_TOPIC = FAITHFUL + " Reboot the router and reinstall the firmware."
# The faithful sentence with a promise in it: tier 1 cannot see it, the judge's compliance rule can.
RISKY = FAITHFUL[:-1] + ", which we guarantee."
INVENTED = model.complete(PROMPT, config.MAX_TOKENS, "hallucinate")


class LlmServicer(support_pb2_grpc.LlmServicer):
    def __init__(self, mode="faithful"):
        self.mode = mode

    def Generate(self, request, context):
        text = model.complete(request.prompt, request.max_tokens, self.mode)
        return support_pb2.GenerateReply(text=text, tokens=len(text.split()), model=request.model)


class JudgeServicer(support_pb2_grpc.JudgeServicer):
    """The LLM judge at judge:50051: the deterministic rubric of assistant.model."""

    def Evaluate(self, request, context):
        return support_pb2.Scores(**model.evaluate(request.question, request.answer, list(request.context_ids)))


def _serve(ctx, mode="faithful"):
    llm = LlmServicer(mode)
    ctx.grpc.serve(support_pb2_grpc.add_LlmServicer_to_server, llm, config.LLM_LARGE)
    ctx.grpc.serve(support_pb2_grpc.add_LlmServicer_to_server, llm, config.LLM_SMALL)
    ctx.grpc.serve(support_pb2_grpc.add_JudgeServicer_to_server, JudgeServicer(), config.JUDGE)
    return ctx.load("guardrail"), llm


def _evaluations(ctx):
    return ctx.grpc.calls_to("Evaluate", config.JUDGE)


def _generations(ctx):
    return ctx.grpc.calls_to("Generate")


async def _check(m, answer, what):
    try:
        verdict = m.check(QUESTION, answer, CHUNKS)
        if inspect.isawaitable(verdict):
            verdict = await verdict
    except Exception as exc:
        raise AssertionError(f"check({what}) must return a verdict, it raised {type(exc).__name__}: {exc}")
    assert isinstance(verdict, dict), f"check must return a dict {{ok, groundedness, reasons}}, got {type(verdict).__name__}"
    for key in ("ok", "groundedness", "reasons"):
        assert key in verdict, f"check's result has no {key!r}: {verdict}"
    assert isinstance(verdict["reasons"], list), f"reasons must be a list of strings, got {verdict['reasons']!r}"
    return verdict


async def _answer(m):
    result = m.answer_or_escalate(QUESTION, CHUNKS, HISTORY)
    if inspect.isawaitable(result):
        result = await result
    assert isinstance(result, dict), f"answer_or_escalate must return a dict {{answer, sources, escalated, model}}, got {type(result).__name__}"
    for key in ("answer", "sources", "escalated", "model"):
        assert key in result, f"answer_or_escalate's result has no {key!r}: {result}"
    return result


async def check_cited_chunks_only(ctx):
    m, _ = _serve(ctx)
    verdict = await _check(m, STRAY, "an answer citing policy-404")
    assert verdict["ok"] is False, f"an answer citing [kb:policy-404], which was never retrieved, must fail: got {verdict}"
    assert verdict["reasons"], "a failed check must say why: reasons is empty"
    assert any("policy-404" in r for r in verdict["reasons"]), f"a reason must name the stray chunk id policy-404, got {verdict['reasons']}"
    assert not _evaluations(ctx), f"tier 1 failed, so the judge must not be called — it was called {len(_evaluations(ctx))} time(s)"


async def check_sentence_similarity(ctx):
    m, _ = _serve(ctx)
    verdict = await _check(m, OFF_TOPIC, "a grounded answer plus an invented sentence")
    assert verdict["ok"] is False, f"a sentence unlike every retrieved chunk (cosine 0.00 < {config.MIN_SIMILARITY}) must fail tier 1: got {verdict}"
    assert verdict["reasons"], "a failed check must say why: reasons is empty"
    assert not _evaluations(ctx), f"tier 1 failed, so the judge must not be called — it was called {len(_evaluations(ctx))} time(s)"
    verdict = await _check(m, FAITHFUL, "the faithful answer")
    assert verdict["ok"] is True, f"the faithful answer cites retrieved chunks and its one sentence is the top chunk's (cosine 0.58): it must pass, got {verdict}"


async def check_judge_verdict(ctx):
    m, _ = _serve(ctx)
    verdict = await _check(m, FAITHFUL, "the faithful answer")
    calls = _evaluations(ctx)
    assert len(calls) == 1, f"an answer that clears tier 1 goes to the judge exactly once, saw {len(calls)} Evaluate call(s) to {config.JUDGE}"
    request = calls[0].request
    assert request.question == QUESTION, f"Evaluate must carry the question, got {request.question!r}"
    assert request.answer == FAITHFUL, f"Evaluate must carry the answer as generated, got {request.answer!r}"
    assert list(request.context_ids) == IDS, f"context_ids must be the retrieved chunk ids {IDS}, got {list(request.context_ids)}"
    assert calls[0].timeout is not None, "the Evaluate call carries no deadline: a stalled judge would hold the chat open forever"
    assert 1.5 <= calls[0].timeout <= 2.0, f"the deadline must be DEADLINE_S = {config.DEADLINE_S} s, got {calls[0].timeout} s"
    assert verdict["ok"] is True, f"the judge passed this answer (groundedness 1.0, compliance 1.0): ok must be True, got {verdict}"
    assert abs(float(verdict["groundedness"]) - 1.0) < 1e-6, f"groundedness must be the judge's score 1.0, got {verdict['groundedness']!r}"
    assert verdict["reasons"] == [], f"a passing verdict has no reasons, got {verdict['reasons']}"


async def check_judge_fails_closed(ctx):
    m, _ = _serve(ctx)
    verdict = await _check(m, RISKY, "an answer with a promise in it")
    assert len(_evaluations(ctx)) == 1, f"the promise is invisible to tier 1 (same citations, cosine 0.56): the judge must be asked once, saw {len(_evaluations(ctx))} call(s)"
    assert verdict["ok"] is False, f"the judge scores 'guarantee' as compliance 0.0 and does not pass it: ok must be False, got {verdict}"
    assert abs(float(verdict["groundedness"]) - 1.0) < 1e-6, f"groundedness is the judge's score (1.0: every citation is in context), got {verdict['groundedness']!r}"
    assert verdict["reasons"], "a failed check must say why: reasons is empty"
    ctx.grpc.stop(config.JUDGE)
    verdict = await _check(m, FAITHFUL, "the faithful answer with the judge down")
    assert verdict["ok"] is False, f"with the judge unreachable (UNAVAILABLE) nothing vouched for the answer: ok must be False, got {verdict}"
    assert len(_evaluations(ctx)) == 2, f"the judge must still be asked when it is down (that is how the call fails): expected 2 Evaluate calls, saw {len(_evaluations(ctx))}"
    assert _evaluations(ctx)[-1].code == grpc.StatusCode.UNAVAILABLE


async def check_escalate_after_retry(ctx):
    m, llm = _serve(ctx, "hallucinate")
    result = await _answer(m)
    assert len(_generations(ctx)) == 2, f"a failed check earns the model one more try: expected exactly 2 Generate calls, saw {len(_generations(ctx))}"
    assert not _evaluations(ctx), "the invented answer fails tier 1 both times: the judge must never be called"
    assert result["escalated"] is True, f"two rejected answers must escalate, got {result}"
    assert result["answer"] == config.HANDOFF_TEXT, f"an escalated turn answers with HANDOFF_TEXT, got {result['answer']!r}"
    assert "policy-404" not in result["answer"] and "resolved within 7 days" not in result["answer"], "the rejected answer must never leave answer_or_escalate"
    assert list(result["sources"]) == [], f"an escalated turn has no sources, got {result['sources']}"
    assert result["model"] == "large", f"model must be the one that answered, got {result['model']!r}"
    assert result.get("tokens", 0) == 0, f"an escalated turn has no answer to count: tokens must be 0, got {result.get('tokens')!r}"
    llm.mode = "faithful"
    result = await _answer(m)
    assert len(_generations(ctx)) == 3, f"a passing answer needs one Generate call, saw {len(_generations(ctx)) - 2}"
    assert len(_evaluations(ctx)) == 1, f"a passing answer is judged exactly once, saw {len(_evaluations(ctx))} Evaluate call(s)"
    assert _generations(ctx)[-1].request.prompt == PROMPT, "generate must be given the question, chunks and history: the prompt differs from build_prompt(question, chunks, history)"
    seen = {k: (list(v) if k == "sources" else v) for k, v in result.items() if k in ("answer", "sources", "escalated", "model")}
    assert seen == {"answer": FAITHFUL, "sources": ["pay-0", "pay-1"], "escalated": False, "model": "large"}, f"a passing answer comes back as generated with its cited ids as sources, got {result}"
    if "tokens" in result:
        assert result["tokens"] == len(FAITHFUL.split()), f"tokens must be the count generate reported, got {result['tokens']!r}"
    ctx.grpc.stop(config.JUDGE)
    result = await _answer(m)
    assert result["escalated"] is True and result["answer"] == config.HANDOFF_TEXT and list(result["sources"]) == [], f"with the judge down an unjudged answer must not reach the Dasher: expected the handoff, got {result}"
    assert len(_generations(ctx)) == 5, f"the judge down still earns one more generation before the handoff: expected 2 Generate calls, saw {len(_generations(ctx)) - 3}"
`,
    typescript: `const QUESTION = 'My payout has not arrived, when is it paid?';
const HISTORY = [{role: 'dasher', text: 'Hi, I dashed all of last week.'}];

const words = (text: string) => text.split(/\\s+/).filter(w => w !== '').length;

/** The assistant package as the harness sees it, the real KB chunks and the answers the checks send. */
function world(ctx) {
  const config = ctx.load('/support/assistant/config.ts');
  const model = ctx.load('/support/assistant/model.ts');
  const {buildPrompt} = ctx.load('/support/assistant/prompt.ts');
  const {chunk} = ctx.load('/support/assistant/chunk.ts');
  const kb = ctx.load('/support/assistant/kb.ts');
  // A real KB chunk, as kb_search would have returned it.
  const one = (id: string) => {
    const at = id.lastIndexOf('-');
    return {id, text: chunk(kb.article(id.slice(0, at)).body)[Number(id.slice(at + 1))], score: 0.5};
  };
  const CHUNKS = ['pay-0', 'pay-1', 'tips-0', 'referrals-1'].map(one);
  const IDS = CHUNKS.map(c => c.id);
  const PROMPT = buildPrompt(QUESTION, CHUNKS, HISTORY);
  // What the faithful model says for this prompt: "Based on [kb:pay-0][kb:pay-1]: Dasher earnings … depending on the bank."
  const FAITHFUL: string = model.complete(PROMPT, config.MAX_TOKENS);
  return {
    config,
    model,
    CHUNKS,
    IDS,
    PROMPT,
    FAITHFUL,
    // The same sentence, one citation swapped for a chunk that was never retrieved.
    STRAY: FAITHFUL.replace('[kb:pay-1]', '[kb:policy-404]'),
    // The faithful answer plus a sentence of words the knowledge base never uses.
    OFF_TOPIC: FAITHFUL + ' Reboot the router and reinstall the firmware.',
    // The faithful sentence with a promise in it: tier 1 cannot see it, the judge's compliance rule can.
    RISKY: FAITHFUL.slice(0, -1) + ', which we guarantee.',
  };
}

/** Both model addresses and the judge served by the stand-ins; the learner's module. */
function serve(ctx, mode = 'faithful') {
  const w = world(ctx);
  const {support} = ctx.proto('support.proto');
  const llm = {
    mode,
    Generate: (call, callback) => {
      const text = w.model.complete(call.request.prompt, call.request.max_tokens, llm.mode);
      callback(null, {text, tokens: words(text), model: call.request.model});
    },
  };
  ctx.grpc.serve(support.Llm.service, {Generate: llm.Generate}, w.config.LLM_LARGE);
  ctx.grpc.serve(support.Llm.service, {Generate: llm.Generate}, w.config.LLM_SMALL);
  ctx.grpc.serve(
    support.Judge.service,
    {
      Evaluate: (call, callback) => {
        const {question, answer, context_ids} = call.request;
        callback(null, w.model.evaluate(question, answer, [...context_ids]));
      },
    },
    w.config.JUDGE,
  );
  return {...w, m: ctx.load('guardrail'), llm};
}

const evaluations = (ctx, config) => ctx.grpc.callsTo('Evaluate', config.JUDGE);
const generations = ctx => ctx.grpc.callsTo('Generate');

async function check(w, answer: string, what: string) {
  let verdict;
  try {
    verdict = await w.m.check(QUESTION, answer, w.CHUNKS);
  } catch (e) {
    throw new assert.AssertionError({message: \`check(\${what}) must resolve to a verdict, it rejected: \${(e as Error).message}\`});
  }
  assert(verdict !== null && typeof verdict === 'object', \`check must resolve to {ok, groundedness, reasons}, got \${JSON.stringify(verdict)}\`);
  for (const key of ['ok', 'groundedness', 'reasons']) assert(key in verdict, \`check's result has no \${key}: \${JSON.stringify(verdict)}\`);
  assert(Array.isArray(verdict.reasons), \`reasons must be an array of strings, got \${JSON.stringify(verdict.reasons)}\`);
  return verdict;
}

async function answer(w) {
  const result = await w.m.answerOrEscalate(QUESTION, w.CHUNKS, HISTORY);
  assert(result !== null && typeof result === 'object', \`answerOrEscalate must resolve to {answer, sources, escalated, model}, got \${JSON.stringify(result)}\`);
  for (const key of ['answer', 'sources', 'escalated', 'model']) assert(key in result, \`answerOrEscalate's result has no \${key}: \${JSON.stringify(result)}\`);
  return result;
}

export async function check_cited_chunks_only(ctx) {
  const w = serve(ctx);
  const verdict = await check(w, w.STRAY, 'an answer citing policy-404');
  assert.equal(verdict.ok, false, \`an answer citing [kb:policy-404], which was never retrieved, must fail: got \${JSON.stringify(verdict)}\`);
  assert(verdict.reasons.length > 0, 'a failed check must say why: reasons is empty');
  assert(verdict.reasons.some((r: string) => r.includes('policy-404')), \`a reason must name the stray chunk id policy-404, got \${JSON.stringify(verdict.reasons)}\`);
  assert.equal(evaluations(ctx, w.config).length, 0, \`tier 1 failed, so the judge must not be called — it was called \${evaluations(ctx, w.config).length} time(s)\`);
}

export async function check_sentence_similarity(ctx) {
  const w = serve(ctx);
  let verdict = await check(w, w.OFF_TOPIC, 'a grounded answer plus an invented sentence');
  assert.equal(verdict.ok, false, \`a sentence unlike every retrieved chunk (cosine 0.00 < \${w.config.MIN_SIMILARITY}) must fail tier 1: got \${JSON.stringify(verdict)}\`);
  assert(verdict.reasons.length > 0, 'a failed check must say why: reasons is empty');
  assert.equal(evaluations(ctx, w.config).length, 0, \`tier 1 failed, so the judge must not be called — it was called \${evaluations(ctx, w.config).length} time(s)\`);
  verdict = await check(w, w.FAITHFUL, 'the faithful answer');
  assert.equal(verdict.ok, true, \`the faithful answer cites retrieved chunks and its one sentence is the top chunk's (cosine 0.58): it must pass, got \${JSON.stringify(verdict)}\`);
}

export async function check_judge_verdict(ctx) {
  const w = serve(ctx);
  const verdict = await check(w, w.FAITHFUL, 'the faithful answer');
  const calls = evaluations(ctx, w.config);
  assert.equal(calls.length, 1, \`an answer that clears tier 1 goes to the judge exactly once, saw \${calls.length} Evaluate call(s) to \${w.config.JUDGE}\`);
  const request = calls[0].request;
  assert.equal(request.question, QUESTION, \`Evaluate must carry the question, got \${JSON.stringify(request.question)}\`);
  assert.equal(request.answer, w.FAITHFUL, \`Evaluate must carry the answer as generated, got \${JSON.stringify(request.answer)}\`);
  assert.deepEqual([...request.context_ids], w.IDS, \`context_ids must be the retrieved chunk ids \${JSON.stringify(w.IDS)}, got \${JSON.stringify([...request.context_ids])}\`);
  assert(calls[0].timeout !== null, 'the Evaluate call carries no deadline: a stalled judge would hold the chat open forever');
  assert(1.5 <= calls[0].timeout && calls[0].timeout <= 2.0, \`the deadline must be DEADLINE_S = \${w.config.DEADLINE_S} s, got \${calls[0].timeout} s\`);
  assert.equal(verdict.ok, true, \`the judge passed this answer (groundedness 1.0, compliance 1.0): ok must be true, got \${JSON.stringify(verdict)}\`);
  assert(Math.abs(Number(verdict.groundedness) - 1) < 1e-6, \`groundedness must be the judge's score 1.0, got \${JSON.stringify(verdict.groundedness)}\`);
  assert.deepEqual(verdict.reasons, [], \`a passing verdict has no reasons, got \${JSON.stringify(verdict.reasons)}\`);
}

export async function check_judge_fails_closed(ctx) {
  const w = serve(ctx);
  let verdict = await check(w, w.RISKY, 'an answer with a promise in it');
  assert.equal(evaluations(ctx, w.config).length, 1, \`the promise is invisible to tier 1 (same citations, cosine 0.56): the judge must be asked once, saw \${evaluations(ctx, w.config).length} call(s)\`);
  assert.equal(verdict.ok, false, \`the judge scores 'guarantee' as compliance 0.0 and does not pass it: ok must be false, got \${JSON.stringify(verdict)}\`);
  assert(Math.abs(Number(verdict.groundedness) - 1) < 1e-6, \`groundedness is the judge's score (1.0: every citation is in context), got \${JSON.stringify(verdict.groundedness)}\`);
  assert(verdict.reasons.length > 0, 'a failed check must say why: reasons is empty');
  ctx.grpc.stop(w.config.JUDGE);
  verdict = await check(w, w.FAITHFUL, 'the faithful answer with the judge down');
  assert.equal(verdict.ok, false, \`with the judge unreachable (UNAVAILABLE) nothing vouched for the answer: ok must be false, got \${JSON.stringify(verdict)}\`);
  assert.equal(evaluations(ctx, w.config).length, 2, \`the judge must still be asked when it is down (that is how the call fails): expected 2 Evaluate calls, saw \${evaluations(ctx, w.config).length}\`);
  assert.equal(evaluations(ctx, w.config).at(-1).code, ctx.grpc.status.UNAVAILABLE);
}

export async function check_escalate_after_retry(ctx) {
  const w = serve(ctx, 'hallucinate');
  let result = await answer(w);
  assert.equal(generations(ctx).length, 2, \`a failed check earns the model one more try: expected exactly 2 Generate calls, saw \${generations(ctx).length}\`);
  assert.equal(evaluations(ctx, w.config).length, 0, 'the invented answer fails tier 1 both times: the judge must never be called');
  assert.equal(result.escalated, true, \`two rejected answers must escalate, got \${JSON.stringify(result)}\`);
  assert.equal(result.answer, w.config.HANDOFF_TEXT, \`an escalated turn answers with HANDOFF_TEXT, got \${JSON.stringify(result.answer)}\`);
  assert(!result.answer.includes('policy-404') && !result.answer.includes('resolved within 7 days'), 'the rejected answer must never leave answerOrEscalate');
  assert.deepEqual([...result.sources], [], \`an escalated turn has no sources, got \${JSON.stringify(result.sources)}\`);
  assert.equal(result.model, 'large', \`model must be the one that answered, got \${JSON.stringify(result.model)}\`);
  assert.equal(result.tokens ?? 0, 0, \`an escalated turn has no answer to count: tokens must be 0, got \${JSON.stringify(result.tokens)}\`);
  w.llm.mode = 'faithful';
  result = await answer(w);
  assert.equal(generations(ctx).length, 3, \`a passing answer needs one Generate call, saw \${generations(ctx).length - 2}\`);
  assert.equal(evaluations(ctx, w.config).length, 1, \`a passing answer is judged exactly once, saw \${evaluations(ctx, w.config).length} Evaluate call(s)\`);
  assert.equal(generations(ctx).at(-1).request.prompt, w.PROMPT, 'generate must be given the question, chunks and history: the prompt differs from buildPrompt(question, chunks, history)');
  const {answer: text, sources, escalated, model} = result;
  assert.deepEqual({answer: text, sources: [...sources], escalated, model}, {answer: w.FAITHFUL, sources: ['pay-0', 'pay-1'], escalated: false, model: 'large'}, \`a passing answer comes back as generated with its cited ids as sources, got \${JSON.stringify(result)}\`);
  if ('tokens' in result) assert.equal(result.tokens, words(w.FAITHFUL), \`tokens must be the count generate reported, got \${JSON.stringify(result.tokens)}\`);
  ctx.grpc.stop(w.config.JUDGE);
  result = await answer(w);
  assert(result.escalated === true && result.answer === w.config.HANDOFF_TEXT && [...result.sources].length === 0, \`with the judge down an unjudged answer must not reach the Dasher: expected the handoff, got \${JSON.stringify(result)}\`);
  assert.equal(generations(ctx).length, 5, \`the judge down still earns one more generation before the handoff: expected 2 Generate calls, saw \${generations(ctx).length - 3}\`);
}
`,
  },
  debrief: `The cheap tier runs first because it is free and it is where most of the damage is: a citation outside the retrieved chunks and a sentence that resembles none of them are the two shapes a hallucination takes in a retrieval system, and both are string operations — no RPC, no tokens, no latency added to the turn. In this course's stand-in embedding the margin is wide: the faithful answer scores 0.58 against its chunk and the invented one 0.08, so \`MIN_SIMILARITY = 0.3\` sits comfortably between them; a short paraphrase ("Check the bank details on file.") can still fall under it, which is why the threshold is a tunable and the judge, not the cosine, has the last word on a grounded answer. The judge is a second model rather than a regex because the failures that survive tier 1 are semantic: the "which we guarantee" answer cites the right chunks and matches the right text, and only a reader of the sentence can tell that it promises something the policy does not. DoorDash's post describes exactly these two layers — a cheap lexical and similarity layer, then an LLM judge grading groundedness, coherence and compliance — and credits them with a 90% drop in hallucinations and a 99% drop in compliance failures. The judge fails closed on purpose: \`UNAVAILABLE\` or a deadline is not a verdict, and the one thing a support assistant must never do is read an unjudged answer to a Dasher because the judge was busy. One more generation before giving up is cheap and often enough; after that, the hand-off is the floor — a person sees the question, the Dasher sees an honest sentence, and the rejected text sees nobody. Production adds what this step leaves out: a judge that reads the question too (relevance, not only groundedness), a sampled judge on the request path with the full one offline (step 6), per-reason metrics so a prompt change that starts failing compliance is a graph before it is a complaint, and a feedback loop from the hand-off queue back into the knowledge base, since a question that keeps escalating is usually an article that is missing.`,
};
