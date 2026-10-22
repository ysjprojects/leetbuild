/**
 * The learning guide for the sliding-window Lua drill: the sorted-set log, why the decision must be
 * one script, the exact retry hint, loading by SHA, and what the log costs against the approximations.
 * Rendered at `/redis-sliding-window-lua/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A **sliding-window log** keeps every admitted call for the last window and counts them before
admitting the next. In Redis that log is a sorted set scored by time, and the decision — trim the
old, count, admit, expire — is one Lua script, so two gateway instances cannot interleave it:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "API callers", "sub": "client_id per request", "x": 10, "y": 50},
    {"id": "limiter", "kind": "service", "label": "limiter", "sub": "allow(client_id, now_ms) · builds key + member", "x": 45, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "sw:{client_id} · the script runs alone", "x": 80, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "limiter", "kind": "plain", "label": "request"},
    {"from": "limiter", "to": "redis", "kind": "redis", "label": "EVALSHA (trim · count · admit · expire)"}
  ]
}
:::

The contract is one function:

\`\`\`text
allow(client_id, now_ms) -> (allowed, retry_after_ms)
LIMIT = 10 calls per WINDOW_MS = 1000, over the sorted set sw:{client_id}
\`\`\`

- The **caller passes the time**; the script never calls \`TIME\`.
- \`KEYS[1]\` is \`sw:{client_id}\`; \`ARGV\` is \`now_ms, WINDOW_MS, LIMIT, member\`.
- The reply is \`{1, 0}\` when admitted, \`{0, retry_after_ms}\` when denied.
- The script is loaded once, at import; every \`allow\` after that is exactly one \`EVALSHA\`.

Stripe, Cloudflare and every API gateway with a per-key quota run a version of this.

# A sorted set is a log the clock trims

A fixed-window counter — \`INCR sw:c7:minute-17\` — lets a client send its whole budget at 17:59.9
and again at 18:00.0: twice the limit in a fifth of a second. The log fixes that by remembering
**when** each call happened, not how many fell in a bucket:

\`\`\`lua
local key = KEYS[1]
local now, window, limit = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)   -- the slide
local count = redis.call('ZCARD', key)                       -- calls still in the window
if count < limit then
  redis.call('ZADD', key, now, member)                       -- this call joins the log
  redis.call('PEXPIRE', key, window)                         -- an idle client costs nothing
  return {1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, tonumber(oldest[2]) + window - now}
\`\`\`

Each line is a sorted-set property doing a job:

| Need | Sorted-set operation | Why it fits |
| --- | --- | --- |
| Forget calls older than the window | \`ZREMRANGEBYSCORE key -inf now-window\` | scores are timestamps; a range by score *is* a range in time |
| Count what is left | \`ZCARD\` | O(1) — the set keeps its size |
| Record this call | \`ZADD key now member\` | O(log n), kept in score order |
| Find the oldest call | \`ZRANGE key 0 0 WITHSCORES\` | rank 0 is the smallest score |
| Drop idle clients | \`PEXPIRE key window\` | after one quiet window nothing in the set can still count |

The **member** matters as much as the score. A sorted set is a set: \`ZADD\` with an existing member
updates its score instead of adding a second entry. Ten calls in one millisecond with the member
\`now_ms\` collapse into **one** — the eleventh is admitted, and the limit leaks exactly under the
burst it exists to stop. So the member is \`"{now_ms}-{nonce}"\` with a random
nonce (\`uuid4\`, \`randomUUID\`): the score carries the time, the member carries nothing but
uniqueness.

Ten calls, a hundred milliseconds apart, then the window slides:

| \`now_ms\` | Trimmed | \`ZCARD\` | Result |
| --- | --- | --- | --- |
| 0 … 900 (ten calls) | — | 0 … 9 | each admitted, \`{1, 0}\` |
| 950 | — | 10 | denied, \`{0, 50}\` — the call at 0 leaves at 1000 |
| 1000 | the member at 0 (score \`<= 0\`) | 9 | admitted |
| 1000 again | — | 10 | denied, \`{0, 100}\` — the call at 100 is now the oldest |

The trim removes scores \`<= now − window\`: a call made exactly one window ago is out, which is
what makes \`retry_after_ms\` honest — come back at the moment it says, and the slot is there.

:::quiz
Q: Two instances both call \`allow("c7", 500)\` in the same millisecond. Why must their members differ?
- [ ] So the two calls can be told apart in a later audit
- [x] Because \`ZADD\` with an existing member replaces it: two calls would count as one and the limit would leak
- [ ] Because Redis rejects a \`ZADD\` whose member already exists
> A sorted set is a set of members. Two calls at score 500 with the member "500" are one member with score 500; the count stays at nine, and the client gets an eleventh call. The nonce is not decoration — it is what makes the log a log.
:::

# Why the decision must be one script

Trim, count, admit are three commands. Sent from the client, they leave two gaps, and a second
gateway instance serving the same client lands in them exactly when it matters — at the edge:

:::sequence
{
  "participants": ["limiter A", "limiter B", "Redis"],
  "messages": [
    {"from": "limiter A", "to": "Redis", "label": "ZREMRANGEBYSCORE sw:c7 -inf -600", "kind": "sync"},
    {"from": "limiter A", "to": "Redis", "label": "ZCARD sw:c7", "kind": "sync"},
    {"from": "Redis", "to": "limiter A", "label": "9", "kind": "reply"},
    {"from": "limiter B", "to": "Redis", "label": "ZREMRANGEBYSCORE sw:c7 -inf -600 · ZCARD sw:c7", "kind": "sync"},
    {"from": "Redis", "to": "limiter B", "label": "9 — A has not added yet", "kind": "reply"},
    {"from": "limiter A", "to": "Redis", "label": "ZADD sw:c7 400 400-a1 — 9 < 10, admit", "kind": "sync"},
    {"from": "limiter B", "to": "Redis", "label": "ZADD sw:c7 400 400-b2 — 9 < 10, admit", "kind": "sync"},
    {"from": "Redis", "to": "limiter B", "label": "the set holds 11 members", "kind": "reply"}
  ]
}
:::

Both read nine; both add; the client gets eleven. Nothing was wrong in either instance — the
count each read was true when it read it. The race is the classic read-modify-write problem: the
value changed between the read and the write that depended on it, and no amount of care on the
client side closes the gap, because the gap is the network.

The same two calls when the whole decision is one \`EVALSHA\`:

:::sequence
{
  "participants": ["limiter A", "limiter B", "Redis"],
  "messages": [
    {"from": "limiter A", "to": "Redis", "label": "EVALSHA sw:c7 now=400 (trim · ZCARD 9 · ZADD · PEXPIRE)", "kind": "sync"},
    {"from": "Redis", "to": "limiter A", "label": "{1, 0}", "kind": "reply"},
    {"from": "limiter B", "to": "Redis", "label": "EVALSHA sw:c7 now=400 (trim · ZCARD 10)", "kind": "sync"},
    {"from": "Redis", "to": "limiter B", "label": "{0, 600} — oldest at 0 leaves at 1000", "kind": "reply"},
    {"from": "limiter B", "to": "Redis", "label": "EVALSHA sw:c7 now=1000 (trim 1 · ZCARD 9 · ZADD)", "kind": "sync"},
    {"from": "Redis", "to": "limiter B", "label": "{1, 0}", "kind": "reply"}
  ]
}
:::

Why a script and not \`MULTI\`/\`EXEC\`:

- Redis runs one script at a time, on the single command thread, and **no other command runs
  until it returns** — the count the script reads is the count it adds to.
- A transaction queues commands and runs them together, but it cannot **branch**: \`ZADD\` only when
  \`ZCARD < limit\` is a decision, and a decision needs the value before the write. \`WATCH\` can
  detect the race and retry; the script simply does not have it.

The price: **a script must be short** — nothing else runs while it does. Five O(log n) commands
over ten members is nothing; a script that loops over a thousand clients stalls everyone. And it
must be **deterministic**: the caller passes \`now_ms\` rather than the script calling \`TIME\`, so
the same arguments do the same thing when the script's effects are replayed on a replica.

:::quiz
Q: Trim, count and add as three client commands admit eleven under a race. Would wrapping the three in \`MULTI\`/\`EXEC\` fix it?
- [ ] Yes — \`EXEC\` runs the three commands atomically
- [x] No — the \`ZADD\` depends on what \`ZCARD\` returns, and a transaction cannot look at a reply before queuing the next command
- [ ] Yes, if both instances share one connection
> MULTI makes the queued commands atomic, but they are chosen before any reply arrives: the client cannot say "ZADD only if the count was under ten". That conditional is the whole limiter, and the only place it can run next to the data is inside a script.
:::

# Retry-after from the oldest member

A denied caller wants one number: how long until a call will be admitted. A fixed-window counter
can only say "until the minute turns". The log knows exactly, because the next slot opens when the
**oldest** member leaves the window:

\`\`\`text
retry_after_ms = oldest_score + WINDOW_MS − now_ms
\`\`\`

\`ZRANGE key 0 0 WITHSCORES\` returns the smallest score in O(log n) — the set is already ordered.
Only the denial path pays for it; an admit returns \`{1, 0}\`.

| The set holds (scores) | \`now_ms\` | Oldest | \`retry_after_ms\` |
| --- | --- | --- | --- |
| 0, 100, …, 900 | 950 | 0 | 50 |
| 0, 100, …, 900 | 400 | 0 | 600 |
| 100, 200, …, 1000 | 1000 | 100 | 100 |
| 0 ×10 (a burst in one millisecond) | 300 | 0 | 700 — and ten slots open at once |

Two properties of the number:

- **Exact, not conservative.** At \`now + retry_after_ms\` the trim removes the oldest member and
  \`ZCARD\` is nine; the retry is admitted — unless another call took the slot first.
- **Never zero on a denial.** The oldest member is at most \`window\` old after the trim, so the
  hint is at least one millisecond; a client that sleeps for it and retries is polite by construction.

Real systems turn the pair into HTTP: \`allowed = false\` becomes **429** with a
[\`Retry-After\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) header
(whole seconds, rounded up). The drill leaves that layer out; the number it returns is what the
header is made from.

:::quiz
Q: The set holds calls at 0, 100, …, 900 and a call at \`now = 950\` is denied. The client waits the 50 ms it was told and retries at 1000. What happens?
- [x] The call at 0 is trimmed (\`0 <= 1000 − 1000\`), the count is nine, the retry is admitted
- [ ] It is denied again, because the trim removes only scores strictly below \`now − window\`
- [ ] It is admitted only if \`PEXPIRE\` has removed the key
> The trim is inclusive: a member scored exactly now − window is out. That is what makes the retry hint exact rather than off by one — the time it names is the first millisecond the slot is open.
:::

# Load once, call by SHA

A script is a few hundred bytes; sending it with every \`EVAL\` on a limiter that runs on every
request is bandwidth and parsing for nothing. Redis caches every script it has seen under the
SHA-1 of its body, and [\`EVALSHA\`](https://redis.io/docs/latest/commands/evalsha/) runs it by that
hash:

\`\`\`text
SCRIPT LOAD "local key = KEYS[1] ..."        → "a7f3…"      once, at import
EVALSHA a7f3… 1 sw:c7 400 1000 10 400-9d1e   → [1, 0]      every allow
EVALSHA a7f3… 1 sw:c7 400 1000 10 400-9d1e   → NOSCRIPT    after a restart or FLUSHSCRIPT
EVAL "local key = KEYS[1] ..." 1 sw:c7 …     → [1, 0]      the fallback re-caches it
\`\`\`

- \`register_script\` (redis-py), \`defineCommand\` (ioredis), \`redis.NewScript\` (go-redis) and their
  peers do this dance: try \`EVALSHA\`, on \`NOSCRIPT\` send \`EVAL\` with the body. Loaded once at
  module level, every \`allow\` after the first is **exactly one round trip**.
- **1 key, then the arguments.** The key count tells Redis which arguments are keys; in a cluster
  that is how it routes the call to the node that owns \`sw:{client_id}\`.
- \`ARGV\` arrives as strings. \`tonumber\` every value you do arithmetic on; \`count < limit\` with
  \`limit\` a string compares the wrong way.
- The reply is an array of integers: \`{1, 0}\` → \`[1, 0]\`; the client turns the first into a bool.

:::details The braces in sw:{client_id} are a cluster feature
In Redis Cluster the part of a key between the first \`{\` and \`}\` is its
[hash tag](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags):
only that part is hashed to pick the slot. \`sw:{c7}\` and \`quota:{c7}\` land on one node, so a script
that reads both can declare both keys and still run — the shape a second, coarser limit per client
would need.
:::

:::quiz
Q: Redis restarts overnight. The limiter's next \`allow\` sends \`EVALSHA\` with the SHA it loaded at import. What should happen?
- [ ] The request is denied: no script means no decision
- [x] Redis answers \`NOSCRIPT\`; the client library sends \`EVAL\` with the body, which re-caches it, and the call succeeds
- [ ] The limiter must be restarted so its import-time load runs again
> The script cache is in memory and does not survive a restart. The EVAL fallback is the standard recovery — one extra round trip, once per node, then back to EVALSHA. A limiter that cannot recover from NOSCRIPT turns a Redis restart into an outage of every endpoint it guards.
:::

# What a log costs, and the approximations

The log is exact because it keeps every call. That is also its cost: memory per client is **one
member per admitted call in the window**, and it is held in Redis, not on the gateway.

| Limit | Members per busy client | Set memory (member ≈ 50 bytes + overhead) |
| --- | --- | --- |
| 10 per second (this drill) | 10 | about 1 KB |
| 1,000 per minute | 1,000 | about 100 KB |
| 10,000 per hour | 10,000 | about 1 MB |

- A member is \`"{now_ms}-{nonce}"\` — a 13-digit timestamp and a 32-character hex nonce. Small sets
  live in a compact listpack; past 128 members Redis switches to a skiplist plus a hash.
- \`ZADD\` and the trim are O(log n) per call, but a trim after a quiet spell removes thousands of
  members in one command — inside a script, with nothing else running.
- \`PEXPIRE window\` after each admit means an idle client's set vanishes one window after its last
  call: a million clients that each called once a day cost nothing between calls.

When the window holds thousands of calls, the standard trade is the **sliding-window counter**
Cloudflare described in
[*How we built rate limiting capable of scaling to millions of domains*](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/):
two fixed counters — the previous window and the current one — and a weighted estimate:

\`\`\`text
rate ≈ previous_count × (window − elapsed_in_current) / window + current_count

previous minute: 42 calls   current minute: 18 calls   15 s into it
rate ≈ 42 × (60 − 15) / 60 + 18 = 49.5
\`\`\`

The estimate assumes the previous window's calls were evenly spread; Cloudflare measured 0.003% of
400 million requests wrongly allowed or denied. Two integers per client instead of a log, and no
\`retry_after_ms\` worth the name.

| | Fixed window | Sliding log (this drill) | Sliding counter |
| --- | --- | --- | --- |
| Memory per client | one counter | one member per call in the window | two counters |
| Exact? | no — double budget at the boundary | yes, at any instant | approximate, assumes even spread |
| Retry hint | "at the boundary" | exact, from the oldest member | an estimate |
| Redis commands | \`INCR\` + \`EXPIRE\` | one script | one script over two keys |

At ten per second the log is ten members and exactness is cheap, so the drill keeps it. Real
systems add a second, coarser limit per client, weighted calls, and a decision for when Redis is
unreachable — most **fail open**: a limiter that denies everyone is worse than a minute without one.

:::quiz
Q: A limit of 5,000 calls per hour per client. Why would a team choose the sliding counter over the log?
- [ ] The log cannot represent a window longer than a minute
- [x] The log holds up to 5,000 members per client in Redis; two counters cost a few bytes and are wrong by a fraction of a percent
- [ ] The counter gives a more precise \`retry_after_ms\`
> At that scale the log's exactness is paid in megabytes per active client and in trims that remove thousands of members at once. The weighted two-counter estimate is within 0.003% in Cloudflare's measurement — close enough for a quota, and the memory is constant.
:::

# What to take away

- **A sorted set scored by time is a log the clock can trim.** \`ZREMRANGEBYSCORE\` is the slide,
  \`ZCARD\` the count, \`ZRANGE 0 0\` the oldest call; \`PEXPIRE\` makes idle clients free.
- **The whole decision runs inside Redis.** Three client commands are two gaps for another
  instance to land in; a script runs alone, so the count it reads is the count it adds to.
- **A set is a set.** The member is \`now_ms\` plus a nonce, or a burst in one millisecond becomes one
  entry and the limit leaks exactly when it matters.
- **Denials carry an exact retry.** \`oldest + window − now\` is the first millisecond the slot opens,
  because the trim is inclusive.
- **Load once, call by SHA, expect a cache miss.** One round trip per call; the \`EVAL\` fallback on
  \`NOSCRIPT\` is what survives a restart.
- **Exactness costs a member per call.** When the window holds thousands, two weighted counters
  are within a fraction of a percent for a few bytes.

The primary reference is Redis's own
[*Scripting with Lua*](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/):
how \`EVAL\` and \`EVALSHA\` run, why scripts are atomic, what \`KEYS\` and \`ARGV\` are for, and the
determinism rules that let a script's effects replicate.
`;
