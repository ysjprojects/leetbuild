/**
 * The learning guide for the token-bucket drill: what a token bucket is, why its refill is computed
 * from timestamps rather than by a timer, why refill and spend must be one Lua script, the wait-time
 * formula, the one-refill TTL and the float-reply pitfall — a figure or a demo where one says it faster
 * than prose, a pop quiz per section. Rendered at `/redis-token-bucket-lua/learn`.
 */
export const learn = `# The mechanism at a glance

A **token bucket** holds up to \`CAPACITY\` tokens and earns \`RATE\` tokens a second. A request spends
\`cost\` tokens if they are there and is refused if they are not. The bucket allows a burst up to its
capacity and a sustained flood only at \`RATE\` — the shape behind every API gateway's rate limit, per-tenant
job admission and outbound-call budgets. Shared across many servers, the bucket lives in Redis and the
decision is one script:

:::diagram
{
  "nodes": [
    {"id": "service", "kind": "service", "label": "API servers", "sub": "take(bucket, cost, now_ms) · pass the clock in", "x": 25, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "tb:{bucket} · tokens · updated_ms", "x": 70, "y": 50}
  ],
  "edges": [
    {"from": "service", "to": "redis", "kind": "redis", "label": "EVAL (refill · take · HSET · PEXPIRE)"}
  ]
}
:::

The contract the drill implements:

- \`take(bucket, cost, now_ms)\` → \`(allowed, tokens_left, wait_ms)\`, with \`RATE = 5\` and \`CAPACITY = 20\`.
- The state is one hash, \`tb:{bucket}\`, with two fields: \`tokens\` and \`updated_ms\`. A missing hash is a
  **full** bucket.
- One \`EVAL\` per call does everything: read the hash, refill from \`now_ms − updated_ms\`, allow or deny,
  write both fields back, \`PEXPIRE\` the key for 4000 ms. The client sends no hash command and does no
  arithmetic.
- The script never calls \`TIME\`; the caller's clock arrives as an argument.

# Rate, capacity, burst

The [token bucket](https://en.wikipedia.org/wiki/Token_bucket) comes from network traffic shaping,
where it polices a link's average rate while letting short bursts through. Two numbers describe it,
and each answers one question:

| Number | In the drill | What it bounds |
| --- | --- | --- |
| \`RATE\` | 5 tokens per second | the **sustained** throughput: over any long window, at most 5 per second |
| \`CAPACITY\` | 20 tokens | the **burst**: how many can go through at one instant from a full bucket |
| \`CAPACITY / RATE\` | 4 s | how long an idle bucket takes to refill completely — the memory of the limiter |

- A fixed window of "100 per minute" lets 200 through in the two seconds around the minute boundary; a
  bucket cannot, because the burst is bounded by what it holds, not by where the clock's minute falls.
- A bucket of capacity 1 is a pure rate: one request every 200 ms, no burst at all. A bucket of
  capacity 20 forgives a client that was quiet for four seconds and then sends twenty at once.
- \`cost\` need not be 1. A heavy endpoint spends 3; the bucket charges by work, not by request count.

Fill a bucket and empty it:

:::widget token-bucket {"rate": 5, "burst": 20}

:::quiz
Q: A client is silent for an hour, then sends 100 requests in one millisecond. With RATE 5 and CAPACITY 20, how many get through?
- [ ] 5, one second's worth
- [x] 20, then the rest are denied until tokens come back at 5 per second
- [ ] 100, because an hour of silence banked 18,000 tokens
> The bucket is capped at CAPACITY: silence fills it, it does not overflow it. Twenty go through at once, the twenty-first waits 200 ms, and the long-run rate is 5 per second.
:::

# Lazy refill: the clock is the ticker

The textbook bucket has a process adding one token every \`1 / RATE\` seconds. For a million tenants that
is a million timers, or one timer walking a million keys, most of them idle. Nothing in the drill ticks.
The bucket remembers *when it was last right*, and every decision begins by moving it to now:

\`\`\`text
tokens = min(CAPACITY, tokens + (now_ms − updated_ms) × RATE / 1000)
updated_ms = now_ms
\`\`\`

Tokens are fractional and the refill is continuous: 300 ms earns 1.5, not 0 or 1. An empty bucket, a
unit take every 300 ms:

| Call | Elapsed | Refilled to | Take 1? | Written back |
| --- | --- | --- | --- | --- |
| 1 | — (new key) | 20 (missing hash = full) | yes → 19 | \`tokens 19\`, \`updated_ms now\` |
| … | 0 ms each | 19, 18 … 1 | yes → 0 | \`tokens 0\` |
| 21 | 0 ms | 0 | no, wait 200 ms | \`tokens 0\` — nothing taken |
| 22 | 300 ms | 0 + 1.5 = 1.5 | yes → 0.5 | \`tokens 0.5\` |
| 23 | 300 ms | 0.5 + 1.5 = 2.0 | yes → 1.0 | \`tokens 1.0\` |
| 24 | 100 s | min(20, 1 + 500) = 20 | yes → 19 | \`tokens 19\` |

Three properties fall out of the formula:

- **Idle costs nothing.** A bucket nobody calls is a hash nobody touches; the refill is computed when
  someone asks and is exact for any gap, 300 ms or a week.
- **A denial still banks the refill.** Call 21 computed a refill (of zero, as it happens) and wrote
  \`updated_ms = now\` back. Had it not, call 22 would refill from call 20's timestamp — the same tokens
  twice if the two calls had different gaps. The write-back is unconditional: it sits *after* the branch.
- **The clock is an input.** The caller passes \`now_ms\`; the script is a pure function of
  \`(tokens, updated_ms, cost, now_ms)\`. The same call with the same arguments gives the same answer
  on a replica, in a replayed log, and in a test that owns its clock — none of which is true of a script
  that reads Redis's \`TIME\`.

:::details Whose clock, then?
A script that calls \`TIME\` is not deterministic, which is why Redis historically forbade writes after
it in scripts and today replicates scripts by their *effects* rather than re-running them. Passing
the clock in moves the nondeterminism to the caller, where it was anyway. The price: two servers with
clocks 50 ms apart will refill slightly differently, and a caller with a clock *behind* the stored
\`updated_ms\` computes a negative elapsed time — the \`min(CAPACITY, …)\` does not protect against
that, and real limiters clamp the gap at zero. The drill's harness drives one clock, so the question
does not arise there.
:::

:::quiz
Q: Why does a denied take still HSET the hash?
- [ ] So the key's TTL is renewed, otherwise it would expire mid-burst
- [x] Because the refill it computed moved updated_ms forward; without the write the next call refills the same interval again
- [ ] It does not need to; the drill writes back only for symmetry
> The refill is a function of the stored timestamp. Compute it, discard it, and the next caller computes it again from the old timestamp — earning the same tokens twice. Writing back on every path is what makes the lazy refill exact.
:::

# Why refill and spend must be one script

The obvious implementation does the arithmetic in the application: \`HMGET\`, compute, \`HSET\`. On one
server it works. On two, both can read the same last token:

:::sequence
{
  "participants": ["server A", "server B", "Redis"],
  "messages": [
    {"from": "server A", "to": "Redis", "label": "HMGET tb:ana tokens updated_ms", "kind": "sync"},
    {"from": "Redis", "to": "server A", "label": "{\\"1\\", \\"…\\"} — one token left", "kind": "reply"},
    {"from": "server B", "to": "Redis", "label": "HMGET tb:ana tokens updated_ms", "kind": "sync"},
    {"from": "Redis", "to": "server B", "label": "{\\"1\\", \\"…\\"} — the same token", "kind": "reply"},
    {"from": "server A", "to": "server A", "label": "1 ≥ 1 → allowed, tokens = 0", "kind": "sync"},
    {"from": "server B", "to": "server B", "label": "1 ≥ 1 → allowed, tokens = 0", "kind": "sync"},
    {"from": "server A", "to": "Redis", "label": "HSET tb:ana tokens 0", "kind": "sync"},
    {"from": "server B", "to": "Redis", "label": "HSET tb:ana tokens 0 — two spends, one token", "kind": "sync"}
  ]
}
:::

A pipeline does not help — \`HMGET\` and \`HSET\` are still two commands with a gap between them that
another client can fill. \`MULTI\`/\`EXEC\` does not help either: the compare happens in the application,
and a transaction cannot branch on what it reads. \`WATCH\` would turn the race into a retry loop. The
tool for *read, compute, branch, write* as one indivisible step is a
[Lua script](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/): Redis runs it
on its single command thread, and no other command touches the key until it returns.

:::sequence
{
  "participants": ["server A", "server B", "Redis"],
  "messages": [
    {"from": "server A", "to": "Redis", "label": "EVAL take · tb:ana · rate 5 · capacity 20 · cost 1 · now · ttl 4000", "kind": "sync"},
    {"from": "server B", "to": "Redis", "label": "EVAL take · tb:ana · cost 1 · now — queued behind A", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "A: HMGET → 1 · refill → 1 · 1 ≥ 1 → 0 · HSET · PEXPIRE", "kind": "sync"},
    {"from": "Redis", "to": "server A", "label": "{1, \\"0\\", 0}", "kind": "reply"},
    {"from": "Redis", "to": "Redis", "label": "B: HMGET → 0 · refill → 0 · 0 < 1 · HSET · PEXPIRE", "kind": "sync"},
    {"from": "Redis", "to": "server B", "label": "{0, \\"0\\", 200}", "kind": "reply"}
  ]
}
:::

The script itself is short — the whole limiter is twenty lines, and every line runs with the key to
itself:

\`\`\`lua
local rate, capacity = tonumber(ARGV[1]), tonumber(ARGV[2])
local cost, now, refill_ms = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated_ms')
local tokens, updated = tonumber(bucket[1]), tonumber(bucket[2])
if tokens == nil then tokens, updated = capacity, now end
tokens = math.min(capacity, tokens + (now - updated) * rate / 1000)
local allowed, wait = 0, 0
if cost > capacity then wait = -1
elseif tokens >= cost then tokens = tokens - cost; allowed = 1
else wait = math.ceil((cost - tokens) * 1000 / rate) end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_ms', now)
redis.call('PEXPIRE', KEYS[1], refill_ms)
return {allowed, tostring(tokens), wait}
\`\`\`

- \`KEYS[1]\` is the hash; the constants, the cost, the clock and the TTL are \`ARGV\`. Naming the key in
  \`KEYS\` is what lets a cluster route the script to the right node.
- One round trip per decision, whatever the outcome. The limiter's cost is one \`EVAL\` on the request
  path, which is why it can sit in front of every call a gateway serves.
- Real systems send the script once with \`SCRIPT LOAD\` and call it by hash with \`EVALSHA\`, falling
  back to \`EVAL\` on \`NOSCRIPT\` after a restart. The drill sends the body every time; the semantics are
  identical.

:::quiz
Q: Two servers share a bucket with one token left and call take(cost=1) at the same instant. What must happen?
- [x] Exactly one is allowed, the other is denied with a wait, and the hash ends at 0
- [ ] Both are allowed; a one-token overspend is within tolerance
- [ ] Both are denied; the conflict is resolved by retrying
> Redis runs one script at a time. The second script's HMGET sees the first script's HSET, so it finds 0 tokens and answers a wait of 200 ms. No lock, no retry, no overspend.
:::

# The wait-time formula

A limiter that only says *no* makes every client guess. The bucket knows exactly when *yes* becomes
possible, because the refill is linear in time:

\`\`\`text
wait_ms = ceil((cost − tokens) × 1000 / RATE)       when tokens < cost ≤ CAPACITY
wait_ms = -1                                          when cost > CAPACITY
wait_ms = 0                                           when allowed
\`\`\`

| Tokens held | Cost | Shortfall | Wait at 5 tokens/s |
| --- | --- | --- | --- |
| 0 | 1 | 1 | 200 ms |
| 0 | 3 | 3 | 600 ms |
| 0.5 | 1 | 0.5 | 100 ms |
| 1.0 | 3 | 2 | 400 ms |
| 20 | 21 | — | \`-1\`: never, nothing taken, bucket still written back |

- **Ceiling, not rounding.** A client that sleeps \`wait_ms\` and retries must find the tokens there;
  rounding down would send it back 1 ms early to be denied again.
- **Nothing is taken on a denial.** The bucket does not go negative and the shortfall is not debited.
  Some limiters do allow debt (a large request goes through and the bucket recovers from below zero);
  this one does not, which keeps \`tokens_left\` meaningful as "what a smaller request can have now".
- **Never is a different answer from "a long time".** A cost of 21 in a bucket of 20 will never fit;
  reporting 200 ms would send the client into a retry loop forever. The check is on \`cost > CAPACITY\`,
  before the refill matters, and it still writes the bucket back like every other path.
- A gateway turns the three return values into headers: \`wait_ms\` becomes
  [\`Retry-After\`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After) on a 429,
  \`tokens_left\` becomes \`X-RateLimit-Remaining\`. The drill stops at the three numbers.

:::quiz
Q: A bucket holds 0.5 tokens and a request costs 3. What should wait_ms be?
- [ ] 600 — the cost in milliseconds at 5 per second
- [x] 500 — ceil((3 − 0.5) × 1000 / 5)
- [ ] -1 — fractional tokens cannot satisfy an integer cost
> The wait is for the shortfall, not the whole cost: 2.5 tokens at 5 per second is 500 ms. Fractional tokens are real tokens; they count toward the next request.
:::

# The small print: expiry and the float reply

Two details separate a bucket that works in a test from one that works in production.

**The key may expire after one full refill.** Every call ends with \`PEXPIRE tb:{bucket} 4000\` —
\`CAPACITY / RATE × 1000\` ms. The argument is exact, not approximate:

- A bucket idle for 4 s has, by the refill formula, \`min(20, tokens + 4 × 5) = 20\` tokens whatever it
  held — it is full.
- A missing hash is defined as a full bucket.
- So a key that disappears after 4 s of idleness is indistinguishable from one that stayed: the next
  caller finds "nothing", starts at 20, and gets the same answer it would have computed from the stale
  fields. The bucket never looks *less* than full because the key went.
- Every take renews the TTL, so an active bucket is never evicted mid-burst, and a limiter for a
  million occasional tenants holds keys only for the ones seen in the last four seconds.

Expire it any sooner and a client that spent its burst gets a fresh one early; later and idle keys pile
up for nothing.

**A Lua float reaching Redis is truncated.** The script returns \`{allowed, tokens, wait}\`, and the
[conversion rules](https://redis.io/docs/latest/develop/interact/programmability/lua-api/#lua-to-resp2-type-conversion)
between Lua and the Redis protocol turn a Lua number into an **integer reply** — \`0.5\` comes back as
\`0\`, \`19.8\` as \`19\`. Nothing warns. The bucket in the hash is right (\`HSET\` stores the number as a
string with its fraction intact); only the *reply* is wrong, which makes the bug look like a refill
error. The fix is to return the string yourself:

\`\`\`lua
return {allowed, tostring(tokens), wait}   -- "0.5", not 0
\`\`\`

and \`float()\` it on the client. The other two values are integers by construction — \`allowed\` is
\`0\`/\`1\`, \`wait\` is a \`math.ceil\` — so they can go back as numbers. (The same table also turns a Lua
\`false\` into a nil reply, which is why the script answers \`allowed\` as \`1\`/\`0\` rather than a boolean.)

:::quiz
Q: The hash shows tokens 0.5, but take() reports tokens_left as 0. Where is the bug?
- [ ] In the refill: 300 ms should earn 1.5 and did not
- [x] In the return: a Lua number crosses to Redis as an integer, so 0.5 became 0
- [ ] In HSET: Redis cannot store fractional values in a hash field
> The stored value is correct — HSET keeps the string "0.5". The reply is where the fraction was lost, because the Lua-to-Redis conversion truncates numbers. Return tostring(tokens) and parse it on the client.
:::

# What to take away

- **A token bucket is two numbers.** \`tokens\` and \`updated_ms\`; \`CAPACITY\` bounds the burst, \`RATE\`
  bounds the sustained throughput, and their ratio is how long the bucket remembers.
- **Refill lazily.** \`min(CAPACITY, tokens + elapsed × RATE / 1000)\` at decision time, from a clock the
  caller passes in — no timer, no \`TIME\`, nothing paid for idle buckets, exact for any gap. Write the
  refill back even on a denial.
- **Read, refill, compare, write — one script.** Two commands from a client, pipelined or not, leave a
  gap another server fills with the same token. \`EVAL\` closes it without a lock or a retry.
- **Tell the client when.** \`ceil(shortfall × 1000 / RATE)\` for a cost that fits, \`-1\` for one that
  never will, nothing taken either way.
- **Mind the edges.** \`PEXPIRE\` for exactly one full refill, because a missing key *is* a full bucket;
  \`tostring\` the tokens, because a Lua float crosses the protocol as an integer.

The primary references are Wikipedia's
[*Token bucket*](https://en.wikipedia.org/wiki/Token_bucket) for the mechanism and Redis's
[scripting with Lua](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/) page for
why one script is the unit of atomicity; Stripe's
[*Scaling your API with rate limiters*](https://stripe.com/blog/rate-limiters) describes the same bucket
in production, with the per-route and global layers the drill leaves out.
`;
