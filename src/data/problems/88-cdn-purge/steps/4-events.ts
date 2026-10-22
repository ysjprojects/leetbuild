import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Purge events keyed by domain, deduped per path',
  concept: 'kafka',
  file: 'events',
  focus: ['purge', 'kafka', 'consumer'],
  task: `## Task

**Review premise.** The starter loops over the outcomes and produces one message per path. It
works against a healthy broker, and it gets three things wrong that only matter later: in the
partition assignment, in the meaning of the event, and on the day the broker is down. Review it
like the owner of the topic, fix it, and prove the fix with the checks below.

Publish the provider's outcomes to \`cdn.purged\`:

- **One event per \`(purge_id, path)\`.** The event carries \`id\`, \`purge_id\`, \`domain\`,
  \`path_digest\`, \`outcome\` and \`state\`. The path itself is not published: \`path_digest\`
  (\`sha256\`) is the identity a consumer matches against an edge log line, and a retained,
  replicated topic is the wrong place for a customer's URLs.
- **The key is the domain.** Kafka orders within a partition, so keying by domain keeps one
  domain's purge history in order — the difference between a projector that sees
  \`accepted → confirmed\` and one that sees them shuffled. Keying by the requester scatters one
  domain's purges across partitions and reorders them.
- **Only confirmed outcomes are published.** \`state\` is \`confirmed\`: the event is emitted once
  the provider has propagated the purge, which is the fact the projector and the status endpoint
  need. A \`requested\` event describes an intention, and a consumer that builds purge state from
  intentions will report a domain clean while edges still serve stale content.
- **Per-path dedupe, and an idempotent producer.** Each path publishes at most once per purge (the
  \`(purge_id, digest)\` id is the dedupe key), and the producer is configured with
  \`enable.idempotence\`/\`acks=all\` (Go: \`RequireAll\` with a hash balancer) so an internal retry
  cannot duplicate the record inside the topic.
- **A rejected produce goes to the outbox.** If the broker refuses the message, the event is
  written to the outbox (\`insert_outbox\`) for a relay to republish. A broker outage must not erase
  a purge record: otherwise the domain looks unpurged in the projector forever, and no one can
  prove the purge happened.

:::widget kafka-partitions {"partitions": 8}

:::widget outbox {}

**Failure mode the checks target.** Keying by requester loses per-domain ordering, so the ops
projector can apply \`confirmed\` before \`accepted\` and show a domain as clean when it is not.
Publishing \`requested\` makes the topic a log of intentions instead of results. And skipping the
outbox turns a broker hiccup into a silently lost purge: the purge happened on the CDN, the
provider says so, and nothing durable records it.`,
  sequence: {
    participants: ['Purge API', 'cdn.purged', 'ops projector'],
    messages: [
      {from: 'Purge API', to: 'Purge API', label: 'outcomes from the provider client', kind: 'sync'},
      {from: 'Purge API', to: 'Purge API', label: 'path_digest · id = purge:purge_id:digest', kind: 'sync'},
      {from: 'Purge API', to: 'cdn.purged', label: 'produce key = domain · state = confirmed', kind: 'async'},
      {from: 'Purge API', to: 'cdn.purged', label: 'broker refuses → insert_outbox(domain, event)', kind: 'async'},
      {from: 'cdn.purged', to: 'ops projector', label: 'consume in domain order', kind: 'async'},
      {from: 'ops projector', to: 'Purge API', label: 'GET /v1/purges/{id} reads confirmed state', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'domain-key',
      title: 'The message key is the domain',
      detail:
        'Every produce passes the domain as the key (`key=domain`, `Key: []byte(domain)`, `ProducerRecord(topic, domain, …)`), so one domain’s purge history stays ordered. The draft keys by the requester.',
      match: {
        python: {all: [/cdn\.purged/, /key=body\.domain/]},
        typescript: {all: [/cdn\.purged/, /key: body\.domain/]},
        go: {all: [/cdn\.purged/, /Key: \[\]byte\(body\.Domain\)/]},
        scala: {all: [/cdn\.purged/, /ProducerRecord\([^)]*domain/]},
        cpp: {all: [/kPurgeTopic/, /domain\.data\(\)/]},
      },
    },
    {
      id: 'confirmed-only',
      title: 'Publishes the confirmed outcome, never the request',
      detail:
        'The event state is `confirmed`, so consumers and the status endpoint learn what propagated rather than what was asked for. The draft publishes `state: "requested"`, which makes the topic a log of intentions.',
      match: {
        python: {all: [/STATE_CONFIRMED/], none: [/["']requested["']/]},
        typescript: {all: [/STATE_CONFIRMED/], none: [/['"]requested['"]/]},
        go: {all: [/stateConfirmed/], none: [/"requested"/]},
        scala: {all: [/StateConfirmed/], none: [/"requested"/]},
        cpp: {all: [/kStateConfirmed/], none: [/"requested"/]},
      },
    },
    {
      id: 'path-digest',
      title: 'Carries a per-path digest instead of the URL',
      detail:
        'Each event identifies its path by `path_digest` — a `sha256` digest — so the topic never carries customer URLs while consumers can still match a purge to an edge log line. The draft publishes the raw path.',
      match: {
        python: {all: [/hashlib\.sha256/, /path_digest\(/]},
        typescript: {all: [/createHash\('sha256'\)/, /pathDigest\(/]},
        go: {all: [/sha256\.Sum256/, /pathDigest\(/]},
        scala: {all: [/MessageDigest\.getInstance\("SHA-256"\)/, /pathDigest\(/]},
        cpp: {all: [/SHA256/, /pathDigest\(/]},
      },
    },
    {
      id: 'dedupe-per-path',
      title: 'One event per path per purge, from an idempotent producer',
      detail:
        'A `(purge_id, digest)` id is published once — the `published` set collapses repeats — and the producer is configured for idempotence with `acks=all` so its own retries cannot duplicate the record. The draft produces whatever it is handed, with no dedupe key and no delivery guarantee.',
      match: {
        python: {all: [/enable\.idempotence/, /acks/, /published/]},
        typescript: {all: [/idempotent: true/, /acks: -1/, /published/]},
        go: {all: [/RequireAll/, /kafka\.Hash\{\}/, /published/]},
        scala: {all: [/enable\.idempotence/, /"acks"/, /published/]},
        cpp: {all: [/enable\.idempotence/, /acks/, /published/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused produce is recorded in the outbox',
      detail:
        'A broker rejection writes the event through `insert_outbox` so a relay republishes it: a purge record must survive an outage. The draft ignores produce errors entirely, so the purge exists only on the CDN.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /KafkaException/]},
        typescript: {all: [/store\.insertOutbox\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /if err != nil/]},
        scala: {all: [/insertOutbox\(/, /KafkaException/]},
        cpp: {all: [/insertOutbox\(/, /ERR_NO_ERROR/]},
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
producer = Producer({"bootstrap.servers": "kafka:9092"})

PURGE_TOPIC = "cdn.purged"


class PurgeOutcomes(BaseModel):
    purge_id: str
    domain: str
    requester: str
    outcomes: dict[str, str]


class OutboxStore:
    def insert_outbox(self, domain: str, event: dict) -> None:
        """One row per event the broker refused; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


@app.post("/v1/purges/{purge_id}/outcomes")
def publish(purge_id: str, body: PurgeOutcomes, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft keys by the requester instead of the domain, publishes the request rather
    # than the confirmed outcome, carries the raw path, and ignores produce failures. Review all
    # four: key = domain, state = confirmed, a per-path digest, and an outbox row when the broker
    # refuses the produce.
    for path, outcome in body.outcomes.items():
        event = {
            "id": f"purge:{purge_id}:{path}",
            "purge_id": purge_id,
            "domain": body.domain,
            "path": path,
            "outcome": outcome,
            "state": "requested",
        }
        producer.produce(PURGE_TOPIC, key=body.requester, value=json.dumps(event))
    producer.flush(2.0)
    return {"published": len(body.outcomes)}
`,
      solution: `import hashlib
import json

import redis
from confluent_kafka import Consumer, KafkaException, Producer
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

PURGE_TOPIC = "cdn.purged"
STATE_CONFIRMED = "confirmed"

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class PurgeOutcomes(BaseModel):
    purge_id: str
    domain: str
    outcomes: dict[str, str]


class OutboxStore:
    def insert_outbox(self, domain: str, event: dict) -> None:
        """One row per event the broker refused; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


def path_digest(path: str) -> str:
    """The path's identity in the topic: a retained topic should not carry customer URLs."""
    return hashlib.sha256(path.encode("utf-8")).hexdigest()


@app.post("/v1/purges/{purge_id}/outcomes")
def publish(purge_id: str, body: PurgeOutcomes, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    published: set[str] = set()
    for path, outcome in body.outcomes.items():
        digest = path_digest(path)
        event = {
            "id": f"purge:{purge_id}:{digest}",
            "purge_id": purge_id,
            "domain": body.domain,
            "tenant": tenant,
            "path_digest": digest,
            "outcome": outcome,
            "state": STATE_CONFIRMED,
        }
        if event["id"] in published:
            continue
        published.add(event["id"])
        try:
            producer.produce(PURGE_TOPIC, key=body.domain, value=json.dumps(event))
            producer.flush(2.0)
        except KafkaException:
            store.insert_outbox(body.domain, event)
    return {"published": len(published), "state": STATE_CONFIRMED}


def consume() -> None:
    """The ops projector: apply the event, then advance the offset."""
    consumer = Consumer(
        {"bootstrap.servers": "kafka:9092", "group.id": "purge-ops", "enable.auto.commit": False}
    )
    consumer.subscribe([PURGE_TOPIC])
    while True:
        message = consumer.poll(1.0)
        if message is None:
            continue
        event = json.loads(message.value())
        r.hincrby(f"purge:outcomes:{event['domain']}", event["outcome"], 1)
        consumer.commit(message)
`,
    },
    typescript: {
      starter: `/** cdn.purged: a model-generated draft that keys by requester and publishes requests. */
import Fastify from 'fastify';
import {Kafka} from 'kafkajs';

export const app = Fastify();
const kafka = new Kafka({clientId: 'cdn-purge', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

const PURGE_TOPIC = 'cdn.purged';

interface OutcomesBody {
  purge_id: string;
  domain: string;
  requester: string;
  outcomes: Record<string, string>;
}

const store = {
  async insertOutbox(domain: string, event: Record<string, unknown>): Promise<void> {
    throw new Error(\`not implemented: outbox row for \${domain} \${JSON.stringify(event)}\`);
  },
};

app.post('/v1/purges/:purgeId/outcomes', async (request, reply) => {
  // TODO: this draft keys by the requester instead of the domain, publishes the request rather
  // than the confirmed outcome, carries the raw path, and ignores produce failures. Review all
  // four: key = domain, state = confirmed, a per-path digest, and an outbox row when the broker
  // refuses the produce.
  // Fastify types route params as a generic record; this route declares :purgeId.
  const params = request.params as {purgeId: string};
  const purgeId = params.purgeId;
  const body = request.body as OutcomesBody;
  for (const [path, outcome] of Object.entries(body.outcomes)) {
    const event = {id: \`purge:\${purgeId}:\${path}\`, purge_id: purgeId, domain: body.domain, path, outcome, state: 'requested'};
    await producer.send({topic: PURGE_TOPIC, messages: [{key: body.requester, value: JSON.stringify(event)}]});
  }
  return reply.code(202).send({published: Object.keys(body.outcomes).length});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** cdn.purged: one confirmed, domain-keyed event per path; refused produces go to the outbox. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import {Kafka} from 'kafkajs';
import {Redis} from 'ioredis';

export const app = Fastify();
const kafka = new Kafka({clientId: 'cdn-purge', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();
const r = new Redis('redis://redis:6379');

const PURGE_TOPIC = 'cdn.purged';
const STATE_CONFIRMED = 'confirmed';

interface OutcomesBody {
  purge_id: string;
  domain: string;
  outcomes: Record<string, string>;
}

const store = {
  async insertOutbox(domain: string, event: Record<string, unknown>): Promise<void> {
    throw new Error(\`not implemented: outbox row for \${domain} \${JSON.stringify(event)}\`);
  },
};

function pathDigest(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

app.post('/v1/purges/:purgeId/outcomes', async (request, reply) => {
  // Fastify types route params as a generic record; this route declares :purgeId.
  const params = request.params as {purgeId: string};
  const purgeId = params.purgeId;
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as OutcomesBody;
  const published = new Set<string>();
  for (const [path, outcome] of Object.entries(body.outcomes)) {
    const digest = pathDigest(path);
    const event = {
      id: \`purge:\${purgeId}:\${digest}\`,
      purge_id: purgeId,
      domain: body.domain,
      tenant,
      path_digest: digest,
      outcome,
      state: STATE_CONFIRMED,
    };
    if (published.has(event.id)) continue;
    published.add(event.id);
    try {
      await producer.send({
        topic: PURGE_TOPIC,
        acks: -1,
        messages: [{key: body.domain, value: JSON.stringify(event)}],
      });
    } catch {
      await store.insertOutbox(body.domain, event);
    }
  }
  return reply.code(202).send({published: published.size, state: STATE_CONFIRMED});
});

export async function consume(): Promise<void> {
  const consumer = kafka.consumer({groupId: 'purge-ops'});
  await consumer.connect();
  await consumer.subscribe({topic: PURGE_TOPIC});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(message.value?.toString() ?? '{}') as {domain: string; outcome: string};
      await r.hincrby(\`purge:outcomes:\${event.domain}\`, event.outcome, 1);
      await consumer.commitOffsets([{topic, partition, offset: String(Number(message.offset) + 1)}]);
    },
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const purgeTopic = "cdn.purged"

type OutcomesRequest struct {
	PurgeID   string            \`json:"purge_id"\`
	Domain    string            \`json:"domain"\`
	Requester string            \`json:"requester"\`
	Outcomes  map[string]string \`json:"outcomes"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, domain string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

var purgeWriter = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: purgeTopic, Async: false}

func publish(ctx context.Context, purgeID string, body OutcomesRequest) error {
	// TODO: this draft keys by the requester instead of the domain, publishes the request rather
	// than the confirmed outcome, carries the raw path, and ignores produce failures. Review all
	// four: key = domain, state = confirmed, a per-path digest, and an outbox row when the broker
	// refuses the produce.
	for path, outcome := range body.Outcomes {
		event := map[string]any{
			"id":      "purge:" + purgeID + ":" + path,
			"domain":  body.Domain,
			"path":    path,
			"outcome": outcome,
			"state":   "requested",
		}
		payload, _ := json.Marshal(event)
		_ = purgeWriter.WriteMessages(ctx, kafka.Message{Key: []byte(body.Requester), Value: payload})
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

const (
	purgeTopic     = "cdn.purged"
	stateConfirmed = "confirmed"
)

type OutcomesRequest struct {
	PurgeID  string            \`json:"purge_id"\`
	Domain   string            \`json:"domain"\`
	Outcomes map[string]string \`json:"outcomes"\`
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, domain string, event map[string]any) error {
	return nil
}

var (
	store = &OutboxStore{}
	rdb   = redis.NewClient(&redis.Options{Addr: "redis:6379"})
)

// RequiredAcks=RequireAll with a hash balancer is the kafka-go equivalent of an idempotent
// producer: the broker acknowledges only once the record is replicated, and a retry of the same key
// lands on the same partition instead of duplicating across them.
var purgeWriter = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        purgeTopic,
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
	Async:        false,
}

// pathDigest is the path's identity in the topic: a retained topic should not carry customer URLs.
func pathDigest(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:])
}

func publish(ctx context.Context, purgeID string, tenant string, body OutcomesRequest) error {
	published := map[string]bool{}
	for path, outcome := range body.Outcomes {
		digest := pathDigest(path)
		event := map[string]any{
			"id":          "purge:" + purgeID + ":" + digest,
			"purge_id":    purgeID,
			"domain":      body.Domain,
			"tenant":      tenant,
			"path_digest": digest,
			"outcome":     outcome,
			"state":       stateConfirmed,
		}
		id, _ := event["id"].(string)
		if published[id] {
			continue
		}
		published[id] = true
		payload, _ := json.Marshal(event)
		if err := purgeWriter.WriteMessages(ctx, kafka.Message{Key: []byte(body.Domain), Value: payload}); err != nil {
			_ = store.InsertOutbox(ctx, body.Domain, event)
		}
	}
	return nil
}

func consume(ctx context.Context) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"kafka:9092"},
		Topic:   purgeTopic,
		GroupID: "purge-ops",
	})
	for {
		message, err := reader.FetchMessage(ctx)
		if err != nil {
			continue
		}
		var event struct {
			Domain  string \`json:"domain"\`
			Outcome string \`json:"outcome"\`
		}
		_ = json.Unmarshal(message.Value, &event)
		rdb.HIncrBy(ctx, "purge:outcomes:"+event.Domain, event.Outcome, 1)
		_ = reader.CommitMessages(ctx, message)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object PurgeEvents {
  val PurgeTopic = "cdn.purged"

  val producer = new KafkaProducer[String, String](new Properties())

  // TODO: this draft keys by the requester instead of the domain, publishes the request rather than
  // the confirmed outcome, carries the raw path, and ignores produce failures. Review all four:
  // key = domain, state = confirmed, a per-path digest, and an outbox row when the broker refuses
  // the produce.
  def publish(purgeId: String, domain: String, requester: String, outcomes: Map[String, String]): Int = {
    outcomes.foreach { case (path, outcome) =>
      val event = Map(
        "id" -> s"purge:$purgeId:$path",
        "domain" -> domain,
        "path" -> path,
        "outcome" -> outcome,
        "state" -> "requested",
      )
      producer.send(new ProducerRecord(PurgeTopic, requester, event.toJson.compactPrint))
    }
    outcomes.size
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import redis.clients.jedis.Jedis
import spray.json._

object PurgeEvents {
  val PurgeTopic = "cdn.purged"
  val StateConfirmed = "confirmed"

  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })
  val jedis = new Jedis("redis", 6379)

  // pathDigest is the path's identity in the topic: a retained topic should not carry customer URLs.
  def pathDigest(path: String): String =
    MessageDigest.getInstance("SHA-256").digest(path.getBytes("UTF-8")).map("%02x".format(_)).mkString

  def publish(purgeId: String, domain: String, outcomes: Map[String, String]): Map[String, String] = {
    val published = scala.collection.mutable.LinkedHashMap.empty[String, String]
    outcomes.foreach { case (path, outcome) =>
      val digest = pathDigest(path)
      val event = Map(
        "id" -> s"purge:$purgeId:$digest",
        "purge_id" -> purgeId,
        "domain" -> domain,
        "path_digest" -> digest,
        "outcome" -> outcome,
        "state" -> StateConfirmed,
      )
      val id = event("id")
      if (!published.contains(id)) {
        published.update(id, outcome)
        try {
          producer.send(new ProducerRecord(PurgeTopic, domain, event.toJson.compactPrint))
        } catch {
          case _: org.apache.kafka.common.KafkaException =>
            PurgeOutbox.insertOutbox(domain, event.toJson.compactPrint)
        }
      }
    }
    published.toMap
  }

  def consume(group: String): Unit = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("group.id", group)
    props.put("enable.auto.commit", "false")
    val consumer = new org.apache.kafka.clients.consumer.KafkaConsumer[String, String](props)
    consumer.subscribe(java.util.List.of(PurgeTopic))
    while (true) {
      val records = consumer.poll(java.time.Duration.ofMillis(200))
      records.forEach { record =>
        val event = record.value().parseJson.asJsObject.fields
        val domain = event("domain").convertTo[String]
        jedis.hincrBy(s"purge:outcomes:$domain", event("outcome").convertTo[String], 1L)
        consumer.commitSync()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <map>
#include <memory>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kPurgeTopic = "cdn.purged";

struct OutboxStore {
  void insertOutbox(const std::string& domain, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

// TODO: this draft keys by the requester instead of the domain, publishes the request rather than
// the confirmed outcome, carries the raw path, and ignores produce failures. Review all four:
// key = domain, state = confirmed, a per-path digest, and an outbox row when the broker refuses the
// produce.
int publish(
    const std::string& purgeId,
    const std::string& domain,
    const std::string& requester,
    const std::map<std::string, std::string>& outcomes) {
  for (const auto& entry : outcomes) {
    const json event = {
        {"id", "purge:" + purgeId + ":" + entry.first},
        {"domain", domain},
        {"path", entry.first},
        {"outcome", entry.second},
        {"state", "requested"},
    };
    const auto payload = event.dump();
    producer->produce(kPurgeTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                      const_cast<char*>(payload.data()), payload.size(), requester.data(), requester.size(), 0,
                      nullptr);
  }
  producer->flush(2000);
  return static_cast<int>(outcomes.size());
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sw/redis++/redis++.h>

#include <iomanip>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>

using json = nlohmann::json;

const std::string kPurgeTopic = "cdn.purged";
const std::string kStateConfirmed = "confirmed";

struct OutboxStore {
  void insertOutbox(const std::string& domain, const json& event);
};

OutboxStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();
std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

// pathDigest is the path's identity in the topic: a retained topic should not carry customer URLs.
std::string pathDigest(const std::string& path) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(path.data()), path.size(), digest);
  std::ostringstream out;
  for (const unsigned char byte : digest) out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  return out.str();
}

std::set<std::string> publish(
    const std::string& purgeId,
    const std::string& domain,
    const std::map<std::string, std::string>& outcomes) {
  std::set<std::string> published;
  for (const auto& entry : outcomes) {
    const auto digest = pathDigest(entry.first);
    const std::string id = "purge:" + purgeId + ":" + digest;
    if (published.count(id) > 0) continue;
    published.insert(id);
    const json event = {
        {"id", id},
        {"purge_id", purgeId},
        {"domain", domain},
        {"path_digest", digest},
        {"outcome", entry.second},
        {"state", kStateConfirmed},
    };
    const auto payload = event.dump();
    const auto error = producer->produce(kPurgeTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                         const_cast<char*>(payload.data()), payload.size(), domain.data(),
                                         domain.size(), 0, nullptr);
    if (error != RdKafka::ERR_NO_ERROR) store.insertOutbox(domain, event);
  }
  producer->flush(2000);
  return published;
}

void consume(const std::string& group) {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", group, err);
  conf->set("enable.auto.commit", "false", err);
  std::unique_ptr<RdKafka::KafkaConsumer> consumer(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({kPurgeTopic});
  while (true) {
    std::unique_ptr<RdKafka::Message> message(consumer->consume(200));
    if (message->err() != RdKafka::ERR_NO_ERROR) continue;
    const json event = json::parse(static_cast<const char*>(message->payload()),
                                   static_cast<const char*>(message->payload()) + message->len());
    redis->hincrby("purge:outcomes:" + event["domain"].get<std::string>(), event["outcome"].get<std::string>(), 1);
    consumer->commitSync();
  }
}
`,
    },
  },
  hints: [
    'The key is a routing decision, not metadata: Kafka hashes the key to a partition and preserves order only inside it. Key by the domain and one domain’s purge history is a sequence; key by the requester and the projector can apply `confirmed` before `accepted`.',
    'Publish the fact, not the intent: the event goes out after the provider confirms propagation, with `state = confirmed`. A `requested` event is a promise the topic then has to be trusted not to break.',
    'Digest the path (`sha256`) and use `(purge_id, digest)` as the dedupe id, keep one event per id, and wrap the produce in a try/catch that writes an outbox row: the topic is retained and replicated, so it should not carry URLs, and a broker outage should not be able to erase the record that a purge happened.',
  ],
  debrief: `The interviewer is checking three things a generated Kafka snippet almost always gets wrong. First, the message key is an ordering contract: partition by domain and every purge of one domain is applied in the order it happened; key by the requester and they are not. Second, an event has to state what happened, not what was asked: \`confirmed\` is the outcome the status endpoint and the projector both need, and a topic full of requests is a log nobody can act on. Third, a broker is not a database: when the produce fails, the durable path is an outbox row a relay republishes, so the outage delays the record instead of losing it. The digest is the quiet one — topics are retained and replicated, and a customer’s URLs do not belong in one when a hash answers every question the consumer has. Real platforms add a schema registry so a future producer cannot smuggle new fields in, a dead-letter topic for events no consumer can decode, and a metric on outbox depth so a stuck relay is visible.`,
};
