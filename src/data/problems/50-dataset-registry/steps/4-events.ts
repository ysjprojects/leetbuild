import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Registry events keyed by dataset',
  concept: 'kafka',
  file: 'events',
  focus: ['registry', 'kafka', 'consumer', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/datasets/{dataset}/purge\` with body
\`{"version": "2026-01", "reason": "…", "team": "team-lm", "content_sample": "…"}\`. It builds a
\`dataset.purged\` event carrying the team and the content sample, produces it to \`dataset.event\`
keyed by the team, flushes, then calls \`store.commit_purge\`; a rejected produce raises out of the
handler. It compiles, it serves the demo, and it hides four flaws that only show up with a second
producer or a consumer that acts on the event.

**Failure mode the checks target.** Ordering is the subtle one: keying by something that changes
(owner team) means two events for one dataset can be consumed out of order, and an incremental
consumer then believes the older one. Publish-before-commit is the other half: an event is a
promise that the registry state exists, and a promise made early cannot be checked by the consumer.

- Every event goes to \`dataset.event\` **keyed by the dataset name** (\`key\`, \`Key: []byte(dataset)\`,
  \`ProducerRecord(topic, dataset, payload)\`), so one dataset's history lands in one partition.
- The payload carries \`type\`, \`dataset\`, \`version\`, the license id and the validator outcome,
  **not the content sample the validator inspected**.
- The registry write **commits first, then the event is published**.
- If the broker rejects the produce, write an **outbox** row and answer \`503\`.`,
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
        'The produce call passes the dataset name as the message key (`key=dataset`, `key: event.dataset`, `Key: []byte(event.Dataset)`, `ProducerRecord(topic, event.dataset, …)`). The starter keys by owner team, so a dataset’s history reorders.',
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
        'The topic is `dataset.event` and no payload field carries the sample the validator inspected (`content_sample` / `contentSample`). The starter ships the inspected rows into a retained, replicated topic.',
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
        'When the broker rejects the produce the event is written to an outbox row (`write_outbox` / `writeOutbox` / `WriteOutbox`) and the request answers 503, so the event is retried instead of dropped. The starter lets the exception escape.',
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
        'The commit happens before the publish (`store.commit_purge` then `publish_dataset_event`), so no consumer can act on an uncommitted version. The starter acks the produce first.',
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
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Registry events. */
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
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
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
    'After a team handover, a consumer sees `dataset.purged` for `2026-02` before `dataset.promoted` for it and un-purges the view. A broker hiccup turns a purge into a 500 with no event at all.',
    'The key is `event["team"]`, so one dataset lands on two partitions; `content_sample` is copied into the payload; `producer.produce` runs before `store.commit_purge`; a produce error propagates instead of being recorded.',
    'Key the produce with `dataset`, drop `content_sample` from the event, call `store.commit_purge` before `publish_dataset_event`, and wrap the produce so a rejection writes an outbox row and answers 503.',
  ],
  debrief: `The order of the two writes is the whole fix: an event is a promise that the registry state exists, so it can only be made after the commit, and the outbox turns a failed promise into a retry rather than a gap. Keying by the dataset gives one partition per dataset, which is what makes "a dataset's history arrives in order" true at all; a mutable key breaks that the day it changes. Keeping the sample out of the payload keeps tenant bytes out of a topic with its own retention. Production registries put a schema with a compatibility policy on the topic, carry a per-dataset sequence in the payload, compact with tombstones for purged datasets, and have consumers persist the last applied sequence so a replay cannot move a view backwards.`,
};
