/**
 * The learning guide for the deadline-propagation drill: deadlines versus timeouts, budgets across
 * hops, the reserve, the work done after the caller gave up, the grpc-timeout header, cancellation
 * and Go's context. Rendered at `/grpc-deadline-propagation/learn`.
 */
export const learn = `# The mechanism at a glance

A **deadline** is the instant after which the original caller no longer wants the answer. In a chain
of RPCs it belongs to the request, not to any one server: each hop reads how much of it is left, keeps a
little back, and gives the rest to the next call. That is **deadline propagation**, and it is how a
request tree that fans out over a dozen services still stops at one moment instead of a dozen.

:::diagram
{
  "nodes": [
    {"id": "checkout", "kind": "client", "label": "Checkout", "sub": "GetQuote · deadline 0.8 s", "x": 10, "y": 50},
    {"id": "quotes", "kind": "service", "label": "Quotes", "sub": "budget = time left · minus RESERVE", "x": 45, "y": 50},
    {"id": "pricing", "kind": "grpc", "label": "Pricing", "sub": "pricing:50051 · GetPrice", "x": 80, "y": 50}
  ],
  "edges": [
    {"from": "checkout", "to": "quotes", "kind": "grpc", "label": "GetQuote{sku, qty} · 0.8 s"},
    {"from": "quotes", "to": "pricing", "kind": "grpc", "label": "GetPrice{sku} · 0.75 s"}
  ]
}
:::

The contract the drill implements, in \`Quotes.GetQuote\` (package \`quotes.v1\`):

- Validate first: an empty \`sku\` or \`qty <= 0\` is \`INVALID_ARGUMENT\` and pricing is never called.
- The budget is the incoming time remaining (Python \`context.time_remaining()\`, TypeScript
  \`call.getDeadline() - Date.now()\`), or \`DEFAULT_BUDGET = 1.0\` s when the caller sent no deadline.
- If \`budget - RESERVE <= 0\` (with \`RESERVE = 0.05\` s), answer \`DEADLINE_EXCEEDED\` without calling pricing.
- Otherwise call \`GetPrice\` at \`pricing:50051\` once, with timeout \`budget - RESERVE\`, and never retry.
- Pass \`DEADLINE_EXCEEDED\`, \`NOT_FOUND\` and \`UNAVAILABLE\` through; every other pricing status becomes
  \`INTERNAL\`. On success \`total_cents = unit_cents * qty\`.

# Deadlines, not timeouts

The two words are used loosely, but they describe different things, and gRPC's
[deadlines guide](https://grpc.io/docs/guides/deadlines/) is careful about it:

| | Timeout | Deadline |
|---|---|---|
| What it is | a duration: "wait at most 2 s" | an instant: "nothing after 12:00:00.800" |
| Whose it is | the code that sets it | the request, end to end |
| After one hop has run for 300 ms | still 2 s for the next call | 300 ms closer for everyone |
| Survives a chain of calls | no: each hop starts its own clock | yes: every hop shares one end |

- A fixed per-call timeout is a local decision. It is right for the outermost caller, which owns the
  deadline, and wrong for every server in the middle, which does not.
- A server that sets its own 2 s timeout on a downstream call, while its caller allowed 0.8 s, has
  promised 1.2 s of work nobody will read.
- On the wire the two meet: a client converts its deadline into a remaining duration when it sends the
  call, and the server converts that duration back into a deadline on arrival.

The drill's server never invents a duration of its own except in one case: the caller sent no deadline
at all. Then it falls back to \`DEFAULT_BUDGET\`, because an unbounded downstream call is the one thing
worse than a wrong bound. Note that "no deadline" and "no time left" are opposites. Python reports the
first as \`None\` and the second as \`0.0\`; a test such as \`time_remaining() or DEFAULT_BUDGET\` turns a spent
request into a fresh second of work.

:::quiz
Q: A server receives a call with 0.8 s left and has used 0.1 s on validation. What should its downstream call get?
- [ ] Its own configured timeout of 2 s, since that is what the dependency's SLO allows
- [x] About 0.7 s minus a reserve: what the caller still waits, not what this server would like
- [ ] 0.8 s, the deadline it received
> The deadline is fixed in time. Every millisecond this server spends comes out of what the next hop can have, and anything beyond the caller's deadline is work no one will read.
:::

# Budgets across hops, and the work nobody reads

Without propagation each server bounds its own call and nothing bounds the request. The caller gives up
on time; the servers below it carry on:

:::sequence
{
  "participants": ["Checkout", "Quotes", "Pricing"],
  "messages": [
    {"from": "Checkout", "to": "Quotes", "label": "GetQuote{kettle, 2} · deadline 0.8 s", "kind": "sync"},
    {"from": "Quotes", "to": "Pricing", "label": "GetPrice{kettle} · its own timeout 2 s", "kind": "sync"},
    {"from": "Checkout", "to": "Checkout", "label": "t = 0.8 s · gives up", "kind": "sync"},
    {"from": "Checkout", "to": "Quotes", "label": "retry: GetQuote{kettle, 2} · 0.8 s", "kind": "sync"},
    {"from": "Quotes", "to": "Pricing", "label": "a second GetPrice · 2 s (the first still running)", "kind": "sync"},
    {"from": "Pricing", "to": "Quotes", "label": "t = 1.5 s · Price{3499} for the first call", "kind": "reply"},
    {"from": "Quotes", "to": "Checkout", "label": "Quote for a request nobody is waiting on", "kind": "reply"}
  ]
}
:::

- **Wasted work.** From 0.8 s to 1.5 s Pricing, and the connection and memory Quotes holds open for it,
  serve a request that already failed.
- **Amplification.** The caller's retry arrives while the first call is still running, so a slow
  Pricing sees twice the load at exactly the moment it is slowest. This is the feedback loop the
  [Google SRE book](https://sre.google/sre-book/addressing-cascading-failures/) describes in its chapter
  on cascading failures, and deadline propagation is one of its first remedies.
- **Wrong answers about who failed.** Pricing reports success, Quotes reports success, and the user saw
  a timeout. Nothing in the logs below the edge explains it.

With propagation the whole tree stops together:

:::sequence
{
  "participants": ["Checkout", "Quotes", "Pricing"],
  "messages": [
    {"from": "Checkout", "to": "Quotes", "label": "GetQuote{kettle, 2} · deadline 0.8 s", "kind": "sync"},
    {"from": "Quotes", "to": "Pricing", "label": "GetPrice{kettle} · timeout 0.8 - 0.05 = 0.75 s", "kind": "sync"},
    {"from": "Pricing", "to": "Quotes", "label": "t = 0.75 s · DEADLINE_EXCEEDED", "kind": "reply"},
    {"from": "Quotes", "to": "Checkout", "label": "DEADLINE_EXCEEDED at 0.75 s, inside 0.8 s", "kind": "reply"},
    {"from": "Checkout", "to": "Quotes", "label": "GetQuote · deadline 0.04 s", "kind": "sync"},
    {"from": "Quotes", "to": "Checkout", "label": "DEADLINE_EXCEEDED · pricing never called", "kind": "reply"}
  ]
}
:::

Two rules fall out of the budget view. A call that cannot finish in time should not be started: with
0.04 s left the drill answers at once and Pricing sees nothing. And a timed-out call is not retried in
the same request, because the retry would run on a budget that is already gone; retries belong to the
hop that owns the deadline and can decide to spend more.

:::quiz
Q: Quotes's pricing call fails with DEADLINE_EXCEEDED after 0.75 of the caller's 0.8 s. Should Quotes retry it?
- [ ] Yes, once: deadlines are transient and a second try often succeeds
- [x] No: 0.05 s is left, the retry cannot finish, and it only adds load to a slow dependency
- [ ] Yes, with the full DEFAULT_BUDGET, since the original deadline has passed
> The budget is spent. A retry with what is left cannot complete, and one with a fresh budget answers a caller that has already left. Report DEADLINE_EXCEEDED and let the deadline's owner decide.
:::

# Why a reserve

A server that hands its whole remaining budget to the next call has nothing left when that call fails.
Both clocks reach zero at the same instant: the downstream call gives up, and so does the caller,
before this server can say why.

| Downstream timeout | Pricing hangs | What the caller sees |
|---|---|---|
| budget (0.8 s) | Quotes's call and Checkout's deadline expire together | its own DEADLINE_EXCEEDED, raised locally, no word from Quotes |
| budget - RESERVE (0.75 s) | Quotes's call expires at 0.75 s | Quotes's DEADLINE_EXCEEDED with details, at 0.75 s |

- The reserve pays for everything after the downstream call: mapping the status, writing logs,
  serialising the response and the network trip back.
- It also absorbs what propagation cannot see. The remaining time crosses the wire as a duration, so
  the transit time of each request is never subtracted, and each hop's view of the deadline is a little
  later than the caller's.
- It sets the floor. When \`budget - RESERVE <= 0\` there is not enough time for a call and its answer,
  so the server answers \`DEADLINE_EXCEEDED\` straight away, as the drill does at 0.04 s.

The size is a judgement: big enough to cover the reply path at its p99, small enough not to starve the
call. Fifty milliseconds is common for in-datacenter hops; deep call trees sometimes take a fraction of
the budget per hop instead.

:::quiz
Q: Why does the drill answer DEADLINE_EXCEEDED for a 0.04 s budget instead of calling pricing with 0.04 s?
- [ ] Because pricing never answers in under 50 ms
- [x] Because with less than RESERVE left there is no time to make the call and still report its result
- [ ] Because gRPC rejects timeouts below 50 ms
> The reserve is the time this server needs to answer. Anything at or under it leaves the downstream call a budget of zero or less: starting it cannot help the caller and only costs Pricing work.
:::

# The grpc-timeout header

gRPC carries the deadline in a request header defined by the
[gRPC over HTTP/2 protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md):

\`\`\`text
grpc-timeout = TimeoutValue TimeoutUnit
TimeoutValue = up to 8 ASCII digits
TimeoutUnit  = H (hours) | M (minutes) | S (seconds) | m (milliseconds) | u (microseconds) | n (nanoseconds)

:path         /quotes.v1.Pricing/GetPrice
grpc-timeout  750m
\`\`\`

- It is a **relative** duration, not a timestamp, so client and server clocks never need to agree. The
  server adds it to its own clock when the request arrives.
- It is only a header. A server library turns it into the context's deadline (\`time_remaining()\`,
  \`getDeadline()\`, \`ctx.Deadline()\`), but nothing copies it into outgoing calls unless the
  server's code or framework does. In Python and Node the drill's code is that copy.
- When the deadline expires the client cancels the HTTP/2 stream and reports \`DEADLINE_EXCEEDED\`
  locally; the server sees its call cancelled. Both sides stop, as long as the server checks.

| Stack | Propagates to outgoing calls by itself? |
|---|---|
| Go \`grpc-go\` | yes, when the outgoing call uses a context derived from the incoming \`ctx\` |
| Java \`grpc-java\` | yes, through \`io.grpc.Context\`; the earlier of the call's and the context's deadline wins |
| Node \`grpc-js\` | only with the \`parent\` call option set to the incoming call |
| Python \`grpcio\` | no: pass \`timeout=\` from \`context.time_remaining()\` yourself |

Even where propagation is automatic, the reserve is not: an inherited deadline gives the downstream
call everything left. The drill's Go, Scala and C++ solutions subtract it explicitly for that reason.

:::quiz
Q: A client sends grpc-timeout: 800m and the request spends 30 ms on the network. What deadline does the server see?
- [ ] 770 ms from arrival, because the header records the send time
- [x] 800 ms from arrival: the transit time is invisible, which is one reason a hop keeps a reserve
- [ ] The client's absolute deadline, copied from its clock
> The header is a duration measured from whenever the receiver reads it. Each hop's deadline ends a little after the caller's, by the time the request spent on the wire, and the reserve absorbs it.
:::

# Cancellation and Go's context

A deadline is a scheduled cancellation. When it fires, or when the caller hangs up first, the useful
response is to stop: abandon the downstream calls, release the connection, skip the database write
that no one will read. gRPC's [cancellation guide](https://grpc.io/docs/guides/cancellation/) puts it
plainly: a cancelled RPC should have its children cancelled too.

Go makes this one value. A request's [\`context.Context\`](https://go.dev/blog/context) carries its
deadline and its cancellation together, and everything derived from it inherits both:

\`\`\`go
budget := defaultBudget
if deadline, ok := ctx.Deadline(); ok {
	budget = time.Until(deadline)
}
callCtx, cancel := context.WithTimeout(ctx, budget-reserve) // the earlier of the two deadlines
defer cancel()
price, err := pricing.GetPrice(callCtx, &pb.PriceRequest{Sku: req.GetSku()})
\`\`\`

- \`context.WithTimeout(ctx, d)\` never extends the parent's deadline; it can only shorten it. Here it
  shortens it by the reserve.
- If the checkout hangs up, \`ctx\` is cancelled, \`callCtx\` with it, and grpc-go resets the Pricing
  stream. The same chain works for a database query or an HTTP call that takes the context.
- \`defer cancel()\` releases the timer as soon as the handler returns, success or not.

Other stacks spell it differently: \`context.is_active()\` and \`add_done_callback\` in Python, the
\`cancelled\` event on a grpc-js call, \`Context.current().isCancelled\` in Java,
\`ServerContext::IsCancelled()\` in C++. The drill grades the deadline half; real servers wire up both.

:::quiz
Q: In Go, the incoming ctx has 0.3 s left. What deadline does context.WithTimeout(ctx, 2*time.Second) give the outgoing call?
- [x] 0.3 s: a derived context keeps the earlier of its parent's deadline and its own
- [ ] 2 s: the explicit timeout overrides the parent's
- [ ] 2.3 s: the timeout is added to what is left
> Derived contexts can only shorten a deadline. That is why Go servers propagate deadlines almost by accident, and why the reserve still has to be subtracted on purpose.
:::

# What to take away

- **A deadline belongs to the request.** Read what is left at every hop; never replace it with a
  server's own timeout. Fall back to a default only when there is no deadline at all, and test for
  "none", not for zero.
- **Keep a reserve.** Pass \`remaining - RESERVE\` downstream so this server still has time to answer, and
  answer \`DEADLINE_EXCEEDED\` at once when that is zero or less.
- **One call per budget.** A timed-out call is not retried with what is left; the owner of the deadline
  decides whether to spend more.
- **Translate statuses.** Pass on what the caller can act on (\`NOT_FOUND\`, \`UNAVAILABLE\`,
  \`DEADLINE_EXCEEDED\`) and turn the rest into \`INTERNAL\`.
- **Deadlines and cancellation travel together.** \`grpc-timeout\` carries the first; a derived context
  or a parent call carries both.

The primary reference is gRPC's [deadlines guide](https://grpc.io/docs/guides/deadlines/), with the
\`grpc-timeout\` format in the HTTP/2 protocol document and the failure it prevents in the SRE book's
chapter on cascading failures.
`;
