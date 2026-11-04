import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'flag.event: keyed by flag, after the commit, outbox on the delivery report',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'redis', 'kafka', 'consumer'],
  task: `## Task

**Starting point.** The starter puts a stored flag live and announces it:
\`apply_change(flag_key, actor)\` loads the definition (\`store.load\`), builds the next snapshot
version, produces \`change_event(definition, version, actor)\` to \`flag.event\` keyed by the
environment (\`"prod"\`), RPUSHes to \`flags:outbox\` if the produce raises, and only then calls
\`engine.publish_snapshot\`. A change shows up on the topic; it hides four flaws.

**Failure mode the checks target.** One flag's events land on whatever partition the environment
hashes to, mixed with every other flag's. A consumer hears of a version the engine never committed
when another publish wins the race. The targeting rules, user id lists included, go into a retained
topic. A broker that rejects the record after accepting it leaves no outbox row.

- The record key is the **flag key**.
- The payload is \`{type: "flag.changed", flag_key, version, flag_version, rollout, rule_attributes,
  actor}\`: \`rule_attributes\` is the sorted, distinct list of attributes the rules target; no rule
  values.
- \`engine.publish_snapshot\` first; when it answers false, return None and produce nothing.
- A delivery failure arrives in the delivery report (\`on_delivery\`, a rejected \`send\`, the error
  \`WriteMessages\` returns with \`Async\` off, \`dr_cb\`, a \`Callback\`): RPUSH \`{"key", "payload"}\` to
  \`flags:outbox\` from there. The answer is still the event: the change is live.`,
  sequence: {
    participants: ['flagsvc', 'Redis', 'flag.event', 'Audit · analytics'],
    messages: [
      {from: 'flagsvc', to: 'Redis', label: 'GET flags:snapshot → v41', kind: 'sync'},
      {from: 'flagsvc', to: 'Redis', label: 'publish_snapshot(v42) → 1', kind: 'sync'},
      {
        from: 'flagsvc',
        to: 'flag.event',
        label: 'produce · key = checkout · {version 42, rule_attributes}',
        kind: 'sync',
      },
      {from: 'flag.event', to: 'flagsvc', label: 'delivery report · error → RPUSH flags:outbox', kind: 'reply'},
      {from: 'flag.event', to: 'Audit · analytics', label: 'one partition per flag, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'flag-key',
      title: 'Keyed by flag key',
      detail:
        "The record key is the flag key (`key=flag_key`, `key: flagKey`, `[]byte(flagKey)`, `ProducerRecord(topic, flagKey, …)`), so one flag's history stays on one partition, in order; the starter keys by environment.",
      match: {
        python: {all: [/key=flag_key/, /flag\.event/], none: [/key=ENVIRONMENT/]},
        typescript: {all: [/key:\s*flagKey\b/, /flag\.event/], none: [/key:\s*ENVIRONMENT/]},
        go: {all: [/Key:\s*\[\]byte\(flagKey\)/, /flag\.event/], none: [/Key:\s*\[\]byte\(environment\)/]},
        scala: {
          all: [/ProducerRecord\[String, String\]\(EventTopic,\s*flagKey/, /flag\.event/],
          none: [/EventTopic,\s*Environment/],
        },
        cpp: {all: [/flag_key\.c_str\(\),\s*flag_key\.size\(\)/, /flag\.event/], none: [/kEnvironment\.c_str\(\)/]},
      },
    },
    {
      id: 'after-commit',
      title: 'Produces only after the snapshot commits',
      detail:
        '`apply_change` calls `publish_snapshot`/`publishSnapshot` and produces only once it answered true; the starter produces first, so a change that lost the race is announced anyway.',
      match: {
        python: {order: [/def apply_change\(/, /engine\.publish_snapshot\(/, /producer\.produce\(/]},
        typescript: {order: [/function applyChange\(/, /publishSnapshot\(/, /producer\.send\(/]},
        go: {order: [/func applyChange\(/, /engine\.PublishSnapshot\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/def applyChange\(/, /Engine\.publishSnapshot\(/, /producer\.send\(/]},
        cpp: {order: [/applyChange\(const/, /engine::publishSnapshot\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'no-targets',
      title: 'Names the targeted attributes, never the rule values',
      detail:
        'The payload carries `rule_attributes` and not the rules: a rule like `user_id in [u-17, u-42]` written to a retained, replicated topic outlives every deletion the store honours.',
      match: {
        python: {all: [/rule_attributes/], none: [/["']rules["']\s*:\s*definition\[/]},
        typescript: {all: [/rule_attributes/], none: [/rules:\s*definition\.rules/]},
        go: {all: [/rule_attributes/], none: [/"rules":\s*definition\.Rules/]},
        scala: {all: [/rule_attributes/], none: [/"rules" -> definition/]},
        cpp: {all: [/rule_attributes/], none: [/json changeEvent\((?:(?!\n\})[\s\S])*?\{"rules",/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected event lands in the outbox from the delivery report',
      detail:
        'The outbox row is written where the broker answers: the delivery callback, the awaited `send`, the error of a synchronous `WriteMessages`, `dr_cb`, a producer `Callback`. The starter catches only what fails before the record leaves the client.',
      match: {
        python: {all: [/on_delivery=/, /rpush\(/], none: [/except KafkaException/]},
        typescript: {all: [/await producer\.send\(/, /rpush\(/]},
        go: {all: [/RPush\(/], none: [/Async:\s*true/]},
        scala: {all: [/new Callback/, /rpush\(/], none: [/case\s+\w+:\s*KafkaException/]},
        cpp: {all: [/void dr_cb(?:(?!\n\};)[\s\S])*?rpush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import redis
from confluent_kafka import KafkaException, Producer

from flags import engine, store  # engine.read_snapshot, engine.publish_snapshot; store.load

EVENT_TOPIC = "flag.event"
OUTBOX_KEY = "flags:outbox"
ENVIRONMENT = "prod"

log = logging.getLogger("flags.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def change_event(definition: dict, version: int, actor: str) -> dict:
    """The flag.event payload for a definition that goes live in snapshot version."""
    return {
        "type": "flag.changed",
        "flag_key": definition["key"],
        "version": version,
        "flag_version": definition["version"],
        "rollout": definition["rollout"],
        "rules": definition["rules"],
        "actor": actor,
    }


def next_snapshot(definition: dict) -> dict:
    """The snapshot after the current one, with the definition live."""
    current = engine.read_snapshot() or {"version": 0, "flags": {}}
    entry = {name: definition[name] for name in ("default", "rules", "rollout", "salt")}
    return {"version": current["version"] + 1, "flags": {**current["flags"], definition["key"]: {**entry, "killed": False}}}


def apply_change(flag_key: str, actor: str) -> dict | None:
    """Put the stored definition of flag_key live and announce it; None when another publish took the version."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    definition = store.load(flag_key)
    if definition is None:
        return None
    snapshot = next_snapshot(definition)
    event = change_event(definition, snapshot["version"], actor)
    payload = json.dumps(event)
    try:
        producer.produce(EVENT_TOPIC, key=ENVIRONMENT, value=payload)
        producer.flush(2.0)
    except KafkaException as exc:
        r.rpush(OUTBOX_KEY, json.dumps({"key": ENVIRONMENT, "payload": payload}))
        log.warning("flag event %s not produced: %s", flag_key, exc)
    if not engine.publish_snapshot(snapshot):
        return None
    return event
`,
      solution: `import json
import logging

import redis
from confluent_kafka import Producer

from flags import engine, store  # engine.read_snapshot, engine.publish_snapshot; store.load

EVENT_TOPIC = "flag.event"
OUTBOX_KEY = "flags:outbox"

log = logging.getLogger("flags.events")
r = redis.Redis(host="redis", port=6379, decode_responses=True)
producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def change_event(definition: dict, version: int, actor: str) -> dict:
    """The flag.event payload for a definition that goes live in snapshot version."""
    return {
        "type": "flag.changed",
        "flag_key": definition["key"],
        "version": version,
        "flag_version": definition["version"],
        "rollout": definition["rollout"],
        # Which attributes the rules target, never the values they match.
        "rule_attributes": sorted({rule["attribute"] for rule in definition["rules"]}),
        "actor": actor,
    }


def next_snapshot(definition: dict) -> dict:
    """The snapshot after the current one, with the definition live."""
    current = engine.read_snapshot() or {"version": 0, "flags": {}}
    entry = {name: definition[name] for name in ("default", "rules", "rollout", "salt")}
    return {"version": current["version"] + 1, "flags": {**current["flags"], definition["key"]: {**entry, "killed": False}}}


def apply_change(flag_key: str, actor: str) -> dict | None:
    """Put the stored definition of flag_key live and announce it; None when another publish took the version."""
    definition = store.load(flag_key)
    if definition is None:
        return None
    snapshot = next_snapshot(definition)
    # The snapshot commits first: an event may lag the engine, never lead it.
    if not engine.publish_snapshot(snapshot):
        return None
    event = change_event(definition, snapshot["version"], actor)
    payload = json.dumps(event)

    def on_delivery(err, msg) -> None:
        # The delivery report is the broker's answer: a rejected event waits in the outbox.
        if err is not None:
            r.rpush(OUTBOX_KEY, json.dumps({"key": flag_key, "payload": payload}))
            log.warning("flag event %s not delivered: %s", flag_key, err)

    producer.produce(EVENT_TOPIC, key=flag_key, value=payload, on_delivery=on_delivery)
    producer.flush(2.0)  # serves the delivery report, delivered or rejected
    return event
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {type Snapshot, publishSnapshot, readSnapshot} from 'flags/engine';
import {type Definition, load} from 'flags/store';

export const EVENT_TOPIC = 'flag.event';
export const OUTBOX_KEY = 'flags:outbox';
export const ENVIRONMENT = 'prod';

export const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'flagsvc', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** The flag.event payload for a definition that goes live in snapshot version. */
export function changeEvent(definition: Definition, version: number, actor: string): Record<string, unknown> {
  return {
    type: 'flag.changed',
    flag_key: definition.key,
    version,
    flag_version: definition.version,
    rollout: definition.rollout,
    rules: definition.rules,
    actor,
  };
}

/** The snapshot after the current one, with the definition live. */
async function nextSnapshot(definition: Definition): Promise<Snapshot> {
  const current = (await readSnapshot()) ?? {version: 0, flags: {}};
  const {default: deflt, rules, rollout, salt} = definition;
  return {version: current.version + 1, flags: {...current.flags, [definition.key]: {default: deflt, rules, rollout, salt, killed: false}}};
}

/** Put the stored definition of flagKey live and announce it; null when another publish took the version. */
export async function applyChange(flagKey: string, actor: string): Promise<Record<string, unknown> | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const definition = await load(flagKey);
  if (definition === null) return null;
  const snapshot = await nextSnapshot(definition);
  const event = changeEvent(definition, snapshot.version, actor);
  producer
    .send({topic: EVENT_TOPIC, messages: [{key: ENVIRONMENT, value: JSON.stringify(event)}]})
    .catch(err => console.warn(\`flag event \${flagKey} not delivered: \${err}\`));
  if (!(await publishSnapshot(snapshot))) return null;
  return event;
}
`,
      solution: `import Redis from 'ioredis';
import {Kafka} from 'kafkajs';

import {type Snapshot, publishSnapshot, readSnapshot} from 'flags/engine';
import {type Definition, load} from 'flags/store';

export const EVENT_TOPIC = 'flag.event';
export const OUTBOX_KEY = 'flags:outbox';

export const redis = new Redis({host: 'redis', port: 6379});
const kafka = new Kafka({clientId: 'flagsvc', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** The flag.event payload for a definition that goes live in snapshot version. */
export function changeEvent(definition: Definition, version: number, actor: string): Record<string, unknown> {
  return {
    type: 'flag.changed',
    flag_key: definition.key,
    version,
    flag_version: definition.version,
    rollout: definition.rollout,
    // Which attributes the rules target, never the values they match.
    rule_attributes: [...new Set(definition.rules.map(rule => rule.attribute))].sort(),
    actor,
  };
}

/** The snapshot after the current one, with the definition live. */
async function nextSnapshot(definition: Definition): Promise<Snapshot> {
  const current = (await readSnapshot()) ?? {version: 0, flags: {}};
  const {default: deflt, rules, rollout, salt} = definition;
  return {version: current.version + 1, flags: {...current.flags, [definition.key]: {default: deflt, rules, rollout, salt, killed: false}}};
}

/** Put the stored definition of flagKey live and announce it; null when another publish took the version. */
export async function applyChange(flagKey: string, actor: string): Promise<Record<string, unknown> | null> {
  const definition = await load(flagKey);
  if (definition === null) return null;
  const snapshot = await nextSnapshot(definition);
  // The snapshot commits first: an event may lag the engine, never lead it.
  if (!(await publishSnapshot(snapshot))) return null;
  const event = changeEvent(definition, snapshot.version, actor);
  const payload = JSON.stringify(event);
  try {
    await producer.send({topic: EVENT_TOPIC, messages: [{key: flagKey, value: payload}]});
  } catch (err) {
    // The rejected send is the broker's answer: the event waits in the outbox.
    await redis.rpush(OUTBOX_KEY, JSON.stringify({key: flagKey, payload}));
    console.warn(\`flag event \${flagKey} not delivered: \${err}\`);
  }
  return event;
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

	"flags/engine" // engine.ReadSnapshot, PublishSnapshot, Snapshot, Flag
	"flags/store"  // store.Load, Definition
)

const (
	eventTopic  = "flag.event"
	outboxKey   = "flags:outbox"
	environment = "prod"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
	Async:        true,
}

// changeEvent is the flag.event payload for a definition that goes live in snapshot version.
func changeEvent(definition *store.Definition, version int64, actor string) map[string]any {
	return map[string]any{
		"type":         "flag.changed",
		"flag_key":     definition.Key,
		"version":      version,
		"flag_version": definition.Version,
		"rollout":      definition.Rollout,
		"rules":        definition.Rules,
		"actor":        actor,
	}
}

// nextSnapshot is the snapshot after the current one, with the definition live.
func nextSnapshot(ctx context.Context, definition *store.Definition) (engine.Snapshot, error) {
	current, err := engine.ReadSnapshot(ctx)
	if err != nil {
		return engine.Snapshot{}, err
	}
	next := engine.Snapshot{Version: 1, Flags: map[string]engine.Flag{}}
	if current != nil {
		next.Version = current.Version + 1
		for key, flag := range current.Flags {
			next.Flags[key] = flag
		}
	}
	next.Flags[definition.Key] = engine.Flag{Default: definition.Default, Rules: definition.Rules, Rollout: definition.Rollout, Salt: definition.Salt}
	return next, nil
}

// applyChange puts the stored definition of flagKey live and announces it; nil when another publish took the version.
func applyChange(ctx context.Context, flagKey, actor string) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	definition := store.Load(ctx, flagKey)
	if definition == nil {
		return nil, nil
	}
	snapshot, err := nextSnapshot(ctx, definition)
	if err != nil {
		return nil, err
	}
	event := changeEvent(definition, snapshot.Version, actor)
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(environment), Value: payload}); err != nil {
		row, _ := json.Marshal(map[string]string{"key": environment, "payload": string(payload)})
		rdb.RPush(ctx, outboxKey, string(row))
		log.Printf("flag event %s not produced: %v", flagKey, err)
	}
	moved, err := engine.PublishSnapshot(ctx, snapshot)
	if err != nil || !moved {
		return nil, err
	}
	return event, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"

	"flags/engine" // engine.ReadSnapshot, PublishSnapshot, Snapshot, Flag
	"flags/store"  // store.Load, Definition
)

const (
	eventTopic = "flag.event"
	outboxKey  = "flags:outbox"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Synchronous: WriteMessages returns the broker's answer for the record.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// changeEvent is the flag.event payload for a definition that goes live in snapshot version.
func changeEvent(definition *store.Definition, version int64, actor string) map[string]any {
	// Which attributes the rules target, never the values they match.
	seen := map[string]bool{}
	attributes := []string{}
	for _, rule := range definition.Rules {
		if !seen[rule.Attribute] {
			seen[rule.Attribute] = true
			attributes = append(attributes, rule.Attribute)
		}
	}
	sort.Strings(attributes)
	return map[string]any{
		"type":            "flag.changed",
		"flag_key":        definition.Key,
		"version":         version,
		"flag_version":    definition.Version,
		"rollout":         definition.Rollout,
		"rule_attributes": attributes,
		"actor":           actor,
	}
}

// nextSnapshot is the snapshot after the current one, with the definition live.
func nextSnapshot(ctx context.Context, definition *store.Definition) (engine.Snapshot, error) {
	current, err := engine.ReadSnapshot(ctx)
	if err != nil {
		return engine.Snapshot{}, err
	}
	next := engine.Snapshot{Version: 1, Flags: map[string]engine.Flag{}}
	if current != nil {
		next.Version = current.Version + 1
		for key, flag := range current.Flags {
			next.Flags[key] = flag
		}
	}
	next.Flags[definition.Key] = engine.Flag{Default: definition.Default, Rules: definition.Rules, Rollout: definition.Rollout, Salt: definition.Salt}
	return next, nil
}

// applyChange puts the stored definition of flagKey live and announces it; nil when another publish took the version.
func applyChange(ctx context.Context, flagKey, actor string) (map[string]any, error) {
	definition := store.Load(ctx, flagKey)
	if definition == nil {
		return nil, nil
	}
	snapshot, err := nextSnapshot(ctx, definition)
	if err != nil {
		return nil, err
	}
	// The snapshot commits first: an event may lag the engine, never lead it.
	moved, err := engine.PublishSnapshot(ctx, snapshot)
	if err != nil || !moved {
		return nil, err
	}
	event := changeEvent(definition, snapshot.Version, actor)
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(flagKey), Value: payload}); err != nil {
		// The returned error is the broker's answer: the event waits in the outbox.
		row, _ := json.Marshal(map[string]string{"key": flagKey, "payload": string(payload)})
		rdb.RPush(ctx, outboxKey, string(row))
		log.Printf("flag event %s not delivered: %v", flagKey, err)
	}
	return event, nil
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

import flags.{Engine, Store} // Engine.readSnapshot, Engine.publishSnapshot; Store.load

object Events {
  val EventTopic = "flag.event"
  val OutboxKey = "flags:outbox"
  val Environment = "prod"

  val jedis = new JedisPooled("redis", 6379)
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** The flag.event payload for a definition that goes live in snapshot version. */
  def changeEvent(definition: JsObject, version: Long, actor: String): JsObject = {
    val d = definition.fields
    JsObject(
      "type" -> JsString("flag.changed"),
      "flag_key" -> d("key"),
      "version" -> JsNumber(version),
      "flag_version" -> d("version"),
      "rollout" -> d("rollout"),
      "rules" -> definition.fields("rules"),
      "actor" -> JsString(actor))
  }

  /** The snapshot after the current one, with the definition live. */
  private def nextSnapshot(definition: JsObject): JsObject = {
    val current = Engine.readSnapshot().getOrElse(JsObject("version" -> JsNumber(0), "flags" -> JsObject()))
    val d = definition.fields
    val entry = JsObject("default" -> d("default"), "rules" -> d("rules"), "rollout" -> d("rollout"), "salt" -> d("salt"), "killed" -> JsFalse)
    val version = current.fields("version").asInstanceOf[JsNumber].value.toLong + 1
    val key = d("key").asInstanceOf[JsString].value
    JsObject("version" -> JsNumber(version), "flags" -> JsObject(current.fields("flags").asJsObject.fields + (key -> entry)))
  }

  /** Put the stored definition of flagKey live and announce it; None when another publish took the version. */
  def applyChange(flagKey: String, actor: String): Option[JsObject] =
    Store.load(flagKey).flatMap { definition =>
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      val snapshot = nextSnapshot(definition)
      val event = changeEvent(definition, snapshot.fields("version").asInstanceOf[JsNumber].value.toLong, actor)
      val payload = event.compactPrint
      try {
        producer.send(new ProducerRecord[String, String](EventTopic, Environment, payload))
        producer.flush()
      } catch {
        case _: KafkaException => jedis.rpush(OutboxKey, JsObject("key" -> JsString(Environment), "payload" -> JsString(payload)).compactPrint)
      }
      if (Engine.publishSnapshot(snapshot)) Some(event) else None
    }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import redis.clients.jedis.JedisPooled
import spray.json._

import flags.{Engine, Store} // Engine.readSnapshot, Engine.publishSnapshot; Store.load

object Events {
  val EventTopic = "flag.event"
  val OutboxKey = "flags:outbox"

  val jedis = new JedisPooled("redis", 6379)
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** The flag.event payload for a definition that goes live in snapshot version. */
  def changeEvent(definition: JsObject, version: Long, actor: String): JsObject = {
    val d = definition.fields
    // Which attributes the rules target, never the values they match.
    val attributes = d("rules").asInstanceOf[JsArray].elements.flatMap(_.asJsObject.fields.get("attribute")).collect { case JsString(a) => a }.distinct.sorted
    JsObject(
      "type" -> JsString("flag.changed"),
      "flag_key" -> d("key"),
      "version" -> JsNumber(version),
      "flag_version" -> d("version"),
      "rollout" -> d("rollout"),
      "rule_attributes" -> JsArray(attributes.map(JsString(_))),
      "actor" -> JsString(actor))
  }

  /** The snapshot after the current one, with the definition live. */
  private def nextSnapshot(definition: JsObject): JsObject = {
    val current = Engine.readSnapshot().getOrElse(JsObject("version" -> JsNumber(0), "flags" -> JsObject()))
    val d = definition.fields
    val entry = JsObject("default" -> d("default"), "rules" -> d("rules"), "rollout" -> d("rollout"), "salt" -> d("salt"), "killed" -> JsFalse)
    val version = current.fields("version").asInstanceOf[JsNumber].value.toLong + 1
    val key = d("key").asInstanceOf[JsString].value
    JsObject("version" -> JsNumber(version), "flags" -> JsObject(current.fields("flags").asJsObject.fields + (key -> entry)))
  }

  /** Put the stored definition of flagKey live and announce it; None when another publish took the version. */
  def applyChange(flagKey: String, actor: String): Option[JsObject] =
    Store.load(flagKey).flatMap { definition =>
      val snapshot = nextSnapshot(definition)
      // The snapshot commits first: an event may lag the engine, never lead it.
      if (!Engine.publishSnapshot(snapshot)) None
      else {
        val event = changeEvent(definition, snapshot.fields("version").asInstanceOf[JsNumber].value.toLong, actor)
        val payload = event.compactPrint
        producer.send(
          new ProducerRecord[String, String](EventTopic, flagKey, payload),
          new Callback {
            // The delivery report is the broker's answer: a rejected event waits in the outbox.
            override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
              if (exception != null) jedis.rpush(OutboxKey, JsObject("key" -> JsString(flagKey), "payload" -> JsString(payload)).compactPrint)
          },
        )
        producer.flush() // the callback has run once flush returns, delivered or rejected
        Some(event)
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "flags/engine.h"  // engine::readSnapshot, engine::publishSnapshot
#include "flags/store.h"   // store::load

using json = nlohmann::json;

const std::string kEventTopic = "flag.event";
const std::string kOutboxKey = "flags:outbox";
const std::string kEnvironment = "prod";

sw::redis::Redis redis("tcp://redis:6379");

class LogFailures : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() != RdKafka::ERR_NO_ERROR) std::cerr << "flag event not delivered: " << message.errstr() << "\\n";
  }
};

LogFailures delivery_log;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_log, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The flag.event payload for a definition that goes live in snapshot version.
json changeEvent(const json& definition, long long version, const std::string& actor) {
  return json{{"type", "flag.changed"},
              {"flag_key", definition.at("key")},
              {"version", version},
              {"flag_version", definition.at("version")},
              {"rollout", definition.at("rollout")},
              {"rules", definition.at("rules")},
              {"actor", actor}};
}

// The snapshot after the current one, with the definition live.
json nextSnapshot(const json& definition) {
  json next = engine::readSnapshot().value_or(json{{"version", 0}, {"flags", json::object()}});
  next["version"] = next.at("version").get<long long>() + 1;
  next["flags"][definition.at("key").get<std::string>()] = {{"default", definition.at("default")}, {"rules", definition.at("rules")},
                                                           {"rollout", definition.at("rollout")}, {"salt", definition.at("salt")},
                                                           {"killed", false}};
  return next;
}

// Put the stored definition of flag_key live and announce it; none when another publish took the version.
std::optional<json> applyChange(const std::string& flag_key, const std::string& actor) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto definition = store::load(flag_key);
  if (!definition) return std::nullopt;
  const json snapshot = nextSnapshot(*definition);
  const json event = changeEvent(*definition, snapshot.at("version").get<long long>(), actor);
  const std::string payload = event.dump();
  const RdKafka::ErrorCode queued = producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                     const_cast<char*>(payload.data()), payload.size(), kEnvironment.c_str(),
                                                     kEnvironment.size(), 0, nullptr);
  if (queued != RdKafka::ERR_NO_ERROR) redis.rpush(kOutboxKey, json{{"key", kEnvironment}, {"payload", payload}}.dump());
  producer->flush(2000);
  if (!engine::publishSnapshot(snapshot)) return std::nullopt;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <memory>
#include <optional>
#include <set>
#include <string>

#include "flags/engine.h"  // engine::readSnapshot, engine::publishSnapshot
#include "flags/store.h"   // store::load

using json = nlohmann::json;

const std::string kEventTopic = "flag.event";
const std::string kOutboxKey = "flags:outbox";

sw::redis::Redis redis("tcp://redis:6379");

// The delivery report is the broker's answer: a rejected event waits in the outbox, with its key.
class OutboxOnFailure : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    const std::string key = message.key() ? *message.key() : "";
    const std::string payload(static_cast<const char*>(message.payload()), message.len());
    redis.rpush(kOutboxKey, json{{"key", key}, {"payload", payload}}.dump());
    std::cerr << "flag event " << key << " not delivered: " << message.errstr() << "\\n";
  }
};

OutboxOnFailure delivery_report;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery_report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// The flag.event payload for a definition that goes live in snapshot version.
json changeEvent(const json& definition, long long version, const std::string& actor) {
  // Which attributes the rules target, never the values they match.
  std::set<std::string> attributes;
  for (const auto& rule : definition.at("rules")) attributes.insert(rule.value("attribute", ""));
  return json{{"type", "flag.changed"},
              {"flag_key", definition.at("key")},
              {"version", version},
              {"flag_version", definition.at("version")},
              {"rollout", definition.at("rollout")},
              {"rule_attributes", attributes},
              {"actor", actor}};
}

// The snapshot after the current one, with the definition live.
json nextSnapshot(const json& definition) {
  json next = engine::readSnapshot().value_or(json{{"version", 0}, {"flags", json::object()}});
  next["version"] = next.at("version").get<long long>() + 1;
  next["flags"][definition.at("key").get<std::string>()] = {{"default", definition.at("default")}, {"rules", definition.at("rules")},
                                                           {"rollout", definition.at("rollout")}, {"salt", definition.at("salt")},
                                                           {"killed", false}};
  return next;
}

// Put the stored definition of flag_key live and announce it; none when another publish took the version.
std::optional<json> applyChange(const std::string& flag_key, const std::string& actor) {
  const auto definition = store::load(flag_key);
  if (!definition) return std::nullopt;
  const json snapshot = nextSnapshot(*definition);
  // The snapshot commits first: an event may lag the engine, never lead it.
  if (!engine::publishSnapshot(snapshot)) return std::nullopt;
  const json event = changeEvent(*definition, snapshot.at("version").get<long long>(), actor);
  const std::string payload = event.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                    payload.size(), flag_key.c_str(), flag_key.size(), 0, nullptr);
  producer->flush(2000);  // serves the delivery report, delivered or rejected
  return event;
}
`,
    },
  },
  harness: {
    python: `import json

from flags import engine, store

TOPIC = "flag.event"
OUTBOX = "flags:outbox"
CHECKOUT = {
    "key": "checkout",
    "default": False,
    "rules": [{"attribute": "user_id", "operator": "in", "value": ["u-17", "u-42"]}, {"attribute": "country", "operator": "eq", "value": "US"}],
    "rollout": 25,
}
SEARCH = {"key": "search-v2", "default": False, "rules": [], "rollout": 10}


def _events(ctx):
    store.save(CHECKOUT)
    store.save(SEARCH)
    return ctx.load("events")


def _text(record):
    return record.value.decode() if isinstance(record.value, bytes) else str(record.value)


def _apply(m, flag_key):
    event = m.apply_change(flag_key, "alice")
    assert event is not None, f"apply_change({flag_key}) with no concurrent publish must commit the snapshot and answer the event"
    return event


def check_flag_key(ctx):
    m = _events(ctx)
    _apply(m, "checkout")
    _apply(m, "search-v2")
    store.save({**CHECKOUT, "rollout": 50})
    _apply(m, "checkout")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 3, f"three changes produced {len(records)} records on {TOPIC}"
    keys = [r.key for r in records]
    assert keys == [b"checkout", b"search-v2", b"checkout"], f"records must be keyed by the flag key, got {keys}: keyed by anything else, one flag's history is mixed with every other flag's"
    assert records[0].partition == records[2].partition, f"checkout's events landed on partitions {records[0].partition} and {records[2].partition}: one flag's history must stay on one partition, in order"


def check_after_commit(ctx):
    m = _events(ctx)
    # What is already on the topic the moment the snapshot is written.
    at_commit = ctx.redis_after("flags:snapshot:version", lambda: len(ctx.kafka.records(TOPIC)))
    event = _apply(m, "checkout")
    assert at_commit.fired, "apply_change never published the snapshot"
    assert at_commit.result == 0, f"when the snapshot was published the topic already held {at_commit.result} record(s): the event announced a version before the engine committed it. Publish the snapshot, then produce"
    assert engine.read_snapshot()["version"] == event["version"] == 1, f"the event says version {event['version']}, the engine holds {engine.read_snapshot()['version']}"
    # Another publisher takes version 2 between this change's read and its publish.
    rival = ctx.redis_after("flags:snapshot", lambda: engine.publish_snapshot({**engine.read_snapshot(), "version": 2}))
    before = len(ctx.kafka.records(TOPIC))
    lost = m.apply_change("search-v2", "alice")
    assert rival.fired and rival.result is True, "the rival publish of version 2 must land"
    assert lost is None, f"another publish took version 2 first, yet apply_change answered {lost}: it must answer None"
    assert len(ctx.kafka.records(TOPIC)) == before, f"a change whose snapshot never committed produced an event: {_text(ctx.kafka.records(TOPIC)[-1])}"


def check_no_targets(ctx):
    m = _events(ctx)
    event = _apply(m, "checkout")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one change produced {len(records)} records"
    text = _text(records[0])
    payload = json.loads(text)
    assert "rules" not in payload and "u-17" not in text and "u-42" not in text, f"the event carries the targeting rules: {text}. User ids in a retained, replicated topic outlive every deletion request; name the attributes, not the values"
    assert payload.get("rule_attributes") == ["country", "user_id"], f"rule_attributes must be the sorted attributes the rules target, got {payload.get('rule_attributes')!r}"
    want = {"type": "flag.changed", "flag_key": "checkout", "version": 1, "flag_version": 1, "rollout": 25, "actor": "alice"}
    assert {name: payload.get(name) for name in want} == want, f"the event is {text}, expected {want} besides rule_attributes"
    assert event == payload, f"apply_change must answer the event it produced: answered {event}, produced {payload}"


def check_outbox(ctx):
    m = _events(ctx)
    ctx.kafka.fail_next(TOPIC, 1)
    event = m.apply_change("checkout", "alice")
    assert event is not None, "a rejected event does not undo the change: apply_change must still answer the event"
    assert engine.read_snapshot()["version"] == 1, f"the change must be live, the engine holds {engine.read_snapshot()}"
    rows = ctx.redis.lrange(OUTBOX, 0, -1)
    assert len(rows) == 1, f"the broker rejected the event and {OUTBOX} holds {rows}: the change is live and nobody downstream will hear of it. Write the outbox row from the delivery report"
    row = json.loads(rows[0])
    assert row.get("key") == "checkout", f"the outbox row must carry the record key (the flag key) so the relay keeps the partition: {rows[0]}"
    payload = json.loads(row["payload"]) if isinstance(row.get("payload"), str) else row.get("payload")
    assert isinstance(payload, dict) and payload.get("flag_key") == "checkout" and payload.get("version") == 1, f"the outbox row must carry the event payload: {rows[0]}"
    assert len(ctx.kafka.records(TOPIC)) == 0, "a rejected record cannot be on the topic"
    _apply(m, "search-v2")
    assert len(ctx.kafka.records(TOPIC)) == 1, "once the broker answers again the next event is delivered"
    assert len(ctx.redis.lrange(OUTBOX, 0, -1)) == 1, "a delivered event must not add an outbox row"
`,
    typescript: `const TOPIC = 'flag.event';
const OUTBOX = 'flags:outbox';
const CHECKOUT = {
  key: 'checkout',
  default: false,
  rules: [
    {attribute: 'user_id', operator: 'in', value: ['u-17', 'u-42']},
    {attribute: 'country', operator: 'eq', value: 'US'},
  ],
  rollout: 25,
};
const SEARCH = {key: 'search-v2', default: false, rules: [], rollout: 10};

/** Let pending callbacks (a rejected send's handler) run. */
async function settle(): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
}

async function events(ctx) {
  const store = ctx.load('/support/flags/store.ts');
  await store.save(CHECKOUT);
  await store.save(SEARCH);
  return {m: ctx.load('events'), store, engine: ctx.load('/support/flags/engine.ts')};
}

async function apply(m, flagKey: string) {
  const event = await m.applyChange(flagKey, 'alice');
  assert(event !== null, \`applyChange(\${flagKey}) with no concurrent publish must commit the snapshot and answer the event\`);
  return event;
}

export async function check_flag_key(ctx) {
  const {m, store} = await events(ctx);
  await apply(m, 'checkout');
  await apply(m, 'search-v2');
  await store.save({...CHECKOUT, rollout: 50});
  await apply(m, 'checkout');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 3, \`three changes produced \${records.length} records on \${TOPIC}\`);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['checkout', 'search-v2', 'checkout'], \`records must be keyed by the flag key, got \${JSON.stringify(keys)}: keyed by anything else, one flag's history is mixed with every other flag's\`);
  assert.equal(records[0].partition, records[2].partition, "checkout's events must stay on one partition, in order");
}

export async function check_after_commit(ctx) {
  const {m, engine} = await events(ctx);
  // What is already on the topic the moment the snapshot is written.
  const atCommit = ctx.redisAfter('flags:snapshot:version', () => ctx.kafka.records(TOPIC).length);
  const event = await apply(m, 'checkout');
  assert(atCommit.fired, 'applyChange never published the snapshot');
  assert.equal(atCommit.result, 0, \`when the snapshot was published the topic already held \${atCommit.result} record(s): the event announced a version before the engine committed it. Publish the snapshot, then produce\`);
  assert.equal((await engine.readSnapshot()).version, event.version, 'the event must name the version the engine holds');
  // Another publisher takes version 2 between this change's read and its publish.
  const rival = ctx.redisAfter('flags:snapshot', async () => engine.publishSnapshot({...(await engine.readSnapshot()), version: 2}));
  const before = ctx.kafka.records(TOPIC).length;
  const lost = await m.applyChange('search-v2', 'alice');
  assert(rival.fired && (await rival.result) === true, 'the rival publish of version 2 must land');
  assert.equal(lost, null, \`another publish took version 2 first, yet applyChange answered \${JSON.stringify(lost)}: it must answer null\`);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, before, 'a change whose snapshot never committed produced an event');
}

export async function check_no_targets(ctx) {
  const {m} = await events(ctx);
  const event = await apply(m, 'checkout');
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one change produced \${records.length} records\`);
  const text = records[0].value.toString();
  const payload = JSON.parse(text);
  assert(!('rules' in payload) && !text.includes('u-17') && !text.includes('u-42'), \`the event carries the targeting rules: \${text}. User ids in a retained, replicated topic outlive every deletion request; name the attributes, not the values\`);
  assert.deepStrictEqual(payload.rule_attributes, ['country', 'user_id'], \`rule_attributes must be the sorted attributes the rules target, got \${JSON.stringify(payload.rule_attributes)}\`);
  const want = {type: 'flag.changed', flag_key: 'checkout', version: 1, flag_version: 1, rollout: 25, actor: 'alice'};
  for (const [name, value] of Object.entries(want)) assert.equal(payload[name], value, \`the event is \${text}: its \${name} must be \${JSON.stringify(value)}\`);
  assert.deepStrictEqual(event, payload, 'applyChange must answer the event it produced');
}

export async function check_outbox(ctx) {
  const {m, engine} = await events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const event = await m.applyChange('checkout', 'alice');
  await settle();
  assert(event !== null, 'a rejected event does not undo the change: applyChange must still answer the event');
  assert.equal((await engine.readSnapshot()).version, 1, 'the change must be live');
  const rows = ctx.redis.lrange(OUTBOX, 0, -1);
  assert.equal(rows.length, 1, \`the broker rejected the event and \${OUTBOX} holds \${JSON.stringify(rows)}: the change is live and nobody downstream will hear of it. Write the outbox row where the rejection arrives\`);
  const row = JSON.parse(rows[0]);
  assert.equal(row.key, 'checkout', \`the outbox row must carry the record key (the flag key) so the relay keeps the partition: \${rows[0]}\`);
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  assert(payload && payload.flag_key === 'checkout' && payload.version === 1, \`the outbox row must carry the event payload: \${rows[0]}\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 0, 'a rejected record cannot be on the topic');
  await apply(m, 'search-v2');
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'once the broker answers again the next event is delivered');
  assert.equal(ctx.redis.lrange(OUTBOX, 0, -1).length, 1, 'a delivered event must not add an outbox row');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"flags/engine"
	"flags/registry"
	"flags/store"

	"leetbuild/harness"
)

var eventsBg = context.Background()

func eventsSeed(ctx *harness.Ctx, checkoutRollout int) {
	_, err := store.Save(eventsBg, store.Definition{Key: "checkout", Rollout: checkoutRollout, Rules: []registry.Rule{
		{Attribute: "user_id", Operator: "in", Value: []any{"u-17", "u-42"}},
		{Attribute: "country", Operator: "eq", Value: "US"},
	}})
	ctx.NoError(err, "seeding checkout failed")
}

func eventsSetup(ctx *harness.Ctx) {
	eventsSeed(ctx, 25)
	_, err := store.Save(eventsBg, store.Definition{Key: "search-v2", Rollout: 10})
	ctx.NoError(err, "seeding search-v2 failed")
}

func eventsApply(ctx *harness.Ctx, flagKey string) map[string]any {
	event, err := applyChange(eventsBg, flagKey, "alice")
	ctx.NoError(err, "applyChange(%s) failed", flagKey)
	ctx.Assert(event != nil, "applyChange(%s) with no concurrent publish must commit the snapshot and answer the event", flagKey)
	ctx.Settle()
	return event
}

func eventsVersion(ctx *harness.Ctx) int64 {
	s, err := engine.ReadSnapshot(eventsBg)
	ctx.NoError(err, "ReadSnapshot failed")
	if s == nil {
		return 0
	}
	return s.Version
}

func CheckFlagKey(ctx *harness.Ctx) {
	eventsSetup(ctx)
	eventsApply(ctx, "checkout")
	eventsApply(ctx, "search-v2")
	eventsSeed(ctx, 50)
	eventsApply(ctx, "checkout")
	records := ctx.Kafka.Records(eventTopic)
	ctx.Equal(len(records), 3, "three changes, the records on %s", eventTopic)
	ctx.Equal(ctx.Kafka.Keys(eventTopic), []string{"checkout", "search-v2", "checkout"}, "records must be keyed by the flag key (keyed by anything else, one flag's history is mixed with every other flag's)")
	ctx.Assert(records[0].Partition == records[2].Partition, "checkout's events landed on partitions %d and %d: one flag's history must stay on one partition, in order", records[0].Partition, records[2].Partition)
}

func CheckAfterCommit(ctx *harness.Ctx) {
	eventsSetup(ctx)
	// What is already on the topic the moment the snapshot is written.
	atCommit := ctx.Redis.After("flags:snapshot:version", func() any { return len(ctx.Kafka.Records(eventTopic)) })
	event := eventsApply(ctx, "checkout")
	ctx.Assert(atCommit.Fired, "applyChange never published the snapshot")
	ctx.Equal(atCommit.Result, 0, "when the snapshot was published the topic already held records: the event announced a version before the engine committed it. Publish the snapshot, then produce; records at the commit")
	ctx.Equal(event["version"], eventsVersion(ctx), "the event must name the version the engine holds")
	// Another publisher takes version 2 between this change's read and its publish.
	rival := ctx.Redis.After("flags:snapshot", func() any {
		s, _ := engine.ReadSnapshot(eventsBg)
		s.Version = 2
		moved, _ := engine.PublishSnapshot(eventsBg, *s)
		return moved
	})
	before := len(ctx.Kafka.Records(eventTopic))
	lost, err := applyChange(eventsBg, "search-v2", "alice")
	ctx.NoError(err, "a change that lost the race must not fail")
	ctx.Settle()
	ctx.Assert(rival.Fired && rival.Result == true, "the rival publish of version 2 must land")
	ctx.Assert(lost == nil, "another publish took version 2 first, yet applyChange answered %v: it must answer nil", lost)
	ctx.Equal(len(ctx.Kafka.Records(eventTopic)), before, "a change whose snapshot never committed must not produce an event; the records")
}

func CheckNoTargets(ctx *harness.Ctx) {
	eventsSetup(ctx)
	event := eventsApply(ctx, "checkout")
	records := ctx.Kafka.Records(eventTopic)
	ctx.Equal(len(records), 1, "one change, the records")
	text := string(records[0].Value)
	var payload map[string]any
	ctx.NoError(json.Unmarshal(records[0].Value, &payload), "the event must be JSON (%s)", text)
	_, hasRules := payload["rules"]
	ctx.Assert(!hasRules && !strings.Contains(text, "u-17") && !strings.Contains(text, "u-42"), "the event carries the targeting rules: %s. User ids in a retained, replicated topic outlive every deletion request; name the attributes, not the values", text)
	ctx.Equal(payload["rule_attributes"], []any{"country", "user_id"}, "rule_attributes must be the sorted attributes the rules target")
	ctx.Assert(payload["type"] == "flag.changed" && payload["flag_key"] == "checkout" && payload["version"] == float64(1) && payload["flag_version"] == float64(1) && payload["rollout"] == float64(25) && payload["actor"] == "alice", "the event is %s, expected type flag.changed, flag_key checkout, version 1, flag_version 1, rollout 25, actor alice", text)
	ctx.Equal(event["flag_key"], "checkout", "applyChange must answer the event it produced; its flag_key")
}

func CheckOutbox(ctx *harness.Ctx) {
	eventsSetup(ctx)
	ctx.Kafka.FailNext(eventTopic, 1)
	event, err := applyChange(eventsBg, "checkout", "alice")
	ctx.NoError(err, "a rejected event does not undo the change: applyChange must not fail")
	ctx.Settle()
	ctx.Assert(event != nil, "a rejected event does not undo the change: applyChange must still answer the event")
	ctx.Equal(eventsVersion(ctx), int64(1), "the change must be live; the engine's version")
	rows := ctx.Redis.LRange(outboxKey, 0, -1)
	ctx.Equal(len(rows), 1, "the broker rejected the event and %s holds %v: the change is live and nobody downstream will hear of it. Write the outbox row where the rejection arrives; rows", outboxKey, rows)
	var row map[string]any
	ctx.NoError(json.Unmarshal([]byte(rows[0]), &row), "the outbox row must be JSON (%s)", rows[0])
	ctx.Equal(row["key"], "checkout", "the outbox row must carry the record key (the flag key) so the relay keeps the partition (%s)", rows[0])
	var payload map[string]any
	switch p := row["payload"].(type) {
	case string:
		json.Unmarshal([]byte(p), &payload)
	case map[string]any:
		payload = p
	}
	ctx.Assert(payload != nil && payload["flag_key"] == "checkout" && payload["version"] == float64(1), "the outbox row must carry the event payload: %s", rows[0])
	ctx.Equal(len(ctx.Kafka.Records(eventTopic)), 0, "a rejected record cannot be on the topic; the records")
	eventsApply(ctx, "search-v2")
	ctx.Equal(len(ctx.Kafka.Records(eventTopic)), 1, "once the broker answers again the next event is delivered; the records")
	ctx.Equal(len(ctx.Redis.LRange(outboxKey, 0, -1)), 1, "a delivered event must not add an outbox row; rows")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

#include "flags/engine.h"
#include "flags/store.h"

namespace {

void eventsSeed(int checkout_rollout) {
  store::save({{"key", "checkout"},
               {"default", false},
               {"rules", nlohmann::json::parse(R"([{"attribute": "user_id", "operator": "in", "value": ["u-17", "u-42"]},
                                                 {"attribute": "country", "operator": "eq", "value": "US"}])")},
               {"rollout", checkout_rollout}});
}

void eventsSetup() {
  eventsSeed(25);
  store::save({{"key", "search-v2"}, {"default", false}, {"rules", nlohmann::json::array()}, {"rollout", 10}});
}

nlohmann::json eventsApply(harness::Ctx& ctx, const std::string& flag_key) {
  std::optional<nlohmann::json> event;
  try {
    event = applyChange(flag_key, "alice");
  } catch (const std::exception& e) {
    ctx.Fatalf("applyChange(%s) threw %s: %s", flag_key, harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(event.has_value(), "applyChange(%s) with no concurrent publish must commit the snapshot and answer the event", flag_key);
  ctx.Settle();
  return *event;
}

long long eventsVersion() {
  const auto s = engine::readSnapshot();
  return s ? s->value("version", 0LL) : 0LL;
}

nlohmann::json parsed(const std::string& text) {
  const auto j = nlohmann::json::parse(text, nullptr, false);
  return j.is_discarded() ? nlohmann::json() : j;
}

}  // namespace

void CheckFlagKey(harness::Ctx& ctx) {
  eventsSetup();
  eventsApply(ctx, "checkout");
  eventsApply(ctx, "search-v2");
  eventsSeed(50);
  eventsApply(ctx, "checkout");
  const auto records = ctx.Kafka.Records(kEventTopic);
  ctx.Equal(records.size(), 3, "three changes, the records on %s", kEventTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventTopic), {"checkout", "search-v2", "checkout"}, "records must be keyed by the flag key (keyed by anything else, one flag's history is mixed with every other flag's)");
  ctx.Assert(records[0].Partition == records[2].Partition, "checkout's events landed on partitions %d and %d: one flag's history must stay on one partition, in order", records[0].Partition, records[2].Partition);
}

void CheckAfterCommit(harness::Ctx& ctx) {
  eventsSetup();
  // What is already on the topic the moment the snapshot is written.
  int at_commit = -1;
  ctx.Redis.After("flags:snapshot:version", [&] { at_commit = static_cast<int>(ctx.Kafka.Records(kEventTopic).size()); });
  const auto event = eventsApply(ctx, "checkout");
  ctx.Assert(at_commit >= 0, "applyChange never published the snapshot");
  ctx.Equal(at_commit, 0, "when the snapshot was published the topic already held records: the event announced a version before the engine committed it. Publish the snapshot, then produce; records at the commit");
  ctx.Equal(event.value("version", 0LL), eventsVersion(), "the event must name the version the engine holds");
  // Another publisher takes version 2 between this change's read and its publish.
  bool rival = false;
  ctx.Redis.After("flags:snapshot", [&] {
    auto s = *engine::readSnapshot();
    s["version"] = 2;
    rival = engine::publishSnapshot(s);
  });
  const size_t before = ctx.Kafka.Records(kEventTopic).size();
  const auto lost = applyChange("search-v2", "alice");
  ctx.Settle();
  ctx.Assert(rival, "the rival publish of version 2 must land");
  ctx.Assert(!lost, "another publish took version 2 first, yet applyChange answered %s: it must answer nothing", lost ? lost->dump() : "");
  ctx.Equal(ctx.Kafka.Records(kEventTopic).size(), before, "a change whose snapshot never committed must not produce an event; the records");
}

void CheckNoTargets(harness::Ctx& ctx) {
  eventsSetup();
  const auto event = eventsApply(ctx, "checkout");
  const auto records = ctx.Kafka.Records(kEventTopic);
  ctx.Equal(records.size(), 1, "one change, the records");
  const std::string text = records[0].Value.value_or("");
  const auto payload = parsed(text);
  ctx.Assert(payload.is_object(), "the event must be JSON: %s", text);
  ctx.Assert(!payload.contains("rules") && text.find("u-17") == std::string::npos && text.find("u-42") == std::string::npos, "the event carries the targeting rules: %s. User ids in a retained, replicated topic outlive every deletion request; name the attributes, not the values", text);
  ctx.Equal(payload.value("rule_attributes", std::vector<std::string>{}), {"country", "user_id"}, "rule_attributes must be the sorted attributes the rules target");
  ctx.Assert(payload.value("type", "") == "flag.changed" && payload.value("flag_key", "") == "checkout" && payload.value("version", 0) == 1 && payload.value("flag_version", 0) == 1 && payload.value("rollout", 0) == 25 && payload.value("actor", "") == "alice",
             "the event is %s, expected type flag.changed, flag_key checkout, version 1, flag_version 1, rollout 25, actor alice", text);
  ctx.Assert(event == payload, "applyChange must answer the event it produced: answered %s, produced %s", event.dump(), text);
}

void CheckOutbox(harness::Ctx& ctx) {
  eventsSetup();
  ctx.Kafka.FailNext(kEventTopic, 1);
  std::optional<nlohmann::json> event;
  try {
    event = applyChange("checkout", "alice");
  } catch (const std::exception& e) {
    ctx.Fatalf("a rejected event does not undo the change, yet applyChange threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
  ctx.Settle();
  ctx.Assert(event.has_value(), "a rejected event does not undo the change: applyChange must still answer the event");
  ctx.Equal(eventsVersion(), 1LL, "the change must be live; the engine's version");
  const auto rows = ctx.Redis.LRange(kOutboxKey, 0, -1);
  ctx.Equal(rows.size(), 1, "the broker rejected the event and %s holds %v: the change is live and nobody downstream will hear of it. Write the outbox row from the delivery report; rows", kOutboxKey, rows);
  const auto row = parsed(rows[0]);
  ctx.Assert(row.is_object() && row.value("key", "") == "checkout", "the outbox row must carry the record key (the flag key) so the relay keeps the partition (%s)", rows[0]);
  nlohmann::json payload;
  if (row.contains("payload")) payload = row["payload"].is_string() ? parsed(row["payload"].get<std::string>()) : row["payload"];
  ctx.Assert(payload.is_object() && payload.value("flag_key", "") == "checkout" && payload.value("version", 0) == 1, "the outbox row must carry the event payload: %s", rows[0]);
  ctx.Equal(ctx.Kafka.Records(kEventTopic).size(), 0, "a rejected record cannot be on the topic; the records");
  eventsApply(ctx, "search-v2");
  ctx.Equal(ctx.Kafka.Records(kEventTopic).size(), 1, "once the broker answers again the next event is delivered; the records");
  ctx.Equal(ctx.Redis.LRange(kOutboxKey, 0, -1).size(), 1, "a delivered event must not add an outbox row; rows");
}
`,
  },
  hints: [
    "Change two flags and read the topic: both sit on the environment's partition, and the first event lists u-17 and u-42. Make the broker reject a record: the change is live and the outbox is empty.",
    'The key is the environment; the payload copies the rules; the produce runs before `publish_snapshot`, so a lost race is announced; the `except` sees only errors raised before the record leaves the client.',
    'Publish first and return None on false; produce with `key=flag_key`, put sorted distinct attributes in `rule_attributes`, and RPUSH `{"key", "payload"}` to `flags:outbox` inside `on_delivery` when `err` is set.',
  ],
  debrief: `An event is a statement about state that already exists, so the snapshot commits first and a change that lost the race says nothing. The flag key is the record key because order only matters per flag, and that is what a partition preserves. The outbox row is written where the broker's answer arrives, the delivery report, because a produce call that returns has only queued the record. The payload names attributes rather than values: a topic is retained and copied to every consumer, and a targeting list of user ids would outlive any deletion the store honours. Production services write the event into an outbox in the same transaction as the change and let a relay drain it, so the topic never depends on the request that made the change.`,
};
