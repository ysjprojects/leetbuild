import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Findings events keyed by target with evidence references',
  concept: 'kafka',
  file: 'events',
  focus: ['runner', 'kafka', 'evidence', 'reviewer'],
  task: `## Task

The starter is a plausible model-generated draft: a probe finds something, an event goes to Kafka,
and a reviewer can see it. It scatters one target's findings across partitions, it copies the
attack into a retained topic, and it publishes findings whose evidence cannot be retrieved. Find the
flaws, fix them, and prove the fix.

Implement \`record_finding\`, called once per finding with
\`{"target_id": "checkout-shadow", "probe_id": "probe-18", "severity": "high", "evidence": "…"}\`:

- Findings are published to **\`redteam.finding\` keyed by \`target_id\`**, so one target's finding
  stream stays in order. The draft keys by severity, which spreads a single target's findings across
  partitions and destroys the order a reviewer reads them in.
- The event carries \`probe_id\`, \`severity\` and an **\`evidence_ref\`** — a reference to the sealed
  evidence bundle, never the raw adversarial payload. The topic is retained and replicated; whatever
  you put in it outlives the run.
- **Seal, then publish**: \`seal_evidence\` writes the bundle and returns its immutable reference, and
  only then is the finding produced. The draft publishes first, so every finding it emits can point
  at evidence that does not exist yet.
- The producer is **idempotent with \`acks=all\`** (\`enable.idempotence\`, \`acks=all\`), so a producer
  retry cannot duplicate a finding into a stream a reviewer is reading.

**Failure mode the checks target.** The loud one is the key: severity as a partition key looks
harmless until a target's findings arrive reordered, and a reviewer reconstructs the attack in the
wrong sequence. The quiet ones are the payload and the ordering: the raw adversarial probe in the
topic is an unredacted attack copied into every replica and every backup, and publishing before
sealing means the reference in the event can 404 the moment someone clicks it.`,
  sequence: {
    participants: ['Probe runner', 'evidence store', 'Kafka redteam.finding', 'Review queue'],
    messages: [
      {from: 'Probe runner', to: 'evidence store', label: 'seal bundle(probe-18)', kind: 'sync'},
      {from: 'evidence store', to: 'Probe runner', label: 'evidence://checkout-shadow/probe-18', kind: 'reply'},
      {from: 'Probe runner', to: 'Kafka redteam.finding', label: 'produce key=target_id · evidence_ref', kind: 'async'},
      {from: 'Kafka redteam.finding', to: 'Probe runner', label: 'ack (idempotent, acks=all)', kind: 'reply'},
      {from: 'Kafka redteam.finding', to: 'Review queue', label: 'consume one target, in order', kind: 'async'},
      {from: 'Review queue', to: 'evidence store', label: 'GET evidence_ref', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'target-key',
      title: 'Keys findings by target',
      detail:
        'The produce call uses the target id as the message key, so a target’s findings share a partition and stay ordered. The draft keys by severity, which scatters one target’s stream.',
      match: {
        python: {all: [/\.produce\(/, /key=target_id/]},
        typescript: {all: [/producer\.send\(/, /key:\s*targetId/]},
        go: {all: [/kafka\.Message\{/, /Key:\s*\[\]byte\(targetID\)/]},
        scala: {all: [/new ProducerRecord\(/, /targetId/]},
        cpp: {all: [/->produce\(/, /targetId\.data\(\)/]},
      },
    },
    {
      id: 'evidence-ref',
      title: 'Carries an evidence reference, not the payload',
      detail:
        'The event names the stored bundle with `evidence_ref` and never embeds the raw adversarial payload. The draft writes a `"payload"` field into a topic that retains and replicates.',
      match: {
        python: {all: [/evidence_ref/], none: [/["']payload["']/]},
        typescript: {all: [/evidenceRef/], none: [/["']payload["']/]},
        go: {all: [/EvidenceRef/], none: [/"payload"/]},
        scala: {all: [/evidenceRef/], none: [/"payload"/]},
        cpp: {all: [/evidence_ref/], none: [/"payload"/]},
      },
    },
    {
      id: 'seal-before-publish',
      title: 'Seals the evidence before it publishes',
      detail:
        '`seal_evidence`/`sealEvidence` returns the reference before the finding is produced, so every published finding has retrievable evidence. The draft produces first and seals afterwards.',
      match: {
        python: {order: [/seal_evidence\(/, /publish_finding\(/]},
        typescript: {order: [/sealEvidence\(/, /publishFinding\(/]},
        go: {order: [/sealEvidence\(/, /publishFinding\(/]},
        scala: {order: [/sealEvidence\(/, /publishFinding\(/]},
        cpp: {order: [/sealEvidence\(/, /publishFinding\(/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'The producer sets `enable.idempotence` and `acks=all`, so a broker retry cannot duplicate a finding. The draft takes the client defaults, which is a duplicate per retry at the reviewer.',
      match: {
        python: {all: [/enable\.idempotence/, /"acks":\s*"all"/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/"enable\.idempotence",\s*"true"/, /"acks",\s*"all"/]},
        cpp: {all: [/enable\.idempotence/, /"acks",\s*"all"/]},
      },
    },
    {
      id: 'finding-fields',
      title: 'Names the probe and the severity',
      detail:
        'The event carries `probe_id` and `severity` next to the evidence reference, which is what makes a finding actionable. An event with only an id and a link leaves the reviewer guessing what fired.',
      match: {
        python: {all: [/probe_id/, /severity/]},
        typescript: {all: [/probeId/, /severity/]},
        go: {all: [/ProbeID/, /Severity/]},
        scala: {all: [/probeId/, /severity/]},
        cpp: {all: [/probe_id/, /severity/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

TOPIC = "redteam.finding"
producer = Producer({"bootstrap.servers": "kafka:9092"})


class Finding(BaseModel):
    target_id: str
    probe_id: str
    severity: str
    evidence: str


def publish_finding(event: dict, key: str) -> None:
    producer.produce(TOPIC, key=key, value=json.dumps(event))
    producer.flush(2)


@app.post("/v1/redteam/findings")
def record_finding(body: Finding, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft keys the event by severity so one target's findings scatter across
    # partitions, writes the raw adversarial payload into a retained topic, produces before the
    # evidence bundle is sealed, and takes the default producer settings. Key by target_id, publish
    # an evidence reference, seal first, and configure idempotence with acks=all.
    event = {"probe_id": body.probe_id, "severity": body.severity, "payload": body.evidence}
    publish_finding(event, body.severity)
    bundle = seal_evidence(body.target_id, body.probe_id, body.evidence)
    return {"finding_id": bundle, "key": body.severity}
`,
      solution: `import json

from confluent_kafka import Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

TOPIC = "redteam.finding"
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class Finding(BaseModel):
    target_id: str
    probe_id: str
    severity: str
    evidence: str


def seal_evidence(target_id: str, probe_id: str, evidence: str) -> str:
    """Write the bundle to the evidence store and return its immutable reference."""
    raise NotImplementedError


def publish_finding(target_id: str, event: dict) -> None:
    """One event per finding, keyed by target so a target's stream stays ordered."""
    producer.produce(TOPIC, key=target_id, value=json.dumps(event))
    producer.flush(2)


@app.post("/v1/redteam/findings")
def record_finding(body: Finding, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    evidence_ref = seal_evidence(body.target_id, body.probe_id, body.evidence)
    event = {
        "finding_id": evidence_ref,
        "target_id": body.target_id,
        "probe_id": body.probe_id,
        "severity": body.severity,
        "evidence_ref": evidence_ref,
    }
    publish_finding(body.target_id, event)
    return {"finding_id": evidence_ref, "key": body.target_id}
`,
    },
    typescript: {
      starter: `/** redteam.finding: a model-generated draft that keys by severity and ships the payload. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();

const TOPIC = 'redteam.finding';
const producer = new Kafka({clientId: 'red-team-runner', brokers: ['kafka:9092']}).producer();

interface FindingBody {
  targetId: string;
  probeId: string;
  severity: string;
  evidence: string;
}

async function publishFinding(finding: Record<string, string>, key: string): Promise<void> {
  await producer.send({topic: TOPIC, messages: [{key, value: JSON.stringify(finding)}]});
}

app.post('/v1/redteam/findings', async (request, reply) => {
  // TODO: this draft keys the event by severity so one target's findings scatter across partitions,
  // writes the raw adversarial payload into a retained topic, produces before the evidence bundle
  // is sealed, and takes the default producer settings. Key by targetId, publish an evidence
  // reference, seal first, and configure idempotence with acks=all.
  const body = request.body as FindingBody;
  await publishFinding({probe_id: body.probeId, severity: body.severity, payload: body.evidence}, body.severity);
  const bundleId = await sealEvidence(body.targetId, body.probeId, body.evidence);
  return reply.code(202).send({finding_id: bundleId, key: body.severity});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** redteam.finding: one target-keyed event per finding, with a sealed evidence reference. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();

const TOPIC = 'redteam.finding';
const producer = new Kafka({clientId: 'red-team-runner', brokers: ['kafka:9092']}).producer({
  idempotent: true,
  acks: -1,
});

interface FindingBody {
  targetId: string;
  probeId: string;
  severity: string;
  evidence: string;
}

interface FindingEvent {
  finding_id: string;
  target_id: string;
  probe_id: string;
  severity: string;
  evidence_ref: string;
}

async function sealEvidence(targetId: string, probeId: string, evidence: string): Promise<string> {
  return \`evidence://\${targetId}/\${probeId}\`;
}

async function publishFinding(targetId: string, event: FindingEvent): Promise<void> {
  await producer.send({topic: TOPIC, messages: [{key: targetId, value: JSON.stringify(event)}]});
}

app.post('/v1/redteam/findings', async (request, reply) => {
  const body = request.body as FindingBody;
  const evidenceRef = await sealEvidence(body.targetId, body.probeId, body.evidence);
  const event: FindingEvent = {
    finding_id: evidenceRef,
    target_id: body.targetId,
    probe_id: body.probeId,
    severity: body.severity,
    evidence_ref: evidenceRef,
  };
  await publishFinding(body.targetId, event);
  return reply.code(202).send({finding_id: evidenceRef, key: body.targetId});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/segmentio/kafka-go"
)

var findingWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "redteam.finding"}

type Finding struct {
	TargetID string \`json:"target_id"\`
	ProbeID  string \`json:"probe_id"\`
	Severity string \`json:"severity"\`
	Evidence string \`json:"evidence"\`
}

func publishFinding(ctx context.Context, key string, event map[string]any) error {
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return findingWriter.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: value})
}

func recordFinding(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft keys the event by severity so one target's findings scatter across
	// partitions, writes the raw adversarial payload into a retained topic, produces before the
	// evidence bundle is sealed, and takes the default writer settings. Key by target id, publish an
	// evidence reference, seal first, and configure RequireAll with a hash balancer.
	var body Finding
	_ = json.NewDecoder(r.Body).Decode(&body)
	event := map[string]any{"probe_id": body.ProbeID, "severity": body.Severity, "payload": body.Evidence}
	_ = publishFinding(r.Context(), body.Severity, event)
	evidenceRef, _ := sealEvidence(r.Context(), body.TargetID, body.ProbeID, body.Evidence)
	writeJSON(rw, http.StatusAccepted, map[string]any{"finding_id": evidenceRef, "key": body.Severity})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/segmentio/kafka-go"
)

var findingWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "redteam.finding",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type Finding struct {
	TargetID string \`json:"target_id"\`
	ProbeID  string \`json:"probe_id"\`
	Severity string \`json:"severity"\`
	Evidence string \`json:"evidence"\`
}

type FindingEvent struct {
	FindingID   string \`json:"finding_id"\`
	TargetID    string \`json:"target_id"\`
	ProbeID     string \`json:"probe_id"\`
	Severity    string \`json:"severity"\`
	EvidenceRef string \`json:"evidence_ref"\`
}

func sealEvidence(ctx context.Context, targetID, probeID, evidence string) (string, error) {
	return "evidence://" + targetID + "/" + probeID, nil
}

func publishFinding(ctx context.Context, targetID string, event FindingEvent) error {
	value, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return findingWriter.WriteMessages(ctx, kafka.Message{Key: []byte(targetID), Value: value})
}

func recordFinding(rw http.ResponseWriter, r *http.Request) {
	var body Finding
	_ = json.NewDecoder(r.Body).Decode(&body)
	evidenceRef, err := sealEvidence(r.Context(), body.TargetID, body.ProbeID, body.Evidence)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	event := FindingEvent{
		FindingID:   evidenceRef,
		TargetID:    body.TargetID,
		ProbeID:     body.ProbeID,
		Severity:    body.Severity,
		EvidenceRef: evidenceRef,
	}
	if err := publishFinding(r.Context(), body.TargetID, event); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	writeJSON(rw, http.StatusAccepted, event)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object Events {
  val Topic = "redteam.finding"
  val producer = new KafkaProducer[String, String](new Properties())

  final case class Finding(target_id: String, probe_id: String, severity: String, evidence: String)

  def publishFinding(key: String, event: JsObject): Unit =
    producer.send(new ProducerRecord(Topic, key, event.compactPrint))

  // TODO: this draft keys the event by severity so one target's findings scatter across partitions,
  // writes the raw adversarial payload into a retained topic, produces before the evidence bundle is
  // sealed, and takes the default producer settings. Key by target_id, publish an evidence
  // reference, seal first, and configure idempotence with acks=all.
  def recordFinding(body: Finding): String = {
    val event = JsObject(
      "probe_id" -> JsString(body.probe_id),
      "severity" -> JsString(body.severity),
      "payload" -> JsString(body.evidence)
    )
    publishFinding(body.severity, event)
    val evidenceRef = sealEvidence(body.target_id, body.probe_id, body.evidence)
    s"""{"finding_id":"$evidenceRef","key":"\${body.severity}"}"""
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json.DefaultJsonProtocol._
import spray.json.{RootJsonFormat, _}

object Events {
  val Topic = "redteam.finding"
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  final case class Finding(target_id: String, probe_id: String, severity: String, evidence: String)
  final case class FindingEvent(finding_id: String, target_id: String, probe_id: String, severity: String, evidence_ref: String)
  implicit val eventFormat: RootJsonFormat[FindingEvent] = jsonFormat5(FindingEvent)

  def sealEvidence(targetId: String, probeId: String, evidence: String): String = s"evidence://$targetId/$probeId"

  def publishFinding(targetId: String, event: FindingEvent): Unit =
    producer.send(new ProducerRecord(Topic, targetId, event.toJson.compactPrint))

  def recordFinding(body: Finding): FindingEvent = {
    val evidenceRef = sealEvidence(body.target_id, body.probe_id, body.evidence)
    val event = FindingEvent(evidenceRef, body.target_id, body.probe_id, body.severity, evidenceRef)
    publishFinding(body.target_id, event)
    event
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kFindingTopic = "redteam.finding";

std::unique_ptr<RdKafka::Producer> producer;

struct Finding {
  std::string target_id;
  std::string probe_id;
  std::string severity;
  std::string evidence;
};

void publishFinding(const std::string& key, const json& event) {
  const auto value = event.dump();
  producer->produce(
      kFindingTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(value.data()),
      value.size(),
      key.data(),
      key.size(),
      0,
      nullptr);
}

// TODO: this draft keys the event by severity so one target's findings scatter across partitions,
// writes the raw adversarial payload into a retained topic, produces before the evidence bundle is
// sealed, and takes the default producer settings. Key by target_id, publish an evidence reference,
// seal first, and configure idempotence with acks=all.
json recordFinding(const Finding& body) {
  const json event = {
      {"probe_id", body.probe_id}, {"severity", body.severity}, {"payload", body.evidence}};
  publishFinding(body.severity, event);
  const auto evidenceRef = sealEvidence(body.target_id, body.probe_id, body.evidence);
  return json{{"finding_id", evidenceRef}, {"key", body.severity}};
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kFindingTopic = "redteam.finding";

struct Finding {
  std::string target_id;
  std::string probe_id;
  std::string severity;
  std::string evidence;
};

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

std::string sealEvidence(const std::string& targetId, const std::string& probeId, const std::string& evidence) {
  return "evidence://" + targetId + "/" + probeId;
}

void publishFinding(const std::string& targetId, const json& event) {
  const auto value = event.dump();
  producer->produce(
      kFindingTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(value.data()),
      value.size(),
      targetId.data(),
      targetId.size(),
      0,
      nullptr);
  producer->flush(2000);
}

json recordFinding(const Finding& body) {
  const auto evidenceRef = sealEvidence(body.target_id, body.probe_id, body.evidence);
  const json event = {
      {"finding_id", evidenceRef},
      {"target_id", body.target_id},
      {"probe_id", body.probe_id},
      {"severity", body.severity},
      {"evidence_ref", evidenceRef}};
  publishFinding(body.target_id, event);
  return event;
}
`,
    },
  },
  hints: [
    'Ask what a consumer needs in order: the story of one attack against one target. The message key decides that, and only `target_id` keeps one target’s findings in a single partition and therefore in probe order.',
    'The topic is infrastructure with its own retention and replication. `evidence_ref` is the only thing that belongs in the event; the bundle itself stays in the store with the retention policy and access control that attackers’ payloads deserve.',
    'Seal then publish, and make the producer idempotent with `acks=all`. Both are about the same promise to the reviewer: every finding they read can be opened, and no finding appears twice because a broker retried a produce.',
  ],
  debrief: `The interviewer is testing whether you can review an event that carries adversarial content. Three contracts are checked: ordering, because the message key is how a stream stays readable per aggregate; content, because a retained topic is not a place for the attack payload when a reference will do; and the publish/seal order, because a finding that points at missing evidence is worse than no finding at all. The idempotent producer with acks=all is the fourth, quieter contract: a retry that duplicates a finding doubles a reviewer’s queue and makes a severity count wrong. Real platforms add schema-registry validation so no future producer can smuggle a payload in, per-tenant topic quotas, and an evidence store with a short-lived signed URL instead of a permanent path.`,
};
