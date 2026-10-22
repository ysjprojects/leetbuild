import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Route events keyed by region with no user positions',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka', 'consumer', 'store'],
  task: `## Task

The starter is a plausible model-generated draft: it produces an event on the happy path and the
payload names the user, so the demo shows telemetry flowing. Three production contracts are
broken. Find them, fix them, and prove the fix.

The publisher is what the map service calls once a route is computed, and it feeds
\`route.computed\`, the topic every region's telemetry pipeline reads from.

- Key the record by **map region**, not by the user: \`route.computed\` is partitioned so one
  region's routes arrive in order. Keyed by the user id, one region's events scatter across
  partitions and the ordering guarantee is gone.
- The event may carry the geography only as a **coordinate-cell hash**: round each endpoint to a
  ~1 km cell (two decimal places) and hash the cell into \`route_cell\`. Exact endpoints must not
  appear in the payload or in any log line — the topic is retained and replicated, and an
  origin/destination pair is where someone lives.
- The event carries what downstream needs to trust it: \`latency_ms\`, \`distance_m\` and the
  traffic \`epoch\` of the route it describes.
- When the broker rejects the produce, write the event to the **outbox** —
  \`store.insert_outbox(region, event)\` / \`store.insertOutbox(region, event)\` /
  \`store.InsertOutbox(ctx, region, event)\` — instead of dropping it; a relay republishes outbox
  rows when the broker recovers.

**Failure mode the checks target.** Keyed by the user, one region's telemetry loses its ordering;
a payload that names the exact endpoints of a trip is a location history with days of retention;
without \`epoch\` and \`distance_m\` a consumer cannot tell which traffic state, or how long a route,
it is counting; and a rejected produce with no outbox row loses the event with no way back.`,
  sequence: {
    participants: ['Route service', 'route.computed', 'Telemetry consumer', 'Route store', 'Outbox relay'],
    messages: [
      {
        from: 'Route service',
        to: 'route.computed',
        label: 'produce · key = region · route_cell, no endpoints',
        kind: 'sync',
      },
      {from: 'route.computed', to: 'Route service', label: 'ack / broker rejection', kind: 'reply'},
      {from: 'Route service', to: 'Route store', label: 'insert_outbox(region, event) on rejection', kind: 'sync'},
      {
        from: 'Outbox relay',
        to: 'route.computed',
        label: 'republish outbox rows once the broker recovers',
        kind: 'async',
      },
      {
        from: 'route.computed',
        to: 'Telemetry consumer',
        label: 'consume · one region per partition, in order',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The message key is the partition key: `key=route["region"]` (or `Key: []byte(route.Region)`, `ProducerRecord("route.computed", route.region, …)`). Keyed by the user id, one region’s events land in different partitions and their order is no longer guaranteed.',
    'Coarsen before you hash: round each coordinate to two decimals (~1 km) — `round(lat, 2)`, `Math.round(lat * 100) / 100`, `math.Round(lat*100) / 100`, `math.round(lat * 100) / 100`, `std::round(lat * 100) / 100` — then hash the cell and publish `route_cell`. The raw `origin`/`destination` never reach the payload or a log line.',
    'The outbox is the durability half: wrap the produce and, when the broker rejects it, write a row — `store.insert_outbox(region, event)`, `store.insertOutbox`, `store.InsertOutbox` — that a relay republishes. Keep `epoch` and `distance_m` in the payload next to `latency_ms`: without them the consumer cannot tell a rush-hour route from a midnight one.',
  ],
  checks: [
    {
      id: 'region-key',
      title: 'Keyed by region, not the user',
      detail:
        'The record key is the map region and the event carries it, so one region’s telemetry stays ordered inside one partition. The draft keys by the user id, which scatters a region’s events and loses the ordering guarantee.',
      match: {
        python: {all: [/key=route\["region"\]/, /"region"\s*:\s*route\["region"\]/]},
        typescript: {all: [/key:\s*route\.region\b/, /region:\s*route\.region\b/]},
        go: {all: [/Key:\s*\[\]byte\(route\.Region\)/, /"region":\s*route\.Region/]},
        scala: {all: [/ProducerRecord\("route\.computed",\s*route\.region/, /"region"\s*->\s*route\.region/]},
        cpp: {all: [/produce\([^;\n]*route\.region/, /"region",\s*route\.region/]},
      },
    },
    {
      id: 'cell-hash',
      title: 'Coordinate cell hash: rounded, then hashed',
      detail:
        'Exact endpoints are rounded to a ~1 km cell (two decimals) and only the hash of that cell — `route_cell` — is published. The draft ships the raw origin and destination instead.',
      match: {
        python: {all: [/def cell_hash\(/, /round\(/, /"route_cell"\s*:\s*cell_hash\(/]},
        typescript: {all: [/cellHash\(route\.origin/, /Math\.round\(/, /route_cell:\s*cell/]},
        go: {all: [/func CellHash\(/, /math\.Round\(/, /"route_cell":\s*CellHash\(/]},
        scala: {all: [/def cellHash\(/, /math\.round\(/, /"route_cell"\s*->\s*cellHash\(/]},
        cpp: {all: [/std::string cellHash\(/, /std::round\(/, /"route_cell",\s*cell/]},
      },
    },
    {
      id: 'no-exact-points',
      title: 'No exact endpoints in the payload or the logs',
      detail:
        'Neither the event payload nor any log line contains the exact origin or destination — only the coarse cell. The draft prints and publishes both, and the topic is retained and replicated, so those points outlive every retention policy the request pipeline has.',
      match: {
        python: {
          none: [
            /["']origin["']\s*:/,
            /["']destination["']\s*:/,
            /logger\.[A-Za-z_]+\([^\n]*\b(?:origin|destination)\b/,
          ],
        },
        typescript: {
          none: [
            /\borigin:\s*route\.origin\b/,
            /\bdestination:\s*route\.destination\b/,
            /console\.[A-Za-z_]+\([^\n]*\b(?:origin|destination)\b/,
          ],
        },
        go: {
          none: [
            /"origin":\s*route\.Origin/,
            /"destination":\s*route\.Destination/,
            /log\.(?:Printf|Println|Print)\([^\n]*\b(?:origin|destination)\b/,
          ],
        },
        scala: {none: [/"origin"\s*->/, /"destination"\s*->/, /log\.[A-Za-z_]+\([^\n]*\b(?:origin|destination)\b/]},
        cpp: {
          none: [/"origin",\s*/, /"destination",\s*/, /std::(?:cerr|cout)[^\n]*\b(?:origin|destination)\b/],
        },
      },
    },
    {
      id: 'payload-fields',
      title: 'Latency, distance and epoch ride the event',
      detail:
        'The event carries the route’s `latency_ms`, `distance_m` and traffic `epoch`, so consumers know what traffic state and how long a route they are counting. The draft drops the epoch and the distance.',
      match: {
        python: {
          all: [
            /"epoch"\s*:\s*route\["epoch"\]/,
            /"distance_m"\s*:\s*route\["distance_m"\]/,
            /"latency_ms"\s*:\s*route\["latency_ms"\]/,
          ],
        },
        typescript: {
          all: [
            /\bepoch:\s*route\.epoch\b/,
            /\bdistance_m:\s*route\.distance_m\b/,
            /\blatency_ms:\s*route\.latency_ms\b/,
          ],
        },
        go: {
          all: [/"epoch":\s*route\.Epoch/, /"distance_m":\s*route\.DistanceM/, /"latency_ms":\s*route\.LatencyMS/],
        },
        scala: {
          all: [
            /"epoch"\s*->\s*route\.epoch/,
            /"distance_m"\s*->\s*route\.distanceM/,
            /"latency_ms"\s*->\s*route\.latencyMs/,
          ],
        },
        cpp: {
          all: [/"epoch",\s*route\.epoch/, /"distance_m",\s*route\.distance_m/, /"latency_ms",\s*route\.latency_ms/],
        },
      },
    },
    {
      id: 'outbox-rejected',
      title: 'A rejected produce becomes an outbox row',
      detail:
        'A broker rejection writes an outbox row (`insert_outbox`/`insertOutbox`/`InsertOutbox`) instead of dropping the event; a relay republishes it when the broker recovers. The draft ignores the produce result entirely.',
      match: {
        python: {all: [/store\.insert_outbox\(/, /except\s+(KafkaException|Exception)/]},
        typescript: {all: [/store\.insertOutbox\(/, /catch\s*[({]/]},
        go: {all: [/store\.InsertOutbox\(/, /err != nil/]},
        scala: {all: [/insertOutbox\(/, /catch\s*\{/]},
        cpp: {all: [/store\.insertOutbox\(/, /ERR_NO_ERROR/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from confluent_kafka import Producer

logger = logging.getLogger("route.events")

producer = Producer({"bootstrap.servers": "kafka:9092"})


class OutboxStore:
    def insert_outbox(self, region: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


# TODO: key by the map region and not the user, publish the coarse coordinate-cell hash instead of
# the exact endpoints, carry the epoch and the distance, and write an outbox row when the broker
# rejects the produce.
def publish_route(route: dict) -> None:
    logger.info("route id=%s user=%s origin=%s destination=%s", route["id"], route["user_id"], route["origin"], route["destination"])
    payload = {
        "id": route["id"],
        "user_id": route["user_id"],
        "origin": route["origin"],
        "destination": route["destination"],
        "latency_ms": route["latency_ms"],
    }
    producer.produce("route.computed", key=route["user_id"], value=json.dumps(payload))
    producer.flush()
`,
      solution: `import hashlib
import json

from confluent_kafka import KafkaException, Producer

producer = Producer(
    {
        "bootstrap.servers": "kafka:9092",
        "enable.idempotence": True,
        "acks": "all",
    }
)


class OutboxStore:
    def insert_outbox(self, region: str, event: dict) -> None:
        """One row per undelivered event; a relay republishes it."""
        raise NotImplementedError


store = OutboxStore()


def cell_hash(origin: tuple[float, float], destination: tuple[float, float]) -> str:
    """Round both endpoints to a ~1 km cell and hash the cell, never the point."""
    cell = f"{round(origin[0], 2)},{round(origin[1], 2)};{round(destination[0], 2)},{round(destination[1], 2)}"
    return hashlib.sha1(cell.encode()).hexdigest()[:16]


def publish_route(route: dict) -> None:
    event = {
        "id": route["id"],
        "region": route["region"],
        "route_cell": cell_hash(route["origin"], route["destination"]),
        "mode": route["mode"],
        "distance_m": route["distance_m"],
        "latency_ms": route["latency_ms"],
        "epoch": route["epoch"],
        "degraded": route["degraded"],
    }
    try:
        producer.produce("route.computed", key=route["region"], value=json.dumps(event))
        producer.flush(2.0)
    except KafkaException:
        store.insert_outbox(route["region"], event)
`,
    },
    typescript: {
      starter: `/** route.computed: a model-generated draft that keys by user and ships raw coordinates. */
import {Kafka} from 'kafkajs';

export const kafka = new Kafka({clientId: 'maps-routing', brokers: ['kafka:9092']});
const producer = kafka.producer();
void producer.connect();

export interface ComputedRoute {
  id: string;
  region: string;
  user_id: string;
  origin: [number, number];
  destination: [number, number];
  mode: 'drive' | 'walk' | 'cycle';
  distance_m: number;
  latency_ms: number;
  epoch: number;
  degraded: boolean;
}

// TODO: key by route.region instead of route.user_id, publish the coarse coordinate-cell hash
// instead of the exact endpoints, carry the epoch and the distance, and write an outbox row when
// the broker rejects the produce.
export async function publishRoute(route: ComputedRoute): Promise<void> {
  const event = {
    id: route.id,
    user_id: route.user_id,
    origin: route.origin,
    destination: route.destination,
    latency_ms: route.latency_ms,
  };
  console.log('route id=%s user=%s origin=%s destination=%s', route.id, route.user_id, route.origin, route.destination);
  await producer.send({
    topic: 'route.computed',
    messages: [{key: route.user_id, value: JSON.stringify(event)}],
  });
}
`,
      solution: `/** route.computed: one region-keyed event per computed route — cells, not positions. */
import {createHash} from 'node:crypto';

import {Kafka} from 'kafkajs';

import {store} from './store';

export const kafka = new Kafka({clientId: 'maps-routing', brokers: ['kafka:9092']});
const producer = kafka.producer({idempotent: true, maxInFlightRequests: 1});
void producer.connect();

export interface ComputedRoute {
  id: string;
  region: string;
  user_id: string;
  origin: [number, number];
  destination: [number, number];
  mode: 'drive' | 'walk' | 'cycle';
  distance_m: number;
  latency_ms: number;
  epoch: number;
  degraded: boolean;
}

function cellHash(origin: [number, number], destination: [number, number]): string {
  const round = (value: number): number => Math.round(value * 100) / 100;
  const cell = \`\${round(origin[0])},\${round(origin[1])};\${round(destination[0])},\${round(destination[1])}\`;
  return createHash('sha1').update(cell).digest('hex').slice(0, 16);
}

export async function publishRoute(route: ComputedRoute): Promise<void> {
  const cell = cellHash(route.origin, route.destination);
  const event = {
    id: route.id,
    region: route.region,
    route_cell: cell,
    mode: route.mode,
    distance_m: route.distance_m,
    latency_ms: route.latency_ms,
    epoch: route.epoch,
    degraded: route.degraded,
  };
  try {
    await producer.send({
      topic: 'route.computed',
      acks: -1,
      messages: [{key: route.region, value: JSON.stringify(event)}],
    });
  } catch {
    await store.insertOutbox(route.region, event);
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

	"github.com/segmentio/kafka-go"
)

var events = &kafka.Writer{Addr: kafka.TCP("kafka:9092"), Topic: "route.computed"}

type ComputedRoute struct {
	ID          string     \`json:"id"\`
	Region      string     \`json:"region"\`
	UserID      string     \`json:"user_id"\`
	Origin      [2]float64 \`json:"origin"\`
	Destination [2]float64 \`json:"destination"\`
	Mode        string     \`json:"mode"\`
	DistanceM   float64    \`json:"distance_m"\`
	LatencyMS   int        \`json:"latency_ms"\`
	Epoch       int64      \`json:"epoch"\`
	Degraded    bool       \`json:"degraded"\`
}

// TODO: key by route.Region instead of route.UserID, publish the coarse coordinate-cell hash
// instead of the exact endpoints, carry the epoch and the distance, and write an outbox row when
// the broker rejects the produce.
func publishRoute(ctx context.Context, route ComputedRoute) {
	log.Printf("route id=%s user=%s origin=%v destination=%v", route.ID, route.UserID, route.Origin, route.Destination)
	event := map[string]any{
		"id":          route.ID,
		"user_id":     route.UserID,
		"origin":      route.Origin,
		"destination": route.Destination,
		"latency_ms":  route.LatencyMS,
	}
	payload, _ := json.Marshal(event)
	_ = events.WriteMessages(ctx, kafka.Message{Key: []byte(route.UserID), Value: payload})
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"

	"github.com/segmentio/kafka-go"
)

// RequiredAcks=RequireAll with a stable hash balancer: the broker acknowledges only replicated
// records, and retries of the same region land on the same partition instead of duplicating.
var events = &kafka.Writer{
	Addr:         kafka.TCP("kafka:9092"),
	Topic:        "route.computed",
	RequiredAcks: kafka.RequireAll,
	Balancer:     &kafka.Hash{},
}

type OutboxStore struct{}

func (s *OutboxStore) InsertOutbox(ctx context.Context, region string, event map[string]any) error {
	return nil
}

var store = &OutboxStore{}

func CellHash(origin [2]float64, destination [2]float64) string {
	round := func(value float64) float64 { return math.Round(value*100) / 100 }
	cell := fmt.Sprintf("%v,%v;%v,%v", round(origin[0]), round(origin[1]), round(destination[0]), round(destination[1]))
	sum := sha1.Sum([]byte(cell))
	return hex.EncodeToString(sum[:])[:16]
}

func publishRoute(ctx context.Context, route ComputedRoute) {
	event := map[string]any{
		"id":         route.ID,
		"region":     route.Region,
		"route_cell": CellHash(route.Origin, route.Destination),
		"mode":       route.Mode,
		"distance_m": route.DistanceM,
		"latency_ms": route.LatencyMS,
		"epoch":      route.Epoch,
		"degraded":   route.Degraded,
	}
	payload, _ := json.Marshal(event)
	if err := events.WriteMessages(ctx, kafka.Message{Key: []byte(route.Region), Value: payload}); err != nil {
		_ = store.InsertOutbox(ctx, route.Region, event)
	}
}
`,
    },
    scala: {
      starter: `import java.util.Properties
import java.util.logging.Logger

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import spray.json._

object Events {
  private val log = Logger.getLogger("route.events")
  val producer = new KafkaProducer[String, String](new Properties())

  case class ComputedRoute(
      id: String,
      region: String,
      userId: String,
      origin: (Double, Double),
      destination: (Double, Double),
      mode: String,
      distanceM: Double,
      latencyMs: Long,
      epoch: Long,
      degraded: Boolean)

  // TODO: key by route.region instead of route.userId, publish the coarse coordinate-cell hash
  // instead of the exact endpoints, carry the epoch and the distance, and write an outbox row when
  // the broker rejects the produce.
  def publishRoute(route: ComputedRoute): Unit = {
    log.info(s"route id=\${route.id} user=\${route.userId} origin=\${route.origin} destination=\${route.destination}")
    val payload = Map(
      "id" -> route.id,
      "user_id" -> route.userId,
      "origin" -> route.origin.toString,
      "destination" -> route.destination.toString,
      "latency_ms" -> route.latencyMs.toString).toJson.compactPrint
    producer.send(new ProducerRecord("route.computed", route.userId, payload))
  }
}
`,
      solution: `import java.security.MessageDigest
import java.util.Properties

import org.apache.kafka.clients.producer.{KafkaProducer, ProducerConfig, ProducerRecord}
import spray.json._

object Events {
  val producer = new KafkaProducer[String, String]({
    val props = new Properties()
    props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092")
    props.put("enable.idempotence", "true")
    props.put("acks", "all")
    props
  })

  case class ComputedRoute(
      id: String,
      region: String,
      userId: String,
      origin: (Double, Double),
      destination: (Double, Double),
      mode: String,
      distanceM: Double,
      latencyMs: Long,
      epoch: Long,
      degraded: Boolean)

  def cellHash(origin: (Double, Double), destination: (Double, Double)): String = {
    def round(value: Double): Double = math.round(value * 100) / 100.0
    val cell = s"\${round(origin._1)},\${round(origin._2)};\${round(destination._1)},\${round(destination._2)}"
    MessageDigest.getInstance("SHA-1").digest(cell.getBytes("UTF-8")).take(8).map("%02x".format(_)).mkString
  }

  def publishRoute(route: ComputedRoute): Unit = {
    val event = Map(
      "id" -> route.id,
      "region" -> route.region,
      "route_cell" -> cellHash(route.origin, route.destination),
      "mode" -> route.mode,
      "distance_m" -> route.distanceM.toString,
      "latency_ms" -> route.latencyMs.toString,
      "epoch" -> route.epoch.toString,
      "degraded" -> route.degraded.toString)
    val payload = event.toJson.compactPrint
    try {
      producer.send(new ProducerRecord("route.computed", route.region, payload))
    } catch {
      case _: org.apache.kafka.common.KafkaException =>
        Store.insertOutbox(route.region, payload)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <librdkafka/rdkafkacpp.h>

#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <utility>

using json = nlohmann::json;

const std::string kRouteComputedTopic = "route.computed";

struct Route {
  std::string id;
  std::string region;
  std::string user_id;
  std::pair<double, double> origin;
  std::pair<double, double> destination;
  std::string mode;
  double distance_m;
  int latency_ms;
  long epoch;
  bool degraded;
};

std::unique_ptr<RdKafka::Producer> producer;

// TODO: key by route.region instead of route.user_id, publish the coarse coordinate-cell hash
// instead of the exact endpoints, carry the epoch and the distance, and write an outbox row when
// the broker rejects the produce.
void publishRoute(const Route& route) {
  std::cerr << "route id=" << route.id << " user=" << route.user_id << " origin=" << route.origin.first << ","
            << route.origin.second << " destination=" << route.destination.first << "," << route.destination.second
            << "\\n";
  const json event = {{"id", route.id},
                      {"user_id", route.user_id},
                      {"origin", {route.origin.first, route.origin.second}},
                      {"destination", {route.destination.first, route.destination.second}},
                      {"latency_ms", route.latency_ms}};
  const auto payload = event.dump();
  producer->produce(kRouteComputedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY,
                    const_cast<char*>(payload.data()), payload.size(), route.user_id.data(), route.user_id.size(), 0,
                    nullptr);
  producer->flush(2000);
}
`,
      solution: `#include <librdkafka/rdkafkacpp.h>

#include <cmath>
#include <iomanip>
#include <memory>
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <sstream>
#include <string>
#include <utility>

using json = nlohmann::json;

const std::string kRouteComputedTopic = "route.computed";

struct OutboxStore {
  void insertOutbox(const std::string& region, const json& event);
};

OutboxStore store;

struct Route {
  std::string id;
  std::string region;
  std::string user_id;
  std::pair<double, double> origin;
  std::pair<double, double> destination;
  std::string mode;
  double distance_m;
  int latency_ms;
  long epoch;
  bool degraded;
};

std::unique_ptr<RdKafka::Producer> makeProducer() {
  std::string err;
  std::unique_ptr<RdKafka::Conf> conf(RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
  conf->set("bootstrap.servers", "kafka:9092", err);
  conf->set("enable.idempotence", "true", err);
  conf->set("acks", "all", err);
  return std::unique_ptr<RdKafka::Producer>(RdKafka::Producer::create(conf.get(), err));
}

std::unique_ptr<RdKafka::Producer> producer = makeProducer();

std::string cellHash(const Route& route) {
  const auto round = [](double value) { return std::round(value * 100) / 100; };
  std::ostringstream cell;
  cell << round(route.origin.first) << "," << round(route.origin.second) << ";" << round(route.destination.first) << ","
       << round(route.destination.second);
  unsigned char digest[SHA_DIGEST_LENGTH];
  SHA1(reinterpret_cast<const unsigned char*>(cell.str().data()), cell.str().size(), digest);
  std::ostringstream hex;
  for (int i = 0; i < 8; ++i) hex << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(digest[i]);
  return hex.str();
}

void publishRoute(const Route& route) {
  const std::string cell = cellHash(route);
  const json event = {{"id", route.id},
                      {"region", route.region},
                      {"route_cell", cell},
                      {"mode", route.mode},
                      {"distance_m", route.distance_m},
                      {"latency_ms", route.latency_ms},
                      {"epoch", route.epoch},
                      {"degraded", route.degraded}};
  const auto payload = event.dump();
  const auto err = producer->produce(kRouteComputedTopic, RdKafka::Topic::PARTITION_UA, RdKafka::Producer::RK_MSG_COPY, const_cast<char*>(payload.data()), payload.size(), route.region.data(), route.region.size(), 0, nullptr);
  if (err != RdKafka::ERR_NO_ERROR) {
    store.insertOutbox(route.region, event);
  }
  producer->flush(2000);
}
`,
    },
  },
  debrief: `The interviewer is checking three things a generated Kafka snippet almost always gets wrong. First, the message key is an ordering contract: partitioned by region, each region’s telemetry arrives in order; keyed by user, it does not. Second, a topic is retained and replicated, so anything written there — exact endpoints included — outlives the request: the payload carries a coarse cell hash and the logs carry ids, not positions. Third, a broker is not a database: a rejected produce becomes an outbox row that a relay republishes, and the event carries the epoch so consumers never mix traffic states. Real platforms add a schema registry and per-topic retention, compact telemetry to roll-ups, and run PII scanners over the pipeline.`,
};
