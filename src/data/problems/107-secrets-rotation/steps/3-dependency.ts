import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Every consumer verifies before the old version retires',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['worker', 'api', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter is the retirement gate: \`verify_consumers(name, version_id)\` calls
\`CanReadVersion\` on every consumer in \`vault.consumers(name)\` (each at \`{consumer}:9000\`), retries
the whole registry up to \`VERIFY_ATTEMPTS\` times while any call fails, and records acceptances;
\`retire(name, old_version_id, new_version_id)\` ends the old version's overlap
(\`rotation.retire\`, \`vault.record_retirement\`) when no report is pending. It retires cleanly in the
demo, and it hides four flaws.

**Failure mode the checks target.** Retirement is the irreversible step: a consumer still holding
the old version stops decrypting. A wedged consumer pins the worker, a "no" counts as a yes, one
down consumer makes the gate call the whole fleet again, and a blocked rotation pages nobody.

\`\`\`proto
service SecretConsumer { rpc CanReadVersion(CanReadRequest) returns (CanReadReply); }
\`\`\`

- Every call carries its own **\`VERIFY_DEADLINE_S\` = 2 s** deadline, however long the calls before it took.
- \`verify_consumer\` makes **one** call and answers \`{consumer_id, verified, detail}\`: verified only
  when \`can_read\` is true for exactly \`version_id\`; an error is unverified with its status.
- \`retire\` proceeds only when there are reports and all are verified; otherwise it calls
  \`vault.raise_alert(name, new_version_id, pending)\` and answers
  \`{retired: False, blocked_by, reports}\`, leaving the old version valid.`,
  sequence: {
    participants: ['Rotation worker', 'billing', 'ledger', 'Redis'],
    messages: [
      {from: 'Rotation worker', to: 'billing', label: 'CanReadVersion(v2) · deadline 2 s', kind: 'sync'},
      {from: 'billing', to: 'Rotation worker', label: 'can_read · v2 → verified', kind: 'reply'},
      {from: 'Rotation worker', to: 'ledger', label: 'CanReadVersion(v2) · deadline 2 s', kind: 'sync'},
      {from: 'ledger', to: 'Rotation worker', label: 'UNAVAILABLE → unverified, not called again', kind: 'reply'},
      {
        from: 'Rotation worker',
        to: 'Rotation worker',
        label: 'pending [ledger] → raise_alert, retired: false',
        kind: 'sync',
      },
      {from: 'Rotation worker', to: 'Redis', label: 'rotation.retire(v1) only when all verified', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'verify-deadline',
      title: 'Each verification call carries a 2-second deadline',
      detail:
        'The deadline is set on each call itself (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`) from the 2-second constant, a full 2 s for every call even after a slow consumer; without it one wedged consumer holds the rotation worker for as long as it likes.',
      match: {
        python: {all: [/VERIFY_DEADLINE_S\s*=\s*2\b/, /CanReadVersion\([\s\S]{0,250}?timeout\s*=\s*VERIFY_DEADLINE_S/]},
        typescript: {
          all: [/VERIFY_DEADLINE_MS\s*=\s*2000\b/, /CanReadVersion\([\s\S]{0,250}?deadline:[^\n]*VERIFY_DEADLINE_MS/],
        },
        go: {all: [/verifyDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*verifyDeadline\)/]},
        scala: {all: [/VerifyDeadlineSeconds\s*=\s*2L?\b/, /withDeadlineAfter\(\s*VerifyDeadlineSeconds/]},
        cpp: {all: [/kVerifyDeadline\{2\}/, /set_deadline\([^\n]*kVerifyDeadline\)/]},
      },
    },
    {
      id: 'reply-must-match',
      title: 'Only a yes for exactly this version is a verification',
      detail:
        'A report is verified only when the reply says `can_read` and names the requested `version_id`; the starter counts any answer, a consumer still on the old version included, as acceptance.',
      match: {
        python: {all: [/reply\.can_read/, /reply\.version_id/]},
        typescript: {all: [/reply\.can_read/, /reply\.version_id/]},
        go: {all: [/reply\.(GetCanRead\(\)|CanRead)/, /reply\.(GetVersionId\(\)|VersionId)/]},
        scala: {all: [/reply\.canRead/, /reply\.versionId/]},
        cpp: {all: [/reply\.can_read\(\)/, /reply\.version_id\(\)/]},
      },
    },
    {
      id: 'one-call-per-consumer',
      title: 'One failure does not re-poll the fleet',
      detail:
        '`verify_consumer` makes one call per consumer and reports a failure as unverified with its status; nothing loops over the registry again (`VERIFY_ATTEMPTS`), so one down consumer costs one call, not one call per consumer per attempt.',
      match: {
        python: {all: [/def verify_consumer\(/], none: [/VERIFY_ATTEMPTS/, /for attempt in/]},
        typescript: {all: [/function verifyConsumer\(/], none: [/VERIFY_ATTEMPTS/, /for \(let attempt/]},
        go: {all: [/func verifyConsumer\(/], none: [/verifyAttempts/, /for attempt :=/]},
        scala: {all: [/def verifyConsumer\(/], none: [/VerifyAttempts/]},
        cpp: {all: [/Report verifyConsumer\(/], none: [/kVerifyAttempts/, /for \(int attempt/]},
      },
    },
    {
      id: 'retire-gate',
      title: 'A blocked retirement pages and keeps the old version',
      detail:
        'An unverified consumer, or a registry with no consumers, blocks `retire`: it raises `vault.raise_alert` with the pending consumers before answering `retired: false`, and only an all-verified gate calls `rotation.retire`.',
      match: {
        python: {all: [/vault\.raise_alert\(/, /not reports/], order: [/vault\.raise_alert\(/, /rotation\.retire\(/]},
        typescript: {
          all: [/vault\.raiseAlert\(/, /reports\.length === 0/],
          order: [/vault\.raiseAlert\(/, /rotation\.retire\(/],
        },
        go: {all: [/vault\.RaiseAlert\(/, /len\(reports\) == 0/], order: [/vault\.RaiseAlert\(/, /rotation\.Retire\(/]},
        scala: {all: [/Vault\.raiseAlert\(/, /reports\.isEmpty/], order: [/Vault\.raiseAlert\(/, /Rotation\.retire\(/]},
        cpp: {all: [/vault::raiseAlert\(/, /reports\.empty\(\)/], order: [/vault::raiseAlert\(/, /rotation::retire\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import secrets_rotation_pb2
import secrets_rotation_pb2_grpc
from secretd import rotation, vault  # vault.consumers, get_version, record_acceptance, record_retirement, raise_alert

log = logging.getLogger("secretd.rotation")

VERIFY_ATTEMPTS = 3


def _stub(consumer_id: str) -> secrets_rotation_pb2_grpc.SecretConsumerStub:
    return secrets_rotation_pb2_grpc.SecretConsumerStub(grpc.insecure_channel(f"{consumer_id}:9000"))


def verify_consumers(name: str, version_id: str) -> list[dict]:
    """Ask every registered consumer whether it can read version_id: one report per consumer."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    version = vault.get_version(name, version_id)
    request = secrets_rotation_pb2.CanReadRequest(secret=name, version_id=version_id, fingerprint=version["fingerprint"])
    reports = []
    for attempt in range(VERIFY_ATTEMPTS):
        reports = []
        for consumer_id in vault.consumers(name):
            try:
                _stub(consumer_id).CanReadVersion(request)
                reports.append({"consumer_id": consumer_id, "verified": True, "detail": "ok"})
            except grpc.RpcError as exc:
                reports.append({"consumer_id": consumer_id, "verified": False, "detail": exc.code().name})
        if all(report["verified"] for report in reports):
            break  # everyone answered: no need to ask again
    for report in reports:
        if report["verified"]:
            vault.record_acceptance(name, version_id, report["consumer_id"])
    return reports


def retire(name: str, old_version_id: str, new_version_id: str) -> dict:
    """End old_version_id's overlap once every consumer verified new_version_id."""
    reports = verify_consumers(name, new_version_id)
    pending = [report["consumer_id"] for report in reports if not report["verified"]]
    if pending:
        log.warning("retirement of %s waits for %s", old_version_id, pending)
        return {"retired": False, "blocked_by": pending, "reports": reports}
    rotation.retire(name, old_version_id)
    vault.record_retirement(name, old_version_id)
    return {"retired": True, "blocked_by": [], "reports": reports}
`,
      solution: `import logging

import grpc

import secrets_rotation_pb2
import secrets_rotation_pb2_grpc
from secretd import rotation, vault  # vault.consumers, get_version, record_acceptance, record_retirement, raise_alert

log = logging.getLogger("secretd.rotation")

VERIFY_DEADLINE_S = 2


def _stub(consumer_id: str) -> secrets_rotation_pb2_grpc.SecretConsumerStub:
    return secrets_rotation_pb2_grpc.SecretConsumerStub(grpc.insecure_channel(f"{consumer_id}:9000"))


def verify_consumer(name: str, version: dict, consumer_id: str) -> dict:
    """One call: verified only when the consumer can read exactly this version."""
    request = secrets_rotation_pb2.CanReadRequest(secret=name, version_id=version["version_id"], fingerprint=version["fingerprint"])
    try:
        reply = _stub(consumer_id).CanReadVersion(request, timeout=VERIFY_DEADLINE_S)
    except grpc.RpcError as exc:
        return {"consumer_id": consumer_id, "verified": False, "detail": exc.code().name}
    if not reply.can_read or reply.version_id != version["version_id"]:
        return {"consumer_id": consumer_id, "verified": False, "detail": f"holds {reply.version_id or 'nothing'}"}
    vault.record_acceptance(name, version["version_id"], consumer_id)
    return {"consumer_id": consumer_id, "verified": True, "detail": "ok"}


def verify_consumers(name: str, version_id: str) -> list[dict]:
    """Ask every registered consumer whether it can read version_id: one report per consumer."""
    version = vault.get_version(name, version_id)
    return [verify_consumer(name, version, consumer_id) for consumer_id in vault.consumers(name)]


def retire(name: str, old_version_id: str, new_version_id: str) -> dict:
    """End old_version_id's overlap once every consumer verified new_version_id."""
    reports = verify_consumers(name, new_version_id)
    pending = [report["consumer_id"] for report in reports if not report["verified"]]
    if not reports or pending:
        # Nobody verified is not everybody verified: keep the old version and page someone.
        vault.raise_alert(name, new_version_id, pending)
        log.warning("retirement of %s blocked by %s", old_version_id, pending or "an empty registry")
        return {"retired": False, "blocked_by": pending, "reports": reports}
    rotation.retire(name, old_version_id)
    vault.record_retirement(name, old_version_id)
    return {"retired": True, "blocked_by": [], "reports": reports}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as rotation from 'secretd/rotation';
import * as vault from 'secretd/vault';

export const VERIFY_ATTEMPTS = 3;

export interface Report {
  consumer_id: string;
  verified: boolean;
  detail: string;
}

export interface Retirement {
  retired: boolean;
  blocked_by: string[];
  reports: Report[];
}

interface CanReadRequest {
  secret: string;
  version_id: string;
  fingerprint: string;
}

interface CanReadReply {
  consumer_id: string;
  version_id: string;
  can_read: boolean;
}

type ConsumerClient = grpc.Client & {
  CanReadVersion(request: CanReadRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<CanReadReply>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('secrets_rotation.proto')) as unknown as {
  secretsrotation: {SecretConsumer: grpc.ServiceClientConstructor};
};

const stub = (consumerId: string): ConsumerClient =>
  new pkg.secretsrotation.SecretConsumer(\`\${consumerId}:9000\`, grpc.credentials.createInsecure()) as ConsumerClient;

/** Ask every registered consumer whether it can read versionId: one report per consumer. */
export async function verifyConsumers(name: string, versionId: string): Promise<Report[]> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const version = (await vault.getVersion(name, versionId)) as vault.Version;
  const request = {secret: name, version_id: versionId, fingerprint: version.fingerprint};
  let reports: Report[] = [];
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    reports = [];
    for (const consumerId of await vault.consumers(name)) {
      try {
        await stub(consumerId).CanReadVersion(request, new grpc.Metadata(), {});
        reports.push({consumer_id: consumerId, verified: true, detail: 'ok'});
      } catch (e) {
        reports.push({consumer_id: consumerId, verified: false, detail: grpc.status[(e as grpc.ServiceError).code]});
      }
    }
    if (reports.every(report => report.verified)) break; // everyone answered: no need to ask again
  }
  for (const report of reports) if (report.verified) await vault.recordAcceptance(name, versionId, report.consumer_id);
  return reports;
}

/** End oldVersionId's overlap once every consumer verified newVersionId. */
export async function retire(name: string, oldVersionId: string, newVersionId: string): Promise<Retirement> {
  const reports = await verifyConsumers(name, newVersionId);
  const pending = reports.filter(report => !report.verified).map(report => report.consumer_id);
  if (pending.length > 0) {
    console.warn(\`retirement of \${oldVersionId} waits for \${pending.join(', ')}\`);
    return {retired: false, blocked_by: pending, reports};
  }
  await rotation.retire(name, oldVersionId);
  await vault.recordRetirement(name, oldVersionId);
  return {retired: true, blocked_by: [], reports};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as rotation from 'secretd/rotation';
import * as vault from 'secretd/vault';

export const VERIFY_DEADLINE_MS = 2000;

export interface Report {
  consumer_id: string;
  verified: boolean;
  detail: string;
}

export interface Retirement {
  retired: boolean;
  blocked_by: string[];
  reports: Report[];
}

interface CanReadRequest {
  secret: string;
  version_id: string;
  fingerprint: string;
}

interface CanReadReply {
  consumer_id: string;
  version_id: string;
  can_read: boolean;
}

type ConsumerClient = grpc.Client & {
  CanReadVersion(request: CanReadRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<CanReadReply>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('secrets_rotation.proto')) as unknown as {
  secretsrotation: {SecretConsumer: grpc.ServiceClientConstructor};
};

const stub = (consumerId: string): ConsumerClient =>
  new pkg.secretsrotation.SecretConsumer(\`\${consumerId}:9000\`, grpc.credentials.createInsecure()) as ConsumerClient;

/** One call: verified only when the consumer can read exactly this version. */
export async function verifyConsumer(name: string, version: vault.Version, consumerId: string): Promise<Report> {
  const request = {secret: name, version_id: version.version_id, fingerprint: version.fingerprint};
  let reply: CanReadReply;
  try {
    reply = await stub(consumerId).CanReadVersion(request, new grpc.Metadata(), {deadline: Date.now() + VERIFY_DEADLINE_MS});
  } catch (e) {
    return {consumer_id: consumerId, verified: false, detail: grpc.status[(e as grpc.ServiceError).code]};
  }
  if (!reply.can_read || reply.version_id !== version.version_id) {
    return {consumer_id: consumerId, verified: false, detail: \`holds \${reply.version_id || 'nothing'}\`};
  }
  await vault.recordAcceptance(name, version.version_id, consumerId);
  return {consumer_id: consumerId, verified: true, detail: 'ok'};
}

/** Ask every registered consumer whether it can read versionId: one report per consumer. */
export async function verifyConsumers(name: string, versionId: string): Promise<Report[]> {
  const version = (await vault.getVersion(name, versionId)) as vault.Version;
  const reports: Report[] = [];
  for (const consumerId of await vault.consumers(name)) reports.push(await verifyConsumer(name, version, consumerId));
  return reports;
}

/** End oldVersionId's overlap once every consumer verified newVersionId. */
export async function retire(name: string, oldVersionId: string, newVersionId: string): Promise<Retirement> {
  const reports = await verifyConsumers(name, newVersionId);
  const pending = reports.filter(report => !report.verified).map(report => report.consumer_id);
  if (reports.length === 0 || pending.length > 0) {
    // Nobody verified is not everybody verified: keep the old version and page someone.
    await vault.raiseAlert(name, newVersionId, pending);
    console.warn(\`retirement of \${oldVersionId} blocked by \${pending.join(', ') || 'an empty registry'}\`);
    return {retired: false, blocked_by: pending, reports};
  }
  await rotation.retire(name, oldVersionId);
  await vault.recordRetirement(name, oldVersionId);
  return {retired: true, blocked_by: [], reports};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"secretd/rotation" // rotation.Retire
	"secretd/vault"    // vault.Consumers, GetVersion, RecordAcceptance, RecordRetirement, RaiseAlert
	pb "secretd/gen/secrets_rotation"
)

const verifyAttempts = 3

// Report is what one consumer said about a version.
type Report struct {
	ConsumerID string \`json:"consumer_id"\`
	Verified   bool   \`json:"verified"\`
	Detail     string \`json:"detail"\`
}

// Retirement is what retire did, and why.
type Retirement struct {
	Retired   bool     \`json:"retired"\`
	BlockedBy []string \`json:"blocked_by"\`
	Reports   []Report \`json:"reports"\`
}

func canRead(ctx context.Context, consumerID string, request *pb.CanReadRequest) (*pb.CanReadReply, error) {
	conn, err := grpc.NewClient(consumerID+":9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	return pb.NewSecretConsumerClient(conn).CanReadVersion(ctx, request)
}

// verifyConsumers asks every registered consumer whether it can read versionID: one report per consumer.
func verifyConsumers(ctx context.Context, name, versionID string) ([]Report, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	version := vault.GetVersion(ctx, name, versionID)
	request := &pb.CanReadRequest{Secret: name, VersionId: versionID, Fingerprint: version.Fingerprint}
	var reports []Report
	for attempt := 0; attempt < verifyAttempts; attempt++ {
		reports = nil
		everyone := true
		for _, consumerID := range vault.Consumers(ctx, name) {
			if _, err := canRead(ctx, consumerID, request); err != nil {
				reports = append(reports, Report{ConsumerID: consumerID, Verified: false, Detail: status.Code(err).String()})
				everyone = false
				continue
			}
			reports = append(reports, Report{ConsumerID: consumerID, Verified: true, Detail: "ok"})
		}
		if everyone {
			break // everyone answered: no need to ask again
		}
	}
	for _, report := range reports {
		if report.Verified {
			vault.RecordAcceptance(ctx, name, versionID, report.ConsumerID)
		}
	}
	return reports, nil
}

// retire ends oldVersionID's overlap once every consumer verified newVersionID.
func retire(ctx context.Context, name, oldVersionID, newVersionID string) (Retirement, error) {
	reports, err := verifyConsumers(ctx, name, newVersionID)
	if err != nil {
		return Retirement{}, err
	}
	pending := []string{}
	for _, report := range reports {
		if !report.Verified {
			pending = append(pending, report.ConsumerID)
		}
	}
	if len(pending) > 0 {
		log.Printf("retirement of %s waits for %v", oldVersionID, pending)
		return Retirement{Retired: false, BlockedBy: pending, Reports: reports}, nil
	}
	if err := rotation.Retire(ctx, name, oldVersionID); err != nil {
		return Retirement{}, err
	}
	vault.RecordRetirement(ctx, name, oldVersionID)
	return Retirement{Retired: true, BlockedBy: []string{}, Reports: reports}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"secretd/rotation" // rotation.Retire
	"secretd/vault"    // vault.Consumers, GetVersion, RecordAcceptance, RecordRetirement, RaiseAlert
	pb "secretd/gen/secrets_rotation"
)

const verifyDeadline = 2 * time.Second

// Report is what one consumer said about a version.
type Report struct {
	ConsumerID string \`json:"consumer_id"\`
	Verified   bool   \`json:"verified"\`
	Detail     string \`json:"detail"\`
}

// Retirement is what retire did, and why.
type Retirement struct {
	Retired   bool     \`json:"retired"\`
	BlockedBy []string \`json:"blocked_by"\`
	Reports   []Report \`json:"reports"\`
}

func canRead(ctx context.Context, consumerID string, request *pb.CanReadRequest) (*pb.CanReadReply, error) {
	conn, err := grpc.NewClient(consumerID+":9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	return pb.NewSecretConsumerClient(conn).CanReadVersion(ctx, request)
}

// verifyConsumer makes one call: verified only when the consumer can read exactly this version.
func verifyConsumer(ctx context.Context, name string, version *vault.Version, consumerID string) Report {
	callCtx, cancel := context.WithTimeout(ctx, verifyDeadline)
	defer cancel()
	reply, err := canRead(callCtx, consumerID, &pb.CanReadRequest{Secret: name, VersionId: version.VersionID, Fingerprint: version.Fingerprint})
	if err != nil {
		return Report{ConsumerID: consumerID, Verified: false, Detail: status.Code(err).String()}
	}
	if !reply.GetCanRead() || reply.GetVersionId() != version.VersionID {
		return Report{ConsumerID: consumerID, Verified: false, Detail: "holds " + reply.GetVersionId()}
	}
	vault.RecordAcceptance(ctx, name, version.VersionID, consumerID)
	return Report{ConsumerID: consumerID, Verified: true, Detail: "ok"}
}

// verifyConsumers asks every registered consumer whether it can read versionID: one report per consumer.
func verifyConsumers(ctx context.Context, name, versionID string) ([]Report, error) {
	version := vault.GetVersion(ctx, name, versionID)
	reports := []Report{}
	for _, consumerID := range vault.Consumers(ctx, name) {
		reports = append(reports, verifyConsumer(ctx, name, version, consumerID))
	}
	return reports, nil
}

// retire ends oldVersionID's overlap once every consumer verified newVersionID.
func retire(ctx context.Context, name, oldVersionID, newVersionID string) (Retirement, error) {
	reports, err := verifyConsumers(ctx, name, newVersionID)
	if err != nil {
		return Retirement{}, err
	}
	pending := []string{}
	for _, report := range reports {
		if !report.Verified {
			pending = append(pending, report.ConsumerID)
		}
	}
	if len(reports) == 0 || len(pending) > 0 {
		// Nobody verified is not everybody verified: keep the old version and page someone.
		vault.RaiseAlert(ctx, name, newVersionID, pending)
		log.Printf("retirement of %s blocked by %v", oldVersionID, pending)
		return Retirement{Retired: false, BlockedBy: pending, Reports: reports}, nil
	}
	if err := rotation.Retire(ctx, name, oldVersionID); err != nil {
		return Retirement{}, err
	}
	vault.RecordRetirement(ctx, name, oldVersionID)
	return Retirement{Retired: true, BlockedBy: []string{}, Reports: reports}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import secretd.{Rotation, Vault} // Vault.consumers, getVersion, recordAcceptance, recordRetirement, raiseAlert; Rotation.retire
import secretsrotation.secrets_rotation.{CanReadRequest, SecretConsumerGrpc}

/** What one consumer said about a version. */
final case class Report(consumerId: String, verified: Boolean, detail: String)

/** What retire did, and why. */
final case class Retirement(retired: Boolean, blockedBy: Seq[String], reports: Seq[Report])

object Client {
  val VerifyAttempts = 3

  private def stub(consumerId: String) =
    SecretConsumerGrpc.blockingStub(ManagedChannelBuilder.forAddress(consumerId, 9000).usePlaintext().build())

  /** Ask every registered consumer whether it can read versionId: one report per consumer. */
  def verifyConsumers(name: String, versionId: String): Seq[Report] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val version = Vault.getVersion(name, versionId).get
    val request = CanReadRequest(name, versionId, version.fingerprint)
    var reports = Seq.empty[Report]
    var attempt = 0
    var everyone = false
    while (attempt < VerifyAttempts && !everyone) {
      reports = Vault.consumers(name).map { consumerId =>
        try {
          stub(consumerId).canReadVersion(request)
          Report(consumerId, verified = true, "ok")
        } catch { case e: StatusRuntimeException => Report(consumerId, verified = false, e.getStatus.getCode.toString) }
      }
      everyone = reports.forall(_.verified) // everyone answered: no need to ask again
      attempt += 1
    }
    reports.filter(_.verified).foreach(report => Vault.recordAcceptance(name, versionId, report.consumerId))
    reports
  }

  /** End oldVersionId's overlap once every consumer verified newVersionId. */
  def retire(name: String, oldVersionId: String, newVersionId: String): Retirement = {
    val reports = verifyConsumers(name, newVersionId)
    val pending = reports.filterNot(_.verified).map(_.consumerId)
    if (pending.nonEmpty) {
      System.err.println(s"retirement of $oldVersionId waits for \${pending.mkString(", ")}")
      Retirement(retired = false, pending, reports)
    } else {
      Rotation.retire(name, oldVersionId)
      Vault.recordRetirement(name, oldVersionId)
      Retirement(retired = true, Seq.empty, reports)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import secretd.{Rotation, Vault} // Vault.consumers, getVersion, recordAcceptance, recordRetirement, raiseAlert; Rotation.retire
import secretsrotation.secrets_rotation.{CanReadRequest, SecretConsumerGrpc}

/** What one consumer said about a version. */
final case class Report(consumerId: String, verified: Boolean, detail: String)

/** What retire did, and why. */
final case class Retirement(retired: Boolean, blockedBy: Seq[String], reports: Seq[Report])

object Client {
  val VerifyDeadlineSeconds = 2L

  private def stub(consumerId: String) =
    SecretConsumerGrpc.blockingStub(ManagedChannelBuilder.forAddress(consumerId, 9000).usePlaintext().build())

  /** One call: verified only when the consumer can read exactly this version. */
  def verifyConsumer(name: String, version: Vault.Version, consumerId: String): Report = {
    val request = CanReadRequest(name, version.versionId, version.fingerprint)
    try {
      val reply = stub(consumerId).withDeadlineAfter(VerifyDeadlineSeconds, TimeUnit.SECONDS).canReadVersion(request)
      if (!reply.canRead || reply.versionId != version.versionId) Report(consumerId, verified = false, s"holds \${reply.versionId}")
      else {
        Vault.recordAcceptance(name, version.versionId, consumerId)
        Report(consumerId, verified = true, "ok")
      }
    } catch { case e: StatusRuntimeException => Report(consumerId, verified = false, e.getStatus.getCode.toString) }
  }

  /** Ask every registered consumer whether it can read versionId: one report per consumer. */
  def verifyConsumers(name: String, versionId: String): Seq[Report] = {
    val version = Vault.getVersion(name, versionId).get
    Vault.consumers(name).map(verifyConsumer(name, version, _))
  }

  /** End oldVersionId's overlap once every consumer verified newVersionId. */
  def retire(name: String, oldVersionId: String, newVersionId: String): Retirement = {
    val reports = verifyConsumers(name, newVersionId)
    val pending = reports.filterNot(_.verified).map(_.consumerId)
    if (reports.isEmpty || pending.nonEmpty) {
      // Nobody verified is not everybody verified: keep the old version and page someone.
      Vault.raiseAlert(name, newVersionId, pending)
      System.err.println(s"retirement of $oldVersionId blocked by \${pending.mkString(", ")}")
      Retirement(retired = false, pending, reports)
    } else {
      Rotation.retire(name, oldVersionId)
      Vault.recordRetirement(name, oldVersionId)
      Retirement(retired = true, Seq.empty, reports)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <string>
#include <vector>

#include "secretd/rotation.h"  // rotation::retire
#include "secretd/vault.h"     // vault::consumers, getVersion, recordAcceptance, recordRetirement, raiseAlert
#include "secrets_rotation.grpc.pb.h"

constexpr int kVerifyAttempts = 3;

// What one consumer said about a version.
struct Report {
  std::string consumer_id;
  bool verified = false;
  std::string detail;
};

// What retire did, and why.
struct Retirement {
  bool retired = false;
  std::vector<std::string> blocked_by;
  std::vector<Report> reports;
};

std::unique_ptr<secretsrotation::SecretConsumer::Stub> stub(const std::string& consumer_id) {
  return secretsrotation::SecretConsumer::NewStub(grpc::CreateChannel(consumer_id + ":9000", grpc::InsecureChannelCredentials()));
}

// Ask every registered consumer whether it can read version_id: one report per consumer.
std::vector<Report> verifyConsumers(const std::string& name, const std::string& version_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const vault::Version version = *vault::getVersion(name, version_id);
  secretsrotation::CanReadRequest request;
  request.set_secret(name);
  request.set_version_id(version_id);
  request.set_fingerprint(version.fingerprint);
  std::vector<Report> reports;
  for (int attempt = 0; attempt < kVerifyAttempts; attempt++) {
    reports.clear();
    bool everyone = true;
    for (const std::string& consumer_id : vault::consumers(name)) {
      grpc::ClientContext ctx;
      secretsrotation::CanReadReply reply;
      const grpc::Status status = stub(consumer_id)->CanReadVersion(&ctx, request, &reply);
      if (!status.ok()) {
        reports.push_back({consumer_id, false, "status " + std::to_string(status.error_code()) + ": " + status.error_message()});
        everyone = false;
        continue;
      }
      reports.push_back({consumer_id, true, "ok"});
    }
    if (everyone) break;  // everyone answered: no need to ask again
  }
  for (const Report& report : reports) {
    if (report.verified) vault::recordAcceptance(name, version_id, report.consumer_id);
  }
  return reports;
}

// End old_version_id's overlap once every consumer verified new_version_id.
Retirement retire(const std::string& name, const std::string& old_version_id, const std::string& new_version_id) {
  const std::vector<Report> reports = verifyConsumers(name, new_version_id);
  std::vector<std::string> pending;
  for (const Report& report : reports) {
    if (!report.verified) pending.push_back(report.consumer_id);
  }
  if (!pending.empty()) {
    std::cerr << "retirement of " << old_version_id << " waits for " << pending.size() << " consumer(s)\\n";
    return {false, pending, reports};
  }
  rotation::retire(name, old_version_id);
  vault::recordRetirement(name, old_version_id);
  return {true, {}, reports};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <vector>

#include "secretd/rotation.h"  // rotation::retire
#include "secretd/vault.h"     // vault::consumers, getVersion, recordAcceptance, recordRetirement, raiseAlert
#include "secrets_rotation.grpc.pb.h"

constexpr std::chrono::seconds kVerifyDeadline{2};

// What one consumer said about a version.
struct Report {
  std::string consumer_id;
  bool verified = false;
  std::string detail;
};

// What retire did, and why.
struct Retirement {
  bool retired = false;
  std::vector<std::string> blocked_by;
  std::vector<Report> reports;
};

std::unique_ptr<secretsrotation::SecretConsumer::Stub> stub(const std::string& consumer_id) {
  return secretsrotation::SecretConsumer::NewStub(grpc::CreateChannel(consumer_id + ":9000", grpc::InsecureChannelCredentials()));
}

// One call: verified only when the consumer can read exactly this version.
Report verifyConsumer(const std::string& name, const vault::Version& version, const std::string& consumer_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kVerifyDeadline);
  secretsrotation::CanReadRequest request;
  request.set_secret(name);
  request.set_version_id(version.version_id);
  request.set_fingerprint(version.fingerprint);
  secretsrotation::CanReadReply reply;
  const grpc::Status status = stub(consumer_id)->CanReadVersion(&ctx, request, &reply);
  if (!status.ok()) return {consumer_id, false, "status " + std::to_string(status.error_code()) + ": " + status.error_message()};
  if (!reply.can_read() || reply.version_id() != version.version_id) return {consumer_id, false, "holds " + reply.version_id()};
  vault::recordAcceptance(name, version.version_id, consumer_id);
  return {consumer_id, true, "ok"};
}

// Ask every registered consumer whether it can read version_id: one report per consumer.
std::vector<Report> verifyConsumers(const std::string& name, const std::string& version_id) {
  const vault::Version version = *vault::getVersion(name, version_id);
  std::vector<Report> reports;
  for (const std::string& consumer_id : vault::consumers(name)) reports.push_back(verifyConsumer(name, version, consumer_id));
  return reports;
}

// End old_version_id's overlap once every consumer verified new_version_id.
Retirement retire(const std::string& name, const std::string& old_version_id, const std::string& new_version_id) {
  const std::vector<Report> reports = verifyConsumers(name, new_version_id);
  std::vector<std::string> pending;
  for (const Report& report : reports) {
    if (!report.verified) pending.push_back(report.consumer_id);
  }
  if (reports.empty() || !pending.empty()) {
    // Nobody verified is not everybody verified: keep the old version and page someone.
    vault::raiseAlert(name, new_version_id, pending);
    std::cerr << "retirement of " << old_version_id << " blocked by " << pending.size() << " consumer(s)\\n";
    return {false, pending, reports};
  }
  rotation::retire(name, old_version_id);
  vault::recordRetirement(name, old_version_id);
  return {true, {}, reports};
}
`,
    },
  },
  harness: {
    python: `import grpc

import secrets_rotation_pb2
import secrets_rotation_pb2_grpc
from secretd import rotation, vault

NAME = "payments-db"
FLEET = ("billing", "checkout", "ledger")


class Consumer(secrets_rotation_pb2_grpc.SecretConsumerServicer):
    """A registered consumer: it can read every version but those after the one it is on (holds); answer, a (version_id, can_read) pair, fixes its reply."""

    def __init__(self, consumer_id, holds="v2", answer=None):
        self.consumer_id = consumer_id
        self.holds = holds
        self.answer = answer

    def CanReadVersion(self, request, context):
        if self.answer is not None:
            return secrets_rotation_pb2.CanReadReply(consumer_id=self.consumer_id, version_id=self.answer[0], can_read=self.answer[1])
        can = request.version_id <= self.holds
        return secrets_rotation_pb2.CanReadReply(consumer_id=self.consumer_id, version_id=request.version_id if can else self.holds, can_read=can)


def _setup(ctx, up=FLEET, lagging=()):
    """v1 then v2 created and activated (v1 in its overlap), the fleet registered; consumers in up served, those in lagging still on v1."""
    vault.create_version(NAME, "material-one", 3600, "op-ana")
    vault.create_version(NAME, "material-two", 3600, "op-ana")
    rotation.activate(NAME, "v1")
    rotation.activate(NAME, "v2")
    peers = {}
    for consumer_id in FLEET:
        vault.register_consumer(NAME, consumer_id)
    for consumer_id in up:
        peers[consumer_id] = Consumer(consumer_id, "v1" if consumer_id in lagging else "v2")
        ctx.grpc.serve(secrets_rotation_pb2_grpc.add_SecretConsumerServicer_to_server, peers[consumer_id], target=f"{consumer_id}:9000")
    return ctx.load("client"), peers


def _by_consumer(reports):
    return {r["consumer_id"]: r for r in reports}


def check_verify_deadline(ctx):
    m, _ = _setup(ctx)
    reports = _by_consumer(m.verify_consumers(NAME, "v2"))
    assert sorted(reports) == list(FLEET), f"verify_consumers must answer one report per registered consumer, got {sorted(reports)}"
    calls = ctx.grpc.calls_to("CanReadVersion")
    assert calls, "no CanReadVersion call was made"
    for call in calls:
        assert call.timeout is not None, f"a CanReadVersion call to {call.target} carries no deadline: a wedged consumer holds the rotation worker for as long as it likes"
        assert 1.5 <= call.timeout <= 2.5, f"a CanReadVersion call carries a {call.timeout} s deadline, expected VERIFY_DEADLINE_S = 2"
    # billing answers after 1.5 s, inside its deadline; every call after it still carries a full 2 s of its own.
    ctx.grpc.set_latency("CanReadVersion", 1.5, target="billing:9000")
    ctx.grpc.set_latency("CanReadVersion", 30.0, target="ledger:9000")
    before = len(calls)
    reports = _by_consumer(m.verify_consumers(NAME, "v2"))
    assert reports["ledger"]["verified"] is False, f"a consumer that takes 30 s to answer must be reported unverified after the deadline, got {reports['ledger']}"
    assert reports["billing"]["verified"] and reports["checkout"]["verified"], f"the healthy consumers must still verify (billing answers in 1.5 s, inside its deadline), got {reports}"
    later = ctx.grpc.calls_to("CanReadVersion")[before:]
    assert len(later) == 3, f"the second verification made {len(later)} CanReadVersion calls, expected one per consumer"
    for call in later:
        assert call.timeout is not None and 1.5 <= call.timeout <= 2.5, f"after billing took 1.5 s, the call to {call.target} carried a {call.timeout} s deadline: each call gets its own VERIFY_DEADLINE_S = 2, not what is left of one shared deadline"


def check_reply_must_match(ctx):
    m, _ = _setup(ctx, lagging=("ledger",))
    # audit says yes, but for the version it holds; search names v2 but says it cannot read it.
    for consumer_id, answer in (("audit", ("v1", True)), ("search", ("v2", False))):
        vault.register_consumer(NAME, consumer_id)
        ctx.grpc.serve(secrets_rotation_pb2_grpc.add_SecretConsumerServicer_to_server, Consumer(consumer_id, answer=answer), target=f"{consumer_id}:9000")
    reports = _by_consumer(m.verify_consumers(NAME, "v2"))
    assert reports["ledger"]["verified"] is False, f"ledger answered can_read=false (it still runs on v1) and was reported {reports['ledger']}: only a yes for exactly v2 is a verification"
    assert reports["audit"]["verified"] is False, f"audit answered can_read=true for version_id v1 and was reported {reports['audit']}: only a yes for exactly v2 is a verification"
    assert reports["search"]["verified"] is False, f"search answered version_id v2 with can_read=false and was reported {reports['search']}: only a yes for exactly v2 is a verification"
    assert reports["billing"]["verified"] and reports["checkout"]["verified"], f"billing and checkout can read v2 and must verify, got {reports}"
    accepted = vault.accepted(NAME, "v2")
    assert accepted == ["billing", "checkout"], f"the vault records {accepted} as having accepted v2, expected ['billing', 'checkout']"


def check_one_call_per_consumer(ctx):
    m, _ = _setup(ctx, up=("billing", "checkout"))
    reports = _by_consumer(m.verify_consumers(NAME, "v2"))
    ledger = reports.get("ledger", {})
    assert ledger.get("verified") is False, f"ledger is down (UNAVAILABLE) and must be reported unverified, got {reports.get('ledger')}"
    assert "unavailable" in str(ledger.get("detail", "")).lower(), f"ledger's report must carry the call's status (UNAVAILABLE) as its detail, got {ledger}"
    for consumer_id in FLEET:
        made = len(ctx.grpc.calls_to("CanReadVersion", target=f"{consumer_id}:9000"))
        assert made == 1, f"{consumer_id} was called {made} times for one verification: one down consumer made the gate ask the whole fleet again. Make one call per consumer and report the failure"


def check_retire_gate(ctx):
    m, _ = _setup(ctx, up=("billing", "checkout"))
    blocked = m.retire(NAME, "v1", "v2")
    assert blocked.get("retired") is False, f"with ledger down retire answered {blocked}: an unverified consumer blocks retirement"
    assert blocked.get("blocked_by") == ["ledger"], f"blocked_by must name ledger, got {blocked.get('blocked_by')}"
    assert rotation.valid_versions(NAME) == ["v2", "v1"], f"a blocked retirement must leave v1 valid, valid_versions is {rotation.valid_versions(NAME)}"
    alerts = vault.alerts(NAME)
    assert alerts == [{"version_id": "v2", "pending": ["ledger"]}], f"a blocked retirement must page with the pending consumers (vault.raise_alert), the alerts are {alerts}"
    ctx.grpc.serve(secrets_rotation_pb2_grpc.add_SecretConsumerServicer_to_server, Consumer("ledger"), target="ledger:9000")
    done = m.retire(NAME, "v1", "v2")
    assert done.get("retired") is True, f"with every consumer verified retire answered {done}"
    assert rotation.valid_versions(NAME) == ["v2"], f"after the retirement valid_versions is {rotation.valid_versions(NAME)}, expected ['v2']"
    assert vault.get_version(NAME, "v1")["retired_at"] is not None, "the retirement must be recorded on v1 (vault.record_retirement)"
    assert len(vault.alerts(NAME)) == 1, f"a retirement every consumer verified must not page, the alerts are {vault.alerts(NAME)}"
    vault.create_version("orphan", "material", 3600, "op-ana")
    vault.create_version("orphan", "material-2", 3600, "op-ana")
    rotation.activate("orphan", "v1")
    rotation.activate("orphan", "v2")
    empty = m.retire("orphan", "v1", "v2")
    assert empty.get("retired") is False, f"a secret with no registered consumers retired its old version ({empty}): nobody verified is not everybody verified"
    assert len(vault.alerts("orphan")) == 1, f"a retirement blocked by an empty registry must page, the alerts are {vault.alerts('orphan')}"
`,
    typescript: `const NAME = 'payments-db';
const FLEET = ['billing', 'checkout', 'ledger'];

/** A registered consumer: it can read every version but those after the one it is on (holds); answer, a [version_id, can_read] pair, fixes its reply. */
function consumerImpl(consumerId: string, holds = 'v2', answer: [string, boolean] | null = null) {
  return {
    CanReadVersion(call, callback) {
      if (answer !== null) return callback(null, {consumer_id: consumerId, version_id: answer[0], can_read: answer[1]});
      const can = call.request.version_id <= holds;
      callback(null, {consumer_id: consumerId, version_id: can ? call.request.version_id : holds, can_read: can});
    },
  };
}

async function setup(ctx, up = FLEET, lagging: string[] = []) {
  const vault = ctx.load('/support/secretd/vault.ts');
  const rotation = ctx.load('/support/secretd/rotation.ts');
  const pkg = ctx.proto('secrets_rotation.proto');
  await vault.createVersion(NAME, 'material-one', 3600, 'op-ana');
  await vault.createVersion(NAME, 'material-two', 3600, 'op-ana');
  await rotation.activate(NAME, 'v1');
  await rotation.activate(NAME, 'v2');
  for (const id of FLEET) await vault.registerConsumer(NAME, id);
  for (const id of up) ctx.grpc.serve(pkg.secretsrotation.SecretConsumer.service, consumerImpl(id, lagging.includes(id) ? 'v1' : 'v2'), \`\${id}:9000\`);
  return {m: ctx.load('client'), vault, rotation, pkg};
}

const byConsumer = reports => Object.fromEntries(reports.map(r => [r.consumer_id, r]));

export async function check_verify_deadline(ctx) {
  const {m} = await setup(ctx);
  let reports = byConsumer(await m.verifyConsumers(NAME, 'v2'));
  assert.deepStrictEqual(Object.keys(reports).sort(), FLEET, 'verifyConsumers must answer one report per registered consumer');
  const calls = ctx.grpc.callsTo('CanReadVersion');
  assert(calls.length > 0, 'no CanReadVersion call was made');
  for (const call of calls) {
    assert(call.timeout !== null, \`a CanReadVersion call to \${call.target} carries no deadline: a wedged consumer holds the rotation worker for as long as it likes\`);
    assert(call.timeout >= 1.5 && call.timeout <= 2.5, \`a CanReadVersion call carries a \${call.timeout} s deadline, expected VERIFY_DEADLINE_MS = 2000\`);
  }
  // billing answers after 1.5 s, inside its deadline; every call after it still carries a full 2 s of its own.
  ctx.grpc.setLatency('CanReadVersion', 1.5, 'billing:9000');
  ctx.grpc.setLatency('CanReadVersion', 30.0, 'ledger:9000');
  const before = calls.length;
  reports = byConsumer(await m.verifyConsumers(NAME, 'v2'));
  assert.equal(reports.ledger.verified, false, \`a consumer that takes 30 s to answer must be reported unverified after the deadline, got \${JSON.stringify(reports.ledger)}\`);
  assert(reports.billing.verified && reports.checkout.verified, \`the healthy consumers must still verify (billing answers in 1.5 s, inside its deadline), got \${JSON.stringify(reports)}\`);
  const later = ctx.grpc.callsTo('CanReadVersion').slice(before);
  assert.equal(later.length, 3, \`the second verification made \${later.length} CanReadVersion calls, expected one per consumer\`);
  for (const call of later) {
    assert(
      call.timeout !== null && call.timeout >= 1.5 && call.timeout <= 2.5,
      \`after billing took 1.5 s, the call to \${call.target} carried a \${call.timeout} s deadline: each call gets its own VERIFY_DEADLINE_MS = 2000, not what is left of one shared deadline\`,
    );
  }
}

export async function check_reply_must_match(ctx) {
  const {m, vault, pkg} = await setup(ctx, FLEET, ['ledger']);
  // audit says yes, but for the version it holds; search names v2 but says it cannot read it.
  for (const [id, answer] of [['audit', ['v1', true]], ['search', ['v2', false]]] as [string, [string, boolean]][]) {
    await vault.registerConsumer(NAME, id);
    ctx.grpc.serve(pkg.secretsrotation.SecretConsumer.service, consumerImpl(id, 'v2', answer), \`\${id}:9000\`);
  }
  const reports = byConsumer(await m.verifyConsumers(NAME, 'v2'));
  assert.equal(reports.ledger.verified, false, \`ledger answered can_read=false (it still runs on v1) and was reported \${JSON.stringify(reports.ledger)}: only a yes for exactly v2 is a verification\`);
  assert.equal(reports.audit?.verified, false, \`audit answered can_read=true for version_id v1 and was reported \${JSON.stringify(reports.audit)}: only a yes for exactly v2 is a verification\`);
  assert.equal(reports.search?.verified, false, \`search answered version_id v2 with can_read=false and was reported \${JSON.stringify(reports.search)}: only a yes for exactly v2 is a verification\`);
  assert(reports.billing.verified && reports.checkout.verified, \`billing and checkout can read v2 and must verify, got \${JSON.stringify(reports)}\`);
  assert.deepStrictEqual(await vault.accepted(NAME, 'v2'), ['billing', 'checkout'], 'the consumers the vault records as having accepted v2');
}

export async function check_one_call_per_consumer(ctx) {
  const {m} = await setup(ctx, ['billing', 'checkout']);
  const reports = byConsumer(await m.verifyConsumers(NAME, 'v2'));
  assert.equal(reports.ledger?.verified, false, \`ledger is down (UNAVAILABLE) and must be reported unverified, got \${JSON.stringify(reports.ledger)}\`);
  assert(String(reports.ledger.detail ?? '').toLowerCase().includes('unavailable'), \`ledger's report must carry the call's status (UNAVAILABLE) as its detail, got \${JSON.stringify(reports.ledger)}\`);
  for (const id of FLEET) {
    const made = ctx.grpc.callsTo('CanReadVersion', \`\${id}:9000\`).length;
    assert.equal(made, 1, \`\${id} was called \${made} times for one verification: one down consumer made the gate ask the whole fleet again. Make one call per consumer and report the failure\`);
  }
}

export async function check_retire_gate(ctx) {
  const {m, vault, rotation, pkg} = await setup(ctx, ['billing', 'checkout']);
  const blocked = await m.retire(NAME, 'v1', 'v2');
  assert.equal(blocked.retired, false, \`with ledger down retire answered \${JSON.stringify(blocked)}: an unverified consumer blocks retirement\`);
  assert.deepStrictEqual(blocked.blocked_by, ['ledger'], 'blocked_by must name ledger');
  assert.deepStrictEqual(await rotation.validVersions(NAME), ['v2', 'v1'], 'a blocked retirement must leave v1 valid');
  const alerts = await vault.alerts(NAME);
  assert.deepStrictEqual(alerts, [{version_id: 'v2', pending: ['ledger']}], \`a blocked retirement must page with the pending consumers (vault.raiseAlert), the alerts are \${JSON.stringify(alerts)}\`);
  ctx.grpc.serve(pkg.secretsrotation.SecretConsumer.service, consumerImpl('ledger'), 'ledger:9000');
  const done = await m.retire(NAME, 'v1', 'v2');
  assert.equal(done.retired, true, \`with every consumer verified retire answered \${JSON.stringify(done)}\`);
  assert.deepStrictEqual(await rotation.validVersions(NAME), ['v2'], 'after the retirement only v2 is valid');
  assert.notEqual((await vault.getVersion(NAME, 'v1')).retired_at, null, 'the retirement must be recorded on v1 (vault.recordRetirement)');
  assert.equal((await vault.alerts(NAME)).length, 1, \`a retirement every consumer verified must not page, the alerts are \${JSON.stringify(await vault.alerts(NAME))}\`);
  await vault.createVersion('orphan', 'material', 3600, 'op-ana');
  await vault.createVersion('orphan', 'material-2', 3600, 'op-ana');
  await rotation.activate('orphan', 'v1');
  await rotation.activate('orphan', 'v2');
  const empty = await m.retire('orphan', 'v1', 'v2');
  assert.equal(empty.retired, false, \`a secret with no registered consumers retired its old version (\${JSON.stringify(empty)}): nobody verified is not everybody verified\`);
  assert.equal((await vault.alerts('orphan')).length, 1, 'a retirement blocked by an empty registry must page');
}
`,
    go: `package main

import (
	"context"
	"sort"
	"strings"
	"time"

	"secretd/rotation"
	"secretd/vault"
	pb "secretd/gen/secrets_rotation"

	"leetbuild/harness"
)

const kHClientName = "payments-db"

var (
	hClientBg    = context.Background()
	hClientFleet = []string{"billing", "checkout", "ledger"}
)

// consumerPeer can read every version but those after the one it is on (holds); a non-nil answer fixes its reply.
type HConsumerPeer struct {
	pb.UnimplementedSecretConsumerServer
	id     string
	holds  string
	answer *pb.CanReadReply
}

func (p *HConsumerPeer) CanReadVersion(_ context.Context, req *pb.CanReadRequest) (*pb.CanReadReply, error) {
	if p.answer != nil {
		return p.answer, nil
	}
	can := req.GetVersionId() <= p.holds
	version := p.holds
	if can {
		version = req.GetVersionId()
	}
	return &pb.CanReadReply{ConsumerId: p.id, VersionId: version, CanRead: can}, nil
}

func hClientServe(ctx *harness.Ctx, id, holds string) {
	pb.RegisterSecretConsumerServer(ctx.GRPC.Server(id+":9000"), &HConsumerPeer{id: id, holds: holds})
}

func hClientSetup(ctx *harness.Ctx, name string, up []string, lagging string) {
	vault.CreateVersion(hClientBg, name, "material-one", 3600, "op-ana")
	vault.CreateVersion(hClientBg, name, "material-two", 3600, "op-ana")
	rotation.Activate(hClientBg, name, "v1")
	rotation.Activate(hClientBg, name, "v2")
	if up == nil {
		return
	}
	for _, id := range hClientFleet {
		vault.RegisterConsumer(hClientBg, name, id)
	}
	for _, id := range up {
		holds := "v2"
		if id == lagging {
			holds = "v1"
		}
		hClientServe(ctx, id, holds)
	}
}

func hClientReports(ctx *harness.Ctx) map[string]Report {
	reports, err := verifyConsumers(hClientBg, kHClientName, "v2")
	ctx.NoError(err, "verifyConsumers failed")
	out := map[string]Report{}
	for _, r := range reports {
		out[r.ConsumerID] = r
	}
	return out
}

func hClientValid(ctx *harness.Ctx, name string) []string {
	valid, err := rotation.ValidVersions(hClientBg, name)
	ctx.NoError(err, "ValidVersions failed")
	return valid
}

func CheckVerifyDeadline(ctx *harness.Ctx) {
	hClientSetup(ctx, kHClientName, hClientFleet, "")
	reports := hClientReports(ctx)
	ids := []string{}
	for id := range reports {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	ctx.Equal(ids, hClientFleet, "verifyConsumers must answer one report per registered consumer")
	calls := ctx.GRPC.CallsTo("CanReadVersion", "")
	ctx.Assert(len(calls) > 0, "no CanReadVersion call was made")
	for _, call := range calls {
		ctx.Assert(!call.Deadline.IsZero(), "a CanReadVersion call to %s carries no deadline: a wedged consumer holds the rotation worker for as long as it likes", call.Target)
		ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "a CanReadVersion call carries a %v deadline, expected verifyDeadline = 2 s", call.Timeout)
	}
	// billing answers after 1.5 s, inside its deadline; every call after it still carries a full 2 s of its own.
	ctx.GRPC.SetLatency("CanReadVersion", 1.5, "billing:9000")
	ctx.GRPC.SetLatency("CanReadVersion", 30.0, "ledger:9000")
	before := len(calls)
	reports = hClientReports(ctx)
	ctx.Equal(reports["ledger"].Verified, false, "a consumer that takes 30 s to answer must be reported unverified after the deadline (%+v); verified", reports["ledger"])
	ctx.Assert(reports["billing"].Verified && reports["checkout"].Verified, "the healthy consumers must still verify (billing answers in 1.5 s, inside its deadline), got %+v", reports)
	later := ctx.GRPC.CallsTo("CanReadVersion", "")[before:]
	ctx.Equal(len(later), 3, "the second verification must make one CanReadVersion call per consumer; its calls")
	for _, call := range later {
		ctx.Assert(!call.Deadline.IsZero() && 1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "after billing took 1.5 s, the call to %s carried a %v deadline: each call gets its own verifyDeadline = 2 s, not what is left of one shared deadline", call.Target, call.Timeout)
	}
}

func CheckReplyMustMatch(ctx *harness.Ctx) {
	hClientSetup(ctx, kHClientName, hClientFleet, "ledger")
	// audit says yes, but for the version it holds; search names v2 but says it cannot read it.
	for _, peer := range []*HConsumerPeer{
		{id: "audit", answer: &pb.CanReadReply{ConsumerId: "audit", VersionId: "v1", CanRead: true}},
		{id: "search", answer: &pb.CanReadReply{ConsumerId: "search", VersionId: "v2", CanRead: false}},
	} {
		vault.RegisterConsumer(hClientBg, kHClientName, peer.id)
		pb.RegisterSecretConsumerServer(ctx.GRPC.Server(peer.id+":9000"), peer)
	}
	reports := hClientReports(ctx)
	ctx.Equal(reports["ledger"].Verified, false, "ledger answered can_read=false (it still runs on v1) and was reported %+v: only a yes for exactly v2 is a verification; verified", reports["ledger"])
	audit, ok := reports["audit"]
	ctx.Assert(ok && !audit.Verified, "audit answered can_read=true for version_id v1 and was reported %+v: only a yes for exactly v2 is a verification", audit)
	search, ok := reports["search"]
	ctx.Assert(ok && !search.Verified, "search answered version_id v2 with can_read=false and was reported %+v: only a yes for exactly v2 is a verification", search)
	ctx.Assert(reports["billing"].Verified && reports["checkout"].Verified, "billing and checkout can read v2 and must verify, got %+v", reports)
	ctx.Equal(vault.Accepted(hClientBg, kHClientName, "v2"), []string{"billing", "checkout"}, "the consumers the vault records as having accepted v2")
}

func CheckOneCallPerConsumer(ctx *harness.Ctx) {
	hClientSetup(ctx, kHClientName, []string{"billing", "checkout"}, "")
	reports := hClientReports(ctx)
	ledger, ok := reports["ledger"]
	ctx.Assert(ok && !ledger.Verified, "ledger is down (UNAVAILABLE) and must be reported unverified, got %+v", ledger)
	ctx.Assert(strings.Contains(strings.ToLower(ledger.Detail), "unavailable"), "ledger's report must carry the call's status (Unavailable) as its detail, got %+v", ledger)
	for _, id := range hClientFleet {
		made := len(ctx.GRPC.CallsTo("CanReadVersion", id+":9000"))
		ctx.Equal(made, 1, "%s was called more than once for one verification: one down consumer made the gate ask the whole fleet again. Make one call per consumer and report the failure; its calls", id)
	}
}

func CheckRetireGate(ctx *harness.Ctx) {
	hClientSetup(ctx, kHClientName, []string{"billing", "checkout"}, "")
	blocked, err := retire(hClientBg, kHClientName, "v1", "v2")
	ctx.NoError(err, "retire failed")
	ctx.Equal(blocked.Retired, false, "with ledger down an unverified consumer blocks retirement; retired")
	ctx.Equal(blocked.BlockedBy, []string{"ledger"}, "blocked_by must name ledger")
	ctx.Equal(hClientValid(ctx, kHClientName), []string{"v2", "v1"}, "a blocked retirement must leave v1 valid; ValidVersions")
	alerts := vault.Alerts(hClientBg, kHClientName)
	ctx.Assert(len(alerts) == 1 && alerts[0].VersionID == "v2" && len(alerts[0].Pending) == 1 && alerts[0].Pending[0] == "ledger", "a blocked retirement must page with the pending consumers (vault.RaiseAlert), the alerts are %+v", alerts)
	hClientServe(ctx, "ledger", "v2")
	done, err := retire(hClientBg, kHClientName, "v1", "v2")
	ctx.NoError(err, "retire failed")
	ctx.Equal(done.Retired, true, "with every consumer verified; retired")
	ctx.Equal(hClientValid(ctx, kHClientName), []string{"v2"}, "after the retirement; ValidVersions")
	ctx.Assert(vault.GetVersion(hClientBg, kHClientName, "v1").RetiredAt != 0, "the retirement must be recorded on v1 (vault.RecordRetirement)")
	ctx.Equal(len(vault.Alerts(hClientBg, kHClientName)), 1, "a retirement every consumer verified must not page; the alerts")
	hClientSetup(ctx, "orphan", nil, "")
	empty, err := retire(hClientBg, "orphan", "v1", "v2")
	ctx.NoError(err, "retire failed")
	ctx.Equal(empty.Retired, false, "a secret with no registered consumers retired its old version: nobody verified is not everybody verified; retired")
	ctx.Equal(len(vault.Alerts(hClientBg, "orphan")), 1, "a retirement blocked by an empty registry must page; the alerts")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cctype>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "secretd/rotation.h"
#include "secretd/vault.h"
#include "secrets_rotation.grpc.pb.h"

namespace {

const std::string hName = "payments-db";
const std::vector<std::string> hFleet = {"billing", "checkout", "ledger"};

// A registered consumer: it can read every version but those after the one it is on (holds); answer, a (version_id, can_read) pair, fixes its reply.
class HConsumerPeer final : public secretsrotation::SecretConsumer::Service {
 public:
  HConsumerPeer(std::string id, std::string holds, std::optional<std::pair<std::string, bool>> answer = std::nullopt)
      : id_(std::move(id)), holds_(std::move(holds)), answer_(std::move(answer)) {}
  grpc::Status CanReadVersion(grpc::ServerContext*, const secretsrotation::CanReadRequest* req, secretsrotation::CanReadReply* out) override {
    out->set_consumer_id(id_);
    if (answer_) {
      out->set_version_id(answer_->first);
      out->set_can_read(answer_->second);
      return grpc::Status::OK;
    }
    const bool can = req->version_id() <= holds_;
    out->set_version_id(can ? req->version_id() : holds_);
    out->set_can_read(can);
    return grpc::Status::OK;
  }

 private:
  std::string id_;
  std::string holds_;
  std::optional<std::pair<std::string, bool>> answer_;
};

std::vector<std::unique_ptr<HConsumerPeer>>& hPeers() {
  static std::vector<std::unique_ptr<HConsumerPeer>> all;
  return all;
}

void hServe(harness::Ctx& ctx, const std::string& id, const std::string& holds, std::optional<std::pair<std::string, bool>> answer = std::nullopt) {
  hPeers().push_back(std::make_unique<HConsumerPeer>(id, holds, std::move(answer)));
  ctx.GRPC.Server(id + ":9000")->RegisterService(hPeers().back().get());
}

void hSetup(harness::Ctx& ctx, const std::string& name, const std::vector<std::string>& up, const std::string& lagging, bool registered = true) {
  vault::createVersion(name, "material-one", 3600, "op-ana");
  vault::createVersion(name, "material-two", 3600, "op-ana");
  rotation::activate(name, "v1");
  rotation::activate(name, "v2");
  if (!registered) return;
  for (const auto& id : hFleet) vault::registerConsumer(name, id);
  for (const auto& id : up) hServe(ctx, id, id == lagging ? "v1" : "v2");
}

std::map<std::string, Report> hReports() {
  std::map<std::string, Report> out;
  for (const Report& r : verifyConsumers(hName, "v2")) out[r.consumer_id] = r;
  return out;
}

}  // namespace

void CheckVerifyDeadline(harness::Ctx& ctx) {
  hSetup(ctx, hName, hFleet, "");
  auto reports = hReports();
  std::vector<std::string> ids;
  for (const auto& [id, _] : reports) ids.push_back(id);
  ctx.Equal(ids, hFleet, "verifyConsumers must answer one report per registered consumer");
  const auto calls = ctx.GRPC.CallsTo("CanReadVersion");
  ctx.Assert(!calls.empty(), "no CanReadVersion call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a CanReadVersion call to %s carries no deadline: a wedged consumer holds the rotation worker for as long as it likes", call.Target);
    ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "a CanReadVersion call carries a %v s deadline, expected kVerifyDeadline = 2 s", call.TimeoutSeconds());
  }
  // billing answers after 1.5 s, inside its deadline; every call after it still carries a full 2 s of its own.
  ctx.GRPC.SetLatency("CanReadVersion", 1.5, "billing:9000");
  ctx.GRPC.SetLatency("CanReadVersion", 30.0, "ledger:9000");
  const size_t before = calls.size();
  reports = hReports();
  ctx.Equal(reports["ledger"].verified, false, "a consumer that takes 30 s to answer must be reported unverified after the deadline (%s); verified", reports["ledger"].detail);
  ctx.Assert(reports["billing"].verified && reports["checkout"].verified, "the healthy consumers must still verify (billing answers in 1.5 s, inside its deadline)");
  const auto all = ctx.GRPC.CallsTo("CanReadVersion");
  ctx.Equal(all.size() - before, 3, "the second verification must make one CanReadVersion call per consumer; its calls");
  for (size_t i = before; i < all.size(); ++i) {
    ctx.Assert(all[i].HasDeadline() && 1.5 <= all[i].TimeoutSeconds() && all[i].TimeoutSeconds() <= 2.5,
               "after billing took 1.5 s, the call to %s carried a %v s deadline: each call gets its own kVerifyDeadline = 2 s, not what is left of one shared deadline", all[i].Target, all[i].TimeoutSeconds());
  }
}

void CheckReplyMustMatch(harness::Ctx& ctx) {
  hSetup(ctx, hName, hFleet, "ledger");
  // audit says yes, but for the version it holds; search names v2 but says it cannot read it.
  vault::registerConsumer(hName, "audit");
  hServe(ctx, "audit", "v2", std::make_pair(std::string("v1"), true));
  vault::registerConsumer(hName, "search");
  hServe(ctx, "search", "v2", std::make_pair(std::string("v2"), false));
  auto reports = hReports();
  ctx.Equal(reports["ledger"].verified, false, "ledger answered can_read=false (it still runs on v1): only a yes for exactly v2 is a verification; verified");
  ctx.Assert(reports.count("audit") == 1 && !reports["audit"].verified, "audit answered can_read=true for version_id v1 and was reported verified: only a yes for exactly v2 is a verification");
  ctx.Assert(reports.count("search") == 1 && !reports["search"].verified, "search answered version_id v2 with can_read=false and was reported verified: only a yes for exactly v2 is a verification");
  ctx.Assert(reports["billing"].verified && reports["checkout"].verified, "billing and checkout can read v2 and must verify");
  ctx.Equal(vault::accepted(hName, "v2"), {"billing", "checkout"}, "the consumers the vault records as having accepted v2");
}

void CheckOneCallPerConsumer(harness::Ctx& ctx) {
  hSetup(ctx, hName, {"billing", "checkout"}, "");
  auto reports = hReports();
  ctx.Assert(reports.count("ledger") == 1 && !reports["ledger"].verified, "ledger is down (UNAVAILABLE) and must be reported unverified");
  std::string detail = reports["ledger"].detail;
  std::transform(detail.begin(), detail.end(), detail.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  ctx.Assert(detail.find("unavailable") != std::string::npos || detail.find("14") != std::string::npos,
             "ledger's report must carry the call's status (UNAVAILABLE, code 14) as its detail, got %q", reports["ledger"].detail);
  for (const auto& id : hFleet) {
    const size_t made = ctx.GRPC.CallsTo("CanReadVersion", id + ":9000").size();
    ctx.Equal(made, 1, "%s was called more than once for one verification: one down consumer made the gate ask the whole fleet again. Make one call per consumer and report the failure; its calls", id);
  }
}

void CheckRetireGate(harness::Ctx& ctx) {
  hSetup(ctx, hName, {"billing", "checkout"}, "");
  const Retirement blocked = retire(hName, "v1", "v2");
  ctx.Equal(blocked.retired, false, "with ledger down an unverified consumer blocks retirement; retired");
  ctx.Equal(blocked.blocked_by, {"ledger"}, "blocked_by must name ledger");
  ctx.Equal(rotation::validVersions(hName), {"v2", "v1"}, "a blocked retirement must leave v1 valid; validVersions");
  const auto alerts = vault::alerts(hName);
  ctx.Assert(alerts.size() == 1 && alerts[0].version_id == "v2" && alerts[0].pending == std::vector<std::string>{"ledger"},
             "a blocked retirement must page with the pending consumers (vault::raiseAlert); the alerts: %d", alerts.size());
  hServe(ctx, "ledger", "v2");
  const Retirement done = retire(hName, "v1", "v2");
  ctx.Equal(done.retired, true, "with every consumer verified; retired");
  ctx.Equal(rotation::validVersions(hName), {"v2"}, "after the retirement; validVersions");
  ctx.Assert(vault::getVersion(hName, "v1")->retired_at != 0, "the retirement must be recorded on v1 (vault::recordRetirement)");
  ctx.Equal(vault::alerts(hName).size(), 1, "a retirement every consumer verified must not page; the alerts");
  hSetup(ctx, "orphan", {}, "", false);
  const Retirement empty = retire("orphan", "v1", "v2");
  ctx.Equal(empty.retired, false, "a secret with no registered consumers retired its old version: nobody verified is not everybody verified; retired");
  ctx.Equal(vault::alerts("orphan").size(), 1, "a retirement blocked by an empty registry must page; the alerts");
}
`,
  },
  hints: [
    'Stop one consumer and run a verification: every healthy consumer is called three times. Make one answer "I still run on v1": it counts as verified. Block a retirement and look for a page: there is none.',
    'The loop treats any call that returned as acceptance and repeats the whole registry while anything failed; no call has a deadline; the blocked branch only logs, and an empty registry has no pending consumer at all.',
    'Write `verify_consumer`: one `CanReadVersion(..., timeout=VERIFY_DEADLINE_S)`, verified when `reply.can_read` and `reply.version_id == version_id`. In `retire`, `if not reports or pending:` call `vault.raise_alert` and answer `retired: False`.',
  ],
  debrief: `Every fix closes the same gap: the absence of a real answer was read as an answer. A deadline on each call is what bounds a wedged consumer; a report built from the reply's own fields is what tells "I can read v2" from "I answered"; and one call per consumer turns a failure into a fact the gate acts on instead of a reason to ask everyone again. The gate is a function of the reports, so an empty registry blocks like a down consumer, and the blocked branch pages because a rotation stuck half way is an incident with a clock on it. Production rotations also retry the gate on a schedule with backoff, and let consumers report the version they load at startup, so the gate has evidence before it asks.`,
};
