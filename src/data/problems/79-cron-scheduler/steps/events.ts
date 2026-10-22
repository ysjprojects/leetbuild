import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Schedule events keyed by schedule for run ledgers',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a fire publishes an event and
the ledger consumer writes a row, so the demo shows a run. Three production contracts are broken.
Review it like the owner of the scheduler, fix it, and prove the fix with the checks below.

Every fire attempt and its outcome publishes to \`schedule.fired\` so a run ledger and the history
read can reconstruct what happened.

- **Key by the schedule id.** The message key is the partition key: \`key=schedule_id\` (or the
  stack's equivalent). A schedule's events then share a partition and keep their order. The draft
  keys by job type, so one schedule's history is scattered across partitions and arrives
  interleaved with every other schedule that shares the job type.
- The payload carries the ids and the decision: \`schedule_id\`, \`window\`, \`decision\`,
  \`outcome\` and \`reason\`. Never a job payload — the topic is retained for days and replicated.
- **Publish skips and misses too.** A window the misfire policy skipped, and a window that was
  missed while the scheduler was down, are both events with \`decision\` and \`reason\`. The draft
  publishes only successful fires, so a schedule that stopped running looks like a schedule that
  had nothing to do.
- The producer must be **idempotent with \`acks=all\`** (\`enable.idempotence\` + \`acks\`,
  KafkaJS \`idempotent: true\` + \`acks: -1\`, or required acks \`all\` with a hash balancer), so a
  retry of a produce cannot duplicate a record.
- When the broker rejects the produce, write the event to the **outbox** (\`insert_outbox\`) instead
  of dropping it; a relay republishes outbox rows when the broker recovers. The draft ignores the
  broker result entirely.

**Failure mode the checks target.** Keying by job type destroys per-schedule ordering, which is the
only property the ledger needs. Omitting skipped windows hides exactly the pauses an on-call
engineer is looking for. And a produce with no outbox means a broker blip silently deletes the
record of a fire that really happened.`,
  sequence: {
    participants: ['Scheduler API', 'schedule.fired', 'Ledger consumer', 'schedule store'],
    messages: [
      {from: 'Scheduler API', to: 'schedule.fired', label: 'produce · key = schedule_id · acks = all', kind: 'sync'},
      {from: 'schedule.fired', to: 'Scheduler API', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'Scheduler API',
        to: 'schedule store',
        label: 'insert_outbox(schedule_id, event) on rejection',
        kind: 'sync',
      },
      {from: 'schedule.fired', to: 'Ledger consumer', label: 'consume · group run-ledger', kind: 'async'},
      {
        from: 'Ledger consumer',
        to: 'schedule store',
        label: 'append run row {window, decision, outcome}',
        kind: 'sync',
      },
      {from: 'Ledger consumer', to: 'schedule.fired', label: 'commit offset after the append', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'schedule-key',
      title: 'Keyed by schedule id on schedule.fired',
      detail:
        'The event is produced to `schedule.fired` with the **schedule id** as the message key, so one schedule has one partition and an ordered history. The draft keys by job type, scattering the history of every schedule that shares it.',
      match: {
        python: {all: [/key=schedule_id/, /schedule\.fired/]},
        typescript: {all: [/key:\s*scheduleId/, /'schedule\.fired'/]},
        go: {all: [/Key:\s*\[\]byte\(scheduleID\)/, /"schedule\.fired"/]},
        scala: {all: [/ProducerRecord\(Topic,\s*scheduleId/, /"schedule\.fired"/]},
        cpp: {all: [/produce\([^;]*scheduleId/, /"schedule\.fired"/]},
      },
    },
    {
      id: 'skip-published',
      title: 'Skipped and missed windows are published with reasons',
      detail:
        'A skipped window is an event: `skipped` with the `reason` that produced the decision is produced like any other outcome. The draft publishes only successful fires, so a stalled schedule looks idle.',
      match: {
        python: {all: [/"skipped"/, /reason/, /produce\(/]},
        typescript: {all: [/'skipped'/, /reason/, /producer\.send\(/]},
        go: {all: [/skipped/, /Reason/, /WriteMessages\(/]},
        scala: {all: [/skipped/, /reason/, /producer\.send\(/]},
        cpp: {all: [/skipped/, /reason/, /produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Falls back to the outbox when the produce is rejected',
      detail:
        'A rejected produce writes an outbox row (`insert_outbox`/`InsertOutbox`) inside the error branch instead of dropping the event. The draft never looks at the broker result.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /catch\s*\(/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS `idempotent: true` + `acks: -1`, or required acks `all` with a hash balancer. A retry of a produce must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'event-shape',
      title: 'Carries schedule, window, decision and outcome',
      detail:
        'The event payload names `schedule_id`, `window`, `decision` and `outcome` (plus the reason), so a consumer can build a ledger row without guessing. The draft sends a job type and window and leaves the decision out.',
      match: {
        python: {all: [/"schedule_id"/, /"window"/, /"decision"/, /"outcome"/]},
        typescript: {all: [/schedule_id/, /window/, /decision/, /outcome/]},
        go: {all: [/ScheduleID/, /Window/, /Decision/, /Outcome/]},
        scala: {all: [/schedule_id|scheduleId/, /window/, /decision/, /outcome/]},
        cpp: {all: [/schedule_id/, /window/, /decision/, /outcome/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("scheduler")

TOPIC = "schedule.fired"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def publish_fire(schedule: dict, window: int, outcome: str) -> None:
    # TODO: this draft keys by job type, publishes only successful fires so a stalled schedule
    # looks idle, and drops the event when the broker rejects the produce. Review all three.
    event = {
        "job_type": schedule["job_ref"],
        "window": window,
        "outcome": outcome,
    }
    producer.produce(TOPIC, key=schedule["job_ref"], value=json.dumps(event).encode("utf-8"))
    producer.poll(0)
    logger.info("schedule event job_type=%s window=%d", schedule["job_ref"], window)


def publish_run(schedule: dict, windows: list[int]) -> None:
    """Publish the windows that ran; the others did not really happen."""
    for window in windows:
        publish_fire(schedule, window, "fired")
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Producer

logger = logging.getLogger("scheduler")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "schedule.fired"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


def insert_outbox(schedule_id: str, event: dict) -> None:
    """The relay republishes outbox rows when the broker recovers."""
    r.rpush(f"outbox:{schedule_id}", json.dumps(event))


def publish_fire(
    schedule_id: str,
    window: int,
    decision: str,
    outcome: str,
    reason: str,
) -> None:
    """One schedule.fired event per attempt and outcome, keyed by schedule for ordered history."""
    event = {
        "schedule_id": schedule_id,
        "window": window,
        "decision": decision,
        "outcome": outcome,
        "reason": reason,
    }
    try:
        producer.produce(
            TOPIC,
            key=schedule_id,
            value=json.dumps(event).encode("utf-8"),
        )
        producer.poll(0)
    except Exception:
        insert_outbox(schedule_id, event)
        logger.warning(
            "schedule event deferred to the outbox schedule=%s window=%d",
            schedule_id,
            window,
        )
        return
    logger.info(
        "schedule event schedule=%s window=%d decision=%s",
        schedule_id,
        window,
        decision,
    )


def publish_pause(schedule_id: str, windows: list[int], reason: str) -> None:
    """A pause is published window by window: a skipped window is a decision, not an absence."""
    for window in windows:
        publish_fire(schedule_id, window, "skipped", "skipped", reason)


def publish_missed(schedule_id: str, window: int, reason: str) -> None:
    publish_fire(schedule_id, window, "misfire", "missed", reason)
`,
    },
    typescript: {
      starter: `/** A model-generated draft that keys events by job type and only publishes successes. */
import {Kafka} from 'kafkajs';

const TOPIC = 'schedule.fired';

const producer = new Kafka({clientId: 'cron-scheduler', brokers: ['kafka:9092']}).producer();

export async function publishFire(jobType: string, window: number, outcome: string): Promise<void> {
  // TODO: this draft keys by job type, publishes only successful fires so a stalled schedule looks
  // idle, and drops the event when the broker rejects the produce. Review all three.
  await producer.send({
    topic: TOPIC,
    messages: [{key: jobType, value: JSON.stringify({job_type: jobType, window, outcome})}],
  });
}
`,
      solution: `/** schedule.fired keyed by schedule id, idempotent, with an outbox for rejected produces. */
import {insertOutbox} from './store';

import {Kafka} from 'kafkajs';

const TOPIC = 'schedule.fired';

const producer = new Kafka({clientId: 'cron-scheduler', brokers: ['kafka:9092']}).producer({
  idempotent: true,
  acks: -1,
});

interface ScheduleEvent {
  schedule_id: string;
  window: number;
  decision: string;
  outcome: string;
  reason: string;
}

/**
 * One schedule.fired event per attempt and outcome, keyed by the schedule id so a schedule's
 * history stays ordered on one partition.
 */
export async function publishFire(
  scheduleId: string,
  window: number,
  decision: string,
  outcome: string,
  reason: string,
): Promise<void> {
  const event: ScheduleEvent = {schedule_id: scheduleId, window, decision, outcome, reason};
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{key: scheduleId, value: JSON.stringify(event)}],
    });
  } catch (err) {
    await insertOutbox(scheduleId, event);
    throw err;
  }
}

/** A skipped window is a decision, not an absence: publish it with the reason. */
export async function publishSkip(scheduleId: string, window: number, reason: string): Promise<void> {
  await publishFire(scheduleId, window, 'skipped', 'skipped', reason);
}

/** A window the scheduler missed while it was down is published the same way. */
export async function publishMissed(scheduleId: string, window: number, reason: string): Promise<void> {
  await publishFire(scheduleId, window, 'misfire', 'missed', reason);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "schedule.fired"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic}

func PublishFire(ctx context.Context, jobType string, window int64, outcome string) error {
	// TODO: this draft keys by job type, publishes only successful fires so a stalled schedule
	// looks idle, and drops the event when the broker rejects the produce. Review all three.
	value, err := json.Marshal(map[string]any{"job_type": jobType, "window": window, "outcome": outcome})
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(jobType), Value: value})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const topic = "schedule.fired"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	Idempotent:   true,
}

type ScheduleEvent struct {
	ScheduleID string \`json:"schedule_id"\`
	Window     int64  \`json:"window"\`
	Decision   string \`json:"decision"\`
	Outcome    string \`json:"outcome"\`
	Reason     string \`json:"reason"\`
}

// PublishFire writes one schedule.fired event per attempt and outcome, keyed by the schedule id so
// a schedule's history stays ordered on one partition.
func PublishFire(ctx context.Context, scheduleID string, window int64, decision, outcome, reason string) error {
	event := ScheduleEvent{
		ScheduleID: scheduleID,
		Window:     window,
		Decision:   decision,
		Outcome:    outcome,
		Reason:     reason,
	}
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(scheduleID), Value: value}); err != nil {
		InsertOutbox(ctx, event)
		return err
	}
	return nil
}

// PublishSkip states a decision: a skipped window is published like any other outcome.
func PublishSkip(ctx context.Context, scheduleID string, window int64, reason string) error {
	return PublishFire(ctx, scheduleID, window, "skipped", "skipped", reason)
}

// PublishMissed covers a window the scheduler missed while it was down.
func PublishMissed(ctx context.Context, scheduleID string, window int64, reason string) error {
	return PublishFire(ctx, scheduleID, window, "misfire", "missed", reason)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object ScheduleEvents {
  val Topic = "schedule.fired"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer")
  props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer")

  val producer = new KafkaProducer[String, String](props)

  def publishFire(jobType: String, window: Long, outcome: String): Unit = {
    // TODO: this draft keys by job type, publishes only successful fires so a stalled schedule
    // looks idle, and drops the event when the broker rejects the produce. Review all three.
    val event = s"""{"job_type":"$jobType","window":$window,"outcome":"$outcome"}"""
    producer.send(new ProducerRecord(Topic, jobType, event))
    producer.flush()
  }

  def publishRun(windows: List[Long], jobType: String): Unit =
    windows.foreach(window => publishFire(jobType, window, "fired"))
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object ScheduleEvents {
  val Topic = "schedule.fired"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer")
  props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")

  val producer = new KafkaProducer[String, String](props)

  /**
   * One schedule.fired event per attempt and outcome, keyed by the schedule id so a schedule's
   * history stays ordered on one partition.
   */
  def publishFire(scheduleId: String, window: Long, decision: String, outcome: String,
                  reason: String): Unit = {
    val event =
      s"""{"schedule_id":"$scheduleId","window":$window,"decision":"$decision","outcome":"$outcome","reason":"$reason"}"""
    try {
      producer.send(new ProducerRecord(Topic, scheduleId, event))
      producer.flush()
    } catch {
      case _: Exception =>
        insertOutbox(scheduleId, event)
        throw new RuntimeException("schedule event deferred to the outbox")
    }
  }

  /** A skipped window is a decision, not an absence: publish it with the reason. */
  def publishSkip(scheduleId: String, window: Long, reason: String): Unit =
    publishFire(scheduleId, window, "skipped", "skipped", reason)

  /** A window the scheduler missed while it was down is published the same way. */
  def publishMissed(scheduleId: String, window: Long, reason: String): Unit =
    publishFire(scheduleId, window, "misfire", "missed", reason)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>

const std::string kTopic = "schedule.fired";

RdKafka::Producer* producer = nullptr;

std::string eventJson(const std::string& jobType, long window, const std::string& outcome) {
  return std::string("{\\"job_type\\":\\"") + jobType + "\\",\\"window\\":" + std::to_string(window) +
         ",\\"outcome\\":\\"" + outcome + "\\"}";
}

void publishFire(const std::string& jobType, long window, const std::string& outcome) {
  // TODO: this draft keys by job type, publishes only successful fires so a stalled schedule looks
  // idle, and drops the event when the broker rejects the produce. Review all three.
  const std::string event = eventJson(jobType, window, outcome);
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(event.c_str()), event.size(), jobType.c_str(), nullptr);
  producer->poll(0);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <string>

const std::string kTopic = "schedule.fired";

RdKafka::Producer* producer = nullptr;

/** Idempotent producer with acks=all: a retry of a produce cannot duplicate the record. */
void configureProducer() {
  std::string err;
  RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  producer = RdKafka::Producer::create(conf, err);
}

/** The event payload: ids and decisions only, never a job payload. */
std::string eventJson(const std::string& scheduleId, long window, const std::string& decision,
                      const std::string& outcome, const std::string& reason) {
  return std::string("{\\"schedule_id\\":\\"") + scheduleId + "\\",\\"window\\":" + std::to_string(window) +
         ",\\"decision\\":\\"" + decision + "\\",\\"outcome\\":\\"" + outcome + "\\",\\"reason\\":\\"" +
         reason + "\\"}";
}

/**
 * One schedule.fired event per attempt and outcome, keyed by the schedule id so a schedule's
 * history stays ordered on one partition.
 */
void publishFire(const std::string& scheduleId, long window, const std::string& decision,
                 const std::string& outcome, const std::string& reason) {
  const std::string event = eventJson(scheduleId, window, decision, outcome, reason);
  try {
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                      const_cast<char*>(event.c_str()), event.size(), scheduleId.c_str(), nullptr);
    producer->poll(0);
  } catch (const std::exception&) {
    insertOutbox(scheduleId, event);
    throw;
  }
}

/** A skipped window is a decision, not an absence: publish it with the reason. */
void publishSkip(const std::string& scheduleId, long window, const std::string& reason) {
  publishFire(scheduleId, window, "skipped", "skipped", reason);
}

/** A window the scheduler missed while it was down is published the same way. */
void publishMissed(const std::string& scheduleId, long window, const std::string& reason) {
  publishFire(scheduleId, window, "misfire", "missed", reason);
}
`,
    },
  },
  hints: [
    'The message key is the partition key, so `key=schedule_id` (or `Key: []byte(scheduleID)`, `key: scheduleId`, `ProducerRecord(topic, scheduleId, …)`) is what keeps one schedule ordered. Keyed by job type, every schedule that shares the type interleaves into one stream and the ledger cannot reconstruct a single schedule.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer. It needs the same key on every retry, which is the same fix as the schedule key.',
    'The outbox is the durability half: wrap the produce and, when the broker rejects it, insert the event as an outbox row for the relay. Publish the decisions you did not act on as well — `skipped` and `missed` with their reason are the rows an on-call engineer reads first.',
  ],
  debrief: `The interviewer is testing whether the event stream can answer "what did this schedule do?" The draft passes because the demo fires successfully and the broker is up. Four defects are checked: keying by job type instead of schedule, publishing only successes, no idempotent producer, and no outbox when the broker rejects the produce. The subtle one is the omission: a history built from successful fires only is indistinguishable from a healthy idle schedule, which is exactly the state a stalled scheduler is in. Real ledgers also carry a producer sequence number so a duplicate is detectable, and reconcile the outbox against the topic before they mark a window final.`,
};
