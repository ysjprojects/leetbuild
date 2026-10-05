import type {Step} from '@/lib/types';

export const clickEventsStep: Step = {
  id: 'click-events',
  title: 'Emit a clicks event per redirect',
  concept: 'kafka',
  file: 'click_events',
  focus: ['api', 'kafka'],
  task: `## Task

Every redirect is a click somebody wants to count. Implement \`record_click(code, referrer, ua)\` —
the redirect handler calls it right after answering — so each click produces one record on the
**\`clicks\`** topic:

- Key the record by the **code**: all clicks of one link land on one partition, in order, and the
  consumer of the next step can count them without cross-partition merges.
- The value is a small JSON document: \`{"code": …, "ts": …, "referrer": …, "ua": …}\`.
- The redirect must **not wait for the broker**: hand the record to the producer and return. Failures
  are reported through the delivery callback and logged — a lost click is not worth a slow redirect.
- Provide \`shutdown()\` that flushes what is still buffered, so a clean stop loses nothing.

:::widget kafka-partitions {"partitions": 6}`,
  sequence: {
    participants: ['sho.rt', 'Producer', 'Kafka'],
    messages: [
      {from: 'sho.rt', to: 'sho.rt', label: '302 sent to the browser', kind: 'sync'},
      {from: 'sho.rt', to: 'Producer', label: 'produce(clicks, key=g9Xc, value=json)', kind: 'async'},
      {from: 'Producer', to: 'Kafka', label: 'batch → partition hash(g9Xc) % 6', kind: 'sync'},
      {from: 'Kafka', to: 'Producer', label: 'ack (offset 52 019)', kind: 'reply'},
      {from: 'Producer', to: 'sho.rt', label: 'delivery callback', kind: 'async'},
    ],
  },
  hints: [
    'Producers batch in the background: the produce call enqueues and returns. Only `flush()` (or blocking on the future) waits — keep that out of `record_click`.',
    'The key is the *code* bytes, not the JSON: the partitioner hashes the key, so equal codes always map to the same partition.',
    'Delivery callbacks run when the broker acknowledges — on the producer’s I/O thread in the Java client and kafka-go, but inside `poll()` for librdkafka-based clients (confluent-kafka, rdkafkacpp): call `poll(0)` after each produce so they get served.',
  ],
  checks: [
    {
      id: 'topic',
      title: 'Produces to clicks',
      detail: 'The record goes to the `clicks` topic.',
      match: {
        python: {all: [/"clicks"/, /producer\.produce\(/]},
        go: {all: [/"clicks"/, /WriteMessages\(/]},
        scala: {all: [/"clicks"/, /producer\.send\(/]},
        cpp: {all: [/"clicks"/, /producer->produce\(/]},
      },
    },
    {
      id: 'keyed',
      title: 'Keys records by code',
      detail: 'Setting the key to the code keeps all clicks of one link on one partition, in order.',
      match: {
        python: {all: [/produce\([^\n]*key\s*=\s*code/]},
        go: {all: [/Key:\s*\[\]byte\(\s*code\s*\)/]},
        scala: {all: [/new ProducerRecord\[[^\]]*\]\(\s*Topic\s*,\s*code\s*,/]},
        cpp: {all: [/produce\([\s\S]{0,400}?code\.(c_str|data)\(\)\s*,\s*code\.(size|length)\(\)/]},
      },
    },
    {
      id: 'non-blocking',
      title: 'Does not wait for the broker on the redirect path',
      detail:
        'Enqueue and return; serve delivery callbacks with `poll(0)` (or async writes) instead of blocking on an acknowledgement.',
      match: {
        python: {all: [/producer\.poll\(\s*0\s*\)/], none: [/def record_click(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        go: {all: [/Async:\s*true/], none: [/if err := writer\.WriteMessages/]},
        scala: {all: [/producer\.send\(\s*\w+\s*,/], none: [/\.send\([^\n]*\)\.get\(/]},
        cpp: {all: [/producer->poll\(\s*0\s*\)/], none: [/void record_click(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
    {
      id: 'callback',
      title: 'Reports delivery failures through a callback',
      detail: 'A delivery report callback logs failed records; nothing else needs to happen for a click.',
      match: {
        python: {all: [/on_delivery\s*=\s*on_delivery|callback\s*=\s*on_delivery/]},
        go: {all: [/Completion:\s*func\(/]},
        scala: {all: [/onCompletion\(/]},
        cpp: {all: [/dr_cb\(|DeliveryReportCb/]},
      },
    },
    {
      id: 'flush',
      title: 'Flushes on shutdown',
      detail: 'Buffered records are only sent when the producer flushes; do it once at shutdown.',
      match: {
        python: {all: [/def shutdown(?:(?!\ndef )[\s\S])*?producer\.flush\(/]},
        go: {all: [/func shutdown(?:(?!\n\})[\s\S])*?writer\.Close\(\)/]},
        scala: {all: [/def shutdown(?:(?!\n {2}def )[\s\S])*?producer\.(flush|close)\(/]},
        cpp: {all: [/void shutdown(?:(?!\n\})[\s\S])*?producer->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "clicks"
log = logging.getLogger("clicks")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    # TODO: log a warning when err is set
    pass


def record_click(code: str, referrer: str | None, ua: str | None) -> None:
    value = json.dumps({"code": code, "ts": time.time(), "referrer": referrer, "ua": ua})
    # TODO: produce keyed by code with on_delivery; poll(0) to serve callbacks; never block here
    raise NotImplementedError


def shutdown() -> None:
    # TODO: flush with a timeout so buffered clicks reach the broker
    raise NotImplementedError
`,
      solution: `import json
import logging
import time

from confluent_kafka import Producer

TOPIC = "clicks"
log = logging.getLogger("clicks")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1", "linger.ms": 5})


def on_delivery(err, msg) -> None:
    if err is not None:
        log.warning("click on %s not delivered: %s", msg.key(), err)


def record_click(code: str, referrer: str | None, ua: str | None) -> None:
    value = json.dumps({"code": code, "ts": time.time(), "referrer": referrer, "ua": ua})
    producer.produce(TOPIC, key=code, value=value, on_delivery=on_delivery)
    producer.poll(0)  # serve delivery callbacks; returns immediately


def shutdown() -> None:
    remaining = producer.flush(timeout=5)
    if remaining:
        log.warning("%d clicks were not delivered", remaining)
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

const topic = "clicks"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 5 * time.Millisecond,
	// TODO: Async writes with a Completion callback that logs failures
}

type clickEvent struct {
	Code     string  \`json:"code"\`
	Ts       float64 \`json:"ts"\`
	Referrer string  \`json:"referrer"\`
	UA       string  \`json:"ua"\`
}

func recordClick(ctx context.Context, code, referrer, ua string) {
	value, _ := json.Marshal(clickEvent{Code: code, Ts: float64(time.Now().UnixMilli()) / 1000, Referrer: referrer, UA: ua})
	// TODO: WriteMessages with the code as Key; never block the redirect on the broker
	_ = value
	log.Println("not implemented")
}

func shutdown() {
	// TODO: close the writer so buffered clicks reach the broker
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

const topic = "clicks"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireOne,
	BatchTimeout: 5 * time.Millisecond,
	Async:        true,
	Completion: func(messages []kafka.Message, err error) {
		if err != nil {
			log.Printf("%d clicks not delivered: %v", len(messages), err)
		}
	},
}

type clickEvent struct {
	Code     string  \`json:"code"\`
	Ts       float64 \`json:"ts"\`
	Referrer string  \`json:"referrer"\`
	UA       string  \`json:"ua"\`
}

func recordClick(ctx context.Context, code, referrer, ua string) {
	value, _ := json.Marshal(clickEvent{Code: code, Ts: float64(time.Now().UnixMilli()) / 1000, Referrer: referrer, UA: ua})
	// Async writer: this enqueues and returns; Completion reports the outcome.
	writer.WriteMessages(ctx, kafka.Message{Key: []byte(code), Value: value})
}

func shutdown() {
	if err := writer.Close(); err != nil {
		log.Printf("closing clicks writer: %v", err)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

object ClickEvents {
  val Topic = "clicks"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def recordClick(code: String, referrer: String, ua: String): Unit = {
    val value = JsObject(
      "code" -> JsString(code),
      "ts" -> JsNumber(System.currentTimeMillis() / 1000.0),
      "referrer" -> JsString(referrer),
      "ua" -> JsString(ua),
    ).compactPrint
    // TODO: send a record keyed by code with a Callback that logs failures; do not block on the future
  }

  def shutdown(): Unit = {
    // TODO: flush and close so buffered clicks reach the broker
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

object ClickEvents {
  val Topic = "clicks"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "1")
  props.put("linger.ms", "5")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  private val onDelivery: Callback = new Callback {
    override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
      if (exception != null) System.err.println(s"click not delivered: \${exception.getMessage}")
  }

  def recordClick(code: String, referrer: String, ua: String): Unit = {
    val value = JsObject(
      "code" -> JsString(code),
      "ts" -> JsNumber(System.currentTimeMillis() / 1000.0),
      "referrer" -> JsString(referrer),
      "ua" -> JsString(ua),
    ).compactPrint
    val record = new ProducerRecord[String, String](Topic, code, value)
    producer.send(record, onDelivery) // enqueues; the future is not awaited
  }

  def shutdown(): Unit = {
    producer.flush()
    producer.close()
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "clicks";

// TODO: a DeliveryReportCb that logs failed messages

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "5", err);
  // TODO: conf->set("dr_cb", &callback, err)
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void record_click(const std::string& code, const std::string& referrer, const std::string& ua) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"code", code}, {"ts", ts}, {"referrer", referrer}, {"ua", ua}}.dump();
  // TODO: produce keyed by code (RK_MSG_COPY); poll(0) to serve callbacks; never block here
}

void shutdown() {
  // TODO: flush with a timeout so buffered clicks reach the broker
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kTopic = "clicks";

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR)
      std::cerr << "click not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  conf->set("linger.ms", "5", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

void record_click(const std::string& code, const std::string& referrer, const std::string& ua) {
  const double ts = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string value = json{{"code", code}, {"ts", ts}, {"referrer", referrer}, {"ua", ua}}.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(value.data()), value.size(), code.c_str(), code.size(), 0, nullptr);
  producer->poll(0);  // serve delivery callbacks; returns immediately
}

void shutdown() {
  if (producer->flush(5000) != RdKafka::ERR_NO_ERROR)
    std::cerr << producer->outq_len() << " clicks were not delivered\\n";
}
`,
    },
  },
  debrief: `A Kafka producer is a buffer with a background thread: \`produce\`/\`send\` costs microseconds, the network happens later in batches. That is what makes "one event per redirect" free — as long as nobody blocks on the acknowledgement. The key is the ordering and the partitioning contract at once: same code → same partition → the next step's consumer sees every click of a link in order, on one consumer. Real pipelines put the referrer through a domain allow-list before it reaches analytics, enrich the event with a geo lookup, and enable idempotent producers so their own retries cannot double-count a click.`,
};
