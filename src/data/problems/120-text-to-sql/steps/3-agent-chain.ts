import type {Step} from '@/lib/types';

export const agentChainStep: Step = {
  id: 'agent-chain',
  title: 'Agent chain: deadlines, column pruning, parsed output',
  concept: 'grpc',
  file: 'agent_chain',
  focus: ['api', 'agents', 'workspaces'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: with small tables and a
healthy agent service it returns SQL, so the demo passes. It hides four production flaws: no
deadline on any call, an unbounded retry of every error, no column pruning, and model output
trusted as JSON. Find them, fix them, and prove the fix.

Implement the agent client the service uses after the user ACKs the tables — \`plan(question)\`
(intent, then tables) and \`generate(question, workspace, tables)\` (schemas, pruning, generation):

- Every call carries a deadline: **10 s** for the classifiers (\`Intent\`, \`PickTables\`,
  \`PruneColumns\`; \`AGENT_DEADLINE_S = 10\`) and **30 s** for \`Generate\`
  (\`GENERATE_DEADLINE_S = 30\`). A call without one lets a stuck model pin a worker for as long
  as the provider feels like.
- At most **2 attempts** per call (\`MAX_ATTEMPTS = 2\`) and only \`UNAVAILABLE\` is retried;
  \`INVALID_ARGUMENT\`, \`RESOURCE_EXHAUSTED\` and everything else return to the caller at once.
- Before \`Generate\`, estimate the schema size as \`characters / 4\` tokens
  (\`estimate_tokens\`). When it exceeds \`SCHEMA_TOKEN_BUDGET = 24000\`, call the **column prune
  agent** with the question and the schemas, and generate from the pruned schemas it returns. The
  source's wide tables cost 40–60K tokens each and broke the 32K-token model they started with;
  pruning is what made large tables generate at all, and it cut the cost and latency of every
  call since.
- The model's answer is a text field holding JSON \`{"sql": "…", "explanation": "…"}\`. Parse it in
  \`parse_output\`: invalid JSON, a missing or non-string \`sql\` or \`explanation\`, or an empty
  \`sql\` is a \`GenerationError\`, not a crash in the handler.

**Failure mode the checks target.** The draft retries forever on any error, so a permanent
\`INVALID_ARGUMENT\` spins the worker against a provider that will never answer differently; with
no deadline a slow generation holds the request open indefinitely; with no pruning the request
that includes two wide tables fails intermittently on token size, which is exactly the bug that
appeared when more users arrived; and indexing straight into \`json.loads(text)["sql"]\` turns one
malformed model answer into a 500 with a stack trace.`,
  sequence: {
    participants: ['querygen', 'Agents', 'Catalog'],
    messages: [
      {from: 'querygen', to: 'Agents', label: 'Intent(question) · deadline 10 s', kind: 'sync'},
      {from: 'Agents', to: 'querygen', label: '{workspace}', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'PickTables(question, workspace) · deadline 10 s', kind: 'sync'},
      {from: 'Agents', to: 'querygen', label: '{tables} → user ACK', kind: 'reply'},
      {from: 'querygen', to: 'Catalog', label: 'schemas_for(acked tables)', kind: 'sync'},
      {from: 'Catalog', to: 'querygen', label: 'DDL per table · estimate_tokens = chars / 4', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'PruneColumns(question, schemas) when > 24 000 tokens', kind: 'sync'},
      {from: 'Agents', to: 'querygen', label: '{schemas} skinnier', kind: 'reply'},
      {
        from: 'querygen',
        to: 'Agents',
        label: 'Generate(question, workspace, tables, schemas) · deadline 30 s',
        kind: 'sync',
      },
      {from: 'Agents', to: 'querygen', label: '{text} → parse_output → {sql, explanation}', kind: 'reply'},
    ],
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`). Put the retry in one helper that takes the call as a closure: `for attempt in range(MAX_ATTEMPTS)`, catch the RPC error, compare its code to `UNAVAILABLE`, and re-raise anything else immediately.',
    'Pruning is a size decision made before generation: sum the schema characters, divide by four, compare to `SCHEMA_TOKEN_BUDGET`. Only when the estimate is over budget does the prune agent run, and what it returns replaces the schemas you pass to `Generate`.',
    '`parse_output` is defensive by construction: parse inside a try, check the result is an object, check `sql` and `explanation` are strings, check `sql` is not blank, and raise `GenerationError` with a reason for anything else. The handler maps that one error type to a 502; everything else is a bug.',
  ],
  checks: [
    {
      id: 'deadlines',
      title: 'Classifier calls get 10 s, Generate gets 30 s',
      detail:
        '`AGENT_DEADLINE_S = 10` is passed on `Intent`, `PickTables` and `PruneColumns`; `GENERATE_DEADLINE_S = 30` on `Generate`. The draft calls every agent without a deadline.',
      match: {
        python: {
          all: [
            /AGENT_DEADLINE_S\s*=\s*10/,
            /GENERATE_DEADLINE_S\s*=\s*30/,
            /timeout=AGENT_DEADLINE_S/,
            /timeout=GENERATE_DEADLINE_S/,
          ],
        },
        typescript: {
          all: [
            /AGENT_DEADLINE_MS\s*=\s*10_?000/,
            /GENERATE_DEADLINE_MS\s*=\s*30_?000/,
            /deadline:\s*Date\.now\(\)\s*\+\s*AGENT_DEADLINE_MS/,
            /deadline:\s*Date\.now\(\)\s*\+\s*GENERATE_DEADLINE_MS/,
          ],
        },
        go: {
          all: [
            /agentDeadline\s*=\s*10\s*\*\s*time\.Second/,
            /generateDeadline\s*=\s*30\s*\*\s*time\.Second/,
            /context\.WithTimeout/,
          ],
        },
        scala: {all: [/AgentDeadlineMs\s*=\s*10000/, /GenerateDeadlineMs\s*=\s*30000/, /withDeadlineAfter\(/]},
        cpp: {all: [/kAgentDeadlineMs\s*=\s*10000/, /kGenerateDeadlineMs\s*=\s*30000/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'At most two attempts, only UNAVAILABLE retried',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 2` and only `UNAVAILABLE` is retried; every other status returns at once. The draft loops forever on any error.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*2/, /range\(MAX_ATTEMPTS\)/, /StatusCode\.UNAVAILABLE/],
          none: [/while\s+True/, /except Exception/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*2/, /attempt\s*<\s*MAX_ATTEMPTS/, /status\.UNAVAILABLE/],
          none: [/for\s*\(\s*;\s*;\s*\)/, /while\s*\(\s*true\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*2/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/],
          none: [/\bfor\s*\{/],
        },
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
      id: 'prune-when-large',
      title: 'Prunes columns when the schemas exceed the token budget',
      detail:
        'When the estimate exceeds `SCHEMA_TOKEN_BUDGET = 24000`, `PruneColumns` runs and its skinnier schemas are what `Generate` receives. The draft never calls the prune agent, so wide tables fail intermittently on token size.',
      match: {
        python: {all: [/SCHEMA_TOKEN_BUDGET\s*=\s*24_?000/, /\.PruneColumns\(/]},
        typescript: {all: [/SCHEMA_TOKEN_BUDGET\s*=\s*24_?000/, /\.PruneColumns\(/]},
        go: {all: [/schemaTokenBudget\s*=\s*24000/, /\.PruneColumns\(/]},
        scala: {all: [/SchemaTokenBudget\s*=\s*24000/, /\.pruneColumns\(/]},
        cpp: {all: [/kSchemaTokenBudget\s*=\s*24000/, /->PruneColumns\(/]},
      },
    },
    {
      id: 'prune-order',
      title: 'Estimates, prunes, then generates — in that order',
      detail:
        '`estimate_tokens` (characters / 4) decides whether to prune, the prune call comes before `Generate`, and `Generate` is called with the schemas that came back. The draft has no estimate and generates from the raw schemas.',
      match: {
        python: {all: [/def estimate_tokens\(/], order: [/estimate_tokens\(/, /\.PruneColumns\(/, /\.Generate\(/]},
        typescript: {
          all: [/function estimateTokens\(/],
          order: [/estimateTokens\(/, /\.PruneColumns\(/, /\.Generate\(/],
        },
        go: {all: [/func estimateTokens\(/], order: [/estimateTokens\(/, /\.PruneColumns\(/, /\.Generate\(/]},
        scala: {all: [/def estimateTokens\(/], order: [/estimateTokens\(/, /\.pruneColumns\(/, /\.generate\(/]},
        cpp: {all: [/int estimateTokens\(/], order: [/estimateTokens\(/, /->PruneColumns\(/, /->Generate\(/]},
      },
    },
    {
      id: 'parse-output',
      title: 'Parses the model output defensively',
      detail:
        '`parse_output` parses the text as JSON inside a try, requires string `sql` and `explanation`, rejects an empty `sql`, and raises `GenerationError` otherwise. The draft indexes into the parsed text and crashes on the first malformed answer.',
      match: {
        python: {
          all: [/def parse_output\(/, /json\.JSONDecodeError/, /isinstance\(\s*sql,\s*str\s*\)/, /GenerationError/],
        },
        typescript: {all: [/function parseOutput\(/, /catch/, /typeof [\w.]+ !== 'string'/, /GenerationError/]},
        go: {
          all: [/func parseOutput\(/, /json\.Unmarshal\(/, /strings\.TrimSpace\([\w.*]+\)\s*==\s*""/, /ErrGeneration/],
        },
        scala: {all: [/def parseOutput\(/, /Try\(/, /JsString\(/, /GenerationError/]},
        cpp: {all: [/parseOutput\(/, /json::parse\([^)]*false\)/, /is_string\(\)/, /GenerationError/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc

import agents_pb2
import agents_pb2_grpc
from catalog import schemas_for

agents = agents_pb2_grpc.AgentsStub(grpc.insecure_channel("agents:9000"))


def call(fn):
    # TODO: add per-call deadlines (10 s classifiers, 30 s Generate), bound the attempts to 2 and
    # retry only UNAVAILABLE, prune columns when the schemas exceed the token budget, and parse the
    # model output defensively instead of indexing into it.
    while True:
        try:
            return fn()
        except Exception:
            continue


def plan(question: str) -> tuple[str, list[str]]:
    intent = call(lambda: agents.Intent(agents_pb2.IntentRequest(question=question)))
    picked = call(
        lambda: agents.PickTables(agents_pb2.PickTablesRequest(question=question, workspace=intent.workspace))
    )
    return intent.workspace, list(picked.tables)


def generate(question: str, workspace: str, tables: list[str]) -> dict:
    schemas = schemas_for(tables)
    reply = call(
        lambda: agents.Generate(
            agents_pb2.GenerateRequest(question=question, workspace=workspace, tables=tables, schemas=schemas)
        )
    )
    parsed = json.loads(reply.text)
    return {"sql": parsed["sql"], "explanation": parsed["explanation"]}
`,
      solution: `import json

import grpc

import agents_pb2
import agents_pb2_grpc
from catalog import schemas_for

AGENT_DEADLINE_S = 10.0
GENERATE_DEADLINE_S = 30.0
MAX_ATTEMPTS = 2
SCHEMA_TOKEN_BUDGET = 24_000
RETRYABLE = {grpc.StatusCode.UNAVAILABLE}

agents = agents_pb2_grpc.AgentsStub(grpc.insecure_channel("agents:9000"))


class GenerationError(Exception):
    """The model answered, but not with something the service can use."""


def call(fn):
    last_error: grpc.RpcError | None = None
    for _ in range(MAX_ATTEMPTS):
        try:
            return fn()
        except grpc.RpcError as exc:
            last_error = exc
            if exc.code() not in RETRYABLE:
                raise
    raise last_error or RuntimeError("agent unavailable")


def estimate_tokens(schemas: list[str]) -> int:
    return sum(len(schema) for schema in schemas) // 4


def parse_output(text: str) -> dict:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GenerationError("model output is not JSON") from exc
    if not isinstance(parsed, dict):
        raise GenerationError("model output is not an object")
    sql = parsed.get("sql")
    explanation = parsed.get("explanation")
    if not isinstance(sql, str) or sql.strip() == "":
        raise GenerationError("model output has no sql")
    if not isinstance(explanation, str):
        raise GenerationError("model output has no explanation")
    return {"sql": sql.strip(), "explanation": explanation}


def plan(question: str) -> tuple[str, list[str]]:
    intent = call(lambda: agents.Intent(agents_pb2.IntentRequest(question=question), timeout=AGENT_DEADLINE_S))
    picked = call(
        lambda: agents.PickTables(
            agents_pb2.PickTablesRequest(question=question, workspace=intent.workspace), timeout=AGENT_DEADLINE_S
        )
    )
    return intent.workspace, list(picked.tables)


def generate(question: str, workspace: str, tables: list[str]) -> dict:
    schemas = schemas_for(tables)
    if estimate_tokens(schemas) > SCHEMA_TOKEN_BUDGET:
        pruned = call(
            lambda: agents.PruneColumns(
                agents_pb2.PruneColumnsRequest(question=question, schemas=schemas), timeout=AGENT_DEADLINE_S
            )
        )
        schemas = list(pruned.schemas)
    reply = call(
        lambda: agents.Generate(
            agents_pb2.GenerateRequest(question=question, workspace=workspace, tables=tables, schemas=schemas),
            timeout=GENERATE_DEADLINE_S,
        )
    )
    return parse_output(reply.text)
`,
    },
    typescript: {
      starter: `/** Agent chain: a model-generated draft that retries everything forever and trusts the output. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {schemasFor} from './catalog';

type Callback<R> = (error: grpc.ServiceError | null, reply: R) => void;

interface GenerateRequest {
  question: string;
  workspace: string;
  tables: string[];
  schemas: string[];
}

interface AgentsClient {
  Intent(request: {question: string}, callback: Callback<{workspace: string}>): void;
  PickTables(request: {question: string; workspace: string}, callback: Callback<{tables: string[]}>): void;
  Generate(request: GenerateRequest, callback: Callback<{text: string}>): void;
}

const {querygen} = grpc.loadPackageDefinition(protoLoader.loadSync('agents.proto')) as unknown as {
  querygen: {Agents: new (target: string, credentials: grpc.ChannelCredentials) => AgentsClient};
};
const agents = new querygen.Agents('agents:9000', grpc.credentials.createInsecure());

function unary<R>(start: (callback: Callback<R>) => void): Promise<R> {
  return new Promise((resolve, reject) => start((error, reply) => (error ? reject(error) : resolve(reply))));
}

async function withRetry<R>(call: () => Promise<R>): Promise<R> {
  // TODO: add per-call deadlines (10 s classifiers, 30 s Generate), bound the attempts to 2 and
  // retry only UNAVAILABLE, prune columns when the schemas exceed the token budget, and parse the
  // model output defensively instead of indexing into it.
  for (;;) {
    try {
      return await call();
    } catch {
      continue;
    }
  }
}

export async function plan(question: string): Promise<{workspace: string; tables: string[]}> {
  const intent = await withRetry(() => unary<{workspace: string}>(cb => agents.Intent({question}, cb)));
  const picked = await withRetry(() =>
    unary<{tables: string[]}>(cb => agents.PickTables({question, workspace: intent.workspace}, cb)),
  );
  return {workspace: intent.workspace, tables: picked.tables};
}

export async function generate(
  question: string,
  workspace: string,
  tables: string[],
): Promise<{sql: string; explanation: string}> {
  const schemas = await schemasFor(tables);
  const reply = await withRetry(() =>
    unary<{text: string}>(cb => agents.Generate({question, workspace, tables, schemas}, cb)),
  );
  const parsed = JSON.parse(reply.text) as {sql: string; explanation: string};
  return {sql: parsed.sql, explanation: parsed.explanation};
}
`,
      solution: `/** Agent chain: deadlines per call, two attempts on UNAVAILABLE only, pruning, parsed output. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {schemasFor} from './catalog';

const AGENT_DEADLINE_MS = 10_000;
const GENERATE_DEADLINE_MS = 30_000;
const MAX_ATTEMPTS = 2;
const SCHEMA_TOKEN_BUDGET = 24_000;

type Callback<R> = (error: grpc.ServiceError | null, reply: R) => void;

interface GenerateRequest {
  question: string;
  workspace: string;
  tables: string[];
  schemas: string[];
}

interface AgentsClient {
  Intent(request: {question: string}, options: grpc.CallOptions, callback: Callback<{workspace: string}>): void;
  PickTables(
    request: {question: string; workspace: string},
    options: grpc.CallOptions,
    callback: Callback<{tables: string[]}>,
  ): void;
  PruneColumns(
    request: {question: string; schemas: string[]},
    options: grpc.CallOptions,
    callback: Callback<{schemas: string[]}>,
  ): void;
  Generate(request: GenerateRequest, options: grpc.CallOptions, callback: Callback<{text: string}>): void;
}

const {querygen} = grpc.loadPackageDefinition(protoLoader.loadSync('agents.proto')) as unknown as {
  querygen: {Agents: new (target: string, credentials: grpc.ChannelCredentials) => AgentsClient};
};
const agents = new querygen.Agents('agents:9000', grpc.credentials.createInsecure());

export class GenerationError extends Error {}

function unary<R>(start: (callback: Callback<R>) => void): Promise<R> {
  return new Promise((resolve, reject) => start((error, reply) => (error ? reject(error) : resolve(reply))));
}

async function withRetry<R>(call: () => Promise<R>): Promise<R> {
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await call();
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      lastError = serviceError;
      if (serviceError.code !== grpc.status.UNAVAILABLE) throw serviceError;
    }
  }
  throw lastError ?? new Error('agent unavailable');
}

function estimateTokens(schemas: string[]): number {
  let chars = 0;
  for (const schema of schemas) chars += schema.length;
  return Math.floor(chars / 4);
}

export function parseOutput(text: string): {sql: string; explanation: string} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GenerationError('model output is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object') throw new GenerationError('model output is not an object');
  const {sql, explanation} = parsed as {sql?: unknown; explanation?: unknown};
  if (typeof sql !== 'string' || sql.trim() === '') throw new GenerationError('model output has no sql');
  if (typeof explanation !== 'string') throw new GenerationError('model output has no explanation');
  return {sql: sql.trim(), explanation};
}

export async function plan(question: string): Promise<{workspace: string; tables: string[]}> {
  const intent = await withRetry(() =>
    unary<{workspace: string}>(cb => agents.Intent({question}, {deadline: Date.now() + AGENT_DEADLINE_MS}, cb)),
  );
  const picked = await withRetry(() =>
    unary<{tables: string[]}>(cb =>
      agents.PickTables({question, workspace: intent.workspace}, {deadline: Date.now() + AGENT_DEADLINE_MS}, cb),
    ),
  );
  return {workspace: intent.workspace, tables: picked.tables};
}

export async function generate(
  question: string,
  workspace: string,
  tables: string[],
): Promise<{sql: string; explanation: string}> {
  let schemas = await schemasFor(tables);
  if (estimateTokens(schemas) > SCHEMA_TOKEN_BUDGET) {
    const pruned = await withRetry(() =>
      unary<{schemas: string[]}>(cb =>
        agents.PruneColumns({question, schemas}, {deadline: Date.now() + AGENT_DEADLINE_MS}, cb),
      ),
    );
    schemas = pruned.schemas;
  }
  const reply = await withRetry(() =>
    unary<{text: string}>(cb =>
      agents.Generate({question, workspace, tables, schemas}, {deadline: Date.now() + GENERATE_DEADLINE_MS}, cb),
    ),
  );
  return parseOutput(reply.text);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	pb "querygen/agentspb"
	"querygen/catalog"
)

type Generated struct {
	SQL         string \`json:"sql"\`
	Explanation string \`json:"explanation"\`
}

// TODO: add per-call deadlines (10 s classifiers, 30 s Generate), bound the attempts to 2 and
// retry only UNAVAILABLE, prune columns when the schemas exceed the token budget, and parse the
// model output defensively instead of indexing into it.
func withRetry[R any](ctx context.Context, call func(ctx context.Context) (R, error)) R {
	for {
		reply, err := call(ctx)
		if err != nil {
			continue
		}
		return reply
	}
}

func plan(ctx context.Context, agents pb.AgentsClient, question string) (string, []string) {
	intent := withRetry(ctx, func(ctx context.Context) (*pb.IntentReply, error) {
		return agents.Intent(ctx, &pb.IntentRequest{Question: question})
	})
	picked := withRetry(ctx, func(ctx context.Context) (*pb.PickTablesReply, error) {
		return agents.PickTables(ctx, &pb.PickTablesRequest{Question: question, Workspace: intent.Workspace})
	})
	return intent.Workspace, picked.Tables
}

func generate(ctx context.Context, agents pb.AgentsClient, question, workspace string, tables []string) Generated {
	schemas := catalog.SchemasFor(ctx, tables)
	reply := withRetry(ctx, func(ctx context.Context) (*pb.GenerateReply, error) {
		return agents.Generate(ctx, &pb.GenerateRequest{Question: question, Workspace: workspace, Tables: tables, Schemas: schemas})
	})
	var parsed map[string]any
	_ = json.Unmarshal([]byte(reply.Text), &parsed)
	return Generated{SQL: parsed["sql"].(string), Explanation: parsed["explanation"].(string)}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "querygen/agentspb"
	"querygen/catalog"
)

const (
	agentDeadline     = 10 * time.Second
	generateDeadline  = 30 * time.Second
	maxAttempts       = 2
	schemaTokenBudget = 24000
)

// ErrGeneration: the model answered, but not with something the service can use.
var ErrGeneration = errors.New("generation output unusable")

type Generated struct {
	SQL         string \`json:"sql"\`
	Explanation string \`json:"explanation"\`
}

func withRetry[R any](ctx context.Context, deadline time.Duration, call func(ctx context.Context) (R, error)) (R, error) {
	var zero R
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := call(callCtx)
		cancel()
		if err == nil {
			return reply, nil
		}
		lastErr = err
		if status.Code(err) != codes.Unavailable {
			return zero, err
		}
	}
	return zero, lastErr
}

func estimateTokens(schemas []string) int {
	chars := 0
	for _, schema := range schemas {
		chars += len(schema)
	}
	return chars / 4
}

func parseOutput(text string) (Generated, error) {
	var parsed struct {
		SQL         *string \`json:"sql"\`
		Explanation *string \`json:"explanation"\`
	}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return Generated{}, errors.Join(ErrGeneration, err)
	}
	if parsed.SQL == nil || strings.TrimSpace(*parsed.SQL) == "" {
		return Generated{}, errors.Join(ErrGeneration, errors.New("no sql"))
	}
	if parsed.Explanation == nil {
		return Generated{}, errors.Join(ErrGeneration, errors.New("no explanation"))
	}
	return Generated{SQL: strings.TrimSpace(*parsed.SQL), Explanation: *parsed.Explanation}, nil
}

func plan(ctx context.Context, agents pb.AgentsClient, question string) (string, []string, error) {
	intent, err := withRetry(ctx, agentDeadline, func(ctx context.Context) (*pb.IntentReply, error) {
		return agents.Intent(ctx, &pb.IntentRequest{Question: question})
	})
	if err != nil {
		return "", nil, err
	}
	picked, err := withRetry(ctx, agentDeadline, func(ctx context.Context) (*pb.PickTablesReply, error) {
		return agents.PickTables(ctx, &pb.PickTablesRequest{Question: question, Workspace: intent.Workspace})
	})
	if err != nil {
		return "", nil, err
	}
	return intent.Workspace, picked.Tables, nil
}

func generate(ctx context.Context, agents pb.AgentsClient, question, workspace string, tables []string) (Generated, error) {
	schemas := catalog.SchemasFor(ctx, tables)
	if estimateTokens(schemas) > schemaTokenBudget {
		pruned, err := withRetry(ctx, agentDeadline, func(ctx context.Context) (*pb.PruneColumnsReply, error) {
			return agents.PruneColumns(ctx, &pb.PruneColumnsRequest{Question: question, Schemas: schemas})
		})
		if err != nil {
			return Generated{}, err
		}
		schemas = pruned.Schemas
	}
	reply, err := withRetry(ctx, generateDeadline, func(ctx context.Context) (*pb.GenerateReply, error) {
		return agents.Generate(ctx, &pb.GenerateRequest{Question: question, Workspace: workspace, Tables: tables, Schemas: schemas})
	})
	if err != nil {
		return Generated{}, err
	}
	return parseOutput(reply.Text)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

final case class Generated(sql: String, explanation: String)

object AgentChain {
  val agents = AgentsGrpc.blockingStub(ManagedChannelBuilder.forAddress("agents", 9000).usePlaintext().build())

  // TODO: add per-call deadlines (10 s classifiers, 30 s Generate), bound the attempts to 2 and
  // retry only UNAVAILABLE, prune columns when the schemas exceed the token budget, and parse the
  // model output defensively instead of indexing into it.
  def withRetry[R](call: () => R): R = {
    var result: Option[R] = None
    while (true) {
      try {
        result = Some(call())
        return result.get
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    result.get
  }

  def plan(question: String): (String, Seq[String]) = {
    val intent = withRetry(() => agents.intent(IntentRequest(question = question)))
    val picked = withRetry(() => agents.pickTables(PickTablesRequest(question = question, workspace = intent.workspace)))
    (intent.workspace, picked.tables)
  }

  def generate(question: String, workspace: String, tables: Seq[String]): Generated = {
    val schemas = Catalog.schemasFor(tables)
    val reply = withRetry(() =>
      agents.generate(GenerateRequest(question = question, workspace = workspace, tables = tables, schemas = schemas))
    )
    val fields = reply.text.parseJson.asJsObject.fields
    Generated(fields("sql").convertTo[String], fields("explanation").convertTo[String])
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.Try

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import spray.json._

final case class Generated(sql: String, explanation: String)
final class GenerationError(message: String) extends RuntimeException(message)

object AgentChain {
  val AgentDeadlineMs = 10000L
  val GenerateDeadlineMs = 30000L
  val MaxAttempts = 2
  val SchemaTokenBudget = 24000

  val agents = AgentsGrpc.blockingStub(ManagedChannelBuilder.forAddress("agents", 9000).usePlaintext().build())

  def withRetry[R](call: () => R): R = {
    var lastError: Option[StatusRuntimeException] = None
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        return call()
      } catch {
        case exc: StatusRuntimeException =>
          lastError = Some(exc)
          if (exc.getStatus.getCode != Status.Code.UNAVAILABLE) throw exc
      }
      attempt += 1
    }
    throw lastError.getOrElse(new RuntimeException("agent unavailable"))
  }

  def estimateTokens(schemas: Seq[String]): Int = schemas.map(_.length).sum / 4

  def parseOutput(text: String): Generated = {
    val parsed = Try(text.parseJson).getOrElse(throw new GenerationError("model output is not JSON"))
    val fields = parsed match {
      case JsObject(f) => f
      case _ => throw new GenerationError("model output is not an object")
    }
    val sql = fields.get("sql") match {
      case Some(JsString(s)) if s.trim.nonEmpty => s.trim
      case _ => throw new GenerationError("model output has no sql")
    }
    val explanation = fields.get("explanation") match {
      case Some(JsString(e)) => e
      case _ => throw new GenerationError("model output has no explanation")
    }
    Generated(sql, explanation)
  }

  def plan(question: String): (String, Seq[String]) = {
    val intent = withRetry(() =>
      agents.withDeadlineAfter(AgentDeadlineMs, TimeUnit.MILLISECONDS).intent(IntentRequest(question = question))
    )
    val picked = withRetry(() =>
      agents
        .withDeadlineAfter(AgentDeadlineMs, TimeUnit.MILLISECONDS)
        .pickTables(PickTablesRequest(question = question, workspace = intent.workspace))
    )
    (intent.workspace, picked.tables)
  }

  def generate(question: String, workspace: String, tables: Seq[String]): Generated = {
    var schemas = Catalog.schemasFor(tables)
    if (estimateTokens(schemas) > SchemaTokenBudget) {
      val pruned = withRetry(() =>
        agents
          .withDeadlineAfter(AgentDeadlineMs, TimeUnit.MILLISECONDS)
          .pruneColumns(PruneColumnsRequest(question = question, schemas = schemas))
      )
      schemas = pruned.schemas
    }
    val reply = withRetry(() =>
      agents
        .withDeadlineAfter(GenerateDeadlineMs, TimeUnit.MILLISECONDS)
        .generate(GenerateRequest(question = question, workspace = workspace, tables = tables, schemas = schemas))
    )
    parseOutput(reply.text)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "agents.grpc.pb.h"

#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

struct Generated {
  std::string sql;
  std::string explanation;
};

std::vector<std::string> schemasFor(const std::vector<std::string>& tables);

// TODO: add per-call deadlines (10 s classifiers, 30 s Generate), bound the attempts to 2 and
// retry only UNAVAILABLE, prune columns when the schemas exceed the token budget, and parse the
// model output defensively instead of indexing into it.
template <typename Call>
void withRetry(Call call) {
  while (true) {
    grpc::ClientContext ctx;
    if (call(ctx).ok()) return;
  }
}

std::pair<std::string, std::vector<std::string>> plan(Agents::Stub* agents, const std::string& question) {
  IntentRequest intentRequest;
  intentRequest.set_question(question);
  IntentReply intent;
  withRetry([&](grpc::ClientContext& ctx) { return agents->Intent(&ctx, intentRequest, &intent); });
  PickTablesRequest pickRequest;
  pickRequest.set_question(question);
  pickRequest.set_workspace(intent.workspace());
  PickTablesReply picked;
  withRetry([&](grpc::ClientContext& ctx) { return agents->PickTables(&ctx, pickRequest, &picked); });
  return {intent.workspace(), std::vector<std::string>(picked.tables().begin(), picked.tables().end())};
}

Generated generate(
    Agents::Stub* agents,
    const std::string& question,
    const std::string& workspace,
    const std::vector<std::string>& tables) {
  const auto schemas = schemasFor(tables);
  GenerateRequest request;
  request.set_question(question);
  request.set_workspace(workspace);
  for (const auto& table : tables) request.add_tables(table);
  for (const auto& schema : schemas) request.add_schemas(schema);
  GenerateReply reply;
  withRetry([&](grpc::ClientContext& ctx) { return agents->Generate(&ctx, request, &reply); });
  const json parsed = json::parse(reply.text());
  return {parsed["sql"].get<std::string>(), parsed["explanation"].get<std::string>()};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "agents.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

constexpr int kAgentDeadlineMs = 10000;
constexpr int kGenerateDeadlineMs = 30000;
constexpr int kMaxAttempts = 2;
constexpr int kSchemaTokenBudget = 24000;

struct Generated {
  std::string sql;
  std::string explanation;
};

// The model answered, but not with something the service can use.
class GenerationError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

std::vector<std::string> schemasFor(const std::vector<std::string>& tables);

template <typename Call>
grpc::Status withRetry(int deadlineMs, Call call) {
  grpc::Status last;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(deadlineMs));
    last = call(ctx);
    if (last.ok() || last.error_code() != grpc::StatusCode::UNAVAILABLE) return last;
  }
  return last;
}

int estimateTokens(const std::vector<std::string>& schemas) {
  std::size_t chars = 0;
  for (const auto& schema : schemas) chars += schema.size();
  return static_cast<int>(chars / 4);
}

std::string trimmed(const std::string& s) {
  const auto first = s.find_first_not_of(" \\t\\r\\n");
  if (first == std::string::npos) return "";
  const auto last = s.find_last_not_of(" \\t\\r\\n");
  return s.substr(first, last - first + 1);
}

Generated parseOutput(const std::string& text) {
  const json parsed = json::parse(text, nullptr, false);
  if (parsed.is_discarded()) throw GenerationError("model output is not JSON");
  if (!parsed.is_object()) throw GenerationError("model output is not an object");
  if (!parsed.contains("sql") || !parsed["sql"].is_string() || trimmed(parsed["sql"].get<std::string>()).empty())
    throw GenerationError("model output has no sql");
  if (!parsed.contains("explanation") || !parsed["explanation"].is_string())
    throw GenerationError("model output has no explanation");
  return {trimmed(parsed["sql"].get<std::string>()), parsed["explanation"].get<std::string>()};
}

std::pair<std::string, std::vector<std::string>> plan(Agents::Stub* agents, const std::string& question) {
  IntentRequest intentRequest;
  intentRequest.set_question(question);
  IntentReply intent;
  const auto intentStatus =
      withRetry(kAgentDeadlineMs, [&](grpc::ClientContext& ctx) { return agents->Intent(&ctx, intentRequest, &intent); });
  if (!intentStatus.ok()) throw std::runtime_error("intent agent: " + intentStatus.error_message());
  PickTablesRequest pickRequest;
  pickRequest.set_question(question);
  pickRequest.set_workspace(intent.workspace());
  PickTablesReply picked;
  const auto pickStatus = withRetry(
      kAgentDeadlineMs, [&](grpc::ClientContext& ctx) { return agents->PickTables(&ctx, pickRequest, &picked); });
  if (!pickStatus.ok()) throw std::runtime_error("table agent: " + pickStatus.error_message());
  return {intent.workspace(), std::vector<std::string>(picked.tables().begin(), picked.tables().end())};
}

Generated generate(
    Agents::Stub* agents,
    const std::string& question,
    const std::string& workspace,
    const std::vector<std::string>& tables) {
  auto schemas = schemasFor(tables);
  if (estimateTokens(schemas) > kSchemaTokenBudget) {
    PruneColumnsRequest pruneRequest;
    pruneRequest.set_question(question);
    for (const auto& schema : schemas) pruneRequest.add_schemas(schema);
    PruneColumnsReply pruned;
    const auto pruneStatus = withRetry(
        kAgentDeadlineMs, [&](grpc::ClientContext& ctx) { return agents->PruneColumns(&ctx, pruneRequest, &pruned); });
    if (!pruneStatus.ok()) throw std::runtime_error("column prune agent: " + pruneStatus.error_message());
    schemas.assign(pruned.schemas().begin(), pruned.schemas().end());
  }
  GenerateRequest request;
  request.set_question(question);
  request.set_workspace(workspace);
  for (const auto& table : tables) request.add_tables(table);
  for (const auto& schema : schemas) request.add_schemas(schema);
  GenerateReply reply;
  const auto status =
      withRetry(kGenerateDeadlineMs, [&](grpc::ClientContext& ctx) { return agents->Generate(&ctx, request, &reply); });
  if (!status.ok()) throw std::runtime_error("generate: " + status.error_message());
  return parseOutput(reply.text());
}
`,
    },
  },
  debrief: `The interviewer is asking one question in four forms: what is the worst case of each model call? A deadline bounds one attempt; the attempt cap and the retryable set bound the call — and the set is tiny on purpose, because an \`INVALID_ARGUMENT\` from a classifier will be an \`INVALID_ARGUMENT\` on the next try too. The token estimate bounds the input: QueryGPT's wide tables are the concrete reason the column prune agent exists, and the source is explicit that pruning fixed the intermittent token failures and lowered the cost and latency of every generation. The parser bounds the output: a model that is asked for JSON returns JSON most of the time, and a service that assumes "most" is "always" ships a 500 on the remainder. Real services add a validation agent that checks the generated tables and columns exist and asks the model to repair them, a prompt enhancer in front of the intent agent, and jittered backoff between the two attempts.`,
};
