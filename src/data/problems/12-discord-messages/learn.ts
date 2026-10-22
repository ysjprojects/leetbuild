/**
 * The learning guide for Message Storage: the concepts the six steps rest on, in the order a reader
 * meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/discord-messages/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

Discord keeps every message ever sent and serves the newest fifty of any channel in a few
milliseconds — whether the channel has three messages or three hundred million, and even when a goal
in a World Cup final sends a million people into one channel at once. The store grew from 12
Cassandra nodes in 2017 to 177 by 2022, then moved to 72 ScyllaDB nodes holding trillions of rows,
fronted by Rust **data services**. The course rebuilds six mechanisms:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Client", "sub": "POST · GET /channels/{id}/messages", "x": 6, "y": 50},
    {"id": "api", "kind": "http", "label": "messages-api", "sub": "steps 1, 2, 6 · snowflake, bucket walk, hash ring", "x": 24, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "recent:{channel} list · channel:{id} hash", "x": 46, "y": 12},
    {"id": "data", "kind": "grpc", "label": "data-service ×3", "sub": "step 3 · GetMessages, one read per hot key", "x": 46, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "message-events", "sub": "step 5 · key = channel id", "x": 46, "y": 88},
    {"id": "db", "kind": "db", "label": "messages", "sub": "(channel_id, bucket) partitions · message_id", "x": 68, "y": 50},
    {"id": "worker", "kind": "service", "label": "channel-state", "sub": "consumer group · last id, count", "x": 68, "y": 88}
  ],
  "edges": [
    {"from": "client", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "api", "to": "data", "kind": "grpc", "label": "GetMessages · ring(channel_id)"},
    {"from": "api", "to": "db", "kind": "plain", "label": "INSERT"},
    {"from": "data", "to": "db", "kind": "plain", "label": "SELECT one bucket"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "LRANGE · LPUSH"},
    {"from": "api", "to": "kafka", "kind": "kafka", "label": "produce"},
    {"from": "kafka", "to": "worker", "kind": "kafka", "label": "consume"},
    {"from": "worker", "to": "redis", "kind": "redis", "label": "HSET · HINCRBY"}
  ]
}
:::

- **Write** (step 1): \`POST\` mints a **snowflake** id, derives a 10-day **bucket** from it, inserts
  one row keyed \`(channel_id, bucket, message_id)\`.
- **Read** (step 2): \`GET\` walks buckets backwards from the newest wanted message, remembering the
  empty ones.
- **Shape the load** (steps 3 and 4): a gRPC data service **coalesces** identical concurrent reads,
  and a **consistent hash ring** sends every request for a channel to the same instance.
- **Fan out** (step 5): one \`message-events\` record per message, keyed by channel; a consumer keeps
  per-channel state in Redis.
- **Shortcut the hot head** (step 6): the newest page of a channel in a Redis list, written through
  on every post.

# A snowflake is an id and a clock

Every id at Discord — message, channel, user, guild — is a
[snowflake](https://en.wikipedia.org/wiki/Snowflake_ID): a 64-bit integer whose high bits are a
timestamp. The course mints one in \`next_id(now_ms)\`:

\`\`\`text
id = (now_ms - DISCORD_EPOCH_MS) << 22 | WORKER_ID << 17 | PROCESS_ID << 12 | seq
\`\`\`

| Bits | Field | Course value | What it buys |
| --- | --- | --- | --- |
| 63–22 (42) | milliseconds since the Discord epoch | \`2015-01-01T00:00:00Z\` | ids sort by time; 139 years of room |
| 21–17 (5) | worker id | \`1\` | two machines never collide |
| 16–12 (5) | process id | \`0\` | two processes on one machine never collide |
| 11–0 (12) | sequence within the millisecond | \`0..4095\`, masked with \`0xFFF\` | 4,096 ids per millisecond per process |

A message sent at noon on 15 October 2026 as the eighth id of its millisecond:

\`\`\`text
1560260955340931079  =  371995200000 << 22  |  1 << 17  |  0 << 12  |  7
\`\`\`

- **No central counter.** Uniqueness comes from the worker and process bits, not a database sequence.
- **Never backwards.** A repeated or earlier \`now_ms\` keeps the last millisecond and bumps \`seq\`;
  when \`seq\` wraps to 0, the generator moves on to the *next* millisecond rather than reuse one.
- **Sorting by id is sorting by time.** \`ORDER BY message_id DESC\` is "newest first" with no
  \`created_at\` column; \`message_id < before\` is "older than the cursor".
- **Ids leave as strings.** A snowflake is 64 bits; a JSON number is only safe to 2⁵³, so \`201\`
  answers \`{"id": "1560260955340931079", …}\`. The gRPC wire keeps them as \`uint64\`.

:::quiz
Q: Why does the timestamp go in the *high* bits rather than the low ones?
- [ ] High bits are cheaper to compare
- [x] So that integer order is time order: sorting and range-scanning by id is sorting and range-scanning by time
- [ ] Because the worker id must stay below 2¹⁷
> With the timestamp on top, every id minted later is numerically larger, whatever worker or sequence produced it. That one property lets the schema drop a time column and paginate on the id alone.
:::

# Partition by channel, then by ten days

A chat store's reads are almost all "the newest N of one channel". A global table scatters a
channel's history across every node; one partition per channel keeps it together but grows without
bound. Discord's 2017 schema splits the difference — the primary key is \`(channel_id, bucket,
message_id)\`, with the bucket a 10-day window of snowflake time:

\`\`\`text
bucket_of(id) = (id >> 22) // BUCKET_MS          BUCKET_MS = 10 days in milliseconds
\`\`\`

| Window | Bucket | Partition key |
| --- | --- | --- |
| 10–20 October 2026 | \`430\` | \`(1032…, 430)\` |
| 30 September – 10 October 2026 | \`429\` | \`(1032…, 429)\` |
| the channel's first ten days | \`bucket_of(channel_id)\` | its creation partition |

- **One channel, one window, one partition.** A channel's recent history sits together on one node; a
  page of it is one contiguous range scan, ordered by \`message_id DESC\`.
- **The bucket costs nothing to compute** — one shift, one division, no clock lookup on the read side.
- **It is a column anyway**, part of the primary key, so a query names exactly one partition:
  \`WHERE channel_id = … AND bucket = … AND message_id < … ORDER BY message_id DESC LIMIT …\`.
- **A channel id is a snowflake too**, so \`bucket_of(channel_id)\` is the bucket the channel was
  created in — a free, exact floor for any walk backwards: nothing was sent before the channel existed.

:::quiz
Q: Why partition by \`(channel_id, bucket)\` rather than by \`channel_id\` alone?
- [ ] Buckets make the id shorter
- [x] One channel's entire history on one partition grows without bound; a 10-day window caps the partition while keeping recent messages together
- [ ] Cassandra cannot sort within a partition
> Per-channel partitioning gives the locality a page read wants, but a partition is what one node holds. Slicing by time bounds each partition and still keeps the recent messages — the ones a read wants — together.
:::

# Reading a page: walk the buckets backwards

"The newest 50 older than \`before\`" starts in \`bucket_of(before)\` and walks one bucket back at a time
until the page is full, asking each bucket only for what is still missing:

:::sequence
{
  "participants": ["Client", "messages-api", "messages"],
  "messages": [
    {"from": "Client", "to": "messages-api", "label": "GET /channels/1032…/messages?limit=50", "kind": "sync"},
    {"from": "messages-api", "to": "messages", "label": "SELECT … bucket = 430 AND message_id < before LIMIT 50", "kind": "sync"},
    {"from": "messages", "to": "messages-api", "label": "38 rows", "kind": "reply"},
    {"from": "messages-api", "to": "messages", "label": "SELECT … bucket = 429 … LIMIT 12", "kind": "sync"},
    {"from": "messages", "to": "messages-api", "label": "0 rows → known_empty[channel] += 429", "kind": "reply"},
    {"from": "messages-api", "to": "messages", "label": "SELECT … bucket = 428 … LIMIT 12", "kind": "sync"},
    {"from": "messages", "to": "messages-api", "label": "12 rows", "kind": "reply"},
    {"from": "messages-api", "to": "Client", "label": "200 [50 messages, newest first]", "kind": "reply"}
  ]
}
:::

- \`limit\` defaults to **50**, must be **1–100**; anything else is a **400**. No \`before\` means
  \`latest_snowflake()\`, an id newer than anything minted so far.
- Each query reads **one partition** with \`LIMIT limit - len(page)\`: the first bucket fills most of the
  page, the next only tops it up.
- **Two exits, one skip.** Stop when the page is full; stop when the bucket drops below
  \`bucket_of(channel_id)\`; skip buckets already known to be empty.

Busy channels pay nothing: their page fills from the first bucket. Quiet channels are the price — a
server that talks twice a month spreads fifty messages over dozens of windows, and without a memo
every page load re-reads every empty one. So the walk remembers them in \`known_empty\`, with one
subtlety:

| Bucket returned 0 rows | Mark it empty? | Why |
| --- | --- | --- |
| older than the starting bucket | yes | the query had no cursor constraint inside it; empty means empty |
| the starting bucket itself | **no** | \`message_id < before\` filtered it; it may hold newer messages |

:::details The twenty-second channel
The 2017 post tells the story behind the memo: a channel whose owner had deleted millions of messages
left millions of tombstones in otherwise empty buckets, and a page load scanned every one — twenty
seconds per request. Real systems persist the memo, invalidate it when old messages are imported, and
cap the buckets one request may scan.
:::

:::quiz
Q: A request for \`before = X\` scans the starting bucket and gets zero rows. Should that bucket go into \`known_empty\`?
- [ ] Yes — zero rows is zero rows
- [x] No — the query only asked for ids below \`X\`; the bucket may hold messages newer than the cursor
- [ ] Only if the channel has been quiet for ten days
> The starting bucket is the only one whose query carries a cursor that cuts inside it. A later request with no cursor would find messages there; memoising it as empty would make them vanish until the process restarted.
:::

# The data service: one read per hot key

The 2023 post is about **hot partitions**: a popular channel's reads pile onto one node, and every
other channel on that node slows with it. Discord's answer was a layer of gRPC **data services**
between the API and the database — one endpoint per query, no business logic — with one trick,
**request coalescing**:

:::sequence
{
  "participants": ["messages-api", "data-service", "messages"],
  "messages": [
    {"from": "messages-api", "to": "data-service", "label": "GetMessages(ch 1032…, before, 50) ×400 within 8 ms", "kind": "sync"},
    {"from": "data-service", "to": "data-service", "label": "inflight[(ch, before, 50)] missing → start read_page task", "kind": "sync"},
    {"from": "data-service", "to": "messages", "label": "SELECT … bucket = 430 … LIMIT 50 (once)", "kind": "sync"},
    {"from": "data-service", "to": "data-service", "label": "399 callers await the same task", "kind": "sync"},
    {"from": "messages", "to": "data-service", "label": "50 rows", "kind": "reply"},
    {"from": "data-service", "to": "data-service", "label": "inflight.pop(key)", "kind": "sync"},
    {"from": "data-service", "to": "messages-api", "label": "GetMessagesReply{50 messages} ×400", "kind": "reply"}
  ]
}
:::

\`\`\`proto
service MessageData {
  rpc GetMessages(GetMessagesRequest) returns (GetMessagesReply);
}
message GetMessagesRequest { uint64 channel_id = 1; uint64 before = 2; uint32 limit = 3; }
message Message           { uint64 id = 1; uint64 author_id = 2; string content = 3; }
message GetMessagesReply  { repeated Message messages = 1; }
\`\`\`

- **The key is the whole query:** \`(channel_id, before, limit)\`. The first caller starts the bucket
  walk as a task and records it in \`inflight\`; every caller arriving while it runs **subscribes** to
  that task. One read, N replies.
- **The key leaves when the read finishes** — success or failure, in a done-callback, exactly once.
  The next identical request reads fresh data.
- **A subscriber hanging up must not cancel the read**: each caller awaits the shared task through
  \`asyncio.shield\`, so one client's timeout stays that client's problem.
- **A failed read fails every subscriber** with \`UNAVAILABLE\`.

Coalescing is a cache with a lifetime of one request: nothing is stored, nothing can go stale, and
the database sees one query per hot key per round trip instead of one per client. It fits a chat
system because the hot key is never a secret — it is the newest page of the channel everyone just
opened. Go's [singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight) is the same idea as a
library; real deployments export the coalescing ratio as the metric that says a partition is hot
before the database does.

:::widget cache-aside {"stampede": true}

:::quiz
Q: Why remove the key from \`inflight\` the moment the read completes rather than keeping the result for a second?
- [ ] Because gRPC replies cannot be reused
- [x] So the shared answer is only ever one that was in flight when the caller asked — no staleness to reason about, no invalidation to build
- [ ] To save memory
> Keeping results turns coalescing into a cache, with everything a cache needs: a TTL, invalidation on write, a freshness story. Coalescing shares only work that is genuinely concurrent; the database still answers every distinct instant.
:::

# Routing by channel: a consistent hash ring

Coalescing only helps when identical requests meet in the **same** data-service instance; a load
balancer that spreads 400 identical requests over three instances gets three database reads. The
API's client side routes by **channel**, and keeps routing the same way when an instance leaves or
joins — [consistent hashing](https://en.wikipedia.org/wiki/Consistent_hashing):

:::sequence
{
  "participants": ["messages-api", "data-2:9000", "data-3:9000"],
  "messages": [
    {"from": "messages-api", "to": "messages-api", "label": "ring.pick(1032…) → _hash(\\"1032…\\") → next point clockwise: data-2", "kind": "sync"},
    {"from": "messages-api", "to": "data-2:9000", "label": "GetMessages(1032…, before, 50) · deadline 300 ms", "kind": "sync"},
    {"from": "data-2:9000", "to": "messages-api", "label": "GetMessagesReply{50 messages}", "kind": "reply"},
    {"from": "messages-api", "to": "messages-api", "label": "ring.remove(\\"data-2:9000\\") → 1032… now maps to data-3", "kind": "sync"},
    {"from": "messages-api", "to": "data-3:9000", "label": "GetMessages(1032…, before, 50) · deadline 300 ms", "kind": "sync"},
    {"from": "data-3:9000", "to": "messages-api", "label": "GetMessagesReply{50 messages}", "kind": "reply"}
  ]
}
:::

- **A 2⁶⁴ circle.** Each of the three instances in \`INSTANCES\` owns \`VNODES\` (**100**) points on it,
  at \`_hash(f"{node}#{i}")\`, kept as a sorted list of \`(position, node)\`.
- **pick.** Hash \`str(channel_id)\`, take the first point at or after it, wrapping round. One channel,
  one instance — from every API process.
- **remove.** Drop exactly that node's points. Every other point stays where it was, so every channel
  that mapped to a survivor still does — the **minimal move** guarantee.
- **A 300 ms deadline** (\`DEADLINE_S\`) on every \`GetMessages\`; a deadline that passes propagates as
  the gRPC error it is.

Why not \`hash(channel) % 3\`? It routes one channel to one instance too — until you go from 3
instances to 4 and two thirds of all channels change homes at once, every one a cold coalescing table:

| Change | \`hash % N\` | Ring with virtual nodes |
| --- | --- | --- |
| instance leaves | nearly every channel moves | only its ~⅓ of channels move, spread over the survivors |
| instance joins | nearly every channel moves | ~¼ of channels move, taken a little from each |
| share per instance | exact | close to equal with 100 points each; very uneven with 1 |

:::widget deadline-retry {"base": 50, "deadline": 300, "attempts": 1}

Discord routes on the channel id for messages and on other keys for other services — each chosen so
that the requests that *would* coalesce share a key.

:::quiz
Q: Three data-service instances, one is replaced during a deploy. What should happen to the routing of channels that lived on the other two?
- [x] Nothing — their points on the ring did not move, so they keep their instance and their warm coalescing tables
- [ ] They are rebalanced evenly across all three
- [ ] They all move to the new instance until it is warm
> A membership change moves only the keys that had to move. A rebalance that touches every channel would turn each deploy into a cluster-wide cold spot — what the ring exists to avoid.
:::

# Message events: one record per message, state in Redis

A stored message is not done: search indexes it, the gateway pushes it to connected clients, unread
counters move. None of that belongs on the request path, so the API publishes one event and answers
**201**:

:::sequence
{
  "participants": ["messages-api", "Kafka", "channel-state", "Redis"],
  "messages": [
    {"from": "messages-api", "to": "Kafka", "label": "produce message-events key=1032… {message.created, id 1561…}", "kind": "async"},
    {"from": "Kafka", "to": "channel-state", "label": "poll → record (partition 4, offset 88 120)", "kind": "reply"},
    {"from": "channel-state", "to": "Redis", "label": "HSET channel:1032… last_message_id 1561…", "kind": "sync"},
    {"from": "channel-state", "to": "Redis", "label": "HINCRBY channel:1032… messages 1", "kind": "sync"},
    {"from": "Redis", "to": "channel-state", "label": "(integer) 48 213", "kind": "reply"},
    {"from": "channel-state", "to": "Kafka", "label": "commit offset 88 121 (partition 4)", "kind": "sync"}
  ]
}
:::

The record is \`{"type": "message.created", "channel_id", "id", "author_id", "content"}\`, ids as
strings:

- **Keyed by the channel id**, not the message id, so a channel's events land on one partition and
  one consumer sees them **in order** — which is what makes \`last_message_id\` safe to overwrite: it
  can only move forward.
- **Enqueue and return.** \`publish\` hands the record to the producer; \`poll(0)\` serves delivery
  callbacks, failures are logged by \`on_delivery\`, nothing waits for the broker.
- **Consumer group** \`channel-state\`, auto-commit **off**: \`HSET channel:{id} last_message_id\`,
  \`HINCRBY channel:{id} messages 1\`, **then** commit.
- **Poison messages are logged, committed and skipped** — malformed JSON, or JSON that is not a
  \`message.created\` with a channel and an id — rather than crash-looping on one record forever.

:::widget kafka-partitions {"partitions": 6}

Commit-after-write is [at-least-once](https://kafka.apache.org/documentation/#semantics): a crash
between the Redis write and the commit replays the record and over-counts by one, which a counter can
tolerate and a lost event could not.

:::widget consumer-groups {"partitions": 6}

Real pipelines make the counter idempotent too — remember the last applied id per channel, skip
anything not newer — and size the partition count for the hottest channel, not the average.

:::quiz
Q: The consumer writes to Redis, then crashes before committing. What does the system see after it restarts?
- [ ] The event is lost; the count is one short
- [x] The record is redelivered and applied again; \`last_message_id\` is unchanged and \`messages\` is one too high
- [ ] Kafka detects the duplicate and skips it
> Commit-after-write means the broker never heard that the record was handled, so it comes back. The HSET is idempotent by nature; the HINCRBY is not, and over-counting by one is the accepted price of never losing an event.
:::

# Hot channels: write-through, not cache-aside

For a hot channel one request dominates: "the newest 50, no cursor". Coalescing turned a thousand of
those into one database read per instant; a bounded list per channel turns them into none. The write
path, one pipeline after \`store_message\` and \`publish\`:

\`\`\`text
LPUSH  recent:{channel_id}  {"id": "1561…", "author_id": "7781…", "content": "…"}
LTRIM  recent:{channel_id}  0 99        # RECENT_N = 100
EXPIRE recent:{channel_id}  300         # RECENT_TTL_S
\`\`\`

The read path answers from the list under exactly two conditions, and otherwise goes to the data
service with \`before or latest_snowflake()\`:

| Request | \`LRANGE\` returns | Answer from |
| --- | --- | --- |
| no \`before\`, \`limit=50\` | 50 or more items | the list |
| no \`before\`, \`limit=50\` | 49 items | the data service — a short list says nothing about item 50 |
| any \`before\` | — | the data service; the list only knows the head |

- **One writer.** The request that stored the message pushes it, so the head of the list is the newest
  message by construction; a full page from it can be trusted without a version or a timestamp.
- **Reads never write the list.** A read-populated list would race the write that happened between
  the database read and the push, and could shadow a newer message until the TTL rescued it.
- **The TTL bounds memory, not staleness.** \`EXPIRE 300\` lets a cold channel stop paying rent.
- **Both branches answer the same shape** — \`[{"id", "author_id", "content"}]\` with string ids.

:::widget cache-aside {"stampede": false}

This is the opposite of [cache-aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside),
where a miss fills the cache and the cache may lag a write until it expires. Discord's 2017 post
says they "do not want to have to cache messages in Redis" — the database is fast enough for the
long tail. The hot head of a popular channel is a different workload, and a bounded write-through
list is the usual answer to it; real systems invalidate it on edits and deletes.

:::quiz
Q: \`LRANGE recent:{channel} 0 49\` returns 30 items for a request with \`limit=50\` and no cursor. What should the API do?
- [ ] Answer the 30; a hot channel's reader wants speed over completeness
- [ ] Answer the 30 and top up from the data service
- [x] Ignore the list and ask the data service for the whole page
> Thirty items prove only that thirty messages were posted since the list was last empty or expired; message 31 may well exist in the database. The list is a shortcut only when it can answer alone.
:::

# What to take away

- **Put the clock in the id.** A snowflake sorts by time, mints without coordination, and yields its
  partition with a shift and a division; the only tax is sending it as a string.
- **Partition for the read you actually serve.** \`(channel_id, bucket)\` keeps recent messages
  together and every partition bounded; a page walks buckets backwards, with a memo for the empty
  ones and the channel's own id as the floor.
- **Shape concurrency in one place.** A thin data service coalesces identical in-flight reads: one
  query per hot key per instant, no cache, nothing stale.
- **Route so that work can be shared.** A consistent hash ring with virtual nodes sends every request
  for a channel to one instance, and moves only that instance's channels when membership changes.
- **Keep the write path short and the rest asynchronous.** One event per message, keyed by channel
  for order, committed after the side effect; the hot head of a channel in a write-through list that
  only the writer touches.

The primary source is Discord's
[*How Discord Stores Trillions of Messages*](https://discord.com/blog/how-discord-stores-trillions-of-messages)
(Bo Ingram, 2023) — the data services, coalescing and routing in the team's own words — with the
schema from
[*How Discord Stores Billions of Messages*](https://discord.com/blog/how-discord-stores-billions-of-messages)
(Stanislav Vishnevskiy, 2017).
`;
