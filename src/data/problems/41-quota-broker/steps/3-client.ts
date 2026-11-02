import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Capacity service calls that deny when uncertain',
  concept: 'grpc',
  file: 'client',
  focus: ['broker', 'capacity', 'redis'],
  task: `## Task

**Starting point.** The starter's \`confirm_capacity\` calls the capacity service's \`Confirm(team,
window, resource_class, amount)\` RPC in a \`while True\` loop, catches every \`grpc.RpcError\` and
calls again; the reserve handler then writes \`ledger.reserve(...)\` and answers **201**. It
compiles and hides four flaws.

**Failure mode the checks target.** A capacity service that is slow or down pins the handler in an
unbounded loop, a pool that answers \`RESOURCE_EXHAUSTED\` is retried as if it might fill up, and
when a reply does arrive its \`source_version\` is dropped on the floor.

- Every attempt carries a \`DEADLINE_MS\` (250 ms) \`timeout=\`.
- At most **2 attempts** per reserve. Only the codes in \`RETRIABLE\` (\`UNAVAILABLE\`,
  \`DEADLINE_EXCEEDED\`) earn the second one.
- \`RESOURCE_EXHAUSTED\` answers **409** \`{"error": "capacity_exhausted"}\` on the first reply.
- When the attempts run out, raise \`CapacityUnavailable\`; the handler turns it into **503**
  \`{"error": "TRY_AGAIN", "retriable": true}\` and does not touch the ledger. \`confirm_capacity\`
  must run before \`ledger.reserve\`.
- A successful confirmation's \`source_version\` is passed into the reservation so a grant can be
  traced to the pool generation it was checked against.`,
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
        'Each RPC carries a 250 ms deadline from a named constant. The starter calls without one, so a slow capacity service blocks the reserve path indefinitely.',
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
        'An unanswered confirmation becomes **503 `{"error": "TRY_AGAIN"}`** and the ledger is never written — the confirm happens before the reserve. The starter treats the failure as tacit approval because the Redis check already passed, so the capacity is promised twice.',
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
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are treated as retriable; `RESOURCE_EXHAUSTED` answers **409** on the first reply. The starter retries the exhausted error until the deadline, turning a shortage into a slow failure.',
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
        'The version from the confirmation is written with the reservation, so a grant can be traced to the pool generation it was checked against. The starter records nothing — it never writes the reservation at all.',
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
      starter: `"""Capacity confirmation before the ledger write."""
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
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Capacity confirmation before the ledger write. */
import Fastify from 'fastify';

import {capacity} from './capacity';

export const app = Fastify();

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

async function confirmCapacity(team: string, window: string, resourceClass: string, amount: number) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    'The capacity service is restarting. Every reserve request hangs, worker threads fill up, and the dashboard shows the broker at 100% CPU with zero responses.',
    '`while True` plus `except grpc.RpcError: continue` is a hot loop with no deadline and no attempt cap. An empty pool (`RESOURCE_EXHAUSTED`) spins the same way as a dead one.',
    'Give each `Confirm` `timeout=DEADLINE_MS / 1000`, allow two attempts, retry only codes in `RETRIABLE`, raise `CapacityUnavailable` to produce 503 `TRY_AGAIN` before `ledger.reserve`, and pass `grant.source_version` into the reservation.',
  ],
  debrief: `When a dependency does not answer, the broker has to decide whose authority counts. Only the pool
knows what is free, so an unanswered confirmation is a denial, not room. The policy has three parts:
a per-attempt deadline so a slow service cannot pin the handler, a retry bounded to the codes that
can succeed on a second try, and a 503 that leaves no ledger trace. \`RESOURCE_EXHAUSTED\` is the
pool saying no and \`UNAVAILABLE\` is the pool saying nothing; only the second is worth a retry.
Recording the source version lets a disputed grant name the pool generation it was made against.
Production brokers add jitter to the retry, wrap the capacity client in a circuit breaker so a dead
pool fails fast, and reconcile held reservations against the pool on a schedule.`,
};
