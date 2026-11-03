import {scalaPath} from '../scala-support';

/**
 * The position update every step of fleetd passes along, as the device sends it: one type per
 * typed language (TypeScript `fleet/position`, Go `fleet/position`, C++ `position.h`, Scala
 * `fleet.Position`); the Python course passes it as a dict.
 */
export const supportModulesTs: Record<string, string> = {
  'fleet/position.ts': `/** One position update as the device sends it and as every step of fleetd passes it along. */
export interface Position {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  lat: number;
  lon: number;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'fleet/position/position.go': `// Package position is the position update every step of fleetd passes along, as the device sends it.
package position

// Position is one update of POST /v1/vehicles/positions.
type Position struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int64   \`json:"sequence"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'position.h': `#pragma once

#include <string>

// One position update as the device sends it and as every step of fleetd passes it along.
struct Position {
  std::string vehicle_id;
  long long device_timestamp_ms = 0;
  long long sequence = 0;
  double lat = 0;
  double lon = 0;
};
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('fleet', 'Position')]: `package fleet

import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

/** One position update as the device sends it and as every step of fleetd passes it along. */
final case class Position(vehicleId: String, deviceTimestampMs: Long, sequence: Long, lat: Double, lon: Double)

object Position {
  implicit val format: RootJsonFormat[Position] =
    jsonFormat(Position.apply _, "vehicle_id", "device_timestamp_ms", "sequence", "lat", "lon")
}
`,
};
