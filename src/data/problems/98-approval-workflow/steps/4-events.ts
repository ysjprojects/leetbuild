import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Approval events keyed by request, after the commit',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter is the commit that tells the trail consumers:
\`record_decision(request_id, step_index, actor, decision)\` loads the request (\`store.load\`),
produces \`{request_id, step, actor, decision, why, amount_cents}\` to \`approval.event\` keyed by the
actor with a plain producer (\`acks=1\`), then commits with \`chain.advance\` (step 2, provided) and
answers its outcome. The demo trail fills up; it hides 5 flaws.

**Failure mode the checks target.** One request's events spread over partitions and a consumer reads
step 1 before step 0; the request's text and amount sit in a retained topic; a refused decision is
announced anyway; a lost acknowledgement writes the event twice; a broker error loses it.

- The key is the **request id**.
- The payload is \`{request_id, step, actor, decision, status}\` (\`status\` from the outcome): ids and
  enums only.
- **Commit first**: \`chain.advance\`, then produce only when the outcome says \`advanced\`.
- The producer is **idempotent with \`acks=all\`** (Go uses confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the delivery report at most 2 s; on an error or no report, \`outbox.insert(topic, key,
  payload)\`. The outcome is returned either way.`,
  sequence: {
    participants: ['Approval API', 'Redis', 'approval.event', 'Outbox'],
    messages: [
      {from: 'Approval API', to: 'Redis', label: 'chain.advance(r-1, 0, u-mgr, approved)', kind: 'sync'},
      {from: 'Redis', to: 'Approval API', label: 'advanced · status pending', kind: 'reply'},
      {from: 'Approval API', to: 'approval.event', label: 'produce key = r-1 · idempotent · acks=all', kind: 'sync'},
      {from: 'approval.event', to: 'Approval API', label: 'delivery report within 2 s', kind: 'reply'},
      {from: 'Approval API', to: 'Outbox', label: 'insert(topic, r-1, payload) on error or silence', kind: 'async'},
    ],
  },
  hints: [
    'Approve two steps of one request and look at the partitions: the events sit on two of them, carrying the request’s text. Repeat a stale decision: the chain refuses it, the topic gets it anyway.',
    'The key is the actor, so partition order follows people, not requests; the payload copies the stored request; the produce happens before `chain.advance` and nobody waits for its delivery report.',
    'Call `chain.advance` first and return early unless `advanced`; produce `{request_id, step, actor, decision, status}` with `key=request_id` on an idempotent `acks=all` producer; `flush(2)` with `on_delivery`, and `outbox.insert` on failure.',
  ],
  checks: [
    {
      id: 'request-key',
      title: 'Keys approval.event by the request id',
      detail:
        'Every event of one request carries the request id as its key, so one chain’s events share a partition and arrive in order. The starter keys by the actor.',
      match: {
        python: {all: [/key\s*=\s*request_id/], none: [/key\s*=\s*actor/]},
        typescript: {all: [/key:\s*requestId/], none: [/key:\s*actor/]},
        go: {all: [/Key:\s*\[\]byte\(requestID\)/], none: [/Key:\s*\[\]byte\(actor\)/]},
        scala: {all: [/ProducerRecord\[String,\s*String\]\(Topic,\s*requestId/], none: [/\(Topic,\s*actor/]},
        cpp: {all: [/request_id\.c_str\(\),\s*request_id\.size\(\)/], none: [/actor\.c_str\(\),\s*actor\.size\(\)/]},
      },
    },
    {
      id: 'ids-only',
      title: 'Carries ids and enums, not request content',
      detail:
        'The payload is `{request_id, step, actor, decision, status}`; the request’s `why` and amount stay in the request store, out of a retained, replicated topic.',
      match: {
        python: {all: [/["']status["']\s*:/], none: [/["']why["']/, /amount_cents/]},
        typescript: {all: [/\bstatus:/], none: [/\.why\b|\bwhy:/, /amount_cents/]},
        go: {all: [/"status"/], none: [/\.Why\b/, /AmountCents/]},
        scala: {all: [/"status"/], none: [/\.why\b|"why"/, /amountCents/]},
        cpp: {all: [/"status"/], none: [/\.why\b|"why"/, /amount_cents/]},
      },
    },
    {
      id: 'commit-first',
      title: 'Commits the decision before producing it',
      detail:
        '`chain.advance` runs first and the event is produced only when the outcome says `advanced`: a refused decision, or one that did not commit, is not announced.',
      match: {
        python: {all: [/["']advanced["']/], order: [/chain\.advance\(/, /producer\.produce\(/]},
        typescript: {all: [/\.advanced\b/], order: [/chain\.advance\(/, /producer\.send\(/]},
        go: {all: [/\.Advanced\b/], order: [/chain\.Advance\(/, /producer\.Produce\(/]},
        scala: {all: [/\.advanced\b/], order: [/Chain\.advance\(/, /producer\.send\(/]},
        cpp: {all: [/\.advanced\b/], order: [/chain::advance\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
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
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the key and the payload; the committed decision stands. The starter fires and forgets.',
      match: {
        python: {all: [/outbox\.insert\(/, /on_delivery\s*=/, /\.flush\(/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /TopicPartition\.Error/, /time\.After\(/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*AckTimeoutMs/]},
        cpp: {all: [/outbox::insert\(/, /dr_cb/, /->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from approvals import chain, outbox, store  # chain.advance · outbox.insert(topic, key, payload) · store.load

TOPIC = "approval.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def record_decision(request_id: str, step_index: int, actor: str, decision: str) -> dict:
    """Commit actor's decision on step step_index and tell the trail consumers; answers the chain.advance outcome."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    request = store.load(request_id)
    event = {
        "request_id": request_id,
        "step": step_index,
        "actor": actor,
        "decision": decision,
        "why": request["why"],  # the trail shows what was approved
        "amount_cents": request["amount_cents"],
    }
    producer.produce(TOPIC, key=actor, value=json.dumps(event))
    producer.poll(0)
    return chain.advance(request_id, step_index, actor, decision)
`,
      solution: `import json

from confluent_kafka import Producer

from approvals import chain, outbox  # chain.advance · outbox.insert(topic, key, payload)

TOPIC = "approval.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def record_decision(request_id: str, step_index: int, actor: str, decision: str) -> dict:
    """Commit actor's decision on step step_index and tell the trail consumers; answers the chain.advance outcome."""
    outcome = chain.advance(request_id, step_index, actor, decision)
    if not outcome["advanced"]:
        return outcome  # a refused decision changed nothing: there is nothing to announce
    # Ids and enums only: the request's content stays in the request store.
    event = {"request_id": request_id, "step": step_index, "actor": actor, "decision": decision, "status": outcome["status"]}
    delivery = {}

    def on_delivery(err, msg) -> None:
        delivery["error"] = err

    producer.produce(TOPIC, key=request_id, value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or delivery.get("error") is not None:
        # The broker did not take it: the relay publishes the row later, so the trail is late, not wrong.
        outbox.insert(TOPIC, request_id, event)
    return outcome
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as chain from 'approvals/chain'; // chain.advance
import * as outbox from 'approvals/outbox'; // outbox.insert(topic, key, payload)
import * as store from 'approvals/store'; // store.load

export const TOPIC = 'approval.event';

const kafka = new Kafka({clientId: 'approvals', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Commit actor's decision on step stepIndex and tell the trail consumers; answers the chain.advance outcome. */
export async function recordDecision(requestId: string, stepIndex: number, actor: string, decision: string): Promise<chain.Outcome> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const request = await store.load(requestId);
  const event = {
    request_id: requestId,
    step: stepIndex,
    actor,
    decision,
    why: request?.why, // the trail shows what was approved
    amount_cents: request?.amount_cents,
  };
  void producer.send({topic: TOPIC, messages: [{key: actor, value: JSON.stringify(event)}], acks: 1});
  return chain.advance(requestId, stepIndex, actor, decision);
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as chain from 'approvals/chain'; // chain.advance
import * as outbox from 'approvals/outbox'; // outbox.insert(topic, key, payload)

export const TOPIC = 'approval.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'approvals', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Commit actor's decision on step stepIndex and tell the trail consumers; answers the chain.advance outcome. */
export async function recordDecision(requestId: string, stepIndex: number, actor: string, decision: string): Promise<chain.Outcome> {
  const outcome = await chain.advance(requestId, stepIndex, actor, decision);
  if (!outcome.advanced) return outcome; // a refused decision changed nothing: there is nothing to announce
  // Ids and enums only: the request's content stays in the request store.
  const event = {request_id: requestId, step: stepIndex, actor, decision, status: outcome.status};
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: requestId, value: JSON.stringify(event)}], acks: -1, timeout: ACK_TIMEOUT_MS});
  } catch {
    // The broker did not take it: the relay publishes the row later, so the trail is late, not wrong.
    await outbox.insert(TOPIC, requestId, event);
  }
  return outcome;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"approvals/chain" // chain.Advance; approvals/outbox has outbox.Insert(ctx, topic, key, payload)
	"approvals/store" // store.Load
)

const topic = "approval.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// recordDecision commits actor's decision on step stepIndex and tells the trail consumers; it
// answers the chain.Advance outcome.
func recordDecision(ctx context.Context, requestID string, stepIndex int, actor, decision string) (chain.Outcome, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	request, err := store.Load(ctx, requestID)
	if err != nil || request == nil {
		return chain.Outcome{}, err
	}
	event := map[string]any{
		"request_id":   requestID,
		"step":         stepIndex,
		"actor":        actor,
		"decision":     decision,
		"why":          request.Why, // the trail shows what was approved
		"amount_cents": request.AmountCents,
	}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(actor), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return chain.Outcome{}, err
	}
	return chain.Advance(ctx, requestID, stepIndex, actor, decision)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"approvals/chain"  // chain.Advance
	"approvals/outbox" // outbox.Insert(ctx, topic, key, payload)
)

const (
	topic      = "approval.event"
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

// recordDecision commits actor's decision on step stepIndex and tells the trail consumers; it
// answers the chain.Advance outcome.
func recordDecision(ctx context.Context, requestID string, stepIndex int, actor, decision string) (chain.Outcome, error) {
	outcome, err := chain.Advance(ctx, requestID, stepIndex, actor, decision)
	if err != nil || !outcome.Advanced {
		return outcome, err // a refused decision changed nothing: there is nothing to announce
	}
	// Ids and enums only: the request's content stays in the request store.
	event := map[string]any{"request_id": requestID, "step": stepIndex, "actor": actor, "decision": decision, "status": outcome.Status}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(requestID), Value: value}
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
		// The broker did not take it: the relay publishes the row later, so the trail is late, not wrong.
		if err := outbox.Insert(ctx, topic, requestID, event); err != nil {
			return outcome, err
		}
	}
	return outcome, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import approvals.{Chain, Outbox, Store} // Chain.advance · Outbox.insert(topic, key, payload) · Store.load

object Events {
  val Topic = "approval.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Commit actor's decision on step stepIndex and tell the trail consumers; answers the Chain.advance outcome. */
  def recordDecision(requestId: String, stepIndex: Long, actor: String, decision: String): Chain.Outcome = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val request = Store.load(requestId)
    val event = JsObject(
      "request_id" -> JsString(requestId),
      "step" -> JsNumber(stepIndex),
      "actor" -> JsString(actor),
      "decision" -> JsString(decision),
      "why" -> JsString(request.map(_.why).getOrElse("")), // the trail shows what was approved
      "amount_cents" -> JsNumber(request.map(_.amountCents).getOrElse(0L)))
    producer.send(new ProducerRecord[String, String](Topic, actor, event.compactPrint))
    Chain.advance(requestId, stepIndex, actor, decision)
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import approvals.{Chain, Outbox} // Chain.advance · Outbox.insert(topic, key, payload)

object Events {
  val Topic = "approval.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Commit actor's decision on step stepIndex and tell the trail consumers; answers the Chain.advance outcome. */
  def recordDecision(requestId: String, stepIndex: Long, actor: String, decision: String): Chain.Outcome = {
    val outcome = Chain.advance(requestId, stepIndex, actor, decision)
    if (!outcome.advanced) return outcome // a refused decision changed nothing: there is nothing to announce
    // Ids and enums only: the request's content stays in the request store.
    val event = JsObject(
      "request_id" -> JsString(requestId),
      "step" -> JsNumber(stepIndex),
      "actor" -> JsString(actor),
      "decision" -> JsString(decision),
      "status" -> JsString(outcome.status))
    val record = new ProducerRecord[String, String](Topic, requestId, event.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    // The broker did not take it: the relay publishes the row later, so the trail is late, not wrong.
    if (acked.isFailure) Outbox.insert(Topic, requestId, event)
    outcome
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "approvals/chain.h"   // chain::advance
#include "approvals/outbox.h"  // outbox::insert(topic, key, payload)
#include "approvals/store.h"   // store::load

using json = nlohmann::json;

const std::string kTopic = "approval.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Commit actor's decision on step step_index and tell the trail consumers; answers the chain::advance outcome.
chain::Outcome recordDecision(const std::string& request_id, long step_index, const std::string& actor, const std::string& decision) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto request = store::load(request_id);
  const json event = {{"request_id", request_id},
                      {"step", step_index},
                      {"actor", actor},
                      {"decision", decision},
                      {"why", request ? request->why : ""},  // the trail shows what was approved
                      {"amount_cents", request ? request->amount_cents : 0}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    actor.c_str(), actor.size(), 0, nullptr);
  producer->poll(0);
  return chain::advance(request_id, step_index, actor, decision);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "approvals/chain.h"   // chain::advance
#include "approvals/outbox.h"  // outbox::insert(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "approval.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: recordDecision produces one record and waits for it.
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

// Commit actor's decision on step step_index and tell the trail consumers; answers the chain::advance outcome.
chain::Outcome recordDecision(const std::string& request_id, long step_index, const std::string& actor, const std::string& decision) {
  const chain::Outcome outcome = chain::advance(request_id, step_index, actor, decision);
  if (!outcome.advanced) return outcome;  // a refused decision changed nothing: there is nothing to announce
  // Ids and enums only: the request's content stays in the request store.
  const json event = {{"request_id", request_id}, {"step", step_index}, {"actor", actor}, {"decision", decision}, {"status", outcome.status}};
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), request_id.c_str(), request_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  // The broker did not take it: the relay publishes the row later, so the trail is late, not wrong.
  if (err != RdKafka::ERR_NO_ERROR) outbox::insert(kTopic, request_id, event);
  return outcome;
}
`,
    },
  },
  harness: {
    python: `import json

from approvals import chain, store

TOPIC = "approval.event"
WHY = "offsite for the platform team"


def _events(ctx):
    for request_id, approvers in (("r-1", ["u-mgr", "u-dir", "u-cfo"]), ("r-2", ["u-mgr", "u-dir"])):
        store.put({"request_id": request_id, "tenant": "t-acme", "requester": "u-req", "chain_id": "spend", "chain_version": 3,
                   "approvers": approvers, "why": WHY, "amount_cents": 1250000}, "")
        chain.start_chain(request_id, approvers)
    return ctx.load("events")


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_request_key(ctx):
    m = _events(ctx)
    m.record_decision("r-1", 0, "u-mgr", "approved")
    m.record_decision("r-2", 0, "u-mgr", "approved")
    m.record_decision("r-1", 1, "u-dir", "approved")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three decisions produced {len(records)} records on approval.event (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"r-1", b"r-2", b"r-1"], f"the records are keyed {keys}, expected the request ids r-1, r-2, r-1"
    assert records[0].partition == records[2].partition, "both r-1 events must land on one partition, or a consumer reads step 1 before step 0"


def check_ids_only(ctx):
    m = _events(ctx)
    m.record_decision("r-1", 0, "u-mgr", "approved")
    values = [r.value for r in ctx.kafka.records(TOPIC)]
    assert len(values) == 1, f"one decision produced {len(values)} records"
    assert WHY.encode() not in values[0] and b"1250000" not in values[0], f"the event carries the request's content: {values[0]!r}"
    event = json.loads(values[0])
    expected = {"request_id": "r-1", "step": 0, "actor": "u-mgr", "decision": "approved", "status": "pending"}
    assert event == expected, f"the event is {event}, expected {expected}"


def check_commit_first(ctx):
    m = _events(ctx)
    at_commit = ctx.redis_after("approval:r-1:state", lambda: len(ctx.kafka.records(TOPIC)))
    outcome = m.record_decision("r-1", 0, "u-mgr", "approved")
    assert at_commit.fired, "record_decision never committed the decision (nothing touched approval:r-1:state)"
    assert at_commit.result == 0, f"when the decision was committed the topic already held {at_commit.result} record(s): commit first, then produce"
    assert outcome.get("advanced") is True and len(ctx.kafka.records(TOPIC)) == 1, f"the committed decision {outcome} must still be produced once"
    stale = m.record_decision("r-1", 0, "u-mgr", "approved")
    assert stale.get("advanced") is False, f"a repeated decision answered {stale}"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"a decision the chain refused was announced: the topic holds {len(ctx.kafka.records(TOPIC))} records"


def check_idempotent_acks(ctx):
    m = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.record_decision("r-1", 0, "u-mgr", "approved")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.record_decision("r-1", 1, "u-dir", "approved")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = _events(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    outcome = m.record_decision("r-1", 0, "u-mgr", "approved")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the trail never hears of the decision"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "r-1" and rows[0].get("payload", {}).get("step") == 0, f"the outbox row is {rows[0]}, expected the topic, the key r-1 and the payload"
    assert outcome.get("advanced") is True and ctx.redis.hget("approval:r-1:state", "step_index") == "1", f"the decision must stay committed when only the produce failed, got {outcome}"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    m.record_decision("r-1", 1, "u-dir", "approved")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"record_decision waited {waited:.0f} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("step") == 1, f"no delivery report within the window and the outbox holds {rows}"
`,
    typescript: `const TOPIC = 'approval.event';
const WHY = 'offsite for the platform team';

async function events(ctx) {
  const store = ctx.load('/support/approvals/store.ts');
  const chain = ctx.load('/support/approvals/chain.ts');
  for (const [requestId, approvers] of [['r-1', ['u-mgr', 'u-dir', 'u-cfo']], ['r-2', ['u-mgr', 'u-dir']]] as [string, string[]][]) {
    await store.put({request_id: requestId, tenant: 't-acme', requester: 'u-req', chain_id: 'spend', chain_version: 3, approvers, why: WHY, amount_cents: 1250000}, '');
    await chain.startChain(requestId, approvers);
  }
  return ctx.load('events');
}

const outboxRows = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_request_key(ctx) {
  const m = await events(ctx);
  await m.recordDecision('r-1', 0, 'u-mgr', 'approved');
  await m.recordDecision('r-2', 0, 'u-mgr', 'approved');
  await m.recordDecision('r-1', 1, 'u-dir', 'approved');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three decisions produced \${records.length} records on approval.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['r-1', 'r-2', 'r-1'], \`the records are keyed \${JSON.stringify(keys)}, expected the request ids r-1, r-2, r-1\`);
  assert.equal(records[0].partition, records[2].partition, 'both r-1 events must land on one partition, or a consumer reads step 1 before step 0');
}

export async function check_ids_only(ctx) {
  const m = await events(ctx);
  await m.recordDecision('r-1', 0, 'u-mgr', 'approved');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one decision produced \${values.length} records\`);
  assert(!values[0].includes(WHY) && !values[0].includes('1250000'), \`the event carries the request's content: \${values[0]}\`);
  const expected = {request_id: 'r-1', step: 0, actor: 'u-mgr', decision: 'approved', status: 'pending'};
  assert.deepEqual(JSON.parse(values[0]), expected, \`the event is \${values[0]}, expected \${JSON.stringify(expected)}\`);
}

export async function check_commit_first(ctx) {
  const m = await events(ctx);
  const atCommit = ctx.redisAfter('approval:r-1:state', () => ctx.kafka.records(TOPIC).length);
  const outcome = await m.recordDecision('r-1', 0, 'u-mgr', 'approved');
  await settle();
  assert(atCommit.fired, 'recordDecision never committed the decision (nothing touched approval:r-1:state)');
  assert.equal(atCommit.result, 0, \`when the decision was committed the topic already held \${atCommit.result} record(s): commit first, then produce\`);
  assert(outcome.advanced === true && ctx.kafka.records(TOPIC).length === 1, \`the committed decision \${JSON.stringify(outcome)} must still be produced once\`);
  const stale = await m.recordDecision('r-1', 0, 'u-mgr', 'approved');
  await settle();
  assert.equal(stale.advanced, false, \`a repeated decision answered \${JSON.stringify(stale)}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`a decision the chain refused was announced: the topic holds \${ctx.kafka.records(TOPIC).length} records\`);
}

export async function check_idempotent_acks(ctx) {
  const m = await events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.recordDecision('r-1', 0, 'u-mgr', 'approved');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.recordDecision('r-1', 1, 'u-dir', 'approved');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = await events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const outcome = await m.recordDecision('r-1', 0, 'u-mgr', 'approved');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the trail never hears of the decision\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'r-1' && rows[0].payload?.step === 0, \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key r-1 and the payload\`);
  assert(outcome.advanced === true && ctx.redis.hget('approval:r-1:state', 'step_index') === '1', \`the decision must stay committed when only the produce failed, got \${JSON.stringify(outcome)}\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  await m.recordDecision('r-1', 1, 'u-dir', 'approved');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`recordDecision waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.step === 1, \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"approvals/chain"
	"approvals/store"

	"leetbuild/harness"
)

var eventsBg = context.Background()

const (
	eventsTopic = "approval.event"
	eventsWhy   = "offsite for the platform team"
)

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsSetup(ctx *harness.Ctx) {
	for requestID, approvers := range map[string][]string{"r-1": {"u-mgr", "u-dir", "u-cfo"}, "r-2": {"u-mgr", "u-dir"}} {
		record := &store.Request{RequestID: requestID, Tenant: "t-acme", Requester: "u-req", ChainID: "spend", ChainVersion: 3, Approvers: approvers, Why: eventsWhy, AmountCents: 1250000}
		ctx.NoError(store.Put(eventsBg, record, ""), "store.Put(%s)", requestID)
		ctx.NoError(chain.StartChain(eventsBg, requestID, approvers), "chain.StartChain(%s)", requestID)
	}
}

func eventsDecide(ctx *harness.Ctx, requestID string, step int, actor string) chain.Outcome {
	o, err := recordDecision(eventsBg, requestID, step, actor, "approved")
	ctx.NoError(err, "recordDecision(%s, %d, %s)", requestID, step, actor)
	return o
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

func CheckRequestKey(ctx *harness.Ctx) {
	eventsSetup(ctx)
	eventsDecide(ctx, "r-1", 0, "u-mgr")
	eventsDecide(ctx, "r-2", 0, "u-mgr")
	eventsDecide(ctx, "r-1", 1, "u-dir")
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three decisions must produce three records on approval.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"r-1", "r-2", "r-1"}, "the records must be keyed by the request ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both r-1 events must land on one partition, or a consumer reads step 1 before step 0; the partitions")
}

func CheckIdsOnly(ctx *harness.Ctx) {
	eventsSetup(ctx)
	eventsDecide(ctx, "r-1", 0, "u-mgr")
	ctx.Settle()
	values := ctx.Kafka.Values(eventsTopic)
	ctx.Equal(len(values), 1, "one decision must produce one record; the records")
	ctx.Assert(!strings.Contains(values[0], eventsWhy) && !strings.Contains(values[0], "1250000"), "the event carries the request's content: %s", values[0])
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON")
	ctx.Equal(event, map[string]any{"request_id": "r-1", "step": 0.0, "actor": "u-mgr", "decision": "approved", "status": "pending"}, "the event")
}

func CheckCommitFirst(ctx *harness.Ctx) {
	eventsSetup(ctx)
	atCommit := ctx.Redis.After("approval:r-1:state", func() any { return len(ctx.Kafka.Records(eventsTopic)) })
	outcome := eventsDecide(ctx, "r-1", 0, "u-mgr")
	ctx.Settle()
	ctx.Assert(atCommit.Fired, "recordDecision never committed the decision (nothing touched approval:r-1:state)")
	ctx.Equal(atCommit.Result, 0, "commit first, then produce; the records on the topic when the decision was committed")
	ctx.Assert(outcome.Advanced && len(ctx.Kafka.Records(eventsTopic)) == 1, "the committed decision %+v must still be produced once", outcome)
	stale := eventsDecide(ctx, "r-1", 0, "u-mgr")
	ctx.Settle()
	ctx.Assert(!stale.Advanced, "a repeated decision answered %+v", stale)
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "a decision the chain refused must not be announced; the records")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	eventsSetup(ctx)
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsDecide(ctx, "r-1", 0, "u-mgr")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsDecide(ctx, "r-1", 1, "u-dir")
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	eventsSetup(ctx)
	ctx.Kafka.FailNext(eventsTopic, 1)
	outcome := eventsDecide(ctx, "r-1", 0, "u-mgr")
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the trail never hears of the decision; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "r-1" && rows[0].Payload["step"] == 0.0, "the outbox row is %+v, expected the topic, the key r-1 and the payload", rows[0])
	index, _ := ctx.Redis.HGet("approval:r-1:state", "step_index")
	ctx.Assert(outcome.Advanced && index == "1", "the decision must stay committed when only the produce failed, got %+v", outcome)
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	eventsDecide(ctx, "r-1", 1, "u-dir")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "recordDecision waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["step"] == 1.0, "no delivery report within the window and the outbox holds %+v", rows)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "approvals/chain.h"
#include "approvals/store.h"

namespace {

const std::string kEventsTopic = "approval.event";
const std::string kWhy = "offsite for the platform team";

void eventsSetup() {
  const std::vector<std::pair<std::string, std::vector<std::string>>> requests = {{"r-1", {"u-mgr", "u-dir", "u-cfo"}}, {"r-2", {"u-mgr", "u-dir"}}};
  for (const auto& [request_id, approvers] : requests) {
    store::put(store::Request{request_id, "t-acme", "u-req", "spend", 3, approvers, kWhy, 1250000}, "");
    chain::startChain(request_id, approvers);
  }
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

long payloadStep(const nlohmann::json& row) {
  return row.contains("payload") && row["payload"].is_object() ? row["payload"].value("step", -1L) : -1L;
}

}  // namespace

void CheckRequestKey(harness::Ctx& ctx) {
  eventsSetup();
  recordDecision("r-1", 0, "u-mgr", "approved");
  recordDecision("r-2", 0, "u-mgr", "approved");
  recordDecision("r-1", 1, "u-dir", "approved");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three decisions must produce three records on approval.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"r-1", "r-2", "r-1"}, "the records must be keyed by the request ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both r-1 events must land on one partition, or a consumer reads step 1 before step 0; the partitions");
}

void CheckIdsOnly(harness::Ctx& ctx) {
  eventsSetup();
  recordDecision("r-1", 0, "u-mgr", "approved");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kEventsTopic);
  ctx.Equal(values.size(), 1, "one decision must produce one record; the records");
  ctx.Assert(values[0].find(kWhy) == std::string::npos && values[0].find("1250000") == std::string::npos, "the event carries the request's content: %s", values[0]);
  const nlohmann::json expected = {{"request_id", "r-1"}, {"step", 0}, {"actor", "u-mgr"}, {"decision", "approved"}, {"status", "pending"}};
  ctx.Equal(nlohmann::json::parse(values[0], nullptr, false), expected, "the event");
}

void CheckCommitFirst(harness::Ctx& ctx) {
  eventsSetup();
  auto atCommit = std::make_shared<long>(-1);
  ctx.Redis.After("approval:r-1:state", [&ctx, atCommit] { *atCommit = static_cast<long>(ctx.Kafka.Records(kEventsTopic).size()); });
  const chain::Outcome outcome = recordDecision("r-1", 0, "u-mgr", "approved");
  ctx.Settle();
  ctx.Assert(*atCommit >= 0, "recordDecision never committed the decision (nothing touched approval:r-1:state)");
  ctx.Equal(*atCommit, 0, "commit first, then produce; the records on the topic when the decision was committed");
  ctx.Assert(outcome.advanced && ctx.Kafka.Records(kEventsTopic).size() == 1, "the committed decision must still be produced once (advanced %t, records %d)", outcome.advanced, ctx.Kafka.Records(kEventsTopic).size());
  const chain::Outcome stale = recordDecision("r-1", 0, "u-mgr", "approved");
  ctx.Settle();
  ctx.Assert(!stale.advanced, "a repeated decision answered advanced true");
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "a decision the chain refused must not be announced; the records");
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  eventsSetup();
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  recordDecision("r-1", 0, "u-mgr", "approved");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  recordDecision("r-1", 1, "u-dir", "approved");
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  eventsSetup();
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const chain::Outcome outcome = recordDecision("r-1", 0, "u-mgr", "approved");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the trail never hears of the decision; the rows");
  ctx.Assert(rows[0].value("topic", "") == kEventsTopic && rows[0].value("key", "") == "r-1" && payloadStep(rows[0]) == 0, "the outbox row is %s, expected the topic, the key r-1 and the payload", rows[0].dump());
  ctx.Assert(outcome.advanced && ctx.Redis.HGet("approval:r-1:state", "step_index") == std::optional<std::string>("1"), "the decision must stay committed when only the produce failed");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  recordDecision("r-1", 1, "u-dir", "approved");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "recordDecision waited %.0f s for a broker that does not answer: wait for the report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && payloadStep(rows[1]) == 1, "no delivery report within the window and the outbox holds %d rows", rows.size());
}
`,
  },
  debrief: `An event is a statement about state that already exists, so the commit comes first and only a decision that moved the chain is announced; a refused double click stays a non-event. The key is the request because order matters within one chain and nowhere else. The payload stops at ids and enums because the topic is retained and replicated beyond the request store's access rules, and a consumer that needs the text can ask the store. Waiting for the delivery report is what lets the outbox catch a broker error, and idempotence closes the gap the retry opens. Production systems write the outbox row in the same transaction as the state change, which removes the window where a crash loses both the event and the row.`,
};
