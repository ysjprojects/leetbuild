import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Part writes with checksum verification per part',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter is the part writer: \`write_part(stub, upload_id, part)\` opens a
gRPC channel to the object store, sends a \`WritePartRequest\` with the part's bytes and marks the
part stored as soon as the call returns. The demo works because the store accepts everything. It
hides five flaws.

**Failure mode the checks target.** Marking a part stored when the store *accepted* the request
rather than when the checksum *verified* moves the discovery of corruption to finalize, after every
part has been uploaded. Retrying the whole upload on one part's failure multiplies the bytes sent on
a flaky network, and without a deadline a stuck store turns one part into a hung request.

- Every \`WritePart\` call carries a **30-second deadline** (\`WRITE_DEADLINE_S\`); a store that hangs
  must not hold the request open.
- The store returns the **checksum it computed** for the bytes it received. The writer compares it
  against the client's checksum and marks the part stored **only on a match**.
- A failed or mismatched part is retried **alone**, at most \`MAX_PART_ATTEMPTS\` (3) times, so a
  5 GiB upload does not re-send 4.99 GiB to recover a 64 MiB part.
- \`resume_list(upload_id, part_count, manifest)\` returns the **exact part numbers** still missing,
  in order, so the client re-sends only those.`,
  sequence: {
    participants: ['Upload API', 'Object store', 'Part manifest'],
    messages: [
      {from: 'Upload API', to: 'Object store', label: 'WritePart · 30s deadline', kind: 'sync'},
      {from: 'Object store', to: 'Upload API', label: 'WritePartReply{checksum}', kind: 'reply'},
      {from: 'Upload API', to: 'Upload API', label: 'compare checksum · retry this part only', kind: 'sync'},
      {from: 'Upload API', to: 'Part manifest', label: 'mark stored on match', kind: 'sync'},
      {from: 'Upload API', to: 'Upload API', label: 'resume_list → exact missing part numbers', kind: 'reply'},
    ],
  },
  hints: [
    'A store node wedges and one upload request hangs until the client gives up; another upload finishes, then finalize reports a checksum mismatch and the client has to send all 5 GiB again.',
    "The call has no deadline, the reply's checksum is thrown away before `mark_stored`, and the only retry loop wraps the whole upload rather than the part that failed.",
    'In `write_part`: call `stub.WritePart(request, timeout=WRITE_DEADLINE_S)` inside a `for attempt in range(MAX_PART_ATTEMPTS)` loop, compare `reply.checksum` to `part.checksum`, and call `mark_stored` only on a match; add `resume_list`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every WritePart carries a 30-second deadline',
      detail:
        'The gRPC call sets a 30-second deadline (`WRITE_DEADLINE_S`). The starter calls `WritePart` with no deadline, so a stuck store holds the request open.',
      match: {
        python: {all: [/WRITE_DEADLINE_S/, /timeout=/]},
        typescript: {all: [/WRITE_DEADLINE_S/, /deadline/]},
        go: {all: [/writeDeadlineS/, /WithTimeout\(/]},
        scala: {all: [/WriteDeadlineS/, /withDeadlineAfter\(/]},
        cpp: {all: [/kWriteDeadlineS/, /set_deadline\(/]},
      },
    },
    {
      id: 'checksum-verify',
      title: 'Compares the store’s checksum before storing',
      detail:
        'The reply checksum is compared against the client’s computed checksum; a mismatch is treated as a failed part. The starter never looks at the checksum the store returns.',
      match: {
        python: {all: [/reply\.checksum/, /part\.checksum/]},
        typescript: {all: [/reply\.checksum/, /part\.checksum/]},
        go: {all: [/reply\.Checksum/, /part\.Checksum/]},
        scala: {all: [/reply\.checksum/, /part\.checksum/]},
        cpp: {all: [/reply\.checksum\(\)/, /part\.checksum\(\)/]},
      },
    },
    {
      id: 'per-part-retry',
      title: 'Retries the failed part alone, bounded',
      detail:
        'The retry loop is per part and bounded by `MAX_PART_ATTEMPTS` (3); a failure does not restart the upload. The starter retries the whole upload on one part’s failure.',
      match: {
        python: {all: [/MAX_PART_ATTEMPTS/, /range\(MAX_PART_ATTEMPTS\)/]},
        typescript: {all: [/MAX_PART_ATTEMPTS/, /attempt < MAX_PART_ATTEMPTS/]},
        go: {all: [/maxPartAttempts/, /attempt < maxPartAttempts/]},
        scala: {all: [/MaxPartAttempts/, /attempt < MaxPartAttempts/]},
        cpp: {all: [/kMaxPartAttempts/, /attempt < kMaxPartAttempts/]},
      },
    },
    {
      id: 'stored-after-verify',
      title: 'Marks stored only after the checksum matches',
      detail:
        '`mark_stored` runs after the checksum comparison succeeds — not as soon as the call returns. The starter marks the part stored when the store accepts the request.',
      match: {
        python: {order: [/reply\.checksum/, /mark_stored\(/]},
        typescript: {order: [/reply\.checksum/, /markStored\(/]},
        go: {order: [/reply\.Checksum/, /MarkStored\(/]},
        scala: {order: [/reply\.checksum/, /markStored\(/]},
        cpp: {order: [/reply\.checksum\(\)/, /MarkStored\(/]},
      },
    },
    {
      id: 'resume-list',
      title: 'Names the exact missing parts',
      detail:
        '`resume_list` returns the part numbers in `1..part_count` that the manifest does not hold, so the client re-sends only the gaps. The starter’s callers get a percentage.',
      match: {
        python: {all: [/resume_list/, /part_count/, /not in manifest|if number/]},
        typescript: {all: [/resumeList/, /partCount/, /manifest/]},
        go: {all: [/ResumeList/, /partCount/, /manifest/]},
        scala: {all: [/resumeList/, /partCount/, /manifest/]},
        cpp: {all: [/ResumeList\(/, /partCount/, /manifest/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

WRITE_DEADLINE_S = 30

# WritePartRequest, WritePartReply and the Store stub come from the generated upload_pb2 /
# upload_pb2_grpc modules.


class Part:
    def __init__(self, number: int, data: bytes, checksum: str) -> None:
        self.number = number
        self.data = data
        self.checksum = checksum


def write_part(stub, upload_id: str, part: Part) -> None:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    request = WritePartRequest(upload_id=upload_id, part_number=part.number, data=part.data)
    stub.WritePart(request)
    mark_stored(upload_id, part.number)


def upload_all_parts(stub, upload_id: str, parts: list[Part]) -> None:
    for _ in range(5):
        try:
            for part in parts:
                write_part(stub, upload_id, part)
            return
        except grpc.RpcError:
            continue
`,
      solution: `import grpc

WRITE_DEADLINE_S = 30
MAX_PART_ATTEMPTS = 3

# WritePartRequest, WritePartReply and the Store stub come from the generated upload_pb2 /
# upload_pb2_grpc modules.


class Part:
    def __init__(self, number: int, data: bytes, checksum: str) -> None:
        self.number = number
        self.data = data
        self.checksum = checksum


def write_part(stub, upload_id: str, part: Part) -> bool:
    """Write one part, verify its checksum, and mark it stored. True when it is stored."""
    request = WritePartRequest(
        upload_id=upload_id,
        part_number=part.number,
        data=part.data,
        checksum=part.checksum,
    )
    for _ in range(MAX_PART_ATTEMPTS):
        try:
            reply = stub.WritePart(request, timeout=WRITE_DEADLINE_S)
        except grpc.RpcError:
            continue
        if reply.checksum != part.checksum:
            continue
        mark_stored(upload_id, part.number, reply.checksum)
        return True
    return False


def resume_list(upload_id: str, part_count: int, manifest: dict) -> list[int]:
    """The part numbers still missing, in order, so the client resumes from the exact gaps."""
    return [number for number in range(1, part_count + 1) if number not in manifest]
`,
    },
    typescript: {
      starter: `/** WritePart. */
import * as grpc from '@grpc/grpc-js';

const WRITE_DEADLINE_S = 30;

interface Part {
  number: number;
  data: Buffer;
  checksum: string;
}

interface StoreClient extends grpc.Client {
  writePart(
    request: {upload_id: string; part_number: number; data: Buffer},
    callback: (error: grpc.ServiceError | null, reply: {checksum: string}) => void,
  ): void;
}

export async function writePart(
  client: StoreClient,
  uploadId: string,
  part: Part,
): Promise<void> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  await new Promise<void>((resolve, reject) => {
    client.writePart(
      {upload_id: uploadId, part_number: part.number, data: part.data},
      error => (error ? reject(error) : resolve()),
    );
  });
  await markStored(uploadId, part.number, '');
}

export async function uploadAllParts(
  client: StoreClient,
  uploadId: string,
  parts: Part[],
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      for (const part of parts) await writePart(client, uploadId, part);
      return;
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** WritePart: one part, verified against the checksum the store echoes, retried alone. */
import * as grpc from '@grpc/grpc-js';

const WRITE_DEADLINE_S = 30;
const MAX_PART_ATTEMPTS = 3;

interface Part {
  number: number;
  data: Buffer;
  checksum: string;
}

interface WritePartReply {
  checksum: string;
}

interface StoreClient extends grpc.Client {
  writePart(
    request: {upload_id: string; part_number: number; data: Buffer; checksum: string},
    options: {deadline: Date},
    callback: (error: grpc.ServiceError | null, reply: WritePartReply) => void,
  ): void;
}

export async function writePart(client: StoreClient, uploadId: string, part: Part): Promise<boolean> {
  const deadline = new Date(Date.now() + WRITE_DEADLINE_S * 1000);
  for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt += 1) {
    const reply = await new Promise<WritePartReply | null>(resolve => {
      client.writePart(
        {
          upload_id: uploadId,
          part_number: part.number,
          data: part.data,
          checksum: part.checksum,
        },
        {deadline},
        (error, value) => (error ? resolve(null) : resolve(value)),
      );
    });
    if (reply === null || reply.checksum !== part.checksum) continue;
    await markStored(uploadId, part.number, reply.checksum);
    return true;
  }
  return false;
}

export function resumeList(uploadId: string, partCount: number, manifest: Record<number, string>): number[] {
  const missing: number[] = [];
  for (let number = 1; number <= partCount; number += 1) if (manifest[number] === undefined) missing.push(number);
  return missing;
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
)

const writeDeadlineS = 30

func WritePart(ctx context.Context, client StoreClient, uploadID string, part Part) error {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	_, err := client.WritePart(ctx, &WritePartRequest{
		UploadId:   uploadID,
		PartNumber: part.Number,
		Data:       part.Data,
	})
	if err != nil {
		return err
	}
	return MarkStored(ctx, uploadID, part.Number, "")
}

func UploadAllParts(ctx context.Context, client StoreClient, uploadID string, parts []Part) error {
	for attempt := 0; attempt < 5; attempt++ {
		failed := false
		for _, part := range parts {
			if err := WritePart(ctx, client, uploadID, part); err != nil {
				failed = true
				break
			}
		}
		if !failed {
			return nil
		}
	}
	return nil
}
`,
      solution: `package client

import (
	"context"
	"time"
)

const (
	writeDeadlineS  = 30
	maxPartAttempts = 3
)

func WritePart(ctx context.Context, client StoreClient, uploadID string, part Part) (bool, error) {
	for attempt := 0; attempt < maxPartAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, writeDeadlineS*time.Second)
		reply, err := client.WritePart(callCtx, &WritePartRequest{
			UploadId:   uploadID,
			PartNumber: part.Number,
			Data:       part.Data,
			Checksum:   part.Checksum,
		})
		cancel()
		if err != nil {
			continue
		}
		if reply.Checksum != part.Checksum {
			continue
		}
		if err := MarkStored(ctx, uploadID, part.Number, reply.Checksum); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

func ResumeList(uploadID string, partCount int64, manifest map[int64]string) []int64 {
	missing := make([]int64, 0, partCount)
	for number := int64(1); number <= partCount; number++ {
		if _, ok := manifest[number]; !ok {
			missing = append(missing, number)
		}
	}
	return missing
}
`,
    },
    scala: {
      starter: `package client

import io.grpc.StatusRuntimeException

object PartWriter {
  val WriteDeadlineS: Long = 30

  def writePart(stub: StoreGrpc.StoreBlockingStub, uploadId: String, part: Part): Unit = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val request = WritePartRequest(uploadId = uploadId, partNumber = part.number, data = part.data)
    stub.writePart(request)
    markStored(uploadId, part.number, "")
  }

  def uploadAllParts(stub: StoreGrpc.StoreBlockingStub, uploadId: String, parts: Seq[Part]): Unit = {
    var attempt = 0
    while (attempt < 5) {
      try {
        parts.foreach(part => writePart(stub, uploadId, part))
        return
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
  }
}
`,
      solution: `package client

import io.grpc.StatusRuntimeException

import java.util.concurrent.TimeUnit

object PartWriter {
  val WriteDeadlineS: Long = 30
  val MaxPartAttempts: Int = 3

  def writePart(stub: StoreGrpc.StoreBlockingStub, uploadId: String, part: Part): Boolean = {
    val request = WritePartRequest(
      uploadId = uploadId,
      partNumber = part.number,
      data = part.data,
      checksum = part.checksum,
    )
    var attempt = 0
    while (attempt < MaxPartAttempts) {
      try {
        val reply = stub.withDeadlineAfter(WriteDeadlineS, TimeUnit.SECONDS).writePart(request)
        if (reply.checksum == part.checksum) {
          markStored(uploadId, part.number, reply.checksum)
          return true
        }
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    false
  }

  def resumeList(uploadId: String, partCount: Long, manifest: Map[Long, String]): Seq[Long] =
    (1L to partCount).filterNot(manifest.contains)
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <memory>
#include <string>

constexpr int kWriteDeadlineS = 30;

void WritePart(std::shared_ptr<grpc::Channel> channel, const std::string& uploadId, const Part& part) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  auto stub = Store::NewStub(channel);
  grpc::ClientContext context;
  WritePartRequest request;
  request.set_upload_id(uploadId);
  request.set_part_number(part.number());
  request.set_data(part.data());
  WritePartReply reply;
  stub->WritePart(&context, request, &reply);
  MarkStored(uploadId, part.number(), "");
}

void UploadAllParts(std::shared_ptr<grpc::Channel> channel, const std::string& uploadId, const std::vector<Part>& parts) {
  for (int attempt = 0; attempt < 5; ++attempt) {
    for (const auto& part : parts) WritePart(channel, uploadId, part);
    return;
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <memory>
#include <string>
#include <vector>

constexpr int kWriteDeadlineS = 30;
constexpr int kMaxPartAttempts = 3;

bool WritePart(std::shared_ptr<grpc::Channel> channel, const std::string& uploadId, const Part& part) {
  auto stub = Store::NewStub(channel);
  WritePartRequest request;
  request.set_upload_id(uploadId);
  request.set_part_number(part.number());
  request.set_data(part.data());
  request.set_checksum(part.checksum());
  for (int attempt = 0; attempt < kMaxPartAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kWriteDeadlineS));
    WritePartReply reply;
    const auto status = stub->WritePart(&context, request, &reply);
    if (!status.ok()) continue;
    if (reply.checksum() != part.checksum()) continue;
    MarkStored(uploadId, part.number(), reply.checksum());
    return true;
  }
  return false;
}

std::vector<long long> ResumeList(
    const std::string& uploadId,
    long long partCount,
    const std::map<long long, std::string>& manifest) {
  std::vector<long long> missing;
  for (long long number = 1; number <= partCount; ++number) {
    if (manifest.find(number) == manifest.end()) missing.push_back(number);
  }
  return missing;
}
`,
    },
  },
  debrief: `The fix orders the writer as write, compare the echoed checksum, then mark stored, because the property it protects is that "stored" in the manifest means the bytes in the store are the bytes the client sent. The store can accept a request and still compute a different checksum, and discovering that at finalize costs a full re-upload. Retrying the single part keeps the cost of a bad part proportional to that part, and the deadline turns a stuck store into a bounded failure. The resume list is what the client consumes: ordered missing part numbers, not a percentage. Production writers also keep each part's checksum on the client so the echo can be verified without re-reading the bytes, and surface the store's ETag so finalize can cross-check the multipart metadata.`,
};
