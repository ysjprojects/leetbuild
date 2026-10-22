import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Eligibility calls that deny when they cannot verify',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'eligibility', 'hr'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the eligibility service
answers, the decision is recorded and the demo approves a request. Every answer that is not a clean
yes is treated as a yes anyway. Review it, fix it, and prove the fix.

Implement the eligibility gate that runs **before** any decision is recorded, and the decision entry
point that uses it: \`POST /v1/requests/{id}/decision\`, actor from \`X-User-Id\` (**401** when
missing), body \`{"step_index": 0, "decision": "approved", "reason": ""}\`.

- Eligibility and delegation status come from the **Eligibility service over gRPC**:
  \`CheckEligibility(actor, request_id)\` → \`{active, eligible, delegated_to}\`. A session cookie is
  not eligibility, and the workflow does not own the directory that says who still works here.
- Every attempt carries a **1-second deadline** (\`1000 ms\`). Without one, a stuck eligibility
  service holds the approval open for as long as it likes.
- Retries are **bounded** (\`2\` attempts) and only a deadline is retried; any other transport error
  is simply an unverified decision.
- **A timeout denies.** When the deadline expires — or anything else stops the service from
  answering — the decision is refused (\`eligibility_timeout\` / \`eligibility_unverified\`).
  Failing open “because the approver has a valid session” is how an outage approves spend.
- **A departed approver cannot decide**: \`active == false\` is denied (\`approver_departed\`).
- A delegation must name the actor: a \`delegated_to\` that is somebody else is denied
  (\`delegation_mismatch\`), and so is \`eligible == false\` (\`approver_ineligible\`).
- A denial from eligibility is **terminal**: the call returns immediately. Retrying an ineligible
  answer until it becomes eligible is how a rejection silently turns into an approval.
- The order is part of the contract: **verify first, then record**. A denied decision must leave
  the chain exactly where it was, and the response is the denial, not a chain advance.

**Failure mode the checks target.** The draft asks eligibility with no deadline, loops until it
hears something it likes, and records the decision before it asks at all. So an approver who left
the company decides, an ineligible approver is retried until the call happens to succeed, and a
timeout becomes an approval because nothing checks the error. Each of those is invisible in a demo
where the dependency is healthy and every approver is valid.`,
  sequence: {
    participants: ['Approver', 'Approval API', 'Eligibility', 'Redis'],
    messages: [
      {from: 'Approver', to: 'Approval API', label: 'POST /v1/requests/r-1/decision · X-User-Id', kind: 'sync'},
      {
        from: 'Approval API',
        to: 'Eligibility',
        label: 'CheckEligibility(actor, r-1) · deadline 1000 ms · attempt 1',
        kind: 'sync',
      },
      {from: 'Eligibility', to: 'Approval API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Approval API', to: 'Eligibility', label: 'attempt 2 (bounded, deadline only)', kind: 'sync'},
      {from: 'Eligibility', to: 'Approval API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Approval API', to: 'Approval API', label: 'fail closed — deny, no state write', kind: 'sync'},
      {from: 'Approval API', to: 'Redis', label: 'state.advance(…) only after a verified yes', kind: 'sync'},
      {from: 'Approval API', to: 'Approver', label: '403 {status: denied, reason: eligibility_timeout}', kind: 'reply'},
    ],
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`) — wrapping the call in a timer changes nothing. Bound the attempts with a constant: an unbounded retry around a dependency that answers “no” turns a rejection into a queue of rejections.',
    'Classify the error before you decide anything: `DEADLINE_EXCEEDED` is retryable within the bound, everything else is an unverified decision that must be denied. Returning `allowed` on the error path is the difference between a fail-closed workflow and an outage that approves spend.',
    'Read all three fields before returning a yes: `active` (a departed approver is never eligible), `delegated_to` (a delegation to somebody else means the actor is not the approver), `eligible`. And call this gate *before* `state.advance` — a denied decision must not have moved the chain.',
  ],
  checks: [
    {
      id: 'grpc-call',
      title: 'Verifies eligibility over gRPC before recording',
      detail:
        'The decision path calls `CheckEligibility` on the eligibility client and only records through `state.advance` after that call returned a verified yes. The draft records first and asks afterwards.',
      match: {
        python: {
          all: [/CheckEligibility\(/, /eligibility/],
          order: [/verify_eligibility\(/, /state\.advance\(/],
        },
        typescript: {
          all: [/CheckEligibility\(/, /eligibility/],
          order: [/verifyEligibility\(/, /state\.advance\(/],
        },
        go: {all: [/CheckEligibility\(/, /eligibility/], order: [/verifyEligibility\(/, /state\.Advance\(/]},
        scala: {
          all: [/[Cc]heck[Ee]ligibility\(/, /[Ee]ligibility/],
          order: [/verifyEligibility\(/, /state\.advance\(/],
        },
        cpp: {
          all: [/CheckEligibility\(/, /eligibility/],
          order: [/verify_eligibility\(/, /state::advance\(/],
        },
      },
    },
    {
      id: 'deadline',
      title: 'Every attempt carries a 1-second deadline',
      detail:
        'The RPC is issued with a `1000 ms` deadline — `timeout=`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter` or `set_deadline`. The draft calls without one, so a hung service holds the approval open.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1\.0/, /timeout=DEADLINE_S/, /CheckEligibility\(/]},
        typescript: {
          all: [/DEADLINE_MS\s*=\s*1000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /CheckEligibility\(/],
        },
        go: {all: [/deadlineMs\s*=\s*1000/, /context\.WithTimeout/, /CheckEligibility\(/]},
        scala: {all: [/DeadlineMs\s*=\s*1000/, /withDeadlineAfter/, /[Cc]heck[Ee]ligibility\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*1000/, /set_deadline\(/, /CheckEligibility\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'A timeout denies instead of allowing',
      detail:
        'A `DEADLINE_EXCEEDED` (and any other transport error) ends in a denial with the `eligibility_timeout` / `eligibility_unverified` reason. The draft keeps looping and treats whatever eventually arrives as consent.',
      match: {
        python: {all: [/StatusCode\.DEADLINE_EXCEEDED/, /REASON_TIMEOUT/, /return False, REASON_TIMEOUT/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /REASON_TIMEOUT/, /allowed:\s*false, reason: REASON_TIMEOUT/]},
        go: {all: [/codes\.DeadlineExceeded/, /reasonTimeout/, /return false, reasonTimeout/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /ReasonTimeout/, /\(false, ReasonTimeout\)/]},
        cpp: {all: [/StatusCode::DEADLINE_EXCEEDED/, /kReasonTimeout/, /return \{false, kReasonTimeout\}/]},
      },
    },
    {
      id: 'departed-approver',
      title: 'A departed approver cannot decide',
      detail:
        'The reply’s `active` flag is read and a false value denies the decision with the `approver_departed` reason. The draft never looks at it, so anybody who ever had the role keeps approving.',
      match: {
        python: {all: [/not reply\.active/, /REASON_DEPARTED/]},
        typescript: {all: [/!reply\.active/, /REASON_DEPARTED/]},
        go: {all: [/!reply\.Active/, /reasonDeparted/]},
        scala: {all: [/!reply\.active/, /ReasonDeparted/]},
        cpp: {all: [/!reply\.active\(\)/, /kReasonDeparted/]},
      },
    },
    {
      id: 'terminal-rejection',
      title: 'An ineligible answer is terminal, not retried',
      detail:
        'A denial from eligibility returns immediately: retries are bounded by an attempt cap and the `approver_ineligible` reason is returned rather than retried. The draft loops until the dependency says yes, which converts a rejection into an approval.',
      match: {
        python: {all: [/REASON_INELIGIBLE/, /MAX_ATTEMPTS\s*=\s*2/, /range\(MAX_ATTEMPTS\)/], none: [/while\s+True/]},
        typescript: {
          all: [/REASON_INELIGIBLE/, /MAX_ATTEMPTS\s*=\s*2/, /attempt\s*<\s*MAX_ATTEMPTS/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        go: {all: [/reasonIneligible/, /maxAttempts\s*=\s*2/, /attempt\s*<\s*maxAttempts/], none: [/for\s*\{/]},
        scala: {
          all: [/ReasonIneligible/, /MaxAttempts\s*=\s*2/, /for \(attempt <- 1 to MaxAttempts\)/],
          none: [/while\s*\(true\)/],
        },
        cpp: {
          all: [/kReasonIneligible/, /kMaxAttempts\s*=\s*2/, /attempt\s*<\s*kMaxAttempts/],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import eligibility_pb2
import eligibility_pb2_grpc
import state
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

channel = grpc.insecure_channel("eligibility:9000")
eligibility = eligibility_pb2_grpc.EligibilityStub(channel)


class DecisionRequest(BaseModel):
    step_index: int
    decision: str
    reason: str = ""


def record_decision(request_id: str, body: DecisionRequest, actor: str) -> dict:
    # TODO: the draft records the decision before it asks eligibility, calls with no deadline,
    # loops until the reply looks acceptable, and never reads active. Review all four.
    recorded = state.advance(request_id, body.step_index, actor, body.decision, body.reason)
    while True:
        try:
            reply = eligibility.CheckEligibility(
                eligibility_pb2.EligibilityRequest(actor=actor, request_id=request_id)
            )
        except grpc.RpcError:
            continue
        if reply.eligible:
            return recorded


@app.post("/v1/requests/{id}/decision")
def decide(id: str, body: DecisionRequest, actor: str = Header(alias="X-User-Id")) -> JSONResponse:
    return JSONResponse(record_decision(id, body, actor), status_code=200)
`,
      solution: `import grpc

import eligibility_pb2
import eligibility_pb2_grpc
import state
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

DEADLINE_S = 1.0
MAX_ATTEMPTS = 2
REASON_TIMEOUT = "eligibility_timeout"
REASON_UNVERIFIED = "eligibility_unverified"
REASON_DEPARTED = "approver_departed"
REASON_INELIGIBLE = "approver_ineligible"
REASON_DELEGATION = "delegation_mismatch"

channel = grpc.insecure_channel("eligibility:9000")
eligibility = eligibility_pb2_grpc.EligibilityStub(channel)


class DecisionRequest(BaseModel):
    step_index: int
    decision: str
    reason: str = ""


def verify_eligibility(actor: str, request_id: str) -> tuple[bool, str]:
    """Ask eligibility and delegation. Deny when the answer cannot be verified."""
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = eligibility.CheckEligibility(
                eligibility_pb2.EligibilityRequest(actor=actor, request_id=request_id),
                timeout=DEADLINE_S,
            )
        except grpc.RpcError as err:
            if err.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                continue
            return False, REASON_UNVERIFIED
        if not reply.active:
            return False, REASON_DEPARTED
        if reply.delegated_to and reply.delegated_to != actor:
            return False, REASON_DELEGATION
        if not reply.eligible:
            return False, REASON_INELIGIBLE
        return True, ""
    return False, REASON_TIMEOUT


def record_decision(request_id: str, body: DecisionRequest, actor: str) -> dict:
    allowed, reason = verify_eligibility(actor, request_id)
    if not allowed:
        # Fail closed: an unverified approver never moves the chain.
        return {"request_id": request_id, "status": "denied", "advanced": False, "reason": reason}
    return state.advance(request_id, body.step_index, actor, body.decision, body.reason)


@app.post("/v1/requests/{id}/decision")
def decide(
    id: str,
    body: DecisionRequest,
    actor: str | None = Header(default=None, alias="X-User-Id"),
) -> JSONResponse:
    if actor is None or actor == "":
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    result = record_decision(id, body, actor)
    if result.get("status") == "denied":
        return JSONResponse(result, status_code=403)
    return JSONResponse(result, status_code=200)
`,
    },
    typescript: {
      starter: `/** Decision path: a model-generated draft that trusts the session for eligibility. */
import * as grpc from '@grpc/grpc-js';
import Fastify from 'fastify';

import {state} from './state';

export const app = Fastify();

export interface EligibilityRequest {
  actor: string;
  request_id: string;
}

export interface EligibilityReply {
  active: boolean;
  eligible: boolean;
  delegated_to: string;
}

/** The generated gRPC client: CheckEligibility(req, options, callback). */
export const eligibility = {
  CheckEligibility(
    _request: EligibilityRequest,
    _options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: EligibilityReply) => void,
  ): void {
    throw new Error('the eligibility client is not wired up');
  },
};

interface DecisionBody {
  step_index: number;
  decision: string;
  reason?: string;
}

async function callEligibility(actor: string, requestId: string): Promise<EligibilityReply> {
  const {promise, resolve, reject} = Promise.withResolvers<EligibilityReply>();
  eligibility.CheckEligibility({actor, request_id: requestId}, {}, (error, reply) => {
    if (error !== null) reject(error);
    else resolve(reply);
  });
  return promise;
}

async function recordDecision(
  requestId: string,
  body: DecisionBody,
  actor: string,
): Promise<Record<string, unknown>> {
  // TODO: the draft records the decision before it asks eligibility, calls with no deadline,
  // loops until the reply looks acceptable, and never reads active. Review all four.
  const recorded = await state.advance(requestId, body.step_index, actor, body.decision, body.reason ?? '');
  for (;;) {
    try {
      const reply = await callEligibility(actor, requestId);
      if (reply.eligible) return recorded;
    } catch {
      continue;
    }
  }
}

app.post('/v1/requests/:id/decision', async (request, reply) => {
  const {id} = request.params as {id: string};
  const actor = request.headers['x-user-id'] as string;
  const body = request.body as DecisionBody;
  return reply.code(200).send(await recordDecision(id, body, actor));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Decision path: verify eligibility under a deadline before anything is recorded. */
import * as grpc from '@grpc/grpc-js';
import Fastify from 'fastify';

import {state} from './state';

export const app = Fastify();

const DEADLINE_MS = 1000;
const MAX_ATTEMPTS = 2;
const REASON_TIMEOUT = 'eligibility_timeout';
const REASON_UNVERIFIED = 'eligibility_unverified';
const REASON_DEPARTED = 'approver_departed';
const REASON_INELIGIBLE = 'approver_ineligible';
const REASON_DELEGATION = 'delegation_mismatch';

export interface EligibilityRequest {
  actor: string;
  request_id: string;
}

export interface EligibilityReply {
  active: boolean;
  eligible: boolean;
  delegated_to: string;
}

/** The generated gRPC client: CheckEligibility(req, options, callback). */
export const eligibility = {
  CheckEligibility(
    _request: EligibilityRequest,
    _options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: EligibilityReply) => void,
  ): void {
    throw new Error('the eligibility client is not wired up');
  },
};

interface DecisionBody {
  step_index: number;
  decision: string;
  reason?: string;
}

async function callEligibility(actor: string, requestId: string): Promise<EligibilityReply> {
  const {promise, resolve, reject} = Promise.withResolvers<EligibilityReply>();
  eligibility.CheckEligibility({actor, request_id: requestId}, {deadline: Date.now() + DEADLINE_MS}, (error, reply) => {
    if (error !== null) reject(error);
    else resolve(reply);
  });
  return promise;
}

/** Ask eligibility and delegation. Deny when the answer cannot be verified. */
async function verifyEligibility(actor: string, requestId: string): Promise<{allowed: boolean; reason: string}> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let reply: EligibilityReply;
    try {
      reply = await callEligibility(actor, requestId);
    } catch (error) {
      if ((error as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) continue;
      return {allowed: false, reason: REASON_UNVERIFIED};
    }
    if (!reply.active) return {allowed: false, reason: REASON_DEPARTED};
    if (reply.delegated_to !== '' && reply.delegated_to !== actor) return {allowed: false, reason: REASON_DELEGATION};
    if (!reply.eligible) return {allowed: false, reason: REASON_INELIGIBLE};
    return {allowed: true, reason: ''};
  }
  return {allowed: false, reason: REASON_TIMEOUT};
}

async function recordDecision(
  requestId: string,
  body: DecisionBody,
  actor: string,
): Promise<Record<string, unknown>> {
  const {allowed, reason} = await verifyEligibility(actor, requestId);
  if (!allowed) {
    // Fail closed: an unverified approver never moves the chain.
    return {request_id: requestId, status: 'denied', advanced: false, reason};
  }
  return state.advance(requestId, body.step_index, actor, body.decision, body.reason ?? '');
}

app.post('/v1/requests/:id/decision', async (request, reply) => {
  const {id} = request.params as {id: string};
  const actor = request.headers['x-user-id'];
  if (typeof actor !== 'string' || actor === '') return reply.code(401).send({error: 'missing X-User-Id'});
  const body = request.body as DecisionBody;
  const result = await recordDecision(id, body, actor);
  return reply.code(result.status === 'denied' ? 403 : 200).send(result);
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
)

type EligibilityRequest struct {
	Actor     string
	RequestID string
}

type EligibilityReply struct {
	Active      bool
	Eligible    bool
	DelegatedTo string
}

type EligibilityStub struct{}

func (s *EligibilityStub) CheckEligibility(
	ctx context.Context,
	req *EligibilityRequest,
	opts ...grpc.CallOption,
) (*EligibilityReply, error) {
	return &EligibilityReply{Active: true, Eligible: true}, nil
}

var eligibility = &EligibilityStub{}

type DecisionBody struct {
	StepIndex int    \`json:"step_index"\`
	Decision  string \`json:"decision"\`
	Reason    string \`json:"reason"\`
}

func recordDecision(ctx context.Context, requestID string, body DecisionBody, actor string) map[string]any {
	// TODO: the draft records the decision before it asks eligibility, calls with no deadline,
	// loops until the reply looks acceptable, and never reads Active. Review all four.
	recorded := state.Advance(ctx, requestID, body.StepIndex, actor, body.Decision, body.Reason)
	for {
		_, err := eligibility.CheckEligibility(ctx, &EligibilityRequest{Actor: actor, RequestID: requestID})
		if err == nil {
			return recorded
		}
	}
}

func decide(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	actor := r.Header.Get("X-User-Id")
	var body DecisionBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	result := recordDecision(r.Context(), id, body, actor)
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusOK)
	json.NewEncoder(rw).Encode(result)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/requests/{id}/decision", decide)
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
	"google.golang.org/grpc/status"
)

const (
	deadlineMs       = 1000
	maxAttempts      = 2
	reasonTimeout    = "eligibility_timeout"
	reasonUnverified = "eligibility_unverified"
	reasonDeparted   = "approver_departed"
	reasonIneligible = "approver_ineligible"
	reasonDelegation = "delegation_mismatch"
)

type EligibilityRequest struct {
	Actor     string
	RequestID string
}

type EligibilityReply struct {
	Active      bool
	Eligible    bool
	DelegatedTo string
}

type EligibilityStub struct{}

func (s *EligibilityStub) CheckEligibility(
	ctx context.Context,
	req *EligibilityRequest,
	opts ...grpc.CallOption,
) (*EligibilityReply, error) {
	return &EligibilityReply{Active: true, Eligible: true}, nil
}

var eligibility = &EligibilityStub{}

type DecisionBody struct {
	StepIndex int    \`json:"step_index"\`
	Decision  string \`json:"decision"\`
	Reason    string \`json:"reason"\`
}

// verifyEligibility asks the eligibility service and denies when the answer cannot be verified.
func verifyEligibility(ctx context.Context, actor, requestID string) (bool, string) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMs*time.Millisecond)
		reply, err := eligibility.CheckEligibility(callCtx, &EligibilityRequest{Actor: actor, RequestID: requestID})
		cancel()
		if err != nil {
			if status.Code(err) == codes.DeadlineExceeded {
				continue
			}
			return false, reasonUnverified
		}
		if !reply.Active {
			return false, reasonDeparted
		}
		if reply.DelegatedTo != "" && reply.DelegatedTo != actor {
			return false, reasonDelegation
		}
		if !reply.Eligible {
			return false, reasonIneligible
		}
		return true, ""
	}
	return false, reasonTimeout
}

func recordDecision(ctx context.Context, requestID string, body DecisionBody, actor string) map[string]any {
	allowed, reason := verifyEligibility(ctx, actor, requestID)
	if !allowed {
		// Fail closed: an unverified approver never moves the chain.
		return map[string]any{"request_id": requestID, "status": "denied", "advanced": false, "reason": reason}
	}
	return state.Advance(ctx, requestID, body.StepIndex, actor, body.Decision, body.Reason)
}

func decide(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	actor := r.Header.Get("X-User-Id")
	if actor == "" {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(rw).Encode(map[string]string{"error": "missing X-User-Id"})
		return
	}
	var body DecisionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(rw).Encode(map[string]string{"error": "invalid json"})
		return
	}
	result := recordDecision(r.Context(), id, body, actor)
	statusCode := http.StatusOK
	if result["status"] == "denied" {
		statusCode = http.StatusForbidden
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(statusCode)
	json.NewEncoder(rw).Encode(result)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/requests/{id}/decision", decide)
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

final case class DecisionRequest(step_index: Int, decision: String, reason: String)
final case class EligibilityReply(active: Boolean, eligible: Boolean, delegated_to: String)

object Client {
  implicit val system: ActorSystem = ActorSystem("approval-workflow")
  implicit val decisionFormat: RootJsonFormat[DecisionRequest] = jsonFormat3(DecisionRequest)
  implicit val replyFormat: RootJsonFormat[EligibilityReply] = jsonFormat3(EligibilityReply)

  val stub = EligibilityGrpc.blockingStub(ManagedChannelBuilder.forAddress("eligibility", 9000).usePlaintext().build())

  def recordDecision(requestId: String, body: DecisionRequest, actor: String): String = {
    // TODO: the draft records the decision before it asks eligibility, calls with no deadline,
    // loops until the reply looks acceptable, and never reads active. Review all four.
    val recorded = state.advance(requestId, body.step_index, actor, body.decision, body.reason)
    var done = false
    while (!done) {
      try {
        val reply = stub.checkEligibility(EligibilityRequest(actor = actor, request_id = requestId))
        if (reply.eligible) done = true
      } catch {
        case _: Exception => ()
      }
    }
    recorded
  }

  val route: Route =
    path("v1" / "requests" / Segment / "decision") { id =>
      post {
        headerValueByName("X-User-Id") { actor =>
          entity(as[DecisionRequest]) { body =>
            complete(StatusCodes.OK, recordDecision(id, body, actor))
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.util.concurrent.TimeUnit

final case class DecisionRequest(step_index: Int, decision: String, reason: String)
final case class EligibilityReply(active: Boolean, eligible: Boolean, delegated_to: String)

object Client {
  implicit val system: ActorSystem = ActorSystem("approval-workflow")
  implicit val decisionFormat: RootJsonFormat[DecisionRequest] = jsonFormat3(DecisionRequest)
  implicit val replyFormat: RootJsonFormat[EligibilityReply] = jsonFormat3(EligibilityReply)

  val DeadlineMs = 1000
  val MaxAttempts = 2
  val ReasonTimeout = "eligibility_timeout"
  val ReasonUnverified = "eligibility_unverified"
  val ReasonDeparted = "approver_departed"
  val ReasonIneligible = "approver_ineligible"
  val ReasonDelegation = "delegation_mismatch"

  val stub = EligibilityGrpc.blockingStub(ManagedChannelBuilder.forAddress("eligibility", 9000).usePlaintext().build())

  /** Ask eligibility and delegation. Deny when the answer cannot be verified. */
  def verifyEligibility(actor: String, requestId: String): (Boolean, String) = {
    for (attempt <- 1 to MaxAttempts) {
      try {
        val reply =
          stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).checkEligibility(
            EligibilityRequest(actor = actor, request_id = requestId)
          )
        if (!reply.active) return (false, ReasonDeparted)
        if (reply.delegated_to.nonEmpty && reply.delegated_to != actor) return (false, ReasonDelegation)
        if (!reply.eligible) return (false, ReasonIneligible)
        return (true, "")
      } catch {
        case err: io.grpc.StatusRuntimeException =>
          if (err.getStatus.getCode != io.grpc.Status.Code.DEADLINE_EXCEEDED) return (false, ReasonUnverified)
      }
    }
    (false, ReasonTimeout)
  }

  def recordDecision(requestId: String, body: DecisionRequest, actor: String): String = {
    val (allowed, reason) = verifyEligibility(actor, requestId)
    if (!allowed) {
      // Fail closed: an unverified approver never moves the chain.
      s"""{"request_id":"$requestId","status":"denied","advanced":false,"reason":"$reason"}"""
    } else {
      state.advance(requestId, body.step_index, actor, body.decision, body.reason)
    }
  }

  val route: Route =
    path("v1" / "requests" / Segment / "decision") { id =>
      post {
        optionalHeaderValueByName("X-User-Id") { actorOpt =>
          entity(as[DecisionRequest]) { body =>
            if (!actorOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-User-Id"}""")
            } else {
              complete(StatusCodes.OK, recordDecision(id, body, actorOpt.get))
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

#include "eligibility.grpc.pb.h"
#include "state.h"

#include <string>

using json = nlohmann::json;

std::unique_ptr<Eligibility::Stub> stub;

json recordDecision(const std::string& requestId, const json& body, const std::string& actor) {
  // TODO: the draft records the decision before it asks eligibility, calls with no deadline,
  // loops until the reply looks acceptable, and never reads active. Review all four.
  json recorded = state::advance(requestId, body.value("step_index", 0), actor, body.value("decision", ""), body.value("reason", ""));
  while (true) {
    grpc::ClientContext ctx;
    EligibilityRequest request;
    request.set_actor(actor);
    request.set_request_id(requestId);
    EligibilityReply reply;
    if (stub->CheckEligibility(&ctx, request, &reply).ok() && reply.eligible()) {
      return recorded;
    }
  }
}

int main() {
  auto channel = grpc::CreateChannel("eligibility:9000", grpc::InsecureChannelCredentials());
  stub = Eligibility::NewStub(channel);
  httplib::Server svr;

  svr.Post("/v1/requests/:id/decision", [](const httplib::Request& req, httplib::Response& res) {
    const auto id = req.path_params.at("id");
    const auto actor = req.get_header_value("X-User-Id");
    const json body = json::parse(req.body, nullptr, false);
    res.status = 200;
    res.set_content(recordDecision(id, body, actor).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "eligibility.grpc.pb.h"
#include "state.h"

#include <chrono>
#include <string>
#include <tuple>

using json = nlohmann::json;

constexpr long long kDeadlineMs = 1000;
constexpr int kMaxAttempts = 2;
const std::string kReasonTimeout = "eligibility_timeout";
const std::string kReasonUnverified = "eligibility_unverified";
const std::string kReasonDeparted = "approver_departed";
const std::string kReasonIneligible = "approver_ineligible";
const std::string kReasonDelegation = "delegation_mismatch";

std::unique_ptr<Eligibility::Stub> stub;

/** Ask eligibility and delegation. Deny when the answer cannot be verified. */
std::tuple<bool, std::string> verify_eligibility(const std::string& actor, const std::string& requestId) {
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    EligibilityRequest request;
    request.set_actor(actor);
    request.set_request_id(requestId);
    EligibilityReply reply;
    const grpc::Status status = stub->CheckEligibility(&ctx, request, &reply);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) continue;
      return {false, kReasonUnverified};
    }
    if (!reply.active()) return {false, kReasonDeparted};
    if (!reply.delegated_to().empty() && reply.delegated_to() != actor) return {false, kReasonDelegation};
    if (!reply.eligible()) return {false, kReasonIneligible};
    return {true, ""};
  }
  return {false, kReasonTimeout};
}

json recordDecision(const std::string& requestId, const json& body, const std::string& actor) {
  const auto [allowed, reason] = verify_eligibility(actor, requestId);
  if (!allowed) {
    // Fail closed: an unverified approver never moves the chain.
    return {
        {"request_id", requestId},
        {"status", "denied"},
        {"advanced", false},
        {"reason", reason},
    };
  }
  return state::advance(requestId, body.value("step_index", 0), actor, body.value("decision", ""), body.value("reason", ""));
}

int main() {
  auto channel = grpc::CreateChannel("eligibility:9000", grpc::InsecureChannelCredentials());
  stub = Eligibility::NewStub(channel);
  httplib::Server svr;

  svr.Post("/v1/requests/:id/decision", [](const httplib::Request& req, httplib::Response& res) {
    const auto id = req.path_params.at("id");
    const auto actor = req.get_header_value("X-User-Id");
    if (actor.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-User-Id"})", "application/json");
      return;
    }
    const json body = json::parse(req.body, nullptr, false);
    const json result = recordDecision(id, body, actor);
    res.status = result.value("status", std::string()) == "denied" ? 403 : 200;
    res.set_content(result.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The question behind this step is what a workflow does when a dependency cannot answer. The draft
  is the classic fail-open shape: it asks eligibility, but nothing about the answer is a condition —
  no deadline means the request waits forever, no error classification means a timeout is treated
  like silence, and the retry loop exists only to hear a yes. The fix is three lines of policy in
  one place: a 1-second deadline on the call, a bounded attempt count, and a denial on every path
  where the answer is not a verified yes — timeout, transport error, departed approver, delegation
  to somebody else, or \`eligible == false\`. A decision from an unverified approver must not move
  the chain, so the gate runs before \`state.advance\` and a denial returns the reason instead of a
  step index. Real systems cache eligibility for a few seconds, carry the delegation chain in the
  audit trail, and page on the timeout rate rather than the error rate, because “slow but answering”
  is the failure mode that approves spend.`,
};
