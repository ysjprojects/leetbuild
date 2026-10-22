import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Handler calls with submission-id idempotency',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'handlers', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: every handler answers on the first attempt in the
demo, so the submission looks delivered. The retry path hides two flaws that only appear when a
handler is slow or down. Review it, fix it, and prove the fix.

Implement the delivery fan-out that runs after a submission is accepted. Each accepted submission is
handed to three downstream handlers — \`webhook\`, \`crm\`, \`queue\` — over gRPC:

- Every call carries the submission id as the **idempotency key**, and the key for one
  \`(submission, handler)\` pair is **stable across retries**. A retry that mints a fresh key lets a
  CRM create a second lead for the same submission.
- Every call runs under a **3-second deadline**. A handler that hangs must not hold the request
  open; the deadline ends the attempt and the outcome is recorded as failed.
- The response records **per-handler outcomes** — which handler succeeded and which failed — rather
  than one aggregate flag. The draft sets \`delivered\` as soon as the first handler succeeds, so a
  submission where two of three handlers failed still reads as delivered.
- The submission is **partial** when some handlers failed and all of them succeeded otherwise. A
  partially delivered submission must be **replayable per handler**: re-running the failed handlers
  re-invokes only those, under the same keys, and never re-invokes a handler that already succeeded.

**Failure mode the checks target.** A fresh idempotency key per attempt turns at-least-once delivery
into duplicate records downstream; a single \`delivered\` flag hides which handlers still need a
replay, so the retry job either re-runs everything — double-charging the handlers that worked — or
gives up on the ones that failed.`,
  sequence: {
    participants: ['Form API', 'Handler client', 'Webhook', 'CRM'],
    messages: [
      {from: 'Form API', to: 'Handler client', label: 'Deliver(webhook) · key sub_123:webhook · 3s', kind: 'sync'},
      {from: 'Handler client', to: 'Webhook', label: 'Deliver(sub_123) with idempotency-key', kind: 'sync'},
      {from: 'Webhook', to: 'Handler client', label: 'ok', kind: 'reply'},
      {from: 'Handler client', to: 'Form API', label: 'outcome webhook=succeeded', kind: 'reply'},
      {from: 'Form API', to: 'Handler client', label: 'Deliver(crm) · key sub_123:crm · 3s', kind: 'sync'},
      {from: 'Handler client', to: 'CRM', label: 'Deliver(sub_123) with idempotency-key', kind: 'sync'},
      {from: 'CRM', to: 'Handler client', label: 'UNAVAILABLE after the deadline', kind: 'reply'},
      {
        from: 'Handler client',
        to: 'Form API',
        label: 'outcomes {webhook: succeeded, crm: failed} → status partial',
        kind: 'reply',
      },
      {
        from: 'Form API',
        to: 'Handler client',
        label: 'replay failed only — same keys, webhook untouched',
        kind: 'async',
      },
    ],
  },
  hints: [
    'An idempotency key is a promise to the downstream service: "this is the same logical operation". Derive it from the submission id and the handler name, not from the attempt, so the retry sends the key the CRM already saw. A random key per attempt is indistinguishable from a brand-new submission.',
    'Do not collapse three calls into one flag. Keep an outcome per handler and derive the submission status from them — `delivered` only when every handler succeeded, `partial` when some failed. The replay job then has a list of which handlers to retry.',
    'The replay must skip handlers that already succeeded. Filter on the recorded outcome and call only the failures, under their original keys; the succeeded handlers are never called again.',
  ],
  checks: [
    {
      id: 'stable-key',
      title: 'Invokes each handler under one stable idempotency key',
      detail:
        'The key for a `(submission, handler)` pair is derived from the submission id and reused on every retry. The draft mints a fresh key per attempt, so downstream systems create duplicate records.',
      match: {
        python: {all: [/"idempotency-key"/, /submission_id/], none: [/uuid/]},
        typescript: {all: [/'idempotency-key'/, /submissionId/], none: [/randomUUID/]},
        go: {all: [/"idempotency-key"/, /submissionID/], none: [/uuid\./]},
        scala: {all: [/"idempotency-key"/, /submissionId/], none: [/UUID/]},
        cpp: {all: [/"idempotency-key"/, /submissionId/], none: [/FreshIdempotencyKey/]},
      },
    },
    {
      id: 'per-handler-outcomes',
      title: 'Records an outcome per handler',
      detail:
        'The response carries one outcome per handler (`HandlerOutcome`), not a single delivered flag. The draft reports delivered as soon as the first handler succeeds.',
      match: {
        python: {all: [/HandlerOutcome/, /outcomes/]},
        typescript: {all: [/HandlerOutcome/, /outcomes/]},
        go: {all: [/HandlerOutcome/, /outcomes/]},
        scala: {all: [/HandlerOutcome/, /outcomes/]},
        cpp: {all: [/HandlerOutcome/, /outcomes/]},
      },
    },
    {
      id: 'partial-status',
      title: 'Marks a submission partial when a handler failed',
      detail:
        'A submission where some handlers failed is reported as `partial`; only an all-succeeded fan-out is `delivered`. The draft always reports delivered.',
      match: {
        python: {all: [/"partial"/]},
        typescript: {all: [/'partial'/]},
        go: {all: [/"partial"/]},
        scala: {all: [/"partial"/]},
        cpp: {all: [/"partial"/]},
      },
    },
    {
      id: 'deadline',
      title: 'Runs every handler call under a 3-second deadline',
      detail:
        'Each gRPC call carries a 3-second deadline, so a hung handler cannot hold the request open. The draft calls with no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S/]},
        typescript: {all: [/DEADLINE_S/]},
        go: {all: [/deadlineSeconds/]},
        scala: {all: [/DeadlineSeconds/]},
        cpp: {all: [/kDeadlineSeconds/]},
      },
    },
    {
      id: 'replay-failed-only',
      title: 'Replays only the failed handlers',
      detail:
        'A replay re-invokes the handlers whose recorded outcome is not `succeeded`, under their original keys, and leaves the succeeded ones alone.',
      match: {
        python: {all: [/replay_failed/, /succeeded/]},
        typescript: {all: [/replayFailed/, /succeeded/]},
        go: {all: [/replayFailed/, /succeeded/]},
        scala: {all: [/replayFailed/, /succeeded/]},
        cpp: {all: [/ReplayFailed/, /succeeded/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc

import handlers_pb2
import handlers_pb2_grpc
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

HANDLERS = ["webhook", "crm", "queue"]

channel = grpc.insecure_channel("handlers:9000")
handlers = handlers_pb2_grpc.HandlerStub(channel)

submissions = {}


class Submission(BaseModel):
    submission_id: str


def deliver(submission_id: str, handler: str) -> bool:
    # TODO: this draft retries each handler with a fresh idempotency key, so a CRM that retries
    # gets two leads, and it marks the submission delivered as soon as the first handler succeeds
    # even when the others failed — there is no per-handler outcome and no replay of just the
    # failed ones.
    for _ in range(3):
        key = str(uuid.uuid4())
        request = handlers_pb2.DeliverRequest(submission_id=submission_id)
        try:
            handlers.Deliver(request, metadata=(("idempotency-key", key),))
            return True
        except grpc.RpcError:
            continue
    return False


@app.post("/v1/submissions/{submission_id}/deliver")
def deliver_all(submission_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    for handler in HANDLERS:
        deliver(submission_id, handler)
    submissions[submission_id] = "delivered"
    return {"submission_id": submission_id, "status": "delivered"}
`,
      solution: `import grpc

import handlers_pb2
import handlers_pb2_grpc
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

DEADLINE_S = 3
HANDLERS = ["webhook", "crm", "queue"]

channel = grpc.insecure_channel("handlers:9000")
handlers = handlers_pb2_grpc.HandlerStub(channel)

submissions = {}


class Submission(BaseModel):
    submission_id: str


class HandlerOutcome(BaseModel):
    handler: str
    status: str
    detail: str = ""


def handler_key(submission_id: str, handler: str) -> str:
    return f"{submission_id}:{handler}"


def deliver(submission_id: str, handler: str) -> HandlerOutcome:
    key = handler_key(submission_id, handler)
    request = handlers_pb2.DeliverRequest(submission_id=submission_id)
    try:
        handlers.Deliver(request, timeout=DEADLINE_S, metadata=(("idempotency-key", key),))
        return HandlerOutcome(handler=handler, status="succeeded")
    except grpc.RpcError as error:
        return HandlerOutcome(handler=handler, status="failed", detail=str(error.code()))


def replay_failed(submission_id: str, outcomes: list[HandlerOutcome]) -> list[HandlerOutcome]:
    replayed = []
    for outcome in outcomes:
        if outcome.status == "succeeded":
            continue
        replayed.append(deliver(submission_id, outcome.handler))
    return replayed


@app.post("/v1/submissions/{submission_id}/deliver")
def deliver_all(submission_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    outcomes = [deliver(submission_id, handler) for handler in HANDLERS]
    failed = [outcome.handler for outcome in outcomes if outcome.status != "succeeded"]
    status = "delivered" if not failed else "partial"
    submissions[submission_id] = status
    return {
        "submission_id": submission_id,
        "status": status,
        "outcomes": [outcome.model_dump() for outcome in outcomes],
    }
`,
    },
    typescript: {
      starter: `/** Delivery fan-out to downstream handlers — a model-generated draft. */
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import * as grpc from '@grpc/grpc-js';
import Fastify from 'fastify';

import {HandlersClient} from './handlers_grpc_pb';

export const app = Fastify();

const HANDLERS = ['webhook', 'crm', 'queue'] as const;

const client = new HandlersClient('handlers:9000', grpc.credentials.createInsecure());
const deliverCall = promisify(client.deliver.bind(client)) as (
  request: {submissionId: string},
  metadata: grpc.Metadata,
  options: object
) => Promise<unknown>;
const submissions: Record<string, string> = {};

async function deliver(submissionId: string, handler: string): Promise<boolean> {
  // TODO: this draft retries each handler with a fresh idempotency key, so a CRM that retries gets
  // two leads, and it marks the submission delivered as soon as the first handler succeeds even
  // when the others failed — there is no per-handler outcome and no replay of just the failed ones.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const key = randomUUID();
    try {
      await deliverCall({submissionId}, new grpc.Metadata().set('idempotency-key', key), {});
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

app.post('/v1/submissions/:id/deliver', async (req, reply) => {
  const {id} = req.params as {id: string};
  for (const handler of HANDLERS) await deliver(id, handler);
  submissions[id] = 'delivered';
  return reply.send({submissionId: id, status: 'delivered'});
});
`,
      solution: `/** Delivery fan-out to downstream handlers — one stable key per (submission, handler). */
import * as grpc from '@grpc/grpc-js';
import Fastify from 'fastify';

import {HandlersClient} from './handlers_grpc_pb';

export const app = Fastify();

const DEADLINE_S = 3;
const HANDLERS = ['webhook', 'crm', 'queue'] as const;

const client = new HandlersClient('handlers:9000', grpc.credentials.createInsecure());
const submissions: Record<string, string> = {};

interface HandlerOutcome {
  handler: string;
  status: string;
  detail?: string;
}

function handlerKey(submissionId: string, handler: string): string {
  return submissionId + ':' + handler;
}

async function deliver(submissionId: string, handler: string): Promise<HandlerOutcome> {
  const key = handlerKey(submissionId, handler);
  try {
    await deliverCall(
      {submissionId},
      new grpc.Metadata().set('idempotency-key', key),
      {deadline: new Date(Date.now() + DEADLINE_S * 1000)}
    );
    return {handler, status: 'succeeded'};
  } catch (error) {
    return {handler, status: 'failed', detail: (error as Error).message};
  }
}

async function replayFailed(submissionId: string, outcomes: HandlerOutcome[]): Promise<HandlerOutcome[]> {
  const replayed: HandlerOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'succeeded') continue;
    replayed.push(await deliver(submissionId, outcome.handler));
  }
  return replayed;
}

app.post('/v1/submissions/:id/deliver', async (req, reply) => {
  const {id} = req.params as {id: string};
  const outcomes = await Promise.all(HANDLERS.map(handler => deliver(id, handler)));
  const failed = outcomes.filter(outcome => outcome.status !== 'succeeded');
  const status = failed.length === 0 ? 'delivered' : 'partial';
  submissions[id] = status;
  return reply.send({submissionId: id, status, outcomes});
});
`,
    },
    go: {
      starter: `package formapi

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

var handlers = []string{"webhook", "crm", "queue"}

func deliver(ctx context.Context, conn *grpc.ClientConn, submissionID, handler string) bool {
	// TODO: this draft retries each handler with a fresh idempotency key, so a CRM that retries gets
	// two leads, and it marks the submission delivered as soon as the first handler succeeds even
	// when the others failed — there is no per-handler outcome and no replay of just the failed ones.
	client := handlerspb.NewHandlerClient(conn)
	for attempt := 0; attempt < 3; attempt++ {
		key := uuid.NewString()
		md := metadata.Pairs("idempotency-key", key)
		callCtx := metadata.NewOutgoingContext(ctx, md)
		if _, err := client.Deliver(callCtx, &handlerspb.DeliverRequest{SubmissionId: submissionID}); err == nil {
			return true
		}
	}
	return false
}

func DeliverAll(w http.ResponseWriter, r *http.Request) {
	for _, handler := range handlers {
		deliver(r.Context(), conn, r.PathValue("id"), handler)
	}
	w.WriteHeader(http.StatusOK)
}
`,
      solution:
        `package formapi

import (
	"context"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

const deadlineSeconds = 3

var handlers = []string{"webhook", "crm", "queue"}

// HandlerOutcome records what one handler did for this submission.
type HandlerOutcome struct {
	Handler string ` +
        '`' +
        `json:"handler"` +
        '`' +
        `
	Status  string ` +
        '`' +
        `json:"status"` +
        '`' +
        `
	Detail  string ` +
        '`' +
        `json:"detail,omitempty"` +
        '`' +
        `
}

func handlerKey(submissionID, handler string) string {
	return submissionID + ":" + handler
}

func deliver(ctx context.Context, conn *grpc.ClientConn, submissionID, handler string) HandlerOutcome {
	client := handlerspb.NewHandlerClient(conn)
	md := metadata.Pairs("idempotency-key", handlerKey(submissionID, handler))
	callCtx, cancel := context.WithTimeout(metadata.NewOutgoingContext(ctx, md), deadlineSeconds*time.Second)
	defer cancel()
	if _, err := client.Deliver(callCtx, &handlerspb.DeliverRequest{SubmissionId: submissionID}); err != nil {
		return HandlerOutcome{Handler: handler, Status: "failed", Detail: err.Error()}
	}
	return HandlerOutcome{Handler: handler, Status: "succeeded"}
}

func replayFailed(ctx context.Context, conn *grpc.ClientConn, submissionID string, outcomes []HandlerOutcome) []HandlerOutcome {
	replayed := make([]HandlerOutcome, 0, len(outcomes))
	for _, outcome := range outcomes {
		if outcome.Status == "succeeded" {
			continue
		}
		replayed = append(replayed, deliver(ctx, conn, submissionID, outcome.Handler))
	}
	return replayed
}

func DeliverAll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	submissionID := r.PathValue("id")
	outcomes := make([]HandlerOutcome, 0, len(handlers))
	for _, handler := range handlers {
		outcomes = append(outcomes, deliver(ctx, conn, submissionID, handler))
	}
	status := "delivered"
	for _, outcome := range outcomes {
		if outcome.Status != "succeeded" {
			status = "partial"
			break
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"submissionId": submissionID,
		"status":       status,
		"outcomes":     outcomes,
	})
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._

import java.util.UUID
import scala.concurrent.Future

object Client {
  val Handlers = Seq("webhook", "crm", "queue")

  def deliver(submissionId: String, handler: String): Future[Boolean] = {
    // TODO: this draft retries each handler with a fresh idempotency key, so a CRM that retries gets
    // two leads, and it marks the submission delivered as soon as the first handler succeeds even
    // when the others failed — there is no per-handler outcome and no replay of just the failed ones.
    val key = UUID.randomUUID().toString
    HandlerClient.deliver(submissionId, metadata = Map("idempotency-key" -> key)).map(_ => true)
  }

  val routes: Route = path("v1" / "submissions" / Segment / "deliver") { submissionId =>
    post {
      complete(s"""{"submissionId":"$submissionId","status":"delivered"}""")
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._

import scala.concurrent.Future
import scala.concurrent.duration._

object Client {
  val DeadlineSeconds = 3
  val Handlers = Seq("webhook", "crm", "queue")

  final case class HandlerOutcome(handler: String, status: String, detail: String = "")

  def handlerKey(submissionId: String, handler: String): String = submissionId + ":" + handler

  def deliver(submissionId: String, handler: String): Future[HandlerOutcome] = {
    val key = handlerKey(submissionId, handler)
    HandlerClient
      .deliver(submissionId, metadata = Map("idempotency-key" -> key), deadline = DeadlineSeconds.seconds)
      .map(_ => HandlerOutcome(handler, "succeeded"))
      .recover { case error => HandlerOutcome(handler, "failed", error.getMessage) }
  }

  def replayFailed(submissionId: String, outcomes: Seq[HandlerOutcome]): Future[Seq[HandlerOutcome]] =
    Future
      .traverse(outcomes.filterNot(_.status == "succeeded"))(outcome => deliver(submissionId, outcome.handler))

  val routes: Route = path("v1" / "submissions" / Segment / "deliver") { submissionId =>
    post {
      onSuccess(Future.traverse(Handlers)(handler => deliver(submissionId, handler))) { outcomes =>
        val failed = outcomes.filterNot(_.status == "succeeded")
        val status = if (failed.isEmpty) "delivered" else "partial"
        val rendered = outcomes.map(o => s"""{"handler":"\${o.handler}","status":"\${o.status}"}""").mkString(",")
        complete(StatusCodes.OK -> s"""{"submissionId":"$submissionId","status":"$status","outcomes":[$rendered]}""")
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>

#include <memory>
#include <random>
#include <string>

std::string FreshIdempotencyKey() {
  static std::mt19937_64 rng{std::random_device{}()};
  return std::to_string(rng());
}

bool DeliverOne(HandlerClient& client, const std::string& submissionId, const std::string& handler) {
  // TODO: this draft retries each handler with a fresh idempotency key, so a CRM that retries gets
  // two leads, and it marks the submission delivered as soon as the first handler succeeds even
  // when the others failed — there is no per-handler outcome and no replay of just the failed ones.
  for (int attempt = 0; attempt < 3; ++attempt) {
    grpc::ClientContext ctx;
    ctx.AddMetadata("idempotency-key", FreshIdempotencyKey());
    DeliverRequest request;
    request.set_submission_id(submissionId);
    DeliverReply reply;
    if (client.Deliver(&ctx, request, &reply).ok()) return true;
  }
  return false;
}

void RegisterRoutes(httplib::Server& svr, HandlerClient& client) {
  svr.Post("/v1/submissions/([^/]+)/deliver", [&](const httplib::Request& req, httplib::Response& res) {
    for (const std::string handler : {"webhook", "crm", "queue"}) {
      DeliverOne(client, req.matches[1], handler);
    }
    res.status = 200;
    res.set_content(R"({"status":"delivered"})", "application/json");
  });
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>

#include <chrono>
#include <string>
#include <vector>

static const int kDeadlineSeconds = 3;

struct HandlerOutcome {
  std::string handler;
  std::string status;
  std::string detail;
};

static std::string HandlerKey(const std::string& submissionId, const std::string& handler) {
  return submissionId + ":" + handler;
}

static HandlerOutcome DeliverOne(HandlerClient& client, const std::string& submissionId, const std::string& handler) {
  grpc::ClientContext ctx;
  ctx.AddMetadata("idempotency-key", HandlerKey(submissionId, handler));
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
  DeliverRequest request;
  request.set_submission_id(submissionId);
  DeliverReply reply;
  const grpc::Status status = client.Deliver(&ctx, request, &reply);
  if (status.ok()) return {handler, "succeeded", ""};
  return {handler, "failed", status.error_message()};
}

static std::vector<HandlerOutcome> ReplayFailed(
    HandlerClient& client, const std::string& submissionId, const std::vector<HandlerOutcome>& outcomes) {
  std::vector<HandlerOutcome> replayed;
  for (const HandlerOutcome& outcome : outcomes) {
    if (outcome.status == "succeeded") continue;
    replayed.push_back(DeliverOne(client, submissionId, outcome.handler));
  }
  return replayed;
}

void RegisterRoutes(httplib::Server& svr, HandlerClient& client) {
  svr.Post("/v1/submissions/([^/]+)/deliver", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string submissionId = req.matches[1];
    std::vector<HandlerOutcome> outcomes;
    for (const std::string handler : {"webhook", "crm", "queue"}) {
      outcomes.push_back(DeliverOne(client, submissionId, handler));
    }
    bool anyFailed = false;
    for (const HandlerOutcome& outcome : outcomes) {
      if (outcome.status != "succeeded") anyFailed = true;
    }
    const std::string status = anyFailed ? "partial" : "delivered";
    res.status = 200;
    res.set_content(R"({"submissionId":")" + submissionId + R"(","status":")" + status + R"("})", "application/json");
  });
}
`,
    },
  },
  debrief: `The interviewer is testing whether you know what an idempotency key is for. It exists so that a retry is not a second operation: the key for one \`(submission, handler)\` pair must be the same on every attempt, so the CRM recognises the replay instead of creating a second lead. The second flaw is aggregation — a single \`delivered\` flag destroys the information the retry job needs. Recording an outcome per handler makes partial delivery visible and lets the replay re-invoke only the failures, under their original keys, so a handler that already succeeded is never called twice. The 3-second deadline is what keeps a hung webhook from holding the request open and blocking the retry that would otherwise never start. Real systems add per-handler backoff and jitter, a durable outcome table so a replay survives a process restart, and a dead-letter path for a handler that keeps failing.`,
};
