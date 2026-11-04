import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'File events keyed by file id, after the change, without the filename',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter is the \`file.event\` publisher: \`emit(kind, key, record)\` produces
\`{type: "file.<kind>", ...record}\` to \`file.event\` under the key it is given;
\`finalize(upload_id)\` calls \`complete\` (step 3) and emits \`finalized\` keyed by the upload id;
\`delete_file(file_id)\` looks the file up, emits \`deleted\` keyed by the file id, then calls
\`store.delete_file\`. Finalize a file and its event shows up; it hides four flaws.

**Failure mode the checks target.** One file's two events travel under two keys, so a consumer can
apply the delete before the finalize; every event copies the tenant's original filename into a
retained topic; a delete is announced before it happens, and again for a file already deleted; and
a lost acknowledgement writes an event twice.

- Every event of a file is keyed by its **file id**.
- The payload is \`type\`, \`file_id\`, \`tenant\`, \`size\`, \`mime\` and \`digest\`: no \`name\`, no
  \`object_key\`.
- \`delete_file\` calls \`store.delete_file\` first and emits only when it returned a record.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent\` with \`acks: -1\`; kafka-go has
  no idempotent producer, so its writer uses \`RequireAll\` and consumers dedupe on file id and type).`,
  sequence: {
    participants: ['Upload API', 'Object store', 'Redis', 'file.event', 'Event consumer'],
    messages: [
      {from: 'Upload API', to: 'Object store', label: 'complete(upload_id) · CommitMultipart', kind: 'sync'},
      {from: 'Upload API', to: 'file.event', label: 'file.finalized · key = file id · acks = all', kind: 'sync'},
      {from: 'Upload API', to: 'Redis', label: 'store.delete_file(file_id) → record', kind: 'sync'},
      {from: 'Upload API', to: 'file.event', label: 'file.deleted · key = file id', kind: 'sync'},
      {
        from: 'file.event',
        to: 'Event consumer',
        label: 'one partition per file: finalized, then deleted',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'file-key',
      title: 'Keys every event by the file id',
      detail:
        'Each record\'s key is the file id from the record (`key=record["file_id"]`), so a file\'s finalize and delete land on one partition in order; a key chosen by the caller (the upload id on finalize) splits one file across two.',
      match: {
        python: {all: [/key=record\[["']file_id["']\]/], none: [/key=key\b/, /emit\([^)\n]*upload_id/]},
        typescript: {all: [/key:\s*record\.file_id/], none: [/key:\s*key\b/, /emit\([^)\n]*uploadId/]},
        go: {all: [/Key:\s*\[\]byte\(record\.FileID\)/], none: [/Key:\s*\[\]byte\(key\)/, /emit\([^)\n]*uploadID/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(EventTopic,\s*record\.fileId/],
          none: [/EventTopic,\s*key\b/, /emit\([^)\n]*uploadId/],
        },
        cpp: {
          all: [/record\.file_id\.c_str\(\),\s*record\.file_id\.(size|length)\(\)/],
          none: [/key\.c_str\(\)/, /emit\([^)\n]*upload_id/],
        },
      },
    },
    {
      id: 'no-filename',
      title: 'Carries ids, digest, type and size, never the filename',
      detail:
        'The payload is built from `PAYLOAD_FIELDS` (`file_id`, `tenant`, `size`, `mime`, `digest`); copying the whole record puts the original filename, user text, into a topic that is retained and replicated.',
      match: {
        python: {all: [/PAYLOAD_FIELDS\s*=/, /for \w+ in PAYLOAD_FIELDS/], none: [/\*\*record/]},
        typescript: {all: [/PAYLOAD_FIELDS\s*=/, /PAYLOAD_FIELDS\.map\(/], none: [/\.\.\.record/]},
        go: {all: [/payloadFields\s*=/, /range payloadFields|record\.Digest/]},
        scala: {all: [/PayloadFields\s*[:=]/, /PayloadFields\.map/]},
        cpp: {all: [/\{"digest",\s*record\.digest\}/], none: [/record\.name\b/, /record\.object_key/]},
      },
    },
    {
      id: 'delete-after-commit',
      title: 'Announces a delete after it happened, and once',
      detail:
        '`delete_file` calls `store.delete_file` first and emits `deleted` only when it returned a record; emitting first announces a delete that may not happen and re-announces a file already deleted.',
      match: {
        python: {order: [/def delete_file/, /store\.delete_file\(/, /emit\(\s*["']deleted["']/]},
        typescript: {order: [/function deleteFile/, /store\.deleteFile\(/, /emit\(\s*['"]deleted['"]/]},
        go: {order: [/func deleteFile/, /store\.DeleteFile\(/, /emit\([^\n]*"deleted"/]},
        scala: {order: [/def deleteFile/, /Store\.deleteFile\(/, /emit\(\s*"deleted"/]},
        cpp: {order: [/delete_file\(const std::string& file_id\)/, /store::deleteFile\(/, /emit\(\s*"deleted"/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` plus `acks`, kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the record once; kafka-go has no idempotent producer, so its writer uses `RequireAll`.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from client import complete  # step 3
from files import store  # store.delete_file, find_file

EVENT_TOPIC = "file.event"
log = logging.getLogger("events")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("file event not delivered: %s", err)


def emit(kind: str, key: str, record: dict) -> dict:
    """One file.event record for a file that was finalized or deleted."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = {"type": f"file.{kind}", **record}
    producer.produce(EVENT_TOPIC, key=key, value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(5.0)
    return payload


def finalize(upload_id: str) -> dict:
    """Commit the upload (step 3) and announce the file; the file record."""
    record = complete(upload_id)
    emit("finalized", upload_id, record)
    return record


def delete_file(file_id: str) -> dict | None:
    """Delete a committed file and announce it; the deleted record, or None when there was nothing to delete."""
    record = store.find_file(file_id)
    if record is None:
        return None
    emit("deleted", file_id, record)
    return store.delete_file(file_id)
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from client import complete  # step 3
from files import store  # store.delete_file, find_file

EVENT_TOPIC = "file.event"
# Ids, the digest, the sniffed type and the size; the filename and the object key stay in the index.
PAYLOAD_FIELDS = ("file_id", "tenant", "size", "mime", "digest")
log = logging.getLogger("events")

# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("file event not delivered: %s", err)


def emit(kind: str, record: dict) -> dict:
    """One file.event record for a file that was finalized or deleted."""
    payload = {"type": f"file.{kind}", **{name: record[name] for name in PAYLOAD_FIELDS}}
    # Keyed by the file: its finalize and its delete share a partition, in order.
    producer.produce(EVENT_TOPIC, key=record["file_id"], value=json.dumps(payload), on_delivery=on_delivery)
    producer.flush(5.0)
    return payload


def finalize(upload_id: str) -> dict:
    """Commit the upload (step 3) and announce the file; the file record."""
    record = complete(upload_id)
    emit("finalized", record)
    return record


def delete_file(file_id: str) -> dict | None:
    """Delete a committed file and announce it; the deleted record, or None when there was nothing to delete."""
    record = store.delete_file(file_id)
    if record is None:
        return None  # nothing changed: nothing to announce
    emit("deleted", record)
    return record
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {complete} from './client'; // step 3
import * as store from 'files/store'; // deleteFile, findFile

export const EVENT_TOPIC = 'file.event';

const kafka = new Kafka({clientId: 'stored', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** One file.event record for a file that was finalized or deleted. */
export async function emit(kind: string, key: string, record: store.FileRecord): Promise<Record<string, unknown>> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = {type: \`file.\${kind}\`, ...record};
  await producer.send({topic: EVENT_TOPIC, messages: [{key, value: JSON.stringify(payload)}], acks: 1});
  return payload;
}

/** Commit the upload (step 3) and announce the file; the file record. */
export async function finalize(uploadId: string): Promise<store.FileRecord> {
  const record = await complete(uploadId);
  await emit('finalized', uploadId, record);
  return record;
}

/** Delete a committed file and announce it; the deleted record, or null when there was nothing to delete. */
export async function deleteFile(fileId: string): Promise<store.FileRecord | null> {
  const record = await store.findFile(fileId);
  if (record === null) return null;
  await emit('deleted', fileId, record);
  return store.deleteFile(fileId);
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {complete} from './client'; // step 3
import * as store from 'files/store'; // deleteFile, findFile

export const EVENT_TOPIC = 'file.event';
// Ids, the digest, the sniffed type and the size; the filename and the object key stay in the index.
export const PAYLOAD_FIELDS = ['file_id', 'tenant', 'size', 'mime', 'digest'] as const;

const kafka = new Kafka({clientId: 'stored', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the record once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One file.event record for a file that was finalized or deleted. */
export async function emit(kind: string, record: store.FileRecord): Promise<Record<string, unknown>> {
  const payload = {type: \`file.\${kind}\`, ...Object.fromEntries(PAYLOAD_FIELDS.map(name => [name, record[name]]))};
  // Keyed by the file: its finalize and its delete share a partition, in order.
  await producer.send({topic: EVENT_TOPIC, messages: [{key: record.file_id, value: JSON.stringify(payload)}], acks: -1});
  return payload;
}

/** Commit the upload (step 3) and announce the file; the file record. */
export async function finalize(uploadId: string): Promise<store.FileRecord> {
  const record = await complete(uploadId);
  await emit('finalized', record);
  return record;
}

/** Delete a committed file and announce it; the deleted record, or null when there was nothing to delete. */
export async function deleteFile(fileId: string): Promise<store.FileRecord | null> {
  const record = await store.deleteFile(fileId);
  if (record === null) return null; // nothing changed: nothing to announce
  await emit('deleted', record);
  return record;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/segmentio/kafka-go"

	"files/store" // store.DeleteFile, FindFile, File
)

const eventTopic = "file.event"

// Built in step 3 (client.go): writes the parts, commits the multipart upload and indexes the file.
var complete = func(ctx context.Context, uploadID string) (*store.File, error) {
	return nil, errors.New("complete is built in step 3 (client.go)")
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// emit produces one file.event record for a file that was finalized or deleted.
func emit(ctx context.Context, kind, key string, record *store.File) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	raw, _ := json.Marshal(record)
	payload := map[string]any{}
	json.Unmarshal(raw, &payload)
	payload["type"] = "file." + kind
	value, _ := json.Marshal(payload)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}

// finalize commits the upload (step 3) and announces the file; the file record.
func finalize(ctx context.Context, uploadID string) (*store.File, error) {
	record, err := complete(ctx, uploadID)
	if err != nil {
		return nil, err
	}
	if _, err := emit(ctx, "finalized", uploadID, record); err != nil {
		return nil, err
	}
	return record, nil
}

// deleteFile deletes a committed file and announces it; the deleted record, or nil when there was nothing to delete.
func deleteFile(ctx context.Context, fileID string) (*store.File, error) {
	record := store.FindFile(ctx, fileID)
	if record == nil {
		return nil, nil
	}
	if _, err := emit(ctx, "deleted", fileID, record); err != nil {
		return nil, err
	}
	return store.DeleteFile(ctx, fileID), nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/segmentio/kafka-go"

	"files/store" // store.DeleteFile, FindFile, File
)

const eventTopic = "file.event"

// payloadFields: ids, the digest, the sniffed type and the size; the filename and the object key stay in the index.
var payloadFields = []string{"file_id", "tenant", "size", "mime", "digest"}

// Built in step 3 (client.go): writes the parts, commits the multipart upload and indexes the file.
var complete = func(ctx context.Context, uploadID string) (*store.File, error) {
	return nil, errors.New("complete is built in step 3 (client.go)")
}

// RequireAll: the record is on every replica before the write returns. kafka-go has no idempotent
// producer, so a retry after a lost acknowledgement can duplicate; consumers dedupe on file id and type.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// emit produces one file.event record for a file that was finalized or deleted.
func emit(ctx context.Context, kind string, record *store.File) (map[string]any, error) {
	raw, _ := json.Marshal(record)
	all := map[string]any{}
	json.Unmarshal(raw, &all)
	payload := map[string]any{"type": "file." + kind}
	for _, name := range payloadFields {
		payload[name] = all[name]
	}
	value, _ := json.Marshal(payload)
	// Keyed by the file: its finalize and its delete share a partition, in order.
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(record.FileID), Value: value}); err != nil {
		return nil, err
	}
	return payload, nil
}

// finalize commits the upload (step 3) and announces the file; the file record.
func finalize(ctx context.Context, uploadID string) (*store.File, error) {
	record, err := complete(ctx, uploadID)
	if err != nil {
		return nil, err
	}
	if _, err := emit(ctx, "finalized", record); err != nil {
		return nil, err
	}
	return record, nil
}

// deleteFile deletes a committed file and announces it; the deleted record, or nil when there was nothing to delete.
func deleteFile(ctx context.Context, fileID string) (*store.File, error) {
	record := store.DeleteFile(ctx, fileID)
	if record == nil {
		return nil, nil // nothing changed: nothing to announce
	}
	if _, err := emit(ctx, "deleted", record); err != nil {
		return nil, err
	}
	return record, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import files.Store // Store.deleteFile, findFile, File

object Events {
  val EventTopic = "file.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"file event not delivered: \${exception.getMessage}")
  }

  /** One file.event record for a file that was finalized or deleted. */
  def emit(kind: String, key: String, record: Store.File): JsObject = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "type" -> JsString(s"file.$kind"), "file_id" -> JsString(record.fileId), "upload_id" -> JsString(record.uploadId),
      "tenant" -> JsString(record.tenant), "name" -> JsString(record.name), "mime" -> JsString(record.mime),
      "size" -> JsNumber(record.size), "digest" -> JsString(record.digest), "object_key" -> JsString(record.objectKey))
    producer.send(new ProducerRecord[String, String](EventTopic, key, payload.compactPrint), onDelivery).get()
    payload
  }

  /** Commit the upload (step 3) and announce the file; the file record. */
  def finalize(uploadId: String): Store.File = {
    val record = Client.complete(uploadId)
    emit("finalized", uploadId, record)
    record
  }

  /** Delete a committed file and announce it; the deleted record, or None when there was nothing to delete. */
  def deleteFile(fileId: String): Option[Store.File] =
    Store.findFile(fileId).flatMap { record =>
      emit("deleted", fileId, record)
      Store.deleteFile(fileId)
    }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import files.Store // Store.deleteFile, findFile, File

object Events {
  val EventTopic = "file.event"
  /** Ids, the digest, the sniffed type and the size; the filename and the object key stay in the index. */
  val PayloadFields: Seq[String] = Seq("file_id", "tenant", "size", "mime", "digest")

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"file event not delivered: \${exception.getMessage}")
  }

  private def field(record: Store.File, name: String): JsValue = name match {
    case "file_id" => JsString(record.fileId)
    case "tenant" => JsString(record.tenant)
    case "size" => JsNumber(record.size)
    case "mime" => JsString(record.mime)
    case "digest" => JsString(record.digest)
  }

  /** One file.event record for a file that was finalized or deleted. */
  def emit(kind: String, record: Store.File): JsObject = {
    val payload = JsObject((("type" -> JsString(s"file.$kind")) +: PayloadFields.map(name => name -> field(record, name))).toMap)
    // Keyed by the file: its finalize and its delete share a partition, in order.
    producer.send(new ProducerRecord[String, String](EventTopic, record.fileId, payload.compactPrint), onDelivery).get()
    payload
  }

  /** Commit the upload (step 3) and announce the file; the file record. */
  def finalize(uploadId: String): Store.File = {
    val record = Client.complete(uploadId)
    emit("finalized", record)
    record
  }

  /** Delete a committed file and announce it; the deleted record, or None when there was nothing to delete. */
  def deleteFile(fileId: String): Option[Store.File] =
    Store.deleteFile(fileId).map { record => // None: nothing changed, nothing to announce
      emit("deleted", record)
      record
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "files/store.h"  // store::deleteFile, findFile, File

using json = nlohmann::json;

const std::string kEventTopic = "file.event";

// Built in step 3 (client.cpp): writes the parts, commits the multipart upload and indexes the file.
store::File complete(const std::string& upload_id);

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "file event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One file.event record for a file that was finalized or deleted.
json emit(const std::string& kind, const std::string& key, const store::File& record) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json payload = {{"type", "file." + kind}, {"file_id", record.file_id}, {"upload_id", record.upload_id},
                        {"tenant", record.tenant},  {"name", record.name},       {"mime", record.mime},
                        {"size", record.size},      {"digest", record.digest},   {"object_key", record.object_key}};
  const std::string value = payload.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), key.c_str(), key.size(), 0, nullptr);
  producer->flush(5000);
  return payload;
}

// Commit the upload (step 3) and announce the file; the file record.
store::File finalize(const std::string& upload_id) {
  const store::File record = complete(upload_id);
  emit("finalized", upload_id, record);
  return record;
}

// Delete a committed file and announce it; the deleted record, or none when there was nothing to delete.
std::optional<store::File> delete_file(const std::string& file_id) {
  const auto record = store::findFile(file_id);
  if (!record) return std::nullopt;
  emit("deleted", file_id, *record);
  return store::deleteFile(file_id);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "files/store.h"  // store::deleteFile, findFile, File

using json = nlohmann::json;

const std::string kEventTopic = "file.event";
// Built in step 3 (client.cpp): writes the parts, commits the multipart upload and indexes the file.
store::File complete(const std::string& upload_id);

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "file event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One file.event record for a file that was finalized or deleted. Ids, the digest, the sniffed type and
// the size; the filename and the object key stay in the index.
json emit(const std::string& kind, const store::File& record) {
  const json payload = {{"type", "file." + kind}, {"file_id", record.file_id}, {"tenant", record.tenant},
                        {"size", record.size},    {"mime", record.mime},       {"digest", record.digest}};
  const std::string value = payload.dump();
  // Keyed by the file: its finalize and its delete share a partition, in order.
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), record.file_id.c_str(), record.file_id.size(), 0, nullptr);
  producer->flush(5000);
  return payload;
}

// Commit the upload (step 3) and announce the file; the file record.
store::File finalize(const std::string& upload_id) {
  const store::File record = complete(upload_id);
  emit("finalized", record);
  return record;
}

// Delete a committed file and announce it; the deleted record, or none when there was nothing to delete.
std::optional<store::File> delete_file(const std::string& file_id) {
  const auto record = store::deleteFile(file_id);
  if (!record) return std::nullopt;  // nothing changed: nothing to announce
  emit("deleted", *record);
  return record;
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

import file_storage_pb2
import file_storage_pb2_grpc
from files import sessions, store

TOPIC = "file.event"
NAME = "passport-scan-2026.png"
DATA = b"\\x89PNG\\r\\n\\x1a\\n" + bytes(24)


class ObjectStore(file_storage_pb2_grpc.ObjectStoreServicer):
    def __init__(self):
        self.parts = {}

    def PutChunk(self, request, context):
        self.parts[(request.upload_id, request.part)] = request.data
        return file_storage_pb2.PutChunkReply(part=request.part)

    def CommitMultipart(self, request, context):
        data = b"".join(self.parts[(request.upload_id, n)] for n in request.parts)
        return file_storage_pb2.CommitReply(object_key=f"objects/{request.upload_id}", digest=hashlib.sha256(data).hexdigest(), size=len(data))


def _events(ctx):
    ctx.grpc.serve(file_storage_pb2_grpc.add_ObjectStoreServicer_to_server, ObjectStore())
    return ctx.load("events")


def _finalized(m):
    upload_id = sessions.open_session("t1", len(DATA), "image/png", NAME)
    store.stage_part(upload_id, 1, DATA)
    sessions.ack_part(upload_id, 1, len(DATA))
    record = m.finalize(upload_id)
    assert record["state"] == "committed", f"finalize must answer the committed record, got {record}"
    return record


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_file_key(ctx):
    m = _events(ctx)
    file_id = _finalized(m)["file_id"]
    assert m.delete_file(file_id) is not None, f"deleting the committed file {file_id} must answer its record"
    records = ctx.kafka.records(TOPIC)
    types = [_payload(r).get("type") for r in records]
    assert types == ["file.finalized", "file.deleted"], f"a finalize and a delete produced {types} on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [file_id.encode()] * 2, f"the file's two events were keyed {keys}: keyed by anything but the file id, one file's lifecycle splits across partitions and a consumer can see the delete first"
    assert records[0].partition == records[1].partition, f"{file_id}'s events landed on partitions {records[0].partition} and {records[1].partition}"


def check_no_filename(ctx):
    m = _events(ctx)
    record = _finalized(m)
    raw = ctx.kafka.records(TOPIC)[0].value
    payload = _payload(ctx.kafka.records(TOPIC)[0])
    assert NAME.encode() not in raw and "name" not in payload, f"the event carries the original filename: {payload}. It is user text in a retained, replicated topic; keep it in the index"
    expected = {"type": "file.finalized", "file_id": record["file_id"], "tenant": "t1", "size": len(DATA), "mime": "image/png", "digest": record["digest"]}
    assert payload == expected, f"the finalized event is {payload}, expected exactly {expected}"


def check_delete_after_commit(ctx):
    m = _events(ctx)
    file_id = _finalized(m)["file_id"]
    # The moment the delete gives the bytes back to the quota, what is already on the topic.
    at_delete = ctx.redis_after("quota:used:t1", lambda: len(ctx.kafka.records(TOPIC)))
    assert m.delete_file(file_id) is not None, f"deleting the committed file {file_id} must answer its record"
    assert at_delete.fired, "delete_file never released the file's quota: it must go through store.delete_file"
    assert at_delete.result == 1, f"when the delete happened the topic already held {at_delete.result} records: the deleted event went out before the delete. Delete, then emit"
    again = m.delete_file(file_id)
    records = ctx.kafka.records(TOPIC)
    assert again is None and len(records) == 2, f"deleting {file_id} a second time answered {again} and left {len(records)} records: a delete that changed nothing must not be announced"
    assert m.delete_file("f-404") is None and len(ctx.kafka.records(TOPIC)) == 2, "deleting a file that does not exist must answer None and emit nothing"


def check_idempotent_producer(ctx):
    m = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    file_id = _finalized(m)["file_id"]
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one finalize whose acknowledgement was lost left {len(records)} records on the topic: the producer's retry wrote the event twice. Enable idempotence (with acks=all)"
    m.delete_file(file_id)
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 2, f"after a leader failover the topic holds {len(ctx.kafka.records(TOPIC))} records, expected 2: with acks=1 the leader alone acknowledged the delete event and lost it. Use acks=all"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'file.event';
const NAME = 'passport-scan-2026.png';
const DATA = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);

function events(ctx) {
  const pkg = ctx.proto('file_storage.proto');
  const parts = new Map<string, Buffer>();
  ctx.grpc.serve(pkg.stored.ObjectStore.service, {
    PutChunk(call, callback) {
      parts.set(\`\${call.request.upload_id}/\${call.request.part}\`, Buffer.from(call.request.data));
      callback(null, {part: call.request.part, deduped: false});
    },
    CommitMultipart(call, callback) {
      const data = Buffer.concat(call.request.parts.map(n => parts.get(\`\${call.request.upload_id}/\${n}\`) as Buffer));
      callback(null, {object_key: \`objects/\${call.request.upload_id}\`, digest: createHash('sha256').update(data).digest('hex'), size: data.length});
    },
  });
  return {m: ctx.load('events'), store: ctx.load('/support/files/store.ts'), sessions: ctx.load('/support/files/sessions.ts')};
}

async function finalized({m, store, sessions}) {
  const uploadId = await sessions.openSession('t1', DATA.length, 'image/png', NAME);
  await store.stagePart(uploadId, 1, DATA);
  await sessions.ackPart(uploadId, 1, DATA.length);
  const record = await m.finalize(uploadId);
  assert.equal(record.state, 'committed', \`finalize must answer the committed record, got \${JSON.stringify(record)}\`);
  return record;
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_file_key(ctx) {
  const e = events(ctx);
  const {file_id} = await finalized(e);
  assert((await e.m.deleteFile(file_id)) !== null, \`deleting the committed file \${file_id} must answer its record\`);
  const records = ctx.kafka.records(TOPIC);
  const types = records.map(r => payload(r).type);
  assert.deepStrictEqual(types, ['file.finalized', 'file.deleted'], \`a finalize and a delete produced \${JSON.stringify(types)} on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, [file_id, file_id], \`the file's two events were keyed \${JSON.stringify(keys)}: keyed by anything but the file id, one file's lifecycle splits across partitions and a consumer can see the delete first\`);
  assert.equal(records[0].partition, records[1].partition, \`\${file_id}'s events landed on two partitions\`);
}

export async function check_no_filename(ctx) {
  const e = events(ctx);
  const record = await finalized(e);
  const raw = ctx.kafka.records(TOPIC)[0].value.toString();
  const p = payload(ctx.kafka.records(TOPIC)[0]);
  assert(!raw.includes(NAME) && !('name' in p), \`the event carries the original filename: \${raw}. It is user text in a retained, replicated topic; keep it in the index\`);
  const expected = {type: 'file.finalized', file_id: record.file_id, tenant: 't1', size: DATA.length, mime: 'image/png', digest: record.digest};
  const sorted = (o: object) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  assert.equal(sorted(p), sorted(expected), \`the finalized event is \${raw}, expected exactly \${JSON.stringify(expected)}\`);
}

export async function check_delete_after_commit(ctx) {
  const e = events(ctx);
  const {file_id} = await finalized(e);
  // The moment the delete gives the bytes back to the quota, what is already on the topic.
  const atDelete = ctx.redisAfter('quota:used:t1', () => ctx.kafka.records(TOPIC).length);
  assert((await e.m.deleteFile(file_id)) !== null, \`deleting the committed file \${file_id} must answer its record\`);
  assert(atDelete.fired, "deleteFile never released the file's quota: it must go through store.deleteFile");
  assert.equal(atDelete.result, 1, \`when the delete happened the topic already held \${atDelete.result} records: the deleted event went out before the delete. Delete, then emit\`);
  const again = await e.m.deleteFile(file_id);
  const records = ctx.kafka.records(TOPIC);
  assert(again === null && records.length === 2, \`deleting \${file_id} a second time answered \${JSON.stringify(again)} and left \${records.length} records: a delete that changed nothing must not be announced\`);
  assert((await e.m.deleteFile('f-404')) === null && ctx.kafka.records(TOPIC).length === 2, 'deleting a file that does not exist must answer null and emit nothing');
}

export async function check_idempotent_producer(ctx) {
  const e = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  const {file_id} = await finalized(e);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one finalize whose acknowledgement was lost left \${records.length} records on the topic: the producer's retry wrote the event twice. Make the producer idempotent (acks -1)\`);
  await e.m.deleteFile(file_id);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: with acks 1 the leader alone acknowledged the delete event and lost it. Use acks -1 (all)\`);
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"files/sessions"
	"files/store"

	"leetbuild/harness"
)

const (
	topic    = "file.event"
	fileName = "passport-scan-2026.png"
)

var (
	eventsBg = context.Background()
	pngData  = append([]byte("\\x89PNG\\r\\n\\x1a\\n"), make([]byte, 24)...)
)

// finalized uploads one part and finalizes it; complete (step 3) stands in as a store that commits at once.
func finalized(ctx *harness.Ctx) *store.File {
	complete = func(c context.Context, uploadID string) (*store.File, error) {
		parts, err := store.StagedParts(c, uploadID)
		if err != nil {
			return nil, err
		}
		var data []byte
		for _, p := range parts {
			data = append(data, p.Data...)
		}
		sum := sha256.Sum256(data)
		return store.CommitFile(c, uploadID, "objects/"+uploadID, hex.EncodeToString(sum[:]))
	}
	uploadID, err := sessions.OpenSession(eventsBg, "t1", int64(len(pngData)), "image/png", fileName)
	ctx.NoError(err, "OpenSession failed")
	store.StagePart(eventsBg, uploadID, 1, pngData)
	sessions.AckPart(eventsBg, uploadID, 1, int64(len(pngData)))
	record, err := finalize(eventsBg, uploadID)
	ctx.NoError(err, "finalize(%s) failed", uploadID)
	ctx.Assert(record != nil && record.State == "committed", "finalize must answer the committed record, got %+v", record)
	return record
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func mustDelete(ctx *harness.Ctx, fileID string) *store.File {
	record, err := deleteFile(eventsBg, fileID)
	ctx.NoError(err, "deleteFile(%s) failed", fileID)
	return record
}

func CheckFileKey(ctx *harness.Ctx) {
	fileID := finalized(ctx).FileID
	ctx.Assert(mustDelete(ctx, fileID) != nil, "deleting the committed file %s must answer its record", fileID)
	records := ctx.Kafka.Records(topic)
	var types []string
	for _, r := range records {
		t, _ := payloadOf(ctx, r.Value)["type"].(string)
		types = append(types, t)
	}
	ctx.Equal(types, []string{"file.finalized", "file.deleted"}, "a finalize and a delete; the event types on %s", topic)
	ctx.Equal(ctx.Kafka.Keys(topic), []string{fileID, fileID}, "the file's two events must be keyed by the file id (keyed by anything else, one file's lifecycle splits across partitions and a consumer can see the delete first)")
	ctx.Assert(records[0].Partition == records[1].Partition, "%s's events landed on partitions %d and %d", fileID, records[0].Partition, records[1].Partition)
}

func CheckNoFilename(ctx *harness.Ctx) {
	record := finalized(ctx)
	raw := ctx.Kafka.Records(topic)[0].Value
	p := payloadOf(ctx, raw)
	_, named := p["name"]
	ctx.Assert(!bytes.Contains(raw, []byte(fileName)) && !named, "the event carries the original filename: %s. It is user text in a retained, replicated topic; keep it in the index", raw)
	expected := map[string]any{"type": "file.finalized", "file_id": record.FileID, "tenant": "t1", "size": float64(len(pngData)), "mime": "image/png", "digest": record.Digest}
	ctx.Equal(p, expected, "the finalized event must carry exactly the type, ids, size, mime and digest")
}

func CheckDeleteAfterCommit(ctx *harness.Ctx) {
	fileID := finalized(ctx).FileID
	// The moment the delete gives the bytes back to the quota, what is already on the topic.
	atDelete := ctx.Redis.After("quota:used:t1", func() any { return len(ctx.Kafka.Records(topic)) })
	ctx.Assert(mustDelete(ctx, fileID) != nil, "deleting the committed file %s must answer its record", fileID)
	ctx.Assert(atDelete.Fired, "deleteFile never released the file's quota: it must go through store.DeleteFile")
	ctx.Equal(atDelete.Result, 1, "when the delete happened the deleted event must not be out yet (delete, then emit); the records at the delete")
	again := mustDelete(ctx, fileID)
	ctx.Assert(again == nil && len(ctx.Kafka.Records(topic)) == 2, "deleting %s a second time answered %+v and left %d records: a delete that changed nothing must not be announced", fileID, again, len(ctx.Kafka.Records(topic)))
	ctx.Assert(mustDelete(ctx, "f-404") == nil && len(ctx.Kafka.Records(topic)) == 2, "deleting a file that does not exist must answer nil and emit nothing")
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	fileID := finalized(ctx).FileID
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "one finalize, the records on the topic")
	mustDelete(ctx, fileID)
	lost := ctx.Kafka.Failover(topic)
	ctx.Equal(len(ctx.Kafka.Records(topic)), 2, "after a leader failover %d record(s) were lost: with RequireOne the leader alone acknowledged the event. Use RequireAll; the records on the topic", lost)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "client.cpp"
#include "file_storage.grpc.pb.h"
#include "files/sessions.h"
#include "files/store.h"

using json = nlohmann::json;

namespace {

const std::string kTopic = "file.event";
const std::string kName = "passport-scan-2026.png";
const std::string kData = std::string("\\x89PNG\\r\\n\\x1a\\n", 8) + std::string(24, '\\0');

class ObjectStorePeer final : public stored::ObjectStore::Service {
 public:
  std::map<std::string, std::string> parts;

  grpc::Status PutChunk(grpc::ServerContext*, const stored::PutChunkRequest* req, stored::PutChunkReply* reply) override {
    parts[req->upload_id() + "/" + std::to_string(req->part())] = req->data();
    reply->set_part(req->part());
    return grpc::Status::OK;
  }

  grpc::Status CommitMultipart(grpc::ServerContext*, const stored::CommitRequest* req, stored::CommitReply* reply) override {
    std::string data;
    for (int n : req->parts()) data += parts[req->upload_id() + "/" + std::to_string(n)];
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(data.data()), data.size(), digest);
    std::string hex;
    char byte[3];
    for (unsigned char b : digest) {
      std::snprintf(byte, sizeof byte, "%02x", b);
      hex += byte;
    }
    reply->set_object_key("objects/" + req->upload_id());
    reply->set_digest(hex);
    reply->set_size(static_cast<long long>(data.size()));
    return grpc::Status::OK;
  }
};

store::File finalized(harness::Ctx& ctx) {
  static ObjectStorePeer* peer = nullptr;
  delete peer;
  peer = new ObjectStorePeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  const std::string upload_id = sessions::openSession("t1", static_cast<long long>(kData.size()), "image/png", kName).value_or("");
  store::stagePart(upload_id, 1, kData);
  sessions::ackPart(upload_id, 1, static_cast<long long>(kData.size()));
  try {
    const store::File record = finalize(upload_id);
    ctx.Equal(record.state, "committed", "finalize must answer the committed record; its state");
    return record;
  } catch (const std::exception& e) {
    ctx.Fatalf("finalize(%s) threw %s: %s", upload_id, harness::CurrentExceptionType(), e.what());
  }
}

json payloadOf(harness::Ctx& ctx, const harness::KafkaRecord& record) {
  try {
    return json::parse(record.Value.value_or(""));
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", record.Value.value_or(""), e.what());
  }
}

}  // namespace

void CheckFileKey(harness::Ctx& ctx) {
  const std::string file_id = finalized(ctx).file_id;
  ctx.Assert(delete_file(file_id).has_value(), "deleting the committed file %s must answer its record", file_id);
  const auto records = ctx.Kafka.Records(kTopic);
  std::vector<std::string> types;
  for (const auto& r : records) types.push_back(payloadOf(ctx, r).value("type", ""));
  ctx.Equal(types, {"file.finalized", "file.deleted"}, "a finalize and a delete; the event types on %s", kTopic);
  ctx.Equal(ctx.Kafka.Keys(kTopic), {file_id, file_id}, "the file's two events must be keyed by the file id (keyed by anything else, one file's lifecycle splits across partitions and a consumer can see the delete first)");
  ctx.Assert(records[0].Partition == records[1].Partition, "%s's events landed on partitions %d and %d", file_id, records[0].Partition, records[1].Partition);
}

void CheckNoFilename(harness::Ctx& ctx) {
  const store::File record = finalized(ctx);
  const auto first = ctx.Kafka.Records(kTopic)[0];
  const std::string raw = first.Value.value_or("");
  const json p = payloadOf(ctx, first);
  ctx.Assert(raw.find(kName) == std::string::npos && !p.contains("name"), "the event carries the original filename: %s. It is user text in a retained, replicated topic; keep it in the index", raw);
  const json expected = {{"type", "file.finalized"}, {"file_id", record.file_id}, {"tenant", "t1"}, {"size", kData.size()}, {"mime", "image/png"}, {"digest", record.digest}};
  ctx.Equal(p, expected, "the finalized event must carry exactly the type, ids, size, mime and digest");
}

void CheckDeleteAfterCommit(harness::Ctx& ctx) {
  const std::string file_id = finalized(ctx).file_id;
  // The moment the delete gives the bytes back to the quota, what is already on the topic.
  int atDelete = -1;
  ctx.Redis.After("quota:used:t1", [&] { atDelete = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  ctx.Assert(delete_file(file_id).has_value(), "deleting the committed file %s must answer its record", file_id);
  ctx.Assert(atDelete >= 0, "delete_file never released the file's quota: it must go through store::deleteFile");
  ctx.Equal(atDelete, 1, "when the delete happened the deleted event must not be out yet (delete, then emit); the records at the delete");
  const auto again = delete_file(file_id);
  ctx.Assert(!again && ctx.Kafka.Records(kTopic).size() == 2, "deleting %s a second time left %d records: a delete that changed nothing must not be announced", file_id, ctx.Kafka.Records(kTopic).size());
  ctx.Assert(!delete_file("f-404") && ctx.Kafka.Records(kTopic).size() == 2, "deleting a file that does not exist must answer nothing and emit nothing");
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kTopic, 1);
  const std::string file_id = finalized(ctx).file_id;
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one finalize whose acknowledgement was lost: the producer's retry wrote the event twice. Set enable.idempotence (with acks=all); the records on the topic");
  delete_file(file_id);
  const int lost = ctx.Kafka.Failover(kTopic);
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 2, "after a leader failover %d record(s) were lost: with acks=1 the leader alone acknowledged the event. Use acks=all; the records on the topic", lost);
}
`,
  },
  hints: [
    "Finalize a file, delete it, and read the topic: the two events carry different keys, both carry the tenant's filename, and deleting the same file twice announces it twice.",
    'The caller picks the key, and finalize passes the upload id. The payload spreads the whole record, filename and object key included. The deleted event is produced from a lookup, before `store.delete_file` decides whether anything was deleted.',
    'Key by `record["file_id"]` inside `emit`, build the payload from `PAYLOAD_FIELDS`, call `store.delete_file` first and emit only when it returned a record, and set `enable.idempotence` with `acks=all`.',
  ],
  debrief: `An event is a statement about state that already changed, which is why the delete runs first and a delete that changed nothing announces nothing. The key comes from the record rather than the caller because ordering only matters per file, and the file id is the one name both ends of its life share. The payload is a fixed list of fields because the topic outlives every rule the index has about who may read a filename, so user text stays where it can be deleted. Idempotence with \`acks=all\` makes a retry after a lost acknowledgement write the record once on every replica. A production service would write the event to an outbox in the same transaction as the index change and let a relay produce it, so a broker outage delays events instead of losing them.`,
};
