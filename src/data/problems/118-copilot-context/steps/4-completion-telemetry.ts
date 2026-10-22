import type {Step} from '@/lib/types';

export const completionTelemetryStep: Step = {
  id: 'completion-telemetry',
  title: 'completion.shown / completion.accepted: ids and sizes, never the code',
  concept: 'kafka',
  file: 'telemetry',
  focus: ['api', 'kafka', 'consumer', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the editor reports what it
showed and what the developer kept, the events reach Kafka, and a consumer moves counters, so the
acceptance dashboard shows numbers. Four production contracts are broken. Find them, fix them,
and prove the fix.

\`POST /v1/telemetry\` with body
\`{"event": "shown" | "accepted", "request_id": "…", "language": "python", "candidate_len": 142, "latency_ms": 210}\`
is how the editor reports the outcome of a completion, and the consumer turns those events into
the acceptance rate — the number GitHub's A/B tests were run on.

- Publish one event per report to \`completion.shown\` or \`completion.accepted\` with the
  **session** as the message key, so one developer's shown/accepted pairs stay on one partition
  and in order. The event carries \`request_id\`, \`session\`, \`language\`, \`candidate_len\` and
  \`latency_ms\`. An \`event\` outside \`ALLOWED_EVENTS\` is **400**.
- **Never** put the completion text, the prefix or the suffix in the event or in a log line. The
  topic is retained and replicated; code written there outlives the session, the file and the
  retention policy that the request path has.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent: required acks
  \`all\` plus hashed, stable keys), so a retried produce cannot count one acceptance twice.
- The consumer (group \`acceptance\`) updates \`HINCRBY acceptance:{language} shown|accepted\` in
  Redis and **only then** commits the offset. Commit first and one crash loses the counter
  update forever.

**Failure mode the checks target.** Keying by request id scatters one session's events across
partitions; an unconfigured producer can duplicate an acceptance on retry; the completion text
in the event is a data leak with a long tail; and commit-before-process makes the acceptance
rate silently wrong after every consumer restart.`,
  sequence: {
    participants: ['Editor', 'completiond', 'completion.accepted', 'Acceptance consumer', 'Redis'],
    messages: [
      {
        from: 'Editor',
        to: 'completiond',
        label: 'POST /v1/telemetry {event: accepted, request_id, candidate_len}',
        kind: 'sync',
      },
      {from: 'completiond', to: 'completion.accepted', label: 'produce · key = session · acks = all', kind: 'sync'},
      {from: 'completion.accepted', to: 'completiond', label: 'ack', kind: 'reply'},
      {from: 'completiond', to: 'Editor', label: '202 {accepted: true}', kind: 'reply'},
      {from: 'completion.accepted', to: 'Acceptance consumer', label: 'consume · group acceptance', kind: 'async'},
      {from: 'Acceptance consumer', to: 'Redis', label: 'HINCRBY acceptance:python accepted 1', kind: 'sync'},
      {from: 'Redis', to: 'Acceptance consumer', label: 'new counter value', kind: 'reply'},
      {from: 'Acceptance consumer', to: 'completion.accepted', label: 'commit offset after the write', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=session` (or `Key: []byte(session)`, `key: session`, `ProducerRecord(topic, session, …)`). Keyed by the request id, a session’s shown and accepted events land on different partitions.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or kafka-go’s `RequireAll` with a hash balancer. Validate `event` against `ALLOWED_EVENTS` before producing.',
    'Replace the `text` field with `candidate_len` everywhere — the request model, the event, the log line. In the consumer, `HINCRBY` first and commit second, with auto-commit off: a crash between the two then replays the record instead of losing it.',
  ],
  checks: [
    {
      id: 'session-key',
      title: 'Keyed by session, validated event, id is the request id',
      detail:
        'The message key is the session (partition by session), the event name is checked against `ALLOWED_EVENTS`, and the event carries the request id. The draft keys by the request id and produces to whatever topic the body names.',
      match: {
        python: {all: [/key\s*=\s*session/, /ALLOWED_EVENTS/, /request_id/]},
        typescript: {all: [/key:\s*session\b/, /ALLOWED_EVENTS/, /request_id|requestId/]},
        go: {all: [/Key:\s*\[\]byte\(session\)/, /allowedEvents/, /RequestID/]},
        scala: {all: [/ProducerRecord\([^,]+,\s*session,/, /AllowedEvents/, /requestId/]},
        cpp: {all: [/session\.data\(\),\s*session\.size\(\)/, /kAllowedEvents/, /requestId/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` with a hash balancer. A retried produce must not count an acceptance twice.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-code',
      title: 'No completion text, prefix or suffix in the event or logs',
      detail:
        'Neither the event payload nor any log line carries the completion text, the prefix or the suffix; the event reports `candidate_len`. The draft accepts a `text` field, logs it and copies it into the event.',
      match: {
        python: {all: [/candidate_len/], none: [/\btext\b/, /\bprefix\b/, /\bsuffix\b/]},
        typescript: {all: [/candidate_len/], none: [/\btext\b/, /\bprefix\b/, /\bsuffix\b/]},
        go: {all: [/CandidateLen/], none: [/\b[Tt]ext\b/, /\b[Pp]refix\b/, /\b[Ss]uffix\b/]},
        scala: {all: [/candidate_len|candidateLen/], none: [/\btext\b/, /\bprefix\b/, /\bsuffix\b/]},
        cpp: {all: [/candidate_len|candidateLen/], none: [/\btext\b/, /\bprefix\b/, /\bsuffix\b/]},
      },
    },
    {
      id: 'counters-before-commit',
      title: 'Updates counters before committing the offset',
      detail:
        'The consumer runs `HINCRBY` on `acceptance:{language}` before committing the offset, with auto-commit off; committing first makes a crash lose the counter update forever. The draft commits first.',
      match: {
        python: {order: [/\.hincrby\(/, /consumer\.commit\(/], all: [/enable\.auto\.commit/]},
        typescript: {order: [/\.hincrby\(/, /commitOffsets\(/], all: [/autoCommit:\s*false/]},
        go: {order: [/\.HIncrBy\(/, /CommitMessages\(/]},
        scala: {order: [/\.hincrBy\(/, /commitSync\(/], all: [/ENABLE_AUTO_COMMIT_CONFIG|enable\.auto\.commit/]},
        cpp: {order: [/->hincrby\(|\.hincrby\(/, /commitSync\(/], all: [/enable\.auto\.commit/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("telemetry")

producer = Producer({"bootstrap.servers": "kafka:9092"})
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class TelemetryRequest(BaseModel):
    event: str
    request_id: str
    language: str
    text: str
    latency_ms: int = 0


@app.post("/v1/telemetry", status_code=202)
def telemetry(body: TelemetryRequest, session: str = Header(alias="X-Session-Id")) -> dict:
    # TODO: key by session instead of the request id and validate the event name, configure the
    # idempotent producer with acks=all, keep the completion text out of the event and the logs,
    # and make the consumer update counters before it commits. Review all four.
    logger.info("telemetry session=%s event=%s text=%r", session, body.event, body.text)
    event = {
        "request_id": body.request_id,
        "session": session,
        "language": body.language,
        "text": body.text,
        "latency_ms": body.latency_ms,
    }
    producer.produce(f"completion.{body.event}", key=body.request_id, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "acceptance"})
    consumer.subscribe(["completion.shown", "completion.accepted"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        consumer.commit(msg)
        event = json.loads(msg.value())
        outcome = msg.topic().split(".")[1]
        r.hincrby(f"acceptance:{event['language']}", outcome, 1)
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer, Producer
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("telemetry")

ALLOWED_EVENTS = {"shown", "accepted"}

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class TelemetryRequest(BaseModel):
    event: str
    request_id: str
    language: str
    candidate_len: int = 0
    latency_ms: int = 0


@app.post("/v1/telemetry", status_code=202)
def telemetry(body: TelemetryRequest, session: str = Header(alias="X-Session-Id")) -> dict:
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
        "telemetry session=%s event=%s request=%s len=%d", session, body.event, body.request_id, body.candidate_len
    )
    return {"accepted": True}


def consume() -> None:
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "acceptance", "enable.auto.commit": False}
    )
    consumer.subscribe(["completion.shown", "completion.accepted"])
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        event = json.loads(msg.value())
        outcome = msg.topic().split(".")[1]
        r.hincrby(f"acceptance:{event['language']}", outcome, 1)
        consumer.commit(msg)
`,
    },
    typescript: {
      starter: `/** Completion telemetry: a model-generated draft that keys by request id and ships the code. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'completiond', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();
const r = new Redis('redis://redis:6379');

interface TelemetryBody {
  event: string;
  request_id: string;
  language: string;
  text: string;
  latency_ms?: number;
}

app.post('/v1/telemetry', async (request, reply) => {
  // TODO: key by session instead of the request id and validate the event name, configure the
  // idempotent producer with acks=all, keep the completion text out of the event and the logs,
  // and make the consumer update counters before it commits. Review all four.
  const session = request.headers['x-session-id'] as string;
  const body = request.body as TelemetryBody;
  request.log.info({session, event: body.event, text: body.text}, 'telemetry');
  const event = {
    request_id: body.request_id,
    session,
    language: body.language,
    text: body.text,
    latency_ms: body.latency_ms ?? 0,
  };
  await producer.send({
    topic: \`completion.\${body.event}\`,
    messages: [{key: body.request_id, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'acceptance'});
  await consumer.connect();
  await consumer.subscribe({topics: ['completion.shown', 'completion.accepted']});
  await consumer.run({
    eachMessage: async ({topic, partition, message}) => {
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
      const event = JSON.parse(message.value?.toString() ?? '{}') as {language: string};
      await r.hincrby(\`acceptance:\${event.language}\`, topic.split('.')[1], 1);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Completion telemetry: session-keyed, idempotent events with sizes, never code; counters before the commit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'completiond', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

const ALLOWED_EVENTS: Record<string, true> = {shown: true, accepted: true};

interface TelemetryBody {
  event: string;
  request_id: string;
  language: string;
  candidate_len?: number;
  latency_ms?: number;
}

app.post('/v1/telemetry', async (request, reply) => {
  const session = request.headers['x-session-id'] as string;
  const body = request.body as TelemetryBody;
  if (ALLOWED_EVENTS[body.event] !== true) return reply.code(400).send({error: 'event must be shown or accepted'});
  const event = {
    request_id: body.request_id,
    session,
    language: body.language,
    candidate_len: body.candidate_len ?? 0,
    latency_ms: body.latency_ms ?? 0,
  };
  await producer.send({
    topic: \`completion.\${body.event}\`,
    acks: -1,
    messages: [{key: session, value: JSON.stringify(event)}],
  });
  request.log.info({session, event: body.event, requestId: body.request_id, candidateLen: event.candidate_len}, 'telemetry');
  return reply.code(202).send({accepted: true});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'acceptance'});
  await consumer.connect();
  await consumer.subscribe({topics: ['completion.shown', 'completion.accepted']});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {language: string};
      await r.hincrby(\`acceptance:\${event.language}\`, topic.split('.')[1], 1);
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
	"log"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

var (
	writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092")}
	rdb    *redis.Client
)

type TelemetryRequest struct {
	Event     string \`json:"event"\`
	RequestID string \`json:"request_id"\`
	Language  string \`json:"language"\`
	Text      string \`json:"text"\`
	LatencyMS int    \`json:"latency_ms"\`
}

func telemetry(rw http.ResponseWriter, r *http.Request) {
	session := r.Header.Get("X-Session-Id")
	body := TelemetryRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: key by session instead of the request id and validate the event name, configure
	// acks=all / hashed keys, keep the completion text out of the event and the logs, and make
	// the consumer update counters before it commits. Review all four.
	log.Printf("telemetry session=%s event=%s text=%q", session, body.Event, body.Text)
	event := map[string]any{
		"request_id": body.RequestID,
		"session":    session,
		"language":   body.Language,
		"text":       body.Text,
		"latency_ms": body.LatencyMS,
	}
	payload, _ := json.Marshal(event)
	_ = writer.WriteMessages(r.Context(), kafka.Message{
		Topic: "completion." + body.Event,
		Key:   []byte(body.RequestID),
		Value: payload,
	})
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     []string{"kafka:9092"},
		GroupTopics: []string{"completion.shown", "completion.accepted"},
		GroupID:     "acceptance",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		_ = reader.CommitMessages(ctx, msg)
		var event struct {
			Language string \`json:"language"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		outcome := strings.TrimPrefix(msg.Topic, "completion.")
		rdb.HIncrBy(ctx, "acceptance:"+event.Language, outcome, 1)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var rdb *redis.Client

var allowedEvents = map[string]bool{"shown": true, "accepted": true}

type TelemetryRequest struct {
	Event        string \`json:"event"\`
	RequestID    string \`json:"request_id"\`
	Language     string \`json:"language"\`
	CandidateLen int    \`json:"candidate_len"\`
	LatencyMS    int    \`json:"latency_ms"\`
}

func telemetry(rw http.ResponseWriter, r *http.Request) {
	session := r.Header.Get("X-Session-Id")
	body := TelemetryRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !allowedEvents[body.Event] {
		rw.WriteHeader(http.StatusBadRequest)
		return
	}
	event := map[string]any{
		"request_id":    body.RequestID,
		"session":       session,
		"language":      body.Language,
		"candidate_len": body.CandidateLen,
		"latency_ms":    body.LatencyMS,
	}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(r.Context(), kafka.Message{
		Topic: "completion." + body.Event,
		Key:   []byte(session),
		Value: payload,
	}); err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	log.Printf("telemetry session=%s event=%s request=%s len=%d", session, body.Event, body.RequestID, body.CandidateLen)
	rw.WriteHeader(http.StatusAccepted)
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     []string{"kafka:9092"},
		GroupTopics: []string{"completion.shown", "completion.accepted"},
		GroupID:     "acceptance",
	})
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			Language string \`json:"language"\`
		}
		_ = json.Unmarshal(msg.Value, &event)
		outcome := strings.TrimPrefix(msg.Topic, "completion.")
		rdb.HIncrBy(ctx, "acceptance:"+event.Language, outcome, 1)
		_ = reader.CommitMessages(ctx, msg)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

object Telemetry {
  private val log = Logger.getLogger("telemetry")
  val producer = new KafkaProducer[String, String](new Properties())
  val jedis = new Jedis("redis", 6379)

  // TODO: key by session instead of the request id and validate the event name, configure the
  // idempotent producer with acks=all, keep the completion text out of the event and the logs,
  // and make the consumer update counters before it commits. Review all four.
  def publish(session: String, event: String, requestId: String, language: String, text: String): Unit = {
    log.info(s"telemetry session=$session event=$event text=$text")
    val payload = Map(
      "request_id" -> requestId,
      "session" -> session,
      "language" -> language,
      "text" -> text
    ).toJson.compactPrint
    producer.send(new ProducerRecord(s"completion.$event", requestId, payload))
  }

  def consume(): Unit = {
    val consumer = new KafkaConsumer[String, String](new Properties())
    consumer.subscribe(java.util.List.of("completion.shown", "completion.accepted"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        consumer.commitSync()
        val fields = record.value().parseJson.asJsObject.fields
        val outcome = record.topic().stripPrefix("completion.")
        jedis.hincrBy(s"acceptance:\${fields("language").convertTo[String]}", outcome, 1L)
      }
    }
  }
}
`,
      solution: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.consumer.{ConsumerConfig, KafkaConsumer}
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json._

object Telemetry {
  private val log = Logger.getLogger("telemetry")
  val AllowedEvents = Set("shown", "accepted")

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  def publish(session: String, event: String, requestId: String, language: String, candidateLen: Int): Boolean = {
    if (!AllowedEvents.contains(event)) {
      false
    } else {
      val payload = Map(
        "request_id" -> JsString(requestId),
        "session" -> JsString(session),
        "language" -> JsString(language),
        "candidate_len" -> JsNumber(candidateLen)
      ).toJson.compactPrint
      producer.send(new ProducerRecord(s"completion.$event", session, payload))
      log.info(s"telemetry session=$session event=$event request=$requestId len=$candidateLen")
      true
    }
  }

  def consume(): Unit = {
    val props = new Properties()
    props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ConsumerConfig.GROUP_ID_CONFIG, "acceptance")
    props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
    val consumer = new KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of("completion.shown", "completion.accepted"))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val fields = record.value().parseJson.asJsObject.fields
        val outcome = record.topic().stripPrefix("completion.")
        jedis.hincrBy(s"acceptance:\${fields("language").convertTo[String]}", outcome, 1L)
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

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

std::unique_ptr<RdKafka::Producer> producer;
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

// TODO: key by session instead of the request id and validate the event name, configure the
// idempotent producer with acks=all, keep the completion text out of the event and the logs, and
// make the consumer update counters before it commits. Review all four.
void publish(
    const std::string& session,
    const std::string& event,
    const std::string& requestId,
    const std::string& language,
    const std::string& text) {
  std::cerr << "telemetry session=" << session << " event=" << event << " text=" << text << "\\n";
  const json payload = {{"request_id", requestId}, {"session", session}, {"language", language}, {"text", text}};
  const auto value = payload.dump();
  producer->produce(
      "completion." + event,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(value.data()),
      value.size(),
      requestId.data(),
      requestId.size(),
      0,
      nullptr);
  producer->flush(2000);
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "acceptance", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"completion.shown", "completion.accepted"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    consumer->commitSync();
    const json event = json::parse(
        static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    const auto outcome = msg->topic_name().substr(std::string("completion.").size());
    redis->hincrby("acceptance:" + event["language"].get<std::string>(), outcome, 1);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kAllowedEvents = {"shown", "accepted"};

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

bool publish(
    const std::string& session,
    const std::string& event,
    const std::string& requestId,
    const std::string& language,
    int candidateLen) {
  if (kAllowedEvents.count(event) == 0) return false;
  const json payload = {
      {"request_id", requestId}, {"session", session}, {"language", language}, {"candidate_len", candidateLen}};
  const auto value = payload.dump();
  const auto err = producer->produce(
      "completion." + event,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(value.data()),
      value.size(),
      session.data(),
      session.size(),
      0,
      nullptr);
  producer->flush(2000);
  std::cerr << "telemetry session=" << session << " event=" << event << " request=" << requestId
            << " len=" << candidateLen << "\\n";
  return err == RdKafka::ERR_NO_ERROR;
}

void consume() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "acceptance", err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"completion.shown", "completion.accepted"});
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(200));
    if (msg->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(
        static_cast<const char*>(msg->payload()), static_cast<const char*>(msg->payload()) + msg->len());
    const auto outcome = msg->topic_name().substr(std::string("completion.").size());
    redis->hincrby("acceptance:" + event["language"].get<std::string>(), outcome, 1);
    consumer->commitSync();
  }
}
`,
    },
  },
  debrief: `The interviewer is checking whether you treat a telemetry topic as a product surface with the same rules as the request path. The acceptance rate is the number GitHub's post reports every improvement against — neighboring tabs +5 %, FIM +10 % — so it has to be right: the session key keeps a developer's shown/accepted pairs ordered on one partition, the idempotent producer with acks=all keeps a retry from counting an acceptance twice, and counters-before-commit keeps a consumer crash from losing one. The leak is the quiet flaw: the draft copies the accepted completion into an event that is retained and replicated, which is source code leaving the editor for a system nobody scoped for it; the event needs the length, not the text. Real pipelines add a schema registry so a \`text\` field cannot be added back by accident, a dead-letter topic for unparseable events, and a windowed aggregation instead of unbounded hash counters.`,
};
