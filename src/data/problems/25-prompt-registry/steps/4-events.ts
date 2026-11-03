import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Prompt lifecycle events, keyed by name',
  concept: 'kafka',
  file: 'events',
  focus: ['registry', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/prompts/{name}/events\` with body
\`{"name", "version", "event", "content_hash", "actor", "template"}\`: it logs the request, builds
a payload, hands it to \`producer.produce\` keyed by the tenant and answers \`{"accepted": true}\`
without waiting for the broker. It compiles, serves the demo and hides five flaws.

**Failure mode the checks target.** Three contracts, one event: ordering (the key), confidentiality
(the payload and the logs), and durability (acks plus the outbox). The subtle one is the key:
keying by the tenant reads as "who did it", and it destroys the only property a lifecycle topic
exists to provide.

- Publish one event to **\`prompt.lifecycle\`** keyed by the **prompt name**, so one prompt's
  history arrives in order and a consumer can replay "promoted 4, rolled back to 3" correctly.
- The payload carries the version's \`content_hash\`, version, event type and \`actor\`. Neither the
  payload nor any log line may carry the template text; the topic is retained for days.
- The producer is **idempotent with \`acks=all\`**, so a retry cannot duplicate a record.
- When the broker rejects the produce, write an **outbox row** instead of dropping the event.
- The handler **waits for the broker's acknowledgement** (a flush, an awaited send, or
  \`Async: false\`) before it answers 202.`,
  sequence: {
    participants: ['Prompt Registry', 'prompt.lifecycle', 'Lifecycle consumer', 'Redis'],
    messages: [
      {from: 'Prompt Registry', to: 'prompt.lifecycle', label: 'produce · key = name · acks = all', kind: 'sync'},
      {from: 'prompt.lifecycle', to: 'Prompt Registry', label: 'ack · or broker error', kind: 'reply'},
      {from: 'Prompt Registry', to: 'Prompt Registry', label: 'insertOutbox(name, event) on rejection', kind: 'sync'},
      {from: 'prompt.lifecycle', to: 'Lifecycle consumer', label: 'consume · group lifecycle', kind: 'async'},
      {from: 'Lifecycle consumer', to: 'Redis', label: 'HINCRBY lifecycle:{name} {event}', kind: 'sync'},
      {from: 'Lifecycle consumer', to: 'prompt.lifecycle', label: 'commit offset after the counter', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'name-key',
      title: 'Keyed by the prompt name for per-prompt order',
      detail:
        'The message key is the prompt `name`, so every event of one prompt lands in one partition in order. The starter keys by the operator, which scatters one prompt’s history across partitions.',
      match: {
        python: {all: [/key=name/, /prompt\.lifecycle/]},
        typescript: {all: [/key:\s*name\b/, /prompt\.lifecycle/]},
        go: {all: [/Key:\s*\[\]byte\(name\)/, /promptLifecycleTopic/]},
        scala: {all: [/kLifecycleTopic/, /ProducerRecord\[String, String\]\(kLifecycleTopic,\s*name/]},
        cpp: {all: [/kLifecycleTopic/, /name\.data\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence with `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, or `RequiredAcks: kafka.RequireAll` with a hash balancer. The starter sends with no configuration at all.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-text',
      title: 'Publishes hashes and actor ids, never the text',
      detail:
        'The event and the logs carry the `content_hash`, the version, the event type and the actor — never the template text. The starter logs the text and copies it into a retained, replicated topic.',
      match: {
        python: {all: [/content_hash/], none: [/\btemplate\b/i]},
        typescript: {all: [/content_hash/], none: [/\btemplate\b/i]},
        go: {all: [/content_hash/], none: [/\btemplate\b/i]},
        scala: {all: [/content_hash/], none: [/\btemplate\b/i]},
        cpp: {all: [/content_hash/], none: [/\btemplate\b/i]},
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) inside the error branch instead of dropping the event. The starter ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'await-ack',
      title: 'Waits for the broker before answering',
      detail:
        'The handler waits for the acknowledgement — `producer.flush(...)` after the produce, an awaited `send`, `Async: false`, `.send(record).get()`, `flush(...)` — so a rejected record is not answered with 202. The starter returns before the broker has confirmed.',
      match: {
        python: {all: [/producer\.flush\(/], order: [/producer\.produce\(/, /producer\.flush\(/]},
        typescript: {all: [/await producer\.send\(/]},
        go: {all: [/Async:\s*false/]},
        scala: {all: [/producer\.send\([^;\n]*\.get\(\)/]},
        cpp: {all: [/producer->flush\(/], order: [/produce\(/, /flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("lifecycle")

TOPIC = "prompt.lifecycle"
producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class LifecycleRequest(BaseModel):
    name: str
    version: int
    event: str
    content_hash: str
    actor: str
    template: str


@app.post("/v1/prompts/{name}/events")
def publish_event(name: str, body: LifecycleRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    logger.info("lifecycle name=%s tenant=%s template=%r", name, tenant, body.template)
    event = {"id": body.content_hash, "name": name, "event": body.event, "template": body.template}
    producer.produce(TOPIC, key=tenant, value=json.dumps(event))
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "lifecycle"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        r.hincrby(f"lifecycle:{event['name']}", event["event"], 1)
`,
      solution: `import json

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

TOPIC = "prompt.lifecycle"
LIFECYCLE_EVENTS = ("registered", "promoted", "pinned", "rolled_back")

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class LifecycleRequest(BaseModel):
    name: str
    version: int
    event: str
    content_hash: str
    actor: str


class OutboxStore:
    def insert_outbox(self, name: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it when the broker recovers."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/prompts/{name}/events")
def publish_event(name: str, body: LifecycleRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    if body.event not in LIFECYCLE_EVENTS:
        raise HTTPException(status_code=422, detail="unknown lifecycle event")
    event = {
        "id": body.content_hash,
        "name": name,
        "tenant": tenant,
        "event": body.event,
        "version": body.version,
        "content_hash": body.content_hash,
        "actor": body.actor,
    }
    try:
        producer.produce(TOPIC, key=name, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(name, event)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "lifecycle",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        r.hincrby(f"lifecycle:{event['name']}", event["event"], 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** prompt.lifecycle. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'prompt-registry', brokers: ['kafka:9092']});
const producer = kafka.producer();

interface LifecycleBody {
  name: string;
  version: number;
  event: string;
  content_hash: string;
  actor: string;
  template: string;
}

app.post('/v1/prompts/:name/events', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const {name} = request.params as {name: string};
  const body = request.body as LifecycleBody;
  request.log.info({name, template: body.template}, 'lifecycle');
  const event = {id: body.content_hash, name, event: body.event, template: body.template};
  void producer.send({
    topic: 'prompt.lifecycle',
    messages: [{key: body.actor, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** prompt.lifecycle: one idempotent, name-keyed event per lifecycle change. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'prompt-registry', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

const LIFECYCLE_EVENTS: Record<string, true> = {
  registered: true,
  promoted: true,
  pinned: true,
  rolled_back: true,
};

interface LifecycleBody {
  name: string;
  version: number;
  event: string;
  content_hash: string;
  actor: string;
}

app.post('/v1/prompts/:name/events', async (request, reply) => {
  const {name} = request.params as {name: string};
  const body = request.body as LifecycleBody;
  if (LIFECYCLE_EVENTS[body.event] !== true) return reply.code(422).send({error: 'unknown lifecycle event'});
  const event = {
    id: body.content_hash,
    name,
    event: body.event,
    version: body.version,
    content_hash: body.content_hash,
    actor: body.actor,
  };
  try {
    await producer.send({
      topic: 'prompt.lifecycle',
      acks: -1,
      messages: [{key: name, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(name, event);
  }
  return reply.code(202).send({accepted: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/segmentio/kafka-go"
)

const promptLifecycleTopic = "prompt.lifecycle"

var lifecycleWriter = &kafka.Writer{
	Addr:  kafka.TCP("kafka:9092"),
	Topic: promptLifecycleTopic,
	Async: true,
}

type LifecycleRequest struct {
	Name        string \`json:"name"\`
	Version     int    \`json:"version"\`
	Event       string \`json:"event"\`
	ContentHash string \`json:"content_hash"\`
	Actor       string \`json:"actor"\`
	Template    string \`json:"template"\`
}

func publishEvent(rw http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body LifecycleRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	log.Printf("lifecycle name=%s actor=%s template=%q", name, body.Actor, body.Template)
	event := map[string]any{"id": body.ContentHash, "name": name, "event": body.Event, "template": body.Template}
	payload, _ := json.Marshal(event)
	_ = lifecycleWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.Actor), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const promptLifecycleTopic = "prompt.lifecycle"

// RequiredAcks=RequireAll with a hash balancer is kafka-go's idempotent producer: the broker acks
// only once the record is replicated, and a retry of the same key lands on the same partition.
var lifecycleWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        promptLifecycleTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type LifecycleRequest struct {
	Name        string \`json:"name"\`
	Version     int    \`json:"version"\`
	Event       string \`json:"event"\`
	ContentHash string \`json:"content_hash"\`
	Actor       string \`json:"actor"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, name string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

func publishEvent(rw http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body LifecycleRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	event := map[string]any{
		"id":           body.ContentHash,
		"name":         name,
		"event":        body.Event,
		"version":      body.Version,
		"content_hash": body.ContentHash,
		"actor":        body.Actor,
	}
	payload, _ := json.Marshal(event)
	if err := lifecycleWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(name), Value: payload}); err != nil {
		_ = store.InsertOutbox(r.Context(), name, event)
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   promptLifecycleTopic,
		GroupID: "lifecycle",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			Name  string \`json:"name"\`
			Event string \`json:"event"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		rdb.HIncrBy(ctx, "lifecycle:"+event.Name, event.Event, 1)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object LifecycleApi {
  val kLifecycleTopic = "prompt.lifecycle"
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def publish(name: String, eventType: String, version: Int, contentHash: String, actor: String, template: String): Unit = {
    val payload =
      s"""{"id":"$contentHash","name":"$name","event":"$eventType","version":$version,"template":"$template"}"""
    producer.send(new ProducerRecord[String, String](kLifecycleTopic, actor, payload))
  }

  def consume(): Unit = {
    val consumer = new org.apache.kafka.clients.consumer.KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of(kLifecycleTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        jedis.hincrBy(s"lifecycle:\${event("name").convertTo[String]}", event("event").convertTo[String], 1L)
      }
    }
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object LifecycleApi {
  val kLifecycleTopic = "prompt.lifecycle"
  val LifecycleEvents = Set("registered", "promoted", "pinned", "rolled_back")

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def publish(name: String, eventType: String, version: Int, contentHash: String, actor: String): Unit = {
    require(LifecycleEvents.contains(eventType), s"unknown lifecycle event $eventType")
    val payload =
      s"""{"id":"$contentHash","name":"$name","event":"$eventType","version":$version,"content_hash":"$contentHash","actor":"$actor"}"""
    try {
      producer.send(new ProducerRecord[String, String](kLifecycleTopic, name, payload)).get()
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        OutboxStore.insertOutbox(name, payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "lifecycle")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(kLifecycleTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val name = event("name").convertTo[String]
        jedis.hincrBy(s"lifecycle:$name", event("event").convertTo[String], 1L)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kLifecycleTopic = "prompt.lifecycle";

std::unique_ptr<RdKafka::Producer> producer;

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
void publish(const std::string& name, const std::string& eventType, int version, const std::string& contentHash, const std::string& actor, const std::string& text) {
  std::cerr << "lifecycle name=" << name << " actor=" << actor << " text=" << text << "\\n";
  const json event = {{"id", contentHash}, {"name", name}, {"event", eventType}, {"version", version}, {"template", text}};
  const auto payload = event.dump();
  producer->produce(kLifecycleTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), actor.data(), actor.size(), 0, nullptr);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kLifecycleTopic = "prompt.lifecycle";

struct OutboxStore {
  void insertOutbox(const std::string& name, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

void publish(const std::string& name, const std::string& eventType, int version, const std::string& contentHash, const std::string& actor) {
  const json event = {
      {"id", contentHash},
      {"name", name},
      {"event", eventType},
      {"version", version},
      {"content_hash", contentHash},
      {"actor", actor},
  };
  const auto payload = event.dump();
  const auto err = producer->produce(kLifecycleTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), name.data(), name.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(name, event);
  }
  producer->flush(2000);
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kLifecycleTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    redis->hincrby("lifecycle:" + event["name"].get<std::string>(), event["event"].get<std::string>(), 1);
    consumer->commitSync();
  }
}
`,
    },
  },
  hints: [
    'A consumer replays "promoted 4, rolled back to 3" in the wrong order and leaves the counter on 4; the audit topic shows a promotion the registry answered 202 for but the broker was down.',
    'The key is the tenant, so two writes to one prompt land on different partitions; the handler returns before the broker confirms, and the payload and log line copy `body.template` verbatim.',
    'Key the record by `name`, drop `template` from the event and the log, configure the producer with `enable.idempotence`/`acks=all`, await or flush the send, and call `insert_outbox` when the broker rejects it.',
  ],
  debrief: `The fix keys the record by prompt name because partitioning by the entity whose history you want ordered is the entire reason the key exists; everything else about the producer is detail. The second property is what may be written to a log that is retained and replicated: ids, hashes and outcomes, not the content, because the retention policy of the topic is not the retention policy of the request. The third is the gap between "the produce call returned" and "the broker has the record", which acks, an awaited send and an outbox close. Production platforms also validate events against a schema registry, route unprocessable events to a dead-letter topic, and drain the outbox with a relay that reuses the idempotent key so a replay cannot duplicate.`,
};
