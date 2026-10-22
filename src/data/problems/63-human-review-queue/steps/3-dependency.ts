import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Auto-resolve calls that only clear safe categories',
  concept: 'grpc',
  file: 'client',
  focus: ['queue', 'enforcement', 'items'],
  task: `## Task

**Review premise.** The starter calls the enforcement service and, when the call times out, decides
the item itself. It also retries a rejection. On the demo the service always answers, so nobody
notices — until an enforcement outage silently approves a spam wave. Review it, fix it, and prove the
fix with the checks below.

Implement \`POST /v1/review/items/{item_id}/resolve\` over the **gRPC** enforcement client:

- **Only the safe class auto-resolves.** \`SAFE_CATEGORIES\` is \`spam_duplicate\` and
  \`known_safe_false_positive\`. Every other category requires explicit reviewer confirmation
  (**409** \`needs_confirmation\` until the reviewer confirms), never an auto-resolve.
- **The call has a 1-second deadline.** Pass it on the RPC (\`timeout\` in Python,
  \`deadline\` in grpc-js, \`context.WithTimeout\` in Go, a deadline in the Scala/C++ client
  context). An enforcement call must never hang a reviewer's request.
- **A timeout escalates, it does not resolve.** \`DEADLINE_EXCEEDED\` returns
  \`{"outcome": "escalated"}\` (**202**) — the item stays with a human. A timeout is *not* approval.
- **A policy rejection is terminal.** \`PERMISSION_DENIED\` means the platform will not clear this
  category; escalate and **stop**. Do not retry it — a retry loop hammers the same category and
  turns one rejection into a denial-of-service on the enforcement service.
- **Every auto-resolve records a grant.** \`record_grant(tenant, item_id, category, grant_id)\`
  writes an audit row tying the auto-resolve to the enforcement service's grant, so the decision can
  be explained months later. No grant, no auto-resolve.

**Failure mode the checks target.** Two defects. The draft treats a timeout as approval for anything
above 0.5 confidence, so an enforcement outage becomes a silent self-approval loop that clears
exactly the items nobody could verify. And it retries \`PERMISSION_DENIED\`, so a category the policy
has refused gets hammered three times per resolution.`,
  sequence: {
    participants: ['Reviewer', 'Review Queue', 'Enforcement', 'Item store'],
    messages: [
      {from: 'Reviewer', to: 'Review Queue', label: 'POST /v1/review/items/{id}/resolve', kind: 'sync'},
      {from: 'Review Queue', to: 'Review Queue', label: 'category in SAFE_CATEGORIES?', kind: 'sync'},
      {from: 'Review Queue', to: 'Enforcement', label: 'AutoResolve · deadline 1 s', kind: 'sync'},
      {from: 'Enforcement', to: 'Review Queue', label: 'grant / DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Review Queue', to: 'Item store', label: 'record_grant · commit outcome', kind: 'sync'},
      {from: 'Review Queue', to: 'Reviewer', label: '200 auto_resolved / 202 escalated', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'The enforcement call has a one-second deadline',
      detail:
        'The RPC is issued with a deadline: a `ENFORCEMENT_DEADLINE` constant passed as `timeout`, `deadline`, or a context/context deadline. The draft issues it with no deadline.',
      match: {
        python: {all: [/ENFORCEMENT_DEADLINE/, /timeout=/]},
        typescript: {all: [/ENFORCEMENT_DEADLINE_MS/, /deadline:/]},
        go: {all: [/enforcementDeadline/, /context\.WithTimeout\(/]},
        scala: {all: [/EnforcementDeadlineMs/, /deadline/]},
        cpp: {all: [/kEnforcementDeadlineMs/, /deadline/]},
      },
    },
    {
      id: 'safe-class',
      title: 'Only the safe class auto-resolves',
      detail:
        'Auto-resolve is gated on `SAFE_CATEGORIES` (`spam_duplicate`, `known_safe_false_positive`); everything else escalates to a human. The draft gates on a 0.5 confidence instead.',
      match: {
        python: {all: [/SAFE_CATEGORIES/, /not in SAFE_CATEGORIES/]},
        typescript: {all: [/SAFE_CATEGORIES/, /SAFE_CATEGORIES\.has\(/]},
        go: {all: [/safeCategories/, /safeCategories\[/]},
        scala: {all: [/SafeCategories/, /SafeCategories\.contains\(/]},
        cpp: {all: [/kSafeCategories/, /kSafeCategories\.count\(/]},
      },
    },
    {
      id: 'grant',
      title: 'Every auto-resolve records a grant',
      detail:
        'A successful auto-resolve calls `record_grant` with the enforcement service’s grant id before the outcome is returned.',
      match: {
        python: {all: [/def record_grant\(/]},
        typescript: {all: [/function recordGrant\(/]},
        go: {all: [/func recordGrant\(/]},
        scala: {all: [/def recordGrant\(/]},
        cpp: {all: [/recordGrant\(/]},
      },
    },
    {
      id: 'timeout-escalates',
      title: 'A timeout escalates instead of resolving',
      detail:
        '`DEADLINE_EXCEEDED` produces an **escalated** outcome for a human — never an auto-resolve. The draft resolves on timeout above 0.5 confidence.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /escalate/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /escalate/]},
        go: {all: [/DeadlineExceeded/, /escalate/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /escalate/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /escalate/]},
      },
    },
    {
      id: 'rejection-terminal',
      title: 'A policy rejection is terminal',
      detail:
        '`PERMISSION_DENIED` is handled as a final answer — escalated, not retried. The draft wraps the RPC in a three-attempt retry loop that hammers the rejected category.',
      match: {
        python: {all: [/PERMISSION_DENIED/], none: [/for attempt in range\(/]},
        typescript: {all: [/PERMISSION_DENIED/], none: [/for \(let attempt/]},
        go: {all: [/PermissionDenied/], none: [/for attempt :=/]},
        scala: {all: [/PERMISSION_DENIED/], none: [/for \(attempt/]},
        cpp: {all: [/PERMISSION_DENIED/], none: [/for \(int attempt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

CONFIDENCE_THRESHOLD = 0.5


class ResolveBody(BaseModel):
    category: str
    confidence: float = 0.0
    confirmed: bool = False


@app.post("/v1/review/items/{item_id}/resolve")
def resolve(
    item_id: str,
    body: ResolveBody,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft auto-resolves any category above 0.5 confidence when the enforcement call
    # times out, and it retries a policy rejection, so one category gets hammered. Review both.
    for attempt in range(3):
        try:
            response = stub.AutoResolve(
                ResolveRequest(tenant=tenant, item_id=item_id, category=body.category)
            )
            return JSONResponse(
                {"item_id": item_id, "outcome": "auto_resolved", "grant_id": response.grant_id}
            )
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED and body.confidence > CONFIDENCE_THRESHOLD:
                return JSONResponse(
                    {"item_id": item_id, "outcome": "auto_resolved", "grant_id": "implicit"}
                )
            continue
    return JSONResponse({"item_id": item_id, "outcome": "auto_resolved", "grant_id": "fallback"})
`,
      solution: `import grpc

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

SAFE_CATEGORIES = {"spam_duplicate", "known_safe_false_positive"}
ENFORCEMENT_DEADLINE_SECONDS = 1.0


class ResolveBody(BaseModel):
    category: str
    confirmed: bool = False


class GrantStore:
    def put(self, key: str, grant: dict) -> None:
        """Write the audit row for an auto-resolve."""
        raise NotImplementedError


audit = GrantStore()


def record_grant(tenant: str, item_id: str, category: str, grant_id: str) -> None:
    audit.put(
        f"{tenant}:{item_id}",
        {"category": category, "grant_id": grant_id, "auto": True},
    )


def auto_resolve(tenant: str, item_id: str, category: str) -> dict:
    if category not in SAFE_CATEGORIES:
        return {"action": "escalate", "reason": "category requires a human"}
    request = ResolveRequest(tenant=tenant, item_id=item_id, category=category)
    try:
        response = stub.AutoResolve(request, timeout=ENFORCEMENT_DEADLINE_SECONDS)
    except grpc.RpcError as exc:
        code = exc.code()
        if code == grpc.StatusCode.DEADLINE_EXCEEDED:
            return {"action": "escalate", "reason": "enforcement timed out"}
        if code == grpc.StatusCode.PERMISSION_DENIED:
            return {"action": "escalate", "reason": "policy rejected the auto-resolve"}
        return {"action": "escalate", "reason": "enforcement unavailable"}
    record_grant(tenant, item_id, category, response.grant_id)
    return {"action": "auto_resolve", "grant_id": response.grant_id}


@app.post("/v1/review/items/{item_id}/resolve")
def resolve(
    item_id: str,
    body: ResolveBody,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    if body.category in SAFE_CATEGORIES:
        outcome = auto_resolve(tenant, item_id, body.category)
        if outcome["action"] == "escalate":
            return JSONResponse(
                {"item_id": item_id, "outcome": "escalated", "reason": outcome["reason"]},
                status_code=202,
            )
        return JSONResponse(
            {"item_id": item_id, "outcome": "auto_resolved", "grant_id": outcome["grant_id"]}
        )
    if not body.confirmed:
        return JSONResponse(
            {"item_id": item_id, "outcome": "needs_confirmation", "category": body.category},
            status_code=409,
        )
    return JSONResponse({"item_id": item_id, "outcome": "reviewer_resolved", "category": body.category})
`,
    },
    typescript: {
      starter: `/** POST /v1/review/items/{id}/resolve: a model-generated draft that resolves on a timeout. */
import Fastify from 'fastify';
import {status} from '@grpc/grpc-js';

export const app = Fastify();

const CONFIDENCE_THRESHOLD = 0.5;

interface ResolveBody {
  category: string;
  confidence?: number;
  confirmed?: boolean;
}

app.post('/v1/review/items/:item_id/resolve', async (request, reply) => {
  // TODO: this draft auto-resolves any category above 0.5 confidence when the enforcement call
  // times out, and it retries a policy rejection, so one category gets hammered. Review both.
  const body = request.body as ResolveBody;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await callEnforcement(body.category).catch(() => null);
    if (response !== null)
      return reply.code(200).send({item_id: 'item', outcome: 'auto_resolved', grant_id: response.grantId});
    if ((body.confidence ?? 0) > CONFIDENCE_THRESHOLD)
      return reply.code(200).send({item_id: 'item', outcome: 'auto_resolved', grant_id: 'implicit'});
  }
  return reply.code(200).send({item_id: 'item', outcome: 'auto_resolved', grant_id: 'fallback'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/review/items/{id}/resolve: a narrow, granted auto-resolve class. */
import Fastify from 'fastify';
import {status} from '@grpc/grpc-js';

export const app = Fastify();

const SAFE_CATEGORIES = new Set(['spam_duplicate', 'known_safe_false_positive']);
const ENFORCEMENT_DEADLINE_MS = 1000;

interface ResolveBody {
  category: string;
  confirmed?: boolean;
}

const grants: Record<string, unknown> = {};

function recordGrant(tenant: string, itemId: string, category: string, grantId: string): void {
  const key = tenant + ':' + itemId;
  grants[key] = {category, grant_id: grantId, auto: true};
}

interface EnforcementResponse {
  grantId: string;
}

function callEnforcement(request: unknown, deadline: Date): Promise<EnforcementResponse> {
  const {promise, resolve, reject} = Promise.withResolvers<EnforcementResponse>();
  enforcementClient.autoResolve(request, {deadline: deadline}, (error, response) =>
    error ? reject(error) : resolve(response),
  );
  return promise;
}

async function autoResolve(tenant: string, itemId: string, category: string): Promise<Record<string, string>> {
  if (!SAFE_CATEGORIES.has(category)) return {action: 'escalate', reason: 'category requires a human'};
  const deadline = new Date(Date.now() + ENFORCEMENT_DEADLINE_MS);
  let response: EnforcementResponse;
  try {
    response = await callEnforcement({tenant, item_id: itemId, category}, deadline);
  } catch (error) {
    const code = (error as {code?: number}).code;
    if (code === status.DEADLINE_EXCEEDED) return {action: 'escalate', reason: 'enforcement timed out'};
    if (code === status.PERMISSION_DENIED) return {action: 'escalate', reason: 'policy rejected the auto-resolve'};
    return {action: 'escalate', reason: 'enforcement unavailable'};
  }
  recordGrant(tenant, itemId, category, response.grantId);
  return {action: 'auto_resolve', grant_id: response.grantId};
}

app.post('/v1/review/items/:item_id/resolve', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as ResolveBody;
  const itemId = request.params['item_id'];
  if (SAFE_CATEGORIES.has(body.category)) {
    const outcome = await autoResolve(tenant, itemId, body.category);
    if (outcome.action === 'escalate') return reply.code(202).send({item_id: itemId, outcome: 'escalated', reason: outcome.reason});
    return reply.code(200).send({item_id: itemId, outcome: 'auto_resolved', grant_id: outcome.grant_id});
  }
  if (body.confirmed !== true) return reply.code(409).send({item_id: itemId, outcome: 'needs_confirmation'});
  return reply.code(200).send({item_id: itemId, outcome: 'reviewer_resolved', category: body.category});
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

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const confidenceThreshold = 0.5

type ResolveBody struct {
	Category   string  \`json:"category"\`
	Confidence float64 \`json:"confidence"\`
	Confirmed  bool    \`json:"confirmed"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func resolve(rw http.ResponseWriter, r *http.Request) {
	var body ResolveBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this draft auto-resolves any category above 0.5 confidence when the enforcement call
	// times out, and it retries a policy rejection, so one category gets hammered. Review both.
	for attempt := 0; attempt < 3; attempt++ {
		resp, err := enforcementClient.AutoResolve(context.Background(), &ResolveRequest{Category: body.Category})
		if err == nil {
			writeJSON(rw, http.StatusOK, map[string]any{"outcome": "auto_resolved", "grant_id": resp.GrantID})
			return
		}
		if status.Code(err) == codes.DeadlineExceeded && body.Confidence > confidenceThreshold {
			writeJSON(rw, http.StatusOK, map[string]any{"outcome": "auto_resolved", "grant_id": "implicit"})
			return
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"outcome": "auto_resolved", "grant_id": "fallback"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/review/items/{item_id}/resolve", resolve)
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

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const enforcementDeadline = time.Second

var safeCategories = map[string]bool{"spam_duplicate": true, "known_safe_false_positive": true}

type ResolveBody struct {
	Category  string \`json:"category"\`
	Confirmed bool   \`json:"confirmed"\`
}

func writeJSON(rw http.ResponseWriter, code int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(code)
	json.NewEncoder(rw).Encode(body)
}

func recordGrant(tenant, itemID, category, grantID string) {
	audit.Put(tenant+":"+itemID, map[string]any{"category": category, "grant_id": grantID, "auto": true})
}

func autoResolve(ctx context.Context, tenant, itemID, category string) map[string]any {
	if _, ok := safeCategories[category]; !ok {
		return map[string]any{"action": "escalate", "reason": "category requires a human"}
	}
	ctx, cancel := context.WithTimeout(ctx, enforcementDeadline)
	defer cancel()
	resp, err := enforcementClient.AutoResolve(ctx, &ResolveRequest{Tenant: tenant, ItemID: itemID, Category: category})
	if err != nil {
		switch status.Code(err) {
		case codes.DeadlineExceeded:
			return map[string]any{"action": "escalate", "reason": "enforcement timed out"}
		case codes.PermissionDenied:
			return map[string]any{"action": "escalate", "reason": "policy rejected the auto-resolve"}
		default:
			return map[string]any{"action": "escalate", "reason": "enforcement unavailable"}
		}
	}
	recordGrant(tenant, itemID, category, resp.GrantID)
	return map[string]any{"action": "auto_resolve", "grant_id": resp.GrantID}
}

func resolve(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body ResolveBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	itemID := r.PathValue("item_id")
	if _, ok := safeCategories[body.Category]; ok {
		outcome := autoResolve(r.Context(), tenant, itemID, body.Category)
		if outcome["action"] == "escalate" {
			writeJSON(rw, http.StatusAccepted, map[string]any{"item_id": itemID, "outcome": "escalated", "reason": outcome["reason"]})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"item_id": itemID, "outcome": "auto_resolved", "grant_id": outcome["grant_id"]})
		return
	}
	if !body.Confirmed {
		writeJSON(rw, http.StatusConflict, map[string]any{"item_id": itemID, "outcome": "needs_confirmation"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"item_id": itemID, "outcome": "reviewer_resolved", "category": body.Category})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/review/items/{item_id}/resolve", resolve)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

import scala.concurrent.Future

case class ResolveBody(category: String, confidence: Double, confirmed: Boolean)

object Client {
  val ConfidenceThreshold: Double = 0.5

  def resolve(tenant: String, itemId: String, category: String, confidence: Double): Future[String] = {
    // TODO: this draft auto-resolves any category above 0.5 confidence when the enforcement call
    // times out, and it retries a policy rejection, so one category gets hammered. Review both.
    for (attempt <- 1 to 3) {
      try {
        val resp = enforcement.autoResolve(tenant, itemId, category)
        return Future.successful(resp.grantId)
      } catch {
        case _: Exception if confidence > ConfidenceThreshold => return Future.successful("implicit")
      }
    }
    Future.successful("fallback")
  }
}

object Api {
  def route: Route =
    path("v1" / "review" / "items" / Segment / "resolve") { itemId =>
      post {
        entity(as[ResolveBody]) { body =>
          headerValueByName("X-Tenant-Id") { tenant =>
            onSuccess(Client.resolve(tenant, itemId, body.category, body.confidence)) { grantId =>
              complete(StatusCodes.OK, s"""{"outcome":"auto_resolved","grant_id":"$grantId"}""")
            }
          }
        }
      }
    }
}
`,
      solution: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

import scala.concurrent.Future
import scala.util.{Failure, Success}

case class ResolveBody(category: String, confirmed: Boolean)

object EnforcementStatus {
  val DeadlineExceeded: String = "DEADLINE_EXCEEDED"
  val PermissionDenied: String = "PERMISSION_DENIED"
}

object Client {
  val SafeCategories: Set[String] = Set("spam_duplicate", "known_safe_false_positive")
  val EnforcementDeadlineMs: Long = 1000

  def recordGrant(tenant: String, itemId: String, category: String, grantId: String): Unit = {
    audit.put(s"$tenant:$itemId", Map("category" -> category, "grant_id" -> grantId, "auto" -> true))
  }

  def autoResolve(tenant: String, itemId: String, category: String): Future[Map[String, String]] = {
    if (!SafeCategories.contains(category))
      Future.successful(Map("action" -> "escalate", "reason" -> "category requires a human"))
    else {
      val deadline = System.currentTimeMillis() + EnforcementDeadlineMs
      enforcement
        .withDeadline(deadline)
        .autoResolve(tenant, itemId, category)
        .map { resp =>
          recordGrant(tenant, itemId, category, resp.grantId)
          Map("action" -> "auto_resolve", "grant_id" -> resp.grantId)
        }
        .recover {
          case e if e.getMessage == EnforcementStatus.DeadlineExceeded =>
            Map("action" -> "escalate", "reason" -> "enforcement timed out")
          case e if e.getMessage == EnforcementStatus.PermissionDenied =>
            Map("action" -> "escalate", "reason" -> "policy rejected the auto-resolve")
          case _ =>
            Map("action" -> "escalate", "reason" -> "enforcement unavailable")
        }
    }
  }
}

object Api {
  def route: Route =
    path("v1" / "review" / "items" / Segment / "resolve") { itemId =>
      post {
        entity(as[ResolveBody]) { body =>
          headerValueByName("X-Tenant-Id") { tenant =>
            if (Client.SafeCategories.contains(body.category)) {
              onSuccess(Client.autoResolve(tenant, itemId, body.category)) { outcome =>
                if (outcome("action") == "escalate")
                  complete(StatusCodes.Accepted, s"""{"outcome":"escalated","reason":"\${outcome("reason")}"}""")
                else
                  complete(StatusCodes.OK, s"""{"outcome":"auto_resolved","grant_id":"\${outcome("grant_id")}"}""")
              }
            } else if (!body.confirmed) {
              complete(StatusCodes.Conflict, """{"outcome":"needs_confirmation"}""")
            } else {
              complete(StatusCodes.OK, s"""{"outcome":"reviewer_resolved","category":"\${body.category}"}""")
            }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <string>
#include <chrono>
#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

const double kConfidenceThreshold = 0.5;

int main() {
  httplib::Server svr;
  svr.Post("/v1/review/items/([^/]+)/resolve", [](const httplib::Request& req, httplib::Response& res) {
    auto body = json::parse(req.body);
    // TODO: this draft auto-resolves any category above 0.5 confidence when the enforcement call
    // times out, and it retries a policy rejection, so one category gets hammered. Review both.
    for (int attempt = 0; attempt < 3; ++attempt) {
      grpc::ClientContext context;
      AutoResolveResponse response;
      auto st = enforcement->AutoResolve(&context, request, &response);
      if (st.ok()) {
        res.status = 200;
        res.set_content(json{{"outcome", "auto_resolved"}, {"grant_id", response.grant_id()}}.dump(), "application/json");
        return;
      }
      if (st.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED && body["confidence"].get<double>() > kConfidenceThreshold) {
        res.status = 200;
        res.set_content(R"({"outcome":"auto_resolved","grant_id":"implicit"})", "application/json");
        return;
      }
    }
    res.status = 200;
    res.set_content(R"({"outcome":"auto_resolved","grant_id":"fallback"})", "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <string>
#include <chrono>
#include <map>
#include <set>
#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

const int kEnforcementDeadlineMs = 1000;
const std::set<std::string> kSafeCategories = {"spam_duplicate", "known_safe_false_positive"};

void recordGrant(const std::string& tenant, const std::string& item_id, const std::string& category, const std::string& grant_id) {
  audit.put(tenant + ":" + item_id, json{{"category", category}, {"grant_id", grant_id}, {"auto", true}});
}

json autoResolve(const std::string& tenant, const std::string& item_id, const std::string& category) {
  if (kSafeCategories.count(category) == 0)
    return json{{"action", "escalate"}, {"reason", "category requires a human"}};

  grpc::ClientContext context;
  context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kEnforcementDeadlineMs));
  AutoResolveResponse response;
  auto st = enforcement->AutoResolve(&context, request, &response);
  if (!st.ok()) {
    if (st.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED)
      return json{{"action", "escalate"}, {"reason", "enforcement timed out"}};
    if (st.error_code() == grpc::StatusCode::PERMISSION_DENIED)
      return json{{"action", "escalate"}, {"reason", "policy rejected the auto-resolve"}};
    return json{{"action", "escalate"}, {"reason", "enforcement unavailable"}};
  }
  recordGrant(tenant, item_id, category, response.grant_id());
  return json{{"action", "auto_resolve"}, {"grant_id", response.grant_id()}};
}

int main() {
  httplib::Server svr;
  svr.Post("/v1/review/items/([^/]+)/resolve", [](const httplib::Request& req, httplib::Response& res) {
    auto body = json::parse(req.body);
    auto category = body["category"].get<std::string>();
    if (kSafeCategories.count(category) > 0) {
      auto outcome = autoResolve(req.get_header_value("X-Tenant-Id"), "item", category);
      if (outcome["action"] == "escalate") {
        res.status = 202;
        res.set_content(outcome.dump(), "application/json");
        return;
      }
      res.status = 200;
      res.set_content(outcome.dump(), "application/json");
      return;
    }
    if (body["confirmed"].get<bool>() != true) {
      res.status = 409;
      res.set_content(R"({"outcome":"needs_confirmation"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"outcome", "reviewer_resolved"}, {"category", category}}.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The safe class is a *set of categories*, not a confidence score. Gate auto-resolve on `SAFE_CATEGORIES` and send everything else to a human with a `needs_confirmation` response.',
    'A deadline is what stops an enforcement outage from becoming a review outage. Pass the 1-second deadline on the RPC, and treat `DEADLINE_EXCEEDED` as "escalate to a human" — a timeout is not approval.',
    'A policy rejection is an answer, not a transient error. Handle `PERMISSION_DENIED` once, escalate, and never retry it — and only auto-resolve after the enforcement service returned a grant you recorded.',
  ],
  debrief: `The interviewer is testing whether you can review a generated dependency call at the most dangerous seam in an AI platform: the place where the system decides an item does not need a human. Three defects are being checked. First, the class: auto-resolution must be gated on a named safe set — spam duplicates and known-safe false positives — never on a confidence threshold, because confidence measures the model's self-assessment, not whether a category is safe to clear unattended. Second, the timeout: a 1-second deadline keeps a reviewer's request bounded, and a timeout must escalate, because treating a timeout as approval turns an enforcement outage into a silent self-approval loop. Third, the rejection: PERMISSION_DENIED is terminal — retrying it hammers the policy that already said no. The subtle point candidates miss is the grant: without a recorded grant id, an auto-resolve months later cannot be explained to an auditor. Real platforms add per-tenant safe-category overrides, a circuit breaker around enforcement, and a hard cap on how many items may auto-resolve per minute.`,
};
