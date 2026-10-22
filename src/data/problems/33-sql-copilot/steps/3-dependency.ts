import type {Step} from '@/lib/types';

export const sqlDependencyStep: Step = {
  id: 'dependency',
  title: 'Warehouse validation before a query is ever offered',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'warehouse', 'model'],
  task: `## Task

The starter is a plausible model-generated draft: the demo asks a short question, the warehouse
agrees with the draft, and the SQL comes back. Review it like the service owner, fix the validation
path, and prove the fix.

Implement the warehouse gate of \`POST /v1/queries/generate\`: what the model wrote is a suggestion
until the warehouse has dry-run it.

- Every dry-run is a gRPC \`DryRun(schema, statement)\` against the warehouse with a **2-second
  deadline on the call itself** (\`timeout=\`, \`deadline:\`, \`context.WithTimeout\`,
  \`withDeadlineAfter\`, \`set_deadline\`). A call without one lets a slow warehouse hold the request
  — and the caller — open until some unrelated timeout fires.
- Validation **fails closed**. A dry-run that errors or exhausts its deadline denies the query with
  **503**, produced by one \`validation_error(...)\` helper, and returns **no \`sql\` field at all**.
  "We could not check it" is not "it is probably fine".
- Retry **only** \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` — the two codes another attempt can fix. A
  syntax rejection is deterministic: it is returned immediately, not retried.
- The dry-run is **unconditional**. It runs for every statement, whatever its length; the long
  generated join is exactly the statement that needs the review.
