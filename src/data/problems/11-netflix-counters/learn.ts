/**
 * The learning guide for Distributed Counters: the concepts the five steps rest on, in the order a
 * reader meets them — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/netflix-counters/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

"How many times was this title played?" is one question with two honest answers. A badge in the UI
wants a number *now* and may be a little wrong; a billing or experimentation pipeline wants the right
number and can wait a few seconds. Netflix's **Distributed Counter Abstraction** answers both behind one
API — AddCount, GetCount, ClearCount over named counters in configured namespaces — with two
implementations behind it. The course rebuilds that shape with Redis in place of EVCache and the rollup
store, Kafka in place of the TimeSeries abstraction, and one rollup worker in place of the queued rollup
tier:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Clients", "sub": "POST …/add · GET · DELETE", "x": 8, "y": 30},
    {"id": "internal", "kind": "client", "label": "Other services", "sub": "GetCount(ns, name)", "x": 8, "y": 74},
    {"id": "api", "kind": "http", "label": "counters", "sub": "step 1 · the namespace decides: 200 or 202", "x": 30, "y": 30},
    {"id": "svc", "kind": "grpc", "label": "CounterService", "sub": "step 5 · total from a 2 s cache", "x": 30, "y": 74},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "counter:… (step 2) · rollup:… · total:…", "x": 56, "y": 52},
    {"id": "kafka", "kind": "kafka", "label": "counter-events", "sub": "step 3 · key = ns:name, acks=all", "x": 56, "y": 14},
    {"id": "rollup", "kind": "service", "label": "rollup", "sub": "step 4 · claim → fold → commit", "x": 82, "y": 14}
  ],
  "edges": [
    {"from": "client", "to": "api", "kind": "http", "label": "HTTPS"},
    {"from": "api", "to": "redis", "kind": "redis", "label": "SET NX EX · INCRBY"},
    {"from": "api", "to": "kafka", "kind": "kafka", "label": "produce acks=all"},
    {"from": "kafka", "to": "rollup", "kind": "kafka", "label": "consume"},
    {"from": "rollup", "to": "redis", "kind": "redis", "label": "SET seen NX · HINCRBY"},
    {"from": "internal", "to": "svc", "kind": "grpc", "label": "GetCount"},
    {"from": "svc", "to": "redis", "kind": "redis", "label": "GET total · HVALS"}
  ]
}
:::

- **One API** (step 1): \`POST /counters/{ns}/{name}/add\`, \`GET\`, \`DELETE\`. The namespace is configured
  once as best-effort or eventually consistent; the caller never chooses per request.
- **Best-effort** (step 2): a key in Redis, \`INCRBY\`, a TTL armed once. Fast, cheap, allowed to be lost.
- **Eventually consistent** (steps 3 and 4): no number is incremented at write time. Every add is an
  event on \`counter-events\`, durable before the API answers; a **rollup** consumer folds the events into
  per-minute buckets, deduplicating on the client's token.
- **Read side** (step 5): \`CounterService.GetCount\` over gRPC, serving the rolled-up total through a
  two-second cache and saying how old the number is.

# Two kinds of counter, one API

The idea the whole system rests on: *which kind of counter* is a property of the **namespace**, not of
the request. \`views\` is best-effort, \`plays\` is eventually consistent, and a client that calls
\`POST /counters/plays/stranger-things/add\` gets the durable kind without knowing it asked for one.

| | Best-effort (\`views\`) | Eventually consistent (\`plays\`) |
| --- | --- | --- |
| What an add does | \`INCRBY\` on a cache key | appends an event to a log |
| Answer | **200** \`{"count": 1207}\` — the number moved | **202** \`{"accepted": true}\` — the number *will* move |
| Token | ignored — a cache cannot dedupe | required, non-empty; the rollup dedupes on it |
| Can be lost | yes: TTL, eviction, restart | no: every replica has the event before the 202 |
| Read | \`GET\` the key, \`0\` if missing | sum the rolled-up buckets, \`0\` if none |
| Fit | badges, previews, anything approximate | billing, experiments, anything audited |

Netflix's control plane configures more per namespace — retention, cardinality limits, consistency —
but the one setting above is the one that changes what the API can promise. The validation order
follows from it:

1. **Namespace first.** Unknown → **404** on every route. It decides everything after it.
2. **Name** against \`^[A-Za-z0-9_-]{1,64}$\` → **400** otherwise.
3. On the add route only: \`delta\` a non-zero integer within ±1 000 000 (\`MAX_DELTA\`) → **400**; and in
   the eventually-consistent branch only, a non-empty \`token\` → **400** without it.
4. \`DELETE\` calls the matching clear and answers **204**; \`GET\` answers **200** with the count from
   whichever store the namespace names.

The two success codes are the API telling the truth. A **200** with a count is a promise that the
number moved; a **202** is a promise that it *will*, and that is the only promise a durable log can
make synchronously. A client that reads right after a 202 and sees the old count is not seeing a bug —
it is seeing
[eventual consistency](https://www.allthingsdistributed.com/2008/12/eventually_consistent.html) stated
in a status code. The third answer, **503**, is for the case where the log could not take the event in
time; the next sections say why that is safe.

:::widget status-codes {}

:::quiz
Q: A client sends \`POST /counters/views/trailer-7/add\` with \`{"delta": 1}\` and no token. What should happen?
- [x] 200 with the new count; \`views\` is best-effort and a token has no consumer there
- [ ] 400: every add needs an idempotency token
- [ ] 202: adds are always accepted asynchronously
> The token exists for one reader, the rollup, and \`views\` has no rollup. Requiring it on a counter that cannot honour it would be a lie about what the system does; the API asks for it only where something dedupes on it.
:::

# A best-effort counter is a number in a cache

The cheapest thing that can be called a counter: one key, one atomic \`INCRBY\`, no log and no
reconciliation. The key is \`counter:{ns}:{name}\`; a read is a \`GET\` (\`0\` when the key is missing or
expired); a clear is a \`DEL\`. The only subtle part is the lifetime:

:::sequence
{
  "participants": ["counters", "Redis"],
  "messages": [
    {"from": "counters", "to": "Redis", "label": "MULTI · SET counter:views:trailer-7 0 NX EX 3600 · INCRBY counter:views:trailer-7 1 · EXEC", "kind": "sync"},
    {"from": "Redis", "to": "counters", "label": "[OK, 1] — key created, TTL armed", "kind": "reply"},
    {"from": "counters", "to": "Redis", "label": "MULTI · SET … 0 NX EX 3600 · INCRBY … 1 · EXEC (20 min later)", "kind": "sync"},
    {"from": "Redis", "to": "counters", "label": "[nil, 2] · TTL still 2400 — the SET was a no-op", "kind": "reply"},
    {"from": "counters", "to": "Redis", "label": "GET counter:views:trailer-7", "kind": "sync"},
    {"from": "Redis", "to": "counters", "label": "\\"2\\"", "kind": "reply"}
  ]
}
:::

- **Two commands, one round trip.** \`SET key 0 NX EX 3600\` and \`INCRBY key delta\` go in one pipeline;
  the second reply is the new count.
- **The trick is** \`NX\`. The \`SET\` only runs when the key does not exist, so the TTL of
  \`TTL_S\` (3600 s) is measured from the key's **creation** and never touched again.
- **Never refresh the TTL on an add.** An \`EXPIRE\` after every \`INCRBY\` is the bug this design avoids:
  a hot counter that re-arms its own expiry never leaves the cache, and the cache fills with counters
  nobody configured to live that long. Lifetime bounded by configuration, not by traffic.
- **No store behind it.** A counter that expires or is evicted starts again from zero on its next add.
  That is the contract — approximate, fast, cheap — and the reason the token is ignored here.

This reproduces what Netflix's EVCache inherits from Memcached, whose
[\`incr\`](https://github.com/memcached/memcached/blob/master/doc/protocol.txt) changes the value and
leaves the item's expiry alone — only \`touch\` and the storage commands set one.
Real deployments replicate the cache across regions and accept that replicas disagree briefly; the
moment a number has to be right, they reach for the other kind.

:::quiz
Q: Why is \`SET … NX EX 3600\` pipelined with the \`INCRBY\` instead of an \`EXPIRE 3600\` after it?
- [ ] \`EXPIRE\` is slower than \`SET\`
- [x] \`EXPIRE\` on every add re-arms the TTL, so a busy counter would never expire; \`SET NX\` arms it once, at creation
- [ ] \`INCRBY\` cannot run on a key with a TTL
> The namespace's TTL is a configured lifetime. A counter that extends its own life on every hit is bounded by traffic, which is exactly what a cache must not be; the \`NX\` makes the TTL a one-time decision the adds cannot undo.
:::

# An add that is not a number yet

An eventually-consistent counter does not exist as a number at write time. It exists as a durable
**fact** — "add 1 to \`plays/stranger-things\`, token \`t-9f3\`, at this time" — and that fact is what
the **202** vouches for. The API's \`append_event\` produces one record and waits for the broker to
confirm it:

:::sequence
{
  "participants": ["counters", "Producer", "Kafka"],
  "messages": [
    {"from": "counters", "to": "Producer", "label": "produce(counter-events, key=plays:stranger-things, {ns, name, delta: 1, token: t-9f3, ts})", "kind": "sync"},
    {"from": "Producer", "to": "Kafka", "label": "partition hash(plays:stranger-things) % 6 · acks=all", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack: every in-sync replica has it (offset 88 412)", "kind": "reply"},
    {"from": "Producer", "to": "counters", "label": "delivery callback (err = None)", "kind": "async"},
    {"from": "counters", "to": "counters", "label": "flush(timeout 1 s) → 0 pending · return → 202", "kind": "sync"}
  ]
}
:::

Everything about the producer follows from the promise:

- **Topic** \`counter-events\`, **key** \`{ns}:{name}\`. Every event of one counter lands on one partition,
  in order, so a consumer folds a counter without merging partitions.
- **Value** is the fact itself: \`{"ns": …, "name": …, "delta": …, "token": …, "ts": …}\`. The token is
  carried as is; it belongs to the client, and the rollup needs it unchanged.
- **Every replica, or nothing:** \`acks=all\`. A leader-only ack can vanish with the leader, and a vanished event is a wrong number
  forever. The 202 means every in-sync replica has it.
- **No doubled facts:** \`enable.idempotence=true\`. The producer's own retries must not double a fact. Kafka's
  [idempotent producer](https://kafka.apache.org/documentation/#semantics) dedupes a resend of the same
  batch at the broker.
- **A bounded flush.** \`producer.flush(timeout=FLUSH_TIMEOUT_S)\` — one second — before returning. A
  stored delivery error, or any record still pending when the flush returns, raises \`EventNotDurable\`
  and the API answers **503**.

That last rule is the opposite trade from a click stream, where a lost event is cheaper than a slow
redirect. Here the add waits — but never longer than a second: a promise you cannot keep in a second
is better refused than kept late. Netflix writes these events to its TimeSeries abstraction with the
same idea — write durably, dedupe downstream.

:::quiz
Q: The flush returns after one second with the record still pending. What should the API answer?
- [ ] 202 — the producer will keep retrying in the background
- [x] 503 — the event is not known to be durable, and the client retries with the same token
- [ ] 200 with the current count, so the client is not blocked
> A 202 is a durability promise; answering it for a record nobody has confirmed turns a broker hiccup into a silently missing add. A 503 is honest, and the token on the retry is what makes the retry harmless.
:::

# The token: why a retry is safe

The API cannot know whether a 503 was returned *before* or *after* the record landed — the flush timed
out, but the broker may have the event. So instead of guessing it refuses, and lets two other parties
settle it: the **client**, which retries with the **same token**, and the **rollup**, which counts a token
once.

| Who | Does | So that |
| --- | --- | --- |
| Client | generates the token, sends it on the add, resends it on a retry | the retry is recognisably the same add |
| API | requires it (400 without), carries it into the event unchanged | the log holds the client's identity for the add, not a server-made one |
| Rollup | claims \`seen:{token}\` before folding; a refused claim is skipped | the second copy of a fact changes nothing |

This is the [idempotency-key](https://stripe.com/docs/api/idempotent_requests) pattern with the dedupe
moved to the consumer: the API keeps no record of what it accepted, so the cheapest place to make an add
happen once is the single reader that turns the log into a number.

:::widget idempotency {}

:::details Why the token is the client's and not the server's
A server-generated id would be new on every retry, so a client that resent after a 503 would create a
second fact the rollup could not tell from the first. The only party that knows "this is the same add
as the one I sent a moment ago" is the sender; the token is how it says so. Netflix carries the same
token into its TimeSeries log and dedupes on it in the rollup.
:::

:::quiz
Q: A client retries a timed-out add with a *fresh* token. What does the system do?
- [ ] The rollup notices the same delta and timestamp and drops the duplicate
- [ ] The API rejects the second token with 409
- [x] Both adds are counted; the system has no way to tell them apart
> The dedupe key is the token and nothing else. Two different tokens are two facts, and the rollup folds both. The client's half of the contract is to keep the token across retries.
:::

# Rollup: a log becomes a number, effectively once

The **rollup** worker — consumer group \`rollup\` on \`counter-events\`, auto-commit off — is where the
events of a counter turn into something a read can return. Each record is handled in a fixed order,
and the order is the design:

:::sequence
{
  "participants": ["Kafka", "rollup", "Redis"],
  "messages": [
    {"from": "Kafka", "to": "rollup", "label": "poll → {plays, stranger-things, +1, t-9f3, ts} (partition 2, offset 88 412)", "kind": "reply"},
    {"from": "rollup", "to": "Redis", "label": "SET seen:t-9f3 1 NX EX 86400 → OK (claimed)", "kind": "sync"},
    {"from": "rollup", "to": "Redis", "label": "HINCRBY rollup:plays:stranger-things 1760616000 1", "kind": "sync"},
    {"from": "rollup", "to": "Kafka", "label": "commit offset 88 413 (partition 2)", "kind": "sync"},
    {"from": "Kafka", "to": "rollup", "label": "poll → same token t-9f3 again (the client retried a 503)", "kind": "reply"},
    {"from": "rollup", "to": "Redis", "label": "SET seen:t-9f3 NX → (nil): skip", "kind": "sync"},
    {"from": "rollup", "to": "Kafka", "label": "commit offset 88 414", "kind": "sync"}
  ]
}
:::

\`\`\`text
claim   SET seen:{token} 1 NX EX 86400     refused → skip, but still commit
fold    HINCRBY rollup:{ns}:{name} {window} delta
commit  the offset, only now
\`\`\`

- **Claim first, because the fold is not idempotent.** \`HINCRBY\` twice is twice the delta. The claim
  on \`seen:{token}\` (kept for \`SEEN_TTL_S\`, 86 400 s) is the one operation that *is* idempotent — \`NX\`
  succeeds exactly once — so it goes before the operation that is not.
- **Commit last.** A crash between the fold and the commit replays the record on restart; the claim is
  already held, so the replay is a no-op.
- **A refused claim still commits.** It is a retry of an add the API already accepted (the 503 story
  from the previous section), not an error.
- **Malformed records are skipped** — log, commit, move on — rather than crash-looping on a record that
  will never parse.

Kafka's consumer gives **at-least-once** delivery with manual commits; the claim key is what turns it
into *effectively once*. The exactly-once that matters is in the fold, not in the transport.

:::widget consumer-groups {"partitions": 6}

:::widget delivery-semantics {}

:::quiz
Q: The rollup folds the event with \`HINCRBY\`, then crashes before committing the offset. On restart it reads the same record again. What happens?
- [ ] The delta is folded twice; eventually-consistent counters can be slightly off
- [x] \`SET seen:{token} NX\` is refused, the record is skipped and the offset committed; the count is right
- [ ] The consumer detects the duplicate offset and skips it without touching Redis
> Offsets say where to resume, not what was folded; the claim does. Because the claim was taken before the fold, the replay finds it held and does nothing, which is the whole reason the order is claim, fold, commit.
:::

# Minute buckets, and why a closed window never changes

The rollup could keep one integer per counter. It keeps a **hash** — one per counter, one field per
minute — because a bucket whose minute has passed is **immutable**:

\`\`\`text
HINCRBY rollup:plays:stranger-things 1760616000 1     window(ts) = ts - ts % 60
\`\`\`

| Field (window start) | Value | State at 1760616090 |
| --- | --- | --- |
| \`1760615880\` | 412 | closed — will never change |
| \`1760615940\` | 388 | closed — will never change |
| \`1760616000\` | 407 | closed — will never change |
| \`1760616060\` | 19 | open — still receiving folds |

- \`window(ts)\` is the start of the event's minute (\`WINDOW_S\` = 60); the field name is that number.
- \`HINCRBY\` creates the hash and the field on first use: no setup, no schema.
- \`get_count\` is the sum of \`HVALS\` — \`0\` for a counter with no events; \`clear_count\` deletes the hash.

The course keeps every window in one hash and sums it on read. Netflix's rollup aggregates in time
windows for the reason the table shows: a closed window can be stored durably, replicated and cached
without ever re-reading the events behind it, and only the window that is still open needs
recomputing. That is also what lets a hot counter be batched — the pipeline queues counters that
changed, aggregates them in a dedicated rollup tier, and persists the result to a rollup store before
anyone reads it.

:::quiz
Q: Why bucket the rollup by minute instead of keeping one running total per counter?
- [ ] Because \`HINCRBY\` is faster than \`INCRBY\`
- [x] Because a closed minute is immutable, so it can be stored, cached and replicated without re-reading its events
- [ ] Because callers ask for counts per minute
> A single total changes on every add and can never be treated as final. A bucket whose minute has passed can; everything expensive — durable storage, caching, cross-region copies — happens on closed windows, and only the open one is live.
:::

# Reading the total: cache-aside with honest staleness

The rest of the company does not call the HTTPS API. It calls \`CounterService.GetCount\` over gRPC,
and the read side is served from a cache for the same reason the write side is a log: a popular
counter is read far more often than its total changes, and summing a hash on every read of a hot
counter would make Redis the bottleneck.

\`\`\`proto
service CounterService {
  rpc GetCount(GetCountRequest) returns (GetCountReply);
}
message GetCountRequest { string namespace = 1; string name = 2; }
message GetCountReply   { int64 count = 1; int64 as_of = 2; }
\`\`\`

:::sequence
{
  "participants": ["Other service", "CounterService", "Redis"],
  "messages": [
    {"from": "Other service", "to": "CounterService", "label": "GetCount(plays, stranger-things)", "kind": "sync"},
    {"from": "CounterService", "to": "Redis", "label": "GET total:plays:stranger-things", "kind": "sync"},
    {"from": "Redis", "to": "CounterService", "label": "(nil) — miss", "kind": "reply"},
    {"from": "CounterService", "to": "Redis", "label": "HVALS rollup:plays:stranger-things → sum 1207", "kind": "sync"},
    {"from": "CounterService", "to": "Redis", "label": "SET total:plays:stranger-things {count: 1207, as_of: 1760616030} EX 2", "kind": "sync"},
    {"from": "CounterService", "to": "Other service", "label": "GetCountReply{count 1207, as_of 1760616030}", "kind": "reply"},
    {"from": "Other service", "to": "CounterService", "label": "GetCount(plays, stranger-things) · 1 s later", "kind": "sync"},
    {"from": "CounterService", "to": "Redis", "label": "GET total:plays:stranger-things → hit", "kind": "sync"},
    {"from": "CounterService", "to": "Other service", "label": "GetCountReply{count 1207, as_of 1760616030} — same as_of", "kind": "reply"}
  ]
}
:::

- **Same two failures, gRPC's spelling.** Unknown namespace → \`NOT_FOUND\`; a name failing \`NAME_RE\` →
  \`INVALID_ARGUMENT\`. The API's 404 and 400, which is what lets one abstraction serve HTTPS clients and
  internal services alike. Abort before touching Redis.
- **Best-effort reads skip the cache.** The counter is already one \`GET\` away; caching it would only
  add staleness. \`as_of\` is now.
- **Eventually-consistent reads go through** \`total:{ns}:{name}\`, the
  [cache-aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside) way: \`GET\`;
  on a miss sum the buckets, \`SET\` the pair as JSON with \`EX 2\` (\`CACHE_TTL_S\`), return it.
- **The compute time, not the read time:** \`as_of\` is when the count was computed — the cached
  value on a hit, never the current time. Two reads a second apart that return the same \`as_of\` are
  honestly the same number.

Two seconds of staleness on a number that is already eventually consistent costs nothing, and it
caps the cost of a hot counter at one \`HVALS\` every two seconds no matter how many readers there are.
Netflix caches rolled-up values in EVCache in front of its rollup store and, for the counters that
must be exact, offers a read that waits for the rollup instead of reading the cache.

:::widget cache-aside {}

:::quiz
Q: Why does the reply carry \`as_of\`, and why is it the cached timestamp on a hit rather than the current time?
- [x] So a caller can tell a fresh number from a cached one; stamping the current time would hide the staleness
- [ ] So the client can compute the TTL and refresh the cache itself
- [ ] Because gRPC requires every reply to carry a timestamp
> The whole read path is built on an admitted lie — the number may be up to two seconds old, plus whatever the rollup has not folded yet. \`as_of\` is what keeps the lie honest: it says *when* the number was true, and that only works if it is the compute time, not the read time.
:::

# What to take away

- **The namespace decides, not the request.** One API, two machineries; the caller never picks
  consistency per call, and the validation starts with the namespace because it decides everything else.
- **Status codes are promises.** 200 with a count means the number moved; 202 means it will; 503 means
  the log could not take it in time. Each one is true, and that is what makes a retry safe.
- **A best-effort counter's lifetime is configuration.** \`SET NX EX\` pipelined with \`INCRBY\`: the TTL is
  armed once, at creation, and traffic cannot extend it.
- **Write facts, not numbers.** \`acks=all\`, an idempotent producer and a bounded flush before the 202;
  the client's token travels with the fact.
- **Effectively once lives in the consumer.** Claim \`seen:{token}\` → \`HINCRBY\` → commit. Per-minute
  buckets, because a closed window never changes.
- **Make staleness visible.** Two seconds of cache in front of the rolled-up total, and \`as_of\` so a
  reader knows how old the number is.

The primary source is
[*Netflix's Distributed Counter Abstraction*](https://netflixtechblog.com/netflixs-distributed-counter-abstraction-8d0c45eb66b2)
(Rajiv Shringi, Oleksii Tkachuk, Kartik Sathyanarayanan, 2024): the namespace-configured API, best-effort
counters as TTL-bound cache entries, eventually consistent counters as an idempotency-tokened event log
rolled up in time windows, and the control plane that configures all of it per use case.
`;
