import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Quota events keyed by team, with amounts not identities',
  concept: 'kafka',
  file: 'events',
  focus: ['broker', 'kafka', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a \`quota.event\` lands in the
topic and the demo shows it. Its ordering, its payload and its durability are all wrong. Review it,
fix it, and prove the fix.

Implement the quota-event path behind the reserve, release and deny paths:

- Every reserve, release and deny publishes a \`quota.event\` **keyed by team**. Kafka orders within
  a partition, not within a topic, so the key decides which events can be reordered relative to one
  another — and a team’s ledger is only readable in order. The draft keys by **resource class**, so
  every team that reserves a \`gpu-a100\` shares one partition and their events interleave.
- The payload carries the **resource class, the window, the amount and the reservation id**, plus
  the event kind. It never carries **who** asked: no user id, no email, no request metadata. The
  topic is retained and replicated far past any request, and the ledger it rebuilds needs amounts,
  not identities. The draft copies the caller’s \`user_id\` into every event.
- The producer uses **\`acks=all\`**, so an acknowledged produce is replicated rather than buffered
  on a single broker.
- The handler returns only **after the broker confirms**. The draft fires the produce and answers
  immediately, so a produce that fails after the response is a lost event nobody can replay.
- When the produce is rejected, the same payload is written to an **outbox** row, so a broker outage
  delays the event instead of dropping it and the ledger can be rebuilt by draining the outbox.

**Failure mode the checks target.** Three proofs: two events of one team must share a partition
(per-team ordering), no user identifier may appear in the retained payload, and a rejected produce
must leave an outbox row rather than a hole in the ledger.

**What to keep.** The topic name and the produce call are fine. The fix is the key, the payload, the
acknowledgement level and the failure path.`,
  sequence: {
    participants: ['Quota Broker', 'Kafka', 'Outbox'],
    messages: [
      {
        from: 'Quota Broker',
        to: 'Kafka',
        label: 'produce quota.event key=team-a {kind, class, amount, reservation_id} acks=all',
        kind: 'sync',
      },
      {from: 'Kafka', to: 'Quota Broker', label: 'ack · or ProduceError', kind: 'reply'},
      {from: 'Quota Broker', to: 'Quota Broker', label: '201 only after the ack', kind: 'sync'},
      {from: 'Quota Broker', to: 'Outbox', label: 'INSERT outbox row on ProduceError', kind: 'sync'},
      {from: 'Outbox', to: 'Quota Broker', label: 'stored for replay', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'team-key',
      title: 'Keys the event by team',
      detail:
        'The record key is the team, so every event of one team lands in the same partition and stays ordered. The draft keys by resource class and interleaves every team that shares a class.',
      match: {
        python: {all: [/key=team/]},
        typescript: {all: [/key:\s*team/]},
        go: {all: [/StringEncoder\(team\)/]},
        scala: {all: [/ProducerRecord.*\(Topic, team,/]},
        cpp: {all: [/builder\.key\(team\)/]},
      },
    },
    {
      id: 'amounts-not-identities',
      title: 'Publishes amounts and ids, never the requester',
      detail:
        'The payload carries the resource class, the window, the amount and the reservation id, and no user identifier of any kind. The draft copies the caller’s `user_id` into the retained topic.',
      match: {
        python: {all: [/resource_class/, /amount/, /reservation_id/], none: [/\buser_id\b/]},
        typescript: {all: [/resource_class/, /amount/, /reservation_id/], none: [/\buser_id\b/]},
        go: {all: [/ResourceClass/, /Amount/, /ReservationID/], none: [/user_id/]},
        scala: {all: [/resource_class/, /amount/, /reservation_id/], none: [/\buser_id\b/]},
        cpp: {all: [/resource_class/, /amount/, /reservation_id/], none: [/\buser_id\b/]},
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
        'The handler waits on the delivery report before it returns. The draft produces and answers immediately, so a produce that fails after the response leaves a hole in the ledger nobody can replay.',
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
      title: 'Writes an outbox row when the produce is rejected',
      detail:
        'A rejected produce stores the same payload in an outbox so the ledger can be rebuilt by replaying it. The draft drops the event when the broker rejects it.',
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
      starter: `"""quota.event: a model-generated draft that keys by resource class and describes the requester."""
import json

from fastapi import FastAPI
from kafka import KafkaProducer
from pydantic import BaseModel

app = FastAPI()
producer = KafkaProducer(bootstrap_servers="kafka:9092")

TOPIC = "quota.event"


class QuotaEvent(BaseModel):
    kind: str
    team: str
    window: str
    resource_class: str
    amount: int
    reservation_id: str
    user_id: str


@app.post("/v1/quotas/{team}/reserve")
def reserve(team: str, event: QuotaEvent) -> dict:
    # TODO: this draft keys the event by resource class, includes the requester's user id, produces
    # without acks=all and answers before the broker confirms, and has no outbox. Key by team,
    # publish kind/window/resource_class/amount/reservation_id only, wait for the ack, and park the
    # payload in an outbox when the produce is rejected.
    payload = json.dumps(
        {
            "kind": event.kind,
            "team": event.team,
            "window": event.window,
            "resource_class": event.resource_class,
            "amount": event.amount,
            "reservation_id": event.reservation_id,
            "user_id": event.user_id,
        }
    ).encode()
    producer.send(TOPIC, key=event.resource_class.encode(), value=payload)
    producer.poll(0)
    return {"reservation_id": event.reservation_id}
`,
      solution: `"""quota.event: per-team ordering, amounts instead of identities, and an outbox when refused."""
import json

import redis
from fastapi import FastAPI
from kafka import KafkaProducer
from kafka.errors import KafkaError
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TOPIC = "quota.event"
ACKS_ALL = "all"

producer = KafkaProducer(bootstrap_servers="kafka:9092", acks=ACKS_ALL)


class QuotaEvent(BaseModel):
    kind: str
    team: str
    window: str
    resource_class: str
    amount: int
    reservation_id: str


def quota_event(event: QuotaEvent) -> dict:
    """The retained record: what happened to which window, never who asked."""
    return {
        "kind": event.kind,
        "team": event.team,
        "window": event.window,
        "resource_class": event.resource_class,
        "amount": event.amount,
        "reservation_id": event.reservation_id,
    }


@app.post("/v1/quotas/{team}/reserve")
def reserve(team: str, event: QuotaEvent) -> dict:
    payload = json.dumps(quota_event(event)).encode()
    try:
        producer.send(TOPIC, key=team.encode(), value=payload).get(timeout=2.0)
    except KafkaError:
        r.rpush("outbox:quota.event", json.dumps(quota_event(event)))
    return {"reservation_id": event.reservation_id}
`,
    },
    typescript: {
      starter: `/** quota.event: a model-generated draft that keys by class and answers before the ack. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();

interface QuotaEvent {
  kind: string;
  team: string;
  window: string;
  resource_class: string;
  amount: number;
  reservation_id: string;
  user_id: string;
}

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const event = request.body as QuotaEvent;
  // TODO: this draft keys the event by resource class, includes the requester's user id, produces
  // without acks=all and answers before the broker confirms, and has no outbox. Key by team,
  // publish kind/window/resource_class/amount/reservation_id only, wait for the ack, and park the
  // payload in an outbox when the produce is rejected.
  void producer.send({
    topic: 'quota.event',
    messages: [
      {
        key: event.resource_class,
        value: JSON.stringify({
          kind: event.kind,
          team: event.team,
          window: event.window,
          resource_class: event.resource_class,
          amount: event.amount,
          reservation_id: event.reservation_id,
          user_id: event.user_id,
        }),
      },
    ],
  });
  return reply.code(201).send({reservation_id: event.reservation_id});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** quota.event: per-team ordering, amounts instead of identities, and an outbox when refused. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Pool} from 'pg';

export const app = Fastify();
const kafka = new Kafka({brokers: ['kafka:9092']});
const producer = kafka.producer();
const db = new Pool({connectionString: 'postgres://db:5432/quota'});

const TOPIC = 'quota.event';
const ACKS_ALL = -1;

interface QuotaEvent {
  kind: string;
  team: string;
  window: string;
  resource_class: string;
  amount: number;
  reservation_id: string;
}

function quotaEvent(event: QuotaEvent): QuotaEvent {
  // The retained record: what happened to which window, never who asked.
  return {
    kind: event.kind,
    team: event.team,
    window: event.window,
    resource_class: event.resource_class,
    amount: event.amount,
    reservation_id: event.reservation_id,
  };
}

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const event = request.body as QuotaEvent;
  const payload = JSON.stringify(quotaEvent(event));
  try {
    await producer.send({
      topic: TOPIC,
      acks: ACKS_ALL,
      messages: [{key: team, value: payload}],
    });
  } catch {
    await db.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2)', [TOPIC, payload]);
  }
  return reply.code(201).send({reservation_id: event.reservation_id});
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

type quotaEvent struct {
	Kind          string \`json:"kind"\`
	Team          string \`json:"team"\`
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int    \`json:"amount"\`
	ReservationID string \`json:"reservation_id"\`
	UserID        string \`json:"user_id"\`
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	var event quotaEvent
	_ = json.NewDecoder(r.Body).Decode(&event)
	// TODO: this draft keys the event by resource class, includes the requester's user id, produces
	// without acks=all and answers before the broker confirms, and has no outbox. Key by team,
	// publish kind/window/resource_class/amount/reservation_id only, wait for the ack, and park the
	// payload in an outbox when the produce is rejected.
	payload, _ := json.Marshal(event)
	producer.Input() <- &sarama.ProducerMessage{
		Topic: "quota.event",
		Key:   sarama.StringEncoder(event.ResourceClass),
		Value: sarama.ByteEncoder(payload),
	}
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"reservation_id":"\` + event.ReservationID + \`"}\`))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
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
	topic   = "quota.event"
	acksAll = sarama.WaitForAll
)

var (
	producer sarama.AsyncProducer
	db       *sql.DB
)

type quotaEvent struct {
	Kind          string \`json:"kind"\`
	Team          string \`json:"team"\`
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int    \`json:"amount"\`
	ReservationID string \`json:"reservation_id"\`
}

// publishEvent keys by team so one team's ledger keeps its partition order, waits for the broker,
// and parks the payload in an outbox row when the produce is rejected.
func publishEvent(ctx context.Context, team string, event quotaEvent) error {
	payload, _ := json.Marshal(event)
	deliveryChan := make(chan error, 1)
	producer.Produce(&sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(team),
		Value: sarama.ByteEncoder(payload),
	}, deliveryChan)
	if err := <-deliveryChan; err != nil {
		_, _ = db.ExecContext(ctx, "INSERT INTO outbox (topic, payload) VALUES ($1, $2)", topic, payload)
		return err
	}
	return nil
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	team := r.PathValue("team")
	var event quotaEvent
	_ = json.NewDecoder(r.Body).Decode(&event)
	_ = publishEvent(ctx, team, event)
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"reservation_id":"\` + event.ReservationID + \`"}\`))
}

func main() {
	config := sarama.NewConfig()
	config.Producer.RequiredAcks = acksAll
	config.Producer.Return.Successes = true
	producer, _ = sarama.NewAsyncProducer([]string{"kafka:9092"}, config)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
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

final case class QuotaEvent(
    kind: String,
    team: String,
    window: String,
    resource_class: String,
    amount: Int,
    reservation_id: String,
    user_id: String)

object EventsApi {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  implicit val eventFormat: RootJsonFormat[QuotaEvent] = jsonFormat7(QuotaEvent)

  val Topic = "quota.event"
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props)

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        entity(as[QuotaEvent]) { event =>
          // TODO: this draft keys the event by resource class, includes the requester's user id,
          // produces without acks=all and answers before the broker confirms, and has no outbox.
          // Key by team, publish kind/window/resource_class/amount/reservation_id only, wait for
          // the ack, and park the payload in an outbox when the produce is rejected.
          val payload =
            s"""{"kind":"\${event.kind}","team":"\${event.team}","window":"\${event.window}","resource_class":"\${event.resource_class}","amount":\${event.amount},"reservation_id":"\${event.reservation_id}","user_id":"\${event.user_id}"}"""
          producer.send(new ProducerRecord[String, String](Topic, event.resource_class, payload))
          complete(StatusCodes.Created, s"""{"reservation_id":"\${event.reservation_id}"}""")
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

final case class QuotaEvent(
    kind: String,
    team: String,
    window: String,
    resource_class: String,
    amount: Int,
    reservation_id: String)

object EventsApi {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  implicit val eventFormat: RootJsonFormat[QuotaEvent] = jsonFormat6(QuotaEvent)

  val Topic = "quota.event"
  val AcksAll = "all"
  val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", AcksAll)
  val producer = new KafkaProducer[String, String](props)
  val db = Database.forConfig("quota")

  // Per-team ordering, amounts instead of identities, and an outbox when the broker refuses.
  def publish(team: String, event: QuotaEvent): Unit = {
    val payload =
      s"""{"kind":"\${event.kind}","team":"\${event.team}","window":"\${event.window}","resource_class":"\${event.resource_class}","amount":\${event.amount},"reservation_id":"\${event.reservation_id}"}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, team, payload)).get()
    } catch {
      case _: Exception =>
        db.run(sqlu"INSERT INTO outbox (topic, payload) VALUES ($Topic, $payload)")
    }
  }

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        entity(as[QuotaEvent]) { event =>
          publish(team, event)
          complete(StatusCodes.Created, s"""{"reservation_id":"\${event.reservation_id}"}""")
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

  svr.Post("/v1/quotas/:team/reserve", [&](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: this draft keys the event by resource class, includes the requester's user id, produces
    // without acks=all and answers before the broker confirms, and has no outbox. Key by team,
    // publish kind/window/resource_class/amount/reservation_id only, wait for the ack, and park the
    // payload in an outbox when the produce is rejected.
    const auto payload = json{{"kind", body.value("kind", std::string())},
                              {"team", body.value("team", std::string())},
                              {"window", body.value("window", std::string())},
                              {"resource_class", body.value("resource_class", std::string())},
                              {"amount", body.value("amount", 0)},
                              {"reservation_id", body.value("reservation_id", std::string())},
                              {"user_id", body.value("user_id", std::string())}}
                             .dump();
    cppkafka::MessageBuilder builder("quota.event");
    builder.key(body.value("resource_class", std::string()));
    builder.payload(payload);
    producer.produce(builder);
    res.status = 201;
    res.set_content(json{{"reservation_id", body.value("reservation_id", std::string())}}.dump(), "application/json");
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

const std::string kTopic = "quota.event";
const std::string kAcksAll = "all";

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  cppkafka::Configuration config{
      {"metadata.broker.list", "kafka:9092"},
      {"acks", kAcksAll},
  };
  cppkafka::Producer producer(config);
  httplib::Server svr;

  svr.Post("/v1/quotas/:team/reserve", [&](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // The retained record: what happened to which window, never who asked.
    const auto payload = json{{"kind", body.value("kind", std::string())},
                              {"team", team},
                              {"window", body.value("window", std::string())},
                              {"resource_class", body.value("resource_class", std::string())},
                              {"amount", body.value("amount", 0)},
                              {"reservation_id", body.value("reservation_id", std::string())}}
                             .dump();
    cppkafka::MessageBuilder builder(kTopic);
    builder.key(team);
    builder.payload(payload);
    producer.produce(builder);
    try {
      producer.flush();
    } catch (const cppkafka::KafkaException&) {
      redis.rpush("outbox:quota.event", payload);
    }
    res.status = 201;
    res.set_content(json{{"reservation_id", body.value("reservation_id", std::string())}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The message key decides the partition, and the partition decides order. `key=team` keeps one team’s reserve, release and deny events readable in sequence; keying by resource class scatters every team that shares a class across one partition and interleaves their ledgers.',
    'The topic is retained and replicated, so publish what the ledger needs and nothing about the caller: `{kind, team, window, resource_class, amount, reservation_id}`. A `user_id` in the payload outlives the request, the reservation and the team’s membership.',
    'Do not answer before the broker does. `acks=all` plus a wait on the delivery report (`.get()`, `await`, a delivery channel, a `flush`) makes the write real; when it fails, insert the same payload into an `outbox` row so a replay can rebuild the ledger instead of losing the event.',
  ],
  debrief: `The interview question behind this step is what an event stream is for and what it must never
carry. The ledger is rebuilt from these events, so their order per team is a correctness property,
and order in Kafka is a property of the partition key: key by team and every event of one team
serialises behind the others. The payload is the second half — this topic is retained far longer
than any request, so an identity copied into it becomes a permanent record of who asked, unrelated
to the accounting the event exists for. Durability is the third: an acknowledged produce needs
\`acks=all\`, the response must wait for that acknowledgement, and a rejected produce must land in an
outbox rather than vanish, because a hole in the ledger is indistinguishable from capacity that was
granted and never returned. Real systems add a schema registry so the payload cannot silently grow
a field, compaction keyed by team for the latest ledger state, and an outbox drainer with its own
retry budget.`,
};
