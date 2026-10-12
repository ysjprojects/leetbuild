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
