import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Receipt signing that queues instead of skipping',
  concept: 'grpc',
  file: 'client',
  focus: ['auditd', 'signer', 'queue'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the signer, catches
errors and returns a record. It compiles, the happy path signs every record, and it hides three
flaws that only matter on the day the signer is down. Review it, fix it, and prove the fix.

Implement the receipt client that every append goes through:

- Call the signing service over gRPC with a **500 ms** deadline on every attempt, and at most
  \`MAX_ATTEMPTS = 2\` attempts, so one record can never hold the append path open.
- Retry **only** \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`. A key-not-found is not a transient
  failure: the draft loops on \`NOT_FOUND\` until its own 30-second budget runs out, which turns a
  permanent configuration error into an outage.
- A **permanent** error (\`PERMISSION_DENIED\`, for example) is surfaced to operators — reported and
  \`raise\`/\`throw\`n — never silently swallowed.
- On an exhausted retry window the record is marked \`unsigned\` and written to the
  \`audit:signing_queue\` so a background worker can sign it later. The draft drops the receipt on
  error and marks the record **verified** anyway, so the trail claims a signature it never had.
- Never cache a signing failure globally. The draft flips one process-wide flag on the first error,
  so every later record — for every tenant — is silently skipped.
- Return \`{"record_id", "receipt", "status"}\` where \`status\` is \`signed\` or \`unsigned\`.

**Failure mode the checks target.** Failure handling on an evidence path. "Unsigned" is a legitimate
state that can be repaired; "verified but unsigned" is a lie the trail cannot walk back, and a
global failure flag turns one tenant’s transient error into everyone’s permanent one.`,
  sequence: {
    participants: ['Audit Service', 'Receipt signer', 'Signing queue'],
    messages: [
      {from: 'Audit Service', to: 'Receipt signer', label: 'Sign(record_id, digest) · 500 ms deadline', kind: 'sync'},
      {from: 'Receipt signer', to: 'Audit Service', label: 'receipt.signature', kind: 'reply'},
      {
        from: 'Audit Service',
        to: 'Receipt signer',
        label: 'UNAVAILABLE or DEADLINE_EXCEEDED → retry once',
        kind: 'sync',
      },
      {
        from: 'Receipt signer',
        to: 'Audit Service',
        label: 'PERMISSION_DENIED → surface to operators, no retry',
        kind: 'reply',
      },
      {
        from: 'Audit Service',
        to: 'Signing queue',
        label: 'window exhausted → enqueue an unsigned record',
        kind: 'async',
      },
      {from: 'Audit Service', to: 'Audit Service', label: 'status = unsigned (never verified)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'One 500 ms deadline per signing attempt',
      detail:
        'Each `Sign` call carries a **500** ms deadline. The draft has a single 30-second budget with no per-attempt deadline, so one hung signer stalls the append path.',
      match: {
        python: {all: [/500/, /timeout|deadline/i]},
        typescript: {all: [/500/, /deadline|timeout/i]},
        go: {all: [/500/, /Deadline|Timeout/]},
        scala: {all: [/500/, /Deadline|Timeout/]},
        cpp: {all: [/500/, /deadline|timeout/i]},
      },
    },
    {
      id: 'unsigned-queue',
      title: 'A failed receipt queues the record as unsigned',
      detail:
        'When the retry window is exhausted the record is marked `unsigned` and written to the `signing_queue` for a later worker. The draft marks it verified and drops the receipt.',
      match: {
        python: {all: [/unsigned/, /signing_queue/]},
        typescript: {all: [/unsigned/, /signing_queue/]},
        go: {all: [/unsigned/, /signing_queue/]},
        scala: {all: [/unsigned/, /signing_queue/]},
        cpp: {all: [/unsigned/, /signing_queue/]},
      },
    },
    {
      id: 'retryable-only',
      title: 'Only UNAVAILABLE and DEADLINE_EXCEEDED are retried',
      detail:
        'The retry set is the transient pair; a permanent code stops immediately. The draft retries `NOT_FOUND` until its budget runs out, so a misconfiguration looks like an outage.',
      match: {
        python: {all: [/UNAVAILABLE/], none: [/NOT_FOUND/]},
        typescript: {all: [/UNAVAILABLE/], none: [/NOT_FOUND/]},
        go: {all: [/Unavailable/], none: [/NotFound/]},
        scala: {all: [/UNAVAILABLE/], none: [/NOT_FOUND/]},
        cpp: {all: [/UNAVAILABLE/], none: [/NOT_FOUND/]},
      },
    },
    {
      id: 'surface-permanent',
      title: 'A permanent error is surfaced to operators',
      detail:
        'A non-retryable permission failure is reported and raised, not swallowed. The draft catches every error the same way, so a broken signer credential is invisible.',
      match: {
        python: {all: [/report_permanent/, /PERMISSION_DENIED/]},
        typescript: {all: [/reportPermanent/, /PERMISSION_DENIED/]},
        go: {all: [/reportPermanent/, /PermissionDenied/]},
        scala: {all: [/reportPermanent/, /PERMISSION_DENIED/]},
        cpp: {all: [/report_permanent/, /PERMISSION_DENIED/]},
      },
    },
    {
      id: 'bounded-window',
      title: 'The retry window is bounded',
      detail:
        '`MAX_ATTEMPTS` bounds the attempts, so every record is either signed or queued within one short window. The draft loops without a bound.',
      match: {
        python: {all: [/MAX_ATTEMPTS/]},
        typescript: {all: [/MAX_ATTEMPTS/]},
        go: {all: [/MAX_ATTEMPTS/]},
        scala: {all: [/MAX_ATTEMPTS/]},
        cpp: {all: [/MAX_ATTEMPTS/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

log = logging.getLogger("auditd.signing")


def request_receipt(stub, conn, record_id: str, record_digest: str) -> dict:
    # TODO: the draft drops every error, marks the record verified anyway, retries NOT_FOUND until
    # its 30-second budget expires and caches the first failure process-wide. Give each attempt a
    # 500 ms deadline, retry only the transient codes, and queue the record as unsigned.
    deadline = time.monotonic() + 30
    global signing_down
    if signing_down:
        mark_verified(conn, record_id)
        return {"record_id": record_id, "receipt": None, "status": "ok"}
    while time.monotonic() < deadline:
        try:
            receipt = stub.Sign(SignRequest(record_id=record_id, digest=record_digest))
            return {"record_id": record_id, "receipt": receipt.signature, "status": "signed"}
        except grpc.RpcError as error:
            if error.code() == grpc.StatusCode.NOT_FOUND:
                continue  # keep asking: maybe the key appears
            signing_down = True
            mark_verified(conn, record_id)
            return {"record_id": record_id, "receipt": None, "status": "ok"}
    return {"record_id": record_id, "receipt": None, "status": "ok"}
`,
      solution: `import logging

import grpc

log = logging.getLogger("auditd.signing")

SIGNER_TIMEOUT_MS = 500  # the deadline for one signing attempt
MAX_ATTEMPTS = 2
SIGNING_QUEUE = "audit:signing_queue"
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)


def report_permanent(record_id: str, error: grpc.RpcError) -> None:
    # Operators need the record id and the code; the audit trail must never absorb this silently.
    log.error("signing rejected record=%s code=%s", record_id, error.code().name)


def enqueue_unsigned(conn, record_id: str, record_digest: str) -> None:
    conn.execute(
        "INSERT INTO " + SIGNING_QUEUE + " (record_id, digest, queued_at) VALUES (%s, %s, now())",
        (record_id, record_digest),
    )


def request_receipt(stub, conn, record_id: str, record_digest: str) -> dict:
    for _ in range(MAX_ATTEMPTS):
        try:
            receipt = stub.Sign(
                SignRequest(record_id=record_id, digest=record_digest),
                timeout=SIGNER_TIMEOUT_MS / 1000,
            )
            return {"record_id": record_id, "receipt": receipt.signature, "status": "signed"}
        except grpc.RpcError as error:
            if error.code() == grpc.StatusCode.PERMISSION_DENIED:
                report_permanent(record_id, error)
                raise
            if error.code() not in RETRYABLE:
                raise
    # The signer is down: keep the record and queue the receipt. "unsigned" is repairable;
    # "verified" without a receipt is a claim the trail can never walk back.
    enqueue_unsigned(conn, record_id, record_digest)
    return {"record_id": record_id, "receipt": None, "status": "unsigned"}
`,
    },
    typescript: {
      starter: `/** A model-generated receipt client that marks first and asks questions later. */
import * as grpc from '@grpc/grpc-js';
import {status} from '@grpc/grpc-js';

let signingDown = false;

export async function requestReceipt(
  stub: grpc.Client,
  conn: {query: (sql: string, values: unknown[]) => Promise<unknown>},
  recordId: string,
  recordDigest: string,
): Promise<Record<string, unknown>> {
  // TODO: the draft drops every error, marks the record verified anyway, retries NOT_FOUND until
  // its 30-second budget expires and caches the first failure process-wide. Give each attempt a
  // 500 ms deadline, retry only the transient codes, and queue the record as unsigned.
  const until = Date.now() + 30_000;
  if (signingDown) {
    await markVerified(conn, recordId);
    return {record_id: recordId, receipt: null, status: 'ok'};
  }
  while (Date.now() < until) {
    try {
      const receipt = await sign(stub, recordId, recordDigest);
      return {record_id: recordId, receipt: receipt.signature, status: 'signed'};
    } catch (error) {
      if ((error as grpc.ServiceError).code === status.NOT_FOUND) continue;
      signingDown = true;
      await markVerified(conn, recordId);
      return {record_id: recordId, receipt: null, status: 'ok'};
    }
  }
  return {record_id: recordId, receipt: null, status: 'ok'};
}
`,
      solution: `/** Signing is a dependency: when it fails, the receipt is queued, never assumed. */
import * as grpc from '@grpc/grpc-js';
import {status} from '@grpc/grpc-js';

const SIGNER_TIMEOUT_MS = 500; // the deadline for one signing attempt
const MAX_ATTEMPTS = 2;
const SIGNING_QUEUE = 'audit:signing_queue';
const RETRYABLE: Record<number, boolean> = {[status.UNAVAILABLE]: true, [status.DEADLINE_EXCEEDED]: true};

type Db = {query: (sql: string, values: unknown[]) => Promise<unknown>};

function reportPermanent(recordId: string, error: unknown): void {
  // Operators need the record id and the code; the audit trail must never absorb this silently.
  console.error('signing rejected record=%s', recordId, error);
}

export async function requestReceipt(
  stub: grpc.Client,
  conn: Db,
  recordId: string,
  recordDigest: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const receipt = await new Promise<{signature: string}>((resolve, reject) => {
        (stub as unknown as {Sign: Function}).Sign(
          {record_id: recordId, digest: recordDigest},
          {deadline: Date.now() + SIGNER_TIMEOUT_MS},
          (error: grpc.ServiceError | null, response: {signature: string}) =>
            error ? reject(error) : resolve(response),
        );
      });
      return {record_id: recordId, receipt: receipt.signature, status: 'signed'};
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (code === status.PERMISSION_DENIED) {
        reportPermanent(recordId, error);
        throw error;
      }
      if (!RETRYABLE[code]) throw error;
    }
  }
  // The signer is down: keep the record and queue the receipt. "unsigned" is repairable;
  // "verified" without a receipt is a claim the trail can never walk back.
  await conn.query('INSERT INTO ' + SIGNING_QUEUE + ' (record_id, digest, queued_at) VALUES ($1, $2, now())', [
    recordId,
    recordDigest,
  ]);
  return {record_id: recordId, receipt: null, status: 'unsigned'};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
)

var signingDown bool

func requestReceipt(ctx context.Context, client SignerClient, db *sql.DB, recordID, recordDigest string) (map[string]any, error) {
	// TODO: the draft drops every error, marks the record verified anyway, retries NotFound until
	// its 30-second budget expires and caches the first failure process-wide. Give each attempt a
	// 500 ms deadline, retry only the transient codes, and queue the record as unsigned.
	until := time.Now().Add(30 * time.Second)
	if signingDown {
		markVerified(ctx, db, recordID)
		return map[string]any{"record_id": recordID, "receipt": nil, "status": "ok"}, nil
	}
	for time.Now().Before(until) {
		reply, err := client.Sign(ctx, &SignRequest{RecordId: recordID, Digest: recordDigest})
		if err == nil {
			return map[string]any{"record_id": recordID, "receipt": reply.Signature, "status": "signed"}, nil
		}
		if status.Code(err) == codes.NotFound {
			continue
		}
		signingDown = true
		markVerified(ctx, db, recordID)
		return map[string]any{"record_id": recordID, "receipt": nil, "status": "ok"}, nil
	}
	log.Printf("giving up on %s", recordID)
	return map[string]any{"record_id": recordID, "receipt": nil, "status": "ok"}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	SIGNER_TIMEOUT_MS       = 500 // the deadline for one signing attempt
	MAX_ATTEMPTS            = 2
	signingQueue     string = "audit:signing_queue"
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

// reportPermanent surfaces a rejected signature: operators need the record id and the code.
func reportPermanent(recordID string, err error) {
	log.Printf("signing rejected record=%s code=%s", recordID, status.Code(err))
}

func enqueueUnsigned(ctx context.Context, db *sql.DB, recordID, recordDigest string) error {
	_, err := db.ExecContext(
		ctx,
		"INSERT INTO "+signingQueue+" (record_id, digest, queued_at) VALUES ($1, $2, now())",
		recordID, recordDigest,
	)
	return err
}

func requestReceipt(ctx context.Context, client SignerClient, db *sql.DB, recordID, recordDigest string) (map[string]any, error) {
	for attempt := 0; attempt < MAX_ATTEMPTS; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, SIGNER_TIMEOUT_MS*time.Millisecond)
		reply, err := client.Sign(callCtx, &SignRequest{RecordId: recordID, Digest: recordDigest})
		cancel()
		if err == nil {
			return map[string]any{"record_id": recordID, "receipt": reply.Signature, "status": "signed"}, nil
		}
		if status.Code(err) == codes.PermissionDenied {
			reportPermanent(recordID, err)
			return nil, err
		}
		if !retryable[status.Code(err)] {
			return nil, err
		}
	}
	// The signer is down: keep the record and queue the receipt. "unsigned" is repairable;
	// "verified" without a receipt is a claim the trail can never walk back.
	if err := enqueueUnsigned(ctx, db, recordID, recordDigest); err != nil {
		return nil, err
	}
	return map[string]any{"record_id": recordID, "receipt": nil, "status": "unsigned"}, nil
}
`,
    },
    scala: {
      starter: `import scala.util.{Failure, Success, Try}

import io.grpc.{Status, StatusRuntimeException}

object ReceiptClient {
  var signingDown = false

  // TODO: the draft drops every error, marks the record verified anyway, retries NOT_FOUND until
  // its 30-second budget expires and caches the first failure process-wide. Give each attempt a
  // 500 ms deadline, retry only the transient codes, and queue the record as unsigned.
  def requestReceipt(conn: java.sql.Connection, recordId: String, recordDigest: String, stub: SignerStub): Map[String, Any] = {
    val until = System.currentTimeMillis() + 30000
    if (signingDown) {
      markVerified(conn, recordId)
      return Map("record_id" -> recordId, "receipt" -> null, "status" -> "ok")
    }
    while (System.currentTimeMillis() < until) {
      Try(stub.sign(SignRequest(recordId, recordDigest))) match {
        case Success(reply) => return Map("record_id" -> recordId, "receipt" -> reply.signature, "status" -> "signed")
        case Failure(error: StatusRuntimeException) if error.getStatus.getCode == Status.Code.NOT_FOUND => ()
        case Failure(_) =>
          signingDown = true
          markVerified(conn, recordId)
          return Map("record_id" -> recordId, "receipt" -> null, "status" -> "ok")
      }
    }
    Map("record_id" -> recordId, "receipt" -> null, "status" -> "ok")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.{Failure, Success, Try}

import io.grpc.{Status, StatusRuntimeException}

object ReceiptClient {
  val SIGNER_TIMEOUT_MS = 500 // the deadline for one signing attempt
  val MAX_ATTEMPTS = 2
  val SIGNING_QUEUE = "audit:signing_queue"

  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  /** reportPermanent surfaces a rejected signature: operators need the record id and the code. */
  def reportPermanent(recordId: String, error: StatusRuntimeException): Unit =
    System.err.println(s"signing rejected record=$recordId code=\${error.getStatus.getCode}")

  def enqueueUnsigned(conn: java.sql.Connection, recordId: String, recordDigest: String): Unit = {
    val insert = conn.prepareStatement(s"INSERT INTO $SIGNING_QUEUE (record_id, digest, queued_at) VALUES (?, ?, now())")
    insert.setString(1, recordId)
    insert.setString(2, recordDigest)
    insert.executeUpdate()
  }

  def requestReceipt(conn: java.sql.Connection, recordId: String, recordDigest: String, stub: SignerStub): Map[String, Any] = {
    var attempt = 0
    while (attempt < MAX_ATTEMPTS) {
      Try(stub.withDeadlineAfter(SIGNER_TIMEOUT_MS, TimeUnit.MILLISECONDS).sign(SignRequest(recordId, recordDigest))) match {
        case Success(reply) => return Map("record_id" -> recordId, "receipt" -> reply.signature, "status" -> "signed")
        case Failure(error: StatusRuntimeException) if error.getStatus.getCode == Status.Code.PERMISSION_DENIED =>
          reportPermanent(recordId, error)
          throw error
        case Failure(error: StatusRuntimeException) if !Retryable.contains(error.getStatus.getCode) => throw error
        case Failure(_) => attempt += 1
      }
    }
    // The signer is down: keep the record and queue the receipt. "unsigned" is repairable;
    // "verified" without a receipt is a claim the trail can never walk back.
    enqueueUnsigned(conn, recordId, recordDigest)
    Map("record_id" -> recordId, "receipt" -> null, "status" -> "unsigned")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

bool signing_down = false;

std::map<std::string, std::string> request_receipt(pqxx::work& tx, const std::string& record_id, const std::string& record_digest, Signer::Stub& stub) {
  // TODO: the draft drops every error, marks the record verified anyway, retries NOT_FOUND until
  // its 30-second budget expires and caches the first failure process-wide. Give each attempt a
  // 500 ms deadline, retry only the transient codes, and queue the record as unsigned.
  const auto until = std::chrono::system_clock::now() + std::chrono::seconds(30);
  if (signing_down) {
    mark_verified(tx, record_id);
    return {{"record_id", record_id}, {"receipt", ""}, {"status", "ok"}};
  }
  while (std::chrono::system_clock::now() < until) {
    grpc::ClientContext context;
    SignReply reply;
    const grpc::Status status = stub.Sign(&context, SignRequest{}, &reply);
    if (status.ok()) return {{"record_id", record_id}, {"receipt", reply.signature()}, {"status", "signed"}};
    if (status.error_code() == grpc::StatusCode::NOT_FOUND) continue;
    signing_down = true;
    mark_verified(tx, record_id);
    return {{"record_id", record_id}, {"receipt", ""}, {"status", "ok"}};
  }
  return {{"record_id", record_id}, {"receipt", ""}, {"status", "ok"}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <map>
#include <string>
#include <vector>

constexpr int SIGNER_TIMEOUT_MS = 500; // the deadline for one signing attempt
constexpr int MAX_ATTEMPTS = 2;
const std::string kSigningQueue = "audit:signing_queue";

const std::vector<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

// report_permanent surfaces a rejected signature: operators need the record id and the code.
void report_permanent(const std::string& record_id, const grpc::Status& status) {
  std::cerr << "signing rejected record=" << record_id << " code=" << status.error_code() << std::endl;
}

void enqueue_unsigned(pqxx::work& tx, const std::string& record_id, const std::string& record_digest) {
  tx.exec_params(
      "INSERT INTO " + kSigningQueue + " (record_id, digest, queued_at) VALUES ($1, $2, now())",
      record_id, record_digest);
}

nlohmann::json request_receipt(pqxx::work& tx, const std::string& record_id, const std::string& record_digest, Signer::Stub& stub) {
  for (int attempt = 0; attempt < MAX_ATTEMPTS; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(SIGNER_TIMEOUT_MS));
    SignRequest request;
    request.set_record_id(record_id);
    request.set_digest(record_digest);
    SignReply reply;
    const grpc::Status status = stub.Sign(&context, request, &reply);
    if (status.ok()) return {{"record_id", record_id}, {"receipt", reply.signature()}, {"status", "signed"}};
    if (status.error_code() == grpc::StatusCode::PERMISSION_DENIED) {
      report_permanent(record_id, status);
      throw std::runtime_error("signing rejected");
    }
    bool retryable = false;
    for (const auto code : kRetryable) retryable = retryable || status.error_code() == code;
    if (!retryable) throw std::runtime_error("signing failed: " + status.error_message());
  }
  // The signer is down: keep the record and queue the receipt. "unsigned" is repairable;
  // "verified" without a receipt is a claim the trail can never walk back.
  enqueue_unsigned(tx, record_id, record_digest);
  return {{"record_id", record_id}, {"receipt", nullptr}, {"status", "unsigned"}};
}
`,
    },
  },
  hints: [
    'Separate the three failure classes before writing any handler: transient (`UNAVAILABLE`, `DEADLINE_EXCEEDED`) → retry within a bounded window; permanent (`PERMISSION_DENIED`, `INVALID_ARGUMENT`) → report and raise; unknown → treat as permanent. `NOT_FOUND` is in the second group, and retrying it is how a missing key becomes a 30-second stall on every append.',
    'One deadline per attempt, not one for the loop. `timeout=0.5`, `{deadline: Date.now() + 500}`, `context.WithTimeout(ctx, 500*time.Millisecond)`, `withDeadlineAfter(500, MILLISECONDS)`, or `context.set_deadline(now + 500ms)` — and `MAX_ATTEMPTS = 2` above the loop so the window is bounded and observable.',
    'The honest state after a failed window is `unsigned`, written to the `signing_queue`. "Unsigned but queued" is a debt a worker repays; "verified" is a statement the record cannot support, and a process-wide failure flag makes one tenant’s bad minute into every tenant’s permanent one.',
  ],
  debrief: `The interviewer is testing failure policy on an evidence path, where the wrong default is worse than an outage. The draft optimises for "the append never fails", so it converts every signing error into a verified record — which is exactly the outcome an audit trail exists to prevent. The fix is a classification: transient errors get a short, bounded retry with a per-attempt deadline; permanent errors are surfaced because no amount of retrying will fix a credential; and exhaustion produces an explicit \`unsigned\` state with a queue row, so the gap is visible and repairable. The insidious defect is the global flag: caching one failure across all records and tenants turns a single bad minute into a silent, systemic loss of receipts. Real systems add a signing worker with exponential backoff, a receipt TTL, and an alert on the age of the oldest unsigned record.`,
};
