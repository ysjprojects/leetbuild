import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Route events keyed by region, without anyone’s coordinates',
  concept: 'kafka',
  guides: ['producing-events'],
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'store'],
  task: `## Task

**Starting point.** The starter is the event the API produces once a route is computed:
\`publish_route_computed(route_id, region, origin, destination, route, latency_ms)\` produces one
\`route.computed\` record keyed by \`route_id\`, carrying \`route_id\`, \`region\`, the exact \`origin\` and
\`destination\`, \`latency_ms\` and \`degraded\`, and returns \`True\` once \`flush\` has served the
delivery report. Records reach the topic; it hides four flaws.

**Failure mode the checks target.** One region's events scatter across partitions, so the region
rollups read them out of order; a retained topic collects every user's exact trip endpoints; the
consumer cannot tell how long a route was or which traffic state it was solved for; and an event the
broker refuses is logged and gone.

- The record key is the \`region\`.
- The payload carries \`route_id\`, \`region\`, \`trip_cell\` (\`trip_cell(origin, destination)\`,
  provided in \`mapsd.geo\`: a hash of ~1 km cells), \`distance_m\`, \`epoch\`, \`latency_ms\` and
  \`degraded\`, and no coordinate.
- A refusal arrives in the delivery report (\`on_delivery\`; kafkajs: a rejected \`send\`; kafka-go: the
  error \`WriteMessages\` returns; librdkafka: \`dr_cb\`). Keep the event with
  \`routes.add_outbox(region, payload)\` (\`mapsd.routes\`) and return \`False\`.`,
  sequence: {
    participants: ['Maps API', 'route.computed', 'Route store', 'Telemetry consumer'],
    messages: [
      {
        from: 'Maps API',
        to: 'route.computed',
        label: 'produce · key = region · trip_cell, distance_m, epoch',
        kind: 'sync',
      },
      {from: 'route.computed', to: 'Maps API', label: 'delivery report: delivered / refused', kind: 'reply'},
      {from: 'Maps API', to: 'Route store', label: 'refused → add_outbox(region, payload)', kind: 'sync'},
      {from: 'route.computed', to: 'Telemetry consumer', label: 'one region per partition, in order', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'region-key',
      title: 'Keyed by region, so a region stays on one partition',
      detail:
        "The record key is the region, so one region's events land on one partition in order; the starter keys by `route_id`, which spreads a region over every partition.",
      match: {
        python: {all: [/key=region\b/], none: [/key=route_id/]},
        typescript: {all: [/key:\s*region\b/], none: [/key:\s*routeId/]},
        go: {all: [/Key:\s*\[\]byte\(region\)/], none: [/Key:\s*\[\]byte\(routeID\)/]},
        scala: {all: [/ProducerRecord\[String, String\]\(Topic,\s*region/], none: [/\(Topic,\s*routeId/]},
        cpp: {all: [/region\.c_str\(\),\s*region\.size\(\)/], none: [/route_id\.c_str\(\),\s*route_id\.size\(\)/]},
      },
    },
    {
      id: 'trip-cell',
      title: "The trip as a cell hash, never the user's coordinates",
      detail:
        'The payload carries `trip_cell(origin, destination)` and no coordinate: the topic is retained and replicated, so an exact endpoint written there outlives every retention rule the request had. The starter publishes both endpoints.',
      match: {
        python: {all: [/trip_cell\(origin, destination\)/], none: [/"origin":/, /"destination":/]},
        typescript: {all: [/tripCell\(origin, destination\)/], none: [/origin\.lat/, /destination\.lat/]},
        go: {all: [/geo\.TripCell\(origin, destination\)/], none: [/"origin":/, /"destination":/]},
        scala: {all: [/Geo\.tripCell\(origin, destination\)/], none: [/"origin"\s*->/, /"destination"\s*->/]},
        cpp: {all: [/geo::tripCell\(origin, destination\)/], none: [/\{"origin",/, /\{"destination",/]},
      },
    },
    {
      id: 'payload-fields',
      title: 'The event carries distance and traffic epoch',
      detail:
        "The payload carries the route's `distance_m` and `epoch`, so a consumer knows how long a route it is counting and which traffic state it was solved for; the starter drops both.",
      match: {
        python: {all: [/"distance_m":\s*route\["distance_m"\]/, /"epoch":\s*route\["epoch"\]/]},
        typescript: {all: [/distance_m:\s*route\.distance_m/, /epoch:\s*route\.epoch/]},
        go: {all: [/"distance_m":\s*route\.DistanceM/, /"epoch":\s*route\.Epoch/]},
        scala: {all: [/"distance_m"\s*->\s*JsNumber\(route\.distanceM\)/, /"epoch"\s*->\s*JsNumber\(route\.epoch\)/]},
        cpp: {all: [/\{"distance_m",\s*route\.distance_m\}/, /\{"epoch",\s*route\.epoch\}/]},
      },
    },
    {
      id: 'outbox',
      title: 'A refused event goes to the outbox',
      detail:
        'When the delivery report says the broker refused the record, the event is kept with `add_outbox(region, payload)` and the call returns false; the starter logs the refusal and reports success. A `try`/`except` around `produce` does not see a refusal: it arrives in the report.',
      match: {
        python: {
          all: [/add_outbox\(\s*region/, /return False/],
          order: [/producer\.flush\(/, /add_outbox\(/],
          none: [/except\s+KafkaException/],
        },
        typescript: {all: [/addOutbox\(\s*region/, /return false/], order: [/producer\.send\(/, /addOutbox\(/]},
        go: {
          all: [/routes\.AddOutbox\(ctx,\s*region/, /return false/],
          order: [/WriteMessages\(/, /routes\.AddOutbox\(/],
        },
        scala: {all: [/Routes\.addOutbox\(\s*region/, /onCompletion/]},
        cpp: {
          all: [/routes::addOutbox\(\s*region/, /return false/],
          order: [/producer->flush\(/, /routes::addOutbox\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import KafkaError, Message, Producer

TOPIC = "route.computed"
PRODUCE_TIMEOUT_S = 2.0

logger = logging.getLogger("route.events")
# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish_route_computed(route_id: str, region: str, origin, destination, route: dict, latency_ms: int) -> bool:
    """One route.computed event per computed route; False when the broker refused it."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payload = json.dumps(
        {
            "route_id": route_id,
            "region": region,
            "origin": {"lat": origin.lat, "lng": origin.lng},
            "destination": {"lat": destination.lat, "lng": destination.lng},
            "latency_ms": latency_ms,
            "degraded": route["degraded"],
        }
    )

    def on_delivery(err: KafkaError | None, msg: Message) -> None:
        if err is not None:
            logger.warning("route event %s not delivered: %s", route_id, err)

    producer.produce(TOPIC, key=route_id, value=payload, on_delivery=on_delivery)
    producer.flush(PRODUCE_TIMEOUT_S)  # the delivery report fires here, delivered or refused
    return True
`,
      solution: `import json
import logging

from confluent_kafka import KafkaError, Message, Producer

from mapsd import routes  # add_outbox
from mapsd.geo import trip_cell

TOPIC = "route.computed"
PRODUCE_TIMEOUT_S = 2.0

logger = logging.getLogger("route.events")
# Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})


def publish_route_computed(route_id: str, region: str, origin, destination, route: dict, latency_ms: int) -> bool:
    """One route.computed event per computed route; False when the broker refused it."""
    payload = json.dumps(
        {
            "route_id": route_id,
            "region": region,
            # Enough to group trips by area, not enough to say where anyone went.
            "trip_cell": trip_cell(origin, destination),
            "distance_m": route["distance_m"],
            "epoch": route["epoch"],
            "latency_ms": latency_ms,
            "degraded": route["degraded"],
        }
    )
    refused: list[KafkaError] = []

    def on_delivery(err: KafkaError | None, msg: Message) -> None:
        if err is not None:
            refused.append(err)

    # One region, one partition: the region rollups read its events in order.
    producer.produce(TOPIC, key=region, value=payload, on_delivery=on_delivery)
    producer.flush(PRODUCE_TIMEOUT_S)  # the delivery report fires here, delivered or refused
    if refused:
        routes.add_outbox(region, payload)
        logger.warning("route event %s refused (%s): kept in the outbox", route_id, refused[0])
        return False
    return True
`,
    },
    typescript: {
      starter: `import {Kafka} from 'kafkajs';

import type {Point, Route} from 'mapsd/geo';

export const TOPIC = 'route.computed';

const kafka = new Kafka({clientId: 'mapsd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the record once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One route.computed event per computed route; false when the broker refused it. */
export async function publishRouteComputed(
  routeId: string,
  region: string,
  origin: Point,
  destination: Point,
  route: Route,
  latencyMs: number,
): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const payload = JSON.stringify({
    route_id: routeId,
    region,
    origin: {lat: origin.lat, lng: origin.lng},
    destination: {lat: destination.lat, lng: destination.lng},
    latency_ms: latencyMs,
    degraded: route.degraded,
  });
  try {
    await producer.send({topic: TOPIC, messages: [{key: routeId, value: payload}], acks: -1});
  } catch (e) {
    console.warn(\`route event \${routeId} not delivered: \${e instanceof Error ? e.message : String(e)}\`);
  }
  return true;
}
`,
      solution: `import {Kafka} from 'kafkajs';

import {type Point, type Route, tripCell} from 'mapsd/geo';
import {addOutbox} from 'mapsd/routes';

export const TOPIC = 'route.computed';

const kafka = new Kafka({clientId: 'mapsd', brokers: ['kafka:9092']});
// Idempotent with acks all: a retry after a lost acknowledgement writes the record once, on every replica.
const producer = kafka.producer({idempotent: true});
void producer.connect();

/** One route.computed event per computed route; false when the broker refused it. */
export async function publishRouteComputed(
  routeId: string,
  region: string,
  origin: Point,
  destination: Point,
  route: Route,
  latencyMs: number,
): Promise<boolean> {
  const payload = JSON.stringify({
    route_id: routeId,
    region,
    // Enough to group trips by area, not enough to say where anyone went.
    trip_cell: tripCell(origin, destination),
    distance_m: route.distance_m,
    epoch: route.epoch,
    latency_ms: latencyMs,
    degraded: route.degraded,
  });
  try {
    // One region, one partition: the region rollups read its events in order.
    await producer.send({topic: TOPIC, messages: [{key: region, value: payload}], acks: -1});
    return true;
  } catch (e) {
    // A rejected send is the broker's delivery report: keep the event for the relay.
    await addOutbox(region, payload);
    console.warn(\`route event \${routeId} refused (\${e instanceof Error ? e.message : String(e)}): kept in the outbox\`);
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
	"log"
	"time"

	"github.com/segmentio/kafka-go"

	"mapsd/geo" // geo.Point, geo.Route
)

const topic = "route.computed"

// kafka-go has no idempotent producer: acks from every in-sync replica and a synchronous write are what it offers.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// publishRouteComputed produces one route.computed event per computed route; false when the broker refused it.
func publishRouteComputed(ctx context.Context, routeID, region string, origin, destination geo.Point, route geo.Route, latencyMs int64) bool {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	payload, _ := json.Marshal(map[string]any{
		"route_id":    routeID,
		"region":      region,
		"origin":      origin,
		"destination": destination,
		"latency_ms":  latencyMs,
		"degraded":    route.Degraded,
	})
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(routeID), Value: payload}); err != nil {
		log.Printf("route event %s not delivered: %v", routeID, err)
	}
	return true
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/segmentio/kafka-go"

	"mapsd/geo"    // geo.Point, geo.Route, geo.TripCell
	"mapsd/routes" // routes.AddOutbox(ctx, key, payload)
)

const topic = "route.computed"

// kafka-go has no idempotent producer: acks from every in-sync replica and a synchronous write are what it offers.
var writer = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        topic,
	Balancer:     &kafka.Hash{},
	RequiredAcks: kafka.RequireAll,
	BatchTimeout: 20 * time.Millisecond,
}

// publishRouteComputed produces one route.computed event per computed route; false when the broker refused it.
func publishRouteComputed(ctx context.Context, routeID, region string, origin, destination geo.Point, route geo.Route, latencyMs int64) bool {
	payload, _ := json.Marshal(map[string]any{
		"route_id": routeID,
		"region":   region,
		// Enough to group trips by area, not enough to say where anyone went.
		"trip_cell":  geo.TripCell(origin, destination),
		"distance_m": route.DistanceM,
		"epoch":      route.Epoch,
		"latency_ms": latencyMs,
		"degraded":   route.Degraded,
	})
	// One region, one partition: the region rollups read its events in order.
	if err := writer.WriteMessages(ctx, kafka.Message{Key: []byte(region), Value: payload}); err != nil {
		// The returned error is the broker's answer: keep the event for the relay.
		routes.AddOutbox(ctx, region, string(payload))
		log.Printf("route event %s refused (%v): kept in the outbox", routeID, err)
		return false
	}
	return true
}
`,
    },
    scala: {
      starter: `import java.util.Properties

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import mapsd.Geo // Geo.Point, Geo.Route

object RouteEvents {
  val Topic = "route.computed"

  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** One route.computed event per computed route; false when the broker refused it. */
  def publishRouteComputed(routeId: String, region: String, origin: Geo.Point, destination: Geo.Point, route: Geo.Route, latencyMs: Long): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val payload = JsObject(
      "route_id" -> JsString(routeId),
      "region" -> JsString(region),
      "origin" -> JsObject("lat" -> JsNumber(origin.lat), "lng" -> JsNumber(origin.lng)),
      "destination" -> JsObject("lat" -> JsNumber(destination.lat), "lng" -> JsNumber(destination.lng)),
      "latency_ms" -> JsNumber(latencyMs),
      "degraded" -> JsBoolean(route.degraded),
    ).compactPrint
    producer.send(
      new ProducerRecord[String, String](Topic, routeId, payload),
      new Callback {
        override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
          if (exception != null) System.err.println(s"route event $routeId not delivered: \${exception.getMessage}")
      },
    )
    producer.flush() // the callback has run once flush returns, delivered or refused
    true
  }
}
`,
      solution: `import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean

import org.apache.kafka.clients.producer.{Callback, KafkaProducer, ProducerRecord, RecordMetadata}
import org.apache.kafka.common.serialization.StringSerializer
import spray.json._

import mapsd.{Geo, Routes} // Geo.Point, Geo.Route, Geo.tripCell, Routes.addOutbox

object RouteEvents {
  val Topic = "route.computed"

  // Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
  private val props = new Properties()
  props.put("bootstrap.servers", "kafka:9092")
  props.put("enable.idempotence", "true")
  props.put("acks", "all")
  private val producer = new KafkaProducer[String, String](props, new StringSerializer, new StringSerializer)

  /** One route.computed event per computed route; false when the broker refused it. */
  def publishRouteComputed(routeId: String, region: String, origin: Geo.Point, destination: Geo.Point, route: Geo.Route, latencyMs: Long): Boolean = {
    val payload = JsObject(
      "route_id" -> JsString(routeId),
      "region" -> JsString(region),
      // Enough to group trips by area, not enough to say where anyone went.
      "trip_cell" -> JsString(Geo.tripCell(origin, destination)),
      "distance_m" -> JsNumber(route.distanceM),
      "epoch" -> JsNumber(route.epoch),
      "latency_ms" -> JsNumber(latencyMs),
      "degraded" -> JsBoolean(route.degraded),
    ).compactPrint
    val refused = new AtomicBoolean(false)
    // One region, one partition: the region rollups read its events in order.
    producer.send(
      new ProducerRecord[String, String](Topic, region, payload),
      new Callback {
        // The delivery report is the broker's answer: keep a refused event for the relay.
        override def onCompletion(metadata: RecordMetadata, exception: Exception): Unit =
          if (exception != null) {
            refused.set(true)
            Routes.addOutbox(region, payload)
          }
      },
    )
    producer.flush() // the callback has run once flush returns, delivered or refused
    !refused.get
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

#include "mapsd/geo.h"  // geo::Point, geo::Route

using json = nlohmann::json;

const std::string kTopic = "route.computed";
constexpr int kProduceTimeoutMs = 2000;

// The delivery report of the last produce: what the broker said once flush() served it.
class LastReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode err = RdKafka::ERR_NO_ERROR;
  std::string errstr;
  void dr_cb(RdKafka::Message& message) override {
    err = message.err();
    errstr = message.errstr();
  }
};

LastReport report;

// Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One route.computed event per computed route; false when the broker refused it.
bool publishRouteComputed(const std::string& route_id, const std::string& region, const geo::Point& origin, const geo::Point& destination,
                          const geo::Route& route, long long latency_ms) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string payload = json{{"route_id", route_id},
                                   {"region", region},
                                   {"origin", json{{"lat", origin.lat}, {"lng", origin.lng}}},
                                   {"destination", json{{"lat", destination.lat}, {"lng", destination.lng}}},
                                   {"latency_ms", latency_ms},
                                   {"degraded", route.degraded}}
                                  .dump();
  report.err = RdKafka::ERR_NO_ERROR;
  producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(),
                    route_id.c_str(), route_id.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);  // the delivery report fires here, delivered or refused
  if (report.err != RdKafka::ERR_NO_ERROR) std::cerr << "route event " << route_id << " not delivered: " << report.errstr << "\\n";
  return true;
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <memory>
#include <string>

#include "mapsd/geo.h"     // geo::Point, geo::Route, geo::tripCell
#include "mapsd/routes.h"  // routes::addOutbox(key, payload)

using json = nlohmann::json;

const std::string kTopic = "route.computed";
constexpr int kProduceTimeoutMs = 2000;

// The delivery report of the last produce: what the broker said once flush() served it.
class LastReport : public RdKafka::DeliveryReportCb {
 public:
  RdKafka::ErrorCode err = RdKafka::ERR_NO_ERROR;
  std::string errstr;
  void dr_cb(RdKafka::Message& message) override {
    err = message.err();
    errstr = message.errstr();
  }
};

LastReport report;

// Idempotent with acks=all: a retry after a lost acknowledgement writes the record once, on every replica.
std::unique_ptr<RdKafka::Producer> make_producer() {
  std::string err;
  auto conf = std::unique_ptr<RdKafka::Conf>(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  conf->set("dr_cb", &report, err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

auto producer = make_producer();

// One route.computed event per computed route; false when the broker refused it.
bool publishRouteComputed(const std::string& route_id, const std::string& region, const geo::Point& origin, const geo::Point& destination,
                          const geo::Route& route, long long latency_ms) {
  const std::string payload = json{{"route_id", route_id},
                                   {"region", region},
                                   // Enough to group trips by area, not enough to say where anyone went.
                                   {"trip_cell", geo::tripCell(origin, destination)},
                                   {"distance_m", route.distance_m},
                                   {"epoch", route.epoch},
                                   {"latency_ms", latency_ms},
                                   {"degraded", route.degraded}}
                                  .dump();
  report.err = RdKafka::ERR_NO_ERROR;
  // One region, one partition: the region rollups read its events in order.
  const RdKafka::ErrorCode queued = producer->produce(kTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()),
                                                     payload.size(), region.c_str(), region.size(), 0, nullptr);
  producer->flush(kProduceTimeoutMs);  // the delivery report fires here, delivered or refused
  if (queued != RdKafka::ERR_NO_ERROR || report.err != RdKafka::ERR_NO_ERROR) {
    routes::addOutbox(region, payload);
    std::cerr << "route event " << route_id << " refused (" << (queued != RdKafka::ERR_NO_ERROR ? RdKafka::err2str(queued) : report.errstr)
              << "): kept in the outbox\\n";
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import json

from mapsd.geo import Point, trip_cell
from mapsd.routes import OUTBOX_KEY

TOPIC = "route.computed"
SF = Point(37.77412, -122.41942)
OAKLAND = Point(37.80418, -122.27112)
BERKELEY = Point(37.87159, -122.27275)
MANHATTAN = Point(40.71277, -74.00597)
BROOKLYN = Point(40.67818, -73.94416)
ROUTE = {"distance_m": 18842.5, "duration_s": 1713.0, "geometry": "poly:2", "epoch": 5871200, "engine_version": "osrm-v26.9", "degraded": False}


def _payload(record):
    try:
        return json.loads(record.value)
    except Exception as exc:
        raise AssertionError(f"the record's value is not JSON: {record.value!r} ({exc})")


def check_region_key(ctx):
    m = ctx.load("events")
    for route_id, (origin, destination) in (("r-1", (SF, OAKLAND)), ("r-2", (OAKLAND, BERKELEY)), ("r-3", (BERKELEY, SF))):
        assert m.publish_route_computed(route_id, "us-west", origin, destination, ROUTE, 40) is True, f"publishing {route_id} must return True"
    m.publish_route_computed("r-4", "us-east", MANHATTAN, BROOKLYN, ROUTE, 40)
    records = ctx.kafka.records(TOPIC)
    keys = [r.key for r in records]
    assert keys == [b"us-west"] * 3 + [b"us-east"], f"records must be keyed by region, got {keys}: keyed by anything else, one region's events scatter across partitions"
    partitions = {r.partition for r in records[:3]}
    assert len(partitions) == 1, f"us-west's events landed on partitions {sorted(partitions)}: one region must stay on one partition, in order"


def check_trip_cell(ctx):
    m = ctx.load("events")
    m.publish_route_computed("r-1", "us-west", SF, OAKLAND, ROUTE, 40)
    record = ctx.kafka.records(TOPIC)[0]
    payload = _payload(record)
    text = record.value.decode()
    for name in ("origin", "destination"):
        assert name not in payload, f"the event carries the trip's {name}: {text}. The topic is retained and replicated; carry trip_cell instead"
    for coordinate in ("37.77412", "-122.41942", "37.80418", "-122.27112"):
        assert coordinate not in text, f"the event carries an exact coordinate ({coordinate}): {text}"
    assert payload.get("trip_cell") == trip_cell(SF, OAKLAND), f"trip_cell must be trip_cell(origin, destination) = {trip_cell(SF, OAKLAND)}, got {payload.get('trip_cell')!r}"


def check_payload_fields(ctx):
    m = ctx.load("events")
    m.publish_route_computed("r-1", "us-west", SF, OAKLAND, ROUTE, 40)
    payload = _payload(ctx.kafka.records(TOPIC)[0])
    expected = {"route_id": "r-1", "region": "us-west", "distance_m": 18842.5, "epoch": 5871200, "latency_ms": 40, "degraded": False}
    for name, value in expected.items():
        assert payload.get(name) == value, f"the event's {name} is {payload.get(name)!r}, expected {value!r} (event: {payload})"


def check_outbox(ctx):
    m = ctx.load("events")
    ctx.kafka.fail_next(TOPIC, 1)
    ok = m.publish_route_computed("r-1", "us-west", SF, OAKLAND, ROUTE, 40)
    assert ok is False, "the broker refused the event (an error in the delivery report), but publish_route_computed returned True"
    rows = ctx.redis.lrange(OUTBOX_KEY, 0, -1)
    assert len(rows) == 1, f"after the broker refused the event {OUTBOX_KEY} holds {rows}, expected one row: without it the event is gone"
    row = json.loads(rows[0])
    assert row.get("key") == "us-west", f"the outbox row must carry the record key us-west, got {row}"
    assert json.loads(row.get("payload", "{}")).get("route_id") == "r-1", f"the outbox row must carry the event's payload, got {row}"
    assert m.publish_route_computed("r-2", "us-west", OAKLAND, BERKELEY, ROUTE, 40) is True, "a delivered event must return True"
    assert ctx.redis.llen(OUTBOX_KEY) == 1, "a delivered event must not be written to the outbox"
`,
    typescript: `const TOPIC = 'route.computed';
const SF = {lat: 37.77412, lng: -122.41942};
const OAKLAND = {lat: 37.80418, lng: -122.27112};
const BERKELEY = {lat: 37.87159, lng: -122.27275};
const MANHATTAN = {lat: 40.71277, lng: -74.00597};
const BROOKLYN = {lat: 40.67818, lng: -73.94416};
const ROUTE = {distance_m: 18842.5, duration_s: 1713.0, geometry: 'poly:2', epoch: 5871200, engine_version: 'osrm-v26.9', degraded: false};

function events(ctx) {
  return {m: ctx.load('events'), geo: ctx.load('/support/mapsd/geo.ts'), routes: ctx.load('/support/mapsd/routes.ts')};
}

function payload(record) {
  try {
    return JSON.parse(record.value.toString());
  } catch (e) {
    assert.fail(\`the record's value is not JSON: \${record.value} (\${e})\`);
  }
}

export async function check_region_key(ctx) {
  const {m} = events(ctx);
  const trips: [string, object, object][] = [['r-1', SF, OAKLAND], ['r-2', OAKLAND, BERKELEY], ['r-3', BERKELEY, SF]];
  for (const [routeId, origin, destination] of trips) {
    assert.equal(await m.publishRouteComputed(routeId, 'us-west', origin, destination, ROUTE, 40), true, \`publishing \${routeId} must return true\`);
  }
  await m.publishRouteComputed('r-4', 'us-east', MANHATTAN, BROOKLYN, ROUTE, 40);
  const records = ctx.kafka.records(TOPIC);
  const keys = records.map(r => r.key?.toString() ?? null);
  assert.deepStrictEqual(keys, ['us-west', 'us-west', 'us-west', 'us-east'], \`records must be keyed by region, got \${JSON.stringify(keys)}: keyed by anything else, one region's events scatter across partitions\`);
  const partitions = [...new Set(records.slice(0, 3).map(r => r.partition))];
  assert.equal(partitions.length, 1, \`us-west's events landed on partitions \${JSON.stringify(partitions)}: one region must stay on one partition, in order\`);
}

export async function check_trip_cell(ctx) {
  const {m, geo} = events(ctx);
  await m.publishRouteComputed('r-1', 'us-west', SF, OAKLAND, ROUTE, 40);
  const record = ctx.kafka.records(TOPIC)[0];
  const p = payload(record);
  const text = record.value.toString();
  for (const name of ['origin', 'destination']) {
    assert(!(name in p), \`the event carries the trip's \${name}: \${text}. The topic is retained and replicated; carry trip_cell instead\`);
  }
  for (const coordinate of ['37.77412', '-122.41942', '37.80418', '-122.27112']) {
    assert(!text.includes(coordinate), \`the event carries an exact coordinate (\${coordinate}): \${text}\`);
  }
  const expected = geo.tripCell(SF, OAKLAND);
  assert.equal(p.trip_cell, expected, \`trip_cell must be tripCell(origin, destination) = \${expected}, got \${JSON.stringify(p.trip_cell)}\`);
}

export async function check_payload_fields(ctx) {
  const {m} = events(ctx);
  await m.publishRouteComputed('r-1', 'us-west', SF, OAKLAND, ROUTE, 40);
  const p = payload(ctx.kafka.records(TOPIC)[0]);
  const expected = {route_id: 'r-1', region: 'us-west', distance_m: 18842.5, epoch: 5871200, latency_ms: 40, degraded: false};
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(p[name], value, \`the event's \${name} is \${JSON.stringify(p[name])}, expected \${JSON.stringify(value)} (event: \${JSON.stringify(p)})\`);
  }
}

export async function check_outbox(ctx) {
  const {m, routes} = events(ctx);
  ctx.kafka.failNext(TOPIC, 1);
  const ok = await m.publishRouteComputed('r-1', 'us-west', SF, OAKLAND, ROUTE, 40);
  assert.equal(ok, false, 'the broker refused the event (a rejected send), but publishRouteComputed returned true');
  const rows = ctx.redis.lrange(routes.OUTBOX_KEY, 0, -1);
  assert.equal(rows.length, 1, \`after the broker refused the event \${routes.OUTBOX_KEY} holds \${JSON.stringify(rows)}, expected one row: without it the event is gone\`);
  const row = JSON.parse(rows[0]);
  assert.equal(row.key, 'us-west', \`the outbox row must carry the record key us-west, got \${rows[0]}\`);
  assert.equal(JSON.parse(row.payload ?? '{}').route_id, 'r-1', \`the outbox row must carry the event's payload, got \${rows[0]}\`);
  assert.equal(await m.publishRouteComputed('r-2', 'us-west', OAKLAND, BERKELEY, ROUTE, 40), true, 'a delivered event must return true');
  assert.equal(ctx.redis.llen(routes.OUTBOX_KEY), 1, 'a delivered event must not be written to the outbox');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"

	"mapsd/geo"
	"mapsd/routes"

	"leetbuild/harness"
)

const eventsTopic = "route.computed"

var (
	eventsBg  = context.Background()
	sf        = geo.Point{Lat: 37.77412, Lng: -122.41942}
	oakland   = geo.Point{Lat: 37.80418, Lng: -122.27112}
	berkeley  = geo.Point{Lat: 37.87159, Lng: -122.27275}
	manhattan = geo.Point{Lat: 40.71277, Lng: -74.00597}
	brooklyn  = geo.Point{Lat: 40.67818, Lng: -73.94416}
	route     = geo.Route{DistanceM: 18842.5, DurationS: 1713.0, Geometry: "poly:2", Epoch: 5871200, EngineVersion: "osrm-v26.9"}
)

func payloadOf(ctx *harness.Ctx, value []byte) map[string]any {
	var p map[string]any
	ctx.Assert(json.Unmarshal(value, &p) == nil, "the record's value is not JSON: %s", value)
	return p
}

func CheckRegionKey(ctx *harness.Ctx) {
	ctx.Assert(publishRouteComputed(eventsBg, "r-1", "us-west", sf, oakland, route, 40), "publishing r-1 must return true")
	ctx.Assert(publishRouteComputed(eventsBg, "r-2", "us-west", oakland, berkeley, route, 40), "publishing r-2 must return true")
	ctx.Assert(publishRouteComputed(eventsBg, "r-3", "us-west", berkeley, sf, route, 40), "publishing r-3 must return true")
	publishRouteComputed(eventsBg, "r-4", "us-east", manhattan, brooklyn, route, 40)
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(ctx.Kafka.Keys(eventsTopic), []string{"us-west", "us-west", "us-west", "us-east"}, "records must be keyed by region (keyed by anything else, one region's events scatter across partitions)")
	ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition, "us-west's events landed on partitions %d, %d, %d: one region must stay on one partition, in order", records[0].Partition, records[1].Partition, records[2].Partition)
}

func CheckTripCell(ctx *harness.Ctx) {
	publishRouteComputed(eventsBg, "r-1", "us-west", sf, oakland, route, 40)
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one published event, the records on %s", eventsTopic)
	text := string(records[0].Value)
	p := payloadOf(ctx, records[0].Value)
	for _, name := range []string{"origin", "destination"} {
		_, present := p[name]
		ctx.Assert(!present, "the event carries the trip's %s: %s. The topic is retained and replicated; carry trip_cell instead", name, text)
	}
	for _, coordinate := range []string{"37.77412", "-122.41942", "37.80418", "-122.27112"} {
		ctx.Assert(!strings.Contains(text, coordinate), "the event carries an exact coordinate (%s): %s", coordinate, text)
	}
	ctx.Equal(p["trip_cell"], geo.TripCell(sf, oakland), "trip_cell must be geo.TripCell(origin, destination)")
}

func CheckPayloadFields(ctx *harness.Ctx) {
	publishRouteComputed(eventsBg, "r-1", "us-west", sf, oakland, route, 40)
	records := ctx.Kafka.Records(eventsTopic)
	ctx.Equal(len(records), 1, "one published event, the records on %s", eventsTopic)
	p := payloadOf(ctx, records[0].Value)
	expected := map[string]any{"route_id": "r-1", "region": "us-west", "distance_m": 18842.5, "epoch": 5871200.0, "latency_ms": 40.0, "degraded": false}
	for name, value := range expected {
		ctx.Equal(p[name], value, "the event's %s (event: %v)", name, p)
	}
}

func CheckOutbox(ctx *harness.Ctx) {
	ctx.Kafka.FailNext(eventsTopic, 1)
	ok := publishRouteComputed(eventsBg, "r-1", "us-west", sf, oakland, route, 40)
	ctx.Assert(!ok, "the broker refused the event (WriteMessages returned an error), but publishRouteComputed returned true")
	rows := ctx.Redis.LRange(routes.OutboxKey, 0, -1)
	ctx.Equal(len(rows), 1, "after the broker refused the event, the rows in %s (without one the event is gone)", routes.OutboxKey)
	var row map[string]string
	ctx.Assert(json.Unmarshal([]byte(rows[0]), &row) == nil, "the outbox row is not JSON: %s", rows[0])
	ctx.Equal(row["key"], "us-west", "the outbox row's record key")
	ctx.Equal(payloadOf(ctx, []byte(row["payload"]))["route_id"], "r-1", "the outbox row must carry the event's payload; its route_id")
	ctx.Assert(publishRouteComputed(eventsBg, "r-2", "us-west", oakland, berkeley, route, 40), "a delivered event must return true")
	ctx.Equal(ctx.Redis.LLen(routes.OutboxKey), int64(1), "a delivered event must not be written to the outbox; the rows")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "mapsd/geo.h"
#include "mapsd/routes.h"

using json = nlohmann::json;

namespace {

const std::string kEventsTopic = "route.computed";
const geo::Point kSf{37.77412, -122.41942};
const geo::Point kOakland{37.80418, -122.27112};
const geo::Point kBerkeley{37.87159, -122.27275};
const geo::Point kManhattan{40.71277, -74.00597};
const geo::Point kBrooklyn{40.67818, -73.94416};

geo::Route route() {
  geo::Route r;
  r.distance_m = 18842.5;
  r.duration_s = 1713.0;
  r.geometry = "poly:2";
  r.epoch = 5871200;
  r.engine_version = "osrm-v26.9";
  return r;
}

json payloadOf(harness::Ctx& ctx, const std::string& text) {
  try {
    return json::parse(text);
  } catch (const std::exception& e) {
    ctx.Fatalf("the record's value is not JSON: %s (%s)", text, e.what());
  }
}

}  // namespace

void CheckRegionKey(harness::Ctx& ctx) {
  ctx.Assert(publishRouteComputed("r-1", "us-west", kSf, kOakland, route(), 40), "publishing r-1 must return true");
  ctx.Assert(publishRouteComputed("r-2", "us-west", kOakland, kBerkeley, route(), 40), "publishing r-2 must return true");
  ctx.Assert(publishRouteComputed("r-3", "us-west", kBerkeley, kSf, route(), 40), "publishing r-3 must return true");
  publishRouteComputed("r-4", "us-east", kManhattan, kBrooklyn, route(), 40);
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(ctx.Kafka.Keys(kEventsTopic), {"us-west", "us-west", "us-west", "us-east"}, "records must be keyed by region (keyed by anything else, one region's events scatter across partitions)");
  ctx.Assert(records[0].Partition == records[1].Partition && records[1].Partition == records[2].Partition,
             "us-west's events landed on partitions %d, %d, %d: one region must stay on one partition, in order", records[0].Partition, records[1].Partition,
             records[2].Partition);
}

void CheckTripCell(harness::Ctx& ctx) {
  publishRouteComputed("r-1", "us-west", kSf, kOakland, route(), 40);
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 1, "one published event, the records on %s", kEventsTopic);
  const std::string text = records[0].Value.value_or("");
  const json p = payloadOf(ctx, text);
  for (const std::string name : {"origin", "destination"}) {
    ctx.Assert(!p.contains(name), "the event carries the trip's %s: %s. The topic is retained and replicated; carry trip_cell instead", name, text);
  }
  for (const std::string coordinate : {"37.77412", "-122.41942", "37.80418", "-122.27112"}) {
    ctx.Assert(text.find(coordinate) == std::string::npos, "the event carries an exact coordinate (%s): %s", coordinate, text);
  }
  ctx.Equal(p.value("trip_cell", ""), geo::tripCell(kSf, kOakland), "trip_cell must be geo::tripCell(origin, destination)");
}

void CheckPayloadFields(harness::Ctx& ctx) {
  publishRouteComputed("r-1", "us-west", kSf, kOakland, route(), 40);
  const auto records = ctx.Kafka.Records(kEventsTopic);
  ctx.Equal(records.size(), 1, "one published event, the records on %s", kEventsTopic);
  const json p = payloadOf(ctx, records[0].Value.value_or(""));
  ctx.Equal(p.value("route_id", ""), "r-1", "the event's route_id (event: %s)", p.dump());
  ctx.Equal(p.value("region", ""), "us-west", "the event's region (event: %s)", p.dump());
  ctx.Equal(p.value("distance_m", 0.0), 18842.5, "the event's distance_m (event: %s)", p.dump());
  ctx.Equal(p.value("epoch", 0LL), 5871200LL, "the event's epoch (event: %s)", p.dump());
  ctx.Equal(p.value("latency_ms", 0LL), 40LL, "the event's latency_ms (event: %s)", p.dump());
  ctx.Assert(p.contains("degraded") && p["degraded"] == false, "the event's degraded must be false (event: %s)", p.dump());
}

void CheckOutbox(harness::Ctx& ctx) {
  ctx.Kafka.FailNext(kEventsTopic, 1);
  const bool ok = publishRouteComputed("r-1", "us-west", kSf, kOakland, route(), 40);
  ctx.Assert(!ok, "the broker refused the event (an error in the delivery report), but publishRouteComputed returned true");
  const auto rows = ctx.Redis.LRange(routes::kOutboxKey, 0, -1);
  ctx.Equal(rows.size(), 1, "after the broker refused the event, the rows in %s (without one the event is gone)", routes::kOutboxKey);
  const json row = payloadOf(ctx, rows[0]);
  ctx.Equal(row.value("key", ""), "us-west", "the outbox row's record key");
  ctx.Equal(payloadOf(ctx, row.value("payload", "{}")).value("route_id", ""), "r-1", "the outbox row must carry the event's payload; its route_id");
  ctx.Assert(publishRouteComputed("r-2", "us-west", kOakland, kBerkeley, route(), 40), "a delivered event must return true");
  ctx.Equal(ctx.Redis.LLen(routes::kOutboxKey), 1, "a delivered event must not be written to the outbox; the rows");
}
`,
  },
  hints: [
    "Publish three us-west routes and look at the partitions: they sit on three different ones. Read one record: it holds the user's exact origin and destination, but not the route's distance or traffic epoch. Refuse a delivery and the outbox stays empty.",
    'The key is `route_id`, which differs on every record, so the partitioner spreads one region everywhere. The payload is built from the request points, not the route. `on_delivery` only logs, and the function returns `True` whatever the report said.',
    'Produce with `key=region`; replace `origin` and `destination` with `"trip_cell": trip_cell(origin, destination)`; add `"distance_m"` and `"epoch"` from `route`; collect the error in `on_delivery`, and after `flush` call `routes.add_outbox(region, payload)` and return `False`.',
  ],
  debrief: `The key decides the partition and the partition decides the order, so a region rollup that needs its region in order needs the region as the key. The payload is what a retained, replicated topic will hold for days, which is why the trip travels as a hash of ~1 km cells: enough to group trips by area, too coarse to say where someone lives. Distance and epoch are what make a count meaningful. A refusal only exists in the delivery report, so that is where the outbox row is written; a \`try\` around \`produce\` sees a full local queue and nothing else. Production systems write the outbox row in the same transaction as the route and let a relay produce from it, so a crash between the two cannot lose the event either.`,
};
