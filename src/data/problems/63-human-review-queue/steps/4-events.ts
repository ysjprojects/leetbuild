import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Review events keyed by source id, reviewer anonymized',
  concept: 'kafka',
  file: 'events',
  focus: ['queue', 'kafka', 'consumer', 'items'],
  task: `## Task

**Review premise.** The starter publishes one \`review.event\` per resolution. It looks right in a
single-reviewer demo. In production the key sends one item's events to different partitions, the
reviewer's name sits in a retained, replicated topic, and the event can describe a resolution the
item store never recorded. Review it, fix it, and prove the fix with the checks below.

Implement the **Kafka** lifecycle path for review items:

- **One topic, keyed by source id.** Publish to \`review.event\` with the message key set to the
  source id (\`event_key(source_id)\`), so every enqueue, assign, resolve and breach for one source
  lands in one partition and stays ordered. Keying by the reviewer breaks that ordering — one
  reviewer handles many sources.
- **The four lifecycle events.** \`enqueued\`, \`assigned\`, \`resolved\` and \`breached\` are the
  event types. Each carries \`priority\`, the SLA state and the outcome category — and the tenant.
- **Reviewer references only, never identity.** The event carries \`reviewer_ref\`, an opaque id used
  for audit. The reviewer's name or email must never appear in the event, and neither must the
  payload text: the topic is retained and replicated, so it is exactly the wrong place for user text.
- **Publish after commit.** The item record commits first; the event is produced only after
  \`store.commit(record)\` succeeds (\`publish_after_commit\`), so an event can never describe a state
  the item store did not reach. The draft produces first and commits after.
- **Idempotent producer with \`acks=all\`.** Set \`acks\` to all (and idempotence on), so a broker
  failover cannot silently drop or duplicate the event.

**Failure mode the checks target.** Three defects. Keying by reviewer destroys per-source ordering, so
a consumer applying events in partition order can mark an item resolved and then assigned. Naming the
reviewer (and inlining payload text) leaks identity and user content into a retained topic. And
publishing before the commit means a crash between the two leaves an event for a resolution that never
happened.`,
  sequence: {
    participants: ['Review Queue', 'Item store', 'review.event', 'Event consumer'],
    messages: [
      {from: 'Review Queue', to: 'Item store', label: 'commit(item record · outcome)', kind: 'sync'},
      {from: 'Item store', to: 'Review Queue', label: 'committed', kind: 'reply'},
      {from: 'Review Queue', to: 'review.event', label: 'produce key = source_id · acks=all', kind: 'async'},
      {from: 'review.event', to: 'Event consumer', label: 'consume · partition = source_id', kind: 'async'},
      {from: 'Event consumer', to: 'Item store', label: 'audit projection', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'key-source',
      title: 'Events are keyed by source id',
      detail:
        'The message key is the source id (`event_key(source_id)`), so one source’s lifecycle stays in one partition. The draft keys by the reviewer.',
      match: {
        python: {all: [/def event_key\(/, /source_id/]},
        typescript: {all: [/function eventKey\(/, /sourceId/]},
        go: {all: [/func eventKey\(/, /SourceID/]},
        scala: {all: [/def eventKey\(/, /sourceId/]},
        cpp: {all: [/eventKey\(/, /source_id/]},
      },
    },
    {
      id: 'anonymized',
      title: 'Reviewer is an opaque reference; no payload text',
      detail:
        'The event carries `reviewer_ref` for audit and nothing identifying the reviewer; the payload text never reaches the topic. The draft names the reviewer and inlines the payload.',
      match: {
        python: {all: [/reviewer_ref/], none: [/reviewer_name|reviewer_email|payload_text/]},
        typescript: {all: [/reviewerRef/], none: [/reviewerName|reviewerEmail|payloadText/]},
        go: {all: [/ReviewerRef/], none: [/ReviewerName|ReviewerEmail|PayloadText/]},
        scala: {all: [/reviewerRef/], none: [/reviewerName|reviewerEmail|payloadText/]},
        cpp: {all: [/reviewer_ref/], none: [/reviewer_name|reviewer_email|payload_text/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Publish happens after the item record commits',
      detail:
        'The event is produced through `publish_after_commit`, called only after `store.commit(...)` succeeds. The draft produces first and commits after.',
      match: {
        python: {all: [/def publish_after_commit\(/]},
        typescript: {all: [/function publishAfterCommit\(/]},
        go: {all: [/func publishAfterCommit\(/]},
        scala: {all: [/def publishAfterCommit\(/]},
        cpp: {all: [/publishAfterCommit\(/]},
      },
    },
    {
      id: 'lifecycle-events',
      title: 'Covers the enqueue, assign, resolve and breach lifecycle',
      detail:
        'The four event types — `enqueued`, `assigned`, `resolved`, `breached` — are all published. The draft only ever publishes a resolution.',
      match: {
        python: {all: [/enqueued/, /assigned/, /resolved/, /breached/]},
        typescript: {all: [/enqueued/, /assigned/, /resolved/, /breached/]},
        go: {all: [/enqueued/, /assigned/, /resolved/, /breached/]},
        scala: {all: [/enqueued/, /assigned/, /resolved/, /breached/]},
        cpp: {all: [/enqueued/, /assigned/, /resolved/, /breached/]},
      },
    },
    {
      id: 'acks-all',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for `acks=all` (and idempotence), so a broker failover cannot drop the event. The draft leaves the default acks.',
      match: {
        python: {all: [/acks\s*=\s*['"]all['"]/]},
        typescript: {all: [/acks:\s*-1/]},
        go: {all: [/kafka\.RequireAll|RequiredAcks/]},
        scala: {all: [/acks",\s*"all"/]},
        cpp: {all: [/"acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from kafka import KafkaProducer

app = FastAPI()

producer = KafkaProducer(
    bootstrap_servers=["kafka:9092"],
    value_serializer=lambda v: json.dumps(v).encode(),
)


class ResolveBody(BaseModel):
    source_id: str
    reviewer: str
    outcome: str
    payload_text: str = ""


@app.post("/v1/review/items/{item_id}/resolve")
def resolve(
    item_id: str,
    body: ResolveBody,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft keys by the reviewer, names the reviewer in the event and publishes the
    # resolution before the item record commits. Review all three.
    event = {
        "event_type": "resolution",
        "item_id": item_id,
        "source_id": body.source_id,
        "reviewer_name": body.reviewer,
        "payload_text": body.payload_text,
    }
    producer.send("review.event", key=body.reviewer.encode(), value=event)
    store.commit({**event, "tenant": tenant})
    return JSONResponse({"item_id": item_id, "outcome": body.outcome})
`,
      solution: `import json

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from kafka import KafkaProducer

app = FastAPI()

producer = KafkaProducer(
    bootstrap_servers=["kafka:9092"],
    acks="all",
    enable_idempotence=True,
    key_serializer=lambda k: k.encode(),
    value_serializer=lambda v: json.dumps(v).encode(),
)

TOPIC = "review.event"
EVENT_ENQUEUED = "enqueued"
EVENT_ASSIGNED = "assigned"
EVENT_RESOLVED = "resolved"
EVENT_BREACHED = "breached"


class ResolveBody(BaseModel):
    source_id: str
    priority: str
    outcome: str
    reviewer_ref: str
    sla_state: str = "ok"


def event_key(source_id: str) -> str:
    key = source_id.strip()
    return key


def publish_after_commit(tenant: str, source_id: str, event: dict) -> None:
    envelope = {"tenant": tenant, "source_id": source_id, **event}
    producer.send(TOPIC, key=event_key(source_id), value=envelope)
    producer.flush()


def emit_enqueued(tenant: str, source_id: str, priority: str) -> None:
    publish_after_commit(tenant, source_id, {"event_type": EVENT_ENQUEUED, "priority": priority})


def emit_assigned(tenant: str, source_id: str, priority: str, reviewer_ref: str) -> None:
    publish_after_commit(
        tenant, source_id, {"event_type": EVENT_ASSIGNED, "priority": priority, "reviewer_ref": reviewer_ref}
    )


def emit_resolved(tenant: str, source_id: str, outcome: str, reviewer_ref: str) -> None:
    publish_after_commit(
        tenant, source_id, {"event_type": EVENT_RESOLVED, "outcome": outcome, "reviewer_ref": reviewer_ref}
    )


def emit_breached(tenant: str, source_id: str, priority: str, sla_state: str) -> None:
    publish_after_commit(
        tenant, source_id, {"event_type": EVENT_BREACHED, "priority": priority, "sla_state": sla_state}
    )


@app.post("/v1/review/items/{item_id}/resolve")
def resolve(
    item_id: str,
    body: ResolveBody,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    record = {
        "tenant": tenant,
        "item_id": item_id,
        "source_id": body.source_id,
        "priority": body.priority,
        "sla_state": body.sla_state,
        "outcome": body.outcome,
        "reviewer_ref": body.reviewer_ref,
    }
    store.commit(record)
    emit_resolved(tenant, body.source_id, body.outcome, body.reviewer_ref)
    return JSONResponse({"item_id": item_id, "outcome": body.outcome})
`,
    },
    typescript: {
      starter: `/** POST /v1/review/items/{id}/resolve: a model-generated draft that publishes too early. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();

const kafka = new Kafka({brokers: ['kafka:9092'], clientId: 'reviewd'});
const producer = kafka.producer();

interface ResolveBody {
  source_id: string;
  reviewer: string;
  outcome: string;
  payloadText?: string;
}

app.post('/v1/review/items/:item_id/resolve', async (request, reply) => {
  // TODO: this draft keys by the reviewer, names the reviewer in the event and publishes the
  // resolution before the item record commits. Review all three.
  const body = request.body as ResolveBody;
  const event = {
    event_type: 'resolution',
    item_id: request.params['item_id'],
    source_id: body.source_id,
    reviewerName: body.reviewer,
    payloadText: body.payloadText ?? '',
  };
  await producer.send({topic: 'review.event', messages: [{key: body.reviewer, value: JSON.stringify(event)}]});
  await store.commit({...event, tenant: request.headers['x-tenant-id']});
  return reply.code(200).send({item_id: request.params['item_id'], outcome: body.outcome});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/review/items/{id}/resolve: source-keyed lifecycle events, publish after commit. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();

const kafka = new Kafka({brokers: ['kafka:9092'], clientId: 'reviewd'});
const producer = kafka.producer({acks: -1, idempotent: true});

const TOPIC = 'review.event';
const EVENT_ENQUEUED = 'enqueued';
const EVENT_ASSIGNED = 'assigned';
const EVENT_RESOLVED = 'resolved';
const EVENT_BREACHED = 'breached';

interface ResolveBody {
  source_id: string;
  priority: string;
  outcome: string;
  reviewer_ref: string;
  sla_state?: string;
}

function eventKey(sourceId: string): string {
  const trimmed = sourceId.trim();
  return trimmed;
}

async function publishAfterCommit(tenant: string, sourceId: string, event: Record<string, unknown>): Promise<void> {
  const envelope = {tenant, source_id: sourceId, ...event};
  await producer.send({
    topic: TOPIC,
    messages: [{key: eventKey(sourceId), value: JSON.stringify(envelope)}],
  });
}

function emitEnqueued(tenant: string, sourceId: string, priority: string): Promise<void> {
  return publishAfterCommit(tenant, sourceId, {event_type: EVENT_ENQUEUED, priority});
}

function emitAssigned(tenant: string, sourceId: string, priority: string, reviewerRef: string): Promise<void> {
  return publishAfterCommit(tenant, sourceId, {event_type: EVENT_ASSIGNED, priority, reviewer_ref: reviewerRef});
}

function emitResolved(tenant: string, sourceId: string, outcome: string, reviewerRef: string): Promise<void> {
  return publishAfterCommit(tenant, sourceId, {event_type: EVENT_RESOLVED, outcome, reviewer_ref: reviewerRef});
}

function emitBreached(tenant: string, sourceId: string, priority: string, slaState: string): Promise<void> {
  return publishAfterCommit(tenant, sourceId, {event_type: EVENT_BREACHED, priority, sla_state: slaState});
}

app.post('/v1/review/items/:item_id/resolve', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as ResolveBody;
  const record = {
    tenant,
    item_id: request.params['item_id'],
    source_id: body.source_id,
    priority: body.priority,
    sla_state: body.sla_state ?? 'ok',
    outcome: body.outcome,
    reviewer_ref: body.reviewer_ref,
  };
  await store.commit(record);
  await emitResolved(tenant, body.source_id, body.outcome, body.reviewer_ref);
  return reply.code(200).send({item_id: record.item_id, outcome: body.outcome});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/IBM/sarama"
)

var producer sarama.SyncProducer

type ReviewEvent struct {
	EventType   string \`json:"event_type"\`
	ItemID      string \`json:"item_id"\`
	SourceID    string \`json:"source_id"\`
	ReviewerName string \`json:"reviewer_name"\`
	PayloadText string \`json:"payload_text"\`
}

func resolve(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var event ReviewEvent
	_ = json.NewDecoder(r.Body).Decode(&event)
	// TODO: this draft keys by the reviewer, names the reviewer in the event and publishes the
	// resolution before the item record commits. Review all three.
	payload, _ := json.Marshal(event)
	producer.SendMessage(&sarama.ProducerMessage{
		Topic: "review.event",
		Key:   sarama.StringEncoder(event.ReviewerName),
		Value: sarama.ByteEncoder(payload),
	})
	store.Commit(tenant, event)
	rw.WriteHeader(http.StatusOK)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/review/items/{item_id}/resolve", resolve)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/IBM/sarama"
)

const topic = "review.event"

const (
	eventEnqueued = "enqueued"
	eventAssigned = "assigned"
	eventResolved = "resolved"
	eventBreached = "breached"
)

type ReviewEvent struct {
	EventType   string \`json:"event_type"\`
	Tenant      string \`json:"tenant"\`
	SourceID    string \`json:"source_id"\`
	Priority    string \`json:"priority"\`
	SLAState    string \`json:"sla_state"\`
	Outcome     string \`json:"outcome"\`
	ReviewerRef string \`json:"reviewer_ref"\`
}

var producer sarama.SyncProducer

func eventKey(sourceID string) string {
	return strings.TrimSpace(sourceID)
}

func publishAfterCommit(tenant, sourceID string, event map[string]any) error {
	envelope := map[string]any{"tenant": tenant, "source_id": sourceID}
	for key, value := range event {
		envelope[key] = value
	}
	payload, _ := json.Marshal(envelope)
	_, _, err := producer.SendMessage(&sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(eventKey(sourceID)),
		Value: sarama.ByteEncoder(payload),
	})
	return err
}

func emitResolved(tenant, sourceID, outcome, reviewerRef string) error {
	return publishAfterCommit(tenant, sourceID, map[string]any{
		"event_type": eventResolved, "outcome": outcome, "reviewer_ref": reviewerRef,
	})
}

func emitEnqueued(tenant, sourceID, priority string) error {
	return publishAfterCommit(tenant, sourceID, map[string]any{"event_type": eventEnqueued, "priority": priority})
}

func emitAssigned(tenant, sourceID, priority, reviewerRef string) error {
	return publishAfterCommit(tenant, sourceID, map[string]any{
		"event_type": eventAssigned, "priority": priority, "reviewer_ref": reviewerRef,
	})
}

func emitBreached(tenant, sourceID, priority, slaState string) error {
	return publishAfterCommit(tenant, sourceID, map[string]any{
		"event_type": eventBreached, "priority": priority, "sla_state": slaState,
	})
}

func resolve(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var event ReviewEvent
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		http.Error(rw, "invalid json", http.StatusBadRequest)
		return
	}
	event.Tenant = tenant
	store.Commit(tenant, event)
	if err := emitResolved(tenant, event.SourceID, event.Outcome, event.ReviewerRef); err != nil {
		log.Printf("publish failed source=%s: %v", event.SourceID, err)
	}
	rw.WriteHeader(http.StatusOK)
}

func main() {
	config := sarama.NewConfig()
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Idempotent = true
	config.Net.MaxOpenRequests = 1
	var err error
	producer, err = sarama.NewSyncProducer([]string{"kafka:9092"}, config)
	if err != nil {
		log.Fatal(err)
	}
	_ = context.Background()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/review/items/{item_id}/resolve", resolve)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

import scala.jdk.CollectionConverters._
import java.util.Properties

case class ReviewEvent(eventType: String, itemId: String, sourceId: String, reviewerName: String, payloadText: String)

object Events {
  def resolve(tenant: String, event: ReviewEvent): Unit = {
    // TODO: this draft keys by the reviewer, names the reviewer in the event and publishes the
    // resolution before the item record commits. Review all three.
    val record = event.copy(eventType = "resolution")
    producer.send(new ProducerRecord[String, String]("review.event", event.reviewerName, record.toString))
    store.commit(tenant, record)
  }
}

object Api {
  def route: Route =
    path("v1" / "review" / "items" / Segment / "resolve") { itemId =>
      post {
        entity(as[ReviewEvent]) { event =>
          headerValueByName("X-Tenant-Id") { tenant =>
            Events.resolve(tenant, event)
            complete(StatusCodes.OK, "resolved")
          }
        }
      }
    }
}
`,
      solution: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

case class ReviewEvent(
    eventType: String,
    tenant: String,
    sourceId: String,
    priority: String,
    slaState: String,
    outcome: String,
    reviewerRef: String,
)

object Events {
  val Topic = "review.event"
  val EventEnqueued = "enqueued"
  val EventAssigned = "assigned"
  val EventResolved = "resolved"
  val EventBreached = "breached"

  val props: java.util.Properties = {
    val p = new java.util.Properties()
    p.put("bootstrap.servers", "kafka:9092")
    p.put("acks", "all")
    p.put("enable.idempotence", "true")
    p
  }

  def eventKey(sourceId: String): String = sourceId.trim

  def publishAfterCommit(tenant: String, sourceId: String, event: Map[String, String]): Unit = {
    val envelope = event + ("tenant" -> tenant) + ("source_id" -> sourceId)
    producer.send(new ProducerRecord[String, String](Topic, eventKey(sourceId), envelope.toString))
  }

  def emitEnqueued(tenant: String, sourceId: String, priority: String): Unit =
    publishAfterCommit(tenant, sourceId, Map("event_type" -> EventEnqueued, "priority" -> priority))

  def emitAssigned(tenant: String, sourceId: String, priority: String, reviewerRef: String): Unit =
    publishAfterCommit(tenant, sourceId, Map("event_type" -> EventAssigned, "priority" -> priority, "reviewer_ref" -> reviewerRef))

  def emitResolved(tenant: String, sourceId: String, outcome: String, reviewerRef: String): Unit =
    publishAfterCommit(tenant, sourceId, Map("event_type" -> EventResolved, "outcome" -> outcome, "reviewer_ref" -> reviewerRef))

  def emitBreached(tenant: String, sourceId: String, priority: String, slaState: String): Unit =
    publishAfterCommit(tenant, sourceId, Map("event_type" -> EventBreached, "priority" -> priority, "sla_state" -> slaState))

  def resolve(tenant: String, event: ReviewEvent): Unit = {
    val record = event.copy(tenant = tenant)
    store.commit(tenant, record)
    emitResolved(tenant, event.sourceId, event.outcome, event.reviewerRef)
  }
}

object Api {
  def route: Route =
    path("v1" / "review" / "items" / Segment / "resolve") { _ =>
      post {
        entity(as[ReviewEvent]) { event =>
          headerValueByName("X-Tenant-Id") { tenant =>
            Events.resolve(tenant, event)
            complete(StatusCodes.OK, "resolved")
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <string>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

struct ReviewEvent {
  std::string event_type;
  std::string item_id;
  std::string source_id;
  std::string reviewer_name;
  std::string payload_text;
};

int main() {
  httplib::Server svr;
  svr.Post("/v1/review/items/([^/]+)/resolve", [](const httplib::Request& req, httplib::Response& res) {
    auto body = json::parse(req.body);
    // TODO: this draft keys by the reviewer, names the reviewer in the event and publishes the
    // resolution before the item record commits. Review all three.
    json event = {
        {"event_type", "resolution"},
        {"item_id", "item"},
        {"source_id", body["source_id"]},
        {"reviewer_name", body["reviewer"]},
        {"payload_text", body["payload_text"]},
    };
    producer.produce("review.event", body["reviewer"].get<std::string>(), event.dump());
    store.commit(req.get_header_value("X-Tenant-Id"), event);
    res.status = 200;
    res.set_content(R"({"outcome":"resolved"})", "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <string>
#include <map>
#include <vector>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

const std::string kTopic = "review.event";
const std::string kEventEnqueued = "enqueued";
const std::string kEventAssigned = "assigned";
const std::string kEventResolved = "resolved";
const std::string kEventBreached = "breached";

std::string eventKey(const std::string& source_id) {
  auto trimmed = source_id;
  while (!trimmed.empty() && trimmed.front() == ' ') trimmed.erase(trimmed.begin());
  return trimmed;
}

void publishAfterCommit(const std::string& tenant, const std::string& source_id, const json& event) {
  json envelope = {{"tenant", tenant}, {"source_id", source_id}};
  for (auto it = event.begin(); it != event.end(); ++it) envelope[it.key()] = it.value();
  producer.produce(kTopic, eventKey(source_id), envelope.dump());
  producer.flush();
}

void emitResolved(const std::string& tenant, const std::string& source_id, const std::string& outcome, const std::string& reviewer_ref) {
  publishAfterCommit(tenant, source_id, json{{"event_type", kEventResolved}, {"outcome", outcome}, {"reviewer_ref", reviewer_ref}});
}

void emitEnqueued(const std::string& tenant, const std::string& source_id, const std::string& priority) {
  publishAfterCommit(tenant, source_id, json{{"event_type", kEventEnqueued}, {"priority", priority}});
}

void emitAssigned(const std::string& tenant, const std::string& source_id, const std::string& priority, const std::string& reviewer_ref) {
  publishAfterCommit(tenant, source_id, json{{"event_type", kEventAssigned}, {"priority", priority}, {"reviewer_ref", reviewer_ref}});
}

void emitBreached(const std::string& tenant, const std::string& source_id, const std::string& priority, const std::string& sla_state) {
  publishAfterCommit(tenant, source_id, json{{"event_type", kEventBreached}, {"priority", priority}, {"sla_state", sla_state}});
}

int main() {
  auto conf = rd_kafka_conf_new();
  rd_kafka_conf_set(conf, "bootstrap.servers", "kafka:9092", nullptr, 0);
  rd_kafka_conf_set(conf, "acks", "all", nullptr, 0);
  rd_kafka_conf_set(conf, "enable.idempotence", "true", nullptr, 0);
  producer.init(conf);

  httplib::Server svr;
  svr.Post("/v1/review/items/([^/]+)/resolve", [](const httplib::Request& req, httplib::Response& res) {
    auto body = json::parse(req.body);
    auto tenant = req.get_header_value("X-Tenant-Id");
    json record = {
        {"tenant", tenant},
        {"source_id", body["source_id"]},
        {"priority", body["priority"]},
        {"sla_state", body["sla_state"]},
        {"outcome", body["outcome"]},
        {"reviewer_ref", body["reviewer_ref"]},
    };
    store.commit(tenant, record);
    emitResolved(tenant, body["source_id"].get<std::string>(), body["outcome"].get<std::string>(), body["reviewer_ref"].get<std::string>());
    res.status = 200;
    res.set_content(R"({"outcome":"resolved"})", "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The message key is the ordering key. Key by the *source id*, so all four lifecycle events for one source land in one partition and a consumer cannot see a resolve before the assign.',
    'A retained topic is not a place for identity or user text. Carry `reviewer_ref` (an opaque id) for audit and keep the reviewer name, email and payload text out of the event entirely.',
    'Commit first, publish second. Call `publish_after_commit` only after the item record commits, so a crash between the two cannot leave an event describing a resolution that never happened — and set `acks=all` with idempotence so the produce itself survives a broker failover.',
  ],
  debrief: `The interviewer is testing whether you can review a generated event path. The draft reads fine because one reviewer resolves one item at a time in a single-partition demo. Three defects are being checked. First, the key: keying by reviewer sends one source's events across partitions, so ordering — enqueue, assign, resolve, breach — is no longer guaranteed, and a consumer applying events in order can mark an item resolved and then assigned; key by source id instead. Second, the payload: a retained, replicated topic must not carry reviewer names or payload text, so the event carries an opaque \`reviewer_ref\` and no content. Third, the ordering against the item store: publishing before the commit lets a crash create an event for a resolution that never happened; publish after commit. The subtle point candidates miss is that \`acks=all\` and idempotence are part of correctness here — a failover that drops a resolve event leaves the audit projection disagreeing with the item store forever. Real platforms add a transactional outbox when the store and the broker cannot be committed together, per-tenant topics for isolation, and a schema registry so event fields stay compatible.`,
};
