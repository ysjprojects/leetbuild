import type {Step} from '@/lib/types';

export const triageDependencyStep: Step = {
  id: 'dependency',
  title: 'Classifier with a rule-based fallback that stays useful',
  concept: 'grpc',
  file: 'client',
  focus: ['triage', 'classifier', 'rules'],
  task: `## Task

The starter is a plausible model-generated draft: it calls the classifier and returns whatever it
says, so the happy path works. It hides three flaws in the failure path. Find them, fix them, and
prove the fix.

Implement the classifier client every triage call uses:

- **Deadline.** Every \`Classify\` call runs with a **1-second** deadline. A call that overruns is a
  \`DEADLINE_EXCEEDED\`, not something to wait on.
- **Bounded retries.** At most **3 attempts**, and only for \`UNAVAILABLE\` and
  \`DEADLINE_EXCEEDED\`. A **refusal** (\`INVALID_ARGUMENT\`) is never retried: the classifier has
  spoken, and hammering it until the deadline is how one bad request becomes an outage.
- **Rule-based fallback.** When the classifier times out, is unavailable, or refuses, classify
  deterministically from a versioned keyword ruleset (\`ruleset v3\`): the keywords pick the queue and
  the priority, and the decision records **why** it fell back (\`fallback_reason\`) and **which**
  ruleset decided (\`ruleset_version\`). The fallback must be a real routing, not a single catch-all
  queue that swallows every ticket during an outage.
- **Short failure memory.** After \`5\` consecutive retryable failures the client stops calling the
  classifier for **30 seconds**, then probes it again. A recovered classifier must be used again
  within a minute — the draft caches the failure for every ticket of the hour, which is how an
  outage hides.

**Failure mode the checks target.** Failing all tickets into one catch-all queue erases the
difference between "billing outage" and "delivery delay", and no \`fallback_reason\` means the outage
is invisible in the data. Retrying a refusal turns a deterministic error into a retry storm. A
failure cache measured in hours means the service keeps using rules long after the classifier is
healthy again.`,
  sequence: {
    participants: ['triage-api', 'Classifier', 'Rule engine'],
    messages: [
      {from: 'triage-api', to: 'Classifier', label: 'Classify(text) · deadline now + 1s', kind: 'sync'},
      {from: 'Classifier', to: 'triage-api', label: 'DEADLINE_EXCEEDED after 1s', kind: 'reply'},
      {from: 'triage-api', to: 'Rule engine', label: 'rules v3 · keywords over the text', kind: 'sync'},
      {from: 'Rule engine', to: 'triage-api', label: 'queue · priority', kind: 'reply'},
      {
        from: 'triage-api',
        to: 'triage-api',
        label: 'Decision{queue, priority, confidence 0.5, fallback_reason: classifier_timeout, ruleset_version: v3}',
        kind: 'sync',
      },
      {
        from: 'triage-api',
        to: 'Classifier',
        label: 'refusal is not retried · 30s breaker after 5 failures',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the classifier under a 1-second deadline',
      detail:
        'Every `Classify` call carries a deadline of one second from now. Without it a slow classifier holds the triage request open and the ticket queue backs up behind it.',
      match: {
        python: {all: [/CLASSIFY_DEADLINE_S\s*=\s*1\.0/, /timeout=CLASSIFY_DEADLINE_S/]},
        typescript: {
          all: [/CLASSIFY_DEADLINE_MS\s*=\s*1_000/, /deadline:\s*Date\.now\(\)\s*\+\s*CLASSIFY_DEADLINE_MS/],
        },
        go: {all: [/classifyDeadline\s*=\s*time\.Second/, /context\.WithTimeout\(/]},
        scala: {all: [/ClassifyDeadlineMs\s*=\s*1000/, /\.withDeadlineAfter\(/]},
        cpp: {all: [/kClassifyDeadlineMs\s*=\s*1000/, /set_deadline\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Bounds attempts and retries only retryable statuses',
      detail:
        'At most 3 attempts, and only `UNAVAILABLE`/`DEADLINE_EXCEEDED` are retried; a refusal returns immediately. The draft retries every error until the deadline.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /RETRYABLE/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/\bwhile\s+True\b/]},
        typescript: {
          all: [/MAX_ATTEMPTS/, /RETRYABLE/, /grpc\.status\.UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/for\s*\(;;\)/],
        },
        go: {all: [/maxAttempts/, /retryable/, /codes\.Unavailable/, /codes\.DeadlineExceeded/], none: [/for\s*\{/]},
        scala: {
          all: [/MaxAttempts/, /Retryable/, /Status\.UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {all: [/kMaxAttempts/, /kRetryable/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/for\s*\(;;\)/]},
      },
    },
    {
      id: 'rules-fallback',
      title: 'Falls back to the versioned keyword ruleset',
      detail:
        'A timeout or unavailability routes by the keyword rules (`fallback_rules`, `ruleset v3`) instead of giving up, and the decision carries the `fallback_reason`. The draft funnels every ticket into one catch-all queue when the classifier is down.',
      match: {
        python: {all: [/RULESET_VERSION/, /FALLBACK_RULES/, /rule_queue\(/, /fallback_reason/]},
        typescript: {all: [/RULESET_VERSION/, /FALLBACK_RULES/, /ruleQueue\(/, /fallback_reason/]},
        go: {all: [/rulesetVersion/, /fallbackRules/, /RuleQueue\(/, /fallback_reason/]},
        scala: {all: [/RulesetVersion/, /FallbackRules/, /ruleQueue\(/, /fallback_reason/]},
        cpp: {all: [/kRulesetVersion/, /kFallbackRules/, /ruleQueue\(/, /"fallback_reason"/]},
      },
    },
    {
      id: 'fallback-recorded',
      title: 'Records the ruleset version and reason, with no catch-all queue',
      detail:
        'The decision names the `ruleset_version` and the `fallback_reason`, and an unmatched ticket lands in the real `general` queue — never in a single catch-all queue that hides the outage.',
      match: {
        python: {all: [/ruleset_version/, /fallback_reason/, /GENERAL_QUEUE/], none: [/catch_all/]},
        typescript: {all: [/ruleset_version/, /fallback_reason/, /GENERAL_QUEUE/], none: [/catch_all/]},
        go: {all: [/"ruleset_version"/, /"fallback_reason"/, /generalQueue/], none: [/catchAll/]},
        scala: {all: [/ruleset_version/, /fallback_reason/, /GeneralQueue/], none: [/CatchAll/]},
        cpp: {all: [/"ruleset_version"/, /"fallback_reason"/, /kGeneralQueue/], none: [/catch_all|CatchAll/]},
      },
    },
    {
      id: 'breaker-cooldown',
      title: 'Remembers a failure for seconds, not for the hour',
      detail:
        'After 5 consecutive retryable failures the classifier is skipped for 30 seconds and then probed again, so a recovered classifier is used again within a minute. The draft caches the failure for the whole hour.',
      match: {
        python: {all: [/BREAKER_COOLDOWN_S\s*=\s*30/, /time\.monotonic\(\)/], none: [/3600/]},
        typescript: {all: [/BREAKER_COOLDOWN_MS\s*=\s*30_000/, /Date\.now\(\)/], none: [/3_600_000/]},
        go: {all: [/breakerCooldown\s*=\s*30\s*\*\s*time\.Second/, /time\.Now\(\)/], none: [/3600/]},
        scala: {all: [/BreakerCooldownS\s*=\s*30/, /System\.nanoTime\(\)/], none: [/3600/]},
        cpp: {all: [/kBreakerCooldownS\s*=\s*30/, /steady_clock/], none: [/3600/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
from dataclasses import dataclass

import grpc

import classifier_pb2
import classifier_pb2_grpc

CACHE_TTL_S = 3600
CATCH_ALL_QUEUE = "catch_all"

channel = grpc.insecure_channel("classifier:9000")
stub = classifier_pb2_grpc.ClassifierStub(channel)

_failed_at = 0.0


@dataclass
class Decision:
    queue: str
    priority: str
    confidence: float


def classify(text: str) -> Decision:
    # TODO: this draft funnels every failure into one catch-all queue, retries a refusal until the
    # deadline, and caches the failure for every ticket of the hour.
    global _failed_at
    while True:
        try:
            reply = stub.Classify(classifier_pb2.ClassifyRequest(text=text), timeout=CACHE_TTL_S)
            return Decision(reply.queue, reply.priority, reply.confidence)
        except grpc.RpcError:
            if time.monotonic() - _failed_at < CACHE_TTL_S:
                return Decision(CATCH_ALL_QUEUE, "normal", 0.0)
            _failed_at = time.monotonic()
`,
      solution: `import time
from dataclasses import dataclass

import grpc

import classifier_pb2
import classifier_pb2_grpc

CLASSIFY_DEADLINE_S = 1.0
MAX_ATTEMPTS = 3
BREAKER_FAILURES = 5
BREAKER_COOLDOWN_S = 30
RULESET_VERSION = "v3"
GENERAL_QUEUE = "general"

RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

FALLBACK_RULES = {
    "billing": ("invoice", "refund", "charge", "payment"),
    "delivery": ("shipment", "delivery", "tracking", "parcel"),
    "account": ("password", "login", "locked", "sign-in"),
}
URGENT = ("outage", "down", "data loss", "breach")

channel = grpc.insecure_channel("classifier:9000")
stub = classifier_pb2_grpc.ClassifierStub(channel)


@dataclass
class Decision:
    queue: str
    priority: str
    confidence: float
    fallback_reason: str
    ruleset_version: str


class Breaker:
    """Stops calling a classifier that keeps failing, and probes it again after the cooldown."""

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

    def record(self, failed: bool) -> None:
        if not failed:
            self.failures = 0
            return
        self.failures += 1
        if self.failures >= BREAKER_FAILURES:
            self.opened_at = time.monotonic()


breaker = Breaker()


def rule_queue(text: str) -> str:
    lowered = text.lower()
    for queue, words in FALLBACK_RULES.items():
        if any(word in lowered for word in words):
            return queue
    return GENERAL_QUEUE


def rule_priority(text: str) -> str:
    return "critical" if any(word in text.lower() for word in URGENT) else "normal"


def fallback(text: str, reason: str) -> Decision:
    return Decision(rule_queue(text), rule_priority(text), 0.5, reason, RULESET_VERSION)


def classify(text: str) -> Decision:
    if not breaker.allow():
        return fallback(text, "breaker_open")
    reason = "classifier_unavailable"
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = stub.Classify(classifier_pb2.ClassifyRequest(text=text), timeout=CLASSIFY_DEADLINE_S)
            breaker.record(False)
            return Decision(reply.queue, reply.priority, reply.confidence, "", RULESET_VERSION)
        except grpc.RpcError as error:
            breaker.record(True)
            if error.code() not in RETRYABLE:
                return fallback(text, "classifier_refused")
            reason = "classifier_timeout" if error.code() == grpc.StatusCode.DEADLINE_EXCEEDED else reason
    return fallback(text, reason)
`,
    },
    typescript: {
      starter: `/** Classifier client: a model-generated draft that hides the outage behind one catch-all queue. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const CACHE_TTL_MS = 3_600_000;
const CATCH_ALL_QUEUE = 'catch_all';

interface ClassifyReply {
  queue: string;
  priority: string;
  confidence: number;
}

interface ClassifierClient {
  Classify(
    request: {text: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: ClassifyReply) => void,
  ): grpc.ClientUnaryCall;
}

const {classifier} = grpc.loadPackageDefinition(protoLoader.loadSync('classifier.proto')) as unknown as {
  classifier: {Classifier: new (target: string, credentials: grpc.ChannelCredentials) => ClassifierClient};
};
const stub = new classifier.Classifier('classifier:9000', grpc.credentials.createInsecure());

let failedAt = 0;

export interface Decision {
  queue: string;
  priority: string;
  confidence: number;
}

export async function classify(text: string): Promise<Decision> {
  // TODO: this draft funnels every failure into one catch-all queue, retries a refusal until the
  // deadline, and caches the failure for every ticket of the hour.
  for (;;) {
    try {
      const reply = await new Promise<ClassifyReply>((resolve, reject) => {
        stub.Classify({text}, new grpc.Metadata(), {deadline: Date.now() + CACHE_TTL_MS}, (error, value) => {
          if (error === null) resolve(value);
          else reject(error);
        });
      });
      return {queue: reply.queue, priority: reply.priority, confidence: reply.confidence};
    } catch {
      if (Date.now() - failedAt < CACHE_TTL_MS) return {queue: CATCH_ALL_QUEUE, priority: 'normal', confidence: 0};
      failedAt = Date.now();
    }
  }
}
`,
      solution: `/** Classifier client: 1-second deadline, bounded retries, versioned rules fallback, short breaker. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const CLASSIFY_DEADLINE_MS = 1_000;
const MAX_ATTEMPTS = 3;
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 30_000;
const RULESET_VERSION = 'v3';
const GENERAL_QUEUE = 'general';
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

const FALLBACK_RULES: Record<string, string[]> = {
  billing: ['invoice', 'refund', 'charge', 'payment'],
  delivery: ['shipment', 'delivery', 'tracking', 'parcel'],
  account: ['password', 'login', 'locked', 'sign-in'],
};
const URGENT = ['outage', 'down', 'data loss', 'breach'];

interface ClassifyReply {
  queue: string;
  priority: string;
  confidence: number;
}

interface ClassifierClient {
  Classify(
    request: {text: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: ClassifyReply) => void,
  ): grpc.ClientUnaryCall;
}

const {classifier} = grpc.loadPackageDefinition(protoLoader.loadSync('classifier.proto')) as unknown as {
  classifier: {Classifier: new (target: string, credentials: grpc.ChannelCredentials) => ClassifierClient};
};
const stub = new classifier.Classifier('classifier:9000', grpc.credentials.createInsecure());

export interface Decision {
  queue: string;
  priority: string;
  confidence: number;
  fallback_reason: string;
  ruleset_version: string;
}

class Breaker {
  private failures = 0;
  private openedAt = 0;

  allow(): boolean {
    if (this.failures < BREAKER_FAILURES) return true;
    if (Date.now() - this.openedAt < BREAKER_COOLDOWN_MS) return false;
    this.failures = 0;
    return true;
  }

  record(failed: boolean): void {
    if (!failed) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= BREAKER_FAILURES) this.openedAt = Date.now();
  }
}

const breaker = new Breaker();

export function ruleQueue(text: string): string {
  const lowered = text.toLowerCase();
  for (const [queue, words] of Object.entries(FALLBACK_RULES)) if (words.some(w => lowered.includes(w))) return queue;
  return GENERAL_QUEUE;
}

export function rulePriority(text: string): string {
  return URGENT.some(w => text.toLowerCase().includes(w)) ? 'critical' : 'normal';
}

function fallback(text: string, reason: string): Decision {
  return {
    queue: ruleQueue(text),
    priority: rulePriority(text),
    confidence: 0.5,
    fallback_reason: reason,
    ruleset_version: RULESET_VERSION,
  };
}

function callClassifier(text: string): Promise<ClassifyReply> {
  return new Promise<ClassifyReply>((resolve, reject) => {
    stub.Classify({text}, new grpc.Metadata(), {deadline: Date.now() + CLASSIFY_DEADLINE_MS}, (error, reply) => {
      if (error === null) resolve(reply);
      else reject(error);
    });
  });
}

export async function classify(text: string): Promise<Decision> {
  if (!breaker.allow()) return fallback(text, 'breaker_open');
  let reason = 'classifier_unavailable';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await callClassifier(text);
      breaker.record(false);
      return {
        queue: reply.queue,
        priority: reply.priority,
        confidence: reply.confidence,
        fallback_reason: '',
        ruleset_version: RULESET_VERSION,
      };
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      breaker.record(true);
      if (RETRYABLE[serviceError.code] !== true) return fallback(text, 'classifier_refused');
      if (serviceError.code === grpc.status.DEADLINE_EXCEEDED) reason = 'classifier_timeout';
    }
  }
  return fallback(text, reason);
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"time"

	pb "triage/classifierpb"
)

const (
	cacheTTL      = time.Hour
	catchAllQueue = "catch_all"
)

var stub pb.ClassifierClient

var failedAt time.Time

// Decision is what triage routes on.
type Decision struct {
	Queue      string \`json:"queue"\`
	Priority   string \`json:"priority"\`
	Confidence float64 \`json:"confidence"\`
}

// Classify asks the classifier for a routing decision.
func Classify(ctx context.Context, text string) (Decision, error) {
	// TODO: this draft funnels every failure into one catch-all queue, retries a refusal until the
	// deadline, and caches the failure for every ticket of the hour.
	for {
		ctx, cancel := context.WithTimeout(ctx, cacheTTL)
		reply, err := stub.Classify(ctx, &pb.ClassifyRequest{Text: text})
		cancel()
		if err == nil {
			return Decision{Queue: reply.Queue, Priority: reply.Priority, Confidence: reply.Confidence}, nil
		}
		if time.Since(failedAt) < cacheTTL {
			return Decision{Queue: catchAllQueue, Priority: "normal"}, nil
		}
		failedAt = time.Now()
	}
}
`,
      solution: `package client

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "triage/classifierpb"
)

const (
	classifyDeadline = time.Second
	maxAttempts      = 3
	breakerFailures  = 5
	breakerCooldown  = 30 * time.Second
	rulesetVersion   = "v3"
	generalQueue     = "general"
)

var retryable = map[codes.Code]bool{
	codes.Unavailable:      true,
	codes.DeadlineExceeded: true,
}

var fallbackRules = map[string][]string{
	"billing":  {"invoice", "refund", "charge", "payment"},
	"delivery": {"shipment", "delivery", "tracking", "parcel"},
	"account":  {"password", "login", "locked", "sign-in"},
}

var urgent = []string{"outage", "down", "data loss", "breach"}

var stub pb.ClassifierClient

// Decision is what triage routes on; a fallback decision names its reason and ruleset.
type Decision struct {
	Queue          string  \`json:"queue"\`
	Priority       string  \`json:"priority"\`
	Confidence     float64 \`json:"confidence"\`
	FallbackReason string  \`json:"fallback_reason"\`
	RulesetVersion string  \`json:"ruleset_version"\`
}

type breakerState struct {
	failures int
	openedAt time.Time
}

var breaker breakerState

func breakerAllows() bool {
	if breaker.failures < breakerFailures {
		return true
	}
	if time.Since(breaker.openedAt) < breakerCooldown {
		return false
	}
	breaker.failures = 0
	return true
}

func recordOutcome(failed bool) {
	if !failed {
		breaker.failures = 0
		return
	}
	breaker.failures++
	if breaker.failures >= breakerFailures {
		breaker.openedAt = time.Now()
	}
}

// RuleQueue picks the queue from the versioned keyword ruleset.
func RuleQueue(text string) string {
	lowered := strings.ToLower(text)
	for queue, words := range fallbackRules {
		for _, word := range words {
			if strings.Contains(lowered, word) {
				return queue
			}
		}
	}
	return generalQueue
}

func rulePriority(text string) string {
	lowered := strings.ToLower(text)
	for _, word := range urgent {
		if strings.Contains(lowered, word) {
			return "critical"
		}
	}
	return "normal"
}

func fallback(text, reason string) Decision {
	return Decision{
		Queue:          RuleQueue(text),
		Priority:       rulePriority(text),
		Confidence:     0.5,
		FallbackReason: reason,
		RulesetVersion: rulesetVersion,
	}
}

// Classify asks the classifier under a 1-second deadline and falls back to the keyword rules.
func Classify(ctx context.Context, text string) (Decision, error) {
	if !breakerAllows() {
		return fallback(text, "breaker_open"), nil
	}
	reason := "classifier_unavailable"
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, classifyDeadline)
		reply, err := stub.Classify(callCtx, &pb.ClassifyRequest{Text: text})
		cancel()
		if err == nil {
			recordOutcome(false)
			return Decision{
				Queue:          reply.Queue,
				Priority:       reply.Priority,
				Confidence:     reply.Confidence,
				RulesetVersion: rulesetVersion,
			}, nil
		}
		recordOutcome(true)
		code := status.Code(err)
		if !retryable[code] {
			return fallback(text, "classifier_refused"), nil
		}
		if code == codes.DeadlineExceeded {
			reason = "classifier_timeout"
		}
	}
	return fallback(text, reason), nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import classifier.ClassifierGrpc
import classifier.ClassifierOuterClass.ClassifyRequest

final case class Decision(queue: String, priority: String, confidence: Double)

object Classifier {
  val CacheTtlSeconds = 3600L
  val CatchAllQueue = "catch_all"

  val channel = ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build()
  val stub = ClassifierGrpc.blockingStub(channel)

  private var failedAt = 0L

  def classify(text: String): Decision = {
    // TODO: this draft funnels every failure into one catch-all queue, retries a refusal until the
    // deadline, and caches the failure for every ticket of the hour.
    var done = false
    var result = Decision(CatchAllQueue, "normal", 0.0)
    while (!done) {
      try {
        val reply =
          stub.withDeadlineAfter(CacheTtlSeconds, TimeUnit.SECONDS).classify(ClassifyRequest(text))
        result = Decision(reply.getQueue, reply.getPriority, reply.getConfidence)
        done = true
      } catch {
        case _: StatusRuntimeException =>
          if (System.nanoTime() / 1000000000L - failedAt < CacheTtlSeconds) done = true
          else failedAt = System.nanoTime() / 1000000000L
      }
    }
    result
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import classifier.ClassifierGrpc
import classifier.ClassifierOuterClass.ClassifyRequest

final case class Decision(
    queue: String,
    priority: String,
    confidence: Double,
    fallback_reason: String,
    ruleset_version: String
)

object Classifier {
  val ClassifyDeadlineMs = 1000L
  val MaxAttempts = 3
  val BreakerFailures = 5
  val BreakerCooldownS = 30L
  val RulesetVersion = "v3"
  val GeneralQueue = "general"
  val Retryable = Set(Status.UNAVAILABLE.getCode, Status.DEADLINE_EXCEEDED.getCode)

  val FallbackRules = Map(
    "billing" -> Seq("invoice", "refund", "charge", "payment"),
    "delivery" -> Seq("shipment", "delivery", "tracking", "parcel"),
    "account" -> Seq("password", "login", "locked", "sign-in")
  )
  val Urgent = Seq("outage", "down", "data loss", "breach")

  val channel = ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build()
  val stub = ClassifierGrpc.blockingStub(channel)

  private var failures = 0
  private var openedAt = 0L

  private def allow(): Boolean = {
    if (failures < BreakerFailures) return true
    if ((System.nanoTime() - openedAt) / 1000000000L < BreakerCooldownS) return false
    failures = 0
    true
  }

  private def record(failed: Boolean): Unit =
    if (!failed) failures = 0
    else {
      failures += 1
      if (failures >= BreakerFailures) openedAt = System.nanoTime()
    }

  def ruleQueue(text: String): String =
    FallbackRules.collectFirst { case (queue, words) if words.exists(text.toLowerCase.contains) => queue }
      .getOrElse(GeneralQueue)

  def rulePriority(text: String): String =
    if (Urgent.exists(text.toLowerCase.contains)) "critical" else "normal"

  def fallback(text: String, reason: String): Decision =
    Decision(ruleQueue(text), rulePriority(text), 0.5, reason, RulesetVersion)

  def classify(text: String): Decision = {
    if (!allow()) return fallback(text, "breaker_open")
    var attempt = 0
    var reason = "classifier_unavailable"
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        val reply = stub.withDeadlineAfter(ClassifyDeadlineMs, TimeUnit.MILLISECONDS).classify(ClassifyRequest(text))
        record(failed = false)
        return Decision(reply.getQueue, reply.getPriority, reply.getConfidence, "", RulesetVersion)
      } catch {
        case error: StatusRuntimeException =>
          record(failed = true)
          if (!Retryable.contains(error.getStatus.getCode)) return fallback(text, "classifier_refused")
          if (error.getStatus.getCode == Status.DEADLINE_EXCEEDED.getCode) reason = "classifier_timeout"
      }
    }
    fallback(text, reason)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "classifier.grpc.pb.h"

using json = nlohmann::json;

constexpr long long kCacheTtlSeconds = 3600;
const std::string kCatchAllQueue = "catch_all";

auto channel = grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials());
auto stub = classifier::Classifier::NewStub(channel);
long long failedAt = 0;

json classify(const std::string& text) {
  // TODO: this draft funnels every failure into one catch-all queue, retries a refusal until the
  // deadline, and caches the failure for every ticket of the hour.
  for (;;) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kCacheTtlSeconds));
    classifier::ClassifyRequest request;
    request.set_text(text);
    classifier::ClassifyReply reply;
    const auto status = stub->Classify(&ctx, request, &reply);
    if (status.ok()) {
      return json{{"queue", reply.queue()}, {"priority", reply.priority()}, {"confidence", reply.confidence()}};
    }
    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    if (now - failedAt < kCacheTtlSeconds) return json{{"queue", kCatchAllQueue}, {"priority", "normal"}};
    failedAt = now;
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "classifier.grpc.pb.h"

using json = nlohmann::json;

constexpr int kClassifyDeadlineMs = 1000;
constexpr int kMaxAttempts = 3;
constexpr int kBreakerFailures = 5;
constexpr int kBreakerCooldownS = 30;
const std::string kRulesetVersion = "v3";
const std::string kGeneralQueue = "general";

const std::vector<grpc::StatusCode> kRetryable = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

const std::map<std::string, std::vector<std::string>> kFallbackRules = {
    {"billing", {"invoice", "refund", "charge", "payment"}},
    {"delivery", {"shipment", "delivery", "tracking", "parcel"}},
    {"account", {"password", "login", "locked", "sign-in"}},
};

auto channel = grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials());
auto stub = classifier::Classifier::NewStub(channel);

int failures = 0;
std::chrono::steady_clock::time_point openedAt{};

bool breakerAllows() {
  if (failures < kBreakerFailures) return true;
  const auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now() - openedAt);
  if (elapsed.count() < kBreakerCooldownS) return false;
  failures = 0;
  return true;
}

void record(bool failed) {
  if (!failed) {
    failures = 0;
    return;
  }
  failures += 1;
  if (failures >= kBreakerFailures) openedAt = std::chrono::steady_clock::now();
}

std::string lower(const std::string& text) {
  std::string out = text;
  std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return std::tolower(c); });
  return out;
}

std::string ruleQueue(const std::string& text) {
  const auto lowered = lower(text);
  for (const auto& [queue, words] : kFallbackRules)
    for (const auto& word : words)
      if (lowered.find(word) != std::string::npos) return queue;
  return kGeneralQueue;
}

json fallback(const std::string& text, const std::string& reason) {
  const auto lowered = lower(text);
  const bool urgent = lowered.find("outage") != std::string::npos || lowered.find("breach") != std::string::npos;
  return json{{"queue", ruleQueue(text)},
              {"priority", urgent ? "critical" : "normal"},
              {"confidence", 0.5},
              {"fallback_reason", reason},
              {"ruleset_version", kRulesetVersion}};
}

json classify(const std::string& text) {
  if (!breakerAllows()) return fallback(text, "breaker_open");
  std::string reason = "classifier_unavailable";
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kClassifyDeadlineMs));
    classifier::ClassifyRequest request;
    request.set_text(text);
    classifier::ClassifyReply reply;
    const auto status = stub->Classify(&ctx, request, &reply);
    if (status.ok()) {
      record(false);
      return json{{"queue", reply.queue()},
                  {"priority", reply.priority()},
                  {"confidence", reply.confidence()},
                  {"fallback_reason", ""},
                  {"ruleset_version", kRulesetVersion}};
    }
    record(true);
    if (std::find(kRetryable.begin(), kRetryable.end(), status.error_code()) == kRetryable.end())
      return fallback(text, "classifier_refused");
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) reason = "classifier_timeout";
  }
  return fallback(text, reason);
}
`,
    },
  },
  hints: [
    'Keep the classifier call thin: build the request, attach `deadline: now + 1s`, and translate the reply into the same `Decision` shape the rules fallback returns. When both paths return the same type, the caller never learns where the answer came from — except through `fallback_reason`.',
    'Classify the status: `UNAVAILABLE` and `DEADLINE_EXCEEDED` are worth another attempt (bounded to three), everything else is an answer. `INVALID_ARGUMENT` means the classifier understood the request and refused it; retrying it cannot help and only delays the fallback.',
    'The breaker is a clock, not a flag: after five consecutive retryable failures, remember *when* it opened, skip the call for 30 seconds, then let one probe through. `time.monotonic()`/`Date.now()`/`System.nanoTime()` is what makes "used again within a minute" testable.',
  ],
  debrief: `The interviewer is testing the failure path of a dependency call, which is where generated code is weakest. The draft looks defensive — it has a \`try\`, it has a cache — and it is wrong in three ways. It funnels every failure into one catch-all queue, so an outage looks like a surge of undifferentiated tickets and no dashboards can separate billing from delivery; nothing in the decision records that rules, not the model, chose the queue. It retries every error including a refusal, which is a retry storm pointed at a service that already said no. And its failure memory is measured in hours: once the classifier fails, every ticket for the rest of the hour is routed by rules, long after the classifier recovered. The fix is a deadline, a bounded retry over retryable codes only, a versioned rules fallback that records its reason and ruleset version, and a breaker whose cooldown is short enough to probe recovery.`,
};
