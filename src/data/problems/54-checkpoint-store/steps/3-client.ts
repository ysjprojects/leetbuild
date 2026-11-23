import type {Step} from '@/lib/types';

export const storageClientStep: Step = {
  id: 'dependency',
  title: 'Object-store writes that confirm the checksum',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['api', 'store'],
  task: `## Task

**Starting point.** The starter is the object-store writer the chunk copier calls for every staged
chunk: \`store_chunk(upload_id, index, payload)\` sends \`PutObject\` over gRPC (key
\`{upload_id}/{index}\`, the bytes, their \`store.digest\`) and returns the \`sha256\` the store
answers. Any error is retried, up to five attempts, then \`StoreUnavailable\`. With a healthy store it
copies the demo upload, and it hides four flaws.

**Failure mode the checks target.** A store that hangs pins the copier for good; bytes flipped on
the way are acknowledged as stored; a store that is down costs five attempts per chunk; and a
bucket that refuses the service account is retried as if it were busy, its reason lost.

\`\`\`proto
service ObjectStore { rpc PutObject(PutObjectRequest) returns (PutObjectReply); }  // reply.sha256: the bytes received
\`\`\`

- Every call carries a **30 s** deadline (\`DEADLINE_S\`).
- A reply whose \`sha256\` differs from the local digest raises \`ChecksumMismatch\`.
- \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried, **\`MAX_ATTEMPTS\` = 3** attempts in all,
  then \`StoreUnavailable\`.
- Any other status, \`PERMISSION_DENIED\` among them, raises \`UploadRejected\` at once, carrying the
  store's details.`,
  sequence: {
    participants: ['Chunk copier', 'Object store'],
    messages: [
      {from: 'Chunk copier', to: 'Object store', label: 'PutObject u-1/0 · sha256 · deadline 30 s', kind: 'sync'},
      {from: 'Object store', to: 'Chunk copier', label: 'UNAVAILABLE → retry (3 attempts in all)', kind: 'reply'},
      {from: 'Chunk copier', to: 'Object store', label: 'PutObject u-1/0 · attempt 2', kind: 'sync'},
      {from: 'Object store', to: 'Chunk copier', label: 'PutObjectReply sha256 = received bytes', kind: 'reply'},
      {from: 'Chunk copier', to: 'Chunk copier', label: 'reply.sha256 ≠ digest → ChecksumMismatch', kind: 'sync'},
      {from: 'Object store', to: 'Chunk copier', label: 'PERMISSION_DENIED → UploadRejected(details)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'store-deadline',
      title: 'Every PutObject carries a 30-second deadline',
      detail:
        'Each call, every retry included, is made with its own full `DEADLINE_S` (30 s), so a store that stops answering gets three attempts and costs at most three deadlines. The starter calls with no deadline, so one hung store pins the copier.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*30\b/, /PutObject\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*30_?000\b/, /PutObject\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*30\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        cpp: {all: [/kDeadline\{30\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'checksum-confirmed',
      title: 'A chunk counts as stored only when the store’s checksum matches',
      detail:
        'The `sha256` in the reply is compared with the local digest and a difference raises `ChecksumMismatch`. The starter returns whatever checksum the store answered.',
      match: {
        python: {all: [/raise ChecksumMismatch/, /reply\.sha256\s*!=\s*\w+|\w+\s*!=\s*reply\.sha256/]},
        typescript: {all: [/throw new ChecksumMismatch/, /reply\.sha256\s*!==\s*\w+|\w+\s*!==\s*reply\.sha256/]},
        go: {all: [/fmt\.Errorf\("%w[^\n]*ErrChecksumMismatch/, /reply\.GetSha256\(\)\s*!=\s*\w+/]},
        cpp: {all: [/throw ChecksumMismatch/, /reply\.sha256\(\)\s*!=\s*\w+/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries UNAVAILABLE and DEADLINE_EXCEEDED, three attempts in all',
      detail:
        'Two `UNAVAILABLE` answers and a success store the chunk on the third attempt, and a `DEADLINE_EXCEEDED` answer and a success on the second; a store that stays down gets exactly three attempts, then `StoreUnavailable`. The starter makes five.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/range\(5\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/attempt\s*<\s*5/]},
        go: {
          all: [/maxAttempts\s*=\s*3\b/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/attempt\s*<\s*5/],
        },
        cpp: {all: [/kMaxAttempts\s*=\s*3\b/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/attempt\s*<\s*5/]},
      },
    },
    {
      id: 'permission-stops',
      title: 'PERMISSION_DENIED stops at once with the store’s reason',
      detail:
        'A status outside the retryable pair (`PERMISSION_DENIED`, `INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`, `INTERNAL`) raises `UploadRejected` after one call, its message carrying the store’s details. The starter retries it like a busy store and drops the reason.',
      match: {
        python: {all: [/raise UploadRejected\([^\n]*details\(\)/]},
        typescript: {all: [/throw new UploadRejected\([^\n]*details/]},
        go: {all: [/fmt\.Errorf\("%w[^\n]*ErrUploadRejected[^\n]*Message\(\)/]},
        cpp: {all: [/throw UploadRejected\([^\n]*error_message\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import checkpoint_store_pb2
import checkpoint_store_pb2_grpc
from checkpoint import store  # digest

objects = checkpoint_store_pb2_grpc.ObjectStoreStub(grpc.insecure_channel("objstore:9000"))


class StoreUnavailable(Exception):
    """The object store did not take the chunk: the copier tries it again later."""


class UploadRejected(Exception):
    """The object store refused the chunk for good: the upload stops."""


class ChecksumMismatch(Exception):
    """The store received other bytes than were sent: the chunk is not stored."""


def store_chunk(upload_id: str, index: int, payload: bytes) -> str:
    """Write a staged chunk to the object store under {upload_id}/{index}; returns the checksum the store confirmed."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    digest = store.digest(payload)
    key = f"{upload_id}/{index}"
    request = checkpoint_store_pb2.PutObjectRequest(key=key, data=payload, sha256=digest)
    for attempt in range(5):
        try:
            reply = objects.PutObject(request)
        except grpc.RpcError:
            continue  # the store is flaky: try again
        return reply.sha256
    raise StoreUnavailable(f"object store did not take {key}")
`,
      solution: `import grpc

import checkpoint_store_pb2
import checkpoint_store_pb2_grpc
from checkpoint import store  # digest

DEADLINE_S = 30
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

objects = checkpoint_store_pb2_grpc.ObjectStoreStub(grpc.insecure_channel("objstore:9000"))


class StoreUnavailable(Exception):
    """The object store did not take the chunk: the copier tries it again later."""


class UploadRejected(Exception):
    """The object store refused the chunk for good: the upload stops."""


class ChecksumMismatch(Exception):
    """The store received other bytes than were sent: the chunk is not stored."""


def store_chunk(upload_id: str, index: int, payload: bytes) -> str:
    """Write a staged chunk to the object store under {upload_id}/{index}; returns the checksum the store confirmed."""
    digest = store.digest(payload)
    key = f"{upload_id}/{index}"
    request = checkpoint_store_pb2.PutObjectRequest(key=key, data=payload, sha256=digest)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = objects.PutObject(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                # PERMISSION_DENIED and the like are the store's final answer: another attempt cannot change it.
                raise UploadRejected(f"{key}: {exc.code().name}: {exc.details()}") from exc
            if attempt == MAX_ATTEMPTS:
                raise StoreUnavailable(f"{key}: {exc.code().name} after {attempt} attempts") from exc
            continue
        if reply.sha256 != digest:
            # The store holds other bytes than the ones sent: acknowledging them hands a resume corrupt weights.
            raise ChecksumMismatch(f"{key}: the store confirmed {reply.sha256}, the chunk is {digest}")
        return reply.sha256
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {digest} from 'checkpoint/store';

interface PutObjectRequest {
  key: string;
  data: Buffer;
  sha256: string;
}

interface PutObjectReply {
  key: string;
  sha256: string;
  size: number | string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('checkpoint_store.proto')) as unknown as {
  ckptstore: {ObjectStore: grpc.ServiceClientConstructor};
};
const objects = new pkg.ckptstore.ObjectStore('objstore:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  PutObject(request: PutObjectRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<PutObjectReply>;
};

/** The object store did not take the chunk: the copier tries it again later. */
export class StoreUnavailable extends Error {}
/** The object store refused the chunk for good: the upload stops. */
export class UploadRejected extends Error {}
/** The store received other bytes than were sent: the chunk is not stored. */
export class ChecksumMismatch extends Error {}

/** Write a staged chunk to the object store under {upload_id}/{index}; resolves the checksum the store confirmed. */
export async function storeChunk(uploadId: string, index: number, payload: Buffer): Promise<string> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const sha = digest(payload);
  const key = \`\${uploadId}/\${index}\`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const reply = await objects.PutObject({key, data: payload, sha256: sha}, new grpc.Metadata(), {});
      return reply.sha256;
    } catch {
      // the store is flaky: try again
    }
  }
  throw new StoreUnavailable(\`object store did not take \${key}\`);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {digest} from 'checkpoint/store';

export const DEADLINE_MS = 30_000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface PutObjectRequest {
  key: string;
  data: Buffer;
  sha256: string;
}

interface PutObjectReply {
  key: string;
  sha256: string;
  size: number | string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('checkpoint_store.proto')) as unknown as {
  ckptstore: {ObjectStore: grpc.ServiceClientConstructor};
};
const objects = new pkg.ckptstore.ObjectStore('objstore:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  PutObject(request: PutObjectRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<PutObjectReply>;
};

/** The object store did not take the chunk: the copier tries it again later. */
export class StoreUnavailable extends Error {}
/** The object store refused the chunk for good: the upload stops. */
export class UploadRejected extends Error {}
/** The store received other bytes than were sent: the chunk is not stored. */
export class ChecksumMismatch extends Error {}

/** Write a staged chunk to the object store under {upload_id}/{index}; resolves the checksum the store confirmed. */
export async function storeChunk(uploadId: string, index: number, payload: Buffer): Promise<string> {
  const sha = digest(payload);
  const key = \`\${uploadId}/\${index}\`;
  for (let attempt = 1; ; attempt += 1) {
    let reply: PutObjectReply;
    try {
      reply = await objects.PutObject({key, data: payload, sha256: sha}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      // PERMISSION_DENIED and the like are the store's final answer: another attempt cannot change it.
      if (!RETRYABLE.has(code)) throw new UploadRejected(\`\${key}: \${grpc.status[code]}: \${details}\`);
      if (attempt === MAX_ATTEMPTS) throw new StoreUnavailable(\`\${key}: \${grpc.status[code]} after \${attempt} attempts\`);
      continue;
    }
    if (reply.sha256 !== sha) {
      // The store holds other bytes than the ones sent: acknowledging them hands a resume corrupt weights.
      throw new ChecksumMismatch(\`\${key}: the store confirmed \${reply.sha256}, the chunk is \${sha}\`);
    }
    return reply.sha256;
  }
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

	"checkpoint/store" // store.Digest
	pb "ckptstore/gen/checkpoint_store"
)

var (
	objectsConn, _ = grpc.NewClient("objstore:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	objects        = pb.NewObjectStoreClient(objectsConn)
)

var (
	// ErrStoreUnavailable: the object store did not take the chunk, the copier tries it again later.
	ErrStoreUnavailable = errors.New("object store unavailable")
	// ErrUploadRejected: the object store refused the chunk for good, the upload stops.
	ErrUploadRejected = errors.New("upload rejected")
	// ErrChecksumMismatch: the store received other bytes than were sent, the chunk is not stored.
	ErrChecksumMismatch = errors.New("checksum mismatch")
)

// storeChunk writes a staged chunk to the object store under {upload_id}/{index} and returns the
// checksum the store confirmed.
func storeChunk(ctx context.Context, uploadID string, index int64, payload []byte) (string, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	digest := store.Digest(payload)
	key := fmt.Sprintf("%s/%d", uploadID, index)
	for attempt := 0; attempt < 5; attempt++ {
		reply, err := objects.PutObject(ctx, &pb.PutObjectRequest{Key: key, Data: payload, Sha256: digest})
		if err != nil {
			continue // the store is flaky: try again
		}
		return reply.GetSha256(), nil
	}
	return "", fmt.Errorf("%w: object store did not take %s", ErrStoreUnavailable, key)
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

	"checkpoint/store" // store.Digest
	pb "ckptstore/gen/checkpoint_store"
)

const (
	deadline    = 30 * time.Second
	maxAttempts = 3
)

var (
	objectsConn, _ = grpc.NewClient("objstore:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	objects        = pb.NewObjectStoreClient(objectsConn)
)

var (
	// ErrStoreUnavailable: the object store did not take the chunk, the copier tries it again later.
	ErrStoreUnavailable = errors.New("object store unavailable")
	// ErrUploadRejected: the object store refused the chunk for good, the upload stops.
	ErrUploadRejected = errors.New("upload rejected")
	// ErrChecksumMismatch: the store received other bytes than were sent, the chunk is not stored.
	ErrChecksumMismatch = errors.New("checksum mismatch")
)

// storeChunk writes a staged chunk to the object store under {upload_id}/{index} and returns the
// checksum the store confirmed.
func storeChunk(ctx context.Context, uploadID string, index int64, payload []byte) (string, error) {
	digest := store.Digest(payload)
	key := fmt.Sprintf("%s/%d", uploadID, index)
	request := &pb.PutObjectRequest{Key: key, Data: payload, Sha256: digest}
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := objects.PutObject(callCtx, request)
		cancel()
		if err != nil {
			code := status.Code(err)
			if code != codes.Unavailable && code != codes.DeadlineExceeded {
				// PERMISSION_DENIED and the like are the store's final answer: another attempt cannot change it.
				return "", fmt.Errorf("%w: %s: %v: %s", ErrUploadRejected, key, code, status.Convert(err).Message())
			}
			if attempt == maxAttempts {
				return "", fmt.Errorf("%w: %s: %v after %d attempts", ErrStoreUnavailable, key, code, attempt)
			}
			continue
		}
		if reply.GetSha256() != digest {
			// The store holds other bytes than the ones sent: acknowledging them hands a resume corrupt weights.
			return "", fmt.Errorf("%w: %s: the store confirmed %s, the chunk is %s", ErrChecksumMismatch, key, reply.GetSha256(), digest)
		}
		return reply.GetSha256(), nil
	}
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>

#include "checkpoint/store.h"  // store::digest
#include "checkpoint_store.grpc.pb.h"

auto objects = ckptstore::ObjectStore::NewStub(grpc::CreateChannel("objstore:9000", grpc::InsecureChannelCredentials()));

// The object store did not take the chunk: the copier tries it again later.
struct StoreUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The object store refused the chunk for good: the upload stops.
struct UploadRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The store received other bytes than were sent: the chunk is not stored.
struct ChecksumMismatch : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Write a staged chunk to the object store under {upload_id}/{index}; returns the checksum the store confirmed.
std::string storeChunk(const std::string& upload_id, long index, const std::string& payload) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string digest = store::digest(payload);
  const std::string key = upload_id + "/" + std::to_string(index);
  ckptstore::PutObjectRequest request;
  request.set_key(key);
  request.set_data(payload);
  request.set_sha256(digest);
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    ckptstore::PutObjectReply reply;
    if (objects->PutObject(&ctx, request, &reply).ok()) return reply.sha256();
    // the store is flaky: try again
  }
  throw StoreUnavailable("object store did not take " + key);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <stdexcept>
#include <string>

#include "checkpoint/store.h"  // store::digest
#include "checkpoint_store.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{30};
constexpr int kMaxAttempts = 3;
const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

auto objects = ckptstore::ObjectStore::NewStub(grpc::CreateChannel("objstore:9000", grpc::InsecureChannelCredentials()));

// The object store did not take the chunk: the copier tries it again later.
struct StoreUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The object store refused the chunk for good: the upload stops.
struct UploadRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};
// The store received other bytes than were sent: the chunk is not stored.
struct ChecksumMismatch : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Write a staged chunk to the object store under {upload_id}/{index}; returns the checksum the store confirmed.
std::string storeChunk(const std::string& upload_id, long index, const std::string& payload) {
  const std::string digest = store::digest(payload);
  const std::string key = upload_id + "/" + std::to_string(index);
  ckptstore::PutObjectRequest request;
  request.set_key(key);
  request.set_data(payload);
  request.set_sha256(digest);
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    ckptstore::PutObjectReply reply;
    const grpc::Status status = objects->PutObject(&ctx, request, &reply);
    if (status.ok()) {
      // The store holds other bytes than the ones sent: acknowledging them hands a resume corrupt weights.
      if (reply.sha256() != digest) throw ChecksumMismatch(key + ": the store confirmed " + reply.sha256() + ", the chunk is " + digest);
      return reply.sha256();
    }
    // PERMISSION_DENIED and the like are the store's final answer: another attempt cannot change it.
    if (!kRetryable.count(status.error_code())) throw UploadRejected(key + ": " + status.error_message());
    if (attempt == kMaxAttempts) throw StoreUnavailable(key + ": " + status.error_message() + " after " + std::to_string(attempt) + " attempts");
  }
}
`,
    },
  },
  harness: {
    python: `import grpc

import checkpoint_store_pb2
import checkpoint_store_pb2_grpc
from checkpoint import store

PAYLOAD = b"layer-0 weights"
DIGEST = store.digest(PAYLOAD)


class ObjectStore(checkpoint_store_pb2_grpc.ObjectStoreServicer):
    """Stores every object; the keys in corrupt arrive with their last byte flipped."""

    def __init__(self):
        self.objects = {}
        self.corrupt = set()

    def PutObject(self, request, context):
        data = bytes(request.data)
        if request.key in self.corrupt:
            data = data[:-1] + bytes([data[-1] ^ 1])
        self.objects[request.key] = data
        return checkpoint_store_pb2.PutObjectReply(key=request.key, sha256=store.digest(data), size=len(data))


def _client(ctx):
    peer = ObjectStore()
    ctx.grpc.serve(checkpoint_store_pb2_grpc.add_ObjectStoreServicer_to_server, peer)
    return ctx.load("client"), peer


def _raises(m, exc, why, index=0):
    try:
        got = m.store_chunk("u-1", index, PAYLOAD)
    except exc as e:
        return e
    except Exception as other:
        raise AssertionError(f"{why}: store_chunk raised {type(other).__name__}: {other}, expected {exc.__name__}")
    raise AssertionError(f"{why}: store_chunk returned {got!r} instead of raising {exc.__name__}")


def _calls(ctx):
    return len(ctx.grpc.calls_to("PutObject"))


def check_store_deadline(ctx):
    m, peer = _client(ctx)
    assert m.store_chunk("u-1", 0, PAYLOAD) == DIGEST, "with a healthy store the chunk must be stored and its checksum returned"
    assert peer.objects.get("u-1/0") == PAYLOAD, f"the store holds {sorted(peer.objects)}, expected the chunk under u-1/0"
    for call in ctx.grpc.calls_to("PutObject"):
        assert call.timeout is not None, "a PutObject call carries no deadline: a store that stops answering pins the copier for good"
        assert 29.5 <= call.timeout <= 30.5, f"a PutObject call carries a {call.timeout} s deadline, expected DEADLINE_S = 30"
    ctx.grpc.set_latency("PutObject", 120.0)
    before = ctx.clock.time()
    _raises(m, m.StoreUnavailable, "with a store that answers after two minutes", index=1)
    waited = ctx.clock.time() - before
    assert waited <= 95, f"store_chunk waited {waited:.0f} s on a store that does not answer: three attempts of 30 s at most"
    hung = ctx.grpc.calls_to("PutObject")[1:]
    assert len(hung) == 3, f"a store that never answers in time got {len(hung)} attempts at one chunk, expected MAX_ATTEMPTS = 3: DEADLINE_EXCEEDED is retried like UNAVAILABLE"
    timeouts = [call.timeout for call in hung]
    assert all(t is not None and 29.5 <= t <= 30.5 for t in timeouts), f"the attempts at a hung store carried deadlines of {timeouts} s: every attempt gets its own full DEADLINE_S = 30, not what is left of the first"


def check_checksum_confirmed(ctx):
    m, peer = _client(ctx)
    peer.corrupt.add("u-1/0")
    _raises(m, m.ChecksumMismatch, "with the store receiving chunk u-1/0 with a byte flipped")
    peer.corrupt.clear()
    assert m.store_chunk("u-1", 0, PAYLOAD) == DIGEST, "once the bytes arrive intact the chunk must be stored and its checksum returned"


def check_bounded_retry(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("PutObject", grpc.StatusCode.UNAVAILABLE, "object store restarting", times=2)
    assert m.store_chunk("u-1", 0, PAYLOAD) == DIGEST, "two UNAVAILABLE answers and then a success: the third attempt must store the chunk"
    assert _calls(ctx) == 3, f"two UNAVAILABLE answers and a success took {_calls(ctx)} calls, expected 3"
    ctx.grpc.fail("PutObject", grpc.StatusCode.UNAVAILABLE, "object store overloaded", times=10)
    _raises(m, m.StoreUnavailable, "with a store that keeps answering UNAVAILABLE", index=1)
    attempts = _calls(ctx) - 3
    assert attempts == 3, f"a store that stays UNAVAILABLE got {attempts} attempts at one chunk, expected MAX_ATTEMPTS = 3"
    ctx.grpc.failures.clear()
    ctx.grpc.fail("PutObject", grpc.StatusCode.DEADLINE_EXCEEDED, "object store busy", times=1)
    assert m.store_chunk("u-1", 2, PAYLOAD) == DIGEST, "a DEADLINE_EXCEEDED answer and then a success: the second attempt must store the chunk"
    assert _calls(ctx) - 6 == 2, f"a DEADLINE_EXCEEDED answer and a success took {_calls(ctx) - 6} calls, expected 2"


def check_permission_stops(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("PutObject", grpc.StatusCode.PERMISSION_DENIED, "bucket ckpt-prod is read-only for this service account", times=1)
    e = _raises(m, m.UploadRejected, "with the bucket refusing the service account")
    assert _calls(ctx) == 1, f"PERMISSION_DENIED was retried ({_calls(ctx)} calls): another attempt cannot change the store's answer"
    assert "read-only" in str(e), f"UploadRejected says {str(e)!r}: the store's details (the bucket is read-only) must reach the operator"
    for code, details in ((grpc.StatusCode.INVALID_ARGUMENT, "object key u-1/0 is malformed"), (grpc.StatusCode.RESOURCE_EXHAUSTED, "bucket ckpt-prod is over its quota"), (grpc.StatusCode.INTERNAL, "object store write path failed")):
        before = _calls(ctx)
        ctx.grpc.fail("PutObject", code, details, times=1)
        e = _raises(m, m.UploadRejected, f"with the store answering {code.name}")
        assert _calls(ctx) - before == 1, f"{code.name} was retried ({_calls(ctx) - before} calls): only UNAVAILABLE and DEADLINE_EXCEEDED are retried, any other status stops at once"
        assert details in str(e), f"UploadRejected for {code.name} says {str(e)!r}: the store's details ({details}) must reach the operator"
`,
    typescript: `const PAYLOAD = Buffer.from('layer-0 weights');

/** An object store that stores every object; the keys in corrupt arrive with their last byte flipped. */
function client(ctx) {
  const store = ctx.load('/support/checkpoint/store.ts');
  const pkg = ctx.proto('checkpoint_store.proto');
  const objects = new Map<string, string>();
  const corrupt = new Set<string>();
  ctx.grpc.serve(pkg.ckptstore.ObjectStore.service, {
    PutObject(call, callback) {
      const data = Buffer.from(call.request.data);
      if (corrupt.has(call.request.key)) data[data.length - 1] ^= 1;
      objects.set(call.request.key, data.toString());
      callback(null, {key: call.request.key, sha256: store.digest(data), size: data.length});
    },
  });
  return {m: ctx.load('client'), objects, corrupt, digest: store.digest(PAYLOAD)};
}

async function raises(m, exc, why: string, index = 0) {
  let got;
  try {
    got = await m.storeChunk('u-1', index, PAYLOAD);
  } catch (e) {
    if (e instanceof exc) return e;
    assert.fail(\`\${why}: storeChunk threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected \${exc.name}\`);
  }
  assert.fail(\`\${why}: storeChunk resolved \${JSON.stringify(got)} instead of throwing \${exc.name}\`);
}

const calls = (ctx): number => ctx.grpc.callsTo('PutObject').length;

export async function check_store_deadline(ctx) {
  const {m, objects, digest} = client(ctx);
  assert.equal(await m.storeChunk('u-1', 0, PAYLOAD), digest, 'with a healthy store the chunk must be stored and its checksum returned');
  assert.equal(objects.get('u-1/0'), PAYLOAD.toString(), 'the store must hold the chunk under u-1/0');
  for (const call of ctx.grpc.callsTo('PutObject')) {
    assert(call.timeout !== null, 'a PutObject call carries no deadline: a store that stops answering pins the copier for good');
    assert(29.5 <= call.timeout && call.timeout <= 30.5, \`a PutObject call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 30000\`);
  }
  ctx.grpc.setLatency('PutObject', 120.0);
  const before = ctx.clock.now();
  await raises(m, m.StoreUnavailable, 'with a store that answers after two minutes', 1);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 95, \`storeChunk waited \${waited.toFixed(0)} s on a store that does not answer: three attempts of 30 s at most\`);
  const hung = ctx.grpc.callsTo('PutObject').slice(1);
  assert.equal(hung.length, 3, \`a store that never answers in time got \${hung.length} attempts at one chunk, expected MAX_ATTEMPTS = 3: DEADLINE_EXCEEDED is retried like UNAVAILABLE\`);
  const timeouts = hung.map(call => call.timeout);
  assert(timeouts.every(t => t !== null && 29.5 <= t && t <= 30.5), \`the attempts at a hung store carried deadlines of \${JSON.stringify(timeouts)} s: every attempt gets its own full 30 s, not what is left of the first\`);
}

export async function check_checksum_confirmed(ctx) {
  const {m, corrupt, digest} = client(ctx);
  corrupt.add('u-1/0');
  await raises(m, m.ChecksumMismatch, 'with the store receiving chunk u-1/0 with a byte flipped');
  corrupt.clear();
  assert.equal(await m.storeChunk('u-1', 0, PAYLOAD), digest, 'once the bytes arrive intact the chunk must be stored and its checksum returned');
}

export async function check_bounded_retry(ctx) {
  const {m, digest} = client(ctx);
  ctx.grpc.fail('PutObject', ctx.grpc.status.UNAVAILABLE, 'object store restarting', 2);
  assert.equal(await m.storeChunk('u-1', 0, PAYLOAD), digest, 'two UNAVAILABLE answers and then a success: the third attempt must store the chunk');
  assert.equal(calls(ctx), 3, \`two UNAVAILABLE answers and a success took \${calls(ctx)} calls, expected 3\`);
  ctx.grpc.fail('PutObject', ctx.grpc.status.UNAVAILABLE, 'object store overloaded', 10);
  await raises(m, m.StoreUnavailable, 'with a store that keeps answering UNAVAILABLE', 1);
  const attempts = calls(ctx) - 3;
  assert.equal(attempts, 3, \`a store that stays UNAVAILABLE got \${attempts} attempts at one chunk, expected MAX_ATTEMPTS = 3\`);
  ctx.grpc.clearFailures();
  ctx.grpc.fail('PutObject', ctx.grpc.status.DEADLINE_EXCEEDED, 'object store busy', 1);
  assert.equal(await m.storeChunk('u-1', 2, PAYLOAD), digest, 'a DEADLINE_EXCEEDED answer and then a success: the second attempt must store the chunk');
  assert.equal(calls(ctx) - 6, 2, \`a DEADLINE_EXCEEDED answer and a success took \${calls(ctx) - 6} calls, expected 2\`);
}

export async function check_permission_stops(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('PutObject', ctx.grpc.status.PERMISSION_DENIED, 'bucket ckpt-prod is read-only for this service account', 1);
  const e = await raises(m, m.UploadRejected, 'with the bucket refusing the service account');
  assert.equal(calls(ctx), 1, \`PERMISSION_DENIED was retried (\${calls(ctx)} calls): another attempt cannot change the store's answer\`);
  assert((e as Error).message.includes('read-only'), \`UploadRejected says \${JSON.stringify((e as Error).message)}: the store's details (the bucket is read-only) must reach the operator\`);
  const terminal: [string, string][] = [
    ['INVALID_ARGUMENT', 'object key u-1/0 is malformed'],
    ['RESOURCE_EXHAUSTED', 'bucket ckpt-prod is over its quota'],
    ['INTERNAL', 'object store write path failed'],
  ];
  for (const [name, details] of terminal) {
    const before = calls(ctx);
    ctx.grpc.fail('PutObject', ctx.grpc.status[name], details, 1);
    const rejected = await raises(m, m.UploadRejected, \`with the store answering \${name}\`);
    assert.equal(calls(ctx) - before, 1, \`\${name} was retried (\${calls(ctx) - before} calls): only UNAVAILABLE and DEADLINE_EXCEEDED are retried, any other status stops at once\`);
    assert((rejected as Error).message.includes(details), \`UploadRejected for \${name} says \${JSON.stringify((rejected as Error).message)}: the store's details (\${details}) must reach the operator\`);
  }
}
`,
    go: `package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	"checkpoint/store"
	pb "ckptstore/gen/checkpoint_store"

	"leetbuild/harness"
)

var (
	harnessBg = context.Background()
	hPayload  = []byte("layer-0 weights")
)

// hObjectPeer stores every object; the keys in corrupt arrive with their last byte flipped.
type hObjectPeer struct {
	pb.UnimplementedObjectStoreServer
	objects map[string][]byte
	corrupt map[string]bool
}

func (p *hObjectPeer) PutObject(_ context.Context, req *pb.PutObjectRequest) (*pb.PutObjectReply, error) {
	data := append([]byte{}, req.GetData()...)
	if p.corrupt[req.GetKey()] && len(data) > 0 {
		data[len(data)-1] ^= 1
	}
	p.objects[req.GetKey()] = data
	return &pb.PutObjectReply{Key: req.GetKey(), Sha256: store.Digest(data), Size: int64(len(data))}, nil
}

func hObjectStore(ctx *harness.Ctx) *hObjectPeer {
	peer := &hObjectPeer{objects: map[string][]byte{}, corrupt: map[string]bool{}}
	pb.RegisterObjectStoreServer(ctx.GRPC.Server(""), peer)
	return peer
}

func hMustStore(ctx *harness.Ctx, why string) {
	got, err := storeChunk(harnessBg, "u-1", 0, hPayload)
	ctx.NoError(err, "%s: storeChunk failed", why)
	ctx.Equal(got, store.Digest(hPayload), "%s: the checksum storeChunk returned", why)
}

func hMustFail(ctx *harness.Ctx, target error, why string, index int64) error {
	got, err := storeChunk(harnessBg, "u-1", index, hPayload)
	ctx.Assert(err != nil, "%s: storeChunk returned %q instead of an error wrapping %v", why, got, target)
	ctx.ErrorIs(err, target, "%s: storeChunk returned %v", why, err)
	return err
}

func hCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("PutObject", "")) }

func CheckStoreDeadline(ctx *harness.Ctx) {
	peer := hObjectStore(ctx)
	hMustStore(ctx, "with a healthy store")
	ctx.Equal(string(peer.objects["u-1/0"]), string(hPayload), "the store must hold the chunk under u-1/0")
	for _, call := range ctx.GRPC.CallsTo("PutObject", "") {
		ctx.Assert(call.HasDeadline(), "a PutObject call carries no deadline: a store that stops answering pins the copier for good")
		ctx.Assert(29500*time.Millisecond <= call.Timeout && call.Timeout <= 30500*time.Millisecond, "a PutObject call carries a %v deadline, expected 30 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("PutObject", 120.0, "")
	before := ctx.Clock.Now()
	hMustFail(ctx, ErrStoreUnavailable, "with a store that answers after two minutes", 1)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 95, "storeChunk waited %.0f s on a store that does not answer: three attempts of 30 s at most", waited)
	hung := ctx.GRPC.CallsTo("PutObject", "")[1:]
	ctx.Equal(len(hung), 3, "a store that never answers in time gets maxAttempts = 3 attempts at one chunk (DEADLINE_EXCEEDED is retried like UNAVAILABLE); the attempts")
	for _, call := range hung {
		ctx.Assert(call.HasDeadline() && 29500*time.Millisecond <= call.Timeout && call.Timeout <= 30500*time.Millisecond, "an attempt at a hung store carried a %v deadline: every attempt gets its own full 30 s, not what is left of the first", call.Timeout)
	}
}

func CheckChecksumConfirmed(ctx *harness.Ctx) {
	peer := hObjectStore(ctx)
	peer.corrupt["u-1/0"] = true
	hMustFail(ctx, ErrChecksumMismatch, "with the store receiving chunk u-1/0 with a byte flipped", 0)
	delete(peer.corrupt, "u-1/0")
	hMustStore(ctx, "once the bytes arrive intact")
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	hObjectStore(ctx)
	ctx.GRPC.Fail("PutObject", codes.Unavailable, "object store restarting", 2, "")
	hMustStore(ctx, "two UNAVAILABLE answers and then a success: the third attempt")
	ctx.Equal(hCalls(ctx), 3, "two UNAVAILABLE answers and a success; the calls")
	ctx.GRPC.Fail("PutObject", codes.Unavailable, "object store overloaded", 10, "")
	hMustFail(ctx, ErrStoreUnavailable, "with a store that keeps answering UNAVAILABLE", 1)
	ctx.Equal(hCalls(ctx)-3, 3, "a store that stays UNAVAILABLE gets maxAttempts = 3 attempts at one chunk; the attempts")
	ctx.GRPC.ClearFailures()
	ctx.GRPC.Fail("PutObject", codes.DeadlineExceeded, "object store busy", 1, "")
	hMustStore(ctx, "a DEADLINE_EXCEEDED answer and then a success: the second attempt")
	ctx.Equal(hCalls(ctx)-6, 2, "a DEADLINE_EXCEEDED answer and a success; the calls")
}

func CheckPermissionStops(ctx *harness.Ctx) {
	hObjectStore(ctx)
	ctx.GRPC.Fail("PutObject", codes.PermissionDenied, "bucket ckpt-prod is read-only for this service account", 1, "")
	err := hMustFail(ctx, ErrUploadRejected, "with the bucket refusing the service account", 0)
	ctx.Equal(hCalls(ctx), 1, "PERMISSION_DENIED must not be retried (another attempt cannot change the store's answer); the calls")
	ctx.Assert(strings.Contains(err.Error(), "read-only"), "the error says %q: the store's details (the bucket is read-only) must reach the operator", err.Error())
	terminal := []struct {
		code    codes.Code
		details string
	}{
		{codes.InvalidArgument, "object key u-1/0 is malformed"},
		{codes.ResourceExhausted, "bucket ckpt-prod is over its quota"},
		{codes.Internal, "object store write path failed"},
	}
	for _, t := range terminal {
		before := hCalls(ctx)
		ctx.GRPC.Fail("PutObject", t.code, t.details, 1, "")
		err := hMustFail(ctx, ErrUploadRejected, "with the store answering "+t.code.String(), 0)
		ctx.Equal(hCalls(ctx)-before, 1, "%v must not be retried (only UNAVAILABLE and DEADLINE_EXCEEDED are retried, any other status stops at once); the calls", t.code)
		ctx.Assert(strings.Contains(err.Error(), t.details), "the error for %v says %q: the store's details (%s) must reach the operator", t.code, err.Error(), t.details)
	}
	_ = errors.Is
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "checkpoint/store.h"
#include "checkpoint_store.grpc.pb.h"

namespace {

const std::string hPayload = "layer-0 weights";

// Stores every object; the keys in corrupt arrive with their last byte flipped.
class HObjectPeer final : public ckptstore::ObjectStore::Service {
 public:
  std::map<std::string, std::string> objects;
  std::set<std::string> corrupt;
  grpc::Status PutObject(grpc::ServerContext*, const ckptstore::PutObjectRequest* req, ckptstore::PutObjectReply* out) override {
    std::string data = req->data();
    if (corrupt.count(req->key()) && !data.empty()) data.back() = static_cast<char>(data.back() ^ 1);
    objects[req->key()] = data;
    out->set_key(req->key());
    out->set_sha256(store::digest(data));
    out->set_size(static_cast<long>(data.size()));
    return grpc::Status::OK;
  }
};

HObjectPeer& hObjectStore(harness::Ctx& ctx) {
  static HObjectPeer* peer = nullptr;
  delete peer;
  peer = new HObjectPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

void hMustStore(harness::Ctx& ctx, const std::string& why) {
  std::string got;
  try {
    got = storeChunk("u-1", 0, hPayload);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: storeChunk threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(got, store::digest(hPayload), "%s: the checksum storeChunk returned", why);
}

template <class E>
std::string hMustThrow(harness::Ctx& ctx, const std::string& expected, const std::string& why, long index = 0) {
  std::string got;
  try {
    got = storeChunk("u-1", index, hPayload);
  } catch (const E& e) {
    return e.what();
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: storeChunk threw %s: %s, expected %s", why, harness::CurrentExceptionType(), e.what(), expected);
  }
  ctx.Fatalf("%s: storeChunk returned %q instead of throwing %s", why, got, expected);
}

size_t hCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("PutObject").size(); }

}  // namespace

void CheckStoreDeadline(harness::Ctx& ctx) {
  HObjectPeer& peer = hObjectStore(ctx);
  hMustStore(ctx, "with a healthy store");
  ctx.Equal(peer.objects["u-1/0"], hPayload, "the store must hold the chunk under u-1/0");
  for (const auto& call : ctx.GRPC.CallsTo("PutObject")) {
    ctx.Assert(call.HasDeadline(), "a PutObject call carries no deadline: a store that stops answering pins the copier for good");
    ctx.Assert(29.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 30.5, "a PutObject call carries a %v s deadline, expected kDeadline = 30 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("PutObject", 120.0);
  const int64_t before = ctx.Clock.Now();
  hMustThrow<StoreUnavailable>(ctx, "StoreUnavailable", "with a store that answers after two minutes", 1);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 95, "storeChunk waited %.0f s on a store that does not answer: three attempts of 30 s at most", waited);
  const auto calls_so_far = ctx.GRPC.CallsTo("PutObject");
  const std::vector<harness::Call> hung(calls_so_far.begin() + 1, calls_so_far.end());
  ctx.Equal(hung.size(), 3, "a store that never answers in time gets kMaxAttempts = 3 attempts at one chunk (DEADLINE_EXCEEDED is retried like UNAVAILABLE); the attempts");
  for (const auto& call : hung) {
    ctx.Assert(call.HasDeadline() && 29.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 30.5,
               "an attempt at a hung store carried a %v s deadline: every attempt gets its own full 30 s, not what is left of the first", call.TimeoutSeconds());
  }
}

void CheckChecksumConfirmed(harness::Ctx& ctx) {
  HObjectPeer& peer = hObjectStore(ctx);
  peer.corrupt.insert("u-1/0");
  hMustThrow<ChecksumMismatch>(ctx, "ChecksumMismatch", "with the store receiving chunk u-1/0 with a byte flipped");
  peer.corrupt.clear();
  hMustStore(ctx, "once the bytes arrive intact");
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  hObjectStore(ctx);
  ctx.GRPC.Fail("PutObject", grpc::StatusCode::UNAVAILABLE, "object store restarting", 2);
  hMustStore(ctx, "two UNAVAILABLE answers and then a success: the third attempt");
  ctx.Equal(hCalls(ctx), 3, "two UNAVAILABLE answers and a success; the calls");
  ctx.GRPC.Fail("PutObject", grpc::StatusCode::UNAVAILABLE, "object store overloaded", 10);
  hMustThrow<StoreUnavailable>(ctx, "StoreUnavailable", "with a store that keeps answering UNAVAILABLE", 1);
  ctx.Equal(hCalls(ctx) - 3, 3, "a store that stays UNAVAILABLE gets kMaxAttempts = 3 attempts at one chunk; the attempts");
  ctx.GRPC.ClearFailures();
  ctx.GRPC.Fail("PutObject", grpc::StatusCode::DEADLINE_EXCEEDED, "object store busy", 1);
  hMustStore(ctx, "a DEADLINE_EXCEEDED answer and then a success: the second attempt");
  ctx.Equal(hCalls(ctx) - 6, 2, "a DEADLINE_EXCEEDED answer and a success; the calls");
}

void CheckPermissionStops(harness::Ctx& ctx) {
  hObjectStore(ctx);
  ctx.GRPC.Fail("PutObject", grpc::StatusCode::PERMISSION_DENIED, "bucket ckpt-prod is read-only for this service account", 1);
  const std::string message = hMustThrow<UploadRejected>(ctx, "UploadRejected", "with the bucket refusing the service account");
  ctx.Equal(hCalls(ctx), 1, "PERMISSION_DENIED must not be retried (another attempt cannot change the store's answer); the calls");
  ctx.Assert(message.find("read-only") != std::string::npos, "UploadRejected says %q: the store's details (the bucket is read-only) must reach the operator", message);
  const std::vector<std::pair<grpc::StatusCode, std::string>> terminal = {
      {grpc::StatusCode::INVALID_ARGUMENT, "object key u-1/0 is malformed"},
      {grpc::StatusCode::RESOURCE_EXHAUSTED, "bucket ckpt-prod is over its quota"},
      {grpc::StatusCode::INTERNAL, "object store write path failed"},
  };
  for (const auto& [code, details] : terminal) {
    const size_t before = hCalls(ctx);
    ctx.GRPC.Fail("PutObject", code, details, 1);
    const std::string rejected = hMustThrow<UploadRejected>(ctx, "UploadRejected", harness::Sprintf("with the store answering %v", code));
    ctx.Equal(hCalls(ctx) - before, 1, "%v must not be retried (only UNAVAILABLE and DEADLINE_EXCEEDED are retried, any other status stops at once); the calls", code);
    ctx.Assert(rejected.find(details) != std::string::npos, "UploadRejected for %v says %q: the store's details (%s) must reach the operator", code, rejected, details);
  }
}
`,
  },
  hints: [
    'Flip a byte on the way to the store: `store_chunk` still returns a checksum and the copier marks the chunk stored. Deny the bucket: the copier tries five times and the error says nothing about why.',
    'The loop catches every `RpcError` the same way and returns the first reply it gets. Nothing bounds a single call, nothing reads the status code, and nothing compares the reply’s `sha256` with the digest that was sent.',
    'Call with `timeout=DEADLINE_S`; on an error, raise `UploadRejected(... exc.details())` unless the code is in `RETRYABLE`, and `StoreUnavailable` on attempt `MAX_ATTEMPTS`; on a reply, raise `ChecksumMismatch` when `reply.sha256 != digest`.',
  ],
  debrief: `An acknowledgment is only worth what it was checked against. The store reports the digest of the bytes it actually received, so comparing it with the local digest is the one moment a corrupted transfer can be caught before a resume loads it. The status code tells the client whether time can help: \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` say the store may answer later, \`PERMISSION_DENIED\` says it never will, so the first is retried a bounded number of times and the second stops the upload with the store's own words. The deadline puts a ceiling on the whole: three attempts, ninety seconds. Production clients add jittered backoff between attempts and a retry budget across all chunks, so a store outage does not turn into a retry storm.`,
};
