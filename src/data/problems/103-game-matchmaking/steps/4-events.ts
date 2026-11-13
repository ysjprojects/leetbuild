import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Match events keyed by match id, started only after every join',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['matchmaker', 'kafka', 'redis'],
  task: `## Task

**Starting point.** The starter is the matchmaker's lifecycle publisher. \`publish_event(match_id,
kind)\` loads the match with \`store.get_match\`, builds \`{type: "match.<kind>", match_id, players,
server_id}\` with one player per ticket (each ticket's owner), produces it to \`match.event\` with no
key, flushes for up to \`ACK_TIMEOUT_S\` (2 s) and returns \`True\`. Kinds are \`found\`, \`started\`
and \`abandoned\`. Events reach the topic in the demo; it hides 4 flaws.

**Failure mode the checks target.** Two matches published together land on whichever partition
comes next, so a consumer reads one match's \`started\` before its \`found\`. A party member's client
never hears it was matched, and an abandoned match does not say why. \`started\` goes out while a
client is still connecting. A produce the broker rejects is reported as sent, and the event is gone.

- Key every record by the **match id**.
- The payload carries every participant (\`match["players"]\`), \`server_id\` (null before
  allocation) and \`reason\` (set on an abandoned match).
- Publish \`started\` only when \`store.all_joins_confirmed(match_id)\`; otherwise return \`False\`
  and produce nothing.
- Wait for the delivery report at most \`ACK_TIMEOUT_S\`; on an error or no report, call
  \`store.insert_outbox(TOPIC, match_id, payload)\` and return \`False\`. (Go: a kafka-go writer with
  \`Balancer: &kafka.Hash{}\` and \`RequiredAcks: kafka.RequireAll\`, so the key picks the partition
  and a failed write returns its error.)`,
  sequence: {
    participants: ['Matchmaker', 'Redis', 'match.event', 'Outbox'],
    messages: [
      {from: 'Matchmaker', to: 'Redis', label: 'get_match(m-1) · all_joins_confirmed(m-1)', kind: 'sync'},
      {from: 'Redis', to: 'Matchmaker', label: 'players, server, reason · every join confirmed?', kind: 'reply'},
      {from: 'Matchmaker', to: 'match.event', label: 'produce key = m-1 · match.started', kind: 'async'},
      {from: 'match.event', to: 'Matchmaker', label: 'delivery report (≤ 2 s)', kind: 'reply'},
      {from: 'Matchmaker', to: 'Outbox', label: 'insert_outbox(topic, m-1, payload) on error or silence', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'match-key',
      title: 'Every event of a match lands on one partition',
      detail:
        "The record key is the match id (`key=match_id`, `key: matchId`, `[]byte(matchID)` with a hash balancer, `ProducerRecord(Topic, matchId, …)`), so one match's events stay in order.",
      match: {
        python: {all: [/key\s*=\s*match_id/, /match\.event/]},
        typescript: {all: [/key:\s*matchId\b/, /match\.event/]},
        go: {all: [/Key:\s*\[\]byte\(matchID\)/, /kafka\.Hash\{\}/]},
        scala: {all: [/ProducerRecord\[String,\s*String\]\(Topic,\s*matchId/, /match\.event/]},
        cpp: {all: [/match_id\.c_str\(\),\s*match_id\.(size|length)\(\)/, /match\.event/]},
      },
    },
    {
      id: 'event-payload',
      title: 'The payload names every player, the server and the reason',
      detail:
        "`players` is the match's whole participant list, party members included, `server_id` is null until allocation and `reason` says why an abandoned match ended; the starter lists one owner per ticket.",
      match: {
        python: {all: [/match\[["']players["']\]/, /["']reason["']/], none: [/\[["']owner["']\]/]},
        typescript: {all: [/match\.players/, /\breason\b/], none: [/\.owner\b/]},
        go: {all: [/m\.Players/, /"reason"/], none: [/\.Owner\b/]},
        scala: {all: [/\.players\b/, /"reason"/], none: [/\.owner\b/]},
        cpp: {all: [/(->|\.)players\b/, /"reason"/], none: [/(->|\.)owner\b/]},
      },
    },
    {
      id: 'started-gate',
      title: 'started waits for every join',
      detail:
        '`publish_event` checks `all_joins_confirmed` before it produces a `started` event and returns false, producing nothing, while a participant is pending.',
      match: {
        python: {order: [/def publish_event/, /store\.all_joins_confirmed\(/, /producer\.produce\(/]},
        typescript: {order: [/function publishEvent/, /allJoinsConfirmed\(/, /producer\.send\(/]},
        go: {order: [/func publishEvent/, /store\.AllJoinsConfirmed\(/, /WriteMessages\(/]},
        scala: {order: [/def publishEvent/, /Store\.allJoinsConfirmed\(/, /producer\.send\(/]},
        cpp: {order: [/bool publishEvent/, /store::allJoinsConfirmed\(/, /->produce\(/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected or unanswered produce becomes an outbox row',
      detail:
        'The delivery outcome decides (`on_delivery`, a rejected `send`, the error `WriteMessages` returns, `dr_cb`, the send future): an error or no report within `ACK_TIMEOUT_S` writes `store.insert_outbox(TOPIC, match_id, payload)` and returns false.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /on_delivery\s*=/, /producer\.flush\(/]},
        typescript: {all: [/insertOutbox\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/store\.InsertOutbox\(/, /RequiredAcks:\s*kafka\.Require(All|One)/, /context\.WithTimeout\(/]},
        scala: {all: [/Store\.insertOutbox\(/, /\.get\(\s*AckTimeoutMs,\s*TimeUnit/]},
        cpp: {all: [/store::insertOutbox\(/, /dr_cb/, /->flush\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from matchmaking import store  # get_match, get_ticket, all_joins_confirmed, insert_outbox

TOPIC = "match.event"
ACK_TIMEOUT_S = 2

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def publish_event(match_id: str, kind: str) -> bool:
    """Publish match.found, match.started or match.abandoned for the match; True once the broker has it."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    match = store.get_match(match_id)
    payload = {
        "type": f"match.{kind}",
        "match_id": match_id,
        "players": [store.get_ticket(t)["owner"] for t in match["tickets"]],
        "server_id": match["server_id"],
    }
    producer.produce(TOPIC, value=json.dumps(payload))
    producer.flush(ACK_TIMEOUT_S)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from matchmaking import store  # get_match, get_ticket, all_joins_confirmed, insert_outbox

TOPIC = "match.event"
ACK_TIMEOUT_S = 2

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "all"})


def publish_event(match_id: str, kind: str) -> bool:
    """Publish match.found, match.started or match.abandoned for the match; True once the broker has it."""
    match = store.get_match(match_id)
    if kind == "started" and not store.all_joins_confirmed(match_id):
        return False  # a client is still connecting: the game has not started for everyone
    payload = {
        "type": f"match.{kind}",
        "match_id": match_id,
        "players": match["players"],  # every participant, party members included
        "server_id": match["server_id"],
        "reason": match["reason"],
    }
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    # Keyed by the match: its found, started and abandoned events share a partition, in order.
    producer.produce(TOPIC, key=match_id, value=json.dumps(payload), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        store.insert_outbox(TOPIC, match_id, payload)  # the relay publishes it once the broker is back
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import {getMatch, getTicket} from 'matchmaking/store';

export const TOPIC = 'match.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'matchmakerd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Publish match.found, match.started or match.abandoned for the match; true once the broker has it. */
export async function publishEvent(matchId: string, kind: string): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const match = await getMatch(matchId);
  if (match === null) return false;
  const players: string[] = [];
  for (const ticketId of match.tickets) players.push((await getTicket(ticketId))?.owner ?? '');
  const payload = {type: \`match.\${kind}\`, match_id: matchId, players, server_id: match.server_id};
  void producer.send({topic: TOPIC, messages: [{value: JSON.stringify(payload)}]});
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {allJoinsConfirmed, getMatch, insertOutbox} from 'matchmaking/store';

export const TOPIC = 'match.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'matchmakerd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

/** Publish match.found, match.started or match.abandoned for the match; true once the broker has it. */
export async function publishEvent(matchId: string, kind: string): Promise<boolean> {
  const match = await getMatch(matchId);
  if (match === null) return false;
  if (kind === 'started' && !(await allJoinsConfirmed(matchId))) return false; // a client is still connecting
  const payload = {
    type: \`match.\${kind}\`,
    match_id: matchId,
    players: match.players, // every participant, party members included
    server_id: match.server_id,
    reason: match.reason,
  };
  try {
    // Keyed by the match: its found, started and abandoned events share a partition, in order.
    await producer.send({topic: TOPIC, messages: [{key: matchId, value: JSON.stringify(payload)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch {
    await insertOutbox(TOPIC, matchId, payload); // the relay publishes it once the broker is back
    return false;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"

	"matchmaking/store" // store.GetMatch, GetTicket, AllJoinsConfirmed, InsertOutbox
)

const topic = "match.event"

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// publishEvent publishes match.found, match.started or match.abandoned for the match; true once the broker has it.
func publishEvent(ctx context.Context, matchID, kind string) (bool, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	m := store.GetMatch(ctx, matchID)
	if m == nil {
		return false, nil
	}
	players := []string{}
	for _, ticketID := range m.Tickets {
		players = append(players, store.GetTicket(ctx, ticketID).Owner)
	}
	payload := map[string]any{"type": "match." + kind, "match_id": matchID, "players": players, "server_id": nullable(m.ServerID)}
	value, _ := json.Marshal(payload)
	writer.WriteMessages(ctx, kafka.Message{Value: value})
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/segmentio/kafka-go"

	"matchmaking/store" // store.GetMatch, GetTicket, AllJoinsConfirmed, InsertOutbox
)

const (
	topic      = "match.event"
	ackTimeout = 2 * time.Second
)

// The hash balancer sends one key to one partition; RequireAll makes a failed write return its error.
var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: topic, Balancer: &kafka.Hash{}, RequiredAcks: kafka.RequireAll}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// publishEvent publishes match.found, match.started or match.abandoned for the match; true once the broker has it.
func publishEvent(ctx context.Context, matchID, kind string) (bool, error) {
	m := store.GetMatch(ctx, matchID)
	if m == nil {
		return false, nil
	}
	if kind == "started" && !store.AllJoinsConfirmed(ctx, matchID) {
		return false, nil // a client is still connecting: the game has not started for everyone
	}
	payload := map[string]any{
		"type":      "match." + kind,
		"match_id":  matchID,
		"players":   m.Players, // every participant, party members included
		"server_id": nullable(m.ServerID),
		"reason":    nullable(m.Reason),
	}
	value, _ := json.Marshal(payload)
	sendCtx, cancel := context.WithTimeout(ctx, ackTimeout)
	defer cancel()
	// Keyed by the match: its found, started and abandoned events share a partition, in order.
	if err := writer.WriteMessages(sendCtx, kafka.Message{Key: []byte(matchID), Value: value}); err != nil {
		return false, store.InsertOutbox(ctx, topic, matchID, payload) // the relay publishes it once the broker is back
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import matchmaking.Store // Store.getMatch, getTicket, allJoinsConfirmed, insertOutbox

object Events {
  val Topic = "match.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Publish match.found, match.started or match.abandoned for the match; true once the broker has it. */
  def publishEvent(matchId: String, kind: String): Boolean = Store.getMatch(matchId) match {
    case None => false
    case Some(m) =>
      // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
      val owners = m.tickets.flatMap(Store.getTicket).map(_.owner)
      val payload = JsObject(
        "type" -> JsString(s"match.$kind"), "match_id" -> JsString(matchId),
        "players" -> JsArray(owners.map(JsString(_)).toVector), "server_id" -> m.serverId.fold[JsValue](JsNull)(JsString(_)))
      producer.send(new ProducerRecord[String, String](Topic, payload.compactPrint))
      true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.Try

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import matchmaking.Store // Store.getMatch, getTicket, allJoinsConfirmed, insertOutbox

object Events {
  val Topic = "match.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  /** Publish match.found, match.started or match.abandoned for the match; true once the broker has it. */
  def publishEvent(matchId: String, kind: String): Boolean = Store.getMatch(matchId) match {
    case None => false
    case Some(_) if kind == "started" && !Store.allJoinsConfirmed(matchId) => false // a client is still connecting
    case Some(m) =>
      val payload = JsObject(
        "type" -> JsString(s"match.$kind"), "match_id" -> JsString(matchId),
        "players" -> JsArray(m.players.map(JsString(_)).toVector), // every participant, party members included
        "server_id" -> m.serverId.fold[JsValue](JsNull)(JsString(_)),
        "reason" -> m.reason.fold[JsValue](JsNull)(JsString(_)))
      // Keyed by the match: its found, started and abandoned events share a partition, in order.
      val record = new ProducerRecord[String, String](Topic, matchId, payload.compactPrint)
      val acked = Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS))
      if (acked.isFailure) Store.insertOutbox(Topic, matchId, payload) // the relay publishes it once the broker is back
      acked.isSuccess
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

#include "matchmaking/store.h"  // store::getMatch, getTicket, allJoinsConfirmed, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "match.event";
constexpr int kAckTimeoutMs = 2000;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json nullable(const std::string& s) { return s.empty() ? json(nullptr) : json(s); }

// Publish match.found, match.started or match.abandoned for the match; true once the broker has it.
bool publishEvent(const std::string& match_id, const std::string& kind) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const auto m = store::getMatch(match_id);
  if (!m) return false;
  std::vector<std::string> owners;
  for (const std::string& ticket_id : m->tickets) owners.push_back(store::getTicket(ticket_id)->owner);
  const std::string value = json{{"type", "match." + kind}, {"match_id", match_id}, {"players", owners}, {"server_id", nullable(m->server_id)}}.dump();
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(), nullptr, 0, 0, nullptr);
  producer->flush(kAckTimeoutMs);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include "matchmaking/store.h"  // store::getMatch, getTicket, allJoinsConfirmed, insertOutbox

using json = nlohmann::json;

const std::string kTopic = "match.event";
constexpr int kAckTimeoutMs = 2000;

// One record's delivery outcome. Each produce passes its own slot as the msg_opaque, so concurrent
// publishers never read each other's report.
struct Outcome {
  std::atomic<bool> reported{false};
  RdKafka::ErrorCode error = RdKafka::ERR_NO_ERROR;  // written before reported is set
};

// librdkafka reports every produced record exactly once (delivered, refused or timed out), on
// whichever thread serves the producer; the report owns the heap reference it was handed.
class DeliveryReport : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    std::unique_ptr<std::shared_ptr<Outcome>> slot(static_cast<std::shared_ptr<Outcome>*>(message.msg_opaque()));
    if (!slot) return;
    (*slot)->error = message.err();
    (*slot)->reported.store(true, std::memory_order_release);
  }
};

DeliveryReport delivery;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json nullable(const std::string& s) { return s.empty() ? json(nullptr) : json(s); }

// Publish match.found, match.started or match.abandoned for the match; true once the broker has it.
bool publishEvent(const std::string& match_id, const std::string& kind) {
  const auto m = store::getMatch(match_id);
  if (!m) return false;
  if (kind == "started" && !store::allJoinsConfirmed(match_id)) return false;  // a client is still connecting
  const json payload = {{"type", "match." + kind},
                        {"match_id", match_id},
                        {"players", m->players},  // every participant, party members included
                        {"server_id", nullable(m->server_id)},
                        {"reason", nullable(m->reason)}};
  const std::string value = payload.dump();
  auto outcome = std::make_shared<Outcome>();
  // The report may come after the window: its own reference keeps the slot alive until then.
  auto* slot = new std::shared_ptr<Outcome>(outcome);
  // Keyed by the match: its found, started and abandoned events share a partition, in order.
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), match_id.c_str(), match_id.size(), 0, slot);
  if (err != RdKafka::ERR_NO_ERROR) {
    delete slot;  // a refused produce is never reported
  } else {
    producer->flush(kAckTimeoutMs);  // serves the delivery reports, or gives up after the window
    err = outcome->reported.load(std::memory_order_acquire) ? outcome->error : RdKafka::ERR__TIMED_OUT;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    store::insertOutbox(kTopic, match_id, payload);  // the relay publishes it once the broker is back
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from matchmaking import store

TOPIC = "match.event"


def _match(match_id, first):
    """A match in pool 15: ticket t{first} is a party of p{first} and p{first+1}, t{first+2} a solo p{first+2}."""
    players = [f"p{first}", f"p{first + 1}", f"p{first + 2}"]
    store.enqueue(f"t{first}", players[0], 1500, players[:2])
    store.enqueue(f"t{first + 2}", players[2], 1510, players[2:])
    store.create_match(match_id, 15, [f"t{first}", f"t{first + 2}"])
    return players


def _ready(match_id, players):
    store.set_server(match_id, f"gs-{match_id}")
    for p in players:
        store.confirm_join(match_id, p)


def _events(ctx):
    return [json.loads(r.value) for r in ctx.kafka.records(TOPIC)]


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox", 0, -1)]


def check_match_key(ctx):
    m = ctx.load("events")
    _ready("m-1", _match("m-1", 1))
    _ready("m-2", _match("m-2", 4))
    for kind in ("found", "started"):
        for match_id in ("m-1", "m-2"):
            m.publish_event(match_id, kind)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 4, f"four publish_event calls produced {len(records)} records on match.event"
    keys = sorted(r.key or b"" for r in records)
    assert keys == [b"m-1", b"m-1", b"m-2", b"m-2"], f"the records are keyed {[r.key for r in records]}, expected the match ids"
    for match_id in (b"m-1", b"m-2"):
        own = [r for r in records if r.key == match_id]
        assert own[0].partition == own[1].partition, f"{match_id.decode()}'s events landed on partitions {own[0].partition} and {own[1].partition}: a consumer can read started before found"


def check_event_payload(ctx):
    m = ctx.load("events")
    _match("m-1", 1)
    m.publish_event("m-1", "found")
    store.abandon("m-1", "allocation_failed")
    m.publish_event("m-1", "abandoned")
    events = _events(ctx)
    assert len(events) == 2, f"two publish_event calls produced {len(events)} events"
    found, abandoned = events
    assert found.get("type") == "match.found" and found.get("match_id") == "m-1", f"the first event is {found}"
    assert found.get("players") == ["p1", "p2", "p3"], f"match.found names players {found.get('players')}, expected ['p1', 'p2', 'p3']: p2 is in p1's party, and a client nobody names never hears it was matched"
    assert "server_id" in found and found["server_id"] is None, f"before allocation server_id must be null, the event is {found}"
    assert abandoned.get("type") == "match.abandoned" and abandoned.get("reason") == "allocation_failed", f"match.abandoned must carry reason allocation_failed, the event is {abandoned}"


def check_started_gate(ctx):
    m = ctx.load("events")
    players = _match("m-1", 1)
    store.set_server("m-1", "gs-m-1")
    store.confirm_join("m-1", "p1")
    store.confirm_join("m-1", "p2")
    assert m.publish_event("m-1", "started") is False, "p3 has not joined: publish_event('m-1', 'started') must answer False"
    started = [e for e in _events(ctx) if e.get("type") == "match.started"]
    assert not started, f"match.started went out while p3 was still connecting: {started}"
    assert _outbox(ctx) == [], f"a refused started is not a failed delivery, yet the outbox holds {_outbox(ctx)}"
    store.confirm_join("m-1", players[2])
    assert m.publish_event("m-1", "started") is True, "with every join confirmed match.started must be published"
    started = [e for e in _events(ctx) if e.get("type") == "match.started"]
    assert len(started) == 1 and started[0].get("server_id") == "gs-m-1", f"the topic holds {started}, expected one match.started on gs-m-1"


def check_outbox(ctx):
    m = ctx.load("events")
    _match("m-1", 1)
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_event("m-1", "found")
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the broker rejected the produce and the outbox holds {len(rows)} rows: the event is gone"
    row = rows[0]
    assert row.get("topic") == TOPIC and row.get("key") == "m-1" and row.get("payload", {}).get("type") == "match.found", f"the outbox row is {row}, expected the topic, the key m-1 and the payload"
    assert ok is False, f"publish_event returned {ok!r} after a rejected produce, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.publish_event("m-1", "found")
    waited = ctx.clock.time() - before
    assert waited <= 2.5, f"publish_event waited {waited:.1f} s for a broker that does not answer: wait for the report at most ACK_TIMEOUT_S (2 s)"
    assert len(_outbox(ctx)) == 2, f"no delivery report within the window and the outbox holds {_outbox(ctx)}"
    assert ok is False, f"publish_event returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'match.event';

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

/** A match in pool 15: ticket t{first} is a party of p{first} and p{first+1}, t{first+2} a solo p{first+2}. */
async function match(store, matchId: string, first: number): Promise<string[]> {
  const players = [\`p\${first}\`, \`p\${first + 1}\`, \`p\${first + 2}\`];
  await store.enqueue(\`t\${first}\`, players[0], 1500, players.slice(0, 2));
  await store.enqueue(\`t\${first + 2}\`, players[2], 1510, players.slice(2));
  await store.createMatch(matchId, 15, [\`t\${first}\`, \`t\${first + 2}\`]);
  return players;
}

async function ready(store, matchId: string, players: string[]) {
  await store.setServer(matchId, \`gs-\${matchId}\`);
  for (const p of players) await store.confirmJoin(matchId, p);
}

const events = ctx => (ctx.kafka.values(TOPIC) as string[]).map(v => JSON.parse(v));
const outbox = ctx => (ctx.redis.lrange('outbox', 0, -1) as string[]).map(row => JSON.parse(row));

function load(ctx) {
  return {m: ctx.load('events'), store: ctx.load('/support/matchmaking/store.ts')};
}

export async function check_match_key(ctx) {
  const {m, store} = load(ctx);
  await ready(store, 'm-1', await match(store, 'm-1', 1));
  await ready(store, 'm-2', await match(store, 'm-2', 4));
  for (const kind of ['found', 'started']) for (const matchId of ['m-1', 'm-2']) await m.publishEvent(matchId, kind);
  await settle();
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 4, \`four publishEvent calls produced \${records.length} records on match.event\`);
  const keys = ctx.kafka.keys(TOPIC);
  assert.deepStrictEqual([...keys].sort(), ['m-1', 'm-1', 'm-2', 'm-2'], \`the records are keyed \${JSON.stringify(keys)}, expected the match ids\`);
  for (const matchId of ['m-1', 'm-2']) {
    const own = records.filter((_, i) => keys[i] === matchId);
    assert.equal(own[0].partition, own[1].partition, \`\${matchId}'s events landed on partitions \${own[0].partition} and \${own[1].partition}: a consumer can read started before found\`);
  }
}

export async function check_event_payload(ctx) {
  const {m, store} = load(ctx);
  await match(store, 'm-1', 1);
  await m.publishEvent('m-1', 'found');
  await store.abandon('m-1', 'allocation_failed');
  await m.publishEvent('m-1', 'abandoned');
  await settle();
  const all = events(ctx);
  assert.equal(all.length, 2, \`two publishEvent calls produced \${all.length} events\`);
  const [found, abandoned] = all;
  assert(found.type === 'match.found' && found.match_id === 'm-1', \`the first event is \${JSON.stringify(found)}\`);
  assert.deepStrictEqual(found.players, ['p1', 'p2', 'p3'], \`match.found names players \${JSON.stringify(found.players)}, expected ["p1","p2","p3"]: p2 is in p1's party, and a client nobody names never hears it was matched\`);
  assert('server_id' in found && found.server_id === null, \`before allocation server_id must be null, the event is \${JSON.stringify(found)}\`);
  assert(abandoned.type === 'match.abandoned' && abandoned.reason === 'allocation_failed', \`match.abandoned must carry reason allocation_failed, the event is \${JSON.stringify(abandoned)}\`);
}

export async function check_started_gate(ctx) {
  const {m, store} = load(ctx);
  await match(store, 'm-1', 1);
  await store.setServer('m-1', 'gs-m-1');
  await store.confirmJoin('m-1', 'p1');
  await store.confirmJoin('m-1', 'p2');
  assert.equal(await m.publishEvent('m-1', 'started'), false, "p3 has not joined: publishEvent('m-1', 'started') must answer false");
  await settle();
  let started = events(ctx).filter(e => e.type === 'match.started');
  assert.deepStrictEqual(started, [], \`match.started went out while p3 was still connecting: \${JSON.stringify(started)}\`);
  assert.deepStrictEqual(outbox(ctx), [], \`a refused started is not a failed delivery, yet the outbox holds \${JSON.stringify(outbox(ctx))}\`);
  await store.confirmJoin('m-1', 'p3');
  assert.equal(await m.publishEvent('m-1', 'started'), true, 'with every join confirmed match.started must be published');
  await settle();
  started = events(ctx).filter(e => e.type === 'match.started');
  assert(started.length === 1 && started[0].server_id === 'gs-m-1', \`the topic holds \${JSON.stringify(started)}, expected one match.started on gs-m-1\`);
}

export async function check_outbox(ctx) {
  const {m, store} = load(ctx);
  await match(store, 'm-1', 1);
  ctx.kafka.failNext(TOPIC, 1);
  let ok = await m.publishEvent('m-1', 'found');
  await settle();
  const rows = outbox(ctx);
  assert.equal(rows.length, 1, \`the broker rejected the produce and the outbox holds \${rows.length} rows: the event is gone\`);
  assert(rows[0].topic === TOPIC && rows[0].key === 'm-1' && rows[0].payload?.type === 'match.found', \`the outbox row is \${JSON.stringify(rows[0])}, expected the topic, the key m-1 and the payload\`);
  assert.equal(ok, false, \`publishEvent resolved \${JSON.stringify(ok)} after a rejected produce, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.publishEvent('m-1', 'found');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 2.5, \`publishEvent waited \${waited.toFixed(1)} s for a broker that does not answer: wait for the report at most ACK_TIMEOUT_MS (2000 ms)\`);
  assert.equal(outbox(ctx).length, 2, \`no delivery report within the window and the outbox holds \${JSON.stringify(outbox(ctx))}\`);
  assert.equal(ok, false, \`publishEvent resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"matchmaking/store"

	"leetbuild/harness"
)

const eventsTopic = "match.event"

var eventsBg = context.Background()

// eventsMatch is a match in pool 15: t{first} is a party of p{first} and p{first+1}, t{first+2} a solo p{first+2}.
func eventsMatch(matchID string, first int) []string {
	players := []string{fmt.Sprintf("p%d", first), fmt.Sprintf("p%d", first+1), fmt.Sprintf("p%d", first+2)}
	store.Enqueue(eventsBg, fmt.Sprintf("t%d", first), players[0], 1500, players[:2])
	store.Enqueue(eventsBg, fmt.Sprintf("t%d", first+2), players[2], 1510, players[2:])
	store.CreateMatch(eventsBg, matchID, 15, []string{fmt.Sprintf("t%d", first), fmt.Sprintf("t%d", first+2)})
	return players
}

func eventsReady(matchID string, players []string) {
	store.SetServer(eventsBg, matchID, "gs-"+matchID)
	for _, p := range players {
		store.ConfirmJoin(eventsBg, matchID, p)
	}
}

func eventsPublish(ctx *harness.Ctx, matchID, kind string) bool {
	ok, err := publishEvent(eventsBg, matchID, kind)
	ctx.NoError(err, "publishEvent(%s, %s)", matchID, kind)
	return ok
}

func eventsAll(ctx *harness.Ctx) []map[string]any {
	out := []map[string]any{}
	for _, v := range ctx.Kafka.Values(eventsTopic) {
		var e map[string]any
		ctx.NoError(json.Unmarshal([]byte(v), &e), "an event must be JSON: %s", v)
		out = append(out, e)
	}
	return out
}

func eventsOutbox(ctx *harness.Ctx) []map[string]any {
	out := []map[string]any{}
	for _, text := range ctx.Redis.LRange("outbox", 0, -1) {
		var row map[string]any
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with topic, key and payload")
		out = append(out, row)
	}
	return out
}

func eventsOfType(ctx *harness.Ctx, kind string) []map[string]any {
	out := []map[string]any{}
	for _, e := range eventsAll(ctx) {
		if e["type"] == kind {
			out = append(out, e)
		}
	}
	return out
}

func CheckMatchKey(ctx *harness.Ctx) {
	eventsReady("m-1", eventsMatch("m-1", 1))
	eventsReady("m-2", eventsMatch("m-2", 4))
	for _, kind := range []string{"found", "started"} {
		for _, matchID := range []string{"m-1", "m-2"} {
			eventsPublish(ctx, matchID, kind)
		}
	}
	ctx.Settle()
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 4, "four publishEvent calls must produce four records on match.event; the records")
	keys := ctx.Kafka.Keys(eventsTopic)
	count := map[string]int{}
	partition := map[string]map[int]bool{}
	for i, k := range keys {
		count[k]++
		if partition[k] == nil {
			partition[k] = map[int]bool{}
		}
		partition[k][int(records[i].Partition)] = true
	}
	ctx.Assert(count["m-1"] == 2 && count["m-2"] == 2, "the records are keyed %q, expected the match ids", keys)
	for _, matchID := range []string{"m-1", "m-2"} {
		ctx.Equal(len(partition[matchID]), 1, "%s's events must land on one partition, or a consumer can read started before found; the partitions", matchID)
	}
}

func CheckEventPayload(ctx *harness.Ctx) {
	eventsMatch("m-1", 1)
	eventsPublish(ctx, "m-1", "found")
	store.Abandon(eventsBg, "m-1", "allocation_failed")
	eventsPublish(ctx, "m-1", "abandoned")
	ctx.Settle()
	all := eventsAll(ctx)
	ctx.Equal(len(all), 2, "two publishEvent calls must produce two events; the events")
	found, abandoned := all[0], all[1]
	ctx.Assert(found["type"] == "match.found" && found["match_id"] == "m-1", "the first event is %v", found)
	ctx.Equal(found["players"], []any{"p1", "p2", "p3"}, "match.found must name every player (p2 is in p1's party, and a client nobody names never hears it was matched); the players")
	serverID, has := found["server_id"]
	ctx.Assert(has && serverID == nil, "before allocation server_id must be null, the event is %v", found)
	ctx.Assert(abandoned["type"] == "match.abandoned" && abandoned["reason"] == "allocation_failed", "match.abandoned must carry reason allocation_failed, the event is %v", abandoned)
}

func CheckStartedGate(ctx *harness.Ctx) {
	eventsMatch("m-1", 1)
	store.SetServer(eventsBg, "m-1", "gs-m-1")
	store.ConfirmJoin(eventsBg, "m-1", "p1")
	store.ConfirmJoin(eventsBg, "m-1", "p2")
	ctx.Equal(eventsPublish(ctx, "m-1", "started"), false, "p3 has not joined: publishEvent(m-1, started)")
	ctx.Settle()
	ctx.Equal(len(eventsOfType(ctx, "match.started")), 0, "match.started must not go out while p3 is still connecting; the started events")
	ctx.Equal(len(eventsOutbox(ctx)), 0, "a refused started is not a failed delivery; the outbox rows")
	store.ConfirmJoin(eventsBg, "m-1", "p3")
	ctx.Equal(eventsPublish(ctx, "m-1", "started"), true, "with every join confirmed match.started must be published")
	ctx.Settle()
	started := eventsOfType(ctx, "match.started")
	ctx.Assert(len(started) == 1 && started[0]["server_id"] == "gs-m-1", "the topic holds %v, expected one match.started on gs-m-1", started)
}

func CheckOutbox(ctx *harness.Ctx) {
	eventsMatch("m-1", 1)
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := eventsPublish(ctx, "m-1", "found")
	ctx.Settle()
	rows := eventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the broker rejected the produce: without an outbox row the event is gone; the rows")
	payload, _ := rows[0]["payload"].(map[string]any)
	ctx.Assert(rows[0]["topic"] == eventsTopic && rows[0]["key"] == "m-1" && payload["type"] == "match.found", "the outbox row is %v, expected the topic, the key m-1 and the payload", rows[0])
	ctx.Equal(ok, false, "publishEvent's result after a rejected produce")
	ctx.Kafka.Stall(eventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = eventsPublish(ctx, "m-1", "found")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 2.5, "publishEvent waited %.1f s for a broker that does not answer: wait for the report at most ackTimeout (2 s)", waited)
	ctx.Equal(len(eventsOutbox(ctx)), 2, "no delivery report within the window; the outbox rows")
	ctx.Equal(ok, false, "publishEvent's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>
#include <vector>

#include "matchmaking/store.h"

namespace {

const std::string kEventsTopic = "match.event";

// A match in pool 15: t{first} is a party of p{first} and p{first+1}, t{first+2} a solo p{first+2}.
std::vector<std::string> eventsMatch(const std::string& match_id, int first) {
  const std::vector<std::string> players = {"p" + std::to_string(first), "p" + std::to_string(first + 1), "p" + std::to_string(first + 2)};
  store::enqueue("t" + std::to_string(first), players[0], 1500, {players[0], players[1]});
  store::enqueue("t" + std::to_string(first + 2), players[2], 1510, {players[2]});
  store::createMatch(match_id, 15, {"t" + std::to_string(first), "t" + std::to_string(first + 2)});
  return players;
}

void eventsReady(const std::string& match_id, const std::vector<std::string>& players) {
  store::setServer(match_id, "gs-" + match_id);
  for (const auto& p : players) store::confirmJoin(match_id, p);
}

std::vector<nlohmann::json> eventsAll(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& v : ctx.Kafka.Values(kEventsTopic)) out.push_back(nlohmann::json::parse(v, nullptr, false));
  return out;
}

std::vector<nlohmann::json> eventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> out;
  for (const auto& text : ctx.Redis.LRange("outbox", 0, -1)) out.push_back(nlohmann::json::parse(text, nullptr, false));
  return out;
}

std::string field(const nlohmann::json& j, const std::string& name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

std::vector<nlohmann::json> eventsOfType(harness::Ctx& ctx, const std::string& type) {
  std::vector<nlohmann::json> out;
  for (const auto& e : eventsAll(ctx)) {
    if (field(e, "type") == type) out.push_back(e);
  }
  return out;
}

}  // namespace

void CheckMatchKey(harness::Ctx& ctx) {
  eventsReady("m-1", eventsMatch("m-1", 1));
  eventsReady("m-2", eventsMatch("m-2", 4));
  for (const std::string kind : {"found", "started"}) {
    for (const std::string match_id : {"m-1", "m-2"}) publishEvent(match_id, kind);
  }
  ctx.Settle();
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 4, "four publishEvent calls must produce four records on match.event; the records");
  const auto keys = ctx.Kafka.Keys(kEventsTopic);
  std::map<std::string, int> count;
  std::map<std::string, std::set<int>> partitions;
  for (size_t i = 0; i < keys.size() && i < records.size(); i++) {
    count[keys[i]]++;
    partitions[keys[i]].insert(static_cast<int>(records[i].Partition));
  }
  ctx.Assert(count["m-1"] == 2 && count["m-2"] == 2, "the records are keyed %q, expected the match ids", keys);
  for (const std::string match_id : {"m-1", "m-2"}) {
    ctx.Equal(partitions[match_id].size(), 1, "%s's events must land on one partition, or a consumer can read started before found; the partitions", match_id);
  }
}

void CheckEventPayload(harness::Ctx& ctx) {
  eventsMatch("m-1", 1);
  publishEvent("m-1", "found");
  store::abandon("m-1", "allocation_failed");
  publishEvent("m-1", "abandoned");
  ctx.Settle();
  const auto all = eventsAll(ctx);
  ctx.Equal(all.size(), 2, "two publishEvent calls must produce two events; the events");
  const nlohmann::json found = all[0];
  const nlohmann::json abandoned = all[1];
  ctx.Assert(field(found, "type") == "match.found" && field(found, "match_id") == "m-1", "the first event is %s", found.dump());
  ctx.Assert(found.is_object() && found.value("players", nlohmann::json()) == nlohmann::json({"p1", "p2", "p3"}), "match.found names players %s, expected [\\"p1\\",\\"p2\\",\\"p3\\"]: p2 is in p1's party, and a client nobody names never hears it was matched", found.is_object() ? found.value("players", nlohmann::json()).dump() : "");
  ctx.Assert(found.is_object() && found.contains("server_id") && found["server_id"].is_null(), "before allocation server_id must be null, the event is %s", found.dump());
  ctx.Assert(field(abandoned, "type") == "match.abandoned" && field(abandoned, "reason") == "allocation_failed", "match.abandoned must carry reason allocation_failed, the event is %s", abandoned.dump());
}

void CheckStartedGate(harness::Ctx& ctx) {
  eventsMatch("m-1", 1);
  store::setServer("m-1", "gs-m-1");
  store::confirmJoin("m-1", "p1");
  store::confirmJoin("m-1", "p2");
  ctx.Equal(publishEvent("m-1", "started"), false, "p3 has not joined: publishEvent(m-1, started)");
  ctx.Settle();
  ctx.Equal(eventsOfType(ctx, "match.started").size(), 0, "match.started must not go out while p3 is still connecting; the started events");
  ctx.Equal(eventsOutbox(ctx).size(), 0, "a refused started is not a failed delivery; the outbox rows");
  store::confirmJoin("m-1", "p3");
  ctx.Equal(publishEvent("m-1", "started"), true, "with every join confirmed match.started must be published");
  ctx.Settle();
  const auto started = eventsOfType(ctx, "match.started");
  ctx.Assert(started.size() == 1 && field(started[0], "server_id") == "gs-m-1", "the topic holds %d match.started events, expected one on gs-m-1", started.size());
}

void CheckOutbox(harness::Ctx& ctx) {
  eventsMatch("m-1", 1);
  ctx.Kafka.FailNext(kEventsTopic, 1);
  bool ok = publishEvent("m-1", "found");
  ctx.Settle();
  auto rows = eventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the broker rejected the produce: without an outbox row the event is gone; the rows");
  ctx.Assert(field(rows[0], "topic") == kEventsTopic && field(rows[0], "key") == "m-1" && rows[0].contains("payload") && field(rows[0]["payload"], "type") == "match.found",
             "the outbox row is %s, expected the topic, the key m-1 and the payload", rows[0].dump());
  ctx.Equal(ok, false, "publishEvent's result after a rejected produce");
  ctx.Kafka.Stall(kEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = publishEvent("m-1", "found");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 2.5, "publishEvent waited %.1f s for a broker that does not answer: wait for the report at most kAckTimeoutMs (2 s)", waited);
  ctx.Equal(eventsOutbox(ctx).size(), 2, "no delivery report within the window; the outbox rows");
  ctx.Equal(ok, false, "publishEvent's result without a delivery report");
}
`,
  },
  hints: [
    "Publish two matches' events together and read them back: one match's started can come before its found. A party member's client is never told it was matched, and started goes out while a client is still connecting.",
    'With no key the partitioner spreads one match over partitions; the player list is built from ticket owners; nothing asks whether every join is in; and the flush result is ignored, so a rejected produce looks sent.',
    'Produce with `key=match_id` and `players=match["players"]` plus `reason`; return False before producing `started` unless `store.all_joins_confirmed`; read the error in `on_delivery`, and after `flush(ACK_TIMEOUT_S)` call `store.insert_outbox` when it is set or the record is still in flight.',
  ],
  debrief: `Kafka orders records within a partition and the key picks the partition, so the match id as key is what makes one match's lifecycle readable in order; ordering across matches is neither needed nor promised. The started gate puts the meaning of the event in the producer: consumers that hide the lobby on started are right only if started means every client has joined. The outbox turns a broker outage into a late event instead of a lost one, which is why the return value has to come from the delivery report, not from the call that queued the record. Production pipelines run the outbox relay as its own process, make consumers deduplicate by match id and type because the relay can publish twice, and version the payload schema in a registry.`,
};
