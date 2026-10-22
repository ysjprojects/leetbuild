import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Tool lifecycle events keyed by tool name',
  concept: 'kafka',
  file: 'events',
  focus: ['registry', 'kafka', 'consumer', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes a
\`tool.lifecycle\` event on every registration and promotion, and the demo timeline shows the catalog
moving. Four production contracts are broken. Review it like the platform owner, fix it, and prove
the fix with the checks below.

\`publish_lifecycle(tool, version, side_effect, manifest)\` is the helper every
register → validate → promote → revoke transition calls to announce itself on the **\`tool.lifecycle\`**
topic.

- The record **key is the tool name**. The key is the partition key: keyed by tool, one tool’s
  registered → validated → promoted → revoked history lands on one partition in order, which is the
  only way a consumer can replay "promoted 4, revoked → 3" correctly. The draft keys by the owner
  team, so two teams’ tools interleave and a tool’s own events lose their order.
- The payload carries the **version**, the **side-effect class** and the **validator outcome** —
  \`validated\` or \`rejected\`, taken from the sandbox verdict, never a hard-coded state. No sandbox
  logs, no credentials, no raw schema dumps: the topic is retained for days and replicated, so
  anything written there outlives the promotion that wrote it.
- **Validate before you publish.** The produce runs only after \`sandbox.validate(...)\` has returned
  the verdict — and, for a validated version, after the promotion is recorded — so an event can
  never announce a version, or a promotion, that the validator has not passed.
- The producer is **idempotent with \`acks=all\`** (the stack’s equivalent: \`enable.idempotence\` +
  \`acks\`, KafkaJS’s \`idempotent: true\`, or required acks \`all\` with a hash balancer), so a retry
  of a produce cannot duplicate a record.
- A version the verdict **rejects** still needs an auditable event: write it to the **outbox** row
  a relay republishes, instead of announcing it as promoted. A produce the broker rejects lands in
  the outbox too — a lifecycle event is never dropped.

**Failure mode the checks target.** The draft reads as complete because the happy path publishes
something for every transition, but the key is the wrong field, the payload ships the sandbox log
with a best-effort regex redaction that misses any credential in an unexpected shape, the event is
produced before the verdict exists, and there is no outbox at all — so a rejected version and a
broker outage both end as silence in the audit trail.`,
  sequence: {
    participants: ['Tool Registry', 'Sandbox', 'tool.lifecycle', 'Catalog DB', 'Consumer'],
    messages: [
      {
        from: 'Tool Registry',
        to: 'Sandbox',
        label: 'validate(manifest) · the verdict comes before anything is published',
        kind: 'sync',
      },
      {from: 'Sandbox', to: 'Tool Registry', label: 'validated / rejected · findings', kind: 'reply'},
      {
        from: 'Tool Registry',
        to: 'Catalog DB',
        label: 'promote(tool, version) on validated · insertOutbox on rejected',
        kind: 'sync',
      },
      {
        from: 'Tool Registry',
        to: 'tool.lifecycle',
        label: 'produce · key = tool name · acks = all · idempotent',
        kind: 'sync',
      },
      {from: 'tool.lifecycle', to: 'Tool Registry', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'Tool Registry',
        to: 'Catalog DB',
        label: 'insertOutbox(tool, event) when the broker rejected the produce',
        kind: 'async',
      },
      {
        from: 'tool.lifecycle',
        to: 'Consumer',
        label: 'consume · one partition per tool keeps the history ordered',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The message key is the partition key: `key=tool`, `key: tool`, `[]byte(tool)`, `ProducerRecord(Topic, tool, …)`, `tool.data()` — the tool name, never the owner team. Keyed by the owner team, two teams share a partition and one tool’s registered → validated → promoted history stops being ordered.',
    'The verdict is the event: call `sandbox.validate(...)` before the produce and copy `verdict.outcome` into the payload. A hard-coded `"promoted"` announces a version the sandbox has not passed, and `registry.promote(...)` must only run on a validated verdict.',
    'The outbox is the durability half: write the event to the outbox when the verdict rejects the version and when the produce returns an error. The payload carries no sandbox logs and no credentials — there is nothing worth redacting, so delete the log field and its helper instead of sanitizing it.',
  ],
  checks: [
    {
      id: 'key',
      title: 'Record keyed by the tool name',
      detail:
        'The Kafka record key is the tool name (`key=tool`, `key: tool`, `[]byte(tool)`, `ProducerRecord(Topic, tool, …)`, `tool.data()`), not the owner team — partition by tool keeps one tool’s lifecycle history ordered. The draft keys by the owner team, so two teams’ tools share a partition.',
      match: {
        python: {all: [/key=tool\b/, /tool\.lifecycle/]},
        typescript: {all: [/key:\s*tool\b/, /tool\.lifecycle/]},
        go: {all: [/Key:\s*\[\]byte\(tool\)/, /tool\.lifecycle/]},
        scala: {all: [/ProducerRecord[^(]*\(\s*Topic\s*,\s*tool\b/, /tool\.lifecycle/]},
        cpp: {all: [/tool\.lifecycle/, /producer->produce\(/, /tool\.data\(\),\s*tool\.size\(\)/]},
      },
    },
    {
      id: 'payload',
      title: 'Version, side-effect class and the validator outcome',
      detail:
        'The event carries `version`, `side_effect` and `outcome` taken from the validator verdict — not a hard-coded state. The draft writes `"promoted"` into the payload before any validator has run.',
      match: {
        python: {
          all: [
            /["']version["']\s*:\s*version/,
            /["']side_effect["']\s*:\s*side_effect/,
            /["']outcome["']\s*:\s*verdict\.outcome/,
          ],
        },
        typescript: {all: [/\bversion\b/, /side_effect:\s*sideEffect/, /outcome:\s*verdict\.outcome/]},
        go: {all: [/Version:\s*version/, /SideEffect:\s*sideEffect/, /Outcome:\s*verdict\.Outcome/]},
        scala: {
          all: [
            /"version"\s*->\s*JsString\(version\)/,
            /"side_effect"\s*->\s*JsString\(sideEffect\)/,
            /"outcome"\s*->\s*JsString\(verdict\.outcome\)/,
          ],
        },
        cpp: {
          all: [/"version",\s*version/, /"side_effect",\s*sideEffect/, /"outcome",\s*verdict\.outcome/],
        },
      },
    },
    {
      id: 'after-validation',
      title: 'Produce runs after the validation verdict',
      detail:
        'The produce is issued after `sandbox.validate(...)` has returned, and after the promotion is recorded for a validated version, so an event can never precede or contradict the verdict. The draft publishes first and validates afterwards, which lets the topic announce a promotion that then fails validation.',
      match: {
        python: {order: [/sandbox\.validate\(/, /producer\.produce\(/]},
        typescript: {order: [/sandbox\.validate\(/, /producer\.send\(/]},
        go: {order: [/sandbox\.Validate\(/, /producer\.WriteMessages\(/]},
        scala: {order: [/sandbox\.validate\(/, /producer\.send\(/]},
        cpp: {order: [/sandbox\.validate\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'no-secrets',
      title: 'No sandbox logs or credentials in the event',
      detail:
        'Nothing writes sandbox log lines or credentials into the payload: the topic is retained and replicated, so the log outlives the request that produced it. The draft ships the sandbox log with a best-effort regex redaction that misses any credential the sandbox printed in another shape.',
      match: {
        python: {none: [/sandbox_log/, /redact/i]},
        typescript: {none: [/sandbox_log/, /redact/i]},
        go: {none: [/sandbox_log/, /redact/i]},
        scala: {none: [/sandbox_log/, /redact/i]},
        cpp: {none: [/sandbox_log/, /redact/i]},
      },
    },
    {
      id: 'outbox',
      title: 'Rejections and failed produces land in the outbox',
      detail:
        'A rejected verdict and a produce the broker refuses both write an outbox row (`insert_outbox`/`insertOutbox`) that a relay republishes, so the rejection is auditable even when the broker is down. The draft drops both.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+KafkaException|verdict\.outcome\s*!=\s*"validated"/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*[{(]|!==\s*'validated'/]},
        go: {all: [/InsertOutbox\(/, /if err != nil|verdict\.Outcome\s*!=\s*"validated"/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{|verdict\.outcome\s*!=\s*"validated"/]},
        cpp: {all: [/insertOutbox\(/, /err\s*!=\s*RdKafka::ERR_NO_ERROR|verdict\.outcome\s*!=\s*"validated"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import re

from confluent_kafka import Producer

TOPIC = "tool.lifecycle"
VALIDATION_DEADLINE_S = 10.0

producer = Producer({"bootstrap.servers": "kafka:9092"})

API_KEY_RE = re.compile(r"api_key=sk-[A-Za-z0-9]+")


def redact_credentials(log: str) -> str:
    """Best-effort: strip the API keys the sandbox printed in the one format we have seen."""
    return API_KEY_RE.sub("api_key=<redacted>", log)


class Verdict:
    """The sandbox verdict the lifecycle event reports: outcome plus findings."""

    def __init__(self, outcome: str, findings: list[str]) -> None:
        self.outcome = outcome
        self.findings = findings


class SandboxClient:
    """Exercises the candidate over gRPC in isolation; a timeout is not a pass."""

    def validate(self, manifest: dict, deadline_s: float) -> Verdict:
        raise NotImplementedError


class ToolRegistry:
    """Catalog rows the lifecycle events describe."""

    def promote(self, tool: str, version: str) -> None:
        """Flip the version to promotable."""


sandbox = SandboxClient()
registry = ToolRegistry()


def publish_lifecycle(tool: str, version: str, side_effect: str, manifest: dict) -> str:
    # TODO: key by the tool name instead of the owner team, run the sandbox validation before
    # publishing, keep the sandbox log out of the event, and write an outbox row when the verdict
    # rejects the version or the broker rejects the produce.
    event = {
        "tool": tool,
        "version": version,
        "side_effect": side_effect,
        "outcome": "promoted",
        "sandbox_log": redact_credentials(manifest["sandbox_log"]),
    }
    producer.produce(TOPIC, key=manifest["owner_team"], value=json.dumps(event))
    producer.flush(2.0)
    verdict = sandbox.validate(manifest, deadline_s=VALIDATION_DEADLINE_S)
    if verdict.outcome == "validated":
        registry.promote(tool, version)
    return verdict.outcome
`,
      solution: `import json

from confluent_kafka import KafkaException, Producer

TOPIC = "tool.lifecycle"
VALIDATION_DEADLINE_S = 10.0

# Idempotence with acks=all: a retried produce with the same key cannot duplicate a record.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class Verdict:
    """The sandbox verdict the lifecycle event reports: outcome plus findings."""

    def __init__(self, outcome: str, findings: list[str]) -> None:
        self.outcome = outcome
        self.findings = findings


class SandboxClient:
    """Exercises the candidate over gRPC in isolation; a timeout is not a pass."""

    def validate(self, manifest: dict, deadline_s: float) -> Verdict:
        raise NotImplementedError


class ToolRegistry:
    """Catalog rows the lifecycle events describe."""

    def promote(self, tool: str, version: str) -> None:
        """Flip the version to promotable — only ever after a validated verdict."""
        raise NotImplementedError

    def insert_outbox(self, tool: str, event: dict) -> None:
        """Durable row a relay republishes when the broker did not accept the event."""
        raise NotImplementedError


sandbox = SandboxClient()
registry = ToolRegistry()


def publish_lifecycle(tool: str, version: str, side_effect: str, manifest: dict) -> str:
    # Validate first: an event must never announce a promotion the sandbox has not passed, and a
    # rejected version still needs an auditable row.
    verdict = sandbox.validate(manifest, deadline_s=VALIDATION_DEADLINE_S)
    event = {
        "tool": tool,
        "version": version,
        "side_effect": side_effect,
        "outcome": verdict.outcome,
        "findings": verdict.findings,
    }
    if verdict.outcome != "validated":
        registry.insert_outbox(tool, event)
        return verdict.outcome
    registry.promote(tool, version)
    try:
        producer.produce(TOPIC, key=tool, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        registry.insert_outbox(tool, event)
    return verdict.outcome
`,
    },
    typescript: {
      starter: `/** tool.lifecycle: a model-generated draft that keys by owner team and publishes before validating. */
import {Kafka} from 'kafkajs';

import {registry, sandbox} from './clients';

const TOPIC = 'tool.lifecycle';
const VALIDATION_DEADLINE_MS = 10_000;

const producer = new Kafka({clientId: 'tool-registry', brokers: ['kafka:9092']}).producer();

interface Manifest {
  owner_team: string;
  sandbox_log: string;
  json_schema: unknown;
}

const API_KEY_RE = /api_key=sk-[A-Za-z0-9]+/g;

function redactCredentials(log: string): string {
  return log.replace(API_KEY_RE, 'api_key=<redacted>');
}

export async function publishLifecycle(
  tool: string,
  version: string,
  sideEffect: string,
  manifest: Manifest,
): Promise<string> {
  // TODO: key by the tool name instead of the owner team, run the sandbox validation before
  // publishing, keep the sandbox log out of the event, and write an outbox row when the verdict
  // rejects the version or the broker rejects the produce.
  const event = {
    tool,
    version,
    side_effect: sideEffect,
    outcome: 'promoted',
    sandbox_log: redactCredentials(manifest.sandbox_log),
  };
  await producer.send({
    topic: TOPIC,
    messages: [{key: manifest.owner_team, value: JSON.stringify(event)}],
  });
  const verdict = await sandbox.validate(manifest, VALIDATION_DEADLINE_MS);
  if (verdict.outcome === 'validated') {
    await registry.promote(tool, version);
  }
  return verdict.outcome;
}
`,
      solution: `/** tool.lifecycle: one idempotent, tool-keyed event per transition, produced after the verdict. */
import {Kafka} from 'kafkajs';

import {registry, sandbox} from './clients';

const TOPIC = 'tool.lifecycle';
const VALIDATION_DEADLINE_MS = 10_000;

// Idempotence keeps a retried produce from duplicating a record; acks=-1 waits for all replicas.
const producer = new Kafka({clientId: 'tool-registry', brokers: ['kafka:9092']}).producer({
  idempotent: true,
  maxInFlightRequests: 1,
});

export async function publishLifecycle(
  tool: string,
  version: string,
  sideEffect: string,
  manifest: unknown,
): Promise<string> {
  // Validate first: an event must never announce a promotion the sandbox has not passed, and a
  // rejected version still needs an auditable row.
  const verdict = await sandbox.validate(manifest, VALIDATION_DEADLINE_MS);
  const event = {
    tool,
    version,
    side_effect: sideEffect,
    outcome: verdict.outcome,
    findings: verdict.findings,
  };
  if (verdict.outcome !== 'validated') {
    await registry.insertOutbox(tool, event);
    return verdict.outcome;
  }
  await registry.promote(tool, version);
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: tool, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await registry.insertOutbox(tool, event);
  }
  return verdict.outcome;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"regexp"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	lifecycleTopic     = "tool.lifecycle"
	validationDeadline = 10 * time.Second
)

var producer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: lifecycleTopic}

var apiKeyRe = regexp.MustCompile(\`api_key=sk-[A-Za-z0-9]+\`)

func redactCredentials(log string) string {
	return apiKeyRe.ReplaceAllString(log, "api_key=<redacted>")
}

type Manifest struct {
	OwnerTeam  string \`json:"owner_team"\`
	SandboxLog string \`json:"sandbox_log"\`
}

type Verdict struct {
	Outcome  string
	Findings []string
}

type SandboxClient struct{}

func (c *SandboxClient) Validate(ctx context.Context, manifest Manifest, deadline time.Duration) (Verdict, error) {
	return Verdict{}, nil
}

type ToolRegistry struct{}

func (r *ToolRegistry) Promote(ctx context.Context, tool, version string) error { return nil }

var (
	sandbox  = &SandboxClient{}
	registry = &ToolRegistry{}
)

// PublishLifecycle announces one tool.lifecycle event for the candidate version.
func PublishLifecycle(ctx context.Context, tool, version, sideEffect string, manifest Manifest) (string, error) {
	// TODO: key by the tool name instead of the owner team, run the sandbox validation before
	// publishing, keep the sandbox log out of the event, and write an outbox row when the verdict
	// rejects the version or the broker rejects the produce.
	event := map[string]any{
		"tool":        tool,
		"version":     version,
		"side_effect": sideEffect,
		"outcome":     "promoted",
		"sandbox_log": redactCredentials(manifest.SandboxLog),
	}
	payload, _ := json.Marshal(event)
	_ = producer.WriteMessages(ctx, kafka.Message{Key: []byte(manifest.OwnerTeam), Value: payload})
	verdict, _ := sandbox.Validate(ctx, manifest, validationDeadline)
	if verdict.Outcome == "validated" {
		_ = registry.Promote(ctx, tool, version)
	}
	return verdict.Outcome, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	lifecycleTopic     = "tool.lifecycle"
	validationDeadline = 10 * time.Second
)

// RequireAll plus a hash balancer is the kafka-go idiom of an idempotent producer: the broker
// acknowledges once every replica has the record, and the same key always lands on the same
// partition, so a retry cannot duplicate across partitions.
var producer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        lifecycleTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

type Verdict struct {
	Outcome  string
	Findings []string
}

type LifecycleEvent struct {
	Tool       string   \`json:"tool"\`
	Version    string   \`json:"version"\`
	SideEffect string   \`json:"side_effect"\`
	Outcome    string   \`json:"outcome"\`
	Findings   []string \`json:"findings"\`
}

type SandboxClient struct{}

func (c *SandboxClient) Validate(ctx context.Context, manifest json.RawMessage, deadline time.Duration) (Verdict, error) {
	return Verdict{}, errors.New("not implemented")
}

type ToolRegistry struct{}

func (r *ToolRegistry) Promote(ctx context.Context, tool, version string) error {
	return errors.New("not implemented")
}

func (r *ToolRegistry) InsertOutbox(ctx context.Context, tool string, event LifecycleEvent) error {
	return errors.New("not implemented")
}

var (
	sandbox  = &SandboxClient{}
	registry = &ToolRegistry{}
)

// PublishLifecycle validates the candidate first, then publishes one tool.lifecycle event keyed by
// the tool name: the verdict is the outcome, and a version the sandbox rejected goes to the outbox
// instead of being announced as promoted.
func PublishLifecycle(ctx context.Context, tool, version, sideEffect string, manifest json.RawMessage) (string, error) {
	verdict, err := sandbox.Validate(ctx, manifest, validationDeadline)
	if err != nil {
		return "", err
	}
	event := LifecycleEvent{
		Tool:       tool,
		Version:    version,
		SideEffect: sideEffect,
		Outcome:    verdict.Outcome,
		Findings:   verdict.Findings,
	}
	if verdict.Outcome != "validated" {
		return verdict.Outcome, registry.InsertOutbox(ctx, tool, event)
	}
	if err := registry.Promote(ctx, tool, version); err != nil {
		return verdict.Outcome, err
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return verdict.Outcome, err
	}
	if err := producer.WriteMessages(ctx, kafka.Message{Key: []byte(tool), Value: payload}); err != nil {
		return verdict.Outcome, registry.InsertOutbox(ctx, tool, event)
	}
	return verdict.Outcome, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

case class Verdict(outcome: String, findings: List[String])

case class Manifest(ownerTeam: String, sandboxLog: String)

class SandboxClient {
  /** Exercises the candidate over gRPC in isolation; a timeout is not a pass. */
  def validate(manifest: Manifest, deadlineMs: Long): Verdict = throw new NotImplementedError()
}

class ToolRegistry {
  /** Flip the version to promotable. */
  def promote(tool: String, version: String): Unit = throw new NotImplementedError()
}

object ToolLifecyclePublisher {
  private val Topic = "tool.lifecycle"
  private val ValidationDeadlineMs = 10000L
  private val producer = new KafkaProducer[String, String](new Properties())
  private val sandbox = new SandboxClient()
  private val registry = new ToolRegistry()

  private val ApiKeyRe = "api_key=sk-[A-Za-z0-9]+".r

  private def redactCredentials(log: String): String = ApiKeyRe.replaceAllIn(log, "api_key=<redacted>")

  // TODO: key by the tool name instead of the owner team, run the sandbox validation before
  // publishing, keep the sandbox log out of the event, and write an outbox row when the verdict
  // rejects the version or the broker rejects the produce.
  def publishLifecycle(tool: String, version: String, sideEffect: String, manifest: Manifest): String = {
    val event = Map(
      "tool" -> tool,
      "version" -> version,
      "side_effect" -> sideEffect,
      "outcome" -> "promoted",
      "sandbox_log" -> redactCredentials(manifest.sandboxLog),
    )
    producer.send(new ProducerRecord(Topic, manifest.ownerTeam, event.toJson.compactPrint))
    val verdict = sandbox.validate(manifest, ValidationDeadlineMs)
    if (verdict.outcome == "validated") {
      registry.promote(tool, version)
    }
    verdict.outcome
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

case class Verdict(outcome: String, findings: List[String])

case class Manifest(ownerTeam: String, sandboxLog: String)

class SandboxClient {
  /** Exercises the candidate over gRPC in isolation; a timeout is not a pass. */
  def validate(manifest: Manifest, deadlineMs: Long): Verdict = throw new NotImplementedError()
}

class ToolRegistry {
  /** Flip the version to promotable — only ever after a validated verdict. */
  def promote(tool: String, version: String): Unit = throw new NotImplementedError()

  /** Durable row a relay republishes when the broker did not accept the event. */
  def insertOutbox(tool: String, payload: String): Unit = throw new NotImplementedError()
}

object ToolLifecyclePublisher {
  private val Topic = "tool.lifecycle"
  private val ValidationDeadlineMs = 10000L

  // enable.idempotence with acks=all: a retried produce with the same key cannot duplicate a record.
  private val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  private val sandbox = new SandboxClient()
  private val registry = new ToolRegistry()

  /** Validate the candidate first, then publish one tool.lifecycle event keyed by the tool name. */
  def publishLifecycle(tool: String, version: String, sideEffect: String, manifest: Manifest): String = {
    // An event must never announce a promotion the sandbox has not passed, and a rejected version
    // still needs an auditable row.
    val verdict = sandbox.validate(manifest, ValidationDeadlineMs)
    val event = JsObject(
      "tool" -> JsString(tool),
      "version" -> JsString(version),
      "side_effect" -> JsString(sideEffect),
      "outcome" -> JsString(verdict.outcome),
      "findings" -> JsArray(verdict.findings.map(f => JsString(f)).toVector),
    )
    val payload = event.compactPrint
    if (verdict.outcome != "validated") {
      registry.insertOutbox(tool, payload)
      return verdict.outcome
    }
    registry.promote(tool, version)
    try {
      producer.send(new ProducerRecord(Topic, tool, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException => registry.insertOutbox(tool, payload)
    }
    verdict.outcome
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <regex>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kLifecycleTopic = "tool.lifecycle";
const int kValidationDeadlineMs = 10000;

struct Verdict {
  std::string outcome;
  std::vector<std::string> findings;
};

struct Manifest {
  std::string owner_team;
  std::string sandbox_log;
};

class SandboxClient {
 public:
  /** Exercises the candidate over gRPC in isolation; a timeout is not a pass. */
  Verdict validate(const Manifest& manifest, int deadline_ms);
};

class ToolRegistry {
 public:
  /** Flip the version to promotable. */
  void promote(const std::string& tool, const std::string& version);
};

SandboxClient sandbox;
ToolRegistry registry;

std::unique_ptr<RdKafka::Producer> producer;

std::string redactCredentials(const std::string& log) {
  return std::regex_replace(log, std::regex("api_key=sk-[A-Za-z0-9]+"), "api_key=<redacted>");
}

// TODO: key by the tool name instead of the owner team, run the sandbox validation before
// publishing, keep the sandbox log out of the event, and write an outbox row when the verdict
// rejects the version or the broker rejects the produce.
std::string publishLifecycle(const std::string& tool, const std::string& version,
                             const std::string& sideEffect, const Manifest& manifest) {
  const json event = {
      {"tool", tool},
      {"version", version},
      {"side_effect", sideEffect},
      {"outcome", "promoted"},
      {"sandbox_log", redactCredentials(manifest.sandbox_log)},
  };
  const auto payload = event.dump();
  producer->produce(kLifecycleTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(),
                    manifest.owner_team.data(), manifest.owner_team.size(), 0, nullptr);
  producer->flush(2000);
  const Verdict verdict = sandbox.validate(manifest, kValidationDeadlineMs);
  if (verdict.outcome == "validated") {
    registry.promote(tool, version);
  }
  return verdict.outcome;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kLifecycleTopic = "tool.lifecycle";
const int kValidationDeadlineMs = 10000;

struct Verdict {
  std::string outcome;
  std::vector<std::string> findings;
};

class SandboxClient {
 public:
  /** Exercises the candidate over gRPC in isolation; a timeout is not a pass. */
  Verdict validate(const Manifest& manifest, int deadline_ms);
};

class ToolRegistry {
 public:
  /** Flip the version to promotable — only ever after a validated verdict. */
  void promote(const std::string& tool, const std::string& version);

  /** Durable row a relay republishes when the broker did not accept the event. */
  void insertOutbox(const std::string& tool, const json& event);
};

SandboxClient sandbox;
ToolRegistry registry;

// enable.idempotence with acks=all: a retried produce with the same key cannot duplicate a record.
std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// Validate the candidate first, then publish one tool.lifecycle event keyed by the tool name: the
// verdict is the outcome, and a rejected version goes to the outbox instead of being announced.
std::string publishLifecycle(const std::string& tool, const std::string& version,
                             const std::string& sideEffect, const Manifest& manifest) {
  const Verdict verdict = sandbox.validate(manifest, kValidationDeadlineMs);
  const json event = {
      {"tool", tool},
      {"version", version},
      {"side_effect", sideEffect},
      {"outcome", verdict.outcome},
      {"findings", verdict.findings},
  };
  const auto payload = event.dump();
  if (verdict.outcome != "validated") {
    registry.insertOutbox(tool, event);
    return verdict.outcome;
  }
  registry.promote(tool, version);
  const auto err = producer->produce(kLifecycleTopic, RdKafka::Topic::PARTITION_UA,
                                     RdKafka::Producer::RK_MSG_COPY,
                                     const_cast<char*>(payload.data()), payload.size(),
                                     tool.data(), tool.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    registry.insertOutbox(tool, event);
  }
  producer->flush(2000);
  return verdict.outcome;
}
`,
    },
  },
  debrief: `The interviewer is probing two questions under many names: what is the ordering key, and
what happens to the event that could not be published? The record key is an ordering contract: keyed
by the tool name, one tool’s registered → validated → promoted → revoked history stays on one
partition in order; keyed by the owner team, it interleaves with every other tool that team owns,
and a consumer replaying the topic can no longer reconstruct what was live when. Publication order
is a correctness contract: validate, record the promotion, then publish, so the topic can never
announce a version the sandbox has not passed — the draft publishes first and validates afterwards,
which turns the topic into a source of lies the moment a candidate fails. The payload is a retention
contract: the topic holds every event on every replica for days, so the sandbox log behind a
best-effort regex redaction is a leak waiting for a credential in an unexpected shape; the fix is to
carry the verdict instead of the evidence. The outbox is the durability contract: a rejected version
and a broker outage both end as a row a relay republishes, so the audit trail survives the broker
being down. Real registries add a schema id and a compacted latest-version topic beside the
append-only one, consumers that replay into a catalog projection, and a relay with its own retry
budget for the outbox.`,
};
