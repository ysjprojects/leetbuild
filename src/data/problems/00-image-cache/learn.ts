/**
 * The learning guide for Image Cache Microservice: the concepts the six steps rest on, in the order a
 * reader meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/image-cache/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

Every product page draws dozens of thumbnails. The originals in the object store are megabytes; the
page wants kilobytes, fast, and **the same bytes for the same request every time**. The real thing is
a CDN edge in front of an image proxy — imgix, Cloudinary, a self-hosted Thumbor. The course rebuilds
the one service under all of that, **thumbs**, which answers \`GET /img/{id}?w=<width>\` and keeps the
expensive part — fetching an original and resizing it — from happening more than once per image and
size:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Browser", "sub": "GET /img/{id}?w=256 · If-None-Match", "x": 9, "y": 50},
    {"id": "thumbs", "kind": "http", "label": "thumbs", "sub": "step 1 · validate, headers, 304", "x": 31, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "thumb:{id}:{w} · lock:… · views:{id}", "x": 55, "y": 16},
    {"id": "resizer", "kind": "grpc", "label": "Resizer", "sub": "step 4 · Resize(id, w) · 800 ms", "x": 55, "y": 84},
    {"id": "origin", "kind": "external", "label": "Origin store", "sub": "originals", "x": 80, "y": 84},
    {"id": "kafka", "kind": "kafka", "label": "image-views", "sub": "step 5 · key = image id", "x": 70, "y": 46},
    {"id": "analytics", "kind": "service", "label": "view-counter", "sub": "step 6 · INCR, then commit", "x": 91, "y": 46}
  ],
  "edges": [
    {"from": "client", "to": "thumbs", "kind": "http", "label": "HTTPS"},
    {"from": "thumbs", "to": "redis", "kind": "redis", "label": "GET / SET EX"},
    {"from": "thumbs", "to": "resizer", "kind": "grpc", "label": "Resize"},
    {"from": "resizer", "to": "origin", "kind": "plain", "label": "fetch original"},
    {"from": "thumbs", "to": "kafka", "kind": "kafka", "label": "produce"},
    {"from": "kafka", "to": "analytics", "kind": "kafka", "label": "consume"},
    {"from": "analytics", "to": "redis", "kind": "redis", "label": "INCR"}
  ]
}
:::

- **Serve** (step 1): validate the width, send bytes a browser and a CDN can cache and revalidate.
- **Cache** (step 2): Redis cache-aside keyed \`thumb:{id}:{width}\`, a day's TTL, a 60-second sentinel
  for images that do not exist.
- **Collapse** (step 3): when a popular key expires, one request renders and the rest wait.
- **Render** (step 4): a unary gRPC \`Resize\` with an 800 ms deadline and one retry on \`UNAVAILABLE\`.
- **Log** (step 5): one \`image-views\` record per request, keyed by image id, never awaited.
- **Count** (step 6): consumer group \`view-counter\` turns the stream into \`views:{id}\` counters,
  committing only after the increment.

Left out on purpose: signed URLs, format negotiation, the JPEG decoding itself, multi-region
replication and purging.

# Three caches and one miss path

One URL passes through three caches before anyone decodes a JPEG:

| Cache | Lives in | Keyed by | A hit costs | Lifetime |
| --- | --- | --- | --- | --- |
| Browser | the user's machine | the URL | nothing — no request | \`max-age=86400\`, then one \`304\` |
| CDN / shared proxy | an edge near the user | the URL | one edge round-trip | the same \`max-age\`; \`public\` lets it store |
| Redis | beside the service | \`thumb:{id}:{width}\` | one \`GET\` | 86400 s for bytes, 60 s for a sentinel |

A miss in all three reaches the resizer: fetch the original, decode, resize, encode — up to the
800 ms the client will wait. Every decision in the course is about how rarely that path runs and how
it behaves when it does: the headers decide how often the **browser** comes back; the TTL and the
sentinel, how often **Redis** sends a request onward; the lock, how many of those become **one**
render; the deadline and the retry rule, what a render costs when the resizer is unwell.

:::quiz
Q: Why does the handler send \`Cache-Control: public, max-age=86400\` rather than just \`max-age=86400\`?
- [ ] \`public\` makes the browser cache it for longer
- [x] \`public\` tells CDNs and shared proxies they may store the response, not only the user's browser
- [ ] \`public\` is required for the \`ETag\` to be honoured
> \`max-age\` is the lifetime; \`public\` is the permission. A thumbnail is the same for every user, so a shared cache may serve it — which is where most hits in the real system happen.
:::

# Headers browsers and CDNs cache by

The handler runs in a fixed order — reject, look up, represent — so nothing expensive happens for a
request it will refuse:

1. **Validate.** \`w\` from the query string, default 256; outside **16–2048** → **400**, before the
   cache or the resizer is touched.
2. **Look up.** \`get_thumb(id, width)\`; nothing → **404**.
3. **Represent.** \`Content-Type: image/jpeg\`, \`Cache-Control: public, max-age=86400\`, and an \`ETag\`
   that is a quoted prefix of the bytes' hash — the first 16 hex digits of \`sha256(bytes)\`.
4. **Revalidate.** \`If-None-Match\` equal to that tag → **304** with the same \`ETag\` and
   \`Cache-Control\`, no body; the browser keeps its copy.

The tag is a function of the bytes, not of a clock or a counter, so every instance computes the same
tag and a \`304\` from a different machine than the one that served the \`200\` is still correct. That is
all [\`If-None-Match\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match) is:
the browser proposes a tag, the server confirms or replaces it. The server also terminates TLS itself
on \`:8443\`; a service that can speak HTTPS on its own is the one you can run anywhere.

:::widget status-codes {}

:::quiz
Q: A browser sends \`If-None-Match\` with a tag that matches. What does the handler send back?
- [x] 304 with the same \`ETag\` and \`Cache-Control\` headers and an empty body
- [ ] 200 with the bytes, since the cache lookup already happened
- [ ] 204, because there is no content
> The point of the round-trip is to skip the body. The headers must still be there: \`Cache-Control\` restarts the browser's day, the \`ETag\` confirms which representation it keeps. 204 means "done, nothing to show"; 304 means "what you have is still right".
:::

# Cache-aside with a TTL and a sentinel

[Cache-aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside) puts the
cache beside the service, not in front of it: read the cache; on a miss fetch, store, return. Three
branches, and the first runs almost all the time:

| Branch | Redis says | thumbs does | Answer |
| --- | --- | --- | --- |
| Hit | the bytes | return them | 200 |
| Hit on the sentinel | \`__missing__\` | return nothing, no render | 404 |
| Miss, rendered | \`(nil)\` | \`render\` → \`SET … EX 86400\` | 200 |
| Miss, missing | \`(nil)\` | \`render\` says none → \`SET … __missing__ EX 60\` | 404 |

\`\`\`text
GET thumb:cat:256                       → (nil)
SET thumb:cat:256 <jpeg bytes> EX 86400
GET thumb:cat:256                       → <jpeg bytes>       hit for the next day

GET thumb:ghost:256                     → (nil)
SET thumb:ghost:256 __missing__ EX 60
GET thumb:ghost:256                     → __missing__        404 without asking the resizer
\`\`\`

- **One key per rendered size.** A 256-wide and a 512-wide thumbnail of one image are different
  bytes, so different entries.
- **The cache is an optimisation.** Flush Redis and the service still works, only slower.
- **The TTL bounds staleness and memory.** A cache without TTLs only grows.
- **Negative caching.** A missing image is a cached *fact*: a sentinel value under the same key,
  written by the same \`SET … EX\`. Only the value and the TTL differ.

:::details Why the sentinel lives 60 seconds and the bytes a day
The two TTLs follow the cost of being wrong. A rendered thumbnail stays right as long as the original
does not change — for an object store, close to forever; a day is a compromise with memory. A missing
image may stop being missing at any moment (the upload is still propagating), and every minute the
sentinel lives is a minute of 404s for an image that now exists. Real caches also jitter TTLs so
entries written together do not expire together, and cap memory with an eviction policy such as
\`allkeys-lru\`.
:::

:::quiz
Q: A broken page requests \`/img/ghost?w=256\` on every scroll event, and \`ghost\` does not exist. Without negative caching, what happens?
- [ ] Nothing: a 404 is cheap
- [x] Every request misses in Redis and calls the resizer, which fetches from the origin and answers NOT_FOUND each time
- [ ] Redis stores an empty value after the first miss
> A miss on a missing image is the most expensive kind: no bytes are ever written, so the cache never warms, and the full miss path runs on every request. The sentinel turns that into a hit after the first one.
:::

# One render per key

A popular thumbnail expires at 86400 s. In the next few milliseconds hundreds of requests \`GET\` the
key, all see \`(nil)\`, and all call the resizer for the same bytes — a
[cache stampede](https://en.wikipedia.org/wiki/Cache_stampede). The fix is a per-key mutex made of one
Redis key: exactly one of them renders, the rest wait for its value.

:::sequence
{
  "participants": ["req A", "req B", "Redis", "render"],
  "messages": [
    {"from": "req A", "to": "Redis", "label": "SET lock:thumb:cat:256 1 NX EX 5 → OK", "kind": "sync"},
    {"from": "req B", "to": "Redis", "label": "SET lock:thumb:cat:256 1 NX EX 5 → (nil)", "kind": "sync"},
    {"from": "req A", "to": "render", "label": "render(cat, 256)", "kind": "sync"},
    {"from": "req B", "to": "Redis", "label": "sleep 50 ms · GET thumb:cat:256 → (nil) · again…", "kind": "sync"},
    {"from": "render", "to": "req A", "label": "jpeg bytes", "kind": "reply"},
    {"from": "req A", "to": "Redis", "label": "SET thumb:cat:256 <bytes> EX 86400 · DEL lock:thumb:cat:256", "kind": "sync"},
    {"from": "Redis", "to": "req B", "label": "GET thumb:cat:256 → <bytes>", "kind": "reply"}
  ]
}
:::

| Role | How it knows | What it does |
| --- | --- | --- |
| Leader | \`SET lock:{key} 1 NX EX 5\` answered \`OK\` | render, \`store\` the value (or the sentinel), \`DEL\` the lock, return |
| Follower | the same \`SET\` answered \`(nil)\` | every 50 ms, \`GET\` the key; return the value when it appears |
| Orphaned follower | 5 s passed and nothing appeared | the leader died; render itself |

- \`NX\` **is the exclusion**: the \`SET\` succeeds for exactly one caller.
- \`EX\` **is the liveness**: a leader that crashes mid-render leaves a lock that expires on its own
  after 5 s. No operator ever deletes one.
- **Release in a** \`finally\`, so an exception in \`render\` does not leave followers waiting the full
  TTL for a value that is not coming.
- **Followers have a deadline**, computed once as \`now + 5 s\`. One that sees the sentinel returns
  nothing, like a hit would.

This is *single flight* in its simplest form: identical requests in flight collapse to one call and
share the result. Production variants avoid polling (Pub/Sub on the key, or in-process single-flight)
and serve the *stale* value while one request refreshes it — stale-while-revalidate — which removes
the wait entirely.

:::widget cache-aside {"stampede": true}

:::quiz
Q: The leader takes the lock, calls the resizer, and is killed before it stores anything. What do the followers experience?
- [ ] They wait forever, because nobody deletes the lock
- [x] They poll until their 5 s deadline passes, then render themselves; the lock has expired by then
- [ ] They get the sentinel and answer 404
> \`EX 5\` is there for exactly this case. The followers' deadline is the lock's TTL, so when it passes the lock is gone too, and a follower rendering itself is just another miss.
:::

# Deadlines and the one retry worth making

The resizer is an internal service with a one-method contract:

\`\`\`proto
service Resizer {
  rpc Resize(ResizeRequest) returns (ResizeReply);
}
message ResizeRequest { string image_id = 1; uint32 width = 2; }
message ResizeReply   { bytes jpeg = 1; }
\`\`\`

\`render(id, width)\` is one call on the generated stub, with two decisions around it: how long to
wait, and which failures deserve a second attempt:

:::sequence
{
  "participants": ["thumbs", "Resizer", "Origin"],
  "messages": [
    {"from": "thumbs", "to": "Resizer", "label": "Resize(cat, 256) · deadline 800 ms", "kind": "sync"},
    {"from": "Resizer", "to": "Origin", "label": "fetch cat.jpg", "kind": "sync"},
    {"from": "Origin", "to": "Resizer", "label": "original bytes", "kind": "reply"},
    {"from": "Resizer", "to": "thumbs", "label": "ResizeReply{jpeg}", "kind": "reply"},
    {"from": "thumbs", "to": "Resizer", "label": "Resize(ghost, 256) · deadline 800 ms", "kind": "sync"},
    {"from": "Resizer", "to": "thumbs", "label": "status NOT_FOUND → render returns nothing → sentinel", "kind": "reply"}
  ]
}
:::

| Status | What it means | What \`render\` does |
| --- | --- | --- |
| \`OK\` | here are the bytes | return them |
| \`NOT_FOUND\` | the origin has no such image | return nothing — a normal outcome, cached as the sentinel |
| \`UNAVAILABLE\` | the resizer is restarting, a connection dropped | one more attempt, then give up |
| \`DEADLINE_EXCEEDED\` | the 800 ms budget is spent | propagate; a retry would spend it again |
| \`INVALID_ARGUMENT\` | the request itself is wrong | propagate; it will fail again |
| anything else | | propagate |

- **The deadline is on the call** — a timeout argument, a context with a timeout, a stub option — not
  a timer around it. The server sees it too and can stop work nobody is waiting for; that is how
  [gRPC deadlines](https://grpc.io/docs/guides/deadlines/) differ from a client-side alarm.
- **800 ms per attempt.** The worst case for a request is two attempts, 1.6 s, then an error.
- **Retry only what might succeed.** \`UNAVAILABLE\` is transient by definition; everything else
  either already cost the budget or is deterministic.
- **Bounded.** At most two attempts, never \`while True\`: a resizer down for a minute would otherwise
  pin every request thread for that minute — and the lock's followers with them.

Without a deadline, a slow dependency becomes a slow *you*; without a bound, a dependency that is
briefly down meets a wall of retries the moment it comes back. Production clients add jittered
backoff and propagate the caller's remaining deadline (\`grpc-timeout\` on the wire).

:::widget deadline-retry {"base": 100, "deadline": 800, "attempts": 2}

:::quiz
Q: The first \`Resize\` attempt fails with \`DEADLINE_EXCEEDED\`. Should \`render\` try again?
- [ ] Yes — the resizer might be faster the second time
- [x] No — the request has already waited 800 ms; a second attempt doubles the hang for the same odds
- [ ] Yes, but with a shorter deadline
> A deadline is a budget the caller agreed to. Once it is spent, the honest outcome is an error, not another wait. Only \`UNAVAILABLE\` — a failure that cost almost nothing and is likely to clear — earns the second attempt.
:::

# A view event per request, never awaited

Analytics wants to know which images are viewed at which sizes. Every request produces one record on
the \`image-views\` topic, and does not wait to find out whether it arrived:

\`\`\`json
key:   "cat"
value: {"id": "cat", "w": 256, "hit": true, "ts": 1700003600.42}
\`\`\`

:::sequence
{
  "participants": ["thumbs", "Producer", "Kafka"],
  "messages": [
    {"from": "thumbs", "to": "Producer", "label": "produce(image-views, key=cat, value=json) · poll(0)", "kind": "async"},
    {"from": "thumbs", "to": "thumbs", "label": "return 200 to the browser", "kind": "sync"},
    {"from": "Producer", "to": "Kafka", "label": "batch, a few ms later → partition hash(cat) % 4", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack (offset 1041)", "kind": "reply"},
    {"from": "Producer", "to": "thumbs", "label": "delivery callback — logs if err", "kind": "async"}
  ]
}
:::

- **A producer is a buffer with a background thread.** \`produce\`/\`send\` appends to an in-memory queue
  and returns in microseconds; the network happens later, in batches (\`linger.ms\` of 5). Only
  \`flush()\`, or blocking on the returned future, waits for the broker — never on the request path.
- **The key is the image id**, as bytes, not the JSON. The partitioner hashes the key, so every event
  for \`cat\` lands on one partition, in order. Across images there is no order, and nobody needs one.
- **Failures arrive through the delivery callback** and are logged; a lost analytics event is not
  worth a slow page. librdkafka-based clients run callbacks inside \`poll()\`, so the handler calls
  \`poll(0)\` after each \`produce\`.
- \`shutdown()\` **flushes**, with a 5 s timeout, and logs how many records were still undelivered: a
  clean stop loses nothing; a dead broker does not keep the process alive for ever.
- \`acks=1\` **is a choice.** The partition leader confirms before followers replicate; a leader
  failure in that window loses the record, which a view count can afford. Events that cannot be lost
  get \`acks=all\`, an idempotent producer so retries do not duplicate, and a bounded buffer
  (\`queue.buffering.max.messages\`) so a slow broker cannot grow the service's memory without limit.

:::widget kafka-partitions {"partitions": 4}

:::quiz
Q: A teammate changes \`emit_view\` to await the broker's acknowledgement "so we never lose an event". What is the consequence?
- [ ] Nothing visible; the ack takes microseconds
- [x] Every thumbnail response now includes a Kafka round-trip, and a slow or absent broker slows or breaks image serving
- [ ] Events arrive in a better order
> The event is a side product of serving an image; it must never become a prerequisite for it. Durability for events that matter is bought with \`acks=all\` and flushing at shutdown — not by making the request wait.
:::

# Counting views: where the commit sits

The analytics side is a consumer in group \`view-counter\` subscribed to \`image-views\`. For each
record it increments \`views:{id}\` in Redis and then — only then — commits the offset:

:::sequence
{
  "participants": ["Kafka", "view-counter", "Redis"],
  "messages": [
    {"from": "Kafka", "to": "view-counter", "label": "poll → record (partition 2, offset 1041) · key cat", "kind": "reply"},
    {"from": "view-counter", "to": "view-counter", "label": "parse JSON · malformed? log, commit, skip", "kind": "sync"},
    {"from": "view-counter", "to": "Redis", "label": "INCR views:cat", "kind": "sync"},
    {"from": "Redis", "to": "view-counter", "label": "(integer) 8213", "kind": "reply"},
    {"from": "view-counter", "to": "Kafka", "label": "commit offset 1042 (partition 2)", "kind": "sync"}
  ]
}
:::

\`\`\`text
enable.auto.commit = false      commit when I say so, not on a timer
auto.offset.reset  = earliest   a new group starts at the beginning of the topic
group.id           = view-counter
\`\`\`

Where the commit sits relative to the side effect is the whole decision; a crash between the two is
the case to design for:

| Order in the loop | Crash between the two | Guarantee | For a counter |
| --- | --- | --- | --- |
| commit, then \`INCR\` | the record is acknowledged and never counted | at-most-once | views silently under-count |
| \`INCR\`, then commit | the record is counted, then replayed and counted again | at-least-once | over by one, rarely |
| auto-commit on a timer | records acknowledged before you looked at them | at-most-once, at random | losses you cannot even see |

- **At-least-once is the right trade for a counter.** A rare duplicate is a rounding error; a lost
  batch is a hole. A payment needs the opposite care — storing the record id so the write is
  idempotent — which is what makes
  [delivery semantics](https://kafka.apache.org/documentation/#semantics) a per-consumer choice.
- \`INCR\` **is atomic**: group members and replayed records never race a read-modify-write.
- **Poison records are skipped, not fatal.** A record that does not parse is logged and *committed*,
  so the consumer moves on instead of crash-looping on one offset. Real consumers send it to a
  dead-letter topic.
- **Commit per record, or once per poll batch** after every record in it is counted; both keep the
  side effect ahead of the commit.
- **Partitions set the parallelism.** With four partitions, a fifth member of \`view-counter\` sits
  idle; the key's hash decides which partition — and so which member — counts \`cat\`.

:::widget delivery-semantics {}

:::quiz
Q: The consumer increments \`views:cat\` to 8213, then dies before committing offset 1042. What happens when it comes back?
- [x] It re-reads offset 1041, increments again, and \`views:cat\` ends at 8214 — one high
- [ ] The increment is rolled back by Kafka
- [ ] Offset 1041 is skipped, because it was already processed
> Kafka knows nothing about Redis; the only record of progress is the committed offset, and that still says 1041 is next. Replay is the price of never losing a record — the right price for a counter; anything that must not double-count makes the side effect idempotent instead.
:::

# What to take away

- **Serve bytes a cache can keep.** Validate first, then \`Cache-Control: public, max-age\`, an
  \`ETag\` from the bytes, and \`304\` for a matching \`If-None-Match\`.
- **Cache-aside is a pure optimisation.** Read, miss, render, \`SET … EX\`; one key per rendered size;
  a TTL bounds staleness and memory; a short-lived sentinel makes a missing image cheap.
- **Collapse the stampede.** \`SET lock NX EX\` makes one leader and bounded followers; \`EX\` and a
  \`finally\` keep a crashed leader harmless.
- **Every call has a deadline, every retry a bound.** 800 ms on the call itself; retry \`UNAVAILABLE\`
  once; \`NOT_FOUND\` is an answer, not an error.
- **Produce without waiting; commit after the side effect.** Key by image id for order, log delivery
  failures, flush at shutdown; in the consumer, \`INCR\` then commit, so a crash replays rather than
  loses.

The closest primary source is [Thumbor](https://github.com/thumbor/thumbor), the open-source image
proxy the statement names: its storage and result-storage layers, loaders and URL signing are the
production form of the cache, origin fetch and endpoint built here.
`;
