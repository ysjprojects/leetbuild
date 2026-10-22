import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Summarizer call when the window overflows',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'summarizer', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a summary eventually appears, so the demo passes.
It has no deadline, no attempt bound, no shared span identity and no write guard. Find the flaws,
fix them, and prove the fix.

Implement the summarizer call the append path makes once the buffer overflows:

- The oldest span is summarized over **gRPC**. Every attempt carries a **1.5-second deadline**. The
  draft has none, so one slow summarizer pins the worker and everything queued behind it.
- At most **2 attempts** per span. The draft retries every error forever, so a provider outage
  becomes a hot loop; a bounded retry fails fast and lets the next worker try.
- The span identity is deterministic:
  \`summary:{tenant}:{session}:{first_turn_id}:{last_turn_id}\`. Two workers that pick up the same
  span must address the same key, and the key must name the exact turns being summarized. A random
  id lets both summarizers write and neither dedupe.
- The write is guarded with **\`SET ... NX\`**: the first writer wins, and a retry reads the stored
  summary instead of overwriting a newer one with a stale result.

**Failure mode the checks target.** A retry after a timeout must store exactly one summary, not two
conflicting ones. A summarizer that never answers must fail within the deadline instead of looping
forever, and a worker that loses the race must return the winner's summary rather than its own.

## What to keep

The span (the oldest turns plus the first and last turn id) and the gRPC reply shape are fine. The
fix is the failure policy and the identity: a bounded, deadline-carrying retry under a
deterministic key with a guarded write.`,
  sequence: {
    participants: ['Memory worker', 'Summarizer', 'Redis'],
    messages: [
      {from: 'Memory worker', to: 'Summarizer', label: 'Summarize(span) · deadline 1500 ms · attempt 1', kind: 'sync'},
      {from: 'Summarizer', to: 'Memory worker', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Memory worker', to: 'Summarizer', label: 'Summarize(span) · attempt 2', kind: 'sync'},
      {from: 'Summarizer', to: 'Memory worker', label: 'SummarizeReply{summary}', kind: 'reply'},
      {from: 'Memory worker', to: 'Redis', label: 'SET summary:{tenant}:{session}:{first}:{last} … NX', kind: 'sync'},
      {from: 'Redis', to: 'Memory worker', label: 'OK · or nil when the other worker won', kind: 'reply'},
      {from: 'Memory worker', to: 'Redis', label: 'GET the same key · return the winner’s summary', kind: 'sync'},
    ],
  },
  hints: [
    'Bound both axes: a deadline per attempt and a cap on attempts. `withDeadlineAfter(1500, MILLISECONDS)` plus a loop that stops after 2 tries turns a provider outage from a hot loop into a fast, reportable failure.',
    'The span identity is the dedupe key. `{session}:{first_turn_id}:{last_turn_id}` names exactly the turns being summarized, so two workers race on one key and a single `SET NX` decides the winner.',
    'Read after the guarded write: `SET NX` returns false when the other worker won, so `GET key` and return the stored summary instead of the reply you just computed — that is what makes a retry store one summary, not two conflicting ones.',
  ],
  checks: [
    {
      id: 'summarize-call',
      title: 'Calls the summarizer over gRPC',
      detail: 'The overflow path invokes the Summarize RPC with the span being compressed.',
      match: {
        python: {all: [/Summarize/]},
        typescript: {all: [/Summarize/]},
        go: {all: [/Summarize/]},
        scala: {all: [/[Ss]ummarize/]},
        cpp: {all: [/[Ss]ummarize/]},
      },
    },
    {
      id: 'deadline',
      title: 'Gives every attempt a 1.5-second deadline',
      detail:
        'Each RPC carries a 1500 ms deadline. The draft has none, so a slow summarizer blocks the worker indefinitely.',
      match: {
        python: {all: [/DEADLINE_MS/, /timeout=/]},
        typescript: {all: [/DEADLINE_MS/, /deadline/]},
        go: {all: [/deadlineMillis/, /WithTimeout/]},
        scala: {all: [/DeadlineMillis/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineMs/, /set_deadline/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'Stops after two attempts',
      detail:
        'The retry loop is bounded by an attempt cap of 2. The draft retries every RPC forever, so a provider outage becomes a hot loop.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /range\(MAX_ATTEMPTS\)/]},
        typescript: {all: [/MAX_ATTEMPTS/, /attempt\s*<\s*MAX_ATTEMPTS/]},
        go: {all: [/maxAttempts/, /attempt\s*<\s*maxAttempts/]},
        scala: {all: [/MaxAttempts/, /attempt\(/]},
        cpp: {all: [/kMaxAttempts/, /attempt\s*<\s*kMaxAttempts/]},
      },
    },
    {
      id: 'span-identity',
      title: 'Addresses the span by (session, first, last)',
      detail:
        'The summary key is derived from the tenant, the session and the first and last turn id, so concurrent summarizers of one span share a key.',
      match: {
        python: {all: [/span_identity/, /first_turn_id/, /last_turn_id/]},
        typescript: {all: [/spanIdentity/, /first_turn_id/, /last_turn_id/]},
        go: {all: [/spanIdentity/, /FirstTurnID/, /LastTurnID/]},
        scala: {all: [/spanIdentity/, /first_turn_id/, /last_turn_id/]},
        cpp: {all: [/span_identity/, /first_turn_id/, /last_turn_id/]},
      },
    },
    {
      id: 'nx-write',
      title: 'Writes the summary once with SET NX',
      detail:
        'The summary is stored with a not-exists guard and the handler returns the stored value; the draft overwrites unconditionally, so a stale retry replaces a newer summary.',
      match: {
        python: {all: [/nx=True/]},
        typescript: {all: [/['"]NX['"]/]},
        go: {all: [/SetNX/]},
        scala: {all: [/\.nx\(\)|setnx/]},
        cpp: {all: [/NOT_EXIST/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

import summaries_pb2
import summaries_pb2_grpc

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

channel = grpc.insecure_channel("summarizer:9000")
summarizer = summaries_pb2_grpc.SummarizerStub(channel)


class Span(BaseModel):
    session_id: str
    first_turn_id: str
    last_turn_id: str
    turns: list[str]


def summarize(tenant: str, span: Span) -> str:
    # TODO: give every attempt a 1.5-second deadline and stop after two attempts; derive the span
    # identity from the session and the first and last turn id; write the summary with SET NX so a
    # retry stores one summary instead of overwriting a newer one.
    while True:
        try:
            reply = summarizer.Summarize(
                summaries_pb2.SummarizeRequest(tenant=tenant, session_id=span.session_id, turns=span.turns)
            )
            r.set(f"summary:{span.session_id}", reply.summary)
            return reply.summary
        except grpc.RpcError:
            continue


@app.post("/v1/sessions/{id}/summaries")
def make_summary(id: str, span: Span, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    return {"session_id": id, "summary": summarize(tenant, span)}
`,
      solution: `import grpc
import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import summaries_pb2
import summaries_pb2_grpc

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

DEADLINE_MS = 1500
MAX_ATTEMPTS = 2

channel = grpc.insecure_channel("summarizer:9000")
summarizer = summaries_pb2_grpc.SummarizerStub(channel)


class Span(BaseModel):
    session_id: str
    first_turn_id: str
    last_turn_id: str
    turns: list[str]


def span_identity(tenant: str, span: Span) -> str:
    return f"summary:{tenant}:{span.session_id}:{span.first_turn_id}:{span.last_turn_id}"


def summarize(tenant: str, span: Span) -> str:
    key = span_identity(tenant, span)
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = summarizer.Summarize(
                summaries_pb2.SummarizeRequest(tenant=tenant, session_id=span.session_id, turns=span.turns),
                timeout=DEADLINE_MS / 1000,
            )
            r.set(key, reply.summary, nx=True)
            return r.get(key)
        except grpc.RpcError:
            continue
    raise HTTPException(status_code=503, detail="summarizer unavailable")


@app.post("/v1/sessions/{id}/summaries")
def make_summary(id: str, span: Span, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    return {"session_id": id, "summary": summarize(tenant, span)}
`,
    },
    typescript: {
      starter: `/** POST /v1/sessions/:id/summaries: a model-generated draft that retries every RPC forever. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {summarizer} from './summarizer';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface Span {
  session_id: string;
  first_turn_id: string;
  last_turn_id: string;
  turns: string[];
}

async function summarize(tenant: string, span: Span): Promise<string> {
  // TODO: give every attempt a 1.5-second deadline and stop after two attempts; derive the span
  // identity from the session and the first and last turn id; write the summary with SET NX so a
  // retry stores one summary instead of overwriting a newer one.
  for (;;) {
    try {
      const reply = await summarizer.Summarize({tenant, session_id: span.session_id, turns: span.turns});
      await r.set(\`summary:\${span.session_id}\`, reply.summary);
      return reply.summary;
    } catch {
      continue;
    }
  }
}

app.post('/v1/sessions/:id/summaries', async (request, reply) => {
  const {id} = request.params as {id: string};
  const span = request.body as Span;
  const summary = await summarize('acme', span);
  return reply.code(200).send({session_id: id, summary});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/sessions/:id/summaries: one deadline-bounded summary under a deterministic span key. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {summarizer} from './summarizer';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const DEADLINE_MS = 1500;
const MAX_ATTEMPTS = 2;

interface Span {
  session_id: string;
  first_turn_id: string;
  last_turn_id: string;
  turns: string[];
}

function spanIdentity(tenant: string, span: Span): string {
  return \`summary:\${tenant}:\${span.session_id}:\${span.first_turn_id}:\${span.last_turn_id}\`;
}

async function summarize(tenant: string, span: Span): Promise<string> {
  const key = spanIdentity(tenant, span);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await summarizer.Summarize(
        {tenant, session_id: span.session_id, turns: span.turns},
        {deadline: Date.now() + DEADLINE_MS},
      );
      await r.set(key, reply.summary, 'NX');
      return (await r.get(key)) ?? reply.summary;
    } catch {
      continue;
    }
  }
  throw new Error('summarizer unavailable');
}

app.post('/v1/sessions/:id/summaries', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  const span = request.body as Span;
  return reply.code(200).send({session_id: id, summary: await summarize(tenant, span)});
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

	"github.com/redis/go-redis/v9"
	pb "memory/summarizerpb"
)

var (
	rdb        *redis.Client
	summarizer pb.SummarizerClient
)

type span struct {
	SessionID   string   \`json:"session_id"\`
	FirstTurnID string   \`json:"first_turn_id"\`
	LastTurnID  string   \`json:"last_turn_id"\`
	Turns       []string \`json:"turns"\`
}

func summarize(ctx context.Context, tenant string, s span) (string, error) {
	// TODO: give every attempt a 1.5-second deadline and stop after two attempts; derive the span
	// identity from the session and the first and last turn id; write the summary with SetNX so a
	// retry stores one summary instead of overwriting a newer one.
	for {
		reply, err := summarizer.Summarize(ctx, &pb.SummarizeRequest{Tenant: tenant, SessionId: s.SessionID, Turns: s.Turns})
		if err != nil {
			continue
		}
		rdb.Set(ctx, "summary:"+s.SessionID, reply.Summary, 0)
		return reply.Summary, nil
	}
}

func makeSummary(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var s span
	_ = json.NewDecoder(r.Body).Decode(&s)
	tenant := r.Header.Get("X-Tenant-Id")
	summary, err := summarize(r.Context(), tenant, s)
	if err != nil {
		http.Error(rw, \`{"error":"summarizer unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(map[string]string{"session_id": id, "summary": summary})
	_, _ = rw.Write(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sessions/{id}/summaries", makeSummary)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	pb "memory/summarizerpb"
)

const (
	deadlineMillis = 1500
	maxAttempts    = 2
)

var (
	rdb        *redis.Client
	summarizer pb.SummarizerClient
)

type span struct {
	SessionID   string   \`json:"session_id"\`
	FirstTurnID string   \`json:"first_turn_id"\`
	LastTurnID  string   \`json:"last_turn_id"\`
	Turns       []string \`json:"turns"\`
}

func spanIdentity(tenant string, s span) string {
	return fmt.Sprintf("summary:%s:%s:%s:%s", tenant, s.SessionID, s.FirstTurnID, s.LastTurnID)
}

func summarize(parent context.Context, tenant string, s span) (string, error) {
	key := spanIdentity(tenant, s)
	for attempt := 0; attempt < maxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(parent, deadlineMillis*time.Millisecond)
		reply, err := summarizer.Summarize(ctx, &pb.SummarizeRequest{Tenant: tenant, SessionId: s.SessionID, Turns: s.Turns})
		cancel()
		if err != nil {
			continue
		}
		rdb.SetNX(ctx, key, reply.Summary, 0)
		stored, _ := rdb.Get(context.Background(), key).Result()
		return stored, nil
	}
	return "", fmt.Errorf("summarizer unavailable")
}

func makeSummary(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var s span
	_ = json.NewDecoder(r.Body).Decode(&s)
	tenant := r.Header.Get("X-Tenant-Id")
	summary, err := summarize(r.Context(), tenant, s)
	if err != nil {
		http.Error(rw, \`{"error":"summarizer unavailable"}\`, http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(map[string]string{"session_id": id, "summary": summary})
	_, _ = rw.Write(payload)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sessions/{id}/summaries", makeSummary)
}
`,
    },
    scala: {
      starter: `import scala.concurrent.Future

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Span(session_id: String, first_turn_id: String, last_turn_id: String, turns: List[String])

object SummariesApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  implicit val spanFormat: RootJsonFormat[Span] = jsonFormat4(Span)

  val jedis = new Jedis("redis", 6379)

  def summarize(tenant: String, span: Span): Future[String] = {
    // TODO: give every attempt a 1.5-second deadline and stop after two attempts; derive the span
    // identity from the session and the first and last turn id; write the summary with NX so a
    // retry stores one summary instead of overwriting a newer one.
    def attempt(): Future[String] =
      stub
        .summarize(SummarizeRequest(tenant, span.session_id, span.turns))
        .recoverWith { case _ => attempt() }
    attempt().map { reply =>
      jedis.set(s"summary:\${span.session_id}", reply.summary)
      reply.summary
    }
  }

  val route: Route =
    path("v1" / "sessions" / Segment / "summaries") { id =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[Span]) { span =>
            onSuccess(summarize(tenant, span)) { summary =>
              complete(StatusCodes.OK, s"""{"session_id":"$id","summary":"$summary"}""")
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
      solution: `import scala.concurrent.Future

import java.util.concurrent.TimeUnit

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Span(session_id: String, first_turn_id: String, last_turn_id: String, turns: List[String])

object SummariesApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  implicit val spanFormat: RootJsonFormat[Span] = jsonFormat4(Span)

  val DeadlineMillis = 1500L
  val MaxAttempts = 2
  val jedis = new Jedis("redis", 6379)

  def spanIdentity(tenant: String, span: Span): String =
    s"summary:$tenant:\${span.session_id}:\${span.first_turn_id}:\${span.last_turn_id}"

  def summarize(tenant: String, span: Span): Future[String] = {
    val key = spanIdentity(tenant, span)
    def attempt(remaining: Int): Future[String] =
      stub
        .withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS)
        .summarize(SummarizeRequest(tenant, span.session_id, span.turns))
        .flatMap { reply =>
          jedis.set(key, reply.summary, redis.clients.jedis.params.SetParams.setParams().nx())
          Future.successful(Option(jedis.get(key)).getOrElse(reply.summary))
        }
        .recoverWith { case _ if remaining > 1 => attempt(remaining - 1) }
    attempt(MaxAttempts)
  }

  val route: Route =
    path("v1" / "sessions" / Segment / "summaries") { id =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[Span]) { span =>
            onSuccess(summarize(tenant, span)) { summary =>
              complete(StatusCodes.OK, s"""{"session_id":"$id","summary":"$summary"}""")
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
#include <sw/redis++/redis++.h>

#include "summaries.grpc.pb.h"

#include <string>
#include <vector>

using json = nlohmann::json;

std::unique_ptr<Summarizer::Stub> summarizer;

std::string summarize(sw::redis::Redis& redis, const std::string& tenant, const json& body) {
  // TODO: give every attempt a 1.5-second deadline and stop after two attempts; derive the span
  // identity from the session and the first and last turn id; write the summary with SET NX so a
  // retry stores one summary instead of overwriting a newer one.
  while (true) {
    grpc::ClientContext ctx;
    SummarizeRequest request;
    request.set_tenant(tenant);
    request.set_session_id(body.value("session_id", std::string()));
    SummarizeReply reply;
    if (summarizer->Summarize(&ctx, request, &reply).ok()) {
      redis.set("summary:" + body.value("session_id", std::string()), reply.summary());
      return reply.summary();
    }
  }
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;
  auto channel = grpc::CreateChannel("summarizer:9000", grpc::InsecureChannelCredentials());
  summarizer = Summarizer::NewStub(channel);

  svr.Post("/v1/sessions/:id/summaries", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    res.set_content(json{{"summary", summarize(redis, tenant, body)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "summaries.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kDeadlineMs = 1500;
constexpr int kMaxAttempts = 2;

std::unique_ptr<Summarizer::Stub> summarizer;

std::string span_identity(
    const std::string& tenant,
    const std::string& session_id,
    const std::string& first_turn_id,
    const std::string& last_turn_id) {
  return "summary:" + tenant + ":" + session_id + ":" + first_turn_id + ":" + last_turn_id;
}

std::string summarize(sw::redis::Redis& redis, const std::string& tenant, const json& body) {
  const auto session_id = body.value("session_id", std::string());
  const auto key = span_identity(
      tenant,
      session_id,
      body.value("first_turn_id", std::string()),
      body.value("last_turn_id", std::string()));
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    SummarizeRequest request;
    request.set_tenant(tenant);
    request.set_session_id(session_id);
    SummarizeReply reply;
    if (summarizer->Summarize(&ctx, request, &reply).ok()) {
      redis.set(key, reply.summary(), std::chrono::seconds(86400), sw::redis::UpdateType::NOT_EXIST);
      auto stored = redis.get(key);
      return stored ? *stored : reply.summary();
    }
  }
  throw std::runtime_error("summarizer unavailable");
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;
  auto channel = grpc::CreateChannel("summarizer:9000", grpc::InsecureChannelCredentials());
  summarizer = Summarizer::NewStub(channel);

  svr.Post("/v1/sessions/:id/summaries", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    res.set_content(json{{"summary", summarize(redis, tenant, body)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is the failure policy of a dependent call. A summarizer
is a slow, failure-prone dependency: it can be late, it can be down, and two workers can ask it the
same thing at once. The draft handles none of the three. A per-attempt deadline stops one slow
reply from pinning a worker; an attempt cap stops an outage from becoming a hot loop; a
deterministic span identity makes concurrent summarizers collide on one key instead of producing
two summaries for one span; and a guarded write makes the loser of the race read the winner's
result instead of overwriting it with a stale one. The subtle part is the last: \`SET NX\` returning
false is not an error, it is the correct outcome of a lost race, and the handler must return what is
stored rather than what it computed.`,
};
