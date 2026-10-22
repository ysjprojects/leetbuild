import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Registry events keyed by dataset',
  concept: 'kafka',
  file: 'events',
  focus: ['registry', 'kafka', 'consumer', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the event publisher: it
builds a payload, produces to \`dataset.event\` and acks. It compiles, it serves the demo, and it
hides three production flaws that only show up once there is more than one producer or a consumer
that acts on the event. Review it like the owner of the topic training pins live on.

Implement the event path behind \`POST /v1/datasets/{dataset}/purge\`.

- Every event is produced to the topic \`dataset.event\` **keyed by the dataset name** (\`key\`,
  \`Key: []byte(dataset)\`, \`ProducerRecord(topic, dataset, payload)\`, the message key argument), so
  one dataset's history is ordered and lands in one partition. The draft keys by owner team, so a
  dataset's events scatter and reorder whenever its team changes.
- The payload carries \`type\`, \`dataset\`, \`version\`, the license id and the validator outcome —
  **never the content sample the validator inspected**. A retained topic is the last place tenant
  bytes should live.
- The registry write **commits first, then the event is published**. The draft acks the produce
  before the write commits, so a consumer can act on a version the registry never recorded.
- If the broker rejects the produce, write an **outbox** row and answer \`503\`, so the event is
  retried instead of lost.

**Failure mode the checks target.** Ordering is the subtle one: keying by something that changes
(owner team) means two events for one dataset can be consumed out of order, and a consumer that
builds its view incrementally then believes the older event. Publish-before-commit is the other
half: an event is a promise that the registry state exists, and a promise made early is a lie the
consumer cannot detect.`,
  sequence: {
    participants: ['Registry API', 'registry store', 'Kafka', 'consumer'],
    messages: [
      {from: 'Registry API', to: 'registry store', label: 'commit_purge(dataset, version)', kind: 'sync'},
      {from: 'registry store', to: 'Registry API', label: 'committed', kind: 'reply'},
      {from: 'Registry API', to: 'Kafka', label: 'produce dataset.event key = dataset', kind: 'async'},
      {from: 'Kafka', to: 'Registry API', label: 'ack / rejection', kind: 'reply'},
      {from: 'Registry API', to: 'registry store', label: 'write_outbox on rejection', kind: 'sync'},
      {from: 'Kafka', to: 'consumer', label: 'dataset.purged key = dataset', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/datasets/{dataset}/purge',
      detail: 'Expose the purge that publishes the registry event.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/datasets\/\{dataset\}\/purge["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/datasets\/:dataset\/purge['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/datasets\/\{dataset\}\/purge"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"datasets"\s*\/\s*Segment\s*\/\s*"purge"\s*\)/]},
        cpp: {all: [/svr\.Post\(/, /\/v1\/datasets/, /purge/]},
      },
    },
    {
      id: 'key-by-dataset',
      title: 'Events are keyed by the dataset name',
      detail:
        'The produce call passes the dataset name as the message key (`key=dataset`, `key: event.dataset`, `Key: []byte(event.Dataset)`, `ProducerRecord(topic, event.dataset, …)`). The draft keys by owner team, so a dataset’s history reorders.',
      match: {
        python: {all: [/key=dataset/]},
        typescript: {all: [/key:\s*event\.dataset/]},
        go: {all: [/Key:\s*\[\]byte\(event\.Dataset\)/]},
        scala: {all: [/new ProducerRecord\[String, String\]\(DatasetEventTopic,\s*event\.dataset/]},
        cpp: {all: [/event\.dataset\.c_str\(\)/]},
      },
    },
    {
      id: 'no-content-sample',
      title: 'Payloads carry identity and outcomes, not content',
      detail:
        'The topic is `dataset.event` and no payload field carries the sample the validator inspected (`content_sample` / `contentSample`). The draft ships the inspected rows into a retained, replicated topic.',
      match: {
        python: {all: [/TOPIC\s*=\s*"dataset\.event"/], none: [/content_sample|contentSample/]},
        typescript: {all: [/TOPIC\s*=\s*'dataset\.event'/], none: [/contentSample/]},
        go: {all: [/datasetEventTopic\s*=\s*"dataset\.event"/], none: [/ContentSample/]},
        scala: {all: [/DatasetEventTopic\s*=\s*"dataset\.event"/], none: [/contentSample/]},
        cpp: {all: [/kDatasetEventTopic\s*=\s*"dataset\.event"/], none: [/content_sample/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce lands in the outbox',
      detail:
        'When the broker rejects the produce the event is written to an outbox row (`write_outbox` / `writeOutbox` / `WriteOutbox`) and the request answers 503, so the event is retried instead of dropped. The draft lets the exception escape.',
      match: {
        python: {all: [/store\.write_outbox\(/, /KafkaException/]},
        typescript: {all: [/store\.writeOutbox\(/, /catch\s*\(/]},
        go: {all: [/store\.WriteOutbox\(/, /err != nil/]},
        scala: {all: [/store\.writeOutbox\(/, /catch/]},
        cpp: {all: [/store\.write_outbox\(/, /catch/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'The registry write commits before the event is published',
      detail:
        'The commit happens before the publish (`store.commit_purge` then `publish_dataset_event`), so no consumer can act on an uncommitted version. The draft acks the produce first.',
      match: {
        python: {order: [/store\.commit_purge\(/, /publish_dataset_event\(/]},
        typescript: {order: [/store\.commitPurge\(/, /publishDatasetEvent\(/]},
        go: {order: [/store\.CommitPurge\(/, /publishDatasetEvent\(/]},
        scala: {order: [/store\.commitPurge\(/, /publishDatasetEvent\(/]},
        cpp: {order: [/store\.commit_purge\(/, /publish_dataset_event\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("registry-events")

TOPIC = "dataset.event"
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


class PurgeRequest(BaseModel):
    version: str
    reason: str
    team: str
    content_sample: str


class RegistryStore:
    def commit_purge(self, dataset: str, version: str) -> None:
        raise NotImplementedError


store = RegistryStore()


def publish_dataset_event(event: dict) -> None:
    # TODO: this draft keys by owner team, ships the content sample the validator inspected, and
    # acks the produce before the registry write commits. Review all three.
    team = event["team"]
    producer.produce(TOPIC, key=team.encode("utf-8"), value=json.dumps(event).encode("utf-8"))
    producer.flush()


@app.post("/v1/datasets/{dataset}/purge")
def purge(dataset: str, body: PurgeRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    event = {
        "type": "dataset.purged",
        "dataset": dataset,
        "version": body.version,
        "team": body.team,
        "content_sample": body.content_sample,
    }
    publish_dataset_event(event)
    store.commit_purge(dataset, body.version)
    logger.info("purged dataset=%s version=%s", dataset, body.version)
    return JSONResponse({"dataset": dataset, "version": body.version}, status_code=200)
`,
      solution: `import json
import logging

from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("registry-events")

TOPIC = "dataset.event"
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


class PurgeRequest(BaseModel):
    version: str
    reason: str


class RegistryStore:
    """The registry write boundary; the event is published only after it commits."""

    def commit_purge(self, dataset: str, version: str) -> None:
        raise NotImplementedError

    def write_outbox(self, dataset: str, event: dict) -> None:
        raise NotImplementedError


store = RegistryStore()


def dataset_event(event_type: str, dataset: str, version: str, license_id: str, validator: str) -> dict:
    """Identity and outcomes only: never the content the validator inspected."""
    return {
        "type": event_type,
        "dataset": dataset,
        "version": version,
        "license": license_id,
        "validator": validator,
    }


def publish_dataset_event(event: dict) -> None:
    """Keyed by the dataset name, so one dataset's history stays in one ordered partition."""
    dataset = event["dataset"]
    producer.produce(TOPIC, key=dataset.encode("utf-8"), value=json.dumps(event).encode("utf-8"))
    producer.poll(0)


@app.post("/v1/datasets/{dataset}/purge")
def purge(
    dataset: str, body: PurgeRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    store.commit_purge(dataset, body.version)
    event = dataset_event("dataset.purged", dataset, body.version, body.reason, tenant)
    try:
        publish_dataset_event(event)
    except KafkaException as err:
        store.write_outbox(dataset, event)
        raise HTTPException(status_code=503, detail="TRY_AGAIN") from err
    logger.info("purged dataset=%s version=%s", dataset, body.version)
    return JSONResponse({"dataset": dataset, "version": body.version}, status_code=200)
`,
    },
    typescript: {
      starter: `/** Registry events: a model-generated draft. */
import Fastify from 'fastify';
import {Kafka, type Producer} from 'kafkajs';

export const app = Fastify();

const TOPIC = 'dataset.event';

const kafka = new Kafka({clientId: 'dataset-registry', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

interface PurgeBody {
  version: string;
  reason: string;
  team: string;
  contentSample: string;
}

interface DatasetEvent {
  type: string;
  dataset: string;
  version: string;
  team: string;
  contentSample: string;
}

class RegistryStore {
  async commitPurge(dataset: string, version: string): Promise<void> {
    void dataset;
    void version;
    throw new Error('not implemented');
  }
}

const store = new RegistryStore();

async function publishDatasetEvent(event: DatasetEvent): Promise<void> {
  // TODO: this draft keys by owner team, ships the content sample the validator inspected, and
  // acks the produce before the registry write commits. Review all three.
  await producer.send({topic: TOPIC, messages: [{key: event.team, value: JSON.stringify(event)}]});
}

app.post('/v1/datasets/:dataset/purge', async (request, reply) => {
  const dataset = (request.params as {dataset: string}).dataset;
  const body = request.body as PurgeBody;
  const event: DatasetEvent = {
    type: 'dataset.purged',
    dataset,
    version: body.version,
    team: body.team,
    contentSample: body.contentSample,
  };
  await publishDatasetEvent(event);
  await store.commitPurge(dataset, body.version);
  return reply.code(200).send({dataset, version: body.version});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Registry events: keyed by dataset, published after the commit, outbox on rejection. */
import Fastify from 'fastify';
import {Kafka, type Producer} from 'kafkajs';

export const app = Fastify();

const TOPIC = 'dataset.event';

const kafka = new Kafka({clientId: 'dataset-registry', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});

interface PurgeBody {
  version: string;
  reason: string;
}

interface DatasetEvent {
  type: string;
  dataset: string;
  version: string;
  license: string;
  validator: string;
}

class RegistryStore {
  async commitPurge(dataset: string, version: string): Promise<void> {
    void dataset;
    void version;
    throw new Error('not implemented');
  }

  async writeOutbox(dataset: string, event: DatasetEvent): Promise<void> {
    void dataset;
    void event;
    throw new Error('not implemented');
  }
}

const store = new RegistryStore();

function datasetEvent(
  type: string,
  dataset: string,
  version: string,
  license: string,
  validator: string,
): DatasetEvent {
  // Identity and outcomes only: never the content the validator inspected.
  return {type, dataset, version, license, validator};
}

async function publishDatasetEvent(event: DatasetEvent): Promise<void> {
  // Keyed by the dataset name, so one dataset's history stays in one ordered partition.
  await producer.send({topic: TOPIC, messages: [{key: event.dataset, value: JSON.stringify(event)}]});
}

app.post('/v1/datasets/:dataset/purge', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const dataset = (request.params as {dataset: string}).dataset;
  const body = request.body as PurgeBody;
  await store.commitPurge(dataset, body.version);
  const event = datasetEvent('dataset.purged', dataset, body.version, body.reason, tenant);
  try {
    await publishDatasetEvent(event);
  } catch (err) {
    await store.writeOutbox(dataset, event);
    return reply.code(503).send({error: 'TRY_AGAIN'});
  }
  request.log.info({dataset, version: body.version}, 'purged');
  return reply.code(200).send({dataset, version: body.version});
});

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

	"github.com/segmentio/kafka-go"
)

const datasetEventTopic = "dataset.event"

type DatasetEvent struct {
	Type          string \`json:"type"\`
	Dataset       string \`json:"dataset"\`
	Version       string \`json:"version"\`
	Team          string \`json:"team"\`
	ContentSample string \`json:"content_sample"\`
}

func publishDatasetEvent(ctx context.Context, writer *kafka.Writer, event DatasetEvent) error {
	// TODO: this draft keys by owner team, ships the content sample the validator inspected, and
	// acks the produce before the registry write commits. Review all three.
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Topic: datasetEventTopic, Key: []byte(event.Team), Value: payload})
}

func main() {
	writer := &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/datasets/{dataset}/purge", func(rw http.ResponseWriter, r *http.Request) {
		var body DatasetEvent
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "invalid json", http.StatusBadRequest)
			return
		}
		body.Dataset = r.PathValue("dataset")
		if err := publishDatasetEvent(r.Context(), writer, body); err != nil {
			http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
			return
		}
		store.CommitPurge(r.Context(), body.Dataset, body.Version)
		writeJSON(rw, http.StatusOK, map[string]any{"dataset": body.Dataset, "version": body.Version})
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
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

const datasetEventTopic = "dataset.event"

type DatasetEvent struct {
	Type      string \`json:"type"\`
	Dataset   string \`json:"dataset"\`
	Version   string \`json:"version"\`
	License   string \`json:"license"\`
	Validator string \`json:"validator"\`
}

func publishDatasetEvent(ctx context.Context, writer *kafka.Writer, event DatasetEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	// Keyed by the dataset name, so one dataset's history stays in one ordered partition.
	return writer.WriteMessages(ctx, kafka.Message{
		Topic: datasetEventTopic,
		Key:   []byte(event.Dataset),
		Value: payload,
	})
}

func main() {
	writer := &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/datasets/{dataset}/purge", func(rw http.ResponseWriter, r *http.Request) {
		var body DatasetEvent
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "invalid json", http.StatusBadRequest)
			return
		}
		body.Dataset = r.PathValue("dataset")
		if err := store.CommitPurge(r.Context(), body.Dataset, body.Version); err != nil {
			http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
			return
		}
		if err := publishDatasetEvent(r.Context(), writer, body); err != nil {
			store.WriteOutbox(r.Context(), body.Dataset, body)
			http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"dataset": body.Dataset, "version": body.Version})
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class DatasetEvent(eventType: String, dataset: String, version: String, team: String, contentSample: String)

object Events {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")
  implicit val eventFormat: RootJsonFormat[DatasetEvent] = jsonFormat5(DatasetEvent)

  val DatasetEventTopic = "dataset.event"
  val producer = new KafkaProducer[String, String](new Properties())

  def publishDatasetEvent(event: DatasetEvent): Unit = {
    // TODO: this draft keys by owner team, ships the content sample the validator inspected, and
    // acks the produce before the registry write commits. Review all three.
    producer.send(new ProducerRecord[String, String](DatasetEventTopic, event.team, event.toString))
  }

  val route: Route =
    path("v1" / "datasets" / Segment / "purge") { dataset =>
      post {
        entity(as[DatasetEvent]) { body =>
          publishDatasetEvent(body.copy(dataset = dataset))
          store.commitPurge(dataset, body.version)
          complete(StatusCodes.OK, s"""{"dataset":"$dataset","version":"\${body.version}"}""")
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class DatasetEvent(eventType: String, dataset: String, version: String, license: String, validator: String)

object Events {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")
  implicit val eventFormat: RootJsonFormat[DatasetEvent] = jsonFormat5(DatasetEvent)

  val DatasetEventTopic = "dataset.event"
  val producer = new KafkaProducer[String, String](new Properties())

  def publishDatasetEvent(event: DatasetEvent): Unit = {
    // Keyed by the dataset name, so one dataset's history stays in one ordered partition.
    producer.send(new ProducerRecord[String, String](DatasetEventTopic, event.dataset, event.toString))
  }

  val route: Route =
    path("v1" / "datasets" / Segment / "purge") { dataset =>
      post {
        entity(as[DatasetEvent]) { body =>
          store.commitPurge(dataset, body.version)
          val event = body.copy(dataset = dataset)
          try {
            publishDatasetEvent(event)
          } catch {
            case _: Throwable =>
              store.writeOutbox(dataset, event)
              complete(StatusCodes.ServiceUnavailable, """{"error":"TRY_AGAIN"}""")
              throw new IllegalStateException("outboxed")
          }
          system.log.info(s"purged dataset=$dataset version=\${body.version}")
          complete(StatusCodes.OK, s"""{"dataset":"$dataset","version":"\${body.version}"}""")
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
      starter: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

const std::string kDatasetEventTopic = "dataset.event";

struct DatasetEvent {
  std::string type;
  std::string dataset;
  std::string version;
  std::string team;
  std::string content_sample;
};

static std::string toJson(const DatasetEvent& event) {
  return json{{"type", event.type},         {"dataset", event.dataset},
              {"version", event.version},   {"team", event.team},
              {"content_sample", event.content_sample}}
      .dump();
}

static void publish_dataset_event(RdKafka::Producer* producer, const DatasetEvent& event) {
  // TODO: this draft keys by owner team, ships the content sample the validator inspected, and
  // acks the produce before the registry write commits. Review all three.
  const std::string payload = toJson(event);
  producer->produce(kDatasetEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), event.team.c_str(), event.team.size(), 0,
                    nullptr);
}

int main() {
  std::string errstr;
  auto* producer = RdKafka::Producer::create(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL), errstr);
  httplib::Server svr;

  svr.Post(R"(/v1/datasets/([^/]+)/purge)", [producer](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    DatasetEvent event{body.value("type", "dataset.purged"), req.matches[1],
                       body.value("version", std::string()), body.value("team", std::string()),
                       body.value("content_sample", std::string())};
    publish_dataset_event(producer, event);
    store.commit_purge(event.dataset, event.version);
    res.status = 200;
    res.set_content(json{{"dataset", event.dataset}, {"version", event.version}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

const std::string kDatasetEventTopic = "dataset.event";

struct DatasetEvent {
  std::string type;
  std::string dataset;
  std::string version;
  std::string license;
  std::string validator;
};

/** Identity and outcomes only: never the content the validator inspected. */
static std::string toJson(const DatasetEvent& event) {
  return json{{"type", event.type},        {"dataset", event.dataset},
              {"version", event.version},  {"license", event.license},
              {"validator", event.validator}}
      .dump();
}

static void publish_dataset_event(RdKafka::Producer* producer, const DatasetEvent& event) {
  // Keyed by the dataset name, so one dataset's history stays in one ordered partition.
  const std::string payload = toJson(event);
  producer->produce(kDatasetEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), event.dataset.c_str(), event.dataset.size(),
                    0, nullptr);
  producer->poll(0);
}

int main() {
  std::string errstr;
  auto* producer = RdKafka::Producer::create(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL), errstr);
  httplib::Server svr;

  svr.Post(R"(/v1/datasets/([^/]+)/purge)", [producer](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const std::string dataset = req.matches[1];
    DatasetEvent event{"dataset.purged", dataset, body.value("version", std::string()),
                       body.value("reason", std::string()), "purge"};
    store.commit_purge(event.dataset, event.version);
    try {
      publish_dataset_event(producer, event);
    } catch (const std::exception& err) {
      store.write_outbox(event.dataset, toJson(event));
      res.status = 503;
      res.set_content(R"({"error":"TRY_AGAIN"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"dataset", event.dataset}, {"version", event.version}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The message key decides the partition, and the partition decides the order a consumer sees. Key by `dataset` — the thing whose history must be ordered — not by the team that happened to own it this quarter.',
    'A payload carries identity and outcomes: type, dataset, version, license id, validator result. The inspected sample belongs to the validator’s report, not to a retained topic with a longer retention than the dataset itself.',
    'Publish after the commit, and keep the produce inside the same try: a rejection writes an outbox row and returns 503. An event is a promise that the registry state exists; published early, it is a promise the consumer cannot verify.',
  ],
  debrief: `The interviewer is testing whether you understand a topic as an ordered log per key and an event as a promise about committed state. The draft reads fine with one producer, one team and a fast broker. Three defects are checked: the key (ordering), the payload (content leakage into a retained topic), and the ordering relative to the registry commit (consumers acting on uncommitted versions), with the outbox as the durability half of the same argument. Real registries add a schema registry with a compatibility policy, a per-dataset event version in the payload, compaction with a tombstone for purged datasets, and a consumer that stores the last applied version so a replayed partition cannot move a view backwards.`,
};
