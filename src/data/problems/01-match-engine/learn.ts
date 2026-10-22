/**
 * The learning guide for Match Engine: the concepts the six steps rest on, in the order a reader
 * meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/match-engine/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

Every order sent to an exchange ends up in a **matching engine**: a single-threaded loop per instrument
that keeps a limit order book and crosses each incoming order against the resting ones — strictly by
price, then by time. Everything around that loop exists to feed it reliably, in order, and to tell the
world what it did. The course builds the exchange in miniature, around one provided \`Book\`:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Trader", "sub": "POST /orders · SubscribeTicks · GET /book", "x": 8, "y": 50},
    {"id": "gateway", "kind": "http", "label": "gateway", "sub": "steps 1 and 6 · HTTPS :8443 · auth, validate, 202", "x": 25, "y": 50},
    {"id": "orders", "kind": "kafka", "label": "orders", "sub": "step 2 · key = symbol · acks=all", "x": 42, "y": 50},
    {"id": "engine", "kind": "service", "label": "engine", "sub": "step 3 · group engine · one Book per symbol", "x": 59, "y": 50},
    {"id": "trades", "kind": "kafka", "label": "trades", "sub": "one record per fill · key = symbol", "x": 76, "y": 18},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "step 4 · book:{symbol} · ticks:{symbol}", "x": 76, "y": 82},
    {"id": "ticks", "kind": "grpc", "label": "ticks", "sub": "step 5 · SubscribeTicks stream :9100", "x": 92, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "gateway", "kind": "http", "label": "HTTPS"},
    {"from": "gateway", "to": "orders", "kind": "kafka", "label": "produce · acks=all"},
    {"from": "orders", "to": "engine", "kind": "kafka", "label": "consume"},
    {"from": "engine", "to": "trades", "kind": "kafka", "label": "one per fill"},
    {"from": "engine", "to": "redis", "kind": "redis", "label": "MULTI HSET PUBLISH EXEC"},
    {"from": "redis", "to": "ticks", "kind": "redis", "label": "HGETALL · SUBSCRIBE"},
    {"from": "ticks", "to": "client", "kind": "grpc", "label": "stream Tick"},
    {"from": "gateway", "to": "redis", "kind": "redis", "label": "HGETALL (GET /book)"}
  ]
}
:::

- **Accept** (step 1): HTTPS, API key, \`Idempotency-Key\`, validation, **202** — a promise, not a fill.
- **Sequence** (step 2): \`orders\` **keyed by symbol**; the 202 waits for \`acks=all\`.
- **Match** (step 3): group \`engine\`, one \`Book\` per symbol, one \`trades\` record per fill, commit after
  the trades are acknowledged.
- **Publish** (step 4): hash \`book:{symbol}\` and a tick on \`ticks:{symbol}\`, in one \`MULTI\`/\`EXEC\`.
- **Stream** (step 5): a gRPC server stream — snapshot from the hash, then every tick from Pub/Sub.
- **Poll** (step 6): \`GET /book/{symbol}\` — validated, \`404\` when absent, never cached.

A real exchange has the same shape with every part hardened; the course keeps what transfers to any
system where order matters:

| Concern | Here | In a real exchange |
| --- | --- | --- |
| Entry | HTTPS, API key, \`Idempotency-Key\` | FIX sessions with sequence numbers, pre-trade risk checks |
| Sequencing | one Kafka partition per symbol | a sequencer stamping every input, replicated to hot standbys before the ack |
| Order types | limit only | IOC, FOK, iceberg, stop; cancels and amends |
| Recovery | replay from the committed offset | deterministic replay from a snapshot plus the log |
| Market data | Redis Pub/Sub, a gRPC stream, one hash | multicast with gap fill, sequence numbers, full depth |

# A limit order book is two queues, sorted twice

A **limit order** says *buy (or sell) up to \`qty\` at \`price\` or better*. The
[order book](https://en.wikipedia.org/wiki/Order_book) for one symbol holds every order that has not
yet traded, on two sides:

- **Bids** (buys), highest price first; **asks** (sells), lowest price first.
- Within one price, **oldest first**. Together: **price-time priority**.
- An incoming order **crosses** when its price reaches the other side's best:

\`\`\`text
BUY  crosses when order.price >= best ask
SELL crosses when order.price <= best bid
\`\`\`

- A fill happens **at the resting order's price** — the taker gets the improvement. Whatever is left of
  the incoming order **rests** on its own side.
- The **top of book** is three numbers: \`bid\`, \`ask\`, \`last\` (last traded price), \`0\` for an empty side
  or no trade yet.

Resting asks for \`ACME\`: \`100 @ 10.05\` (order A), \`50 @ 10.06\` (order B, placed before C),
\`30 @ 10.06\` (order C). Best bid \`40 @ 10.03\`. A \`BUY 150 @ 10.06\` arrives:

| Step | Against | Fill | Remaining | Why |
| --- | --- | --- | --- | --- |
| 1 | A, \`10.05\` | \`100 @ 10.05\` | 50 | best price first; filled at A's price, not 10.06 |
| 2 | B, \`10.06\` | \`50 @ 10.06\` | 0 | same price as C, but older |
| — | C | untouched | — | nothing left to cross |

Two fills, \`last = 10.06\`, C still rests, and the top of book is \`bid 10.03 · ask 10.06 · last 10.06\`. Each
fill names both sides — \`{symbol, price, qty, buy_order_id, sell_order_id, taker_side}\` — and is what the
engine publishes as a trade.

:::widget order-book {}

The table only comes out that way because the orders arrived in that order: deliver C before B and C
fills instead. **The book is a deterministic function of its input sequence** — so the sequence is the
contract every other part of the system has to keep.

:::quiz
Q: Two sell orders rest at 10.06 — B placed at 09:00:00.100, C at 09:00:00.300. A buy for 50 at 10.06 arrives. Who trades?
- [x] B, in full: same price, earlier time
- [ ] B and C, 25 each: same price, so the quantity is shared
- [ ] Whichever the engine reaches first; the book does not record time
> Price-time priority is the exchange's fairness rule: at one price, the queue is by arrival. It is also why everything upstream has to preserve arrival order — if orders could reach the book shuffled, "earlier" would mean nothing.
:::

# Accepting an order: the 202 is a promise

\`POST /orders\` is the only door into the exchange. The handler is a **funnel**: cheap rejections first,
the one expensive call last.

:::sequence
{
  "participants": ["Client", "gateway", "publish_order"],
  "messages": [
    {"from": "Client", "to": "gateway", "label": "POST /orders · X-Api-Key: k-1f9c · Idempotency-Key: 7c2e… · {symbol, side, price, qty, client_order_id}", "kind": "sync"},
    {"from": "gateway", "to": "gateway", "label": "key in API_KEYS? header present? side in SIDES, price > 0, qty > 0?", "kind": "sync"},
    {"from": "gateway", "to": "publish_order", "label": "publish_order(order) — fresh order_id, blocks for the broker", "kind": "sync"},
    {"from": "publish_order", "to": "gateway", "label": "acknowledged", "kind": "reply"},
    {"from": "gateway", "to": "Client", "label": "202 {order_id, status: \\"accepted\\"}", "kind": "reply"},
    {"from": "Client", "to": "gateway", "label": "POST /orders (no X-Api-Key)", "kind": "sync"},
    {"from": "gateway", "to": "Client", "label": "401 Unauthorized — body never read", "kind": "reply"}
  ]
}
:::

| Check, in order | Fails with | Cost |
| --- | --- | --- |
| \`X-Api-Key\` is one of \`API_KEYS\` | **401** | a header lookup, before the body is parsed |
| \`Idempotency-Key\` present | **400** | a header lookup |
| \`side\` in \`SIDES\`, \`price > 0\`, \`qty > 0\`, \`symbol\` and \`client_order_id\` present | **400**, one message | parse the body |
| \`publish_order\` acknowledged | **503** on \`PublishFailed\` | a round trip to the broker |
| — | **202** \`{order_id, status: "accepted"}\` | — |

- **202, not 200 or 201.** Nothing has been created: the order is durably *accepted*; the outcome — a
  fill, a rest on the book — arrives later on another channel. The status is only honest because the
  gateway waits for the broker before sending it.
- **The order id is the gateway's.** A fresh \`order_id\` is minted before the publish; the 202 body needs
  nothing from the broker.
- **Idempotency-Key.** A client that times out cannot know whether its order got in; it re-sends with
  the *same* key, and the same order is never placed twice. The course requires the header; real
  gateways store it and replay the original response for a duplicate — the
  [Idempotency-Key header draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).
- **503 means "retry with the same key".** \`PublishFailed\` is the broker not acknowledging; a 500 would
  say nothing about what to do next.
- **HTTPS is not optional.** The gateway terminates TLS itself; the API key travels in the clear inside
  the tunnel.

:::quiz
Q: A client sends an order and its connection drops before any response arrives. What should it do?
- [ ] Nothing: the order was probably accepted
- [x] Re-send the same body with the same Idempotency-Key
- [ ] Re-send with a new Idempotency-Key so the request is not rejected as a duplicate
> The client cannot distinguish "never arrived" from "accepted, reply lost". The same key is what turns the retry into a safe question — "did this order get in?" — instead of a possible second order on the book.
:::

# The partition key is the ordering contract

\`publish_order\` uses the same producer API as an analytics event with the opposite trade-off: latency
is spent to buy durability, because the 202 is about to leave as a promise.

:::sequence
{
  "participants": ["gateway", "Producer", "Kafka"],
  "messages": [
    {"from": "gateway", "to": "Producer", "label": "produce(orders, key=ACME, value=json(order))", "kind": "sync"},
    {"from": "Producer", "to": "Kafka", "label": "partition hash(ACME) % 8 · acks=all · idempotent", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack — every in-sync replica has it", "kind": "reply"},
    {"from": "Producer", "to": "gateway", "label": "delivered (offset 5120) — within ACK_TIMEOUT_S", "kind": "reply"},
    {"from": "gateway", "to": "gateway", "label": "only now: 202 to the client", "kind": "sync"}
  ]
}
:::

- **Key = symbol, never the order id.** Kafka keeps order *within one partition*; hashing the symbol puts
  every \`ACME\` order on one partition, in arrival order, and one engine instance owns that partition.
  Keying by order id spreads one symbol over every partition and loses the sequence the book depends on.
- **acks=all.** With \`acks=1\` a leader crash right after the ack loses the order silently; with \`all\`
  the failure is *reported*, and the 202 means what it says.
- **Idempotent producer.** \`enable.idempotence\` has the broker deduplicate the producer's own retries,
  so a retry never turns one order into two. (kafka-go has none; there the \`order_id\` travels in a
  record header so the engine can deduplicate.)
- **Wait, bounded.** Block on the delivery result for up to \`ACK_TIMEOUT_S\` (2 s). Never
  fire-and-forget, never unbounded.

| Outcome of the wait | \`publish_order\` | Gateway |
| --- | --- | --- |
| delivery report: acknowledged | returns | 202 |
| delivery report: error | raises \`PublishFailed\` with the broker's reason | 503 |
| no report within the timeout | raises \`PublishFailed\` | 503 |

The last two are indistinguishable to the caller and should be: either way the order is not known to be durable.

:::widget kafka-partitions {"partitions": 8}

:::quiz
Q: An engineer proposes keying \`orders\` by \`order_id\` "so load spreads evenly across all eight partitions". What breaks?
- [x] Two orders for the same symbol can be consumed by different engines in a different order; the book's time priority is gone
- [ ] Nothing: the consumer group reorders records by timestamp
- [ ] Idempotence, because the broker deduplicates by key
> Kafka orders records per partition and nowhere else. The symbol key is what makes "partition order" equal "arrival order for this symbol", and what gives each book exactly one writer. Spreading a symbol across partitions spreads its sequence across consumers.
:::

# The engine: match, emit, then commit

The consumer group turns the partition key into **ownership**: whoever holds the \`ACME\` partition holds
the \`ACME\` book, so the hottest structure in the system runs single-threaded, in memory, with no lock.

:::sequence
{
  "participants": ["Kafka", "engine", "Book"],
  "messages": [
    {"from": "Kafka", "to": "engine", "label": "poll → order (partition 3, offset 5120)", "kind": "reply"},
    {"from": "engine", "to": "Book", "label": "books[ACME].match(order)", "kind": "sync"},
    {"from": "Book", "to": "engine", "label": "[fill 100 @ 10.05, fill 50 @ 10.06]", "kind": "reply"},
    {"from": "engine", "to": "Kafka", "label": "produce trades ×2, key=ACME · flush", "kind": "sync"},
    {"from": "Kafka", "to": "engine", "label": "acks", "kind": "reply"},
    {"from": "engine", "to": "Kafka", "label": "commit offset 5121 (partition 3)", "kind": "sync"}
  ]
}
:::

- **Group** \`engine\`, subscribed to \`orders\`; \`books[symbol]\` is created on first sight, no lock needed.
- **Auto-commit off.** The offset moves only when the loop says so — not on a timer.
- **The loop body has a fixed order:** parse → \`match\` → produce **one record per fill** on \`trades\`,
  keyed by the symbol → wait for the producer → commit.
- **A malformed record is skipped**: log it and commit, so one poison message does not stall the
  partition — and every symbol behind it.

:::widget consumer-groups {"partitions": 8}

Why the trades go out *before* the commit, and why the producer is flushed first:

| Crash… | Offset | Trades on the broker | On restart |
| --- | --- | --- | --- |
| before \`match\` | not moved | none | the order is replayed; nothing was lost |
| after \`produce\`, before \`flush\` returns | not moved | maybe some | replayed; a fill may be published twice |
| after \`flush\`, before \`commit\` | not moved | all | replayed; the fills are published twice |
| after \`commit\` | moved | all | nothing to do |

Commit first and the middle rows become *order lost, trades never published* — an order the client holds
a 202 for, silently gone. Commit after and the worst case is a duplicate:
[at-least-once](https://kafka.apache.org/documentation/#semantics), chosen on purpose.

:::widget delivery-semantics {}

:::details The gap a replay opens — and how real engines close it
For a stateless counter an at-least-once replay is a harmless duplicate. For an **in-memory book** it is a
**second match**: the replayed order crosses again against a book that already absorbed it. Real engines
close the gap by making the book a pure function of the sequenced input: on restart they rebuild from a
snapshot plus the log (the commit is just a bookmark) and deduplicate by sequence number, so a replayed
order is *recognised*, not re-matched. Add a warm standby consuming the same partition a few messages
behind, and that is the failover story of every exchange.
:::

:::quiz
Q: The engine produces the two trade records, then commits the offset without waiting for the producer. It crashes a moment later. What can happen?
- [ ] Nothing: produce is synchronous in every client
- [x] The offset is past the order, but its trades were still in the producer buffer — they are never published
- [ ] The order is replayed and matched twice
> A produce call hands the record to a buffer; the ack comes later. Committing before that ack is the same mistake as the gateway sending the 202 before the broker answered — a promise about durability that nothing backs. Flush, then commit.
:::

# Top of book: one write, one announcement, one transaction

After every order that changed the book, the engine publishes the three numbers twice — as **state** a
late reader can fetch, and as an **event** a subscriber hears now — and the two must agree.

:::sequence
{
  "participants": ["engine", "Redis", "Subscribers"],
  "messages": [
    {"from": "engine", "to": "Redis", "label": "MULTI", "kind": "sync"},
    {"from": "engine", "to": "Redis", "label": "HSET book:ACME bid 10.03 ask 10.06 last 10.06", "kind": "sync"},
    {"from": "engine", "to": "Redis", "label": "PUBLISH ticks:ACME {\\"symbol\\":\\"ACME\\",\\"bid\\":10.03,\\"ask\\":10.06,\\"last\\":10.06}", "kind": "sync"},
    {"from": "engine", "to": "Redis", "label": "EXEC", "kind": "sync"},
    {"from": "Redis", "to": "engine", "label": "[3, 12] — fields set, subscribers reached", "kind": "reply"},
    {"from": "Redis", "to": "Subscribers", "label": "message ticks:ACME", "kind": "async"}
  ]
}
:::

\`\`\`text
MULTI
HSET    book:ACME  bid 10.03 ask 10.06 last 10.06
PUBLISH ticks:ACME {"symbol":"ACME","bid":10.03,"ask":10.06,"last":10.06}
EXEC
\`\`\`

- **The hash** \`book:{symbol}\` with exactly \`bid\`, \`ask\`, \`last\` — the fields the stream's snapshot and
  \`GET /book\` read.
- **The tick** on \`ticks:{symbol}\` repeats the three fields and names the symbol, so a subscriber never
  has to read the hash.
- **One** [\`MULTI\`/\`EXEC\`](https://redis.io/docs/latest/develop/interact/transactions/): both commands are
  queued on the transaction, not the plain client, and run as one unit.
- **No TTL.** This is current state, not a cache entry. An expired top of book reads as "no such symbol"
  — "stale" turned into "absent", which is a worse lie.
- **No WATCH, no Lua.** The engine owning \`ACME\`'s partition is the *only* writer of \`book:ACME\`; the
  transaction protects readers from a torn update, not writers from each other.

| Without the transaction, a reader could see… | Who is misled |
| --- | --- |
| a tick whose values the hash does not yet hold | a client that trusts the tick, then polls \`GET /book\` and gets older prices |
| a hash updated with no tick announcing it | every subscriber keeps an old price until the next trade |

Pub/Sub is fire-and-forget: Redis drops messages for a subscriber that cannot keep up, and a tick here
carries no sequence number. Real feeds number every tick so subscribers detect gaps, keep the full depth
(\`ZADD\` per price level, or a proper feed handler), and multicast at the network layer.

:::quiz
Q: Why does the hash \`book:ACME\` get no TTL, when nearly every other Redis key in a service has one?
- [ ] Because HSET cannot take an expiry
- [x] Because the hash is the current state, not a copy of it: expiring it would make a live symbol look like one that never traded
- [ ] Because the transaction would have to include EXPIRE too
> A TTL is for data that can be refetched from somewhere truer. Nothing else holds the top of book; if it expired, the stream would answer NOT_FOUND and the endpoint 404 for a symbol trading right now.
:::

# Snapshot, then stream

A stream alone cannot tell a new client the current price — it would wait for the next trade. A
snapshot alone is stale a millisecond later. Every subscription API combines the two, and \`SubscribeTicks\`
is the minimal form:

\`\`\`proto
service TickService {
  rpc SubscribeTicks(SubscribeRequest) returns (stream Tick);
}
message SubscribeRequest { string symbol = 1; }
message Tick { string symbol = 1; double bid = 2; double ask = 3; double last = 4; }
\`\`\`

:::sequence
{
  "participants": ["Client", "ticks", "Redis"],
  "messages": [
    {"from": "Client", "to": "ticks", "label": "SubscribeTicks{symbol: ACME}", "kind": "sync"},
    {"from": "ticks", "to": "Redis", "label": "HGETALL book:ACME", "kind": "sync"},
    {"from": "Redis", "to": "ticks", "label": "{bid, ask, last} — empty: end with NOT_FOUND", "kind": "reply"},
    {"from": "ticks", "to": "Client", "label": "Tick (snapshot)", "kind": "reply"},
    {"from": "ticks", "to": "Redis", "label": "SUBSCRIBE ticks:ACME", "kind": "sync"},
    {"from": "Redis", "to": "ticks", "label": "message {\\"symbol\\":\\"ACME\\",…}", "kind": "async"},
    {"from": "ticks", "to": "Client", "label": "Tick", "kind": "reply"},
    {"from": "ticks", "to": "ticks", "label": "every ≤ 1 s: context cancelled? — client gone → UNSUBSCRIBE, end", "kind": "sync"}
  ]
}
:::

Three phases, in this order:

1. **Snapshot.** \`HGETALL book:{symbol}\`, sent as the first \`Tick\`. An empty hash means no such book:
   end the call with status \`NOT_FOUND\`, not with an empty stream a client would wait on forever.
2. **Subscribe** to \`ticks:{symbol}\` and forward every message as a \`Tick\` — the JSON the engine
   publishes maps 1:1 onto the message.
3. **Loop on the call's liveness, not the subscription's.** Wake up at least every second (a receive
   timeout, or a select on the context) and check whether the client cancelled; otherwise a client that
   disconnected on a quiet symbol pins a Redis connection until the next trade. Unsubscribe in a
   \`finally\`/\`defer\`, so it runs on cancellation, on a send error and on normal completion alike.

:::widget grpc-streams {"mode": "server"}

:::details The race between HGETALL and SUBSCRIBE
A tick published after the snapshot is read and before the subscription is open is lost to that client:
its snapshot is already behind and it hears nothing until the next trade. Real feeds close the race with
sequence numbers — subscribe *first*, then take the snapshot, then drop the buffered ticks older than
the snapshot's sequence. Without a number on the tick there is no way to tell "older" from "newer", so
the course sends the snapshot first and accepts the gap. At scale the other change is fan-out: one Redis
subscription per process feeding all of its gRPC streams, instead of one Redis connection per client.
:::

:::quiz
Q: The stream loop blocks on the subscription until a tick arrives. A client subscribed to a symbol that trades once a day disconnects. What happens?
- [ ] gRPC closes the Redis subscription for you when the client goes away
- [x] The handler sits in the blocking receive until the next tick, holding the Redis connection for up to a day
- [ ] The next tick is sent to the dead client and the server crashes
> Cancellation is a flag on the call; nothing inspects it unless the loop does. A bounded receive timeout turns "noticed at the next trade" into "noticed within a second" and lets the finally block release the subscription.
:::

# A price is never cached

Not every client wants a stream. \`GET /book/{symbol}\` is the poll: the same three-exit shape as the order
endpoint — validate, look up, represent — with one header that carries the whole design decision.

| Exit, in order | Status | Note |
| --- | --- | --- |
| symbol does not match \`^[A-Z]{1,6}$\` | **400** | before any Redis call |
| \`HGETALL book:{symbol}\` is empty | **404** | the symbol has never traded here; not an empty 200 |
| otherwise | **200** \`{symbol, bid, ask, last}\` with \`Cache-Control: no-store\` | the hash already has the shape of the response |

- **Validate the path segment first.** It is user input like any other; the pattern is what keeps
  \`GET /book/../../admin\`-style input from ever becoming a key name.
- **404 for an unknown symbol**, like \`NOT_FOUND\` on the stream: the two doors agree on what "absent" means.
- **No caching.** [\`Cache-Control: no-store\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control) on the 200
  only. A price that a browser, proxy or CDN replays a second later is wrong by definition; the truth of
  this resource has a lifetime of one trade. Error responses carry no price and need no policy.

Compare a thumbnail service's \`max-age=86400\`: the same header with the opposite value, because the two
resources have opposite lifetimes. Choosing the cache policy is part of designing the endpoint. Real
market-data APIs derive an \`ETag\` from the tick sequence number, so a poll that finds nothing changed is
cheap *and* never stale.

:::quiz
Q: A proxy between the traders and the gateway caches 200 responses for one second by default. What does the endpoint have to do?
- [x] Send \`Cache-Control: no-store\` on every 200, so no cache along the path may keep a copy
- [ ] Nothing: one second of staleness is acceptable for a price
- [ ] Add a random query parameter to the URL in the client
> One second is several trades on a busy symbol; a client acting on a cached price is acting on a price that no longer exists. The header is the only mechanism every cache on the path is obliged to honour.
:::

# What to take away

- **The book is a function of its input sequence.** Price-time priority only means something if arrival
  order survives the trip to the engine; every design choice upstream serves that.
- **The partition key is the ordering contract.** Key by the thing that must stay in order — the symbol —
  and one partition becomes one book with one writer and no lock.
- **A 202 is a promise, so earn it first.** \`acks=all\`, an idempotent producer, a bounded wait; \`503\`
  with the same \`Idempotency-Key\` when the promise cannot be made.
- **Emit before you commit.** Trades on the broker, producer flushed, then the offset moves:
  at-least-once by construction, and the replay gap it leaves is what real engines close with
  sequenced, deterministic replay.
- **State and event in one transaction; snapshot before stream; never cache a price.** The hash and
  the tick agree, a new subscriber learns the current price immediately, and no cache on the path can
  replay a price that is no longer true.

The primary source is Martin Fowler's [*The LMAX Architecture*](https://martinfowler.com/articles/lmax.html)
(2011): how a real exchange keeps the matching logic single-threaded and in memory, sequences every
input through a replicated journal, and recovers by deterministic replay — the production version of the
partition key, the commit position and the replay gap this course leaves open.
`;
