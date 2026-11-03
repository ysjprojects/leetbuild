import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Sync events keyed by connector, with an outbox',
  concept: 'kafka',
  file: 'events',
  focus: ['hub', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter announces committed pages: \`sync_page(connector, page_token, page)\`
commits the page with \`commit_page\` (step 2, provided as \`hub.ledger\`) and, when it was applied,
produces a \`connector.sync\` event keyed by the source type with the source, the token reference,
the cursor, the record count and a sample of the records; \`consume_sync\` folds events into
\`health:{id}\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** Every GitHub connector shares one key, so one connector's health
waits behind another's backlog; a retained topic holds token references and customer records; a lost
acknowledgement writes an event twice and a leader failover loses one; a rejected produce vanishes;
and a consumer that crashes after committing loses the page from the health read.

- Key the event by **connector id**; the payload is \`{connector_id, cursor, records, at}\`: the
  record count and the epoch second.
- The producer is idempotent with \`acks=all\` (kafkajs \`idempotent: true\`, librdkafka
  \`enable.idempotence\`; kafka-go has no idempotent writer, so it takes \`RequireAll\`).
- A delivery the broker rejects (the delivery report, a rejected \`send\`, a \`WriteMessages\` error)
  appends \`{"key", "payload"}\` to the list \`outbox:connector.sync\`; the page stays committed.
- \`consume_sync\` (group \`connector-health\`) applies an event to \`health:{id}\` (\`last_success_at\`,
  \`pages\`, \`records\`) and commits its offset after.`,
  sequence: {
    participants: ['Sync worker', 'Redis ledger', 'connector.sync', 'Health consumer'],
    messages: [
      {from: 'Sync worker', to: 'Redis ledger', label: 'commit_page(id, t1, t2) → applied', kind: 'sync'},
      {from: 'Sync worker', to: 'connector.sync', label: 'produce key = connector id · acks = all', kind: 'sync'},
      {from: 'connector.sync', to: 'Sync worker', label: 'delivered · or rejected → RPUSH outbox', kind: 'reply'},
      {from: 'connector.sync', to: 'Health consumer', label: 'consume · group connector-health', kind: 'async'},
      {
        from: 'Health consumer',
        to: 'Redis ledger',
        label: 'HSET health:{id} last_success_at · HINCRBY pages',
        kind: 'sync',
      },
      {from: 'Health consumer', to: 'connector.sync', label: 'commit the offset after', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'connector-key',
      title: 'Keys the event by connector id',
      detail:
        "The record key is the connector id, so one connector's events stay ordered on one partition and connectors of one source spread across partitions; the starter keys by source type.",
      match: {
        python: {all: [/key\s*=\s*connector_id\b/], none: [/key\s*=\s*connector\[["']source_type["']\]/]},
        typescript: {all: [/key:\s*connector\.connector_id\b/], none: [/key:\s*connector\.source_type/]},
        go: {all: [/Key:\s*\[\]byte\(connector\.ConnectorID\)/], none: [/Key:\s*\[\]byte\(connector\.SourceType\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(Topic,\s*connector\.connectorId/],
          none: [/Topic,\s*connector\.sourceType/],
        },
        cpp: {
          all: [/connector\.connector_id\.c_str\(\)\s*,\s*connector\.connector_id\.(size|length)\(\)/],
          none: [/connector\.source_type\.c_str\(\)/],
        },
      },
    },
    {
      id: 'no-secrets',
      title: 'Carries ids and counts, no token and no records',
      detail:
        'The payload is `{connector_id, cursor, records, at}` with `records` the count: the token reference and record bodies stay out of a topic that is retained, replicated and read by every consumer.',
      match: {
        python: {all: [/["']records["']\s*:\s*len\(/], none: [/token_ref/, /\.body\b|sample/]},
        typescript: {all: [/records:\s*page\.records\.length/], none: [/token_ref/, /\.body\b|sample/]},
        go: {all: [/len\(page\.(GetRecords\(\)|Records)\)/], none: [/TokenRef/, /\.Body\b|GetBody\(|Sample/]},
        scala: {all: [/page\.records\.(size|length)/], none: [/tokenRef/, /\.body\b|sample/i]},
        cpp: {all: [/page\.records_size\(\)/], none: [/token_ref/, /\.body\(\)|sample/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'A retry after a lost acknowledgement must not duplicate the event (`enable.idempotence`, kafkajs `idempotent: true`) and a leader failover must not lose it (`acks=all`; kafka-go: `RequiredAcks: kafka.RequireAll`).',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce leaves an outbox row',
      detail:
        'When the delivery report says the broker rejected the event, `{"key", "payload"}` is appended to `outbox:connector.sync` for a relay to republish; logging the error drops the event for good.',
      match: {
        python: {all: [/outbox:connector\.sync|OUTBOX_KEY/, /\.rpush\(/]},
        typescript: {all: [/outbox:connector\.sync|OUTBOX_KEY/, /\.rpush\(/]},
        go: {all: [/outbox:connector\.sync|outboxKey/, /\.RPush\(/]},
        scala: {all: [/outbox:connector\.sync|OutboxKey/, /\.rpush\(/]},
        cpp: {all: [/outbox:connector\.sync|kOutboxKey/, /\.rpush\(/]},
      },
    },
    {
      id: 'apply-before-commit',
      title: 'Applies the event before committing its offset',
      detail:
        'The consumer writes `health:{id}` and commits the offset afterwards, so a crash in between replays the event; committing first loses it.',
      match: {
        python: {order: [/\n\s+apply_event\(/, /consumer\.commit\(/]},
        typescript: {order: [/\n\s+await applyEvent\(/, /commitOffsets\(/]},
        go: {order: [/applyEvent\(ctx,\s*event\)/, /CommitMessages\(/]},
        scala: {order: [/\n\s+applyEvent\(/, /commitSync\(/]},
        cpp: {order: [/\n\s+applyEvent\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

import redis
from confluent_kafka import Consumer, Producer

import vendor_pb2
from hub.ledger import commit_page

TOPIC = "connector.sync"
GROUP = "connector-health"
PRODUCE_TIMEOUT_S = 2.0

log = logging.getLogger("connectord.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("sync event not delivered: %s", err)


def sync_page(connector: dict, page_token: str, page: vendor_pb2.Page) -> dict | None:
    """Commit a fetched page to the ledger and announce it on connector.sync; None for a page already applied."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    result = commit_page(connector["connector_id"], page_token, page.next_cursor)
    if not result["applied"]:
        return None
    event = {
        "connector_id": connector["connector_id"],
        "source_type": connector["source_type"],
        "token_ref": connector["token_ref"],
        "cursor": result["cursor"],
        "records": len(page.records),
        "sample": [record.body for record in page.records[:3]],  # a preview for the sync dashboard
        "at": int(time.time()),
    }
    producer.produce(TOPIC, key=connector["source_type"], value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(PRODUCE_TIMEOUT_S)
    return event


def apply_event(event: dict) -> None:
    """Fold one sync event into the connector's health: the last page that landed and the totals."""
    key = f"health:{event['connector_id']}"
    r.hset(key, "last_success_at", event["at"])
    r.hincrby(key, "pages", 1)
    r.hincrby(key, "records", event["records"])


def consume_sync() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        consumer.commit(message=msg, asynchronous=False)
        apply_event(json.loads(msg.value()))
`,
      solution: `import json
import logging
import time

import redis
from confluent_kafka import Consumer, Producer

import vendor_pb2
from hub.ledger import commit_page

TOPIC = "connector.sync"
GROUP = "connector-health"
OUTBOX_KEY = "outbox:connector.sync"
PRODUCE_TIMEOUT_S = 2.0

log = logging.getLogger("connectord.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
# Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def sync_page(connector: dict, page_token: str, page: vendor_pb2.Page) -> dict | None:
    """Commit a fetched page to the ledger and announce it on connector.sync; None for a page already applied."""
    connector_id = connector["connector_id"]
    result = commit_page(connector_id, page_token, page.next_cursor)
    if not result["applied"]:
        return None
    # Ids and counts: the token reference and the records are not the topic's to keep.
    event = {"connector_id": connector_id, "cursor": result["cursor"], "records": len(page.records), "at": int(time.time())}
    payload = json.dumps(event)
    rejected = []

    def on_delivery(err, msg) -> None:
        if err is not None:
            rejected.append(err)

    producer.produce(TOPIC, key=connector_id, value=payload, on_delivery=on_delivery)
    producer.flush(PRODUCE_TIMEOUT_S)  # the delivery report fires here, delivered or rejected
    if rejected:
        r.rpush(OUTBOX_KEY, json.dumps({"key": connector_id, "payload": payload}))
        log.warning("sync event for %s rejected (%s), kept in %s", connector_id, rejected[0], OUTBOX_KEY)
    return event


def apply_event(event: dict) -> None:
    """Fold one sync event into the connector's health: the last page that landed and the totals."""
    key = f"health:{event['connector_id']}"
    r.hset(key, "last_success_at", event["at"])
    r.hincrby(key, "pages", 1)
    r.hincrby(key, "records", event["records"])


def consume_sync() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": GROUP, "auto.offset.reset": "earliest", "enable.auto.commit": False})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        apply_event(json.loads(msg.value()))
        consumer.commit(message=msg, asynchronous=False)  # only once health:{id} holds the event
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {commitPage} from 'hub/ledger';
import type {Connector} from 'hub/store';

export const TOPIC = 'connector.sync';
export const GROUP = 'connector-health';

export interface Page {
  records: {id: string; body: string}[];
  next_cursor: string;
}

export interface SyncEvent {
  connector_id: string;
  cursor: string;
  records: number;
  at: number;
  [field: string]: unknown;
}

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'connectord', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Commit a fetched page to the ledger and announce it on connector.sync; null for a page already applied. */
export async function syncPage(connector: Connector, pageToken: string, page: Page): Promise<SyncEvent | null> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const result = await commitPage(connector.connector_id, pageToken, page.next_cursor);
  if (!result.applied) return null;
  const event: SyncEvent = {
    connector_id: connector.connector_id,
    source_type: connector.source_type,
    token_ref: connector.token_ref,
    cursor: result.cursor,
    records: page.records.length,
    sample: page.records.slice(0, 3).map(record => record.body), // a preview for the sync dashboard
    at: Math.floor(Date.now() / 1000),
  };
  await producer
    .send({topic: TOPIC, messages: [{key: connector.source_type, value: JSON.stringify(event)}], acks: 1})
    .catch((e: Error) => console.warn(\`sync event not delivered: \${e.message}\`));
  return event;
}

/** Fold one sync event into the connector's health: the last page that landed and the totals. */
export async function applyEvent(event: SyncEvent): Promise<void> {
  const key = \`health:\${event.connector_id}\`;
  await redis.hset(key, 'last_success_at', event.at);
  await redis.hincrby(key, 'pages', 1);
  await redis.hincrby(key, 'records', event.records);
}

export async function consumeSync(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await applyEvent(JSON.parse(String(message.value)) as SyncEvent);
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {commitPage} from 'hub/ledger';
import type {Connector} from 'hub/store';

export const TOPIC = 'connector.sync';
export const GROUP = 'connector-health';
export const OUTBOX_KEY = 'outbox:connector.sync';

export interface Page {
  records: {id: string; body: string}[];
  next_cursor: string;
}

export interface SyncEvent {
  connector_id: string;
  cursor: string;
  records: number;
  at: number;
}

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'connectord', brokers: ['kafka:9092']});
// Idempotent (which needs acks -1, all): a retry after a lost acknowledgement writes the event once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Commit a fetched page to the ledger and announce it on connector.sync; null for a page already applied. */
export async function syncPage(connector: Connector, pageToken: string, page: Page): Promise<SyncEvent | null> {
  const result = await commitPage(connector.connector_id, pageToken, page.next_cursor);
  if (!result.applied) return null;
  // Ids and counts: the token reference and the records are not the topic's to keep.
  const event: SyncEvent = {connector_id: connector.connector_id, cursor: result.cursor, records: page.records.length, at: Math.floor(Date.now() / 1000)};
  const payload = JSON.stringify(event);
  try {
    await producer.send({topic: TOPIC, messages: [{key: connector.connector_id, value: payload}], acks: -1});
  } catch (e) {
    await redis.rpush(OUTBOX_KEY, JSON.stringify({key: connector.connector_id, payload}));
    console.warn(\`sync event for \${connector.connector_id} rejected (\${(e as Error).message}), kept in \${OUTBOX_KEY}\`);
  }
  return event;
}

/** Fold one sync event into the connector's health: the last page that landed and the totals. */
export async function applyEvent(event: SyncEvent): Promise<void> {
  const key = \`health:\${event.connector_id}\`;
  await redis.hset(key, 'last_success_at', event.at);
  await redis.hincrby(key, 'pages', 1);
  await redis.hincrby(key, 'records', event.records);
}

export async function consumeSync(): Promise<void> {
  const consumer = kafka.consumer({groupId: GROUP});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await applyEvent(JSON.parse(String(message.value)) as SyncEvent);
      // Only once health:{id} holds the event: a crash before this line replays it.
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
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	pb "hub/gen/vendor"
	"hub/ledger" // ledger.CommitPage(ctx, connectorID, pageToken, nextCursor) (ledger.Commit, error)
	"hub/store"  // store.Connector
)

const (
	topic = "connector.sync"
	group = "connector-health"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 20 * time.Millisecond,
}

// SyncEvent is what connector.sync carries for one applied page.
type SyncEvent struct {
	ConnectorID string   \`json:"connector_id"\`
	SourceType  string   \`json:"source_type"\`
	TokenRef    string   \`json:"token_ref"\`
	Cursor      string   \`json:"cursor"\`
	Records     int      \`json:"records"\`
	Sample      []string \`json:"sample"\` // a preview for the sync dashboard
	At          int64    \`json:"at"\`
}

// syncPage commits a fetched page to the ledger and announces it on connector.sync; nil for a page already applied.
func syncPage(ctx context.Context, connector store.Connector, pageToken string, page *pb.Page) (*SyncEvent, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	result, err := ledger.CommitPage(ctx, connector.ConnectorID, pageToken, page.GetNextCursor())
	if err != nil || !result.Applied {
		return nil, err
	}
	var sample []string
	for i, record := range page.GetRecords() {
		if i < 3 {
			sample = append(sample, record.GetBody())
		}
	}
	event := &SyncEvent{ConnectorID: connector.ConnectorID, SourceType: connector.SourceType, TokenRef: connector.TokenRef, Cursor: result.Cursor, Records: len(page.GetRecords()), Sample: sample, At: time.Now().Unix()}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(connector.SourceType), Value: value}); err != nil {
		log.Printf("sync event not delivered: %v", err)
	}
	return event, nil
}

// applyEvent folds one sync event into the connector's health: the last page that landed and the totals.
func applyEvent(ctx context.Context, event SyncEvent) error {
	key := "health:" + event.ConnectorID
	if err := rdb.HSet(ctx, key, "last_success_at", event.At).Err(); err != nil {
		return err
	}
	rdb.HIncrBy(ctx, key, "pages", 1)
	return rdb.HIncrBy(ctx, key, "records", int64(event.Records)).Err()
}

func consumeSync(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	defer reader.Close()
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
		var event SyncEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := applyEvent(ctx, event); err != nil {
			return err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	pb "hub/gen/vendor"
	"hub/ledger" // ledger.CommitPage(ctx, connectorID, pageToken, nextCursor) (ledger.Commit, error)
	"hub/store"  // store.Connector
)

const (
	topic     = "connector.sync"
	group     = "connector-health"
	outboxKey = "outbox:connector.sync"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// RequireAll: the event is on every in-sync replica before the write returns. kafka-go has no
// idempotent producer, so a retry after a lost acknowledgement can duplicate; the health consumer
// counts pages, and a relay that cares deduplicates by (connector_id, cursor).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// SyncEvent is what connector.sync carries for one applied page: ids and counts only.
type SyncEvent struct {
	ConnectorID string \`json:"connector_id"\`
	Cursor      string \`json:"cursor"\`
	Records     int    \`json:"records"\`
	At          int64  \`json:"at"\`
}

// syncPage commits a fetched page to the ledger and announces it on connector.sync; nil for a page already applied.
func syncPage(ctx context.Context, connector store.Connector, pageToken string, page *pb.Page) (*SyncEvent, error) {
	result, err := ledger.CommitPage(ctx, connector.ConnectorID, pageToken, page.GetNextCursor())
	if err != nil || !result.Applied {
		return nil, err
	}
	// Ids and counts: the token reference and the records are not the topic's to keep.
	event := &SyncEvent{ConnectorID: connector.ConnectorID, Cursor: result.Cursor, Records: len(page.GetRecords()), At: time.Now().Unix()}
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(connector.ConnectorID), Value: value}); err != nil {
		row, _ := json.Marshal(map[string]string{"key": connector.ConnectorID, "payload": string(value)})
		rdb.RPush(ctx, outboxKey, string(row))
		log.Printf("sync event for %s rejected (%v), kept in %s", connector.ConnectorID, err, outboxKey)
	}
	return event, nil
}

// applyEvent folds one sync event into the connector's health: the last page that landed and the totals.
func applyEvent(ctx context.Context, event SyncEvent) error {
	key := "health:" + event.ConnectorID
	if err := rdb.HSet(ctx, key, "last_success_at", event.At).Err(); err != nil {
		return err
	}
	rdb.HIncrBy(ctx, key, "pages", 1)
	return rdb.HIncrBy(ctx, key, "records", int64(event.Records)).Err()
}

func consumeSync(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"kafka:9092"}, GroupID: group, Topic: topic})
	defer reader.Close()
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event SyncEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err
		}
		if err := applyEvent(ctx, event); err != nil {
			return err
		}
		// Only once health:{id} holds the event: a crash before this line replays it.
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import hub.{Ledger, Store} // Ledger.commitPage(connectorId, pageToken, nextCursor): Ledger.Commit; Store.Connector
import hub.vendor.Page

object Events {
  val Topic = "connector.sync"
  val Group = "connector-health"

  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"sync event not delivered: \${exception.getMessage}")
  }

  /** Commit a fetched page to the ledger and announce it on connector.sync; None for a page already applied. */
  def syncPage(connector: Store.Connector, pageToken: String, page: Page): Option[JsObject] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val result = Ledger.commitPage(connector.connectorId, pageToken, page.nextCursor)
    if (!result.applied) None
    else {
      val event = JsObject(
        "connector_id" -> JsString(connector.connectorId),
        "source_type" -> JsString(connector.sourceType),
        "token_ref" -> JsString(connector.tokenRef),
        "cursor" -> JsString(result.cursor),
        "records" -> JsNumber(page.records.size),
        "sample" -> JsArray(page.records.take(3).map(record => JsString(record.body)).toVector), // a preview for the sync dashboard
        "at" -> JsNumber(System.currentTimeMillis() / 1000))
      producer.send(new ProducerRecord[String, String](Topic, connector.sourceType, event.compactPrint), onDelivery)
      producer.flush()
      Some(event)
    }
  }

  /** Fold one sync event into the connector's health: the last page that landed and the totals. */
  def applyEvent(event: JsObject): Unit = {
    def field(name: String): String = event.fields.get(name) match {
      case Some(JsString(s)) => s
      case Some(other)       => other.toString
      case None              => ""
    }
    val key = s"health:\${field("connector_id")}"
    jedis.hset(key, "last_success_at", field("at"))
    jedis.hincrBy(key, "pages", 1L)
    jedis.hincrBy(key, "records", field("records").toLong)
  }

  def consumeSync(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
        applyEvent(record.value.parseJson.asJsObject)
      }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.atomic.AtomicReference

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import hub.{Ledger, Store} // Ledger.commitPage(connectorId, pageToken, nextCursor): Ledger.Commit; Store.Connector
import hub.vendor.Page

object Events {
  val Topic = "connector.sync"
  val Group = "connector-health"
  val OutboxKey = "outbox:connector.sync"

  val jedis = new JedisPooled("redis", 6379)

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Commit a fetched page to the ledger and announce it on connector.sync; None for a page already applied. */
  def syncPage(connector: Store.Connector, pageToken: String, page: Page): Option[JsObject] = {
    val result = Ledger.commitPage(connector.connectorId, pageToken, page.nextCursor)
    if (!result.applied) None
    else {
      // Ids and counts: the token reference and the records are not the topic's to keep.
      val event = JsObject(
        "connector_id" -> JsString(connector.connectorId),
        "cursor" -> JsString(result.cursor),
        "records" -> JsNumber(page.records.size),
        "at" -> JsNumber(System.currentTimeMillis() / 1000))
      val payload = event.compactPrint
      val rejected = new AtomicReference[Exception]()
      producer.send(new ProducerRecord[String, String](Topic, connector.connectorId, payload), new Callback {
        override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
          if (exception != null) rejected.set(exception)
      })
      producer.flush() // the delivery report has fired once flush returns, delivered or rejected
      if (rejected.get != null) {
        jedis.rpush(OutboxKey, JsObject("key" -> JsString(connector.connectorId), "payload" -> JsString(payload)).compactPrint)
        System.err.println(s"sync event for \${connector.connectorId} rejected (\${rejected.get.getMessage}), kept in $OutboxKey")
      }
      Some(event)
    }
  }

  /** Fold one sync event into the connector's health: the last page that landed and the totals. */
  def applyEvent(event: JsObject): Unit = {
    def field(name: String): String = event.fields.get(name) match {
      case Some(JsString(s)) => s
      case Some(other)       => other.toString
      case None              => ""
    }
    val key = s"health:\${field("connector_id")}"
    jedis.hset(key, "last_success_at", field("at"))
    jedis.hincrBy(key, "pages", 1L)
    jedis.hincrBy(key, "records", field("records").toLong)
  }

  def consumeSync(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", Group)
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(List(Topic).asJava)
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        applyEvent(record.value.parseJson.asJsObject)
        // Only once health:{id} holds the event: a crash before this line replays it.
        consumer.commitSync(Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)
      }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "hub/ledger.h"  // ledger::commitPage(connector_id, page_token, next_cursor) -> ledger::Commit
#include "hub/store.h"   // store::Connector
#include "vendor.grpc.pb.h"

using json = nlohmann::json;

const std::string kTopic = "connector.sync";
const std::string kGroup = "connector-health";
constexpr int kProduceTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "sync event not delivered: " << message.errstr() << "\\n";
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

long nowS() { return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }

// Commit a fetched page to the ledger and announce it on connector.sync; none for a page already applied.
std::optional<json> syncPage(const store::Connector& connector, const std::string& page_token, const hub::Page& page) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const ledger::Commit result = ledger::commitPage(connector.connector_id, page_token, page.next_cursor());
  if (!result.applied) return std::nullopt;
  json sample = json::array();
  for (int i = 0; i < page.records_size() && i < 3; i++) sample.push_back(page.records(i).body());  // a preview for the sync dashboard
  const json event = {{"connector_id", connector.connector_id}, {"source_type", connector.source_type}, {"token_ref", connector.token_ref},
                      {"cursor", result.cursor},                {"records", page.records_size()},     {"sample", sample},
                      {"at", nowS()}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    connector.source_type.c_str(), connector.source_type.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);
  return event;
}

// Fold one sync event into the connector's health: the last page that landed and the totals.
void applyEvent(const json& event) {
  const std::string key = "health:" + event.value("connector_id", "");
  redis.hset(key, "last_success_at", std::to_string(event.value("at", 0L)));
  redis.hincrby(key, "pages", 1);
  redis.hincrby(key, "records", event.value("records", 0L));
}

void consumeSync() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    consumer->commitSync(msg.get());
    applyEvent(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "hub/ledger.h"  // ledger::commitPage(connector_id, page_token, next_cursor) -> ledger::Commit
#include "hub/store.h"   // store::Connector
#include "vendor.grpc.pb.h"

using json = nlohmann::json;

const std::string kTopic = "connector.sync";
const std::string kGroup = "connector-health";
const std::string kOutboxKey = "outbox:connector.sync";
constexpr int kProduceTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report of the last produce: what the broker said once flush() served it.
class LastReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode err = RdKafka::ERR_NO_ERROR;
  std::string errstr;
  void dr_cb(RdKafka::Message& message) override {
    err = message.err();
    errstr = message.errstr();
  }
};

LastReport report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  // Idempotent with acks=all: a retry after a lost acknowledgement writes the event once, on every replica.
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

long nowS() { return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }

// Commit a fetched page to the ledger and announce it on connector.sync; none for a page already applied.
std::optional<json> syncPage(const store::Connector& connector, const std::string& page_token, const hub::Page& page) {
  const ledger::Commit result = ledger::commitPage(connector.connector_id, page_token, page.next_cursor());
  if (!result.applied) return std::nullopt;
  // Ids and counts: the token reference and the records are not the topic's to keep.
  const json event = {{"connector_id", connector.connector_id}, {"cursor", result.cursor}, {"records", page.records_size()}, {"at", nowS()}};
  const std::string payload = event.dump();
  report.err = RdKafka::ERR_NO_ERROR;
  const RdKafka::ErrorCode queued =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(),
                        connector.connector_id.c_str(), connector.connector_id.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);  // the delivery report fires here, delivered or rejected
  if (queued != RdKafka::ERR_NO_ERROR || report.err != RdKafka::ERR_NO_ERROR) {
    const std::string why = queued != RdKafka::ERR_NO_ERROR ? RdKafka::err2str(queued) : report.errstr;
    redis.rpush(kOutboxKey, json{{"key", connector.connector_id}, {"payload", payload}}.dump());
    std::cerr << "sync event for " << connector.connector_id << " rejected (" << why << "), kept in " << kOutboxKey << "\\n";
  }
  return event;
}

// Fold one sync event into the connector's health: the last page that landed and the totals.
void applyEvent(const json& event) {
  const std::string key = "health:" + event.value("connector_id", "");
  redis.hset(key, "last_success_at", std::to_string(event.value("at", 0L)));
  redis.hincrby(key, "pages", 1);
  redis.hincrby(key, "records", event.value("records", 0L));
}

void consumeSync() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", kGroup, err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    applyEvent(json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len())));
    // Only once health:{id} holds the event: a crash before this line replays it.
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json

import vendor_pb2
from hub import store
from hub.ledger import load_cursor

TOPIC = "connector.sync"
GROUP = "connector-health"
OUTBOX = "outbox:connector.sync"
TOKEN = "vault:acme/github#4"


def _page(n):
    records = [vendor_pb2.SourceRecord(id=f"r-{n}-{i}", body=f"customer {n}{i}: jane@example.com") for i in range(2)]
    return vendor_pb2.Page(records=records, next_cursor=f"t{n + 1}")


def _world(ctx):
    m = ctx.load("events")
    first = store.create("acme", "github", "api.github.com", TOKEN, 900)
    second = store.create("acme", "github", "api.github.com", "vault:acme/github#5", 900)
    return m, first, second


def check_connector_key(ctx):
    m, a, b = _world(ctx)
    m.sync_page(a, "t0", _page(0))
    m.sync_page(b, "t0", _page(0))
    m.sync_page(a, "t1", _page(1))
    assert m.sync_page(a, "t1", _page(1)) is None, "a page already applied must not be announced again"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three applied pages produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    expected = [a["connector_id"].encode(), b["connector_id"].encode(), a["connector_id"].encode()]
    assert keys == expected, f"records must be keyed by the connector id, got {keys}: keyed by source, every GitHub connector shares one partition and one backlog"
    assert records[0].partition == records[2].partition, "one connector's events must stay on one partition, in order"


def check_no_secrets(ctx):
    m, a, _ = _world(ctx)
    m.sync_page(a, "t0", _page(0))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one applied page produced {len(records)} records"
    text = records[0].value.decode()
    assert TOKEN not in text, f"the event carries the token reference: {text}. The topic is retained and replicated; the registry keeps the reference"
    assert "jane@example.com" not in text, f"the event carries record contents: {text}. Count the records; their contents stay with the vendor and the destination"
    event = json.loads(text)
    assert set(event) == {"connector_id", "cursor", "records", "at"}, f"the event must be {{connector_id, cursor, records, at}}, got {text}"
    assert event["connector_id"] == a["connector_id"] and event["cursor"] == "t1" and event["records"] == 2, f"the event must name the connector, the cursor the page moved to (t1) and its 2 records: {text}"


def check_idempotent_producer(ctx):
    m, a, _ = _world(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    m.sync_page(a, "t0", _page(0))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one page whose acknowledgement was lost left {len(records)} records: the producer's retry wrote the event twice (enable.idempotence)"
    m.sync_page(a, "t1", _page(1))
    ctx.kafka.failover(TOPIC)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 2, f"after a leader failover the topic holds {len(records)} records, expected 2: a record acknowledged by the leader alone is lost (acks=all)"


def check_outbox(ctx):
    m, a, _ = _world(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    m.sync_page(a, "t0", _page(0))
    rows = ctx.redis.lrange(OUTBOX, 0, -1)
    assert len(rows) == 1, f"after the broker rejected the event {OUTBOX} holds {rows}, expected one row: logged and dropped, the page never reaches the health read"
    row = json.loads(rows[0])
    assert row.get("key") == a["connector_id"], f"the outbox row must carry the message key (the connector id) so the relay keeps the order: {row}"
    payload = json.loads(row["payload"]) if isinstance(row.get("payload"), str) else row.get("payload")
    assert isinstance(payload, dict) and payload.get("cursor") == "t1", f"the outbox row must carry the event: {row}"
    assert ctx.kafka.records(TOPIC) == [], "a rejected event cannot be on the topic"
    assert load_cursor(a["connector_id"]) == "t1", "the page stays committed whatever the broker said"
    m.sync_page(a, "t1", _page(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, "once the broker answers again events flow"
    assert len(ctx.redis.lrange(OUTBOX, 0, -1)) == 1, "a delivered event leaves no outbox row"


def check_apply_before_commit(ctx):
    m, a, _ = _world(ctx)
    for n in range(3):
        m.sync_page(a, f"t{n}", _page(n))
    cid = a["connector_id"]
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(int(ctx.redis.hget(f"health:{cid}", "pages") or 0)))
    ctx.drain(m.consume_sync)
    assert at_commit, "the consumer never committed an offset"
    for k, pages in enumerate(at_commit, start=1):
        assert pages >= k, f"at commit {k} health:{cid} counted {pages} page(s): the offset was committed before the event was applied, and a crash in between loses the page from the health read"
    health = ctx.redis.hgetall(f"health:{cid}")
    assert health.get("pages") == "3" and health.get("records") == "6" and health.get("last_success_at"), f"health:{cid} holds {health}, expected pages 3, records 6 and last_success_at"
    assert ctx.kafka.lag(GROUP, TOPIC) == 0, f"the consumer left {ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted"
`,
    typescript: `const TOPIC = 'connector.sync';
const GROUP = 'connector-health';
const OUTBOX = 'outbox:connector.sync';
const TOKEN = 'vault:acme/github#4';

const page = (n: number) => ({
  records: [0, 1].map(i => ({id: \`r-\${n}-\${i}\`, body: \`customer \${n}\${i}: jane@example.com\`})),
  next_cursor: \`t\${n + 1}\`,
});

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

async function world(ctx) {
  const m = ctx.load('events');
  const store = ctx.load('/support/hub/store.ts');
  const ledger = ctx.load('/support/hub/ledger.ts');
  const a = await store.create('acme', 'github', 'api.github.com', TOKEN, 900);
  const b = await store.create('acme', 'github', 'api.github.com', 'vault:acme/github#5', 900);
  return {m, ledger, a, b};
}

async function sync(m, connector, n: number) {
  const event = await m.syncPage(connector, \`t\${n}\`, page(n));
  await settle();
  return event;
}

export async function check_connector_key(ctx) {
  const {m, a, b} = await world(ctx);
  await sync(m, a, 0);
  await sync(m, b, 0);
  await sync(m, a, 1);
  assert.equal(await sync(m, a, 1), null, 'a page already applied must not be announced again');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three applied pages produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, [a.connector_id, b.connector_id, a.connector_id], \`records must be keyed by the connector id, got \${JSON.stringify(keys)}: keyed by source, every GitHub connector shares one partition and one backlog\`);
  assert.equal(records[0].partition, records[2].partition, "one connector's events must stay on one partition, in order");
}

export async function check_no_secrets(ctx) {
  const {m, a} = await world(ctx);
  await sync(m, a, 0);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one applied page produced \${records.length} records\`);
  const text = records[0].value.toString();
  assert(!text.includes(TOKEN), \`the event carries the token reference: \${text}. The topic is retained and replicated; the registry keeps the reference\`);
  assert(!text.includes('jane@example.com'), \`the event carries record contents: \${text}. Count the records; their contents stay with the vendor and the destination\`);
  const event = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(event).sort(), ['at', 'connector_id', 'cursor', 'records'], \`the event must be {connector_id, cursor, records, at}, got \${text}\`);
  assert(event.connector_id === a.connector_id && event.cursor === 't1' && event.records === 2, \`the event must name the connector, the cursor the page moved to (t1) and its 2 records: \${text}\`);
}

export async function check_idempotent_producer(ctx) {
  const {m, a} = await world(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await sync(m, a, 0);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`one page whose acknowledgement was lost left \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice (idempotent: true)\`);
  await sync(m, a, 1);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 2, \`after a leader failover the topic holds \${ctx.kafka.records(TOPIC).length} records, expected 2: a record acknowledged by the leader alone is lost (acks -1)\`);
}

export async function check_outbox(ctx) {
  const {m, ledger, a} = await world(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  await sync(m, a, 0);
  const rows = ctx.redis.lrange(OUTBOX, 0, -1);
  assert.equal(rows.length, 1, \`after the broker rejected the event \${OUTBOX} holds \${JSON.stringify(rows)}, expected one row: logged and dropped, the page never reaches the health read\`);
  const row = JSON.parse(rows[0]);
  assert.equal(row.key, a.connector_id, \`the outbox row must carry the message key (the connector id) so the relay keeps the order: \${rows[0]}\`);
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  assert(payload !== null && typeof payload === 'object' && payload.cursor === 't1', \`the outbox row must carry the event: \${rows[0]}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'a rejected event cannot be on the topic');
  assert.equal(await ledger.loadCursor(a.connector_id), 't1', 'the page stays committed whatever the broker said');
  await sync(m, a, 1);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'once the broker answers again events flow');
  assert.equal(ctx.redis.lrange(OUTBOX, 0, -1).length, 1, 'a delivered event leaves no outbox row');
}

export async function check_apply_before_commit(ctx) {
  const {m, a} = await world(ctx);
  for (let n = 0; n < 3; n += 1) await sync(m, a, n);
  const cid = a.connector_id;
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(Number(ctx.redis.hget(\`health:\${cid}\`, 'pages') ?? 0)));
  await ctx.drain(m.consumeSync());
  assert(atCommit.length > 0, 'the consumer never committed an offset');
  atCommit.forEach((pages, i) => {
    assert(pages >= i + 1, \`at commit \${i + 1} health:\${cid} counted \${pages} page(s): the offset was committed before the event was applied, and a crash in between loses the page from the health read\`);
  });
  const health = ctx.redis.hgetall(\`health:\${cid}\`);
  assert(health.pages === '3' && health.records === '6' && health.last_success_at, \`health:\${cid} holds \${JSON.stringify(health)}, expected pages 3, records 6 and last_success_at\`);
  assert.equal(ctx.kafka.lag(GROUP, TOPIC), 0, \`the consumer left \${ctx.kafka.lag(GROUP, TOPIC)} record(s) uncommitted\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	pb "hub/gen/vendor"
	"hub/ledger"
	"hub/store"

	"leetbuild/harness"
)

const (
	eventsTopic  = "connector.sync"
	eventsGroup  = "connector-health"
	eventsOutbox = "outbox:connector.sync"
	eventsToken  = "vault:acme/github#4"
)

var eventsBg = context.Background()

func eventsPage(n int) *pb.Page {
	return &pb.Page{
		Records: []*pb.SourceRecord{
			{Id: fmt.Sprintf("r-%d-0", n), Body: fmt.Sprintf("customer %d0: jane@example.com", n)},
			{Id: fmt.Sprintf("r-%d-1", n), Body: fmt.Sprintf("customer %d1: jane@example.com", n)},
		},
		NextCursor: fmt.Sprintf("t%d", n+1),
	}
}

func eventsWorld() (store.Connector, store.Connector) {
	a := store.Create(eventsBg, "acme", "github", "api.github.com", eventsToken, 900)
	b := store.Create(eventsBg, "acme", "github", "api.github.com", "vault:acme/github#5", 900)
	return *a, *b
}

// eventsSync is syncPage, reporting a panic as an error instead of ending the check.
func eventsSync(ctx *harness.Ctx, connector store.Connector, n int) (event *SyncEvent, err error) {
	defer func() {
		if e := recover(); e != nil {
			err = errors.New("panic: " + harness.Show(e))
		}
		ctx.Settle()
	}()
	return syncPage(eventsBg, connector, fmt.Sprintf("t%d", n), eventsPage(n))
}

func CheckConnectorKey(ctx *harness.Ctx) {
	a, b := eventsWorld()
	for _, step := range []struct {
		c store.Connector
		n int
	}{{a, 0}, {b, 0}, {a, 1}} {
		_, err := eventsSync(ctx, step.c, step.n)
		ctx.NoError(err, "syncPage(%s, t%d) on a healthy broker", step.c.ConnectorID, step.n)
	}
	replay, err := eventsSync(ctx, a, 1)
	ctx.Assert(err == nil && replay == nil, "a page already applied must not be announced again, got %+v (%v)", replay, err)
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three applied pages; the records on %s", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{a.ConnectorID, b.ConnectorID, a.ConnectorID}, "records must be keyed by the connector id (keyed by source, every GitHub connector shares one partition and one backlog); the keys")
	ctx.Equal(records[0].Partition, records[2].Partition, "one connector's events must stay on one partition, in order; the partitions")
}

func CheckNoSecrets(ctx *harness.Ctx) {
	a, _ := eventsWorld()
	_, err := eventsSync(ctx, a, 0)
	ctx.NoError(err, "syncPage on a healthy broker")
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one applied page; the records")
	text := string(records[0].Value)
	ctx.Assert(!strings.Contains(text, eventsToken), "the event carries the token reference: %s. The topic is retained and replicated; the registry keeps the reference", text)
	ctx.Assert(!strings.Contains(text, "jane@example.com"), "the event carries record contents: %s. Count the records; their contents stay with the vendor and the destination", text)
	var event map[string]any
	ctx.NoError(json.Unmarshal(records[0].Value, &event), "the event must be JSON (%s)", text)
	var fields []string
	for k := range event {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	ctx.Equal(fields, []string{"at", "connector_id", "cursor", "records"}, "the event must be {connector_id, cursor, records, at} (%s); its fields", text)
	ctx.Assert(event["connector_id"] == a.ConnectorID && event["cursor"] == "t1" && event["records"] == float64(2), "the event must name the connector, the cursor the page moved to (t1) and its 2 records: %s", text)
}

func CheckIdempotentProducer(ctx *harness.Ctx) {
	a, _ := eventsWorld()
	_, err := eventsSync(ctx, a, 0)
	ctx.NoError(err, "syncPage on a healthy broker")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "one applied page; the records")
	lost := ctx.Kafka.Failover(eventsTopic)
	ctx.Equal(lost, 0, "a leader failover right after the write lost the event: it was acknowledged by the leader alone (RequiredAcks: kafka.RequireAll); records lost")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after a leader failover the event must still be on the topic; the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	a, _ := eventsWorld()
	ctx.Kafka.FailNext(eventsTopic, 1)
	eventsSync(ctx, a, 0)
	rows := ctx.Redis.LRange(eventsOutbox, 0, -1)
	ctx.Equal(len(rows), 1, "after the broker rejected the event %s must hold one row (logged and dropped, the page never reaches the health read); it holds %v; rows", eventsOutbox, rows)
	var row map[string]any
	ctx.NoError(json.Unmarshal([]byte(rows[0]), &row), "the outbox row must be JSON (%s)", rows[0])
	ctx.Equal(row["key"], a.ConnectorID, "the outbox row must carry the message key (the connector id) so the relay keeps the order (%s)", rows[0])
	var payload map[string]any
	if text, ok := row["payload"].(string); ok {
		json.Unmarshal([]byte(text), &payload)
	} else if object, ok := row["payload"].(map[string]any); ok {
		payload = object
	}
	ctx.Assert(payload != nil && payload["cursor"] == "t1", "the outbox row must carry the event: %s", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 0, "a rejected event cannot be on the topic; the records")
	cursor, _ := ledger.LoadCursor(eventsBg, a.ConnectorID)
	ctx.Equal(cursor, "t1", "the page stays committed whatever the broker said; the cursor")
	_, err := eventsSync(ctx, a, 1)
	ctx.NoError(err, "syncPage after the broker recovered")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "once the broker answers again events flow; the records")
	ctx.Equal(len(ctx.Redis.LRange(eventsOutbox, 0, -1)), 1, "a delivered event leaves no outbox row; the rows")
}

func CheckApplyBeforeCommit(ctx *harness.Ctx) {
	a, _ := eventsWorld()
	for n := 0; n < 3; n++ {
		_, err := eventsSync(ctx, a, n)
		ctx.NoError(err, "syncPage(t%d) on a healthy broker", n)
	}
	var atCommit []int
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) {
		pages, _ := ctx.Redis.HGet("health:"+a.ConnectorID, "pages")
		n, _ := strconv.Atoi(pages)
		atCommit = append(atCommit, n)
	})
	ctx.Drain(func() { consumeSync(context.Background()) })
	ctx.Assert(len(atCommit) > 0, "the consumer never committed an offset")
	for i, pages := range atCommit {
		ctx.Assert(pages >= i+1, "at commit %d health:%s counted %d page(s): the offset was committed before the event was applied, and a crash in between loses the page from the health read", i+1, a.ConnectorID, pages)
	}
	health := ctx.Redis.HGetAll("health:" + a.ConnectorID)
	ctx.Assert(health["pages"] == "3" && health["records"] == "6" && health["last_success_at"] != "", "health:%s holds %v, expected pages 3, records 6 and last_success_at", a.ConnectorID, health)
	ctx.Equal(ctx.Kafka.Lag(eventsGroup, eventsTopic), 0, "records the consumer left uncommitted")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "connector.sync";
const std::string kEventsGroup = "connector-health";
const std::string kEventsOutbox = "outbox:connector.sync";
const std::string kEventsToken = "vault:acme/github#4";

hub::Page eventsPage(int n) {
  hub::Page page;
  for (int i = 0; i < 2; i++) {
    hub::SourceRecord* record = page.add_records();
    record->set_id("r-" + std::to_string(n) + "-" + std::to_string(i));
    record->set_body("customer " + std::to_string(n) + std::to_string(i) + ": jane@example.com");
  }
  page.set_next_cursor("t" + std::to_string(n + 1));
  return page;
}

// syncPage, reporting what it threw ("" when nothing) and whether it answered an event.
struct Synced {
  std::string thrown;
  bool announced = false;
};

Synced eventsSync(harness::Ctx& ctx, const store::Connector& connector, int n) {
  Synced out;
  try {
    out.announced = syncPage(connector, "t" + std::to_string(n), eventsPage(n)).has_value();
  } catch (const std::exception& e) {
    out.thrown = std::string(harness::CurrentExceptionType()) + ": " + e.what();
  }
  ctx.Settle();
  return out;
}

nlohmann::json parsed(const std::string& text) {
  try {
    return nlohmann::json::parse(text);
  } catch (const std::exception&) {
    return nlohmann::json();
  }
}

}  // namespace

void CheckConnectorKey(harness::Ctx& ctx) {
  const store::Connector a = store::create("acme", "github", "api.github.com", kEventsToken, 900);
  const store::Connector b = store::create("acme", "github", "api.github.com", "vault:acme/github#5", 900);
  ctx.Equal(eventsSync(ctx, a, 0).thrown, "", "syncPage on a healthy broker threw");
  ctx.Equal(eventsSync(ctx, b, 0).thrown, "", "syncPage on a healthy broker threw");
  ctx.Equal(eventsSync(ctx, a, 1).thrown, "", "syncPage on a healthy broker threw");
  ctx.Equal(eventsSync(ctx, a, 1).announced, false, "a page already applied must not be announced again; announced");
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three applied pages; the records on %s", kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {a.connector_id, b.connector_id, a.connector_id},
            "records must be keyed by the connector id (keyed by source, every GitHub connector shares one partition and one backlog); the keys");
  ctx.Equal(records[0].Partition, records[2].Partition, "one connector's events must stay on one partition, in order; the partitions");
}

void CheckNoSecrets(harness::Ctx& ctx) {
  const store::Connector a = store::create("acme", "github", "api.github.com", kEventsToken, 900);
  ctx.Equal(eventsSync(ctx, a, 0).thrown, "", "syncPage on a healthy broker threw");
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 1, "one applied page; the records");
  const std::string text = records[0].Value.value_or("");
  ctx.Assert(text.find(kEventsToken) == std::string::npos, "the event carries the token reference: %s. The topic is retained and replicated; the registry keeps the reference", text);
  ctx.Assert(text.find("jane@example.com") == std::string::npos, "the event carries record contents: %s. Count the records; their contents stay with the vendor and the destination", text);
  const auto event = parsed(text);
  ctx.Assert(event.is_object(), "the event must be JSON: %s", text);
  std::vector<std::string> fields;
  for (const auto& [k, v] : event.items()) fields.push_back(k);
  std::sort(fields.begin(), fields.end());
  ctx.Equal(fields, {"at", "connector_id", "cursor", "records"}, "the event must be {connector_id, cursor, records, at} (%s); its fields", text);
  ctx.Assert(event.value("connector_id", "") == a.connector_id && event.value("cursor", "") == "t1" && event.value("records", 0) == 2,
             "the event must name the connector, the cursor the page moved to (t1) and its 2 records: %s", text);
}

void CheckIdempotentProducer(harness::Ctx& ctx) {
  const store::Connector a = store::create("acme", "github", "api.github.com", kEventsToken, 900);
  ctx.Kafka.LoseAcks(kEventsTopic, 1);
  ctx.Equal(eventsSync(ctx, a, 0).thrown, "", "syncPage threw: a lost acknowledgement is retried by the client, not reported;");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "one page whose acknowledgement was lost: the producer's retry wrote the event twice (enable.idempotence); the records");
  eventsSync(ctx, a, 1);
  ctx.Kafka.Failover(kEventsTopic);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "after a leader failover the topic must hold both events: a record acknowledged by the leader alone is lost (acks=all); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  const store::Connector a = store::create("acme", "github", "api.github.com", kEventsToken, 900);
  ctx.Kafka.FailNext(kEventsTopic, 1);
  eventsSync(ctx, a, 0);
  const auto rows = ctx.Redis.LRange(kEventsOutbox, 0, -1);
  ctx.Equal(rows.size(), 1, "after the broker rejected the event %s must hold one row (logged and dropped, the page never reaches the health read); it holds %v; rows", kEventsOutbox, rows);
  const auto row = parsed(rows[0]);
  ctx.Assert(row.is_object() && row.value("key", "") == a.connector_id, "the outbox row must carry the message key (the connector id) so the relay keeps the order (%s)", rows[0]);
  nlohmann::json payload;
  if (row.contains("payload")) payload = row["payload"].is_string() ? parsed(row["payload"].get<std::string>()) : row["payload"];
  ctx.Assert(payload.is_object() && payload.value("cursor", "") == "t1", "the outbox row must carry the event: %s", rows[0]);
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 0, "a rejected event cannot be on the topic; the records");
  ctx.Equal(ledger::loadCursor(a.connector_id).value_or(""), "t1", "the page stays committed whatever the broker said; the cursor");
  ctx.Equal(eventsSync(ctx, a, 1).thrown, "", "syncPage after the broker recovered threw");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "once the broker answers again events flow; the records");
  ctx.Equal(ctx.Redis.LRange(kEventsOutbox, 0, -1).size(), 1, "a delivered event leaves no outbox row; the rows");
}

void CheckApplyBeforeCommit(harness::Ctx& ctx) {
  const store::Connector a = store::create("acme", "github", "api.github.com", kEventsToken, 900);
  for (int n = 0; n < 3; n++) ctx.Equal(eventsSync(ctx, a, n).thrown, "", "syncPage on a healthy broker threw");
  const std::string key = "health:" + a.connector_id;
  std::vector<long> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) {
    const auto pages = ctx.Redis.HGet(key, "pages");
    atCommit.push_back(pages && !pages->empty() ? std::stol(*pages) : 0);
  });
  ctx.Drain([] { consumeSync(); });
  ctx.Assert(!atCommit.empty(), "the consumer never committed an offset");
  for (size_t i = 0; i < atCommit.size(); i++) {
    ctx.Assert(atCommit[i] >= static_cast<long>(i + 1),
               "at commit %d %s counted %d page(s): the offset was committed before the event was applied, and a crash in between loses the page from the health read",
               i + 1, key, atCommit[i]);
  }
  const auto health = ctx.Redis.HGetAll(key);
  const auto field = [&health](const std::string& f) { return health.count(f) ? health.at(f) : std::string(); };
  ctx.Assert(field("pages") == "3" && field("records") == "6" && !field("last_success_at").empty(), "%s holds %v, expected pages 3, records 6 and last_success_at", key, health);
  ctx.Equal(ctx.Kafka.Lag(kEventsGroup, kEventsTopic), 0, "records the consumer left uncommitted");
}
`,
  },
  hints: [
    "Register two GitHub connectors and sync a page of each: both events carry the key `github`. Read the topic: the token reference and a customer's email are in it. Reject one produce: no trace of that page remains.",
    'The key decides the partition and the payload is built from the connector row and the records themselves. The delivery report only logs, the producer runs with `acks=1` and no idempotence, and the consumer commits before it writes health.',
    'Key by `connector_id`, send `{connector_id, cursor, records: len(page.records), at}`, configure `enable.idempotence` with `acks=all`, RPUSH `{key, payload}` to `outbox:connector.sync` when the report says rejected, and call `apply_event` before `consumer.commit`.',
  ],
  debrief: `The event is announced only after the ledger applied the page, so a page already claimed produces nothing, and its key is the connector because order matters per connector: the health of one connector should not wait behind another's backlog. The payload carries ids and counts because a topic outlives the request, is copied to every consumer and is hard to purge, while the registry and the destination already hold the token and the records. Idempotence with acks=all is what makes one page one event on every replica; the outbox row is what makes a rejection recoverable instead of silent. Production hubs write the outbox row in the same transaction as the page and alert when the relay that drains it falls behind.`,
};
