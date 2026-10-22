/**
 * The learning guide for r/place: the concepts the five steps rest on, in the order a reader meets
 * them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/reddit-place/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

For 72 hours in April 2017 Reddit ran **r/place**: a 1000 × 1000 canvas, sixteen colours, and one
rule — any logged-in user may paint one pixel every five minutes. Everyone saw the same board, live;
about 80 000 browsers were connected at the peak and almost 200 tiles a second were painted. The
course rebuilds the backend as one service, **place**, over Redis and Kafka:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Client", "sub": "browser · bots · scrapers", "x": 9, "y": 50},
    {"id": "api", "kind": "http", "label": "place-api", "sub": "steps 1–3 · the board, the cooldown, the event", "x": 31, "y": 30},
    {"id": "stream", "kind": "grpc", "label": "tile-stream", "sub": "step 4 · one server stream per client", "x": 31, "y": 70},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "board · cooldown:{user} · place:leaders · history:{x}:{y}", "x": 55, "y": 30},
    {"id": "kafka", "kind": "kafka", "label": "placements", "sub": "key = x:y · one record per painted tile", "x": 55, "y": 70},
    {"id": "worker", "kind": "service", "label": "leaderboard", "sub": "step 5 · consumer group, two read models", "x": 79, "y": 70}
  ],
  "edges": [
    {"from": "client", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "client", "to": "stream", "kind": "grpc", "label": "StreamTiles"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "GET · SET NX EX · SETRANGE"},
    {"from": "api", "to": "kafka", "kind": "kafka", "label": "produce"},
    {"from": "kafka", "to": "stream", "kind": "kafka", "label": "consume (own group)"},
    {"from": "kafka", "to": "worker", "kind": "kafka", "label": "consume"},
    {"from": "worker", "to": "redis", "kind": "redis", "label": "ZINCRBY · LPUSH · LTRIM"}
  ]
}
:::

- **The board** is one Redis string, served whole by \`GET /board\` with headers written for a CDN.
- **The cooldown** is one Redis key per user whose expiry *is* the five-minute rule.
- **A painted tile is an event** on the \`placements\` topic; the request does not wait for it.
- **Every client holds one gRPC server stream** and sees each tile as it lands.
- **A consumer** turns the same stream into a leaderboard and a per-pixel history.

Reddit's own stack had Fastly, Cassandra and a websocket service in those places; the course keeps the
decisions the post defends and closes the one race it regrets.

# The board is one string

Reddit's first design was a Cassandra row of a million columns, one per pixel; reading it took up to
30 seconds. The one that shipped was a Redis
[bitfield](https://redis.io/docs/latest/commands/bitfield/) of a million 4-bit integers, read whole
in under 100 ms. The course keeps the shape and drops the packing — **one byte per pixel**:

\`\`\`text
SIZE   = 100                         (Reddit: 1000)
offset = y * SIZE + x                (row-major; Reddit: x + 1000·y, in 4-bit units)
byte   = colour index, 0–15
board  = exactly SIZE * SIZE bytes   (10 000 here; 500 000 for Reddit's two-pixels-per-byte board)
\`\`\`

The pixel at \`(3, 7)\` is byte \`703\`. That arithmetic buys three things:

- **Read whole in one command.** \`GET board\` returns the entire canvas; the client indexes into it.
  A missing or short key is padded with zeros — an untouched board is all colour 0.
- **Write one pixel in place.** \`SETRANGE board 703 <byte>\` overwrites one byte at a computed
  offset. No read, no lock, no read-modify-write; on a fresh key Redis zero-fills up to the offset.
  Two hundred placements a second never contend, because each touches one byte.
- **Nothing else lives in the hot structure.** Who painted the pixel and when is a different
  question with its own structure (last section). The board holds colours only, which is what keeps
  it small enough to ship on every refresh.

| Design | Read the whole board | Write one pixel | Size |
| --- | --- | --- | --- |
| Wide Cassandra row | 1 000 000 columns, up to 30 s | one column write | author + colour + time per cell |
| Redis 4-bit bitfield (Reddit) | one \`GET\`, under 100 ms | \`BITFIELD SET u4 #offset\` | 500 KB |
| Redis one-byte string (here) | one \`GET\`, 10 000 bytes | \`SETRANGE\` at \`y·SIZE + x\` | 10 KB |

:::quiz
Q: Why keep the board as a flat string of colour indexes rather than a hash of \`"x:y" → {colour, user, ts}\`?
- [x] So the whole board is one fixed-size read and a pixel is one in-place byte write, with no read-modify-write
- [ ] Because Redis hashes cannot hold a million fields
- [ ] Because strings are replicated and hashes are not
> A hash with a million fields reads as a million field-value pairs; a string reads as one blob the client indexes by offset, and SETRANGE updates one byte without reading first. Author and timestamp belong to a structure sized for its own query.
:::

# Read by everyone: shape it for the cache

Every client fetches the board on load and on every reconnect. Reddit planned for 100 000
simultaneous users and feared bursts of refreshes hitting Redis at once. Since the board is one
shared global state, the answer was a cache, placed at the CDN, as close to the clients as possible:

:::sequence
{
  "participants": ["Client", "CDN", "place-api", "Redis"],
  "messages": [
    {"from": "Client", "to": "CDN", "label": "GET /board", "kind": "sync"},
    {"from": "CDN", "to": "place-api", "label": "GET /board (miss)", "kind": "sync"},
    {"from": "place-api", "to": "Redis", "label": "GET board", "kind": "sync"},
    {"from": "Redis", "to": "place-api", "label": "10 000 bytes", "kind": "reply"},
    {"from": "place-api", "to": "CDN", "label": "200 octet-stream · Cache-Control: public, max-age=1, stale-while-revalidate=5 · ETag: \\"…\\"", "kind": "reply"},
    {"from": "CDN", "to": "Client", "label": "200 — served from cache for the next second", "kind": "reply"},
    {"from": "CDN", "to": "place-api", "label": "GET /board · If-None-Match: \\"…\\" (a second later)", "kind": "sync"},
    {"from": "place-api", "to": "CDN", "label": "304, empty body, same ETag and Cache-Control", "kind": "reply"}
  ]
}
:::

- \`application/octet-stream\`, exactly \`SIZE * SIZE\` bytes: a fixed-size binary body is the cheapest
  thing to cache and the simplest thing for a browser to index.
- \`Cache-Control: public, max-age=1\` — the origin sees at most one request per edge node per second,
  however many clients refresh. Fastly ran around 33 points of presence, so Reddit's origin saw at
  most ~33 board requests a second from 100 000 clients; the graphs in the post confirm it.
- [\`stale-while-revalidate=5\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#stale-while-revalidate)
  — when the second rolls over, the edge keeps serving the copy it has while one request refreshes
  it, instead of letting every waiting client fall through together.
- An \`ETag\` derived from the bytes, and **304** with an empty body when \`If-None-Match\` matches: a
  revalidation that costs headers rather than 10 000 bytes. The 304 carries the same \`ETag\` and
  \`Cache-Control\` so the cache can extend the entry it already holds.

A board that is a second stale is fine: the client does not learn about new tiles from \`/board\` but
from the stream (two sections on); \`/board\` is only the starting picture.

The write endpoint has the opposite shape. \`POST /place\` with \`{"x", "y", "color", "user"}\` is a
funnel: \`x\`/\`y\` outside \`[0, SIZE)\`, \`color\` outside \`[0, 16)\` or an empty \`user\` is a **400**
before anything touches Redis — three comparisons reject most bad input for free. A user still on
cooldown gets **429** with \`Retry-After: <seconds>\`; a painted tile answers **200** with the tile.

:::widget status-codes {}

:::quiz
Q: A hundred thousand clients refresh the board within the same second. How many reads does Redis see?
- [ ] A hundred thousand — one per client
- [x] About one per CDN edge node, because every copy is good for a second
- [ ] One, because the API caches the board in memory
> max-age=1 lets each edge serve its copy for a second; stale-while-revalidate keeps it serving while one request refreshes it. Reddit's origin never saw more than ~33 board requests a second, one per Fastly POP.
:::

# The cooldown is a lock whose expiry is the rule

Reddit's draw path was: read the user's last-placement timestamp from Cassandra and reject if it is
younger than five minutes; write the tile; write the new timestamp; tell the websocket service.
Nothing locked the first three steps, so parallel requests from one account all passed the check
before any wrote the timestamp — about 15 000 tiles (0.09 % of all placements) got through that way,
a [time-of-check to time-of-use](https://en.wikipedia.org/wiki/Time-of-check_to_time-of-use) race.
The course makes the race inexpressible:

:::sequence
{
  "participants": ["place-api", "Redis"],
  "messages": [
    {"from": "place-api", "to": "Redis", "label": "SET cooldown:ana 1 NX EX 300", "kind": "sync"},
    {"from": "Redis", "to": "place-api", "label": "OK — ana was free, and is now on cooldown", "kind": "reply"},
    {"from": "place-api", "to": "Redis", "label": "SETRANGE board 703 0x0c", "kind": "sync"},
    {"from": "Redis", "to": "place-api", "label": "10 000 (new length)", "kind": "reply"},
    {"from": "place-api", "to": "Redis", "label": "SET cooldown:ana 1 NX EX 300  (100 s later)", "kind": "sync"},
    {"from": "Redis", "to": "place-api", "label": "(nil) — key exists", "kind": "reply"},
    {"from": "place-api", "to": "Redis", "label": "TTL cooldown:ana", "kind": "sync"},
    {"from": "Redis", "to": "place-api", "label": "200 → 429, Retry-After: 200", "kind": "reply"}
  ]
}
:::

\`place_tile(user, x, y, color)\` returns the seconds the user still has to wait — **0** when the tile
was painted — and it is one command deep:

- [\`SET cooldown:{user} 1 NX EX 300\`](https://redis.io/docs/latest/commands/set/) — \`NX\` writes only
  if the key does not exist, \`EX 300\` makes it vanish after \`COOLDOWN_S\` seconds. The reply is the
  whole check: set → the user was free and is now on cooldown; not set → refuse. Asking and claiming
  are one atomic step, so a thousand parallel requests from one bot produce exactly one tile.
- Refused → \`TTL cooldown:{user}\`, returned as the wait, at least 1 (the TTL reads \`-2\` if the key
  expired between the two commands; \`max(1, ttl)\` keeps the answer honest). The endpoint maps it
  straight to \`Retry-After\`.
- Accepted → \`SETRANGE board <y * SIZE + x> <byte>\`. Painting happens *after* the claim.

| Order | What a race or a crash costs |
| --- | --- |
| \`GET\`/\`EXISTS\` the key, then \`SET\` it | two requests both see "free" and both paint — Reddit's 15 000 tiles |
| \`SET NX EX\`, then \`SETRANGE\` | a claim for a tile never painted costs one user one turn; nobody else sees anything |
| \`SETRANGE\`, then \`SET NX EX\` | a tile painted by a user who should have been refused is what everyone sees |

The same key is the lock and the business rule — no second store for the timestamp, no cleanup job,
and the five minutes is one number. The shape generalises: "one email per signup", "one job per
minute per tenant", "one retry in flight" are all \`SET … NX EX\`. Reddit turned the cooldown knob
several times during the event to shed load; here that knob is the \`EX\` argument.

:::quiz
Q: Why does \`place_tile\` claim the cooldown key before writing the pixel, rather than after?
- [ ] Because SETRANGE fails on a key that does not exist yet
- [x] Because a claim without a pixel costs one user one turn, while a pixel without a claim is visible to everyone and cannot be undone
- [ ] Because the TTL has to start before the write for Retry-After to be exact
> If the process dies between the two commands, one order leaves a user waiting five minutes for a tile that never landed; the other lets a bot paint a tile it should have been refused. The first failure is private and bounded; the second is what the rule exists to prevent.
:::

# A painted tile is an event, not a call

Reddit's last draw step was a synchronous call to the websocket service, and the message bus behind
it was what broke: when it buckled under the burst, the only lever left was to lengthen the cooldown
for everyone. The course puts a log between the write and its consumers. \`record_placement\` runs
right after \`place_tile\` returned 0 and produces one record on the \`placements\` topic:

:::sequence
{
  "participants": ["place-api", "Producer", "Kafka"],
  "messages": [
    {"from": "place-api", "to": "place-api", "label": "place_tile → 0 (painted)", "kind": "sync"},
    {"from": "place-api", "to": "Producer", "label": "produce(placements, key=\\"3:7\\", value={user, x, y, color, ts}) · poll(0)", "kind": "async"},
    {"from": "place-api", "to": "place-api", "label": "200 sent to the client — before the broker answers", "kind": "sync"},
    {"from": "Producer", "to": "Kafka", "label": "batch → partition hash(\\"3:7\\") % 8", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack (offset 41 207)", "kind": "reply"},
    {"from": "Producer", "to": "place-api", "label": "delivery callback — a failure is logged, not raised", "kind": "async"}
  ]
}
:::

\`\`\`json
{"user": "ana", "x": 3, "y": 7, "color": 12, "ts": 1491523200123}
\`\`\`

- **Keyed by the tile**, \`"{x}:{y}"\`, not the user. The key is the ordering contract: one key, one
  partition, in order. The per-pixel history needs one pixel's placements in order; a user's tile
  count is a sum and does not care. Pick the thing whose order matters.
- **The request does not wait for the broker.** A producer is a buffer with a background thread:
  \`produce\` enqueues in microseconds and the network happens later in batches. \`poll(0)\` right after
  \`produce\` serves delivery callbacks; then return. Only \`flush()\` waits, and it lives in
  \`shutdown()\` so a clean stop loses nothing.
- **Failures are logged, nothing more.** The board in Redis is the truth; the event is a
  notification. A slow or dead broker must not turn a painted pixel into a 5xx, nor undo the tile.
- **A rejected tile is not an event**; \`ts\` is epoch **milliseconds**, the unit the history uses too.

:::widget kafka-partitions {"partitions": 8}

What the log buys is the second consumer: the tile stream and the leaderboard read the same records
in their own groups, a slow one falls behind on its own, and the write path never changes.

:::quiz
Q: The Kafka brokers are unreachable for two minutes. What should \`POST /place\` do for a user whose cooldown is clear?
- [ ] Return 503 until the broker is back, so no placement goes unrecorded
- [x] Paint the tile, answer 200, and let the producer log the delivery failure
- [ ] Paint the tile, then undo it with SETRANGE when the delivery callback reports an error
> The cooldown and the pixel are already in Redis — that is the placement. Losing an event during an outage is a gap in a notification stream, not a wrong board. Blocking or reverting would make the write path depend on the thing Reddit found breaks first.
:::

# Fanning tiles out: one stream per client

Every open client holds one server-streaming call and receives each placement as it happens — the
gRPC shape of "tell me everything from now on": one request, an open HTTP/2 stream, messages pushed
until someone hangs up.

\`\`\`proto
service Place {
  rpc StreamTiles(Subscribe) returns (stream Tile);
}
message Subscribe { string client = 1; }
message Tile      { uint32 x = 1; uint32 y = 2; uint32 color = 3; string user = 4; int64 ts = 5; }
\`\`\`

Each **tile-stream** instance consumes \`placements\` in its own consumer group and publishes every
record onto a per-instance bus; a handler is a loop around a queue from that bus:

:::sequence
{
  "participants": ["Client", "tile-stream", "tile bus"],
  "messages": [
    {"from": "Client", "to": "tile-stream", "label": "StreamTiles(Subscribe{client: web})", "kind": "sync"},
    {"from": "tile-stream", "to": "tile bus", "label": "subscribe() → queue; done callback registered: unsubscribe(queue)", "kind": "sync"},
    {"from": "tile bus", "to": "tile-stream", "label": "{ana, 3, 7, 12, ts}", "kind": "async"},
    {"from": "tile-stream", "to": "Client", "label": "Tile{3, 7, 12, ana, ts}", "kind": "async"},
    {"from": "tile bus", "to": "tile-stream", "label": "{bo, 3, 8, 1, ts}", "kind": "async"},
    {"from": "tile-stream", "to": "Client", "label": "Tile{3, 8, 1, bo, ts}", "kind": "async"},
    {"from": "Client", "to": "tile-stream", "label": "cancel → done callback → unsubscribe(queue)", "kind": "async"}
  ]
}
:::

:::widget grpc-streams {"mode": "server"}

Two rules around the loop are what let it survive at 80 000 clients:

- **Every subscription dies with its call.** Cleanup is registered the moment the handler subscribes
  — \`add_done_callback\` / \`ctx.Done()\` / \`setOnCancelHandler\` — not written at the end of the handler,
  because on a cancellation the end never runs. Whatever killed the stream, the callback
  unsubscribes; a subscription that outlives its stream is a leak per disconnect.
- **A slow reader is dropped, not buffered.** More than \`MAX_LAG\` (1000) tiles queued for one client
  ends the call with \`RESOURCE_EXHAUSTED\`, rather than the server holding minutes of backlog per
  slow reader until memory runs out.

Dropping would be rude if reconnecting were expensive. It is not, because of the client's start-up
order — the trick the whole design turns on:

1. Open \`StreamTiles\` **first** and start buffering tiles.
2. Fetch \`/board\` — a snapshot that may be a second stale.
3. Replay the buffered tiles onto it; keep drawing every tile that follows.

A snapshot plus every change since *before* it was generated is a consistent picture; there is no
gap for a tile to fall into. Reverse the order and a tile painted in between is lost until reload.

:::details What 4 Gbps of tiny messages taught Reddit
Reddit's 24 websocket instances pushed over 4 Gbps at the peak, and the team assumed they were
network-bound with headroom to spare. The CPU graphs said otherwise: per-message work, not bytes,
is the cost of fan-out. The browser already batched every tile that arrived between animation frames
into one draw per ~16 ms; real deployments batch tiles per 50 ms frame on the server too.
:::

:::quiz
Q: A client on a bad connection falls 1 500 tiles behind its stream. What does the server do?
- [ ] Keeps queueing; the client will catch up when its connection improves
- [x] Ends the call with RESOURCE_EXHAUSTED; the client reconnects and refetches the cached board
- [ ] Skips ahead to the newest tile and keeps streaming from there
> A backlog per slow reader is memory spent on the worst client, and at tens of thousands of clients it is how the fan-out tier dies. A reconnect costs one cached GET /board plus a new stream, and because the stream opens before the board is fetched, the client comes back consistent.
:::

# Two read models from one stream

"Who placed this pixel?" was the most popular request of the original and the only one the CDN could
not cache; scrapers pulled the whole board through it one tile at a time. The course answers it —
and "who has placed the most?" — from Redis structures a consumer in group \`leaderboard\` keeps up
to date from \`placements\`:

| Question | Structure | Write | Read |
| --- | --- | --- | --- |
| Top 10 users by tiles — \`GET /top\` | sorted set \`place:leaders\` | \`ZINCRBY place:leaders 1 {user}\` | \`ZREVRANGE place:leaders 0 9 WITHSCORES\` → \`[{"user", "tiles"}, …]\` |
| Last placements on a pixel — \`GET /history?x=&y=\` | capped list \`history:{x}:{y}\` | \`LPUSH\` + \`LTRIM 0 9\` | \`LRANGE history:{x}:{y} 0 9\` → \`[{"user", "color", "ts"}, …]\` |

- The sorted set is the leaderboard structure: \`ZINCRBY\` keeps it ordered on every write, creating
  key and member when they do not exist; the top 10 is one O(log n + 10) read, no scan, no sort.
- \`LPUSH\` then \`LTRIM 0 9\` is the Redis idiom for "the last N, newest first" — \`HISTORY_LEN\` = 10,
  the trim bound inclusive: bounded memory, no cleanup job, and the per-pixel key is exactly the
  lookup the hover makes, one O(1) read.
- \`/history\` validates \`x\`/\`y\` against \`[0, SIZE)\` and answers **400** before building the key.
- Both structures are derived: replay the topic and they come back, so a lost Redis is an
  inconvenience, not a data loss.

Where the commit sits decides the guarantee. Auto-commit acknowledges records on a timer, *before*
the worker knows they were counted; a crash then loses tiles silently. So auto-commit is off, and the
worker writes to Redis first and commits the offset second —
[at-least-once](https://kafka.apache.org/documentation/#semantics): a crash between the two replays
the record and over-counts by one instead of losing it. A scoreboard occasionally one too high beats
one that is quietly short. The one record the worker must not stop on is a malformed one — crash,
restart, same poison message, crash again has no exit — so it logs, commits past it and moves on.

:::widget delivery-semantics {}

:::widget consumer-groups {"partitions": 8}

:::quiz
Q: The leaderboard worker crashes after \`ZINCRBY\` and \`LPUSH\` but before committing the offset. What happens on restart?
- [ ] The tile is lost from the leaderboard; the offset had already moved on
- [x] The record is read again, the user gets one extra tile, and the pixel's history has a duplicate entry
- [ ] Redis rolls back the two writes because the commit never arrived
> Process-then-commit redelivers the uncommitted record and counts it twice: at-least-once. Commit-then-process would have moved the offset past a record never counted: at-most-once. For a scoreboard the duplicate is the cheaper mistake, and replaying the topic fixes either.
:::

# What to take away

- **Store the hot state as the thing the client needs.** A board of colour indexes is one string:
  read whole with one \`GET\`, written one byte in place with \`SETRANGE\` at \`y·SIZE + x\`. Author,
  timestamp and counts live in structures sized for their own queries.
- **Shape the hot read for the cache in front of it.** \`max-age=1\` turns 100 000 clients into one
  origin request per edge per second; \`stale-while-revalidate\` keeps that true when the second
  rolls over; an \`ETag\` makes a revalidation a 304.
- **Check and claim in one command.** \`SET cooldown:{user} 1 NX EX 300\` is the lock and the rule;
  a check followed by a write is the race that let 15 000 tiles through.
- **Decouple the write from its consumers.** One \`placements\` record per painted tile, keyed by the
  thing whose order matters, produced without waiting; a dead broker is a logged warning, not a 5xx.
- **Bound what fan-out holds per client.** One server stream each, cleanup in the done callback, a
  lag cap that ends the call — safe because the client opens the stream before it fetches the board.
- **Put the commit after the work.** At-least-once for a scoreboard: an occasional extra tile beats a
  silent gap, and the topic replays both read models from scratch.

The primary source is Reddit's
[*How We Built r/Place*](https://www.redditinc.com/blog/how-we-built-rplace) (Brian Simpson, Matt
Lee and Daniel Ellis, 2017): the Cassandra row that took 30 seconds, the bitfield that replaced it,
the Fastly graphs, the race the team owned up to, and the CPU-bound websocket boxes.
`;
