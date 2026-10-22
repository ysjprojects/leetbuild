/**
 * The learning guide for the keyed producer drill: what a Kafka producer is underneath, and the three
 * decisions — key, acks, shutdown — that decide whether it is correct. A figure where one says it faster
 * than prose, a pop quiz per section. Rendered at `/kafka-keyed-producer/learn`; the same Markdown is
 * what the download exports.
 */
export const learn = `# The mechanism at a glance

A Kafka **producer** is not a socket you write to. It is an in-memory queue, a background thread that
drains the queue into batches, one batch per partition, and a callback through which the broker's
answer comes back later. The caller appends and returns; everything else happens after. The drill
builds the module every order service has around that producer:

:::diagram
{
  "nodes": [
    {"id": "orders", "kind": "service", "label": "orders", "sub": "emit(order_id, event) · stats() · shutdown()", "x": 20, "y": 50},
    {"id": "producer", "kind": "service", "label": "producer", "sub": "queue · background thread · delivery callback", "x": 50, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "order-events", "sub": "key = order id · acks=all", "x": 80, "y": 50}
  ],
  "edges": [
    {"from": "orders", "to": "producer", "kind": "plain", "label": "produce · poll(0) · flush(5 s)"},
    {"from": "producer", "to": "kafka", "kind": "kafka", "label": "batches, one per partition"}
  ]
}
:::

The contract, in one table:

| Call | What it does | What it must not do |
| --- | --- | --- |
| \`emit(order_id, event)\` | key = the order id as bytes, value = JSON \`{"order_id", "type", "ts"}\`, produced with \`acks=all\`; then \`poll(0)\`; then return | wait for the broker, or raise because of it |
| delivery callback | \`delivered += 1\` for an acknowledged record, \`failed += 1\` for a rejected one | run on its own — librdkafka only runs it inside \`poll\` / \`flush\` |
| \`stats()\` | \`{"delivered": n, "failed": n}\`, the two counts the callback keeps | guess from how many times \`produce\` returned |
| \`shutdown() -> int\` | \`flush(5)\`; return how many records were still undelivered — \`0\` after a clean stop | flush without a bound |

Three decisions make or break it, and the next three sections take one each: the **key** (which
partition, hence which order), **acks** (what an acknowledgement promises), and the **shutdown** (the
one place the producer is allowed to wait, and for how long).

# The key is the ordering contract

Kafka orders records **within a partition** and nowhere else. A topic with three partitions is three
independent logs; a consumer reading all three sees each one in order and the interleaving in whatever
order the network delivers. So "events of one order arrive in order" is only true if every event of
that order lands on the **same partition** — and the only thing that decides the partition is the key.

The default partitioner hashes the key bytes and takes the remainder:

\`\`\`text
partition = murmur2(key) % partition_count     # Java client; librdkafka uses the same by default
\`\`\`

| Key | Hashes to | Every event with this key |
| --- | --- | --- |
| \`o-1\` | partition 1 | \`created\`, \`paid\`, \`shipped\` — appended in emit order, read in emit order |
| \`o-2\` | partition 0 | its own log, independent of \`o-1\` |
| \`o-1\` again, tomorrow | partition 1 | the same partition, whatever happened in between |

Equal bytes, equal hash, equal partition. Three consequences:

- **The key is the order id, not the JSON.** The value also contains the id, but the partitioner never
  reads the value. Keying on the serialised event — different bytes for \`created\` and \`paid\` — scatters
  one order across partitions and the ordering guarantee is gone.
- **No key means no guarantee.** A null key is sticky-batched or round-robined across partitions; fine
  for metrics, wrong for anything that has a lifecycle.
- **Ordering is per key, not global.** \`o-1 paid\` can be read before \`o-2 created\` even if it was
  emitted after. Nothing in the system should need it otherwise.

:::widget kafka-partitions {"partitions": 3}

Partition count matters for one thing: **adding partitions changes the hash's modulus**, and keys move.
From that point on an order's old events are on one partition and its new ones on another. Pick the
count before there is data, and treat it as fixed.

:::quiz
Q: The value already contains \`order_id\`. Why must the record's key be the order id as well?
- [ ] So consumers can filter without parsing JSON
- [x] The partitioner hashes only the key; without it, one order's events spread across partitions and lose their order
- [ ] Kafka rejects records with a null key
> The partition decision is a function of the key bytes and nothing else. A consumer could parse the value, but by then the events are already on different partitions and the broker has already given up the only ordering it offers.
:::

# What an acknowledgement promises

The producer sends a batch to the partition's **leader**; the leader appends it and the **followers**
replicate it. \`acks\` says when the leader may answer:

| \`acks\` | The leader answers when | A record is lost if |
| --- | --- | --- |
| \`0\` | never — the producer does not wait at all | the packet is dropped, the leader dies, anything |
| \`1\` | it has written the batch to its own log | the leader dies before a follower copied it, and a follower becomes leader |
| \`all\` | every in-sync replica has the batch | all in-sync replicas die at once |

The failure \`acks=1\` leaves open is the one that matters, because it happens on an ordinary day — a
leader restarts for a deploy:

:::sequence
{
  "participants": ["Producer", "leader (broker 1)", "follower (broker 2)"],
  "messages": [
    {"from": "Producer", "to": "leader (broker 1)", "label": "batch · acks=1", "kind": "sync"},
    {"from": "leader (broker 1)", "to": "Producer", "label": "ack (offset 17) — written to its own log only", "kind": "reply"},
    {"from": "Producer", "to": "Producer", "label": "delivery callback → delivered += 1", "kind": "sync"},
    {"from": "leader (broker 1)", "to": "follower (broker 2)", "label": "replicate offset 17 … never sent: broker 1 crashes", "kind": "async"},
    {"from": "follower (broker 2)", "to": "follower (broker 2)", "label": "elected leader; its log ends at 16", "kind": "sync"},
    {"from": "follower (broker 2)", "to": "Producer", "label": "offset 17 does not exist. \\"delivered\\" was a lie", "kind": "async"}
  ]
}
:::

With \`acks=all\` the leader does not answer until broker 2 has the batch, so the ack and the record's
survival are the same event. The cost is one replication round-trip of latency per batch — paid by
the background thread, not by \`emit\`, which is why the drill can insist on it without the request
path noticing.

- \`acks=all\` is the **durability** half of the contract; \`min.insync.replicas\` on the topic is the
  other half, saying how many replicas "all" must mean before the leader refuses writes.
- An acknowledged record under \`acks=all\` **survives a leader failover**. That is the whole claim, and
  the only reason \`delivered\` is worth counting.
- A record the broker **rejects** — too large, topic missing, every retry exhausted — comes back
  through the same callback with an error, and that is \`failed\`.

Kafka's own account of the replication protocol is
[the replication section of the design docs](https://kafka.apache.org/documentation/#replication).

:::quiz
Q: A record was acknowledged with \`acks=1\`, the callback counted it as delivered, and the leader crashed a second later. Where is the record?
- [ ] On the new leader, because followers copy before the ack
- [x] Possibly nowhere: the ack only promised the old leader's log, and the new leader may never have seen it
- [ ] In the producer's queue, waiting to be resent
> With acks=1 the callback fires when one broker's disk has the batch. If that broker is gone before replication, the new leader's log is shorter and the offset the ack named was never there. acks=all moves the ack to after replication, so "delivered" means what the counter says.
:::

# Produce never waits: outcomes arrive through the callback

\`produce\` appends to the queue and returns in microseconds. The network, the batching, the
retries and the acknowledgement happen on the background thread, and the result for each record
is handed back as a **delivery report** — a callback with either a message (acknowledged, with its
partition and offset) or an error:

:::sequence
{
  "participants": ["orders", "Producer", "Kafka"],
  "messages": [
    {"from": "orders", "to": "Producer", "label": "produce(order-events, key=o-1, value=json, on_delivery=cb)", "kind": "async"},
    {"from": "orders", "to": "orders", "label": "poll(0) · return — microseconds, nothing waited for", "kind": "sync"},
    {"from": "Producer", "to": "Kafka", "label": "batch → partition hash(o-1) % 3, acks=all", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack (offset 17)", "kind": "reply"},
    {"from": "Producer", "to": "orders", "label": "delivery callback → delivered += 1 (on the next poll)", "kind": "async"}
  ]
}
:::

The rules the drill fixes, and why each one is there:

- **Produce returning says nothing about delivery.** It says the record is in the queue. The only
  honest place to learn what happened is the callback, so \`delivered\` and \`failed\` are counted there
  and nowhere else.
- **A failed delivery is a count, not an exception.** When the broker rejects a record, \`emit\` has
  already returned; the callback adds one to \`failed\`, and the next record goes out as usual. Raising
  would hit the wrong request — the one that happened to call \`poll\` — or no request at all.
- **Callbacks need a thread to run on.** librdkafka runs delivery reports only inside \`poll\` and
  \`flush\`, on the caller's thread, so the counters are touched without locks. Hence \`poll(0)\` right
  after every \`produce\`: serve whatever reports are ready, wait for none. Skip it and the reports
  queue up until \`shutdown\`, where they all land at once.
- **Batching is why this is cheap.** Records for the same partition that arrive within \`linger.ms\`
  go out as one request; a thousand \`emit\` calls can be a handful of round-trips.

\`\`\`python
def on_delivery(err, msg):
    if err is None: delivered += 1
    else:           failed += 1

producer.produce("order-events", key=order_id.encode(), value=value, on_delivery=on_delivery)
producer.poll(0)   # run callbacks that are ready; return immediately
\`\`\`

:::details Why the callback runs in poll rather than on the background thread
The Java client calls the callback from the I/O thread; librdkafka deliberately does not. Its
background thread only queues the report, and the application decides when reports are processed by
calling \`poll\`. The application's counters, loggers and locks are then only ever touched from the
application's own threads, and a slow callback slows the caller rather than the network. The price is
the discipline the drill asks for: something must call \`poll\` regularly, or nothing is ever reported.
librdkafka's [introduction](https://github.com/confluentinc/librdkafka/blob/master/INTRODUCTION.md)
covers the threading model in a page.
:::

:::quiz
Q: Why count \`delivered\` in the callback rather than incrementing it right after \`produce\` returns?
- [ ] The callback runs sooner
- [x] \`produce\` returning only means the record is queued; the broker's answer, including a rejection, comes later and only through the callback
- [ ] Counting after produce would need a lock
> Between produce and the ack the record can be retried, rejected or stranded by a dead broker. A counter bumped at produce time counts intentions; the callback counts outcomes, which is what stats() claims to report.
:::

# Shutdown: the one wait, and its bound

A process that stops with records in the producer's queue loses them — the queue is memory. So
\`shutdown\` must flush. But \`flush()\` with no timeout waits until the queue is empty, and if the broker
is not answering, that is never. The two naive versions, side by side with the drill's:

| Shutdown | Broker alive | Broker stalled |
| --- | --- | --- |
| no flush | the tail of the queue is lost, silently | the whole queue is lost, silently |
| \`flush()\` unbounded | drains, exits | **never returns**; the deploy hangs until someone kills the process, and then the queue is lost anyway |
| \`flush(5)\` | drains in milliseconds, returns \`0\`, exits | returns after 5 s with the count still queued; the process exits and the number is logged |

:::sequence
{
  "participants": ["orders", "Producer", "Kafka (stalled)"],
  "messages": [
    {"from": "orders", "to": "Producer", "label": "emit × 3 — produce, poll(0), return; each in microseconds", "kind": "async"},
    {"from": "Producer", "to": "Kafka (stalled)", "label": "batch · acks=all … no answer", "kind": "sync"},
    {"from": "orders", "to": "Producer", "label": "shutdown: flush(5)", "kind": "sync"},
    {"from": "Producer", "to": "Producer", "label": "serve callbacks, wait for acks … 5 s of clock time pass", "kind": "sync"},
    {"from": "Producer", "to": "orders", "label": "3 — still in the queue, neither delivered nor failed", "kind": "reply"},
    {"from": "orders", "to": "orders", "label": "log 3 undelivered; exit", "kind": "sync"}
  ]
}
:::

- \`flush(timeout)\` is \`poll\` in a loop until the queue is empty or the time is up, and returns the
  **number of records still queued**. That number is \`shutdown\`'s return value: \`0\` is a clean stop,
  anything else is the honest size of the loss.
- The records a bounded flush gives up on are **neither delivered nor failed**. No ack came, no
  rejection came; the callback never ran for them. \`stats()\` must not pretend otherwise.
- Five seconds is a budget the deploy tooling can plan around — a rolling restart of twenty
  instances costs at most a hundred seconds of flushing, not an unbounded wait on one dead broker.
- The ordering guarantee is unaffected by what a flush gives up: the records that did reach the
  partition are in emit order, and the lost ones are the tail.

The same shape appears wherever a process writes asynchronously and then exits — a bound on the
drain, and a count of what the bound cost. The producer's
[\`delivery.timeout.ms\`](https://kafka.apache.org/documentation/#producerconfigs_delivery.timeout.ms)
(\`message.timeout.ms\` in librdkafka) is the per-record version of the same idea: a deadline after
which a record fails through the callback instead of waiting.

:::widget deadline-retry {}

:::quiz
Q: The broker has been down for a minute and the process receives SIGTERM. What should \`shutdown()\` do?
- [ ] Call \`flush()\` and wait: a lost record is worse than a slow deploy
- [x] Call \`flush(5)\`, log the count it returns, and exit
- [ ] Skip the flush: the broker is down, so nothing can be delivered anyway
> An unbounded flush on a dead broker never returns; the process is eventually killed and loses the queue regardless, having also held up the deploy. Skipping the flush gives up records a broker that comes back in two seconds could still take. Five seconds and a number is the version an operator can reason about.
:::

# What a stalled broker costs, and what real producers add

Put the three decisions together and ask what a stalled broker does to the service:

- **The request path pays nothing.** \`emit\` is produce plus \`poll(0)\`; both return at once whether
  the broker is answering or not. Latency on the order endpoint does not move.
- **Memory grows.** Every \`emit\` adds a record to a queue that is not draining. In the drill that queue
  is unbounded; a broker outage long enough becomes an out-of-memory in the service.
- **The counters stop moving.** No acks, no rejections, so \`delivered\` and \`failed\` are flat while
  \`emit\` is still being called — the signal, if anyone graphs it, that something is wrong upstream.
- **Shutdown costs five seconds and reports the loss.** The process exits; the number says how much.

The drill leaves three things out on purpose, each one a producer setting away:

| What it leaves out | The setting | What it buys |
| --- | --- | --- |
| Duplicates after a lost ack | \`enable.idempotence=true\` | the broker dedupes retried batches by producer id and sequence, so a retry after a timed-out ack does not append twice — Kafka's route to [exactly-once on the produce side](https://kafka.apache.org/documentation/#semantics) |
| An unbounded queue | \`queue.buffering.max.messages\` (librdkafka) / \`buffer.memory\` (Java) | a full queue makes \`produce\` fail fast — or block, by policy — instead of growing until the process dies |
| Records held for ever | \`message.timeout.ms\` short enough | a record the broker has not taken in time fails through the callback and counts in \`failed\`, instead of sitting in the queue for the default five minutes |

Without idempotence a producer with retries is **at-least-once**: a batch whose ack was lost on the
wire is resent and appended again. The drill is the baseline those settings are layered on.

:::quiz
Q: With \`acks=all\` and retries on, the ack for a batch is lost on the network and the producer resends. What happens without \`enable.idempotence\`?
- [x] The batch is appended twice; consumers see each of its records two times
- [ ] The broker notices the duplicate by content and drops it
- [ ] The second send fails and the records count as failed
> The broker has no memory of what it already appended unless the producer carries an id and a sequence number per partition. That is exactly what idempotence adds; without it, a retry is just another produce request.
:::

# What to take away

- **The key is the ordering contract.** Equal key bytes hash to one partition; the order id as the key
  means an order's events are read in the order they were emitted, whatever the partition count.
- **acks=all is what makes "delivered" true.** The ack comes after replication, so an acknowledged
  record survives a leader failover; \`acks=1\` is an ack for a log that may be about to disappear.
- **Produce is an enqueue.** Outcomes come back through the delivery callback, which librdkafka runs
  only inside \`poll\` / \`flush\` — so \`poll(0)\` after every produce, count there, raise nowhere.
- **Shutdown flushes with a bound.** \`flush(5)\` drains a live broker in milliseconds and gives up on a
  dead one after five seconds, returning the number it could not deliver; that number is logged, not lost.
- **The rest is settings.** Idempotence against duplicates, a bounded queue against memory, a message
  timeout so a dead broker fails records instead of holding them.

The primary reference is the Kafka documentation's
[*Message delivery semantics*](https://kafka.apache.org/documentation/#semantics): two pages on what
acks, retries and idempotence each promise, in the project's own words.
`;
