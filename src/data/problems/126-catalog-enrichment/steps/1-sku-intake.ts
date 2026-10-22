import type {Step} from '@/lib/types';

export const skuIntakeStep: Step = {
  id: 'sku-intake',
  title: 'sku.upserted: validate, content-hash, enqueue, then commit',
  concept: 'kafka',
  file: 'sku_intake',
  focus: ['feed', 'upserted', 'catalogd', 'taxonomy'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it subscribes to the topic,
parses each record, skips SKUs it has seen and enqueues an extraction job. It compiles, it moves
records in the demo, and it hides five production flaws. Review it like the owner of the catalog
pipeline, fix it, and prove the fix with the checks below.

Implement the intake consumer for \`sku.upserted\`. Each record is keyed by merchant and carries
\`{"merchant": "safeway", "sku_id": "sfw-1023", "title": "…", "description": "…", "images": ["…"]}\`.

- Consume in group **\`catalog-enrichment\`** with **auto-commit disabled**; the offset is committed
  by your code, after the work.
- **Validate** before anything else: \`merchant\`, \`sku_id\` and a non-blank \`title\` are
  required; the title is at most **4 KiB** (\`MAX_TITLE_BYTES = 4096\`), the description at most
  **16 KiB**, and at most **8** image refs. A malformed record — including unparseable JSON — is
  produced to **\`sku.upserted.dlq\`** with a \`reason\` header and its offset committed, so one bad
  record neither crashes the group nor disappears.
- **Dedupe by content**, not by id: hash the canonical \`(merchant, title, description, sorted
  images)\` with **SHA-256** and compare it with the hash stored for the SKU (\`store.last_hash\`).
  A merchant re-sends its whole feed nightly; an unchanged SKU must not cost an extraction, and a
  changed one must not be skipped because its id was "seen".
- **Enqueue** the job on \`sku.extract\` with the **merchant as the message key**, so all of one
  merchant's SKUs — and every version of one SKU — stay ordered in one partition.
- **Commit after the enqueue** (and after the hash is stored). Commit first and a crash between the
  commit and the enqueue loses the SKU until the merchant's next full feed.

**Failure mode the checks target.** A consumer with auto-commit and an early commit looks correct
in a demo where nothing crashes; in production it drops SKUs silently. The in-memory "seen" set is
the subtle one: it re-extracts every SKU after a restart and skips every genuine update before
one — the opposite of what the catalog needs in both directions.`,
  sequence: {
    participants: ['sku.upserted', 'catalogd', 'sku store', 'sku.extract'],
    messages: [
      {from: 'sku.upserted', to: 'catalogd', label: 'fetch · key = merchant · group catalog-enrichment', kind: 'async'},
      {from: 'catalogd', to: 'catalogd', label: 'validate · dlq on failure', kind: 'sync'},
      {from: 'catalogd', to: 'catalogd', label: 'sha256(merchant, title, description, images)', kind: 'sync'},
      {from: 'catalogd', to: 'sku store', label: 'last_hash(sku_id)', kind: 'sync'},
      {from: 'sku store', to: 'catalogd', label: 'stored hash / none', kind: 'reply'},
      {from: 'catalogd', to: 'sku.extract', label: 'produce job · key = merchant', kind: 'sync'},
      {from: 'catalogd', to: 'sku store', label: 'put_hash(sku_id, hash)', kind: 'sync'},
      {from: 'catalogd', to: 'sku.upserted', label: 'commit offset after the enqueue', kind: 'async'},
    ],
  },
  hints: [
    'Turn auto-commit off in the consumer configuration (`enable.auto.commit`, `autoCommit: false`, `FetchMessage` instead of `ReadMessage`) and move the commit to the last line of the loop body. Everything the record needs — validation, dead-letter, hash, enqueue, hash store — happens before it.',
    'The dedupe key is a hash of the content, not the id: build a canonical JSON of merchant, title, description and the sorted image refs, SHA-256 it, and compare with `store.last_hash(sku_id)`. Store the new hash only after the enqueue succeeded, so a crash in between replays the record instead of losing it.',
    'Validation has two outcomes and both commit: a good record is enqueued with `key=merchant`; a bad one is produced to `sku.upserted.dlq` with a `reason` header. Neither raises out of the loop — a poison record that crashes the consumer stalls the whole merchant partition.',
  ],
  checks: [
    {
      id: 'manual-commit',
      title: 'Consumes in group catalog-enrichment with auto-commit off',
      detail:
        'The consumer joins group `catalog-enrichment` with auto-commit disabled (`enable.auto.commit=false`, `autoCommit: false`, kafka-go `FetchMessage` + `CommitMessages`). With auto-commit the offset moves on a timer, regardless of whether the record was enqueued.',
      match: {
        python: {all: [/["']group\.id["']\s*:\s*GROUP/, /["']enable\.auto\.commit["']\s*:\s*False/]},
        typescript: {all: [/groupId:\s*GROUP/, /autoCommit:\s*false/]},
        go: {all: [/GroupID:\s*group\b/, /\.FetchMessage\(/, /\.CommitMessages\(/], none: [/\.ReadMessage\(/]},
        scala: {all: [/GROUP_ID_CONFIG,\s*Group\b/, /ENABLE_AUTO_COMMIT_CONFIG,\s*"false"/]},
        cpp: {all: [/"group\.id",\s*kGroup/, /"enable\.auto\.commit",\s*"false"/]},
      },
    },
    {
      id: 'validate-dlq',
      title: 'Validates the record and dead-letters malformed ones',
      detail:
        'Titles are capped at `MAX_TITLE_BYTES = 4096`, descriptions at 16 KiB and images at 8 refs; a record that fails validation or does not parse is produced to `sku.upserted.dlq` with a reason. The draft trusts every record and crashes on the first malformed one.',
      match: {
        python: {
          all: [/MAX_TITLE_BYTES\s*=\s*4096/, /MAX_DESCRIPTION_BYTES/, /MAX_IMAGES\s*=\s*8/, /sku\.upserted\.dlq/],
        },
        typescript: {
          all: [/MAX_TITLE_BYTES\s*=\s*4096/, /MAX_DESCRIPTION_BYTES/, /MAX_IMAGES\s*=\s*8/, /sku\.upserted\.dlq/],
        },
        go: {all: [/maxTitleBytes\s*=\s*4096/, /maxDescriptionBytes/, /maxImages\s*=\s*8/, /sku\.upserted\.dlq/]},
        scala: {all: [/MaxTitleBytes\s*=\s*4096/, /MaxDescriptionBytes/, /MaxImages\s*=\s*8/, /sku\.upserted\.dlq/]},
        cpp: {all: [/kMaxTitleBytes\s*=\s*4096/, /kMaxDescriptionBytes/, /kMaxImages\s*=\s*8/, /sku\.upserted\.dlq/]},
      },
    },
    {
      id: 'content-hash',
      title: 'Dedupes by SHA-256 of the content, compared with the stored hash',
      detail:
        'The record is hashed (SHA-256 over merchant, title, description and sorted images) and compared with `store.last_hash(sku_id)`; the new hash is stored after the enqueue. The draft keeps an in-memory set of ids: it forgets on restart and never notices a changed title.',
      match: {
        python: {all: [/hashlib\.sha256\(/, /store\.last_hash\(/, /store\.put_hash\(/], none: [/\bseen\b/]},
        typescript: {
          all: [/createHash\(\s*['"]sha256['"]\s*\)/, /store\.lastHash\(/, /store\.putHash\(/],
          none: [/\bseen\b/],
        },
        go: {all: [/sha256\.Sum256\(/, /store\.LastHash\(/, /store\.PutHash\(/], none: [/\bseen\b/]},
        scala: {
          all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/, /store\.lastHash\(/, /store\.putHash\(/],
          none: [/\bseen\b/],
        },
        cpp: {all: [/sha256Hex\(/, /store\.lastHash\(/, /store\.putHash\(/], none: [/\bseen\b/]},
      },
    },
    {
      id: 'merchant-key',
      title: 'Enqueues the extraction job keyed by merchant',
      detail:
        'The job on `sku.extract` carries the merchant as its message key, so one merchant’s SKUs and every version of one SKU stay in one partition, in order. The draft produces without a key and lets two versions of the same SKU race across partitions.',
      match: {
        python: {all: [/produce\(\s*EXTRACT_TOPIC,\s*key=merchant/]},
        typescript: {all: [/topic:\s*EXTRACT_TOPIC/, /key:\s*merchant\b/]},
        go: {all: [/Key:\s*\[\]byte\(merchant\)/]},
        scala: {all: [/ProducerRecord\(\s*ExtractTopic,\s*merchant\b/]},
        cpp: {all: [/produce\(\s*kExtractTopic[^;]*merchant\.data\(\)/]},
      },
    },
    {
      id: 'commit-after-enqueue',
      title: 'Commits the offset after the enqueue',
      detail:
        'The offset commit is the last thing that happens to a record: after the dead-letter or the enqueue and the hash store. The draft commits as soon as it has polled, so a crash before the enqueue loses the SKU.',
      match: {
        python: {order: [/jobs\.enqueue\(/, /consumer\.commit\(/]},
        typescript: {order: [/jobs\.enqueue\(/, /commitOffsets\(/]},
        go: {order: [/jobs\.Enqueue\(/, /\.CommitMessages\(/]},
        scala: {order: [/jobs\.enqueue\(/, /consumer\.commitSync\(/]},
        cpp: {order: [/jobs\.enqueue\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Consumer, Producer

TOPIC = "sku.upserted"
EXTRACT_TOPIC = "sku.extract"
GROUP = "catalog-enrichment"

consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP})
producer = Producer({"bootstrap.servers": "kafka:9092"})


class ExtractQueue:
    def enqueue(self, merchant: str, job: dict) -> None:
        producer.produce(EXTRACT_TOPIC, value=json.dumps(job))
        producer.flush(2.0)


jobs = ExtractQueue()
seen: set[str] = set()


def consume() -> None:
    # TODO: this draft auto-commits and commits before the enqueue, trusts every record, dedupes
    # by an in-memory set of ids, and produces the job without a key. Review all five.
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        sku_id = event["sku_id"]
        if sku_id in seen:
            continue
        seen.add(sku_id)
        jobs.enqueue(
            event["merchant"],
            {
                "sku_id": sku_id,
                "merchant": event["merchant"],
                "title": event["title"],
                "description": event.get("description", ""),
                "images": event.get("images", []),
            },
        )
`,
      solution: `import hashlib
import json

from confluent_kafka import Consumer, KafkaException, Message, Producer

TOPIC = "sku.upserted"
DLQ_TOPIC = "sku.upserted.dlq"
EXTRACT_TOPIC = "sku.extract"
GROUP = "catalog-enrichment"
MAX_TITLE_BYTES = 4096
MAX_DESCRIPTION_BYTES = 16384
MAX_IMAGES = 8

consumer = Consumer(
    {"bootstrap.servers": "kafka:9092", "group.id": GROUP, "enable.auto.commit": False}
)
producer = Producer({"bootstrap.servers": "kafka:9092"})


class SkuStore:
    def last_hash(self, sku_id: str) -> str | None:
        """Content hash of the version last enqueued for this SKU, if any."""
        raise NotImplementedError

    def put_hash(self, sku_id: str, content_hash: str) -> None:
        raise NotImplementedError


class ExtractQueue:
    def enqueue(self, merchant: str, job: dict) -> None:
        producer.produce(EXTRACT_TOPIC, key=merchant, value=json.dumps(job))
        producer.flush(2.0)


store = SkuStore()
jobs = ExtractQueue()


def content_hash(event: dict) -> str:
    canonical = json.dumps(
        {
            "merchant": event["merchant"],
            "title": event["title"],
            "description": event.get("description", ""),
            "images": sorted(event.get("images", [])),
        },
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate(event: dict) -> str | None:
    """The reason the record is unusable, or None when it is well-formed."""
    if not isinstance(event.get("merchant"), str) or event["merchant"] == "":
        return "merchant is required"
    if not isinstance(event.get("sku_id"), str) or event["sku_id"] == "":
        return "sku_id is required"
    title = event.get("title")
    if not isinstance(title, str) or title.strip() == "":
        return "title is required"
    if len(title.encode("utf-8")) > MAX_TITLE_BYTES:
        return "title exceeds 4 KiB"
    description = event.get("description", "")
    if not isinstance(description, str) or len(description.encode("utf-8")) > MAX_DESCRIPTION_BYTES:
        return "description exceeds 16 KiB"
    images = event.get("images", [])
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        return "images must be a list of at most 8 refs"
    if any(not isinstance(ref, str) for ref in images):
        return "image refs must be strings"
    return None


def dead_letter(msg: Message, reason: str) -> None:
    producer.produce(DLQ_TOPIC, key=msg.key(), value=msg.value(), headers={"reason": reason})
    producer.flush(2.0)


def intake(msg: Message) -> None:
    """Dead-letter or enqueue one record; returns only once the work is durable."""
    try:
        event = json.loads(msg.value())
    except ValueError:
        dead_letter(msg, "invalid json")
        return
    if not isinstance(event, dict):
        dead_letter(msg, "record is not an object")
        return
    reason = validate(event)
    if reason is not None:
        dead_letter(msg, reason)
        return
    digest = content_hash(event)
    if store.last_hash(event["sku_id"]) == digest:
        return
    jobs.enqueue(
        event["merchant"],
        {
            "sku_id": event["sku_id"],
            "merchant": event["merchant"],
            "content_hash": digest,
            "title": event["title"],
            "description": event.get("description", ""),
            "images": event.get("images", []),
        },
    )
    store.put_hash(event["sku_id"], digest)


def consume() -> None:
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            raise KafkaException(msg.error())
        intake(msg)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** sku.upserted intake: a model-generated draft that commits early and dedupes by id. */
import {Kafka} from 'kafkajs';

const TOPIC = 'sku.upserted';
const EXTRACT_TOPIC = 'sku.extract';
const GROUP = 'catalog-enrichment';

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface SkuUpserted {
  merchant: string;
  sku_id: string;
  title: string;
  description?: string;
  images?: string[];
}

class ExtractQueue {
  async enqueue(merchant: string, job: Record<string, unknown>): Promise<void> {
    await producer.send({topic: EXTRACT_TOPIC, messages: [{value: JSON.stringify(job)}]});
  }
}

const jobs = new ExtractQueue();
const seen = new Set<string>();

export async function consume(): Promise<void> {
  // TODO: this draft commits before the enqueue, trusts every record, dedupes by an in-memory set
  // of ids, and produces the job without a key. Review all five.
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as SkuUpserted;
      if (seen.has(event.sku_id)) return;
      seen.add(event.sku_id);
      await jobs.enqueue(event.merchant, {
        sku_id: event.sku_id,
        merchant: event.merchant,
        title: event.title,
        description: event.description ?? '',
        images: event.images ?? [],
      });
    },
  });
}
`,
      solution: `/** sku.upserted intake: validated, content-hashed, enqueued by merchant, then committed. */
import {createHash} from 'node:crypto';

import {Kafka, type KafkaMessage} from 'kafkajs';

import {store} from './store';

const TOPIC = 'sku.upserted';
const DLQ_TOPIC = 'sku.upserted.dlq';
const EXTRACT_TOPIC = 'sku.extract';
const GROUP = 'catalog-enrichment';
const MAX_TITLE_BYTES = 4096;
const MAX_DESCRIPTION_BYTES = 16384;
const MAX_IMAGES = 8;

const kafka = new Kafka({clientId: 'catalogd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface SkuUpserted {
  merchant: string;
  sku_id: string;
  title: string;
  description?: string;
  images?: string[];
}

class ExtractQueue {
  async enqueue(merchant: string, job: Record<string, unknown>): Promise<void> {
    await producer.send({topic: EXTRACT_TOPIC, messages: [{key: merchant, value: JSON.stringify(job)}]});
  }
}

const jobs = new ExtractQueue();

function contentHash(event: SkuUpserted): string {
  const canonical = JSON.stringify({
    merchant: event.merchant,
    title: event.title,
    description: event.description ?? '',
    images: [...(event.images ?? [])].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** The reason the record is unusable, or null when it is well-formed. */
function validate(event: Partial<SkuUpserted>): string | null {
  if (typeof event.merchant !== 'string' || event.merchant === '') return 'merchant is required';
  if (typeof event.sku_id !== 'string' || event.sku_id === '') return 'sku_id is required';
  if (typeof event.title !== 'string' || event.title.trim() === '') return 'title is required';
  if (Buffer.byteLength(event.title, 'utf8') > MAX_TITLE_BYTES) return 'title exceeds 4 KiB';
  const description = event.description ?? '';
  if (typeof description !== 'string' || Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES)
    return 'description exceeds 16 KiB';
  const images = event.images ?? [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return 'images must be a list of at most 8 refs';
  if (images.some(ref => typeof ref !== 'string')) return 'image refs must be strings';
  return null;
}

async function deadLetter(message: KafkaMessage, reason: string): Promise<void> {
  await producer.send({
    topic: DLQ_TOPIC,
    messages: [{key: message.key, value: message.value, headers: {reason}}],
  });
}

/** Dead-letter or enqueue one record; resolves only once the work is durable. */
async function intake(message: KafkaMessage): Promise<void> {
  let event: Partial<SkuUpserted>;
  try {
    event = JSON.parse(message.value?.toString() ?? '') as Partial<SkuUpserted>;
  } catch {
    await deadLetter(message, 'invalid json');
    return;
  }
  if (event === null || typeof event !== 'object') {
    await deadLetter(message, 'record is not an object');
    return;
  }
  const reason = validate(event);
  if (reason !== null) {
    await deadLetter(message, reason);
    return;
  }
  const sku = event as SkuUpserted;
  const digest = contentHash(sku);
  if ((await store.lastHash(sku.sku_id)) === digest) return;
  await jobs.enqueue(sku.merchant, {
    sku_id: sku.sku_id,
    merchant: sku.merchant,
    content_hash: digest,
    title: sku.title,
    description: sku.description ?? '',
    images: sku.images ?? [],
  });
  await store.putHash(sku.sku_id, digest);
}

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await intake(message);
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
	"log"

	"github.com/segmentio/kafka-go"
)

const (
	topic        = "sku.upserted"
	extractTopic = "sku.extract"
	group        = "catalog-enrichment"
)

type SkuUpserted struct {
	Merchant    string   \`json:"merchant"\`
	SkuID       string   \`json:"sku_id"\`
	Title       string   \`json:"title"\`
	Description string   \`json:"description"\`
	Images      []string \`json:"images"\`
}

type ExtractQueue struct {
	writer *kafka.Writer
}

func (q *ExtractQueue) Enqueue(ctx context.Context, merchant string, job map[string]any) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return err
	}
	return q.writer.WriteMessages(ctx, kafka.Message{Value: payload})
}

var (
	jobs = &ExtractQueue{writer: &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: extractTopic}}
	seen = map[string]bool{}
)

// TODO: this draft auto-commits on read, trusts every record, dedupes by an in-memory set of ids,
// and produces the job without a key. Review all five.
func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: group,
	})
	for {
		msg, err := reader.ReadMessage(ctx)
		if err != nil {
			log.Printf("read failed: %v", err)
			continue
		}
		var event SkuUpserted
		_ = json.Unmarshal(msg.Value, &event)
		if seen[event.SkuID] {
			continue
		}
		seen[event.SkuID] = true
		_ = jobs.Enqueue(ctx, event.Merchant, map[string]any{
			"sku_id":      event.SkuID,
			"merchant":    event.Merchant,
			"title":       event.Title,
			"description": event.Description,
			"images":      event.Images,
		})
	}
}

func main() {
	consume(context.Background())
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"strings"

	"github.com/segmentio/kafka-go"
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

type SkuUpserted struct {
	Merchant    string   \`json:"merchant"\`
	SkuID       string   \`json:"sku_id"\`
	Title       string   \`json:"title"\`
	Description string   \`json:"description"\`
	Images      []string \`json:"images"\`
}

// SkuStore remembers the content hash of the version last enqueued for each SKU.
type SkuStore struct{}

func (s *SkuStore) LastHash(ctx context.Context, skuID string) (string, error) {
	return "", nil
}

func (s *SkuStore) PutHash(ctx context.Context, skuID, contentHash string) error {
	return nil
}

type ExtractQueue struct {
	writer *kafka.Writer
}

func (q *ExtractQueue) Enqueue(ctx context.Context, merchant string, job map[string]any) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return err
	}
	return q.writer.WriteMessages(ctx, kafka.Message{Key: []byte(merchant), Value: payload})
}

var (
	store = &SkuStore{}
	jobs  = &ExtractQueue{writer: &kafka.Writer{
		Addr:     kafka.TCP("kafka:9092"),
		Topic:    extractTopic,
		Balancer: &kafka.Hash{},
	}}
	dlq = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: dlqTopic}
)

func contentHash(e SkuUpserted) string {
	images := append([]string(nil), e.Images...)
	sort.Strings(images)
	canonical, _ := json.Marshal(map[string]any{
		"merchant":    e.Merchant,
		"title":       e.Title,
		"description": e.Description,
		"images":      images,
	})
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}

// validate returns why the record is unusable, or nil when it is well-formed.
func validate(e SkuUpserted) error {
	if e.Merchant == "" {
		return errors.New("merchant is required")
	}
	if e.SkuID == "" {
		return errors.New("sku_id is required")
	}
	if strings.TrimSpace(e.Title) == "" {
		return errors.New("title is required")
	}
	if len(e.Title) > maxTitleBytes {
		return errors.New("title exceeds 4 KiB")
	}
	if len(e.Description) > maxDescriptionBytes {
		return errors.New("description exceeds 16 KiB")
	}
	if len(e.Images) > maxImages {
		return errors.New("images must be a list of at most 8 refs")
	}
	return nil
}

func deadLetter(ctx context.Context, msg kafka.Message, reason string) error {
	return dlq.WriteMessages(ctx, kafka.Message{
		Key:     msg.Key,
		Value:   msg.Value,
		Headers: []kafka.Header{{Key: "reason", Value: []byte(reason)}},
	})
}

// intake dead-letters or enqueues one record; it returns nil only once the work is durable.
func intake(ctx context.Context, msg kafka.Message) error {
	var event SkuUpserted
	if err := json.Unmarshal(msg.Value, &event); err != nil {
		return deadLetter(ctx, msg, "invalid json")
	}
	if err := validate(event); err != nil {
		return deadLetter(ctx, msg, err.Error())
	}
	digest := contentHash(event)
	last, err := store.LastHash(ctx, event.SkuID)
	if err != nil {
		return err
	}
	if last == digest {
		return nil
	}
	job := map[string]any{
		"sku_id":       event.SkuID,
		"merchant":     event.Merchant,
		"content_hash": digest,
		"title":        event.Title,
		"description":  event.Description,
		"images":       event.Images,
	}
	if err := jobs.Enqueue(ctx, event.Merchant, job); err != nil {
		return err
	}
	return store.PutHash(ctx, event.SkuID, digest)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   topic,
		GroupID: group,
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			log.Printf("fetch failed: %v", err)
			continue
		}
		if err := intake(ctx, msg); err != nil {
			log.Printf("intake failed, record will be redelivered: %v", err)
			continue
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			log.Printf("commit failed: %v", err)
		}
	}
}

func main() {
	consume(context.Background())
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

final case class SkuUpserted(
    merchant: String,
    sku_id: String,
    title: String,
    description: Option[String],
    images: Option[List[String]])

object SkuIntake {
  import DefaultJsonProtocol._
  implicit val skuFormat: RootJsonFormat[SkuUpserted] = jsonFormat5(SkuUpserted)

  val Topic = "sku.upserted"
  val ExtractTopic = "sku.extract"
  val Group = "catalog-enrichment"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")
    props
  })

  object jobs {
    def enqueue(merchant: String, job: JsObject): Unit =
      producer.send(new ProducerRecord(ExtractTopic, job.compactPrint)).get()
  }

  val seen = scala.collection.mutable.Set.empty[String]

  // TODO: this draft auto-commits and commits before the enqueue, trusts every record, dedupes by
  // an in-memory set of ids, and produces the job without a key. Review all five.
  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringDeserializer")
    props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringDeserializer")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.convertTo[SkuUpserted]
        if (!seen.contains(event.sku_id)) {
          seen += event.sku_id
          jobs.enqueue(
            event.merchant,
            JsObject(
              "sku_id" -> JsString(event.sku_id),
              "merchant" -> JsString(event.merchant),
              "title" -> JsString(event.title),
              "description" -> JsString(event.description.getOrElse("")),
              "images" -> JsArray(event.images.getOrElse(Nil).map(JsString(_)).toVector)
            )
          )
        }
      }
    }
  }

  def main(args: Array[String]): Unit = consume()
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, ConsumerRecord, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import org.apache.kafka.common.header.internals.RecordHeader
import spray.json._

final case class SkuUpserted(
    merchant: String,
    sku_id: String,
    title: String,
    description: Option[String],
    images: Option[List[String]])

object SkuIntake {
  import DefaultJsonProtocol._
  implicit val skuFormat: RootJsonFormat[SkuUpserted] = jsonFormat5(SkuUpserted)

  val Topic = "sku.upserted"
  val DlqTopic = "sku.upserted.dlq"
  val ExtractTopic = "sku.extract"
  val Group = "catalog-enrichment"
  val MaxTitleBytes = 4096
  val MaxDescriptionBytes = 16384
  val MaxImages = 8

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringSerializer")
    props
  })

  val store = SkuStore.open()

  object jobs {
    def enqueue(merchant: String, job: JsObject): Unit =
      producer.send(new ProducerRecord(ExtractTopic, merchant, job.compactPrint)).get()
  }

  def contentHash(event: SkuUpserted): String = {
    val canonical = JsObject(
      "merchant" -> JsString(event.merchant),
      "title" -> JsString(event.title),
      "description" -> JsString(event.description.getOrElse("")),
      "images" -> JsArray(event.images.getOrElse(Nil).sorted.map(JsString(_)).toVector)
    ).compactPrint
    val digest = MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8))
    digest.map("%02x".format(_)).mkString
  }

  /** Why the record is unusable, or None when it is well-formed. */
  def validate(event: SkuUpserted): Option[String] =
    if (event.merchant.isEmpty) Some("merchant is required")
    else if (event.sku_id.isEmpty) Some("sku_id is required")
    else if (event.title.trim.isEmpty) Some("title is required")
    else if (event.title.getBytes(StandardCharsets.UTF_8).length > MaxTitleBytes) Some("title exceeds 4 KiB")
    else if (event.description.getOrElse("").getBytes(StandardCharsets.UTF_8).length > MaxDescriptionBytes)
      Some("description exceeds 16 KiB")
    else if (event.images.getOrElse(Nil).length > MaxImages) Some("images must be a list of at most 8 refs")
    else None

  def deadLetter(record: ConsumerRecord[String, String], reason: String): Unit = {
    val dead = new ProducerRecord(DlqTopic, record.key(), record.value())
    dead.headers().add(new RecordHeader("reason", reason.getBytes(StandardCharsets.UTF_8)))
    producer.send(dead).get()
  }

  /** Dead-letter or enqueue one record; returns only once the work is durable. */
  def intake(record: ConsumerRecord[String, String]): Unit = {
    val parsed =
      try Right(record.value().parseJson.convertTo[SkuUpserted])
      catch { case e: Exception => Left(s"invalid record: \${e.getMessage}") }
    parsed match {
      case Left(reason) => deadLetter(record, reason)
      case Right(event) =>
        validate(event) match {
          case Some(reason) => deadLetter(record, reason)
          case None =>
            val digest = contentHash(event)
            if (!store.lastHash(event.sku_id).contains(digest)) {
              jobs.enqueue(
                event.merchant,
                JsObject(
                  "sku_id" -> JsString(event.sku_id),
                  "merchant" -> JsString(event.merchant),
                  "content_hash" -> JsString(digest),
                  "title" -> JsString(event.title),
                  "description" -> JsString(event.description.getOrElse("")),
                  "images" -> JsArray(event.images.getOrElse(Nil).map(JsString(_)).toVector)
                )
              )
              store.putHash(event.sku_id, digest)
            }
        }
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, Group)
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringDeserializer")
    props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, "org.apache.kafka.common.serialization.StringDeserializer")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        intake(record)
        consumer.commitSync()
      }
    }
  }

  def main(args: Array[String]): Unit = consume()
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <set>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "sku.upserted";
const std::string kExtractTopic = "sku.extract";
const std::string kGroup = "catalog-enrichment";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

struct ExtractQueue {
  void enqueue(const std::string& merchant, const json& job) {
    const auto payload = job.dump();
    producer->produce(kExtractTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                      const_cast<char*>(payload.data()), payload.size(), nullptr, 0, 0, nullptr);
    producer->flush(2000);
  }
};

ExtractQueue jobs;
std::set<std::string> seen;

// TODO: this draft auto-commits and commits before the enqueue, trusts every record, dedupes by
// an in-memory set of ids, and produces the job without a key. Review all five.
void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const auto* bytes = static_cast<const char*>(msg->payload());
    const json event = json::parse(bytes, bytes + msg->len());
    const auto skuId = event["sku_id"].get<std::string>();
    if (seen.count(skuId) > 0) continue;
    seen.insert(skuId);
    jobs.enqueue(event["merchant"].get<std::string>(),
                 json{{"sku_id", skuId},
                      {"merchant", event["merchant"]},
                      {"title", event["title"]},
                      {"description", event.value("description", std::string())},
                      {"images", event.value("images", json::array())}});
  }
}

int main() { consume(); }
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <algorithm>
#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kTopic = "sku.upserted";
const std::string kDlqTopic = "sku.upserted.dlq";
const std::string kExtractTopic = "sku.extract";
const std::string kGroup = "catalog-enrichment";
constexpr std::size_t kMaxTitleBytes = 4096;
constexpr std::size_t kMaxDescriptionBytes = 16384;
constexpr std::size_t kMaxImages = 8;

std::string sha256Hex(const std::string& bytes);

struct SkuStore {
  std::optional<std::string> lastHash(const std::string& skuId);
  void putHash(const std::string& skuId, const std::string& contentHash);
};

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
SkuStore store;

struct ExtractQueue {
  void enqueue(const std::string& merchant, const json& job) {
    const auto payload = job.dump();
    producer->produce(kExtractTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                      const_cast<char*>(payload.data()), payload.size(), merchant.data(), merchant.size(), 0,
                      nullptr);
    producer->flush(2000);
  }
};

ExtractQueue jobs;

std::string contentHash(const json& event) {
  auto images = event.value("images", std::vector<std::string>{});
  std::sort(images.begin(), images.end());
  const json canonical = {{"description", event.value("description", std::string())},
                          {"images", images},
                          {"merchant", event["merchant"]},
                          {"title", event["title"]}};
  return sha256Hex(canonical.dump());
}

// The reason the record is unusable, or nullopt when it is well-formed.
std::optional<std::string> validate(const json& event) {
  if (!event.is_object()) return "record is not an object";
  if (!event.contains("merchant") || !event["merchant"].is_string() || event["merchant"].get<std::string>().empty())
    return "merchant is required";
  if (!event.contains("sku_id") || !event["sku_id"].is_string() || event["sku_id"].get<std::string>().empty())
    return "sku_id is required";
  if (!event.contains("title") || !event["title"].is_string()) return "title is required";
  const auto title = event["title"].get<std::string>();
  if (title.find_first_not_of(" \\t\\r\\n") == std::string::npos) return "title is required";
  if (title.size() > kMaxTitleBytes) return "title exceeds 4 KiB";
  if (event.contains("description") &&
      (!event["description"].is_string() || event["description"].get<std::string>().size() > kMaxDescriptionBytes))
    return "description exceeds 16 KiB";
  if (event.contains("images")) {
    if (!event["images"].is_array() || event["images"].size() > kMaxImages) return "images must be a list of at most 8 refs";
    for (const auto& ref : event["images"])
      if (!ref.is_string()) return "image refs must be strings";
  }
  return std::nullopt;
}

void deadLetter(const RdKafka::Message& msg, const std::string& reason) {
  RdKafka::Headers* headers = RdKafka::Headers::create();
  headers->add("reason", reason);
  const std::string key = msg.key() ? *msg.key() : std::string();
  producer->produce(kDlqTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<void*>(msg.payload()), msg.len(), key.data(), key.size(), 0, headers, nullptr);
  producer->flush(2000);
}

// Dead-letter or enqueue one record; returns only once the work is durable.
void intake(const RdKafka::Message& msg) {
  const auto* bytes = static_cast<const char*>(msg.payload());
  const json event = json::parse(bytes, bytes + msg.len(), nullptr, false);
  if (event.is_discarded()) {
    deadLetter(msg, "invalid json");
    return;
  }
  if (const auto reason = validate(event)) {
    deadLetter(msg, *reason);
    return;
  }
  const auto skuId = event["sku_id"].get<std::string>();
  const auto merchant = event["merchant"].get<std::string>();
  const auto digest = contentHash(event);
  const auto last = store.lastHash(skuId);
  if (last && *last == digest) return;
  jobs.enqueue(merchant, json{{"sku_id", skuId},
                              {"merchant", merchant},
                              {"content_hash", digest},
                              {"title", event["title"]},
                              {"description", event.value("description", std::string())},
                              {"images", event.value("images", json::array())}});
  store.putHash(skuId, digest);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    intake(*msg);
    consumer->commitSync(msg.get());
  }
}

int main() { consume(); }
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated consumer for the three contracts a queue gives you only if you keep them: at-least-once (commit after the work, auto-commit off), ordering (the merchant key puts every version of a SKU in one partition) and poison-record isolation (a dead-letter topic with a reason instead of a crash or a silent skip). The content hash is the catalog-specific one: the source describes merchants whose feeds arrive in every format, re-sent in full, so identity-based dedupe is wrong twice — it forgets on restart and ignores real changes — and only a hash of the content, stored durably, tells an unchanged SKU from an updated one. The caps are cost control before cost: a 4 KiB title bounds the prompt that step 2 will build from it. Real intakes add schema registry validation, per-merchant lag alerts, and a replay tool for the dead-letter topic.`,
};
