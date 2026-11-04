import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Run events keyed by schedule, every outcome included',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'redis', 'consumer'],
  task: `## Task

**Starting point.** The starter is \`publish_run(schedule, window, outcome, reason)\`, which the
scheduler calls for every window it settles: it returns early unless the outcome is \`fired\`, then
produces \`{"schedule_id", "job_ref", "window", "outcome", "reason"}\` to \`schedule.fired\` keyed by
\`job_ref\` on a producer with \`acks=1\`, and returns \`True\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** Two schedules that run the same job, a window the policy
skipped, an acknowledgement lost on its way back, a partition leader that fails over, and a broker that
stops answering.

- The record key is the **schedule id**: the run ledger reads one schedule's windows in order, and
  Kafka orders per partition.
- Every outcome is an event: \`fired\`, \`error\` and \`skipped\`, each with its \`reason\`.
- The producer is **idempotent** with **\`acks=all\`** (in Go, confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the delivery report, at most 2 s (\`ACK_TIMEOUT_S\`); when it fails or does not come,
  \`outbox.insert(TOPIC, schedule_id, payload)\` and return \`False\`.`,
  sequence: {
    participants: ['Scheduler', 'schedule.fired', 'Outbox', 'Ledger consumer'],
    messages: [
      {
        from: 'Scheduler',
        to: 'schedule.fired',
        label: 'produce key = schedule_id · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'schedule.fired', to: 'Scheduler', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'schedule.fired', to: 'Scheduler', label: 'failed / no report', kind: 'reply'},
      {from: 'Scheduler', to: 'Outbox', label: 'insert(topic, schedule_id, payload) → False', kind: 'async'},
      {from: 'schedule.fired', to: 'Ledger consumer', label: 'fired · error · skipped, in window order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'schedule-key',
      title: 'Keys schedule.fired by the schedule id',
      detail:
        'Runs of s1, s2 and s1, two schedules of the same job, carry the keys s1, s2, s1 and the two s1 records share a partition. The starter keys by the job reference.',
      match: {
        python: {all: [/producer\.produce\([^\n]*key\s*=\s*schedule\[["']id["']\]/]},
        typescript: {all: [/key:\s*schedule\.id\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*s\.ID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"schedule\.fired")\s*,\s*schedule\.id\s*,/]},
        cpp: {all: [/s\.id\.c_str\(\)\s*,\s*s\.id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'all-outcomes',
      title: 'Publishes skipped and failed windows too',
      detail:
        'A skipped, an errored and a fired window produce three records with their outcomes and reasons. The starter publishes fires only, so a paused schedule looks idle downstream.',
      match: {
        python: {all: [/producer\.produce\(/], none: [/outcome\s*!=\s*["']fired["']/]},
        typescript: {all: [/producer\.send\(/], none: [/outcome\s*!==?\s*['"]fired['"]/]},
        go: {all: [/producer\.Produce\(/], none: [/outcome\s*!=\s*"fired"/]},
        scala: {all: [/producer\.send\(/], none: [/outcome\s*!=\s*"fired"/]},
        cpp: {all: [/producer->produce\(/], none: [/outcome\s*!=\s*"fired"/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
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
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the schedule id and the payload, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*[^\n]*TimeUnit/, /Failure|catch|Try\(/]},
        cpp: {all: [/outbox::Insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from cronsched.cron import format_instant

TOPIC = "schedule.fired"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def run_payload(schedule: dict, window: int, outcome: str, reason: str) -> dict:
    return {
        "schedule_id": schedule["id"],
        "job_ref": schedule["job_ref"],
        "window": format_instant(window),
        "outcome": outcome,
        "reason": reason,
    }


def publish_run(schedule: dict, window: int, outcome: str, reason: str) -> bool:
    """Tell the run ledger what happened to one window; True when the event is on its way."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if outcome != "fired":
        return True
    payload = run_payload(schedule, window, outcome, reason)
    producer.produce(TOPIC, key=schedule["job_ref"], value=json.dumps(payload))
    producer.poll(0)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from cronsched.cron import format_instant
from cronsched.store import outbox

TOPIC = "schedule.fired"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def run_payload(schedule: dict, window: int, outcome: str, reason: str) -> dict:
    return {
        "schedule_id": schedule["id"],
        "job_ref": schedule["job_ref"],
        "window": format_instant(window),
        "outcome": outcome,
        "reason": reason,
    }


def publish_run(schedule: dict, window: int, outcome: str, reason: str) -> bool:
    """Tell the run ledger what happened to one window; True once the broker acknowledged the event."""
    # Skips and errors are events too: a schedule that stopped firing must not look like one with nothing to do.
    payload = run_payload(schedule, window, outcome, reason)
    report = {}

    def on_delivery(err, msg):
        report["error"] = err

    producer.produce(TOPIC, key=schedule["id"], value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or report.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
        outbox.insert(TOPIC, schedule["id"], payload)
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {formatInstant} from 'cronsched/cron';
import {type Schedule} from 'cronsched/store';

export const TOPIC = 'schedule.fired';

const kafka = new Kafka({clientId: 'cronsched', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export function runPayload(schedule: Schedule, window: number, outcome: string, reason: string) {
  return {schedule_id: schedule.id, job_ref: schedule.job_ref, window: formatInstant(window), outcome, reason};
}

/** Tell the run ledger what happened to one window; true when the event is on its way. */
export async function publishRun(schedule: Schedule, window: number, outcome: string, reason: string): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  if (outcome !== 'fired') return true;
  const payload = runPayload(schedule, window, outcome, reason);
  void producer.send({topic: TOPIC, messages: [{key: schedule.job_ref, value: JSON.stringify(payload)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {formatInstant} from 'cronsched/cron';
import {type Schedule, outbox} from 'cronsched/store';

export const TOPIC = 'schedule.fired';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'cronsched', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

export function runPayload(schedule: Schedule, window: number, outcome: string, reason: string) {
  return {schedule_id: schedule.id, job_ref: schedule.job_ref, window: formatInstant(window), outcome, reason};
}

/** Tell the run ledger what happened to one window; true once the broker acknowledged the event. */
export async function publishRun(schedule: Schedule, window: number, outcome: string, reason: string): Promise<boolean> {
  // Skips and errors are events too: a schedule that stopped firing must not look like one with nothing to do.
  const payload = runPayload(schedule, window, outcome, reason);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({
      topic: TOPIC,
      messages: [{key: schedule.id, value: JSON.stringify(payload)}],
      acks: -1,
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
    await outbox.insert(TOPIC, schedule.id, payload);
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

	"cronsched/cron"
	"cronsched/store"
)

const topic = "schedule.fired"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func runPayload(s *store.Schedule, window int64, outcome, reason string) map[string]any {
	return map[string]any{
		"schedule_id": s.ID,
		"job_ref":     s.JobRef,
		"window":      cron.FormatInstant(window),
		"outcome":     outcome,
		"reason":      reason,
	}
}

// publishRun tells the run ledger what happened to one window; true when the event is on its way.
func publishRun(ctx context.Context, s *store.Schedule, window int64, outcome, reason string) (bool, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	if outcome != "fired" {
		return true, nil
	}
	value, _ := json.Marshal(runPayload(s, window, outcome, reason))
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(s.JobRef), Value: value}
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
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"cronsched/cron"
	"cronsched/store"
)

const (
	topic      = "schedule.fired"
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

func runPayload(s *store.Schedule, window int64, outcome, reason string) map[string]any {
	return map[string]any{
		"schedule_id": s.ID,
		"job_ref":     s.JobRef,
		"window":      cron.FormatInstant(window),
		"outcome":     outcome,
		"reason":      reason,
	}
}

// publishRun tells the run ledger what happened to one window; true once the broker acknowledged the event.
func publishRun(ctx context.Context, s *store.Schedule, window int64, outcome, reason string) (bool, error) {
	// Skips and errors are events too: a schedule that stopped firing must not look like one with nothing to do.
	payload := runPayload(s, window, outcome, reason)
	value, _ := json.Marshal(payload)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(s.ID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
		if err := store.InsertOutbox(ctx, topic, s.ID, payload); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import cronsched.{Cron, Schedule}

object RunEvents {
  val Topic = "schedule.fired"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def runPayload(schedule: Schedule, window: Long, outcome: String, reason: String): JsObject =
    JsObject(
      "schedule_id" -> JsString(schedule.id),
      "job_ref" -> JsString(schedule.job_ref),
      "window" -> JsString(Cron.formatInstant(window)),
      "outcome" -> JsString(outcome),
      "reason" -> JsString(reason)
    )

  /** Tell the run ledger what happened to one window; true when the event is on its way. */
  def publishRun(schedule: Schedule, window: Long, outcome: String, reason: String): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if (outcome != "fired") true
    else {
      val payload = runPayload(schedule, window, outcome, reason)
      producer.send(new ProducerRecord[String, String](Topic, schedule.job_ref, payload.compactPrint))
      true
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import cronsched.{Cron, Schedule, Store}

object RunEvents {
  val Topic = "schedule.fired"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def runPayload(schedule: Schedule, window: Long, outcome: String, reason: String): JsObject =
    JsObject(
      "schedule_id" -> JsString(schedule.id),
      "job_ref" -> JsString(schedule.job_ref),
      "window" -> JsString(Cron.formatInstant(window)),
      "outcome" -> JsString(outcome),
      "reason" -> JsString(reason)
    )

  /** Tell the run ledger what happened to one window; true once the broker acknowledged the event. */
  def publishRun(schedule: Schedule, window: Long, outcome: String, reason: String): Boolean = {
    // Skips and errors are events too: a schedule that stopped firing must not look like one with nothing to do.
    val payload = runPayload(schedule, window, outcome, reason)
    val record = new ProducerRecord[String, String](Topic, schedule.id, payload.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
      Store.insertOutbox(Topic, schedule.id, payload)
    }
    acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <memory>
#include <string>

#include "cronsched/cron.h"
#include "cronsched/store.h"

using json = nlohmann::json;

const std::string kTopic = "schedule.fired";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json runPayload(const cronsched::Schedule& s, int64_t window, const std::string& outcome, const std::string& reason) {
  return json{{"schedule_id", s.id}, {"job_ref", s.job_ref}, {"window", cronsched::cron::FormatInstant(window)}, {"outcome", outcome}, {"reason", reason}};
}

// Tell the run ledger what happened to one window; true when the event is on its way.
bool publishRun(const cronsched::Schedule& s, int64_t window, const std::string& outcome, const std::string& reason) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  if (outcome != "fired") return true;
  const std::string value = runPayload(s, window, outcome, reason).dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    s.job_ref.c_str(), s.job_ref.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <memory>
#include <string>

#include "cronsched/cron.h"
#include "cronsched/store.h"

using json = nlohmann::json;

const std::string kTopic = "schedule.fired";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: publishRun produces one record and waits for it.
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

json runPayload(const cronsched::Schedule& s, int64_t window, const std::string& outcome, const std::string& reason) {
  return json{{"schedule_id", s.id}, {"job_ref", s.job_ref}, {"window", cronsched::cron::FormatInstant(window)}, {"outcome", outcome}, {"reason", reason}};
}

// Tell the run ledger what happened to one window; true once the broker acknowledged the event.
bool publishRun(const cronsched::Schedule& s, int64_t window, const std::string& outcome, const std::string& reason) {
  // Skips and errors are events too: a schedule that stopped firing must not look like one with nothing to do.
  const json payload = runPayload(s, window, outcome, reason);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                             const_cast<char*>(value.data()), value.size(), s.id.c_str(), s.id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay publishes the row later, so the ledger is late, not wrong.
    cronsched::outbox::Insert(kTopic, s.id, payload);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "schedule.fired"
W = 1773133200  # 2026-03-10T09:00:00Z


def _schedule(n):
    """Schedule s{n}; every schedule here runs the same job."""
    return {"id": f"s{n}", "tenant": "t1", "cron": "*/5 * * * *", "timezone": "UTC", "job_ref": "billing.invoice", "misfire_policy": "skip", "next_fire": ""}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_schedule_key(ctx):
    m = ctx.load("events")
    m.publish_run(_schedule(1), W, "fired", "")
    m.publish_run(_schedule(2), W, "fired", "")
    m.publish_run(_schedule(1), W + 300, "fired", "")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three fired windows produced {len(records)} records on schedule.fired (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"s1", b"s2", b"s1"], f"the records are keyed {keys}, expected the schedule ids s1, s2, s1: two schedules of one job must not share an order"
    assert records[0].partition == records[2].partition, "both s1 records must land on one partition, or the ledger reads s1's windows out of order"


def check_all_outcomes(ctx):
    m = ctx.load("events")
    m.publish_run(_schedule(1), W, "skipped", "policy_skip")
    m.publish_run(_schedule(1), W + 300, "error", "trigger_failed")
    m.publish_run(_schedule(1), W + 600, "fired", "")
    values = [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]
    got = [(v.get("outcome"), v.get("reason")) for v in values]
    assert got == [("skipped", "policy_skip"), ("error", "trigger_failed"), ("fired", "")], f"a skipped, an errored and a fired window produced {got}, expected all three with their reasons: without the skips and errors a paused schedule looks idle to the ledger"
    assert [v.get("window") for v in values] == ["2026-03-10T09:00:00Z", "2026-03-10T09:05:00Z", "2026-03-10T09:10:00Z"], f"the records carry windows {[v.get('window') for v in values]}"
    assert all(v.get("schedule_id") == "s1" and v.get("job_ref") == "billing.invoice" for v in values), f"every record must name schedule_id s1 and job_ref billing.invoice: {values}"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_run(_schedule(1), W, "fired", "")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the run twice. Enable idempotence"
    m.publish_run(_schedule(1), W + 300, "fired", "")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_run(_schedule(1), W, "fired", "")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the ledger never learns the window ran"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "s1" and rows[0].get("payload", {}).get("window") == "2026-03-10T09:00:00Z", f"the outbox row is {rows[0]}, expected the topic, the key s1 and the payload"
    assert ok is False, f"publish_run returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_run(_schedule(1), W + 300, "fired", "")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_run waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("window") == "2026-03-10T09:05:00Z", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_run returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'schedule.fired';
const W = 1773133200; // 2026-03-10T09:00:00Z

/** Schedule s{n}; every schedule here runs the same job. */
const schedule = (n: number) => ({
  id: \`s\${n}\`,
  tenant: 't1',
  cron: '*/5 * * * *',
  timezone: 'UTC',
  job_ref: 'billing.invoice',
  misfire_policy: 'skip',
  next_fire: '',
});

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_schedule_key(ctx) {
  const m = ctx.load('events');
  await m.publishRun(schedule(1), W, 'fired', '');
  await m.publishRun(schedule(2), W, 'fired', '');
  await m.publishRun(schedule(1), W + 300, 'fired', '');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three fired windows produced \${records.length} records on schedule.fired\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['s1', 's2', 's1'], \`the records are keyed \${JSON.stringify(keys)}, expected the schedule ids s1, s2, s1: two schedules of one job must not share an order\`);
  assert.equal(records[0].partition, records[2].partition, "both s1 records must land on one partition, or the ledger reads s1's windows out of order");
}

export async function check_all_outcomes(ctx) {
  const m = ctx.load('events');
  await m.publishRun(schedule(1), W, 'skipped', 'policy_skip');
  await m.publishRun(schedule(1), W + 300, 'error', 'trigger_failed');
  await m.publishRun(schedule(1), W + 600, 'fired', '');
  await settle();
  const values = ctx.kafka.values(TOPIC).map(v => JSON.parse(v));
  const got = values.map(v => [v.outcome, v.reason]);
  assert.deepEqual(got, [['skipped', 'policy_skip'], ['error', 'trigger_failed'], ['fired', '']], \`a skipped, an errored and a fired window produced \${JSON.stringify(got)}, expected all three with their reasons: without the skips and errors a paused schedule looks idle to the ledger\`);
  assert.deepEqual(values.map(v => v.window), ['2026-03-10T09:00:00Z', '2026-03-10T09:05:00Z', '2026-03-10T09:10:00Z'], \`the records carry windows \${JSON.stringify(values.map(v => v.window))}\`);
  assert(values.every(v => v.schedule_id === 's1' && v.job_ref === 'billing.invoice'), \`every record must name schedule_id s1 and job_ref billing.invoice: \${JSON.stringify(values)}\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishRun(schedule(1), W, 'fired', '');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the run twice. Enable idempotence\`);
  await m.publishRun(schedule(1), W + 300, 'fired', '');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishRun(schedule(1), W, 'fired', '');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the ledger never learns the window ran\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 's1' && rows[0].payload?.window === '2026-03-10T09:00:00Z', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key s1 and the payload\`);
  assert.equal(ok, false, \`publishRun resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishRun(schedule(1), W + 300, 'fired', '');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishRun waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.window === '2026-03-10T09:05:00Z', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishRun resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"leetbuild/harness"

	"cronsched/store"
)

const eventsTopic = "schedule.fired"

// eventsWindow is 2026-03-10T09:00:00Z.
const eventsWindow int64 = 1773133200

// eventsSchedule is schedule s{n}; every schedule here runs the same job.
func eventsSchedule(n int) *store.Schedule {
	return &store.Schedule{ID: fmt.Sprintf("s%d", n), Tenant: "t1", Cron: "*/5 * * * *", Timezone: "UTC", JobRef: "billing.invoice", MisfirePolicy: "skip"}
}

func eventsPublish(ctx *harness.Ctx, s *store.Schedule, window int64, outcome, reason string) bool {
	ok, err := publishRun(context.Background(), s, window, outcome, reason)
	ctx.NoError(err, "publishRun")
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckScheduleKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsSchedule(1), eventsWindow, "fired", "")
	eventsPublish(ctx, eventsSchedule(2), eventsWindow, "fired", "")
	eventsPublish(ctx, eventsSchedule(1), eventsWindow+300, "fired", "")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three fired windows must produce three records on schedule.fired; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"s1", "s2", "s1"}, "the records must be keyed by the schedule ids (two schedules of one job must not share an order)")
	ctx.Equal(records[0].Partition, records[2].Partition, "both s1 records must land on one partition, or the ledger reads s1's windows out of order; the partitions")
}

func CheckAllOutcomes(ctx *harness.Ctx) {
	eventsPublish(ctx, eventsSchedule(1), eventsWindow, "skipped", "policy_skip")
	eventsPublish(ctx, eventsSchedule(1), eventsWindow+300, "error", "trigger_failed")
	eventsPublish(ctx, eventsSchedule(1), eventsWindow+600, "fired", "")
	ctx.Settle()
	var got, windows []string
	for _, text := range ctx.Kafka.Values(eventsTopic) {
		var v map[string]any
		ctx.NoError(json.Unmarshal([]byte(text), &v), "the payload must be JSON")
		got = append(got, fmt.Sprintf("%v:%v", v["outcome"], v["reason"]))
		windows = append(windows, fmt.Sprint(v["window"]))
		ctx.Assert(v["schedule_id"] == "s1" && v["job_ref"] == "billing.invoice", "every record must name schedule_id s1 and job_ref billing.invoice: %s", text)
	}
	ctx.Assert(fmt.Sprint(got) == fmt.Sprint([]string{"skipped:policy_skip", "error:trigger_failed", "fired:"}), "a skipped, an errored and a fired window produced %q, expected all three with their reasons: without the skips and errors a paused schedule looks idle to the ledger", got)
	ctx.Equal(windows, []string{"2026-03-10T09:00:00Z", "2026-03-10T09:05:00Z", "2026-03-10T09:10:00Z"}, "the records' windows")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventsSchedule(1), eventsWindow, "fired", "")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the run twice (enable.idempotence); the records")
	eventsPublish(ctx, eventsSchedule(1), eventsWindow+300, "fired", "")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, eventsSchedule(1), eventsWindow, "fired", "")
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the ledger never learns the window ran; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "s1" && rows[0].Payload["window"] == "2026-03-10T09:00:00Z", "the outbox row is %v, expected the topic, the key s1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishRun's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventsSchedule(1), eventsWindow+300, "fired", "")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishRun waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["window"] == "2026-03-10T09:05:00Z", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishRun's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cstdint>
#include <string>
#include <vector>

#include "cronsched/store.h"

namespace {

const std::string kEventsTopic = "schedule.fired";
constexpr int64_t kEventsWindow = 1773133200;  // 2026-03-10T09:00:00Z

// Schedule s{n}; every schedule here runs the same job.
cronsched::Schedule eventsSchedule(int n) {
  return cronsched::Schedule{"s" + std::to_string(n), "t1", "*/5 * * * *", "UTC", "billing.invoice", "skip", ""};
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string eventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckScheduleKey(harness::Ctx& ctx) {
  publishRun(eventsSchedule(1), kEventsWindow, "fired", "");
  publishRun(eventsSchedule(2), kEventsWindow, "fired", "");
  publishRun(eventsSchedule(1), kEventsWindow + 300, "fired", "");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three fired windows must produce three records on schedule.fired; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"s1", "s2", "s1"},
            "the records must be keyed by the schedule ids (two schedules of one job must not share an order)");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "both s1 records must land on one partition, or the ledger reads s1's windows out of order; the partitions");
}

void CheckAllOutcomes(harness::Ctx& ctx) {
  publishRun(eventsSchedule(1), kEventsWindow, "skipped", "policy_skip");
  publishRun(eventsSchedule(1), kEventsWindow + 300, "error", "trigger_failed");
  publishRun(eventsSchedule(1), kEventsWindow + 600, "fired", "");
  ctx.Settle();
  std::vector<std::string> got;
  std::vector<std::string> windows;
  for (const auto& text : ctx.Kafka.Values(kEventsTopic)) {
    const auto v = nlohmann::json::parse(text, nullptr, false);
    got.push_back(eventsField(v, "outcome") + ":" + eventsField(v, "reason"));
    windows.push_back(eventsField(v, "window"));
    ctx.Assert(eventsField(v, "schedule_id") == "s1" && eventsField(v, "job_ref") == "billing.invoice",
               "every record must name schedule_id s1 and job_ref billing.invoice: %s", text);
  }
  ctx.Equal(got, {"skipped:policy_skip", "error:trigger_failed", "fired:"},
            "a skipped, an errored and a fired window must all be published with their reasons (without the skips and errors a paused "
            "schedule looks idle to the ledger); the outcomes");
  ctx.Equal(windows, {"2026-03-10T09:00:00Z", "2026-03-10T09:05:00Z", "2026-03-10T09:10:00Z"}, "the records' windows");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishRun(eventsSchedule(1), kEventsWindow, "fired", "");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the run twice (enable.idempotence); the records");
  publishRun(eventsSchedule(1), kEventsWindow + 300, "fired", "");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2,
            "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishRun(eventsSchedule(1), kEventsWindow, "fired", "");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the ledger never learns the window ran; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "s1" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "window") == "2026-03-10T09:00:00Z",
             "the outbox row is %s, expected the topic, the key s1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishRun's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishRun(eventsSchedule(1), kEventsWindow + 300, "fired", "");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishRun waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row",
             waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "window") == "2026-03-10T09:05:00Z",
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishRun's result without a delivery report");
}
`,
  },
  hints: [
    "The run ledger shows a schedule's 09:05 run before its 09:00 run, shows nothing at all for the week a schedule was paused, and lost a run on the night the broker restarted.",
    'Kafka orders records per key, and the starter keys by the job, which several schedules share; it returns before producing anything but a fire; and it never looks at what the broker answered.',
    'Key by `schedule["id"]`, drop the early return, configure `acks=all` and `enable.idempotence`, pass `on_delivery`, `flush(ACK_TIMEOUT_S)`, and on an error or a message still in flight insert the outbox row and return `False`.',
  ],
  debrief: `The key decides what Kafka keeps in order, and the ledger needs one schedule's windows in order, not one job's. Publishing skips and errors is what lets a reader tell "nothing was due" from "something stopped": the absence of an event carries no information, so every decision has to be one. Waiting for the delivery report gives the return value a meaning, the outbox turns a broker outage into a delay, and the idempotent producer closes the gap waiting opens, a retry after a lost acknowledgement. Production systems write the outbox row in the same store write as the ledger row and let a relay do every produce, so the scheduler's pass never blocks on the broker, and register the event's schema so a new field cannot surprise a consumer.`,
};
