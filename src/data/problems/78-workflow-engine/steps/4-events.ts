import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'workflow.step events keyed by run id, through an outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['worker', 'kafka', 'ledger'],
  task: `## Task

**Starting point.** \`publish_step(run, step, outcome)\` tells the audit consumers that a step of a
run (the record \`runs.get\` returns) reached \`outcome\`: it produces
\`{run_id, workflow, step, "outcome": "done", input}\` to \`workflow.step\` keyed by the step name,
from a producer with \`acks=1\`, and returns \`True\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** An auditor replaying one run finds its events spread over
several partitions in no order, cannot tell a started step from a finished one, reads the
customer's input on a topic kept for days, and misses the transitions lost to a broker outage, a
lost acknowledgement or a leader failover.

- Key every event by the run id.
- The value is \`{run_id, workflow, step, effect_id, outcome}\`, \`effect_id\` = \`"{run_id}:{step}"\`.
- \`outcome\` is one of \`OUTCOMES\` (\`started\`, \`succeeded\`, \`failed\`; the same name in each
  language's casing); anything else raises before anything is written or produced.
- An idempotent producer with \`acks=all\`.
- \`outbox.insert(event_id, topic, key, event)\` (\`event_id\` = \`"{run_id}:{step}:{outcome}"\`)
  before the produce; wait at most 2 s for the delivery report; acknowledged →
  \`outbox.remove(event_id)\` and \`True\`, otherwise \`False\` and the row stays.`,
  sequence: {
    participants: ['Worker', 'Outbox (Redis)', 'workflow.step', 'Audit consumer'],
    messages: [
      {from: 'Worker', to: 'Outbox (Redis)', label: 'insert(r1:send_welcome:started, …)', kind: 'sync'},
      {from: 'Worker', to: 'workflow.step', label: 'produce key = r1 · idempotent · acks=all', kind: 'sync'},
      {from: 'workflow.step', to: 'Worker', label: 'delivery report within 2 s', kind: 'reply'},
      {from: 'Worker', to: 'Outbox (Redis)', label: 'acknowledged → remove · else the row stays', kind: 'sync'},
      {from: 'workflow.step', to: 'Audit consumer', label: "one partition holds all of r1's history", kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'key-run',
      title: 'Keys every event by run id',
      detail:
        "Events for r1, r2, r1 are keyed `r1`, `r2`, `r1` and both r1 events share a partition. The starter keys by step name, which spreads one run's history over unordered partitions.",
      match: {
        python: {all: [/key\s*=\s*(run_id|run\[["']run_id["']\])/], none: [/key\s*=\s*step\b/]},
        typescript: {all: [/key:\s*(runId|run\.run_id)/], none: [/key:\s*step\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*run\.RunID\s*\)/]},
        cpp: {all: [/run\.run_id\.c_str\(\)\s*,\s*run\.run_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'outcome',
      title: 'Publishes the outcome it was given, from a fixed set',
      detail:
        'A `started` then a `succeeded` publish produce those two outcomes; an outcome outside `OUTCOMES` raises, produces nothing and leaves no outbox row. The starter writes `done` for everything.',
      match: {
        python: {all: [/OUTCOMES/, /"succeeded"/], none: [/["']done["']/]},
        typescript: {all: [/OUTCOMES/, /'succeeded'/], none: [/["']done["']/]},
        go: {all: [/\boutcomes\b/, /"succeeded"/], none: [/"done"/]},
        cpp: {all: [/kOutcomes/, /"succeeded"/], none: [/"done"/]},
      },
    },
    {
      id: 'no-input',
      title: 'Carries ids and names, not the input',
      detail:
        "The value is exactly `run_id`, `workflow`, `step`, `effect_id` and `outcome`; the customer's email from the run's input appears nowhere. The starter copies the input onto a topic retained for days.",
      match: {
        python: {all: [/effect_id/], none: [/run\[["']input["']\]/]},
        typescript: {all: [/effect_id/], none: [/run\.input/]},
        go: {all: [/"effect_id"/], none: [/run\.Input/]},
        cpp: {all: [/"effect_id"/], none: [/run\.input/]},
      },
    },
    {
      id: 'acks',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'After a lost acknowledgement the topic holds the event once, and a leader failover keeps every acknowledged event. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Keeps an outbox row until the broker acknowledges',
      detail:
        'The row, stored under the event id (`r1:create_account:succeeded`), is in the outbox before the event reaches the topic. An acknowledged event leaves the outbox empty and returns true; a failed delivery, or no report within 2 s, returns false and leaves the row with the topic, the key and the event. The starter returns true and keeps nothing.',
      match: {
        python: {
          all: [/on_delivery\s*=/, /producer\.flush\(/, /outbox\.remove\(/],
          order: [/outbox\.insert\(/, /producer\.produce\(/],
        },
        typescript: {all: [/outbox\.remove\(/, /catch/], order: [/outbox\.insert\(/, /producer\.send\(/]},
        go: {all: [/TopicPartition\.Error/, /outbox\.Remove\(/], order: [/outbox\.Insert\(/, /producer\.Produce\(/]},
        cpp: {all: [/dr_cb/, /outbox::remove\(/], order: [/outbox::insert\(/, /producer->produce\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from workflow import outbox  # outbox.insert(event_id, topic, key, payload), outbox.remove(event_id)

TOPIC = "workflow.step"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_step(run: dict, step: str, outcome: str) -> bool:
    """Tell the audit consumers that step of the run reached outcome; True once the broker has the event."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    event = {"run_id": run["run_id"], "workflow": run["workflow"], "step": step, "outcome": "done", "input": run["input"]}
    producer.produce(TOPIC, key=step, value=json.dumps(event))
    producer.poll(0)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from workflow import outbox  # outbox.insert(event_id, topic, key, payload), outbox.remove(event_id)

TOPIC = "workflow.step"
OUTCOMES = ("started", "succeeded", "failed")
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the event before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def publish_step(run: dict, step: str, outcome: str) -> bool:
    """Tell the audit consumers that step of the run reached outcome; True once the broker has the event."""
    if outcome not in OUTCOMES:
        raise ValueError(f"unknown outcome {outcome!r}, expected one of {OUTCOMES}")
    run_id = run["run_id"]
    # Ids and names only: the run's input stays in the run store, off a topic retained for days.
    event = {"run_id": run_id, "workflow": run["workflow"], "step": step, "effect_id": f"{run_id}:{step}", "outcome": outcome}
    event_id = f"{run_id}:{step}:{outcome}"
    # The row lands first: if the broker never takes the event, the relay publishes it later.
    outbox.insert(event_id, TOPIC, run_id, event)
    report = {}

    def on_delivery(err, msg) -> None:
        report["error"] = err

    producer.produce(TOPIC, key=run_id, value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or report.get("error") is not None:
        return False
    outbox.remove(event_id)
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as outbox from 'workflow/outbox'; // insert(eventId, topic, key, payload), remove(eventId)
import type {Run} from 'workflow/runs';

export const TOPIC = 'workflow.step';

const kafka = new Kafka({clientId: 'workflowd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Tell the audit consumers that step of the run reached outcome; true once the broker has the event. */
export async function publishStep(run: Run, step: string, outcome: string): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const event = {run_id: run.run_id, workflow: run.workflow, step, outcome: 'done', input: run.input};
  await producer.send({topic: TOPIC, messages: [{key: step, value: JSON.stringify(event)}], acks: 1});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as outbox from 'workflow/outbox'; // insert(eventId, topic, key, payload), remove(eventId)
import type {Run} from 'workflow/runs';

export const TOPIC = 'workflow.step';
export const OUTCOMES = ['started', 'succeeded', 'failed'];
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'workflowd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Tell the audit consumers that step of the run reached outcome; true once the broker has the event. */
export async function publishStep(run: Run, step: string, outcome: string): Promise<boolean> {
  if (!OUTCOMES.includes(outcome)) throw new Error(\`unknown outcome \${outcome}, expected one of \${OUTCOMES.join(', ')}\`);
  const runId = run.run_id;
  // Ids and names only: the run's input stays in the run store, off a topic retained for days.
  const event = {run_id: runId, workflow: run.workflow, step, effect_id: \`\${runId}:\${step}\`, outcome};
  const eventId = \`\${runId}:\${step}:\${outcome}\`;
  // The row lands first: if the broker never takes the event, the relay publishes it later.
  await outbox.insert(eventId, TOPIC, runId, event);
  try {
    // acks: -1 (all): every in-sync replica has the event before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: runId, value: JSON.stringify(event)}], acks: -1, timeout: ACK_TIMEOUT_MS});
  } catch {
    return false;
  }
  await outbox.remove(eventId);
  return true;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"workflow/runs" // runs.Run
)

const topic = "workflow.step"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

// publishStep tells the audit consumers that step of the run reached outcome; true once the broker
// has the event. The outbox is the package workflow/outbox: outbox.Insert(ctx, eventID, topic, key,
// payload) error, outbox.Remove(ctx, eventID) error.
func publishStep(ctx context.Context, run *runs.Run, step, outcome string) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(map[string]any{"run_id": run.RunID, "workflow": run.Workflow, "step": step, "outcome": "done", "input": run.Input})
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(step), Value: value}
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
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"workflow/outbox" // outbox.Insert(ctx, eventID, topic, key, payload) error, outbox.Remove(ctx, eventID) error
	"workflow/runs"   // runs.Run
)

const (
	topic      = "workflow.step"
	ackTimeout = 2 * time.Second
)

var outcomes = map[string]bool{"started": true, "succeeded": true, "failed": true}

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

// publishStep tells the audit consumers that step of the run reached outcome; true once the broker
// has the event.
func publishStep(ctx context.Context, run *runs.Run, step, outcome string) (bool, error) {
	if !outcomes[outcome] {
		return false, fmt.Errorf("unknown outcome %q, expected started, succeeded or failed", outcome)
	}
	// Ids and names only: the run's input stays in the run store, off a topic retained for days.
	event := map[string]any{"run_id": run.RunID, "workflow": run.Workflow, "step": step, "effect_id": run.RunID + ":" + step, "outcome": outcome}
	eventID := run.RunID + ":" + step + ":" + outcome
	// The row lands first: if the broker never takes the event, the relay publishes it later.
	if err := outbox.Insert(ctx, eventID, topic, run.RunID, event); err != nil {
		return false, err
	}
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(run.RunID), Value: value}
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
		return false, nil // the row stays for the relay
	}
	return true, outbox.Remove(ctx, eventID)
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "workflow/outbox.h"  // outbox::insert(event_id, topic, key, payload), outbox::remove(event_id)
#include "workflow/runs.h"    // runs::Run

using json = nlohmann::json;

const std::string kTopic = "workflow.step";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Tell the audit consumers that step of the run reached outcome; true once the broker has the event.
bool publishStep(const runs::Run& run, const std::string& step, const std::string& outcome) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const json event = {{"run_id", run.run_id}, {"workflow", run.workflow}, {"step", step}, {"outcome", "done"}, {"input", run.input}};
  const std::string value = event.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                    step.c_str(), step.size(), 0, nullptr);
  producer->poll(0);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <set>
#include <stdexcept>
#include <string>

#include "workflow/outbox.h"  // outbox::insert(event_id, topic, key, payload), outbox::remove(event_id)
#include "workflow/runs.h"    // runs::Run

using json = nlohmann::json;

const std::string kTopic = "workflow.step";
const std::set<std::string> kOutcomes = {"started", "succeeded", "failed"};
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the event in flight: publishStep produces one event and waits for it.
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
  conf->set("acks", "all", err);                // every in-sync replica has the event before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Tell the audit consumers that step of the run reached outcome; true once the broker has the event.
bool publishStep(const runs::Run& run, const std::string& step, const std::string& outcome) {
  if (kOutcomes.count(outcome) == 0) throw std::invalid_argument("unknown outcome " + outcome + ", expected started, succeeded or failed");
  // Ids and names only: the run's input stays in the run store, off a topic retained for days.
  const json event = {{"run_id", run.run_id}, {"workflow", run.workflow}, {"step", step}, {"effect_id", run.run_id + ":" + step}, {"outcome", outcome}};
  const std::string event_id = run.run_id + ":" + step + ":" + outcome;
  // The row lands first: if the broker never takes the event, the relay publishes it later.
  outbox::insert(event_id, kTopic, run.run_id, event);
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), run.run_id.c_str(), run.run_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) return false;  // the row stays for the relay
  outbox::remove(event_id);
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

TOPIC = "workflow.step"
EXPECTED = {"run_id": "r1", "workflow": "signup", "step": "send_welcome", "effect_id": "r1:send_welcome", "outcome": "started"}


def _run(run_id="r1"):
    return {
        "run_id": run_id,
        "tenant": "t1",
        "workflow": "signup",
        "definition_version": 3,
        "pinned_steps": ["create_account", "send_welcome"],
        "input": {"email": "ada@example.com"},
        "max_steps": 50,
        "started_at": 1000,
    }


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.hgetall("outbox").values()]


def check_key_run(ctx):
    m = ctx.load("events")
    m.publish_step(_run("r1"), "create_account", "succeeded")
    m.publish_step(_run("r2"), "create_account", "succeeded")
    m.publish_step(_run("r1"), "send_welcome", "started")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_step calls produced {len(records)} records on workflow.step (topics: {sorted(ctx.kafka.topics)})"
    keys = [r.key for r in records]
    assert keys == [b"r1", b"r2", b"r1"], f"the records are keyed {keys}, expected the run ids r1, r2, r1"
    assert records[0].partition == records[2].partition, "both r1 events must land on one partition, or the auditor reads r1's history out of order"


def check_outcome(ctx):
    m = ctx.load("events")
    m.publish_step(_run(), "send_welcome", "started")
    m.publish_step(_run(), "send_welcome", "succeeded")
    outcomes = [json.loads(r.value).get("outcome") for r in ctx.kafka.records(TOPIC)]
    assert outcomes == ["started", "succeeded"], f"publishing started then succeeded produced the outcomes {outcomes}: the auditor cannot tell a running step from a finished one"
    try:
        m.publish_step(_run(), "send_welcome", "done")
    except Exception:
        pass
    else:
        raise AssertionError("publish_step accepted the outcome 'done', which is not in OUTCOMES")
    assert len(ctx.kafka.records(TOPIC)) == 2, "an unknown outcome must be refused before anything is produced"
    assert _outbox(ctx) == [], f"the refused outcome 'done' left the outbox row {_outbox(ctx)}: the relay would publish it. Refuse it before anything is written"


def check_no_input(ctx):
    m = ctx.load("events")
    m.publish_step(_run(), "send_welcome", "started")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one publish_step produced {len(records)} records"
    raw = records[0].value.decode() if isinstance(records[0].value, bytes) else records[0].value
    assert "ada@example.com" not in raw, f"the event carries the run's input: {raw}. The topic keeps it for days after the run store deletes it"
    value = json.loads(raw)
    assert value == EXPECTED, f"the event is {value}, expected exactly {EXPECTED}"


def check_acks(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_step(_run(), "create_account", "succeeded")
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_step(_run(), "send_welcome", "started")
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost an event the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox(ctx):
    m = ctx.load("events")
    # The moment the outbox is first written, the event must not be on the topic yet.
    seen = ctx.redis_after("outbox", lambda: (len(ctx.kafka.records(TOPIC)), sorted(ctx.redis.hkeys("outbox"))))
    ok = m.publish_step(_run(), "create_account", "succeeded")
    assert ok is True, f"publish_step returned {ok!r} for an acknowledged event, expected True"
    assert _outbox(ctx) == [], f"the broker acknowledged the event and the outbox still holds {_outbox(ctx)}: the relay would publish it again"
    assert seen.fired, "an acknowledged publish never wrote its outbox row: a crash between the produce and the acknowledgement loses the transition"
    if seen.error is not None:
        raise seen.error
    produced, fields = seen.result
    assert produced == 0 and fields == ["r1:create_account:succeeded"], f"when the outbox was first written the topic held {produced} records and the outbox the rows {fields}, expected no record yet and the one row r1:create_account:succeeded (the event id): the row goes in before the produce"
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_step(_run(), "send_welcome", "started")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the transition is gone from the history"
    row = rows[0]
    started = {**EXPECTED, "outcome": "started"}
    assert row.get("topic") == TOPIC and row.get("key") == "r1" and row.get("payload") == started, f"the outbox row is {row}, expected the topic, the key r1 and the event {started}"
    fields = sorted(ctx.redis.hkeys("outbox"))
    assert fields == ["r1:send_welcome:started"], f"the outbox row is stored under {fields}, expected the event id r1:send_welcome:started"
    assert ok is False, f"publish_step returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_step(_run(), "send_welcome", "succeeded")
    waited = ctx.clock.time() - before
    assert waited <= 2.5, f"publish_step waited {waited:.1f} s for a broker that does not answer: wait for the report at most 2 s"
    assert len(_outbox(ctx)) == 2, f"no acknowledgement within the window and the outbox holds {_outbox(ctx)}"
    assert ok is False, f"publish_step returned {ok!r} without an acknowledgement, expected False"
`,
    typescript: `const TOPIC = 'workflow.step';
const EXPECTED = {run_id: 'r1', workflow: 'signup', step: 'send_welcome', effect_id: 'r1:send_welcome', outcome: 'started'};

const run = (runId = 'r1') => ({
  run_id: runId,
  tenant: 't1',
  workflow: 'signup',
  definition_version: 3,
  pinned_steps: ['create_account', 'send_welcome'],
  input: {email: 'ada@example.com'},
  max_steps: 50,
  started_at: 1000,
});

const outboxRows = ctx => Object.values(ctx.redis.hgetall('outbox') as Record<string, string>).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** What publishStep resolved, or the message it rejected with. */
async function publish(m, runId: string, step: string, outcome: string): Promise<unknown> {
  try {
    return await m.publishStep(run(runId), step, outcome);
  } catch (e) {
    return \`rejected: \${(e as Error).message}\`;
  }
}

export async function check_key_run(ctx) {
  const m = ctx.load('events');
  await publish(m, 'r1', 'create_account', 'succeeded');
  await publish(m, 'r2', 'create_account', 'succeeded');
  await publish(m, 'r1', 'send_welcome', 'started');
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishStep calls produced \${records.length} records on workflow.step\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['r1', 'r2', 'r1'], \`the records are keyed \${JSON.stringify(keys)}, expected the run ids r1, r2, r1\`);
  assert.equal(records[0].partition, records[2].partition, "both r1 events must land on one partition, or the auditor reads r1's history out of order");
}

export async function check_outcome(ctx) {
  const m = ctx.load('events');
  await publish(m, 'r1', 'send_welcome', 'started');
  await publish(m, 'r1', 'send_welcome', 'succeeded');
  await settle();
  const outcomes = ctx.kafka.values(TOPIC).map(v => JSON.parse(v).outcome);
  assert.deepEqual(outcomes, ['started', 'succeeded'], \`publishing started then succeeded produced the outcomes \${JSON.stringify(outcomes)}: the auditor cannot tell a running step from a finished one\`);
  const refused = await publish(m, 'r1', 'send_welcome', 'done');
  assert(typeof refused === 'string' && refused.startsWith('rejected'), "publishStep accepted the outcome 'done', which is not in OUTCOMES");
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'an unknown outcome must be refused before anything is produced');
  assert.deepStrictEqual(outboxRows(ctx), [], \`the refused outcome 'done' left the outbox rows \${JSON.stringify(outboxRows(ctx))}: the relay would publish it. Refuse it before anything is written\`);
}

export async function check_no_input(ctx) {
  const m = ctx.load('events');
  await publish(m, 'r1', 'send_welcome', 'started');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`one publishStep produced \${values.length} records\`);
  assert(!values[0].includes('ada@example.com'), \`the event carries the run's input: \${values[0]}. The topic keeps it for days after the run store deletes it\`);
  assert.deepStrictEqual(JSON.parse(values[0]), EXPECTED, \`the event is \${values[0]}, expected exactly \${JSON.stringify(EXPECTED)}\`);
}

export async function check_acks(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await publish(m, 'r1', 'create_account', 'succeeded');
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await publish(m, 'r1', 'send_welcome', 'started');
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost an event the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox(ctx) {
  const m = ctx.load('events');
  // The moment the outbox is first written, the event must not be on the topic yet.
  const seen = ctx.redisAfter('outbox', () => [ctx.kafka.records(TOPIC).length, Object.keys(ctx.redis.hgetall('outbox')).sort()]);
  let ok = await publish(m, 'r1', 'create_account', 'succeeded');
  assert.equal(ok, true, \`publishStep resolved \${JSON.stringify(ok)} for an acknowledged event, expected true\`);
  assert.deepStrictEqual(outboxRows(ctx), [], \`the broker acknowledged the event and the outbox still holds \${JSON.stringify(outboxRows(ctx))}: the relay would publish it again\`);
  assert(seen.fired, 'an acknowledged publish never wrote its outbox row: a crash between the produce and the acknowledgement loses the transition');
  if (seen.error !== undefined) throw seen.error;
  const [produced, fields] = await seen.result;
  assert(
    produced === 0 && JSON.stringify(fields) === JSON.stringify(['r1:create_account:succeeded']),
    \`when the outbox was first written the topic held \${produced} records and the outbox the rows \${JSON.stringify(fields)}, expected no record yet and the one row r1:create_account:succeeded (the event id): the row goes in before the produce\`,
  );
  ctx.kafka.failNext(TOPIC, 1);
  ok = await publish(m, 'r1', 'send_welcome', 'started');
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the transition is gone from the history\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'r1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic \${TOPIC} and the key r1\`);
  assert.deepStrictEqual(rows[0].payload, EXPECTED, \`the outbox row holds the event \${JSON.stringify(rows[0].payload)}, expected exactly \${JSON.stringify(EXPECTED)}\`);
  const ids = Object.keys(ctx.redis.hgetall('outbox'));
  assert.deepStrictEqual(ids, ['r1:send_welcome:started'], \`the outbox row is stored under \${JSON.stringify(ids)}, expected the event id r1:send_welcome:started\`);
  assert.equal(ok, false, \`publishStep resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await publish(m, 'r1', 'send_welcome', 'succeeded');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 2.5, \`publishStep waited \${waited.toFixed(1)} s for a broker that does not answer: wait for the report at most 2 s\`);
  rows = outboxRows(ctx);
  assert.equal(rows.length, 2, \`no acknowledgement within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishStep resolved \${JSON.stringify(ok)} without an acknowledgement, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"workflow/runs"

	"leetbuild/harness"
)

const kHEventsTopic = "workflow.step"

var hEventsBg = context.Background()

var hEventsExpected = map[string]any{"run_id": "r1", "workflow": "signup", "step": "send_welcome", "effect_id": "r1:send_welcome", "outcome": "started"}

func hEventsRun(runID string) *runs.Run {
	return &runs.Run{
		RunID: runID, Tenant: "t1", Workflow: "signup", DefinitionVersion: 3, PinnedSteps: []string{"create_account", "send_welcome"},
		Input: map[string]any{"email": "ada@example.com"}, MaxSteps: 50, StartedAt: 1000,
	}
}

func hEventsPublish(runID, step, outcome string) (bool, error) {
	return publishStep(hEventsBg, hEventsRun(runID), step, outcome)
}

type HEventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func hEventsOutbox(ctx *harness.Ctx) []HEventsRow {
	rows := []HEventsRow{}
	for _, text := range ctx.Redis.HGetAll("outbox") {
		var row HEventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckKeyRun(ctx *harness.Ctx) {
	hEventsPublish("r1", "create_account", "succeeded")
	hEventsPublish("r2", "create_account", "succeeded")
	hEventsPublish("r1", "send_welcome", "started")
	ctx.Settle()
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Equal(len(records), 3, "three publishStep calls must produce three records on workflow.step; the records")
	ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), []string{"r1", "r2", "r1"}, "the records must be keyed by the run ids")
	ctx.Equal(records[0].Partition, records[2].Partition, "both r1 events must land on one partition, or the auditor reads r1's history out of order; the partitions")
}

func CheckOutcome(ctx *harness.Ctx) {
	hEventsPublish("r1", "send_welcome", "started")
	hEventsPublish("r1", "send_welcome", "succeeded")
	ctx.Settle()
	var outcomes []any
	for _, v := range ctx.Kafka.Values(kHEventsTopic) {
		var event map[string]any
		json.Unmarshal([]byte(v), &event)
		outcomes = append(outcomes, event["outcome"])
	}
	ctx.Equal(outcomes, []any{"started", "succeeded"}, "publishing started then succeeded (otherwise the auditor cannot tell a running step from a finished one); the outcomes")
	_, err := hEventsPublish("r1", "send_welcome", "done")
	ctx.Assert(err != nil, "publishStep accepted the outcome \\"done\\", which is not in outcomes")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 2, "an unknown outcome must be refused before anything is produced; the records")
	ctx.Equal(len(hEventsOutbox(ctx)), 0, "the refused outcome \\"done\\" must leave no outbox row (the relay would publish it); the rows")
}

func CheckNoInput(ctx *harness.Ctx) {
	hEventsPublish("r1", "send_welcome", "started")
	ctx.Settle()
	values := ctx.Kafka.Values(kHEventsTopic)
	ctx.Equal(len(values), 1, "one publishStep must produce one record; the records")
	ctx.Assert(!strings.Contains(values[0], "ada@example.com"), "the event carries the run's input: %s. The topic keeps it for days after the run store deletes it", values[0])
	var event map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &event), "the event must be JSON")
	ctx.Equal(event, hEventsExpected, "the event")
}

func CheckAcks(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(kHEventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	hEventsPublish("r1", "create_account", "succeeded")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	hEventsPublish("r1", "send_welcome", "started")
	ctx.Settle()
	ctx.Kafka.Failover(kHEventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records")
}

func hEventsRowIDs(ctx *harness.Ctx) []string {
	ids := []string{}
	for id := range ctx.Redis.HGetAll("outbox") {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

type HEventsSeen struct {
	produced int
	ids      []string
}

func CheckOutbox(ctx *harness.Ctx) {
	// The moment the outbox is first written, the event must not be on the topic yet.
	seen := ctx.Redis.After("outbox", func() any {
		return HEventsSeen{len(ctx.Kafka.Records(kHEventsTopic)), hEventsRowIDs(ctx)}
	})
	ok, err := hEventsPublish("r1", "create_account", "succeeded")
	ctx.NoError(err, "publishStep failed for a healthy broker")
	ctx.Equal(ok, true, "publishStep's result for an acknowledged event")
	ctx.Equal(len(hEventsOutbox(ctx)), 0, "the broker acknowledged the event, so the outbox must be empty (the relay would publish it again); the rows")
	ctx.Assert(seen.Fired, "an acknowledged publish never wrote its outbox row: a crash between the produce and the acknowledgement loses the transition")
	first, _ := seen.Result.(HEventsSeen)
	ctx.Assert(first.produced == 0 && strings.Join(first.ids, ",") == "r1:create_account:succeeded", "when the outbox was first written the topic held %d records and the outbox the rows %q, expected no record yet and the one row r1:create_account:succeeded (the event id): the row goes in before the produce", first.produced, first.ids)
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	ok, _ = hEventsPublish("r1", "send_welcome", "started")
	ctx.Settle()
	rows := hEventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the transition is gone from the history; the rows")
	ctx.Assert(rows[0].Topic == kHEventsTopic && rows[0].Key == "r1", "the outbox row is %+v, expected the topic and the key r1", rows[0])
	ctx.Equal(rows[0].Payload, hEventsExpected, "the event in the outbox row")
	ctx.Equal(hEventsRowIDs(ctx), []string{"r1:send_welcome:started"}, "the outbox row's event id")
	ctx.Equal(ok, false, "publishStep's result after a failed delivery")
	ctx.Kafka.Stall(kHEventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok, _ = hEventsPublish("r1", "send_welcome", "succeeded")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 2.5, "publishStep waited %.1f s for a broker that does not answer: wait for the report at most 2 s", waited)
	ctx.Equal(len(hEventsOutbox(ctx)), 2, "no acknowledgement within the window must leave a second row; the rows")
	ctx.Equal(ok, false, "publishStep's result without an acknowledgement")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include "workflow/runs.h"

namespace {

const std::string kHEventsTopic = "workflow.step";

runs::Run hEventsRun(const std::string& run_id) {
  runs::Run run;
  run.run_id = run_id;
  run.tenant = "t1";
  run.workflow = "signup";
  run.definition_version = 3;
  run.pinned_steps = {"create_account", "send_welcome"};
  run.input = nlohmann::json{{"email", "ada@example.com"}};
  run.max_steps = 50;
  run.started_at = 1000;
  return run;
}

const nlohmann::json kHEventsExpected = {{"run_id", "r1"}, {"workflow", "signup"}, {"step", "send_welcome"}, {"effect_id", "r1:send_welcome"}, {"outcome", "started"}};

// What publishStep returned: "true", "false", or "threw".
std::string hPublishEvent(const std::string& run_id, const std::string& step, const std::string& outcome) {
  try {
    return publishStep(hEventsRun(run_id), step, outcome) ? "true" : "false";
  } catch (const std::exception&) {
    return "threw";
  }
}

std::vector<nlohmann::json> hEventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& [event_id, text] : ctx.Redis.HGetAll("outbox")) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::vector<std::string> hEventsRowIds(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& [event_id, text] : ctx.Redis.HGetAll("outbox")) ids.push_back(event_id);
  std::sort(ids.begin(), ids.end());
  return ids;
}

std::string hEventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

struct HEventsSeen {
  bool fired = false;
  size_t produced = 0;
  std::vector<std::string> ids;
};

}  // namespace

void CheckKeyRun(harness::Ctx& ctx) {
  hPublishEvent("r1", "create_account", "succeeded");
  hPublishEvent("r2", "create_account", "succeeded");
  hPublishEvent("r1", "send_welcome", "started");
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Equal(records.size(), 3, "three publishStep calls must produce three records on workflow.step; the records");
  ctx.Equal(ctx.Kafka.Keys(kHEventsTopic), {"r1", "r2", "r1"}, "the records must be keyed by the run ids");
  ctx.Equal(records[0].Partition, records[2].Partition, "both r1 events must land on one partition, or the auditor reads r1's history out of order; the partitions");
}

void CheckOutcome(harness::Ctx& ctx) {
  hPublishEvent("r1", "send_welcome", "started");
  hPublishEvent("r1", "send_welcome", "succeeded");
  ctx.Settle();
  std::vector<std::string> outcomes;
  for (const auto& v : ctx.Kafka.Values(kHEventsTopic)) outcomes.push_back(hEventsField(nlohmann::json::parse(v, nullptr, false), "outcome"));
  ctx.Equal(outcomes, {"started", "succeeded"}, "publishing started then succeeded (otherwise the auditor cannot tell a running step from a finished one); the outcomes");
  ctx.Equal(hPublishEvent("r1", "send_welcome", "done"), "threw", "the outcome \\"done\\" is not in kOutcomes and must be refused; publishStep");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 2, "an unknown outcome must be refused before anything is produced; the records");
  ctx.Equal(hEventsOutbox(ctx).size(), 0, "the refused outcome \\"done\\" must leave no outbox row (the relay would publish it); the rows");
}

void CheckNoInput(harness::Ctx& ctx) {
  hPublishEvent("r1", "send_welcome", "started");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kHEventsTopic);
  ctx.Equal(values.size(), 1, "one publishStep must produce one record; the records");
  ctx.Assert(values[0].find("ada@example.com") == std::string::npos, "the event carries the run's input: %s. The topic keeps it for days after the run store deletes it", values[0]);
  ctx.Equal(nlohmann::json::parse(values[0], nullptr, false), kHEventsExpected, "the event");
}

void CheckAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kHEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  hPublishEvent("r1", "create_account", "succeeded");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  hPublishEvent("r1", "send_welcome", "started");
  ctx.Settle();
  ctx.Kafka.Failover(kHEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  // The moment the outbox is first written, the event must not be on the topic yet.
  auto seen = std::make_shared<HEventsSeen>();
  ctx.Redis.After("outbox", [seen, &ctx] {
    seen->fired = true;
    seen->produced = ctx.Kafka.Records(kHEventsTopic).size();
    seen->ids = hEventsRowIds(ctx);
  });
  ctx.Equal(hPublishEvent("r1", "create_account", "succeeded"), "true", "publishStep's result for an acknowledged event");
  ctx.Equal(hEventsOutbox(ctx).size(), 0, "the broker acknowledged the event, so the outbox must be empty (the relay would publish it again); the rows");
  ctx.Assert(seen->fired, "an acknowledged publish never wrote its outbox row: a crash between the produce and the acknowledgement loses the transition");
  ctx.Assert(seen->produced == 0 && seen->ids == std::vector<std::string>{"r1:create_account:succeeded"},
             "when the outbox was first written the topic held %d records and the outbox the rows %q, expected no record yet and the one row r1:create_account:succeeded (the event id): the row goes in before the produce",
             seen->produced, seen->ids);
  ctx.Kafka.FailNext(kHEventsTopic, 1);
  std::string ok = hPublishEvent("r1", "send_welcome", "started");
  ctx.Settle();
  auto rows = hEventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the transition is gone from the history; the rows");
  ctx.Assert(hEventsField(rows[0], "topic") == kHEventsTopic && hEventsField(rows[0], "key") == "r1", "the outbox row is %s, expected the topic and the key r1", rows[0].dump());
  ctx.Equal(rows[0].value("payload", nlohmann::json()), kHEventsExpected, "the event in the outbox row");
  ctx.Equal(hEventsRowIds(ctx), {"r1:send_welcome:started"}, "the outbox row's event id");
  ctx.Equal(ok, "false", "publishStep's result after a failed delivery");
  ctx.Kafka.Stall(kHEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = hPublishEvent("r1", "send_welcome", "succeeded");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 2.5, "publishStep waited %.1f s for a broker that does not answer: wait for the report at most 2 s", waited);
  ctx.Equal(hEventsOutbox(ctx).size(), 2, "no acknowledgement within the window must leave a second row; the rows");
  ctx.Equal(ok, "false", "publishStep's result without an acknowledgement");
}
`,
  },
  hints: [
    "Replay run r1 from `workflow.step`: its events sit on several partitions in no order, every one says `done`, each carries the customer's email, and the ones produced during a broker outage are missing.",
    'The key is the step name, so one run spreads over as many partitions as it has steps. The value copies `run["input"]` and a fixed `"done"`, and `produce` with `poll(0)` returns before any acknowledgement from an `acks=1` producer.',
    'Check `outcome in OUTCOMES`; value `{run_id, workflow, step, effect_id, outcome}`; `outbox.insert`, then `produce(key=run_id, on_delivery=…)` and `flush(2)`; acknowledged → `outbox.remove`, `True`, else `False`. Producer: `acks=all`, `enable.idempotence`.',
  ],
  debrief: `The key is the run id because a partition is the only order Kafka gives, and an auditor needs one run's transitions in order. The value carries ids and names, never the input, because the topic's retention outlives any deletion the run store honours. The outbox row goes in before the produce and comes out only on an acknowledgement, so a broker outage delays an event instead of losing it; the idempotent \`acks=all\` producer keeps a retry or a failover from duplicating or dropping one. A process that dies between the ack and the removal still lets the relay publish twice, so consumers deduplicate on run, step and outcome. Production systems write the row in the same transaction as the state change and let a relay such as Debezium's outbox event router do every produce.`,
};
