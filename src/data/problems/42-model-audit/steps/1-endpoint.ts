import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/audit/decisions: append, never edit',
  concept: 'http',
  file: 'api',
  focus: ['client', 'auditd', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/audit/decisions\` with body
\`{"model_version": "…", "policy_id": "…", "input_digest": "…", "decision_digest": "…"}\`: it reads
the tenant header, copies the body into a row (including \`prompt\` and the caller's \`timestamp\`),
inserts it, and also registers a \`PATCH\` route that runs \`UPDATE audit_decisions\`. It compiles,
serves the demo and hides 4 flaws.

**Failure mode the checks target.** The trail must be evidence: it must hold digests rather than
content, it must not carry a clock the caller controls, it must refuse malformed records, and its
correctness includes the routes it does not have.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- Every field is required and non-empty (**400** otherwise). \`input_digest\` and
  \`decision_digest\` are lowercase hex digests of exactly **64** characters; anything else is
  **400**.
- Prompts do not enter the store. The record holds the model version, the policy id and the two
  digests; the caller's inputs and the decision itself are not read from the body, logged or
  persisted.
- The record is immutable. There is no update route and no delete route; an update attempt on an
  existing record is answered **405** by design.
- Timestamps are server-set and monotonic per tenant: the field is \`recorded_at\`, written from the
  server clock as \`max(now_ms, last_recorded_at + 1)\`; the caller's own timestamp is never read.
- Answer **201** with the stored record: \`id\`, \`tenant\`, \`model_version\`, \`policy_id\`,
  \`input_digest\`, \`decision_digest\` and \`recorded_at\`.`,
  sequence: {
    participants: ['Client', 'Audit Service', 'Postgres'],
    messages: [
      {from: 'Client', to: 'Audit Service', label: 'POST /v1/audit/decisions · X-Tenant-Id · digests', kind: 'sync'},
      {
        from: 'Audit Service',
        to: 'Audit Service',
        label: '401 when the tenant is missing · 400 on a bad digest',
        kind: 'sync',
      },
      {from: 'Audit Service', to: 'Postgres', label: 'SELECT max(recorded_at) for the tenant', kind: 'sync'},
      {from: 'Postgres', to: 'Audit Service', label: 'last recorded_at', kind: 'reply'},
      {
        from: 'Audit Service',
        to: 'Postgres',
        label: 'INSERT digests only · recorded_at = max(now, last + 1)',
        kind: 'sync',
      },
      {from: 'Audit Service', to: 'Client', label: '201 {id, digests, recorded_at}', kind: 'reply'},
      {from: 'Client', to: 'Audit Service', label: 'PATCH /v1/audit/decisions/{id}', kind: 'sync'},
      {from: 'Audit Service', to: 'Client', label: '405 — the trail has no edits', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves POST /v1/audit/decisions',
      detail:
        'Register the append on `POST /v1/audit/decisions`; the body carries the model version, the policy id and the two digests.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/audit\/decisions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/audit\/decisions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/audit\/decisions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"audit"\s*\/\s*"decisions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(R"\(/, /audit\/decisions/]},
      },
    },
    {
      id: 'no-prompt',
      title: 'Prompts never enter the store',
      detail:
        'The handler reads and persists the two digests only; the word `prompt` appears nowhere in the code path. The starter stores the full prompt "for replayability", which is exactly the content an audit trail must be able to prove it never kept.',
      match: {
        python: {all: [/input_digest/, /decision_digest/], none: [/prompt/]},
        typescript: {all: [/input_digest/, /decision_digest/], none: [/prompt/]},
        go: {all: [/input_digest/, /decision_digest/], none: [/prompt/]},
        scala: {all: [/input_digest/, /decision_digest/], none: [/prompt/]},
        cpp: {all: [/input_digest/, /decision_digest/], none: [/prompt/]},
      },
    },
    {
      id: 'immutable',
      title: 'No update route; an edit attempt is 405',
      detail:
        'There is no `UPDATE audit_decisions` in the code path and an update attempt answers **405**. The starter registers a `PATCH` route that runs `UPDATE audit_decisions … SET …`, so history is editable.',
      match: {
        python: {all: [/\b405\b/], none: [/UPDATE audit_decisions/]},
        typescript: {all: [/\b405\b/], none: [/UPDATE audit_decisions/]},
        go: {all: [/StatusMethodNotAllowed/], none: [/UPDATE audit_decisions/]},
        scala: {all: [/StatusCodes\.MethodNotAllowed/], none: [/UPDATE audit_decisions/]},
        cpp: {all: [/\b405\b/], none: [/UPDATE audit_decisions/]},
      },
    },
    {
      id: 'server-timestamp',
      title: 'The timestamp is server-set and monotonic per tenant',
      detail:
        'The stored field is `recorded_at`, taken from the server clock and advanced past the tenant’s last record; the caller’s `timestamp` is never read. The starter writes whatever the body sends, so a client can backdate history.',
      match: {
        python: {all: [/\btime\.time\(\)|now_ms\(\)/, /recorded_at/], none: [/\btimestamp\b/]},
        typescript: {all: [/Date\.now\(\)/, /recorded_at/], none: [/\btimestamp\b/]},
        go: {all: [/time\.Now\(\)/, /recorded_at/], none: [/\btimestamp\b/]},
        scala: {all: [/System\.currentTimeMillis\(\)/, /recorded_at/], none: [/\btimestamp\b/]},
        cpp: {all: [/system_clock::now\(\)|now_ms\(\)/, /recorded_at/], none: [/\btimestamp\b/]},
      },
    },
    {
      id: 'validate',
      title: 'Tenant and digest validation before the insert',
      detail:
        'A missing tenant is **401**; an empty field or a digest that is not 64 lowercase hex characters is **400**. The starter validates nothing, so a malformed record is accepted and becomes evidence.',
      match: {
        python: {all: [/\b401\b/, /\b400\b/, /64/]},
        typescript: {all: [/code\(401\)/, /code\(400\)/, /64/]},
        go: {all: [/StatusUnauthorized/, /StatusBadRequest/, /64/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /StatusCodes\.BadRequest/, /64/]},
        cpp: {all: [/\b401\b/, /\b400\b/, /64/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


def now_ms() -> int:
    import time

    return int(time.time() * 1000)


@app.post("/v1/audit/decisions")
def append_decision(body: dict, cur=None) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    record = {
        "model_version": body["model_version"],
        "policy_id": body["policy_id"],
        "prompt": body.get("prompt", ""),
        "timestamp": body["timestamp"],
    }
    cur.execute(
        "INSERT INTO audit_decisions (model_version, policy_id, prompt, recorded_at)"
        " VALUES (%s, %s, %s, %s) RETURNING id",
        (record["model_version"], record["policy_id"], record["prompt"], record["timestamp"]),
    )
    return JSONResponse({"id": cur.fetchone()[0], "timestamp": record["timestamp"]}, status_code=201)


@app.patch("/v1/audit/decisions/{record_id}")
def correct_decision(record_id: str, body: dict, cur=None) -> JSONResponse:
    # "Corrections" for an audit trail: the whole point is that there are none.
    cur.execute("UPDATE audit_decisions SET model_version = %s WHERE id = %s", (body["model_version"], record_id))
    return JSONResponse({"id": record_id}, status_code=200)
`,
      solution: `import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

DIGEST_LEN = 64
HEX = set("0123456789abcdef")


def now_ms() -> int:
    return int(time.time() * 1000)


def is_digest(value: object) -> bool:
    return isinstance(value, str) and len(value) == DIGEST_LEN and set(value) <= HEX


@app.post("/v1/audit/decisions")
def append_decision(
    body: dict,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    cur=None,
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail={"error": "missing X-Tenant-Id"})

    model_version = body.get("model_version")
    policy_id = body.get("policy_id")
    input_digest = body.get("input_digest")
    decision_digest = body.get("decision_digest")
    if not isinstance(model_version, str) or model_version == "":
        raise HTTPException(status_code=400, detail={"error": "model_version required"})
    if not isinstance(policy_id, str) or policy_id == "":
        raise HTTPException(status_code=400, detail={"error": "policy_id required"})
    if not is_digest(input_digest) or not is_digest(decision_digest):
        raise HTTPException(status_code=400, detail={"error": "digest must be 64 hex characters"})

    # Digests only: the inputs and the decision never reach the store, so "replay" is impossible by
    # construction rather than by policy, and the trail is not a second copy of tenant content.
    cur.execute("SELECT COALESCE(max(recorded_at), 0) FROM audit_decisions WHERE tenant_id = %s", (tenant,))
    recorded_at = max(now_ms(), int(cur.fetchone()[0]) + 1)
    cur.execute(
        "INSERT INTO audit_decisions"
        " (tenant_id, model_version, policy_id, input_digest, decision_digest, recorded_at)"
        " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        (tenant, model_version, policy_id, input_digest, decision_digest, recorded_at),
    )
    record_id = cur.fetchone()[0]
    return JSONResponse(
        {
            "id": record_id,
            "tenant": tenant,
            "model_version": model_version,
            "policy_id": policy_id,
            "input_digest": input_digest,
            "decision_digest": decision_digest,
            "recorded_at": recorded_at,
        },
        status_code=201,
    )


@app.api_route("/v1/audit/decisions/{record_id}", methods=["PUT", "PATCH", "DELETE"])
def immutability(record_id: str) -> JSONResponse:
    # An audit trail has no corrections: the route exists to answer 405 by design, not to edit.
    return JSONResponse({"error": "audit records are append-only"}, status_code=405)
`,
    },
    typescript: {
      starter: `/** A audit endpoint that keeps the prompt and offers corrections. */
import Fastify from 'fastify';

export const app = Fastify();

app.post('/v1/audit/decisions', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const body = request.body as Record<string, unknown>;
  const tenant = (request.headers['x-tenant-id'] as string) ?? 'anonymous';
  const {rows} = await db.query(
    'INSERT INTO audit_decisions (tenant_id, model_version, prompt, recorded_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenant, body.model_version, body.prompt, body.timestamp],
  );
  return reply.code(201).send({id: rows[0].id, timestamp: body.timestamp});
});

app.patch('/v1/audit/decisions/:record_id', async (request, reply) => {
  await db.query('UPDATE audit_decisions SET model_version = $1 WHERE id = $2', [
    (request.body as Record<string, unknown>).model_version,
    (request.params as Record<string, string>).record_id,
  ]);
  return reply.code(200).send({ok: true});
});
`,
      solution: `/** Append-only audit records: digests in, nothing else out. */
import Fastify from 'fastify';

export const app = Fastify();

const DIGEST_LEN = 64;

const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && value.length === DIGEST_LEN && /^[0-9a-f]+$/.test(value);

app.post('/v1/audit/decisions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = request.body as Record<string, unknown>;
  const modelVersion = body.model_version;
  const policyId = body.policy_id;
  const inputDigest = body.input_digest;
  const decisionDigest = body.decision_digest;
  if (typeof modelVersion !== 'string' || modelVersion === '') return reply.code(400).send({error: 'model_version required'});
  if (typeof policyId !== 'string' || policyId === '') return reply.code(400).send({error: 'policy_id required'});
  if (!isDigest(inputDigest) || !isDigest(decisionDigest))
    return reply.code(400).send({error: 'digest must be 64 hex characters'});

  // Digests only: the inputs never reach the store, so the trail proves what was decided without
  // keeping the content that produced it.
  const {rows} = await db.query(
    'SELECT COALESCE(max(recorded_at), 0) AS last FROM audit_decisions WHERE tenant_id = $1',
    [tenant],
  );
  const recordedAt = Math.max(Date.now(), Number(rows[0].last) + 1);
  const inserted = await db.query(
    'INSERT INTO audit_decisions (tenant_id, model_version, policy_id, input_digest, decision_digest, recorded_at)'
      + ' VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [tenant, modelVersion, policyId, inputDigest, decisionDigest, recordedAt],
  );
  return reply.code(201).send({
    id: inserted.rows[0].id,
    tenant,
    model_version: modelVersion,
    policy_id: policyId,
    input_digest: inputDigest,
    decision_digest: decisionDigest,
    recorded_at: recordedAt,
  });
});

app.route({
  method: ['PUT', 'PATCH', 'DELETE'],
  url: '/v1/audit/decisions/:record_id',
  // An audit trail has no corrections: the route exists to answer 405 by design, not to edit.
  handler: async (_request, reply) => reply.code(405).send({error: 'audit records are append-only'}),
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

type appendRequest struct {
	ModelVersion string \`json:"model_version"\`
	Prompt       string \`json:"prompt"\`
	Timestamp    int64  \`json:"timestamp"\`
}

func appendDecision(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	var in appendRequest
	_ = json.NewDecoder(r.Body).Decode(&in)
	tenant := r.Header.Get("X-Tenant-Id")
	var id string
	_ = db.QueryRowContext(
		r.Context(),
		"INSERT INTO audit_decisions (tenant_id, model_version, prompt, recorded_at) VALUES ($1, $2, $3, $4) RETURNING id",
		tenant, in.ModelVersion, in.Prompt, in.Timestamp,
	).Scan(&id)
	writeJSON(rw, http.StatusCreated, map[string]any{"id": id, "timestamp": in.Timestamp})
}

func correctDecision(rw http.ResponseWriter, r *http.Request) {
	var in appendRequest
	_ = json.NewDecoder(r.Body).Decode(&in)
	_, _ = db.ExecContext(
		r.Context(),
		"UPDATE audit_decisions SET model_version = $1 WHERE id = $2",
		in.ModelVersion, r.PathValue("record_id"),
	)
	writeJSON(rw, http.StatusOK, map[string]any{"ok": true})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/audit/decisions", appendDecision)
	mux.HandleFunc("PATCH /v1/audit/decisions/{record_id}", correctDecision)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"
)

const digestLen = 64

func isDigest(value string) bool {
	if len(value) != digestLen {
		return false
	}
	for _, c := range value {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

type appendRequest struct {
	ModelVersion   string \`json:"model_version"\`
	PolicyID       string \`json:"policy_id"\`
	InputDigest    string \`json:"input_digest"\`
	DecisionDigest string \`json:"decision_digest"\`
}

func appendDecision(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var in appendRequest
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if in.ModelVersion == "" || in.PolicyID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "model_version and policy_id required"})
		return
	}
	if !isDigest(in.InputDigest) || !isDigest(in.DecisionDigest) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "digest must be 64 hex characters"})
		return
	}

	// Digests only: the inputs never reach the store, so the record proves what was decided without
	// holding the content that produced it.
	var last int64
	_ = db.QueryRowContext(
		r.Context(),
		"SELECT COALESCE(max(recorded_at), 0) FROM audit_decisions WHERE tenant_id = $1",
		tenant,
	).Scan(&last)
	recordedAt := time.Now().UnixMilli()
	if recordedAt <= last {
		recordedAt = last + 1
	}
	var id string
	err := db.QueryRowContext(
		r.Context(),
		"INSERT INTO audit_decisions (tenant_id, model_version, policy_id, input_digest, decision_digest, recorded_at)"
			+" VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
		tenant, in.ModelVersion, in.PolicyID, in.InputDigest, in.DecisionDigest, recordedAt,
	).Scan(&id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "append failed"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{
		"id":              id,
		"tenant":          tenant,
		"model_version":   in.ModelVersion,
		"policy_id":       in.PolicyID,
		"input_digest":    in.InputDigest,
		"decision_digest": in.DecisionDigest,
		"recorded_at":     recordedAt,
	})
}

// An audit trail has no corrections: the write methods exist to answer 405 by design, not to edit.
func immutable(rw http.ResponseWriter, _ *http.Request) {
	writeJSON(rw, http.StatusMethodNotAllowed, map[string]string{"error": "audit records are append-only"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/audit/decisions", appendDecision)
	mux.HandleFunc("PUT /v1/audit/decisions/{record_id}", immutable)
	mux.HandleFunc("PATCH /v1/audit/decisions/{record_id}", immutable)
	mux.HandleFunc("DELETE /v1/audit/decisions/{record_id}", immutable)
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

object AuditApi {
  implicit val system: ActorSystem = ActorSystem("auditd")

  final case class AppendRequest(model_version: String, prompt: String, timestamp: Long)

  val route: Route =
    path("v1" / "audit" / "decisions") {
      post {
        entity(as[AppendRequest]) { request =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val recordedAt = request.timestamp
          val id = db.insert(tenant, request.model_version, request.prompt, recordedAt)
          complete(StatusCodes.Created, s"""{"id":"$id","timestamp":$recordedAt}""")
        }
      } ~
        patch {
          path("v1" / "audit" / "decisions" / Segment) { recordId =>
            // "Corrections" for an audit trail: the whole point is that there are none.
            db.update(recordId)
            complete(StatusCodes.OK, """{"ok":true}""")
          }
        }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.sql.Connection

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AppendRequest(model_version: String, policy_id: String, input_digest: String, decision_digest: String)

final case class AuditRecord(
    id: String,
    tenant: String,
    model_version: String,
    policy_id: String,
    input_digest: String,
    decision_digest: String,
    recorded_at: Long,
)

object AuditApi {
  implicit val system: ActorSystem = ActorSystem("auditd")
  implicit val requestFormat: RootJsonFormat[AppendRequest] = jsonFormat4(AppendRequest)
  implicit val recordFormat: RootJsonFormat[AuditRecord] = jsonFormat7(AuditRecord)

  val DigestLen = 64
  val Hex = "0123456789abcdef".toSet

  def isDigest(value: String): Boolean =
    value.length == DigestLen && value.forall(Hex.contains)

  def appendDecision(conn: Connection, tenant: String, request: AppendRequest): Either[String, AuditRecord] = {
    // Digests only: the inputs never reach the store, so the trail proves what was decided without
    // keeping the content that produced it.
    val last = db.lastRecordedAt(conn, tenant)
    val recordedAt = Math.max(System.currentTimeMillis(), last + 1)
    val id = db.insert(conn, tenant, request.model_version, request.policy_id, request.input_digest, request.decision_digest, recordedAt)
    Right(AuditRecord(id, tenant, request.model_version, request.policy_id, request.input_digest, request.decision_digest, recordedAt))
  }

  val route: Route =
    path("v1" / "audit" / "decisions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            entity(as[AppendRequest]) { request =>
              if (request.model_version.isEmpty || request.policy_id.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"model_version and policy_id required"}""")
              } else if (!isDigest(request.input_digest) || !isDigest(request.decision_digest)) {
                complete(StatusCodes.BadRequest, """{"error":"digest must be 64 hex characters"}""")
              } else {
                appendDecision(conn, tenantOpt.get, request) match {
                  case Right(record) => complete(StatusCodes.Created, record)
                  case Left(error) => complete(StatusCodes.ServiceUnavailable, s"""{"error":"\\$error"}""")
                }
              }
            }
          }
        }
      } ~
        path("v1" / "audit" / "decisions" / Segment) { recordId =>
          // An audit trail has no corrections: the route exists to answer 405 by design, not to edit.
          (put | patch | delete) {
            complete(StatusCodes.MethodNotAllowed, s"""{"error":"\\$recordId is append-only"}""")
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

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/audit/decisions)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto body = json::parse(req.body);
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto id = db_insert(tenant, body["model_version"], body["prompt"], body["timestamp"]);
    res.status = 201;
    res.set_content(json{{"id", id}, {"timestamp", body["timestamp"]}}.dump(), "application/json");
  });

  svr.Patch(R"(/v1/audit/decisions/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    // "Corrections" for an audit trail: the whole point is that there are none.
    const auto body = json::parse(req.body);
    db_update(req.matches[1], body["model_version"]);
    res.status = 200;
    res.set_content(R"({"ok":true})", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

using json = nlohmann::json;

constexpr int kDigestLen = 64;

bool is_digest(const std::string& value) {
  if (value.size() != kDigestLen) return false;
  for (const char c : value)
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

int main() {
  httplib::Server svr;

  svr.Post(R"(/v1/audit/decisions)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const json body = json::parse(req.body);
    const std::string model_version = body.value("model_version", "");
    const std::string policy_id = body.value("policy_id", "");
    const std::string input_digest = body.value("input_digest", "");
    const std::string decision_digest = body.value("decision_digest", "");
    if (model_version.empty() || policy_id.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"model_version and policy_id required"})", "application/json");
      return;
    }
    if (!is_digest(input_digest) || !is_digest(decision_digest)) {
      res.status = 400;
      res.set_content(R"({"error":"digest must be 64 hex characters"})", "application/json");
      return;
    }

    // Digests only: the inputs never reach the store, so the trail proves what was decided without
    // keeping the content that produced it.
    pqxx::work tx(db_pool());
    const long long last = last_recorded_at(tx, tenant);
    const long long recorded_at = std::max(now_ms(), last + 1);
    const std::string id =
        insert_decision(tx, tenant, model_version, policy_id, input_digest, decision_digest, recorded_at);
    tx.commit();
    res.status = 201;
    res.set_content(
        json{{"id", id},
             {"tenant", tenant},
             {"model_version", model_version},
             {"policy_id", policy_id},
             {"input_digest", input_digest},
             {"decision_digest", decision_digest},
             {"recorded_at", recorded_at}}
            .dump(),
        "application/json");
  });

  // An audit trail has no corrections: the route exists to answer 405 by design, not to edit.
  const auto immutable = [](const httplib::Request&, httplib::Response& res) {
    res.status = 405;
    res.set_content(R"({"error":"audit records are append-only"})", "application/json");
  };
  svr.Put(R"(/v1/audit/decisions/([\\w-]+))", immutable);
  svr.Patch(R"(/v1/audit/decisions/([\\w-]+))", immutable);
  svr.Delete(R"(/v1/audit/decisions/([\\w-]+))", immutable);

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'An auditor pulls a record and finds the prompt text and a timestamp from last year, then discovers a PATCH that would let anyone rewrite it. The service accepts anything the body says.',
    'The handler copies body fields straight into the row: `prompt`, the caller `timestamp`, unvalidated digests. The PATCH route exists because the code offers corrections instead of refusing them.',
    'Validate tenant (401), fields and 64-char hex digests (400); drop `prompt`; write `recorded_at = max(now_ms, last + 1)`; replace the PATCH route with a 405 handler and remove the UPDATE.',
  ],
  debrief: `The fix has the shape of a boundary: everything the row contains is either validated or produced by the server. Digests stand in for content so the trail can prove what was decided without holding it; \`recorded_at\` comes from the server clock and is advanced past the tenant's last record so the verifier can order entries later; the 405 handler is registered deliberately, because the absence of an edit route is a property you have to assert, not a route you forgot. Production audit services go further: a per-record signature or Merkle proof over each append batch, a policy id that resolves to an immutable policy version, and a hash-only index so an auditor can look a decision up by its input digest without the service ever seeing the input.`,
};
