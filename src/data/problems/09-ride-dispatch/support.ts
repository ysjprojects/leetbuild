import {CPP_IDS_H} from '../cpp-support';

/**
 * Runtime support modules for the Python steps: the "provided" pieces the starters import but no
 * step builds — the ride store and dispatcher hand-off (steps 1 and 5) and the geo helpers (step 6).
 */
export const supportModules: Record<string, string> = {
  'ride_store.py': `"""Provided: the dispatcher's in-memory ride store."""


class RideStore:
    def __init__(self) -> None:
        self._rides: dict[str, dict] = {}

    def get(self, ride_id: str) -> dict | None:
        """The stored ride, or None when the id is unknown."""
        ride = self._rides.get(ride_id)
        return dict(ride) if ride is not None else None

    def put(self, ride: dict) -> None:
        ride_id = ride.get("ride_id") or ride.get("id")
        if not ride_id:
            raise ValueError("a ride needs a ride_id")
        self._rides[ride_id] = dict(ride)

    def set_status(self, ride_id: str, status: str) -> None:
        ride = self._rides.setdefault(ride_id, {"ride_id": ride_id})
        ride["status"] = status

    def set_driver(self, ride_id: str, driver_id: str) -> None:
        ride = self._rides.setdefault(ride_id, {"ride_id": ride_id})
        ride["driver_id"] = driver_id
        ride["status"] = "matched"

    def all(self) -> list[dict]:
        return [dict(ride) for ride in self._rides.values()]


rides = RideStore()
`,
  'dispatch.py': `"""Provided: the hand-off from the ride API to the dispatcher."""
from ride_store import rides

matching: list[str] = []  # ride ids handed to the dispatcher, in order


def start_matching(ride: dict) -> None:
    """Records the ride and queues it for matching (the dispatcher is built in the next steps)."""
    rides.put(ride)
    matching.append(ride.get("ride_id") or ride.get("id"))
`,
  'geo.py': `"""Provided: a ~1 km grid id for cache keys and the great-circle distance."""
import math

EARTH_RADIUS_KM = 6371.0088
CELL_DEG = 0.01  # ~1.1 km of latitude


def cell(lat: float, lng: float) -> str:
    """A ~1 km grid id: both coordinates floored to 0.01 degrees, as 8 hex digits."""
    row = int(math.floor(lat / CELL_DEG)) & 0xFFFF
    col = int(math.floor(lng / CELL_DEG)) & 0xFFFF
    return f"{row:04x}{col:04x}"


def haversine_km(a, b) -> float:
    """Great-circle distance between two points with .lat/.lng, in km."""
    lat1, lng1 = math.radians(a.lat), math.radians(a.lng)
    lat2, lng2 = math.radians(b.lat), math.radians(b.lng)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))
`,
};

/**
 * The same provided pieces for the TypeScript steps, imported by bare path (`import {rides} from
 * 'ride_store'`): the ride store and dispatcher hand-off (steps 1 and 5) and the geo helpers (step 6).
 */
export const supportModulesTs: Record<string, string> = {
  'ride_store.ts': `/** Provided: the dispatcher's in-memory ride store. */

export interface Ride {
  ride_id: string;
  status?: string;
  driver_id?: string;
  [field: string]: unknown;
}

export class RideStore {
  private readonly rides = new Map<string, Ride>();

  /** The stored ride, or null when the id is unknown. */
  get(rideId: string): Ride | null {
    const ride = this.rides.get(rideId);
    return ride === undefined ? null : {...ride};
  }

  put(ride: Ride): void {
    if (!ride.ride_id) throw new Error('a ride needs a ride_id');
    this.rides.set(ride.ride_id, {...ride});
  }

  setStatus(rideId: string, status: string): void {
    const ride = this.rides.get(rideId) ?? {ride_id: rideId};
    ride.status = status;
    this.rides.set(rideId, ride);
  }

  setDriver(rideId: string, driverId: string): void {
    const ride = this.rides.get(rideId) ?? {ride_id: rideId};
    ride.driver_id = driverId;
    ride.status = 'matched';
    this.rides.set(rideId, ride);
  }

  all(): Ride[] {
    return [...this.rides.values()].map(ride => ({...ride}));
  }
}

export const rides = new RideStore();
`,
  'dispatch.ts': `/** Provided: the hand-off from the ride API to the dispatcher. */
import {type Ride, rides} from 'ride_store';

export {rides};

/** Ride ids handed to the dispatcher, in order. */
export const matching: string[] = [];

/** Records the ride and queues it for matching (the dispatcher is built in the next steps). */
export function startMatching(ride: Ride): void {
  rides.put(ride);
  matching.push(ride.ride_id);
}
`,
  'geo.ts': `/** Provided: a ~1 km grid id for cache keys and the great-circle distance. */

export const EARTH_RADIUS_KM = 6371.0088;
/** ~1.1 km of latitude. */
export const CELL_DEG = 0.01;

/** A ~1 km grid id: both coordinates floored to 0.01 degrees, as 8 hex digits. */
export function cell(lat: number, lng: number): string {
  const row = (Math.floor(lat / CELL_DEG) & 0xffff).toString(16).padStart(4, '0');
  const col = (Math.floor(lng / CELL_DEG) & 0xffff).toString(16).padStart(4, '0');
  return row + col;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points with .lat/.lng, in km. */
export function haversineKm(a: {lat: number; lng: number}, b: {lat: number; lng: number}): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng) - toRad(a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}
`,
};

