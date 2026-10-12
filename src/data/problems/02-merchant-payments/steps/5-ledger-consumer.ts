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
  },
  debrief: `The consumer owns its delivery guarantee: at-least-once from the broker (commit after the work) plus a claim keyed by the event's own id turns duplicates into no-ops. The claim is in Redis for speed, but notice its weak spot — a crash between the SET and the post leaves a claimed, unposted event until the TTL. Real ledgers close that gap by making the post itself idempotent (a unique index on \`event_id\` in the journal, insert-or-ignore) so the Redis claim is only a fast path, and they commit offsets in batches once the whole poll was applied.`,
};
