import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Permission events keyed by subject, relayed from the outbox',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'outbox', 'kafka', 'projector', 'redis'],
  task: `## Task

**Starting point.** Grant changes commit through \`grants.commit_grant\` / \`commit_revoke\`
(provided): the grant, the bump of \`perm:grant_version\` and an outbox row, in one Lua script. The
starter is the rest: \`relay()\` produces every pending row to \`permission.event\` keyed by the
role, marks each row sent and flushes once at the end; \`apply_event(raw)\`, the projector, sets
\`perm:grant_version\` to each record's \`grant_version\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** One subject's grant and revoke land on two partitions; a record
the broker rejects is marked sent and lost; a revoke goes out while the grant before it is still
pending; and a projector that reads partitions in another order winds the version counter back.

- The record key is the **subject**; the value is \`{type, grant_id, subject, role, scope,
  grant_version}\`.
- A row is marked sent only after its **delivery report** says the broker has it. Wait for the
  report **2 s** at most: a row without one counts as a failure.
- On the first failure the relay **stops**: that row and every row after it stay pending, in order.
- \`apply_event\` only ever **raises** the counter, comparing versions as numbers, in one Lua
  compare-and-set.`,
  sequence: {
    participants: ['Permission Service', 'Outbox', 'permission.event', 'Projector', 'Redis'],
    messages: [
      {
        from: 'Permission Service',
        to: 'Outbox',
        label: 'commit_grant: grant + version + row, one script',
        kind: 'sync',
      },
      {from: 'Outbox', to: 'permission.event', label: 'relay: produce key = subject', kind: 'async'},
      {from: 'permission.event', to: 'Outbox', label: 'delivery report → mark_sent(row)', kind: 'reply'},
      {
        from: 'permission.event',
        to: 'Outbox',
        label: 'rejected → stop; this row and the rest stay pending',
        kind: 'reply',
      },
      {from: 'permission.event', to: 'Projector', label: 'consume · any partition order', kind: 'async'},
      {from: 'Projector', to: 'Redis', label: 'EVAL raise perm:grant_version to max(seen)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'subject-key',
      title: 'Keys every event by the subject',
      detail:
        "The record key is the row's subject, so one subject's grants and revokes share a partition and replay in order; the starter keys by role, which spreads one subject over every partition.",
      match: {
        python: {
          all: [/producer\.produce\([^\n]*key\s*=\s*row\[["']subject["']\]/, /permission\.event/],
          none: [/key\s*=\s*row\[["']role["']\]/],
        },
        typescript: {all: [/key:\s*row\.subject/, /permission\.event/], none: [/key:\s*row\.role/]},
        go: {all: [/Key:\s*\[\]byte\(row\.Subject\)/, /permission\.event/], none: [/Key:\s*\[\]byte\(row\.Role\)/]},
        cpp: {
          all: [/row\.subject\.c_str\(\),\s*row\.subject\.size\(\)/, /permission\.event/],
          none: [/row\.role\.c_str\(\)/],
        },
      },
    },
    {
      id: 'sent-after-ack',
      title: 'Marks a row sent only after its delivery report',
      detail:
        'Each row is produced with a delivery report (`on_delivery`, an awaited `send`, the `WriteMessages` error, `dr_cb`, the send future) and marked sent only once the broker has it, waiting 2 s at most: a broker that never answers leaves the row pending. The starter marks every row before the flush, so a rejected record is gone.',
      match: {
        python: {all: [/on_delivery\s*=/], order: [/producer\.produce\(/, /producer\.flush\(/, /grants\.mark_sent\(/]},
        typescript: {all: [/await producer\.send\(/], order: [/await producer\.send\(/, /markSent\(/]},
        go: {all: [/err\s*:?=\s*writer\.WriteMessages\(/], order: [/writer\.WriteMessages\(/, /grants\.MarkSent\(/]},
        cpp: {all: [/dr_cb/], order: [/producer->produce\(/, /producer->flush\(/, /grants::markSent\(/]},
      },
    },
    {
      id: 'stop-at-failure',
      title: 'Stops at the first failed row, keeping the order',
      detail:
        "After a failed delivery the relay stops: that row and every later row stay pending for the next pass, so a subject's revoke is never published ahead of the grant it revokes.",
      match: {
        python: {all: [/\n\s+break\b/], none: [/\n\s+continue\b/]},
        typescript: {all: [/\bbreak;/], none: [/\bcontinue;/]},
        go: {all: [/\n\s+break\b/], none: [/\n\s+continue\b/]},
        cpp: {all: [/\bbreak;/], none: [/\bcontinue;/]},
      },
    },
    {
      id: 'monotonic-rebuild',
      title: 'The projector only ever raises the version counter',
      detail:
        "Records of different subjects arrive from different partitions in any order, so `apply_event` raises `perm:grant_version` to the record's version in one Lua compare-and-set, comparing numbers, and leaves a higher counter alone, even one another projector raised a moment ago; a plain `SET` winds it back, and cache entries stamped since look current again.",
      match: {
        python: {all: [/register_script\(|\.eval\(/, /tonumber\(ARGV\[1\]\)\s*>/], none: [/\.set\(\s*VERSION_KEY/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /tonumber\(ARGV\[1\]\)\s*>/], none: [/\.set\(\s*VERSION_KEY/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /tonumber\(ARGV\[1\]\)\s*>/], none: [/\.Set\(\s*ctx,\s*versionKey/]},
        cpp: {all: [/redis\.eval</, /tonumber\(ARGV\[1\]\)\s*>/], none: [/redis\.set\(\s*kVersionKey/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from confluent_kafka import Producer

from permz import grants  # commit_grant, commit_revoke, pending, mark_sent

TOPIC = "permission.event"
VERSION_KEY = "perm:grant_version"
ACK_TIMEOUT_S = 2

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})


def event_of(row: dict) -> dict:
    return {name: row[name] for name in ("type", "grant_id", "subject", "role", "scope", "grant_version")}


def relay() -> int:
    """Publish the pending outbox rows, oldest first; returns how many were published."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    sent = 0
    for row in grants.pending():
        producer.produce(TOPIC, key=row["role"], value=json.dumps(event_of(row)))
        grants.mark_sent(row["id"])
        sent += 1
    producer.flush(ACK_TIMEOUT_S)
    return sent


def apply_event(raw) -> None:
    """The projector: fold one permission.event record into perm:grant_version."""
    event = json.loads(raw)
    r.set(VERSION_KEY, event["grant_version"])
`,
      solution: `import json

import redis
from confluent_kafka import Producer

from permz import grants  # commit_grant, commit_revoke, pending, mark_sent

TOPIC = "permission.event"
VERSION_KEY = "perm:grant_version"
ACK_TIMEOUT_S = 2

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all", "enable.idempotence": True})

# Raise the counter to ARGV[1]; a counter already past it stays where it is.
RAISE_LUA = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return tonumber(ARGV[1])
end
return current
"""
raise_version = r.register_script(RAISE_LUA)


def event_of(row: dict) -> dict:
    return {name: row[name] for name in ("type", "grant_id", "subject", "role", "scope", "grant_version")}


def relay() -> int:
    """Publish the pending outbox rows, oldest first; returns how many were published."""
    sent = 0
    for row in grants.pending():
        report = {}

        def on_delivery(err, msg):
            report["error"] = err

        producer.produce(TOPIC, key=row["subject"], value=json.dumps(event_of(row)), on_delivery=on_delivery)
        in_flight = producer.flush(ACK_TIMEOUT_S)
        if in_flight > 0 or report.get("error") is not None:
            break  # this row and every later one stay pending, in order, for the next pass
        grants.mark_sent(row["id"])  # the broker has it
        sent += 1
    return sent


def apply_event(raw) -> None:
    """The projector: fold one permission.event record into perm:grant_version."""
    event = json.loads(raw)
    raise_version(keys=[VERSION_KEY], args=[event["grant_version"]])
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {type OutboxRow, markSent, pending} from 'permz/grants';

export const TOPIC = 'permission.event';
export const VERSION_KEY = 'perm:grant_version';

const redis = new Redis({host: 'redis', port: 6379});
const producer = new Kafka({clientId: 'permz', brokers: ['kafka:9092']}).producer({idempotent: true});
void producer.connect();

export function eventOf(row: OutboxRow) {
  const {type, grant_id, subject, role, scope, grant_version} = row;
  return {type, grant_id, subject, role, scope, grant_version};
}

/** Publish the pending outbox rows, oldest first; resolves how many were published. */
export async function relay(): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  let sent = 0;
  for (const row of await pending()) {
    void producer.send({topic: TOPIC, acks: -1, messages: [{key: row.role, value: JSON.stringify(eventOf(row))}]});
    await markSent(row.id);
    sent++;
  }
  return sent;
}

/** The projector: fold one permission.event record into perm:grant_version. */
export async function applyEvent(raw: string): Promise<void> {
  const event = JSON.parse(raw) as {grant_version: number};
  await redis.set(VERSION_KEY, event.grant_version);
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {type OutboxRow, markSent, pending} from 'permz/grants';

export const TOPIC = 'permission.event';
export const VERSION_KEY = 'perm:grant_version';
export const ACK_TIMEOUT_MS = 2000;

// Raise the counter to ARGV[1]; a counter already past it stays where it is.
export const RAISE_LUA = \`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return tonumber(ARGV[1])
end
return current
\`;

interface RaiseRedis extends Redis {
  raiseVersion(key: string, version: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as RaiseRedis;
redis.defineCommand('raiseVersion', {numberOfKeys: 1, lua: RAISE_LUA});
const producer = new Kafka({clientId: 'permz', brokers: ['kafka:9092']}).producer({idempotent: true});
void producer.connect();

export function eventOf(row: OutboxRow) {
  const {type, grant_id, subject, role, scope, grant_version} = row;
  return {type, grant_id, subject, role, scope, grant_version};
}

/** Publish the pending outbox rows, oldest first; resolves how many were published. */
export async function relay(): Promise<number> {
  let sent = 0;
  for (const row of await pending()) {
    try {
      await producer.send({
        topic: TOPIC,
        acks: -1,
        timeout: ACK_TIMEOUT_MS,
        messages: [{key: row.subject, value: JSON.stringify(eventOf(row))}],
      });
    } catch {
      break; // this row and every later one stay pending, in order, for the next pass
    }
    await markSent(row.id); // the broker has it
    sent++;
  }
  return sent;
}

/** The projector: fold one permission.event record into perm:grant_version. */
export async function applyEvent(raw: string): Promise<void> {
  const event = JSON.parse(raw) as {grant_version: number};
  await redis.raiseVersion(VERSION_KEY, event.grant_version);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"permz/grants" // grants.CommitGrant, CommitRevoke, Pending, MarkSent
)

const (
	topic      = "permission.event"
	versionKey = "perm:grant_version"
	ackTimeout = 2 * time.Second
)

var (
	rdb    = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}
)

func eventOf(row grants.OutboxRow) map[string]any {
	return map[string]any{"type": row.Type, "grant_id": row.GrantID, "subject": row.Subject, "role": row.Role, "scope": row.Scope, "grant_version": row.GrantVersion}
}

// relay publishes the pending outbox rows, oldest first, and returns how many were published.
func relay(ctx context.Context) int {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var messages []kafka.Message
	for _, row := range grants.Pending(ctx) {
		value, _ := json.Marshal(eventOf(row))
		messages = append(messages, kafka.Message{Key: []byte(row.Role), Value: value})
		grants.MarkSent(ctx, row.ID)
	}
	if len(messages) > 0 {
		writer.WriteMessages(ctx, messages...)
	}
	return len(messages)
}

// applyEvent is the projector: it folds one permission.event record into perm:grant_version.
func applyEvent(ctx context.Context, raw []byte) error {
	var event struct {
		GrantVersion int64 \`json:"grant_version"\`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return err
	}
	return rdb.Set(ctx, versionKey, event.GrantVersion, 0).Err()
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"permz/grants" // grants.CommitGrant, CommitRevoke, Pending, MarkSent
)

const (
	topic      = "permission.event"
	versionKey = "perm:grant_version"
	ackTimeout = 2 * time.Second
)

var (
	rdb    = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}
)

// raiseVersion raises the counter to ARGV[1]; a counter already past it stays where it is.
var raiseVersion = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return tonumber(ARGV[1])
end
return current
\`)

func eventOf(row grants.OutboxRow) map[string]any {
	return map[string]any{"type": row.Type, "grant_id": row.GrantID, "subject": row.Subject, "role": row.Role, "scope": row.Scope, "grant_version": row.GrantVersion}
}

// relay publishes the pending outbox rows, oldest first, and returns how many were published.
func relay(ctx context.Context) int {
	sent := 0
	for _, row := range grants.Pending(ctx) {
		value, _ := json.Marshal(eventOf(row))
		sendCtx, cancel := context.WithTimeout(ctx, ackTimeout) // the broker's answer, or give up after the window
		err := writer.WriteMessages(sendCtx, kafka.Message{Key: []byte(row.Subject), Value: value})
		cancel()
		if err != nil {
			break // this row and every later one stay pending, in order, for the next pass
		}
		grants.MarkSent(ctx, row.ID) // the broker has it
		sent++
	}
	return sent
}

// applyEvent is the projector: it folds one permission.event record into perm:grant_version.
func applyEvent(ctx context.Context, raw []byte) error {
	var event struct {
		GrantVersion int64 \`json:"grant_version"\`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return err
	}
	return raiseVersion.Run(ctx, rdb, []string{versionKey}, event.GrantVersion).Err()
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>

#include "permz/grants.h"  // grants::commitGrant, commitRevoke, pending, markSent

using json = nlohmann::json;

const std::string kTopic = "permission.event";
const std::string kVersionKey = "perm:grant_version";
constexpr int kAckTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventOf(const grants::OutboxRow& row) {
  return json{{"type", row.type}, {"grant_id", row.grant_id}, {"subject", row.subject}, {"role", row.role}, {"scope", row.scope}, {"grant_version", row.grant_version}};
}

// Publish the pending outbox rows, oldest first; returns how many were published.
int relay() {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  int sent = 0;
  for (const grants::OutboxRow& row : grants::pending()) {
    const std::string value = eventOf(row).dump();
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                      value.size(), row.role.c_str(), row.role.size(), 0, nullptr);
    grants::markSent(row.id);
    sent++;
  }
  producer->flush(kAckTimeoutMs);
  return sent;
}

// The projector: fold one permission.event record into perm:grant_version.
void applyEvent(const std::string& raw) {
  const json event = json::parse(raw);
  redis.set(kVersionKey, std::to_string(event.at("grant_version").get<long long>()));
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>

#include "permz/grants.h"  // grants::commitGrant, commitRevoke, pending, markSent

using json = nlohmann::json;

const std::string kTopic = "permission.event";
const std::string kVersionKey = "perm:grant_version";
constexpr int kAckTimeoutMs = 2000;

// Raise the counter to ARGV[1]; a counter already past it stays where it is.
const std::string kRaiseLua = R"lua(
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1])
  return tonumber(ARGV[1])
end
return current
)lua";

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report of the record in flight: relay produces one row at a time and waits for it.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;
  void dr_cb(RdKafka::Message& message) override { error = message.err(); }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json eventOf(const grants::OutboxRow& row) {
  return json{{"type", row.type}, {"grant_id", row.grant_id}, {"subject", row.subject}, {"role", row.role}, {"scope", row.scope}, {"grant_version", row.grant_version}};
}

// Publish the pending outbox rows, oldest first; returns how many were published.
int relay() {
  int sent = 0;
  for (const grants::OutboxRow& row : grants::pending()) {
    const std::string value = eventOf(row).dump();
    delivery.error = RdKafka::ERR_NO_ERROR;
    RdKafka::ErrorCode err =
        producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                          value.size(), row.subject.c_str(), row.subject.size(), 0, nullptr);
    if (err == RdKafka::ERR_NO_ERROR) {
      producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
      err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
    }
    if (err != RdKafka::ERR_NO_ERROR) break;  // this row and every later one stay pending, in order, for the next pass
    grants::markSent(row.id);                   // the broker has it
    sent++;
  }
  return sent;
}

// The projector: fold one permission.event record into perm:grant_version.
void applyEvent(const std::string& raw) {
  const json event = json::parse(raw);
  redis.eval<long long>(kRaiseLua, {kVersionKey}, {std::to_string(event.at("grant_version").get<long long>())});
}
`,
    },
  },
  harness: {
    python: `import json

from permz import grants

TOPIC = "permission.event"


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _event(version):
    return json.dumps({"type": "granted", "grant_id": f"g-{version}", "subject": "ada", "role": "viewer", "scope": "team:eng", "grant_version": version})


def _stalled_relay(ctx, m):
    """bob's row meets a broker that stops answering: relay gives up after the report window, the row pending."""
    grants.commit_grant("bob", "viewer", "team:eng", "olu")
    ctx.kafka.stall(TOPIC)
    before = ctx.clock.time()
    m.relay()
    waited = ctx.clock.time() - before
    assert waited <= 2.5, f"relay waited {waited:.1f} s for a broker that does not answer, expected the 2 s delivery-report window"
    held = [row["subject"] for row in grants.pending()]
    assert held == ["bob"], f"no delivery report came for bob's row and the outbox holds the rows of {held}: a row without a report stays pending"


def check_subject_key(ctx):
    m = ctx.load("events")
    ada = grants.commit_grant("ada", "viewer", "team:eng", "olu")
    grants.commit_grant("bob", "viewer", "team:eng", "olu")
    grants.commit_revoke(ada["grant_id"])
    m.relay()
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three committed changes produced {len(records)} records on permission.event"
    keys = sorted((r.key or b"").decode() for r in records)
    assert keys == ["ada", "ada", "bob"], f"the records are keyed {keys}, expected the subjects ada, ada, bob"
    on_ada = {r.partition for r in records if r.key == b"ada"}
    assert len(on_ada) == 1, "ada's grant and revoke must share a partition, or a consumer can apply the revoke first"
    granted = [e for e in _events(ctx) if e.get("type") == "granted" and e.get("subject") == "ada"]
    assert granted == [{"type": "granted", "grant_id": "g-1", "subject": "ada", "role": "viewer", "scope": "team:eng", "grant_version": 1}], f"ada's granted event is {granted}, expected type, grant_id, subject, role, scope and grant_version 1"
    assert grants.pending() == [], f"every delivered row must be marked sent, the outbox still holds {grants.pending()}"


def check_sent_after_ack(ctx):
    m = ctx.load("events")
    grants.commit_grant("ada", "viewer", "team:eng", "olu")
    ctx.kafka.fail_next(TOPIC, 1)
    m.relay()
    assert ctx.kafka.records(TOPIC) == [], "the broker rejected the record, yet it is on the topic"
    pending = grants.pending()
    assert len(pending) == 1, "the broker rejected ada's granted event and relay marked the row sent anyway: the event is lost for good. Mark a row sent only after its delivery report"
    m.relay()
    assert len(ctx.kafka.records(TOPIC)) == 1, f"the next relay must publish the row the broker rejected, the topic holds {len(ctx.kafka.records(TOPIC))} records"
    assert grants.pending() == [], f"once delivered the row must be marked sent, the outbox still holds {grants.pending()}"
    _stalled_relay(ctx, m)


def check_stop_at_failure(ctx):
    m = ctx.load("events")
    grant = grants.commit_grant("ada", "team_admin", "team:eng", "olu")
    grants.commit_revoke(grant["grant_id"])
    ctx.kafka.fail_next(TOPIC, 1)
    m.relay()
    seen = [e.get("type") for e in _events(ctx) if e.get("subject") == "ada"]
    assert "revoked" not in seen or "granted" in seen, f"the broker rejected ada's grant and relay published the revoke behind it ({seen}): a consumer applies the revoke, then the grant, and ada keeps team_admin. Stop at the first failed row"
    m.relay()
    seen = [e.get("type") for e in _events(ctx) if e.get("subject") == "ada"]
    assert seen == ["granted", "revoked"], f"after a rejected delivery and a second relay ada's events are {seen}, expected the grant, then the revoke"


def check_monotonic_rebuild(ctx):
    m = ctx.load("events")
    # Records of different subjects come off different partitions in any order.
    for version in (5, 3, 6, 2):
        m.apply_event(_event(version))
    got = ctx.redis.get("perm:grant_version")
    assert got == "6", f"after records with grant_version 5, 3, 6, 2 the counter is {got!r}, expected 6: a counter wound back makes cache entries stamped since look current again"
    ctx.redis.set("perm:grant_version", "9")
    m.apply_event(_event(7))
    got = ctx.redis.get("perm:grant_version")
    assert got == "9", f"a record with grant_version 7 moved the counter from 9 to {got!r}: the projector only ever raises it"
    m.apply_event(_event(10))
    got = ctx.redis.get("perm:grant_version")
    assert got == "10", f"a record with grant_version 10 left the counter at {got!r} (it was 9): versions compare as numbers"
    ctx.redis_after("perm:grant_version", lambda: ctx.redis.set("perm:grant_version", "20"))
    m.apply_event(_event(11))
    got = ctx.redis.get("perm:grant_version")
    assert got == "20", f"another projector raised the counter to 20 while this one applied grant_version 11, and it ended at {got!r}: read and raise it in one atomic step"
`,
    typescript: `const TOPIC = 'permission.event';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

const event = (version: number): string =>
  JSON.stringify({type: 'granted', grant_id: \`g-\${version}\`, subject: 'ada', role: 'viewer', scope: 'team:eng', grant_version: version});

function events(ctx) {
  return {m: ctx.load('events'), grants: ctx.load('/support/permz/grants.ts')};
}

const values = ctx => ctx.kafka.values(TOPIC).map(v => JSON.parse(v));

/** bob's row meets a broker that stops answering: relay gives up after the report window, the row pending. */
async function stalledRelay(ctx, m, grants): Promise<void> {
  await grants.commitGrant('bob', 'viewer', 'team:eng', 'olu');
  ctx.kafka.stall(TOPIC);
  const before = ctx.clock.now();
  await m.relay();
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 2.5, \`relay waited \${waited.toFixed(1)} s for a broker that does not answer, expected the 2 s delivery-report window\`);
  const held = (await grants.pending()).map(row => row.subject);
  assert.deepStrictEqual(held, ['bob'], \`no delivery report came for bob's row and the outbox holds the rows of \${JSON.stringify(held)}: a row without a report stays pending\`);
}

export async function check_subject_key(ctx) {
  const {m, grants} = events(ctx);
  const ada = await grants.commitGrant('ada', 'viewer', 'team:eng', 'olu');
  await grants.commitGrant('bob', 'viewer', 'team:eng', 'olu');
  await grants.commitRevoke(ada.grant_id);
  await m.relay();
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three committed changes produced \${records.length} records on permission.event\`);
  const keys = [...ctx.kafka.keys(TOPIC)].sort();
  assert.deepStrictEqual(keys, ['ada', 'ada', 'bob'], \`the records are keyed \${JSON.stringify(keys)}, expected the subjects ada, ada, bob\`);
  const onAda = new Set(records.filter((_, i) => ctx.kafka.keys(TOPIC)[i] === 'ada').map(r => r.partition));
  assert.equal(onAda.size, 1, "ada's grant and revoke must share a partition, or a consumer can apply the revoke first");
  const granted = values(ctx).filter(e => e.type === 'granted' && e.subject === 'ada');
  assert.deepStrictEqual(granted, [{type: 'granted', grant_id: 'g-1', subject: 'ada', role: 'viewer', scope: 'team:eng', grant_version: 1}], \`ada's granted event is \${JSON.stringify(granted)}, expected type, grant_id, subject, role, scope and grant_version 1\`);
  assert.deepStrictEqual(await grants.pending(), [], 'every delivered row must be marked sent');
}

export async function check_sent_after_ack(ctx) {
  const {m, grants} = events(ctx);
  await grants.commitGrant('ada', 'viewer', 'team:eng', 'olu');
  ctx.kafka.failNext(TOPIC, 1);
  await m.relay();
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'the broker rejected the record, yet it is on the topic');
  assert.equal((await grants.pending()).length, 1, "the broker rejected ada's granted event and relay marked the row sent anyway: the event is lost for good. Mark a row sent only after its delivery report");
  await m.relay();
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the next relay must publish the row the broker rejected');
  assert.deepStrictEqual(await grants.pending(), [], 'once delivered the row must be marked sent');
  await stalledRelay(ctx, m, grants);
}

export async function check_stop_at_failure(ctx) {
  const {m, grants} = events(ctx);
  const grant = await grants.commitGrant('ada', 'team_admin', 'team:eng', 'olu');
  await grants.commitRevoke(grant.grant_id);
  ctx.kafka.failNext(TOPIC, 1);
  await m.relay();
  await settle();
  let seen = values(ctx).filter(e => e.subject === 'ada').map(e => e.type);
  assert(!seen.includes('revoked') || seen.includes('granted'), \`the broker rejected ada's grant and relay published the revoke behind it (\${JSON.stringify(seen)}): a consumer applies the revoke, then the grant, and ada keeps team_admin. Stop at the first failed row\`);
  await m.relay();
  await settle();
  seen = values(ctx).filter(e => e.subject === 'ada').map(e => e.type);
  assert.deepStrictEqual(seen, ['granted', 'revoked'], \`after a rejected delivery and a second relay ada's events are \${JSON.stringify(seen)}, expected the grant, then the revoke\`);
}

export async function check_monotonic_rebuild(ctx) {
  const {m} = events(ctx);
  // Records of different subjects come off different partitions in any order.
  for (const version of [5, 3, 6, 2]) await m.applyEvent(event(version));
  let got = ctx.redis.get('perm:grant_version');
  assert.equal(got, '6', \`after records with grant_version 5, 3, 6, 2 the counter is \${JSON.stringify(got)}, expected 6: a counter wound back makes cache entries stamped since look current again\`);
  ctx.redis.set('perm:grant_version', '9');
  await m.applyEvent(event(7));
  got = ctx.redis.get('perm:grant_version');
  assert.equal(got, '9', \`a record with grant_version 7 moved the counter from 9 to \${JSON.stringify(got)}: the projector only ever raises it\`);
  await m.applyEvent(event(10));
  got = ctx.redis.get('perm:grant_version');
  assert.equal(got, '10', \`a record with grant_version 10 left the counter at \${JSON.stringify(got)} (it was 9): versions compare as numbers\`);
  ctx.redisAfter('perm:grant_version', () => ctx.redis.set('perm:grant_version', '20'));
  await m.applyEvent(event(11));
  got = ctx.redis.get('perm:grant_version');
  assert.equal(got, '20', \`another projector raised the counter to 20 while this one applied grant_version 11, and it ended at \${JSON.stringify(got)}: read and raise it in one atomic step\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"permz/grants"

	"leetbuild/harness"
)

const kHEventsTopic = "permission.event"

var hEventsBg = context.Background()

func hEventValues(ctx *harness.Ctx) []map[string]any {
	var out []map[string]any
	for _, v := range ctx.Kafka.Values(kHEventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &e), "a permission.event value must be JSON, got %s", v)
		out = append(out, e)
	}
	return out
}

func hTypesOf(ctx *harness.Ctx, subject string) []string {
	out := []string{}
	for _, e := range hEventValues(ctx) {
		if e["subject"] == subject {
			out = append(out, fmt.Sprint(e["type"]))
		}
	}
	return out
}

func hEventJSON(version int) []byte {
	raw, _ := json.Marshal(map[string]any{"type": "granted", "grant_id": fmt.Sprintf("g-%d", version), "subject": "ada", "role": "viewer", "scope": "team:eng", "grant_version": version})
	return raw
}

// stalledRelay: bob's row meets a broker that stops answering; relay gives up after the report window, the row pending.
func hStalledRelay(ctx *harness.Ctx) {
	hMustCommit(ctx, "bob", "viewer")
	ctx.Kafka.Stall(kHEventsTopic)
	before := ctx.Clock.Now()
	relay(hEventsBg)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 2.5, "relay waited %.1f s for a broker that does not answer, expected the 2 s delivery-report window", waited)
	held := []string{}
	for _, row := range grants.Pending(hEventsBg) {
		held = append(held, row.Subject)
	}
	ctx.Equal(held, []string{"bob"}, "no delivery report came for bob's row: a row without a report stays pending; the subjects of the pending rows")
}

func hMustCommit(ctx *harness.Ctx, subject, role string) *grants.OutboxRow {
	row, err := grants.CommitGrant(hEventsBg, subject, role, "team:eng", "olu")
	ctx.NoError(err, "CommitGrant(%s, %s)", subject, role)
	return row
}

func CheckSubjectKey(ctx *harness.Ctx) {
	ada := hMustCommit(ctx, "ada", "viewer")
	hMustCommit(ctx, "bob", "viewer")
	grants.CommitRevoke(hEventsBg, ada.GrantID)
	relay(hEventsBg)
	ctx.Settle()
	records := ctx.Kafka.Records(kHEventsTopic)
	ctx.Equal(len(records), 3, "three committed changes must produce three records on permission.event; the records")
	keys := ctx.Kafka.Keys(kHEventsTopic)
	sorted := append([]string{}, keys...)
	sort.Strings(sorted)
	ctx.Equal(sorted, []string{"ada", "ada", "bob"}, "the records must be keyed by the subjects")
	partitions := map[int]bool{}
	for i, r := range records {
		if keys[i] == "ada" {
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(len(partitions), 1, "ada's grant and revoke must share a partition, or a consumer can apply the revoke first; the partitions")
	var granted []map[string]any
	for _, e := range hEventValues(ctx) {
		if e["type"] == "granted" && e["subject"] == "ada" {
			granted = append(granted, e)
		}
	}
	ctx.Equal(granted, []map[string]any{{"type": "granted", "grant_id": "g-1", "subject": "ada", "role": "viewer", "scope": "team:eng", "grant_version": 1}}, "ada's granted event (type, grant_id, subject, role, scope, grant_version)")
	ctx.Equal(len(grants.Pending(hEventsBg)), 0, "every delivered row must be marked sent; the pending rows")
}

func CheckSentAfterAck(ctx *harness.Ctx) {
	hMustCommit(ctx, "ada", "viewer")
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	relay(hEventsBg)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 0, "the broker rejected the record; the records on the topic")
	ctx.Equal(len(grants.Pending(hEventsBg)), 1, "the broker rejected ada's granted event: a row marked sent anyway is lost for good, mark it sent only after its delivery report; the pending rows")
	relay(hEventsBg)
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "the next relay must publish the row the broker rejected; the records")
	ctx.Equal(len(grants.Pending(hEventsBg)), 0, "once delivered the row must be marked sent; the pending rows")
	hStalledRelay(ctx)
}

func CheckStopAtFailure(ctx *harness.Ctx) {
	g := hMustCommit(ctx, "ada", "team_admin")
	grants.CommitRevoke(hEventsBg, g.GrantID)
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	relay(hEventsBg)
	ctx.Settle()
	seen := hTypesOf(ctx, "ada")
	ctx.Assert(len(seen) == 0 || seen[0] == "granted", "the broker rejected ada's grant and relay published the revoke behind it (%v): a consumer applies the revoke, then the grant, and ada keeps team_admin. Stop at the first failed row", seen)
	relay(hEventsBg)
	ctx.Settle()
	ctx.Equal(hTypesOf(ctx, "ada"), []string{"granted", "revoked"}, "after a rejected delivery and a second relay, ada's events in order")
}

func CheckMonotonicRebuild(ctx *harness.Ctx) {
	// Records of different subjects come off different partitions in any order.
	for _, v := range []int{5, 3, 6, 2} {
		ctx.NoError(applyEvent(hEventsBg, hEventJSON(v)), "applyEvent(grant_version %d)", v)
	}
	got, _ := ctx.Redis.Get("perm:grant_version")
	ctx.Equal(got, "6", "after records with grant_version 5, 3, 6, 2 the counter must be 6 (a counter wound back makes cache entries stamped since look current again)")
	ctx.Redis.Set("perm:grant_version", "9")
	ctx.NoError(applyEvent(hEventsBg, hEventJSON(7)), "applyEvent(grant_version 7)")
	got, _ = ctx.Redis.Get("perm:grant_version")
	ctx.Equal(got, "9", "a record with grant_version 7 must leave a counter of 9 alone: the projector only ever raises it")
	ctx.NoError(applyEvent(hEventsBg, hEventJSON(10)), "applyEvent(grant_version 10)")
	got, _ = ctx.Redis.Get("perm:grant_version")
	ctx.Equal(got, "10", "a record with grant_version 10 must raise a counter of 9: versions compare as numbers; the counter")
	ctx.Redis.After("perm:grant_version", func() any {
		ctx.Redis.Set("perm:grant_version", "20")
		return nil
	})
	ctx.NoError(applyEvent(hEventsBg, hEventJSON(11)), "applyEvent(grant_version 11)")
	got, _ = ctx.Redis.Get("perm:grant_version")
	ctx.Equal(got, "20", "another projector raised the counter to 20 while this one applied grant_version 11: read and raise it in one atomic step; the counter")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <string>
#include <vector>

#include "permz/grants.h"

namespace {

const std::string kHEventsTopic = "permission.event";

std::vector<nlohmann::json> hEventValues(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& v : ctx.Kafka.Values(kHEventsTopic)) {
    const auto e = nlohmann::json::parse(v, nullptr, false);
    ctx.Assert(e.is_object(), "a permission.event value must be JSON, got %s", v);
    out.push_back(e);
  }
  return out;
}

std::vector<std::string> hTypesOf(harness::Ctx& ctx, const std::string& subject) {
  std::vector<std::string> out;
  for (const auto& e : hEventValues(ctx)) {
    if (e.value("subject", "") == subject) out.push_back(e.value("type", ""));
  }
  return out;
}

std::string hEventJson(int version) {
  return nlohmann::json{{"type", "granted"}, {"grant_id", "g-" + std::to_string(version)}, {"subject", "ada"}, {"role", "viewer"}, {"scope", "team:eng"}, {"grant_version", version}}.dump();
}

// bob's row meets a broker that stops answering: relay gives up after the report window, the row pending.
void hStalledRelay(harness::Ctx& ctx) {
  grants::commitGrant("bob", "viewer", "team:eng", "olu");
  ctx.Kafka.Stall(kHEventsTopic);
  const int64_t before = ctx.Clock.Now();
  relay();
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 2.5, "relay waited %.1f s for a broker that does not answer, expected the 2 s delivery-report window", waited);
  std::vector<std::string> held;
  for (const grants::OutboxRow& row : grants::pending()) held.push_back(row.subject);
  ctx.Equal(held, {"bob"}, "no delivery report came for bob's row: a row without a report stays pending; the subjects of the pending rows");
}

}  // namespace

void CheckSubjectKey(harness::Ctx& ctx) {
  const grants::OutboxRow ada = grants::commitGrant("ada", "viewer", "team:eng", "olu");
  grants::commitGrant("bob", "viewer", "team:eng", "olu");
  grants::commitRevoke(ada.grant_id);
  relay();
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kHEventsTopic);
  ctx.Equal(records.size(), 3, "three committed changes must produce three records on permission.event; the records");
  const auto keys = ctx.Kafka.Keys(kHEventsTopic);
  std::vector<std::string> sorted(keys.begin(), keys.end());
  std::sort(sorted.begin(), sorted.end());
  ctx.Equal(sorted, {"ada", "ada", "bob"}, "the records must be keyed by the subjects");
  std::set<int> partitions;
  for (size_t i = 0; i < records.size(); i++) {
    if (keys[i] == "ada") partitions.insert(records[i].Partition);
  }
  ctx.Equal(partitions.size(), 1, "ada's grant and revoke must share a partition, or a consumer can apply the revoke first; the partitions");
  std::vector<nlohmann::json> granted;
  for (const auto& e : hEventValues(ctx)) {
    if (e.value("type", "") == "granted" && e.value("subject", "") == "ada") granted.push_back(e);
  }
  const nlohmann::json want = {{"type", "granted"}, {"grant_id", "g-1"}, {"subject", "ada"}, {"role", "viewer"}, {"scope", "team:eng"}, {"grant_version", 1}};
  ctx.Assert(granted.size() == 1 && granted[0] == want, "ada's granted event is %s, expected %s", nlohmann::json(granted).dump(), want.dump());
  ctx.Equal(grants::pending().size(), 0, "every delivered row must be marked sent; the pending rows");
}

void CheckSentAfterAck(harness::Ctx& ctx) {
  grants::commitGrant("ada", "viewer", "team:eng", "olu");
  ctx.Kafka.FailNext(kHEventsTopic, 1);
  relay();
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 0, "the broker rejected the record; the records on the topic");
  ctx.Equal(grants::pending().size(), 1, "the broker rejected ada's granted event: a row marked sent anyway is lost for good, mark it sent only after its delivery report; the pending rows");
  relay();
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1, "the next relay must publish the row the broker rejected; the records");
  ctx.Equal(grants::pending().size(), 0, "once delivered the row must be marked sent; the pending rows");
  hStalledRelay(ctx);
}

void CheckStopAtFailure(harness::Ctx& ctx) {
  const grants::OutboxRow g = grants::commitGrant("ada", "team_admin", "team:eng", "olu");
  grants::commitRevoke(g.grant_id);
  ctx.Kafka.FailNext(kHEventsTopic, 1);
  relay();
  ctx.Settle();
  const auto seen = hTypesOf(ctx, "ada");
  ctx.Assert(seen.empty() || seen[0] == "granted", "the broker rejected ada's grant and relay published the revoke behind it (%v): a consumer applies the revoke, then the grant, and ada keeps team_admin. Stop at the first failed row", seen);
  relay();
  ctx.Settle();
  ctx.Equal(hTypesOf(ctx, "ada"), {"granted", "revoked"}, "after a rejected delivery and a second relay, ada's events in order");
}

void CheckMonotonicRebuild(harness::Ctx& ctx) {
  // Records of different subjects come off different partitions in any order.
  for (const int v : {5, 3, 6, 2}) applyEvent(hEventJson(v));
  ctx.Equal(ctx.Redis.Get("perm:grant_version"), std::optional<std::string>("6"), "after records with grant_version 5, 3, 6, 2 the counter must be 6 (a counter wound back makes cache entries stamped since look current again)");
  ctx.Redis.Set("perm:grant_version", "9");
  applyEvent(hEventJson(7));
  ctx.Equal(ctx.Redis.Get("perm:grant_version"), std::optional<std::string>("9"), "a record with grant_version 7 must leave a counter of 9 alone: the projector only ever raises it");
  applyEvent(hEventJson(10));
  ctx.Equal(ctx.Redis.Get("perm:grant_version"), std::optional<std::string>("10"), "a record with grant_version 10 must raise a counter of 9: versions compare as numbers; the counter");
  ctx.Redis.After("perm:grant_version", [&ctx] { ctx.Redis.Set("perm:grant_version", "20"); });
  applyEvent(hEventJson(11));
  ctx.Equal(ctx.Redis.Get("perm:grant_version"), std::optional<std::string>("20"), "another projector raised the counter to 20 while this one applied grant_version 11: read and raise it in one atomic step; the counter");
}
`,
  },
  hints: [
    'Make the broker reject one record and run the relay twice: the grant never reaches the topic, its revoke does. Replay the topic into an empty Redis and the version counter ends wherever the last partition read left it.',
    "The relay marks a row sent before the flush has heard from the broker, carries on past a failure, and keys by role; the projector writes each record's version with a plain `SET`, whatever the counter already holds.",
    'Per row: `produce(key=row["subject"], on_delivery=…)`, `flush(ACK_TIMEOUT_S)`, then `mark_sent` on success or `break`. In `apply_event`, one Lua script: `SET` the counter only when `tonumber(ARGV[1])` is greater than what it holds.',
  ],
  debrief: `The outbox makes the grant and its event one commit; the relay's job is to move rows to the topic without losing or reordering them. Marking a row only after its delivery report turns a rejected record into a delay. Stopping at the first failure keeps the outbox order, and with the subject as the key, that order survives on the partition, so a revoke cannot overtake its grant. The projector's compare-and-set is what makes a replay safe: partitions arrive in any order, and only a counter that never goes back keeps old cache stamps old. Production relays poll on a schedule, publish batches while keeping per-key order, and alert on outbox age, the number that says events are late.`,
};
