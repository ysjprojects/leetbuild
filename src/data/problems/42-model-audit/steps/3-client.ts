import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Receipt signing that queues instead of skipping',
  concept: 'grpc',
  file: 'client',
  focus: ['auditd', 'signer', 'queue'],
  task: `## Task

**Starting point.** The starter is \`request_receipt(record_id)\`, which every chained record goes
through: it reads the record (\`audit.ledger\`) and its chain link (\`chain.entry_at\`), calls
\`ReceiptSigner.Sign\` up to \`MAX_ATTEMPTS\` = 3 times on any error, keeps the receipt with
\`ledger.set_receipt\` and answers \`{"record_id", "status", "signature"}\`. When the signer is healthy
records get signed; it hides 4 flaws.

**Failure mode the checks target.** A signer that hangs holds every append open; a revoked key is
retried as if it were a blip; a record the signer never saw is stored as signed with an empty
signature; and after one bad minute no record is ever sent to the signer again.

\`\`\`proto
service ReceiptSigner { rpc Sign(SignRequest) returns (Receipt); }  // PERMISSION_DENIED: key revoked
\`\`\`

- Every attempt carries a **500 ms** deadline (\`DEADLINE_S\` = 0.5).
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried. Any other code queues the record
  (\`ledger.queue_unsigned\`) and raises \`ReceiptRefused\` after that one call.
- When the attempts run out, the record is \`ledger.queue_unsigned\` and the answer says
  \`"status": "unsigned"\` with an empty signature.
- Each record makes its own attempts: no process-wide failure flag.`,
  sequence: {
    participants: ['Audit Service', 'Receipt signer', 'Signing queue'],
    messages: [
      {
        from: 'Audit Service',
        to: 'Receipt signer',
        label: 'Sign(record_id, tenant, position, link) · 500 ms',
        kind: 'sync',
      },
      {from: 'Receipt signer', to: 'Audit Service', label: 'Receipt{signature, key_id}', kind: 'reply'},
      {
        from: 'Audit Service',
        to: 'Receipt signer',
        label: 'UNAVAILABLE / DEADLINE_EXCEEDED → again, 3 attempts',
        kind: 'sync',
      },
      {
        from: 'Receipt signer',
        to: 'Audit Service',
        label: 'PERMISSION_DENIED → ReceiptRefused, no retry',
        kind: 'reply',
      },
      {from: 'Audit Service', to: 'Signing queue', label: 'queue_unsigned(record_id)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Sign attempt carries a 500 ms deadline',
      detail:
        'Each call is made with `DEADLINE_S`/`DEADLINE_MS` (500 ms), so three attempts against a stalled signer cost 1.5 s, not an open request.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.5\b/, /Sign\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*500\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*500\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineMillis\s*=\s*500L?\b/, /withDeadlineAfter\(\s*DeadlineMillis/]},
        cpp: {all: [/kDeadline\{500\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'transient-only',
      title: 'Only UNAVAILABLE and DEADLINE_EXCEEDED are retried',
      detail:
        'A transient code is retried; any other (`PERMISSION_DENIED`: the key is revoked) queues the record and raises `ReceiptRefused` after one call, so an operator hears about it.',
      match: {
        python: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /raise ReceiptRefused/]},
        typescript: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /throw new ReceiptRefused/]},
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /ErrReceiptRefused\)?,/]},
        scala: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /throw new ReceiptRefused/]},
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/, /throw ReceiptRefused/]},
      },
    },
    {
      id: 'unsigned-queue',
      title: 'A record the signer never signed is queued as unsigned',
      detail:
        'When the attempts run out the record goes through `queue_unsigned`/`queueUnsigned` and the answer says `unsigned`; recording an empty receipt marks a record signed that has no signature.',
      match: {
        python: {all: [/ledger\.queue_unsigned\(/], none: [/set_receipt\([^)\n]*""/]},
        typescript: {all: [/queueUnsigned\(/], none: [/setReceipt\([^)\n]*''/]},
        go: {all: [/ledger\.QueueUnsigned\(/], none: [/SetReceipt\([^)\n]*""/]},
        scala: {all: [/Ledger\.queueUnsigned\(/], none: [/setReceipt\([^)\n]*""/]},
        cpp: {all: [/ledger::queueUnsigned\(/], none: [/setReceipt\([^)\n]*""/]},
      },
    },
    {
      id: 'no-sticky-failure',
      title: 'Each record makes its own attempts',
      detail:
        'No process-wide flag remembers a failure: after the signer recovers, the next record is sent to it and signed.',
      match: {
        python: {none: [/signer_?[dD]own/]},
        typescript: {none: [/signer_?[dD]own/]},
        go: {none: [/signer_?[dD]own/]},
        scala: {none: [/signer_?[dD]own/]},
        cpp: {none: [/signer_?[dD]own/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import signer_pb2
import signer_pb2_grpc
from audit import chain, ledger

MAX_ATTEMPTS = 3

signer = signer_pb2_grpc.ReceiptSignerStub(grpc.insecure_channel("signer:9000"))

# Set on the first failure, so later records do not wait on a signer that is down.
signer_down = False


class ReceiptRefused(Exception):
    """The signer refused for good (the key is revoked): an operator has to act."""


def request_receipt(record_id: str) -> dict:
    """Have the signer sign the record's chain link: {"record_id", "status", "signature"}."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    global signer_down
    record = ledger.get(record_id)
    entry = chain.entry_at(record["tenant"], record["position"])
    request = signer_pb2.SignRequest(record_id=record_id, tenant=record["tenant"], position=record["position"], digest=entry["digest"])
    if not signer_down:
        for _ in range(MAX_ATTEMPTS):
            try:
                receipt = signer.Sign(request)
            except grpc.RpcError:
                continue
            ledger.set_receipt(record_id, receipt.signature, receipt.key_id)
            return {"record_id": record_id, "status": "signed", "signature": receipt.signature}
        signer_down = True
    ledger.set_receipt(record_id, "", "")
    return {"record_id": record_id, "status": "signed", "signature": ""}
`,
      solution: `import grpc

import signer_pb2
import signer_pb2_grpc
from audit import chain, ledger

MAX_ATTEMPTS = 3
DEADLINE_S = 0.5
TRANSIENT = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

signer = signer_pb2_grpc.ReceiptSignerStub(grpc.insecure_channel("signer:9000"))


class ReceiptRefused(Exception):
    """The signer refused for good (the key is revoked): an operator has to act."""


def request_receipt(record_id: str) -> dict:
    """Have the signer sign the record's chain link: {"record_id", "status", "signature"}."""
    record = ledger.get(record_id)
    entry = chain.entry_at(record["tenant"], record["position"])
    request = signer_pb2.SignRequest(record_id=record_id, tenant=record["tenant"], position=record["position"], digest=entry["digest"])
    for _ in range(MAX_ATTEMPTS):
        try:
            receipt = signer.Sign(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() in TRANSIENT:
                continue
            # Not a blip: the record waits in the queue and an operator hears about it now.
            ledger.queue_unsigned(record_id)
            raise ReceiptRefused(f"signer: {exc.code().name} {exc.details()}") from exc
        ledger.set_receipt(record_id, receipt.signature, receipt.key_id)
        return {"record_id": record_id, "status": "signed", "signature": receipt.signature}
    # Unsigned is a state the signing worker repairs; signed without a signature would be a false claim.
    ledger.queue_unsigned(record_id)
    return {"record_id": record_id, "status": "unsigned", "signature": ""}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {entryAt} from 'audit/chain';
import {get, queueUnsigned, setReceipt} from 'audit/ledger';

export const MAX_ATTEMPTS = 3;

interface SignRequest {
  record_id: string;
  tenant: string;
  position: number;
  digest: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('signer.proto')) as unknown as {
  audit: {ReceiptSigner: grpc.ServiceClientConstructor};
};
const signer = new pkg.audit.ReceiptSigner('signer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Sign(request: SignRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{record_id: string; signature: string; key_id: string}>;
};

/** The signer refused for good (the key is revoked): an operator has to act. */
export class ReceiptRefused extends Error {}

export interface ReceiptResult {
  record_id: string;
  status: string;
  signature: string;
}

// Set on the first failure, so later records do not wait on a signer that is down.
let signerDown = false;

/** Have the signer sign the record's chain link. */
export async function requestReceipt(recordId: string): Promise<ReceiptResult> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const record = (await get(recordId))!;
  const entry = (await entryAt(record.tenant, record.position))!;
  const request = {record_id: recordId, tenant: record.tenant, position: record.position, digest: entry.digest};
  if (!signerDown) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const receipt = await signer.Sign(request, new grpc.Metadata(), {});
        await setReceipt(recordId, receipt.signature, receipt.key_id);
        return {record_id: recordId, status: 'signed', signature: receipt.signature};
      } catch {
        continue;
      }
    }
    signerDown = true;
  }
  await setReceipt(recordId, '', '');
  return {record_id: recordId, status: 'signed', signature: ''};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {entryAt} from 'audit/chain';
import {get, queueUnsigned, setReceipt} from 'audit/ledger';

export const MAX_ATTEMPTS = 3;
export const DEADLINE_MS = 500;

interface SignRequest {
  record_id: string;
  tenant: string;
  position: number;
  digest: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('signer.proto')) as unknown as {
  audit: {ReceiptSigner: grpc.ServiceClientConstructor};
};
const signer = new pkg.audit.ReceiptSigner('signer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Sign(request: SignRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{record_id: string; signature: string; key_id: string}>;
};

/** The signer refused for good (the key is revoked): an operator has to act. */
export class ReceiptRefused extends Error {}

export interface ReceiptResult {
  record_id: string;
  status: string;
  signature: string;
}

/** Have the signer sign the record's chain link. */
export async function requestReceipt(recordId: string): Promise<ReceiptResult> {
  const record = (await get(recordId))!;
  const entry = (await entryAt(record.tenant, record.position))!;
  const request = {record_id: recordId, tenant: record.tenant, position: record.position, digest: entry.digest};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const receipt = await signer.Sign(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      await setReceipt(recordId, receipt.signature, receipt.key_id);
      return {record_id: recordId, status: 'signed', signature: receipt.signature};
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED) continue;
      // Not a blip: the record waits in the queue and an operator hears about it now.
      await queueUnsigned(recordId);
      throw new ReceiptRefused(\`signer: \${grpc.status[code]} \${details}\`);
    }
  }
  // Unsigned is a state the signing worker repairs; signed without a signature would be a false claim.
  await queueUnsigned(recordId);
  return {record_id: recordId, status: 'unsigned', signature: ''};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"audit/chain"  // chain.EntryAt
	"audit/ledger" // ledger.Get, SetReceipt, QueueUnsigned
	pb "audit/gen/signer"
)

const maxAttempts = 3

var (
	signerConn, _ = grpc.NewClient("signer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	signer        = pb.NewReceiptSignerClient(signerConn)
)

// ErrReceiptRefused: the signer refused for good (the key is revoked), an operator has to act.
var ErrReceiptRefused = errors.New("the signer refused the receipt")

// Receipt is what requestReceipt answers.
type Receipt struct {
	RecordID  string \`json:"record_id"\`
	Status    string \`json:"status"\`
	Signature string \`json:"signature"\`
}

// signerDown is set on the first failure, so later records do not wait on a signer that is down.
var signerDown = false

// requestReceipt has the signer sign the record's chain link.
func requestReceipt(ctx context.Context, recordID string) (Receipt, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	record := ledger.Get(ctx, recordID)
	if record == nil {
		return Receipt{}, fmt.Errorf("no record %s", recordID)
	}
	entry, err := chain.EntryAt(ctx, record.Tenant, record.Position)
	if err != nil || entry == nil {
		return Receipt{}, fmt.Errorf("record %s is not chained: %v", recordID, err)
	}
	request := &pb.SignRequest{RecordId: recordID, Tenant: record.Tenant, Position: record.Position, Digest: entry.Digest}
	if !signerDown {
		for attempt := 0; attempt < maxAttempts; attempt++ {
			receipt, err := signer.Sign(ctx, request)
			if err != nil {
				continue
			}
			ledger.SetReceipt(ctx, recordID, receipt.GetSignature(), receipt.GetKeyId())
			return Receipt{RecordID: recordID, Status: "signed", Signature: receipt.GetSignature()}, nil
		}
		signerDown = true
	}
	ledger.SetReceipt(ctx, recordID, "", "")
	return Receipt{RecordID: recordID, Status: "signed"}, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"audit/chain"  // chain.EntryAt
	"audit/ledger" // ledger.Get, SetReceipt, QueueUnsigned
	pb "audit/gen/signer"
)

const (
	maxAttempts = 3
	deadline    = 500 * time.Millisecond
)

var (
	signerConn, _ = grpc.NewClient("signer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	signer        = pb.NewReceiptSignerClient(signerConn)
)

// ErrReceiptRefused: the signer refused for good (the key is revoked), an operator has to act.
var ErrReceiptRefused = errors.New("the signer refused the receipt")

// Receipt is what requestReceipt answers.
type Receipt struct {
	RecordID  string \`json:"record_id"\`
	Status    string \`json:"status"\`
	Signature string \`json:"signature"\`
}

// requestReceipt has the signer sign the record's chain link.
func requestReceipt(ctx context.Context, recordID string) (Receipt, error) {
	record := ledger.Get(ctx, recordID)
	if record == nil {
		return Receipt{}, fmt.Errorf("no record %s", recordID)
	}
	entry, err := chain.EntryAt(ctx, record.Tenant, record.Position)
	if err != nil || entry == nil {
		return Receipt{}, fmt.Errorf("record %s is not chained: %v", recordID, err)
	}
	request := &pb.SignRequest{RecordId: recordID, Tenant: record.Tenant, Position: record.Position, Digest: entry.Digest}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		receipt, err := signer.Sign(callCtx, request)
		cancel()
		if err == nil {
			ledger.SetReceipt(ctx, recordID, receipt.GetSignature(), receipt.GetKeyId())
			return Receipt{RecordID: recordID, Status: "signed", Signature: receipt.GetSignature()}, nil
		}
		code := status.Code(err)
		if code == codes.Unavailable || code == codes.DeadlineExceeded {
			continue
		}
		// Not a blip: the record waits in the queue and an operator hears about it now.
		ledger.QueueUnsigned(ctx, recordID)
		return Receipt{RecordID: recordID, Status: "unsigned"}, fmt.Errorf("%w: %v %s", ErrReceiptRefused, code, status.Convert(err).Message())
	}
	// Unsigned is a state the signing worker repairs; signed without a signature would be a false claim.
	ledger.QueueUnsigned(ctx, recordID)
	return Receipt{RecordID: recordID, Status: "unsigned"}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import audit.{Chain, Ledger} // Chain.entryAt; Ledger.get, setReceipt, queueUnsigned
import audit.signer.{ReceiptSignerGrpc, SignRequest}

/** The signer refused for good (the key is revoked): an operator has to act. */
final class ReceiptRefused(message: String) extends Exception(message)

object Client {
  final case class ReceiptResult(recordId: String, status: String, signature: String)

  val MaxAttempts = 3

  private val signer = ReceiptSignerGrpc.blockingStub(ManagedChannelBuilder.forAddress("signer", 9000).usePlaintext().build())

  /** Set on the first failure, so later records do not wait on a signer that is down. */
  @volatile private var signerDown = false

  /** Have the signer sign the record's chain link. */
  def requestReceipt(recordId: String): ReceiptResult = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val record = Ledger.get(recordId).get
    val entry = Chain.entryAt(record.tenant, record.position).get
    val request = SignRequest(recordId, record.tenant, record.position, entry.digest)
    if (!signerDown) {
      for (_ <- 1 to MaxAttempts) {
        try {
          val receipt = signer.sign(request)
          Ledger.setReceipt(recordId, receipt.signature, receipt.keyId)
          return ReceiptResult(recordId, "signed", receipt.signature)
        } catch { case _: StatusRuntimeException => () }
      }
      signerDown = true
    }
    Ledger.setReceipt(recordId, "", "")
    ReceiptResult(recordId, "signed", "")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import audit.{Chain, Ledger} // Chain.entryAt; Ledger.get, setReceipt, queueUnsigned
import audit.signer.{ReceiptSignerGrpc, SignRequest}

/** The signer refused for good (the key is revoked): an operator has to act. */
final class ReceiptRefused(message: String) extends Exception(message)

object Client {
  final case class ReceiptResult(recordId: String, status: String, signature: String)

  val MaxAttempts = 3
  val DeadlineMillis = 500L

  private val signer = ReceiptSignerGrpc.blockingStub(ManagedChannelBuilder.forAddress("signer", 9000).usePlaintext().build())

  /** Have the signer sign the record's chain link. */
  def requestReceipt(recordId: String): ReceiptResult = {
    val record = Ledger.get(recordId).get
    val entry = Chain.entryAt(record.tenant, record.position).get
    val request = SignRequest(recordId, record.tenant, record.position, entry.digest)
    for (_ <- 1 to MaxAttempts) {
      try {
        val receipt = signer.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).sign(request)
        Ledger.setReceipt(recordId, receipt.signature, receipt.keyId)
        return ReceiptResult(recordId, "signed", receipt.signature)
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (code != Status.Code.UNAVAILABLE && code != Status.Code.DEADLINE_EXCEEDED) {
            // Not a blip: the record waits in the queue and an operator hears about it now.
            Ledger.queueUnsigned(recordId)
            throw new ReceiptRefused(s"signer: $code \${e.getStatus.getDescription}")
          }
      }
    }
    // Unsigned is a state the signing worker repairs; signed without a signature would be a false claim.
    Ledger.queueUnsigned(recordId)
    ReceiptResult(recordId, "unsigned", "")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>

#include "audit/chain.h"   // chain::entryAt
#include "audit/ledger.h"  // ledger::get, setReceipt, queueUnsigned
#include "signer.grpc.pb.h"

constexpr int kMaxAttempts = 3;

auto signer = audit::ReceiptSigner::NewStub(grpc::CreateChannel("signer:9000", grpc::InsecureChannelCredentials()));

// The signer refused for good (the key is revoked): an operator has to act.
struct ReceiptRefused : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct ReceiptResult {
  std::string record_id;
  std::string status;
  std::string signature;
};

// Set on the first failure, so later records do not wait on a signer that is down.
bool signer_down = false;

// Have the signer sign the record's chain link.
ReceiptResult requestReceipt(const std::string& record_id) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const ledger::Decision record = *ledger::get(record_id);
  const chain::Link entry = *chain::entryAt(record.tenant, record.position);
  audit::SignRequest request;
  request.set_record_id(record_id);
  request.set_tenant(record.tenant);
  request.set_position(record.position);
  request.set_digest(entry.digest);
  if (!signer_down) {
    for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
      grpc::ClientContext ctx;
      audit::Receipt receipt;
      if (!signer->Sign(&ctx, request, &receipt).ok()) continue;
      ledger::setReceipt(record_id, receipt.signature(), receipt.key_id());
      return ReceiptResult{record_id, "signed", receipt.signature()};
    }
    signer_down = true;
  }
  ledger::setReceipt(record_id, "", "");
  return ReceiptResult{record_id, "signed", ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "audit/chain.h"   // chain::entryAt
#include "audit/ledger.h"  // ledger::get, setReceipt, queueUnsigned
#include "signer.grpc.pb.h"

constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kDeadline{500};

auto signer = audit::ReceiptSigner::NewStub(grpc::CreateChannel("signer:9000", grpc::InsecureChannelCredentials()));

// The signer refused for good (the key is revoked): an operator has to act.
struct ReceiptRefused : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct ReceiptResult {
  std::string record_id;
  std::string status;
  std::string signature;
};

// Have the signer sign the record's chain link.
ReceiptResult requestReceipt(const std::string& record_id) {
  const ledger::Decision record = *ledger::get(record_id);
  const chain::Link entry = *chain::entryAt(record.tenant, record.position);
  audit::SignRequest request;
  request.set_record_id(record_id);
  request.set_tenant(record.tenant);
  request.set_position(record.position);
  request.set_digest(entry.digest);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    audit::Receipt receipt;
    const grpc::Status status = signer->Sign(&ctx, request, &receipt);
    if (status.ok()) {
      ledger::setReceipt(record_id, receipt.signature(), receipt.key_id());
      return ReceiptResult{record_id, "signed", receipt.signature()};
    }
    const grpc::StatusCode code = status.error_code();
    if (code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED) continue;
    // Not a blip: the record waits in the queue and an operator hears about it now.
    ledger::queueUnsigned(record_id);
    throw ReceiptRefused("signer: " + status.error_message());
  }
  // Unsigned is a state the signing worker repairs; signed without a signature would be a false claim.
  ledger::queueUnsigned(record_id);
  return ReceiptResult{record_id, "unsigned", ""};
}
`,
    },
  },
  harness: {
    python: `import hashlib

import grpc

import signer_pb2
import signer_pb2_grpc
from audit import chain, ledger


class Signer(signer_pb2_grpc.ReceiptSignerServicer):
    """Signs (tenant, position, link) with key k-2026."""

    def Sign(self, request, context):
        return signer_pb2.Receipt(record_id=request.record_id, signature=f"sig:{request.tenant}:{request.position}:{request.digest[:12]}", key_id="k-2026")


def _chained(n):
    fields = {
        "model_version": "risk-v7",
        "policy_id": "refunds-2026-10",
        "input_digest": hashlib.sha256(f"in-{n}".encode()).hexdigest(),
        "decision_digest": hashlib.sha256(f"out-{n}".encode()).hexdigest(),
        "recorded_at": 1700000000000 + n,
    }
    record = ledger.insert("t1", fields)
    entry = chain.append_entry("t1", record["id"], ledger.record_digest(record))
    ledger.set_position(record["id"], entry["position"])
    return record["id"], entry


def _client(ctx):
    ctx.grpc.serve(signer_pb2_grpc.add_ReceiptSignerServicer_to_server, Signer())
    return ctx.load("client")


def _queue(ctx):
    return ctx.redis.lrange("audit:signing_queue", 0, -1)


def check_deadline(ctx):
    m = _client(ctx)
    record_id, entry = _chained(1)
    signed = m.request_receipt(record_id)
    want = f"sig:t1:1:{entry['digest'][:12]}"
    assert signed == {"record_id": record_id, "status": "signed", "signature": want}, f"with a healthy signer request_receipt answered {signed}, expected the signature of the record's link"
    for call in ctx.grpc.calls_to("Sign"):
        assert call.timeout is not None, "a Sign call carries no deadline: a signer that hangs holds every append open"
        assert 0.45 <= call.timeout <= 0.55, f"a Sign call carries a {call.timeout} s deadline, expected 0.5 s"
    ctx.grpc.set_latency("Sign", 2.0)
    other, _ = _chained(2)
    before = len(ctx.grpc.calls_to("Sign"))
    slow = m.request_receipt(other)
    calls = ctx.grpc.calls_to("Sign")[before:]
    assert all(c.timeout is not None and c.timeout <= 0.55 for c in calls), f"against a signer that takes 2 s the attempts carried deadlines {[c.timeout for c in calls]}, expected 0.5 s each"
    assert len(calls) == m.MAX_ATTEMPTS, f"against a signer that takes 2 s request_receipt made {len(calls)} attempts, expected MAX_ATTEMPTS = {m.MAX_ATTEMPTS}"
    assert slow["status"] == "unsigned", f"three attempts that hit the deadline answered {slow}, expected unsigned"


def check_transient_only(ctx):
    m = _client(ctx)
    record_id, _ = _chained(1)
    ctx.grpc.fail("Sign", grpc.StatusCode.PERMISSION_DENIED, "key k-2026 is revoked", times=1)
    try:
        answer = m.request_receipt(record_id)
    except m.ReceiptRefused:
        pass
    else:
        raise AssertionError(f"a PERMISSION_DENIED from the signer was answered {answer}: a revoked key is not a blip, request_receipt must raise ReceiptRefused")
    calls = len(ctx.grpc.calls_to("Sign"))
    assert calls == 1, f"a PERMISSION_DENIED was retried: {calls} Sign calls, expected 1"
    assert _queue(ctx) == [record_id], f"a refused record must wait in audit:signing_queue, it holds {_queue(ctx)}"
    other, _ = _chained(2)
    ctx.grpc.fail("Sign", grpc.StatusCode.UNAVAILABLE, "signer restarting", times=1)
    ctx.grpc.fail("Sign", grpc.StatusCode.DEADLINE_EXCEEDED, "", times=1)
    answer = m.request_receipt(other)
    assert answer["status"] == "signed", f"after one UNAVAILABLE and one DEADLINE_EXCEEDED the third attempt must sign the record, got {answer}"
    assert len(ctx.grpc.calls_to("Sign")) == calls + 3, f"the transient failures took {len(ctx.grpc.calls_to('Sign')) - calls} calls, expected 3"


def check_unsigned_queue(ctx):
    m = _client(ctx)
    record_id, _ = _chained(1)
    ctx.grpc.fail("Sign", grpc.StatusCode.UNAVAILABLE, "signer down", times=3)
    answer = m.request_receipt(record_id)
    assert answer == {"record_id": record_id, "status": "unsigned", "signature": ""}, f"with the signer down for every attempt request_receipt answered {answer}, expected unsigned with no signature"
    record = ledger.get(record_id)
    assert record["status"] == "unsigned", f"the ledger says the record is {record['status']!r} (signature {record.get('signature')!r}): a record the signer never signed is unsigned"
    assert _queue(ctx) == [record_id], f"audit:signing_queue holds {_queue(ctx)}, expected the record for the signing worker"


def check_no_sticky_failure(ctx):
    m = _client(ctx)
    first, _ = _chained(1)
    ctx.grpc.fail("Sign", grpc.StatusCode.UNAVAILABLE, "signer down", times=3)
    m.request_receipt(first)
    before = len(ctx.grpc.calls_to("Sign"))
    second, _ = _chained(2)
    answer = m.request_receipt(second)
    assert len(ctx.grpc.calls_to("Sign")) > before, "after one record failed, the next record was never sent to the signer: a failure must not be remembered for the whole process"
    assert answer["status"] == "signed", f"with the signer back the next record answered {answer}, expected signed"
    assert ledger.get(second)["status"] == "signed", f"the ledger says {ledger.get(second)['status']!r} for the record the recovered signer signed"
`,
    typescript: `import {createHash} from 'node:crypto';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function client(ctx) {
  const pkg = ctx.proto('signer.proto');
  ctx.grpc.serve(pkg.audit.ReceiptSigner.service, {
    Sign(call, callback) {
      const {record_id, tenant, position, digest} = call.request;
      callback(null, {record_id, signature: \`sig:\${tenant}:\${position}:\${String(digest).slice(0, 12)}\`, key_id: 'k-2026'});
    },
  });
  const ledger = ctx.load('/support/audit/ledger.ts');
  const chain = ctx.load('/support/audit/chain.ts');
  const chained = async (n: number) => {
    const fields = {model_version: 'risk-v7', policy_id: 'refunds-2026-10', input_digest: sha(\`in-\${n}\`), decision_digest: sha(\`out-\${n}\`), recorded_at: 1700000000000 + n};
    const record = await ledger.insert('t1', fields);
    const entry = await chain.appendEntry('t1', record.id, ledger.recordDigest(record));
    await ledger.setPosition(record.id, entry.position);
    return {recordId: record.id as string, entry};
  };
  return {m: ctx.load('client'), ledger, chained};
}

const queue = ctx => ctx.redis.lrange('audit:signing_queue', 0, -1);

export async function check_deadline(ctx) {
  const {m, chained} = client(ctx);
  const {recordId, entry} = await chained(1);
  const signed = await m.requestReceipt(recordId);
  const want = \`sig:t1:1:\${entry.digest.slice(0, 12)}\`;
  assert.deepEqual(signed, {record_id: recordId, status: 'signed', signature: want}, \`with a healthy signer requestReceipt answered \${JSON.stringify(signed)}, expected the signature of the record's link\`);
  for (const call of ctx.grpc.callsTo('Sign')) {
    assert(call.timeout !== null, 'a Sign call carries no deadline: a signer that hangs holds every append open');
    assert(0.45 <= call.timeout && call.timeout <= 0.55, \`a Sign call carries a \${call.timeout} s deadline, expected 0.5 s\`);
  }
  ctx.grpc.setLatency('Sign', 2.0);
  const other = await chained(2);
  const before = ctx.grpc.callsTo('Sign').length;
  const slow = await m.requestReceipt(other.recordId);
  const calls = ctx.grpc.callsTo('Sign').slice(before);
  assert(calls.every(c => c.timeout !== null && c.timeout <= 0.55), \`against a signer that takes 2 s the attempts carried deadlines \${JSON.stringify(calls.map(c => c.timeout))}, expected 0.5 s each\`);
  assert.equal(calls.length, m.MAX_ATTEMPTS, \`against a signer that takes 2 s requestReceipt made \${calls.length} attempts, expected MAX_ATTEMPTS = \${m.MAX_ATTEMPTS}\`);
  assert.equal(slow.status, 'unsigned', \`three attempts that hit the deadline answered \${JSON.stringify(slow)}, expected unsigned\`);
}

export async function check_transient_only(ctx) {
  const {m, chained} = client(ctx);
  const {recordId} = await chained(1);
  ctx.grpc.fail('Sign', ctx.grpc.status.PERMISSION_DENIED, 'key k-2026 is revoked', 1);
  let answer;
  try {
    answer = await m.requestReceipt(recordId);
  } catch (e) {
    assert(e instanceof m.ReceiptRefused, \`a PERMISSION_DENIED made requestReceipt throw \${(e as Error).constructor.name}: \${(e as Error).message}, expected ReceiptRefused\`);
  }
  assert.equal(answer, undefined, \`a PERMISSION_DENIED from the signer was answered \${JSON.stringify(answer)}: a revoked key is not a blip, requestReceipt must throw ReceiptRefused\`);
  const calls = ctx.grpc.callsTo('Sign').length;
  assert.equal(calls, 1, \`a PERMISSION_DENIED was retried: \${calls} Sign calls, expected 1\`);
  assert.deepEqual(queue(ctx), [recordId], \`a refused record must wait in audit:signing_queue, it holds \${JSON.stringify(queue(ctx))}\`);
  const other = await chained(2);
  ctx.grpc.fail('Sign', ctx.grpc.status.UNAVAILABLE, 'signer restarting', 1);
  ctx.grpc.fail('Sign', ctx.grpc.status.DEADLINE_EXCEEDED, '', 1);
  const retried = await m.requestReceipt(other.recordId);
  assert.equal(retried.status, 'signed', \`after one UNAVAILABLE and one DEADLINE_EXCEEDED the third attempt must sign the record, got \${JSON.stringify(retried)}\`);
  assert.equal(ctx.grpc.callsTo('Sign').length, calls + 3, \`the transient failures took \${ctx.grpc.callsTo('Sign').length - calls} calls, expected 3\`);
}

export async function check_unsigned_queue(ctx) {
  const {m, ledger, chained} = client(ctx);
  const {recordId} = await chained(1);
  ctx.grpc.fail('Sign', ctx.grpc.status.UNAVAILABLE, 'signer down', 3);
  const answer = await m.requestReceipt(recordId);
  assert.deepEqual(answer, {record_id: recordId, status: 'unsigned', signature: ''}, \`with the signer down for every attempt requestReceipt answered \${JSON.stringify(answer)}, expected unsigned with no signature\`);
  const record = await ledger.get(recordId);
  assert.equal(record.status, 'unsigned', \`the ledger says the record is \${JSON.stringify(record.status)} (signature \${JSON.stringify(record.signature)}): a record the signer never signed is unsigned\`);
  assert.deepEqual(queue(ctx), [recordId], \`audit:signing_queue holds \${JSON.stringify(queue(ctx))}, expected the record for the signing worker\`);
}

export async function check_no_sticky_failure(ctx) {
  const {m, ledger, chained} = client(ctx);
  const first = await chained(1);
  ctx.grpc.fail('Sign', ctx.grpc.status.UNAVAILABLE, 'signer down', 3);
  await m.requestReceipt(first.recordId);
  const before = ctx.grpc.callsTo('Sign').length;
  const second = await chained(2);
  const answer = await m.requestReceipt(second.recordId);
  assert(ctx.grpc.callsTo('Sign').length > before, 'after one record failed, the next record was never sent to the signer: a failure must not be remembered for the whole process');
  assert.equal(answer.status, 'signed', \`with the signer back the next record answered \${JSON.stringify(answer)}, expected signed\`);
  assert.equal((await ledger.get(second.recordId)).status, 'signed', 'the ledger must say signed for the record the recovered signer signed');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"

	"audit/chain"
	"audit/digest"
	"audit/ledger"
	pb "audit/gen/signer"

	"leetbuild/harness"
)

var clientBg = context.Background()

// signerPeer signs (tenant, position, link) with key k-2026.
type signerPeer struct {
	pb.UnimplementedReceiptSignerServer
}

func (signerPeer) Sign(_ context.Context, req *pb.SignRequest) (*pb.Receipt, error) {
	return &pb.Receipt{RecordId: req.GetRecordId(), Signature: fmt.Sprintf("sig:%s:%d:%s", req.GetTenant(), req.GetPosition(), req.GetDigest()[:12]), KeyId: "k-2026"}, nil
}

func client(ctx *harness.Ctx) {
	pb.RegisterReceiptSignerServer(ctx.GRPC.Server(""), signerPeer{})
}

func chained(ctx *harness.Ctx, n int) (string, chain.Entry) {
	fields := map[string]any{
		"model_version":   "risk-v7",
		"policy_id":       "refunds-2026-10",
		"input_digest":    digest.Sha256Hex(fmt.Sprintf("in-%d", n)),
		"decision_digest": digest.Sha256Hex(fmt.Sprintf("out-%d", n)),
		"recorded_at":     fmt.Sprint(1700000000000 + n),
	}
	record, err := ledger.Insert(clientBg, "t1", fields)
	ctx.NoError(err, "the ledger insert failed")
	entry, err := chain.AppendEntry(clientBg, "t1", record.ID, ledger.RecordDigest(record))
	ctx.NoError(err, "the chain append failed")
	ledger.SetPosition(clientBg, record.ID, entry.Position)
	return record.ID, entry
}

func signingQueue(ctx *harness.Ctx) []string { return ctx.Redis.LRange("audit:signing_queue", 0, -1) }

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	recordID, entry := chained(ctx, 1)
	signed, err := requestReceipt(clientBg, recordID)
	ctx.NoError(err, "with a healthy signer requestReceipt failed")
	want := fmt.Sprintf("sig:t1:1:%s", entry.Digest[:12])
	ctx.Assert(signed.Status == "signed" && signed.Signature == want && signed.RecordID == recordID, "with a healthy signer requestReceipt answered %+v, expected the signature of the record's link", signed)
	for _, call := range ctx.GRPC.CallsTo("Sign", "") {
		ctx.Assert(call.HasDeadline(), "a Sign call carries no deadline: a signer that hangs holds every append open")
		ctx.Assert(450*time.Millisecond <= call.Timeout && call.Timeout <= 550*time.Millisecond, "a Sign call carries a %v deadline, expected 500 ms", call.Timeout)
	}
	ctx.GRPC.SetLatency("Sign", 2.0, "")
	other, _ := chained(ctx, 2)
	before := len(ctx.GRPC.CallsTo("Sign", ""))
	slow, _ := requestReceipt(clientBg, other)
	calls := ctx.GRPC.CallsTo("Sign", "")[before:]
	for _, call := range calls {
		ctx.Assert(call.HasDeadline() && call.Timeout <= 550*time.Millisecond, "against a signer that takes 2 s an attempt carried a %v deadline, expected 500 ms", call.Timeout)
	}
	ctx.Equal(len(calls), maxAttempts, "against a signer that takes 2 s, the attempts (expected maxAttempts)")
	ctx.Equal(slow.Status, "unsigned", "three attempts that hit the deadline; the status")
}

func CheckTransientOnly(ctx *harness.Ctx) {
	client(ctx)
	recordID, _ := chained(ctx, 1)
	ctx.GRPC.Fail("Sign", codes.PermissionDenied, "key k-2026 is revoked", 1, "")
	answer, err := requestReceipt(clientBg, recordID)
	ctx.Assert(err != nil && errors.Is(err, ErrReceiptRefused), "a PERMISSION_DENIED from the signer was answered %+v (error %v): a revoked key is not a blip, requestReceipt must return an error wrapping ErrReceiptRefused", answer, err)
	calls := len(ctx.GRPC.CallsTo("Sign", ""))
	ctx.Equal(calls, 1, "a PERMISSION_DENIED must not be retried; the Sign calls")
	ctx.Equal(signingQueue(ctx), []string{recordID}, "a refused record must wait in audit:signing_queue")
	other, _ := chained(ctx, 2)
	ctx.GRPC.Fail("Sign", codes.Unavailable, "signer restarting", 1, "")
	ctx.GRPC.Fail("Sign", codes.DeadlineExceeded, "", 1, "")
	retried, err := requestReceipt(clientBg, other)
	ctx.NoError(err, "after two transient failures requestReceipt failed")
	ctx.Equal(retried.Status, "signed", "after one UNAVAILABLE and one DEADLINE_EXCEEDED the third attempt must sign the record; the status")
	ctx.Equal(len(ctx.GRPC.CallsTo("Sign", "")), calls+3, "the transient failures and the success; the Sign calls")
}

func CheckUnsignedQueue(ctx *harness.Ctx) {
	client(ctx)
	recordID, _ := chained(ctx, 1)
	ctx.GRPC.Fail("Sign", codes.Unavailable, "signer down", 3, "")
	answer, err := requestReceipt(clientBg, recordID)
	ctx.NoError(err, "a signer down for every attempt is not an error of the record")
	ctx.Assert(answer.Status == "unsigned" && answer.Signature == "", "with the signer down for every attempt requestReceipt answered %+v, expected unsigned with no signature", answer)
	record := ledger.Get(clientBg, recordID)
	ctx.Equal(record.Status, "unsigned", "a record the signer never signed is unsigned (signature %q); the ledger status", record.Signature)
	ctx.Equal(signingQueue(ctx), []string{recordID}, "audit:signing_queue must hold the record for the signing worker")
}

func CheckNoStickyFailure(ctx *harness.Ctx) {
	client(ctx)
	first, _ := chained(ctx, 1)
	ctx.GRPC.Fail("Sign", codes.Unavailable, "signer down", 3, "")
	requestReceipt(clientBg, first)
	before := len(ctx.GRPC.CallsTo("Sign", ""))
	second, _ := chained(ctx, 2)
	answer, err := requestReceipt(clientBg, second)
	ctx.NoError(err, "with the signer back requestReceipt failed")
	ctx.Assert(len(ctx.GRPC.CallsTo("Sign", "")) > before, "after one record failed, the next record was never sent to the signer: a failure must not be remembered for the whole process")
	ctx.Equal(answer.Status, "signed", "with the signer back, the next record's status")
	ctx.Equal(ledger.Get(clientBg, second).Status, "signed", "the ledger status of the record the recovered signer signed")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <utility>
#include <vector>

namespace {

// Signs (tenant, position, link) with key k-2026.
class SignerPeer final : public audit::ReceiptSigner::Service {
 public:
  grpc::Status Sign(grpc::ServerContext*, const audit::SignRequest* req, audit::Receipt* out) override {
    out->set_record_id(req->record_id());
    out->set_signature("sig:" + req->tenant() + ":" + std::to_string(req->position()) + ":" + req->digest().substr(0, 12));
    out->set_key_id("k-2026");
    return grpc::Status::OK;
  }
};

void client(harness::Ctx& ctx) {
  static SignerPeer* peer = nullptr;
  delete peer;
  peer = new SignerPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

std::pair<std::string, chain::Entry> chained(int n) {
  const nlohmann::json fields = {{"model_version", "risk-v7"},
                                 {"policy_id", "refunds-2026-10"},
                                 {"input_digest", sha256_hex("in-" + std::to_string(n))},
                                 {"decision_digest", sha256_hex("out-" + std::to_string(n))},
                                 {"recorded_at", std::to_string(1700000000000LL + n)}};
  const ledger::Decision record = ledger::insert("t1", fields);
  const chain::Entry entry = chain::appendEntry("t1", record.id, ledger::recordDigest(record));
  ledger::setPosition(record.id, entry.position);
  return {record.id, entry};
}

std::vector<std::string> signingQueue(harness::Ctx& ctx) { return ctx.Redis.LRange("audit:signing_queue", 0, -1); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  const auto [record_id, entry] = chained(1);
  const ReceiptResult signed_ = requestReceipt(record_id);
  const std::string want = "sig:t1:1:" + entry.digest.substr(0, 12);
  ctx.Assert(signed_.status == "signed" && signed_.signature == want, "with a healthy signer requestReceipt answered %s / %q, expected the signature of the record's link", signed_.status, signed_.signature);
  for (const auto& call : ctx.GRPC.CallsTo("Sign")) {
    ctx.Assert(call.HasDeadline(), "a Sign call carries no deadline: a signer that hangs holds every append open");
    ctx.Assert(0.45 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.55, "a Sign call carries a %v s deadline, expected 0.5 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Sign", 2.0);
  const std::string other = chained(2).first;
  const size_t before = ctx.GRPC.CallsTo("Sign").size();
  const ReceiptResult slow = requestReceipt(other);
  const auto calls = ctx.GRPC.CallsTo("Sign");
  for (size_t i = before; i < calls.size(); i++) {
    ctx.Assert(calls[i].HasDeadline() && calls[i].TimeoutSeconds() <= 0.55, "against a signer that takes 2 s an attempt carried a %v s deadline, expected 0.5 s", calls[i].TimeoutSeconds());
  }
  ctx.Equal(calls.size() - before, kMaxAttempts, "against a signer that takes 2 s, the attempts (expected kMaxAttempts)");
  ctx.Equal(slow.status, "unsigned", "three attempts that hit the deadline; the status");
}

void CheckTransientOnly(harness::Ctx& ctx) {
  client(ctx);
  const std::string record_id = chained(1).first;
  ctx.GRPC.Fail("Sign", grpc::StatusCode::PERMISSION_DENIED, "key k-2026 is revoked", 1);
  bool refused = false;
  std::string answered;
  try {
    answered = requestReceipt(record_id).status;
  } catch (const ReceiptRefused&) {
    refused = true;
  }
  ctx.Assert(refused, "a PERMISSION_DENIED from the signer was answered %q: a revoked key is not a blip, requestReceipt must throw ReceiptRefused", answered);
  const size_t calls = ctx.GRPC.CallsTo("Sign").size();
  ctx.Equal(calls, 1, "a PERMISSION_DENIED must not be retried; the Sign calls");
  ctx.Equal(signingQueue(ctx), {record_id}, "a refused record must wait in audit:signing_queue");
  const std::string other = chained(2).first;
  ctx.GRPC.Fail("Sign", grpc::StatusCode::UNAVAILABLE, "signer restarting", 1);
  ctx.GRPC.Fail("Sign", grpc::StatusCode::DEADLINE_EXCEEDED, "", 1);
  const ReceiptResult retried = requestReceipt(other);
  ctx.Equal(retried.status, "signed", "after one UNAVAILABLE and one DEADLINE_EXCEEDED the third attempt must sign the record; the status");
  ctx.Equal(ctx.GRPC.CallsTo("Sign").size(), calls + 3, "the transient failures and the success; the Sign calls");
}

void CheckUnsignedQueue(harness::Ctx& ctx) {
  client(ctx);
  const std::string record_id = chained(1).first;
  ctx.GRPC.Fail("Sign", grpc::StatusCode::UNAVAILABLE, "signer down", 3);
  const ReceiptResult answer = requestReceipt(record_id);
  ctx.Assert(answer.status == "unsigned" && answer.signature.empty(), "with the signer down for every attempt requestReceipt answered %s / %q, expected unsigned with no signature", answer.status, answer.signature);
  const auto record = ledger::get(record_id);
  ctx.Equal(record->status, "unsigned", "a record the signer never signed is unsigned (signature %q); the ledger status", record->signature);
  ctx.Equal(signingQueue(ctx), {record_id}, "audit:signing_queue must hold the record for the signing worker");
}

void CheckNoStickyFailure(harness::Ctx& ctx) {
  client(ctx);
  const std::string first = chained(1).first;
  ctx.GRPC.Fail("Sign", grpc::StatusCode::UNAVAILABLE, "signer down", 3);
  requestReceipt(first);
  const size_t before = ctx.GRPC.CallsTo("Sign").size();
  const std::string second = chained(2).first;
  const ReceiptResult answer = requestReceipt(second);
  ctx.Assert(ctx.GRPC.CallsTo("Sign").size() > before, "after one record failed, the next record was never sent to the signer: a failure must not be remembered for the whole process");
  ctx.Equal(answer.status, "signed", "with the signer back, the next record's status");
  ctx.Equal(ledger::get(second)->status, "signed", "the ledger status of the record the recovered signer signed");
}
`,
  },
  hints: [
    'Give the signer two seconds of latency: the append waits the full two seconds per attempt. Revoke the key: three calls go out anyway. Take the signer down: the record says signed with an empty signature, and the next healthy record is never sent.',
    'The call has no deadline, the `except` treats every code alike, the fallback writes an empty receipt through `set_receipt`, and `signer_down` turns one record\u2019s failure into a state of the whole process.',
    'Pass `timeout=DEADLINE_S` (0.5); `continue` only on `UNAVAILABLE`/`DEADLINE_EXCEEDED`, otherwise `queue_unsigned` and raise `ReceiptRefused`; after the loop `queue_unsigned` and answer `unsigned`; delete `signer_down`.',
  ],
  debrief: `The status code carries the decision: \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` say nothing about the record, so another attempt is worth its 500 ms, while \`PERMISSION_DENIED\` will answer the same way every time and belongs in front of an operator. The per-attempt deadline is what bounds the append at 1.5 s instead of at the signer's mood. \`unsigned\` with a queue entry is a state the trail can repair later; \`signed\` with an empty signature is a claim it can never take back. Production signers keep keys in an HSM or a cloud KMS (AWS KMS \`Sign\`, for example), sign batches or Merkle roots rather than single records, and the queue worker retries with backoff and alerts on age.`,
};
