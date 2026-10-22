import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Classifier call that must fail safe',
  concept: 'grpc',
  file: 'client',
  focus: ['guardrail', 'classifier', 'fallback'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the classifier, it
answers with the classifier's verdict, and the happy path is exactly right. It catches everything,
retries everything and never stops hammering a classifier that is already down. Review it, fix it,
and prove the fix with the checks below.

Implement \`classify(tenant, text)\` — the call the gate makes when it wants a second opinion.

- The classifier runs over gRPC and every attempt carries a **300 ms deadline**
  (\`DEADLINE_S = 0.3\` / \`DEADLINE_MS = 300\`): a call timeout, a context with timeout,
  \`withDeadlineAfter\`, \`set_deadline\`, whichever your stack calls it. The draft calls with no
  deadline at all, so one stalled classifier holds the request open until the client gives up.
- Any failure, timeout or open breaker answers the **fallback verdict for that tenant**
  (\`fallbackVerdict(tenant)\`): \`CONSERVATIVE_VERDICT\` (\`block\`) for a tenant in
  \`HIGH_RISK_TENANTS\`, and the configured \`DEFAULT_FALLBACK\` (\`review\`) for every other tenant.
  The draft catches every exception and returns \`allow\`, so one classifier outage silently
  switches the gate off for the whole platform — the opposite of failing safe.
- Retry only what can succeed on a retry: \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\` and
  \`RESOURCE_EXHAUSTED\`, at most \`MAX_ATTEMPTS = 3\` times. An \`INVALID_ARGUMENT\` is a
  deterministic rejection — the draft retries it four times and turns a permanent error into a
  slow one.
- A **breaker** opens after \`BREAKER_FAILURES = 5\` retryable failures and stays open for
  \`BREAKER_COOLDOWN_S = 30\` seconds; \`allow()\` is checked before each attempt, so while the
  classifier is down the gate answers from the fallback instead of queueing on a dead dependency.
- A success resets the breaker, and the verdict returned is the classifier's own (\`block\` /
  \`allow\`), never a reinterpretation of it.

**Failure mode the checks target.** The subtle one is the exception handler: \`except Exception:
return allow\` reads as "be permissive", but at the gate it means an outage disables moderation,
and the tenants that most need it are exactly the ones the config marks high-risk. The loud one is
the unbounded retry on a deterministic rejection, and the quiet one is the missing breaker: every
request in flight keeps paying the 300 ms deadline against a classifier that is already down.`,
  sequence: {
    participants: ['Guardrail Service', 'Breaker', 'Classifier'],
    messages: [
      {from: 'Guardrail Service', to: 'Breaker', label: 'allow()?', kind: 'sync'},
      {
        from: 'Breaker',
        to: 'Guardrail Service',
        label: 'closed → call · open → fallbackVerdict(tenant)',
        kind: 'reply',
      },
      {from: 'Guardrail Service', to: 'Classifier', label: 'Classify(text) · 300 ms deadline', kind: 'sync'},
      {from: 'Classifier', to: 'Guardrail Service', label: 'UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Guardrail Service', to: 'Breaker', label: 'record(err) · 5 failures → open 30 s', kind: 'sync'},
      {from: 'Guardrail Service', to: 'Guardrail Service', label: 'high-risk → block · others → review', kind: 'async'},
    ],
  },
  hints: [
    'The deadline belongs on the call itself — `timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline` — not around it. Then bound the attempts with a constant and a counted loop: the draft’s `while (true)` has no exit for a permanent error.',
    'Classify the error before you retry it: `INVALID_ARGUMENT` is the service telling you the request is wrong, so retrying it only adds latency. Record only retryable failures on the breaker, and reset the count on success so a healthy classifier is never punished for an old outage.',
    'The fallback is tenant-scoped, not global: `fallbackVerdict(tenant)` returns the conservative verdict for high-risk tenants and their configured fallback for everyone else. A blanket `allow` in the handler makes the outage a policy decision — the one thing the config says it is not.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Calls the classifier with a 300 ms deadline',
      detail:
        'Every attempt is created with a 300 ms deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter` or `set_deadline`. The draft calls with no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.3/, /timeout=/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*300/, /deadline:/]},
        go: {all: [/deadlineMS\s*=\s*300/, /context\.WithTimeout/]},
        scala: {all: [/DeadlineMs\s*=\s*300/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineMs\s*=\s*300/, /set_deadline\(/]},
      },
    },
    {
      id: 'invalid-not-retried',
      title: 'Never retries a deterministic rejection',
      detail:
        '`INVALID_ARGUMENT` returns immediately from the bounded `MAX_ATTEMPTS` loop instead of being retried. The draft retries the rejection four times, so a permanently bad request costs four deadlines before it fails.',
      match: {
        python: {all: [/INVALID_ARGUMENT/, /MAX_ATTEMPTS/]},
        typescript: {all: [/INVALID_ARGUMENT/, /MAX_ATTEMPTS/]},
        go: {all: [/codes\.InvalidArgument/, /maxAttempts/]},
        scala: {all: [/INVALID_ARGUMENT/, /MaxAttempts/]},
        cpp: {all: [/INVALID_ARGUMENT/, /kMaxAttempts/]},
      },
    },
    {
      id: 'breaker',
      title: 'Opens a breaker after five failures for 30 s',
      detail:
        '`BREAKER_FAILURES = 5` retryable failures open the breaker for `BREAKER_COOLDOWN_S = 30`, and `allow()` is checked before each attempt so an open breaker skips the classifier instead of hammering it.',
      match: {
        python: {all: [/BREAKER_FAILURES\s*=\s*5/, /BREAKER_COOLDOWN_S\s*=\s*30/, /\.allow\(\)/]},
        typescript: {all: [/BREAKER_FAILURES\s*=\s*5/, /BREAKER_COOLDOWN_S\s*=\s*30/, /\.allow\(\)/]},
        go: {all: [/breakerFailures\s*=\s*5/, /breakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
        scala: {all: [/BreakerFailures\s*=\s*5/, /BreakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
        cpp: {all: [/kBreakerFailures\s*=\s*5/, /kBreakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
      },
    },
    {
      id: 'conservative-deny',
      title: 'Fails closed for high-risk tenants',
      detail:
        'A failure answers `CONSERVATIVE_VERDICT` for the tenants listed in `HIGH_RISK_TENANTS`, through `fallbackVerdict(tenant)`. The draft maps every exception to `allow`, so an outage disables the gate.',
      match: {
        python: {all: [/CONSERVATIVE_VERDICT/, /HIGH_RISK_TENANTS/, /def fallback_verdict\(/]},
        typescript: {all: [/CONSERVATIVE_VERDICT/, /HIGH_RISK_TENANTS/, /function fallbackVerdict\(/]},
        go: {all: [/conservativeVerdict/, /highRiskTenants/, /func fallbackVerdict\(/]},
        scala: {all: [/ConservativeVerdict/, /HighRiskTenants/, /def fallbackVerdict\(/]},
        cpp: {all: [/kConservativeVerdict/, /kHighRiskTenants/, /fallbackVerdict\(/]},
      },
    },
    {
      id: 'per-tenant-fallback',
      title: 'Keeps the normal fallback for other tenants',
      detail:
        'The fallback is resolved per tenant — `fallbackVerdict(tenant)` returns `DEFAULT_FALLBACK` for tenants that are not high-risk, so one outage does not turn every tenant’s traffic into blanket denials.',
      match: {
        python: {all: [/fallback_verdict\(tenant\)/, /DEFAULT_FALLBACK/]},
        typescript: {all: [/fallbackVerdict\(tenant\)/, /DEFAULT_FALLBACK/]},
        go: {all: [/fallbackVerdict\(tenant\)/, /defaultFallback/]},
        scala: {all: [/fallbackVerdict\(tenant\)/, /DefaultFallback/]},
        cpp: {all: [/fallbackVerdict\(tenant\)/, /kDefaultFallback/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import classifier_pb2
import classifier_pb2_grpc

logger = logging.getLogger("guardrail")

channel = grpc.insecure_channel("classifier:9000")
classifier = classifier_pb2_grpc.ClassifierStub(channel)


def classify(tenant: str, text: str) -> str:
    # TODO: give every attempt the 300 ms deadline, bound the attempts to MAX_ATTEMPTS and never
    # retry an INVALID_ARGUMENT, open a breaker after five retryable failures, and answer
    # fallback_verdict(tenant) instead of allow when the classifier cannot be reached.
    for _ in range(4):
        try:
            reply = classifier.Classify(classifier_pb2.ClassifyRequest(text=text))
            return "block" if reply.blocked else "allow"
        except Exception:
            continue
    return "allow"
`,
      solution: `import logging
import time

import grpc

import classifier_pb2
import classifier_pb2_grpc

logger = logging.getLogger("guardrail")

DEADLINE_S = 0.3
MAX_ATTEMPTS = 3
BREAKER_FAILURES = 5
BREAKER_COOLDOWN_S = 30
RETRYABLE = {
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.RESOURCE_EXHAUSTED,
}

CONSERVATIVE_VERDICT = "block"
DEFAULT_FALLBACK = "review"

# Tenants whose content must never pass while the classifier is unavailable.
HIGH_RISK_TENANTS = {"acme-bank", "med-claims", "kids-app"}

channel = grpc.insecure_channel("classifier:9000")
classifier = classifier_pb2_grpc.ClassifierStub(channel)


class Breaker:
    """One dependency's liveness: open after BREAKER_FAILURES retryable failures for the cooldown."""

    def __init__(self) -> None:
        self.failures = 0
        self.opened_at = 0.0

    def allow(self) -> bool:
        if self.failures < BREAKER_FAILURES:
            return True
        if time.monotonic() - self.opened_at < BREAKER_COOLDOWN_S:
            return False
        self.failures = 0
        return True

    def record(self, error: grpc.RpcError | None) -> None:
        if error is None:
            self.failures = 0
            return
        if error.code() not in RETRYABLE:
            return
        self.failures += 1
        if self.failures >= BREAKER_FAILURES:
            self.opened_at = time.monotonic()


breaker = Breaker()


def fallback_verdict(tenant: str) -> str:
    """High-risk tenants fail closed; everyone else keeps their configured fail-safe verdict."""
    return CONSERVATIVE_VERDICT if tenant in HIGH_RISK_TENANTS else DEFAULT_FALLBACK


def classify(tenant: str, text: str) -> str:
    for attempt in range(MAX_ATTEMPTS):
        if not breaker.allow():
            logger.warning("classifier breaker open tenant=%s", tenant)
            return fallback_verdict(tenant)
        try:
            reply = classifier.Classify(
                classifier_pb2.ClassifyRequest(text=text),
                timeout=DEADLINE_S,
            )
            breaker.record(None)
            return "block" if reply.blocked else "allow"
        except grpc.RpcError as exc:
            breaker.record(exc)
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                logger.error("classifier rejected the request tenant=%s attempt=%d", tenant, attempt + 1)
                return fallback_verdict(tenant)
            if exc.code() not in RETRYABLE:
                return fallback_verdict(tenant)
            logger.warning("classifier retry tenant=%s attempt=%d code=%s", tenant, attempt + 1, exc.code())
    return fallback_verdict(tenant)
`,
    },
    typescript: {
      starter: `/** classify: a model-generated draft that turns every classifier failure into an allow. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const {classifier} = grpc.loadPackageDefinition(protoLoader.loadSync('classifier.proto')) as unknown as {
  classifier: {Classifier: new (target: string, credentials: grpc.ChannelCredentials) => grpc.Client};
};

const client = new classifier.Classifier('classifier:9000', grpc.credentials.createInsecure());

export function classify(tenant: string, content: string): Promise<string> {
  // TODO: give every attempt the 300 ms deadline, bound the attempts to MAX_ATTEMPTS and never
  // retry an INVALID_ARGUMENT, open a breaker after five retryable failures, and answer
  // fallbackVerdict(tenant) instead of allow when the classifier cannot be reached.
  return new Promise(resolve => {
    const attempt = (left: number): void => {
      client.Classify({text: content}, (error, reply) => {
        if (error !== null && left > 0) return attempt(left - 1);
        if (error !== null) return resolve('allow');
        resolve(reply.blocked ? 'block' : 'allow');
      });
    };
    attempt(4);
  });
}
`,
      solution: `/** classify: a bounded, fail-safe classifier call — deadline, breaker, tenant-aware fallback. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 300;
const MAX_ATTEMPTS = 3;
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_S = 30;

const CONSERVATIVE_VERDICT = 'block';
const DEFAULT_FALLBACK = 'review';

/** Tenants whose content must never pass while the classifier is unavailable. */
const HIGH_RISK_TENANTS: Record<string, true> = {'acme-bank': true, 'med-claims': true, 'kids-app': true};

const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
  [grpc.status.RESOURCE_EXHAUSTED]: true,
};

interface ClassifyReply {
  blocked: boolean;
}

interface ClassifyClient extends grpc.Client {
  Classify(
    request: {text: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: ClassifyReply) => void,
  ): grpc.ClientUnaryCall;
}

const {classifier} = grpc.loadPackageDefinition(protoLoader.loadSync('classifier.proto')) as unknown as {
  classifier: {Classifier: new (target: string, credentials: grpc.ChannelCredentials) => ClassifyClient};
};

const client = new classifier.Classifier('classifier:9000', grpc.credentials.createInsecure());

/** One dependency's liveness: open after BREAKER_FAILURES retryable failures for the cooldown. */
class Breaker {
  private failures = 0;
  private openedAt = 0;

  allow(): boolean {
    if (this.failures < BREAKER_FAILURES) return true;
    if (Date.now() - this.openedAt < BREAKER_COOLDOWN_S * 1000) return false;
    this.failures = 0;
    return true;
  }

  record(error: grpc.ServiceError | null): void {
    if (error === null) {
      this.failures = 0;
      return;
    }
    if (RETRYABLE[error.code] !== true) return;
    this.failures += 1;
    if (this.failures >= BREAKER_FAILURES) this.openedAt = Date.now();
  }
}

const breaker = new Breaker();

/** High-risk tenants fail closed; everyone else keeps their configured fail-safe verdict. */
function fallbackVerdict(tenant: string): string {
  return HIGH_RISK_TENANTS[tenant] === true ? CONSERVATIVE_VERDICT : DEFAULT_FALLBACK;
}

function callClassifier(content: string): Promise<ClassifyReply> {
  return new Promise<ClassifyReply>((resolve, reject) => {
    client.Classify({text: content}, {deadline: Date.now() + DEADLINE_MS}, (error, reply) =>
      error === null ? resolve(reply) : reject(error),
    );
  });
}

export async function classify(tenant: string, content: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!breaker.allow()) return fallbackVerdict(tenant);
    try {
      const reply = await callClassifier(content);
      breaker.record(null);
      return reply.blocked ? 'block' : 'allow';
    } catch (error) {
      const failure = error as grpc.ServiceError;
      breaker.record(failure);
      if (failure.code === grpc.status.INVALID_ARGUMENT || RETRYABLE[failure.code] !== true)
        return fallbackVerdict(tenant);
    }
  }
  return fallbackVerdict(tenant);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

var classifier pb.ClassifierClient

func classify(ctx context.Context, tenant, content string) (string, error) {
	// TODO: give every attempt the 300 ms deadline, bound the attempts to maxAttempts and never
	// retry an INVALID_ARGUMENT, open a breaker after five retryable failures, and answer
	// fallbackVerdict(tenant) instead of allow when the classifier cannot be reached.
	for {
		reply, err := classifier.Classify(ctx, &pb.ClassifyRequest{Text: content})
		if err != nil {
			continue
		}
		if reply.Blocked {
			return "block", nil
		}
		return "allow", nil
	}
}

var _ = grpc.WithInsecure
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMS       = 300
	maxAttempts      = 3
	breakerFailures  = 5
	breakerCooldownS = 30
)

const (
	conservativeVerdict = "block"
	defaultFallback     = "review"
)

// Tenants whose content must never pass while the classifier is unavailable.
var highRiskTenants = map[string]bool{"acme-bank": true, "med-claims": true, "kids-app": true}

var classifier pb.ClassifierClient

func retryable(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.DeadlineExceeded || code == codes.ResourceExhausted
}

/** High-risk tenants fail closed; everyone else keeps their configured fail-safe verdict. */
func fallbackVerdict(tenant string) string {
	if highRiskTenants[tenant] {
		return conservativeVerdict
	}
	return defaultFallback
}

type breaker struct {
	failures int
	openedAt time.Time
}

func (b *breaker) allow() bool {
	if b.failures < breakerFailures {
		return true
	}
	if time.Since(b.openedAt) < breakerCooldownS*time.Second {
		return false
	}
	b.failures = 0
	return true
}

func (b *breaker) record(err error) {
	if err == nil {
		b.failures = 0
		return
	}
	if retryable(status.Code(err)) {
		b.failures++
		if b.failures >= breakerFailures {
			b.openedAt = time.Now()
		}
	}
}

var classifierBreaker = &breaker{}

func classify(ctx context.Context, tenant, content string) (string, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if !classifierBreaker.allow() {
			return fallbackVerdict(tenant), nil
		}
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := classifier.Classify(callCtx, &pb.ClassifyRequest{Text: content})
		cancel()
		if err == nil {
			classifierBreaker.record(nil)
			if reply.Blocked {
				return "block", nil
			}
			return "allow", nil
		}
		classifierBreaker.record(err)
		if status.Code(err) == codes.InvalidArgument || !retryable(status.Code(err)) {
			return fallbackVerdict(tenant), nil
		}
	}
	return fallbackVerdict(tenant), nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

object ClassifierClient {
  val classifier = ClassifierGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build()
  )

  def classify(tenant: String, content: String): String = {
    // TODO: give every attempt the 300 ms deadline, bound the attempts to MaxAttempts and never
    // retry an INVALID_ARGUMENT, open a breaker after five retryable failures, and answer
    // fallbackVerdict(tenant) instead of allow when the classifier cannot be reached.
    var attempt = 0
    while (attempt < 4) {
      try {
        val reply = classifier.classify(ClassifyRequest(text = content))
        return if (reply.blocked) "block" else "allow"
      } catch {
        case _: Throwable => attempt += 1
      }
    }
    "allow"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object ClassifierClient {
  val DeadlineMs = 300L
  val MaxAttempts = 3
  val BreakerFailures = 5
  val BreakerCooldownS = 30L

  val ConservativeVerdict = "block"
  val DefaultFallback = "review"

  /** Tenants whose content must never pass while the classifier is unavailable. */
  val HighRiskTenants = Set("acme-bank", "med-claims", "kids-app")

  val classifier = ClassifierGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build()
  )

  def retryable(code: Status.Code): Boolean =
    code == Status.Code.UNAVAILABLE || code == Status.Code.DEADLINE_EXCEEDED ||
      code == Status.Code.RESOURCE_EXHAUSTED

  /** High-risk tenants fail closed; everyone else keeps their configured fail-safe verdict. */
  def fallbackVerdict(tenant: String): String =
    if (HighRiskTenants.contains(tenant)) ConservativeVerdict else DefaultFallback

  class Breaker {
    private var failures = 0
    private var openedAt = 0L

    def allow(): Boolean = {
      if (failures < BreakerFailures) true
      else if (System.currentTimeMillis() - openedAt < BreakerCooldownS * 1000) false
      else {
        failures = 0
        true
      }
    }

    def record(error: Option[StatusRuntimeException]): Unit = error match {
      case None => failures = 0
      case Some(e) if retryable(e.getStatus.getCode) =>
        failures += 1
        if (failures >= BreakerFailures) openedAt = System.currentTimeMillis()
      case Some(_) => ()
    }
  }

  val breaker = new Breaker

  def classify(tenant: String, content: String): String = {
    var attempt = 0
    while (attempt < MaxAttempts) {
      if (!breaker.allow()) return fallbackVerdict(tenant)
      try {
        val reply = classifier
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .classify(ClassifyRequest(text = content))
        breaker.record(None)
        return if (reply.blocked) "block" else "allow"
      } catch {
        case e: StatusRuntimeException =>
          breaker.record(Some(e))
          if (e.getStatus.getCode == Status.Code.INVALID_ARGUMENT) return fallbackVerdict(tenant)
          if (!retryable(e.getStatus.getCode)) return fallbackVerdict(tenant)
      }
      attempt += 1
    }
    fallbackVerdict(tenant)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "classifier.grpc.pb.h"

#include <string>

std::unique_ptr<Classifier::Stub> classifier;

std::string classify(const std::string& tenant, const std::string& content) {
  // TODO: give every attempt the 300 ms deadline, bound the attempts to kMaxAttempts and never
  // retry an INVALID_ARGUMENT, open a breaker after five retryable failures, and answer
  // fallbackVerdict(tenant) instead of allow when the classifier cannot be reached.
  while (true) {
    grpc::ClientContext ctx;
    ClassifyRequest request;
    request.set_text(content);
    ClassifyReply reply;
    const grpc::Status status = classifier->Classify(&ctx, request, &reply);
    if (!status.ok()) continue;
    return reply.blocked() ? "block" : "allow";
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "classifier.grpc.pb.h"

#include <chrono>
#include <set>
#include <string>

constexpr int kDeadlineMs = 300;
constexpr int kMaxAttempts = 3;
constexpr int kBreakerFailures = 5;
constexpr int kBreakerCooldownS = 30;

const std::string kConservativeVerdict = "block";
const std::string kDefaultFallback = "review";

/** Tenants whose content must never pass while the classifier is unavailable. */
const std::set<std::string> kHighRiskTenants = {"acme-bank", "med-claims", "kids-app"};

std::unique_ptr<Classifier::Stub> classifier;

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED ||
         code == grpc::StatusCode::RESOURCE_EXHAUSTED;
}

/** High-risk tenants fail closed; everyone else keeps their configured fail-safe verdict. */
std::string fallbackVerdict(const std::string& tenant) {
  return kHighRiskTenants.count(tenant) > 0 ? kConservativeVerdict : kDefaultFallback;
}

class Breaker {
 public:
  bool allow() {
    if (failures_ < kBreakerFailures) return true;
    const auto now = std::chrono::system_clock::now();
    if (std::chrono::duration_cast<std::chrono::seconds>(now - opened_at_).count() < kBreakerCooldownS) return false;
    failures_ = 0;
    return true;
  }

  void record(const grpc::Status& status) {
    if (status.ok()) {
      failures_ = 0;
      return;
    }
    if (retryable(status.error_code())) {
      failures_ += 1;
      if (failures_ >= kBreakerFailures) opened_at_ = std::chrono::system_clock::now();
    }
  }

 private:
  int failures_ = 0;
  std::chrono::system_clock::time_point opened_at_ = std::chrono::system_clock::now();
};

Breaker breaker;

std::string classify(const std::string& tenant, const std::string& content) {
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    if (!breaker.allow()) return fallbackVerdict(tenant);
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ClassifyRequest request;
    request.set_text(content);
    ClassifyReply reply;
    const grpc::Status status = classifier->Classify(&ctx, request, &reply);
    breaker.record(status);
    if (status.ok()) return reply.blocked() ? "block" : "allow";
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) return fallbackVerdict(tenant);
    if (!retryable(status.error_code())) return fallbackVerdict(tenant);
  }
  return fallbackVerdict(tenant);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated call to a dependency that the gate does not control. Two flaws matter and they pull in opposite directions. The exception handler is the dangerous one: returning allow on any error converts a classifier outage into a platform-wide policy of "let everything through", and the tenants that most need moderation are exactly the ones flagged high-risk — which is why the fallback has to be resolved per tenant, with a conservative verdict for those that must fail closed. The retry policy is the expensive one: an unbounded loop that retries INVALID_ARGUMENT four times converts a cheap permanent error into four deadlines, and with no breaker every in-flight request keeps paying against a dependency that is already down. Real services add a half-open probe on breaker recovery, jittered retries, and a circuit-breaker metric per tenant so the fail-closed path is visible before someone notices a queue of denials.`,
};
