import type {Step} from '@/lib/types';

export const skuIntakeStep: Step = {
  id: 'sku-intake',
  title: 'sku.upserted: validate, content-hash, enqueue, then commit',
  concept: 'kafka',
  file: 'sku_intake',
  focus: ['feed', 'upserted', 'catalogd', 'redis', 'extract'],
  task: `## Task

**Starting point.** The starter is the intake consumer. \`consume()\` reads \`sku.upserted\` in group
\`catalog-enrichment\` with auto-commit on and commits each record as soon as it arrives; \`intake\`
parses it, skips a SKU whose id is in an in-memory \`seen\` set, and \`send\`s the job
\`{sku_id, merchant, title, description, images}\` to \`sku.extract\` without a key. It moves records
in the demo and hides 4 flaws.

**Failure mode the checks target.** One record that is not JSON stops the merchant's partition; a
merchant's jobs scatter over partitions; a re-sent feed is extracted again after every restart while
a changed title is skipped; and a job the broker refused is lost because its offset was committed
first.

- A record that is not a JSON object, lacks \`merchant\`, \`sku_id\` or a non-blank \`title\`, has a title
  over \`MAX_TITLE_BYTES\` (4096), a description over 16 KiB or more than 8 image refs goes to
  \`sku.upserted.dlq\` with a \`reason\` header, and is committed.
- The job carries \`content_hash = store.content_hash(...)\`; a SKU whose hash equals
  \`store.last_hash(sku_id)\` is skipped; \`store.put_hash\` runs after the job is on \`sku.extract\`.
- The job's key is the merchant.
- Auto-commit off; the offset is committed after \`intake\` returns. \`send\` raises when the broker
  refuses the record, which leaves the offset for the redelivery.`,
  sequence: {
    participants: ['sku.upserted', 'catalogd', 'Redis', 'sku.extract'],
    messages: [
      {from: 'sku.upserted', to: 'catalogd', label: 'poll · group catalog-enrichment', kind: 'async'},
      {from: 'catalogd', to: 'catalogd', label: 'validate → sku.upserted.dlq (reason header)', kind: 'sync'},
      {from: 'catalogd', to: 'Redis', label: 'HGET sku:{id} content_hash', kind: 'sync'},
      {from: 'catalogd', to: 'sku.extract', label: 'job · key = merchant · wait for the ack', kind: 'async'},
      {from: 'catalogd', to: 'Redis', label: 'HSET sku:{id} content_hash', kind: 'sync'},
      {from: 'catalogd', to: 'sku.upserted', label: 'commit offset (after the work)', kind: 'sync'},
    ],
  },
  hints: [
    'A record with a broken payload stops a whole merchant; after a deploy the full feed is extracted again while a corrected title never is; a broker blip loses a SKU for good.',
    'The commit happens before the work, so a failed `send` leaves nothing to redeliver. The `seen` set lives in memory and keys on the id. Parsing assumes valid JSON, and the job has no key.',
    'Disable auto-commit and commit after `intake`. Validate, else `send` to `DLQ_TOPIC` with a `reason` header. Compare `store.content_hash(...)` with `store.last_hash`, `send` keyed by `job["merchant"]`, then `store.put_hash`.',
  ],
  checks: [
    {
      id: 'merchant-key',
      title: 'Jobs are keyed by the merchant',
      detail:
        "The job on `sku.extract` has the merchant as its key, so a merchant's jobs land on one partition in order. The starter sends them without a key.",
      match: {
        python: {all: [/send\(\s*EXTRACT_TOPIC,\s*job\[["']merchant["']\]/]},
        typescript: {all: [/send\(\s*EXTRACT_TOPIC,\s*job\.merchant/]},
        go: {all: [/send\(\s*ctx,\s*extractTopic,\s*job\.Merchant/]},
        scala: {all: [/send\(\s*ExtractTopic,\s*job\("merchant"\)\.str/]},
        cpp: {all: [/send\(\s*kExtractTopic,\s*job\["merchant"\]/]},
      },
    },
    {
      id: 'dead-letter',
      title: 'A malformed record goes to sku.upserted.dlq with a reason',
      detail:
        'A record that is not a JSON object, lacks a required field or breaks a size cap is sent to `sku.upserted.dlq` with a `reason` header and committed; the records behind it keep flowing. The starter parses every record as valid and crashes on the first one that is not.',
      match: {
        python: {all: [/send\(\s*DLQ_TOPIC/, /["']reason["']/, /MAX_TITLE_BYTES\s*=\s*4096/]},
        typescript: {all: [/send\(\s*DLQ_TOPIC/, /reason/, /MAX_TITLE_BYTES\s*=\s*4096/]},
        go: {all: [/send\(\s*ctx,\s*dlqTopic/, /"reason"/, /maxTitleBytes\s*=\s*4096/]},
        scala: {all: [/send\(\s*DlqTopic/, /"reason"/, /MaxTitleBytes\s*=\s*4096/]},
        cpp: {all: [/send\(\s*kDlqTopic/, /"reason"/, /kMaxTitleBytes\s*=\s*4096/]},
      },
    },
    {
      id: 'content-hash',
      title: 'Skips a SKU by its stored content hash, not its id',
      detail:
        "The job carries the SKU's content hash; a SKU whose hash equals `store.last_hash` is skipped, and the hash is stored after the job is on `sku.extract`. The starter keeps the ids it has seen in memory: a changed title is skipped and every SKU is extracted again after a restart.",
      match: {
        python: {
          all: [/store\.last_hash\(/],
          order: [/send\(\s*EXTRACT_TOPIC/, /store\.put_hash\(/],
          none: [/\bseen\b/],
        },
        typescript: {all: [/lastHash\(/], order: [/send\(\s*EXTRACT_TOPIC/, /putHash\(/], none: [/\bseen\b/]},
        go: {
          all: [/store\.LastHash\(/],
          order: [/send\(\s*ctx,\s*extractTopic/, /store\.PutHash\(/],
          none: [/\bseen\b/],
        },
        scala: {all: [/Store\.lastHash\(/], order: [/send\(\s*ExtractTopic/, /Store\.putHash\(/], none: [/\bseen\b/]},
        cpp: {
          all: [/store::last_hash\(/],
          order: [/send\(\s*kExtractTopic/, /store::put_hash\(/],
          none: [/\bseen\b/],
        },
      },
    },
    {
      id: 'commit-after-enqueue',
      title: 'Commits the offset only after the job is on sku.extract',
      detail:
        'Auto-commit is off and the offset is committed after `intake` returns, so a job the broker refused leaves the record uncommitted for its redelivery. The starter commits each record as it arrives.',
      match: {
        python: {
          all: [/["']enable\.auto\.commit["']\s*:\s*False/],
          order: [/\n\s+intake\(msg\)/, /consumer\.commit\(/],
        },
        typescript: {all: [/autoCommit:\s*false/], order: [/await intake\(/, /commitOffsets\(/]},
        go: {all: [/FetchMessage\(/], none: [/ReadMessage\(/], order: [/intake\(ctx,\s*msg\)/, /CommitMessages\(/]},
        scala: {all: [/ENABLE_AUTO_COMMIT_CONFIG,\s*"false"/], order: [/\n\s+intake\(record\)/, /commitSync\(/]},
        cpp: {all: [/"enable\.auto\.commit",\s*"false"/], order: [/\n\s+intake\(\*msg\)/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Message, Producer

from enrich import store  # content_hash, last_hash, put_hash

TOPIC = "sku.upserted"
EXTRACT_TOPIC = "sku.extract"
GROUP = "catalog-enrichment"

producer = Producer({"bootstrap.servers": "kafka:9092"})


class EnqueueFailed(Exception):
    """The broker refused a record."""


def send(topic: str, key: str | None, value: bytes | str, headers: dict | None = None) -> None:
    """Produce one record and wait for its delivery report; raise EnqueueFailed when the broker refused it."""
    errors = []

    def on_delivery(err, _msg) -> None:
        if err is not None:
            errors.append(err)

    producer.produce(topic, key=key, value=value, headers=headers, on_delivery=on_delivery)
    producer.flush(5.0)
    if errors:
        raise EnqueueFailed(str(errors[0]))


seen: set[str] = set()


def intake(msg: Message) -> None:
    """Turn one sku.upserted record into an extraction job."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    event = json.loads(msg.value())
    if event["sku_id"] in seen:
        return
    seen.add(event["sku_id"])
    job = {
        "sku_id": event["sku_id"],
        "merchant": event["merchant"],
        "title": event["title"],
        "description": event.get("description", ""),
        "images": event.get("images", []),
    }
    send(EXTRACT_TOPIC, None, json.dumps(job))


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        intake(msg)
`,
      solution: `import json

from confluent_kafka import Consumer, Message, Producer

from enrich import store  # content_hash, last_hash, put_hash

TOPIC = "sku.upserted"
DLQ_TOPIC = "sku.upserted.dlq"
EXTRACT_TOPIC = "sku.extract"
GROUP = "catalog-enrichment"
MAX_TITLE_BYTES = 4096
MAX_DESCRIPTION_BYTES = 16384
MAX_IMAGES = 8

producer = Producer({"bootstrap.servers": "kafka:9092"})


class EnqueueFailed(Exception):
    """The broker refused a record."""


def send(topic: str, key: str | None, value: bytes | str, headers: dict | None = None) -> None:
    """Produce one record and wait for its delivery report; raise EnqueueFailed when the broker refused it."""
    errors = []

    def on_delivery(err, _msg) -> None:
        if err is not None:
            errors.append(err)

    producer.produce(topic, key=key, value=value, headers=headers, on_delivery=on_delivery)
    producer.flush(5.0)
    if errors:
        raise EnqueueFailed(str(errors[0]))


def validate(event) -> str | None:
    """Why the record is unusable, or None when it is well-formed."""
    if not isinstance(event, dict):
        return "not a JSON object"
    for name in ("merchant", "sku_id", "title"):
        if not isinstance(event.get(name), str) or event[name].strip() == "":
            return f"{name} is required"
    if len(event["title"].encode("utf-8")) > MAX_TITLE_BYTES:
        return "title exceeds 4 KiB"
    description = event.get("description", "")
    if not isinstance(description, str) or len(description.encode("utf-8")) > MAX_DESCRIPTION_BYTES:
        return "description must be text of at most 16 KiB"
    images = event.get("images", [])
    if not isinstance(images, list) or len(images) > MAX_IMAGES or not all(isinstance(ref, str) for ref in images):
        return "images must be a list of at most 8 refs"
    return None


def intake(msg: Message) -> None:
    """Turn one sku.upserted record into an extraction job, or dead-letter it."""
    try:
        event = json.loads(msg.value())
    except ValueError:
        event = None
    reason = validate(event)
    if reason is not None:
        send(DLQ_TOPIC, msg.key(), msg.value(), {"reason": reason})
        return
    description, images = event.get("description", ""), event.get("images", [])
    digest = store.content_hash(event["merchant"], event["title"], description, images)
    if store.last_hash(event["sku_id"]) == digest:
        return  # the merchant re-sent an unchanged SKU: nothing to extract
    job = {
        "sku_id": event["sku_id"],
        "merchant": event["merchant"],
        "content_hash": digest,
        "title": event["title"],
        "description": description,
        "images": images,
    }
    send(EXTRACT_TOPIC, job["merchant"], json.dumps(job))
    store.put_hash(job["sku_id"], digest)  # only once the job is on the topic


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        intake(msg)
        consumer.commit(message=msg, asynchronous=False)  # after the work: a failure above leaves the record for the redelivery
`,
    },
    typescript: {
      starter: `import {type KafkaMessage, Kafka} from 'kafkajs';

export const TOPIC = 'sku.upserted';
export const EXTRACT_TOPIC = 'sku.extract';
export const GROUP = 'catalog-enrichment';

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Produce one record; the promise rejects when the broker refused it. */
export async function send(topic: string, key: string | null, value: string | Buffer, headers?: Record<string, string>): Promise<void> {
  await producer.send({topic, messages: [{key, value, headers}]});
}

const seen = new Set<string>();

/** Turn one sku.upserted record into an extraction job. */
async function intake(message: KafkaMessage): Promise<void> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const event = JSON.parse(Buffer.from(message.value ?? []).toString('utf8'));
  if (seen.has(event.sku_id)) return;
  seen.add(event.sku_id);
  const job = {sku_id: event.sku_id, merchant: event.merchant, title: event.title, description: event.description ?? '', images: event.images ?? []};
  await send(EXTRACT_TOPIC, null, JSON.stringify(job));
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await intake(message);
    },
  });
}
`,
      solution: `import {type KafkaMessage, Kafka} from 'kafkajs';

import {contentHash, lastHash, putHash} from 'enrich/store';

export const TOPIC = 'sku.upserted';
export const DLQ_TOPIC = 'sku.upserted.dlq';
export const EXTRACT_TOPIC = 'sku.extract';
export const GROUP = 'catalog-enrichment';
export const MAX_TITLE_BYTES = 4096;
export const MAX_DESCRIPTION_BYTES = 16384;
export const MAX_IMAGES = 8;

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Produce one record; the promise rejects when the broker refused it. */
export async function send(topic: string, key: string | null, value: string | Buffer, headers?: Record<string, string>): Promise<void> {
  await producer.send({topic, messages: [{key, value, headers}]});
}

/** Why the record is unusable, or null when it is well-formed. */
export function validate(event: unknown): string | null {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return 'not a JSON object';
  const record = event as Record<string, unknown>;
  for (const name of ['merchant', 'sku_id', 'title']) {
    const value = record[name];
    if (typeof value !== 'string' || value.trim() === '') return \`\${name} is required\`;
  }
  if (Buffer.byteLength(record.title as string, 'utf8') > MAX_TITLE_BYTES) return 'title exceeds 4 KiB';
  const description = record.description ?? '';
  if (typeof description !== 'string' || Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES) return 'description must be text of at most 16 KiB';
  const images = record.images ?? [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES || images.some(ref => typeof ref !== 'string')) return 'images must be a list of at most 8 refs';
  return null;
}

/** Turn one sku.upserted record into an extraction job, or dead-letter it. */
async function intake(message: KafkaMessage): Promise<void> {
  const raw = Buffer.from(message.value ?? []);
  let event: unknown = null;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    // not JSON: validate says so
  }
  const reason = validate(event);
  if (reason !== null) {
    await send(DLQ_TOPIC, message.key === null ? null : Buffer.from(message.key).toString('utf8'), raw, {reason});
    return;
  }
  const record = event as {sku_id: string; merchant: string; title: string; description?: string; images?: string[]};
  const description = record.description ?? '';
  const images = record.images ?? [];
  const digest = contentHash(record.merchant, record.title, description, images);
  if ((await lastHash(record.sku_id)) === digest) return; // the merchant re-sent an unchanged SKU
  const job = {sku_id: record.sku_id, merchant: record.merchant, content_hash: digest, title: record.title, description, images};
  await send(EXTRACT_TOPIC, job.merchant, JSON.stringify(job));
  await putHash(job.sku_id, digest); // only once the job is on the topic
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await intake(message);
      // After the work: a rejected send above leaves the record for the redelivery.
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"

	"enrich/store" // store.Job
)

const (
	topic        = "sku.upserted"
	extractTopic = "sku.extract"
	group        = "catalog-enrichment"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}}

// send produces one record and returns the broker's error when it refused it.
func send(ctx context.Context, topic, key string, value []byte, headers ...kafka.Header) error {
	msg := kafka.Message{Topic: topic, Value: value, Headers: headers}
	if key != "" {
		msg.Key = []byte(key)
	}
	return writer.WriteMessages(ctx, msg)
}

var seen = map[string]bool{}

// intake turns one sku.upserted record into an extraction job.
func intake(ctx context.Context, msg kafka.Message) error {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	var job store.Job
	if err := json.Unmarshal(msg.Value, &job); err != nil {
		return err
	}
	if seen[job.SkuID] {
		return nil
	}
	seen[job.SkuID] = true
	value, _ := json.Marshal(job)
	return send(ctx, extractTopic, "", value)
}

func consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	defer reader.Close()
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			return err
		}
		if err := intake(ctx, msg); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/segmentio/kafka-go"

	"enrich/store" // store.Job, ContentHash, LastHash, PutHash
)

const (
	topic               = "sku.upserted"
	dlqTopic            = "sku.upserted.dlq"
	extractTopic        = "sku.extract"
	group               = "catalog-enrichment"
	maxTitleBytes       = 4096
	maxDescriptionBytes = 16384
	maxImages           = 8
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}}

// send produces one record and returns the broker's error when it refused it.
func send(ctx context.Context, topic, key string, value []byte, headers ...kafka.Header) error {
	msg := kafka.Message{Topic: topic, Value: value, Headers: headers}
	if key != "" {
		msg.Key = []byte(key)
	}
	return writer.WriteMessages(ctx, msg)
}

// validate decodes a record into a job; the reason is "" when it is well-formed.
func validate(raw []byte) (store.Job, string) {
	var event map[string]any
	if err := json.Unmarshal(raw, &event); err != nil || event == nil {
		return store.Job{}, "not a JSON object"
	}
	text := map[string]string{}
	for _, name := range []string{"merchant", "sku_id", "title"} {
		value, ok := event[name].(string)
		if !ok || strings.TrimSpace(value) == "" {
			return store.Job{}, name + " is required"
		}
		text[name] = value
	}
	if len(text["title"]) > maxTitleBytes {
		return store.Job{}, "title exceeds 4 KiB"
	}
	job := store.Job{SkuID: text["sku_id"], Merchant: text["merchant"], Title: text["title"], Images: []string{}}
	if value, present := event["description"]; present {
		description, ok := value.(string)
		if !ok || len(description) > maxDescriptionBytes {
			return store.Job{}, "description must be text of at most 16 KiB"
		}
		job.Description = description
	}
	if value, present := event["images"]; present {
		refs, ok := value.([]any)
		if !ok || len(refs) > maxImages {
			return store.Job{}, "images must be a list of at most 8 refs"
		}
		for _, ref := range refs {
			image, ok := ref.(string)
			if !ok {
				return store.Job{}, "images must be a list of at most 8 refs"
			}
			job.Images = append(job.Images, image)
		}
	}
	return job, ""
}

// intake turns one sku.upserted record into an extraction job, or dead-letters it.
func intake(ctx context.Context, msg kafka.Message) error {
	job, reason := validate(msg.Value)
	if reason != "" {
		return send(ctx, dlqTopic, string(msg.Key), msg.Value, kafka.Header{Key: "reason", Value: []byte(reason)})
	}
	job.ContentHash = store.ContentHash(job.Merchant, job.Title, job.Description, job.Images)
	if last, ok := store.LastHash(ctx, job.SkuID); ok && last == job.ContentHash {
		return nil // the merchant re-sent an unchanged SKU: nothing to extract
	}
	value, _ := json.Marshal(job)
	if err := send(ctx, extractTopic, job.Merchant, value); err != nil {
		return err
	}
	return store.PutHash(ctx, job.SkuID, job.ContentHash) // only once the job is on the topic
}

func consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	defer reader.Close()
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := intake(ctx, msg); err != nil {
			return err // not committed: the record is redelivered after the restart
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets.UTF_8
import java.time.Duration
import java.util.Properties
import java.util.concurrent.ExecutionException

import org.apache.kafka.clients.consumer.{ConsumerConfig, ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}

import scala.collection.mutable
import scala.jdk.CollectionConverters._

import enrich.Store // Store.contentHash, lastHash, putHash

/** The broker refused a record. */
final class EnqueueFailed(cause: Throwable) extends Exception(cause)

object SkuIntake {
  val Topic = "sku.upserted"
  val ExtractTopic = "sku.extract"
  val Group = "catalog-enrichment"

  private val producer = {
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Produce one record and wait for the broker's answer; throws EnqueueFailed when it refused it. */
  def send(topic: String, key: String, value: String, reason: Option[String] = None): Unit = {
    val record = new ProducerRecord[String, String](topic, key, value)
    reason.foreach(r => record.headers().add("reason", r.getBytes(UTF_8)))
    try producer.send(record).get()
    catch { case e: ExecutionException => throw new EnqueueFailed(e.getCause) }
  }

  private val seen = mutable.Set.empty[String]

  /** Turn one sku.upserted record into an extraction job. */
  def intake(record: ConsumerRecord[String, String]): Unit = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val event = ujson.read(record.value())
    val skuId = event("sku_id").str
    if (!seen.contains(skuId)) {
      seen += skuId
      val job = ujson.Obj(
        "sku_id" -> skuId,
        "merchant" -> event("merchant").str,
        "title" -> event("title").str,
        "description" -> (event.obj.get("description").map(_.str).getOrElse(""): String),
        "images" -> event.obj.getOrElse("images", ujson.Arr()),
      )
      send(ExtractTopic, null, ujson.write(job))
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        intake(record)
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8
import java.time.Duration
import java.util.Properties
import java.util.concurrent.ExecutionException

import org.apache.kafka.clients.consumer.{ConsumerConfig, ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}

import scala.jdk.CollectionConverters._
import scala.util.Try

import enrich.Store // Store.contentHash, lastHash, putHash

/** The broker refused a record. */
final class EnqueueFailed(cause: Throwable) extends Exception(cause)

object SkuIntake {
  val Topic = "sku.upserted"
  val DlqTopic = "sku.upserted.dlq"
  val ExtractTopic = "sku.extract"
  val Group = "catalog-enrichment"
  val MaxTitleBytes = 4096
  val MaxDescriptionBytes = 16384
  val MaxImages = 8

  private val producer = {
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Produce one record and wait for the broker's answer; throws EnqueueFailed when it refused it. */
  def send(topic: String, key: String, value: String, reason: Option[String] = None): Unit = {
    val record = new ProducerRecord[String, String](topic, key, value)
    reason.foreach(r => record.headers().add("reason", r.getBytes(UTF_8)))
    try producer.send(record).get()
    catch { case e: ExecutionException => throw new EnqueueFailed(e.getCause) }
  }

  /** Why the record is unusable, or None when it is well-formed. */
  def validate(parsed: Option[ujson.Value]): Option[String] = parsed.flatMap(_.objOpt) match {
    case None => Some("not a JSON object")
    case Some(event) =>
      val missing = Seq("merchant", "sku_id", "title").find(name => event.get(name).flatMap(_.strOpt).forall(_.trim.isEmpty))
      val description = event.get("description").map(_.strOpt)
      val images = event.get("images").map(_.arrOpt)
      if (missing.nonEmpty) missing.map(_ + " is required")
      else if (event("title").str.getBytes(UTF_8).length > MaxTitleBytes) Some("title exceeds 4 KiB")
      else if (description.exists(_.forall(_.getBytes(UTF_8).length > MaxDescriptionBytes))) Some("description must be text of at most 16 KiB")
      else if (images.exists(_.forall(refs => refs.length > MaxImages || refs.exists(_.strOpt.isEmpty)))) Some("images must be a list of at most 8 refs")
      else None
  }

  /** Turn one sku.upserted record into an extraction job, or dead-letter it. */
  def intake(record: ConsumerRecord[String, String]): Unit = {
    val parsed = Try(ujson.read(record.value())).toOption
    validate(parsed) match {
      case Some(reason) => send(DlqTopic, record.key, record.value, Some(reason))
      case None =>
        val event = parsed.get
        val skuId = event("sku_id").str
        val description = event.obj.get("description").map(_.str).getOrElse("")
        val images = event.obj.get("images").map(_.arr.map(_.str).toSeq).getOrElse(Seq.empty)
        val digest = Store.contentHash(event("merchant").str, event("title").str, description, images)
        if (!Store.lastHash(skuId).contains(digest)) { // an unchanged re-send has nothing to extract
          val job = ujson.Obj(
            "sku_id" -> skuId,
            "merchant" -> event("merchant").str,
            "content_hash" -> digest,
            "title" -> event("title").str,
            "description" -> description,
            "images" -> images,
          )
          send(ExtractTopic, job("merchant").str, ujson.write(job))
          Store.putHash(skuId, digest) // only once the job is on the topic
        }
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        intake(record)
        // After the work: an EnqueueFailed above leaves the record for the redelivery.
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <set>
#include <stdexcept>
#include <string>

#include "enrich/store.h"  // store::content_hash, last_hash, put_hash

using json = nlohmann::json;

const std::string kTopic = "sku.upserted";
const std::string kExtractTopic = "sku.extract";
const std::string kGroup = "catalog-enrichment";

// The broker refused a record.
struct EnqueueFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Delivery report: msg_opaque points at the slot the producing call waits on.
class RecordOutcome : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override { *static_cast<RdKafka::ErrorCode*>(message.msg_opaque()) = message.err(); }
};
RecordOutcome outcomes;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &outcomes, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}
auto producer = make_producer();

// Produce one record and wait for its delivery report; throws EnqueueFailed when the broker refused it.
void send(const std::string& topic, const std::string& key, const std::string& value, const std::string& reason = "") {
  RdKafka::ErrorCode outcome = RdKafka::ERR__IN_PROGRESS;
  RdKafka::Headers* headers = nullptr;
  if (!reason.empty()) {
    headers = RdKafka::Headers::create();
    headers->add("reason", reason);
  }
  const RdKafka::ErrorCode queued =
      producer->produce(topic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), key.empty() ? nullptr : key.data(), key.size(), 0, headers, &outcome);
  if (queued != RdKafka::ERR_NO_ERROR) throw EnqueueFailed(RdKafka::err2str(queued));
  producer->flush(5000);
  if (outcome != RdKafka::ERR_NO_ERROR) throw EnqueueFailed(RdKafka::err2str(outcome));
}

std::set<std::string> seen;

// Turn one sku.upserted record into an extraction job.
void intake(const RdKafka::Message& msg) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const auto* bytes = static_cast<const char*>(msg.payload());
  const json event = json::parse(bytes, bytes + msg.len());
  const std::string sku_id = event["sku_id"];
  if (seen.count(sku_id)) return;
  seen.insert(sku_id);
  const json job = {{"sku_id", sku_id},
                    {"merchant", event["merchant"]},
                    {"title", event["title"]},
                    {"description", event.value("description", std::string())},
                    {"images", event.value("images", json::array())}};
  send(kExtractTopic, "", job.dump());
}

void consume() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    intake(*msg);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "enrich/store.h"  // store::content_hash, last_hash, put_hash

using json = nlohmann::json;

const std::string kTopic = "sku.upserted";
const std::string kDlqTopic = "sku.upserted.dlq";
const std::string kExtractTopic = "sku.extract";
const std::string kGroup = "catalog-enrichment";
constexpr size_t kMaxTitleBytes = 4096;
constexpr size_t kMaxDescriptionBytes = 16384;
constexpr size_t kMaxImages = 8;

// The broker refused a record.
struct EnqueueFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Delivery report: msg_opaque points at the slot the producing call waits on.
class RecordOutcome : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override { *static_cast<RdKafka::ErrorCode*>(message.msg_opaque()) = message.err(); }
};
RecordOutcome outcomes;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("dr_cb", &outcomes, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}
auto producer = make_producer();

// Produce one record and wait for its delivery report; throws EnqueueFailed when the broker refused it.
void send(const std::string& topic, const std::string& key, const std::string& value, const std::string& reason = "") {
  RdKafka::ErrorCode outcome = RdKafka::ERR__IN_PROGRESS;
  RdKafka::Headers* headers = nullptr;
  if (!reason.empty()) {
    headers = RdKafka::Headers::create();
    headers->add("reason", reason);
  }
  const RdKafka::ErrorCode queued =
      producer->produce(topic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), key.empty() ? nullptr : key.data(), key.size(), 0, headers, &outcome);
  if (queued != RdKafka::ERR_NO_ERROR) throw EnqueueFailed(RdKafka::err2str(queued));
  producer->flush(5000);
  if (outcome != RdKafka::ERR_NO_ERROR) throw EnqueueFailed(RdKafka::err2str(outcome));
}

bool blank(const json& value) {
  return !value.is_string() || value.get<std::string>().find_first_not_of(" \\t\\r\\n") == std::string::npos;
}

// Why the record is unusable, or nothing when it is well-formed.
std::optional<std::string> validate(const json& event) {
  if (!event.is_object()) return "not a JSON object";
  for (const char* name : {"merchant", "sku_id", "title"}) {
    if (!event.contains(name) || blank(event[name])) return std::string(name) + " is required";
  }
  if (event["title"].get<std::string>().size() > kMaxTitleBytes) return "title exceeds 4 KiB";
  if (event.contains("description") && (!event["description"].is_string() || event["description"].get<std::string>().size() > kMaxDescriptionBytes))
    return "description must be text of at most 16 KiB";
  if (event.contains("images")) {
    const json& images = event["images"];
    bool ok = images.is_array() && images.size() <= kMaxImages;
    for (size_t i = 0; ok && i < images.size(); i++) ok = images[i].is_string();
    if (!ok) return "images must be a list of at most 8 refs";
  }
  return std::nullopt;
}

// Turn one sku.upserted record into an extraction job, or dead-letter it.
void intake(const RdKafka::Message& msg) {
  const auto* bytes = static_cast<const char*>(msg.payload());
  const std::string raw(bytes, msg.len());
  const json event = json::parse(raw, nullptr, false);
  if (const auto reason = validate(event)) {
    send(kDlqTopic, msg.key() ? *msg.key() : "", raw, *reason);
    return;
  }
  const std::string description = event.value("description", std::string());
  const std::vector<std::string> images = event.value("images", std::vector<std::string>());
  const std::string digest = store::content_hash(event["merchant"], event["title"], description, images);
  const auto last = store::last_hash(event["sku_id"]);
  if (last && *last == digest) return;  // the merchant re-sent an unchanged SKU: nothing to extract
  const json job = {{"sku_id", event["sku_id"]}, {"merchant", event["merchant"]}, {"content_hash", digest},
                    {"title", event["title"]},   {"description", description},     {"images", images}};
  send(kExtractTopic, job["merchant"], job.dump());
  store::put_hash(job["sku_id"], digest);  // only once the job is on the topic
}

void consume() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    intake(*msg);
    consumer->commitSync(msg.get());  // after the work: an EnqueueFailed above leaves the record for the redelivery
  }
}
`,
    },
  },
  harness: {
    python: `import json

from enrich import store

GROUP = "catalog-enrichment"
TITLE = "DOVE SILK GLOW BODY WASH 500ML"


def _sku(sku_id="sku-1", merchant="m-1", title=TITLE, **extra):
    return {"merchant": merchant, "sku_id": sku_id, "title": title, "description": "Nourishing body wash", "images": ["img/a.jpg", "img/b.jpg"], **extra}


def _seed(ctx, record, key="m-1"):
    value = json.dumps(record) if isinstance(record, dict) else record
    ctx.kafka.seed("sku.upserted", key=record.get("merchant", key) if isinstance(record, dict) else key, value=value)


def _run(ctx):
    """One life of the consumer; what it raised, if anything."""
    m = ctx.load("sku_intake")
    try:
        ctx.drain(m.consume)
    except Exception as exc:  # noqa: BLE001 - what it raised is part of the verdict
        return exc
    return None


def _jobs(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records("sku.extract")]


def check_merchant_key(ctx):
    for sku_id, merchant in (("sku-1", "m-1"), ("sku-2", "m-2"), ("sku-3", "m-1")):
        _seed(ctx, _sku(sku_id, merchant))
    err = _run(ctx)
    assert err is None, f"three well-formed records stopped the consumer: {err!r}"
    records = ctx.kafka.records("sku.extract")
    assert len(records) == 3, f"three new SKUs produced {len(records)} jobs on sku.extract"
    keys = [r.key for r in records]
    assert sorted(k or b"" for k in keys) == [b"m-1", b"m-1", b"m-2"], f"jobs must be keyed by the merchant, got keys {keys}"
    partitions = {r.partition for r in records if r.key == b"m-1"}
    assert len(partitions) == 1, f"merchant m-1's jobs landed on partitions {sorted(partitions)}: one merchant, one partition"


def check_dead_letter(ctx):
    _seed(ctx, b"{not json")
    _seed(ctx, _sku("sku-2", title="   "))
    _seed(ctx, _sku("sku-3", title="X" * 5000))
    _seed(ctx, _sku("sku-4", images=[f"img/{i}.jpg" for i in range(9)]))
    _seed(ctx, _sku("sku-5"))
    err = _run(ctx)
    assert err is None, f"a malformed record stopped the consumer ({err!r}): every record behind it on the partition is stuck"
    dlq = ctx.kafka.records("sku.upserted.dlq")
    assert len(dlq) == 4, f"four malformed records (not JSON, a blank title, a 5000-byte title, nine images) put {len(dlq)} records on sku.upserted.dlq"
    for r in dlq:
        reason = dict(r.headers).get("reason")
        assert reason, f"a dead-lettered record carries no reason header: {r.value[:40]!r}"
    jobs = [j.get("sku_id") for j in _jobs(ctx)]
    assert jobs == ["sku-5"], f"only the well-formed record may become a job, sku.extract holds {jobs}"
    assert ctx.kafka.lag(GROUP, "sku.upserted") == 0, "dead-lettered records must be committed too, or they are redelivered forever"


def check_content_hash(ctx):
    v1 = _sku()
    _seed(ctx, v1)
    _seed(ctx, {**v1, "images": list(reversed(v1["images"]))})  # the merchant re-sends its feed
    v2 = _sku(title="DOVE SILK GLOW BODY WASH 750ML")
    _seed(ctx, v2)
    kept = _sku("sku-7", title="OATLY OAT MILK 1L")
    store.put_hash("sku-7", store.content_hash("m-1", kept["title"], kept["description"], kept["images"]))  # enqueued before the last restart
    _seed(ctx, kept)
    err = _run(ctx)
    assert err is None, f"the consumer stopped: {err!r}"
    jobs = _jobs(ctx)
    titles = [(j.get("sku_id"), j.get("title")) for j in jobs]
    assert titles == [("sku-1", TITLE), ("sku-1", v2["title"])], f"a re-sent SKU must be skipped, a changed one enqueued and one enqueued before a restart skipped: sku.extract holds {titles}"
    expected = store.content_hash("m-1", v2["title"], v2["description"], v2["images"])
    assert jobs[1].get("content_hash") == expected, f"the job must carry store.content_hash of the SKU, got {jobs[1].get('content_hash')!r}"
    assert store.last_hash("sku-1") == expected, f"store.last_hash('sku-1') is {store.last_hash('sku-1')!r} after the changed title was enqueued"


def check_commit_after_enqueue(ctx):
    _seed(ctx, _sku())
    ctx.kafka.fail_next("sku.extract", 1)
    _run(ctx)
    assert ctx.kafka.lag(GROUP, "sku.upserted") == 1, "the broker refused the job and the record's offset was committed anyway: the SKU is lost. Commit only after the job is on sku.extract"
    assert store.last_hash("sku-1") is None, "the content hash was stored for a job that never reached sku.extract: the redelivery would be skipped"
`,
    typescript: `const GROUP = 'catalog-enrichment';
const TITLE = 'DOVE SILK GLOW BODY WASH 500ML';

const sku = (sku_id = 'sku-1', merchant = 'm-1', title = TITLE, extra: Record<string, unknown> = {}) => ({
  merchant,
  sku_id,
  title,
  description: 'Nourishing body wash',
  images: ['img/a.jpg', 'img/b.jpg'],
  ...extra,
});

function seed(ctx, record, key = 'm-1'): void {
  const value = typeof record === 'string' ? record : JSON.stringify(record);
  ctx.kafka.seed('sku.upserted', {key: typeof record === 'string' ? key : record.merchant, value});
}

/** One life of the consumer; what it threw, if anything. */
async function run(ctx): Promise<unknown> {
  const m = ctx.load('sku_intake');
  try {
    await ctx.drain(m.consume());
  } catch (e) {
    return e;
  }
  return null;
}

const text = (b): string => (b === null || b === undefined ? '' : Buffer.from(b).toString('utf8'));
const jobs = (ctx) => ctx.kafka.records('sku.extract').map(r => JSON.parse(text(r.value)));

export async function check_merchant_key(ctx) {
  for (const [id, merchant] of [['sku-1', 'm-1'], ['sku-2', 'm-2'], ['sku-3', 'm-1']]) seed(ctx, sku(id, merchant));
  const err = await run(ctx);
  assert.equal(err, null, \`three well-formed records stopped the consumer: \${err}\`);
  const records = ctx.kafka.records('sku.extract');
  assert.equal(records.length, 3, \`three new SKUs produced \${records.length} jobs on sku.extract\`);
  const keys = records.map(r => text(r.key)).sort();
  assert.deepStrictEqual(keys, ['m-1', 'm-1', 'm-2'], \`jobs must be keyed by the merchant, got keys \${JSON.stringify(keys)}\`);
  const partitions = new Set(records.filter(r => text(r.key) === 'm-1').map(r => r.partition));
  assert.equal(partitions.size, 1, "merchant m-1's jobs landed on more than one partition: one merchant, one partition");
}

export async function check_dead_letter(ctx) {
  seed(ctx, '{not json');
  seed(ctx, sku('sku-2', 'm-1', '   '));
  seed(ctx, sku('sku-3', 'm-1', 'X'.repeat(5000)));
  seed(ctx, sku('sku-4', 'm-1', TITLE, {images: Array.from({length: 9}, (_, i) => \`img/\${i}.jpg\`)}));
  seed(ctx, sku('sku-5'));
  const err = await run(ctx);
  assert.equal(err, null, \`a malformed record stopped the consumer (\${err}): every record behind it on the partition is stuck\`);
  const dlq = ctx.kafka.records('sku.upserted.dlq');
  assert.equal(dlq.length, 4, \`four malformed records (not JSON, a blank title, a 5000-byte title, nine images) put \${dlq.length} records on sku.upserted.dlq\`);
  for (const r of dlq) assert(text(r.headers?.reason) !== '', \`a dead-lettered record carries no reason header: \${text(r.value).slice(0, 40)}\`);
  const ids = jobs(ctx).map(j => j.sku_id);
  assert.deepStrictEqual(ids, ['sku-5'], \`only the well-formed record may become a job, sku.extract holds \${JSON.stringify(ids)}\`);
  assert.equal(ctx.kafka.lag(GROUP, 'sku.upserted'), 0, 'dead-lettered records must be committed too, or they are redelivered forever');
}

export async function check_content_hash(ctx) {
  const store = ctx.load('/support/enrich/store.ts');
  const v1 = sku();
  seed(ctx, v1);
  seed(ctx, {...v1, images: [...v1.images].reverse()}); // the merchant re-sends its feed
  const v2 = sku('sku-1', 'm-1', 'DOVE SILK GLOW BODY WASH 750ML');
  seed(ctx, v2);
  const kept = sku('sku-7', 'm-1', 'OATLY OAT MILK 1L');
  await store.putHash('sku-7', store.contentHash('m-1', kept.title, kept.description, kept.images)); // enqueued before the last restart
  seed(ctx, kept);
  const err = await run(ctx);
  assert.equal(err, null, \`the consumer stopped: \${err}\`);
  const all = jobs(ctx);
  const titles = all.map(j => [j.sku_id, j.title]);
  assert.deepStrictEqual(titles, [['sku-1', TITLE], ['sku-1', v2.title]], \`a re-sent SKU must be skipped, a changed one enqueued and one enqueued before a restart skipped: sku.extract holds \${JSON.stringify(titles)}\`);
  const expected = store.contentHash('m-1', v2.title, v2.description, v2.images);
  assert.equal(all[1].content_hash, expected, 'the job must carry store.contentHash of the SKU');
  assert.equal(await store.lastHash('sku-1'), expected, 'store.lastHash(sku-1) must hold the hash of the changed title once it was enqueued');
}

export async function check_commit_after_enqueue(ctx) {
  const store = ctx.load('/support/enrich/store.ts');
  seed(ctx, sku());
  ctx.kafka.failNext('sku.extract', 1);
  await run(ctx);
  assert.equal(ctx.kafka.lag(GROUP, 'sku.upserted'), 1, "the broker refused the job and the record's offset was committed anyway: the SKU is lost. Commit only after the job is on sku.extract");
  assert.equal(await store.lastHash('sku-1'), null, 'the content hash was stored for a job that never reached sku.extract: the redelivery would be skipped');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"enrich/store"

	"leetbuild/harness"
)

const intakeGroup = "catalog-enrichment"
const intakeTitle = "DOVE SILK GLOW BODY WASH 500ML"

var intakeBg = context.Background()

func intakeSku(skuID, merchant, title string) map[string]any {
	return map[string]any{"merchant": merchant, "sku_id": skuID, "title": title, "description": "Nourishing body wash", "images": []string{"img/a.jpg", "img/b.jpg"}}
}

func intakeSeed(ctx *harness.Ctx, record map[string]any) {
	value, _ := json.Marshal(record)
	ctx.Kafka.Seed("sku.upserted", record["merchant"], string(value))
}

// intakeRun is one life of the consumer; what it returned, if anything.
func intakeRun(ctx *harness.Ctx) error {
	var err error
	ctx.Drain(func() { err = consume(intakeBg) })
	return err
}

func intakeJobs(ctx *harness.Ctx) []store.Job {
	var jobs []store.Job
	for _, r := range ctx.Kafka.Records("sku.extract") {
		var job store.Job
		json.Unmarshal(r.Value, &job)
		jobs = append(jobs, job)
	}
	return jobs
}

func CheckMerchantKey(ctx *harness.Ctx) {
	intakeSeed(ctx, intakeSku("sku-1", "m-1", intakeTitle))
	intakeSeed(ctx, intakeSku("sku-2", "m-2", intakeTitle))
	intakeSeed(ctx, intakeSku("sku-3", "m-1", intakeTitle))
	ctx.NoError(intakeRun(ctx), "three well-formed records stopped the consumer")
	records := ctx.Kafka.Records("sku.extract")
	ctx.Equal(len(records), 3, "three new SKUs; the jobs on sku.extract")
	keys := ctx.Kafka.Keys("sku.extract")
	sort.Strings(keys)
	ctx.Equal(keys, []string{"m-1", "m-1", "m-2"}, "jobs must be keyed by the merchant; the keys")
	partitions := map[int]bool{}
	for _, r := range records {
		if string(r.Key) == "m-1" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "one merchant, one partition; the partitions of m-1's jobs")
}

func CheckDeadLetter(ctx *harness.Ctx) {
	ctx.Kafka.Seed("sku.upserted", "m-1", "{not json")
	intakeSeed(ctx, intakeSku("sku-2", "m-1", "   "))
	intakeSeed(ctx, intakeSku("sku-3", "m-1", strings.Repeat("X", 5000)))
	many := intakeSku("sku-4", "m-1", intakeTitle)
	images := []string{}
	for i := 0; i < 9; i++ {
		images = append(images, fmt.Sprintf("img/%d.jpg", i))
	}
	many["images"] = images
	intakeSeed(ctx, many)
	intakeSeed(ctx, intakeSku("sku-5", "m-1", intakeTitle))
	ctx.NoError(intakeRun(ctx), "a malformed record stopped the consumer: every record behind it on the partition is stuck")
	dlq := ctx.Kafka.Records("sku.upserted.dlq")
	ctx.Equal(len(dlq), 4, "four malformed records (not JSON, a blank title, a 5000-byte title, nine images); the records on sku.upserted.dlq")
	for _, r := range dlq {
		reason, ok := r.Header("reason")
		ctx.Assert(ok && len(reason) > 0, "a dead-lettered record carries no reason header: %.40s", r.Value)
	}
	ids := []string{}
	for _, job := range intakeJobs(ctx) {
		ids = append(ids, job.SkuID)
	}
	ctx.Equal(ids, []string{"sku-5"}, "only the well-formed record may become a job; sku.extract holds")
	ctx.Equal(ctx.Kafka.Lag(intakeGroup, "sku.upserted"), 0, "dead-lettered records must be committed too, or they are redelivered forever; the lag")
}

func CheckContentHash(ctx *harness.Ctx) {
	v1 := intakeSku("sku-1", "m-1", intakeTitle)
	intakeSeed(ctx, v1)
	resent := intakeSku("sku-1", "m-1", intakeTitle)
	resent["images"] = []string{"img/b.jpg", "img/a.jpg"} // the merchant re-sends its feed
	intakeSeed(ctx, resent)
	v2Title := "DOVE SILK GLOW BODY WASH 750ML"
	intakeSeed(ctx, intakeSku("sku-1", "m-1", v2Title))
	store.PutHash(intakeBg, "sku-7", store.ContentHash("m-1", "OATLY OAT MILK 1L", "Nourishing body wash", []string{"img/a.jpg", "img/b.jpg"})) // enqueued before the last restart
	intakeSeed(ctx, intakeSku("sku-7", "m-1", "OATLY OAT MILK 1L"))
	ctx.NoError(intakeRun(ctx), "the consumer stopped")
	jobs := intakeJobs(ctx)
	titles := []string{}
	for _, job := range jobs {
		titles = append(titles, job.SkuID+" "+job.Title)
	}
	ctx.Equal(titles, []string{"sku-1 " + intakeTitle, "sku-1 " + v2Title}, "a re-sent SKU must be skipped, a changed one enqueued and one enqueued before a restart skipped; sku.extract holds")
	expected := store.ContentHash("m-1", v2Title, "Nourishing body wash", []string{"img/a.jpg", "img/b.jpg"})
	ctx.Equal(jobs[1].ContentHash, expected, "the job must carry store.ContentHash of the SKU; its content_hash")
	last, _ := store.LastHash(intakeBg, "sku-1")
	ctx.Equal(last, expected, "store.LastHash(sku-1) once the changed title was enqueued")
}

func CheckCommitAfterEnqueue(ctx *harness.Ctx) {
	intakeSeed(ctx, intakeSku("sku-1", "m-1", intakeTitle))
	ctx.Kafka.FailNext("sku.extract", 1)
	intakeRun(ctx)
	ctx.Equal(ctx.Kafka.Lag(intakeGroup, "sku.upserted"), 1, "the broker refused the job: commit only after the job is on sku.extract, or the SKU is lost; the uncommitted records")
	_, stored := store.LastHash(intakeBg, "sku-1")
	ctx.Assert(!stored, "the content hash was stored for a job that never reached sku.extract: the redelivery would be skipped")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

#include "enrich/store.h"

namespace {

const std::string kIntakeGroup = "catalog-enrichment";
const std::string kIntakeTitle = "DOVE SILK GLOW BODY WASH 500ML";

nlohmann::json intakeSku(const std::string& sku_id, const std::string& merchant, const std::string& title) {
  return {{"merchant", merchant}, {"sku_id", sku_id}, {"title", title}, {"description", "Nourishing body wash"}, {"images", {"img/a.jpg", "img/b.jpg"}}};
}

void intakeSeed(harness::Ctx& ctx, const nlohmann::json& record) {
  ctx.Kafka.Seed("sku.upserted", record["merchant"].get<std::string>(), record.dump());
}

// One life of the consumer; what it threw, if anything.
std::string intakeRun(harness::Ctx& ctx) {
  try {
    ctx.Drain([] { consume(); });
  } catch (const std::exception& e) {
    return std::string(e.what()).empty() ? "an exception" : e.what();
  }
  return "";
}

std::vector<nlohmann::json> intakeJobs(harness::Ctx& ctx) {
  std::vector<nlohmann::json> jobs;
  for (const auto& r : ctx.Kafka.Records("sku.extract")) jobs.push_back(nlohmann::json::parse(r.Value.value_or(""), nullptr, false));
  return jobs;
}

}  // namespace

void CheckMerchantKey(harness::Ctx& ctx) {
  intakeSeed(ctx, intakeSku("sku-1", "m-1", kIntakeTitle));
  intakeSeed(ctx, intakeSku("sku-2", "m-2", kIntakeTitle));
  intakeSeed(ctx, intakeSku("sku-3", "m-1", kIntakeTitle));
  const std::string err = intakeRun(ctx);
  ctx.Assert(err.empty(), "three well-formed records stopped the consumer: %s", err);
  const auto records = ctx.Kafka.Records("sku.extract");
  ctx.Equal(records.size(), 3, "three new SKUs; the jobs on sku.extract");
  auto keys = ctx.Kafka.Keys("sku.extract");
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, {"m-1", "m-1", "m-2"}, "jobs must be keyed by the merchant; the keys");
  std::set<int> partitions;
  for (const auto& r : records)
    if (r.Key.value_or("") == "m-1") partitions.insert(r.Partition);
  ctx.Equal(partitions.size(), 1, "one merchant, one partition; the partitions of m-1's jobs");
}

void CheckDeadLetter(harness::Ctx& ctx) {
  ctx.Kafka.Seed("sku.upserted", std::string("m-1"), std::string("{not json"));
  intakeSeed(ctx, intakeSku("sku-2", "m-1", "   "));
  intakeSeed(ctx, intakeSku("sku-3", "m-1", std::string(5000, 'X')));
  auto many = intakeSku("sku-4", "m-1", kIntakeTitle);
  many["images"] = nlohmann::json::array();
  for (int i = 0; i < 9; i++) many["images"].push_back("img/" + std::to_string(i) + ".jpg");
  intakeSeed(ctx, many);
  intakeSeed(ctx, intakeSku("sku-5", "m-1", kIntakeTitle));
  const std::string err = intakeRun(ctx);
  ctx.Assert(err.empty(), "a malformed record stopped the consumer (%s): every record behind it on the partition is stuck", err);
  const auto dlq = ctx.Kafka.Records("sku.upserted.dlq");
  ctx.Equal(dlq.size(), 4, "four malformed records (not JSON, a blank title, a 5000-byte title, nine images); the records on sku.upserted.dlq");
  for (const auto& r : dlq) ctx.Assert(!r.Header("reason").value_or("").empty(), "a dead-lettered record carries no reason header: %s", r.Value.value_or("").substr(0, 40));
  std::vector<std::string> ids;
  for (const auto& job : intakeJobs(ctx)) ids.push_back(job.value("sku_id", ""));
  ctx.Equal(ids, {"sku-5"}, "only the well-formed record may become a job; sku.extract holds");
  ctx.Equal(ctx.Kafka.Lag(kIntakeGroup, "sku.upserted"), 0, "dead-lettered records must be committed too, or they are redelivered forever; the lag");
}

void CheckContentHash(harness::Ctx& ctx) {
  const auto v1 = intakeSku("sku-1", "m-1", kIntakeTitle);
  intakeSeed(ctx, v1);
  auto resent = v1;
  resent["images"] = {"img/b.jpg", "img/a.jpg"};  // the merchant re-sends its feed
  intakeSeed(ctx, resent);
  const std::string v2_title = "DOVE SILK GLOW BODY WASH 750ML";
  intakeSeed(ctx, intakeSku("sku-1", "m-1", v2_title));
  store::put_hash("sku-7", store::content_hash("m-1", "OATLY OAT MILK 1L", "Nourishing body wash", {"img/a.jpg", "img/b.jpg"}));  // enqueued before the last restart
  intakeSeed(ctx, intakeSku("sku-7", "m-1", "OATLY OAT MILK 1L"));
  const std::string err = intakeRun(ctx);
  ctx.Assert(err.empty(), "the consumer stopped: %s", err);
  const auto jobs = intakeJobs(ctx);
  std::vector<std::string> titles;
  for (const auto& job : jobs) titles.push_back(job.value("sku_id", "") + " " + job.value("title", ""));
  ctx.Equal(titles, {"sku-1 " + kIntakeTitle, "sku-1 " + v2_title}, "a re-sent SKU must be skipped, a changed one enqueued and one enqueued before a restart skipped; sku.extract holds");
  const std::string expected = store::content_hash("m-1", v2_title, "Nourishing body wash", {"img/a.jpg", "img/b.jpg"});
  ctx.Equal(jobs[1].value("content_hash", ""), expected, "the job must carry store::content_hash of the SKU; its content_hash");
  ctx.Equal(store::last_hash("sku-1").value_or(""), expected, "store::last_hash(sku-1) once the changed title was enqueued");
}

void CheckCommitAfterEnqueue(harness::Ctx& ctx) {
  intakeSeed(ctx, intakeSku("sku-1", "m-1", kIntakeTitle));
  ctx.Kafka.FailNext("sku.extract", 1);
  intakeRun(ctx);
  ctx.Equal(ctx.Kafka.Lag(kIntakeGroup, "sku.upserted"), 1, "the broker refused the job: commit only after the job is on sku.extract, or the SKU is lost; the uncommitted records");
  ctx.Assert(!store::last_hash("sku-1"), "the content hash was stored for a job that never reached sku.extract: the redelivery would be skipped");
}
`,
  },
  debrief: `Commit-after-work is what turns "the broker refused it" into a redelivery instead of a loss, and it only holds with auto-commit off: the timer would otherwise commit records the code never finished. The merchant key keeps one merchant's versions of a SKU in order on one partition, so an old title never overtakes a new one. The dead-letter topic isolates a bad record without stopping the partition, and the reason header is what lets an operator fix the merchant's feed. The content hash lives in Redis beside the SKU, so a re-sent feed is free after a restart and a corrected title is extracted again. A larger intake would validate against a schema registry, alert on per-merchant dead-letter rates, and replay the dead-letter topic once the merchant fixes the feed.`,
};
