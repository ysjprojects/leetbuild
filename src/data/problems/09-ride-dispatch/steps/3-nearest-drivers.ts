import type {Step} from '@/lib/types';

// ---- 3. Nearest available drivers from the GEO set --------------------------------------------
export const nearestDriversStep: Step = {
  id: 'nearest-drivers',
  title: 'Find the nearest available drivers',
  concept: 'redis',
  file: 'nearest',
  focus: ['dispatcher', 'redis'],
  task: `## Task

Implement \`nearest(city, lat, lng, k)\`: the \`k\` closest drivers who are actually there and actually
free, nearest first, each with its distance. \`driver_status(ids)\` is provided and maps driver ids to
\`available\`, \`on_trip\` or \`offline\` from the driver store.

- \`GEOSEARCH drivers:{city} FROMLONLAT lng lat BYRADIUS 3 km ASC COUNT 20 WITHDIST\`: twenty candidates,
  sorted by distance, with the distance in the reply. Beyond 3 km the rider waits too long anyway.
- Candidates may be stale — the GEO set remembers a driver's last position forever. One \`MGET\` over
  \`driver:{id}:seen\` for all candidates; drop every driver whose presence key is gone.
- Ask \`driver_status\` about the survivors and keep only \`available\`.
- Return the first \`k\` as \`(driver_id, distance_km)\`.

:::widget cache-aside {}

> The widget shows a TTL as a staleness bound on cached data. The \`EX 30\` on \`driver:{id}:seen\` is the
> same mechanism used for something else: **liveness**. The key does not cache a value — its mere
> existence says "this driver reported in the last 30 s", and expiry is the heartbeat timing out.`,
  sequence: {
    participants: ['dispatcher', 'Redis', 'driver store'],
    messages: [
      {
        from: 'dispatcher',
        to: 'Redis',
        label: 'GEOSEARCH drivers:paris FROMLONLAT 2.35 48.85 BYRADIUS 3 km ASC COUNT 20 WITHDIST',
        kind: 'sync',
      },
      {from: 'Redis', to: 'dispatcher', label: '[d-7 0.4] [d-2 1.1] [d-9 2.6]', kind: 'reply'},
      {from: 'dispatcher', to: 'Redis', label: 'MGET driver:d-7:seen driver:d-2:seen driver:d-9:seen', kind: 'sync'},
      {from: 'Redis', to: 'dispatcher', label: '[ts, nil, ts] → d-2 went silent', kind: 'reply'},
      {from: 'dispatcher', to: 'driver store', label: 'driver_status([d-7, d-9])', kind: 'sync'},
      {from: 'driver store', to: 'dispatcher', label: '{d-7: available, d-9: on_trip} → [d-7 0.4]', kind: 'reply'},
    ],
  },
  hints: [
    'Three filters in order of cost: the spatial query (one command, already sorted), presence (one MGET for all ids), status (one call to the store). Each one shrinks the list the next one sees.',
    'GEOSEARCH again wants longitude before latitude (`FROMLONLAT`). Ask for the distance in the same command (`WITHDIST`) instead of computing it yourself.',
    'MGET returns one entry per key in the same order as the ids you passed; zip them together and keep the drivers whose entry is not null. Never GET in a loop — twenty round trips for one search.',
  ],
  checks: [
    {
      id: 'geosearch',
      title: 'Searches drivers:{city} by radius from (lng, lat)',
      detail:
        'One `GEOSEARCH` (or `GEORADIUS`) on `drivers:{city}` from the pickup — longitude first — within a 3 km radius.',
      match: {
        python: {
          all: [/\br\.geosearch\(/, /longitude\s*=\s*lng\b/, /latitude\s*=\s*lat\b/, /radius\s*=\s*(?:RADIUS_KM|3)\b/],
        },
        typescript: {
          all: [
            /\.geosearch\(/,
            /['"]FROMLONLAT['"]\s*,\s*lng\b\s*,\s*lat\b/,
            /['"]BYRADIUS['"]\s*,\s*(?:RADIUS_KM|3)\b/,
          ],
        },
        go: {
          all: [/GeoSearchLocation\(/, /Longitude:\s*lng\b/, /Latitude:\s*lat\b/, /Radius:\s*(?:radiusKm|3(?:\.0)?)\b/],
        },
        scala: {
          all: [
            /\.geosearch\(/,
            /fromLonLat\(\s*lng\s*,\s*lat\s*\)|new GeoCoordinate\(\s*lng\s*,\s*lat\s*\)/,
            /byRadius\(\s*(?:RadiusKm|3(?:\.0)?)\s*,\s*GeoUnit\.KM\s*\)/,
          ],
        },
        cpp: {
          all: [
            /redis\.georadius\(|redis\.geosearch\(/,
            /std::make_pair\(\s*lng\s*,\s*lat\s*\)|\{\s*lng\s*,\s*lat\s*\}/,
            /(?:kRadiusKm|3\.0|\b3\b)\s*,\s*GeoUnit::KM/,
          ],
        },
      },
    },
    {
      id: 'sorted-bounded',
      title: 'Asks for 20 candidates, nearest first, with distances',
      detail:
        '`ASC COUNT 20 WITHDIST`: Redis sorts and bounds the result and returns the distance, so the service does neither.',
      match: {
        python: {all: [/sort\s*=\s*"ASC"/, /count\s*=\s*(?:CANDIDATES|20)\b/, /withdist\s*=\s*True/]},
        typescript: {all: [/['"]ASC['"]/, /['"]COUNT['"]\s*,\s*(?:CANDIDATES|20)\b/, /['"]WITHDIST['"]/]},
        go: {all: [/Sort:\s*"ASC"/, /Count:\s*(?:candidates|20)\b/, /WithDist:\s*true/]},
        scala: {all: [/\.asc\(\)/, /\.count\(\s*(?:Candidates|20)\s*\)/, /\.withDist\(\)/]},
        cpp: {all: [/GeoUnit::KM\s*,\s*(?:kCandidates|20)\s*,\s*true/, /std::tuple<std::string,\s*double>/]},
      },
    },
    {
      id: 'presence-mget',
      title: 'Drops silent drivers with one MGET over driver:{id}:seen',
      detail:
        "A single `MGET` of every candidate's presence key, then keep the ones whose key still exists. No GET per driver.",
      match: {
        python: {all: [/\br\.mget\(/, /:seen/], none: [/\br\.get\(/]},
        typescript: {all: [/\bredis\.mget\(/, /:seen/], none: [/\bredis\.get\(/]},
        go: {all: [/rdb\.MGet\(/, /:seen/], none: [/rdb\.Get\(/]},
        scala: {all: [/jedis\.mget\(/, /:seen/], none: [/jedis\.get\(/]},
        cpp: {all: [/redis\.mget\(/, /:seen/], none: [/redis\.get\(/]},
      },
    },
    {
      id: 'available-only',
      title: 'Keeps only drivers the store reports as available',
      detail: 'Call the provided `driver_status` with the surviving ids and keep those whose status is `available`.',
      match: {
        python: {all: [/(?<!def )\bdriver_status\(/, /"available"/]},
        typescript: {all: [/\bstore\.driverStatus\(/, /['"]available['"]/]},
        go: {all: [/(?<!func )\bdriverStatus\(/, /"available"/]},
        scala: {all: [/(?<!def )\bdriverStatus\(/, /"available"/]},
        cpp: {all: [/\bdriver_status\(\s*(?!const\b)\w/, /"available"/]},
      },
    },
    {
      id: 'top-k',
      title: 'Returns at most k drivers',
      detail: 'The caller asked for `k`; the twenty candidates were only there to survive the two filters.',
      match: {
        python: {all: [/\[\s*:\s*k\s*\]|len\(\s*\w+\s*\)\s*(?:==|>=)\s*k\b/]},
        typescript: {all: [/\.slice\(\s*0\s*,\s*k\s*\)|\.length\s*(?:===?|>=)\s*k\b/]},
        go: {all: [/\[\s*:\s*k\s*\]|len\(\s*\w+\s*\)\s*(?:==|>=)\s*k\b/]},
        scala: {all: [/\.take\(\s*k\s*\)/]},
        cpp: {all: [/\.size\(\)\s*(?:==|>=|<)\s*k\b|\.resize\(\s*k\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RADIUS_KM = 3
CANDIDATES = 20


def driver_status(driver_ids: list[str]) -> dict[str, str]:
    """Provided (driver store): driver id → available / on_trip / offline."""
    raise NotImplementedError


def nearest(city: str, lat: float, lng: float, k: int) -> list[tuple[str, float]]:
    """The k closest available drivers as (driver_id, distance_km), nearest first."""
    # TODO: GEOSEARCH drivers:{city} FROMLONLAT lng lat BYRADIUS RADIUS_KM km ASC COUNT CANDIDATES WITHDIST
    # TODO: one MGET over driver:{id}:seen; drop drivers whose presence key expired
    # TODO: driver_status(ids); keep the available ones; return the first k
    raise NotImplementedError
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RADIUS_KM = 3
CANDIDATES = 20


def driver_status(driver_ids: list[str]) -> dict[str, str]:
    """Provided (driver store): driver id → available / on_trip / offline."""
    raise NotImplementedError


def nearest(city: str, lat: float, lng: float, k: int) -> list[tuple[str, float]]:
    """The k closest available drivers as (driver_id, distance_km), nearest first."""
    found = r.geosearch(
        f"drivers:{city}",
        longitude=lng,
        latitude=lat,
        radius=RADIUS_KM,
        unit="km",
        sort="ASC",
        count=CANDIDATES,
        withdist=True,
    )
    if not found:
        return []
    seen = r.mget([f"driver:{driver_id}:seen" for driver_id, _dist in found])
    live = [(driver_id, dist) for (driver_id, dist), ts in zip(found, seen) if ts is not None]
    status = driver_status([driver_id for driver_id, _dist in live])
    return [(driver_id, dist) for driver_id, dist in live if status.get(driver_id) == "available"][:k]
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const RADIUS_KM = 3;
export const CANDIDATES = 20;

/** One driver with its distance from the pickup, in km. */
export type Candidate = [driverId: string, distanceKm: number];

/** Driver store (provided): driver id → available / on_trip / offline. */
export const store = {
  async driverStatus(driverIds: string[]): Promise<Record<string, string>> {
    throw new Error('not implemented');
  },
};

/** The k closest available drivers as [driverId, distanceKm], nearest first. */
export async function nearest(city: string, lat: number, lng: number, k: number): Promise<Candidate[]> {
  // TODO: GEOSEARCH drivers:{city} FROMLONLAT lng lat BYRADIUS RADIUS_KM km ASC COUNT CANDIDATES WITHDIST
  // TODO: one MGET over driver:{id}:seen; drop drivers whose presence key expired
  // TODO: store.driverStatus(ids); keep the available ones; return the first k
  throw new Error('not implemented');
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const RADIUS_KM = 3;
export const CANDIDATES = 20;

/** One driver with its distance from the pickup, in km. */
export type Candidate = [driverId: string, distanceKm: number];

/** Driver store (provided): driver id → available / on_trip / offline. */
export const store = {
  async driverStatus(driverIds: string[]): Promise<Record<string, string>> {
    throw new Error('not implemented');
  },
};

/** The k closest available drivers as [driverId, distanceKm], nearest first. */
export async function nearest(city: string, lat: number, lng: number, k: number): Promise<Candidate[]> {
  const found = (await redis.geosearch(
    \`drivers:\${city}\`,
    'FROMLONLAT',
    lng,
    lat,
    'BYRADIUS',
    RADIUS_KM,
    'km',
    'ASC',
    'COUNT',
    CANDIDATES,
    'WITHDIST',
  )) as [string, string][];
  if (found.length === 0) return [];
  const seen = await redis.mget(found.map(([driverId]) => \`driver:\${driverId}:seen\`));
  const live: Candidate[] = found
    .filter((_, i) => seen[i] !== null)
    .map(([driverId, dist]) => [driverId, Number(dist)]);
  const status = await store.driverStatus(live.map(([driverId]) => driverId));
  return live.filter(([driverId]) => status[driverId] === 'available').slice(0, k);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	radiusKm   = 3.0
	candidates = 20
)

// Candidate is one driver with its distance from the pickup, in km.
type Candidate struct {
	DriverID string
	Dist     float64
}

// driverStatus is provided (driver_store.go): driver id → available / on_trip / offline.
func driverStatus(ctx context.Context, ids []string) map[string]string { panic("not implemented") }

// nearest returns the k closest available drivers, nearest first.
func nearest(ctx context.Context, city string, lat, lng float64, k int) ([]Candidate, error) {
	// TODO: GeoSearchLocation drivers:{city} {Longitude: lng, Latitude: lat, Radius: radiusKm, RadiusUnit: "km", Sort: "ASC", Count: candidates}, WithDist
	// TODO: one MGet over driver:{id}:seen; drop drivers whose presence key expired (nil)
	// TODO: driverStatus(ctx, ids); keep the available ones; return the first k
	return nil, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	radiusKm   = 3.0
	candidates = 20
)

// Candidate is one driver with its distance from the pickup, in km.
type Candidate struct {
	DriverID string
	Dist     float64
}

// driverStatus is provided (driver_store.go): driver id → available / on_trip / offline.
func driverStatus(ctx context.Context, ids []string) map[string]string { panic("not implemented") }

// nearest returns the k closest available drivers, nearest first.
func nearest(ctx context.Context, city string, lat, lng float64, k int) ([]Candidate, error) {
	found, err := rdb.GeoSearchLocation(ctx, "drivers:"+city, &redis.GeoSearchLocationQuery{
		GeoSearchQuery: redis.GeoSearchQuery{Longitude: lng, Latitude: lat, Radius: radiusKm, RadiusUnit: "km", Sort: "ASC", Count: candidates},
		WithDist:       true,
	}).Result()
	if err != nil || len(found) == 0 {
		return nil, err
	}
	keys := make([]string, len(found))
	for i, loc := range found {
		keys[i] = "driver:" + loc.Name + ":seen"
	}
	seen, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	live := make([]string, 0, len(found))
	for i, loc := range found {
		if seen[i] != nil {
			live = append(live, loc.Name)
		}
	}
	status := driverStatus(ctx, live) // expired drivers were not asked about: absent from the map
	out := make([]Candidate, 0, k)
	for _, loc := range found {
		if status[loc.Name] != "available" {
			continue
		}
		out = append(out, Candidate{DriverID: loc.Name, Dist: loc.Dist})
		if len(out) == k {
			break
		}
	}
	return out, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.args.GeoUnit
import redis.clients.jedis.params.GeoSearchParam
import scala.jdk.CollectionConverters._

object Nearest {
  val jedis = new JedisPooled("redis", 6379)
  val RadiusKm = 3.0
  val Candidates = 20

  /** One driver with its distance from the pickup, in km. */
  final case class Candidate(driverId: String, distKm: Double)

  /** Provided (DriverStore): driver id → available / on_trip / offline. */
  def driverStatus(ids: Seq[String]): Map[String, String] = ???

  /** The k closest available drivers, nearest first. */
  def nearest(city: String, lat: Double, lng: Double, k: Int): Seq[Candidate] = {
    // TODO: geosearch(s"drivers:$city", new GeoSearchParam().fromLonLat(lng, lat).byRadius(RadiusKm, GeoUnit.KM).asc().count(Candidates).withDist())
    // TODO: one mget over driver:{id}:seen; drop drivers whose presence key expired (null)
    // TODO: driverStatus(ids); keep the available ones; take(k)
    Nil
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.args.GeoUnit
import redis.clients.jedis.params.GeoSearchParam
import scala.jdk.CollectionConverters._

object Nearest {
  val jedis = new JedisPooled("redis", 6379)
  val RadiusKm = 3.0
  val Candidates = 20

  /** One driver with its distance from the pickup, in km. */
  final case class Candidate(driverId: String, distKm: Double)

  /** Provided (DriverStore): driver id → available / on_trip / offline. */
  def driverStatus(ids: Seq[String]): Map[String, String] = ???

  /** The k closest available drivers, nearest first. */
  def nearest(city: String, lat: Double, lng: Double, k: Int): Seq[Candidate] = {
    val params = new GeoSearchParam().fromLonLat(lng, lat).byRadius(RadiusKm, GeoUnit.KM).asc().count(Candidates).withDist()
    val found = jedis.geosearch(s"drivers:$city", params).asScala.toSeq
    if (found.isEmpty) Nil
    else {
      val seen = jedis.mget(found.map(r => s"driver:\${r.getMemberByString}:seen"): _*).asScala
      val live = found.zip(seen).collect { case (r, ts) if ts != null => r }
      val status = driverStatus(live.map(_.getMemberByString))
      live
        .collect { case r if status.get(r.getMemberByString).contains("available") => Candidate(r.getMemberByString, r.getDistance) }
        .take(k)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <string>
#include <tuple>
#include <vector>

using sw::redis::GeoUnit;

sw::redis::Redis redis("tcp://redis:6379");

constexpr double kRadiusKm = 3.0;
constexpr long long kCandidates = 20;

// One driver with its distance from the pickup, in km.
struct Candidate {
  std::string driver_id;
  double dist_km;
};

// Provided (driver_store.h): driver id → available / on_trip / offline.
std::map<std::string, std::string> driver_status(const std::vector<std::string>& ids);

// The k closest available drivers, nearest first.
std::vector<Candidate> nearest(const std::string& city, double lat, double lng, std::size_t k) {
  // TODO: georadius("drivers:" + city, {lng, lat}, kRadiusKm, GeoUnit::KM, kCandidates, true /*asc*/, back_inserter of tuple<string, double> — WITHDIST)
  // TODO: one mget over driver:{id}:seen; drop drivers whose presence key expired (nullopt)
  // TODO: driver_status(ids); keep the available ones; stop at k
  return {};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <string>
#include <tuple>
#include <vector>

using sw::redis::GeoUnit;

sw::redis::Redis redis("tcp://redis:6379");

constexpr double kRadiusKm = 3.0;
constexpr long long kCandidates = 20;

// One driver with its distance from the pickup, in km.
struct Candidate {
  std::string driver_id;
  double dist_km;
};

// Provided (driver_store.h): driver id → available / on_trip / offline.
std::map<std::string, std::string> driver_status(const std::vector<std::string>& ids);

// The k closest available drivers, nearest first.
std::vector<Candidate> nearest(const std::string& city, double lat, double lng, std::size_t k) {
  std::vector<std::tuple<std::string, double>> found;  // (member, distance): the element type selects WITHDIST
  redis.georadius("drivers:" + city, std::make_pair(lng, lat), kRadiusKm, GeoUnit::KM, kCandidates, true, std::back_inserter(found));
  if (found.empty()) return {};
  std::vector<std::string> keys;
  for (const auto& [driver_id, dist] : found) keys.push_back("driver:" + driver_id + ":seen");
  std::vector<sw::redis::OptionalString> seen;
  redis.mget(keys.begin(), keys.end(), std::back_inserter(seen));
  std::vector<std::string> live;
  for (std::size_t i = 0; i < found.size(); ++i)
    if (seen[i]) live.push_back(std::get<0>(found[i]));
  const auto status = driver_status(live);  // expired drivers were not asked about: absent from the map
  std::vector<Candidate> out;
  for (const auto& [driver_id, dist] : found) {
    const auto it = status.find(driver_id);
    if (it == status.end() || it->second != "available") continue;
    out.push_back(Candidate{driver_id, dist});
    if (out.size() == k) break;
  }
  return out;
}
`,
    },
  },
  harness: {
    python: `PICKUP = (48.85, 2.35)  # lat, lng


def _seed(ctx, city, *drivers, seen=True):
    """drivers: (driver_id, lat, lng). Writes the GEO member and, by default, a live presence key."""
    for driver_id, lat, lng in drivers:
        ctx.redis.geoadd(f"drivers:{city}", [lng, lat, driver_id])
        if seen:
            ctx.redis.set(f"driver:{driver_id}:seen", "1000", ex=30)


def _dispatcher(ctx, statuses=None):
    m = ctx.load("nearest")
    calls = []

    def driver_status(driver_ids):
        calls.append(list(driver_ids))
        return {d: (statuses or {}).get(d, "available") for d in driver_ids}

    m.driver_status = driver_status
    commands = []
    real_execute = m.r.execute_command

    def execute_command(*args, **kwargs):
        commands.append(str(args[0]).upper())
        return real_execute(*args, **kwargs)

    m.r.execute_command = execute_command
    return m, calls, commands


def _ids(found):
    return [row[0] for row in found]


async def check_geosearch(ctx):
    _seed(ctx, "paris", ("d-7", 48.852, 2.352), ("d-9", 48.86, 2.37), ("d-far", 48.90, 2.35))
    _seed(ctx, "lyon", ("d-l", 45.76, 4.84))
    m, calls, commands = _dispatcher(ctx)
    found = m.nearest("paris", PICKUP[0], PICKUP[1], 10)
    assert isinstance(found, list), f"nearest must return a list, got {type(found).__name__}"
    assert _ids(found) == ["d-7", "d-9"], f"nearest(paris) returned {_ids(found)}, expected [d-7, d-9]: within 3 km of (lat 48.85, lng 2.35), lng before lat in the search"
    assert "d-far" not in _ids(found), "d-far is 5.6 km away and must be outside the 3 km radius"
    found = m.nearest("lyon", 45.76, 4.84, 10)
    assert _ids(found) == ["d-l"], f"nearest(lyon) returned {_ids(found)}, expected [d-l]: the search is on drivers:{{city}}"


async def check_sorted_bounded(ctx):
    drivers = [(f"d-{i}", 48.85 + i / 1000, 2.35) for i in range(1, 26)]  # ~0.111 km apart, 25 within 3 km
    import random

    random.Random(7).shuffle(drivers)
    _seed(ctx, "paris", *drivers)
    m, calls, commands = _dispatcher(ctx)
    found = m.nearest("paris", PICKUP[0], PICKUP[1], 25)
    assert len(found) == 20, f"got {len(found)} drivers for k=25 with 25 in range; the search must ask Redis for COUNT 20 candidates"
    dists = [row[1] for row in found]
    assert dists == sorted(dists), f"results must be nearest first: distances {dists}"
    assert _ids(found)[:3] == ["d-1", "d-2", "d-3"], f"the nearest three are d-1, d-2, d-3, got {_ids(found)[:3]}"
    assert abs(float(dists[0]) - 0.111) < 0.02, f"distances must be in km from WITHDIST: d-1 is 0.11 km away, got {dists[0]}"
    assert abs(float(dists[9]) - 1.112) < 0.03, f"d-10 is 1.11 km away, got {dists[9]}"


async def check_presence_mget(ctx):
    _seed(ctx, "paris", ("d-2", 48.857, 2.35))
    ctx.clock.advance(31)  # d-2 went silent: its presence key expired
    _seed(ctx, "paris", ("d-7", 48.852, 2.352), ("d-9", 48.86, 2.37))
    _seed(ctx, "paris", ("d-5", 48.83, 2.35), seen=False)
    m, calls, commands = _dispatcher(ctx)
    found = m.nearest("paris", PICKUP[0], PICKUP[1], 10)
    assert _ids(found) == ["d-7", "d-9"], f"nearest returned {_ids(found)}, expected [d-7, d-9]: d-2 and d-5 have no driver:{{id}}:seen key"
    assert commands.count("MGET") == 1, f"presence must be one MGET over every candidate's seen key; MGET was sent {commands.count('MGET')} times (commands: {commands})"
    assert commands.count("GET") == 0, f"no GET per driver: {commands.count('GET')} GETs were sent (commands: {commands})"
    assert all(d not in sum(calls, []) for d in ("d-2", "d-5")), f"silent drivers must be dropped before asking driver_status, which saw {calls}"


async def check_available_only(ctx):
    _seed(ctx, "paris", ("d-7", 48.852, 2.352), ("d-2", 48.857, 2.35), ("d-9", 48.86, 2.37), ("d-5", 48.83, 2.35))
    m, calls, commands = _dispatcher(ctx, {"d-7": "on_trip", "d-9": "offline"})
    found = m.nearest("paris", PICKUP[0], PICKUP[1], 10)
    assert _ids(found) == ["d-2", "d-5"], f"nearest returned {_ids(found)}, expected [d-2, d-5]: d-7 is on_trip and d-9 offline"
    assert len(calls) == 1, f"driver_status must be asked once with every live candidate, it was called {len(calls)} times: {calls}"
    assert sorted(calls[0]) == ["d-2", "d-5", "d-7", "d-9"], f"driver_status was asked about {calls[0]}, expected the four live candidates"


async def check_top_k(ctx):
    _seed(ctx, "paris", ("d-7", 48.852, 2.352), ("d-2", 48.857, 2.35), ("d-9", 48.86, 2.37), ("d-5", 48.83, 2.35), ("d-3", 48.87, 2.36))
    m, calls, commands = _dispatcher(ctx)
    found = m.nearest("paris", PICKUP[0], PICKUP[1], 2)
    assert len(found) == 2, f"k=2 but nearest returned {len(found)} drivers: {_ids(found)}"
    assert _ids(found) == ["d-7", "d-2"], f"the two nearest are d-7 and d-2, got {_ids(found)}"
    found = m.nearest("paris", PICKUP[0], PICKUP[1], 10)
    assert len(found) == 5, f"k=10 with five drivers in range must return all five, got {len(found)}"
    m, calls, commands = _dispatcher(ctx, {"d-7": "on_trip"})
    found = m.nearest("paris", PICKUP[0], PICKUP[1], 2)
    assert _ids(found) == ["d-2", "d-9"], f"with d-7 on a trip the top 2 are d-2 and d-9, got {_ids(found)}: filter first, then cut to k"
`,
    typescript: `const PICKUP: [number, number] = [48.85, 2.35]; // lat, lng

type Seeded = [driverId: string, lat: number, lng: number];

/** Writes the GEO member and, by default, a live presence key for every driver. */
function seed(ctx, city: string, drivers: Seeded[], seen = true) {
  for (const [driverId, lat, lng] of drivers) {
    ctx.redis.geoadd(\`drivers:\${city}\`, lng, lat, driverId);
    if (seen) ctx.redis.set(\`driver:\${driverId}:seen\`, '1000', 'EX', 30);
  }
}

/** The learner's module with the provided driver store answering from \`statuses\` (default available). */
function dispatcher(ctx, statuses: Record<string, string> = {}) {
  const m = ctx.load('nearest');
  const calls: string[][] = [];
  m.store.driverStatus = async (driverIds: string[]) => {
    calls.push([...driverIds]);
    return Object.fromEntries(driverIds.map(d => [d, statuses[d] ?? 'available']));
  };
  return {m, calls};
}

const ids = (found: [string, number][]): string[] => found.map(row => row[0]);

export async function check_geosearch(ctx) {
  seed(ctx, 'paris', [['d-7', 48.852, 2.352], ['d-9', 48.86, 2.37], ['d-far', 48.9, 2.35]]);
  seed(ctx, 'lyon', [['d-l', 45.76, 4.84]]);
  const {m} = dispatcher(ctx);
  let found = await m.nearest('paris', PICKUP[0], PICKUP[1], 10);
  assert(Array.isArray(found), \`nearest must return an array, got \${typeof found}\`);
  assert.deepEqual(ids(found), ['d-7', 'd-9'], \`nearest(paris) returned \${JSON.stringify(ids(found))}, expected [d-7, d-9]: within 3 km of (lat 48.85, lng 2.35), lng before lat in the search\`);
  assert(!ids(found).includes('d-far'), 'd-far is 5.6 km away and must be outside the 3 km radius');
  found = await m.nearest('lyon', 45.76, 4.84, 10);
  assert.deepEqual(ids(found), ['d-l'], \`nearest(lyon) returned \${JSON.stringify(ids(found))}, expected [d-l]: the search is on drivers:{city}\`);
}

export async function check_sorted_bounded(ctx) {
  // ~0.111 km apart, 25 within 3 km, seeded in a fixed shuffled order.
  const drivers: Seeded[] = Array.from({length: 25}, (_, i) => [\`d-\${i + 1}\`, 48.85 + (i + 1) / 1000, 2.35]);
  let state = 7;
  for (let i = drivers.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [drivers[i], drivers[j]] = [drivers[j], drivers[i]];
  }
  seed(ctx, 'paris', drivers);
  const {m} = dispatcher(ctx);
  const found = await m.nearest('paris', PICKUP[0], PICKUP[1], 25);
  assert.equal(found.length, 20, \`got \${found.length} drivers for k=25 with 25 in range; the search must ask Redis for COUNT 20 candidates\`);
  const dists = found.map(row => Number(row[1]));
  assert.deepEqual(dists, [...dists].sort((a, b) => a - b), \`results must be nearest first: distances \${JSON.stringify(dists)}\`);
  assert.deepEqual(ids(found).slice(0, 3), ['d-1', 'd-2', 'd-3'], \`the nearest three are d-1, d-2, d-3, got \${JSON.stringify(ids(found).slice(0, 3))}\`);
  assert(Math.abs(dists[0] - 0.111) < 0.02, \`distances must be in km from WITHDIST: d-1 is 0.11 km away, got \${found[0][1]}\`);
  assert(Math.abs(dists[9] - 1.112) < 0.03, \`d-10 is 1.11 km away, got \${found[9][1]}\`);
}

export async function check_presence_mget(ctx) {
  seed(ctx, 'paris', [['d-2', 48.857, 2.35]]);
  ctx.clock.advance(31); // d-2 went silent: its presence key expired
  seed(ctx, 'paris', [['d-7', 48.852, 2.352], ['d-9', 48.86, 2.37]]);
  seed(ctx, 'paris', [['d-5', 48.83, 2.35]], false);
  const {m, calls} = dispatcher(ctx);
  const before = ctx.redisRoundTrips().length;
  const found = await m.nearest('paris', PICKUP[0], PICKUP[1], 10);
  const commands = ctx.redisRoundTrips().slice(before).flat();
  const got = ids(found);
  assert.deepEqual(got, ['d-7', 'd-9'], \`nearest returned \${JSON.stringify(got)}, expected [d-7, d-9]: d-2 and d-5 have no driver:{id}:seen key\`);
  const mgets = commands.filter(c => c === 'MGET').length;
  const gets = commands.filter(c => c === 'GET').length;
  assert.equal(mgets, 1, \`presence must be one MGET over every candidate's seen key; MGET was sent \${mgets} times (commands: \${JSON.stringify(commands)})\`);
  assert.equal(gets, 0, \`no GET per driver: \${gets} GETs were sent (commands: \${JSON.stringify(commands)})\`);
  const asked = calls.flat();
  assert(!asked.includes('d-2') && !asked.includes('d-5'), \`silent drivers must be dropped before asking the driver store, which saw \${JSON.stringify(calls)}\`);
}

export async function check_available_only(ctx) {
  seed(ctx, 'paris', [['d-7', 48.852, 2.352], ['d-2', 48.857, 2.35], ['d-9', 48.86, 2.37], ['d-5', 48.83, 2.35]]);
  const {m, calls} = dispatcher(ctx, {'d-7': 'on_trip', 'd-9': 'offline'});
  const found = await m.nearest('paris', PICKUP[0], PICKUP[1], 10);
  assert.deepEqual(ids(found), ['d-2', 'd-5'], \`nearest returned \${JSON.stringify(ids(found))}, expected [d-2, d-5]: d-7 is on_trip and d-9 offline\`);
  assert.equal(calls.length, 1, \`the driver store must be asked once with every live candidate, it was called \${calls.length} times: \${JSON.stringify(calls)}\`);
  assert.deepEqual([...calls[0]].sort(), ['d-2', 'd-5', 'd-7', 'd-9'], \`the driver store was asked about \${JSON.stringify(calls[0])}, expected the four live candidates\`);
}

export async function check_top_k(ctx) {
  seed(ctx, 'paris', [['d-7', 48.852, 2.352], ['d-2', 48.857, 2.35], ['d-9', 48.86, 2.37], ['d-5', 48.83, 2.35], ['d-3', 48.87, 2.36]]);
  let {m} = dispatcher(ctx);
  let found = await m.nearest('paris', PICKUP[0], PICKUP[1], 2);
  assert.equal(found.length, 2, \`k=2 but nearest returned \${found.length} drivers: \${JSON.stringify(ids(found))}\`);
  assert.deepEqual(ids(found), ['d-7', 'd-2'], \`the two nearest are d-7 and d-2, got \${JSON.stringify(ids(found))}\`);
  found = await m.nearest('paris', PICKUP[0], PICKUP[1], 10);
  assert.equal(found.length, 5, \`k=10 with five drivers in range must return all five, got \${found.length}\`);
  ({m} = dispatcher(ctx, {'d-7': 'on_trip'}));
  found = await m.nearest('paris', PICKUP[0], PICKUP[1], 2);
  assert.deepEqual(ids(found), ['d-2', 'd-9'], \`with d-7 on a trip the top 2 are d-2 and d-9, got \${JSON.stringify(ids(found))}: filter first, then cut to k\`);
}
`,
  },
  debrief: `Redis does the geometry — geohash-encoded sorted set, radius query, sort, distance — and the service does the two things Redis cannot know: who is still reporting and who is free. Asking for more candidates than you need (\`COUNT 20\` for \`k = 3\`) is what keeps the result full after the filters. Real dispatchers query several neighbouring cells instead of one radius, weight drivers by ETA rather than straight-line distance, include drivers about to finish a trip, and run the match as a batch over many riders instead of one at a time.`,
};
