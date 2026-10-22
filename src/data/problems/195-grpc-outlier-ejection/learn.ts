/**
 * The learning guide for the outlier-ejection drill: client-side versus proxy load balancing, gRPC's
 * pick_first and round_robin, Envoy-style outlier detection, which failures may eject an instance, and
 * the retry storm and timeout tax that ejection prevents. Rendered at `/grpc-outlier-ejection/learn`.
 */
export const learn = `# The mechanism at a glance

A client that talks to several instances of one gRPC service has to decide, call by call, which instance
gets the request. **Round robin** spreads calls evenly. **Outlier ejection** takes an instance out of the
rotation for a while when it fails in a way that says the instance itself is broken, so the next calls
stop paying for it.

:::diagram
{
  "nodes": [
    {"id": "client", "kind": "client", "label": "Balancer", "sub": "cursor · ejected_until · one stub per target", "x": 20, "y": 50},
    {"id": "grpc", "kind": "grpc", "label": "Inventory × 3", "sub": "inv-a · inv-b · inv-c :50051", "x": 72, "y": 50}
  ],
  "edges": [
    {"from": "client", "to": "grpc", "kind": "grpc", "label": "GetStock(sku) · 0.2 s per attempt"}
  ]
}
:::

The contract the drill implements:

- \`Balancer(targets, deadline=0.2, eject_for=30.0)\` with \`get_stock(sku)\` returning \`Stock.count\` from
  \`Inventory.GetStock\` (package \`inventory.v1\`), over \`inv-a:50051\`, \`inv-b:50051\`, \`inv-c:50051\`.
- Round robin over the targets that are not ejected, continuing after the last one used.
- Every attempt carries a 0.2 s deadline.
- \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\` ejects that target for 30 s and the same call tries the next
  healthy one. One call tries each target at most once.
- Any other status (\`NOT_FOUND\`, \`INVALID_ARGUMENT\`, \`PERMISSION_DENIED\`) is raised at once: no retry,
  no ejection.
- With every target ejected, the call raises \`UNAVAILABLE\` without sending anything. After 30 s an
  ejected target is back.

# Client-side or proxy load balancing

There are two places the choice of instance can live.

| | Proxy (L7) | Client-side |
| --- | --- | --- |
| Who picks | Envoy, NGINX, a cloud load balancer, between client and servers | the client library, inside the calling process |
| What the client knows | one address | every instance address (from DNS, a registry or xDS) |
| Extra hop | yes: one more network hop and one more thing to run | no |
| Where health state lives | in the proxy, shared by every client | in each client, learned from its own calls |
| Language support | any client, unchanged | each language's gRPC library must implement the policy |

gRPC makes the question sharper than plain HTTP/1.1 does. A gRPC channel keeps **one long-lived HTTP/2
connection** per backend and multiplexes every call over it. An L4 load balancer that picks a backend
per TCP connection therefore picks once, and every call from that client goes to the same instance for
hours. Balancing gRPC means balancing **per call**: either an L7 proxy that understands HTTP/2 streams, or
a client that holds a connection to every instance and chooses among them for each RPC.

- Client-side balancing has no extra hop and scales with the clients, but every client must learn the
  instance list and must find out for itself which instances are sick.
- A proxy sees the traffic of all clients, so one proxy notices a bad instance faster than any single
  client could. The price is the hop and a fleet of proxies to operate.
- A sidecar proxy (Envoy beside each service, as in a service mesh) is the hybrid: proxy logic,
  client-side placement.

The drill is the client-side version: the balancer holds one stub per target and does its own health
accounting.

:::quiz
Q: A team puts an L4 (TCP) load balancer in front of three gRPC servers. One client sends 10,000 calls a second. How are they spread?
- [ ] Evenly, about 3,333 per server
- [x] Almost all on one server, because the client's single HTTP/2 connection was balanced once
- [ ] Randomly per call, because HTTP/2 opens a stream per call
> The L4 balancer sees TCP connections, not calls. gRPC multiplexes every call over one connection, so the balancer's one decision pins all of them to one backend. Per-call balancing needs an L7 proxy or a client-side policy.
:::

# pick_first and round_robin

gRPC's client libraries ship load-balancing policies that run inside the channel. Two are built in
everywhere, and a channel uses \`pick_first\` unless told otherwise.

| Policy | Connections | Which instance gets a call | When an instance fails |
| --- | --- | --- | --- |
| \`pick_first\` | tries the addresses in order, keeps the first that connects | always that one | reconnects and walks the list again |
| \`round_robin\` | one subchannel per address, all kept connected | the next READY subchannel, in turn | the subchannel leaves the READY set until it reconnects |

\`pick_first\` is the right default for a client that talks to one logical server through a proxy: there is
only one address that matters. \`round_robin\` is the client-side balancer: it spreads load evenly and
reacts to **connection** state. That last point is its blind spot. An instance whose TCP connection is up
but which answers every call after 2 s, or with errors, stays READY and keeps getting its share. The
\`round_robin\` policy does not look at call outcomes.

The drill's rotation is a cursor over the target list:

\`\`\`text
target = targets[next]
next = (next + 1) % len(targets)    # moved before the attempt
\`\`\`

Moving the cursor before the attempt means the next call starts after the target just used, whatever
happened to the attempt. Skipped (ejected) targets still move the cursor, so the survivors keep strict
alternation.

:::details Where the instance list comes from
In the drill the list is a constructor argument. Real clients resolve it: a DNS name with several A
records (gRPC's default resolver), a service registry, or an xDS control plane that pushes endpoints,
weights and the load-balancing policy itself to the client. The policy then has to cope with the list
changing under it: a new instance arrives cold, a removed one has calls in flight.
:::

:::quiz
Q: One of three instances accepts connections but answers every call in 2 s. What does plain round_robin do?
- [ ] Removes it from the rotation after the first timeout
- [x] Keeps sending it a third of the calls, because its connection is still READY
- [ ] Sends it fewer calls, weighted by latency
> round_robin tracks connectivity, not call results. A slow or failing instance with a healthy connection keeps its full share. Detecting that takes a policy that watches outcomes: outlier detection.
:::

# Outlier detection: watching outcomes

Outlier detection is passive health checking: instead of probing an endpoint, watch the real calls and
take an instance out when its results stand out. Envoy made the idea standard, and gRPC now ships an
\`outlier_detection\` policy that wraps \`round_robin\` with the same idea, configured over xDS. The knobs,
in [Envoy's outlier detection](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier):

| Knob | What it means | In the drill |
| --- | --- | --- |
| \`consecutive_5xx\` | eject after this many consecutive 5xx responses (default 5) | 1 transport failure |
| \`consecutive_gateway_failure\` | the same, counting only 502, 503, 504 and connect failures | \`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\` |
| \`base_ejection_time\` | how long an ejection lasts; multiplied by the number of times the host was ejected | a flat 30 s |
| \`max_ejection_percent\` | the most of the cluster that may be ejected at once (default 10%) | none: all three may go |
| success rate / failure percentage | eject hosts whose success rate is far below the cluster's | not modelled |

Two of those knobs exist because ejection itself can do harm:

- **Ejection time grows with repeats.** A host ejected for the third time stays out three times as long,
  so a flapping host spends most of its time out instead of failing a burst of calls every 30 s.
- **The ejection cap.** If ejection could take every host, a cluster-wide hiccup (a bad deploy of a
  shared dependency) would empty the pool and the client would fail every call even though some hosts
  would have answered. Envoy stops ejecting at \`max_ejection_percent\` and keeps the rest in rotation.
  The drill lets every target go and then fails fast, which is honest on three instances and wrong on
  three hundred.

Readmission in the drill is simply time: once \`time.time()\` passes \`ejected_until[target]\` the target is
back in rotation, and its next call is the test. Envoy does the same: no probe, the host returns and the
real traffic decides whether it stays.

:::quiz
Q: Why does Envoy cap ejections at a percentage of the cluster?
- [ ] To keep the outlier detector's memory use bounded
- [x] So a failure that hits every host at once cannot empty the pool and turn partial service into none
- [ ] Because a host must be probed before it can be ejected, and probes are rate-limited
> If every host looks bad, the problem is probably not the hosts. Ejecting them all guarantees failure; keeping a floor in rotation keeps whatever partial service is still possible.
:::

# Which failures may eject an instance

The status code says whether the instance or the request is at fault, and only the first is a reason to
eject. The [gRPC status codes](https://grpc.github.io/grpc/core/md_doc_statuscodes.html) split cleanly:

| Status | What it says | Another instance would | The drill |
| --- | --- | --- | --- |
| \`UNAVAILABLE\` | the instance could not be reached or is shutting down | probably answer | eject, try the next |
| \`DEADLINE_EXCEEDED\` | no answer within 0.2 s | probably answer in time | eject, try the next |
| \`NOT_FOUND\` | the SKU does not exist | say the same | raise |
| \`INVALID_ARGUMENT\` | the request is malformed (empty SKU) | say the same | raise |
| \`PERMISSION_DENIED\` | the caller may not do this | say the same | raise |

Ejecting on an application error is a self-inflicted outage. One client looping over unknown SKUs gets
\`NOT_FOUND\` from \`inv-a\`, then \`inv-b\`, then \`inv-c\`; with ejection on any error all three are out
for 30 s and every other client's valid requests fail with \`UNAVAILABLE\`. Retrying an application error
on another instance is the milder form of the same mistake: three calls for one answer that was already
final.

:::sequence
{
  "participants": ["balancer", "inv-a:50051", "inv-b:50051", "inv-c:50051"],
  "messages": [
    {"from": "balancer", "to": "inv-a:50051", "label": "GetStock(\\"ghost\\")", "kind": "sync"},
    {"from": "inv-a:50051", "to": "balancer", "label": "NOT_FOUND", "kind": "reply"},
    {"from": "balancer", "to": "balancer", "label": "raise NOT_FOUND · nothing ejected", "kind": "sync"},
    {"from": "balancer", "to": "inv-b:50051", "label": "next call: GetStock(\\"sku-1\\")", "kind": "sync"},
    {"from": "inv-b:50051", "to": "balancer", "label": "UNAVAILABLE (instance down)", "kind": "reply"},
    {"from": "balancer", "to": "balancer", "label": "eject inv-b until now + 30 s", "kind": "sync"},
    {"from": "balancer", "to": "inv-c:50051", "label": "same call: GetStock(\\"sku-1\\")", "kind": "sync"},
    {"from": "inv-c:50051", "to": "balancer", "label": "Stock{count: 7}", "kind": "reply"}
  ]
}
:::

Envoy draws the same line in HTTP terms: 4xx responses never count toward ejection, and the
gateway-failure counter looks only at 502, 503, 504 and failed connects, the codes that mean "this host,
not this request".

:::quiz
Q: A client sends a request with an empty SKU. Every instance answers INVALID_ARGUMENT. What should the balancer do?
- [ ] Try the other two instances in case one accepts it, then eject all three
- [ ] Eject the instance that answered and raise the error
- [x] Raise INVALID_ARGUMENT after the one call and keep all instances in rotation
> The instance did its job: it read the request and rejected it. Every instance gives the same answer, so another attempt is wasted work, and ejecting would let one bad caller take healthy instances away from everyone else.
:::

# Retry storms and the timeout tax

Without ejection, a dead or stalled instance keeps its third of the rotation, and every call that lands on
it pays first. With a 0.2 s deadline and failover inside the call, a third of all calls take at least
0.2 s longer, for as long as the instance stays broken:

:::sequence
{
  "participants": ["balancer", "inv-a:50051", "inv-b:50051 (stalled)", "inv-c:50051"],
  "messages": [
    {"from": "balancer", "to": "inv-b:50051 (stalled)", "label": "call 1: GetStock", "kind": "sync"},
    {"from": "inv-b:50051 (stalled)", "to": "balancer", "label": "DEADLINE_EXCEEDED after 0.2 s", "kind": "reply"},
    {"from": "balancer", "to": "inv-c:50051", "label": "call 1, retry: GetStock", "kind": "sync"},
    {"from": "inv-c:50051", "to": "balancer", "label": "Stock (call 1 took 0.2 s+)", "kind": "reply"},
    {"from": "balancer", "to": "inv-a:50051", "label": "call 2: GetStock", "kind": "sync"},
    {"from": "inv-a:50051", "to": "balancer", "label": "Stock", "kind": "reply"},
    {"from": "balancer", "to": "inv-b:50051 (stalled)", "label": "call 3: GetStock, no memory of call 1", "kind": "sync"},
    {"from": "inv-b:50051 (stalled)", "to": "balancer", "label": "DEADLINE_EXCEEDED after 0.2 s, again", "kind": "reply"},
    {"from": "balancer", "to": "inv-c:50051", "label": "call 3, retry: GetStock", "kind": "sync"},
    {"from": "inv-c:50051", "to": "balancer", "label": "Stock (call 3 took 0.2 s+)", "kind": "reply"}
  ]
}
:::

With ejection the balancer pays that 0.2 s once per 30 s window: call 1 times out on \`inv-b\` and
ejects it, call 3 goes straight to \`inv-a\` or \`inv-c\`. At 1,000 calls a second that is the difference
between one slow call and about 10,000 slow calls in the same 30 s.

The other half of the problem is load. Every timed-out attempt that is retried elsewhere is extra traffic
on the survivors, and every client does the same thing at the same moment. Retries multiply: a client
that makes 3 attempts, calling a service that makes 3 attempts, turns one failing request into 9 at the
bottom of the stack. That is a **retry storm**, and it is why the
[AWS Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
caps retries, adds jitter and uses token buckets for them. The drill's bounds are the same idea in small:

- one attempt per target per call, so a call costs at most three attempts;
- no retry at all for application errors;
- with everything ejected, zero attempts: \`UNAVAILABLE\` at once, and the instances see no load while they
  recover.

How attempts stack up under a deadline:

:::widget deadline-retry {"base": 50, "deadline": 600, "attempts": 3}

:::quiz
Q: All three instances are ejected. Why raise UNAVAILABLE immediately instead of trying them anyway?
- [ ] Because a channel to an ejected target cannot send calls
- [x] The call would almost surely fail after paying the timeouts, and the extra load hits instances that are trying to recover
- [ ] gRPC forbids sending calls to a target that returned UNAVAILABLE in the last 30 s
> Nothing stops the client from calling; it chooses not to. Failing fast gives the caller the same answer three timeouts sooner and keeps traffic off instances that are restarting or overloaded, so they come back sooner.
:::

# What to take away

- Balance gRPC per call, not per connection: one HTTP/2 connection carries every call, so an L4 balancer
  pins a client to one instance.
- \`pick_first\` follows one address; \`round_robin\` spreads calls but only reacts to connection state, not
  to slow or failing answers.
- Outlier detection watches call outcomes and ejects for a time: here 30 s after one \`UNAVAILABLE\` or
  \`DEADLINE_EXCEEDED\`, in Envoy after consecutive failures, growing with each repeat and capped at a share
  of the pool.
- Only transport failures eject. \`NOT_FOUND\`, \`INVALID_ARGUMENT\` and friends are final answers: raise
  them after one call.
- Bound the work: each target once per call, and fail fast with \`UNAVAILABLE\` when nothing is left.

Primary reference: [gRPC Load Balancing](https://grpc.io/blog/grpc-load-balancing/) on the gRPC blog.
`;
