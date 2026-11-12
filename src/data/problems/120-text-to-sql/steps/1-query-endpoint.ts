import type {Step} from '@/lib/types';

export const queryEndpointStep: Step = {
  id: 'query-endpoint',
  title: 'POST /v1/queries: workspace resolved, tables proposed for ACK',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'queries_api',
  focus: ['analyst', 'api', 'agents', 'workspaces'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/queries\` with body \`{"question": "…", "workspace":
"mobility"}\` (\`workspace\` optional): it answers 401 without \`X-User-Id\`, takes the caller's workspace
or asks the intent agent (\`Intent\`), lets the table agent pick tables (\`PickTables\`), calls \`Generate\`
over their schemas, stores the record with its SQL (\`store.save\`) and answers 201. It serves the demo
and hides 4 flaws.

**Failure mode the checks target.** A pasted document becomes a chain of oversized model calls; a
caller's \`workspace\` string aims the agents at any table set, and an intent answer outside the curated
list goes unchecked; a client retry runs the chain again; and SQL generated before the user ACKs the
tables makes the ACK a formality.

Requirements:

- \`question\` is non-empty (**400**) and at most \`MAX_QUESTION_CHARS\` = 2000 characters (**413**),
  checked before any agent call.
- A given \`workspace\` must be in \`SYSTEM_WORKSPACES\` (**400**); without one, the intent agent's answer
  must be in it too (**422**).
- \`Idempotency-Key\` is required (**400**). A new record is stored with \`store.put(user, key, record)\`;
  a replay of the same \`(user, key)\` answers **200** with \`store.find\`'s record and calls no agent.
- Stop at the proposal: **202** with \`status: "pending_ack"\`, the table agent's \`tables_proposed\`, an
  empty \`tables_acked\` and \`sql\`. \`Generate\` runs after the ACK.`,
  sequence: {
    participants: ['Analyst', 'querygen', 'Agents', 'query store'],
    messages: [
      {from: 'Analyst', to: 'querygen', label: 'POST /v1/queries · X-User-Id · Idempotency-Key', kind: 'sync'},
      {from: 'querygen', to: 'querygen', label: 'question ≤ 2000 · workspace ∈ SYSTEM_WORKSPACES', kind: 'sync'},
      {from: 'querygen', to: 'query store', label: 'find(user, key)', kind: 'sync'},
      {from: 'querygen', to: 'Agents', label: 'Intent(question) when no workspace · 10 s', kind: 'sync'},
      {from: 'Agents', to: 'querygen', label: '{workspace} → allow-list or 422', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'PickTables(question, workspace) · 10 s', kind: 'sync'},
      {from: 'querygen', to: 'query store', label: 'put(user, key, record)', kind: 'sync'},
      {from: 'querygen', to: 'Analyst', label: '202 {status: pending_ack, tables_proposed}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/queries',
      detail:
        "A valid question answers 2xx with the query id, the workspace and the table agent's tables, and the record is in the query store; no X-User-Id is 401.",
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/queries["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/queries['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/queries"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"queries"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/queries"/]},
      },
    },
    {
      id: 'question-cap',
      title: 'Caps the question at 2000 characters before any agent call',
      detail:
        'An empty question is 400 and one over 2000 characters is 413, with no agent called and no record stored; exactly 2000 is accepted. The starter forwards whatever arrives.',
      match: {
        python: {all: [/MAX_QUESTION_CHARS/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_QUESTION_CHARS/, /code\(\s*413\s*\)/]},
        go: {all: [/maxQuestionChars/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxQuestionChars/, /StatusCodes\.PayloadTooLarge/]},
        cpp: {all: [/kMaxQuestionChars/, /\b413\b/]},
      },
    },
    {
      id: 'workspace-allowlist',
      title: "Holds the caller's workspace and the intent agent's answer to the system list",
      detail:
        'A workspace outside SYSTEM_WORKSPACES is 400 before any agent call; an intent answer outside it is 422 with no table pick. The starter hands either string to the table agent.',
      match: {
        python: {all: [/SYSTEM_WORKSPACES/, /status_code\s*=\s*422/]},
        typescript: {all: [/SYSTEM_WORKSPACES/, /code\(\s*422\s*\)/]},
        go: {all: [/config\.SystemWorkspaces\[/, /StatusUnprocessableEntity/]},
        scala: {all: [/Config\.SystemWorkspaces/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/config::kSystemWorkspaces/, /\b422\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys question submissions by (user, Idempotency-Key)',
      detail:
        "Idempotency-Key is required (400 without it); a replay of the same (user, key) answers 200 with the stored query and calls no agent; another user's same key gets its own query. The starter ignores the header.",
      match: {
        python: {all: [/store\.find\(\s*user\s*,/, /store\.put\(\s*user\s*,\s*idem_key/]},
        typescript: {all: [/store\.find\(\s*user\s*,/, /store\.put\(\s*user\s*,\s*idemKey/]},
        go: {all: [/queries\.Find\(\s*[\w.()]+,\s*user\s*,/, /queries\.Put\(\s*[\w.()]+,\s*user\s*,\s*idemKey/]},
        scala: {all: [/Queries\.find\(\s*user\s*,/, /Queries\.put\(\s*user\s*,\s*idemKey/]},
        cpp: {all: [/queries::find\(\s*user\s*,/, /queries::put\(\s*user\s*,\s*idem_key/]},
      },
    },
    {
      id: 'pending-ack',
      title: 'Proposes tables for ACK and generates nothing yet',
      detail:
        'The answer is 202 with status pending_ack, the proposed tables, an empty tables_acked and sql, and Generate is never called. The starter generates SQL from whatever the table agent picked.',
      match: {
        python: {all: [/["']pending_ack["']/, /status_code\s*=\s*202/], none: [/stub\.Generate\(/]},
        typescript: {all: [/['"]pending_ack['"]/, /code\(\s*202\s*\)/], none: [/stub\.Generate\(/]},
        go: {all: [/"pending_ack"/, /StatusAccepted/], none: [/stub\.Generate\(/]},
        scala: {all: [/"pending_ack"/, /StatusCodes\.Accepted/], none: [/\.generate\(/]},
        cpp: {all: [/"pending_ack"/, /\b202\b/], none: [/->Generate\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import uuid

import grpc
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import text_to_sql_pb2
import text_to_sql_pb2_grpc
from querygen.catalog import schema_for
from querygen.config import AGENT_DEADLINE_S, AGENTS, GENERATE_DEADLINE_S
from querygen.queries import store

app = FastAPI()
stub = text_to_sql_pb2_grpc.AgentsStub(grpc.insecure_channel(AGENTS))


class QueryRequest(BaseModel):
    question: str = ""
    workspace: str | None = None


@app.post("/v1/queries")
def create_query(body: QueryRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    user = request.headers.get("x-user-id", "")
    if user == "":
        return JSONResponse({"error": "missing X-User-Id"}, status_code=401)
    question = body.question
    try:
        workspace = body.workspace or stub.Intent(text_to_sql_pb2.IntentRequest(question=question), timeout=AGENT_DEADLINE_S).workspace
        picked = stub.PickTables(text_to_sql_pb2.PickTablesRequest(question=question, workspace=workspace), timeout=AGENT_DEADLINE_S)
        tables = list(picked.tables)
        reply = stub.Generate(
            text_to_sql_pb2.GenerateRequest(question=question, workspace=workspace, schemas=[schema_for(t) for t in tables]),
            timeout=GENERATE_DEADLINE_S,
        )
    except grpc.RpcError as err:
        return JSONResponse({"error": f"agents: {err.code().name}"}, status_code=502)
    record = {
        "query_id": str(uuid.uuid4()),
        "user": user,
        "workspace": workspace,
        "question": question,
        "status": "generated",
        "tables_proposed": tables,
        "tables_acked": tables,
        "sql": json.loads(reply.text)["sql"],
        "run_ok": False,
        "has_output": False,
    }
    store.save(record)
    return JSONResponse(record, status_code=201)
`,
      solution: `import uuid

import grpc
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import text_to_sql_pb2
import text_to_sql_pb2_grpc
from querygen.config import AGENT_DEADLINE_S, AGENTS, SYSTEM_WORKSPACES
from querygen.queries import store

app = FastAPI()
stub = text_to_sql_pb2_grpc.AgentsStub(grpc.insecure_channel(AGENTS))

MAX_QUESTION_CHARS = 2000


class QueryRequest(BaseModel):
    question: str = ""
    workspace: str | None = None


@app.post("/v1/queries")
def create_query(body: QueryRequest, request: Request) -> JSONResponse:
    user = request.headers.get("x-user-id", "")
    if user == "":
        return JSONResponse({"error": "missing X-User-Id"}, status_code=401)
    idem_key = request.headers.get("idempotency-key", "")
    if idem_key == "":
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    question = body.question
    if question.strip() == "":
        return JSONResponse({"error": "question is required"}, status_code=400)
    if len(question) > MAX_QUESTION_CHARS:
        return JSONResponse({"error": f"question is over {MAX_QUESTION_CHARS} characters"}, status_code=413)
    if body.workspace is not None and body.workspace not in SYSTEM_WORKSPACES:
        return JSONResponse({"error": "workspace is not a system workspace"}, status_code=400)

    stored = store.find(user, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    try:
        workspace = body.workspace
        if workspace is None:
            workspace = stub.Intent(text_to_sql_pb2.IntentRequest(question=question), timeout=AGENT_DEADLINE_S).workspace
            if workspace not in SYSTEM_WORKSPACES:
                return JSONResponse({"error": "the question matches no system workspace"}, status_code=422)
        picked = stub.PickTables(text_to_sql_pb2.PickTablesRequest(question=question, workspace=workspace), timeout=AGENT_DEADLINE_S)
    except grpc.RpcError as err:
        return JSONResponse({"error": f"agents: {err.code().name}"}, status_code=502)

    # The proposal is the product: SQL is generated only after the user ACKs (or edits) these tables.
    record = {
        "query_id": str(uuid.uuid4()),
        "user": user,
        "workspace": workspace,
        "question": question,
        "status": "pending_ack",
        "tables_proposed": list(picked.tables),
        "tables_acked": [],
        "sql": "",
        "run_ok": False,
        "has_output": False,
    }
    store.put(user, idem_key, record)
    return JSONResponse(record, status_code=202)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {schemaFor} from 'querygen/catalog';
import {AGENT_DEADLINE_MS, AGENTS, GENERATE_DEADLINE_MS} from 'querygen/config';
import {type QueryRecord, store} from 'querygen/queries';

interface AgentsClient {
  Intent(request: {question: string}, options: {deadline: number}): Promise<{workspace: string}>;
  PickTables(request: {question: string; workspace: string}, options: {deadline: number}): Promise<{tables: string[]}>;
  Generate(request: {question: string; workspace: string; schemas: string[]}, options: {deadline: number}): Promise<{text: string}>;
}

const {sqlagents} = grpc.loadPackageDefinition(protoLoader.loadSync('text_to_sql.proto')) as unknown as {
  sqlagents: {Agents: new (target: string, credentials: grpc.ChannelCredentials) => AgentsClient};
};
const stub = new sqlagents.Agents(AGENTS, grpc.credentials.createInsecure());

export const app = Fastify();

interface QueryBody {
  question?: string;
  workspace?: string;
}

app.post('/v1/queries', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const body = (request.body ?? {}) as QueryBody;
  const question = body.question ?? '';
  let record: QueryRecord;
  try {
    const workspace = body.workspace || (await stub.Intent({question}, {deadline: Date.now() + AGENT_DEADLINE_MS})).workspace;
    const {tables} = await stub.PickTables({question, workspace}, {deadline: Date.now() + AGENT_DEADLINE_MS});
    const generated = await stub.Generate(
      {question, workspace, schemas: tables.map(schemaFor)},
      {deadline: Date.now() + GENERATE_DEADLINE_MS},
    );
    record = {
      query_id: randomUUID(),
      user,
      workspace,
      question,
      status: 'generated',
      tables_proposed: tables,
      tables_acked: tables,
      sql: (JSON.parse(generated.text) as {sql: string}).sql,
      run_ok: false,
      has_output: false,
    };
  } catch (err) {
    return reply.code(502).send({error: \`agents: \${(err as grpc.ServiceError).code}\`});
  }
  await store.save(record);
  return reply.code(201).send(record);
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {AGENT_DEADLINE_MS, AGENTS, SYSTEM_WORKSPACES} from 'querygen/config';
import {type QueryRecord, store} from 'querygen/queries';

export const MAX_QUESTION_CHARS = 2000;

interface AgentsClient {
  Intent(request: {question: string}, options: {deadline: number}): Promise<{workspace: string}>;
  PickTables(request: {question: string; workspace: string}, options: {deadline: number}): Promise<{tables: string[]}>;
}

const {sqlagents} = grpc.loadPackageDefinition(protoLoader.loadSync('text_to_sql.proto')) as unknown as {
  sqlagents: {Agents: new (target: string, credentials: grpc.ChannelCredentials) => AgentsClient};
};
const stub = new sqlagents.Agents(AGENTS, grpc.credentials.createInsecure());

export const app = Fastify();

interface QueryBody {
  question?: string;
  workspace?: string;
}

app.post('/v1/queries', async (request, reply) => {
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as QueryBody;
  const question = typeof body.question === 'string' ? body.question : '';
  if (question.trim() === '') return reply.code(400).send({error: 'question is required'});
  if (question.length > MAX_QUESTION_CHARS)
    return reply.code(413).send({error: \`question is over \${MAX_QUESTION_CHARS} characters\`});
  if (body.workspace !== undefined && SYSTEM_WORKSPACES[body.workspace] !== true)
    return reply.code(400).send({error: 'workspace is not a system workspace'});

  const stored = await store.find(user, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  let workspace = body.workspace;
  let tables: string[];
  try {
    if (workspace === undefined) {
      workspace = (await stub.Intent({question}, {deadline: Date.now() + AGENT_DEADLINE_MS})).workspace;
      if (SYSTEM_WORKSPACES[workspace] !== true)
        return reply.code(422).send({error: 'the question matches no system workspace'});
    }
    tables = (await stub.PickTables({question, workspace}, {deadline: Date.now() + AGENT_DEADLINE_MS})).tables;
  } catch (err) {
    return reply.code(502).send({error: \`agents: \${(err as grpc.ServiceError).code}\`});
  }

  // The proposal is the product: SQL is generated only after the user ACKs (or edits) these tables.
  const record: QueryRecord = {
    query_id: randomUUID(),
    user,
    workspace,
    question,
    status: 'pending_ack',
    tables_proposed: tables,
    tables_acked: [],
    sql: '',
    run_ok: false,
    has_output: false,
  };
  await store.put(user, idemKey, record);
  return reply.code(202).send(record);
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"querygen/catalog" // catalog.SchemaFor(table) — provided
	"querygen/config"  // config.Agents, config.AgentDeadline, config.GenerateDeadline — provided
	"querygen/queries" // queries.Record, queries.Find/Put/Get/Save — provided
	pb "sqlagents/gen/text_to_sql"
)

var conn, _ = grpc.NewClient(config.Agents, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewAgentsClient(conn)

type queryRequest struct {
	Question  string  \`json:"question"\`
	Workspace *string \`json:"workspace"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createQuery(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	user := r.Header.Get("X-User-Id")
	if user == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	var body queryRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	agentsDown := func(err error) {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "agents: " + err.Error()})
	}
	workspace := ""
	if body.Workspace != nil {
		workspace = *body.Workspace
	}
	if workspace == "" {
		ctx, cancel := context.WithTimeout(r.Context(), config.AgentDeadline)
		intent, err := stub.Intent(ctx, &pb.IntentRequest{Question: body.Question})
		cancel()
		if err != nil {
			agentsDown(err)
			return
		}
		workspace = intent.GetWorkspace()
	}
	ctx, cancel := context.WithTimeout(r.Context(), config.AgentDeadline)
	picked, err := stub.PickTables(ctx, &pb.PickTablesRequest{Question: body.Question, Workspace: workspace})
	cancel()
	if err != nil {
		agentsDown(err)
		return
	}
	tables := picked.GetTables()
	schemas := make([]string, 0, len(tables))
	for _, t := range tables {
		schemas = append(schemas, catalog.SchemaFor(t))
	}
	ctx, cancel = context.WithTimeout(r.Context(), config.GenerateDeadline)
	generated, err := stub.Generate(ctx, &pb.GenerateRequest{Question: body.Question, Workspace: workspace, Schemas: schemas})
	cancel()
	if err != nil {
		agentsDown(err)
		return
	}
	var output struct {
		SQL string \`json:"sql"\`
	}
	json.Unmarshal([]byte(generated.GetText()), &output)
	rec := queries.Record{
		QueryID:        uuid.NewString(),
		User:           user,
		Workspace:      workspace,
		Question:       body.Question,
		Status:         "generated",
		TablesProposed: tables,
		TablesAcked:    tables,
		SQL:            output.SQL,
	}
	if err := queries.Save(r.Context(), rec); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, rec)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/queries", createQuery)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"querygen/config"  // config.Agents, config.AgentDeadline, config.SystemWorkspaces — provided
	"querygen/queries" // queries.Record, queries.Find/Put/Get/Save — provided
	pb "sqlagents/gen/text_to_sql"
)

const maxQuestionChars = 2000

var conn, _ = grpc.NewClient(config.Agents, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewAgentsClient(conn)

type queryRequest struct {
	Question  string  \`json:"question"\`
	Workspace *string \`json:"workspace"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reject(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func createQuery(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	if user == "" {
		reject(rw, http.StatusUnauthorized, "missing X-User-Id")
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		reject(rw, http.StatusBadRequest, "Idempotency-Key is required")
		return
	}
	var body queryRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		reject(rw, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(body.Question) == "" {
		reject(rw, http.StatusBadRequest, "question is required")
		return
	}
	if utf8.RuneCountInString(body.Question) > maxQuestionChars {
		reject(rw, http.StatusRequestEntityTooLarge, "question is over 2000 characters")
		return
	}
	if body.Workspace != nil && !config.SystemWorkspaces[*body.Workspace] {
		reject(rw, http.StatusBadRequest, "workspace is not a system workspace")
		return
	}

	stored, err := queries.Find(r.Context(), user, idemKey)
	if err != nil {
		reject(rw, http.StatusServiceUnavailable, "TRY_AGAIN")
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	var workspace string
	if body.Workspace != nil {
		workspace = *body.Workspace
	} else {
		ctx, cancel := context.WithTimeout(r.Context(), config.AgentDeadline)
		intent, err := stub.Intent(ctx, &pb.IntentRequest{Question: body.Question})
		cancel()
		if err != nil {
			reject(rw, http.StatusBadGateway, "agents: "+err.Error())
			return
		}
		workspace = intent.GetWorkspace()
		if !config.SystemWorkspaces[workspace] {
			reject(rw, http.StatusUnprocessableEntity, "the question matches no system workspace")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), config.AgentDeadline)
	picked, err := stub.PickTables(ctx, &pb.PickTablesRequest{Question: body.Question, Workspace: workspace})
	cancel()
	if err != nil {
		reject(rw, http.StatusBadGateway, "agents: "+err.Error())
		return
	}

	// The proposal is the product: SQL is generated only after the user ACKs (or edits) these tables.
	rec := queries.Record{
		QueryID:        uuid.NewString(),
		User:           user,
		Workspace:      workspace,
		Question:       body.Question,
		Status:         "pending_ack",
		TablesProposed: picked.GetTables(),
		TablesAcked:    []string{},
	}
	if err := queries.Put(r.Context(), user, idemKey, rec); err != nil {
		reject(rw, http.StatusServiceUnavailable, "TRY_AGAIN")
		return
	}
	writeJSON(rw, http.StatusAccepted, rec)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/queries", createQuery)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import querygen.{Catalog, Config, Queries, QueryRecord}
import sqlagents.text_to_sql.{AgentsGrpc, GenerateRequest, IntentRequest, PickTablesRequest}

object QueriesApi {
  implicit val system: ActorSystem = ActorSystem("querygen")

  private val channel = ManagedChannelBuilder.forTarget(Config.Agents).usePlaintext().build()
  private val stub = AgentsGrpc.blockingStub(channel)

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("v1" / "queries") {
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          entity(as[String]) { raw =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!userOpt.exists(_.nonEmpty)) json(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
            else {
              val user = userOpt.get
              val body = ujson.read(raw)
              val question = body.obj.get("question").map(_.str).getOrElse("")
              try {
                val workspace = body.obj.get("workspace").map(_.str).filter(_.nonEmpty).getOrElse(
                  stub.withDeadlineAfter(Config.AgentDeadlineMs, TimeUnit.MILLISECONDS).intent(IntentRequest(question = question)).workspace
                )
                val tables = stub
                  .withDeadlineAfter(Config.AgentDeadlineMs, TimeUnit.MILLISECONDS)
                  .pickTables(PickTablesRequest(question = question, workspace = workspace))
                  .tables
                  .toList
                val reply = stub
                  .withDeadlineAfter(Config.GenerateDeadlineMs, TimeUnit.MILLISECONDS)
                  .generate(GenerateRequest(question = question, workspace = workspace, schemas = tables.map(Catalog.schemaFor)))
                val sql = ujson.read(reply.text)("sql").str
                val record = QueryRecord(UUID.randomUUID().toString, user, workspace, question, "generated", tables, tables, sql, false, false)
                Queries.save(record)
                json(StatusCodes.Created, Queries.encode(record))
              } catch {
                case e: StatusRuntimeException =>
                  json(StatusCodes.BadGateway, ujson.write(ujson.Obj("error" -> s"agents: \${e.getStatus.getCode}")))
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import querygen.{Config, Queries, QueryRecord}
import sqlagents.text_to_sql.{AgentsGrpc, IntentRequest, PickTablesRequest}

object QueriesApi {
  implicit val system: ActorSystem = ActorSystem("querygen")

  val MaxQuestionChars = 2000

  private val channel = ManagedChannelBuilder.forTarget(Config.Agents).usePlaintext().build()
  private val stub = AgentsGrpc.blockingStub(channel)

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  private def error(status: StatusCode, message: String): Route = json(status, ujson.write(ujson.Obj("error" -> message)))

  val route: Route =
    path("v1" / "queries") {
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[String]) { raw =>
              val body = ujson.read(raw)
              val question = body.obj.get("question").map(_.str).getOrElse("")
              val requested = body.obj.get("workspace").map(_.str)
              if (!userOpt.exists(_.nonEmpty)) error(StatusCodes.Unauthorized, "missing X-User-Id")
              else if (!idemOpt.exists(_.nonEmpty)) error(StatusCodes.BadRequest, "Idempotency-Key is required")
              else if (question.trim.isEmpty) error(StatusCodes.BadRequest, "question is required")
              else if (question.length > MaxQuestionChars) error(StatusCodes.PayloadTooLarge, "question is over 2000 characters")
              else if (requested.exists(w => !Config.SystemWorkspaces.contains(w)))
                error(StatusCodes.BadRequest, "workspace is not a system workspace")
              else {
                val user = userOpt.get
                val idemKey = idemOpt.get
                Queries.find(user, idemKey) match {
                  case Some(stored) => json(StatusCodes.OK, Queries.encode(stored))
                  case None =>
                    try {
                      val workspace = requested.getOrElse(
                        stub.withDeadlineAfter(Config.AgentDeadlineMs, TimeUnit.MILLISECONDS).intent(IntentRequest(question = question)).workspace
                      )
                      if (!Config.SystemWorkspaces.contains(workspace))
                        error(StatusCodes.UnprocessableEntity, "the question matches no system workspace")
                      else {
                        val tables = stub
                          .withDeadlineAfter(Config.AgentDeadlineMs, TimeUnit.MILLISECONDS)
                          .pickTables(PickTablesRequest(question = question, workspace = workspace))
                          .tables
                          .toList
                        // The proposal is the product: SQL is generated only after the user ACKs (or edits) these tables.
                        val record = QueryRecord(UUID.randomUUID().toString, user, workspace, question, "pending_ack", tables, Nil, "", false, false)
                        Queries.put(user, idemKey, record)
                        json(StatusCodes.Accepted, Queries.encode(record))
                      }
                    } catch {
                      case e: StatusRuntimeException => error(StatusCodes.BadGateway, s"agents: \${e.getStatus.getCode}")
                    }
                }
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "ids.h"                 // new_uuid() — provided
#include "querygen/catalog.h"    // catalog::schema_for(table) — provided
#include "querygen/config.h"     // config::kAgents, kAgentDeadline, kGenerateDeadline — provided
#include "querygen/queries.h"    // queries::find/put/get/save — provided
#include "text_to_sql.grpc.pb.h"

using json = nlohmann::json;

auto channel = grpc::CreateChannel(config::kAgents, grpc::InsecureChannelCredentials());
auto stub = sqlagents::Agents::NewStub(channel);

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_query(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) return reply_json(res, 401, {{"error", "missing X-User-Id"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply_json(res, 400, {{"error", "invalid json"}});
  const std::string question = body.value("question", std::string());
  std::string workspace = body.value("workspace", std::string());
  if (workspace.empty()) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + config::kAgentDeadline);
    sqlagents::IntentRequest request;
    request.set_question(question);
    sqlagents::IntentReply reply;
    if (!stub->Intent(&ctx, request, &reply).ok()) return reply_json(res, 502, {{"error", "agents unavailable"}});
    workspace = reply.workspace();
  }
  grpc::ClientContext pick_ctx;
  pick_ctx.set_deadline(std::chrono::system_clock::now() + config::kAgentDeadline);
  sqlagents::PickTablesRequest pick;
  pick.set_question(question);
  pick.set_workspace(workspace);
  sqlagents::PickTablesReply picked;
  if (!stub->PickTables(&pick_ctx, pick, &picked).ok()) return reply_json(res, 502, {{"error", "agents unavailable"}});
  const std::vector<std::string> tables(picked.tables().begin(), picked.tables().end());

  grpc::ClientContext gen_ctx;
  gen_ctx.set_deadline(std::chrono::system_clock::now() + config::kGenerateDeadline);
  sqlagents::GenerateRequest generate;
  generate.set_question(question);
  generate.set_workspace(workspace);
  for (const auto& t : tables) generate.add_schemas(catalog::schema_for(t));
  sqlagents::GenerateReply generated;
  if (!stub->Generate(&gen_ctx, generate, &generated).ok()) return reply_json(res, 502, {{"error", "agents unavailable"}});

  const json record = {
      {"query_id", new_uuid()}, {"user", user},         {"workspace", workspace},
      {"question", question},   {"status", "generated"}, {"tables_proposed", tables},
      {"tables_acked", tables}, {"sql", json::parse(generated.text())["sql"]},
      {"run_ok", false},        {"has_output", false},
  };
  queries::save(record);
  reply_json(res, 201, record);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/queries", create_query); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "ids.h"                 // new_uuid() — provided
#include "querygen/config.h"     // config::kAgents, kAgentDeadline, kSystemWorkspaces — provided
#include "querygen/queries.h"    // queries::find/put/get/save — provided
#include "text_to_sql.grpc.pb.h"

using json = nlohmann::json;

constexpr size_t kMaxQuestionChars = 2000;

auto channel = grpc::CreateChannel(config::kAgents, grpc::InsecureChannelCredentials());
auto stub = sqlagents::Agents::NewStub(channel);

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// Characters, not bytes: a UTF-8 continuation byte does not start one.
size_t char_count(const std::string& s) {
  size_t n = 0;
  for (const unsigned char c : s) n += (c & 0xC0) != 0x80;
  return n;
}

void create_query(const httplib::Request& req, httplib::Response& res) {
  const std::string user = req.get_header_value("X-User-Id");
  if (user.empty()) return reply_json(res, 401, {{"error", "missing X-User-Id"}});
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reply_json(res, 400, {{"error", "Idempotency-Key is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply_json(res, 400, {{"error", "invalid json"}});
  const std::string question = body.contains("question") && body["question"].is_string() ? body["question"].get<std::string>() : "";
  if (question.find_first_not_of(" \\t\\r\\n") == std::string::npos) return reply_json(res, 400, {{"error", "question is required"}});
  if (char_count(question) > kMaxQuestionChars) return reply_json(res, 413, {{"error", "question is over 2000 characters"}});
  const bool has_workspace = body.contains("workspace");
  if (has_workspace && (!body["workspace"].is_string() || config::kSystemWorkspaces.count(body["workspace"].get<std::string>()) == 0))
    return reply_json(res, 400, {{"error", "workspace is not a system workspace"}});

  if (const auto stored = queries::find(user, idem_key)) return reply_json(res, 200, *stored);

  std::string workspace = has_workspace ? body["workspace"].get<std::string>() : "";
  if (!has_workspace) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + config::kAgentDeadline);
    sqlagents::IntentRequest request;
    request.set_question(question);
    sqlagents::IntentReply reply;
    if (!stub->Intent(&ctx, request, &reply).ok()) return reply_json(res, 502, {{"error", "agents unavailable"}});
    workspace = reply.workspace();
    if (config::kSystemWorkspaces.count(workspace) == 0)
      return reply_json(res, 422, {{"error", "the question matches no system workspace"}});
  }
  grpc::ClientContext pick_ctx;
  pick_ctx.set_deadline(std::chrono::system_clock::now() + config::kAgentDeadline);
  sqlagents::PickTablesRequest pick;
  pick.set_question(question);
  pick.set_workspace(workspace);
  sqlagents::PickTablesReply picked;
  if (!stub->PickTables(&pick_ctx, pick, &picked).ok()) return reply_json(res, 502, {{"error", "agents unavailable"}});

  // The proposal is the product: SQL is generated only after the user ACKs (or edits) these tables.
  const json record = {
      {"query_id", new_uuid()},
      {"user", user},
      {"workspace", workspace},
      {"question", question},
      {"status", "pending_ack"},
      {"tables_proposed", std::vector<std::string>(picked.tables().begin(), picked.tables().end())},
      {"tables_acked", json::array()},
      {"sql", ""},
      {"run_ok", false},
      {"has_output", false},
  };
  queries::put(user, idem_key, record);
  reply_json(res, 202, record);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/queries", create_query); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
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
GOOD = {"question": QUESTION, "workspace": "mobility"}
AGENT_METHODS = ("Intent", "PickTables", "PruneColumns", "Generate")


class AgentsServicer(text_to_sql_pb2_grpc.AgentsServicer):
    """The stand-in agents: answers from querygen.agents."""

    def Intent(self, request, context):
        return text_to_sql_pb2.IntentReply(workspace=agents.intent(request.question))

    def PickTables(self, request, context):
        return text_to_sql_pb2.PickTablesReply(tables=agents.pick_tables(request.question, request.workspace))

    def PruneColumns(self, request, context):
        return text_to_sql_pb2.PruneColumnsReply(schemas=agents.prune_columns(request.question, list(request.schemas)))

    def Generate(self, request, context):
        if agents.prompt_tokens(list(request.schemas)) > agents.CONTEXT_LIMIT_TOKENS:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "prompt is over the model's context window")
        return text_to_sql_pb2.GenerateReply(text=agents.generate(request.question, request.workspace, list(request.schemas)))


def _api(ctx):
    ctx.grpc.serve(text_to_sql_pb2_grpc.add_AgentsServicer_to_server, AgentsServicer(), config.AGENTS)
    m = ctx.load("queries_api")
    return ctx.client(m.app)


def _calls(ctx, method=None):
    return sum(len(ctx.grpc.calls_to(name)) for name in ((method,) if method else AGENT_METHODS))


async def _post(c, body, user="ana", key="k-1"):
    headers = {}
    if user is not None:
        headers["X-User-Id"] = user
    if key is not None:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/queries", json=body, headers=headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert 200 <= r.status_code < 300, f"a valid question answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("query_id"), f"the answer needs a query_id: {body}"
        assert body.get("workspace") == "mobility", f"the answer carries the workspace, got {body.get('workspace')!r}"
        assert body.get("tables_proposed") == ["trips", "drivers"], f"tables_proposed must be the table agent's pick for mobility (trips, drivers), got {body.get('tables_proposed')}"
        assert ctx.redis.get(f"query:{body['query_id']}") is not None, f"the record must be in the query store (query:{{query_id}}): keys {sorted(ctx.redis.keys('*'))}"
        r = await _post(c, GOOD, user=None, key="k-2")
        assert r.status_code == 401, f"without X-User-Id the request must answer 401, got {r.status_code}"


async def check_question_cap(ctx):
    async with _api(ctx) as c:
        for question, key in (("", "k-empty"), ("   ", "k-blank")):
            r = await _post(c, {"question": question, "workspace": "mobility"}, key=key)
            assert r.status_code == 400, f"question {question!r} answered {r.status_code}, expected 400"
        r = await _post(c, {"question": "x" * 2001, "workspace": "mobility"}, key="k-long")
        assert r.status_code == 413, f"a 2001-character question answered {r.status_code}, expected 413: a pasted document must not reach the agents"
        assert _calls(ctx) == 0, f"rejected questions reached the agents: {_calls(ctx)} agent calls; refuse before the first call"
        assert ctx.redis.keys("query:*") == [], f"a rejected question must store nothing, found {ctx.redis.keys('query:*')}"
        r = await _post(c, {"question": "y" * 2000, "workspace": "mobility"}, key="k-max")
        assert 200 <= r.status_code < 300, f"exactly 2000 characters is allowed, got {r.status_code}: {r.text}"


async def check_workspace_allowlist(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {"question": QUESTION, "workspace": "finance"}, key="k-fin")
        assert r.status_code == 400, f"workspace 'finance' is not a system workspace and answered {r.status_code}, expected 400"
        assert _calls(ctx) == 0, f"a caller's unknown workspace reached the agents ({_calls(ctx)} calls): check it against SYSTEM_WORKSPACES first"
        r = await _post(c, {"question": "offtopic: what did payroll pay contractors in October?"}, key="k-off")
        assert r.status_code == 422, f"the intent agent answered 'hr-payroll', which is no system workspace; expected 422, got {r.status_code}: {r.text}"
        assert _calls(ctx, "PickTables") == 0, "an intent answer outside SYSTEM_WORKSPACES went on to the table agent"
        assert ctx.redis.keys("query:*") == [], f"a refused question must store nothing, found {ctx.redis.keys('query:*')}"
        r = await _post(c, {"question": "Which campaign spent the most last week?"}, key="k-ads")
        assert 200 <= r.status_code < 300 and r.json().get("workspace") == "ads", f"without a workspace the intent agent's 'ads' must be used: {r.status_code} {r.text}"
        intents = _calls(ctx, "Intent")
        r = await _post(c, {"question": QUESTION, "workspace": "core-services"}, key="k-core")
        assert 200 <= r.status_code < 300 and r.json().get("workspace") == "core-services", f"a system workspace the caller names is used as given: {r.status_code} {r.text}"
        assert _calls(ctx, "Intent") == intents, "with a valid workspace in the body the intent agent must not be asked"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, key=None)
        assert r.status_code == 400, f"a request without Idempotency-Key answered {r.status_code}, expected 400"
        assert _calls(ctx) == 0, "a request without Idempotency-Key reached the agents"
        first = await _post(c, GOOD, key="k-7")
        assert 200 <= first.status_code < 300, f"the first request answered {first.status_code}: {first.text}"
        picks = _calls(ctx, "PickTables")
        replay = await _post(c, GOOD, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (user, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored query"
        assert replay.json().get("query_id") == first.json().get("query_id"), f"the replay must return the same query: {replay.json().get('query_id')} vs {first.json().get('query_id')}"
        assert _calls(ctx, "PickTables") == picks, "a replay ran the agents again: the client retried, the chain must not"
        other = await _post(c, GOOD, user="ben", key="k-7")
        assert 200 <= other.status_code < 300 and other.json().get("query_id") != first.json().get("query_id"), "another user reusing the key gets their own query (keys are per user)"
        assert len(ctx.redis.keys("query:*")) == 2, f"two users, two queries: the store holds {len(ctx.redis.keys('query:*'))}"


async def check_pending_ack(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, key="k-ack")
        assert r.status_code == 202, f"a proposal waiting for the user's ACK answers 202, got {r.status_code}"
        body = r.json()
        assert body.get("status") == "pending_ack", f"status must be pending_ack, got {body.get('status')!r}"
        assert body.get("tables_proposed") == ["trips", "drivers"], f"tables_proposed must be the table agent's pick, got {body.get('tables_proposed')}"
        assert body.get("tables_acked") == [] and body.get("sql") == "", f"nothing is ACKed or generated yet: tables_acked {body.get('tables_acked')}, sql {body.get('sql')!r}"
        assert _calls(ctx, "Generate") == 0, f"Generate was called {_calls(ctx, 'Generate')} time(s) before the user ACKed the tables"
        stored = ctx.redis.get(f"query:{body.get('query_id')}")
        assert stored is not None and '"pending_ack"' in stored, f"the stored record must say pending_ack: {stored}"
`,
    typescript: `const QUESTION = 'How many trips completed in Seattle yesterday?';
const GOOD = {question: QUESTION, workspace: 'mobility'};
const AGENT_METHODS = ['Intent', 'PickTables', 'PruneColumns', 'Generate'];

function api(ctx) {
  const {sqlagents} = ctx.proto('text_to_sql.proto');
  const config = ctx.load('/support/querygen/config.ts');
  const agents = ctx.load('/support/querygen/agents.ts');
  ctx.grpc.serve(sqlagents.Agents.service, {
    Intent(call, callback) {
      callback(null, {workspace: agents.intent(call.request.question)});
    },
    PickTables(call, callback) {
      callback(null, {tables: agents.pickTables(call.request.question, call.request.workspace)});
    },
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
  const m = ctx.load('queries_api');
  return ctx.client(m.app);
}

const calls = (ctx, method?: string): number => (method ? [method] : AGENT_METHODS).reduce((n, name) => n + ctx.grpc.callsTo(name).length, 0);

async function post(c, body, {user = 'ana' as string | null, key = 'k-1' as string | null} = {}) {
  const headers: Record<string, string> = {};
  if (user !== null) headers['X-User-Id'] = user;
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post('/v1/queries', {body, headers});
}

const ok = (status: number) => status >= 200 && status < 300;

export async function check_route(ctx) {
  const c = api(ctx);
  let r = await post(c, GOOD);
  assert(ok(r.status), \`a valid question answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.query_id, \`the answer needs a query_id: \${r.text}\`);
  assert.equal(body.workspace, 'mobility', \`the answer carries the workspace: \${r.text}\`);
  assert.deepStrictEqual(body.tables_proposed, ['trips', 'drivers'], \`tables_proposed must be the table agent's pick for mobility (trips, drivers): \${r.text}\`);
  assert(ctx.redis.get(\`query:\${body.query_id}\`) !== null, \`the record must be in the query store (query:{query_id}): keys \${JSON.stringify(ctx.redis.keys('*'))}\`);
  r = await post(c, GOOD, {user: null, key: 'k-2'});
  assert.equal(r.status, 401, \`without X-User-Id the request must answer 401, got \${r.status}\`);
}

export async function check_question_cap(ctx) {
  const c = api(ctx);
  for (const [question, key] of [['', 'k-empty'], ['   ', 'k-blank']]) {
    const r = await post(c, {question, workspace: 'mobility'}, {key});
    assert.equal(r.status, 400, \`question \${JSON.stringify(question)} answered \${r.status}, expected 400\`);
  }
  let r = await post(c, {question: 'x'.repeat(2001), workspace: 'mobility'}, {key: 'k-long'});
  assert.equal(r.status, 413, \`a 2001-character question answered \${r.status}, expected 413: a pasted document must not reach the agents\`);
  assert.equal(calls(ctx), 0, \`rejected questions reached the agents: \${calls(ctx)} agent calls; refuse before the first call\`);
  assert.deepStrictEqual(ctx.redis.keys('query:*'), [], \`a rejected question must store nothing, found \${JSON.stringify(ctx.redis.keys('query:*'))}\`);
  r = await post(c, {question: 'y'.repeat(2000), workspace: 'mobility'}, {key: 'k-max'});
  assert(ok(r.status), \`exactly 2000 characters is allowed, got \${r.status}: \${r.text}\`);
}

export async function check_workspace_allowlist(ctx) {
  const c = api(ctx);
  let r = await post(c, {question: QUESTION, workspace: 'finance'}, {key: 'k-fin'});
  assert.equal(r.status, 400, \`workspace 'finance' is not a system workspace and answered \${r.status}, expected 400\`);
  assert.equal(calls(ctx), 0, \`a caller's unknown workspace reached the agents (\${calls(ctx)} calls): check it against SYSTEM_WORKSPACES first\`);
  r = await post(c, {question: 'offtopic: what did payroll pay contractors in October?'}, {key: 'k-off'});
  assert.equal(r.status, 422, \`the intent agent answered 'hr-payroll', which is no system workspace; expected 422, got \${r.status}: \${r.text}\`);
  assert.equal(calls(ctx, 'PickTables'), 0, 'an intent answer outside SYSTEM_WORKSPACES went on to the table agent');
  assert.deepStrictEqual(ctx.redis.keys('query:*'), [], \`a refused question must store nothing, found \${JSON.stringify(ctx.redis.keys('query:*'))}\`);
  r = await post(c, {question: 'Which campaign spent the most last week?'}, {key: 'k-ads'});
  assert(ok(r.status) && r.json().workspace === 'ads', \`without a workspace the intent agent's 'ads' must be used: \${r.status} \${r.text}\`);
  const intents = calls(ctx, 'Intent');
  r = await post(c, {question: QUESTION, workspace: 'core-services'}, {key: 'k-core'});
  assert(ok(r.status) && r.json().workspace === 'core-services', \`a system workspace the caller names is used as given: \${r.status} \${r.text}\`);
  assert.equal(calls(ctx, 'Intent'), intents, 'with a valid workspace in the body the intent agent must not be asked');
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const noKey = await post(c, GOOD, {key: null});
  assert.equal(noKey.status, 400, \`a request without Idempotency-Key answered \${noKey.status}, expected 400\`);
  assert.equal(calls(ctx), 0, 'a request without Idempotency-Key reached the agents');
  const first = await post(c, GOOD, {key: 'k-7'});
  assert(ok(first.status), \`the first request answered \${first.status}: \${first.text}\`);
  const picks = calls(ctx, 'PickTables');
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (user, Idempotency-Key) answered \${replay.status}, expected 200 with the stored query\`);
  assert.equal(replay.json().query_id, first.json().query_id, 'the replay must return the same query');
  assert.equal(calls(ctx, 'PickTables'), picks, 'a replay ran the agents again: the client retried, the chain must not');
  const other = await post(c, GOOD, {user: 'ben', key: 'k-7'});
  assert(ok(other.status) && other.json().query_id !== first.json().query_id, 'another user reusing the key gets their own query (keys are per user)');
  assert.equal(ctx.redis.keys('query:*').length, 2, \`two users, two queries: the store holds \${ctx.redis.keys('query:*').length}\`);
}

export async function check_pending_ack(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD, {key: 'k-ack'});
  assert.equal(r.status, 202, \`a proposal waiting for the user's ACK answers 202, got \${r.status}\`);
  const body = r.json();
  assert.equal(body.status, 'pending_ack', \`status must be pending_ack: \${r.text}\`);
  assert.deepStrictEqual(body.tables_proposed, ['trips', 'drivers'], \`tables_proposed must be the table agent's pick: \${r.text}\`);
  assert(Array.isArray(body.tables_acked) && body.tables_acked.length === 0 && body.sql === '', \`nothing is ACKed or generated yet: \${r.text}\`);
  assert.equal(calls(ctx, 'Generate'), 0, \`Generate was called \${calls(ctx, 'Generate')} time(s) before the user ACKed the tables\`);
  const stored = ctx.redis.get(\`query:\${body.query_id}\`);
  assert(stored !== null && JSON.parse(stored).status === 'pending_ack', \`the stored record must say pending_ack: \${stored}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"querygen/agents"
	"querygen/config"
	pb "sqlagents/gen/text_to_sql"

	"leetbuild/harness"
)

const apiQuestion = "How many trips completed in Seattle yesterday?"

var apiGood = map[string]any{"question": apiQuestion, "workspace": "mobility"}

// agentsPeer is the stand-in agents: answers from querygen/agents.
type agentsPeer struct {
	pb.UnimplementedAgentsServer
}

func (agentsPeer) Intent(_ context.Context, req *pb.IntentRequest) (*pb.IntentReply, error) {
	return &pb.IntentReply{Workspace: agents.Intent(req.GetQuestion())}, nil
}

func (agentsPeer) PickTables(_ context.Context, req *pb.PickTablesRequest) (*pb.PickTablesReply, error) {
	return &pb.PickTablesReply{Tables: agents.PickTables(req.GetQuestion(), req.GetWorkspace())}, nil
}

func (agentsPeer) PruneColumns(_ context.Context, req *pb.PruneColumnsRequest) (*pb.PruneColumnsReply, error) {
	return &pb.PruneColumnsReply{Schemas: agents.PruneColumns(req.GetQuestion(), req.GetSchemas())}, nil
}

func (agentsPeer) Generate(_ context.Context, req *pb.GenerateRequest) (*pb.GenerateReply, error) {
	if agents.PromptTokens(req.GetSchemas()) > agents.ContextLimitTokens {
		return nil, status.Error(codes.InvalidArgument, "prompt is over the model's context window")
	}
	return &pb.GenerateReply{Text: agents.Generate(req.GetQuestion(), req.GetWorkspace(), req.GetSchemas())}, nil
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterAgentsServer(ctx.GRPC.Server(config.Agents), &agentsPeer{})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiCalls(ctx *harness.Ctx, methods ...string) int {
	if len(methods) == 0 {
		methods = []string{"Intent", "PickTables", "PruneColumns", "Generate"}
	}
	n := 0
	for _, m := range methods {
		n += len(ctx.GRPC.CallsTo(m, ""))
	}
	return n
}

func apiPost(c *harness.HTTP, body map[string]any, user, key string) *harness.Response {
	var headers []string
	if user != "" {
		headers = append(headers, "X-User-Id", user)
	}
	if key != "" {
		headers = append(headers, "Idempotency-Key", key)
	}
	return c.Post("/v1/queries", body, headers...)
}

func apiBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func apiOK(status int) bool { return status >= 200 && status < 300 }

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood, "ana", "k-1")
	ctx.Assert(apiOK(r.Status), "a valid question answered %d: %s", r.Status, r.Text())
	body := apiBody(ctx, r)
	id, _ := body["query_id"].(string)
	ctx.Assert(id != "", "the answer needs a query_id: %s", r.Text())
	ctx.Equal(body["workspace"], "mobility", "the answer carries the workspace")
	ctx.Equal(body["tables_proposed"], []any{"trips", "drivers"}, "tables_proposed must be the table agent's pick for mobility (trips, drivers)")
	_, stored := ctx.Redis.Get("query:" + id)
	ctx.Assert(stored, "the record must be in the query store (query:{query_id}): keys %v", ctx.Redis.Keys("*"))
	ctx.Equal(apiPost(c, apiGood, "", "k-2").Status, 401, "without X-User-Id the request")
}

func CheckQuestionCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, q := range []string{"", "   "} {
		r := apiPost(c, map[string]any{"question": q, "workspace": "mobility"}, "ana", "k-empty")
		ctx.Equal(r.Status, 400, "question %q", q)
	}
	r := apiPost(c, map[string]any{"question": strings.Repeat("x", 2001), "workspace": "mobility"}, "ana", "k-long")
	ctx.Equal(r.Status, 413, "a 2001-character question (a pasted document must not reach the agents)")
	ctx.Equal(apiCalls(ctx), 0, "rejected questions reached the agents (refuse before the first call); agent calls")
	ctx.Equal(len(ctx.Redis.Keys("query:*")), 0, "a rejected question must store nothing; records")
	r = apiPost(c, map[string]any{"question": strings.Repeat("y", 2000), "workspace": "mobility"}, "ana", "k-max")
	ctx.Assert(apiOK(r.Status), "exactly 2000 characters is allowed, got %d: %s", r.Status, r.Text())
}

func CheckWorkspaceAllowlist(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, map[string]any{"question": apiQuestion, "workspace": "finance"}, "ana", "k-fin")
	ctx.Equal(r.Status, 400, "workspace 'finance' is not a system workspace")
	ctx.Equal(apiCalls(ctx), 0, "a caller's unknown workspace reached the agents (check it against config.SystemWorkspaces first); agent calls")
	r = apiPost(c, map[string]any{"question": "offtopic: what did payroll pay contractors in October?"}, "ana", "k-off")
	ctx.Equal(r.Status, 422, "the intent agent answered 'hr-payroll', which is no system workspace (%s)", r.Text())
	ctx.Equal(apiCalls(ctx, "PickTables"), 0, "an intent answer outside the system workspaces went on to the table agent; PickTables calls")
	ctx.Equal(len(ctx.Redis.Keys("query:*")), 0, "a refused question must store nothing; records")
	r = apiPost(c, map[string]any{"question": "Which campaign spent the most last week?"}, "ana", "k-ads")
	ctx.Assert(apiOK(r.Status) && apiBody(ctx, r)["workspace"] == "ads", "without a workspace the intent agent's 'ads' must be used: %d %s", r.Status, r.Text())
	intents := apiCalls(ctx, "Intent")
	r = apiPost(c, map[string]any{"question": apiQuestion, "workspace": "core-services"}, "ana", "k-core")
	ctx.Assert(apiOK(r.Status) && apiBody(ctx, r)["workspace"] == "core-services", "a system workspace the caller names is used as given: %d %s", r.Status, r.Text())
	ctx.Equal(apiCalls(ctx, "Intent"), intents, "with a valid workspace in the body the intent agent must not be asked; Intent calls")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	ctx.Equal(apiPost(c, apiGood, "ana", "").Status, 400, "a request without Idempotency-Key")
	ctx.Equal(apiCalls(ctx), 0, "a request without Idempotency-Key reached the agents; agent calls")
	first := apiPost(c, apiGood, "ana", "k-7")
	ctx.Assert(apiOK(first.Status), "the first request answered %d: %s", first.Status, first.Text())
	picks := apiCalls(ctx, "PickTables")
	replay := apiPost(c, apiGood, "ana", "k-7")
	ctx.Equal(replay.Status, 200, "a replay of the same (user, Idempotency-Key) must answer the stored query")
	ctx.Equal(apiBody(ctx, replay)["query_id"], apiBody(ctx, first)["query_id"], "the replay must return the same query")
	ctx.Equal(apiCalls(ctx, "PickTables"), picks, "a replay ran the agents again (the client retried, the chain must not); PickTables calls")
	other := apiPost(c, apiGood, "ben", "k-7")
	ctx.Assert(apiOK(other.Status) && apiBody(ctx, other)["query_id"] != apiBody(ctx, first)["query_id"], "another user reusing the key gets their own query (keys are per user)")
	ctx.Equal(len(ctx.Redis.Keys("query:*")), 2, "two users, two queries; records")
}

func CheckPendingAck(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood, "ana", "k-ack")
	ctx.Equal(r.Status, 202, "a proposal waiting for the user's ACK")
	body := apiBody(ctx, r)
	ctx.Equal(body["status"], "pending_ack", "status")
	ctx.Equal(body["tables_proposed"], []any{"trips", "drivers"}, "tables_proposed must be the table agent's pick")
	acked, _ := body["tables_acked"].([]any)
	ctx.Assert(acked != nil && len(acked) == 0 && body["sql"] == "", "nothing is ACKed or generated yet: %s", r.Text())
	ctx.Equal(apiCalls(ctx, "Generate"), 0, "Generate ran before the user ACKed the tables; Generate calls")
	id, _ := body["query_id"].(string)
	raw, _ := ctx.Redis.Get("query:" + id)
	var stored map[string]any
	json.Unmarshal([]byte(raw), &stored)
	ctx.Equal(stored["status"], "pending_ack", "the stored record's status")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "querygen/agents.h"

namespace {

using json = nlohmann::json;

const std::string kQuestion = "How many trips completed in Seattle yesterday?";
const json kGood = {{"question", kQuestion}, {"workspace", "mobility"}};

// The stand-in agents: answers from querygen/agents.h.
class AgentsPeer final : public sqlagents::Agents::Service {
 public:
  grpc::Status Intent(grpc::ServerContext*, const sqlagents::IntentRequest* req, sqlagents::IntentReply* reply) override {
    reply->set_workspace(agents::intent(req->question()));
    return grpc::Status::OK;
  }
  grpc::Status PickTables(grpc::ServerContext*, const sqlagents::PickTablesRequest* req, sqlagents::PickTablesReply* reply) override {
    for (const auto& t : agents::pick_tables(req->question(), req->workspace())) reply->add_tables(t);
    return grpc::Status::OK;
  }
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

struct Api {
  AgentsPeer peer;
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    ctx.GRPC.Server(config::kAgents)->RegisterService(&peer);
    register_routes(svr);
  }

  harness::Response post(const json& body, const std::string& user = "ana", const std::string& key = "k-1") {
    if (user.empty()) return http.Post("/v1/queries", body.dump(), "Idempotency-Key", key);
    if (key.empty()) return http.Post("/v1/queries", body.dump(), "X-User-Id", user);
    return http.Post("/v1/queries", body.dump(), "X-User-Id", user, "Idempotency-Key", key);
  }
};

Api& api(harness::Ctx& ctx) {
  static Api* current = nullptr;
  delete current;
  current = new Api(ctx);
  return *current;
}

size_t calls(harness::Ctx& ctx, const std::vector<std::string>& methods = {"Intent", "PickTables", "PruneColumns", "Generate"}) {
  size_t n = 0;
  for (const auto& m : methods) n += ctx.GRPC.CallsTo(m).size();
  return n;
}

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

bool ok(int status) { return status >= 200 && status < 300; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto& a = api(ctx);
  const auto r = a.post(kGood);
  ctx.Assert(ok(r.Status), "a valid question answered %d: %s", r.Status, r.Text());
  const json body = bodyOf(ctx, r);
  const std::string id = body.value("query_id", "");
  ctx.Assert(!id.empty(), "the answer needs a query_id: %s", r.Text());
  ctx.Equal(body.value("workspace", ""), "mobility", "the answer carries the workspace");
  ctx.Assert(body["tables_proposed"] == json({"trips", "drivers"}), "tables_proposed must be the table agent's pick for mobility (trips, drivers): %s", r.Text());
  ctx.Assert(ctx.Redis.Get("query:" + id).has_value(), "the record must be in the query store (query:{query_id}): keys %v", ctx.Redis.Keys("*"));
  ctx.Equal(a.post(kGood, "", "k-2").Status, 401, "without X-User-Id the request");
}

void CheckQuestionCap(harness::Ctx& ctx) {
  auto& a = api(ctx);
  for (const std::string q : {"", "   "}) {
    const auto r = a.post({{"question", q}, {"workspace", "mobility"}}, "ana", "k-empty");
    ctx.Equal(r.Status, 400, "question %q", q);
  }
  auto r = a.post({{"question", std::string(2001, 'x')}, {"workspace", "mobility"}}, "ana", "k-long");
  ctx.Equal(r.Status, 413, "a 2001-character question (a pasted document must not reach the agents)");
  ctx.Equal(calls(ctx), 0, "rejected questions reached the agents (refuse before the first call); agent calls");
  ctx.Equal(ctx.Redis.Keys("query:*").size(), 0, "a rejected question must store nothing; records");
  r = a.post({{"question", std::string(2000, 'y')}, {"workspace", "mobility"}}, "ana", "k-max");
  ctx.Assert(ok(r.Status), "exactly 2000 characters is allowed, got %d: %s", r.Status, r.Text());
}

void CheckWorkspaceAllowlist(harness::Ctx& ctx) {
  auto& a = api(ctx);
  auto r = a.post({{"question", kQuestion}, {"workspace", "finance"}}, "ana", "k-fin");
  ctx.Equal(r.Status, 400, "workspace 'finance' is not a system workspace");
  ctx.Equal(calls(ctx), 0, "a caller's unknown workspace reached the agents (check it against config::kSystemWorkspaces first); agent calls");
  r = a.post({{"question", "offtopic: what did payroll pay contractors in October?"}}, "ana", "k-off");
  ctx.Equal(r.Status, 422, "the intent agent answered 'hr-payroll', which is no system workspace (%s)", r.Text());
  ctx.Equal(calls(ctx, {"PickTables"}), 0, "an intent answer outside the system workspaces went on to the table agent; PickTables calls");
  ctx.Equal(ctx.Redis.Keys("query:*").size(), 0, "a refused question must store nothing; records");
  r = a.post({{"question", "Which campaign spent the most last week?"}}, "ana", "k-ads");
  ctx.Assert(ok(r.Status) && bodyOf(ctx, r).value("workspace", "") == "ads", "without a workspace the intent agent's 'ads' must be used: %d %s", r.Status, r.Text());
  const size_t intents = calls(ctx, {"Intent"});
  r = a.post({{"question", kQuestion}, {"workspace", "core-services"}}, "ana", "k-core");
  ctx.Assert(ok(r.Status) && bodyOf(ctx, r).value("workspace", "") == "core-services", "a system workspace the caller names is used as given: %d %s", r.Status, r.Text());
  ctx.Equal(calls(ctx, {"Intent"}), intents, "with a valid workspace in the body the intent agent must not be asked; Intent calls");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto& a = api(ctx);
  ctx.Equal(a.post(kGood, "ana", "").Status, 400, "a request without Idempotency-Key");
  ctx.Equal(calls(ctx), 0, "a request without Idempotency-Key reached the agents; agent calls");
  const auto first = a.post(kGood, "ana", "k-7");
  ctx.Assert(ok(first.Status), "the first request answered %d: %s", first.Status, first.Text());
  const size_t picks = calls(ctx, {"PickTables"});
  const auto replay = a.post(kGood, "ana", "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (user, Idempotency-Key) must answer the stored query");
  ctx.Equal(bodyOf(ctx, replay)["query_id"], bodyOf(ctx, first)["query_id"], "the replay must return the same query");
  ctx.Equal(calls(ctx, {"PickTables"}), picks, "a replay ran the agents again (the client retried, the chain must not); PickTables calls");
  const auto other = a.post(kGood, "ben", "k-7");
  ctx.Assert(ok(other.Status) && bodyOf(ctx, other)["query_id"] != bodyOf(ctx, first)["query_id"], "another user reusing the key gets their own query (keys are per user)");
  ctx.Equal(ctx.Redis.Keys("query:*").size(), 2, "two users, two queries; records");
}

void CheckPendingAck(harness::Ctx& ctx) {
  auto& a = api(ctx);
  const auto r = a.post(kGood, "ana", "k-ack");
  ctx.Equal(r.Status, 202, "a proposal waiting for the user's ACK");
  const json body = bodyOf(ctx, r);
  ctx.Equal(body.value("status", ""), "pending_ack", "status");
  ctx.Assert(body["tables_proposed"] == json({"trips", "drivers"}), "tables_proposed must be the table agent's pick: %s", r.Text());
  ctx.Assert(body["tables_acked"] == json::array() && body.value("sql", "?") == "", "nothing is ACKed or generated yet: %s", r.Text());
  ctx.Equal(calls(ctx, {"Generate"}), 0, "Generate ran before the user ACKed the tables; Generate calls");
  const auto stored = ctx.Redis.Get("query:" + body.value("query_id", ""));
  ctx.Assert(stored && json::parse(*stored, nullptr, false).value("status", "") == "pending_ack", "the stored record must say pending_ack: %s", stored.value_or("(none)"));
}
`,
  },
  hints: [
    'Symptom: a client that retried a slow request sees two queries and two rounds of model calls, a pasted forty-page document ties up the agents, a question tagged `finance` gets tables anyway, and the SQL exists before anyone looked at the tables.',
    "Mechanism: the handler never reads `Idempotency-Key`, measures nothing, hands the caller's `workspace` (or the intent agent's answer) to the table agent unchecked, and calls `Generate` straight after `PickTables`.",
    'Change: guards in order (401, key 400, empty 400, over 2000 → 413, unknown workspace 400), `store.find` → 200; an intent answer outside `SYSTEM_WORKSPACES` → 422; `PickTables`, then `store.put(user, key, record)` with `pending_ack` and 202. No `Generate`.',
  ],
  debrief: `The fix moves every decision the service can make on its own ahead of the first agent call, and ends the handler one call earlier. A missing header or an oversized question costs nothing to refuse; an intent call costs a model round trip. The caller's workspace and the intent agent's answer pass the same allow-list, because a hallucinated workspace is as untrusted as a typed one. Keying by \`(user, Idempotency-Key)\` makes a retry return the stored proposal instead of paying for the chain twice. Stopping at the proposal is the product contract: QueryGPT added the ACK because users saw wrong tables picked, so SQL waits for it. Production services also let teams own custom workspaces, which turns the allow-list into a per-user lookup.`,
};
