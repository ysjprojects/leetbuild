import type {Step} from '@/lib/types';

export const decisionEventsStep: Step = {
  id: 'events',
  title: 'Firewall events keyed by channel with prompt hashes',
  concept: 'kafka',
  file: 'events',
  focus: ['kafka', 'outbox', 'audit'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the publisher: it builds a
record, sends it to \`firewall.decision\` and catches an error. It compiles, it serves the happy path,
and it is wrong in three ways that only a reviewer would notice. Review it, fix it, prove it.

Publish one \`firewall.decision\` event per decision.

- **Key by channel.** The message key is the channel (\`user\`, \`tool\`, \`retrieval\`), so every
  decision for one channel lands in one partition and the stream reads in order. The draft keys by
  tenant, which interleaves channels and makes "what happened to tool prompts at 14:02" a partition
  scan across tenants.
- The payload carries the decision, the matched **rule ids**, the **spans** and a **prompt hash**
  (\`prompt_sha256\`) — plus the rule version that produced it. Never the prompt, and never the text
  of a matched span.
- The producer is **idempotent with \`acks=all\`**, so a retried produce cannot duplicate a record.
- When the produce fails, **write an outbox row** with the same payload. The draft swallows the
  error: a broker hiccup then erases the only record that a prompt was blocked.

**Failure mode the checks target.** The draft's payload includes \`span_text\` and a \`prompt_excerpt\`
"so rules can be tuned from logs" — which is the injection attempt itself, copied into a topic that
is retained across replicas, backups and every consumer that ever joins. The tenant key is the
ordering bug; the dropped event is the audit hole; the excerpt is the data leak. All three are the
same mistake: treating the event as a debugging aid for this service instead of a record that other
people will read.`,
  sequence: {
    participants: ['Prompt Firewall', 'firewall.decision', 'Audit consumer', 'Outbox'],
    messages: [
      {from: 'Prompt Firewall', to: 'firewall.decision', label: 'produce · key = channel · acks = all', kind: 'sync'},
      {from: 'firewall.decision', to: 'Prompt Firewall', label: 'ack · or broker error', kind: 'reply'},
      {from: 'Prompt Firewall', to: 'Outbox', label: 'writeOutbox(record) when the produce fails', kind: 'sync'},
      {from: 'firewall.decision', to: 'Audit consumer', label: 'consume · ordered per channel', kind: 'async'},
      {from: 'Audit consumer', to: 'Outbox', label: 'replay unsent decisions', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'key-by-channel',
      title: 'Keyed by channel so each channel stream stays ordered',
      detail:
        'The message key is the channel: `key=event.channel`, `key: event.channel`, `Key: []byte(event.Channel)`. The draft keys by tenant, so one channel’s decisions are interleaved with every other channel’s and order per channel is lost.',
      match: {
        python: {all: [/firewall\.decision/, /key\s*=\s*event\.channel/]},
        typescript: {all: [/firewall\.decision/, /key:\s*event\.channel/]},
        go: {all: [/firewall\.decision/, /Key:\s*\[\]byte\(event\.Channel\)/]},
        scala: {all: [/firewall\.decision/, /new ProducerRecord\(DecisionTopic,\s*event\.channel/]},
        cpp: {all: [/firewall\.decision/, /produce\([^;]*event\.channel\.data\(\)/]},
      },
    },
    {
      id: 'payload-fields',
      title: 'Carries rule ids, spans and a prompt hash',
      detail:
        'The record carries the matched rule ids, the spans and `prompt_sha256`, so a decision can be audited and a rule tuned without the prompt. The draft sends span text and a prompt excerpt instead.',
      match: {
        python: {all: [/"rules"/, /"spans"/, /prompt_sha256/]},
        typescript: {all: [/\brules\b/, /\bspans\b/, /prompt_sha256/]},
        go: {all: [/"rules"/, /"spans"/, /prompt_sha256/]},
        scala: {all: [/"rules"/, /"spans"/, /prompt_sha256/]},
        cpp: {all: [/"rules"/, /"spans"/, /prompt_sha256/]},
      },
    },
    {
      id: 'no-content-leak',
      title: 'Never ships span text or a prompt excerpt',
      detail:
        'Neither the payload nor a log line carries the matched span text or an excerpt of the prompt. The draft sends both "so rules can be tuned from logs" — a copy of the attack text in a retained, replicated topic.',
      match: {
        python: {all: [/firewall\.decision/], none: [/span_text/, /prompt_excerpt/]},
        typescript: {all: [/firewall\.decision/], none: [/span_text/, /prompt_excerpt/]},
        go: {all: [/firewall\.decision/], none: [/span_text/, /prompt_excerpt/]},
        scala: {all: [/firewall\.decision/], none: [/span_text/, /prompt_excerpt/]},
        cpp: {all: [/firewall\.decision/], none: [/span_text/, /prompt_excerpt/]},
      },
    },
    {
      id: 'outbox-row',
      title: 'Writes an outbox row when the produce fails',
      detail:
        'A rejected produce writes the same record to the outbox inside the error branch, so no blocked attempt disappears from the record. The draft catches the broker error and drops the event.',
      match: {
        python: {all: [/write_outbox\(/, /except/]},
        typescript: {all: [/writeOutbox\(/, /\bcatch\b/]},
        go: {all: [/writeOutbox\(/, /err\s*!=\s*nil/]},
        scala: {all: [/writeOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/writeOutbox\(/, /catch/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` (`enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` and `acks: -1`, or required acks `all` with a hash balancer). A retry of a produce must not duplicate the record.',
      match: {
        python: {all: [/"acks":\s*"all"/, /"enable_idempotence":\s*True/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/ACKS_CONFIG/, /ENABLE_IDEMPOTENCE_CONFIG/]},
        cpp: {all: [/"acks",\s*"all"/, /"enable\.idempotence"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("firewall-events")
TOPIC = "firewall.decision"

producer = Producer({"bootstrap.servers": "kafka:9092"})


def event_record(event) -> dict:
    """Everything a rule author needs to tune a rule, straight from the matched span."""
    return {
        "channel": event.channel,
        "decision": event.decision,
        "rules": event.rules,
        "spans": event.spans,
        "span_text": event.span_text,
        "prompt_excerpt": event.prompt[:120],
    }


def publish(event) -> None:
    # TODO: the draft keys by tenant, ships the matched span text and a prompt excerpt so rules can
    # be tuned from logs, and swallows a failed produce. Key by channel, publish rule ids, spans and
    # a prompt hash only, and write an outbox row when the broker rejects the produce.
    record = event_record(event)
    payload = json.dumps(record).encode("utf-8")
    try:
        producer.produce(TOPIC, key=event.tenant, value=payload)
        producer.poll(0)
    except Exception:
        logger.warning("produce failed; dropping event")
`,
      solution: `import hashlib
import json
import logging

from confluent_kafka import KafkaError, Producer

logger = logging.getLogger("firewall-events")
TOPIC = "firewall.decision"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable_idempotence": True,
    }
)


def prompt_sha256(prompt: str) -> str:
    """The only trace of the prompt that leaves the process: a hash for dedupe and rule tuning."""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def event_record(event, rule_version: str) -> dict:
    """Decision, rule ids, spans and a prompt hash — never span text, never prompt text."""
    return {
        "channel": event.channel,
        "decision": event.decision,
        "rules": event.rules,
        "spans": event.spans,
        "prompt_sha256": event.prompt_sha256,
        "rule_version": rule_version,
    }


def write_outbox(record: dict) -> None:
    """Keeps a blocked attempt in the record when the broker rejects the produce."""
    db.execute(
        "INSERT INTO firewall_outbox (topic, payload) VALUES (%s, %s)",
        (TOPIC, json.dumps(record)),
    )


def publish(event, rule_version: str) -> None:
    record = event_record(event, rule_version)
    payload = json.dumps(record).encode("utf-8")
    try:
        producer.produce(TOPIC, key=event.channel, value=payload)
        producer.poll(0)
    except KafkaError:
        logger.exception("produce failed channel=%s", event.channel)
        write_outbox(record)
`,
    },
    typescript: {
      starter: `/** A model-generated publisher that keys by tenant and ships matched span text. */
import {Kafka} from 'kafkajs';

const TOPIC = 'firewall.decision';

export const producer = new Kafka({brokers: ['kafka:9092']}).producer();

export function eventRecord(event: FirewallEvent) {
  return {
    channel: event.channel,
    decision: event.decision,
    rules: event.rules,
    spans: event.spans,
    span_text: event.spanText,
    prompt_excerpt: event.prompt.slice(0, 120),
  };
}

export async function publish(event: FirewallEvent): Promise<void> {
  // TODO: the draft keys by tenant, ships the matched span text and a prompt excerpt so rules can
  // be tuned from logs, and swallows a failed produce. Key by channel, publish rule ids, spans and
  // a prompt hash only, and write an outbox row when the broker rejects the produce.
  const record = eventRecord(event);
  try {
    await producer.send({topic: TOPIC, messages: [{key: event.tenant, value: JSON.stringify(record)}]});
  } catch (error) {
    logger.warn({err: error}, 'produce failed; dropping event');
  }
}
`,
      solution: `/** Decisions published to firewall.decision, keyed by channel, carrying ids and a hash. */
import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

const TOPIC = 'firewall.decision';

export const producer = new Kafka({brokers: ['kafka:9092']}).producer({
  idempotent: true,
  acks: -1,
  maxInFlightRequests: 1,
});

export function promptSha256(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export function eventRecord(event: FirewallEvent, ruleVersion: string) {
  return {
    channel: event.channel,
    decision: event.decision,
    rules: event.rules,
    spans: event.spans,
    prompt_sha256: event.promptSha256,
    rule_version: ruleVersion,
  };
}

export async function writeOutbox(record: FirewallRecord): Promise<void> {
  await db.query('INSERT INTO firewall_outbox (topic, payload) VALUES ($1, $2)', [TOPIC, JSON.stringify(record)]);
}

export async function publish(event: FirewallEvent, ruleVersion: string): Promise<void> {
  const record = eventRecord(event, ruleVersion);
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: event.channel, value: JSON.stringify(record)}]});
  } catch (error) {
    logger.error({err: error, channel: event.channel}, 'produce failed');
    await writeOutbox(record);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const decisionTopic = "firewall.decision"

var decisionWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: decisionTopic}

type FirewallEvent struct {
	Channel  string   \`json:"channel"\`
	Tenant   string   \`json:"tenant"\`
	Decision string   \`json:"decision"\`
	Rules    []string \`json:"rules"\`
	Spans    []Span   \`json:"spans"\`
	SpanText string   \`json:"span_text"\`
	Prompt   string   \`json:"prompt_excerpt"\`
}

// TODO: the draft keys by tenant, ships the matched span text and a prompt excerpt so rules can be
// tuned from logs, and swallows a failed produce. Key by channel, publish rule ids, spans and a
// prompt hash only, and write an outbox row when the broker rejects the produce.
func publish(ctx context.Context, event FirewallEvent) {
	record := map[string]any{
		"channel":        event.Channel,
		"decision":       event.Decision,
		"rules":          event.Rules,
		"spans":          event.Spans,
		"span_text":      event.SpanText,
		"prompt_excerpt": event.Prompt,
	}
	payload, err := json.Marshal(record)
	if err != nil {
		log.Printf("marshal failed")
		return
	}
	if err := decisionWriter.WriteMessages(ctx, kafka.Message{Key: []byte(event.Tenant), Value: payload}); err != nil {
		log.Printf("produce failed; dropping event")
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const decisionTopic = "firewall.decision"

// RequiredAcks=RequireAll with a hash balancer is the kafka-go equivalent of an idempotent
// producer: a retried record is acknowledged only once it is replicated, and it lands on the same
// partition as the original instead of duplicating across them.
var decisionWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        decisionTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type FirewallEvent struct {
	Channel      string
	Decision     string
	Rules        []string
	Spans        []Span
	PromptSHA256 string
	RuleVersion  string
}

func promptSHA256(prompt string) string {
	sum := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(sum[:])
}

func eventRecord(event FirewallEvent) map[string]any {
	return map[string]any{
		"channel":       event.Channel,
		"decision":      event.Decision,
		"rules":         event.Rules,
		"spans":         event.Spans,
		"prompt_sha256": event.PromptSHA256,
		"rule_version":  event.RuleVersion,
	}
}

func writeOutbox(ctx context.Context, record map[string]any) {
	payload, err := json.Marshal(record)
	if err != nil {
		log.Printf("outbox marshal failed")
		return
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO firewall_outbox (topic, payload) VALUES (?, ?)", decisionTopic, payload); err != nil {
		log.Printf("outbox insert failed: %v", err)
	}
}

func publish(ctx context.Context, event FirewallEvent) {
	record := eventRecord(event)
	payload, err := json.Marshal(record)
	if err != nil {
		log.Printf("marshal failed: %v", err)
		return
	}
	if err := decisionWriter.WriteMessages(ctx, kafka.Message{Key: []byte(event.Channel), Value: payload}); err != nil {
		log.Printf("produce failed channel=%s: %v", event.Channel, err)
		writeOutbox(ctx, record)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object DecisionEvents {
  val DecisionTopic = "firewall.decision"

  val producer = new KafkaProducer[String, String](new Properties())

  final case class FirewallEvent(
      channel: String,
      tenant: String,
      decision: String,
      rules: List[String],
      spans: List[Span],
      spanText: String,
      prompt: String
  )

  // TODO: the draft keys by tenant, ships the matched span text and a prompt excerpt so rules can
  // be tuned from logs, and swallows a failed produce. Key by channel, publish rule ids, spans and
  // a prompt hash only, and write an outbox row when the broker rejects the produce.
  def eventRecord(event: FirewallEvent): String = {
    val rules = event.rules.mkString(",")
    s"""{"channel":"\${event.channel}","decision":"\${event.decision}","rules":[$rules],""" +
      s""""span_text":"\${event.spanText}","prompt_excerpt":"\${event.prompt.take(120)}"}"""
  }

  def publish(event: FirewallEvent): Unit = {
    val record = eventRecord(event)
    try {
      producer.send(new ProducerRecord(DecisionTopic, event.tenant, record))
    } catch {
      case error: Exception => System.err.println(s"produce failed; dropping event: $error")
    }
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

object DecisionEvents {
  val DecisionTopic = "firewall.decision"

  val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put(ProducerConfig.ACKS_CONFIG, "all")
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
    props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, "1")
    new KafkaProducer[String, String](props)
  }

  final case class FirewallEvent(
      channel: String,
      decision: String,
      rules: List[String],
      spans: List[Span],
      promptSha256: String,
      ruleVersion: String
  )

  def promptSha256(prompt: String): String =
    MessageDigest.getInstance("SHA-256").digest(prompt.getBytes("UTF-8")).map("%02x".format(_)).mkString

  // Decision, rule ids, spans and a prompt hash — never span text, never prompt text.
  def eventRecord(event: FirewallEvent): String = {
    val rules = event.rules.map(id => "\\"" + id + "\\"").mkString(",")
    val spans = event.spans.map(span => s"""{"start":\${span.start},"end":\${span.end}}""").mkString(",")
    s"""{"channel":"\${event.channel}","decision":"\${event.decision}","rules":[$rules],""" +
      s""""spans":[$spans],"prompt_sha256":"\${event.promptSha256}","rule_version":"\${event.ruleVersion}"}"""
  }

  def writeOutbox(record: String): Unit =
    db.execute("INSERT INTO firewall_outbox (topic, payload) VALUES (?, ?)", DecisionTopic, record)

  def publish(event: FirewallEvent): Unit = {
    val record = eventRecord(event)
    try {
      producer.send(new ProducerRecord(DecisionTopic, event.channel, record))
    } catch {
      case error: Exception =>
        System.err.println(s"produce failed channel=\${event.channel}: $error")
        writeOutbox(record)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kDecisionTopic = "firewall.decision";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: the draft keys by tenant, ships the matched span text and a prompt excerpt so rules can be
// tuned from logs, and swallows a failed produce. Key by channel, publish rule ids, spans and a
// prompt hash only, and write an outbox row when the broker rejects the produce.
void publish(const FirewallEvent& event) {
  const json record = {
      {"channel", event.channel},
      {"decision", event.decision},
      {"rules", event.rules},
      {"spans", event.spans},
      {"span_text", event.span_text},
      {"prompt_excerpt", event.prompt.substr(0, 120)},
  };
  const auto payload = record.dump();
  const auto err = producer->produce(
      kDecisionTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
      payload.size(), event.tenant.data(), event.tenant.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "produce failed; dropping event\\n";
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kDecisionTopic = "firewall.decision";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

std::string prompt_sha256(const std::string& prompt);

// Decision, rule ids, spans and a prompt hash — never span text, never prompt text.
json event_record(const FirewallEvent& event) {
  return {
      {"channel", event.channel},
      {"decision", event.decision},
      {"rules", event.rules},
      {"spans", event.spans},
      {"prompt_sha256", event.prompt_sha256},
      {"rule_version", event.rule_version},
  };
}

void writeOutbox(const json& record) {
  try {
    db->execute("INSERT INTO firewall_outbox (topic, payload) VALUES (?, ?)", kDecisionTopic, record.dump());
  } catch (const std::exception& error) {
    std::clog << "outbox insert failed: " << error.what() << "\\n";
  }
}

void publish(const FirewallEvent& event) {
  const json record = event_record(event);
  const auto payload = record.dump();
  const auto err = producer->produce(
      kDecisionTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
      payload.size(), event.channel.data(), event.channel.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    std::cerr << "produce failed channel=" << event.channel << "\\n";
    writeOutbox(record);
  }
}
`,
    },
  },
  hints: [
    'The message key is the partition key. Keying by channel makes each channel’s decision stream ordered; keying by tenant (or by request) interleaves channels, and any later consumer that wants "all tool decisions in order" has to rebuild that order itself.',
    'Idempotence is producer configuration, not application logic: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or required acks `all` behind a hash balancer. It requires the same message key on every retry — the same fix as the channel key.',
    'The payload is a record other people will read. Send ids, offsets and a hash (`prompt_sha256`); the span *offsets* locate the match without shipping the match. When the broker rejects the produce, insert the same record into the outbox instead of logging the failure and moving on.',
  ],
  debrief: `The interviewer is testing whether you can tell a debugging aid from a record. The draft's payload is convenient for the author and expensive for everyone else: the matched text and a prompt excerpt are the attack in its original form, sitting in a compacted, replicated, long-retention topic that every future consumer can read. The channel key is the ordering contract the audit team needs, and the outbox is the difference between "we logged that something failed" and "we can prove which prompts were blocked during the outage". Real systems add a schema registry so a future producer cannot smuggle content in, a hash-salted prompt digest so the same prompt is comparable across services without being reversible, and a consumer that reads the outbox and republishes with the same key so replays stay ordered.`,
};
