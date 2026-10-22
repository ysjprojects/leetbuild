import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Object-store writes with chunk-safe retries',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the object-store client: it
calls \`PutChunk\`, retries on failure, and marks the file complete. It compiles, it works on a healthy
network, and it hides three production flaws. Review it, fix it, and prove the fix with the checks
below.

Implement the gRPC object-store client:

- Every \`PutChunk\` runs under a **15-second deadline**, so a stuck stream cannot hold the upload open
  forever.
- The chunk request carries the chunk's \`chunk_hash\` (SHA-256 of the bytes), so the store can dedupe a
  chunk that has already been written — including one written by another upload.
- A failed chunk is retried **in place**: only that chunk is re-sent, up to three attempts, and only on
  \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`. Anything else surfaces immediately. The retry must never
  restart the multipart upload or re-send the chunks that already succeeded.
- \`complete\` waits for the store's \`CommitMultipart\` response and only then marks the file complete in
  the local index; a commit the store did not confirm leaves the file incomplete.
- Listings only contain files whose state is \`committed\`, so an upload interrupted between its chunks
  and its commit never appears to a reader as a finished file.

**Failure mode the checks target.** Restarting the whole multipart upload on one failed chunk turns a
flaky connection into a multi-gigabyte re-upload — the bytes that already landed are sent again. Marking
the file complete before the commit returns means readers and the search index see a file whose bytes
the store never committed. And a listing that does not filter on the committed state shows interrupted
uploads as finished ones.`,
  sequence: {
    participants: ['Upload API', 'Object store'],
    messages: [
      {from: 'Upload API', to: 'Object store', label: 'PutChunk(chunk_hash, data) · deadline 15s', kind: 'sync'},
      {from: 'Object store', to: 'Upload API', label: 'chunk stored', kind: 'reply'},
      {from: 'Upload API', to: 'Upload API', label: 'UNAVAILABLE · retry only this chunk', kind: 'async'},
      {from: 'Upload API', to: 'Object store', label: 'PutChunk(same chunk_hash)', kind: 'sync'},
      {from: 'Object store', to: 'Upload API', label: 'dedupe hit · chunk already present', kind: 'reply'},
      {from: 'Upload API', to: 'Object store', label: 'CommitMultipart(manifest)', kind: 'sync'},
      {from: 'Object store', to: 'Upload API', label: 'committed · file_id', kind: 'reply'},
      {from: 'Upload API', to: 'Upload API', label: 'mark committed in the index', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'chunk-deadline',
      title: 'Every chunk write runs under a 15-second deadline',
      detail:
        '`PutChunk` carries a 15-second deadline. The draft calls the RPC with no deadline, so one stuck chunk holds the whole upload open.',
      match: {
        python: {all: [/CHUNK_DEADLINE_S/, /timeout=/]},
        typescript: {all: [/CHUNK_DEADLINE_MS/, /deadline:/]},
        go: {all: [/chunkDeadline/, /WithTimeout/]},
        scala: {all: [/ChunkDeadlineSeconds/, /withDeadlineAfter/]},
        cpp: {all: [/kChunkDeadlineS/, /set_deadline/]},
      },
    },
    {
      id: 'chunk-hash',
      title: 'A chunk carries its hash so the store can dedupe',
      detail:
        'The `PutChunk` request includes the chunk’s SHA-256 so an identical chunk is written once. The draft sends the bytes with no hash, so every retry stores a duplicate.',
      match: {
        python: {all: [/chunk_hash/, /PutChunk/]},
        typescript: {all: [/chunkHash/, /putChunk/]},
        go: {all: [/chunkHash/, /PutChunk/]},
        scala: {all: [/chunkHash/, /putChunk/]},
        cpp: {all: [/chunkHash/, /putChunk/]},
      },
    },
    {
      id: 'chunk-scope',
      title: 'A retry re-sends only the failed chunk',
      detail:
        'Retries are scoped to one chunk and only on the retryable statuses. The draft restarts the whole multipart upload on any failure, re-sending every byte the client already sent.',
      match: {
        python: {all: [/RETRYABLE/, /_retry_chunk/]},
        typescript: {all: [/RETRYABLE/, /retryChunk/]},
        go: {all: [/retryable/, /retryChunk/]},
        scala: {all: [/Retryable/, /retryChunk/]},
        cpp: {all: [/kRetryable/, /retryChunk/]},
      },
    },
    {
      id: 'commit-order',
      title: 'Completion waits for the store’s commit',
      detail:
        'The file is marked complete only after `CommitMultipart` returns a confirmed commit. The draft marks it complete first, so an interrupted upload is already visible as finished.',
      match: {
        python: {order: [/stub\.CommitMultipart\(/, /\._finalize_object\(/]},
        typescript: {order: [/stub\.commitMultipart\(/, /\.finalizeObject\(/]},
        go: {order: [/stub\.CommitMultipart\(/, /\.FinalizeObject\(/]},
        scala: {order: [/stub\.commitMultipart\(/, /\.finalizeObject\(/]},
        cpp: {order: [/stub->CommitMultipart\(/, /->finalizeObject\(/]},
      },
    },
    {
      id: 'listings',
      title: 'Only committed files appear in listings',
      detail:
        'The listing filters on the committed state, so an upload interrupted before its commit is invisible to readers. The draft lists every upload row.',
      match: {
        python: {all: [/def list_files/, /committed/]},
        typescript: {all: [/listFiles/, /committed/]},
        go: {all: [/ListFiles/, /committed/]},
        scala: {all: [/listFiles/, /committed/]},
        cpp: {all: [/listFiles/, /committed/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

from objectstore_pb2 import CommitMultipartRequest, PutChunkRequest
from objectstore_pb2_grpc import ObjectStoreStub

CHUNK_ATTEMPTS = 3


class ObjectStoreClient:
    def __init__(self, stub, index):
        self.stub = stub
        self.index = index

    def _put_chunk(self, multipart_id, index, data):
        return self.stub.PutChunk(PutChunkRequest(multipart_id=multipart_id, index=index, data=data))

    def upload_chunk(self, multipart_id, tenant, index, data):
        # TODO: this draft retries by restarting the whole multipart upload and marks the file
        # finished before the store confirms the commit.
        try:
            return self._put_chunk(multipart_id, index, data)
        except grpc.RpcError:
            return self._restart_upload(tenant, data)

    def _restart_upload(self, tenant, data):
        multipart_id = self.stub.StartMultipartUpload(tenant=tenant)
        for index, chunk in enumerate(data):
            self.stub.PutChunk(PutChunkRequest(multipart_id=multipart_id, index=index, data=chunk))
        return multipart_id

    def complete(self, multipart_id, manifest):
        self._finalize_object(multipart_id)
        return self.stub.CommitMultipart(
            CommitMultipartRequest(multipart_id=multipart_id, manifest=manifest)
        ).file_id

    def _finalize_object(self, multipart_id):
        self.index.set_state(multipart_id, "uploaded")

    def list_files(self, tenant):
        return self.index.by_tenant(tenant)
`,
      solution: `import hashlib

import grpc

from objectstore_pb2 import CommitMultipartRequest, PutChunkRequest
from objectstore_pb2_grpc import ObjectStoreStub

CHUNK_DEADLINE_S = 15
CHUNK_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
COMMITTED = "committed"


def chunk_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ObjectStoreClient:
    def __init__(self, stub, index):
        self.stub = stub
        self.index = index

    def _put_chunk(self, multipart_id, index, data):
        request = PutChunkRequest(
            multipart_id=multipart_id,
            index=index,
            chunk_hash=chunk_hash(data),
            data=data,
        )
        return self.stub.PutChunk(request, timeout=CHUNK_DEADLINE_S)

    def _retry_chunk(self, multipart_id, index, data):
        last = None
        for _ in range(CHUNK_ATTEMPTS):
            try:
                return self._put_chunk(multipart_id, index, data)
            except grpc.RpcError as exc:
                if exc.code() not in RETRYABLE:
                    raise
                last = exc
        raise last

    def put_chunk(self, multipart_id, index, data):
        return self._retry_chunk(multipart_id, index, data)

    def complete(self, multipart_id, manifest):
        response = self.stub.CommitMultipart(
            CommitMultipartRequest(multipart_id=multipart_id, manifest=manifest)
        )
        if not response.committed:
            raise RuntimeError("the store did not confirm the commit")
        self._finalize_object(multipart_id)
        return response.file_id

    def _finalize_object(self, multipart_id):
        self.index.set_state(multipart_id, COMMITTED)

    def list_files(self, tenant):
        return [row for row in self.index.by_tenant(tenant) if row["state"] == COMMITTED]
`,
    },
    typescript: {
      starter: `interface PutChunkResponse {
  ok: boolean;
}

export class ObjectStoreClient {
  constructor(
    private readonly stub: ObjectStoreStub,
    private readonly index: FileIndex,
  ) {}

  putChunk(multipartId: string, index: number, data: Buffer): Promise<PutChunkResponse> {
    return this.stub.putChunk({multipartId, index, data});
  }

  async uploadChunk(multipartId: string, tenant: string, index: number, data: Buffer): Promise<PutChunkResponse> {
    // TODO: this draft retries by restarting the whole multipart upload and marks the file
    // finished before the store confirms the commit.
    try {
      return await this.putChunk(multipartId, index, data);
    } catch {
      return this.restartUpload(tenant, data);
    }
  }

  async restartUpload(tenant: string, data: Buffer): Promise<PutChunkResponse> {
    const multipartId = (await this.stub.startMultipartUpload({tenant})).multipartId;
    return this.putChunk(multipartId, 0, data);
  }

  async complete(multipartId: string): Promise<string> {
    this.finalizeObject(multipartId);
    const response = await this.stub.commitMultipart({multipartId});
    return response.fileId;
  }

  finalizeObject(multipartId: string): void {
    this.index.setState(multipartId, 'uploaded');
  }

  listFiles(tenant: string): FileRow[] {
    return this.index.byTenant(tenant);
  }
}
`,
      solution: `import {createHash} from 'node:crypto';

const CHUNK_DEADLINE_MS = 15_000;
const CHUNK_ATTEMPTS = 3;
const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);
const COMMITTED = 'committed';

function chunkHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface PutChunkResponse {
  ok: boolean;
}

export class ObjectStoreClient {
  constructor(
    private readonly stub: ObjectStoreStub,
    private readonly index: FileIndex,
  ) {}

  putChunk(multipartId: string, index: number, data: Buffer): Promise<PutChunkResponse> {
    return this.stub.putChunk(
      {multipartId, index, chunkHash: chunkHash(data), data},
      {deadline: Date.now() + CHUNK_DEADLINE_MS},
    );
  }

  async retryChunk(multipartId: string, index: number, data: Buffer): Promise<PutChunkResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
      try {
        return await this.putChunk(multipartId, index, data);
      } catch (error) {
        const code = (error as {code?: number}).code;
        if (code === undefined || !RETRYABLE.has(code)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async complete(multipartId: string, manifest: ChunkRef[]): Promise<string> {
    const response = await this.stub.commitMultipart({multipartId, manifest});
    if (!response.committed) throw new Error('the store did not confirm the commit');
    this.finalizeObject(multipartId);
    return response.fileId;
  }

  finalizeObject(multipartId: string): void {
    this.index.setState(multipartId, COMMITTED);
  }

  listFiles(tenant: string): FileRow[] {
    return this.index.byTenant(tenant).filter(row => row.state === COMMITTED);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
)

func (c *ObjectStoreClient) putChunk(ctx context.Context, multipartID string, index int, data []byte) (*PutChunkResponse, error) {
	return c.stub.PutChunk(ctx, &PutChunkRequest{MultipartId: multipartID, Index: int32(index), Data: data})
}

func (c *ObjectStoreClient) uploadChunk(ctx context.Context, multipartID, tenant string, index int, data []byte) (*PutChunkResponse, error) {
	// TODO: this draft retries by restarting the whole multipart upload and marks the file
	// finished before the store confirms the commit.
	response, err := c.putChunk(ctx, multipartID, index, data)
	if err == nil {
		return response, nil
	}
	return c.restartUpload(ctx, tenant, data)
}

func (c *ObjectStoreClient) restartUpload(ctx context.Context, tenant string, data []byte) (*PutChunkResponse, error) {
	started, err := c.stub.StartMultipartUpload(ctx, &StartMultipartUploadRequest{Tenant: tenant})
	if err != nil {
		return nil, err
	}
	return c.putChunk(ctx, started.MultipartId, 0, data)
}

func (c *ObjectStoreClient) complete(ctx context.Context, multipartID string) (string, error) {
	c.FinalizeObject(multipartID)
	response, err := c.stub.CommitMultipart(ctx, &CommitMultipartRequest{MultipartId: multipartID})
	if err != nil {
		return "", err
	}
	return response.FileId, nil
}

func (c *ObjectStoreClient) FinalizeObject(multipartID string) {
	c.index.SetState(multipartID, "uploaded")
}

func (c *ObjectStoreClient) ListFiles(tenant string) []*FileRow {
	return c.index.ByTenant(tenant)
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const chunkDeadline = 15 * time.Second
const chunkAttempts = 3
const committed = "committed"

var retryable = map[codes.Code]bool{
	codes.Unavailable:      true,
	codes.DeadlineExceeded: true,
}

func chunkHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (c *ObjectStoreClient) putChunk(ctx context.Context, multipartID string, index int, data []byte) (*PutChunkResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, chunkDeadline)
	defer cancel()
	return c.stub.PutChunk(ctx, &PutChunkRequest{
		MultipartId: multipartID,
		Index:       int32(index),
		ChunkHash:   chunkHash(data),
		Data:        data,
	})
}

func (c *ObjectStoreClient) retryChunk(ctx context.Context, multipartID string, index int, data []byte) (*PutChunkResponse, error) {
	var last error
	for attempt := 0; attempt < chunkAttempts; attempt++ {
		response, err := c.putChunk(ctx, multipartID, index, data)
		if err == nil {
			return response, nil
		}
		if !retryable[status.Code(err)] {
			return nil, err
		}
		last = err
	}
	return nil, last
}

func (c *ObjectStoreClient) complete(ctx context.Context, multipartID string, manifest []*ChunkRef) (string, error) {
	response, err := c.stub.CommitMultipart(ctx, &CommitMultipartRequest{
		MultipartId: multipartID,
		Manifest:    manifest,
	})
	if err != nil {
		return "", err
	}
	if !response.Committed {
		return "", errors.New("the store did not confirm the commit")
	}
	c.FinalizeObject(multipartID)
	return response.FileId, nil
}

func (c *ObjectStoreClient) FinalizeObject(multipartID string) {
	c.index.SetState(multipartID, committed)
}

func (c *ObjectStoreClient) ListFiles(tenant string) []*FileRow {
	var out []*FileRow
	for _, row := range c.index.ByTenant(tenant) {
		if row.State == committed {
			out = append(out, row)
		}
	}
	return out
}
`,
    },
    scala: {
      starter: `import scala.concurrent.Future

import com.google.protobuf.ByteString

object ObjectStoreClient {
  val ChunkAttempts = 3
}

class ObjectStoreClient(stub: ObjectStoreGrpc.ObjectStoreStub, index: FileIndex) {
  import ObjectStoreClient._

  private def putChunk(multipartId: String, index: Int, data: ByteString): Future[Unit] =
    stub.putChunk(PutChunkRequest(multipartId = multipartId, index = index, data = data)).map(_ => ())

  def uploadChunk(multipartId: String, tenant: String, index: Int, data: ByteString): Future[Unit] = {
    // TODO: this draft retries by restarting the whole multipart upload and marks the file
    // finished before the store confirms the commit.
    putChunk(multipartId, index, data).recoverWith { case _: StatusRuntimeException =>
      restartUpload(tenant, data)
    }
  }

  private def restartUpload(tenant: String, data: ByteString): Future[Unit] =
    stub
      .startMultipartUpload(StartMultipartUploadRequest(tenant = tenant))
      .flatMap(started => putChunk(started.multipartId, 0, data))

  def complete(multipartId: String): Future[String] = {
    this.finalizeObject(multipartId)
    stub.commitMultipart(CommitMultipartRequest(multipartId = multipartId)).map(_.fileId)
  }

  def finalizeObject(multipartId: String): Unit = index.set_state(multipartId, "uploaded")

  def listFiles(tenant: String): Seq[FileRow] = index.by_tenant(tenant)
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.concurrent.Future

import com.google.protobuf.ByteString

object ObjectStoreClient {
  val ChunkDeadlineSeconds = 15
  val ChunkAttempts = 3
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val Committed = "committed"
}

class ObjectStoreClient(stub: ObjectStoreGrpc.ObjectStoreStub, index: FileIndex) {
  import ObjectStoreClient._

  private def putChunk(multipartId: String, index: Int, data: ByteString): Future[Unit] =
    stub
      .withDeadlineAfter(ChunkDeadlineSeconds, TimeUnit.SECONDS)
      .putChunk(PutChunkRequest(multipartId = multipartId, index = index, chunkHash = chunkHash(data), data = data))
      .map(_ => ())

  private def retryChunk(multipartId: String, index: Int, data: ByteString): Future[Unit] =
    putChunk(multipartId, index, data).recoverWith {
      case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) =>
        retryChunk(multipartId, index, data)
    }

  def complete(multipartId: String, manifest: Seq[ChunkRef]): Future[String] = {
    val committed = stub.commitMultipart(CommitMultipartRequest(multipartId = multipartId, manifest = manifest))
    committed.flatMap { response =>
      if (!response.committed) {
        Future.failed(new IllegalStateException("the store did not confirm the commit"))
      } else {
        this.finalizeObject(multipartId)
        Future.successful(response.fileId)
      }
    }
  }

  def finalizeObject(multipartId: String): Unit = index.set_state(multipartId, Committed)

  def listFiles(tenant: String): Seq[FileRow] = index.by_tenant(tenant).filter(_.state == Committed)
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <memory>
#include <string>
#include <vector>

struct ObjectStoreClient {
  std::unique_ptr<ObjectStore::Stub> stub;
  FileIndex index;

  bool putChunk(const std::string& multipartId, int index, const std::string& data, PutChunkResponse* out) {
    grpc::ClientContext context;
    PutChunkRequest request;
    request.set_multipart_id(multipartId);
    request.set_index(index);
    request.set_data(data);
    return stub->PutChunk(&context, request, out).ok();
  }

  bool uploadChunk(const std::string& multipartId, const std::string& tenant, int index, const std::string& data,
                   PutChunkResponse* out) {
    // TODO: this draft retries by restarting the whole multipart upload and marks the file
    // finished before the store confirms the commit.
    if (putChunk(multipartId, index, data, out)) return true;
    return restartUpload(tenant, data, out);
  }

  bool restartUpload(const std::string& tenant, const std::string& data, PutChunkResponse* out) {
    StartMultipartUploadRequest start;
    start.set_tenant(tenant);
    StartMultipartUploadResponse started;
    grpc::ClientContext context;
    if (!stub->StartMultipartUpload(&context, start, &started).ok()) return false;
    return putChunk(started.multipart_id(), 0, data, out);
  }

  std::string complete(const std::string& multipartId) {
    this->finalizeObject(multipartId);
    grpc::ClientContext context;
    CommitMultipartRequest request;
    request.set_multipart_id(multipartId);
    CommitMultipartResponse response;
    if (!stub->CommitMultipart(&context, request, &response).ok()) return "";
    return response.file_id();
  }

  void finalizeObject(const std::string& multipartId) { index.set_state(multipartId, "uploaded"); }

  std::vector<FileRow> listFiles(const std::string& tenant) { return index.by_tenant(tenant); }
};
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <set>
#include <string>
#include <vector>

const int kChunkDeadlineS = 15;
const int kChunkAttempts = 3;
const std::string kCommitted = "committed";

const std::set<grpc::StatusCode> kRetryable = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

std::string chunkHash(const std::string& data);

struct ObjectStoreClient {
  std::unique_ptr<ObjectStore::Stub> stub;
  FileIndex index;

  bool putChunk(const std::string& multipartId, int index, const std::string& data, PutChunkResponse* out) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kChunkDeadlineS));
    PutChunkRequest request;
    request.set_multipart_id(multipartId);
    request.set_index(index);
    request.set_chunk_hash(chunkHash(data));
    request.set_data(data);
    return stub->PutChunk(&context, request, out).ok();
  }

  bool retryChunk(const std::string& multipartId, int index, const std::string& data, PutChunkResponse* out) {
    for (int attempt = 0; attempt < kChunkAttempts; attempt++) {
      if (putChunk(multipartId, index, data, out)) return true;
      if (kRetryable.count(lastStatus.error_code()) == 0) return false;
    }
    return false;
  }

  std::string complete(const std::string& multipartId, const std::vector<ChunkRef>& manifest) {
    grpc::ClientContext context;
    CommitMultipartRequest request;
    request.set_multipart_id(multipartId);
    for (const auto& chunk : manifest) *request.add_manifest() = chunk;
    CommitMultipartResponse response;
    const grpc::Status status = stub->CommitMultipart(&context, request, &response);
    if (!status.ok()) return "";
    if (!response.committed()) return "";
    this->finalizeObject(multipartId);
    return response.file_id();
  }

  void finalizeObject(const std::string& multipartId) { index.set_state(multipartId, kCommitted); }

  std::vector<FileRow> listFiles(const std::string& tenant) {
    std::vector<FileRow> out;
    for (const auto& row : index.by_tenant(tenant)) {
      if (row.state == kCommitted) out.push_back(row);
    }
    return out;
  }
};
`,
    },
  },
  hints: [
    'The deadline belongs on the chunk call, not on the whole upload: one slow chunk should fail its own attempt and be retried, while the chunks that already landed stay landed. Fifteen seconds is long enough for a large chunk on a bad link and short enough to fail before the client gives up.',
    'The chunk hash is what makes the retry cheap. The store keeps a map from hash to object, so a re-sent chunk that already exists is acknowledged without writing bytes again — the retry costs a round-trip, not a re-upload.',
    'Order matters at the end: `CommitMultipart` first, then the local index. If you mark the file complete first, a reader can list a file whose bytes the store has not committed, and the listing is the first thing every client sees.',
  ],
  debrief: `The interviewer is testing whether you can review a generated retry path. The draft's retry reads like resilience and is the opposite: restarting the multipart upload re-sends gigabytes because one chunk failed. The fix is to make the retry the unit of work — one chunk, one hash, one deadline — so the store can dedupe and the client only pays for what it did not already send. The second half is ordering: a file is complete when the store says so, not when the client stops sending. Real clients add jitter to the retry backoff, a circuit breaker so one dead store does not absorb every chunk attempt, and a resumable manifest so a client that reconnects after a crash knows exactly which chunks are already committed.`,
};
