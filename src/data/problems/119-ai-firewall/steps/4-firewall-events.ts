import type {Step} from '@/lib/types';

export const firewallEventsStep: Step = {
  id: 'firewall-events',
  title: 'ai.firewall.events and response-phase sensitive data detection',
  concept: 'kafka',
  file: 'events',
  focus: ['aifw', 'kafka', 'app', 'client'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes one event per
decision and hands the application's answer back to the client, so the dashboard shows numbers
moving. Four production contracts are broken. Find them, fix them, and prove the fix.

\`finish(api_key, request_id, decision, response_text, started_at)\` is the last thing the proxy
does on every request: it scans the application's response, publishes the decision event and
returns the text the client will see. The source describes both halves: **Sensitive Data Detection**
on the response phase, scanning for financial data such as card numbers and for secrets such as API
keys, and every decision visible as a security event.

- Publish **exactly one** \`ai.firewall.events\` record per request, keyed by **\`key_hash\`** — the
  SHA-256 of the API key, first 16 hex characters — so one caller's events stay ordered on one
  partition and the key itself is never written to a retained topic. The payload carries
  \`request_id\`, \`key_hash\`, \`action\`, \`score\`, \`tags\`, \`reason\`, \`latency_ms\` and
  \`redactions\`.
- The producer is **idempotent with \`acks=all\`** (or the stack's equivalent), so a retried produce
  cannot duplicate a record.
- **Never** put the user's text — the request's input or the model's answer — in the event or a
  log line: the topic is retained and replicated, and outlives every retention policy the request
  pipeline has.
- **Redact before the client sees it**: \`redact(text)\` replaces card numbers
  (\`CARD_PATTERN\`, 13–19 digits with optional spaces or dashes) and API keys (\`API_KEY_PATTERN\`,
  \`sk-\` or \`key-\` followed by 20+ alphanumerics) with \`[REDACTED]\` and counts them; the count
  goes into the event as \`redactions\`.

**Failure mode the checks target.** Keying by request id scatters one caller's events across
partitions; an unconfigured producer duplicates on retry; the retained text is a data leak with a
long tail; and an unscanned response hands a card number or a leaked key straight to whoever asked
the model for it — the disclosure the source's SDD rules exist to catch.`,
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
    'The message key is the partition key and the topic is retained: hash the API key (`sha256`, first 16 hex) and use the hash as both the record key and the `key_hash` field. Keyed by request id, one caller’s events land on different partitions.',
    'Idempotence is producer configuration: `enable.idempotence=true` with `acks=all`, KafkaJS’s `idempotent: true` with `acks: -1`, or kafka-go’s `RequireAll` with a hash balancer. It needs the same key on every retry — the same fix as the key hash.',
    'Scan the response before anything else: two compiled patterns, `[REDACTED]` as the replacement, the number of hits returned alongside the text. The count is what goes in the event; the matched text never does.',
  ],
  checks: [
    {
      id: 'key-hash',
      title: 'Keyed by the API key’s SHA-256 hash',
      detail:
        'The record key and the `key_hash` field are the first 16 hex characters of the SHA-256 of the API key. The draft keys by the request id and never hashes anything.',
      match: {
        python: {all: [/sha256\(/, /key=key_hash/, /\[:16\]/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]\s*\)/, /key:\s*keyHash/, /slice\(0,\s*16\)/]},
        go: {all: [/sha256\.Sum256\(/, /Key:\s*\[\]byte\(keyHash\)/, /\[:16\]/]},
        scala: {
          all: [
            /MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/,
            /ProducerRecord\("ai\.firewall\.events",\s*keyHash/,
            /take\(16\)/,
          ],
        },
        cpp: {all: [/SHA256\(/, /keyHash\.data\(\)/, /substr\(0,\s*16\)/]},
      },
    },
    {
      id: 'idempotent-acks',
      title: 'Idempotent producer with acks=all',
      detail:
        'The producer is configured for idempotence and `acks=all` — `enable.idempotence` + `acks`, KafkaJS’s `idempotent: true` with `acks: -1`, or kafka-go’s `RequireAll` with a hash balancer. A retried produce must not duplicate the record.',
      match: {
        python: {all: [/enable\.idempotence/, /["']acks["']\s*:\s*["']all["']/]},
        typescript: {all: [/idempotent:\s*true/, /acks:\s*-1/]},
        go: {all: [/RequiredAcks:\s*kafka\.RequireAll/, /Balancer:\s*&kafka\.Hash\{\}/]},
        scala: {all: [/enable\.idempotence/, /"acks"/]},
        cpp: {all: [/enable\.idempotence/, /set\("acks",\s*"all"/]},
      },
    },
    {
      id: 'no-text',
      title: 'No user or model text in the event or the logs',
      detail:
        'Neither the event payload nor any log line carries the request’s input or the model’s answer. The draft copies the input text into the event — a leak that is retained and replicated with the topic.',
      match: {
        python: {all: [/latency_ms/], none: [/\bprompt\b/i, /["']text["']\s*:/]},
        typescript: {all: [/latency_ms/], none: [/\bprompt\b/i, /\btext:\s*responseText/]},
        go: {all: [/latency_ms/], none: [/\bprompt\b/i, /"text":/]},
        scala: {all: [/latency_ms/], none: [/\bprompt\b/i, /"text"\s*->/]},
        cpp: {all: [/latency_ms/], none: [/\bprompt\b/i, /\{"text",/]},
      },
    },
    {
      id: 'redact',
      title: 'Redacts card numbers and API keys before the client sees the answer',
      detail:
        '`redact(text)` applies `CARD_PATTERN` and `API_KEY_PATTERN`, replaces hits with `[REDACTED]` and returns the count; `finish` returns the redacted text and puts the count in the event as `redactions`. The draft returns the response untouched.',
      match: {
        python: {all: [/CARD_PATTERN/, /API_KEY_PATTERN/, /\[REDACTED\]/, /=\s*redact\(/, /["']redactions["']/]},
        typescript: {all: [/CARD_PATTERN/, /API_KEY_PATTERN/, /\[REDACTED\]/, /=\s*redact\(/, /redactions/]},
        go: {all: [/cardPattern/, /apiKeyPattern/, /\[REDACTED\]/, /:=\s*redact\(/, /"redactions"/]},
        scala: {all: [/CardPattern/, /ApiKeyPattern/, /\[REDACTED\]/, /=\s*redact\(/, /"redactions"/]},
        cpp: {all: [/kCardPattern/, /kApiKeyPattern/, /\[REDACTED\]/, /=\s*redact\(/, /"redactions"/]},
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


def finish(api_key: str, request_id: str, decision: Decision, prompt: str, response_text: str, started_at: float) -> str:
    # TODO: key by a hash of the API key instead of the request id, configure the idempotent
    # producer with acks=all, keep the user's text and the model's answer out of the event and
    # the logs, and redact card numbers and API keys from the response before returning it.
    event = {
        "request_id": request_id,
        "api_key": api_key,
        "action": decision.action,
        "score": decision.score,
        "prompt": prompt,
        "text": response_text,
    }
    logger.info("event rid=%s prompt=%r", request_id, prompt)
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
CARD_PATTERN = re.compile(r"\\b(?:\\d[ -]?){13,19}\\b")
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
    cleaned, redactions = redact(response_text)
    key_hash = key_hash_of(api_key)
    event = {
        "request_id": request_id,
        "key_hash": key_hash,
        "action": decision.action,
        "score": decision.score,
        "tags": decision.tags,
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
      starter: `/** ai.firewall.events: a model-generated draft that keys by request id and returns the answer as is. */
import {Kafka} from 'kafkajs';

import type {Decision} from './detect';

const kafka = new Kafka({clientId: 'aifw', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const TOPIC = 'ai.firewall.events';

export async function finish(
  apiKey: string,
  requestId: string,
  decision: Decision,
  prompt: string,
  responseText: string,
  startedAt: number,
): Promise<string> {
  // TODO: key by a hash of the API key instead of the request id, configure the idempotent
  // producer with acks=all, keep the user's text and the model's answer out of the event and
  // the logs, and redact card numbers and API keys from the response before returning it.
  const event = {
    request_id: requestId,
    api_key: apiKey,
    action: decision.action,
    score: decision.score,
    prompt,
    text: responseText,
  };
  console.log(\`event rid=\${requestId} prompt=\${prompt}\`);
  await producer.send({topic: TOPIC, messages: [{key: requestId, value: JSON.stringify(event)}]});
  return responseText;
}
`,
      solution: `/** ai.firewall.events: one idempotent record per request keyed by the key hash; the answer redacted first. */
import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import type {Decision} from './detect';

const kafka = new Kafka({clientId: 'aifw', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const TOPIC = 'ai.firewall.events';
const CARD_PATTERN = /\\b(?:\\d[ -]?){13,19}\\b/g;
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

var eventsWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "ai.firewall.events"}

// TODO: key by a hash of the API key instead of the request id, configure acks=all / a hash
// balancer, keep the user's text and the model's answer out of the event and the logs, and redact
// card numbers and API keys from the response before returning it.
func finish(ctx context.Context, apiKey, requestID string, decision Decision, prompt, responseText string, startedAt time.Time) string {
	event := map[string]any{
		"request_id": requestID,
		"api_key":    apiKey,
		"action":     decision.Action,
		"score":      decision.Score,
		"prompt":     prompt,
		"text":       responseText,
	}
	log.Printf("event rid=%s prompt=%q", requestID, prompt)
	payload, _ := json.Marshal(event)
	_ = eventsWriter.WriteMessages(ctx, kafka.Message{Key: []byte(requestID), Value: payload})
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

// RequiredAcks=RequireAll with a stable hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and retries of the same
// key land on the same partition instead of duplicating across them.
var eventsWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "ai.firewall.events",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

var (
	cardPattern   = regexp.MustCompile(\`\\b(?:\\d[ -]?){13,19}\\b\`)
	apiKeyPattern = regexp.MustCompile(\`\\b(?:sk|key)-[A-Za-z0-9]{20,}\\b\`)
)

const redacted = "[REDACTED]"

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
			return redacted
		})
	}
	return text, count
}

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
import spray.json._
import spray.json.DefaultJsonProtocol._

object Events {
  private val log = Logger.getLogger("aifw")
  val producer = new KafkaProducer[String, String](new Properties())
  val Topic = "ai.firewall.events"

  // TODO: key by a hash of the API key instead of the request id, configure the idempotent
  // producer with acks=all, keep the user's text and the model's answer out of the event and the
  // logs, and redact card numbers and API keys from the response before returning it.
  def finish(apiKey: String, requestId: String, decision: Decision, prompt: String, responseText: String, startedAt: Long): String = {
    val event = Map(
      "request_id" -> requestId,
      "api_key" -> apiKey,
      "action" -> decision.action,
      "score" -> decision.score.toString,
      "prompt" -> prompt,
      "text" -> responseText
    )
    log.info(s"event rid=$requestId prompt=$prompt")
    producer.send(new ProducerRecord(Topic, requestId, event.toJson.compactPrint))
    responseText
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._
import spray.json.DefaultJsonProtocol._

object Events {
  private val log = Logger.getLogger("aifw")
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val Topic = "ai.firewall.events"
  val CardPattern = """\\b(?:\\d[ -]?){13,19}\\b""".r
  val ApiKeyPattern = """\\b(?:sk|key)-[A-Za-z0-9]{20,}\\b""".r
  val Redacted = "[REDACTED]"

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
    producer.send(new ProducerRecord("ai.firewall.events", keyHash, event.compactPrint))
    cleaned
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

#include "detect.h"

using json = nlohmann::json;

const std::string kTopic = "ai.firewall.events";

std::unique_ptr<RdKafka::Producer> producer;

// TODO: key by a hash of the API key instead of the request id, configure the idempotent producer
// with acks=all, keep the user's text and the model's answer out of the event and the logs, and
// redact card numbers and API keys from the response before returning it.
std::string finish(
    const std::string& apiKey,
    const std::string& requestId,
    const Decision& decision,
    const std::string& prompt,
    const std::string& responseText,
    std::chrono::steady_clock::time_point startedAt) {
  const json event = {
      {"request_id", requestId},
      {"api_key", apiKey},
      {"action", decision.action},
      {"score", decision.score},
      {"prompt", prompt},
      {"text", responseText},
  };
  std::cerr << "event rid=" << requestId << " prompt=" << prompt << "\\n";
  const auto payload = event.dump();
  producer->produce(
      kTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      requestId.data(),
      requestId.size(),
      0,
      nullptr);
  producer->poll(0);
  return responseText;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <openssl/sha.h>

#include <chrono>
#include <iomanip>
#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <regex>
#include <sstream>
#include <string>
#include <utility>

#include "detect.h"

using json = nlohmann::json;

const std::string kTopic = "ai.firewall.events";
const std::regex kCardPattern(R"(\\b(?:\\d[ -]?){13,19}\\b)");
const std::regex kApiKeyPattern(R"(\\b(?:sk|key)-[A-Za-z0-9]{20,}\\b)");
const std::string kRedacted = "[REDACTED]";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// The record key: the API key itself never lands on a retained topic.
std::string keyHashOf(const std::string& apiKey) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(apiKey.data()), apiKey.size(), digest);
  std::ostringstream hex;
  for (unsigned char byte : digest) hex << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  return hex.str().substr(0, 16);
}

// The response with card numbers and API keys replaced, and how many were replaced.
std::pair<std::string, int> redact(const std::string& text) {
  int count = 0;
  std::string cleaned = text;
  for (const auto* pattern : {&kCardPattern, &kApiKeyPattern}) {
    count += static_cast<int>(std::distance(
        std::sregex_iterator(cleaned.begin(), cleaned.end(), *pattern), std::sregex_iterator()));
    cleaned = std::regex_replace(cleaned, *pattern, kRedacted);
  }
  return {cleaned, count};
}

std::string finish(
    const std::string& apiKey,
    const std::string& requestId,
    const Decision& decision,
    const std::string& responseText,
    std::chrono::steady_clock::time_point startedAt) {
  const auto [cleaned, redactions] = redact(responseText);
  const auto keyHash = keyHashOf(apiKey);
  const auto latency = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - startedAt);
  const json event = {
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
  const auto payload = event.dump();
  const auto err = producer->produce(
      kTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      keyHash.data(),
      keyHash.size(),
      0,
      nullptr);
  if (err != RdKafka::ERR_NO_ERROR) std::cerr << "event rid=" << requestId << " produce failed\\n";
  producer->poll(0);
  return cleaned;
}
`,
    },
  },
  debrief: `The interviewer is checking the two things a firewall owes the rest of the platform: an audit trail that can be trusted and a response the client can be given. On the trail, the message key is an ordering contract and a retention contract at once — hash the API key and one caller's events stay in order without the secret ever reaching a replicated topic; idempotence and acks=all make a retried produce a no-op instead of a duplicate; and the text stays out because a topic outlives every retention policy upstream of it. On the response, the source's Sensitive Data Detection is a scan of what the model returned for card numbers and API keys — the disclosure class in OWASP's list — and the only place to do it is before the bytes reach the client, with the count, never the match, going into the event. Real firewalls add custom fingerprints per tenant, request-phase scanning and obfuscation of the input, an outbox for events the broker rejects, and a consumer that turns the topic into the security-events dashboard.`,
};
