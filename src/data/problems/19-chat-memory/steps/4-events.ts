import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Session events without content',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'db'],
  task: `## Task

The starter is a plausible model-generated draft: a turn lands in the topic and the demo shows the
event. Its ordering, its payload and its durability are all wrong. Find the flaws, fix them, and
prove the fix.

Implement the session-event path behind the append endpoint:

- Every accepted turn publishes a \`session.turn\` event **keyed by tenant**. Kafka orders within a
  partition, not within a topic, so the key decides which events can be reordered relative to one
  another. The draft keys by turn id, scattering one session across partitions — a consumer then
  sees turn 3 before turn 2.
- The payload carries **ids and token counts**, never the message text:
  \`{turn_id, session_id, role, tokens}\`. The topic is retained and replicated, so a turn's text in
  it would outlive every buffer TTL and outlive the delete semantics of the conversation.
- The producer uses **\`acks=all\`**, so an acknowledged produce is replicated rather than buffered
  on a single broker.
- The handler returns only **after the broker confirms**. The draft fires the produce and answers
  immediately, so a produce that fails after the response is a lost event nobody can replay.
- When the produce is rejected, the event is written to an **outbox** row instead, so a broker
  outage delays events rather than dropping them.

**Failure mode the checks target.** Two turns of one session must share a partition, the payload
must carry no turn text, and a broker outage must leave an outbox row instead of a lost event.

## What to keep

The topic name and the produce call are fine. The fix is the key, the payload, the acknowledgement
level and the failure path.`,
  sequence: {
    participants: ['Memory API', 'Kafka', 'Outbox'],
    messages: [
      {from: 'Memory API', to: 'Kafka', label: 'produce session.turn key=acme {ids, tokens} acks=all', kind: 'sync'},
      {from: 'Kafka', to: 'Memory API', label: 'ack · or ProduceError', kind: 'reply'},
      {from: 'Memory API', to: 'Memory API', label: '201 only after the ack', kind: 'sync'},
      {from: 'Memory API', to: 'Outbox', label: 'INSERT outbox row on ProduceError', kind: 'sync'},
      {from: 'Outbox', to: 'Memory API', label: 'stored for replay', kind: 'reply'},
    ],
  },
  hints: [
    'The message key decides the partition. `key=tenant` keeps one tenant’s turns in order; keying by turn id scatters the conversation across partitions and reorders it.',
    'The topic is retained: publish `{turn_id, session_id, role, tokens}` and never the text. A payload with the message duplicates the store with a longer lifetime and none of its delete semantics.',
    'Do not answer before the broker does. `acks=all` plus a wait on the delivery report (`.get()`, `await`, a delivery channel, a flush) makes the write real; on failure, insert the same payload into an `outbox` row so it can be replayed later.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys the event by tenant',
      detail:
        'The record key is the authenticated tenant, so every turn of one tenant shares a partition and keeps its order. The draft keys by turn id and scatters the session.',
      match: {
        python: {all: [/key=tenant/]},
        typescript: {all: [/key:\s*tenant/]},
        go: {all: [/StringEncoder\(tenant\)/]},
        scala: {all: [/ProducerRecord.*tenant/]},
        cpp: {all: [/builder\.key\(tenant\)/]},
      },
    },
    {
      id: 'no-content',
      title: 'Publishes ids and token counts, not message text',
      detail:
        'The event payload carries `turn_id`, `session_id`, `role` and `tokens`; the turn text never enters the retained topic. The draft copies the content field into the event.',
      match: {
        python: {all: [/tokens/], none: [/"content"/]},
        typescript: {all: [/tokens/], none: [/\bcontent:\s*turn\.content/]},
        go: {all: [/Tokens/], none: [/"content"/]},
        scala: {all: [/tokens/], none: [/"content"/]},
        cpp: {all: [/tokens/], none: [/"content"/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Produce with acks=all',
      detail:
        'The producer acknowledges only after all in-sync replicas have the record. The draft leaves the acknowledgement level at its default.',
      match: {
        python: {all: [/ACKS_ALL/]},
        typescript: {all: [/ACKS_ALL/]},
        go: {all: [/acksAll/]},
        scala: {all: [/AcksAll/]},
        cpp: {all: [/kAcksAll/]},
      },
    },
    {
      id: 'broker-confirmed',
      title: 'Waits for the broker before answering',
      detail:
        'The handler waits on the delivery report before returning. The draft produces and answers immediately, so a produce that fails after the response is an event nobody can replay.',
      match: {
        python: {all: [/producer\.send\(/, /\.get\(/]},
        typescript: {all: [/await producer\.send\(/]},
        go: {all: [/\.Produce\(/, /<-deliveryChan/]},
        scala: {all: [/\.send\(.*\)\.get\(\)/]},
        cpp: {all: [/producer\.produce\(/, /producer\.flush\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the produce fails',
      detail:
        'A rejected produce stores the same payload in an outbox so it can be replayed. The draft drops the event when the broker rejects it.',
      match: {
        python: {all: [/outbox/i, /rpush\(/]},
        typescript: {all: [/outbox/i, /INSERT/i]},
        go: {all: [/outbox/i, /INSERT/i]},
        scala: {all: [/outbox/i, /INSERT/i]},
        cpp: {all: [/outbox/i, /rpush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI
from kafka import KafkaProducer
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = KafkaProducer(bootstrap_servers="kafka:9092")

TOPIC = "session.turn"


class Turn(BaseModel):
    turn_id: str
    session_id: str
    role: str
    content: str
    tokens: int


@app.post("/v1/sessions/{id}/turns")
def append_turn(id: str, turn: Turn) -> dict:
    # TODO: key the event by tenant so one session keeps its partition order, publish ids and token
    # counts instead of the turn text, configure acks=all, wait for the broker to confirm before
    # answering, and write an outbox row when the produce fails.
    payload = json.dumps(
        {"turn_id": turn.turn_id, "content": turn.content, "role": turn.role}
    ).encode()
    producer.send(TOPIC, key=turn.turn_id.encode(), value=payload)
    producer.poll(0)
    return {"session_id": id, "turn_id": turn.turn_id}
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header
from kafka import KafkaProducer
from kafka.errors import KafkaError
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "session.turn"
ACKS_ALL = "all"

producer = KafkaProducer(bootstrap_servers="kafka:9092", acks=ACKS_ALL)


class Turn(BaseModel):
    turn_id: str
    session_id: str
    role: str
    content: str
    tokens: int


def turn_event(turn: Turn) -> dict:
    return {
        "turn_id": turn.turn_id,
        "session_id": turn.session_id,
        "role": turn.role,
        "tokens": turn.tokens,
    }


@app.post("/v1/sessions/{id}/turns")
def append_turn(id: str, turn: Turn, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    event = turn_event(turn)
    payload = json.dumps(event).encode()
    try:
        producer.send(TOPIC, key=tenant.encode(), value=payload).get(timeout=2.0)
    except KafkaError:
        r.rpush("outbox:session.turn", json.dumps(event))
    return {"session_id": id, "turn_id": turn.turn_id}
`,
    },
    typescript: {
      starter: `/** POST /v1/sessions/:id/turns: a model-generated draft that answers before the broker confirms. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();

interface Turn {
  turn_id: string;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
}

app.post('/v1/sessions/:id/turns', async (request, reply) => {
  const {id} = request.params as {id: string};
  const turn = request.body as Turn;
  // TODO: key the event by tenant so one session keeps its partition order, publish ids and token
  // counts instead of the turn text, configure acks=all, wait for the broker to confirm before
  // answering, and write an outbox row when the produce fails.
  void producer.send({
    topic: 'session.turn',
    messages: [
      {key: turn.turn_id, value: JSON.stringify({turn_id: turn.turn_id, content: turn.content, role: turn.role})},
    ],
  });
  return reply.code(201).send({session_id: id, turn_id: turn.turn_id});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/sessions/:id/turns: publish a content-free event keyed by tenant, after the ack. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Pool} from 'pg';

export const app = Fastify();
const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();
const db = new Pool({connectionString: 'postgres://db:5432/memory'});

const TOPIC = 'session.turn';
const ACKS_ALL = -1;

interface Turn {
  turn_id: string;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
}

app.post('/v1/sessions/:id/turns', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  const turn = request.body as Turn;
  const event = {
    turn_id: turn.turn_id,
    session_id: turn.session_id,
    role: turn.role,
    tokens: turn.tokens,
  };
  const payload = JSON.stringify(event);
  try {
    await producer.send({
      topic: TOPIC,
      acks: ACKS_ALL,
      messages: [{key: tenant, value: payload}],
    });
  } catch {
    await db.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2)', [TOPIC, payload]);
  }
  return reply.code(201).send({session_id: id, turn_id: turn.turn_id});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"github.com/IBM/sarama"
)

var producer sarama.AsyncProducer

type turn struct {
	TurnID    string \`json:"turn_id"\`
	SessionID string \`json:"session_id"\`
	Role      string \`json:"role"\`
	Content   string \`json:"content"\`
	Tokens    int    \`json:"tokens"\`
}

func appendTurn(rw http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var t turn
	_ = json.NewDecoder(r.Body).Decode(&t)
	// TODO: key the event by tenant so one session keeps its partition order, publish ids and token
	// counts instead of the turn text, configure acks=all, wait for the broker to confirm before
	// answering, and write an outbox row when the produce fails.
	payload, _ := json.Marshal(map[string]any{"turn_id": t.TurnID, "content": t.Content, "role": t.Role})
	producer.Input() <- &sarama.ProducerMessage{
		Topic: "session.turn",
		Key:   sarama.StringEncoder(t.TurnID),
		Value: sarama.ByteEncoder(payload),
	}
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"session_id":"\` + id + \`"}\`))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sessions/{id}/turns", appendTurn)
}
`,
      solution: `package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"

	"github.com/IBM/sarama"
)

const (
	topic   = "session.turn"
	acksAll = sarama.WaitForAll
)

var (
	producer sarama.AsyncProducer
	db       *sql.DB
)

type turnEvent struct {
	TurnID    string \`json:"turn_id"\`
	SessionID string \`json:"session_id"\`
	Role      string \`json:"role"\`
	Tokens    int    \`json:"tokens"\`
}

func publishEvent(ctx context.Context, tenant string, event turnEvent) error {
	payload, _ := json.Marshal(event)
	deliveryChan := make(chan error, 1)
	producer.Produce(&sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(tenant),
		Value: sarama.ByteEncoder(payload),
	}, deliveryChan)
	if err := <-deliveryChan; err != nil {
		_, _ = db.ExecContext(ctx, "INSERT INTO outbox (topic, payload) VALUES ($1, $2)", topic, payload)
		return err
	}
	return nil
}

func appendTurn(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant := r.Header.Get("X-Tenant-Id")
	id := r.PathValue("id")
	var event turnEvent
	_ = json.NewDecoder(r.Body).Decode(&event)
	_ = publishEvent(ctx, tenant, event)
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"session_id":"\` + id + \`"}\`))
}

func main() {
	config := sarama.NewConfig()
	config.Producer.RequiredAcks = acksAll
	config.Producer.Return.Successes = true
	producer, _ = sarama.NewAsyncProducer([]string{"kafka:9092"}, config)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sessions/{id}/turns", appendTurn)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Turn(turn_id: String, session_id: String, role: String, content: String, tokens: Int)

object EventsApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  implicit val turnFormat: RootJsonFormat[Turn] = jsonFormat5(Turn)

  val Topic = "session.turn"
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  val route: Route =
    path("v1" / "sessions" / Segment / "turns") { id =>
      post {
        entity(as[Turn]) { turn =>
          // TODO: key the event by tenant so one session keeps its partition order, publish ids and
          // token counts instead of the turn text, configure acks=all, wait for the broker to
          // confirm before answering, and write an outbox row when the produce fails.
          val event = s"""{"turn_id":"\${turn.turn_id}","content":"\${turn.content}","role":"\${turn.role}"}"""
          producer.send(new ProducerRecord[String, String](Topic, turn.turn_id, event))
          complete(StatusCodes.Created, s"""{"session_id":"$id","turn_id":"\${turn.turn_id}"}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import slick.jdbc.PostgresProfile.api._
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Turn(turn_id: String, session_id: String, role: String, content: String, tokens: Int)

object EventsApi {
  implicit val system: ActorSystem = ActorSystem("chat-memory")
  implicit val turnFormat: RootJsonFormat[Turn] = jsonFormat5(Turn)

  val Topic = "session.turn"
  val AcksAll = "all"
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", AcksAll)
  val producer = new KafkaProducer[String, String](props)
  val db = Database.forConfig("memory")

  def publish(tenant: String, turn: Turn): Unit = {
    val event = s"""{"turn_id":"\${turn.turn_id}","session_id":"\${turn.session_id}","role":"\${turn.role}","tokens":\${turn.tokens}}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, tenant, event)).get()
    } catch {
      case _: Exception =>
        db.run(sqlu"INSERT INTO outbox (topic, payload) VALUES ($Topic, $event)")
    }
  }

  val route: Route =
    path("v1" / "sessions" / Segment / "turns") { id =>
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[Turn]) { turn =>
            publish(tenant, turn)
            complete(StatusCodes.Created, s"""{"session_id":"$id","turn_id":"\${turn.turn_id}"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <cppkafka/cppkafka.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  cppkafka::Configuration config{{"metadata.broker.list", "kafka:9092"}};
  cppkafka::Producer producer(config);
  httplib::Server svr;

  svr.Post("/v1/sessions/:id/turns", [&](const httplib::Request& req, httplib::Response& res) {
    const auto id = req.path_params.at("id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: key the event by tenant so one session keeps its partition order, publish ids and token
    // counts instead of the turn text, configure acks=all, wait for the broker to confirm before
    // answering, and write an outbox row when the produce fails.
    const auto event = json{{"turn_id", body.value("turn_id", std::string())},
                            {"content", body.value("content", std::string())},
                            {"role", body.value("role", std::string())}}
                           .dump();
    cppkafka::MessageBuilder builder("session.turn");
    builder.key(body.value("turn_id", std::string()));
    builder.payload(event);
    producer.produce(builder);
    res.status = 201;
    res.set_content(json{{"session_id", id}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <cppkafka/cppkafka.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

const std::string kTopic = "session.turn";
const std::string kAcksAll = "all";

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  cppkafka::Configuration config{
      {"metadata.broker.list", "kafka:9092"},
      {"acks", kAcksAll},
  };
  cppkafka::Producer producer(config);
  httplib::Server svr;

  svr.Post("/v1/sessions/:id/turns", [&](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto id = req.path_params.at("id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto event = json{{"turn_id", body.value("turn_id", std::string())},
                            {"session_id", body.value("session_id", std::string())},
                            {"role", body.value("role", std::string())},
                            {"tokens", body.value("tokens", 0)}}
                           .dump();
    cppkafka::MessageBuilder builder(kTopic);
    builder.key(tenant);
    builder.payload(event);
    producer.produce(builder);
    try {
      producer.flush();
    } catch (const cppkafka::KafkaException&) {
      redis.rpush("outbox:session.turn", event);
    }
    res.status = 201;
    res.set_content(json{{"session_id", id}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question behind this step is what belongs in a retained, replicated log. The
topic is not a queue you can delete from; it is an append-only record with a retention policy, so
anything published there inherits that lifetime. Copying a turn's text in duplicates the message
store with weaker delete semantics and a longer memory, which is why the event carries only ids and
token counts. The key is the ordering half: Kafka orders within a partition, so keying by tenant is
what keeps one conversation's events readable in sequence. The third half is durability: an
acknowledged produce needs \`acks=all\`, and the response must wait for that acknowledgement. When
the broker is down, the correct behavior is not to drop the event or to fail the turn; it is to
park the same payload in an outbox and let a replay drain it.`,
};
