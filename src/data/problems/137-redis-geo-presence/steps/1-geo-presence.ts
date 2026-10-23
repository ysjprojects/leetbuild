import type {Step} from '@/lib/types';

export const geoPresenceStep: Step = {
  id: 'geo-presence',
  title: 'Nearest with presence: GEO plus heartbeats',
  concept: 'redis',
  file: 'geo_presence',
  focus: ['dispatch', 'redis'],
  task: `## Task

Four functions over one GEO set, \`drivers\`, and one presence key per driver, \`seen:{driver_id}\`,
with a 30 s TTL (\`PRESENCE_TTL_S\`). The GEO set says where a driver last was; the presence key says
whether it has reported in the last 30 s. A driver is *near* only if both agree.

- \`heartbeat(driver_id, lat, lon)\`: \`GEOADD drivers lon lat driver_id\` and \`SET seen:{driver_id} 1 EX 30\`
  in **one pipeline** — one round trip. A second heartbeat moves the member and resets the TTL to a full 30 s.
- \`nearest(lat, lon, radius_km, k) → [(driver_id, distance_km)]\`, nearest first, distances in km
  **rounded to 3 decimals**: \`GEOSEARCH drivers FROMLONLAT lon lat BYRADIUS radius_km km ASC COUNT 4k WITHDIST\`
  (\`OVERFETCH = 4\`), then **one \`MGET\`** of every candidate's \`seen:\` key, drop the candidates whose key is
  gone, return the first \`k\`. At most **two round trips**; no candidates → \`[]\` after the search. A driver
  whose heartbeat is older than 30 s is never returned, even though the GEO set still holds it.
- \`remove(driver_id)\`: \`ZREM drivers driver_id\` and \`DEL seen:{driver_id}\` in one pipeline. Unknown ids are a no-op.
- \`sweep(limit) → int\`: \`ZRANGE drivers 0 limit-1\`, one \`MGET\` of their \`seen:\` keys, \`ZREM\` the members whose
  key is gone, and return how many were removed. Live members are never touched; nothing stale → \`0\`.

> The GEO set is a sorted set with geohash scores: it answers *where*, never *whether*. Liveness is a
> TTL key that disappears by itself — so the query is always two facts joined client-side, and it
> over-fetches because the filter can only shrink the list.`,
  sequence: {
    participants: ['driver app', 'dispatch', 'Redis'],
    messages: [
      {from: 'driver app', to: 'dispatch', label: 'heartbeat(d-7, 48.852, 2.352)', kind: 'async'},
      {
        from: 'dispatch',
        to: 'Redis',
        label: 'MULTI · GEOADD drivers 2.352 48.852 d-7 · SET seen:d-7 1 EX 30 · EXEC',
        kind: 'sync',
      },
      {
        from: 'dispatch',
        to: 'Redis',
        label: 'GEOSEARCH drivers FROMLONLAT 2.35 48.85 BYRADIUS 3 km ASC COUNT 8 WITHDIST',
        kind: 'sync',
      },
      {from: 'Redis', to: 'dispatch', label: '[d-2 0.11] [d-7 0.26] [d-9 1.83] …', kind: 'reply'},
      {from: 'dispatch', to: 'Redis', label: 'MGET seen:d-2 seen:d-7 seen:d-9 …', kind: 'sync'},
      {from: 'Redis', to: 'dispatch', label: '[nil, "1", "1", …] — d-2 went silent 40 s ago', kind: 'reply'},
      {from: 'dispatch', to: 'driver app', label: 'nearest(k=2) → [(d-7, 0.26), (d-9, 1.83)]', kind: 'reply'},
    ],
  },
  hints: [
    'Longitude comes first in every GEO command (`GEOADD key lon lat member`, `FROMLONLAT lon lat`), while the function takes `lat, lon`. Ask for `WITHDIST` and let Redis sort (`ASC`) — do no geometry yourself.',
    '`MGET` returns one entry per key in the order you asked; zip it with the candidates and keep those whose entry is not null. Never `GET`/`EXISTS` per driver: that is 4k round trips for one search.',
    'If you ask Redis for exactly `k` candidates, a single silent driver among them leaves you with `k − 1`. Ask for `OVERFETCH * k`, filter, then cut to `k`. `sweep` is the same join on `ZRANGE 0 limit-1` instead of a radius.',
  ],
  checks: [
    {
      id: 'heartbeat-pipeline',
      title: 'Heartbeat writes the position and a 30 s presence key in one pipeline',
      detail:
        '`GEOADD drivers lon lat driver_id` and `SET seen:{driver_id} 1 EX 30` queued on one pipeline and executed once; a second heartbeat moves the member and resets the TTL to 30; after 30 s without one the presence key is gone while the GEO member remains.',
      match: {
        python: {
          all: [
            /\br\.pipeline\(/,
            /pipe\.geoadd\(\s*GEO_KEY/,
            /pipe\.set\(\s*seen_key\(driver_id\),\s*1,\s*ex=PRESENCE_TTL_S\)/,
          ],
        },
        typescript: {
          all: [
            /\bredis\s*\.pipeline\(\)/,
            /\.geoadd\(\s*GEO_KEY/,
            /\.set\(\s*seenKey\(driverId\),\s*1,\s*'EX',\s*PRESENCE_TTL_S\)/,
          ],
        },
        go: {
          all: [
            /rdb\.Pipeline\(\)/,
            /pipe\.GeoAdd\(ctx, geoKey/,
            /pipe\.Set\(ctx, seenKey\(driverID\), 1, presenceTTL\)/,
          ],
        },
        scala: {
          all: [
            /jedis\.pipelined\(\)/,
            /pipeline\.geoadd\(\s*GeoKey/,
            /pipeline\.set\(\s*seenKey\(driverId\),\s*"1",\s*SetParams\.setParams\(\)\.ex\(PresenceTtlS\)\)/,
          ],
        },
        cpp: {
          all: [
            /redis\.pipeline\(\)/,
            /\.geoadd\(\s*kGeoKey/,
            /\.set\(\s*seen_key\(driver_id\),\s*"1",\s*kPresenceTtl\)/,
          ],
        },
      },
    },
    {
      id: 'radius-order',
      title: 'Searches by radius from (lon, lat), nearest first, distances rounded to 3 decimals',
      detail:
        'One `GEOSEARCH drivers FROMLONLAT lon lat BYRADIUS radius_km km ASC … WITHDIST`: members outside the radius are absent, the rest come nearest first, and each distance is the km from `WITHDIST` rounded to 3 decimals.',
      match: {
        python: {
          all: [
            /\br\.geosearch\(\s*GEO_KEY/,
            /longitude\s*=\s*lon\b/,
            /latitude\s*=\s*lat\b/,
            /radius\s*=\s*radius_km\b/,
            /sort\s*=\s*"ASC"/,
            /withdist\s*=\s*True/,
            /round\(\s*float\(\s*dist\s*\)\s*,\s*3\s*\)/,
          ],
        },
        typescript: {
          all: [
            /\bredis\.geosearch\(\s*GEO_KEY/,
            /'FROMLONLAT',\s*lon,\s*lat/,
            /'BYRADIUS',\s*radiusKm,\s*'km'/,
            /'ASC'/,
            /'WITHDIST'/,
            /Math\.round\(\s*Number\(\s*dist\s*\)\s*\*\s*1000\s*\)\s*\/\s*1000/,
          ],
        },
        go: {
          all: [
            /rdb\.GeoSearchLocation\(ctx, geoKey/,
            /Longitude:\s*lon\b/,
            /Latitude:\s*lat\b/,
            /Radius:\s*radiusKm\b/,
            /Sort:\s*"ASC"/,
            /WithDist:\s*true/,
            /math\.Round\(\s*loc\.Dist\s*\*\s*1000\s*\)\s*\/\s*1000/,
          ],
        },
        scala: {
          all: [
            /jedis\.geosearch\(\s*GeoKey/,
            /fromLonLat\(\s*lon\s*,\s*lat\s*\)/,
            /byRadius\(\s*radiusKm\s*,\s*GeoUnit\.KM\s*\)/,
            /\.asc\(\)/,
            /\.withDist\(\)/,
            /math\.round\(\s*\w+\.getDistance\s*\*\s*1000\s*\)\s*\/\s*1000\.0/,
          ],
        },
        cpp: {
          all: [
            /redis\.georadius\(\s*kGeoKey/,
            /std::make_pair\(\s*lon\s*,\s*lat\s*\)/,
            /radius_km\s*,\s*GeoUnit::KM/,
            /std::round\(\s*dist\s*\*\s*1000\s*\)\s*\/\s*1000/,
          ],
        },
      },
    },
    {
      id: 'stale-excluded',
      title: 'A driver whose heartbeat expired is never returned, in two round trips',
      detail:
        'After the search, one `MGET` over every candidate’s `seen:` key drops the drivers whose key has expired — the GEO set still holds them — and `nearest` costs at most two round trips: no `GET` or `EXISTS` per driver.',
      match: {
        python: {
          order: [/\br\.geosearch\(/, /\br\.mget\(/],
          all: [/\bflag is not None\b/],
          none: [/\br\.get\(/, /\br\.exists\(/, /\br\.ttl\(/],
        },
        typescript: {
          order: [/\bredis\.geosearch\(/, /\bredis\.mget\(/],
          all: [/seen\[i\] !== null/],
          none: [/\bredis\.get\(/, /\bredis\.exists\(/, /\bredis\.ttl\(/],
        },
        go: {
          order: [/rdb\.GeoSearchLocation\(/, /rdb\.MGet\(/],
          all: [/seen\[i\] == nil/],
          none: [/rdb\.Get\(/, /rdb\.Exists\(/, /rdb\.TTL\(/],
        },
        scala: {
          order: [/jedis\.geosearch\(/, /jedis\.mget\(/],
          all: [/\bflag != null\b/],
          none: [/jedis\.get\(/, /jedis\.exists\(/, /jedis\.ttl\(/],
        },
        cpp: {
          order: [/redis\.georadius\(/, /redis\.mget\(/],
          all: [/if \(!seen\[i\]\) continue;/],
          none: [/redis\.get\(/, /redis\.exists\(/, /redis\.ttl\(/],
        },
      },
    },
    {
      id: 'overfetch-k',
      title: 'Over-fetches 4k candidates and returns the first k live ones',
      detail:
        '`COUNT OVERFETCH * k` on the search so silent drivers among the nearest do not empty the result; after the presence filter the list is cut to `k`.',
      match: {
        python: {all: [/count\s*=\s*OVERFETCH\s*\*\s*k\b/, /\[\s*:\s*k\s*\]/]},
        typescript: {all: [/'COUNT',\s*OVERFETCH\s*\*\s*k\b/, /\.slice\(\s*0\s*,\s*k\s*\)/]},
        go: {all: [/Count:\s*overfetch\s*\*\s*k\b/, /len\(\s*out\s*\)\s*==\s*k\b/]},
        scala: {all: [/\.count\(\s*OverFetch\s*\*\s*k\s*\)/, /\.take\(\s*k\s*\)/]},
        cpp: {all: [/kOverFetch\s*\*\s*static_cast<long long>\(\s*k\s*\)/, /out\.size\(\)\s*<\s*k\b/]},
      },
    },
    {
      id: 'remove-both',
      title: 'remove deletes the GEO member and the presence key',
      detail:
        '`ZREM drivers driver_id` and `DEL seen:{driver_id}` in one pipeline: the driver is gone from `nearest` at once; other drivers are untouched; an unknown id is a no-op.',
      match: {
        python: {all: [/pipe\.zrem\(\s*GEO_KEY,\s*driver_id\s*\)/, /pipe\.delete\(\s*seen_key\(driver_id\)\s*\)/]},
        typescript: {all: [/\.zrem\(\s*GEO_KEY,\s*driverId\s*\)/, /\.del\(\s*seenKey\(driverId\)\s*\)/]},
        go: {all: [/pipe\.ZRem\(ctx, geoKey, driverID\)/, /pipe\.Del\(ctx, seenKey\(driverID\)\)/]},
        scala: {all: [/pipeline\.zrem\(\s*GeoKey,\s*driverId\s*\)/, /pipeline\.del\(\s*seenKey\(driverId\)\s*\)/]},
        cpp: {all: [/\.zrem\(\s*kGeoKey,\s*driver_id\s*\)/, /\.del\(\s*seen_key\(driver_id\)\s*\)/]},
      },
    },
    {
      id: 'sweep-stale',
      title: 'sweep removes only members whose presence key is gone and reports the count',
      detail:
        '`ZRANGE drivers 0 limit-1`, one `MGET` of their `seen:` keys, `ZREM` of the ones with no key; returns how many were removed, `0` when none, and never touches a live member or a presence key.',
      match: {
        python: {
          order: [
            /\br\.zrange\(\s*GEO_KEY,\s*0,\s*limit\s*-\s*1\s*\)/,
            /\br\.mget\(/,
            /\br\.zrem\(\s*GEO_KEY,\s*\*stale\s*\)/,
          ],
          all: [/return len\(stale\)/],
        },
        typescript: {
          order: [
            /\bredis\.zrange\(\s*GEO_KEY,\s*0,\s*limit\s*-\s*1\s*\)/,
            /\bredis\.mget\(/,
            /\bredis\.zrem\(\s*GEO_KEY,\s*\.\.\.stale\s*\)/,
          ],
          all: [/return stale\.length/],
        },
        go: {
          order: [/rdb\.ZRange\(ctx, geoKey, 0, int64\(limit-1\)\)/, /rdb\.MGet\(/, /rdb\.ZRem\(ctx, geoKey, stale/],
          all: [/return len\(stale\), nil/],
        },
        scala: {
          order: [
            /jedis\.zrange\(\s*GeoKey,\s*0,\s*limit\s*-\s*1\s*\)/,
            /jedis\.mget\(/,
            /jedis\.zrem\(\s*GeoKey,\s*stale/,
          ],
          all: [/stale\.size/],
        },
        cpp: {
          order: [
            /redis\.zrange\(\s*kGeoKey,\s*0,\s*limit\s*-\s*1/,
            /redis\.mget\(/,
            /redis\.zrem\(\s*kGeoKey,\s*stale\.begin\(\),\s*stale\.end\(\)\s*\)/,
          ],
          all: [/return stale\.size\(\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Nearest live drivers: a GEO set for position, one presence key per driver for liveness."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

GEO_KEY = "drivers"
PRESENCE_TTL_S = 30
OVERFETCH = 4


def seen_key(driver_id: str) -> str:
    return f"seen:{driver_id}"


def heartbeat(driver_id: str, lat: float, lon: float) -> None:
    """GEOADD drivers lon lat driver_id and SET seen:{driver_id} 1 EX 30, on one pipeline."""
    # TODO
    raise NotImplementedError


def nearest(lat: float, lon: float, radius_km: float, k: int) -> list[tuple[str, float]]:
    """The k closest drivers with a live heartbeat, nearest first, as (driver_id, km rounded to 3 decimals)."""
    # TODO: GEOSEARCH drivers FROMLONLAT lon lat BYRADIUS radius_km km ASC COUNT OVERFETCH * k WITHDIST
    # TODO: one MGET over seen:{driver_id}; drop the candidates whose key is gone; first k
    raise NotImplementedError


def remove(driver_id: str) -> None:
    """ZREM drivers driver_id and DEL seen:{driver_id}, on one pipeline."""
    # TODO
    raise NotImplementedError


def sweep(limit: int) -> int:
    """ZRANGE drivers 0 limit-1, one MGET of their seen: keys, ZREM the members whose key is gone; how many."""
    # TODO
    raise NotImplementedError
`,
      solution: `"""Nearest live drivers: a GEO set for position, one presence key per driver for liveness."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

GEO_KEY = "drivers"
PRESENCE_TTL_S = 30
OVERFETCH = 4


def seen_key(driver_id: str) -> str:
    return f"seen:{driver_id}"


def heartbeat(driver_id: str, lat: float, lon: float) -> None:
    """GEOADD drivers lon lat driver_id and SET seen:{driver_id} 1 EX 30, on one pipeline."""
    pipe = r.pipeline()
    pipe.geoadd(GEO_KEY, [lon, lat, driver_id])  # longitude first
    pipe.set(seen_key(driver_id), 1, ex=PRESENCE_TTL_S)
    pipe.execute()


def nearest(lat: float, lon: float, radius_km: float, k: int) -> list[tuple[str, float]]:
    """The k closest drivers with a live heartbeat, nearest first, as (driver_id, km rounded to 3 decimals)."""
    found = r.geosearch(
        GEO_KEY,
        longitude=lon,
        latitude=lat,
        radius=radius_km,
        unit="km",
        sort="ASC",
        count=OVERFETCH * k,
        withdist=True,
    )
    if not found:
        return []
    seen = r.mget([seen_key(driver_id) for driver_id, _dist in found])
    live = [(driver_id, round(float(dist), 3)) for (driver_id, dist), flag in zip(found, seen) if flag is not None]
    return live[:k]


def remove(driver_id: str) -> None:
    """ZREM drivers driver_id and DEL seen:{driver_id}, on one pipeline."""
    pipe = r.pipeline()
    pipe.zrem(GEO_KEY, driver_id)
    pipe.delete(seen_key(driver_id))
    pipe.execute()


def sweep(limit: int) -> int:
    """ZRANGE drivers 0 limit-1, one MGET of their seen: keys, ZREM the members whose key is gone; how many."""
    members = r.zrange(GEO_KEY, 0, limit - 1)
    if not members:
        return 0
    seen = r.mget([seen_key(member) for member in members])
    stale = [member for member, flag in zip(members, seen) if flag is None]
    if stale:
        r.zrem(GEO_KEY, *stale)
    return len(stale)
`,
    },
    typescript: {
      starter: `/** Nearest live drivers: a GEO set for position, one presence key per driver for liveness. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const GEO_KEY = 'drivers';
export const PRESENCE_TTL_S = 30;
export const OVERFETCH = 4;

/** One driver with its distance from the search point, in km rounded to 3 decimals. */
export type Near = [driverId: string, distanceKm: number];

export const seenKey = (driverId: string): string => \`seen:\${driverId}\`;

/** GEOADD drivers lon lat driverId and SET seen:{driverId} 1 EX 30, on one pipeline. */
export async function heartbeat(driverId: string, lat: number, lon: number): Promise<void> {
  // TODO
  throw new Error('not implemented');
}

/** The k closest drivers with a live heartbeat, nearest first. */
export async function nearest(lat: number, lon: number, radiusKm: number, k: number): Promise<Near[]> {
  // TODO: GEOSEARCH drivers FROMLONLAT lon lat BYRADIUS radiusKm km ASC COUNT OVERFETCH * k WITHDIST
  // TODO: one MGET over seen:{driverId}; drop the candidates whose key is gone; first k
  throw new Error('not implemented');
}

/** ZREM drivers driverId and DEL seen:{driverId}, on one pipeline. */
export async function remove(driverId: string): Promise<void> {
  // TODO
  throw new Error('not implemented');
}

/** ZRANGE drivers 0 limit-1, one MGET of their seen: keys, ZREM the members whose key is gone; how many. */
export async function sweep(limit: number): Promise<number> {
  // TODO
  throw new Error('not implemented');
}
`,
      solution: `/** Nearest live drivers: a GEO set for position, one presence key per driver for liveness. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const GEO_KEY = 'drivers';
export const PRESENCE_TTL_S = 30;
export const OVERFETCH = 4;

/** One driver with its distance from the search point, in km rounded to 3 decimals. */
export type Near = [driverId: string, distanceKm: number];

export const seenKey = (driverId: string): string => \`seen:\${driverId}\`;

/** GEOADD drivers lon lat driverId and SET seen:{driverId} 1 EX 30, on one pipeline. */
export async function heartbeat(driverId: string, lat: number, lon: number): Promise<void> {
  await redis
    .pipeline()
    .geoadd(GEO_KEY, lon, lat, driverId) // longitude first
    .set(seenKey(driverId), 1, 'EX', PRESENCE_TTL_S)
    .exec();
}

/** The k closest drivers with a live heartbeat, nearest first. */
export async function nearest(lat: number, lon: number, radiusKm: number, k: number): Promise<Near[]> {
  const found = (await redis.geosearch(
    GEO_KEY,
    'FROMLONLAT',
    lon,
    lat,
    'BYRADIUS',
    radiusKm,
    'km',
    'ASC',
    'COUNT',
    OVERFETCH * k,
    'WITHDIST',
  )) as [string, string][];
  if (found.length === 0) return [];
  const seen = await redis.mget(found.map(([driverId]) => seenKey(driverId)));
  const live: Near[] = [];
  for (const [i, [driverId, dist]] of found.entries()) {
    if (seen[i] !== null) live.push([driverId, Math.round(Number(dist) * 1000) / 1000]);
  }
  return live.slice(0, k);
}

/** ZREM drivers driverId and DEL seen:{driverId}, on one pipeline. */
export async function remove(driverId: string): Promise<void> {
  await redis.pipeline().zrem(GEO_KEY, driverId).del(seenKey(driverId)).exec();
}

/** ZRANGE drivers 0 limit-1, one MGET of their seen: keys, ZREM the members whose key is gone; how many. */
export async function sweep(limit: number): Promise<number> {
  const members = await redis.zrange(GEO_KEY, 0, limit - 1);
  if (members.length === 0) return 0;
  const seen = await redis.mget(members.map(seenKey));
  const stale = members.filter((_, i) => seen[i] === null);
  if (stale.length > 0) await redis.zrem(GEO_KEY, ...stale);
  return stale.length;
}
`,
    },
    go: {
      starter: `// Nearest live drivers: a GEO set for position, one presence key per driver for liveness.
package main

import (
	"context"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	geoKey      = "drivers"
	presenceTTL = 30 * time.Second
	overfetch   = 4
)

// Near is one driver with its distance from the search point, in km rounded to 3 decimals.
type Near struct {
	DriverID string
	Dist     float64
}

func seenKey(driverID string) string { return "seen:" + driverID }

// heartbeat GEOADDs drivers lon lat driverID and SETs seen:{driverID} 1 EX 30, on one pipeline.
func heartbeat(ctx context.Context, driverID string, lat, lon float64) error {
	// TODO
	return nil
}

// nearest returns the k closest drivers with a live heartbeat, nearest first.
func nearest(ctx context.Context, lat, lon, radiusKm float64, k int) ([]Near, error) {
	// TODO: GeoSearchLocation drivers {Longitude: lon, Latitude: lat, Radius: radiusKm, RadiusUnit: "km", Sort: "ASC", Count: overfetch * k}, WithDist
	// TODO: one MGet over seen:{driverID}; drop the candidates whose key is gone (nil); first k
	_ = math.Round
	return nil, nil
}

// remove ZREMs drivers driverID and DELs seen:{driverID}, on one pipeline.
func remove(ctx context.Context, driverID string) error {
	// TODO
	return nil
}

// sweep ZRANGEs drivers 0 limit-1, MGets their seen: keys, ZREMs the members whose key is gone; how many.
func sweep(ctx context.Context, limit int) (int, error) {
	// TODO
	return 0, nil
}

func main() {
	ctx := context.Background()
	_ = heartbeat(ctx, "d-7", 48.852, 2.352)
	_, _ = nearest(ctx, 48.85, 2.35, 3, 2)
	_, _ = sweep(ctx, 100)
	_ = remove(ctx, "d-7")
}
`,
      solution: `// Nearest live drivers: a GEO set for position, one presence key per driver for liveness.
package main

import (
	"context"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	geoKey      = "drivers"
	presenceTTL = 30 * time.Second
	overfetch   = 4
)

// Near is one driver with its distance from the search point, in km rounded to 3 decimals.
type Near struct {
	DriverID string
	Dist     float64
}

func seenKey(driverID string) string { return "seen:" + driverID }

// heartbeat GEOADDs drivers lon lat driverID and SETs seen:{driverID} 1 EX 30, on one pipeline.
func heartbeat(ctx context.Context, driverID string, lat, lon float64) error {
	pipe := rdb.Pipeline()
	pipe.GeoAdd(ctx, geoKey, &redis.GeoLocation{Name: driverID, Longitude: lon, Latitude: lat}) // longitude first
	pipe.Set(ctx, seenKey(driverID), 1, presenceTTL)
	_, err := pipe.Exec(ctx)
	return err
}

// nearest returns the k closest drivers with a live heartbeat, nearest first.
func nearest(ctx context.Context, lat, lon, radiusKm float64, k int) ([]Near, error) {
	found, err := rdb.GeoSearchLocation(ctx, geoKey, &redis.GeoSearchLocationQuery{
		GeoSearchQuery: redis.GeoSearchQuery{Longitude: lon, Latitude: lat, Radius: radiusKm, RadiusUnit: "km", Sort: "ASC", Count: overfetch * k},
		WithDist:       true,
	}).Result()
	if err != nil || len(found) == 0 {
		return nil, err
	}
	keys := make([]string, len(found))
	for i, loc := range found {
		keys[i] = seenKey(loc.Name)
	}
	seen, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	out := make([]Near, 0, k)
	for i, loc := range found {
		if seen[i] == nil {
			continue // the GEO set remembers the driver; the heartbeat does not
		}
		out = append(out, Near{DriverID: loc.Name, Dist: math.Round(loc.Dist*1000) / 1000})
		if len(out) == k {
			break
		}
	}
	return out, nil
}

// remove ZREMs drivers driverID and DELs seen:{driverID}, on one pipeline.
func remove(ctx context.Context, driverID string) error {
	pipe := rdb.Pipeline()
	pipe.ZRem(ctx, geoKey, driverID)
	pipe.Del(ctx, seenKey(driverID))
	_, err := pipe.Exec(ctx)
	return err
}

// sweep ZRANGEs drivers 0 limit-1, MGets their seen: keys, ZREMs the members whose key is gone; how many.
func sweep(ctx context.Context, limit int) (int, error) {
	members, err := rdb.ZRange(ctx, geoKey, 0, int64(limit-1)).Result()
	if err != nil || len(members) == 0 {
		return 0, err
	}
	keys := make([]string, len(members))
	for i, member := range members {
		keys[i] = seenKey(member)
	}
	seen, err := rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return 0, err
	}
	stale := make([]interface{}, 0, len(members))
	for i, member := range members {
		if seen[i] == nil {
			stale = append(stale, member)
		}
	}
	if len(stale) > 0 {
		if err := rdb.ZRem(ctx, geoKey, stale...).Err(); err != nil {
			return 0, err
		}
	}
	return len(stale), nil
}

func main() {
	ctx := context.Background()
	_ = heartbeat(ctx, "d-7", 48.852, 2.352)
	_, _ = nearest(ctx, 48.85, 2.35, 3, 2)
	_, _ = sweep(ctx, 100)
	_ = remove(ctx, "d-7")
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.args.GeoUnit
import redis.clients.jedis.params.{GeoSearchParam, SetParams}
import scala.jdk.CollectionConverters._

/** Nearest live drivers: a GEO set for position, one presence key per driver for liveness. */
object GeoPresence {
  val jedis = new JedisPooled("redis", 6379)
  val GeoKey = "drivers"
  val PresenceTtlS = 30L
  val OverFetch = 4

  /** One driver with its distance from the search point, in km rounded to 3 decimals. */
  final case class Near(driverId: String, distanceKm: Double)

  def seenKey(driverId: String): String = s"seen:$driverId"

  /** GEOADD drivers lon lat driverId and SET seen:{driverId} 1 EX 30, on one pipeline. */
  def heartbeat(driverId: String, lat: Double, lon: Double): Unit = {
    ??? // TODO
  }

  /** The k closest drivers with a live heartbeat, nearest first. */
  def nearest(lat: Double, lon: Double, radiusKm: Double, k: Int): Seq[Near] = {
    // TODO: geosearch(GeoKey, new GeoSearchParam().fromLonLat(lon, lat).byRadius(radiusKm, GeoUnit.KM).asc().count(OverFetch * k).withDist())
    // TODO: one mget over seen:{driverId}; drop the candidates whose key is gone (null); take(k)
    ???
  }

  /** ZREM drivers driverId and DEL seen:{driverId}, on one pipeline. */
  def remove(driverId: String): Unit = {
    ??? // TODO
  }

  /** ZRANGE drivers 0 limit-1, one MGET of their seen: keys, ZREM the members whose key is gone; how many. */
  def sweep(limit: Int): Int = {
    ??? // TODO
  }

  def main(args: Array[String]): Unit = {
    heartbeat("d-7", 48.852, 2.352)
    println(nearest(48.85, 2.35, 3, 2))
    println(sweep(100))
    remove("d-7")
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.args.GeoUnit
import redis.clients.jedis.params.{GeoSearchParam, SetParams}
import scala.jdk.CollectionConverters._

/** Nearest live drivers: a GEO set for position, one presence key per driver for liveness. */
object GeoPresence {
  val jedis = new JedisPooled("redis", 6379)
  val GeoKey = "drivers"
  val PresenceTtlS = 30L
  val OverFetch = 4

  /** One driver with its distance from the search point, in km rounded to 3 decimals. */
  final case class Near(driverId: String, distanceKm: Double)

  def seenKey(driverId: String): String = s"seen:$driverId"

  /** GEOADD drivers lon lat driverId and SET seen:{driverId} 1 EX 30, on one pipeline. */
  def heartbeat(driverId: String, lat: Double, lon: Double): Unit = {
    val pipeline = jedis.pipelined()
    pipeline.geoadd(GeoKey, lon, lat, driverId) // longitude first
    pipeline.set(seenKey(driverId), "1", SetParams.setParams().ex(PresenceTtlS))
    pipeline.sync()
  }

  /** The k closest drivers with a live heartbeat, nearest first. */
  def nearest(lat: Double, lon: Double, radiusKm: Double, k: Int): Seq[Near] = {
    val params = new GeoSearchParam().fromLonLat(lon, lat).byRadius(radiusKm, GeoUnit.KM).asc().count(OverFetch * k).withDist()
    val found = jedis.geosearch(GeoKey, params).asScala.toSeq
    if (found.isEmpty) Nil
    else {
      val seen = jedis.mget(found.map(r => seenKey(r.getMemberByString)): _*).asScala
      found
        .zip(seen)
        .collect { case (r, flag) if flag != null => Near(r.getMemberByString, math.round(r.getDistance * 1000) / 1000.0) }
        .take(k)
    }
  }

  /** ZREM drivers driverId and DEL seen:{driverId}, on one pipeline. */
  def remove(driverId: String): Unit = {
    val pipeline = jedis.pipelined()
    pipeline.zrem(GeoKey, driverId)
    pipeline.del(seenKey(driverId))
    pipeline.sync()
  }

  /** ZRANGE drivers 0 limit-1, one MGET of their seen: keys, ZREM the members whose key is gone; how many. */
  def sweep(limit: Int): Int = {
    val members = jedis.zrange(GeoKey, 0, limit - 1).asScala.toSeq
    if (members.isEmpty) 0
    else {
      val seen = jedis.mget(members.map(seenKey): _*).asScala
      val stale = members.zip(seen).collect { case (member, flag) if flag == null => member }
      if (stale.nonEmpty) jedis.zrem(GeoKey, stale: _*)
      stale.size
    }
  }

  def main(args: Array[String]): Unit = {
    heartbeat("d-7", 48.852, 2.352)
    println(nearest(48.85, 2.35, 3, 2))
    println(sweep(100))
    remove("d-7")
  }
}
`,
    },
    cpp: {
      starter: `// Nearest live drivers: a GEO set for position, one presence key per driver for liveness.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cmath>
#include <iterator>
#include <string>
#include <tuple>
#include <vector>

using sw::redis::GeoUnit;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kGeoKey = "drivers";
constexpr std::chrono::seconds kPresenceTtl{30};
constexpr long long kOverFetch = 4;

// One driver with its distance from the search point, in km rounded to 3 decimals.
struct Near {
  std::string driver_id;
  double distance_km;
};

std::string seen_key(const std::string& driver_id) { return "seen:" + driver_id; }

// GEOADD drivers lon lat driver_id and SET seen:{driver_id} 1 EX 30, on one pipeline.
void heartbeat(const std::string& driver_id, double lat, double lon) {
  // TODO
}

// The k closest drivers with a live heartbeat, nearest first.
std::vector<Near> nearest(double lat, double lon, double radius_km, std::size_t k) {
  // TODO: georadius(kGeoKey, {lon, lat}, radius_km, GeoUnit::KM, kOverFetch * k, true /*asc*/, back_inserter of tuple<string, double> — WITHDIST)
  // TODO: one mget over seen:{driver_id}; drop the candidates whose key is gone (nullopt); stop at k
  return {};
}

// ZREM drivers driver_id and DEL seen:{driver_id}, on one pipeline.
void remove(const std::string& driver_id) {
  // TODO
}

// ZRANGE drivers 0 limit-1, one MGET of their seen: keys, ZREM the members whose key is gone; how many.
std::size_t sweep(long long limit) {
  // TODO
  return 0;
}

int main() {
  heartbeat("d-7", 48.852, 2.352);
  nearest(48.85, 2.35, 3, 2);
  sweep(100);
  remove("d-7");
}
`,
      solution: `// Nearest live drivers: a GEO set for position, one presence key per driver for liveness.
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cmath>
#include <iterator>
#include <string>
#include <tuple>
#include <vector>

using sw::redis::GeoUnit;

sw::redis::Redis redis("tcp://redis:6379");

const std::string kGeoKey = "drivers";
constexpr std::chrono::seconds kPresenceTtl{30};
constexpr long long kOverFetch = 4;

// One driver with its distance from the search point, in km rounded to 3 decimals.
struct Near {
  std::string driver_id;
  double distance_km;
};

std::string seen_key(const std::string& driver_id) { return "seen:" + driver_id; }

// GEOADD drivers lon lat driver_id and SET seen:{driver_id} 1 EX 30, on one pipeline.
void heartbeat(const std::string& driver_id, double lat, double lon) {
  auto pipe = redis.pipeline();
  pipe.geoadd(kGeoKey, std::make_tuple(driver_id, lon, lat))  // member, longitude, latitude
      .set(seen_key(driver_id), "1", kPresenceTtl);
  pipe.exec();
}

// The k closest drivers with a live heartbeat, nearest first.
std::vector<Near> nearest(double lat, double lon, double radius_km, std::size_t k) {
  std::vector<std::tuple<std::string, double>> found;  // (member, distance): the element type selects WITHDIST
  redis.georadius(kGeoKey, std::make_pair(lon, lat), radius_km, GeoUnit::KM, kOverFetch * static_cast<long long>(k), true,
                  std::back_inserter(found));
  if (found.empty()) return {};
  std::vector<std::string> keys;
  for (const auto& [driver_id, dist] : found) keys.push_back(seen_key(driver_id));
  std::vector<sw::redis::OptionalString> seen;
  redis.mget(keys.begin(), keys.end(), std::back_inserter(seen));
  std::vector<Near> out;
  for (std::size_t i = 0; i < found.size() && out.size() < k; ++i) {
    if (!seen[i]) continue;  // the GEO set remembers the driver; the heartbeat does not
    const auto& [driver_id, dist] = found[i];
    out.push_back(Near{driver_id, std::round(dist * 1000) / 1000});
  }
  return out;
}

// ZREM drivers driver_id and DEL seen:{driver_id}, on one pipeline.
void remove(const std::string& driver_id) {
  auto pipe = redis.pipeline();
  pipe.zrem(kGeoKey, driver_id).del(seen_key(driver_id));
  pipe.exec();
}

// ZRANGE drivers 0 limit-1, one MGET of their seen: keys, ZREM the members whose key is gone; how many.
std::size_t sweep(long long limit) {
  std::vector<std::string> members;
  redis.zrange(kGeoKey, 0, limit - 1, std::back_inserter(members));
  if (members.empty()) return 0;
  std::vector<std::string> keys;
  for (const auto& member : members) keys.push_back(seen_key(member));
  std::vector<sw::redis::OptionalString> seen;
  redis.mget(keys.begin(), keys.end(), std::back_inserter(seen));
  std::vector<std::string> stale;
  for (std::size_t i = 0; i < members.size(); ++i)
    if (!seen[i]) stale.push_back(members[i]);
  if (!stale.empty()) redis.zrem(kGeoKey, stale.begin(), stale.end());
  return stale.size();
}

int main() {
  heartbeat("d-7", 48.852, 2.352);
  nearest(48.85, 2.35, 3, 2);
  sweep(100);
  remove("d-7");
}
`,
    },
  },
  harness: {
    python: `import math

from leetbuild.metrics import METRICS

PICKUP = (48.85, 2.35)  # lat, lon
EARTH_KM = 6372.797560856  # the radius Redis's GEO commands use


def _km(lat1, lon1, lat2, lon2):
    """Great-circle distance the way GEOSEARCH WITHDIST computes it, independently of the learner."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


def _seed(ctx, *drivers, seen=True):
    """drivers: (driver_id, lat, lon). Writes the GEO member and, by default, a 30 s presence key — what a heartbeat leaves behind."""
    for driver_id, lat, lon in drivers:
        ctx.redis.geoadd("drivers", [lon, lat, driver_id])
        if seen:
            ctx.redis.set(f"seen:{driver_id}", 1, ex=30)


def _ids(found):
    return [row[0] for row in found]


def _pos(ctx, driver_id):
    pos = ctx.redis.geopos("drivers", driver_id)[0]
    return None if pos is None else (float(pos[0]), float(pos[1]))


def check_heartbeat_pipeline(ctx):
    m = ctx.load("geo_presence")
    before = METRICS.redis_trips
    m.heartbeat("d-a", 48.852, 2.352)
    trips = METRICS.redis_trips - before
    pos = _pos(ctx, "d-a")
    assert pos is not None, "heartbeat must GEOADD the driver to the GEO set drivers"
    assert abs(pos[0] - 2.352) < 1e-4 and abs(pos[1] - 48.852) < 1e-4, f"d-a is at lat 48.852, lon 2.352 but GEOPOS says (lon {pos[0]}, lat {pos[1]}): GEOADD takes longitude before latitude"
    assert ctx.redis.exists("seen:d-a") == 1, "heartbeat must SET seen:d-a"
    ttl = ctx.redis.ttl("seen:d-a")
    assert 28 <= ttl <= 30, f"seen:d-a must expire after 30 s (EX 30), its TTL is {ttl}"
    assert trips == 1, f"heartbeat made {trips} round trip(s): queue GEOADD and SET on one pipeline and execute once"
    ctx.clock.advance(20)
    assert ctx.redis.ttl("seen:d-a") <= 10, "the presence key must count down on its own"
    m.heartbeat("d-a", 48.853, 2.353)
    ttl = ctx.redis.ttl("seen:d-a")
    assert 28 <= ttl <= 30, f"a new heartbeat must reset the presence key to a full 30 s, its TTL is {ttl}"
    pos = _pos(ctx, "d-a")
    assert abs(pos[0] - 2.353) < 1e-4 and abs(pos[1] - 48.853) < 1e-4, f"a new heartbeat must move the driver: GEOPOS says (lon {pos[0]}, lat {pos[1]}), expected (2.353, 48.853)"
    assert ctx.redis.zcard("drivers") == 1, "a driver that heartbeats twice is one GEO member, not two"
    ctx.clock.advance(31)
    assert ctx.redis.exists("seen:d-a") == 0, "30 s after the last heartbeat the presence key must be gone on its own (EX 30)"
    assert ctx.redis.zcard("drivers") == 1, "expiry removes only the presence key: the GEO set still holds the driver"


def check_radius_order(ctx):
    drivers = [("d-a", 48.852, 2.352), ("d-b", 48.857, 2.35), ("d-c", 48.86, 2.37), ("d-far", 48.90, 2.35)]
    _seed(ctx, *reversed(drivers))  # inserted farthest first: the order must come from the distance
    m = ctx.load("geo_presence")
    found = m.nearest(PICKUP[0], PICKUP[1], 3, 10)
    assert isinstance(found, list), f"nearest must return a list, got {type(found).__name__}"
    assert _ids(found) == ["d-a", "d-b", "d-c"], f"nearest(radius 3 km) returned {_ids(found)}, expected [d-a, d-b, d-c]: nearest first, lon before lat in the search, d-far (5.6 km) outside the radius"
    for driver_id, lat, lon in drivers[:3]:
        dist = dict(found)[driver_id]
        want = _km(PICKUP[0], PICKUP[1], lat, lon)
        assert isinstance(dist, float), f"the distance of {driver_id} must be a float in km, got {dist!r}"
        assert abs(dist - want) < 0.01, f"{driver_id} is {want:.3f} km away (WITHDIST, km), nearest says {dist}"
        assert dist == round(dist, 3), f"distances are rounded to 3 decimals: {driver_id} came back as {dist}"
    found = m.nearest(PICKUP[0], PICKUP[1], 1, 10)
    assert _ids(found) == ["d-a", "d-b"], f"nearest(radius 1 km) returned {_ids(found)}, expected [d-a, d-b]: d-c is 1.8 km away"
    assert m.nearest(PICKUP[0], PICKUP[1], 0.1, 10) == [], "nobody within 100 m: nearest returns []"
    assert m.nearest(45.76, 4.84, 3, 10) == [], "a search 400 km away finds nobody"


def check_stale_excluded(ctx):
    m = ctx.load("geo_presence")
    _seed(ctx, ("d-a", 48.852, 2.352), ("d-c", 48.86, 2.37))
    ctx.clock.advance(10)
    _seed(ctx, ("d-b", 48.857, 2.35))
    ctx.clock.advance(21)  # d-a and d-c heartbeat 31 s ago, d-b 21 s ago
    before = METRICS.redis_trips
    found = m.nearest(PICKUP[0], PICKUP[1], 3, 10)
    trips = METRICS.redis_trips - before
    assert _ids(found) == ["d-b"], f"nearest returned {_ids(found)}, expected [d-b]: d-a and d-c last heartbeat 31 s ago, their seen: keys expired"
    assert ctx.redis.zscore("drivers", "d-a") is not None, "nothing removed d-a from the GEO set — nearest must filter on the seen: keys, not trust GEOSEARCH"
    assert trips <= 2, f"nearest made {trips} round trips: one GEOSEARCH, then one MGET over every candidate's seen: key — never a GET or EXISTS per driver"
    m.heartbeat("d-a", 48.852, 2.352)
    found = m.nearest(PICKUP[0], PICKUP[1], 3, 10)
    assert _ids(found) == ["d-a", "d-b"], f"after a fresh heartbeat d-a is back: nearest returned {_ids(found)}, expected [d-a, d-b]"
    ctx.clock.advance(10)  # d-b is now 31 s old
    found = m.nearest(PICKUP[0], PICKUP[1], 3, 10)
    assert _ids(found) == ["d-a"], f"d-b went silent 31 s ago: nearest returned {_ids(found)}, expected [d-a]"
    before = METRICS.redis_trips
    assert m.nearest(0.0, 0.0, 1, 5) == [], "no candidates at all: nearest returns []"
    assert METRICS.redis_trips - before <= 2, "an empty search still costs at most two round trips"


def check_overfetch_k(ctx):
    m = ctx.load("geo_presence")
    silent = [(f"s-{i}", 48.85 + i / 1000, 2.35) for i in range(1, 6)]  # 0.11 .. 0.56 km, GEO members with no presence key
    live = [(f"l-{i}", 48.85 + (6 + i) / 1000, 2.35) for i in range(1, 4)]  # 0.78, 0.89, 1.00 km
    _seed(ctx, *silent, seen=False)
    _seed(ctx, *live)
    found = m.nearest(PICKUP[0], PICKUP[1], 3, 2)
    assert _ids(found) == ["l-1", "l-2"], f"nearest(k=2) returned {_ids(found)}, expected [l-1, l-2]: the five nearest members are silent and the live ones come after them — ask Redis for COUNT 4k = 8 candidates, drop the silent, then cut to k"
    assert len(found) == 2, f"k=2 but nearest returned {len(found)} drivers"
    found = m.nearest(PICKUP[0], PICKUP[1], 3, 5)
    assert _ids(found) == ["l-1", "l-2", "l-3"], f"k=5 with three live drivers in range returns all three, got {_ids(found)}"
    _seed(ctx, ("s-6", 48.8575, 2.35), seen=False)  # between l-1 and l-2: the 8 candidates are s-1..s-5, l-1, s-6, l-2
    found = m.nearest(PICKUP[0], PICKUP[1], 3, 2)
    assert _ids(found) == ["l-1", "l-2"], f"with a silent driver between the two live ones nearest(k=2) returned {_ids(found)}, expected [l-1, l-2]"


def check_remove_both(ctx):
    m = ctx.load("geo_presence")
    _seed(ctx, ("d-a", 48.852, 2.352), ("d-b", 48.857, 2.35))
    m.remove("d-a")
    assert ctx.redis.zscore("drivers", "d-a") is None, "remove must ZREM the driver from drivers"
    assert ctx.redis.exists("seen:d-a") == 0, "remove must DEL seen:d-a"
    assert ctx.redis.zscore("drivers", "d-b") is not None and ctx.redis.exists("seen:d-b") == 1, "remove touches only the driver it was given"
    assert _ids(m.nearest(PICKUP[0], PICKUP[1], 3, 10)) == ["d-b"], "a removed driver is gone from nearest at once"
    m.remove("ghost")  # unknown: no error
    assert ctx.redis.zcard("drivers") == 1 and ctx.redis.exists("seen:d-b") == 1, "removing an unknown driver changes nothing"


def check_sweep_stale(ctx):
    m = ctx.load("geo_presence")
    _seed(ctx, ("s-1", 48.851, 2.35), ("s-2", 48.852, 2.35), ("s-3", 48.853, 2.35))
    ctx.clock.advance(31)  # their presence keys expired
    _seed(ctx, ("l-1", 48.857, 2.35), ("l-2", 48.858, 2.35))
    ctx.redis.geoadd("drivers", [2.36, 48.84, "orphan"])  # a GEO member that never had a presence key
    removed = m.sweep(100)
    assert removed == 4, f"sweep must return how many stale members it removed (s-1, s-2, s-3, orphan = 4), it returned {removed!r}"
    assert sorted(ctx.redis.zrange("drivers", 0, -1)) == ["l-1", "l-2"], f"after the sweep the GEO set must hold exactly the live drivers, it holds {sorted(ctx.redis.zrange('drivers', 0, -1))}"
    assert ctx.redis.ttl("seen:l-1") > 0 and ctx.redis.ttl("seen:l-2") > 0, "sweep must not touch presence keys"
    assert m.sweep(100) == 0, "nothing stale left: sweep returns 0"
    assert sorted(ctx.redis.zrange("drivers", 0, -1)) == ["l-1", "l-2"], "a sweep with nothing to do removes nothing"
    ctx.redis.delete("drivers", "seen:l-1", "seen:l-2")
    for i in range(10):
        ctx.redis.geoadd("drivers", [2.30 + i / 100, 48.80, f"x-{i}"])
    removed = m.sweep(4)
    assert removed == 4, f"sweep(4) inspects the first 4 members (ZRANGE drivers 0 3) and removes the stale among them: expected 4, got {removed!r}"
    assert ctx.redis.zcard("drivers") == 6, f"sweep(4) must leave the other 6 members for the next pass, {ctx.redis.zcard('drivers')} remain"
    assert m.sweep(100) == 6 and ctx.redis.zcard("drivers") == 0, "the next sweep clears the rest"
`,
    typescript: `const PICKUP: [number, number] = [48.85, 2.35]; // lat, lon
const EARTH_KM = 6372.797560856; // the radius Redis's GEO commands use

/** Great-circle distance the way GEOSEARCH WITHDIST computes it, independently of the learner. */
function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

type Seeded = [driverId: string, lat: number, lon: number];

/** Writes the GEO member and, by default, a 30 s presence key — what a heartbeat leaves behind. */
function seed(ctx, drivers: Seeded[], seen = true) {
  for (const [driverId, lat, lon] of drivers) {
    ctx.redis.geoadd('drivers', lon, lat, driverId);
    if (seen) ctx.redis.set(\`seen:\${driverId}\`, '1', 'EX', 30);
  }
}

const ids = (found: [string, number][]): string[] => found.map(row => row[0]);

function pos(ctx, driverId: string): [number, number] | null {
  const p = ctx.redis.geopos('drivers', driverId)[0];
  return p === null ? null : [Number(p[0]), Number(p[1])];
}

export async function check_heartbeat_pipeline(ctx) {
  const m = ctx.load('geo_presence');
  const before = ctx.redisRoundTrips().length;
  await m.heartbeat('d-a', 48.852, 2.352);
  const trips = ctx.redisRoundTrips().slice(before);
  let p = pos(ctx, 'd-a');
  assert(p !== null, 'heartbeat must GEOADD the driver to the GEO set drivers');
  assert(Math.abs(p[0] - 2.352) < 1e-4 && Math.abs(p[1] - 48.852) < 1e-4, \`d-a is at lat 48.852, lon 2.352 but GEOPOS says (lon \${p[0]}, lat \${p[1]}): GEOADD takes longitude before latitude\`);
  assert.equal(ctx.redis.exists('seen:d-a'), 1, 'heartbeat must SET seen:d-a');
  let ttl = ctx.redis.ttl('seen:d-a');
  assert(28 <= ttl && ttl <= 30, \`seen:d-a must expire after 30 s (EX 30), its TTL is \${ttl}\`);
  assert.equal(trips.length, 1, \`heartbeat made \${trips.length} round trip(s) (\${JSON.stringify(trips)}): queue GEOADD and SET on one pipeline and exec once\`);
  ctx.clock.advance(20);
  assert(ctx.redis.ttl('seen:d-a') <= 10, 'the presence key must count down on its own');
  await m.heartbeat('d-a', 48.853, 2.353);
  ttl = ctx.redis.ttl('seen:d-a');
  assert(28 <= ttl && ttl <= 30, \`a new heartbeat must reset the presence key to a full 30 s, its TTL is \${ttl}\`);
  p = pos(ctx, 'd-a');
  assert(p !== null && Math.abs(p[0] - 2.353) < 1e-4 && Math.abs(p[1] - 48.853) < 1e-4, \`a new heartbeat must move the driver: GEOPOS says \${JSON.stringify(p)}, expected (2.353, 48.853)\`);
  assert.equal(ctx.redis.zcard('drivers'), 1, 'a driver that heartbeats twice is one GEO member, not two');
  ctx.clock.advance(31);
  assert.equal(ctx.redis.exists('seen:d-a'), 0, '30 s after the last heartbeat the presence key must be gone on its own (EX 30)');
  assert.equal(ctx.redis.zcard('drivers'), 1, 'expiry removes only the presence key: the GEO set still holds the driver');
}

export async function check_radius_order(ctx) {
  const drivers: Seeded[] = [['d-a', 48.852, 2.352], ['d-b', 48.857, 2.35], ['d-c', 48.86, 2.37], ['d-far', 48.9, 2.35]];
  seed(ctx, [...drivers].reverse()); // inserted farthest first: the order must come from the distance
  const m = ctx.load('geo_presence');
  let found = await m.nearest(PICKUP[0], PICKUP[1], 3, 10);
  assert(Array.isArray(found), \`nearest must return an array, got \${typeof found}\`);
  assert.deepEqual(ids(found), ['d-a', 'd-b', 'd-c'], \`nearest(radius 3 km) returned \${JSON.stringify(ids(found))}, expected [d-a, d-b, d-c]: nearest first, lon before lat in the search, d-far (5.6 km) outside the radius\`);
  const byId = new Map<string, number>(found);
  for (const [driverId, lat, lon] of drivers.slice(0, 3)) {
    const dist = byId.get(driverId);
    const want = km(PICKUP[0], PICKUP[1], lat, lon);
    assert(typeof dist === 'number', \`the distance of \${driverId} must be a number in km, got \${JSON.stringify(dist)}\`);
    assert(Math.abs(dist - want) < 0.01, \`\${driverId} is \${want.toFixed(3)} km away (WITHDIST, km), nearest says \${dist}\`);
    assert.equal(dist, Math.round(dist * 1000) / 1000, \`distances are rounded to 3 decimals: \${driverId} came back as \${dist}\`);
  }
  found = await m.nearest(PICKUP[0], PICKUP[1], 1, 10);
  assert.deepEqual(ids(found), ['d-a', 'd-b'], \`nearest(radius 1 km) returned \${JSON.stringify(ids(found))}, expected [d-a, d-b]: d-c is 1.8 km away\`);
  assert.deepEqual(await m.nearest(PICKUP[0], PICKUP[1], 0.1, 10), [], 'nobody within 100 m: nearest returns []');
  assert.deepEqual(await m.nearest(45.76, 4.84, 3, 10), [], 'a search 400 km away finds nobody');
}

export async function check_stale_excluded(ctx) {
  const m = ctx.load('geo_presence');
  seed(ctx, [['d-a', 48.852, 2.352], ['d-c', 48.86, 2.37]]);
  ctx.clock.advance(10);
  seed(ctx, [['d-b', 48.857, 2.35]]);
  ctx.clock.advance(21); // d-a and d-c heartbeat 31 s ago, d-b 21 s ago
  let before = ctx.redisRoundTrips().length;
  let found = await m.nearest(PICKUP[0], PICKUP[1], 3, 10);
  let trips = ctx.redisRoundTrips().slice(before);
  assert.deepEqual(ids(found), ['d-b'], \`nearest returned \${JSON.stringify(ids(found))}, expected [d-b]: d-a and d-c last heartbeat 31 s ago, their seen: keys expired\`);
  assert(ctx.redis.zscore('drivers', 'd-a') !== null, 'nothing removed d-a from the GEO set — nearest must filter on the seen: keys, not trust GEOSEARCH');
  assert(trips.length <= 2, \`nearest made \${trips.length} round trips (\${JSON.stringify(trips)}): one GEOSEARCH, then one MGET over every candidate's seen: key — never a GET or EXISTS per driver\`);
  await m.heartbeat('d-a', 48.852, 2.352);
  found = await m.nearest(PICKUP[0], PICKUP[1], 3, 10);
  assert.deepEqual(ids(found), ['d-a', 'd-b'], \`after a fresh heartbeat d-a is back: nearest returned \${JSON.stringify(ids(found))}, expected [d-a, d-b]\`);
  ctx.clock.advance(10); // d-b is now 31 s old
  found = await m.nearest(PICKUP[0], PICKUP[1], 3, 10);
  assert.deepEqual(ids(found), ['d-a'], \`d-b went silent 31 s ago: nearest returned \${JSON.stringify(ids(found))}, expected [d-a]\`);
  before = ctx.redisRoundTrips().length;
  assert.deepEqual(await m.nearest(0, 0, 1, 5), [], 'no candidates at all: nearest returns []');
  trips = ctx.redisRoundTrips().slice(before);
  assert(trips.length <= 2, \`an empty search still costs at most two round trips, this one made \${trips.length}\`);
}

export async function check_overfetch_k(ctx) {
  const m = ctx.load('geo_presence');
  // 0.11 .. 0.56 km: GEO members with no presence key; then three live drivers at 0.78, 0.89, 1.00 km.
  const silent: Seeded[] = Array.from({length: 5}, (_, i) => [\`s-\${i + 1}\`, 48.85 + (i + 1) / 1000, 2.35]);
  const live: Seeded[] = Array.from({length: 3}, (_, i) => [\`l-\${i + 1}\`, 48.85 + (7 + i) / 1000, 2.35]);
  seed(ctx, silent, false);
  seed(ctx, live);
  let found = await m.nearest(PICKUP[0], PICKUP[1], 3, 2);
  assert.deepEqual(ids(found), ['l-1', 'l-2'], \`nearest(k=2) returned \${JSON.stringify(ids(found))}, expected [l-1, l-2]: the five nearest members are silent and the live ones come after them — ask Redis for COUNT 4k = 8 candidates, drop the silent, then cut to k\`);
  assert.equal(found.length, 2, \`k=2 but nearest returned \${found.length} drivers\`);
  found = await m.nearest(PICKUP[0], PICKUP[1], 3, 5);
  assert.deepEqual(ids(found), ['l-1', 'l-2', 'l-3'], \`k=5 with three live drivers in range returns all three, got \${JSON.stringify(ids(found))}\`);
  seed(ctx, [['s-6', 48.8575, 2.35]], false); // between l-1 and l-2: the 8 candidates are s-1..s-5, l-1, s-6, l-2
  found = await m.nearest(PICKUP[0], PICKUP[1], 3, 2);
  assert.deepEqual(ids(found), ['l-1', 'l-2'], \`with a silent driver between the two live ones nearest(k=2) returned \${JSON.stringify(ids(found))}, expected [l-1, l-2]\`);
}

export async function check_remove_both(ctx) {
  const m = ctx.load('geo_presence');
  seed(ctx, [['d-a', 48.852, 2.352], ['d-b', 48.857, 2.35]]);
  await m.remove('d-a');
  assert.equal(ctx.redis.zscore('drivers', 'd-a'), null, 'remove must ZREM the driver from drivers');
  assert.equal(ctx.redis.exists('seen:d-a'), 0, 'remove must DEL seen:d-a');
  assert(ctx.redis.zscore('drivers', 'd-b') !== null && ctx.redis.exists('seen:d-b') === 1, 'remove touches only the driver it was given');
  assert.deepEqual(ids(await m.nearest(PICKUP[0], PICKUP[1], 3, 10)), ['d-b'], 'a removed driver is gone from nearest at once');
  await m.remove('ghost'); // unknown: no error
  assert(ctx.redis.zcard('drivers') === 1 && ctx.redis.exists('seen:d-b') === 1, 'removing an unknown driver changes nothing');
}

export async function check_sweep_stale(ctx) {
  const m = ctx.load('geo_presence');
  seed(ctx, [['s-1', 48.851, 2.35], ['s-2', 48.852, 2.35], ['s-3', 48.853, 2.35]]);
  ctx.clock.advance(31); // their presence keys expired
  seed(ctx, [['l-1', 48.857, 2.35], ['l-2', 48.858, 2.35]]);
  ctx.redis.geoadd('drivers', 2.36, 48.84, 'orphan'); // a GEO member that never had a presence key
  let removed = await m.sweep(100);
  assert.equal(removed, 4, \`sweep must return how many stale members it removed (s-1, s-2, s-3, orphan = 4), it returned \${JSON.stringify(removed)}\`);
  assert.deepEqual([...ctx.redis.zrange('drivers', 0, -1)].sort(), ['l-1', 'l-2'], \`after the sweep the GEO set must hold exactly the live drivers, it holds \${JSON.stringify([...ctx.redis.zrange('drivers', 0, -1)].sort())}\`);
  assert(ctx.redis.ttl('seen:l-1') > 0 && ctx.redis.ttl('seen:l-2') > 0, 'sweep must not touch presence keys');
  assert.equal(await m.sweep(100), 0, 'nothing stale left: sweep returns 0');
  assert.deepEqual([...ctx.redis.zrange('drivers', 0, -1)].sort(), ['l-1', 'l-2'], 'a sweep with nothing to do removes nothing');
  ctx.redis.del('drivers', 'seen:l-1', 'seen:l-2');
  for (let i = 0; i < 10; i++) ctx.redis.geoadd('drivers', 2.3 + i / 100, 48.8, \`x-\${i}\`);
  removed = await m.sweep(4);
  assert.equal(removed, 4, \`sweep(4) inspects the first 4 members (ZRANGE drivers 0 3) and removes the stale among them: expected 4, got \${JSON.stringify(removed)}\`);
  assert.equal(ctx.redis.zcard('drivers'), 6, \`sweep(4) must leave the other 6 members for the next pass, \${ctx.redis.zcard('drivers')} remain\`);
  assert(await m.sweep(100) === 6 && ctx.redis.zcard('drivers') === 0, 'the next sweep clears the rest');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"

	"leetbuild/harness"
)

var gpBg = context.Background()

const (
	gpPickupLat, gpPickupLon = 48.85, 2.35
	gpEarthKm                = 6372.797560856 // the radius Redis's GEO commands use
)

// gpKm is the great-circle distance the way GEOSEARCH WITHDIST computes it, independently of the learner.
func gpKm(lat1, lon1, lat2, lon2 float64) float64 {
	rad := func(d float64) float64 { return d * math.Pi / 180 }
	a := math.Pow(math.Sin(rad(lat2-lat1)/2), 2) + math.Cos(rad(lat1))*math.Cos(rad(lat2))*math.Pow(math.Sin(rad(lon2-lon1)/2), 2)
	return 2 * gpEarthKm * math.Asin(math.Sqrt(a))
}

type gpDriver struct {
	id       string
	lat, lon float64
}

// gpSeed writes the GEO member and, when seen, a 30 s presence key: what a heartbeat leaves behind.
func gpSeed(ctx *harness.Ctx, drivers []gpDriver, seen bool) {
	for _, d := range drivers {
		ctx.Redis.Do("GEOADD", "drivers", d.lon, d.lat, d.id)
		if seen {
			ctx.Redis.Set("seen:"+d.id, "1", "EX", 30)
		}
	}
}

func gpIDs(found []Near) []string {
	ids := []string{}
	for _, n := range found {
		ids = append(ids, n.DriverID)
	}
	return ids
}

// gpPos is the driver's GEOPOS as (lon, lat), or nil when it is not in drivers.
func gpPos(ctx *harness.Ctx, driverID string) []float64 {
	reply, _ := ctx.Redis.Do("GEOPOS", "drivers", driverID).([]any)
	if len(reply) == 0 {
		return nil
	}
	pair, _ := reply[0].([]any)
	if len(pair) != 2 {
		return nil
	}
	lon, _ := strconv.ParseFloat(fmt.Sprint(pair[0]), 64)
	lat, _ := strconv.ParseFloat(fmt.Sprint(pair[1]), 64)
	return []float64{lon, lat}
}

func gpNearest(ctx *harness.Ctx, lat, lon, radiusKm float64, k int) []Near {
	found, err := nearest(gpBg, lat, lon, radiusKm, k)
	ctx.NoError(err, "nearest(%v, %v, %v, %d) returned an error", lat, lon, radiusKm, k)
	return found
}

func gpSweep(ctx *harness.Ctx, limit int) int {
	n, err := sweep(gpBg, limit)
	ctx.NoError(err, "sweep(%d) returned an error", limit)
	return n
}

func gpMembers(ctx *harness.Ctx) []string {
	ids := []string{}
	for _, z := range ctx.Redis.ZRangeWithScores("drivers", 0, -1) {
		ids = append(ids, z.Member)
	}
	sort.Strings(ids)
	return ids
}

func CheckHeartbeatPipeline(ctx *harness.Ctx) {
	before := len(ctx.Redis.RoundTrips())
	ctx.NoError(heartbeat(gpBg, "d-a", 48.852, 2.352), "heartbeat returned an error")
	trips := ctx.Redis.RoundTrips()[before:]
	p := gpPos(ctx, "d-a")
	ctx.Assert(p != nil, "heartbeat must GEOADD the driver to the GEO set drivers")
	ctx.Assert(math.Abs(p[0]-2.352) < 1e-4 && math.Abs(p[1]-48.852) < 1e-4, "d-a is at lat 48.852, lon 2.352 but GEOPOS says (lon %v, lat %v): GEOADD takes longitude before latitude", p[0], p[1])
	ctx.Equal(ctx.Redis.Exists("seen:d-a"), 1, "heartbeat must SET seen:d-a")
	ttl := ctx.Redis.TTL("seen:d-a")
	ctx.Assert(28 <= ttl && ttl <= 30, "seen:d-a must expire after 30 s (EX 30), its TTL is %d", ttl)
	ctx.Assert(len(trips) == 1, "heartbeat made %d round trip(s) (%v): queue GEOADD and SET on one pipeline and exec once", len(trips), trips)
	ctx.Clock.Advance(20)
	ctx.Assert(ctx.Redis.TTL("seen:d-a") <= 10, "the presence key must count down on its own")
	ctx.NoError(heartbeat(gpBg, "d-a", 48.853, 2.353), "heartbeat returned an error")
	ttl = ctx.Redis.TTL("seen:d-a")
	ctx.Assert(28 <= ttl && ttl <= 30, "a new heartbeat must reset the presence key to a full 30 s, its TTL is %d", ttl)
	p = gpPos(ctx, "d-a")
	ctx.Assert(p != nil && math.Abs(p[0]-2.353) < 1e-4 && math.Abs(p[1]-48.853) < 1e-4, "a new heartbeat must move the driver: GEOPOS says %v, expected (2.353, 48.853)", p)
	ctx.Equal(ctx.Redis.ZCard("drivers"), 1, "a driver that heartbeats twice is one GEO member, not two: ZCARD drivers")
	ctx.Clock.Advance(31)
	ctx.Equal(ctx.Redis.Exists("seen:d-a"), 0, "30 s after the last heartbeat the presence key must be gone on its own (EX 30): EXISTS seen:d-a")
	ctx.Equal(ctx.Redis.ZCard("drivers"), 1, "expiry removes only the presence key, the GEO set still holds the driver: ZCARD drivers")
}

func CheckRadiusOrder(ctx *harness.Ctx) {
	drivers := []gpDriver{{"d-a", 48.852, 2.352}, {"d-b", 48.857, 2.35}, {"d-c", 48.86, 2.37}, {"d-far", 48.9, 2.35}}
	// inserted farthest first: the order must come from the distance
	gpSeed(ctx, []gpDriver{drivers[3], drivers[2], drivers[1], drivers[0]}, true)
	found := gpNearest(ctx, gpPickupLat, gpPickupLon, 3, 10)
	ctx.Equal(gpIDs(found), []string{"d-a", "d-b", "d-c"}, "nearest(radius 3 km): nearest first, lon before lat in the search, d-far (5.6 km) outside the radius")
	byID := map[string]float64{}
	for _, n := range found {
		byID[n.DriverID] = n.Dist
	}
	for _, d := range drivers[:3] {
		dist, ok := byID[d.id]
		want := gpKm(gpPickupLat, gpPickupLon, d.lat, d.lon)
		ctx.Assert(ok, "the distance of %s must be a number in km, got none", d.id)
		ctx.Assert(math.Abs(dist-want) < 0.01, "%s is %.3f km away (WITHDIST, km), nearest says %v", d.id, want, dist)
		ctx.Equal(dist, math.Round(dist*1000)/1000, "distances are rounded to 3 decimals: %s's distance", d.id)
	}
	found = gpNearest(ctx, gpPickupLat, gpPickupLon, 1, 10)
	ctx.Equal(gpIDs(found), []string{"d-a", "d-b"}, "nearest(radius 1 km): d-c is 1.8 km away")
	found = gpNearest(ctx, gpPickupLat, gpPickupLon, 0.1, 10)
	ctx.Assert(len(found) == 0, "nobody within 100 m: nearest must return no drivers, got %+v", found)
	found = gpNearest(ctx, 45.76, 4.84, 3, 10)
	ctx.Assert(len(found) == 0, "a search 400 km away finds nobody, got %+v", found)
}

func CheckStaleExcluded(ctx *harness.Ctx) {
	gpSeed(ctx, []gpDriver{{"d-a", 48.852, 2.352}, {"d-c", 48.86, 2.37}}, true)
	ctx.Clock.Advance(10)
	gpSeed(ctx, []gpDriver{{"d-b", 48.857, 2.35}}, true)
	ctx.Clock.Advance(21) // d-a and d-c heartbeat 31 s ago, d-b 21 s ago
	before := len(ctx.Redis.RoundTrips())
	found := gpNearest(ctx, gpPickupLat, gpPickupLon, 3, 10)
	trips := ctx.Redis.RoundTrips()[before:]
	ctx.Equal(gpIDs(found), []string{"d-b"}, "nearest: d-a and d-c last heartbeat 31 s ago, their seen: keys expired")
	_, kept := ctx.Redis.ZScore("drivers", "d-a")
	ctx.Assert(kept, "nothing removed d-a from the GEO set — nearest must filter on the seen: keys, not trust GEOSEARCH")
	ctx.Assert(len(trips) <= 2, "nearest made %d round trips (%v): one GEOSEARCH, then one MGET over every candidate's seen: key — never a GET or EXISTS per driver", len(trips), trips)
	ctx.NoError(heartbeat(gpBg, "d-a", 48.852, 2.352), "heartbeat returned an error")
	found = gpNearest(ctx, gpPickupLat, gpPickupLon, 3, 10)
	ctx.Equal(gpIDs(found), []string{"d-a", "d-b"}, "after a fresh heartbeat d-a is back: nearest")
	ctx.Clock.Advance(10) // d-b is now 31 s old
	found = gpNearest(ctx, gpPickupLat, gpPickupLon, 3, 10)
	ctx.Equal(gpIDs(found), []string{"d-a"}, "d-b went silent 31 s ago: nearest")
	before = len(ctx.Redis.RoundTrips())
	found = gpNearest(ctx, 0, 0, 1, 5)
	ctx.Assert(len(found) == 0, "no candidates at all: nearest must return no drivers, got %+v", found)
	trips = ctx.Redis.RoundTrips()[before:]
	ctx.Assert(len(trips) <= 2, "an empty search still costs at most two round trips, this one made %d", len(trips))
}

func CheckOverfetchK(ctx *harness.Ctx) {
	// 0.11 .. 0.56 km: GEO members with no presence key; then three live drivers at 0.78, 0.89, 1.00 km.
	silent, live := []gpDriver{}, []gpDriver{}
	for i := range 5 {
		silent = append(silent, gpDriver{fmt.Sprintf("s-%d", i+1), 48.85 + float64(i+1)/1000, 2.35})
	}
	for i := range 3 {
		live = append(live, gpDriver{fmt.Sprintf("l-%d", i+1), 48.85 + float64(7+i)/1000, 2.35})
	}
	gpSeed(ctx, silent, false)
	gpSeed(ctx, live, true)
	found := gpNearest(ctx, gpPickupLat, gpPickupLon, 3, 2)
	ctx.Equal(gpIDs(found), []string{"l-1", "l-2"}, "nearest(k=2): the five nearest members are silent and the live ones come after them — ask Redis for COUNT 4k = 8 candidates, drop the silent, then cut to k")
	ctx.Equal(len(found), 2, "k=2: the number of drivers nearest returned")
	found = gpNearest(ctx, gpPickupLat, gpPickupLon, 3, 5)
	ctx.Equal(gpIDs(found), []string{"l-1", "l-2", "l-3"}, "k=5 with three live drivers in range returns all three")
	gpSeed(ctx, []gpDriver{{"s-6", 48.8575, 2.35}}, false) // between l-1 and l-2: the 8 candidates are s-1..s-5, l-1, s-6, l-2
	found = gpNearest(ctx, gpPickupLat, gpPickupLon, 3, 2)
	ctx.Equal(gpIDs(found), []string{"l-1", "l-2"}, "with a silent driver between the two live ones nearest(k=2)")
}

func CheckRemoveBoth(ctx *harness.Ctx) {
	gpSeed(ctx, []gpDriver{{"d-a", 48.852, 2.352}, {"d-b", 48.857, 2.35}}, true)
	ctx.NoError(remove(gpBg, "d-a"), "remove(%q) returned an error", "d-a")
	_, inGeo := ctx.Redis.ZScore("drivers", "d-a")
	ctx.Assert(!inGeo, "remove must ZREM the driver from drivers")
	ctx.Equal(ctx.Redis.Exists("seen:d-a"), 0, "remove must DEL seen:d-a")
	_, otherInGeo := ctx.Redis.ZScore("drivers", "d-b")
	ctx.Assert(otherInGeo && ctx.Redis.Exists("seen:d-b") == 1, "remove touches only the driver it was given")
	ctx.Equal(gpIDs(gpNearest(ctx, gpPickupLat, gpPickupLon, 3, 10)), []string{"d-b"}, "a removed driver is gone from nearest at once")
	ctx.NoError(remove(gpBg, "ghost"), "removing an unknown driver must not fail")
	ctx.Assert(ctx.Redis.ZCard("drivers") == 1 && ctx.Redis.Exists("seen:d-b") == 1, "removing an unknown driver changes nothing")
}

func CheckSweepStale(ctx *harness.Ctx) {
	gpSeed(ctx, []gpDriver{{"s-1", 48.851, 2.35}, {"s-2", 48.852, 2.35}, {"s-3", 48.853, 2.35}}, true)
	ctx.Clock.Advance(31) // their presence keys expired
	gpSeed(ctx, []gpDriver{{"l-1", 48.857, 2.35}, {"l-2", 48.858, 2.35}}, true)
	ctx.Redis.Do("GEOADD", "drivers", 2.36, 48.84, "orphan") // a GEO member that never had a presence key
	ctx.Equal(gpSweep(ctx, 100), 4, "sweep must return how many stale members it removed (s-1, s-2, s-3, orphan = 4)")
	ctx.Equal(gpMembers(ctx), []string{"l-1", "l-2"}, "after the sweep the GEO set must hold exactly the live drivers")
	ctx.Assert(ctx.Redis.TTL("seen:l-1") > 0 && ctx.Redis.TTL("seen:l-2") > 0, "sweep must not touch presence keys")
	ctx.Equal(gpSweep(ctx, 100), 0, "nothing stale left: sweep returns 0")
	ctx.Equal(gpMembers(ctx), []string{"l-1", "l-2"}, "a sweep with nothing to do removes nothing")
	ctx.Redis.Del("drivers", "seen:l-1", "seen:l-2")
	for i := range 10 {
		ctx.Redis.Do("GEOADD", "drivers", 2.3+float64(i)/100, 48.8, fmt.Sprintf("x-%d", i))
	}
	ctx.Equal(gpSweep(ctx, 4), 4, "sweep(4) inspects the first 4 members (ZRANGE drivers 0 3) and removes the stale among them")
	ctx.Equal(ctx.Redis.ZCard("drivers"), 6, "sweep(4) must leave the other 6 members for the next pass: ZCARD drivers")
	ctx.Assert(gpSweep(ctx, 100) == 6 && ctx.Redis.ZCard("drivers") == 0, "the next sweep clears the rest")
}
`,
  },
  debrief: `Two facts, two shapes. Position goes into the GEO set because that is the structure that can answer a radius query sorted by distance in one command; it is a sorted set underneath, which is why \`ZREM\` and \`ZRANGE\` work on it and why nothing in it ever expires by itself. Liveness goes into a plain key with a TTL because expiry is exactly the semantics a heartbeat needs: refresh it or lose it, no sweeper on the hot path. The query joins them client-side in two round trips, and over-fetches because a filter can only shrink a list — ask for \`k\` and one silent driver among the nearest hands the rider \`k − 1\`. \`sweep\` exists only to keep the GEO set from growing with every driver who ever logged in; it is bounded by \`limit\` so it can run from a cron without stalling Redis. Real systems shard the set per city, use \`COUNT … ANY\` when any \`k\` live drivers will do, fold driver status into the same \`MGET\` (a hash per driver instead of a flag), and replace straight-line distance with an ETA from the routing service once the candidate list is short.`,
};
