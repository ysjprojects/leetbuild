import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Upload events keyed by upload id',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: it produces to \`upload.event\`, the topic exists and
the happy path emits events. Four defects hide in how and when it publishes. Find them, fix them, and
prove the fix.

Implement the upload event publisher. Three events are published to the \`upload.event\` topic:
\`part.stored\`, \`session.expired\` and \`upload.completed\`.

- Every event is keyed by the **upload id**, so all events for one upload land in the same partition
  and their history stays ordered. The draft keys by client, so one upload's events scatter and a
  consumer sees \`upload.completed\` before the \`part.stored\` events that precede it.
- The \`upload.completed\` event is published **after the object commits**, not before. The draft
  publishes first and commits afterwards, so a consumer can react to an upload whose object does not
  exist yet — an upload that is invisible downstream is worse than a late event.
- When the broker rejects the produce, an **outbox row** is written so the event can be replayed.
  The draft drops the event on the floor.
- The event carries **part numbers and checksums**, never content: \`{"event":"part.stored",
  "upload_id": …, "part_number": …, "size": …, "checksum": …}\`. The draft puts the part bytes in
  the event, so the topic retains and replicates tenant content.

**Failure mode the checks target.** Keying by client scatters one upload's events across partitions, so
ordering is lost; publishing \`upload.completed\` before the object commits lets a consumer act on an
upload that is not there; a missing outbox means a broker blip loses the completion event; and copying
part bytes into the event ships tenant content into a retained, replicated log.`,
  sequence: {
    participants: ['Upload API', 'Object store', 'upload.event'],
    messages: [
      {from: 'Upload API', to: 'Object store', label: 'commit object first', kind: 'sync'},
      {from: 'Object store', to: 'Upload API', label: 'committed', kind: 'reply'},
      {from: 'Upload API', to: 'upload.event', label: 'produce upload.completed · key = upload_id', kind: 'sync'},
      {from: 'upload.event', to: 'Upload API', label: 'broker ack / rejection', kind: 'reply'},
      {from: 'Upload API', to: 'Upload API', label: 'outbox row when the broker rejects', kind: 'async'},
    ],
  },
  hints: [
    'The key is the ordering guarantee: `key: uploadId` (or `Key: []byte(uploadID)`, or the first argument after the topic in the Java client). Key by client and one upload’s history splits across partitions; key by upload id and it stays in order.',
    'Sequence the completion event after the object commit — `await commitObject(uploadId)` then the produce. If the object is not committed, the event describes something that does not exist yet, and a consumer that fans out on it races the commit.',
    'Events carry part metadata, never bytes. If the produce fails, write an outbox row so a replay can publish later; dropping the event means a completed upload is invisible downstream. An idempotent producer keeps a retry from duplicating.',
  ],
  checks: [
    {
      id: 'topic',
      title: 'Produces to upload.event',
      detail: 'Events are produced to the `upload.event` topic.',
      match: {
        python: {all: [/upload\.event/]},
        typescript: {all: [/upload\.event/]},
        go: {all: [/upload\.event/]},
        scala: {all: [/upload\.event/]},
        cpp: {all: [/upload\.event/]},
      },
    },
    {
      id: 'key-by-upload',
      title: 'Keys every event by the upload id',
      detail:
        'The message key is the upload id, so one upload’s events share a partition and stay ordered. The draft keys by client, so the history scatters.',
      match: {
        python: {all: [/key=upload_id/]},
        typescript: {all: [/key: uploadId/]},
        go: {all: [/Key:\s*\[\]byte\(uploadID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(\s*"upload\.event"\s*,\s*uploadId/]},
        cpp: {all: [/"upload\.event", uploadId/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publishes completed only after the object commits',
      detail:
        'The object commit happens before the `upload.completed` produce. The draft publishes first and commits afterwards.',
      match: {
        python: {order: [/commit_object\(/, /producer\.send\(/]},
        typescript: {order: [/commitObject\(/, /producer\.send\(/]},
        go: {order: [/CommitObject\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/commitObject\(/, /producer\.send\(/]},
        cpp: {order: [/CommitObject\(/, /Producer::produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the broker rejects',
      detail: 'A rejected produce leaves an outbox row so the event can be replayed. The draft drops the event.',
      match: {
        python: {all: [/outbox/]},
        typescript: {all: [/[Oo]utbox/]},
        go: {all: [/Outbox/]},
        scala: {all: [/Outbox/]},
        cpp: {all: [/Outbox/]},
      },
    },
    {
      id: 'no-content',
      title: 'Carries part numbers and checksums, never content',
      detail:
        'The event carries `part_number` and `checksum`; the part bytes never reach the topic. The draft puts the part bytes in the event payload.',
      match: {
        python: {all: [/part_number/, /checksum/], none: [/\bdata\b/]},
        typescript: {all: [/part_number/, /checksum/], none: [/\bdata\b/]},
        go: {all: [/partNumber/, /checksum/], none: [/\bdata\b/]},
        scala: {all: [/partNumber/, /checksum/], none: [/\bdata\b/]},
        cpp: {all: [/part_number/, /checksum/], none: [/\bdata\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from kafka import KafkaProducer

producer = KafkaProducer(bootstrap_servers="kafka:9092", acks="all")


def publish_part_stored(
    client_id: str, upload_id: str, part_number: int, checksum: str, data: bytes
) -> None:
    # TODO: this draft keys by client so one upload's events scatter across partitions, publishes
    # upload.completed before the object commits, carries the part bytes in the event, and writes no
    # outbox row when the broker rejects.
    event = {
        "event": "part.stored",
        "upload_id": upload_id,
        "part_number": part_number,
        "checksum": checksum,
        "payload": data.hex(),
    }
    producer.send("upload.event", key=client_id.encode(), value=json.dumps(event).encode())


def publish_upload_completed(client_id: str, upload_id: str, content_type: str) -> None:
    event = {"event": "upload.completed", "upload_id": upload_id, "content_type": content_type}
    producer.send("upload.event", key=client_id.encode(), value=json.dumps(event).encode())
    commit_object(upload_id)
`,
      solution: `import json

from kafka import KafkaProducer

producer = KafkaProducer(
    bootstrap_servers="kafka:9092", acks="all", enable_idempotence=True
)


def publish_part_stored(upload_id: str, part_number: int, size: int, checksum: str) -> None:
    event = {
        "event": "part.stored",
        "upload_id": upload_id,
        "part_number": part_number,
        "size": size,
        "checksum": checksum,
    }
    send_event(upload_id, event)


def publish_upload_completed(upload_id: str, content_type: str, part_count: int) -> None:
    # The object must exist before a consumer hears about the completion.
    commit_object(upload_id)
    event = {
        "event": "upload.completed",
        "upload_id": upload_id,
        "content_type": content_type,
        "part_count": part_count,
    }
    send_event(upload_id, event)


def send_event(upload_id: str, event: dict) -> None:
    """Produce one event keyed by upload id; a rejection leaves an outbox row for replay."""
    try:
        producer.send(
            "upload.event", key=upload_id.encode(), value=json.dumps(event).encode()
        ).get(timeout=5)
    except Exception:
        write_outbox(upload_id, event)
`,
    },
    typescript: {
      starter: `/** upload.event: a model-generated draft that keys by client and commits late. */
import {Kafka, logLevel} from 'kafkajs';

const kafka = new Kafka({brokers: ['kafka:9092'], logLevel: logLevel.ERROR});
const producer = kafka.producer();

interface PartStoredEvent {
  event: 'part.stored';
  upload_id: string;
  part_number: number;
  checksum: string;
  payload: string;
}

export async function publishPartStored(
  clientId: string,
  uploadId: string,
  partNumber: number,
  checksum: string,
  data: Buffer,
): Promise<void> {
  // TODO: this draft keys by client so one upload's events scatter across partitions, publishes
  // upload.completed before the object commits, carries the part bytes in the event, and writes no
  // outbox row when the broker rejects.
  const event: PartStoredEvent = {
    event: 'part.stored',
    upload_id: uploadId,
    part_number: partNumber,
    checksum,
    payload: data.toString('hex'),
  };
  await producer.send({topic: 'upload.event', messages: [{key: clientId, value: JSON.stringify(event)}]});
}

export async function publishUploadCompleted(
  clientId: string,
  uploadId: string,
  contentType: string,
): Promise<void> {
  const event = {event: 'upload.completed', upload_id: uploadId, content_type: contentType};
  await producer.send({topic: 'upload.event', messages: [{key: clientId, value: JSON.stringify(event)}]});
  await commitObject(uploadId);
}
`,
      solution: `/** upload.event: every event keyed by upload id, published after the object commits. */
import {Kafka, logLevel} from 'kafkajs';

const kafka = new Kafka({brokers: ['kafka:9092'], logLevel: logLevel.ERROR});
const producer = kafka.producer({idempotent: true});

interface UploadEvent {
  event: string;
  upload_id: string;
  part_number?: number;
  size?: number;
  checksum?: string;
  content_type?: string;
  part_count?: number;
}

export async function publishPartStored(
  uploadId: string,
  partNumber: number,
  size: number,
  checksum: string,
): Promise<void> {
  await sendEvent(uploadId, {
    event: 'part.stored',
    upload_id: uploadId,
    part_number: partNumber,
    size,
    checksum,
  });
}

export async function publishUploadCompleted(
  uploadId: string,
  contentType: string,
  partCount: number,
): Promise<void> {
  await commitObject(uploadId);
  await sendEvent(uploadId, {
    event: 'upload.completed',
    upload_id: uploadId,
    content_type: contentType,
    part_count: partCount,
  });
}

async function sendEvent(uploadId: string, event: UploadEvent): Promise<void> {
  try {
    await producer.send({topic: 'upload.event', messages: [{key: uploadId, value: JSON.stringify(event)}]});
  } catch {
    await writeOutbox(uploadId, event);
  }
}
`,
    },
    go: {
      starter: `package events

import (
	"context"
	"encoding/hex"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "upload.event"}

func PublishPartStored(
	ctx context.Context,
	clientID string,
	uploadID string,
	partNumber int,
	checksum string,
	data []byte,
) error {
	// TODO: this draft keys by client so one upload's events scatter across partitions, publishes
	// upload.completed before the object commits, carries the part bytes in the event, and writes no
	// outbox row when the broker rejects.
	value, _ := json.Marshal(map[string]any{
		"event":       "part.stored",
		"upload_id":   uploadID,
		"part_number": partNumber,
		"checksum":    checksum,
		"payload":     hex.EncodeToString(data),
	})
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(clientID), Value: value})
}

func PublishUploadCompleted(ctx context.Context, clientID, uploadID, contentType string) error {
	value, _ := json.Marshal(map[string]any{
		"event":        "upload.completed",
		"upload_id":    uploadID,
		"content_type": contentType,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(clientID), Value: value}); err != nil {
		return err
	}
	return CommitObject(ctx, uploadID)
}
`,
      solution: `package events

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:                   kafka.TCP("kafka:9092"),
	Topic:                  "upload.event",
	RequiredAcks:           kafka.RequireAll,
	AllowAutoTopicCreation: false,
}

func PublishPartStored(ctx context.Context, uploadID string, partNumber int, size int64, checksum string) error {
	return SendEvent(ctx, uploadID, map[string]any{
		"event":       "part.stored",
		"upload_id":   uploadID,
		"part_number": partNumber,
		"size":        size,
		"checksum":    checksum,
	})
}

func PublishUploadCompleted(ctx context.Context, uploadID, contentType string, partCount int) error {
	if err := CommitObject(ctx, uploadID); err != nil {
		return err
	}
	return SendEvent(ctx, uploadID, map[string]any{
		"event":        "upload.completed",
		"upload_id":    uploadID,
		"content_type": contentType,
		"part_count":   partCount,
	})
}

func SendEvent(ctx context.Context, uploadID string, event map[string]any) error {
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(uploadID), Value: value}); err != nil {
		return WriteOutbox(ctx, uploadID, event)
	}
	return nil
}
`,
    },
    scala: {
      starter: `package events

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

import java.util.Properties

object UploadEvents {
  val props: Properties = {
    val p = new Properties()
    p.put("bootstrap.servers", "kafka:9092")
    p
  }
  val producer = new KafkaProducer[String, String](props)

  def publishPartStored(
      clientId: String,
      uploadId: String,
      partNumber: Long,
      checksum: String,
      data: Array[Byte],
  ): Unit = {
    // TODO: this draft keys by client so one upload's events scatter across partitions, publishes
    // upload.completed before the object commits, carries the part bytes in the event, and writes no
    // outbox row when the broker rejects.
    val event =
      s"""{"event":"part.stored","upload_id":"$uploadId","part_number":$partNumber,"checksum":"$checksum","payload":"\${data.map("%02x".format(_)).mkString}"}"""
    producer.send(new ProducerRecord[String, String]("upload.event", clientId, event))
  }

  def publishUploadCompleted(clientId: String, uploadId: String, contentType: String): Unit = {
    val event = s"""{"event":"upload.completed","upload_id":"$uploadId","content_type":"$contentType"}"""
    producer.send(new ProducerRecord[String, String]("upload.event", clientId, event))
    commitObject(uploadId)
  }
}
`,
      solution: `package events

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

import java.util.Properties

object UploadEvents {
  val props: Properties = {
    val p = new Properties()
    p.put("bootstrap.servers", "kafka:9092")
    p.put("acks", "all")
    p.put("enable.idempotence", "true")
    p
  }
  val producer = new KafkaProducer[String, String](props)

  def publishPartStored(uploadId: String, partNumber: Long, size: Long, checksum: String): Unit = {
    val event =
      s"""{"event":"part.stored","upload_id":"$uploadId","part_number":$partNumber,"size":$size,"checksum":"$checksum"}"""
    sendEvent(uploadId, event)
  }

  def publishUploadCompleted(uploadId: String, contentType: String, partCount: Long): Unit = {
    // The object must exist before a consumer hears about the completion.
    commitObject(uploadId)
    val event =
      s"""{"event":"upload.completed","upload_id":"$uploadId","content_type":"$contentType","part_count":$partCount}"""
    sendEvent(uploadId, event)
  }

  def sendEvent(uploadId: String, event: String): Unit = {
    try {
      producer.send(new ProducerRecord[String, String]("upload.event", uploadId, event)).get()
    } catch {
      case _: Exception => WriteOutbox(uploadId, event)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>

void PublishPartStored(
    RdKafka::Producer* producer,
    const std::string& clientId,
    const std::string& uploadId,
    long long partNumber,
    const std::string& checksum,
    const std::string& data) {
  // TODO: this draft keys by client so one upload's events scatter across partitions, publishes
  // upload.completed before the object commits, carries the part bytes in the event, and writes no
  // outbox row when the broker rejects.
  const auto event = "{\\"event\\":\\"part.stored\\",\\"upload_id\\":\\"" + uploadId +
                     "\\",\\"part_number\\":" + std::to_string(partNumber) +
                     ",\\"checksum\\":\\"" + checksum + "\\",\\"payload\\":\\"" + data + "\\"}";
  RdKafka::Producer::produce(producer, "upload.event", clientId, event);
}

void PublishUploadCompleted(
    RdKafka::Producer* producer,
    const std::string& clientId,
    const std::string& uploadId,
    const std::string& contentType) {
  const auto event = "{\\"event\\":\\"upload.completed\\",\\"upload_id\\":\\"" + uploadId +
                     "\\",\\"content_type\\":\\"" + contentType + "\\"}";
  RdKafka::Producer::produce(producer, "upload.event", clientId, event);
  CommitObject(uploadId);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

void PublishPartStored(
    RdKafka::Producer* producer,
    const std::string& uploadId,
    long long partNumber,
    long long size,
    const std::string& checksum) {
  const json event = {
      {"event", "part.stored"},
      {"upload_id", uploadId},
      {"part_number", partNumber},
      {"size", size},
      {"checksum", checksum},
  };
  SendEvent(producer, uploadId, event.dump());
}

void PublishUploadCompleted(
    RdKafka::Producer* producer,
    const std::string& uploadId,
    const std::string& contentType,
    long long partCount) {
  // The object must exist before a consumer hears about the completion.
  CommitObject(uploadId);
  const json event = {
      {"event", "upload.completed"},
      {"upload_id", uploadId},
      {"content_type", contentType},
      {"part_count", partCount},
  };
  SendEvent(producer, uploadId, event.dump());
}

void SendEvent(RdKafka::Producer* producer, const std::string& uploadId, const std::string& event) {
  const auto error = RdKafka::Producer::produce(producer, "upload.event", uploadId, event);
  if (error != RdKafka::ERR_NO_ERROR) {
    WriteOutbox(uploadId, event);
  }
}
`,
    },
  },
  debrief: `The event path is where an upload's history becomes a contract with every downstream consumer. Keying by client is the subtle defect: Kafka orders within a partition, not across the topic, so a client-keyed topic delivers \`upload.completed\` before the \`part.stored\` events that produced it. Publishing the completion event before the object commits is the second one — the event describes a state that does not exist yet, and a consumer that fans out on it races the commit. The outbox is what makes the event durable when the broker blinks, and keeping the part bytes out of the event keeps tenant content out of a retained, replicated log. Real pipelines add a schema registry so a future producer cannot smuggle content in, and a consumer that commits its offset only after it has applied the event.`,
};
