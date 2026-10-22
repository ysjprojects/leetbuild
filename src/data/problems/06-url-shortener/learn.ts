/**
 * The learning guide for URL Shortener: the concepts the five steps rest on, in the order a reader
 * meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/url-shortener/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

A URL shortener is the interview warm-up everybody has sketched and almost nobody has run. bit.ly
handled **6 billion clicks and 600 million shortens a month** in 2014 with about thirty servers on
the front line — and made its money not on the shortening but on what the clicks revealed. The
redirect is the product; everything else exists to make it fast and to count it. The course builds
**sho.rt** as five pieces:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Client", "sub": "POST /shorten · GET /{code}", "x": 9, "y": 50},
    {"id": "api", "kind": "http", "label": "sho.rt", "sub": "steps 1, 3 · validate, mint, redirect", "x": 31, "y": 50},
    {"id": "keys", "kind": "grpc", "label": "Key service", "sub": "step 2 · ReserveBlock(size) — counters in blocks", "x": 53, "y": 16},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "url:{code} cache · top:{day} sorted sets", "x": 53, "y": 50},
    {"id": "db", "kind": "db", "label": "links", "sub": "code → url · the source of truth", "x": 53, "y": 84},
    {"id": "kafka", "kind": "kafka", "label": "clicks", "sub": "step 4 · key = code", "x": 73, "y": 50},
    {"id": "worker", "kind": "service", "label": "top-links", "sub": "step 5 · consumer group, ZINCRBY", "x": 91, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "api", "to": "keys", "kind": "grpc", "label": "ReserveBlock"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "GET / SET EX"},
    {"from": "api", "to": "db", "kind": "plain", "label": "save · lookup"},
    {"from": "api", "to": "kafka", "kind": "kafka", "label": "produce"},
    {"from": "kafka", "to": "worker", "kind": "kafka", "label": "consume"},
    {"from": "worker", "to": "redis", "kind": "redis", "label": "ZINCRBY"}
  ]
}
:::

- **Shorten** (step 1): \`POST /shorten\` validates the URL, accepts a custom alias, answers **201**.
- **Mint codes** (step 2): a key service hands out blocks of a counter over gRPC; replicas turn them
  into base62 codes locally.
- **Redirect** (step 3): \`GET /{code}\` is one Redis hit — cache-aside with negative caching — and a
  **302**.
- **Count** (step 4): every redirect produces one \`clicks\` record without waiting for the broker.
- **Rank** (step 5): a consumer group keeps a per-day sorted set; \`GET /top?day=\` reads the top 10.

Two paths with opposite shapes: shortening is synchronous and rare, the redirect is synchronous and
constant, and everything that counts clicks is asynchronous and off to the side. Left out on
purpose: accounts, link expiry, malware screening, multi-region replication, the analytics warehouse.

# Codes are counters, not hashes

The short code is the whole product surface. Two ways to make one:

| | Hash the URL | Count |
| --- | --- | --- |
| Code | first 6–7 chars of \`md5(url)\` | \`base62(n)\`, \`n\` the next integer |
| Collisions | certain at scale: 7 base62 chars keep 42 bits of the hash | impossible: every \`n\` is used once |
| Who hands out codes | anyone, independently | **one** counter — the coordination problem |
| Length | fixed from day one | grows with \`n\`: 4 chars to 14 million, 6 to 56 billion |

Hashing looks coordination-free and is not: by the birthday bound collisions start around 2 million
links, and from then on every insert is a read-then-write against the links table with a retry
loop. A counter never collides; its one weakness — somebody must own it — is what the next section
solves. The encoding is **base62**, the 62 URL-safe alphanumerics, so a code carries no
percent-escapes:

\`\`\`text
ALPHABET = 0-9 a-z A-Z            (62 symbols)
base62(n): repeat n, rem = divmod(n, 62); prepend ALPHABET[rem]; until n == 0

62^4 =         14 776 336        every code up to 4 chars
62^6 =     56 800 235 584        6 chars
62^7 =  3 521 614 606 208        7 chars — bit.ly's size
\`\`\`

Codes come out **sequential**: \`g7tK\`, \`g7tL\`, \`g7tM\`. A counter is unguessable only if you need
it to be — then you add a random prefix or encrypt the integer before encoding. For a public
shortener it does not matter; a database sequence would give you the same thing.

:::quiz
Q: Why does sho.rt mint codes from a counter instead of hashing the long URL?
- [ ] A hash is slower to compute than a counter increment
- [x] A counter never collides, so a minted code needs no existence check on the write path
- [ ] Hashes cannot be encoded in base62
> Truncated hashes collide, and every collision is a read-then-write race against the links table. A counter trades that for a different problem — one owner for the number — which blocks over gRPC make cheap.
:::

# Blocks over gRPC: one call per thousand codes

One counter, many API replicas. Calling the counter per shorten would put a network round trip —
and a single point of failure — on every write. Instead the **key service** reserves a *block* of the
counter in one call, and the replica walks through it locally:

\`\`\`proto
service KeyService {
  rpc ReserveBlock(ReserveRequest) returns (ReserveReply);
}
message ReserveRequest { uint32 size = 1; }
message ReserveReply   { uint64 start = 1; uint32 size = 2; }
\`\`\`

:::sequence
{
  "participants": ["request thread", "key client", "Key service"],
  "messages": [
    {"from": "request thread", "to": "key client", "label": "next_code() — under the lock", "kind": "sync"},
    {"from": "key client", "to": "key client", "label": "remaining == 0 → refill", "kind": "sync"},
    {"from": "key client", "to": "Key service", "label": "ReserveBlock(size 1000) · deadline 500 ms", "kind": "sync"},
    {"from": "Key service", "to": "key client", "label": "UNAVAILABLE", "kind": "reply"},
    {"from": "key client", "to": "Key service", "label": "ReserveBlock(size 1000) — the one retry", "kind": "sync"},
    {"from": "Key service", "to": "key client", "label": "ReserveReply{start 3 842 000, size 1000}", "kind": "reply"},
    {"from": "key client", "to": "request thread", "label": "base62(start) · start++ · remaining = 999", "kind": "reply"},
    {"from": "request thread", "to": "key client", "label": "next_code() × 999 — no RPC", "kind": "sync"}
  ]
}
:::

The client is a few lines and three disciplines:

- **A block is a pair** \`(start, remaining)\`. \`next_code()\` returns \`base62(start)\`, then \`start + 1\`,
  \`remaining - 1\`. Refill **only** when \`remaining\` is 0: one RPC per \`BLOCK_SIZE\` (1000) codes.
- **A deadline on the call itself.** 500 ms, set as the RPC's timeout — not a sleep around it. A key
  service that hangs must not pin every shorten request behind it. gRPC propagates
  [deadlines](https://grpc.io/docs/guides/deadlines/) through the call so the server can stop work
  the client has given up on.
- **Retry once, on one status, nothing else.** \`UNAVAILABLE\` means "the connection or the server
  was not there" — a second attempt may land on a healthy instance. \`INVALID_ARGUMENT\` or
  \`INTERNAL\` will fail the same way twice; retrying them is load without hope. Two attempts total,
  a bounded loop, never \`while True\`.
- **Under a lock.** The block is shared by every request thread. Check, refill and advance are one
  atomic step, or two threads both see \`remaining == 0\`, both reserve, and a code is handed out
  twice — the one bug a shortener cannot have.

:::widget deadline-retry {"base": 100, "deadline": 500, "attempts": 2}

What the block buys: a key service outage is invisible until a replica's block runs dry, and the
codes left unused when a replica restarts are simply never minted. It is the same idea as Flickr's
[ticket servers](https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/):
centralise the *number*, not the *work*. Production key services pre-fetch the next block before
the current one empties, so the refill never sits on a request, and persist their high-water mark
so their own restart cannot re-issue a block.

:::quiz
Q: Two request threads call \`next_code()\` at the same instant and the block has one code left. Without the lock, what can happen?
- [ ] Nothing: gRPC serialises the calls
- [x] Both read the same \`start\`, hand out the same code, and both may reserve a fresh block
- [ ] One gets a code and the other gets \`UNAVAILABLE\`
> Check-refill-advance is three operations on shared state. Interleaved, two threads read the same counter before either increments it; the result is one short link that points at two long URLs. The lock makes the three one step; the key service never sees the race at all.
:::

# The shorten API: cheap checks first

\`POST /shorten\` takes \`{"url": "…", "alias": "…"}\` and either refuses or creates. It is shaped as a
**funnel**: every check is cheaper than the one after it, and every rejection returns before the
next step spends anything.

:::sequence
{
  "participants": ["Client", "sho.rt", "links", "key client"],
  "messages": [
    {"from": "Client", "to": "sho.rt", "label": "POST /shorten {url, alias: \\"launch\\"}", "kind": "sync"},
    {"from": "sho.rt", "to": "sho.rt", "label": "parse url: scheme http/https, ≤ 2048 chars — 400 otherwise", "kind": "sync"},
    {"from": "sho.rt", "to": "sho.rt", "label": "alias matches ^[A-Za-z0-9_-]{4,32}$ — 400 otherwise", "kind": "sync"},
    {"from": "sho.rt", "to": "links", "label": "exists(\\"launch\\")", "kind": "sync"},
    {"from": "links", "to": "sho.rt", "label": "false — 409 if true", "kind": "reply"},
    {"from": "sho.rt", "to": "key client", "label": "next_code() — only without an alias; may cost an RPC", "kind": "sync"},
    {"from": "sho.rt", "to": "links", "label": "save(\\"launch\\", url)", "kind": "sync"},
    {"from": "sho.rt", "to": "Client", "label": "201 {code, short_url} · Location: https://sho.rt/launch", "kind": "reply"}
  ]
}
:::

| Check | Costs | Fails with |
| --- | --- | --- |
| URL parses, scheme is \`http\` or \`https\`, length ≤ **2048** | CPU only | **400** |
| Alias matches \`^[A-Za-z0-9_-]{4,32}$\` | CPU only | **400** |
| Alias not already taken | one store lookup | **409** |
| No alias → \`next_code()\` | nothing, or one gRPC call per thousand | propagates |
| \`store.save(code, url)\` | one write | — |
| Reply | — | **201** + \`Location\` |

- **400 versus 409 is about what the client can do next.** A malformed alias can never succeed:
  400, "never send that". A taken alias is a well-formed request that lost a race for a name: 409
  Conflict, "pick another".
- **Parse, do not regex.** The standard library's URL parser decides what a URL is; the handler only
  inspects the scheme it returns.
- **201 says created; the header says where.** The body carries \`{"code", "short_url"}\`; \`Location\`
  carries the same short URL for anything HTTP-native. Both are built from \`BASE_URL\`
  (\`https://sho.rt/\`) and the code.
- The code is decided **before** the single \`save\` — the alias or \`next_code()\` — so nothing is
  written for a request that fails.

:::widget status-codes {}

Real shorteners put authentication and per-user quotas in front of this funnel and screen the target
against malware lists before saving. bit.ly's own rule for this path: shortening stays
**synchronous** — a user would rather see an error than receive a link that does not work.

:::quiz
Q: A client sends \`alias: "launch"\` and somebody already owns it. Why 409 rather than 400?
- [ ] 400 is reserved for malformed JSON
- [x] The request was well-formed; the name is simply taken, and the client can succeed by choosing another
- [ ] 409 tells caches not to store the response
> 4xx codes are instructions to the client. 400 means the request itself is wrong and resending it is pointless; 409 means the request was fine but conflicts with current state. A client that sees 409 can retry with \`launch-2\`; one that sees 400 should fix its input.
:::

# The redirect: one Redis hit

Reads outnumber writes by a hundred to one, and every one of them is a person waiting for a page.
So \`GET /{code}\` is built to be **one Redis round trip and nothing else** on the common path, with
the links table behind it as the source of truth:

:::sequence
{
  "participants": ["Browser", "sho.rt", "Redis", "links"],
  "messages": [
    {"from": "Browser", "to": "sho.rt", "label": "GET /g9Xc", "kind": "sync"},
    {"from": "sho.rt", "to": "Redis", "label": "GET url:g9Xc", "kind": "sync"},
    {"from": "Redis", "to": "sho.rt", "label": "(nil) — a miss; a hit ends here", "kind": "reply"},
    {"from": "sho.rt", "to": "links", "label": "lookup(\\"g9Xc\\")", "kind": "sync"},
    {"from": "links", "to": "sho.rt", "label": "https://example.com/launch", "kind": "reply"},
    {"from": "sho.rt", "to": "Redis", "label": "SET url:g9Xc <url> EX 86400", "kind": "sync"},
    {"from": "sho.rt", "to": "Browser", "label": "302 · Location · Cache-Control: private, max-age=0", "kind": "reply"},
    {"from": "Browser", "to": "sho.rt", "label": "GET /zzzzz (a scanner)", "kind": "sync"},
    {"from": "sho.rt", "to": "Redis", "label": "GET url:zzzzz → (nil) · lookup → nothing", "kind": "sync"},
    {"from": "sho.rt", "to": "Redis", "label": "SET url:zzzzz __missing__ EX 60", "kind": "sync"},
    {"from": "sho.rt", "to": "Browser", "label": "404 — and the next 60 s of tries never reach links", "kind": "reply"}
  ]
}
:::

This is **cache-aside**: the application, not the cache, decides what to load and when. The read
has three outcomes, and the hit branch is the one that runs almost every time:

| \`GET url:{code}\` returns | Meaning | Then |
| --- | --- | --- |
| a URL | hit | **302** — the request is done |
| \`__missing__\` | negative hit | **404** — no store call |
| nil | miss | \`store.lookup\`; URL → \`SET … EX 86400\`; nothing → \`SET __missing__ EX 60\` |

- **Both writes are the same command**, \`SET\` with an expiry; only value and TTL differ. A link lives in cache
  for a day; a cache without TTLs only grows.
- **Negative caching** matters more here than in most caches. Unknown codes are *the* abuse pattern
  — scanners walking the key space — and without the sentinel each probe is a database query.
- A handful of links take most of the clicks, so a day of TTL keeps them warm indefinitely.

:::widget cache-aside {}

Real shorteners add a local in-process cache in front of Redis for the top links, and jitter the TTL
so a popular link's entry does not expire on every replica at once.

:::quiz
Q: A bot requests 50 000 random codes a minute. What protects the links table?
- [ ] The 86400 s TTL on cached URLs
- [x] The 60 s \`__missing__\` sentinel: each unknown code costs the store one lookup a minute at most
- [ ] The 404 status, which tells the bot to stop
> A positive cache only helps for codes that exist. Scanners ask for codes that do not, so every probe would be a miss and a database query. Caching the *absence* turns the second and later probes of a code into a Redis hit — the same one-round-trip shape as a real redirect.
:::

# 302, not 301

The redirect status looks like a detail and is the decision the analytics stand on.

| Status | Browser behaviour | Consequence for a shortener |
| --- | --- | --- |
| **301** Moved Permanently | cached; later clicks go straight to the target | sho.rt sees the first click only; counting stops |
| **302** Found | not cached by default; every click comes back | every click is seen, every click is one Redis hit |
| **307** Temporary Redirect | like 302, and the method is preserved | equivalent for \`GET\`; the course accepts either |

Browsers cache a
[permanent redirection](https://developer.mozilla.org/en-US/docs/Web/HTTP/Redirections) and go
straight to the target next time. A shortener that answers 301 has handed its analytics to the
browser after the first click — and cannot change where the link points. So the redirect is:

\`\`\`http
HTTP/1.1 302 Found
Location: https://example.com/launch
Cache-Control: private, max-age=0
\`\`\`

- **private** keeps shared caches and CDNs from storing the redirect for other users; **max-age=0**
  says a stored copy is stale immediately. 302 alone is usually enough; the header makes the intent
  explicit to every intermediary.
- The price is one round trip to sho.rt per click — exactly the round trip the previous section made
  cheap.

:::details When a 301 is the right answer
If the short link is a *permanent* vanity address and nobody wants to count clicks or retarget it —
a documentation redirect, a renamed path on your own site — 301 is correct and kinder to the
network. The moment a redirect's destination may change, or the click is data, it is temporary by
definition. Shorteners are both.
:::

:::quiz
Q: A shortener answers 301. A user clicks the same short link ten times over a week. How many clicks does the shortener count?
- [x] One — the browser cached the redirect after the first and never came back
- [ ] Ten — each click is a new request
- [ ] Zero — 301 responses are not logged
> A permanent redirect is a promise that the mapping will not change, and browsers hold you to it by skipping you entirely next time. 302 (or 307) withdraws that promise, which is what keeps every click on your server.
:::

# Clicks: produced, never awaited

Every redirect is a click somebody wants to count, and a Kafka round trip is not allowed to spoil
the one-hit redirect. The producer is the escape: a buffer with a background thread, where
\`produce\` costs microseconds and the network happens later, in batches.

:::sequence
{
  "participants": ["sho.rt", "Producer", "Kafka"],
  "messages": [
    {"from": "sho.rt", "to": "sho.rt", "label": "302 sent to the browser", "kind": "sync"},
    {"from": "sho.rt", "to": "Producer", "label": "produce(clicks, key=g9Xc, value={code, ts, referrer, ua}) · poll(0)", "kind": "async"},
    {"from": "sho.rt", "to": "sho.rt", "label": "record_click returns — microseconds, no broker", "kind": "sync"},
    {"from": "Producer", "to": "Kafka", "label": "batch → partition hash(g9Xc) % 6", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack (offset 52 019)", "kind": "reply"},
    {"from": "Producer", "to": "sho.rt", "label": "delivery callback — failures logged, nothing else", "kind": "async"}
  ]
}
:::

One record per click on the \`clicks\` topic:

\`\`\`json
{"code": "g9Xc", "ts": 1759622400, "referrer": "https://news.example/", "ua": "Mozilla/5.0 …"}
\`\`\`

- **Keyed by the code**, not by the JSON. The partitioner hashes the key, so every click of one link
  lands on one partition, in order — and the consumer in the next section can count a link on one
  consumer without merging across partitions.
- **Hand the record to the producer and return.** Only \`flush()\`, or blocking on the delivery future,
  waits for the broker; neither belongs in \`record_click\`. A lost click is not worth a slow redirect.
- **Failures surface through the delivery callback** and are logged. For librdkafka-based clients
  the callback runs inside \`poll()\`, so \`record_click\` calls \`poll(0)\` after each produce to let
  pending reports fire; Java and kafka-go clients run it on the producer's I/O thread.
- **Shutdown flushes.** Buffered records are only on the wire when the producer sends them;
  \`shutdown()\` waits for that once, so a clean stop loses nothing.

:::widget kafka-partitions {"partitions": 6}

bit.ly runs the same split: the redirect is synchronous and returns as fast as it can; the event
"this link was decoded" goes on a queue for an archive, a real-time dashboard and long-term history —
none of which the redirect knows about. An *event* ("X happened") rather than a *command* ("count
X") is what lets a new consumer appear next month without touching the producer. Real pipelines
also enable
[idempotent producers](https://kafka.apache.org/documentation/#semantics) so their own retries
cannot double-count a click.

:::quiz
Q: The Kafka brokers are unreachable for two minutes. What does a user clicking a short link experience?
- [x] A normal 302; the producer buffers, and records beyond its buffer are reported as failures by the callback
- [ ] A 302 after a two-minute wait while the producer retries
- [ ] A 503, since the click cannot be recorded
> The redirect never depended on the broker — \`record_click\` enqueues and returns, and nothing on the request path waits for an acknowledgement. Clicks that cannot be delivered are logged through the callback; the user never knows.
:::

# Top links: a sorted set per day

The \`clicks\` stream is the raw material; the leaderboard is a **sorted set** per day in Redis, kept
current by a consumer in group \`top-links\`. Two ideas carry the section: the data structure, and
where the commit sits.

:::sequence
{
  "participants": ["Kafka", "top-links", "Redis", "Client"],
  "messages": [
    {"from": "Kafka", "to": "top-links", "label": "poll → record (partition 2, offset 52 019)", "kind": "reply"},
    {"from": "top-links", "to": "top-links", "label": "parse JSON — malformed? log, commit, skip", "kind": "sync"},
    {"from": "top-links", "to": "Redis", "label": "ZINCRBY top:2026-10-05 1 g9Xc", "kind": "sync"},
    {"from": "Redis", "to": "top-links", "label": "\\"8213\\"", "kind": "reply"},
    {"from": "top-links", "to": "Redis", "label": "EXPIRE top:2026-10-05 604800", "kind": "sync"},
    {"from": "top-links", "to": "Kafka", "label": "commit offset 52 020 (partition 2) — after the side effect", "kind": "sync"},
    {"from": "Client", "to": "top-links", "label": "GET /top?day=2026-10-05", "kind": "sync"},
    {"from": "top-links", "to": "Redis", "label": "ZREVRANGE top:2026-10-05 0 9 WITHSCORES", "kind": "sync"},
    {"from": "Redis", "to": "top-links", "label": "[g9Xc 8213, launch 5102, …]", "kind": "reply"},
    {"from": "top-links", "to": "Client", "label": "200 [{code, clicks}, …]", "kind": "reply"}
  ]
}
:::

## The leaderboard structure

A [sorted set](https://redis.io/docs/latest/develop/data-types/sorted-sets/) keeps members ordered by
a numeric score on every write, so there is no sort at read time:

\`\`\`text
ZINCRBY top:2026-10-05 1 g9Xc           → "8213"   O(log n); creates key and member if absent
EXPIRE  top:2026-10-05 604800           → 7 days; NX if the client supports it
ZREVRANGE top:2026-10-05 0 9 WITHSCORES → the top 10 with counts, O(log n + 10); 0 9 is inclusive
\`\`\`

- **Keyed by day** (\`day_key(ts)\` → \`top:YYYY-MM-DD\`): a natural partition and a natural expiry.
  The **7-day TTL** bounds memory with no cleanup job; re-arming it on every click is harmless.
- \`ZINCRBY\` is atomic, so six workers can increment the same set with no lock.
- \`GET /top?day=\` (default today) is one read: \`ZREVRANGE … 0 9 WITHSCORES\` → \`[{"code", "clicks"}]\`.

## Where the commit sits

Kafka remembers a consumer's progress as a **committed offset** per partition. *When* that offset
is committed, relative to the increment, decides what a crash does:

| Order | Semantics | A crash between the two |
| --- | --- | --- |
| commit, then \`ZINCRBY\` | at-most-once | the click is acknowledged and never counted — silently lost |
| auto-commit on a timer | at-most-once, at random | whatever was polled but not yet counted is lost |
| \`ZINCRBY\`, **then commit** | **at-least-once** | the record is redelivered and counted twice — one click too many |

The worker disables auto-commit and commits **after** \`ZINCRBY\` and \`EXPIRE\`. For a leaderboard the
choice is easy: an over-count by one on a link with thousands of clicks is invisible; a silently
missing click is unexplainable. Exactly-once would need the increment and the offset in one
transaction, which Redis and Kafka do not share.

:::widget delivery-semantics {}

- **A poison record is skipped, not retried forever.** Malformed JSON is logged and its offset
  committed; otherwise the consumer crashes, restarts, re-reads the same record and crashes again.
- **Six partitions, up to six useful consumers.** Partitions are the unit of parallelism in a group;
  a seventh member idles. Because clicks are keyed by code, one consumer sees every click of a link,
  in order.

Real pipelines keep an hourly set too, merge days with \`ZUNIONSTORE\` for "this week", and write the
raw clicks to a warehouse for the questions a sorted set cannot answer — clicks by country, by referrer.

:::quiz
Q: The worker crashes right after \`ZINCRBY\` and before committing the offset. What happens when it restarts?
- [ ] The click is lost; the sorted set is corrected on the next read
- [x] The record is delivered again and the link gains one extra click
- [ ] Kafka detects the duplicate and skips it
> The committed offset still points at the record, so the group re-delivers it, and the worker increments once more. That is at-least-once: a duplicate rather than a loss, which is the right error for a leaderboard. Committing first would have made the crash lose the click instead.
:::

# What to take away

- **Mint codes from a counter, not a hash.** base62 of an integer never collides; the only cost is
  one owner for the number, and blocks of 1000 over gRPC make that one RPC per thousand links.
- **Every remote call on a request path carries a deadline and a bounded retry.** 500 ms, one retry
  on \`UNAVAILABLE\`, nothing else — a slow dependency fails fast instead of pinning every thread.
- **Order checks by cost and answer with codes the client can act on.** 400 for "never send that",
  409 for "pick another", 201 with \`Location\` for "created, here".
- **The hot path is one cache hit, and absence is cached too.** \`url:{code}\` for a day, \`__missing__\`
  for a minute; scanners never reach the database.
- **302, so every click comes back; then log it without waiting.** A keyed, fire-and-forget producer
  turns one event per redirect into microseconds; a consumer that commits *after* the side effect
  turns the stream into a leaderboard that may over-count by one and never under-counts.

The primary source is Sean O'Connor's
[*Lessons Learned Building Distributed Systems at Bitly*](https://vimeo.com/96844401) (BACON, 2014):
a talk on why shortening stays synchronous, why the click is an event on a queue rather than a
command, and what 6 billion redirects a month teach about letting services fail independently.
`;
