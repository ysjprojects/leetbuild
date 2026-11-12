import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Membership events keyed by service, published on the real expiry',
  concept: 'kafka',
  file: 'events',
  focus: ['discovery', 'kafka', 'consumer', 'reaper'],
  task: `## Task

**Starting point.** The starter produces the \`discovery.event\` membership stream routers and caches
consume: \`publish_event(event)\` produces \`{"kind", "service", "instance_id", "reason"}\` keyed by the
instance id from a producer with \`acks=1\`, and writes the outbox (\`outbox.write\`) when \`produce\`
raises; \`sweep_expired(service)\` announces \`expired\` for every member whose record TTL is below
\`EXPIRY_MARGIN_S\` and drops it from \`sd:members:{service}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** One service's changes land on several partitions and a cache
applies them out of order; a live instance with two seconds left on its record is announced expired;
a broker that lost an acknowledgement gets the event twice; and a delivery that fails after
\`produce\` returned is lost, because only a local enqueue error raises.

- The record key is the **service name**.
- \`sweep_expired\` announces an instance once its record is gone, and once: the existence check and
  the \`SREM\` are one Lua script, and only the sweeper whose \`SREM\` removed the member publishes.
- The producer is **idempotent** with **\`acks=all\`** (in Go, confluent-kafka-go: kafka-go has no
  idempotent producer).
- Wait for the delivery report at most \`ACK_TIMEOUT_S\` (2 s); when it fails or does not come, write
  the outbox row \`(topic, service, event)\` and return \`False\`.`,
  sequence: {
    participants: ['Expiry sweep', 'Redis', 'discovery.event', 'Outbox', 'Membership cache'],
    messages: [
      {
        from: 'Expiry sweep',
        to: 'Redis',
        label: 'EVAL claim: EXISTS sd:checkout:checkout-1 → 0 · SREM sd:members:checkout → 1',
        kind: 'sync',
      },
      {
        from: 'Expiry sweep',
        to: 'discovery.event',
        label: 'produce key=checkout {kind expired} · idempotent · acks=all',
        kind: 'sync',
      },
      {from: 'discovery.event', to: 'Expiry sweep', label: 'delivery report within 2 s', kind: 'reply'},
      {
        from: 'Expiry sweep',
        to: 'Outbox',
        label: 'no report or an error: write (topic, service, event)',
        kind: 'async',
      },
      {from: 'discovery.event', to: 'Membership cache', label: 'one partition per service, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'service-key',
      title: 'Membership events are keyed by service',
      detail:
        "Three events for checkout, payments, checkout carry those keys and the two checkout events share a partition. The starter keys by instance id, which spreads one service's changes over every partition.",
      match: {
        python: {all: [/producer\.produce\(\s*[^\n]*key\s*=\s*event\[["']service["']\]/]},
        typescript: {all: [/key:\s*event\.service\b/]},
        go: {all: [/Key:\s*\[\]byte\(\s*event\.Service\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*Topic\s*,\s*event\.service\s*,/]},
        cpp: {all: [/event\.service\.c_str\(\)\s*,\s*event\.service\.(size|length)\(\)/]},
      },
    },
    {
      id: 'real-expiry',
      title: 'Expired is published once the record is gone, once',
      detail:
        'The sweep claims a member in one script (`EXISTS` on the record, then `SREM` from the members set) and publishes only when the claim returns 1. The starter reads the TTL and announces an instance that still has seconds left.',
      match: {
        python: {all: [/['"]EXISTS['"]/, /['"]SREM['"]/], none: [/r\.ttl\(/]},
        typescript: {all: [/['"]EXISTS['"]/, /['"]SREM['"]/], none: [/redis\.ttl\(/]},
        go: {all: [/['"]EXISTS['"]/, /['"]SREM['"]/], none: [/rdb\.TTL\(/]},
        scala: {all: [/['"]EXISTS['"]/, /['"]SREM['"]/], none: [/jedis\.ttl\(/]},
        cpp: {all: [/['"]EXISTS['"]/, /['"]SREM['"]/], none: [/redis\.ttl\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once, and a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox-on-failure',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A failed delivery, or no report within 2 s, leaves an outbox row with the topic, the service and the event, and the call returns false. The starter only catches the errors `produce` raises locally, so a failed delivery vanishes.',
      match: {
        python: {
          all: [/outbox\.write\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/outbox\.write\(/, /await producer\.send\(/, /catch/], none: [/void producer\.send\(/]},
        go: {all: [/outbox\.Write\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.write\(/, /\.get\(\s*[^\n]*TimeUnit/], none: [/case _: KafkaException/]},
        cpp: {all: [/outbox::write\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from confluent_kafka import KafkaException, Producer

from discovery import instances  # members, record_key, members_key
from discovery import outbox  # write(topic, key, payload)

TOPIC = "discovery.event"
EXPIRY_MARGIN_S = 5

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def publish_event(event: dict) -> bool:
    """Produce one membership event {kind, service, instance_id, reason}; True when it is on its way."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    try:
        producer.produce(TOPIC, key=event["instance_id"], value=json.dumps(event))
        producer.poll(0)
    except KafkaException:
        outbox.write(TOPIC, event["instance_id"], event)
        return False
    return True


def sweep_expired(service: str) -> list[str]:
    """Announce the members of service whose record has lapsed; returns their ids."""
    expired = []
    for instance_id in instances.members(service):
        if r.ttl(instances.record_key(service, instance_id)) < EXPIRY_MARGIN_S:
            r.srem(instances.members_key(service), instance_id)
            publish_event({"kind": "expired", "service": service, "instance_id": instance_id, "reason": "heartbeat TTL lapsed"})
            expired.append(instance_id)
    return expired
`,
      solution: `import json

import redis
from confluent_kafka import Producer

from discovery import instances  # members, record_key, members_key
from discovery import outbox  # write(topic, key, payload)

TOPIC = "discovery.event"
ACK_TIMEOUT_S = 2

r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the event before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})

# KEYS[1] the record, KEYS[2] the members set, ARGV[1] the instance id. The expiry is claimed only
# while the record is gone, and only by the sweeper whose SREM removed the member.
CLAIM_LUA = """
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
return redis.call('SREM', KEYS[2], ARGV[1])
"""
claim = r.register_script(CLAIM_LUA)


def publish_event(event: dict) -> bool:
    """Produce one membership event {kind, service, instance_id, reason}; True once the broker acknowledged it."""
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    # Keyed by service: one service's changes share a partition, so caches apply them in order.
    producer.produce(TOPIC, key=event["service"], value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay republishes the row, so the change is late, not lost.
        outbox.write(TOPIC, event["service"], event)
        return False
    return True


def sweep_expired(service: str) -> list[str]:
    """Announce the members of service whose record has lapsed; returns their ids."""
    expired = []
    for instance_id in instances.members(service):
        keys = [instances.record_key(service, instance_id), instances.members_key(service)]
        if claim(keys=keys, args=[instance_id]) != 1:
            continue  # still alive, re-registered, or another sweeper announced it
        publish_event({"kind": "expired", "service": service, "instance_id": instance_id, "reason": "heartbeat TTL lapsed"})
        expired.append(instance_id)
    return expired
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import * as instances from 'discovery/instances'; // members, recordKey, membersKey
import * as outbox from 'discovery/outbox'; // write(topic, key, payload)

export const TOPIC = 'discovery.event';
export const EXPIRY_MARGIN_S = 5;

export type MembershipEvent = {kind: string; service: string; instance_id: string; reason: string};

const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'discoveryd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Produce one membership event; true when it is on its way. */
export async function publishEvent(event: MembershipEvent): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  try {
    void producer.send({topic: TOPIC, messages: [{key: event.instance_id, value: JSON.stringify(event)}], acks: 1});
  } catch {
    await outbox.write(TOPIC, event.instance_id, event);
    return false;
  }
  return true;
}

/** Announce the members of service whose record has lapsed; returns their ids. */
export async function sweepExpired(service: string): Promise<string[]> {
  const expired: string[] = [];
  for (const instanceId of await instances.members(service)) {
    if ((await redis.ttl(instances.recordKey(service, instanceId))) < EXPIRY_MARGIN_S) {
      await redis.srem(instances.membersKey(service), instanceId);
      await publishEvent({kind: 'expired', service, instance_id: instanceId, reason: 'heartbeat TTL lapsed'});
      expired.push(instanceId);
    }
  }
  return expired;
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import * as instances from 'discovery/instances'; // members, recordKey, membersKey
import * as outbox from 'discovery/outbox'; // write(topic, key, payload)

export const TOPIC = 'discovery.event';
export const ACK_TIMEOUT_MS = 2000;

export type MembershipEvent = {kind: string; service: string; instance_id: string; reason: string};

// KEYS[1] the record, KEYS[2] the members set, ARGV[1] the instance id. The expiry is claimed only
// while the record is gone, and only by the sweeper whose SREM removed the member.
export const CLAIM_LUA = \`
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
return redis.call('SREM', KEYS[2], ARGV[1])
\`;

interface ClaimRedis extends Redis {
  claimExpired(record: string, members: string, instanceId: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ClaimRedis;
redis.defineCommand('claimExpired', {numberOfKeys: 2, lua: CLAIM_LUA});

const kafka = new Kafka({clientId: 'discoveryd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Produce one membership event; true once the broker acknowledged it. */
export async function publishEvent(event: MembershipEvent): Promise<boolean> {
  try {
    // Keyed by service: one service's changes share a partition, so caches apply them in order.
    await producer.send({
      topic: TOPIC,
      messages: [{key: event.service, value: JSON.stringify(event)}],
      acks: -1, // every in-sync replica has the event before the broker answers
      timeout: ACK_TIMEOUT_MS,
    });
    return true;
  } catch {
    // The broker did not take it: the relay republishes the row, so the change is late, not lost.
    await outbox.write(TOPIC, event.service, event);
    return false;
  }
}

/** Announce the members of service whose record has lapsed; returns their ids. */
export async function sweepExpired(service: string): Promise<string[]> {
  const expired: string[] = [];
  for (const instanceId of await instances.members(service)) {
    const claimed = await redis.claimExpired(instances.recordKey(service, instanceId), instances.membersKey(service), instanceId);
    if (claimed !== 1) continue; // still alive, re-registered, or another sweeper announced it
    await publishEvent({kind: 'expired', service, instance_id: instanceId, reason: 'heartbeat TTL lapsed'});
    expired.push(instanceId);
  }
  return expired;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"discovery/instances" // instances.Members, RecordKey, MembersKey
	"discovery/outbox"    // outbox.Write(ctx, topic, key, payload)
)

const (
	topic        = "discovery.event"
	expiryMargin = 5 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

type membershipEvent struct {
	Kind       string \`json:"kind"\`
	Service    string \`json:"service"\`
	InstanceID string \`json:"instance_id"\`
	Reason     string \`json:"reason"\`
}

// publishEvent produces one membership event; true when it is on its way.
func publishEvent(ctx context.Context, event membershipEvent) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(event.InstanceID), Value: value}
	if err := producer.Produce(msg, nil); err != nil {
		return false, outbox.Write(ctx, topic, event.InstanceID, event)
	}
	return true, nil
}

// sweepExpired announces the members of service whose record has lapsed and returns their ids.
func sweepExpired(ctx context.Context, service string) ([]string, error) {
	ids, err := instances.Members(ctx, service)
	if err != nil {
		return nil, err
	}
	expired := []string{}
	for _, id := range ids {
		ttl, err := rdb.TTL(ctx, instances.RecordKey(service, id)).Result()
		if err != nil {
			return nil, err
		}
		if ttl >= expiryMargin {
			continue
		}
		rdb.SRem(ctx, instances.MembersKey(service), id)
		if _, err := publishEvent(ctx, membershipEvent{Kind: "expired", Service: service, InstanceID: id, Reason: "heartbeat TTL lapsed"}); err != nil {
			return nil, err
		}
		expired = append(expired, id)
	}
	return expired, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/redis/go-redis/v9"

	"discovery/instances" // instances.Members, RecordKey, MembersKey
	"discovery/outbox"    // outbox.Write(ctx, topic, key, payload)
)

const (
	topic      = "discovery.event"
	ackTimeout = 2 * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// claimScript: KEYS[1] the record, KEYS[2] the members set, ARGV[1] the instance id. The expiry is
// claimed only while the record is gone, and only by the sweeper whose SREM removed the member.
var claimScript = redis.NewScript(\`
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
return redis.call('SREM', KEYS[2], ARGV[1])
\`)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the event before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

type membershipEvent struct {
	Kind       string \`json:"kind"\`
	Service    string \`json:"service"\`
	InstanceID string \`json:"instance_id"\`
	Reason     string \`json:"reason"\`
}

// publishEvent produces one membership event; true once the broker acknowledged it.
func publishEvent(ctx context.Context, event membershipEvent) (bool, error) {
	value, _ := json.Marshal(event)
	t := topic
	// Keyed by service: one service's changes share a partition, so caches apply them in order.
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(event.Service), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = context.DeadlineExceeded // no delivery report within the window
		}
	}
	if err != nil {
		// The broker did not take it: the relay republishes the row, so the change is late, not lost.
		return false, outbox.Write(ctx, topic, event.Service, event)
	}
	return true, nil
}

// sweepExpired announces the members of service whose record has lapsed and returns their ids.
func sweepExpired(ctx context.Context, service string) ([]string, error) {
	ids, err := instances.Members(ctx, service)
	if err != nil {
		return nil, err
	}
	expired := []string{}
	for _, id := range ids {
		claimed, err := claimScript.Run(ctx, rdb, []string{instances.RecordKey(service, id), instances.MembersKey(service)}, id).Int()
		if err != nil {
			return nil, err
		}
		if claimed != 1 {
			continue // still alive, re-registered, or another sweeper announced it
		}
		if _, err := publishEvent(ctx, membershipEvent{Kind: "expired", Service: service, InstanceID: id, Reason: "heartbeat TTL lapsed"}); err != nil {
			return nil, err
		}
		expired = append(expired, id)
	}
	return expired, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.KafkaException
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import discovery.{Instances, Outbox} // Instances.members, recordKey, membersKey · Outbox.write(topic, key, payload)

object Events {
  val Topic = "discovery.event"
  val ExpiryMarginS = 5L

  final case class MembershipEvent(kind: String, service: String, instanceId: String, reason: String) {
    def toJson: JsObject =
      JsObject("kind" -> JsString(kind), "service" -> JsString(service), "instance_id" -> JsString(instanceId), "reason" -> JsString(reason))
  }

  val jedis = new JedisPooled("redis", 6379)

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Produce one membership event; true when it is on its way. */
  def publishEvent(event: MembershipEvent): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    try {
      producer.send(new ProducerRecord[String, String](Topic, event.instanceId, event.toJson.compactPrint))
      true
    } catch {
      case _: KafkaException =>
        Outbox.write(Topic, event.instanceId, event.toJson)
        false
    }
  }

  /** Announce the members of service whose record has lapsed; returns their ids. */
  def sweepExpired(service: String): Seq[String] =
    Instances.members(service).filter { instanceId =>
      val lapsing = jedis.ttl(Instances.recordKey(service, instanceId)) < ExpiryMarginS
      if (lapsing) {
        jedis.srem(Instances.membersKey(service), instanceId)
        publishEvent(MembershipEvent("expired", service, instanceId, "heartbeat TTL lapsed"))
      }
      lapsing
    }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.jdk.CollectionConverters._
import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import discovery.{Instances, Outbox} // Instances.members, recordKey, membersKey · Outbox.write(topic, key, payload)

object Events {
  val Topic = "discovery.event"
  val AckTimeoutMs = 2000L

  final case class MembershipEvent(kind: String, service: String, instanceId: String, reason: String) {
    def toJson: JsObject =
      JsObject("kind" -> JsString(kind), "service" -> JsString(service), "instance_id" -> JsString(instanceId), "reason" -> JsString(reason))
  }

  val jedis = new JedisPooled("redis", 6379)

  /**
   * KEYS[1] the record, KEYS[2] the members set, ARGV[1] the instance id. The expiry is claimed only
   * while the record is gone, and only by the sweeper whose SREM removed the member.
   */
  val ClaimLua: String =
    """if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
      |return redis.call('SREM', KEYS[2], ARGV[1])
      |""".stripMargin

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the event before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Produce one membership event; true once the broker acknowledged it. */
  def publishEvent(event: MembershipEvent): Boolean = {
    // Keyed by service: one service's changes share a partition, so caches apply them in order.
    val record = new ProducerRecord[String, String](Topic, event.service, event.toJson.compactPrint)
    val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
    if (acked.isFailure) {
      // The broker did not take it: the relay republishes the row, so the change is late, not lost.
      Outbox.write(Topic, event.service, event.toJson)
    }
    acked.isSuccess
  }

  /** Announce the members of service whose record has lapsed; returns their ids. */
  def sweepExpired(service: String): Seq[String] =
    Instances.members(service).filter { instanceId =>
      val keys = List(Instances.recordKey(service, instanceId), Instances.membersKey(service)).asJava
      // Still alive, re-registered, or another sweeper announced it: the claim returns 0.
      val claimed = jedis.eval(ClaimLua, keys, List(instanceId).asJava).asInstanceOf[java.lang.Long] == 1L
      if (claimed) publishEvent(MembershipEvent("expired", service, instanceId, "heartbeat TTL lapsed"))
      claimed
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>
#include <vector>

#include "discovery/instances.h"  // instances::members, recordKey, membersKey
#include "discovery/outbox.h"     // outbox::write(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "discovery.event";
constexpr long long kExpiryMarginS = 5;

sw::redis::Redis redis("tcp://redis:6379");

struct MembershipEvent {
  std::string kind, service, instance_id, reason;
};

json toJson(const MembershipEvent& e) {
  return json{{"kind", e.kind}, {"service", e.service}, {"instance_id", e.instance_id}, {"reason", e.reason}};
}

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Produce one membership event; true when it is on its way.
bool publishEvent(const MembershipEvent& event) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string value = toJson(event).dump();
  const RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), event.instance_id.c_str(), event.instance_id.size(), 0, nullptr);
  producer->poll(0);
  if (err != RdKafka::ERR_NO_ERROR) {
    outbox::write(kTopic, event.instance_id, toJson(event));
    return false;
  }
  return true;
}

// Announce the members of service whose record has lapsed; returns their ids.
std::vector<std::string> sweepExpired(const std::string& service) {
  std::vector<std::string> expired;
  for (const std::string& instance_id : instances::members(service)) {
    if (redis.ttl(instances::recordKey(service, instance_id)) >= kExpiryMarginS) continue;
    redis.srem(instances::membersKey(service), instance_id);
    publishEvent({"expired", service, instance_id, "heartbeat TTL lapsed"});
    expired.push_back(instance_id);
  }
  return expired;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <memory>
#include <string>
#include <vector>

#include "discovery/instances.h"  // instances::members, recordKey, membersKey
#include "discovery/outbox.h"     // outbox::write(topic, key, payload)

using json = nlohmann::json;

const std::string kTopic = "discovery.event";
constexpr int kAckTimeoutMs = 2000;

sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] the record, KEYS[2] the members set, ARGV[1] the instance id. The expiry is claimed only
// while the record is gone, and only by the sweeper whose SREM removed the member.
const std::string kClaimLua = R"lua(
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
return redis.call('SREM', KEYS[2], ARGV[1])
)lua";

struct MembershipEvent {
  std::string kind, service, instance_id, reason;
};

json toJson(const MembershipEvent& e) {
  return json{{"kind", e.kind}, {"service", e.service}, {"instance_id", e.instance_id}, {"reason", e.reason}};
}

// The delivery report of the record in flight: publishEvent produces one record and waits for it.
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
  conf->set("acks", "all", err);                // every in-sync replica has the event before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

// Produce one membership event; true once the broker acknowledged it.
bool publishEvent(const MembershipEvent& event) {
  const json payload = toJson(event);
  const std::string value = payload.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  // Keyed by service: one service's changes share a partition, so caches apply them in order.
  RdKafka::ErrorCode err =
      producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                        value.size(), event.service.c_str(), event.service.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay republishes the row, so the change is late, not lost.
    outbox::write(kTopic, event.service, payload);
    return false;
  }
  return true;
}

// Announce the members of service whose record has lapsed; returns their ids.
std::vector<std::string> sweepExpired(const std::string& service) {
  std::vector<std::string> expired;
  for (const std::string& instance_id : instances::members(service)) {
    const bool claimed =
        redis.eval<long long>(kClaimLua, {instances::recordKey(service, instance_id), instances::membersKey(service)}, {instance_id}) == 1;
    if (!claimed) continue;  // still alive, re-registered, or another sweeper announced it
    publishEvent({"expired", service, instance_id, "heartbeat TTL lapsed"});
    expired.push_back(instance_id);
  }
  return expired;
}
`,
    },
  },
  harness: {
    python: `import json

from discovery import instances

TOPIC = "discovery.event"


def _event(instance_id, service="checkout", kind="registered"):
    return {"kind": kind, "service": service, "instance_id": instance_id, "reason": "registered by checkout-agent"}


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("sd:outbox", 0, -1)]


def check_service_key(ctx):
    m = ctx.load("events")
    m.publish_event(_event("checkout-1"))
    m.publish_event(_event("payments-1", "payments"))
    m.publish_event(_event("checkout-2"))
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three publish_event calls produced {len(records)} records on discovery.event"
    keys = [r.key for r in records]
    assert keys == [b"checkout", b"payments", b"checkout"], f"the records are keyed {keys}, expected the service names checkout, payments, checkout"
    assert records[0].partition == records[2].partition, "both checkout events must land on one partition, or a cache applies checkout's changes out of order"


def check_real_expiry(ctx):
    m = ctx.load("events")
    instances.register_instance("checkout", "checkout-1", "10.4.2.1", 8080, 2, 1)  # expires after 6 s
    instances.register_instance("checkout", "checkout-2", "10.4.2.2", 8080, 3, 1)  # expires after 9 s
    instances.register_instance("checkout", "checkout-3", "10.4.2.3", 8080, 10, 1)  # expires after 30 s
    ctx.clock.advance(7)
    expired = m.sweep_expired("checkout")
    assert sorted(expired) == ["checkout-1"], f"7 s in, only checkout-1's record has lapsed and the sweep announced {expired}: checkout-2 has 2 s left and is alive"
    events = [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]
    assert [(e.get("kind"), e.get("instance_id")) for e in events] == [("expired", "checkout-1")], f"the sweep produced {events}, expected one expired event for checkout-1"
    members = sorted(ctx.redis.smembers("sd:members:checkout"))
    assert members == ["checkout-2", "checkout-3"], f"sd:members:checkout holds {members} after the sweep, expected the live checkout-2 and checkout-3"
    again = m.sweep_expired("checkout")
    assert again == [] and len(ctx.kafka.records(TOPIC)) == 1, f"a second sweep announced {again}: an expiry is announced once"


def check_acks_idempotent(ctx):
    m = ctx.load("events")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.publish_event(_event("checkout-1"))
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement the topic holds {len(ctx.kafka.records(TOPIC))} records: the producer's retry wrote the event twice. Enable idempotence"
    m.publish_event(_event("checkout-2"))
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the event the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox_on_failure(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_event(_event("checkout-1"))
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and the outbox holds {len(rows)} rows: without a row the change never reaches a membership cache"
    assert rows[0].get("topic") == TOPIC and rows[0].get("key") == "checkout" and rows[0].get("payload", {}).get("instance_id") == "checkout-1", f"the outbox row is {rows[0]}, expected the topic, the key checkout and the event"
    assert ok is False, f"publish_event returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_event(_event("checkout-2"))
    waited = ctx.clock.time() - before
    assert waited <= 5, f"publish_event waited {waited:.0f} s for a broker that does not answer: wait for the delivery report at most 2 s, then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and rows[1].get("payload", {}).get("instance_id") == "checkout-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"publish_event returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'discovery.event';

const event = (instanceId: string, service = 'checkout', kind = 'registered') => ({kind, service, instance_id: instanceId, reason: 'registered by checkout-agent'});

const outboxRows = ctx => (ctx.redis.lrange('sd:outbox', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_service_key(ctx) {
  const m = ctx.load('events');
  await m.publishEvent(event('checkout-1'));
  await m.publishEvent(event('payments-1', 'payments'));
  await m.publishEvent(event('checkout-2'));
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three publishEvent calls produced \${records.length} records on discovery.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepEqual(keys, ['checkout', 'payments', 'checkout'], \`the records are keyed \${JSON.stringify(keys)}, expected the service names checkout, payments, checkout\`);
  assert.equal(records[0].partition, records[2].partition, "both checkout events must land on one partition, or a cache applies checkout's changes out of order");
}

export async function check_real_expiry(ctx) {
  const m = ctx.load('events');
  const instances = ctx.load('/support/discovery/instances.ts');
  await instances.registerInstance('checkout', 'checkout-1', '10.4.2.1', 8080, 2, 1); // expires after 6 s
  await instances.registerInstance('checkout', 'checkout-2', '10.4.2.2', 8080, 3, 1); // expires after 9 s
  await instances.registerInstance('checkout', 'checkout-3', '10.4.2.3', 8080, 10, 1); // expires after 30 s
  ctx.clock.advance(7);
  const expired = await m.sweepExpired('checkout');
  await settle();
  assert.deepEqual([...expired].sort(), ['checkout-1'], \`7 s in, only checkout-1's record has lapsed and the sweep announced \${JSON.stringify(expired)}: checkout-2 has 2 s left and is alive\`);
  const events = ctx.kafka.values(TOPIC).map(v => JSON.parse(v));
  assert.deepEqual(events.map(e => [e.kind, e.instance_id]), [['expired', 'checkout-1']], \`the sweep produced \${JSON.stringify(events)}, expected one expired event for checkout-1\`);
  const members = (ctx.redis.smembers('sd:members:checkout') as string[]).sort();
  assert.deepEqual(members, ['checkout-2', 'checkout-3'], \`sd:members:checkout holds \${JSON.stringify(members)} after the sweep, expected the live checkout-2 and checkout-3\`);
  const again = await m.sweepExpired('checkout');
  await settle();
  assert(again.length === 0 && ctx.kafka.records(TOPIC).length === 1, \`a second sweep announced \${JSON.stringify(again)}: an expiry is announced once\`);
}

export async function check_acks_idempotent(ctx) {
  const m = ctx.load('events');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.publishEvent(event('checkout-1'));
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement the topic holds \${ctx.kafka.records(TOPIC).length} records: the producer's retry wrote the event twice. Enable idempotence\`);
  await m.publishEvent(event('checkout-2'));
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the event the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox_on_failure(ctx) {
  const m = ctx.load('events');
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishEvent(event('checkout-1'));
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and the outbox holds \${rows.length} rows: without a row the change never reaches a membership cache\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'checkout' && rows[0].payload?.instance_id === 'checkout-1', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key checkout and the event\`);
  assert.equal(ok, false, \`publishEvent resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishEvent(event('checkout-2'));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`publishEvent waited \${waited.toFixed(0)} s for a broker that does not answer: wait for the delivery report at most 2 s, then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].payload?.instance_id === 'checkout-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`publishEvent resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"

	"discovery/instances"

	"leetbuild/harness"
)

const eventsTopic = "discovery.event"

var eventsBg = context.Background()

func eventFor(instanceID, service string) membershipEvent {
	return membershipEvent{Kind: "registered", Service: service, InstanceID: instanceID, Reason: "registered by checkout-agent"}
}

func eventsPublish(ctx *harness.Ctx, event membershipEvent) bool {
	ok, err := publishEvent(eventsBg, event)
	ctx.NoError(err, "publishEvent")
	return ok
}

type eventsRow struct {
	Topic   string         \`json:"topic"\`
	Key     string         \`json:"key"\`
	Payload map[string]any \`json:"payload"\`
}

func eventsOutbox(ctx *harness.Ctx) []eventsRow {
	var rows []eventsRow
	for _, text := range ctx.Redis.LRange("sd:outbox", 0, -1) {
		var row eventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		rows = append(rows, row)
	}
	return rows
}

func CheckServiceKey(ctx *harness.Ctx) {
	eventsPublish(ctx, eventFor("checkout-1", "checkout"))
	eventsPublish(ctx, eventFor("payments-1", "payments"))
	eventsPublish(ctx, eventFor("checkout-2", "checkout"))
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 3, "three publishEvent calls must produce three records on discovery.event; the records")
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"checkout", "payments", "checkout"}, "the records must be keyed by the service names")
	ctx.Equal(records[0].Partition, records[2].Partition, "both checkout events must land on one partition, or a cache applies checkout's changes out of order; the partitions")
}

func CheckRealExpiry(ctx *harness.Ctx) {
	for _, r := range []struct {
		id       string
		interval int
	}{{"checkout-1", 2}, {"checkout-2", 3}, {"checkout-3", 10}} { // expiring after 6, 9 and 30 s
		_, err := instances.RegisterInstance(eventsBg, "checkout", r.id, "10.4.2.1", 8080, r.interval, 1)
		ctx.NoError(err, "registering %s", r.id)
	}
	ctx.Clock.Advance(7)
	expired, err := sweepExpired(eventsBg, "checkout")
	ctx.NoError(err, "sweepExpired(checkout)")
	sort.Strings(expired)
	ctx.Equal(expired, []string{"checkout-1"}, "7 s in, only checkout-1's record has lapsed (checkout-2 has 2 s left and is alive); the sweep announced")
	var kinds []string
	for _, v := range ctx.Kafka.Values(eventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &e), "an event must be JSON")
		kinds = append(kinds, e["kind"].(string)+" "+e["instance_id"].(string))
	}
	ctx.Equal(kinds, []string{"expired checkout-1"}, "the sweep must produce one expired event for checkout-1; the events")
	ctx.Equal(ctx.Redis.SMembers("sd:members:checkout"), []string{"checkout-2", "checkout-3"}, "sd:members:checkout after the sweep must hold the live checkout-2 and checkout-3")
	again, err := sweepExpired(eventsBg, "checkout")
	ctx.NoError(err, "the second sweepExpired(checkout)")
	ctx.Assert(len(again) == 0 && len(ctx.Kafka.Records(eventsTopic)) == 1, "a second sweep announced %v: an expiry is announced once", again)
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	ctx.Kafka.LoseAcks(eventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	eventsPublish(ctx, eventFor("checkout-1", "checkout"))
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 1, "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records")
	eventsPublish(ctx, eventFor("checkout-2", "checkout"))
	ctx.Settle()
	ctx.Kafka.Failover(eventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(eventsTopic)), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records")
}

func CheckOutboxOnFailure(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, eventFor("checkout-1", "checkout"))
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the change never reaches a membership cache; the rows")
	ctx.Assert(rows[0].Topic == eventsTopic && rows[0].Key == "checkout" && rows[0].Payload["instance_id"] == "checkout-1", "the outbox row is %v, expected the topic, the key checkout and the event", rows[0])
	ctx.Equal(ok, false, "publishEvent's result after a failed delivery")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, eventFor("checkout-2", "checkout"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "publishEvent waited %.0f s for a broker that does not answer: wait for the delivery report at most 2 s, then write the outbox row", waited)
	rows = eventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Payload["instance_id"] == "checkout-2", "no delivery report within the window and the outbox holds %v", rows)
	ctx.Equal(ok, false, "publishEvent's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "discovery/instances.h"

namespace {

const std::string kEventsTopic = "discovery.event";

MembershipEvent eventFor(const std::string& instance_id, const std::string& service = "checkout") {
  return MembershipEvent{"registered", service, instance_id, "registered by checkout-agent"};
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("sd:outbox", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with topic, key and payload, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string eventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckServiceKey(harness::Ctx& ctx) {
  publishEvent(eventFor("checkout-1"));
  publishEvent(eventFor("payments-1", "payments"));
  publishEvent(eventFor("checkout-2"));
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 3, "three publishEvent calls must produce three records on discovery.event; the records");
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"checkout", "payments", "checkout"}, "the records must be keyed by the service names");
  ctx.Equal(records[0].Partition, records[2].Partition,
            "both checkout events must land on one partition, or a cache applies checkout's changes out of order; the partitions");
}

void CheckRealExpiry(harness::Ctx& ctx) {
  // Expiring after 6, 9 and 30 s.
  for (const auto& [instance_id, interval] : std::vector<std::pair<std::string, long>>{{"checkout-1", 2}, {"checkout-2", 3}, {"checkout-3", 10}}) {
    instances::registerInstance("checkout", instance_id, "10.4.2.1", 8080, interval, 1);
  }
  ctx.Clock.Advance(7);
  auto expired = sweepExpired("checkout");
  std::sort(expired.begin(), expired.end());
  ctx.Equal(expired, {"checkout-1"}, "7 s in, only checkout-1's record has lapsed (checkout-2 has 2 s left and is alive); the sweep announced");
  std::vector<std::string> kinds;
  for (const auto& v : ctx.Kafka.Values(kEventsTopic)) {
    const auto e = nlohmann::json::parse(v, nullptr, false);
    kinds.push_back(eventsField(e, "kind") + " " + eventsField(e, "instance_id"));
  }
  ctx.Equal(kinds, {"expired checkout-1"}, "the sweep must produce one expired event for checkout-1; the events");
  ctx.Equal(ctx.Redis.SMembers("sd:members:checkout"), {"checkout-2", "checkout-3"}, "sd:members:checkout after the sweep must hold the live checkout-2 and checkout-3");
  const auto again = sweepExpired("checkout");
  ctx.Assert(again.empty() && ctx.Kafka.Records(kEventsTopic).size() == 1, "a second sweep announced %q: an expiry is announced once", again);
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  ctx.Kafka.LoseAcks(kEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  publishEvent(eventFor("checkout-1"));
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 1,
            "after one lost acknowledgement the producer's retry must not write the event twice (enable.idempotence); the records");
  publishEvent(eventFor("checkout-2"));
  ctx.Settle();
  ctx.Kafka.Failover(kEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kEventsTopic).size(), 2, "a leader failover must not lose an event (acks=all waits for every in-sync replica); the records");
}

void CheckOutboxOnFailure(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishEvent(eventFor("checkout-1"));
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the change never reaches a membership cache; the rows");
  ctx.Assert(eventsField(rows[0], "topic") == kEventsTopic && eventsField(rows[0], "key") == "checkout" && rows[0].contains("payload") &&
                 eventsField(rows[0]["payload"], "instance_id") == "checkout-1",
             "the outbox row is %s, expected the topic, the key checkout and the event", rows[0].dump());
  ctx.Equal(ok, false, "publishEvent's result after a failed delivery");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishEvent(eventFor("checkout-2"));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "publishEvent waited %.0f s for a broker that does not answer: wait for the delivery report at most 2 s, then write the outbox row", waited);
  rows = eventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("payload") && eventsField(rows[1]["payload"], "instance_id") == "checkout-2",
             "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "publishEvent's result without a delivery report");
}
`,
  },
  hints: [
    "A router's cache shows checkout-2 removed and then re-added in the wrong order, a healthy pod drops out of it every few seconds, and after a broker restart some membership changes never arrive.",
    'The key decides the partition, and it is the instance id. The sweep treats "expires soon" as expired. The `except KafkaException` around `produce` only sees local enqueue errors: the delivery is reported later, to a callback nobody registered.',
    'Key by `event["service"]`; claim each member with one script (`EXISTS` on the record → 0, else `SREM`) and publish only on 1; set `enable.idempotence` and `acks=all`; on a failed `on_delivery` or anything left after `flush(ACK_TIMEOUT_S)`, `outbox.write` and return False.',
  ],
  debrief: `The key is an ordering contract: a cache rebuilds a service's membership by applying its events in order, and Kafka orders only within a partition. An \`expired\` event states a fact, so it follows the record's disappearance instead of a prediction, and the claim script makes it happen once across every sweeper: the \`SREM\`'s return value says who won. Waiting for the delivery report is what gives the return value a meaning, and the outbox turns a broker outage into a delay instead of a hole in membership history; idempotence closes the gap waiting opens, a retry after a lost acknowledgement. Production registries also publish periodic full snapshots of each service, so a cache that missed events can resynchronise without replaying the topic.`,
};
