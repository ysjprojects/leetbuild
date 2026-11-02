import type {Step} from '@/lib/types';

export const queryEndpointStep: Step = {
  id: 'query-endpoint',
  title: 'POST /v1/queries: workspace resolved, tables proposed for ACK',
  concept: 'http',
  file: 'queries_api',
  focus: ['analyst', 'api', 'agents', 'workspaces'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/queries\` with body
\`{"question": "…", "workspace": "mobility"}\` (\`workspace\` optional), reads \`X-User-Id\`, passes
the caller's workspace string (or the intent agent's answer) to the table agent, calls \`Generate\`
and returns SQL in one round trip. It compiles, serves the demo and hides 4 flaws.

**Failure mode the checks target.** Trusting \`workspace\` lets a caller aim the agents at any
curated table set; a missing cap turns one pasted document into a minute of model calls; an
un-keyed endpoint runs the chain again on every client retry; and generating before the ACK makes
the ACK a formality on SQL that already exists.

Requirements:

- A missing \`X-User-Id\` is **401**; a missing \`Idempotency-Key\` is **400**, and a retry with the
  same \`(user, key)\` returns the stored record instead of running the agents again.
- \`question\` is non-empty and at most **2000** characters (\`MAX_QUESTION_CHARS\`): empty is
  **400**, longer is **413**.
- \`workspace\`, when given, must be in \`SYSTEM_WORKSPACES\` (\`mobility\`, \`ads\`, \`core-services\`,
  \`platform-engineering\`, \`it\`), **400** otherwise. When absent, the **intent agent** picks one
  and its answer is checked against the same list, **422** when nothing matches.
- The **table agent** proposes tables; respond **202** with \`status: "pending_ack"\`, the query id
  and \`tables_proposed\`. SQL is generated only after the user ACKs or edits the list.`,
  sequence: {
    participants: ['Analyst', 'querygen', 'Agents', 'query store'],
    messages: [
      {from: 'Analyst', to: 'querygen', label: 'POST /v1/queries · X-User-Id · Idempotency-Key', kind: 'sync'},
      {from: 'querygen', to: 'querygen', label: 'validate user · key · question · workspace', kind: 'sync'},
      {from: 'querygen', to: 'query store', label: 'get(user, idem_key)', kind: 'sync'},
      {from: 'query store', to: 'querygen', label: 'stored record / none', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'Intent(question) when no workspace given', kind: 'sync'},
      {from: 'Agents', to: 'querygen', label: '{workspace} · checked against SYSTEM_WORKSPACES', kind: 'reply'},
      {from: 'querygen', to: 'Agents', label: 'PickTables(question, workspace)', kind: 'sync'},
      {from: 'Agents', to: 'querygen', label: '{tables}', kind: 'reply'},
      {from: 'querygen', to: 'query store', label: 'put(user, idem_key, record)', kind: 'async'},
      {
        from: 'querygen',
        to: 'Analyst',
        label: '202 {query_id, workspace, tables_proposed, pending_ack}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/queries',
      detail: 'Register the query route on `POST /v1/queries`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/queries["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/queries['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/queries"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"queries"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/queries"/]},
      },
    },
    {
      id: 'auth-idempotency',
      title: 'Authenticates the user and keys retries by (user, Idempotency-Key)',
      detail:
        'A missing `X-User-Id` is **401**; `Idempotency-Key` is required and the record is stored under `(user, key)` so a replay returns it instead of running the agents again. The starter takes the header as given and ignores the key.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/code\(\s*401\s*\)/, /idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/StatusUnauthorized/, /Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/\b401\b/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'question-cap',
      title: 'Caps the question at 2000 characters',
      detail:
        'An empty question is **400** and one over `MAX_QUESTION_CHARS = 2000` is **413**, before any agent is called. The starter forwards whatever arrives, so one pasted document becomes a chain of oversized model calls.',
      match: {
        python: {all: [/MAX_QUESTION_CHARS\s*=\s*2000/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_QUESTION_CHARS\s*=\s*2000/, /code\(\s*413\s*\)/]},
        go: {all: [/maxQuestionChars\s*=\s*2000/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxQuestionChars\s*=\s*2000/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxQuestionChars\s*=\s*2000/, /\b413\b/]},
      },
    },
    {
      id: 'workspace-allowlist',
      title: 'Resolves the workspace against the system allow-list',
      detail:
        'A caller-supplied `workspace` must be in `SYSTEM_WORKSPACES` (**400** otherwise), and the intent agent’s answer is checked against the same set in `resolve_workspace`. The starter passes the caller’s string straight to the agents.',
      match: {
        python: {all: [/SYSTEM_WORKSPACES/, /def resolve_workspace\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/SYSTEM_WORKSPACES/, /function resolveWorkspace\(/, /code\(\s*400\s*\)/]},
        go: {all: [/systemWorkspaces/, /func resolveWorkspace\(/, /StatusBadRequest/]},
        scala: {all: [/SystemWorkspaces/, /def resolveWorkspace\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kSystemWorkspaces/, /resolveWorkspace\(/, /\b400\b/]},
      },
    },
    {
      id: 'pending-ack',
      title: 'Proposes tables for ACK and does not generate yet',
      detail:
        'The response carries `tables_proposed` with `status: "pending_ack"` and the handler never calls `Generate`; SQL is produced only after the user ACKs the table list. The starter generates immediately with whatever the table agent picked.',
      match: {
        python: {all: [/pending_ack/, /\.PickTables\(/], none: [/\.Generate\(/]},
        typescript: {all: [/pending_ack/, /\.PickTables\(/], none: [/\.Generate\(/]},
        go: {all: [/pending_ack/, /\.PickTables\(/], none: [/\.Generate\(/]},
        scala: {all: [/pending_ack/, /\.pickTables\(/], none: [/\.generate\(/]},
        cpp: {all: [/pending_ack/, /->PickTables\(/], none: [/->Generate\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

import grpc
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import agents_pb2
import agents_pb2_grpc

app = FastAPI()
logger = logging.getLogger("querygen")

agents = agents_pb2_grpc.AgentsStub(grpc.insecure_channel("agents:9000"))


class QueryRequest(BaseModel):
    question: str
    workspace: str | None = None


class QueryStore:
    def get(self, user: str, idem_key: str):
        """The record stored for (user, idem_key), if any."""
        raise NotImplementedError

    def put(self, user: str, idem_key: str, record: dict) -> None:
        """Store the record under (user, idem_key)."""
        raise NotImplementedError


store = QueryStore()


@app.post("/v1/queries")
def create_query(body: QueryRequest, user: str = Header(alias="X-User-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    workspace = body.workspace
    if workspace is None:
        workspace = agents.Intent(agents_pb2.IntentRequest(question=body.question)).workspace
    picked = agents.PickTables(agents_pb2.PickTablesRequest(question=body.question, workspace=workspace))
    generated = agents.Generate(
        agents_pb2.GenerateRequest(question=body.question, workspace=workspace, tables=picked.tables)
    )
    logger.info("query user=%s workspace=%s", user, workspace)
    return JSONResponse(
        {
            "query_id": str(uuid.uuid4()),
            "workspace": workspace,
            "tables": list(picked.tables),
            "sql": generated.text,
        },
        status_code=200,
    )
`,
      solution: `import logging
import uuid

import grpc
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import agents_pb2
import agents_pb2_grpc

app = FastAPI()
logger = logging.getLogger("querygen")

MAX_QUESTION_CHARS = 2000
SYSTEM_WORKSPACES = {"mobility", "ads", "core-services", "platform-engineering", "it"}
AGENT_DEADLINE_S = 10.0

agents = agents_pb2_grpc.AgentsStub(grpc.insecure_channel("agents:9000"))


class QueryRequest(BaseModel):
    question: str
    workspace: str | None = None


class QueryStore:
    def get(self, user: str, idem_key: str) -> dict | None:
        """The record stored for (user, idem_key), if any."""
        raise NotImplementedError

    def put(self, user: str, idem_key: str, record: dict) -> None:
        """Store the record under (user, idem_key)."""
        raise NotImplementedError


store = QueryStore()


def resolve_workspace(question: str, requested: str | None) -> str:
    if requested is not None:
        if requested not in SYSTEM_WORKSPACES:
            raise HTTPException(status_code=400, detail="unknown workspace")
        return requested
    intent = agents.Intent(agents_pb2.IntentRequest(question=question), timeout=AGENT_DEADLINE_S)
    if intent.workspace not in SYSTEM_WORKSPACES:
        raise HTTPException(status_code=422, detail="no system workspace matches the question")
    return intent.workspace


@app.post("/v1/queries")
def create_query(
    body: QueryRequest,
    user: str | None = Header(default=None, alias="X-User-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if user is None or user == "":
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    question = body.question.strip()
    if question == "":
        raise HTTPException(status_code=400, detail="question must be a non-empty string")
    if len(question) > MAX_QUESTION_CHARS:
        raise HTTPException(status_code=413, detail="question exceeds 2000 characters")

    stored = store.get(user, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=202)

    workspace = resolve_workspace(question, body.workspace)
    picked = agents.PickTables(
        agents_pb2.PickTablesRequest(question=question, workspace=workspace), timeout=AGENT_DEADLINE_S
    )
    record = {
        "query_id": str(uuid.uuid4()),
        "workspace": workspace,
        "tables_proposed": list(picked.tables),
        "status": "pending_ack",
    }
    store.put(user, idem_key, record)
    logger.info(
        "query id=%s user=%s workspace=%s tables=%d", record["query_id"], user, workspace, len(picked.tables)
    )
    return JSONResponse(record, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/queries: the starter. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {agents} from './agents';

export const app = Fastify();

interface QueryBody {
  question: string;
  workspace?: string;
}

app.post('/v1/queries', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const user = request.headers['x-user-id'] as string;
  const body = request.body as QueryBody;
  const workspace = body.workspace ?? (await agents.Intent({question: body.question})).workspace;
  const picked = await agents.PickTables({question: body.question, workspace});
  const generated = await agents.Generate({question: body.question, workspace, tables: picked.tables});
  request.log.info({user, workspace}, 'query');
  return reply.code(200).send({query_id: randomUUID(), workspace, tables: picked.tables, sql: generated.text});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/queries: authenticated, capped, idempotent; tables proposed for ACK, no SQL yet. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {agents} from './agents';
import {store} from './store';

export const app = Fastify();

const MAX_QUESTION_CHARS = 2000;
const SYSTEM_WORKSPACES: Record<string, true> = {
  mobility: true,
  ads: true,
  'core-services': true,
  'platform-engineering': true,
  it: true,
};
const AGENT_DEADLINE_MS = 10_000;

interface QueryBody {
  question: string;
  workspace?: string;
}

interface QueryRecord {
  query_id: string;
  workspace: string;
  tables_proposed: string[];
  status: 'pending_ack';
}

class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function resolveWorkspace(question: string, requested: string | undefined): Promise<string> {
  if (requested !== undefined) {
    if (SYSTEM_WORKSPACES[requested] !== true) throw new WorkspaceError(400, 'unknown workspace');
    return requested;
  }
  const intent = await agents.Intent({question}, {deadline: Date.now() + AGENT_DEADLINE_MS});
  if (SYSTEM_WORKSPACES[intent.workspace] !== true)
    throw new WorkspaceError(422, 'no system workspace matches the question');
  return intent.workspace;
}

app.post('/v1/queries', async (request, reply) => {
  const user = request.headers['x-user-id'];
  if (typeof user !== 'string' || user === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<QueryBody> | null;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (question === '') return reply.code(400).send({error: 'question must be a non-empty string'});
  if (question.length > MAX_QUESTION_CHARS) return reply.code(413).send({error: 'question exceeds 2000 characters'});

  const stored: QueryRecord | null = await store.get(user, idemKey);
  if (stored !== null) return reply.code(202).send(stored);

  let workspace: string;
  try {
    workspace = await resolveWorkspace(question, body?.workspace);
  } catch (error) {
    if (error instanceof WorkspaceError) return reply.code(error.status).send({error: error.message});
    throw error;
  }
  const picked = await agents.PickTables({question, workspace}, {deadline: Date.now() + AGENT_DEADLINE_MS});
  const record: QueryRecord = {
    query_id: randomUUID(),
    workspace,
    tables_proposed: picked.tables,
    status: 'pending_ack',
  };
  await store.put(user, idemKey, record);
  request.log.info({query_id: record.query_id, user, workspace, tables: picked.tables.length}, 'query');
  return reply.code(202).send(record);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	pb "querygen/agentspb"
)

var agents pb.AgentsClient

type QueryRequest struct {
	Question  string \`json:"question"\`
	Workspace string \`json:"workspace"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createQuery(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	var body QueryRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	workspace := body.Workspace
	if workspace == "" {
		intent, _ := agents.Intent(r.Context(), &pb.IntentRequest{Question: body.Question})
		workspace = intent.Workspace
	}
	picked, _ := agents.PickTables(r.Context(), &pb.PickTablesRequest{Question: body.Question, Workspace: workspace})
	generated, _ := agents.Generate(r.Context(), &pb.GenerateRequest{Question: body.Question, Workspace: workspace, Tables: picked.Tables})
	log.Printf("query user=%s workspace=%s", user, workspace)
	writeJSON(rw, http.StatusOK, map[string]any{
		"query_id":  uuid.NewString(),
		"workspace": workspace,
		"tables":    picked.Tables,
		"sql":       generated.Text,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/queries", createQuery)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	pb "querygen/agentspb"
)

const (
	maxQuestionChars = 2000
	agentDeadline    = 10 * time.Second
)

var systemWorkspaces = map[string]bool{
	"mobility":             true,
	"ads":                  true,
	"core-services":        true,
	"platform-engineering": true,
	"it":                   true,
}

var agents pb.AgentsClient

type QueryRequest struct {
	Question  string \`json:"question"\`
	Workspace string \`json:"workspace"\`
}

type QueryRecord struct {
	QueryID        string   \`json:"query_id"\`
	Workspace      string   \`json:"workspace"\`
	TablesProposed []string \`json:"tables_proposed"\`
	Status         string   \`json:"status"\`
}

type QueryStore struct{}

func (s *QueryStore) Get(ctx context.Context, user, idemKey string) (*QueryRecord, error) {
	return nil, nil
}

func (s *QueryStore) Put(ctx context.Context, user, idemKey string, record *QueryRecord) error {
	return nil
}

var store = &QueryStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// resolveWorkspace returns the workspace and the HTTP status to answer when there is none.
func resolveWorkspace(ctx context.Context, question, requested string) (string, int) {
	if requested != "" {
		if !systemWorkspaces[requested] {
			return "", http.StatusBadRequest
		}
		return requested, 0
	}
	callCtx, cancel := context.WithTimeout(ctx, agentDeadline)
	defer cancel()
	intent, err := agents.Intent(callCtx, &pb.IntentRequest{Question: question})
	if err != nil {
		return "", http.StatusBadGateway
	}
	if !systemWorkspaces[intent.Workspace] {
		return "", http.StatusUnprocessableEntity
	}
	return intent.Workspace, 0
}

func createQuery(rw http.ResponseWriter, r *http.Request) {
	user := r.Header.Get("X-User-Id")
	if user == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-User-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body QueryRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	question := strings.TrimSpace(body.Question)
	if question == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "question must be a non-empty string"})
		return
	}
	if len([]rune(question)) > maxQuestionChars {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "question exceeds 2000 characters"})
		return
	}
	stored, err := store.Get(r.Context(), user, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusAccepted, stored)
		return
	}
	workspace, status := resolveWorkspace(r.Context(), question, body.Workspace)
	if status != 0 {
		writeJSON(rw, status, map[string]string{"error": "workspace could not be resolved"})
		return
	}
	callCtx, cancel := context.WithTimeout(r.Context(), agentDeadline)
	defer cancel()
	picked, err := agents.PickTables(callCtx, &pb.PickTablesRequest{Question: question, Workspace: workspace})
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "table agent failed"})
		return
	}
	record := &QueryRecord{
		QueryID:        uuid.NewString(),
		Workspace:      workspace,
		TablesProposed: picked.Tables,
		Status:         "pending_ack",
	}
	if err := store.Put(r.Context(), user, idemKey, record); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("query id=%s user=%s workspace=%s tables=%d", record.QueryID, user, workspace, len(picked.Tables))
	writeJSON(rw, http.StatusAccepted, record)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/queries", createQuery)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class QueryRequest(question: String, workspace: Option[String])

object QueriesApi {
  implicit val system: ActorSystem = ActorSystem("querygen")
  implicit val requestFormat: RootJsonFormat[QueryRequest] = jsonFormat2(QueryRequest)

  val agents = AgentsGrpc.blockingStub(ManagedChannelBuilder.forAddress("agents", 9000).usePlaintext().build())

  val route: Route =
    path("v1" / "queries") {
      post {
        headerValueByName("X-User-Id") { user =>
          entity(as[QueryRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val workspace = body.workspace.getOrElse(agents.intent(IntentRequest(question = body.question)).workspace)
            val picked = agents.pickTables(PickTablesRequest(question = body.question, workspace = workspace))
            val generated =
              agents.generate(GenerateRequest(question = body.question, workspace = workspace, tables = picked.tables))
            system.log.info(s"query user=$user workspace=$workspace")
            val tables = picked.tables.map(t => s""""$t"""").mkString("[", ",", "]")
            complete(
              StatusCodes.OK,
              s"""{"query_id":"\${UUID.randomUUID()}","workspace":"$workspace","tables":$tables,"sql":\${generated.text}}"""
            )
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

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class QueryRequest(question: String, workspace: Option[String])
final case class QueryRecord(query_id: String, workspace: String, tables_proposed: Seq[String], status: String)

object QueriesApi {
  implicit val system: ActorSystem = ActorSystem("querygen")
  implicit val requestFormat: RootJsonFormat[QueryRequest] = jsonFormat2(QueryRequest)
  implicit val recordFormat: RootJsonFormat[QueryRecord] = jsonFormat4(QueryRecord)

  val MaxQuestionChars = 2000
  val SystemWorkspaces = Set("mobility", "ads", "core-services", "platform-engineering", "it")
  val AgentDeadlineMs = 10000L

  val agents = AgentsGrpc.blockingStub(ManagedChannelBuilder.forAddress("agents", 9000).usePlaintext().build())
  val store = QueryStore.open()

  def resolveWorkspace(question: String, requested: Option[String]): Either[StatusCode, String] =
    requested match {
      case Some(ws) if SystemWorkspaces.contains(ws) => Right(ws)
      case Some(_) => Left(StatusCodes.BadRequest)
      case None =>
        val intent = agents
          .withDeadlineAfter(AgentDeadlineMs, TimeUnit.MILLISECONDS)
          .intent(IntentRequest(question = question))
        if (SystemWorkspaces.contains(intent.workspace)) Right(intent.workspace)
        else Left(StatusCodes.UnprocessableEntity)
    }

  val route: Route =
    path("v1" / "queries") {
      post {
        optionalHeaderValueByName("X-User-Id") { userOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[QueryRequest]) { body =>
              val question = body.question.trim
              if (!userOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (question.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"question must be a non-empty string"}""")
              } else if (question.length > MaxQuestionChars) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"question exceeds 2000 characters"}""")
              } else {
                val user = userOpt.get
                val idemKey = idemOpt.get
                store.get(user, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.Accepted, stored)
                  case None =>
                    resolveWorkspace(question, body.workspace) match {
                      case Left(status) =>
                        complete(status, """{"error":"workspace could not be resolved"}""")
                      case Right(workspace) =>
                        val picked = agents
                          .withDeadlineAfter(AgentDeadlineMs, TimeUnit.MILLISECONDS)
                          .pickTables(PickTablesRequest(question = question, workspace = workspace))
                        val record = QueryRecord(UUID.randomUUID().toString, workspace, picked.tables, "pending_ack")
                        store.put(user, idemKey, record)
                        system.log.info(
                          s"query id=\${record.query_id} user=$user workspace=$workspace tables=\${picked.tables.size}"
                        )
                        complete(StatusCodes.Accepted, record)
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

#include "agents.grpc.pb.h"

#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

std::unique_ptr<Agents::Stub> agents;
std::string uuidString();

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");
  agents = Agents::NewStub(grpc::CreateChannel("agents:9000", grpc::InsecureChannelCredentials()));

  svr.Post("/v1/queries", [](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto question = body.value("question", std::string());
    auto workspace = body.value("workspace", std::string());
    if (workspace.empty()) {
      grpc::ClientContext ctx;
      IntentRequest request;
      request.set_question(question);
      IntentReply intent;
      agents->Intent(&ctx, request, &intent);
      workspace = intent.workspace();
    }
    grpc::ClientContext pickCtx;
    PickTablesRequest pickRequest;
    pickRequest.set_question(question);
    pickRequest.set_workspace(workspace);
    PickTablesReply picked;
    agents->PickTables(&pickCtx, pickRequest, &picked);
    grpc::ClientContext genCtx;
    GenerateRequest genRequest;
    genRequest.set_question(question);
    genRequest.set_workspace(workspace);
    for (const auto& table : picked.tables()) genRequest.add_tables(table);
    GenerateReply generated;
    agents->Generate(&genCtx, genRequest, &generated);
    std::cerr << "query user=" << user << " workspace=" << workspace << "\\n";
    const std::vector<std::string> tables(picked.tables().begin(), picked.tables().end());
    res.status = 200;
    res.set_content(
        json{{"query_id", uuidString()}, {"workspace", workspace}, {"tables", tables}, {"sql", generated.text()}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "agents.grpc.pb.h"

#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxQuestionChars = 2000;
constexpr int kAgentDeadlineMs = 10000;
const std::set<std::string> kSystemWorkspaces = {"mobility", "ads", "core-services", "platform-engineering", "it"};

struct QueryStore {
  std::optional<json> get(const std::string& user, const std::string& idemKey);
  void put(const std::string& user, const std::string& idemKey, const json& record);
};

QueryStore store;
std::unique_ptr<Agents::Stub> agents;
std::string uuidString();

std::string trim(const std::string& s) {
  const auto first = s.find_first_not_of(" \\t\\r\\n");
  if (first == std::string::npos) return "";
  const auto last = s.find_last_not_of(" \\t\\r\\n");
  return s.substr(first, last - first + 1);
}

// Returns the workspace, or sets status to the HTTP answer when there is none.
std::string resolveWorkspace(const std::string& question, const std::string& requested, int& status) {
  status = 0;
  if (!requested.empty()) {
    if (kSystemWorkspaces.count(requested) == 0) status = 400;
    return requested;
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kAgentDeadlineMs));
  IntentRequest request;
  request.set_question(question);
  IntentReply intent;
  if (!agents->Intent(&ctx, request, &intent).ok()) {
    status = 502;
    return "";
  }
  if (kSystemWorkspaces.count(intent.workspace()) == 0) status = 422;
  return intent.workspace();
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");
  agents = Agents::NewStub(grpc::CreateChannel("agents:9000", grpc::InsecureChannelCredentials()));

  svr.Post("/v1/queries", [](const httplib::Request& req, httplib::Response& res) {
    const auto user = req.get_header_value("X-User-Id");
    if (user.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-User-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("question") || !body["question"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"question must be a non-empty string"})", "application/json");
      return;
    }
    const auto question = trim(body["question"].get<std::string>());
    if (question.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"question must be a non-empty string"})", "application/json");
      return;
    }
    if (question.size() > kMaxQuestionChars) {
      res.status = 413;
      res.set_content(R"({"error":"question exceeds 2000 characters"})", "application/json");
      return;
    }
    const auto stored = store.get(user, idemKey);
    if (stored) {
      res.status = 202;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    int status = 0;
    const auto workspace = resolveWorkspace(question, body.value("workspace", std::string()), status);
    if (status != 0) {
      res.status = status;
      res.set_content(R"({"error":"workspace could not be resolved"})", "application/json");
      return;
    }
    grpc::ClientContext pickCtx;
    pickCtx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kAgentDeadlineMs));
    PickTablesRequest pickRequest;
    pickRequest.set_question(question);
    pickRequest.set_workspace(workspace);
    PickTablesReply picked;
    if (!agents->PickTables(&pickCtx, pickRequest, &picked).ok()) {
      res.status = 502;
      res.set_content(R"({"error":"table agent failed"})", "application/json");
      return;
    }
    const std::vector<std::string> tables(picked.tables().begin(), picked.tables().end());
    const json record = {
        {"query_id", uuidString()},
        {"workspace", workspace},
        {"tables_proposed", tables},
        {"status", "pending_ack"},
    };
    store.put(user, idemKey, record);
    std::cerr << "query id=" << record["query_id"] << " user=" << user << " workspace=" << workspace
              << " tables=" << tables.size() << "\\n";
    res.status = 202;
    res.set_content(record.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Symptoms: a typo in `workspace` becomes a 502 from the agents, a pasted document runs for a minute, a retry doubles the bill, and the response carries SQL the user never confirmed.',
    'The handler validates nothing before the first agent call: no user or key check, no length check, the workspace string goes straight to `PickTables`, and `Generate` runs in the same request.',
    'Guard clauses first (401 user, 400 key, 400/413 question, workspace via one `resolve_workspace` against `SYSTEM_WORKSPACES`), look up `(user, key)`, then stop at `PickTables`: store and return 202 `pending_ack` with `tables_proposed`, no `Generate`.',
  ],
  debrief: `The fix moves every decision the service can make on its own ahead of the first agent call, and ends the handler one call earlier. Rejections are ordered by cost: a missing header or an oversized question costs nothing to refuse, an intent call costs seconds and money. Workspace resolution lives in one function so the caller's string and the intent agent's answer pass through the same allow-list. Idempotency keyed by (user, key) makes a client retry return the stored record. Stopping at the table proposal is the product contract: QueryGPT added the table agent because users saw the wrong tables picked, so SQL comes only after the ACK. Production services also carry user-owned custom workspaces, a prompt enhancer for five-word questions, and a trace id across every agent.`,
};
