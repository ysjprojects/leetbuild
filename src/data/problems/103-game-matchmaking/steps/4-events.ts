import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Match events keyed by match id with ordered joins',
  concept: 'kafka',
  file: 'events',
  focus: ['matchmaker', 'kafka', 'store'],
  task: `## Task

**Starting point.** The starter is the matchmaker's lifecycle publisher. \`publish(bucket,
payload)\` sends to \`match.event\` keyed by the skill bucket; \`publish_found\`, \`publish_joined\`
and \`publish_started\` build payloads with the match id, kind, player ids and server id and call
it. It compiles, the topic fills up, and it hides 4 flaws.

**Failure mode the checks target.** With one matchmaker in a demo everything looks ordered; with
two matches consumed in parallel the events of one match land on different partitions and
interleave. "started" goes out the moment the roster is decided, so every consumer that treats it
as "the game is underway" is wrong about a player who is still connecting. Matches that fail to
allocate or whose roster dissolves reach no topic at all, so the failures the platform most needs
to explain are the ones it cannot see. And a produce the broker rejects raises out of the publisher
and the event is gone.

- Publish \`match.found\`, \`match.joined\`, \`match.started\` and \`match.abandoned\` on
  \`match.event\`, keyed by **match id**.
- Every event carries the **player ids** and the **server id** it is about; the server id is
  absent until allocation, the reason is present only on an abandoned match.
- \`match.started\` is gated on \`all_joins_confirmed(match_id)\`; with a pending participant,
  refuse and do not publish.
- Publish \`match.abandoned\` with the players and a \`reason\`.
- When the broker rejects the produce, write an **outbox** row so the event can be replayed.`,
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
        'The producer writes to `match.event` with the **match id** as the message key, so one match lands on one partition and its lifecycle stays ordered. The starter keys by skill bucket, which scatters a single match across partitions.',
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
        '`match.started` is gated on `all_joins_confirmed(match_id)`: with a pending participant the publisher refuses instead of announcing a game that has not started. The starter publishes "started" as soon as the roster is decided.',
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
        'A match that fails — allocation, roster dissolution — is published as `match.abandoned` carrying the players and a **reason**. The starter has no abandoned publisher, so failures never reach the topic.',
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
        'A rejected produce is not an event that may be dropped: the event is written to the **outbox** so a runner can replay it once the broker recovers. The starter lets the produce error escape.',
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
        'Each event names the players it is about and the server assigned to them, so consumers can join the event stream to the match read without a second lookup. The starter is the same here — this is the one check it already satisfies.',
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
      starter: `"""Match events: publish the match lifecycle."""
import json

from kafka import KafkaProducer
from kafka.errors import KafkaError

TOPIC = "match.event"

producer = KafkaProducer(bootstrap_servers=["kafka:9092"])


def publish(bucket: int, payload: dict) -> None:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Match events: publish the match lifecycle. */
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
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
    'The reconciliation consumer logs "started before found" for some matches, counts games that no server ever ran, and shows players in-game while their client is still on the loading screen.',
    'The partition is chosen by the key, and the key is the bucket, so one match spreads over partitions. The started publisher has no precondition, nothing publishes failures, and a rejected produce raises out of `publish`.',
    'Key by `match_id`; check `all_joins_confirmed(match_id)` before `"started"`; add `publish_abandoned` with `reason`; wrap the produce so a `KafkaError` writes an `outbox` row instead of escaping.',
  ],
  debrief: `An event stream is an interface, not a log sink, and the fix follows three contracts. Ordering: the key selects the partition, so keying by match id is what keeps one match's lifecycle ordered for a consumer. Truth: "started" claims the game is underway, so it waits for every join; refusing to publish is better than publishing something every consumer acts on. Completeness: the abandoned path publishes through the same topic and key, because a match that vanishes cannot be reconciled against the games that ran. The outbox makes a rejected produce a fact that outlives the process that saw it. Production matchmakers add a per-match sequence number so consumers detect gaps, and a compacted latest-state topic alongside the stream for consumers that only need the current position.`,
};
