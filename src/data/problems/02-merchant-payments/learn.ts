/**
 * The learning guide for the Online Merchant Transaction System: the concepts the six steps rest
 * on, in the order a reader meets them — a figure or a demo where one says it faster than prose, a
 * pop quiz per section. Rendered at `/merchant-payments/learn`; the same Markdown is what the
 * download exports.
 */
export const learn = `# The system at a glance

A merchant's storefront calls a payments platform — Stripe, Adyen, a bank's acquiring stack — to charge
a customer's card. Networks retry, providers time out, processes crash mid-request, and through all of
it the card must be charged **exactly once** and the books must balance. The course rebuilds the money
path: one service, **checkout**, and the two workers behind it.

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Merchant app", "sub": "POST /checkout · Idempotency-Key", "x": 8, "y": 50},
    {"id": "checkout", "kind": "http", "label": "checkout", "sub": "steps 1, 6 · reserve the key, count the minute", "x": 26, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "idem:{key} · rl:{m}:{min} · applied:{id}", "x": 58, "y": 14},
    {"id": "provider", "kind": "grpc", "label": "PaymentProvider", "sub": "step 2 · Authorize, 3 s deadline", "x": 26, "y": 86},
    {"id": "db", "kind": "db", "label": "Postgres", "sub": "step 3 · orders + outbox, one transaction", "x": 44, "y": 50},
    {"id": "relay", "kind": "service", "label": "outbox-relay", "sub": "step 4 · 100 rows, acks=all, then sent_at", "x": 62, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "payments", "sub": "key = merchant id", "x": 78, "y": 50},
    {"id": "ledger", "kind": "service", "label": "ledger", "sub": "step 5 · group ledger, claim then post", "x": 92, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "checkout", "kind": "http", "label": "HTTPS"},
    {"from": "checkout", "to": "redis", "kind": "redis", "label": "SET NX EX · INCR"},
    {"from": "checkout", "to": "provider", "kind": "grpc", "label": "Authorize"},
    {"from": "checkout", "to": "db", "kind": "plain", "label": "orders + outbox (1 tx)"},
    {"from": "relay", "to": "db", "kind": "plain", "label": "SELECT unsent · UPDATE sent"},
    {"from": "relay", "to": "kafka", "kind": "kafka", "label": "produce acks=all"},
    {"from": "kafka", "to": "ledger", "kind": "kafka", "label": "consume"},
    {"from": "ledger", "to": "redis", "kind": "redis", "label": "SET applied NX"}
  ]
}
:::

- **Accept once** (step 1): \`POST /checkout\` carries an \`Idempotency-Key\`; a Redis reservation makes a
  retry a replay, not a second charge.
- **Authorize** (step 2): one gRPC call to the provider with a deadline, retries only where they are
  safe, and an honest \`PENDING\` when no answer came.
- **Record** (step 3): the order and its \`payment.captured\` event commit in one database transaction.
- **Publish** (step 4): a relay moves committed outbox rows to the \`payments\` topic with \`acks=all\`.
- **Book** (step 5): a consumer in group \`ledger\` posts each event once, deduping on the event id.
- **Protect** (step 6): a fixed window of 100 checkouts a minute per merchant, one \`INCR\` per request.

Left out on purpose: card data (the merchant sends a \`card_token\`), fraud scoring, 3-D Secure, currency
conversion, refunds, reconciliation. They add steps; they do not change the six mechanisms.

# Charge once: the idempotency key

The network offers *at least once*: a client that got no reply cannot tell whether the server ran the
request, so it sends it again. Harmless for a search; for a charge, the one bug a payments API may not
have. An **idempotency key** turns at-least-once from the network into exactly-once at the API — the
client names the operation, the server promises one name produces one charge:

:::sequence
{
  "participants": ["Merchant app", "checkout", "Redis"],
  "messages": [
    {"from": "Merchant app", "to": "checkout", "label": "POST /checkout · Idempotency-Key: k1", "kind": "sync"},
    {"from": "checkout", "to": "Redis", "label": "SET idem:k1 processing NX EX 86400 → OK", "kind": "sync"},
    {"from": "checkout", "to": "checkout", "label": "process_checkout(body) — authorize, record", "kind": "sync"},
    {"from": "checkout", "to": "Redis", "label": "SET idem:k1 {response} EX 86400", "kind": "sync"},
    {"from": "checkout", "to": "Merchant app", "label": "201 {order_id, status}", "kind": "reply"},
    {"from": "Merchant app", "to": "checkout", "label": "POST /checkout · Idempotency-Key: k1 (retry)", "kind": "sync"},
    {"from": "checkout", "to": "Redis", "label": "SET idem:k1 … NX → refused; value is {response}", "kind": "sync"},
    {"from": "checkout", "to": "Merchant app", "label": "200 {order_id, status} — replayed, handler never ran", "kind": "reply"}
  ]
}
:::

One command does the whole job: \`SET idem:{key} "processing" NX EX 86400\`. \`NX\` makes it a claim, \`EX\`
bounds how long the promise is kept (a day), and the reply tells the server which of three situations
it is in:

| The SET | Stored value | Meaning | Answer |
| --- | --- | --- | --- |
| succeeds | — | this request owns the key | run \`process_checkout\`, store its JSON over the key with the same TTL, **201** |
| refused | a response document | the work finished earlier | **200** with the stored body, byte-identical; the handler does not run |
| refused | \`processing\` | a request with this key is still running | **409 Conflict** — not a wait, not a second charge |

- No \`Idempotency-Key\` header → **400**. Without a name the server can promise nothing.
- The marker is **overwritten** by the response: a plain \`SET\` with the same expiry over the same key.
- If \`process_checkout\` throws, the key is **deleted** before the error propagates — otherwise every
  retry with that key gets a 409 for a day.

:::widget idempotency {}

> Why one command and not a \`GET\` followed by a \`SET\`: between the two, a second retry sees "nothing
> stored" as well, and both charge the card. The check and the claim have to be the same atomic step.

:::details What Stripe adds on top
Stripe's implementation, described in
[*Designing robust and predictable APIs with idempotency*](https://stripe.com/blog/idempotency), stores a
**fingerprint** of the request body with the key — the same key with a different body is answered
\`422\` — scopes keys per API key so merchants cannot collide, and stores **error** responses too, so a
retry of a declined charge gets the decline back rather than a fresh attempt.
:::

:::quiz
Q: A retry arrives while the first request with the same key is still waiting on the provider. What should it get?
- [ ] 200 with an empty body — the client will retry again
- [x] 409: the key is held by a request in flight, and nothing is charged
- [ ] It should wait on the key until the first request stores its response
> The stored value is the \`processing\` marker: the server knows the work is running but not what it will return. 409 says exactly that; waiting would tie a request thread to a provider call it does not own, and running the handler again is the double charge the key exists to prevent.
:::

# Talking to the provider: deadlines, retries, and the honest PENDING

The card network sits behind a payment provider with one RPC:

\`\`\`proto
service PaymentProvider {
  rpc Authorize(AuthorizeRequest) returns (AuthorizeReply);
}
message AuthorizeRequest { int64 amount_cents = 1; string currency = 2; string card_token = 3; string idempotency_key = 4; }
message AuthorizeReply   { string authorization_id = 1; }
\`\`\`

Three ideas in the client, and each fails without the other two:

:::sequence
{
  "participants": ["checkout", "PaymentProvider"],
  "messages": [
    {"from": "checkout", "to": "PaymentProvider", "label": "Authorize(4999 EUR, tok_…, idempotency_key k1) · deadline 3 s", "kind": "sync"},
    {"from": "PaymentProvider", "to": "checkout", "label": "status UNAVAILABLE", "kind": "reply"},
    {"from": "checkout", "to": "checkout", "label": "sleep 200 ms + jitter (0–200 ms)", "kind": "sync"},
    {"from": "checkout", "to": "PaymentProvider", "label": "Authorize(… key k1) · attempt 2 · deadline 3 s", "kind": "sync"},
    {"from": "PaymentProvider", "to": "checkout", "label": "AuthorizeReply{authorization_id} — same key, same authorization", "kind": "reply"}
  ]
}
:::

- **A deadline on every attempt** — 3 s. A
  [gRPC deadline](https://grpc.io/docs/guides/deadlines/) is a promise about *your* latency, not a
  statement about the provider's state; without it a hung provider hangs checkout.
- **The idempotency key in the request.** The provider dedupes on it — the only thing that makes a
  retry safe for a call that moves money.
- **Retry only** \`UNAVAILABLE\`, at most 3 attempts; the status decides the outcome in one place:

| Status | Means | Result |
| --- | --- | --- |
| \`OK\` | authorized | \`APPROVED\` with the \`authorization_id\` |
| \`UNAVAILABLE\` | the provider could not take the call | sleep, try again; after the third attempt, raise |
| \`DEADLINE_EXCEEDED\` | 3 s passed with no answer | \`PENDING\` — the charge *may* have gone through |
| \`INVALID_ARGUMENT\` | the provider rejected the request | \`DECLINED\` with the provider's message |
| anything else | unknown | propagate as an error |

\`PENDING\` is the line most people get wrong. A timeout says only that you did not hear back. Reporting
it as a failure makes the merchant retry with a **new** key, which the provider cannot recognise, and
the customer pays twice. Pending authorizations are reconciled later through a status query or webhook.

The wait between attempts doubles and is randomised:

\`\`\`text
backoff(n) = 200 ms × 2^(n−1)          # attempt n ≥ 2
sleep      = backoff(n) + random(0 … backoff(n))
\`\`\`

The doubling gives a struggling provider room; the jitter keeps a fleet of checkout servers that all
saw the same outage from retrying in lockstep — the
[thundering herd that fixed intervals create](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).

:::widget deadline-retry {"base": 200, "deadline": 3000, "attempts": 3}

:::quiz
Q: The third attempt to the provider hits the 3 s deadline. What does checkout tell the merchant?
- [ ] DECLINED — three attempts failed
- [x] PENDING — the authorization may exist, and the merchant must not retry with a fresh key
- [ ] APPROVED — the provider dedupes on the key, so one of the attempts must have gone through
> A deadline is silence, not a decline. The provider may have authorized the charge after checkout stopped listening; the only honest status is "unknown", reconciled later. A DECLINED here is how customers get charged twice.
:::

# Why a dual write cannot be fixed, and what replaces it

Once the provider approves, checkout must commit the order to Postgres **and** tell the platform with a
\`payment.captured\` event on the \`payments\` topic. The obvious code writes to both — a **dual write** —
and no order of the two writes is safe:

| Order | Crash in between leaves | Consequence |
| --- | --- | --- |
| commit, then produce | an order the ledger never hears about | money moved, books do not show it |
| produce, then commit | an event for an order that rolled back | books show money that never moved |
| produce inside the transaction | an event for an order that may still roll back | the same |

Two systems, two failure points, and no way to make the second write conditional on the first surviving.
The [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) borrows the
database's atomicity instead: the event is written as a **row**, in the same transaction as the order.

\`\`\`sql
BEGIN;
INSERT INTO orders (id, merchant_id, amount_cents, currency, …) VALUES (…);
INSERT INTO outbox (id, topic, key, payload)
  VALUES ('e7…', 'payments', 'm42', '{"event_id": "e7…", "type": "payment.captured", …}');
COMMIT;   -- both rows or neither
\`\`\`

- **Atomicity becomes a proposition**: the event exists iff the order exists. No crash point breaks it.
- The row carries **everything the relay needs**: the \`topic\` (\`payments\`), the \`key\` (the merchant id),
  the serialised \`payload\`. No lookups at publish time.
- The event gets a **fresh UUID**, both the row \`id\` and the \`event_id\` inside the payload — the one
  the consumer dedupes on, because it is the one that survives into the Kafka record.
- **No producer in the request path.** Publishing is a separate, retryable job; the request returns
  when the transaction commits.

:::widget outbox {}

:::details Polling the table or tailing the log
The relay here polls the \`outbox\` table. The other way to drain one is **change data capture**: a
connector such as Debezium tails Postgres's write-ahead log and turns each committed outbox insert into
a Kafka record — no polling query, lower latency. Both need the same table and the same idempotent
consumer; CDC usually replaces the poller once volume grows. Either way, something must delete sent
rows, or the table grows forever.
:::

:::quiz
Q: Why can the event not simply be produced to Kafka *inside* the database transaction, before COMMIT?
- [ ] Kafka producers cannot be called while a transaction is open
- [x] The transaction can still roll back after the record is published, so the ledger would book an order that does not exist
- [ ] Because the merchant id is not known until the order row has been committed
> A produce is not undone by a ROLLBACK. The only write that shares the order's fate is another row in the same database, which is exactly what the outbox is: the publish happens later, from rows that are known to have committed.
:::

# The relay: durable before marked sent

The relay is a small loop that turns committed outbox rows into Kafka records. It is where **durable**
is decided, and it is honest about one thing above all: a row is marked sent only after the broker
acknowledged the record.

:::sequence
{
  "participants": ["relay", "Postgres", "Kafka"],
  "messages": [
    {"from": "relay", "to": "Postgres", "label": "BEGIN · SELECT … WHERE sent_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED", "kind": "sync"},
    {"from": "Postgres", "to": "relay", "label": "37 rows", "kind": "reply"},
    {"from": "relay", "to": "Kafka", "label": "produce ×37 (payments, key = merchant id)", "kind": "async"},
    {"from": "Kafka", "to": "relay", "label": "acks — every in-sync replica has the record", "kind": "reply"},
    {"from": "relay", "to": "Postgres", "label": "UPDATE outbox SET sent_at = now() WHERE id = ANY(delivered)", "kind": "sync"},
    {"from": "relay", "to": "Postgres", "label": "COMMIT", "kind": "sync"}
  ]
}
:::

Inside one database transaction, two phases:

1. **Produce everything.** Each row goes to its \`topic\` with its \`key\`. Keying by merchant id puts all
   of one merchant's events on one partition, in order.
2. **Wait for the acknowledgements** — flush, join the futures, collect delivery reports — and only then
   one \`UPDATE\` with the ids that were **delivered**. A row whose record failed stays unsent and is
   picked up next pass.

The producer's two settings carry the broker side of the guarantee:

| Setting | Protects against | How |
| --- | --- | --- |
| \`acks=all\` | a leader failover losing an acknowledged record | the leader answers only when every in-sync replica has it |
| idempotent producer | the producer's own retries duplicating a record | a sequence number per partition lets the broker drop the resend |

Everything else is throughput: \`FOR UPDATE SKIP LOCKED\` so several relays run at once without
publishing the same row; batches of **100**; an **idle sleep** when a pass found nothing, so a busy
relay never sleeps and an idle one polls a couple of times a second instead of hammering an empty table.

The relay is **at-least-once by design**. A crash after the acknowledgement and before the \`UPDATE\`
leaves the row unsent, and the next pass sends it again. Marking first would turn a lost record into a
lost payment; re-sending turns it into a duplicate — the consumer's problem, which is why the payload
carries an \`event_id\`.

:::quiz
Q: The relay crashes after Kafka acknowledged a batch but before the UPDATE committed. What happens to those 37 payments?
- [ ] They are lost: the broker has them but nothing points to them
- [x] They are published again on the next pass, and the ledger's dedupe makes the second copy a no-op
- [ ] They are marked sent by the next relay instance from the delivery reports
> The rows still have \`sent_at IS NULL\`, so they are selected again and produced again. That is the at-least-once the relay chose on purpose: a duplicate costs one refused SET downstream; a lost payment costs a customer.
:::

# The ledger: effectively once

The ledger turns every \`payment.captured\` event into double-entry rows — a debit and a credit of the same
amount, so the books balance. \`ledger.post(event)\` is **not** idempotent: posting an event twice books
the money twice. The relay is at-least-once, so duplicates *will* arrive. The consumer, in group
\`ledger\`, owns the last link of the guarantee:

:::sequence
{
  "participants": ["Kafka", "ledger", "Redis"],
  "messages": [
    {"from": "Kafka", "to": "ledger", "label": "poll → payment.captured (event_id e7, offset 5120)", "kind": "reply"},
    {"from": "ledger", "to": "Redis", "label": "SET applied:e7 1 NX EX 604800 → OK: first time", "kind": "sync"},
    {"from": "ledger", "to": "ledger", "label": "ledger.post(event)", "kind": "sync"},
    {"from": "ledger", "to": "Kafka", "label": "commit offset 5121", "kind": "sync"},
    {"from": "Kafka", "to": "ledger", "label": "poll → the same e7 again (relay replay, offset 5188)", "kind": "reply"},
    {"from": "ledger", "to": "Redis", "label": "SET applied:e7 1 NX → (nil): already applied, skip the post", "kind": "sync"},
    {"from": "ledger", "to": "Kafka", "label": "commit offset 5189", "kind": "sync"}
  ]
}
:::

The order inside the loop is the whole design — **claim → post → commit**:

- **Auto-commit off.** Auto-commit acknowledges on a timer, before the post happened. Offsets are
  committed by the consumer, after the work.
- **Claim by the event's own id**, not the offset: \`SET applied:{event_id} 1 NX EX 604800\`. A replayed
  row arrives at a new offset with the same \`event_id\`. Seven days outlasts any replay you will do.
- **Refused claim → skip the post, still commit.** Skipping without committing would redeliver the
  duplicate on every restart, forever.
- **Post fails → release the claim, do not commit.** \`DEL\` the key; the record comes back and is
  retried. Without the \`DEL\` a transient ledger error leaves a claimed, never-posted event.

Where the commit sits relative to the work is what names the guarantee:

| Guarantee | Commit happens | A crash in between | Who pays |
| --- | --- | --- | --- |
| at-most-once | before the work | the event is never applied | the books are short |
| at-least-once | after the work | the event is applied twice | the books are long |
| effectively once | after the work, with an idempotent consumer | the second copy is a no-op | nobody |

:::widget delivery-semantics {}

[Kafka's own exactly-once](https://kafka.apache.org/documentation/#semantics) holds only between Kafka
topics, via transactions. The moment a side effect lives in Redis or Postgres, dedupe is the consumer's
job — "effectively once" is at-least-once delivery plus an idempotent consumer, nothing more.

The Redis claim has a known weak spot: a crash between the \`SET\` and the post leaves a claimed, unposted
event until the TTL. Real ledgers make the **post itself idempotent** — a unique index on \`event_id\` in
the journal, insert-or-ignore — so the claim is only a fast path, and commit offsets in batches once a
whole poll has been applied.

:::quiz
Q: The claim SET is refused for an event. The consumer skips the post. Should it commit the offset?
- [x] Yes — the event is already booked, and an uncommitted duplicate would be redelivered on every restart
- [ ] No — committing acknowledges work that this consumer did not do
- [ ] Only after checking the ledger to confirm the earlier post
> A refused claim is proof that an earlier delivery posted (or is posting) the event. The offset says "this record needs nothing more from me", which is exactly true; left uncommitted, the consumer re-reads and re-skips it after every rebalance or restart.
:::

# Exactly once, assembled from at-least-once pieces

Nothing here is exactly-once on its own. Every hop is at-least-once, and at every hop a key turns the
second delivery into a no-op:

| Hop | What repeats | The key | Where it is checked |
| --- | --- | --- | --- |
| merchant → checkout | the HTTP request | \`Idempotency-Key\` | \`SET idem:{key} NX\` in Redis |
| checkout → provider | the \`Authorize\` call | \`idempotency_key\` in the request | the provider's own dedupe |
| checkout → Postgres | nothing — one transaction | — | the database's atomicity |
| relay → Kafka | the produce | the producer's sequence number; the outbox row | idempotent producer; \`sent_at\` |
| Kafka → ledger | the record | \`event_id\` in the payload | \`SET applied:{event_id} NX\` in Redis |

One pattern, five times: whoever starts the work mints the name, the name travels with the work, and
one atomic command checks and claims it. Offsets, retry counts and row positions are not names — they
change on replay.

:::quiz
Q: The relay's producer is idempotent. Why does the ledger still need its own dedupe?
- [ ] Because not every Kafka client library offers an idempotent producer
- [x] Because the producer's sequence number covers only its own retries; a relay replay after a crash is a new produce the broker accepts
- [ ] Because Kafka does not keep records in order across partitions
> Each key covers one hop. The idempotent producer stops a resend *within* one produce from landing twice; it knows nothing about the outbox row being produced again on the next pass. Only the \`event_id\` inside the payload survives that, and only the consumer can check it.
:::

# One INCR per request: the rate limiter

One merchant's runaway retry loop must not take checkout down for everyone else. A **fixed-window**
limiter runs before the handler: 100 checkouts per merchant per minute, and the whole thing is one Redis
command.

:::sequence
{
  "participants": ["Merchant app", "checkout", "Redis"],
  "messages": [
    {"from": "Merchant app", "to": "checkout", "label": "POST /checkout (merchant m42)", "kind": "sync"},
    {"from": "checkout", "to": "Redis", "label": "INCR rl:m42:29876543 (minute = now // 60)", "kind": "sync"},
    {"from": "Redis", "to": "checkout", "label": "(integer) 1 — new key → EXPIRE 120", "kind": "reply"},
    {"from": "checkout", "to": "Merchant app", "label": "201 · X-RateLimit-Remaining: 99", "kind": "reply"},
    {"from": "Merchant app", "to": "checkout", "label": "POST /checkout (request 101 this minute)", "kind": "sync"},
    {"from": "checkout", "to": "Redis", "label": "INCR rl:m42:29876543 → 101", "kind": "sync"},
    {"from": "checkout", "to": "Merchant app", "label": "429 · Retry-After: 17 · X-RateLimit-Remaining: 0", "kind": "reply"}
  ]
}
:::

\`\`\`text
now       = integer seconds
key       = rl:{merchant}:{now // 60}
count     = INCR key            # == 1 → EXPIRE key 120
remaining = max(100 − count, 0)
count > 100 → 429, Retry-After: 60 − now % 60, X-RateLimit-Remaining: 0
\`\`\`

- **The window is in the key name.** \`rl:{merchant}:{minute}\` is a fresh counter every minute; nothing
  is ever reset.
- **One atomic command.** \`INCR\` returns the count: no \`GET\`, no read-modify-write, no Lua. \`1\` means
  this request created the key; \`> 100\` means reject.
- **Expire on the first hit.** \`EXPIRE 120\` when \`INCR\` returned \`1\` — one window later the key is gone.
  An \`INCR\` without an expiry is a memory leak with a merchant id on it.
- **Tell the client.** [\`Retry-After\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After)
  carries the seconds left in the window; \`X-RateLimit-Remaining\` the budget left — \`0\` on the 429,
  \`99\` on the first success.

The fixed window has one known flaw: 100 requests at 12:00:59 and 100 more at 12:01:00 are both allowed —
200 in two seconds. The alternatives cost more:

| Limiter | Burst at a boundary | Cost per request |
| --- | --- | --- |
| fixed window | 2× the limit, once per boundary | one \`INCR\` on one key |
| sliding window | smoothed — the previous window counts at a fading weight | two keys and a read |
| token bucket | capped at \`burst\`; refills continuously | a read-modify-write, usually a Lua script |

:::widget token-bucket {"rate": 100, "burst": 100}

Real gateways run the limiter at the edge, size the limit per plan, and **fail open** when Redis is
unreachable: a limiter that turns a cache outage into a checkout outage is worse than no limiter at all.

:::quiz
Q: Why does the limiter set \`EXPIRE 120\` only when \`INCR\` returned 1?
- [ ] Because EXPIRE on an existing key resets the count
- [x] Because that is the one request that created the key; setting it every time costs a round trip for nothing
- [ ] Because later requests might belong to a different window
> \`INCR\` returning 1 is the signal that this request created the key, and the expiry needs setting once. Setting it on every request would work but doubles the commands for no change in behaviour; the window is already in the key name, so a late request cannot land in the wrong one.
:::

# What to take away

- **A retry must be a replay.** The client names the operation with an \`Idempotency-Key\`; one atomic
  \`SET NX EX\` is both the check and the claim; the stored body makes the replay byte-identical; the TTL
  bounds the promise.
- **A deadline bounds your latency, not the provider's state.** Retry only \`UNAVAILABLE\`, with backoff
  and jitter, with the key in the request; and when the deadline fires, say \`PENDING\` — never "failed".
- **Never dual-write.** The order and its event commit together as rows; publishing is a separate job
  that reads what the database committed.
- **Durable means acknowledged.** \`acks=all\`, the idempotent producer, and \`sent_at\` written only after
  the ack. Choose a duplicate over a loss, every time.
- **Exactly once is a chain of idempotent hops.** At-least-once delivery plus a consumer that claims the
  event's own id before it posts and commits after.
- **One atomic command beats a clever one.** \`INCR\` on a key that names the window, \`EXPIRE\` on first
  touch, and fail open when the limiter's store is away.

The primary source is Stripe's
[*Designing robust and predictable APIs with idempotency*](https://stripe.com/blog/idempotency)
(Brandur Leach, 2017): how a payments API treats a retry, why the key is the client's to choose, and
what the server stores so that the replay is identical.
`;