- The statement is returned only after a successful dry-run, and the response reports
  \`"validated": true\`.

**Failure mode the checks target.** The draft logs the dry-run failure and returns the SQL anyway
(\`logger.warning\` / \`console.warn\` on the way out), so a two-second warehouse outage becomes a
licence to run an unvalidated statement. It wraps the call in a three-attempt loop that catches
every exception and continues, so a syntax rejection the warehouse will always reject is retried
three times — and then, worse, returned to the caller. And it only validates statements under 100
characters, which means the one statement that most needs a dry-run, the five-table join the model
generated from a long question, is the one that never gets one. All three are invisible in the demo,
where the warehouse is healthy and the question is short.`,
  sequence: {
    participants: ['SQL Copilot', 'Model', 'Warehouse'],
    messages: [
      {from: 'SQL Copilot', to: 'Model', label: 'Generate(question, schema, dialect)', kind: 'sync'},
      {from: 'Model', to: 'SQL Copilot', label: 'draft statement', kind: 'reply'},
      {from: 'SQL Copilot', to: 'Warehouse', label: 'DryRun(schema, statement) · deadline = 2 s', kind: 'sync'},
      {from: 'Warehouse', to: 'SQL Copilot', label: 'OK', kind: 'reply'},
      {from: 'SQL Copilot', to: 'SQL Copilot', label: '200 {sql, dialect, "validated": true}', kind: 'sync'},
      {from: 'Warehouse', to: 'SQL Copilot', label: 'DEADLINE_EXCEEDED after the 2 s deadline', kind: 'reply'},
      {from: 'SQL Copilot', to: 'SQL Copilot', label: 'validation_error ⇒ 503 {error}, no sql field', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every dry-run carries a two-second deadline',
      detail:
        'The validation call is bounded: `VALIDATION_DEADLINE_S = 2` with `timeout=VALIDATION_DEADLINE_S` (Go: `validationDeadline = 2 * time.Second` through `context.WithTimeout`; Scala: `withDeadlineAfter`; C++: `set_deadline`). The draft calls the stub with no deadline and no context.',
      match: {
        python: {all: [/VALIDATION_DEADLINE_S\s*=\s*2/, /timeout\s*=\s*VALIDATION_DEADLINE_S/]},
        typescript: {all: [/VALIDATION_DEADLINE_MS\s*=\s*2000/, /deadline\s*:/]},
        go: {all: [/validationDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\(/]},
        scala: {all: [/ValidationDeadlineSeconds\s*=\s*2/, /withDeadlineAfter\(/]},
        cpp: {all: [/kValidationDeadlineMs\s*=\s*2000/, /set_deadline\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'A failed dry-run denies the query',
      detail:
        'A timeout or an erroring dry-run produces a **503** through one `validation_error(...)` helper and no SQL is returned. The draft logs the error, calls it a warning and returns the statement anyway.',
      match: {
        python: {all: [/def validation_error\(/, /AioRpcError/, /status_code\s*=\s*503/]},
        typescript: {all: [/function validationError\(/, /UNAVAILABLE/, /\b503\b/]},
        go: {all: [/func validationError\(/, /codes\.Unavailable/, /StatusServiceUnavailable/]},
        scala: {all: [/def validationError\(/, /Status\.UNAVAILABLE/, /StatusCodes\.ServiceUnavailable/]},
        cpp: {all: [/validationError\(/, /UNAVAILABLE/, /\b503\b/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED',
      detail:
        'The retryable set is exactly those two codes; a syntax rejection fails immediately. The draft catches every exception and retries a statement the warehouse will always reject.',
      match: {
        python: {all: [/RETRYABLE_CODES/, /StatusCode\.UNAVAILABLE/, /StatusCode\.DEADLINE_EXCEEDED/]},
        typescript: {all: [/RETRYABLE_CODES/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        go: {all: [/retryableCodes/, /codes\.Unavailable/, /codes\.DeadlineExceeded/]},
        scala: {all: [/RetryableCodes/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/kRetryableCodes/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'validate-every-statement',
      title: 'Validates every statement, whatever its length',
      detail:
        'The dry-run is unconditional — there is no length gate. The draft validates only statements under 100 characters, so a long generated statement is offered to the caller without ever reaching the warehouse.',
      match: {
        python: {all: [/DryRun/], none: [/<\s*100/]},
        typescript: {all: [/DryRun/], none: [/<\s*100/]},
        go: {all: [/DryRun/], none: [/<\s*100/]},
        scala: {all: [/DryRun/], none: [/<\s*100/]},
        cpp: {all: [/DryRun/], none: [/<\s*100/]},
      },
    },
    {
      id: 'reported',
      title: 'The response reports a validated statement',
      detail:
        'The SQL is returned only after the dry-run succeeds and the response carries `"validated"`. The draft never states whether anything was validated.',
      match: {
        python: {order: [/\.DryRun\(/, /"validated"/]},
        typescript: {order: [/\.DryRun\(/, /validated/]},
        go: {order: [/\.DryRun\(/, /"validated"/]},
        scala: {order: [/\.DryRun\(/, /validated/]},
        cpp: {order: [/\.DryRun\(/, /"validated"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/queries/generate: a model-generated draft that validates what it feels like."""
import logging

import grpc

import warehouse_pb2
import warehouse_pb2_grpc
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("copilot")

channel = grpc.insecure_channel("warehouse:9000")
warehouse = warehouse_pb2_grpc.WarehouseStub(channel)


class GenerateRequest(BaseModel):
    question: str
    schema: str
    dialect: str = "postgres"


class ModelClient:
    def Generate(self, question: str, schema: str, dialect: str) -> str:
        """A single statement for \`schema\`, written in \`dialect\`."""
        raise NotImplementedError


models = ModelClient()


@app.post("/v1/queries/generate")
def generate(body: GenerateRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: every statement must be dry-run with the 2 s deadline on the call, a dry-run that
    # fails or times out must deny the query through validation_error (503, no sql) instead of
    # being logged, only UNAVAILABLE / DEADLINE_EXCEEDED may be retried, and the response has to
    # report the validation. Drop the length gate.
    statement = models.Generate(body.question, body.schema, body.dialect)
    confirmed = True
    if len(statement) < 100:
        confirmed = False
        for _ in range(3):
            try:
                warehouse.DryRun(warehouse_pb2.DryRunRequest(schema=body.schema, statement=statement))
                confirmed = True
                break
            except Exception:
                continue
    if not confirmed:
        logger.warning("warehouse never confirmed the statement for tenant=%s", tenant)
    return JSONResponse({"sql": statement, "dialect": body.dialect}, status_code=200)
`,
      solution: `"""POST /v1/queries/generate: the statement is dry-run, or it is not returned."""
import logging

import grpc
import grpc.aio

import warehouse_pb2
import warehouse_pb2_grpc
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("copilot")

VALIDATION_DEADLINE_S = 2
VALIDATION_ATTEMPTS = 3
RETRYABLE_CODES = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.aio.insecure_channel("warehouse:9000")
warehouse = warehouse_pb2_grpc.WarehouseStub(channel)


class GenerateRequest(BaseModel):
    question: str
    schema: str
    dialect: str = "postgres"


class ModelClient:
    def Generate(self, question: str, schema: str, dialect: str) -> str:
        """A single statement for \`schema\`, written in \`dialect\`."""
        raise NotImplementedError


models = ModelClient()


def validation_error(detail: str) -> HTTPException:
    """Fail closed: an unconfirmed statement is never returned to the caller."""
    return HTTPException(status_code=503, detail=detail)


async def dry_run(schema: str, statement: str) -> None:
    """Every statement goes through here: bounded attempts, each with the 2 s deadline."""
    request = warehouse_pb2.DryRunRequest(schema=schema, statement=statement)
    last: grpc.aio.AioRpcError | None = None
    for _ in range(VALIDATION_ATTEMPTS):
        try:
            await warehouse.DryRun(request, timeout=VALIDATION_DEADLINE_S)
            return
        except grpc.aio.AioRpcError as exc:
            if exc.code() not in RETRYABLE_CODES:
                raise validation_error(f"warehouse rejected the statement: {exc.details()}") from exc
            last = exc
    detail = last.details() if last is not None else "the warehouse never answered"
    raise validation_error(f"warehouse timed out before confirming the statement: {detail}")


@app.post("/v1/queries/generate")
async def generate(body: GenerateRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    statement = models.Generate(body.question, body.schema, body.dialect)
    await dry_run(body.schema, statement)
    logger.info("generate tenant=%s schema=%s validated=true", tenant, body.schema)
    return JSONResponse(
        {"sql": statement, "dialect": body.dialect, "validated": True},
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/queries/generate: a model-generated draft that gates on the length of the SQL. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

export const app = Fastify();

class ModelClient {
  async Generate(question: string, schema: string, dialect: string): Promise<string> {
    throw new Error('not implemented');
  }
}

const models = new ModelClient();

interface WarehouseClient {
  DryRun(
    request: {schema: string; statement: string},
    metadata: grpc.Metadata,
    options: object,
    callback: (error: grpc.ServiceError | null, reply: {ok: boolean}) => void,
  ): void;
}

const {warehouse} = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse.proto')) as unknown as {
  warehouse: {Warehouse: new (target: string, credentials: grpc.ChannelCredentials) => WarehouseClient};
};

const stub = new warehouse.Warehouse('warehouse:9000', grpc.credentials.createInsecure());

interface GenerateBody {
  question: string;
  schema: string;
  dialect?: string;
}

app.post('/v1/queries/generate', async (request, reply) => {
  // TODO: every statement must be dry-run with the 2 s deadline on the call, a dry-run that
  // fails or times out must deny the query through validationError (503, no sql) instead of
  // being logged, only UNAVAILABLE / DEADLINE_EXCEEDED may be retried, and the response has to
  // report the validation. Drop the length gate.
  const body = request.body as GenerateBody;
  const dialect = body.dialect ?? 'postgres';
  const statement = await models.Generate(body.question, body.schema, dialect);
  let confirmed = true;
  if (statement.length < 100) {
    confirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          stub.DryRun({schema: body.schema, statement}, new grpc.Metadata(), {}, error => {
            if (error) reject(error);
            else resolve();
          });
        });
        confirmed = true;
        break;
      } catch {
        continue;
      }
    }
  }
  if (!confirmed) console.warn(\`warehouse never confirmed the statement for \${request.headers['x-tenant-id']}\`);
  return reply.code(200).send({sql: statement, dialect});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/queries/generate: the statement is dry-run, or it is not returned. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

export const app = Fastify();

const VALIDATION_DEADLINE_MS = 2000;
const VALIDATION_ATTEMPTS = 3;
const RETRYABLE_CODES: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

class ModelClient {
  async Generate(question: string, schema: string, dialect: string): Promise<string> {
    throw new Error('not implemented');
  }
}

const models = new ModelClient();

interface WarehouseClient {
  DryRun(
    request: {schema: string; statement: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: {ok: boolean}) => void,
  ): void;
}

const {warehouse} = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse.proto')) as unknown as {
  warehouse: {Warehouse: new (target: string, credentials: grpc.ChannelCredentials) => WarehouseClient};
};

const stub = new warehouse.Warehouse('warehouse:9000', grpc.credentials.createInsecure());

interface GenerateBody {
  question: string;
  schema: string;
  dialect?: string;
}

interface ValidationFailure {
  status: number;
  error: string;
}

function validationError(detail: string): ValidationFailure {
  return {status: 503, error: detail};
}

async function dryRun(schema: string, statement: string): Promise<void> {
  const request = {schema, statement};
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < VALIDATION_ATTEMPTS; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        stub.DryRun(request, new grpc.Metadata(), {deadline: Date.now() + VALIDATION_DEADLINE_MS}, error => {
          if (error) reject(error);
          else resolve();
        });
      });
      return;
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (RETRYABLE_CODES[serviceError.code] !== true)
        throw validationError(\`warehouse rejected the statement: \${serviceError.details}\`);
      lastError = serviceError;
    }
  }
  throw validationError(
    \`warehouse timed out before confirming the statement: \${lastError?.details ?? 'the warehouse never answered'}\`,
  );
}

app.post('/v1/queries/generate', async (request, reply) => {
  const body = request.body as GenerateBody;
  const dialect = body.dialect ?? 'postgres';
  const statement = await models.Generate(body.question, body.schema, dialect);
  try {
    await dryRun(body.schema, statement);
  } catch (error) {
    const failure = error as ValidationFailure;
    return reply.code(failure.status).send({error: failure.error});
  }
  request.log.info({tenant: request.headers['x-tenant-id'], schema: body.schema, validated: true}, 'generated');
  return reply.code(200).send({sql: statement, dialect, validated: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "copilot/gen/warehouse"
)

const validationAttempts = 3

var conn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var warehouse = pb.NewWarehouseClient(conn)

type GenerateRequest struct {
	Question string \`json:"question"\`
	Schema   string \`json:"schema"\`
	Dialect  string \`json:"dialect"\`
}

type ModelClient struct{}

func (c *ModelClient) Generate(ctx context.Context, question, schema, dialect string) (string, error) {
	return "", nil
}

var models = &ModelClient{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func generate(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body GenerateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	dialect := body.Dialect
	if dialect == "" {
		dialect = "postgres"
	}
	// TODO: every statement must be dry-run with a context that expires after the 2 s validation
	// deadline, a dry-run that fails or times out must deny the query through validationError
	// (StatusServiceUnavailable, no sql) instead of being logged, only UNAVAILABLE /
	// DEADLINE_EXCEEDED may be retried, and the response has to report the validation. Drop the
	// length gate.
	statement, err := models.Generate(r.Context(), body.Question, body.Schema, dialect)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	confirmed := true
	if len(statement) < 100 {
		confirmed = false
		for attempt := 0; attempt < validationAttempts; attempt++ {
			_, err := warehouse.DryRun(r.Context(), &pb.DryRunRequest{Schema: body.Schema, Statement: statement})
			if err != nil {
				continue
			}
			confirmed = true
			break
		}
	}
	if !confirmed {
		log.Printf("warehouse never confirmed the statement for tenant=%s, returning it anyway", tenant)
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"sql":     statement,
		"dialect": dialect,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/queries/generate", generate)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "copilot/gen/warehouse"
)

const (
	validationAttempts = 3
	validationDeadline = 2 * time.Second
)

var retryableCodes = map[codes.Code]bool{
	codes.Unavailable:      true,
	codes.DeadlineExceeded: true,
}

var conn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var warehouse = pb.NewWarehouseClient(conn)

type GenerateRequest struct {
	Question string \`json:"question"\`
	Schema   string \`json:"schema"\`
	Dialect  string \`json:"dialect"\`
}

type ModelClient struct{}

func (c *ModelClient) Generate(ctx context.Context, question, schema, dialect string) (string, error) {
	return "", nil
}

var models = &ModelClient{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func validationError(detail string) map[string]string {
	return map[string]string{"error": detail}
}

// dryRun validates every statement, with a bounded attempt count and a deadline on every call.
func dryRun(ctx context.Context, schema, statement string) error {
	request := &pb.DryRunRequest{Schema: schema, Statement: statement}
	var last error
	for attempt := 0; attempt < validationAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, validationDeadline)
		_, err := warehouse.DryRun(callCtx, request)
		cancel()
		if err == nil {
			return nil
		}
		last = err
		if !retryableCodes[status.Code(err)] {
			return err
		}
	}
	return last
}

func generate(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body GenerateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	dialect := body.Dialect
	if dialect == "" {
		dialect = "postgres"
	}
	statement, err := models.Generate(r.Context(), body.Question, body.Schema, dialect)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	if err := dryRun(r.Context(), body.Schema, statement); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, validationError("warehouse did not confirm the statement: "+err.Error()))
		return
	}
	log.Printf("generate tenant=%s schema=%s validated=true", tenant, body.Schema)
	writeJSON(rw, http.StatusOK, map[string]any{
		"sql":       statement,
		"dialect":   dialect,
		"validated": true,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/queries/generate", generate)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import copilot.warehouse.{DryRunRequest, WarehouseGrpc}

final case class GenerateRequest(question: String, schema: String, dialect: String)

object Models {
  def generate(question: String, schema: String, dialect: String): String = {
    // A single statement for the schema, written in the requested dialect.
    throw new NotImplementedError
  }
}

object SqlClient {
  implicit val system: ActorSystem = ActorSystem("sql-copilot")
  implicit val generateFormat: RootJsonFormat[GenerateRequest] = jsonFormat3(GenerateRequest)

  private val channel = ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build()
  private val stub = WarehouseGrpc.blockingStub(channel)

  val route: Route =
    path("v1" / "queries" / "generate") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[GenerateRequest]) { body =>
            // TODO: every statement must be dry-run with the 2 s validation deadline on the call,
            // a dry-run that fails or times out must deny the query through validationError
            // (StatusCodes.ServiceUnavailable, no sql) instead of being logged, only UNAVAILABLE /
            // DEADLINE_EXCEEDED may be retried, and the response has to report the validation.
            // Drop the length gate.
            val statement = Models.generate(body.question, body.schema, body.dialect)
            var confirmed = true
            if (statement.length < 100) {
              confirmed = false
              var attempt = 0
              while (attempt < 3 && !confirmed) {
                attempt += 1
                try {
                  stub.dryRun(DryRunRequest(schema = body.schema, statement = statement))
                  confirmed = true
                } catch {
                  case _: Throwable => () // try again
                }
              }
            }
            if (!confirmed) {
              system.log.warning(s"warehouse never confirmed the statement for tenant=$tenant")
            }
            complete(StatusCodes.OK, s"""{"sql":"$statement","dialect":"\${body.dialect}"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.{Route, StandardRoute}
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import copilot.warehouse.{DryRunReply, DryRunRequest, WarehouseGrpc}

final case class GenerateRequest(question: String, schema: String, dialect: String)

object Models {
  def generate(question: String, schema: String, dialect: String): String = {
    // A single statement for the schema, written in the requested dialect.
    throw new NotImplementedError
  }
}

object SqlClient {
  implicit val system: ActorSystem = ActorSystem("sql-copilot")
  implicit val generateFormat: RootJsonFormat[GenerateRequest] = jsonFormat3(GenerateRequest)

  val ValidationDeadlineSeconds = 2L
  val ValidationAttempts = 3
  val RetryableCodes = Set(Status.UNAVAILABLE.getCode, Status.DEADLINE_EXCEEDED.getCode)

  private val channel = ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build()
  private val stub = WarehouseGrpc.blockingStub(channel)

  /** The one place a dry-run happens, so the validation deadline cannot be forgotten at a call site. */
  private class WarehouseClient(stub: WarehouseGrpc.WarehouseStub) {
    def DryRun(request: DryRunRequest): DryRunReply =
      stub.withDeadlineAfter(ValidationDeadlineSeconds, TimeUnit.SECONDS).dryRun(request)
  }

  private val warehouse = new WarehouseClient(stub)

  def validationError(detail: String): StandardRoute =
    complete(StatusCodes.ServiceUnavailable, s"""{"error":"$detail"}""")

  /** None once the warehouse confirmed the statement; Some(reason) when it did not. */
  def dryRun(schema: String, statement: String): Option[String] = {
    var last = "the warehouse never answered"
    for (_ <- 0 until ValidationAttempts) {
      try {
        warehouse.DryRun(DryRunRequest(schema = schema, statement = statement))
        return None
      } catch {
        case exc: StatusRuntimeException =>
          if (!RetryableCodes.contains(exc.getStatus.getCode)) return Some(exc.getStatus.getDescription)
          last = exc.getStatus.getDescription
      }
    }
    Some(last)
  }

  val route: Route =
    path("v1" / "queries" / "generate") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[GenerateRequest]) { body =>
            val statement = Models.generate(body.question, body.schema, body.dialect)
            dryRun(body.schema, statement) match {
              case Some(detail) =>
                validationError(s"warehouse did not confirm the statement: $detail")
              case None =>
                system.log.info(s"generate tenant=$tenant schema=\${body.schema} validated=true")
                complete(
                  StatusCodes.OK,
                  s"""{"sql":"$statement","dialect":"\${body.dialect}","validated":true}"""
                )
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

#include "warehouse.grpc.pb.h"

#include <iostream>
#include <string>

using json = nlohmann::json;
using copilot::DryRunRequest;
using copilot::Warehouse;

class ModelClient {
 public:
  std::string Generate(const std::string& question, const std::string& schema, const std::string& dialect);
};

ModelClient models;

std::unique_ptr<Warehouse::Stub> stub;

int main() {
  httplib::Server svr;
  auto channel = grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials());
  stub = Warehouse::NewStub(channel);

  svr.Post("/v1/queries/generate", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("question") || !body["question"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"question must be a non-empty string"})", "application/json");
      return;
    }
    const auto schema = body.value("schema", std::string());
    const auto dialect = body.value("dialect", std::string("postgres"));
    // TODO: every statement must be dry-run with a 2 s deadline on the call, a dry-run that fails
    // or times out must deny the query through validationError (503, no sql) instead of being
    // logged, only UNAVAILABLE / DEADLINE_EXCEEDED may be retried, and the response has to report
    // the validation. Drop the length gate.
    const auto statement = models.Generate(body["question"].get<std::string>(), schema, dialect);
    bool confirmed = true;
    if (statement.size() < 100) {
      confirmed = false;
      for (int attempt = 0; attempt < 3; ++attempt) {
        grpc::ClientContext ctx;
        DryRunRequest request;
        request.set_schema(schema);
        request.set_statement(statement);
        copilot::DryRunReply reply;
        if (stub->DryRun(&ctx, request, &reply).ok()) {
          confirmed = true;
          break;
        }
      }
    }
    if (!confirmed) {
      std::clog << "warehouse never confirmed the statement, returning it anyway\\n";
    }
    res.status = 200;
    res.set_content(json{{"sql", statement}, {"dialect", dialect}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "warehouse.grpc.pb.h"

#include <chrono>
#include <iostream>
#include <set>
#include <string>

using json = nlohmann::json;
using copilot::DryRunReply;
using copilot::DryRunRequest;
using copilot::Warehouse;

constexpr int kValidationDeadlineMs = 2000;
constexpr int kValidationAttempts = 3;
const std::set<grpc::StatusCode> kRetryableCodes = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

class ModelClient {
 public:
  std::string Generate(const std::string& question, const std::string& schema, const std::string& dialect);
};

ModelClient models;

/** The one place a dry-run happens, so the validation deadline cannot be forgotten at a call site. */
class Validator {
 public:
  explicit Validator(Warehouse::Stub& warehouse) : warehouse_(warehouse) {}

  grpc::Status DryRun(const std::string& schema, const std::string& statement) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kValidationDeadlineMs));
    DryRunRequest request;
    request.set_schema(schema);
    request.set_statement(statement);
    DryRunReply reply;
    return warehouse_.DryRun(&ctx, request, &reply);
  }

 private:
  Warehouse::Stub& warehouse_;
};

void validationError(httplib::Response& res, const std::string& detail) {
  res.status = 503;
  res.set_content(json{{"error", detail}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;
  auto channel = grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials());
  const auto stub = Warehouse::NewStub(channel);
  Validator validator(*stub);

  svr.Post("/v1/queries/generate", [&validator](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("question") || !body["question"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"question must be a non-empty string"})", "application/json");
      return;
    }
    const auto schema = body.value("schema", std::string());
    const auto dialect = body.value("dialect", std::string("postgres"));
    const auto statement = models.Generate(body["question"].get<std::string>(), schema, dialect);

    grpc::Status status;
    for (int attempt = 0; attempt < kValidationAttempts; ++attempt) {
      status = validator.DryRun(schema, statement);
      if (status.ok()) break;
      if (kRetryableCodes.count(status.error_code()) == 0) break;
    }
    if (!status.ok()) {
      validationError(res, "warehouse did not confirm the statement: " + status.error_message());
      return;
    }
    std::clog << "generate schema=" << schema << " validated=true\\n";
    res.status = 200;
    res.set_content(
        json{{"sql", statement}, {"dialect", dialect}, {"validated", true}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The dry-run is not optional and not best-effort: put the deadline on the call (`timeout=VALIDATION_DEADLINE_S`, a `context.WithTimeout` of `validationDeadline`, `withDeadlineAfter`, `set_deadline`) so a hanging warehouse cannot hold the request open.',
    'Fail closed. A timeout or an erroring dry-run must produce a 503 through `validation_error(...)` and return no SQL at all — logging the error and returning the statement anyway is exactly how the DELETE shipped.',
    'Retry only the codes a retry can fix: `UNAVAILABLE` and `DEADLINE_EXCEEDED`. A syntax rejection is deterministic, so retrying it three times only delays the 422 the caller deserves.',
  ],
  debrief: `The interviewer is testing whether validation here is a gate or telemetry. The draft treats the
dry-run as best-effort — it logs the failure and returns the statement anyway — which is exactly how an
unvalidated \`DELETE\` reaches a warehouse during a two-second outage; a gate bounds the check with a
deadline on the call, denies on failure through one \`validation_error\` (503, no SQL), retries only the
two codes a retry can fix, and never negotiates on length, because the long generated statement is the
one that most needs review. Real copilots add a warehouse-side allowlist for what a dry-run may accept,
a plan-cost ceiling that refuses a legal-but-expensive statement, and a validation cache keyed by
statement hash so an identical regenerated query does not pay for a second dry-run.`,
};
