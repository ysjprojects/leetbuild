import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Lifecycle events on prompt.lifecycle, keyed by name',
  concept: 'kafka',
  file: 'events',
  focus: ['registry', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter's \`publish(event)\` takes the provided \`LifecycleEvent\` (ids, the
version, the action, the content hash, the actor, the eval id, and the template text the caller still
holds), produces a JSON event to \`prompt.lifecycle\` keyed by the actor with \`acks=1\`, logs the move
and returns true without waiting for the broker. The demo shows events reaching the consumer. It hides
5 flaws.

**Failure mode the checks target.** Keying by actor is the ordering bug: a promotion by one operator
and a rollback by another land on two partitions, and a consumer can apply the rollback first. The
payload names a version without the hash or the eval that put it live, and carries the template, which
a retained topic keeps long after the prompt changed. A refused or unanswered produce disappears.

Requirements:

- Key every record by the prompt **\`name\`**.
- The payload is \`{event_id, tenant, name, version, action, content_hash, actor, eval_id}\`; the
  template reaches neither the topic, the outbox nor a log line.
- The producer is **idempotent with \`acks=all\`** (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the delivery report at most **2 s** (\`ACK_TIMEOUT_S\`); on an error or no answer, keep the
  payload with \`outbox.insert_outbox\` and return false.`,
  sequence: {
    participants: ['registryd', 'prompt.lifecycle', 'outbox', 'Lifecycle consumer'],
    messages: [
      {
        from: 'registryd',
        to: 'prompt.lifecycle',
        label: 'produce key=name {ids, version, content_hash, eval_id} · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'prompt.lifecycle', to: 'registryd', label: 'delivery report within 2 s', kind: 'reply'},
      {from: 'registryd', to: 'outbox', label: 'insert_outbox(payload) on an error or no answer', kind: 'async'},
      {from: 'prompt.lifecycle', to: 'Lifecycle consumer', label: 'one prompt’s moves, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'name-key',
      title: 'Keys every event by the prompt name',
      detail:
        'A promotion by alice, a rollback by oncall and another promotion of support-reply are keyed support-reply and share a partition; a welcome event is keyed welcome. The starter keys by actor and scatters one prompt’s moves.',
      match: {
        python: {all: [/produce\([^)]*key\s*=\s*event\.name/], none: [/key\s*=\s*event\.actor/]},
        typescript: {all: [/key:\s*event\.name/], none: [/key:\s*event\.actor/]},
        go: {all: [/Key:\s*\[\]byte\(\s*event\.Name\s*\)/], none: [/Key:\s*\[\]byte\(\s*event\.Actor\s*\)/]},
        scala: {
          all: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*event\.name\s*,/],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*[\w.]+\s*,\s*event\.actor\s*,/],
        },
        cpp: {all: [/event\.name\.(c_str|data)\(\)/], none: [/event\.actor\.(c_str|data)\(\)/]},
      },
    },
    {
      id: 'event-identity',
      title: 'Carries the content hash and the eval id',
      detail:
        'The event is {event_id, tenant, name, version, action, content_hash, actor, eval_id}, so a consumer knows which bytes went live on which eval. The starter sends neither the hash nor the eval id.',
      match: {
        python: {all: [/["']content_hash["']\s*:/, /["']eval_id["']\s*:/]},
        typescript: {all: [/content_hash:/, /eval_id:/]},
        go: {all: [/"content_hash"/, /"eval_id"/]},
        scala: {all: [/"content_hash"/, /"eval_id"/]},
        cpp: {all: [/"content_hash"/, /"eval_id"/]},
      },
    },
    {
      id: 'no-template',
      title: 'No template text in the event, the outbox or the logs',
      detail:
        'The template reaches neither a record on prompt.lifecycle, an outbox row nor a log line: the topic is retained and replicated, so what goes in outlives the version. The starter copies it into the payload and the log.',
      match: {
        python: {none: [/event\.template\b/]},
        typescript: {none: [/event\.template\b/]},
        go: {none: [/event\.Template\b/]},
        scala: {none: [/event\.template\b/]},
        cpp: {none: [/event\.template_text\b/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and an acknowledged record survives a leader failover. The starter sets acks=1 and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A refused produce, or no acknowledgement within 2 s, leaves the payload in the outbox and publish returns false. The starter returns true before the broker answers.',
      match: {
        python: {
          all: [/outbox\.insert_outbox\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/outbox\.insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch/]},
        cpp: {all: [/outbox::insert_outbox\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

from prompts.config import TOPIC
from prompts.lifecycle import LifecycleEvent

logger = logging.getLogger("prompts.lifecycle")

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish(event: LifecycleEvent) -> bool:
    """Tell the lifecycle consumers a version moved; True once the event is on its way."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    payload = {
        "event_id": event.event_id,
        "tenant": event.tenant,
        "name": event.name,
        "version": event.version,
        "action": event.action,
        "actor": event.actor,
        "template": event.template,
    }
    logger.info("lifecycle %s %s v%d by %s: %r", event.action, event.name, event.version, event.actor, event.template)
    producer.produce(TOPIC, key=event.actor, value=json.dumps(payload))
    producer.poll(0)
    return True
`,
      solution: `import json
import logging

from confluent_kafka import Producer

from prompts.config import TOPIC
from prompts.lifecycle import LifecycleEvent
from prompts.outbox import outbox

logger = logging.getLogger("prompts.lifecycle")

ACK_TIMEOUT_S = 2

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",  # every in-sync replica has the event before the broker answers
        "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
    }
)


def publish(event: LifecycleEvent) -> bool:
    """Tell the lifecycle consumers a version moved; True once the broker acknowledged the event."""
    payload = {
        "event_id": event.event_id,
        "tenant": event.tenant,
        "name": event.name,
        "version": event.version,
        "action": event.action,
        "content_hash": event.content_hash,
        "actor": event.actor,
        "eval_id": event.eval_id,
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=event.name, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        outbox.insert_outbox(payload)  # the relay republishes it; the consumers are late, not wrong
        logger.warning("lifecycle event %s kept in the outbox: %s", event.event_id, outcome.get("error") or "no acknowledgement")
        return False
    logger.info("lifecycle %s %s v%d by %s", event.action, event.name, event.version, event.actor)
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {TOPIC} from 'prompts/config';
import type {LifecycleEvent} from 'prompts/lifecycle';

const kafka = new Kafka({clientId: 'registryd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Tell the lifecycle consumers a version moved; true once the event is on its way. */
export async function publish(event: LifecycleEvent): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const payload = {
    event_id: event.event_id,
    tenant: event.tenant,
    name: event.name,
    version: event.version,
    action: event.action,
    actor: event.actor,
    template: event.template,
  };
  console.log(\`lifecycle \${event.action} \${event.name} v\${event.version} by \${event.actor}: \${JSON.stringify(event.template)}\`);
  void producer.send({topic: TOPIC, messages: [{key: event.actor, value: JSON.stringify(payload)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {TOPIC} from 'prompts/config';
import type {LifecycleEvent} from 'prompts/lifecycle';
import {outbox} from 'prompts/outbox';

export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'registryd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Tell the lifecycle consumers a version moved; true once the broker acknowledged the event. */
export async function publish(event: LifecycleEvent): Promise<boolean> {
  const payload = {
    event_id: event.event_id,
    tenant: event.tenant,
    name: event.name,
    version: event.version,
    action: event.action,
    content_hash: event.content_hash,
    actor: event.actor,
    eval_id: event.eval_id,
  };
  try {
    // acks: -1 (all): every in-sync replica has the event before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: event.name, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
  } catch (err) {
    // The relay republishes it; the consumers are late, not wrong.
    await outbox.insertOutbox(payload);
    console.warn(\`lifecycle event \${event.event_id} kept in the outbox: \${(err as Error).message}\`);
    return false;
  }
  console.log(\`lifecycle \${event.action} \${event.name} v\${event.version} by \${event.actor}\`);
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"prompts/config"    // config.Topic — provided
	"prompts/lifecycle" // lifecycle.Event — provided
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publish tells the lifecycle consumers a version moved; true once the event is on its way.
func publish(ctx context.Context, event lifecycle.Event) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	value, err := json.Marshal(map[string]any{
		"event_id": event.EventID,
		"tenant":   event.Tenant,
		"name":     event.Name,
		"version":  event.Version,
		"action":   event.Action,
		"actor":    event.Actor,
		"template": event.Template,
	})
	if err != nil {
		return false, err
	}
	log.Printf("lifecycle %s %s v%d by %s: %q", event.Action, event.Name, event.Version, event.Actor, event.Template)
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(event.Actor), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"prompts/config"    // config.Topic — provided
	"prompts/lifecycle" // lifecycle.Event — provided
	"prompts/outbox"    // outbox.Insert(ctx, eventJSON) — provided
)

const ackTimeout = 2 * time.Second

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the event before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

type lifecyclePayload struct {
	EventID     string \`json:"event_id"\`
	Tenant      string \`json:"tenant"\`
	Name        string \`json:"name"\`
	Version     int    \`json:"version"\`
	Action      string \`json:"action"\`
	ContentHash string \`json:"content_hash"\`
	Actor       string \`json:"actor"\`
	EvalID      string \`json:"eval_id"\`
}

// publish tells the lifecycle consumers a version moved; true once the broker acknowledged the event.
func publish(ctx context.Context, event lifecycle.Event) (bool, error) {
	value, err := json.Marshal(lifecyclePayload{
		EventID:     event.EventID,
		Tenant:      event.Tenant,
		Name:        event.Name,
		Version:     event.Version,
		Action:      event.Action,
		ContentHash: event.ContentHash,
		Actor:       event.Actor,
		EvalID:      event.EvalID,
	})
	if err != nil {
		return false, err
	}
	topic := config.Topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(event.Name), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err = producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no acknowledgement within the window
		}
	}
	if err != nil {
		// The relay republishes it; the consumers are late, not wrong.
		if err := outbox.Insert(ctx, value); err != nil {
			return false, err
		}
		log.Printf("lifecycle event %s kept in the outbox: %v", event.EventID, err)
		return false, nil
	}
	log.Printf("lifecycle %s %s v%d by %s", event.Action, event.Name, event.Version, event.Actor)
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import prompts.{Config, LifecycleEvent}

object LifecyclePublisher {
  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Tell the lifecycle consumers a version moved; true once the event is on its way. */
  def publish(event: LifecycleEvent): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val payload = ujson.write(
      ujson.Obj(
        "event_id" -> event.event_id,
        "tenant" -> event.tenant,
        "name" -> event.name,
        "version" -> event.version,
        "action" -> event.action,
        "actor" -> event.actor,
        "template" -> event.template
      )
    )
    System.err.println(s"lifecycle \${event.action} \${event.name} v\${event.version} by \${event.actor}: \${event.template}")
    producer.send(new ProducerRecord[String, String](Config.Topic, event.actor, payload))
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

import scala.util.{Failure, Success, Try}

import prompts.{Config, LifecycleEvent, Outbox}

object LifecyclePublisher {
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the event before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Tell the lifecycle consumers a version moved; true once the broker acknowledged the event. */
  def publish(event: LifecycleEvent): Boolean = {
    val payload = ujson.write(
      ujson.Obj(
        "event_id" -> event.event_id,
        "tenant" -> event.tenant,
        "name" -> event.name,
        "version" -> event.version,
        "action" -> event.action,
        "content_hash" -> event.content_hash,
        "actor" -> event.actor,
        "eval_id" -> event.eval_id
      )
    )
    val record = new ProducerRecord[String, String](Config.Topic, event.name, payload)
    Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS)) match {
      case Failure(error) =>
        // The relay republishes it; the consumers are late, not wrong.
        Outbox.insertOutbox(payload)
        System.err.println(s"lifecycle event \${event.event_id} kept in the outbox: \${error.getMessage}")
        false
      case Success(_) =>
        System.err.println(s"lifecycle \${event.action} \${event.name} v\${event.version} by \${event.actor}")
        true
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "prompts/config.h"     // config::kTopic — provided
#include "prompts/lifecycle.h"  // lifecycle::Event — provided

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Tell the lifecycle consumers a version moved; true once the event is on its way.
bool publish(const lifecycle::Event& event) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string payload = nlohmann::json{{"event_id", event.event_id},
                                             {"tenant", event.tenant},
                                             {"name", event.name},
                                             {"version", event.version},
                                             {"action", event.action},
                                             {"actor", event.actor},
                                             {"template", event.template_text}}
                                  .dump();
  std::cerr << "lifecycle " << event.action << " " << event.name << " v" << event.version << " by " << event.actor << ": "
            << event.template_text << "\\n";
  producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                    payload.size(), event.actor.c_str(), event.actor.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "prompts/config.h"     // config::kTopic — provided
#include "prompts/lifecycle.h"  // lifecycle::Event — provided
#include "prompts/outbox.h"     // outbox::insert_outbox(event_json) — provided

constexpr int kAckTimeoutMs = 2000;

// The delivery report of the event in flight: publish produces one event and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);                // every in-sync replica has the event before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Tell the lifecycle consumers a version moved; true once the broker acknowledged the event.
bool publish(const lifecycle::Event& event) {
  const std::string payload = nlohmann::json{{"event_id", event.event_id},
                                             {"tenant", event.tenant},
                                             {"name", event.name},
                                             {"version", event.version},
                                             {"action", event.action},
                                             {"content_hash", event.content_hash},
                                             {"actor", event.actor},
                                             {"eval_id", event.eval_id}}
                                  .dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err =
      producer->produce(config::kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                        payload.size(), event.name.c_str(), event.name.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The relay republishes it; the consumers are late, not wrong.
    outbox::insert_outbox(payload);
    std::cerr << "lifecycle event " << event.event_id << " kept in the outbox: " << RdKafka::err2str(err) << "\\n";
    return false;
  }
  std::cerr << "lifecycle " << event.action << " " << event.name << " v" << event.version << " by " << event.actor << "\\n";
  return true;
}
`,
    },
  },
  harness: {
    python: `import json
import logging

from prompts.lifecycle import LifecycleEvent

TOPIC = "prompt.lifecycle"
TEMPLATE = "Hi {{customer_name}}, your refund for order 4411 is approved."
MOVES = (("support-reply", "alice", "promoted", 4), ("support-reply", "oncall", "rolled_back", 3), ("support-reply", "alice", "promoted", 5), ("welcome", "bob", "registered", 1))


def _event(n, name="support-reply", actor="alice", action="promoted", version=4):
    return LifecycleEvent(event_id=f"ev-{n}", tenant="t1", name=name, version=version, action=action, content_hash=f"sha-{name}-{version}", actor=actor, eval_id=f"eval-{version}", template=TEMPLATE)


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("prompts:outbox", 0, -1)]


def check_name_key(ctx):
    m = ctx.load("events")
    for n, (name, actor, action, version) in enumerate(MOVES):
        assert m.publish(_event(n, name, actor, action, version)) is True, f"publishing {action} of {name} v{version} returned False on a healthy broker"
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"four moves produced {len(records)} records on {TOPIC} (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"support-reply"] * 3 + [b"welcome"], f"the records are keyed {keys}, expected the prompt names: keyed by actor, a rollback can overtake the promotion it undoes"
    assert len({r.partition for r in records[:3]}) == 1, "one prompt's moves must land on one partition so a consumer applies them in order"


def check_event_identity(ctx):
    m = ctx.load("events")
    assert m.publish(_event(1)) is True, "publish returned False on a healthy broker"
    values = ctx.kafka.values(TOPIC)
    assert len(values) == 1, f"one move produced {len(values)} records"
    event = json.loads(values[0])
    expected = {"event_id": "ev-1", "tenant": "t1", "name": "support-reply", "version": 4, "action": "promoted", "content_hash": "sha-support-reply-4", "actor": "alice", "eval_id": "eval-4"}
    for key, value in expected.items():
        assert event.get(key) == value, f"the event must carry {key}={value!r}, got {event}: a consumer learns which bytes went live, on which eval, from the hash and the eval id"


def check_no_template(ctx):
    class Capture(logging.Handler):
        def __init__(self):
            super().__init__()
            self.lines = []

        def emit(self, record):
            self.lines.append(record.getMessage())

    capture = Capture()
    logging.getLogger().addHandler(capture)
    try:
        m = ctx.load("events")
        ctx.kafka.fail_next(TOPIC, 1)
        m.publish(_event(1))
        m.publish(_event(2))
    finally:
        logging.getLogger().removeHandler(capture)
    for value in ctx.kafka.values(TOPIC):
        assert b"refund for order 4411" not in value, f"the event carries the template text: {value!r}; the topic is retained and replicated"
        assert "template" not in json.loads(value), f"the event has a template field: {value!r}"
    for row in ctx.redis.lrange("prompts:outbox", 0, -1):
        assert "refund for order 4411" not in row, f"the outbox row carries the template text: {row}"
    for line in capture.lines:
        assert "refund for order 4411" not in line, f"a log line carries the template text: {line!r}"


def check_idempotent_acks(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish(_event(1))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish(_event(2))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish(_event(1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker refused the produce and the outbox holds {len(rows)} rows: without a row the move vanishes from every consumer"
    assert rows[0].get("event_id") == "ev-1" and rows[0].get("content_hash") == "sha-support-reply-4", f"the outbox row must be the event itself, got {rows[0]}"
    assert ok is False, f"publish returned {ok!r} after a refused produce, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish(_event(2))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish waited {waited:.0f} s for a broker that does not answer: wait at most 2 s, then keep the event in the outbox"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("event_id") == "ev-2", f"no acknowledgement within the window and the outbox holds {rows}"
    assert ok is False, f"publish returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'prompt.lifecycle';
const TEMPLATE = 'Hi {{customer_name}}, your refund for order 4411 is approved.';
const MOVES: [string, string, string, number][] = [
  ['support-reply', 'alice', 'promoted', 4],
  ['support-reply', 'oncall', 'rolled_back', 3],
  ['support-reply', 'alice', 'promoted', 5],
  ['welcome', 'bob', 'registered', 1],
];

const event = (n: number, name = 'support-reply', actor = 'alice', action = 'promoted', version = 4) => ({
  event_id: \`ev-\${n}\`,
  tenant: 't1',
  name,
  version,
  action,
  content_hash: \`sha-\${name}-\${version}\`,
  actor,
  eval_id: \`eval-\${version}\`,
  template: TEMPLATE,
});

const outboxRows = ctx => (ctx.redis.lrange('prompts:outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_name_key(ctx) {
  const m = ctx.load('events');
  for (const [n, [name, actor, action, version]] of MOVES.entries()) {
    assert.equal(await m.publish(event(n, name, actor, action, version)), true, \`publishing \${action} of \${name} v\${version} resolved false on a healthy broker\`);
  }
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`four moves produced \${records.length} records on \${TOPIC}\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['support-reply', 'support-reply', 'support-reply', 'welcome'], \`the records are keyed \${JSON.stringify(keys)}, expected the prompt names: keyed by actor, a rollback can overtake the promotion it undoes\`);
  assert.equal(new Set(records.slice(0, 3).map(r => r.partition)).size, 1, "one prompt's moves must land on one partition so a consumer applies them in order");
}

export async function check_event_identity(ctx) {
  const m = ctx.load('events');
  assert.equal(await m.publish(event(1)), true, 'publish resolved false on a healthy broker');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one move produced \${values.length} records\`);
  const got = JSON.parse(values[0]);
  const expected = {event_id: 'ev-1', tenant: 't1', name: 'support-reply', version: 4, action: 'promoted', content_hash: 'sha-support-reply-4', actor: 'alice', eval_id: 'eval-4'};
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(got[key], value, \`the event must carry \${key}=\${JSON.stringify(value)}, got \${values[0]}: a consumer learns which bytes went live, on which eval, from the hash and the eval id\`);
  }
}

export async function check_no_template(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  await m.publish(event(1));
  await m.publish(event(2));
  await settle();
  for (const value of ctx.kafka.values(TOPIC)) {
    assert(!value.includes('refund for order 4411'), \`the event carries the template text: \${value}; the topic is retained and replicated\`);
    assert(!('template' in JSON.parse(value)), \`the event has a template field: \${value}\`);
  }
  for (const row of ctx.redis.lrange('prompts:outbox', 0, -1)) assert(!row.includes('refund for order 4411'), \`the outbox row carries the template text: \${row}\`);
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publish(event(1));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publish(event(2));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publish(event(1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the broker refused the produce and the outbox holds \${rows.length} rows: without a row the move vanishes from every consumer\`);
  assert(rows[0].event_id === 'ev-1' && rows[0].content_hash === 'sha-support-reply-4', \`the outbox row must be the event itself, got \${JSON.stringify(rows[0])}\`);
  assert.equal(ok, false, \`publish resolved \${JSON.stringify(ok)} after a refused produce, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publish(event(2));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publish waited \${waited.toFixed(0)} s for a broker that does not answer: wait at most 2 s, then keep the event in the outbox\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].event_id === 'ev-2', \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publish resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"prompts/lifecycle"

	"leetbuild/harness"
)

const (
	eventsTopic    = "prompt.lifecycle"
	eventsTemplate = "Hi {{customer_name}}, your refund for order 4411 is approved."
)

func eventsEvent(n int, name, actor, action string, version int) lifecycle.Event {
	return lifecycle.Event{
		EventID: fmt.Sprintf("ev-%d", n), Tenant: "t1", Name: name, Version: version, Action: action,
		ContentHash: fmt.Sprintf("sha-%s-%d", name, version), Actor: actor, EvalID: fmt.Sprintf("eval-%d", version), Template: eventsTemplate,
	}
}

func eventsPublish(ctx *harness.Ctx, e lifecycle.Event) bool {
	ok, err := publish(context.Background(), e)
	ctx.NoError(err, "publish(%s)", e.EventID)
	return ok
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	var rows []map[string]any
	for _, text := range ctx.Redis.LRange("prompts:outbox", 0, -1) {
		var row map[string]any
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be the event's JSON, got %s", text)
		rows = append(rows, row)
	}
	return rows
}

func CheckNameKey(ctx *harness.Ctx) {
	moves := []struct {
		name, actor, action string
		version             int
	}{{"support-reply", "alice", "promoted", 4}, {"support-reply", "oncall", "rolled_back", 3}, {"support-reply", "alice", "promoted", 5}, {"welcome", "bob", "registered", 1}}
	for n, mv := range moves {
		ctx.Assert(eventsPublish(ctx, eventsEvent(n, mv.name, mv.actor, mv.action, mv.version)), "publishing %s of %s v%d returned false on a healthy broker", mv.action, mv.name, mv.version)
	}
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 4, "four moves must produce four records on %s; the records", eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"support-reply", "support-reply", "support-reply", "welcome"}, "the records must be keyed by the prompt names (keyed by actor, a rollback can overtake the promotion it undoes)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "one prompt's moves must land on one partition so a consumer applies them in order")
}

func CheckEventIdentity(ctx *harness.Ctx) {
	ctx.Assert(eventsPublish(ctx, eventsEvent(1, "support-reply", "alice", "promoted", 4)), "publish returned false on a healthy broker")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one move must produce one record; the records")
	var got map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &got), "the event must be JSON")
	ctx.Equal(got, map[string]any{"event_id": "ev-1", "tenant": "t1", "name": "support-reply", "version": float64(4), "action": "promoted", "content_hash": "sha-support-reply-4", "actor": "alice", "eval_id": "eval-4"},
		"the event must carry the ids, the version, the action, the content hash and the eval id: a consumer learns which bytes went live, on which eval, from them")
}

func CheckNoTemplate(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	eventsPublish(ctx, eventsEvent(1, "support-reply", "alice", "promoted", 4))
	eventsPublish(ctx, eventsEvent(2, "support-reply", "alice", "promoted", 5))
	ctx.Settle()
	for _, value := range ctx.Kafka.Values(eventsTopic) {
		ctx.Assert(!strings.Contains(value, "refund for order 4411"), "the event carries the template text: %s; the topic is retained and replicated", value)
		var e map[string]any
		json.Unmarshal([]byte(value), &e)
		_, has := e["template"]
		ctx.Assert(!has, "the event has a template field: %s", value)
	}
	for _, row := range ctx.Redis.LRange("prompts:outbox", 0, -1) {
		ctx.Assert(!strings.Contains(row, "refund for order 4411"), "the outbox row carries the template text: %s", row)
	}
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsEvent(1, "support-reply", "alice", "promoted", 4))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsEvent(2, "support-reply", "alice", "promoted", 5))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, eventsEvent(1, "support-reply", "alice", "promoted", 4))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker refused the produce: without an outbox row the move vanishes from every consumer; the rows")
	ctx.Assert(rows[0]["event_id"] == "ev-1" && rows[0]["content_hash"] == "sha-support-reply-4", "the outbox row must be the event itself, got %v", rows[0])
	ctx.Equal(ok, false, "publish's result after a refused produce")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsEvent(2, "support-reply", "alice", "promoted", 5))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publish waited %.0f s for a broker that does not answer: wait at most 2 s, then keep the event in the outbox", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1]["event_id"] == "ev-2", "no acknowledgement within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publish's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "prompt.lifecycle";
const std::string kTemplate = "Hi {{customer_name}}, your refund for order 4411 is approved.";

lifecycle::Event eventsEvent(int n, const std::string& name = "support-reply", const std::string& actor = "alice",
                             const std::string& action = "promoted", int version = 4) {
  return lifecycle::Event{"ev-" + std::to_string(n), "t1", name, version, action, "sha-" + name + "-" + std::to_string(version), actor,
                          "eval-" + std::to_string(version), kTemplate};
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("prompts:outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be the event's JSON, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string field(const nlohmann::json& j, const std::string& key) {
  return j.is_object() && j.contains(key) && j[key].is_string() ? j[key].get<std::string>() : "";
}

}  // namespace

void CheckNameKey(harness::Ctx& ctx) {
  ctx.Assert(publish(eventsEvent(0, "support-reply", "alice", "promoted", 4)), "publishing promoted of support-reply v4 returned false on a healthy broker");
  ctx.Assert(publish(eventsEvent(1, "support-reply", "oncall", "rolled_back", 3)), "publishing rolled_back of support-reply v3 returned false on a healthy broker");
  ctx.Assert(publish(eventsEvent(2, "support-reply", "alice", "promoted", 5)), "publishing promoted of support-reply v5 returned false on a healthy broker");
  ctx.Assert(publish(eventsEvent(3, "welcome", "bob", "registered", 1)), "publishing registered of welcome v1 returned false on a healthy broker");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 4, "four moves must produce four records on %s; the records", kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"support-reply", "support-reply", "support-reply", "welcome"},
            "the records must be keyed by the prompt names (keyed by actor, a rollback can overtake the promotion it undoes)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "one prompt's moves must land on one partition so a consumer applies them in order");
}

void CheckEventIdentity(harness::Ctx& ctx) {
  ctx.Assert(publish(eventsEvent(1)), "publish returned false on a healthy broker");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one move must produce one record; the records");
  const auto got = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Equal(got,
            nlohmann::json({{"event_id", "ev-1"}, {"tenant", "t1"}, {"name", "support-reply"}, {"version", 4}, {"action", "promoted"},
                            {"content_hash", "sha-support-reply-4"}, {"actor", "alice"}, {"eval_id", "eval-4"}}),
            "the event must carry the ids, the version, the action, the content hash and the eval id: a consumer learns which bytes went live, on which eval, from them");
}

void CheckNoTemplate(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  publish(eventsEvent(1));
  publish(eventsEvent(2, "support-reply", "alice", "promoted", 5));
  ctx.Settle();
  for (const auto& value : ctx.Kafka.Values(kEventsTopic)) {
    ctx.Assert(value.find("refund for order 4411") == std::string::npos, "the event carries the template text: %s; the topic is retained and replicated", value);
    const auto e = nlohmann::json::parse(value, nullptr, false);
    ctx.Assert(!e.is_object() || !e.contains("template"), "the event has a template field: %s", value);
  }
  for (const auto& row : ctx.Redis.LRange("prompts:outbox", 0, -1)) {
    ctx.Assert(row.find("refund for order 4411") == std::string::npos, "the outbox row carries the template text: %s", row);
  }
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publish(eventsEvent(1));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publish(eventsEvent(2, "support-reply", "alice", "promoted", 5));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publish(eventsEvent(1));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker refused the produce: without an outbox row the move vanishes from every consumer; the rows");
  ctx.Assert(field(rows[0], "event_id") == "ev-1" && field(rows[0], "content_hash") == "sha-support-reply-4", "the outbox row must be the event itself, got %s", rows[0].dump());
  ctx.Equal(ok, false, "publish's result after a refused produce");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publish(eventsEvent(2, "support-reply", "alice", "promoted", 5));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publish waited %.0f s for a broker that does not answer: wait at most 2 s, then keep the event in the outbox", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && field(rows[1], "event_id") == "ev-2", "no acknowledgement within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publish's result without an acknowledgement");
}
`,
  },
  hints: [
    'Symptom: a consumer sees version 4 rolled back before it saw it promoted, a cache invalidator cannot tell which bytes went live, a customer’s template shows up in the topic, and a broker restart loses a promotion.',
    'Mechanism: the key is `event.actor`, so one prompt’s moves scatter across partitions; the payload copies `template` and drops `content_hash` and `eval_id`; the produce is fire-and-forget with `acks=1`, so a lost acknowledgement duplicates and a refusal goes unseen.',
    'Change: `key=event.name`; a payload of ids, hash and eval id without `template`; `acks=all` with `enable.idempotence`; an `on_delivery` callback, `producer.flush(ACK_TIMEOUT_S)`, then `outbox.insert_outbox(payload)` and False on an error or anything still in flight.',
  ],
  debrief: `The key is an ordering contract: Kafka orders within a partition, so whatever is the key is what stays in order, and a consumer following a prompt needs its moves in sequence. The hash and the eval id let that consumer act without the text: a cache invalidator compares hashes, an auditor follows the eval id to its record, and neither needs the template a retained, replicated topic would otherwise keep. Waiting for the delivery report gives the return value a meaning; idempotence closes the duplicate that waiting opens when an acknowledgement is lost. Here the outbox row is written after the broker refused; a registry that cannot afford to lose a move writes the row in the same transaction as the move and lets a relay do every produce.`,
};
