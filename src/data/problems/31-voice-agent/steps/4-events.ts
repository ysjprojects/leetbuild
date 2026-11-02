import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Call events keyed by session with redacted transcript refs',
  concept: 'kafka',
  file: 'events',
  focus: ['gateway', 'kafka', 'transcripts', 'consumer'],
  task: `## Task

**Starting point.** The starter takes a finished turn on \`POST /v1/voice/turns\`, publishes a \`voice.turn\` event, and the consumer stores the turn and commits, so the demo shows turns arriving. It serves the demo and hides five flaws.

**Failure mode the checks target.** A user-keyed event scatters one session's turns across partitions and loses order; raw speech in a retained topic is a data leak with a long tail; an unconfigured producer duplicates on retry; a bare counter without timings cannot be placed in time; and commit-before-process trades correctness for code that merely looks exactly-once.

- Publish **one** \`voice.turn\` event per turn with the **session id** as the message key, so one transcript assembles in order.
- The payload carries ids only: \`session_id\`, \`tenant\`, \`turn_index\`, \`started_at\`, \`ended_at\` (the timings) and \`transcript_ref\`, a reference to the stored, redacted transcript. No raw speech (\`transcript_text\`) and no audio (\`audio_bytes\`): the topic is retained for days and replicated, so content written there outlives every retention policy the call has.
- The producer is **idempotent with \`acks=all\`**, so a retried produce cannot duplicate a record.
- The consumer writes the transcript row (\`insert_turn\`) and **only then** commits the offset.`,
  sequence: {
    participants: ['Voice Gateway', 'voice.turn', 'Transcript consumer', 'Transcript store'],
    messages: [
      {from: 'Voice Gateway', to: 'voice.turn', label: 'produce · key = session_id · acks = all', kind: 'sync'},
      {from: 'voice.turn', to: 'Voice Gateway', label: 'ack / broker error', kind: 'reply'},
      {from: 'voice.turn', to: 'Transcript consumer', label: 'consume · group transcripts', kind: 'async'},
      {
        from: 'Transcript consumer',
        to: 'Transcript store',
        label: 'insert_turn(tenant, session_id, turn_index, transcript_ref)',
        kind: 'sync',
      },
      {from: 'Transcript store', to: 'Transcript consumer', label: 'row persisted', kind: 'reply'},
      {from: 'Transcript consumer', to: 'voice.turn', label: 'commit offset after the row is durable', kind: 'async'},
    ],
  },
  hints: [
    'Support pulls a transcript and the turns of two calls from the same user are shuffled together; a compliance scan then finds verbatim speech and audio blobs sitting in the topic a week later.',
    'The producer keys on the user id, so concurrent sessions share partitions; the event body copies `transcript_text` and `audio_bytes`; the producer has default acks; the consumer commits before `insert_turn`.',
    'Key by `session_id`, send `turn_index`, `started_at`, `ended_at` and `transcript_ref` only, enable idempotence with `acks=all` (KafkaJS `idempotent: true`, `acks: -1`), and call `insert_turn` before the commit.',
  ],
  checks: [
    {
      id: 'session-key',
      title: 'Keyed by session id so a transcript assembles in order',
      detail: "The message key is the session id, so one call's turns land on one partition and assemble in order.",
      match: {
        python: {all: [/key=session_id/]},
        typescript: {all: [/key:\s*sessionId\b/]},
        go: {all: [/Key:\s*\[\]byte\(sessionId\)/]},
        scala: {all: [/ProducerRecord\("voice.turn",\s*sessionId/]},
        cpp: {all: [/produce\([^;\n]*sessionId/]},
      },
    },
    {
      id: 'no-raw-speech',
      title: 'References the redacted transcript, never raw speech',
      detail: 'The event carries `transcript_ref` and no `transcript_text` or `audio_bytes` anywhere in the file.',
      match: {
        python: {all: [/transcript_ref/], none: [/transcript_text/, /audio_bytes/]},
        typescript: {all: [/transcript_ref/], none: [/transcript_text/, /audio_bytes/]},
        go: {all: [/transcript_ref/], none: [/transcript_text/, /audio_bytes/]},
        scala: {all: [/transcript_ref/], none: [/transcript_text/, /audio_bytes/]},
        cpp: {all: [/transcript_ref/], none: [/transcript_text/, /audio_bytes/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all`: `enable.idempotence` + `acks`, KafkaJS `idempotent: true` + `acks: -1`, `RequiredAcks: kafka.RequireAll` with a hash balancer.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'persist-before-commit',
      title: 'Persists the transcript before committing the offset',
      detail:
        'The consumer runs `insert_turn` before committing the offset; committing first makes a crash lose the turn.',
      match: {
        python: {order: [/insert_turn\(/, /consumer\.commit\(/]},
        typescript: {order: [/insert_turn\(/, /commitOffsets\(/]},
        go: {order: [/insertTurn\(/, /CommitMessages\(/]},
        scala: {order: [/insertTurn\(/, /commitSync\(/]},
        cpp: {order: [/insert_turn\(/, /commitSync\(/]},
      },
    },
    {
      id: 'turn-payload',
      title: 'Carries the turn index, timings and the transcript ref',
      detail:
        'The event carries `turn_index`, the timings (`started_at`, `ended_at`) and `transcript_ref`, so a consumer can place the turn in time.',
      match: {
        python: {all: [/turn_index/, /transcript_ref/]},
        typescript: {all: [/turn_index/, /transcript_ref/]},
        go: {all: [/turn_index/, /transcript_ref/]},
        scala: {all: [/turn_index/, /transcript_ref/]},
        cpp: {all: [/turn_index/, /transcript_ref/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("voice-gateway")

producer = Producer({"bootstrap.servers": "kafka:9092"})


class TurnRequest(BaseModel):
    session_id: str
    user_id: str
    turn: int
    started_at: str
    ended_at: str
    transcript_text: str
    audio_bytes: str


@app.post("/v1/voice/turns")
def post_turn(body: TurnRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    logger.info("turn session=%s user=%s text=%r", body.session_id, body.user_id, body.transcript_text)
    event = {
        "session_id": body.session_id,
        "tenant": tenant,
        "turn": body.turn,
        "started_at": body.started_at,
        "ended_at": body.ended_at,
        "text": body.transcript_text,
        "audio_bytes": body.audio_bytes,
    }
    producer.produce("voice.turn", key=body.user_id, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "transcripts", "enable.auto.commit": False}
    )
    consumer.subscribe(["voice.turn"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        store.append_turn(event["tenant"], event["session_id"], event["turn"], event["text"])


class TranscriptStore:
    def append_turn(self, tenant: str, session_id: str, turn: int, text: str) -> None:
        """Stub: appends one turn to the stored transcript in arrival order."""
        raise NotImplementedError


store = TranscriptStore()
`,
      solution: `import json
import logging

from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("voice-gateway")

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class TurnRequest(BaseModel):
    session_id: str
    turn_index: int
    started_at: str
    ended_at: str
    transcript_ref: str


@app.post("/v1/voice/turns")
def post_turn(body: TurnRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    session_id = body.session_id
    event = {
        "session_id": session_id,
        "tenant": tenant,
        "turn_index": body.turn_index,
        "started_at": body.started_at,
        "ended_at": body.ended_at,
        "transcript_ref": body.transcript_ref,
    }
    producer.produce("voice.turn", key=session_id, value=json.dumps(event))
    producer.flush(2.0)
    logger.info("turn published session=%s turn=%d", session_id, body.turn_index)
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "transcripts", "enable.auto.commit": False}
    )
    consumer.subscribe(["voice.turn"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        store.insert_turn(
            event["tenant"], event["session_id"], event["turn_index"], event["transcript_ref"]
        )
        consumer.commit(msg)


class TranscriptStore:
    def insert_turn(self, tenant: str, session_id: str, turn_index: int, transcript_ref: str) -> None:
        """Stub: one row per finished turn; the transcript reads the rows in turn_index order."""
        raise NotImplementedError


store = TranscriptStore()
`,
    },
    typescript: {
      starter: `/** voice.turn: flawed code that keys by user id and commits before the row lands. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './transcripts';

export const app = Fastify();
const kafka = new Kafka({clientId: 'voice-gateway', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface TurnBody {
  session_id: string;
  user_id: string;
  turn: number;
  started_at: string;
  ended_at: string;
  transcript_text: string;
  audio_bytes: string;
}

app.post('/v1/voice/turns', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as TurnBody;
  request.log.info({session_id: body.session_id, text: body.transcript_text}, 'turn finished');
  const event = {
    session_id: body.session_id,
    tenant,
    turn: body.turn,
    started_at: body.started_at,
    ended_at: body.ended_at,
    text: body.transcript_text,
    audio_bytes: body.audio_bytes,
  };
  await producer.send({
    topic: 'voice.turn',
    messages: [{key: body.user_id, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'transcripts'});
  await consumer.connect();
  await consumer.subscribe({topic: 'voice.turn'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        tenant: string;
        session_id: string;
        turn: number;
        text: string;
      };
      await store.appendTurn(event.tenant, event.session_id, event.turn, event.text);
    },
  });
}

void app.listen({port: 8453, host: '0.0.0.0'});
`,
      solution: `/** voice.turn: one session-keyed event per turn; the offset commits only after the row lands. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

import {store} from './transcripts';

export const app = Fastify();
const kafka = new Kafka({clientId: 'voice-gateway', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface TurnBody {
  session_id: string;
  turn_index: number;
  started_at: string;
  ended_at: string;
  transcript_ref: string;
}

app.post('/v1/voice/turns', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as TurnBody;
  const sessionId = body.session_id;
  const event = {
    session_id: sessionId,
    tenant,
    turn_index: body.turn_index,
    started_at: body.started_at,
    ended_at: body.ended_at,
    transcript_ref: body.transcript_ref,
  };
  await producer.send({
    topic: 'voice.turn',
    acks: -1,
    messages: [{key: sessionId, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'transcripts'});
  await consumer.connect();
  await consumer.subscribe({topic: 'voice.turn'});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {
        tenant: string;
        session_id: string;
        turn_index: number;
        transcript_ref: string;
      };
      await store.insert_turn(event.tenant, event.session_id, event.turn_index, event.transcript_ref);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8453, host: '0.0.0.0'});
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

var turnWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "voice.turn"}

// TranscriptStore is the durable transcript: one row per finished turn.
type TranscriptStore struct{}

func (s *TranscriptStore) appendTurn(ctx context.Context, tenant string, sessionID string, turn int, text string) error {
	return nil
}

var store = &TranscriptStore{}

type TurnRequest struct {
	SessionID      string \`json:"session_id"\`
	UserID         string \`json:"user_id"\`
	Turn           int    \`json:"turn"\`
	StartedAt      string \`json:"started_at"\`
	EndedAt        string \`json:"ended_at"\`
	TranscriptText string \`json:"transcript_text"\`
	AudioBytes     string \`json:"audio_bytes"\`
}

func postTurn(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body TurnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "bad request", http.StatusBadRequest)
		return
	}
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	log.Printf("turn session=%s user=%s text=%q", body.SessionID, body.UserID, body.TranscriptText)
	event := map[string]any{
		"session_id":  body.SessionID,
		"tenant":      tenant,
		"turn":        body.Turn,
		"started_at":  body.StartedAt,
		"ended_at":    body.EndedAt,
		"text":        body.TranscriptText,
		"audio_bytes": body.AudioBytes,
	}
	payload, _ := json.Marshal(event)
	_ = turnWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.UserID), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "voice.turn",
		GroupID: "transcripts",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			SessionID string \`json:"session_id"\`
			Tenant    string \`json:"tenant"\`
			Turn      int    \`json:"turn"\`
			Text      string \`json:"text"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		_ = store.appendTurn(ctx, event.Tenant, event.SessionID, event.Turn, event.Text)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges the record once it is replicated, and a retry of the same
// session key lands on the same partition instead of duplicating across partitions.
var turnWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "voice.turn",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

// TranscriptStore is the durable transcript: one row per finished turn, read in turn_index order.
type TranscriptStore struct{}

func (s *TranscriptStore) insertTurn(ctx context.Context, tenant string, sessionID string, turnIndex int, transcriptRef string) error {
	return nil
}

var store = &TranscriptStore{}

type TurnRequest struct {
	SessionID     string \`json:"session_id"\`
	TurnIndex     int    \`json:"turn_index"\`
	StartedAt     string \`json:"started_at"\`
	EndedAt       string \`json:"ended_at"\`
	TranscriptRef string \`json:"transcript_ref"\`
}

func postTurn(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body TurnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "bad request", http.StatusBadRequest)
		return
	}
	sessionId := body.SessionID
	event := map[string]any{
		"session_id":     sessionId,
		"tenant":         tenant,
		"turn_index":     body.TurnIndex,
		"started_at":     body.StartedAt,
		"ended_at":       body.EndedAt,
		"transcript_ref": body.TranscriptRef,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		http.Error(rw, "cannot encode event", http.StatusInternalServerError)
		return
	}
	if err := turnWriter.WriteMessages(r.Context(), kafka.Message{Key: []byte(sessionId), Value: payload}); err != nil {
		log.Printf("produce rejected session=%s turn=%d", sessionId, body.TurnIndex)
		http.Error(rw, "broker unavailable", http.StatusServiceUnavailable)
		return
	}
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) error {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   "voice.turn",
		GroupID: "transcripts",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event struct {
			SessionID     string \`json:"session_id"\`
			Tenant        string \`json:"tenant"\`
			TurnIndex     int    \`json:"turn_index"\`
			TranscriptRef string \`json:"transcript_ref"\`
		}
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			log.Printf("skipping malformed record at offset %d", msg.Offset)
			_ = reader.CommitMessages(ctx, msg)
			continue
		}
		if err := store.insertTurn(ctx, event.Tenant, event.SessionID, event.TurnIndex, event.TranscriptRef); err != nil {
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object VoiceEvents {
  val Topic = "voice.turn"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def publish(
      tenant: String,
      sessionId: String,
      userId: String,
      turn: Int,
      startedAt: String,
      endedAt: String,
      transcriptText: String,
      audioBytes: String,
  ): Unit = {
    println(s"turn session=$sessionId user=$userId text=$transcriptText")
    val payload = Map(
      "session_id" -> sessionId,
      "tenant" -> tenant,
      "turn" -> turn.toString,
      "started_at" -> startedAt,
      "ended_at" -> endedAt,
      "transcript_text" -> transcriptText,
      "audio_bytes" -> audioBytes,
    ).toJson.compactPrint
    producer.send(new ProducerRecord("voice.turn", userId, payload))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val fields = record.value().parseJson.asJsObject.fields
        appendTurn(
          fields("tenant").convertTo[String],
          fields("session_id").convertTo[String],
          fields("turn").convertTo[Int],
          fields("transcript_text").convertTo[String],
        )
      }
    }
  }

  def appendTurn(tenant: String, sessionId: String, turn: Int, text: String): Unit = {}
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object VoiceEvents {
  val Topic = "voice.turn"
  val GroupId = "transcripts"

  private val producerProps = new Properties()
  producerProps.put("bootstrap.servers", "kafka:9092")
  producerProps.put("enable.idempotence", "true")
  producerProps.put("acks", "all")
  val producer = new KafkaProducer[String, String](producerProps)

  def buildEvent(
      tenant: String,
      sessionId: String,
      turnIndex: Int,
      startedAt: String,
      endedAt: String,
      transcriptRef: String,
  ): String =
    Map(
      "session_id" -> sessionId,
      "tenant" -> tenant,
      "turn_index" -> turnIndex.toString,
      "started_at" -> startedAt,
      "ended_at" -> endedAt,
      "transcript_ref" -> transcriptRef,
    ).toJson.compactPrint

  def publish(
      tenant: String,
      sessionId: String,
      turnIndex: Int,
      startedAt: String,
      endedAt: String,
      transcriptRef: String,
  ): Unit = {
    val payload = buildEvent(tenant, sessionId, turnIndex, startedAt, endedAt, transcriptRef)
    producer.send(new ProducerRecord("voice.turn", sessionId, payload))
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, GroupId)
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(Topic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val fields = record.value().parseJson.asJsObject.fields
        insertTurn(
          fields("tenant").convertTo[String],
          fields("session_id").convertTo[String],
          fields("turn_index").convertTo[Int],
          fields("transcript_ref").convertTo[String],
        )
        consumer.commitSync()
      }
    }
  }

  // One row per finished turn; returns only once the row is durable, so the commit below it
  // replays the turn on a crash instead of losing it.
  def insertTurn(tenant: String, sessionId: String, turnIndex: Int, transcriptRef: String): Unit = {}
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

const std::string kVoiceTurnTopic = "voice.turn";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TranscriptStore is the durable transcript; append_turn adds one finished turn to it.
struct TranscriptStore {
  void append_turn(const std::string& tenant, const std::string& sessionId, int turn, const std::string& text);
};

TranscriptStore store;

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
void post_turn(const std::string& tenant, const std::string& sessionId, const std::string& userId, int turn, const std::string& startedAt, const std::string& endedAt, const std::string& transcriptText, const std::string& audioBytes) {
  std::cerr << "turn session=" << sessionId << " user=" << userId << " text=" << transcriptText << "\\n";
  const json event = {{"session_id", sessionId}, {"tenant", tenant}, {"turn", turn}, {"started_at", startedAt}, {"ended_at", endedAt}, {"transcript_text", transcriptText}, {"audio_bytes", audioBytes}};
  const auto payload = event.dump();
  producer->produce(kVoiceTurnTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), userId.data(), userId.size(), 0, nullptr);
  producer->flush(2000);
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kVoiceTurnTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    store.append_turn(event["tenant"].get<std::string>(), event["session_id"].get<std::string>(), event["turn"].get<int>(), event["transcript_text"].get<std::string>());
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

const std::string kVoiceTurnTopic = "voice.turn";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// insert_turn writes one row per finished turn; the consumer commits the offset after it returns,
// so a crash in between replays the record instead of losing the turn.
struct TranscriptStore {
  void insert_turn(const std::string& tenant, const std::string& sessionId, int turnIndex, const std::string& transcriptRef);
};

TranscriptStore store;

void post_turn(const std::string& tenant, const std::string& sessionId, int turnIndex, const std::string& startedAt, const std::string& endedAt, const std::string& transcriptRef) {
  const json event = {{"session_id", sessionId}, {"tenant", tenant}, {"turn_index", turnIndex}, {"started_at", startedAt}, {"ended_at", endedAt}, {"transcript_ref", transcriptRef}};
  const auto payload = event.dump();
  producer->produce(kVoiceTurnTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), sessionId.data(), sessionId.size(), 0, nullptr);
  producer->flush(2000);
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kVoiceTurnTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    store.insert_turn(event["tenant"].get<std::string>(), event["session_id"].get<std::string>(), event["turn_index"].get<int>(), event["transcript_ref"].get<std::string>());
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  debrief: `The fix follows the two contracts a topic does not renegotiate. The partition key is the unit of ordering: Kafka orders records only within a partition, so keying every turn by the session id keeps one call's turns together and lets the consumer assemble them in \`turn_index\` order, while a user key interleaves two concurrent calls. Retention is the second: a replicated topic keeps whatever you write into it long after the request, the tenant and the policy that produced it are gone, so the event carries ids, timings and a \`transcript_ref\` into storage that redacts and expires on its own schedule. \`insert_turn\` before the commit, with an idempotent \`acks=all\` producer on the other side, turns a crash into a replay instead of a lost turn. Production pipelines also enforce the payload shape with a schema registry and route rows the transcript store cannot apply to a dead-letter topic.`,
};
