/**
 * The learning guide for the fixed-window rate limit: the one Redis pattern every other limiter is
 * compared against — where the window lives, why the count is an INCR and not a GET/SET, what the
 * TTL is for, and the boundary burst it knowingly lets through. A figure per idea, a pop quiz per
 * section. Rendered at `/redis-fixed-window-limit/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A **fixed-window rate limit** cuts time into equal windows, gives every client one counter per
window, and admits a request while that counter is at or below a limit. It is the limiter Redis's own
documentation uses to introduce \`INCR\`, and the default policy in API gateways — Kong, Envoy's
local rate limit, GitHub's REST quotas — because it costs one round trip per request and stays correct
across any number of gateway workers.

:::diagram
{
  "nodes": [
    {"id": "clients", "kind": "client", "label": "clients", "sub": "alice · bob · … · one counter each", "x": 8, "y": 50},
    {"id": "gateway", "kind": "service", "label": "API gateway", "sub": "allow(client_id) on every request · N workers", "x": 38, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "rl:{client_id}:{window} · TTL 60 · single-threaded", "x": 76, "y": 50}
  ],
  "edges": [
    {"from": "clients", "to": "gateway", "kind": "http", "label": "requests"},
    {"from": "gateway", "to": "redis", "kind": "redis", "label": "INCR · EXPIRE on 1 · TTL when full"}
  ]
}
:::

The whole contract is one function:

\`\`\`text
allow(client_id) -> (allowed, retry_after_s)

LIMIT    = 100            requests per client per window
WINDOW_S = 60             seconds
window   = now // WINDOW_S
key      = rl:{client_id}:{window}
\`\`\`

- \`INCR key\` and keep the number it returns. **1** means this request created the key: \`EXPIRE key 60\`
  now, and never touch the TTL again.
- Count \`<= LIMIT\` → \`(True, 0)\`. Count above it → \`(False, ttl)\`, where \`ttl\` is \`TTL key\` clamped to
  at least 1 — the number the caller puts in \`Retry-After\`.
- No \`GET\`, no \`SET\`, no reset, no sweeper, no list of timestamps, no Lua.

# The window lives in the key name

A limiter that stored one counter per client would have to *reset* it every minute — a scheduled job,
a stored window start, or a compare-and-reset on every request, each a place for two workers to
disagree. The fixed-window pattern stores no window start at all: the window number is part of the key,
so a new minute is simply a **new key that starts from nothing**.

\`\`\`python
window = int(time.time() // WINDOW_S)      # 1 792 599 // 60 = 29876
key = f"rl:{client_id}:{window}"           # rl:alice:29876
\`\`\`

| Clock (s since epoch) | \`now // 60\` | Key for alice | Count after this request |
| --- | --- | --- | --- |
| 1 792 560 | 29876 | \`rl:alice:29876\` | 1 — key created, TTL armed |
| 1 792 577 | 29876 | \`rl:alice:29876\` | 101 — denied, TTL 43 |
| 1 792 619 | 29876 | \`rl:alice:29876\` | 140 — still denied, TTL 1 |
| 1 792 620 | 29877 | \`rl:alice:29877\` | 1 — a fresh window, allowed again |

Properties that follow from putting the window in the name:

- **Nothing is ever reset.** Integer division gives every worker the same window number from its own
  clock; no worker has to notice the minute rolling over, because the next \`INCR\` lands on a key
  that does not exist yet and Redis creates it at \`0\` before adding one.
- **Every worker agrees.** A hundred gateway processes computing \`now // 60\` get the same key for the
  same client, so they share one count without ever talking to each other.
- **Old windows are garbage.** \`rl:alice:29876\` is never read again once the clock says 29877; the
  TTL set on its first hit removes it a minute after it was born, whatever happened in between.
- **One client, one key.** \`rl:{client_id}:{window}\` — with bob's window full, alice's first call of
  the minute still lands in her own key at \`1\` and is allowed; a shared counter would let one noisy
  client deny everyone.

The windows are aligned to the clock, not to the client's first request: everyone's window ends at the
same multiple of sixty seconds. That alignment is what makes the key name computable without state —
and, as the last section shows, it is also where the pattern's one weakness comes from.

:::quiz
Q: Why is the window number in the key, rather than a counter per client that is reset every minute?
- [x] So no worker ever has to reset anything: the next minute is a key that does not exist yet
- [ ] Because Redis keys cannot be set back to zero
- [ ] To make the key shorter
> A reset is a read-modify-write with a clock in it — two workers can both decide it is time, or neither can. A key named after the window is created at zero by the first INCR that touches it, on whichever worker that happens to be, and the old key is simply left to expire.
:::

# INCR is a count; GET then SET is a race

The number of requests in a window is maintained by many gateway workers at once, and the obvious
code — read the count, add one, write it back — loses updates under exactly that load. Two workers
both read 99, both write 100, and one request was never counted; the client gets 101 through, or
more. The step's race check is precisely this: a second worker's request lands right after the first
worker's read.

:::sequence
{
  "participants": ["worker A", "worker B", "Redis"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "GET rl:alice:29876", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "\\"99\\"", "kind": "reply"},
    {"from": "worker B", "to": "Redis", "label": "GET rl:alice:29876", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "\\"99\\"", "kind": "reply"},
    {"from": "worker A", "to": "Redis", "label": "SET rl:alice:29876 100 — 100 ≤ 100, allowed", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "SET rl:alice:29876 100 — 100 ≤ 100, allowed", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "OK — the key says 100; two requests used one slot", "kind": "reply"}
  ]
}
:::

\`INCR\` moves the read-modify-write **onto the server**. Redis executes commands one at a time on a
single thread, so two concurrent \`INCR\`s on one key are serialised by construction: one returns 100,
the other 101, and nobody needed a lock.

:::sequence
{
  "participants": ["worker A", "worker B", "Redis"],
  "messages": [
    {"from": "worker A", "to": "Redis", "label": "INCR rl:alice:29876", "kind": "sync"},
    {"from": "worker B", "to": "Redis", "label": "INCR rl:alice:29876", "kind": "sync"},
    {"from": "Redis", "to": "worker A", "label": "100 → 100 ≤ 100, (true, 0)", "kind": "reply"},
    {"from": "Redis", "to": "worker B", "label": "101 → 101 > 100, deny", "kind": "reply"},
    {"from": "worker B", "to": "Redis", "label": "TTL rl:alice:29876", "kind": "sync"},
    {"from": "Redis", "to": "worker B", "label": "43 → (false, 43)", "kind": "reply"}
  ]
}
:::

The return value is the whole protocol — one number says everything the worker needs to know:

| \`INCR\` returned | Meaning | What the worker does |
| --- | --- | --- |
| \`1\` | this request created the key | \`EXPIRE key 60\`, then allow |
| \`2 … 100\` | inside the limit | allow, \`(True, 0)\` |
| \`101\` and above | window full | \`TTL key\`, deny with \`(False, max(ttl, 1))\` |

- **Count first, decide after.** The deny path still increments: a client hammering a full window
  drives the count to 140, 500, 5000 — harmless, the key expires with the window, and the count
  doubles as a record of how hard they pushed.
- **No lock, no transaction.** \`MULTI\`/\`EXEC\` around \`GET\` and \`SET\` would not help either: the
  \`SET\` value is computed on the client from a stale read. Atomicity has to include the arithmetic,
  and \`INCR\` is arithmetic on the server.
- **One round trip on the allow path**, two on the deny path. There is nothing cheaper that is also
  correct under concurrency.

:::quiz
Q: Two gateway workers handle alice's requests 100 and 101 in the same millisecond. What makes the limiter deny exactly one of them?
- [ ] Each worker takes a lock on the key before reading it
- [x] Both send INCR; Redis runs them one after the other and returns 100 to one worker and 101 to the other
- [ ] The workers share the count through their own memory
> Redis is single-threaded for command execution, so two INCRs on one key cannot interleave. The server hands back two different numbers and each worker compares its own against LIMIT. With GET and SET both workers would read 99, both write 100, and both would allow.
:::

# The TTL is the window's lifetime — and the Retry-After

Without a TTL every client that ever made a request would leave one key per minute behind forever.
The pattern gives each key a lifetime equal to the window on the hit that creates it:

\`\`\`text
n = INCR rl:alice:29876         → 1
if n == 1: EXPIRE rl:alice:29876 60
\`\`\`

[\`EXPIRE\`](https://redis.io/docs/latest/commands/expire/) is set **once**, on the \`1\`, and later hits
leave it alone. Re-arming it on every request would keep a busy client's key alive indefinitely and
extend nothing useful: the key is already unreachable the moment the clock moves to the next window
number. Arming it once gives the key the window's natural lifetime, give or take the few seconds
between the window's start and the client's first request.

The TTL also answers the question the caller asks on a deny — *when may I try again?* — for free:

| Moment in the window | \`INCR\` returned | \`TTL\` | Answer |
| --- | --- | --- | --- |
| 0 s — first request | 1 | 60 (just armed) | \`(True, 0)\` |
| 17 s — request 101 | 101 | 43 | \`(False, 43)\` |
| 30 s — ten more hits | 111 | 30 (not re-armed) | \`(False, 30)\` |
| 59.6 s — last second | 140 | 0 | \`(False, 1)\` — clamped |
| 60 s — new window | 1 | 60 | \`(True, 0)\` |

- **TTL on the deny path only.** The allow path stays at one command; the extra round trip is paid by
  the clients who are over the limit.
- **Clamp to at least 1.** In the window's last second \`TTL\` returns \`0\`; a client told to wait zero
  seconds retries immediately, inside the same window, and is denied again. \`max(ttl, 1)\` costs
  nothing and ends that loop.
- **Retry-After is the handshake.** The HTTP response — \`429 Too Many Requests\`, outside this drill —
  carries the seconds in a
  [\`Retry-After\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) header, and a
  well-behaved client sleeps that long instead of polling. The limiter's number is exact because it is
  the key's remaining life, not an estimate.

:::details The gap between INCR and EXPIRE
\`INCR\` and \`EXPIRE\` are two commands. If the worker crashes, or the connection drops, between
them, the key exists with value \`1\` and **no TTL** — and since every later hit returns a number above
1, nobody will ever arm it. The client's count for that window number then lives forever, which is
harmless for alice this minute (29876 never comes back) but is a key that is never freed. Real systems
close the gap one of two ways: a
[Lua script](https://redis.io/docs/latest/develop/programmability/eval-intro/) that runs \`INCR\` and
the conditional \`EXPIRE\` as one atomic step, or
[\`SET key 0 EX 60 NX\`](https://redis.io/docs/latest/commands/set/) before the \`INCR\` so the key is born
with its TTL. The drill keeps the two-command form because it is the shape every reference describes;
the race it cares about is the one between workers, not the one between a worker and its own crash.
:::

:::quiz
Q: Why is EXPIRE sent only when INCR returns 1, and not on every request?
- [ ] Because EXPIRE on an existing key is an error
- [x] Re-arming the TTL on every hit would keep a busy client's key alive past its window, while the window itself still ends at the next multiple of 60
- [ ] Because EXPIRE is slower than INCR
> The window boundary is decided by the key name, not the TTL; the TTL only exists to free the key afterwards and to tell a denied client how long is left. Resetting it on every hit makes the second answer wrong and the first job never finish for a client that keeps requesting.
:::

# Fixed windows and the boundary burst

The pattern's one documented weakness is in its name. Windows are aligned to the clock, so a client
can spend a full allowance at the end of one window and another at the start of the next:

| Clock | Window | Requests | Count | Result |
| --- | --- | --- | --- | --- |
| 0:00 – 0:58 | 29876 | 0 | 0 | — |
| 0:59 | 29876 | 100 | 100 | all allowed |
| 1:00 | 29877 | 100 | 100 | all allowed — new key |
| 1:01 – 1:59 | 29877 | 1 | 101 | denied, TTL 59 |

Two hundred requests in two seconds, against a limit that says "100 per minute", and the limiter was
not wrong by its own definition: each *window* saw exactly 100. Over any sixty seconds that straddle a
boundary, up to **twice the limit** can get through. Everything else about the pattern is a strength;
this is the trade it makes for being one command.

Whether that matters depends on the resource: a tenant quota or a billing tier usually tolerates it,
a backend that falls over at 150 requests a second does not. When it does matter, the alternatives
tighten the bound at the cost of more state or more commands:

| Limiter | State per client | Bound over any 60 s | Cost per request |
| --- | --- | --- | --- |
| Fixed window (this drill) | one counter per window | up to 2 × LIMIT at a boundary | 1 command (2 on deny) |
| Sliding window | counters for this and the previous window, weighted by overlap | ≈ LIMIT, within a few percent | 2 reads + 1 INCR, or a Lua script |
| Sliding log | a sorted set of timestamps | exactly LIMIT | ZADD + ZREMRANGEBYSCORE + ZCARD, memory ∝ LIMIT |
| Token bucket | tokens + last refill time | LIMIT plus a configured burst, smoothed | a Lua script for the refill arithmetic |

The sliding-window approximation is the one Cloudflare runs at their edge — their
[*How we built rate limiting capable of scaling to millions of domains*](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
post is the standard explanation: weight the previous window's count by how much of the sliding
minute still lies in it, add the current window's. The key naming, the \`INCR\` and the TTL are
unchanged; it is this pattern with one more read. The token bucket is a different shape: it meters a
*rate* with a burst allowance rather than counting per interval.

:::widget token-bucket {"rate": 100, "burst": 100}

:::quiz
Q: A limiter is set to 100 per minute with fixed windows. What is the most a single client can get through in the 60 seconds from 0:30 to 1:30?
- [ ] 100 — that is the limit
- [x] 200 — 100 in window 0:00–0:59 and 100 in window 1:00–1:59, both counted from zero
- [ ] 150 — the second window starts half full
> Each window has its own key that starts at zero at the boundary, so the limiter enforces 100 per aligned window, not 100 per any sixty seconds. A sliding window closes most of that gap by weighting the previous window's count; the fixed window accepts it in exchange for one command per request.
:::

# What production adds around the one command

The drill is the core that every gateway's limiter wraps. The pieces real systems add change nothing
in the three ideas — key name, server-side count, TTL — but they decide how the limiter is operated:

- **The HTTP surface.** \`429 Too Many Requests\` with \`Retry-After: {retry_after_s}\`, and usually
  \`X-RateLimit-Limit\` / \`X-RateLimit-Remaining\` on allowed responses so clients can pace themselves
  before they hit the wall. \`Remaining\` is just \`LIMIT - n\` from the number \`INCR\` returned.
- **More dimensions in the key.** Per route (\`rl:{client}:{route}:{window}\`), per plan with a
  different \`LIMIT\` per tier, per IP for unauthenticated traffic. The key template is the policy; the
  commands stay the same.
- **Several windows at once.** A per-second limit for burst and a per-hour quota for volume — two
  \`INCR\`s on two keys with two TTLs, deny if either is over.
- **Closing the INCR/EXPIRE gap** with a Lua script or \`SET … EX NX\`, as the aside above describes.
- **Failing open or closed.** When Redis is unreachable the gateway must choose: admit everything
  (protect availability, lose the limit) or deny everything (protect the backend, lose the API).
  Most gateways fail open for a limiter and fail closed for a quota that is billed.
- **A local pre-filter.** Envoy's local rate limit and Kong's \`local\` policy count in each worker's
  memory first — zero round trips, but N workers means N × LIMIT, which is why the shared Redis counter
  is the policy of record and the local one is only a shield against floods.

:::quiz
Q: A gateway with 20 workers switches from a shared Redis counter to counting in each worker's memory. What happens to the effective limit?
- [ ] Nothing — each worker sees the same requests
- [x] It becomes up to 20 × LIMIT, because each worker counts only the requests routed to it
- [ ] It becomes LIMIT ÷ 20
> A load balancer spreads one client's requests across workers; each worker's private counter sees a fraction of them and allows up to LIMIT on its own. The shared key in Redis is what makes the count a count of the client's requests rather than of one worker's share.
:::

# What to take away

- **The window is in the key name.** \`rl:{client_id}:{now // 60}\` — a new minute is a new key that
  starts at zero; nothing is ever reset, and every worker computes the same key from its own clock.
- **The server does the counting.** One \`INCR\`, serialised by Redis, returns a number no other worker
  can also have received; \`GET\` then \`SET\` loses updates the moment two workers overlap.
- **The TTL is set once, on the 1.** It frees the key a window after it was born, and its remaining
  value is the exact \`Retry-After\` for a denied caller — clamped to 1 so nobody retries in the same
  second.
- **One key per client**, never a shared counter; more dimensions in the key template are how real
  policies are expressed.
- **The boundary burst is the price.** Up to twice the limit across an aligned boundary; a sliding
  window or a token bucket buys a tighter bound with more state or a Lua script.

The primary reference is the Redis
[\`INCR\` command page](https://redis.io/docs/latest/commands/incr/), whose *Pattern: Rate limiter*
section describes this exact algorithm — the per-client, per-second key, the \`EXPIRE\` on the first
hit, the race between \`INCR\` and \`EXPIRE\` — and then shows the Lua and \`MULTI\` variants that close it.
`;
