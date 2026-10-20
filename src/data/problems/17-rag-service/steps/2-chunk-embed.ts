import type {Step} from '@/lib/types';

export const chunkEmbedStep: Step = {
  id: 'chunk-embed',
  title: 'Chunk and embed: stable ids, bounded retries',
  concept: 'grpc',
  file: 'chunk_embed',
  focus: ['kafka', 'worker', 'embed', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it compiles and passes the
happy path, so a quick demo makes it look done. Review it like the service owner. Find the subtle
flaw, fix it, and prove the fix with the checks below.

Consume \`doc.ingest\` events carrying \`{doc_id, version, content}\` and write searchable chunks.

- Split the text into chunks of about **800 characters** with **100 characters of overlap**, so a
  sentence crossing a boundary is still contiguous in one chunk. Skip chunks that are empty after
  trimming.
- Give every chunk a **stable id**: SHA-256 of \`doc_id:version:index:start\`. A redelivered event
  must produce exactly the same ids.
- Embed in batches of **32** texts through gRPC \`Embed(EmbedRequest{texts})\` with a **2-second
  deadline** per call.
- Retry only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`, with exponential backoff and jitter, at most
  **3 attempts**. Every other status is a permanent failure for that batch.
- Upsert by chunk id, so replaying an event overwrites the same rows instead of appending new ones.

**Failure mode the checks target.** Random chunk ids plus retry-everything looks harmless in the
demo: the first upload works. A redelivery then doubles the index, and a permanent \`INVALID_ARGUMENT\`
spins the consumer forever because the draft catches every exception.

:::widget deadline-retry {}

> A deadline bounds the worst case of one call; max attempts bounds the worst case of the batch. You
> need both, or a stalled embedding service turns into an unbounded consumer lag.`,
  sequence: {
    participants: ['doc.ingest', 'Chunk/embed worker', 'Embedding service', 'Redis index'],
    messages: [
      {from: 'doc.ingest', to: 'Chunk/embed worker', label: 'doc.ingest {doc_id, version, content}', kind: 'async'},
      {
        from: 'Chunk/embed worker',
        to: 'Chunk/embed worker',
        label: 'chunk 800 / overlap 100 · sha256 ids',
        kind: 'sync',
      },
      {from: 'Chunk/embed worker', to: 'Embedding service', label: 'Embed(batch of 32) · 2s deadline', kind: 'sync'},
      {from: 'Embedding service', to: 'Chunk/embed worker', label: 'vectors / UNAVAILABLE', kind: 'reply'},
      {from: 'Chunk/embed worker', to: 'Chunk/embed worker', label: 'retry ≤ 3 · backoff + jitter', kind: 'sync'},
      {from: 'Chunk/embed worker', to: 'Redis index', label: 'upsert by chunk_id', kind: 'sync'},
      {from: 'Chunk/embed worker', to: 'doc.ingest', label: 'commit offset', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'overlap',
      title: 'Chunks overlap by 100 characters',
      detail:
        'Chunk size is 800 and the next chunk starts 100 characters before the previous one ended. Non-overlapping chunks lose sentences that cross a boundary.',
      match: {
        python: {all: [/OVERLAP/, /CHUNK_SIZE/]},
        typescript: {all: [/\bOVERLAP\b/, /\bCHUNK_SIZE\b/]},
        go: {all: [/\boverlap\b/, /\bchunkSize\b/]},
        scala: {all: [/\bOverlap\b/, /\bChunkSize\b/]},
        cpp: {all: [/\bkOverlap\b/, /\bkChunkSize\b/]},
      },
    },
    {
      id: 'stable-id',
      title: 'Chunk ids are deterministic',
      detail:
        'The chunk id is SHA-256 of `doc_id:version:index:start`, not a UUID. A replay must address the same rows.',
      match: {
        python: {all: [/sha256/, /chunk_id/, /version/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /chunkId/, /version/]},
        go: {all: [/sha256/, /chunkID/, /version/]},
        scala: {all: [/(MessageDigest|SHA-256|sha256)/, /chunkId/, /version/]},
        cpp: {all: [/(SHA256|sha256)/, /chunkId/, /version/]},
      },
    },
    {
      id: 'batch-deadline',
      title: 'Embeds batches of 32 under a 2s deadline',
      detail:
        'Send at most 32 texts per `Embed` call and put a 2-second deadline on each call. One RPC per chunk with no deadline turns a slow embedder into an unbounded backlog.',
      match: {
        python: {all: [/BATCH_SIZE|\b32\b/, /EMBED_DEADLINE_S|timeout\s*=\s*2(?:\.0)?/]},
        typescript: {
          all: [
            /(BATCH_SIZE|\b32\b)/,
            /(EMBED_DEADLINE_S|deadline\s*:\s*Date\.now\(\)\s*\+)/,
            /EMBED_DEADLINE_S\s*=\s*2|2\s*\*\s*1000/,
          ],
        },
        go: {all: [/(batchSize|\b32\b)/, /(embedDeadline|WithTimeout)/, /2\s*\*\s*time\.Second/]},
        scala: {
          all: [/(BatchSize|\b32\b)/, /(EmbedDeadline|withDeadlineAfter)/, /Duration\.ofSeconds\(2\)|2\.seconds/],
        },
        cpp: {all: [/(kBatchSize|\b32\b)/, /(kEmbedDeadline|set_deadline)/, /seconds\(2\)/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries only retryable statuses, at most 3 attempts',
      detail:
        'Retry `UNAVAILABLE` and `DEADLINE_EXCEEDED` with exponential backoff and jitter, capped at 3 attempts. Retrying every error forever wedges the consumer on a permanent failure.',
      match: {
        python: {all: [/MAX_ATTEMPTS|\b3\b/, /grpc\.StatusCode\.UNAVAILABLE|UNAVAILABLE/, /DEADLINE_EXCEEDED/]},
        typescript: {
          all: [
            /(MAX_ATTEMPTS|\battempt\s*<=\s*3\b)/,
            /(status\.UNAVAILABLE|UNAVAILABLE)/,
            /(status\.DEADLINE_EXCEEDED|DEADLINE_EXCEEDED)/,
          ],
        },
        go: {
          all: [
            /(maxAttempts|\b3\b)/,
            /(codes\.Unavailable|Unavailable)/,
            /(codes\.DeadlineExceeded|DeadlineExceeded)/,
          ],
        },
        scala: {all: [/(MaxAttempts|\b3\b)/, /(UNAVAILABLE|Unavailable)/, /(DEADLINE_EXCEEDED|DeadlineExceeded)/]},
        cpp: {
          all: [
            /(kMaxAttempts|\b3\b)/,
            /(StatusCode::UNAVAILABLE|UNAVAILABLE)/,
            /(StatusCode::DEADLINE_EXCEEDED|DEADLINE_EXCEEDED)/,
          ],
        },
      },
    },
    {
      id: 'idempotent-upsert',
      title: 'Upserts by chunk id',
      detail:
        'Write with `HSET`/upsert keyed by the deterministic chunk id, so a redelivered event overwrites its rows rather than adding duplicates.',
      match: {
        python: {all: [/(hset|HSET|upsert|Upsert)/, /chunk_id|cid/]},
        typescript: {all: [/(hset|HSET|upsert|Upsert)/, /chunkId|chunk_id|\bcid\b/]},
        go: {all: [/(HSet|hset|Upsert)/, /chunkID|chunk_id/]},
        scala: {all: [/(hset|HSET|upsert|Upsert)/, /chunkId|chunk_id/]},
        cpp: {all: [/(hset|HSET|upsert|Upsert)/, /chunkId|chunk_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import uuid

import grpc
from confluent_kafka import Consumer
from redis import Redis

import embed_pb2
import embed_pb2_grpc

CHUNK_SIZE = 800
consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "chunk-embed"})
redis = Redis(host="redis", port=6379)
channel = grpc.insecure_channel("embed:50051")
stub = embed_pb2_grpc.EmbedderStub(channel)


def split(text: str):
    for i in range(0, len(text), CHUNK_SIZE):
        yield text[i : i + CHUNK_SIZE]


def embed_one(text: str):
    while True:
        try:
            return stub.Embed(embed_pb2.EmbedRequest(texts=[text])).vectors[0].values
        except Exception:
            continue


def handle(event: dict) -> None:
    for index, piece in enumerate(split(event["content"])):
        if not piece:
            continue
        chunk_id = str(uuid.uuid4())
        vector = embed_one(piece)
        # TODO: chunk ids are random, one RPC per chunk, and every error is retried forever.
        # A redelivered doc.ingest event duplicates the whole index.
        redis.set(f"chunk:{chunk_id}", json.dumps({"text": piece, "vector": list(vector), "index": index}))


def main() -> None:
    consumer.subscribe(["doc.ingest"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        handle(json.loads(msg.value()))
        consumer.commit(msg)


if __name__ == "__main__":
    main()
`,
      solution: `import hashlib
import json
import random
import time

import grpc
from confluent_kafka import Consumer
from redis import Redis

import embed_pb2
import embed_pb2_grpc

CHUNK_SIZE = 800
OVERLAP = 100
BATCH_SIZE = 32
MAX_ATTEMPTS = 3
EMBED_DEADLINE_S = 2.0
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "chunk-embed"})
redis = Redis(host="redis", port=6379)
channel = grpc.insecure_channel("embed:50051")
stub = embed_pb2_grpc.EmbedderStub(channel)


def split(text: str):
    start = 0
    index = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        piece = text[start:end].strip()
        if piece:
            yield index, start, end, piece
            index += 1
        if end == len(text):
            break
        start = end - OVERLAP


def chunk_id(doc_id: str, version: int, index: int, start: int) -> str:
    key = f"{doc_id}:{version}:{index}:{start}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def embed(texts: list[str]) -> list[list[float]]:
    delay = 0.05
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Embed(embed_pb2.EmbedRequest(texts=texts), timeout=EMBED_DEADLINE_S)
            return [list(vector.values) for vector in reply.vectors]
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE or attempt == MAX_ATTEMPTS:
                raise
            time.sleep(delay + random.uniform(0, delay))
            delay *= 2
    raise RuntimeError("embed: retries exhausted")


def handle(event: dict) -> None:
    doc_id = event["doc_id"]
    version = event["version"]
    pieces = list(split(event["content"]))
    for batch_start in range(0, len(pieces), BATCH_SIZE):
        batch = pieces[batch_start : batch_start + BATCH_SIZE]
        vectors = embed([piece for _, _, _, piece in batch])
        for (index, start, end, piece), vector in zip(batch, vectors):
            cid = chunk_id(doc_id, version, index, start)
            redis.hset(
                f"rag:chunk:{cid}",
                mapping={
                    "doc_id": doc_id,
                    "version": str(version),
                    "index": str(index),
                    "start": str(start),
                    "end": str(end),
                    "text": piece,
                    "vector": json.dumps(vector),
                },
            )


def main() -> None:
    consumer.subscribe(["doc.ingest"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        handle(json.loads(msg.value()))
        consumer.commit(msg)


if __name__ == "__main__":
    main()
`,
    },
    typescript: {
      starter: `/** doc.ingest consumer: a model-generated draft that indexes one chunk at a time. */
import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Kafka} from 'kafkajs';
import Redis from 'ioredis';

const CHUNK_SIZE = 800;

const kafka = new Kafka({clientId: 'chunk-embed', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'chunk-embed'});
const redis = new Redis({host: 'redis', port: 6379});

interface EmbedRequest {
  texts: string[];
}
interface EmbedReply {
  vectors: {values: number[]}[];
}
interface Embedder {
  Embed(request: EmbedRequest, options: {deadline: number}): Promise<EmbedReply>;
}

const {embed: embedService} = grpc.loadPackageDefinition(protoLoader.loadSync('embed.proto')) as unknown as {
  embed: {Embedder: new (target: string, credentials: grpc.ChannelCredentials) => Embedder};
};
const stub = new embedService.Embedder('embed:50051', grpc.credentials.createInsecure());

interface IngestEvent {
  doc_id: string;
  version: number;
  content: string;
}

function split(text: string): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) pieces.push(text.slice(i, i + CHUNK_SIZE));
  return pieces;
}

async function embedOne(text: string): Promise<number[]> {
  while (true) {
    try {
      const reply = await stub.Embed({texts: [text]}, {deadline: Date.now() + 5000});
      return reply.vectors[0].values;
    } catch {
      continue;
    }
  }
}

async function handle(event: IngestEvent): Promise<void> {
  let index = 0;
  for (const piece of split(event.content)) {
    if (piece === '') continue;
    // TODO: chunk ids are random, one RPC per chunk, and every error is retried forever.
    // A redelivered doc.ingest event duplicates the whole index.
    const chunkId = randomUUID();
    const vector = await embedOne(piece);
    await redis.set(\`chunk:\${chunkId}\`, JSON.stringify({text: piece, vector, index}));
    index += 1;
  }
}

async function main(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'doc.ingest'});
  await consumer.run({
    eachMessage: async ({message}) => {
      await handle(JSON.parse(message.value!.toString()) as IngestEvent);
    },
  });
}

void main();
`,
      solution: `/** doc.ingest consumer: deterministic chunk ids, batched embeddings, bounded retries, upserts. */
import {createHash} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Kafka} from 'kafkajs';
import Redis from 'ioredis';

const CHUNK_SIZE = 800;
const OVERLAP = 100;
const BATCH_SIZE = 32;
const MAX_ATTEMPTS = 3;
const EMBED_DEADLINE_S = 2;
const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

const kafka = new Kafka({clientId: 'chunk-embed', brokers: ['kafka:9092']});
const consumer = kafka.consumer({groupId: 'chunk-embed'});
const redis = new Redis({host: 'redis', port: 6379});

interface EmbedRequest {
  texts: string[];
}
interface EmbedReply {
  vectors: {values: number[]}[];
}
interface Embedder {
  Embed(request: EmbedRequest, options: {deadline: number}): Promise<EmbedReply>;
}

const {embed: embedService} = grpc.loadPackageDefinition(protoLoader.loadSync('embed.proto')) as unknown as {
  embed: {Embedder: new (target: string, credentials: grpc.ChannelCredentials) => Embedder};
};
const stub = new embedService.Embedder('embed:50051', grpc.credentials.createInsecure());

interface IngestEvent {
  doc_id: string;
  version: number;
  content: string;
}

interface Piece {
  index: number;
  start: number;
  end: number;
  text: string;
}

function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Start the next chunk OVERLAP characters before the previous one ended. */
function split(text: string): Piece[] {
  const pieces: Piece[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    const piece = text.slice(start, end).trim();
    if (piece !== '') {
      pieces.push({index, start, end, text: piece});
      index += 1;
    }
    if (end === text.length) break;
    start = end - OVERLAP;
  }
  return pieces;
}

/** SHA-256 of (doc_id, version, index, start): a replay addresses the same rows. */
const chunkId = (doc_id: string, version: number, index: number, start: number): string =>
  createHash('sha256').update(\`\${doc_id}:\${version}:\${index}:\${start}\`).digest('hex');

async function embed(texts: string[]): Promise<number[][]> {
  let delay = 50;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await stub.Embed({texts}, {deadline: Date.now() + EMBED_DEADLINE_S * 1000});
      return reply.vectors.map(vector => vector.values);
    } catch (error) {
      const code = (error as grpc.ServiceError).code;
      if (!RETRYABLE.has(code) || attempt === MAX_ATTEMPTS) throw error;
      await sleep(delay + Math.random() * delay);
      delay *= 2;
    }
  }
  throw new Error('embed: retries exhausted');
}

async function handle(event: IngestEvent): Promise<void> {
  const pieces = split(event.content);
  for (let offset = 0; offset < pieces.length; offset += BATCH_SIZE) {
    const batch = pieces.slice(offset, offset + BATCH_SIZE);
    const vectors = await embed(batch.map(piece => piece.text));
    for (const [i, piece] of batch.entries()) {
      const cid = chunkId(event.doc_id, event.version, piece.index, piece.start);
      await redis.hset(\`rag:chunk:\${cid}\`, {
        doc_id: event.doc_id,
        version: String(event.version),
        index: String(piece.index),
        start: String(piece.start),
        end: String(piece.end),
        text: piece.text,
        vector: JSON.stringify(vectors[i]),
      });
    }
  }
}

async function main(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'doc.ingest'});
  await consumer.run({
    eachMessage: async ({message}) => {
      await handle(JSON.parse(message.value!.toString()) as IngestEvent);
    },
  });
}

void main();
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "rag/embedpb"
)

const chunkSize = 800

var redisClient = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var consumer = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "chunk-embed",
	Topic:   "doc.ingest",
})

type Event struct {
	DocID   string \`json:"doc_id"\`
	Version int    \`json:"version"\`
	Content string \`json:"content"\`
}

func split(text string) []string {
	var out []string
	for i := 0; i < len(text); i += chunkSize {
		end := i + chunkSize
		if end > len(text) {
			end = len(text)
		}
		out = append(out, text[i:end])
	}
	return out
}

func embedOne(client pb.EmbedderClient, text string) []float32 {
	for {
		reply, err := client.Embed(context.Background(), &pb.EmbedRequest{Texts: []string{text}})
		if err == nil {
			return reply.Vectors[0].Values
		}
		// TODO: retries every error forever, with no deadline, no batching and random ids.
	}
}

func main() {
	conn, _ := grpc.NewClient("embed:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	client := pb.NewEmbedderClient(conn)
	ctx := context.Background()
	for {
		msg, err := consumer.FetchMessage(ctx)
		if err != nil {
			log.Fatal(err)
		}
		var event Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		for _, piece := range split(event.Content) {
			if piece == "" {
				continue
			}
			vector := embedOne(client, piece)
			payload, _ := json.Marshal(map[string]any{"text": piece, "vector": vector})
			redisClient.Set(ctx, "chunk:"+uuid.NewString(), payload, 0)
		}
		consumer.CommitMessages(ctx, msg)
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "rag/embedpb"
)

const (
	chunkSize     = 800
	overlap       = 100
	batchSize     = 32
	maxAttempts   = 3
	embedDeadline = 2 * time.Second
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var redisClient = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var consumer = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "chunk-embed",
	Topic:   "doc.ingest",
})

type Event struct {
	DocID   string \`json:"doc_id"\`
	Version int    \`json:"version"\`
	Content string \`json:"content"\`
}

type Chunk struct {
	Index int
	Start int
	End   int
	Text  string
}

func split(text string) []Chunk {
	var out []Chunk
	start := 0
	index := 0
	for start < len(text) {
		end := start + chunkSize
		if end > len(text) {
			end = len(text)
		}
		piece := text[start:end]
		if piece != "" {
			out = append(out, Chunk{Index: index, Start: start, End: end, Text: piece})
			index++
		}
		if end == len(text) {
			break
		}
		start = end - overlap
	}
	return out
}

func chunkID(docID string, version, index, start int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d:%d", docID, version, index, start)))
	return hex.EncodeToString(sum[:])
}

func embed(client pb.EmbedderClient, texts []string) ([][]float32, error) {
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), embedDeadline)
		reply, err := client.Embed(ctx, &pb.EmbedRequest{Texts: texts})
		cancel()
		if err == nil {
			vectors := make([][]float32, len(reply.Vectors))
			for i, vector := range reply.Vectors {
				vectors[i] = vector.Values
			}
			return vectors, nil
		}
		if !retryable[status.Code(err)] || attempt == maxAttempts {
			return nil, err
		}
		backoff := time.Duration(50*(1<<uint(attempt-1))) * time.Millisecond
		time.Sleep(backoff + time.Duration(rand.Int63n(int64(backoff))))
	}
	return nil, fmt.Errorf("embed: retries exhausted")
}

func handle(ctx context.Context, client pb.EmbedderClient, event Event) error {
	chunks := split(event.Content)
	for start := 0; start < len(chunks); start += batchSize {
		end := start + batchSize
		if end > len(chunks) {
			end = len(chunks)
		}
		batch := chunks[start:end]
		texts := make([]string, len(batch))
		for i, chunk := range batch {
			texts[i] = chunk.Text
		}
		vectors, err := embed(client, texts)
		if err != nil {
			return err
		}
		for i, chunk := range batch {
			id := chunkID(event.DocID, event.Version, chunk.Index, chunk.Start)
			vector, _ := json.Marshal(vectors[i])
			fields := map[string]any{
				"doc_id":  event.DocID,
				"version": event.Version,
				"start":   chunk.Start,
				"end":     chunk.End,
				"text":    chunk.Text,
				"vector":  vector,
			}
			if err := redisClient.HSet(ctx, "rag:chunk:"+id, fields).Err(); err != nil {
				return err
			}
		}
	}
	return nil
}

func main() {
	conn, _ := grpc.NewClient("embed:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	client := pb.NewEmbedderClient(conn)
	ctx := context.Background()
	for {
		msg, err := consumer.FetchMessage(ctx)
		if err != nil {
			log.Fatal(err)
		}
		var event Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			continue
		}
		if err := handle(ctx, client, event); err != nil {
			log.Printf("chunk-embed: batch failed: %v", err)
			continue
		}
		consumer.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.{Collections, Properties, UUID}
import java.util.concurrent.ThreadLocalRandom

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

import embed.EmbedServiceGrpc
import embed.EmbedRequest

object ChunkEmbed {
  val ChunkSize = 800
  val consumer = new KafkaConsumer[String, String](KafkaConfig.consumer("chunk-embed"))
  val jedis = new Jedis("redis", 6379)
  val channel = ManagedChannelBuilder.forAddress("embed", 50051).usePlaintext().build()
  val stub = EmbedServiceGrpc.blockingStub(channel)

  def split(text: String): Seq[String] = text.grouped(ChunkSize).toSeq

  def embedOne(text: String): Seq[Float] = {
    while (true) {
      try {
        return stub.embed(EmbedRequest(texts = Seq(text))).vectors.head.values
      } catch {
        case _: Throwable => ()
      }
    }
    Seq.empty
  }

  def handle(event: DocEvent): Unit = {
    split(event.content).zipWithIndex.foreach { case (piece, index) =>
      if (piece.nonEmpty) {
        val chunkId = UUID.randomUUID().toString
        val vector = embedOne(piece)
        // TODO: random chunk id, one RPC per chunk, every error retried forever.
        jedis.set("chunk:" + chunkId, s"""{"text":"$piece","index":$index}""")
      }
    }
  }

  def main(args: Array[String]): Unit = {
    consumer.subscribe(Collections.singletonList("doc.ingest"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofSeconds(1))
      records.forEach { record =>
        handle(parse(record.value()))
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Duration
import java.util.Collections
import java.util.concurrent.{ThreadLocalRandom, TimeUnit}

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.kafka.clients.consumer.KafkaConsumer
import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

import embed.EmbedServiceGrpc
import embed.EmbedRequest

object ChunkEmbed {
  val ChunkSize = 800
  val Overlap = 100
  val BatchSize = 32
  val MaxAttempts = 3
  val EmbedDeadline = Duration.ofSeconds(2)
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val consumer = new KafkaConsumer[String, String](KafkaConfig.consumer("chunk-embed"))
  val jedis = new Jedis("redis", 6379)
  val channel = ManagedChannelBuilder.forAddress("embed", 50051).usePlaintext().build()
  val stub = EmbedServiceGrpc.blockingStub(channel)

  case class Chunk(index: Int, start: Int, end: Int, text: String)

  def split(text: String): Seq[Chunk] = {
    val out = scala.collection.mutable.ArrayBuffer.empty[Chunk]
    var start = 0
    var index = 0
    while (start < text.length) {
      val end = math.min(start + ChunkSize, text.length)
      val piece = text.substring(start, end).trim
      if (piece.nonEmpty) {
        out += Chunk(index, start, end, piece)
        index += 1
      }
      if (end == text.length) start = text.length else start = end - Overlap
    }
    out.toSeq
  }

  def chunkId(docId: String, version: Int, index: Int, start: Int): String = {
    val key = s"$docId:$version:$index:$start"
    val digest = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8))
    digest.map("%02x".format(_)).mkString
  }

  def embed(texts: Seq[String]): Seq[Seq[Float]] = {
    var attempt = 1
    var backoff = 50L
    while (attempt <= MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(EmbedDeadline.toMillis, TimeUnit.MILLISECONDS).embed(EmbedRequest(texts = texts))
        return reply.vectors.map(_.values)
      } catch {
        case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) && attempt < MaxAttempts =>
          Thread.sleep(backoff + ThreadLocalRandom.current().nextLong(backoff))
          backoff *= 2
          attempt += 1
        case e: StatusRuntimeException => throw e
      }
    }
    Seq.empty
  }

  def handle(event: DocEvent): Unit = {
    split(event.content).grouped(BatchSize).foreach { batch =>
      val vectors = embed(batch.map(_.text))
      batch.zip(vectors).foreach { case (chunk, vector) =>
        val id = chunkId(event.docId, event.version, chunk.index, chunk.start)
        val fields = Map(
          "doc_id" -> event.docId,
          "version" -> event.version.toString,
          "start" -> chunk.start.toString,
          "end" -> chunk.end.toString,
          "text" -> chunk.text,
          "vector" -> vector.mkString(","),
        )
        jedis.hset("rag:chunk:" + id, fields.asJava)
      }
    }
  }

  def main(args: Array[String]): Unit = {
    consumer.subscribe(Collections.singletonList("doc.ingest"))
    while (true) {
      val records = consumer.poll(Duration.ofSeconds(1))
      records.forEach { record =>
        handle(parse(record.value()))
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <redis++/redis++.h>

#include <string>
#include <vector>

#include "embed.grpc.pb.h"

using json = nlohmann::json;

constexpr std::size_t kChunkSize = 800;

std::vector<std::string> split(const std::string& text) {
  std::vector<std::string> out;
  for (std::size_t i = 0; i < text.size(); i += kChunkSize) {
    out.push_back(text.substr(i, kChunkSize));
  }
  return out;
}

std::vector<float> embedOne(const std::shared_ptr<Embedder::Stub>& stub, const std::string& text) {
  while (true) {
    grpc::ClientContext ctx;
    EmbedRequest request;
    EmbedReply reply;
    request.add_texts(text);
    const auto status = stub->Embed(&ctx, request, &reply);
    if (status.ok()) {
      return std::vector<float>(reply.vectors(0).values().begin(), reply.vectors(0).values().end());
    }
    // TODO: retries every status forever, with no deadline, no batching and random ids.
  }
}

int main() {
  auto redis = sw::redis::Redis("tcp://redis:6379");
  auto stub = Embedder::NewStub(grpc::CreateChannel("embed:50051", grpc::InsecureChannelCredentials()));
  auto consumer = KafkaConsumer::create("doc.ingest", "chunk-embed");
  const auto event = json::parse(consumer->poll());
  for (const auto& piece : split(event.value("content", std::string()))) {
    if (piece.empty()) continue;
    const auto id = uuidString();
    const auto vector = embedOne(stub, piece);
    redis.set("chunk:" + id, json{{"text", piece}, {"vector", vector}}.dump());
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "embed.grpc.pb.h"

using json = nlohmann::json;

constexpr std::size_t kChunkSize = 800;
constexpr std::size_t kOverlap = 100;
constexpr std::size_t kBatchSize = 32;
constexpr int kMaxAttempts = 3;
constexpr auto kEmbedDeadline = std::chrono::seconds(2);

struct Chunk {
  int index;
  std::size_t start;
  std::size_t end;
  std::string text;
};

std::vector<Chunk> split(const std::string& text) {
  std::vector<Chunk> out;
  std::size_t start = 0;
  int index = 0;
  while (start < text.size()) {
    const auto end = std::min(start + kChunkSize, text.size());
    const auto piece = text.substr(start, end - start);
    if (!piece.empty()) {
      out.push_back({index, start, end, piece});
      ++index;
    }
    if (end == text.size()) break;
    start = end - kOverlap;
  }
  return out;
}

std::string chunkId(const std::string& docId, int version, int index, std::size_t start) {
  const auto key = docId + ":" + std::to_string(version) + ":" + std::to_string(index) + ":" + std::to_string(start);
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(key.data()), key.size(), digest);
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(SHA256_DIGEST_LENGTH * 2);
  for (unsigned char byte : digest) {
    out.push_back(hex[byte >> 4]);
    out.push_back(hex[byte & 0x0f]);
  }
  return out;
}

std::vector<std::vector<float>> embed(const std::shared_ptr<Embedder::Stub>& stub, const std::vector<std::string>& texts) {
  std::mt19937 rng(std::random_device{}());
  long backoff = 50;
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kEmbedDeadline);
    EmbedRequest request;
    for (const auto& text : texts) request.add_texts(text);
    EmbedReply reply;
    const auto status = stub->Embed(&ctx, request, &reply);
    if (status.ok()) {
      std::vector<std::vector<float>> vectors;
      for (const auto& vector : reply.vectors()) {
        vectors.emplace_back(vector.values().begin(), vector.values().end());
      }
      return vectors;
    }
    const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE ||
                           status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    if (!retryable || attempt == kMaxAttempts) throw std::runtime_error(status.error_message());
    std::uniform_int_distribution<long> jitter(0, backoff);
    std::this_thread::sleep_for(std::chrono::milliseconds(backoff + jitter(rng)));
    backoff *= 2;
  }
  throw std::runtime_error("embed: retries exhausted");
}

int main() {
  auto redis = sw::redis::Redis("tcp://redis:6379");
  auto stub = Embedder::NewStub(grpc::CreateChannel("embed:50051", grpc::InsecureChannelCredentials()));
  auto consumer = KafkaConsumer::create("doc.ingest", "chunk-embed");
  while (true) {
    const auto event = json::parse(consumer->poll());
    const auto chunks = split(event.value("content", std::string()));
    for (std::size_t start = 0; start < chunks.size(); start += kBatchSize) {
      const auto end = std::min(start + kBatchSize, chunks.size());
      std::vector<std::string> texts;
      for (auto i = start; i < end; ++i) texts.push_back(chunks[i].text);
      const auto vectors = embed(stub, texts);
      for (auto i = start; i < end; ++i) {
        const auto& chunk = chunks[i];
        const auto id = chunkId(event["doc_id"], event["version"], chunk.index, chunk.start);
        redis.hset("rag:chunk:" + id,
                   {{"doc_id", event["doc_id"].get<std::string>()},
                    {"version", std::to_string(event["version"].get<int>())},
                    {"start", std::to_string(chunk.start)},
                    {"end", std::to_string(chunk.end)},
                    {"text", chunk.text},
                    {"vector", json(vectors[i - start]).dump()}});
      }
    }
    consumer->commit();
  }
}
`,
    },
  },
  hints: [
    'Chunk with `start` and `end` cursors, not `text.grouped(n)`: overlap means the next start is `end - 100`, not `end`. Stop when a chunk reaches the end of the document.',
    'Build the id from the document identity and the chunk geometry. The embedding is derived data; the id must be derivable from the event alone, so a replay recomputes the same key.',
    'Retry inside one batch call. Check `status.code()` / `e.code()` before sleeping; `INVALID_ARGUMENT` and `PERMISSION_DENIED` will never heal, so fail the batch immediately.',
  ],
  debrief: `The interviewer is looking for review instincts around derived data. The draft has three independent production bugs that the first upload hides: non-overlapping chunks quietly cut sentences in half, one RPC per chunk with no deadline lets a slow embedder stall the consumer, and catch-all retries turn a permanent error into poison-message thrash. The stable id is the design signal: it makes the pipeline idempotent without a dedupe table, because replaying an event addresses the same Redis hashes. Batch size and deadline are one decision — 32 texts is a latency/size trade-off, and 2 seconds bounds the tail; max attempts and jitter bound the batch. Real pipelines add a dead-letter topic for permanent failures, metrics on retry rate, and a content hash in the id when the same document id can be re-ingested with different bytes.`,
};
