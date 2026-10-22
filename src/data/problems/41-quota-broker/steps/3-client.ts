import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Capacity service calls that deny when uncertain',
  concept: 'grpc',
  file: 'client',
  focus: ['broker', 'capacity', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the capacity service,
catches whatever comes back, and carries on. The demo shows a reservation because the demo service
always answers. Review it like the platform owner, fix it, and prove the fix.

Implement the capacity confirmation the reserve path makes before it writes the ledger:

- The broker confirms capacity over **gRPC** with the \`Confirm(team, window, resource_class,
  amount)\` RPC. The reply carries the granted amount and a \`source_version\` — the capacity
  service’s own generation counter — and that version is recorded with the reservation so a grant
  can be traced back to the pool state it was made against.
- Every attempt carries a **250 ms deadline**. The draft has none, so one slow capacity service
  pins the handler and every request queued behind it.
- A deadline or an unavailable service is **not** approval. It answers **503**
  \`{"error": "TRY_AGAIN", "retriable": true}\` and **records no reservation** — the ledger is never
  touched, so an uncertain answer cannot hold capacity. This is the flaw the checks target: the
  draft proceeds with the reservation because the Redis check already passed, and the GPUs it
  promised are already promised to someone else.
- \`RESOURCE_EXHAUSTED\` is **not retried**. When the pool itself is empty, retrying cannot create
  GPUs; the answer is **409** \`{"error": "capacity_exhausted"}\`, immediately. The draft retries a
  quota-exhausted error until the deadline and turns a real shortage into a slow 503.
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are worth retrying, and at most **2 attempts** per
  reserve. The first confirmation that succeeds is the one recorded.

**Failure mode the checks target.** Three proofs: a capacity timeout yields a 503 with **no**
reservation recorded, an exhausted team is not retried at all, and a successful confirmation
records the capacity source version alongside the reservation id.

**What to keep.** The RPC and the call site are fine. The fix is the failure policy: a deadline, a
bounded retry, a code-specific decision, and a ledger write that only happens after a confirmed
grant.`,
  sequence: {
    participants: ['Quota Broker', 'Capacity service', 'Redis'],
    messages: [
      {
        from: 'Quota Broker',
        to: 'Capacity service',
        label: 'Confirm(team, window, class, amount) · deadline 250 ms',
        kind: 'sync',
      },
      {from: 'Capacity service', to: 'Quota Broker', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Quota Broker', to: 'Capacity service', label: 'Confirm(...) · attempt 2', kind: 'sync'},
      {from: 'Capacity service', to: 'Quota Broker', label: 'ConfirmReply{granted, source_version}', kind: 'reply'},
      {
        from: 'Quota Broker',
        to: 'Quota Broker',
        label: '503 TRY_AGAIN and no ledger write when no reply arrives',
        kind: 'sync',
      },
      {from: 'Quota Broker', to: 'Redis', label: 'EVAL reserve(..., source_version)', kind: 'sync'},
      {from: 'Redis', to: 'Quota Broker', label: 'reservation_id', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'capacity-call',
      title: 'Confirms capacity over gRPC',
      detail: 'The reserve path invokes the capacity service’s `Confirm` RPC before it holds any capacity.',
      match: {
        python: {all: [/Confirm/]},
        typescript: {all: [/Confirm/]},
        go: {all: [/Confirm/]},
        scala: {all: [/[Cc]onfirm/]},
        cpp: {all: [/Confirm/]},
      },
    },
    {
      id: 'deadline',
      title: 'Gives every attempt a 250 ms deadline',
      detail:
        'Each RPC carries a 250 ms deadline from a named constant. The draft calls without one, so a slow capacity service blocks the reserve path indefinitely.',
      match: {
        python: {all: [/DEADLINE_MS/, /timeout=/]},
        typescript: {all: [/DEADLINE_MS/, /deadline/]},
        go: {all: [/deadlineMillis/, /WithTimeout/]},
        scala: {all: [/DeadlineMillis/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineMs/, /set_deadline/]},
      },
    },
    {
      id: 'timeout-denies',
      title: 'A timeout is 503 with no reservation recorded',
      detail:
        'An unanswered confirmation becomes **503 `{"error": "TRY_AGAIN"}`** and the ledger is never written — the confirm happens before the reserve. The draft treats the failure as tacit approval because the Redis check already passed, so the capacity is promised twice.',
      match: {
        python: {
          all: [/status_code\s*=\s*503/, /TRY_AGAIN/, /except CapacityUnavailable/],
          order: [/confirm_capacity\(/, /ledger\.reserve\(/],
        },
        typescript: {
          all: [/code\(\s*503\s*\)/, /TRY_AGAIN/, /CapacityUnavailable/],
          order: [/confirmCapacity\(/, /ledger\.reserve\(/],
        },
        go: {
          all: [/StatusServiceUnavailable/, /TRY_AGAIN/, /ErrCapacityUnavailable/],
          order: [/confirmCapacity\(/, /ledger\.Reserve\(/],
        },
        scala: {
          all: [/StatusCodes\.ServiceUnavailable/, /TRY_AGAIN/, /CapacityUnavailable/],
          order: [/confirmCapacity\(/, /[Ll]edger\.reserve\(/],
        },
        cpp: {all: [/\b503\b/, /TRY_AGAIN/, /CapacityUnavailable/], order: [/confirm_capacity\(/, /ledger\.reserve\(/]},
      },
    },
    {
      id: 'exhausted-not-retried',
      title: 'Does not retry a quota-exhausted team',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are treated as retriable; `RESOURCE_EXHAUSTED` answers **409** on the first reply. The draft retries the exhausted error until the deadline, turning a shortage into a slow failure.',
      match: {
        python: {all: [/RESOURCE_EXHAUSTED/, /RETRIABLE/]},
        typescript: {all: [/RESOURCE_EXHAUSTED/, /RETRIABLE/]},
        go: {all: [/ResourceExhausted/, /retriable/]},
        scala: {all: [/RESOURCE_EXHAUSTED/, /Retriable/]},
        cpp: {all: [/RESOURCE_EXHAUSTED/, /kRetriable/]},
      },
    },
    {
      id: 'source-version',
      title: 'Records the capacity source version',
      detail:
        'The version from the confirmation is written with the reservation, so a grant can be traced to the pool generation it was checked against. The draft records nothing — it never writes the reservation at all.',
      match: {
        python: {all: [/source_version/]},
        typescript: {all: [/source_version/]},
        go: {all: [/SourceVersion/]},
        scala: {all: [/source_version/]},
        cpp: {all: [/source_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Capacity confirmation: a model-generated draft that fails open on a timeout."""
import grpc
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import capacity_pb2
import capacity_pb2_grpc

app = FastAPI()

channel = grpc.insecure_channel("capacity:9000")
capacity = capacity_pb2_grpc.CapacityServiceStub(channel)


class ReserveRequest(BaseModel):
    window: str
    resource_class: str
    amount: int


class Ledger:
    def reserve(self, team: str, window: str, resource_class: str, amount: int) -> str:
        raise NotImplementedError


ledger = Ledger()


def confirm_capacity(team: str, window: str, resource_class: str, amount: int):
    # TODO: this draft proceeds with the reservation when the capacity call fails, because the
    # Redis check already passed, and it retries a quota-exhausted error until the deadline. Give
    # every attempt a 250 ms deadline, retry only UNAVAILABLE/DEADLINE_EXCEEDED and at most twice,
    # deny with a 503 TRY_AGAIN and no ledger write on uncertainty, and record the capacity source
    # version when the confirmation succeeds.
    while True:
        try:
            return capacity.Confirm(
                capacity_pb2.ConfirmRequest(
                    team=team, window=window, resource_class=resource_class, amount=amount
                )
            )
        except grpc.RpcError:
            continue


@app.post("/v1/quotas/{team}/reserve")
def reserve(team: str, body: ReserveRequest, caller: str = Header(alias="X-Team-Id")) -> JSONResponse:
    grant = confirm_capacity(team, body.window, body.resource_class, body.amount)
    reservation_id = ledger.reserve(team, body.window, body.resource_class, body.amount)
    return JSONResponse({"reservation_id": reservation_id}, status_code=201)
`,
      solution: `"""Capacity confirmation: a deadline-bounded call that denies when the answer is uncertain."""
import grpc
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import capacity_pb2
import capacity_pb2_grpc

app = FastAPI()

DEADLINE_MS = 250
MAX_ATTEMPTS = 2
RETRIABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("capacity:9000")
capacity = capacity_pb2_grpc.CapacityServiceStub(channel)


class ReserveRequest(BaseModel):
    window: str
    resource_class: str
    amount: int


class CapacityUnavailable(Exception):
    """No answer in time: deny and let the caller retry, never assume room."""


class CapacityExhausted(Exception):
    """The pool itself cannot cover it: retrying cannot create capacity."""


class Ledger:
    def reserve(
        self, team: str, window: str, resource_class: str, amount: int, source_version: str
    ) -> str:
        """Atomically take amount units for the pool generation that granted them."""
        raise NotImplementedError


ledger = Ledger()


def confirm_capacity(team: str, window: str, resource_class: str, amount: int):
    last_error = None
    for _ in range(MAX_ATTEMPTS):
        try:
            return capacity.Confirm(
                capacity_pb2.ConfirmRequest(
                    team=team, window=window, resource_class=resource_class, amount=amount
                ),
                timeout=DEADLINE_MS / 1000,
            )
        except grpc.RpcError as error:
            if error.code() == grpc.StatusCode.RESOURCE_EXHAUSTED:
                # Not retriable: the pool is out, and waiting cannot conjure GPUs.
                raise CapacityExhausted(resource_class)
            if error.code() not in RETRIABLE:
                raise
            last_error = error
    raise CapacityUnavailable(str(last_error))


@app.post("/v1/quotas/{team}/reserve")
def reserve(team: str, body: ReserveRequest, caller: str = Header(alias="X-Team-Id")) -> JSONResponse:
    if caller != team:
        raise HTTPException(status_code=403, detail="team mismatch")
    try:
        grant = confirm_capacity(team, body.window, body.resource_class, body.amount)
    except CapacityExhausted:
        raise HTTPException(status_code=409, detail={"error": "capacity_exhausted"})
    except CapacityUnavailable:
        # The ledger is not touched: an uncertain answer must not hold capacity.
        raise HTTPException(status_code=503, detail={"error": "TRY_AGAIN", "retriable": True})

    reservation_id = ledger.reserve(
        team, body.window, body.resource_class, body.amount, grant.source_version
    )
    return JSONResponse(
        {
            "reservation_id": reservation_id,
            "window": body.window,
            "resource_class": body.resource_class,
            "amount": body.amount,
            "capacity_source_version": grant.source_version,
        },
        status_code=201,
    )
`,
    },
    typescript: {
      starter: `/** Capacity confirmation: a model-generated draft that fails open on a timeout. */
import Fastify from 'fastify';

import {capacity} from './capacity';

export const app = Fastify();

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

async function confirmCapacity(team: string, window: string, resourceClass: string, amount: number) {
  // TODO: this draft proceeds with the reservation when the capacity call fails, because the Redis
  // check already passed, and it retries a quota-exhausted error until the deadline. Give every
  // attempt a 250 ms deadline, retry only UNAVAILABLE/DEADLINE_EXCEEDED and at most twice, deny
  // with a 503 TRY_AGAIN and no ledger write on uncertainty, and record the capacity source
  // version when the confirmation succeeds.
  for (;;) {
    try {
      return await capacity.Confirm({team, window, resource_class: resourceClass, amount});
    } catch {
      continue;
    }
  }
}

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const {team} = request.params as {team: string};
  const body = request.body as ReserveBody;
  const grant = await confirmCapacity(team, body.window, body.resource_class, body.amount);
  void grant;
  const reservation_id = await ledger.reserve(team, body.window, body.resource_class, body.amount);
  return reply.code(201).send({reservation_id});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Capacity confirmation: a deadline-bounded call that denies when the answer is uncertain. */
import Fastify from 'fastify';

import {capacity, Status} from './capacity';

export const app = Fastify();

const DEADLINE_MS = 250;
const MAX_ATTEMPTS = 2;
const RETRIABLE: Record<string, true> = {UNAVAILABLE: true, DEADLINE_EXCEEDED: true};

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

class CapacityUnavailable extends Error {}
class CapacityExhausted extends Error {}

async function confirmCapacity(team: string, window: string, resourceClass: string, amount: number) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await capacity.Confirm(
        {team, window, resource_class: resourceClass, amount},
        {deadline: Date.now() + DEADLINE_MS},
      );
    } catch (error) {
      const code = (error as {code?: string}).code;
      if (code === Status.RESOURCE_EXHAUSTED) throw new CapacityExhausted(resourceClass);
      if (code === undefined || RETRIABLE[code] !== true) throw error;
      lastError = error;
    }
  }
  throw new CapacityUnavailable(String(lastError));
}

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const {team} = request.params as {team: string};
  const caller = request.headers['x-team-id'];
  if (caller !== team) return reply.code(403).send({error: 'team mismatch'});
  const body = request.body as ReserveBody;

  let grant;
  try {
    grant = await confirmCapacity(team, body.window, body.resource_class, body.amount);
  } catch (error) {
    if (error instanceof CapacityExhausted) return reply.code(409).send({error: 'capacity_exhausted'});
    if (error instanceof CapacityUnavailable)
      // The ledger is not touched: an uncertain answer must not hold capacity.
      return reply.code(503).send({error: 'TRY_AGAIN', retriable: true});
    throw error;
  }

  const reservation_id = await ledger.reserve(
    team,
    body.window,
    body.resource_class,
    body.amount,
    grant.source_version,
  );
  return reply.code(201).send({
    reservation_id,
    window: body.window,
    resource_class: body.resource_class,
    amount: body.amount,
    capacity_source_version: grant.source_version,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"google.golang.org/grpc"

	capacitypb "quota/capacitypb"
)

var capacity capacitypb.CapacityServiceClient

type reserveRequest struct {
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int    \`json:"amount"\`
}

func confirmCapacity(ctx context.Context, team, window, resourceClass string, amount int) (*capacitypb.ConfirmReply, error) {
	// TODO: this draft proceeds with the reservation when the capacity call fails, because the Redis
	// check already passed, and it retries a quota-exhausted error until the deadline. Give every
	// attempt a 250 ms deadline, retry only Unavailable/DeadlineExceeded and at most twice, deny
	// with a 503 TRY_AGAIN and no ledger write on uncertainty, and record the capacity source
	// version when the confirmation succeeds.
	for {
		reply, err := capacity.Confirm(ctx, &capacitypb.ConfirmRequest{
			Team:          team,
			Window:        window,
			ResourceClass: resourceClass,
			Amount:        int32(amount),
		})
		if err != nil {
			continue
		}
		return reply, nil
	}
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	team := r.PathValue("team")
	var body reserveRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	_, _ = confirmCapacity(r.Context(), team, body.Window, body.ResourceClass, body.Amount)
	reservationID, _ := ledger.Reserve(r.Context(), team, body.Window, body.ResourceClass, body.Amount)
	payload, _ := json.Marshal(map[string]string{"reservation_id": reservationID})
	_, _ = rw.Write(payload)
}

func main() {
	conn, _ := grpc.NewClient("capacity:9000")
	capacity = capacitypb.NewCapacityServiceClient(conn)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	capacitypb "quota/capacitypb"
)

const (
	deadlineMillis = 250
	maxAttempts    = 2
)

// ErrCapacityUnavailable is retriable: no answer arrived in time, so deny instead of assuming room.
var ErrCapacityUnavailable = errors.New("TRY_AGAIN")

// ErrCapacityExhausted is not retriable: the pool cannot cover it, and waiting cannot create GPUs.
var ErrCapacityExhausted = errors.New("capacity_exhausted")

var retriable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var capacity capacitypb.CapacityServiceClient

type reserveRequest struct {
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int    \`json:"amount"\`
}

func confirmCapacity(parent context.Context, team, window, resourceClass string, amount int) (*capacitypb.ConfirmReply, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(parent, deadlineMillis*time.Millisecond)
		reply, err := capacity.Confirm(ctx, &capacitypb.ConfirmRequest{
			Team:          team,
			Window:        window,
			ResourceClass: resourceClass,
			Amount:        int32(amount),
		})
		cancel()
		if err == nil {
			return reply, nil
		}
		if status.Code(err) == codes.ResourceExhausted {
			return nil, ErrCapacityExhausted
		}
		if !retriable[status.Code(err)] {
			return nil, err
		}
	}
	return nil, ErrCapacityUnavailable
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	team := r.PathValue("team")
	if r.Header.Get("X-Team-Id") != team {
		http.Error(rw, \`{"error":"team mismatch"}\`, http.StatusForbidden)
		return
	}
	var body reserveRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	grant, err := confirmCapacity(ctx, team, body.Window, body.ResourceClass, body.Amount)
	if errors.Is(err, ErrCapacityExhausted) {
		http.Error(rw, \`{"error":"capacity_exhausted"}\`, http.StatusConflict)
		return
	}
	if err != nil {
		// The ledger is not touched: an uncertain answer must not hold capacity.
		http.Error(rw, \`{"error":"TRY_AGAIN"}\`, http.StatusServiceUnavailable)
		return
	}
	reservationID, err := ledger.Reserve(ctx, team, body.Window, body.ResourceClass, body.Amount, grant.SourceVersion)
	if err != nil {
		http.Error(rw, \`{"error":"ledger unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"reservation_id":          reservationID,
		"window":                  body.Window,
		"resource_class":          body.ResourceClass,
		"amount":                  body.Amount,
		"capacity_source_version": grant.SourceVersion,
	})
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write(payload)
}

func main() {
	conn, _ := grpc.NewClient("capacity:9000")
	capacity = capacitypb.NewCapacityServiceClient(conn)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
}
`,
    },
    scala: {
      starter: `import scala.concurrent.Future
import scala.concurrent.ExecutionContext.Implicits.global

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReserveRequest(window: String, resource_class: String, amount: Int)

object ClientApi {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  implicit val reserveFormat: RootJsonFormat[ReserveRequest] = jsonFormat3(ReserveRequest)

  def confirmCapacity(team: String, window: String, resourceClass: String, amount: Int): Future[ConfirmReply] = {
    // TODO: this draft proceeds with the reservation when the capacity call fails, because the
    // Redis check already passed, and it retries a quota-exhausted error until the deadline. Give
    // every attempt a 250 ms deadline, retry only UNAVAILABLE/DEADLINE_EXCEEDED and at most twice,
    // deny with a 503 TRY_AGAIN and no ledger write on uncertainty, and record the capacity source
    // version when the confirmation succeeds.
    def attempt(): Future[ConfirmReply] =
      stub.confirm(ConfirmRequest(team, window, resourceClass, amount)).recoverWith { case _ => attempt() }
    attempt()
  }

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        entity(as[ReserveRequest]) { body =>
          onSuccess(confirmCapacity(team, body.window, body.resource_class, body.amount)) { grant =>
            val reservationId =
              ledger.reserve(team, body.window, body.resource_class, body.amount)
            complete(StatusCodes.Created, s"""{"reservation_id":"$reservationId"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import scala.concurrent.Future
import scala.concurrent.ExecutionContext.Implicits.global

import java.util.concurrent.TimeUnit

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReserveRequest(window: String, resource_class: String, amount: Int)

class CapacityUnavailable(message: String) extends RuntimeException(message)
class CapacityExhausted(resourceClass: String) extends RuntimeException(resourceClass)

object ClientApi {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  implicit val reserveFormat: RootJsonFormat[ReserveRequest] = jsonFormat3(ReserveRequest)

  val DeadlineMillis = 250L
  val MaxAttempts = 2
  val Retriable = Set(Status.UNAVAILABLE, Status.DEADLINE_EXCEEDED)

  def confirmCapacity(team: String, window: String, resourceClass: String, amount: Int): Future[ConfirmReply] = {
    def attempt(remaining: Int): Future[ConfirmReply] =
      stub
        .withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS)
        .confirm(ConfirmRequest(team, window, resourceClass, amount))
        .recoverWith {
          case e: StatusRuntimeException if e.getStatus.getCode == Status.RESOURCE_EXHAUSTED =>
            // Not retriable: the pool is out, and waiting cannot conjure GPUs.
            Future.failed(new CapacityExhausted(resourceClass))
          case e: StatusRuntimeException if Retriable.contains(e.getStatus.getCode) && remaining > 1 =>
            attempt(remaining - 1)
          case e: StatusRuntimeException =>
            Future.failed(new CapacityUnavailable(e.getMessage))
        }
    attempt(MaxAttempts)
  }

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        headerValueByName("X-Team-Id") { caller =>
          entity(as[ReserveRequest]) { body =>
            if (caller != team) {
              complete(StatusCodes.Forbidden, """{"error":"team mismatch"}""")
            } else {
              onComplete(confirmCapacity(team, body.window, body.resource_class, body.amount)) {
                case scala.util.Success(grant) =>
                  val reservationId =
                    ledger.reserve(team, body.window, body.resource_class, body.amount, grant.source_version)
                  complete(
                    StatusCodes.Created,
                    s"""{"reservation_id":"$reservationId","window":"\${body.window}","capacity_source_version":"\${grant.source_version}"}""")
                case scala.util.Failure(_: CapacityExhausted) =>
                  complete(StatusCodes.Conflict, """{"error":"capacity_exhausted"}""")
                case scala.util.Failure(_: CapacityUnavailable) =>
                  // The ledger is not touched: an uncertain answer must not hold capacity.
                  complete(StatusCodes.ServiceUnavailable, """{"error":"TRY_AGAIN"}""")
                case scala.util.Failure(other) =>
                  complete(StatusCodes.ServiceUnavailable, s"""{"error":"\${other.getMessage}"}""")
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

#include "capacity.grpc.pb.h"

#include <string>

using json = nlohmann::json;

std::unique_ptr<CapacityService::Stub> capacity;

json confirm_capacity(const std::string& team, const std::string& window, const std::string& resource_class, int amount) {
  // TODO: this draft proceeds with the reservation when the capacity call fails, because the Redis
  // check already passed, and it retries a quota-exhausted error until the deadline. Give every
  // attempt a 250 ms deadline, retry only UNAVAILABLE/DEADLINE_EXCEEDED and at most twice, deny
  // with a 503 TRY_AGAIN and no ledger write on uncertainty, and record the capacity source
  // version when the confirmation succeeds.
  while (true) {
    grpc::ClientContext ctx;
    ConfirmRequest request;
    request.set_team(team);
    request.set_window(window);
    request.set_resource_class(resource_class);
    request.set_amount(amount);
    ConfirmReply reply;
    if (capacity->Confirm(&ctx, request, &reply).ok()) {
      return json{{"granted", reply.granted()}};
    }
  }
}

int main() {
  httplib::Server svr;
  auto channel = grpc::CreateChannel("capacity:9000", grpc::InsecureChannelCredentials());
  capacity = CapacityService::NewStub(channel);

  svr.Post("/v1/quotas/:team/reserve", [](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto grant = confirm_capacity(team, body.value("window", std::string()), body.value("resource_class", std::string()), body.value("amount", 0));
    const auto reservation_id = ledger.reserve(team, body.value("window", std::string()), body.value("resource_class", std::string()), body.value("amount", 0));
    res.status = 201;
    res.set_content(json{{"reservation_id", reservation_id}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "capacity.grpc.pb.h"

#include <chrono>
#include <set>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

constexpr long long kDeadlineMs = 250;
constexpr int kMaxAttempts = 2;
const std::set<grpc::StatusCode> kRetriable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

class CapacityUnavailable : public std::runtime_error {
 public:
  CapacityUnavailable() : std::runtime_error("TRY_AGAIN") {}
};

class CapacityExhausted : public std::runtime_error {
 public:
  CapacityExhausted() : std::runtime_error("capacity_exhausted") {}
};

std::unique_ptr<CapacityService::Stub> capacity;

json confirm_capacity(const std::string& team, const std::string& window, const std::string& resource_class, int amount) {
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ConfirmRequest request;
    request.set_team(team);
    request.set_window(window);
    request.set_resource_class(resource_class);
    request.set_amount(amount);
    ConfirmReply reply;
    const auto status = capacity->Confirm(&ctx, request, &reply);
    if (status.ok()) {
      return json{{"granted", reply.granted()}, {"source_version", reply.source_version()}};
    }
    if (status.error_code() == grpc::StatusCode::RESOURCE_EXHAUSTED) {
      // Not retriable: the pool is out, and waiting cannot conjure GPUs.
      throw CapacityExhausted();
    }
    if (kRetriable.count(status.error_code()) == 0) throw CapacityUnavailable();
  }
  throw CapacityUnavailable();
}

int main() {
  httplib::Server svr;
  auto channel = grpc::CreateChannel("capacity:9000", grpc::InsecureChannelCredentials());
  capacity = CapacityService::NewStub(channel);

  svr.Post("/v1/quotas/:team/reserve", [](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    if (req.get_header_value("X-Team-Id") != team) {
      res.status = 403;
      res.set_content(R"({"error":"team mismatch"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto window = body.value("window", std::string());
    const auto resource_class = body.value("resource_class", std::string());
    const int amount = body.value("amount", 0);
    json grant;
    try {
      grant = confirm_capacity(team, window, resource_class, amount);
    } catch (const CapacityExhausted&) {
      res.status = 409;
      res.set_content(R"({"error":"capacity_exhausted"})", "application/json");
      return;
    } catch (const CapacityUnavailable&) {
      // The ledger is not touched: an uncertain answer must not hold capacity.
      res.status = 503;
      res.set_content(R"({"error":"TRY_AGAIN"})", "application/json");
      return;
    }
    const auto source_version = grant.value("source_version", std::string());
    const auto reservation_id = ledger.reserve(team, window, resource_class, amount, source_version);
    res.status = 201;
    res.set_content(
        json{{"reservation_id", reservation_id},
             {"window", window},
             {"resource_class", resource_class},
             {"amount", amount},
             {"capacity_source_version", source_version}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Bound both axes of the call: a 250 ms deadline per attempt and a cap of two attempts. Without them a slow or dead capacity service either blocks the handler or becomes a hot loop, and both look like a shortage to the caller.',
    'Decide by status code, not by `except`. `UNAVAILABLE` and `DEADLINE_EXCEEDED` are worth one more try; `RESOURCE_EXHAUSTED` means the pool is empty, so answer 409 at once — retrying a shortage only delays the truth.',
    'The confirm must come before the ledger write, and an uncertain answer must leave the ledger untouched: 503 `TRY_AGAIN` with no reservation recorded. When the confirmation does succeed, carry its `source_version` into the reservation so the grant is traceable to the pool generation it was checked against.',
  ],
  debrief: `The interview question behind this step is what to do when a dependency does not answer. The
tempting answer — proceed, because the local check passed — is the one that produces double-booked
GPUs, since the local check and the remote pool are different authorities and only the pool knows
what is actually free. The correct policy has three parts: a per-attempt deadline so a slow service
cannot pin the handler, a bounded retry over exactly the codes that can succeed on a second try, and
a hard denial that leaves no trace on any other answer. Distinguishing \`RESOURCE_EXHAUSTED\` from
\`UNAVAILABLE\` is the part candidates skip: one is the pool saying no, the other is the pool saying
nothing, and only the second is worth retrying. Recording the confirmation’s source version closes
the loop — when a grant is later disputed, the broker can name the pool generation it was made
against. Real brokers add jittered backoff, a circuit breaker over the capacity service, and a
reconciliation job that compares held reservations against the pool.`,
};
