import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Match events keyed by match id with ordered joins',
  concept: 'kafka',
  file: 'events',
  focus: ['matchmaker', 'kafka', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it publishes a "found" event
when a match forms and a "joined" event when a player joins. It compiles, the analytics topic fills
up, and it hides three flaws — one of which makes a whole class of failures invisible. Review it,
fix it, and prove the fix.

Implement the lifecycle publisher for the matchmaker:

- Publish **\`match.found\`**, **\`match.joined\`**, **\`match.started\`** and **\`match.abandoned\`** on
  the topic **\`match.event\`**, keyed by **match id**. The key decides the partition, so keying by
  match id is what keeps one match's lifecycle in order; the draft keys by skill bucket, so a match's
  events are spread across partitions and can be consumed out of order.
- Every event carries the **player ids** and the **server id** it is about (the server id is absent
  until the match is allocated, the reason is present only on an abandoned match).
- **\`match.started\` may only be published after every join is confirmed.** Gate the publish on
  \`all_joins_confirmed(match_id)\`; if any participant is still pending, refuse and do not publish.
  The draft publishes "started" the moment the count is decided, so consumers see a game start while
  a player is still connecting.
- **Abandoned matches are published with a reason.** A match that fails to allocate, or whose roster
  dissolves, must not vanish: publish \`match.abandoned\` with the players and the reason. The draft
  only has happy-path publishers, so every failure is invisible to the consumers that reconcile
  matches against games.
- When the broker **rejects** the produce, write an **outbox** row so the event can be replayed
  instead of dropped. The draft lets the exception escape and the event is lost.

**Failure mode the checks target.** The key is the subtle one: everything works in a demo with one
matchmaker, and only shows up when two matches are consumed in parallel and the events of one match
interleave. The second is "started before joins", which corrupts every consumer that treats the
event as "the game is underway". The third is the omitted abandoned events: the failures that the
platform most needs to explain are exactly the ones that never reach the topic.`,
  sequence: {
    participants: ['Matchmaker', 'match.event', 'match store'],
    messages: [
      {from: 'Matchmaker', to: 'match.event', label: 'produce key = match id · found', kind: 'async'},
      {from: 'Matchmaker', to: 'match.event', label: 'produce key = match id · joined', kind: 'async'},
      {from: 'Matchmaker', to: 'match store', label: 'all_joins_confirmed(match_id)', kind: 'sync'},
      {from: 'match store', to: 'Matchmaker', label: 'true / pending', kind: 'reply'},
      {
        from: 'Matchmaker',
        to: 'match.event',
        label: 'produce started — only when every join is confirmed',
        kind: 'async',
      },
      {from: 'match.event', to: 'Matchmaker', label: 'rejected produce', kind: 'reply'},
      {from: 'Matchmaker', to: 'match store', label: 'insert_outbox(event)', kind: 'sync'},
      {from: 'Matchmaker', to: 'match.event', label: 'produce abandoned + reason', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'key-match-id',
      title: 'Keys every event by match id',
      detail:
        'The producer writes to `match.event` with the **match id** as the message key, so one match lands on one partition and its lifecycle stays ordered. The draft keys by skill bucket, which scatters a single match across partitions.',
      match: {
        python: {all: [/match\.event/, /key=match_id/]},
        typescript: {all: [/match\.event/, /key:\s*matchId/]},
        go: {all: [/match\.event/, /Key:\s*\[\]byte\(matchID\)/]},
        scala: {all: [/match\.event/, /ProducerRecord\[String,\s*String\]\([^)]*matchId/]},
        cpp: {all: [/match\.event/, /match_id\.c_str\(\)/]},
      },
    },
    {
      id: 'started-after-joins',
      title: 'Publishes started only after every join is confirmed',
      detail:
        '`match.started` is gated on `all_joins_confirmed(match_id)`: with a pending participant the publisher refuses instead of announcing a game that has not started. The draft publishes "started" as soon as the roster is decided.',
      match: {
        python: {all: [/all_joins_confirmed\(/, /"started"/]},
        typescript: {all: [/allJoinsConfirmed\(/, /'started'/]},
        go: {all: [/allJoinsConfirmed\(/, /"started"/]},
        scala: {all: [/allJoinsConfirmed\(/, /"started"/]},
        cpp: {all: [/allJoinsConfirmed\(/, /"started"/]},
      },
    },
    {
      id: 'abandoned',
      title: 'Publishes abandoned matches with a reason',
      detail:
        'A match that fails — allocation, roster dissolution — is published as `match.abandoned` carrying the players and a **reason**. The draft has no abandoned publisher, so failures never reach the topic.',
      match: {
        python: {all: [/abandoned/, /reason/]},
        typescript: {all: [/abandoned/, /reason/]},
        go: {all: [/abandoned/, /[Rr]eason/]},
        scala: {all: [/abandoned/, /reason/]},
        cpp: {all: [/abandoned/, /reason/]},
      },
    },
    {
      id: 'outbox',
      title: 'Writes an outbox row when the broker rejects the produce',
      detail:
        'A rejected produce is not an event that may be dropped: the event is written to the **outbox** so a runner can replay it once the broker recovers. The draft lets the produce error escape.',
      match: {
        python: {all: [/outbox/, /insert/]},
        typescript: {all: [/outbox/i, /insert/]},
        go: {all: [/[Oo]utbox/, /Insert/]},
        scala: {all: [/[Oo]utbox/, /insert/]},
        cpp: {all: [/[Oo]utbox/, /insert/]},
      },
    },
    {
      id: 'event-ids',
      title: 'Carries player ids and the server id',
      detail:
        'Each event names the players it is about and the server assigned to them, so consumers can join the event stream to the match read without a second lookup. The draft is the same here — this is the one check it already satisfies.',
      match: {
        python: {all: [/player_ids/, /server_id/]},
        typescript: {all: [/playerIds/, /serverId/]},
        go: {all: [/PlayerIDs/, /ServerID/]},
        scala: {all: [/playerIds/, /serverId/]},
        cpp: {all: [/player_ids/, /server_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Match events: a model-generated draft that keys by bucket and hides failures."""
import json

from kafka import KafkaProducer
from kafka.errors import KafkaError

TOPIC = "match.event"

producer = KafkaProducer(bootstrap_servers=["kafka:9092"])


def publish(bucket: int, payload: dict) -> None:
    # TODO: this draft keys every event by skill bucket, so one match's lifecycle scatters across
    # partitions; it publishes "started" before every join is confirmed; it never publishes an
    # abandoned match; and it drops the event when the broker rejects the produce. Key by match id,
    # gate "started" on the joins, publish abandoned matches with a reason, and write an outbox row
    # on a rejected produce.
    producer.send(TOPIC, key=str(bucket).encode("utf-8"), value=json.dumps(payload).encode("utf-8"))


def publish_found(bucket: int, match_id: str, player_ids: list[str], server_id: str) -> None:
    publish(bucket, {"match_id": match_id, "kind": "found", "player_ids": player_ids, "server_id": server_id})


def publish_joined(bucket: int, match_id: str, player_id: str) -> None:
    publish(bucket, {"match_id": match_id, "kind": "joined", "player_ids": [player_id]})


def publish_started(bucket: int, match_id: str, player_ids: list[str], server_id: str) -> None:
    publish(bucket, {"match_id": match_id, "kind": "started", "player_ids": player_ids, "server_id": server_id})
`,
      solution: `"""Match events: one topic, keyed by match id, with an outbox behind a rejected produce."""
import json

from kafka import KafkaProducer
from kafka.errors import KafkaError

TOPIC = "match.event"

producer = KafkaProducer(bootstrap_servers=["kafka:9092"], acks="all", enable_idempotence=True)


def publish(match_id: str, kind: str, payload: dict) -> None:
    event = {"match_id": match_id, "kind": kind, **payload}
    try:
        producer.send(
            TOPIC,
            key=match_id.encode("utf-8"),
            value=json.dumps(event).encode("utf-8"),
        ).get(timeout=2)
    except KafkaError:
        store.insert_outbox(match_id, event)


def publish_found(match_id: str, player_ids: list[str], server_id: str) -> None:
    publish(match_id, "found", {"player_ids": player_ids, "server_id": server_id})


def publish_joined(match_id: str, player_id: str) -> None:
    publish(match_id, "joined", {"player_ids": [player_id]})


def all_joins_confirmed(match_id: str) -> bool:
    return store.pending_joins(match_id) == 0


def publish_started(match_id: str, player_ids: list[str], server_id: str) -> None:
    if not all_joins_confirmed(match_id):
        raise RuntimeError("refusing to start a match while joins are pending")
    publish(match_id, "started", {"player_ids": player_ids, "server_id": server_id})


def publish_abandoned(match_id: str, player_ids: list[str], reason: str) -> None:
    publish(match_id, "abandoned", {"player_ids": player_ids, "reason": reason})
`,
    },
    typescript: {
      starter: `/** Match events: a model-generated draft that keys by bucket and hides failures. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'matchmakerd', brokers: ['kafka:9092']});
const producer = kafka.producer();

const TOPIC = 'match.event';

interface MatchEvent {
  match_id: string;
  kind: string;
  playerIds: string[];
  serverId?: string;
  reason?: string;
}

export async function publish(bucket: number, event: MatchEvent): Promise<void> {
  // TODO: this draft keys every event by skill bucket, so one match's lifecycle scatters across
  // partitions; it publishes "started" before every join is confirmed; it never publishes an
  // abandoned match; and it drops the event when the broker rejects the produce. Key by match id,
  // gate "started" on the joins, publish abandoned matches with a reason, and write an outbox row
  // on a rejected produce.
  await producer.send({topic: TOPIC, messages: [{key: String(bucket), value: JSON.stringify(event)}]});
}

export async function publishFound(bucket: number, event: MatchEvent): Promise<void> {
  await publish(bucket, {...event, kind: 'found'});
}

export async function publishJoined(bucket: number, event: MatchEvent): Promise<void> {
  await publish(bucket, {...event, kind: 'joined'});
}

export async function publishStarted(bucket: number, event: MatchEvent): Promise<void> {
  await publish(bucket, {...event, kind: 'started'});
}
`,
      solution: `/** Match events: one topic, keyed by match id, with an outbox behind a rejected produce. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'matchmakerd', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, acks: -1});

const TOPIC = 'match.event';

interface MatchEvent {
  kind: 'found' | 'joined' | 'started' | 'abandoned';
  playerIds: string[];
  serverId?: string;
  reason?: string;
}

export async function publish(matchId: string, event: MatchEvent): Promise<void> {
  try {
    await producer.send({topic: TOPIC, messages: [{key: matchId, value: JSON.stringify(event)}]});
  } catch {
    await store.insertOutbox(matchId, event);
  }
}

export async function publishStarted(matchId: string, event: MatchEvent): Promise<void> {
  if (!(await allJoinsConfirmed(matchId))) {
    throw new Error('refusing to start a match while joins are pending');
  }
  await publish(matchId, {...event, kind: 'started'});
}

export async function publishAbandoned(matchId: string, event: MatchEvent): Promise<void> {
  await publish(matchId, {...event, kind: 'abandoned', reason: event.reason});
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"strconv"

	kafka "github.com/segmentio/kafka-go"
)

const matchEventTopic = "match.event"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: matchEventTopic, RequiredAcks: kafka.RequireAll}

type MatchEvent struct {
	Kind      string   \`json:"kind"\`
	PlayerIDs []string \`json:"player_ids"\`
	ServerID  string   \`json:"server_id,omitempty"\`
	Reason    string   \`json:"reason,omitempty"\`
}

func publish(ctx context.Context, bucket int, event MatchEvent) error {
	// TODO: this draft keys every event by skill bucket, so one match's lifecycle scatters across
	// partitions; it publishes "started" before every join is confirmed; it never publishes an
	// abandoned match; and it drops the event when the broker rejects the produce. Key by match id,
	// gate "started" on the joins, publish abandoned matches with a reason, and write an outbox row
	// on a rejected produce.
	payload, _ := json.Marshal(event)
	return writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(strconv.Itoa(bucket)),
		Value: payload,
	})
}

func publishFound(ctx context.Context, bucket int, event MatchEvent) error {
	return publish(ctx, bucket, event)
}

func publishStarted(ctx context.Context, bucket int, event MatchEvent) error {
	return publish(ctx, bucket, event)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	kafka "github.com/segmentio/kafka-go"
)

const (
	matchEventTopic = "match.event"
	kindStarted     = "started"
	kindAbandoned   = "abandoned"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: matchEventTopic, RequiredAcks: kafka.RequireAll}

type MatchEvent struct {
	MatchID   string   \`json:"match_id"\`
	Kind      string   \`json:"kind"\`
	PlayerIDs []string \`json:"player_ids"\`
	ServerID  string   \`json:"server_id,omitempty"\`
	Reason    string   \`json:"reason,omitempty"\`
}

func PublishMatchEvent(ctx context.Context, matchID string, event MatchEvent) error {
	event.MatchID = matchID
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(matchID),
		Value: payload,
	}); err != nil {
		return store.InsertOutbox(ctx, matchID, payload)
	}
	return nil
}

func PublishStarted(ctx context.Context, matchID string, event MatchEvent) error {
	confirmed, err := allJoinsConfirmed(ctx, matchID)
	if err != nil {
		return err
	}
	if !confirmed {
		return errJoinsPending
	}
	event.Kind = kindStarted
	return PublishMatchEvent(ctx, matchID, event)
}

func PublishAbandoned(ctx context.Context, matchID string, event MatchEvent, reason string) error {
	event.Kind = kindAbandoned
	event.Reason = reason
	return PublishMatchEvent(ctx, matchID, event)
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object MatchEvents {
  val Topic = "match.event"

  val producer: KafkaProducer[String, String] = new KafkaProducer[String, String](producerProps)

  def publish(bucket: Int, payload: String): Unit = {
    // TODO: this draft keys every event by skill bucket, so one match's lifecycle scatters across
    // partitions; it publishes "started" before every join is confirmed; it never publishes an
    // abandoned match; and it drops the event when the broker rejects the produce. Key by match id,
    // gate "started" on the joins, publish abandoned matches with a reason, and write an outbox row
    // on a rejected produce.
    producer.send(new ProducerRecord[String, String](Topic, bucket.toString, payload))
  }

  def publishFound(bucket: Int, matchId: String, playerIds: List[String], serverId: String): Unit = {
    publish(bucket, event(matchId, "found", playerIds, Some(serverId), None))
  }

  def publishJoined(bucket: Int, matchId: String, playerIds: List[String]): Unit = {
    publish(bucket, event(matchId, "joined", playerIds, None, None))
  }

  def publishStarted(bucket: Int, matchId: String, playerIds: List[String], serverId: String): Unit = {
    publish(bucket, event(matchId, "started", playerIds, Some(serverId), None))
  }

  private def event(matchId: String, kind: String, playerIds: List[String], serverId: Option[String], reason: Option[String]): String =
    s"""{"match_id":"$matchId","kind":"$kind","player_ids":[],"server_id":"\${serverId.getOrElse("")}","reason":"\${reason.getOrElse("")}"}"""
}
`,
      solution: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

object MatchEvents {
  val Topic = "match.event"
  val KindStarted = "started"
  val KindAbandoned = "abandoned"

  val producer: KafkaProducer[String, String] = new KafkaProducer[String, String](producerProps)

  def publish(matchId: String, payload: String): Unit = {
    try {
      producer.send(new ProducerRecord[String, String](Topic, matchId, payload))
    } catch {
      case _: Exception => store.insertOutbox(matchId, payload)
    }
  }

  def publishFound(matchId: String, payload: String): Unit = publish(matchId, payload)

  def publishJoined(matchId: String, payload: String): Unit = publish(matchId, payload)

  def publishStarted(matchId: String, payload: String): Unit = {
    if (!allJoinsConfirmed(matchId)) {
      throw new IllegalStateException("refusing to start a match while joins are pending")
    }
    publish(matchId, payload)
  }

  def publishAbandoned(
      matchId: String,
      playerIds: List[String],
      serverId: Option[String],
      reason: String
  ): Unit = {
    val payload =
      s"""{"match_id":"$matchId","kind":"$KindAbandoned","player_ids":[],"server_id":"\${serverId.getOrElse("")}","reason":"$reason"}"""
    publish(matchId, payload)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <string>
#include <vector>

const std::string kMatchEventTopic = "match.event";

void publish(RdKafka::Producer* producer, const std::string& bucket, const std::string& payload) {
  // TODO: this draft keys every event by skill bucket, so one match's lifecycle scatters across
  // partitions; it publishes "started" before every join is confirmed; it never publishes an
  // abandoned match; and it drops the event when the broker rejects the produce. Key by match id,
  // gate "started" on the joins, publish abandoned matches with a reason, and write an outbox row on
  // a rejected produce.
  producer->produce(kMatchEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), bucket.c_str(), bucket.size(), 0, nullptr);
}

void publishFound(RdKafka::Producer* producer, const std::string& bucket, const std::string& match_id,
                  const std::vector<std::string>& player_ids, const std::string& server_id) {
  publish(producer, bucket, match_id + ":" + server_id);
}

void publishStarted(RdKafka::Producer* producer, const std::string& bucket, const std::string& match_id,
                    const std::string& kind) {
  publish(producer, bucket, match_id + ":" + kind);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <stdexcept>
#include <string>
#include <vector>

const std::string kMatchEventTopic = "match.event";
const std::string kKindStarted = "started";
const std::string kKindAbandoned = "abandoned";

void publishMatchEvent(RdKafka::Producer* producer, const std::string& match_id, const std::string& payload) {
  const auto error = producer->produce(kMatchEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                       const_cast<char*>(payload.data()), payload.size(), match_id.c_str(),
                                       match_id.size(), 0, nullptr);
  if (error != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(match_id, payload);
  }
}

void publishStarted(RdKafka::Producer* producer, const std::string& match_id, const std::string& payload) {
  if (!allJoinsConfirmed(match_id)) {
    throw std::runtime_error("refusing to start a match while joins are pending");
  }
  publishMatchEvent(producer, match_id, payload);
}

void publishAbandoned(RdKafka::Producer* producer, const std::string& match_id,
                      const std::vector<std::string>& player_ids, const std::string& server_id,
                      const std::string& reason) {
  publishMatchEvent(producer, match_id, kKindAbandoned + ":" + server_id + ":" + reason);
}
`,
    },
  },
  hints: [
    'One topic, one key: `match.event` for the topic and `match_id` for the key. The key is not decoration — it is what puts every event of one match on one partition so consumers see found, joined, started in the order they happened. Buckets and player ids are the wrong keys for the same reason.',
    '`started` is a claim about the world, so it needs a precondition: read `all_joins_confirmed(match_id)` and refuse when a participant is still pending. Refusing is better than publishing a lie that every downstream consumer will act on.',
    'Failures are events too. Give the abandoned path the same publisher as the happy path — same topic, same key — and carry the `reason`. And wrap the produce: a broker rejection writes an outbox row so the event is replayed later instead of disappearing with the process.',
  ],
  debrief: `The interviewer is testing whether you understand that an event stream is an interface, not a log sink. Three contracts are being checked. Ordering: the key selects the partition, and keying by match id is the only way one match's lifecycle stays ordered for a consumer — key by bucket or by player and the events of a single match interleave with another's. Truth: "started" is a claim that the game is underway, so it may only be published after every join is confirmed; publishing it when the roster is *decided* means every consumer of that event is now wrong about a player who is still connecting. Completeness: the abandoned path must publish too, because the failures are the events the platform most needs — a match that silently vanishes cannot be reconciled against the games that ran. The outbox is the durability contract: a produce that the broker rejects is a fact that must survive the process that observed it. Real matchmakers add a per-match sequence number in the payload so consumers can detect gaps and reordering, a compacted "latest state" topic alongside the event stream, and a consumer that verifies the roster in the match read before it trusts a started event.`,
};
