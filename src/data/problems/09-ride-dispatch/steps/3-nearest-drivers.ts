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
  debrief: `Redis does the geometry — geohash-encoded sorted set, radius query, sort, distance — and the service does the two things Redis cannot know: who is still reporting and who is free. Asking for more candidates than you need (\`COUNT 20\` for \`k = 3\`) is what keeps the result full after the filters. Real dispatchers query several neighbouring cells instead of one radius, weight drivers by ETA rather than straight-line distance, include drivers about to finish a trip, and run the match as a batch over many riders instead of one at a time.`,
};
