import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Part writes verified against the store under a deadline',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['api', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter is \`store_part(upload_id, part_number, data, checksum)\`, called for
every part a client sends with the SHA-256 (hex) it computed: it loads the upload
(\`store.get_upload\`), sends the bytes with \`ObjectStore.WritePart\` over gRPC and, once the call
returns, registers the part with \`manifest.register_part\` (step 2, provided as \`uploads.manifest\`).
It stores the demo's parts and hides three flaws.

\`\`\`proto
service ObjectStore { rpc WritePart(WritePartRequest) returns (WritePartReply); }  // checksum: SHA-256 of the bytes received
\`\`\`

**Failure mode the checks target.** A store node that hangs holds the part open as long as it hangs;
bytes corrupted on the way are registered as stored, so a resume skips them and the object is
assembled corrupt; one restarting node fails the part and the client has to send it again.

- Every \`WritePart\` carries a deadline of \`WRITE_DEADLINE_S\` (30 s).
- Register the part only when \`reply.checksum\` equals the client's \`checksum\`; a mismatch is a
  failed write.
- \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\` and a mismatch are retried for this part alone, at most
  \`MAX_PART_ATTEMPTS\` (3) attempts; then \`store_part\` returns \`False\` and registers nothing. Any
  other status is raised.`,
  sequence: {
    participants: ['uploadd', 'Object store', 'Redis manifest'],
    messages: [
      {from: 'uploadd', to: 'Object store', label: 'WritePart(upload_id, n, data) · deadline 30 s', kind: 'sync'},
      {
        from: 'Object store',
        to: 'uploadd',
        label: 'WritePartReply{checksum} · UNAVAILABLE · DEADLINE_EXCEEDED',
        kind: 'reply',
      },
      {
        from: 'uploadd',
        to: 'uploadd',
        label: 'checksum ≠ client’s or retryable → this part again, 3 attempts',
        kind: 'sync',
      },
      {from: 'uploadd', to: 'Redis manifest', label: 'register_part only once verified', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'stores-part',
      title: 'Writes a part and registers it',
      detail:
        'A part the store receives intact is written once with `WritePart` and registered with its size and checksum.',
      match: {
        python: {all: [/\.WritePart\(/, /manifest\.register_part\(/]},
        typescript: {all: [/\.WritePart\(/, /registerPart\(/]},
        go: {all: [/\.WritePart\(/, /manifest\.RegisterPart\(/]},
        scala: {all: [/\.writePart\(/, /Manifest\.registerPart\(/]},
        cpp: {all: [/->WritePart\(/, /manifest::registerPart\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every WritePart carries a 30-second deadline',
      detail:
        'The call is made with `WRITE_DEADLINE_S` (30 s), so a hung store node costs at most three deadlines and the part is not registered; the starter sets no deadline and waits as long as the node does.',
      match: {
        python: {all: [/WRITE_DEADLINE_S\s*=\s*30\b/, /WritePart\([\s\S]{0,200}?timeout\s*=\s*WRITE_DEADLINE_S/]},
        typescript: {
          all: [/WRITE_DEADLINE_MS\s*=\s*30_?000\b/, /WritePart\([\s\S]{0,200}?deadline:[^\n]*WRITE_DEADLINE_MS/],
        },
        go: {all: [/writeDeadline\s*=\s*30\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*writeDeadline\s*\)/]},
        scala: {all: [/WriteDeadlineSeconds\s*=\s*30L?\b/, /withDeadlineAfter\(\s*WriteDeadlineSeconds/]},
        cpp: {all: [/kWriteDeadline\{30\}|kWriteDeadline\(30\)/, /set_deadline\([^\n]*kWriteDeadline\)/]},
      },
    },
    {
      id: 'checksum',
      title: 'Registers a part only when the checksums match',
      detail:
        "The store's `checksum` is compared with the client's before `register_part`/`registerPart`, and a mismatch registers nothing; the starter registers whatever the store received.",
      match: {
        python: {
          all: [/reply\.checksum\s*[!=]=\s*checksum|checksum\s*[!=]=\s*reply\.checksum/],
          order: [/reply\.checksum\s*[!=]=\s*checksum|checksum\s*[!=]=\s*reply\.checksum/, /manifest\.register_part\(/],
        },
        typescript: {
          all: [/reply\.checksum\s*[!=]==?\s*checksum|checksum\s*[!=]==?\s*reply\.checksum/],
          order: [/reply\.checksum\s*[!=]==?\s*checksum|checksum\s*[!=]==?\s*reply\.checksum/, /registerPart\(/],
        },
        go: {
          all: [
            /reply\.(GetChecksum\(\)|Checksum)\s*[!=]=\s*checksum|checksum\s*[!=]=\s*reply\.(GetChecksum\(\)|Checksum)/,
          ],
          order: [
            /reply\.(GetChecksum\(\)|Checksum)\s*[!=]=\s*checksum|checksum\s*[!=]=\s*reply\.(GetChecksum\(\)|Checksum)/,
            /manifest\.RegisterPart\(/,
          ],
        },
        scala: {
          all: [/reply\.checksum\s*[!=]=\s*checksum|checksum\s*[!=]=\s*reply\.checksum/],
          order: [/reply\.checksum\s*[!=]=\s*checksum|checksum\s*[!=]=\s*reply\.checksum/, /Manifest\.registerPart\(/],
        },
        cpp: {
          all: [/reply\.checksum\(\)\s*[!=]=\s*checksum|checksum\s*[!=]=\s*reply\.checksum\(\)/],
          order: [
            /reply\.checksum\(\)\s*[!=]=\s*checksum|checksum\s*[!=]=\s*reply\.checksum\(\)/,
            /manifest::registerPart\(/,
          ],
        },
      },
    },
    {
      id: 'retry',
      title: 'Retries the failed part alone, three attempts',
      detail:
        '`UNAVAILABLE`, `DEADLINE_EXCEEDED` and a checksum mismatch are tried again for this part, `MAX_PART_ATTEMPTS` (3) attempts in all, and then `store_part` reports false; the starter gives up on the first failure.',
      match: {
        python: {all: [/MAX_PART_ATTEMPTS\s*=\s*3\b/, /for \w+ in range\(MAX_PART_ATTEMPTS\)/, /UNAVAILABLE/]},
        typescript: {all: [/MAX_PART_ATTEMPTS\s*=\s*3\b/, /attempt < MAX_PART_ATTEMPTS/, /UNAVAILABLE/]},
        go: {all: [/maxPartAttempts\s*=\s*3\b/, /attempt < maxPartAttempts/, /codes\.Unavailable/]},
        scala: {all: [/MaxPartAttempts\s*=\s*3\b/, /attempt < MaxPartAttempts/, /UNAVAILABLE/]},
        cpp: {all: [/kMaxPartAttempts\s*=\s*3\b/, /attempt < kMaxPartAttempts/, /UNAVAILABLE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import resumable_upload_pb2 as pb
import resumable_upload_pb2_grpc
from uploads import manifest, store  # manifest.register_part, store.get_upload

objects = resumable_upload_pb2_grpc.ObjectStoreStub(grpc.insecure_channel("objects:9000"))


def store_part(upload_id: str, part_number: int, data: bytes, checksum: str) -> bool:
    """Write one part and register it; checksum is the SHA-256 (hex) the client computed. True once registered."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    upload = store.get_upload(upload_id)
    if upload is None:
        raise KeyError(f"no upload {upload_id}")
    objects.WritePart(pb.WritePartRequest(upload_id=upload_id, part_number=part_number, data=data))
    return manifest.register_part(upload_id, part_number, upload["part_count"], len(data), checksum) >= 0
`,
      solution: `import grpc

import resumable_upload_pb2 as pb
import resumable_upload_pb2_grpc
from uploads import manifest, store  # manifest.register_part, store.get_upload

MAX_PART_ATTEMPTS = 3
WRITE_DEADLINE_S = 30
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

objects = resumable_upload_pb2_grpc.ObjectStoreStub(grpc.insecure_channel("objects:9000"))


def store_part(upload_id: str, part_number: int, data: bytes, checksum: str) -> bool:
    """Write one part and register it; checksum is the SHA-256 (hex) the client computed. True once registered."""
    upload = store.get_upload(upload_id)
    if upload is None:
        raise KeyError(f"no upload {upload_id}")
    request = pb.WritePartRequest(upload_id=upload_id, part_number=part_number, data=data)
    for _ in range(MAX_PART_ATTEMPTS):
        try:
            reply = objects.WritePart(request, timeout=WRITE_DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                raise
            continue  # this part again; the parts already stored stay stored
        if reply.checksum == checksum:
            # Verified: only now does the manifest say the server holds this part.
            return manifest.register_part(upload_id, part_number, upload["part_count"], len(data), checksum) >= 0
        # The store holds other bytes than the client sent: write the part again.
    return False
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {registerPart} from 'uploads/manifest';
import {getUpload} from 'uploads/store';

interface WritePartRequest {
  upload_id: string;
  part_number: number;
  data: Uint8Array;
}

interface WritePartReply {
  checksum: string;
  size: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('resumable_upload.proto')) as unknown as {
  uploadd: {ObjectStore: grpc.ServiceClientConstructor};
};
const objects = new pkg.uploadd.ObjectStore('objects:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  WritePart(request: WritePartRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<WritePartReply>;
};

/** Write one part and register it; checksum is the SHA-256 (hex) the client computed. True once registered. */
export async function storePart(uploadId: string, partNumber: number, data: Uint8Array, checksum: string): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const upload = await getUpload(uploadId);
  if (upload === null) throw new Error(\`no upload \${uploadId}\`);
  await objects.WritePart({upload_id: uploadId, part_number: partNumber, data}, new grpc.Metadata(), {});
  return (await registerPart(uploadId, partNumber, upload.part_count, data.length, checksum)) >= 0;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {registerPart} from 'uploads/manifest';
import {getUpload} from 'uploads/store';

export const MAX_PART_ATTEMPTS = 3;
export const WRITE_DEADLINE_MS = 30_000;
const RETRYABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface WritePartRequest {
  upload_id: string;
  part_number: number;
  data: Uint8Array;
}

interface WritePartReply {
  checksum: string;
  size: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('resumable_upload.proto')) as unknown as {
  uploadd: {ObjectStore: grpc.ServiceClientConstructor};
};
const objects = new pkg.uploadd.ObjectStore('objects:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  WritePart(request: WritePartRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<WritePartReply>;
};

/** Write one part and register it; checksum is the SHA-256 (hex) the client computed. True once registered. */
export async function storePart(uploadId: string, partNumber: number, data: Uint8Array, checksum: string): Promise<boolean> {
  const upload = await getUpload(uploadId);
  if (upload === null) throw new Error(\`no upload \${uploadId}\`);
  for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt += 1) {
    let reply: WritePartReply;
    try {
      reply = await objects.WritePart(
        {upload_id: uploadId, part_number: partNumber, data},
        new grpc.Metadata(),
        {deadline: Date.now() + WRITE_DEADLINE_MS},
      );
    } catch (e) {
      if (!RETRYABLE.has((e as grpc.ServiceError).code)) throw e;
      continue; // this part again; the parts already stored stay stored
    }
    // Verified: only now does the manifest say the server holds this part.
    if (reply.checksum === checksum) return (await registerPart(uploadId, partNumber, upload.part_count, data.length, checksum)) >= 0;
    // The store holds other bytes than the client sent: write the part again.
  }
  return false;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "uploads/gen/resumable_upload"
	"uploads/manifest" // manifest.RegisterPart(ctx, uploadID, partNumber, partCount, size, checksum) (int64, error)
	"uploads/store"    // store.GetUpload(ctx, uploadID) *store.Upload
)

var (
	objectsConn, _ = grpc.NewClient("objects:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	objects        = pb.NewObjectStoreClient(objectsConn)
)

// storePart writes one part and registers it; checksum is the SHA-256 (hex) the client computed. True once registered.
func storePart(ctx context.Context, uploadID string, partNumber int, data []byte, checksum string) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil {
		return false, fmt.Errorf("no upload %s", uploadID)
	}
	if _, err := objects.WritePart(ctx, &pb.WritePartRequest{UploadId: uploadID, PartNumber: int32(partNumber), Data: data}); err != nil {
		return false, err
	}
	registered, err := manifest.RegisterPart(ctx, uploadID, partNumber, upload.PartCount, int64(len(data)), checksum)
	return registered >= 0, err
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "uploads/gen/resumable_upload"
	"uploads/manifest" // manifest.RegisterPart(ctx, uploadID, partNumber, partCount, size, checksum) (int64, error)
	"uploads/store"    // store.GetUpload(ctx, uploadID) *store.Upload
)

const (
	maxPartAttempts = 3
	writeDeadline   = 30 * time.Second
)

var (
	objectsConn, _ = grpc.NewClient("objects:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	objects        = pb.NewObjectStoreClient(objectsConn)
)

// storePart writes one part and registers it; checksum is the SHA-256 (hex) the client computed. True once registered.
func storePart(ctx context.Context, uploadID string, partNumber int, data []byte, checksum string) (bool, error) {
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil {
		return false, fmt.Errorf("no upload %s", uploadID)
	}
	request := &pb.WritePartRequest{UploadId: uploadID, PartNumber: int32(partNumber), Data: data}
	for attempt := 0; attempt < maxPartAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, writeDeadline)
		reply, err := objects.WritePart(callCtx, request)
		cancel()
		if err != nil {
			if code := status.Code(err); code != codes.Unavailable && code != codes.DeadlineExceeded {
				return false, err
			}
			continue // this part again; the parts already stored stay stored
		}
		if reply.GetChecksum() == checksum {
			// Verified: only now does the manifest say the server holds this part.
			registered, err := manifest.RegisterPart(ctx, uploadID, partNumber, upload.PartCount, int64(len(data)), checksum)
			return registered >= 0, err
		}
		// The store holds other bytes than the client sent: write the part again.
	}
	return false, nil
}
`,
    },
    scala: {
      starter: `import com.google.protobuf.ByteString
import io.grpc.ManagedChannelBuilder

import uploads.{Manifest, Store} // Manifest.registerPart, Store.getUpload
import uploadd.resumable_upload.{ObjectStoreGrpc, WritePartRequest}

object Client {
  private val objects = ObjectStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("objects", 9000).usePlaintext().build())

  /** Write one part and register it; checksum is the SHA-256 (hex) the client computed. True once registered. */
  def storePart(uploadId: String, partNumber: Int, data: Array[Byte], checksum: String): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val upload = Store.getUpload(uploadId).getOrElse(throw new NoSuchElementException(s"no upload $uploadId"))
    objects.writePart(WritePartRequest(uploadId, partNumber, ByteString.copyFrom(data)))
    Manifest.registerPart(uploadId, partNumber, upload.partCount, data.length.toLong, checksum) >= 0
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import com.google.protobuf.ByteString
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import uploads.{Manifest, Store} // Manifest.registerPart, Store.getUpload
import uploadd.resumable_upload.{ObjectStoreGrpc, WritePartReply, WritePartRequest}

object Client {
  val MaxPartAttempts = 3
  val WriteDeadlineSeconds = 30L
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val objects = ObjectStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("objects", 9000).usePlaintext().build())

  /** Write one part and register it; checksum is the SHA-256 (hex) the client computed. True once registered. */
  def storePart(uploadId: String, partNumber: Int, data: Array[Byte], checksum: String): Boolean = {
    val upload = Store.getUpload(uploadId).getOrElse(throw new NoSuchElementException(s"no upload $uploadId"))
    val request = WritePartRequest(uploadId, partNumber, ByteString.copyFrom(data))
    var attempt = 0
    while (attempt < MaxPartAttempts) {
      attempt += 1
      val written: Option[WritePartReply] =
        try Some(objects.withDeadlineAfter(WriteDeadlineSeconds, TimeUnit.SECONDS).writePart(request))
        catch { case e: StatusRuntimeException if Retryable(e.getStatus.getCode) => None } // this part again
      written match {
        // Verified: only now does the manifest say the server holds this part.
        case Some(reply) if reply.checksum == checksum =>
          return Manifest.registerPart(uploadId, partNumber, upload.partCount, data.length.toLong, checksum) >= 0
        case _ => () // the store holds other bytes than the client sent, or did not answer: write the part again
      }
    }
    false
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>

#include "resumable_upload.grpc.pb.h"
#include "uploads/manifest.h"  // manifest::registerPart(upload_id, part_number, part_count, size, checksum)
#include "uploads/store.h"     // store::getUpload(upload_id)

auto objects = uploadd::ObjectStore::NewStub(grpc::CreateChannel("objects:9000", grpc::InsecureChannelCredentials()));

// Write one part and register it; checksum is the SHA-256 (hex) the client computed. True once registered.
bool storePart(const std::string& upload_id, int part_number, const std::string& data, const std::string& checksum) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const auto upload = store::getUpload(upload_id);
  if (!upload) throw std::out_of_range("no upload " + upload_id);
  uploadd::WritePartRequest request;
  request.set_upload_id(upload_id);
  request.set_part_number(part_number);
  request.set_data(data);
  grpc::ClientContext ctx;
  uploadd::WritePartReply reply;
  const grpc::Status status = objects->WritePart(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("WritePart: " + status.error_message());
  return manifest::registerPart(upload_id, part_number, upload->part_count, static_cast<long long>(data.size()), checksum) >= 0;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "resumable_upload.grpc.pb.h"
#include "uploads/manifest.h"  // manifest::registerPart(upload_id, part_number, part_count, size, checksum)
#include "uploads/store.h"     // store::getUpload(upload_id)

constexpr int kMaxPartAttempts = 3;
constexpr std::chrono::seconds kWriteDeadline{30};

auto objects = uploadd::ObjectStore::NewStub(grpc::CreateChannel("objects:9000", grpc::InsecureChannelCredentials()));

// Write one part and register it; checksum is the SHA-256 (hex) the client computed. True once registered.
bool storePart(const std::string& upload_id, int part_number, const std::string& data, const std::string& checksum) {
  const auto upload = store::getUpload(upload_id);
  if (!upload) throw std::out_of_range("no upload " + upload_id);
  uploadd::WritePartRequest request;
  request.set_upload_id(upload_id);
  request.set_part_number(part_number);
  request.set_data(data);
  for (int attempt = 0; attempt < kMaxPartAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kWriteDeadline);
    uploadd::WritePartReply reply;
    const grpc::Status status = objects->WritePart(&ctx, request, &reply);
    if (!status.ok()) {
      const grpc::StatusCode code = status.error_code();
      if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED) {
        throw std::runtime_error("WritePart: " + status.error_message());
      }
      continue;  // this part again; the parts already stored stay stored
    }
    if (reply.checksum() == checksum) {
      // Verified: only now does the manifest say the server holds this part.
      return manifest::registerPart(upload_id, part_number, upload->part_count, static_cast<long long>(data.size()), checksum) >= 0;
    }
    // The store holds other bytes than the client sent: write the part again.
  }
  return false;
}
`,
    },
  },
  harness: {
    python: `import hashlib

import grpc

import resumable_upload_pb2 as pb
import resumable_upload_pb2_grpc
from uploads import manifest, store

PART = b"abcd"


def _sha(data):
    return hashlib.sha256(data).hexdigest()


class Objects(resumable_upload_pb2_grpc.ObjectStoreServicer):
    """Answers the SHA-256 of what it received; the next \`corrupt\` writes arrive with their first byte flipped."""

    def __init__(self):
        self.corrupt = 0

    def WritePart(self, request, context):
        data = request.data
        if self.corrupt > 0:
            self.corrupt -= 1
            data = bytes([data[0] ^ 0xFF]) + data[1:]
        return pb.WritePartReply(checksum=_sha(data), size=len(data))


def _client(ctx):
    objects = Objects()
    ctx.grpc.serve(resumable_upload_pb2_grpc.add_ObjectStoreServicer_to_server, objects)
    store.create_upload("t1", 10, 4, 3, "video/mp4")  # u-1: parts of 4, 4 and 2 bytes
    return ctx.load("client"), objects


def _registered():
    return {p["part_number"]: p for p in manifest.read_parts("u-1")}


def _writes(ctx, part_number):
    return [c for c in ctx.grpc.calls_to("WritePart") if c.request.part_number == part_number]


def _store(m, part_number, data, why):
    try:
        return m.store_part("u-1", part_number, data, _sha(data))
    except grpc.RpcError as exc:
        raise AssertionError(f"{why}: store_part raised {exc.code().name} ({exc.details()})") from None


def check_stores_part(ctx):
    m, _ = _client(ctx)
    ok = _store(m, 1, PART, "with a healthy store")
    assert ok is True, f"store_part answered {ok!r} for a part the store received intact, expected True"
    writes = _writes(ctx, 1)
    assert len(writes) == 1 and writes[0].request.data == PART and writes[0].request.upload_id == "u-1", f"part 1 must be written once with its bytes, the store saw {len(writes)} write(s)"
    assert _registered() == {1: {"part_number": 1, "size": 4, "checksum": _sha(PART)}}, f"the manifest holds {_registered()}, expected part 1 with size 4 and its checksum"


def check_deadline(ctx):
    m, _ = _client(ctx)
    _store(m, 1, PART, "with a healthy store")
    for call in ctx.grpc.calls_to("WritePart"):
        assert call.timeout is not None, "a WritePart call carries no deadline: a store node that hangs holds the part, and the client's request, open"
        assert 29.5 <= call.timeout <= 30.5, f"a WritePart call carries a {call.timeout} s deadline, expected WRITE_DEADLINE_S = 30"
    ctx.grpc.set_latency("WritePart", 45.0)
    before = ctx.clock.time()
    try:
        m.store_part("u-1", 2, PART, _sha(PART))
    except grpc.RpcError:
        pass  # reporting the deadline to the caller is fine too
    waited = ctx.clock.time() - before
    assert 2 not in _registered(), "part 2 is registered although every write of it ran past the deadline"
    assert waited <= 91, f"store_part spent {waited:.0f} s on one part with the store hanging: three attempts of 30 s at most"


def check_checksum(ctx):
    m, objects = _client(ctx)
    objects.corrupt = 10
    ok = _store(m, 2, PART, "with every copy of part 2 corrupted on the way")
    assert 2 not in _registered(), f"part 2 is registered although the store answered a checksum other than the client's: a resume would skip it and the object would be assembled corrupt (manifest {_registered()})"
    assert ok is False, f"store_part answered {ok!r} for a part whose checksum never matched, expected False"
    assert len(_writes(ctx, 2)) <= 3, f"part 2 was written {len(_writes(ctx, 2))} times: MAX_PART_ATTEMPTS is 3"
    objects.corrupt = 0
    assert _store(m, 2, PART, "with the store healthy again") is True and 2 in _registered(), "once the store receives part 2 intact it must be registered"


def check_retry(ctx):
    m, objects = _client(ctx)
    ctx.grpc.fail("WritePart", grpc.StatusCode.UNAVAILABLE, "store node restarting", times=1)
    ok = _store(m, 1, PART, "after one UNAVAILABLE from a restarting store node")
    assert ok is True and len(_writes(ctx, 1)) == 2, f"after one UNAVAILABLE store_part answered {ok!r} with {len(_writes(ctx, 1))} write(s): part 1 must be written again and registered"
    objects.corrupt = 1
    ok = _store(m, 2, PART, "after one corrupted copy")
    assert ok is True and len(_writes(ctx, 2)) == 2, f"after one checksum mismatch store_part answered {ok!r} with {len(_writes(ctx, 2))} write(s): the part must be written again"
    ctx.grpc.fail("WritePart", grpc.StatusCode.UNAVAILABLE, "store node down", times=10)
    ok = _store(m, 3, b"ef", "with the store node down")
    writes = len(_writes(ctx, 3))
    assert writes == 3, f"with the store node down part 3 was written {writes} time(s), expected MAX_PART_ATTEMPTS = 3"
    assert ok is False and 3 not in _registered(), f"store_part answered {ok!r} for a part the store never took, expected False with nothing registered"
    assert sorted(_registered()) == [1, 2], f"a failed part 3 must leave parts 1 and 2 registered, the manifest holds {sorted(_registered())}"
`,
    typescript: `import {createHash} from 'node:crypto';

const PART = new Uint8Array([97, 98, 99, 100]);
const TAIL = new Uint8Array([101, 102]);

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The object store: answers the SHA-256 of what it received; the next \`corrupt\` writes arrive with their first byte flipped. */
async function client(ctx) {
  const pkg = ctx.proto('resumable_upload.proto');
  const objects = {corrupt: 0};
  ctx.grpc.serve(pkg.uploadd.ObjectStore.service, {
    WritePart(call, callback) {
      const data = Uint8Array.from(call.request.data);
      if (objects.corrupt > 0) {
        objects.corrupt -= 1;
        data[0] ^= 0xff;
      }
      callback(null, {checksum: sha(data), size: data.length});
    },
  });
  const store = ctx.load('/support/uploads/store.ts');
  await store.createUpload('t1', 10, 4, 3, 'video/mp4'); // u-1: parts of 4, 4 and 2 bytes
  return {m: ctx.load('client'), objects, manifest: ctx.load('/support/uploads/manifest.ts')};
}

async function registered(manifest): Promise<Map<number, {part_number: number; size: number; checksum: string}>> {
  return new Map((await manifest.readParts('u-1')).map(p => [p.part_number, p]));
}

const writes = (ctx, n: number) => ctx.grpc.callsTo('WritePart').filter(c => Number(c.request.part_number) === n);

async function storeIt(m, n: number, data: Uint8Array, why: string) {
  try {
    return await m.storePart('u-1', n, data, sha(data));
  } catch (e) {
    assert.fail(\`\${why}: storePart threw \${(e as Error).message}\`);
  }
}

export async function check_stores_part(ctx) {
  const {m, manifest} = await client(ctx);
  const ok = await storeIt(m, 1, PART, 'with a healthy store');
  assert.equal(ok, true, \`storePart answered \${ok} for a part the store received intact, expected true\`);
  const calls = writes(ctx, 1);
  assert(calls.length === 1 && sha(Uint8Array.from(calls[0].request.data)) === sha(PART) && calls[0].request.upload_id === 'u-1', \`part 1 must be written once with its bytes, the store saw \${calls.length} write(s)\`);
  assert.deepStrictEqual([...(await registered(manifest)).values()], [{part_number: 1, size: 4, checksum: sha(PART)}], 'the manifest must hold part 1 with size 4 and its checksum');
}

export async function check_deadline(ctx) {
  const {m, manifest} = await client(ctx);
  await storeIt(m, 1, PART, 'with a healthy store');
  for (const call of ctx.grpc.callsTo('WritePart')) {
    assert(call.timeout !== null, "a WritePart call carries no deadline: a store node that hangs holds the part, and the client's request, open");
    assert(call.timeout >= 29.5 && call.timeout <= 30.5, \`a WritePart call carries a \${call.timeout} s deadline, expected WRITE_DEADLINE_MS = 30000\`);
  }
  ctx.grpc.setLatency('WritePart', 45.0);
  const before = ctx.clock.now();
  try {
    await m.storePart('u-1', 2, PART, sha(PART));
  } catch {
    // reporting the deadline to the caller is fine too
  }
  const waited = (ctx.clock.now() - before) / 1000;
  assert(!(await registered(manifest)).has(2), 'part 2 is registered although every write of it ran past the deadline');
  assert(waited <= 91, \`storePart spent \${waited.toFixed(0)} s on one part with the store hanging: three attempts of 30 s at most\`);
}

export async function check_checksum(ctx) {
  const {m, objects, manifest} = await client(ctx);
  objects.corrupt = 10;
  const ok = await storeIt(m, 2, PART, 'with every copy of part 2 corrupted on the way');
  assert(!(await registered(manifest)).has(2), "part 2 is registered although the store answered a checksum other than the client's: a resume would skip it and the object would be assembled corrupt");
  assert.equal(ok, false, \`storePart answered \${ok} for a part whose checksum never matched, expected false\`);
  assert(writes(ctx, 2).length <= 3, \`part 2 was written \${writes(ctx, 2).length} times: MAX_PART_ATTEMPTS is 3\`);
  objects.corrupt = 0;
  assert.equal(await storeIt(m, 2, PART, 'with the store healthy again'), true, 'once the store receives part 2 intact storePart must answer true');
  assert((await registered(manifest)).has(2), 'once the store receives part 2 intact it must be registered');
}

export async function check_retry(ctx) {
  const {m, objects, manifest} = await client(ctx);
  ctx.grpc.fail('WritePart', ctx.grpc.status.UNAVAILABLE, 'store node restarting', 1);
  let ok = await storeIt(m, 1, PART, 'after one UNAVAILABLE from a restarting store node');
  assert(ok === true && writes(ctx, 1).length === 2, \`after one UNAVAILABLE storePart answered \${ok} with \${writes(ctx, 1).length} write(s): part 1 must be written again and registered\`);
  objects.corrupt = 1;
  ok = await storeIt(m, 2, PART, 'after one corrupted copy');
  assert(ok === true && writes(ctx, 2).length === 2, \`after one checksum mismatch storePart answered \${ok} with \${writes(ctx, 2).length} write(s): the part must be written again\`);
  ctx.grpc.fail('WritePart', ctx.grpc.status.UNAVAILABLE, 'store node down', 10);
  ok = await storeIt(m, 3, TAIL, 'with the store node down');
  assert.equal(writes(ctx, 3).length, 3, \`with the store node down part 3 was written \${writes(ctx, 3).length} time(s), expected MAX_PART_ATTEMPTS = 3\`);
  assert(ok === false && !(await registered(manifest)).has(3), \`storePart answered \${ok} for a part the store never took, expected false with nothing registered\`);
  assert.deepStrictEqual([...(await registered(manifest)).keys()], [1, 2], 'a failed part 3 must leave parts 1 and 2 registered');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"google.golang.org/grpc/codes"

	pb "uploads/gen/resumable_upload"
	"uploads/manifest"
	"uploads/store"

	"leetbuild/harness"
)

var (
	clientBg = context.Background()
	part     = []byte("abcd")
	tail     = []byte("ef")
)

func sha(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// objectsPeer answers the SHA-256 of what it received; the next corrupt writes arrive with their first byte flipped.
type objectsPeer struct {
	pb.UnimplementedObjectStoreServer
	corrupt int
}

func (o *objectsPeer) WritePart(_ context.Context, req *pb.WritePartRequest) (*pb.WritePartReply, error) {
	data := append([]byte{}, req.GetData()...)
	if o.corrupt > 0 {
		o.corrupt--
		data[0] ^= 0xff
	}
	return &pb.WritePartReply{Checksum: sha(data), Size: int64(len(data))}, nil
}

func client(ctx *harness.Ctx) *objectsPeer {
	peer := &objectsPeer{}
	pb.RegisterObjectStoreServer(ctx.GRPC.Server(""), peer)
	store.CreateUpload(clientBg, "t1", 10, 4, 3, "video/mp4") // u-1: parts of 4, 4 and 2 bytes
	return peer
}

func registered(ctx *harness.Ctx) map[int]manifest.Part {
	parts, err := manifest.ReadParts(clientBg, "u-1")
	ctx.NoError(err, "manifest.ReadParts(u-1)")
	out := map[int]manifest.Part{}
	for _, p := range parts {
		out[p.PartNumber] = p
	}
	return out
}

func writes(ctx *harness.Ctx, n int) []*pb.WritePartRequest {
	var out []*pb.WritePartRequest
	for _, c := range ctx.GRPC.CallsTo("WritePart", "") {
		if req := c.Request.(*pb.WritePartRequest); int(req.GetPartNumber()) == n {
			out = append(out, req)
		}
	}
	return out
}

func storeIt(ctx *harness.Ctx, n int, data []byte, why string) bool {
	ok, err := storePart(clientBg, "u-1", n, data, sha(data))
	ctx.NoError(err, "%s: storePart returned an error", why)
	return ok
}

func CheckStoresPart(ctx *harness.Ctx) {
	client(ctx)
	ctx.Equal(storeIt(ctx, 1, part, "with a healthy store"), true, "storePart's answer for a part the store received intact")
	w := writes(ctx, 1)
	ctx.Assert(len(w) == 1 && string(w[0].GetData()) == string(part) && w[0].GetUploadId() == "u-1", "part 1 must be written once with its bytes, the store saw %d write(s)", len(w))
	ctx.Equal(registered(ctx), map[int]manifest.Part{1: {PartNumber: 1, Size: 4, Checksum: sha(part)}}, "the manifest must hold part 1 with size 4 and its checksum")
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	storeIt(ctx, 1, part, "with a healthy store")
	for _, call := range ctx.GRPC.CallsTo("WritePart", "") {
		ctx.Assert(call.HasDeadline(), "a WritePart call carries no deadline: a store node that hangs holds the part, and the client's request, open")
		ctx.Assert(29500*time.Millisecond <= call.Timeout && call.Timeout <= 30500*time.Millisecond, "a WritePart call carries a %v deadline, expected writeDeadline = 30 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("WritePart", 45.0, "")
	before := ctx.Clock.Now()
	storePart(clientBg, "u-1", 2, part, sha(part)) // an error reporting the deadline is fine too
	waited := float64(ctx.Clock.Now()-before) / 1000
	_, has := registered(ctx)[2]
	ctx.Assert(!has, "part 2 is registered although every write of it ran past the deadline")
	ctx.Assert(waited <= 91, "storePart spent %.0f s on one part with the store hanging: three attempts of 30 s at most", waited)
}

func CheckChecksum(ctx *harness.Ctx) {
	peer := client(ctx)
	peer.corrupt = 10
	ok := storeIt(ctx, 2, part, "with every copy of part 2 corrupted on the way")
	_, has := registered(ctx)[2]
	ctx.Assert(!has, "part 2 is registered although the store answered a checksum other than the client's: a resume would skip it and the object would be assembled corrupt")
	ctx.Equal(ok, false, "storePart's answer for a part whose checksum never matched")
	ctx.Assert(len(writes(ctx, 2)) <= 3, "part 2 was written %d times: maxPartAttempts is 3", len(writes(ctx, 2)))
	peer.corrupt = 0
	ctx.Equal(storeIt(ctx, 2, part, "with the store healthy again"), true, "once the store receives part 2 intact, storePart's answer")
	_, has = registered(ctx)[2]
	ctx.Assert(has, "once the store receives part 2 intact it must be registered")
}

func CheckRetry(ctx *harness.Ctx) {
	peer := client(ctx)
	ctx.GRPC.Fail("WritePart", codes.Unavailable, "store node restarting", 1, "")
	ok := storeIt(ctx, 1, part, "after one UNAVAILABLE from a restarting store node")
	ctx.Assert(ok && len(writes(ctx, 1)) == 2, "after one UNAVAILABLE storePart answered %v with %d write(s): part 1 must be written again and registered", ok, len(writes(ctx, 1)))
	peer.corrupt = 1
	ok = storeIt(ctx, 2, part, "after one corrupted copy")
	ctx.Assert(ok && len(writes(ctx, 2)) == 2, "after one checksum mismatch storePart answered %v with %d write(s): the part must be written again", ok, len(writes(ctx, 2)))
	ctx.GRPC.Fail("WritePart", codes.Unavailable, "store node down", 10, "")
	ok = storeIt(ctx, 3, tail, "with the store node down")
	ctx.Equal(len(writes(ctx, 3)), 3, "with the store node down, the writes of part 3 (maxPartAttempts = 3)")
	_, has := registered(ctx)[3]
	ctx.Assert(!ok && !has, "storePart answered %v for a part the store never took, expected false with nothing registered", ok)
	got := registered(ctx)
	_, one := got[1]
	_, two := got[2]
	ctx.Assert(len(got) == 2 && one && two, "a failed part 3 must leave parts 1 and 2 registered, the manifest holds %v", got)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <openssl/sha.h>

#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "resumable_upload.grpc.pb.h"
#include "uploads/manifest.h"
#include "uploads/store.h"

namespace {

const std::string kPart = "abcd";
const std::string kTail = "ef";

std::string sha(const std::string& data) {
  unsigned char md[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(data.data()), data.size(), md);
  std::string hex;
  char byte[3];
  for (unsigned char c : md) {
    std::snprintf(byte, sizeof byte, "%02x", c);
    hex += byte;
  }
  return hex;
}

// Answers the SHA-256 of what it received; the next corrupt writes arrive with their first byte flipped.
class ObjectsPeer final : public uploadd::ObjectStore::Service {
 public:
  int corrupt = 0;
  grpc::Status WritePart(grpc::ServerContext*, const uploadd::WritePartRequest* req, uploadd::WritePartReply* out) override {
    std::string data = req->data();
    if (corrupt > 0) {
      corrupt--;
      data[0] = static_cast<char>(data[0] ^ 0xff);
    }
    out->set_checksum(sha(data));
    out->set_size(static_cast<long long>(data.size()));
    return grpc::Status::OK;
  }
};

ObjectsPeer& client(harness::Ctx& ctx) {
  static ObjectsPeer* peer = nullptr;
  delete peer;
  peer = new ObjectsPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  store::createUpload("t1", 10, 4, 3, "video/mp4");  // u-1: parts of 4, 4 and 2 bytes
  return *peer;
}

std::map<int, manifest::Part> registered() {
  std::map<int, manifest::Part> out;
  for (const auto& p : manifest::readParts("u-1")) out[p.part_number] = p;
  return out;
}

std::vector<uploadd::WritePartRequest> writes(harness::Ctx& ctx, int n) {
  std::vector<uploadd::WritePartRequest> out;
  for (const auto& c : ctx.GRPC.CallsTo("WritePart")) {
    const auto req = c.Request<uploadd::WritePartRequest>();
    if (req.part_number() == n) out.push_back(req);
  }
  return out;
}

bool storeIt(harness::Ctx& ctx, int n, const std::string& data, const std::string& why) {
  try {
    return storePart("u-1", n, data, sha(data));
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: storePart threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckStoresPart(harness::Ctx& ctx) {
  client(ctx);
  ctx.Equal(storeIt(ctx, 1, kPart, "with a healthy store"), true, "storePart's answer for a part the store received intact");
  const auto w = writes(ctx, 1);
  ctx.Assert(w.size() == 1 && w[0].data() == kPart && w[0].upload_id() == "u-1", "part 1 must be written once with its bytes, the store saw %d write(s)", w.size());
  const auto parts = registered();
  ctx.Assert(parts.size() == 1 && parts.count(1) && parts.at(1).size == 4 && parts.at(1).checksum == sha(kPart), "the manifest must hold part 1 with size 4 and its checksum, it holds %d part(s)", parts.size());
}

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  storeIt(ctx, 1, kPart, "with a healthy store");
  for (const auto& call : ctx.GRPC.CallsTo("WritePart")) {
    ctx.Assert(call.HasDeadline(), "a WritePart call carries no deadline: a store node that hangs holds the part, and the client's request, open");
    ctx.Assert(29.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 30.5, "a WritePart call carries a %v s deadline, expected kWriteDeadline = 30 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("WritePart", 45.0);
  const int64_t before = ctx.Clock.Now();
  try {
    storePart("u-1", 2, kPart, sha(kPart));
  } catch (const std::exception&) {
    // reporting the deadline to the caller is fine too
  }
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(!registered().count(2), "part 2 is registered although every write of it ran past the deadline");
  ctx.Assert(waited <= 91, "storePart spent %.0f s on one part with the store hanging: three attempts of 30 s at most", waited);
}

void CheckChecksum(harness::Ctx& ctx) {
  ObjectsPeer& peer = client(ctx);
  peer.corrupt = 10;
  const bool ok = storeIt(ctx, 2, kPart, "with every copy of part 2 corrupted on the way");
  ctx.Assert(!registered().count(2), "part 2 is registered although the store answered a checksum other than the client's: a resume would skip it and the object would be assembled corrupt");
  ctx.Equal(ok, false, "storePart's answer for a part whose checksum never matched");
  ctx.Assert(writes(ctx, 2).size() <= 3, "part 2 was written %d times: kMaxPartAttempts is 3", writes(ctx, 2).size());
  peer.corrupt = 0;
  ctx.Equal(storeIt(ctx, 2, kPart, "with the store healthy again"), true, "once the store receives part 2 intact, storePart's answer");
  ctx.Assert(registered().count(2), "once the store receives part 2 intact it must be registered");
}

void CheckRetry(harness::Ctx& ctx) {
  ObjectsPeer& peer = client(ctx);
  ctx.GRPC.Fail("WritePart", grpc::StatusCode::UNAVAILABLE, "store node restarting", 1);
  bool ok = storeIt(ctx, 1, kPart, "after one UNAVAILABLE from a restarting store node");
  ctx.Assert(ok && writes(ctx, 1).size() == 2, "after one UNAVAILABLE storePart answered %t with %d write(s): part 1 must be written again and registered", ok, writes(ctx, 1).size());
  peer.corrupt = 1;
  ok = storeIt(ctx, 2, kPart, "after one corrupted copy");
  ctx.Assert(ok && writes(ctx, 2).size() == 2, "after one checksum mismatch storePart answered %t with %d write(s): the part must be written again", ok, writes(ctx, 2).size());
  ctx.GRPC.Fail("WritePart", grpc::StatusCode::UNAVAILABLE, "store node down", 10);
  ok = storeIt(ctx, 3, kTail, "with the store node down");
  ctx.Equal(writes(ctx, 3).size(), 3, "with the store node down, the writes of part 3 (kMaxPartAttempts = 3)");
  ctx.Assert(!ok && !registered().count(3), "storePart answered %t for a part the store never took, expected false with nothing registered", ok);
  const auto got = registered();
  ctx.Assert(got.size() == 2 && got.count(1) && got.count(2), "a failed part 3 must leave parts 1 and 2 registered, the manifest holds %d part(s)", got.size());
}
`,
  },
  hints: [
    'Make the store hang and the part hangs with it; flip a byte on the way and the manifest still lists the part; let one write fail with UNAVAILABLE and the whole call fails.',
    'The call has no deadline, the reply is never read, so the checksum the store computed is never compared with the client’s, and a failure goes straight to the caller because nothing tries the part again.',
    'Loop `for _ in range(MAX_PART_ATTEMPTS)`: `WritePart(..., timeout=WRITE_DEADLINE_S)`; on UNAVAILABLE or DEADLINE_EXCEEDED continue, other codes raise; if `reply.checksum == checksum` register and return; after the loop return `False`.',
  ],
  debrief: `The store's checksum is the only proof that the bytes it holds are the bytes the client sent, so a part is stored when that proof arrives, not when the call returns. Retrying one part is cheap because parts are independent and the write is keyed by part number: a second write of part 7 replaces the first and the manifest counts it once. The deadline bounds what a hung node can cost, three attempts bound the whole part, and returning False leaves the part in the resume list for the client. Production services hedge a slow write to a second node, spread a part's retries over replicas, use a cheaper rolling checksum such as CRC32C for transport, and keep the strong hash for the assembled object.`,
};
