import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Suggestion events that carry no source code',
  concept: 'kafka',
  file: 'events',
  focus: ['assistant', 'kafka', 'consumer'],
  task: `## Task

The starter is a plausible model-generated draft: a completion is accepted and an event appears on
the topic, so the quality dashboard has something to count. The topic is the wrong shape, the
payload is the wrong content, and the producer is the wrong guarantee. Find the flaws, fix them, and
prove the fix.

\`publish_suggestion(suggestion)\` is how the completion path reports one accepted or rejected
suggestion. The event's consumers are the quality counters and, later, a training-set review.

- Publish **exactly one** \`assistant.suggestion\` event per suggestion with the **repository as the
  message key**. Partitioning by repository is what keeps one repository’s suggestions in order, so
  its accept rate can be reconciled against the suggestions themselves. The draft keys by user, so
  one repository’s signal is scattered across partitions and ordered nowhere.
- The payload carries the **outcome** (\`accepted\`/\`rejected\`), the **token counts**
  (\`prompt_tokens\`, \`completion_tokens\`) and a **fingerprint** of the completed code
  (\`code_fingerprint\`, a digest). It **never** carries the code itself and never logs it: the topic
  is retained for days and replicated, and the source a developer was writing belongs to their
  repository, not to the platform’s topic.
- The producer is **idempotent with \`acks=all\`** — \`enable.idempotence\` + \`acks\`, KafkaJS’s
  \`idempotent: true\`, required acks \`all\` with a hash balancer, \`acks: -1\` — so a retried produce
  cannot duplicate or silently drop a suggestion.
- When the broker rejects the produce, write the event to the **outbox** (\`insert_outbox\`) instead
  of dropping it: a relay republishes outbox rows when the broker recovers, and the event is the only
  record that the suggestion ever existed.
- Keep the tenant and the user id out of the payload: the per-repository counters only need the
  repository, the outcome and the counts, and a smaller payload is a smaller thing to retain.

**Failure mode the checks target.** Three independent production bugs sit behind a working demo:
the partition key destroys per-repository ordering (the counters then describe an order that never
happened), the retained topic becomes a copy of customer source code that outlives the repository it
came from, and \`acks=1\` with no outbox turns a broker hiccup into a suggestion that no counter ever
sees. The token counts matter for the same reason the fingerprint does — they are the signal without
the content.`,
  sequence: {
    participants: ['Completion path', 'assistant.suggestion', 'Quality consumer'],
    messages: [
      {from: 'Completion path', to: 'assistant.suggestion', label: 'produce · key = repo · acks = all', kind: 'sync'},
      {from: 'assistant.suggestion', to: 'Completion path', label: 'ack / broker error', kind: 'reply'},
      {
        from: 'Completion path',
        to: 'Completion path',
        label: 'insertOutbox(repo, event) when the broker rejects the produce',
        kind: 'sync',
      },
      {from: 'assistant.suggestion', to: 'Quality consumer', label: 'consume · group repo-quality', kind: 'async'},
      {from: 'Quality consumer', to: 'Quality consumer', label: 'fold outcome + counts per repo', kind: 'sync'},
      {
        from: 'Completion path',
        to: 'Completion path',
        label: 'payload: outcome, token counts, code fingerprint — never the code',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'repo-key',
      title: 'Keyed by repository, one event per suggestion',
      detail:
        'The message key is the repository, so one repository’s suggestions share a partition and stay ordered. The draft keys by user, so the same repository’s signal is scattered and its counters describe no order at all.',
      match: {
        python: {all: [/assistant\.suggestion/, /key=suggestion\.repo/]},
        typescript: {all: [/assistant\.suggestion/, /key:\s*repo/]},
        go: {all: [/assistant\.suggestion/, /Key:\s*\[\]byte\(repo\)/]},
        scala: {all: [/assistant\.suggestion/, /"assistant\.suggestion",\s*repo/]},
        cpp: {all: [/assistant\.suggestion/, /repo\.c_str\(\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and full acknowledgement — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, required acks `all` with a hash balancer. The draft takes the default `acks=1`, where a retried or lost produce silently changes the counters.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-source-text',
      title: 'Carries a code fingerprint, never the code',
      detail:
        'The event carries `code_fingerprint` (a digest of the completed text), and neither the payload nor a log line carries the code itself. The draft copies the completion into the retained topic and logs it, so customer source lives in the platform’s topic and its log pipeline.',
      match: {
        python: {all: [/code_fingerprint/, /fingerprint\(/], none: [/logger\.\w+\([^)]*code/, /"code":/]},
        typescript: {
          all: [/code_fingerprint/, /fingerprintOf\(/],
          none: [/log\.\w+\([^)]*code/, /\bcode:\s*body\.code/],
        },
        go: {all: [/code_fingerprint/, /fingerprintOf\(/], none: [/log\.\w+\([^)]*Code/, /"code":\s*body\.Code/]},
        scala: {all: [/code_fingerprint/, /fingerprint\(/], none: [/log\.info\([^)]*code/, /"code":/]},
        cpp: {
          all: [/code_fingerprint/, /fingerprint\(/],
          none: [/(std::)?(cerr|clog)[^;]*code/, /"code",\s*result\.code/],
        },
      },
    },
    {
      id: 'outbox-fallback',
      title: 'Falls back to the outbox when the produce fails',
      detail:
        'A rejected produce writes an outbox row (`store.insert_outbox`/`insertOutbox`/`InsertOutbox`) inside the error branch instead of dropping the event or failing the completion. The draft ignores the broker result entirely.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /except\s+KafkaException/]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'token-counts',
      title: 'Carries the token counts with the outcome',
      detail:
        'The event carries `prompt_tokens` and `completion_tokens` alongside the outcome, so cost and quality can be read from the topic without the text. The draft publishes only the id, the repository and the code.',
      match: {
        python: {all: [/prompt_tokens/, /completion_tokens/]},
        typescript: {all: [/prompt_tokens/, /completion_tokens/]},
        go: {all: [/PromptTokens/, /CompletionTokens/]},
        scala: {all: [/prompt_tokens/, /completion_tokens/]},
        cpp: {all: [/prompt_tokens/, /completion_tokens/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("assistant")

producer = Producer({"bootstrap.servers": "kafka:9092"})


class Suggestion(BaseModel):
    id: str
    repo: str
    user_id: str
    outcome: str
    code: str


class OutboxStore:
    def insert_outbox(self, repo: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/suggestions")
def publish_suggestion(suggestion: Suggestion) -> dict:
    # TODO: this draft keys by user, copies the completed code into the retained topic, and produces
    # with acks=1 so a broker hiccup can drop or duplicate the event.
    logger.info("suggestion repo=%s code=%r", suggestion.repo, suggestion.code)
    event = {
        "id": suggestion.id,
        "repo": suggestion.repo,
        "outcome": suggestion.outcome,
        "code": suggestion.code,
    }
    producer.produce("assistant.suggestion", key=suggestion.user_id, value=json.dumps(event))
    producer.flush()
    return {"accepted": True}
`,
      solution: `import hashlib
import json
import logging

from confluent_kafka import KafkaException, Producer
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("assistant")

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class Suggestion(BaseModel):
    id: str
    repo: str
    user_id: str
    outcome: str
    prompt_tokens: int
    completion_tokens: int
    code: str


class OutboxStore:
    def insert_outbox(self, repo: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


def fingerprint(text: str) -> str:
    """The suggestion's identity, never the suggestion: a digest of the completed text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@app.post("/v1/suggestions")
def publish_suggestion(suggestion: Suggestion) -> dict:
    event = {
        "id": suggestion.id,
        "repo": suggestion.repo,
        "outcome": suggestion.outcome,
        "prompt_tokens": suggestion.prompt_tokens,
        "completion_tokens": suggestion.completion_tokens,
        "code_fingerprint": fingerprint(suggestion.code),
    }
    try:
        producer.produce("assistant.suggestion", key=suggestion.repo, value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(suggestion.repo, event)
    logger.info(
        "suggestion repo=%s outcome=%s prompt_tokens=%d",
        suggestion.repo,
        suggestion.outcome,
        suggestion.prompt_tokens,
    )
    return {"accepted": True}
`,
    },
    typescript: {
      starter: `/** publishSuggestion: a model-generated draft that keys by user and ships the code. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'code-assistant', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Suggestion {
  id: string;
  repo: string;
  user_id: string;
  outcome: string;
  code: string;
}

app.post('/v1/suggestions', async (request, reply) => {
  // TODO: this draft keys by user, copies the completed code into the retained topic, and produces
  // with acks=1 so a broker hiccup can drop or duplicate the event.
  const body = request.body as Suggestion;
  request.log.info({repo: body.repo, code: body.code}, 'suggestion');
  const event = {id: body.id, repo: body.repo, outcome: body.outcome, code: body.code};
  await producer.send({
    topic: 'assistant.suggestion',
    messages: [{key: body.user_id, value: JSON.stringify(event)}],
  });
  return reply.code(202).send({accepted: true});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** publishSuggestion: a repository-keyed event carrying counts and a fingerprint, not the code. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'code-assistant', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

interface Suggestion {
  id: string;
  repo: string;
  user_id: string;
  outcome: 'accepted' | 'rejected';
  prompt_tokens: number;
  completion_tokens: number;
  code: string;
}

class OutboxStore {
  async insertOutbox(repo: string, event: Record<string, unknown>): Promise<void> {
    throw new Error('outbox not wired');
  }
}

const store = new OutboxStore();

function fingerprintOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

app.post('/v1/suggestions', async (request, reply) => {
  const body = request.body as Suggestion;
  const repo = body.repo;
  const event = {
    id: body.id,
    repo,
    outcome: body.outcome,
    prompt_tokens: body.prompt_tokens,
    completion_tokens: body.completion_tokens,
    code_fingerprint: fingerprintOf(body.code),
  };
  try {
    await producer.send({
      topic: 'assistant.suggestion',
      acks: -1,
      messages: [{key: repo, value: JSON.stringify(event)}],
    });
  } catch (error) {
    await store.insertOutbox(repo, event);
  }
  request.log.info({repo, outcome: body.outcome, prompt_tokens: body.prompt_tokens}, 'suggestion');
  return reply.code(202).send({accepted: true});
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

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "assistant.suggestion"}

type Suggestion struct {
	ID      string \`json:"id"\`
	Repo    string \`json:"repo"\`
	UserID  string \`json:"user_id"\`
	Outcome string \`json:"outcome"\`
	Code    string \`json:"code"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, repo string, payload []byte) error { return nil }

var store = &OutboxStore{}

func publishSuggestion(rw http.ResponseWriter, r *http.Request) {
	body := Suggestion{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this draft keys by user, copies the completed code into the retained topic, and produces
	// with acks=1 so a broker hiccup can drop or duplicate the event.
	log.Printf("suggestion repo=%s code=%q", body.Repo, body.Code)
	event := map[string]any{
		"id":      body.ID,
		"repo":    body.Repo,
		"outcome": body.Outcome,
		"code":    body.Code,
	}
	payload, _ := json.Marshal(event)
	_ = writer.WriteMessages(r.Context(), kafka.Message{Key: []byte(body.UserID), Value: payload})
	rw.WriteHeader(http.StatusAccepted)
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "assistant.suggestion",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type Suggestion struct {
	ID               string \`json:"id"\`
	Repo             string \`json:"repo"\`
	UserID           string \`json:"user_id"\`
	Outcome          string \`json:"outcome"\`
	PromptTokens     int    \`json:"prompt_tokens"\`
	CompletionTokens int    \`json:"completion_tokens"\`
	Code             string \`json:"code"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, repo string, payload []byte) error { return nil }

var store = &OutboxStore{}

func fingerprintOf(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func publishSuggestion(rw http.ResponseWriter, r *http.Request) {
	body := Suggestion{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	repo := body.Repo
	event := map[string]any{
		"id":                body.ID,
		"repo":              repo,
		"outcome":           body.Outcome,
		"prompt_tokens":     body.PromptTokens,
		"completion_tokens": body.CompletionTokens,
		"code_fingerprint":  fingerprintOf(body.Code),
	}
	payload, err := json.Marshal(event)
	if err != nil {
		http.Error(rw, "encode failed", http.StatusInternalServerError)
		return
	}
	if err := writer.WriteMessages(r.Context(), kafka.Message{Key: []byte(repo), Value: payload}); err != nil {
		store.InsertOutbox(r.Context(), repo, payload)
	}
	log.Printf("suggestion repo=%s outcome=%s prompt_tokens=%d", repo, body.Outcome, body.PromptTokens)
	rw.WriteHeader(http.StatusAccepted)
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class Suggestion(id: String, repo: String, user_id: String, outcome: String, code: String)

object Suggestions {
  val props = new java.util.Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def insertOutbox(repo: String, payload: String): Unit = ()

  def publishSuggestion(suggestion: Suggestion): Unit = {
    // TODO: this draft keys by user, copies the completed code into the retained topic, and produces
    // with acks=1 so a broker hiccup can drop or duplicate the event.
    val payload =
      s"""{"id":"\${suggestion.id}","repo":"\${suggestion.repo}","outcome":"\${suggestion.outcome}","code":"\${suggestion.code}"}"""
    producer.send(new ProducerRecord[String, String]("assistant.suggestion", suggestion.user_id, payload))
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class Suggestion(
    id: String,
    repo: String,
    user_id: String,
    outcome: String,
    prompt_tokens: Int,
    completion_tokens: Int,
    code: String
)

object Suggestions {
  val props = new java.util.Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  def insertOutbox(repo: String, payload: String): Unit = ()

  def fingerprint(text: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(text.getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString

  def publishSuggestion(suggestion: Suggestion): Unit = {
    val repo = suggestion.repo
    val payload =
      s"""{"id":"\${suggestion.id}","repo":"$repo","outcome":"\${suggestion.outcome}","prompt_tokens":\${suggestion.prompt_tokens},"completion_tokens":\${suggestion.completion_tokens},"code_fingerprint":"\${fingerprint(suggestion.code)}"}"""
    try {
      producer.send(new ProducerRecord[String, String]("assistant.suggestion", repo, payload))
      producer.flush()
    } catch {
      case _: Exception => insertOutbox(repo, payload)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

struct Suggestion {
  std::string id;
  std::string repo;
  std::string user_id;
  std::string outcome;
  std::string code;
};

struct OutboxStore {
  void insertOutbox(const std::string& repo, const std::string& payload);
};

OutboxStore store;

void publishSuggestion(RdKafka::Producer* producer, const Suggestion& result) {
  // TODO: this draft keys by user, copies the completed code into the retained topic, and produces
  // with acks=1 so a broker hiccup can drop or duplicate the event.
  const auto payload =
      json{{"id", result.id}, {"repo", result.repo}, {"outcome", result.outcome}, {"code", result.code}}.dump();
  std::cerr << "suggestion repo=" << result.repo << " code=" << result.code << "\\n";
  producer->produce(
      "assistant.suggestion",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.c_str()),
      payload.size(),
      result.user_id.c_str(),
      result.user_id.size(),
      0,
      nullptr);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

struct Suggestion {
  std::string id;
  std::string repo;
  std::string outcome;
  int prompt_tokens;
  int completion_tokens;
  std::string code;
};

struct OutboxStore {
  void insertOutbox(const std::string& repo, const std::string& payload);
};

OutboxStore store;

/** FNV-1a over the completed text: the same value in every process, unlike std::hash. */
std::string fingerprint(const std::string& text) {
  std::uint64_t hash = 14695981039346656037ULL;
  for (const unsigned char byte : text) {
    hash ^= byte;
    hash *= 1099511628211ULL;
  }
  return std::to_string(hash);
}

RdKafka::Producer* makeProducer() {
  std::string errstr;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", errstr);
  conf->set("enable.idempotence", "true", errstr);
  conf->set("acks", "all", errstr);
  return RdKafka::Producer::create(conf.get(), errstr);
}

void publishSuggestion(RdKafka::Producer* producer, const Suggestion& result) {
  const auto repo = result.repo;
  const auto payload = json{{"id", result.id},
                            {"repo", repo},
                            {"outcome", result.outcome},
                            {"prompt_tokens", result.prompt_tokens},
                            {"completion_tokens", result.completion_tokens},
                            {"code_fingerprint", fingerprint(result.code)}}
                           .dump();
  const auto error = producer->produce(
      "assistant.suggestion",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.c_str()),
      payload.size(),
      repo.c_str(),
      repo.size(),
      0,
      nullptr);
  if (error != RdKafka::ERR_NO_ERROR) store.insertOutbox(repo, payload);
  producer->flush(2000);
  std::cerr << "suggestion repo=" << repo << " outcome=" << result.outcome << "\\n";
}
`,
    },
  },
  hints: [
    'The message key is the partition key: `key=suggestion.repo`, `key: repo`, `Key: []byte(repo)`, `ProducerRecord("assistant.suggestion", repo, payload)`. Everything about per-repository ordering follows from that one argument, and the user id — the natural-looking choice — gives you the opposite.',
    'Idempotence is producer configuration: `enable.idempotence` with `acks=all`, KafkaJS’s `idempotent: true` (which wants `maxInFlightRequests: 1`) with `acks: -1`, required acks `all` plus the hash balancer. It only holds if the same message key is used on every retry, so this fix and the key fix are the same fix.',
    'The payload is the privacy boundary: `code_fingerprint` is a digest you can dedupe on and compare across releases, while the code itself may never be written to a topic that is retained and replicated. The outbox is the durability half — wrap the produce, and insert a row when the broker rejects it so a hiccup cannot lose the event.',
  ],
  debrief: `The interview question is ordering, privacy and durability on a topic you do not own, and all three are decided before the consumer exists. The partition key decides whether one repository’s suggestions arrive in the order its counters describe; the payload decides whether the platform retains a copy of customer source code with a long retention window and no repository ACL attached to it; the producer configuration and the outbox decide whether a broker hiccup loses or duplicates a signal that the quality counters depend on. The fingerprint is what makes the privacy boundary compatible with the analytics — you can still count distinct completions, join them to a user through the id, and see how a model version’s acceptance moved, without ever holding the text. Real platforms add a schema registry so a future producer cannot smuggle text into the topic, per-repository retention with an erasure path for a repository that is deleted, and a lag alarm on the quality consumer group.`,
};
