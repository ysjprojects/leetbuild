import type {Step} from '@/lib/types';

export const chunkEmbedStep: Step = {
  id: 'chunk-embed',
  title: 'Chunk and embed: stable ids, batches, a deadline, bounded retries',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'chunk_embed',
  focus: ['worker', 'embed', 'redis'],
  task: `## Task

**Starting point.** The starter's \`index_document(tenant, doc_id, version)\`, the worker body for one
\`doc.ingest\` event, reads the version with \`docs.get\`, cuts the content into 800-character chunks,
gives each a random id, calls \`Embedder.Embed\` (\`rag.proto\`, a stand-in at \`config.EMBEDDER\`) once per
chunk, retrying any error up to ten times, and writes each chunk with \`search.upsert\`. It returns the
chunk count. It indexes the demo and hides five flaws.

**Failure mode the checks target.** A sentence cut at a chunk boundary is whole in neither chunk, so
neither retrieves it. A redelivered event adds a second copy of every chunk. One call per chunk with
no deadline lets one hung embedder replica stall the partition, and an \`INVALID_ARGUMENT\` retried ten
times is a permanent error with a delay.

\`\`\`proto
service Embedder { rpc Embed(EmbedRequest) returns (EmbedReply); }
message EmbedRequest { repeated string texts = 1; }
message EmbedReply   { repeated Vector vectors = 1; string model = 2; }  // one vector per text
\`\`\`

Requirements:

- \`CHUNK_SIZE\` = 800 characters; each chunk starts \`OVERLAP\` = 100 before the previous one ended.
- \`chunk_id\` is the hex SHA-256 of \`"{tenant}:{doc_id}:{version}:{start}"\`.
- \`Embed\` takes up to \`BATCH\` = 32 texts per call, each call under a \`DEADLINE_S\` = 2 s deadline.
- \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried after a backoff, \`MAX_ATTEMPTS\` = 3 calls in all;
  any other status, or the last failure, raises, so the event is redelivered or dead-lettered.`,
  sequence: {
    participants: ['Worker', 'Redis', 'Embedder'],
    messages: [
      {from: 'Worker', to: 'Redis', label: 'docs.get(tenant, doc_id, version)', kind: 'sync'},
      {from: 'Worker', to: 'Worker', label: 'chunks: 800 chars, overlap 100, id = sha256', kind: 'sync'},
      {from: 'Worker', to: 'Embedder', label: 'Embed(32 texts) · deadline 2 s', kind: 'sync'},
      {from: 'Embedder', to: 'Worker', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Worker', to: 'Embedder', label: 'Embed · attempt 2 after backoff', kind: 'sync'},
      {from: 'Embedder', to: 'Worker', label: '32 vectors', kind: 'reply'},
      {from: 'Worker', to: 'Redis', label: 'search.upsert(chunk, vector) by chunk id', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'overlap',
      title: 'Chunks overlap by 100 characters',
      detail:
        'A 2000-character document is indexed as (0, 800), (700, 1500), (1400, 2000), each chunk holding content[start:end], and index_document returns 3. The starter cuts at 0, 800, 1600.',
      match: {
        python: {all: [/\bOVERLAP\b/, /-\s*OVERLAP\b/]},
        typescript: {all: [/\bOVERLAP\b/, /-\s*OVERLAP\b/]},
        go: {all: [/\boverlap\b/, /-\s*overlap\b/]},
        scala: {all: [/\bOverlap\b/, /-\s*Overlap\b/]},
        cpp: {all: [/\bkOverlap\b/, /-\s*kOverlap\b/]},
      },
    },
    {
      id: 'stable-id',
      title: 'Derives chunk ids from tenant, document, version and offset',
      detail:
        'Indexing the same version again (a redelivered event, another worker) leaves the same chunk ids and the same count, each id the SHA-256 of "{tenant}:{doc_id}:{version}:{start}". The starter mints a random id per chunk, so a replay doubles the index.',
      match: {
        python: {all: [/sha256\(/], none: [/\buuid\b/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]/], none: [/randomUUID/]},
        go: {all: [/sha256\.Sum256\(/], none: [/\buuid\./]},
        scala: {all: [/SHA-256/], none: [/\bUUID\b/]},
        cpp: {all: [/sha256_hex\(/], none: [/new_uuid\(/]},
      },
    },
    {
      id: 'batch-size',
      title: 'Embeds up to 32 texts per call',
      detail:
        'A 40-chunk document costs two Embed calls (32 + 8 texts), never more than 32 texts in one request. The starter makes one call per chunk.',
      match: {
        python: {all: [/\bBATCH\b/], none: [/texts\s*=\s*\[\s*text\s*\]/]},
        typescript: {all: [/\bBATCH\b/], none: [/texts:\s*\[\s*text\s*\]/]},
        go: {all: [/\bbatch\b/], none: [/Texts:\s*\[\]string\{\s*text\s*\}/]},
        scala: {all: [/\bBatch\b/], none: [/texts\s*=\s*Seq\(\s*text\s*\)/]},
        cpp: {all: [/\bkBatch\b/], none: [/add_texts\(\s*text\s*\)/]},
      },
    },
    {
      id: 'call-deadline',
      title: 'Puts a two-second deadline on every Embed call',
      detail:
        'Every Embed call carries a deadline of about 2 s; an embedder that hangs 5 s per call ends index_document with an error after three cut calls, in under 8 s. The starter sends no deadline and waits the hang out.',
      match: {
        python: {all: [/timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(/, /\bdeadline\b/]},
        scala: {all: [/withDeadlineAfter\(/, /DeadlineMs/]},
        cpp: {all: [/set_deadline\(/, /kDeadline/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries only transient statuses, three calls at most',
      detail:
        'One UNAVAILABLE is retried after a backoff and the document indexes; INVALID_ARGUMENT raises after one call; UNAVAILABLE five times raises after three calls. The starter retries every status up to ten times.',
      match: {
        python: {all: [/StatusCode\.UNAVAILABLE/, /\bMAX_ATTEMPTS\b/], none: [/MAX_TRIES/]},
        typescript: {all: [/status\.UNAVAILABLE/, /\bMAX_ATTEMPTS\b/], none: [/MAX_TRIES/]},
        go: {all: [/codes\.Unavailable/, /\bmaxAttempts\b/], none: [/maxTries/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/, /\bMaxAttempts\b/], none: [/MaxTries/]},
        cpp: {all: [/StatusCode::UNAVAILABLE/, /\bkMaxAttempts\b/], none: [/kMaxTries/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time
import uuid

import grpc

import rag_pb2
import rag_pb2_grpc
from rag import docs, search
from rag.config import EMBEDDER

logger = logging.getLogger("ragd.chunks")

CHUNK_SIZE = 800
MAX_TRIES = 10
BACKOFF_S = 0.5

channel = grpc.insecure_channel(EMBEDDER)
stub = rag_pb2_grpc.EmbedderStub(channel)


def embed_one(text: str) -> list[float]:
    for attempt in range(1, MAX_TRIES + 1):
        try:
            reply = stub.Embed(rag_pb2.EmbedRequest(texts=[text]))
            return list(reply.vectors[0].values)
        except grpc.RpcError as err:
            logger.warning("embed failed attempt=%d code=%s", attempt, err.code())
            time.sleep(BACKOFF_S)
    raise RuntimeError("embedder unavailable")


def index_document(tenant: str, doc_id: str, version: int) -> int:
    """Chunk, embed and index one stored document version; the number of chunks."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    doc = docs.get(tenant, doc_id, version)
    if doc is None:
        raise LookupError(f"no document {doc_id} v{version} for tenant {tenant}")
    content = doc["content"]
    count = 0
    for start in range(0, len(content), CHUNK_SIZE):
        text = content[start : start + CHUNK_SIZE]
        chunk = {
            "chunk_id": str(uuid.uuid4()),
            "tenant": tenant,
            "doc_id": doc_id,
            "version": version,
            "start": start,
            "end": start + len(text),
            "text": text,
        }
        search.upsert(chunk, embed_one(text))
        count += 1
    return count
`,
      solution: `import hashlib
import logging
import time

import grpc

import rag_pb2
import rag_pb2_grpc
from rag import docs, search
from rag.config import EMBEDDER

logger = logging.getLogger("ragd.chunks")

CHUNK_SIZE = 800
OVERLAP = 100
BATCH = 32
DEADLINE_S = 2.0
MAX_ATTEMPTS = 3
BACKOFF_S = 0.2
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

channel = grpc.insecure_channel(EMBEDDER)
stub = rag_pb2_grpc.EmbedderStub(channel)


def embed_batch(texts: list[str]) -> list[list[float]]:
    """One vector per text: up to MAX_ATTEMPTS calls, each under DEADLINE_S; a permanent status raises at once."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Embed(rag_pb2.EmbedRequest(texts=texts), timeout=DEADLINE_S)
            return [list(v.values) for v in reply.vectors]
        except grpc.RpcError as err:
            if err.code() not in RETRYABLE or attempt == MAX_ATTEMPTS:
                raise
            logger.warning("embed failed attempt=%d code=%s", attempt, err.code())
            time.sleep(BACKOFF_S * 2 ** (attempt - 1))
    raise AssertionError("unreachable")


def index_document(tenant: str, doc_id: str, version: int) -> int:
    """Chunk, embed and index one stored document version; the number of chunks."""
    doc = docs.get(tenant, doc_id, version)
    if doc is None:
        raise LookupError(f"no document {doc_id} v{version} for tenant {tenant}")
    content = doc["content"]
    chunks = []
    start = 0
    while start < len(content):
        end = min(start + CHUNK_SIZE, len(content))
        chunk_id = hashlib.sha256(f"{tenant}:{doc_id}:{version}:{start}".encode("utf-8")).hexdigest()
        chunks.append({"chunk_id": chunk_id, "tenant": tenant, "doc_id": doc_id, "version": version, "start": start, "end": end, "text": content[start:end]})
        if end == len(content):
            break
        start = end - OVERLAP
    for i in range(0, len(chunks), BATCH):
        group = chunks[i : i + BATCH]
        for chunk, vector in zip(group, embed_batch([c["text"] for c in group])):
            search.upsert(chunk, vector)
    return len(chunks)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {EMBEDDER} from 'rag/config';
import * as docs from 'rag/docs';
import * as search from 'rag/search';

export const CHUNK_SIZE = 800;
export const MAX_TRIES = 10;
export const BACKOFF_MS = 500;

interface EmbedReply {
  vectors: {values: number[]}[];
  model: string;
}
interface EmbedderClient {
  Embed(request: {texts: string[]}, options?: {deadline: number}): Promise<EmbedReply>;
}

const {rag} = grpc.loadPackageDefinition(protoLoader.loadSync('rag.proto')) as unknown as {
  rag: {Embedder: new (target: string, credentials: grpc.ChannelCredentials) => EmbedderClient};
};
const stub = new rag.Embedder(EMBEDDER, grpc.credentials.createInsecure());

async function embedOne(text: string): Promise<number[]> {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    try {
      const reply = await stub.Embed({texts: [text]});
      return reply.vectors[0].values;
    } catch (err) {
      console.warn(\`embed failed attempt=\${attempt} code=\${(err as grpc.ServiceError).code}\`);
      await sleep(BACKOFF_MS);
    }
  }
  throw new Error('embedder unavailable');
}

/** Chunk, embed and index one stored document version; the number of chunks. */
export async function indexDocument(tenant: string, docId: string, version: number): Promise<number> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const doc = await docs.get(tenant, docId, version);
  if (doc === null) throw new Error(\`no document \${docId} v\${version} for tenant \${tenant}\`);
  const content = doc.content;
  let count = 0;
  for (let start = 0; start < content.length; start += CHUNK_SIZE) {
    const text = content.slice(start, start + CHUNK_SIZE);
    const chunk = {chunk_id: randomUUID(), tenant, doc_id: docId, version, start, end: start + text.length, text};
    await search.upsert(chunk, await embedOne(text));
    count += 1;
  }
  return count;
}
`,
      solution: `import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {EMBEDDER} from 'rag/config';
import * as docs from 'rag/docs';
import * as search from 'rag/search';

export const CHUNK_SIZE = 800;
export const OVERLAP = 100;
export const BATCH = 32;
export const DEADLINE_MS = 2_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 200;

interface EmbedReply {
  vectors: {values: number[]}[];
  model: string;
}
interface EmbedderClient {
  Embed(request: {texts: string[]}, options?: {deadline: number}): Promise<EmbedReply>;
}

const {rag} = grpc.loadPackageDefinition(protoLoader.loadSync('rag.proto')) as unknown as {
  rag: {Embedder: new (target: string, credentials: grpc.ChannelCredentials) => EmbedderClient};
};
const stub = new rag.Embedder(EMBEDDER, grpc.credentials.createInsecure());

/** One vector per text: up to MAX_ATTEMPTS calls, each under DEADLINE_MS; a permanent status throws at once. */
async function embedBatch(texts: string[]): Promise<number[][]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await stub.Embed({texts}, {deadline: Date.now() + DEADLINE_MS});
      return reply.vectors.map(v => v.values);
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      const retryable = code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED;
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      console.warn(\`embed failed attempt=\${attempt} code=\${code}\`);
      await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

/** Chunk, embed and index one stored document version; the number of chunks. */
export async function indexDocument(tenant: string, docId: string, version: number): Promise<number> {
  const doc = await docs.get(tenant, docId, version);
  if (doc === null) throw new Error(\`no document \${docId} v\${version} for tenant \${tenant}\`);
  const content = doc.content;
  const chunks: search.Chunk[] = [];
  for (let start = 0; start < content.length; ) {
    const end = Math.min(start + CHUNK_SIZE, content.length);
    const chunkId = createHash('sha256').update(\`\${tenant}:\${docId}:\${version}:\${start}\`, 'utf8').digest('hex');
    chunks.push({chunk_id: chunkId, tenant, doc_id: docId, version, start, end, text: content.slice(start, end)});
    if (end === content.length) break;
    start = end - OVERLAP;
  }
  for (let i = 0; i < chunks.length; i += BATCH) {
    const group = chunks.slice(i, i + BATCH);
    const vectors = await embedBatch(group.map(c => c.text));
    for (const [j, chunk] of group.entries()) await search.upsert(chunk, vectors[j]);
  }
  return chunks.length;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"rag/config" // config.Embedder — provided
	"rag/docs"   // docs.Get(ctx, tenant, docID, version) — provided
	pb "rag/gen/rag"
	"rag/search" // search.Chunk, search.Upsert(ctx, chunk, vector) — provided
)

const (
	chunkSize = 800
	maxTries  = 10
	backoff   = 500 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Embedder, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewEmbedderClient(conn)

func embedOne(ctx context.Context, text string) ([]float64, error) {
	var lastErr error
	for attempt := 1; attempt <= maxTries; attempt++ {
		reply, err := stub.Embed(ctx, &pb.EmbedRequest{Texts: []string{text}})
		if err == nil {
			return reply.GetVectors()[0].GetValues(), nil
		}
		lastErr = err
		log.Printf("embed failed attempt=%d: %v", attempt, err)
		time.Sleep(backoff)
	}
	return nil, fmt.Errorf("embedder unavailable: %w", lastErr)
}

// indexDocument chunks, embeds and indexes one stored document version; the number of chunks.
func indexDocument(ctx context.Context, tenant, docID string, version int) (int, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	doc, err := docs.Get(ctx, tenant, docID, version)
	if err != nil {
		return 0, err
	}
	if doc == nil {
		return 0, fmt.Errorf("no document %s v%d for tenant %s", docID, version, tenant)
	}
	count := 0
	for start := 0; start < len(doc.Content); start += chunkSize {
		end := min(start+chunkSize, len(doc.Content))
		text := doc.Content[start:end]
		vector, err := embedOne(ctx, text)
		if err != nil {
			return count, err
		}
		chunk := search.Chunk{ChunkID: uuid.NewString(), Tenant: tenant, DocID: docID, Version: version, Start: start, End: end, Text: text}
		if err := search.Upsert(ctx, chunk, vector); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"rag/config" // config.Embedder — provided
	"rag/docs"   // docs.Get(ctx, tenant, docID, version) — provided
	pb "rag/gen/rag"
	"rag/search" // search.Chunk, search.Upsert(ctx, chunk, vector) — provided
)

const (
	chunkSize   = 800
	overlap     = 100
	batch       = 32
	deadline    = 2 * time.Second
	maxAttempts = 3
	backoff     = 200 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Embedder, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewEmbedderClient(conn)

// embedBatch is one vector per text: up to maxAttempts calls, each under deadline; a permanent status fails at once.
func embedBatch(ctx context.Context, texts []string) ([][]float64, error) {
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Embed(callCtx, &pb.EmbedRequest{Texts: texts})
		cancel()
		if err == nil {
			vectors := make([][]float64, len(reply.GetVectors()))
			for i, v := range reply.GetVectors() {
				vectors[i] = v.GetValues()
			}
			return vectors, nil
		}
		code := status.Code(err)
		if (code != codes.Unavailable && code != codes.DeadlineExceeded) || attempt == maxAttempts {
			return nil, err
		}
		log.Printf("embed failed attempt=%d: %v", attempt, err)
		time.Sleep(backoff << (attempt - 1))
	}
}

// indexDocument chunks, embeds and indexes one stored document version; the number of chunks.
func indexDocument(ctx context.Context, tenant, docID string, version int) (int, error) {
	doc, err := docs.Get(ctx, tenant, docID, version)
	if err != nil {
		return 0, err
	}
	if doc == nil {
		return 0, fmt.Errorf("no document %s v%d for tenant %s", docID, version, tenant)
	}
	content := doc.Content
	var chunks []search.Chunk
	for start := 0; start < len(content); {
		end := min(start+chunkSize, len(content))
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d:%d", tenant, docID, version, start)))
		chunks = append(chunks, search.Chunk{ChunkID: hex.EncodeToString(sum[:]), Tenant: tenant, DocID: docID, Version: version, Start: start, End: end, Text: content[start:end]})
		if end == len(content) {
			break
		}
		start = end - overlap
	}
	for i := 0; i < len(chunks); i += batch {
		group := chunks[i:min(i+batch, len(chunks))]
		texts := make([]string, len(group))
		for j, c := range group {
			texts[j] = c.Text
		}
		vectors, err := embedBatch(ctx, texts)
		if err != nil {
			return 0, err
		}
		for j, c := range group {
			if err := search.Upsert(ctx, c, vectors[j]); err != nil {
				return 0, err
			}
		}
	}
	return len(chunks), nil
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import rag.{Chunk, Config, Docs, Search}
import rag.rag.{EmbedRequest, EmbedderGrpc}

object ChunkWorker {
  val ChunkSize = 800
  val MaxTries = 10
  val BackoffMs = 500L

  private val channel = ManagedChannelBuilder.forTarget(Config.Embedder).usePlaintext().build()
  private val stub = EmbedderGrpc.blockingStub(channel)

  private def embedOne(text: String): Seq[Double] = {
    var attempt = 1
    while (attempt <= MaxTries) {
      try {
        return stub.embed(EmbedRequest(texts = Seq(text))).vectors.head.values
      } catch {
        case e: StatusRuntimeException =>
          System.err.println(s"embed failed attempt=$attempt code=\${e.getStatus.getCode}")
          Thread.sleep(BackoffMs)
          attempt += 1
      }
    }
    throw new RuntimeException("embedder unavailable")
  }

  /** Chunk, embed and index one stored document version; the number of chunks. */
  def indexDocument(tenant: String, docId: String, version: Int): Int = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val doc = Docs.get(tenant, docId, version).getOrElse(throw new NoSuchElementException(s"no document $docId v$version for tenant $tenant"))
    val content = doc.content
    var count = 0
    for (start <- 0 until content.length by ChunkSize) {
      val end = math.min(start + ChunkSize, content.length)
      val text = content.substring(start, end)
      Search.upsert(Chunk(UUID.randomUUID().toString, tenant, docId, version, start, end, text), embedOne(text))
      count += 1
    }
    count
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import rag.{Chunk, Config, Docs, Search}
import rag.rag.{EmbedRequest, EmbedderGrpc}

object ChunkWorker {
  val ChunkSize = 800
  val Overlap = 100
  val Batch = 32
  val DeadlineMs = 2000L
  val MaxAttempts = 3
  val BackoffMs = 200L
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val channel = ManagedChannelBuilder.forTarget(Config.Embedder).usePlaintext().build()
  private val stub = EmbedderGrpc.blockingStub(channel)

  private def chunkId(tenant: String, docId: String, version: Int, start: Int): String =
    MessageDigest.getInstance("SHA-256").digest(s"$tenant:$docId:$version:$start".getBytes("UTF-8")).map("%02x".format(_)).mkString

  /** One vector per text: up to MaxAttempts calls, each under DeadlineMs; a permanent status throws at once. */
  private def embedBatch(texts: Seq[String]): Seq[Seq[Double]] = {
    var attempt = 1
    while (true) {
      try {
        return stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).embed(EmbedRequest(texts = texts)).vectors.map(_.values)
      } catch {
        case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) && attempt < MaxAttempts =>
          System.err.println(s"embed failed attempt=$attempt code=\${e.getStatus.getCode}")
          Thread.sleep(BackoffMs << (attempt - 1))
          attempt += 1
      }
    }
    Seq.empty
  }

  /** Chunk, embed and index one stored document version; the number of chunks. */
  def indexDocument(tenant: String, docId: String, version: Int): Int = {
    val doc = Docs.get(tenant, docId, version).getOrElse(throw new NoSuchElementException(s"no document $docId v$version for tenant $tenant"))
    val content = doc.content
    val chunks = Vector.newBuilder[Chunk]
    var start = 0
    var more = content.nonEmpty
    while (more) {
      val end = math.min(start + ChunkSize, content.length)
      chunks += Chunk(chunkId(tenant, docId, version, start), tenant, docId, version, start, end, content.substring(start, end))
      more = end < content.length
      start = end - Overlap
    }
    val all = chunks.result()
    all.grouped(Batch).foreach { group =>
      group.zip(embedBatch(group.map(_.text))).foreach { case (chunk, vector) => Search.upsert(chunk, vector) }
    }
    all.length
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "ids.h"         // new_uuid() — provided
#include "rag.grpc.pb.h"
#include "rag/config.h"  // config::kEmbedder — provided
#include "rag/docs.h"    // docs::get(tenant, doc_id, version) — provided
#include "rag/search.h"  // search::Chunk, search::upsert(chunk, vector) — provided

constexpr int kChunkSize = 800;
constexpr int kMaxTries = 10;
constexpr std::chrono::milliseconds kBackoff{500};

auto channel = grpc::CreateChannel(config::kEmbedder, grpc::InsecureChannelCredentials());
auto stub = rag::Embedder::NewStub(channel);

std::vector<double> embed_one(const std::string& text) {
  for (int attempt = 1; attempt <= kMaxTries; attempt++) {
    grpc::ClientContext ctx;
    rag::EmbedRequest request;
    request.add_texts(text);
    rag::EmbedReply reply;
    const grpc::Status status = stub->Embed(&ctx, request, &reply);
    if (status.ok()) return {reply.vectors(0).values().begin(), reply.vectors(0).values().end()};
    std::cerr << "embed failed attempt=" << attempt << " code=" << status.error_code() << "\\n";
    std::this_thread::sleep_for(kBackoff);
  }
  throw std::runtime_error("embedder unavailable");
}

// Chunk, embed and index one stored document version; the number of chunks.
int index_document(const std::string& tenant, const std::string& doc_id, int version) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto doc = docs::get(tenant, doc_id, version);
  if (!doc) throw std::runtime_error("no document " + doc_id + " for tenant " + tenant);
  const std::string& content = doc->content;
  int count = 0;
  for (int start = 0; start < static_cast<int>(content.size()); start += kChunkSize) {
    const int end = std::min(start + kChunkSize, static_cast<int>(content.size()));
    const std::string text = content.substr(start, end - start);
    search::upsert({new_uuid(), tenant, doc_id, version, start, end, text}, embed_one(text));
    count++;
  }
  return count;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "digest.h"      // sha256_hex(bytes) — provided
#include "rag.grpc.pb.h"
#include "rag/config.h"  // config::kEmbedder — provided
#include "rag/docs.h"    // docs::get(tenant, doc_id, version) — provided
#include "rag/search.h"  // search::Chunk, search::upsert(chunk, vector) — provided

constexpr int kChunkSize = 800;
constexpr int kOverlap = 100;
constexpr size_t kBatch = 32;
constexpr std::chrono::seconds kDeadline{2};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{200};

auto channel = grpc::CreateChannel(config::kEmbedder, grpc::InsecureChannelCredentials());
auto stub = rag::Embedder::NewStub(channel);

// One vector per text: up to kMaxAttempts calls, each under kDeadline; a permanent status throws at once.
std::vector<std::vector<double>> embed_batch(const std::vector<search::Chunk>& group) {
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    rag::EmbedRequest request;
    for (const auto& c : group) request.add_texts(c.text);
    rag::EmbedReply reply;
    const grpc::Status status = stub->Embed(&ctx, request, &reply);
    if (status.ok()) {
      std::vector<std::vector<double>> vectors;
      for (const auto& v : reply.vectors()) vectors.emplace_back(v.values().begin(), v.values().end());
      return vectors;
    }
    const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE || status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable || attempt == kMaxAttempts) throw std::runtime_error("embed failed: " + status.error_message());
    std::cerr << "embed failed attempt=" << attempt << " code=" << status.error_code() << "\\n";
    std::this_thread::sleep_for(kBackoff * (1 << (attempt - 1)));
  }
}

// Chunk, embed and index one stored document version; the number of chunks.
int index_document(const std::string& tenant, const std::string& doc_id, int version) {
  const auto doc = docs::get(tenant, doc_id, version);
  if (!doc) throw std::runtime_error("no document " + doc_id + " for tenant " + tenant);
  const std::string& content = doc->content;
  const int size = static_cast<int>(content.size());
  std::vector<search::Chunk> chunks;
  for (int start = 0; start < size;) {
    const int end = std::min(start + kChunkSize, size);
    const std::string id = sha256_hex(tenant + ":" + doc_id + ":" + std::to_string(version) + ":" + std::to_string(start));
    chunks.push_back({id, tenant, doc_id, version, start, end, content.substr(start, end - start)});
    if (end == size) break;
    start = end - kOverlap;
  }
  for (size_t i = 0; i < chunks.size(); i += kBatch) {
    const std::vector<search::Chunk> group(chunks.begin() + i, chunks.begin() + std::min(i + kBatch, chunks.size()));
    const auto vectors = embed_batch(group);
    for (size_t j = 0; j < group.size(); j++) search::upsert(group[j], vectors.at(j));
  }
  return static_cast<int>(chunks.size());
}
`,
    },
  },
  harness: {
    python: `import hashlib
import math

import grpc

import rag_pb2
import rag_pb2_grpc
from rag import config, embed

DOC_KEY = "rag:doc:t1:handbook:3"


class EmbedderServicer(rag_pb2_grpc.EmbedderServicer):
    """The stand-in embedder: one rag.embed vector per text."""

    def Embed(self, request, context):
        return rag_pb2.EmbedReply(vectors=[rag_pb2.Vector(values=embed.vector(t)) for t in request.texts], model=embed.MODEL)


def _text(n):
    return " ".join(f"word{i}" for i in range(n // 4 + 1))[:n]


def _world(ctx, n):
    ctx.grpc.serve(rag_pb2_grpc.add_EmbedderServicer_to_server, EmbedderServicer(), config.EMBEDDER)
    content = _text(n)
    ctx.redis.hset(DOC_KEY, mapping={"sha256": "-", "job_id": "j1", "content_type": "text/plain", "content": content})
    return ctx.load("chunk_embed"), content


def _index(m):
    return m.index_document("t1", "handbook", 3)


def _raises(m):
    try:
        _index(m)
    except Exception:  # noqa: BLE001 - any error ends the event's processing
        return True
    return False


def _chunks(ctx):
    rows = [ctx.redis.hgetall(f"rag:chunk:{cid}") for cid in ctx.redis.smembers("rag:chunks:t1")]
    return sorted(rows, key=lambda c: int(c.get("start", 0)))


def _calls(ctx):
    return ctx.grpc.calls_to("Embed")


def check_overlap(ctx):
    m, content = _world(ctx, 2000)
    n = _index(m)
    chunks = _chunks(ctx)
    spans = [(int(c["start"]), int(c["end"])) for c in chunks]
    assert spans == [(0, 800), (700, 1500), (1400, 2000)], f"a 2000-character document must be chunked (0, 800), (700, 1500), (1400, 2000): 800 characters, each starting 100 before the previous one ended; got {spans}"
    for c in chunks:
        assert c["text"] == content[int(c["start"]) : int(c["end"])], f"the chunk at {c['start']} must hold content[start:end]"
    assert n == 3, f"index_document returns the number of chunks: expected 3, got {n}"


def check_stable_id(ctx):
    m, _ = _world(ctx, 2000)
    _index(m)
    first = sorted(ctx.redis.smembers("rag:chunks:t1"))
    _index(ctx.reload("chunk_embed"))  # the event redelivered, to another worker
    again = sorted(ctx.redis.smembers("rag:chunks:t1"))
    assert again == first, f"a redelivered event changed the index: {len(first)} chunks before, {len(again)} after; a chunk's id must come from what it is, not from a random draw"
    expected = sorted(hashlib.sha256(f"t1:handbook:3:{c['start']}".encode()).hexdigest() for c in _chunks(ctx))
    assert first == expected, f"chunk ids must be sha256('{{tenant}}:{{doc_id}}:{{version}}:{{start}}'), got {first[:2]}..."


def check_batch_size(ctx):
    m, _ = _world(ctx, 700 * 39 + 800)
    n = _index(m)
    sizes = [len(c.request.texts) for c in _calls(ctx)]
    assert max(sizes) <= 32, f"an Embed call carried {max(sizes)} texts; at most 32 per call"
    assert len(sizes) == math.ceil(n / 32), f"{n} chunks were embedded in {len(sizes)} calls of {sizes[:5]}... texts; batches of 32 need {math.ceil(n / 32)}"
    assert len(_chunks(ctx)) == n, f"every chunk is written: index_document returned {n}, the index holds {len(_chunks(ctx))}"


def check_call_deadline(ctx):
    m, _ = _world(ctx, 2000)
    _index(m)
    calls = _calls(ctx)
    assert calls and all(c.timeout is not None for c in calls), "an Embed call carries no deadline: a hung embedder holds the worker, and the partition behind it, until it answers"
    assert all(1.5 <= c.timeout <= 2.5 for c in calls), f"the deadline must be DEADLINE_S = 2 s, got {[c.timeout for c in calls]}"
    ctx.grpc.set_latency("Embed", 5.0, config.EMBEDDER)
    before, started = len(calls), ctx.clock.offset
    raised = _raises(m)
    waited, hung = ctx.clock.offset - started, len(_calls(ctx)) - before
    assert raised, f"an embedder that hangs 5 s on every call must end index_document with an error once the attempts are spent; it returned after {waited:.1f} s and {hung} calls"
    assert hung == 3, f"a hung call is cut at the deadline and retried: expected 3 calls, saw {hung}"
    assert waited <= 8.0, f"index_document waited {waited:.1f} s on a hung embedder: three 2-second deadlines and two backoffs fit in 8"


def check_bounded_retry(ctx):
    m, _ = _world(ctx, 500)
    ctx.grpc.fail("Embed", grpc.StatusCode.UNAVAILABLE, "embedder restarting", times=1, target=config.EMBEDDER)
    assert _index(m) == 1
    assert len(_calls(ctx)) == 2 and ctx.clock.sleeps >= 1, f"one UNAVAILABLE earns one retry after a backoff: saw {len(_calls(ctx))} calls and {ctx.clock.sleeps} sleeps"
    ctx.grpc.fail("Embed", grpc.StatusCode.INVALID_ARGUMENT, "text rejected", times=1, target=config.EMBEDDER)
    raised = _raises(m)
    assert raised and len(_calls(ctx)) == 3, f"INVALID_ARGUMENT is permanent: one call, then an error; saw {len(_calls(ctx)) - 2} calls and {'an error' if raised else 'a normal return'}"
    ctx.grpc.fail("Embed", grpc.StatusCode.UNAVAILABLE, "embedder down", times=5, target=config.EMBEDDER)
    raised = _raises(m)
    assert raised and len(_calls(ctx)) == 6, f"an embedder that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls, then an error; saw {len(_calls(ctx)) - 3} calls and {'an error' if raised else 'a normal return'}"
`,
    typescript: `import {createHash} from 'node:crypto';

const DOC_KEY = 'rag:doc:t1:handbook:3';

const text = (n: number): string => Array.from({length: Math.floor(n / 4) + 1}, (_, i) => \`word\${i}\`).join(' ').slice(0, n);

/** The stand-in embedder at EMBEDDER, the document stored, the learner's module. */
function world(ctx, n: number) {
  const {rag} = ctx.proto('rag.proto');
  const config = ctx.load('/support/rag/config.ts');
  const embed = ctx.load('/support/rag/embed.ts');
  ctx.grpc.serve(rag.Embedder.service, {
    Embed(call, callback) {
      callback(null, {vectors: call.request.texts.map(t => ({values: embed.vector(t)})), model: embed.MODEL});
    },
  }, config.EMBEDDER);
  const content = text(n);
  ctx.redis.hset(DOC_KEY, 'sha256', '-', 'job_id', 'j1', 'content_type', 'text/plain', 'content', content);
  return {m: ctx.load('chunk_embed'), content, config};
}

const index = m => m.indexDocument('t1', 'handbook', 3);
const raises = async m => {
  try {
    await index(m);
  } catch {
    return true;
  }
  return false;
};
const chunks = ctx => ctx.redis.smembers('rag:chunks:t1').map(id => ctx.redis.hgetall(\`rag:chunk:\${id}\`)).sort((a, b) => Number(a.start) - Number(b.start));
const calls = ctx => ctx.grpc.callsTo('Embed');

export async function check_overlap(ctx) {
  const {m, content} = world(ctx, 2000);
  const n = await index(m);
  const all = chunks(ctx);
  const spans = all.map(c => [Number(c.start), Number(c.end)]);
  assert.deepEqual(spans, [[0, 800], [700, 1500], [1400, 2000]], \`a 2000-character document must be chunked (0, 800), (700, 1500), (1400, 2000): 800 characters, each starting 100 before the previous one ended; got \${JSON.stringify(spans)}\`);
  for (const c of all) assert.equal(c.text, content.slice(Number(c.start), Number(c.end)), \`the chunk at \${c.start} must hold content[start:end]\`);
  assert.equal(n, 3, \`indexDocument resolves to the number of chunks: expected 3, got \${n}\`);
}

export async function check_stable_id(ctx) {
  const {m} = world(ctx, 2000);
  await index(m);
  const first = ctx.redis.smembers('rag:chunks:t1').sort();
  await index(ctx.reload('chunk_embed')); // the event redelivered, to another worker
  const again = ctx.redis.smembers('rag:chunks:t1').sort();
  assert.deepEqual(again, first, \`a redelivered event changed the index: \${first.length} chunks before, \${again.length} after; a chunk's id must come from what it is, not from a random draw\`);
  const expected = chunks(ctx).map(c => createHash('sha256').update(\`t1:handbook:3:\${c.start}\`).digest('hex')).sort();
  assert.deepEqual(first, expected, \`chunk ids must be sha256('{tenant}:{doc_id}:{version}:{start}'), got \${first.slice(0, 2).join(', ')}...\`);
}

export async function check_batch_size(ctx) {
  const {m} = world(ctx, 700 * 39 + 800);
  const n = await index(m);
  const sizes = calls(ctx).map(c => c.request.texts.length);
  assert(Math.max(...sizes) <= 32, \`an Embed call carried \${Math.max(...sizes)} texts; at most 32 per call\`);
  assert.equal(sizes.length, Math.ceil(n / 32), \`\${n} chunks were embedded in \${sizes.length} calls of \${JSON.stringify(sizes.slice(0, 5))}... texts; batches of 32 need \${Math.ceil(n / 32)}\`);
  assert.equal(chunks(ctx).length, n, \`every chunk is written: indexDocument resolved to \${n}, the index holds \${chunks(ctx).length}\`);
}

export async function check_call_deadline(ctx) {
  const {m, config} = world(ctx, 2000);
  await index(m);
  const all = calls(ctx);
  assert(all.length > 0 && all.every(c => c.timeout !== null), 'an Embed call carries no deadline: a hung embedder holds the worker, and the partition behind it, until it answers');
  assert(all.every(c => 1.5 <= c.timeout && c.timeout <= 2.5), \`the deadline must be DEADLINE_MS = 2000 ms, got \${JSON.stringify(all.map(c => c.timeout))} s\`);
  ctx.grpc.setLatency('Embed', 5.0, config.EMBEDDER);
  const before = all.length;
  const started = ctx.clock.now();
  const raised = await raises(m);
  const waited = (ctx.clock.now() - started) / 1000;
  const hung = calls(ctx).length - before;
  assert(raised, \`an embedder that hangs 5 s on every call must end indexDocument with an error once the attempts are spent; it resolved after \${waited.toFixed(1)} s and \${hung} calls\`);
  assert.equal(hung, 3, \`a hung call is cut at the deadline and retried: expected 3 calls, saw \${hung}\`);
  assert(waited <= 8.0, \`indexDocument waited \${waited.toFixed(1)} s on a hung embedder: three 2-second deadlines and two backoffs fit in 8\`);
}

export async function check_bounded_retry(ctx) {
  const {m, config} = world(ctx, 500);
  ctx.grpc.fail('Embed', ctx.grpc.status.UNAVAILABLE, 'embedder restarting', 1, config.EMBEDDER);
  assert.equal(await index(m), 1);
  assert(calls(ctx).length === 2 && ctx.clock.sleeps >= 1, \`one UNAVAILABLE earns one retry after a backoff: saw \${calls(ctx).length} calls and \${ctx.clock.sleeps} sleeps\`);
  ctx.grpc.fail('Embed', ctx.grpc.status.INVALID_ARGUMENT, 'text rejected', 1, config.EMBEDDER);
  let raised = await raises(m);
  assert(raised && calls(ctx).length === 3, \`INVALID_ARGUMENT is permanent: one call, then an error; saw \${calls(ctx).length - 2} calls and \${raised ? 'an error' : 'a normal return'}\`);
  ctx.grpc.fail('Embed', ctx.grpc.status.UNAVAILABLE, 'embedder down', 5, config.EMBEDDER);
  raised = await raises(m);
  assert(raised && calls(ctx).length === 6, \`an embedder that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls, then an error; saw \${calls(ctx).length - 3} calls and \${raised ? 'an error' : 'a normal return'}\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	"rag/config"
	"rag/embed"
	pb "rag/gen/rag"

	"leetbuild/harness"
)

const chunkDoc = "rag:doc:t1:handbook:3"

// embedderPeer is the stand-in embedder: one rag/embed vector per text.
type embedderPeer struct {
	pb.UnimplementedEmbedderServer
}

func (embedderPeer) Embed(_ context.Context, req *pb.EmbedRequest) (*pb.EmbedReply, error) {
	out := &pb.EmbedReply{Model: embed.Model}
	for _, t := range req.GetTexts() {
		out.Vectors = append(out.Vectors, &pb.Vector{Values: embed.Vector(t)})
	}
	return out, nil
}

func chunkText(n int) string {
	var b strings.Builder
	for i := 0; b.Len() < n; i++ {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString("word" + strconv.Itoa(i))
	}
	return b.String()[:n]
}

func chunkWorld(ctx *harness.Ctx, n int) string {
	pb.RegisterEmbedderServer(ctx.GRPC.Server(config.Embedder), &embedderPeer{})
	content := chunkText(n)
	ctx.Redis.Do("HSET", chunkDoc, "sha256", "-", "job_id", "j1", "content_type", "text/plain", "content", content)
	return content
}

func chunkIndex() (int, error) { return indexDocument(context.Background(), "t1", "handbook", 3) }

type storedChunk struct {
	id         string
	start, end int
	text       string
}

func chunkRows(ctx *harness.Ctx) []storedChunk {
	var out []storedChunk
	for _, id := range ctx.Redis.SMembers("rag:chunks:t1") {
		h := ctx.Redis.HGetAll("rag:chunk:" + id)
		start, _ := strconv.Atoi(h["start"])
		end, _ := strconv.Atoi(h["end"])
		out = append(out, storedChunk{id, start, end, h["text"]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].start < out[j].start })
	return out
}

func chunkCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Embed", "") }

func CheckOverlap(ctx *harness.Ctx) {
	content := chunkWorld(ctx, 2000)
	n, err := chunkIndex()
	ctx.NoError(err, "indexDocument")
	rows := chunkRows(ctx)
	var spans [][2]int
	for _, c := range rows {
		spans = append(spans, [2]int{c.start, c.end})
	}
	ctx.Equal(spans, [][2]int{{0, 800}, {700, 1500}, {1400, 2000}}, "a 2000-character document's chunks (800 characters, each starting 100 before the previous one ended)")
	for _, c := range rows {
		ctx.Assert(c.text == content[c.start:c.end], "the chunk at %d must hold content[start:end]", c.start)
	}
	ctx.Equal(n, 3, "indexDocument returns the number of chunks")
}

func CheckStableId(ctx *harness.Ctx) {
	chunkWorld(ctx, 2000)
	_, err := chunkIndex()
	ctx.NoError(err, "indexDocument")
	first := ctx.Redis.SMembers("rag:chunks:t1")
	_, err = chunkIndex() // the event redelivered
	ctx.NoError(err, "indexDocument, redelivered")
	again := ctx.Redis.SMembers("rag:chunks:t1")
	ctx.Assert(len(again) == len(first), "a redelivered event changed the index: %d chunks before, %d after; a chunk's id must come from what it is, not from a random draw", len(first), len(again))
	var expected []string
	for _, c := range chunkRows(ctx) {
		sum := sha256.Sum256([]byte(fmt.Sprintf("t1:handbook:3:%d", c.start)))
		expected = append(expected, hex.EncodeToString(sum[:]))
	}
	sort.Strings(expected)
	ctx.Equal(first, expected, "chunk ids must be sha256('{tenant}:{doc_id}:{version}:{start}')")
}

func CheckBatchSize(ctx *harness.Ctx) {
	chunkWorld(ctx, 700*39+800)
	n, err := chunkIndex()
	ctx.NoError(err, "indexDocument")
	var sizes []int
	most := 0
	for _, c := range chunkCalls(ctx) {
		size := len(c.Request.(*pb.EmbedRequest).GetTexts())
		sizes = append(sizes, size)
		most = max(most, size)
	}
	ctx.Assert(most <= 32, "an Embed call carried %d texts; at most 32 per call", most)
	ctx.Assert(len(sizes) == (n+31)/32, "%d chunks were embedded in %d calls of %v texts; batches of 32 need %d", n, len(sizes), sizes, (n+31)/32)
	ctx.Equal(len(chunkRows(ctx)), n, "every chunk is written: indexDocument's count against the index")
}

func CheckCallDeadline(ctx *harness.Ctx) {
	chunkWorld(ctx, 2000)
	_, err := chunkIndex()
	ctx.NoError(err, "indexDocument")
	calls := chunkCalls(ctx)
	ctx.Assert(len(calls) > 0, "no Embed call was made")
	for _, c := range calls {
		ctx.Assert(c.HasDeadline(), "an Embed call carries no deadline: a hung embedder holds the worker, and the partition behind it, until it answers")
		ctx.Assert(1500*time.Millisecond <= c.Timeout && c.Timeout <= 2500*time.Millisecond, "the deadline must be 2 s, got %v", c.Timeout)
	}
	ctx.GRPC.SetLatency("Embed", 5.0, config.Embedder)
	before, started := len(calls), ctx.Clock.Now()
	_, err = chunkIndex()
	waited, hung := float64(ctx.Clock.Now()-started)/1000, len(chunkCalls(ctx))-before
	ctx.Assert(err != nil, "an embedder that hangs 5 s on every call must end indexDocument with an error once the attempts are spent; it returned after %.1f s and %d calls", waited, hung)
	ctx.Equal(hung, 3, "a hung call is cut at the deadline and retried; calls")
	ctx.Assert(waited <= 8.0, "indexDocument waited %.1f s on a hung embedder: three 2-second deadlines and two backoffs fit in 8", waited)
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	chunkWorld(ctx, 500)
	ctx.GRPC.Fail("Embed", codes.Unavailable, "embedder restarting", 1, config.Embedder)
	n, err := chunkIndex()
	ctx.NoError(err, "indexDocument after one UNAVAILABLE")
	ctx.Equal(n, 1, "chunks")
	ctx.Assert(len(chunkCalls(ctx)) == 2 && ctx.Clock.Sleeps() >= 1, "one UNAVAILABLE earns one retry after a backoff: saw %d calls and %d sleeps", len(chunkCalls(ctx)), ctx.Clock.Sleeps())
	ctx.GRPC.Fail("Embed", codes.InvalidArgument, "text rejected", 1, config.Embedder)
	_, err = chunkIndex()
	ctx.Assert(err != nil && len(chunkCalls(ctx)) == 3, "INVALID_ARGUMENT is permanent: one call, then an error; saw %d calls and error %v", len(chunkCalls(ctx))-2, err)
	ctx.GRPC.Fail("Embed", codes.Unavailable, "embedder down", 5, config.Embedder)
	_, err = chunkIndex()
	ctx.Assert(err != nil && len(chunkCalls(ctx)) == 6, "an embedder that stays UNAVAILABLE gets maxAttempts = 3 calls, then an error; saw %d calls and error %v", len(chunkCalls(ctx))-3, err)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <string>
#include <vector>

#include "digest.h"
#include "rag/embed.h"

namespace {

const std::string kDocKey = "rag:doc:t1:handbook:3";

// The stand-in embedder: one rag/embed.h vector per text.
class EmbedderPeer final : public rag::Embedder::Service {
 public:
  grpc::Status Embed(grpc::ServerContext*, const rag::EmbedRequest* req, rag::EmbedReply* reply) override {
    for (const auto& t : req->texts()) {
      auto* v = reply->add_vectors();
      for (double x : embed::vector(t)) v->add_values(x);
    }
    reply->set_model(embed::kModel);
    return grpc::Status::OK;
  }
};

std::string chunkText(size_t n) {
  std::string out;
  for (int i = 0; out.size() < n; i++) out += (i ? " word" : "word") + std::to_string(i);
  return out.substr(0, n);
}

std::string chunkWorld(harness::Ctx& ctx, size_t n) {
  static EmbedderPeer* peer = nullptr;
  delete peer;
  peer = new EmbedderPeer();
  ctx.GRPC.Server(config::kEmbedder)->RegisterService(peer);
  const std::string content = chunkText(n);
  ctx.Redis.Do("HSET", kDocKey, "sha256", "-", "job_id", "j1", "content_type", "text/plain", "content", content);
  return content;
}

bool chunkRaises() {
  try {
    index_document("t1", "handbook", 3);
  } catch (...) {
    return true;
  }
  return false;
}

struct Stored {
  std::string id;
  int start = 0;
  int end = 0;
  std::string text;
};

std::vector<Stored> chunkRows(harness::Ctx& ctx) {
  std::vector<Stored> out;
  for (const auto& id : ctx.Redis.SMembers("rag:chunks:t1")) {
    auto h = ctx.Redis.HGetAll("rag:chunk:" + id);
    out.push_back({id, std::stoi(h["start"]), std::stoi(h["end"]), h["text"]});
  }
  std::sort(out.begin(), out.end(), [](const Stored& a, const Stored& b) { return a.start < b.start; });
  return out;
}

}  // namespace

void CheckOverlap(harness::Ctx& ctx) {
  const std::string content = chunkWorld(ctx, 2000);
  const int n = index_document("t1", "handbook", 3);
  const auto rows = chunkRows(ctx);
  std::vector<std::vector<int>> spans;
  for (const auto& c : rows) spans.push_back({c.start, c.end});
  ctx.Equal(spans, std::vector<std::vector<int>>{{0, 800}, {700, 1500}, {1400, 2000}}, "a 2000-character document's chunks (800 characters, each starting 100 before the previous one ended)");
  for (const auto& c : rows) ctx.Assert(c.text == content.substr(c.start, c.end - c.start), "the chunk at %d must hold content[start:end]", c.start);
  ctx.Equal(n, 3, "index_document returns the number of chunks");
}

void CheckStableId(harness::Ctx& ctx) {
  chunkWorld(ctx, 2000);
  index_document("t1", "handbook", 3);
  const auto first = ctx.Redis.SMembers("rag:chunks:t1");
  index_document("t1", "handbook", 3);  // the event redelivered
  const auto again = ctx.Redis.SMembers("rag:chunks:t1");
  ctx.Assert(again.size() == first.size(), "a redelivered event changed the index: %d chunks before, %d after; a chunk's id must come from what it is, not from a random draw", first.size(), again.size());
  std::vector<std::string> expected;
  for (const auto& c : chunkRows(ctx)) expected.push_back(sha256_hex("t1:handbook:3:" + std::to_string(c.start)));
  std::sort(expected.begin(), expected.end());
  ctx.Equal(first, expected, "chunk ids must be sha256('{tenant}:{doc_id}:{version}:{start}')");
}

void CheckBatchSize(harness::Ctx& ctx) {
  chunkWorld(ctx, 700 * 39 + 800);
  const int n = index_document("t1", "handbook", 3);
  std::vector<int> sizes;
  int most = 0;
  for (const auto& c : ctx.GRPC.CallsTo("Embed")) {
    sizes.push_back(c.Request<rag::EmbedRequest>().texts_size());
    most = std::max(most, sizes.back());
  }
  ctx.Assert(most <= 32, "an Embed call carried %d texts; at most 32 per call", most);
  ctx.Assert(static_cast<int>(sizes.size()) == (n + 31) / 32, "%d chunks were embedded in %d calls of %v texts; batches of 32 need %d", n, sizes.size(), sizes, (n + 31) / 32);
  ctx.Equal(chunkRows(ctx).size(), n, "every chunk is written: index_document's count against the index");
}

void CheckCallDeadline(harness::Ctx& ctx) {
  chunkWorld(ctx, 2000);
  index_document("t1", "handbook", 3);
  const auto calls = ctx.GRPC.CallsTo("Embed");
  ctx.Assert(!calls.empty(), "no Embed call was made");
  for (const auto& c : calls) {
    ctx.Assert(c.HasDeadline(), "an Embed call carries no deadline: a hung embedder holds the worker, and the partition behind it, until it answers");
    ctx.Assert(1.5 <= c.TimeoutSeconds() && c.TimeoutSeconds() <= 2.5, "the deadline must be 2 s, got %vs", c.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Embed", 5.0, config::kEmbedder);
  const size_t before = calls.size();
  const int64_t started = ctx.Clock.Now();
  const bool raised = chunkRaises();
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  const size_t hung = ctx.GRPC.CallsTo("Embed").size() - before;
  ctx.Assert(raised, "an embedder that hangs 5 s on every call must end index_document with an error once the attempts are spent; it returned after %.1f s and %d calls", waited, hung);
  ctx.Equal(hung, 3, "a hung call is cut at the deadline and retried; calls");
  ctx.Assert(waited <= 8.0, "index_document waited %.1f s on a hung embedder: three 2-second deadlines and two backoffs fit in 8", waited);
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  chunkWorld(ctx, 500);
  ctx.GRPC.Fail("Embed", grpc::StatusCode::UNAVAILABLE, "embedder restarting", 1, config::kEmbedder);
  ctx.Equal(index_document("t1", "handbook", 3), 1, "chunks after one UNAVAILABLE");
  ctx.Assert(ctx.GRPC.CallsTo("Embed").size() == 2 && ctx.Clock.Sleeps() >= 1, "one UNAVAILABLE earns one retry after a backoff: saw %d calls and %d sleeps", ctx.GRPC.CallsTo("Embed").size(), ctx.Clock.Sleeps());
  ctx.GRPC.Fail("Embed", grpc::StatusCode::INVALID_ARGUMENT, "text rejected", 1, config::kEmbedder);
  bool raised = chunkRaises();
  ctx.Assert(raised && ctx.GRPC.CallsTo("Embed").size() == 3, "INVALID_ARGUMENT is permanent: one call, then an error; saw %d calls (raised: %t)", ctx.GRPC.CallsTo("Embed").size() - 2, raised);
  ctx.GRPC.Fail("Embed", grpc::StatusCode::UNAVAILABLE, "embedder down", 5, config::kEmbedder);
  raised = chunkRaises();
  ctx.Assert(raised && ctx.GRPC.CallsTo("Embed").size() == 6, "an embedder that stays UNAVAILABLE gets kMaxAttempts = 3 calls, then an error; saw %d calls (raised: %t)", ctx.GRPC.CallsTo("Embed").size() - 3, raised);
}
`,
  },
  hints: [
    'Symptom: an answer quotes half a sentence, a replayed ingest event doubles every chunk in the index, one slow embedder replica stalls ingestion for minutes, and a rejected text is retried ten times before the worker gives up.',
    'Mechanism: chunks start every 800 characters with no overlap, ids come from `uuid4()`, each chunk is its own `Embed` call without a `timeout`, and the retry loop treats every `RpcError` alike.',
    'Change: step by `CHUNK_SIZE - OVERLAP`; `sha256(f"{tenant}:{doc_id}:{version}:{start}")`; embed `chunks[i:i + BATCH]` with `timeout=DEADLINE_S`; retry only `UNAVAILABLE` or `DEADLINE_EXCEEDED` while `attempt < MAX_ATTEMPTS`, then raise.',
  ],
  debrief: `Overlap exists so a sentence that straddles a boundary is whole in at least one chunk; 100 characters is about a sentence, 800 a paragraph. The chunk id is a function of what the chunk is (tenant, document version, position), which lets an at-least-once consumer replay an event and land on the same keys. Batching cuts the round trips by up to thirty-two; the per-call deadline bounds what a hung replica costs; the retry set follows what a retry can change: a restarting server recovers, a rejected input does not. Production indexers also delete the chunks of a superseded version, store the embedding model beside each vector so a model change triggers a re-index, and cap batches in flight per tenant.`,
};
