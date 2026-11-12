import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'gRPC delivery: one key per submission and handler, a deadline, outcomes per handler',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'handlers'],
  task: `## Task

**Starting point.** The starter is \`deliver(submission_id)\`: it loads the submission
(\`store.load_submission\`), hands it to three handlers over gRPC (\`formd.Handler/Deliver\` at
\`webhook:9000\`, \`crm:9000\` and \`queue:9000\`), tries each up to \`ATTEMPTS\` = 3 times with a
freshly minted \`idempotency_key\`, and writes one \`status\` into \`delivery:{submission_id}\`:
\`delivered\` as soon as any handler answered. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A CRM whose first answer was lost gets a retry it cannot
recognise and creates a second lead; a hung webhook holds the delivery open; a queue that is down
leaves the submission marked delivered; and the retry job, replaying it, calls every handler again.

\`\`\`proto
service Handler { rpc Deliver(DeliverRequest) returns (DeliverReply); }  // upserts on idempotency_key
\`\`\`

- The key is \`{submission_id}:{handler}\`, the same on every attempt and every replay.
- Every call carries a **\`DEADLINE_S\` = 3 s** deadline; an attempt that runs out counts as failed.
- \`delivery:{submission_id}\` holds each handler's outcome (\`ok\` or \`failed\`) and a \`status\`:
  \`delivered\` when all are ok, \`partial\` when some are, \`failed\` when none are. \`deliver\` returns
  \`{status, outcomes}\`.
- Calling \`deliver\` again is the replay: it reads \`delivery:{submission_id}\` first and calls only the
  handlers that are not \`ok\` yet.`,
  sequence: {
    participants: ['Form API', 'webhook', 'crm', 'queue', 'Redis'],
    messages: [
      {from: 'Form API', to: 'Redis', label: 'HGETALL delivery:{id} → handlers already ok', kind: 'sync'},
      {from: 'Form API', to: 'webhook', label: 'Deliver · key {id}:webhook · 3 s', kind: 'sync'},
      {from: 'Form API', to: 'crm', label: 'Deliver · key {id}:crm · 3 s', kind: 'sync'},
      {from: 'crm', to: 'Form API', label: 'same key on a retry → the first receipt', kind: 'reply'},
      {from: 'Form API', to: 'queue', label: 'Deliver · key {id}:queue · 3 s', kind: 'sync'},
      {from: 'queue', to: 'Form API', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Form API', to: 'Redis', label: 'HSET webhook ok · crm ok · queue failed · status partial', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'stable-key',
      title: 'One idempotency key per submission and handler',
      detail:
        'Every attempt and every replay of one `(submission, handler)` carries the key `{submission_id}:{handler}`, so the CRM recognises a retry and keeps one lead. The starter mints a random key per attempt.',
      match: {
        python: {all: [/idempotency_key\s*=/], none: [/uuid/i]},
        typescript: {all: [/idempotency_key:/], none: [/randomUUID|uuid/i]},
        go: {all: [/IdempotencyKey:/], none: [/rand\.|uuid/i]},
        scala: {all: [/idempotencyKey\s*=/], none: [/randomUUID|uuid/i]},
        cpp: {all: [/set_idempotency_key\(/], none: [/random|uuid/i]},
      },
    },
    {
      id: 'deadline',
      title: 'Every call carries a 3-second deadline',
      detail:
        'Each `Deliver` call is made with `DEADLINE_S` = 3 s (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`), so a hung handler costs one bounded attempt and the others are still called. The starter waits as long as the handler takes.',
      match: {
        python: {all: [/\.Deliver\([^\n]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(\s*ctx\s*,\s*deadline\s*\)/]},
        scala: {all: [/withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'per-handler-outcomes',
      title: 'Records an outcome per handler',
      detail:
        '`deliver` returns and stores every handler’s outcome (`ok`/`failed`) in `delivery:{submission_id}`, so the retry job knows which handler still needs the submission. The starter keeps one flag for all three.',
      match: {
        python: {all: [/outcomes\[\s*handler\s*\]\s*=/]},
        typescript: {all: [/outcomes\[\s*handler\s*\]\s*=/]},
        go: {all: [/outcomes\[\s*handler\s*\]\s*=/]},
        scala: {all: [/outcomes\(\s*handler\s*\)\s*=/]},
        cpp: {all: [/outcomes\[\s*handler\s*\]\s*=/]},
      },
    },
    {
      id: 'partial-status',
      title: 'Partial unless every handler took it',
      detail:
        'The status is `delivered` only when every handler is ok, `partial` when some are, `failed` when none are. The starter says delivered as soon as one handler answered.',
      match: {
        python: {all: [/["']partial["']/]},
        typescript: {all: [/['"]partial['"]/]},
        go: {all: [/"partial"/]},
        scala: {all: [/"partial"/]},
        cpp: {all: [/"partial"/]},
      },
    },
    {
      id: 'replay-failed-only',
      title: 'A replay calls only the handlers that failed',
      detail:
        '`deliver` reads `delivery:{submission_id}` before calling anyone and skips the handlers already `ok`. The starter calls all three handlers on every replay.',
      match: {
        python: {all: [/r\.hgetall\(/], order: [/r\.hgetall\(/, /\.Deliver\(/]},
        typescript: {all: [/redis\.hgetall\(/], order: [/redis\.hgetall\(/, /\.Deliver\(/]},
        go: {all: [/rdb\.HGetAll\(/], order: [/rdb\.HGetAll\(/, /\.Deliver\(/]},
        scala: {all: [/jedis\.hgetAll\(/], order: [/jedis\.hgetAll\(/, /\.deliver\(/]},
        cpp: {all: [/redis\.hgetall\(/], order: [/redis\.hgetall\(/, /->Deliver\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc
import redis

import form_service_pb2
import form_service_pb2_grpc
from forms import store  # store.load_submission

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HANDLERS = ("webhook", "crm", "queue")
ATTEMPTS = 3
DEADLINE_S = 3

stubs = {name: form_service_pb2_grpc.HandlerStub(grpc.insecure_channel(f"{name}:9000")) for name in HANDLERS}


def deliver(submission_id: str) -> dict:
    """Hand the stored submission to every handler: {status, outcomes}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    submission = store.load_submission(submission_id)
    delivered = False
    for handler in HANDLERS:
        for _ in range(ATTEMPTS):
            request = form_service_pb2.DeliverRequest(
                handler=handler,
                submission_id=submission_id,
                form_id=submission["form_id"],
                idempotency_key=uuid.uuid4().hex,
                values=submission["values"],
            )
            try:
                stubs[handler].Deliver(request)
                delivered = True
                break
            except grpc.RpcError:
                continue
    status = "delivered" if delivered else "failed"
    r.hset(f"delivery:{submission_id}", "status", status)
    return {"status": status}
`,
      solution: `import grpc
import redis

import form_service_pb2
import form_service_pb2_grpc
from forms import store  # store.load_submission

r = redis.Redis(host="redis", port=6379, decode_responses=True)

HANDLERS = ("webhook", "crm", "queue")
ATTEMPTS = 3
DEADLINE_S = 3

stubs = {name: form_service_pb2_grpc.HandlerStub(grpc.insecure_channel(f"{name}:9000")) for name in HANDLERS}


def deliver(submission_id: str) -> dict:
    """Hand the stored submission to every handler that has not taken it yet: {status, outcomes}."""
    submission = store.load_submission(submission_id)
    outcomes = {h: v for h, v in r.hgetall(f"delivery:{submission_id}").items() if h in HANDLERS}
    for handler in HANDLERS:
        if outcomes.get(handler) == "ok":
            continue  # a replay leaves the handlers that already took it alone
        request = form_service_pb2.DeliverRequest(
            handler=handler,
            submission_id=submission_id,
            form_id=submission["form_id"],
            idempotency_key=f"{submission_id}:{handler}",  # the same on every attempt and every replay
            values=submission["values"],
        )
        outcomes[handler] = "failed"
        for _ in range(ATTEMPTS):
            try:
                stubs[handler].Deliver(request, timeout=DEADLINE_S)
                outcomes[handler] = "ok"
                break
            except grpc.RpcError:
                continue
    succeeded = [h for h in HANDLERS if outcomes[h] == "ok"]
    status = "delivered" if len(succeeded) == len(HANDLERS) else "partial" if succeeded else "failed"
    r.hset(f"delivery:{submission_id}", mapping={**outcomes, "status": status})
    return {"status": status, "outcomes": outcomes}
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {loadSubmission} from 'forms/store';

export const HANDLERS = ['webhook', 'crm', 'queue'] as const;
export const ATTEMPTS = 3;
export const DEADLINE_MS = 3000;

interface DeliverRequest {
  handler: string;
  submission_id: string;
  form_id: string;
  idempotency_key: string;
  values: Record<string, string>;
}

type HandlerClient = grpc.Client & {
  Deliver(request: DeliverRequest, options?: grpc.CallOptions): Promise<{receipt: string}>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('form_service.proto')) as unknown as {
  formd: {Handler: grpc.ServiceClientConstructor};
};
const stubs = Object.fromEntries(
  HANDLERS.map(name => [name, new pkg.formd.Handler(\`\${name}:9000\`, grpc.credentials.createInsecure()) as HandlerClient]),
);
const redis = new Redis({host: 'redis', port: 6379});

export interface Delivery {
  status: string;
  outcomes?: Record<string, string>;
}

/** Hand the stored submission to every handler. */
export async function deliver(submissionId: string): Promise<Delivery> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const submission = await loadSubmission(submissionId);
  if (submission === null) throw new Error(\`no submission \${submissionId}\`);
  let delivered = false;
  for (const handler of HANDLERS) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const request = {handler, submission_id: submissionId, form_id: submission.form_id, idempotency_key: randomUUID(), values: submission.values};
      try {
        await stubs[handler].Deliver(request);
        delivered = true;
        break;
      } catch {
        continue;
      }
    }
  }
  const status = delivered ? 'delivered' : 'failed';
  await redis.hset(\`delivery:\${submissionId}\`, 'status', status);
  return {status};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {loadSubmission} from 'forms/store';

export const HANDLERS = ['webhook', 'crm', 'queue'] as const;
export const ATTEMPTS = 3;
export const DEADLINE_MS = 3000;

interface DeliverRequest {
  handler: string;
  submission_id: string;
  form_id: string;
  idempotency_key: string;
  values: Record<string, string>;
}

type HandlerClient = grpc.Client & {
  Deliver(request: DeliverRequest, options?: grpc.CallOptions): Promise<{receipt: string}>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('form_service.proto')) as unknown as {
  formd: {Handler: grpc.ServiceClientConstructor};
};
const stubs = Object.fromEntries(
  HANDLERS.map(name => [name, new pkg.formd.Handler(\`\${name}:9000\`, grpc.credentials.createInsecure()) as HandlerClient]),
);
const redis = new Redis({host: 'redis', port: 6379});

export interface Delivery {
  status: string;
  outcomes?: Record<string, string>;
}

/** Hand the stored submission to every handler that has not taken it yet. */
export async function deliver(submissionId: string): Promise<Delivery> {
  const submission = await loadSubmission(submissionId);
  if (submission === null) throw new Error(\`no submission \${submissionId}\`);
  const recorded = await redis.hgetall(\`delivery:\${submissionId}\`);
  const outcomes: Record<string, string> = {};
  for (const handler of HANDLERS) {
    if (recorded[handler] === 'ok') {
      outcomes[handler] = 'ok'; // a replay leaves the handlers that already took it alone
      continue;
    }
    // The same key on every attempt and every replay.
    const request = {handler, submission_id: submissionId, form_id: submission.form_id, idempotency_key: \`\${submissionId}:\${handler}\`, values: submission.values};
    outcomes[handler] = 'failed';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        await stubs[handler].Deliver(request, {deadline: Date.now() + DEADLINE_MS});
        outcomes[handler] = 'ok';
        break;
      } catch {
        continue;
      }
    }
  }
  const succeeded = HANDLERS.filter(h => outcomes[h] === 'ok').length;
  const status = succeeded === HANDLERS.length ? 'delivered' : succeeded > 0 ? 'partial' : 'failed';
  await redis.hset(\`delivery:\${submissionId}\`, {...outcomes, status});
  return {status, outcomes};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "forms/gen/form_service"
	"forms/store" // store.LoadSubmission
)

var handlers = []string{"webhook", "crm", "queue"}

const (
	attempts = 3
	deadline = 3 * time.Second
)

var (
	rdb   = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	stubs = dialHandlers()
)

func dialHandlers() map[string]pb.HandlerClient {
	out := map[string]pb.HandlerClient{}
	for _, name := range handlers {
		conn, _ := grpc.NewClient(name+":9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[name] = pb.NewHandlerClient(conn)
	}
	return out
}

// Delivery is what deliver reports: the overall status and each handler's outcome.
type Delivery struct {
	Status   string
	Outcomes map[string]string
}

// deliver hands the stored submission to every handler.
func deliver(ctx context.Context, submissionID string) (Delivery, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	submission := store.LoadSubmission(ctx, submissionID)
	if submission == nil {
		return Delivery{}, fmt.Errorf("no submission %s", submissionID)
	}
	delivered := false
	for _, handler := range handlers {
		for attempt := 0; attempt < attempts; attempt++ {
			request := &pb.DeliverRequest{Handler: handler, SubmissionId: submissionID, FormId: submission.FormID,
				IdempotencyKey: fmt.Sprintf("%016x", rand.Int63()), Values: submission.Values}
			if _, err := stubs[handler].Deliver(ctx, request); err == nil {
				delivered = true
				break
			}
		}
	}
	status := "failed"
	if delivered {
		status = "delivered"
	}
	return Delivery{Status: status}, rdb.HSet(ctx, "delivery:"+submissionID, "status", status).Err()
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "forms/gen/form_service"
	"forms/store" // store.LoadSubmission
)

var handlers = []string{"webhook", "crm", "queue"}

const (
	attempts = 3
	deadline = 3 * time.Second
)

var (
	rdb   = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	stubs = dialHandlers()
)

func dialHandlers() map[string]pb.HandlerClient {
	out := map[string]pb.HandlerClient{}
	for _, name := range handlers {
		conn, _ := grpc.NewClient(name+":9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
		out[name] = pb.NewHandlerClient(conn)
	}
	return out
}

// Delivery is what deliver reports: the overall status and each handler's outcome.
type Delivery struct {
	Status   string
	Outcomes map[string]string
}

// deliver hands the stored submission to every handler that has not taken it yet.
func deliver(ctx context.Context, submissionID string) (Delivery, error) {
	submission := store.LoadSubmission(ctx, submissionID)
	if submission == nil {
		return Delivery{}, fmt.Errorf("no submission %s", submissionID)
	}
	recorded := rdb.HGetAll(ctx, "delivery:"+submissionID).Val()
	outcomes := map[string]string{}
	succeeded := 0
	for _, handler := range handlers {
		if recorded[handler] == "ok" {
			outcomes[handler] = "ok" // a replay leaves the handlers that already took it alone
			succeeded++
			continue
		}
		// The same key on every attempt and every replay.
		request := &pb.DeliverRequest{Handler: handler, SubmissionId: submissionID, FormId: submission.FormID,
			IdempotencyKey: submissionID + ":" + handler, Values: submission.Values}
		outcomes[handler] = "failed"
		for i := 0; i < attempts; i++ {
			if attempt(ctx, handler, request) == nil {
				outcomes[handler] = "ok"
				succeeded++
				break
			}
		}
	}
	status := "failed"
	if succeeded == len(handlers) {
		status = "delivered"
	} else if succeeded > 0 {
		status = "partial"
	}
	fields := map[string]any{"status": status}
	for handler, outcome := range outcomes {
		fields[handler] = outcome
	}
	return Delivery{Status: status, Outcomes: outcomes}, rdb.HSet(ctx, "delivery:"+submissionID, fields).Err()
}

// attempt is one call under the deadline.
func attempt(ctx context.Context, handler string, request *pb.DeliverRequest) error {
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	_, err := stubs[handler].Deliver(callCtx, request)
	return err
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import formd.form_service.{DeliverRequest, HandlerGrpc}
import forms.Store // Store.loadSubmission

/** What deliver reports: the overall status and each handler's outcome. */
final case class Delivery(status: String, outcomes: Map[String, String])

object HandlerClient {
  val Handlers: Seq[String] = Seq("webhook", "crm", "queue")
  val Attempts = 3
  val DeadlineSeconds = 3L

  private val jedis = new JedisPooled("redis", 6379)
  private val stubs = Handlers.map(name => name -> HandlerGrpc.blockingStub(ManagedChannelBuilder.forAddress(name, 9000).usePlaintext().build())).toMap

  /** Hand the stored submission to every handler. */
  def deliver(submissionId: String): Delivery = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val submission = Store.loadSubmission(submissionId).getOrElse(throw new NoSuchElementException(s"no submission $submissionId"))
    var delivered = false
    Handlers.foreach { handler =>
      var attempt = 0
      var done = false
      while (!done && attempt < Attempts) {
        val request = DeliverRequest(handler = handler, submissionId = submissionId, formId = submission.formId,
          idempotencyKey = java.util.UUID.randomUUID().toString, values = submission.values)
        try {
          stubs(handler).deliver(request)
          delivered = true
          done = true
        } catch { case _: StatusRuntimeException => attempt += 1 }
      }
    }
    val status = if (delivered) "delivered" else "failed"
    jedis.hset(s"delivery:$submissionId", "status", status)
    Delivery(status, Map.empty)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import scala.collection.mutable
import scala.jdk.CollectionConverters._

import formd.form_service.{DeliverRequest, HandlerGrpc}
import forms.Store // Store.loadSubmission

/** What deliver reports: the overall status and each handler's outcome. */
final case class Delivery(status: String, outcomes: Map[String, String])

object HandlerClient {
  val Handlers: Seq[String] = Seq("webhook", "crm", "queue")
  val Attempts = 3
  val DeadlineSeconds = 3L

  private val jedis = new JedisPooled("redis", 6379)
  private val stubs = Handlers.map(name => name -> HandlerGrpc.blockingStub(ManagedChannelBuilder.forAddress(name, 9000).usePlaintext().build())).toMap

  /** Hand the stored submission to every handler that has not taken it yet. */
  def deliver(submissionId: String): Delivery = {
    val submission = Store.loadSubmission(submissionId).getOrElse(throw new NoSuchElementException(s"no submission $submissionId"))
    val recorded = jedis.hgetAll(s"delivery:$submissionId").asScala
    val outcomes = mutable.Map.empty[String, String]
    Handlers.foreach { handler =>
      if (recorded.get(handler).contains("ok")) outcomes(handler) = "ok" // a replay leaves the handlers that already took it alone
      else {
        // The same key on every attempt and every replay.
        val request = DeliverRequest(handler = handler, submissionId = submissionId, formId = submission.formId,
          idempotencyKey = s"$submissionId:$handler", values = submission.values)
        val ok = (1 to Attempts).exists { _ =>
          try {
            stubs(handler).withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).deliver(request)
            true
          } catch { case _: StatusRuntimeException => false }
        }
        outcomes(handler) = if (ok) "ok" else "failed"
      }
    }
    val succeeded = Handlers.count(h => outcomes(h) == "ok")
    val status = if (succeeded == Handlers.size) "delivered" else if (succeeded > 0) "partial" else "failed"
    jedis.hset(s"delivery:$submissionId", (outcomes.toMap + ("status" -> status)).asJava)
    Delivery(status, outcomes.toMap)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <map>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

#include "form_service.grpc.pb.h"
#include "forms/store.h"  // store::loadSubmission

const std::vector<std::string> kHandlers = {"webhook", "crm", "queue"};
constexpr int kAttempts = 3;
constexpr std::chrono::seconds kDeadline{3};

sw::redis::Redis redis("tcp://redis:6379");

std::map<std::string, std::unique_ptr<formd::Handler::Stub>> dialHandlers() {
  std::map<std::string, std::unique_ptr<formd::Handler::Stub>> out;
  for (const auto& name : kHandlers) out[name] = formd::Handler::NewStub(grpc::CreateChannel(name + ":9000", grpc::InsecureChannelCredentials()));
  return out;
}

auto stubs = dialHandlers();

// What deliver reports: the overall status and each handler's outcome.
struct Delivery {
  std::string status;
  std::map<std::string, std::string> outcomes;
};

std::string freshKey() {
  static std::mt19937_64 random{std::random_device{}()};
  return std::to_string(random());
}

// Hand the stored submission to every handler.
Delivery deliver(const std::string& submission_id) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto submission = store::loadSubmission(submission_id);
  if (!submission) throw std::out_of_range("no submission " + submission_id);
  bool delivered = false;
  for (const auto& handler : kHandlers) {
    for (int attempt = 0; attempt < kAttempts; attempt++) {
      formd::DeliverRequest request;
      request.set_handler(handler);
      request.set_submission_id(submission_id);
      request.set_form_id(submission->form_id);
      request.set_idempotency_key(freshKey());
      for (const auto& [name, value] : submission->values) (*request.mutable_values())[name] = value;
      grpc::ClientContext ctx;
      formd::DeliverReply reply;
      if (stubs.at(handler)->Deliver(&ctx, request, &reply).ok()) {
        delivered = true;
        break;
      }
    }
  }
  const std::string status = delivered ? "delivered" : "failed";
  redis.hset("delivery:" + submission_id, "status", status);
  return {status, {}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "form_service.grpc.pb.h"
#include "forms/store.h"  // store::loadSubmission

const std::vector<std::string> kHandlers = {"webhook", "crm", "queue"};
constexpr int kAttempts = 3;
constexpr std::chrono::seconds kDeadline{3};

sw::redis::Redis redis("tcp://redis:6379");

std::map<std::string, std::unique_ptr<formd::Handler::Stub>> dialHandlers() {
  std::map<std::string, std::unique_ptr<formd::Handler::Stub>> out;
  for (const auto& name : kHandlers) out[name] = formd::Handler::NewStub(grpc::CreateChannel(name + ":9000", grpc::InsecureChannelCredentials()));
  return out;
}

auto stubs = dialHandlers();

// What deliver reports: the overall status and each handler's outcome.
struct Delivery {
  std::string status;
  std::map<std::string, std::string> outcomes;
};

// Hand the stored submission to every handler that has not taken it yet.
Delivery deliver(const std::string& submission_id) {
  const auto submission = store::loadSubmission(submission_id);
  if (!submission) throw std::out_of_range("no submission " + submission_id);
  std::unordered_map<std::string, std::string> recorded;
  redis.hgetall("delivery:" + submission_id, std::inserter(recorded, recorded.begin()));
  std::map<std::string, std::string> outcomes;
  int succeeded = 0;
  for (const auto& handler : kHandlers) {
    if (recorded[handler] == "ok") {
      outcomes[handler] = "ok";  // a replay leaves the handlers that already took it alone
      succeeded++;
      continue;
    }
    formd::DeliverRequest request;
    request.set_handler(handler);
    request.set_submission_id(submission_id);
    request.set_form_id(submission->form_id);
    request.set_idempotency_key(submission_id + ":" + handler);  // the same on every attempt and every replay
    for (const auto& [name, value] : submission->values) (*request.mutable_values())[name] = value;
    outcomes[handler] = "failed";
    for (int attempt = 0; attempt < kAttempts; attempt++) {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
      formd::DeliverReply reply;
      if (stubs.at(handler)->Deliver(&ctx, request, &reply).ok()) {
        outcomes[handler] = "ok";
        succeeded++;
        break;
      }
    }
  }
  const std::string status = succeeded == static_cast<int>(kHandlers.size()) ? "delivered" : succeeded > 0 ? "partial" : "failed";
  std::map<std::string, std::string> fields = outcomes;
  fields["status"] = status;
  redis.hset("delivery:" + submission_id, fields.begin(), fields.end());
  return {status, outcomes};
}
`,
    },
  },
  harness: {
    python: `import grpc

import form_service_pb2
import form_service_pb2_grpc
from forms import store

HANDLERS = ("webhook", "crm", "queue")
EVERYONE_OK = {"webhook": "ok", "crm": "ok", "queue": "ok"}


class Handler(form_service_pb2_grpc.HandlerServicer):
    """A downstream handler that upserts on idempotency_key: one record per key it has seen."""

    def __init__(self, name):
        self.name = name
        self.records = {}
        self.down = False

    def Deliver(self, request, context):
        if self.down:
            context.abort(grpc.StatusCode.UNAVAILABLE, f"{self.name} is down")
        receipt = self.records.setdefault(request.idempotency_key, f"{self.name}-{len(self.records) + 1}")
        return form_service_pb2.DeliverReply(receipt=receipt)


def _setup(ctx):
    store.define_form("f-1", "u-owner", {"name": 40, "email": 80}, {"name": 40, "email": 80})
    handlers = {name: Handler(name) for name in HANDLERS}
    for name, handler in handlers.items():
        ctx.grpc.serve(form_service_pb2_grpc.add_HandlerServicer_to_server, handler, target=f"{name}:9000")
    return ctx.load("client"), handlers


def _submission():
    return store.insert_submission("f-1", {"name": "Ada", "email": "ada@example.com"})


def _calls(ctx, handler):
    return ctx.grpc.calls_to("Deliver", target=f"{handler}:9000")


def check_stable_key(ctx):
    m, handlers = _setup(ctx)
    sid = _submission()
    ctx.grpc.fail("Deliver", grpc.StatusCode.UNAVAILABLE, times=1, target="crm:9000")  # the crm's first answer is lost
    m.deliver(sid)
    m.deliver(sid)  # the retry job replays it
    calls = _calls(ctx, "crm")
    keys = sorted({c.request.idempotency_key for c in calls})
    assert len(calls) >= 2, f"the crm failed once and was called {len(calls)} times: it must be retried"
    assert len(keys) == 1, f"the crm was called with {len(keys)} idempotency keys {keys} for one submission: each retry looks like a new lead. Send {sid}:crm every time"
    assert sid in keys[0], f"the key {keys[0]!r} does not name the submission {sid}"
    assert len(handlers["crm"].records) == 1, f"the crm holds {len(handlers['crm'].records)} leads for one submission"
    other = _submission()
    m.deliver(other)
    other_keys = {c.request.idempotency_key for c in _calls(ctx, "crm") if c.request.submission_id == other}
    assert other_keys and other_keys.isdisjoint(keys), f"a second submission was sent with the key {other_keys}: each submission needs its own"


def check_deadline(ctx):
    m, _ = _setup(ctx)
    sid = _submission()
    ctx.grpc.set_latency("Deliver", 10.0, target="webhook:9000")  # the webhook hangs
    start = ctx.clock.time()
    m.deliver(sid)
    elapsed = ctx.clock.time() - start
    for call in ctx.grpc.calls_to("Deliver"):
        assert call.timeout is not None, f"a Deliver call to {call.target} carries no deadline: a hung handler holds the delivery open"
        assert 2.5 <= call.timeout <= 3.5, f"a Deliver call to {call.target} carries a {call.timeout} s deadline, expected DEADLINE_S = 3"
    assert _calls(ctx, "crm") and _calls(ctx, "queue"), "after the webhook timed out the crm and the queue must still be called"
    assert elapsed <= 10, f"deliver took {elapsed:.0f} s with one hung webhook: each attempt must end at its deadline"


def check_per_handler_outcomes(ctx):
    m, handlers = _setup(ctx)
    sid = _submission()
    handlers["queue"].down = True
    result = m.deliver(sid)
    expected = {"webhook": "ok", "crm": "ok", "queue": "failed"}
    assert result.get("outcomes") == expected, f"with the queue down deliver answered {result}, expected outcomes {expected}"
    stored = ctx.redis.hgetall(f"delivery:{sid}")
    assert {h: stored.get(h) for h in HANDLERS} == expected, f"delivery:{sid} holds {stored}: the retry job cannot tell which handler still needs the submission"


def check_partial_status(ctx):
    m, handlers = _setup(ctx)
    handlers["queue"].down = True
    sid = _submission()
    result = m.deliver(sid)
    assert result.get("status") == "partial", f"with the queue down deliver answered status {result.get('status')!r}, expected partial"
    assert ctx.redis.hget(f"delivery:{sid}", "status") == "partial", f"delivery:{sid} says {ctx.redis.hget(f'delivery:{sid}', 'status')!r} while the queue never got it"
    handlers["queue"].down = False
    assert m.deliver(_submission()).get("status") == "delivered", "with every handler up the status must be delivered"
    for handler in handlers.values():
        handler.down = True
    assert m.deliver(_submission()).get("status") == "failed", "with every handler down the status must be failed"


def check_replay_failed_only(ctx):
    m, handlers = _setup(ctx)
    sid = _submission()
    handlers["queue"].down = True
    m.deliver(sid)
    handlers["queue"].down = False
    before = len(ctx.grpc.calls_to("Deliver"))
    result = m.deliver(sid)  # the retry job replays the partial delivery
    called = sorted({c.target for c in ctx.grpc.calls_to("Deliver")[before:]})
    assert called == ["queue:9000"], f"the replay called {called}: only the handler that failed (queue) needs the submission again"
    assert result.get("status") == "delivered", f"after the queue took it on the replay the status is {result.get('status')!r}, expected delivered"
    assert len(handlers["webhook"].records) == 1 and len(handlers["crm"].records) == 1, "the replay re-sent the submission to a handler that already had it"
`,
    typescript: `const HANDLERS = ['webhook', 'crm', 'queue'];

/** A downstream handler that upserts on idempotency_key: one record per key it has seen. */
class Handler {
  records = new Map<string, string>();
  down = false;
  constructor(readonly name: string) {}
}

async function setup(ctx) {
  const store = ctx.load('/support/forms/store.ts');
  await store.defineForm('f-1', 'u-owner', {name: 40, email: 80}, {name: 40, email: 80});
  const pkg = ctx.proto('form_service.proto');
  const handlers: Record<string, Handler> = {};
  for (const name of HANDLERS) {
    const handler = new Handler(name);
    handlers[name] = handler;
    ctx.grpc.serve(
      pkg.formd.Handler.service,
      {
        Deliver(call, callback) {
          if (handler.down) return callback({code: ctx.grpc.status.UNAVAILABLE, details: \`\${name} is down\`});
          const key = call.request.idempotency_key;
          if (!handler.records.has(key)) handler.records.set(key, \`\${name}-\${handler.records.size + 1}\`);
          callback(null, {receipt: handler.records.get(key)});
        },
      },
      \`\${name}:9000\`,
    );
  }
  const submission = () => store.insertSubmission('f-1', {name: 'Ada', email: 'ada@example.com'});
  return {m: ctx.load('client'), handlers, submission};
}

const callsTo = (ctx, handler: string) => ctx.grpc.callsTo('Deliver', \`\${handler}:9000\`);

export async function check_stable_key(ctx) {
  const {m, handlers, submission} = await setup(ctx);
  const sid = await submission();
  ctx.grpc.fail('Deliver', ctx.grpc.status.UNAVAILABLE, '', 1, 'crm:9000'); // the crm's first answer is lost
  await m.deliver(sid);
  await m.deliver(sid); // the retry job replays it
  const calls = callsTo(ctx, 'crm');
  const keys = [...new Set(calls.map(c => c.request.idempotency_key))].sort();
  assert(calls.length >= 2, \`the crm failed once and was called \${calls.length} times: it must be retried\`);
  assert.equal(keys.length, 1, \`the crm was called with \${keys.length} idempotency keys \${JSON.stringify(keys)} for one submission: each retry looks like a new lead. Send \${sid}:crm every time\`);
  assert(keys[0].includes(sid), \`the key \${keys[0]} does not name the submission \${sid}\`);
  assert.equal(handlers.crm.records.size, 1, \`the crm holds \${handlers.crm.records.size} leads for one submission\`);
  const other = await submission();
  await m.deliver(other);
  const otherKeys = callsTo(ctx, 'crm').filter(c => c.request.submission_id === other).map(c => c.request.idempotency_key);
  assert(otherKeys.length > 0 && otherKeys.every(k => !keys.includes(k)), \`a second submission was sent with the key \${JSON.stringify(otherKeys)}: each submission needs its own\`);
}

export async function check_deadline(ctx) {
  const {m, submission} = await setup(ctx);
  const sid = await submission();
  ctx.grpc.setLatency('Deliver', 10.0, 'webhook:9000'); // the webhook hangs
  const start = ctx.clock.now();
  await m.deliver(sid);
  const elapsed = (ctx.clock.now() - start) / 1000;
  for (const call of ctx.grpc.callsTo('Deliver')) {
    assert(call.timeout !== null, \`a Deliver call to \${call.target} carries no deadline: a hung handler holds the delivery open\`);
    assert(call.timeout >= 2.5 && call.timeout <= 3.5, \`a Deliver call to \${call.target} carries a \${call.timeout} s deadline, expected DEADLINE_MS = 3000\`);
  }
  assert(callsTo(ctx, 'crm').length > 0 && callsTo(ctx, 'queue').length > 0, 'after the webhook timed out the crm and the queue must still be called');
  assert(elapsed <= 10, \`deliver took \${elapsed.toFixed(0)} s with one hung webhook: each attempt must end at its deadline\`);
}

export async function check_per_handler_outcomes(ctx) {
  const {m, handlers, submission} = await setup(ctx);
  const sid = await submission();
  handlers.queue.down = true;
  const result = await m.deliver(sid);
  const expected = {webhook: 'ok', crm: 'ok', queue: 'failed'};
  assert.deepEqual(result.outcomes, expected, \`with the queue down deliver answered \${JSON.stringify(result)}, expected outcomes \${JSON.stringify(expected)}\`);
  const stored = ctx.redis.hgetall(\`delivery:\${sid}\`);
  assert.deepEqual(Object.fromEntries(HANDLERS.map(h => [h, stored[h]])), expected, \`delivery:\${sid} holds \${JSON.stringify(stored)}: the retry job cannot tell which handler still needs the submission\`);
}

export async function check_partial_status(ctx) {
  const {m, handlers, submission} = await setup(ctx);
  handlers.queue.down = true;
  const sid = await submission();
  const result = await m.deliver(sid);
  assert.equal(result.status, 'partial', \`with the queue down deliver answered status \${JSON.stringify(result.status)}, expected partial\`);
  assert.equal(ctx.redis.hget(\`delivery:\${sid}\`, 'status'), 'partial', \`delivery:\${sid} says \${ctx.redis.hget(\`delivery:\${sid}\`, 'status')} while the queue never got it\`);
  handlers.queue.down = false;
  assert.equal((await m.deliver(await submission())).status, 'delivered', 'with every handler up the status must be delivered');
  for (const handler of Object.values(handlers)) handler.down = true;
  assert.equal((await m.deliver(await submission())).status, 'failed', 'with every handler down the status must be failed');
}

export async function check_replay_failed_only(ctx) {
  const {m, handlers, submission} = await setup(ctx);
  const sid = await submission();
  handlers.queue.down = true;
  await m.deliver(sid);
  handlers.queue.down = false;
  const before = ctx.grpc.callsTo('Deliver').length;
  const result = await m.deliver(sid); // the retry job replays the partial delivery
  const called = [...new Set(ctx.grpc.callsTo('Deliver').slice(before).map(c => c.target))].sort();
  assert.deepEqual(called, ['queue:9000'], \`the replay called \${JSON.stringify(called)}: only the handler that failed (queue) needs the submission again\`);
  assert.equal(result.status, 'delivered', \`after the queue took it on the replay the status is \${JSON.stringify(result.status)}, expected delivered\`);
  assert(handlers.webhook.records.size === 1 && handlers.crm.records.size === 1, 'the replay re-sent the submission to a handler that already had it');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "forms/gen/form_service"
	"forms/store"

	"leetbuild/harness"
)

var clientBg = context.Background()

// handlerPeer upserts on idempotency_key: one record per key it has seen.
type handlerPeer struct {
	pb.UnimplementedHandlerServer
	name    string
	records map[string]string
	down    bool
}

func (h *handlerPeer) Deliver(_ context.Context, req *pb.DeliverRequest) (*pb.DeliverReply, error) {
	if h.down {
		return nil, status.Errorf(codes.Unavailable, "%s is down", h.name)
	}
	if _, seen := h.records[req.GetIdempotencyKey()]; !seen {
		h.records[req.GetIdempotencyKey()] = fmt.Sprintf("%s-%d", h.name, len(h.records)+1)
	}
	return &pb.DeliverReply{Receipt: h.records[req.GetIdempotencyKey()]}, nil
}

func clientSetup(ctx *harness.Ctx) map[string]*handlerPeer {
	ctx.NoError(store.DefineForm(clientBg, "f-1", "u-owner", store.Schema{"name": 40, "email": 80}, store.Schema{"name": 40, "email": 80}), "DefineForm")
	peers := map[string]*handlerPeer{
		"webhook": {name: "webhook", records: map[string]string{}},
		"crm":     {name: "crm", records: map[string]string{}},
		"queue":   {name: "queue", records: map[string]string{}},
	}
	pb.RegisterHandlerServer(ctx.GRPC.Server("webhook:9000"), peers["webhook"])
	pb.RegisterHandlerServer(ctx.GRPC.Server("crm:9000"), peers["crm"])
	pb.RegisterHandlerServer(ctx.GRPC.Server("queue:9000"), peers["queue"])
	return peers
}

func clientSubmission(ctx *harness.Ctx) string {
	id, err := store.InsertSubmission(clientBg, "f-1", map[string]string{"name": "Ada", "email": "ada@example.com"})
	ctx.NoError(err, "InsertSubmission")
	return id
}

func clientDeliver(ctx *harness.Ctx, id string) Delivery {
	d, err := deliver(clientBg, id)
	ctx.NoError(err, "deliver(%s)", id)
	return d
}

func keyOf(c any) string { return c.(*pb.DeliverRequest).GetIdempotencyKey() }

func CheckStableKey(ctx *harness.Ctx) {
	peers := clientSetup(ctx)
	sid := clientSubmission(ctx)
	ctx.GRPC.Fail("Deliver", codes.Unavailable, "", 1, "crm:9000") // the crm's first answer is lost
	clientDeliver(ctx, sid)
	clientDeliver(ctx, sid) // the retry job replays it
	calls := ctx.GRPC.CallsTo("Deliver", "crm:9000")
	ctx.Assert(len(calls) >= 2, "the crm failed once and was called %d times: it must be retried", len(calls))
	seen := map[string]bool{}
	for _, c := range calls {
		seen[keyOf(c.Request)] = true
	}
	keys := []string{}
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ctx.Assert(len(keys) == 1, "the crm was called with %d idempotency keys %q for one submission: each retry looks like a new lead. Send %s:crm every time", len(keys), keys, sid)
	ctx.Assert(strings.Contains(keys[0], sid), "the key %q does not name the submission %s", keys[0], sid)
	ctx.Equal(len(peers["crm"].records), 1, "the crm must hold one lead for one submission; leads")
	other := clientSubmission(ctx)
	clientDeliver(ctx, other)
	var otherKeys []string
	for _, c := range ctx.GRPC.CallsTo("Deliver", "crm:9000") {
		if c.Request.(*pb.DeliverRequest).GetSubmissionId() == other {
			otherKeys = append(otherKeys, keyOf(c.Request))
		}
	}
	ctx.Assert(len(otherKeys) > 0 && !seen[otherKeys[0]], "a second submission was sent with the key %q: each submission needs its own", otherKeys)
}

func CheckDeadline(ctx *harness.Ctx) {
	clientSetup(ctx)
	sid := clientSubmission(ctx)
	ctx.GRPC.SetLatency("Deliver", 10.0, "webhook:9000") // the webhook hangs
	start := ctx.Clock.Now()
	clientDeliver(ctx, sid)
	elapsed := float64(ctx.Clock.Now()-start) / 1000
	for _, call := range ctx.GRPC.CallsTo("Deliver", "") {
		ctx.Assert(call.HasDeadline(), "a Deliver call to %s carries no deadline: a hung handler holds the delivery open", call.Target)
		ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "a Deliver call to %s carries a %v deadline, expected 3 s", call.Target, call.Timeout)
	}
	ctx.Assert(len(ctx.GRPC.CallsTo("Deliver", "crm:9000")) > 0 && len(ctx.GRPC.CallsTo("Deliver", "queue:9000")) > 0, "after the webhook timed out the crm and the queue must still be called")
	ctx.Assert(elapsed <= 10, "deliver took %.0f s with one hung webhook: each attempt must end at its deadline", elapsed)
}

func CheckPerHandlerOutcomes(ctx *harness.Ctx) {
	peers := clientSetup(ctx)
	sid := clientSubmission(ctx)
	peers["queue"].down = true
	result := clientDeliver(ctx, sid)
	expected := map[string]string{"webhook": "ok", "crm": "ok", "queue": "failed"}
	ctx.Equal(result.Outcomes, expected, "with the queue down, deliver's outcomes")
	stored := ctx.Redis.HGetAll("delivery:" + sid)
	got := map[string]string{}
	for _, h := range []string{"webhook", "crm", "queue"} {
		got[h] = stored[h]
	}
	ctx.Equal(got, expected, "delivery:%s must hold every handler's outcome, or the retry job cannot tell which handler still needs the submission", sid)
}

func CheckPartialStatus(ctx *harness.Ctx) {
	peers := clientSetup(ctx)
	peers["queue"].down = true
	sid := clientSubmission(ctx)
	ctx.Equal(clientDeliver(ctx, sid).Status, "partial", "with the queue down, deliver's status")
	stored, _ := ctx.Redis.HGet("delivery:"+sid, "status")
	ctx.Equal(stored, "partial", "delivery:%s's status while the queue never got it", sid)
	peers["queue"].down = false
	ctx.Equal(clientDeliver(ctx, clientSubmission(ctx)).Status, "delivered", "with every handler up, the status")
	for _, p := range peers {
		p.down = true
	}
	ctx.Equal(clientDeliver(ctx, clientSubmission(ctx)).Status, "failed", "with every handler down, the status")
}

func CheckReplayFailedOnly(ctx *harness.Ctx) {
	peers := clientSetup(ctx)
	sid := clientSubmission(ctx)
	peers["queue"].down = true
	clientDeliver(ctx, sid)
	peers["queue"].down = false
	before := len(ctx.GRPC.CallsTo("Deliver", ""))
	result := clientDeliver(ctx, sid) // the retry job replays the partial delivery
	targets := map[string]bool{}
	for _, c := range ctx.GRPC.CallsTo("Deliver", "")[before:] {
		targets[c.Target] = true
	}
	called := []string{}
	for t := range targets {
		called = append(called, t)
	}
	sort.Strings(called)
	ctx.Equal(called, []string{"queue:9000"}, "the replay must call only the handler that failed (queue); it called")
	ctx.Equal(result.Status, "delivered", "after the queue took it on the replay, the status")
	ctx.Assert(len(peers["webhook"].records) == 1 && len(peers["crm"].records) == 1, "the replay re-sent the submission to a handler that already had it")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "form_service.grpc.pb.h"
#include "forms/store.h"

namespace {

// A downstream handler that upserts on idempotency_key: one record per key it has seen.
class HandlerPeer final : public formd::Handler::Service {
 public:
  explicit HandlerPeer(std::string name) : name_(std::move(name)) {}
  std::map<std::string, std::string> records;
  bool down = false;
  grpc::Status Deliver(grpc::ServerContext*, const formd::DeliverRequest* req, formd::DeliverReply* out) override {
    if (down) return grpc::Status(grpc::StatusCode::UNAVAILABLE, name_ + " is down");
    if (!records.count(req->idempotency_key())) records[req->idempotency_key()] = name_ + "-" + std::to_string(records.size() + 1);
    out->set_receipt(records[req->idempotency_key()]);
    return grpc::Status::OK;
  }

 private:
  std::string name_;
};

struct Peers {
  HandlerPeer webhook{"webhook"};
  HandlerPeer crm{"crm"};
  HandlerPeer queue{"queue"};
};

Peers& setup(harness::Ctx& ctx) {
  store::defineForm("f-1", "u-owner", {{"name", 40}, {"email", 80}}, {{"name", 40}, {"email", 80}});
  static Peers* peers = nullptr;
  delete peers;
  peers = new Peers;
  ctx.GRPC.Server("webhook:9000")->RegisterService(&peers->webhook);
  ctx.GRPC.Server("crm:9000")->RegisterService(&peers->crm);
  ctx.GRPC.Server("queue:9000")->RegisterService(&peers->queue);
  return *peers;
}

std::string newSubmission() { return store::insertSubmission("f-1", {{"name", "Ada"}, {"email", "ada@example.com"}}); }

std::string keyOf(const harness::Call& c) { return c.Request<formd::DeliverRequest>().idempotency_key(); }

}  // namespace

void CheckStableKey(harness::Ctx& ctx) {
  Peers& peers = setup(ctx);
  const std::string sid = newSubmission();
  ctx.GRPC.Fail("Deliver", grpc::StatusCode::UNAVAILABLE, "", 1, "crm:9000");  // the crm's first answer is lost
  deliver(sid);
  deliver(sid);  // the retry job replays it
  const auto calls = ctx.GRPC.CallsTo("Deliver", "crm:9000");
  ctx.Assert(calls.size() >= 2, "the crm failed once and was called %d times: it must be retried", calls.size());
  std::set<std::string> keys;
  for (const auto& c : calls) keys.insert(keyOf(c));
  ctx.Assert(keys.size() == 1, "the crm was called with %d idempotency keys %q for one submission: each retry looks like a new lead. Send %s:crm every time", keys.size(), std::vector<std::string>(keys.begin(), keys.end()), sid);
  ctx.Assert(keys.begin()->find(sid) != std::string::npos, "the key %q does not name the submission %s", *keys.begin(), sid);
  ctx.Equal(peers.crm.records.size(), 1, "the crm must hold one lead for one submission; leads");
  const std::string other = newSubmission();
  deliver(other);
  std::vector<std::string> otherKeys;
  for (const auto& c : ctx.GRPC.CallsTo("Deliver", "crm:9000")) {
    if (c.Request<formd::DeliverRequest>().submission_id() == other) otherKeys.push_back(keyOf(c));
  }
  ctx.Assert(!otherKeys.empty() && !keys.count(otherKeys.front()), "a second submission was sent with the key %q: each submission needs its own", otherKeys);
}

void CheckDeadline(harness::Ctx& ctx) {
  setup(ctx);
  const std::string sid = newSubmission();
  ctx.GRPC.SetLatency("Deliver", 10.0, "webhook:9000");  // the webhook hangs
  const long long start = ctx.Clock.Now();
  deliver(sid);
  const double elapsed = static_cast<double>(ctx.Clock.Now() - start) / 1000;
  for (const auto& call : ctx.GRPC.CallsTo("Deliver")) {
    ctx.Assert(call.HasDeadline(), "a Deliver call to %s carries no deadline: a hung handler holds the delivery open", call.Target);
    ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "a Deliver call to %s carries a %v s deadline, expected kDeadline = 3 s", call.Target, call.TimeoutSeconds());
  }
  ctx.Assert(!ctx.GRPC.CallsTo("Deliver", "crm:9000").empty() && !ctx.GRPC.CallsTo("Deliver", "queue:9000").empty(), "after the webhook timed out the crm and the queue must still be called");
  ctx.Assert(elapsed <= 10, "deliver took %.0f s with one hung webhook: each attempt must end at its deadline", elapsed);
}

void CheckPerHandlerOutcomes(harness::Ctx& ctx) {
  Peers& peers = setup(ctx);
  const std::string sid = newSubmission();
  peers.queue.down = true;
  const Delivery result = deliver(sid);
  const std::map<std::string, std::string> expected = {{"webhook", "ok"}, {"crm", "ok"}, {"queue", "failed"}};
  ctx.Equal(result.outcomes, expected, "with the queue down, deliver's outcomes");
  const auto stored = ctx.Redis.HGetAll("delivery:" + sid);
  std::map<std::string, std::string> got;
  for (const std::string h : {"webhook", "crm", "queue"}) got[h] = stored.count(h) ? stored.at(h) : "";
  ctx.Equal(got, expected, "delivery:%s must hold every handler's outcome, or the retry job cannot tell which handler still needs the submission", sid);
}

void CheckPartialStatus(harness::Ctx& ctx) {
  Peers& peers = setup(ctx);
  peers.queue.down = true;
  const std::string sid = newSubmission();
  ctx.Equal(deliver(sid).status, "partial", "with the queue down, deliver's status");
  ctx.Equal(ctx.Redis.HGet("delivery:" + sid, "status").value_or(""), "partial", "delivery:%s's status while the queue never got it", sid);
  peers.queue.down = false;
  ctx.Equal(deliver(newSubmission()).status, "delivered", "with every handler up, the status");
  peers.webhook.down = peers.crm.down = peers.queue.down = true;
  ctx.Equal(deliver(newSubmission()).status, "failed", "with every handler down, the status");
}

void CheckReplayFailedOnly(harness::Ctx& ctx) {
  Peers& peers = setup(ctx);
  const std::string sid = newSubmission();
  peers.queue.down = true;
  deliver(sid);
  peers.queue.down = false;
  const size_t before = ctx.GRPC.CallsTo("Deliver").size();
  const Delivery result = deliver(sid);  // the retry job replays the partial delivery
  const auto calls = ctx.GRPC.CallsTo("Deliver");
  std::set<std::string> targets;
  for (size_t i = before; i < calls.size(); i++) targets.insert(calls[i].Target);
  ctx.Equal(std::vector<std::string>(targets.begin(), targets.end()), std::vector<std::string>{"queue:9000"}, "the replay must call only the handler that failed (queue); it called");
  ctx.Equal(result.status, "delivered", "after the queue took it on the replay, the status");
  ctx.Assert(peers.webhook.records.size() == 1 && peers.crm.records.size() == 1, "the replay re-sent the submission to a handler that already had it");
}
`,
  },
  hints: [
    'Lose the CRM’s first answer: it shows two leads for one submission. Hang the webhook: the delivery waits as long as it does. Take the queue down: the submission still reads delivered, and a retry calls all three again.',
    'A random key per attempt means a handler cannot tell a retry from a new submission; no deadline means one slow peer stalls the loop; one `delivered` flag set on the first success says nothing about the other two.',
    'Send `f"{submission_id}:{handler}"` with `timeout=DEADLINE_S`; keep `outcomes[handler]`, HSET them with a status of delivered, partial or failed, and on entry HGETALL `delivery:{id}` and skip the handlers already `ok`.',
  ],
  debrief: `The key carries the identity of the work, not of the attempt: a handler that upserts on it can absorb any number of retries, which is the only thing that makes retrying a call with side effects safe. The deadline turns a hung peer into a failed attempt the loop can move past. Outcomes per handler are what give the retry job something to act on; a single flag forces it to choose between re-sending to everyone and giving up. The replay reads them first for the same reason. A delivery system in production moves this out of the request path into a queue per handler with exponential backoff and a dead-letter list, and signs each webhook body so the receiver can verify where it came from.`,
};
