import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'File events keyed by file id with no content',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'store', 'kafka'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the event publisher: it
serialises an event and produces it to \`file.event\`. It compiles, the happy path works, and it hides
three production flaws. Review it, fix it, and prove the fix with the checks below.

Implement the \`file.event\` publisher:

- Upload, finalize and delete events all publish to the topic \`file.event\`.
- The message **key is the file id**, so every event for one file lands in the same partition and a
  consumer sees that file's lifecycle in order. Keying by tenant scatters one file's events across
  partitions and reorders them.
- The payload carries the object's **digest** (SHA-256), its **sniffed mime** and its **size**, plus
  opaque ids. It never carries the original filename, the file's bytes, or anything a consumer would
  have to treat as untrusted user text.
- The **finalize** event publishes only after the object store's \`CommitMultipart\` has returned. A
  consumer that reacts to "finalized" must never race the commit and find the bytes missing.
- The producer is configured for **\`acks=all\`** and **idempotence**, so a broker-side retry cannot
  duplicate an event and a lost acknowledgement cannot silently drop one.

**Failure mode the checks target.** A tenant key puts one file's events in different partitions and a
consumer sees "deleted" before "finalized". Publishing before the commit lets a downstream index mark a
file readable before its bytes exist. And a payload that carries the original filename ships user text
into a retained, replicated topic — the extension alone tells an attacker what the tenant is storing.`,
  sequence: {
    participants: ['Upload API', 'Object store', 'Kafka', 'Event consumer'],
    messages: [
      {from: 'Upload API', to: 'Object store', label: 'CommitMultipart(manifest)', kind: 'sync'},
      {from: 'Object store', to: 'Upload API', label: 'committed · file_id', kind: 'reply'},
      {from: 'Upload API', to: 'Upload API', label: 'publish only after the commit returns', kind: 'sync'},
      {
        from: 'Upload API',
        to: 'Kafka',
        label: 'produce file.event · key = file_id · {digest, sniffed_mime, size}',
        kind: 'async',
      },
      {from: 'Kafka', to: 'Event consumer', label: 'consume file.event', kind: 'async'},
      {from: 'Event consumer', to: 'Event consumer', label: 'index metadata · no user text', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'key-by-file',
      title: 'Events are keyed by file id',
      detail:
        'The produced key is derived from the file id, so one file’s lifecycle stays in one partition. The draft keys by tenant, so a file’s events scatter across partitions.',
      match: {
        python: {all: [/file_event_key\(/, /produce\(/]},
        typescript: {all: [/fileEventKey\(/, /\.send\(/]},
        go: {all: [/fileEventKey\(/, /WriteMessages\(/]},
        scala: {all: [/fileEventKey\(/, /ProducerRecord\[/]},
        cpp: {all: [/fileEventKey\(/, /produce\(/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Finalize publishes only after the store commits',
      detail:
        '`CommitMultipart` is called before the event is produced. The draft publishes first, so a consumer can act on a file whose bytes the store has not committed.',
      match: {
        python: {order: [/\.commit_multipart\(/, /publish\(/]},
        typescript: {order: [/commitMultipart\(/, /publish\(/]},
        go: {order: [/CommitMultipart\(/, /publish\(/]},
        scala: {order: [/commitMultipart\(/, /publish\(/]},
        cpp: {order: [/commitMultipart\(/, /publish\(/]},
      },
    },
    {
      id: 'no-filename',
      title: 'The payload never carries the original filename',
      detail:
        'The original filename is user text and stays out of the event. The draft includes it so downstream consumers can label attachments.',
      match: {
        python: {none: [/filename/]},
        typescript: {none: [/filename/]},
        go: {none: [/filename/]},
        scala: {none: [/filename/]},
        cpp: {none: [/filename/]},
      },
    },
    {
      id: 'opaque-payload',
      title: 'The payload carries digest, sniffed type and size',
      detail:
        'The event carries the object’s digest, its sniffed mime and its size instead of content. The draft sends the filename and the size with neither digest nor sniffed type.',
      match: {
        python: {all: [/digest/, /sniffed_mime/, /size/]},
        typescript: {all: [/digest/, /sniffedMime/, /size/]},
        go: {all: [/Digest/, /SniffedMime/, /Size/]},
        scala: {all: [/digest/, /sniffedMime/, /size/]},
        cpp: {all: [/digest/, /sniffed_mime/, /size/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'The producer is idempotent with acks=all',
      detail:
        'The producer is configured `acks=all` with idempotence enabled. The draft uses the client defaults, so a retry can duplicate an event.',
      match: {
        python: {all: [/acks/, /idempotence/]},
        typescript: {all: [/acks/, /idempotent/]},
        go: {all: [/RequireAll/, /Acks/]},
        scala: {all: [/acks/, /idempotence/]},
        cpp: {all: [/acks/, /idempotence/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

producer = Producer({"bootstrap.servers": "kafka:9092"})


def tenant_event_key(event):
    return event["tenant"]


def publish_file_event(kind, event):
    # TODO: this draft keys by tenant, publishes before the store commits, and ships the original
    # filename in the payload so consumers can label attachments.
    payload = json.dumps(
        {
            "kind": kind,
            "file_id": event["file_id"],
            "tenant": event["tenant"],
            "filename": event["filename"],
            "size": event["size"],
        }
    )
    producer.produce("file.event", key=tenant_event_key(event), value=payload)
    producer.poll(0)


def finalize(upload, store):
    publish_file_event("finalized", event_of(upload))
    store.commit_multipart(upload.multipart_id)


def event_of(upload):
    return {"file_id": upload.file_id, "tenant": upload.tenant, "filename": upload.filename, "size": upload.size}
`,
      solution: `import json

from confluent_kafka import Producer

FILE_EVENT_TOPIC = "file.event"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)


def file_event_key(event):
    return event["file_id"]


def payload(kind, event):
    return json.dumps(
        {
            "kind": kind,
            "file_id": event["file_id"],
            "tenant": event["tenant"],
            "digest": event["digest"],
            "sniffed_mime": event["sniffed_mime"],
            "size": event["size"],
        }
    )


def publish(kind, event):
    producer.produce(FILE_EVENT_TOPIC, key=file_event_key(event), value=payload(kind, event))
    producer.poll(0)


def finalize(upload, store):
    store.commit_multipart(upload.multipart_id)
    publish("finalized", event_of(upload))


def delete_file(file_id, tenant, digest, store):
    store.delete_object(file_id)
    publish("deleted", {"file_id": file_id, "tenant": tenant, "digest": digest, "sniffed_mime": "", "size": 0})


def event_of(upload):
    return {
        "file_id": upload.file_id,
        "tenant": upload.tenant,
        "digest": upload.digest,
        "sniffed_mime": upload.sniffed_mime,
        "size": upload.size,
    }


def flush():
    producer.flush()
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();

function tenantEventKey(event: FileEvent): string {
  return event.tenant;
}

export async function publishFileEvent(kind: string, event: FileEvent): Promise<void> {
  // TODO: this draft keys by tenant, publishes before the store commits, and ships the original
  // filename in the payload so consumers can label attachments.
  await producer.send({
    topic: 'file.event',
    messages: [
      {
        key: tenantEventKey(event),
        value: JSON.stringify({kind, file_id: event.fileId, filename: event.filename, size: event.size}),
      },
    ],
  });
}

export async function finalize(upload: Upload, store: ObjectStore): Promise<void> {
  await publishFileEvent('finalized', eventOf(upload));
  await store.commitMultipart(upload.multipartId);
}

function eventOf(upload: Upload): FileEvent {
  return {fileId: upload.fileId, tenant: upload.tenant, filename: upload.filename, size: upload.size};
}
`,
      solution: `import {Kafka} from 'kafkajs';

const FILE_EVENT_TOPIC = 'file.event';

const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, acks: -1});

function fileEventKey(event: FileEvent): string {
  return event.fileId;
}

function payload(kind: string, event: FileEvent): string {
  return JSON.stringify({
    kind,
    file_id: event.fileId,
    tenant: event.tenant,
    digest: event.digest,
    sniffed_mime: event.sniffedMime,
    size: event.size,
  });
}

async function publish(kind: string, event: FileEvent): Promise<void> {
  await producer.send({topic: FILE_EVENT_TOPIC, messages: [{key: fileEventKey(event), value: payload(kind, event)}]});
}

export async function finalize(upload: Upload, store: ObjectStore): Promise<void> {
  await store.commitMultipart(upload.multipartId);
  await publish('finalized', eventOf(upload));
}

export async function deleteFile(fileId: string, tenant: string, digest: string, store: ObjectStore): Promise<void> {
  await store.deleteObject(fileId);
  await publish('deleted', {fileId, tenant, digest, sniffedMime: '', size: 0});
}

function eventOf(upload: Upload): FileEvent {
  return {
    fileId: upload.fileId,
    tenant: upload.tenant,
    digest: upload.digest,
    sniffedMime: upload.sniffedMime,
    size: upload.size,
  };
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:     kafka.TCP("kafka:9092"),
	Topic:    "file.event",
	Balancer: &kafka.Hash{},
}

func tenantEventKey(event FileEvent) []byte {
	return []byte(event.Tenant)
}

func publishFileEvent(ctx context.Context, kind string, event FileEvent) error {
	// TODO: this draft keys by tenant, publishes before the store commits, and ships the original
	// filename in the payload so consumers can label attachments.
	body, _ := json.Marshal(map[string]any{
		"kind":     kind,
		"file_id":  event.FileID,
		"filename": event.Filename,
		"size":     event.Size,
	})
	return writer.WriteMessages(ctx, kafka.Message{Key: tenantEventKey(event), Value: body})
}

func finalize(ctx context.Context, upload Upload, store ObjectStore) error {
	if err := publishFileEvent(ctx, "finalized", eventOf(upload)); err != nil {
		return err
	}
	return store.CommitMultipart(ctx, upload.MultipartID)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const FileEventTopic = "file.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        FileEventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	Async:        false,
}

func fileEventKey(event FileEvent) []byte {
	return []byte(event.FileID)
}

func payload(kind string, event FileEvent) []byte {
	body, _ := json.Marshal(map[string]any{
		"kind":         kind,
		"file_id":      event.FileID,
		"tenant":       event.Tenant,
		"digest":       event.Digest,
		"sniffed_mime": event.SniffedMime,
		"size":         event.Size,
	})
	return body
}

func publish(ctx context.Context, kind string, event FileEvent) error {
	return writer.WriteMessages(ctx, kafka.Message{Key: fileEventKey(event), Value: payload(kind, event)})
}

func finalize(ctx context.Context, upload Upload, store ObjectStore) error {
	if err := store.CommitMultipart(ctx, upload.MultipartID); err != nil {
		return err
	}
	return publish(ctx, "finalized", eventOf(upload))
}

func deleteFile(ctx context.Context, fileID, tenant, digest string, store ObjectStore) error {
	if err := store.DeleteObject(ctx, fileID); err != nil {
		return err
	}
	return publish(ctx, "deleted", FileEvent{FileID: fileID, Tenant: tenant, Digest: digest})
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object FileEvents {
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")

  val producer = new KafkaProducer[String, String](props)

  def tenantEventKey(event: FileEvent): String = event.tenant

  def publishFileEvent(kind: String, event: FileEvent): Unit =
    // TODO: this draft keys by tenant, publishes before the store commits, and ships the original
    // filename in the payload so consumers can label attachments.
    producer.send(
      new ProducerRecord[String, String](
        "file.event",
        tenantEventKey(event),
        "{\\"kind\\":\\"" + kind + "\\",\\"filename\\":\\"" + event.filename + "\\",\\"size\\":" + event.size + "}"
      )
    )

  def finalizeUpload(upload: Upload, store: ObjectStore): Unit = {
    publishFileEvent("finalized", eventOf(upload))
    store.commitMultipart(upload.multipartId)
  }

  def eventOf(upload: Upload): FileEvent = FileEvent(upload.fileId, upload.tenant, upload.filename, upload.size)
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object FileEvents {
  val FileEventTopic = "file.event"

  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  props.put("enable.idempotence", "true")

  val producer = new KafkaProducer[String, String](props)

  def fileEventKey(event: FileEvent): String = event.fileId

  def payload(kind: String, event: FileEvent): String =
    "{\\"kind\\":\\"" + kind + "\\",\\"file_id\\":\\"" + event.fileId + "\\",\\"tenant\\":\\"" + event.tenant +
      "\\",\\"digest\\":\\"" + event.digest + "\\",\\"sniffed_mime\\":\\"" + event.sniffedMime +
      "\\",\\"size\\":" + event.size + "}"

  def publish(kind: String, event: FileEvent): Unit =
    producer.send(new ProducerRecord[String, String](FileEventTopic, fileEventKey(event), payload(kind, event)))

  def finalizeUpload(upload: Upload, store: ObjectStore): Unit = {
    store.commitMultipart(upload.multipartId)
    publish("finalized", eventOf(upload))
  }

  def deleteFile(fileId: String, tenant: String, digest: String, store: ObjectStore): Unit = {
    store.deleteObject(fileId)
    publish("deleted", FileEvent(fileId, tenant, digest))
  }

  def eventOf(upload: Upload): FileEvent =
    FileEvent(upload.fileId, upload.tenant, upload.digest, upload.sniffedMime, upload.size)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <string>

std::string tenantEventKey(const FileEvent& event) { return event.tenant; }

bool publishFileEvent(const std::string& kind, const FileEvent& event) {
  // TODO: this draft keys by tenant, publishes before the store commits, and ships the original
  // filename in the payload so consumers can label attachments.
  nlohmann::json body = {{"kind", kind}, {"filename", event.filename}, {"size", event.size}};
  const std::string text = body.dump();
  const std::string key = tenantEventKey(event);
  const RdKafka::ErrorCode code = producer->produce("file.event", RdKafka::Topic::PARTITION_UA,
                                                    RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(text.data()),
                                                    text.size(), key.data(), key.size(), 0, nullptr);
  return code == RdKafka::ERR_NO_ERROR;
}

void finalizeUpload(const Upload& upload, ObjectStore& store) {
  publishFileEvent("finalized", eventOf(upload));
  store.commitMultipart(upload.multipart_id);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <string>

const std::string kFileEventTopic = "file.event";

RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
RdKafka::Producer* producer = nullptr;

std::string fileEventKey(const FileEvent& event) { return event.file_id; }

void configure() {
  std::string err;
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  producer = RdKafka::Producer::create(conf, err);
}

std::string payload(const std::string& kind, const FileEvent& event) {
  nlohmann::json body = {
      {"kind", kind},
      {"file_id", event.file_id},
      {"tenant", event.tenant},
      {"digest", event.digest},
      {"sniffed_mime", event.sniffed_mime},
      {"size", event.size},
  };
  return body.dump();
}

bool publish(const std::string& kind, const FileEvent& event) {
  const std::string text = payload(kind, event);
  const std::string key = fileEventKey(event);
  const RdKafka::ErrorCode code = producer->produce(kFileEventTopic, RdKafka::Topic::PARTITION_UA,
                                                    RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(text.data()),
                                                    text.size(), key.data(), key.size(), 0, nullptr);
  return code == RdKafka::ERR_NO_ERROR;
}

void finalizeUpload(const Upload& upload, ObjectStore& store) {
  store.commitMultipart(upload.multipart_id);
  publish("finalized", eventOf(upload));
}

void deleteFile(const std::string& file_id, const std::string& tenant, const std::string& digest, ObjectStore& store) {
  store.deleteObject(file_id);
  publish("deleted", FileEvent{file_id, tenant, digest});
}
`,
    },
  },
  hints: [
    'The partition key decides ordering. Key by the file id and every event for one file is appended to one partition in order; key by the tenant and the same file’s events interleave with other files.',
    'Publish after the commit, not before. A consumer that reacts to "finalized" reads the object; if the event left the producer first, the consumer can race the commit and read a half-written object.',
    'Treat the topic as a public, retained surface. Digests, sniffed types and sizes are safe to keep; the original filename is user text whose extension alone leaks what the tenant is storing.',
  ],
  debrief: `The interviewer is testing whether you treat an event topic as part of the storage contract. The draft looks harmless because one tenant and one file never collide in a demo; under load the tenant key reorders a file's lifecycle and the pre-commit publish lets an index mark a file readable before the bytes exist. The fixes are ordering and content: key by the thing whose order matters, and keep user text out of the payload. Real systems add an outbox row so a broker outage cannot lose the event with the commit, a schema registry so a future producer cannot smuggle a filename back in, and a consumer that updates its index idempotently because \`acks=all\` gives you at-least-once, not exactly-once.`,
};
