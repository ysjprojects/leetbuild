import type {Step} from '@/lib/types';

export const eventsStep: Step = {
  id: 'events',
  title: 'Position events keyed by vehicle with driver ids hashed',
  concept: 'kafka',
  file: 'events',
  focus: ['api', 'kafka'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it builds a position event,
sends it to \`fleet.position\` and then updates the vehicle's latest state. It compiles, it serves
the demo, and it hides three production flaws. Review it like the service owner, fix it, and prove
the fix with the checks below.

Implement the position-event publish.

- The topic is \`fleet.position\` and the message is **keyed by the vehicle id**, so every event for
  one vehicle lands on one partition and consumers see that vehicle's track in order.
- The payload carries the timestamp, the sequence and a **coarse heading** (the heading rounded to
  the nearest 10 degrees), never the exact coordinates.
- The payload never carries **driver identity** and never the **exact home coordinates**: those are
  the fields that turn a tracking topic into a privacy incident once the topic is retained and
  replicated.
- The event is published **after** the Redis latest-position write: a consumer must never observe an
  event whose state write has not landed.
- The producer uses \`acks=all\` (or the client's equivalent durable-ack setting).

**Failure mode the checks target.** The draft keys by fleet instead of vehicle, so one vehicle's
track interleaves with every other vehicle in the fleet; it embeds the driver id and exact
coordinates; and it publishes before the state write, so a consumer can see a position the map has
not accepted. The checks verify the vehicle key, the coarse payload, the absent driver identity and
coordinates, and the publish-after-write order.`,
  sequence: {
    participants: ['Position API', 'Redis', 'Kafka', 'Consumer'],
    messages: [
      {from: 'Position API', to: 'Redis', label: 'update latest position', kind: 'sync'},
      {from: 'Redis', to: 'Position API', label: 'applied', kind: 'reply'},
      {from: 'Position API', to: 'Kafka', label: 'produce fleet.position key=vehicle_id', kind: 'async'},
      {from: 'Kafka', to: 'Consumer', label: 'ordered per vehicle', kind: 'async'},
      {from: 'Position API', to: 'Position API', label: 'coarse heading, no driver id', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'topic-and-key',
      title: 'Publishes to fleet.position keyed by vehicle id',
      detail:
        'The event goes to `fleet.position` with the vehicle id as the message key, so a vehicle track stays ordered on one partition. The draft keys by fleet.',
      match: {
        python: {all: [/fleet\.position/, /key\s*=\s*vehicle_id/]},
        typescript: {all: [/fleet\.position/, /key:\s*vehicleId/]},
        go: {all: [/fleet\.position/, /Key:\s*\[\]byte\(vehicleID\)/]},
        scala: {all: [/fleet\.position/, /ProducerRecord\[String, String\]\("fleet\.position", vehicleId/]},
        cpp: {all: [/fleet\.position/, /produce\([^;]*vehicleId\)/]},
      },
    },
    {
      id: 'coarse-heading',
      title: 'Carries timestamp, sequence and a coarse heading',
      detail:
        'The payload carries the device timestamp, the sequence and a heading rounded to the nearest 10 degrees. The draft ships exact coordinates instead of a coarse heading.',
      match: {
        python: {all: [/heading_deg/, /round/, /sequence/]},
        typescript: {all: [/heading_deg/, /Math\.round/, /sequence/]},
        go: {all: [/heading_deg/, /\/\s*10/, /Sequence/]},
        scala: {all: [/heading_deg/, /\/ 10/, /sequence/]},
        cpp: {all: [/heading_deg/, /\/ 10/, /sequence/]},
      },
    },
    {
      id: 'no-driver-id',
      title: 'No driver identity in the payload',
      detail:
        'The event never carries a driver identifier, hashed or raw, so a retained, replicated topic cannot be joined back to a person. The draft embeds `driver_id`.',
      match: {
        python: {none: [/driver_id/]},
        typescript: {none: [/driver_id/]},
        go: {none: [/driver_id/]},
        scala: {none: [/driver_id/]},
        cpp: {none: [/driver_id/]},
      },
    },
    {
      id: 'publish-after-write',
      title: 'Publishes after the latest-position write',
      detail:
        'The Redis write happens first and the produce second, so no consumer observes an event the state does not have. The draft sends before it writes.',
      match: {
        python: {order: [/write_latest\(/, /producer\.send\(/]},
        typescript: {order: [/writeLatest\(/, /producer\.send\(/]},
        go: {order: [/writeLatest\(/, /WriteMessages\(/]},
        scala: {order: [/writeLatest\(/, /producer\.send\(/]},
        cpp: {order: [/writeLatest\(/, /produce\(/]},
      },
    },
    {
      id: 'no-exact-coordinates',
      title: 'No exact home coordinates in the payload',
      detail:
        'The event carries a coarse heading, never the exact `lat`/`lon`, so a retained topic cannot reconstruct a doorstep. The draft ships both coordinates.',
      match: {
        python: {none: [/["'](lat|lon)["']/]},
        typescript: {none: [/\.lat\b|\.lon\b/]},
        go: {none: [/["'](lat|lon)["']/]},
        scala: {none: [/["'](lat|lon)["']/]},
        cpp: {none: [/["'](lat|lon)["']/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json


def publish_position(producer, fleet_id: str, vehicle_id: str, position: dict, redis) -> None:
    # TODO: this draft keys by fleet, embeds the driver id and exact coordinates, and publishes
    # before the state write. Review the key, the payload and the ordering.
    event = {
        "driver_id": position["driver_id"],
        "lat": position["lat"],
        "lon": position["lon"],
        "device_timestamp_ms": position["device_timestamp_ms"],
        "sequence": position["sequence"],
    }
    producer.send("fleet.position", key=fleet_id.encode(), value=json.dumps(event).encode())
    redis.set(f"vehicle:{vehicle_id}:latest", json.dumps(position))
`,
      solution: `import json


def write_latest(vehicle_id: str, position: dict) -> None:
    """Write the latest position for the vehicle."""
    raise NotImplementedError


def coarse_heading(heading_deg: float) -> int:
    return int(round(heading_deg / 10.0) * 10)


def publish_position(producer, vehicle_id: str, position: dict) -> None:
    write_latest(vehicle_id, position)
    event = {
        "vehicle_id": vehicle_id,
        "device_timestamp_ms": position["device_timestamp_ms"],
        "sequence": position["sequence"],
        "heading_deg": coarse_heading(position["heading_deg"]),
    }
    producer.send(
        "fleet.position",
        key=vehicle_id.encode(),
        value=json.dumps(event).encode(),
    )
`,
    },
    typescript: {
      starter: `/** Position event publisher: a model-generated draft with three leaks. */
import type {Producer} from 'kafkajs';

export interface Position {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  heading_deg: number;
  driver_id: string;
  lat: number;
  lon: number;
}

export async function publishPosition(
  producer: Producer,
  redis: {set(key: string, value: string): Promise<unknown>},
  fleetId: string,
  vehicleId: string,
  position: Position,
): Promise<void> {
  // TODO: this draft keys by fleet, embeds the driver id and exact coordinates, and publishes
  // before the state write. Review the key, the payload and the ordering.
  const event = {
    driver_id: position.driver_id,
    lat: position.lat,
    lon: position.lon,
    device_timestamp_ms: position.device_timestamp_ms,
    sequence: position.sequence,
  };
  await producer.send({
    topic: 'fleet.position',
    messages: [{key: fleetId, value: JSON.stringify(event)}],
  });
  await redis.set(\`vehicle:\${vehicleId}:latest\`, JSON.stringify(position));
}
`,
      solution: `/** Position event publisher: vehicle-keyed, coarse, and written after state. */
import type {Producer} from 'kafkajs';

export interface Position {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  heading_deg: number;
}

export interface LatestWriter {
  writeLatest(vehicleId: string, position: Position): Promise<void>;
}

export async function publishPosition(
  producer: Producer,
  latest: LatestWriter,
  vehicleId: string,
  position: Position,
): Promise<void> {
  await latest.writeLatest(vehicleId, position);
  const event = {
    vehicle_id: vehicleId,
    device_timestamp_ms: position.device_timestamp_ms,
    sequence: position.sequence,
    heading_deg: Math.round(position.heading_deg / 10) * 10,
  };
  await producer.send({
    topic: 'fleet.position',
    acks: -1,
    messages: [{key: vehicleId, value: JSON.stringify(event)}],
  });
}
`,
    },
    go: {
      starter: `package events

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	kafka "github.com/segmentio/kafka-go"
)

type Position struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int     \`json:"sequence"\`
	HeadingDeg        int     \`json:"heading_deg"\`
	DriverID          string  \`json:"driver_id"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
}

func PublishPosition(
	ctx context.Context,
	writer *kafka.Writer,
	rdb *redis.Client,
	fleetID string,
	vehicleID string,
	pos Position,
) error {
	// TODO: this draft keys by fleet, embeds the driver id and exact coordinates, and publishes
	// before the state write. Review the key, the payload and the ordering.
	event := map[string]any{
		"driver_id":           pos.DriverID,
		"lat":                 pos.Lat,
		"lon":                 pos.Lon,
		"device_timestamp_ms": pos.DeviceTimestampMs,
		"sequence":            pos.Sequence,
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := writer.WriteMessages(ctx, kafka.Message{
		Topic: "fleet.position",
		Key:   []byte(fleetID),
		Value: payload,
	}); err != nil {
		return err
	}
	return rdb.Set(ctx, "vehicle:"+vehicleID+":latest", payload, 0).Err()
}
`,
      solution: `package events

import (
	"context"
	"encoding/json"

	kafka "github.com/segmentio/kafka-go"
)

type Position struct {
	VehicleID         string
	DeviceTimestampMs int64
	Sequence          int
	HeadingDeg        int
}

func writeLatest(ctx context.Context, vehicleID string, pos Position) error {
	return nil
}

func CoarseHeading(headingDeg int) int {
	return (headingDeg / 10) * 10
}

func PublishPosition(ctx context.Context, writer *kafka.Writer, vehicleID string, pos Position) error {
	if err := writeLatest(ctx, vehicleID, pos); err != nil {
		return err
	}
	event := map[string]any{
		"vehicle_id":          vehicleID,
		"device_timestamp_ms": pos.DeviceTimestampMs,
		"sequence":            pos.Sequence,
		"heading_deg":         CoarseHeading(pos.HeadingDeg),
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return writer.WriteMessages(ctx, kafka.Message{
		Topic: "fleet.position",
		Key:   []byte(vehicleID),
		Value: payload,
	})
}
`,
    },
    scala: {
      starter: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import play.api.libs.json.{JsObject, Json}

object PositionEvents {
  final case class Position(
      vehicleId: String,
      deviceTimestampMs: Long,
      sequence: Int,
      headingDeg: Int,
      driverId: String,
      lat: Double,
      lon: Double,
  )

  def publishPosition(
      producer: KafkaProducer[String, String],
      redis: RedisClient,
      fleetId: String,
      vehicleId: String,
      position: Position,
  ): Unit = {
    // TODO: this draft keys by fleet, embeds the driver id and exact coordinates, and publishes
    // before the state write. Review the key, the payload and the ordering.
    val event: JsObject = Json.obj(
      "driver_id" -> position.driverId,
      "lat" -> position.lat,
      "lon" -> position.lon,
      "device_timestamp_ms" -> position.deviceTimestampMs,
      "sequence" -> position.sequence,
    )
    producer.send(new ProducerRecord[String, String]("fleet.position", fleetId, Json.stringify(event)))
    redis.set(s"vehicle:$vehicleId:latest", Json.stringify(position))
  }
}
`,
      solution: `import org.apache.kafka.clients.producer.{KafkaProducer, ProducerRecord}
import play.api.libs.json.{JsObject, Json}

object PositionEvents {
  final case class Position(
      vehicleId: String,
      deviceTimestampMs: Long,
      sequence: Int,
      headingDeg: Int,
  )

  def writeLatest(vehicleId: String, position: Position): Unit = ()

  def coarseHeading(headingDeg: Int): Int = (headingDeg / 10) * 10

  def publishPosition(producer: KafkaProducer[String, String], vehicleId: String, position: Position): Unit = {
    writeLatest(vehicleId, position)
    val event: JsObject = Json.obj(
      "vehicle_id" -> vehicleId,
      "device_timestamp_ms" -> position.deviceTimestampMs,
      "sequence" -> position.sequence,
      "heading_deg" -> coarseHeading(position.headingDeg),
    )
    producer.send(new ProducerRecord[String, String]("fleet.position", vehicleId, Json.stringify(event)))
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

void publishPosition(Producer* producer,
                     RedisClient& redis,
                     const std::string& fleetId,
                     const std::string& vehicleId,
                     const json& position) {
  // TODO: this draft keys by fleet, embeds the driver id and exact coordinates, and publishes
  // before the state write. Review the key, the payload and the ordering.
  json event = {
      {"driver_id", position.value("driver_id", std::string())},
      {"lat", position.value("lat", 0.0)},
      {"lon", position.value("lon", 0.0)},
      {"device_timestamp_ms", position.value("device_timestamp_ms", 0LL)},
      {"sequence", position.value("sequence", 0)},
  };
  const std::string payload = event.dump();
  producer->produce("fleet.position", Producer::kDefaultPartition, payload.data(), payload.size(), fleetId);
  redis.set("vehicle:" + vehicleId + ":latest", payload);
}
`,
      solution: `#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

void writeLatest(const std::string& vehicleId, const json& position);

int coarseHeading(int headingDeg) {
  return (headingDeg / 10) * 10;
}

void publishPosition(Producer* producer, const std::string& vehicleId, const json& position) {
  writeLatest(vehicleId, position);
  json event = {
      {"vehicle_id", vehicleId},
      {"device_timestamp_ms", position.value("device_timestamp_ms", 0LL)},
      {"sequence", position.value("sequence", 0)},
      {"heading_deg", coarseHeading(position.value("heading_deg", 0))},
  };
  const std::string payload = event.dump();
  producer->produce("fleet.position", Producer::kDefaultPartition, payload.data(), payload.size(), vehicleId);
}
`,
    },
  },
  hints: [
    'The key is the vehicle id, not the fleet id: `key=vehicle_id.encode()` / `key: vehicleId` / `Key: []byte(vehicleID)` / `ProducerRecord(..., vehicleId, ...)` / the last argument of `produce`. One key per vehicle is what keeps a track ordered.',
    'The payload is `{vehicle_id, device_timestamp_ms, sequence, heading_deg}` where `heading_deg` is the heading rounded to the nearest 10 degrees. No `driver_id`, no `lat`, no `lon`.',
    'Order matters: call `write_latest`/`writeLatest` **before** `producer.send`/`WriteMessages`/`produce`. A consumer that reads the topic must never see a position the state store has not accepted.',
  ],
  debrief: `The interviewer is testing whether you can review a generated event publisher against three separate contracts: partitioning (vehicle key keeps a track ordered), privacy (no driver identity, no exact home coordinates in a retained, replicated topic), and causality (publish after the state write). The draft passes the demo because one vehicle and one tenant are active and the consumer is a local print. The hash-the-driver-id idea appears in the title because the naive fix is to hash the id rather than drop it; either is acceptable only if the hash is not reversible and not the primary key of another dataset. Real platforms add a schema registry, tombstoning for GDPR deletes, and a separate coarse geohash topic for map rendering.`,
};
