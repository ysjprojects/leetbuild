import type {Step} from '@/lib/types';

export const firewallEventsStep: Step = {
  id: 'firewall-events',
  title: 'ai.firewall.events and response-phase sensitive data detection',
  concept: 'kafka',
  guides: ['producing-events', 'request-boundaries'],
  file: 'events',
  focus: ['aifw', 'kafka', 'app', 'client'],
  task: `## Task

**Starting point.** The starter is \`finish(api_key, request_id, decision, response_text, started_at)\`,
step 1's last call once a decision exists: it publishes one record to \`ai.firewall.events\` with
the request id, the caller, the decision and the latency, logs a line, and returns the text the
client sees. It serves the demo and hides four flaws.

**Failure mode the checks target.** The topic is retained and replicated; the record key picks a
caller's partition. Keying by request id scatters one caller's trail; a producer at its defaults
writes a retried record twice; the model's answer in the payload or a log line is a leak with a
long tail; an unscanned response hands the asker a card number or a leaked key.

- One record per call, keyed by **\`key_hash\`**, the first 16 hex characters of the SHA-256 of the
  API key; the key itself appears nowhere. Payload: \`request_id\`, \`key_hash\`, \`action\`,
  \`score\`, \`tags\`, \`reason\`, \`latency_ms\`, \`redactions\`.
- The producer is **idempotent with \`acks=all\`** (kafka-go: \`RequireAll\` and the hash balancer).
- No user or model text in the event or the logs.
- \`redact(text)\` replaces card numbers (\`CARD_PATTERN\`: 13 to 19 digits, spaces or dashes
  between) and API keys (\`API_KEY_PATTERN\`: \`sk-\` or \`key-\` plus 20+ alphanumerics) with
  \`[REDACTED]\`; \`finish\` returns that text and counts the hits in the event as \`redactions\`.`,
  sequence: {
    participants: ['LLM app', 'aifw', 'ai.firewall.events', 'Client'],
    messages: [
      {from: 'LLM app', to: 'aifw', label: 'application response', kind: 'reply'},
      {from: 'aifw', to: 'aifw', label: 'redact(text) → text, redactions', kind: 'sync'},
      {from: 'aifw', to: 'ai.firewall.events', label: 'produce · key = key_hash · acks = all', kind: 'async'},
      {from: 'aifw', to: 'Client', label: '200 redacted text · X-Request-Id', kind: 'reply'},
    ],
  },
  hints: [
    'The dashboard shows one caller\u2019s events out of order and, after a broker hiccup, twice; a support ticket quotes a card number the assistant read back from the knowledge base.',
    'Kafka partitions by record key, so a key that changes per request scatters a caller\u2019s trail; a producer that is not idempotent writes its retry again; nothing looks at the response before it goes back.',
    'Key and `key_hash` both from `sha256(api_key)[:16]`; `enable.idempotence` with `acks=all` (`idempotent: true`, `RequireAll`); drop `text` from the event and the log; `redact` first, return its text.',
  ],
  checks: [
    {
      id: 'key-hash',
      title: 'Keyed by the API key’s SHA-256 hash',
      detail:
        'The record key and the payload’s `key_hash` are the first 16 hex characters of the SHA-256 of the API key; the key itself is not in the payload. The starter keys by the request id and writes the API key into the event.',
      match: {
        python: {all: [/sha256\(/, /\[:16\]|\[0:16\]/, /key\s*=\s*key_hash/], none: [/key\s*=\s*request_id/]},
        typescript: {
          all: [
            /createHash\(\s*['"]sha256['"]\s*\)/,
            /slice\(\s*0,\s*16\s*\)|substring\(\s*0,\s*16\s*\)/,
            /key:\s*keyHash/,
          ],
          none: [/key:\s*requestId/],
        },
        go: {
          all: [/sha256\.Sum256\(/, /\[:16\]/, /Key:\s*\[\]byte\(\s*keyHash/],
          none: [/Key:\s*\[\]byte\(\s*requestID\s*\)/],
        },
        scala: {
          all: [
            /MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/,
            /take\(\s*16\s*\)|substring\(\s*0,\s*16\s*\)/,
            /ProducerRecord(\[[^\]]*\])?\(\s*\w+\s*,\s*keyHash/,
          ],
          none: [/ProducerRecord(\[[^\]]*\])?\(\s*\w+\s*,\s*requestId/],
        },
        cpp: {
          all: [/SHA256\(/, /substr\(\s*0,\s*16\s*\)/, /keyHash\.(data|c_str)\(\)/],
          none: [/requestId\.(data|c_str)\(\)/],
        },
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured so a retried produce is written once and a leader failover loses nothing: `enable.idempotence` with `acks=all`, KafkaJS’s `idempotent: true`, librdkafka’s `enable.idempotence`. kafka-go has no idempotent mode: `RequiredAcks: kafka.RequireAll` is what it can promise. The starter leaves the producer at its defaults.',
      match: {
        python: {all: [/["']enable\.idempotence["']\s*:\s*True/, /["']acks["']\s*:\s*["']?(all|-1)["']?/]},
        typescript: {all: [/idempotent:\s*true/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/], none: [/RequiredAcks:\s*kafka\.Require(None|One)/]},
        scala: {all: [/"enable\.idempotence"\s*,\s*"true"/, /"acks"\s*,\s*"(all|-1)"/]},
        cpp: {all: [/"enable\.idempotence"\s*,\s*"true"/, /"acks"\s*,\s*"(all|-1)"/]},
      },
    },
    {
      id: 'no-text',
      title: 'No user or model text in the event or the logs',
      detail:
        'Neither the payload nor a log line carries the model’s answer, redacted or not, and no log line carries the API key itself: the event has `latency_ms` and the counts, not the text. The starter copies the response into the event and prints it.',
      match: {
        python: {all: [/latency_ms/], none: [/["']text["']\s*:/, /logger\.\w+\([^\n]*response_text/]},
        typescript: {all: [/latency_ms/], none: [/\btext:\s*responseText/, /(console|log)\.\w+\([^\n]*responseText/]},
        go: {all: [/latency_ms/], none: [/"text":/, /log\.\w+\([^\n]*responseText/]},
        scala: {all: [/latency_ms/], none: [/"text"\s*->/, /log\.\w+\([^\n]*responseText/]},
        cpp: {all: [/latency_ms/], none: [/\{"text",/, /(cerr|clog|cout)[^;]*responseText/]},
      },
    },
    {
      id: 'redact',
      title: 'Redacts card numbers and API keys before the client sees the answer',
      detail:
        '`redact(text)` applies `CARD_PATTERN` (every card length from 13 to 19 digits) and `API_KEY_PATTERN` (`sk-` and `key-` keys), replaces each hit with `[REDACTED]` and counts the hits; `finish` returns the redacted text and puts the count in the event as `redactions`. The starter returns the response untouched.',
      match: {
        python: {all: [/CARD_PATTERN/, /API_KEY_PATTERN/, /\[REDACTED\]/, /=\s*redact\(/, /["']redactions["']\s*:/]},
        typescript: {all: [/CARD_PATTERN/, /API_KEY_PATTERN/, /\[REDACTED\]/, /=\s*redact\(/, /redactions[,:\s}]/]},
        go: {all: [/cardPattern/, /apiKeyPattern/, /\[REDACTED\]/, /:=\s*redact\(/, /"redactions":/]},
        scala: {all: [/CardPattern/, /ApiKeyPattern/, /\[REDACTED\]/, /=\s*redact\(/, /"redactions"\s*->/]},
        cpp: {all: [/kCardPattern/, /kApiKeyPattern/, /\[REDACTED\]/, /=\s*redact\(/, /\{"redactions",/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging
import time

from confluent_kafka import Producer

from detect import Decision

logger = logging.getLogger("aifw")
producer = Producer({"bootstrap.servers": "kafka:9092"})

TOPIC = "ai.firewall.events"


def finish(api_key: str, request_id: str, decision: Decision, response_text: str, started_at: float) -> str:
    """Publish the decision event; return the text the client will see."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    event = {
        "request_id": request_id,
        "api_key": api_key,
        "action": decision.action,
        "score": decision.score,
        "tags": list(decision.tags),
        "reason": decision.reason,
        "latency_ms": int((time.monotonic() - started_at) * 1000),
        "text": response_text,
    }
    logger.info("event rid=%s action=%s text=%r", request_id, decision.action, response_text)
    producer.produce(TOPIC, key=request_id, value=json.dumps(event))
    producer.poll(0)
    return response_text
`,
      solution: `import hashlib
import json
import logging
import re
import time

from confluent_kafka import Producer

from detect import Decision

logger = logging.getLogger("aifw")
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)

TOPIC = "ai.firewall.events"
CARD_PATTERN = re.compile(r"\\b\\d(?:[ -]?\\d){12,18}\\b")
API_KEY_PATTERN = re.compile(r"\\b(?:sk|key)-[A-Za-z0-9]{20,}\\b")
REDACTED = "[REDACTED]"


def key_hash_of(api_key: str) -> str:
    """The record key: the API key itself never lands on a retained topic."""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def redact(text: str) -> tuple[str, int]:
    """The response with card numbers and API keys replaced, and how many were replaced."""
    text, cards = CARD_PATTERN.subn(REDACTED, text)
    text, keys = API_KEY_PATTERN.subn(REDACTED, text)
    return text, cards + keys


def finish(api_key: str, request_id: str, decision: Decision, response_text: str, started_at: float) -> str:
    """Publish the decision event; return the text the client will see."""
    cleaned, redactions = redact(response_text)
    key_hash = key_hash_of(api_key)
    event = {
        "request_id": request_id,
        "key_hash": key_hash,
        "action": decision.action,
        "score": decision.score,
        "tags": list(decision.tags),
        "reason": decision.reason,
        "latency_ms": int((time.monotonic() - started_at) * 1000),
        "redactions": redactions,
    }
    logger.info("event rid=%s key=%s action=%s redactions=%d", request_id, key_hash, decision.action, redactions)
    producer.produce(TOPIC, key=key_hash, value=json.dumps(event))
    producer.poll(0)
    return cleaned
`,
    },
    typescript: {
      starter: `/** ai.firewall.events: one record per decision, and the text the client will see. */
import {Kafka} from 'kafkajs';

import type {Decision} from './detect';

const kafka = new Kafka({clientId: 'aifw', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export const TOPIC = 'ai.firewall.events';

export async function finish(
  apiKey: string,
  requestId: string,
  decision: Decision,
  responseText: string,
  startedAt: number,
): Promise<string> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const event = {
    request_id: requestId,
    api_key: apiKey,
    action: decision.action,
    score: decision.score,
    tags: decision.tags,
    reason: decision.reason ?? '',
    latency_ms: Date.now() - startedAt,
    text: responseText,
  };
  console.log(\`event rid=\${requestId} action=\${decision.action} text=\${responseText}\`);
  await producer.send({topic: TOPIC, messages: [{key: requestId, value: JSON.stringify(event)}]});
  return responseText;
}
`,
      solution: `/** ai.firewall.events: one idempotent record per decision keyed by the key hash; the answer redacted first. */
import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import type {Decision} from './detect';

const kafka = new Kafka({clientId: 'aifw', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

export const TOPIC = 'ai.firewall.events';
const CARD_PATTERN = /\\b\\d(?:[ -]?\\d){12,18}\\b/g;
const API_KEY_PATTERN = /\\b(?:sk|key)-[A-Za-z0-9]{20,}\\b/g;
const REDACTED = '[REDACTED]';

/** The record key: the API key itself never lands on a retained topic. */
function keyHashOf(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/** The response with card numbers and API keys replaced, and how many were replaced. */
export function redact(text: string): [string, number] {
  let count = 0;
  const cleaned = text
    .replace(CARD_PATTERN, () => {
      count += 1;
      return REDACTED;
    })
    .replace(API_KEY_PATTERN, () => {
      count += 1;
      return REDACTED;
    });
  return [cleaned, count];
}

export async function finish(
  apiKey: string,
  requestId: string,
  decision: Decision,
  responseText: string,
  startedAt: number,
): Promise<string> {
  const [cleaned, redactions] = redact(responseText);
  const keyHash = keyHashOf(apiKey);
  const event = {
    request_id: requestId,
    key_hash: keyHash,
    action: decision.action,
    score: decision.score,
    tags: decision.tags,
    reason: decision.reason ?? '',
    latency_ms: Date.now() - startedAt,
    redactions,
  };
  console.log(\`event rid=\${requestId} key=\${keyHash} action=\${decision.action} redactions=\${redactions}\`);
  await producer.send({topic: TOPIC, acks: -1, messages: [{key: keyHash, value: JSON.stringify(event)}]});
  return cleaned;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

const eventsTopic = "ai.firewall.events"

var eventsWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: eventsTopic}

// finish publishes the decision event and returns the text the client will see.
func finish(ctx context.Context, apiKey, requestID string, decision Decision, responseText string, startedAt time.Time) string {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	event := map[string]any{
		"request_id": requestID,
		"api_key":    apiKey,
		"action":     decision.Action,
		"score":      decision.Score,
		"tags":       decision.Tags,
		"reason":     decision.Reason,
		"latency_ms": time.Since(startedAt).Milliseconds(),
		"text":       responseText,
	}
	log.Printf("event rid=%s action=%s text=%q", requestID, decision.Action, responseText)
	payload, _ := json.Marshal(event)
	if err := eventsWriter.WriteMessages(ctx, kafka.Message{Key: []byte(requestID), Value: payload}); err != nil {
		log.Printf("event rid=%s produce failed: %v", requestID, err)
	}
	return responseText
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"regexp"
	"time"

	"github.com/segmentio/kafka-go"
)

const eventsTopic = "ai.firewall.events"

// kafka-go has no idempotent producer: RequireAll keeps a record through a leader failover, the
// hash balancer keeps one caller's events on one partition, and a consumer de-duplicates a retried
// write on request_id.
var eventsWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventsTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

var (
	cardPattern   = regexp.MustCompile(\`\\b\\d(?:[ -]?\\d){12,18}\\b\`)
	apiKeyPattern = regexp.MustCompile(\`\\b(?:sk|key)-[A-Za-z0-9]{20,}\\b\`)
)

const redactedText = "[REDACTED]"

// keyHashOf is the record key: the API key itself never lands on a retained topic.
func keyHashOf(apiKey string) string {
	sum := sha256.Sum256([]byte(apiKey))
	return hex.EncodeToString(sum[:])[:16]
}

// redact returns the response with card numbers and API keys replaced, and how many were replaced.
func redact(text string) (string, int) {
	count := 0
	for _, pattern := range []*regexp.Regexp{cardPattern, apiKeyPattern} {
		text = pattern.ReplaceAllStringFunc(text, func(string) string {
			count++
			return redactedText
		})
	}
	return text, count
}

// finish publishes the decision event and returns the text the client will see.
func finish(ctx context.Context, apiKey, requestID string, decision Decision, responseText string, startedAt time.Time) string {
	cleaned, redactions := redact(responseText)
	keyHash := keyHashOf(apiKey)
	event := map[string]any{
		"request_id": requestID,
		"key_hash":   keyHash,
		"action":     decision.Action,
		"score":      decision.Score,
		"tags":       decision.Tags,
		"reason":     decision.Reason,
		"latency_ms": time.Since(startedAt).Milliseconds(),
		"redactions": redactions,
	}
	log.Printf("event rid=%s key=%s action=%s redactions=%d", requestID, keyHash, decision.Action, redactions)
	payload, _ := json.Marshal(event)
	if err := eventsWriter.WriteMessages(ctx, kafka.Message{Key: []byte(keyHash), Value: payload}); err != nil {
		log.Printf("event rid=%s produce failed: %v", requestID, err)
	}
	return cleaned
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._
import spray.json.DefaultJsonProtocol._

object Events {
  private val log = Logger.getLogger("aifw")
  val Topic = "ai.firewall.events"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Publishes the decision event; returns the text the client will see. */
  def finish(apiKey: String, requestId: String, decision: Decision, responseText: String, startedAt: Long): String = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val event = JsObject(
      "request_id" -> JsString(requestId),
      "api_key" -> JsString(apiKey),
      "action" -> JsString(decision.action),
      "score" -> JsNumber(decision.score),
      "tags" -> decision.tags.toJson,
      "reason" -> JsString(decision.reason),
      "latency_ms" -> JsNumber(System.currentTimeMillis() - startedAt),
      "text" -> JsString(responseText)
    )
    log.info(s"event rid=$requestId action=\${decision.action} text=$responseText")
    producer.send(new ProducerRecord(Topic, requestId, event.compactPrint))
    responseText
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._
import spray.json.DefaultJsonProtocol._

object Events {
  private val log = Logger.getLogger("aifw")
  val Topic = "ai.firewall.events"
  val CardPattern = """\\b\\d(?:[ -]?\\d){12,18}\\b""".r
  val ApiKeyPattern = """\\b(?:sk|key)-[A-Za-z0-9]{20,}\\b""".r
  val Redacted = "[REDACTED]"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** The record key: the API key itself never lands on a retained topic. */
  def keyHashOf(apiKey: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(apiKey.getBytes(StandardCharsets.UTF_8))
    digest.map("%02x".format(_)).mkString.take(16)
  }

  /** The response with card numbers and API keys replaced, and how many were replaced. */
  def redact(text: String): (String, Int) = {
    val cards = CardPattern.findAllIn(text).size
    val afterCards = CardPattern.replaceAllIn(text, Redacted)
    val keys = ApiKeyPattern.findAllIn(afterCards).size
    (ApiKeyPattern.replaceAllIn(afterCards, Redacted), cards + keys)
  }

  /** Publishes the decision event; returns the text the client will see. */
  def finish(apiKey: String, requestId: String, decision: Decision, responseText: String, startedAt: Long): String = {
    val (cleaned, redactions) = redact(responseText)
    val keyHash = keyHashOf(apiKey)
    val event = JsObject(
      "request_id" -> JsString(requestId),
      "key_hash" -> JsString(keyHash),
      "action" -> JsString(decision.action),
      "score" -> JsNumber(decision.score),
      "tags" -> decision.tags.toJson,
      "reason" -> JsString(decision.reason),
      "latency_ms" -> JsNumber(System.currentTimeMillis() - startedAt),
      "redactions" -> JsNumber(redactions)
    )
    log.info(s"event rid=$requestId key=$keyHash action=\${decision.action} redactions=$redactions")
    producer.send(new ProducerRecord(Topic, keyHash, event.compactPrint))
    cleaned
  }
}
`,
    },
    cpp: {
      starter: `// ai.firewall.events: one record per decision, and the text the client will see.
#pragma once

#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

#include "detect.cpp"

const std::string kEventsTopic = "ai.firewall.events";

inline RdKafka::Producer& events_producer() {
  static std::unique_ptr<RdKafka::Producer> producer = [] {
    std::string err;
    std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
    conf->set("bootstrap.servers", "kafka:9092", err);
    return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
  }();
  return *producer;
}

// Publishes the decision event; returns the text the client will see.
inline std::string finish(const std::string& apiKey, const std::string& requestId, const Decision& decision,
                          const std::string& responseText, std::chrono::steady_clock::time_point startedAt) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const auto latency = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - startedAt);
  const nlohmann::json event = {
      {"request_id", requestId},
      {"api_key", apiKey},
      {"action", decision.action},
      {"score", decision.score},
      {"tags", decision.tags},
      {"reason", decision.reason},
      {"latency_ms", latency.count()},
      {"text", responseText},
  };
  std::cerr << "event rid=" << requestId << " action=" << decision.action << " text=" << responseText << "\\n";
  const std::string payload = event.dump();
  const RdKafka::ErrorCode err = events_producer().produce(
      kEventsTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
      payload.size(), requestId.data(), requestId.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "event rid=" << requestId << " produce failed\\n";
  events_producer().poll(0);
  return responseText;
}
`,
      solution: `// ai.firewall.events: one idempotent record per decision keyed by the key hash; the answer redacted first.
#pragma once

#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <chrono>
#include <iomanip>
#include <iostream>
#include <memory>
#include <regex>
#include <sstream>
#include <string>
#include <utility>

#include "detect.cpp"

const std::string kEventsTopic = "ai.firewall.events";
const std::regex kCardPattern(R"(\\b\\d(?:[ -]?\\d){12,18}\\b)");
const std::regex kApiKeyPattern(R"(\\b(?:sk|key)-[A-Za-z0-9]{20,}\\b)");
const std::string kRedacted = "[REDACTED]";

inline RdKafka::Producer& events_producer() {
  static std::unique_ptr<RdKafka::Producer> producer = [] {
    std::string err;
    std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
    conf->set("bootstrap.servers", "kafka:9092", err);
    conf->set("enable.idempotence", "true", err);
    conf->set("acks", "all", err);
    return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
  }();
  return *producer;
}

// The record key: the API key itself never lands on a retained topic.
inline std::string keyHashOf(const std::string& apiKey) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(apiKey.data()), apiKey.size(), digest);
  std::ostringstream hex;
  for (unsigned char byte : digest) hex << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  return hex.str().substr(0, 16);
}

// The response with card numbers and API keys replaced, and how many were replaced.
inline std::pair<std::string, int> redact(const std::string& text) {
  int count = 0;
  std::string cleaned = text;
  for (const auto* pattern : {&kCardPattern, &kApiKeyPattern}) {
    count += static_cast<int>(
        std::distance(std::sregex_iterator(cleaned.begin(), cleaned.end(), *pattern), std::sregex_iterator()));
    cleaned = std::regex_replace(cleaned, *pattern, kRedacted);
  }
  return {cleaned, count};
}

// Publishes the decision event; returns the text the client will see.
inline std::string finish(const std::string& apiKey, const std::string& requestId, const Decision& decision,
                          const std::string& responseText, std::chrono::steady_clock::time_point startedAt) {
  const auto [cleaned, redactions] = redact(responseText);
  const std::string keyHash = keyHashOf(apiKey);
  const auto latency = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - startedAt);
  const nlohmann::json event = {
      {"request_id", requestId},
      {"key_hash", keyHash},
      {"action", decision.action},
      {"score", decision.score},
      {"tags", decision.tags},
      {"reason", decision.reason},
      {"latency_ms", latency.count()},
      {"redactions", redactions},
  };
  std::cerr << "event rid=" << requestId << " key=" << keyHash << " action=" << decision.action
            << " redactions=" << redactions << "\\n";
  const std::string payload = event.dump();
  const RdKafka::ErrorCode err = events_producer().produce(
      kEventsTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
      payload.size(), keyHash.data(), keyHash.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "event rid=" << requestId << " produce failed\\n";
  events_producer().poll(0);
  return cleaned;
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json
import logging
import time

TOPIC = "ai.firewall.events"
KEY = "key-7f3a"
KEY_HASH = hashlib.sha256(KEY.encode()).hexdigest()[:16]
ANSWER = "The zebra-pangolin tunnel opens at dawn."
LEAKY = (
    "Card 4111 1111 1111 1111 is on file, Amex 3782 822463 10005 and 4222222222222 too; old card"
    " 6011-0009-9013-9424-123 expired. Use sk-AbCdEfGhIjKlMnOpQrStUv123456 or key-ABCDEFGHIJKLMNOPQRSTUV12"
    " for the API, done."
)
REDACTED_LEAKY = (
    "Card [REDACTED] is on file, Amex [REDACTED] and [REDACTED] too; old card [REDACTED] expired."
    " Use [REDACTED] or [REDACTED] for the API, done."
)
SECRETS = ("4111", "3782", "10005", "4222222222222", "6011", "sk-AbC", "key-ABC")
FIELDS = ("request_id", "key_hash", "action", "score", "tags", "reason", "latency_ms", "redactions")


class Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


def _events(ctx):
    m = ctx.load("events")
    capture = Capture()
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(capture)
    return m, capture


def _allow():
    from detect import Decision  # step 3 declares it; events.py need not re-export it

    return Decision("allow", 90, ["travel"], "")


def _event(ctx, i=0):
    records = ctx.kafka.records(TOPIC)
    assert len(records) > i, f"the topic holds {len(records)} record(s), expected at least {i + 1} (topics: {sorted(ctx.kafka.topics)})"
    try:
        return json.loads(records[i].value), records[i]
    except ValueError:
        raise AssertionError(f"the record's value is not JSON: {records[i].value!r}")


def check_key_hash(ctx):
    m, _ = _events(ctx)
    now = time.monotonic()
    m.finish(KEY, "r-1", _allow(), ANSWER, now)
    m.finish(KEY, "r-2", _allow(), ANSWER, now)
    m.finish("key-b2c9", "r-3", _allow(), ANSWER, now)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three finish() calls produced {len(records)} records on {TOPIC}"
    keys = [(r.key or b"").decode() for r in records]
    assert keys[0] != "r-1", "the record is keyed by the request id: one caller's events scatter across partitions and a replay of one caller is a scan of the whole topic"
    assert keys[0] == KEY_HASH, f"the record key is {keys[0]!r}, expected the first 16 hex characters of the SHA-256 of the API key ({KEY_HASH})"
    assert keys[1] == KEY_HASH and keys[2] != KEY_HASH, f"keys over three calls were {keys}: the same API key must give the same key, another key another"
    assert records[0].partition == records[1].partition, "two events of one caller landed on different partitions: the key must be the same for every request of a caller"
    event, _ = _event(ctx)
    assert event.get("key_hash") == KEY_HASH, f"the payload's key_hash is {event.get('key_hash')!r}, expected {KEY_HASH}"
    assert KEY not in records[0].value.decode(), f"the API key itself is in the payload: {records[0].value!r}. Only its hash may reach a retained topic"
    missing = [f for f in FIELDS if f not in event]
    assert not missing, f"the payload lacks {missing}: {event}"


def check_idempotent_acks(ctx):
    m, _ = _events(ctx)
    ctx.kafka.lose_acks(TOPIC, 1)
    m.finish(KEY, "r-1", _allow(), ANSWER, time.monotonic())
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one finish() whose acknowledgement was lost left {len(records)} records on the topic: the producer retried and the broker wrote it again. enable.idempotence makes the retry a no-op (it needs acks=all)"
    ctx.kafka.failover(TOPIC)
    assert len(ctx.kafka.records(TOPIC)) == 1, "after a leader failover the event is gone: it was acknowledged by the leader alone, the producer needs acks=all"
    m.finish(KEY, "r-2", _allow(), ANSWER, time.monotonic())
    assert len(ctx.kafka.records(TOPIC)) == 2, "after the failover the producer must keep producing"


def _leak(text, logged):
    """The first 8-character piece of the text found in the log, or None."""
    return next((text[i : i + 8] for i in range(len(text) - 7) if text[i : i + 8] in logged), None)


def check_no_text(ctx):
    m, capture = _events(ctx)
    started = time.monotonic()
    ctx.clock.advance(0.25)
    m.finish(KEY, "r-1", _allow(), ANSWER, started)
    event, record = _event(ctx)
    assert "zebra-pangolin" not in record.value.decode(), f"the event carries the model's answer: {record.value!r}. The topic is retained and replicated; the answer stays out"
    m.finish(KEY, "r-2", _allow(), LEAKY, time.monotonic())
    logged = "\\n".join(capture.lines)
    for what, text in (("the model's answer", ANSWER), ("an answer that needed redacting, before or after", LEAKY)):
        piece = _leak(text, logged)
        assert piece is None, f"a log line carries {what} ({piece!r} of it): {logged!r}. Log the request id, the action and the counts"
    assert KEY not in logged, f"a log line carries the API key itself: {logged!r}. The key appears nowhere; its key_hash identifies the caller"
    latency = event.get("latency_ms")
    assert isinstance(latency, int) and 200 <= latency <= 2000, f"latency_ms is {latency!r} for a request started 250 ms ago, expected an integer around 250"
    assert event.get("action") == "allow" and event.get("score") == 90 and event.get("tags") == ["travel"], f"the payload must carry the decision's action, score and tags: {event}"


def check_redact(ctx):
    m, _ = _events(ctx)
    out = m.finish(KEY, "r-1", _allow(), LEAKY, time.monotonic())
    left = [s for s in SECRETS if s in out]
    assert not left, f"the response reached the client with {left} still in it: {out!r}. CARD_PATTERN covers 13 to 19 digits, API_KEY_PATTERN sk- and key- keys of any case"
    assert out == REDACTED_LEAKY, f"expected every card number and key replaced with [REDACTED] and the rest untouched: got {out!r}, expected {REDACTED_LEAKY!r}"
    event, record = _event(ctx)
    assert event.get("redactions") == 6, f"the event's redactions is {event.get('redactions')!r}, expected 6: four card numbers and two keys, one per hit"
    assert "4111" not in record.value.decode(), f"the card number is in the event: {record.value!r}"
    clean = m.finish(KEY, "r-2", _allow(), ANSWER, time.monotonic())
    assert clean == ANSWER, f"a clean answer must come through unchanged, got {clean!r}"
    event, _ = _event(ctx, 1)
    assert event.get("redactions") == 0, f"a clean answer's event has redactions {event.get('redactions')!r}, expected 0"
    dashed = m.finish(KEY, "r-3", _allow(), "Try 4111-1111-1111-1111 next.", time.monotonic())
    assert dashed == "Try [REDACTED] next.", f"a dashed card number must be redacted too, got {dashed!r}"
`,
    typescript: `import {createHash} from 'node:crypto';

const TOPIC = 'ai.firewall.events';
const KEY = 'key-7f3a';
const KEY_HASH = createHash('sha256').update(KEY).digest('hex').slice(0, 16);
const ANSWER = 'The zebra-pangolin tunnel opens at dawn.';
const LEAKY =
  'Card 4111 1111 1111 1111 is on file, Amex 3782 822463 10005 and 4222222222222 too; old card' +
  ' 6011-0009-9013-9424-123 expired. Use sk-AbCdEfGhIjKlMnOpQrStUv123456 or key-ABCDEFGHIJKLMNOPQRSTUV12' +
  ' for the API, done.';
const REDACTED_LEAKY =
  'Card [REDACTED] is on file, Amex [REDACTED] and [REDACTED] too; old card [REDACTED] expired.' +
  ' Use [REDACTED] or [REDACTED] for the API, done.';
const SECRETS = ['4111', '3782', '10005', '4222222222222', '6011', 'sk-AbC', 'key-ABC'];
const FIELDS = ['request_id', 'key_hash', 'action', 'score', 'tags', 'reason', 'latency_ms', 'redactions'];

/** The learner's module, with every console line captured. */
function events(ctx) {
  const m = ctx.load('events');
  const lines: string[] = [];
  const capture = (...args: unknown[]): void => void lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  return {m, lines};
}

const allow = () => ({action: 'allow', score: 90, tags: ['travel'], reason: ''});

function event(ctx, i = 0) {
  const records = ctx.kafka.records(TOPIC);
  assert(records.length > i, \`the topic holds \${records.length} record(s), expected at least \${i + 1}\`);
  const value = records[i].value?.toString() ?? '';
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    assert.fail(\`the record's value is not JSON: \${JSON.stringify(value)}\`);
  }
  return {event: parsed, record: records[i], value};
}

export async function check_key_hash(ctx) {
  const {m} = events(ctx);
  const now = Date.now();
  await m.finish(KEY, 'r-1', allow(), ANSWER, now);
  await m.finish(KEY, 'r-2', allow(), ANSWER, now);
  await m.finish('key-b2c9', 'r-3', allow(), ANSWER, now);
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three finish() calls produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? '');
  assert(keys[0] !== 'r-1', "the record is keyed by the request id: one caller's events scatter across partitions and a replay of one caller is a scan of the whole topic");
  assert.equal(keys[0], KEY_HASH, \`the record key is \${JSON.stringify(keys[0])}, expected the first 16 hex characters of the SHA-256 of the API key (\${KEY_HASH})\`);
  assert(keys[1] === KEY_HASH && keys[2] !== KEY_HASH, \`keys over three calls were \${JSON.stringify(keys)}: the same API key must give the same key, another key another\`);
  assert.equal(records[0].partition, records[1].partition, 'two events of one caller landed on different partitions: the key must be the same for every request of a caller');
  const {event: e, value} = event(ctx);
  assert.equal(e.key_hash, KEY_HASH, \`the payload's key_hash is \${JSON.stringify(e.key_hash)}, expected \${KEY_HASH}\`);
  assert(!value.includes(KEY), \`the API key itself is in the payload: \${value}. Only its hash may reach a retained topic\`);
  const missing = FIELDS.filter(f => !(f in e));
  assert.equal(missing.length, 0, \`the payload lacks \${JSON.stringify(missing)}: \${value}\`);
}

export async function check_idempotent_acks(ctx) {
  const {m} = events(ctx);
  ctx.kafka.loseAcks(TOPIC, 1);
  await m.finish(KEY, 'r-1', allow(), ANSWER, Date.now());
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one finish() whose acknowledgement was lost left \${records.length} records on the topic: the producer retried and the broker wrote it again. idempotent: true makes the retry a no-op (it needs acks: -1)\`);
  ctx.kafka.failover(TOPIC);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'after a leader failover the event is gone: it was acknowledged by the leader alone, the producer needs acks: -1 (all)');
  await m.finish(KEY, 'r-2', allow(), ANSWER, Date.now());
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'after the failover the producer must keep producing');
}

/** The first 8-character piece of the text found in the log, or null. */
function leak(text: string, logged: string): string | null {
  for (let i = 0; i + 8 <= text.length; i += 1) if (logged.includes(text.slice(i, i + 8))) return text.slice(i, i + 8);
  return null;
}

export async function check_no_text(ctx) {
  const {m, lines} = events(ctx);
  const started = Date.now();
  ctx.clock.advance(0.25);
  await m.finish(KEY, 'r-1', allow(), ANSWER, started);
  const {event: e, value} = event(ctx);
  assert(!value.includes('zebra-pangolin'), \`the event carries the model's answer: \${value}. The topic is retained and replicated; the answer stays out\`);
  await m.finish(KEY, 'r-2', allow(), LEAKY, Date.now());
  const logged = lines.join('\\n');
  for (const [what, text] of [["the model's answer", ANSWER], ['an answer that needed redacting, before or after', LEAKY]]) {
    const piece = leak(text, logged);
    assert(piece === null, \`a log line carries \${what} (\${JSON.stringify(piece)} of it): \${JSON.stringify(logged)}. Log the request id, the action and the counts\`);
  }
  assert(!logged.includes(KEY), \`a log line carries the API key itself: \${JSON.stringify(logged)}. The key appears nowhere; its key_hash identifies the caller\`);
  assert(Number.isInteger(e.latency_ms) && e.latency_ms >= 200 && e.latency_ms <= 2000, \`latency_ms is \${JSON.stringify(e.latency_ms)} for a request started 250 ms ago, expected an integer around 250\`);
  assert(e.action === 'allow' && e.score === 90 && JSON.stringify(e.tags) === '["travel"]', \`the payload must carry the decision's action, score and tags: \${value}\`);
}

export async function check_redact(ctx) {
  const {m} = events(ctx);
  const out = await m.finish(KEY, 'r-1', allow(), LEAKY, Date.now());
  const left = SECRETS.filter(s => out.includes(s));
  assert.equal(left.length, 0, \`the response reached the client with \${JSON.stringify(left)} still in it: \${JSON.stringify(out)}. CARD_PATTERN covers 13 to 19 digits, API_KEY_PATTERN sk- and key- keys of any case\`);
  assert.equal(out, REDACTED_LEAKY, \`expected every card number and key replaced with [REDACTED] and the rest untouched: got \${JSON.stringify(out)}, expected \${JSON.stringify(REDACTED_LEAKY)}\`);
  const first = event(ctx);
  assert.equal(first.event.redactions, 6, \`the event's redactions is \${JSON.stringify(first.event.redactions)}, expected 6: four card numbers and two keys, one per hit\`);
  assert(!first.value.includes('4111'), \`the card number is in the event: \${first.value}\`);
  const clean = await m.finish(KEY, 'r-2', allow(), ANSWER, Date.now());
  assert.equal(clean, ANSWER, \`a clean answer must come through unchanged, got \${JSON.stringify(clean)}\`);
  assert.equal(event(ctx, 1).event.redactions, 0, "a clean answer's event must have redactions 0");
  const dashed = await m.finish(KEY, 'r-3', allow(), 'Try 4111-1111-1111-1111 next.', Date.now());
  assert.equal(dashed, 'Try [REDACTED] next.', \`a dashed card number must be redacted too, got \${JSON.stringify(dashed)}\`);
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"strings"
	"time"

	"leetbuild/harness"
)

const (
	eventsTopicName = "ai.firewall.events"
	eventsKey       = "key-7f3a"
	eventsAnswer    = "The zebra-pangolin tunnel opens at dawn."
	eventsLeaky     = "Card 4111 1111 1111 1111 is on file, Amex 3782 822463 10005 and 4222222222222 too; old card" +
		" 6011-0009-9013-9424-123 expired. Use sk-AbCdEfGhIjKlMnOpQrStUv123456 or key-ABCDEFGHIJKLMNOPQRSTUV12" +
		" for the API, done."
	eventsRedactedLeaky = "Card [REDACTED] is on file, Amex [REDACTED] and [REDACTED] too; old card [REDACTED] expired." +
		" Use [REDACTED] or [REDACTED] for the API, done."
)

var eventsSecrets = []string{"4111", "3782", "10005", "4222222222222", "6011", "sk-AbC", "key-ABC"}

var eventsFields = []string{"request_id", "key_hash", "action", "score", "tags", "reason", "latency_ms", "redactions"}

func eventsKeyHash() string {
	sum := sha256.Sum256([]byte(eventsKey))
	return hex.EncodeToString(sum[:])[:16]
}

// Decision is the firewall's verdict on one prompt, as detect.go (step 3) declares it: the Go
// runtime compiles one step's file at a time, so the harness carries the type here.
type Decision struct {
	Action string
	Score  int32
	Tags   []string
	Reason string
}

func allowDecision() Decision { return Decision{Action: "allow", Score: 90, Tags: []string{"travel"}} }

// eventAt is the i-th record's payload.
func eventAt(ctx *harness.Ctx, i int) (map[string]any, harness.KafkaRecord) {
	records := ctx.Kafka.Records(eventsTopicName)
	ctx.Assert(len(records) > i, "the topic holds %d record(s), expected at least %d (topics: %v)", len(records), i+1, ctx.Kafka.Topics())
	var event map[string]any
	ctx.NoError(json.Unmarshal(records[i].Value, &event), "the record's value is not JSON: %s", records[i].Value)
	return event, records[i]
}

func CheckKeyHash(ctx *harness.Ctx) {
	now := time.Now()
	finish(context.Background(), eventsKey, "r-1", allowDecision(), eventsAnswer, now)
	finish(context.Background(), eventsKey, "r-2", allowDecision(), eventsAnswer, now)
	finish(context.Background(), "key-b2c9", "r-3", allowDecision(), eventsAnswer, now)
	records := ctx.Kafka.Records(eventsTopicName)
	ctx.Equal(len(records), 3, "three finish() calls must produce three records on %s; the records", eventsTopicName)
	keys := ctx.Kafka.Keys(eventsTopicName)
	ctx.Assert(keys[0] != "r-1", "the record is keyed by the request id: one caller's events scatter across partitions and a replay of one caller is a scan of the whole topic")
	ctx.Equal(keys[0], eventsKeyHash(), "the record key must be the first 16 hex characters of the SHA-256 of the API key")
	ctx.Assert(keys[1] == eventsKeyHash() && keys[2] != eventsKeyHash(), "keys over three calls were %q: the same API key must give the same key, another key another", keys)
	ctx.Equal(records[0].Partition, records[1].Partition, "two events of one caller landed on different partitions: the key must be the same for every request of a caller, and the writer needs Balancer: &kafka.Hash{} (kafka-go's default is round robin); k1's partitions")
	event, record := eventAt(ctx, 0)
	ctx.Equal(event["key_hash"], eventsKeyHash(), "the payload's key_hash")
	ctx.Assert(!strings.Contains(string(record.Value), eventsKey), "the API key itself is in the payload: %s. Only its hash may reach a retained topic", record.Value)
	var missing []string
	for _, f := range eventsFields {
		if _, ok := event[f]; !ok {
			missing = append(missing, f)
		}
	}
	ctx.Assert(len(missing) == 0, "the payload lacks %v: %s", missing, record.Value)
}

func CheckIdempotentAcks(ctx *harness.Ctx) {
	finish(context.Background(), eventsKey, "r-1", allowDecision(), eventsAnswer, time.Now())
	ctx.Equal(len(ctx.Kafka.Records(eventsTopicName)), 1, "one finish() must leave one record; the records")
	lost := ctx.Kafka.Failover(eventsTopicName)
	ctx.Assert(lost == 0 && len(ctx.Kafka.Records(eventsTopicName)) == 1, "after a leader failover the event is gone: it was acknowledged by nobody or the leader alone (kafka-go's default RequiredAcks is RequireNone), the writer needs RequiredAcks: kafka.RequireAll")
	finish(context.Background(), eventsKey, "r-2", allowDecision(), eventsAnswer, time.Now())
	ctx.Equal(len(ctx.Kafka.Records(eventsTopicName)), 2, "after the failover the writer must keep producing; the records")
}

// textLeak is the first 8-byte piece of text found in the log, or "".
func textLeak(text, logged string) string {
	for i := 0; i+8 <= len(text); i++ {
		if strings.Contains(logged, text[i:i+8]) {
			return text[i : i+8]
		}
	}
	return ""
}

func CheckNoText(ctx *harness.Ctx) {
	var logged bytes.Buffer
	log.SetOutput(&logged)
	started := time.Now()
	ctx.Clock.Advance(0.25)
	finish(context.Background(), eventsKey, "r-1", allowDecision(), eventsAnswer, started)
	event, record := eventAt(ctx, 0)
	ctx.Assert(!strings.Contains(string(record.Value), "zebra-pangolin"), "the event carries the model's answer: %s. The topic is retained and replicated; the answer stays out", record.Value)
	finish(context.Background(), eventsKey, "r-2", allowDecision(), eventsLeaky, time.Now())
	for _, tc := range []struct{ what, text string }{{"the model's answer", eventsAnswer}, {"an answer that needed redacting, before or after", eventsLeaky}} {
		piece := textLeak(tc.text, logged.String())
		ctx.Assert(piece == "", "a log line carries %s (%q of it): %q. Log the request id, the action and the counts", tc.what, piece, logged.String())
	}
	ctx.Assert(!strings.Contains(logged.String(), eventsKey), "a log line carries the API key itself: %q. The key appears nowhere; its key_hash identifies the caller", logged.String())
	latency, _ := event["latency_ms"].(float64)
	ctx.Assert(latency >= 200 && latency <= 2000, "latency_ms is %v for a request started 250 ms ago, expected around 250", event["latency_ms"])
	ctx.Assert(event["action"] == "allow" && event["score"] == float64(90), "the payload must carry the decision's action and score: %s", record.Value)
	ctx.Equal(event["tags"], []any{"travel"}, "the payload's tags")
}

func CheckRedact(ctx *harness.Ctx) {
	out := finish(context.Background(), eventsKey, "r-1", allowDecision(), eventsLeaky, time.Now())
	var left []string
	for _, secret := range eventsSecrets {
		if strings.Contains(out, secret) {
			left = append(left, secret)
		}
	}
	ctx.Assert(len(left) == 0, "the response reached the client with %q still in it: %q. cardPattern covers 13 to 19 digits, apiKeyPattern sk- and key- keys of any case", left, out)
	ctx.Equal(out, eventsRedactedLeaky, "the response (every card number and key replaced with [REDACTED], the rest untouched)")
	event, record := eventAt(ctx, 0)
	ctx.Equal(event["redactions"], 6, "the event's redactions (four card numbers and two keys, one per hit)")
	ctx.Assert(!strings.Contains(string(record.Value), "4111"), "the card number is in the event: %s", record.Value)
	clean := finish(context.Background(), eventsKey, "r-2", allowDecision(), eventsAnswer, time.Now())
	ctx.Equal(clean, eventsAnswer, "a clean answer must come through unchanged")
	event, _ = eventAt(ctx, 1)
	ctx.Equal(event["redactions"], 0, "a clean answer's event's redactions")
	dashed := finish(context.Background(), eventsKey, "r-3", allowDecision(), "Try 4111-1111-1111-1111 next.", time.Now())
	ctx.Equal(dashed, "Try [REDACTED] next.", "a dashed card number must be redacted too")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>
#include <openssl/sha.h>

#include <chrono>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

const std::string kEventsTopicName = "ai.firewall.events";
const std::string kEventsKey = "key-7f3a";
const std::string kEventsAnswer = "The zebra-pangolin tunnel opens at dawn.";
const std::string kEventsLeaky =
    "Card 4111 1111 1111 1111 is on file, Amex 3782 822463 10005 and 4222222222222 too; old card"
    " 6011-0009-9013-9424-123 expired. Use sk-AbCdEfGhIjKlMnOpQrStUv123456 or key-ABCDEFGHIJKLMNOPQRSTUV12"
    " for the API, done.";
const std::string kEventsRedactedLeaky =
    "Card [REDACTED] is on file, Amex [REDACTED] and [REDACTED] too; old card [REDACTED] expired."
    " Use [REDACTED] or [REDACTED] for the API, done.";
const std::vector<std::string> kEventsSecrets = {"4111", "3782", "10005", "4222222222222", "6011", "sk-AbC", "key-ABC"};
const std::vector<std::string> kEventsFields = {"request_id", "key_hash", "action", "score",
                                                "tags",       "reason",   "latency_ms", "redactions"};

std::string eventsKeyHash() {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(kEventsKey.data()), kEventsKey.size(), digest);
  std::ostringstream hex;
  for (unsigned char byte : digest) hex << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  return hex.str().substr(0, 16);
}

Decision allowDecision() { return Decision{"allow", 90, {"travel"}, ""}; }

// The first 8-byte piece of text found in the log, or "".
std::string textLeak(const std::string& text, const std::string& logged) {
  for (size_t i = 0; i + 8 <= text.size(); i++) {
    if (logged.find(text.substr(i, 8)) != std::string::npos) return text.substr(i, 8);
  }
  return "";
}

// The i-th record's payload.
std::pair<nlohmann::json, harness::KafkaRecord> eventAt(harness::Ctx& ctx, size_t i) {
  const auto records = ctx.Kafka.Records(kEventsTopicName);
  ctx.Assert(records.size() > i, "the topic holds %d record(s), expected at least %d (topics: %v)", records.size(), i + 1,
             ctx.Kafka.Topics());
  nlohmann::json event = nlohmann::json::parse(records[i].Value.value_or(""), nullptr, false);
  ctx.Assert(event.is_object(), "the record's value is not JSON: %s", records[i].Value.value_or(""));
  return {event, records[i]};
}

// Everything the learner writes to cerr, clog or cout while alive.
struct CaptureLogs {
  std::ostringstream lines;
  std::streambuf* err;
  std::streambuf* clg;
  std::streambuf* out;
  CaptureLogs() : err(std::cerr.rdbuf(lines.rdbuf())), clg(std::clog.rdbuf(lines.rdbuf())), out(std::cout.rdbuf(lines.rdbuf())) {}
  ~CaptureLogs() {
    std::cerr.rdbuf(err);
    std::clog.rdbuf(clg);
    std::cout.rdbuf(out);
  }
};

}  // namespace

void CheckKeyHash(harness::Ctx& ctx) {
  const auto now = std::chrono::steady_clock::now();
  finish(kEventsKey, "r-1", allowDecision(), kEventsAnswer, now);
  finish(kEventsKey, "r-2", allowDecision(), kEventsAnswer, now);
  finish("key-b2c9", "r-3", allowDecision(), kEventsAnswer, now);
  const auto records = ctx.Kafka.Records(kEventsTopicName);
  ctx.Equal(records.size(), 3, "three finish() calls must produce three records on %s; the records", kEventsTopicName);
  const auto keys = ctx.Kafka.Keys(kEventsTopicName);
  ctx.Assert(keys[0] != "r-1",
             "the record is keyed by the request id: one caller's events scatter across partitions and a replay of one "
             "caller is a scan of the whole topic");
  ctx.Equal(keys[0], eventsKeyHash(), "the record key must be the first 16 hex characters of the SHA-256 of the API key");
  ctx.Assert(keys[1] == eventsKeyHash() && keys[2] != eventsKeyHash(),
             "keys over three calls were %q: the same API key must give the same key, another key another", keys);
  ctx.Equal(records[0].Partition, records[1].Partition,
            "two events of one caller landed on different partitions: the key must be the same for every request of a "
            "caller; k1's partitions");
  const auto [event, record] = eventAt(ctx, 0);
  ctx.Equal(event.value("key_hash", ""), eventsKeyHash(), "the payload's key_hash");
  ctx.Assert(record.Value.value_or("").find(kEventsKey) == std::string::npos,
             "the API key itself is in the payload: %s. Only its hash may reach a retained topic", record.Value.value_or(""));
  std::vector<std::string> missing;
  for (const auto& f : kEventsFields)
    if (!event.contains(f)) missing.push_back(f);
  ctx.Assert(missing.empty(), "the payload lacks %v: %s", missing, record.Value.value_or(""));
}

void CheckIdempotentAcks(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopicName, 1);
  finish(kEventsKey, "r-1", allowDecision(), kEventsAnswer, std::chrono::steady_clock::now());
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopicName).size(), 1,
            "one finish() whose acknowledgement was lost must leave one record on the topic: the producer retried and "
            "the broker wrote it again, enable.idempotence makes the retry a no-op (it needs acks=all); the records");
  ctx.Kafka.Failover(kEventsTopicName);
  ctx.Equal(ctx.Kafka.Records(kEventsTopicName).size(), 1,
            "after a leader failover the event is gone: it was acknowledged by the leader alone, the producer needs "
            "acks=all; the records");
  finish(kEventsKey, "r-2", allowDecision(), kEventsAnswer, std::chrono::steady_clock::now());
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopicName).size(), 2, "after the failover the producer must keep producing; the records");
}

void CheckNoText(harness::Ctx& ctx) {
  const auto started = std::chrono::steady_clock::now();
  ctx.Clock.Advance(0.25);
  std::string logged;
  {
    CaptureLogs capture;
    finish(kEventsKey, "r-1", allowDecision(), kEventsAnswer, started);
    finish(kEventsKey, "r-2", allowDecision(), kEventsLeaky, std::chrono::steady_clock::now());
    logged = capture.lines.str();
  }
  const auto [event, record] = eventAt(ctx, 0);
  ctx.Assert(record.Value.value_or("").find("zebra-pangolin") == std::string::npos,
             "the event carries the model's answer: %s. The topic is retained and replicated; the answer stays out",
             record.Value.value_or(""));
  const std::pair<std::string, std::string> texts[] = {
      {"the model's answer", kEventsAnswer}, {"an answer that needed redacting, before or after", kEventsLeaky}};
  for (const auto& [what, text] : texts) {
    const std::string piece = textLeak(text, logged);
    ctx.Assert(piece.empty(), "a log line carries %s (%q of it): %q. Log the request id, the action and the counts", what,
               piece, logged);
  }
  ctx.Assert(logged.find(kEventsKey) == std::string::npos,
             "a log line carries the API key itself: %q. The key appears nowhere; its key_hash identifies the caller",
             logged);
  const double latency = event.value("latency_ms", -1.0);
  ctx.Assert(latency >= 200 && latency <= 2000, "latency_ms is %v for a request started 250 ms ago, expected around 250",
             latency);
  ctx.Assert(event.value("action", "") == "allow" && event.value("score", 0) == 90,
             "the payload must carry the decision's action and score: %s", record.Value.value_or(""));
  ctx.Equal(event.contains("tags") ? event["tags"] : nlohmann::json(), nlohmann::json::array({"travel"}),
            "the payload's tags");
}

void CheckRedact(harness::Ctx& ctx) {
  const std::string out = finish(kEventsKey, "r-1", allowDecision(), kEventsLeaky, std::chrono::steady_clock::now());
  std::vector<std::string> left;
  for (const auto& secret : kEventsSecrets)
    if (out.find(secret) != std::string::npos) left.push_back(secret);
  ctx.Assert(left.empty(),
             "the response reached the client with %v still in it: %q. kCardPattern covers 13 to 19 digits, "
             "kApiKeyPattern sk- and key- keys of any case",
             left, out);
  ctx.Equal(out, kEventsRedactedLeaky,
            "the response (every card number and key replaced with [REDACTED], the rest untouched)");
  const auto [event, record] = eventAt(ctx, 0);
  ctx.Equal(event.value("redactions", -1), 6, "the event's redactions (four card numbers and two keys, one per hit)");
  ctx.Assert(record.Value.value_or("").find("4111") == std::string::npos, "the card number is in the event: %s",
             record.Value.value_or(""));
  const std::string clean = finish(kEventsKey, "r-2", allowDecision(), kEventsAnswer, std::chrono::steady_clock::now());
  ctx.Equal(clean, kEventsAnswer, "a clean answer must come through unchanged");
  ctx.Equal(eventAt(ctx, 1).first.value("redactions", -1), 0, "a clean answer's event's redactions");
  const std::string dashed =
      finish(kEventsKey, "r-3", allowDecision(), "Try 4111-1111-1111-1111 next.", std::chrono::steady_clock::now());
  ctx.Equal(dashed, "Try [REDACTED] next.", "a dashed card number must be redacted too");
}
`,
  },
  debrief: `The record key does two jobs at once, which is why the fix hashes the API key rather than picking any unique value: it keeps one caller's events on one partition, in order, and it keeps the key itself off a topic that is replicated and kept for months. Idempotence is producer configuration because the producer is the only party that knows a write is a retry. The redaction happens in \`finish\` because that is the last point before the bytes leave: a scan anywhere earlier misses what the model composes. Production firewalls match far more than two patterns (Cloudflare's managed ruleset covers card numbers, SSNs and credentials, plus custom fingerprints), and they decide per application whether a hit is redacted, blocked or only logged.`,
};
