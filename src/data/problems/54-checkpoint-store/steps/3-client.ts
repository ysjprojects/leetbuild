import type {Step} from '@/lib/types';

export const storageClientStep: Step = {
  id: 'dependency',
  title: 'Storage calls that verify before acknowledging',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'store', 'verifier'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: against a healthy store it
writes every chunk and acknowledges it, so the demo uploads. Against a slow, corrupting or
unauthorized store it is wrong in three ways. Find them, fix them, and prove the fix with the checks
below.

Implement \`put_chunk(upload_id, index, payload)\` for the checkpoint store's object-store client:

- Every store call carries a **30-second deadline**. A call without one lets one stuck store pin the
  chunk writer for the life of the process.
- The chunk is written with \`WriteChunk\`, and it is acknowledged **only after** the store confirms
  the checksum for that chunk (\`VerifyChunk\` returns \`stored\` and a matching digest). The draft
  acknowledges as soon as the write returns and verifies later in a background pass, so corruption
  is discovered *after* a training run has already resumed from that chunk.
- The digest is computed locally (\`sha256\` of the payload) and compared with what the store
  confirms. A chunk the store cannot verify **fails the upload** — it is never acknowledged, never
  queued for a later pass.
- At most **3 attempts**, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retryable. A store that
  answers anything else is not going to answer differently because you asked again.
- \`PERMISSION_DENIED\` stops the upload immediately with a **visible reason** (\`UploadRejected\`
  carrying the status), because retrying a credential problem burns the upload window and hides an
  expired token behind a timeout.

**Failure mode the checks target.** An acknowledgment is a promise: the trainer resumes from the
last acknowledged chunk. Acknowledging before verification means the platform's promise rests on a
background pass that runs minutes later, so a corrupted chunk is already part of the model's weights.
And a retry loop that swallows \`PERMISSION_DENIED\` turns a misconfigured credential into an upload
that hangs instead of one that fails with a reason.`,
  sequence: {
    participants: ['Chunk writer', 'Object store', 'Verifier'],
    messages: [
      {from: 'Chunk writer', to: 'Chunk writer', label: 'sha256(payload) → digest', kind: 'sync'},
      {from: 'Chunk writer', to: 'Object store', label: 'WriteChunk · deadline 30 s · attempt ≤ 3', kind: 'sync'},
      {from: 'Object store', to: 'Chunk writer', label: 'ok / UNAVAILABLE / PERMISSION_DENIED', kind: 'reply'},
      {from: 'Chunk writer', to: 'Object store', label: 'VerifyChunk(upload_id, index, digest)', kind: 'sync'},
      {from: 'Object store', to: 'Chunk writer', label: 'stored · digest', kind: 'reply'},
      {from: 'Chunk writer', to: 'Verifier', label: 'acknowledged chunk only after the confirmation', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'store-deadline',
      title: 'Puts a 30-second deadline on every store call',
      detail:
        'Each `WriteChunk`/`VerifyChunk` runs under a 30-second deadline. The draft calls the store with no deadline, so one hung store pins the writer indefinitely.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS/, /deadline:/]},
        go: {all: [/storeTimeout/, /context\.WithTimeout/]},
        scala: {all: [/StoreTimeout/, /withDeadlineAfter/]},
        cpp: {all: [/kStoreTimeout/, /set_deadline/]},
      },
    },
    {
      id: 'verify-before-ack',
      title: 'Acknowledges only after the store verifies the chunk',
      detail:
        'The write is followed by a verification of that chunk, and the acknowledgment comes last. The draft acknowledges right after the write and verifies in a background pass, so corruption surfaces after a resume has consumed the chunk.',
      match: {
        python: {order: [/WriteChunk\(/, /VerifyChunk\(/]},
        typescript: {order: [/\.WriteChunk\(/, /\.VerifyChunk\(/]},
        go: {order: [/WriteChunk\(/, /VerifyChunk\(/]},
        scala: {order: [/writeChunk\(/, /verifyChunk\(/]},
        cpp: {order: [/WriteChunk\(/, /VerifyChunk\(/]},
      },
    },
    {
      id: 'checksum-confirmed',
      title: 'Compares the store’s checksum with the local digest',
      detail:
        'The payload is digested with **sha256** and the digest is what the store confirms; a mismatch or a `stored: false` fails the chunk. The draft never compares a checksum on the write path.',
      match: {
        python: {all: [/sha256\(/, /VerifyChunk\(/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /\.VerifyChunk\(/]},
        go: {all: [/sha256\.Sum256/, /VerifyChunk\(/]},
        scala: {all: [/getInstance\("SHA-256"\)/, /verifyChunk\(/]},
        cpp: {all: [/SHA256\(/, /VerifyChunk\(/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries only UNAVAILABLE and DEADLINE_EXCEEDED, at most 3 times',
      detail:
        'A named retryable set contains exactly `UNAVAILABLE` and `DEADLINE_EXCEEDED`, and the loop is bounded by a maximum attempt count. The draft catches every error and loops forever.',
      match: {
        python: {all: [/RETRYABLE/, /MAX_ATTEMPTS/]},
        typescript: {all: [/RETRYABLE/, /MAX_ATTEMPTS/]},
        go: {all: [/retryable/, /maxAttempts/]},
        scala: {all: [/Retryable/, /MaxAttempts/]},
        cpp: {all: [/kRetryable/, /kMaxAttempts/]},
      },
    },
    {
      id: 'permission-stops',
      title: 'Stops the upload on PERMISSION_DENIED with a visible reason',
      detail:
        '`PERMISSION_DENIED` is not retried: the upload stops and the error carries the status (`UploadRejected`). The draft treats it like any other failure and retries until the process dies.',
      match: {
        python: {all: [/PERMISSION_DENIED/, /UploadRejected/]},
        typescript: {all: [/PERMISSION_DENIED/, /UploadRejected/]},
        go: {all: [/codes\.PermissionDenied/, /UploadRejected/]},
        scala: {all: [/PERMISSION_DENIED/, /UploadRejected/]},
        cpp: {all: [/PERMISSION_DENIED/, /UploadRejected/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import store_pb2
import store_pb2_grpc

channel = grpc.insecure_channel("store:9000")
store = store_pb2_grpc.CheckpointStoreStub(channel)


def put_chunk(upload_id: str, index: int, payload: bytes) -> None:
    # TODO: this draft acknowledges the chunk as soon as the write returns, verifies later in a
    # background pass, retries every error forever with no deadline, and treats an authorization
    # rejection like a transient failure. Verify the checksum before acknowledging, bound the
    # retries, and stop the upload when the store denies permission.
    while True:
        try:
            store.WriteChunk(store_pb2.Chunk(upload_id=upload_id, index=index, data=payload))
            ack(upload_id, index)
            return
        except Exception:
            continue


def background_verify() -> None:
    """Runs every 10 s: a corrupted chunk surfaces here, after a resume consumed it."""
    raise NotImplementedError
`,
      solution: `import hashlib
import time

import grpc

import store_pb2
import store_pb2_grpc

DEADLINE_S = 30.0
MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("store:9000")
store = store_pb2_grpc.CheckpointStoreStub(channel)


class UploadRejected(RuntimeError):
    """The chunk was not persisted as sent; the upload stops with this reason."""


def put_chunk(upload_id: str, index: int, payload: bytes) -> str:
    digest = hashlib.sha256(payload).hexdigest()
    last_error: grpc.RpcError | None = None
    for _ in range(MAX_ATTEMPTS):
        try:
            store.WriteChunk(
                store_pb2.Chunk(upload_id=upload_id, index=index, data=payload, digest=digest),
                timeout=DEADLINE_S,
            )
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.PERMISSION_DENIED:
                raise UploadRejected(f"chunk {index} rejected: {exc.details()}") from exc
            if exc.code() not in RETRYABLE:
                raise UploadRejected(f"chunk {index} failed: {exc.code()}") from exc
            last_error = exc
            time.sleep(0.2)
            continue
        verified = store.VerifyChunk(
            store_pb2.VerifyRequest(upload_id=upload_id, index=index, digest=digest),
            timeout=DEADLINE_S,
        )
        if not verified.stored or verified.digest != digest:
            raise UploadRejected(f"chunk {index} failed verification")
        return digest
    raise UploadRejected(f"chunk {index} unverified after {MAX_ATTEMPTS} attempts") from last_error
`,
    },
    typescript: {
      starter: `/** Object-store client: a model-generated draft that acknowledges before verifying. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface Chunk {
  upload_id: string;
  index: number;
  data: Buffer;
}

interface VerifyRequest {
  upload_id: string;
  index: number;
  digest: string;
}

interface VerifyReply {
  stored: boolean;
  digest: string;
}

interface CheckpointStoreClient {
  WriteChunk(
    request: Chunk,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null) => void,
  ): grpc.ClientUnaryCall;
  VerifyChunk(
    request: VerifyRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: VerifyReply) => void,
  ): grpc.ClientUnaryCall;
}

const {store} = grpc.loadPackageDefinition(protoLoader.loadSync('store.proto')) as unknown as {
  store: {CheckpointStore: new (target: string, credentials: grpc.ChannelCredentials) => CheckpointStoreClient};
};
const client = new store.CheckpointStore('store:9000', grpc.credentials.createInsecure());

export async function putChunk(uploadId: string, index: number, payload: Buffer): Promise<void> {
  // TODO: this draft acknowledges the chunk as soon as the write returns, verifies later in a
  // background pass, retries every error forever with no deadline, and treats an authorization
  // rejection like a transient failure. Verify the checksum before acknowledging, bound the
  // retries, and stop the upload when the store denies permission.
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) =>
        client.WriteChunk({upload_id: uploadId, index, data: payload}, new grpc.Metadata(), {}, error =>
          error ? reject(error) : resolve(),
        ),
      );
      await ack(uploadId, index);
      return;
    } catch {
      continue;
    }
  }
}

export async function backgroundVerify(): Promise<void> {
  // Runs every 10 s: a corrupted chunk surfaces here, after a resume consumed it.
}

declare function ack(uploadId: string, index: number): Promise<void>;
`,
      solution: `/** Object-store client: a chunk is acknowledged only once the store confirms its checksum. */
import {createHash} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface Chunk {
  upload_id: string;
  index: number;
  data: Buffer;
  digest: string;
}

interface VerifyRequest {
  upload_id: string;
  index: number;
  digest: string;
}

interface VerifyReply {
  stored: boolean;
  digest: string;
}

interface CheckpointStoreClient {
  WriteChunk(
    request: Chunk,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null) => void,
  ): grpc.ClientUnaryCall;
  VerifyChunk(
    request: VerifyRequest,
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: VerifyReply) => void,
  ): grpc.ClientUnaryCall;
}

const {store} = grpc.loadPackageDefinition(protoLoader.loadSync('store.proto')) as unknown as {
  store: {CheckpointStore: new (target: string, credentials: grpc.ChannelCredentials) => CheckpointStoreClient};
};
const client = new store.CheckpointStore('store:9000', grpc.credentials.createInsecure());

/** Thrown when the chunk was not persisted as sent; the upload stops with this reason. */
export class UploadRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UploadRejected';
  }
}

export async function putChunk(uploadId: string, index: number, payload: Buffer): Promise<string> {
  const digest = createHash('sha256').update(payload).digest('hex');
  let lastError: grpc.ServiceError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) =>
        client.WriteChunk(
          {upload_id: uploadId, index, data: payload, digest},
          new grpc.Metadata(),
          {deadline: Date.now() + DEADLINE_MS},
          error => (error ? reject(error) : resolve()),
        ),
      );
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (serviceError.code === grpc.status.PERMISSION_DENIED)
        throw new UploadRejected(\`chunk \${index} rejected\`);
      if (RETRYABLE[serviceError.code] !== true)
        throw new UploadRejected(\`chunk \${index} failed: \${serviceError.code}\`);
      lastError = serviceError;
      continue;
    }

    const verified = await new Promise<VerifyReply>((resolve, reject) =>
      client.VerifyChunk({upload_id: uploadId, index, digest}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}, (error, reply) =>
        error ? reject(error) : resolve(reply),
      ),
    );
    if (!verified.stored || verified.digest !== digest)
      throw new UploadRejected(\`chunk \${index} failed verification\`);
    return digest;
  }

  throw new UploadRejected(\`chunk \${index} unverified after \${MAX_ATTEMPTS} attempts: \${lastError?.message ?? ''}\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

type chunkStoreClient interface {
	WriteChunk(ctx context.Context, in *Chunk, opts ...grpc.CallOption) (*WriteReply, error)
}

func putChunk(store chunkStoreClient, uploadID string, index int, payload []byte) error {
	// TODO: this draft acknowledges the chunk as soon as the write returns, verifies later in a
	// background pass, retries every error forever with no deadline, and treats an authorization
	// rejection like a transient failure. Verify the checksum before acknowledging, bound the
	// retries, and stop the upload when the store denies permission.
	for {
		ctx := context.Background()
		if _, err := store.WriteChunk(ctx, &Chunk{UploadId: uploadID, Index: int32(index), Data: payload}); err != nil {
			continue
		}
		return ackChunk(uploadID, index)
	}
}

func backgroundVerify() {
	// Runs every 10 s: a corrupted chunk surfaces here, after a resume consumed it.
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	storeTimeout = 30 * time.Second
	maxAttempts  = 3
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

// UploadRejected stops the upload with the reason the store gave.
type UploadRejected struct{ Reason string }

func (e *UploadRejected) Error() string { return "upload rejected: " + e.Reason }

type chunkStoreClient interface {
	WriteChunk(ctx context.Context, in *Chunk, opts ...grpc.CallOption) (*WriteReply, error)
	VerifyChunk(ctx context.Context, in *VerifyRequest, opts ...grpc.CallOption) (*VerifyReply, error)
}

func putChunk(store chunkStoreClient, uploadID string, index int, payload []byte) (string, error) {
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	var lastErr error

	for attempt := 0; attempt < maxAttempts; attempt++ {
		writeCtx, cancelWrite := context.WithTimeout(context.Background(), storeTimeout)
		_, err := store.WriteChunk(writeCtx, &Chunk{UploadId: uploadID, Index: int32(index), Data: payload, Digest: digest})
		cancelWrite()
		if err != nil {
			if status.Code(err) == codes.PermissionDenied {
				return "", &UploadRejected{Reason: "permission denied: " + status.Convert(err).Message()}
			}
			if !retryable[status.Code(err)] {
				return "", &UploadRejected{Reason: status.Code(err).String()}
			}
			lastErr = err
			continue
		}

		verifyCtx, cancelVerify := context.WithTimeout(context.Background(), storeTimeout)
		reply, err := store.VerifyChunk(verifyCtx, &VerifyRequest{UploadId: uploadID, Index: int32(index), Digest: digest})
		cancelVerify()
		if err != nil || !reply.Stored || reply.Digest != digest {
			return "", &UploadRejected{Reason: "chunk failed verification"}
		}
		return digest, nil
	}

	return "", &UploadRejected{Reason: fmt.Sprintf("unverified after %d attempts: %v", maxAttempts, lastErr)}
}
`,
    },
    scala: {
      starter: `import com.google.protobuf.ByteString
import io.grpc.StatusRuntimeException

object Client {
  def putChunk(stub: CheckpointStoreGrpc.CheckpointStoreBlockingStub, uploadId: String, index: Int, payload: Array[Byte]): Unit = {
    // TODO: this draft acknowledges the chunk as soon as the write returns, verifies later in a
    // background pass, retries every error forever with no deadline, and treats an authorization
    // rejection like a transient failure. Verify the checksum before acknowledging, bound the
    // retries, and stop the upload when the store denies permission.
    while (true) {
      try {
        stub.writeChunk(ChunkRequest(uploadId, index, ByteString.copyFrom(payload), ""))
        ackChunk(uploadId, index)
        return
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
  }

  def backgroundVerify(): Unit = {
    // Runs every 10 s: a corrupted chunk surfaces here, after a resume consumed it.
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import com.google.protobuf.ByteString
import io.grpc.Status
import io.grpc.StatusRuntimeException

object Client {
  val StoreTimeout = 30
  val MaxAttempts = 3
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  final class UploadRejected(message: String) extends RuntimeException(message)

  def sha256Hex(payload: Array[Byte]): String =
    MessageDigest.getInstance("SHA-256").digest(payload).map("%02x".format(_)).mkString

  def putChunk(stub: CheckpointStoreGrpc.CheckpointStoreBlockingStub, uploadId: String, index: Int, payload: Array[Byte]): String = {
    val digest = sha256Hex(payload)
    var attempt = 0
    var lastError: StatusRuntimeException = null
    var acknowledged = false
    var result = ""

    while (!acknowledged && attempt < MaxAttempts) {
      attempt += 1
      try {
        stub
          .withDeadlineAfter(StoreTimeout, TimeUnit.SECONDS)
          .writeChunk(ChunkRequest(uploadId, index, ByteString.copyFrom(payload), digest))
        val verified = stub
          .withDeadlineAfter(StoreTimeout, TimeUnit.SECONDS)
          .verifyChunk(VerifyRequest(uploadId, index, digest))
        if (!verified.stored || verified.digest != digest) {
          throw new UploadRejected(s"chunk \${index} failed verification")
        }
        result = digest
        acknowledged = true
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.PERMISSION_DENIED =>
          throw new UploadRejected(s"chunk \${index} rejected: \${e.getStatus.getDescription}")
        case e: StatusRuntimeException if !Retryable.contains(e.getStatus.getCode) =>
          throw new UploadRejected(s"chunk \${index} failed: \${e.getStatus.getCode}")
        case e: StatusRuntimeException =>
          lastError = e
      }
    }

    if (!acknowledged) throw new UploadRejected(s"chunk \${index} unverified after $MaxAttempts attempts: $lastError")
    result
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

#include "store.grpc.pb.h"

std::string putChunk(CheckpointStore::Stub& store, const std::string& uploadId, int index, const std::string& payload) {
  // TODO: this draft acknowledges the chunk as soon as the write returns, verifies later in a
  // background pass, retries every error forever with no deadline, and treats an authorization
  // rejection like a transient failure. Verify the checksum before acknowledging, bound the
  // retries, and stop the upload when the store denies permission.
  while (true) {
    grpc::ClientContext ctx;
    ChunkRequest request;
    request.set_upload_id(uploadId);
    request.set_index(index);
    request.set_data(payload);
    WriteReply reply;
    const auto status = store.WriteChunk(&ctx, request, &reply);
    if (status.ok()) {
      ackChunk(uploadId, index);
      return "";
    }
  }
}

void backgroundVerify() {
  // Runs every 10 s: a corrupted chunk surfaces here, after a resume consumed it.
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <openssl/sha.h>

#include <chrono>
#include <iomanip>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>

#include "store.grpc.pb.h"

constexpr int kStoreTimeout = 30;
constexpr int kMaxAttempts = 3;

const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

// UploadRejected stops the upload with the reason the store gave.
class UploadRejected : public std::runtime_error {
 public:
  explicit UploadRejected(const std::string& reason) : std::runtime_error(reason) {}
};

std::string sha256Hex(const std::string& payload) {
  unsigned char out[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), out);
  std::ostringstream hex;
  for (unsigned char byte : out) hex << std::hex << std::setw(2) << std::setfill('0') << int(byte);
  return hex.str();
}

std::string putChunk(CheckpointStore::Stub& store, const std::string& uploadId, int index, const std::string& payload) {
  const auto digest = sha256Hex(payload);
  std::string lastError;

  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kStoreTimeout));
      ChunkRequest request;
      request.set_upload_id(uploadId);
      request.set_index(index);
      request.set_data(payload);
      request.set_digest(digest);
      WriteReply reply;
      const auto status = store.WriteChunk(&ctx, request, &reply);
      if (!status.ok()) {
        if (status.error_code() == grpc::StatusCode::PERMISSION_DENIED) {
          throw UploadRejected("chunk " + std::to_string(index) + " rejected: " + status.error_message());
        }
        if (kRetryable.count(status.error_code()) == 0) {
          throw UploadRejected("chunk " + std::to_string(index) + " failed: " + status.error_message());
        }
        lastError = status.error_message();
        continue;
      }
    }

    grpc::ClientContext verifyCtx;
    verifyCtx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kStoreTimeout));
    VerifyRequest verifyRequest;
    verifyRequest.set_upload_id(uploadId);
    verifyRequest.set_index(index);
    verifyRequest.set_digest(digest);
    VerifyReply verifyReply;
    const auto verifyStatus = store.VerifyChunk(&verifyCtx, verifyRequest, &verifyReply);
    if (!verifyStatus.ok() || !verifyReply.stored() || verifyReply.digest() != digest) {
      throw UploadRejected("chunk " + std::to_string(index) + " failed verification");
    }
    return digest;
  }

  throw UploadRejected("chunk unverified after " + std::to_string(kMaxAttempts) + " attempts: " + lastError);
}
`,
    },
  },
  hints: [
    'An acknowledgment is a promise to the trainer: "you can resume from here". That is why the order matters — write, verify the checksum the store reports for that chunk, and only then tell the writer the chunk is in. A background pass is a monitoring tool, not an acknowledgment path.',
    'The digest has to be computed locally and compared with what the store returns (`stored` and `digest`). If the store cannot confirm the bytes it persisted, the chunk has not been persisted as sent, and the upload must fail rather than continue.',
    'Bound the failure policy: `MAX_ATTEMPTS = 3`, retry only `UNAVAILABLE`/`DEADLINE_EXCEEDED`, and give every call a 30-second deadline. `PERMISSION_DENIED` is terminal — raise a typed error with the status in it so on-call sees an expired credential instead of a hang.',
  ],
  debrief: `The interviewer is testing whether you can review a generated client against the failure it hides. The draft is the throughput-optimized shape: acknowledge fast, verify in the background, retry everything. Each choice is individually plausible and jointly wrong, because the platform's correctness argument runs through the acknowledgment: the trainer resumes from the last chunk the client said was durable. Real stores add per-chunk checksums returned by the object store, a resumable digest computed over the chunk list, retry budgets shared across chunks, and a token refresh path so a permission error is retried once after re-authenticating rather than swallowed.`,
};
