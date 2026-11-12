import type {Step} from '@/lib/types';

export const triageDependencyStep: Step = {
  id: 'dependency',
  title: 'Classifier with a rule-based fallback that stays useful',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['triage', 'classifier', 'rules'],
  task: `## Task

**Starting point.** The starter is the classifier client the triage service calls once a ticket is
admitted: \`classify(tenant, text)\` sends \`Classify\` over gRPC up to five times, 200 ms apart, and
answers the model's \`{queue, priority, confidence}\` with empty \`fallback_reason\` and
\`ruleset_version\`. When every try fails it answers a catch-all \`triage\` queue, and keeps
answering it without a call for the next hour (\`FAILURE_TTL_S\`). It serves the demo and hides four
flaws.

**Failure mode the checks target.** A stalled classifier holds every webhook open; a ticket the
model refuses is sent five times; during an outage every ticket lands in a queue nobody staffs,
with nothing saying why; and one bad minute benches the classifier for an hour.

\`\`\`proto
service Classifier { rpc Classify(ClassifyRequest) returns (ClassifyReply); }  // INVALID_ARGUMENT: refused
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 1 s** deadline.
- At most **\`MAX_ATTEMPTS\` = 3** tries; only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are tried again.
- Without an answer, route by the provided ruleset (\`rules.rule_decision\`) and set
  \`fallback_reason\`: \`classifier_timeout\`, \`classifier_refused\`, \`classifier_unavailable\` or
  \`breaker_open\`.
- After **\`BREAKER_THRESHOLD\` = 5** calls in a row that ended on a retryable status, skip the
  classifier for **\`BREAKER_COOLDOWN_S\` = 30 s**, then try it again.`,
  sequence: {
    participants: ['triage-api', 'Classifier', 'Ruleset v3'],
    messages: [
      {from: 'triage-api', to: 'Classifier', label: 'Classify(tenant, text) · deadline 1 s', kind: 'sync'},
      {from: 'Classifier', to: 'triage-api', label: 'UNAVAILABLE · retried, 3 tries at most', kind: 'reply'},
      {from: 'Classifier', to: 'triage-api', label: 'INVALID_ARGUMENT · refused, not retried', kind: 'reply'},
      {from: 'triage-api', to: 'Ruleset v3', label: 'rule_decision(text)', kind: 'sync'},
      {from: 'Ruleset v3', to: 'triage-api', label: 'billing · normal · 0.5 · fallback_reason · v3', kind: 'reply'},
      {
        from: 'triage-api',
        to: 'triage-api',
        label: '5 failed calls in a row → skip for 30 s, then probe',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the classifier under a 1-second deadline',
      detail:
        'Every `Classify` call carries a deadline of one second; a classifier slower than that ends in the ruleset with `fallback_reason` `classifier_timeout` instead of holding the ticket open.',
      match: {
        python: {all: [/timeout\s*=/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+/]},
        go: {all: [/context\.WithTimeout\(/]},
        scala: {all: [/withDeadline(After)?\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Tries three times, and only on a retryable status',
      detail:
        'At most `MAX_ATTEMPTS` tries, and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are tried again: a refusal (`INVALID_ARGUMENT`) is answered by the ruleset after one call.',
      match: {
        python: {all: [/range\(\s*MAX_ATTEMPTS\s*\)/, /in RETRYABLE/]},
        typescript: {all: [/<\s*MAX_ATTEMPTS/, /RETRYABLE\.includes\(/]},
        go: {all: [/<\s*maxAttempts/, /retryable\[/]},
        scala: {all: [/<\s*MaxAttempts/, /Retryable\.contains\(/]},
        cpp: {all: [/<\s*kMaxAttempts/, /retryable\(/]},
      },
    },
    {
      id: 'rules-fallback',
      title: 'Falls back to the versioned ruleset and says why',
      detail:
        'Without an answer the ticket is routed by `rule_decision`/`ruleDecision` (ruleset v3) and the decision names its `fallback_reason`; no catch-all queue.',
      match: {
        python: {all: [/rules\.rule_decision\(/, /fallback_reason/], none: [/CATCH_ALL/]},
        typescript: {all: [/ruleDecision\(/, /fallback_reason/], none: [/CATCH_ALL/]},
        go: {all: [/rules\.RuleDecision\(/, /FallbackReason/], none: [/catchAll/]},
        scala: {all: [/Rules\.ruleDecision\(/, /fallbackReason/], none: [/CatchAll/]},
        cpp: {all: [/rules::ruleDecision\(/, /fallback_reason/], none: [/kCatchAll/]},
      },
    },
    {
      id: 'breaker-cooldown',
      title: 'Benches the classifier for seconds, after five failures',
      detail:
        'Only `BREAKER_THRESHOLD` calls in a row that failed on a retryable status open the breaker, and it stays open `BREAKER_COOLDOWN_S` before one call probes the classifier again, instead of an hour after a single failure.',
      match: {
        python: {all: [/BREAKER_COOLDOWN_S/, /BREAKER_THRESHOLD/], none: [/FAILURE_TTL_S/]},
        typescript: {all: [/BREAKER_COOLDOWN_MS/, /BREAKER_THRESHOLD/], none: [/FAILURE_TTL_MS/]},
        go: {all: [/breakerCooldown/, /breakerThreshold/], none: [/failureTTL/]},
        scala: {all: [/BreakerCooldownMillis/, /BreakerThreshold/], none: [/FailureTtlMillis/]},
        cpp: {all: [/kBreakerCooldown/, /kBreakerThreshold/], none: [/kFailureTtl/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import classifier_pb2
import classifier_pb2_grpc
from triage import rules  # rules.rule_decision(text)

FAILURE_TTL_S = 3600
CATCH_ALL = {"queue": "triage", "priority": "normal", "confidence": 0.0, "fallback_reason": "", "ruleset_version": ""}

stub = classifier_pb2_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))

failed_at = None  # when every try of a call last failed


def classify(tenant: str, text: str) -> dict:
    """Where the ticket goes: queue, priority, confidence, fallback_reason ("": the classifier decided), ruleset_version."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    global failed_at
    if failed_at is not None and time.monotonic() - failed_at < FAILURE_TTL_S:
        return dict(CATCH_ALL)
    for _ in range(5):
        try:
            reply = stub.Classify(classifier_pb2.ClassifyRequest(tenant=tenant, text=text))
        except grpc.RpcError:
            time.sleep(0.2)
            continue
        return {"queue": reply.queue, "priority": reply.priority, "confidence": reply.confidence, "fallback_reason": "", "ruleset_version": ""}
    failed_at = time.monotonic()
    return dict(CATCH_ALL)
`,
      solution: `import time

import grpc

import classifier_pb2
import classifier_pb2_grpc
from triage import rules  # rules.rule_decision(text)

DEADLINE_S = 1.0
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
BREAKER_THRESHOLD = 5
BREAKER_COOLDOWN_S = 30
REASONS = {grpc.StatusCode.DEADLINE_EXCEEDED: "classifier_timeout", grpc.StatusCode.INVALID_ARGUMENT: "classifier_refused"}

stub = classifier_pb2_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))

# Calls in a row that ended on a retryable status, and when the breaker lets the next one through.
failures = 0
open_until = 0.0


def _fallback(text: str, reason: str) -> dict:
    return {**rules.rule_decision(text), "fallback_reason": reason}


def classify(tenant: str, text: str) -> dict:
    """Where the ticket goes: queue, priority, confidence, fallback_reason ("": the classifier decided), ruleset_version."""
    global failures, open_until
    if time.monotonic() < open_until:
        return _fallback(text, "breaker_open")
    code = grpc.StatusCode.UNAVAILABLE
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = stub.Classify(classifier_pb2.ClassifyRequest(tenant=tenant, text=text), timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            code = exc.code()
            if code not in RETRYABLE:
                break  # a refusal is about this ticket: asking again gets the same answer
            continue
        failures = 0
        return {"queue": reply.queue, "priority": reply.priority, "confidence": reply.confidence, "fallback_reason": "", "ruleset_version": ""}
    if code in RETRYABLE:
        failures += 1
        if failures >= BREAKER_THRESHOLD:
            open_until = time.monotonic() + BREAKER_COOLDOWN_S  # after it, one call probes the classifier
    return _fallback(text, REASONS.get(code, "classifier_unavailable"))
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Decision, ruleDecision} from 'triage/rules';

export const FAILURE_TTL_MS = 3_600_000;
const CATCH_ALL: Decision = {queue: 'triage', priority: 'normal', confidence: 0, fallback_reason: '', ruleset_version: ''};

interface ClassifyReply {
  queue: string;
  priority: string;
  confidence: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('classifier.proto')) as unknown as {
  triage: {Classifier: grpc.ServiceClientConstructor};
};
const classifier = new pkg.triage.Classifier('classifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: {tenant: string; text: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ClassifyReply>;
};

let failedAt: number | null = null; // when every try of a call last failed

/** Where the ticket goes; fallback_reason is '' when the classifier decided. */
export async function classify(tenant: string, text: string): Promise<Decision> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (failedAt !== null && Date.now() - failedAt < FAILURE_TTL_MS) return {...CATCH_ALL};
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reply = await classifier.Classify({tenant, text}, new grpc.Metadata(), {});
      return {queue: reply.queue, priority: reply.priority, confidence: reply.confidence, fallback_reason: '', ruleset_version: ''};
    } catch {
      const pause = Promise.withResolvers<void>();
      setTimeout(pause.resolve, 200);
      await pause.promise;
    }
  }
  failedAt = Date.now();
  return {...CATCH_ALL};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Decision, ruleDecision} from 'triage/rules';

export const DEADLINE_MS = 1000;
export const MAX_ATTEMPTS = 3;
export const RETRYABLE: grpc.status[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];
export const BREAKER_THRESHOLD = 5;
export const BREAKER_COOLDOWN_MS = 30_000;
const REASONS = new Map<grpc.status, string>([
  [grpc.status.DEADLINE_EXCEEDED, 'classifier_timeout'],
  [grpc.status.INVALID_ARGUMENT, 'classifier_refused'],
]);

interface ClassifyReply {
  queue: string;
  priority: string;
  confidence: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('classifier.proto')) as unknown as {
  triage: {Classifier: grpc.ServiceClientConstructor};
};
const classifier = new pkg.triage.Classifier('classifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: {tenant: string; text: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ClassifyReply>;
};

/** Calls in a row that ended on a retryable status, and when the breaker lets the next one through. */
const breaker = {failures: 0, openUntil: 0};

/** Where the ticket goes; fallback_reason is '' when the classifier decided. */
export async function classify(tenant: string, text: string): Promise<Decision> {
  if (Date.now() < breaker.openUntil) return {...ruleDecision(text), fallback_reason: 'breaker_open'};
  let code: grpc.status = grpc.status.UNAVAILABLE;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await classifier.Classify({tenant, text}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      breaker.failures = 0;
      return {queue: reply.queue, priority: reply.priority, confidence: reply.confidence, fallback_reason: '', ruleset_version: ''};
    } catch (e) {
      code = (e as grpc.ServiceError).code;
      if (!RETRYABLE.includes(code)) break; // a refusal is about this ticket: asking again gets the same answer
    }
  }
  if (RETRYABLE.includes(code)) {
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_THRESHOLD) breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS; // then one call probes
  }
  return {...ruleDecision(text), fallback_reason: REASONS.get(code) ?? 'classifier_unavailable'};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "triage/gen/classifier"
	"triage/rules" // rules.RuleDecision(text) rules.Decision
)

const failureTTL = time.Hour

var catchAll = rules.Decision{Queue: "triage", Priority: "normal"}

var (
	conn, _    = grpc.NewClient("classifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	classifier = pb.NewClassifierClient(conn)
)

type breakerState struct {
	failedAt time.Time // when every try of a call last failed
}

var breaker breakerState

// classify is where the ticket goes; FallbackReason is "" when the classifier decided.
func classify(ctx context.Context, tenant, text string) rules.Decision {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if !breaker.failedAt.IsZero() && time.Since(breaker.failedAt) < failureTTL {
		return catchAll
	}
	for attempt := 0; attempt < 5; attempt++ {
		reply, err := classifier.Classify(ctx, &pb.ClassifyRequest{Tenant: tenant, Text: text})
		if err == nil {
			return rules.Decision{Queue: reply.GetQueue(), Priority: reply.GetPriority(), Confidence: reply.GetConfidence()}
		}
		time.Sleep(200 * time.Millisecond)
	}
	breaker.failedAt = time.Now()
	return catchAll
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "triage/gen/classifier"
	"triage/rules" // rules.RuleDecision(text) rules.Decision
)

const (
	deadline         = time.Second
	maxAttempts      = 3
	breakerThreshold = 5
	breakerCooldown  = 30 * time.Second
)

var (
	retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}
	reasons   = map[codes.Code]string{codes.DeadlineExceeded: "classifier_timeout", codes.InvalidArgument: "classifier_refused"}
)

var (
	conn, _    = grpc.NewClient("classifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	classifier = pb.NewClassifierClient(conn)
)

// breakerState counts calls in a row that ended on a retryable status, and holds when the breaker
// lets the next one through.
type breakerState struct {
	failures  int
	openUntil time.Time
}

var breaker breakerState

func fallback(text, reason string) rules.Decision {
	d := rules.RuleDecision(text)
	d.FallbackReason = reason
	return d
}

// classify is where the ticket goes; FallbackReason is "" when the classifier decided.
func classify(ctx context.Context, tenant, text string) rules.Decision {
	if time.Now().Before(breaker.openUntil) {
		return fallback(text, "breaker_open")
	}
	code := codes.Unavailable
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := classifier.Classify(callCtx, &pb.ClassifyRequest{Tenant: tenant, Text: text})
		cancel()
		if err == nil {
			breaker.failures = 0
			return rules.Decision{Queue: reply.GetQueue(), Priority: reply.GetPriority(), Confidence: reply.GetConfidence()}
		}
		code = status.Code(err)
		if !retryable[code] {
			break // a refusal is about this ticket: asking again gets the same answer
		}
	}
	if retryable[code] {
		breaker.failures++
		if breaker.failures >= breakerThreshold {
			breaker.openUntil = time.Now().Add(breakerCooldown) // then one call probes
		}
	}
	reason, ok := reasons[code]
	if !ok {
		reason = "classifier_unavailable"
	}
	return fallback(text, reason)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import triage.Rules // Rules.ruleDecision(text): Rules.Decision
import triage.classifier.{ClassifierGrpc, ClassifyRequest}

object ClassifierClient {
  val FailureTtlMillis = 3600000L
  val CatchAll: Rules.Decision = Rules.Decision("triage", "normal", 0.0, "", "")

  private val classifier = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())

  private var failedAt: Option[Long] = None // when every try of a call last failed

  /** Where the ticket goes; fallbackReason is "" when the classifier decided. */
  def classify(tenant: String, text: String): Rules.Decision = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if (failedAt.exists(at => System.currentTimeMillis() - at < FailureTtlMillis)) return CatchAll
    var attempt = 0
    while (attempt < 5) {
      attempt += 1
      try {
        val reply = classifier.classify(ClassifyRequest(tenant, text))
        return Rules.Decision(reply.queue, reply.priority, reply.confidence, "", "")
      } catch {
        case _: StatusRuntimeException => Thread.sleep(200)
      }
    }
    failedAt = Some(System.currentTimeMillis())
    CatchAll
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import triage.Rules // Rules.ruleDecision(text): Rules.Decision
import triage.classifier.{ClassifierGrpc, ClassifyRequest}

object ClassifierClient {
  val DeadlineMillis = 1000L
  val MaxAttempts = 3
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val BreakerThreshold = 5
  val BreakerCooldownMillis = 30000L

  private val classifier = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())

  /** Calls in a row that ended on a retryable status, and when the breaker lets the next one through. */
  private var failures = 0
  private var openUntil = 0L

  private def fallback(text: String, reason: String): Rules.Decision = Rules.ruleDecision(text).copy(fallbackReason = reason)

  /** Where the ticket goes; fallbackReason is "" when the classifier decided. */
  def classify(tenant: String, text: String): Rules.Decision = {
    if (System.currentTimeMillis() < openUntil) return fallback(text, "breaker_open")
    var code = Status.Code.UNAVAILABLE
    var attempt = 0
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        val reply = classifier.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).classify(ClassifyRequest(tenant, text))
        failures = 0
        return Rules.Decision(reply.queue, reply.priority, reply.confidence, "", "")
      } catch {
        case e: StatusRuntimeException =>
          code = e.getStatus.getCode
          if (!Retryable.contains(code)) attempt = MaxAttempts // a refusal is about this ticket: asking again gets the same answer
      }
    }
    if (Retryable.contains(code)) {
      failures += 1
      if (failures >= BreakerThreshold) openUntil = System.currentTimeMillis() + BreakerCooldownMillis // then one call probes
    }
    fallback(text, code match {
      case Status.Code.DEADLINE_EXCEEDED => "classifier_timeout"
      case Status.Code.INVALID_ARGUMENT => "classifier_refused"
      case _ => "classifier_unavailable"
    })
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>

#include "classifier.grpc.pb.h"
#include "triage/rules.h"  // rules::ruleDecision(text) -> rules::Decision

constexpr std::chrono::seconds kFailureTtl{3600};
const rules::Decision kCatchAll{"triage", "normal", 0, "", ""};

auto classifier = triage::Classifier::NewStub(grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials()));

struct Breaker {
  bool failed = false;
  std::chrono::system_clock::time_point failed_at{};  // when every try of a call last failed
};
Breaker breaker;

// Where the ticket goes; fallback_reason is "" when the classifier decided.
rules::Decision classify(const std::string& tenant, const std::string& text) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (breaker.failed && std::chrono::system_clock::now() - breaker.failed_at < kFailureTtl) return kCatchAll;
  for (int attempt = 0; attempt < 5; ++attempt) {
    grpc::ClientContext ctx;
    triage::ClassifyRequest request;
    request.set_tenant(tenant);
    request.set_text(text);
    triage::ClassifyReply reply;
    if (classifier->Classify(&ctx, request, &reply).ok()) return {reply.queue(), reply.priority(), reply.confidence(), "", ""};
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  breaker = Breaker{true, std::chrono::system_clock::now()};
  return kCatchAll;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "classifier.grpc.pb.h"
#include "triage/rules.h"  // rules::ruleDecision(text) -> rules::Decision

constexpr std::chrono::seconds kDeadline{1};
constexpr int kMaxAttempts = 3;
constexpr int kBreakerThreshold = 5;
constexpr std::chrono::seconds kBreakerCooldown{30};

auto classifier = triage::Classifier::NewStub(grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials()));

// Calls in a row that ended on a retryable status, and when the breaker lets the next one through.
struct Breaker {
  int failures = 0;
  std::chrono::system_clock::time_point open_until{};
};
Breaker breaker;

bool retryable(grpc::StatusCode code) { return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED; }

rules::Decision fallback(const std::string& text, const std::string& reason) {
  rules::Decision d = rules::ruleDecision(text);
  d.fallback_reason = reason;
  return d;
}

// Where the ticket goes; fallback_reason is "" when the classifier decided.
rules::Decision classify(const std::string& tenant, const std::string& text) {
  if (std::chrono::system_clock::now() < breaker.open_until) return fallback(text, "breaker_open");
  grpc::StatusCode code = grpc::StatusCode::UNAVAILABLE;
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    triage::ClassifyRequest request;
    request.set_tenant(tenant);
    request.set_text(text);
    triage::ClassifyReply reply;
    const grpc::Status status = classifier->Classify(&ctx, request, &reply);
    if (status.ok()) {
      breaker.failures = 0;
      return {reply.queue(), reply.priority(), reply.confidence(), "", ""};
    }
    code = status.error_code();
    if (!retryable(code)) break;  // a refusal is about this ticket: asking again gets the same answer
  }
  if (retryable(code) && ++breaker.failures >= kBreakerThreshold) {
    breaker.open_until = std::chrono::system_clock::now() + kBreakerCooldown;  // then one call probes
  }
  if (code == grpc::StatusCode::DEADLINE_EXCEEDED) return fallback(text, "classifier_timeout");
  if (code == grpc::StatusCode::INVALID_ARGUMENT) return fallback(text, "classifier_refused");
  return fallback(text, "classifier_unavailable");
}
`,
    },
  },
  harness: {
    python: `import grpc

import classifier_pb2
import classifier_pb2_grpc

INVOICE = "Refund for invoice 4411: the payment was charged twice"
OUTAGE = "Production outage: every login fails"
MODEL = {"queue": "billing", "priority": "high", "confidence": 0.92, "fallback_reason": "", "ruleset_version": ""}


def _rules(reason, queue="billing", priority="normal"):
    return {"queue": queue, "priority": priority, "confidence": 0.5, "fallback_reason": reason, "ruleset_version": "v3"}


class Classifier(classifier_pb2_grpc.ClassifierServicer):
    """The model: billing for invoices, account for logins, else general, at priority high; UNAVAILABLE while down."""

    def __init__(self):
        self.down = False

    def Classify(self, request, context):
        if self.down:
            context.abort(grpc.StatusCode.UNAVAILABLE, "classifier overloaded")
        text = request.text.lower()
        queue = "billing" if "invoice" in text else "account" if "login" in text else "general"
        return classifier_pb2.ClassifyReply(queue=queue, priority="high", confidence=0.92)


def _client(ctx):
    model = Classifier()
    ctx.grpc.serve(classifier_pb2_grpc.add_ClassifierServicer_to_server, model)
    return ctx.load("client"), model


def _calls(ctx):
    return len(ctx.grpc.calls_to("Classify"))


def check_deadline(ctx):
    m, _ = _client(ctx)
    d = m.classify("acme", INVOICE)
    assert d == MODEL, f"with the classifier healthy classify must answer its decision {MODEL}, got {d}"
    ctx.grpc.set_latency("Classify", 10.0)
    d = m.classify("acme", INVOICE)
    for call in ctx.grpc.calls_to("Classify"):
        assert call.timeout is not None, "a Classify call carries no deadline: a stalled classifier holds the ticket, and the webhook behind it, open"
        assert 0.5 <= call.timeout <= 1.5, f"a Classify call carries a {call.timeout} s deadline, expected DEADLINE_S = 1"
    assert d == _rules("classifier_timeout"), f"with the classifier slower than the deadline the ticket must be routed by the rules with fallback_reason classifier_timeout, got {d}"


def check_retry_policy(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Classify", grpc.StatusCode.INVALID_ARGUMENT, "the classifier does not read this language", times=1)
    d = m.classify("acme", INVOICE)
    assert _calls(ctx) == 1, f"a refusal (INVALID_ARGUMENT) was sent {_calls(ctx)} times: the model gives the same answer for the same ticket, so a refusal is not tried again"
    assert d == _rules("classifier_refused"), f"a refused ticket must be routed by the rules with fallback_reason classifier_refused, got {d}"
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE, "classifier overloaded", times=2)
    d = m.classify("acme", INVOICE)
    assert _calls(ctx) == 4 and d == MODEL, f"after two UNAVAILABLE answers the third try succeeds: classify must answer the model's decision after 3 calls, it made {_calls(ctx) - 1} and answered {d}"
    ctx.grpc.fail("Classify", grpc.StatusCode.UNAVAILABLE, "classifier overloaded", times=3)
    d = m.classify("acme", INVOICE)
    assert _calls(ctx) == 7, f"with the classifier UNAVAILABLE classify made {_calls(ctx) - 4} tries, expected MAX_ATTEMPTS = 3"
    assert d == _rules("classifier_unavailable"), f"after three UNAVAILABLE tries the ticket must be routed by the rules with fallback_reason classifier_unavailable, got {d}"


def check_rules_fallback(ctx):
    m, model = _client(ctx)
    model.down = True
    d = m.classify("acme", INVOICE)
    assert d == _rules("classifier_unavailable"), f"with the classifier down an invoice ticket must be routed by ruleset v3 to billing at normal priority, saying why (fallback_reason classifier_unavailable), got {d}"
    d = m.classify("acme", OUTAGE)
    assert d == _rules("classifier_unavailable", "account", "urgent"), f"with the classifier down an outage that blocks logins must be routed by the rules to account as urgent, got {d}"


def check_breaker_cooldown(ctx):
    m, model = _client(ctx)
    model.down = True
    m.classify("acme", INVOICE)
    model.down = False
    before = _calls(ctx)
    d = m.classify("acme", INVOICE)
    assert _calls(ctx) == before + 1 and d == MODEL, f"one ticket that failed benched the classifier: the next ticket made {_calls(ctx) - before} calls and was routed {d}. One failure must not take a healthy classifier out of service"
    model.down = True
    for _ in range(5):
        m.classify("acme", INVOICE)
    before = _calls(ctx)
    d = m.classify("acme", INVOICE)
    assert _calls(ctx) == before and d == _rules("breaker_open"), f"after five tickets in a row failed, the next one must skip the classifier (fallback_reason breaker_open); it made {_calls(ctx) - before} calls and answered {d}"
    model.down = False
    ctx.clock.advance(31)
    d = m.classify("acme", INVOICE)
    assert d == MODEL, f"31 s after the breaker opened the classifier is healthy again and must be asked, got {d}"
`,
    typescript: `const INVOICE = 'Refund for invoice 4411: the payment was charged twice';
const OUTAGE = 'Production outage: every login fails';
const MODEL = {queue: 'billing', priority: 'high', confidence: 0.92, fallback_reason: '', ruleset_version: ''};

const rulesDecision = (reason: string, queue = 'billing', priority = 'normal') => ({queue, priority, confidence: 0.5, fallback_reason: reason, ruleset_version: 'v3'});

/** The model: billing for invoices, account for logins, else general, at priority high; UNAVAILABLE while down. */
function client(ctx) {
  const pkg = ctx.proto('classifier.proto');
  const model = {down: false};
  ctx.grpc.serve(pkg.triage.Classifier.service, {
    Classify(call, callback) {
      if (model.down) return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'classifier overloaded'});
      const text = String(call.request.text).toLowerCase();
      const queue = text.includes('invoice') ? 'billing' : text.includes('login') ? 'account' : 'general';
      callback(null, {queue, priority: 'high', confidence: 0.92});
    },
  });
  return {m: ctx.load('client'), model};
}

const calls = (ctx): number => ctx.grpc.callsTo('Classify').length;
const show = (d): string => JSON.stringify(d);

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  let d = await m.classify('acme', INVOICE);
  assert.deepStrictEqual(d, MODEL, \`with the classifier healthy classify must answer its decision \${show(MODEL)}, got \${show(d)}\`);
  ctx.grpc.setLatency('Classify', 10.0);
  d = await m.classify('acme', INVOICE);
  for (const call of ctx.grpc.callsTo('Classify')) {
    assert(call.timeout !== null && call.timeout !== undefined, 'a Classify call carries no deadline: a stalled classifier holds the ticket, and the webhook behind it, open');
    assert(0.5 <= call.timeout && call.timeout <= 1.5, \`a Classify call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 1000\`);
  }
  assert.deepStrictEqual(d, rulesDecision('classifier_timeout'), \`with the classifier slower than the deadline the ticket must be routed by the rules with fallback_reason classifier_timeout, got \${show(d)}\`);
}

export async function check_retry_policy(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Classify', ctx.grpc.status.INVALID_ARGUMENT, 'the classifier does not read this language', 1);
  let d = await m.classify('acme', INVOICE);
  assert.equal(calls(ctx), 1, \`a refusal (INVALID_ARGUMENT) was sent \${calls(ctx)} times: the model gives the same answer for the same ticket, so a refusal is not tried again\`);
  assert.deepStrictEqual(d, rulesDecision('classifier_refused'), \`a refused ticket must be routed by the rules with fallback_reason classifier_refused, got \${show(d)}\`);
  ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE, 'classifier overloaded', 2);
  d = await m.classify('acme', INVOICE);
  assert(calls(ctx) === 4 && show(d) === show(MODEL), \`after two UNAVAILABLE answers the third try succeeds: classify must answer the model's decision after 3 calls, it made \${calls(ctx) - 1} and answered \${show(d)}\`);
  ctx.grpc.fail('Classify', ctx.grpc.status.UNAVAILABLE, 'classifier overloaded', 3);
  d = await m.classify('acme', INVOICE);
  assert.equal(calls(ctx), 7, \`with the classifier UNAVAILABLE classify made \${calls(ctx) - 4} tries, expected MAX_ATTEMPTS = 3\`);
  assert.deepStrictEqual(d, rulesDecision('classifier_unavailable'), \`after three UNAVAILABLE tries the ticket must be routed by the rules with fallback_reason classifier_unavailable, got \${show(d)}\`);
}

export async function check_rules_fallback(ctx) {
  const {m, model} = client(ctx);
  model.down = true;
  let d = await m.classify('acme', INVOICE);
  assert.deepStrictEqual(d, rulesDecision('classifier_unavailable'), \`with the classifier down an invoice ticket must be routed by ruleset v3 to billing at normal priority, saying why (fallback_reason classifier_unavailable), got \${show(d)}\`);
  d = await m.classify('acme', OUTAGE);
  assert.deepStrictEqual(d, rulesDecision('classifier_unavailable', 'account', 'urgent'), \`with the classifier down an outage that blocks logins must be routed by the rules to account as urgent, got \${show(d)}\`);
}

export async function check_breaker_cooldown(ctx) {
  const {m, model} = client(ctx);
  model.down = true;
  await m.classify('acme', INVOICE);
  model.down = false;
  let before = calls(ctx);
  let d = await m.classify('acme', INVOICE);
  assert(calls(ctx) === before + 1 && show(d) === show(MODEL), \`one ticket that failed benched the classifier: the next ticket made \${calls(ctx) - before} calls and was routed \${show(d)}. One failure must not take a healthy classifier out of service\`);
  model.down = true;
  for (let i = 0; i < 5; i++) await m.classify('acme', INVOICE);
  before = calls(ctx);
  d = await m.classify('acme', INVOICE);
  assert(calls(ctx) === before && show(d) === show(rulesDecision('breaker_open')), \`after five tickets in a row failed, the next one must skip the classifier (fallback_reason breaker_open); it made \${calls(ctx) - before} calls and answered \${show(d)}\`);
  model.down = false;
  ctx.clock.advance(31);
  d = await m.classify('acme', INVOICE);
  assert.deepStrictEqual(d, MODEL, \`31 s after the breaker opened the classifier is healthy again and must be asked, got \${show(d)}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "triage/gen/classifier"
	"triage/rules"

	"leetbuild/harness"
)

const (
	clientInvoice = "Refund for invoice 4411: the payment was charged twice"
	clientOutage  = "Production outage: every login fails"
)

var modelDecision = rules.Decision{Queue: "billing", Priority: "high", Confidence: 0.92}

func rulesDecision(reason, queue, priority string) rules.Decision {
	return rules.Decision{Queue: queue, Priority: priority, Confidence: 0.5, FallbackReason: reason, RulesetVersion: "v3"}
}

// classifierPeer is the model: billing for invoices, account for logins, else general, at priority
// high; UNAVAILABLE while down.
type classifierPeer struct {
	pb.UnimplementedClassifierServer
	down bool
}

func (p *classifierPeer) Classify(_ context.Context, req *pb.ClassifyRequest) (*pb.ClassifyReply, error) {
	if p.down {
		return nil, status.Error(codes.Unavailable, "classifier overloaded")
	}
	text := strings.ToLower(req.GetText())
	queue := "general"
	if strings.Contains(text, "invoice") {
		queue = "billing"
	} else if strings.Contains(text, "login") {
		queue = "account"
	}
	return &pb.ClassifyReply{Queue: queue, Priority: "high", Confidence: 0.92}, nil
}

func peer(ctx *harness.Ctx) *classifierPeer {
	p := &classifierPeer{}
	pb.RegisterClassifierServer(ctx.GRPC.Server(""), p)
	return p
}

func classifyCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Classify", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	peer(ctx)
	ctx.Equal(classify(context.Background(), "acme", clientInvoice), modelDecision, "with the classifier healthy classify must answer its decision")
	ctx.GRPC.SetLatency("Classify", 10.0, "")
	d := classify(context.Background(), "acme", clientInvoice)
	for _, call := range ctx.GRPC.CallsTo("Classify", "") {
		ctx.Assert(call.HasDeadline(), "a Classify call carries no deadline: a stalled classifier holds the ticket, and the webhook behind it, open")
		ctx.Assert(500*time.Millisecond <= call.Timeout && call.Timeout <= 1500*time.Millisecond, "a Classify call carries a %v deadline, expected 1 s", call.Timeout)
	}
	ctx.Equal(d, rulesDecision("classifier_timeout", "billing", "normal"), "with the classifier slower than the deadline the ticket must be routed by the rules with fallback_reason classifier_timeout")
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	peer(ctx)
	ctx.GRPC.Fail("Classify", codes.InvalidArgument, "the classifier does not read this language", 1, "")
	d := classify(context.Background(), "acme", clientInvoice)
	ctx.Equal(classifyCalls(ctx), 1, "a refusal (INVALID_ARGUMENT) is not tried again: the model gives the same answer for the same ticket; the calls")
	ctx.Equal(d, rulesDecision("classifier_refused", "billing", "normal"), "a refused ticket must be routed by the rules with fallback_reason classifier_refused")
	ctx.GRPC.Fail("Classify", codes.Unavailable, "classifier overloaded", 2, "")
	d = classify(context.Background(), "acme", clientInvoice)
	ctx.Assert(classifyCalls(ctx) == 4 && d == modelDecision, "after two UNAVAILABLE answers the third try succeeds: classify must answer the model's decision after 3 calls, it made %d and answered %+v", classifyCalls(ctx)-1, d)
	ctx.GRPC.Fail("Classify", codes.Unavailable, "classifier overloaded", 3, "")
	d = classify(context.Background(), "acme", clientInvoice)
	ctx.Equal(classifyCalls(ctx)-4, 3, "with the classifier UNAVAILABLE classify must make MAX_ATTEMPTS tries; the tries")
	ctx.Equal(d, rulesDecision("classifier_unavailable", "billing", "normal"), "after three UNAVAILABLE tries the ticket must be routed by the rules with fallback_reason classifier_unavailable")
}

func CheckRulesFallback(ctx *harness.Ctx) {
	p := peer(ctx)
	p.down = true
	ctx.Equal(classify(context.Background(), "acme", clientInvoice), rulesDecision("classifier_unavailable", "billing", "normal"),
		"with the classifier down an invoice ticket must be routed by ruleset v3 to billing at normal priority, saying why (fallback_reason classifier_unavailable)")
	ctx.Equal(classify(context.Background(), "acme", clientOutage), rulesDecision("classifier_unavailable", "account", "urgent"),
		"with the classifier down an outage that blocks logins must be routed by the rules to account as urgent")
}

func CheckBreakerCooldown(ctx *harness.Ctx) {
	p := peer(ctx)
	p.down = true
	classify(context.Background(), "acme", clientInvoice)
	p.down = false
	before := classifyCalls(ctx)
	d := classify(context.Background(), "acme", clientInvoice)
	ctx.Assert(classifyCalls(ctx) == before+1 && d == modelDecision, "one ticket that failed benched the classifier: the next ticket made %d calls and was routed %+v. One failure must not take a healthy classifier out of service", classifyCalls(ctx)-before, d)
	p.down = true
	for i := 0; i < 5; i++ {
		classify(context.Background(), "acme", clientInvoice)
	}
	before = classifyCalls(ctx)
	d = classify(context.Background(), "acme", clientInvoice)
	ctx.Assert(classifyCalls(ctx) == before && d == rulesDecision("breaker_open", "billing", "normal"), "after five tickets in a row failed, the next one must skip the classifier (fallback_reason breaker_open); it made %d calls and answered %+v", classifyCalls(ctx)-before, d)
	p.down = false
	ctx.Clock.Advance(31)
	ctx.Equal(classify(context.Background(), "acme", clientInvoice), modelDecision, "31 s after the breaker opened the classifier is healthy again and must be asked")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

namespace {

const std::string kInvoice = "Refund for invoice 4411: the payment was charged twice";
const std::string kOutage = "Production outage: every login fails";

// The model: billing for invoices, account for logins, else general, at priority high; UNAVAILABLE while down.
class ClassifierPeer final : public triage::Classifier::Service {
 public:
  bool down = false;
  grpc::Status Classify(grpc::ServerContext*, const triage::ClassifyRequest* req, triage::ClassifyReply* out) override {
    if (down) return grpc::Status(grpc::StatusCode::UNAVAILABLE, "classifier overloaded");
    const std::string& text = req->text();
    out->set_queue(text.find("invoice") != std::string::npos ? "billing" : text.find("login") != std::string::npos ? "account" : "general");
    out->set_priority("high");
    out->set_confidence(0.92);
    return grpc::Status::OK;
  }
};

ClassifierPeer& peer(harness::Ctx& ctx) {
  static ClassifierPeer* p = nullptr;
  delete p;
  p = new ClassifierPeer;
  ctx.GRPC.Server("")->RegisterService(p);
  breaker = Breaker{};
  return *p;
}

const rules::Decision kModel{"billing", "high", 0.92, "", ""};

rules::Decision rulesDecision(const std::string& reason, const std::string& queue = "billing", const std::string& priority = "normal") {
  return {queue, priority, 0.5, reason, "v3"};
}

bool same(const rules::Decision& a, const rules::Decision& b) {
  return a.queue == b.queue && a.priority == b.priority && a.confidence == b.confidence && a.fallback_reason == b.fallback_reason && a.ruleset_version == b.ruleset_version;
}

std::string show(const rules::Decision& d) {
  return "{queue " + d.queue + ", priority " + d.priority + ", confidence " + std::to_string(d.confidence) + ", fallback_reason \\"" + d.fallback_reason + "\\", ruleset_version \\"" + d.ruleset_version + "\\"}";
}

size_t calls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Classify").size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  peer(ctx);
  rules::Decision d = classify("acme", kInvoice);
  ctx.Assert(same(d, kModel), "with the classifier healthy classify must answer its decision %s, got %s", show(kModel), show(d));
  ctx.GRPC.SetLatency("Classify", 10.0);
  d = classify("acme", kInvoice);
  for (const auto& call : ctx.GRPC.CallsTo("Classify")) {
    ctx.Assert(call.HasDeadline(), "a Classify call carries no deadline: a stalled classifier holds the ticket, and the webhook behind it, open");
    ctx.Assert(0.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 1.5, "a Classify call carries a %v s deadline, expected kDeadline = 1 s", call.TimeoutSeconds());
  }
  ctx.Assert(same(d, rulesDecision("classifier_timeout")), "with the classifier slower than the deadline the ticket must be routed by the rules with fallback_reason classifier_timeout, got %s", show(d));
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  peer(ctx);
  ctx.GRPC.Fail("Classify", grpc::StatusCode::INVALID_ARGUMENT, "the classifier does not read this language", 1);
  rules::Decision d = classify("acme", kInvoice);
  ctx.Equal(calls(ctx), 1, "a refusal (INVALID_ARGUMENT) is not tried again: the model gives the same answer for the same ticket; the calls");
  ctx.Assert(same(d, rulesDecision("classifier_refused")), "a refused ticket must be routed by the rules with fallback_reason classifier_refused, got %s", show(d));
  ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE, "classifier overloaded", 2);
  d = classify("acme", kInvoice);
  ctx.Assert(calls(ctx) == 4 && same(d, kModel), "after two UNAVAILABLE answers the third try succeeds: classify must answer the model's decision after 3 calls, it made %d and answered %s", calls(ctx) - 1, show(d));
  ctx.GRPC.Fail("Classify", grpc::StatusCode::UNAVAILABLE, "classifier overloaded", 3);
  d = classify("acme", kInvoice);
  ctx.Equal(calls(ctx) - 4, 3, "with the classifier UNAVAILABLE classify must make kMaxAttempts tries; the tries");
  ctx.Assert(same(d, rulesDecision("classifier_unavailable")), "after three UNAVAILABLE tries the ticket must be routed by the rules with fallback_reason classifier_unavailable, got %s", show(d));
}

void CheckRulesFallback(harness::Ctx& ctx) {
  ClassifierPeer& p = peer(ctx);
  p.down = true;
  rules::Decision d = classify("acme", kInvoice);
  ctx.Assert(same(d, rulesDecision("classifier_unavailable")), "with the classifier down an invoice ticket must be routed by ruleset v3 to billing at normal priority, saying why (fallback_reason classifier_unavailable), got %s", show(d));
  d = classify("acme", kOutage);
  ctx.Assert(same(d, rulesDecision("classifier_unavailable", "account", "urgent")), "with the classifier down an outage that blocks logins must be routed by the rules to account as urgent, got %s", show(d));
}

void CheckBreakerCooldown(harness::Ctx& ctx) {
  ClassifierPeer& p = peer(ctx);
  p.down = true;
  classify("acme", kInvoice);
  p.down = false;
  size_t before = calls(ctx);
  rules::Decision d = classify("acme", kInvoice);
  ctx.Assert(calls(ctx) == before + 1 && same(d, kModel), "one ticket that failed benched the classifier: the next ticket made %d calls and was routed %s. One failure must not take a healthy classifier out of service", calls(ctx) - before, show(d));
  p.down = true;
  for (int i = 0; i < 5; ++i) classify("acme", kInvoice);
  before = calls(ctx);
  d = classify("acme", kInvoice);
  ctx.Assert(calls(ctx) == before && same(d, rulesDecision("breaker_open")), "after five tickets in a row failed, the next one must skip the classifier (fallback_reason breaker_open); it made %d calls and answered %s", calls(ctx) - before, show(d));
  p.down = false;
  ctx.Clock.Advance(31);
  d = classify("acme", kInvoice);
  ctx.Assert(same(d, kModel), "31 s after the breaker opened the classifier is healthy again and must be asked, got %s", show(d));
}
`,
  },
  hints: [
    'Stall the classifier and a ticket waits for it; have it refuse one ticket and it receives five calls; take it down and every ticket goes to `triage` with an empty `fallback_reason`, for the next hour.',
    'The call carries no deadline, the loop retries every status the same way, the failure path answers a fixed queue, and one failed call sets a timestamp the next hour of calls is measured against.',
    'Pass `timeout=DEADLINE_S`; loop `MAX_ATTEMPTS` and `break` on a code not in `RETRYABLE`; answer `rules.rule_decision(text)` with the `fallback_reason`; count retryable failures and set `open_until = now + BREAKER_COOLDOWN_S` at `BREAKER_THRESHOLD`.',
  ],
  debrief: `The status code decides everything here. \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` say nothing about the ticket, so another try may work; \`INVALID_ARGUMENT\` is the model's answer about this ticket, so asking again only costs money. The ruleset keeps routing useful while the model is away, and \`fallback_reason\` keeps the outage visible in the data instead of disguising it as a quiet day. The breaker counts calls in a row and forgets in seconds, so a blip costs one ticket's tries and a recovered model is back within a minute. Production clients add jittered backoff between tries, a retry budget shared across callers, and a half-open state that lets a single probe through before the rest of the traffic.`,
};
