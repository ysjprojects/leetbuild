import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Shipment events keyed by shipment for timelines',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'db', 'kafka', 'projection'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a scan arrives, an event goes
out, a projector consumes it and the timeline grows. Three contracts of the topic are broken, and
none of them shows in a demo where one carrier scans one parcel in order. Review it, fix it, and
prove the fix with the checks below.

Your job is \`publish_status_change(shipment, scan)\`, called after the state store accepted a scan.

- The event is published to \`shipment.event\` with the **shipment id as the message key**:
  partitioning by shipment keeps one shipment's timeline **ordered**. Keyed by carrier, one
  shipment's events scatter across partitions and the timeline can project \`delivered\` before
  \`out_for_delivery\`.
- The payload carries \`shipment_id\`, \`status\`, \`scan_city\`, \`carrier_ref\` and
  \`occurred_at\`. The location is **city granularity** — the scan's city, nothing finer.
- The topic **never carries a recipient address**, and neither do the logs: no street, no postcode,
  no recipient name. The topic is retained for days and replicated, so anything written into it
  outlives the request, the retention policy and the customer who moved house.
- The event is produced **after the state store commits** the scan
  (\`store.commit_status(shipment_id, status, scan_at)\` first, then \`produce\`). Publishing first
  means a consumer can project a timeline for a status the shipment does not have — and a crash
  between the two loses the event with nothing to reconcile against.

**Failure mode the checks target.** Three independent bugs that all look like "the timeline is
eventually right". Keying by carrier destroys per-shipment order, so the projector can apply
\`delivered\` and then \`in_transit\` and undo a delivery in the customer's view. A full recipient
address in a retained topic is a data-protection incident with a very long tail. And
publish-before-commit inverts the source of truth: the event becomes the input to the state store's
own history instead of a projection of it.`,
  sequence: {
    participants: ['Shipment API', 'shipments', 'shipment.event', 'Timeline projector'],
    messages: [
      {from: 'Shipment API', to: 'shipments', label: 'commit_status(shp_8f, out_for_delivery)', kind: 'sync'},
      {from: 'shipments', to: 'Shipment API', label: 'accepted — the scan is durable', kind: 'reply'},
      {from: 'Shipment API', to: 'shipment.event', label: 'produce · key = shp_8f · city + carrier_ref', kind: 'sync'},
      {from: 'shipment.event', to: 'Shipment API', label: 'ack / broker error', kind: 'reply'},
      {from: 'shipment.event', to: 'Timeline projector', label: 'consume · group timelines', kind: 'async'},
      {from: 'Timeline projector', to: 'shipments', label: 'project the ordered timeline', kind: 'async'},
    ],
  },
  hints: [
    'The message key is the ordering contract: `key=shipment_id`, `key: shipmentId`, `Key: []byte(shipmentID)`, `ProducerRecord("shipment.event", shipmentId, payload)`. The projector can only keep a shipment’s timeline in order if every event for that shipment lands on the same partition — keyed by carrier, the same parcel’s events are split across carriers.',
    'Publish what a timeline needs and nothing that identifies a person: shipment id, status, the scan **city**, a carrier reference and the timestamp. An address is the one field that turns a retained, replicated topic into a data-protection problem, and no last-mile routing happens from the event — that is the carrier’s own system.',
    'Order the two writes: the state store commits first, the event follows. `store.commit_status(...)` then `produce(...)` means the event describes a state that already exists, so a crash between them loses an event the reconciliation job can rebuild from the store — the other order invents history the store never accepted.',
  ],
  checks: [
    {
      id: 'shipment-key',
      title: 'Publishes keyed by shipment id',
      detail:
        'The message key is the shipment id, so one shipment’s events share a partition and its timeline stays ordered. The draft keys by carrier, which scatters one shipment’s events across partitions and lets the projector apply a delivery before the scans that preceded it.',
      match: {
        python: {all: [/key=shipment_id/, /\.produce\(/]},
        typescript: {all: [/key:\s*shipmentId/, /producer\.send\(/]},
        go: {all: [/Key:\s*\[\]byte\(shipmentID\)/, /WriteMessages\(/]},
        scala: {all: [/ProducerRecord\("shipment\.event",\s*shipmentId/, /\.send\(/]},
        cpp: {all: [/shipment_id\.data\(\)/, /produce\(/]},
      },
    },
    {
      id: 'city-granularity',
      title: 'Carries the scan city, nothing finer',
      detail:
        'The event’s location is the scan city (`scan_city`), not a street address: the timeline needs "which city, when", and the last-mile detail stays in the carrier’s system. The draft copies the recipient’s full address into the topic.',
      match: {
        python: {all: [/scan_city/, /"scan_city"/]},
        typescript: {all: [/scan_city:|"scan_city"/, /scan\.scan_city/]},
        go: {all: [/ScanCity/, /"scan_city"/]},
        scala: {all: [/scan_city/, /"scan_city"/]},
        cpp: {all: [/scan_city/, /"scan_city"/]},
      },
    },
    {
      id: 'no-address',
      title: 'No recipient address or name in the event or the logs',
      detail:
        'Neither the payload nor any log line carries a recipient address, street, postcode or name. The topic is retained for days and replicated, so the draft’s last-mile address outlives every retention policy the request pipeline has.',
      match: {
        python: {none: [/\baddress/i, /\bstreet/i, /\bpostal/i, /\bzip\b/i, /\brecipient\b/i]},
        typescript: {none: [/\baddress/i, /\bstreet/i, /\bpostal/i, /\bzip\b/i, /\brecipient\b/i]},
        go: {none: [/\baddress/i, /\bstreet/i, /\bpostal/i, /\bzip\b/i, /\brecipient\b/i]},
        scala: {none: [/\baddress/i, /\bstreet/i, /\bpostal/i, /\bzip\b/i, /\brecipient\b/i]},
        cpp: {none: [/\baddress/i, /\bstreet/i, /\bpostal/i, /\bzip\b/i, /\brecipient\b/i]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Produces only after the state store commits',
      detail:
        'The state store commits the scan first and the event is produced after it, so the event describes a state that already exists. The draft produces first and commits afterwards, which invents timeline entries for statuses the store never accepted.',
      match: {
        python: {order: [/store\.commit_status\(/, /producer\.produce\(/]},
        typescript: {order: [/store\.commitStatus\(/, /producer\.send\(/]},
        go: {order: [/store\.CommitStatus\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/commitStatus\(shipmentId,\s*scan\.status/, /producer\.send\(/]},
        cpp: {order: [/store\.commitStatus\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'envelope',
      title: 'Carries state, carrier reference and timestamp',
      detail:
        'The event envelope carries the shipment id, the status, the scan city, a carrier reference (`carrier_ref`) and `occurred_at` on `shipment.event`. The draft’s event has none of the fields the projector and the reconciliation job need.',
      match: {
        python: {all: [/shipment\.event/, /carrier_ref/, /occurred_at/]},
        typescript: {all: [/shipment\.event/, /carrier_ref/, /occurred_at/]},
        go: {all: [/shipment\.event/, /carrier_ref/, /occurred_at/]},
        scala: {all: [/shipment\.event/, /carrier_ref/, /occurred_at/]},
        cpp: {all: [/shipment\.event/, /carrier_ref/, /occurred_at/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("shipment-events")

producer = Producer({"bootstrap.servers": "kafka:9092"})


class StateStore:
    def commit_status(self, shipment_id: str, status: str, scan_at: int) -> None:
        """Persist the accepted scan; the timeline event follows the store, never precedes it."""
        raise NotImplementedError


store = StateStore()


def publish_status_change(shipment: dict, scan: dict) -> None:
    # TODO: this draft keys the event by the carrier so one shipment's timeline lands on many
    # partitions, publishes the recipient's full address for last-mile routing, and produces before
    # the state store has committed the scan. Key by shipment id, publish the scan city instead of
    # the address, and produce only after the commit.
    event = {
        "shipment_id": shipment["shipment_id"],
        "status": scan["status"],
        "address": scan["address"],
        "recipient_name": scan["recipient_name"],
    }
    logger.info("status change shipment=%s address=%s", shipment["shipment_id"], scan["address"])
    producer.produce("shipment.event", key=shipment["carrier"], value=json.dumps(event))
    producer.flush()
    store.commit_status(shipment["shipment_id"], scan["status"], scan["scan_at"])
`,
      solution: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("shipment-events")

TOPIC = "shipment.event"
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


class StateStore:
    def commit_status(self, shipment_id: str, status: str, scan_at: int) -> None:
        """Persist the accepted scan; the timeline event follows the store, never precedes it."""
        raise NotImplementedError


store = StateStore()


def event_payload(shipment: dict, scan: dict) -> dict:
    """The timeline event: ids, states, a city and a carrier reference only."""
    return {
        "shipment_id": shipment["shipment_id"],
        "status": scan["status"],
        "scan_city": scan["scan_city"],
        "carrier_ref": shipment["carrier_ref"],
        "occurred_at": scan["scan_at"],
    }


def publish_status_change(shipment: dict, scan: dict) -> None:
    shipment_id = shipment["shipment_id"]
    store.commit_status(shipment_id, scan["status"], scan["scan_at"])
    event = event_payload(shipment, scan)
    producer.produce(TOPIC, key=shipment_id, value=json.dumps(event))
    producer.flush(2.0)
    logger.info(
        "status change shipment=%s status=%s city=%s carrier=%s",
        shipment_id,
        scan["status"],
        scan["scan_city"],
        shipment["carrier_ref"],
    )
`,
    },
    typescript: {
      starter: `/** shipment.event: a model-generated draft keyed by carrier, carrying the address. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'shipments', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

interface Shipment {
  shipment_id: string;
  carrier: string;
  carrier_ref: string;
}

interface Scan {
  status: string;
  scan_at: number;
  address: string;
  recipient_name: string;
}

class StateStore {
  /** Persist the accepted scan; the timeline event follows the store, never precedes it. */
  async commitStatus(shipmentId: string, status: string, scanAt: number): Promise<void> {
    throw new Error('not implemented');
  }
}

const store = new StateStore();

export async function publishStatusChange(shipment: Shipment, scan: Scan): Promise<void> {
  // TODO: this draft keys the event by the carrier so one shipment's timeline lands on many
  // partitions, publishes the recipient's full address for last-mile routing, and produces before
  // the state store has committed the scan. Key by shipment id, publish the scan city instead of
  // the address, and produce only after the commit.
  const event = {
    shipment_id: shipment.shipment_id,
    status: scan.status,
    address: scan.address,
    recipient_name: scan.recipient_name,
  };
  await producer.send({
    topic: 'shipment.event',
    messages: [{key: shipment.carrier, value: JSON.stringify(event)}],
  });
  await store.commitStatus(shipment.shipment_id, scan.status, scan.scan_at);
}
`,
      solution: `/** shipment.event: keyed by shipment, city granularity, produced after the commit. */
import {Kafka} from 'kafkajs';

const kafka = new Kafka({clientId: 'shipments', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

const TOPIC = 'shipment.event';

interface Shipment {
  shipment_id: string;
  carrier_ref: string;
}

interface Scan {
  status: string;
  scan_at: number;
  scan_city: string;
}

class StateStore {
  /** Persist the accepted scan; the timeline event follows the store, never precedes it. */
  async commitStatus(shipmentId: string, status: string, scanAt: number): Promise<void> {
    throw new Error('not implemented');
  }
}

const store = new StateStore();

function eventPayload(shipment: Shipment, scan: Scan): Record<string, unknown> {
  return {
    shipment_id: shipment.shipment_id,
    status: scan.status,
    scan_city: scan.scan_city,
    carrier_ref: shipment.carrier_ref,
    occurred_at: scan.scan_at,
  };
}

export async function publishStatusChange(shipment: Shipment, scan: Scan): Promise<void> {
  const shipmentId = shipment.shipment_id;
  await store.commitStatus(shipmentId, scan.status, scan.scan_at);
  const event = eventPayload(shipment, scan);
  await producer.send({
    topic: TOPIC,
    acks: -1,
    messages: [{key: shipmentId, value: JSON.stringify(event)}],
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "shipment.event"}

type Shipment struct {
	ShipmentID string \`json:"shipment_id"\`
	Carrier    string \`json:"carrier"\`
	CarrierRef string \`json:"carrier_ref"\`
}

type Scan struct {
	Status        string \`json:"status"\`
	ScanAt        int64  \`json:"scan_at"\`
	Address       string \`json:"address"\`
	RecipientName string \`json:"recipient_name"\`
}

type stateStore struct{}

// CommitStatus persists the accepted scan; the timeline event follows the store, never precedes it.
func (s *stateStore) CommitStatus(ctx context.Context, shipmentID, status string, scanAt int64) error {
	return nil
}

var store = &stateStore{}

func publishStatusChange(ctx context.Context, shipment Shipment, scan Scan) error {
	// TODO: this draft keys the event by the carrier so one shipment's timeline lands on many
	// partitions, publishes the recipient's full address for last-mile routing, and produces before
	// the state store has committed the scan. Key by shipment id, publish the scan city instead of
	// the address, and produce only after the commit.
	event := map[string]any{
		"shipment_id":    shipment.ShipmentID,
		"status":         scan.Status,
		"address":        scan.Address,
		"recipient_name": scan.RecipientName,
	}
	payload, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(shipment.Carrier), Value: payload}); err != nil {
		return err
	}
	log.Printf("status change shipment=%s address=%s", shipment.ShipmentID, scan.Address)
	return store.CommitStatus(ctx, shipment.ShipmentID, scan.Status, scan.ScanAt)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"

	"github.com/segmentio/kafka-go"
)

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "shipment.event",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type Shipment struct {
	ShipmentID string \`json:"shipment_id"\`
	CarrierRef string \`json:"carrier_ref"\`
}

type Scan struct {
	Status   string \`json:"status"\`
	ScanAt   int64  \`json:"scan_at"\`
	ScanCity string \`json:"scan_city"\`
}

type stateStore struct{}

// CommitStatus persists the accepted scan; the timeline event follows the store, never precedes it.
func (s *stateStore) CommitStatus(ctx context.Context, shipmentID, status string, scanAt int64) error {
	return nil
}

var store = &stateStore{}

func eventPayload(shipment Shipment, scan Scan) map[string]any {
	return map[string]any{
		"shipment_id": shipment.ShipmentID,
		"status":      scan.Status,
		"scan_city":   scan.ScanCity,
		"carrier_ref": shipment.CarrierRef,
		"occurred_at": scan.ScanAt,
	}
}

func publishStatusChange(ctx context.Context, shipment Shipment, scan Scan) error {
	shipmentID := shipment.ShipmentID
	if err := store.CommitStatus(ctx, shipmentID, scan.Status, scan.ScanAt); err != nil {
		return err
	}
	payload, err := json.Marshal(eventPayload(shipment, scan))
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{Key: []byte(shipmentID), Value: payload})
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}

case class Shipment(shipment_id: String, carrier: String, carrier_ref: String)
case class Scan(status: String, scan_at: Long, address: String, recipient_name: String)

object ShipmentEvents {
  val producer = new KafkaProducer[String, String](new Properties())

  /** Persist the accepted scan; the timeline event follows the store, never precedes it. */
  def commitStatus(shipmentId: String, status: String, scanAt: Long): Unit = ()

  // TODO: this draft keys the event by the carrier so one shipment's timeline lands on many
  // partitions, publishes the recipient's full address for last-mile routing, and produces before
  // the state store has committed the scan. Key by shipment id, publish the scan city instead of
  // the address, and produce only after the commit.
  def publishStatusChange(shipment: Shipment, scan: Scan): Unit = {
    val event = Map(
      "shipment_id" -> shipment.shipment_id,
      "status" -> scan.status,
      "address" -> scan.address,
      "recipient_name" -> scan.recipient_name
    ).map { case (k, v) => "\\"" + k + "\\":\\"" + v + "\\"" }.mkString("{", ",", "}")
    producer.send(new ProducerRecord("shipment.event", shipment.carrier, event))
    commitStatus(shipment.shipment_id, scan.status, scan.scan_at)
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}

case class Shipment(shipment_id: String, carrier_ref: String)
case class Scan(status: String, scan_at: Long, scan_city: String)

object ShipmentEvents {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  /** Persist the accepted scan; the timeline event follows the store, never precedes it. */
  def commitStatus(shipmentId: String, status: String, scanAt: Long): Unit = ()

  def eventPayload(shipment: Shipment, scan: Scan): String = {
    val fields = Map(
      "shipment_id" -> shipment.shipment_id,
      "status" -> scan.status,
      "scan_city" -> scan.scan_city,
      "carrier_ref" -> shipment.carrier_ref,
      "occurred_at" -> scan.scan_at.toString
    )
    fields.map { case (k, v) => "\\"" + k + "\\":\\"" + v + "\\"" }.mkString("{", ",", "}")
  }

  def publishStatusChange(shipment: Shipment, scan: Scan): Unit = {
    val shipmentId = shipment.shipment_id
    commitStatus(shipmentId, scan.status, scan.scan_at)
    val payload = eventPayload(shipment, scan)
    producer.send(new ProducerRecord("shipment.event", shipmentId, payload))
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

using json = nlohmann::json;

struct Shipment {
  std::string shipment_id;
  std::string carrier;
  std::string carrier_ref;
};

struct Scan {
  std::string status;
  long long scan_at;
  std::string scan_city;
  std::string address;
  std::string recipient_name;
};

struct StateStore {
  /** Persist the accepted scan; the timeline event follows the store, never precedes it. */
  void commitStatus(const std::string& shipmentId, const std::string& status, long long scanAt);
};

StateStore store;
std::unique_ptr<RdKafka::Producer> producer;

// TODO: this draft keys the event by the carrier so one shipment's timeline lands on many
// partitions, publishes the recipient's full address for last-mile routing, and produces before
// the state store has committed the scan. Key by shipment id, publish the scan city instead of the
// address, and produce only after the commit.
void publishStatusChange(const Shipment& shipment, const Scan& scan) {
  const json event = {
      {"shipment_id", shipment.shipment_id},
      {"status", scan.status},
      {"address", scan.address},
      {"recipient_name", scan.recipient_name},
  };
  const auto payload = event.dump();
  producer->produce(
      "shipment.event",
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      shipment.carrier.data(),
      shipment.carrier.size(),
      0,
      nullptr);
  producer->flush(2000);
  store.commitStatus(shipment.shipment_id, scan.status, scan.scan_at);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using json = nlohmann::json;

const std::string kShipmentEventTopic = "shipment.event";

struct Shipment {
  std::string shipment_id;
  std::string carrier_ref;
};

struct Scan {
  std::string status;
  long long scan_at;
  std::string scan_city;
};

struct StateStore {
  /** Persist the accepted scan; the timeline event follows the store, never precedes it. */
  void commitStatus(const std::string& shipmentId, const std::string& status, long long scanAt);
};

StateStore store;

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

json eventPayload(const Shipment& shipment, const Scan& scan) {
  return json{
      {"shipment_id", shipment.shipment_id},
      {"status", scan.status},
      {"scan_city", scan.scan_city},
      {"carrier_ref", shipment.carrier_ref},
      {"occurred_at", scan.scan_at},
  };
}

void publishStatusChange(const Shipment& shipment, const Scan& scan) {
  const auto& shipment_id = shipment.shipment_id;
  store.commitStatus(shipment_id, scan.status, scan.scan_at);
  const auto payload = eventPayload(shipment, scan).dump();
  producer->produce(
      kShipmentEventTopic,
      RdKafka::Topic::PARTITION_UA,
      RdKafka::Producer::RK_MSG_COPY,
      const_cast<char*>(payload.data()),
      payload.size(),
      shipment_id.data(),
      shipment_id.size(),
      0,
      nullptr);
  producer->flush(2000);
}
`,
    },
  },
  debrief: `The interview question is what a topic is allowed to be: a projection of durable state, ordered per entity, carrying only what consumers need. The draft breaks all three. Keying by carrier scatters a shipment’s timeline, so ordering is lost exactly where it matters. Publishing before the commit makes the topic the source of truth for scans the store never accepted. And the address is the quiet one: a retained, replicated topic is the worst place in the system for recipient data, and no consumer of the timeline needs a house number. Real platforms add a topic schema with city-level location types, an outbox so a broker rejection cannot lose an event, and a reconciliation job that replays the store into the projector.`,
};
