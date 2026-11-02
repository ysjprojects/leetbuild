import type {Step} from '@/lib/types';

export const mergeClientStep: Step = {
  id: 'dependency',
  concept: 'grpc',
  file: 'client',
  title: 'Merge calls that surface conflicts instead of picking winners',
  focus: ['sync', 'merger', 'revisions'],
  task: `## Task

**Starting point.** The starter's \`three_way_merge\` builds a \`MergeRequest\`, calls the merge
service in a \`while True\` loop with no deadline, returns the merged body on success and, when the
call raises, returns whichever of local and remote has the later \`uploaded_at\`. It compiles, the
demo merge succeeds, and it hides five flaws.

**Failure mode the checks target.** The merge service hangs and every push on the box stays open
behind it. The service rejects three revisions as unmergeable and the client asks again, forever.
When a call finally fails, the client picks the newer upload and the other edit vanishes while the
user sees a synced document.

Requirements:

- The merge runs over gRPC as \`ThreeWayMerge(doc_id, base_revision, local_revision, remote_revision)\`
  with a **2-second deadline** per attempt (\`MERGE_DEADLINE_S\`). A merge that has not answered in
  two seconds is a failed merge, not a request to hold the push open.
- At most **two attempts** (\`MAX_MERGE_ATTEMPTS\`), and only \`UNAVAILABLE\` and
  \`DEADLINE_EXCEEDED\` are retried: those are the failures where trying again can change the answer.
- A rejection is terminal. \`FAILED_PRECONDITION\` (\`REJECTED\`) means the service has decided these
  revisions are not mergeable; retrying it burns the push worker and returns nothing.
- A failed merge marks the document conflicted (\`conflicted(...)\`) and retains both the local and
  the remote revision for the user to resolve. There is no winner.
- No failure path picks a side by upload time.`,
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
        'The call is created with a 2 s deadline: `timeout=MERGE_DEADLINE_S`, `deadline: Date.now() + MERGE_DEADLINE_MS`, a context with timeout, `withDeadlineAfter` or `set_deadline`. The starter has no deadline, so one stuck merge holds the push open.',
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
        'Attempts are bounded by `MAX_MERGE_ATTEMPTS = 2` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; there is no unbounded retry loop. The starter retries every failure forever.',
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
        '`FAILED_PRECONDITION`, the service’s "these revisions are not mergeable", stops the retry loop instead of being retried. The starter treats every failure as retryable and loops forever on a rejection.',
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
        'The failure path records a conflicted document that carries the local **and** the remote revision; nothing is discarded. The starter returns the winner it picked and never records a conflict.',
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
        'Nothing in the client compares upload times to pick a side: a merge failure is a conflict, not a winner. The starter compares `uploaded_at` and silently drops the losing edit.',
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
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Three-way merge: flawed code that picks a winner when the call fails. */
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    'Two people edit one document; the merge service is down for a minute; both phones say "synced" and one of them has lost its paragraph. Meanwhile push latency on the box climbs to minutes.',
    'The call has no deadline, so a hung merge holds the push. `while True` retries every `RpcError`, including a terminal `FAILED_PRECONDITION`. The `except` branch compares `uploaded_at` and returns a winner as "merged".',
    'Call with `timeout=MERGE_DEADLINE_S`, loop `for attempt in range(MAX_MERGE_ATTEMPTS)`, retry only `UNAVAILABLE`/`DEADLINE_EXCEEDED`, break on `REJECTED`, and on failure return `conflicted(doc_id, local, remote)`.',
  ],
  debrief: `The fix separates two things the starter conflated: a transport failure and a merge decision. A deadline and a bounded retry handle the transport, and only the codes where a second attempt can change the answer are retried; \`FAILED_PRECONDITION\` is the service's verdict and asking again cannot change it. The failure path then becomes a value rather than a guess: a conflicted record carrying both revisions, persisted and returned, so a person can choose. Comparing upload times looked like resilience but turned a retryable outage into silent data loss with the sync reporting success.

Production merge clients add a conflict inbox the user can see, an operation log on the merge service for text so non-overlapping edits merge automatically, and a circuit breaker so a dead merger fails fast instead of spending its two seconds on every document.`,
};
