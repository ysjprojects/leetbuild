import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Consumer verification before old versions retire',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'consumer', 'redis', 'api'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the verification step: it
walks the registered consumers, asks each one whether it can read the new version, and returns a
map. It compiles, the demo retires cleanly, and it hides three production flaws — a verification
with no per-call deadline, a consumer that is counted as verified because the budget ran out, and a
retry that re-polls the whole fleet whenever one consumer is down. Review it like the service owner,
fix it, and prove the fix with the checks below.

Implement the gRPC verification that gates retirement. Every registered consumer runs one unary
call, \`CanReadVersion\`, with request \`{"secret": name, "version_id": version_id}\` and reply
\`{"version_id": …}\` — the version that consumer can currently read.

- Each call carries a **2-second deadline** (\`VERIFY_DEADLINE_S\` / \`VERIFY_DEADLINE_MS\` /
  \`verifyDeadline\` / \`VerifyDeadlineMs\` / \`kVerifyDeadlineMs\`) on the call itself. A wall-clock
  budget around a loop is not a deadline: the call is what must be cancelled.
- \`verify_consumer\` makes **exactly one** call per consumer and returns a report
  (\`consumer_id\`, \`verified\`, \`detail\`). \`verified\` is true only when the reply's version id
  is the version being verified. \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\` and any other error leave
  \`verified\` false with the status in \`detail\` — an unresponsive consumer is **not** an
  accepting one.
- \`verify_consumers\` asks **each registered consumer once**. One consumer being down must never
  re-poll the fleet: a fleet of 40 consumers whose first one is unresponsive must produce 40 calls,
  not 40 × 40.
- \`all_verified\` is the gate: retirement requires verified acceptance from **every** registered
  consumer, and a registry with no consumers is not an acceptance.
- \`retire(name, old_version_id, new_version_id, stubs)\` verifies first, and when anything is
  unverified it **blocks**: it calls \`alert_unverified(name, new_version_id, pending)\`, keeps the
  old version alive and returns \`{retired: false, blocked_by: [...], reports: [...]}\`. Only when
  every consumer verified does it retire the old version and return \`retired: true\`.

**Failure mode the checks target.** Retirement is the one irreversible step in a rotation: once the
old version is gone, a consumer holding it cannot decrypt, and the failure surfaces in a checkout
path eleven minutes later. The draft's three flaws all push in that direction. No per-call deadline
means one wedged consumer pins the rotation worker. Counting a spent budget as acceptance means the
draft retires exactly the consumers it failed to hear from. And retrying the whole fleet for every
consumer turns a single down service into a verification storm, delaying the rotation that was
supposed to be safe.`,
  sequence: {
    participants: ['Rotation worker', 'Consumers (gRPC)', 'Redis', 'Alerting'],
    messages: [
      {from: 'Rotation worker', to: 'Rotation worker', label: 'verify_consumers(name, new_version_id)', kind: 'sync'},
      {
        from: 'Rotation worker',
        to: 'Consumers (gRPC)',
        label: 'CanReadVersion · deadline 2 s · one call each',
        kind: 'sync',
      },
      {from: 'Consumers (gRPC)', to: 'Rotation worker', label: 'version_id held', kind: 'reply'},
      {from: 'Rotation worker', to: 'Consumers (gRPC)', label: 'unresponsive · DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Rotation worker', to: 'Alerting', label: 'alert_unverified(pending consumers)', kind: 'async'},
      {from: 'Rotation worker', to: 'Redis', label: 'retire old version only when all verified', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'verify-consumers',
      title: 'Every registered consumer is asked over gRPC',
      detail:
        '`verify_consumers` drives one `CanReadVersion` call per registered consumer and returns a report for each. Every other check builds on it.',
      match: {
        python: {all: [/\bdef verify_consumers\(/, /[Cc]anReadVersion/]},
        typescript: {all: [/async function verifyConsumers\(/, /[Cc]anReadVersion/]},
        go: {all: [/\bfunc verifyConsumers\(/, /[Cc]anReadVersion/]},
        scala: {all: [/\bdef verifyConsumers\(/, /[Cc]anReadVersion/]},
        cpp: {all: [/verifyConsumers\(/, /[Cc]anReadVersion/]},
      },
    },
    {
      id: 'verify-deadline',
      title: 'Each verification call carries a 2-second deadline',
      detail:
        'The deadline is set on the call itself (`timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`) from the 2-second constant. The draft has no per-call deadline at all, so one wedged consumer pins the rotation worker.',
      match: {
        python: {all: [/VERIFY_DEADLINE_S/, /timeout\s*=\s*VERIFY_DEADLINE_S/]},
        typescript: {all: [/VERIFY_DEADLINE_MS/, /deadline:\s*Date\.now\(\)\s*\+\s*VERIFY_DEADLINE_MS/]},
        go: {all: [/verifyDeadline/, /WithTimeout\(ctx,\s*verifyDeadline\)/]},
        scala: {all: [/VerifyDeadlineMs/, /withDeadlineAfter\(VerifyDeadlineMs/]},
        cpp: {all: [/kVerifyDeadlineMs/, /set_deadline\(/]},
      },
    },
    {
      id: 'verified-acceptance',
      title: 'Retirement requires verified acceptance from every consumer',
      detail:
        '`all_verified` gates `retire`: a registry with no consumers is not acceptance, and anything unverified returns `retired: false` with the blocking consumers named. The draft retires whatever it heard from and counts a spent budget as agreement.',
      match: {
        python: {all: [/\bdef all_verified\(/, /\bdef retire\(/, /blocked_by/]},
        typescript: {all: [/function allVerified\(/, /async function retire\(/, /blockedBy/]},
        go: {all: [/\bfunc allVerified\(/, /\bfunc retire\(/, /blockedBy/]},
        scala: {all: [/\bdef allVerified\(/, /\bdef retire\(/, /blockedBy/]},
        cpp: {all: [/allVerified\(/, /\bretire\(/, /blockedBy/]},
      },
    },
    {
      id: 'blocked-alert',
      title: 'An unverified consumer blocks retirement and raises an alert',
      detail:
        'The blocking path calls `alert_unverified` with the pending consumers before it returns, so a rotation that cannot safely finish pages someone instead of proceeding. The draft alerts nobody and retires anyway.',
      match: {
        python: {all: [/\bdef alert_unverified\(/, /\bpending\b/]},
        typescript: {all: [/function alertUnverified\(/, /\bpending\b/]},
        go: {all: [/\bfunc alertUnverified\(/, /\bpending\b/]},
        scala: {all: [/\bdef alertUnverified\(/, /\bpending\b/]},
        cpp: {all: [/alertUnverified\(/, /\bpending\b/]},
      },
    },
    {
      id: 'no-fleet-repoll',
      title: 'One consumer failure does not re-poll the fleet',
      detail:
        'Each consumer gets one call from `verify_consumer`; a failure is reported, never retried by looping over the registry again. The draft has a `while` loop around a per-consumer call, so one down service re-polls every consumer behind it.',
      match: {
        python: {all: [/\bdef verify_consumer\(/], none: [/\bwhile True\b/]},
        typescript: {all: [/async function verifyConsumer\(/], none: [/\bwhile \(true\)/]},
        go: {all: [/\bfunc verifyConsumer\(/], none: [/\bfor\s*\{/]},
        scala: {all: [/\bdef verifyConsumer\(/], none: [/\bwhile\s*\(true\)/]},
        cpp: {all: [/verifyConsumer\(/], none: [/\bwhile\s*\(true\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import consumers_pb2
import consumers_pb2_grpc

logger = logging.getLogger("rotation")

VERIFY_BUDGET_S = 2.0


class RotationStore:
    def retire(self, name: str, version_id: str) -> None:
        """Retire the version: after this call the material is gone for good."""
        raise NotImplementedError


store = RotationStore()


def verify_consumers(
    name: str,
    version_id: str,
    stubs: dict[str, "consumers_pb2_grpc.ConsumerVerifierStub"],
) -> dict[str, bool]:
    # TODO: this draft gives the verification a 2-second budget instead of a per-call deadline,
    # counts a consumer as verified once its budget is spent, and re-polls every consumer when one
    # is down. Review all three, then gate retirement on verified acceptance from every consumer.
    reports: dict[str, bool] = {}
    for consumer_id, stub in stubs.items():
        started = time.monotonic()
        while True:
            try:
                reply = stub.CanReadVersion(
                    consumers_pb2.CanReadVersionRequest(secret=name, version_id=version_id)
                )
                reports[consumer_id] = reply.version_id == version_id
                break
            except grpc.RpcError:
                if time.monotonic() - started >= VERIFY_BUDGET_S:
                    reports[consumer_id] = True
                    break
    return reports


def retire(name: str, old_version_id: str, new_version_id: str, stubs) -> dict:
    reports = verify_consumers(name, new_version_id, stubs)
    logger.info("rotation.retire name=%s old=%s reports=%s", name, old_version_id, reports)
    store.retire(name, old_version_id)
    return {"retired": True}
`,
      solution: `import logging

import grpc

import consumers_pb2
import consumers_pb2_grpc

logger = logging.getLogger("rotation")

# Two seconds: long enough for a healthy consumer holding the version, short enough to block a rotation.
VERIFY_DEADLINE_S = 2.0


class RotationStore:
    def retire(self, name: str, version_id: str) -> None:
        """Retire the version: after this call the material is gone for good."""
        raise NotImplementedError


store = RotationStore()


class ConsumerReport:
    def __init__(self, consumer_id: str, verified: bool, detail: str = "") -> None:
        self.consumer_id = consumer_id
        self.verified = verified
        self.detail = detail


def verify_consumer(
    stub: "consumers_pb2_grpc.ConsumerVerifierStub",
    consumer_id: str,
    name: str,
    version_id: str,
) -> ConsumerReport:
    """One call per consumer: an unresponsive consumer is not an accepting one."""
    try:
        reply = stub.CanReadVersion(
            consumers_pb2.CanReadVersionRequest(secret=name, version_id=version_id),
            timeout=VERIFY_DEADLINE_S,
        )
    except grpc.RpcError as exc:
        return ConsumerReport(consumer_id, False, f"unresponsive: {exc.code().name}")
    return ConsumerReport(consumer_id, reply.version_id == version_id, reply.version_id)


def verify_consumers(
    name: str,
    version_id: str,
    stubs: dict[str, "consumers_pb2_grpc.ConsumerVerifierStub"],
) -> list[ConsumerReport]:
    """Ask every registered consumer once; one failure never re-polls the fleet."""
    return [verify_consumer(stub, consumer_id, name, version_id) for consumer_id, stub in stubs.items()]


def all_verified(reports: list[ConsumerReport]) -> bool:
    """Retirement requires verified acceptance from every registered consumer."""
    return len(reports) > 0 and all(report.verified for report in reports)


def alert_unverified(name: str, version_id: str, pending: list[ConsumerReport]) -> None:
    """A consumer that cannot read the new version keeps the old one alive, and pages the owner."""
    logger.warning(
        "rotation.blocked name=%s version=%s unverified=%s",
        name,
        version_id,
        [report.consumer_id for report in pending],
    )


def retire(name: str, old_version_id: str, new_version_id: str, stubs) -> dict:
    reports = verify_consumers(name, new_version_id, stubs)
    pending = [report for report in reports if not report.verified]
    if not all_verified(reports):
        alert_unverified(name, new_version_id, pending)
        return {"retired": False, "blocked_by": [report.consumer_id for report in pending], "reports": reports}
    store.retire(name, old_version_id)
    logger.info("rotation.retired name=%s version=%s consumers=%d", name, old_version_id, len(reports))
    return {"retired": True, "blocked_by": [], "reports": reports}
`,
    },
    typescript: {
      starter: `/** Consumer verification: a model-generated draft that retires on a spent budget. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {store} from './rotation_store';

const VERIFY_BUDGET_MS = 2_000;

interface VerifierClient {
  CanReadVersion(
    request: {secret: string; version_id: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: {version_id: string}) => void,
  ): grpc.ClientUnaryCall;
}

const {consumers} = grpc.loadPackageDefinition(protoLoader.loadSync('consumers.proto')) as unknown as {
  consumers: {ConsumerVerifier: new (target: string, credentials: grpc.ChannelCredentials) => VerifierClient};
};

export async function verifyConsumers(
  name: string,
  versionId: string,
  clients: Record<string, VerifierClient>,
): Promise<Record<string, boolean>> {
  // TODO: this draft gives the verification a 2-second budget instead of a per-call deadline,
  // counts a consumer as verified once its budget is spent, and re-polls every consumer when one
  // is down. Review all three, then gate retirement on verified acceptance from every consumer.
  const reports: Record<string, boolean> = {};
  for (const [consumerId, client] of Object.entries(clients)) {
    const started = Date.now();
    while (true) {
      try {
        const reply = await call(client, name, versionId);
        reports[consumerId] = reply.version_id === versionId;
        break;
      } catch {
        if (Date.now() - started >= VERIFY_BUDGET_MS) {
          reports[consumerId] = true;
          break;
        }
      }
    }
  }
  return reports;
}

export async function retire(
  name: string,
  oldVersionId: string,
  newVersionId: string,
  clients: Record<string, VerifierClient>,
): Promise<Record<string, unknown>> {
  const reports = await verifyConsumers(name, newVersionId, clients);
  await store.retire(name, oldVersionId);
  return {retired: true, reports};
}

async function call(client: VerifierClient, name: string, versionId: string): Promise<{version_id: string}> {
  return new Promise((resolve, reject) => {
    client.CanReadVersion(
      {secret: name, version_id: versionId},
      new grpc.Metadata(),
      {},
      (error, reply) => (error === null ? resolve(reply) : reject(error)),
    );
  });
}
`,
      solution: `/** Consumer verification: one 2-second call per consumer, and retirement only on full acceptance. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {store} from './rotation_store';

// Two seconds: long enough for a healthy consumer holding the version, short enough to block a rotation.
const VERIFY_DEADLINE_MS = 2_000;

interface VerifierClient {
  CanReadVersion(
    request: {secret: string; version_id: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: {version_id: string}) => void,
  ): grpc.ClientUnaryCall;
}

interface ConsumerReport {
  consumer_id: string;
  verified: boolean;
  detail: string;
}

const {consumers} = grpc.loadPackageDefinition(protoLoader.loadSync('consumers.proto')) as unknown as {
  consumers: {ConsumerVerifier: new (target: string, credentials: grpc.ChannelCredentials) => VerifierClient};
};

function canReadVersion(
  client: VerifierClient,
  name: string,
  versionId: string,
): Promise<{version_id: string}> {
  return new Promise((resolve, reject) => {
    client.CanReadVersion(
      {secret: name, version_id: versionId},
      new grpc.Metadata(),
      {deadline: Date.now() + VERIFY_DEADLINE_MS},
      (error, reply) => (error === null ? resolve(reply) : reject(error)),
    );
  });
}

/** One call per consumer: an unresponsive consumer is not an accepting one. */
async function verifyConsumer(
  client: VerifierClient,
  consumerId: string,
  name: string,
  versionId: string,
): Promise<ConsumerReport> {
  try {
    const reply = await canReadVersion(client, name, versionId);
    return {consumer_id: consumerId, verified: reply.version_id === versionId, detail: reply.version_id};
  } catch (error) {
    const serviceError = error as grpc.ServiceError;
    const code = grpc.status[serviceError.code] ?? 'error';
    return {consumer_id: consumerId, verified: false, detail: \`unresponsive: \${code}\`};
  }
}

/** Ask every registered consumer once; one failure never re-polls the fleet. */
async function verifyConsumers(
  name: string,
  versionId: string,
  clients: Record<string, VerifierClient>,
): Promise<ConsumerReport[]> {
  return Promise.all(
    Object.entries(clients).map(([consumerId, client]) => verifyConsumer(client, consumerId, name, versionId)),
  );
}

/** Retirement requires verified acceptance from every registered consumer. */
function allVerified(reports: ConsumerReport[]): boolean {
  return reports.length > 0 && reports.every(report => report.verified);
}

/** A consumer that cannot read the new version keeps the old one alive, and pages the owner. */
async function alertUnverified(name: string, versionId: string, pending: ConsumerReport[]): Promise<void> {
  await store.alert({
    kind: 'rotation.blocked',
    name,
    version_id: versionId,
    unverified: pending.map(report => report.consumer_id),
  });
}

export async function retire(
  name: string,
  oldVersionId: string,
  newVersionId: string,
  clients: Record<string, VerifierClient>,
): Promise<Record<string, unknown>> {
  const reports = await verifyConsumers(name, newVersionId, clients);
  const pending = reports.filter(report => !report.verified);
  if (!allVerified(reports)) {
    await alertUnverified(name, newVersionId, pending);
    return {retired: false, blockedBy: pending.map(report => report.consumer_id), reports};
  }
  await store.retire(name, oldVersionId);
  return {retired: true, blockedBy: [], reports};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	pb "rotation/consumerspb"
)

const verifyBudget = 2 * time.Second

type RotationStore struct{}

func (s *RotationStore) Retire(ctx context.Context, name, versionID string) error { return nil }

var store = &RotationStore{}

func verifyConsumers(
	ctx context.Context,
	clients map[string]pb.ConsumerVerifierClient,
	name, versionID string,
) map[string]bool {
	// TODO: this draft gives the verification a 2-second budget instead of a per-call deadline,
	// counts a consumer as verified once its budget is spent, and re-polls every consumer when one
	// is down. Review all three, then gate retirement on verified acceptance from every consumer.
	reports := map[string]bool{}
	for consumerID, client := range clients {
		started := time.Now()
		for {
			reply, err := client.CanReadVersion(ctx, &pb.CanReadVersionRequest{Secret: name, VersionId: versionID})
			if err == nil {
				reports[consumerID] = reply.VersionId == versionID
				break
			}
			if time.Since(started) >= verifyBudget {
				reports[consumerID] = true
				break
			}
		}
	}
	return reports
}

func retire(ctx context.Context, name, oldVersionID, newVersionID string, clients map[string]pb.ConsumerVerifierClient) map[string]any {
	reports := verifyConsumers(ctx, clients, name, newVersionID)
	log.Printf("rotation.retire name=%s old=%s reports=%v", name, oldVersionID, reports)
	_ = store.Retire(ctx, name, oldVersionID)
	return map[string]any{"retired": true}
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	pb "rotation/consumerspb"
)

// Two seconds: long enough for a healthy consumer holding the version, short enough to block a rotation.
const verifyDeadline = 2 * time.Second

type RotationStore struct{}

func (s *RotationStore) Retire(ctx context.Context, name, versionID string) error { return nil }

var store = &RotationStore{}

type ConsumerReport struct {
	ConsumerID string
	Verified   bool
	Detail     string
}

type RetirementDecision struct {
	Retired   bool
	BlockedBy []string
	Reports   []ConsumerReport
}

// verifyConsumer makes exactly one call: an unresponsive consumer is not an accepting one.
func verifyConsumer(
	ctx context.Context,
	client pb.ConsumerVerifierClient,
	consumerID, name, versionID string,
) ConsumerReport {
	callCtx, cancel := context.WithTimeout(ctx, verifyDeadline)
	defer cancel()
	reply, err := client.CanReadVersion(callCtx, &pb.CanReadVersionRequest{Secret: name, VersionId: versionID})
	if err != nil {
		return ConsumerReport{ConsumerID: consumerID, Verified: false, Detail: err.Error()}
	}
	return ConsumerReport{ConsumerID: consumerID, Verified: reply.VersionId == versionID, Detail: reply.VersionId}
}

// verifyConsumers asks every registered consumer once; one failure never re-polls the fleet.
func verifyConsumers(
	ctx context.Context,
	clients map[string]pb.ConsumerVerifierClient,
	name, versionID string,
) []ConsumerReport {
	reports := make([]ConsumerReport, 0, len(clients))
	for consumerID, client := range clients {
		reports = append(reports, verifyConsumer(ctx, client, consumerID, name, versionID))
	}
	return reports
}

// allVerified is the gate: retirement requires verified acceptance from every registered consumer.
func allVerified(reports []ConsumerReport) bool {
	if len(reports) == 0 {
		return false
	}
	for _, report := range reports {
		if !report.Verified {
			return false
		}
	}
	return true
}

// alertUnverified keeps the old version alive and pages the rotation owner.
func alertUnverified(name, versionID string, pending []ConsumerReport) {
	ids := make([]string, 0, len(pending))
	for _, report := range pending {
		ids = append(ids, report.ConsumerID)
	}
	log.Printf("rotation.blocked name=%s version=%s unverified=%v", name, versionID, ids)
}

func retire(
	ctx context.Context,
	name, oldVersionID, newVersionID string,
	clients map[string]pb.ConsumerVerifierClient,
) RetirementDecision {
	reports := verifyConsumers(ctx, clients, name, newVersionID)
	blockedBy := make([]string, 0)
	pending := make([]ConsumerReport, 0)
	for _, report := range reports {
		if !report.Verified {
			pending = append(pending, report)
			blockedBy = append(blockedBy, report.ConsumerID)
		}
	}
	if !allVerified(reports) {
		alertUnverified(name, newVersionID, pending)
		return RetirementDecision{Retired: false, BlockedBy: blockedBy, Reports: reports}
	}
	if err := store.Retire(ctx, name, oldVersionID); err != nil {
		return RetirementDecision{Retired: false, BlockedBy: blockedBy, Reports: reports}
	}
	return RetirementDecision{Retired: true, BlockedBy: nil, Reports: reports}
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object RotationVerify {
  val VerifyBudgetMs = 2000L

  val store = RotationStore.open()

  def client(target: String): ConsumerVerifierGrpc.ConsumerVerifierBlockingStub =
    ConsumerVerifierGrpc.blockingStub(ManagedChannelBuilder.forAddress(target, 9000).usePlaintext().build())

  // TODO: this draft gives the verification a 2-second budget instead of a per-call deadline,
  // counts a consumer as verified once its budget is spent, and re-polls every consumer when one
  // is down. Review all three, then gate retirement on verified acceptance from every consumer.
  def verifyConsumers(
      stubs: Map[String, ConsumerVerifierGrpc.ConsumerVerifierBlockingStub],
      name: String,
      versionId: String
  ): Map[String, Boolean] =
    stubs.map { case (consumerId, stub) =>
      val started = System.currentTimeMillis()
      var verified = false
      var done = false
      while (true) {
        try {
          val reply = stub.canReadVersion(CanReadVersionRequest(secret = name, versionId = versionId))
          verified = reply.versionId == versionId
          done = true
        } catch {
          case _: StatusRuntimeException =>
            if (System.currentTimeMillis() - started >= VerifyBudgetMs) {
              verified = true
              done = true
            }
        }
      }
      consumerId -> verified
    }

  def retire(
      name: String,
      oldVersionId: String,
      newVersionId: String,
      stubs: Map[String, ConsumerVerifierGrpc.ConsumerVerifierBlockingStub]
  ): Map[String, Any] = {
    val reports = verifyConsumers(stubs, name, newVersionId)
    store.retire(name, oldVersionId)
    Map("retired" -> true, "reports" -> reports)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

final case class ConsumerReport(consumerId: String, verified: Boolean, detail: String)
final case class RetirementDecision(retired: Boolean, blockedBy: List[String], reports: List[ConsumerReport])

object RotationVerify {
  // Two seconds: long enough for a healthy consumer holding the version, short enough to block a rotation.
  val VerifyDeadlineMs = 2000L

  val store = RotationStore.open()

  def client(target: String): ConsumerVerifierGrpc.ConsumerVerifierBlockingStub =
    ConsumerVerifierGrpc.blockingStub(ManagedChannelBuilder.forAddress(target, 9000).usePlaintext().build())

  // One call per consumer: an unresponsive consumer is not an accepting one.
  def verifyConsumer(
      stub: ConsumerVerifierGrpc.ConsumerVerifierBlockingStub,
      consumerId: String,
      name: String,
      versionId: String
  ): ConsumerReport =
    try {
      val reply = stub
        .withDeadlineAfter(VerifyDeadlineMs, TimeUnit.MILLISECONDS)
        .canReadVersion(CanReadVersionRequest(secret = name, versionId = versionId))
      ConsumerReport(consumerId, reply.versionId == versionId, reply.versionId)
    } catch {
      case exc: StatusRuntimeException => ConsumerReport(consumerId, verified = false, exc.getStatus.getCode.name)
    }

  // Ask every registered consumer once; one failure never re-polls the fleet.
  def verifyConsumers(
      stubs: Map[String, ConsumerVerifierGrpc.ConsumerVerifierBlockingStub],
      name: String,
      versionId: String
  ): List[ConsumerReport] =
    stubs.toList.map { case (consumerId, stub) => verifyConsumer(stub, consumerId, name, versionId) }

  // Retirement requires verified acceptance from every registered consumer.
  def allVerified(reports: List[ConsumerReport]): Boolean = reports.nonEmpty && reports.forall(_.verified)

  // A consumer that cannot read the new version keeps the old one alive, and pages the owner.
  def alertUnverified(name: String, versionId: String, pending: List[ConsumerReport]): Unit =
    System.err.println(s"rotation.blocked name=$name version=$versionId unverified=\${pending.map(_.consumerId)}")

  def retire(
      name: String,
      oldVersionId: String,
      newVersionId: String,
      stubs: Map[String, ConsumerVerifierGrpc.ConsumerVerifierBlockingStub]
  ): RetirementDecision = {
    val reports = verifyConsumers(stubs, name, newVersionId)
    val pending = reports.filterNot(_.verified)
    if (!allVerified(reports)) {
      alertUnverified(name, newVersionId, pending)
      RetirementDecision(retired = false, blockedBy = pending.map(_.consumerId), reports = reports)
    } else {
      store.retire(name, oldVersionId)
      RetirementDecision(retired = true, blockedBy = Nil, reports = reports)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "consumers.grpc.pb.h"

#include <chrono>
#include <map>
#include <string>

struct RotationStore {
  void retire(const std::string& name, const std::string& versionId);
};

RotationStore store;

constexpr long long kVerifyBudgetMs = 2000;

// TODO: this draft gives the verification a 2-second budget instead of a per-call deadline, counts
// a consumer as verified once its budget is spent, and re-polls every consumer when one is down.
// Review all three, then gate retirement on verified acceptance from every consumer.
std::map<std::string, bool> verifyConsumers(
    const std::map<std::string, ConsumerVerifier::Stub*>& stubs,
    const std::string& name,
    const std::string& versionId) {
  std::map<std::string, bool> reports;
  for (const auto& [consumerId, stub] : stubs) {
    const auto started = std::chrono::steady_clock::now();
    while (true) {
      grpc::ClientContext ctx;
      CanReadVersionRequest request;
      request.set_secret(name);
      request.set_version_id(versionId);
      CanReadVersionReply reply;
      const grpc::Status status = stub->CanReadVersion(&ctx, request, &reply);
      if (status.ok()) {
        reports[consumerId] = reply.version_id() == versionId;
        break;
      }
      if (std::chrono::steady_clock::now() - started >= std::chrono::milliseconds(kVerifyBudgetMs)) {
        reports[consumerId] = true;
        break;
      }
    }
  }
  return reports;
}

std::map<std::string, bool> retire(
    const std::string& name,
    const std::string& oldVersionId,
    const std::string& newVersionId,
    const std::map<std::string, ConsumerVerifier::Stub*>& stubs) {
  const auto reports = verifyConsumers(stubs, name, newVersionId);
  store.retire(name, oldVersionId);
  return reports;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "consumers.grpc.pb.h"

#include <chrono>
#include <iostream>
#include <map>
#include <string>
#include <vector>

// Two seconds: long enough for a healthy consumer holding the version, short enough to block a rotation.
constexpr int kVerifyDeadlineMs = 2000;

struct RotationStore {
  void retire(const std::string& name, const std::string& versionId);
  void alert(const std::string& name, const std::string& versionId, const std::vector<std::string>& pending);
};

struct ConsumerReport {
  std::string consumerId;
  bool verified;
  std::string detail;
};

struct RetirementDecision {
  bool retired;
  std::vector<std::string> blockedBy;
  std::vector<ConsumerReport> reports;
};

RotationStore store;

// One call per consumer: an unresponsive consumer is not an accepting one.
ConsumerReport verifyConsumer(
    ConsumerVerifier::Stub* stub,
    const std::string& consumerId,
    const std::string& name,
    const std::string& versionId) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kVerifyDeadlineMs));
  CanReadVersionRequest request;
  request.set_secret(name);
  request.set_version_id(versionId);
  CanReadVersionReply reply;
  const grpc::Status status = stub->CanReadVersion(&ctx, request, &reply);
  if (!status.ok()) {
    return ConsumerReport{consumerId, false, "unresponsive: " + std::to_string(static_cast<int>(status.error_code()))};
  }
  return ConsumerReport{consumerId, reply.version_id() == versionId, reply.version_id()};
}

// Ask every registered consumer once; one failure never re-polls the fleet.
std::vector<ConsumerReport> verifyConsumers(
    const std::map<std::string, ConsumerVerifier::Stub*>& stubs,
    const std::string& name,
    const std::string& versionId) {
  std::vector<ConsumerReport> reports;
  reports.reserve(stubs.size());
  for (const auto& [consumerId, stub] : stubs) {
    reports.push_back(verifyConsumer(stub, consumerId, name, versionId));
  }
  return reports;
}

// Retirement requires verified acceptance from every registered consumer.
bool allVerified(const std::vector<ConsumerReport>& reports) {
  if (reports.empty()) return false;
  for (const auto& report : reports) {
    if (!report.verified) return false;
  }
  return true;
}

// A consumer that cannot read the new version keeps the old one alive, and pages the owner.
void alertUnverified(const std::string& name, const std::string& versionId, const std::vector<ConsumerReport>& pending) {
  std::vector<std::string> ids;
  ids.reserve(pending.size());
  for (const auto& report : pending) ids.push_back(report.consumerId);
  store.alert(name, versionId, ids);
}

RetirementDecision retire(
    const std::string& name,
    const std::string& oldVersionId,
    const std::string& newVersionId,
    const std::map<std::string, ConsumerVerifier::Stub*>& stubs) {
  const auto reports = verifyConsumers(stubs, name, newVersionId);
  std::vector<ConsumerReport> pending;
  std::vector<std::string> blockedBy;
  for (const auto& report : reports) {
    if (!report.verified) {
      pending.push_back(report);
      blockedBy.push_back(report.consumerId);
    }
  }
  if (!allVerified(reports)) {
    alertUnverified(name, newVersionId, pending);
    return RetirementDecision{false, blockedBy, reports};
  }
  store.retire(name, oldVersionId);
  return RetirementDecision{true, {}, reports};
}
`,
    },
  },
  hints: [
    'Put the deadline on the call, not around the loop: `timeout=VERIFY_DEADLINE_S` in Python, `{deadline: Date.now() + VERIFY_DEADLINE_MS}` for @grpc/grpc-js, a `context.WithTimeout` derived context for Go, `withDeadlineAfter` on the stub for ScalaPB, `ctx.set_deadline` for grpc++. A budget you check after a call returns never cancels a call that never returns.',
    'Map the reply to a report you can reason about: `verified = reply.version_id == version_id`, and every error path — `UNAVAILABLE`, `DEADLINE_EXCEEDED`, anything else — produces `verified: false` with the status in `detail`. Never turn an absent answer into an affirmative one.',
    'Retirement is a gate, not a summary: compute `all_verified(reports)` (an empty registry is not acceptance), filter the unverified into `pending`, alert with them, and return `retired: false` naming who blocked. One call per consumer is the other half — the fleet is polled once, never once per failure.',
  ],
  debrief: `The interviewer is probing the dependency that makes a rotation safe: before you delete the old version, every consumer must prove it can read the new one. Three flaws are being checked, and all three are the same mistake in different clothes — treating the absence of an answer as an answer. No per-call deadline means a wedged consumer holds the rotation open forever; a wall-clock budget that "expires" into acceptance means the draft retires exactly the consumers it never heard from; and re-polling the whole fleet on one failure turns a down service into a storm that delays the very rotation it was meant to protect. The gate itself is the third property: \`all_verified\` over every registered consumer, an alert when the gate fails, and a returned decision that names the blockers. Real rotators add capability checks instead of liveness checks (a consumer that says "I can read it" must actually have fetched and decrypted it), a per-consumer verification lease so a slow deploy does not block forever, and a two-phase retirement that marks the version retiring for a full deploy cycle first.`,
};
