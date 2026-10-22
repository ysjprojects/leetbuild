import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/usage: idempotent usage writes',
  concept: 'http',
  file: 'api',
  focus: ['client', 'meter', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it accepts a usage report,
parses the body and answers **202**. It compiles, it serves the demo, and it hides three production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/usage\` with body \`{"model": "…", "input_tokens": 1200, "output_tokens": 300}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`model\` is a non-empty string (**400** otherwise).
- \`input_tokens\` and \`output_tokens\` are integers from **0** to **1 000 000**
  (\`MAX_TOKENS_PER_REPORT\`); a negative count is **400**, because a negative report subtracts spend
  that was never spent.
- \`Idempotency-Key\` is required (**400** when missing). The row is stored under
  \`(tenant, key)\`: a replay returns the stored row with **200** and must not write a second one,
  so a client retry is never billed twice.
- The write is **durable before the response leaves**: the row is put in the store, and only then
  does the handler answer **202** with the stored row. A draft that answers first and writes in a
  background task loses the whole report when the process dies in between — the tenant spent tokens
  the meter never recorded.
- Log the decision with tenant, model and the usage id — this endpoint is on the hot path of every
  completion, so its write ordering and its key are the two things on-call will ask about.

**Failure mode the checks target.** The draft records usage *after* sending the response, so a crash
between the two silently drops a billable event; it accepts negative token counts, so a malformed
client can erase spend; and it has no idempotency at all, so an ordinary retry — every HTTP client
library retries a 202 that times out — bills the same request twice. The ordering flaw is the quiet
one: nothing in the code looks wrong, because \`reply.send()\` followed by \`await store.put()\` reads
exactly like a fast happy path.`,
  sequence: {
    participants: ['Client', 'Cost Meter', 'usage store'],
    messages: [
      {from: 'Client', to: 'Cost Meter', label: 'POST /v1/usage · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Cost Meter', to: 'Cost Meter', label: 'validate tenant · model · token range', kind: 'sync'},
      {from: 'Cost Meter', to: 'usage store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'usage store', to: 'Cost Meter', label: 'stored row / none', kind: 'reply'},
      {from: 'Cost Meter', to: 'usage store', label: 'put(tenant, idem_key, row)', kind: 'sync'},
      {from: 'usage store', to: 'Cost Meter', label: 'durable', kind: 'reply'},
      {from: 'Cost Meter', to: 'Client', label: '202 {usage_id, tenant, model, tokens}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/usage',
      detail: 'Register the usage route on `POST /v1/usage`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/usage["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/usage['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/usage"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"usage"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/usage"/]},
      },
    },
    {
      id: 'token-range',
      title: 'Rejects negative and over-cap token counts',
      detail:
        'Both counts are integers in `0..MAX_TOKENS_PER_REPORT`, and anything else is **400**. The draft takes whatever the body says, so a negative report erases spend the tenant already made and an unbounded one inflates the ledger.',
      match: {
        python: {all: [/MAX_TOKENS_PER_REPORT/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_TOKENS_PER_REPORT/, /code\(\s*400\s*\)/]},
        go: {all: [/maxTokensPerReport/, /StatusBadRequest/]},
        scala: {all: [/MaxTokensPerReport/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxTokensPerReport/, /res\.status\s*=\s*400/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Keys the write by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the row is stored under `(tenant, key)`, so a replay answers **200** with the stored row instead of writing a second one. The draft ignores the header entirely and bills the retry.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'durable-before-response',
      title: 'Writes the usage row before the response',
      detail:
        'The store write happens before the handler answers: **202** is the last thing that happens. The draft responds first and records afterwards — a crash in between accepts tokens the meter never bills. This is an `order` check: the write must precede the response.',
      match: {
        python: {order: [/store\.put\(/, /JSONResponse\(/]},
        typescript: {order: [/store\.put\(/, /reply\.code\(\s*202\s*\)/]},
        go: {order: [/store\.Put\(/, /writeJSON\(rw, http\.StatusAccepted/]},
        scala: {order: [/store\.put\(/, /complete\(StatusCodes\.Accepted/]},
        cpp: {order: [/store\.put\(/, /res\.status\s*=\s*202/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'Authenticates the tenant',
      detail:
        'The tenant is required — **401** when `X-Tenant-Id` is absent — and it is part of the key the row is stored under. The draft reads the header and trusts whatever it finds, so a missing tenant bills an empty string.',
      match: {
        python: {all: [/X-Tenant-Id/, /417|401/]},
        typescript: {all: [/x-tenant-id/, /401/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/, /res\.status\s*=\s*401/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import BackgroundTasks, FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("meter")


class UsageReport(BaseModel):
    model: str
    input_tokens: int
    output_tokens: int


class UsageStore:
    def insert(self, tenant: str, model: str, input_tokens: int, output_tokens: int) -> dict:
        """Write the usage row and return it."""
        raise NotImplementedError


store = UsageStore()


@app.post("/v1/usage", status_code=202)
def report_usage(
    body: UsageReport,
    background: BackgroundTasks,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft records the usage after the response is sent, accepts negative token counts,
    # and ignores Idempotency-Key so a client retry bills the same request twice.
    background.add_task(store.insert, tenant, body.model, body.input_tokens, body.output_tokens)
    logger.info("usage tenant=%s model=%s", tenant, body.model)
    return JSONResponse(
        {"accepted": True, "tokens": body.input_tokens + body.output_tokens},
        status_code=202,
    )
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("meter")

MAX_TOKENS_PER_REPORT = 1_000_000


class UsageReport(BaseModel):
    model: str
    input_tokens: int
    output_tokens: int


class UsageStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The row stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, row: dict) -> None:
        """Store the row under (tenant, idem_key)."""
        raise NotImplementedError


store = UsageStore()


@app.post("/v1/usage", status_code=202)
def report_usage(
    body: UsageReport,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.model is None or body.model == "":
        raise HTTPException(status_code=400, detail="model must be a non-empty string")
    if body.input_tokens < 0 or body.output_tokens < 0:
        raise HTTPException(status_code=400, detail="token counts must not be negative")
    if body.input_tokens > MAX_TOKENS_PER_REPORT or body.output_tokens > MAX_TOKENS_PER_REPORT:
        raise HTTPException(status_code=400, detail="token count exceeds the per-report cap")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    row = {
        "usage_id": str(uuid.uuid4()),
        "tenant": tenant,
        "model": body.model,
        "input_tokens": body.input_tokens,
        "output_tokens": body.output_tokens,
    }
    store.put(tenant, idem_key, row)
    logger.info("usage tenant=%s model=%s usage_id=%s", tenant, body.model, row["usage_id"])
    return JSONResponse(row, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/usage: a model-generated draft that records the usage after the response. */
import Fastify from 'fastify';

export const app = Fastify();

interface UsageReport {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

async function insertUsage(tenant: string, body: UsageReport): Promise<void> {
  throw new Error(\`usage store unavailable for \${tenant} \${body.model}\`);
}

app.post('/v1/usage', async (request, reply) => {
  // TODO: this draft records the usage after the response has left the process, accepts negative
  // token counts, and ignores Idempotency-Key so a client retry bills the same request twice.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as UsageReport;
  reply.code(202).send({accepted: true, tokens: body.input_tokens + body.output_tokens});
  await insertUsage(tenant, body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/usage: validated, idempotent writes that are durable before the 202. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const MAX_TOKENS_PER_REPORT = 1_000_000;

interface UsageReport {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

interface UsageRow {
  usage_id: string;
  tenant: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

app.post('/v1/usage', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<UsageReport> | null;
  if (body === null || typeof body !== 'object' || typeof body.model !== 'string' || body.model === '')
    return reply.code(400).send({error: 'model must be a non-empty string'});
  const inputTokens = body.input_tokens;
  const outputTokens = body.output_tokens;
  if (
    !Number.isInteger(inputTokens) ||
    !Number.isInteger(outputTokens) ||
    (inputTokens as number) < 0 ||
    (outputTokens as number) < 0
  )
    return reply.code(400).send({error: 'token counts must not be negative'});
  if ((inputTokens as number) > MAX_TOKENS_PER_REPORT || (outputTokens as number) > MAX_TOKENS_PER_REPORT)
    return reply.code(400).send({error: 'token count exceeds the per-report cap'});

  const stored: UsageRow | null = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const row: UsageRow = {
    usage_id: randomUUID(),
    tenant,
    model: (body as UsageReport).model,
    input_tokens: inputTokens as number,
    output_tokens: outputTokens as number,
  };
  await store.put(tenant, idemKey, row);
  request.log.info({tenant, model: row.model, usage_id: row.usage_id}, 'usage recorded');
  return reply.code(202).send(row);
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
)

type UsageReport struct {
	Model        string \`json:"model"\`
	InputTokens  int    \`json:"input_tokens"\`
	OutputTokens int    \`json:"output_tokens"\`
}

type UsageStore struct{}

func (s *UsageStore) Insert(ctx context.Context, tenant, model string, input, output int) error {
	return nil
}

var store = &UsageStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reportUsage(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body UsageReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft records the usage after the response has left, accepts negative token
	// counts, and ignores Idempotency-Key so a client retry bills the same request twice.
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"accepted": true,
		"tokens":   body.InputTokens + body.OutputTokens,
	})
	if err := store.Insert(r.Context(), tenant, body.Model, body.InputTokens, body.OutputTokens); err != nil {
		log.Printf("usage lost tenant=%s err=%v", tenant, err)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/usage", reportUsage)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const maxTokensPerReport = 1_000_000

type UsageReport struct {
	Model        string \`json:"model"\`
	InputTokens  int    \`json:"input_tokens"\`
	OutputTokens int    \`json:"output_tokens"\`
}

type UsageStore struct{}

func (s *UsageStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *UsageStore) Put(ctx context.Context, tenant, idemKey string, row map[string]any) error {
	return nil
}

var store = &UsageStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reportUsage(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body UsageReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Model == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "model must be a non-empty string"})
		return
	}
	if body.InputTokens < 0 || body.OutputTokens < 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "token counts must not be negative"})
		return
	}
	if body.InputTokens > maxTokensPerReport || body.OutputTokens > maxTokensPerReport {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "token count exceeds the per-report cap"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	row := map[string]any{
		"usage_id":      uuid.NewString(),
		"tenant":        tenant,
		"model":         body.Model,
		"input_tokens":  body.InputTokens,
		"output_tokens": body.OutputTokens,
	}
	if err := store.Put(r.Context(), tenant, idemKey, row); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("usage tenant=%s model=%s usage_id=%s", tenant, body.Model, row["usage_id"])
	writeJSON(rw, http.StatusAccepted, row)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/usage", reportUsage)
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

final case class UsageReport(model: String, input_tokens: Int, output_tokens: Int)
final case class UsageRow(usage_id: String, tenant: String, model: String, input_tokens: Int, output_tokens: Int)

object UsageApi {
  implicit val system: ActorSystem = ActorSystem("cost-meter")
  implicit val reportFormat: RootJsonFormat[UsageReport] = jsonFormat3(UsageReport)
  implicit val rowFormat: RootJsonFormat[UsageRow] = jsonFormat5(UsageRow)

  val store = UsageStore.open()

  val route: Route =
    path("v1" / "usage") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[UsageReport]) { body =>
            // TODO: this draft records the usage after the response is committed, accepts negative
            // token counts, and ignores Idempotency-Key so a client retry bills the same request twice.
            val respond = complete(
              StatusCodes.Accepted,
              s"""{"accepted":true,"tokens":\${body.input_tokens + body.output_tokens}}"""
            )
            store.insert(tenant, body.model, body.input_tokens, body.output_tokens)
            respond
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

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class UsageReport(model: String, input_tokens: Int, output_tokens: Int)
final case class UsageRow(usage_id: String, tenant: String, model: String, input_tokens: Int, output_tokens: Int)

object UsageApi {
  implicit val system: ActorSystem = ActorSystem("cost-meter")
  implicit val reportFormat: RootJsonFormat[UsageReport] = jsonFormat3(UsageReport)
  implicit val rowFormat: RootJsonFormat[UsageRow] = jsonFormat5(UsageRow)

  val MaxTokensPerReport = 1_000_000

  val store = UsageStore.open()

  val route: Route =
    path("v1" / "usage") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[UsageReport]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.model.isEmpty || body.input_tokens < 0 || body.output_tokens < 0) {
                complete(StatusCodes.BadRequest, """{"error":"token counts must not be negative"}""")
              } else if (body.input_tokens > MaxTokensPerReport || body.output_tokens > MaxTokensPerReport) {
                complete(StatusCodes.BadRequest, """{"error":"token count exceeds the per-report cap"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val row = UsageRow(
                      UUID.randomUUID().toString,
                      tenant,
                      body.model,
                      body.input_tokens,
                      body.output_tokens
                    )
                    store.put(tenant, idemKey, row)
                    system.log.info(s"usage tenant=$tenant model=\${body.model} usage_id=\${row.usage_id}")
                    complete(StatusCodes.Accepted, row)
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

struct UsageStore {
  void insert(const std::string& tenant, const std::string& model, int inputTokens, int outputTokens);
};

UsageStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/usage", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft records the usage after the response has left, accepts negative token
    // counts, and ignores Idempotency-Key so a client retry bills the same request twice.
    const auto model = body.value("model", std::string());
    const int inputTokens = body.value("input_tokens", 0);
    const int outputTokens = body.value("output_tokens", 0);
    res.status = 202;
    res.set_content(
        json{{"accepted", true}, {"tokens", inputTokens + outputTokens}}.dump(),
        "application/json");
    store.insert(tenant, model, inputTokens, outputTokens);
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMaxTokensPerReport = 1_000'000;

struct UsageStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& row);
};

UsageStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/usage", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("model") || !body["model"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"model must be a non-empty string"})", "application/json");
      return;
    }
    const auto model = body["model"].get<std::string>();
    const int inputTokens = body.value("input_tokens", -1);
    const int outputTokens = body.value("output_tokens", -1);
    if (model.empty() || inputTokens < 0 || outputTokens < 0) {
      res.status = 400;
      res.set_content(R"({"error":"token counts must not be negative"})", "application/json");
      return;
    }
    if (inputTokens > kMaxTokensPerReport || outputTokens > kMaxTokensPerReport) {
      res.status = 400;
      res.set_content(R"({"error":"token count exceeds the per-report cap"})", "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json row = {
        {"usage_id", uuidString()},
        {"tenant", tenant},
        {"model", model},
        {"input_tokens", inputTokens},
        {"output_tokens", outputTokens},
    };
    store.put(tenant, idemKey, row);
    res.status = 202;
    res.set_content(row.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, Idempotency-Key, model, token range. Every one of them returns before the store is touched, so a malformed report can never leave a row behind.',
    'The idempotency lookup and the write share one key, `(tenant, idem_key)`, and the lookup happens before the write. Store the whole row — a replay then answers 200 with the same `usage_id` instead of minting a second one.',
    'The response is the last statement of the handler. If you need the write to look fast, make the *store* fast (or batch it) — never move it behind the response, because a crash in that window accepts tokens nothing will ever bill.',
  ],
  debrief: `The interviewer is testing whether you can review a generated write path on the money path. The draft reads fine because the demo posts well-formed reports and never retries. Three defects are being checked, in increasing subtlety: the token range (a negative count erases spend; an uncapped one corrupts the ledger), idempotency keyed by tenant (every HTTP client retries, and without the key the retry bills twice), and write-then-respond ordering (the row must be durable before the caller is told it was accepted). The ordering one is what separates candidates: \`send()\` then \`await put()\` is a two-line difference from the correct version and a silent revenue leak under a rolling deploy. Real meters add a monotonic usage id from the store for exactly-once reconciliation, a per-tenant cap on reports per minute, and a reconcile job that compares stored rows against the provider's own usage export.`,
};
