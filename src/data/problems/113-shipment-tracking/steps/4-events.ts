import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Shipment events keyed by shipment, after the commit, without the address',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'redis', 'kafka', 'projection'],
  task: `## Task

**Starting point.** The starter handles a carrier's scan push:
\`record_scan(shipment_id, carrier, scan)\`, where \`scan\` is
\`{"status", "scan_at", "city", "carrier_ref", "recipient": {"name", "street", "postcode"}}\`,
builds an event that carries the scan as it came, logs the street, produces the event to
\`shipment.event\` keyed by the carrier code (a \`KafkaException\` parks it with
\`store.park_event\`), then calls \`apply_scan\` (\`shipments.timeline\`, step 2) and answers the event
when the scan applied. It serves the demo and hides four flaws.

**Failure mode the checks target.** One shipment's events spread over the partitions of every
carrier's traffic and the projector applies \`delivered\` before \`out_for_delivery\`; the recipient's
street sits in a topic retained for a week; a scan the state dropped still reaches the timeline; a
broker that times the record out loses it.

- Key by the **shipment id**.
- The payload is \`{shipment_id, status, scan_city, carrier_ref, occurred_at}\`: the city, no name,
  street or postcode, in the payload or the logs.
- \`apply_scan\` first; produce only when it applied.
- Park the event (\`store.park_event\`) when its **delivery** fails: \`on_delivery\`, a rejected
  \`send\`, a \`WriteMessages\` error, \`dr_cb\`, a producer \`Callback\`.`,
  sequence: {
    participants: ['Carrier push', 'Shipment API', 'Redis', 'shipment.event', 'Timeline projector'],
    messages: [
      {from: 'Carrier push', to: 'Shipment API', label: 'scan out_for_delivery · Leeds · recipient', kind: 'sync'},
      {from: 'Shipment API', to: 'Redis', label: 'apply_scan → applied', kind: 'sync'},
      {
        from: 'Shipment API',
        to: 'shipment.event',
        label: 'produce · key shp_1 · {status, scan_city, carrier_ref}',
        kind: 'sync',
      },
      {from: 'shipment.event', to: 'Shipment API', label: 'delivery report: timed out', kind: 'reply'},
      {from: 'Shipment API', to: 'Redis', label: 'park_event → outbox:shipment.event', kind: 'sync'},
      {from: 'shipment.event', to: 'Timeline projector', label: 'consume · one partition per shipment', kind: 'async'},
    ],
  },
  hints: [
    "A customer's timeline shows delivered before out for delivery, a data-protection review finds street addresses in the topic, and a scan the shipment ignored still shows up in the timeline.",
    'The key picks the partition and the key is the carrier, so one shipment shares partitions with every other parcel that carrier moves. The event is built from the scan as it came and produced before the state decides.',
    'Call `apply_scan` first and return when it did not apply; build `{shipment_id, status, scan_city, carrier_ref, occurred_at}`; produce with `key=shipment_id` and park the event from the delivery callback, not from `except KafkaException`.',
  ],
  checks: [
    {
      id: 'shipment-key',
      title: 'Keys every event by the shipment id',
      detail:
        "The record key is the shipment id, so one shipment's events share a partition and reach the projector in order; keyed by the carrier they are spread across partitions.",
      match: {
        python: {all: [/key\s*=\s*shipment_id/], none: [/key\s*=\s*carrier/]},
        typescript: {all: [/key:\s*shipmentId\b/], none: [/key:\s*carrier\b/]},
        go: {all: [/Key:\s*\[\]byte\(shipmentID\)/], none: [/\[\]byte\(carrier\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(EventTopic,\s*shipmentId/], none: [/EventTopic,\s*carrier/]},
        cpp: {all: [/shipment_id\.c_str\(\),\s*shipment_id\.size\(\)/], none: [/carrier\.c_str\(\)/]},
      },
    },
    {
      id: 'no-address',
      title: 'Carries the scan city, never the recipient',
      detail:
        "The payload names the scan's city (`scan_city`) and nothing finer; no name, street or postcode reaches the payload or a log line. The topic is retained and replicated long after the parcel arrives.",
      match: {
        python: {all: [/["']scan_city["']/], none: [/["']recipient["']|["']street["']|["']scan["']\s*:\s*scan\b/]},
        typescript: {all: [/scan_city/], none: [/scan\.recipient|\.\.\.scan\b|scan:\s*scan\b/]},
        go: {all: [/"scan_city"/], none: [/scan\.Recipient|"scan":\s*scan\b/]},
        scala: {all: [/"scan_city"/], none: [/scan\.recipient|scan\.toJson/]},
        cpp: {all: [/"scan_city"/], none: [/recipient|\{"scan",\s*scan\}/]},
      },
    },
    {
      id: 'publish-after-commit',
      title: 'Produces only what the state store applied',
      detail:
        '`apply_scan` runs first and the event is produced only when the scan applied, so the topic never describes a status the shipment does not hold.',
      match: {
        python: {order: [/apply_scan\(/, /producer\.produce\(/]},
        typescript: {order: [/applyScan\(/, /producer\.send\(/]},
        go: {order: [/timeline\.ApplyScan\(/, /writer\.WriteMessages\(/]},
        scala: {order: [/Timeline\.applyScan\(/, /producer\.send\(/]},
        cpp: {order: [/timeline::applyScan\(/, /producer->produce\(/]},
      },
    },
    {
      id: 'delivery-outbox',
      title: 'Parks an event whose delivery failed',
      detail:
        'The event is parked when the broker reports the delivery failed (`on_delivery`, a rejected `send`, a `WriteMessages` error, `dr_cb`, a producer `Callback`); `except KafkaException` around `produce` only sees local enqueue errors.',
      match: {
        python: {all: [/on_delivery\s*=/, /store\.park_event\(/], none: [/except\s+KafkaException/]},
        typescript: {all: [/await\s+producer\.send\(/, /store\.parkEvent\(/], none: [/\.catch\(/]},
        go: {order: [/writer\.WriteMessages\(/, /store\.ParkEvent\(/]},
        scala: {all: [/new Callback|onCompletion/, /Store\.parkEvent\(/], none: [/case\s+\w+:\s*KafkaException/]},
        cpp: {order: [/void dr_cb\(/, /store::parkEvent\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaException, Producer

from shipments import store  # store.park_event
from shipments.timeline import apply_scan

EVENT_TOPIC = "shipment.event"
log = logging.getLogger("shipment-events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def record_scan(shipment_id: str, carrier: str, scan: dict) -> dict | None:
    """Apply a carrier's scan push and tell the timeline projector; the event, or None when the scan did not apply."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    event = {"shipment_id": shipment_id, "status": scan["status"], "occurred_at": scan["scan_at"], "carrier_ref": scan["carrier_ref"], "scan": scan}
    log.info("scan %s for %s at %s", scan["status"], shipment_id, scan["recipient"]["street"])
    try:
        producer.produce(EVENT_TOPIC, key=carrier, value=json.dumps(event))
        producer.flush(5)
    except KafkaException:
        store.park_event(event)
    result = apply_scan(shipment_id, scan["status"], scan["scan_at"], scan["city"])
    return event if result["applied"] else None
`,
      solution: `import json
import logging

from confluent_kafka import KafkaException, Producer

from shipments import store  # store.park_event
from shipments.timeline import apply_scan

EVENT_TOPIC = "shipment.event"
log = logging.getLogger("shipment-events")

producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def park_on_failure(event: dict):
    """The delivery report: a record the broker did not take goes to the outbox for the relay."""

    def on_delivery(err, msg) -> None:
        if err is not None:
            store.park_event(event)

    return on_delivery


def record_scan(shipment_id: str, carrier: str, scan: dict) -> dict | None:
    """Apply a carrier's scan push and tell the timeline projector; the event, or None when the scan did not apply."""
    # The state decides first: an event describes a status the shipment holds.
    result = apply_scan(shipment_id, scan["status"], scan["scan_at"], scan["city"])
    if not result["applied"]:
        return None
    event = {
        "shipment_id": shipment_id,
        "status": scan["status"],
        "scan_city": scan["city"],  # the city is as fine as the timeline goes
        "carrier_ref": scan["carrier_ref"],
        "occurred_at": scan["scan_at"],
    }
    log.info("scan %s for %s in %s", scan["status"], shipment_id, scan["city"])
    producer.produce(EVENT_TOPIC, key=shipment_id, value=json.dumps(event), on_delivery=park_on_failure(event))
    producer.flush(5)
    return event
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import * as store from 'shipments/store'; // store.parkEvent
import {applyScan} from 'shipments/timeline';

export const EVENT_TOPIC = 'shipment.event';

export interface ScanReport {
  status: string;
  scan_at: number;
  city: string;
  carrier_ref: string;
  recipient: {name: string; street: string; postcode: string};
}

const kafka = new Kafka({clientId: 'shipments', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Apply a carrier's scan push and tell the timeline projector; the event, or null when the scan did not apply. */
export async function recordScan(shipmentId: string, carrier: string, scan: ScanReport): Promise<Record<string, unknown> | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const event = {shipment_id: shipmentId, status: scan.status, occurred_at: scan.scan_at, carrier_ref: scan.carrier_ref, scan};
  console.log(\`scan \${scan.status} for \${shipmentId} at \${scan.recipient.street}\`);
  producer
    .send({topic: EVENT_TOPIC, messages: [{key: carrier, value: JSON.stringify(event)}], acks: -1})
    .catch(err => console.warn(\`event not delivered: \${(err as Error).message}\`));
  const result = await applyScan(shipmentId, scan.status, scan.scan_at, scan.city);
  return result.applied ? event : null;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import * as store from 'shipments/store'; // store.parkEvent
import {applyScan} from 'shipments/timeline';

export const EVENT_TOPIC = 'shipment.event';

export interface ScanReport {
  status: string;
  scan_at: number;
  city: string;
  carrier_ref: string;
  recipient: {name: string; street: string; postcode: string};
}

const kafka = new Kafka({clientId: 'shipments', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** Apply a carrier's scan push and tell the timeline projector; the event, or null when the scan did not apply. */
export async function recordScan(shipmentId: string, carrier: string, scan: ScanReport): Promise<Record<string, unknown> | null> {
  // The state decides first: an event describes a status the shipment holds.
  const result = await applyScan(shipmentId, scan.status, scan.scan_at, scan.city);
  if (!result.applied) return null;
  // The city is as fine as the timeline goes.
  const event = {shipment_id: shipmentId, status: scan.status, scan_city: scan.city, carrier_ref: scan.carrier_ref, occurred_at: scan.scan_at};
  console.log(\`scan \${scan.status} for \${shipmentId} in \${scan.city}\`);
  try {
    await producer.send({topic: EVENT_TOPIC, messages: [{key: shipmentId, value: JSON.stringify(event)}], acks: -1});
  } catch {
    await store.parkEvent(event); // the broker did not take it: the relay sends it again
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

	"github.com/segmentio/kafka-go"

	// the outbox: store.ParkEvent in "shipments/store"
	"shipments/timeline" // timeline.ApplyScan
)

const eventTopic = "shipment.event"

var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 10 * time.Millisecond,
}

// Recipient is who the parcel goes to.
type Recipient struct {
	Name     string \`json:"name"\`
	Street   string \`json:"street"\`
	Postcode string \`json:"postcode"\`
}

// ScanReport is a carrier's scan push.
type ScanReport struct {
	Status     string    \`json:"status"\`
	ScanAt     int64     \`json:"scan_at"\`
	City       string    \`json:"city"\`
	CarrierRef string    \`json:"carrier_ref"\`
	Recipient  Recipient \`json:"recipient"\`
}

// recordScan applies a carrier's scan push and tells the timeline projector; the event, or nil when the scan did not apply.
func recordScan(ctx context.Context, shipmentID, carrier string, scan ScanReport) (map[string]any, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	event := map[string]any{"shipment_id": shipmentID, "status": scan.Status, "occurred_at": scan.ScanAt, "carrier_ref": scan.CarrierRef, "scan": scan}
	log.Printf("scan %s for %s at %s", scan.Status, shipmentID, scan.Recipient.Street)
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(carrier), Value: value}); err != nil {
		log.Printf("event not delivered: %v", err)
	}
	result, err := timeline.ApplyScan(ctx, shipmentID, scan.Status, scan.ScanAt, scan.City)
	if err != nil || !result.Applied {
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
	"time"

	"github.com/segmentio/kafka-go"

	"shipments/store"    // store.ParkEvent
	"shipments/timeline" // timeline.ApplyScan
)

const eventTopic = "shipment.event"

// RequireAll: the record is on every replica before WriteMessages returns. kafka-go has no
// idempotent producer; the projector deduplicates by (shipment_id, status).
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        eventTopic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 10 * time.Millisecond,
}

// Recipient is who the parcel goes to.
type Recipient struct {
	Name     string \`json:"name"\`
	Street   string \`json:"street"\`
	Postcode string \`json:"postcode"\`
}

// ScanReport is a carrier's scan push.
type ScanReport struct {
	Status     string    \`json:"status"\`
	ScanAt     int64     \`json:"scan_at"\`
	City       string    \`json:"city"\`
	CarrierRef string    \`json:"carrier_ref"\`
	Recipient  Recipient \`json:"recipient"\`
}

// recordScan applies a carrier's scan push and tells the timeline projector; the event, or nil when the scan did not apply.
func recordScan(ctx context.Context, shipmentID, carrier string, scan ScanReport) (map[string]any, error) {
	// The state decides first: an event describes a status the shipment holds.
	result, err := timeline.ApplyScan(ctx, shipmentID, scan.Status, scan.ScanAt, scan.City)
	if err != nil || !result.Applied {
		return nil, err
	}
	// The city is as fine as the timeline goes.
	event := map[string]any{"shipment_id": shipmentID, "status": scan.Status, "scan_city": scan.City, "carrier_ref": scan.CarrierRef, "occurred_at": scan.ScanAt}
	log.Printf("scan %s for %s in %s", scan.Status, shipmentID, scan.City)
	value, _ := json.Marshal(event)
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(shipmentID), Value: value}); err != nil {
		store.ParkEvent(ctx, event) // the broker did not take it: the relay sends it again
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
import spray.json._

import shipments.{Store, Timeline} // Store.parkEvent; Timeline.applyScan

final case class Recipient(name: String, street: String, postcode: String)
final case class ScanReport(status: String, scanAt: Long, city: String, carrierRef: String, recipient: Recipient) {
  def toJson: JsObject = JsObject(
    "status" -> JsString(status), "scan_at" -> JsNumber(scanAt), "city" -> JsString(city), "carrier_ref" -> JsString(carrierRef),
    "recipient" -> JsObject("name" -> JsString(recipient.name), "street" -> JsString(recipient.street), "postcode" -> JsString(recipient.postcode)))
}

object Events {
  val EventTopic = "shipment.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Apply a carrier's scan push and tell the timeline projector; the event, or None when the scan did not apply. */
  def recordScan(shipmentId: String, carrier: String, scan: ScanReport): Option[JsObject] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val event = JsObject("shipment_id" -> JsString(shipmentId), "status" -> JsString(scan.status), "occurred_at" -> JsNumber(scan.scanAt),
      "carrier_ref" -> JsString(scan.carrierRef), "scan" -> scan.toJson)
    println(s"scan \${scan.status} for $shipmentId at \${scan.recipient.street}")
    try producer.send(new ProducerRecord[String, String](EventTopic, carrier, event.compactPrint))
    catch { case _: KafkaException => Store.parkEvent(event) }
    if (Timeline.applyScan(shipmentId, scan.status, scan.scanAt, scan.city).applied) Some(event) else None
  }
}
`,
      solution: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import shipments.{Store, Timeline} // Store.parkEvent; Timeline.applyScan

final case class Recipient(name: String, street: String, postcode: String)
final case class ScanReport(status: String, scanAt: Long, city: String, carrierRef: String, recipient: Recipient)

object Events {
  val EventTopic = "shipment.event"

  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** Apply a carrier's scan push and tell the timeline projector; the event, or None when the scan did not apply. */
  def recordScan(shipmentId: String, carrier: String, scan: ScanReport): Option[JsObject] = {
    // The state decides first: an event describes a status the shipment holds.
    if (!Timeline.applyScan(shipmentId, scan.status, scan.scanAt, scan.city).applied) return None
    // The city is as fine as the timeline goes.
    val event = JsObject("shipment_id" -> JsString(shipmentId), "status" -> JsString(scan.status), "scan_city" -> JsString(scan.city),
      "carrier_ref" -> JsString(scan.carrierRef), "occurred_at" -> JsNumber(scan.scanAt))
    println(s"scan \${scan.status} for $shipmentId in \${scan.city}")
    producer.send(new ProducerRecord[String, String](EventTopic, shipmentId, event.compactPrint), new Callback {
      // The broker did not take it: the relay sends it again.
      override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit = if (exception != null) Store.parkEvent(event)
    })
    producer.flush()
    Some(event)
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "shipments/store.h"     // store::parkEvent
#include "shipments/timeline.h"  // timeline::applyScan

using json = nlohmann::json;

const std::string kEventTopic = "shipment.event";

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Apply a carrier's scan push ({status, scan_at, city, carrier_ref, recipient}) and tell the timeline
// projector; the event, or none when the scan did not apply.
std::optional<json> recordScan(const std::string& shipment_id, const std::string& carrier, const json& scan) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json event = {{"shipment_id", shipment_id}, {"status", scan.value("status", "")}, {"occurred_at", scan.value("scan_at", 0L)},
                      {"carrier_ref", scan.value("carrier_ref", "")}, {"scan", scan}};
  std::cerr << "scan " << scan.value("status", "") << " for " << shipment_id << " at " << scan["recipient"].value("street", "") << "\\n";
  const std::string value = event.dump();
  const RdKafka::ErrorCode err = producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                                                   const_cast<char*>(value.data()), value.size(), carrier.c_str(), carrier.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) store::parkEvent(event);
  producer->flush(5000);
  const timeline::Result result = timeline::applyScan(shipment_id, scan.value("status", ""), scan.value("scan_at", 0L), scan.value("city", ""));
  if (!result.applied) return std::nullopt;
  return event;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <optional>
#include <string>

#include "shipments/store.h"     // store::parkEvent
#include "shipments/timeline.h"  // timeline::applyScan

using json = nlohmann::json;

const std::string kEventTopic = "shipment.event";

// The delivery report: a record the broker did not take goes to the outbox for the relay.
class ParkOnFailure : public RdKafka::DeliveryReportCb {
 public:
  void dr_cb(RdKafka::Message& message) override {
    if (message.err() == RdKafka::ERR_NO_ERROR) return;
    store::parkEvent(json::parse(std::string(static_cast<const char*>(message.payload()), message.len())));
  }
};

ParkOnFailure park_on_failure;

std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &park_on_failure, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// Apply a carrier's scan push ({status, scan_at, city, carrier_ref, ...}) and tell the timeline
// projector; the event, or none when the scan did not apply.
std::optional<json> recordScan(const std::string& shipment_id, const std::string& carrier, const json& scan) {
  // The state decides first: an event describes a status the shipment holds.
  const timeline::Result result = timeline::applyScan(shipment_id, scan.value("status", ""), scan.value("scan_at", 0L), scan.value("city", ""));
  if (!result.applied) return std::nullopt;
  // The city is as fine as the timeline goes.
  const json event = {{"shipment_id", shipment_id}, {"status", scan.value("status", "")}, {"scan_city", scan.value("city", "")},
                      {"carrier_ref", scan.value("carrier_ref", "")}, {"occurred_at", scan.value("scan_at", 0L)}};
  std::cerr << "scan " << scan.value("status", "") << " for " << shipment_id << " in " << scan.value("city", "") << "\\n";
  const std::string value = event.dump();
  producer->produce(kEventTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(value.data()),
                    value.size(), shipment_id.c_str(), shipment_id.size(), 0, nullptr);
  producer->flush(5000);
  return event;
}
`,
    },
  },
  harness: {
    python: `import json
import logging

from shipments import store

TOPIC = "shipment.event"
RECIPIENT = {"name": "Ada Lovelace", "street": "12 Elm Street", "postcode": "LS1 4AP"}
PRIVATE = ("Ada Lovelace", "12 Elm Street", "LS1 4AP")


def _scan(status, at, city="Leeds"):
    return {"status": status, "scan_at": at, "city": city, "carrier_ref": "1Z999AA1", "recipient": RECIPIENT}


def _events(ctx, *shipment_ids):
    for shipment_id in shipment_ids:
        store.save({"shipment_id": shipment_id, "tenant_id": "t-acme", "order_id": f"ord_{shipment_id}", "carrier": "ups", "service_level": "ground", "status": "label", "replacement_of": "", "created_at": 0})
    return ctx.load("events")


class _Lines(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


def check_shipment_key(ctx):
    m = _events(ctx, "shp_1", "shp_2")
    m.record_scan("shp_1", "ups", _scan("in_transit", 100, "Memphis"))
    m.record_scan("shp_2", "ups", _scan("in_transit", 110, "Memphis"))
    m.record_scan("shp_1", "ups", _scan("out_for_delivery", 200))
    m.record_scan("shp_1", "ups", _scan("delivered", 300))
    records = ctx.kafka.records(TOPIC)
    keys = [r.key for r in records]
    assert keys == [b"shp_1", b"shp_2", b"shp_1", b"shp_1"], f"the records are keyed {keys}: key each event by its shipment id"
    partitions = {r.partition for r in records if r.key == b"shp_1"}
    assert len(partitions) == 1, f"shp_1's events landed on partitions {sorted(partitions)}: one shipment's timeline must stay on one partition, in order"


def check_no_address(ctx):
    m = _events(ctx, "shp_1")
    lines = _Lines()
    root = logging.getLogger()
    root.addHandler(lines)
    root.setLevel(logging.INFO)
    try:
        event = m.record_scan("shp_1", "ups", _scan("out_for_delivery", 200))
    finally:
        root.removeHandler(lines)
    records = ctx.kafka.records(TOPIC)
    assert len(records) == 1, f"one applied scan left {len(records)} records on {TOPIC}"
    text = records[0].value.decode()
    leaked = [p for p in PRIVATE if p in text]
    assert not leaked, f"the event carries the recipient's {leaked}: {text}. The timeline needs the city, nothing finer"
    payload = json.loads(text)
    assert payload.get("scan_city") == "Leeds" and payload.get("carrier_ref") == "1Z999AA1" and payload.get("occurred_at") == 200, f"the event must carry scan_city Leeds, carrier_ref and occurred_at 200, got {payload}"
    assert event == payload, f"record_scan must answer the event it produced: answered {event}, produced {payload}"
    logged = [line for line in lines.lines if any(p in line for p in PRIVATE)]
    assert not logged, f"a log line carries the recipient: {logged}"


def check_publish_after_commit(ctx):
    m = _events(ctx, "shp_1")
    at_commit = ctx.redis_after("shipment:shp_1", lambda: len(ctx.kafka.records(TOPIC)))
    m.record_scan("shp_1", "ups", _scan("out_for_delivery", 200))
    assert at_commit.fired, "record_scan never touched shipment:shp_1: the scan must go through apply_scan"
    assert at_commit.result == 0, f"when the state store saw the scan the topic already held {at_commit.result} record(s): apply first, produce after"
    assert len(ctx.kafka.records(TOPIC)) == 1, f"one applied scan left {len(ctx.kafka.records(TOPIC))} records"
    dropped = m.record_scan("shp_1", "ups", _scan("in_transit", 260))
    assert dropped is None, f"a scan the state dropped (in_transit after out_for_delivery) must answer None, got {dropped}"
    statuses = [json.loads(r.value).get("status") for r in ctx.kafka.records(TOPIC)]
    assert statuses == ["out_for_delivery"], f"the topic holds {statuses}: a scan the state dropped reached the timeline"


def check_delivery_outbox(ctx):
    m = _events(ctx, "shp_1")
    ctx.kafka.fail_next(TOPIC, 1)
    event = m.record_scan("shp_1", "ups", _scan("out_for_delivery", 200))
    parked = [json.loads(raw) for raw in ctx.redis.lrange("outbox:shipment.event", 0, -1)]
    assert len(parked) == 1, f"the broker timed the event out and the outbox holds {len(parked)} events: park it from the delivery report (on_delivery), an exception around produce never sees it"
    assert parked[0].get("shipment_id") == "shp_1" and parked[0].get("status") == "out_for_delivery", f"the parked event is {parked[0]}, expected shp_1's out_for_delivery event {event}"
    m.record_scan("shp_1", "ups", _scan("delivered", 300))
    assert len(ctx.redis.lrange("outbox:shipment.event", 0, -1)) == 1, "a delivered event must not be parked"
    assert [json.loads(r.value).get("status") for r in ctx.kafka.records(TOPIC)][-1] == "delivered", "the next event must reach the topic"
`,
    typescript: `const TOPIC = 'shipment.event';
const RECIPIENT = {name: 'Ada Lovelace', street: '12 Elm Street', postcode: 'LS1 4AP'};
const PRIVATE = ['Ada Lovelace', '12 Elm Street', 'LS1 4AP'];

const scan = (status: string, at: number, city = 'Leeds') => ({status, scan_at: at, city, carrier_ref: '1Z999AA1', recipient: RECIPIENT});

async function events(ctx, ...shipmentIds: string[]) {
  const store = ctx.load('/support/shipments/store.ts');
  for (const id of shipmentIds) {
    await store.save({shipment_id: id, tenant_id: 't-acme', order_id: \`ord_\${id}\`, carrier: 'ups', service_level: 'ground', status: 'label', replacement_of: '', created_at: 0});
  }
  return ctx.load('events');
}

const valueOf = (record): string => record.value.toString();

export async function check_shipment_key(ctx) {
  const m = await events(ctx, 'shp_1', 'shp_2');
  await m.recordScan('shp_1', 'ups', scan('in_transit', 100, 'Memphis'));
  await m.recordScan('shp_2', 'ups', scan('in_transit', 110, 'Memphis'));
  await m.recordScan('shp_1', 'ups', scan('out_for_delivery', 200));
  await m.recordScan('shp_1', 'ups', scan('delivered', 300));
  const records = ctx.kafka.records(TOPIC);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['shp_1', 'shp_2', 'shp_1', 'shp_1'], \`the records are keyed \${JSON.stringify(keys)}: key each event by its shipment id\`);
  const partitions = new Set(records.filter(r => r.key?.toString() === 'shp_1').map(r => r.partition));
  assert.equal(partitions.size, 1, \`shp_1's events landed on partitions \${JSON.stringify([...partitions])}: one shipment's timeline must stay on one partition, in order\`);
}

export async function check_no_address(ctx) {
  const m = await events(ctx, 'shp_1');
  const lines: string[] = [];
  const real = {log: console.log, info: console.info, warn: console.warn, error: console.error};
  console.log = console.info = console.warn = console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  let event;
  try {
    event = await m.recordScan('shp_1', 'ups', scan('out_for_delivery', 200));
  } finally {
    Object.assign(console, real);
  }
  const records = ctx.kafka.records(TOPIC);
  assert.equal(records.length, 1, \`one applied scan left \${records.length} records on \${TOPIC}\`);
  const text = valueOf(records[0]);
  const leaked = PRIVATE.filter(p => text.includes(p));
  assert.equal(leaked.length, 0, \`the event carries the recipient's \${JSON.stringify(leaked)}: \${text}. The timeline needs the city, nothing finer\`);
  const payload = JSON.parse(text);
  assert(payload.scan_city === 'Leeds' && payload.carrier_ref === '1Z999AA1' && payload.occurred_at === 200, \`the event must carry scan_city Leeds, carrier_ref and occurred_at 200, got \${text}\`);
  assert.deepStrictEqual(event, payload, \`recordScan must answer the event it produced: answered \${JSON.stringify(event)}, produced \${text}\`);
  const logged = lines.filter(line => PRIVATE.some(p => line.includes(p)));
  assert.equal(logged.length, 0, \`a log line carries the recipient: \${JSON.stringify(logged)}\`);
}

export async function check_publish_after_commit(ctx) {
  const m = await events(ctx, 'shp_1');
  const atCommit = ctx.redisAfter('shipment:shp_1', () => ctx.kafka.records(TOPIC).length);
  await m.recordScan('shp_1', 'ups', scan('out_for_delivery', 200));
  assert(atCommit.fired, 'recordScan never touched shipment:shp_1: the scan must go through applyScan');
  assert.equal(atCommit.result, 0, \`when the state store saw the scan the topic already held \${atCommit.result} record(s): apply first, produce after\`);
  assert.equal(ctx.kafka.records(TOPIC).length, 1, 'one applied scan must leave one record');
  const dropped = await m.recordScan('shp_1', 'ups', scan('in_transit', 260));
  assert.equal(dropped, null, \`a scan the state dropped (in_transit after out_for_delivery) must answer null, got \${JSON.stringify(dropped)}\`);
  const statuses = ctx.kafka.records(TOPIC).map(r => JSON.parse(valueOf(r)).status);
  assert.deepStrictEqual(statuses, ['out_for_delivery'], \`the topic holds \${JSON.stringify(statuses)}: a scan the state dropped reached the timeline\`);
}

export async function check_delivery_outbox(ctx) {
  const m = await events(ctx, 'shp_1');
  ctx.kafka.failNext(TOPIC, 1);
  const event = await m.recordScan('shp_1', 'ups', scan('out_for_delivery', 200));
  const parked = ctx.redis.lrange('outbox:shipment.event', 0, -1).map(raw => JSON.parse(raw));
  assert.equal(parked.length, 1, \`the broker timed the event out and the outbox holds \${parked.length} events: park it when the send rejects, a .catch that logs drops it\`);
  assert(parked[0].shipment_id === 'shp_1' && parked[0].status === 'out_for_delivery', \`the parked event is \${JSON.stringify(parked[0])}, expected shp_1's out_for_delivery event \${JSON.stringify(event)}\`);
  await m.recordScan('shp_1', 'ups', scan('delivered', 300));
  assert.equal(ctx.redis.lrange('outbox:shipment.event', 0, -1).length, 1, 'a delivered event must not be parked');
  const last = ctx.kafka.records(TOPIC).at(-1);
  assert(last !== undefined && JSON.parse(valueOf(last)).status === 'delivered', 'the next event must reach the topic');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"

	"shipments/store"

	"leetbuild/harness"
)

const topic = "shipment.event"

var (
	eventsBg = context.Background()
	private  = []string{"Ada Lovelace", "12 Elm Street", "LS1 4AP"}
)

func scanOf(status string, at int64, city string) ScanReport {
	return ScanReport{Status: status, ScanAt: at, City: city, CarrierRef: "1Z999AA1", Recipient: Recipient{Name: "Ada Lovelace", Street: "12 Elm Street", Postcode: "LS1 4AP"}}
}

func ships(ids ...string) {
	for _, id := range ids {
		store.Save(eventsBg, store.Shipment{ShipmentID: id, TenantID: "t-acme", OrderID: "ord_" + id, Carrier: "ups", ServiceLevel: "ground", Status: "label"})
	}
}

func record(ctx *harness.Ctx, shipmentID string, s ScanReport) map[string]any {
	event, err := recordScan(eventsBg, shipmentID, "ups", s)
	ctx.NoError(err, "recordScan(%s, %s) failed", shipmentID, s.Status)
	return event
}

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func statuses(ctx *harness.Ctx) []string {
	out := []string{}
	for _, r := range ctx.Kafka.Records(topic) {
		s, _ := payloadOf(ctx, r.Value)["status"].(string)
		out = append(out, s)
	}
	return out
}

func CheckShipmentKey(ctx *harness.Ctx) {
	ships("shp_1", "shp_2")
	record(ctx, "shp_1", scanOf("in_transit", 100, "Memphis"))
	record(ctx, "shp_2", scanOf("in_transit", 110, "Memphis"))
	record(ctx, "shp_1", scanOf("out_for_delivery", 200, "Leeds"))
	record(ctx, "shp_1", scanOf("delivered", 300, "Leeds"))
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 4, "four applied scans; the records on %s", topic)
	partitions := map[int]bool{}
	ones := 0
	for _, r := range records {
		if string(r.Key) == "shp_1" {
			ones++
			partitions[r.Partition] = true
		}
	}
	ctx.Equal(ones, 3, "key each event by its shipment id; the records keyed shp_1 (keys %q)", ctx.Kafka.Keys(topic))
	ctx.Equal(len(partitions), 1, "one shipment's timeline must stay on one partition, in order; the partitions of shp_1's events")
}

func CheckNoAddress(ctx *harness.Ctx) {
	ships("shp_1")
	var lines bytes.Buffer
	log.SetOutput(&lines)
	event := record(ctx, "shp_1", scanOf("out_for_delivery", 200, "Leeds"))
	log.SetOutput(os.Stderr)
	records := ctx.Kafka.Records(topic)
	ctx.Equal(len(records), 1, "one applied scan; the records on %s", topic)
	text := string(records[0].Value)
	for _, p := range private {
		ctx.Assert(!strings.Contains(text, p), "the event carries the recipient's %q: %s. The timeline needs the city, nothing finer", p, text)
		ctx.Assert(!strings.Contains(lines.String(), p), "a log line carries the recipient's %q: %s", p, lines.String())
	}
	payload := payloadOf(ctx, records[0].Value)
	ctx.Assert(payload["scan_city"] == "Leeds" && payload["carrier_ref"] == "1Z999AA1" && payload["occurred_at"] == float64(200), "the event must carry scan_city Leeds, carrier_ref and occurred_at 200, got %s", text)
	ctx.Equal(event["scan_city"], "Leeds", "recordScan must answer the event it produced; its scan_city")
}

func CheckPublishAfterCommit(ctx *harness.Ctx) {
	ships("shp_1")
	atCommit := ctx.Redis.After("shipment:shp_1", func() any { return len(ctx.Kafka.Records(topic)) })
	record(ctx, "shp_1", scanOf("out_for_delivery", 200, "Leeds"))
	ctx.Assert(atCommit.Fired, "recordScan never touched shipment:shp_1: the scan must go through timeline.ApplyScan")
	ctx.Equal(atCommit.Result, 0, "when the state store saw the scan the topic already held records: apply first, produce after; records at the commit")
	ctx.Equal(len(ctx.Kafka.Records(topic)), 1, "one applied scan; the records")
	dropped := record(ctx, "shp_1", scanOf("in_transit", 260, "Leeds"))
	ctx.Assert(dropped == nil, "a scan the state dropped (in_transit after out_for_delivery) must answer nil, got %v", dropped)
	ctx.Equal(statuses(ctx), []string{"out_for_delivery"}, "a scan the state dropped must not reach the timeline; the statuses on the topic")
}

func CheckDeliveryOutbox(ctx *harness.Ctx) {
	ships("shp_1")
	ctx.Kafka.FailNext(topic, 1)
	record(ctx, "shp_1", scanOf("out_for_delivery", 200, "Leeds"))
	parked := ctx.Redis.LRange("outbox:shipment.event", 0, -1)
	ctx.Equal(len(parked), 1, "the broker timed the event out: park it when WriteMessages returns an error; the outbox")
	p := payloadOf(ctx, []byte(parked[0]))
	ctx.Assert(p["shipment_id"] == "shp_1" && p["status"] == "out_for_delivery", "the parked event is %s, expected shp_1's out_for_delivery event", parked[0])
	record(ctx, "shp_1", scanOf("delivered", 300, "Leeds"))
	ctx.Equal(len(ctx.Redis.LRange("outbox:shipment.event", 0, -1)), 1, "a delivered event must not be parked; the outbox")
	s := statuses(ctx)
	ctx.Assert(len(s) > 0 && s[len(s)-1] == "delivered", "the next event must reach the topic, the statuses are %q", s)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "shipments/store.h"

using json = nlohmann::json;

namespace {

const std::string kTopic = "shipment.event";
const std::vector<std::string> kPrivate = {"Ada Lovelace", "12 Elm Street", "LS1 4AP"};

json scanOf(const std::string& status, long at, const std::string& city) {
  return json{{"status", status}, {"scan_at", at}, {"city", city}, {"carrier_ref", "1Z999AA1"},
              {"recipient", {{"name", "Ada Lovelace"}, {"street", "12 Elm Street"}, {"postcode", "LS1 4AP"}}}};
}

void ships(const std::vector<std::string>& ids) {
  for (const auto& id : ids) store::save(store::Shipment{id, "t-acme", "ord_" + id, "ups", "ground", "label", "", 0});
}

std::optional<json> record(harness::Ctx& ctx, const std::string& shipment_id, const json& scan) {
  try {
    return recordScan(shipment_id, "ups", scan);
  } catch (const std::exception& e) {
    ctx.Fatalf("recordScan(%s, %s) threw %s: %s", shipment_id, scan.value("status", ""), harness::CurrentExceptionType(), e.what());
  }
  return std::nullopt;
}

std::vector<std::string> statuses(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& r : ctx.Kafka.Records(kTopic)) out.push_back(json::parse(r.Value.value_or("{}")).value("status", ""));
  return out;
}

}  // namespace

void CheckShipmentKey(harness::Ctx& ctx) {
  ships({"shp_1", "shp_2"});
  record(ctx, "shp_1", scanOf("in_transit", 100, "Memphis"));
  record(ctx, "shp_2", scanOf("in_transit", 110, "Memphis"));
  record(ctx, "shp_1", scanOf("out_for_delivery", 200, "Leeds"));
  record(ctx, "shp_1", scanOf("delivered", 300, "Leeds"));
  ctx.Equal(ctx.Kafka.Keys(kTopic), {"shp_1", "shp_2", "shp_1", "shp_1"}, "key each event by its shipment id; the record keys");
  std::set<int> partitions;
  for (const auto& r : ctx.Kafka.Records(kTopic)) {
    if (r.Key.value_or("") == "shp_1") partitions.insert(r.Partition);
  }
  ctx.Equal(partitions.size(), 1, "one shipment's timeline must stay on one partition, in order; the partitions of shp_1's events");
}

void CheckNoAddress(harness::Ctx& ctx) {
  ships({"shp_1"});
  std::ostringstream lines;
  auto* err = std::cerr.rdbuf(lines.rdbuf());
  auto* clog = std::clog.rdbuf(lines.rdbuf());
  auto* out = std::cout.rdbuf(lines.rdbuf());
  const auto event = record(ctx, "shp_1", scanOf("out_for_delivery", 200, "Leeds"));
  std::cerr.rdbuf(err);
  std::clog.rdbuf(clog);
  std::cout.rdbuf(out);
  const auto records = ctx.Kafka.Records(kTopic);
  ctx.Equal(records.size(), 1, "one applied scan; the records on %s", kTopic);
  const std::string text = records[0].Value.value_or("");
  for (const auto& p : kPrivate) {
    ctx.Assert(text.find(p) == std::string::npos, "the event carries the recipient's %q: %s. The timeline needs the city, nothing finer", p, text);
    ctx.Assert(lines.str().find(p) == std::string::npos, "a log line carries the recipient's %q: %s", p, lines.str());
  }
  const json payload = json::parse(text);
  ctx.Assert(payload.value("scan_city", "") == "Leeds" && payload.value("carrier_ref", "") == "1Z999AA1" && payload.value("occurred_at", 0L) == 200,
             "the event must carry scan_city Leeds, carrier_ref and occurred_at 200, got %s", text);
  ctx.Assert(event && *event == payload, "recordScan must answer the event it produced (%s)", text);
}

void CheckPublishAfterCommit(harness::Ctx& ctx) {
  ships({"shp_1"});
  int at_commit = -1;
  ctx.Redis.After("shipment:shp_1", [&] { at_commit = static_cast<int>(ctx.Kafka.Records(kTopic).size()); });
  record(ctx, "shp_1", scanOf("out_for_delivery", 200, "Leeds"));
  ctx.Assert(at_commit >= 0, "recordScan never touched shipment:shp_1: the scan must go through timeline::applyScan");
  ctx.Equal(at_commit, 0, "when the state store saw the scan the topic already held records: apply first, produce after; records at the commit");
  ctx.Equal(ctx.Kafka.Records(kTopic).size(), 1, "one applied scan; the records");
  const auto dropped = record(ctx, "shp_1", scanOf("in_transit", 260, "Leeds"));
  ctx.Assert(!dropped, "a scan the state dropped (in_transit after out_for_delivery) must answer nothing, got %s", dropped ? dropped->dump() : "");
  ctx.Equal(statuses(ctx), {"out_for_delivery"}, "a scan the state dropped must not reach the timeline; the statuses on the topic");
}

void CheckDeliveryOutbox(harness::Ctx& ctx) {
  ships({"shp_1"});
  ctx.Kafka.FailNext(kTopic, 1);
  record(ctx, "shp_1", scanOf("out_for_delivery", 200, "Leeds"));
  const auto parked = ctx.Redis.LRange("outbox:shipment.event", 0, -1);
  ctx.Equal(parked.size(), 1, "the broker timed the event out: park it from the delivery report (dr_cb), produce's return code never sees it; the outbox");
  const json p = json::parse(parked[0]);
  ctx.Assert(p.value("shipment_id", "") == "shp_1" && p.value("status", "") == "out_for_delivery", "the parked event is %s, expected shp_1's out_for_delivery event", parked[0]);
  record(ctx, "shp_1", scanOf("delivered", 300, "Leeds"));
  ctx.Equal(ctx.Redis.LRange("outbox:shipment.event", 0, -1).size(), 1, "a delivered event must not be parked; the outbox");
  const auto s = statuses(ctx);
  ctx.Assert(!s.empty() && s.back() == "delivered", "the next event must reach the topic, the statuses are %q", s);
}
`,
  },
  debrief: `The state store is the source of truth and the topic reports it, so the scan is applied first and only an applied scan becomes an event; a dropped scan is already recorded as a rejected edge. Keying by shipment keeps one parcel's events in order on one partition, which is the only order the projector needs. The payload is cut to what a timeline shows: a city and a carrier reference, because the topic is retained and replicated by people who never see the order. Parking from the delivery report is what catches a broker that times the record out. What this step leaves open is the gap between the apply and the produce: a crash there loses the event. A production service writes the event into an outbox in the same Lua script as the status, and a relay produces it.`,
};
