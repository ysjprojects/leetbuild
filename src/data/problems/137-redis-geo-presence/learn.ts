/**
 * The learning guide for the GEO-plus-presence drill: what a GEO set is underneath, why liveness
 * cannot live in it, and how the join is done in two round trips — a figure or a table where one
 * says it faster than prose, a pop quiz per section.
 */
export const learn = `# The mechanism at a glance

"Who is near me *and* still here" is two questions. Redis answers the first with a **GEO set** — a
sorted set whose scores are geohashes, searched by radius with \`GEOSEARCH\` — and the second with
nothing at all: a GEO member never expires. So the second answer lives in a separate **presence key**
with a TTL, and the query joins the two. Ride dispatch, food delivery, "friends nearby" and fleet
dashboards all have this shape.

:::diagram
{
  "nodes": [
    {"id": "drivers", "kind": "client", "label": "driver apps", "sub": "heartbeat every few seconds", "x": 10, "y": 50},
    {"id": "dispatch", "kind": "service", "label": "dispatch", "sub": "nearest · remove · sweep", "x": 45, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "drivers (GEO) · seen:{driver_id} EX 30", "x": 80, "y": 50}
  ],
  "edges": [
    {"from": "drivers", "to": "dispatch", "kind": "plain", "label": "heartbeat(id, lat, lon)"},
    {"from": "dispatch", "to": "redis", "kind": "redis", "label": "GEOADD + SET EX · GEOSEARCH → MGET"}
  ]
}
:::

The contract is four functions over one GEO set, \`drivers\`, and one key per driver, \`seen:{driver_id}\`,
with a 30 s TTL (\`PRESENCE_TTL_S\`):

| Function | Commands | Round trips |
| --- | --- | --- |
| \`heartbeat(driver_id, lat, lon)\` | \`GEOADD drivers lon lat driver_id\` · \`SET seen:{driver_id} 1 EX 30\`, one pipeline | 1 |
| \`nearest(lat, lon, radius_km, k)\` | \`GEOSEARCH drivers FROMLONLAT lon lat BYRADIUS radius_km km ASC COUNT 4k WITHDIST\`, then one \`MGET\` of the candidates' \`seen:\` keys | 2 at most |
| \`remove(driver_id)\` | \`ZREM drivers driver_id\` · \`DEL seen:{driver_id}\`, one pipeline | 1 |
| \`sweep(limit) → int\` | \`ZRANGE drivers 0 limit-1\` · \`MGET\` of their \`seen:\` keys · \`ZREM\` the stale ones | 3 at most |

\`nearest\` returns \`[(driver_id, distance_km)]\`, nearest first, distances rounded to 3 decimals, and
never a driver whose last heartbeat is older than 30 s — even though the GEO set still holds it.

# A GEO set is a sorted set with geohash scores

There is no spatial data type in Redis. \`GEOADD\` is \`ZADD\` with a computed score: the latitude and
longitude are each quantised to 26 bits, the bits are interleaved, and the resulting 52-bit integer is
the member's score. That interleaving is a
[geohash](https://en.wikipedia.org/wiki/Geohash) — a
[Z-order curve](https://en.wikipedia.org/wiki/Z-order_curve) over the globe:

\`\`\`text
lon bits  x25 x24 x23 … x0          (−180 … 180 split in half 26 times)
lat bits  y25 y24 y23 … y0          (−85.05 … 85.05 split in half 26 times)
score     x25 y25 x24 y24 … x0 y0   52 bits, one sorted-set score
\`\`\`

The property that makes it an index: **points that share a score prefix share a cell**, and the longer
the prefix, the smaller the cell. Each bit pair halves the cell in both directions:

| Score prefix | Cell is about | Good for |
| --- | --- | --- |
| 10 bits | 1,250 km | a continent |
| 20 bits | 39 km | a city |
| 30 bits | 1.2 km | a neighbourhood |
| 40 bits | 38 m | a street |
| 52 bits | 60 cm | the member itself |

So a radius query is a handful of **range scans**: Redis picks the bit depth whose cell is at least the
radius, scans the score range of the cell containing the centre and its eight neighbours
(\`ZRANGEBYSCORE\` underneath), computes the exact great-circle distance to each hit, and discards those
outside the radius. \`ASC\` sorts the survivors by that distance, \`WITHDIST\` returns it, \`COUNT n\` keeps
the first \`n\`. No geometry happens in the client.

Two conventions trip everyone once:

- **Longitude first.** \`GEOADD key lon lat member\`, \`FROMLONLAT lon lat\` — the x-then-y order of
  GeoJSON — while people, and the drill's functions, say \`lat, lon\`. Swap them and Paris lands in the
  Indian Ocean without an error.
- **Latitude is bounded** to ±85.05112878°: the projection is the Web Mercator square, and the poles are
  not in it.

Because it is a sorted set, every sorted-set command works on it: \`ZREM\` removes a member, \`ZRANGE\`
walks it, \`ZCARD\` counts it. And because it is a sorted set, **nothing in it expires**. A key can have a
TTL; a member cannot.

:::details Distance on a sphere
\`WITHDIST\` is the [haversine](https://en.wikipedia.org/wiki/Haversine_formula) distance on a sphere of
radius 6,372,797.56 m; the Earth is an ellipsoid, so the Redis documentation allows for errors up to
0.5% in edge cases — metres across a city. Real dispatch re-ranks the short list by routing ETA anyway,
so the index only has to be roughly right.
:::

:::quiz
Q: Why can a radius query be answered by a sorted set, a structure that only knows one-dimensional order?
- [ ] Redis stores a separate quadtree beside the sorted set
- [x] Interleaving the coordinate bits puts nearby points under a shared score prefix, so a cell is a contiguous score range
- [ ] The score is the distance from the equator, so a range of scores is a band of latitude
> A geohash is a Z-order curve: nearby points mostly share leading bits, so one cell is one \`ZRANGEBYSCORE\`. The curve has seams — neighbours can sit in different cells — which is why the search scans the centre cell and its eight neighbours, then checks the exact distance.
:::

# Where is not whether: presence lives in a TTL key

A driver whose app died ten minutes ago is still in \`drivers\` at the last position it sent. The naive
query — \`GEOSEARCH\` alone — hands the rider that driver first, because it is the nearest:

:::sequence
{
  "participants": ["rider", "dispatch (naive)", "Redis"],
  "messages": [
    {"from": "rider", "to": "dispatch (naive)", "label": "nearest(48.85, 2.35, radius 3 km, k=2)", "kind": "sync"},
    {"from": "dispatch (naive)", "to": "Redis", "label": "GEOSEARCH drivers FROMLONLAT 2.35 48.85 BYRADIUS 3 km ASC COUNT 2 WITHDIST", "kind": "sync"},
    {"from": "Redis", "to": "dispatch (naive)", "label": "[d-2 0.11] [d-7 0.26] — d-2's app died 10 min ago", "kind": "reply"},
    {"from": "dispatch (naive)", "to": "rider", "label": "[(d-2, 0.11), (d-7, 0.26)] — d-2 never answers", "kind": "reply"}
  ]
}
:::

The fix is not a smarter query; it is a second fact with its own shape. Liveness has exactly the
semantics of a key with a TTL: **refresh it or lose it**.

\`\`\`text
heartbeat(d-7, 48.852, 2.352)
  GEOADD drivers 2.352 48.852 d-7     where — overwrites the position, never expires
  SET seen:d-7 1 EX 30                whether — 30 s from now, gone on its own
\`\`\`

The alternatives, and why they lose:

| Put liveness in… | What goes wrong |
| --- | --- |
| the GEO member itself | a sorted-set member has no TTL; the score is already spent on the geohash |
| a second sorted set keyed by last-seen time | a \`ZSCORE\` per candidate or a client-side timestamp comparison, and nothing cleans it up either |
| a hash \`driver:{id}\` with a \`last_seen\` field | a field has no TTL; the client compares clocks, and one skewed server marks a live fleet dead |
| \`seen:{driver_id}\` with \`EX 30\` | Redis's own clock decides; expiry is lazy and background, nothing on the hot path; \`MGET\` checks many at once |

Each heartbeat resets the TTL to a **full 30 s** — \`SET … EX\` replaces the value and the expiry
together — so a stuttering heartbeat is harmless and a stopped one is detected within 30 s. Per the
[\`EXPIRE\`](https://redis.io/docs/latest/commands/expire/) documentation, Redis deletes an expired key
when something next touches it and also samples for them in the background, so \`MGET\` sees \`nil\` the
moment the TTL has passed, whichever path ran first.

:::quiz
Q: Why not store the last-seen timestamp in a hash per driver and compare it with the current time in the query?
- [ ] A hash cannot hold a number
- [x] The comparison then depends on the client's clock agreeing with every heartbeat writer's clock; a TTL lets Redis's single clock decide
- [ ] Hashes are slower than strings
> With a TTL the writer says "30 seconds" and Redis counts them. With a timestamp the writer says "now" by its clock and the reader says "now" by a different one; a minute of skew on one server marks every driver it heard from as dead — or alive forever.
:::

# Over-fetch, because a filter can only shrink the list

The join is a filter: ask for candidates, drop the ones whose presence key is gone. A filter never adds.
Ask \`GEOSEARCH\` for exactly \`k\` and a single silent driver among the nearest leaves \`k − 1\`:

:::sequence
{
  "participants": ["rider", "dispatch (COUNT k)", "Redis"],
  "messages": [
    {"from": "rider", "to": "dispatch (COUNT k)", "label": "nearest(…, k=2)", "kind": "sync"},
    {"from": "dispatch (COUNT k)", "to": "Redis", "label": "GEOSEARCH … ASC COUNT 2 WITHDIST", "kind": "sync"},
    {"from": "Redis", "to": "dispatch (COUNT k)", "label": "[d-2 0.11] [d-7 0.26]", "kind": "reply"},
    {"from": "dispatch (COUNT k)", "to": "Redis", "label": "MGET seen:d-2 seen:d-7", "kind": "sync"},
    {"from": "Redis", "to": "dispatch (COUNT k)", "label": "[nil, \\"1\\"]", "kind": "reply"},
    {"from": "dispatch (COUNT k)", "to": "rider", "label": "[(d-7, 0.26)] — one driver, and d-9 at 1.83 km was never asked for", "kind": "reply"}
  ]
}
:::

The drill asks for \`OVERFETCH * k\` with \`OVERFETCH = 4\`, filters, then cuts to \`k\`:

:::sequence
{
  "participants": ["rider", "dispatch", "Redis"],
  "messages": [
    {"from": "rider", "to": "dispatch", "label": "nearest(48.85, 2.35, radius 3 km, k=2)", "kind": "sync"},
    {"from": "dispatch", "to": "Redis", "label": "GEOSEARCH drivers FROMLONLAT 2.35 48.85 BYRADIUS 3 km ASC COUNT 8 WITHDIST", "kind": "sync"},
    {"from": "Redis", "to": "dispatch", "label": "[d-2 0.11] [d-7 0.26] [d-9 1.83] [d-4 2.40]", "kind": "reply"},
    {"from": "dispatch", "to": "Redis", "label": "MGET seen:d-2 seen:d-7 seen:d-9 seen:d-4", "kind": "sync"},
    {"from": "Redis", "to": "dispatch", "label": "[nil, \\"1\\", \\"1\\", \\"1\\"] — d-2 went silent 40 s ago", "kind": "reply"},
    {"from": "dispatch", "to": "rider", "label": "[(d-7, 0.26), (d-9, 1.83)] — filtered, cut to k", "kind": "reply"}
  ]
}
:::

Worked through, candidate by candidate:

| Candidate | \`WITHDIST\` | \`seen:\` key | Kept? | Position in reply |
| --- | --- | --- | --- | --- |
| \`d-2\` | 0.11 km | \`nil\` — expired | no | — |
| \`d-7\` | 0.26 km | \`"1"\` | yes | 1 |
| \`d-9\` | 1.83 km | \`"1"\` | yes | 2 |
| \`d-4\` | 2.40 km | \`"1"\` | yes | cut: already have \`k\` |

- \`MGET\` returns **one entry per key, in the order asked**; zip it with the candidates and keep those
  whose entry is not \`nil\`. Order is preserved, so the result is still nearest first.
- The cut to \`k\` happens **after** the filter, never before.
- No candidates from the search → \`[]\` **without** the \`MGET\`; there is nothing to ask about.
- Four is a guess about the stale fraction, not a guarantee. Five silent drivers among the eight nearest
  still leave one short. Real systems tune the factor from the measured stale rate, or page: search
  again with a larger \`COUNT\` when the filtered list is short.

:::details COUNT … ANY, when any k will do
\`GEOSEARCH … COUNT n\` finds **every** member in the radius, sorts, then keeps \`n\` — the cost is the
whole radius. \`COUNT n ANY\` stops at the first \`n\` matches found, in whatever order the cell scans
produced them, which is far cheaper in a dense city. The drill wants the nearest, so it pays for the
sort; a dispatcher that will re-rank by ETA anyway often does not, and asks for \`ANY\`.
:::

:::quiz
Q: \`nearest(…, k=3)\` searches with \`COUNT 3\`, the \`MGET\` comes back \`["1", nil, "1"]\`. What does the rider get?
- [ ] Three drivers — the stale one is replaced from the set
- [x] Two drivers, although a live fourth may be just outside the three the search returned
- [ ] An error, because a candidate was stale
> The search already truncated to three; the filter can only remove. Nothing re-queries. That is the whole case for \`COUNT 4k\`: the search must hand the filter more than the filter is allowed to drop.
:::

# The sweeper: who reclaims what never expires

Presence keys clean themselves up. GEO members do not: every driver who ever logged in stays in
\`drivers\` at the position of their last heartbeat. The query is correct anyway — the \`MGET\` filters
them — but the set grows without bound, every radius scan walks more dead members, and every search
over-fetches harder for nothing. \`sweep(limit)\` is the same join, run over the set instead of a radius:

\`\`\`text
sweep(limit)
  ZRANGE drivers 0 limit-1                 the first limit members, by score (= by geohash)
  MGET seen:m1 seen:m2 … seen:mN           one round trip for all of them
  ZREM drivers <members whose entry is nil> only when there is something to remove
  → number removed; 0 when nothing was stale
\`\`\`

- **Never touches a live member**, and never touches a presence key — it reads them, it does not
  refresh or delete them.
- **Bounded by** \`limit\`, so a cron can run it every minute without a single command stalling Redis
  on a million-member set. Each run inspects a slice; across runs the slices add up.
- **Idempotent.** Run it twice and the second run finds nothing: \`0\`.
- **Off the hot path.** \`nearest\` is correct whether or not the sweeper has run recently; the sweeper
  buys cost, not correctness.

Because \`ZRANGE 0 limit-1\` is by score, each run inspects the same low-geohash slice until it is
clean and the next shifts into range. Real systems keep a cursor (\`ZRANGE … BYSCORE\` from the last
score, or \`ZSCAN\`) to walk the whole set across runs; the drill leaves the cursor out.

\`remove(driver_id)\` is the eager version for a driver who logs out: \`ZREM drivers driver_id\` and
\`DEL seen:{driver_id}\` in one pipeline, so the driver is gone from \`nearest\` at once rather than
within 30 s. An unknown id removes nothing and raises nothing.

:::quiz
Q: The sweeper has not run for an hour. What does a rider's \`nearest\` return?
- [x] The same correct list — only live drivers — at a somewhat higher cost per search
- [ ] Stale drivers, until the sweeper catches up
- [ ] Nothing, because the GEO set is locked while it is dirty
> Correctness comes from the \`MGET\` on every query; the sweeper only keeps the set small so that scans and over-fetching stay cheap. That separation is what lets the sweeper be a lazy, bounded cron rather than a hot-path dependency.
:::

# Round-trip accounting: pipelines and MGET

Each command is a round trip to Redis unless you say otherwise, and a dispatcher serving a city pays
that latency on every heartbeat and every search. The drill fixes the budget per function:

| Function | Per-key version | Drill | How |
| --- | --- | --- | --- |
| \`heartbeat\` | 2 (\`GEOADD\`, \`SET\`) | **1** | both queued on one pipeline, executed once |
| \`nearest\` | 1 + 4k (\`GET\`/\`EXISTS\` per candidate) | **2** | \`GEOSEARCH\`, then one \`MGET\` over every candidate |
| \`remove\` | 2 | **1** | \`ZREM\` + \`DEL\` on one pipeline |
| \`sweep\` | 1 + limit + 1 | **3** at most | \`ZRANGE\`, one \`MGET\`, one \`ZREM\` with every stale member |

With \`k = 5\` the per-key \`nearest\` is 21 round trips; at a millisecond each, a 20 ms search that
could be 2 ms. Two tools, chosen by what the commands have in common:

- A **pipeline** sends several commands without waiting for each reply —
  [Redis pipelining](https://redis.io/docs/latest/develop/use/pipelining/). The commands are unrelated
  (\`GEOADD\` and \`SET\` on different keys); what they share is the trip. The drill's sequence shows
  the heartbeat wrapped in \`MULTI\`/\`EXEC\`, which a client's transactional pipeline emits: same single
  round trip, plus the guarantee that no reader sees the position without the presence key.
- **One command, many keys:** \`MGET\`. The presence check is the same operation on 4k keys, and
  Redis answers with one array in the asked order. \`nil\` where the key is gone.

The second \`nearest\` round trip cannot be pipelined with the first — the \`MGET\` arguments are the
\`GEOSEARCH\` result. Collapsing it to one needs a Lua script that does the search and the presence
lookups server-side; real systems do that when the two-trip latency matters, at the price of a script
to version and test.

:::quiz
Q: A teammate replaces the \`MGET\` with an \`EXISTS seen:{id}\` per candidate "because it is clearer". With \`k = 10\`, what changed?
- [ ] Nothing measurable; both read one key at a time inside Redis
- [x] A search went from two round trips to up to forty-one
- [ ] The results are now wrong, because \`EXISTS\` cannot see TTLs
> \`EXISTS\` sees expiry exactly as \`MGET\` does; the answers are identical. The cost is not: \`COUNT 4k\` is forty candidates, so forty sequential trips where one \`MGET\` did the job. Round trips, not commands, are what a client pays for.
:::

# What to take away

- **A GEO set is a sorted set.** Scores are 52-bit interleaved geohashes; a radius query is a few score
  range scans plus an exact distance check; \`ZREM\` and \`ZRANGE\` work on it; nothing in it expires.
- **Where is not whether.** Liveness is a key with a TTL, refreshed by every heartbeat and gone on its
  own when they stop. Redis's clock decides; nothing runs on the hot path.
- **A filter can only shrink.** Ask for \`4k\`, join with one \`MGET\`, cut to \`k\` after the filter.
  \`COUNT k\` hands the rider \`k − 1\` the moment one nearby driver goes silent.
- **The sweeper buys cost, not correctness.** \`ZRANGE 0 limit-1\` → \`MGET\` → \`ZREM\`, bounded so a cron
  can run it; \`nearest\` is right whether or not it has run.
- **Count round trips, not commands.** One pipeline per write, one \`MGET\` per check; a search is two
  trips because the second depends on the first.

The primary reference is the Redis
[\`GEOSEARCH\`](https://redis.io/docs/latest/commands/geosearch/) command page, with
[\`GEOADD\`](https://redis.io/docs/latest/commands/geoadd/) for how the 52-bit score is built and what it
costs in precision; the Wikipedia [geohash](https://en.wikipedia.org/wiki/Geohash) article explains the
bit interleaving and why nearby cells can share no prefix.
`;
