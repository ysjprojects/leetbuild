import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'gRPC summarizer: a deadline, a bounded retry and one summary per span',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['worker', 'summarizer', 'redis'],
  task: `## Task

**Starting point.** The starter is the memory worker's summarizer client:
\`summarize_span(tenant, session_id, turns)\` sends the span (oldest first) to \`Summarizer.Summarize\`
at \`summarizer:9000\`, retries any error up to five times with a one-second sleep, stores the reply
with \`SET summary:{session_id}\` for a day and returns it. With a healthy summarizer it works, and
it hides four flaws.

**Failure mode the checks target.** A summarizer that hangs holds the worker as long as it likes; a
request the summarizer rejects is sent again and again; each new span of a session overwrites the
summary of the one before; and when two workers summarize the same span, the slower one replaces
the stored summary with its own.

\`\`\`proto
service Summarizer { rpc Summarize(SummarizeRequest) returns (Summary); }  // INVALID_ARGUMENT: bad span · UNAVAILABLE: overloaded
\`\`\`

- Every attempt carries a \`DEADLINE_S\` = **1.5 s** deadline.
- At most \`MAX_ATTEMPTS\` = **2** attempts, the second only after \`UNAVAILABLE\` or
  \`DEADLINE_EXCEEDED\`; any other status, or a failed last attempt, raises \`SummarizerError\`.
- A summary is stored in the hash \`summaries_key(tenant, session_id)\` =
  \`summaries:{tenant}:{session_id}\` under \`span_id(turns)\` = \`{first_turn_id}:{last_turn_id}\`,
  where \`memory.summaries.latest_summary\` reads it.
- The write is \`HSETNX\`: the first summary of a span wins, and \`summarize_span\` returns the stored
  text.`,
  sequence: {
    participants: ['Memory worker', 'Summarizer', 'Redis'],
    messages: [
      {from: 'Memory worker', to: 'Summarizer', label: 'Summarize(t-1..t-10) · deadline 1.5 s', kind: 'sync'},
      {
        from: 'Summarizer',
        to: 'Memory worker',
        label: 'UNAVAILABLE → one more attempt · INVALID_ARGUMENT → SummarizerError',
        kind: 'reply',
      },
      {from: 'Memory worker', to: 'Summarizer', label: 'Summarize(t-1..t-10) · deadline 1.5 s', kind: 'sync'},
      {from: 'Summarizer', to: 'Memory worker', label: 'Summary', kind: 'reply'},
      {from: 'Memory worker', to: 'Redis', label: 'HSETNX summaries:t1:s-1 t-1:t-10 text', kind: 'sync'},
      {
        from: 'Memory worker',
        to: 'Redis',
        label: 'HGET summaries:t1:s-1 t-1:t-10 → the first summary stored',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 1.5-second deadline',
      detail:
        'Each `Summarize` call is made with `DEADLINE_S` (1.5 s), so a summarizer that hangs costs at most two deadlines; the starter passes no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1\.5\b/, /Summarize\([^)]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*1500\b/, /Summarize\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*1500\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {
          all: [/DeadlineMillis\s*=\s*1500L?\b/, /withDeadlineAfter\(\s*DeadlineMillis\s*,\s*TimeUnit\.MILLISECONDS/],
        },
        cpp: {all: [/kDeadline\{1500\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries once, and only a retryable status',
      detail:
        'At most `MAX_ATTEMPTS` (2) calls per span, the second only after `UNAVAILABLE` or `DEADLINE_EXCEEDED`; `INVALID_ARGUMENT` raises at once. The starter retries every error five times with a sleep in between.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/range\(\s*5\s*\)/, /time\.sleep\(/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/attempt < 5/, /setTimeout\(/],
        },
        go: {
          all: [/maxAttempts\s*=\s*2\b/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/attempt < 5/, /time\.Sleep\(/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*2\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/attempt < 5/, /Thread\.sleep\(/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*2\b/, /StatusCode::UNAVAILABLE/, /StatusCode::DEADLINE_EXCEEDED/],
          none: [/attempt < 5/, /sleep_for\(/],
        },
      },
    },
    {
      id: 'span-identity',
      title: 'Stores each span under its own id',
      detail:
        'A summary goes into `summaries:{tenant}:{session_id}` under `span_id(turns)` (`{first_turn_id}:{last_turn_id}`), so a later span adds a field instead of replacing the earlier summary; the starter writes every span of a session to `summary:{session_id}`.',
      match: {
        python: {all: [/def span_id\(/, /summaries:\{tenant\}:\{session_id\}/], none: [/summary:\{session_id\}/]},
        typescript: {
          all: [/spanId\s*=\s*\(|function spanId\(/, /summaries:\$\{tenant\}:\$\{sessionId\}/],
          none: [/summary:\$\{sessionId\}/],
        },
        go: {all: [/func spanID\(/, /"summaries:"\s*\+\s*tenant/], none: [/"summary:"\s*\+\s*sessionID/]},
        scala: {all: [/def spanId\(/, /s"summaries:\$tenant:\$sessionId"/], none: [/s"summary:\$sessionId"/]},
        cpp: {all: [/std::string spanId\(/, /"summaries:"\s*\+\s*tenant/], none: [/"summary:"\s*\+\s*session_id/]},
      },
    },
    {
      id: 'first-writer-wins',
      title: 'Keeps the first summary of a span',
      detail:
        "The summary is written with `HSETNX` and the stored field is read back and returned, so a worker that lost the race returns the winner's summary; the starter's plain `SET` replaces it.",
      match: {
        python: {all: [/\.hsetnx\(/, /\.hget\(/], none: [/\br\.set\(/, /\.hset\(/]},
        typescript: {all: [/\.hsetnx\(/, /\.hget\(/], none: [/redis\.set\(/, /redis\.hset\(/]},
        go: {all: [/\.HSetNX\(/, /\.HGet\(/], none: [/rdb\.Set\(/, /rdb\.HSet\(/]},
        scala: {all: [/jedis\.hsetnx\(/, /jedis\.hget\(/], none: [/jedis\.set(ex)?\(/, /jedis\.hset\(/]},
        cpp: {all: [/\.hsetnx\(/, /\.hget\(/], none: [/redis\(\)\.set\(/, /redis\(\)\.hset\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc
import redis

import summarizer_pb2
import summarizer_pb2_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)
stub = summarizer_pb2_grpc.SummarizerStub(grpc.insecure_channel("summarizer:9000"))

SUMMARY_TTL_S = 86400


class SummarizerError(Exception):
    """The summarizer gave no summary: the worker tries the span again later."""


def summarize_span(tenant: str, session_id: str, turns: list[dict]) -> str:
    """Summarize a span of turns (oldest first) and store the summary; returns the stored text."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    request = summarizer_pb2.SummarizeRequest(
        tenant=tenant,
        session_id=session_id,
        turns=[summarizer_pb2.Turn(turn_id=t["turn_id"], role=t["role"], content=t["content"]) for t in turns],
    )
    for attempt in range(5):
        try:
            reply = stub.Summarize(request)
            break
        except grpc.RpcError:
            time.sleep(1.0)  # the summarizer is flaky: try again
    else:
        raise SummarizerError("the summarizer did not answer")
    r.set(f"summary:{session_id}", reply.text, ex=SUMMARY_TTL_S)
    return reply.text
`,
      solution: `import grpc
import redis

import summarizer_pb2
import summarizer_pb2_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)
stub = summarizer_pb2_grpc.SummarizerStub(grpc.insecure_channel("summarizer:9000"))

DEADLINE_S = 1.5
MAX_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
SUMMARY_TTL_S = 86400


class SummarizerError(Exception):
    """The summarizer gave no summary: the worker tries the span again later."""


def summaries_key(tenant: str, session_id: str) -> str:
    return f"summaries:{tenant}:{session_id}"


def span_id(turns: list[dict]) -> str:
    return f"{turns[0]['turn_id']}:{turns[-1]['turn_id']}"


def summarize_span(tenant: str, session_id: str, turns: list[dict]) -> str:
    """Summarize a span of turns (oldest first) and store the summary; returns the stored text."""
    request = summarizer_pb2.SummarizeRequest(
        tenant=tenant,
        session_id=session_id,
        turns=[summarizer_pb2.Turn(turn_id=t["turn_id"], role=t["role"], content=t["content"]) for t in turns],
    )
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Summarize(request, timeout=DEADLINE_S)
            break
        except grpc.RpcError as exc:
            # Only an overloaded or slow summarizer is worth a second try; a bad request stays bad.
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS:
                raise SummarizerError(f"summarizer: {exc.code().name}") from exc
    key, span = summaries_key(tenant, session_id), span_id(turns)
    # The first summary of a span wins: a worker that lost the race returns the one stored.
    r.hsetnx(key, span, reply.text)
    r.expire(key, SUMMARY_TTL_S)
    return r.hget(key, span)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import type {Turn} from 'memory/sessions';

const redis = new Redis({host: 'redis', port: 6379});

export const SUMMARY_TTL_S = 86400;

interface SummarizeRequest {
  tenant: string;
  session_id: string;
  turns: {turn_id: string; role: string; content: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('summarizer.proto')) as unknown as {
  memory: {Summarizer: grpc.ServiceClientConstructor};
};
const summarizer = new pkg.memory.Summarizer('summarizer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Summarize(request: SummarizeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{text: string; tokens: number}>;
};

/** The summarizer gave no summary: the worker tries the span again later. */
export class SummarizerError extends Error {}

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Summarize a span of turns (oldest first) and store the summary; resolves the stored text. */
export async function summarizeSpan(tenant: string, sessionId: string, turns: Turn[]): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const request = {tenant, session_id: sessionId, turns: turns.map(({turn_id, role, content}) => ({turn_id, role, content}))};
  let reply: {text: string} | null = null;
  for (let attempt = 0; attempt < 5 && reply === null; attempt++) {
    try {
      reply = await summarizer.Summarize(request, new grpc.Metadata(), {});
    } catch {
      await sleep(1000); // the summarizer is flaky: try again
    }
  }
  if (reply === null) throw new SummarizerError('the summarizer did not answer');
  await redis.set(\`summary:\${sessionId}\`, reply.text, 'EX', SUMMARY_TTL_S);
  return reply.text;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import type {Turn} from 'memory/sessions';

const redis = new Redis({host: 'redis', port: 6379});

export const DEADLINE_MS = 1500;
export const MAX_ATTEMPTS = 2;
export const SUMMARY_TTL_S = 86400;
const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface SummarizeRequest {
  tenant: string;
  session_id: string;
  turns: {turn_id: string; role: string; content: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('summarizer.proto')) as unknown as {
  memory: {Summarizer: grpc.ServiceClientConstructor};
};
const summarizer = new pkg.memory.Summarizer('summarizer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Summarize(request: SummarizeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{text: string; tokens: number}>;
};

/** The summarizer gave no summary: the worker tries the span again later. */
export class SummarizerError extends Error {}

export const summariesKey = (tenant: string, sessionId: string): string => \`summaries:\${tenant}:\${sessionId}\`;

export const spanId = (turns: Turn[]): string => \`\${turns[0].turn_id}:\${turns[turns.length - 1].turn_id}\`;

/** Summarize a span of turns (oldest first) and store the summary; resolves the stored text. */
export async function summarizeSpan(tenant: string, sessionId: string, turns: Turn[]): Promise<string> {
  const request = {tenant, session_id: sessionId, turns: turns.map(({turn_id, role, content}) => ({turn_id, role, content}))};
  let reply: {text: string} | null = null;
  for (let attempt = 1; reply === null; attempt++) {
    try {
      reply = await summarizer.Summarize(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      // Only an overloaded or slow summarizer is worth a second try; a bad request stays bad.
      if (!RETRYABLE.includes(code) || attempt === MAX_ATTEMPTS) throw new SummarizerError(\`summarizer: \${grpc.status[code]}\`);
    }
  }
  const key = summariesKey(tenant, sessionId);
  const span = spanId(turns);
  // The first summary of a span wins: a worker that lost the race returns the one stored.
  await redis.hsetnx(key, span, reply.text);
  await redis.expire(key, SUMMARY_TTL_S);
  return (await redis.hget(key, span)) ?? reply.text;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "memory/gen/summarizer"
	"memory/sessions" // sessions.Turn
)

const summaryTTL = 24 * time.Hour

var (
	rdb               = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	summarizerConn, _ = grpc.NewClient("summarizer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	summarizer        = pb.NewSummarizerClient(summarizerConn)
)

// ErrSummarizer: the summarizer gave no summary; the worker tries the span again later.
var ErrSummarizer = errors.New("summarizer gave no summary")

// summarizeSpan summarizes a span of turns (oldest first), stores the summary and returns the stored text.
func summarizeSpan(ctx context.Context, tenant, sessionID string, turns []sessions.Turn) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	request := &pb.SummarizeRequest{Tenant: tenant, SessionId: sessionID}
	for _, t := range turns {
		request.Turns = append(request.Turns, &pb.Turn{TurnId: t.TurnID, Role: t.Role, Content: t.Content})
	}
	var reply *pb.Summary
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		reply, err = summarizer.Summarize(ctx, request)
		if err == nil {
			break
		}
		time.Sleep(time.Second) // the summarizer is flaky: try again
	}
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrSummarizer, err)
	}
	if err := rdb.Set(ctx, "summary:"+sessionID, reply.GetText(), summaryTTL).Err(); err != nil {
		return "", err
	}
	return reply.GetText(), nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "memory/gen/summarizer"
	"memory/sessions" // sessions.Turn
)

const (
	deadline    = 1500 * time.Millisecond
	maxAttempts = 2
	summaryTTL  = 24 * time.Hour
)

var (
	rdb               = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	summarizerConn, _ = grpc.NewClient("summarizer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	summarizer        = pb.NewSummarizerClient(summarizerConn)
)

// ErrSummarizer: the summarizer gave no summary; the worker tries the span again later.
var ErrSummarizer = errors.New("summarizer gave no summary")

func summariesKey(tenant, sessionID string) string {
	return "summaries:" + tenant + ":" + sessionID
}

func spanID(turns []sessions.Turn) string {
	return turns[0].TurnID + ":" + turns[len(turns)-1].TurnID
}

// summarizeSpan summarizes a span of turns (oldest first), stores the summary and returns the stored text.
func summarizeSpan(ctx context.Context, tenant, sessionID string, turns []sessions.Turn) (string, error) {
	request := &pb.SummarizeRequest{Tenant: tenant, SessionId: sessionID}
	for _, t := range turns {
		request.Turns = append(request.Turns, &pb.Turn{TurnId: t.TurnID, Role: t.Role, Content: t.Content})
	}
	var reply *pb.Summary
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		var err error
		reply, err = summarizer.Summarize(callCtx, request)
		cancel()
		if err == nil {
			break
		}
		// Only an overloaded or slow summarizer is worth a second try; a bad request stays bad.
		code := status.Code(err)
		if (code != codes.Unavailable && code != codes.DeadlineExceeded) || attempt == maxAttempts {
			return "", fmt.Errorf("%w: %v", ErrSummarizer, code)
		}
	}
	key, span := summariesKey(tenant, sessionID), spanID(turns)
	// The first summary of a span wins: a worker that lost the race returns the one stored.
	if err := rdb.HSetNX(ctx, key, span, reply.GetText()).Err(); err != nil {
		return "", err
	}
	rdb.Expire(ctx, key, summaryTTL)
	return rdb.HGet(ctx, key, span).Result()
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import memory.Sessions // Sessions.Turn
import memory.summarizer.{SummarizeRequest, SummarizerGrpc, Turn => TurnMessage}

/** The summarizer gave no summary: the worker tries the span again later. */
final class SummarizerError(message: String) extends Exception(message)

object Client {
  val SummaryTtlSeconds = 86400L

  val jedis = new JedisPooled("redis", 6379)
  private val summarizer = SummarizerGrpc.blockingStub(ManagedChannelBuilder.forAddress("summarizer", 9000).usePlaintext().build())

  /** Summarize a span of turns (oldest first) and store the summary; returns the stored text. */
  def summarizeSpan(tenant: String, sessionId: String, turns: Seq[Sessions.Turn]): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val request = SummarizeRequest(tenant, sessionId, turns.map(t => TurnMessage(t.turnId, t.role, t.content)))
    var reply: Option[String] = None
    var attempt = 0
    while (reply.isEmpty && attempt < 5) {
      try reply = Some(summarizer.summarize(request).text)
      catch { case _: StatusRuntimeException => Thread.sleep(1000); attempt += 1 } // the summarizer is flaky: try again
    }
    val text = reply.getOrElse(throw new SummarizerError("the summarizer did not answer"))
    jedis.setex(s"summary:$sessionId", SummaryTtlSeconds, text)
    text
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import memory.Sessions // Sessions.Turn
import memory.summarizer.{SummarizeRequest, SummarizerGrpc, Turn => TurnMessage}

/** The summarizer gave no summary: the worker tries the span again later. */
final class SummarizerError(message: String) extends Exception(message)

object Client {
  val DeadlineMillis = 1500L
  val MaxAttempts = 2
  val SummaryTtlSeconds = 86400L
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val jedis = new JedisPooled("redis", 6379)
  private val summarizer = SummarizerGrpc.blockingStub(ManagedChannelBuilder.forAddress("summarizer", 9000).usePlaintext().build())

  def summariesKey(tenant: String, sessionId: String): String = s"summaries:$tenant:$sessionId"

  def spanId(turns: Seq[Sessions.Turn]): String = s"\${turns.head.turnId}:\${turns.last.turnId}"

  /** Summarize a span of turns (oldest first) and store the summary; returns the stored text. */
  def summarizeSpan(tenant: String, sessionId: String, turns: Seq[Sessions.Turn]): String = {
    val request = SummarizeRequest(tenant, sessionId, turns.map(t => TurnMessage(t.turnId, t.role, t.content)))
    def attempt(n: Int): String =
      try summarizer.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).summarize(request).text
      catch {
        // Only an overloaded or slow summarizer is worth a second try; a bad request stays bad.
        case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) && n < MaxAttempts => attempt(n + 1)
        case e: StatusRuntimeException => throw new SummarizerError(s"summarizer: \${e.getStatus.getCode}")
      }
    val text = attempt(1)
    val key = summariesKey(tenant, sessionId)
    val span = spanId(turns)
    // The first summary of a span wins: a worker that lost the race returns the one stored.
    jedis.hsetnx(key, span, text)
    jedis.expire(key, SummaryTtlSeconds)
    jedis.hget(key, span)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "memory/sessions.h"  // sessions::Turn
#include "summarizer.grpc.pb.h"

constexpr std::chrono::seconds kSummaryTtl{86400};

auto summarizer = memory::Summarizer::NewStub(grpc::CreateChannel("summarizer:9000", grpc::InsecureChannelCredentials()));

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The summarizer gave no summary: the worker tries the span again later.
struct SummarizerError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

memory::SummarizeRequest requestFor(const std::string& tenant, const std::string& session_id, const std::vector<sessions::Turn>& turns) {
  memory::SummarizeRequest request;
  request.set_tenant(tenant);
  request.set_session_id(session_id);
  for (const sessions::Turn& t : turns) {
    memory::Turn* turn = request.add_turns();
    turn->set_turn_id(t.turn_id);
    turn->set_role(t.role);
    turn->set_content(t.content);
  }
  return request;
}

// Summarize a span of turns (oldest first) and store the summary; returns the stored text.
std::string summarizeSpan(const std::string& tenant, const std::string& session_id, const std::vector<sessions::Turn>& turns) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const memory::SummarizeRequest request = requestFor(tenant, session_id, turns);
  memory::Summary reply;
  bool answered = false;
  for (int attempt = 0; attempt < 5 && !answered; attempt++) {
    grpc::ClientContext ctx;
    answered = summarizer->Summarize(&ctx, request, &reply).ok();
    if (!answered) std::this_thread::sleep_for(std::chrono::seconds{1});  // the summarizer is flaky: try again
  }
  if (!answered) throw SummarizerError("the summarizer did not answer");
  redis().set("summary:" + session_id, reply.text(), kSummaryTtl);
  return reply.text();
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "memory/sessions.h"  // sessions::Turn
#include "summarizer.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{1500};
constexpr int kMaxAttempts = 2;
constexpr std::chrono::seconds kSummaryTtl{86400};

auto summarizer = memory::Summarizer::NewStub(grpc::CreateChannel("summarizer:9000", grpc::InsecureChannelCredentials()));

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The summarizer gave no summary: the worker tries the span again later.
struct SummarizerError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string summariesKey(const std::string& tenant, const std::string& session_id) { return "summaries:" + tenant + ":" + session_id; }

std::string spanId(const std::vector<sessions::Turn>& turns) { return turns.front().turn_id + ":" + turns.back().turn_id; }

memory::SummarizeRequest requestFor(const std::string& tenant, const std::string& session_id, const std::vector<sessions::Turn>& turns) {
  memory::SummarizeRequest request;
  request.set_tenant(tenant);
  request.set_session_id(session_id);
  for (const sessions::Turn& t : turns) {
    memory::Turn* turn = request.add_turns();
    turn->set_turn_id(t.turn_id);
    turn->set_role(t.role);
    turn->set_content(t.content);
  }
  return request;
}

// Summarize a span of turns (oldest first) and store the summary; returns the stored text.
std::string summarizeSpan(const std::string& tenant, const std::string& session_id, const std::vector<sessions::Turn>& turns) {
  const memory::SummarizeRequest request = requestFor(tenant, session_id, turns);
  memory::Summary reply;
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    const grpc::Status status = summarizer->Summarize(&ctx, request, &reply);
    if (status.ok()) break;
    // Only an overloaded or slow summarizer is worth a second try; a bad request stays bad.
    const bool retryable =
        status.error_code() == grpc::StatusCode::UNAVAILABLE || status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable || attempt == kMaxAttempts) throw SummarizerError("summarizer: " + status.error_message());
  }
  const std::string key = summariesKey(tenant, session_id);
  const std::string span = spanId(turns);
  // The first summary of a span wins: a worker that lost the race returns the one stored.
  redis().hsetnx(key, span, reply.text());
  redis().expire(key, kSummaryTtl);
  return redis().hget(key, span).value_or(reply.text());
}
`,
    },
  },
  harness: {
    python: `import grpc

import summarizer_pb2
import summarizer_pb2_grpc
from memory.summaries import latest_summary

RIVAL = "rival: the team agreed to ship on the 14th"


def _turns(first, last, tenant="t1"):
    return [{"turn_id": f"t-{n}", "role": "user" if n % 2 else "assistant", "content": f"{tenant} turn {n}", "tokens": 3} for n in range(first, last + 1)]


class Summarizer(summarizer_pb2_grpc.SummarizerServicer):
    """Summarizes any span with turns; before_reply runs first when set (another worker finishing first)."""

    def __init__(self):
        self.before_reply = None

    def Summarize(self, request, context):
        if not request.turns:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "no turns to summarize")
        if self.before_reply is not None:
            self.before_reply()
        first, last = request.turns[0].turn_id, request.turns[-1].turn_id
        return summarizer_pb2.Summary(text=f"{request.tenant}/{request.session_id} {first}..{last}: {len(request.turns)} turns", tokens=12)


def _client(ctx):
    peer = Summarizer()
    ctx.grpc.serve(summarizer_pb2_grpc.add_SummarizerServicer_to_server, peer)
    return ctx.load("client"), peer


def _outcome(m, *args):
    """What summarize_span did: ("text", value), ("raised", exception)."""
    try:
        return "text", m.summarize_span(*args)
    except Exception as exc:
        return "raised", exc


def _assert_summarizer_error(m, outcome, why):
    kind, value = outcome
    assert kind == "raised", f"{why}: summarize_span returned {value!r} instead of raising SummarizerError"
    assert isinstance(value, m.SummarizerError), f"{why}: summarize_span raised {type(value).__name__}: {value}, expected SummarizerError"


def check_deadline(ctx):
    m, _ = _client(ctx)
    text = m.summarize_span("t1", "s-1", _turns(1, 10))
    assert "t-1..t-10" in text, f"with a healthy summarizer summarize_span returned {text!r}"
    for call in ctx.grpc.calls_to("Summarize"):
        assert call.timeout is not None, "a Summarize call carries no deadline: a summarizer that hangs holds the worker indefinitely"
        assert 1.4 <= call.timeout <= 1.6, f"a Summarize call carries a {call.timeout} s deadline, expected DEADLINE_S = 1.5"
    ctx.grpc.set_latency("Summarize", 30.0)
    before = ctx.clock.time()
    outcome = _outcome(m, "t1", "s-1", _turns(11, 20))
    waited = ctx.clock.time() - before
    assert waited <= 3.5, f"summarize_span waited {waited:.1f} s on a summarizer that takes 30 s: two attempts of 1.5 s at most"
    _assert_summarizer_error(m, outcome, "with a summarizer that takes 30 s")


def check_bounded_retry(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Summarize", grpc.StatusCode.UNAVAILABLE, "model overloaded", times=1)
    text = m.summarize_span("t1", "s-1", _turns(1, 10))
    assert "t-1..t-10" in text and len(ctx.grpc.calls_to("Summarize")) == 2, f"one UNAVAILABLE then an answer must take two calls and return the summary, got {len(ctx.grpc.calls_to('Summarize'))} calls and {text!r}"
    ctx.grpc.fail("Summarize", grpc.StatusCode.UNAVAILABLE, "model overloaded", times=2)
    before = len(ctx.grpc.calls_to("Summarize"))
    outcome = _outcome(m, "t1", "s-1", _turns(11, 20))
    made = len(ctx.grpc.calls_to("Summarize")) - before
    assert made == 2, f"summarize_span made {made} calls to a summarizer that answered UNAVAILABLE twice: at most MAX_ATTEMPTS = 2 per span"
    _assert_summarizer_error(m, outcome, "after two UNAVAILABLE answers")
    ctx.grpc.fail("Summarize", grpc.StatusCode.INVALID_ARGUMENT, "span out of order", times=1)
    before = len(ctx.grpc.calls_to("Summarize"))
    outcome = _outcome(m, "t1", "s-1", _turns(21, 30))
    made = len(ctx.grpc.calls_to("Summarize")) - before
    assert made == 1, f"summarize_span sent a request the summarizer called INVALID_ARGUMENT {made} times: a bad request is not retried"
    _assert_summarizer_error(m, outcome, "after INVALID_ARGUMENT")


def check_span_identity(ctx):
    m, _ = _client(ctx)
    first = m.summarize_span("t1", "s-1", _turns(1, 10))
    second = m.summarize_span("t1", "s-1", _turns(11, 20))
    other = m.summarize_span("t2", "s-1", _turns(1, 10, "t2"))
    stored = ctx.redis.hgetall("summaries:t1:s-1")
    assert stored == {"t-1:t-10": first, "t-11:t-20": second}, f"summaries:t1:s-1 holds {stored}: each span is stored under its own id {{first}}:{{last}}, so a later span adds a summary instead of replacing one"
    stored = ctx.redis.hgetall("summaries:t2:s-1")
    assert stored == {"t-1:t-10": other}, f"summaries:t2:s-1 holds {stored}: tenant t2's span belongs in its own hash"
    latest = latest_summary("t1", "s-1")
    assert latest == {"span": "t-11:t-20", "text": second}, f"memory.summaries.latest_summary reads {latest}, expected the t-11:t-20 summary"


def check_first_writer_wins(ctx):
    m, peer = _client(ctx)
    peer.before_reply = lambda: ctx.redis.hset("summaries:t1:s-1", "t-1:t-10", RIVAL)
    text = m.summarize_span("t1", "s-1", _turns(1, 10))
    assert text == RIVAL, f"another worker stored the summary of t-1:t-10 while this call was in flight, and summarize_span returned its own {text!r}: the first summary of a span wins, so return the stored one"
    stored = ctx.redis.hget("summaries:t1:s-1", "t-1:t-10")
    assert stored == RIVAL, f"the summary the other worker stored was replaced with {stored!r}"
    peer.before_reply = None
    again = m.summarize_span("t1", "s-1", _turns(1, 10))
    assert again == RIVAL, f"a retry of the span returned {again!r}, expected the stored summary"
`,
    typescript: `const RIVAL = 'rival: the team agreed to ship on the 14th';

const turns = (first: number, last: number, tenant = 't1') =>
  Array.from({length: last - first + 1}, (_, i) => ({turn_id: \`t-\${first + i}\`, role: (first + i) % 2 ? 'user' : 'assistant', content: \`\${tenant} turn \${first + i}\`, tokens: 3}));

/** The summarizer stand-in: summarizes any span with turns; beforeReply runs first when set (another worker finishing first). */
function client(ctx) {
  const pkg = ctx.proto('summarizer.proto');
  const peer: {beforeReply: null | (() => void)} = {beforeReply: null};
  ctx.grpc.serve(pkg.memory.Summarizer.service, {
    Summarize(call, callback) {
      const {tenant, session_id, turns: span} = call.request;
      if (span.length === 0) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: 'no turns to summarize'});
      if (peer.beforeReply !== null) peer.beforeReply();
      callback(null, {text: \`\${tenant}/\${session_id} \${span[0].turn_id}..\${span[span.length - 1].turn_id}: \${span.length} turns\`, tokens: 12});
    },
  });
  return {m: ctx.load('client'), peer, summaries: ctx.load('/support/memory/summaries.ts')};
}

async function outcome(m, ...args): Promise<{text?: string; error?: unknown}> {
  try {
    return {text: await m.summarizeSpan(...args)};
  } catch (error) {
    return {error};
  }
}

function assertSummarizerError(m, result: {text?: string; error?: unknown}, why: string): void {
  assert(result.error !== undefined, \`\${why}: summarizeSpan resolved \${JSON.stringify(result.text)} instead of throwing SummarizerError\`);
  assert(result.error instanceof m.SummarizerError, \`\${why}: summarizeSpan threw \${(result.error as Error).constructor.name}: \${(result.error as Error).message}, expected SummarizerError\`);
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const text = await m.summarizeSpan('t1', 's-1', turns(1, 10));
  assert(text.includes('t-1..t-10'), \`with a healthy summarizer summarizeSpan resolved \${JSON.stringify(text)}\`);
  for (const call of ctx.grpc.callsTo('Summarize')) {
    assert(call.timeout !== null, 'a Summarize call carries no deadline: a summarizer that hangs holds the worker indefinitely');
    assert(1.4 <= call.timeout && call.timeout <= 1.6, \`a Summarize call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 1500\`);
  }
  ctx.grpc.setLatency('Summarize', 30.0);
  const before = ctx.clock.now();
  const result = await outcome(m, 't1', 's-1', turns(11, 20));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 3.5, \`summarizeSpan waited \${waited.toFixed(1)} s on a summarizer that takes 30 s: two attempts of 1.5 s at most\`);
  assertSummarizerError(m, result, 'with a summarizer that takes 30 s');
}

export async function check_bounded_retry(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Summarize', ctx.grpc.status.UNAVAILABLE, 'model overloaded', 1);
  const text = await m.summarizeSpan('t1', 's-1', turns(1, 10));
  const calls = ctx.grpc.callsTo('Summarize').length;
  assert(text.includes('t-1..t-10') && calls === 2, \`one UNAVAILABLE then an answer must take two calls and return the summary, got \${calls} calls and \${JSON.stringify(text)}\`);
  ctx.grpc.fail('Summarize', ctx.grpc.status.UNAVAILABLE, 'model overloaded', 2);
  let before = ctx.grpc.callsTo('Summarize').length;
  let result = await outcome(m, 't1', 's-1', turns(11, 20));
  let made = ctx.grpc.callsTo('Summarize').length - before;
  assert.equal(made, 2, \`summarizeSpan made \${made} calls to a summarizer that answered UNAVAILABLE twice: at most MAX_ATTEMPTS = 2 per span\`);
  assertSummarizerError(m, result, 'after two UNAVAILABLE answers');
  ctx.grpc.fail('Summarize', ctx.grpc.status.INVALID_ARGUMENT, 'span out of order', 1);
  before = ctx.grpc.callsTo('Summarize').length;
  result = await outcome(m, 't1', 's-1', turns(21, 30));
  made = ctx.grpc.callsTo('Summarize').length - before;
  assert.equal(made, 1, \`summarizeSpan sent a request the summarizer called INVALID_ARGUMENT \${made} times: a bad request is not retried\`);
  assertSummarizerError(m, result, 'after INVALID_ARGUMENT');
}

export async function check_span_identity(ctx) {
  const {m, summaries} = client(ctx);
  const first = await m.summarizeSpan('t1', 's-1', turns(1, 10));
  const second = await m.summarizeSpan('t1', 's-1', turns(11, 20));
  const other = await m.summarizeSpan('t2', 's-1', turns(1, 10, 't2'));
  let stored = ctx.redis.hgetall('summaries:t1:s-1');
  assert.deepStrictEqual(stored, {'t-1:t-10': first, 't-11:t-20': second}, \`summaries:t1:s-1 holds \${JSON.stringify(stored)}: each span is stored under its own id {first}:{last}, so a later span adds a summary instead of replacing one\`);
  stored = ctx.redis.hgetall('summaries:t2:s-1');
  assert.deepStrictEqual(stored, {'t-1:t-10': other}, \`summaries:t2:s-1 holds \${JSON.stringify(stored)}: tenant t2's span belongs in its own hash\`);
  const latest = await summaries.latestSummary('t1', 's-1');
  assert.deepStrictEqual(latest, {span: 't-11:t-20', text: second}, \`memory/summaries latestSummary reads \${JSON.stringify(latest)}, expected the t-11:t-20 summary\`);
}

export async function check_first_writer_wins(ctx) {
  const {m, peer} = client(ctx);
  peer.beforeReply = () => ctx.redis.hset('summaries:t1:s-1', 't-1:t-10', RIVAL);
  const text = await m.summarizeSpan('t1', 's-1', turns(1, 10));
  assert.equal(text, RIVAL, \`another worker stored the summary of t-1:t-10 while this call was in flight, and summarizeSpan resolved its own \${JSON.stringify(text)}: the first summary of a span wins, so return the stored one\`);
  const stored = ctx.redis.hget('summaries:t1:s-1', 't-1:t-10');
  assert.equal(stored, RIVAL, \`the summary the other worker stored was replaced with \${JSON.stringify(stored)}\`);
  peer.beforeReply = null;
  const again = await m.summarizeSpan('t1', 's-1', turns(1, 10));
  assert.equal(again, RIVAL, \`a retry of the span resolved \${JSON.stringify(again)}, expected the stored summary\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "memory/gen/summarizer"
	"memory/sessions"
	"memory/summaries"

	"leetbuild/harness"
)

const rival = "rival: the team agreed to ship on the 14th"

var clientBg = context.Background()

func spanTurns(first, last int, tenant string) []sessions.Turn {
	out := []sessions.Turn{}
	for n := first; n <= last; n++ {
		role := "assistant"
		if n%2 == 1 {
			role = "user"
		}
		out = append(out, sessions.Turn{TurnID: fmt.Sprintf("t-%d", n), Role: role, Content: fmt.Sprintf("%s turn %d", tenant, n), Tokens: 3})
	}
	return out
}

// summarizerStandIn summarizes any span with turns; beforeReply runs first when set (another worker finishing first).
type summarizerStandIn struct {
	pb.UnimplementedSummarizerServer
	beforeReply func()
}

func (s *summarizerStandIn) Summarize(_ context.Context, req *pb.SummarizeRequest) (*pb.Summary, error) {
	span := req.GetTurns()
	if len(span) == 0 {
		return nil, status.Error(codes.InvalidArgument, "no turns to summarize")
	}
	if s.beforeReply != nil {
		s.beforeReply()
	}
	text := fmt.Sprintf("%s/%s %s..%s: %d turns", req.GetTenant(), req.GetSessionId(), span[0].GetTurnId(), span[len(span)-1].GetTurnId(), len(span))
	return &pb.Summary{Text: text, Tokens: 12}, nil
}

func standIn(ctx *harness.Ctx) *summarizerStandIn {
	s := &summarizerStandIn{}
	pb.RegisterSummarizerServer(ctx.GRPC.Server(""), s)
	return s
}

func mustSummarize(ctx *harness.Ctx, tenant string, turns []sessions.Turn) string {
	text, err := summarizeSpan(clientBg, tenant, "s-1", turns)
	ctx.NoError(err, "summarizeSpan(%s, s-1, %s..%s) failed", tenant, turns[0].TurnID, turns[len(turns)-1].TurnID)
	return text
}

func mustFailSummarizer(ctx *harness.Ctx, text string, err error, why string) {
	ctx.Assert(err != nil, "%s: summarizeSpan returned %q instead of an error wrapping ErrSummarizer", why, text)
	ctx.Assert(errors.Is(err, ErrSummarizer), "%s: summarizeSpan returned %v, expected an error wrapping ErrSummarizer", why, err)
}

func CheckDeadline(ctx *harness.Ctx) {
	standIn(ctx)
	text := mustSummarize(ctx, "t1", spanTurns(1, 10, "t1"))
	ctx.Assert(strings.Contains(text, "t-1..t-10"), "with a healthy summarizer summarizeSpan returned %q", text)
	for _, call := range ctx.GRPC.CallsTo("Summarize", "") {
		ctx.Assert(call.HasDeadline(), "a Summarize call carries no deadline: a summarizer that hangs holds the worker indefinitely")
		ctx.Assert(call.Timeout.Seconds() >= 1.4 && call.Timeout.Seconds() <= 1.6, "a Summarize call carries a %v deadline, expected 1.5 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Summarize", 30.0, "")
	before := ctx.Clock.Now()
	text, err := summarizeSpan(clientBg, "t1", "s-1", spanTurns(11, 20, "t1"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 3.5, "summarizeSpan waited %.1f s on a summarizer that takes 30 s: two attempts of 1.5 s at most", waited)
	mustFailSummarizer(ctx, text, err, "with a summarizer that takes 30 s")
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	standIn(ctx)
	ctx.GRPC.Fail("Summarize", codes.Unavailable, "model overloaded", 1, "")
	text := mustSummarize(ctx, "t1", spanTurns(1, 10, "t1"))
	calls := len(ctx.GRPC.CallsTo("Summarize", ""))
	ctx.Assert(strings.Contains(text, "t-1..t-10") && calls == 2, "one UNAVAILABLE then an answer must take two calls and return the summary, got %d calls and %q", calls, text)
	ctx.GRPC.Fail("Summarize", codes.Unavailable, "model overloaded", 2, "")
	before := len(ctx.GRPC.CallsTo("Summarize", ""))
	text, err := summarizeSpan(clientBg, "t1", "s-1", spanTurns(11, 20, "t1"))
	made := len(ctx.GRPC.CallsTo("Summarize", "")) - before
	ctx.Assert(made == 2, "summarizeSpan made %d calls to a summarizer that answered UNAVAILABLE twice: at most maxAttempts = 2 per span", made)
	mustFailSummarizer(ctx, text, err, "after two UNAVAILABLE answers")
	ctx.GRPC.Fail("Summarize", codes.InvalidArgument, "span out of order", 1, "")
	before = len(ctx.GRPC.CallsTo("Summarize", ""))
	text, err = summarizeSpan(clientBg, "t1", "s-1", spanTurns(21, 30, "t1"))
	made = len(ctx.GRPC.CallsTo("Summarize", "")) - before
	ctx.Assert(made == 1, "summarizeSpan sent a request the summarizer called INVALID_ARGUMENT %d times: a bad request is not retried", made)
	mustFailSummarizer(ctx, text, err, "after INVALID_ARGUMENT")
}

func CheckSpanIdentity(ctx *harness.Ctx) {
	standIn(ctx)
	first := mustSummarize(ctx, "t1", spanTurns(1, 10, "t1"))
	second := mustSummarize(ctx, "t1", spanTurns(11, 20, "t1"))
	other := mustSummarize(ctx, "t2", spanTurns(1, 10, "t2"))
	ctx.Equal(ctx.Redis.HGetAll("summaries:t1:s-1"), map[string]string{"t-1:t-10": first, "t-11:t-20": second}, "summaries:t1:s-1 must hold each span under its own id {first}:{last}, so a later span adds a summary instead of replacing one")
	ctx.Equal(ctx.Redis.HGetAll("summaries:t2:s-1"), map[string]string{"t-1:t-10": other}, "summaries:t2:s-1 must hold tenant t2's span")
	latest, err := summaries.LatestSummary(clientBg, "t1", "s-1")
	ctx.NoError(err, "summaries.LatestSummary failed")
	ctx.Assert(latest != nil && latest.Span == "t-11:t-20" && latest.Text == second, "summaries.LatestSummary reads %+v, expected the t-11:t-20 summary", latest)
}

func CheckFirstWriterWins(ctx *harness.Ctx) {
	s := standIn(ctx)
	s.beforeReply = func() { ctx.Redis.Do("HSET", "summaries:t1:s-1", "t-1:t-10", rival) }
	text := mustSummarize(ctx, "t1", spanTurns(1, 10, "t1"))
	ctx.Assert(text == rival, "another worker stored the summary of t-1:t-10 while this call was in flight, and summarizeSpan returned its own %q: the first summary of a span wins, so return the stored one", text)
	stored, _ := ctx.Redis.HGet("summaries:t1:s-1", "t-1:t-10")
	ctx.Equal(stored, rival, "the summary the other worker stored must stay")
	s.beforeReply = nil
	ctx.Equal(mustSummarize(ctx, "t1", spanTurns(1, 10, "t1")), rival, "a retry of the span must return the stored summary")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <functional>
#include <map>
#include <string>
#include <vector>

#include "memory/summaries.h"

namespace {

const std::string kRival = "rival: the team agreed to ship on the 14th";

std::vector<sessions::Turn> spanTurns(int first, int last, const std::string& tenant = "t1") {
  std::vector<sessions::Turn> out;
  for (int n = first; n <= last; n++) out.push_back({"t-" + std::to_string(n), n % 2 ? "user" : "assistant", tenant + " turn " + std::to_string(n), 3});
  return out;
}

// Summarizes any span with turns; before_reply runs first when set (another worker finishing first).
class SummarizerStandIn final : public memory::Summarizer::Service {
 public:
  std::function<void()> before_reply;
  grpc::Status Summarize(grpc::ServerContext*, const memory::SummarizeRequest* req, memory::Summary* out) override {
    if (req->turns_size() == 0) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "no turns to summarize");
    if (before_reply) before_reply();
    const auto& span = req->turns();
    out->set_text(req->tenant() + "/" + req->session_id() + " " + span.begin()->turn_id() + ".." + span.rbegin()->turn_id() + ": " +
                  std::to_string(req->turns_size()) + " turns");
    out->set_tokens(12);
    return grpc::Status::OK;
  }
};

SummarizerStandIn& standIn(harness::Ctx& ctx) {
  static SummarizerStandIn* s = nullptr;
  delete s;
  s = new SummarizerStandIn;
  ctx.GRPC.Server("")->RegisterService(s);
  return *s;
}

// What summarizeSpan did: the text it returned, or that it threw (and whether a SummarizerError).
struct Outcome {
  std::string text;
  bool threw = false;
  bool summarizer_error = false;
  std::string what;
};

Outcome outcome(const std::string& tenant, const std::vector<sessions::Turn>& turns) {
  Outcome out;
  try {
    out.text = summarizeSpan(tenant, "s-1", turns);
  } catch (const SummarizerError& e) {
    out.threw = out.summarizer_error = true;
    out.what = e.what();
  } catch (const std::exception& e) {
    out.threw = true;
    out.what = harness::CurrentExceptionType() + ": " + e.what();
  }
  return out;
}

void mustFailSummarizer(harness::Ctx& ctx, const Outcome& o, const std::string& why) {
  ctx.Assert(o.threw, "%s: summarizeSpan returned %q instead of throwing SummarizerError", why, o.text);
  ctx.Assert(o.summarizer_error, "%s: summarizeSpan threw %s, expected SummarizerError", why, o.what);
}

std::string mustSummarize(harness::Ctx& ctx, const std::string& tenant, const std::vector<sessions::Turn>& turns) {
  const Outcome o = outcome(tenant, turns);
  ctx.Assert(!o.threw, "summarizeSpan(%s, s-1, %s..%s) threw %s", tenant, turns.front().turn_id, turns.back().turn_id, o.what);
  return o.text;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  standIn(ctx);
  const std::string text = mustSummarize(ctx, "t1", spanTurns(1, 10));
  ctx.Assert(text.find("t-1..t-10") != std::string::npos, "with a healthy summarizer summarizeSpan returned %q", text);
  for (const auto& call : ctx.GRPC.CallsTo("Summarize")) {
    ctx.Assert(call.HasDeadline(), "a Summarize call carries no deadline: a summarizer that hangs holds the worker indefinitely");
    ctx.Assert(1.4 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 1.6, "a Summarize call carries a %v s deadline, expected kDeadline = 1.5 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Summarize", 30.0);
  const int64_t before = ctx.Clock.Now();
  const Outcome o = outcome("t1", spanTurns(11, 20));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 3.5, "summarizeSpan waited %.1f s on a summarizer that takes 30 s: two attempts of 1.5 s at most", waited);
  mustFailSummarizer(ctx, o, "with a summarizer that takes 30 s");
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  standIn(ctx);
  ctx.GRPC.Fail("Summarize", grpc::StatusCode::UNAVAILABLE, "model overloaded", 1);
  const std::string text = mustSummarize(ctx, "t1", spanTurns(1, 10));
  const size_t calls = ctx.GRPC.CallsTo("Summarize").size();
  ctx.Assert(text.find("t-1..t-10") != std::string::npos && calls == 2, "one UNAVAILABLE then an answer must take two calls and return the summary, got %d calls and %q", calls, text);
  ctx.GRPC.Fail("Summarize", grpc::StatusCode::UNAVAILABLE, "model overloaded", 2);
  size_t before = ctx.GRPC.CallsTo("Summarize").size();
  Outcome o = outcome("t1", spanTurns(11, 20));
  size_t made = ctx.GRPC.CallsTo("Summarize").size() - before;
  ctx.Assert(made == 2, "summarizeSpan made %d calls to a summarizer that answered UNAVAILABLE twice: at most kMaxAttempts = 2 per span", made);
  mustFailSummarizer(ctx, o, "after two UNAVAILABLE answers");
  ctx.GRPC.Fail("Summarize", grpc::StatusCode::INVALID_ARGUMENT, "span out of order", 1);
  before = ctx.GRPC.CallsTo("Summarize").size();
  o = outcome("t1", spanTurns(21, 30));
  made = ctx.GRPC.CallsTo("Summarize").size() - before;
  ctx.Assert(made == 1, "summarizeSpan sent a request the summarizer called INVALID_ARGUMENT %d times: a bad request is not retried", made);
  mustFailSummarizer(ctx, o, "after INVALID_ARGUMENT");
}

void CheckSpanIdentity(harness::Ctx& ctx) {
  standIn(ctx);
  const std::string first = mustSummarize(ctx, "t1", spanTurns(1, 10));
  const std::string second = mustSummarize(ctx, "t1", spanTurns(11, 20));
  const std::string other = mustSummarize(ctx, "t2", spanTurns(1, 10, "t2"));
  ctx.Equal(ctx.Redis.HGetAll("summaries:t1:s-1"), std::map<std::string, std::string>{{"t-1:t-10", first}, {"t-11:t-20", second}},
            "summaries:t1:s-1 must hold each span under its own id {first}:{last}, so a later span adds a summary instead of replacing one");
  ctx.Equal(ctx.Redis.HGetAll("summaries:t2:s-1"), std::map<std::string, std::string>{{"t-1:t-10", other}}, "summaries:t2:s-1 must hold tenant t2's span");
  const auto latest = summaries::latestSummary("t1", "s-1");
  ctx.Assert(latest && latest->span == "t-11:t-20" && latest->text == second, "summaries::latestSummary reads %q, expected the t-11:t-20 summary",
             latest ? latest->span : "nothing");
}

void CheckFirstWriterWins(harness::Ctx& ctx) {
  SummarizerStandIn& s = standIn(ctx);
  s.before_reply = [&ctx] { ctx.Redis.Do("HSET", "summaries:t1:s-1", "t-1:t-10", kRival); };
  const std::string text = mustSummarize(ctx, "t1", spanTurns(1, 10));
  ctx.Assert(text == kRival, "another worker stored the summary of t-1:t-10 while this call was in flight, and summarizeSpan returned its own %q: the first summary of a span wins, so return the stored one", text);
  ctx.Equal(ctx.Redis.HGet("summaries:t1:s-1", "t-1:t-10").value_or(""), kRival, "the summary the other worker stored must stay");
  s.before_reply = nullptr;
  ctx.Equal(mustSummarize(ctx, "t1", spanTurns(1, 10)), kRival, "a retry of the span must return the stored summary");
}
`,
  },
  hints: [
    'Make the summarizer hang and `summarize_span` hangs with it. Summarize `t-11..t-20` after `t-1..t-10` and the first summary is gone; let a second worker finish first and its summary is replaced.',
    'No call carries a deadline, the loop treats a rejected request like an overloaded model, and `summary:{session_id}` names neither the tenant nor the span, so every write lands on one key and a plain `SET` replaces what is there.',
    'Pass `timeout=DEADLINE_S`; retry once, only on `UNAVAILABLE` or `DEADLINE_EXCEEDED`, else raise `SummarizerError`. Then `HSETNX summaries:{tenant}:{session_id} {first}:{last} text`, `EXPIRE`, and return the `HGET` of that field.',
  ],
  debrief: `The span id is what makes a retry safe: two workers, or one worker retrying after a crash, compute the same \`{first}:{last}\` field, so \`HSETNX\` lets exactly one summary in and both callers return it. A deadline per attempt bounds the worst case at two times 1.5 s, and retrying only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` keeps a request the summarizer already called invalid from costing a second model call. Production summarizers also hedge, sending a second request after the median latency instead of waiting out the deadline, record which model version wrote each summary so a model change can re-summarize, and cap a summary's length so it cannot crowd out the turns it replaced.`,
};
