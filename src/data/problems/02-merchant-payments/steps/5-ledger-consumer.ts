import type {Step} from '@/lib/types';

// ---- 5. Effectively-once ledger consumer -------------------------------------------------------
export const ledgerConsumerStep: Step = {
  id: 'ledger-consumer',
  title: 'Post to the ledger effectively once',
  concept: 'kafka',
  file: 'ledger_consumer',
  focus: ['kafka', 'ledger', 'redis'],
  task: `## Task

The ledger turns every \`payment.captured\` event into double-entry rows. \`ledger.post(event)\` is provided
and is **not** idempotent: posting the same event twice books the money twice. The relay is at-least-once,
so duplicates *will* arrive. Implement the consumer in group **\`ledger\`** so each event is applied once:

- Disable auto-commit; offsets are committed by you, after the work.
- For every record, first claim the event: \`SET applied:{event_id} 1 NX EX 604800\` in Redis (seven days —
  longer than any replay you will ever do).
- If the SET is refused, the event was already applied: **skip** \`ledger.post\` but **still commit** the
  offset, or the duplicate is redelivered forever.
- Otherwise post, **then** commit. Order inside the loop: dedupe SET → post → commit.
- If posting throws, release the claim (DEL) and do not commit: the record comes back and is retried.

:::widget delivery-semantics {}

> "Effectively once" is at-least-once delivery plus an idempotent consumer. Kafka's own transactions give
> exactly-once only between Kafka topics; the moment a side effect lives in Redis or Postgres, dedupe is
> your job.`,
  sequence: {
    participants: ['Kafka', 'ledger', 'Redis'],
    messages: [
      {from: 'Kafka', to: 'ledger', label: 'poll → payment.captured (event_id e7, offset 5120)', kind: 'reply'},
      {from: 'ledger', to: 'Redis', label: 'SET applied:e7 1 NX EX 604800 → OK', kind: 'sync'},
      {from: 'ledger', to: 'ledger', label: 'ledger.post(event)', kind: 'sync'},
      {from: 'ledger', to: 'Kafka', label: 'commit offset 5121', kind: 'sync'},
      {from: 'Kafka', to: 'ledger', label: 'poll → same event e7 again (relay replay, offset 5188)', kind: 'reply'},
      {from: 'ledger', to: 'Redis', label: 'SET applied:e7 NX → (nil): skip', kind: 'sync'},
      {from: 'ledger', to: 'Kafka', label: 'commit offset 5189', kind: 'sync'},
    ],
  },
  hints: [
    'The dedupe key is derived from the *event id inside the payload*, not the Kafka offset: a replayed row gets a new offset but carries the same event id.',
    'Both branches end with a commit. Only the middle differs: a refused SET skips the post, a successful SET runs it.',
    'Wrap the post: on failure DEL the claim and re-raise without committing. Otherwise a transient ledger error leaves a claimed-but-unposted event that nothing will ever retry.',
  ],
  checks: [
    {
      id: 'group-manual-commit',
      title: 'Joins group ledger with auto-commit disabled',
      detail:
        'The consumer uses `group.id` `ledger` and commits offsets itself; auto-commit acknowledges on a timer, before the post happened.',
      match: {
        python: {all: [/"group\.id"\s*:\s*"ledger"/, /"enable\.auto\.commit"\s*:\s*False/]},
        typescript: {all: [/groupId:\s*['"]ledger['"]/, /autoCommit:\s*false/]},
        go: {all: [/GroupID:\s*"ledger"/, /reader\.FetchMessage\(/], none: [/ReadMessage\(/]},
        scala: {all: [/"group\.id"\s*,\s*"ledger"/, /"enable\.auto\.commit"\s*,\s*"false"/]},
        cpp: {all: [/"group\.id"\s*,\s*"ledger"/, /"enable\.auto\.commit"\s*,\s*"false"/]},
      },
    },
    {
      id: 'dedupe-nx',
      title: 'Claims applied:{event_id} with SET NX and a 7-day expiry',
      detail:
        '`SET applied:{event_id} 1 NX EX 604800` is the atomic "have I seen this?" — one command, one winner, and the key eventually disappears on its own.',
      match: {
        python: {
          all: [
            /f["']applied:\{/,
            /\.set\(\s*\w+\s*,[^\n]*nx\s*=\s*True/,
            /\.set\(\s*\w+\s*,[^\n]*ex\s*=\s*APPLIED_TTL_S/,
          ],
        },
        typescript: {
          all: [
            /`applied:\$\{/,
            /\.set\(\s*\w+\s*,[^\n]*['"]NX['"]/,
            /\.set\(\s*\w+\s*,[^\n]*['"]EX['"]\s*,\s*APPLIED_TTL_S/,
          ],
        },
        go: {all: [/"applied:"\s*\+/, /rdb\.SetNX\(\s*[\w.()]+\s*,\s*\w+\s*,[^\n]*appliedTTL\s*\)/]},
        scala: {all: [/s"applied:\$/, /\.nx\(\)/, /\.ex\(\s*AppliedTtlSeconds\s*\)/]},
        cpp: {
          all: [
            /"applied:"\s*\+/,
            /redis\.set\(\s*\w+\s*,[^\n]*kAppliedTtl\s*,\s*sw::redis::UpdateType::NOT_EXIST\s*\)/,
          ],
        },
      },
    },
    {
      id: 'dedupe-before-post',
      title: 'Claims the event before posting it',
      detail:
        'The SET NX runs before `ledger.post`; claiming afterwards leaves a window where a second consumer posts the same event.',
      match: {
        python: {order: [/\.set\(\s*\w+\s*,[^\n]*nx\s*=\s*True/, /ledger\.post\(/]},
        typescript: {order: [/\.set\(\s*\w+\s*,[^\n]*['"]NX['"]/, /ledger\.post\(/]},
        go: {order: [/rdb\.SetNX\(/, /ledger\.Post\(/]},
        scala: {order: [/jedis\.set\(/, /Ledger\.post\(/]},
        cpp: {order: [/redis\.set\(/, /ledger::post\(/]},
      },
    },
    {
      id: 'skip-still-commits',
      title: 'A duplicate is skipped and its offset committed',
      detail:
        'When the claim is refused the record is committed without posting; skipping without committing would redeliver the duplicate on every restart.',
      match: {
        python: {order: [/if not (r\.set\(|\w+\s*:)/, /consumer\.commit\(/, /ledger\.post\(/]},
        typescript: {
          order: [/if \(\s*(claimed|\w+)\s*===?\s*null\s*\)|if \(\s*!\w+\s*\)/, /commitOffsets\(/, /ledger\.post\(/],
        },
        go: {order: [/if !\w+/, /reader\.CommitMessages\(/, /ledger\.Post\(/]},
        scala: {order: [/if \(!\w+\)|==\s*null\)/, /commit\(\s*\w+\s*\)/, /Ledger\.post\(/]},
        cpp: {order: [/if \(!\w+/, /consumer->commitSync\(/, /ledger::post\(/]},
      },
    },
    {
      id: 'commit-after-post',
      title: 'Commits only after the post succeeded',
      detail:
        'Commit follows `ledger.post`; a crash in between replays the record, and the claim makes the replay harmless.',
      match: {
        python: {order: [/ledger\.post\(/, /consumer\.commit\(/]},
        typescript: {order: [/ledger\.post\(/, /commitOffsets\(/]},
        go: {order: [/ledger\.Post\(/, /reader\.CommitMessages\(/]},
        scala: {order: [/Ledger\.post\(/, /commit\(\s*\w+\s*\)/]},
        cpp: {order: [/ledger::post\(/, /consumer->commitSync\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import Consumer

from payments import ledger  # ledger.post(event: dict) -> None writes the double-entry rows; NOT idempotent

log = logging.getLogger("ledger")
r = redis.Redis(host="redis", port=6379)

APPLIED_TTL_S = 604800  # 7 days: longer than any replay window

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "ledger",
        "auto.offset.reset": "earliest",
        # TODO: disable auto-commit
    }
)
consumer.subscribe(["payments"])


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        event = json.loads(msg.value())
        # TODO: SET applied:{event_id} 1 NX EX APPLIED_TTL_S; refused → already applied: commit and skip
        # TODO: ledger.post(event) (DEL the claim and re-raise on failure), then commit this message's offset
        raise NotImplementedError
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Consumer

from payments import ledger  # ledger.post(event: dict) -> None writes the double-entry rows; NOT idempotent

log = logging.getLogger("ledger")
r = redis.Redis(host="redis", port=6379)

APPLIED_TTL_S = 604800  # 7 days: longer than any replay window

consumer = Consumer(
    {
        "bootstrap.servers": "kafka:9092",
        "group.id": "ledger",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    }
)
consumer.subscribe(["payments"])


def run() -> None:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            log.error("consumer error: %s", msg.error())
            continue
        event = json.loads(msg.value())
        key = f"applied:{event['event_id']}"
        if not r.set(key, 1, nx=True, ex=APPLIED_TTL_S):
            log.info("event %s already applied; skipping", event["event_id"])
            consumer.commit(message=msg, asynchronous=False)
            continue
        try:
            ledger.post(event)
        except Exception:
            r.delete(key)  # release the claim: the redelivery must be allowed to post
            raise
        consumer.commit(message=msg, asynchronous=False)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {ledger} from 'payments/ledger'; // ledger.post(event) writes the double-entry rows; NOT idempotent

const redis = new Redis({host: 'redis', port: 6379});

export const APPLIED_TTL_S = 604800; // 7 days: longer than any replay window

const kafka = new Kafka({clientId: 'ledger', brokers: ['kafka:9092']});
export const consumer = kafka.consumer({groupId: 'ledger'});

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'payments', fromBeginning: true});
  await consumer.run({
    // TODO: disable auto-commit
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(String(message.value));
      // TODO: SET applied:{event_id} 1 NX EX APPLIED_TTL_S; refused → already applied: commit and skip
      // TODO: ledger.post(event) (DEL the claim and rethrow on failure), then commit this message's offset + 1
      throw new Error('not implemented');
    },
  });
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {ledger} from 'payments/ledger'; // ledger.post(event) writes the double-entry rows; NOT idempotent

const redis = new Redis({host: 'redis', port: 6379});

export const APPLIED_TTL_S = 604800; // 7 days: longer than any replay window

const kafka = new Kafka({clientId: 'ledger', brokers: ['kafka:9092']});
export const consumer = kafka.consumer({groupId: 'ledger'});

export async function run(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({topic: 'payments', fromBeginning: true});
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({topic, partition, message}) => {
      const event = JSON.parse(String(message.value));
      const key = \`applied:\${event.event_id}\`;
      const next = [{topic, partition, offset: String(Number(message.offset) + 1)}];
      const claimed = await redis.set(key, 1, 'EX', APPLIED_TTL_S, 'NX');
      if (claimed === null) {
        console.info(\`event \${event.event_id} already applied; skipping\`);
        await consumer.commitOffsets(next);
        return;
      }
      try {
        ledger.post(event);
      } catch (e) {
        await redis.del(key); // release the claim: the redelivery must be allowed to post
        throw e;
      }
      await consumer.commitOffsets(next);
    },
  });
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

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"payments/ledger" // ledger.Post(ctx, ledger.Event) error writes the double-entry rows; NOT idempotent
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const appliedTTL = 7 * 24 * time.Hour // longer than any replay window

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "ledger",
	Topic:   "payments",
})

func run(ctx context.Context) error {
	for {
		// TODO: FetchMessage (ReadMessage commits automatically — not what we want)
		// TODO: SetNX applied:{event_id} 1 appliedTTL; false → already applied: CommitMessages and continue
		// TODO: ledger.Post(ctx, event) (Del the claim on failure, do not commit), then CommitMessages
		var event ledger.Event
		_ = json.Unmarshal
		_ = event
		log.Println("not implemented")
		return nil
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"payments/ledger" // ledger.Post(ctx, ledger.Event) error writes the double-entry rows; NOT idempotent
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const appliedTTL = 7 * 24 * time.Hour // longer than any replay window

var reader = kafka.NewReader(kafka.ReaderConfig{
	Brokers: []string{"kafka:9092"},
	GroupID: "ledger",
	Topic:   "payments",
})

func run(ctx context.Context) error {
	for {
		msg, err := reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var event ledger.Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			return err // a malformed payment event is a bug upstream, not something to skip silently
		}
		key := "applied:" + event.EventID
		applied, err := rdb.SetNX(ctx, key, 1, appliedTTL).Result()
		if err != nil {
			return err
		}
		if !applied {
			log.Printf("event %s already applied; skipping", event.EventID)
			if err := reader.CommitMessages(ctx, msg); err != nil {
				return err
			}
			continue
		}
		if err := ledger.Post(ctx, event); err != nil {
			rdb.Del(ctx, key) // release the claim: the redelivery must be allowed to post
			return err
		}
		if err := reader.CommitMessages(ctx, msg); err != nil {
			return err
		}
	}
}
`,
    },
    scala: {
      starter: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import payments.Ledger // Ledger.post(event: Ledger.Event): Unit writes the double-entry rows; NOT idempotent
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._

object LedgerConsumer {
  val jedis = new JedisPooled("redis", 6379)
  val AppliedTtlSeconds = 604800L // 7 days: longer than any replay window

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "ledger")
  props.put("auto.offset.reset", "earliest")
  // TODO: disable auto-commit
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("payments").asJava)

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = Ledger.Event.fromJson(record.value())
        // TODO: SET applied:{eventId} 1 NX EX AppliedTtlSeconds; refused → already applied: commit(record) and skip
        // TODO: Ledger.post(event) (del the claim and rethrow on failure), then commit(record)
      }
}
`,
      solution: `import java.time.Duration
import java.util.Properties

import org.apache.kafka.clients.consumer.{ConsumerRecord, KafkaConsumer, OffsetAndMetadata}
import org.apache.kafka.common.TopicPartition
import org.apache.kafka.common.serialization.StringDeserializer
import payments.Ledger // Ledger.post(event: Ledger.Event): Unit writes the double-entry rows; NOT idempotent
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import scala.jdk.CollectionConverters._

object LedgerConsumer {
  val jedis = new JedisPooled("redis", 6379)
  val AppliedTtlSeconds = 604800L // 7 days: longer than any replay window

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("group.id", "ledger")
  props.put("auto.offset.reset", "earliest")
  props.put("enable.auto.commit", "false")
  private val consumer = new KafkaConsumer[String, String](props, new StringDeserializer, new StringDeserializer)
  consumer.subscribe(List("payments").asJava)

  /** Commits this record's offset synchronously. */
  private def commit(record: ConsumerRecord[String, String]): Unit =
    consumer.commitSync(
      Map(new TopicPartition(record.topic, record.partition) -> new OffsetAndMetadata(record.offset + 1)).asJava)

  def run(): Unit =
    while (true)
      consumer.poll(Duration.ofSeconds(1)).asScala.foreach { record =>
        val event = Ledger.Event.fromJson(record.value())
        val key = s"applied:\${event.eventId}"
        val claimed = jedis.set(key, "1", SetParams.setParams().nx().ex(AppliedTtlSeconds)) != null
        if (!claimed) {
          System.err.println(s"event \${event.eventId} already applied; skipping")
          commit(record)
        } else {
          try Ledger.post(event)
          catch { case e: Exception => jedis.del(key); throw e } // release the claim: the redelivery must post
          commit(record)
        }
      }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

#include "ledger.h"  // ledger::Event ledger::parse(const std::string& json); void ledger::post(const ledger::Event&) — NOT idempotent

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kAppliedTtl{604800};  // 7 days: longer than any replay window

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "ledger", err);
  conf->set("auto.offset.reset", "earliest", err);
  // TODO: disable auto-commit
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"payments"});
  return consumer;
}

auto consumer = make_consumer();

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const ledger::Event event = ledger::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    // TODO: SET applied:{event_id} 1 NX EX kAppliedTtl; refused → already applied: commitSync and continue
    // TODO: ledger::post(event) (del the claim and rethrow on failure), then commitSync this message
  }
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <memory>
#include <string>

#include "ledger.h"  // ledger::Event ledger::parse(const std::string& json); void ledger::post(const ledger::Event&) — NOT idempotent

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kAppliedTtl{604800};  // 7 days: longer than any replay window

std::unique_ptr<RdKafka::KafkaConsumer> make_consumer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("group.id", "ledger", err);
  conf->set("auto.offset.reset", "earliest", err);
  conf->set("enable.auto.commit", "false", err);
  auto consumer = std::unique_ptr<RdKafka::KafkaConsumer>(RdKafka::KafkaConsumer::create(conf.get(), err));
  consumer->subscribe({"payments"});
  return consumer;
}

auto consumer = make_consumer();

void run() {
  while (true) {
    std::unique_ptr<RdKafka::Message> msg(consumer->consume(1000));
    if (msg->err() == RdKafka::ERR__TIMED_OUT) continue;
    if (msg->err() != RdKafka::ERR_NO_ERROR) {
      std::cerr << "consumer error: " << msg->errstr() << "\\n";
      continue;
    }
    const ledger::Event event = ledger::parse(std::string(static_cast<const char*>(msg->payload()), msg->len()));
    const std::string key = "applied:" + event.event_id;
    if (!redis.set(key, "1", kAppliedTtl, sw::redis::UpdateType::NOT_EXIST)) {
      std::cerr << "event " << event.event_id << " already applied; skipping\\n";
      consumer->commitSync(msg.get());
      continue;
    }
    try {
      ledger::post(event);
    } catch (...) {
      redis.del(key);  // release the claim: the redelivery must be allowed to post
      throw;
    }
    consumer->commitSync(msg.get());
  }
}
`,
    },
  },
  harness: {
    python: `import json
import sys


def _seed(ctx, *event_ids):
    for event_id in event_ids:
        event = {"event_id": event_id, "type": "payment.captured", "merchant_id": "m-42", "order_id": "o-" + event_id, "amount_cents": 4999, "currency": "EUR"}
        ctx.kafka.seed("payments", key="m-42", value=json.dumps(event))


def _consumer(ctx):
    """The learner's module and the payments.ledger instance it imported (posted = the journal)."""
    m = ctx.load("ledger_consumer")
    return m, sys.modules["payments.ledger"]


def _posted(ledger):
    return [e["event_id"] for e in ledger.posted]


def check_group_manual_commit(ctx):
    _seed(ctx, "e1")
    m, ledger = _consumer(ctx)
    subscriptions = [e for e in ctx.kafka.events if e[0] == "subscribe"]
    assert subscriptions, "the consumer must subscribe to a topic"
    group, topics = subscriptions[-1][1], subscriptions[-1][2]
    assert group == "ledger", f"group.id must be ledger, got {group!r}"
    assert "payments" in topics, f"the consumer must subscribe to payments, got {topics}"
    assert ctx.kafka.consumers[-1].auto_commit is False, "enable.auto.commit is on: offsets would be acknowledged on a timer, before the post"
    ctx.drain(m.run)
    assert not any(e[0] == "auto-commit" for e in ctx.kafka.events), "offsets were auto-committed"
    assert any(e[0] == "manual-commit" for e in ctx.kafka.events), "no explicit commit happened"
    assert ctx.kafka.lag("ledger", "payments") == 0, "every processed record must be committed"


def check_dedupe_nx(ctx):
    ctx.redis.set("applied:e2", "1", ex=600000)  # applied by an earlier run of the ledger
    _seed(ctx, "e1", "e2")
    m, ledger = _consumer(ctx)
    ctx.drain(m.run)
    assert ctx.redis.exists("applied:e1"), "after posting e1 the claim applied:e1 must exist"
    ttl = ctx.redis.ttl("applied:e1")
    assert 604000 <= ttl <= 604800, f"applied:e1 has TTL {ttl}, expected 604800 s (7 days)"
    assert _posted(ledger) == ["e1"], f"the ledger posted {_posted(ledger)}: e2 was already applied and must be skipped, e1 must be posted once"
    assert ctx.redis.ttl("applied:e2") <= 600000, "the claim of an already applied event must not be overwritten (SET NX, not SET)"


def check_dedupe_before_post(ctx):
    _seed(ctx, "e1")
    m, ledger = _consumer(ctx)
    claimed_at_post = []
    real_post = ledger.post

    def post(event):
        claimed_at_post.append(ctx.redis.exists("applied:" + str(event.get("event_id"))))
        real_post(event)

    ledger.post = post
    ctx.drain(m.run)
    assert claimed_at_post, "ledger.post never ran for e1"
    assert claimed_at_post == [1], "when ledger.post ran, applied:e1 was not yet claimed: SET NX must come before the post"


def check_skip_still_commits(ctx):
    _seed(ctx, "e1", "e2", "e1")  # the relay replayed e1: a duplicate with a new offset
    m, ledger = _consumer(ctx)
    ctx.drain(m.run)
    assert _posted(ledger) == ["e1", "e2"], f"the ledger posted {_posted(ledger)}: each event exactly once, the replayed e1 skipped"
    lag = ctx.kafka.lag("ledger", "payments")
    assert lag == 0, f"{lag} record(s) not committed: the skipped duplicate's offset must be committed too, or it is redelivered forever"


def check_commit_after_post(ctx):
    _seed(ctx, "e1")
    m, ledger = _consumer(ctx)
    at_commit = []
    ctx.kafka.on_commit(lambda group, offsets: at_commit.append(len(ledger.posted)))
    ctx.drain(m.run)
    assert at_commit, "the offset of e1 was never committed"
    assert at_commit[0] == 1, "the commit must come after ledger.post: at commit time nothing had been posted"
    _seed(ctx, "e2")

    def failing_post(event):
        raise RuntimeError("ledger database down")

    ledger.post = failing_post
    try:
        ctx.drain(m.run)
    except RuntimeError:
        pass
    assert ctx.redis.get("applied:e2") is None, "when the post fails the claim applied:e2 must be released (DEL), or no retry will ever post it"
    assert ctx.kafka.lag("ledger", "payments") == 1, "a record whose post failed must not be committed: it has to come back"
    # restart the consumer: e1 is deduped by its claim, e2 is redelivered and posted this time
    m2, ledger2 = _consumer(ctx)
    ctx.drain(m2.run)
    assert _posted(ledger2) == ["e2"], f"after a restart the ledger posted {_posted(ledger2)}, expected only the retried e2"
    assert ctx.kafka.lag("ledger", "payments") == 0
`,
    typescript: `function seed(ctx, ...eventIds: string[]) {
  for (const eventId of eventIds) {
    const event = {event_id: eventId, type: 'payment.captured', merchant_id: 'm-42', order_id: 'o-' + eventId, amount_cents: 4999, currency: 'EUR'};
    ctx.kafka.seed('payments', {key: 'm-42', value: JSON.stringify(event)});
  }
}

/** The learner's module and the payments/ledger instance it imported (ledger.posted = the journal). */
function consumer(ctx) {
  const m = ctx.load('ledger_consumer');
  return {m, ledger: ctx.load('/support/payments/ledger.ts').ledger};
}

const posted = ledger => ledger.posted.map(e => e.event_id);

export async function check_group_manual_commit(ctx) {
  seed(ctx, 'e1');
  const {m} = consumer(ctx);
  await ctx.drain(m.run());
  const subscriptions = ctx.kafka.events.filter(e => e[0] === 'subscribe');
  assert(subscriptions.length > 0, 'the consumer must subscribe to a topic');
  const [, group, topics] = subscriptions[subscriptions.length - 1];
  assert.equal(group, 'ledger', \`groupId must be ledger, got \${JSON.stringify(group)}\`);
  assert(topics.includes('payments'), \`the consumer must subscribe to payments, got \${JSON.stringify(topics)}\`);
  const c = ctx.kafka.consumers[ctx.kafka.consumers.length - 1];
  assert.equal(c.autoCommit, false, 'autoCommit is on: offsets would be acknowledged on a timer, before the post');
  assert(!ctx.kafka.events.some(e => e[0] === 'auto-commit'), 'offsets were auto-committed');
  assert(ctx.kafka.events.some(e => e[0] === 'manual-commit'), 'no explicit commit happened');
  assert.equal(ctx.kafka.lag('ledger', 'payments'), 0, 'every processed record must be committed');
}

export async function check_dedupe_nx(ctx) {
  ctx.redis.set('applied:e2', '1', 'EX', 600000); // applied by an earlier run of the ledger
  seed(ctx, 'e1', 'e2', 'e3');
  // Another ledger replica claims e3 right after the first command that touches its key.
  let claimedByReplica = false;
  ctx.redisAfter('applied:e3', () => {
    claimedByReplica = ctx.redis.set('applied:e3', '1', 'EX', 604800, 'NX') === 'OK';
  });
  const {m, ledger} = consumer(ctx);
  await ctx.drain(m.run());
  assert(ctx.redis.exists('applied:e1'), 'after posting e1 the claim applied:e1 must exist');
  const ttl = ctx.redis.ttl('applied:e1');
  assert(604000 <= ttl && ttl <= 604800, \`applied:e1 has TTL \${ttl}, expected 604800 s (7 days)\`);
  assert.deepEqual(posted(ledger).filter(id => id !== 'e3'), ['e1'], \`the ledger posted \${JSON.stringify(posted(ledger))}: e2 was already applied and must be skipped, e1 must be posted once\`);
  assert(ctx.redis.ttl('applied:e2') <= 600000, 'the claim of an already applied event must not be overwritten (SET NX, not SET)');
  if (claimedByReplica) {
    assert(!posted(ledger).includes('e3'), 'another replica claimed applied:e3 between your read and your write and both posted e3: the claim must be one atomic SET NX');
  } else {
    assert.deepEqual(posted(ledger).slice(1), ['e3'], \`the replica that won the SET NX must post e3, the ledger posted \${JSON.stringify(posted(ledger))}\`);
  }
}

export async function check_dedupe_before_post(ctx) {
  seed(ctx, 'e1');
  const {m, ledger} = consumer(ctx);
  const claimedAtPost: number[] = [];
  const realPost = ledger.post;
  ledger.post = event => {
    claimedAtPost.push(ctx.redis.exists('applied:' + String(event.event_id)));
    realPost(event);
  };
  await ctx.drain(m.run());
  assert(claimedAtPost.length > 0, 'ledger.post never ran for e1');
  assert.deepEqual(claimedAtPost, [1], 'when ledger.post ran, applied:e1 was not yet claimed: SET NX must come before the post');
}

export async function check_skip_still_commits(ctx) {
  seed(ctx, 'e1', 'e2', 'e1'); // the relay replayed e1: a duplicate with a new offset
  const {m, ledger} = consumer(ctx);
  await ctx.drain(m.run());
  assert.deepEqual(posted(ledger), ['e1', 'e2'], \`the ledger posted \${JSON.stringify(posted(ledger))}: each event exactly once, the replayed e1 skipped\`);
  const lag = ctx.kafka.lag('ledger', 'payments');
  assert.equal(lag, 0, \`\${lag} record(s) not committed: the skipped duplicate's offset must be committed too, or it is redelivered forever\`);
}

export async function check_commit_after_post(ctx) {
  seed(ctx, 'e1');
  const {m, ledger} = consumer(ctx);
  const atCommit: number[] = [];
  ctx.kafka.onCommit(() => atCommit.push(ledger.posted.length));
  await ctx.drain(m.run());
  assert(atCommit.length > 0, 'the offset of e1 was never committed');
  assert.equal(atCommit[0], 1, 'the commit must come after ledger.post: at commit time nothing had been posted');
  seed(ctx, 'e2');
  const realPost = ledger.post;
  ledger.post = () => {
    throw new Error('ledger database down');
  };
  try {
    await ctx.drain(m.run());
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'ledger database down') throw e;
  }
  assert.equal(ctx.redis.get('applied:e2'), null, 'when the post fails the claim applied:e2 must be released (DEL), or no retry will ever post it');
  assert.equal(ctx.kafka.lag('ledger', 'payments'), 1, 'a record whose post failed must not be committed: it has to come back');
  // restart the consumer (a fresh replica; the ledger is back): e1 is deduped by its claim, e2 is redelivered and posted this time
  ledger.post = realPost;
  const before = ledger.posted.length;
  const m2 = ctx.reload('ledger_consumer');
  await ctx.drain(m2.run());
  const after = posted(ledger).slice(before);
  assert.deepEqual(after, ['e2'], \`after a restart the ledger posted \${JSON.stringify(after)}, expected only the retried e2\`);
  assert.equal(ctx.kafka.lag('ledger', 'payments'), 0);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/segmentio/kafka-go"

	"leetbuild/harness"

	"payments/ledger"
)

var errLedgerDown = errors.New("ledger database down")

func seedCaptured(ctx *harness.Ctx, eventIDs ...string) {
	for _, id := range eventIDs {
		event, _ := json.Marshal(map[string]any{"event_id": id, "type": "payment.captured", "merchant_id": "m-42", "order_id": "o-" + id, "amount_cents": 4999, "currency": "EUR"})
		ctx.Kafka.Seed("payments", "m-42", event)
	}
}

// consumeLedger runs the learner's loop until it waits for records that will not come, then stops it.
func consumeLedger(ctx *harness.Ctx) error {
	c, cancel := context.WithCancel(context.Background())
	var err error
	ctx.Drain(func() { err = run(c) })
	cancel()
	ctx.Settle()
	return err
}

func mustConsume(ctx *harness.Ctx) {
	err := consumeLedger(ctx)
	if err != nil && !errors.Is(err, context.Canceled) {
		ctx.Fatalf("run returned an error: %v", err)
	}
}

func postedIDs() []string {
	ids := []string{}
	for _, e := range ledger.Posted {
		ids = append(ids, e.EventID)
	}
	return ids
}

func CheckGroupManualCommit(ctx *harness.Ctx) {
	seedCaptured(ctx, "e1")
	mustConsume(ctx)
	subscriptions := ctx.Kafka.EventsOf("subscribe")
	ctx.Assert(len(subscriptions) > 0, "the consumer must subscribe to a topic")
	last := subscriptions[len(subscriptions)-1]
	ctx.Equal(last.Group, "ledger", "GroupID")
	subscribed := false
	for _, t := range last.Topics {
		subscribed = subscribed || t == "payments"
	}
	ctx.Assert(subscribed, "the consumer must subscribe to payments, got %v", last.Topics)
	consumers := ctx.Kafka.Consumers()
	ctx.Equal(consumers[len(consumers)-1].AutoCommit, false, "auto-commit is on: offsets would be acknowledged before the post; AutoCommit")
	ctx.Equal(len(ctx.Kafka.EventsOf("auto-commit")), 0, "offsets were auto-committed: auto-commit events")
	ctx.Assert(len(ctx.Kafka.EventsOf("manual-commit")) > 0, "no explicit commit happened")
	ctx.Equal(ctx.Kafka.Lag("ledger", "payments"), 0, "every processed record must be committed: lag")
}

func CheckDedupeNx(ctx *harness.Ctx) {
	ctx.Redis.Set("applied:e2", "1", "EX", 600000) // applied by an earlier run of the ledger
	seedCaptured(ctx, "e1", "e2", "e3")
	// Another ledger replica claims e3 right after the first command that touches its key.
	claimedByReplica := false
	ctx.Redis.After("applied:e3", func() any {
		claimedByReplica = ctx.Redis.Set("applied:e3", "1", "EX", 604800, "NX")
		return claimedByReplica
	})
	mustConsume(ctx)
	ctx.Equal(ctx.Redis.Exists("applied:e1"), 1, "after posting e1 the claim applied:e1 must exist")
	ttl := ctx.Redis.TTL("applied:e1")
	ctx.Assert(604000 <= ttl && ttl <= 604800, "applied:e1 has TTL %d, expected 604800 s (7 days)", ttl)
	var withoutE3 []string
	for _, id := range postedIDs() {
		if id != "e3" {
			withoutE3 = append(withoutE3, id)
		}
	}
	ctx.Equal(withoutE3, []string{"e1"}, "e2 was already applied and must be skipped, e1 must be posted once; the ledger posted %v", postedIDs())
	ctx.Assert(ctx.Redis.TTL("applied:e2") <= 600000, "the claim of an already applied event must not be overwritten (SetNX, not Set)")
	if claimedByReplica {
		for _, id := range postedIDs() {
			ctx.Assert(id != "e3", "another replica claimed applied:e3 between your read and your write and both posted e3: the claim must be one atomic SetNX")
		}
	} else {
		posted := postedIDs()
		ctx.Assert(len(posted) > 0, "the ledger posted nothing")
		ctx.Equal(posted[1:], []string{"e3"}, "the replica that won the SetNX must post e3; the ledger posted after e1")
	}
}

func CheckDedupeBeforePost(ctx *harness.Ctx) {
	seedCaptured(ctx, "e1")
	var claimedAtPost []int64
	realPost := ledger.Post
	ledger.Post = func(c context.Context, event ledger.Event) error {
		claimedAtPost = append(claimedAtPost, ctx.Redis.Exists("applied:"+event.EventID))
		return realPost(c, event)
	}
	mustConsume(ctx)
	ctx.Assert(len(claimedAtPost) > 0, "ledger.Post never ran for e1")
	ctx.Equal(claimedAtPost, []int64{1}, "when ledger.Post ran, applied:e1 must already be claimed (SetNX before the post): Exists at each post")
}

func CheckSkipStillCommits(ctx *harness.Ctx) {
	seedCaptured(ctx, "e1", "e2", "e1") // the relay replayed e1: a duplicate with a new offset
	mustConsume(ctx)
	ctx.Equal(postedIDs(), []string{"e1", "e2"}, "each event exactly once, the replayed e1 skipped; the ledger posted")
	ctx.Equal(ctx.Kafka.Lag("ledger", "payments"), 0, "the skipped duplicate's offset must be committed too, or it is redelivered forever: records not committed")
}

func CheckCommitAfterPost(ctx *harness.Ctx) {
	seedCaptured(ctx, "e1")
	var atCommit []int
	ctx.Kafka.OnCommit(func(string, harness.KafkaOffsets) { atCommit = append(atCommit, len(ledger.Posted)) })
	mustConsume(ctx)
	ctx.Assert(len(atCommit) > 0, "the offset of e1 was never committed")
	ctx.Equal(atCommit[0], 1, "the commit must come after ledger.Post: posts at commit time")
	seedCaptured(ctx, "e2")
	realPost := ledger.Post
	ledger.Post = func(context.Context, ledger.Event) error { return errLedgerDown }
	if err := consumeLedger(ctx); err != nil && !errors.Is(err, errLedgerDown) && !errors.Is(err, context.Canceled) {
		ctx.Fatalf("run returned an error: %v", err)
	}
	_, claimed := ctx.Redis.Get("applied:e2")
	ctx.Assert(!claimed, "when the post fails the claim applied:e2 must be released (Del), or no retry will ever post it")
	ctx.Equal(ctx.Kafka.Lag("ledger", "payments"), 1, "a record whose post failed must not be committed (it has to come back): records not committed")
	// restart the consumer (a fresh replica; the ledger is back): e1 is deduped by its claim, e2 is redelivered and posted this time
	ledger.Post = realPost
	before := len(ledger.Posted)
	config := reader.Config()
	_ = reader.Close()
	reader = kafka.NewReader(config)
	mustConsume(ctx)
	ctx.Equal(postedIDs()[before:], []string{"e2"}, "after a restart only the retried e2 must be posted; the ledger posted")
	ctx.Equal(ctx.Kafka.Lag("ledger", "payments"), 0, "records not committed after the restart")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <stdexcept>

namespace {

const std::string errLedgerDown = "ledger database down";

void seedCaptured(harness::Ctx& ctx, const std::vector<std::string>& eventIDs) {
  for (const auto& id : eventIDs) {
    ctx.Kafka.Seed("payments", "m-42",
                   R"({"amount_cents":4999,"currency":"EUR","event_id":")" + id + R"(","merchant_id":"m-42","order_id":"o-)" + id +
                       R"(","type":"payment.captured"})");
  }
}

// The learner's consume loop, on a thread of its own: run() takes no context to cancel (Go's run(ctx)
// does), so one loop keeps reading across the check's drains until it returns, throws or is abandoned.
struct runner {
  bool done = false;
  std::optional<std::string> err;
};
std::shared_ptr<runner> active;

// consumeLedger runs the learner's loop until it waits for records that will not come; what it threw
// when it ended by itself.
std::optional<std::string> consumeLedger(harness::Ctx& ctx) {
  if (!active || active->done) {
    auto r = active = std::make_shared<runner>();
    lb::spawn([r] {
      try {
        run();
      } catch (const std::exception& e) {
        r->err = std::string(e.what());
      } catch (...) {
        r->err = harness::CurrentExceptionType();
      }
      r->done = true;
    });
  }
  ctx.Settle();
  return active->done ? active->err : std::nullopt;
}

void mustConsume(harness::Ctx& ctx) {
  if (const auto err = consumeLedger(ctx)) ctx.Fatalf("run returned an error: %v", *err);
}

std::vector<std::string> postedIDs() {
  std::vector<std::string> ids;
  for (const auto& e : ledger::posted) ids.push_back(e.event_id);
  return ids;
}

}  // namespace

void CheckGroupManualCommit(harness::Ctx& ctx) {
  seedCaptured(ctx, {"e1"});
  mustConsume(ctx);
  const auto subscriptions = ctx.Kafka.EventsOf("subscribe");
  ctx.Assert(!subscriptions.empty(), "the consumer must subscribe to a topic");
  const auto& last = subscriptions.back();
  ctx.Equal(last.Group, "ledger", "group.id");
  bool subscribed = false;
  for (const auto& t : last.Topics) subscribed = subscribed || t == "payments";
  ctx.Assert(subscribed, "the consumer must subscribe to payments, got %v", last.Topics);
  const auto consumers = ctx.Kafka.Consumers();
  ctx.Equal(consumers.back().AutoCommit, false, "auto-commit is on: offsets would be acknowledged before the post; enable.auto.commit");
  ctx.Equal(ctx.Kafka.EventsOf("auto-commit").size(), 0, "offsets were auto-committed: auto-commit events");
  ctx.Assert(!ctx.Kafka.EventsOf("manual-commit").empty(), "no explicit commit happened");
  ctx.Equal(ctx.Kafka.Lag("ledger", "payments"), 0, "every processed record must be committed: lag");
}

void CheckDedupeNx(harness::Ctx& ctx) {
  ctx.Redis.Set("applied:e2", "1", "EX", 600000);  // applied by an earlier run of the ledger
  seedCaptured(ctx, {"e1", "e2", "e3"});
  // Another ledger replica claims e3 right after the first command that touches its key.
  bool claimedByReplica = false;
  ctx.Redis.After("applied:e3", [&] { claimedByReplica = ctx.Redis.Set("applied:e3", "1", "EX", 604800, "NX"); });
  mustConsume(ctx);
  ctx.Equal(ctx.Redis.Exists("applied:e1"), 1, "after posting e1 the claim applied:e1 must exist");
  const long long ttl = ctx.Redis.TTL("applied:e1");
  ctx.Assert(604000 <= ttl && ttl <= 604800, "applied:e1 has TTL %d, expected 604800 s (7 days)", ttl);
  std::vector<std::string> withoutE3;
  for (const auto& id : postedIDs()) {
    if (id != "e3") withoutE3.push_back(id);
  }
  ctx.Equal(withoutE3, {"e1"}, "e2 was already applied and must be skipped, e1 must be posted once; the ledger posted %v", postedIDs());
  ctx.Assert(ctx.Redis.TTL("applied:e2") <= 600000, "the claim of an already applied event must not be overwritten (SET NX, not SET)");
  if (claimedByReplica) {
    for (const auto& id : postedIDs()) {
      ctx.Assert(id != "e3", "another replica claimed applied:e3 between your read and your write and both posted e3: the claim must be one atomic SET NX");
    }
  } else {
    const auto posted = postedIDs();
    ctx.Assert(!posted.empty(), "the ledger posted nothing");
    ctx.Equal(std::vector<std::string>(posted.begin() + 1, posted.end()), {"e3"}, "the replica that won the SET NX must post e3; the ledger posted after e1");
  }
}

void CheckDedupeBeforePost(harness::Ctx& ctx) {
  seedCaptured(ctx, {"e1"});
  std::vector<long long> claimedAtPost;
  const auto realPost = ledger::post;
  ledger::post = [&ctx, &claimedAtPost, realPost](const ledger::Event& event) {
    claimedAtPost.push_back(ctx.Redis.Exists("applied:" + event.event_id));
    realPost(event);
  };
  mustConsume(ctx);
  ctx.Assert(!claimedAtPost.empty(), "ledger::post never ran for e1");
  ctx.Equal(claimedAtPost, {1LL}, "when ledger::post ran, applied:e1 must already be claimed (SET NX before the post): EXISTS at each post");
}

void CheckSkipStillCommits(harness::Ctx& ctx) {
  seedCaptured(ctx, {"e1", "e2", "e1"});  // the relay replayed e1: a duplicate with a new offset
  mustConsume(ctx);
  ctx.Equal(postedIDs(), {"e1", "e2"}, "each event exactly once, the replayed e1 skipped; the ledger posted");
  ctx.Equal(ctx.Kafka.Lag("ledger", "payments"), 0, "the skipped duplicate's offset must be committed too, or it is redelivered forever: records not committed");
}

void CheckCommitAfterPost(harness::Ctx& ctx) {
  seedCaptured(ctx, {"e1"});
  std::vector<size_t> atCommit;
  ctx.Kafka.OnCommit([&](const std::string&, const harness::KafkaOffsets&) { atCommit.push_back(ledger::posted.size()); });
  mustConsume(ctx);
  ctx.Assert(!atCommit.empty(), "the offset of e1 was never committed");
  ctx.Equal(atCommit[0], 1, "the commit must come after ledger::post: posts at commit time");
  seedCaptured(ctx, {"e2"});
  const auto realPost = ledger::post;
  ledger::post = [](const ledger::Event&) { throw std::runtime_error(errLedgerDown); };
  if (const auto err = consumeLedger(ctx); err && err->find(errLedgerDown) == std::string::npos) {
    ctx.Fatalf("run returned an error: %v", *err);
  }
  ctx.Assert(!ctx.Redis.Get("applied:e2").has_value(), "when the post fails the claim applied:e2 must be released (DEL), or no retry will ever post it");
  ctx.Equal(ctx.Kafka.Lag("ledger", "payments"), 1, "a record whose post failed must not be committed (it has to come back): records not committed");
  // restart the consumer (a fresh replica; the ledger is back): e1 is deduped by its claim, e2 is redelivered and posted this time
  ledger::post = realPost;
  const size_t before = ledger::posted.size();
  consumer->close();
  consumer = make_consumer();  // a loop still reading the old consumer waits on it for good
  active.reset();
  mustConsume(ctx);
  const auto posted = postedIDs();
  ctx.Equal(std::vector<std::string>(posted.begin() + static_cast<long>(before), posted.end()), {"e2"}, "after a restart only the retried e2 must be posted; the ledger posted");
  ctx.Equal(ctx.Kafka.Lag("ledger", "payments"), 0, "records not committed after the restart");
}
`,
  },
  debrief: `The consumer owns its delivery guarantee: at-least-once from the broker (commit after the work) plus a claim keyed by the event's own id turns duplicates into no-ops. The claim is in Redis for speed, but notice its weak spot — a crash between the SET and the post leaves a claimed, unposted event until the TTL. Real ledgers close that gap by making the post itself idempotent (a unique index on \`event_id\` in the journal, insert-or-ignore) so the Redis claim is only a fast path, and they commit offsets in batches once the whole poll was applied.`,
};
