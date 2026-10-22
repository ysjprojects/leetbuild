/**
 * The learning guide for Ride Dispatch: the concepts the six steps rest on, in the order a reader
 * meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/ride-dispatch/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

A rider taps *Request*; seconds later a driver two streets away sees the offer, accepts, and the
rider watches the car approach. This is the dispatch layer of Uber or Lyft — what Uber described in
2015 as **DISCO**: a supply service, a demand service, a geospatial index between them, a matching
loop on top. The course rebuilds one service, **dispatch**, with six pieces:

:::diagram
{
  "nodes": [
    {"id": "rider", "kind": "client", "label": "Rider app", "sub": "POST /rides · GET /rides/{id}", "x": 9, "y": 28},
    {"id": "driver", "kind": "client", "label": "Driver app", "sub": "one position every 4 s", "x": 9, "y": 74},
    {"id": "api", "kind": "http", "label": "ride-api", "sub": "step 1 · validate, dedupe, accept", "x": 31, "y": 28},
    {"id": "location", "kind": "grpc", "label": "location-svc", "sub": "step 2 · one client stream per driver", "x": 31, "y": 74},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "drivers:{city} GEO · seen TTL · offer lock", "x": 55, "y": 74},
    {"id": "dispatcher", "kind": "service", "label": "dispatcher", "sub": "steps 3–4 · nearest, offer, accept", "x": 55, "y": 28},
    {"id": "kafka", "kind": "kafka", "label": "trip-events", "sub": "step 5 · key = ride_id · group trip-state", "x": 79, "y": 28},
    {"id": "routing", "kind": "grpc", "label": "Routing", "sub": "step 6 · Eta, 500 ms deadline", "x": 79, "y": 74}
  ],
  "edges": [
    {"from": "rider", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "driver", "to": "location", "kind": "grpc", "label": "stream LocationUpdate"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "SET idem NX EX"},
    {"from": "api", "to": "dispatcher", "kind": "plain", "label": "start_matching"},
    {"from": "location", "to": "redis", "kind": "redis", "label": "GEOADD · SET seen EX 30"},
    {"from": "dispatcher", "to": "redis", "kind": "redis", "label": "GEOSEARCH · offer lock"},
    {"from": "dispatcher", "to": "kafka", "kind": "kafka", "label": "produce / consume"},
    {"from": "dispatcher", "to": "routing", "kind": "grpc", "label": "Eta"}
  ]
}
:::

- **Request** (step 1): an HTTPS API validates, dedupes on an \`Idempotency-Key\`, answers \`202\`.
- **Track** (step 2): one client-streaming gRPC call per driver app, into a Redis GEO set plus a
  presence key with a 30 s TTL.
- **Search** (step 3): \`GEOSEARCH\` by radius, one \`MGET\` to drop silent drivers, a status filter.
- **Offer** (step 4): \`SET NX EX 15\` — one open offer per driver, released with a compare-and-delete.
- **Record** (step 5): ride events on Kafka keyed by ride id, applied through a transition table.
- **Decorate** (step 6): an ETA under a 500 ms deadline, a flagged straight-line estimate otherwise.

Surge, forecasting, map-matching, per-city sharding, batched matching, payments and fraud are left
out; none of them changes the shape of these six.

# A write that may arrive twice

The rider app is on a flaky connection and retries. A ride request is the textbook case for an
[idempotency key](https://stripe.com/blog/idempotency): the client names the operation, the server
remembers it, a retry is answered from memory. Four branches, **ordered by cost**:

| Branch | Costs | Answer |
| --- | --- | --- |
| latitude outside \`[-90, 90]\` or longitude outside \`[-180, 180]\` | nothing | \`400\` |
| no \`Idempotency-Key\` header | nothing | \`400\` — the server cannot dedupe what it cannot identify |
| \`SET idem:{key} <ride_id> NX EX 3600\` refused | one round trip | \`200\` with the stored ride id |
| \`start_matching(ride)\` | the expensive one | \`202 {ride_id, status: "matching"}\` |

- **The claim is the check.** \`NX\` succeeds for exactly one caller; two racing retries cannot both
  pass, because there is no separate "does it exist" read to race against.
- **The key is written before the ride exists**, with a TTL. A crash between the \`SET\` and
  \`start_matching\` leaves a key pointing at a ride nobody recorded; the hour-long TTL heals it.
- **A replay reads the key back** — \`GET idem:{key}\` — and answers \`200\` with the same ride id.
- **The 202 is honest.** Accepted, not matched; \`GET /rides/{id}\` answers \`404\` for an unknown id and
  \`{status, driver_id?}\` otherwise.

:::widget idempotency {}

:::details What the course's key does not do
Production idempotency layers store the **whole first response** under the key, answer \`409\` while
the first request is still in flight (the widget shows it), and scope keys **per rider**.
:::

:::quiz
Q: Why claim \`idem:{key}\` with \`SET NX\` before calling \`start_matching\`, rather than after?
- [x] Two concurrent retries must not both pass; \`NX\` lets one through, and the TTL covers a crash in between
- [ ] Because a \`SET\` after \`start_matching\` would need a longer TTL
- [ ] So the first request can answer \`200\` instead of \`202\`
> Claiming after the work leaves a window in which a retry sees no key and creates a second ride. Claiming first closes it; the cost is a key that may point at nothing after a crash, gone an hour later.
:::

# Positions as one stream per driver

Thousands of drivers reporting every four seconds would be thousands of unary calls a second, each
with its own setup. The course opens **one client stream per driver** and keeps it open:

\`\`\`proto
service Locations {
  rpc UpdateLocations(stream LocationUpdate) returns (Ack);
}
message LocationUpdate { string driver_id = 1; string city = 2; double lat = 3; double lng = 4; int64 ts = 5; }
message Ack            { uint32 count = 1; }
\`\`\`

:::widget grpc-streams {"mode": "client"}

The servicer is a loop over the incoming messages with one response at the very end:

- **Per update, two writes, one round trip.** \`GEOADD drivers:{city} lng lat driver_id\` and
  \`SET driver:{id}:seen <ts> EX 30\`, in **one pipeline** — the hottest write path in the system.
- **The client finishes** (half-close) → \`Ack{count}\`, the number of updates applied.
- **The client cancels or the connection drops** → stop, log what was applied, send nothing.

| | A unary call per position | One client stream |
| --- | --- | --- |
| Per message | request, headers, response | a frame on an open HTTP/2 stream |
| Back-pressure | none | flow control, for free |
| Noticing the driver left | a timer somewhere else | the stream ends |
| Reply | one per position | one \`Ack\` at half-close |

:::quiz
Q: A driver's phone loses signal mid-stream. What should \`UpdateLocations\` do?
- [ ] Send \`Ack{count}\` so the app knows how many positions arrived
- [x] Stop the loop, log the count applied, return nothing
- [ ] Delete the driver from \`drivers:{city}\`
> The Ack answers a client that finished its side; a cancelled stream has no one listening. The driver drops out of search on their own: the \`seen\` key expires in 30 s, and the next step filters the GEO entry.
:::

# Where a driver is, and whether they are still there

Two questions, two keys — because the structure that answers the first cannot answer the second.

\`\`\`text
GEOADD drivers:paris 2.35 48.85 d-7       # longitude first — the opposite of how people say it
SET    driver:d-7:seen 1700000000 EX 30   # the heartbeat: exists ⇔ reported in the last 30 s
\`\`\`

## The GEO set is a sorted set with a geohash for a score

Redis has no spatial tree. \`GEOADD\` interleaves the bits of longitude and latitude into one 52-bit
integer — a [geohash](https://en.wikipedia.org/wiki/Geohash) — and stores it as the member's score
in an ordinary sorted set. Points close on the ground mostly share a prefix, so a radius search is a
few score-range scans over the centre cell and its neighbours plus an exact distance check. That is
why \`GEOSEARCH\` returns results **already sorted, with the distance attached**: the geometry is
Redis's job.

## Why presence is a separate key

| Key | Answers | Expires? |
| --- | --- | --- |
| \`drivers:{city}\` (GEO set) | where was \`d-7\` last seen | never — a sorted set cannot expire one member |
| \`driver:{id}:seen\` (\`EX 30\`) | has \`d-7\` reported in the last 30 s | yes; expiry *is* the heartbeat timing out |

- A member stays at its last position **forever**: a driver who closed the app at 17:00 is still
  there at midnight, and \`GEOSEARCH\` will return them.
- The \`seen\` key caches no value; its **existence** is the fact. Every update refreshes the TTL, a
  silent app lets it lapse, nobody deletes anything.

:::quiz
Q: A driver's app crashed 40 seconds ago. What does Redis know about them?
- [x] \`drivers:{city}\` still has them at their last position; \`driver:{id}:seen\` is gone
- [ ] Both keys are gone — the GEO entry expired with the presence key
- [ ] \`drivers:{city}\` dropped them when the stream closed
> Nothing removes a GEO member, and a closing stream writes nothing. Only the presence key knows the driver stopped reporting, which is why the search checks it before trusting a hit.
:::

# Nearest: three filters, cheapest first

\`nearest(city, lat, lng, k)\` wants the \`k\` closest drivers who are actually there and actually free.
Three filters, in order of cost, each shrinking what the next one sees:

:::sequence
{
  "participants": ["dispatcher", "Redis", "driver store"],
  "messages": [
    {"from": "dispatcher", "to": "Redis", "label": "GEOSEARCH drivers:paris FROMLONLAT 2.35 48.85 BYRADIUS 3 km ASC COUNT 20 WITHDIST", "kind": "sync"},
    {"from": "Redis", "to": "dispatcher", "label": "[d-7 0.4] [d-2 1.1] [d-9 2.6] — sorted, with distances", "kind": "reply"},
    {"from": "dispatcher", "to": "Redis", "label": "MGET driver:d-7:seen driver:d-2:seen driver:d-9:seen", "kind": "sync"},
    {"from": "Redis", "to": "dispatcher", "label": "[ts, nil, ts] → d-2 went silent", "kind": "reply"},
    {"from": "dispatcher", "to": "driver store", "label": "driver_status([d-7, d-9])", "kind": "sync"},
    {"from": "driver store", "to": "dispatcher", "label": "{d-7: available, d-9: on_trip} → first k of [(d-7, 0.4)]", "kind": "reply"}
  ]
}
:::

| Filter | One call | Removes |
| --- | --- | --- |
| spatial | \`GEOSEARCH … BYRADIUS 3 km ASC COUNT 20 WITHDIST\` | everyone beyond 3 km; sorts and bounds the rest |
| presence | \`MGET\` over every candidate's \`driver:{id}:seen\` | drivers whose heartbeat lapsed — the stale GEO members |
| status | \`driver_status(ids)\` → \`available\`, \`on_trip\`, \`offline\` | drivers who are there but busy |

- \`FROMLONLAT\`: longitude first again. \`WITHDIST\`: the distance comes back in the same command.
  \`ASC\`: Redis sorts, the service does not. **3 km**: beyond it the rider waits too long anyway.
- **One MGET, never a GET loop.** One entry per key, in the order of the ids passed; zip, keep the
  non-null ones. Twenty round trips for one search is how a dispatcher falls over.
- **Over-fetch, then cut.** \`COUNT 20\` for \`k = 3\`: the filters will remove candidates and the
  result must still be full. Return the first \`k\` as \`(driver_id, distance_km)\`.

:::quiz
Q: The caller asks for \`k = 3\`. Why does the \`GEOSEARCH\` ask for \`COUNT 20\`?
- [ ] Redis cannot sort fewer than twenty results
- [x] Presence and status will drop some of the twenty; three survivors are needed at the end
- [ ] So the result can be cached for later calls
> The spatial query knows nothing about silence or busyness. Asking for exactly three would often return one available driver and two ghosts. Over-fetch is the price of filtering after the index.
:::

# One offer per driver: a lock with a lease

A driver must see **one** offer at a time, and an unanswered offer must expire so the ride can move
on. That is a lock with a lease — Redis's
[single-instance lock pattern](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
— in three operations:

:::sequence
{
  "participants": ["dispatcher", "Redis", "Driver app"],
  "messages": [
    {"from": "dispatcher", "to": "Redis", "label": "SET offer:driver:d-7 r-42 NX EX 15", "kind": "sync"},
    {"from": "Redis", "to": "dispatcher", "label": "OK — no open offer", "kind": "reply"},
    {"from": "dispatcher", "to": "Driver app", "label": "offer r-42 (15 s)", "kind": "async"},
    {"from": "Driver app", "to": "dispatcher", "label": "accept(r-42)", "kind": "sync"},
    {"from": "dispatcher", "to": "Redis", "label": "EVALSHA compare-and-delete offer:driver:d-7 r-42", "kind": "sync"},
    {"from": "Redis", "to": "dispatcher", "label": "1 — still r-42, now deleted", "kind": "reply"},
    {"from": "dispatcher", "to": "Redis", "label": "SET ride:r-42:driver d-7", "kind": "sync"},
    {"from": "dispatcher", "to": "Driver app", "label": "true", "kind": "reply"}
  ]
}
:::

- **offer**: a **lock** (\`NX\` — a driver already holding an offer is skipped), a **lease** (\`EX 15\` —
  the offer window) and a **record of the holder** (the value is the ride id), in one command.
- **accept**: prove the offer under the key is still *this* ride, then remove it — atomically. \`1\` →
  \`SET ride:{ride_id}:driver <driver_id>\`, answer \`true\`. \`0\` → \`false\`: expired, or another ride.
- **decline**: the same guarded delete — never a blind \`DEL\` — then \`next_candidate(ride_id)\`.

The guarded delete is four lines of Lua (or a \`WATCH\`/\`MULTI\` transaction):

\`\`\`lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
\`\`\`

The race a client-side \`GET\` then \`DEL\` lets through:

| t | Event | \`offer:driver:d-7\` |
| --- | --- | --- |
| 0 s | offer \`r-42\` to \`d-7\` | \`r-42\`, 15 s to live |
| 15 s | no answer; the lease lapses | *(gone)* |
| 16 s | dispatcher offers \`r-57\` to \`d-7\` | \`r-57\` |
| 17 s | \`d-7\`'s late tap on \`r-42\` arrives: \`accept(r-42, d-7)\` | script: \`r-57 ≠ r-42\` → \`0\`, nothing deleted |

With a blind delete at 17 s, \`d-7\` would be assigned \`r-42\` **and** lose \`r-57\`'s offer. The value
in the lock is what makes a release safe after your own lease expired.

:::quiz
Q: A driver's accept for ride A arrives two seconds after A's offer expired and offer B landed under the same key. What happens?
- [ ] The driver gets A; B is re-offered to someone else
- [x] The compare-and-delete returns 0, accept answers false, B's offer is untouched
- [ ] Both A and B are assigned to the driver
> The key now holds B's ride id, not A's: the comparison fails, nothing is deleted, the stale answer is rejected. A \`GET\` then \`DEL\` from the client could not promise that.
:::

# The ride is a state machine; the topic is its history

Every ride event — \`requested\`, \`matched\`, \`started\`, \`completed\`, \`cancelled\` — goes on the
**trip-events** topic, and the ride's status is whatever the consumer group **trip-state** has
applied so far. The transition table is the whole business rule:

| Event | May follow | Meaning |
| --- | --- | --- |
| \`requested\` | *(an unseen ride)* | the only event a new ride accepts |
| \`matched\` | \`requested\` | a driver accepted |
| \`started\` | \`matched\` | the rider is in the car |
| \`completed\` | \`started\` | billing's event; terminal |
| \`cancelled\` | \`requested\`, \`matched\` | before the car moves; terminal |

:::widget kafka-partitions {"partitions": 8}

Kafka orders records **within a partition** and nowhere else; keying by ride id puts one ride's
events on one partition, in order, so no consumer can see \`started\` before \`matched\`.

:::sequence
{
  "participants": ["dispatcher", "Kafka", "trip-state", "ride store"],
  "messages": [
    {"from": "dispatcher", "to": "Kafka", "label": "produce trip-events · key = r-42 · {event: matched} · acks=all", "kind": "sync"},
    {"from": "Kafka", "to": "trip-state", "label": "poll → r-42 matched (partition 3, offset 518)", "kind": "reply"},
    {"from": "trip-state", "to": "ride store", "label": "get r-42 → requested · can_transition(requested, matched) ✓", "kind": "sync"},
    {"from": "trip-state", "to": "ride store", "label": "set_status r-42 matched", "kind": "sync"},
    {"from": "trip-state", "to": "Kafka", "label": "commit offset 519 — after the write", "kind": "sync"},
    {"from": "Kafka", "to": "trip-state", "label": "poll → r-99 started, but r-99 is completed", "kind": "reply"},
    {"from": "trip-state", "to": "Kafka", "label": "log, commit — nothing written", "kind": "sync"}
  ]
}
:::

- **Producer:** \`acks=all\` and the idempotent producer. A lost or duplicated \`completed\` is a
  billing bug: \`acks=all\` survives a leader failover, idempotence survives the producer's own retries.
- **Consumer:** \`group.id=trip-state\`, auto-commit off, three exits per record:

| The record is | The consumer | Commits? |
| --- | --- | --- |
| an illegal transition | logs it; writes nothing | **yes** — the event is wrong, not the consumer; refusing to commit blocks every later event on the partition |
| legal | \`set_status\`, **then** commit | yes, after the write |
| legal, but \`set_status\` fails | does not commit | no — the record is redelivered |

:::widget delivery-semantics {}

Committing after the write is
[at-least-once](https://kafka.apache.org/documentation/#semantics): a crash between \`set_status\`
and the commit replays the event, and the transition table makes the replay harmless — the ride is
already \`matched\`, so the duplicate is logged and committed. The state machine is the deduplication.

:::quiz
Q: The consumer reads \`started\` for a ride whose status is already \`completed\`. Commit the offset or not?
- [x] Commit: the event will never become legal, and not committing blocks the partition on it forever
- [ ] Do not commit: at-least-once means every event must eventually be applied
- [ ] Apply it anyway and let billing sort it out
> Not committing is right only when *the consumer* failed — a write that did not happen — because the same work will succeed on redelivery. A record the transition table rejects is rejected every time; not committing only sticks the partition.
:::

# An ETA that degrades instead of failing

"Driver arrives in 4 min" comes from a routing service with live traffic — a dependency the match
must not let take it down. The ETA is decoration on the match, not the match itself.

:::sequence
{
  "participants": ["dispatcher", "Redis", "Routing"],
  "messages": [
    {"from": "dispatcher", "to": "Redis", "label": "GET eta:8f2a:8f31 (origin cell, destination cell)", "kind": "sync"},
    {"from": "Redis", "to": "dispatcher", "label": "(nil)", "kind": "reply"},
    {"from": "dispatcher", "to": "Routing", "label": "Eta(origin, dest) · deadline 500 ms", "kind": "sync"},
    {"from": "Routing", "to": "dispatcher", "label": "EtaReply{seconds: 412}", "kind": "reply"},
    {"from": "dispatcher", "to": "Redis", "label": "SET eta:8f2a:8f31 412 EX 60", "kind": "sync"},
    {"from": "dispatcher", "to": "Routing", "label": "Eta(origin2, dest2) · deadline 500 ms", "kind": "sync"},
    {"from": "Routing", "to": "dispatcher", "label": "DEADLINE_EXCEEDED", "kind": "reply"},
    {"from": "dispatcher", "to": "dispatcher", "label": "haversine_km / 30 km/h → {seconds, estimated: true} — not cached", "kind": "sync"}
  ]
}
:::

Three outcomes, in order, and no loop anywhere:

1. **Cache hit** on \`eta:{cell(origin)}:{cell(dest)}\` → the answer. \`cell\` is a ~1 km grid id —
   as precise as an ETA in minutes needs.
2. **RPC succeeds** under a **500 ms** [deadline](https://grpc.io/docs/guides/deadlines/) set on the
   call itself, not a timer around it. Cache the answer for **60 s**, return it.
3. **RPC fails** → look at the status. \`DEADLINE_EXCEEDED\` or \`UNAVAILABLE\` → **degrade**. Anything
   else propagates.

The fallback is a straight line at city speed:

\`\`\`text
seconds = haversine_km(origin, dest) / 30 * 3600      # great-circle distance at 30 km/h
2.0 km  → 240 s  → shown as "~4 min", estimated: true
\`\`\`

- **The flag keeps the degradation honest.** The screen shows "~4 min", not "4 min".
- **No retry on the request path.** A second 500 ms would be spent on a service that just said it is
  slow, while the rider waits. Retries belong where a second try is likely to succeed — a background
  job — not here.
- **Never cache an estimate.** Cached for 60 s, a 500 ms outage becomes a minute of wrong numbers
  for every rider in that cell pair.

:::widget deadline-retry {"base": 100, "deadline": 500, "attempts": 1}

:::quiz
Q: \`Eta\` fails with \`DEADLINE_EXCEEDED\` at 500 ms. Why answer with the straight-line estimate rather than retry once?
- [ ] Because gRPC forbids retrying a deadline failure
- [x] A retry costs the rider another 500 ms against a service that just proved slow; a flagged estimate now is better
- [ ] Because the estimate is more accurate than the routing service
> The deadline bounded the cost of finding out; spending it twice doubles the wait with no new information. Decide the acceptable worse answer in advance, switch to it on exactly "slow or gone", and say so to the caller.
:::

# What to take away

- **Claim before you work.** \`SET … NX EX\` is the check and the claim in one step; order the
  branches by cost so a request you will refuse never touches the store.
- **Stream what moves.** One client stream per driver: back-pressure, one setup, a clear end.
- **Index *where*, lease *still here*.** A GEO set remembers forever; a TTL key is a heartbeat. Check
  both, and over-fetch, because the filters come after the index.
- **A lock is a value with a lease.** \`SET NX EX\` to acquire, the holder's id as the value, a
  compare-and-delete to release — never a blind \`DEL\`.
- **Key the log by the entity, project it through a state machine.** Per-key order plus a transition
  table turns at-least-once replay into a no-op; skip illegal events *and commit*.
- **Decide the degraded answer in advance.** A deadline on the call, a fallback on exactly the "slow
  or gone" statuses, a flag on the result, no retry, no caching of the guess.

The primary source is Matt Ranney's
[*Scaling Uber's Real-time Market Platform*](https://www.infoq.com/presentations/uber-market-platform)
(QCon, 2015): an hour on DISCO in the team's own words — why supply and demand are separate services,
how the geospatial index is sharded, and what the matching loop optimises.
`;
