import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Suggestion events behind GET /v1/autocomplete',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces a \`suggest.event\`
for every impression and selection. It compiles, the topic fills in the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement the suggestion event producer behind \`GET /v1/autocomplete\`.

- Events publish to the **\`suggest.event\`** topic, **keyed by tenant**, so every event for one tenant
  lands on one partition and stays ordered. Impression and selection events for the same session
  arrive in the order they happened.
- The payload carries a **prefix hash**, a position and a latency in milliseconds — **never the raw
  prefix text**. A prefix can be a person's name typed into a search box; hashing it keyed by tenant
  keeps the event joinable without storing the name.
- **No event is lost during a broker hiccup.** A produce failure writes the event to the outbox so it
  can be replayed, rather than dropping it. The producer is configured **idempotent with
  \`acks=all\`**, so a retry cannot duplicate an event.
- The outbox row is the durable record; the replay publishes it with the same key so ordering holds.
- The event never carries the raw prefix, in the payload or in a log line.

**Failure mode the checks target.** Keying by prefix scatters one tenant's events across partitions,
so ordering is gone and per-session sequences look shuffled. Publishing the raw prefix text ships a
possible name into a retained, replicated topic — the exact place a search term should never be. The
subtle one is the swallowed produce failure: the draft catches the exception, logs it and moves on,
so during a broker hiccup the metrics silently lose the events the product makes decisions on.`,
  sequence: {
    participants: ['Autocomplete API', 'suggest.event', 'Event consumer'],
    messages: [
      {
        from: 'Autocomplete API',
        to: 'Autocomplete API',
        label: 'hash(tenant, prefix) · position · latency',
        kind: 'sync',
      },
      {from: 'Autocomplete API', to: 'suggest.event', label: 'produce key=tenant · acks=all', kind: 'async'},
      {from: 'Autocomplete API', to: 'Autocomplete API', label: 'on failure: write outbox row', kind: 'sync'},
      {from: 'suggest.event', to: 'Event consumer', label: 'consume in tenant order', kind: 'async'},
      {from: 'Event consumer', to: 'Event consumer', label: 'aggregate counts before commit', kind: 'sync'},
      {from: 'Event consumer', to: 'suggest.event', label: 'commit offset', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'tenant-key',
      title: 'Keys events by tenant',
      detail:
        "Events publish to `suggest.event` keyed by tenant, so one tenant's events share a partition and stay ordered. The draft keys by prefix, scattering them.",
      match: {
        python: {all: [/"suggest\.event"/, /key\s*=\s*tenant/]},
        typescript: {all: [/'suggest\.event'/, /key:\s*tenant/]},
        go: {all: [/"suggest\.event"/, /Key:\s*\[\]byte\(tenant\)/]},
        scala: {all: [/"suggest\.event"/, /ProducerRecord[^(]*\(\s*Topic\s*,\s*tenant/]},
        cpp: {all: [/"suggest\.event"/, /tenant\.c_str\(\)/]},
      },
    },
    {
      id: 'prefix-hash',
      title: 'Carries a prefix hash, never the raw prefix',
      detail:
        'The payload carries `prefix_hash`, a hash of `(tenant, prefix)`, and never the raw prefix text. The draft publishes the raw prefix "for relevance tuning".',
      match: {
        python: {all: [/prefix_hash/, /sha256/], none: [/"prefix"\s*:\s*prefix\b/]},
        typescript: {all: [/prefixHash/, /createHash/], none: [/prefix:\s*prefix\b/]},
        go: {all: [/prefixHash/, /sha256/], none: [/"prefix":\s*prefix\b/]},
        scala: {all: [/prefixHash/, /MessageDigest/], none: [/"prefix":"\$prefix"/]},
        cpp: {all: [/prefixHash/, /sha256/], none: [/\\"prefix\\":/]},
      },
    },
    {
      id: 'durable',
      title: 'Writes the outbox when the broker rejects the produce',
      detail:
        'A produce failure writes an outbox row for replay instead of dropping the event. The draft swallows the exception and loses the event.',
      match: {
        python: {all: [/OUTBOX/, /except\s+Exception/]},
        typescript: {all: [/OUTBOX/, /catch\s*\(/]},
        go: {all: [/outbox/, /WriteMessages\(/]},
        scala: {all: [/Outbox/, /catch\s*\{/]},
        cpp: {all: [/kOutbox/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'idempotent-producer',
      title: 'Produces idempotently with acks=all',
      detail:
        'The producer is configured idempotent with `acks=all`, so a retry cannot duplicate an event. The draft uses the defaults.',
      match: {
        python: {all: [/"enable\.idempotence"\s*:\s*True/, /"acks"\s*:\s*"all"/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /MaxAttempts/]},
        scala: {all: [/ACKS_CONFIG\s*,\s*"all"/, /ENABLE_IDEMPOTENCE_CONFIG/]},
        cpp: {all: [/"acks"\s*,\s*"all"/, /"enable\.idempotence"/]},
      },
    },
    {
      id: 'payload-fields',
      title: 'Carries the prefix hash, position and latency',
      detail:
        'The payload carries the prefix hash, the position in the suggestion list and the latency in milliseconds. The draft carries the raw prefix and the two numbers.',
      match: {
        python: {all: [/prefix_hash/, /"position"/, /"latency_ms"/]},
        typescript: {all: [/prefix_hash/, /position/, /latency_ms/]},
        go: {all: [/prefix_hash/, /position/, /latency_ms/]},
        scala: {all: [/prefix_hash/, /position/, /latency_ms/]},
        cpp: {all: [/prefix_hash/, /position/, /latency_ms/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

TOPIC = "suggest.event"


def publish(producer, tenant: str, prefix: str, position: int, latency_ms: int) -> None:
    # TODO: this draft keys by prefix so one tenant's events scatter across partitions, publishes
    # the raw prefix text for "relevance tuning", and lets a producer exception drop the event.
    payload = json.dumps({"prefix": prefix, "position": position, "latency_ms": latency_ms})
    try:
        producer.produce(topic=TOPIC, key=prefix, value=payload)
        producer.flush()
    except Exception as error:
        logger.warning("produce failed: %s", error)
`,
      solution: `import hashlib
import json

from confluent_kafka import Producer

TOPIC = "suggest.event"
OUTBOX = "suggest_outbox"


def prefix_hash(tenant: str, prefix: str) -> str:
    digest = hashlib.sha256(f"{tenant}:{prefix}".encode("utf-8")).hexdigest()
    return digest[:32]


def build_producer(bootstrap: str) -> Producer:
    return Producer(
        {
            "bootstrap.servers": bootstrap,
            "enable.idempotence": True,
            "acks": "all",
            "retries": 2147483647,
        }
    )


def event(tenant: str, prefix: str, position: int, latency_ms: int) -> str:
    return json.dumps(
        {
            "tenant": tenant,
            "prefix_hash": prefix_hash(tenant, prefix),
            "position": position,
            "latency_ms": latency_ms,
        }
    )


def publish(producer, tenant: str, prefix: str, position: int, latency_ms: int) -> None:
    payload = event(tenant, prefix, position, latency_ms)
    try:
        producer.produce(topic=TOPIC, key=tenant, value=payload)
        producer.flush()
    except Exception:
        save_outbox(OUTBOX, tenant, payload)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

export const TOPIC = 'suggest.event';

export async function publish(
  producer: Producer,
  tenant: string,
  prefix: string,
  position: number,
  latency_ms: number,
): Promise<void> {
  // TODO: this draft keys by prefix so one tenant's events scatter across partitions, publishes
  // the raw prefix text for "relevance tuning", and lets a producer exception drop the event.
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{key: prefix, value: JSON.stringify({prefix: prefix, position, latency_ms})}],
    });
  } catch (error) {
    logger.warn({error}, 'produce failed');
  }
}
`,
      solution: `import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

export const TOPIC = 'suggest.event';
export const OUTBOX = 'suggest_outbox';

export function prefixHash(tenant: string, prefix: string): string {
  return createHash('sha256').update(\`\${tenant}:\${prefix}\`).digest('hex').slice(0, 32);
}

export interface SuggestEvent {
  tenant: string;
  prefix_hash: string;
  position: number;
  latency_ms: number;
}

export function buildEvent(tenant: string, prefix: string, position: number, latency_ms: number): SuggestEvent {
  return {tenant, prefix_hash: prefixHash(tenant, prefix), position, latency_ms};
}

export const producer = new Kafka({brokers: []}).producer({
  idempotent: true,
  acks: -1,
  retry: {retries: 2147483647},
});

export async function publish(
  producer: Producer,
  tenant: string,
  prefix: string,
  position: number,
  latency_ms: number,
): Promise<void> {
  const payload = JSON.stringify(buildEvent(tenant, prefix, position, latency_ms));
  try {
    await producer.send({topic: TOPIC, acks: -1, messages: [{key: tenant, value: payload}]});
  } catch (error) {
    await outbox.put(OUTBOX, tenant, payload);
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

const topic = "suggest.event"

func Publish(ctx context.Context, writer *kafka.Writer, tenant, prefix string, position, latencyMs int) error {
	// TODO: this draft keys by prefix so one tenant's events scatter across partitions, publishes
	// the raw prefix text for "relevance tuning", and lets a producer exception drop the event.
	payload, err := json.Marshal(map[string]any{"prefix": prefix, "position": position, "latency_ms": latencyMs})
	if err != nil {
		return err
	}
	message := kafka.Message{Key: []byte(prefix), Value: payload}
	if err := writer.WriteMessages(ctx, message); err != nil {
		log.Printf("produce failed: %v", err)
	}
	return nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const (
	topic  = "suggest.event"
	outbox = "suggest_outbox"
)

func prefixHash(tenant, prefix string) string {
	sum := sha256.Sum256([]byte(tenant + ":" + prefix))
	return hex.EncodeToString(sum[:])[:32]
}

type SuggestEvent struct {
	Tenant     string \`json:"tenant"\`
	PrefixHash string \`json:"prefix_hash"\`
	Position   int    \`json:"position"\`
	LatencyMs  int    \`json:"latency_ms"\`
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("broker:9092"),
	Topic:        topic,
	RequiredAcks: kafka.RequireAll,
	MaxAttempts:  2147483647,
}

func Publish(ctx context.Context, writer *kafka.Writer, tenant, prefix string, position, latencyMs int) error {
	event := SuggestEvent{
		Tenant:     tenant,
		PrefixHash: prefixHash(tenant, prefix),
		Position:   position,
		LatencyMs:  latencyMs,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	message := kafka.Message{Key: []byte(tenant), Value: payload}
	if err := writer.WriteMessages(ctx, message); err != nil {
		return saveOutbox(ctx, outbox, tenant, payload)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object Events {
  val Topic = "suggest.event"

  def publish(producer: KafkaProducer[String, String], tenant: String, prefix: String, position: Int, latencyMs: Int): Unit = {
    // TODO: this draft keys by prefix so one tenant's events scatter across partitions, publishes
    // the raw prefix text for "relevance tuning", and lets a producer exception drop the event.
    val payload = s"""{"prefix":"$prefix","position":$position,"latency_ms":$latencyMs}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, prefix, payload))
      producer.flush()
    } catch {
      case error: Exception => logger.warn(s"produce failed: $error")
    }
  }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

object Events {
  val Topic = "suggest.event"
  val Outbox = "suggest_outbox"

  def prefixHash(tenant: String, prefix: String): String = {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.digest(s"$tenant:$prefix".getBytes("UTF-8")).take(16).map(b => f"\${b & 0xff}%02x").mkString
  }

  def producerConfigs(bootstrap: String): java.util.Map[String, Object] = {
    val props = new java.util.HashMap[String, Object]()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap)
    props.put(ProducerConfig.ACKS_CONFIG, "all")
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, "true")
    props
  }

  def publish(producer: KafkaProducer[String, String], tenant: String, prefix: String, position: Int, latencyMs: Int): Unit = {
    val payload =
      s"""{"tenant":"$tenant","prefix_hash":"\${prefixHash(tenant, prefix)}","position":$position,"latency_ms":$latencyMs}"""
    try {
      producer.send(new ProducerRecord[String, String](Topic, tenant, payload))
      producer.flush()
    } catch {
      case _: Exception => outboxStore.put(Outbox, tenant, payload)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <string>

#include <librdkafka/rdkafkacpp.h>

const std::string kTopic = "suggest.event";

void publish(RdKafka::Producer& producer, const std::string& tenant, const std::string& prefix, int position, int latencyMs) {
  // TODO: this draft keys by prefix so one tenant's events scatter across partitions, publishes
  // the raw prefix text for "relevance tuning", and lets a producer exception drop the event.
  const std::string payload = "{\\"prefix\\":\\"" + prefix + "\\",\\"position\\":" + std::to_string(position) +
                              ",\\"latency_ms\\":" + std::to_string(latencyMs) + "}";
  const auto result = producer.produce(kTopic, RdKafka::PartitionAny, RdKafka::Producer::RK_MSG_COPY,
                                       const_cast<char*>(payload.c_str()), payload.size(), prefix.c_str(),
                                       prefix.size(), 0, nullptr);
  if (result != RdKafka::ERR_NO_ERROR) {
    logger.warn("produce failed");
  }
}
`,
      solution: `#include <string>

#include <librdkafka/rdkafkacpp.h>

const std::string kTopic = "suggest.event";
const std::string kOutbox = "suggest_outbox";
const std::string kHashAlgorithm = "sha256";

std::string prefixHash(const std::string& tenant, const std::string& prefix);

void configure(RdKafka::Conf* conf) {
  conf->set("acks", "all", error);
  conf->set("enable.idempotence", "true", error);
}

void publish(RdKafka::Producer& producer, const std::string& tenant, const std::string& prefix, int position, int latencyMs) {
  const std::string payload = "{\\"tenant\\":\\"" + tenant + "\\",\\"prefix_hash\\":\\"" + prefixHash(tenant, prefix) +
                              "\\",\\"position\\":" + std::to_string(position) + ",\\"latency_ms\\":" +
                              std::to_string(latencyMs) + "}";
  const auto result = producer.produce(kTopic, RdKafka::PartitionAny, RdKafka::Producer::RK_MSG_COPY,
                                       const_cast<char*>(payload.c_str()), payload.size(), tenant.c_str(),
                                       tenant.size(), 0, nullptr);
  if (result != RdKafka::ERR_NO_ERROR) {
    saveOutbox(kOutbox, tenant, payload);
  }
  producer.flush(1000);
}
`,
    },
  },
  hints: [
    'The key is the ordering guarantee: `(tenant)` puts every event for one tenant on one partition. The prefix is not a key — it is user text, and it belongs in the payload only as a hash.',
    'Hash the prefix keyed by tenant so the same name from two tenants is not one joinable hash, and never log or publish the raw text. The event carries the hash, the position and the latency; that is enough for relevance tuning.',
    'Do not swallow a produce failure. Write the event to the outbox and let the replay publish it with the same key; keep the producer idempotent with `acks=all` so the replay cannot double-count.',
  ],
  debrief: `The interviewer is testing whether you can review a generated analytics producer at the privacy boundary. The draft reads fine because the demo has one tenant and a healthy broker. Three defects are being checked. Keying by prefix scatters a tenant's events across partitions, so ordering — the thing the topic is for — is gone. Publishing the raw prefix ships user text into a retained, replicated topic, which is where a search term must never be; the fix is a tenant-keyed hash that stays joinable without the text. The subtle one is the swallowed produce failure: the draft catches the exception and logs it, so during a broker hiccup the events that the product's trend decisions depend on are silently missing. Real pipelines add an outbox with a replayer, a schema registry so a future producer cannot smuggle content into the topic, and a metric on outbox depth so a hiccup is visible.`,
};
