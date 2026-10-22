import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Session events keyed by session with redacted traces',
  concept: 'kafka',
  file: 'events',
  focus: ['worker', 'kafka', 'consumer', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the worker publishes one
\`browser.step\` record per driver action and the trace consumer appends each record to the session's
trace, so the demo shows a trace growing. It hides four production flaws — a record keyed by the
step index, a payload that ships what the agent typed "for debugging", an offset committed before
the trace is durable, and a producer left at its defaults. Review it like the owner of the trace
pipeline, fix it, and prove the fix with the checks below.

Implement the worker's event path and the trace consumer for browser sessions. Every driver action
the worker completes produces **exactly one** \`browser.step\` record, and a consumer in group
\`trace-store\` turns those records into the per-session trace.

- The record's **key is the session id**: one session, one partition, so the steps of a session are
  consumed in order. Keying by the step index spreads one session's trace across partitions and lets
  two of its steps be replayed out of order.
- The payload carries \`session_id\`, \`step_index\`, \`action\`, \`target_digest\`, \`outcome\` and
  \`redacted_fields\`, and nothing else. Page content and **typed values never leave the worker**: a
  password typed into a form must not reach the topic, and it must not reach the logs either.
- Redaction is a helper, not a review habit: a \`REDACTED_FIELDS\` constant plus \`redact(typed_input)\`
  reduce typed input to the **names** of the fields it filled, and the target is published as a
  digest. Writing the typed value anywhere — "temporarily, for debugging" — is the bug.
- The producer is **idempotent with \`acks=all\`** (\`enable.idempotence=true\` with \`"acks": "all"\`,
  KafkaJS's \`idempotent: true\` with \`acks: -1\`, or required acks \`all\` plus a hash balancer), and
  the record carries an \`idempotency_key\` of \`{session_id}:{step_index}\`, so a producer retry
  cannot duplicate a step or reorder a session.
- The consumer **appends the step to the trace store first and commits the offset last**. A crash in
  between replays the record, so the trace stays complete; committing first loses the step the
  moment the process dies before the append.
- A produce the broker rejects is not dropped: it leaves a \`record_pending_step(...)\` record on
  \`session:{id}\` — the state step's key — and a relay republishes it. The worker never fails the
  session for a broker hiccup.

**Failure mode the checks target.** The draft keys the record by \`step_index\`, so one session's
trace is reassembled from several partitions and can land out of order — wrong in a way nobody
notices until a customer reads the trace. It puts \`typed_values\` in the payload and logs the event,
so the password the agent typed is now in the topic and in the log aggregator, where it outlives
every redaction nobody wrote. It commits the offset before the trace append, so a crash between the
two drops the step for good while the offset says it was processed. And it leaves the producer at
its defaults with no dedupe key, so a retry duplicates the step and a rejected produce disappears.`,
  sequence: {
    participants: ['Worker', 'Session state', 'browser.step', 'Trace consumer', 'Trace store'],
    messages: [
      {from: 'Worker', to: 'Session state', label: 'CLAIM · RENEW lease (session:{id})', kind: 'sync'},
      {from: 'Session state', to: 'Worker', label: 'lease + steps left', kind: 'reply'},
      {from: 'Worker', to: 'browser.step', label: 'produce · key = session id · acks = all', kind: 'sync'},
      {from: 'browser.step', to: 'Worker', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'Worker',
        to: 'Session state',
        label: 'record_pending_step(session:{id}) when the broker rejects',
        kind: 'sync',
      },
      {from: 'browser.step', to: 'Trace consumer', label: 'consume · group trace-store', kind: 'async'},
      {from: 'Trace consumer', to: 'Trace consumer', label: 'redact typed input → field names', kind: 'sync'},
      {from: 'Trace consumer', to: 'Trace store', label: 'append step (session_id, step_index)', kind: 'sync'},
      {from: 'Trace store', to: 'Trace consumer', label: 'step persisted', kind: 'reply'},
      {from: 'Trace consumer', to: 'browser.step', label: 'commit offset after the append', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'session-key',
      title: 'Keys every event by the session id',
      detail:
        'The produced record is keyed by the **session id** — one session, one partition, so its steps are consumed in order. The draft keys by the step index, so two steps of the same session land in different partitions and the trace is written out of order.',
      match: {
        python: {all: [/key=session_id/], none: [/key=step_index/]},
        typescript: {all: [/key:\s*sessionId\b/], none: [/key:\s*stepIndex\b/]},
        go: {all: [/Key:\s*\[\]byte\(sessionID\)/], none: [/Key:\s*\[\]byte\(stepKey\)/]},
        scala: {
          all: [/ProducerRecord\("browser\.step",\s*sessionId/],
          none: [/ProducerRecord\("browser\.step",\s*stepIndex/],
        },
        cpp: {all: [/produce\([^;\n]*sessionId\.data\(\)/], none: [/produce\([^;\n]*stepKey\.data\(\)/]},
      },
    },
    {
      id: 'no-typed-values',
      title: 'Never publishes the typed values',
      detail:
        'Typed input is reduced by the compile-time `redact(...)` helper before the record is built: the payload carries field names and a digest, never the values the agent typed into the page. The draft adds `typed_values` "for debugging" and logs the whole event.',
      match: {
        python: {all: [/def redact\(/], none: [/typed_values/]},
        typescript: {all: [/function redact\(/], none: [/typed_values/]},
        go: {all: [/func redact\(/], none: [/typed_values/]},
        scala: {all: [/def redact\(/], none: [/typed_values/]},
        cpp: {all: [/redact\(typedInput\)/], none: [/typed_values/]},
      },
    },
    {
      id: 'redacted-fields',
      title: 'Reduces typed input to field names and the target to a digest',
      detail:
        'A `REDACTED_FIELDS` constant names the sensitive fields and a `redact(...)` helper returns the **names** of the fields the agent filled; the target is published as a digest. A payload built straight from the request body carries the password itself into the topic.',
      match: {
        python: {all: [/REDACTED_FIELDS/, /def redact\(/, /sha256/]},
        typescript: {all: [/REDACTED_FIELDS/, /function redact\(/, /createHash\(\s*'sha256'\s*\)/]},
        go: {all: [/redactedFields/, /func redact\(/, /sha256\.Sum256/]},
        scala: {all: [/RedactedFields/, /def redact\(/, /MessageDigest/]},
        cpp: {all: [/kRedactedFields/, /redact\(typedInput\)/, /targetDigest/]},
      },
    },
    {
      id: 'store-before-commit',
      title: 'Appends the trace before committing the offset',
      detail:
        'The consumer appends the step to the trace store **before** it commits the offset, so a crash between the two replays the record instead of losing it. The draft commits first: the offset then claims a step the trace never received.',
      match: {
        python: {order: [/store\.append_step\(/, /consumer\.commit\(/]},
        typescript: {order: [/store\.appendStep\(/, /commitOffsets\(/]},
        go: {order: [/store\.AppendStep\(/, /CommitMessages\(/]},
        scala: {order: [/TraceStore\.appendStep\(/, /commitSync\(/]},
        cpp: {order: [/store\.appendStep\(/, /commitSync\(/]},
      },
    },
    {
      id: 'producer-durability',
      title: 'Produces idempotently, deduped per (session, step)',
      detail:
        'The producer is configured for idempotence and `acks=all` and each record carries an `idempotency_key` of `{session_id}:{step_index}`, so a retry cannot duplicate a step. A produce the broker rejects records a pending step on `session:{id}` instead of being dropped. The draft ships a default producer with no dedupe key and ignores the produce result.',
      match: {
        python: {
          all: [/enable\.idempotence/, /"acks":\s*"all"/, /idempotency_key/, /store\.record_pending_step\(/],
        },
        typescript: {
          all: [/idempotent:\s*true/, /acks:\s*-1/, /idempotency_key/, /store\.recordPendingStep\(/],
        },
        go: {
          all: [
            /RequiredAcks:\s*kafka\.RequireAll/,
            /Balancer:\s*&kafka\.Hash\{\}/,
            /idempotency_key/,
            /store\.RecordPendingStep\(/,
          ],
        },
        scala: {
          all: [/enable\.idempotence/, /"acks"/, /idempotency_key/, /TraceStore\.recordPendingStep\(/],
        },
        cpp: {
          all: [/enable\.idempotence/, /set\("acks",\s*"all"/, /idempotency_key/, /store\.recordPendingStep\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("browser-worker")

producer = Producer({"bootstrap.servers": "kafka:9092"})

TOPIC = "browser.step"


class StepEvent(BaseModel):
    step_index: int
    action: str
    target: str
    typed_input: dict[str, str]
    outcome: str


class SessionStore:
    def append_step(self, session_id: str, step_index: int, event: dict) -> None:
        """Append one redacted step to the session trace."""
        raise NotImplementedError

    def record_pending_step(self, session_id: str, step_index: int, event: dict) -> None:
        """Durable pending step on session:{id}; a relay republishes it."""
        raise NotImplementedError


store = SessionStore()


@app.post("/internal/sessions/{session_id}/steps")
def publish_step(session_id: str, body: StepEvent) -> dict:
    # TODO: the draft keys the record by the step index instead of the session, ships the typed
    # values in the payload "for debugging", and commits the offset before the trace append.
    event = {
        "session_id": session_id,
        "step_index": body.step_index,
        "action": body.action,
        "target_digest": body.target,
        "outcome": body.outcome,
        "typed_values": body.typed_input,
    }
    logger.info("browser.step %s", event)
    producer.produce(TOPIC, key=body.step_index, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "trace-store"})
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        consumer.commit(msg)
        store.append_step(event["session_id"], event["step_index"], event)
`,
      solution: `import hashlib
import json

from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
        "max.in.flight.requests.per.connection": 1,
    }
)

TOPIC = "browser.step"
REDACTED_FIELDS = ("password", "card", "token")


class StepEvent(BaseModel):
    step_index: int
    action: str
    target: str
    typed_input: dict[str, str]
    outcome: str


class SessionStore:
    def append_step(self, session_id: str, step_index: int, event: dict) -> None:
        """Append one redacted step to the session trace."""
        raise NotImplementedError

    def record_pending_step(self, session_id: str, step_index: int, event: dict) -> None:
        """Durable pending step on session:{id}; a relay republishes it."""
        raise NotImplementedError


store = SessionStore()


def redact(typed_input: dict[str, str]) -> list[str]:
    """Typed input never leaves the worker: only the names of the filled fields travel."""
    return sorted(name for name in typed_input if name.lower() in REDACTED_FIELDS)


def target_digest(target: str) -> str:
    return hashlib.sha256(target.encode("utf-8")).hexdigest()


@app.post("/internal/sessions/{session_id}/steps")
def publish_step(session_id: str, body: StepEvent) -> dict:
    event = {
        "session_id": session_id,
        "step_index": body.step_index,
        "action": body.action,
        "target_digest": target_digest(body.target),
        "outcome": body.outcome,
        "redacted_fields": redact(body.typed_input),
        "idempotency_key": f"{session_id}:{body.step_index}",
    }
    payload = json.dumps(event)
    try:
        producer.produce(TOPIC, key=session_id, value=payload)
        producer.flush(2.0)
    except KafkaException:
        # The broker refused the record: keep it on the state key so the relay republishes it
        # instead of losing a step the page really took.
        store.record_pending_step(session_id, body.step_index, event)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "trace-store", "enable.auto.commit": False}
    )
    consumer.subscribe([TOPIC])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        # Trace first, offset last: a crash in between replays the record into an idempotent append.
        store.append_step(event["session_id"], event["step_index"], event)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** browser.step: a model-generated draft that keys by step index and commits before the append. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'browser-worker', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const TOPIC = 'browser.step';

interface StepBody {
  step_index: number;
  action: string;
  target: string;
  typed_input: Record<string, string>;
  outcome: string;
}

interface SessionStore {
  /** Append one redacted step to the session trace. */
  appendStep(sessionId: string, stepIndex: number, event: unknown): Promise<void>;
  /** Durable pending step on session:{id}; a relay republishes it. */
  recordPendingStep(sessionId: string, stepIndex: number, event: unknown): Promise<void>;
}

declare const store: SessionStore;

app.post('/internal/sessions/:sessionId/steps', async (request, reply) => {
  // TODO: the draft keys the record by the step index instead of the session, ships the typed values
  // in the payload "for debugging", and commits the offset before the trace append.
  const {sessionId} = request.params as {sessionId: string};
  const body = request.body as StepBody;
  const event = {
    session_id: sessionId,
    step_index: body.step_index,
    action: body.action,
    target_digest: body.target,
    outcome: body.outcome,
    typed_values: body.typed_input,
  };
  await producer.send({
    topic: TOPIC,
    messages: [{key: body.step_index, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'trace-store'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        session_id: string;
        step_index: number;
      };
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      await store.appendStep(event.session_id, event.step_index, event);
    },
  });
}

void app.listen({port: 9090, host: '0.0.0.0'});
`,
      solution: `/** browser.step: session-keyed, redacted and idempotent; trace appended before the commit. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'browser-worker', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const TOPIC = 'browser.step';
const REDACTED_FIELDS = ['password', 'card', 'token'];

interface StepBody {
  step_index: number;
  action: string;
  target: string;
  typed_input: Record<string, string>;
  outcome: string;
}

interface SessionStore {
  /** Append one redacted step to the session trace. */
  appendStep(sessionId: string, stepIndex: number, event: unknown): Promise<void>;
  /** Durable pending step on session:{id}; a relay republishes it. */
  recordPendingStep(sessionId: string, stepIndex: number, event: unknown): Promise<void>;
}

declare const store: SessionStore;

/** Typed input never leaves the worker: only the names of the filled fields travel. */
function redact(typedInput: Record<string, string>): string[] {
  return Object.keys(typedInput)
    .filter(name => REDACTED_FIELDS.includes(name))
    .sort();
}

function targetDigest(target: string): string {
  return createHash('sha256').update(target).digest('hex');
}

app.post('/internal/sessions/:sessionId/steps', async (request, reply) => {
  const {sessionId} = request.params as {sessionId: string};
  const body = request.body as StepBody;
  const event = {
    session_id: sessionId,
    step_index: body.step_index,
    action: body.action,
    target_digest: targetDigest(body.target),
    outcome: body.outcome,
    redacted_fields: redact(body.typed_input),
    idempotency_key: \`\${sessionId}:\${body.step_index}\`,
  };
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: sessionId, value: JSON.stringify(event)}],
    });
  } catch (error) {
    // The broker refused the record: keep it on the state key so the relay republishes it instead
    // of losing a step the page really took.
    await store.recordPendingStep(sessionId, body.step_index, event);
  }
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'trace-store'});
  await consumer.connect();
  await consumer.subscribe({topic: TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        session_id: string;
        step_index: number;
      };
      // Trace first, offset last: a crash in between replays the record into an idempotent append.
      await store.appendStep(event.session_id, event.step_index, event);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 9090, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/segmentio/kafka-go"
)

const stepTopic = "browser.step"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: stepTopic}

type SessionStore struct{}

// AppendStep appends one redacted step to the session trace.
func (s *SessionStore) AppendStep(ctx context.Context, sessionID string, stepIndex int, event map[string]any) error {
	return nil
}

// RecordPendingStep keeps the event on session:{id} when the broker rejects the produce.
func (s *SessionStore) RecordPendingStep(ctx context.Context, sessionID string, stepIndex int, event map[string]any) error {
	return nil
}

var store = &SessionStore{}

func publishStep(rw http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("session_id")
	body := struct {
		StepIndex  int            \`json:"step_index"\`
		Action     string         \`json:"action"\`
		Target     string         \`json:"target"\`
		TypedInput map[string]any \`json:"typed_input"\`
		Outcome    string         \`json:"outcome"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: the draft keys the record by the step index instead of the session, ships the typed
	// values in the payload "for debugging", and commits the offset before the trace append.
	event := map[string]any{
		"session_id":    sessionID,
		"step_index":    body.StepIndex,
		"action":        body.Action,
		"target_digest": body.Target,
		"outcome":       body.Outcome,
		"typed_values":  body.TypedInput,
	}
	payload, _ := json.Marshal(event)
	stepKey := strconv.Itoa(body.StepIndex)
	_ = writer.WriteMessages(r.Context(), kafka.Message{Key: []byte(stepKey), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   stepTopic,
		GroupID: "trace-store",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			SessionID string \`json:"session_id"\`
			StepIndex int    \`json:"step_index"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		_ = reader.CommitMessages(ctx, msg)
		_ = store.AppendStep(ctx, event.SessionID, event.StepIndex, map[string]any{"payload": string(msg.Value)})
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/segmentio/kafka-go"
)

const stepTopic = "browser.step"

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the record is acknowledged only once replicated, and a retry of the same key lands on
// the same partition instead of duplicating across them.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        stepTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var redactedFields = map[string]bool{"password": true, "card": true, "token": true}

type SessionStore struct{}

// AppendStep appends one redacted step to the session trace.
func (s *SessionStore) AppendStep(ctx context.Context, sessionID string, stepIndex int, event map[string]any) error {
	return nil
}

// RecordPendingStep keeps the event on session:{id} when the broker rejects the produce.
func (s *SessionStore) RecordPendingStep(ctx context.Context, sessionID string, stepIndex int, event map[string]any) error {
	return nil
}

var store = &SessionStore{}

// redact turns typed input into the names of the filled fields; the values never leave the worker.
func redact(typedInput map[string]any) []string {
	names := make([]string, 0, len(typedInput))
	for name := range typedInput {
		if redactedFields[name] {
			names = append(names, name)
		}
	}
	return names
}

func targetDigest(target string) string {
	sum := sha256.Sum256([]byte(target))
	return hex.EncodeToString(sum[:])
}

func publishStep(rw http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("session_id")
	body := struct {
		StepIndex  int            \`json:"step_index"\`
		Action     string         \`json:"action"\`
		Target     string         \`json:"target"\`
		TypedInput map[string]any \`json:"typed_input"\`
		Outcome    string         \`json:"outcome"\`
	}{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	event := map[string]any{
		"session_id":      sessionID,
		"step_index":      body.StepIndex,
		"action":          body.Action,
		"target_digest":   targetDigest(body.Target),
		"outcome":         body.Outcome,
		"redacted_fields": redact(body.TypedInput),
		"idempotency_key": sessionID + ":" + strconv.Itoa(body.StepIndex),
	}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(r.Context(), kafka.Message{Key: []byte(sessionID), Value: payload}); err != nil {
		// The broker refused the record: keep it on the state key so the relay republishes it.
		_ = store.RecordPendingStep(r.Context(), sessionID, body.StepIndex, event)
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   stepTopic,
		GroupID: "trace-store",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			SessionID string \`json:"session_id"\`
			StepIndex int    \`json:"step_index"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		// Trace first, offset last: a crash in between replays the record into an idempotent append.
		if err := store.AppendStep(ctx, event.SessionID, event.StepIndex, map[string]any{"payload": string(msg.Value)}); err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object BrowserEvents {
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: the draft keys the record by the step index instead of the session, ships the typed values
  // in the payload "for debugging", and commits the offset before the trace append.
  def publishStep(sessionId: String, stepIndex: Int, action: String, target: String, typedInput: Map[String, String], outcome: String): Unit = {
    val payload = Map(
      "session_id" -> sessionId,
      "step_index" -> stepIndex,
      "action" -> action,
      "target_digest" -> target,
      "outcome" -> outcome,
      "typed_values" -> typedInput.toJson
    ).toJson.compactPrint
    producer.send(new ProducerRecord("browser.step", stepIndex.toString, payload))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("browser.step"))
    while (true) {
      val records = consumer.poll(Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val sessionId = event("session_id").convertTo[String]
        val stepIndex = event("step_index").convertTo[Int]
        consumer.commitSync()
        TraceStore.appendStep(sessionId, stepIndex, record.value())
      }
    }
  }
}

object TraceStore {
  def appendStep(sessionId: String, stepIndex: Int, payload: String): Unit =
    throw new UnsupportedOperationException

  def recordPendingStep(sessionId: String, stepIndex: Int, payload: String): Unit =
    throw new UnsupportedOperationException
}
`,
      solution: `import java.security.MessageDigest
import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object BrowserEvents {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  val RedactedFields = Set("password", "card", "token")

  /** Typed input never leaves the worker: only the names of the filled fields travel. */
  def redact(typedInput: Map[String, String]): List[String] =
    typedInput.keySet.filter(RedactedFields.contains).toList.sorted

  def targetDigest(target: String): String =
    MessageDigest.getInstance("SHA-256").digest(target.getBytes("UTF-8")).map("%02x".format(_)).mkString

  def publishStep(sessionId: String, stepIndex: Int, action: String, target: String, typedInput: Map[String, String], outcome: String): Unit = {
    val payload = Map(
      "session_id" -> sessionId,
      "step_index" -> stepIndex,
      "action" -> action,
      "target_digest" -> targetDigest(target),
      "outcome" -> outcome,
      "redacted_fields" -> redact(typedInput),
      "idempotency_key" -> s"$sessionId:$stepIndex"
    ).toJson.compactPrint
    try {
      producer.send(new ProducerRecord("browser.step", sessionId, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        // The broker refused the record: keep it on the state key so the relay republishes it.
        TraceStore.recordPendingStep(sessionId, stepIndex, payload)
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "trace-store")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("browser.step"))
    while (true) {
      val records = consumer.poll(Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val sessionId = event("session_id").convertTo[String]
        val stepIndex = event("step_index").convertTo[Int]
        // Trace first, offset last: a crash in between replays the record into an idempotent append.
        TraceStore.appendStep(sessionId, stepIndex, record.value())
        consumer.commitSync()
      }
    }
  }
}

object TraceStore {
  def appendStep(sessionId: String, stepIndex: Int, payload: String): Unit =
    throw new UnsupportedOperationException

  def recordPendingStep(sessionId: String, stepIndex: Int, payload: String): Unit =
    throw new UnsupportedOperationException
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

const std::string kStepTopic = "browser.step";

std::unique_ptr<RdKafka::Producer> producer;

struct SessionStore {
  // Append one redacted step to the session trace.
  void appendStep(const std::string& sessionId, int stepIndex, const json& event);
  // Durable pending step on session:{id}; a relay republishes it.
  void recordPendingStep(const std::string& sessionId, int stepIndex, const json& event);
};

SessionStore store;

// TODO: the draft keys the record by the step index instead of the session, ships the typed values in
// the payload "for debugging", and commits the offset before the trace append.
void publishStep(const std::string& sessionId, int stepIndex, const std::string& action, const std::string& target, const json& typedInput, const std::string& outcome) {
  const json event = {{"session_id", sessionId}, {"step_index", stepIndex}, {"action", action}, {"target_digest", target}, {"outcome", outcome}, {"typed_values", typedInput}};
  const auto payload = event.dump();
  const auto stepKey = std::to_string(stepIndex);
  producer->produce(kStepTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), stepKey.data(), stepKey.size(), 0, nullptr);
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "trace-store", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"browser.step"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    consumer->commitSync(msg.get());
    store.appendStep(event["session_id"].get<std::string>(), event["step_index"].get<int>(), event);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kStepTopic = "browser.step";
const std::vector<std::string> kRedactedFields = {"password", "card", "token"};

struct SessionStore {
  // Append one redacted step to the session trace.
  void appendStep(const std::string& sessionId, int stepIndex, const json& event);
  // Durable pending step on session:{id}; a relay republishes it.
  void recordPendingStep(const std::string& sessionId, int stepIndex, const json& event);
};

SessionStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// Typed input never leaves the worker: only the names of the filled fields travel.
std::vector<std::string> redact(const json& typedInput) {
  std::vector<std::string> names;
  for (const auto& field : typedInput.items()) {
    if (std::find(kRedactedFields.begin(), kRedactedFields.end(), field.key()) != kRedactedFields.end()) {
      names.push_back(field.key());
    }
  }
  return names;
}

std::string targetDigest(const std::string& target) {
  std::ostringstream out;
  out << std::hex << std::hash<std::string>{}(target);
  return out.str();
}

void publishStep(const std::string& sessionId, int stepIndex, const std::string& action, const std::string& target, const json& typedInput, const std::string& outcome) {
  const json event = {{"session_id", sessionId}, {"step_index", stepIndex}, {"action", action}, {"target_digest", targetDigest(target)}, {"outcome", outcome}, {"redacted_fields", redact(typedInput)}, {"idempotency_key", sessionId + ":" + std::to_string(stepIndex)}};
  const auto payload = event.dump();
  const auto err = producer->produce(kStepTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), sessionId.data(), sessionId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker refused the record: keep it on the state key so the relay republishes it.
    store.recordPendingStep(sessionId, stepIndex, event);
  }
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "trace-store", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"browser.step"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    // Trace first, offset last: a crash in between replays the record into an idempotent append.
    store.appendStep(event["session_id"].get<std::string>(), event["step_index"].get<int>(), event);
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  hints: [
    'The record key is the ordering contract: `key=session_id` (`Key: []byte(sessionID)`, `ProducerRecord("browser.step", sessionId, …)`). Keyed by the step index, two steps of one session land in different partitions and the trace can be replayed out of order.',
    'Redaction belongs in a helper, not in a reviewer’s habit: a `REDACTED_FIELDS` constant plus `redact(typed_input)` leave only the names of the fields the agent filled, and the target travels as a digest. The typed value itself must never be serialized or logged — "temporarily, for debugging" included.',
    'Order is the whole check. In the consumer, append the step to the trace store and commit the offset last, so a crash in between replays the record. In the producer, idempotence plus `acks=all` plus an `idempotency_key` of `{session_id}:{step_index}` make the retry safe, and a broker rejection writes `record_pending_step(...)` on `session:{id}` — the state step’s key — instead of dropping the event.',
  ],
  debrief: `The interviewer is testing whether you can review a generated Kafka path as a privacy and durability contract instead of a publish call. The draft looks fine because the demo runs in a quiet cluster on a clean page: one session, no retry, no crash, nothing typed. Four separate defects are being checked. The key is the ordering contract — keyed by the step index, a session’s trace is scattered across partitions and reassembled out of order. The payload is the privacy contract — building the event from the request body puts the password the agent typed into the topic and the log, where it outlives every retention policy. The consumer’s order is the completeness contract — commit the offset first and a crash drops a step the page really took while the offset claims it was processed; append first and the replay lands on an idempotent (session_id, step_index) append. And the producer is the retry contract — idempotence with acks=all plus an idempotency_key of {session_id}:{step_index} stops a retry duplicating a step, and record_pending_step on session:{id} keeps a rejected produce alive for the relay. The quiet one is the redaction: it never shows up in a test, only in an incident review, because the leak is a field nobody meant to publish. Real pipelines add a schema registry that refuses an unknown field, field-level encryption for the truly sensitive values, and a tombstone/replay path for traces whose offsets were committed too early.`,
};
