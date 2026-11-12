import type {Step} from '@/lib/types';

export const completionTelemetryStep: Step = {
  id: 'completion-telemetry',
  title: 'completion.shown / completion.accepted: ids and sizes, not the code',
  concept: 'kafka',
  file: 'telemetry',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/telemetry\`, where the editor reports
\`{"event": "shown" | "accepted", "request_id", "language", "text", "latency_ms"}\` for a completion
it showed or the developer kept. It produces the report to \`completion.{event}\` keyed by the
request id with a default producer, and \`consume()\` reads both topics in group \`acceptance\`,
commits each record, then runs \`HINCRBY acceptance:{language} {event} 1\`. The dashboard shows
numbers. It hides four flaws.

**Failure mode the checks target.** Keying by request id scatters one session's events across
partitions; a retry after a lost acknowledgement counts an acceptance twice; the suggestion's text
in the topic and the log is source code with a long retention; and committing first loses a count
whenever the consumer dies between the commit and the write.

- \`X-Session-Id\` is required (**401**); an \`event\` outside \`ALLOWED_EVENTS\` is **400**. Publish
  \`{request_id, session, language, candidate_len, latency_ms}\` keyed by the **session**.
- No suggestion text in the event or any log line: report \`candidate_len\`.
- The producer is **idempotent** with **\`acks=all\`** (Go: confluent-kafka-go, since kafka-go has
  no idempotent producer).
- The consumer runs with auto-commit off, \`HINCRBY\` first and **only then** commits.`,
  sequence: {
    participants: ['Editor', 'completiond', 'completion.accepted', 'Acceptance consumer', 'Redis'],
    messages: [
      {
        from: 'Editor',
        to: 'completiond',
        label: 'POST /v1/telemetry {event: accepted, request_id, candidate_len}',
        kind: 'sync',
      },
      {
        from: 'completiond',
        to: 'completion.accepted',
        label: 'produce · key = session · idempotent · acks = all',
        kind: 'sync',
      },
      {from: 'completion.accepted', to: 'completiond', label: 'ack', kind: 'reply'},
      {from: 'completiond', to: 'Editor', label: '202 {accepted: true}', kind: 'reply'},
      {from: 'completion.accepted', to: 'Acceptance consumer', label: 'consume · group acceptance', kind: 'async'},
      {from: 'Acceptance consumer', to: 'Redis', label: 'HINCRBY acceptance:python accepted 1', kind: 'sync'},
      {from: 'Acceptance consumer', to: 'completion.accepted', label: 'commit after the write', kind: 'async'},
    ],
  },
  hints: [
    "The acceptance rate drifts after every consumer restart, a broker hiccup counts one acceptance twice, a stranger's event name creates a topic, and the topic now holds the suggestions developers accepted.",
    "The record key is the request id, the producer has neither idempotence nor `acks=all`, the body's `text` is logged and copied into the event, and the consumer commits before `HINCRBY`.",
    'Key by the session after a 401/400 guard, set `enable.idempotence` with `acks=all`, publish `candidate_len` instead of `text`, and turn auto-commit off with `consumer.commit(msg)` after `r.hincrby`.',
  ],
  checks: [
    {
      id: 'session-key',
      title: 'Keyed by session, with a session and a known event required',
      detail:
        "Every record is keyed by the session, so one developer's events share a partition and stay in order; a report without `X-Session-Id` is **401** and an event outside `ALLOWED_EVENTS` is **400** with nothing produced. The starter keys by the request id and produces to whatever topic the body names.",
      match: {
        python: {all: [/key\s*=\s*session/, /ALLOWED_EVENTS/, /\b401\b/]},
        typescript: {all: [/key:\s*session\b/, /ALLOWED_EVENTS/, /code\(\s*401\s*\)/]},
        go: {all: [/Key:\s*\[\]byte\(session\)/, /allowedEvents/, /StatusUnauthorized/]},
        scala: {all: [/ProducerRecord\[String,\s*String\]\([^,]+,\s*session,/, /AllowedEvents/, /Unauthorized/]},
        cpp: {all: [/session\.data\(\),\s*session\.size\(\)/, /kAllowedEvents/, /\b401\b/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        "The producer is idempotent with `acks=all` (`enable.idempotence` plus `acks`, kafkajs `idempotent: true` with `acks: -1`), so a retry after a lost acknowledgement writes the event once. The starter's default producer writes it twice.",
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/"enable\.idempotence":\s*true/, /"acks":\s*"all"/]},
        scala: {all: [/put\("enable\.idempotence",\s*"true"\)/, /put\("acks",\s*"all"\)/]},
        cpp: {all: [/set\("enable\.idempotence",\s*"true"/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-code',
      title: 'No suggestion text in the event or the logs',
      detail:
        "Neither the event nor a log line carries the suggestion's text; the event reports `candidate_len`. The starter accepts a `text` field, logs it and copies it into the event.",
      match: {
        python: {all: [/["']candidate_len["']\s*:/], none: [/\btext\b/]},
        typescript: {all: [/candidate_len\s*:/], none: [/\btext\b/]},
        go: {all: [/"candidate_len"/], none: [/\bText\b|"text"/]},
        scala: {all: [/"candidate_len"/], none: [/"text"|\.text\b/]},
        cpp: {all: [/"candidate_len"/], none: [/"text"/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Updates the counter before committing the offset',
      detail:
        'The consumer runs with auto-commit off, `HINCRBY acceptance:{language} {event} 1` first and commits the record after it, so a crash between the two replays the record instead of losing the count. The starter commits first.',
      match: {
        python: {order: [/r\.hincrby\(/, /consumer\.commit\(/], all: [/["']enable\.auto\.commit["']\s*:\s*False/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/], all: [/autoCommit:\s*false/]},
        go: {order: [/\.HIncrBy\(/, /\.CommitMessage\(/], all: [/"enable\.auto\.commit":\s*false/]},
        scala: {order: [/\.hincrBy\(/, /commitSync\(/], all: [/put\("enable\.auto\.commit",\s*"false"\)/]},
        cpp: {order: [/\.hincrby\(/, /commitSync\(/], all: [/set\("enable\.auto\.commit",\s*"false"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Request
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("completiond.telemetry")
logger.setLevel(logging.INFO)

TOPICS = ["completion.shown", "completion.accepted"]

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class TelemetryReport(BaseModel):
    event: str
    request_id: str
    language: str
    text: str = ""
    latency_ms: int = 0


@app.post("/v1/telemetry", status_code=202)
def telemetry(body: TelemetryReport, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    session = request.headers.get("x-session-id", "")
    logger.info("telemetry session=%s event=%s text=%r", session, body.event, body.text)
    event = {
        "request_id": body.request_id,
        "session": session,
        "language": body.language,
        "text": body.text,
        "latency_ms": body.latency_ms,
    }
    producer.produce(f"completion.{body.event}", key=body.request_id, value=json.dumps(event))
    producer.flush(2.0)
    return {"accepted": True}


def consume() -> None:
    """Count every shown and accepted event into acceptance:{language}."""
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "acceptance", "auto.offset.reset": "earliest"})
    consumer.subscribe(TOPICS)
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        consumer.commit(message=msg, asynchronous=False)
        event = json.loads(msg.value())
        r.hincrby(f"acceptance:{event['language']}", msg.topic().split(".", 1)[1], 1)
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("completiond.telemetry")
logger.setLevel(logging.INFO)

ALLOWED_EVENTS = ("shown", "accepted")
TOPICS = ["completion.shown", "completion.accepted"]

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,  # a retry after a lost acknowledgement writes the event once
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class TelemetryReport(BaseModel):
    event: str
    request_id: str
    language: str
    candidate_len: int = 0
    latency_ms: int = 0


@app.post("/v1/telemetry", status_code=202)
def telemetry(body: TelemetryReport, request: Request) -> dict:
    session = request.headers.get("x-session-id", "")
    if session == "":
        raise HTTPException(status_code=401, detail="X-Session-Id is required")
    if body.event not in ALLOWED_EVENTS:
        raise HTTPException(status_code=400, detail="event must be shown or accepted")
    event = {
        "request_id": body.request_id,
        "session": session,
        "language": body.language,
        "candidate_len": body.candidate_len,
        "latency_ms": body.latency_ms,
    }
    producer.produce(f"completion.{body.event}", key=session, value=json.dumps(event))
    producer.flush(2.0)
    logger.info(
        "telemetry session=%s event=%s request_id=%s candidate_len=%d",
        session,
        body.event,
        body.request_id,
        body.candidate_len,
    )
    return {"accepted": True}


def consume() -> None:
    """Count every shown and accepted event into acceptance:{language}, committing each record after its count."""
    consumer = Consumer(
        {
            "bootstrap.servers": "kafka:9092",
            "group.id": "acceptance",
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe(TOPICS)
    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.error():
            continue
        event = json.loads(msg.value())
        r.hincrby(f"acceptance:{event['language']}", msg.topic().split(".", 1)[1], 1)
        consumer.commit(message=msg, asynchronous=False)  # a crash before this line replays the record
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const TOPICS = ['completion.shown', 'completion.accepted'];

export const app = Fastify({logger: true});
const kafka = new Kafka({clientId: 'completiond', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

interface TelemetryReport {
  event: string;
  request_id: string;
  language: string;
  text?: string;
  latency_ms?: number;
}

app.post('/v1/telemetry', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const session = String(request.headers['x-session-id'] ?? '');
  const body = request.body as TelemetryReport;
  request.log.info({session, event: body.event, text: body.text}, 'telemetry');
  const event = {request_id: body.request_id, session, language: body.language, text: body.text, latency_ms: body.latency_ms ?? 0};
  await producer.send({topic: \`completion.\${body.event}\`, messages: [{key: body.request_id, value: JSON.stringify(event)}]});
  return reply.code(202).send({accepted: true});
});

/** Count every shown and accepted event into acceptance:{language}. */
export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'acceptance'});
  await consumer.connect();
  await consumer.subscribe({topics: TOPICS, fromBeginning: true});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}');
      await redis.hincrby(\`acceptance:\${event.language}\`, topic.split('.')[1], 1);
    },
  });
}
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

export const ALLOWED_EVENTS = ['shown', 'accepted'];
export const TOPICS = ['completion.shown', 'completion.accepted'];

export const app = Fastify({logger: true});
const kafka = new Kafka({clientId: 'completiond', brokers: ['kafka:9092']});
// Idempotent: a retry after a lost acknowledgement writes the event once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();
const redis = new Redis({host: 'redis', port: 6379});

interface TelemetryReport {
  event: string;
  request_id: string;
  language: string;
  candidate_len?: number;
  latency_ms?: number;
}

app.post('/v1/telemetry', async (request, reply) => {
  const session = request.headers['x-session-id'];
  if (typeof session !== 'string' || session === '') return reply.code(401).send({error: 'X-Session-Id is required'});
  const body = request.body as TelemetryReport;
  if (!ALLOWED_EVENTS.includes(body.event)) return reply.code(400).send({error: 'event must be shown or accepted'});
  const event = {
    request_id: body.request_id,
    session,
    language: body.language,
    candidate_len: body.candidate_len ?? 0,
    latency_ms: body.latency_ms ?? 0,
  };
  await producer.send({
    topic: \`completion.\${body.event}\`,
    messages: [{key: session, value: JSON.stringify(event)}],
    acks: -1,
  });
  request.log.info({session, event: body.event, request_id: body.request_id, candidate_len: event.candidate_len}, 'telemetry');
  return reply.code(202).send({accepted: true});
});

/** Count every shown and accepted event into acceptance:{language}, committing each record after its count. */
export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'acceptance'});
  await consumer.connect();
  await consumer.subscribe({topics: TOPICS, fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}');
      await redis.hincrby(\`acceptance:\${event.language}\`, topic.split('.')[1], 1);
      // A crash before this line replays the record.
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"
)

var topics = []string{"completion.shown", "completion.accepted"}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092"})
	if err != nil {
		panic(err)
	}
	return p
}

type telemetryReport struct {
	Event     string \`json:"event"\`
	RequestID string \`json:"request_id"\`
	Language  string \`json:"language"\`
	Text      string \`json:"text"\`
	LatencyMS int    \`json:"latency_ms"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func telemetry(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	session := r.Header.Get("X-Session-Id")
	var body telemetryReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	log.Printf("telemetry session=%s event=%s text=%q", session, body.Event, body.Text)
	value, _ := json.Marshal(map[string]any{
		"request_id": body.RequestID,
		"session":    session,
		"language":   body.Language,
		"text":       body.Text,
		"latency_ms": body.LatencyMS,
	})
	topic := "completion." + body.Event
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(body.RequestID), Value: value}
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(2 * time.Second):
			err = context.DeadlineExceeded
		}
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "telemetry unavailable"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]bool{"accepted": true})
}

// consume counts every shown and accepted event into acceptance:{language}.
func consume(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "group.id": "acceptance", "auto.offset.reset": "earliest"})
	if err != nil {
		return err
	}
	defer consumer.Close()
	if err := consumer.SubscribeTopics(topics, nil); err != nil {
		return err
	}
	for ctx.Err() == nil {
		msg, err := consumer.ReadMessage(time.Second)
		if err != nil {
			continue
		}
		if _, err := consumer.CommitMessage(msg); err != nil {
			return err
		}
		var event struct {
			Language string \`json:"language"\`
		}
		json.Unmarshal(msg.Value, &event)
		outcome := strings.TrimPrefix(*msg.TopicPartition.Topic, "completion.")
		if err := rdb.HIncrBy(ctx, "acceptance:"+event.Language, outcome, 1).Err(); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/telemetry", telemetry)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"
)

var allowedEvents = map[string]bool{"shown": true, "accepted": true}
var topics = []string{"completion.shown", "completion.accepted"}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// confluent-kafka-go, not kafka-go: kafka-go has no idempotent producer.
var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"enable.idempotence": true, // a retry after a lost acknowledgement writes the event once
		"acks":               "all",
	})
	if err != nil {
		panic(err)
	}
	return p
}

type telemetryReport struct {
	Event        string \`json:"event"\`
	RequestID    string \`json:"request_id"\`
	Language     string \`json:"language"\`
	CandidateLen int    \`json:"candidate_len"\`
	LatencyMS    int    \`json:"latency_ms"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func telemetry(rw http.ResponseWriter, r *http.Request) {
	session := r.Header.Get("X-Session-Id")
	if session == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Session-Id is required"})
		return
	}
	var body telemetryReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !allowedEvents[body.Event] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "event must be shown or accepted"})
		return
	}
	value, _ := json.Marshal(map[string]any{
		"request_id":    body.RequestID,
		"session":       session,
		"language":      body.Language,
		"candidate_len": body.CandidateLen,
		"latency_ms":    body.LatencyMS,
	})
	topic := "completion." + body.Event
	deliveries := make(chan kafka.Event, 1)
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny}, Key: []byte(session), Value: value}
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(2 * time.Second):
			err = context.DeadlineExceeded
		}
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "telemetry unavailable"})
		return
	}
	log.Printf("telemetry session=%s event=%s request_id=%s candidate_len=%d", session, body.Event, body.RequestID, body.CandidateLen)
	writeJSON(rw, http.StatusAccepted, map[string]bool{"accepted": true})
}

// consume counts every shown and accepted event into acceptance:{language}, committing each record after its count.
func consume(ctx context.Context) error {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"group.id":           "acceptance",
		"auto.offset.reset":  "earliest",
		"enable.auto.commit": false,
	})
	if err != nil {
		return err
	}
	defer consumer.Close()
	if err := consumer.SubscribeTopics(topics, nil); err != nil {
		return err
	}
	for ctx.Err() == nil {
		msg, err := consumer.ReadMessage(time.Second)
		if err != nil {
			continue
		}
		var event struct {
			Language string \`json:"language"\`
		}
		json.Unmarshal(msg.Value, &event)
		outcome := strings.TrimPrefix(*msg.TopicPartition.Topic, "completion.")
		if err := rdb.HIncrBy(ctx, "acceptance:"+event.Language, outcome, 1).Err(); err != nil {
			return err
		}
		if _, err := consumer.CommitMessage(msg); err != nil { // a crash before this line replays the record
			return err
		}
	}
	return ctx.Err()
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/telemetry", telemetry)
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

object Telemetry {
  val Topics: List[String] = List("completion.shown", "completion.accepted")

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }
  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "telemetry") {
    post {
      optionalHeaderValueByName("X-Session-Id") { header =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val session = header.getOrElse("")
          val body = raw.parseJson.asJsObject.fields
          def field(name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
          val event = field("event")
          System.err.println(s"telemetry session=$session event=$event text=\${field("text")}")
          val payload = JsObject(
            "request_id" -> JsString(field("request_id")),
            "session" -> JsString(session),
            "language" -> JsString(field("language")),
            "text" -> JsString(field("text")),
            "latency_ms" -> body.getOrElse("latency_ms", JsNumber(0))
          )
          producer.send(new ProducerRecord[String, String](s"completion.$event", field("request_id"), payload.compactPrint)).get(2, TimeUnit.SECONDS)
          complete(json(StatusCodes.Accepted, JsObject("accepted" -> JsBoolean(true))))
        }
      }
    }
  }

  /** Count every shown and accepted event into acceptance:{language}. */
  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "acceptance")
    props.put("auto.offset.reset", "earliest")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(Topics.asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        consumer.commitSync(Map(new TopicPartition(record.topic(), record.partition()) -> new OffsetAndMetadata(record.offset() + 1)).asJava)
        val language = record.value().parseJson.asJsObject.fields.get("language").collect { case JsString(s) => s }.getOrElse("")
        jedis.hincrBy(s"acceptance:$language", record.topic().stripPrefix("completion."), 1)
      }
    }
  }
}
`,
      solution: `import java.time.Duration
import java.util.Properties
import java.util.concurrent.TimeUnit

import org.apache.kafka.clients.consumer.{KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.{StringDeserializer, StringSerializer}
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

object Telemetry {
  val AllowedEvents: Set[String] = Set("shown", "accepted")
  val Topics: List[String] = List("completion.shown", "completion.accepted")

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true") // a retry after a lost acknowledgement writes the event once
    props.put("acks", "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }
  val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "telemetry") {
    post {
      optionalHeaderValueByName("X-Session-Id") {
        case None | Some("") =>
          complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Session-Id is required"))))
        case Some(session) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            def field(name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
            val event = field("event")
            if (!AllowedEvents(event)) complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("event must be shown or accepted"))))
            else {
              val candidateLen = body.getOrElse("candidate_len", JsNumber(0))
              val payload = JsObject(
                "request_id" -> JsString(field("request_id")),
                "session" -> JsString(session),
                "language" -> JsString(field("language")),
                "candidate_len" -> candidateLen,
                "latency_ms" -> body.getOrElse("latency_ms", JsNumber(0))
              )
              producer.send(new ProducerRecord[String, String](s"completion.$event", session, payload.compactPrint)).get(2, TimeUnit.SECONDS)
              System.err.println(s"telemetry session=$session event=$event request_id=\${field("request_id")} candidate_len=$candidateLen")
              complete(json(StatusCodes.Accepted, JsObject("accepted" -> JsBoolean(true))))
            }
          }
      }
    }
  }

  /** Count every shown and accepted event into acceptance:{language}, committing each record after its count. */
  def consume(): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", "acceptance")
    props.put("auto.offset.reset", "earliest")
    props.put("enable.auto.commit", "false")
    val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
    consumer.subscribe(Topics.asJava)
    while (true) {
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val language = record.value().parseJson.asJsObject.fields.get("language").collect { case JsString(s) => s }.getOrElse("")
        jedis.hincrBy(s"acceptance:$language", record.topic().stripPrefix("completion."), 1)
        // A crash before this line replays the record.
        consumer.commitSync(Map(new TopicPartition(record.topic(), record.partition()) -> new OffsetAndMetadata(record.offset() + 1)).asJava)
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::vector<std::string> kTopics = {"completion.shown", "completion.accepted"};

// The delivery report of the record in flight: the handler produces one record and waits for it.
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
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void telemetry(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string session = req.get_header_value("X-Session-Id");
  const json body = json::parse(req.body);
  const std::string event = body.value("event", "");
  const std::string request_id = body.value("request_id", "");
  std::cerr << "telemetry session=" << session << " event=" << event << " text=" << body.value("text", "") << "\\n";
  const std::string value = json{{"request_id", request_id},
                                 {"session", session},
                                 {"language", body.value("language", "")},
                                 {"text", body.value("text", "")},
                                 {"latency_ms", body.value("latency_ms", 0)}}
                                .dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce("completion." + event, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                             const_cast<char*>(value.data()), value.size(), request_id.data(), request_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(2000);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) return reply(res, 503, {{"error", "telemetry unavailable"}});
  reply(res, 202, {{"accepted", true}});
}

// Count every shown and accepted event into acceptance:{language}.
void consume() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "acceptance", err);
  conf->set("auto.offset.reset", "earliest", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe(kTopics);
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync(msg.get());
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    const std::string topic = msg->topic_name();
    redis().hincrby("acceptance:" + event.value("language", ""), topic.substr(topic.find('.') + 1), 1);
  }
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/telemetry", telemetry); }
`,
      solution: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::set<std::string> kAllowedEvents = {"shown", "accepted"};
const std::vector<std::string> kTopics = {"completion.shown", "completion.accepted"};

// The delivery report of the record in flight: the handler produces one record and waits for it.
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
  conf->set("enable.idempotence", "true", err);  // a retry after a lost acknowledgement writes the event once
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void telemetry(const httplib::Request& req, httplib::Response& res) {
  const std::string session = req.get_header_value("X-Session-Id");
  if (session.empty()) return reply(res, 401, {{"error", "X-Session-Id is required"}});
  const json body = json::parse(req.body);
  const std::string event = body.value("event", "");
  if (kAllowedEvents.count(event) == 0) return reply(res, 400, {{"error", "event must be shown or accepted"}});
  const std::string request_id = body.value("request_id", "");
  const int candidate_len = body.value("candidate_len", 0);
  const std::string value = json{{"request_id", request_id},
                                 {"session", session},
                                 {"language", body.value("language", "")},
                                 {"candidate_len", candidate_len},
                                 {"latency_ms", body.value("latency_ms", 0)}}
                                .dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce("completion." + event, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                             const_cast<char*>(value.data()), value.size(), session.data(), session.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(2000);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) return reply(res, 503, {{"error", "telemetry unavailable"}});
  std::cerr << "telemetry session=" << session << " event=" << event << " request_id=" << request_id << " candidate_len=" << candidate_len << "\\n";
  reply(res, 202, {{"accepted", true}});
}

// Count every shown and accepted event into acceptance:{language}, committing each record after its count.
void consume() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "acceptance", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe(kTopics);
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    const std::string topic = msg->topic_name();
    redis().hincrby("acceptance:" + event.value("language", ""), topic.substr(topic.find('.') + 1), 1);
    consumer->commitSync(msg.get());  // a crash before this line replays the record
  }
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/telemetry", telemetry); }
`,
    },
  },
  harness: {
    python: `import contextlib
import io
import json
import logging

SESSION = {"X-Session-Id": "s-ada"}
SHOWN, ACCEPTED = "completion.shown", "completion.accepted"
CANARY = "CANARY_7731"


def _report(event="accepted", request_id="req-1", **extra):
    body = {"event": event, "request_id": request_id, "language": "python", "candidate_len": 18, "latency_ms": 210}
    body.update(extra)
    return body


def _app(ctx):
    m = ctx.load("telemetry")
    return m, ctx.client(m.app)


async def check_session_key(ctx):
    m, client = _app(ctx)
    async with client as c:
        for event, request_id in (("shown", "req-1"), ("accepted", "req-1"), ("shown", "req-2")):
            r = await c.post("/v1/telemetry", json=_report(event, request_id), headers=SESSION)
            assert r.status_code == 202, f"POST /v1/telemetry ({event}) answered {r.status_code}: {r.text}"
        keys = ctx.kafka.keys(SHOWN) + ctx.kafka.keys(ACCEPTED)
        assert keys == [b"s-ada"] * 3, f"records must be keyed by the session, got {keys}: keyed by request id, one session's events land on several partitions"
        events = [json.loads(v) for v in ctx.kafka.values(SHOWN)]
        assert [e.get("request_id") for e in events] == ["req-1", "req-2"] and all(e.get("session") == "s-ada" for e in events), f"each event carries its request_id and session, got {events}"
        before = sorted(ctx.kafka.topics)
        bad = await c.post("/v1/telemetry", json=_report("copied"), headers=SESSION)
        assert bad.status_code == 400, f"an event outside ALLOWED_EVENTS answered {bad.status_code}, expected 400"
        assert sorted(ctx.kafka.topics) == before, f"an unknown event created a topic: {sorted(ctx.kafka.topics)}"
        anon = await c.post("/v1/telemetry", json=_report())
    assert anon.status_code == 401, f"a report without X-Session-Id answered {anon.status_code}, expected 401"
    assert len(ctx.kafka.records(ACCEPTED)) == 1, "a report without a session reached the topic"


async def check_idempotent_acks(ctx):
    m, client = _app(ctx)
    ctx.kafka.lose_acks(ACCEPTED, 1)  # the broker wrote it, the acknowledgement never arrived
    async with client as c:
        r = await c.post("/v1/telemetry", json=_report(), headers=SESSION)
    assert r.status_code == 202, f"POST /v1/telemetry answered {r.status_code}: {r.text}"
    records = ctx.kafka.records(ACCEPTED)
    assert len(records) == 1, f"one acceptance whose acknowledgement was lost left {len(records)} records: the producer's retry wrote it twice. Make the producer idempotent with acks=all"


async def check_no_code(ctx):
    m, client = _app(ctx)
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    logging.getLogger().addHandler(handler)
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            async with client as c:
                r = await c.post("/v1/telemetry", json=_report(text=f"conn.cursor()  # {CANARY}", candidate_len=30), headers=SESSION)
    finally:
        logging.getLogger().removeHandler(handler)
    assert r.status_code == 202, f"POST /v1/telemetry answered {r.status_code}: {r.text}"
    values = ctx.kafka.values(ACCEPTED)
    assert len(values) == 1, f"one report produced {len(values)} records"
    assert CANARY.encode() not in values[0], f"the event carries the suggestion's text: {values[0]!r}"
    event = json.loads(values[0])
    assert event.get("candidate_len") == 30 and "text" not in event, f"the event reports candidate_len and no text, got {event}"
    assert CANARY not in captured.getvalue(), f"the suggestion's text reached a log line: {captured.getvalue().strip()!r}"


def check_counters_before_commit(ctx):
    for i in range(3):
        ctx.kafka.seed(ACCEPTED, key="s-ada", value=json.dumps({"request_id": f"req-{i}", "session": "s-ada", "language": "python", "candidate_len": 18, "latency_ms": 200}), partition=0)
    for i in range(2):
        ctx.kafka.seed(SHOWN, key="s-ada", value=json.dumps({"request_id": f"req-{i}", "session": "s-ada", "language": "python", "candidate_len": 18, "latency_ms": 200}), partition=0)
    early = []

    def hook(group, offsets):
        for (topic, partition), offset in offsets.items():
            counted = int(ctx.redis.hget("acceptance:python", topic.split(".", 1)[1]) or 0)
            if counted < offset:
                early.append(f"{topic}[{partition}] was committed to offset {offset} with only {counted} counted")

    ctx.kafka.on_commit(hook)
    m = ctx.load("telemetry")
    ctx.drain(m.consume)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "auto-commit is on: offsets are committed on a timer, whatever the counter holds"
    assert not early, f"{early[0]}: the commit ran before HINCRBY, so a crash between them loses the count"
    counts = ctx.redis.hgetall("acceptance:python")
    assert counts == {"accepted": "3", "shown": "2"}, f"acceptance:python must read accepted 3, shown 2, got {counts}"
    assert ctx.kafka.lag("acceptance", ACCEPTED) == 0 and ctx.kafka.lag("acceptance", SHOWN) == 0, "every counted record must be committed"
`,
    typescript: `const SESSION = {'X-Session-Id': 's-ada'};
const SHOWN = 'completion.shown';
const ACCEPTED = 'completion.accepted';
const CANARY = 'CANARY_7731';

const report = (event = 'accepted', requestId = 'req-1', extra = {}) => ({
  event,
  request_id: requestId,
  language: 'python',
  candidate_len: 18,
  latency_ms: 210,
  ...extra,
});

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_session_key(ctx) {
  const m = ctx.load('telemetry');
  const c = ctx.client(m.app);
  for (const [event, requestId] of [['shown', 'req-1'], ['accepted', 'req-1'], ['shown', 'req-2']]) {
    const r = await c.post('/v1/telemetry', {json: report(event, requestId), headers: SESSION});
    assert.equal(r.status, 202, \`POST /v1/telemetry (\${event}) answered \${r.status}: \${r.text}\`);
  }
  await settle();
  const keys = [...ctx.kafka.records(SHOWN), ...ctx.kafka.records(ACCEPTED)].map(r => r.key?.toString() ?? null);
  assert.deepEqual(keys, ['s-ada', 's-ada', 's-ada'], \`records must be keyed by the session, got \${JSON.stringify(keys)}: keyed by request id, one session's events land on several partitions\`);
  const events = ctx.kafka.records(SHOWN).map(r => JSON.parse(r.value.toString()));
  assert(events.map(e => e.request_id).join() === 'req-1,req-2' && events.every(e => e.session === 's-ada'), \`each event carries its request_id and session, got \${JSON.stringify(events)}\`);
  const before = ctx.kafka.topics.size;
  const bad = await c.post('/v1/telemetry', {json: report('copied'), headers: SESSION});
  assert.equal(bad.status, 400, \`an event outside ALLOWED_EVENTS answered \${bad.status}, expected 400\`);
  assert.equal(ctx.kafka.topics.size, before, \`an unknown event created a topic: \${JSON.stringify([...ctx.kafka.topics.keys()])}\`);
  const anon = await c.post('/v1/telemetry', {json: report()});
  assert.equal(anon.status, 401, \`a report without X-Session-Id answered \${anon.status}, expected 401\`);
  await settle();
  assert.equal(ctx.kafka.records(ACCEPTED).length, 1, 'a report without a session reached the topic');
}

export async function check_idempotent_acks(ctx) {
  const m = ctx.load('telemetry');
  ctx.kafka.loseAcks(ACCEPTED, 1); // the broker wrote it, the acknowledgement never arrived
  const r = await ctx.client(m.app).post('/v1/telemetry', {json: report(), headers: SESSION});
  assert.equal(r.status, 202, \`POST /v1/telemetry answered \${r.status}: \${r.text}\`);
  await settle();
  const records = ctx.kafka.records(ACCEPTED);
  assert.equal(records.length, 1, \`one acceptance whose acknowledgement was lost left \${records.length} records: the producer's retry wrote it twice. Make the producer idempotent with acks=all\`);
}

export async function check_no_code(ctx) {
  const m = ctx.load('telemetry');
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  let r;
  try {
    r = await ctx.client(m.app).post('/v1/telemetry', {json: report('accepted', 'req-1', {text: \`conn.cursor()  # \${CANARY}\`, candidate_len: 30}), headers: SESSION});
    await settle();
  } finally {
    Object.assign(console, prior);
  }
  assert.equal(r.status, 202, \`POST /v1/telemetry answered \${r.status}: \${r.text}\`);
  const values = ctx.kafka.records(ACCEPTED).map(rec => rec.value.toString());
  assert.equal(values.length, 1, \`one report produced \${values.length} records\`);
  assert(!values[0].includes(CANARY), \`the event carries the suggestion's text: \${values[0]}\`);
  const event = JSON.parse(values[0]);
  assert(event.candidate_len === 30 && !('text' in event), \`the event reports candidate_len and no text, got \${values[0]}\`);
  const leak = logged.find(line => line.includes(CANARY));
  assert(leak === undefined, \`the suggestion's text reached a log line: \${leak}\`);
}

export async function check_counters_before_commit(ctx) {
  const value = (i: number) => JSON.stringify({request_id: \`req-\${i}\`, session: 's-ada', language: 'python', candidate_len: 18, latency_ms: 200});
  for (let i = 0; i < 3; i++) ctx.kafka.seed(ACCEPTED, {key: 's-ada', value: value(i), partition: 0});
  for (let i = 0; i < 2; i++) ctx.kafka.seed(SHOWN, {key: 's-ada', value: value(i), partition: 0});
  const early: string[] = [];
  ctx.kafka.onCommit((group, offsets: Map<string, number>) => {
    for (const [tp, offset] of offsets) {
      const [topic, partition] = tp.split('|');
      const counted = Number(ctx.redis.hget('acceptance:python', topic.split('.')[1]) ?? 0);
      if (counted < offset) early.push(\`\${topic}[\${partition}] was committed to offset \${offset} with only \${counted} counted\`);
    }
  });
  const m = ctx.load('telemetry');
  await ctx.drain(m.consume());
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'auto-commit is on: offsets are committed on a timer, whatever the counter holds');
  assert(early.length === 0, \`\${early[0]}: the commit ran before HINCRBY, so a crash between them loses the count\`);
  const counts = ctx.redis.hgetall('acceptance:python');
  assert.deepEqual(counts, {accepted: '3', shown: '2'}, \`acceptance:python must read accepted 3, shown 2, got \${JSON.stringify(counts)}\`);
  assert(ctx.kafka.lag('acceptance', ACCEPTED) === 0 && ctx.kafka.lag('acceptance', SHOWN) === 0, 'every counted record must be committed');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	telShown    = "completion.shown"
	telAccepted = "completion.accepted"
	telCanary   = "CANARY_7731"
)

func telApp(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func telReport(event, requestID string, extra map[string]any) map[string]any {
	body := map[string]any{"event": event, "request_id": requestID, "language": "python", "candidate_len": 18, "latency_ms": 210}
	for k, v := range extra {
		body[k] = v
	}
	return body
}

func CheckSessionKey(ctx *harness.Ctx) {
	c := telApp(ctx)
	for _, report := range [][2]string{{"shown", "req-1"}, {"accepted", "req-1"}, {"shown", "req-2"}} {
		r := c.Post("/v1/telemetry", telReport(report[0], report[1], nil), "X-Session-Id", "s-ada")
		ctx.Equal(r.Status, 202, "POST /v1/telemetry (%s): %s", report[0], r.Text())
	}
	keys := append(ctx.Kafka.Keys(telShown), ctx.Kafka.Keys(telAccepted)...)
	ctx.Equal(keys, []string{"s-ada", "s-ada", "s-ada"}, "records must be keyed by the session (keyed by request id, one session's events land on several partitions)")
	ids := []string{}
	for _, v := range ctx.Kafka.Values(telShown) {
		var e map[string]any
		json.Unmarshal([]byte(v), &e)
		ctx.Equal(e["session"], "s-ada", "each event carries its session (%s)", v)
		id, _ := e["request_id"].(string)
		ids = append(ids, id)
	}
	ctx.Equal(ids, []string{"req-1", "req-2"}, "each event carries its request_id")
	before := len(ctx.Kafka.Topics())
	bad := c.Post("/v1/telemetry", telReport("copied", "req-3", nil), "X-Session-Id", "s-ada")
	ctx.Equal(bad.Status, 400, "an event outside allowedEvents")
	ctx.Equal(len(ctx.Kafka.Topics()), before, "an unknown event created a topic (%v); topics", ctx.Kafka.Topics())
	anon := c.Post("/v1/telemetry", telReport("accepted", "req-4", nil))
	ctx.Equal(anon.Status, 401, "a report without X-Session-Id")
	ctx.Equal(len(ctx.Kafka.Records(telAccepted)), 1, "a report without a session reached the topic; records")
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	c := telApp(ctx)
	ctx.Kafka.LoseAcks(telAccepted, 1) // the broker wrote it, the acknowledgement never arrived
	r := c.Post("/v1/telemetry", telReport("accepted", "req-1", nil), "X-Session-Id", "s-ada")
	ctx.Equal(r.Status, 202, "POST /v1/telemetry (%s)", r.Text())
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(telAccepted)), 1, "one acceptance whose acknowledgement was lost: the producer's retry wrote it twice. Make the producer idempotent with acks=all; records")
}

func CheckNoCode(ctx *harness.Ctx) {
	c := telApp(ctx)
	var logged bytes.Buffer
	log.SetOutput(&logged)
	r := c.Post("/v1/telemetry", telReport("accepted", "req-1", map[string]any{"text": "conn.cursor()  # " + telCanary, "candidate_len": 30}), "X-Session-Id", "s-ada")
	log.SetOutput(os.Stderr)
	ctx.Equal(r.Status, 202, "POST /v1/telemetry (%s)", r.Text())
	values := ctx.Kafka.Values(telAccepted)
	ctx.Equal(len(values), 1, "one report; records")
	ctx.Assert(!strings.Contains(values[0], telCanary), "the event carries the suggestion's text: %s", values[0])
	var event map[string]any
	json.Unmarshal([]byte(values[0]), &event)
	_, hasText := event["text"]
	ctx.Assert(event["candidate_len"] == float64(30) && !hasText, "the event reports candidate_len and no text, got %s", values[0])
	ctx.Assert(!strings.Contains(logged.String(), telCanary), "the suggestion's text reached a log line: %q", strings.TrimSpace(logged.String()))
}

func CheckCountersBeforeCommit(ctx *harness.Ctx) {
	value := func(i int) string {
		b, _ := json.Marshal(map[string]any{"request_id": fmt.Sprintf("req-%d", i), "session": "s-ada", "language": "python", "candidate_len": 18, "latency_ms": 200})
		return string(b)
	}
	for i := 0; i < 3; i++ {
		ctx.Kafka.SeedPartition(telAccepted, 0, "s-ada", value(i))
	}
	for i := 0; i < 2; i++ {
		ctx.Kafka.SeedPartition(telShown, 0, "s-ada", value(i))
	}
	early := []string{}
	ctx.Kafka.OnCommit(func(_ string, offsets harness.KafkaOffsets) {
		for tp, offset := range offsets {
			raw, _ := ctx.Redis.HGet("acceptance:python", strings.TrimPrefix(tp.Topic, "completion."))
			counted, _ := strconv.ParseInt(raw, 10, 64)
			if counted < offset {
				early = append(early, fmt.Sprintf("%s[%d] was committed to offset %d with only %d counted", tp.Topic, tp.Partition, offset, counted))
			}
		}
	})
	loop, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx.Drain(func() { _ = consume(loop) })
	ctx.Assert(len(ctx.Kafka.EventsOf("auto-commit")) == 0, "auto-commit is on: offsets are committed on a timer, whatever the counter holds")
	if len(early) > 0 {
		ctx.Fatalf("%s: the commit ran before HINCRBY, so a crash between them loses the count", early[0])
	}
	ctx.Equal(ctx.Redis.HGetAll("acceptance:python"), map[string]string{"accepted": "3", "shown": "2"}, "acceptance:python")
	ctx.Assert(ctx.Kafka.Lag("acceptance", telAccepted) == 0 && ctx.Kafka.Lag("acceptance", telShown) == 0, "every counted record must be committed")
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

const std::string kTelShown = "completion.shown";
const std::string kTelAccepted = "completion.accepted";
const std::string kTelCanary = "CANARY_7731";

httplib::Server& telServer() {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return *svr;
}

std::string telReport(const std::string& event, const std::string& request_id, const nlohmann::json& extra = nlohmann::json::object()) {
  nlohmann::json body = {{"event", event}, {"request_id", request_id}, {"language", "python"}, {"candidate_len", 18}, {"latency_ms", 210}};
  body.update(extra);
  return body.dump();
}

harness::Response telPost(harness::HTTP& c, const std::string& body) {
  return c.Post("/v1/telemetry", body, "Content-Type", "application/json", "X-Session-Id", "s-ada");
}

}  // namespace

void CheckSessionKey(harness::Ctx& ctx) {
  auto c = ctx.HTTP(telServer());
  for (const auto& [event, request_id] : std::vector<std::pair<std::string, std::string>>{{"shown", "req-1"}, {"accepted", "req-1"}, {"shown", "req-2"}}) {
    const auto r = telPost(c, telReport(event, request_id));
    ctx.Equal(r.Status, 202, "POST /v1/telemetry (%s): %s", event, r.Text());
  }
  auto keys = ctx.Kafka.Keys(kTelShown);
  for (const auto& k : ctx.Kafka.Keys(kTelAccepted)) keys.push_back(k);
  ctx.Equal(keys, {"s-ada", "s-ada", "s-ada"}, "records must be keyed by the session (keyed by request id, one session's events land on several partitions)");
  std::vector<std::string> ids;
  for (const auto& v : ctx.Kafka.Values(kTelShown)) {
    const auto e = nlohmann::json::parse(v, nullptr, false);
    ctx.Assert(e.is_object() && e.value("session", "") == "s-ada", "each event carries its session (%s)", v);
    ids.push_back(e.is_object() ? e.value("request_id", "") : "");
  }
  ctx.Equal(ids, {"req-1", "req-2"}, "each event carries its request_id");
  const std::size_t before = ctx.Kafka.Topics().size();
  const auto bad = telPost(c, telReport("copied", "req-3"));
  ctx.Equal(bad.Status, 400, "an event outside kAllowedEvents");
  ctx.Equal(ctx.Kafka.Topics().size(), before, "an unknown event created a topic (%v); topics", ctx.Kafka.Topics());
  const auto anon = c.Post("/v1/telemetry", telReport("accepted", "req-4"), "Content-Type", "application/json");
  ctx.Equal(anon.Status, 401, "a report without X-Session-Id");
  ctx.Equal(ctx.Kafka.Records(kTelAccepted).size(), 1, "a report without a session reached the topic; records");
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  auto c = ctx.HTTP(telServer());
  ctx.Kafka.LoseAcks(kTelAccepted, 1);  // the broker wrote it, the acknowledgement never arrived
  const auto r = telPost(c, telReport("accepted", "req-1"));
  ctx.Equal(r.Status, 202, "POST /v1/telemetry (%s)", r.Text());
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kTelAccepted).size(), 1,
            "one acceptance whose acknowledgement was lost: the producer's retry wrote it twice. Set enable.idempotence with acks=all; records");
}

void CheckNoCode(harness::Ctx& ctx) {
  auto c = ctx.HTTP(telServer());
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  const auto r = telPost(c, telReport("accepted", "req-1", {{"text", "conn.cursor()  # " + kTelCanary}, {"candidate_len", 30}}));
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  ctx.Equal(r.Status, 202, "POST /v1/telemetry (%s)", r.Text());
  const auto values = ctx.Kafka.Values(kTelAccepted);
  ctx.Equal(values.size(), 1, "one report; records");
  ctx.Assert(values[0].find(kTelCanary) == std::string::npos, "the event carries the suggestion's text: %s", values[0]);
  const auto event = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(event.is_object() && event.value("candidate_len", 0) == 30 && !event.contains("text"), "the event reports candidate_len and no text, got %s", values[0]);
  ctx.Assert(logged.str().find(kTelCanary) == std::string::npos, "the suggestion's text reached a log line: %q", logged.str());
}

void CheckCountersBeforeCommit(harness::Ctx& ctx) {
  const auto value = [](int i) {
    return nlohmann::json{{"request_id", "req-" + std::to_string(i)}, {"session", "s-ada"}, {"language", "python"}, {"candidate_len", 18}, {"latency_ms", 200}}.dump();
  };
  for (int i = 0; i < 3; i++) ctx.Kafka.SeedPartition(kTelAccepted, 0, "s-ada", value(i));
  for (int i = 0; i < 2; i++) ctx.Kafka.SeedPartition(kTelShown, 0, "s-ada", value(i));
  std::vector<std::string> early;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets& offsets) {
    for (const auto& [tp, offset] : offsets) {
      const auto raw = ctx.Redis.HGet("acceptance:python", tp.Topic.substr(tp.Topic.find('.') + 1));
      const long long counted = raw ? std::strtoll(raw->c_str(), nullptr, 10) : 0;
      if (counted < offset)
        early.push_back(harness::Sprintf("%s[%d] was committed to offset %d with only %d counted", tp.Topic, tp.Partition, offset, counted));
    }
  });
  ctx.Drain([&] { consume(); });
  ctx.Assert(ctx.Kafka.EventsOf("auto-commit").empty(), "auto-commit is on: offsets are committed on a timer, whatever the counter holds");
  if (!early.empty()) ctx.Fatalf("%s: the commit ran before HINCRBY, so a crash between them loses the count", early[0]);
  ctx.Equal(ctx.Redis.HGetAll("acceptance:python"), std::map<std::string, std::string>{{"accepted", "3"}, {"shown", "2"}}, "acceptance:python");
  ctx.Assert(ctx.Kafka.Lag("acceptance", kTelAccepted) == 0 && ctx.Kafka.Lag("acceptance", kTelShown) == 0, "every counted record must be committed");
}
`,
  },
  debrief: `Each fix answers a question the dashboard depends on. The session key makes Kafka's one ordering promise, per partition, cover what belongs together: one developer's shown and accepted events. Idempotence with \`acks=all\` closes the gap a retry opens, so a lost acknowledgement does not double an acceptance. \`candidate_len\` replaces the text because a topic is replicated and retained: whatever goes in outlives the session that typed it. Committing after \`HINCRBY\` makes delivery at-least-once, so a crash replays a record instead of dropping a count. The replay can still count twice; a production pipeline would dedupe by \`request_id\` and track retention, whether the accepted code is still there minutes later.`,
};
