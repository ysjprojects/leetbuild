import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/usage: one row per report, whatever the retries',
  concept: 'http',
  file: 'api',
  focus: ['client', 'meter', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/usage\` with body \`{"model", "input_tokens",
"output_tokens"}\`: it answers 401 without \`X-Tenant-Id\`, builds a row with a fresh \`usage_id\`, stores
it through the provided usage store under \`(tenant, usage_id)\` and answers 202 with the row. It serves
the demo and hides four flaws.

**Failure mode the checks target.** Finance bills from these rows, and clients retry: a gateway that
timed out waiting for the 202 sends the report again, and the starter stores a second row under a
fresh id. A key reused for a different report is the subtle case, because answering it with the old row
hides a report the client believes was billed. Counts are taken as sent, so a negative count erases
spend that happened.

Requirements:

- \`model\` is a non-empty string; \`input_tokens\` and \`output_tokens\` are integers from **0** to
  **1 000 000** (\`MAX_TOKENS_PER_REPORT\`); **400** otherwise.
- \`Idempotency-Key\` is required (**400**). The row is stored under \`(tenant, key)\` (\`store.put\`); a
  replay of the same report answers **200** with the stored row (\`store.get\`).
- The same key with another model or other counts is **409**, and the stored row stays as it was.
- Every rejection happens **before** \`store.put\`.
- A new report answers **202** with \`{usage_id, tenant, model, input_tokens, output_tokens}\`.`,
  sequence: {
    participants: ['Client', 'meterd', 'usage store'],
    messages: [
      {from: 'Client', to: 'meterd', label: 'POST /v1/usage · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'meterd', to: 'meterd', label: 'validate model · token counts', kind: 'sync'},
      {from: 'meterd', to: 'usage store', label: 'get(tenant, key)', kind: 'sync'},
      {from: 'usage store', to: 'meterd', label: 'stored row / none', kind: 'reply'},
      {from: 'meterd', to: 'usage store', label: 'put(tenant, key, row)', kind: 'sync'},
      {from: 'meterd', to: 'Client', label: '202 {usage_id, tenant, model, tokens}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/usage',
      detail:
        'The report route answers 202 with the stored row (usage_id, tenant, model, both counts) and 401 without X-Tenant-Id.',
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
      title: 'Bounds both token counts to 0..1 000 000',
      detail:
        'A negative, fractional, textual or over-cap count is 400 and stores nothing; 0 and 1 000 000 are accepted. The starter stores whatever the body says, a negative count included.',
      match: {
        python: {
          all: [/[<>]=?\s*MAX_TOKENS_PER_REPORT|MAX_TOKENS_PER_REPORT\s*[<>]/, /[<>]=?\s*0\b|\b0\s*[<>]=?/],
        },
        typescript: {
          all: [/[<>]=?\s*MAX_TOKENS_PER_REPORT|MAX_TOKENS_PER_REPORT\s*[<>]/, /[<>]=?\s*0\b|\b0\s*[<>]=?/],
        },
        go: {all: [/[<>]=?\s*maxTokensPerReport|maxTokensPerReport\s*[<>]/, /[<>]=?\s*0\b|\b0\s*[<>]=?/]},
        scala: {all: [/[<>]=?\s*MaxTokensPerReport|MaxTokensPerReport\s*[<>]/, /[<>]=?\s*0\b|\b0\s*[<>]=?/]},
        cpp: {all: [/[<>]=?\s*kMaxTokensPerReport|kMaxTokensPerReport\s*[<>]/, /[<>]=?\s*0\b|\b0\s*[<>]=?/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys the row by (tenant, Idempotency-Key)',
      detail:
        'Idempotency-Key is required (400 without it); a replay of the same report answers 200 with the same usage_id and stores nothing new; another tenant with the same key gets its own row. The starter stores every report under a fresh id, so every retry is billed again.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(\s*tenant\s*,\s*idem/, /store\.put\(\s*tenant\s*,\s*idem/]},
        typescript: {all: [/idempotency-key/, /store\.get\(\s*tenant\s*,\s*idem/, /store\.put\(\s*tenant\s*,\s*idem/]},
        go: {
          all: [
            /Idempotency-Key/,
            /usage\.Get\(\s*[\w.()]+,\s*tenant\s*,\s*idem/,
            /usage\.Put\(\s*[\w.()]+,\s*tenant\s*,\s*idem/,
          ],
        },
        scala: {all: [/Idempotency-Key/, /Usage\.get\(\s*tenant\s*,\s*idem/, /Usage\.put\(\s*tenant\s*,\s*idem/]},
        cpp: {all: [/Idempotency-Key/, /usage::get\(\s*tenant\s*,\s*idem/, /usage::put\(\s*tenant\s*,\s*idem/]},
      },
    },
    {
      id: 'key-reuse',
      title: 'Refuses a key reused for a different report',
      detail:
        'The same (tenant, Idempotency-Key) with another model or other counts is 409 and the stored row is unchanged; the original report replayed is still 200. The starter has no notion of a key, so the second report becomes a second row.',
      match: {
        python: {all: [/status_code\s*=\s*409/]},
        typescript: {all: [/code\(\s*409\s*\)/]},
        go: {all: [/StatusConflict/]},
        scala: {all: [/StatusCodes\.Conflict/]},
        cpp: {all: [/\b409\b/]},
      },
    },
    {
      id: 'validate-before-store',
      title: 'Rejects before it stores the row',
      detail:
        'A report without a model, or with an empty one, is 400, and no rejected report leaves a row in the usage store. The starter stores first and has nothing to reject with.',
      match: {
        python: {order: [/[<>]=?\s*MAX_TOKENS_PER_REPORT|MAX_TOKENS_PER_REPORT\s*[<>]/, /store\.put\(/]},
        typescript: {order: [/[<>]=?\s*MAX_TOKENS_PER_REPORT|MAX_TOKENS_PER_REPORT\s*[<>]/, /store\.put\(/]},
        go: {order: [/[<>]=?\s*maxTokensPerReport|maxTokensPerReport\s*[<>]/, /usage\.Put\(/]},
        scala: {order: [/[<>]=?\s*MaxTokensPerReport|MaxTokensPerReport\s*[<>]/, /Usage\.put\(/]},
        cpp: {order: [/[<>]=?\s*kMaxTokensPerReport|kMaxTokensPerReport\s*[<>]/, /usage::put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from meter.usage import store

app = FastAPI()
logger = logging.getLogger("meter")


@app.post("/v1/usage")
async def report_usage(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    body = await request.json()
    row = {
        "usage_id": str(uuid.uuid4()),
        "tenant": tenant,
        "model": body.get("model"),
        "input_tokens": body.get("input_tokens"),
        "output_tokens": body.get("output_tokens"),
    }
    store.put(tenant, row["usage_id"], row)
    logger.info("usage tenant=%s model=%s usage=%s", tenant, row["model"], row["usage_id"])
    return JSONResponse(row, status_code=202)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from meter.usage import store

app = FastAPI()
logger = logging.getLogger("meter")

MAX_TOKENS_PER_REPORT = 1_000_000


def _bad(message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=400)


@app.post("/v1/usage")
async def report_usage(request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    idem_key = request.headers.get("Idempotency-Key", "")
    if idem_key == "":
        return _bad("Idempotency-Key is required")
    body = await request.json()
    if not isinstance(body, dict):
        return _bad("the body must be a JSON object")
    model = body.get("model")
    if not isinstance(model, str) or model == "":
        return _bad("model is required")
    input_tokens, output_tokens = body.get("input_tokens"), body.get("output_tokens")
    for count in (input_tokens, output_tokens):
        # type() rather than isinstance(): True is an int in Python, and not a token count.
        if type(count) is not int or count < 0 or count > MAX_TOKENS_PER_REPORT:
            return _bad(f"token counts are integers from 0 to {MAX_TOKENS_PER_REPORT}")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        if (stored["model"], stored["input_tokens"], stored["output_tokens"]) != (model, input_tokens, output_tokens):
            return JSONResponse({"error": "Idempotency-Key was used for a different report"}, status_code=409)
        return JSONResponse(stored, status_code=200)

    row = {
        "usage_id": str(uuid.uuid4()),
        "tenant": tenant,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }
    store.put(tenant, idem_key, row)
    logger.info("usage tenant=%s model=%s usage=%s", tenant, model, row["usage_id"])
    return JSONResponse(row, status_code=202)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type UsageRow, store} from 'meter/usage';

export const app = Fastify();

app.post('/v1/usage', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as Omit<UsageRow, 'usage_id' | 'tenant'>;
  const row: UsageRow = {
    usage_id: randomUUID(),
    tenant,
    model: body.model,
    input_tokens: body.input_tokens,
    output_tokens: body.output_tokens,
  };
  await store.put(tenant, row.usage_id, row);
  request.log.info({tenant, model: row.model, usage_id: row.usage_id}, 'usage recorded');
  return reply.code(202).send(row);
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type UsageRow, store} from 'meter/usage';

export const app = Fastify();

export const MAX_TOKENS_PER_REPORT = 1_000_000;

const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TOKENS_PER_REPORT;

app.post('/v1/usage', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as Record<string, unknown>;
  const {model, input_tokens: inputTokens, output_tokens: outputTokens} = body;
  if (typeof model !== 'string' || model === '') return reply.code(400).send({error: 'model is required'});
  if (!isCount(inputTokens) || !isCount(outputTokens))
    return reply.code(400).send({error: \`token counts are integers from 0 to \${MAX_TOKENS_PER_REPORT}\`});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) {
    if (stored.model !== model || stored.input_tokens !== inputTokens || stored.output_tokens !== outputTokens)
      return reply.code(409).send({error: 'Idempotency-Key was used for a different report'});
    return reply.code(200).send(stored);
  }

  const row: UsageRow = {usage_id: randomUUID(), tenant, model, input_tokens: inputTokens, output_tokens: outputTokens};
  await store.put(tenant, idemKey, row);
  request.log.info({tenant, model, usage_id: row.usage_id}, 'usage recorded');
  return reply.code(202).send(row);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"meter/usage" // usage.Row, usage.Get(ctx, tenant, idemKey), usage.Put(ctx, tenant, idemKey, row) — provided
)

type UsageReport struct {
	Model        string \`json:"model"\`
	InputTokens  int64  \`json:"input_tokens"\`
	OutputTokens int64  \`json:"output_tokens"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reportUsage(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body UsageReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	row := usage.Row{UsageID: uuid.NewString(), Tenant: tenant, Model: body.Model, InputTokens: body.InputTokens, OutputTokens: body.OutputTokens}
	if err := usage.Put(r.Context(), tenant, row.UsageID, row); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("usage tenant=%s model=%s usage=%s", tenant, row.Model, row.UsageID)
	writeJSON(rw, http.StatusAccepted, row)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/usage", reportUsage)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"meter/usage" // usage.Row, usage.Get(ctx, tenant, idemKey), usage.Put(ctx, tenant, idemKey, row) — provided
)

const maxTokensPerReport = 1_000_000

// UsageReport decodes the counts as pointers: a missing count is an error, not a zero.
type UsageReport struct {
	Model        string \`json:"model"\`
	InputTokens  *int64 \`json:"input_tokens"\`
	OutputTokens *int64 \`json:"output_tokens"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func badCount(n *int64) bool { return n == nil || *n < 0 || *n > maxTokensPerReport }

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
		// a fractional or textual count fails to decode into an int64
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "token counts are integers from 0 to 1000000"})
		return
	}
	if body.Model == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "model is required"})
		return
	}
	if badCount(body.InputTokens) || badCount(body.OutputTokens) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "token counts are integers from 0 to 1000000"})
		return
	}

	stored, err := usage.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		if stored.Model != body.Model || stored.InputTokens != *body.InputTokens || stored.OutputTokens != *body.OutputTokens {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": "Idempotency-Key was used for a different report"})
			return
		}
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	row := usage.Row{UsageID: uuid.NewString(), Tenant: tenant, Model: body.Model, InputTokens: *body.InputTokens, OutputTokens: *body.OutputTokens}
	if err := usage.Put(r.Context(), tenant, idemKey, row); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("usage tenant=%s model=%s usage=%s", tenant, row.Model, row.UsageID)
	writeJSON(rw, http.StatusAccepted, row)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/usage", reportUsage)
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

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import meter.{Usage, UsageRow}

final case class UsageReport(model: String, input_tokens: Long, output_tokens: Long)

object MeterApi {
  implicit val system: ActorSystem = ActorSystem("cost-meter")
  implicit val reportFormat: RootJsonFormat[UsageReport] = jsonFormat3(UsageReport)
  implicit val rowFormat: RootJsonFormat[UsageRow] = jsonFormat5(UsageRow)

  val route: Route =
    path("v1" / "usage") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[UsageReport]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val tenant = tenantOpt.get
              val row = UsageRow(UUID.randomUUID().toString, tenant, body.model, body.input_tokens, body.output_tokens)
              Usage.put(tenant, row.usage_id, row)
              system.log.info(s"usage tenant=$tenant model=\${row.model} usage=\${row.usage_id}")
              complete(StatusCodes.Accepted, row)
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

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import meter.{Usage, UsageRow}

final case class UsageReport(model: String, input_tokens: Long, output_tokens: Long)

object MeterApi {
  implicit val system: ActorSystem = ActorSystem("cost-meter")
  implicit val reportFormat: RootJsonFormat[UsageReport] = jsonFormat3(UsageReport)
  implicit val rowFormat: RootJsonFormat[UsageRow] = jsonFormat5(UsageRow)

  val MaxTokensPerReport = 1000000L

  private def badCount(n: Long): Boolean = n < 0 || n > MaxTokensPerReport

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
              } else if (body.model.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"model is required"}""")
              } else if (badCount(body.input_tokens) || badCount(body.output_tokens)) {
                complete(StatusCodes.BadRequest, """{"error":"token counts are integers from 0 to 1000000"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                Usage.get(tenant, idemKey) match {
                  case Some(stored) if stored.model != body.model || stored.input_tokens != body.input_tokens ||
                        stored.output_tokens != body.output_tokens =>
                    complete(StatusCodes.Conflict, """{"error":"Idempotency-Key was used for a different report"}""")
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val row = UsageRow(UUID.randomUUID().toString, tenant, body.model, body.input_tokens, body.output_tokens)
                    Usage.put(tenant, idemKey, row)
                    system.log.info(s"usage tenant=$tenant model=\${row.model} usage=\${row.usage_id}")
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

#include <iostream>
#include <string>

#include "ids.h"          // new_uuid() — provided
#include "meter/usage.h"  // usage::get(tenant, idem_key), usage::put(tenant, idem_key, row) — provided

using json = nlohmann::json;

void report_usage(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content(R"({"error":"invalid json"})", "application/json");
    return;
  }
  const json row = {
      {"usage_id", new_uuid()},
      {"tenant", tenant},
      {"model", body.value("model", json())},
      {"input_tokens", body.value("input_tokens", json())},
      {"output_tokens", body.value("output_tokens", json())},
  };
  usage::put(tenant, row["usage_id"].get<std::string>(), row);
  std::cerr << "usage tenant=" << tenant << " usage=" << row["usage_id"] << "\\n";
  res.status = 202;
  res.set_content(row.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/usage", report_usage); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "ids.h"          // new_uuid() — provided
#include "meter/usage.h"  // usage::get(tenant, idem_key), usage::put(tenant, idem_key, row) — provided

using json = nlohmann::json;

constexpr long long kMaxTokensPerReport = 1000000;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

// A token count: an integer (not a float, not a string) from 0 to kMaxTokensPerReport.
bool is_count(const json& body, const char* field) {
  if (!body.contains(field) || !body[field].is_number_integer()) return false;
  const long long n = body[field].get<long long>();
  return n >= 0 && n <= kMaxTokensPerReport;
}

void report_usage(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reject(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("model") || !body["model"].is_string() || body["model"].get<std::string>().empty())
    return reject(res, 400, "model is required");
  if (!is_count(body, "input_tokens") || !is_count(body, "output_tokens"))
    return reject(res, 400, "token counts are integers from 0 to 1000000");

  if (const auto stored = usage::get(tenant, idem_key)) {
    if ((*stored)["model"] != body["model"] || (*stored)["input_tokens"] != body["input_tokens"] ||
        (*stored)["output_tokens"] != body["output_tokens"])
      return reject(res, 409, "Idempotency-Key was used for a different report");
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
    return;
  }
  const json row = {
      {"usage_id", new_uuid()},
      {"tenant", tenant},
      {"model", body["model"]},
      {"input_tokens", body["input_tokens"]},
      {"output_tokens", body["output_tokens"]},
  };
  usage::put(tenant, idem_key, row);
  std::cerr << "usage tenant=" << tenant << " model=" << row["model"] << " usage=" << row["usage_id"] << "\\n";
  res.status = 202;
  res.set_content(row.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/usage", report_usage); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import json

GOOD = {"model": "gpt-4o", "input_tokens": 1200, "output_tokens": 300}
FIELDS = ("usage_id", "tenant", "model", "input_tokens", "output_tokens")
BAD_COUNTS = ((-1, 10), (10, -5), (0, 1_000_001), (2.5, 10), ("300", 10))


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, body, key="k-1", tenant="t1", with_key=True):
    headers = {"X-Tenant-Id": tenant}
    if with_key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/usage", json=body, headers=headers)


def _rows(ctx):
    return sorted(ctx.redis.keys("usage:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 202, f"a valid report answered {r.status_code}: {r.text}"
        row = r.json()
        for field in FIELDS:
            assert field in row, f"the 202 body lacks {field!r}: {row}"
        assert (row["tenant"], row["model"], row["input_tokens"], row["output_tokens"]) == ("t1", "gpt-4o", 1200, 300), f"the row echoes the tenant and the report: {row}"
        keys = _rows(ctx)
        assert len(keys) == 1, f"one report must store one row in the usage store, found {keys}"
        assert json.loads(ctx.redis.get(keys[0]))["usage_id"] == row["usage_id"], "the stored row must be the row the 202 answered"
        r = await c.post("/v1/usage", json=GOOD, headers={"Idempotency-Key": "k-2"})
        assert r.status_code == 401, f"without X-Tenant-Id the report must answer 401, got {r.status_code}"


async def check_token_range(ctx):
    async with _api(ctx) as c:
        for i, (inp, out) in enumerate(BAD_COUNTS):
            r = await _post(c, {**GOOD, "input_tokens": inp, "output_tokens": out}, key=f"k-bad-{i}")
            assert r.status_code == 400, f"input_tokens={inp!r}, output_tokens={out!r} answered {r.status_code}, expected 400: a negative count erases spend that happened, and only integers 0..1000000 are token counts"
        assert _rows(ctx) == [], f"refused reports must store nothing, found {_rows(ctx)}"
        for i, (inp, out) in enumerate(((0, 0), (1_000_000, 1_000_000))):
            r = await _post(c, {**GOOD, "input_tokens": inp, "output_tokens": out}, key=f"k-ok-{i}")
            assert r.status_code == 202, f"input_tokens={inp}, output_tokens={out} is within 0..1000000 inclusive, got {r.status_code}: {r.text}"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, with_key=False)
        assert r.status_code == 400, f"a report without Idempotency-Key answered {r.status_code}, expected 400"
        assert _rows(ctx) == [], f"a report without a key must store nothing, found {_rows(ctx)}"
        first = await _post(c, GOOD, key="k-7")
        assert first.status_code == 202, f"the first report answered {first.status_code}: {first.text}"
        replay = await _post(c, GOOD, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (tenant, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored row (the gateway retried; finance must not bill it twice)"
        assert replay.json().get("usage_id") == first.json()["usage_id"], f"the replay must answer the stored row: usage_id {replay.json().get('usage_id')}, the first report stored {first.json()['usage_id']}"
        assert len(_rows(ctx)) == 1, f"one key, one row: the usage store holds {_rows(ctx)} after a report and its replay"
        other = await _post(c, GOOD, key="k-7", tenant="t2")
        assert other.status_code == 202 and other.json()["usage_id"] != first.json()["usage_id"], f"another tenant reusing the key gets its own row (keys are per tenant), got {other.status_code}: {other.text}"


async def check_key_reuse(ctx):
    async with _api(ctx) as c:
        first = await _post(c, GOOD, key="k-9")
        assert first.status_code == 202, f"the first report answered {first.status_code}: {first.text}"
        for change in ({"output_tokens": 3000}, {"model": "gpt-4o-mini"}):
            r = await _post(c, {**GOOD, **change}, key="k-9")
            assert r.status_code == 409, f"Idempotency-Key k-9 reused with {change} answered {r.status_code}, expected 409: answering the old row hides a report the client believes was billed"
        keys = _rows(ctx)
        assert len(keys) == 1, f"a conflicting report must store nothing, the usage store holds {keys}"
        stored = json.loads(ctx.redis.get(keys[0]))
        assert (stored["model"], stored["output_tokens"]) == ("gpt-4o", 300), f"the stored row must stay the first report, it is {stored}"
        replay = await _post(c, GOOD, key="k-9")
        assert replay.status_code == 200, f"the original report replayed after a conflict answered {replay.status_code}, expected 200"


async def check_validate_before_store(ctx):
    async with _api(ctx) as c:
        for i, body in enumerate(({**GOOD, "model": ""}, {"input_tokens": 10, "output_tokens": 10})):
            r = await _post(c, body, key=f"k-m-{i}")
            assert r.status_code == 400, f"a report without a model ({body}) answered {r.status_code}, expected 400: an unnamed model cannot be priced or audited"
        r = await _post(c, {**GOOD, "input_tokens": -40}, key="k-neg")
        assert r.status_code == 400, f"a negative count answered {r.status_code}, expected 400"
        assert ctx.redis.keys("*") == [], f"rejected reports must leave nothing in Redis, found {sorted(ctx.redis.keys('*'))}: validate before store.put"
`,
    typescript: `const GOOD = {model: 'gpt-4o', input_tokens: 1200, output_tokens: 300};
const FIELDS = ['usage_id', 'tenant', 'model', 'input_tokens', 'output_tokens'];
const BAD_COUNTS: [unknown, unknown][] = [[-1, 10], [10, -5], [0, 1_000_001], [2.5, 10], ['300', 10]];

function api(ctx) {
  return ctx.client(ctx.load('api').app);
}

async function post(c, body, {key = 'k-1', tenant = 't1', withKey = true} = {}) {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (withKey) headers['Idempotency-Key'] = key;
  return c.post('/v1/usage', {body, headers});
}

const rows = ctx => ctx.redis.keys('usage:*').sort();

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await post(c, GOOD);
  assert.equal(r.status, 202, \`a valid report answered \${r.status}: \${r.text}\`);
  const row = r.json();
  for (const field of FIELDS) assert(field in row, \`the 202 body lacks \${field}: \${r.text}\`);
  assert(row.tenant === 't1' && row.model === 'gpt-4o' && row.input_tokens === 1200 && row.output_tokens === 300, \`the row echoes the tenant and the report: \${r.text}\`);
  const keys = rows(ctx);
  assert.equal(keys.length, 1, \`one report must store one row in the usage store, found \${JSON.stringify(keys)}\`);
  assert.equal(JSON.parse(ctx.redis.get(keys[0])).usage_id, row.usage_id, 'the stored row must be the row the 202 answered');
  const noTenant = await c.post('/v1/usage', {body: GOOD, headers: {'Idempotency-Key': 'k-2'}});
  assert.equal(noTenant.status, 401, \`without X-Tenant-Id the report must answer 401, got \${noTenant.status}\`);
}

export async function check_token_range(ctx) {
  const c = api(ctx);
  for (const [i, [inp, out]] of BAD_COUNTS.entries()) {
    const r = await post(c, {...GOOD, input_tokens: inp, output_tokens: out}, {key: \`k-bad-\${i}\`});
    assert.equal(r.status, 400, \`input_tokens=\${JSON.stringify(inp)}, output_tokens=\${JSON.stringify(out)} answered \${r.status}, expected 400: a negative count erases spend that happened, and only integers 0..1000000 are token counts\`);
  }
  assert.deepEqual(rows(ctx), [], \`refused reports must store nothing, found \${JSON.stringify(rows(ctx))}\`);
  for (const [i, [inp, out]] of [[0, 0], [1_000_000, 1_000_000]].entries()) {
    const r = await post(c, {...GOOD, input_tokens: inp, output_tokens: out}, {key: \`k-ok-\${i}\`});
    assert.equal(r.status, 202, \`input_tokens=\${inp}, output_tokens=\${out} is within 0..1000000 inclusive, got \${r.status}: \${r.text}\`);
  }
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const noKey = await post(c, GOOD, {withKey: false});
  assert.equal(noKey.status, 400, \`a report without Idempotency-Key answered \${noKey.status}, expected 400\`);
  assert.deepEqual(rows(ctx), [], \`a report without a key must store nothing, found \${JSON.stringify(rows(ctx))}\`);
  const first = await post(c, GOOD, {key: 'k-7'});
  assert.equal(first.status, 202, \`the first report answered \${first.status}: \${first.text}\`);
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (tenant, Idempotency-Key) answered \${replay.status}, expected 200 with the stored row (the gateway retried; finance must not bill it twice)\`);
  assert.equal(replay.json().usage_id, first.json().usage_id, \`the replay must answer the stored row: usage_id \${replay.json().usage_id}, the first report stored \${first.json().usage_id}\`);
  assert.equal(rows(ctx).length, 1, \`one key, one row: the usage store holds \${JSON.stringify(rows(ctx))} after a report and its replay\`);
  const other = await post(c, GOOD, {key: 'k-7', tenant: 't2'});
  assert(other.status === 202 && other.json().usage_id !== first.json().usage_id, \`another tenant reusing the key gets its own row (keys are per tenant), got \${other.status}: \${other.text}\`);
}

export async function check_key_reuse(ctx) {
  const c = api(ctx);
  const first = await post(c, GOOD, {key: 'k-9'});
  assert.equal(first.status, 202, \`the first report answered \${first.status}: \${first.text}\`);
  for (const change of [{output_tokens: 3000}, {model: 'gpt-4o-mini'}]) {
    const r = await post(c, {...GOOD, ...change}, {key: 'k-9'});
    assert.equal(r.status, 409, \`Idempotency-Key k-9 reused with \${JSON.stringify(change)} answered \${r.status}, expected 409: answering the old row hides a report the client believes was billed\`);
  }
  const keys = rows(ctx);
  assert.equal(keys.length, 1, \`a conflicting report must store nothing, the usage store holds \${JSON.stringify(keys)}\`);
  const stored = JSON.parse(ctx.redis.get(keys[0]));
  assert(stored.model === 'gpt-4o' && stored.output_tokens === 300, \`the stored row must stay the first report, it is \${JSON.stringify(stored)}\`);
  const replay = await post(c, GOOD, {key: 'k-9'});
  assert.equal(replay.status, 200, \`the original report replayed after a conflict answered \${replay.status}, expected 200\`);
}

export async function check_validate_before_store(ctx) {
  const c = api(ctx);
  for (const [i, body] of [{...GOOD, model: ''}, {input_tokens: 10, output_tokens: 10}].entries()) {
    const r = await post(c, body, {key: \`k-m-\${i}\`});
    assert.equal(r.status, 400, \`a report without a model (\${JSON.stringify(body)}) answered \${r.status}, expected 400: an unnamed model cannot be priced or audited\`);
  }
  const r = await post(c, {...GOOD, input_tokens: -40}, {key: 'k-neg'});
  assert.equal(r.status, 400, \`a negative count answered \${r.status}, expected 400\`);
  assert.deepEqual(ctx.redis.keys('*'), [], \`rejected reports must leave nothing in Redis, found \${JSON.stringify(ctx.redis.keys('*'))}: validate before store.put\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"

	"leetbuild/harness"
)

var apiGood = map[string]any{"model": "gpt-4o", "input_tokens": 1200, "output_tokens": 300}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiWith(overrides map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range apiGood {
		out[k] = v
	}
	for k, v := range overrides {
		out[k] = v
	}
	return out
}

func apiPost(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	return c.Post("/v1/usage", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func apiRow(ctx *harness.Ctx, r *harness.Response) map[string]any {
	row, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return row
}

func apiRows(ctx *harness.Ctx) []string {
	keys := ctx.Redis.Keys("usage:*")
	sort.Strings(keys)
	return keys
}

func apiStored(ctx *harness.Ctx, key string) map[string]any {
	raw, _ := ctx.Redis.Get(key)
	var row map[string]any
	ctx.NoError(json.Unmarshal([]byte(raw), &row), "the stored row is JSON: %s", raw)
	return row
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiGood, "k-1", "t1")
	ctx.Equal(r.Status, 202, "a valid report (%s)", r.Text())
	row := apiRow(ctx, r)
	for _, field := range []string{"usage_id", "tenant", "model", "input_tokens", "output_tokens"} {
		_, ok := row[field]
		ctx.Assert(ok, "the 202 body lacks %s: %s", field, r.Text())
	}
	ctx.Assert(row["tenant"] == "t1" && row["model"] == "gpt-4o" && row["input_tokens"] == float64(1200) && row["output_tokens"] == float64(300), "the row echoes the tenant and the report: %s", r.Text())
	keys := apiRows(ctx)
	ctx.Equal(len(keys), 1, "one report must store one row in the usage store (%v); rows", keys)
	ctx.Equal(apiStored(ctx, keys[0])["usage_id"], row["usage_id"], "the stored row must be the row the 202 answered; usage_id")
	noTenant := c.Post("/v1/usage", apiGood, "Idempotency-Key", "k-2")
	ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the report")
}

func CheckTokenRange(ctx *harness.Ctx) {
	c := apiClient(ctx)
	bad := [][2]any{{-1, 10}, {10, -5}, {0, 1_000_001}, {2.5, 10}, {"300", 10}}
	for i, counts := range bad {
		r := apiPost(c, apiWith(map[string]any{"input_tokens": counts[0], "output_tokens": counts[1]}), fmt.Sprintf("k-bad-%d", i), "t1")
		ctx.Equal(r.Status, 400, "input_tokens=%v, output_tokens=%v (a negative count erases spend that happened, and only integers 0..1000000 are token counts)", counts[0], counts[1])
	}
	ctx.Equal(len(apiRows(ctx)), 0, "refused reports must store nothing (%v); rows", apiRows(ctx))
	for i, n := range []int{0, 1_000_000} {
		r := apiPost(c, apiWith(map[string]any{"input_tokens": n, "output_tokens": n}), fmt.Sprintf("k-ok-%d", i), "t1")
		ctx.Equal(r.Status, 202, "counts of %d are within 0..1000000 inclusive (%s)", n, r.Text())
	}
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	noKey := c.Post("/v1/usage", apiGood, "X-Tenant-Id", "t1")
	ctx.Equal(noKey.Status, 400, "a report without Idempotency-Key")
	ctx.Equal(len(apiRows(ctx)), 0, "a report without a key must store nothing; rows")
	first := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(first.Status, 202, "the first report (%s)", first.Text())
	replay := apiPost(c, apiGood, "k-7", "t1")
	ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored row (the gateway retried; finance must not bill it twice)")
	ctx.Equal(apiRow(ctx, replay)["usage_id"], apiRow(ctx, first)["usage_id"], "the replay must answer the stored row; usage_id")
	ctx.Equal(len(apiRows(ctx)), 1, "one key, one row: rows after a report and its replay (%v)", apiRows(ctx))
	other := apiPost(c, apiGood, "k-7", "t2")
	ctx.Assert(other.Status == 202 && apiRow(ctx, other)["usage_id"] != apiRow(ctx, first)["usage_id"], "another tenant reusing the key gets its own row (keys are per tenant), got %d: %s", other.Status, other.Text())
}

func CheckKeyReuse(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := apiPost(c, apiGood, "k-9", "t1")
	ctx.Equal(first.Status, 202, "the first report (%s)", first.Text())
	for _, change := range []map[string]any{{"output_tokens": 3000}, {"model": "gpt-4o-mini"}} {
		r := apiPost(c, apiWith(change), "k-9", "t1")
		ctx.Equal(r.Status, 409, "Idempotency-Key k-9 reused with %v (answering the old row hides a report the client believes was billed)", change)
	}
	keys := apiRows(ctx)
	ctx.Equal(len(keys), 1, "a conflicting report must store nothing (%v); rows", keys)
	stored := apiStored(ctx, keys[0])
	ctx.Assert(stored["model"] == "gpt-4o" && stored["output_tokens"] == float64(300), "the stored row must stay the first report, it is %v", stored)
	replay := apiPost(c, apiGood, "k-9", "t1")
	ctx.Equal(replay.Status, 200, "the original report replayed after a conflict")
}

func CheckValidateBeforeStore(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for i, body := range []map[string]any{apiWith(map[string]any{"model": ""}), {"input_tokens": 10, "output_tokens": 10}} {
		r := apiPost(c, body, fmt.Sprintf("k-m-%d", i), "t1")
		ctx.Equal(r.Status, 400, "a report without a model (%v): an unnamed model cannot be priced or audited", body)
	}
	r := apiPost(c, apiWith(map[string]any{"input_tokens": -40}), "k-neg", "t1")
	ctx.Equal(r.Status, 400, "a negative count")
	ctx.Equal(len(ctx.Redis.Keys("*")), 0, "rejected reports must leave nothing in Redis (%v): validate before usage.Put; keys", ctx.Redis.Keys("*"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const json kGood = {{"model", "gpt-4o"}, {"input_tokens", 1200}, {"output_tokens", 300}};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const json& body, const std::string& key = "k-1", const std::string& tenant = "t1") {
    return http.Post("/v1/usage", body.dump(), "X-Tenant-Id", tenant, "Idempotency-Key", key);
  }
};

json with(json body, const std::string& field, const json& value) {
  body[field] = value;
  return body;
}

json rowOf(harness::Ctx& ctx, const harness::Response& r) {
  const json row = json::parse(r.Text(), nullptr, false);
  ctx.Assert(row.is_object(), "the body must be a JSON object: %s", r.Text());
  return row;
}

std::vector<std::string> rows(harness::Ctx& ctx) {
  auto keys = ctx.Redis.Keys("usage:*");
  std::sort(keys.begin(), keys.end());
  return keys;
}

json stored(harness::Ctx& ctx, const std::string& key) {
  return json::parse(ctx.Redis.Get(key).value_or("null"), nullptr, false);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kGood);
  ctx.Equal(r.Status, 202, "a valid report (%s)", r.Text());
  const json row = rowOf(ctx, r);
  for (const char* field : {"usage_id", "tenant", "model", "input_tokens", "output_tokens"}) {
    ctx.Assert(row.contains(field), "the 202 body lacks %s: %s", field, r.Text());
  }
  ctx.Assert(row["tenant"] == "t1" && row["model"] == "gpt-4o" && row["input_tokens"] == 1200 && row["output_tokens"] == 300,
             "the row echoes the tenant and the report: %s", r.Text());
  const auto keys = rows(ctx);
  ctx.Equal(keys.size(), 1, "one report must store one row in the usage store (%v); rows", keys);
  ctx.Equal(stored(ctx, keys[0])["usage_id"], row["usage_id"], "the stored row must be the row the 202 answered; usage_id");
  const auto noTenant = api.http.Post("/v1/usage", kGood.dump(), "Idempotency-Key", "k-2");
  ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the report");
}

void CheckTokenRange(harness::Ctx& ctx) {
  Api api(ctx);
  const std::vector<std::pair<json, json>> bad = {{-1, 10}, {10, -5}, {0, 1000001}, {2.5, 10}, {"300", 10}};
  int i = 0;
  for (const auto& [inp, out] : bad) {
    const auto r = api.post(with(with(kGood, "input_tokens", inp), "output_tokens", out), "k-bad-" + std::to_string(i++));
    ctx.Equal(r.Status, 400, "input_tokens=%s, output_tokens=%s (a negative count erases spend that happened, and only integers 0..1000000 are token counts)", inp.dump(), out.dump());
  }
  ctx.Equal(rows(ctx).size(), 0, "refused reports must store nothing (%v); rows", rows(ctx));
  for (long long n : {0LL, 1000000LL}) {
    const auto r = api.post(with(with(kGood, "input_tokens", n), "output_tokens", n), "k-ok-" + std::to_string(n));
    ctx.Equal(r.Status, 202, "counts of %d are within 0..1000000 inclusive (%s)", n, r.Text());
  }
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  Api api(ctx);
  const auto noKey = api.http.Post("/v1/usage", kGood.dump(), "X-Tenant-Id", "t1");
  ctx.Equal(noKey.Status, 400, "a report without Idempotency-Key");
  ctx.Equal(rows(ctx).size(), 0, "a report without a key must store nothing; rows");
  const auto first = api.post(kGood, "k-7");
  ctx.Equal(first.Status, 202, "the first report (%s)", first.Text());
  const auto replay = api.post(kGood, "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored row (the gateway retried; finance must not bill it twice)");
  ctx.Equal(rowOf(ctx, replay)["usage_id"], rowOf(ctx, first)["usage_id"], "the replay must answer the stored row; usage_id");
  ctx.Equal(rows(ctx).size(), 1, "one key, one row: rows after a report and its replay (%v)", rows(ctx));
  const auto other = api.post(kGood, "k-7", "t2");
  ctx.Assert(other.Status == 202 && rowOf(ctx, other)["usage_id"] != rowOf(ctx, first)["usage_id"],
             "another tenant reusing the key gets its own row (keys are per tenant), got %d: %s", other.Status, other.Text());
}

void CheckKeyReuse(harness::Ctx& ctx) {
  Api api(ctx);
  const auto first = api.post(kGood, "k-9");
  ctx.Equal(first.Status, 202, "the first report (%s)", first.Text());
  for (const auto& [field, value] : std::vector<std::pair<std::string, json>>{{"output_tokens", 3000}, {"model", "gpt-4o-mini"}}) {
    const auto r = api.post(with(kGood, field, value), "k-9");
    ctx.Equal(r.Status, 409, "Idempotency-Key k-9 reused with %s=%s (answering the old row hides a report the client believes was billed)", field, value.dump());
  }
  const auto keys = rows(ctx);
  ctx.Equal(keys.size(), 1, "a conflicting report must store nothing (%v); rows", keys);
  const json row = stored(ctx, keys[0]);
  ctx.Assert(row.is_object() && row["model"] == "gpt-4o" && row["output_tokens"] == 300, "the stored row must stay the first report, it is %s", row.dump());
  const auto replay = api.post(kGood, "k-9");
  ctx.Equal(replay.Status, 200, "the original report replayed after a conflict");
}

void CheckValidateBeforeStore(harness::Ctx& ctx) {
  Api api(ctx);
  const std::vector<json> bodies = {with(kGood, "model", ""), json{{"input_tokens", 10}, {"output_tokens", 10}}};
  int i = 0;
  for (const auto& body : bodies) {
    const auto r = api.post(body, "k-m-" + std::to_string(i++));
    ctx.Equal(r.Status, 400, "a report without a model (%s): an unnamed model cannot be priced or audited", body.dump());
  }
  const auto r = api.post(with(kGood, "input_tokens", -40), "k-neg");
  ctx.Equal(r.Status, 400, "a negative count");
  ctx.Equal(ctx.Redis.Keys("*").size(), 0, "rejected reports must leave nothing in Redis (%v): validate before usage::put; keys", ctx.Redis.Keys("*"));
}
`,
  },
  hints: [
    'Symptom: an invoice shows the same report twice after a gateway timeout, a retry that changed its counts is silently answered with the old row, and a report of -5000 tokens lowers the bill.',
    'Mechanism: the starter stores each report under a fresh usage_id, so a replay of the same Idempotency-Key finds nothing to match; and it copies model and counts from the body without a type or a range.',
    'Change: guards first (tenant 401, key 400, model 400, counts 0..MAX_TOKENS_PER_REPORT 400); then `store.get(tenant, key)`: 409 if model or counts differ, 200 if they match; `store.put(tenant, key, row)` only after that.',
  ],
  debrief: `The key is what turns a retry into a lookup: the client names the report, so a replay finds the row it already made instead of minting another usage_id. Comparing the replay with the stored report is what keeps the key honest. Stripe's idempotency layer does the same and errors when a key comes back with other parameters, because answering the old result would tell the caller a new report was billed when it was not. Validating before the write means a rejected report leaves nothing to clean up. Keys are per tenant because clients choose them and collide. What a production meter adds: key expiry tied to the client's retry window (Stripe prunes after 24 hours), a request fingerprint hashed over the whole body, and a reconcile job against the provider's own usage export.`,
};
