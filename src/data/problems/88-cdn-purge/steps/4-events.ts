import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'cdn.purged events keyed by domain, with stable ids and an outbox',
  concept: 'kafka',
  file: 'events',
  focus: ['purge', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter's \`publish_outcomes(purge_id, domain, outcomes)\` turns a batch's
per-path outcomes into \`cdn.purged\` events for the ops projector, one per path
(\`{event_id, purge_id, domain, path, outcome}\`): it produces each keyed by the purge id with a
fresh \`uuid4\` id on an \`acks=1\` producer, counts it as published, and parks it in the outbox
(\`records.insert_outbox\`) only when \`produce\` raises. It works against a healthy broker and hides
four flaws.

**Failure mode the checks target.** One domain's purge history lands on several partitions and the
projector applies it out of order; a worker that publishes a purge again creates events the
projector cannot recognise as copies; a lost acknowledgement writes an event twice and a leader
failover loses one; and a delivery the broker refuses after \`produce\` returned is lost.

- The record key is the **domain**.
- \`event_id\` is \`{purge_id}:{path_digest}\`, \`path_digest\` the hex \`sha256\` of the path, so a
  republish carries the same ids.
- The producer is idempotent with \`acks=all\` (Go: confluent-kafka-go, as kafka-go has no
  idempotent producer).
- Wait for the delivery reports at most 2 s (\`ACK_TIMEOUT_S\`); every event not acknowledged goes to
  the outbox with the topic and the key. Return the number acknowledged.

:::widget kafka-partitions {"partitions": 8}

:::widget outbox {}`,
  sequence: {
    participants: ['provider client', 'cdn.purged', 'outbox', 'ops projector'],
    messages: [
      {from: 'provider client', to: 'provider client', label: 'event_id = purge_id:sha256(path)', kind: 'sync'},
      {from: 'provider client', to: 'cdn.purged', label: 'produce key = domain · idempotent · acks=all', kind: 'async'},
      {from: 'cdn.purged', to: 'provider client', label: 'delivery reports within 2 s', kind: 'reply'},
      {
        from: 'provider client',
        to: 'outbox',
        label: 'not acknowledged → insert_outbox(topic, domain, event)',
        kind: 'sync',
      },
      {from: 'cdn.purged', to: 'ops projector', label: 'one domain in order · dedupe on event_id', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'domain-key',
      title: 'Every event is keyed by its domain',
      detail:
        'Events carry the domain as the record key, so one domain’s purges share a partition and reach the projector in order. The starter keys by purge id.',
      match: {
        python: {all: [/key\s*=\s*domain\b/], none: [/key\s*=\s*purge_id\b/]},
        typescript: {all: [/key:\s*domain\b/], none: [/key:\s*purgeId\b/]},
        go: {all: [/Key:\s*\[\]byte\(domain\)/], none: [/Key:\s*\[\]byte\(purgeID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*domain\b/], none: [/Topic,\s*purgeId\b/]},
        cpp: {all: [/domain\.c_str\(\),\s*domain\.size\(\)/], none: [/purge_id\.c_str\(\),\s*purge_id\.size\(\)/]},
      },
    },
    {
      id: 'event-id',
      title: 'A republished purge carries the same event ids',
      detail:
        '`event_id` is the purge id and the `sha256` of the path, so publishing a purge twice yields the same ids and the projector drops the copies. The starter mints a random id per produce.',
      match: {
        python: {all: [/hashlib\.sha256\(/], none: [/uuid/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/], none: [/randomUUID/]},
        go: {all: [/sha256\.Sum256\(/], none: [/uuid\./]},
        scala: {all: [/MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/], none: [/UUID\.randomUUID/]},
        cpp: {all: [/SHA256\(/], none: [/uuid_generate/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'An idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["'](all|-1)["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"(all|-1)"/]},
        scala: {all: [/put\("enable\.idempotence",\s*"true"\)/, /put\("acks",\s*"(all|-1)"\)/]},
        cpp: {all: [/set\("enable\.idempotence",\s*"true"/, /set\("acks",\s*"(all|-1)"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'An unacknowledged event goes to the outbox',
      detail:
        'The delivery reports decide: a failed delivery or no acknowledgement within 2 s leaves an outbox row with the topic, the domain and the event, and the call counts only acknowledged events. The starter catches only errors `produce` raises itself.',
      match: {
        python: {all: [/records\.insert_outbox\(/, /on_delivery\s*=/, /\.flush\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/], none: [/void producer\.send\(/]},
        go: {all: [/records\.InsertOutbox\(/, /TopicPartition\.Error/, /time\.After\(/]},
        scala: {all: [/Records\.insertOutbox\(/, /\.get\([^\n]*TimeUnit/]},
        cpp: {all: [/records::insertOutbox\(/, /dr_cb/, /->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import uuid

from confluent_kafka import KafkaException, Producer

from purge import records  # insert_outbox

TOPIC = "cdn.purged"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def purge_event(purge_id: str, domain: str, path: str, outcome: str) -> dict:
    """One cdn.purged event: what became of one path of one purge."""
    return {"event_id": str(uuid.uuid4()), "purge_id": purge_id, "domain": domain, "path": path, "outcome": outcome}


def publish_outcomes(purge_id: str, domain: str, outcomes: dict[str, str]) -> int:
    """Publish one event per path of the purge; the number of events the broker acknowledged."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    published = 0
    for path, outcome in outcomes.items():
        event = purge_event(purge_id, domain, path, outcome)
        try:
            producer.produce(TOPIC, key=purge_id, value=json.dumps(event))
            producer.poll(0)
            published += 1
        except KafkaException:
            records.insert_outbox(TOPIC, purge_id, event)
    return published
`,
      solution: `import hashlib
import json

from confluent_kafka import Producer

from purge import records  # insert_outbox

TOPIC = "cdn.purged"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def purge_event(purge_id: str, domain: str, path: str, outcome: str) -> dict:
    """One cdn.purged event: what became of one path of one purge, with the same id however often it is published."""
    digest = hashlib.sha256(path.encode()).hexdigest()
    return {"event_id": f"{purge_id}:{digest}", "purge_id": purge_id, "domain": domain, "path": path, "path_digest": digest, "outcome": outcome}


def publish_outcomes(purge_id: str, domain: str, outcomes: dict[str, str]) -> int:
    """Publish one event per path of the purge; the number of events the broker acknowledged."""
    events = [purge_event(purge_id, domain, path, outcome) for path, outcome in outcomes.items()]
    acked = set()

    def on_delivery(err, msg):
        if err is None:
            acked.add(json.loads(msg.value())["event_id"])

    for event in events:
        producer.produce(TOPIC, key=domain, value=json.dumps(event), on_delivery=on_delivery)
    producer.flush(ACK_TIMEOUT_S)  # serves the delivery reports, or gives up after the window
    for event in events:
        if event["event_id"] not in acked:
            # The broker did not take it: the relay publishes it later, and the projector dedupes on event_id.
            records.insert_outbox(TOPIC, domain, event)
    return len(acked)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {insertOutbox} from 'purge/records';

export const TOPIC = 'cdn.purged';

const kafka = new Kafka({clientId: 'purged', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export type PurgeEvent = {event_id: string; purge_id: string; domain: string; path: string; outcome: string};

/** One cdn.purged event: what became of one path of one purge. */
export function purgeEvent(purgeId: string, domain: string, path: string, outcome: string): PurgeEvent {
  return {event_id: randomUUID(), purge_id: purgeId, domain, path, outcome};
}

/** Publish one event per path of the purge; the number of events the broker acknowledged. */
export async function publishOutcomes(purgeId: string, domain: string, outcomes: Record<string, string>): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  let published = 0;
  for (const [path, outcome] of Object.entries(outcomes)) {
    const event = purgeEvent(purgeId, domain, path, outcome);
    try {
      void producer.send({topic: TOPIC, messages: [{key: purgeId, value: JSON.stringify(event)}], acks: 1});
      published++;
    } catch {
      await insertOutbox(TOPIC, purgeId, event);
    }
  }
  return published;
}
`,
      solution: `import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {insertOutbox} from 'purge/records';

export const TOPIC = 'cdn.purged';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'purged', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

export type PurgeEvent = {event_id: string; purge_id: string; domain: string; path: string; path_digest: string; outcome: string};

/** One cdn.purged event: what became of one path of one purge, with the same id however often it is published. */
export function purgeEvent(purgeId: string, domain: string, path: string, outcome: string): PurgeEvent {
  const digest = createHash('sha256').update(path).digest('hex');
  return {event_id: \`\${purgeId}:\${digest}\`, purge_id: purgeId, domain, path, path_digest: digest, outcome};
}

/** Publish one event per path of the purge; the number of events the broker acknowledged. */
export async function publishOutcomes(purgeId: string, domain: string, outcomes: Record<string, string>): Promise<number> {
  const events = Object.entries(outcomes).map(([path, outcome]) => purgeEvent(purgeId, domain, path, outcome));
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: events.map(event => ({key: domain, value: JSON.stringify(event)})),
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return events.length;
  } catch {
    // The broker did not take them: the relay publishes them later, and the projector dedupes on event_id.
    for (const event of events) await insertOutbox(TOPIC, domain, event);
    return 0;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"

	"purge/records" // records.InsertOutbox
)

const topic = "cdn.purged"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// PurgeEvent is one cdn.purged event: what became of one path of one purge.
type PurgeEvent struct {
	EventID string \`json:"event_id"\`
	PurgeID string \`json:"purge_id"\`
	Domain  string \`json:"domain"\`
	Path    string \`json:"path"\`
	Outcome string \`json:"outcome"\`
}

func purgeEvent(purgeID, domain, path, outcome string) PurgeEvent {
	return PurgeEvent{EventID: uuid.NewString(), PurgeID: purgeID, Domain: domain, Path: path, Outcome: outcome}
}

// publishOutcomes publishes one event per path of the purge; the number of events the broker acknowledged.
func publishOutcomes(ctx context.Context, purgeID, domain string, outcomes map[string]string) (int, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	published := 0
	t := topic
	for path, outcome := range outcomes {
		event := purgeEvent(purgeID, domain, path, outcome)
		value, _ := json.Marshal(event)
		msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(purgeID), Value: value}
		if err := producer.Produce(msg, nil); err != nil {
			if err := records.InsertOutbox(ctx, topic, purgeID, event); err != nil {
				return published, err
			}
			continue
		}
		published++
	}
	return published, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"purge/records" // records.InsertOutbox
)

const (
	topic      = "cdn.purged"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

// PurgeEvent is one cdn.purged event: what became of one path of one purge.
type PurgeEvent struct {
	EventID    string \`json:"event_id"\`
	PurgeID    string \`json:"purge_id"\`
	Domain     string \`json:"domain"\`
	Path       string \`json:"path"\`
	PathDigest string \`json:"path_digest"\`
	Outcome    string \`json:"outcome"\`
}

// purgeEvent builds the event, with the same id however often it is published.
func purgeEvent(purgeID, domain, path, outcome string) PurgeEvent {
	sum := sha256.Sum256([]byte(path))
	digest := hex.EncodeToString(sum[:])
	return PurgeEvent{EventID: purgeID + ":" + digest, PurgeID: purgeID, Domain: domain, Path: path, PathDigest: digest, Outcome: outcome}
}

// publishOutcomes publishes one event per path of the purge; the number of events the broker acknowledged.
func publishOutcomes(ctx context.Context, purgeID, domain string, outcomes map[string]string) (int, error) {
	paths := make([]string, 0, len(outcomes))
	for path := range outcomes {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	deliveries := make(chan kafka.Event, len(paths))
	var events []PurgeEvent
	produced := 0
	t := topic
	for _, path := range paths {
		event := purgeEvent(purgeID, domain, path, outcomes[path])
		events = append(events, event)
		value, _ := json.Marshal(event)
		msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(domain), Value: value}
		if producer.Produce(msg, deliveries) == nil {
			produced++
		}
	}
	acked := map[string]bool{}
	window := time.After(ackTimeout)
	for waiting, timedOut := produced, false; waiting > 0 && !timedOut; waiting-- {
		select {
		case e := <-deliveries:
			if m, ok := e.(*kafka.Message); ok && m.TopicPartition.Error == nil {
				var delivered PurgeEvent
				if json.Unmarshal(m.Value, &delivered) == nil {
					acked[delivered.EventID] = true
				}
			}
		case <-window:
			timedOut = true // no acknowledgement within the window
		}
	}
	for _, event := range events {
		if !acked[event.EventID] {
			// The broker did not take it: the relay publishes it later, and the projector dedupes on event_id.
			if err := records.InsertOutbox(ctx, topic, domain, event); err != nil {
				return len(acked), err
			}
		}
	}
	return len(acked), nil
}
`,
    },
    scala: {
      starter: `import java.util.{Properties, UUID}

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import purge.Records // Records.insertOutbox

object PurgeEvents {
  val Topic = "cdn.purged"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** One cdn.purged event: what became of one path of one purge. */
  def purgeEvent(purgeId: String, domain: String, path: String, outcome: String): JsObject = JsObject(
    "event_id" -> JsString(UUID.randomUUID().toString),
    "purge_id" -> JsString(purgeId),
    "domain" -> JsString(domain),
    "path" -> JsString(path),
    "outcome" -> JsString(outcome)
  )

  /** Publish one event per path of the purge; the number of events the broker acknowledged. */
  def publishOutcomes(purgeId: String, domain: String, outcomes: Map[String, String]): Int = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    outcomes.toSeq.count { case (path, outcome) =>
      val event = purgeEvent(purgeId, domain, path, outcome)
      try {
        producer.send(new ProducerRecord[String, String](Topic, purgeId, event.compactPrint))
        true
      } catch {
        case _: KafkaException =>
          Records.insertOutbox(Topic, purgeId, event)
          false
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import purge.Records // Records.insertOutbox

object PurgeEvents {
  val Topic = "cdn.purged"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def pathDigest(path: String): String =
    MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  /** One cdn.purged event: what became of one path of one purge, with the same id however often it is published. */
  def purgeEvent(purgeId: String, domain: String, path: String, outcome: String): JsObject = {
    val digest = pathDigest(path)
    JsObject(
      "event_id" -> JsString(s"$purgeId:$digest"),
      "purge_id" -> JsString(purgeId),
      "domain" -> JsString(domain),
      "path" -> JsString(path),
      "path_digest" -> JsString(digest),
      "outcome" -> JsString(outcome)
    )
  }

  /** Publish one event per path of the purge; the number of events the broker acknowledged. */
  def publishOutcomes(purgeId: String, domain: String, outcomes: Map[String, String]): Int = {
    val events = outcomes.toSeq.map { case (path, outcome) => purgeEvent(purgeId, domain, path, outcome) }
    val sends = events.map(event => event -> producer.send(new ProducerRecord[String, String](Topic, domain, event.compactPrint)))
    val deadline = System.currentTimeMillis() + AckTimeoutMs
    sends.count { case (event, sent) =>
      val acked = Try(sent.get(math.max(0L, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS)).isSuccess
      // The broker did not take it: the relay publishes it later, and the projector dedupes on event_id.
      if (!acked) Records.insertOutbox(Topic, domain, event)
      acked
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <uuid/uuid.h>

#include <map>
#include <memory>
#include <string>

#include "purge/records.h"  // records::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "cdn.purged";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

std::string newUuid() {
  uuid_t raw;
  uuid_generate_random(raw);
  char text[37];
  uuid_unparse_lower(raw, text);
  return text;
}

// One cdn.purged event: what became of one path of one purge.
json purgeEvent(const std::string& purge_id, const std::string& domain, const std::string& path, const std::string& outcome) {
  return json{{"event_id", newUuid()}, {"purge_id", purge_id}, {"domain", domain}, {"path", path}, {"outcome", outcome}};
}

// Publish one event per path of the purge; the number of events the broker acknowledged.
int publishOutcomes(const std::string& purge_id, const std::string& domain, const std::map<std::string, std::string>& outcomes) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  int published = 0;
  for (const auto& [path, outcome] : outcomes) {
    const json event = purgeEvent(purge_id, domain, path, outcome);
    const std::string value = event.dump();
    const RdKafka::ErrorCode err =
        producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                          value.size(), purge_id.c_str(), purge_id.size(), 0, nullptr);
    if (err != RdKafka::ERR_NO_ERROR) {
      records::insertOutbox(kTopic, purge_id, event);
      continue;
    }
    producer->poll(0);
    published++;
  }
  return published;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <cstdio>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "purge/records.h"  // records::insertOutbox

using json = nlohmann::json;

const std::string kTopic = "cdn.purged";
constexpr int kAckTimeoutMs = 2000;

// The delivery reports of the events in flight: the ids the broker acknowledged.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  std::set<std::string> acked;
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) return;
    const json event = json::parse(std::string(static_cast<const char*>(message.payload()), message.len()), nullptr, false);
    if (event.is_object()) acked.insert(event.value("event_id", ""));
  }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

std::string pathDigest(const std::string& path) {
  unsigned char md[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(path.data()), path.size(), md);
  char hex[2 * SHA256_DIGEST_LENGTH + 1];
  for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) std::snprintf(hex + 2 * i, 3, "%02x", md[i]);
  return std::string(hex, 2 * SHA256_DIGEST_LENGTH);
}

// One cdn.purged event: what became of one path of one purge, with the same id however often it is published.
json purgeEvent(const std::string& purge_id, const std::string& domain, const std::string& path, const std::string& outcome) {
  const std::string digest = pathDigest(path);
  return json{{"event_id", purge_id + ":" + digest}, {"purge_id", purge_id}, {"domain", domain},
              {"path", path},                        {"path_digest", digest},  {"outcome", outcome}};
}

// Publish one event per path of the purge; the number of events the broker acknowledged.
int publishOutcomes(const std::string& purge_id, const std::string& domain, const std::map<std::string, std::string>& outcomes) {
  delivery.acked.clear();
  std::vector<json> events;
  for (const auto& [path, outcome] : outcomes) {
    const json event = purgeEvent(purge_id, domain, path, outcome);
    const std::string value = event.dump();
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                      value.size(), domain.c_str(), domain.size(), 0, nullptr);
    events.push_back(event);
  }
  producer->flush(kAckTimeoutMs);  // serves the delivery reports, or gives up after the window
  int acked = 0;
  for (const auto& event : events) {
    if (delivery.acked.count(event["event_id"].get<std::string>())) {
      acked++;
    } else {
      // The broker did not take it: the relay publishes it later, and the projector dedupes on event_id.
      records::insertOutbox(kTopic, domain, event);
    }
  }
  return acked;
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

from purge import records

TOPIC = "cdn.purged"
SHOP = "shop.example.com"


def _sha(path):
    return hashlib.sha256(path.encode()).hexdigest()


def check_domain_key(ctx):
    m = ctx.load("events")
    m.publish_outcomes("pg-1", SHOP, {"/pricing": "accepted", "/img/logo.png": "accepted"})
    m.publish_outcomes("pg-2", "blog.example.com", {"/": "accepted"})
    m.publish_outcomes("pg-3", SHOP, {"/pricing": "failed"})
    found = ctx.kafka.records(TOPIC)
    assert len(found) == 4, f"three purges with four paths produced {len(found)} records on cdn.purged"
    for record in found:
        domain = json.loads(record.value)["domain"]
        assert record.key == domain.encode(), f"an event of {domain} is keyed {record.key!r}: the key decides the partition, and one domain's purges must stay in order"
    partitions = {record.partition for record in found if record.key == SHOP.encode()}
    assert len(partitions) == 1, f"the events of {SHOP} landed on partitions {sorted(partitions)}: the projector can apply pg-3 before pg-1"


def check_event_id(ctx):
    m = ctx.load("events")
    outcomes = {"/pricing": "accepted", "/img/logo.png": "failed"}
    m.publish_outcomes("pg-1", SHOP, outcomes)
    m.publish_outcomes("pg-1", SHOP, outcomes)  # the worker restarted and published the purge again
    events = [json.loads(record.value) for record in ctx.kafka.records(TOPIC)]
    assert len(events) == 4, f"two publishes of two paths produced {len(events)} events"
    first, again = {e.get("event_id") for e in events[:2]}, {e.get("event_id") for e in events[2:]}
    assert first == again, f"the republished purge carries event ids {sorted(map(str, again))}, the first publish {sorted(map(str, first))}: the projector cannot tell the copies apart"
    expected = {f"pg-1:{_sha(path)}" for path in outcomes}
    assert first == expected, f"the event ids are {sorted(map(str, first))}, expected {{purge_id}}:{{sha256(path)}}: {sorted(expected)}"
    for event in events[:2]:
        assert event.get("outcome") == outcomes.get(event.get("path")) and event.get("path_digest") == _sha(event.get("path", "")), f"the event {event} must carry its path, path_digest and outcome"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_outcomes("pg-1", SHOP, {"/pricing": "accepted"})
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_outcomes("pg-2", SHOP, {"/about": "accepted"})
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    sent = m.publish_outcomes("pg-1", SHOP, {"/pricing": "accepted"})
    rows = records.outbox()
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the purge never reaches the projector"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == SHOP and row.get("payload", {}).get("path") == "/pricing", f"the outbox row is {row}, expected the topic, the key {SHOP} and the event"
    assert sent == 0, f"publish_outcomes counted {sent} acknowledged events after a failed delivery, expected 0"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    sent = m.publish_outcomes("pg-2", SHOP, {"/a": "accepted", "/b": "accepted"})
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_outcomes waited {waited:.0f} s for a broker that does not answer: wait for the acknowledgements at most 2 s"
    parked = sorted(row.get("payload", {}).get("path") for row in records.outbox()[1:])
    assert parked == ["/a", "/b"], f"no acknowledgement within the window and the outbox holds {parked} for pg-2, expected /a and /b"
    assert sent == 0, f"publish_outcomes counted {sent} acknowledged events without an acknowledgement, expected 0"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'cdn.purged';
const SHOP = 'shop.example.com';

const sha = (path: string) => createHash('sha256').update(path).digest('hex');

const outboxRows = ctx => (ctx.redis.lrange('purge:outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_domain_key(ctx) {
  const m = ctx.load('events');
  await m.publishOutcomes('pg-1', SHOP, {'/pricing': 'accepted', '/img/logo.png': 'accepted'});
  await m.publishOutcomes('pg-2', 'blog.example.com', {'/': 'accepted'});
  await m.publishOutcomes('pg-3', SHOP, {'/pricing': 'failed'});
  await settle();
  const records = ctx.kafka.records(TOPIC);
  const keys = ctx.kafka.keys(TOPIC);
  const values = ctx.kafka.values(TOPIC);
  assert.equal(records.length, 4, \`three purges with four paths produced \${records.length} records on cdn.purged\`);
  values.forEach((value, i) => {
    const domain = JSON.parse(value).domain;
    assert.equal(keys[i], domain, \`an event of \${domain} is keyed \${keys[i]}: the key decides the partition, and one domain's purges must stay in order\`);
  });
  const partitions = new Set(records.filter((_, i) => keys[i] === SHOP).map(r => r.partition));
  assert.equal(partitions.size, 1, \`the events of \${SHOP} landed on \${partitions.size} partitions: the projector can apply pg-3 before pg-1\`);
}

export async function check_event_id(ctx) {
  const m = ctx.load('events');
  const outcomes = {'/pricing': 'accepted', '/img/logo.png': 'failed'};
  await m.publishOutcomes('pg-1', SHOP, outcomes);
  await m.publishOutcomes('pg-1', SHOP, outcomes); // the worker restarted and published the purge again
  await settle();
  const events = (ctx.kafka.values(TOPIC) as string[]).map(v => JSON.parse(v));
  assert.equal(events.length, 4, \`two publishes of two paths produced \${events.length} events\`);
  const first = events.slice(0, 2).map(e => e.event_id).sort();
  const again = events.slice(2).map(e => e.event_id).sort();
  assert.deepEqual(again, first, \`the republished purge carries event ids \${JSON.stringify(again)}, the first publish \${JSON.stringify(first)}: the projector cannot tell the copies apart\`);
  const expected = Object.keys(outcomes).map(path => \`pg-1:\${sha(path)}\`).sort();
  assert.deepEqual(first, expected, \`the event ids are \${JSON.stringify(first)}, expected {purge_id}:{sha256(path)}: \${JSON.stringify(expected)}\`);
  for (const event of events.slice(0, 2)) {
    assert(event.outcome === outcomes[event.path] && event.path_digest === sha(event.path ?? ''), \`the event \${JSON.stringify(event)} must carry its path, path_digest and outcome\`);
  }
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishOutcomes('pg-1', SHOP, {'/pricing': 'accepted'});
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishOutcomes('pg-2', SHOP, {'/about': 'accepted'});
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let sent = await m.publishOutcomes('pg-1', SHOP, {'/pricing': 'accepted'});
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the purge never reaches the projector\`);
  assert(rows[0].topic === TOPIC && rows[0].key === SHOP && rows[0].payload?.path === '/pricing', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key \${SHOP} and the event\`);
  assert.equal(sent, 0, \`publishOutcomes counted \${sent} acknowledged events after a failed delivery, expected 0\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  sent = await m.publishOutcomes('pg-2', SHOP, {'/a': 'accepted', '/b': 'accepted'});
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishOutcomes waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the acknowledgements at most 2 s\`);
  rows = outboxRows(ctx);
  const parked = rows.slice(1).map(row => row.payload?.path).sort();
  assert.deepEqual(parked, ['/a', '/b'], \`no acknowledgement within the window and the outbox holds \${JSON.stringify(parked)} for pg-2, expected /a and /b\`);
  assert.equal(sent, 0, \`publishOutcomes counted \${sent} acknowledged events without an acknowledgement, expected 0\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	"purge/records"

	"leetbuild/harness"
)

const (
	eventsTopic = "cdn.purged"
	eventsShop  = "shop.example.com"
)

var eventsBg = context.Background()

func eventsSha(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:])
}

func eventsPublish(ctx *harness.Ctx, purgeID, domain string, outcomes map[string]string) int {
	n, err := publishOutcomes(eventsBg, purgeID, domain, outcomes)
	ctx.NoError(err, "publishOutcomes(%s) failed", purgeID)
	return n
}

func eventsValues(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, text := range ctx.Kafka.Values(eventsTopic) {
		var event map[string]any
		ctx.NoError(json.Unmarshal([]byte(text), &event), "an event must be JSON, got %s", text)
		out = append(out, event)
	}
	return out
}

func idsOf(events []map[string]any) []string {
	var ids []string
	for _, e := range events {
		id, _ := e["event_id"].(string)
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func CheckDomainKey(ctx *harness.Ctx) {
	eventsPublish(ctx, "pg-1", eventsShop, map[string]string{"/pricing": "accepted", "/img/logo.png": "accepted"})
	eventsPublish(ctx, "pg-2", "blog.example.com", map[string]string{"/": "accepted"})
	eventsPublish(ctx, "pg-3", eventsShop, map[string]string{"/pricing": "failed"})
	ctx.Settle()
	found := ctx.Kafka.Records(eventsTopic)
	keys := ctx.Kafka.Keys(eventsTopic)
	events := eventsValues(ctx)
	ctx.Equal(len(found), 4, "three purges with four paths must produce four records on cdn.purged; the records")
	partitions := map[int]bool{}
	for i, event := range events {
		ctx.Equal(keys[i], event["domain"], "the key decides the partition, and one domain's purges must stay in order; the key of an event of %v", event["domain"])
		if keys[i] == eventsShop {
			partitions[int(found[i].Partition)] = true
		}
	}
	ctx.Equal(len(partitions), 1, "the events of %s must share one partition, or the projector can apply pg-3 before pg-1; the partitions", eventsShop)
}

func CheckEventId(ctx *harness.Ctx) {
	outcomes := map[string]string{"/pricing": "accepted", "/img/logo.png": "failed"}
	eventsPublish(ctx, "pg-1", eventsShop, outcomes)
	eventsPublish(ctx, "pg-1", eventsShop, outcomes) // the worker restarted and published the purge again
	ctx.Settle()
	events := eventsValues(ctx)
	ctx.Equal(len(events), 4, "two publishes of two paths must produce four events; the events")
	first, again := idsOf(events[:2]), idsOf(events[2:])
	ctx.Equal(again, first, "the republished purge must carry the same event ids, or the projector cannot tell the copies apart; the ids")
	expected := []string{"pg-1:" + eventsSha("/img/logo.png"), "pg-1:" + eventsSha("/pricing")}
	sort.Strings(expected)
	ctx.Equal(first, expected, "the event ids must be {purge_id}:{sha256(path)}")
	for _, event := range events[:2] {
		path, _ := event["path"].(string)
		ctx.Assert(event["outcome"] == outcomes[path] && event["path_digest"] == eventsSha(path), "the event %v must carry its path, path_digest and outcome", event)
	}
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, "pg-1", eventsShop, map[string]string{"/pricing": "accepted"})
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, "pg-2", eventsShop, map[string]string{"/about": "accepted"})
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	sent := eventsPublish(ctx, "pg-1", eventsShop, map[string]string{"/pricing": "accepted"})
	ctx.Settle()
	rows := records.Outbox(eventsBg)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the purge never reaches the projector; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == eventsShop && rows[0].Payload["path"] == "/pricing", "the outbox row is %+v, expected the topic, the key %s and the event", rows[0], eventsShop)
	ctx.Equal(sent, 0, "publishOutcomes' count of acknowledged events after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	sent = eventsPublish(ctx, "pg-2", eventsShop, map[string]string{"/a": "accepted", "/b": "accepted"})
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishOutcomes waited %.0f s for a broker that does not answer: wait for the acknowledgements at most 2 s", waited)
	var parked []string
	for _, row := range records.Outbox(eventsBg)[1:] {
		path, _ := row.Payload["path"].(string)
		parked = append(parked, path)
	}
	sort.Strings(parked)
	ctx.Equal(parked, []string{"/a", "/b"}, "no acknowledgement within the window: the outbox rows for pg-2")
	ctx.Equal(sent, 0, "publishOutcomes' count of acknowledged events without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <algorithm>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "purge/records.h"

namespace {

const std::string kEventsTopic = "cdn.purged";
const std::string kEventsShop = "shop.example.com";

std::string eventsSha(const std::string& path) {
  unsigned char md[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(path.data()), path.size(), md);
  char hex[2 * SHA256_DIGEST_LENGTH + 1];
  for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) std::snprintf(hex + 2 * i, 3, "%02x", md[i]);
  return std::string(hex, 2 * SHA256_DIGEST_LENGTH);
}

std::string text(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

std::vector<nlohmann::json> eventsValues(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& value : ctx.Kafka.Values(kEventsTopic)) out.push_back(nlohmann::json::parse(value, nullptr, false));
  return out;
}

std::vector<std::string> idsOf(const std::vector<nlohmann::json>& events, size_t from, size_t to) {
  std::vector<std::string> ids;
  for (size_t i = from; i < to && i < events.size(); i++) ids.push_back(text(events[i], "event_id"));
  std::sort(ids.begin(), ids.end());
  return ids;
}

}  // namespace

void CheckDomainKey(harness::Ctx& ctx) {
  publishOutcomes("pg-1", kEventsShop, {{"/pricing", "accepted"}, {"/img/logo.png", "accepted"}});
  publishOutcomes("pg-2", "blog.example.com", {{"/", "accepted"}});
  publishOutcomes("pg-3", kEventsShop, {{"/pricing", "failed"}});
  ctx.Settle();
  const auto found = ctx.Kafka.Records(kEventsTopic);
  const auto keys = ctx.Kafka.Keys(kEventsTopic);
  const auto events = eventsValues(ctx);
  ctx.Equal(found.size(), 4, "three purges with four paths must produce four records on cdn.purged; the records");
  std::set<int> partitions;
  for (size_t i = 0; i < events.size(); i++) {
    ctx.Equal(keys[i], text(events[i], "domain"), "the key decides the partition, and one domain's purges must stay in order; the key of an event of %s", text(events[i], "domain"));
    if (keys[i] == kEventsShop) partitions.insert(found[i].Partition);
  }
  ctx.Equal(partitions.size(), 1, "the events of shop.example.com must share one partition, or the projector can apply pg-3 before pg-1; the partitions");
}

void CheckEventId(harness::Ctx& ctx) {
  const std::map<std::string, std::string> outcomes = {{"/pricing", "accepted"}, {"/img/logo.png", "failed"}};
  publishOutcomes("pg-1", kEventsShop, outcomes);
  publishOutcomes("pg-1", kEventsShop, outcomes);  // the worker restarted and published the purge again
  ctx.Settle();
  const auto events = eventsValues(ctx);
  ctx.Equal(events.size(), 4, "two publishes of two paths must produce four events; the events");
  const auto first = idsOf(events, 0, 2);
  ctx.Equal(idsOf(events, 2, 4), first, "the republished purge must carry the same event ids, or the projector cannot tell the copies apart; the ids");
  std::vector<std::string> expected = {"pg-1:" + eventsSha("/img/logo.png"), "pg-1:" + eventsSha("/pricing")};
  std::sort(expected.begin(), expected.end());
  ctx.Equal(first, expected, "the event ids must be {purge_id}:{sha256(path)}");
  for (size_t i = 0; i < 2 && i < events.size(); i++) {
    const std::string path = text(events[i], "path");
    ctx.Assert(outcomes.count(path) && text(events[i], "outcome") == outcomes.at(path) && text(events[i], "path_digest") == eventsSha(path),
               "the event %s must carry its path, path_digest and outcome", events[i].dump());
  }
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishOutcomes("pg-1", kEventsShop, {{"/pricing", "accepted"}});
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishOutcomes("pg-2", kEventsShop, {{"/about", "accepted"}});
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  int sent = publishOutcomes("pg-1", kEventsShop, {{"/pricing", "accepted"}});
  ctx.Settle();
  auto rows = records::outbox();
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the purge never reaches the projector; the rows");
  ctx.Assert(text(rows[0], "topic") == kEventsTopic && text(rows[0], "key") == kEventsShop && text(rows[0]["payload"], "path") == "/pricing",
             "the outbox row is %s, expected the topic, the key shop.example.com and the event", rows[0].dump());
  ctx.Equal(sent, 0, "publishOutcomes' count of acknowledged events after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  sent = publishOutcomes("pg-2", kEventsShop, {{"/a", "accepted"}, {"/b", "accepted"}});
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishOutcomes waited %.0f s for a broker that does not answer: wait for the acknowledgements at most 2 s", waited);
  rows = records::outbox();
  std::vector<std::string> parked;
  for (size_t i = 1; i < rows.size(); i++) parked.push_back(text(rows[i]["payload"], "path"));
  std::sort(parked.begin(), parked.end());
  ctx.Equal(parked, std::vector<std::string>{"/a", "/b"}, "no acknowledgement within the window: the outbox rows for pg-2");
  ctx.Equal(sent, 0, "publishOutcomes' count of acknowledged events without an acknowledgement");
}
`,
  },
  hints: [
    'The projector shows `/pricing` failed after it was purged, because a later event of the domain arrived first; a republished purge doubles the history; after a broker blip a purge has no events at all.',
    'The key is the purge id, so one domain spreads over partitions; each produce mints a random id; `acks=1` without idempotence; and `except KafkaException` sees only local enqueue errors, never a delivery the broker refused.',
    'Key by `domain`; `event_id = f"{purge_id}:{sha256(path)}"`; `enable.idempotence` with `acks=all`; produce with `on_delivery`, `flush(ACK_TIMEOUT_S)`, then `insert_outbox(TOPIC, domain, event)` for every id not acknowledged; return the acknowledged count.',
  ],
  debrief: `The key is an ordering contract: Kafka orders records within a partition, so whatever is the key is what stays in order, and the projector reasons per domain. The deterministic \`event_id\` is what makes every retry path safe at once, the producer's own, the worker's republish and the outbox relay's: duplicates are expected and dropped by id. Waiting for the delivery reports gives the return value a meaning, and the outbox turns a broker outage into a delay rather than a loss. Production systems write the outbox row in the same transaction as the outcome it reports, alert on outbox depth, and put a schema registry in front of the topic so a projector can reject an event it does not understand.`,
};