/**
 * The C++ twins, included by the starters: dispatch.h (step 1's hand-off to the dispatcher) and
 * ride_store.h (step 5's status store) declare the dispatcher's interface — the harness stands in
 * for it, as the Go harness does — ids.h makes ride ids, and geo.h (step 6) is the grid cell and
 * the great-circle distance.
 */
export const supportModulesCpp: Record<string, string> = {
  'ids.h': CPP_IDS_H,
  'dispatch.h': `// The hand-off from the ride API to the dispatcher (provided): the ride, matching it, reading it back.
#pragma once

#include <optional>
#include <string>

#include "ids.h"

struct Point {
  double lat;
  double lng;
};

struct Ride {
  std::string ride_id;
  std::string rider_id;
  Point pickup;
  Point dropoff;
  std::string status;     // "matching", then "matched", ...
  std::string driver_id;  // "" until a driver accepted
};

// Records the ride and queues it for matching (the dispatcher is built in the next steps).
void start_matching(const Ride& ride);

// The stored ride, or nullopt when the id is unknown.
std::optional<Ride> get_ride(const std::string& ride_id);

// A fresh ride id: a random UUID.
inline std::string new_ride_id() { return new_uuid(); }
`,
  'ride_store.h': `// The dispatcher's ride store (provided): each ride's status, as the trip-state consumer keeps it.
#pragma once

#include <string>

// The ride's status; "" for a ride nobody has seen yet.
std::string get_status(const std::string& ride_id);

// Record the ride's new status; throws when the store is unavailable.
void set_status(const std::string& ride_id, const std::string& status);
`,
  'geo.h': `// Geo helpers (provided): a ~1 km grid id for cache keys and the great-circle distance.
#pragma once

#include <cmath>
#include <cstdio>
#include <string>

#include "routing.pb.h"

inline constexpr double kEarthRadiusKm = 6371.0088;
// ~1.1 km of latitude.
inline constexpr double kCellDeg = 0.01;

// A ~1 km grid id: both coordinates floored to 0.01 degrees, as 8 hex digits.
inline std::string cell(double lat, double lng) {
  const long long row = static_cast<long long>(std::floor(lat / kCellDeg)) & 0xffff;
  const long long col = static_cast<long long>(std::floor(lng / kCellDeg)) & 0xffff;
  char out[9];
  std::snprintf(out, sizeof out, "%04llx%04llx", row, col);
  return out;
}

// Great-circle distance between two points, in km.
inline double haversine_km(const dispatch::LatLng& a, const dispatch::LatLng& b) {
  const double rad = M_PI / 180;
  const double lat1 = a.lat() * rad, lat2 = b.lat() * rad;
  const double d_lat = lat2 - lat1;
  const double d_lng = b.lng() * rad - a.lng() * rad;
  const double h = std::pow(std::sin(d_lat / 2), 2) + std::cos(lat1) * std::cos(lat2) * std::pow(std::sin(d_lng / 2), 2);
  return 2 * kEarthRadiusKm * std::asin(std::sqrt(h));
}
`,
};
