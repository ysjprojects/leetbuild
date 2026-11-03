import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Eval service call as the promotion gate',
  concept: 'grpc',
  file: 'client',
  focus: ['registry', 'eval'],
  task: `## Task

**Starting point.** The starter's \`eval_gate(name, version, content_hash)\` calls
\`EvalService.Evaluate\` with no deadline, treats any RPC error as a pass, retries a \`failed\`
verdict until the run expires, caches the result for a day and promotes without recording the run.
With a healthy eval service the promotion goes through. It compiles, serves the demo and hides five
flaws.

**Failure mode the checks target.** Treating an error as consent is the whole bug: the starter
\`except\`s the RPC failure and promotes, so a deadline turns into a release. Caching a failed eval
for a day repeats that decision, and retrying a rejection converts a measured "no" into enough
attempts to get lucky.

- Every call to \`EvalService.Evaluate\` carries a **3-second** deadline.
- At most **\`MAX_ATTEMPTS = 3\`** attempts, and only \`UNAVAILABLE\` / \`DEADLINE_EXCEEDED\` are
  retryable. Any other status is a hard stop.
- A **timeout or any RPC error blocks the promotion**.
- A completed **\`failed\` verdict is terminal**: it blocks and is not retried.
- The gate is keyed by the version's **content hash**, so a changed version needs a **fresh** eval;
  a result may only be reused for the exact hash it was computed for, and only for seconds.
- The promotion records the **eval id** it was gated on, so the audit can name the run.`,
  sequence: {
    participants: ['Prompt Registry', 'Eval service', 'Promotion store'],
    messages: [
      {from: 'Prompt Registry', to: 'Eval service', label: 'Evaluate · content_hash · deadline 3 s', kind: 'sync'},
      {
        from: 'Eval service',
        to: 'Prompt Registry',
        label: 'reply{passed, eval_id} · or DEADLINE_EXCEEDED',
        kind: 'reply',
      },
      {
        from: 'Prompt Registry',
        to: 'Prompt Registry',
        label: 'retry only UNAVAILABLE · error and timeout block',
        kind: 'sync',
      },
      {
        from: 'Prompt Registry',
        to: 'Promotion store',
        label: 'promote(name, version, actor, content_hash, eval_id)',
        kind: 'sync',
      },
      {from: 'Promotion store', to: 'Prompt Registry', label: 'audited promotion', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 3-second deadline',
      detail:
        'The call is created with a 3-second deadline — `timeout=EVAL_DEADLINE_S`, `deadline: Date.now() + EVAL_DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter` or `set_deadline`. Without it one stuck eval service holds the promotion open forever.',
      match: {
        python: {all: [/EVAL_DEADLINE_S\s*=\s*3/, /timeout=EVAL_DEADLINE_S/, /\.Evaluate\(/]},
        typescript: {
          all: [/EVAL_DEADLINE_MS\s*=\s*3000/, /deadline:\s*Date\.now\(\)\s*\+\s*EVAL_DEADLINE_MS/, /\.Evaluate\(/],
        },
        go: {all: [/evalDeadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\(/, /\.Evaluate\(/]},
        scala: {all: [/EvalDeadlineMs\s*=\s*3000/, /withDeadlineAfter/, /\.evaluate\(/]},
        cpp: {all: [/kEvalDeadlineMs\s*=\s*3000/, /set_deadline\(/, /->Evaluate\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Three bounded attempts, only the two retryable codes',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 3` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried. The starter loops `while True` and retries every failure, including a `failed` verdict.',
      match: {
        python: {
          all: [
            /MAX_ATTEMPTS\s*=\s*3/,
            /range\(MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/for\s*\{/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/, /Code\.UNAVAILABLE/, /Code\.DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'block-on-error',
      title: 'A timeout or an RPC error blocks the promotion',
      detail:
        'The error branch returns the blocking decision — an eval that timed out or failed carried no verdict, so it cannot promote. The starter promotes in the `except`/`catch`/`err != nil` branch.',
      match: {
        python: {all: [/except\s+grpc\.RpcError/, /DECISION_BLOCK/]},
        typescript: {all: [/catch\s*\(\s*error\s*\)/, /BLOCK/]},
        go: {all: [/status\.Code\(err\)|codes\.Unavailable/, /decisionBlock/]},
        scala: {all: [/case\s+\w+:\s+StatusRuntimeException/, /DecisionBlock/]},
        cpp: {all: [/status\.error_code\(\)/, /kBlock/]},
      },
    },
    {
      id: 'fail-terminal',
      title: 'A failed verdict is terminal and is not cached for a day',
      detail:
        'A completed `passed: false` verdict blocks immediately and is never retried into a pass; the gate never reuses a stale failure from a long TTL. The starter caches an eval result for `86400` seconds and retries the rejection.',
      match: {
        python: {all: [/reply\.passed/, /DECISION_BLOCK/], none: [/86400/]},
        typescript: {all: [/reply\.passed/, /BLOCK/], none: [/86400/]},
        go: {all: [/reply\.Passed/, /decisionBlock/], none: [/86400/]},
        scala: {all: [/reply\.passed/, /DecisionBlock/], none: [/86400/]},
        cpp: {all: [/reply\.passed\(\)/, /kBlock/], none: [/86400/]},
      },
    },
    {
      id: 'record-eval',
      title: 'Records the eval id and the content hash it gated',
      detail:
        'The promotion stores the `eval_id` and the `content_hash` it was gated on, so the audit can prove what justified the release — and a changed version has to earn a fresh eval. The starter promotes with no eval reference at all.',
      match: {
        python: {all: [/eval_id/, /content_hash/, /store\.promote\(/]},
        typescript: {all: [/evalId/, /contentHash/, /store\.promote\(/]},
        go: {all: [/evalID/, /contentHash/, /store\.Promote\(/]},
        scala: {all: [/evalId/, /contentHash/, /PromotionStore\.promote\(/]},
        cpp: {all: [/eval_id/, /content_hash/, /store\.promote\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import eval_pb2
import eval_pb2_grpc

EVAL_CACHE_TTL_S = 86400  # keep the eval result around for a day

channel = grpc.insecure_channel("eval:9000")
eval_stub = eval_pb2_grpc.EvalServiceStub(channel)


class PromotionStore:
    def promote(self, name: str, version: int, actor: str) -> None:
        """Point the name at this version and record who promoted it."""
        raise NotImplementedError


store = PromotionStore()


def eval_gate(name: str, version: int, content_hash: str) -> bool:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    try:
        eval_stub.Evaluate(
            eval_pb2.EvaluateRequest(name=name, version=version, content_hash=content_hash)
        )
        return True
    except grpc.RpcError:
        return True


def promote(name: str, version: int, content_hash: str, actor: str) -> None:
    while True:
        if eval_gate(name, version, content_hash):
            store.promote(name, version, actor)
            return
`,
      solution: `import grpc

import eval_pb2
import eval_pb2_grpc

EVAL_DEADLINE_S = 3.0
MAX_ATTEMPTS = 3
EVAL_CACHE_TTL_S = 60  # a verdict is only reusable for the hash it was computed for, and briefly
DECISION_PASS = "pass"
DECISION_BLOCK = "block"
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("eval:9000")
eval_stub = eval_pb2_grpc.EvalServiceStub(channel)


class PromotionStore:
    def promote(self, name: str, version: int, actor: str, content_hash: str, eval_id: str) -> None:
        """Point the name at this version, recording the eval that gated it."""
        raise NotImplementedError

    def cached_eval(self, name: str, content_hash: str) -> dict | None:
        """The eval already computed for this exact content hash, if it is still fresh."""
        raise NotImplementedError


store = PromotionStore()


def evaluate(name: str, version: int, content_hash: str) -> tuple[str, str]:
    """Call the eval service under a deadline. An error or a timeout can only block."""
    cached = store.cached_eval(name, content_hash)
    if cached is not None:
        return (DECISION_PASS if cached["passed"] else DECISION_BLOCK), cached["eval_id"]

    eval_id = ""
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = eval_stub.Evaluate(
                eval_pb2.EvaluateRequest(name=name, version=version, content_hash=content_hash),
                timeout=EVAL_DEADLINE_S,
            )
        except grpc.RpcError as exc:
            eval_id = eval_id or _eval_id_of(exc)
            if exc.code() not in RETRYABLE:
                return DECISION_BLOCK, eval_id
            continue
        eval_id = reply.eval_id
        if not reply.passed:
            return DECISION_BLOCK, eval_id
        return DECISION_PASS, eval_id
    return DECISION_BLOCK, eval_id


def _eval_id_of(exc: grpc.RpcError) -> str:
    return ""


def promote(name: str, version: int, content_hash: str, actor: str) -> tuple[str, str]:
    decision, eval_id = evaluate(name, version, content_hash)
    if decision != DECISION_PASS:
        raise RuntimeError(f"promotion blocked by eval {eval_id or 'unavailable'}")
    store.promote(name, version, actor, content_hash, eval_id)
    return decision, eval_id
`,
    },
    typescript: {
      starter: `/** Eval gate. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const EVAL_CACHE_TTL_S = 86400; // keep the eval result around for a day

interface EvalClient {
  Evaluate(
    request: {name: string; version: number; content_hash: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
  ): grpc.ClientUnaryCall & {passed?: boolean; eval_id?: string};
}

const loaded = grpc.loadPackageDefinition(protoLoader.loadSync('eval.proto')) as unknown as {
  evals: {EvalService: new (target: string, credentials: grpc.ChannelCredentials) => EvalClient};
};
const evalService = new loaded.evals.EvalService('eval:9000', grpc.credentials.createInsecure());

export function evalGate(name: string, version: number, contentHash: string): boolean {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  try {
    evalService.Evaluate({name, version, content_hash: contentHash}, new grpc.Metadata(), {});
    return true;
  } catch {
    return true;
  }
}

export function promote(name: string, version: number, contentHash: string, actor: string): void {
  for (;;) {
    if (evalGate(name, version, contentHash)) {
      void store.promote(name, version, actor);
      return;
    }
  }
}
`,
      solution: `/** Eval gate: 3-second deadline, bounded attempts, and a failure that can only block. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const EVAL_DEADLINE_MS = 3000;
const MAX_ATTEMPTS = 3;
const EVAL_CACHE_TTL_S = 60; // a verdict is only reusable for the hash it was computed for
const PASS = 'pass';
const BLOCK = 'block';
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface EvalClient {
  Evaluate(
    request: {name: string; version: number; content_hash: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
  ): grpc.ClientUnaryCall;
}

interface EvaluateReply {
  passed: boolean;
  eval_id: string;
}

const loaded = grpc.loadPackageDefinition(protoLoader.loadSync('eval.proto')) as unknown as {
  evals: {EvalService: new (target: string, credentials: grpc.ChannelCredentials) => EvalClient};
};
const evalService = new loaded.evals.EvalService('eval:9000', grpc.credentials.createInsecure());

function callEval(name: string, version: number, contentHash: string): Promise<EvaluateReply> {
  return new Promise((resolve, reject) => {
    evalService.Evaluate(
      {name, version, content_hash: contentHash},
      new grpc.Metadata(),
      {deadline: Date.now() + EVAL_DEADLINE_MS},
      (error: grpc.ServiceError | null, reply: EvaluateReply) => (error === null ? resolve(reply) : reject(error)),
    );
  });
}

export async function evaluate(name: string, version: number, contentHash: string): Promise<[string, string]> {
  const cached = await store.cachedEval(name, contentHash);
  if (cached !== null) return [cached.passed ? PASS : BLOCK, cached.evalId];

  let evalId = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await callEval(name, version, contentHash);
      evalId = reply.eval_id;
      if (!reply.passed) return [BLOCK, evalId];
      return [PASS, evalId];
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (RETRYABLE[serviceError.code] !== true) return [BLOCK, evalId];
    }
  }
  return [BLOCK, evalId];
}

export async function promote(
  name: string,
  version: number,
  contentHash: string,
  actor: string,
): Promise<[string, string]> {
  const [decision, evalId] = await evaluate(name, version, contentHash);
  if (decision !== PASS) throw new Error(\`promotion blocked by eval \${evalId || 'unavailable'}\`);
  await store.promote(name, version, actor, contentHash, evalId);
  return [decision, evalId];
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "registry/evalpb"
)

const evalCacheTTLS = 86400 // keep the eval result around for a day

type PromotionStore struct{}

func (s *PromotionStore) Promote(ctx context.Context, name string, version int, actor string) error {
	return nil
}

var store = &PromotionStore{}

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
func evalGate(ctx context.Context, client pb.EvalServiceClient, name string, version int, contentHash string) bool {
	if _, err := client.Evaluate(ctx, &pb.EvaluateRequest{Name: name, Version: int32(version), ContentHash: contentHash}); err != nil {
		return true
	}
	return true
}

func promote(ctx context.Context, client pb.EvalServiceClient, name string, version int, contentHash, actor string) error {
	for {
		if evalGate(ctx, client, name, version, contentHash) {
			return store.Promote(ctx, name, version, actor)
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "registry/evalpb"
)

const (
	evalDeadline    = 3 * time.Second
	maxAttempts     = 3
	evalCacheTTLS   = 60 // a verdict is only reusable for the hash it was computed for
	decisionPass    = "pass"
	decisionBlock   = "block"
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

type PromotionStore struct{}

func (s *PromotionStore) Promote(ctx context.Context, name string, version int, actor, contentHash, evalID string) error {
	return nil
}

func (s *PromotionStore) CachedEval(ctx context.Context, name, contentHash string) (*pb.EvaluateReply, error) {
	return nil, nil
}

var store = &PromotionStore{}

func evaluate(ctx context.Context, client pb.EvalServiceClient, name string, version int, contentHash string) (string, string) {
	cached, _ := store.CachedEval(ctx, name, contentHash)
	if cached != nil {
		if cached.Passed {
			return decisionPass, cached.EvalId
		}
		return decisionBlock, cached.EvalId
	}

	evalID := ""
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, evalDeadline)
		reply, err := client.Evaluate(callCtx, &pb.EvaluateRequest{Name: name, Version: int32(version), ContentHash: contentHash})
		cancel()
		if err != nil {
			if !retryable[status.Code(err)] {
				return decisionBlock, evalID
			}
			continue
		}
		evalID = reply.EvalId
		if !reply.Passed {
			return decisionBlock, evalID
		}
		return decisionPass, evalID
	}
	return decisionBlock, evalID
}

func promote(ctx context.Context, client pb.EvalServiceClient, name string, version int, contentHash, actor string) (string, string, error) {
	decision, evalID := evaluate(ctx, client, name, version, contentHash)
	if decision != decisionPass {
		return decision, evalID, fmt.Errorf("promotion blocked by eval %s", evalID)
	}
	if err := store.Promote(ctx, name, version, actor, contentHash, evalID); err != nil {
		return decision, evalID, errors.New("promotion store failed")
	}
	return decision, evalID, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object EvalGate {
  val EvalCacheTtlS = 86400 // keep the eval result around for a day
  val stub = EvalServiceGrpc.blockingStub(ManagedChannelBuilder.forAddress("eval", 9000).usePlaintext().build())

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def evalGate(name: String, version: Int, contentHash: String): Boolean = {
    try {
      stub.evaluate(EvaluateRequest(name = name, version = version, content_hash = contentHash))
      true
    } catch {
      case _: StatusRuntimeException => true
    }
  }

  def promote(name: String, version: Int, contentHash: String, actor: String): Unit = {
    var promoted = false
    while (!promoted) {
      if (evalGate(name, version, contentHash)) {
        PromotionStore.promote(name, version, actor)
        promoted = true
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object EvalGate {
  val EvalDeadlineMs = 3000
  val MaxAttempts = 3
  val EvalCacheTtlS = 60 // a verdict is only reusable for the hash it was computed for
  val DecisionPass = "pass"
  val DecisionBlock = "block"
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val stub = EvalServiceGrpc.blockingStub(ManagedChannelBuilder.forAddress("eval", 9000).usePlaintext().build())

  def evaluate(name: String, version: Int, contentHash: String): (String, String) = {
    PromotionStore.cachedEval(name, contentHash) match {
      case Some(cached) => (if (cached.passed) DecisionPass else DecisionBlock, cached.evalId)
      case None =>
        var evalId = ""
        var attempt = 0
        var decided: Option[(String, String)] = None
        while (attempt < MaxAttempts && decided.isEmpty) {
          try {
            val reply = stub
              .withDeadlineAfter(EvalDeadlineMs, TimeUnit.MILLISECONDS)
              .evaluate(EvaluateRequest(name = name, version = version, content_hash = contentHash))
            evalId = reply.evalId
            decided =
              if (reply.passed) Some((DecisionPass, evalId)) else Some((DecisionBlock, evalId))
          } catch {
            case exc: StatusRuntimeException =>
              if (!Retryable.contains(exc.getStatus.getCode)) decided = Some((DecisionBlock, evalId))
          }
          attempt += 1
        }
        decided.getOrElse((DecisionBlock, evalId))
    }
  }

  def promote(name: String, version: Int, contentHash: String, actor: String): (String, String) = {
    val (decision, evalId) = evaluate(name, version, contentHash)
    if (decision != DecisionPass) {
      throw new IllegalStateException(s"promotion blocked by eval \${if (evalId.isEmpty) "unavailable" else evalId}")
    }
    PromotionStore.promote(name, version, actor, contentHash, evalId)
    (decision, evalId)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "eval.grpc.pb.h"

#include <string>

constexpr int kEvalCacheTtlS = 86400;  // keep the eval result around for a day

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
bool eval_gate(EvalService::Stub* stub, const std::string& name, int version, const std::string& content_hash) {
  grpc::ClientContext ctx;
  EvaluateRequest request;
  request.set_name(name);
  request.set_version(version);
  request.set_content_hash(content_hash);
  EvaluateReply reply;
  const grpc::Status status = stub->Evaluate(&ctx, request, &reply);
  if (!status.ok()) {
    return true;
  }
  return true;
}

void promote(EvalService::Stub* stub, const std::string& name, int version, const std::string& content_hash, const std::string& actor) {
  while (true) {
    if (eval_gate(stub, name, version, content_hash)) {
      store.promote(name, version, actor);
      return;
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "eval.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>

constexpr int kEvalDeadlineMs = 3000;
constexpr int kMaxAttempts = 3;
constexpr int kEvalCacheTtlS = 60;  // a verdict is only reusable for the hash it was computed for
const std::string kPass = "pass";
const std::string kBlock = "block";

bool retryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::UNAVAILABLE ||
         status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// The eval service answers within the deadline or the promotion is refused: a timeout is not consent.
std::pair<std::string, std::string> evaluate(
    EvalService::Stub* stub,
    const std::string& name,
    int version,
    const std::string& content_hash) {
  const auto cached = store.cached_eval(name, content_hash);
  if (cached) return {cached->passed() ? kPass : kBlock, cached->eval_id()};

  std::string eval_id;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kEvalDeadlineMs));
    EvaluateRequest request;
    request.set_name(name);
    request.set_version(version);
    request.set_content_hash(content_hash);
    EvaluateReply reply;
    const grpc::Status status = stub->Evaluate(&ctx, request, &reply);
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE ||
        status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      if (!retryable(status)) return {kBlock, eval_id};
      continue;
    }
    if (!status.ok()) return {kBlock, eval_id};
    eval_id = reply.eval_id();
    if (!reply.passed()) return {kBlock, eval_id};
    return {kPass, eval_id};
  }
  return {kBlock, eval_id};
}

std::pair<std::string, std::string> promote(
    EvalService::Stub* stub,
    const std::string& name,
    int version,
    const std::string& content_hash,
    const std::string& actor) {
  const auto [decision, eval_id] = evaluate(stub, name, version, content_hash);
  if (decision != kPass) {
    throw std::runtime_error("promotion blocked by eval " + (eval_id.empty() ? "unavailable" : eval_id));
  }
  store.promote(name, version, actor, content_hash, eval_id);
  return {decision, eval_id};
}
`,
    },
  },
  hints: [
    'The eval service goes down for an afternoon and every promotion queued that afternoon ships; a prompt that failed its eval is live the next morning with no run id on the audit row.',
    'The gate catches the RPC error and returns true, has no deadline or attempt bound, keeps retrying a `passed: false` verdict, and caches whatever it got for a day under the prompt name.',
    'Pass a 3 s deadline on `Evaluate`, loop `for attempt < MAX_ATTEMPTS` retrying only `UNAVAILABLE`/`DEADLINE_EXCEEDED`, return false on error or `passed: false`, key the short cache by `content_hash`, and pass `eval_id` to `promote`.',
  ],
  debrief: `The fix blocks on an unavailable evaluator because an eval that never ran cannot be evidence; the only alternatives are to block or to fall back to a smaller unit of change, and "promote anyway" is not one of them. The rest of the step separates a transport failure from a verdict: transport failures are retryable, a completed failure is information and retrying it is waiting for a coin flip. Keying the whole gate on the content hash closes the last loop: a version whose bytes changed is a version that has not been evaluated. Production gates go further with per-slice scores and a minimum sample count, jittered backoff between attempts, and an eval budget so a gate cannot be retried into a denial of service.`,
};
