/**
 * The learning guide for the Notification Service: the concepts the six steps rest on, in the order
 * a notification meets them — a figure or a demo where one says it faster than prose, a pop quiz per
 * section. Rendered at `/notifications/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

Every product team wants to ping users — an order shipped, a friend replied, a password changed —
and each would otherwise build its own half-working sender. A **notification platform** takes those
requests through one door and gets them to a phone: the shape Uber, Airbnb and LinkedIn have each
described. The course builds the push path of one, **notify**, in six pieces:

:::diagram
{
  "nodes": [
    {"id": "app", "kind": "client", "label": "Product services", "sub": "POST /notifications · Idempotency-Key", "x": 9, "y": 50},
    {"id": "api", "kind": "http", "label": "notify API", "sub": "step 1 · validate, claim the key, 202", "x": 28, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "idem:{key} · rl:{user} · prefs:{user}", "x": 50, "y": 16},
    {"id": "bus", "kind": "kafka", "label": "notifications", "sub": "step 2 · key = user id · 8 partitions", "x": 50, "y": 50},
    {"id": "worker", "kind": "service", "label": "delivery", "sub": "step 6 · group delivery, manual commits", "x": 72, "y": 50},
    {"id": "gateway", "kind": "grpc", "label": "Push gateway", "sub": "step 5 · Send · 3 s deadline", "x": 90, "y": 26},
    {"id": "retry", "kind": "kafka", "label": "notifications-retry", "sub": "+ notifications-dlq after 5 attempts", "x": 90, "y": 74},
    {"id": "db", "kind": "db", "label": "Preferences DB", "sub": "step 4 · source of truth for prefs", "x": 28, "y": 84}
  ],
  "edges": [
    {"from": "app", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "SET NX · DEL"},
    {"from": "api", "to": "bus", "kind": "kafka", "label": "produce · acks=all"},
    {"from": "api", "to": "db", "kind": "plain", "label": "save_prefs"},
    {"from": "bus", "to": "worker", "kind": "kafka", "label": "consume"},
    {"from": "worker", "to": "redis", "kind": "redis", "label": "ZADD · GET prefs"},
    {"from": "worker", "to": "db", "kind": "plain", "label": "load_prefs on miss"},
    {"from": "worker", "to": "gateway", "kind": "grpc", "label": "Send"},
    {"from": "worker", "to": "retry", "kind": "kafka", "label": "retry · dlq"},
    {"from": "retry", "to": "worker", "kind": "kafka", "label": "consume"}
  ]
}
:::

- **Accept** (step 1): an HTTPS endpoint validates the request, dedupes the caller's retries with an
  \`Idempotency-Key\`, and answers \`202\` once the notification is in Kafka.
- **Queue** (step 2): one record per accepted request on \`notifications\`, keyed by user, acknowledged
  by every in-sync replica before the API answers.
- **Limit and filter** (steps 3 and 4): the worker asks Redis whether this user has had twenty in
  the last hour and whether their preferences allow a push now.
- **Send** (step 5): one gRPC call with a deadline, jittered retries for "not right now", a
  stale-token path for "never".
- **Deliver, retry, give up** (step 6): a consumer group that commits only after the outcome is
  recorded, re-queues failures to a retry topic, and parks the hopeless ones in a dead-letter queue.

SMS, email, templates, receipts, digests and several devices per user are left out; none changes
the shape.

# Intake: the first duplicate is the caller's retry

A product service calls \`POST /notifications\` and its connection drops before the reply. It cannot
know whether the ping went out, so it retries — and a user must never get the same ping twice. So
every request carries an
[\`Idempotency-Key\`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/),
and two requests with one key produce one notification:

:::sequence
{
  "participants": ["Product service", "notify API", "Redis"],
  "messages": [
    {"from": "Product service", "to": "notify API", "label": "POST /notifications · Idempotency-Key: k1", "kind": "sync"},
    {"from": "notify API", "to": "notify API", "label": "validate — 400 and no Redis call otherwise", "kind": "sync"},
    {"from": "notify API", "to": "Redis", "label": "SET idem:k1 n-7f3 NX EX 86400 → OK", "kind": "sync"},
    {"from": "notify API", "to": "notify API", "label": "enqueue(notification) — waits for Kafka", "kind": "sync"},
    {"from": "notify API", "to": "Product service", "label": "202 {\\"id\\": \\"n-7f3\\"}", "kind": "reply"},
    {"from": "Product service", "to": "notify API", "label": "POST /notifications · Idempotency-Key: k1 (retry)", "kind": "sync"},
    {"from": "notify API", "to": "Redis", "label": "SET … NX → (nil) · GET idem:k1 → n-7f3", "kind": "sync"},
    {"from": "notify API", "to": "Product service", "label": "200 {\\"id\\": \\"n-7f3\\"} (replayed)", "kind": "reply"}
  ]
}
:::

The order of operations is the design:

1. **Validate before claiming.** \`user_id\` and \`title\` present, \`channel\` one of
   \`push | sms | email\`, \`priority\` one of \`high | normal\`, the header present — anything else is a
   **400** that never touches Redis, so a rejected request burns no key.
2. **Mint the id, then claim the key in one command.** \`SET idem:{key} <id> NX EX 86400\` is both the
   check and the claim; two commands would let two concurrent retries both win.
3. **A refused SET is a replay.** \`GET\` the stored id and answer **200** with it.
4. **Enqueue, then 202.** A \`202 Accepted\` is a promise, not a receipt: the notification is in Kafka,
   not yet on a phone.
5. **A failed enqueue releases the key.** \`DEL idem:{key}\`, then **503**: the retry finds no key,
   claims it, enqueues again. A key left claimed for a notification nobody enqueued would turn every
   retry into a confident 200 for a ping that never existed.

:::widget idempotency {}

The 24-hour expiry bounds the memory. Real intake APIs also fingerprint the body — same key,
different payload → **422** — and scope keys per caller, so two teams' \`order-123\` do not collide.

:::quiz
Q: A request claims its idempotency key, then the enqueue raises. What must the API do before answering 503?
- [ ] Nothing: the key expires in 24 hours anyway
- [x] Delete the key, so the caller's retry can claim it and enqueue again
- [ ] Store the notification under the key and enqueue it later
> With the key left in place, the retry is refused by SET NX and answered 200 — for a notification that was never enqueued. The claim is only honest while it names a record that exists.
:::

# One partition per user is the ordering you need

Kafka orders records within a partition and nowhere else — less than a global queue offers and
exactly enough: a user notices when "your order shipped" arrives before "your order was placed";
nobody notices the order between two users. So every record on \`notifications\` is keyed by the
**user id** — same key, same partition, same order — and eight partitions spread users across the
workers.

:::widget kafka-partitions {"partitions": 8}

The producer's configuration is where the \`202\` gets its meaning: the record must actually be in
Kafka when \`enqueue\` returns.

| Setting | What it buys | Without it |
| --- | --- | --- |
| \`acks=all\` | the leader answers once every in-sync replica has the record | a leader failover loses an acknowledged notification |
| idempotent producer | the broker dedupes the producer's own resends by sequence number | a lost ack and a resend write the record twice |
| wait for the ack, **2 s** timeout | the record is durable before the API answers | a 202 for a record still in a client buffer |
| priority in a **record header** | the consumer reads \`high\` or \`normal\` without parsing the value | every worker deserialises JSON to triage |

A timeout and a delivery error are the same thing to the caller: \`enqueue\` raises, the API releases
the idempotency key and answers **503**. An analytics event can fire and forget; a notification
cannot, because the request path has made a promise. Note the two dedupes: the \`Idempotency-Key\`
covers the *caller's* retries, the idempotent producer the *producer's* — each hop that retries
needs its own.

:::quiz
Q: Why key the record by user id rather than by the unique notification id?
- [ ] A unique key spreads load more evenly across partitions
- [x] Ordering holds only within a partition, and the order a user sees is the only one that matters
- [ ] Kafka requires keys to repeat
> A unique key spreads one user's notifications over eight partitions and eight workers, in whatever order they get to them. Keying by user puts them on one partition, in the order accepted.
:::

# Twenty an hour: a sliding window in a sorted set

Twenty pings an hour is where a user turns notifications off for good, so the delivery worker asks
before every send: how many has this user had in the last hour, counting this one? Three ways to
answer:

| Limiter | How it counts | At the boundary | Cost per user |
| --- | --- | --- | --- |
| Fixed window | one counter per clock hour | 2× the limit: 20 at 10:59, 20 at 11:00 | one integer |
| Token bucket | continuous refill, capped at the burst | smooth; one burst up to the cap | two numbers |
| Sliding window | the exact events of the last hour | never more than 20 in any 60 minutes | one member per event |

:::widget token-bucket {"rate": 20, "burst": 20}

The course takes the exact one. A Redis sorted set scored by time *is* a sliding window: add the
event, trim everything older than an hour, count what is left. Four commands in one \`MULTI\`, one
round trip:

\`\`\`text
ZADD             rl:{user}  <now_ms>  <notification_id>
ZREMRANGEBYSCORE rl:{user}  -inf      <now_ms − 3600000>
ZCARD            rl:{user}
EXPIRE           rl:{user}  3600
\`\`\`

- **Add first, trim second.** Once the stale members are gone, \`ZCARD\` is exactly "events in the last
  hour including this one" — read from the third reply of the \`EXEC\`, not a separate round trip.
- **Over 20 → drop.** \`INCR dropped:{user}\` so the number lands on a dashboard, return false.
- **EXPIRE every time.** The TTL equals the window, because anything older is trimmed anyway; an
  idle user's set disappears on its own.
- **Per user, so it shards.** A hundred workers checking a hundred users never contend.

From the course's sequence, \`EXEC → [1, 3, 21, 1]\`: one added, three expired, twenty-one in the
window — dropped. The price is one sorted-set member per event instead of a counter: nothing at
twenty an hour. At thousands per window real systems move to a
[sliding log with coarse buckets](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
or a token bucket, wrap the four commands in a Lua script so add-trim-count is atomic against
concurrent workers, and remove the member again on "drop" so dropped pings do not eat the budget.

:::quiz
Q: A user got 20 notifications between 10:30 and 10:59. The 21st arrives at 11:01. What does each limiter say?
- [x] Fixed window: allow (new hour); sliding window: drop (21 in the last 60 minutes)
- [ ] Both drop it; the limits are the same
- [ ] Both allow it; 11:01 is a new hour
> The fixed window reset at 11:00 and has seen one event. The sliding window still holds the twenty from 10:30 — the earliest is not trimmed until 11:30 — so this makes twenty-one. "Twenty an hour" means twenty in any hour.
:::

# Preferences: cache-aside, and invalidate rather than update

Every delivery reads the user's preferences — is push on, when are the quiet hours — and the
preferences database must not see one query per notification. Readers go through Redis; writers go
to the database and then *remove* the cached copy:

:::sequence
{
  "participants": ["delivery", "Redis", "Preferences DB", "notify API"],
  "messages": [
    {"from": "delivery", "to": "Redis", "label": "GET prefs:u42 → (nil)", "kind": "sync"},
    {"from": "delivery", "to": "Preferences DB", "label": "load_prefs(u42)", "kind": "sync"},
    {"from": "Preferences DB", "to": "delivery", "label": "{push: true, quiet 22–07}", "kind": "reply"},
    {"from": "delivery", "to": "Redis", "label": "SET prefs:u42 {…} EX 600", "kind": "sync"},
    {"from": "notify API", "to": "Preferences DB", "label": "PUT /users/u42/preferences → save_prefs(u42, {push: false})", "kind": "sync"},
    {"from": "notify API", "to": "Redis", "label": "DEL prefs:u42", "kind": "sync"},
    {"from": "delivery", "to": "Redis", "label": "GET prefs:u42 → (nil) → reload from the database", "kind": "sync"}
  ]
}
:::

- **Read side — cache-aside on** \`prefs:{user_id}\`. \`GET\`; on a miss, \`load_prefs\` from the
  database, \`SET\` the JSON with \`EX 600\`, return it. Ten minutes stale is acceptable.
- **Write side — database first, then** \`DEL\`. \`PUT /users/{id}/preferences\` writes through with
  \`save_prefs\`, then deletes \`prefs:{id}\`. The next read misses and reloads: a user's own change is
  visible at once despite the TTL.
- **Never write the new value into the cache on the write path**, even though it is in hand.

The third rule looks wrong and is not. Two concurrent \`PUT\`s can finish their database writes in one
order and their cache writes in the other; the cache then holds the loser for ten minutes. A \`DEL\`
has no order to get wrong: whichever runs last, the next reader refills from the database, which has
the winner. The order of the two calls matters too — \`DEL\` first and a concurrent reader could
refill the old row before the database write landed. Facebook's memcache paper makes the same call:
[delete, not update](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala).

The worker reads two things from the document: \`push\` must be true, and \`quiet(prefs, hour)\` must be
false — unless the priority is \`high\`, which goes through quiet hours; a password change at 3 a.m.
is the point of the exception. The default row is \`{push: true, quiet_start: 22, quiet_end: 7}\`.

:::quiz
Q: On \`PUT /users/{id}/preferences\` the new document is in hand. Why DEL the cache key instead of SET-ing it?
- [ ] DEL is cheaper than SET
- [x] Two concurrent PUTs can land in the cache in the opposite order to the database, leaving the loser cached
- [ ] The worker would not notice a SET until the TTL expires
> The database serialises the two writes and keeps the last. A SET from each request races the other, and the cache can keep the one the database rejected. A DEL from each leaves the cache empty either way.
:::

# A provider call that cannot be allowed to hang

The push gateway fronts APNs and FCM with one unary RPC — \`Send(SendRequest) returns (SendReply)\` —
and like every provider it has bad minutes. A worker that waits on one of them holds its partition,
and every user behind it, hostage. Three decisions make the call safe inside a consumer loop:

:::sequence
{
  "participants": ["delivery", "Push gateway", "devices"],
  "messages": [
    {"from": "delivery", "to": "Push gateway", "label": "Send(token, title, body, collapse_key) · deadline 3 s", "kind": "sync"},
    {"from": "Push gateway", "to": "delivery", "label": "status UNAVAILABLE", "kind": "reply"},
    {"from": "delivery", "to": "delivery", "label": "sleep 200 ms + random jitter up to 200 ms", "kind": "sync"},
    {"from": "delivery", "to": "Push gateway", "label": "Send(…) attempt 2 · deadline 3 s", "kind": "sync"},
    {"from": "Push gateway", "to": "delivery", "label": "SendReply{message_id}", "kind": "reply"},
    {"from": "delivery", "to": "Push gateway", "label": "Send(stale-token, …)", "kind": "sync"},
    {"from": "Push gateway", "to": "delivery", "label": "status NOT_FOUND → devices.disable(token), no retry", "kind": "reply"}
  ]
}
:::

1. **A deadline on every call** — 3 s. gRPC propagates it to the server, which stops working on a
   request nobody is waiting for; the client gets \`DEADLINE_EXCEEDED\` instead of a hang.
2. **Retry only the statuses that mean "not right now"**, with backoff and jitter, at most 3 attempts.
3. **A distinct retryable error** when the attempts run out, so the caller can park the work.

| Status | Meaning | Action |
| --- | --- | --- |
| \`UNAVAILABLE\`, \`RESOURCE_EXHAUSTED\` | the gateway is overloaded or restarting | wait \`200 ms × 2^attempt\` plus a random slice, try again; 3 attempts in all |
| \`INVALID_ARGUMENT\`, \`NOT_FOUND\` | the token is malformed or unregistered | \`devices.disable(token)\`, return nothing, never retry |
| \`DEADLINE_EXCEEDED\` | 3 s passed | raise the **retryable** error at once |
| retries exhausted | three "not right now" in a row | raise the **retryable** error |
| anything else | a bug on one side or the other | propagate as a plain error |

:::widget deadline-retry {"base": 200, "deadline": 3000, "attempts": 3}

The jitter is not decoration. A gateway recovering from an outage is hit, on the first tick, by
every worker that was waiting — in lock-step if they all slept exactly 200 ms, spread over a window
if each added a random slice; Marc Brooker's
[*Exponential Backoff And Jitter*](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
is the standard account. The stale-token path is the drop counter's cousin: a token that will fail
the same way forever must stop being tried, or the gateway's error rate is a lie. Real clients also
honour \`Retry-After\` metadata, open a circuit breaker when the error rate stays high, and let the
device collapse duplicates on the \`collapse_key\` — here the notification id.

:::quiz
Q: The gateway answers \`NOT_FOUND\` for a device token. Why not retry, as for \`UNAVAILABLE\`?
- [ ] NOT_FOUND is a 4xx and gRPC forbids retrying those
- [x] The token is unregistered; the same call will fail the same way, so disable it and move on
- [ ] Retrying would exceed the 3 s deadline
> UNAVAILABLE describes the gateway's moment; NOT_FOUND describes the token. A moment passes, a token does not come back. Disabling it is the only action that changes anything.
:::

# The delivery worker: outcome first, commit last

The consumer group \`delivery\` reads both \`notifications\` and \`notifications-retry\`, auto-commit
off. For every record it reaches one of three outcomes — delivered, skipped, re-queued — records it,
and only then commits the offset:

:::sequence
{
  "participants": ["Kafka", "delivery", "Push gateway"],
  "messages": [
    {"from": "Kafka", "to": "delivery", "label": "poll → notifications (partition 3, offset 90213)", "kind": "reply"},
    {"from": "delivery", "to": "delivery", "label": "allowed(u42, n-7f3) · get_prefs(u42).push · quiet? unless priority = high", "kind": "sync"},
    {"from": "delivery", "to": "Push gateway", "label": "send_push(n-7f3)", "kind": "sync"},
    {"from": "Push gateway", "to": "delivery", "label": "Retryable (deadline exceeded)", "kind": "reply"},
    {"from": "delivery", "to": "Kafka", "label": "produce notifications-retry · same key and value · attempt=1 → ack", "kind": "sync"},
    {"from": "delivery", "to": "Kafka", "label": "commit offset 90214 (partition 3)", "kind": "sync"}
  ]
}
:::

- **Skipped is an outcome.** Rate limit says no, push is off, or quiet hours and priority \`normal\`:
  nothing is sent, the record is committed past. Nobody re-queues a ping the user asked not to get.
- **Retry in a topic, not in place.** Sleeping and calling the gateway again blocks every user on the
  partition behind one slow provider. Re-queuing the record — same key, same value, an \`attempt\`
  header one higher — frees the partition and keeps the order for everyone who did not fail.
- **Five attempts, then the DLQ.** \`attempt_of(record)\` reads the header (0 on first delivery); when
  the next attempt would reach **5**, the record goes to \`notifications-dlq\`, where a human or a
  replay tool can look at it.
- **Wait for the re-queue's ack, then commit.** The record must exist on the retry topic before the
  offset that held it is given up.

The commit position decides the delivery guarantee end to end:

:::widget delivery-semantics {}

Commit before the outcome and a crash in between loses the record —
[at-most-once](https://kafka.apache.org/documentation/#semantics). Commit after, and the same crash
replays it: the worker restarts from the last committed offset, sees the record again, and may send
a ping that already went out — **at-least-once**, the course's deliberate choice. A duplicate ping
is better than a lost one, and the \`collapse_key\` lets the device fold it away.

A re-queued record keeps its user key, and the retry topic is just another topic the same group
reads — no second code path. Uber's pattern runs
[several retry topics with growing delays](https://www.uber.com/blog/reliable-reprocessing/)
— \`retry-1m\`, \`retry-10m\` — so a provider gets longer to recover; real workers also pause a
partition rather than sleep in it, give the \`priority\` header its own group, and alert on the DLQ's
depth.

:::details What the retry topic gives up
Per-user order, for the one user who failed: "your order shipped" is re-queued, "your order was
delivered" goes out on the next poll, and the shipped ping arrives afterwards. The course accepts
that over holding every user on the partition for one user's order; a system that cannot pauses the
partition until the retry lands instead.
:::

:::quiz
Q: The worker produces the record to \`notifications-retry\`, then crashes before committing. What happens on restart?
- [ ] The record is lost: it left the main topic when it was produced to the retry topic
- [x] The record is consumed again from the main topic and re-queued a second time — a duplicate, not a loss
- [ ] Kafka notices the uncommitted record and skips it
> Producing to the retry topic moves nothing; the offset is still uncommitted, so the restarted worker reads the record again and the retry topic holds it twice. A crash between outcome and commit duplicates, never loses.
:::

# What to take away

- **Dedupe at every hop that retries.** The caller's retries meet \`SET idem:{key} NX\`; the producer's
  meet the idempotent producer; the consumer's replays meet the device's \`collapse_key\`.
- **A 202 is a promise, so pay for it.** \`acks=all\`, wait for the acknowledgement, release the
  idempotency key when it does not come.
- **Order by the key the user notices.** Per-user keys give per-user order; nothing else needs one.
- **Limits and preferences live in Redis, next to the worker.** A sorted set is an exact sliding
  window in four commands; cache-aside with delete-on-write survives concurrent writers where
  update-in-place does not.
- **A provider call inside a consumer needs a deadline, selective retries with jitter, and a way to
  say "later".** Retry topics make "later" an ordinary record; the DLQ makes "never" visible.
- **Commit after the outcome.** A crash between the two duplicates a ping instead of losing one.

The course has no single primary source; the closest is Uber's
[*Building Reliable Reprocessing and Dead Letter Queues with Apache Kafka*](https://www.uber.com/blog/reliable-reprocessing/)
(2018): the retry-topic and dead-letter design the delivery worker follows, and the reasoning for
why blocking a partition on one failure is the thing to avoid.
`;
