/**
 * The learning guide for Flash-Sale Inventory: the concepts the five steps rest on, in the order a
 * reader meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/flash-sale/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

Five hundred pairs of a sneaker, two hundred thousand people pressing *Buy* in the same ten seconds.
Every storefront that survives a drop — Shopify's oversell protection, the "seckill" systems behind
Singles' Day — shares one skeleton: an atomic counter in front, a durable queue in the middle, a slow
physical warehouse at the back, and a clock that takes back what nobody paid for. The course builds
it for one product and one warehouse:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Shopper", "sub": "POST /checkout · 202 / 409 / 429", "x": 9, "y": 50},
    {"id": "checkout", "kind": "http", "label": "checkout", "sub": "step 2 · say no fast, promise once", "x": 30, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "step 1 · stock:{sku} · hold:{id} · holds", "x": 52, "y": 16},
    {"id": "kafka", "kind": "kafka", "label": "orders", "sub": "step 3 · key = sku · acks=all", "x": 52, "y": 84},
    {"id": "fulfilment", "kind": "service", "label": "fulfilment", "sub": "step 4 · group fulfilment, commit after", "x": 74, "y": 84},
    {"id": "warehouse", "kind": "grpc", "label": "Warehouse", "sub": "Allocate(order, sku, qty) · 5 s", "x": 91, "y": 84},
    {"id": "sweeper", "kind": "service", "label": "hold sweeper", "sub": "step 5 · every 1 s · LIMIT 100", "x": 76, "y": 16}
  ],
  "edges": [
    {"from": "client", "to": "checkout", "kind": "http", "label": "HTTPS :8443"},
    {"from": "checkout", "to": "redis", "kind": "redis", "label": "INCR attempts · EVALSHA reserve"},
    {"from": "checkout", "to": "kafka", "kind": "kafka", "label": "produce · wait for ack"},
    {"from": "kafka", "to": "fulfilment", "kind": "kafka", "label": "consume"},
    {"from": "fulfilment", "to": "warehouse", "kind": "grpc", "label": "Allocate · 5 s"},
    {"from": "fulfilment", "to": "redis", "kind": "redis", "label": "confirm / release"},
    {"from": "sweeper", "to": "redis", "kind": "redis", "label": "ZRANGEBYSCORE · EVALSHA release"}
  ]
}
:::

- **Reserve** (step 1): one Lua script checks stock, decrements it and writes a hold with an expiry.
- **Answer** (step 2): \`POST /checkout\` rejects in order of cost — 400, 429, 409 — and answers **202**
  only once the order is durably queued.
- **Queue** (step 3): a Kafka producer keyed by SKU, \`acks=all\`, blocking on the ack for at most 2 s.
- **Fulfil** (step 4): a consumer group calls the warehouse's \`Allocate\` over gRPC with a deadline and
  backoff, and commits only after it knows the outcome.
- **Sweep** (step 5): a process gives expired holds back to stock, atomically and at most once.

Payment is left out on purpose: an order here is *reserved*, never *paid*.

# Why a counter oversells

The naive reservation is a read followed by a write. Under a burst it fails in the only way that
matters: two shoppers both see the last pair and both get it.

:::sequence
{
  "participants": ["request A", "request B", "Redis"],
  "messages": [
    {"from": "request A", "to": "Redis", "label": "GET stock:shoe-42", "kind": "sync"},
    {"from": "Redis", "to": "request A", "label": "1", "kind": "reply"},
    {"from": "request B", "to": "Redis", "label": "GET stock:shoe-42", "kind": "sync"},
    {"from": "Redis", "to": "request B", "label": "1", "kind": "reply"},
    {"from": "request A", "to": "Redis", "label": "DECRBY stock:shoe-42 1 → 0", "kind": "sync"},
    {"from": "request B", "to": "Redis", "label": "DECRBY stock:shoe-42 1 → −1 — oversold", "kind": "sync"}
  ]
}
:::

Redis runs one command at a time, but a *sequence* of commands from one client interleaves with
everyone else's. The fix is to move the whole decision into the server: a
[Lua script](https://redis.io/docs/latest/develop/programmability/eval-intro/) runs atomically — no
other command executes between its first line and its last.

\`\`\`lua
-- KEYS: stock:{sku}  hold:{order_id}  holds     ARGV: qty  member  key TTL  expiry timestamp
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 1                                      -- retried order: already reserved, touch nothing
end
local stock = tonumber(redis.call('GET', KEYS[1]) or '0')
if stock < tonumber(ARGV[1]) then
  return 0                                      -- sold out
end
redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
return 1
\`\`\`

- **Check and decrement are one unit.** A second request sees stock *after* the first took its
  units; the counter can never go below zero.
- **Idempotent by key.** \`EXISTS hold:{order_id}\` runs before any arithmetic: a retried checkout with
  the same order id returns 1 and reserves nothing twice. The order id is generated *before* the
  call, so the retry carries the same one.
- **The client only builds keys and arguments.** A \`GET\` or \`DECRBY\` issued from the client is the
  race the script exists to remove.
- **Registered once, called by SHA.** \`register_script\` / \`NewScript\` / \`scriptLoad\` loads it one
  time; every reservation is then an \`EVALSHA\`, not a 300-byte upload per request.

:::details Why not WATCH / MULTI / EXEC?
Redis's optimistic transaction — \`WATCH stock\`, read, \`MULTI\`, \`DECRBY\`, \`EXEC\` — is also correct:
if anyone touched the key, \`EXEC\` fails and the client retries. Under a drop that is the problem:
ten thousand clients watching one key means almost every \`EXEC\` fails and the retry loop becomes the
hot path. A script decides on the server in one round trip and never retries. Real systems go
further and shard a hot SKU across several counters, with the script run per shard.
:::

:::quiz
Q: Two requests for the last pair arrive in the same millisecond, both running the reserve script. What happens?
- [x] One returns 1 and takes the pair; the other reads stock 0 and returns 0
- [ ] Both return 1 and the sweeper fixes the count a minute later
- [ ] Redis runs them in parallel and the result depends on timing
> A script runs to completion before any other command starts. The second script's GET already sees the first script's DECRBY, so it fails its own check. Nothing downstream has to repair anything.
:::

# A hold is a reservation with a clock

Decrementing the counter is half the reservation. The other half records *who* has the units and
*until when*, so a shopper who walks away cannot keep the last pair off sale for ever:

| Key | Type | Holds | Why |
| --- | --- | --- | --- |
| \`stock:{sku}\` | string (integer) | units still available | the counter every reservation decrements |
| \`hold:{order_id}\` | string, \`EX 1200\` | the member \`{order_id}:{sku}:{qty}\` | the retry guard; what \`release(order_id)\` reads |
| \`holds\` | sorted set | member → score \`now + 600\` | the expiry queue the sweeper drains by time |

- The **member** packs everything a release needs — order, SKU, quantity — so a sweeper that finds it
  by time never has to look anything up.
- The **score** is the expiry timestamp, \`now + 600\`: ten minutes is the course's \`HOLD_TTL_S\`.
- The **key TTL is twice the hold**, 1,200 s, and it is only garbage collection: a sweeper that is a
  few minutes late still finds the hold key.

Why not let the TTL *be* the expiry? Because expiry here has a side effect — stock goes back up — and
Redis runs no code when a key dies. A TTL is the right tool when forgetting is the whole job (a cached
thumbnail); a hold needs an explicit queue, ordered by time, that something drains.

A hold ends one of three ways, each a different caller of the same Redis commands:

| Outcome | Who | What happens to the three keys |
| --- | --- | --- |
| Allocated by the warehouse | fulfilment: \`confirm(order_id)\` | \`DEL hold\`, \`ZREM holds\` — stock stays down: the reservation is a sale |
| Released explicitly | checkout's 503 path, fulfilment's no-stock path: \`release(order_id)\` | \`INCRBY stock\`, \`DEL hold\`, \`ZREM holds\` |
| Expired | the sweeper | the same release, found by score rather than by order id |

:::quiz
Q: The sweeper is down for fifteen minutes. A hold placed at noon expired at 12:10. What state is it in at 12:15?
- [x] Still in \`holds\` with its key present; the sweeper will release it when it comes back
- [ ] Gone: Redis expired the key and gave the stock back
- [ ] Gone from \`holds\` but the key remains
> The key TTL is 1,200 s, twice the hold, precisely so a late sweeper still finds the hold and can restore the units. Redis never restores stock by itself — only the release script does.
:::

# The checkout says no, cheaply

During a drop most requests are refusals, so the endpoint's job is to refuse as cheaply as possible
and to promise only what it can keep. Every branch of \`POST /checkout\` is ordered by what it costs:

:::sequence
{
  "participants": ["Client", "checkout", "Redis"],
  "messages": [
    {"from": "Client", "to": "checkout", "label": "POST /checkout {sku: shoe-42, qty: 2, user: u9}", "kind": "sync"},
    {"from": "checkout", "to": "checkout", "label": "validate — sku, user, 1 ≤ qty ≤ 5; 400 otherwise, nothing touched", "kind": "sync"},
    {"from": "checkout", "to": "Redis", "label": "INCR attempts:u9 → 1 · EXPIRE 60", "kind": "sync"},
    {"from": "checkout", "to": "Redis", "label": "EVALSHA reserve → 1 (0 → 409 SOLD_OUT)", "kind": "sync"},
    {"from": "checkout", "to": "checkout", "label": "enqueue_order({order_id, sku, qty, user}) — blocks for the Kafka ack", "kind": "sync"},
    {"from": "checkout", "to": "Client", "label": "202 {order_id, status: \\"reserved\\"}", "kind": "reply"},
    {"from": "Client", "to": "checkout", "label": "POST /checkout (21st attempt in the minute)", "kind": "sync"},
    {"from": "checkout", "to": "Client", "label": "429 · Retry-After: 60 — no Lua call made", "kind": "reply"}
  ]
}
:::

| Answer | Costs | Means to the client |
| --- | --- | --- |
| **400** | nothing | fix the request: missing \`sku\`/\`user\`, or \`qty\` outside 1–5 |
| **429** \`Retry-After: 60\` | one \`INCR\` | *wait* — more than 20 attempts in the 60 s window |
| **409** \`{"error": "SOLD_OUT"}\` | the Lua script | *stop* — the drop has no units for you |
| **503** | script + a failed Kafka ack, then a release | *try again* — the order could not be made durable |
| **202** \`{"order_id", "status": "reserved"}\` | script + a Kafka round trip | accepted for processing; not paid, not fulfilled |

- **The attempt counter comes before stock.** \`INCR attempts:{user}\`; a result of 1 means the key is
  new and gets \`EXPIRE 60\`. A bot costs one integer increment per request, never a script run, and
  the counter lives in Redis so every API replica shares it.
- **409, not 400 or 404.** Sold out is a conflict with the current state of stock, not a malformed
  request and not a missing resource.
- **202, not 200 or 201.** Nothing is paid and nothing is allocated; the body carries the \`order_id\`.
- **The 503 path undoes the reservation** before answering, so no units sit stranded for ten minutes.

\`INCR\` + \`EXPIRE\` is a fixed window: 20 per minute, refilled all at once at the window edge. The
smoother shape gateways use is a token bucket — one token a second, burst of 20:

:::widget token-bucket {"rate": 1, "burst": 20}

:::quiz
Q: Why is the attempt limit checked before the reservation script rather than after it?
- [x] A rejected bot must cost one INCR, not a script run against the hot stock key
- [ ] Because the script cannot be called more than 20 times a second
- [ ] So the 429 can carry the order id
> Branches are ordered by cost. The stock key is the one contended resource in the system; every request that reaches it should be one that could plausibly buy. Limit first, then reserve.
:::

# The 202 is a promise

A 202 says the order *will* be fulfilled or explicitly failed — true only if the order exists somewhere
that survives the API process dying a millisecond later. The course backs it with a record on the
\`orders\` topic, and the request does not answer until the broker has it:

:::sequence
{
  "participants": ["checkout", "Producer", "Kafka"],
  "messages": [
    {"from": "checkout", "to": "Producer", "label": "produce(orders, key = shoe-42, value = order JSON)", "kind": "sync"},
    {"from": "Producer", "to": "Kafka", "label": "partition hash(shoe-42) % 8 · acks=all", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack — leader and every in-sync replica have it", "kind": "reply"},
    {"from": "Producer", "to": "checkout", "label": "delivered · offset 88231 (within 2 s)", "kind": "reply"},
    {"from": "checkout", "to": "checkout", "label": "202 reserved", "kind": "sync"},
    {"from": "checkout", "to": "Producer", "label": "produce(orders, key = shoe-42, o2) — broker slow", "kind": "sync"},
    {"from": "Producer", "to": "checkout", "label": "OrderNotAcknowledged after 2 s → release(o2), 503", "kind": "reply"}
  ]
}
:::

Three producer settings decide what "sent" means:

| Setting | Course value | What it buys |
| --- | --- | --- |
| \`acks\` | \`all\` | the record is on the leader *and* every in-sync replica before the ack; a broker crash does not lose it |
| \`enable.idempotence\` | on | a producer-side retry cannot write the same record twice: exactly one copy per send |
| \`delivery.timeout.ms\` | 2000 — the same as the wait | a record cannot be delivered *after* the API gave up, released the hold and answered 503 |

- **Blocking, not fire-and-forget.** The call waits — \`flush(timeout)\`, \`.get(timeout)\`, a context with
  a deadline — for at most **2 s**. An analytics event may be produced and forgotten; an order is what
  the customer came for.
- **Three outcomes, one honest one.** Acknowledged returns normally. Failed or timed out becomes
  \`OrderNotAcknowledged\`, naming the order; the API releases the hold and answers 503.
- **Keyed by SKU, not by order id.** Every order for one product lands on one partition, in arrival
  order. Keying by order id would spread a product across all eight partitions and let several
  consumers race the warehouse for the same units.

:::widget kafka-partitions {"partitions": 8}

The price is a few milliseconds per successful checkout, paid after the expensive part (the
reservation) is already done. Eight partitions keep the broker side parallel; each SKU stays serial.

:::details The gap the outbox closes
There is still a crash window: the process dies after the script reserved and before the producer
sent. Nothing is lost — the hold expires and the sweeper gives the units back — but the customer
waits for an order that was never queued. Real intakes close the window with the
[transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html): the order
row and its event are written in one database transaction and a relay publishes the event.
:::

:::widget outbox {}

:::quiz
Q: The broker is slow and the ack arrives after 2.5 s. What must be true?
- [x] The producer's delivery timeout already expired, so the record is never written; the API released the hold and answered 503
- [ ] The record is written late and the consumer fulfils an order whose hold was released
- [ ] The API waits for the late ack and answers 202
> The wait and the delivery timeout are the same 2 s on purpose. If the API could give up while the producer kept trying, an order could land on the topic after its hold went back to stock — a sale the counter no longer knows about.
:::

# Fulfilment: allocate, then commit

The Redis counter said "probably yours". The warehouse is where it becomes "yours": a physical
allocation, over gRPC, by a consumer that reads the \`orders\` topic in group \`fulfilment\`.

:::sequence
{
  "participants": ["Kafka", "fulfilment", "Warehouse", "Redis"],
  "messages": [
    {"from": "Kafka", "to": "fulfilment", "label": "poll → order o1 (partition 3, offset 88231)", "kind": "reply"},
    {"from": "fulfilment", "to": "Warehouse", "label": "Allocate(o1, shoe-42, 2) · deadline 5 s", "kind": "sync"},
    {"from": "Warehouse", "to": "fulfilment", "label": "UNAVAILABLE → sleep 250 ms, retry", "kind": "reply"},
    {"from": "fulfilment", "to": "Warehouse", "label": "Allocate(o1, shoe-42, 2) · attempt 2", "kind": "sync"},
    {"from": "Warehouse", "to": "fulfilment", "label": "AllocateReply{shipment_id}", "kind": "reply"},
    {"from": "fulfilment", "to": "Redis", "label": "confirm(o1): DEL hold:o1 · ZREM holds", "kind": "sync"},
    {"from": "fulfilment", "to": "Kafka", "label": "commit offset 88232 (partition 3)", "kind": "sync"}
  ]
}
:::

The RPC is one unary call carrying the order id:

\`\`\`proto
service Warehouse {
  rpc Allocate(AllocateRequest) returns (AllocateReply);
}
message AllocateRequest { string order_id = 1; string sku = 2; uint32 qty = 3; }
message AllocateReply   { string shipment_id = 1; }
\`\`\`

The consumer does what every good gRPC client does, and the [status code](https://grpc.io/docs/guides/status-codes/)
decides everything:

| Warehouse answers | Meaning | The consumer |
| --- | --- | --- |
| \`OK\` + \`shipment_id\` | allocated | \`confirm(order_id)\`, commit |
| \`FAILED_PRECONDITION\` | no physical stock for this SKU | \`release(order_id)\`, \`publish_failed(order)\` to \`orders-failed\`, commit |
| \`UNAVAILABLE\` | try later | sleep 250 ms, 500 ms, 1 s; at most **4 attempts** in total |
| \`DEADLINE_EXCEEDED\`, anything else | unknown | propagate; the record stays **uncommitted** |

- **A 5 s [deadline](https://grpc.io/docs/guides/deadlines/) on every attempt.** Without it a hung
  warehouse stalls the partition for ever.
- **Backoff only for the one status that means "later".** \`UNAVAILABLE\` is the warehouse overloaded or
  restarting; doubling the wait — base × 2^(attempt − 1), first call immediate — gives it room.
  \`FAILED_PRECONDITION\` will not change by asking again; retrying it is just load.
- **A hard cap.** Four attempts, then the error propagates. Unbounded retries are a slow outage
  disguised as patience.
- **No stock is a final outcome.** The hold goes back to the counter, the order is dead-lettered so
  someone can tell the customer, and the offset is committed: the record is done, just not happily.

:::widget deadline-retry {"base": 250, "deadline": 5000, "attempts": 4}

:::quiz
Q: The warehouse answers \`FAILED_PRECONDITION\`. Why commit the offset at all, rather than leave the record for a retry?
- [x] No physical stock is a final answer; the hold is released and the order dead-lettered, so the record is handled
- [ ] Because gRPC forbids retrying that status
- [ ] To free the partition for the next order faster
> A retry only makes sense when the answer might change. Precondition failed means the SKU is physically gone; the right response is to give the units back to the counter, record the failure on \`orders-failed\`, and move on. Leaving it uncommitted would replay a known failure for ever.
:::

# Crash anywhere, replay safely

Auto-commit is off, and the commit is the *last* thing the consumer does with a record. That one
ordering decision is the difference between at-least-once and at-most-once processing:

| Commit happens | Crash between processing and commit | Crash between commit and processing | Semantics |
| --- | --- | --- | --- |
| **after** the outcome (the course) | record replays: \`Allocate\` is asked again | — | [at-least-once](https://kafka.apache.org/documentation/#semantics) |
| **before** the outcome (auto-commit on a timer) | — | record is gone; the order is never fulfilled | at-most-once |

:::widget delivery-semantics {}

At-least-once means every side effect must survive being asked twice:

- **The warehouse** is idempotent on \`order_id\`: a redelivered record after a crash between
  \`Allocate\` and the commit asks for the same allocation and gets the same \`shipment_id\` back. That is
  why the order id is in the request — so the warehouse can dedupe.
- \`confirm\` **is DEL + ZREM**: running it twice is harmless.
- \`release\` **goes through a guarded script** (next section): the second call finds no hold and
  restores nothing.
- **A thrown error leaves the offset where it was.** For a warehouse still down after four attempts,
  an uncommitted offset is exactly right: the record is redelivered when the consumer restarts.

The partition is the unit of order and of recovery: every order for a SKU sits on one partition that
one consumer owns, so a replay re-runs the same orders in the same order.

:::quiz
Q: The consumer crashes after the warehouse allocated o1 but before \`confirm\` and the commit. What happens on restart?
- [x] o1 is redelivered; \`Allocate(o1)\` returns the same shipment; \`confirm\` and the commit complete
- [ ] o1 is lost because the warehouse already has it
- [ ] o1 is allocated twice and the warehouse ships two pairs
> The offset was never committed, so Kafka hands the record back. The warehouse recognises the order id and returns the existing allocation instead of making a second one. At-least-once delivery plus an idempotent callee is effectively-once.
:::

# Sweeping expired holds back

A hold that is never paid for must go back on sale. The sweeper is one process, every second, that
drains the expiry queue in bounded slices:

:::sequence
{
  "participants": ["sweeper", "Redis"],
  "messages": [
    {"from": "sweeper", "to": "Redis", "label": "ZRANGEBYSCORE holds -inf 1727431200 LIMIT 0 100", "kind": "sync"},
    {"from": "Redis", "to": "sweeper", "label": "[o7:shoe-42:2, o9:hat-1:1]", "kind": "reply"},
    {"from": "sweeper", "to": "Redis", "label": "EVALSHA release · stock:shoe-42 hold:o7 holds · 2 · o7:shoe-42:2", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "EXISTS hold:o7 → 1 · INCRBY 2 · DEL · ZREM", "kind": "sync"},
    {"from": "Redis", "to": "sweeper", "label": "1", "kind": "reply"},
    {"from": "sweeper", "to": "Redis", "label": "EVALSHA release · hold:o9 (confirmed meanwhile)", "kind": "sync"},
    {"from": "Redis", "to": "sweeper", "label": "0 — hold gone: ZREM only, stock untouched", "kind": "reply"}
  ]
}
:::

The sorted set is a priority queue keyed by time. \`ZRANGEBYSCORE holds -inf <now>\` returns exactly
what is due, and \`LIMIT 0 100\` caps a tick so one burst of abandoned carts cannot stall the loop:
sweep a batch, sleep a second, repeat. Each member goes through one script:

\`\`\`lua
-- KEYS: stock:{sku}  hold:{order_id}  holds     ARGV: qty  member
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('ZREM', KEYS[3], ARGV[2])          -- confirmed or already released: index only
  return 0
end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
return 1
\`\`\`

- **One guard, two paths, both end in ZREM.** A member never survives a sweep, and stock moves only
  when the hold key was still there.
- **Atomic, so a crash restores once.** Done as three commands, a sweeper that dies between
  \`INCRBY\` and \`ZREM\` finds the member again next tick and gives the units back twice.
- **Three callers, one script.** The sweeper, the API's 503 path and the consumer's no-stock path all
  run it; \`release(order_id)\` just reads the member from \`hold:{order_id}\` first. Whoever gets there
  first wins; the race between an explicit release and a sweep is settled inside Redis.
- **Never for a fulfilled order.** \`confirm\` deleted the hold key, so the script only tidies the index.

Hold expiry is the course's answer to every failure it cannot see — an API that died after reserving,
a queue that never heard about an order, a customer who closed the tab. The clock runs out and the
counter is whole again.

:::quiz
Q: \`release(o2)\` from the consumer and the sweeper's tick run in the same millisecond on the same expired hold. What is the stock afterwards?
- [x] Up by o2's quantity exactly once: the second script sees no hold and only ZREMs
- [ ] Up twice, and reconciliation fixes it after the drop
- [ ] Unchanged, because the two calls cancel out
> Both go through the same script, and scripts do not interleave. The first to run restores the stock and deletes the hold; the second finds \`EXISTS == 0\` and takes the index-only branch.
:::

# What to take away

- **Make the decision where the data is.** A check and a write from the client is a race; a Lua
  script is one atomic unit, and \`EXISTS hold\` at the top makes it a safe retry.
- **A hold is a counter plus a clock.** Record who has the units and until when; put expiry in a queue
  ordered by time, with the key TTL as a safety net, because Redis runs no code when a key dies.
- **Refuse in order of cost, promise only what is durable.** 400 free, 429 one \`INCR\`, 409 one script,
  and 202 only after a replicated, acknowledged, bounded-timeout write — or release and 503.
- **Commit after the outcome, and make every side effect replayable.** Deadline per call, backoff only
  for "later", a hard cap, the order id in the request so the warehouse can dedupe.
- **Let the clock undo what nobody finished.** One \`EXISTS\`-guarded release script, shared by the
  sweeper and every explicit caller, restores units at most once no matter who gets there first.

Redis says "probably yours"; the warehouse says "yours". The primary source for why that gap matters is
Shopify's
[*We replaced Redis with MySQL for inventory reservations — and it scaled*](https://shopify.engineering/scaling-inventory-reservations)
(Emilie Noel, 2026): reserve-then-claim with a short hold, the oversell and undersell a counter in a
separate store can produce, and what it took to put the reservation and the ledger in one transaction.
`;
