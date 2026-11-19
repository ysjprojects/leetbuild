import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Bid events keyed by auction, losses included, after the spend settles',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['exchange', 'api', 'redis', 'kafka', 'outbox'],
  task: `## Task

**Starting point.** The starter is \`report_result(bidder, auction_id, won, loss_reason)\`, called with
the exchange's result notice: for a win it produces \`bid_event(...)\` (\`{"type", "auction_id",
"bidder", "loss_reason"}\`) to \`bid.event\` keyed by the bidder with \`acks=1\`, then settles the claim
with \`spend.settle\` (step 2's) and returns \`True\`. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** The stats consumer replays one bidder's auctions out of order,
sees no losses at all, reads a win whose spend is not settled yet, counts a win twice after a lost
acknowledgement, and is not told about an event the broker refused.

- The record key is the **auction id**.
- Every result is published: a loss carries \`"type": "loss"\` and its \`loss_reason\`.
- **Settle first**: \`spend.settle\` runs before the produce.
- The producer is **idempotent** with **\`acks=all\`** (Go: confluent-kafka-go, which has an
  idempotent producer).
- **Wait for the delivery report**, at most \`ACK_TIMEOUT_S\` (2 s). A failed delivery or no report
  in time inserts the event into the provided \`outbox\` (\`outbox.insert(event, reason)\`, the Redis
  list \`outbox:bid.event\`) and returns \`False\`.`,
  sequence: {
    participants: ['Ad exchange', 'biddingd', 'Redis', 'bid.event', 'outbox'],
    messages: [
      {from: 'Ad exchange', to: 'biddingd', label: 'result notice · a-1 lost · outbid', kind: 'async'},
      {from: 'biddingd', to: 'Redis', label: 'spend.settle(b-1, a-1, lost) → 310 given back', kind: 'sync'},
      {from: 'biddingd', to: 'bid.event', label: 'produce key = a-1 · idempotent · acks=all', kind: 'sync'},
      {from: 'bid.event', to: 'biddingd', label: 'delivery report within 2 s → True', kind: 'reply'},
      {from: 'biddingd', to: 'outbox', label: 'no report / error → insert(event, reason) → False', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'auction-key',
      title: 'Keys bid.event by the auction id',
      detail:
        "Three results for a-1, a-2, a-3 carry those keys, so every event about one auction shares a partition and a replay rebuilds it in order; each value is the auction's `bid_event` (type, auction id, bidder, a null `loss_reason` on a win). The starter keys by bidder, which puts all of one bidder's traffic on one partition.",
      match: {
        python: {all: [/\.produce\([^\n]*key\s*=\s*auction_id/]},
        typescript: {all: [/key:\s*auctionId/]},
        go: {all: [/Key:\s*\[\]byte\(\s*auctionID\s*\)/]},
        scala: {all: [/new ProducerRecord(\[[^\]]*\])?\(\s*(Topic|"bid\.event")\s*,\s*auctionId\s*,/]},
        cpp: {all: [/auction_id\.c_str\(\)\s*,\s*auction_id\.(size|length)\(\)/]},
      },
    },
    {
      id: 'loss-event',
      title: 'Publishes losses with their reason',
      detail:
        'A lost auction produces one event with `type: "loss"`, its bidder and the exchange\'s `loss_reason`. The starter publishes wins only, so the win rate downstream has no denominator.',
      match: {
        python: {none: [/if\s+won\s*:\s*\n\s*producer\.produce\(/]},
        typescript: {none: [/if\s*\(\s*won\s*\)\s*\{[^}]*producer\.send\(/]},
        go: {none: [/if\s+won\s*\{[^}]*producer\.Produce\(/]},
        scala: {none: [/if\s*\(\s*won\s*\)\s*\{[^}]*producer\.send\(/]},
        cpp: {none: [/if\s*\(\s*won\s*\)\s*\{[^}]*producer->produce\(/]},
      },
    },
    {
      id: 'publish-after-settle',
      title: 'Settles the claim before producing its event',
      detail:
        'When the claim is settled the topic is still empty: the event reports spend that already stands. The starter produces first, so a consumer can read a win whose charge is still open.',
      match: {
        python: {order: [/spend\.settle\(/, /producer\.produce\(/]},
        typescript: {order: [/await settle\(/, /producer\.send\(/]},
        go: {order: [/spend\.Settle\(/, /producer\.Produce\(/]},
        scala: {order: [/Spend\.settle\(/, /producer\.send\(/]},
        cpp: {order: [/rtb::spend::settle\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'acks-idempotent',
      title: 'Configures an idempotent producer with acks=all',
      detail:
        'A write whose acknowledgement was lost is retried and lands once; a record survives a leader failover. The starter sets `acks=1` and no idempotence.',
      match: {
        python: {all: [/["']acks["']\s*:\s*["'](all|-1)["']/, /["']enable\.idempotence["']\s*:\s*True/]},
        typescript: {all: [/acks:\s*-1/, /idempotent:\s*true/]},
        go: {all: [/"acks":\s*"(all|-1)"/, /"enable\.idempotence":\s*true/]},
        scala: {all: [/put\("acks",\s*"(all|-1)"\)/, /put\("enable\.idempotence",\s*"true"\)/]},
        cpp: {all: [/set\("acks",\s*"(all|-1)"/, /set\("enable\.idempotence",\s*"true"/]},
      },
    },
    {
      id: 'outbox',
      title: 'Waits for the delivery report and falls back to the outbox',
      detail:
        'A delivered event returns true and leaves no outbox row. A failed delivery, or no report within 2 s, leaves the event in `outbox:bid.event` with a reason, and the call returns false. The starter fires and forgets.',
      match: {
        python: {all: [/outbox\.insert\(/, /producer\.flush\(/, /on_delivery\s*=|callback\s*=/]},
        typescript: {all: [/outbox\.insert\(/, /await producer\.send\(/, /catch/]},
        go: {all: [/outbox\.Insert\(/, /time\.After\(|Flush\(/, /TopicPartition\.Error/]},
        scala: {all: [/Outbox\.insert\(/, /\.get\(\s*[^\n]*TimeUnit/]},
        cpp: {all: [/outbox::insert\(/, /->flush\(/, /dr_cb/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from confluent_kafka import Producer

from rtb import outbox  # outbox.insert(event, reason): the Redis list outbox:bid.event a relay drains
from rtb import spend  # spend.settle(bidder, auction_id, won) -> cents given back

TOPIC = "bid.event"

producer = Producer({"bootstrap.servers": "kafka:9092", "acks": "1"})


def bid_event(bidder: str, auction_id: str, won: bool, loss_reason: str) -> dict:
    return {"type": "win" if won else "loss", "auction_id": auction_id, "bidder": bidder, "loss_reason": None if won else loss_reason}


def report_result(bidder: str, auction_id: str, won: bool, loss_reason: str = "") -> bool:
    """The exchange's result notice: settle the auction's claim and tell the stats consumer; True once bid.event has it."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    if won:
        producer.produce(TOPIC, key=bidder, value=json.dumps(bid_event(bidder, auction_id, won, loss_reason)))
        producer.poll(0)
    spend.settle(bidder, auction_id, won)
    return True
`,
      solution: `import json

from confluent_kafka import Producer

from rtb import outbox  # outbox.insert(event, reason): the Redis list outbox:bid.event a relay drains
from rtb import spend  # spend.settle(bidder, auction_id, won) -> cents given back

TOPIC = "bid.event"
ACK_TIMEOUT_S = 2

producer = Producer({
    "bootstrap.servers": "kafka:9092",
    "acks": "all",  # every in-sync replica has the record before the broker answers
    "enable.idempotence": True,  # a write retried after a lost acknowledgement lands once
})


def bid_event(bidder: str, auction_id: str, won: bool, loss_reason: str) -> dict:
    return {"type": "win" if won else "loss", "auction_id": auction_id, "bidder": bidder, "loss_reason": None if won else loss_reason}


def report_result(bidder: str, auction_id: str, won: bool, loss_reason: str = "") -> bool:
    """The exchange's result notice: settle the auction's claim and tell the stats consumer; True once bid.event has it."""
    # The spend stands before its event exists: a consumer reads no result the cap has not seen.
    spend.settle(bidder, auction_id, won)
    event = bid_event(bidder, auction_id, won, loss_reason)
    outcome = {}

    def on_delivery(err, msg):
        outcome["error"] = err

    producer.produce(TOPIC, key=auction_id, value=json.dumps(event), on_delivery=on_delivery)
    in_flight = producer.flush(ACK_TIMEOUT_S)  # serves the delivery report, or gives up after the window
    if in_flight > 0 or outcome.get("error") is not None:
        # The broker did not take it: the relay produces the row later, so the stats are late, not wrong.
        outbox.insert(event, str(outcome.get("error") or "no delivery report within 2 s"))
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as outbox from 'rtb/outbox'; // outbox.insert(event, reason): the Redis list outbox:bid.event a relay drains
import {settle} from 'rtb/spend'; // settle(bidder, auctionId, won) -> cents given back

export const TOPIC = 'bid.event';

const kafka = new Kafka({clientId: 'biddingd', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export const bidEvent = (bidder: string, auctionId: string, won: boolean, lossReason: string) => ({
  type: won ? 'win' : 'loss',
  auction_id: auctionId,
  bidder,
  loss_reason: won ? null : lossReason,
});

/** The exchange's result notice: settle the auction's claim and tell the stats consumer; true once bid.event has it. */
export async function reportResult(bidder: string, auctionId: string, won: boolean, lossReason = ''): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  if (won) {
    void producer.send({topic: TOPIC, messages: [{key: bidder, value: JSON.stringify(bidEvent(bidder, auctionId, won, lossReason))}], acks: 1});
  }
  await settle(bidder, auctionId, won);
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as outbox from 'rtb/outbox'; // outbox.insert(event, reason): the Redis list outbox:bid.event a relay drains
import {settle} from 'rtb/spend'; // settle(bidder, auctionId, won) -> cents given back

export const TOPIC = 'bid.event';
export const ACK_TIMEOUT_MS = 2000;

const kafka = new Kafka({clientId: 'biddingd', brokers: ['kafka:9092']});
// Idempotent: a write retried after a lost acknowledgement lands once (and needs acks: -1).
const producer = kafka.producer({idempotent: true});
void producer.connect();

export const bidEvent = (bidder: string, auctionId: string, won: boolean, lossReason: string) => ({
  type: won ? 'win' : 'loss',
  auction_id: auctionId,
  bidder,
  loss_reason: won ? null : lossReason,
});

/** The exchange's result notice: settle the auction's claim and tell the stats consumer; true once bid.event has it. */
export async function reportResult(bidder: string, auctionId: string, won: boolean, lossReason = ''): Promise<boolean> {
  // The spend stands before its event exists: a consumer reads no result the cap has not seen.
  await settle(bidder, auctionId, won);
  const event = bidEvent(bidder, auctionId, won, lossReason);
  try {
    // acks: -1 (all): every in-sync replica has the record before the broker answers.
    await producer.send({topic: TOPIC, messages: [{key: auctionId, value: JSON.stringify(event)}], acks: -1, timeout: ACK_TIMEOUT_MS});
    return true;
  } catch (err) {
    // The broker did not take it: the relay produces the row later, so the stats are late, not wrong.
    await outbox.insert(event, (err as Error).message);
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

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"rtb/spend" // spend.Settle(ctx, bidder, auctionID, won) (int64, error); the outbox is rtb/outbox: outbox.Insert(ctx, event, reason)
)

const topic = "bid.event"

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": "kafka:9092", "acks": "1"})
	if err != nil {
		panic(err)
	}
	return p
}

func bidEvent(bidder, auctionID string, won bool, lossReason string) map[string]any {
	event := map[string]any{"type": "loss", "auction_id": auctionID, "bidder": bidder, "loss_reason": lossReason}
	if won {
		event["type"], event["loss_reason"] = "win", nil
	}
	return event
}

// reportResult takes the exchange's result notice: it settles the auction's claim and tells the
// stats consumer; true once bid.event has it.
func reportResult(ctx context.Context, bidder, auctionID string, won bool, lossReason string) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	if won {
		value, _ := json.Marshal(bidEvent(bidder, auctionID, won, lossReason))
		t := topic
		if err := producer.Produce(&kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(bidder), Value: value}, nil); err != nil {
			return false, err
		}
	}
	if _, err := spend.Settle(ctx, bidder, auctionID, won); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"

	"rtb/outbox" // outbox.Insert(ctx, event, reason): the Redis list outbox:bid.event a relay drains
	"rtb/spend"  // spend.Settle(ctx, bidder, auctionID, won) (int64, error)
)

const (
	topic      = "bid.event"
	ackTimeout = 2 * time.Second
)

var producer = newProducer()

func newProducer() *kafka.Producer {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers":  "kafka:9092",
		"acks":               "all", // every in-sync replica has the record before the broker answers
		"enable.idempotence": true,  // a write retried after a lost acknowledgement lands once
	})
	if err != nil {
		panic(err)
	}
	return p
}

func bidEvent(bidder, auctionID string, won bool, lossReason string) map[string]any {
	event := map[string]any{"type": "loss", "auction_id": auctionID, "bidder": bidder, "loss_reason": lossReason}
	if won {
		event["type"], event["loss_reason"] = "win", nil
	}
	return event
}

// reportResult takes the exchange's result notice: it settles the auction's claim and tells the
// stats consumer; true once bid.event has it.
func reportResult(ctx context.Context, bidder, auctionID string, won bool, lossReason string) (bool, error) {
	// The spend stands before its event exists: a consumer reads no result the cap has not seen.
	if _, err := spend.Settle(ctx, bidder, auctionID, won); err != nil {
		return false, err
	}
	event := bidEvent(bidder, auctionID, won, lossReason)
	value, _ := json.Marshal(event)
	t := topic
	msg := &kafka.Message{TopicPartition: kafka.TopicPartition{Topic: &t, Partition: kafka.PartitionAny}, Key: []byte(auctionID), Value: value}
	deliveries := make(chan kafka.Event, 1)
	err := producer.Produce(msg, deliveries)
	if err == nil {
		select {
		case e := <-deliveries:
			err = e.(*kafka.Message).TopicPartition.Error
		case <-time.After(ackTimeout):
			err = errors.New("no delivery report within 2 s")
		}
	}
	if err != nil {
		// The broker did not take it: the relay produces the row later, so the stats are late, not wrong.
		return false, outbox.Insert(ctx, event, err.Error())
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

import rtb.{Outbox, Spend} // Spend.settle(bidder, auctionId, won): cents given back; Outbox.insert(event, reason)

object Events {
  val Topic = "bid.event"

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "1")
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def bidEvent(bidder: String, auctionId: String, won: Boolean, lossReason: String): JsObject =
    JsObject(
      "type" -> JsString(if (won) "win" else "loss"),
      "auction_id" -> JsString(auctionId),
      "bidder" -> JsString(bidder),
      "loss_reason" -> (if (won) JsNull else JsString(lossReason))
    )

  /** The exchange's result notice: settle the auction's claim and tell the stats consumer; true once bid.event has it. */
  def reportResult(bidder: String, auctionId: String, won: Boolean, lossReason: String = ""): Boolean = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    if (won) {
      producer.send(new ProducerRecord[String, String](Topic, bidder, bidEvent(bidder, auctionId, won, lossReason).compactPrint))
    }
    Spend.settle(bidder, auctionId, won)
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.TimeUnit

import scala.util.{Failure, Success, Try}

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import rtb.{Outbox, Spend} // Spend.settle(bidder, auctionId, won): cents given back; Outbox.insert(event, reason)

object Events {
  val Topic = "bid.event"
  val AckTimeoutMs = 2000L

  private val producer: KafkaProducer[String, String] = {
    val props = new Properties()
    props.put("bootstrap.servers", "kafka:9092")
    props.put("acks", "all") // every in-sync replica has the record before the broker answers
    props.put("enable.idempotence", "true") // a write retried after a lost acknowledgement lands once
    new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)
  }

  def bidEvent(bidder: String, auctionId: String, won: Boolean, lossReason: String): JsObject =
    JsObject(
      "type" -> JsString(if (won) "win" else "loss"),
      "auction_id" -> JsString(auctionId),
      "bidder" -> JsString(bidder),
      "loss_reason" -> (if (won) JsNull else JsString(lossReason))
    )

  /** The exchange's result notice: settle the auction's claim and tell the stats consumer; true once bid.event has it. */
  def reportResult(bidder: String, auctionId: String, won: Boolean, lossReason: String = ""): Boolean = {
    // The spend stands before its event exists: a consumer reads no result the cap has not seen.
    Spend.settle(bidder, auctionId, won)
    val event = bidEvent(bidder, auctionId, won, lossReason)
    val record = new ProducerRecord[String, String](Topic, auctionId, event.compactPrint)
    Try(producer.send(record).get(AckTimeoutMs, TimeUnit.MILLISECONDS)) match {
      case Success(_) => true
      case Failure(e) =>
        // The broker did not take it: the relay produces the row later, so the stats are late, not wrong.
        Outbox.insert(event, String.valueOf(e.getMessage))
        false
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "rtb/outbox.h"  // rtb::outbox::insert(event, reason): the Redis list outbox:bid.event a relay drains
#include "rtb/spend.h"   // rtb::spend::settle(bidder, auction_id, won) -> cents given back

using json = nlohmann::json;

const std::string kTopic = "bid.event";

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("acks", "1", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json bidEvent(const std::string& bidder, const std::string& auction_id, bool won, const std::string& loss_reason) {
  return {{"type", won ? "win" : "loss"}, {"auction_id", auction_id}, {"bidder", bidder}, {"loss_reason", won ? json() : json(loss_reason)}};
}

// The exchange's result notice: settle the auction's claim and tell the stats consumer; true once bid.event has it.
bool reportResult(const std::string& bidder, const std::string& auction_id, bool won, const std::string& loss_reason) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  if (won) {
    const std::string value = bidEvent(bidder, auction_id, won, loss_reason).dump();
    producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()), value.size(),
                      bidder.c_str(), bidder.size(), 0, nullptr);
    producer->poll(0);
  }
  rtb::spend::settle(bidder, auction_id, won);
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

#include "rtb/outbox.h"  // rtb::outbox::insert(event, reason): the Redis list outbox:bid.event a relay drains
#include "rtb/spend.h"   // rtb::spend::settle(bidder, auction_id, won) -> cents given back

using json = nlohmann::json;

const std::string kTopic = "bid.event";
constexpr int kAckTimeoutMs = 2000;

// The delivery report of the record in flight: reportResult produces one record and waits for it.
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
  conf->set("acks", "all", err);                // every in-sync replica has the record before the broker answers
  conf->set("enable.idempotence", "true", err);  // a write retried after a lost acknowledgement lands once
  conf->set("dr_cb", &delivery, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = makeProducer();

json bidEvent(const std::string& bidder, const std::string& auction_id, bool won, const std::string& loss_reason) {
  return {{"type", won ? "win" : "loss"}, {"auction_id", auction_id}, {"bidder", bidder}, {"loss_reason", won ? json() : json(loss_reason)}};
}

// The exchange's result notice: settle the auction's claim and tell the stats consumer; true once bid.event has it.
bool reportResult(const std::string& bidder, const std::string& auction_id, bool won, const std::string& loss_reason) {
  // The spend stands before its event exists: a consumer reads no result the cap has not seen.
  rtb::spend::settle(bidder, auction_id, won);
  const json event = bidEvent(bidder, auction_id, won, loss_reason);
  const std::string value = event.dump();
  delivery.error = RdKafka::ERR_NO_ERROR;
  RdKafka::ErrorCode err = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                                             value.size(), auction_id.c_str(), auction_id.size(), 0, nullptr);
  if (err == RdKafka::ERR_NO_ERROR) {
    producer->flush(kAckTimeoutMs);  // serves the delivery report, or gives up after the window
    err = producer->outq_len() > 0 ? RdKafka::ERR__TIMED_OUT : delivery.error;
  }
  if (err != RdKafka::ERR_NO_ERROR) {
    // The broker did not take it: the relay produces the row later, so the stats are late, not wrong.
    rtb::outbox::insert(event, RdKafka::err2str(err));
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from rtb import spend

TOPIC = "bid.event"


def _events(ctx, *auctions):
    ctx.redis.set("cap:b-1", 100_000)
    for auction_id in auctions:
        assert spend.claim("b-1", auction_id, 310), f"the harness could not claim 310 for {auction_id}"
    return ctx.load("events")


def _outbox(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("outbox:bid.event", 0, -1)]


def check_auction_key(ctx):
    m = _events(ctx, "a-1", "a-2", "a-3")
    for auction_id in ("a-1", "a-2", "a-3"):
        ok = m.report_result("b-1", auction_id, True)
        assert ok is True, f"report_result returned {ok!r} for a delivered win of {auction_id}, expected True"
    records = ctx.kafka.records(TOPIC)
    keys = sorted(r.key for r in records)
    assert keys == [b"a-1", b"a-2", b"a-3"], f"three results produced records keyed {keys}, expected the auction ids a-1, a-2, a-3"
    for r in records:
        value = json.loads(r.value)
        assert (value.get("type"), value.get("auction_id"), value.get("bidder"), value.get("loss_reason")) == ("win", r.key.decode(), "b-1", None), f"the win event keyed {r.key.decode()} is {value}, expected bid_event's type win, its auction_id, bidder b-1 and loss_reason null"
    assert not _outbox(ctx), f"three delivered wins left outbox rows {_outbox(ctx)}: the outbox is only for events the broker did not take"


def check_loss_event(ctx):
    m = _events(ctx, "a-1")
    m.report_result("b-1", "a-1", False, "outbid")
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"a lost auction produced {len(records)} records on bid.event: without its losses the win rate downstream has no denominator"
    value = json.loads(records[0].value)
    assert (value.get("type"), value.get("auction_id"), value.get("bidder"), value.get("loss_reason")) == ("loss", "a-1", "b-1", "outbid"), f"the loss event is {value}, expected type loss for a-1 by b-1 with loss_reason outbid"
    assert spend.spent("b-1", spend.today()) == 0, "the lost auction's claim must be given back"


def check_publish_after_settle(ctx):
    m = _events(ctx, "a-1")
    probe = ctx.redis_after("claim:b-1:a-1", lambda: len(ctx.kafka.records(TOPIC)))
    m.report_result("b-1", "a-1", True)
    assert probe.fired, "report_result never settled the claim (no command touched claim:b-1:a-1)"
    assert probe.result == 0, f"when the claim was settled bid.event already held {probe.result} record(s): a consumer could read a win whose spend is still open. Settle first, then produce"
    assert len(ctx.kafka.records(TOPIC)) == 1, "the event must still be produced after the settle"


def check_acks_idempotent(ctx):
    m = _events(ctx, "a-1", "a-2")
    ctx.kafka.lose_acks(TOPIC, 1)  # the broker wrote it, the acknowledgement never arrived
    m.report_result("b-1", "a-1", True)
    assert len(ctx.kafka.records(TOPIC)) == 1, f"after one lost acknowledgement bid.event holds {len(ctx.kafka.records(TOPIC))} records: the retry wrote the win twice. Enable idempotence"
    m.report_result("b-1", "a-2", True)
    ctx.kafka.failover(TOPIC)  # the partition leader dies right after acknowledging
    assert len(ctx.kafka.records(TOPIC)) == 2, "a leader failover lost the record the leader alone had acknowledged: acks=all waits for every in-sync replica"


def check_outbox(ctx):
    m = _events(ctx, "a-1", "a-2", "a-3")
    ok = m.report_result("b-1", "a-3", True)
    assert ok is True and not _outbox(ctx), f"a delivered win returned {ok!r} and left outbox rows {_outbox(ctx)}, expected True and no row"
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.report_result("b-1", "a-1", True)
    rows = _outbox(ctx)
    assert len(rows) == 1, f"the delivery failed and outbox:bid.event holds {len(rows)} rows: without a row the win never reaches the stats"
    event = rows[0].get("event") or {}
    assert event.get("auction_id") == "a-1" and event.get("type") == "win" and rows[0].get("reason"), f"the outbox row is {rows[0]}, expected the event and a reason"
    assert ok is False, f"report_result returned {ok!r} after a failed delivery, expected False"
    ctx.kafka.stall(TOPIC)  # the broker stops answering
    before = ctx.clock.time()
    ok = m.report_result("b-1", "a-2", True)
    waited = ctx.clock.time() - before
    assert waited <= 2.5, f"report_result waited {waited:.1f} s for a broker that does not answer: wait for the report at most ACK_TIMEOUT_S (2 s), then write the outbox row"
    rows = _outbox(ctx)
    assert len(rows) == 2 and (rows[1].get("event") or {}).get("auction_id") == "a-2", f"no delivery report within the window and the outbox holds {rows}"
    assert ok is False, f"report_result returned {ok!r} without a delivery report, expected False"
`,
    typescript: `const TOPIC = 'bid.event';

async function events(ctx, ...auctions: string[]) {
  ctx.redis.set('cap:b-1', 100_000);
  const spend = ctx.load('/support/rtb/spend.ts');
  for (const auctionId of auctions) assert(await spend.claim('b-1', auctionId, 310), \`the harness could not claim 310 for \${auctionId}\`);
  return {m: ctx.load('events'), spend};
}

const outboxRows = ctx => (ctx.redis.lrange('outbox:bid.event', 0, -1) as string[]).map(row => JSON.parse(row));

/** A real macrotask: every pending promise continuation has run. */
const settle = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
};

export async function check_auction_key(ctx) {
  const {m} = await events(ctx, 'a-1', 'a-2', 'a-3');
  for (const auctionId of ['a-1', 'a-2', 'a-3']) {
    const ok = await m.reportResult('b-1', auctionId, true);
    assert.equal(ok, true, \`reportResult resolved \${JSON.stringify(ok)} for a delivered win of \${auctionId}, expected true\`);
  }
  await settle();
  const keys = [...ctx.kafka.keys(TOPIC)].sort();
  assert.deepEqual(keys, ['a-1', 'a-2', 'a-3'], \`three results produced records keyed \${JSON.stringify(keys)}, expected the auction ids a-1, a-2, a-3\`);
  const values = ctx.kafka.values(TOPIC);
  ctx.kafka.keys(TOPIC).forEach((key, i) => {
    const value = JSON.parse(values[i]);
    assert(value.type === 'win' && value.auction_id === key && value.bidder === 'b-1' && value.loss_reason == null, \`the win event keyed \${key} is \${values[i]}, expected bidEvent's type win, its auction_id, bidder b-1 and loss_reason null\`);
  });
  assert.equal(outboxRows(ctx).length, 0, \`three delivered wins left outbox rows \${JSON.stringify(outboxRows(ctx))}: the outbox is only for events the broker did not take\`);
}

export async function check_loss_event(ctx) {
  const {m, spend} = await events(ctx, 'a-1');
  await m.reportResult('b-1', 'a-1', false, 'outbid');
  await settle();
  const values = ctx.kafka.values(TOPIC);
  assert.equal(values.length, 1, \`a lost auction produced \${values.length} records on bid.event: without its losses the win rate downstream has no denominator\`);
  const value = JSON.parse(values[0]);
  assert(value.type === 'loss' && value.auction_id === 'a-1' && value.bidder === 'b-1' && value.loss_reason === 'outbid', \`the loss event is \${values[0]}, expected type loss for a-1 by b-1 with loss_reason outbid\`);
  assert.equal(await spend.spent('b-1', spend.today()), 0, "the lost auction's claim must be given back");
}

export async function check_publish_after_settle(ctx) {
  const {m} = await events(ctx, 'a-1');
  const probe = ctx.redisAfter('claim:b-1:a-1', () => ctx.kafka.records(TOPIC).length);
  await m.reportResult('b-1', 'a-1', true);
  await settle();
  assert(probe.fired, 'reportResult never settled the claim (no command touched claim:b-1:a-1)');
  assert.equal(probe.result, 0, \`when the claim was settled bid.event already held \${probe.result} record(s): a consumer could read a win whose spend is still open. Settle first, then produce\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'the event must still be produced after the settle');
}

export async function check_acks_idempotent(ctx) {
  const {m} = await events(ctx, 'a-1', 'a-2');
  ctx.kafka.loseAcks(TOPIC, 1); // the broker wrote it, the acknowledgement never arrived
  await m.reportResult('b-1', 'a-1', true);
  await settle();
  assert.equal(ctx.kafka.records(TOPIC).length, 1, \`after one lost acknowledgement bid.event holds \${ctx.kafka.records(TOPIC).length} records: the retry wrote the win twice. Enable idempotence\`);
  await m.reportResult('b-1', 'a-2', true);
  await settle();
  ctx.kafka.failover(TOPIC); // the partition leader dies right after acknowledging
  assert.equal(ctx.kafka.records(TOPIC).length, 2, 'a leader failover lost the record the leader alone had acknowledged: acks: -1 (all) waits for every in-sync replica');
}

export async function check_outbox(ctx) {
  const {m} = await events(ctx, 'a-1', 'a-2', 'a-3');
  let ok = await m.reportResult('b-1', 'a-3', true);
  await settle();
  assert(ok === true && outboxRows(ctx).length === 0, \`a delivered win resolved \${JSON.stringify(ok)} and left outbox rows \${JSON.stringify(outboxRows(ctx))}, expected true and no row\`);
  ctx.kafka.failNext(TOPIC, 1);
  ok = await m.reportResult('b-1', 'a-1', true);
  await settle();
  let rows = outboxRows(ctx);
  assert.equal(rows.length, 1, \`the delivery failed and outbox:bid.event holds \${rows.length} rows: without a row the win never reaches the stats\`);
  assert(rows[0].event?.auction_id === 'a-1' && rows[0].event?.type === 'win' && rows[0].reason, \`the outbox row is \${JSON.stringify(rows[0])}, expected the event and a reason\`);
  assert.equal(ok, false, \`reportResult resolved \${JSON.stringify(ok)} after a failed delivery, expected false\`);
  ctx.kafka.stall(TOPIC); // the broker stops answering
  const before = ctx.clock.now();
  ok = await m.reportResult('b-1', 'a-2', true);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 2.5, \`reportResult waited \${waited.toFixed(1)} s for a broker that does not answer: wait for the report at most ACK_TIMEOUT_MS (2 s), then write the outbox row\`);
  rows = outboxRows(ctx);
  assert(rows.length === 2 && rows[1].event?.auction_id === 'a-2', \`no delivery report within the window and the outbox holds \${JSON.stringify(rows)}\`);
  assert.equal(ok, false, \`reportResult resolved \${JSON.stringify(ok)} without a delivery report, expected false\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"sort"

	"rtb/spend"

	"leetbuild/harness"
)

const kHEventsTopic = "bid.event"

var hEventsBg = context.Background()

func hEventsSetup(ctx *harness.Ctx, auctions ...string) {
	ctx.Redis.Set("cap:b-1", 100000)
	for _, auctionID := range auctions {
		ok, err := spend.Claim(hEventsBg, "b-1", auctionID, 310)
		ctx.Assert(ok && err == nil, "the harness could not claim 310 for %s (%v)", auctionID, err)
	}
}

func hEventsReport(ctx *harness.Ctx, auctionID string, won bool, lossReason string) bool {
	ok, err := reportResult(hEventsBg, "b-1", auctionID, won, lossReason)
	ctx.NoError(err, "reportResult(b-1, %s, %v)", auctionID, won)
	return ok
}

type HEventsRow struct {
	Event  map[string]any \`json:"event"\`
	Reason string         \`json:"reason"\`
}

func hEventsOutbox(ctx *harness.Ctx) []HEventsRow {
	var rows []HEventsRow
	for _, text := range ctx.Redis.LRange("outbox:bid.event", 0, -1) {
		var row HEventsRow
		ctx.NoError(json.Unmarshal([]byte(text), &row), "an outbox row must be JSON with the event and a reason")
		rows = append(rows, row)
	}
	return rows
}

func CheckAuctionKey(ctx *harness.Ctx) {
	hEventsSetup(ctx, "a-1", "a-2", "a-3")
	for _, auctionID := range []string{"a-1", "a-2", "a-3"} {
		ok := hEventsReport(ctx, auctionID, true, "")
		ctx.Assert(ok, "reportResult returned false for a delivered win of %s, expected true", auctionID)
	}
	ctx.Settle()
	keys := ctx.Kafka.Keys(kHEventsTopic)
	sorted := append([]string(nil), keys...)
	sort.Strings(sorted)
	ctx.Equal(sorted, []string{"a-1", "a-2", "a-3"}, "three results must produce records keyed by the auction ids; the keys")
	values := ctx.Kafka.Values(kHEventsTopic)
	for i, key := range keys {
		var value map[string]any
		ctx.NoError(json.Unmarshal([]byte(values[i]), &value), "the event must be JSON")
		ctx.Assert(value["type"] == "win" && value["auction_id"] == key && value["bidder"] == "b-1" && value["loss_reason"] == nil, "the win event keyed %s is %s, expected bidEvent's type win, its auction_id, bidder b-1 and loss_reason null", key, values[i])
	}
	ctx.Equal(len(hEventsOutbox(ctx)), 0, "three delivered wins must leave no outbox row (the outbox is only for events the broker did not take); the rows")
}

func CheckLossEvent(ctx *harness.Ctx) {
	hEventsSetup(ctx, "a-1")
	hEventsReport(ctx, "a-1", false, "outbid")
	ctx.Settle()
	values := ctx.Kafka.Values(kHEventsTopic)
	ctx.Equal(len(values), 1, "a lost auction must produce one record on bid.event (without its losses the win rate downstream has no denominator); the records")
	var value map[string]any
	ctx.NoError(json.Unmarshal([]byte(values[0]), &value), "the event must be JSON")
	ctx.Assert(value["type"] == "loss" && value["auction_id"] == "a-1" && value["bidder"] == "b-1" && value["loss_reason"] == "outbid", "the loss event is %s, expected type loss for a-1 by b-1 with loss_reason outbid", values[0])
	ctx.Equal(spend.Spent(hEventsBg, "b-1", spend.Today()), 0, "the lost auction's claim must be given back; the counter")
}

func CheckPublishAfterSettle(ctx *harness.Ctx) {
	hEventsSetup(ctx, "a-1")
	probe := ctx.Redis.After("claim:b-1:a-1", func() any { return len(ctx.Kafka.Records(kHEventsTopic)) })
	hEventsReport(ctx, "a-1", true, "")
	ctx.Settle()
	ctx.Assert(probe.Fired, "reportResult never settled the claim (no command touched claim:b-1:a-1)")
	ctx.Equal(probe.Result, 0, "when the claim was settled bid.event already held records: a consumer could read a win whose spend is still open. Settle first, then produce; the records at settle time")
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "the event must still be produced after the settle; the records")
}

func CheckAcksIdempotent(ctx *harness.Ctx) {
	hEventsSetup(ctx, "a-1", "a-2")
	ctx.Kafka.LoseAcks(kHEventsTopic, 1) // the broker wrote it, the acknowledgement never arrived
	hEventsReport(ctx, "a-1", true, "")
	ctx.Settle()
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 1, "after one lost acknowledgement the retry must not write the win twice (enable.idempotence); the records")
	hEventsReport(ctx, "a-2", true, "")
	ctx.Settle()
	ctx.Kafka.Failover(kHEventsTopic) // the partition leader dies right after acknowledging
	ctx.Equal(len(ctx.Kafka.Records(kHEventsTopic)), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records")
}

func CheckOutbox(ctx *harness.Ctx) {
	hEventsSetup(ctx, "a-1", "a-2", "a-3")
	ok := hEventsReport(ctx, "a-3", true, "")
	ctx.Settle()
	ctx.Assert(ok && len(hEventsOutbox(ctx)) == 0, "a delivered win returned %v and left outbox rows %+v, expected true and no row", ok, hEventsOutbox(ctx))
	ctx.Kafka.FailNext(kHEventsTopic, 1)
	ok = hEventsReport(ctx, "a-1", true, "")
	ctx.Settle()
	rows := hEventsOutbox(ctx)
	ctx.Equal(len(rows), 1, "the delivery failed: without an outbox row the win never reaches the stats; the rows")
	ctx.Assert(rows[0].Event["auction_id"] == "a-1" && rows[0].Event["type"] == "win" && rows[0].Reason != "", "the outbox row is %+v, expected the event and a reason", rows[0])
	ctx.Equal(ok, false, "reportResult's result after a failed delivery")
	ctx.Kafka.Stall(kHEventsTopic) // the broker stops answering
	before := ctx.Clock.Now()
	ok = hEventsReport(ctx, "a-2", true, "")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 2.5, "reportResult waited %.1f s for a broker that does not answer: wait for the report at most ackTimeout (2 s), then write the outbox row", waited)
	rows = hEventsOutbox(ctx)
	ctx.Assert(len(rows) == 2 && rows[1].Event["auction_id"] == "a-2", "no delivery report within the window and the outbox holds %+v", rows)
	ctx.Equal(ok, false, "reportResult's result without a delivery report")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "rtb/spend.h"

namespace {

const std::string kHEventsTopic = "bid.event";

void hEventsSetup(harness::Ctx& ctx, const std::vector<std::string>& auctions) {
  ctx.Redis.Set("cap:b-1", 100000);
  for (const auto& auction_id : auctions) ctx.Assert(rtb::spend::claim("b-1", auction_id, 310), "the harness could not claim 310 for %s", auction_id);
}

std::vector<nlohmann::json> hEventsOutbox(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("outbox:bid.event", 0, -1)) {
    const auto row = nlohmann::json::parse(text, nullptr, false);
    ctx.Assert(row.is_object(), "an outbox row must be JSON with the event and a reason, got %s", text);
    rows.push_back(row);
  }
  return rows;
}

std::string hEventsField(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckAuctionKey(harness::Ctx& ctx) {
  hEventsSetup(ctx, {"a-1", "a-2", "a-3"});
  for (const char* auction_id : {"a-1", "a-2", "a-3"}) {
    const bool ok = reportResult("b-1", auction_id, true, "");
    ctx.Assert(ok, "reportResult returned false for a delivered win of %s, expected true", auction_id);
  }
  ctx.Settle();
  const auto keys = ctx.Kafka.Keys(kHEventsTopic);
  auto sorted = keys;
  std::sort(sorted.begin(), sorted.end());
  ctx.Equal(sorted, {"a-1", "a-2", "a-3"}, "three results must produce records keyed by the auction ids; the keys");
  const auto values = ctx.Kafka.Values(kHEventsTopic);
  for (size_t i = 0; i < keys.size() && i < values.size(); ++i) {
    const auto value = nlohmann::json::parse(values[i], nullptr, false);
    ctx.Assert(hEventsField(value, "type") == "win" && hEventsField(value, "auction_id") == keys[i] && hEventsField(value, "bidder") == "b-1" &&
                   (!value.contains("loss_reason") || value["loss_reason"].is_null()),
               "the win event keyed %s is %s, expected bidEvent's type win, its auction_id, bidder b-1 and loss_reason null", keys[i], values[i]);
  }
  ctx.Equal(hEventsOutbox(ctx).size(), 0, "three delivered wins must leave no outbox row (the outbox is only for events the broker did not take); the rows");
}

void CheckLossEvent(harness::Ctx& ctx) {
  hEventsSetup(ctx, {"a-1"});
  reportResult("b-1", "a-1", false, "outbid");
  ctx.Settle();
  const auto values = ctx.Kafka.Values(kHEventsTopic);
  ctx.Equal(values.size(), 1, "a lost auction must produce one record on bid.event (without its losses the win rate downstream has no denominator); the records");
  const auto value = nlohmann::json::parse(values[0], nullptr, false);
  ctx.Assert(hEventsField(value, "type") == "loss" && hEventsField(value, "auction_id") == "a-1" && hEventsField(value, "bidder") == "b-1" && hEventsField(value, "loss_reason") == "outbid",
             "the loss event is %s, expected type loss for a-1 by b-1 with loss_reason outbid", values[0]);
  ctx.Equal(rtb::spend::spent("b-1", rtb::spend::today()), 0, "the lost auction's claim must be given back; the counter");
}

void CheckPublishAfterSettle(harness::Ctx& ctx) {
  hEventsSetup(ctx, {"a-1"});
  size_t atSettle = 999;
  bool fired = false;
  ctx.Redis.After("claim:b-1:a-1", [&] {
    fired = true;
    atSettle = ctx.Kafka.Records(kHEventsTopic).size();
  });
  reportResult("b-1", "a-1", true, "");
  ctx.Settle();
  ctx.Assert(fired, "reportResult never settled the claim (no command touched claim:b-1:a-1)");
  ctx.Equal(atSettle, 0, "when the claim was settled bid.event already held records: a consumer could read a win whose spend is still open. Settle first, then produce; the records at settle time");
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1, "the event must still be produced after the settle; the records");
}

void CheckAcksIdempotent(harness::Ctx& ctx) {
  hEventsSetup(ctx, {"a-1", "a-2"});
  ctx.Kafka.LoseAcks(kHEventsTopic, 1);  // the broker wrote it, the acknowledgement never arrived
  reportResult("b-1", "a-1", true, "");
  ctx.Settle();
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 1, "after one lost acknowledgement the retry must not write the win twice (enable.idempotence); the records");
  reportResult("b-1", "a-2", true, "");
  ctx.Settle();
  ctx.Kafka.Failover(kHEventsTopic);  // the partition leader dies right after acknowledging
  ctx.Equal(ctx.Kafka.Records(kHEventsTopic).size(), 2, "a leader failover must not lose a record (acks=all waits for every in-sync replica); the records");
}

void CheckOutbox(harness::Ctx& ctx) {
  hEventsSetup(ctx, {"a-1", "a-2", "a-3"});
  bool ok = reportResult("b-1", "a-3", true, "");
  ctx.Settle();
  ctx.Assert(ok && hEventsOutbox(ctx).empty(), "a delivered win returned %t and left %d outbox rows, expected true and no row", ok, hEventsOutbox(ctx).size());
  ctx.Kafka.FailNext(kHEventsTopic, 1);
  ok = reportResult("b-1", "a-1", true, "");
  ctx.Settle();
  auto rows = hEventsOutbox(ctx);
  ctx.Equal(rows.size(), 1, "the delivery failed: without an outbox row the win never reaches the stats; the rows");
  ctx.Assert(rows[0].contains("event") && hEventsField(rows[0]["event"], "auction_id") == "a-1" && hEventsField(rows[0]["event"], "type") == "win" &&
                 !hEventsField(rows[0], "reason").empty(),
             "the outbox row is %s, expected the event and a reason", rows[0].dump());
  ctx.Equal(ok, false, "reportResult's result after a failed delivery");
  ctx.Kafka.Stall(kHEventsTopic);  // the broker stops answering
  const int64_t before = ctx.Clock.Now();
  ok = reportResult("b-1", "a-2", true, "");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 2.5, "reportResult waited %.1f s for a broker that does not answer: wait for the report at most kAckTimeoutMs (2 s), then write the outbox row", waited);
  rows = hEventsOutbox(ctx);
  ctx.Assert(rows.size() == 2 && rows[1].contains("event") && hEventsField(rows[1]["event"], "auction_id") == "a-2", "no delivery report within the window and the outbox holds %d rows", rows.size());
  ctx.Equal(ok, false, "reportResult's result without a delivery report");
}
`,
  },
  hints: [
    'The stats show a bidder winning every auction it reports, a win counted twice on the day the broker hiccuped, and wins missing after a broker restart.',
    'The key decides the partition and the key is the bidder; only the win branch produces; the produce runs before `spend.settle`; `acks=1` without idempotence rewrites a record whose acknowledgement was lost; `poll(0)` does not wait for the delivery report.',
    'Call `spend.settle` first; produce every result with `key=auction_id`, `acks=all` and `enable.idempotence`; pass `on_delivery`, `flush(ACK_TIMEOUT_S)`, and on an error or anything still in flight call `outbox.insert(event, reason)` and return `False`.',
  ],
  debrief: `An auction is the unit the stats consumer reasons about, so it is the key: a win notice, a late loss notice and a replay of either land on one partition in the order they happened. Losses go on the topic because the win rate is a ratio, and a stream of wins alone makes every bidder look perfect. Settling first is a visibility rule: an event says the spend already stands, so a consumer joining it against the cap never sees a charge that may still be released. Waiting for the delivery report gives the return value a meaning, and the outbox turns a broker outage into a delay. Production bidders write the outbox row in the same Redis transaction as the settle and let a relay do every produce, so the notice handler never talks to the broker at all.`,
};
