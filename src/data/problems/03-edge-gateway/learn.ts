/**
 * The learning guide for the Rate-Limited API Gateway: the concepts the five steps rest on, in the
 * order a reader meets them — a figure or a demo where one says it faster than prose, a pop quiz per
 * section. Rendered at `/edge-gateway/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The system at a glance

Every public API has one process that every request passes through first. Envoy, Kong, Traefik and
the cloud vendors' gateways are that process at scale; the course rebuilds the part of it that gives
the shape to everything else — one **gateway** in front of an internal catalog service:

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Client", "sub": "GET /items/{id} · X-API-Key", "x": 9, "y": 50},
    {"id": "gateway", "kind": "http", "label": "gateway", "sub": "HTTPS :8443 · TLS floor, HSTS, drain", "x": 31, "y": 50},
    {"id": "redis", "kind": "redis", "label": "Redis", "sub": "bucket:{key} (Lua) · resp:{sha} (EX 10)", "x": 55, "y": 16},
    {"id": "catalog", "kind": "grpc", "label": "Catalog", "sub": "GetItem · 2 s deadline · status mapped", "x": 55, "y": 84},
    {"id": "kafka", "kind": "kafka", "label": "gateway-audit", "sub": "key = api key · never awaited", "x": 70, "y": 50},
    {"id": "audit", "kind": "service", "label": "audit-writer", "sub": "consumer group", "x": 91, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "gateway", "kind": "http", "label": "HTTPS"},
    {"from": "gateway", "to": "redis", "kind": "redis", "label": "EVALSHA · GET / SET EX"},
    {"from": "gateway", "to": "catalog", "kind": "grpc", "label": "GetItem"},
    {"from": "gateway", "to": "kafka", "kind": "kafka", "label": "produce (async)"},
    {"from": "kafka", "to": "audit", "kind": "kafka", "label": "consume"}
  ]
}
:::

One request, five stations, in the order it meets them:

- **Terminate TLS** (step 1): HTTPS on \`:8443\`, nothing older than TLS 1.2, HSTS on every response,
  a drain on \`SIGTERM\`.
- **Rate-limit** (step 2): a token bucket per \`X-API-Key\` in Redis, refilled and debited in one Lua
  script; \`429\` with \`Retry-After\` when it is empty.
- **Translate** (step 3): \`GET /items/{id}\` becomes \`Catalog.GetItem\` over gRPC, with a 2 s deadline
  and the request id forwarded.
- **Cache** (step 5): a successful answer is kept for ten seconds under \`resp:{sha256(path?query)}\`.
- **Record** (step 4): after the response is written, one audit record goes to Kafka — and the request
  never waits for it.

Authentication, a WAF, mTLS to the catalog, configuration reloads, tracing: all left out, and each
slots into this pipeline without changing its shape.

# One front door, and the policies that live there

A gateway exists because some rules must hold for **every** request, and the only way to guarantee
that is one place every request passes. Put the rule in each service and one of them forgets; put it
in the gateway and the services behind it can assume it was done.

| Policy | Where it lives | Why there and not per route |
| --- | --- | --- |
| TLS 1.2 floor | the TLS context (\`MinVersion\`, \`minimum_version\`, \`SSL_CTX_set_min_proto_version\`) | checked once per handshake, before any route exists |
| \`Strict-Transport-Security: max-age=63072000\` | a middleware or post-routing hook | a route added next year cannot forget it |
| \`GET /healthz\` → \`{"ok": true}\` | a route the load balancer polls | the only way the process can be taken out of rotation |
| Drain on \`SIGTERM\`, at most 10 s | a signal handler calling the server's own graceful stop | the orchestrator sends \`SIGTERM\`, waits, then \`SIGKILL\` |

[HSTS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security) tells a
browser to refuse plain HTTP to this host for two years — a promise only a header on *every* response
can keep.

:::widget http-lifecycle {"tls": true}

The drain is the part teams get wrong. Die on the first signal and every in-flight request is lost;
wait forever and one client holding a connection keeps the old version alive through a deploy.
Graceful means: stop accepting, finish what is open, **with a deadline**:

:::sequence
{
  "participants": ["Client", "gateway", "OS"],
  "messages": [
    {"from": "Client", "to": "gateway", "label": "TLS handshake (1.2 or newer)", "kind": "sync"},
    {"from": "Client", "to": "gateway", "label": "GET /healthz", "kind": "sync"},
    {"from": "gateway", "to": "Client", "label": "200 {\\"ok\\": true} · Strict-Transport-Security", "kind": "reply"},
    {"from": "OS", "to": "gateway", "label": "SIGTERM", "kind": "async"},
    {"from": "gateway", "to": "gateway", "label": "close the listening socket · wait for in-flight requests, at most 10 s", "kind": "sync"},
    {"from": "gateway", "to": "Client", "label": "last in-flight response", "kind": "reply"},
    {"from": "gateway", "to": "OS", "label": "exit — before the SIGKILL lands", "kind": "reply"}
  ]
}
:::

- Close the accept socket **first**: new connections go to the replicas that are staying.
- Wait for open connections, bounded: \`srv.Shutdown(ctx)\` with a 10 s context, uvicorn's
  \`timeout_graceful_shutdown\`, a bounded \`wait_for\` on the serving thread.
- Real gateways also flip \`/healthz\` to unhealthy a few seconds *before* the drain, so the load
  balancer stops sending traffic before the socket closes.

:::quiz
Q: The orchestrator sends SIGTERM to a gateway replica with 40 requests in flight. What should happen?
- [ ] Exit immediately; the load balancer will retry the 40 requests on another replica
- [x] Close the listener, finish the 40 requests, exit — or exit anyway after 10 s
- [ ] Keep serving until the last client disconnects, however long that takes
> The 40 requests are already past the load balancer; only this process can answer them. Finishing them is the point of the drain; the 10 s bound is what stops one slow client from holding the old version alive until SIGKILL.
:::

# A rate limit is two numbers and a clock

A caller is allowed \`rate\` requests per second on average and \`burst\` at once. The
[token bucket](https://en.wikipedia.org/wiki/Token_bucket) is the smallest state that enforces both:
a count of tokens and the time it was last refilled. Each request takes one token; tokens come back at
\`rate\` per second, never beyond \`burst\`.

\`\`\`text
tokens = min(burst, tokens + (now - ts) * rate)     -- refill since the last visit
if tokens >= 1 then tokens = tokens - 1; allowed    -- take one, or deny
\`\`\`

The course's bucket is \`rate = 5\`, \`burst = 10\`, one per API key. A caller that has been quiet:

| When | Before refill | Refilled to | Request | After | Answer |
| --- | --- | --- | --- | --- | --- |
| \`t = 0\` | no hash | 10 (a missing bucket is full) | 1st of 11 at once | 9 | \`200\`, \`X-RateLimit-Remaining: 9\` |
| \`t = 0\` | 1 | 1 | 10th | 0 | \`200\`, \`X-RateLimit-Remaining: 0\` |
| \`t = 0\` | 0 | 0 | 11th | 0 | \`429\`, \`Retry-After: 1\` |
| \`t = 0.2 s\` | 0 | 1 | next | 0 | \`200\` — one token has appeared |
| \`t = 2.2 s\` | 0 | 10 (capped) | next | 9 | \`200\` — idle time refilled it, up to \`burst\` |

- **Burst** is what lets a page load fire ten calls at once; **rate** is what stops it doing that
  every 100 ms. Leaky-bucket and fixed-window counters only enforce one of the two.
- A quiet key does not bank credit forever: the cap at \`burst\` is the line that turns "ten
  minutes of silence" into ten requests, not three thousand.
- \`Retry-After\` is \`ceil(1 / rate)\` — the seconds until one token exists. Advice, not punishment:
  a well-behaved client sleeps that long instead of hammering.

:::widget token-bucket {"rate": 5, "burst": 10}

:::quiz
Q: A client was idle for an hour and then sends 30 requests in the same millisecond. With rate 5 and burst 10, how many succeed?
- [x] 10 — the bucket was full, and full means burst
- [ ] 30 — an hour of refill at 5 per second is 18 000 tokens
- [ ] 5 — the rate is 5 per second
> Refill is capped at burst on every visit, so the hour of silence is worth exactly ten tokens. The other twenty get 429 and Retry-After: 1; one of them gets through 200 ms later.
:::

# Atomic in Redis, honest to the client

Two gateway replicas share one counter, so the bucket lives in Redis under \`bucket:{api_key}\` — a hash
with \`tokens\` and \`ts\`. The tempting implementation reads it, computes, writes it back: two round
trips, and a race in between where both replicas see the last token and both allow. The fix is to move
the computation **into** Redis:

:::sequence
{
  "participants": ["Client", "gateway", "Redis"],
  "messages": [
    {"from": "Client", "to": "gateway", "label": "GET /items/42 · X-API-Key: k1", "kind": "sync"},
    {"from": "gateway", "to": "Redis", "label": "EVALSHA <sha> 1 bucket:k1 5 10 <now>", "kind": "sync"},
    {"from": "Redis", "to": "Redis", "label": "HMGET · refill · take one · HSET · EXPIRE — nothing runs in between", "kind": "sync"},
    {"from": "Redis", "to": "gateway", "label": "{1, 7}  (allowed, remaining)", "kind": "reply"},
    {"from": "gateway", "to": "Client", "label": "200 · X-RateLimit-Remaining: 7", "kind": "reply"},
    {"from": "gateway", "to": "Redis", "label": "EVALSHA … (burst spent)", "kind": "sync"},
    {"from": "Redis", "to": "gateway", "label": "{0, 0}", "kind": "reply"},
    {"from": "gateway", "to": "Client", "label": "429 · Retry-After: 1 · X-RateLimit-Remaining: 0", "kind": "reply"}
  ]
}
:::

The script, in full — the key in \`KEYS[1]\`, \`rate\`, \`burst\` and \`now\` in \`ARGV\`:

\`\`\`lua
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local rate, burst, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local tokens = tonumber(bucket[1]) or burst
local ts = tonumber(bucket[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(burst / rate) * 2)
return {allowed, math.floor(tokens)}
\`\`\`

- **One script at a time.** Redis
  [runs a script to completion](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)
  before touching the next command, so read-refill-take-write is atomic across every replica without a
  lock.
- **Loaded once, called by hash.** \`SCRIPT LOAD\` at start-up, \`EVALSHA\` per request: the Lua source
  crosses the wire once, not on every call.
- **Time comes from the gateway.** \`now\` is an argument, not \`TIME\` inside the script, so the script is a pure function
  of its arguments and stays deterministic under replication.
- **Idle keys expire.** \`EXPIRE\` at twice the time a bucket takes to refill: a key nobody has used for four seconds is
  indistinguishable from a full bucket, so it need not exist.

What the client sees is as much a part of the limiter as the arithmetic. Allowed: pass through, add
\`X-RateLimit-Remaining\`. Denied: **429 Too Many Requests**
([RFC 6585](https://www.rfc-editor.org/rfc/rfc6585#section-4)) with \`Retry-After\` and
\`X-RateLimit-Remaining: 0\`. A missing \`X-API-Key\` is the key \`anonymous\` — one shared bucket for
everyone who did not identify themselves.

:::details Fail open or fail closed when Redis is away?
The course's \`allow\` does not catch a Redis error, so an unreachable Redis becomes a 5xx. Real gateways
usually **fail open** for the limiter — serve the request, count the failure — because a limiter's job
is to protect the backend from abuse, and an unreachable Redis is not abuse. The opposite choice is
right for a quota that bills money. Either way it is a decision to make on purpose, with a counter on
it, rather than whatever the client library does by default.
:::

:::quiz
Q: Why does the gateway send \`now\` as an argument instead of the script calling \`redis.call('TIME')\`?
- [ ] EVALSHA cannot call TIME
- [x] So the script is a pure function of its arguments and replays identically on a replica
- [ ] Because the gateway's clock is more accurate than Redis's
> A script that reads the clock gives a different answer each time it runs; replicated as a script, a replica would compute a different bucket. With time passed in, the same call always yields the same writes.
:::

# A translation layer with a deadline

The catalog speaks gRPC; the public API speaks JSON. The proxy is the bridge, and it does three
translations and nothing more:

\`\`\`proto
service Catalog {
  rpc GetItem(GetItemRequest) returns (Item);
}
message GetItemRequest { string id = 1; }
message Item { string id = 1; string name = 2; int64 price_cents = 3; }
\`\`\`

:::sequence
{
  "participants": ["Client", "gateway", "Catalog"],
  "messages": [
    {"from": "Client", "to": "gateway", "label": "GET /items/42 · X-Request-Id: r-9", "kind": "sync"},
    {"from": "gateway", "to": "Catalog", "label": "GetItem{id: 42} · metadata x-request-id: r-9 · deadline now + 2 s", "kind": "sync"},
    {"from": "Catalog", "to": "gateway", "label": "Item{42, \\"Kettle\\", 3499}", "kind": "reply"},
    {"from": "gateway", "to": "Client", "label": "200 application/json {id, name, price_cents}", "kind": "reply"},
    {"from": "Client", "to": "gateway", "label": "GET /items/ghost", "kind": "sync"},
    {"from": "gateway", "to": "Catalog", "label": "GetItem{id: ghost}", "kind": "sync"},
    {"from": "Catalog", "to": "gateway", "label": "status NOT_FOUND", "kind": "reply"},
    {"from": "gateway", "to": "Client", "label": "404", "kind": "reply"}
  ]
}
:::

- **Path → message.** \`{id}\` from the URL becomes \`GetItemRequest.id\`; the reply becomes JSON. Watch
  \`int64\`: some stubs hand it over as a decimal string — \`"price_cents": "3499"\`.
- **Header → metadata.** \`X-Request-Id\` is attached as \`x-request-id\` (metadata keys are lowercase
  on the wire), so the catalog's log line and the gateway's carry the same id and can be joined.
- **Status → status.** One lookup table, in one place:

| gRPC status | HTTP | What the client learns |
| --- | --- | --- |
| \`NOT_FOUND\` | **404** | the item does not exist — do not retry |
| \`INVALID_ARGUMENT\` | **400** | the id is malformed — fix the request |
| \`DEADLINE_EXCEEDED\` | **504** | the catalog did not answer in 2 s — try later |
| \`UNAVAILABLE\` | **503** | the catalog is down — try later |
| anything else | **502** | the gateway's upstream failed; nothing leaks |

The **2 s deadline** is what makes it safe to sit in front of a service you do not control: without
it, a stalled catalog holds one gateway connection per arriving request, and the gateway runs out
before the catalog recovers. gRPC [propagates the deadline](https://grpc.io/docs/guides/deadlines/) to
the server, which can stop working on a call nobody is waiting for.

The gateway **does not retry** on the client's behalf: the caller's budget is unknown, and a \`GET\`
that timed out once has already cost 2 s. Report the status honestly — 504, not 200-after-a-retry —
and let the client decide:

:::widget deadline-retry {"base": 100, "deadline": 2000, "attempts": 1}

:::quiz
Q: The catalog returns \`INTERNAL\` with a message naming its database host. What should the client get?
- [ ] 500 with the message, so the client can report it
- [x] 502 with a generic body; the detail goes to the gateway's log
- [ ] 503, so the client retries
> INTERNAL is not in the table, and the 502 default is the whole point of having one: an upstream's internals never reach the public API. 503 would be a lie — it promises that retrying helps.
:::

# Audit off the request path

Security wants every request on record: who called, what, with which status, how long it took. The
record is produced **after** the response is written, to \`gateway-audit\`, keyed by the API key:

\`\`\`json
{"api_key": "k1", "path": "/items/42", "status": 200, "latency_ms": 12, "ts": 1700000000.4}
\`\`\`

:::sequence
{
  "participants": ["gateway", "Producer", "Kafka"],
  "messages": [
    {"from": "gateway", "to": "gateway", "label": "response written · latency 12 ms", "kind": "sync"},
    {"from": "gateway", "to": "Producer", "label": "produce(gateway-audit, key = k1, {…}) — returns at once", "kind": "async"},
    {"from": "Producer", "to": "Kafka", "label": "batch after linger · partition = hash(k1) % 6", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack (acks=1); poll(0) runs the delivery callback", "kind": "reply"},
    {"from": "gateway", "to": "Producer", "label": "produce(…) while the local queue is full", "kind": "async"},
    {"from": "Producer", "to": "gateway", "label": "BufferError / ERR__QUEUE_FULL → dropped += 1", "kind": "reply"}
  ]
}
:::

The priority is fixed before a line is written: an audit record is valuable, but never worth a slow or
failed request. Three rules follow:

1. **Hand off and return.** \`audit()\` enqueues; no \`flush()\`, no \`.get()\` on the future, no
   synchronous write on the request thread. The producer batches and sends in the background.
2. **Bound the queue.** \`queue.buffering.max.messages\`, or \`buffer.memory\` with \`max.block.ms=0\`, or a
   fixed-size channel in front of the writer. An unbounded buffer turns a slow broker into an
   out-of-memory gateway twenty minutes later.
3. **Drop and count.** When the queue is full the library says so — \`BufferError\`,
   \`BufferExhaustedException\`, \`ERR__QUEUE_FULL\`, a \`select\` falling to \`default\` — and the handler is
   one line: \`dropped += 1\`. Exported as \`gateway_audit_dropped_total\`; a rising value is a page.

Keyed by the **API key**, so one caller's history lands on one partition in order; a security
investigation reads a tenant's trail as it happened. Cross-caller order is not promised and not needed.

:::widget kafka-partitions {"partitions": 6}

:::details Why the producer still needs poll(0)
A Kafka client holds a record in its queue until the broker acknowledges it, and reports the outcome
through a delivery callback the application must give it a chance to run. \`poll(0)\` after each
\`produce\` does that without waiting: acknowledged records leave the queue, failed ones get logged.
Skip it and the queue fills with records that were delivered long ago — and \`audit()\` starts dropping
for no reason. Real gateways go one step further and hand audit to a local agent (Vector, Fluent Bit)
over a socket on the same host, so the process never holds a broker connection at all.
:::

:::quiz
Q: Kafka is down for ten minutes. During that time the gateway should…
- [ ] Return 503, since requests cannot be audited
- [ ] Queue every record in memory and send them all when the broker returns
- [x] Serve at normal latency, drop records past the queue bound, and count them
> The request never depended on Kafka and must not start to during an outage. A growing queue is the second-worst answer: it only moves the failure from "lost audit lines" to "gateway out of memory" — and loses the lines anyway.
:::

# A ten-second cache in front of the proxy

The same items are asked for thousands of times a minute, and each ask is a gRPC call. The response
cache is [cache-aside](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)
applied to whole HTTP responses:

:::sequence
{
  "participants": ["Client", "gateway", "Redis", "Catalog"],
  "messages": [
    {"from": "Client", "to": "gateway", "label": "GET /items/42", "kind": "sync"},
    {"from": "gateway", "to": "Redis", "label": "GET resp:sha256(\\"/items/42\\")", "kind": "sync"},
    {"from": "Redis", "to": "gateway", "label": "(nil)", "kind": "reply"},
    {"from": "gateway", "to": "Catalog", "label": "GetItem{42}", "kind": "sync"},
    {"from": "Catalog", "to": "gateway", "label": "200 · Item", "kind": "reply"},
    {"from": "gateway", "to": "Redis", "label": "SET resp:… {\\"content_type\\": \\"application/json\\", \\"body\\": \\"…\\"} EX 10", "kind": "sync"},
    {"from": "gateway", "to": "Client", "label": "200 · X-Cache: MISS", "kind": "reply"},
    {"from": "Client", "to": "gateway", "label": "GET /items/42 (within 10 s)", "kind": "sync"},
    {"from": "gateway", "to": "Redis", "label": "GET resp:sha256(\\"/items/42\\")", "kind": "sync"},
    {"from": "Redis", "to": "gateway", "label": "{content_type, body}", "kind": "reply"},
    {"from": "gateway", "to": "Client", "label": "200 · X-Cache: HIT — no gRPC call", "kind": "reply"}
  ]
}
:::

Four decisions make it a response cache rather than a bug:

- **The key** is \`resp:{sha256(path?query)}\`. Hashing keeps the key a fixed length and safe whatever
  the query string holds, and \`?a=1&b=2\` and \`?b=2&a=1\` are honestly different entries.
- **The entry** carries the body *and* its content type, in one value, so a single \`GET\` reproduces the
  response. A body without its media type is half a response.
- **Only a 200 is stored.** The guard sits in front of the \`SET\`: a cached 404 or 503 is an outage that
  outlives its cause by the TTL, served confidently to everyone for ten seconds.
- **No-cache skips the lookup.** A request with \`Cache-Control: no-cache\` goes straight to the upstream,
  but still refreshes the entry on the way out: the client gets a fresh answer and warms the cache for
  everyone else.

\`X-Cache: HIT\` or \`MISS\` on every response, so an operator with \`curl\` can see what the cache is doing.

Ten seconds is a **micro-cache**. At 2 000 requests/s for one hot item it turns 20 000 gRPC calls into
one, and nobody sees a price more than ten seconds old. Real gateways honour \`Vary\` (per-\`Accept\`,
per-tenant keys), respect the upstream's own \`Cache-Control\`, refresh hot keys in the background with
stale-while-revalidate, and single-flight concurrent misses so a cold key is fetched once, not 2 000
times.

:::widget cache-aside {}

:::quiz
Q: The catalog returns 503 for \`/items/42\` during a 30-second blip. Which design keeps the blip at 30 seconds?
- [x] Store nothing unless the status is 200, so the next request after recovery is a miss and gets the real item
- [ ] Cache the 503 too, so the catalog is not hammered while it is down
- [ ] Cache it, but with a shorter TTL of 2 s
> The cache's job is to repeat good answers, not bad ones. Caching the 503 would make the outage visible for up to 10 s after the catalog was already back — and the rate limiter, not the cache, is what protects an upstream from a stampede.
:::

# What to take away

- **A gateway is where cross-cutting policy lives.** TLS floor, HSTS, graceful drain: one process every
  request passes, so no route and no backend can forget them.
- **A token bucket is two numbers and a clock.** \`min(burst, tokens + elapsed × rate)\`, take one;
  \`429\` with \`Retry-After\` turns a rejection into advice.
- **Put the read-modify-write where it is atomic.** A Lua script runs alone inside Redis; many
  replicas share one correct counter with no lock and one round trip.
- **Translate honestly, with a deadline, without retrying.** Path → message, header → metadata,
  status → status with a 502 default; 2 s is the most a stalled upstream may cost.
- **A side channel never fails the main one.** Audit is handed off, bounded, dropped and counted —
  and a response cache stores only what it would be glad to repeat.

The primary source is the
[Envoy architecture overview](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/arch_overview):
the listener, filter-chain and cluster model that every production gateway — Envoy itself, Istio's
sidecars, the cloud vendors' managed proxies — shares, with the same stations this course builds
appearing as filters in the request pipeline.
`;
