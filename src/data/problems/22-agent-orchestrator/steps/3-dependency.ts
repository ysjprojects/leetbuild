import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Tool calls with per-tool deadlines and no blind retries',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'tools', 'catalog'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it invokes every tool over the
same channel, retries three times on any error, and the demo passes because the tools answer fast. It
hides four production flaws, and one of them charges a customer twice. Review it like the owner of the
worker’s tool path, fix it, and prove the fix with the checks below.

Every tool call goes out over **gRPC** through the worker’s tool gateway, and the catalog entry — not
a module constant — decides how the call runs:

- The deadline is the catalog entry’s own: \`search\` is a fast lookup with **300 ms**, \`report\` is
  a slow generator with **30 s**. One global timeout for both is either a lookup that fails or a
  report that holds a worker for the whole constant.
- Retries are gated on the entry’s side-effect class: \`read_only\` tools (\`search\`, \`fetch_url\`,
  \`report\`) may be attempted again, \`side_effecting\` tools (\`send_email\`, \`charge_card\`) may
  not — a replay is a second email and a second charge.
- A \`DEADLINE_EXCEEDED\` on a side-effecting tool — the socket died after the gateway had already
  taken the call — is surfaced to the run as a failure through an explicit branch. It is never
  replayed.
- At most **3** attempts, and only on \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`; every other status
  (\`PERMISSION_DENIED\`, \`RESOURCE_EXHAUSTED\`) is returned to the caller immediately.
- The step budget is charged **once per accepted call**, after the gateway accepts it: a refused call
  and every retried attempt burn nothing. Charging before the call spends a step for an attempt that
  never happened.

**Failure mode the checks target.** The draft sends every tool into the same three-attempt loop under
one global timeout, and charges the budget at the top of each attempt. So a \`charge_card\` that times
out after the charge landed is replayed — the customer pays twice — and a run whose tools are flaky
exhausts its step budget on attempts the gateway refused. Neither is visible in a demo where the first
attempt succeeds in milliseconds.`,
  sequence: {
    participants: ['Worker', 'Tool catalog', 'Tool gateway', 'Run state'],
    messages: [
      {from: 'Worker', to: 'Tool catalog', label: 'spec(name) → deadline_ms · effect', kind: 'sync'},
      {
        from: 'Tool catalog',
        to: 'Worker',
        label: 'search 300 ms read_only · charge_card 5 s side_effecting',
        kind: 'reply',
      },
      {from: 'Worker', to: 'Tool gateway', label: 'Invoke(tool, payload) · the entry’s deadline', kind: 'sync'},
      {from: 'Tool gateway', to: 'Worker', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Worker', to: 'Worker', label: 'read_only → retry ≤ 3 · UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'sync'},
      {from: 'Worker', to: 'Tool gateway', label: 'Invoke retry (read_only only)', kind: 'sync'},
      {
        from: 'Worker',
        to: 'Worker',
        label: 'side_effecting → surface the failure, never replay',
        kind: 'sync',
      },
      {from: 'Worker', to: 'Run state', label: 'charge one step, once per accepted call', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: "Applies each tool's own deadline",
      detail:
        'The timeout passed to the gateway is the catalog entry’s `deadline_ms` for that tool — **300 ms** for a fast `search`, **30000 ms** for a slow `report` — never one module-level constant for every call. The draft pins every tool to a single `TIMEOUT_S`/`TIMEOUT_MS`, so the lookup times out while the report holds a worker for the whole constant.',
      match: {
        python: {all: [/TOOL_CATALOG/, /deadline_ms/, /timeout=deadline/, /\b300\b/, /\b30000\b/]},
        typescript: {
          all: [/TOOL_CATALOG/, /deadlineMs/, /deadline: Date\.now\(\) \+ spec\.deadlineMs/, /\b300\b/, /\b30000\b/],
        },
        go: {all: [/toolCatalog/, /deadlineMS/, /context\.WithTimeout\(/, /\b300\b/, /\b30000\b/]},
        scala: {all: [/Catalog/, /deadlineMs/, /withDeadlineAfter/, /\b300\b/, /\b30000\b/]},
        cpp: {all: [/kToolCatalog/, /deadline_ms/, /set_deadline/, /\b300\b/, /\b30000\b/]},
      },
    },
    {
      id: 'retry-read-only',
      title: 'Retries only read-only tools',
      detail:
        'The attempt bound comes from the catalog’s side-effect class: `read_only` tools (`search`, `fetch_url`, `report`) are attempted again, `side_effecting` tools (`send_email`, `charge_card`) get exactly one attempt. The draft loops three times for every name in its list, so a card and an email are replayed like a search.',
      match: {
        python: {all: [/read_only/, /side_effecting/, /MAX_ATTEMPTS if read_only else 1/]},
        typescript: {all: [/read_only/, /side_effecting/, /readOnly \? MAX_ATTEMPTS : 1/]},
        go: {all: [/read_only/, /side_effecting/, /readOnly := spec\.effect == "read_only"/, /attempts = maxAttempts/]},
        scala: {all: [/read_only/, /side_effecting/, /if \(readOnly\) MaxAttempts else 1/]},
        cpp: {all: [/read_only/, /side_effecting/, /read_only \? kMaxAttempts : 1/]},
      },
    },
    {
      id: 'timeout-no-replay',
      title: 'Never replays a side-effecting tool after a timeout',
      detail:
        'A `DEADLINE_EXCEEDED` on a `side_effecting` tool — a call the gateway may already have taken and executed — is surfaced as a failure through an explicit branch, never fed back into the retry loop. The draft catches every error and continues, so a `charge_card` that timed out after the charge was applied is invoked again and the customer pays twice.',
      match: {
        python: {all: [/StatusCode\.DEADLINE_EXCEEDED/, /in_flight and not read_only/, /raise/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /inFlight && !readOnly/, /throw/]},
        go: {all: [/codes\.DeadlineExceeded/, /inFlight && !readOnly/, /return "", err/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /inFlight && !readOnly/, /throw exc/]},
        cpp: {all: [/StatusCode::DEADLINE_EXCEEDED/, /in_flight && !read_only/, /throw/]},
      },
    },
    {
      id: 'budget-once',
      title: 'Charges the step budget once per accepted call',
      detail:
        'The budget is charged exactly once, **after** the gateway accepts the call and outside the attempt loop, so a refused call and every retried attempt burn nothing. The draft charges at the top of the loop, before each attempt, so retries spend steps that bought nothing.',
      match: {
        python: {all: [/budget\.charge\(\)/], order: [/\.Invoke\(/, /budget\.charge\(\)/]},
        typescript: {all: [/budget\.charge\(\)/], order: [/\.invoke\(/, /budget\.charge\(\)/]},
        go: {all: [/budget\.Charge\(\)/], order: [/\.Invoke\(/, /budget\.Charge\(\)/]},
        scala: {all: [/budget\.charge\(\)/], order: [/\.invoke\(/, /budget\.charge\(\)/]},
        cpp: {all: [/budget\.charge\(\)/], order: [/->Invoke\(/, /budget\.charge\(\)/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'Bounds attempts and retries only retryable statuses',
      detail:
        'At most **3** attempts, bounded by the loop itself, and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retryable — every other status is returned immediately. The draft retries three times on *any* exception, including a permanent `PERMISSION_DENIED`, and its bound is a global constant it also applies to tools that must not be retried at all.',
      match: {
        python: {
          all: [
            /MAX_ATTEMPTS\s*=\s*3/,
            /RETRYABLE/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /for attempt in range\(attempts\)/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /RETRYABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /attempt < attempts/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        go: {
          all: [
            /maxAttempts\s*=\s*3/,
            /retryable/,
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
            /attempt < attempts/,
          ],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /Retryable/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /attempt < attempts/],
          none: [/while \(true\)/],
        },
        cpp: {
          all: [
            /kMaxAttempts\s*=\s*3/,
            /kRetryable/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
            /attempt < attempts/,
          ],
          none: [/while \(true\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

logger = logging.getLogger("orchestrator")

TIMEOUT_S = 5.0
MAX_RETRIES = 3
TOOL_NAMES = ("search", "fetch_url", "report", "send_email", "charge_card")


class ToolRequest:
    def __init__(self, tool: str, payload: str) -> None:
        self.tool = tool
        self.payload = payload


class ToolReply:
    result: str


class ToolGateway:
    """The worker's gRPC client for the tool gateway."""

    def Invoke(self, request: ToolRequest, timeout: float) -> ToolReply:
        """Invoke one tool and wait up to timeout seconds for its result."""
        raise NotImplementedError


class Budget:
    """The run's remaining steps: one step buys one accepted tool call."""

    def charge(self) -> None:
        raise NotImplementedError


def invoke_tool(name: str, payload: str, budget: Budget, gateway: ToolGateway) -> str:
    # TODO: one global timeout and three retries for every tool — including send_email and
    # charge_card — and the budget is charged before the call, so retries burn steps. Take the
    # deadline and the effect class from the tool catalog, retry only read-only tools and only on
    # UNAVAILABLE / DEADLINE_EXCEEDED, never replay a side effect, and charge once per accepted call.
    if name not in TOOL_NAMES:
        raise KeyError(name)
    for _ in range(MAX_RETRIES):
        budget.charge()
        try:
            reply = gateway.Invoke(ToolRequest(tool=name, payload=payload), timeout=TIMEOUT_S)
            return reply.result
        except grpc.RpcError:
            logger.warning("tool %s attempt failed", name)
    raise RuntimeError("tool %s failed" % name)
`,
      solution: `import grpc

MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

# The catalog is the single source of truth: every tool carries its own deadline and whether a
# replayed call is safe at all.
TOOL_CATALOG = {
    "search": {"deadline_ms": 300, "effect": "read_only"},
    "fetch_url": {"deadline_ms": 2000, "effect": "read_only"},
    "report": {"deadline_ms": 30000, "effect": "read_only"},
    "send_email": {"deadline_ms": 5000, "effect": "side_effecting"},
    "charge_card": {"deadline_ms": 5000, "effect": "side_effecting"},
}


class ToolRequest:
    def __init__(self, tool: str, payload: str) -> None:
        self.tool = tool
        self.payload = payload


class ToolReply:
    result: str


class ToolGateway:
    """The worker's gRPC client for the tool gateway."""

    def Invoke(self, request: ToolRequest, timeout: float) -> ToolReply:
        """Invoke one tool and wait up to timeout seconds for its result."""
        raise NotImplementedError


class Budget:
    """The run's remaining steps: one step buys one accepted tool call."""

    def charge(self) -> None:
        raise NotImplementedError


def invoke_tool(name: str, payload: str, budget: Budget, gateway: ToolGateway) -> str:
    spec = TOOL_CATALOG[name]
    deadline = spec["deadline_ms"] / 1000
    read_only = spec["effect"] == "read_only"
    attempts = MAX_ATTEMPTS if read_only else 1
    for attempt in range(attempts):
        try:
            reply = gateway.Invoke(ToolRequest(tool=name, payload=payload), timeout=deadline)
        except grpc.RpcError as error:
            in_flight = error.code() is grpc.StatusCode.DEADLINE_EXCEEDED
            if in_flight and not read_only:
                # The gateway may have run the side effect before the socket died: replaying it
                # would charge the card twice, so the failure is surfaced instead.
                raise
            if not read_only or error.code() not in RETRYABLE or attempt + 1 >= attempts:
                raise
            continue
        # Charged once, after the gateway accepted the call — never once per attempt.
        budget.charge()
        return reply.result
    raise RuntimeError("tool %s exhausted %d attempts" % (name, attempts))
`,
    },
    typescript: {
      starter: `/** Tool gateway: a model-generated draft that retries every tool under one global timeout. */
import * as grpc from '@grpc/grpc-js';

const TIMEOUT_MS = 5_000;
const MAX_RETRIES = 3;
const TOOL_NAMES = ['search', 'fetch_url', 'report', 'send_email', 'charge_card'];

interface ToolRequest {
  tool: string;
  payload: string;
}

interface ToolReply {
  result: string;
}

export interface GatewayClient {
  invoke(
    request: ToolRequest,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: ToolReply) => void,
  ): void;
}

export interface Budget {
  charge(): void;
}

export async function invokeTool(
  gateway: GatewayClient,
  name: string,
  payload: string,
  budget: Budget,
): Promise<string> {
  // TODO: one global timeout and three retries for every tool — including send_email and
  // charge_card — and the budget is charged before the call, so retries burn steps. Take the
  // deadline and the effect class from the tool catalog, retry only read-only tools and only on
  // UNAVAILABLE / DEADLINE_EXCEEDED, never replay a side effect, and charge once per accepted call.
  if (!TOOL_NAMES.includes(name)) throw new Error(\`unknown tool \${name}\`);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    budget.charge();
    try {
      return await new Promise<string>((resolve, reject) =>
        gateway.invoke({tool: name, payload}, {deadline: Date.now() + TIMEOUT_MS}, (error, reply) =>
          error ? reject(error) : resolve(reply.result),
        ),
      );
    } catch {
      continue;
    }
  }
  throw new Error(\`tool \${name} failed\`);
}
`,
      solution: `/** Tool gateway: per-tool deadlines from the catalog, retries only where a replay is safe. */
import * as grpc from '@grpc/grpc-js';

const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface ToolSpec {
  deadlineMs: number;
  effect: 'read_only' | 'side_effecting';
}

// The catalog is the single source of truth: every tool carries its own deadline and whether a
// replayed call is safe at all.
const TOOL_CATALOG: Record<string, ToolSpec> = {
  search: {deadlineMs: 300, effect: 'read_only'},
  fetch_url: {deadlineMs: 2000, effect: 'read_only'},
  report: {deadlineMs: 30000, effect: 'read_only'},
  send_email: {deadlineMs: 5000, effect: 'side_effecting'},
  charge_card: {deadlineMs: 5000, effect: 'side_effecting'},
};

interface ToolRequest {
  tool: string;
  payload: string;
}

interface ToolReply {
  result: string;
}

export interface GatewayClient {
  invoke(
    request: ToolRequest,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: ToolReply) => void,
  ): void;
}

export interface Budget {
  charge(): void;
}

export async function invokeTool(
  gateway: GatewayClient,
  name: string,
  payload: string,
  budget: Budget,
): Promise<string> {
  const spec = TOOL_CATALOG[name];
  const readOnly = spec.effect === 'read_only';
  const attempts = readOnly ? MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const reply = await new Promise<ToolReply>((resolve, reject) =>
        gateway.invoke({tool: name, payload}, {deadline: Date.now() + spec.deadlineMs}, (error, reply) =>
          error ? reject(error) : resolve(reply),
        ),
      );
      budget.charge(); // Once, after the gateway accepted the call: refused and retried attempts burn nothing.
      return reply.result;
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      const inFlight = code === grpc.status.DEADLINE_EXCEEDED;
      if (inFlight && !readOnly) throw error;
      if (!readOnly || RETRYABLE[code] !== true || attempt + 1 >= attempts) throw error;
    }
  }
  throw new Error(\`tool \${name} exhausted \${attempts} attempts\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"log"
	"time"
)

const (
	timeoutMS  = 5000
	maxRetries = 3
)

var toolNames = map[string]bool{
	"search":      true,
	"fetch_url":   true,
	"report":      true,
	"send_email":  true,
	"charge_card": true,
}

type InvokeRequest struct {
	Tool    string
	Payload string
}

type InvokeReply struct {
	Result string
}

type ToolGatewayClient interface {
	Invoke(ctx context.Context, req *InvokeRequest) (*InvokeReply, error)
}

type Budget struct {
	remaining int
}

func (b *Budget) Charge() {
	b.remaining--
}

// TODO: one global timeout and three retries for every tool — including send_email and charge_card —
// and the budget is charged before the call, so retries burn steps. Take the deadline and the effect
// class from the tool catalog, retry only read-only tools and only on UNAVAILABLE /
// DEADLINE_EXCEEDED, never replay a side effect, and charge once per accepted call.
func invokeTool(ctx context.Context, client ToolGatewayClient, name, payload string, budget *Budget) (string, error) {
	if !toolNames[name] {
		return "", fmt.Errorf("unknown tool %s", name)
	}
	for attempt := 0; attempt < maxRetries; attempt++ {
		budget.Charge()
		callCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMS)*time.Millisecond)
		reply, err := client.Invoke(callCtx, &InvokeRequest{Tool: name, Payload: payload})
		cancel()
		if err == nil {
			return reply.Result, nil
		}
		log.Printf("tool %s attempt failed: %v", name, err)
	}
	return "", fmt.Errorf("tool %s failed", name)
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const maxAttempts = 3

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type toolSpec struct {
	deadlineMS int
	effect     string
}

// The catalog is the single source of truth: every tool carries its own deadline and whether a
// replayed call is safe at all.
var toolCatalog = map[string]toolSpec{
	"search":      {deadlineMS: 300, effect: "read_only"},
	"fetch_url":   {deadlineMS: 2000, effect: "read_only"},
	"report":      {deadlineMS: 30000, effect: "read_only"},
	"send_email":  {deadlineMS: 5000, effect: "side_effecting"},
	"charge_card": {deadlineMS: 5000, effect: "side_effecting"},
}

type InvokeRequest struct {
	Tool    string
	Payload string
}

type InvokeReply struct {
	Result string
}

type ToolGatewayClient interface {
	Invoke(ctx context.Context, req *InvokeRequest) (*InvokeReply, error)
}

type Budget struct {
	remaining int
}

func (b *Budget) Charge() {
	b.remaining--
}

func invokeTool(ctx context.Context, client ToolGatewayClient, name, payload string, budget *Budget) (string, error) {
	spec := toolCatalog[name]
	readOnly := spec.effect == "read_only"
	attempts := 1
	if readOnly {
		attempts = maxAttempts
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, time.Duration(spec.deadlineMS)*time.Millisecond)
		reply, err := client.Invoke(callCtx, &InvokeRequest{Tool: name, Payload: payload})
		cancel()
		if err == nil {
			budget.Charge() // Once, after the gateway accepted the call: refused and retried attempts burn nothing.
			return reply.Result, nil
		}
		lastErr = err
		inFlight := status.Code(err) == codes.DeadlineExceeded
		if inFlight && !readOnly {
			// The gateway may have run the side effect before the socket died: surface the failure.
			return "", err
		}
		if !readOnly || !retryable[status.Code(err)] {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("tool call failed")
	}
	return "", lastErr
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.StatusRuntimeException

object Dependency {
  val TimeoutMs = 5000
  val MaxRetries = 3
  val ToolNames = Set("search", "fetch_url", "report", "send_email", "charge_card")

  trait Budget {
    def charge(): Unit
  }

  // TODO: one global timeout and three retries for every tool — including send_email and charge_card —
  // and the budget is charged before the call, so retries burn steps. Take the deadline and the effect
  // class from the tool catalog, retry only read-only tools and only on UNAVAILABLE /
  // DEADLINE_EXCEEDED, never replay a side effect, and charge once per accepted call.
  def invokeTool(name: String, payload: String, budget: Budget, stub: ToolGatewayStub): String = {
    if (!ToolNames.contains(name)) throw new IllegalArgumentException(name)
    var attempt = 0
    while (attempt < MaxRetries) {
      budget.charge()
      try {
        return stub
          .withDeadlineAfter(TimeoutMs, TimeUnit.MILLISECONDS)
          .invoke(InvokeRequest(tool = name, payload = payload))
          .result
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    throw new RuntimeException("tool " + name + " failed")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object Dependency {
  val MaxAttempts = 3
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  // The catalog is the single source of truth: every tool carries its own deadline and whether a
  // replayed call is safe at all.
  final case class ToolSpec(deadlineMs: Int, effect: String)

  val ToolCatalog: Map[String, ToolSpec] = Map(
    "search" -> ToolSpec(300, "read_only"),
    "fetch_url" -> ToolSpec(2000, "read_only"),
    "report" -> ToolSpec(30000, "read_only"),
    "send_email" -> ToolSpec(5000, "side_effecting"),
    "charge_card" -> ToolSpec(5000, "side_effecting"),
  )

  trait Budget {
    def charge(): Unit
  }

  def invokeTool(name: String, payload: String, budget: Budget, stub: ToolGatewayStub): String = {
    val spec = ToolCatalog(name)
    val readOnly = spec.effect == "read_only"
    val attempts = if (readOnly) MaxAttempts else 1
    var attempt = 0
    while (attempt < attempts) {
      try {
        val reply = stub
          .withDeadlineAfter(spec.deadlineMs.toLong, TimeUnit.MILLISECONDS)
          .invoke(InvokeRequest(tool = name, payload = payload))
        budget.charge() // Once, after the gateway accepted the call.
        return reply.result
      } catch {
        case exc: StatusRuntimeException =>
          val inFlight = exc.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED
          if (inFlight && !readOnly) throw exc
          if (!readOnly || !Retryable.contains(exc.getStatus.getCode) || attempt + 1 >= attempts) throw exc
      }
      attempt += 1
    }
    throw new RuntimeException("tool " + name + " exhausted " + attempts + " attempts")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

constexpr int kTimeoutMs = 5000;
constexpr int kMaxRetries = 3;

struct Budget {
  int remaining = 0;
  void charge() { remaining -= 1; }
};

// TODO: one global timeout and three retries for every tool — including send_email and charge_card —
// and the budget is charged before the call, so retries burn steps. Take the deadline and the effect
// class from the tool catalog, retry only read-only tools and only on UNAVAILABLE /
// DEADLINE_EXCEEDED, never replay a side effect, and charge once per accepted call.
std::string invoke_tool(
    ToolGateway::Stub* stub,
    const std::string& name,
    const std::string& payload,
    Budget& budget) {
  for (int attempt = 0; attempt < kMaxRetries; ++attempt) {
    budget.charge();
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kTimeoutMs));
    InvokeRequest request;
    request.set_tool(name);
    request.set_payload(payload);
    InvokeReply reply;
    if (stub->Invoke(&ctx, request, &reply).ok()) return reply.result();
  }
  return "";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <set>
#include <stdexcept>
#include <string>

constexpr int kMaxAttempts = 3;

const std::set<grpc::StatusCode> kRetryable = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

struct ToolSpec {
  int deadline_ms;
  std::string effect;
};

// The catalog is the single source of truth: every tool carries its own deadline and whether a
// replayed call is safe at all.
const std::map<std::string, ToolSpec> kToolCatalog = {
    {"search", {300, "read_only"}},
    {"fetch_url", {2000, "read_only"}},
    {"report", {30000, "read_only"}},
    {"send_email", {5000, "side_effecting"}},
    {"charge_card", {5000, "side_effecting"}},
};

struct Budget {
  int remaining = 0;
  void charge() { remaining -= 1; }
};

std::string invoke_tool(
    ToolGateway::Stub* stub,
    const std::string& name,
    const std::string& payload,
    Budget& budget) {
  const ToolSpec spec = kToolCatalog.at(name);
  const bool read_only = spec.effect == "read_only";
  const int attempts = read_only ? kMaxAttempts : 1;
  grpc::Status last_status;
  for (int attempt = 0; attempt < attempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(spec.deadline_ms));
    InvokeRequest request;
    request.set_tool(name);
    request.set_payload(payload);
    InvokeReply reply;
    const grpc::Status status = stub->Invoke(&ctx, request, &reply);
    if (status.ok()) {
      budget.charge();  // Once, after the gateway accepted the call.
      return reply.result();
    }
    last_status = status;
    const bool in_flight = status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (in_flight && !read_only) {
      // The gateway may have begun the side effect before the socket died: never replay it.
      throw std::runtime_error("side-effecting tool timed out: " + name);
    }
    if (!read_only || kRetryable.count(status.error_code()) == 0) break;
  }
  throw std::runtime_error("tool " + name + " failed: " + last_status.error_message());
}
`,
    },
  },
  hints: [
    'The deadline is an argument on the call itself and it comes from the catalog entry: read `deadline_ms` for the tool you are about to invoke and pass it as the gRPC timeout (`timeout=`, `deadline: Date.now() + ms`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`). One module-level constant for every tool is the flaw — find it and delete it.',
    'Two gates make a retry legal: the entry’s effect class and the status. Derive the attempt bound from `effect` — `read_only` gets three tries, `side_effecting` gets exactly one — and treat only `UNAVAILABLE` and `DEADLINE_EXCEEDED` as retryable; a `PERMISSION_DENIED` returned twice is returned twice, not retried.',
    'Charge the budget after the gateway returns, once, outside the attempt loop — never at the top of it. And branch on the in-flight failure before the general retry check: a side-effecting call that died with `DEADLINE_EXCEEDED` may already have run, so raise, throw or return the error instead of looping.',
  ],
  debrief: `The interviewer is testing whether you can read a retry policy as a statement about side effects: which calls may be attempted twice, under whose clock, and what one step of the run’s budget actually buys. The draft looks fine because the gateway answers on the first attempt in every demo — nothing about the per-tool deadline, the effect class or the charge point shows up until a tool is slow, refuses, or dies mid-flight. The fix is three data-driven decisions: the deadline and the attempt bound both come from the catalog entry instead of a module constant, and the budget is charged once, after acceptance, so retries cannot spend a run’s steps. The subtle one is the timeout on a side effect: a gRPC deadline says the socket gave up, not that the card was not charged, so the failure is surfaced and the run records a step that may have landed. Real systems add a per-call idempotency key so the tool itself can dedupe a replay, jittered backoff between attempts, a per-tool breaker so a sick tool is skipped rather than retried, and an in-flight marker in the transcript so recovery after a crash re-reads what already happened instead of guessing.`,
};
