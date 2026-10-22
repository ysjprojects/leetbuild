import type {Step} from '@/lib/types';

export const mergeClientStep: Step = {
  id: 'dependency',
  concept: 'grpc',
  file: 'client',
  title: 'Merge calls that surface conflicts instead of picking winners',
  focus: ['sync', 'merger', 'revisions'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the merge service,
returns a merged body on success and always returns *something* on failure, so the client never
shows an error. Two of those three properties are wrong. Find them, fix them, and prove the fix.

Implement the three-way merge client that the push path uses for a document both devices edited:

- The merge runs over gRPC as \`ThreeWayMerge(doc_id, base_revision, local_revision, remote_revision)\`
  with a **2-second deadline** per attempt. A merge that has not answered in two seconds is a failed
  merge, not a request to hold the push open.
- At most **two attempts**, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried: those are
  the failures where trying again can produce a different answer.
- **A rejection is terminal.** \`FAILED_PRECONDITION\` means the service has decided these three
  revisions are not mergeable; retrying it forever burns the push worker and returns nothing.
- **A failed merge marks the document conflicted** and retains **both** revisions — the local one
  and the remote one — for the user to resolve. There is no winner.
- **No failure path may overwrite either side** with a last-write-wins pick on upload time. Silently
  choosing the newer upload is how a day of work disappears while the sync reports success.

**Failure mode the checks target.** The draft has no deadline, so a hung merge service holds every
push open; it retries every failure forever, including the rejections that are terminal by design;
and when the call finally fails it resolves the conflict by comparing upload times, discarding the
losing edit without telling anyone. The user sees a synced document; the other edit is gone.`,
  sequence: {
    participants: ['Sync Engine', 'Merge service', 'revisions'],
    messages: [
      {from: 'Sync Engine', to: 'Merge service', label: 'ThreeWayMerge · deadline 2 s', kind: 'sync'},
      {from: 'Merge service', to: 'Sync Engine', label: 'OK {revision, body}', kind: 'reply'},
      {from: 'Merge service', to: 'Sync Engine', label: 'UNAVAILABLE / DEADLINE_EXCEEDED → one retry', kind: 'reply'},
      {from: 'Merge service', to: 'Sync Engine', label: 'FAILED_PRECONDITION → terminal', kind: 'reply'},
      {from: 'Sync Engine', to: 'revisions', label: 'record conflicted(base, local, remote)', kind: 'sync'},
      {
        from: 'revisions',
        to: 'Sync Engine',
        label: 'conflicted document · both revisions retained',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every merge attempt carries a 2-second deadline',
      detail:
        'The call is created with a 2 s deadline — `timeout=MERGE_DEADLINE_S`, `deadline: Date.now() + MERGE_DEADLINE_MS`, a context with timeout, `withDeadlineAfter` or `set_deadline`. The draft has no deadline, so one stuck merge holds the push open.',
      match: {
        python: {all: [/MERGE_DEADLINE_S\s*=\s*2\.0/, /timeout=MERGE_DEADLINE_S/]},
        typescript: {all: [/MERGE_DEADLINE_MS\s*=\s*2000/, /deadline:\s*Date\.now\(\)\s*\+\s*MERGE_DEADLINE_MS/]},
        go: {all: [/mergeDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\(ctx, mergeDeadline\)/]},
        scala: {all: [/MergeDeadlineMs\s*=\s*2000/, /withDeadlineAfter\(/]},
        cpp: {all: [/kMergeDeadlineMs\s*=\s*2000/, /set_deadline\(/]},
      },
    },
    {
      id: 'bounded-retries',
      title: 'At most two attempts, only the two retryable codes',
      detail:
        'Attempts are bounded by `MAX_MERGE_ATTEMPTS = 2` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; there is no unbounded retry loop. The draft retries every failure forever.',
      match: {
        python: {
          all: [
            /MAX_MERGE_ATTEMPTS\s*=\s*2/,
            /range\(MAX_MERGE_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [
            /MAX_MERGE_ATTEMPTS\s*=\s*2/,
            /attempt\s*<\s*MAX_MERGE_ATTEMPTS/,
            /grpc\.status\.UNAVAILABLE/,
            /grpc\.status\.DEADLINE_EXCEEDED/,
          ],
          none: [/for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [
            /maxMergeAttempts\s*=\s*2/,
            /attempt\s*<\s*maxMergeAttempts/,
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
          ],
          none: [/for\s*\{/],
        },
        scala: {
          all: [/MaxMergeAttempts\s*=\s*2/, /attempt\s*<\s*MaxMergeAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kMaxMergeAttempts\s*=\s*2/,
            /attempt\s*<\s*kMaxMergeAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'rejection-terminal',
      title: 'A merge rejection is terminal',
      detail:
        '`FAILED_PRECONDITION` — the service’s "these revisions are not mergeable" — stops the retry loop instead of being retried. The draft treats every failure as retryable and loops forever on a rejection.',
      match: {
        python: {all: [/REJECTED\s*=\s*grpc\.StatusCode\.FAILED_PRECONDITION/, /error\.code\(\)\s*==\s*REJECTED/]},
        typescript: {all: [/REJECTED\s*=\s*grpc\.status\.FAILED_PRECONDITION/, /code === REJECTED/]},
        go: {all: [/rejectedStatus\s*=\s*codes\.FailedPrecondition/, /code == rejectedStatus/]},
        scala: {all: [/Rejected\s*=\s*Status\.Code\.FAILED_PRECONDITION/, /code == Rejected/]},
        cpp: {all: [/kRejected\s*=\s*grpc::StatusCode::FAILED_PRECONDITION/, /error_code\(\)\s*==\s*kRejected/]},
      },
    },
    {
      id: 'conflicted-retains-both',
      title: 'A failed merge keeps both revisions',
      detail:
        'The failure path records a conflicted document that carries the local **and** the remote revision; nothing is discarded. The draft returns the winner it picked and never records a conflict.',
      match: {
        python: {all: [/def conflicted\(/, /"conflicted"/, /\blocal\b/, /\bremote\b/]},
        typescript: {all: [/function conflicted\(/, /'conflicted'/, /local, remote/]},
        go: {all: [/func conflicted\(/, /"conflicted"/, /Local: local/, /Remote: remote/]},
        scala: {all: [/def conflicted\(/, /"conflicted"/, /localRevision = local/, /remoteRevision = remote/]},
        cpp: {all: [/MergeOutcome conflicted\(/, /"conflicted"/, /outcome\.local = local/, /outcome\.remote = remote/]},
      },
    },
    {
      id: 'no-last-write-wins',
      title: 'No failure path resolves by upload time',
      detail:
        'Nothing in the client compares upload times to pick a side: a merge failure is a conflict, not a winner. The draft compares `uploaded_at` and silently drops the losing edit.',
      match: {
        python: {all: [/conflicted\(/], none: [/uploaded_at/]},
        typescript: {all: [/conflicted\(/], none: [/uploaded_at/]},
        go: {all: [/conflicted\(/], none: [/UploadedAt/]},
        scala: {all: [/conflicted\(/], none: [/uploadedAt/]},
        cpp: {all: [/conflicted\(/], none: [/uploadedAt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import merge_pb2
import merge_pb2_grpc

stub = merge_pb2_grpc.MergeServiceStub(grpc.insecure_channel("merger:9000"))


def three_way_merge(doc_id: str, base: dict, local: dict, remote: dict) -> dict:
    # TODO: call the merge service with a 2-second deadline, bound the attempts and retry only
    # UNAVAILABLE / DEADLINE_EXCEEDED, treat a rejection as terminal, and stop resolving a failure
    # by last-write-wins on upload time.
    request = merge_pb2.MergeRequest(
        doc_id=doc_id,
        base_revision=base["revision"],
        local_revision=local["revision"],
        remote_revision=remote["revision"],
    )
    while True:
        try:
            reply = stub.ThreeWayMerge(request)
            return {"status": "merged", "revision": reply.revision, "body": reply.body}
        except grpc.RpcError:
            if local["uploaded_at"] > remote["uploaded_at"]:
                return {"status": "merged", "revision": local["revision"], "body": local["body"]}
            return {"status": "merged", "revision": remote["revision"], "body": remote["body"]}
`,
      solution: `import grpc

import merge_pb2
import merge_pb2_grpc

MERGE_DEADLINE_S = 2.0
MAX_MERGE_ATTEMPTS = 2
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
REJECTED = grpc.StatusCode.FAILED_PRECONDITION

stub = merge_pb2_grpc.MergeServiceStub(grpc.insecure_channel("merger:9000"))


def conflicted(doc_id: str, base_revision: int, local: dict, remote: dict) -> dict:
    """A conflicted document keeps both revisions: the user resolves it, not the server."""
    return {
        "status": "conflicted",
        "doc_id": doc_id,
        "base_revision": base_revision,
        "local": local,
        "remote": remote,
    }


def record_conflict(doc_id: str, outcome: dict) -> None:
    """Persist the conflict so both devices can fetch it and let the user resolve it."""
    raise NotImplementedError


def three_way_merge(doc_id: str, base: dict, local: dict, remote: dict) -> dict:
    request = merge_pb2.MergeRequest(
        doc_id=doc_id,
        base_revision=base["revision"],
        local_revision=local["revision"],
        remote_revision=remote["revision"],
    )
    for _ in range(MAX_MERGE_ATTEMPTS):
        try:
            reply = stub.ThreeWayMerge(request, timeout=MERGE_DEADLINE_S)
            return {"status": "merged", "revision": reply.revision, "body": reply.body}
        except grpc.RpcError as error:
            if error.code() == REJECTED:
                # Terminal: these revisions are not mergeable, and a retry cannot change that.
                break
            if error.code() not in RETRYABLE:
                break
    outcome = conflicted(doc_id, base["revision"], local, remote)
    record_conflict(doc_id, outcome)
    return outcome
`,
    },
    typescript: {
      starter: `/** Three-way merge: a model-generated draft that picks a winner when the call fails. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface MergeClient {
  ThreeWayMerge(
    request: {doc_id: string; base_revision: number; local_revision: number; remote_revision: number},
    callback: (error: grpc.ServiceError | null, reply: {revision: number; body: string}) => void,
  ): grpc.ClientUnaryCall;
}

const {merge} = grpc.loadPackageDefinition(protoLoader.loadSync('merge.proto')) as unknown as {
  merge: {MergeService: new (target: string, credentials: grpc.ChannelCredentials) => MergeClient};
};
const merger = new merge.MergeService('merger:9000', grpc.credentials.createInsecure());

interface Revision {
  revision: number;
  body: string;
  uploaded_at: number;
}

function mergeOnce(docId: string, base: number, local: Revision, remote: Revision) {
  return new Promise<{revision: number; body: string}>((resolve, reject) => {
    merger.ThreeWayMerge(
      {
        doc_id: docId,
        base_revision: base,
        local_revision: local.revision,
        remote_revision: remote.revision,
      },
      (error, reply) => (error === null ? resolve(reply) : reject(error)),
    );
  });
}

export async function threeWayMerge(docId: string, base: number, local: Revision, remote: Revision) {
  // TODO: call the merge service with a 2-second deadline, bound the attempts and retry only
  // UNAVAILABLE / DEADLINE_EXCEEDED, treat a rejection as terminal, and stop resolving a failure
  // by last-write-wins on upload time.
  for (;;) {
    try {
      const reply = await mergeOnce(docId, base, local, remote);
      return {status: 'merged', revision: reply.revision, body: reply.body};
    } catch {
      return local.uploaded_at > remote.uploaded_at
        ? {status: 'merged', revision: local.revision, body: local.body}
        : {status: 'merged', revision: remote.revision, body: remote.body};
    }
  }
}
`,
      solution: `/** Three-way merge: 2 s deadline, two attempts, terminal rejection, conflicts that keep both sides. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const MERGE_DEADLINE_MS = 2000;
const MAX_MERGE_ATTEMPTS = 2;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};
const REJECTED = grpc.status.FAILED_PRECONDITION;

interface MergeClient {
  ThreeWayMerge(
    request: {doc_id: string; base_revision: number; local_revision: number; remote_revision: number},
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: {revision: number; body: string}) => void,
  ): grpc.ClientUnaryCall;
}

const {merge} = grpc.loadPackageDefinition(protoLoader.loadSync('merge.proto')) as unknown as {
  merge: {MergeService: new (target: string, credentials: grpc.ChannelCredentials) => MergeClient};
};
const merger = new merge.MergeService('merger:9000', grpc.credentials.createInsecure());

interface Revision {
  revision: number;
  body: string;
}

interface MergeOutcome {
  status: string;
  doc_id: string;
  base_revision: number;
  local: Revision;
  remote: Revision;
}

function mergeOnce(docId: string, base: number, local: Revision, remote: Revision) {
  return new Promise<{revision: number; body: string}>((resolve, reject) => {
    merger.ThreeWayMerge(
      {
        doc_id: docId,
        base_revision: base,
        local_revision: local.revision,
        remote_revision: remote.revision,
      },
      {deadline: Date.now() + MERGE_DEADLINE_MS},
      (error, reply) => (error === null ? resolve(reply) : reject(error)),
    );
  });
}

function conflicted(docId: string, baseRevision: number, local: Revision, remote: Revision): MergeOutcome {
  // Both revisions are retained: a merge failure is a conflict for the user, never a winner.
  return {status: 'conflicted', doc_id: docId, base_revision: baseRevision, local, remote};
}

export async function threeWayMerge(
  docId: string,
  base: number,
  local: Revision,
  remote: Revision,
): Promise<MergeOutcome> {
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt += 1) {
    try {
      const reply = await mergeOnce(docId, base, local, remote);
      return {
        status: 'merged',
        doc_id: docId,
        base_revision: base,
        local: {revision: reply.revision, body: reply.body},
        remote,
      };
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (code === REJECTED) break;
      if (RETRYABLE[code] !== true) break;
    }
  }
  return conflicted(docId, base, local, remote);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
)

var merger pb.MergeServiceClient

type Revision struct {
	Revision   int64
	Body       string
	UploadedAt time.Time
}

type MergeOutcome struct {
	Status string
	Body   string
}

func threeWayMerge(ctx context.Context, docID string, base int64, local, remote Revision) MergeOutcome {
	// TODO: call the merge service with a 2-second deadline, bound the attempts and retry only
	// UNAVAILABLE / DEADLINE_EXCEEDED, treat a rejection as terminal, and stop resolving a failure
	// by last-write-wins on upload time.
	request := &pb.MergeRequest{
		DocId:          docID,
		BaseRevision:   base,
		LocalRevision:  local.Revision,
		RemoteRevision: remote.Revision,
	}
	for {
		reply, err := merger.ThreeWayMerge(ctx, request)
		if err == nil {
			return MergeOutcome{Status: "merged", Body: reply.Body}
		}
		if local.UploadedAt.After(remote.UploadedAt) {
			return MergeOutcome{Status: "merged", Body: local.Body}
		}
		return MergeOutcome{Status: "merged", Body: remote.Body}
	}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	mergeDeadline    = 2 * time.Second
	maxMergeAttempts = 2
)

var (
	merger = pb.MergeServiceClient(nil)

	rejectedStatus = codes.FailedPrecondition

	retryableStatus = map[codes.Code]bool{
		codes.Unavailable:      true,
		codes.DeadlineExceeded: true,
	}
)

type Revision struct {
	Revision int64
	Body     string
}

type MergeOutcome struct {
	Status       string
	DocID        string
	BaseRevision int64
	Local        Revision
	Remote       Revision
}

// conflicted records a conflicted document. Both revisions are retained: the user resolves the
// conflict, the server never picks a winner.
func conflicted(docID string, baseRevision int64, local, remote Revision) MergeOutcome {
	return MergeOutcome{Status: "conflicted", DocID: docID, BaseRevision: baseRevision, Local: local, Remote: remote}
}

func recordConflict(ctx context.Context, outcome MergeOutcome) error {
	return nil
}

func threeWayMerge(ctx context.Context, docID string, base int64, local, remote Revision) (MergeOutcome, error) {
	request := &pb.MergeRequest{
		DocId:          docID,
		BaseRevision:   base,
		LocalRevision:  local.Revision,
		RemoteRevision: remote.Revision,
	}
	for attempt := 0; attempt < maxMergeAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, mergeDeadline)
		reply, err := merger.ThreeWayMerge(callCtx, request)
		cancel()
		if err == nil {
			return MergeOutcome{
				Status:       "merged",
				DocID:        docID,
				BaseRevision: base,
				Local:        Revision{Revision: reply.Revision, Body: reply.Body},
				Remote:       remote,
			}, nil
		}
		code := status.Code(err)
		if code == rejectedStatus {
			// Terminal: the revisions are not mergeable, and a retry cannot change the answer.
			break
		}
		if !retryableStatus[code] {
			break
		}
	}
	outcome := conflicted(docID, base, local, remote)
	if err := recordConflict(ctx, outcome); err != nil {
		return outcome, err
	}
	return outcome, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

final case class Revision(revision: Long, body: String, uploadedAt: Long)
final case class MergeOutcome(status: String, body: String)

object MergeClient {
  val stub =
    MergeServiceGrpc.blockingStub(ManagedChannelBuilder.forAddress("merger", 9000).usePlaintext().build())

  def threeWayMerge(docId: String, base: Long, local: Revision, remote: Revision): MergeOutcome = {
    // TODO: call the merge service with a 2-second deadline, bound the attempts and retry only
    // UNAVAILABLE / DEADLINE_EXCEEDED, treat a rejection as terminal, and stop resolving a failure
    // by last-write-wins on upload time.
    val request = MergeRequest(docId, base, local.revision, remote.revision)
    while (true) {
      try {
        val reply = stub.threeWayMerge(request)
        return MergeOutcome("merged", reply.body)
      } catch {
        case _: io.grpc.StatusRuntimeException =>
          if (local.uploadedAt > remote.uploadedAt) return MergeOutcome("merged", local.body)
          return MergeOutcome("merged", remote.body)
      }
    }
    MergeOutcome("merged", local.body)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import io.grpc.Status
import io.grpc.StatusRuntimeException

final case class Revision(revision: Long, body: String)
final case class MergeOutcome(
  status: String,
  docId: String,
  baseRevision: Long,
  localRevision: Revision,
  remoteRevision: Revision,
)

object MergeClient {
  val MergeDeadlineMs = 2000
  val MaxMergeAttempts = 2
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val Rejected = Status.Code.FAILED_PRECONDITION

  val stub =
    MergeServiceGrpc.blockingStub(ManagedChannelBuilder.forAddress("merger", 9000).usePlaintext().build())

  def conflicted(docId: String, baseRevision: Long, local: Revision, remote: Revision): MergeOutcome =
    MergeOutcome(
      status = "conflicted",
      docId = docId,
      baseRevision = baseRevision,
      localRevision = local,
      remoteRevision = remote,
    )

  def recordConflict(docId: String, outcome: MergeOutcome): Unit = ()

  def threeWayMerge(docId: String, base: Long, local: Revision, remote: Revision): MergeOutcome = {
    val request = MergeRequest(docId, base, local.revision, remote.revision)
    var attempt = 0
    var terminal = false
    while (attempt < MaxMergeAttempts && !terminal) {
      attempt += 1
      try {
        val reply =
          stub.withDeadlineAfter(MergeDeadlineMs, TimeUnit.MILLISECONDS).threeWayMerge(request)
        return MergeOutcome("merged", docId, base, Revision(reply.revision, reply.body), remote)
      } catch {
        case error: StatusRuntimeException =>
          val code = error.getStatus.getCode
          // A rejection is terminal: these revisions are not mergeable and a retry cannot help.
          terminal = code == Rejected || !Retryable.contains(code)
      }
    }
    val outcome = conflicted(docId, base, localRevision = local, remoteRevision = remote)
    recordConflict(docId, outcome)
    outcome
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "merge.grpc.pb.h"

#include <chrono>
#include <memory>
#include <string>

struct Revision {
  long long revision;
  std::string body;
  long long uploadedAt;
};

struct MergeOutcome {
  std::string status;
  std::string body;
};

std::unique_ptr<MergeService::Stub> merger;

MergeOutcome threeWayMerge(
    const std::string& docId,
    long long base,
    const Revision& local,
    const Revision& remote) {
  // TODO: call the merge service with a 2-second deadline, bound the attempts and retry only
  // UNAVAILABLE / DEADLINE_EXCEEDED, treat a rejection as terminal, and stop resolving a failure
  // by last-write-wins on upload time.
  MergeRequest request;
  request.set_doc_id(docId);
  request.set_base_revision(base);
  request.set_local_revision(local.revision);
  request.set_remote_revision(remote.revision);
  while (true) {
    grpc::ClientContext ctx;
    MergeReply reply;
    const grpc::Status status = merger->ThreeWayMerge(&ctx, request, &reply);
    if (status.ok()) return MergeOutcome{"merged", reply.body()};
    if (local.uploadedAt > remote.uploadedAt) return MergeOutcome{"merged", local.body};
    return MergeOutcome{"merged", remote.body};
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "merge.grpc.pb.h"

#include <chrono>
#include <memory>
#include <string>

constexpr int kMergeDeadlineMs = 2000;
constexpr int kMaxMergeAttempts = 2;
constexpr grpc::StatusCode kRejected = grpc::StatusCode::FAILED_PRECONDITION;

struct Revision {
  long long revision;
  std::string body;
};

struct MergeOutcome {
  std::string status;
  std::string docId;
  long long baseRevision;
  Revision local;
  Revision remote;
};

std::unique_ptr<MergeService::Stub> merger;

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

// Both revisions are retained: the user resolves the conflict, the server never picks a winner.
MergeOutcome conflicted(const std::string& docId, long long baseRevision, const Revision& local, const Revision& remote) {
  MergeOutcome outcome;
  outcome.status = "conflicted";
  outcome.docId = docId;
  outcome.baseRevision = baseRevision;
  outcome.local = local;
  outcome.remote = remote;
  return outcome;
}

void recordConflict(const std::string& docId, const MergeOutcome& outcome);

MergeOutcome threeWayMerge(
    const std::string& docId,
    long long base,
    const Revision& local,
    const Revision& remote) {
  MergeRequest request;
  request.set_doc_id(docId);
  request.set_base_revision(base);
  request.set_local_revision(local.revision);
  request.set_remote_revision(remote.revision);
  for (int attempt = 0; attempt < kMaxMergeAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kMergeDeadlineMs));
    MergeReply reply;
    const grpc::Status status = merger->ThreeWayMerge(&ctx, request, &reply);
    if (status.ok()) {
      return MergeOutcome{"merged", docId, base, Revision{reply.revision(), reply.body()}, remote};
    }
    if (status.error_code() == kRejected) {
      // Terminal: these revisions are not mergeable, and a retry cannot change that.
      break;
    }
    if (!retryable(status.error_code())) break;
  }
  const auto outcome = conflicted(docId, base, local, remote);
  recordConflict(docId, outcome);
  return outcome;
}
`,
    },
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `{deadline: Date.now() + …}`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`). Wrapping the call in a timeout changes nothing; the transport has to know the budget.',
    'Retryability is a property of the status, not of "it threw". Capture the error, compare its code against `UNAVAILABLE` / `DEADLINE_EXCEEDED`, and stop the loop for `FAILED_PRECONDITION` — that code means the service already decided these revisions cannot be merged.',
    "A conflict is a value, not an exception: build the conflicted record with both revisions in it, persist it, and return it to the caller. If you find yourself comparing two timestamps, you are about to delete a user's work — the timestamp is only useful for showing the user which edit is newer, never for choosing which one survives.",
  ],
  debrief: `The interview question is "what does a merge failure mean?" A generated client usually answers "somebody wins", because that keeps the happy path linear. But an infrastructure failure is not a merge decision: turning a timeout into last-write-wins converts a retryable dependency problem into permanent data loss, and it does so silently, with the sync reporting success. Three separate contracts are being checked. The deadline: an unbounded merge call holds a push worker and the device's connection for as long as the dependency is slow. The retry policy: \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` may succeed on a retry; \`FAILED_PRECONDITION\` is a decision, and a rejection loop burns the worker for nothing. The failure path: a conflicted document that carries both revisions is the only honest answer, and it is also what makes the user experience possible — show both, let a person choose or retype. Real systems add merge-service-side operation logs for text, a conflict inbox, and a policy for auto-merging the non-overlapping cases while still surfacing the overlapping ones.`,
};
