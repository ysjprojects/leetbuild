import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'upload.completed after the commit, keyed by upload id',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'store', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter is \`complete_upload(upload_id)\`, called once the status read shows
nothing to resume: it refuses an upload with parts missing (\`UploadIncomplete\`), produces
\`upload.completed\` \`{type, upload_id, tenant, total_bytes, part_count, content_type}\` to
\`upload.event\`, writes \`store.insert_outbox\` when \`produce\` raises, then commits the object with
\`ObjectStore.CommitObject\` (the registered parts' numbers and checksums) and calls
\`store.mark_complete\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** The media pipeline fetches an object that is not committed yet,
or never will be; the record lands on any partition, so a later event of the same upload can
overtake it; a broker that refuses the record loses the event, because \`produce\` raises only for
local errors; a retry after a lost acknowledgement writes the event twice.

- Key every record by the **upload id**.
- **Commit first**: \`CommitObject\` and \`store.mark_complete\`, then produce. A failed commit raises
  and produces nothing.
- Wait for the delivery report, at most \`ACK_TIMEOUT_S\` (2 s); on a failure or no report, call
  \`store.insert_outbox(topic, key, payload)\` and return \`False\`.
- The producer is idempotent with \`acks=all\` (Go uses confluent-kafka-go here: kafka-go has no
  idempotent producer).`,
  sequence: {
    participants: ['uploadd', 'Object store', 'upload.event', 'Outbox'],
    messages: [
      {from: 'uploadd', to: 'Object store', label: 'CommitObject(upload_id, parts) · 30 s', kind: 'sync'},
      {from: 'Object store', to: 'uploadd', label: 'CommitReply{object_key}', kind: 'reply'},
      {from: 'uploadd', to: 'uploadd', label: 'mark_complete(upload_id)', kind: 'sync'},
      {
        from: 'uploadd',
        to: 'upload.event',
        label: 'upload.completed · key = upload_id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'upload.event', to: 'uploadd', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'uploadd', to: 'Outbox', label: 'refused or no report → insert_outbox → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'upload-key',
      title: 'Keys upload.completed by the upload id',
      detail:
        "Every record on `upload.event` carries the upload id as its key, so one upload's events share a partition and stay in order; the starter produces without a key.",
      match: {
        python: {all: [/producer\.produce\([^\n]*key\s*=\s*upload_id/, /upload\.event/]},
        typescript: {all: [/key:\s*uploadId\b/, /upload\.event/]},
        go: {all: [/Key:\s*\[\]byte\(uploadID\)/, /upload\.event/]},
        scala: {all: [/new ProducerRecord\[String, String\]\(\s*Topic\s*,\s*uploadId\s*,/, /upload\.event/]},
        cpp: {all: [/upload_id\.c_str\(\),\s*upload_id\.(size|length)\(\)/, /upload\.event/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Commits the object before producing the event',
      detail:
        '`CommitObject` and `mark_complete` run before the produce, and a failed commit produces nothing; the starter produces first, so a consumer can fetch an object that does not exist.',
      match: {
        python: {order: [/\.CommitObject\(/, /store\.mark_complete\(/, /producer\.produce\(/]},
        typescript: {order: [/\.CommitObject\(/, /markComplete\(/, /producer\.send\(/]},
        go: {order: [/\.CommitObject\(/, /store\.MarkComplete\(/, /producer\.Produce\(/]},
        scala: {order: [/\.commitObject\(/, /Store\.markComplete\(/, /producer\.send\(/]},
        cpp: {order: [/->CommitObject\(/, /store::markComplete\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes the outbox row from the delivery report',
      detail:
        'The delivery report decides (`on_delivery` and `flush`, an awaited `send`, the delivery channel, `send(...).get`, `dr_cb`): a refused or unacknowledged record leaves an outbox row and the call returns false. The starter catches only the exception `produce` raises for local errors.',
      match: {
        python: {
          all: [/on_delivery\s*=|callback\s*=/, /store\.insert_outbox\(/, /producer\.flush\(/],
          none: [/except\s+(confluent_kafka\.)?KafkaException/],
        },
        typescript: {all: [/await producer\.send\(/, /insertOutbox\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /TopicPartition\.Error/, /time\.After\(|Flush\(/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/store::insertOutbox\(/, /dr_cb/, /->flush\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Idempotent producer with acks=all',
      detail:
        'A record whose acknowledgement was lost is retried and lands once, and a leader failover keeps it: `enable.idempotence` with `acks=all` (kafkajs `idempotent: true` with `acks: -1`). The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc
from confluent_kafka import KafkaException, Producer

import resumable_upload_pb2 as pb
import resumable_upload_pb2_grpc
from uploads import manifest, store  # manifest.read_parts, store.get_upload, mark_complete, insert_outbox

TOPIC = "upload.event"
COMMIT_DEADLINE_S = 30

objects = resumable_upload_pb2_grpc.ObjectStoreStub(grpc.insecure_channel("objects:9000"))
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


class UploadIncomplete(Exception):
    """A part is still missing: the upload cannot be committed."""


def complete_upload(upload_id: str) -> bool:
    """Commit the upload's object and announce it; True once the broker acknowledged upload.completed."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    upload = store.get_upload(upload_id)
    if upload is None:
        raise KeyError(f"no upload {upload_id}")
    parts = manifest.read_parts(upload_id)
    if len(parts) != upload["part_count"]:
        raise UploadIncomplete(f"{len(parts)} of {upload['part_count']} parts registered")
    payload = {
        "type": "upload.completed",
        "upload_id": upload_id,
        "tenant": upload["tenant"],
        "total_bytes": upload["total_bytes"],
        "part_count": upload["part_count"],
        "content_type": upload["content_type"],
    }
    try:
        producer.produce(TOPIC, value=json.dumps(payload))
        producer.poll(0)
    except KafkaException:
        store.insert_outbox(TOPIC, upload_id, payload)
        return False
    refs = [pb.PartRef(part_number=p["part_number"], checksum=p["checksum"]) for p in parts]
    objects.CommitObject(pb.CommitRequest(upload_id=upload_id, parts=refs), timeout=COMMIT_DEADLINE_S)
    store.mark_complete(upload_id)
    return True
`,
      solution: `import json

import grpc
from confluent_kafka import Producer

import resumable_upload_pb2 as pb
import resumable_upload_pb2_grpc
from uploads import manifest, store  # manifest.read_parts, store.get_upload, mark_complete, insert_outbox

TOPIC = "upload.event"
COMMIT_DEADLINE_S = 30
ACK_TIMEOUT_S = 2

objects = resumable_upload_pb2_grpc.ObjectStoreStub(grpc.insecure_channel("objects:9000"))
producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a record retried after a lost acknowledgement lands once
})


class UploadIncomplete(Exception):
    """A part is still missing: the upload cannot be committed."""


def complete_upload(upload_id: str) -> bool:
    """Commit the upload's object and announce it; True once the broker acknowledged upload.completed."""
    upload = store.get_upload(upload_id)
    if upload is None:
        raise KeyError(f"no upload {upload_id}")
    parts = manifest.read_parts(upload_id)
    if len(parts) != upload["part_count"]:
        raise UploadIncomplete(f"{len(parts)} of {upload['part_count']} parts registered")
    refs = [pb.PartRef(part_number=p["part_number"], checksum=p["checksum"]) for p in parts]
    # The object first: an event may lag the commit, it may not precede it. A failed commit raises here.
    objects.CommitObject(pb.CommitRequest(upload_id=upload_id, parts=refs), timeout=COMMIT_DEADLINE_S)
    store.mark_complete(upload_id)
    payload = {
        "type": "upload.completed",
        "upload_id": upload_id,
        "tenant": upload["tenant"],
        "total_bytes": upload["total_bytes"],
        "part_count": upload["part_count"],
        "content_type": upload["content_type"],
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=upload_id, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the pipeline hears late, not never.
        store.insert_outbox(TOPIC, upload_id, payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Kafka} from 'kafkajs';

import {readParts} from 'uploads/manifest';
import {getUpload, insertOutbox, markComplete} from 'uploads/store';

export const TOPIC = 'upload.event';
export const COMMIT_DEADLINE_MS = 30_000;

interface CommitRequest {
  upload_id: string;
  parts: {part_number: number; checksum: string}[];
}

interface CommitReply {
  object_key: string;
  size: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('resumable_upload.proto')) as unknown as {
  uploadd: {ObjectStore: grpc.ServiceClientConstructor};
};
const objects = new pkg.uploadd.ObjectStore('objects:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CommitObject(request: CommitRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<CommitReply>;
};

const kafka = new Kafka({clientId: 'uploadd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** A part is still missing: the upload cannot be committed. */
export class UploadIncomplete extends Error {}

/** Commit the upload's object and announce it; true once the broker acknowledged upload.completed. */
export async function completeUpload(uploadId: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const upload = await getUpload(uploadId);
  if (upload === null) throw new Error(\`no upload \${uploadId}\`);
  const parts = await readParts(uploadId);
  if (parts.length !== upload.part_count) throw new UploadIncomplete(\`\${parts.length} of \${upload.part_count} parts registered\`);
  const payload = {
    type: 'upload.completed',
    upload_id: uploadId,
    tenant: upload.tenant,
    total_bytes: upload.total_bytes,
    part_count: upload.part_count,
    content_type: upload.content_type,
  };
  try {
    void producer.send({topic: TOPIC, messages: [{value: JSON.stringify(payload)}], acks: 1});
  } catch {
    await insertOutbox(TOPIC, uploadId, payload);
    return false;
  }
  const refs = parts.map(p => ({part_number: p.part_number, checksum: p.checksum}));
  await objects.CommitObject({upload_id: uploadId, parts: refs}, new grpc.Metadata(), {deadline: Date.now() + COMMIT_DEADLINE_MS});
  await markComplete(uploadId);
  return true;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Kafka} from 'kafkajs';

import {readParts} from 'uploads/manifest';
import {getUpload, insertOutbox, markComplete} from 'uploads/store';

export const TOPIC = 'upload.event';
export const COMMIT_DEADLINE_MS = 30_000;
export const ACK_TIMEOUT_MS = 2000;

interface CommitRequest {
  upload_id: string;
  parts: {part_number: number; checksum: string}[];
}

interface CommitReply {
  object_key: string;
  size: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('resumable_upload.proto')) as unknown as {
  uploadd: {ObjectStore: grpc.ServiceClientConstructor};
};
const objects = new pkg.uploadd.ObjectStore('objects:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CommitObject(request: CommitRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<CommitReply>;
};

const kafka = new Kafka({clientId: 'uploadd', brokers: ['kafka:9092']});
// Idempotent: a record retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** A part is still missing: the upload cannot be committed. */
export class UploadIncomplete extends Error {}

/** Commit the upload's object and announce it; true once the broker acknowledged upload.completed. */
export async function completeUpload(uploadId: string): Promise<boolean> {
  const upload = await getUpload(uploadId);
  if (upload === null) throw new Error(\`no upload \${uploadId}\`);
  const parts = await readParts(uploadId);
  if (parts.length !== upload.part_count) throw new UploadIncomplete(\`\${parts.length} of \${upload.part_count} parts registered\`);
  const refs = parts.map(p => ({part_number: p.part_number, checksum: p.checksum}));
  // The object first: an event may lag the commit, it may not precede it. A failed commit throws here.
  await objects.CommitObject({upload_id: uploadId, parts: refs}, new grpc.Metadata(), {deadline: Date.now() + COMMIT_DEADLINE_MS});
  await markComplete(uploadId);
  const payload = {
    type: 'upload.completed',
    upload_id: uploadId,
    tenant: upload.tenant,
    total_bytes: upload.total_bytes,
    part_count: upload.part_count,
    content_type: upload.content_type,
  };
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: uploadId, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the pipeline hears late, not never.
    await insertOutbox(TOPIC, uploadId, payload);
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "uploads/gen/resumable_upload"
	"uploads/manifest" // manifest.ReadParts
	"uploads/store"    // store.GetUpload, MarkComplete, InsertOutbox
)

const (
	topic          = "upload.event"
	commitDeadline = 30 * time.Second
)

// ErrUploadIncomplete: a part is still missing, the upload cannot be committed.
var ErrUploadIncomplete = errors.New("upload incomplete")

var (
	objectsConn, _ = grpc.NewClient("objects:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	objects        = pb.NewObjectStoreClient(objectsConn)
	producer       = newProducer()
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// completeUpload commits the upload's object and announces it; true once the broker acknowledged upload.completed.
func completeUpload(ctx context.Context, uploadID string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil {
		return false, fmt.Errorf("no upload %s", uploadID)
	}
	parts, err := manifest.ReadParts(ctx, uploadID)
	if err != nil {
		return false, err
	}
	if len(parts) != upload.PartCount {
		return false, fmt.Errorf("%w: %d of %d parts registered", ErrUploadIncomplete, len(parts), upload.PartCount)
	}
	payload := map[string]any{
		"type": "upload.completed", "upload_id": uploadID, "tenant": upload.Tenant,
		"total_bytes": upload.TotalBytes, "part_count": upload.PartCount, "content_type": upload.ContentType,
	}
	value, _ := json.Marshal(payload)
	t := topic
	if err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Value: value}, nil); err != nil {
		return false, store.InsertOutbox(ctx, topic, uploadID, payload)
	}
	refs := make([]*pb.PartRef, 0, len(parts))
	for _, p := range parts {
		refs = append(refs, &pb.PartRef{PartNumber: int32(p.PartNumber), Checksum: p.Checksum})
	}
	callCtx, cancel := context.WithTimeout(ctx, commitDeadline)
	defer cancel()
	if _, err := objects.CommitObject(callCtx, &pb.CommitRequest{UploadId: uploadID, Parts: refs}); err != nil {
		return false, err
	}
	store.MarkComplete(ctx, uploadID)
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "uploads/gen/resumable_upload"
	"uploads/manifest" // manifest.ReadParts
	"uploads/store"    // store.GetUpload, MarkComplete, InsertOutbox
)

const (
	topic          = "upload.event"
	commitDeadline = 30 * time.Second
	ackTimeout     = 2 * time.Second
)

// ErrUploadIncomplete: a part is still missing, the upload cannot be committed.
var ErrUploadIncomplete = errors.New("upload incomplete")

var (
	objectsConn, _ = grpc.NewClient("objects:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	objects        = pb.NewObjectStoreClient(objectsConn)
	producer       = newProducer()
)

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a record retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// completeUpload commits the upload's object and announces it; true once the broker acknowledged upload.completed.
func completeUpload(ctx context.Context, uploadID string) (bool, error) {
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil {
		return false, fmt.Errorf("no upload %s", uploadID)
	}
	parts, err := manifest.ReadParts(ctx, uploadID)
	if err != nil {
		return false, err
	}
	if len(parts) != upload.PartCount {
		return false, fmt.Errorf("%w: %d of %d parts registered", ErrUploadIncomplete, len(parts), upload.PartCount)
	}
	refs := make([]*pb.PartRef, 0, len(parts))
	for _, p := range parts {
		refs = append(refs, &pb.PartRef{PartNumber: int32(p.PartNumber), Checksum: p.Checksum})
	}
	// The object first: an event may lag the commit, it may not precede it. A failed commit returns here.
	callCtx, cancel := context.WithTimeout(ctx, commitDeadline)
	defer cancel()
	if _, err := objects.CommitObject(callCtx, &pb.CommitRequest{UploadId: uploadID, Parts: refs}); err != nil {
		return false, err
	}
	store.MarkComplete(ctx, uploadID)
	payload := map[string]any{
		"type": "upload.completed", "upload_id": uploadID, "tenant": upload.Tenant,
		"total_bytes": upload.TotalBytes, "part_count": upload.PartCount, "content_type": upload.ContentType,
	}
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(uploadID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err = producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the pipeline hears late, not never.
		return false, store.InsertOutbox(ctx, topic, uploadID, payload)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import uploads.{Manifest, Store} // Manifest.readParts, Store.getUpload, markComplete, insertOutbox
import uploadd.resumable_upload.{CommitRequest, ObjectStoreGrpc, PartRef}

/** A part is still missing: the upload cannot be committed. */
final class UploadIncomplete(message: String) extends Exception(message)

object Events {
  val Topic = "upload.event"
  val CommitDeadlineSeconds = 30L

  private val objects = ObjectStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("objects", 9000).usePlaintext().build())

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Commit the upload's object and announce it; true once the broker acknowledged upload.completed. */
  def completeUpload(uploadId: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val upload = Store.getUpload(uploadId).getOrElse(throw new NoSuchElementException(s"no upload $uploadId"))
    val parts = Manifest.readParts(uploadId)
    if (parts.size != upload.partCount) throw new UploadIncomplete(s"\${parts.size} of \${upload.partCount} parts registered")
    val payload = JsObject(
      "type" -> JsString("upload.completed"), "upload_id" -> JsString(uploadId), "tenant" -> JsString(upload.tenant),
      "total_bytes" -> JsNumber(upload.totalBytes), "part_count" -> JsNumber(upload.partCount), "content_type" -> JsString(upload.contentType))
    try producer.send(new ProducerRecord[String, String](Topic, payload.compactPrint))
    catch {
      case _: KafkaException =>
        Store.insertOutbox(Topic, uploadId, payload)
        return false
    }
    val refs = parts.map(p => PartRef(p.partNumber, p.checksum))
    objects.withDeadlineAfter(CommitDeadlineSeconds, TimeUnit.SECONDS).commitObject(CommitRequest(uploadId, refs))
    Store.markComplete(uploadId)
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import io.grpc.ManagedChannelBuilder
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import uploads.{Manifest, Store} // Manifest.readParts, Store.getUpload, markComplete, insertOutbox
import uploadd.resumable_upload.{CommitRequest, ObjectStoreGrpc, PartRef}

/** A part is still missing: the upload cannot be committed. */
final class UploadIncomplete(message: String) extends Exception(message)

object Events {
  val Topic = "upload.event"
  val CommitDeadlineSeconds = 30L
  val AckTimeoutMs = 2000L

  private val objects = ObjectStoreGrpc.blockingStub(ManagedChannelBuilder.forAddress("objects", 9000).usePlaintext().build())

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a record retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Commit the upload's object and announce it; true once the broker acknowledged upload.completed. */
  def completeUpload(uploadId: String): Boolean = {
    val upload = Store.getUpload(uploadId).getOrElse(throw new NoSuchElementException(s"no upload $uploadId"))
    val parts = Manifest.readParts(uploadId)
    if (parts.size != upload.partCount) throw new UploadIncomplete(s"\${parts.size} of \${upload.partCount} parts registered")
    val refs = parts.map(p => PartRef(p.partNumber, p.checksum))
    // The object first: an event may lag the commit, it may not precede it. A failed commit throws here.
    objects.withDeadlineAfter(CommitDeadlineSeconds, TimeUnit.SECONDS).commitObject(CommitRequest(uploadId, refs))
    Store.markComplete(uploadId)
    val payload = JsObject(
      "type" -> JsString("upload.completed"), "upload_id" -> JsString(uploadId), "tenant" -> JsString(upload.tenant),
      "total_bytes" -> JsNumber(upload.totalBytes), "part_count" -> JsNumber(upload.partCount), "content_type" -> JsString(upload.contentType))
    val record = new ProducerRecord[String, String](Topic, uploadId, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay publishes the row later, so the pipeline hears late, not never.
    if (acked.isFailure) Store.insertOutbox(Topic, uploadId, payload)
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>

#include "resumable_upload.grpc.pb.h"
#include "uploads/manifest.h"  // manifest::readParts
#include "uploads/store.h"     // store::getUpload, markComplete, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "upload.event";
constexpr std::chrono::seconds kCommitDeadline{30};

auto objects = uploadd::ObjectStore::NewStub(grpc::CreateChannel("objects:9000", grpc::InsecureChannelCredentials()));

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// A part is still missing: the upload cannot be committed.
struct UploadIncomplete : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Commit the upload's object and announce it; true once the broker acknowledged upload.completed.
bool completeUpload(const std::string& upload_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto upload = store::getUpload(upload_id);
  if (!upload) throw std::out_of_range("no upload " + upload_id);
  const auto parts = manifest::readParts(upload_id);
  if (static_cast<int>(parts.size()) != upload->part_count) {
    throw UploadIncomplete(std::to_string(parts.size()) + " of " + std::to_string(upload->part_count) + " parts registered");
  }
  const json payload = {{"type", "upload.completed"}, {"upload_id", upload_id}, {"tenant", upload->tenant},
                        {"total_bytes", upload->total_bytes}, {"part_count", upload->part_count}, {"content_type", upload->content_type}};
  const std::string value = payload.dump();
  if (producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                        nullptr, 0, 0, nullptr) != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kTopic, upload_id, payload);
    return false;
  }
  producer->poll(0);
  uploadd::CommitRequest request;
  request.set_upload_id(upload_id);
  for (const auto& p : parts) {
    uploadd::PartRef* ref = request.add_parts();
    ref->set_part_number(p.part_number);
    ref->set_checksum(p.checksum);
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kCommitDeadline);
  uploadd::CommitReply reply;
  const grpc::Status status = objects->CommitObject(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("CommitObject: " + status.error_message());
  store::markComplete(upload_id);
  return true;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>

#include "resumable_upload.grpc.pb.h"
#include "uploads/manifest.h"  // manifest::readParts
#include "uploads/store.h"     // store::getUpload, markComplete, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "upload.event";
constexpr std::chrono::seconds kCommitDeadline{30};
constexpr int kAckTimeoutMs = 2000;

auto objects = uploadd::ObjectStore::NewStub(grpc::CreateChannel("objects:9000", grpc::InsecureChannelCredentials()));

// The delivery report of the record in flight: completeUpload produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a record retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// A part is still missing: the upload cannot be committed.
struct UploadIncomplete : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Commit the upload's object and announce it; true once the broker acknowledged upload.completed.
bool completeUpload(const std::string& upload_id) {
  const auto upload = store::getUpload(upload_id);
  if (!upload) throw std::out_of_range("no upload " + upload_id);
  const auto parts = manifest::readParts(upload_id);
  if (static_cast<int>(parts.size()) != upload->part_count) {
    throw UploadIncomplete(std::to_string(parts.size()) + " of " + std::to_string(upload->part_count) + " parts registered");
  }
  uploadd::CommitRequest request;
  request.set_upload_id(upload_id);
  for (const auto& p : parts) {
    uploadd::PartRef* ref = request.add_parts();
    ref->set_part_number(p.part_number);
    ref->set_checksum(p.checksum);
  }
  // The object first: an event may lag the commit, it may not precede it. A failed commit throws here.
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kCommitDeadline);
  uploadd::CommitReply reply;
  const grpc::Status status = objects->CommitObject(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("CommitObject: " + status.error_message());
  store::markComplete(upload_id);
  const json payload = {{"type", "upload.completed"}, {"upload_id", upload_id}, {"tenant", upload->tenant},
                        {"total_bytes", upload->total_bytes}, {"part_count", upload->part_count}, {"content_type", upload->content_type}};
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), upload_id.c_str(), upload_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the pipeline hears late, not never.
    store::insertOutbox(kTopic, upload_id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import resumable_upload_pb2 as pb
import resumable_upload_pb2_grpc
from uploads import manifest, store

TOPIC = "upload.event"


class Objects(resumable_upload_pb2_grpc.ObjectStoreServicer):
    """Commits what it is asked to, and notes how many upload.event records existed at that moment."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.commits = []

    def CommitObject(self, request, context):
        self.commits.append((request, len(self.ctx.kafka.records(TOPIC))))
        return pb.CommitReply(object_key=f"objects/{request.upload_id}", size=10)


def _events(ctx, uploads=1):
    """Uploads u-1..u-n of tenant t1, each with its three parts (4, 4 and 2 bytes) registered."""
    objects = Objects(ctx)
    ctx.grpc.serve(resumable_upload_pb2_grpc.add_ObjectStoreServicer_to_server, objects)
    for _ in range(uploads):
        upload_id = store.create_upload("t1", 10, 4, 3, "video/mp4")["upload_id"]
        for number, size in ((1, 4), (2, 4), (3, 2)):
            manifest.register_part(upload_id, number, 3, size, f"c{number}")
    return ctx.load("events"), objects


def _complete(m, upload_id, why):
    try:
        return m.complete_upload(upload_id)
    except grpc.RpcError as exc:
        raise AssertionError(f"{why}: complete_upload raised {exc.code().name} ({exc.details()})") from None


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_upload_key(ctx):
    m, _ = _events(ctx, 2)
    _complete(m, "u-1", "completing u-1")
    _complete(m, "u-2", "completing u-2")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"two completions produced {len(records)} records on upload.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"u-1", b"u-2"], f"the records are keyed {keys}, expected the upload ids: without the key a later event of the same upload can land on another partition and overtake this one"
    value = json.loads(records[0].value)
    assert value.get("type") == "upload.completed" and value.get("upload_id") == "u-1" and value.get("tenant") == "t1", f"the payload is {value}, expected type upload.completed, upload_id u-1, tenant t1"


def check_after_commit(ctx):
    m, objects = _events(ctx, 2)
    _complete(m, "u-1", "with a healthy store")
    assert objects.commits, "complete_upload never called CommitObject"
    request, records_then = objects.commits[0]
    assert records_then == 0, f"when the object was committed upload.event already held {records_then} record(s): a consumer can fetch an object that does not exist yet. Commit first, then produce"
    assert [(p.part_number, p.checksum) for p in request.parts] == [(1, "c1"), (2, "c2"), (3, "c3")], f"CommitObject listed {[(p.part_number, p.checksum) for p in request.parts]}, expected the registered parts in order"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the completion must still be produced after the commit"
    assert store.get_upload("u-1")["status"] == "complete", "a committed upload must be marked complete"
    ctx.grpc.fail("CommitObject", grpc.StatusCode.UNAVAILABLE, "store node down")
    try:
        m.complete_upload("u-2")
        raised = False
    except grpc.RpcError:
        raised = True
    assert len(ctx.kafka.records(TOPIC)) == 1, "an upload.completed event was produced for u-2, whose object never committed"
    assert raised, "complete_upload returned although CommitObject failed: the caller must learn the upload is not complete"
    assert store.get_upload("u-2")["status"] == "pending", f"u-2's status is {store.get_upload('u-2')['status']!r} after a failed commit, expected pending"


def check_outbox(ctx):
    m, _ = _events(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    ok = _complete(m, "u-1", "with the broker refusing the record")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused upload.completed and the outbox holds {len(rows)} rows: the media pipeline never hears of the upload"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "u-1" and rows[0].get("payload", {}).get("upload_id") == "u-1", f"the outbox row is {rows[0]}, expected the topic, the key u-1 and the payload"
    assert ok is False, f"complete_upload returned {ok!r} after a refused record, expected False"
    assert store.get_upload("u-1")["status"] == "complete", "the object committed: the upload stays complete when only the event failed"


def check_acks_idempotent(ctx):
    m, _ = _events(ctx, 2)
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    _complete(m, "u-1", "with one acknowledgement lost")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement upload.event holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    _complete(m, "u-2", "completing u-2")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"
`,
    typescript: `const TOPIC = 'upload.event';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** Uploads u-1..u-n of tenant t1, each with its three parts (4, 4 and 2 bytes) registered; the store notes the records at each commit. */
async function events(ctx, uploads = 1) {
  const pkg = ctx.proto('resumable_upload.proto');
  const commits: {parts: [number, string][]; recordsThen: number}[] = [];
  ctx.grpc.serve(pkg.uploadd.ObjectStore.service, {
    CommitObject(call, callback) {
      commits.push({parts: call.request.parts.map(p => [Number(p.part_number), p.checksum]), recordsThen: ctx.kafka.records(TOPIC).length});
      callback(null, {object_key: \`objects/\${call.request.upload_id}\`, size: 10});
    },
  });
  const store = ctx.load('/support/uploads/store.ts');
  const manifest = ctx.load('/support/uploads/manifest.ts');
  for (let i = 0; i < uploads; i += 1) {
    const {upload_id} = await store.createUpload('t1', 10, 4, 3, 'video/mp4');
    for (const [n, size] of [[1, 4], [2, 4], [3, 2]]) await manifest.registerPart(upload_id, n, 3, size, \`c\${n}\`);
  }
  return {m: ctx.load('events'), commits, store};
}

async function complete(m, uploadId: string, why: string) {
  try {
    return await m.completeUpload(uploadId);
  } catch (e) {
    assert.fail(\`\${why}: completeUpload threw \${(e as Error).message}\`);
  }
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

export async function check_upload_key(ctx) {
  const {m} = await events(ctx, 2);
  await complete(m, 'u-1', 'completing u-1');
  await complete(m, 'u-2', 'completing u-2');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 2, \`two completions produced \${records.length} records on upload.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['u-1', 'u-2'], \`the records are keyed \${JSON.stringify(keys)}, expected the upload ids: without the key a later event of the same upload can land on another partition and overtake this one\`);
  const value = JSON.parse(ctx.kafka.values(TOPIC)[0]);
  assert(value.type === 'upload.completed' && value.upload_id === 'u-1' && value.tenant === 't1', \`the payload is \${JSON.stringify(value)}, expected type upload.completed, upload_id u-1, tenant t1\`);
}

export async function check_after_commit(ctx) {
  const {m, commits, store} = await events(ctx, 2);
  await complete(m, 'u-1', 'with a healthy store');
  await settle();
  assert(commits.length > 0, 'completeUpload never called CommitObject');
  assert.equal(commits[0].recordsThen, 0, \`when the object was committed upload.event already held \${commits[0].recordsThen} record(s): a consumer can fetch an object that does not exist yet. Commit first, then produce\`);
  assert.deepStrictEqual(commits[0].parts, [[1, 'c1'], [2, 'c2'], [3, 'c3']], \`CommitObject listed \${JSON.stringify(commits[0].parts)}, expected the registered parts in order\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the completion must still be produced after the commit');
  assert.equal((await store.getUpload('u-1')).status, 'complete', 'a committed upload must be marked complete');
  ctx.grpc.fail('CommitObject', ctx.grpc.status.UNAVAILABLE, 'store node down', 1);
  let raised = false;
  try {
    await m.completeUpload('u-2');
  } catch {
    raised = true;
  }
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'an upload.completed event was produced for u-2, whose object never committed');
  assert(raised, 'completeUpload resolved although CommitObject failed: the caller must learn the upload is not complete');
  assert.equal((await store.getUpload('u-2')).status, 'pending', "u-2's status after a failed commit must stay pending");
}

export async function check_outbox(ctx) {
  const {m, store} = await events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const ok = await complete(m, 'u-1', 'with the broker refusing the record');
  await settle();
  const rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused upload.completed and the outbox holds \${rows.length} rows: the media pipeline never hears of the upload\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'u-1' && rows[0].payload?.upload_id === 'u-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key u-1 and the payload\`);
  assert.equal(ok, false, \`completeUpload resolved \${JSON.stringify(ok)} after a refused record, expected false\`);
  assert.equal((await store.getUpload('u-1')).status, 'complete', 'the object committed: the upload stays complete when only the event failed');
}

export async function check_acks_idempotent(ctx) {
  const {m} = await events(ctx, 2);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await complete(m, 'u-1', 'with one acknowledgement lost');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement upload.event holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await complete(m, 'u-2', 'completing u-2');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"google.golang.org/grpc/codes"

	pb "uploads/gen/resumable_upload"
	"uploads/manifest"
	"uploads/store"

	"leetbuild/harness"
)

var eventsBg = context.Background()

type commitSeen struct {
	parts       []string
	recordsThen int
}

// objectsPeer commits what it is asked to, and notes how many upload.event records existed at that moment.
type objectsPeer struct {
	pb.UnimplementedObjectStoreServer
	ctx     *harness.Ctx
	commits []commitSeen
}

func (o *objectsPeer) CommitObject(_ context.Context, req *pb.CommitRequest) (*pb.CommitReply, error) {
	var parts []string
	for _, p := range req.GetParts() {
		parts = append(parts, fmt.Sprintf("%d:%s", p.GetPartNumber(), p.GetChecksum()))
	}
	o.commits = append(o.commits, commitSeen{parts: parts, recordsThen: len(o.ctx.Kafka.Records(topic))})
	return &pb.CommitReply{ObjectKey: "objects/" + req.GetUploadId(), Size: 10}, nil
}

// events makes uploads u-1..u-n of tenant t1, each with its three parts (4, 4 and 2 bytes) registered.
func events(ctx *harness.Ctx, uploads int) *objectsPeer {
	peer := &objectsPeer{ctx: ctx}
	pb.RegisterObjectStoreServer(ctx.GRPC.Server(""), peer)
	for i := 0; i < uploads; i++ {
		u := store.CreateUpload(eventsBg, "t1", 10, 4, 3, "video/mp4")
		for n, size := range map[int]int64{1: 4, 2: 4, 3: 2} {
			_, err := manifest.RegisterPart(eventsBg, u.UploadID, n, 3, size, fmt.Sprintf("c%d", n))
			ctx.NoError(err, "registering part %d of %s", n, u.UploadID)
		}
	}
	return peer
}

func complete(ctx *harness.Ctx, uploadID, why string) bool {
	ok, err := completeUpload(eventsBg, uploadID)
	ctx.NoError(err, "%s: completeUpload(%s)", why, uploadID)
	return ok
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outbox(ctx *harness.Ctx) []outboxRow {
	var rows []outboxRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckUploadKey(ctx *harness.Ctx) {
	events(ctx, 2)
	complete(ctx, "u-1", "completing u-1")
	complete(ctx, "u-2", "completing u-2")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "two completions must produce two records on upload.event; the records")
	ctx.Equal(ctx.Kafka.Keys(topic), []string{"u-1", "u-2"}, "the records must be keyed by the upload ids (without the key a later event of the same upload can land on another partition and overtake this one)")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(ctx.Kafka.Values(topic)[0]), &value), "the payload must be JSON")
	ctx.Assert(value["type"] == "upload.completed" && value["upload_id"] == "u-1" && value["tenant"] == "t1", "the payload is %v, expected type upload.completed, upload_id u-1, tenant t1", value)
}

func CheckAfterCommit(ctx *harness.Ctx) {
	peer := events(ctx, 2)
	complete(ctx, "u-1", "with a healthy store")
	ctx.Settle()
	ctx.Assert(len(peer.commits) > 0, "completeUpload never called CommitObject")
	ctx.Equal(peer.commits[0].recordsThen, 0, "when the object was committed upload.event already held records: a consumer can fetch an object that does not exist yet. Commit first, then produce; the records at commit time")
	ctx.Equal(peer.commits[0].parts, []string{"1:c1", "2:c2", "3:c3"}, "CommitObject must list the registered parts in order")
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "the completion must still be produced after the commit; the records")
	ctx.Equal(store.GetUpload(eventsBg, "u-1").Status, "complete", "a committed upload's status")
	ctx.GRPC.Fail("CommitObject", codes.Unavailable, "store node down", 1, "")
	_, err := completeUpload(eventsBg, "u-2")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "no upload.completed event may be produced for u-2, whose object never committed; the records")
	ctx.Assert(err != nil, "completeUpload returned no error although CommitObject failed: the caller must learn the upload is not complete")
	ctx.Equal(store.GetUpload(eventsBg, "u-2").Status, "pending", "u-2's status after a failed commit")
}

func CheckOutbox(ctx *harness.Ctx) {
	events(ctx, 1)
	ctx.Kafka.FailNext(topic, 1)
	ok := complete(ctx, "u-1", "with the broker refusing the record")
	ctx.Settle()
	rows := outbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused upload.completed: without an outbox row the media pipeline never hears of the upload; the rows")
	ctx.Assert(rows[0].Topic == topic && rows[0].Key == "u-1" && rows[0].Payload["upload_id"] == "u-1", "the outbox row is %v, expected the topic, the key u-1 and the payload", rows[0])
	ctx.Equal(ok, false, "completeUpload's result after a refused record")
	ctx.Equal(store.GetUpload(eventsBg, "u-1").Status, "complete", "the object committed: the upload stays complete when only the event failed; the status")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	events(ctx, 2)
	ctx.Kafka.LoseAcks(topic, 1) // the broker wrote it, the acknowledgement never arrived
	complete(ctx, "u-1", "with one acknowledgement lost")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	complete(ctx, "u-2", "completing u-2")
	ctx.Settle()
	ctx.Kafka.Failover(topic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "resumable_upload.grpc.pb.h"
#include "uploads/manifest.h"
#include "uploads/store.h"

namespace {

struct CommitSeen {
  std::vector<std::string> parts;
  size_t records_then = 0;
};

// Commits what it is asked to, and notes how many upload.event records existed at that moment.
class ObjectsPeer final : public uploadd::ObjectStore::Service {
 public:
  explicit ObjectsPeer(harness::Ctx& ctx) : ctx_(ctx) {}
  std::vector<CommitSeen> commits;
  grpc::Status CommitObject(grpc::ServerContext*, const uploadd::CommitRequest* req, uploadd::CommitReply* out) override {
    CommitSeen seen;
    for (const auto& p : req->parts()) seen.parts.push_back(std::to_string(p.part_number()) + ":" + p.checksum());
    seen.records_then = ctx_.Kafka.Records(kTopic).size();
    commits.push_back(seen);
    out->set_object_key("objects/" + req->upload_id());
    out->set_size(10);
    return grpc::Status::OK;
  }

 private:
  harness::Ctx& ctx_;
};

// Uploads u-1..u-n of tenant t1, each with its three parts (4, 4 and 2 bytes) registered.
ObjectsPeer& events(harness::Ctx& ctx, int uploads) {
  static ObjectsPeer* peer = nullptr;
  delete peer;
  peer = new ObjectsPeer(ctx);
  ctx.GRPC.Server("")->RegisterService(peer);
  for (int i = 0; i < uploads; i++) {
    const std::string upload_id = store::createUpload("t1", 10, 4, 3, "video/mp4").upload_id;
    manifest::registerPart(upload_id, 1, 3, 4, "c1");
    manifest::registerPart(upload_id, 2, 3, 4, "c2");
    manifest::registerPart(upload_id, 3, 3, 2, "c3");
  }
  return *peer;
}

bool complete(harness::Ctx& ctx, const std::string& upload_id, const std::string& why) {
  try {
    return completeUpload(upload_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: completeUpload threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
}

std::vector<nlohmann::json> outbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckUploadKey(harness::Ctx& ctx) {
  events(ctx, 2);
  complete(ctx, "u-1", "completing u-1");
  complete(ctx, "u-2", "completing u-2");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "two completions must produce two records on upload.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"u-1", "u-2"}, "the records must be keyed by the upload ids (without the key a later event of the same upload can land on another partition and overtake this one)");
  const auto value = nlohmann::json::parse(ctx.Kafka.Values(kTopic)[0], nullptr, false);
  ctx.Assert(field(value, "type") == "upload.completed" && field(value, "upload_id") == "u-1" && field(value, "tenant") == "t1",
             "the payload is %s, expected type upload.completed, upload_id u-1, tenant t1", ctx.Kafka.Values(kTopic)[0]);
}

void CheckAfterCommit(harness::Ctx& ctx) {
  ObjectsPeer& peer = events(ctx, 2);
  complete(ctx, "u-1", "with a healthy store");
  ctx.Settle();
  ctx.Assert(!peer.commits.empty(), "completeUpload never called CommitObject");
  ctx.Equal(peer.commits[0].records_then, 0,
            "when the object was committed upload.event already held records: a consumer can fetch an object that does not exist yet. Commit first, then produce; the records at commit time");
  ctx.Equal(peer.commits[0].parts, {"1:c1", "2:c2", "3:c3"}, "CommitObject must list the registered parts in order");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "the completion must still be produced after the commit; the records");
  ctx.Equal(store::getUpload("u-1")->status, "complete", "a committed upload's status");
  ctx.GRPC.Fail("CommitObject", grpc::StatusCode::UNAVAILABLE, "store node down", 1);
  bool raised = false;
  try {
    completeUpload("u-2");
  } catch (const std::exception&) {
    raised = true;
  }
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "no upload.completed event may be produced for u-2, whose object never committed; the records");
  ctx.Assert(raised, "completeUpload returned although CommitObject failed: the caller must learn the upload is not complete");
  ctx.Equal(store::getUpload("u-2")->status, "pending", "u-2's status after a failed commit");
}

void CheckOutbox(harness::Ctx& ctx) {
  events(ctx, 1);
  ctx.Kafka.FailNext(kTopic, 1);
  const bool ok = complete(ctx, "u-1", "with the broker refusing the record");
  ctx.Settle();
  const auto rows = outbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused upload.completed: without an outbox row the media pipeline never hears of the upload; the rows");
  ctx.Assert(field(rows[0], "topic") == kTopic && field(rows[0], "key") == "u-1" && rows[0].contains("payload") && field(rows[0]["payload"], "upload_id") == "u-1",
             "the outbox row is %s, expected the topic, the key u-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "completeUpload's result after a refused record");
  ctx.Equal(store::getUpload("u-1")->status, "complete", "the object committed: the upload stays complete when only the event failed; the status");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  events(ctx, 2);
  ctx.Kafka.LoseAcks(kTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  complete(ctx, "u-1", "with one acknowledgement lost");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  complete(ctx, "u-2", "completing u-2");
  ctx.Settle();
  ctx.Kafka.Failover(kTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}
`,
  },
  hints: [
    'Fail the commit: the media pipeline already has upload.completed. Refuse the record at the broker: nothing reaches the outbox and the call reports success. Every record has an empty key.',
    "`produce` hands the record to a local queue and raises only for local errors; the broker's answer arrives later in a delivery report the starter never reads. The produce runs before CommitObject.",
    'Call `CommitObject` and `mark_complete` first; then produce with `key=upload_id` and an `on_delivery` callback, `flush(ACK_TIMEOUT_S)`, and on an error or anything in flight `insert_outbox` and return False. Set `acks` all and `enable.idempotence`.',
  ],
  debrief: `An event is a promise that the thing it names exists, so it is produced only once the commit made that true; a failed commit raises and leaves the upload pending for a retry. The key is the upload id because the consumer's order only holds inside a partition, and the events that will follow, a deletion or a re-encode, must queue behind this one. The delivery report is where the broker's answer arrives, which is why the outbox decision lives there and not around \`produce\`. Production services write the outbox row in the same transaction as the status change and let a relay publish it, so a crash between the commit and the produce is covered too.`,
};
