import type {Step} from '@/lib/types';

export const labelEventsStep: Step = {
  id: 'events',
  title: 'Label events keyed by task for agreement math',
  concept: 'kafka',
  file: 'events',
  focus: ['service', 'db', 'kafka'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the submit handler writes a
label, publishes a \`label.submitted\` event, and a consumer moves agreement counters, so the demo
shows numbers rising. It compiles, the demo never crashes, and it breaks four production contracts
at once. Review it like the service owner, name the subtle ones, fix them, and prove the fix with
the checks below.

\`POST /v1/tasks/{id}/labels\` accepts one human answer for one item, and the consumer folds those
events into the per-task agreement counters the progress endpoint reads.

- Validate before anything is written: label \`values\` must be non-empty (**400**), \`ms_spent\`
  must be non-negative (**400**), and the submitted \`spec_version\` must equal the version the task
  was pinned to when it was created (**409** \`{"error": "spec_version_mismatch"}\`). A label
  answered under an older taxonomy is not the same measurement, so it must not reach agreement math
  wearing a fresh version number.
- **Persist first, publish second.** The label row is the source of truth; the event is a
  notification about that row. Publish before the row lands and a crash between the two loses the
  label while its event survives — the agreement fold then counts an answer nobody stored.
- The event is keyed by \`task_id\`, never by annotator or label id: one task's submissions must
  land on one partition, because per-task ordering is exactly what makes the fold well defined. The
  producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks \`all\`
  plus a hashed, stable key); an idempotent producer deduplicates a retry only when the retry
  repeats the same key.
- The payload carries \`{"label_id", "task_id", "item_id", "annotator", "spec_version", "values",
  "ms_spent", "submitted_at"}\`. The spec version and the time spent are the two fields the
  agreement job and the productivity reports cannot reconstruct later.
- When the broker rejects the produce, write the same payload to an **outbox** row
  (\`insert_outbox\`/\`insertOutbox\`) so a relay republishes it when the broker recovers. Never
  drop the event, and never fail the annotator's submit because a broker blinked.
- The consumer folds each event **idempotently**: \`SADD agreement:applied:{task_id} label_id\`
  guards the fold, the counters move (\`HINCRBY agreement:{task_id}:{value} {annotator} 1\`), and
  only then is the **offset committed**. Counters before commit, so a crash replays the record
  instead of losing the update; the applied set makes that replay a no-op instead of a double count.

**Failure mode the checks target.** The draft is wrong in four places that only show up under
failure. Keying by annotator scatters one task's events across partitions, so "this is the second
label for this item" stops being a fact you can compute. Publishing before persisting inverts the
guarantee you actually want: the event is durable and the label is not. A producer with no outbox
turns a broker outage into silent data loss, with the submit still returning 202. And a consumer
that commits the offset first and increments afterwards has a window where a crash drops a counter
update *forever*, with no applied set to stop a replay from counting the same label twice.`,
  sequence: {
    participants: ['Annotator', 'labeld', 'Postgres', 'label.submitted', 'Agreement consumer', 'Redis'],
    messages: [
      {
        from: 'Annotator',
        to: 'labeld',
        label: 'POST /v1/tasks/{id}/labels · {label_id, spec_version, values, ms_spent}',
        kind: 'sync',
      },
      {
        from: 'labeld',
        to: 'Annotator',
        label: '400 empty values · 400 negative ms_spent · 409 spec_version_mismatch',
        kind: 'reply',
      },
      {from: 'labeld', to: 'Postgres', label: 'persist_label(label) — the durable row', kind: 'sync'},
      {from: 'Postgres', to: 'labeld', label: 'row committed', kind: 'reply'},
      {from: 'labeld', to: 'label.submitted', label: 'produce · key = task_id · idempotent · acks=all', kind: 'sync'},
      {from: 'label.submitted', to: 'labeld', label: 'ack / broker rejection', kind: 'reply'},
      {from: 'labeld', to: 'Postgres', label: 'insert_outbox(task_id, payload) on a rejected produce', kind: 'sync'},
      {from: 'label.submitted', to: 'Agreement consumer', label: 'consume · group agreement', kind: 'async'},
      {from: 'Agreement consumer', to: 'Redis', label: 'SADD agreement:applied:{task_id} label_id', kind: 'sync'},
      {from: 'Redis', to: 'Agreement consumer', label: '1 = first delivery · 0 = already counted', kind: 'reply'},
      {
        from: 'Agreement consumer',
        to: 'Redis',
        label: 'HINCRBY agreement:{task_id}:{value} {annotator} 1',
        kind: 'sync',
      },
      {from: 'Agreement consumer', to: 'label.submitted', label: 'commit the offset after the counters', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'key-task',
      title: 'label.submitted is keyed by the task id',
      detail:
        'The produce keys the record by the task id on an idempotent, `acks=all` producer: partition by task keeps one task’s submissions in order, and an idempotent producer can only deduplicate a retry that repeats the same key. The draft keys by the annotator on a default producer, so one task’s labels scatter across partitions and the fold loses its ordering guarantee.',
      match: {
        python: {all: [/key=task_id\b/, /"enable\.idempotence":\s*True/]},
        typescript: {all: [/key:\s*label\.task_id,/, /acks:\s*-1/]},
        go: {all: [/Key:\s*\[\]byte\(label\.TaskID\)/, /RequiredAcks:\s*kafka\.RequireAll/]},
        scala: {all: [/new ProducerRecord\(SubmittedTopic, taskId, event\)/, /ProducerConfig\.ACKS_CONFIG, "all"/]},
        cpp: {all: [/taskId\.data\(\),\s*taskId\.size\(\)/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'payload',
      title: 'The event carries the values, the spec version and the time spent',
      detail:
        'The event body carries `values`, `spec_version` and `ms_spent`, beside the ids and the submit time. The draft sends the ids and the values only, so a later agreement pass cannot tell which question the answer was given under — or how fast it was given.',
      match: {
        python: {
          all: [/"values":\s*body\.values/, /"spec_version":\s*body\.spec_version/, /"ms_spent":\s*body\.ms_spent/],
        },
        typescript: {
          all: [/values:\s*body\.values/, /spec_version:\s*body\.spec_version/, /ms_spent:\s*body\.ms_spent/],
        },
        go: {all: [/json:"values"/, /json:"spec_version"/, /json:"ms_spent"/]},
        scala: {
          all: [/"values" -> values\.mkString\(/, /"spec_version" -> specVersion/, /"ms_spent" -> msSpent\.toString/],
        },
        cpp: {
          all: [
            /\{"values", body\["values"\]\}/,
            /\{"spec_version", body\["spec_version"\]\}/,
            /\{"ms_spent", body\["ms_spent"\]\}/,
          ],
        },
      },
    },
    {
      id: 'persist-first',
      title: 'The label is persisted before it is published',
      detail:
        'The first persist call (`store.persist_label(label)` and its per-language equivalent) must appear before the first produce. The draft produces and flushes and only then writes the row, so a crash between the two leaves an event in the agreement math whose label was never stored.',
      match: {
        python: {order: [/store\.persist_label\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.persistLabel\(/, /producer\.send\(/]},
        go: {order: [/store\.PersistLabel\(/, /labelWriter\.WriteMessages\(/]},
        scala: {order: [/LabelStore\.persistLabel\(/, /producer\.send\(/]},
        cpp: {order: [/store\.persistLabel\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce writes an outbox row',
      detail:
        'The failure branch of the produce writes the same payload to the outbox — `store.insert_outbox(...)` inside `except KafkaException`, `store.insertOutbox(...)` in the send callback or the `catch`, `store.InsertOutbox(...)` under `if err != nil`. The draft ignores the broker result entirely, so a rejected produce loses the event while the submit still answers 202.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /except KafkaException/]},
        typescript: {all: [/store\.insertOutbox\(/, /catch\s*\(error\)/]},
        go: {all: [/store\.InsertOutbox\(/, /if err != nil/]},
        scala: {
          all: [
            /producer\.send\(new ProducerRecord\(SubmittedTopic, taskId, event\),/,
            /LabelStore\.insertOutbox\(/,
            /exception != null/,
          ],
        },
        cpp: {all: [/store\.insertOutbox\(/, /err != RdKafka::ERR_NO_ERROR/]},
      },
    },
    {
      id: 'agreement-idempotent',
      title: 'Agreement counters fold idempotently before the offset commit',
      detail:
        'In the consumer the applied-set guard (`SADD agreement:applied:{task_id}` with the label id) matches before the first counter increment (`HINCRBY`), which matches before the offset commit. The draft commits first, increments after, and keeps no applied set: a replay counts one label twice, and a crash between commit and increment loses the update for good.',
      match: {
        python: {all: [/agreement:applied/], order: [/\.sadd\(/, /\.hincrby\(/, /\.commit\(/]},
        typescript: {all: [/agreement:applied/], order: [/\.sadd\(/, /\.hincrby\(/, /commitOffsets\(/]},
        go: {all: [/agreement:applied/], order: [/\.SAdd\(/, /\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {all: [/agreement:applied/], order: [/\.sadd\(/, /\.hincrBy\(/, /commitSync\(/]},
        cpp: {all: [/agreement:applied/], order: [/->sadd\(/, /->hincrby\(/, /commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class LabelSubmission(BaseModel):
    label_id: str
    item_id: str
    annotator: str
    spec_version: str
    values: list[str]
    ms_spent: int


class LabelStore:
    def persist_label(self, label: dict) -> None:
        """One row per stored answer; the agreement fold must be able to rebuild from it."""
        raise NotImplementedError

    def pinned_spec_version(self, task_id: str) -> str:
        """The spec version the task was created under."""
        raise NotImplementedError

    def insert_outbox(self, topic: str, key: str, payload: dict) -> None:
        """Holds the event when the broker rejects the produce; a relay republishes it."""
        raise NotImplementedError


store = LabelStore()


@app.post("/v1/tasks/{task_id}/labels")
def submit_label(task_id: str, body: LabelSubmission) -> dict:
    # TODO: key the event by task_id instead of the annotator (annotator keys scatter one task's
    # labels across partitions, so per-task agreement can never fold them in order), persist the
    # label before publishing instead of after the flush (a publish-before-persist keeps the event
    # and loses the label on a crash), write an outbox row when the broker rejects the produce, and
    # fix the consumer: there is no applied-set guard and the offset is committed before the
    # counters, so a replay double-counts and a crash between them drops the update.
    event = {
        "label_id": body.label_id,
        "task_id": task_id,
        "item_id": body.item_id,
        "annotator": body.annotator,
        "values": body.values,
    }
    producer.produce("label.submitted", key=body.annotator, value=json.dumps(event))
    producer.flush(2.0)
    store.persist_label(event)
    return {"label_id": body.label_id, "status": "submitted"}


def consume_submitted() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "agreement"})
    consumer.subscribe(["label.submitted"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        for value in event["values"]:
            r.hincrby(f"agreement:{event['task_id']}:{value}", event["annotator"], 1)
`,
      solution: `import json
from datetime import datetime, timezone

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)
SUBMITTED_TOPIC = "label.submitted"


class LabelSubmission(BaseModel):
    label_id: str
    item_id: str
    annotator: str
    spec_version: str
    values: list[str]
    ms_spent: int
    submitted_at: str = ""


class LabelStore:
    def persist_label(self, label: dict) -> None:
        """One row per stored answer; the agreement fold must be able to rebuild from it."""
        raise NotImplementedError

    def pinned_spec_version(self, task_id: str) -> str:
        """The spec version the task was created under."""
        raise NotImplementedError

    def insert_outbox(self, topic: str, key: str, payload: dict) -> None:
        """Holds the event when the broker rejects the produce; a relay republishes it."""
        raise NotImplementedError


store = LabelStore()


@app.post("/v1/tasks/{task_id}/labels")
def submit_label(task_id: str, body: LabelSubmission) -> dict:
    if not body.values or any(not value.strip() for value in body.values):
        raise HTTPException(status_code=400, detail="empty_label_values")
    if body.ms_spent < 0:
        raise HTTPException(status_code=400, detail="negative_ms_spent")
    if body.spec_version != store.pinned_spec_version(task_id):
        raise HTTPException(status_code=409, detail="spec_version_mismatch")
    label = {
        "label_id": body.label_id,
        "task_id": task_id,
        "item_id": body.item_id,
        "annotator": body.annotator,
        "spec_version": body.spec_version,
        "values": body.values,
        "ms_spent": body.ms_spent,
        "submitted_at": body.submitted_at or datetime.now(timezone.utc).isoformat(),
    }
    store.persist_label(label)
    try:
        producer.produce(SUBMITTED_TOPIC, key=task_id, value=json.dumps(label))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(SUBMITTED_TOPIC, task_id, label)
    return {"label_id": label["label_id"], "status": "submitted"}


def consume_submitted() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "agreement", "enable.auto.commit": False}
    )
    consumer.subscribe([SUBMITTED_TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        applied = r.sadd(f"agreement:applied:{event['task_id']}", event["label_id"])
        if applied:
            for value in event["values"]:
                r.hincrby(f"agreement:{event['task_id']}:{value}", event["annotator"], 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** label.submitted: a model-generated draft that keys by annotator and publishes before persisting. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'labeld', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

interface LabelBody {
  label_id: string;
  item_id: string;
  annotator: string;
  spec_version: string;
  values: string[];
  ms_spent: number;
}

app.post('/v1/tasks/:taskId/labels', async (request, reply) => {
  // TODO: key the event by the task id instead of the annotator, persist the label before it is
  // published instead of after, write an outbox row when the broker rejects the produce, and give
  // the consumer an applied-set guard with the counters before the commit — as written the offset
  // moves first and a replay double-counts.
  const {taskId} = request.params as {taskId: string};
  const body = request.body as LabelBody;
  if (body.values.length === 0) return reply.code(400).send({error: 'empty_label_values'});
  const event = {
    label_id: body.label_id,
    task_id: taskId,
    item_id: body.item_id,
    annotator: body.annotator,
    values: body.values,
  };
  await producer.send({
    topic: 'label.submitted',
    messages: [{key: body.annotator, value: JSON.stringify(event)}],
  });
  await store.persistLabel(event);
  return reply.code(202).send({label_id: body.label_id, status: 'submitted'});
});

export async function consumeSubmitted(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'agreement'});
  await consumer.connect();
  await consumer.subscribe({topic: 'label.submitted'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        task_id: string;
        annotator: string;
        values: string[];
      };
      for (const value of event.values) {
        await r.hincrby(\`agreement:\${event.task_id}:\${value}\`, event.annotator, 1);
      }
    },
  });
}
`,
      solution: `/** label.submitted: one task-keyed event per label, persisted first, outbox on a rejected produce. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const kafka = new Kafka({clientId: 'labeld', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');
const SUBMITTED = 'label.submitted';

interface LabelBody {
  label_id: string;
  item_id: string;
  annotator: string;
  spec_version: string;
  values: string[];
  ms_spent: number;
}

interface LabelEvent {
  label_id: string;
  task_id: string;
  item_id: string;
  annotator: string;
  spec_version: string;
  values: string[];
  ms_spent: number;
  submitted_at: string;
}

app.post('/v1/tasks/:taskId/labels', async (request, reply) => {
  const {taskId} = request.params as {taskId: string};
  const body = request.body as LabelBody;
  if (body.values.length === 0 || body.values.some(value => value.trim() === '')) {
    return reply.code(400).send({error: 'empty_label_values'});
  }
  if (body.ms_spent < 0) return reply.code(400).send({error: 'negative_ms_spent'});
  const pinned = await store.pinnedSpecVersion(taskId);
  if (body.spec_version !== pinned) {
    return reply.code(409).send({error: 'spec_version_mismatch', pinned});
  }
  const label: LabelEvent = {
    label_id: body.label_id,
    task_id: taskId,
    item_id: body.item_id,
    annotator: body.annotator,
    spec_version: body.spec_version,
    values: body.values,
    ms_spent: body.ms_spent,
    submitted_at: new Date().toISOString(),
  };
  await store.persistLabel(label);
  try {
    await producer.send({
      topic: SUBMITTED,
      acks: -1,
      messages: [{key: label.task_id, value: JSON.stringify(label)}],
    });
  } catch (error) {
    await store.insertOutbox({topic: SUBMITTED, key: label.task_id, payload: label});
  }
  return reply.code(202).send({label_id: label.label_id, status: 'submitted'});
});

export async function consumeSubmitted(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'agreement'});
  await consumer.connect();
  await consumer.subscribe({topic: SUBMITTED});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as LabelEvent;
      const guard = await r.sadd(\`agreement:applied:\${event.task_id}\`, event.label_id);
      if (guard === 1) {
        for (const value of event.values) {
          await r.hincrby(\`agreement:\${event.task_id}:\${value}\`, event.annotator, 1);
        }
      }
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

// labelWriter publishes label.submitted; the agreement consumer folds the events into counters.
var labelWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "label.submitted"}

var rdb *redis.Client

type LabelSubmission struct {
	LabelID   string   \`json:"label_id"\`
	ItemID    string   \`json:"item_id"\`
	Annotator string   \`json:"annotator"\`
	Values    []string \`json:"values"\`
}

// TODO: key the event by the task id instead of the annotator, persist the label before it is
// published instead of after, write an outbox row when the broker rejects the produce, and give
// the consumer an applied-set guard with the counters before the commit — as written the offset
// moves first and a replay double-counts.
func submitLabel(rw http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("taskID")
	body := LabelSubmission{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	event := map[string]any{
		"label_id":  body.LabelID,
		"task_id":   taskID,
		"item_id":   body.ItemID,
		"annotator": body.Annotator,
		"values":    body.Values,
	}
	payload, _ := json.Marshal(event)
	_ = labelWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.Annotator), Value: payload})
	_ = store.PersistLabel(r.Context(), taskID, event)
	rw.WriteHeader(http.StatusAccepted)
}

func consumeSubmitted(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "label.submitted",
		GroupID: "agreement",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			TaskID    string   \`json:"task_id"\`
			Annotator string   \`json:"annotator"\`
			Values    []string \`json:"values"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		for _, value := range event.Values {
			rdb.HIncrBy(ctx, "agreement:"+event.TaskID+":"+value, event.Annotator, 1)
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker confirms only a replicated record, and a retry of the same key lands on the
// same partition — which is also what keeps one task's labels in order.
var labelWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "label.submitted",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

type LabelSubmission struct {
	LabelID     string   \`json:"label_id"\`
	ItemID      string   \`json:"item_id"\`
	Annotator   string   \`json:"annotator"\`
	SpecVersion string   \`json:"spec_version"\`
	Values      []string \`json:"values"\`
	MSpent      int      \`json:"ms_spent"\`
}

type LabelEvent struct {
	LabelID     string   \`json:"label_id"\`
	TaskID      string   \`json:"task_id"\`
	ItemID      string   \`json:"item_id"\`
	Annotator   string   \`json:"annotator"\`
	SpecVersion string   \`json:"spec_version"\`
	Values      []string \`json:"values"\`
	MSpent      int      \`json:"ms_spent"\`
	SubmittedAt string   \`json:"submitted_at"\`
}

type LabelStore struct{}

func (s *LabelStore) PersistLabel(ctx context.Context, label LabelEvent) error { return nil }

func (s *LabelStore) PinnedSpecVersion(ctx context.Context, taskID string) (string, error) {
	return "", nil
}

func (s *LabelStore) InsertOutbox(ctx context.Context, taskID string, payload []byte) error { return nil }

var store = &LabelStore{}

func submitLabel(rw http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("taskID")
	body := LabelSubmission{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if len(body.Values) == 0 || body.MSpent < 0 {
		http.Error(rw, "invalid_label", http.StatusBadRequest)
		return
	}
	pinned, _ := store.PinnedSpecVersion(r.Context(), taskID)
	if body.SpecVersion != pinned {
		http.Error(rw, "spec_version_mismatch", http.StatusConflict)
		return
	}
	label := LabelEvent{
		LabelID:     body.LabelID,
		TaskID:      taskID,
		ItemID:      body.ItemID,
		Annotator:   body.Annotator,
		SpecVersion: body.SpecVersion,
		Values:      body.Values,
		MSpent:      body.MSpent,
		SubmittedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err := store.PersistLabel(r.Context(), label); err != nil {
		http.Error(rw, "label_not_stored", http.StatusInternalServerError)
		return
	}
	payload, _ := json.Marshal(label)
	if err := labelWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(label.TaskID), Value: payload}); err != nil {
		_ = store.InsertOutbox(r.Context(), label.TaskID, payload)
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consumeSubmitted(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "label.submitted",
		GroupID: "agreement",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event LabelEvent
		_ = json.Unmarshal(msg.Value, &event)
		added, err := rdb.SAdd(ctx, "agreement:applied:"+event.TaskID, event.LabelID).Result()
		if err != nil {
			continue
		}
		if added == 1 {
			for _, value := range event.Values {
				rdb.HIncrBy(ctx, "agreement:"+event.TaskID+":"+value, event.Annotator, 1)
			}
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object LabelEventsApi {
  private val SubmittedTopic = "label.submitted"

  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: key the event by the task id instead of the annotator, persist the label before it is
  // published instead of after, write an outbox row when the broker rejects the produce, and give
  // the consumer an applied-set guard with the counters before the commit — as written the offset
  // moves first and a replay double-counts.
  def submitLabel(taskId: String, labelId: String, annotator: String, values: List[String]): Unit = {
    val event = Map(
      "label_id" -> labelId,
      "task_id" -> taskId,
      "annotator" -> annotator,
      "values" -> values.mkString(","),
    ).toJson.compactPrint
    producer.send(new ProducerRecord(SubmittedTopic, annotator, event))
    LabelStore.persistLabel(taskId, labelId, event)
  }

  def consumeSubmitted(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of(SubmittedTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val event = record.value().parseJson.asJsObject.fields
        event("values").convertTo[String].split(",").foreach { value =>
          jedis.hincrBy(s"agreement:\${event("task_id").convertTo[String]}:$value", event("annotator").convertTo[String], 1L)
        }
      }
    }
  }
}
`,
      solution: `import java.time.Instant
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object LabelEventsApi {
  private val SubmittedTopic = "label.submitted"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
    props.put(ProducerConfig.ACKS_CONFIG, "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def submitLabel(taskId: String, labelId: String, itemId: String, annotator: String, specVersion: String, values: List[String], msSpent: Long): Either[String, String] = {
    if (values.isEmpty || values.exists(_.trim.isEmpty)) return Left("400 empty_label_values")
    if (msSpent < 0) return Left("400 negative_ms_spent")
    if (specVersion != LabelStore.pinnedSpecVersion(taskId)) return Left("409 spec_version_mismatch")
    val event = Map(
      "label_id" -> labelId,
      "task_id" -> taskId,
      "item_id" -> itemId,
      "annotator" -> annotator,
      "spec_version" -> specVersion,
      "values" -> values.mkString(","),
      "ms_spent" -> msSpent.toString,
      "submitted_at" -> Instant.now().toString,
    ).toJson.compactPrint
    LabelStore.persistLabel(taskId, labelId, event)
    producer.send(new ProducerRecord(SubmittedTopic, taskId, event), (_, exception) => {
      if (exception != null) LabelStore.insertOutbox(taskId, event)
    })
    Right(labelId)
  }

  def consumeSubmitted(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "agreement")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(SubmittedTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val taskId = event("task_id").convertTo[String]
        val applied = jedis.sadd(s"agreement:applied:$taskId", event("label_id").convertTo[String])
        if (applied == 1L) {
          event("values").convertTo[String].split(",").foreach { value =>
            jedis.hincrBy(s"agreement:$taskId:$value", event("annotator").convertTo[String], 1L)
          }
        }
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kSubmittedTopic = "label.submitted";

std::unique_ptr<RdKafka::Producer> producer;
std::unique_ptr<sw::redis::Redis> redis;

// TODO: key the event by the task id instead of the annotator, persist the label before it is
// published instead of after, write an outbox row when the broker rejects the produce, and give
// the consumer an applied-set guard with the counters before the commit — as written the offset
// moves first and a replay double-counts.
void submitLabel(const std::string& taskId, const std::string& labelId, const std::string& annotator, const json& values) {
  const json event = {{"label_id", labelId}, {"task_id", taskId}, {"annotator", annotator}, {"values", values}};
  const auto payload = event.dump();
  producer->produce(kSubmittedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), annotator.data(), annotator.size(), 0, nullptr);
  producer->flush(2000);
  store.persistLabel(taskId, event);
}

void consumeSubmitted(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kSubmittedTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    consumer->commitSync();
    for (const auto& value : event["values"]) {
      redis->hincrby("agreement:" + event["task_id"].get<std::string>() + ":" + value.get<std::string>(), event["annotator"].get<std::string>(), 1);
    }
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kSubmittedTopic = "label.submitted";

struct LabelStore {
  void persistLabel(const std::string& taskId, const json& label);
  std::string pinnedSpecVersion(const std::string& taskId);
  void insertOutbox(const std::string& key, const json& payload);
};

LabelStore store;

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

std::string submitLabel(const std::string& taskId, const json& body) {
  if (!body.contains("values") || body["values"].empty()) return "400 empty_label_values";
  if (body.value("ms_spent", 0) < 0) return "400 negative_ms_spent";
  if (body.value("spec_version", std::string{}) != store.pinnedSpecVersion(taskId)) {
    return "409 spec_version_mismatch";
  }
  const json label = {
      {"label_id", body["label_id"]},
      {"task_id", taskId},
      {"item_id", body["item_id"]},
      {"annotator", body["annotator"]},
      {"spec_version", body["spec_version"]},
      {"values", body["values"]},
      {"ms_spent", body["ms_spent"]},
      {"submitted_at", body.value("submitted_at", std::string{})},
  };
  const auto payload = label.dump();
  store.persistLabel(taskId, label);
  const auto err = producer->produce(kSubmittedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), taskId.data(), taskId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(taskId, label);
  }
  producer->flush(2000);
  return "202 " + label["label_id"].get<std::string>();
}

void consumeSubmitted(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kSubmittedTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    const std::string taskId = event["task_id"].get<std::string>();
    const long applied = redis->sadd("agreement:applied:" + taskId, event["label_id"].get<std::string>());
    if (applied == 1) {
      for (const auto& value : event["values"]) {
        redis->hincrby("agreement:" + taskId + ":" + value.get<std::string>(), event["annotator"].get<std::string>(), 1);
      }
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  hints: [
    'The message key is the ordering contract: `key=task_id`, `key: label.task_id`, `Key: []byte(label.TaskID)`, `new ProducerRecord(SUBMITTED_TOPIC, task_id, payload)`. Keyed by annotator, one task’s submissions share no partition and “the second label for this item” stops being computable. Idempotence rides along: a retry can only be deduplicated if it repeats the same key, and `acks=all` is what makes the record durable before the caller is told it is.',
    'Persist, then produce — the order is a correctness property, not style. Publish first and a crash between the two keeps the event and loses the label, so agreement math counts an answer nobody stored. When the broker rejects the produce, take the same payload to the outbox row (`insert_outbox`, `insertOutbox`, `insertOutbox` in a producer callback, `if err != nil` in Go) so a relay can republish it; an ignored broker error is silent loss.',
    'The consumer must be re-runnable. Guard the fold with `SADD agreement:applied:{task_id} label_id` (or its language equivalent: `sadd`, `SAdd`), increment the counters (`HINCRBY`), and commit the offset last. Commit first and a crash between commit and increment loses the update permanently; no applied set and every replay counts the same label twice.',
  ],
  debrief: `The interviewer is testing whether you can keep an event stream honest under failure, not whether you can call a producer. Three ordering decisions carry the step. The message key is the first: keying \`label.submitted\` by task id is what makes “one task’s labels, in submission order” a fact — key it by annotator and a task’s answers are spread over partitions, and the agreement fold has nothing stable to walk. The key also has to be stable across retries, which is why idempotence and the key belong to the same decision. The second is persist-then-publish: the database row is the source of truth and the event is a notification about it, so writing the event first quietly inverts the guarantee — after a crash the event exists and the label does not, and every downstream count is wrong in a way no replay can repair. The third is the consumer: counters before the offset commit, plus an applied set keyed by label id, turns the fold into an operation that is safe to replay. Commit first and one crash loses a counter update forever; commit with no applied set and one replay double-counts a label. Your code will be replayed often — a broker redelivers, a rebalance hands a partition to another worker, a deploy restarts the group — so the fold has to be idempotent by construction rather than by luck. The outbox is the same idea on the write side: the broker is a network service, not a database, so a rejected produce lands in a durable row a relay can republish instead of disappearing behind a 202.`,
};
