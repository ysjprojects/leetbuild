import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Violation events with no raw text',
  concept: 'kafka',
  file: 'events',
  focus: ['guardrail', 'kafka', 'review'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it produces one
\`guardrail.violation\` event per block and the happy path lands in the review topic. It scatters one
tenant's blocks across partitions, ships the offending text to a retained topic, and drops the event
when the broker rejects the produce. Review it, fix it, and prove the fix with the checks below.

Implement \`publish_violations\` — the review path the gate calls after it decides to block.

- Every block publishes to \`guardrail.violation\` keyed by the **tenant**, so all of one tenant's
  blocks land in the same partition and reviewers read them in the order the gate produced them. The
  draft keys by \`tenant:event_id\`, which spreads one tenant's blocks across partitions and loses the
  ordering the review queue is built on.
- The payload carries **no raw content**: the rule ids that fired, the **span offsets** of the
  offending text, and a **fingerprint** (a salted hash) for correlation. The draft includes
  \`text\` "for debuggability", which copies tenant content into a retained, replicated topic — the
  one place a guardrail must never leak the prompt.
- A rejected produce must not lose the block: write an **outbox row**
  (\`insert_outbox\`/\`insertOutbox\`/\`InsertOutbox\`) in the same transaction as the verdict, and let a
  relay republish it when the broker recovers. The draft is fire-and-forget — it starts the produce
  and moves on, so a rejection disappears.
- The produce result is **observed** (\`await asyncio.gather\`, \`await Promise.all\`, an \`errgroup\`,
  \`Await.result\`, \`producer->flush\`) rather than launched and forgotten, and a produce failure is
  logged and counted instead of being raised at the gate: the verdict is already decided, and a
  broker hiccup must not turn a block into a 500.

**Failure mode the checks target.** Ordering is the subtle one: a key that includes a random uuid
looks like good hygiene — every event gets its own identity — and it is exactly what breaks the
per-tenant queue. The leak is the loud one, and the fire-and-forget produce is the quiet one: review
drops the blocks that arrive while the broker is unhappy, which is also when blocks matter most.`,
  sequence: {
    participants: ['Guardrail Service', 'guardrail.violation', 'Review Worker', 'Outbox'],
    messages: [
      {
        from: 'Guardrail Service',
        to: 'guardrail.violation',
        label: 'produce · key = tenant · acks = all',
        kind: 'sync',
      },
      {from: 'Guardrail Service', to: 'Guardrail Service', label: 'observe the produce result', kind: 'sync'},
      {from: 'Guardrail Service', to: 'Outbox', label: 'insertOutbox(violation) on rejection', kind: 'async'},
      {from: 'guardrail.violation', to: 'Review Worker', label: 'consume · per-tenant order', kind: 'async'},
      {from: 'Review Worker', to: 'Review Worker', label: 'fingerprint + spans → review entry', kind: 'sync'},
      {from: 'Outbox', to: 'guardrail.violation', label: 'relay republishes when the broker recovers', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the partition key: `key=event["tenant"]`, `key: event.tenant`, `Key: []byte(event.Tenant)`, `new ProducerRecord(VerdictTopic, event.tenant, payload)`, the key arguments of `produce`. Anything with a uuid in it scatters one tenant across partitions.',
    'Reviewers need to find the phrase without being sent the phrase: publish the `rule_ids` that fired and the `spans` as offset pairs, plus a salted `fingerprint` for correlation. The text stays in the request that already has it.',
    'Durability is the outbox: `insert_outbox`/`insertOutbox`/`InsertOutbox` in the rejection path, next to the verdict write. Then observe the produce — `await` it, join the `errgroup`, `Await.result`, `flush` — and count failures instead of raising them, because the gate has already answered.',
  ],
  checks: [
    {
      id: 'tenant-key',
      title: 'Keyed by tenant, not by a random uuid',
      detail:
        'The produce key is the tenant (`key=event["tenant"]`, `key: event.tenant`, `Key: []byte(event.Tenant)`, `ProducerRecord(topic, event.tenant, …)`), so one tenant’s blocks keep their order in one partition. The draft keys by `tenant:event_id`, where the uuid is the event’s own id.',
      match: {
        python: {all: [/key=event\["tenant"\]/], none: [/uuid/]},
        typescript: {all: [/key:\s*event\.tenant,/], none: [/event\.tenant\s*\+/]},
        go: {all: [/Key:\s*\[\]byte\(event\.Tenant\)/], none: [/uuid\./]},
        scala: {
          all: [/new ProducerRecord\[String, String\]\(VerdictTopic, event\.tenant,/],
          none: [/UUID\.randomUUID/],
        },
        cpp: {all: [/event\.tenant\.c_str\(\),\s*event\.tenant\.size\(\)/], none: [/uuid/]},
      },
    },
    {
      id: 'no-raw-text',
      title: 'The event payload carries no raw text',
      detail:
        'The payload holds a `fingerprint` instead of the offending text, so the retained topic never carries tenant content. The draft puts `text` in the event "for debuggability".',
      match: {
        python: {all: [/fingerprint/], none: [/"text"/, /raw_text/]},
        typescript: {all: [/fingerprint/], none: [/"text"/, /raw_text/]},
        go: {all: [/fingerprint/], none: [/"text"/, /raw_text/]},
        scala: {all: [/fingerprint/], none: [/"text"/, /raw_text/]},
        cpp: {all: [/fingerprint/], none: [/"text"/, /raw_text/]},
      },
    },
    {
      id: 'spans',
      title: 'Publishes rule ids and span offsets',
      detail:
        'The event names the `rule_ids` that fired and the `spans` as offset pairs, so a reviewer can locate the exact offending phrase in the text they already hold. The draft publishes neither.',
      match: {
        python: {all: [/rule_ids/, /spans/]},
        typescript: {all: [/rule_ids/, /spans/]},
        go: {all: [/rule_ids/, /spans/]},
        scala: {all: [/rule_ids/, /spans/]},
        cpp: {all: [/rule_ids/, /spans/]},
      },
    },
    {
      id: 'outbox-on-reject',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A rejected produce writes the event to the outbox instead of dropping it: `insert_outbox(` / `insertOutbox(` / `InsertOutbox(` in the rejection branch. The draft ignores the produce result, so a rejected event vanishes and the review queue never sees the block.',
      match: {
        python: {all: [/insert_outbox\(/, /except /]},
        typescript: {all: [/insertOutbox\(/, /catch\s*\(/]},
        go: {all: [/InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /case .*Exception/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
    {
      id: 'observed-produce',
      title: 'Observes the produce result instead of firing and forgetting',
      detail:
        'The produce is awaited and joined — `await asyncio.gather(`, `await Promise.all(`, an `errgroup`, `Await.result(`, `producer->flush(` — so the outbox branch is reachable. The draft launches the send and returns before it knows whether the broker took it.',
      match: {
        python: {all: [/await asyncio\.gather\(/], none: [/create_task\(/]},
        typescript: {all: [/await Promise\.all\(/], none: [/void producer\.send\(/]},
        go: {all: [/errgroup/], none: [/\bgo\s+func\(/]},
        scala: {all: [/Await\.result\(/], none: [/producer\.send\(record\)\s*\n/]},
        cpp: {all: [/->flush\(/], none: [/produce\([^;]*;\s*\n\s*\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import json
import logging
import uuid

from aiokafka import AIOKafkaProducer

logger = logging.getLogger("guardrail")

VERDICT_TOPIC = "guardrail.violation"
producer = AIOKafkaProducer(bootstrap_servers="kafka:9092")


class ViolationPublisher:
    async def _produce(self, event: dict) -> None:
        # TODO: key by the tenant alone, keep the raw text out of the payload (publish rule ids,
        # spans and a fingerprint instead), observe the produce result and write an outbox row when
        # the broker rejects it.
        payload = json.dumps(
            {
                "tenant": event["tenant"],
                "rule_ids": event["rule_ids"],
                "text": event["text"],
            }
        ).encode()
        key = f'{event["tenant"]}:{uuid.uuid4()}'.encode()
        await producer.send(VERDICT_TOPIC, key=key, value=payload)

    def publish_violations(self, events: list[dict]) -> None:
        for event in events:
            asyncio.create_task(self._produce(event))
`,
      solution: `import asyncio
import hashlib
import json
import logging
import os

from aiokafka import AIOKafkaProducer

logger = logging.getLogger("guardrail")

VERDICT_TOPIC = "guardrail.violation"
PUBLISH_TIMEOUT_S = 0.25
FINGERPRINT_SALT = os.environ["GUARDRAIL_FINGERPRINT_SALT"]

producer = AIOKafkaProducer(bootstrap_servers="kafka:9092", enable_idempotence=True, acks="all")

publish_failures_total = 0
_failures_lock = asyncio.Lock()


def fingerprint(text: str) -> str:
    """Salted hash: enough to correlate two sightings without carrying the text."""
    return hashlib.sha256((FINGERPRINT_SALT + text).encode()).hexdigest()


class ViolationPublisher:
    def __init__(self, outbox: "OutboxStore") -> None:
        self._outbox = outbox

    def _payload(self, event: dict) -> bytes:
        return json.dumps(
            {
                "tenant": event["tenant"],
                "direction": event["direction"],
                "rule_ids": event["rule_ids"],
                "spans": event["spans"],
                "fingerprint": event["fingerprint"],
            }
        ).encode()

    async def _produce(self, event: dict) -> None:
        global publish_failures_total
        payload = self._payload(event)
        try:
            await asyncio.wait_for(
                producer.send_and_wait(VERDICT_TOPIC, key=event["tenant"].encode(), value=payload),
                timeout=PUBLISH_TIMEOUT_S,
            )
        except Exception:
            # The gate has already answered: a broker rejection must not fail the check, it must
            # leave the block for the relay instead.
            self._outbox.insert_outbox(event["tenant"], event)
            async with _failures_lock:
                publish_failures_total += 1
            logger.warning("guardrail.violation produce rejected tenant=%s", event["tenant"])

    async def publish_violations(self, events: list[dict]) -> None:
        await asyncio.gather(*(self._produce(event) for event in events))
`,
    },
    typescript: {
      starter: `/** publishViolations: a model-generated draft that scatters and leaks violations. */
import {Kafka, type Producer} from 'kafkajs';

const VERDICT_TOPIC = 'guardrail.violation';

const kafka = new Kafka({clientId: 'guardrail-service', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer();

interface ViolationEvent {
  tenant: string;
  event_id: string;
  direction: string;
  rule_ids: string[];
  text: string;
}

export class ViolationPublisher {
  constructor(private readonly outbox: OutboxStore) {}

  publishViolations(events: ViolationEvent[]): void {
    // TODO: key by the tenant alone, keep the raw text out of the payload (publish rule ids, spans
    // and a fingerprint instead), observe the produce result and write an outbox row when the
    // broker rejects it.
    for (const event of events) {
      void producer.send({
        topic: VERDICT_TOPIC,
        messages: [
          {
            key: event.tenant + ':' + event.event_id,
            value: JSON.stringify({tenant: event.tenant, rule_ids: event.rule_ids, text: event.text}),
          },
        ],
      });
    }
  }
}
`,
      solution: `/** publishViolations: one keyed, text-free violation event per block, with an outbox fallback. */
import {createHash} from 'node:crypto';

import {Kafka, type Producer} from 'kafkajs';
import {pino} from 'pino';

const VERDICT_TOPIC = 'guardrail.violation';
const PUBLISH_TIMEOUT_MS = 250;

const logger = pino({name: 'guardrail-events'});

const kafka = new Kafka({clientId: 'guardrail-service', brokers: ['kafka:9092']});
const producer: Producer = kafka.producer({idempotent: true, maxInFlightRequests: 1, acks: -1});

let publishFailuresTotal = 0;

interface ViolationEvent {
  tenant: string;
  event_id: string;
  direction: string;
  rule_ids: string[];
  spans: Array<[number, number]>;
  fingerprint: string;
}

/** Salted hash: enough to correlate two sightings without carrying the text. */
function fingerprint(text: string, salt: string): string {
  return createHash('sha256').update(salt + text).digest('hex');
}

export class ViolationPublisher {
  constructor(private readonly outbox: OutboxStore) {}

  private payload(event: ViolationEvent): string {
    return JSON.stringify({
      tenant: event.tenant,
      direction: event.direction,
      rule_ids: event.rule_ids,
      spans: event.spans,
      fingerprint: event.fingerprint,
    });
  }

  private async produce(event: ViolationEvent): Promise<void> {
    try {
      await producer.send({
        topic: VERDICT_TOPIC,
        acks: -1,
        timeout: PUBLISH_TIMEOUT_MS,
        messages: [{key: event.tenant, value: this.payload(event)}],
      });
    } catch (error) {
      // The verdict is already decided: a rejection goes to the outbox for the relay, not back to
      // the caller as a 500.
      this.outbox.insertOutbox(event.tenant, event);
      publishFailuresTotal += 1;
      logger.warn({tenant: event.tenant, error}, 'guardrail.violation produce rejected');
    }
  }

  async publishViolations(events: ViolationEvent[]): Promise<void> {
    await Promise.all(events.map(event => this.produce(event)));
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
)

const verdictTopic = "guardrail.violation"

var violationWriter = &kafka.Writer{
	Addr:  kafka.TCP("kafka:9092"),
	Topic: verdictTopic,
}

type ViolationEvent struct {
	Tenant  string   \`json:"tenant"\`
	EventID string   \`json:"event_id"\`
	RuleIDs []string \`json:"rule_ids"\`
	Text    string   \`json:"text"\`
}

type ViolationPublisher struct {
	outbox OutboxStore
}

func (p *ViolationPublisher) PublishViolations(ctx context.Context, events []ViolationEvent) {
	// TODO: key by the tenant alone, keep the raw text out of the payload (publish rule ids, spans
	// and a fingerprint instead), observe the produce result and write an outbox row when the
	// broker rejects it.
	for _, event := range events {
		payload, _ := json.Marshal(event)
		key := event.Tenant + ":" + uuid.NewString()
		go func(key string, payload []byte) {
			_ = violationWriter.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: payload})
		}(key, payload)
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"time"

	"golang.org/x/sync/errgroup"
	"github.com/segmentio/kafka-go"
)

const (
	verdictTopic    = "guardrail.violation"
	publishTimeout  = 250 * time.Millisecond
)

var violationWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        verdictTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

var fingerprintSalt = os.Getenv("GUARDRAIL_FINGERPRINT_SALT")

type ViolationEvent struct {
	Tenant      string   \`json:"tenant"\`
	EventID     string   \`json:"event_id"\`
	Direction   string   \`json:"direction"\`
	RuleIDs     []string \`json:"rule_ids"\`
	Spans       [][2]int \`json:"spans"\`
	Fingerprint string   \`json:"fingerprint"\`
}

// Salted hash: enough to correlate two sightings without carrying the text.
func Fingerprint(text string) string {
	sum := sha256.Sum256([]byte(fingerprintSalt + text))
	return hex.EncodeToString(sum[:])
}

type ViolationPublisher struct {
	outbox OutboxStore
}

func (p *ViolationPublisher) PublishViolations(ctx context.Context, events []ViolationEvent) {
	g, groupCtx := errgroup.WithContext(ctx)
	for _, event := range events {
		event := event
		g.Go(func() error {
			payload, err := json.Marshal(event)
			if err != nil {
				return nil
			}
			produceCtx, cancel := context.WithTimeout(groupCtx, publishTimeout)
			defer cancel()
			if err := violationWriter.WriteMessages(produceCtx, kafka.Message{
				Key:   []byte(event.Tenant),
				Value: payload,
			}); err != nil {
				// The gate has already answered: a rejection goes to the outbox for the relay.
				p.outbox.InsertOutbox(event.Tenant, event)
				return nil
			}
			return nil
		})
	}
	_ = g.Wait()
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class ViolationEvent(
    tenant: String,
    event_id: String,
    rule_ids: List[String],
    text: String
)

object ViolationPublisher {
  val VerdictTopic = "guardrail.violation"

  val producer = {
    val props = new java.util.Properties()
    props.put("bootstrap.servers", "kafka:9092")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def publishViolations(events: List[ViolationEvent]): Unit = {
    // TODO: key by the tenant alone, keep the raw text out of the payload (publish rule ids, spans
    // and a fingerprint instead), observe the produce result and write an outbox row when the
    // broker rejects it.
    events.foreach { event =>
      val key = event.tenant + ":" + UUID.randomUUID().toString
      val payload = s"""{"tenant":"${'$'}{event.tenant}","rule_ids":[${'$'}{event.rule_ids.map(id => """ + id + """).mkString(",")}],"text":"${'$'}{event.text}"}"""
      producer.send(new ProducerRecord[String, String](VerdictTopic, key, payload))
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import scala.concurrent.duration._
import scala.concurrent.{Await, Future}
import scala.concurrent.ExecutionContext.Implicits.global

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer

final case class ViolationEvent(
    tenant: String,
    event_id: String,
    direction: String,
    rule_ids: List[String],
    spans: List[(Int, Int)],
    fingerprint: String
)

object ViolationPublisher {
  val VerdictTopic = "guardrail.violation"
  val PublishTimeoutMs = 250
  val FingerprintSalt: String = sys.env("GUARDRAIL_FINGERPRINT_SALT")

  val producer = {
    val props = new java.util.Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Salted hash: enough to correlate two sightings without carrying the text. */
  def fingerprint(text: String): String = {
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update((FingerprintSalt + text).getBytes(StandardCharsets.UTF_8))
    digest.digest.map(b => f"${'$'}b%02x").mkString
  }

  def payload(event: ViolationEvent): String = {
    val ruleIds = event.rule_ids.map(id => """ + id + """).mkString(",")
    val spans = event.spans.map { case (start, end) => s"[${'$'}start,${'$'}end]" }.mkString(",")
    s"""{"tenant":"${'$'}{event.tenant}","direction":"${'$'}{event.direction}","rule_ids":[${'$'}ruleIds],"spans":[${'$'}spans],"fingerprint":"${'$'}{event.fingerprint}"}"""
  }

  def produce(event: ViolationEvent, outbox: OutboxStore): Unit = {
    val record = new ProducerRecord[String, String](VerdictTopic, event.tenant, payload(event))
    try {
      producer.send(record).get(PublishTimeoutMs.toLong, java.util.concurrent.TimeUnit.MILLISECONDS)
    } catch {
      // The gate has already answered: a rejection goes to the outbox for the relay.
      case _: Exception => outbox.insertOutbox(event.tenant, event)
    }
  }

  def publishViolations(events: List[ViolationEvent], outbox: OutboxStore): Unit = {
    val sends: List[Future[Unit]] = events.map(event => Future(produce(event, outbox)))
    Await.result(Future.sequence(sends), (PublishTimeoutMs * 2).millis)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kVerdictTopic = "guardrail.violation";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  auto producer = std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
  return producer;
}

auto producer = make_producer();

struct ViolationEvent {
  std::string tenant;
  std::string event_id;
  std::vector<std::string> rule_ids;
  std::string text;
};

void publishViolations(const std::vector<ViolationEvent>& events) {
  // TODO: key by the tenant alone, keep the raw text out of the payload (publish rule ids, spans
  // and a fingerprint instead), observe the produce result and write an outbox row when the broker
  // rejects it.
  for (const auto& event : events) {
    const auto payload = json{{"tenant", event.tenant}, {"rule_ids", event.rule_ids}, {"text", event.text}}.dump();
    const std::string key = event.tenant + ":" + event.event_id;
    producer->produce(kVerdictTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                      const_cast<char*>(payload.data()), payload.size(), key.c_str(), key.size(), 0, nullptr);
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <future>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kVerdictTopic = "guardrail.violation";
constexpr int kPublishTimeoutMs = 250;

std::string fingerprint(const std::string& text);

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  auto producer = std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
  return producer;
}

auto producer = make_producer();
std::atomic<long> publishFailuresTotal{0};

struct ViolationEvent {
  std::string tenant;
  std::string event_id;
  std::string direction;
  std::vector<std::string> rule_ids;
  std::vector<std::pair<int, int>> spans;
  std::string fingerprint;
};

/** The payload reviewers get: rule ids, span offsets and a fingerprint — never the text. */
std::string payload(const ViolationEvent& event) {
  json spans = json::array();
  for (const auto& [start, end] : event.spans) spans.push_back(json{start, end});
  return json{{"tenant", event.tenant},
              {"direction", event.direction},
              {"rule_ids", event.rule_ids},
              {"spans", spans},
              {"fingerprint", event.fingerprint}}
      .dump();
}

void produce(const ViolationEvent& event, OutboxStore& outbox) {
  const auto body = payload(event);
  const auto err = producer->produce(kVerdictTopic, RdKafka::Topic::PARTITION_UA,
                                     RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(body.data()),
                                     body.size(), event.tenant.c_str(), event.tenant.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    // The gate has already answered: a rejection goes to the outbox for the relay.
    outbox.insertOutbox(event.tenant, event);
    publishFailuresTotal.fetch_add(1);
    return;
  }
  if (producer->flush(kPublishTimeoutMs) != RdKafka::ERR_NO_ERROR) {
    outbox.insertOutbox(event.tenant, event);
    publishFailuresTotal.fetch_add(1);
  }
}

void publishViolations(const std::vector<ViolationEvent>& events, OutboxStore& outbox) {
  std::vector<std::future<void>> inflight;
  inflight.reserve(events.size());
  for (const auto& event : events)
    inflight.push_back(std::async(std::launch::async, [&event, &outbox] { produce(event, outbox); }));
  for (auto& task : inflight) task.get();
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review the event path that feeds a review queue. The key is the subtle part: adding the event id to the key looks like good practice — unique keys, no collisions — but the partition key is a routing decision, and with a uuid in it one tenant's blocks land in different partitions and the review queue loses the order the gate produced them in. The leak is the loud part: publishing the text "for debuggability" copies tenant content into a retained, replicated topic, and a topic is the hardest place to delete data from later. The fire-and-forget produce is the quiet part: without observing the result there is no rejection branch to run, so the outbox that would have saved the block is never written. The fix is one key, one payload and one branch: key by tenant, publish rule ids, spans and a fingerprint, and put a rejected event in the outbox next to the verdict. Real systems add a relay with its own retry budget, a dead-letter topic for events the relay cannot deliver, and a review-queue consumer that dedupes on the event id so a republish does not create a second review entry.`,
};
