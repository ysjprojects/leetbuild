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
