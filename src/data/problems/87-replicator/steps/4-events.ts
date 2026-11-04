import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'replication.applied: one event per confirmed batch, keyed by shard',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter is \`confirm_batch(replication_id, shard, batch)\`, called once the
target confirmed a batch \`{offset, applied, rejected}\`: it produces \`{replication_id, shard, offset,
applied}\` to \`replication.applied\` with no key and \`acks=1\`, writes an outbox row
(\`store.insert_outbox\`) if \`produce\` raises, then advances the shard with \`advance_offset\` and
returns \`True\`. The lag dashboard moves, and it hides five flaws.

**Failure mode the checks target.** One shard's events arrive out of order; a shard whose changes the
target refuses looks healthy; the lag consumer reads an offset the store does not hold yet; a lost
acknowledgement writes the event twice and a failover loses it; and a broker that refuses or never
answers loses the event while \`confirm_batch\` reports success.

- Key \`{replication_id}:{shard}\`, so one shard's events share a partition.
- The payload is \`{replication_id, shard, offset, applied, rejected}\`, \`offset\` being what
  \`advance_offset\` returned.
- \`advance_offset\` first, then produce.
- An idempotent producer with \`acks=all\` (Go: confluent-kafka-go, since kafka-go has no idempotent
  producer).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` (2 s); on a failure or no report, insert the
  outbox row \`(topic, key, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['Replication worker', 'Redis', 'replication.applied', 'Outbox'],
    messages: [
      {from: 'Replication worker', to: 'Redis', label: 'advance_offset(rep-1, 0, 120) → 120', kind: 'sync'},
      {
        from: 'Replication worker',
        to: 'replication.applied',
        label: 'produce · key rep-1:0 · acks=all · idempotent',
        kind: 'sync',
      },
      {from: 'replication.applied', to: 'Replication worker', label: 'delivery report within 2 s', kind: 'reply'},
      {
        from: 'Replication worker',
        to: 'Outbox',
        label: 'insert_outbox(topic, key, payload) on failure or no report',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'shard-key',
      title: 'Keys replication.applied by replication and shard',
      detail:
        "The record key is `{replication_id}:{shard}`, so one shard's events land on one partition in order; the starter sends no key, and the partitioner scatters a shard's events.",
      match: {
        python: {all: [/producer\.produce\([^\n]*key\s*=/, /f["']\{replication_id\}:\{shard\}["']/]},
        typescript: {all: [/messages:\s*\[\{\s*key\b/, /\$\{replicationId\}:\$\{shard\}/]},
        go: {all: [/Key:\s*\[\]byte\(/, /"%s:%d"/]},
        scala: {all: [/new ProducerRecord\[String, String\]\(\s*Topic\s*,\s*key\s*,/, /s"\$replicationId:\$shard"/]},
        cpp: {
          all: [
            /key\.c_str\(\)\s*,\s*key\.(size|length)\(\)/,
            /replication_id\s*\+\s*":"\s*\+\s*std::to_string\(shard\)/,
          ],
        },
      },
    },
    {
      id: 'rejected-count',
      title: 'The event carries the rejected count',
      detail:
        'The payload carries `offset`, `applied` and `rejected`; without `rejected`, a shard whose every change the target refuses looks as healthy as one that applied them.',
      match: {
        python: {all: [/["']rejected["']\s*:/]},
        typescript: {all: [/rejected:\s*batch\.rejected/]},
        go: {all: [/"rejected"/]},
        scala: {all: [/"rejected"/]},
        cpp: {all: [/"rejected"/]},
      },
    },
    {
      id: 'advance-before-produce',
      title: 'Advances the offset before producing the event',
      detail:
        "When the shard's offset key is written the topic does not hold the event yet: a consumer that reads the event finds the offset it names. The starter produces first.",
      match: {
        python: {order: [/advance_offset\(/, /producer\.produce\(/]},
        typescript: {order: [/await advanceOffset\(/, /producer\.send\(/]},
        go: {order: [/offsets\.AdvanceOffset\(/, /producer\.Produce\(/]},
        scala: {order: [/Offsets\.advanceOffset\(/, /producer\.send\(/]},
        cpp: {order: [/offsets::advanceOffset\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'An idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
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
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload, and the call returns false. Catching an exception around `produce` sees only local errors: the broker answers later, in the delivery report.',
      match: {
        python: {
          all: [/on_delivery\s*=|callback\s*=/, /producer\.flush\(/, /store\.insert_outbox\(/],
          none: [/except KafkaException/],
        },
        typescript: {all: [/await producer\.send\(/, /catch/, /insertOutbox\(/]},
        go: {all: [/TopicPartition\.Error/, /time\.After\(/, /store\.InsertOutbox\(/]},
        scala: {all: [/\.get\(\s*AckTimeoutMs/, /Store\.insertOutbox\(/], none: [/case _: KafkaException/]},
        cpp: {all: [/dr_cb/, /->flush\(/, /store::insertOutbox\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import KafkaException, Producer

from replication import store  # store.insert_outbox(topic, key, payload)
from replication.offsets import advance_offset

TOPIC = "replication.applied"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def confirm_batch(replication_id: str, shard: int, batch: dict) -> bool:
    """Record a batch the target confirmed ({offset, applied, rejected}) and tell the lag consumers; True once the event is out."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {"replication_id": replication_id, "shard": shard, "offset": batch["offset"], "applied": batch["applied"]}
    try:
        producer.produce(TOPIC, value=json.dumps(event))
        producer.poll(0)
    except KafkaException:
        store.insert_outbox(TOPIC, replication_id, event)
        return False
    advance_offset(replication_id, shard, batch["offset"])
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from replication import store  # store.insert_outbox(topic, key, payload)
from replication.offsets import advance_offset

TOPIC = "replication.applied"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def confirm_batch(replication_id: str, shard: int, batch: dict) -> bool:
    """Record a batch the target confirmed ({offset, applied, rejected}) and tell the lag consumers; True once the event is out."""
    # The offset first: a consumer that reads the event must find the offset it names.
    offset = advance_offset(replication_id, shard, batch["offset"])
    key = f"{replication_id}:{shard}"  # one shard, one partition, one order
    event = {"replication_id": replication_id, "shard": shard, "offset": offset, "applied": batch["applied"], "rejected": batch["rejected"]}
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=key, value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the dashboard is late, not wrong.
        store.insert_outbox(TOPIC, key, event)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {advanceOffset} from 'replication/offsets';
import {insertOutbox} from 'replication/store';

export const TOPIC = 'replication.applied';

export interface Batch {
  offset: number;
  applied: number;
  rejected: number;
}

const kafka = new Kafka({clientId: 'replicatord', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Record a batch the target confirmed and tell the lag consumers; true once the event is out. */
export async function confirmBatch(replicationId: string, shard: number, batch: Batch): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {replication_id: replicationId, shard, offset: batch.offset, applied: batch.applied};
  try {
    void producer.send({topic: TOPIC, messages: [{value: JSON.stringify(event)}], acks: 1});
  } catch {
    await insertOutbox(TOPIC, replicationId, event);
    return false;
  }
  await advanceOffset(replicationId, shard, batch.offset);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {advanceOffset} from 'replication/offsets';
import {insertOutbox} from 'replication/store';

export const TOPIC = 'replication.applied';
export const ACK_TIMEOUT_MS = 2000;

export interface Batch {
  offset: number;
  applied: number;
  rejected: number;
}

const kafka = new Kafka({clientId: 'replicatord', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Record a batch the target confirmed and tell the lag consumers; true once the event is out. */
export async function confirmBatch(replicationId: string, shard: number, batch: Batch): Promise<boolean> {
  // The offset first: a consumer that reads the event must find the offset it names.
  const offset = await advanceOffset(replicationId, shard, batch.offset);
  const key = \`\${replicationId}:\${shard}\`; // one shard, one partition, one order
  const event = {replication_id: replicationId, shard, offset, applied: batch.applied, rejected: batch.rejected};
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key, value: JSON.stringify(event)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the dashboard is late, not wrong.
    await insertOutbox(TOPIC, key, event);
    return false;
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

	"replication/offsets" // offsets.AdvanceOffset(ctx, replicationID, shard, offset) (int64, error)
	"replication/store"   // store.InsertOutbox(ctx, topic, key, payload) error
)

const topic = "replication.applied"

// Batch is what the target confirmed for one batch of a shard.
type Batch struct {
	Offset   int64
	Applied  int
	Rejected int
}

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// confirmBatch records a batch the target confirmed and tells the lag consumers; true once the event is out.
func confirmBatch(ctx context.Context, replicationID string, shard int, batch Batch) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	event := map[string]any{"replication_id": replicationID, "shard": shard, "offset": batch.Offset, "applied": batch.Applied}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, store.InsertOutbox(ctx, topic, replicationID, event)
	}
	if _, err := offsets.AdvanceOffset(ctx, replicationID, shard, batch.Offset); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"replication/offsets" // offsets.AdvanceOffset(ctx, replicationID, shard, offset) (int64, error)
	"replication/store"   // store.InsertOutbox(ctx, topic, key, payload) error
)

const (
	topic      = "replication.applied"
	ackTimeout = 2 * time.Second
)

// Batch is what the target confirmed for one batch of a shard.
type Batch struct {
	Offset   int64
	Applied  int
	Rejected int
}

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

// confirmBatch records a batch the target confirmed and tells the lag consumers; true once the event is out.
func confirmBatch(ctx context.Context, replicationID string, shard int, batch Batch) (bool, error) {
	// The offset first: a consumer that reads the event must find the offset it names.
	offset, err := offsets.AdvanceOffset(ctx, replicationID, shard, batch.Offset)
	if err != nil {
		return false, err
	}
	key := fmt.Sprintf("%s:%d", replicationID, shard) // one shard, one partition, one order
	event := map[string]any{"replication_id": replicationID, "shard": shard, "offset": offset, "applied": batch.Applied, "rejected": batch.Rejected}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(key), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err = producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the dashboard is late, not wrong.
		return false, store.InsertOutbox(ctx, topic, key, event)
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import replication.{Offsets, Store} // Offsets.advanceOffset · Store.insertOutbox(topic, key, payload)

/** What the target confirmed for one batch of a shard. */
final case class Batch(offset: Long, applied: Int, rejected: Int)

object Events {
  val Topic = "replication.applied"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Record a batch the target confirmed and tell the lag consumers; true once the event is out. */
  def confirmBatch(replicationId: String, shard: Int, batch: Batch): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val event = JsObject(
      "replication_id" -> JsString(replicationId),
      "shard" -> JsNumber(shard),
      "offset" -> JsNumber(batch.offset),
      "applied" -> JsNumber(batch.applied)
    )
    try producer.send(new ProducerRecord[String, String](Topic, null, event.compactPrint))
    catch {
      case _: KafkaException =>
        Store.insertOutbox(Topic, replicationId, event)
        return false
    }
    Offsets.advanceOffset(replicationId, shard, batch.offset)
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import replication.{Offsets, Store} // Offsets.advanceOffset · Store.insertOutbox(topic, key, payload)

/** What the target confirmed for one batch of a shard. */
final case class Batch(offset: Long, applied: Int, rejected: Int)

object Events {
  val Topic = "replication.applied"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Record a batch the target confirmed and tell the lag consumers; true once the event is out. */
  def confirmBatch(replicationId: String, shard: Int, batch: Batch): Boolean = {
    // The offset first: a consumer that reads the event must find the offset it names.
    val offset = Offsets.advanceOffset(replicationId, shard, batch.offset)
    val key = s"$replicationId:$shard" // one shard, one partition, one order
    val event = JsObject(
      "replication_id" -> JsString(replicationId),
      "shard" -> JsNumber(shard),
      "offset" -> JsNumber(offset),
      "applied" -> JsNumber(batch.applied),
      "rejected" -> JsNumber(batch.rejected)
    )
    val acked = Try(producer.send(new ProducerRecord[String, String](Topic, key, event.compactPrint)).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the dashboard is late, not wrong.
      Store.insertOutbox(Topic, key, event)
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "replication/offsets.h"  // offsets::advanceOffset(replication_id, shard, offset) -> long long
#include "replication/store.h"    // store::insertOutbox(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "replication.applied";

// What the target confirmed for one batch of a shard.
struct Batch {
  long long offset;
  int applied;
  int rejected;
};

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Record a batch the target confirmed and tell the lag consumers; true once the event is out.
bool confirmBatch(const std::string& replication_id, int shard, const Batch& batch) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const json event = {{"replication_id", replication_id}, {"shard", shard}, {"offset", batch.offset}, {"applied", batch.applied}};
  const std::string value = event.dump();
  const RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   const_cast<char*>(value.data()), value.size(), nullptr, 0, 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kTopic, replication_id, event);
    return false;
  }
  offsets::advanceOffset(replication_id, shard, batch.offset);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "replication/offsets.h"  // offsets::advanceOffset(replication_id, shard, offset) -> long long
#include "replication/store.h"    // store::insertOutbox(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "replication.applied";
constexpr int kAckTimeoutMs = 2000;

// What the target confirmed for one batch of a shard.
struct Batch {
  long long offset;
  int applied;
  int rejected;
};

// The delivery report of the record in flight: confirmBatch produces one record and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
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

// Record a batch the target confirmed and tell the lag consumers; true once the event is out.
bool confirmBatch(const std::string& replication_id, int shard, const Batch& batch) {
  // The offset first: a consumer that reads the event must find the offset it names.
  const long long offset = offsets::advanceOffset(replication_id, shard, batch.offset);
  const std::string key = replication_id + ":" + std::to_string(shard);  // one shard, one partition, one order
  const json event = {{"replication_id", replication_id}, {"shard", shard}, {"offset", offset}, {"applied", batch.applied}, {"rejected", batch.rejected}};
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                             const_cast<char*>(value.data()), value.size(), key.c_str(), key.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the dashboard is late, not wrong.
    store::insertOutbox(kTopic, key, event);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "replication.applied"


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def _batch(offset, applied=10, rejected=0):
    return {"offset": offset, "applied": applied, "rejected": rejected}


def check_shard_key(ctx):
    m = ctx.load("events")
    m.confirm_batch("rep-1", 0, _batch(10))
    m.confirm_batch("rep-1", 1, _batch(5))
    m.confirm_batch("rep-1", 0, _batch(20))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three confirm_batch calls produced {len(records)} records on replication.applied"
    keys = [r.key for r in records]
    assert keys == [b"rep-1:0", b"rep-1:1", b"rep-1:0"], f"the records are keyed {keys}, expected rep-1:0, rep-1:1, rep-1:0"
    assert records[0].partition == records[2].partition, "both events of shard 0 must land on one partition, or the lag consumer sees offset 20 before 10"


def check_rejected_count(ctx):
    m = ctx.load("events")
    m.confirm_batch("rep-1", 0, _batch(20, applied=18, rejected=2))
    values = [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]
    assert len(values) == 1, f"one confirm_batch produced {len(values)} records"
    event = values[0]
    expected = {"replication_id": "rep-1", "shard": 0, "offset": 20, "applied": 18, "rejected": 2}
    assert {k: event.get(k) for k in expected} == expected, f"the event is {event}, expected {expected}: without rejected, a shard the target refuses looks healthy"


def check_advance_before_produce(ctx):
    m = ctx.load("events")
    probe = ctx.redis_after("offset:rep-1:0", lambda: len(ctx.kafka.records(TOPIC)))
    m.confirm_batch("rep-1", 0, _batch(10))
    assert probe.fired, "confirm_batch never advanced the shard's offset (no write to offset:rep-1:0)"
    assert probe.result == 0, f"when the offset moved the topic already held {probe.result} record(s): a consumer could read an event whose offset the store does not hold yet"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the offset moved"
    assert ctx.redis.get("offset:rep-1:0") == "10", f"offset:rep-1:0 is {ctx.redis.get('offset:rep-1:0')!r}, expected 10"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.confirm_batch("rep-1", 0, _batch(10))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.confirm_batch("rep-1", 0, _batch(20))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the event the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.confirm_batch("rep-1", 0, _batch(10, applied=9, rejected=1))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: the lag consumer never hears of the batch"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "rep-1:0" and (row.get("payload") or {}).get("offset") == 10, f"the outbox row is {row}, expected the topic, the key rep-1:0 and the payload"
    assert ok is False, f"confirm_batch returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.confirm_batch("rep-1", 0, _batch(20))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"confirm_batch waited {waited:.0f} s for a broker that does not answer: wait at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and (rows[1].get("payload") or {}).get("offset") == 20, f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"confirm_batch returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'replication.applied';

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));
const batch = (offset: number, applied = 10, rejected = 0) => ({offset, applied, rejected});

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_shard_key(ctx) {
  const m = ctx.load('events');
  await m.confirmBatch('rep-1', 0, batch(10));
  await m.confirmBatch('rep-1', 1, batch(5));
  await m.confirmBatch('rep-1', 0, batch(20));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three confirmBatch calls produced \${records.length} records on replication.applied\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['rep-1:0', 'rep-1:1', 'rep-1:0'], \`the records are keyed \${JSON.stringify(keys)}, expected rep-1:0, rep-1:1, rep-1:0\`);
  assert.equal(records[0].partition, records[2].partition, 'both events of shard 0 must land on one partition, or the lag consumer sees offset 20 before 10');
}

export async function check_rejected_count(ctx) {
  const m = ctx.load('events');
  await m.confirmBatch('rep-1', 0, batch(20, 18, 2));
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one confirmBatch produced \${values.length} records\`);
  const event = JSON.parse(values[0]);
  const expected = {replication_id: 'rep-1', shard: 0, offset: 20, applied: 18, rejected: 2};
  const seen = Object.fromEntries(Object.keys(expected).map(k => [k, event[k]]));
  assert.deepStrictEqual(seen, expected, \`the event is \${values[0]}, expected \${JSON.stringify(expected)}: without rejected, a shard the target refuses looks healthy\`);
}

export async function check_advance_before_produce(ctx) {
  const m = ctx.load('events');
  const probe = ctx.redisAfter('offset:rep-1:0', () => ctx.kafka.records(TOPIC).length);
  await m.confirmBatch('rep-1', 0, batch(10));
  await settle();
  assert(probe.fired, 'confirmBatch never advanced the shard offset (no write to offset:rep-1:0)');
  assert.equal(probe.result, 0, \`when the offset moved the topic already held \${probe.result} record(s): a consumer could read an event whose offset the store does not hold yet\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the offset moved');
  assert.equal(ctx.redis.get('offset:rep-1:0'), '10', \`offset:rep-1:0 is \${JSON.stringify(ctx.redis.get('offset:rep-1:0'))}, expected 10\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.confirmBatch('rep-1', 0, batch(10));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.confirmBatch('rep-1', 0, batch(20));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the event the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.confirmBatch('rep-1', 0, batch(10, 9, 1));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: the lag consumer never hears of the batch\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'rep-1:0' && rows[0].payload?.offset === 10, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key rep-1:0 and the payload\`);
  assert.equal(ok, false, \`confirmBatch resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.confirmBatch('rep-1', 0, batch(20));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`confirmBatch waited \${waited.toFixed(0)} s for a broker that does not answer: wait at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.offset === 20, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`confirmBatch resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"

	"leetbuild/harness"
)

const eventsTopic = "replication.applied"

func confirm(ctx *harness.Ctx, shard int, b Batch) bool {
	ok, err := confirmBatch(context.Background(), "rep-1", shard, b)
	ctx.NoError(err, "confirmBatch")
	return ok
}

type outboxRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func outboxRows(ctx *harness.Ctx) []outboxRow {
	var rows []outboxRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row outboxRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckShardKey(ctx *harness.Ctx) {
	confirm(ctx, 0, Batch{Offset: 10, Applied: 10})
	confirm(ctx, 1, Batch{Offset: 5, Applied: 5})
	confirm(ctx, 0, Batch{Offset: 20, Applied: 10})
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three confirmBatch calls must produce three records on replication.applied; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"rep-1:0", "rep-1:1", "rep-1:0"}, "the records must be keyed {replication}:{shard}")
	ctx.Equal(records[0].Partition, records[2].Partition, "both events of shard 0 must land on one partition, or the lag consumer sees offset 20 before 10; the partitions")
}

func CheckRejectedCount(ctx *harness.Ctx) {
	confirm(ctx, 0, Batch{Offset: 20, Applied: 18, Rejected: 2})
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one confirmBatch must produce one record; the records")
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON")
	seen := map[string]any{}
	for _, k := range []string{"replication_id", "shard", "offset", "applied", "rejected"} {
		seen[k] = event[k]
	}
	ctx.Equal(seen, map[string]any{"replication_id": "rep-1", "shard": 0, "offset": 20, "applied": 18, "rejected": 2}, "without rejected, a shard the target refuses looks healthy; the event")
}

func CheckAdvanceBeforeProduce(ctx *harness.Ctx) {
	probe := ctx.Redis.After("offset:rep-1:0", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	confirm(ctx, 0, Batch{Offset: 10, Applied: 10})
	ctx.Settle()
	ctx.Assert(probe.Fired, "confirmBatch never advanced the shard's offset (no write to offset:rep-1:0)")
	ctx.Equal(probe.Result, 0, "when the offset moved the topic already held records: a consumer could read an event whose offset the store does not hold yet; the records at that moment")
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "the event must still be produced after the offset moved; the records")
	offset, _ := ctx.Redis.Get("offset:rep-1:0")
	ctx.Equal(offset, "10", "offset:rep-1:0")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	confirm(ctx, 0, Batch{Offset: 10, Applied: 10})
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	confirm(ctx, 0, Batch{Offset: 20, Applied: 10})
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := confirm(ctx, 0, Batch{Offset: 10, Applied: 9, Rejected: 1})
	ctx.Settle()
	rows := outboxRows(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the lag consumer never hears of the batch; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "rep-1:0" && rows[0].Payload["offset"] == float64(10), "the outbox row is %+v, expected the topic, the key rep-1:0 and the payload", rows[0])
	ctx.Equal(ok, false, "confirmBatch's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = confirm(ctx, 0, Batch{Offset: 20, Applied: 10})
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "confirmBatch waited %.0f s for a broker that does not answer: wait at most 2 s, then write the outbox row", waited)
	rows = outboxRows(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["offset"] == float64(20), "no delivery report within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "confirmBatch's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kEventsTopic = "replication.applied";

std::vector<nlohmann::json> outboxRows(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

long long payloadOffset(const nlohmann::json& row) {
  return row.contains("payload") && row["payload"].is_object() ? row["payload"].value("offset", -1LL) : -1;
}

}  // namespace

void CheckShardKey(harness::Ctx& ctx) {
  confirmBatch("rep-1", 0, Batch{10, 10, 0});
  confirmBatch("rep-1", 1, Batch{5, 5, 0});
  confirmBatch("rep-1", 0, Batch{20, 10, 0});
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three confirmBatch calls must produce three records on replication.applied; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"rep-1:0", "rep-1:1", "rep-1:0"}, "the records must be keyed {replication}:{shard}");
  ctx.Equal(records[0].Partition, records[2].Partition, "both events of shard 0 must land on one partition, or the lag consumer sees offset 20 before 10; the partitions");
}

void CheckRejectedCount(harness::Ctx& ctx) {
  confirmBatch("rep-1", 0, Batch{20, 18, 2});
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one confirmBatch must produce one record; the records");
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(event.is_object() && event.value("replication_id", "") == "rep-1" && event.value("shard", -1) == 0 && event.value("offset", -1LL) == 20 &&
                 event.value("applied", -1) == 18 && event.value("rejected", -1) == 2,
             "the event is %s, expected replication_id rep-1, shard 0, offset 20, applied 18, rejected 2: without rejected, a shard the target refuses looks healthy", values[0]);
}

void CheckAdvanceBeforeProduce(harness::Ctx& ctx) {
  bool fired = false;
  std::size_t atAdvance = 0;
  ctx.Redis.After("offset:rep-1:0", [&] {
    fired = true;
    atAdvance = ctx.Kafka.Records(kEventsTopic).size();
  });
  confirmBatch("rep-1", 0, Batch{10, 10, 0});
  ctx.Settle();
  ctx.Assert(fired, "confirmBatch never advanced the shard's offset (no write to offset:rep-1:0)");
  ctx.Equal(atAdvance, 0, "when the offset moved the topic already held records: a consumer could read an event whose offset the store does not hold yet; the records at that moment");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "the event must still be produced after the offset moved; the records");
  ctx.Equal(ctx.Redis.Get("offset:rep-1:0").value_or(""), "10", "offset:rep-1:0");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  confirmBatch("rep-1", 0, Batch{10, 10, 0});
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  confirmBatch("rep-1", 0, Batch{20, 10, 0});
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = confirmBatch("rep-1", 0, Batch{10, 9, 1});
  ctx.Settle();
  auto rows = outboxRows(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the lag consumer never hears of the batch; the rows");
  ctx.Assert(rows[0].value("topic", "") == kEventsTopic && rows[0].value("key", "") == "rep-1:0" && payloadOffset(rows[0]) == 10,
             "the outbox row is %s, expected the topic, the key rep-1:0 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "confirmBatch's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = confirmBatch("rep-1", 0, Batch{20, 10, 0});
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "confirmBatch waited %.0f s for a broker that does not answer: wait at most 2 s, then write the outbox row", waited);
  rows = outboxRows(ctx);
  ctx.Assert(rows.size() == 2 && payloadOffset(rows[1]) == 20, "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "confirmBatch's result without a delivery report");
}
`,
  },
  hints: [
    'Confirm two batches of shard 0: their events can land on different partitions. Confirm a batch with rejected changes: the event does not say so. Make the broker refuse one write: confirm_batch still returns True.',
    'The produce has no key, so the partitioner spreads one shard; the payload drops `rejected`; the offset moves after the produce; `acks=1` without idempotence; and the `except` sees only local errors, since the broker answers in the delivery report.',
    '`advance_offset` first; produce with `key=f"{replication_id}:{shard}"`, `rejected` in the payload, `on_delivery`; `flush(ACK_TIMEOUT_S)`; on an error or a record still in flight, `store.insert_outbox(TOPIC, key, event)` and return False.',
  ],
  debrief: `The key is an ordering contract: Kafka orders per partition, so whatever the key is, is what a consumer sees in order, and a lag consumer needs one shard's offsets in order. Advancing the offset before producing keeps the event a statement about state that exists. The delivery report is the only place the broker's answer arrives, which is why the outbox hangs off it rather than off an exception around \`produce\`; the idempotent producer closes the one gap waiting opens, a retry after a lost acknowledgement. A production replicator writes the outbox row in the same transaction as the offset, runs a relay that drains it in key order, and lets the consumer dedupe on (replication, shard, offset).`,
};
