import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Shipment events keyed by shipment for timelines',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'db', 'kafka', 'projection'],
  task: `## Task

**Starting point.** The starter's \`publish_status_change(shipment, scan)\` builds an event with the
shipment id, the status, the recipient's address and name, logs the address, produces it to
\`shipment.event\` keyed by the carrier code, flushes, and only then calls
\`store.commit_status(shipment_id, status, scan_at)\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** Keyed by carrier, one shipment's events scatter across
partitions and the projector can apply \`delivered\` before \`out_for_delivery\`, undoing a delivery in
the customer's view. The recipient's address sits in a topic that is retained for days and
replicated, long after the request and the customer who moved house. Publishing before the commit
makes the topic describe a status the store never accepted, and a crash between the two leaves
nothing to reconcile against.

- Produce to \`shipment.event\` with the shipment id as the message key (\`key=shipment_id\`).
- The payload carries \`shipment_id\`, \`status\`, \`scan_city\`, \`carrier_ref\` and
  \`occurred_at\`. Location is the scan's city, nothing finer.
- No recipient address, street, postcode or name in the payload or the logs.
- \`store.commit_status(...)\` first, \`producer.produce(...)\` after it.`,
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
    'A customer timeline shows delivered, then in transit, then delivered again; and a data-protection review finds street addresses in a topic retained for a week.',
    'The message key is the carrier, so one shipment lands on whichever partition that carrier maps to, and the projector reads its events out of order. The payload copies the scan verbatim.',
    'Key with `key=shipment_id`, replace the address fields with `scan_city`, add `carrier_ref` and `occurred_at`, and move `store.commit_status(...)` above `producer.produce(...)`. The log line must drop the address too.',
  ],
  checks: [
    {
      id: 'shipment-key',
      title: 'Publishes keyed by shipment id',
      detail:
        'The message key is the shipment id, so one shipment’s events share a partition and its timeline stays ordered. The starter keys by carrier, which scatters one shipment’s events across partitions and lets the projector apply a delivery before the scans that preceded it.',
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
        'The event’s location is the scan city (`scan_city`), not a street address: the timeline needs "which city, when", and the last-mile detail stays in the carrier’s system. The starter copies the recipient’s full address into the topic.',
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
        'Neither the payload nor any log line carries a recipient address, street, postcode or name. The topic is retained for days and replicated, so the starter’s last-mile address outlives every retention policy the request pipeline has.',
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
        'The state store commits the scan first and the event is produced after it, so the event describes a state that already exists. The starter produces first and commits afterwards, which invents timeline entries for statuses the store never accepted.',
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
        'The event envelope carries the shipment id, the status, the scan city, a carrier reference (`carrier_ref`) and `occurred_at` on `shipment.event`. The starter’s event has none of the fields the projector and the reconciliation job need.',
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
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
      starter: `/** shipment.event: publish one timeline event per status change. */
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
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
  debrief: `A timeline topic is a projection of durable state, ordered per entity, carrying only what consumers need, and the fix restores each property in turn. The shipment id as key puts every event for one parcel on one partition, the only ordering Kafka guarantees. Committing before producing means the event describes a state that already exists, so a crash between the two loses an event the store can rebuild rather than inventing one it cannot. The city-only payload keeps recipient data out of a log retained far longer than the request. Production platforms register the envelope in a schema registry so a producer cannot add an address field by accident, and write the event through an outbox in the commit's transaction so a broker rejection cannot drop it.`,
};
