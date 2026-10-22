import type {Step} from '@/lib/types';

export const sqlEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/queries/generate: a question, not a query',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'model', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body, asks the model and returns a statement. It compiles, it serves the demo, and it hides the
one defect that ends a company. Review it like the service owner, fix it, and prove the fix.

Implement \`POST /v1/queries/generate\` with body
\`{"question": "…", "schema": "analytics", "dialect": "postgres"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; the schema handle names the schema
  summary the model is allowed to see.
- \`question\` is a non-empty natural-language string of at most **2 KiB** (\`1 << 11\` bytes) of
  UTF-8; a larger question is **413**. The draft never measures it, so an unbounded prompt goes
  straight into the model.
- \`dialect\` comes from an **allowlist** (\`postgres\`, \`mysql\`, \`bigquery\`); anything else is
  **400**. The draft echoes the caller's string into the prompt, so a caller can talk the model into
  another dialect — or into no dialect at all.
- The response returns the generated statement, the dialect and a **cost estimate** in
  milliseconds: one \`estimated_cost_ms\` per started KiB of statement.
- **The statement may only read.** A server-side verdict (\`is_read_only\`: a leading-keyword
  allowlist over \`select\`/\`with\`/\`explain\`/\`show\`/\`describe\`) decides whether the SQL may
  ever run, the response carries it as \`read_only\`, and a statement that may write is refused with
  **422** before it is returned to anyone.
- Log the outcome with tenant, schema, dialect and verdict — never the question text.

**Failure mode the checks target.** "Delete the stale rows" is a perfectly good English question and
the draft answers it with a \`DELETE\`, which the next steps then run because nothing ever said what
the statement was allowed to do. Answering a write with a statement is not a validation problem to
fix downstream: the generation endpoint is where a draft becomes a query, so the read-only verdict
has to be produced and enforced here, before the SQL leaves the service. The missing 2 KiB cap and
the unchecked dialect are the same defect in a cheaper form: the caller's input reaches the model
unmeasured and unfiltered.`,
  sequence: {
    participants: ['Client', 'SQL Copilot', 'Model'],
    messages: [
      {from: 'Client', to: 'SQL Copilot', label: 'POST /v1/queries/generate · X-Tenant-Id', kind: 'sync'},
      {from: 'SQL Copilot', to: 'SQL Copilot', label: '2 KiB question cap · dialect allowlist', kind: 'sync'},
      {from: 'SQL Copilot', to: 'Model', label: 'question + schema summary + dialect', kind: 'sync'},
      {from: 'Model', to: 'SQL Copilot', label: 'draft statement', kind: 'reply'},
      {from: 'SQL Copilot', to: 'SQL Copilot', label: 'is_read_only(statement) → false ⇒ 422', kind: 'sync'},
      {from: 'SQL Copilot', to: 'Client', label: '200 {sql, dialect, read_only, estimated_cost_ms}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/queries/generate',
      detail: 'Register the generation route on `POST /v1/queries/generate`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/queries\/generate["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/queries\/generate['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/queries\/generate"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"queries"\s*\/\s*"generate"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/queries\/generate"/]},
      },
    },
    {
      id: 'question-cap',
      title: 'Caps the natural-language question at 2 KiB',
      detail:
        'A question over `1 << 11` bytes is **413**. The draft never measures it, so one request can push an unbounded prompt — and an unbounded bill — into the model.',
      match: {
        python: {all: [/MAX_QUESTION_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_QUESTION_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxQuestionBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxQuestionBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxQuestionBytes/, /\b413\b/]},
      },
    },
    {
      id: 'dialect-allowlist',
      title: 'Takes the dialect from an allowlist',
      detail:
        '`dialect` must be one of the allowlisted dialects (**400** otherwise) and is never echoed into the prompt unchecked. The draft forwards whatever string the caller sends.',
      match: {
        python: {all: [/ALLOWED_DIALECTS/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_DIALECTS/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedDialects/, /StatusBadRequest/]},
        scala: {all: [/AllowedDialects/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedDialects/, /\b400\b/]},
      },
    },
    {
      id: 'read-only-verdict',
      title: 'The response marks the statement read-only',
      detail:
        'A server-side prefix allowlist (`is_read_only` / `isReadOnly`) decides whether the statement may run, and the response carries it as `read_only` so nothing downstream has to guess. The draft returns the SQL with no verdict at all.',
      match: {
        python: {all: [/def is_read_only\(/, /"read_only"\s*:/]},
        typescript: {all: [/function isReadOnly\(/, /read_only\s*:/]},
        go: {all: [/func isReadOnly\(/, /"read_only"/]},
        scala: {all: [/def isReadOnly\(/, /"read_only"/]},
        cpp: {all: [/isReadOnly\(/, /"read_only"/]},
      },
    },
    {
      id: 'refuse-write',
      title: 'A statement that may write is refused, not returned',
      detail:
        'When the verdict says the statement is not read-only the request fails with **422** and no SQL leaves the service — that is what keeps “delete the stale rows” from shipping a `DELETE` to the next step.',
      match: {
        python: {all: [/status_code\s*=\s*422/]},
        typescript: {all: [/code\(\s*422\s*\)/]},
        go: {all: [/StatusUnprocessableEntity/]},
        scala: {all: [/StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/\b422\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("copilot")


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
    # TODO: this draft echoes the caller's dialect unchecked, never measures the question and
    # returns a statement with no read-only verdict, so "delete the stale rows" ships a DELETE
    # that the next step will happily run. Review all three.
    logger.info("generate tenant=%s question=%r", tenant, body.question)
    statement = models.Generate(body.question, body.schema, body.dialect)
    return JSONResponse(
        {"sql": statement, "dialect": body.dialect, "estimated_cost_ms": 4},
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("copilot")

MAX_QUESTION_BYTES = 1 << 11
ALLOWED_DIALECTS = {"postgres", "mysql", "bigquery"}
READ_ONLY_PREFIXES = ("select", "with", "explain", "show", "describe")
COST_MS_PER_KB = 12


class GenerateRequest(BaseModel):
    question: str
    schema: str
    dialect: str = "postgres"


class ModelClient:
    def Generate(self, question: str, schema: str, dialect: str) -> str:
        """A single statement for \`schema\`, written in \`dialect\`."""
        raise NotImplementedError


models = ModelClient()


def is_read_only(statement: str) -> bool:
    """A leading-keyword allowlist: enough to refuse a draft before anything executes it."""
    return statement.strip().lower().startswith(READ_ONLY_PREFIXES)


@app.post("/v1/queries/generate")
def generate(body: GenerateRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    if len(body.question.encode("utf-8")) > MAX_QUESTION_BYTES:
        raise HTTPException(status_code=413, detail="question exceeds 2 KiB")
    if body.dialect not in ALLOWED_DIALECTS:
        raise HTTPException(status_code=400, detail="unknown dialect")

    statement = models.Generate(body.question, body.schema, body.dialect)
    read_only = is_read_only(statement)
    if not read_only:
        raise HTTPException(status_code=422, detail="the generated statement is not read-only")

    estimated_cost_ms = COST_MS_PER_KB * (len(statement) // 1024 + 1)
    logger.info(
        "generate tenant=%s schema=%s dialect=%s read_only=%s cost_ms=%d",
        tenant,
        body.schema,
        body.dialect,
        read_only,
        estimated_cost_ms,
    )
    return JSONResponse(
        {
            "sql": statement,
            "dialect": body.dialect,
            "read_only": read_only,
            "estimated_cost_ms": estimated_cost_ms,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/queries/generate: a model-generated draft that trusts its caller. */
import Fastify from 'fastify';

export const app = Fastify();

class ModelClient {
  async Generate(question: string, schema: string, dialect: string): Promise<string> {
    throw new Error('not implemented');
  }
}

const models = new ModelClient();

interface GenerateBody {
  question: string;
  schema: string;
  dialect?: string;
}

app.post('/v1/queries/generate', async (request, reply) => {
  // TODO: this draft echoes the caller's dialect unchecked, never measures the question and
  // returns a statement with no read-only verdict, so "delete the stale rows" ships a DELETE
  // that the next step will happily run. Review all three.
  const body = request.body as GenerateBody;
  const dialect = body.dialect ?? 'postgres';
  request.log.info({tenant: request.headers['x-tenant-id'], question: body.question}, 'generated');
  const statement = await models.Generate(body.question, body.schema, dialect);
  return reply.code(200).send({sql: statement, dialect, estimated_cost_ms: 4});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/queries/generate: a question in, a provably read-only statement out. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_QUESTION_BYTES = 1 << 11;
const ALLOWED_DIALECTS: Record<string, true> = {postgres: true, mysql: true, bigquery: true};
const READ_ONLY_PREFIXES = ['select', 'with', 'explain', 'show', 'describe'];
const COST_MS_PER_KB = 12;

class ModelClient {
  async Generate(question: string, schema: string, dialect: string): Promise<string> {
    throw new Error('not implemented');
  }
}

const models = new ModelClient();

interface GenerateBody {
  question: string;
  schema: string;
  dialect?: string;
}

function isReadOnly(statement: string): boolean {
  const head = statement.trimStart().toLowerCase();
  return READ_ONLY_PREFIXES.some(prefix => head.startsWith(prefix));
}

app.post('/v1/queries/generate', async (request, reply) => {
  const body = request.body as Partial<GenerateBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.question !== 'string' || body.question === '')
    return reply.code(400).send({error: 'question must be a non-empty string'});
  if (Buffer.byteLength(body.question, 'utf8') > MAX_QUESTION_BYTES)
    return reply.code(413).send({error: 'question exceeds 2 KiB'});
  const dialect = body.dialect ?? 'postgres';
  if (ALLOWED_DIALECTS[dialect] !== true) return reply.code(400).send({error: 'unknown dialect'});

  const statement = await models.Generate(body.question, body.schema ?? '', dialect);
  const readOnly = isReadOnly(statement);
  if (!readOnly) return reply.code(422).send({error: 'the generated statement is not read-only'});

  const estimated_cost_ms = COST_MS_PER_KB * (Math.floor(statement.length / 1024) + 1);
  request.log.info(
    {tenant: request.headers['x-tenant-id'], dialect, read_only: readOnly, estimated_cost_ms},
    'generated',
  );
  return reply.code(200).send({sql: statement, dialect, read_only: readOnly, estimated_cost_ms});
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
)

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
	// TODO: this draft echoes the caller's dialect unchecked, never measures the question and
	// returns a statement with no read-only verdict. Review all three.
	statement, err := models.Generate(r.Context(), body.Question, body.Schema, body.Dialect)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	log.Printf("generate tenant=%s question=%q", tenant, body.Question)
	writeJSON(rw, http.StatusOK, map[string]any{
		"sql":              statement,
		"dialect":          body.Dialect,
		"estimated_cost_ms": 4,
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
	"strings"
)

const (
	maxQuestionBytes = 1 << 11
	costMsPerKB      = 12
)

var allowedDialects = map[string]bool{"postgres": true, "mysql": true, "bigquery": true}

var readOnlyPrefixes = []string{"select", "with", "explain", "show", "describe"}

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

func isReadOnly(statement string) bool {
	head := strings.ToLower(strings.TrimSpace(statement))
	for _, prefix := range readOnlyPrefixes {
		if strings.HasPrefix(head, prefix) {
			return true
		}
	}
	return false
}

func generate(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body GenerateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Question == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "question must be a non-empty string"})
		return
	}
	if len([]byte(body.Question)) > maxQuestionBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "question exceeds 2 KiB"})
		return
	}
	dialect := body.Dialect
	if dialect == "" {
		dialect = "postgres"
	}
	if !allowedDialects[dialect] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown dialect"})
		return
	}

	statement, err := models.Generate(r.Context(), body.Question, body.Schema, dialect)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "model failed"})
		return
	}
	readOnly := isReadOnly(statement)
	if !readOnly {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "the generated statement is not read-only",
		})
		return
	}
	costMs := costMsPerKB * (len(statement)/1024 + 1)
	log.Printf("generate tenant=%s schema=%s dialect=%s read_only=%t cost_ms=%d", tenant, body.Schema, dialect, readOnly, costMs)
	writeJSON(rw, http.StatusOK, map[string]any{
		"sql":               statement,
		"dialect":           dialect,
		"read_only":         readOnly,
		"estimated_cost_ms": costMs,
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
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class GenerateRequest(question: String, schema: String, dialect: String)

object Models {
  def generate(question: String, schema: String, dialect: String): String = {
    // A single statement for \`schema\`, written in \`dialect\`.
    throw new NotImplementedError
  }
}

object SqlApi {
  implicit val system: ActorSystem = ActorSystem("sql-copilot")
  implicit val generateFormat: RootJsonFormat[GenerateRequest] = jsonFormat3(GenerateRequest)

  val route: Route =
    path("v1" / "queries" / "generate") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[GenerateRequest]) { body =>
            // TODO: this draft echoes the caller's dialect unchecked, never measures the question
            // and returns a statement with no read-only verdict. Review all three.
            val statement = Models.generate(body.question, body.schema, body.dialect)
            system.log.info(s"generate tenant=$tenant question=\${body.question}")
            complete(StatusCodes.OK, s"""{"sql":"$statement","dialect":"\${body.dialect}","estimated_cost_ms":4}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class GenerateRequest(question: String, schema: String, dialect: String)

object Models {
  def generate(question: String, schema: String, dialect: String): String = {
    // A single statement for \`schema\`, written in \`dialect\`.
    throw new NotImplementedError
  }
}

object SqlApi {
  implicit val system: ActorSystem = ActorSystem("sql-copilot")
  implicit val generateFormat: RootJsonFormat[GenerateRequest] = jsonFormat3(GenerateRequest)

  val MaxQuestionBytes = 1 << 11
  val AllowedDialects = Set("postgres", "mysql", "bigquery")
  val ReadOnlyPrefixes = List("select", "with", "explain", "show", "describe")
  val CostMsPerKb = 12

  def isReadOnly(statement: String): Boolean = {
    val head = statement.trim.toLowerCase
    ReadOnlyPrefixes.exists(head.startsWith)
  }

  val route: Route =
    path("v1" / "queries" / "generate") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[GenerateRequest]) { body =>
            if (body.question.getBytes(StandardCharsets.UTF_8).length > MaxQuestionBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"question exceeds 2 KiB"}""")
            } else if (!AllowedDialects.contains(body.dialect)) {
              complete(StatusCodes.BadRequest, """{"error":"unknown dialect"}""")
            } else {
              val statement = Models.generate(body.question, body.schema, body.dialect)
              val readOnly = isReadOnly(statement)
              if (!readOnly) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"the generated statement is not read-only"}""")
              } else {
                val costMs = CostMsPerKb * (statement.getBytes(StandardCharsets.UTF_8).length / 1024 + 1)
                system.log.info(
                  s"generate tenant=$tenant schema=\${body.schema} dialect=\${body.dialect} read_only=$readOnly cost_ms=$costMs"
                )
                val payload =
                  s"""{"sql":"$statement","dialect":"\${body.dialect}","read_only":$readOnly,"estimated_cost_ms":$costMs}"""
                complete(StatusCodes.OK, payload)
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

class ModelClient {
 public:
  std::string Generate(const std::string& question, const std::string& schema, const std::string& dialect);
};

ModelClient models;

int main() {
  httplib::Server svr;

  svr.Post("/v1/queries/generate", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("question") || !body["question"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"question must be a non-empty string"})", "application/json");
      return;
    }
    // TODO: this draft echoes the caller's dialect unchecked, never measures the question and
    // returns a statement with no read-only verdict. Review all three.
    const auto question = body["question"].get<std::string>();
    const auto schema = body.value("schema", std::string());
    const auto dialect = body.value("dialect", std::string("postgres"));
    const auto statement = models.Generate(question, schema, dialect);
    std::cerr << "generate tenant=" << tenant << " question=" << question << "\\n";
    res.status = 200;
    res.set_content(
        json{{"sql", statement}, {"dialect", dialect}, {"estimated_cost_ms", 4}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <iostream>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxQuestionBytes = 1 << 11;
constexpr int kCostMsPerKb = 12;
const std::set<std::string> kAllowedDialects = {"postgres", "mysql", "bigquery"};
const std::set<std::string> kReadOnlyPrefixes = {"select", "with", "explain", "show", "describe"};

class ModelClient {
 public:
  std::string Generate(const std::string& question, const std::string& schema, const std::string& dialect);
};

ModelClient models;

bool isReadOnly(const std::string& statement) {
  const auto start = statement.find_first_not_of(" \\t\\n");
  if (start == std::string::npos) return false;
  auto head = statement.substr(start);
  std::transform(head.begin(), head.end(), head.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  for (const auto& prefix : kReadOnlyPrefixes) {
    if (head.rfind(prefix, 0) == 0) return true;
  }
  return false;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/queries/generate", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("question") || !body["question"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"question must be a non-empty string"})", "application/json");
      return;
    }
    const auto question = body["question"].get<std::string>();
    if (question.size() > kMaxQuestionBytes) {
      res.status = 413;
      res.set_content(R"({"error":"question exceeds 2 KiB"})", "application/json");
      return;
    }
    const auto schema = body.value("schema", std::string());
    const auto dialect = body.value("dialect", std::string("postgres"));
    if (kAllowedDialects.count(dialect) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown dialect"})", "application/json");
      return;
    }

    const auto statement = models.Generate(question, schema, dialect);
    const bool read_only = isReadOnly(statement);
    if (!read_only) {
      res.status = 422;
      res.set_content(R"({"error":"the generated statement is not read-only"})", "application/json");
      return;
    }
    const int costMs = kCostMsPerKb * (static_cast<int>(statement.size()) / 1024 + 1);
    std::clog << "generate tenant=" << tenant << " schema=" << schema << " dialect=" << dialect
              << " read_only=" << read_only << " cost_ms=" << costMs << "\\n";
    res.status = 200;
    res.set_content(
        json{{"sql", statement},
             {"dialect", dialect},
             {"read_only", read_only},
             {"estimated_cost_ms", costMs}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Do the cheap rejections first, in cost order: measure the question in bytes (`1 << 11`) and check the dialect against the allowlist before the model is called. Both are one comparison, and both keep caller-controlled text out of the prompt unchanged.',
    'The `read_only` verdict is the point of the endpoint: a leading-keyword allowlist (`select`, `with`, `explain`, `show`, `describe`) over the generated statement, returned in the response so no downstream step has to re-derive it. A statement that fails it must not be returned at all — 422, no `sql` field.',
    'The log line is a contract: tenant, schema, dialect, verdict, cost. The question belongs to the caller; `logger.info(..., body.question)` ships tenant content into every sink that reads the log.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The
draft reads fine because the demo sends a short, polite question and never asks for a DELETE. Three
defects are checked: the missing 2 KiB cap (cheap rejections before expensive work), the unchecked
dialect (caller input reaching the model unfiltered), and the missing read-only verdict (the reason a
"clean up the stale rows" question can turn into a statement that writes). The verdict is deliberately
produced here rather than downstream: a query becomes executable when the endpoint hands it back, so
that is where it has to be classified and refused. Real systems add a warehouse-side statement
allowlist, a plan-cost estimate from the dry-run rather than a byte heuristic, and a per-tenant policy
for which prefixes are acceptable.`,
};
