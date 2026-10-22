import type {Step} from '@/lib/types';

export const shadowEventsStep: Step = {
  id: 'events',
  title: 'Comparison events keyed by config with no user content',
  concept: 'kafka',
  file: 'events',
  focus: ['shadow', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes a comparison event
on the happy path, so the analytics team sees data arriving. It compiles and the demo works. The
contract it breaks is the one that makes the topic safe and the comparison correct. Review it, fix
it, and prove the fix.

Implement the path that publishes one **paired evaluation** per shadowed request.

- Publish exactly one \`shadow.sample\` event per paired evaluation, **keyed by the config id** —
  partition by config keeps each experiment's samples in order, which is what makes a paired
  comparison meaningful.
- The payload carries **both versions**, **both scores**, a **request fingerprint** and the traffic
  window. It carries **no prompt and no completion text**: the topic is retained and replicated, so
  user content written there outlives every retention policy the request path has.
- The producer is **idempotent with \`acks=all\`** (the stack's equivalent: \`enable.idempotence\` plus
  \`acks: all\`, KafkaJS \`idempotent: true\` with \`acks: -1\`, or \`kafka.RequireAll\` with a hash
  balancer), so a retried produce cannot duplicate a sample.
- When the broker **rejects** the produce mid-experiment, write an **outbox row** (\`insertOutbox\`)
  instead of dropping the sample or failing the request; a relay republishes outbox rows when the
  broker recovers.

**Failure mode the checks target.** The draft publishes the **full prompt and both completions** so
analysts can review by hand — a data leak with a long tail into a retained topic; it keys by **user**,
so one config's samples scatter across partitions and lose their pairing order; and it has **no
outbox**, so a broker hiccup silently loses the comparisons the experiment depends on.`,
  sequence: {
    participants: ['Shadow Service', 'shadow.sample', 'outbox', 'Comparison consumer'],
    messages: [
      {from: 'Shadow Service', to: 'shadow.sample', label: 'produce · key = config id · acks = all', kind: 'sync'},
      {from: 'shadow.sample', to: 'Shadow Service', label: 'ack / broker error', kind: 'reply'},
      {from: 'Shadow Service', to: 'outbox', label: 'insertOutbox(topic, config, payload) on failure', kind: 'sync'},
      {from: 'shadow.sample', to: 'Comparison consumer', label: 'consume · group shadow-pairs', kind: 'async'},
      {from: 'Comparison consumer', to: 'Comparison consumer', label: 'paired delta · interval', kind: 'sync'},
      {from: 'Comparison consumer', to: 'shadow.sample', label: 'commit offset after processing', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'topic',
      title: 'Publishes to shadow.sample',
      detail: 'The paired evaluation is published to the `shadow.sample` topic.',
      match: {
        python: {all: [/shadow\.sample/]},
        typescript: {all: [/shadow\.sample/]},
        go: {all: [/shadow\.sample/]},
        scala: {all: [/shadow\.sample/]},
        cpp: {all: [/shadow\.sample/]},
      },
    },
    {
      id: 'config-key',
      title: 'Keys every sample by the config id',
      detail:
        'The message key is the config id (`key=config_id`, `key: configId`, `Key: []byte(configID)`, a `ProducerRecord` keyed by config). The draft keys by user, so one config’s samples scatter across partitions and lose pairing order.',
      match: {
        python: {all: [/key=config_id/]},
        typescript: {all: [/key:\s*configId/]},
        go: {all: [/Key:\s*\[\]byte\(configID\)/]},
        scala: {all: [/ProducerRecord.*configId/]},
        cpp: {all: [/produce\([\s\S]{0,300}?configId\.c_str\(\)/]},
      },
    },
    {
      id: 'no-content',
      title: 'No prompt or completion text in the payload',
      detail:
        'The payload carries both versions, both scores and a request fingerprint — never the prompt or a completion. The draft copies the prompt and both completions into a retained, replicated topic.',
      match: {
        python: {none: [/\bprompt\b/i, /\bcompletion/i], all: [/fingerprint/i]},
        typescript: {none: [/\bprompt\b/i, /\bcompletion/i], all: [/fingerprint/i]},
        go: {none: [/\bprompt\b/i, /\bcompletion/i], all: [/fingerprint/i]},
        scala: {none: [/\bprompt\b/i, /\bcompletion/i], all: [/fingerprint/i]},
        cpp: {none: [/\bprompt\b/i, /\bcompletion/i], all: [/fingerprint/i]},
      },
    },
    {
      id: 'outbox',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`insertOutbox`) inside the error branch instead of dropping the sample. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is idempotent with `acks=all` — `enable.idempotence` + `acks`, KafkaJS `idempotent: true` + `acks: -1`, or `RequiredAcks: kafka.RequireAll` with a hash balancer. A retried produce must not duplicate a sample.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

logger = logging.getLogger("shadow.events")

SHADOW_TOPIC = "shadow.sample"


class ShadowPublisher:
    def __init__(self, producer):
        self.producer = producer

    def publish(self, config_id: str, pair: dict) -> None:
        # TODO: the draft keys by user so one config's samples scatter, publishes the prompt and
        # both completions so analysts can review, and has no outbox for a rejected produce.
        payload = json.dumps(
            {
                "user_id": pair["user_id"],
                "prompt": pair["prompt"],
                "production_completion": pair["production_completion"],
                "candidate_completion": pair["candidate_completion"],
            }
        )
        self.producer.produce(
            SHADOW_TOPIC, key=pair["user_id"].encode("utf-8"), value=payload.encode("utf-8")
        )
        self.producer.flush()
        logger.info("shadow.sample user=%s", pair["user_id"])
`,
      solution: `import json
import logging

logger = logging.getLogger("shadow.events")

SHADOW_TOPIC = "shadow.sample"
PRODUCER_CONFIG = {"enable.idempotence": True, "acks": "all"}


def build_event(config_id: str, pair: dict) -> dict:
    """One paired evaluation: both versions, both scores, a fingerprint — never user content."""
    return {
        "config_id": config_id,
        "production_version": pair["production_version"],
        "candidate_version": pair["candidate_version"],
        "production_score": pair["production_score"],
        "candidate_score": pair["candidate_score"],
        "fingerprint": pair["fingerprint"],
        "window": pair["window"],
    }


class ShadowPublisher:
    def __init__(self, producer, outbox):
        self.producer = producer
        self.outbox = outbox
        self.producer.configure(PRODUCER_CONFIG)

    def publish(self, config_id: str, pair: dict) -> None:
        payload = json.dumps(build_event(config_id, pair))
        try:
            # Keyed by config id: every sample of one config lands on one partition, in order.
            self.producer.produce(
                SHADOW_TOPIC, key=config_id.encode("utf-8"), value=payload.encode("utf-8")
            )
            self.producer.flush()
        except KafkaException as exc:
            # A rejected produce becomes an outbox row, never a lost comparison.
            self.outbox.insert_outbox(SHADOW_TOPIC, config_id, payload)
            logger.warning("shadow.sample_outboxed config=%s err=%s", config_id, exc)
`,
    },
    typescript: {
      starter: `/** shadow.sample: a model-generated draft that ships user content downstream. */
import type {Producer} from 'kafkajs';

export const SHADOW_TOPIC = 'shadow.sample';

export class ShadowPublisher {
  constructor(private readonly producer: Producer) {}

  async publish(configId: string, pair: Record<string, unknown>): Promise<void> {
    // TODO: the draft keys by user so one config's samples scatter, publishes the prompt and both
    // completions so analysts can review, and has no outbox for a rejected produce.
    const payload = JSON.stringify({
      config_id: configId,
      user_id: pair.user_id,
      prompt: pair.prompt,
      production_completion: pair.production_completion,
      candidate_completion: pair.candidate_completion,
    });
    await this.producer.send({
      topic: SHADOW_TOPIC,
      messages: [{key: String(pair.user_id), value: payload}],
    });
  }
}
`,
      solution: `/** shadow.sample: paired comparison events, keyed by config, without user content. */
import type {Producer} from 'kafkajs';

export const SHADOW_TOPIC = 'shadow.sample';
export const PRODUCER_CONFIG = {idempotent: true, acks: -1};

interface Outbox {
  insertOutbox(topic: string, key: string, payload: string): Promise<void>;
}

interface Pair {
  production_version: string;
  candidate_version: string;
  production_score: number;
  candidate_score: number;
  fingerprint: string;
  window: string;
}

export class ShadowPublisher {
  constructor(
    private readonly producer: Producer,
    private readonly outbox: Outbox,
  ) {}

  async publish(configId: string, pair: Pair): Promise<void> {
    const payload = JSON.stringify({
      config_id: configId,
      production_version: pair.production_version,
      candidate_version: pair.candidate_version,
      production_score: pair.production_score,
      candidate_score: pair.candidate_score,
      fingerprint: pair.fingerprint,
      window: pair.window,
    });
    try {
      // Keyed by config id: every sample of one config lands on one partition, in order.
      await this.producer.send({
        topic: SHADOW_TOPIC,
        acks: -1,
        messages: [{key: configId, value: payload}],
      });
    } catch (error) {
      // A rejected produce becomes an outbox row, never a lost comparison.
      await this.outbox.insertOutbox(SHADOW_TOPIC, configId, payload);
      console.warn('shadow.sample_outboxed', configId, error);
    }
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	kafka "github.com/segmentio/kafka-go"
)

const shadowTopic = "shadow.sample"

type ShadowPublisher struct {
	writer *kafka.Writer
}

func NewShadowPublisher(brokers []string) *ShadowPublisher {
	return &ShadowPublisher{writer: &kafka.Writer{Addr: kafka.TCP(brokers...), Topic: shadowTopic}}
}

func (p *ShadowPublisher) Publish(ctx context.Context, configID string, pair map[string]any) error {
	// TODO: the draft keys by user so one config's samples scatter, publishes the prompt and both
	// completions so analysts can review, and has no outbox for a rejected produce.
	payload, _ := json.Marshal(map[string]any{
		"user_id":               pair["user_id"],
		"prompt":                pair["prompt"],
		"production_completion": pair["production_completion"],
		"candidate_completion":  pair["candidate_completion"],
	})
	return p.writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(pair["user_id"].(string)),
		Value: payload,
	})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"

	kafka "github.com/segmentio/kafka-go"
)

const shadowTopic = "shadow.sample"

type Outbox interface {
	InsertOutbox(ctx context.Context, topic, key, payload string) error
}

type ComparisonEvent struct {
	ConfigID          string  \`json:"config_id"\`
	ProductionVersion string  \`json:"production_version"\`
	CandidateVersion  string  \`json:"candidate_version"\`
	ProductionScore   float64 \`json:"production_score"\`
	CandidateScore    float64 \`json:"candidate_score"\`
	Fingerprint       string  \`json:"fingerprint"\`
	Window            string  \`json:"window"\`
}

type ShadowPublisher struct {
	writer *kafka.Writer
	outbox Outbox
}

func NewShadowPublisher(brokers []string, outbox Outbox) *ShadowPublisher {
	return &ShadowPublisher{
		writer: &kafka.Writer{
			Addr:         kafka.TCP(brokers...),
			Topic:        shadowTopic,
			RequiredAcks: kafka.RequireAll,
			Balancer:     &kafka.Hash{},
		},
		outbox: outbox,
	}
}

func (p *ShadowPublisher) Publish(ctx context.Context, configID string, pair ComparisonEvent) error {
	pair.ConfigID = configID
	payload, err := json.Marshal(pair)
	if err != nil {
		return err
	}
	// Keyed by config id: every sample of one config lands on one partition, in order.
	err = p.writer.WriteMessages(ctx, kafka.Message{Key: []byte(configID), Value: payload})
	if err != nil {
		// A rejected produce becomes an outbox row, never a lost comparison.
		if outboxErr := p.outbox.InsertOutbox(ctx, shadowTopic, configID, string(payload)); outboxErr != nil {
			log.Printf("shadow.sample_outbox_failed config=%s err=%v", configID, outboxErr)
		}
	}
	return err
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object ShadowPublisher {
  val ShadowTopic = "shadow.sample"
}

final class ShadowPublisher(producer: KafkaProducer[String, String]) {
  import ShadowPublisher._

  def publish(configId: String, pair: Map[String, String]): Unit = {
    // TODO: the draft keys by user so one config's samples scatter, publishes the prompt and both
    // completions so analysts can review, and has no outbox for a rejected produce.
    val payload =
      "user=" + pair("user_id") + " prompt=" + pair("prompt") + " completion=" + pair("completion")
    producer.send(new ProducerRecord[String, String](ShadowTopic, pair("user_id"), payload))
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object ShadowPublisher {
  val ShadowTopic = "shadow.sample"

  def producerProps(bootstrap: String): Properties = {
    val props = new Properties()
    props.put("bootstrap.servers", bootstrap)
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  }
}

final case class ComparisonEvent(
    config_id: String,
    production_version: String,
    candidate_version: String,
    production_score: Double,
    candidate_score: Double,
    fingerprint: String,
    window: String
)

final class ShadowPublisher(producer: KafkaProducer[String, String], outbox: Outbox) {
  import ShadowPublisher._

  def publish(configId: String, pair: ComparisonEvent): Unit = {
    val payload = pair.copy(config_id = configId).toString
    try {
      // Keyed by config id: every sample of one config lands on one partition, in order.
      producer.send(new ProducerRecord[String, String](ShadowTopic, configId, payload))
    } catch {
      case error: Throwable =>
        // A rejected produce becomes an outbox row, never a lost comparison.
        outbox.insertOutbox(ShadowTopic, configId, payload)
        System.err.println(s"shadow.sample_outboxed config=$configId err=$error")
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <string>

const std::string kShadowTopic = "shadow.sample";

class ShadowPublisher {
 public:
  explicit ShadowPublisher(RdKafka::Producer* producer) : producer_(producer) {}

  void publish(const std::string& configId, const std::string& userId, const std::string& prompt,
               const std::string& completion) {
    // TODO: the draft keys by user so one config's samples scatter, publishes the prompt and the
    // completion so analysts can review, and has no outbox for a rejected produce.
    const std::string payload =
        "{\\"user_id\\":\\"" + userId + "\\",\\"prompt\\":\\"" + prompt + "\\",\\"completion\\":\\"" + completion + "\\"}";
    producer_->produce(kShadowTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                       const_cast<char*>(payload.data()), payload.size(), userId.c_str(), userId.size(), 0, nullptr);
    std::cerr << "shadow.sample user=" << userId << "\\n";
  }

 private:
  RdKafka::Producer* producer_;
};
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <sstream>
#include <string>

const std::string kShadowTopic = "shadow.sample";

class Outbox {
 public:
  void insertOutbox(const std::string& topic, const std::string& key, const std::string& payload);
};

std::string buildPayload(const std::string& productionVersion, const std::string& candidateVersion,
                         double productionScore, double candidateScore, const std::string& fingerprint) {
  std::ostringstream out;
  out << "{\\"production_version\\":\\"" << productionVersion << "\\",\\"candidate_version\\":\\"" << candidateVersion
      << "\\",\\"production_score\\":" << productionScore << ",\\"candidate_score\\":" << candidateScore
      << ",\\"fingerprint\\":\\"" << fingerprint << "\\"}";
  return out.str();
}

RdKafka::Producer* buildProducer(const std::string& brokers) {
  std::string errstr;
  RdKafka::Conf* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", brokers, errstr);
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
  return RdKafka::Producer::create(conf, errstr);
}

class ShadowPublisher {
 public:
  ShadowPublisher(RdKafka::Producer* producer, Outbox& outbox) : producer_(producer), outbox_(outbox) {}

  void publish(const std::string& configId, const std::string& payload) {
    const RdKafka::ErrorCode err =
        producer_->produce(kShadowTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                           const_cast<char*>(payload.data()), payload.size(), configId.c_str(), configId.size(), 0, nullptr);
    if (err != RdKafka::ERR_NO_ERROR) {
      // A rejected produce becomes an outbox row, never a lost comparison.
      outbox_.insertOutbox(kShadowTopic, configId, payload);
      std::cerr << "shadow.sample_outboxed config=" << configId << " err=" << RdKafka::err2str(err) << "\\n";
    }
  }

 private:
  RdKafka::Producer* producer_;
  Outbox& outbox_;
};
`,
    },
  },
  hints: [
    'The message key is the partition key: `key=config_id` (or `Key: []byte(configID)`, `key: configId`, a `ProducerRecord(topic, configId, …)`). Keyed by user, one config’s samples land in different partitions and their pairing order is no longer guaranteed.',
    'Idempotence is producer configuration: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or `RequiredAcks: kafka.RequireAll` with a hash balancer. It needs the same message key on every retry, which is the same fix as the config key.',
    'The payload is the experiment’s contract: both versions, both scores and a request fingerprint. If the payload can name the user or carry the text, the comparison is correct but the topic is a copy of the data the redactor removed. The outbox is the durability half: wrap the produce and insert a row when the broker rejects it.',
  ],
  debrief: `The interviewer is testing whether you can keep a shadow’s analytics from becoming a second copy of production data, and whether the comparison is statistically usable. Four defects are being checked. The key: partition by config keeps one experiment’s samples ordered so pairing is meaningful; keyed by user they scatter. The payload: a retained, replicated topic is the wrong place for prompts and completions, so the payload carries versions, scores and a fingerprint — an id, not content. The producer: idempotence with \`acks=all\` is what stops a retried produce from double-counting a sample, and it depends on the same stable key. The outbox: a broker rejection mid-experiment must not silently lose the samples the report will be computed from. Real pipelines add a schema registry so a future producer cannot smuggle content into the topic.`,
};
