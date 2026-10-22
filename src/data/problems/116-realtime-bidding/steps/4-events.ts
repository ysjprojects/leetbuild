import type {Step} from '@/lib/types';

/**
 * Step 4 — the bid event stream. One event per bid, win or loss, keyed by auction so an auction's
 * history stays ordered, with the loss reason attached and an outbox for rejected produces.
 */
export const eventsStep: Step = {
  id: 'events',
  title: 'Bid events keyed by auction with loss reasons',
  concept: 'kafka',
  file: 'events',
  focus: ['bidding', 'kafka', 'outbox', 'consumer'],
  task: `## Task

**Review premise.** You are the AI platform engineer on call. The analytics team cannot compute a win
rate: the \`bid.event\` topic holds bids and wins but no losses at all, and the losses it was told to
expect disappeared. Worse, one auction's events are spread over every partition because the producer
keys by bidder, so a consumer replaying the topic sees a win before the bid that produced it. And a
crash during a produce left a spend charge that no event explains.

Review \`events\` and make the auction's history complete, ordered and reconcilable.

- Every event about one auction must share a partition: key the produce with the **auction id**
  (\`partition_key(event)\` returning \`event["auction_id"]\` / \`event.auction_id\` / \`event.AuctionID\`),
  so a consumer sees one auction's bid, win or loss in the order they happened.
- **Losses are published, and they always carry a reason.** Build them with a named
  \`loss_event\` / \`lossEvent\` that sets \`result: "loss"\` and a \`loss_reason\`. A win rate computed
  without loss reasons cannot be diagnosed — the draft drops every loss instead.
- **Publish after the spend claim commits**: \`spend.commit(claim)\` happens first, so an event can
  never reference a charge that was rolled back.
- A produce the broker rejects must **not** be dropped: keep it in the outbox
  (\`publish_with_outbox\` / \`publishWithOutbox\` → \`outbox.put\`), so a retry can republish it.
- Produce durably: \`acks=all\` with idempotent retries where the client exposes them
  (Go: \`RequiredAcks: kafka.RequireAll\` plus a \`kafka.Hash\` balancer so the auction key picks the
  partition). The draft asks for \`acks=1\` and calls the produce successful on the local send.

**Failure mode the checks target.** The draft is a working publisher that answers the wrong questions:
keying by bidder scatters an auction across partitions, so ordering is lost and a consumer that
replays cannot rebuild the auction; dropping losses makes the win rate undiagnosable — a bidder whose
bids are always too low looks identical to one whose bids are never delivered; and publishing before
the claim commits leaves the reconciliation job chasing an event for a spend that never existed.`,
  sequence: {
    participants: ['Bidding service', 'Spend ledger', 'bid.event', 'Stats consumer'],
    messages: [
      {from: 'Bidding service', to: 'Spend ledger', label: 'commit(claim) — the spend is final', kind: 'sync'},
      {from: 'Spend ledger', to: 'Bidding service', label: 'committed', kind: 'reply'},
      {from: 'Bidding service', to: 'bid.event', label: 'produce key = auction_id · acks=all', kind: 'async'},
      {from: 'bid.event', to: 'Bidding service', label: 'rejected → outbox.put(event)', kind: 'reply'},
      {from: 'Bidding service', to: 'bid.event', label: 'produce loss event {result, loss_reason}', kind: 'async'},
      {from: 'bid.event', to: 'Stats consumer', label: 'consume · one auction per partition', kind: 'async'},
      {from: 'Stats consumer', to: 'Stats consumer', label: 'wins, losses and reasons in order', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'auction-key',
      title: 'Every event is keyed by its auction',
      detail:
        'A `partition_key` / `partitionKey` returns the auction id and the produce uses it as the message key, so every event about one auction lands in one partition in order. The draft keys by bidder, so an auction’s history scatters and a replay cannot rebuild it.',
      match: {
        python: {all: [/def partition_key\(/, /return event\["auction_id"\]/]},
        typescript: {all: [/function partitionKey\(/, /return event\.auction_id/]},
        go: {all: [/func partitionKey\(/, /return e\.AuctionID/]},
        scala: {all: [/def partitionKey\(/, /event\.auction_id/]},
        cpp: {all: [/partitionKey\(/, /return event\.auction_id/]},
      },
    },
    {
      id: 'loss-reason',
      title: 'Losses are published with a reason',
      detail:
        'A `loss_event` / `lossEvent` builds `result: "loss"` together with a `loss_reason`, and the settlement publishes it. The draft drops every loss, so the win rate in the stats read has no inputs.',
      match: {
        python: {all: [/def loss_event\(/, /loss_reason/, /"result": "loss"/]},
        typescript: {all: [/function lossEvent\(/, /loss_reason/, /result: 'loss'/]},
        go: {all: [/func lossEvent\(/, /LossReason: lossReason/, /Result:\s*"loss"/]},
        scala: {all: [/def lossEvent\(/, /loss_reason/, /"loss",\s*lossReason/]},
        cpp: {all: [/lossEvent\(/, /loss_reason/, /"loss",\s*lossReason/]},
      },
    },
    {
      id: 'publish-after-claim',
      title: 'The spend is committed before the event is published',
      detail:
        '`spend.commit(claim)` runs before the event is published, so a published event always corresponds to a charge that stands. The draft publishes first and commits afterwards.',
      match: {
        python: {order: [/spend\.commit\(claim\)/, /publish_with_outbox\(event\)/]},
        typescript: {order: [/spend\.commit\(claim\)/, /publishWithOutbox\(event\)/]},
        go: {order: [/spend\.Commit\(ctx, claim\)/, /publishWithOutbox\(ctx, writer, event\)/]},
        scala: {order: [/spend\.commit\(claim\)/, /publishWithOutbox\(event\)/]},
        cpp: {order: [/spend\.commit\(claim\)/, /publishWithOutbox\(rk, topic, event\)/]},
      },
    },
    {
      id: 'outbox',
      title: 'A rejected produce is kept in the outbox',
      detail:
        'The produce goes through `publish_with_outbox` / `publishWithOutbox`, and a rejection writes an `outbox` row instead of dropping the event, so a retry can republish it. The draft treats the local send as success.',
      match: {
        python: {all: [/def publish_with_outbox\(/, /outbox\.put\(/]},
        typescript: {all: [/function publishWithOutbox\(/, /outbox\.put\(/]},
        go: {all: [/func publishWithOutbox\(/, /outbox\.Put\(/]},
        scala: {all: [/def publishWithOutbox\(/, /[Oo]utbox\.put\(/]},
        cpp: {all: [/void publishWithOutbox\(/, /outbox\.put\(/]},
      },
    },
    {
      id: 'durable-produce',
      title: 'The producer is durable and idempotent',
      detail:
        'Configure `acks=all` and idempotent retries (Go: `RequiredAcks: kafka.RequireAll` with a `kafka.Hash` balancer) so a retry after a timeout cannot duplicate a bid event and a produce is not called successful before the replicas hold it.',
      match: {
        python: {all: [/"acks": "all"/, /"enable\.idempotence": True/]},
        typescript: {all: [/acks: -1/, /idempotent: true/]},
        go: {all: [/RequiredAcks: kafka\.RequireAll/, /Balancer: *&kafka\.Hash\{/]},
        scala: {all: [/"acks", "all"/, /"enable\.idempotence", "true"/]},
        cpp: {all: [/"acks", "all"/, /"enable\.idempotence", "true"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("bid-events")

TOPIC = "bid.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


class Outbox:
    def put(self, record: dict) -> None:
        raise NotImplementedError


outbox = Outbox()


class BidEvents:
    """Publishes one bid.event per bid."""

    def __init__(self, spend) -> None:
        self.spend = spend

    def publish(self, event: dict) -> None:
        producer.produce(TOPIC, key=event["bidder_id"], value=json.dumps(event))
        producer.poll(0)

    def record_result(self, claim: dict, result: str, auction_id: str, loss_reason: str = "") -> None:
        # TODO: this draft keys by bidder so one auction's history scatters across partitions,
        # drops every loss so win rate cannot be diagnosed, and publishes before the spend claim
        # commits, so a crash between the two leaves a charge that no event explains.
        if result == "win":
            self.publish({"auction_id": auction_id, "bidder_id": claim["bidder"], "result": result})
        self.spend.commit(claim)
`,
      solution: `import json
import logging

from confluent_kafka import KafkaException, Producer

logger = logging.getLogger("bid-events")

TOPIC = "bid.event"

# acks=all with idempotent retries: a duplicated bid event would double-count a win.
producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "acks": "all",
        "enable.idempotence": True,
    }
)


class Outbox:
    def put(self, record: dict) -> None:
        """Keeps a bid event the broker rejected, so a retry can republish it."""
        raise NotImplementedError


outbox = Outbox()


def partition_key(event: dict) -> str:
    """Every event about one auction shares a partition, so the auction's history stays ordered."""
    return event["auction_id"]


def loss_event(auction_id: str, bidder_id: str, bid_cents: int, loss_reason: str) -> dict:
    """A loss always says why: a win rate without loss reasons cannot be diagnosed."""
    return {
        "auction_id": auction_id,
        "bidder_id": bidder_id,
        "bid_cents": bid_cents,
        "result": "loss",
        "loss_reason": loss_reason,
    }


def publish_with_outbox(event: dict) -> None:
    """Produce under the auction key; a rejection is kept in the outbox instead of dropped."""
    try:
        producer.produce(TOPIC, key=partition_key(event), value=json.dumps(event))
        producer.flush()
    except KafkaException:
        logger.warning("produce rejected auction=%s result=%s", event["auction_id"], event["result"])
        outbox.put(event)


class BidEvents:
    """Publishes one bid.event per bid, win or loss, after the spend is settled."""

    def __init__(self, spend) -> None:
        self.spend = spend

    def record_result(self, claim: dict, result: str, auction_id: str, loss_reason: str = "") -> None:
        # The spend is committed first: an event outrunning its claim is an event the reconciliation
        # job cannot explain.
        self.spend.commit(claim)
        if result == "loss":
            event = loss_event(auction_id, claim["bidder"], claim["cents"], loss_reason)
        else:
            event = {
                "auction_id": auction_id,
                "bidder_id": claim["bidder"],
                "bid_cents": claim["cents"],
                "result": result,
            }
        logger.info("bid event auction=%s result=%s", auction_id, result)
        publish_with_outbox(event)
`,
    },
    typescript: {
      starter: `/** bid.event: one event per bid. */
import {Kafka} from 'kafkajs';

const TOPIC = 'bid.event';

const producer = new Kafka({brokers: ['kafka:9092']}).producer({acks: 1});

interface Claim {
  bidder: string;
  cents: number;
}

interface SpendLedger {
  commit(claim: Claim): Promise<void>;
}

export class BidEvents {
  constructor(private readonly spend: SpendLedger) {}

  async publish(event: {auction_id: string; bidder_id: string; result: string}): Promise<void> {
    await producer.send({
      topic: TOPIC,
      acks: 1,
      messages: [{key: event.bidder_id, value: JSON.stringify(event)}],
    });
  }

  async recordResult(claim: Claim, result: string, auctionId: string): Promise<void> {
    // TODO: this draft keys by bidder so one auction's history scatters across partitions, drops
    // every loss so win rate cannot be diagnosed, and publishes before the spend claim commits,
    // so a crash between the two leaves a charge that no event explains.
    if (result === 'win') {
      await this.publish({auction_id: auctionId, bidder_id: claim.bidder, result});
    }
    await this.spend.commit(claim);
  }
}
`,
      solution: `/** bid.event: one event per bid, win or loss, published after the spend claim commits. */
import {Kafka} from 'kafkajs';

const TOPIC = 'bid.event';

interface Claim {
  bidder: string;
  cents: number;
}

interface SpendLedger {
  commit(claim: Claim): Promise<void>;
}

interface BidEvent {
  auction_id: string;
  bidder_id: string;
  bid_cents: number;
  result: string;
  loss_reason?: string;
}

// acks=all with idempotent retries: a duplicated bid event would double-count a win.
const producer = new Kafka({brokers: ['kafka:9092']}).producer({idempotent: true, acks: -1});

const outbox = {
  put(record: BidEvent): void {
    throw new Error('outbox not implemented');
  },
};

/** Every event about one auction shares a partition, so the auction's history stays ordered. */
function partitionKey(event: BidEvent): string {
  return event.auction_id;
}

/** A loss always says why: a win rate without loss reasons cannot be diagnosed. */
function lossEvent(auctionId: string, bidderId: string, bidCents: number, lossReason: string): BidEvent {
  return {
    auction_id: auctionId,
    bidder_id: bidderId,
    bid_cents: bidCents,
    result: 'loss',
    loss_reason: lossReason,
  };
}

/** Produce under the auction key; a rejection is kept in the outbox instead of dropped. */
async function publishWithOutbox(event: BidEvent): Promise<void> {
  try {
    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: [{key: partitionKey(event), value: JSON.stringify(event)}],
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    outbox.put(event);
  }
}

export class BidEvents {
  constructor(private readonly spend: SpendLedger) {}

  async recordResult(claim: Claim, result: string, auctionId: string, lossReason: string): Promise<void> {
    // The spend is committed first: an event outrunning its claim is an event the reconciliation
    // job cannot explain.
    await this.spend.commit(claim);
    const event =
      result === 'loss'
        ? lossEvent(auctionId, claim.bidder, claim.cents, lossReason)
        : {auction_id: auctionId, bidder_id: claim.bidder, bid_cents: claim.cents, result};
    console.info({auction: auctionId, result}, 'bid event');
    await publishWithOutbox(event);
  }
}
`,
    },
    go: {
      starter: `package events

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

const Topic = "bid.event"

type BidEvent struct {
	AuctionID string \`json:"auction_id"\`
	BidderID  string \`json:"bidder_id"\`
	Result    string \`json:"result"\`
}

type Claim struct {
	Bidder string
	Cents  int
}

type SpendLedger interface {
	Commit(ctx context.Context, claim Claim) error
}

type BidEvents struct {
	spend SpendLedger
}

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        Topic,
	RequiredAcks: kafka.RequireNone,
}

func (b *BidEvents) Publish(ctx context.Context, event BidEvent) error {
	payload, _ := json.Marshal(event)
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(event.BidderID), Value: payload})
}

func (b *BidEvents) RecordResult(ctx context.Context, claim Claim, result, auctionID string) error {
	// TODO: this draft keys by bidder so one auction's history scatters across partitions, drops
	// every loss so win rate cannot be diagnosed, and publishes before the spend claim commits,
	// so a crash between the two leaves a charge that no event explains.
	if result == "win" {
		if err := b.Publish(ctx, BidEvent{AuctionID: auctionID, BidderID: claim.Bidder, Result: result}); err != nil {
			return err
		}
	}
	return b.spend.Commit(ctx, claim)
}
`,
      solution: `package events

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

const Topic = "bid.event"

type BidEvent struct {
	AuctionID  string \`json:"auction_id"\`
	BidderID   string \`json:"bidder_id"\`
	BidCents   int    \`json:"bid_cents"\`
	Result     string \`json:"result"\`
	LossReason string \`json:"loss_reason,omitempty"\`
}

type Claim struct {
	Bidder string
	Cents  int
}

type SpendLedger interface {
	Commit(ctx context.Context, claim Claim) error
}

type Outbox struct{}

func (o *Outbox) Put(ctx context.Context, event BidEvent) error {
	return nil
}

var outbox = &Outbox{}

// NewWriter waits for the full in-sync replica set, so a produce is not durable until the replicas
// hold it, and hashes on the auction key so one auction's events share a partition.
func NewWriter() *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP("kafka:9092"),
		Topic:        Topic,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}
}

// partitionKey: every event about one auction shares a partition, so its history stays ordered.
func partitionKey(e BidEvent) string {
	return e.AuctionID
}

// lossEvent: a loss always says why, or the win rate cannot be diagnosed.
func lossEvent(auctionID, bidderID string, bidCents int, lossReason string) BidEvent {
	return BidEvent{
		AuctionID:  auctionID,
		BidderID:   bidderID,
		BidCents:   bidCents,
		Result:     "loss",
		LossReason: lossReason,
	}
}

type BidEvents struct {
	spend SpendLedger
}

// publishWithOutbox produces under the auction key; a rejection is kept in the outbox, not dropped.
func publishWithOutbox(ctx context.Context, writer *kafka.Writer, event BidEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(partitionKey(event)), Value: payload}); err != nil {
		if outboxErr := outbox.Put(ctx, event); outboxErr != nil {
			return outboxErr
		}
		return err
	}
	return nil
}

// RecordResult commits the spend first: an event outrunning its claim cannot be reconciled.
func (b *BidEvents) RecordResult(ctx context.Context, writer *kafka.Writer, claim Claim, result, auctionID, lossReason string) error {
	if err := b.spend.Commit(ctx, claim); err != nil {
		return err
	}
	event := BidEvent{AuctionID: auctionID, BidderID: claim.Bidder, BidCents: claim.Cents, Result: result}
	if result == "loss" {
		event = lossEvent(auctionID, claim.Bidder, claim.Cents, lossReason)
	}
	log.Printf("bid event auction=%s result=%s", auctionID, result)
	return publishWithOutbox(ctx, writer, event)
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

final case class BidEvent(auction_id: String, bidder_id: String, result: String)

final case class Claim(bidder: String, cents: Int)

trait SpendLedger {
  def commit(claim: Claim): Unit
}

object Outbox {
  def put(event: BidEvent): Unit = ()
}

object BidEvents {
  val Topic = "bid.event"

  val ProducerProps: Properties = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    props
  }

  val producer = new KafkaProducer[String, String](ProducerProps)

  def publish(event: BidEvent): Unit = {
    producer.send(new ProducerRecord[String, String](Topic, event.bidder_id, event.toString))
  }
}

class BidEvents(spend: SpendLedger) {
  def recordResult(claim: Claim, result: String, auctionId: String, lossReason: String): Unit = {
    // TODO: this draft keys by bidder so one auction's history scatters across partitions, drops
    // every loss so win rate cannot be diagnosed, and publishes before the spend claim commits,
    // so a crash between the two leaves a charge that no event explains.
    if (result == "win") {
      BidEvents.publish(BidEvent(auctionId, claim.bidder, result))
    }
    spend.commit(claim)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

final case class BidEvent(
    auction_id: String,
    bidder_id: String,
    bid_cents: Int,
    result: String,
    loss_reason: String
)

final case class Claim(bidder: String, cents: Int)

trait SpendLedger {
  def commit(claim: Claim): Unit
}

object Outbox {
  def put(event: BidEvent): Unit = ()
}

object BidEvents {
  val Topic = "bid.event"

  // acks=all with idempotent retries: a duplicated bid event would double-count a win.
  val ProducerProps: Properties = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all")
    props.put("enable.idempotence", "true")
    props
  }

  val producer = new KafkaProducer[String, String](ProducerProps)

  /** Every event about one auction shares a partition, so the auction's history stays ordered. */
  def partitionKey(event: BidEvent): String = {
    // One partition per auction: a consumer replaying the topic sees bid then win then loss.
    event.auction_id
  }

  /** A loss always says why: a win rate without loss reasons cannot be diagnosed. */
  def lossEvent(auctionId: String, bidderId: String, bidCents: Int, lossReason: String): BidEvent = {
    BidEvent(auctionId, bidderId, bidCents, "loss", lossReason)
  }

  /** Produce under the auction key; a rejection is kept in the outbox instead of dropped. */
  def publishWithOutbox(event: BidEvent): Unit = {
    try {
      producer.send(new ProducerRecord[String, String](Topic, partitionKey(event), event.toString))
    } catch {
      case _: RuntimeException => Outbox.put(event)
    }
  }
}

class BidEvents(spend: SpendLedger) {
  def recordResult(claim: Claim, result: String, auctionId: String, lossReason: String): Unit = {
    // The spend is committed first: an event outrunning its claim cannot be reconciled.
    spend.commit(claim)
    val event =
      if (result == "loss") BidEvents.lossEvent(auctionId, claim.bidder, claim.cents, lossReason)
      else BidEvent(auctionId, claim.bidder, claim.cents, result, "")
    println(s"bid event auction=$auctionId result=$result")
    BidEvents.publishWithOutbox(event)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <string>

const std::string kTopic = "bid.event";

struct BidEvent {
  std::string auction_id;
  std::string bidder_id;
  std::string result;
};

struct Claim {
  std::string bidder;
  int cents;
};

struct SpendLedger {
  void commit(const Claim& claim);
};

struct Outbox {
  void put(const BidEvent& event);
};

Outbox outbox;

RdKafka::Producer* producer() {
  std::string err;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return RdKafka::Producer::create(conf, err);
}

RdKafka::Topic* topic() {
  std::string err;
  return RdKafka::Topic::create(producer(), kTopic, nullptr, err);
}

void publish(RdKafka::Producer* rk, RdKafka::Topic* tp, const BidEvent& event) {
  const std::string payload = event.result;
  rk->produce(tp, RdKafka::Message::COPY, event.bidder_id, RdKafka::Message::COPY, payload.c_str(),
              payload.size(), 0);
}

void recordResult(SpendLedger& spend, const Claim& claim, const std::string& result, const std::string& auctionId,
                  const std::string& lossReason) {
  // TODO: this draft keys by bidder so one auction's history scatters across partitions, drops
  // every loss so win rate cannot be diagnosed, and publishes before the spend claim commits, so a
  // crash between the two leaves a charge that no event explains.
  if (result == "win") {
    publish(producer(), topic(), BidEvent{auctionId, claim.bidder, result});
  }
  spend.commit(claim);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <string>

const std::string kTopic = "bid.event";

struct BidEvent {
  std::string auction_id;
  std::string bidder_id;
  int bid_cents;
  std::string result;
  std::string loss_reason;
};

struct Claim {
  std::string bidder;
  int cents;
};

struct SpendLedger {
  void commit(const Claim& claim);
};

struct Outbox {
  void put(const BidEvent& event);
};

Outbox outbox;

/** acks=all with idempotent retries: a duplicated bid event would double-count a win. */
RdKafka::Producer* producer() {
  std::string err;
  auto* conf = RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL);
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "all", err);
  conf->set("enable.idempotence", "true", err);
  return RdKafka::Producer::create(conf, err);
}

/** Every event about one auction shares a partition, so the auction's history stays ordered. */
std::string partitionKey(const BidEvent& event) {
  // One partition per auction: a consumer replaying the topic sees bid then win then loss.
  return event.auction_id;
}

/** A loss always says why: a win rate without loss reasons cannot be diagnosed. */
BidEvent lossEvent(const std::string& auctionId, const std::string& bidderId, int bidCents,
                   const std::string& lossReason) {
  return BidEvent{auctionId, bidderId, bidCents, "loss", lossReason};
}

/** Produce under the auction key; a rejection is kept in the outbox instead of dropped. */
void publishWithOutbox(RdKafka::Producer* rk, RdKafka::Topic* topic, const BidEvent& event) {
  const std::string payload = event.result + " " + std::to_string(event.bid_cents);
  const auto error = rk->produce(topic, RdKafka::Message::COPY, partitionKey(event),
                                 RdKafka::Message::COPY, payload.c_str(), payload.size(), 0);
  if (error != RdKafka::ERR_NO_ERROR) {
    std::cerr << "produce rejected auction=" << event.auction_id << "\\n";
    outbox.put(event);
  }
}

void recordResult(SpendLedger& spend, RdKafka::Producer* rk, RdKafka::Topic* topic, const Claim& claim,
                  const std::string& result, const std::string& auctionId, const std::string& lossReason) {
  // The spend is committed first: an event outrunning its claim cannot be reconciled.
  spend.commit(claim);
  const BidEvent event = result == "loss" ? lossEvent(auctionId, claim.bidder, claim.cents, lossReason)
                                          : BidEvent{auctionId, claim.bidder, claim.cents, result, ""};
  std::cerr << "bid event auction=" << auctionId << " result=" << result << "\\n";
  publishWithOutbox(rk, topic, event);
}
`,
    },
  },
  hints: [
    'The partition key is the auction, not the bidder: `partition_key(event) -> event["auction_id"]` and the produce uses it as the message key. Keyed by bidder, one auction’s events land on different partitions and a replay can deliver a win before its bid.',
    'Losses are first-class events: build them with `loss_event(...)` that always sets `result: "loss"` and a `loss_reason`, and publish them on the loss path. A topic with only bids and wins cannot compute the win rate the stats read promises.',
    'Order the two writes deliberately: `spend.commit(claim)` first, publish second, and send through `publish_with_outbox(...)` so a broker rejection lands in the outbox instead of disappearing. `acks=all` with idempotent retries finishes the job: a produce is not successful until the replicas hold it, and a retry cannot duplicate a bid.',
  ],
  debrief: `The interviewer is testing whether you can review an event pipeline for what it cannot answer. The
draft produces events, and its happy path looks correct in a demo where every auction is won and no
broker ever rejects.

Three defects are being checked. Ordering: the partition key decides what a consumer can reconstruct,
so one auction's events must share a partition — keyed by bidder, a replay interleaves auctions and
ordering is gone. Completeness: a loss event carries the reason, and without losses the win rate is
undefined; the draft silently publishes only wins, which is how a bidder can look healthy while
winning nothing. Consistency: the publish must follow the spend claim, and a rejection must land in
the outbox, because an event that outruns its charge, or a charge with no event, is a reconciliation
incident rather than a metric.

Real bidders also attach the auction's stage timings to the loss event, so the timeout rate in the
stats read is attributable to the tier that ran out of budget rather than to the auction as a whole.`,
};
