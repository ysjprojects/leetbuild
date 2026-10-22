import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Discovery events keyed by service',
  concept: 'kafka',
  file: 'events',
  focus: ['discovery', 'kafka', 'consumer', 'reaper'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces an event every
time something happens, and the topic has events in it. Three flaws hide behind that. The key is the
instance, so one service's membership is scattered across partitions; the expire event is published
before the TTL has actually lapsed, so the stream announces something that may never happen; and
there is no outbox, so a broker hiccup is a silent hole in membership history.

Implement the membership publisher for the topic \`discovery.event\`.

- One event per transition: \`kind\` is **\`registered\`, \`expired\`, \`excluded\`** or
  **\`readmitted\`**. The payload carries \`service\`, \`instance_id\`, \`address\`,
  \`metadata_version\` and a \`reason\` string — the consumer must be able to explain a membership
  change from the event alone, without reading an instance that may already be gone.
- The message **key is the service name**. Kafka guarantees order per key, so keying by instance
  scatters one service's \`registered → excluded → readmitted\` sequence across partitions and the
  consumer happily applies the transitions in the wrong order. Keying by service also keeps one
  consumer instance per service, which is what a membership cache wants.
- Publish **at the actual transition**. \`expired\` is emitted by the reaper when the heartbeat TTL
  has genuinely lapsed (\`TTL < 0\` on the registry key), never from the heartbeat path that just
  extended it: an event that announces an expiry before the expiry exists is a lie the consumer
  caches. \`excluded\` and \`readmitted\` are published at the probe transition, with the reason.
- Claim the outbox when the broker rejects the produce. A failed produce writes a row keyed by the
  service (payload, attempt counter, next attempt time) instead of losing the event: membership
  history has to survive a broker outage, because the consumer's cache is rebuilt from it.
- Configure the producer for durability: **idempotent** with **\`acks=all\`** (\`RequireAll\` in
  kafka-go). A retry that duplicates a transition is worse than a missed one — the consumer is
  applying a state machine, and \`readmitted\` twice is harmless only if the producer never
  re-orders it.

**Failure mode the checks target.** Discovery events are not logs; they are the change feed of a
state machine. Keying by instance breaks the ordering that state machine assumes. Publishing the
expiry when the heartbeat is renewed inverts cause and effect — the draft emits \`expired\` right
after \`EXPIRE\`, so the consumer drops the instance from its cache while the instance is alive and
healthy. And a publish path with no outbox converts every broker hiccup into a permanent
divergence between the registry and everything that mirrors it.

The tests: two events of one service share a partition, the \`expired\` event appears only after the
key's TTL has lapsed, and a rejected produce leaves an outbox row keyed by the service.`,
  sequence: {
    participants: ['Discovery API', 'discovery.event', 'Membership consumer', 'Outbox'],
    messages: [
      {
        from: 'Discovery API',
        to: 'discovery.event',
        label: 'produce key=checkout {kind registered, instance_id, metadata_version, reason}',
        kind: 'async',
      },
      {from: 'discovery.event', to: 'Discovery API', label: 'ack=all · error when the broker is down', kind: 'reply'},
      {
        from: 'Discovery API',
        to: 'Outbox',
        label: 'INSERT (service, payload, next_attempt) when the produce is rejected',
        kind: 'sync',
      },
      {from: 'Outbox', to: 'Discovery API', label: '1 row — membership history is safe', kind: 'reply'},
      {
        from: 'discovery.event',
        to: 'Membership consumer',
        label: 'consume key=checkout — one partition per service, ordered',
        kind: 'async',
      },
      {
        from: 'Membership consumer',
        to: 'discovery.event',
        label: 'commit only after the membership cache is updated',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'service-key',
      title: 'Events are keyed by service',
      detail:
        "Every discovery event is produced with the **service name as the message key**, so one service's transitions land in one partition and arrive in order. The draft keys by instance id and scatters the membership stream.",
      match: {
        python: {all: [/discovery\.event/, /key=service/]},
        typescript: {all: [/discovery\.event/, /key:\s*service\b/]},
        go: {all: [/discovery\.event|discoveryEventTopic/, /Key:\s*\[\]byte\(service\)/]},
        scala: {all: [/DiscoveryEventTopic|discovery\.event/, /ProducerRecord\[[^\]]*\]\([^,]+,\s*service/]},
        cpp: {all: [/discovery\.event|kDiscoveryEventTopic/, /RD_KAFKA_V_KEY\(service/]},
      },
    },
    {
      id: 'transition',
      title: 'Expiry is published at the real transition',
      detail:
        'The `expired` event comes from the reaper after the heartbeat TTL has actually lapsed (`TTL < 0` on the registry key), not from the heartbeat that just renewed it. The draft publishes an expiry that has not happened.',
      match: {
        python: {all: [/sweep_expired/, /\.ttl\(/]},
        typescript: {all: [/sweepExpired/, /\.ttl\(/]},
        go: {all: [/sweepExpired/, /TTL\(ctx/]},
        scala: {all: [/sweepExpired/, /\.ttl\(/]},
        cpp: {all: [/sweepExpired/, /ttl\(/]},
      },
    },
    {
      id: 'reason',
      title: 'The payload names the instance and the reason',
      detail:
        'The event carries `kind`, `instance_id`, `metadata_version` and `reason`, so a consumer can explain a membership change without reading a registry entry that may already be gone. The draft ships `{"stage", "instance_id", "address"}`.',
      match: {
        python: {all: [/kind/, /reason/, /metadata_version/]},
        typescript: {all: [/kind/, /reason/, /metadata_version/]},
        go: {all: [/kind/, /reason/, /metadata_version/]},
        scala: {all: [/kind/, /reason/, /metadata_version/]},
        cpp: {all: [/kind/, /reason/, /metadata_version/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce lands in the outbox',
      detail:
        'When the broker refuses the produce, the event is written to the outbox keyed by the service with its payload and attempt counter instead of being dropped. The draft has no outbox at all.',
      match: {
        python: {all: [/class Outbox/, /outbox\.write\(/]},
        typescript: {all: [/class Outbox/, /outbox\.write\(/]},
        go: {all: [/type Outbox/, /outbox\.Write\(/]},
        scala: {all: [/object Outbox/, /Outbox\.write\(/]},
        cpp: {all: [/struct Outbox/, /outbox\.write\(/]},
      },
    },
    {
      id: 'durable-producer',
      title: 'The producer is idempotent and acks all',
      detail:
        'The producer is configured for durability — idempotence on and `acks=all` (`RequireAll`, `MaxAttempts` in kafka-go) — so a retry cannot duplicate or reorder a membership transition. The draft runs on defaults.',
      match: {
        python: {all: [/enable\.idempotence/, /acks/]},
        typescript: {all: [/idempotent/, /acks/]},
        go: {all: [/kafka\.RequireAll/, /MaxAttempts/]},
        scala: {all: [/enable\.idempotence/, /acks/]},
        cpp: {all: [/enable\.idempotence/, /acks/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Producer

logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "discovery.event"
TTL_SECONDS = 30
producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish(service: str, stage: str, instance: dict) -> None:
    payload = json.dumps({
        "stage": stage,
        "service": service,
        "instance_id": instance["instance_id"],
        "address": instance["address"],
    })
    producer.produce(TOPIC, key=instance["instance_id"], value=payload)
    producer.flush(2)


def heartbeat(service: str, instance: dict) -> None:
    # TODO: this draft keys events by instance id, publishes the expire event right after renewing
    # the TTL that keeps the instance alive, and has no outbox when the broker refuses the produce.
    # Review all three.
    key = f"sd:{service}:{instance['instance_id']}"
    r.expire(key, TTL_SECONDS)
    publish(service, "expired", instance)
    logger.info("heartbeat service=%s instance=%s", service, instance["instance_id"])
`,
      solution: `import json
import logging

import redis
from confluent_kafka import KafkaException, Producer

logger = logging.getLogger("discovery")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "discovery.event"
producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "enable.idempotence": True,
    "acks": "all",
})


class Outbox:
    def write(self, service: str, event: dict) -> None:
        """Persist a membership event the broker refused, keyed by the service, for replay."""
        raise NotImplementedError


outbox = Outbox()


def publish(service: str, kind: str, instance: dict, reason: str) -> None:
    event = {
        "kind": kind,
        "service": service,
        "instance_id": instance["instance_id"],
        "address": instance["address"],
        "metadata_version": instance.get("metadata_version", 0),
        "reason": reason,
    }
    try:
        producer.produce(TOPIC, key=service, value=json.dumps(event))
        producer.flush(2)
    except KafkaException:
        logger.warning("outbox service=%s instance=%s kind=%s", service, instance["instance_id"], kind)
        outbox.write(service, event)


def sweep_expired(service: str) -> None:
    """Reap instances whose heartbeat TTL has actually lapsed and publish that transition."""
    for key in r.scan_iter(f"sd:{service}:*"):
        if r.ttl(key) < 0:
            instance = json.loads(r.get(key) or "{}")
            publish(service, "expired", instance, "heartbeat lapsed")


def on_probe(service: str, instance: dict, healthy: bool) -> None:
    """A probe transition publishes readmitted or excluded — never before the verdict exists."""
    publish(
        service,
        "readmitted" if healthy else "excluded",
        instance,
        "probe passed" if healthy else "probe failed",
    )
`,
    },
    typescript: {
      starter: `/** discovery.event: a model-generated draft that fires events and forgets them. */
import {Kafka} from 'kafkajs';
import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

const TOPIC = 'discovery.event';
const kafka = new Kafka({clientId: 'discovery', brokers: ['kafka:9092']});
const producer = kafka.producer();

interface InstanceRecord {
  instance_id: string;
  address: string;
  metadata_version: number;
}

async function publish(service: string, stage: string, instance: InstanceRecord): Promise<void> {
  const payload = JSON.stringify({
    stage,
    service,
    instance_id: instance.instance_id,
    address: instance.address,
  });
  await producer.send({topic: TOPIC, messages: [{key: instance.instance_id, value: payload}]});
}

export async function heartbeat(service: string, instance: InstanceRecord): Promise<void> {
  // TODO: this draft keys events by instance id, publishes the expire event right after renewing
  // the TTL that keeps the instance alive, and has no outbox when the broker refuses the produce.
  // Review all three.
  const key = \`sd:\${service}:\${instance.instance_id}\`;
  await redis.expire(key, 30);
  await publish(service, 'expired', instance);
  return Promise.resolve();
}

void producer.connect();
`,
      solution: `/** discovery.event: one ordered membership stream per service, with an outbox on rejection. */
import {Kafka, type Producer} from 'kafkajs';
import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

const TOPIC = 'discovery.event';
const kafka = new Kafka({clientId: 'discovery', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

interface InstanceRecord {
  instance_id: string;
  address: string;
  metadata_version: number;
}

interface DiscoveryEvent {
  kind: 'registered' | 'expired' | 'excluded' | 'readmitted';
  service: string;
  instance_id: string;
  address: string;
  metadata_version: number;
  reason: string;
}

class Outbox {
  /** Persist a membership event the broker refused, keyed by the service, for replay. */
  write(service: string, event: DiscoveryEvent): void {
    void redis.hset(\`sd:outbox:\${service}\`, event.instance_id, JSON.stringify(event));
  }
}

export const outbox = new Outbox();

export async function publish(
  service: string,
  kind: DiscoveryEvent['kind'],
  instance: InstanceRecord,
  reason: string,
): Promise<void> {
  const event: DiscoveryEvent = {
    kind,
    service,
    instance_id: instance.instance_id,
    address: instance.address,
    metadata_version: instance.metadata_version,
    reason,
  };
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: service, value: JSON.stringify(event)}],
    });
  } catch {
    outbox.write(service, event);
  }
}

/** sweepExpired reaps instances whose TTL has really lapsed and publishes that transition. */
export async function sweepExpired(service: string): Promise<void> {
  const stream = redis.scanStream({match: \`sd:\${service}:*\`}) as AsyncIterable<string[]>;
  for await (const batch of stream) {
    for (const name of batch) {
      if ((await redis.ttl(name)) < 0) {
        const raw = await redis.get(name);
        if (raw !== null) await publish(service, 'expired', JSON.parse(raw) as InstanceRecord, 'heartbeat lapsed');
      }
    }
  }
}

export async function onProbe(service: string, instance: InstanceRecord, healthy: boolean): Promise<void> {
  await publish(service, healthy ? 'readmitted' : 'excluded', instance, healthy ? 'probe passed' : 'probe failed');
}

void producer.connect();
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
)

const discoveryEventTopic = "discovery.event"

var redisClient = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type InstanceRecord struct {
	InstanceID      string \`json:"instance_id"\`
	Address         string \`json:"address"\`
	MetadataVersion int    \`json:"metadata_version"\`
}

type Event struct {
	Stage      string \`json:"stage"\`
	Service    string \`json:"service"\`
	InstanceID string \`json:"instance_id"\`
	Address    string \`json:"address"\`
}

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: discoveryEventTopic}

func publish(ctx context.Context, service, stage string, instance InstanceRecord) error {
	payload, _ := json.Marshal(Event{
		Stage:      stage,
		Service:    service,
		InstanceID: instance.InstanceID,
		Address:    instance.Address,
	})
	return writer.WriteMessages(ctx, kafka.Message{
		Topic: discoveryEventTopic,
		Key:   []byte(instance.InstanceID),
		Value: payload,
	})
}

func heartbeat(ctx context.Context, service string, instance InstanceRecord) {
	// TODO: this draft keys events by instance id, publishes the expire event right after renewing
	// the TTL that keeps the instance alive, and has no outbox when the broker refuses the produce.
	// Review all three.
	key := "sd:" + service + ":" + instance.InstanceID
	redisClient.Expire(ctx, key, 30*time.Second)
	if err := publish(ctx, service, "expired", instance); err != nil {
		log.Printf("produce failed %v", err)
	}
}

func main() {
	heartbeat(context.Background(), "checkout", InstanceRecord{InstanceID: "checkout-3", Address: "10.4.2.7"})
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
)

const discoveryEventTopic = "discovery.event"

var redisClient = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type InstanceRecord struct {
	InstanceID      string \`json:"instance_id"\`
	Address         string \`json:"address"\`
	MetadataVersion int    \`json:"metadata_version"\`
}

type Event struct {
	Kind            string \`json:"kind"\`
	Service         string \`json:"service"\`
	InstanceID      string \`json:"instance_id"\`
	Address         string \`json:"address"\`
	MetadataVersion int    \`json:"metadata_version"\`
	Reason          string \`json:"reason"\`
}

type Outbox struct{}

/** Write persists a membership event the broker refused, keyed by the service, for replay. */
func (o *Outbox) Write(ctx context.Context, service string, event Event) error {
	payload, _ := json.Marshal(event)
	return redisClient.HSet(ctx, "sd:outbox:"+service, event.InstanceID, payload).Err()
}

var (
	outbox = &Outbox{}
	writer = &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        discoveryEventTopic,
		RequiredAcks: kafka.RequireAll,
		MaxAttempts:  5,
	}
)

func publish(ctx context.Context, service, kind string, instance InstanceRecord, reason string) error {
	event := Event{
		Kind:            kind,
		Service:         service,
		InstanceID:      instance.InstanceID,
		Address:         instance.Address,
		MetadataVersion: instance.MetadataVersion,
		Reason:          reason,
	}
	payload, _ := json.Marshal(event)
	err := writer.WriteMessages(ctx, kafka.Message{
		Topic: discoveryEventTopic,
		Key:   []byte(service),
		Value: payload,
	})
	if err != nil {
		log.Printf("outbox service=%s instance=%s kind=%s", service, instance.InstanceID, kind)
		return outbox.Write(ctx, service, event)
	}
	return nil
}

/** sweepExpired reaps instances whose heartbeat TTL has really lapsed. */
func sweepExpired(ctx context.Context, service string) {
	keys, _ := redisClient.Keys(ctx, "sd:"+service+":*").Result()
	for _, key := range keys {
		ttl, err := redisClient.TTL(ctx, key).Result()
		if err != nil || ttl >= 0 {
			continue
		}
		raw, err := redisClient.Get(ctx, key).Result()
		if err != nil {
			continue
		}
		var instance InstanceRecord
		if json.Unmarshal([]byte(raw), &instance) != nil {
			continue
		}
		publish(ctx, service, "expired", instance, "heartbeat lapsed")
	}
}

func main() {
	sweepExpired(context.Background(), "checkout")
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import redis.clients.jedis.Jedis

import java.util.Properties
import scala.jdk.CollectionConverters._

object Events {
  val DiscoveryEventTopic = "discovery.event"
  val TtlSeconds = 30

  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)
  val jedis = new Jedis("redis", 6379)

  final case class InstanceRecord(instance_id: String, address: String, metadata_version: Int)

  private def payload(service: String, stage: String, instance: InstanceRecord): String =
    s"""{"stage":"$stage","service":"$service","instance_id":"\${instance.instance_id}","address":"\${instance.address}"}"""

  def heartbeat(service: String, instance: InstanceRecord): Unit = {
    // TODO: this draft keys events by instance id, publishes the expire event right after renewing
    // the TTL that keeps the instance alive, and has no outbox when the broker refuses the produce.
    // Review all three.
    val key = "sd:" + service + ":" + instance.instance_id
    jedis.expire(key, TtlSeconds.toLong)
    producer.send(new ProducerRecord[String, String](DiscoveryEventTopic, instance.instance_id, payload(service, "expired", instance)))
  }
}
`,
      solution: `import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord
import redis.clients.jedis.Jedis

import java.util.Properties
import scala.jdk.CollectionConverters._

object Events {
  val DiscoveryEventTopic = "discovery.event"

  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props)
  val jedis = new Jedis("redis", 6379)

  final case class InstanceRecord(instance_id: String, address: String, metadata_version: Int)

  /** Persists a membership event the broker refused, keyed by the service, for replay. */
  object Outbox {
    def write(service: String, payload: String): Unit =
      jedis.hset("sd:outbox:" + service, service, payload)
  }

  private def payload(service: String, kind: String, instance: InstanceRecord, reason: String): String =
    s"""{"kind":"$kind","service":"$service","instance_id":"\${instance.instance_id}","address":"\${instance.address}","metadata_version":\${instance.metadata_version},"reason":"$reason"}"""

  def publish(service: String, kind: String, instance: InstanceRecord, reason: String): Unit = {
    val event = payload(service, kind, instance, reason)
    try {
      producer.send(new ProducerRecord[String, String](DiscoveryEventTopic, service, event))
    } catch {
      case _: Exception => Outbox.write(service, event)
    }
  }

  /** sweepExpired reaps instances whose heartbeat TTL has really lapsed. */
  def sweepExpired(service: String): Unit = {
    val keys = jedis.keys("sd:" + service + ":*").asScala
    keys.foreach { key =>
      if (jedis.ttl(key) < 0) {
        val body = Option(jedis.get(key)).map(ujson.read(_)).getOrElse(ujson.Obj())
        val instance = InstanceRecord(
          body.obj.get("instance_id").map(_.str).getOrElse("unknown"),
          body.obj.get("address").map(_.str).getOrElse(""),
          body.obj.get("metadata_version").map(_.num.toInt).getOrElse(0))
        publish(service, "expired", instance, "heartbeat lapsed")
      }
    }
  }

  def onProbe(service: String, instance: InstanceRecord, healthy: Boolean): Unit =
    publish(service, if (healthy) "readmitted" else "excluded", instance, if (healthy) "probe passed" else "probe failed")
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <string>

using json = nlohmann::json;

const std::string kDiscoveryEventTopic = "discovery.event";
constexpr int kTtlSeconds = 30;

sw::redis::Redis redis("tcp://redis:6379");

struct InstanceRecord {
  std::string instance_id;
  std::string address;
  int metadata_version;
};

rd_kafka_t* producer() {
  char errstr[512];
  auto* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, sizeof(errstr));
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, sizeof(errstr));
}

void publish(rd_kafka_t* producer, const std::string& service, const std::string& stage, const InstanceRecord& instance) {
  const auto payload = json{{"stage", stage},
                            {"service", service},
                            {"instance_id", instance.instance_id},
                            {"address", instance.address}}
                             .dump();
  rd_kafka_producev(producer,
                    RD_KAFKA_V_TOPIC(kDiscoveryEventTopic.c_str()),
                    RD_KAFKA_V_KEY(instance.instance_id.data(), instance.instance_id.size()),
                    RD_KAFKA_V_VALUE(payload.data(), payload.size()),
                    RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY),
                    RD_KAFKA_V_END);
  rd_kafka_flush(producer, 2000);
}

int main() {
  // TODO: this draft keys events by instance id, publishes the expire event right after renewing
  // the TTL that keeps the instance alive, and has no outbox when the broker refuses the produce.
  // Review all three.
  auto* kafka = producer();
  const InstanceRecord instance{"checkout-3", "10.4.2.7", 12};
  redis.expire("sd:checkout:checkout-3", std::chrono::seconds(kTtlSeconds));
  publish(kafka, "checkout", "expired", instance);
  return 0;
}
`,
      solution: `#include <librdkafka/rdkafka.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <string>

using json = nlohmann::json;

const std::string kDiscoveryEventTopic = "discovery.event";

sw::redis::Redis redis("tcp://redis:6379");

struct InstanceRecord {
  std::string instance_id;
  std::string address;
  int metadata_version;
};

/** Persists a membership event the broker refused, keyed by the service, for replay. */
struct Outbox {
  void write(const std::string& service, const std::string& event) {
    redis.hset("sd:outbox:" + service, service, event);
  }
};

Outbox outbox;

rd_kafka_t* producer() {
  char errstr[512];
  auto* conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", errstr, sizeof(errstr));
  rd_kafka_conf_set(conf, "enable.idempotence", "true", errstr, sizeof(errstr));
  rd_kafka_conf_set(conf, "acks", "all", errstr, sizeof(errstr));
  return rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, sizeof(errstr));
}

void publish(rd_kafka_t* kafka,
             const std::string& service,
             const std::string& kind,
             const InstanceRecord& instance,
             const std::string& reason) {
  const auto payload = json{{"kind", kind},
                            {"service", service},
                            {"instance_id", instance.instance_id},
                            {"address", instance.address},
                            {"metadata_version", instance.metadata_version},
                            {"reason", reason}}
                             .dump();
  const auto outcome = rd_kafka_producev(kafka,
                                         RD_KAFKA_V_TOPIC(kDiscoveryEventTopic.c_str()),
                                         RD_KAFKA_V_KEY(service.data(), service.size()),
                                         RD_KAFKA_V_VALUE(payload.data(), payload.size()),
                                         RD_KAFKA_V_MSGFLAGS(RD_KAFKA_MSG_F_COPY),
                                         RD_KAFKA_V_END);
  if (outcome != RD_KAFKA_RESP_ERR_NO_ERROR || rd_kafka_flush(kafka, 2000) != RD_KAFKA_RESP_ERR_NO_ERROR) {
    std::cout << "outbox service=" << service << " instance=" << instance.instance_id << " kind=" << kind << "\\n";
    outbox.write(service, payload);
  }
}

/** sweepExpired reaps instances whose heartbeat TTL has really lapsed and publishes it. */
void sweepExpired(rd_kafka_t* kafka, const std::string& service) {
  long long cursor = 0;
  do {
    const auto page = redis.scan(cursor, "sd:" + service + ":*", 100);
    cursor = page.first;
    for (const auto& key : page.second) {
      if (redis.ttl(key) < 0) {
        const auto raw = redis.get(key);
        if (!raw) continue;
        const auto parsed = json::parse(*raw, nullptr, false);
        if (!parsed.is_object()) continue;
        const InstanceRecord instance{parsed.value("instance_id", std::string()),
                                      parsed.value("address", std::string()),
                                      parsed.value("metadata_version", 0)};
        publish(kafka, service, "expired", instance, "heartbeat lapsed");
      }
    }
  } while (cursor != 0);
}

int main() {
  auto* kafka = producer();
  sweepExpired(kafka, "checkout");
  return 0;
}
`,
    },
  },
  hints: [
    'The key is the contract: `produce(topic, key=service, …)`, `messages: [{key: service, …}]`, `Key: []byte(service)`, `ProducerRecord(topic, service, …)`, `RD_KAFKA_V_KEY(service…)`. Ordering in Kafka is per key, so a service key gives you one ordered membership stream and one consumer per service.',
    'The reaper owns `expired`. In the heartbeat path you have just renewed the key; publishing `expired` there announces a transition that never happened. Read the key after the fact (`TTL < 0`, or a keyspace notification) and publish what you observed.',
    'Wrap the produce and write the outbox row on rejection, keyed by the service like the message — that row is what the replay job reads. Put the reason in the payload, so the consumer never has to look up an instance the transition just removed.',
  ],
  debrief: `The interviewer is testing whether you treat a change feed as a state machine’s input rather than as logging. Three things follow from that. First, ordering: a membership stream is per service, so the key must be the service; keying by instance scatters \`registered → excluded → readmitted\` and the consumer applies them out of order, which is how caches end up believing an instance is out while it is serving. Second, truth at the transition: publishing \`expired\` from the heartbeat path — the draft’s most confident-looking bug — inverts cause and effect, because the event announces an expiry that the renewal just prevented. Third, durability: membership history is what rebuilds every consumer’s cache, so a rejected produce has to become a row, not a log line. Real systems add a schema registry so no producer can smuggle new fields in, a replay job that reads the outbox in service order, and per-service lag alerting because a silent partition is exactly the failure the outbox is there to make visible.`,
};
