import type {Step} from '@/lib/types';

export const classifyColumnsStep: Step = {
  id: 'classify-columns',
  title: 'Classify: token-sized batches, a deadline, one retry, a closed taxonomy',
  concept: 'grpc',
  file: 'classify_columns',
  focus: ['metasense', 'llm'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it builds the prompt, calls
the gateway and parses the JSON the model returns, so the demo tags a ten-column table correctly.
It hides five production flaws. Review it like the owner of the model bill and the tag library,
fix it, and prove the fix.

Implement \`classify_columns(entity, columns)\` for the classifier worker. The LLM gateway exposes
\`Classifier.Classify(ClassifyRequest{entity, prompt}) → ClassifyReply{content}\` at
\`llm-gateway:9000\`; \`content\` is the model's raw text, which the prompt asks to be a JSON array
of \`{"column_name", "assigned_tag"}\`.

- The tag library is closed: \`Personal.ID\`, \`Personal.Name\`, \`Personal.Contact_Info\`,
  \`Geo.Geohash\` and \`None\` (\`TAXONOMY\`). A tag the model invents — \`PII\`, \`Personal.Email\`,
  \`<Personal.ID>\` with the angle brackets left in — becomes \`None\` with confidence \`0\`. The
  taxonomy is what the privacy rules are written against; an unknown tag downstream is a tier
  nobody defined.
- Batch the columns so each prompt stays under **3000 tokens** (\`MAX_PROMPT_TOKENS\`, estimated
  as \`len(text) // 4 + 1\`): the source's model had a 4000-token context shared by prompt and
  answer. One call per batch; the results are concatenated in column order.
- Every call carries a **15 s** deadline (\`DEADLINE_S\`).
- At most **2 attempts** per batch (\`MAX_ATTEMPTS\`), and only \`UNAVAILABLE\` is retried; any
  other status fails the job so the worker can requeue it later.
- Parse defensively: content that is not a JSON array fails the batch (do not crash the worker);
  a column missing from the array gets \`None\`; a column the model adds is ignored; confidence, when
  present, is clamped to \`0..1\`, else \`1\`.

**Failure mode the checks target.** A 600-column table in one prompt is silently truncated by the
gateway or answered for the first hundred columns; a call without a deadline pins the worker on a
slow provider; a retry loop on every error turns an \`INVALID_ARGUMENT\` into a hot loop against a
paid API; and a tag string copied straight from the model into the metadata store is the quiet one —
it looks like a classification and is not one.`,
  sequence: {
    participants: ['metasense', 'LLM gateway'],
    messages: [
      {from: 'metasense', to: 'metasense', label: 'batches(columns) · ≤ 3000 tokens each', kind: 'sync'},
      {from: 'metasense', to: 'LLM gateway', label: 'Classify(entity, prompt) · deadline 15 s', kind: 'sync'},
      {from: 'LLM gateway', to: 'metasense', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'metasense', to: 'LLM gateway', label: 'Classify · attempt 2 of 2', kind: 'sync'},
      {from: 'LLM gateway', to: 'metasense', label: 'content: [{column_name, assigned_tag}, …]', kind: 'reply'},
      {from: 'metasense', to: 'metasense', label: 'parse · unknown tag → None · missing column → None', kind: 'sync'},
    ],
  },
  hints: [
    'Write the batching as a greedy loop over columns: keep a running token estimate that starts at the prompt header, and start a new batch when adding the next column would cross `MAX_PROMPT_TOKENS`. The deadline is an argument on the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`).',
    'Retry is a `for attempt in range(MAX_ATTEMPTS)` whose body catches the RPC error, checks `code() == UNAVAILABLE`, and otherwise re-raises. There is no `while True` anywhere in a client that pays per call.',
    'Parsing is a funnel: `json.loads` in a `try` that turns a decode error into a failed batch; `isinstance(data, list)`; a dict from `column_name` to `assigned_tag` built with `.get`; then one output row per *requested* column, `tag if tag in TAXONOMY else "None"`, confidence clamped.',
  ],
  checks: [
    {
      id: 'token-batches',
      title: 'Batches columns under a 3000-token prompt budget',
      detail:
        'A `MAX_PROMPT_TOKENS = 3000` constant and an `estimate_tokens` helper split the columns into several prompts. The draft sends every column in one call, however wide the table.',
      match: {
        python: {all: [/MAX_PROMPT_TOKENS\s*=\s*3000/, /estimate_tokens\(/]},
        typescript: {all: [/MAX_PROMPT_TOKENS\s*=\s*3000/, /estimateTokens\(/]},
        go: {all: [/maxPromptTokens\s*=\s*3000/, /estimateTokens\(/]},
        scala: {all: [/MaxPromptTokens\s*=\s*3000/, /estimateTokens\(/]},
        cpp: {all: [/kMaxPromptTokens\s*=\s*3000/, /estimateTokens\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every call carries a 15 s deadline',
      detail:
        'The `Classify` call is made with a 15-second deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_S * 1000`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`. Without it a slow provider holds the worker open indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*15/, /timeout=DEADLINE_S/, /\.Classify\(/]},
        typescript: {all: [/DEADLINE_S\s*=\s*15/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_S/, /\.Classify\(/]},
        go: {all: [/deadlineS\s*=\s*15/, /context\.WithTimeout\(/, /\.Classify\(/]},
        scala: {all: [/DeadlineS\s*=\s*15/, /withDeadlineAfter\(/, /\.classify\(/]},
        cpp: {all: [/kDeadlineS\s*=\s*15/, /set_deadline\(/, /->Classify\(/]},
      },
    },
    {
      id: 'retry-once',
      title: 'Two attempts per batch, retrying only UNAVAILABLE',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 2` and only `UNAVAILABLE` is retried; every other status fails the batch. The draft makes one unguarded call, or loops on everything.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*2/, /range\(MAX_ATTEMPTS\)/, /StatusCode\.UNAVAILABLE/],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*2/, /attempt\s*<\s*MAX_ATTEMPTS/, /status\.UNAVAILABLE/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/maxAttempts\s*=\s*2/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/], none: [/for\s*\{/]},
        scala: {
          all: [/MaxAttempts\s*=\s*2/, /attempt\s*<\s*MaxAttempts/, /Status\.Code\.UNAVAILABLE/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*2/, /attempt\s*<\s*kMaxAttempts/, /StatusCode::UNAVAILABLE/],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'taxonomy',
      title: 'Rejects tags outside the taxonomy',
      detail:
        'A `TAXONOMY` set names the five allowed tags and every model tag is checked against it; an unknown tag becomes `None` with confidence 0. The draft stores whatever string the model returned.',
      match: {
        python: {all: [/TAXONOMY\s*=/, /not in TAXONOMY/]},
        typescript: {all: [/const TAXONOMY/, /TAXONOMY\[\w+\]\s*!==\s*true/]},
        go: {all: [/taxonomy\s*=\s*map\[string\]bool/, /taxonomy\[/]},
        scala: {all: [/Taxonomy\s*=\s*Set\(/, /Taxonomy\.contains\(/]},
        cpp: {all: [/kTaxonomy\s*=/, /kTaxonomy\.count\(/]},
      },
    },
    {
      id: 'defensive-parse',
      title: 'Parses the model reply defensively',
      detail:
        'Invalid JSON fails the batch instead of crashing the worker, the array shape is checked, and the tag of each requested column is looked up with a default rather than indexed. The draft indexes the parsed array as if it were well-formed.',
      match: {
        python: {all: [/JSONDecodeError/, /isinstance\(\s*\w+,\s*list\s*\)/, /\.get\(\s*["']assigned_tag["']/]},
        typescript: {all: [/catch/, /Array\.isArray\(/, /\.get\(/]},
        go: {all: [/if err := json\.Unmarshal\(/, /byName\[/]},
        scala: {all: [/Try\(/, /JsArray\(/, /\.getOrElse\(/]},
        cpp: {all: [/json::parse\([^;]*false\)/, /is_array\(\)/, /\.find\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc

import classifier_pb2
import classifier_pb2_grpc

channel = grpc.insecure_channel("llm-gateway:9000")
classifier = classifier_pb2_grpc.ClassifierStub(channel)

PROMPT_HEADER = (
    "You are a database column tag classifier. Assign exactly one tag per column from the list "
    "below, or None when nothing fits. Answer with a JSON array of "
    '{"column_name": "", "assigned_tag": ""}.\\n'
    "Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n"
)


def build_prompt(entity: str, columns: list[str]) -> str:
    lines = [f"{i + 1}. {column}" for i, column in enumerate(columns)]
    return f'{PROMPT_HEADER}These columns belong to the "{entity}" table\\n' + "\\n".join(lines)


def classify_columns(entity: str, columns: list[str]) -> list[dict]:
    # TODO: this draft sends every column in one prompt, calls without a deadline, never retries
    # a flaky gateway, trusts the JSON shape and keeps any tag the model invents. Review all five.
    request = classifier_pb2.ClassifyRequest(entity=entity, prompt=build_prompt(entity, columns))
    reply = classifier.Classify(request)
    data = json.loads(reply.content)
    return [
        {"column": row["column_name"], "tag": row["assigned_tag"], "confidence": row.get("confidence", 1.0)}
        for row in data
    ]
`,
      solution: `import json

import grpc

import classifier_pb2
import classifier_pb2_grpc

MAX_PROMPT_TOKENS = 3000
DEADLINE_S = 15
MAX_ATTEMPTS = 2
TAXONOMY = {"Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash", "None"}

channel = grpc.insecure_channel("llm-gateway:9000")
classifier = classifier_pb2_grpc.ClassifierStub(channel)

PROMPT_HEADER = (
    "You are a database column tag classifier. Assign exactly one tag per column from the list "
    "below, or None when nothing fits. Answer with a JSON array of "
    '{"column_name": "", "assigned_tag": ""}.\\n'
    "Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n"
)


class BatchFailed(Exception):
    """The gateway answered with something the worker cannot use; the job is requeued."""


def estimate_tokens(text: str) -> int:
    return len(text) // 4 + 1


def build_prompt(entity: str, columns: list[str]) -> str:
    lines = [f"{i + 1}. {column}" for i, column in enumerate(columns)]
    return f'{PROMPT_HEADER}These columns belong to the "{entity}" table\\n' + "\\n".join(lines)


def batches(entity: str, columns: list[str]) -> list[list[str]]:
    base = estimate_tokens(build_prompt(entity, []))
    out: list[list[str]] = []
    current: list[str] = []
    used = base
    for column in columns:
        cost = estimate_tokens(column) + 2
        if current and used + cost > MAX_PROMPT_TOKENS:
            out.append(current)
            current, used = [], base
        current.append(column)
        used += cost
    if current:
        out.append(current)
    return out


def call_gateway(entity: str, prompt: str) -> str:
    last: grpc.RpcError | None = None
    for _ in range(MAX_ATTEMPTS):
        try:
            request = classifier_pb2.ClassifyRequest(entity=entity, prompt=prompt)
            return classifier.Classify(request, timeout=DEADLINE_S).content
        except grpc.RpcError as exc:
            last = exc
            if exc.code() != grpc.StatusCode.UNAVAILABLE:
                raise
    raise last or RuntimeError("gateway unavailable")


def parse_reply(content: str, columns: list[str]) -> list[dict]:
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise BatchFailed("reply is not JSON") from exc
    if not isinstance(data, list):
        raise BatchFailed("reply is not a JSON array")
    by_name: dict[str, dict] = {}
    for row in data:
        if isinstance(row, dict) and isinstance(row.get("column_name"), str):
            by_name[row["column_name"]] = row
    out = []
    for column in columns:
        row = by_name.get(column, {})
        tag = row.get("assigned_tag", "None")
        confidence = row.get("confidence", 1.0)
        if not isinstance(confidence, (int, float)):
            confidence = 1.0
        confidence = min(1.0, max(0.0, float(confidence)))
        if not isinstance(tag, str) or tag not in TAXONOMY:
            tag, confidence = "None", 0.0
        out.append({"column": column, "tag": tag, "confidence": confidence})
    return out


def classify_columns(entity: str, columns: list[str]) -> list[dict]:
    results: list[dict] = []
    for batch in batches(entity, columns):
        content = call_gateway(entity, build_prompt(entity, batch))
        results.extend(parse_reply(content, batch))
    return results
`,
    },
    typescript: {
      starter: `/** Classify: a model-generated draft that sends one prompt and keeps whatever comes back. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface ClassifierClient {
  Classify(
    request: {entity: string; prompt: string},
    callback: (error: grpc.ServiceError | null, reply: {content: string}) => void,
  ): void;
}

const {metasense} = grpc.loadPackageDefinition(protoLoader.loadSync('classifier.proto')) as unknown as {
  metasense: {Classifier: new (target: string, credentials: grpc.ChannelCredentials) => ClassifierClient};
};
const classifier = new metasense.Classifier('llm-gateway:9000', grpc.credentials.createInsecure());

const PROMPT_HEADER =
  'You are a database column tag classifier. Assign exactly one tag per column from the list below, ' +
  'or None when nothing fits. Answer with a JSON array of {"column_name": "", "assigned_tag": ""}.\\n' +
  'Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n';

export interface ColumnTag {
  column: string;
  tag: string;
  confidence: number;
}

function buildPrompt(entity: string, columns: string[]): string {
  const lines = columns.map((column, i) => \`\${i + 1}. \${column}\`);
  return \`\${PROMPT_HEADER}These columns belong to the "\${entity}" table\\n\${lines.join('\\n')}\`;
}

export async function classifyColumns(entity: string, columns: string[]): Promise<ColumnTag[]> {
  // TODO: this draft sends every column in one prompt, calls without a deadline, never retries
  // a flaky gateway, trusts the JSON shape and keeps any tag the model invents. Review all five.
  const reply = await new Promise<{content: string}>((resolve, reject) => {
    classifier.Classify({entity, prompt: buildPrompt(entity, columns)}, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
  const data = JSON.parse(reply.content) as {column_name: string; assigned_tag: string; confidence?: number}[];
  return data.map(row => ({column: row.column_name, tag: row.assigned_tag, confidence: row.confidence ?? 1}));
}
`,
      solution: `/** Classify: token-sized batches, a 15 s deadline, one retry on UNAVAILABLE, a closed taxonomy. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const MAX_PROMPT_TOKENS = 3000;
const DEADLINE_S = 15;
const MAX_ATTEMPTS = 2;
const TAXONOMY: Record<string, true> = {
  'Personal.ID': true,
  'Personal.Name': true,
  'Personal.Contact_Info': true,
  'Geo.Geohash': true,
  None: true,
};

interface ClassifierClient {
  Classify(
    request: {entity: string; prompt: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: {content: string}) => void,
  ): void;
}

const {metasense} = grpc.loadPackageDefinition(protoLoader.loadSync('classifier.proto')) as unknown as {
  metasense: {Classifier: new (target: string, credentials: grpc.ChannelCredentials) => ClassifierClient};
};
const classifier = new metasense.Classifier('llm-gateway:9000', grpc.credentials.createInsecure());

const PROMPT_HEADER =
  'You are a database column tag classifier. Assign exactly one tag per column from the list below, ' +
  'or None when nothing fits. Answer with a JSON array of {"column_name": "", "assigned_tag": ""}.\\n' +
  'Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n';

export interface ColumnTag {
  column: string;
  tag: string;
  confidence: number;
}

export class BatchFailed extends Error {}

function estimateTokens(text: string): number {
  return Math.floor(text.length / 4) + 1;
}

function buildPrompt(entity: string, columns: string[]): string {
  const lines = columns.map((column, i) => \`\${i + 1}. \${column}\`);
  return \`\${PROMPT_HEADER}These columns belong to the "\${entity}" table\\n\${lines.join('\\n')}\`;
}

function batches(entity: string, columns: string[]): string[][] {
  const base = estimateTokens(buildPrompt(entity, []));
  const out: string[][] = [];
  let current: string[] = [];
  let used = base;
  for (const column of columns) {
    const cost = estimateTokens(column) + 2;
    if (current.length > 0 && used + cost > MAX_PROMPT_TOKENS) {
      out.push(current);
      current = [];
      used = base;
    }
    current.push(column);
    used += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function classifyOnce(entity: string, prompt: string): Promise<string> {
  const {promise, resolve, reject} = Promise.withResolvers<string>();
  classifier.Classify(
    {entity, prompt},
    new grpc.Metadata(),
    {deadline: Date.now() + DEADLINE_S * 1000},
    (error, reply) => (error ? reject(error) : resolve(reply.content)),
  );
  return promise;
}

async function callGateway(entity: string, prompt: string): Promise<string> {
  let last: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await classifyOnce(entity, prompt);
    } catch (error) {
      last = error as grpc.ServiceError;
      if (last.code !== grpc.status.UNAVAILABLE) throw last;
    }
  }
  throw last ?? new Error('gateway unavailable');
}

function parseReply(content: string, columns: string[]): ColumnTag[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new BatchFailed('reply is not JSON');
  }
  if (!Array.isArray(data)) throw new BatchFailed('reply is not a JSON array');
  const byName = new Map<string, Record<string, unknown>>();
  for (const row of data as unknown[]) {
    if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>).column_name === 'string')
      byName.set((row as Record<string, string>).column_name, row as Record<string, unknown>);
  }
  return columns.map(column => {
    const row = byName.get(column) ?? {};
    const tag = row.assigned_tag;
    const raw = typeof row.confidence === 'number' ? row.confidence : 1;
    const confidence = Math.min(1, Math.max(0, raw));
    if (typeof tag !== 'string' || TAXONOMY[tag] !== true) return {column, tag: 'None', confidence: 0};
    return {column, tag, confidence};
  });
}

export async function classifyColumns(entity: string, columns: string[]): Promise<ColumnTag[]> {
  const results: ColumnTag[] = [];
  for (const batch of batches(entity, columns)) {
    const content = await callGateway(entity, buildPrompt(entity, batch));
    results.push(...parseReply(content, batch));
  }
  return results;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	pb "metasense/classifierpb"
)

const promptHeader = "You are a database column tag classifier. Assign exactly one tag per column from the list below, " +
	"or None when nothing fits. Answer with a JSON array of {\\"column_name\\": \\"\\", \\"assigned_tag\\": \\"\\"}.\\n" +
	"Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n"

type ColumnTag struct {
	Column     string  \`json:"column"\`
	Tag        string  \`json:"tag"\`
	Confidence float64 \`json:"confidence"\`
}

type replyRow struct {
	ColumnName  string   \`json:"column_name"\`
	AssignedTag string   \`json:"assigned_tag"\`
	Confidence  *float64 \`json:"confidence"\`
}

func buildPrompt(entity string, columns []string) string {
	var b strings.Builder
	b.WriteString(promptHeader)
	fmt.Fprintf(&b, "These columns belong to the %q table\\n", entity)
	for i, column := range columns {
		fmt.Fprintf(&b, "%d. %s\\n", i+1, column)
	}
	return b.String()
}

// TODO: this draft sends every column in one prompt, calls without a deadline, never retries a
// flaky gateway, trusts the JSON shape and keeps any tag the model invents. Review all five.
func classifyColumns(ctx context.Context, client pb.ClassifierClient, entity string, columns []string) ([]ColumnTag, error) {
	reply, err := client.Classify(ctx, &pb.ClassifyRequest{Entity: entity, Prompt: buildPrompt(entity, columns)})
	if err != nil {
		return nil, err
	}
	var rows []replyRow
	_ = json.Unmarshal([]byte(reply.Content), &rows)
	out := make([]ColumnTag, 0, len(rows))
	for _, row := range rows {
		confidence := 1.0
		if row.Confidence != nil {
			confidence = *row.Confidence
		}
		out = append(out, ColumnTag{Column: row.ColumnName, Tag: row.AssignedTag, Confidence: confidence})
	}
	return out, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "metasense/classifierpb"
)

const (
	maxPromptTokens = 3000
	deadlineS       = 15
	maxAttempts     = 2
)

var taxonomy = map[string]bool{
	"Personal.ID":           true,
	"Personal.Name":         true,
	"Personal.Contact_Info": true,
	"Geo.Geohash":           true,
	"None":                  true,
}

var errBatchFailed = errors.New("gateway reply unusable; requeue the job")

const promptHeader = "You are a database column tag classifier. Assign exactly one tag per column from the list below, " +
	"or None when nothing fits. Answer with a JSON array of {\\"column_name\\": \\"\\", \\"assigned_tag\\": \\"\\"}.\\n" +
	"Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n"

type ColumnTag struct {
	Column     string  \`json:"column"\`
	Tag        string  \`json:"tag"\`
	Confidence float64 \`json:"confidence"\`
}

type replyRow struct {
	ColumnName  string   \`json:"column_name"\`
	AssignedTag string   \`json:"assigned_tag"\`
	Confidence  *float64 \`json:"confidence"\`
}

func estimateTokens(text string) int {
	return len(text)/4 + 1
}

func buildPrompt(entity string, columns []string) string {
	var b strings.Builder
	b.WriteString(promptHeader)
	fmt.Fprintf(&b, "These columns belong to the %q table\\n", entity)
	for i, column := range columns {
		fmt.Fprintf(&b, "%d. %s\\n", i+1, column)
	}
	return b.String()
}

func batches(entity string, columns []string) [][]string {
	base := estimateTokens(buildPrompt(entity, nil))
	var out [][]string
	var current []string
	used := base
	for _, column := range columns {
		cost := estimateTokens(column) + 2
		if len(current) > 0 && used+cost > maxPromptTokens {
			out = append(out, current)
			current = nil
			used = base
		}
		current = append(current, column)
		used += cost
	}
	if len(current) > 0 {
		out = append(out, current)
	}
	return out
}

func callGateway(ctx context.Context, client pb.ClassifierClient, entity, prompt string) (string, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
		reply, err := client.Classify(callCtx, &pb.ClassifyRequest{Entity: entity, Prompt: prompt})
		cancel()
		if err == nil {
			return reply.Content, nil
		}
		lastErr = err
		if status.Code(err) != codes.Unavailable {
			return "", err
		}
	}
	return "", lastErr
}

func parseReply(content string, columns []string) ([]ColumnTag, error) {
	var rows []replyRow
	if err := json.Unmarshal([]byte(content), &rows); err != nil {
		return nil, fmt.Errorf("%w: %v", errBatchFailed, err)
	}
	byName := make(map[string]replyRow, len(rows))
	for _, row := range rows {
		if row.ColumnName != "" {
			byName[row.ColumnName] = row
		}
	}
	out := make([]ColumnTag, 0, len(columns))
	for _, column := range columns {
		row, found := byName[column]
		tag := "None"
		confidence := 1.0
		if found {
			tag = row.AssignedTag
			if row.Confidence != nil {
				confidence = *row.Confidence
			}
		}
		if confidence < 0 {
			confidence = 0
		}
		if confidence > 1 {
			confidence = 1
		}
		if !taxonomy[tag] {
			tag, confidence = "None", 0
		}
		out = append(out, ColumnTag{Column: column, Tag: tag, Confidence: confidence})
	}
	return out, nil
}

func classifyColumns(ctx context.Context, client pb.ClassifierClient, entity string, columns []string) ([]ColumnTag, error) {
	var results []ColumnTag
	for _, batch := range batches(entity, columns) {
		content, err := callGateway(ctx, client, entity, buildPrompt(entity, batch))
		if err != nil {
			return nil, err
		}
		tags, err := parseReply(content, batch)
		if err != nil {
			return nil, err
		}
		results = append(results, tags...)
	}
	return results, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import spray.json._

final case class ColumnTag(column: String, tag: String, confidence: Double)

object ClassifyColumns {
  val stub = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("llm-gateway", 9000).usePlaintext().build())

  val PromptHeader =
    "You are a database column tag classifier. Assign exactly one tag per column from the list below, " +
      "or None when nothing fits. Answer with a JSON array of {\\"column_name\\": \\"\\", \\"assigned_tag\\": \\"\\"}.\\n" +
      "Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n"

  def buildPrompt(entity: String, columns: List[String]): String = {
    val lines = columns.zipWithIndex.map { case (column, i) => s"\${i + 1}. $column" }
    s"""$PromptHeader These columns belong to the "$entity" table\\n""" + lines.mkString("\\n")
  }

  // TODO: this draft sends every column in one prompt, calls without a deadline, never retries a
  // flaky gateway, trusts the JSON shape and keeps any tag the model invents. Review all five.
  def classifyColumns(entity: String, columns: List[String]): List[ColumnTag] = {
    val reply = stub.classify(ClassifyRequest(entity = entity, prompt = buildPrompt(entity, columns)))
    reply.content.parseJson.asInstanceOf[JsArray].elements.toList.map { element =>
      val row = element.asJsObject.fields
      val confidence = row.get("confidence").map(_.convertTo[Double]).getOrElse(1.0)
      ColumnTag(row("column_name").convertTo[String], row("assigned_tag").convertTo[String], confidence)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import spray.json._

import scala.util.Try

final case class ColumnTag(column: String, tag: String, confidence: Double)
final class BatchFailed(message: String) extends RuntimeException(message)

object ClassifyColumns {
  val MaxPromptTokens = 3000
  val DeadlineS = 15L
  val MaxAttempts = 2
  val Taxonomy = Set("Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash", "None")

  val stub = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("llm-gateway", 9000).usePlaintext().build())

  val PromptHeader =
    "You are a database column tag classifier. Assign exactly one tag per column from the list below, " +
      "or None when nothing fits. Answer with a JSON array of {\\"column_name\\": \\"\\", \\"assigned_tag\\": \\"\\"}.\\n" +
      "Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n"

  def estimateTokens(text: String): Int = text.length / 4 + 1

  def buildPrompt(entity: String, columns: List[String]): String = {
    val lines = columns.zipWithIndex.map { case (column, i) => s"\${i + 1}. $column" }
    s"""$PromptHeader These columns belong to the "$entity" table\\n""" + lines.mkString("\\n")
  }

  def batches(entity: String, columns: List[String]): List[List[String]] = {
    val base = estimateTokens(buildPrompt(entity, Nil))
    val out = scala.collection.mutable.ListBuffer.empty[List[String]]
    var current = scala.collection.mutable.ListBuffer.empty[String]
    var used = base
    columns.foreach { column =>
      val cost = estimateTokens(column) + 2
      if (current.nonEmpty && used + cost > MaxPromptTokens) {
        out += current.toList
        current = scala.collection.mutable.ListBuffer.empty[String]
        used = base
      }
      current += column
      used += cost
    }
    if (current.nonEmpty) out += current.toList
    out.toList
  }

  def callGateway(entity: String, prompt: String): String = {
    var attempt = 0
    var last: Option[StatusRuntimeException] = None
    while (attempt < MaxAttempts) {
      try {
        return stub
          .withDeadlineAfter(DeadlineS, TimeUnit.SECONDS)
          .classify(ClassifyRequest(entity = entity, prompt = prompt))
          .content
      } catch {
        case exc: StatusRuntimeException =>
          last = Some(exc)
          if (exc.getStatus.getCode != Status.Code.UNAVAILABLE) throw exc
      }
      attempt += 1
    }
    throw last.getOrElse(new RuntimeException("gateway unavailable"))
  }

  def parseReply(content: String, columns: List[String]): List[ColumnTag] = {
    val rows = Try(content.parseJson).toOption match {
      case Some(JsArray(elements)) => elements.toList
      case Some(_) => throw new BatchFailed("reply is not a JSON array")
      case None => throw new BatchFailed("reply is not JSON")
    }
    val byName = rows.collect { case obj: JsObject =>
      obj.fields.get("column_name").collect { case JsString(name) => name -> obj.fields }
    }.flatten.toMap
    columns.map { column =>
      val row = byName.getOrElse(column, Map.empty[String, JsValue])
      val tag = row.get("assigned_tag").collect { case JsString(t) => t }.getOrElse("None")
      val raw = row.get("confidence").collect { case JsNumber(n) => n.toDouble }.getOrElse(1.0)
      val confidence = math.min(1.0, math.max(0.0, raw))
      if (Taxonomy.contains(tag)) ColumnTag(column, tag, confidence) else ColumnTag(column, "None", 0.0)
    }
  }

  def classifyColumns(entity: String, columns: List[String]): List[ColumnTag] =
    batches(entity, columns).flatMap { batch =>
      parseReply(callGateway(entity, buildPrompt(entity, batch)), batch)
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "classifier.grpc.pb.h"

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kPromptHeader =
    "You are a database column tag classifier. Assign exactly one tag per column from the list below, "
    "or None when nothing fits. Answer with a JSON array of {\\"column_name\\": \\"\\", \\"assigned_tag\\": \\"\\"}.\\n"
    "Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n";

struct ColumnTag {
  std::string column;
  std::string tag;
  double confidence;
};

std::string buildPrompt(const std::string& entity, const std::vector<std::string>& columns) {
  std::string prompt = kPromptHeader + "These columns belong to the \\"" + entity + "\\" table\\n";
  for (std::size_t i = 0; i < columns.size(); i++) {
    prompt += std::to_string(i + 1) + ". " + columns[i] + "\\n";
  }
  return prompt;
}

// TODO: this draft sends every column in one prompt, calls without a deadline, never retries a
// flaky gateway, trusts the JSON shape and keeps any tag the model invents. Review all five.
std::vector<ColumnTag> classifyColumns(Classifier::Stub* stub, const std::string& entity,
                                       const std::vector<std::string>& columns) {
  grpc::ClientContext ctx;
  ClassifyRequest request;
  request.set_entity(entity);
  request.set_prompt(buildPrompt(entity, columns));
  ClassifyReply reply;
  const grpc::Status status = stub->Classify(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error(status.error_message());
  std::vector<ColumnTag> out;
  for (const auto& row : json::parse(reply.content())) {
    out.push_back(ColumnTag{row["column_name"].get<std::string>(), row["assigned_tag"].get<std::string>(),
                            row.value("confidence", 1.0)});
  }
  return out;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "classifier.grpc.pb.h"

#include <algorithm>
#include <chrono>
#include <nlohmann/json.hpp>
#include <set>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxPromptTokens = 3000;
constexpr int kDeadlineS = 15;
constexpr int kMaxAttempts = 2;
const std::set<std::string> kTaxonomy = {"Personal.ID", "Personal.Name", "Personal.Contact_Info", "Geo.Geohash",
                                         "None"};

const std::string kPromptHeader =
    "You are a database column tag classifier. Assign exactly one tag per column from the list below, "
    "or None when nothing fits. Answer with a JSON array of {\\"column_name\\": \\"\\", \\"assigned_tag\\": \\"\\"}.\\n"
    "Tags: Personal.ID, Personal.Name, Personal.Contact_Info, Geo.Geohash, None\\n";

struct ColumnTag {
  std::string column;
  std::string tag;
  double confidence;
};

struct BatchFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

int estimateTokens(const std::string& text) { return static_cast<int>(text.size()) / 4 + 1; }

std::string buildPrompt(const std::string& entity, const std::vector<std::string>& columns) {
  std::string prompt = kPromptHeader + "These columns belong to the \\"" + entity + "\\" table\\n";
  for (std::size_t i = 0; i < columns.size(); i++) {
    prompt += std::to_string(i + 1) + ". " + columns[i] + "\\n";
  }
  return prompt;
}

std::vector<std::vector<std::string>> batches(const std::string& entity, const std::vector<std::string>& columns) {
  const int base = estimateTokens(buildPrompt(entity, {}));
  std::vector<std::vector<std::string>> out;
  std::vector<std::string> current;
  int used = base;
  for (const auto& column : columns) {
    const int cost = estimateTokens(column) + 2;
    if (!current.empty() && used + cost > kMaxPromptTokens) {
      out.push_back(current);
      current.clear();
      used = base;
    }
    current.push_back(column);
    used += cost;
  }
  if (!current.empty()) out.push_back(current);
  return out;
}

std::string callGateway(Classifier::Stub* stub, const std::string& entity, const std::string& prompt) {
  grpc::Status last;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
    ClassifyRequest request;
    request.set_entity(entity);
    request.set_prompt(prompt);
    ClassifyReply reply;
    const grpc::Status status = stub->Classify(&ctx, request, &reply);
    if (status.ok()) return reply.content();
    last = status;
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE) throw std::runtime_error(status.error_message());
  }
  throw std::runtime_error("gateway unavailable: " + last.error_message());
}

std::vector<ColumnTag> parseReply(const std::string& content, const std::vector<std::string>& columns) {
  const json data = json::parse(content, nullptr, false);
  if (data.is_discarded()) throw BatchFailed("reply is not JSON");
  if (!data.is_array()) throw BatchFailed("reply is not a JSON array");
  std::unordered_map<std::string, json> byName;
  for (const auto& row : data) {
    if (row.is_object() && row.contains("column_name") && row["column_name"].is_string()) {
      byName[row["column_name"].get<std::string>()] = row;
    }
  }
  std::vector<ColumnTag> out;
  out.reserve(columns.size());
  for (const auto& column : columns) {
    const auto it = byName.find(column);
    std::string tag = "None";
    double confidence = 1.0;
    if (it != byName.end()) {
      tag = it->second.value("assigned_tag", std::string("None"));
      if (it->second.contains("confidence") && it->second["confidence"].is_number()) {
        confidence = it->second["confidence"].get<double>();
      }
    }
    confidence = std::min(1.0, std::max(0.0, confidence));
    if (kTaxonomy.count(tag) == 0) {
      tag = "None";
      confidence = 0.0;
    }
    out.push_back(ColumnTag{column, tag, confidence});
  }
  return out;
}

std::vector<ColumnTag> classifyColumns(Classifier::Stub* stub, const std::string& entity,
                                       const std::vector<std::string>& columns) {
  std::vector<ColumnTag> results;
  for (const auto& batch : batches(entity, columns)) {
    const auto tags = parseReply(callGateway(stub, entity, buildPrompt(entity, batch)), batch);
    results.insert(results.end(), tags.begin(), tags.end());
  }
  return results;
}
`,
    },
  },
  debrief: `The interviewer is testing whether you treat a model's output as input. The draft trusts three things at once: that the prompt fits (it does not, past a few hundred columns — the source's team split tables at 150 for exactly this reason), that the reply is the JSON the prompt asked for (usually; not always), and that the string in \`assigned_tag\` is a tag (the model is told the library, not bound by it). Five separate defects are being checked: the token-budgeted batches, the per-call deadline, the bounded retry that only follows \`UNAVAILABLE\`, the closed taxonomy, and the defensive parse that maps each *requested* column to a tag instead of each returned row. The taxonomy is the one that matters most downstream: the tier rules in step 4 are written against five names, so an unknown tag is not a classification, it is a gap that looks filled. Real classifiers add the few-shot example from the source's prompt, a confidence threshold below which the owner is asked rather than told, and a second, PII-only pass with the 8-tag prompt Metasense V2 describes.`,
};
