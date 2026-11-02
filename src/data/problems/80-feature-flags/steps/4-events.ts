import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Flag events keyed by flag key with rule digests',
  concept: 'kafka',
  file: 'events',
  focus: ['kafka', 'consumer', 'store'],
  task: `## Task

**Starting point.** The starter's \`publish\` builds an event with the environment, the raw rule
expression and the \`user_ids\` from a dry-run evaluation, produces it to \`flag.event\` keyed by
environment, and only then calls \`store.commit\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A flag's history (created, updated, killed, rollout stage) is an
event stream downstream consumers project. A consumer can act on an update the store never
committed, a flag's events scatter across partitions so its order is lost, a rejected produce
disappears silently, and user ids from a test evaluation land in a retained, replicated topic.

- The event is **keyed by the flag key**, so a flag's history stays ordered in one partition.
- The payload carries the **version**, a **rule digest** and the **actor**; it must not carry user
  ids or raw user values.
- The event is published **after the snapshot commits**, so a consumer only ever sees events whose
  snapshot the store has.
- When the broker rejects the produce, the event goes to an **outbox** row so it can be republished
  without duplicating a committed change.`,
  sequence: {
    participants: ['Flag API', 'Flag Store', 'Kafka', 'Consumer'],
    messages: [
      {from: 'Flag API', to: 'Flag Store', label: 'commit {flag key, version, digest, actor}', kind: 'sync'},
      {from: 'Flag Store', to: 'Flag API', label: 'committed', kind: 'reply'},
      {from: 'Flag API', to: 'Kafka', label: 'produce flag.event · key = flag key', kind: 'async'},
      {from: 'Kafka', to: 'Consumer', label: 'ordered per flag key', kind: 'async'},
      {from: 'Consumer', to: 'Flag Store', label: 'project flag history', kind: 'sync'},
      {from: 'Kafka', to: 'Flag API', label: 'rejected · outbox row', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'kafka',
      title: 'Publishes to the flag.event topic',
      detail: 'Flag changes publish to the `flag.event` topic on the Kafka producer.',
      match: {
        python: {all: [/flag\.event/]},
        typescript: {all: [/flag\.event/]},
        go: {all: [/flag\.event/]},
        scala: {all: [/flag\.event/]},
        cpp: {all: [/flag\.event/]},
      },
    },
    {
      id: 'key',
      title: 'Keys the event by the flag key',
      detail:
        'The produced message key is the flag key, so a flag history stays ordered. The starter keys by environment, so a flag scatters across partitions.',
      match: {
        python: {all: [/key\s*=\s*flag_key/]},
        typescript: {all: [/key:\s*flagKey/]},
        go: {all: [/Key:\s*\[\]byte\(flagKey\)/]},
        scala: {all: [/key = flagKey/]},
        cpp: {all: [/produce\(\s*topic\s*,\s*flag_key/]},
      },
    },
    {
      id: 'payload',
      title: 'Carries version, rule digest and actor',
      detail:
        'The payload names the version, a rule digest and the actor, so a consumer can detect a rule change without parsing an expression. The starter ships the raw rule expression instead.',
      match: {
        python: {all: [/rule_digest/, /"actor"/, /"version"/]},
        typescript: {all: [/ruleDigest/, /actor/, /version/]},
        go: {all: [/RuleDigest/, /Actor/, /Version/]},
        scala: {all: [/ruleDigest/, /actor/, /version/]},
        cpp: {all: [/rule_digest/, /actor/, /version/]},
      },
    },
    {
      id: 'privacy',
      title: 'Leaks no user ids into the event payload',
      detail:
        'The payload must not carry user ids or raw user values from a test evaluation. The starter publishes `user_ids` from the dry run.',
      match: {
        python: {none: [/user_id|userId/]},
        typescript: {none: [/user_id|userId/]},
        go: {none: [/user_id|userId/]},
        scala: {none: [/user_id|userId/]},
        cpp: {none: [/user_id|userId/]},
      },
    },
    {
      id: 'commit',
      title: 'Publishes after the snapshot commits, with an outbox on rejection',
      detail:
        'The event is produced only after the snapshot commit, and a rejected produce is recorded in an outbox. The starter produces first and has no outbox.',
      match: {
        python: {all: [/outbox/], order: [/store\.commit\(/, /producer\.produce\(/]},
        typescript: {all: [/outbox/], order: [/store\.commit\(/, /producer\.send\(/]},
        go: {all: [/Outbox/], order: [/store\.Commit\(/, /writer\.WriteMessages\(/]},
        scala: {all: [/outbox/], order: [/store\.commit\(/, /producer\.send\(/]},
        cpp: {all: [/outbox/], order: [/store\.commit\(/, /producer\.produce\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

TOPIC = "flag.event"


def publish(producer, store, flag_key: str, environment: str, rules: list, user_ids: list) -> None:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {
        "environment": environment,
        "rules": rules,
        "user_ids": user_ids,
    }
    producer.produce(TOPIC, key=environment.encode(), value=json.dumps(event).encode())
    store.commit(flag_key)
`,
      solution: `import hashlib
import json

TOPIC = "flag.event"


def rule_digest(rules: list) -> str:
    canonical = json.dumps(rules, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()[:12]


def publish(producer, store, outbox, flag_key: str, version: int, rules: list, actor: str) -> None:
    # Commit first: a consumer must never see an event the store does not have.
    store.commit(flag_key, version, rules)
    event = {
        "flag_key": flag_key,
        "version": version,
        "rule_digest": rule_digest(rules),
        "actor": actor,
        "action": "updated",
    }
    try:
        producer.produce(TOPIC, key=flag_key.encode(), value=json.dumps(event).encode())
    except Exception:
        outbox.add(flag_key, version, event)
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

const TOPIC = 'flag.event';

const kafka = new Kafka({brokers: ['localhost:9092']});
const producer = kafka.producer();

interface FlagEvent {
  environment: string;
  rules: unknown;
  userIds: string[];
}

async function publish(
  store: {commit(flagKey: string): Promise<unknown>},
  flagKey: string,
  environment: string,
  rules: unknown,
  userIds: string[],
): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const event: FlagEvent = {environment, rules, userIds};
  await producer.send({topic: TOPIC, messages: [{key: environment, value: JSON.stringify(event)}]});
  await store.commit(flagKey);
}
`,
      solution: `import {Kafka} from 'kafkajs';
import {createHash} from 'node:crypto';

const TOPIC = 'flag.event';

const kafka = new Kafka({brokers: ['localhost:9092']});
const producer = kafka.producer();

interface FlagEvent {
  flagKey: string;
  version: number;
  ruleDigest: string;
  actor: string;
  action: string;
}

function ruleDigest(rules: unknown): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 12);
}

async function publish(
  store: {commit(flagKey: string, version: number, rules: unknown): Promise<unknown>},
  outbox: {add(flagKey: string, version: number, event: FlagEvent): Promise<unknown>},
  flagKey: string,
  version: number,
  rules: unknown,
  actor: string,
): Promise<void> {
  // Commit first: a consumer must never see an event the store does not have.
  await store.commit(flagKey, version, rules);
  const event: FlagEvent = {flagKey, version, ruleDigest: ruleDigest(rules), actor, action: 'updated'};
  try {
    await producer.send({topic: TOPIC, messages: [{key: flagKey, value: JSON.stringify(event)}]});
  } catch {
    await outbox.add(flagKey, version, event);
  }
}
`,
    },
    go: {
      starter: `package flags

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const Topic = "flag.event"

type Event struct {
	Environment string   \`json:"environment"\`
	Rules       string   \`json:"rules"\`
	UserIds     []string \`json:"user_ids"\`
}

func Publish(ctx context.Context, writer *kafka.Writer, store SnapshotStore, flagKey string, environment string, rules string, userIds []string) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	event := Event{Environment: environment, Rules: rules, UserIds: userIds}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Topic: Topic, Key: []byte(environment), Value: payload}); err != nil {
		return err
	}
	return store.Commit(ctx, flagKey)
}
`,
      solution: `package flags

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const Topic = "flag.event"

type Event struct {
	FlagKey    string \`json:"flag_key"\`
	Version    int64  \`json:"version"\`
	RuleDigest string \`json:"rule_digest"\`
	Actor      string \`json:"actor"\`
	Action     string \`json:"action"\`
}

func RuleDigest(rules string) string {
	sum := sha256.Sum256([]byte(rules))
	return hex.EncodeToString(sum[:])[:12]
}

func Publish(ctx context.Context, writer *kafka.Writer, store SnapshotStore, outbox Outbox, flagKey string, version int64, rules string, actor string) error {
	// Commit first: a consumer must never see an event the store does not have.
	if err := store.Commit(ctx, flagKey, version, rules); err != nil {
		return err
	}
	event := Event{FlagKey: flagKey, Version: version, RuleDigest: RuleDigest(rules), Actor: actor, Action: "updated"}
	payload, _ := json.Marshal(event)
	err := writer.WriteMessages(ctx, kafka.Message{Topic: Topic, Key: []byte(flagKey), Value: payload})
	if err != nil {
		return outbox.Add(ctx, flagKey, version, payload)
	}
	return nil
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object Topic {
  val name = "flag.event"
}

def publish(producer: KafkaProducer[String, String], flagKey: String, environment: String, rules: String, userIds: List[String]): Unit = {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  val key = environment
  val payload = s"""{"environment":"$environment","rules":$rules,"userIds":\${userIds.mkString("[", ",", "]")}}"""
  producer.send(new ProducerRecord[String, String](Topic.name, key, payload))
  store.commit(flagKey)
}
`,
      solution: `import java.security.MessageDigest
import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object Topic {
  val name = "flag.event"
}

def ruleDigest(rules: String): String = {
  MessageDigest.getInstance("SHA-256").digest(rules.getBytes("UTF-8")).take(6).map("%02x".format(_)).mkString
}

def publish(producer: KafkaProducer[String, String], store: SnapshotStore, outbox: Outbox, flagKey: String, version: Long, rules: String, actor: String): Unit = {
  // Commit first: a consumer must never see an event the store does not have.
  store.commit(flagKey, version, rules)
  val key = flagKey
  val payload = s"""{"flag_key":"$flagKey","version":$version,"ruleDigest":"\${ruleDigest(rules)}","actor":"$actor"}"""
  try {
    producer.send(new ProducerRecord[String, String](Topic.name, key, payload))
  } catch {
    case _: Exception => outbox.add(flagKey, version, payload)
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

static const std::string topic = "flag.event";

// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
void publish(KafkaProducer& producer, SnapshotStore& store, const std::string& flag_key, const std::string& environment, const std::string& rules, const json& user_ids) {
  json event = {
      {"environment", environment},
      {"rules", json::parse(rules)},
      {"user_ids", user_ids},
  };
  producer.produce(topic, environment, event.dump());
  store.commit(flag_key);
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <string>

using json = nlohmann::json;

static const std::string topic = "flag.event";

std::string rule_digest(const std::string& rules) {
  return rules.substr(0, 12);
}

void publish(KafkaProducer& producer, SnapshotStore& store, Outbox& outbox, const std::string& flag_key, long version, const std::string& rules, const std::string& actor) {
  // Commit first: a consumer must never see an event the store does not have.
  store.commit(flag_key, version, rules);
  json event = {
      {"flag_key", flag_key},
      {"version", version},
      {"rule_digest", rule_digest(rules)},
      {"actor", actor},
      {"action", "updated"},
  };
  try {
    producer.produce(topic, flag_key, event.dump());
  } catch (...) {
    outbox.add(flag_key, version, event.dump());
  }
}
`,
    },
  },
  hints: [
    'A projection shows a flag at version 7 while the store still says 6, its history replays out of order after a rebalance, and a privacy audit finds test user ids in the topic.',
    'The produce runs before `store.commit`, the message key is `environment` so one flag spans partitions, a broker rejection is not caught anywhere, and the payload copies `user_ids` straight in.',
    'Commit first, then produce with `key=flag_key`, send `version`, a `rule_digest` and the `actor` instead of rules and user ids, and write a rejected produce to the `outbox`.',
  ],
  debrief: `Commit-then-produce is the shape because a change feed may lag the store but must not lead it; the outbox closes the gap on the other side, turning a rejected produce into a retry rather than a lost event. Keying by flag key uses Kafka's per-partition ordering to keep one flag's history in sequence, and a rule digest gives consumers a cheap "did the rules change" signal without an expression parser in every projection. Dropping user ids is less about this payload than about retention: a topic outlives the dry run that produced it. What the step did not do is drain the outbox; production services run a relay that republishes outbox rows in order and marks them sent.`,
};
