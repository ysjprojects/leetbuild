import type {Step} from '@/lib/types';

export const agentChainStep: Step = {
  id: 'agent-chain',
  title: 'Agent chain: deadlines, column pruning, parsed output',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'model-output'],
  file: 'agent_chain',
  focus: ['api', 'agents', 'workspaces'],
  task: `## Task

**Starting point.** The starter is \`generate_sql(question, workspace, tables)\`, which the service calls
once the user ACKs the tables: it renders each table's DDL with \`schema_for\` (\`querygen.catalog\`),
calls \`Agents.Generate\` (\`text_to_sql.proto\`, a stand-in at \`AGENTS\`) through a \`call\` helper that
asks again after every error, and returns \`parse_output(reply.text)\`, which indexes
\`json.loads(text)["sql"]\`. A defined \`GenerationError\` is never raised. It answers the demo in one call
and hides 4 flaws.

**Failure mode the checks target.** A generator that hangs holds the request open; a bad argument
pins a worker in a retry loop; two Tier-1 tables (about 18 000 tokens of DDL each) overflow the
model's 32 000-token window on every try; and one chatty answer is a 500.

Requirements:

- Deadlines on every call: \`AGENT_DEADLINE_S\` (10 s) on \`PruneColumns\`, \`GENERATE_DEADLINE_S\` (30 s)
  on \`Generate\`.
- At most \`MAX_ATTEMPTS\` = 2 per call, and only \`UNAVAILABLE\` is retried; any other failure raises
  \`GenerationError\`.
- When \`estimate_tokens(schemas)\` (characters / 4) exceeds \`SCHEMA_TOKEN_BUDGET\` = 24 000, call
  \`PruneColumns\` and generate from the schemas it returns.
- \`parse_output\` raises \`GenerationError\` for text that is not a JSON object, a missing or non-string
  \`sql\` or \`explanation\`, or a blank \`sql\`.`,
  sequence: {
    participants: ['querygen', 'Catalog', 'Agents'],
    messages: [
      {from: 'querygen', to: 'Catalog', label: 'schema_for(acked tables)', kind: 'sync'},
      {from: 'Catalog', to: 'querygen', label: 'DDL · estimate_tokens = chars / 4', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'PruneColumns(question, schemas) when > 24 000 · 10 s', kind: 'sync'},
      {from: 'Agents', to: 'querygen', label: '{schemas} without unused columns', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'Generate(question, workspace, schemas) · 30 s', kind: 'sync'},
      {
        from: 'Agents',
        to: 'querygen',
        label: 'UNAVAILABLE → one retry; anything else → GenerationError',
        kind: 'reply',
      },
      {from: 'Agents', to: 'querygen', label: '{text} → parse_output → {sql, explanation}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadlines',
      title: 'Generate gets 30 s, PruneColumns 10 s',
      detail:
        'Every Generate call carries a deadline of about 30 s and every PruneColumns call about 10 s; a generator that hangs ends the call at the deadline with GenerationError. The starter sends no deadline and waits the hang out.',
      match: {
        python: {all: [/GENERATE_DEADLINE_S/, /AGENT_DEADLINE_S/, /timeout\s*=/]},
        typescript: {all: [/GENERATE_DEADLINE_MS/, /AGENT_DEADLINE_MS/, /deadline:\s*Date\.now\(\)\s*\+/]},
        go: {all: [/config\.GenerateDeadline/, /config\.AgentDeadline/, /context\.WithTimeout\(/]},
        scala: {all: [/Config\.GenerateDeadlineMs/, /Config\.AgentDeadlineMs/, /withDeadlineAfter\(/]},
        cpp: {all: [/config::kGenerateDeadline/, /config::kAgentDeadline/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'At most two attempts, only UNAVAILABLE retried',
      detail:
        'One UNAVAILABLE earns one retry after a backoff; two in a row end in GenerationError after two calls; INVALID_ARGUMENT ends it after one. The starter asks again after any error, for ever.',
      match: {
        python: {all: [/grpc\.StatusCode\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/while\s+True/]},
        typescript: {all: [/status\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/codes\.Unavailable/, /maxAttempts/], none: [/for\s*\{/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/, /MaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {
          all: [/grpc::StatusCode::UNAVAILABLE/, /kMaxAttempts/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
    {
      id: 'prune-over-budget',
      title: 'Prunes columns when the schemas exceed the token budget',
      detail:
        'Two Tier-1 tables (about 36 000 tokens) go through PruneColumns and Generate receives the pruned schemas; one small table goes straight to Generate. The starter never prunes, so the generator refuses the oversized prompt.',
      match: {
        python: {
          order: [/estimate_tokens\(\s*schemas\s*\)\s*>\s*SCHEMA_TOKEN_BUDGET/, /stub\.PruneColumns/, /stub\.Generate/],
        },
        typescript: {
          order: [
            /estimateTokens\(\s*schemas\s*\)\s*>\s*SCHEMA_TOKEN_BUDGET/,
            /stub\.PruneColumns\(/,
            /stub\.Generate\(/,
          ],
        },
        go: {
          order: [
            /estimateTokens\(\s*schemas\s*\)\s*>\s*schemaTokenBudget/,
            /stub\.PruneColumns\(/,
            /stub\.Generate\(/,
          ],
        },
        scala: {order: [/estimateTokens\(\s*schemas\s*\)\s*>\s*SchemaTokenBudget/, /\.pruneColumns\(/, /\.generate\(/]},
        cpp: {
          order: [
            /estimate_tokens\(\s*schemas\s*\)\s*>\s*kSchemaTokenBudget/,
            /stub->PruneColumns\(/,
            /stub->Generate\(/,
          ],
        },
      },
    },
    {
      id: 'parse-output',
      title: 'Turns an unusable model answer into GenerationError',
      detail:
        'Prose instead of JSON, JSON without sql, and a blank sql each raise GenerationError, and a well-formed answer comes back as {sql, explanation}. The starter indexes into the parsed text and raises whatever the parser or the lookup raises.',
      match: {
        python: {all: [/raise GenerationError/, /except\s+\(?\s*(json\.JSONDecodeError|ValueError)/]},
        typescript: {all: [/throw new GenerationError/, /catch/]},
        go: {all: [/fmt\.Errorf\(\s*"%w/, /errGeneration/, /json\.Unmarshal\(/]},
        scala: {all: [/throw\s+(new\s+)?GenerationError/, /Try\(|catch/]},
        cpp: {all: [/throw GenerationError/, /is_discarded\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import grpc

import text_to_sql_pb2
import text_to_sql_pb2_grpc
from querygen.catalog import schema_for
from querygen.config import AGENTS

BACKOFF_S = 0.5

stub = text_to_sql_pb2_grpc.AgentsStub(grpc.insecure_channel(AGENTS))


class GenerationError(Exception):
    """The chain produced nothing usable: an agent failed or the model's answer is not SQL."""


def call(method, request):
    """One agent call: ask until the agent answers."""
    while True:
        try:
            return method(request)
        except grpc.RpcError:
            time.sleep(BACKOFF_S)


def parse_output(text: str) -> dict:
    """The generator's answer as {"sql", "explanation"}."""
    out = json.loads(text)
    return {"sql": out["sql"], "explanation": out.get("explanation", "")}


def generate_sql(question: str, workspace: str, tables: list[str]) -> dict:
    """SQL for an ACKed question: the tables' schemas, then the generator."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    schemas = [schema_for(t) for t in tables]
    reply = call(stub.Generate, text_to_sql_pb2.GenerateRequest(question=question, workspace=workspace, schemas=schemas))
    return parse_output(reply.text)
`,
      solution: `import json
import time

import grpc

import text_to_sql_pb2
import text_to_sql_pb2_grpc
from querygen.catalog import schema_for
from querygen.config import AGENT_DEADLINE_S, AGENTS, GENERATE_DEADLINE_S

SCHEMA_TOKEN_BUDGET = 24_000
MAX_ATTEMPTS = 2
BACKOFF_S = 0.5

stub = text_to_sql_pb2_grpc.AgentsStub(grpc.insecure_channel(AGENTS))


class GenerationError(Exception):
    """The chain produced nothing usable: an agent failed or the model's answer is not SQL."""


def call(method, request, timeout_s: float):
    """One agent call under a deadline; only UNAVAILABLE (the agent restarting) is worth a second try."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return method(request, timeout=timeout_s)
        except grpc.RpcError as err:
            if err.code() == grpc.StatusCode.UNAVAILABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S)
                continue
            raise GenerationError(f"agent call failed: {err.code().name}") from err
    raise GenerationError("agent call failed")


def estimate_tokens(schemas: list[str]) -> int:
    """About four characters per token: close enough to decide whether to prune."""
    return sum(len(s) for s in schemas) // 4


def parse_output(text: str) -> dict:
    """The generator's answer as {"sql", "explanation"}; GenerationError when it is not usable."""
    try:
        out = json.loads(text)
    except ValueError as err:
        raise GenerationError("the model's answer is not JSON") from err
    if not isinstance(out, dict):
        raise GenerationError("the model's answer is not a JSON object")
    sql, explanation = out.get("sql"), out.get("explanation")
    if not isinstance(sql, str) or not isinstance(explanation, str) or sql.strip() == "":
        raise GenerationError("the model's answer has no SQL")
    return {"sql": sql, "explanation": explanation}


def generate_sql(question: str, workspace: str, tables: list[str]) -> dict:
    """SQL for an ACKed question: the tables' schemas, pruned when too wide, then the generator."""
    schemas = [schema_for(t) for t in tables]
    if estimate_tokens(schemas) > SCHEMA_TOKEN_BUDGET:
        pruned = call(stub.PruneColumns, text_to_sql_pb2.PruneColumnsRequest(question=question, schemas=schemas), AGENT_DEADLINE_S)
        schemas = list(pruned.schemas)
    reply = call(
        stub.Generate,
        text_to_sql_pb2.GenerateRequest(question=question, workspace=workspace, schemas=schemas),
        GENERATE_DEADLINE_S,
    )
    return parse_output(reply.text)
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {schemaFor} from 'querygen/catalog';
import {AGENTS} from 'querygen/config';

export const BACKOFF_MS = 500;

interface CallOptions {
  deadline?: number;
}
interface AgentsClient {
  PruneColumns(request: {question: string; schemas: string[]}, options?: CallOptions): Promise<{schemas: string[]}>;
  Generate(request: {question: string; workspace: string; schemas: string[]}, options?: CallOptions): Promise<{text: string}>;
}

const {sqlagents} = grpc.loadPackageDefinition(protoLoader.loadSync('text_to_sql.proto')) as unknown as {
  sqlagents: {Agents: new (target: string, credentials: grpc.ChannelCredentials) => AgentsClient};
};
const stub = new sqlagents.Agents(AGENTS, grpc.credentials.createInsecure());

/** The chain produced nothing usable: an agent failed or the model's answer is not SQL. */
export class GenerationError extends Error {}

export interface Output {
  sql: string;
  explanation: string;
}

/** One agent call: ask until the agent answers. */
async function call<T>(invoke: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      return await invoke();
    } catch {
      await sleep(BACKOFF_MS);
    }
  }
}

/** The generator's answer as {sql, explanation}. */
export function parseOutput(text: string): Output {
  const out = JSON.parse(text) as {sql: string; explanation?: string};
  return {sql: out.sql, explanation: out.explanation ?? ''};
}

/** SQL for an ACKed question: the tables' schemas, then the generator. */
export async function generateSql(question: string, workspace: string, tables: string[]): Promise<Output> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const schemas = tables.map(schemaFor);
  const reply = await call(() => stub.Generate({question, workspace, schemas}));
  return parseOutput(reply.text);
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {schemaFor} from 'querygen/catalog';
import {AGENT_DEADLINE_MS, AGENTS, GENERATE_DEADLINE_MS} from 'querygen/config';

export const SCHEMA_TOKEN_BUDGET = 24_000;
export const MAX_ATTEMPTS = 2;
export const BACKOFF_MS = 500;

interface CallOptions {
  deadline?: number;
}
interface AgentsClient {
  PruneColumns(request: {question: string; schemas: string[]}, options?: CallOptions): Promise<{schemas: string[]}>;
  Generate(request: {question: string; workspace: string; schemas: string[]}, options?: CallOptions): Promise<{text: string}>;
}

const {sqlagents} = grpc.loadPackageDefinition(protoLoader.loadSync('text_to_sql.proto')) as unknown as {
  sqlagents: {Agents: new (target: string, credentials: grpc.ChannelCredentials) => AgentsClient};
};
const stub = new sqlagents.Agents(AGENTS, grpc.credentials.createInsecure());

/** The chain produced nothing usable: an agent failed or the model's answer is not SQL. */
export class GenerationError extends Error {}

export interface Output {
  sql: string;
  explanation: string;
}

/** One agent call under a deadline; only UNAVAILABLE (the agent restarting) is worth a second try. */
async function call<T>(invoke: (options: CallOptions) => Promise<T>, deadlineMs: number): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await invoke({deadline: Date.now() + deadlineMs});
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS);
        continue;
      }
      throw new GenerationError(\`agent call failed: \${grpc.status[code] ?? code}\`);
    }
  }
  throw new GenerationError('agent call failed');
}

/** About four characters per token: close enough to decide whether to prune. */
export function estimateTokens(schemas: string[]): number {
  return Math.floor(schemas.reduce((n, s) => n + s.length, 0) / 4);
}

/** The generator's answer as {sql, explanation}; GenerationError when it is not usable. */
export function parseOutput(text: string): Output {
  let out: unknown;
  try {
    out = JSON.parse(text);
  } catch {
    throw new GenerationError("the model's answer is not JSON");
  }
  if (out === null || typeof out !== 'object' || Array.isArray(out))
    throw new GenerationError("the model's answer is not a JSON object");
  const {sql, explanation} = out as Record<string, unknown>;
  if (typeof sql !== 'string' || typeof explanation !== 'string' || sql.trim() === '')
    throw new GenerationError("the model's answer has no SQL");
  return {sql, explanation};
}

/** SQL for an ACKed question: the tables' schemas, pruned when too wide, then the generator. */
export async function generateSql(question: string, workspace: string, tables: string[]): Promise<Output> {
  let schemas = tables.map(schemaFor);
  if (estimateTokens(schemas) > SCHEMA_TOKEN_BUDGET) {
    const pruned = await call(options => stub.PruneColumns({question, schemas}, options), AGENT_DEADLINE_MS);
    schemas = pruned.schemas;
  }
  const reply = await call(options => stub.Generate({question, workspace, schemas}, options), GENERATE_DEADLINE_MS);
  return parseOutput(reply.text);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"querygen/catalog" // catalog.SchemaFor(table) — provided
	"querygen/config"  // config.Agents — provided
	pb "sqlagents/gen/text_to_sql"
)

const backoff = 500 * time.Millisecond

var conn, _ = grpc.NewClient(config.Agents, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewAgentsClient(conn)

// errGeneration: the chain produced nothing usable (an agent failed or the model's answer is not SQL).
var errGeneration = errors.New("generation failed")

// Output is the generator's answer.
type Output struct {
	SQL         string \`json:"sql"\`
	Explanation string \`json:"explanation"\`
}

// call makes one agent call: it asks until the agent answers.
func call(ctx context.Context, rpc func(context.Context) error) error {
	for {
		if err := rpc(ctx); err == nil {
			return nil
		}
		time.Sleep(backoff)
	}
}

// parseOutput is the generator's answer as an Output.
func parseOutput(text string) (Output, error) {
	var out Output
	err := json.Unmarshal([]byte(text), &out)
	return out, err
}

// generateSQL is SQL for an ACKed question: the tables' schemas, then the generator.
func generateSQL(ctx context.Context, question, workspace string, tables []string) (Output, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	schemas := make([]string, 0, len(tables))
	for _, t := range tables {
		schemas = append(schemas, catalog.SchemaFor(t))
	}
	var reply *pb.GenerateReply
	err := call(ctx, func(ctx context.Context) error {
		var err error
		reply, err = stub.Generate(ctx, &pb.GenerateRequest{Question: question, Workspace: workspace, Schemas: schemas})
		return err
	})
	if err != nil {
		return Output{}, err
	}
	return parseOutput(reply.GetText())
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

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"querygen/catalog" // catalog.SchemaFor(table) — provided
	"querygen/config"  // config.Agents, config.AgentDeadline, config.GenerateDeadline — provided
	pb "sqlagents/gen/text_to_sql"
)

const (
	schemaTokenBudget = 24_000
	maxAttempts       = 2
	backoff           = 500 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Agents, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewAgentsClient(conn)

// errGeneration: the chain produced nothing usable (an agent failed or the model's answer is not SQL).
var errGeneration = errors.New("generation failed")

// Output is the generator's answer.
type Output struct {
	SQL         string \`json:"sql"\`
	Explanation string \`json:"explanation"\`
}

// call makes one agent call under a deadline; only Unavailable (the agent restarting) is worth a second try.
func call(ctx context.Context, deadline time.Duration, rpc func(context.Context) error) error {
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		err := rpc(callCtx)
		cancel()
		if err == nil {
			return nil
		}
		if status.Code(err) == codes.Unavailable && attempt < maxAttempts {
			time.Sleep(backoff)
			continue
		}
		return fmt.Errorf("%w: agent call failed: %v", errGeneration, status.Code(err))
	}
	return fmt.Errorf("%w: agent call failed", errGeneration)
}

// estimateTokens: about four characters per token, close enough to decide whether to prune.
func estimateTokens(schemas []string) int {
	n := 0
	for _, s := range schemas {
		n += len(s)
	}
	return n / 4
}

// parseOutput is the generator's answer as an Output; errGeneration when it is not usable.
func parseOutput(text string) (Output, error) {
	var raw map[string]any
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return Output{}, fmt.Errorf("%w: the model's answer is not a JSON object", errGeneration)
	}
	sql, okSQL := raw["sql"].(string)
	explanation, okExplanation := raw["explanation"].(string)
	if !okSQL || !okExplanation || strings.TrimSpace(sql) == "" {
		return Output{}, fmt.Errorf("%w: the model's answer has no SQL", errGeneration)
	}
	return Output{SQL: sql, Explanation: explanation}, nil
}

// generateSQL is SQL for an ACKed question: the tables' schemas, pruned when too wide, then the generator.
func generateSQL(ctx context.Context, question, workspace string, tables []string) (Output, error) {
	schemas := make([]string, 0, len(tables))
	for _, t := range tables {
		schemas = append(schemas, catalog.SchemaFor(t))
	}
	if estimateTokens(schemas) > schemaTokenBudget {
		err := call(ctx, config.AgentDeadline, func(ctx context.Context) error {
			pruned, err := stub.PruneColumns(ctx, &pb.PruneColumnsRequest{Question: question, Schemas: schemas})
			if err == nil {
				schemas = pruned.GetSchemas()
			}
			return err
		})
		if err != nil {
			return Output{}, err
		}
	}
	var reply *pb.GenerateReply
	err := call(ctx, config.GenerateDeadline, func(ctx context.Context) error {
		var err error
		reply, err = stub.Generate(ctx, &pb.GenerateRequest{Question: question, Workspace: workspace, Schemas: schemas})
		return err
	})
	if err != nil {
		return Output{}, err
	}
	return parseOutput(reply.GetText())
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import querygen.{Catalog, Config}
import sqlagents.text_to_sql.{AgentsGrpc, GenerateRequest}

/** The chain produced nothing usable: an agent failed or the model's answer is not SQL. */
final case class GenerationError(reason: String) extends Exception(reason)

/** The generator's answer. */
final case class Output(sql: String, explanation: String)

object AgentChain {
  val BackoffMs = 500L

  private val channel = ManagedChannelBuilder.forTarget(Config.Agents).usePlaintext().build()
  private val stub = AgentsGrpc.blockingStub(channel)

  /** One agent call: ask until the agent answers. */
  private def call[T](rpc: => T): T = {
    var result: Option[T] = None
    while (true) {
      try return rpc
      catch { case _: StatusRuntimeException => Thread.sleep(BackoffMs) }
    }
    result.get
  }

  /** The generator's answer as an Output. */
  def parseOutput(text: String): Output = {
    val out = ujson.read(text)
    Output(out("sql").str, out.obj.get("explanation").map(_.str).getOrElse(""))
  }

  /** SQL for an ACKed question: the tables' schemas, then the generator. */
  def generateSql(question: String, workspace: String, tables: List[String]): Output = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val schemas = tables.map(Catalog.schemaFor)
    val reply = call(stub.generate(GenerateRequest(question = question, workspace = workspace, schemas = schemas)))
    parseOutput(reply.text)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.Try

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import querygen.{Catalog, Config}
import sqlagents.text_to_sql.AgentsGrpc.AgentsBlockingStub
import sqlagents.text_to_sql.{AgentsGrpc, GenerateRequest, PruneColumnsRequest}

/** The chain produced nothing usable: an agent failed or the model's answer is not SQL. */
final case class GenerationError(reason: String) extends Exception(reason)

/** The generator's answer. */
final case class Output(sql: String, explanation: String)

object AgentChain {
  val SchemaTokenBudget = 24000
  val MaxAttempts = 2
  val BackoffMs = 500L

  private val channel = ManagedChannelBuilder.forTarget(Config.Agents).usePlaintext().build()
  private val stub = AgentsGrpc.blockingStub(channel)

  /** One agent call under a deadline; only UNAVAILABLE (the agent restarting) is worth a second try. */
  private def call[T](deadlineMs: Long)(rpc: AgentsBlockingStub => T): T = {
    var attempt = 1
    var result: Option[T] = None
    while (result.isEmpty) {
      try result = Some(rpc(stub.withDeadlineAfter(deadlineMs, TimeUnit.MILLISECONDS)))
      catch {
        case e: StatusRuntimeException =>
          if (e.getStatus.getCode == Status.Code.UNAVAILABLE && attempt < MaxAttempts) {
            Thread.sleep(BackoffMs)
            attempt += 1
          } else throw GenerationError(s"agent call failed: \${e.getStatus.getCode}")
      }
    }
    result.get
  }

  /** About four characters per token: close enough to decide whether to prune. */
  def estimateTokens(schemas: Seq[String]): Int = schemas.map(_.length).sum / 4

  /** The generator's answer as an Output; GenerationError when it is not usable. */
  def parseOutput(text: String): Output = {
    val out = Try(ujson.read(text)).getOrElse(throw GenerationError("the model's answer is not JSON"))
    val fields = out.objOpt.getOrElse(throw GenerationError("the model's answer is not a JSON object"))
    (fields.get("sql").flatMap(_.strOpt), fields.get("explanation").flatMap(_.strOpt)) match {
      case (Some(sql), Some(explanation)) if sql.trim.nonEmpty => Output(sql, explanation)
      case _ => throw GenerationError("the model's answer has no SQL")
    }
  }

  /** SQL for an ACKed question: the tables' schemas, pruned when too wide, then the generator. */
  def generateSql(question: String, workspace: String, tables: List[String]): Output = {
    var schemas: Seq[String] = tables.map(Catalog.schemaFor)
    if (estimateTokens(schemas) > SchemaTokenBudget)
      schemas = call(Config.AgentDeadlineMs)(_.pruneColumns(PruneColumnsRequest(question = question, schemas = schemas))).schemas
    val reply = call(Config.GenerateDeadlineMs)(_.generate(GenerateRequest(question = question, workspace = workspace, schemas = schemas)))
    parseOutput(reply.text)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <functional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "querygen/catalog.h"  // catalog::schema_for(table) — provided
#include "querygen/config.h"   // config::kAgents — provided
#include "text_to_sql.grpc.pb.h"

constexpr std::chrono::milliseconds kBackoff{500};

auto channel = grpc::CreateChannel(config::kAgents, grpc::InsecureChannelCredentials());
auto stub = sqlagents::Agents::NewStub(channel);

// The chain produced nothing usable: an agent failed or the model's answer is not SQL.
struct GenerationError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The generator's answer.
struct Output {
  std::string sql;
  std::string explanation;
};

// One agent call: ask until the agent answers.
void call(const std::function<grpc::Status(grpc::ClientContext&)>& rpc) {
  while (true) {
    grpc::ClientContext ctx;
    if (rpc(ctx).ok()) return;
    std::this_thread::sleep_for(kBackoff);
  }
}

// The generator's answer as an Output.
Output parse_output(const std::string& text) {
  nlohmann::json out = nlohmann::json::parse(text);
  return {out["sql"].get<std::string>(), out.value("explanation", std::string())};
}

// SQL for an ACKed question: the tables' schemas, then the generator.
Output generate_sql(const std::string& question, const std::string& workspace, const std::vector<std::string>& tables) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  sqlagents::GenerateRequest request;
  request.set_question(question);
  request.set_workspace(workspace);
  for (const auto& t : tables) request.add_schemas(catalog::schema_for(t));
  sqlagents::GenerateReply reply;
  call([&](grpc::ClientContext& ctx) { return stub->Generate(&ctx, request, &reply); });
  return parse_output(reply.text());
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <functional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "querygen/catalog.h"  // catalog::schema_for(table) — provided
#include "querygen/config.h"   // config::kAgents, kAgentDeadline, kGenerateDeadline — provided
#include "text_to_sql.grpc.pb.h"

constexpr long long kSchemaTokenBudget = 24000;
constexpr int kMaxAttempts = 2;
constexpr std::chrono::milliseconds kBackoff{500};

auto channel = grpc::CreateChannel(config::kAgents, grpc::InsecureChannelCredentials());
auto stub = sqlagents::Agents::NewStub(channel);

// The chain produced nothing usable: an agent failed or the model's answer is not SQL.
struct GenerationError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The generator's answer.
struct Output {
  std::string sql;
  std::string explanation;
};

// One agent call under a deadline; only UNAVAILABLE (the agent restarting) is worth a second try.
void call(std::chrono::seconds deadline, const std::function<grpc::Status(grpc::ClientContext&)>& rpc) {
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + deadline);
    const grpc::Status status = rpc(ctx);
    if (status.ok()) return;
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE && attempt < kMaxAttempts) {
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    throw GenerationError("agent call failed: " + std::to_string(static_cast<int>(status.error_code())));
  }
}

// About four characters per token: close enough to decide whether to prune.
long long estimate_tokens(const std::vector<std::string>& schemas) {
  long long n = 0;
  for (const auto& s : schemas) n += static_cast<long long>(s.size());
  return n / 4;
}

// The generator's answer as an Output; GenerationError when it is not usable.
Output parse_output(const std::string& text) {
  const nlohmann::json out = nlohmann::json::parse(text, nullptr, false);
  if (out.is_discarded() || !out.is_object()) throw GenerationError("the model's answer is not a JSON object");
  const auto sql = out.find("sql");
  const auto explanation = out.find("explanation");
  if (sql == out.end() || !sql->is_string() || explanation == out.end() || !explanation->is_string() ||
      sql->get<std::string>().find_first_not_of(" \\t\\r\\n") == std::string::npos)
    throw GenerationError("the model's answer has no SQL");
  return {sql->get<std::string>(), explanation->get<std::string>()};
}

// SQL for an ACKed question: the tables' schemas, pruned when too wide, then the generator.
Output generate_sql(const std::string& question, const std::string& workspace, const std::vector<std::string>& tables) {
  std::vector<std::string> schemas;
  for (const auto& t : tables) schemas.push_back(catalog::schema_for(t));
  if (estimate_tokens(schemas) > kSchemaTokenBudget) {
    sqlagents::PruneColumnsRequest prune;
    prune.set_question(question);
    for (const auto& s : schemas) prune.add_schemas(s);
    sqlagents::PruneColumnsReply pruned;
    call(config::kAgentDeadline, [&](grpc::ClientContext& ctx) { return stub->PruneColumns(&ctx, prune, &pruned); });
    schemas.assign(pruned.schemas().begin(), pruned.schemas().end());
  }
  sqlagents::GenerateRequest request;
  request.set_question(question);
  request.set_workspace(workspace);
  for (const auto& s : schemas) request.add_schemas(s);
  sqlagents::GenerateReply reply;
  call(config::kGenerateDeadline, [&](grpc::ClientContext& ctx) { return stub->Generate(&ctx, request, &reply); });
  return parse_output(reply.text());
}
`,
    },
  },
  harness: {
    python: `import grpc

import text_to_sql_pb2
import text_to_sql_pb2_grpc
from querygen import agents, config

QUESTION = "How many trips completed in Seattle yesterday?"
WIDE = ["trips_tier1", "drivers_tier1"]


class AgentsServicer(text_to_sql_pb2_grpc.AgentsServicer):
    """The stand-in agents: answers from querygen.agents."""

    def PruneColumns(self, request, context):
        return text_to_sql_pb2.PruneColumnsReply(schemas=agents.prune_columns(request.question, list(request.schemas)))

    def Generate(self, request, context):
        if agents.prompt_tokens(list(request.schemas)) > agents.CONTEXT_LIMIT_TOKENS:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "prompt is over the model's context window")
        return text_to_sql_pb2.GenerateReply(text=agents.generate(request.question, request.workspace, list(request.schemas)))


def _world(ctx):
    ctx.grpc.serve(text_to_sql_pb2_grpc.add_AgentsServicer_to_server, AgentsServicer(), config.AGENTS)
    return ctx.load("agent_chain")


def _generate(ctx, m, question=QUESTION, tables=("trips",)):
    """(output, error): what generate_sql returned, or what it raised."""
    try:
        return m.generate_sql(question, "mobility", list(tables)), None
    except KeyboardInterrupt:
        raise AssertionError(f"generate_sql never returned: it kept calling the agents ({len(ctx.grpc.calls_to('Generate'))} Generate calls) instead of giving up with GenerationError") from None
    except Exception as err:  # noqa: BLE001 - whatever it raised is the verdict
        return None, err


def _expect_error(m, out, err, what):
    assert err is not None, f"{what} returned {out}: it must raise GenerationError"
    assert isinstance(err, m.GenerationError), f"{what} raised {type(err).__name__}: {err}; it must raise GenerationError"


def check_deadlines(ctx):
    m = _world(ctx)
    out, err = _generate(ctx, m)
    assert err is None, f"a healthy chain raised {err!r}"
    call = ctx.grpc.calls_to("Generate")[0]
    assert call.timeout is not None, "Generate was called without a deadline: a generator that hangs holds the request open"
    assert 29 <= call.timeout <= 31, f"the Generate deadline must be GENERATE_DEADLINE_S = 30 s, got {call.timeout} s"
    _generate(ctx, m, tables=WIDE)
    for prune in ctx.grpc.calls_to("PruneColumns"):
        assert prune.timeout is not None and 9 <= prune.timeout <= 11, f"PruneColumns must carry AGENT_DEADLINE_S = 10 s, got {prune.timeout}"
    ctx.grpc.set_latency("Generate", 45.0, config.AGENTS)
    calls = len(ctx.grpc.calls_to("Generate"))
    started = ctx.clock.offset
    out, err = _generate(ctx, m)
    waited = ctx.clock.offset - started
    _expect_error(m, out, err, "a generator that hangs for 45 s")
    assert waited <= 31, f"generate_sql waited {waited:.0f} s on a hung generator: the deadline must end the call at 30 s"
    assert len(ctx.grpc.calls_to("Generate")) == calls + 1, "DEADLINE_EXCEEDED is not retried: the next try would hang as long"


def check_retry_policy(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Generate", grpc.StatusCode.UNAVAILABLE, "generator restarting", times=1, target=config.AGENTS)
    out, err = _generate(ctx, m)
    assert err is None and out.get("sql"), f"one UNAVAILABLE earns one retry and then SQL, got {out!r} / {err!r}"
    assert len(ctx.grpc.calls_to("Generate")) == 2, f"one UNAVAILABLE, then success: expected 2 Generate calls, saw {len(ctx.grpc.calls_to('Generate'))}"
    assert ctx.clock.sleeps >= 1, "a retry waits a backoff before the next attempt"
    ctx.grpc.fail("Generate", grpc.StatusCode.UNAVAILABLE, "generator down", times=2, target=config.AGENTS)
    out, err = _generate(ctx, m)
    _expect_error(m, out, err, "a generator that stays UNAVAILABLE")
    assert len(ctx.grpc.calls_to("Generate")) == 4, f"MAX_ATTEMPTS = 2: a generator that stays UNAVAILABLE gets 2 calls, saw {len(ctx.grpc.calls_to('Generate')) - 2}"
    ctx.grpc.fail("Generate", grpc.StatusCode.INVALID_ARGUMENT, "bad request", times=1, target=config.AGENTS)
    out, err = _generate(ctx, m)
    _expect_error(m, out, err, "an INVALID_ARGUMENT from the generator")
    assert len(ctx.grpc.calls_to("Generate")) == 5, f"INVALID_ARGUMENT will not change on a retry: expected 1 call, saw {len(ctx.grpc.calls_to('Generate')) - 4}"


def check_prune_over_budget(ctx):
    m = _world(ctx)
    out, err = _generate(ctx, m)
    assert err is None, f"one small table must generate, raised {err!r}"
    assert ctx.grpc.calls_to("PruneColumns") == [], "a schema well under the token budget was sent to the prune agent: that is a model call for nothing"
    out, err = _generate(ctx, m, tables=WIDE)
    prunes = ctx.grpc.calls_to("PruneColumns")
    assert len(prunes) == 1, f"two Tier-1 tables (about 36 000 tokens of DDL) must go through PruneColumns once, saw {len(prunes)} calls; the generator refused them: {err!r}"
    sent = list(ctx.grpc.calls_to("Generate")[-1].request.schemas)
    assert sent and not any("attr_" in s for s in sent), "Generate must receive the pruned schemas, not the ones that were too wide"
    assert err is None and out.get("sql", "").startswith("SELECT * FROM trips_tier1"), f"the pruned prompt generates SQL, got {out!r} / {err!r}"


def check_parse_output(ctx):
    m = _world(ctx)
    out, err = _generate(ctx, m)
    assert err is None and out == {"sql": "SELECT * FROM trips WHERE datestr = '2026-11-01'", "explanation": "Rows of trips for 2026-11-01."}, f"a well-formed answer comes back as {{sql, explanation}}, got {out!r} / {err!r}"
    for question, what in (
        ("garbled: trips last week", "prose instead of JSON"),
        ("nosql: trips last week", "JSON without sql"),
        ("blank: trips last week", "a blank sql"),
    ):
        out, err = _generate(ctx, m, question=question)
        _expect_error(m, out, err, f"an answer with {what}")
`,
    typescript: `const QUESTION = 'How many trips completed in Seattle yesterday?';
const WIDE = ['trips_tier1', 'drivers_tier1'];

function world(ctx) {
  const {sqlagents} = ctx.proto('text_to_sql.proto');
  const config = ctx.load('/support/querygen/config.ts');
  const agents = ctx.load('/support/querygen/agents.ts');
  ctx.grpc.serve(sqlagents.Agents.service, {
    PruneColumns(call, callback) {
      callback(null, {schemas: agents.pruneColumns(call.request.question, call.request.schemas)});
    },
    Generate(call, callback) {
      if (agents.promptTokens(call.request.schemas) > agents.CONTEXT_LIMIT_TOKENS) {
        callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: "prompt is over the model's context window"});
        return;
      }
      callback(null, {text: agents.generate(call.request.question, call.request.workspace, call.request.schemas)});
    },
  }, config.AGENTS);
  return {m: ctx.load('agent_chain'), config};
}

const generates = ctx => ctx.grpc.callsTo('Generate');

/** {out, err}: what generateSql resolved to, or what it threw. */
async function generate(ctx, m, question = QUESTION, tables = ['trips']) {
  const done: {out?: {sql: string; explanation: string}; err?: Error; ended: boolean} = {ended: false};
  await ctx.drain(
    m.generateSql(question, 'mobility', tables).then(
      out => Object.assign(done, {out, ended: true}),
      err => Object.assign(done, {err, ended: true}),
    ),
  );
  assert(done.ended, \`generateSql never returned: it kept calling the agents (\${generates(ctx).length} Generate calls) instead of giving up with GenerationError\`);
  return done;
}

function expectError(m, {out, err}, what: string) {
  assert(err !== undefined, \`\${what} returned \${JSON.stringify(out)}: it must throw GenerationError\`);
  assert(err instanceof m.GenerationError, \`\${what} threw \${err?.constructor?.name}: \${err?.message}; it must throw GenerationError\`);
}

export async function check_deadlines(ctx) {
  const {m, config} = world(ctx);
  let r = await generate(ctx, m);
  assert(r.err === undefined, \`a healthy chain threw \${r.err}\`);
  const call = generates(ctx)[0];
  assert(call.timeout !== null, 'Generate was called without a deadline: a generator that hangs holds the request open');
  assert(call.timeout >= 29 && call.timeout <= 31, \`the Generate deadline must be GENERATE_DEADLINE_MS = 30 s, got \${call.timeout} s\`);
  await generate(ctx, m, QUESTION, WIDE);
  for (const prune of ctx.grpc.callsTo('PruneColumns')) {
    assert(prune.timeout !== null && prune.timeout >= 9 && prune.timeout <= 11, \`PruneColumns must carry AGENT_DEADLINE_MS = 10 s, got \${prune.timeout}\`);
  }
  ctx.grpc.setLatency('Generate', 45, config.AGENTS);
  const calls = generates(ctx).length;
  const started = ctx.clock.now();
  r = await generate(ctx, m);
  const waited = (ctx.clock.now() - started) / 1000;
  expectError(m, r, 'a generator that hangs for 45 s');
  assert(waited <= 31, \`generateSql waited \${waited.toFixed(0)} s on a hung generator: the deadline must end the call at 30 s\`);
  assert.equal(generates(ctx).length, calls + 1, 'DEADLINE_EXCEEDED is not retried: the next try would hang as long');
}

export async function check_retry_policy(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Generate', ctx.grpc.status.UNAVAILABLE, 'generator restarting', 1, config.AGENTS);
  let r = await generate(ctx, m);
  assert(r.err === undefined && r.out?.sql, \`one UNAVAILABLE earns one retry and then SQL, got \${JSON.stringify(r.out)} / \${r.err}\`);
  assert.equal(generates(ctx).length, 2, \`one UNAVAILABLE, then success: expected 2 Generate calls, saw \${generates(ctx).length}\`);
  assert(ctx.clock.sleeps >= 1, 'a retry waits a backoff before the next attempt');
  ctx.grpc.fail('Generate', ctx.grpc.status.UNAVAILABLE, 'generator down', 2, config.AGENTS);
  r = await generate(ctx, m);
  expectError(m, r, 'a generator that stays UNAVAILABLE');
  assert.equal(generates(ctx).length, 4, \`MAX_ATTEMPTS = 2: a generator that stays UNAVAILABLE gets 2 calls, saw \${generates(ctx).length - 2}\`);
  ctx.grpc.fail('Generate', ctx.grpc.status.INVALID_ARGUMENT, 'bad request', 1, config.AGENTS);
  r = await generate(ctx, m);
  expectError(m, r, 'an INVALID_ARGUMENT from the generator');
  assert.equal(generates(ctx).length, 5, \`INVALID_ARGUMENT will not change on a retry: expected 1 call, saw \${generates(ctx).length - 4}\`);
}

export async function check_prune_over_budget(ctx) {
  const {m} = world(ctx);
  let r = await generate(ctx, m);
  assert(r.err === undefined, \`one small table must generate, threw \${r.err}\`);
  assert.equal(ctx.grpc.callsTo('PruneColumns').length, 0, 'a schema well under the token budget was sent to the prune agent: that is a model call for nothing');
  r = await generate(ctx, m, QUESTION, WIDE);
  const prunes = ctx.grpc.callsTo('PruneColumns');
  assert.equal(prunes.length, 1, \`two Tier-1 tables (about 36 000 tokens of DDL) must go through PruneColumns once, saw \${prunes.length} calls; the generator refused them: \${r.err}\`);
  const sent = generates(ctx).at(-1).request.schemas as string[];
  assert(sent.length > 0 && !sent.some(s => s.includes('attr_')), 'Generate must receive the pruned schemas, not the ones that were too wide');
  assert(r.err === undefined && String(r.out?.sql).startsWith('SELECT * FROM trips_tier1'), \`the pruned prompt generates SQL, got \${JSON.stringify(r.out)} / \${r.err}\`);
}

export async function check_parse_output(ctx) {
  const {m} = world(ctx);
  const r = await generate(ctx, m);
  assert.deepStrictEqual(r.out, {sql: "SELECT * FROM trips WHERE datestr = '2026-11-01'", explanation: 'Rows of trips for 2026-11-01.'}, \`a well-formed answer comes back as {sql, explanation}, got \${JSON.stringify(r.out)} / \${r.err}\`);
  for (const [question, what] of [
    ['garbled: trips last week', 'prose instead of JSON'],
    ['nosql: trips last week', 'JSON without sql'],
    ['blank: trips last week', 'a blank sql'],
  ]) {
    expectError(m, await generate(ctx, m, question), \`an answer with \${what}\`);
  }
}
`,
    go: `package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"querygen/agents"
	"querygen/config"
	pb "sqlagents/gen/text_to_sql"

	"leetbuild/harness"
)

const chainQuestion = "How many trips completed in Seattle yesterday?"

var chainWide = []string{"trips_tier1", "drivers_tier1"}

// chainPeer is the stand-in agents: answers from querygen/agents.
type chainPeer struct {
	pb.UnimplementedAgentsServer
}

func (chainPeer) PruneColumns(_ context.Context, req *pb.PruneColumnsRequest) (*pb.PruneColumnsReply, error) {
	return &pb.PruneColumnsReply{Schemas: agents.PruneColumns(req.GetQuestion(), req.GetSchemas())}, nil
}

func (chainPeer) Generate(_ context.Context, req *pb.GenerateRequest) (*pb.GenerateReply, error) {
	if agents.PromptTokens(req.GetSchemas()) > agents.ContextLimitTokens {
		return nil, status.Error(codes.InvalidArgument, "prompt is over the model's context window")
	}
	return &pb.GenerateReply{Text: agents.Generate(req.GetQuestion(), req.GetWorkspace(), req.GetSchemas())}, nil
}

func chainWorld(ctx *harness.Ctx) {
	pb.RegisterAgentsServer(ctx.GRPC.Server(config.Agents), &chainPeer{})
}

func chainGenerates(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Generate", "") }

func chainGenerate(ctx *harness.Ctx, question string, tables []string) (Output, error) {
	var out Output
	var err error
	ended := ctx.Drain(func() { out, err = generateSQL(context.Background(), question, "mobility", tables) })
	ctx.Assert(ended, "generateSQL never returned: it kept calling the agents (%d Generate calls) instead of giving up with errGeneration", len(chainGenerates(ctx)))
	return out, err
}

func chainExpectError(ctx *harness.Ctx, out Output, err error, what string) {
	ctx.Assert(err != nil, "%s returned %+v: it must return an error wrapping errGeneration", what, out)
	ctx.Assert(errors.Is(err, errGeneration), "%s returned %v; it must wrap errGeneration", what, err)
}

func CheckDeadlines(ctx *harness.Ctx) {
	chainWorld(ctx)
	_, err := chainGenerate(ctx, chainQuestion, []string{"trips"})
	ctx.NoError(err, "a healthy chain")
	call := chainGenerates(ctx)[0]
	ctx.Assert(call.HasDeadline(), "Generate was called without a deadline: a generator that hangs holds the request open")
	ctx.Assert(29*time.Second <= call.Timeout && call.Timeout <= 31*time.Second, "the Generate deadline must be 30 s, got %v", call.Timeout)
	chainGenerate(ctx, chainQuestion, chainWide)
	for _, prune := range ctx.GRPC.CallsTo("PruneColumns", "") {
		ctx.Assert(prune.HasDeadline() && 9*time.Second <= prune.Timeout && prune.Timeout <= 11*time.Second, "PruneColumns must carry config.AgentDeadline (10 s), got %v", prune.Timeout)
	}
	ctx.GRPC.SetLatency("Generate", 45, config.Agents)
	calls := len(chainGenerates(ctx))
	started := ctx.Clock.Now()
	out, err := chainGenerate(ctx, chainQuestion, []string{"trips"})
	waited := float64(ctx.Clock.Now()-started) / 1000
	chainExpectError(ctx, out, err, "a generator that hangs for 45 s")
	ctx.Assert(waited <= 31, "generateSQL waited %.0f s on a hung generator: the deadline must end the call at 30 s", waited)
	ctx.Equal(len(chainGenerates(ctx)), calls+1, "DEADLINE_EXCEEDED is not retried (the next try would hang as long); Generate calls")
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	chainWorld(ctx)
	ctx.GRPC.Fail("Generate", codes.Unavailable, "generator restarting", 1, config.Agents)
	out, err := chainGenerate(ctx, chainQuestion, []string{"trips"})
	ctx.Assert(err == nil && out.SQL != "", "one UNAVAILABLE earns one retry and then SQL, got %+v / %v", out, err)
	ctx.Equal(len(chainGenerates(ctx)), 2, "one UNAVAILABLE, then success; Generate calls")
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt")
	ctx.GRPC.Fail("Generate", codes.Unavailable, "generator down", 2, config.Agents)
	out, err = chainGenerate(ctx, chainQuestion, []string{"trips"})
	chainExpectError(ctx, out, err, "a generator that stays UNAVAILABLE")
	ctx.Equal(len(chainGenerates(ctx)), 4, "maxAttempts = 2: a generator that stays UNAVAILABLE gets 2 calls; Generate calls so far")
	ctx.GRPC.Fail("Generate", codes.InvalidArgument, "bad request", 1, config.Agents)
	out, err = chainGenerate(ctx, chainQuestion, []string{"trips"})
	chainExpectError(ctx, out, err, "an INVALID_ARGUMENT from the generator")
	ctx.Equal(len(chainGenerates(ctx)), 5, "INVALID_ARGUMENT will not change on a retry (1 call); Generate calls so far")
}

func CheckPruneOverBudget(ctx *harness.Ctx) {
	chainWorld(ctx)
	_, err := chainGenerate(ctx, chainQuestion, []string{"trips"})
	ctx.NoError(err, "one small table must generate")
	ctx.Equal(len(ctx.GRPC.CallsTo("PruneColumns", "")), 0, "a schema well under the token budget was sent to the prune agent (a model call for nothing); PruneColumns calls")
	out, err := chainGenerate(ctx, chainQuestion, chainWide)
	ctx.Equal(len(ctx.GRPC.CallsTo("PruneColumns", "")), 1, "two Tier-1 tables (about 36 000 tokens of DDL) must go through PruneColumns once (the generator answered %v); PruneColumns calls", err)
	calls := chainGenerates(ctx)
	sent, _ := calls[len(calls)-1].Request.(*pb.GenerateRequest)
	ctx.Assert(sent != nil && len(sent.GetSchemas()) > 0 && !strings.Contains(strings.Join(sent.GetSchemas(), " "), "attr_"), "Generate must receive the pruned schemas, not the ones that were too wide")
	ctx.Assert(err == nil && strings.HasPrefix(out.SQL, "SELECT * FROM trips_tier1"), "the pruned prompt generates SQL, got %+v / %v", out, err)
}

func CheckParseOutput(ctx *harness.Ctx) {
	chainWorld(ctx)
	out, err := chainGenerate(ctx, chainQuestion, []string{"trips"})
	ctx.NoError(err, "a well-formed answer")
	ctx.Equal(out, Output{SQL: "SELECT * FROM trips WHERE datestr = '2026-11-01'", Explanation: "Rows of trips for 2026-11-01."}, "a well-formed answer comes back as {SQL, Explanation}")
	for _, c := range []struct{ question, what string }{
		{"garbled: trips last week", "prose instead of JSON"},
		{"nosql: trips last week", "JSON without sql"},
		{"blank: trips last week", "a blank sql"},
	} {
		out, err := chainGenerate(ctx, c.question, []string{"trips"})
		chainExpectError(ctx, out, err, "an answer with "+c.what)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "querygen/agents.h"

namespace {

const std::string kQuestion = "How many trips completed in Seattle yesterday?";
const std::vector<std::string> kWide = {"trips_tier1", "drivers_tier1"};

// The stand-in agents: answers from querygen/agents.h.
class ChainPeer final : public sqlagents::Agents::Service {
 public:
  grpc::Status PruneColumns(grpc::ServerContext*, const sqlagents::PruneColumnsRequest* req, sqlagents::PruneColumnsReply* reply) override {
    for (const auto& s : agents::prune_columns(req->question(), {req->schemas().begin(), req->schemas().end()})) reply->add_schemas(s);
    return grpc::Status::OK;
  }
  grpc::Status Generate(grpc::ServerContext*, const sqlagents::GenerateRequest* req, sqlagents::GenerateReply* reply) override {
    const std::vector<std::string> schemas(req->schemas().begin(), req->schemas().end());
    if (agents::prompt_tokens(schemas) > agents::kContextLimitTokens)
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "prompt is over the model's context window");
    reply->set_text(agents::generate(req->question(), req->workspace(), schemas));
    return grpc::Status::OK;
  }
};

void world(harness::Ctx& ctx) {
  static ChainPeer peer;
  ctx.GRPC.Server(config::kAgents)->RegisterService(&peer);
}

// What generate_sql returned, or what it threw.
struct Result {
  Output out;
  bool threw = false;
  bool generation_error = false;
  std::string error;
};

Result run(harness::Ctx& ctx, const std::string& question = kQuestion, const std::vector<std::string>& tables = {"trips"}) {
  Result r;
  const bool ended = ctx.Drain([&] {
    try {
      r.out = generate_sql(question, "mobility", tables);
    } catch (const GenerationError& e) {
      r.threw = r.generation_error = true;
      r.error = e.what();
    } catch (const std::exception& e) {
      r.threw = true;
      r.error = e.what();
    }
  });
  ctx.Assert(ended, "generate_sql never returned: it kept calling the agents (%d Generate calls) instead of giving up with GenerationError", ctx.GRPC.CallsTo("Generate").size());
  return r;
}

void expectError(harness::Ctx& ctx, const Result& r, const std::string& what) {
  ctx.Assert(r.threw, "%s returned sql %q: it must throw GenerationError", what, r.out.sql);
  ctx.Assert(r.generation_error, "%s threw something else (%s); it must throw GenerationError", what, r.error);
}

}  // namespace

void CheckDeadlines(harness::Ctx& ctx) {
  world(ctx);
  Result r = run(ctx);
  ctx.Assert(!r.threw, "a healthy chain threw: %s", r.error);
  const auto call = ctx.GRPC.CallsTo("Generate")[0];
  ctx.Assert(call.HasDeadline(), "Generate was called without a deadline: a generator that hangs holds the request open");
  ctx.Assert(29 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 31, "the Generate deadline must be 30 s, got %vs", call.TimeoutSeconds());
  run(ctx, kQuestion, kWide);
  for (const auto& prune : ctx.GRPC.CallsTo("PruneColumns")) {
    ctx.Assert(prune.HasDeadline() && 9 <= prune.TimeoutSeconds() && prune.TimeoutSeconds() <= 11, "PruneColumns must carry config::kAgentDeadline (10 s), got %vs", prune.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Generate", 45, config::kAgents);
  const size_t calls = ctx.GRPC.CallsTo("Generate").size();
  const int64_t started = ctx.Clock.Now();
  r = run(ctx);
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  expectError(ctx, r, "a generator that hangs for 45 s");
  ctx.Assert(waited <= 31, "generate_sql waited %.0f s on a hung generator: the deadline must end the call at 30 s", waited);
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), calls + 1, "DEADLINE_EXCEEDED is not retried (the next try would hang as long); Generate calls");
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  world(ctx);
  ctx.GRPC.Fail("Generate", grpc::StatusCode::UNAVAILABLE, "generator restarting", 1, config::kAgents);
  Result r = run(ctx);
  ctx.Assert(!r.threw && !r.out.sql.empty(), "one UNAVAILABLE earns one retry and then SQL, got %q / %s", r.out.sql, r.error);
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 2, "one UNAVAILABLE, then success; Generate calls");
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt");
  ctx.GRPC.Fail("Generate", grpc::StatusCode::UNAVAILABLE, "generator down", 2, config::kAgents);
  r = run(ctx);
  expectError(ctx, r, "a generator that stays UNAVAILABLE");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 4, "kMaxAttempts = 2: a generator that stays UNAVAILABLE gets 2 calls; Generate calls so far");
  ctx.GRPC.Fail("Generate", grpc::StatusCode::INVALID_ARGUMENT, "bad request", 1, config::kAgents);
  r = run(ctx);
  expectError(ctx, r, "an INVALID_ARGUMENT from the generator");
  ctx.Equal(ctx.GRPC.CallsTo("Generate").size(), 5, "INVALID_ARGUMENT will not change on a retry (1 call); Generate calls so far");
}

void CheckPruneOverBudget(harness::Ctx& ctx) {
  world(ctx);
  Result r = run(ctx);
  ctx.Assert(!r.threw, "one small table must generate, threw: %s", r.error);
  ctx.Equal(ctx.GRPC.CallsTo("PruneColumns").size(), 0, "a schema well under the token budget was sent to the prune agent (a model call for nothing); PruneColumns calls");
  r = run(ctx, kQuestion, kWide);
  ctx.Equal(ctx.GRPC.CallsTo("PruneColumns").size(), 1, "two Tier-1 tables (about 36 000 tokens of DDL) must go through PruneColumns once (the generator answered: %s); PruneColumns calls", r.error);
  const auto calls = ctx.GRPC.CallsTo("Generate");
  const auto sent = calls.back().Request<sqlagents::GenerateRequest>();
  bool wide = false;
  for (const auto& s : sent.schemas()) wide = wide || s.find("attr_") != std::string::npos;
  ctx.Assert(sent.schemas_size() > 0 && !wide, "Generate must receive the pruned schemas, not the ones that were too wide");
  ctx.Assert(!r.threw && r.out.sql.rfind("SELECT * FROM trips_tier1", 0) == 0, "the pruned prompt generates SQL, got %q / %s", r.out.sql, r.error);
}

void CheckParseOutput(harness::Ctx& ctx) {
  world(ctx);
  const Result r = run(ctx);
  ctx.Assert(!r.threw && r.out.sql == "SELECT * FROM trips WHERE datestr = '2026-11-01'" && r.out.explanation == "Rows of trips for 2026-11-01.",
             "a well-formed answer comes back as {sql, explanation}, got %q / %q / %s", r.out.sql, r.out.explanation, r.error);
  for (const auto& [question, what] : std::vector<std::pair<std::string, std::string>>{
           {"garbled: trips last week", "prose instead of JSON"}, {"nosql: trips last week", "JSON without sql"}, {"blank: trips last week", "a blank sql"}}) {
    expectError(ctx, run(ctx, question), "an answer with " + what);
  }
}
`,
  },
  hints: [
    'Symptom: two wide Tier-1 tables never produce SQL, a slow generator holds the request for minutes, a request the generator rejects keeps a worker busy for good, and one chatty model answer surfaces as a 500.',
    'Mechanism: `call` loops on every `RpcError` with no deadline and no attempt cap; nothing measures the schemas before `Generate`, so the prompt overflows the window on every try; `parse_output` trusts `json.loads(text)["sql"]`.',
    'Change: `call(method, request, timeout_s)` with `timeout=`, `range(MAX_ATTEMPTS)`, retry only `UNAVAILABLE`, else `raise GenerationError`; prune when `estimate_tokens(schemas) > SCHEMA_TOKEN_BUDGET`; in `parse_output` catch `ValueError` and check both fields are non-blank strings.',
  ],
  debrief: `The chain treats every agent answer as one of three kinds. \`UNAVAILABLE\` means the agent is restarting and is worth one more try after a pause; a deadline or an invalid argument will fail the same way again, so it ends the chain with a reason the caller can show. The deadline belongs on the call: a loop around a call without one still waits for the reply. Pruning is cheaper than a larger window because the generator only needs the columns the question touches; QueryGPT added its column prune agent for exactly the 200-column tables that broke the 32K model. Parsing defensively turns a chatty answer into a user-facing error instead of a stack trace. A production chain would also log the token estimate and the pruned column count per question.`,
};
