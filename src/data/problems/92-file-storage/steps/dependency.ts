import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Object-store writes: a deadline, a part-sized retry, a commit before the index',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['api', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter is the object-store client the finalize path calls:
\`complete(upload_id)\` reads the staged parts (\`store.staged_parts\`), indexes the file with
\`store.commit_file\`, writes every part with \`put_part\` (\`PutChunk\`), starting the whole upload over
on any error, then calls \`CommitMultipart\`. With a healthy store the file is indexed and its parts are
written; it hides four flaws.

\`\`\`proto
service ObjectStore {
  rpc PutChunk(PutChunkRequest) returns (PutChunkReply);       // {upload_id, part, data, sha256}
  rpc CommitMultipart(CommitRequest) returns (CommitReply);    // {object_key, digest, size}
}
\`\`\`

**Failure mode the checks target.** A stalled store holds the finalize open with no end; one dropped
connection on part 2 sends part 1 again; the store cannot tell a retried part from a new one; and a
failed commit leaves a file in the index whose object does not exist.

- Every call carries a \`DEADLINE_S\` = 15 s deadline.
- \`PutChunkRequest.sha256\` is the hex SHA-256 of the part's bytes.
- \`put_part\` retries **that part**, up to \`ATTEMPTS\` = 3 tries, on \`UNAVAILABLE\` and
  \`DEADLINE_EXCEEDED\` only; any other status is raised at once.
- \`store.commit_file\` runs after \`CommitMultipart\` returned, with its \`object_key\` and \`digest\`; a
  failed commit raises and leaves the session for a retry.`,
  sequence: {
    participants: ['Upload API', 'Object store', 'Redis'],
    messages: [
      {from: 'Upload API', to: 'Redis', label: 'staged_parts(upload_id)', kind: 'sync'},
      {from: 'Upload API', to: 'Object store', label: 'PutChunk part 1 · sha256 · deadline 15 s', kind: 'sync'},
      {from: 'Upload API', to: 'Object store', label: 'PutChunk part 2 → UNAVAILABLE', kind: 'sync'},
      {from: 'Upload API', to: 'Object store', label: 'PutChunk part 2 again (same sha256)', kind: 'sync'},
      {from: 'Upload API', to: 'Object store', label: 'CommitMultipart [1, 2]', kind: 'sync'},
      {from: 'Object store', to: 'Upload API', label: '{object_key, digest, size}', kind: 'reply'},
      {from: 'Upload API', to: 'Redis', label: 'commit_file(upload_id, object_key, digest)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every object-store call carries a 15-second deadline',
      detail:
        '`PutChunk` and `CommitMultipart` are called with `DEADLINE_S` (15 s), a full one on every attempt of a retried part; without one, a store that stops answering holds the finalize, and the client waiting on it, open indefinitely.',
      match: {
        python: {
          all: [
            /DEADLINE_S\s*=\s*15\b/,
            /PutChunk\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/,
            /CommitMultipart\([\s\S]{0,160}?timeout\s*=\s*DEADLINE_S/,
          ],
        },
        typescript: {
          all: [
            /DEADLINE_MS\s*=\s*15_?000\b/,
            /PutChunk\([\s\S]{0,120}?deadline:[^\n]*DEADLINE_MS/,
            /CommitMultipart\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/,
          ],
        },
        go: {all: [/deadline\s*=\s*15\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*15L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{15\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'chunk-hash',
      title: 'Each part carries its SHA-256',
      detail:
        "`PutChunkRequest.sha256` is the hex SHA-256 of the part's bytes, so the store verifies what arrived and acknowledges a retried part as a duplicate instead of storing it twice.",
      match: {
        python: {all: [/sha256\s*=\s*hashlib\.sha256\(\s*data\s*\)\.hexdigest\(\)/]},
        typescript: {
          all: [/sha256:\s*createHash\(\s*['"]sha256['"]\s*\)\.update\(\s*data\s*\)\.digest\(\s*['"]hex['"]\s*\)/],
        },
        go: {all: [/sha256\.Sum256\(\s*data\s*\)/, /Sha256:/]},
        scala: {all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/, /sha256\s*=/]},
        cpp: {all: [/SHA256\(/, /set_sha256\(/]},
      },
    },
    {
      id: 'retry-in-place',
      title: 'A failed part is retried alone, and only when the status allows it',
      detail:
        '`put_part` retries the part that failed, up to `ATTEMPTS`, on `UNAVAILABLE` and `DEADLINE_EXCEEDED`; any other status is raised. Restarting the loop over every part re-sends what the store already holds.',
      match: {
        python: {
          all: [/ATTEMPTS\s*=\s*3/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /def put_part[\s\S]*for attempt in/],
          none: [/def complete[\s\S]*for attempt in/],
        },
        typescript: {
          all: [/ATTEMPTS\s*=\s*3/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /function putPart[\s\S]*for \(let attempt/],
          none: [/function complete[\s\S]*for \(let attempt/],
        },
        go: {
          all: [
            /attempts\s*=\s*3/,
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
            /func putPart[\s\S]*for attempt :=/,
          ],
          none: [/func complete[\s\S]*for attempt :=/],
        },
        scala: {
          all: [/Attempts\s*=\s*3/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /def putPart[\s\S]*attempt/],
          none: [/def complete[\s\S]*attempt/],
        },
        cpp: {
          all: [/kAttempts\s*=\s*3/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/, /void putPart[\s\S]*for \(int attempt/],
          none: [/complete\([^)]*\)\s*\{[\s\S]*for \(int attempt/],
        },
      },
    },
    {
      id: 'commit-gate',
      title: 'The index learns of a file only after the commit',
      detail:
        '`commit_file` is called after `CommitMultipart` returned and with its `object_key` and `digest`; indexing first leaves a file readers can find whose object a failed commit never created.',
      match: {
        python: {order: [/def complete/, /\.CommitMultipart\(/, /store\.commit_file\(/]},
        typescript: {order: [/function complete/, /\.CommitMultipart\(/, /store\.commitFile\(/]},
        go: {order: [/func complete/, /\.CommitMultipart\(/, /store\.CommitFile\(/]},
        scala: {order: [/def complete/, /\.commitMultipart\(/, /Store\.commitFile\(/]},
        cpp: {order: [/store::File complete/, /->CommitMultipart\(/, /store::commitFile\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib

import grpc

import file_storage_pb2
import file_storage_pb2_grpc
from files import store  # store.staged_parts, commit_file

objects = file_storage_pb2_grpc.ObjectStoreStub(grpc.insecure_channel("objectstore:9000"))


def put_part(upload_id: str, n: int, data: bytes) -> None:
    """Write part n of the upload to the object store."""
    objects.PutChunk(file_storage_pb2.PutChunkRequest(upload_id=upload_id, part=n, data=data))


def complete(upload_id: str) -> dict:
    """Write every staged part, commit the multipart upload and index the file; the file record."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    parts = store.staged_parts(upload_id)
    digest = hashlib.sha256(b"".join(data for _, data in parts)).hexdigest()
    record = store.commit_file(upload_id, f"objects/{upload_id}", digest)
    for attempt in range(3):
        try:
            for n, data in parts:
                put_part(upload_id, n, data)
            break
        except grpc.RpcError:
            continue
    objects.CommitMultipart(file_storage_pb2.CommitRequest(upload_id=upload_id, parts=[n for n, _ in parts]))
    return record
`,
      solution: `import hashlib
import time

import grpc

import file_storage_pb2
import file_storage_pb2_grpc
from files import store  # store.staged_parts, commit_file

DEADLINE_S = 15
ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

objects = file_storage_pb2_grpc.ObjectStoreStub(grpc.insecure_channel("objectstore:9000"))


def put_part(upload_id: str, n: int, data: bytes) -> None:
    """Write part n of the upload to the object store."""
    # The hash lets the store verify the part and dedupe a retry of it.
    request = file_storage_pb2.PutChunkRequest(upload_id=upload_id, part=n, data=data, sha256=hashlib.sha256(data).hexdigest())
    for attempt in range(1, ATTEMPTS + 1):
        try:
            objects.PutChunk(request, timeout=DEADLINE_S)
            return
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE or attempt == ATTEMPTS:
                raise
            time.sleep(0.2 * attempt)  # this part only: the parts before it are already stored


def complete(upload_id: str) -> dict:
    """Write every staged part, commit the multipart upload and index the file; the file record."""
    parts = store.staged_parts(upload_id)
    for n, data in parts:
        put_part(upload_id, n, data)
    commit = objects.CommitMultipart(file_storage_pb2.CommitRequest(upload_id=upload_id, parts=[n for n, _ in parts]), timeout=DEADLINE_S)
    # Only a committed object is indexed; a failed commit raises above and the session stays for a retry.
    return store.commit_file(upload_id, commit.object_key, commit.digest)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {createHash} from 'node:crypto';

import * as store from 'files/store'; // stagedParts, commitFile

interface PutChunkRequest {
  upload_id: string;
  part: number;
  data: Uint8Array;
  sha256?: string;
}

interface CommitReply {
  object_key: string;
  digest: string;
  size: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('file_storage.proto')) as unknown as {
  stored: {ObjectStore: grpc.ServiceClientConstructor};
};
const objects = new pkg.stored.ObjectStore('objectstore:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  PutChunk(request: PutChunkRequest, metadata?: grpc.Metadata, options?: grpc.CallOptions): Promise<{part: number; deduped: boolean}>;
  CommitMultipart(request: {upload_id: string; parts: number[]}, metadata?: grpc.Metadata, options?: grpc.CallOptions): Promise<CommitReply>;
};

/** Write part n of the upload to the object store. */
export async function putPart(uploadId: string, n: number, data: Uint8Array): Promise<void> {
  await objects.PutChunk({upload_id: uploadId, part: n, data});
}

/** Write every staged part, commit the multipart upload and index the file; the file record. */
export async function complete(uploadId: string): Promise<store.FileRecord> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const parts = await store.stagedParts(uploadId);
  const digest = createHash('sha256').update(Buffer.concat(parts.map(([, data]) => data))).digest('hex') as string;
  const record = await store.commitFile(uploadId, \`objects/\${uploadId}\`, digest);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      for (const [n, data] of parts) await putPart(uploadId, n, data);
      break;
    } catch {
      continue;
    }
  }
  await objects.CommitMultipart({upload_id: uploadId, parts: parts.map(([n]) => n)});
  return record;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {createHash} from 'node:crypto';

import * as store from 'files/store'; // stagedParts, commitFile

export const DEADLINE_MS = 15_000;
export const ATTEMPTS = 3;
const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface PutChunkRequest {
  upload_id: string;
  part: number;
  data: Uint8Array;
  sha256?: string;
}

interface CommitReply {
  object_key: string;
  digest: string;
  size: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('file_storage.proto')) as unknown as {
  stored: {ObjectStore: grpc.ServiceClientConstructor};
};
const objects = new pkg.stored.ObjectStore('objectstore:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  PutChunk(request: PutChunkRequest, metadata?: grpc.Metadata, options?: grpc.CallOptions): Promise<{part: number; deduped: boolean}>;
  CommitMultipart(request: {upload_id: string; parts: number[]}, metadata?: grpc.Metadata, options?: grpc.CallOptions): Promise<CommitReply>;
};

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Write part n of the upload to the object store. */
export async function putPart(uploadId: string, n: number, data: Uint8Array): Promise<void> {
  // The hash lets the store verify the part and dedupe a retry of it.
  const request = {upload_id: uploadId, part: n, data, sha256: createHash('sha256').update(data).digest('hex') as string};
  for (let attempt = 1; ; attempt++) {
    try {
      await objects.PutChunk(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return;
    } catch (e) {
      if (!RETRYABLE.includes((e as grpc.ServiceError).code) || attempt === ATTEMPTS) throw e;
      await sleep(200 * attempt); // this part only: the parts before it are already stored
    }
  }
}

/** Write every staged part, commit the multipart upload and index the file; the file record. */
export async function complete(uploadId: string): Promise<store.FileRecord> {
  const parts = await store.stagedParts(uploadId);
  for (const [n, data] of parts) await putPart(uploadId, n, data);
  const commit = await objects.CommitMultipart(
    {upload_id: uploadId, parts: parts.map(([n]) => n)},
    new grpc.Metadata(),
    {deadline: Date.now() + DEADLINE_MS},
  );
  // Only a committed object is indexed; a failed commit throws above and the session stays for a retry.
  return store.commitFile(uploadId, commit.object_key, commit.digest);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "files/gen/file_storage"
	"files/store" // store.StagedParts, CommitFile, File
)

var (
	conn, _ = grpc.NewClient("objectstore:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	objects = pb.NewObjectStoreClient(conn)
)

// putPart writes part n of the upload to the object store.
func putPart(ctx context.Context, uploadID string, n int, data []byte) error {
	_, err := objects.PutChunk(ctx, &pb.PutChunkRequest{UploadId: uploadID, Part: int32(n), Data: data})
	return err
}

// complete writes every staged part, commits the multipart upload and indexes the file; the file record.
func complete(ctx context.Context, uploadID string) (*store.File, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	parts, err := store.StagedParts(ctx, uploadID)
	if err != nil {
		return nil, err
	}
	whole := sha256.New()
	numbers := make([]int32, 0, len(parts))
	for _, p := range parts {
		whole.Write(p.Data)
		numbers = append(numbers, int32(p.N))
	}
	f, err := store.CommitFile(ctx, uploadID, "objects/"+uploadID, hex.EncodeToString(whole.Sum(nil)))
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		err = nil
		for _, p := range parts {
			if err = putPart(ctx, uploadID, p.N, p.Data); err != nil {
				break
			}
		}
		if err == nil {
			break
		}
	}
	if _, err := objects.CommitMultipart(ctx, &pb.CommitRequest{UploadId: uploadID, Parts: numbers}); err != nil {
		return nil, err
	}
	return f, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "files/gen/file_storage"
	"files/store" // store.StagedParts, CommitFile, File
)

const (
	deadline = 15 * time.Second
	attempts = 3
)

var (
	conn, _ = grpc.NewClient("objectstore:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	objects = pb.NewObjectStoreClient(conn)
)

// putPart writes part n of the upload to the object store.
func putPart(ctx context.Context, uploadID string, n int, data []byte) error {
	// The hash lets the store verify the part and dedupe a retry of it.
	sum := sha256.Sum256(data)
	request := &pb.PutChunkRequest{UploadId: uploadID, Part: int32(n), Data: data, Sha256: hex.EncodeToString(sum[:])}
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		_, err = objects.PutChunk(callCtx, request)
		cancel()
		if code := status.Code(err); err == nil || (code != codes.Unavailable && code != codes.DeadlineExceeded) {
			return err
		}
		if attempt < attempts {
			time.Sleep(time.Duration(attempt) * 200 * time.Millisecond) // this part only: the parts before it are already stored
		}
	}
	return err
}

// complete writes every staged part, commits the multipart upload and indexes the file; the file record.
func complete(ctx context.Context, uploadID string) (*store.File, error) {
	parts, err := store.StagedParts(ctx, uploadID)
	if err != nil {
		return nil, err
	}
	numbers := make([]int32, 0, len(parts))
	for _, p := range parts {
		if err := putPart(ctx, uploadID, p.N, p.Data); err != nil {
			return nil, err
		}
		numbers = append(numbers, int32(p.N))
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	commit, err := objects.CommitMultipart(callCtx, &pb.CommitRequest{UploadId: uploadID, Parts: numbers})
	if err != nil {
		return nil, err // the session stays: a retry of complete can finish
	}
	// Only a committed object is indexed.
	return store.CommitFile(ctx, uploadID, commit.GetObjectKey(), commit.GetDigest())
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import com.google.protobuf.ByteString
import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import files.Store // Store.stagedParts, commitFile, File
import stored.file_storage.{CommitRequest, ObjectStoreGrpc, PutChunkRequest}

object Client {
  private val objects = ObjectStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("objectstore", 9000).usePlaintext().build())

  /** Write part n of the upload to the object store. */
  def putPart(uploadId: String, n: Int, data: Array[Byte]): Unit =
    objects.putChunk(PutChunkRequest(uploadId = uploadId, part = n, data = ByteString.copyFrom(data)))

  /** Write every staged part, commit the multipart upload and index the file; the file record. */
  def complete(uploadId: String): Store.File = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val parts = Store.stagedParts(uploadId)
    val whole = MessageDigest.getInstance("SHA-256")
    parts.foreach { case (_, data) => whole.update(data) }
    val record = Store.commitFile(uploadId, s"objects/$uploadId", whole.digest().map(b => f"\${b & 0xff}%02x").mkString)
    var attempt = 0
    var written = false
    while (!written && attempt < 3) {
      attempt += 1
      try {
        parts.foreach { case (n, data) => putPart(uploadId, n, data) }
        written = true
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    objects.commitMultipart(CommitRequest(uploadId = uploadId, parts = parts.map(_._1)))
    record
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import com.google.protobuf.ByteString
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import files.Store // Store.stagedParts, commitFile, File
import stored.file_storage.{CommitRequest, ObjectStoreGrpc, PutChunkRequest}

object Client {
  val DeadlineSeconds = 15L
  val Attempts = 3
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val objects = ObjectStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("objectstore", 9000).usePlaintext().build())

  /** Write part n of the upload to the object store. */
  def putPart(uploadId: String, n: Int, data: Array[Byte]): Unit = {
    // The hash lets the store verify the part and dedupe a retry of it.
    val hex = MessageDigest.getInstance("SHA-256").digest(data).map(b => f"\${b & 0xff}%02x").mkString
    val request = PutChunkRequest(uploadId = uploadId, part = n, data = ByteString.copyFrom(data), sha256 = hex)
    def attempt(number: Int): Unit =
      try objects.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).putChunk(request)
      catch {
        case e: StatusRuntimeException if Retryable(e.getStatus.getCode) && number < Attempts =>
          Thread.sleep(200L * number) // this part only: the parts before it are already stored
          attempt(number + 1)
      }
    attempt(1)
  }

  /** Write every staged part, commit the multipart upload and index the file; the file record. */
  def complete(uploadId: String): Store.File = {
    val parts = Store.stagedParts(uploadId)
    parts.foreach { case (n, data) => putPart(uploadId, n, data) }
    val commit = objects.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).commitMultipart(CommitRequest(uploadId = uploadId, parts = parts.map(_._1)))
    // Only a committed object is indexed; a failed commit throws above and the session stays for a retry.
    Store.commitFile(uploadId, commit.objectKey, commit.digest)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <openssl/sha.h>

#include <cstdio>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "file_storage.grpc.pb.h"
#include "files/store.h"  // store::stagedParts, commitFile, File

auto objects = stored::ObjectStore::NewStub(grpc::CreateChannel("objectstore:9000", grpc::InsecureChannelCredentials()));

std::string hexOf(const unsigned char* digest, size_t length) {
  std::string hex;
  char byte[3];
  for (size_t i = 0; i < length; i++) {
    std::snprintf(byte, sizeof byte, "%02x", digest[i]);
    hex += byte;
  }
  return hex;
}

// Write part n of the upload to the object store; throws when the store refuses it.
void putPart(const std::string& upload_id, int n, const std::string& data) {
  grpc::ClientContext ctx;
  stored::PutChunkRequest request;
  request.set_upload_id(upload_id);
  request.set_part(n);
  request.set_data(data);
  stored::PutChunkReply reply;
  const grpc::Status status = objects->PutChunk(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("PutChunk: " + status.error_message());
}

// Write every staged part, commit the multipart upload and index the file; the file record.
store::File complete(const std::string& upload_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto parts = store::stagedParts(upload_id);
  std::string whole;
  for (const auto& [n, data] : parts) whole += data;
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(whole.data()), whole.size(), digest);
  const store::File record = store::commitFile(upload_id, "objects/" + upload_id, hexOf(digest, sizeof digest));
  for (int round = 0; round < 3; round++) {
    try {
      for (const auto& [n, data] : parts) putPart(upload_id, n, data);
      break;
    } catch (const std::runtime_error&) {
      continue;
    }
  }
  grpc::ClientContext ctx;
  stored::CommitRequest request;
  request.set_upload_id(upload_id);
  for (const auto& [n, data] : parts) request.add_parts(n);
  stored::CommitReply commit;
  const grpc::Status status = objects->CommitMultipart(&ctx, request, &commit);
  if (!status.ok()) throw std::runtime_error("CommitMultipart: " + status.error_message());
  return record;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <openssl/sha.h>

#include <chrono>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "file_storage.grpc.pb.h"
#include "files/store.h"  // store::stagedParts, commitFile, File

constexpr std::chrono::seconds kDeadline{15};
constexpr int kAttempts = 3;

auto objects = stored::ObjectStore::NewStub(grpc::CreateChannel("objectstore:9000", grpc::InsecureChannelCredentials()));

std::string hexOf(const unsigned char* digest, size_t length) {
  std::string hex;
  char byte[3];
  for (size_t i = 0; i < length; i++) {
    std::snprintf(byte, sizeof byte, "%02x", digest[i]);
    hex += byte;
  }
  return hex;
}

// Write part n of the upload to the object store; throws when the store refuses it.
void putPart(const std::string& upload_id, int n, const std::string& data) {
  // The hash lets the store verify the part and dedupe a retry of it.
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(data.data()), data.size(), digest);
  stored::PutChunkRequest request;
  request.set_upload_id(upload_id);
  request.set_part(n);
  request.set_data(data);
  request.set_sha256(hexOf(digest, sizeof digest));
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    stored::PutChunkReply reply;
    const grpc::Status status = objects->PutChunk(&ctx, request, &reply);
    if (status.ok()) return;
    const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE || status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable || attempt == kAttempts) throw std::runtime_error("PutChunk: " + status.error_message());
    std::this_thread::sleep_for(std::chrono::milliseconds(200 * attempt));  // this part only: the parts before it are already stored
  }
}

// Write every staged part, commit the multipart upload and index the file; the file record.
store::File complete(const std::string& upload_id) {
  const auto parts = store::stagedParts(upload_id);
  for (const auto& [n, data] : parts) putPart(upload_id, n, data);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  stored::CommitRequest request;
  request.set_upload_id(upload_id);
  for (const auto& [n, data] : parts) request.add_parts(n);
  stored::CommitReply commit;
  const grpc::Status status = objects->CommitMultipart(&ctx, request, &commit);
  // A failed commit throws and the session stays for a retry; only a committed object is indexed.
  if (!status.ok()) throw std::runtime_error("CommitMultipart: " + status.error_message());
  return store::commitFile(upload_id, commit.object_key(), commit.digest());
}
`,
    },
  },
  harness: {
    python: `import hashlib

import grpc

import file_storage_pb2
import file_storage_pb2_grpc
from files import sessions, store

PARTS = [b"\\x89PNG\\r\\n\\x1a\\n" + bytes(24), bytes(range(32)), b"tail" * 4]
WHOLE = hashlib.sha256(b"".join(PARTS)).hexdigest()


class ObjectStore(file_storage_pb2_grpc.ObjectStoreServicer):
    """Keeps parts per upload; a part in fail_once fails UNAVAILABLE on its first write, one in stall_once after 10 s."""

    def __init__(self, clock):
        self.clock = clock
        self.parts = {}
        self.fail_once = set()
        self.stall_once = set()

    def PutChunk(self, request, context):
        key = (request.upload_id, request.part)
        if key in self.fail_once:
            self.fail_once.discard(key)
            context.abort(grpc.StatusCode.UNAVAILABLE, "connection reset by peer")
        if key in self.stall_once:
            self.stall_once.discard(key)
            self.clock.advance(10)
            context.abort(grpc.StatusCode.UNAVAILABLE, "connection reset by peer after 10 s")
        if request.sha256 and request.sha256 != hashlib.sha256(request.data).hexdigest():
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "sha256 does not match the part")
        deduped = bool(request.sha256) and key in self.parts and hashlib.sha256(self.parts[key]).hexdigest() == request.sha256
        self.parts[key] = request.data
        return file_storage_pb2.PutChunkReply(part=request.part, deduped=deduped)

    def CommitMultipart(self, request, context):
        missing = [n for n in request.parts if (request.upload_id, n) not in self.parts]
        if missing:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, f"parts {missing} were never written")
        data = b"".join(self.parts[(request.upload_id, n)] for n in request.parts)
        return file_storage_pb2.CommitReply(object_key=f"objects/{request.upload_id}", digest=hashlib.sha256(data).hexdigest(), size=len(data))


def _client(ctx):
    peer = ObjectStore(ctx.clock)
    ctx.grpc.serve(file_storage_pb2_grpc.add_ObjectStoreServicer_to_server, peer)
    return ctx.load("client"), peer


def _staged():
    upload_id = sessions.open_session("t1", sum(len(p) for p in PARTS), "image/png", "holiday.png")
    for n, data in enumerate(PARTS, start=1):
        store.stage_part(upload_id, n, data)
        sessions.ack_part(upload_id, n, len(data))
    return upload_id


def _fails(m, upload_id, why):
    try:
        record = m.complete(upload_id)
    except Exception:
        return
    raise AssertionError(f"{why}: complete returned {record} instead of raising")


def _completes(m, upload_id, why):
    try:
        return m.complete(upload_id)
    except grpc.RpcError as exc:
        raise AssertionError(f"{why}, complete raised {exc.code().name}: {exc.details()}") from None


def _sent_since(ctx, before):
    return [c.request.part for c in ctx.grpc.calls_to("PutChunk")[before:]]


def check_deadline(ctx):
    m, peer = _client(ctx)
    upload_id = _staged()
    m.complete(upload_id)
    for method in ("PutChunk", "CommitMultipart"):
        calls = ctx.grpc.calls_to(method)
        assert calls, f"no {method} call was made"
        for call in calls:
            assert call.timeout is not None, f"a {method} call carries no deadline: a stalled object store would hold the finalize open"
            assert 14 <= call.timeout <= 16, f"a {method} call carries a {call.timeout} s deadline, expected DEADLINE_S = 15"
    slow = _staged()
    peer.stall_once.add((slow, 2))
    before = len(ctx.grpc.calls_to("PutChunk"))
    m.complete(slow)
    retried = ctx.grpc.calls_to("PutChunk")[before:]
    assert [c.request.part for c in retried] == [1, 2, 2, 3], f"with part 2 failing UNAVAILABLE after 10 s the parts were sent in the order {[c.request.part for c in retried]}, expected [1, 2, 2, 3]"
    for call in retried:
        assert call.timeout is not None and 14 <= call.timeout <= 16, f"part {call.request.part} was sent with a {call.timeout} s deadline after part 2's first attempt took 10 s: every attempt carries its own DEADLINE_S, not what is left of one shared deadline"
    stalled = _staged()
    ctx.grpc.set_latency("PutChunk", 60.0)
    _fails(m, stalled, "with the object store taking 60 s per part")
    assert store.find_file(store.file_id_for(stalled)) is None, "an upload whose parts timed out was indexed as a file"


def check_chunk_hash(ctx):
    m, _ = _client(ctx)
    upload_id = _staged()
    record = m.complete(upload_id)
    for call in ctx.grpc.calls_to("PutChunk"):
        expected = hashlib.sha256(call.request.data).hexdigest()
        assert call.request.sha256 == expected, f"part {call.request.part} was sent with sha256 {call.request.sha256!r}, expected {expected}: without it the store cannot verify the part or dedupe a retry"
    assert record["digest"] == WHOLE, f"the file was indexed with digest {record['digest']}, expected the object's {WHOLE}"


def check_retry_in_place(ctx):
    m, peer = _client(ctx)
    upload_id = _staged()
    peer.fail_once.add((upload_id, 2))
    record = m.complete(upload_id)
    sent = [c.request.part for c in ctx.grpc.calls_to("PutChunk")]
    assert sent == [1, 2, 2, 3], f"with part 2 failing once UNAVAILABLE the parts were sent in the order {sent}, expected [1, 2, 2, 3]: retry the part that failed, not the upload"
    assert record["digest"] == WHOLE and store.find_file(record["file_id"]) is not None, f"the retried upload must be committed and indexed, got {record}"
    refused = _staged()
    ctx.grpc.fail("PutChunk", grpc.StatusCode.INVALID_ARGUMENT, "part rejected", times=1)
    before = len(ctx.grpc.calls_to("PutChunk"))
    _fails(m, refused, "with part 1 rejected INVALID_ARGUMENT")
    tries = len(ctx.grpc.calls_to("PutChunk")) - before
    assert tries == 1, f"a part rejected INVALID_ARGUMENT was sent {tries} times: only UNAVAILABLE and DEADLINE_EXCEEDED are worth a retry"
    assert ctx.clock.sleeps <= 1, f"the client slept {ctx.clock.sleeps} times: one backoff for the one retryable failure"
    for code in (grpc.StatusCode.FAILED_PRECONDITION, grpc.StatusCode.PERMISSION_DENIED, grpc.StatusCode.INTERNAL, grpc.StatusCode.RESOURCE_EXHAUSTED):
        terminal = _staged()
        ctx.grpc.fail("PutChunk", code, "part rejected", times=1)
        before = len(ctx.grpc.calls_to("PutChunk"))
        _fails(m, terminal, f"with part 1 rejected {code.name}")
        tries = len(ctx.grpc.calls_to("PutChunk")) - before
        assert tries == 1, f"a part rejected {code.name} was sent {tries} times: only UNAVAILABLE and DEADLINE_EXCEEDED are worth a retry"
    timed_out = _staged()
    ctx.grpc.fail("PutChunk", grpc.StatusCode.DEADLINE_EXCEEDED, "deadline exceeded", times=1)
    before = len(ctx.grpc.calls_to("PutChunk"))
    _completes(m, timed_out, "with part 1 failing DEADLINE_EXCEEDED once (a retryable status)")
    assert _sent_since(ctx, before) == [1, 1, 2, 3], f"with part 1 failing DEADLINE_EXCEEDED once the parts were sent in the order {_sent_since(ctx, before)}, expected [1, 1, 2, 3]: DEADLINE_EXCEEDED is retried"
    third = _staged()
    ctx.grpc.fail("PutChunk", grpc.StatusCode.UNAVAILABLE, "connection reset by peer", times=2)
    before = len(ctx.grpc.calls_to("PutChunk"))
    _completes(m, third, "with part 1 failing UNAVAILABLE twice (ATTEMPTS = 3 tries)")
    assert _sent_since(ctx, before) == [1, 1, 1, 2, 3], f"with part 1 failing UNAVAILABLE twice the parts were sent in the order {_sent_since(ctx, before)}, expected [1, 1, 1, 2, 3]: ATTEMPTS = 3 tries"
    exhausted = _staged()
    ctx.grpc.fail("PutChunk", grpc.StatusCode.UNAVAILABLE, "connection reset by peer", times=3)
    before = len(ctx.grpc.calls_to("PutChunk"))
    _fails(m, exhausted, "with part 1 failing UNAVAILABLE three times")
    assert _sent_since(ctx, before) == [1, 1, 1], f"with part 1 failing UNAVAILABLE three times the parts were sent in the order {_sent_since(ctx, before)}, expected [1, 1, 1]: give up after ATTEMPTS = 3 tries"
    assert store.find_file(store.file_id_for(exhausted)) is None, "an upload whose part 1 never reached the store was indexed as a file"


def check_commit_gate(ctx):
    m, _ = _client(ctx)
    upload_id = _staged()
    file_id = store.file_id_for(upload_id)
    ctx.grpc.fail("CommitMultipart", grpc.StatusCode.UNAVAILABLE, "store restarting", times=1)
    _fails(m, upload_id, "with CommitMultipart failing UNAVAILABLE")
    assert store.find_file(file_id) is None, f"the commit failed and file:{file_id} was indexed anyway ({store.find_file(file_id)}): readers find a file whose object does not exist"
    assert sessions.find_session(upload_id) is not None, "a failed commit dropped the session: the upload can no longer be finished"
    record = m.complete(upload_id)
    assert record["object_key"] == f"objects/{upload_id}" and record["digest"] == WHOLE, f"the index must record the object key and digest CommitMultipart answered, got {record}"
    assert store.find_file(file_id)["state"] == "committed", "after a successful retry the file must be committed"
`,
    typescript: `import {createHash} from 'node:crypto';

const PARTS = [
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]),
  Buffer.from(Array.from({length: 32}, (_, i) => i)),
  Buffer.from('tail'.repeat(4)),
];
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex') as string;
const WHOLE = sha(Buffer.concat(PARTS));

/** Keeps parts per upload; a part in failOnce fails UNAVAILABLE on its first write, one in stallOnce after 10 s. */
function client(ctx) {
  const pkg = ctx.proto('file_storage.proto');
  const parts = new Map<string, Buffer>();
  const failOnce = new Set<string>();
  const stallOnce = new Set<string>();
  ctx.grpc.serve(pkg.stored.ObjectStore.service, {
    PutChunk(call, callback) {
      const {upload_id, part, data, sha256} = call.request;
      const key = \`\${upload_id}/\${part}\`;
      if (failOnce.delete(key)) return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'connection reset by peer'});
      if (stallOnce.delete(key)) {
        ctx.clock.advance(10);
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'connection reset by peer after 10 s'});
      }
      if (sha256 && sha256 !== sha(data)) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: 'sha256 does not match the part'});
      const deduped = Boolean(sha256) && parts.has(key) && sha(parts.get(key) as Buffer) === sha256;
      parts.set(key, Buffer.from(data));
      callback(null, {part, deduped});
    },
    CommitMultipart(call, callback) {
      const {upload_id} = call.request;
      const numbers: number[] = call.request.parts;
      const missing = numbers.filter(n => !parts.has(\`\${upload_id}/\${n}\`));
      if (missing.length > 0) return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: \`parts \${missing} were never written\`});
      const data = Buffer.concat(numbers.map(n => parts.get(\`\${upload_id}/\${n}\`) as Buffer));
      callback(null, {object_key: \`objects/\${upload_id}\`, digest: sha(data), size: data.length});
    },
  });
  return {m: ctx.load('client'), failOnce, stallOnce, store: ctx.load('/support/files/store.ts'), sessions: ctx.load('/support/files/sessions.ts')};
}

async function staged(store, sessions): Promise<string> {
  const uploadId = await sessions.openSession('t1', PARTS.reduce((n, p) => n + p.length, 0), 'image/png', 'holiday.png');
  for (const [i, data] of PARTS.entries()) {
    await store.stagePart(uploadId, i + 1, data);
    await sessions.ackPart(uploadId, i + 1, data.length);
  }
  return uploadId;
}

async function fails(m, uploadId: string, why: string): Promise<void> {
  let record;
  try {
    record = await m.complete(uploadId);
  } catch {
    return;
  }
  assert.fail(\`\${why}: complete returned \${JSON.stringify(record)} instead of throwing\`);
}

async function completes(m, uploadId: string, why: string) {
  try {
    return await m.complete(uploadId);
  } catch (error) {
    assert.fail(\`\${why}, complete threw \${(error as Error).message}\`);
  }
}

const sentSince = (ctx, before: number): number[] => ctx.grpc.callsTo('PutChunk').slice(before).map(c => c.request.part);

export async function check_deadline(ctx) {
  const {m, stallOnce, store, sessions} = client(ctx);
  await m.complete(await staged(store, sessions));
  for (const method of ['PutChunk', 'CommitMultipart']) {
    const calls = ctx.grpc.callsTo(method);
    assert(calls.length > 0, \`no \${method} call was made\`);
    for (const call of calls) {
      assert(call.timeout !== null, \`a \${method} call carries no deadline: a stalled object store would hold the finalize open\`);
      assert(call.timeout >= 14 && call.timeout <= 16, \`a \${method} call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 15000\`);
    }
  }
  const slow = await staged(store, sessions);
  stallOnce.add(\`\${slow}/2\`);
  const before = ctx.grpc.callsTo('PutChunk').length;
  await m.complete(slow);
  const retried = ctx.grpc.callsTo('PutChunk').slice(before);
  assert.deepStrictEqual(retried.map(c => c.request.part), [1, 2, 2, 3], 'with part 2 failing UNAVAILABLE after 10 s the parts must be sent in the order [1, 2, 2, 3]');
  for (const call of retried) {
    assert(call.timeout !== null && call.timeout >= 14 && call.timeout <= 16, \`part \${call.request.part} was sent with a \${call.timeout} s deadline after part 2's first attempt took 10 s: every attempt carries its own DEADLINE_MS, not what is left of one shared deadline\`);
  }
  const stalled = await staged(store, sessions);
  ctx.grpc.setLatency('PutChunk', 60.0);
  await fails(m, stalled, 'with the object store taking 60 s per part');
  assert.equal(await store.findFile(store.fileIdFor(stalled)), null, 'an upload whose parts timed out was indexed as a file');
}

export async function check_chunk_hash(ctx) {
  const {m, store, sessions} = client(ctx);
  const record = await m.complete(await staged(store, sessions));
  for (const call of ctx.grpc.callsTo('PutChunk')) {
    const expected = sha(call.request.data);
    assert.equal(call.request.sha256, expected, \`part \${call.request.part} was sent with sha256 \${JSON.stringify(call.request.sha256)}, expected \${expected}: without it the store cannot verify the part or dedupe a retry\`);
  }
  assert.equal(record.digest, WHOLE, \`the file was indexed with digest \${record.digest}, expected the object's \${WHOLE}\`);
}

export async function check_retry_in_place(ctx) {
  const {m, failOnce, store, sessions} = client(ctx);
  const uploadId = await staged(store, sessions);
  failOnce.add(\`\${uploadId}/2\`);
  const record = await m.complete(uploadId);
  const sent = ctx.grpc.callsTo('PutChunk').map(c => c.request.part);
  assert.deepStrictEqual(sent, [1, 2, 2, 3], \`with part 2 failing once UNAVAILABLE the parts were sent in the order \${JSON.stringify(sent)}, expected [1, 2, 2, 3]: retry the part that failed, not the upload\`);
  assert(record.digest === WHOLE && (await store.findFile(record.file_id)) !== null, \`the retried upload must be committed and indexed, got \${JSON.stringify(record)}\`);
  const refused = await staged(store, sessions);
  ctx.grpc.fail('PutChunk', ctx.grpc.status.INVALID_ARGUMENT, 'part rejected', 1);
  const before = ctx.grpc.callsTo('PutChunk').length;
  await fails(m, refused, 'with part 1 rejected INVALID_ARGUMENT');
  const tries = ctx.grpc.callsTo('PutChunk').length - before;
  assert.equal(tries, 1, \`a part rejected INVALID_ARGUMENT was sent \${tries} times: only UNAVAILABLE and DEADLINE_EXCEEDED are worth a retry\`);
  assert(ctx.clock.sleeps <= 1, \`the client slept \${ctx.clock.sleeps} times: one backoff for the one retryable failure\`);
  for (const code of ['FAILED_PRECONDITION', 'PERMISSION_DENIED', 'INTERNAL', 'RESOURCE_EXHAUSTED']) {
    const terminal = await staged(store, sessions);
    ctx.grpc.fail('PutChunk', ctx.grpc.status[code], 'part rejected', 1);
    const from = ctx.grpc.callsTo('PutChunk').length;
    await fails(m, terminal, \`with part 1 rejected \${code}\`);
    const sent = ctx.grpc.callsTo('PutChunk').length - from;
    assert.equal(sent, 1, \`a part rejected \${code} was sent \${sent} times: only UNAVAILABLE and DEADLINE_EXCEEDED are worth a retry\`);
  }
  const timedOut = await staged(store, sessions);
  ctx.grpc.fail('PutChunk', ctx.grpc.status.DEADLINE_EXCEEDED, 'deadline exceeded', 1);
  let from = ctx.grpc.callsTo('PutChunk').length;
  await completes(m, timedOut, 'with part 1 failing DEADLINE_EXCEEDED once (a retryable status)');
  assert.deepStrictEqual(sentSince(ctx, from), [1, 1, 2, 3], \`with part 1 failing DEADLINE_EXCEEDED once the parts were sent in the order \${JSON.stringify(sentSince(ctx, from))}, expected [1, 1, 2, 3]: DEADLINE_EXCEEDED is retried\`);
  const third = await staged(store, sessions);
  ctx.grpc.fail('PutChunk', ctx.grpc.status.UNAVAILABLE, 'connection reset by peer', 2);
  from = ctx.grpc.callsTo('PutChunk').length;
  await completes(m, third, 'with part 1 failing UNAVAILABLE twice (ATTEMPTS = 3 tries)');
  assert.deepStrictEqual(sentSince(ctx, from), [1, 1, 1, 2, 3], \`with part 1 failing UNAVAILABLE twice the parts were sent in the order \${JSON.stringify(sentSince(ctx, from))}, expected [1, 1, 1, 2, 3]: ATTEMPTS = 3 tries\`);
  const exhausted = await staged(store, sessions);
  ctx.grpc.fail('PutChunk', ctx.grpc.status.UNAVAILABLE, 'connection reset by peer', 3);
  from = ctx.grpc.callsTo('PutChunk').length;
  await fails(m, exhausted, 'with part 1 failing UNAVAILABLE three times');
  assert.deepStrictEqual(sentSince(ctx, from), [1, 1, 1], \`with part 1 failing UNAVAILABLE three times the parts were sent in the order \${JSON.stringify(sentSince(ctx, from))}, expected [1, 1, 1]: give up after ATTEMPTS = 3 tries\`);
  assert.equal(await store.findFile(store.fileIdFor(exhausted)), null, 'an upload whose part 1 never reached the store was indexed as a file');
}

export async function check_commit_gate(ctx) {
  const {m, store, sessions} = client(ctx);
  const uploadId = await staged(store, sessions);
  const fileId = store.fileIdFor(uploadId);
  ctx.grpc.fail('CommitMultipart', ctx.grpc.status.UNAVAILABLE, 'store restarting', 1);
  await fails(m, uploadId, 'with CommitMultipart failing UNAVAILABLE');
  assert.equal(await store.findFile(fileId), null, \`the commit failed and file:\${fileId} was indexed anyway: readers find a file whose object does not exist\`);
  assert((await sessions.findSession(uploadId)) !== null, 'a failed commit dropped the session: the upload can no longer be finished');
  const record = await m.complete(uploadId);
  assert(record.object_key === \`objects/\${uploadId}\` && record.digest === WHOLE, \`the index must record the object key and digest CommitMultipart answered, got \${JSON.stringify(record)}\`);
  assert.equal((await store.findFile(fileId)).state, 'committed', 'after a successful retry the file must be committed');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "files/gen/file_storage"
	"files/sessions"
	"files/store"

	"leetbuild/harness"
)

var (
	hBg    = context.Background()
	hParts = [][]byte{append([]byte("\\x89PNG\\r\\n\\x1a\\n"), make([]byte, 24)...), hSeq(32), bytes.Repeat([]byte("tail"), 4)}
	hWhole = hHexSum(bytes.Join(hParts, nil))
)

func hSeq(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(i)
	}
	return out
}

func hHexSum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// hObjectStore keeps parts per upload; a part in failOnce fails UNAVAILABLE on its first write, one in stallOnce after 10 s.
type hObjectStore struct {
	pb.UnimplementedObjectStoreServer
	clock     *harness.Clock
	parts     map[string][]byte
	failOnce  map[string]bool
	stallOnce map[string]bool
}

func (s *hObjectStore) PutChunk(_ context.Context, req *pb.PutChunkRequest) (*pb.PutChunkReply, error) {
	key := fmt.Sprintf("%s/%d", req.GetUploadId(), req.GetPart())
	if s.failOnce[key] {
		delete(s.failOnce, key)
		return nil, status.Error(codes.Unavailable, "connection reset by peer")
	}
	if s.stallOnce[key] {
		delete(s.stallOnce, key)
		s.clock.Advance(10)
		return nil, status.Error(codes.Unavailable, "connection reset by peer after 10 s")
	}
	if req.GetSha256() != "" && req.GetSha256() != hHexSum(req.GetData()) {
		return nil, status.Error(codes.InvalidArgument, "sha256 does not match the part")
	}
	previous, seen := s.parts[key]
	s.parts[key] = append([]byte{}, req.GetData()...)
	return &pb.PutChunkReply{Part: req.GetPart(), Deduped: req.GetSha256() != "" && seen && hHexSum(previous) == req.GetSha256()}, nil
}

func (s *hObjectStore) CommitMultipart(_ context.Context, req *pb.CommitRequest) (*pb.CommitReply, error) {
	var data []byte
	for _, n := range req.GetParts() {
		part, ok := s.parts[fmt.Sprintf("%s/%d", req.GetUploadId(), n)]
		if !ok {
			return nil, status.Errorf(codes.FailedPrecondition, "part %d was never written", n)
		}
		data = append(data, part...)
	}
	return &pb.CommitReply{ObjectKey: "objects/" + req.GetUploadId(), Digest: hHexSum(data), Size: int64(len(data))}, nil
}

func hObjectPeer(ctx *harness.Ctx) *hObjectStore {
	peer := &hObjectStore{clock: ctx.Clock, parts: map[string][]byte{}, failOnce: map[string]bool{}, stallOnce: map[string]bool{}}
	pb.RegisterObjectStoreServer(ctx.GRPC.Server(""), peer)
	return peer
}

func hStaged(ctx *harness.Ctx) string {
	var total int64
	for _, p := range hParts {
		total += int64(len(p))
	}
	uploadID, err := sessions.OpenSession(hBg, "t1", total, "image/png", "holiday.png")
	ctx.NoError(err, "OpenSession failed")
	for i, data := range hParts {
		store.StagePart(hBg, uploadID, i+1, data)
		sessions.AckPart(hBg, uploadID, i+1, int64(len(data)))
	}
	return uploadID
}

func hComplete(ctx *harness.Ctx, uploadID, why string) *store.File {
	f, err := complete(hBg, uploadID)
	ctx.NoError(err, "%s: complete(%s) failed", why, uploadID)
	ctx.Assert(f != nil, "%s: complete(%s) returned no file", why, uploadID)
	return f
}

func hFail(ctx *harness.Ctx, uploadID, why string) {
	f, err := complete(hBg, uploadID)
	ctx.Assert(err != nil, "%s: complete returned %+v instead of an error", why, f)
}

// hSentSince is the part numbers of the PutChunk calls after the first before.
func hSentSince(ctx *harness.Ctx, before int) []int32 {
	sent := []int32{}
	for _, call := range ctx.GRPC.CallsTo("PutChunk", "")[before:] {
		sent = append(sent, call.Request.(*pb.PutChunkRequest).GetPart())
	}
	return sent
}

func CheckDeadline(ctx *harness.Ctx) {
	peer := hObjectPeer(ctx)
	hComplete(ctx, hStaged(ctx), "with a healthy object store")
	for _, method := range []string{"PutChunk", "CommitMultipart"} {
		calls := ctx.GRPC.CallsTo(method, "")
		ctx.Assert(len(calls) > 0, "no %s call was made", method)
		for _, call := range calls {
			ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a stalled object store would hold the finalize open", method)
			ctx.Assert(14*time.Second <= call.Timeout && call.Timeout <= 16*time.Second, "a %s call carries a %v deadline, expected 15 s", method, call.Timeout)
		}
	}
	slow := hStaged(ctx)
	peer.stallOnce[slow+"/2"] = true
	before := len(ctx.GRPC.CallsTo("PutChunk", ""))
	hComplete(ctx, slow, "with part 2 failing UNAVAILABLE after 10 s")
	retried := ctx.GRPC.CallsTo("PutChunk", "")[before:]
	ctx.Equal(hSentSince(ctx, before), []int32{1, 2, 2, 3}, "with part 2 failing UNAVAILABLE after 10 s, the parts sent")
	for _, call := range retried {
		ctx.Assert(call.HasDeadline() && 14*time.Second <= call.Timeout && call.Timeout <= 16*time.Second, "part %d was sent with a %v deadline after part 2's first attempt took 10 s: every attempt carries its own 15 s deadline, not what is left of one shared deadline", call.Request.(*pb.PutChunkRequest).GetPart(), call.Timeout)
	}
	stalled := hStaged(ctx)
	ctx.GRPC.SetLatency("PutChunk", 60.0, "")
	hFail(ctx, stalled, "with the object store taking 60 s per part")
	ctx.Assert(store.FindFile(hBg, store.FileIDFor(stalled)) == nil, "an upload whose parts timed out was indexed as a file")
}

func CheckChunkHash(ctx *harness.Ctx) {
	hObjectPeer(ctx)
	f := hComplete(ctx, hStaged(ctx), "with a healthy object store")
	for _, call := range ctx.GRPC.CallsTo("PutChunk", "") {
		req := call.Request.(*pb.PutChunkRequest)
		ctx.Equal(req.GetSha256(), hHexSum(req.GetData()), "part %d must carry the SHA-256 of its bytes (without it the store cannot verify the part or dedupe a retry); its sha256", req.GetPart())
	}
	ctx.Equal(f.Digest, hWhole, "the file must be indexed with the object's digest")
}

func CheckRetryInPlace(ctx *harness.Ctx) {
	peer := hObjectPeer(ctx)
	uploadID := hStaged(ctx)
	peer.failOnce[uploadID+"/2"] = true
	f := hComplete(ctx, uploadID, "with part 2 failing once UNAVAILABLE")
	ctx.Equal(hSentSince(ctx, 0), []int32{1, 2, 2, 3}, "with part 2 failing once UNAVAILABLE, retry the part that failed and not the upload; the parts sent")
	ctx.Assert(f.Digest == hWhole && store.FindFile(hBg, f.FileID) != nil, "the retried upload must be committed and indexed, got %+v", f)
	refused := hStaged(ctx)
	ctx.GRPC.Fail("PutChunk", codes.InvalidArgument, "part rejected", 1, "")
	before := len(ctx.GRPC.CallsTo("PutChunk", ""))
	hFail(ctx, refused, "with part 1 rejected INVALID_ARGUMENT")
	ctx.Equal(len(ctx.GRPC.CallsTo("PutChunk", ""))-before, 1, "only UNAVAILABLE and DEADLINE_EXCEEDED are worth a retry; the sends of a part rejected INVALID_ARGUMENT")
	ctx.Assert(ctx.Clock.Sleeps() <= 1, "the client slept %d times: one backoff for the one retryable failure", ctx.Clock.Sleeps())
	for _, code := range []codes.Code{codes.FailedPrecondition, codes.PermissionDenied, codes.Internal, codes.ResourceExhausted} {
		terminal := hStaged(ctx)
		ctx.GRPC.Fail("PutChunk", code, "part rejected", 1, "")
		before = len(ctx.GRPC.CallsTo("PutChunk", ""))
		hFail(ctx, terminal, "with part 1 rejected "+code.String())
		ctx.Equal(len(ctx.GRPC.CallsTo("PutChunk", ""))-before, 1, "only UNAVAILABLE and DEADLINE_EXCEEDED are worth a retry; the sends of a part rejected %v", code)
	}
	timedOut := hStaged(ctx)
	ctx.GRPC.Fail("PutChunk", codes.DeadlineExceeded, "deadline exceeded", 1, "")
	before = len(ctx.GRPC.CallsTo("PutChunk", ""))
	hComplete(ctx, timedOut, "with part 1 failing DEADLINE_EXCEEDED once (a retryable status)")
	ctx.Equal(hSentSince(ctx, before), []int32{1, 1, 2, 3}, "with part 1 failing DEADLINE_EXCEEDED once (it is retried), the parts sent")
	third := hStaged(ctx)
	ctx.GRPC.Fail("PutChunk", codes.Unavailable, "connection reset by peer", 2, "")
	before = len(ctx.GRPC.CallsTo("PutChunk", ""))
	hComplete(ctx, third, "with part 1 failing UNAVAILABLE twice (ATTEMPTS = 3 tries)")
	ctx.Equal(hSentSince(ctx, before), []int32{1, 1, 1, 2, 3}, "with part 1 failing UNAVAILABLE twice (3 tries), the parts sent")
	exhausted := hStaged(ctx)
	ctx.GRPC.Fail("PutChunk", codes.Unavailable, "connection reset by peer", 3, "")
	before = len(ctx.GRPC.CallsTo("PutChunk", ""))
	hFail(ctx, exhausted, "with part 1 failing UNAVAILABLE three times")
	ctx.Equal(hSentSince(ctx, before), []int32{1, 1, 1}, "with part 1 failing UNAVAILABLE three times (give up after 3 tries), the parts sent")
	ctx.Assert(store.FindFile(hBg, store.FileIDFor(exhausted)) == nil, "an upload whose part 1 never reached the store was indexed as a file")
}

func CheckCommitGate(ctx *harness.Ctx) {
	hObjectPeer(ctx)
	uploadID := hStaged(ctx)
	fileID := store.FileIDFor(uploadID)
	ctx.GRPC.Fail("CommitMultipart", codes.Unavailable, "store restarting", 1, "")
	hFail(ctx, uploadID, "with CommitMultipart failing UNAVAILABLE")
	ctx.Assert(store.FindFile(hBg, fileID) == nil, "the commit failed and file:%s was indexed anyway: readers find a file whose object does not exist", fileID)
	s, _ := sessions.FindSession(hBg, uploadID)
	ctx.Assert(s != nil, "a failed commit dropped the session: the upload can no longer be finished")
	f := hComplete(ctx, uploadID, "retrying after the failed commit")
	ctx.Assert(f.ObjectKey == "objects/"+uploadID && f.Digest == hWhole, "the index must record the object key and digest CommitMultipart answered, got %+v", f)
	ctx.Equal(store.FindFile(hBg, fileID).State, "committed", "after a successful retry, the file's state")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <openssl/sha.h>

#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "file_storage.grpc.pb.h"
#include "files/sessions.h"
#include "files/store.h"

namespace {

std::string hSequence32() {
  std::string out;
  for (int i = 0; i < 32; i++) out += static_cast<char>(i);
  return out;
}

const std::vector<std::string> hParts = {std::string("\\x89PNG\\r\\n\\x1a\\n", 8) + std::string(24, '\\0'), hSequence32(), "tailtailtailtail"};

std::string hSha(const std::string& data) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(data.data()), data.size(), digest);
  std::string hex;
  char byte[3];
  for (unsigned char b : digest) {
    std::snprintf(byte, sizeof byte, "%02x", b);
    hex += byte;
  }
  return hex;
}

std::string hWhole() { return hSha(hParts[0] + hParts[1] + hParts[2]); }

// Keeps parts per upload; a part in fail_once fails UNAVAILABLE on its first write, one in stall_once after 10 s.
class HObjectStorePeer final : public stored::ObjectStore::Service {
 public:
  explicit HObjectStorePeer(harness::Clock& clock) : clock_(clock) {}
  std::map<std::string, std::string> parts;
  std::set<std::string> fail_once;
  std::set<std::string> stall_once;

  grpc::Status PutChunk(grpc::ServerContext*, const stored::PutChunkRequest* req, stored::PutChunkReply* reply) override {
    const std::string key = req->upload_id() + "/" + std::to_string(req->part());
    if (fail_once.erase(key)) return grpc::Status(grpc::StatusCode::UNAVAILABLE, "connection reset by peer");
    if (stall_once.erase(key)) {
      clock_.Advance(10);
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "connection reset by peer after 10 s");
    }
    if (!req->sha256().empty() && req->sha256() != hSha(req->data())) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "sha256 does not match the part");
    const auto previous = parts.find(key);
    reply->set_deduped(!req->sha256().empty() && previous != parts.end() && hSha(previous->second) == req->sha256());
    parts[key] = req->data();
    reply->set_part(req->part());
    return grpc::Status::OK;
  }

  grpc::Status CommitMultipart(grpc::ServerContext*, const stored::CommitRequest* req, stored::CommitReply* reply) override {
    std::string data;
    for (int n : req->parts()) {
      const auto part = parts.find(req->upload_id() + "/" + std::to_string(n));
      if (part == parts.end()) return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, "part " + std::to_string(n) + " was never written");
      data += part->second;
    }
    reply->set_object_key("objects/" + req->upload_id());
    reply->set_digest(hSha(data));
    reply->set_size(static_cast<long long>(data.size()));
    return grpc::Status::OK;
  }

 private:
  harness::Clock& clock_;
};

HObjectStorePeer& hObjectPeer(harness::Ctx& ctx) {
  static HObjectStorePeer* peer = nullptr;
  delete peer;
  peer = new HObjectStorePeer(ctx.Clock);
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::string hStaged() {
  long long total = 0;
  for (const auto& p : hParts) total += static_cast<long long>(p.size());
  const std::string upload_id = sessions::openSession("t1", total, "image/png", "holiday.png").value_or("");
  for (size_t i = 0; i < hParts.size(); i++) {
    store::stagePart(upload_id, static_cast<int>(i + 1), hParts[i]);
    sessions::ackPart(upload_id, static_cast<int>(i + 1), static_cast<long long>(hParts[i].size()));
  }
  return upload_id;
}

store::File hComplete(harness::Ctx& ctx, const std::string& upload_id, const std::string& why) {
  try {
    return complete(upload_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: complete(%s) threw %s: %s", why, upload_id, harness::CurrentExceptionType(), e.what());
  }
}

void hFail(harness::Ctx& ctx, const std::string& upload_id, const std::string& why) {
  try {
    complete(upload_id);
  } catch (const std::exception&) {
    return;
  }
  ctx.Fatalf("%s: complete returned a file instead of throwing", why);
}

// The part numbers of the PutChunk calls after the first before.
std::vector<int> hSentSince(harness::Ctx& ctx, size_t before) {
  std::vector<int> sent;
  const auto calls = ctx.GRPC.CallsTo("PutChunk");
  for (size_t i = before; i < calls.size(); i++) sent.push_back(calls[i].Request<stored::PutChunkRequest>().part());
  return sent;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  HObjectStorePeer& peer = hObjectPeer(ctx);
  hComplete(ctx, hStaged(), "with a healthy object store");
  for (const std::string method : {"PutChunk", "CommitMultipart"}) {
    const auto calls = ctx.GRPC.CallsTo(method);
    ctx.Assert(!calls.empty(), "no %s call was made", method);
    for (const auto& call : calls) {
      ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a stalled object store would hold the finalize open", method);
      ctx.Assert(14 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 16, "a %s call carries a %v s deadline, expected kDeadline = 15 s", method, call.TimeoutSeconds());
    }
  }
  const std::string slow = hStaged();
  peer.stall_once.insert(slow + "/2");
  const size_t before = ctx.GRPC.CallsTo("PutChunk").size();
  hComplete(ctx, slow, "with part 2 failing UNAVAILABLE after 10 s");
  ctx.Equal(hSentSince(ctx, before), {1, 2, 2, 3}, "with part 2 failing UNAVAILABLE after 10 s, the parts sent");
  const auto calls = ctx.GRPC.CallsTo("PutChunk");
  for (size_t i = before; i < calls.size(); i++) {
    ctx.Assert(calls[i].HasDeadline() && 14 <= calls[i].TimeoutSeconds() && calls[i].TimeoutSeconds() <= 16, "part %d was sent with a %v s deadline after part 2's first attempt took 10 s: every attempt carries its own kDeadline, not what is left of one shared deadline", calls[i].Request<stored::PutChunkRequest>().part(), calls[i].TimeoutSeconds());
  }
  const std::string stalled = hStaged();
  ctx.GRPC.SetLatency("PutChunk", 60.0);
  hFail(ctx, stalled, "with the object store taking 60 s per part");
  ctx.Assert(!store::findFile(store::fileIdFor(stalled)), "an upload whose parts timed out was indexed as a file");
}

void CheckChunkHash(harness::Ctx& ctx) {
  hObjectPeer(ctx);
  const store::File f = hComplete(ctx, hStaged(), "with a healthy object store");
  for (const auto& call : ctx.GRPC.CallsTo("PutChunk")) {
    const auto& req = call.Request<stored::PutChunkRequest>();
    ctx.Equal(req.sha256(), hSha(req.data()), "part %d must carry the SHA-256 of its bytes (without it the store cannot verify the part or dedupe a retry); its sha256", req.part());
  }
  ctx.Equal(f.digest, hWhole(), "the file must be indexed with the object's digest");
}

void CheckRetryInPlace(harness::Ctx& ctx) {
  HObjectStorePeer& peer = hObjectPeer(ctx);
  const std::string upload_id = hStaged();
  peer.fail_once.insert(upload_id + "/2");
  const store::File f = hComplete(ctx, upload_id, "with part 2 failing once UNAVAILABLE");
  ctx.Equal(hSentSince(ctx, 0), {1, 2, 2, 3}, "with part 2 failing once UNAVAILABLE, retry the part that failed and not the upload; the parts sent");
  ctx.Assert(f.digest == hWhole() && store::findFile(f.file_id).has_value(), "the retried upload must be committed and indexed (digest %s)", f.digest);
  const std::string refused = hStaged();
  ctx.GRPC.Fail("PutChunk", grpc::StatusCode::INVALID_ARGUMENT, "part rejected", 1);
  size_t before = ctx.GRPC.CallsTo("PutChunk").size();
  hFail(ctx, refused, "with part 1 rejected INVALID_ARGUMENT");
  ctx.Equal(ctx.GRPC.CallsTo("PutChunk").size() - before, 1, "only UNAVAILABLE and DEADLINE_EXCEEDED are worth a retry; the sends of a part rejected INVALID_ARGUMENT");
  ctx.Assert(ctx.Clock.Sleeps() <= 1, "the client slept %d times: one backoff for the one retryable failure", ctx.Clock.Sleeps());
  const std::vector<std::pair<grpc::StatusCode, std::string>> terminal_codes = {
      {grpc::StatusCode::FAILED_PRECONDITION, "FAILED_PRECONDITION"},
      {grpc::StatusCode::PERMISSION_DENIED, "PERMISSION_DENIED"},
      {grpc::StatusCode::INTERNAL, "INTERNAL"},
      {grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"},
  };
  for (const auto& [code, name] : terminal_codes) {
    const std::string terminal = hStaged();
    ctx.GRPC.Fail("PutChunk", code, "part rejected", 1);
    before = ctx.GRPC.CallsTo("PutChunk").size();
    hFail(ctx, terminal, "with part 1 rejected " + name);
    ctx.Equal(ctx.GRPC.CallsTo("PutChunk").size() - before, 1, "only UNAVAILABLE and DEADLINE_EXCEEDED are worth a retry; the sends of a part rejected %s", name);
  }
  const std::string timed_out = hStaged();
  ctx.GRPC.Fail("PutChunk", grpc::StatusCode::DEADLINE_EXCEEDED, "deadline exceeded", 1);
  before = ctx.GRPC.CallsTo("PutChunk").size();
  hComplete(ctx, timed_out, "with part 1 failing DEADLINE_EXCEEDED once (a retryable status)");
  ctx.Equal(hSentSince(ctx, before), {1, 1, 2, 3}, "with part 1 failing DEADLINE_EXCEEDED once (it is retried), the parts sent");
  const std::string third = hStaged();
  ctx.GRPC.Fail("PutChunk", grpc::StatusCode::UNAVAILABLE, "connection reset by peer", 2);
  before = ctx.GRPC.CallsTo("PutChunk").size();
  hComplete(ctx, third, "with part 1 failing UNAVAILABLE twice (kAttempts = 3 tries)");
  ctx.Equal(hSentSince(ctx, before), {1, 1, 1, 2, 3}, "with part 1 failing UNAVAILABLE twice (3 tries), the parts sent");
  const std::string exhausted = hStaged();
  ctx.GRPC.Fail("PutChunk", grpc::StatusCode::UNAVAILABLE, "connection reset by peer", 3);
  before = ctx.GRPC.CallsTo("PutChunk").size();
  hFail(ctx, exhausted, "with part 1 failing UNAVAILABLE three times");
  ctx.Equal(hSentSince(ctx, before), {1, 1, 1}, "with part 1 failing UNAVAILABLE three times (give up after 3 tries), the parts sent");
  ctx.Assert(!store::findFile(store::fileIdFor(exhausted)), "an upload whose part 1 never reached the store was indexed as a file");
}

void CheckCommitGate(harness::Ctx& ctx) {
  hObjectPeer(ctx);
  const std::string upload_id = hStaged();
  const std::string file_id = store::fileIdFor(upload_id);
  ctx.GRPC.Fail("CommitMultipart", grpc::StatusCode::UNAVAILABLE, "store restarting", 1);
  hFail(ctx, upload_id, "with CommitMultipart failing UNAVAILABLE");
  ctx.Assert(!store::findFile(file_id), "the commit failed and file:%s was indexed anyway: readers find a file whose object does not exist", file_id);
  ctx.Assert(sessions::findSession(upload_id).has_value(), "a failed commit dropped the session: the upload can no longer be finished");
  const store::File f = hComplete(ctx, upload_id, "retrying after the failed commit");
  ctx.Assert(f.object_key == "objects/" + upload_id && f.digest == hWhole(), "the index must record the object key and digest CommitMultipart answered, got %s and %s", f.object_key, f.digest);
  ctx.Equal(store::findFile(file_id)->state, "committed", "after a successful retry, the file's state");
}
`,
  },
  hints: [
    'Fail part 2 once with UNAVAILABLE: part 1 is sent again. Fail CommitMultipart: the file is in the index anyway, with a digest the store never computed. Slow the store down: the finalize waits as long as it does.',
    'The retry loop wraps every part, so any failure restarts from part 1, and it catches every status, including ones a retry cannot fix. No call has a deadline, no request carries a hash, and `commit_file` runs before the commit.',
    'Build the request once with `sha256=hashlib.sha256(data).hexdigest()`; loop inside `put_part` up to `ATTEMPTS`, `timeout=DEADLINE_S`, re-raising unless the code is UNAVAILABLE or DEADLINE_EXCEEDED. In `complete`, call `CommitMultipart` with a deadline, then `commit_file` with its `object_key` and `digest`.',
  ],
  debrief: `A multipart upload exists so that a failure costs one part, which is why the retry lives inside \`put_part\`, carries the same hash every time, and gives up on statuses that say the request itself is wrong. The hash also turns a retry after a lost reply into a no-op on the store's side. The commit is the moment the object exists, so the index is written from what \`CommitMultipart\` answered, and a failed commit leaves the session for the caller to try again. S3 goes further at the storage layer: \`ListParts\` lets a client that lost its own state resume from what the store holds, and a lifecycle rule aborts incomplete uploads after a set number of days.`,
};
