/**
 * The learning guide for the idempotent-producer drill: where the lost-ack duplicate comes from, how
 * the producer id and sequence numbers remove it, and the three rules — retry bounded, park the rest,
 * hold the caller back — that a delivery callback adds around it. A figure or a demo where one says it
 * faster than prose, a pop quiz per section. Rendered at `/kafka-idempotent-producer/learn`.
 */
export const learn = `# The mechanism at a glance

A Kafka producer is a pipeline with three places to fail: the client's send, the broker's write, the
acknowledgement on the way back. The **idempotent producer** — shipped in Kafka 0.11 under
[KIP-98](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging)
— makes the client's own retries safe by numbering its batches so the broker can recognise a resend.
The drill wraps one such producer in a module of three functions:

:::diagram
{
  "nodes": [
    {"id": "emitter", "kind": "service", "label": "event emitter", "sub": "send · stats · shutdown · callback decides", "x": 25, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "events", "sub": "key = event_id · 3 partitions · PID + seq per batch", "x": 70, "y": 50}
  ],
  "edges": [
    {"from": "emitter", "to": "kafka", "kind": "kafka", "label": "produce · acks=all · idempotent"},
    {"from": "kafka", "to": "emitter", "kind": "kafka", "label": "delivery report"}
  ]
}
:::

- \`send(event_id, payload)\` — one record on \`events\`, key \`event_id\`, value \`payload\`; returns as
  soon as the client has it. The outcome arrives later, in the delivery callback.
- \`stats()\` — \`{delivered, retried, dead, pending}\`: records acknowledged, retries issued, the ids
  given up on in order, records in flight right now.
- \`shutdown()\` — flush for at most \`FLUSH_TIMEOUT_S = 3\` seconds; return how many records were
  still in flight when it gave up.

The producer is configured with \`enable.idempotence=true\` and \`acks=all\`. Around it, three constants
carry the rules: \`MAX_RETRIES = 3\` re-produces per record, \`MAX_PENDING = 100\` records in flight,
\`FLUSH_TIMEOUT_S = 3\` on the way out.

# The lost ack: where the duplicate comes from

A broker that writes a batch and then fails to answer looks, from the client's chair, exactly like a
broker that never received it. The client has to guess. Before idempotence, \`retries > 0\` meant
"guess *not written* and resend" — and the broker, with no way to tell a resend from a new batch,
appended it again:

:::sequence
{
  "participants": ["caller", "Producer (no idempotence)", "Kafka"],
  "messages": [
    {"from": "caller", "to": "Producer (no idempotence)", "label": "produce(events, key=e1, value)", "kind": "async"},
    {"from": "Producer (no idempotence)", "to": "Kafka", "label": "batch [e1]", "kind": "sync"},
    {"from": "Kafka", "to": "Kafka", "label": "appended at offset 41", "kind": "sync"},
    {"from": "Kafka", "to": "Producer (no idempotence)", "label": "ack lost", "kind": "reply"},
    {"from": "Producer (no idempotence)", "to": "Kafka", "label": "retry: batch [e1] again", "kind": "sync"},
    {"from": "Kafka", "to": "Kafka", "label": "appended at offset 42 — a second copy", "kind": "sync"},
    {"from": "Kafka", "to": "Producer (no idempotence)", "label": "ack", "kind": "reply"},
    {"from": "Producer (no idempotence)", "to": "caller", "label": "delivery report: ok (once) — the topic holds two", "kind": "async"}
  ]
}
:::

The alternative guess, \`retries = 0\`, loses the record whenever the ack is what failed. That is the
[at-least-once / at-most-once](https://kafka.apache.org/documentation/#semantics) fork every
messaging system faces, and neither branch is what an order system or an audit log wants. The retry
itself is correct — the record *might* not be there; the missing piece is on the broker: a way to
recognise a batch it has already written.

:::widget delivery-semantics {}

:::quiz
Q: A producer sends a batch, the broker writes it, and the acknowledgement is lost on the network. Without idempotence, what are the client's two choices?
- [ ] Ask the broker whether it wrote the batch, then decide
- [x] Resend and risk a duplicate, or give up and risk losing the record
- [ ] Wait for the ack to arrive; acks are never truly lost
> A lost ack is indistinguishable from a lost request. The client can only guess, and each guess fails in one direction: resending duplicates a written batch, not resending drops an unwritten one. Only the broker knows which happened, which is why the fix lives there.
:::

# Producer id and sequence numbers

KIP-98 gives the broker what it needs. At start-up the producer asks a broker for a **producer id**
(PID). Every batch it sends carries that PID and a **sequence number** per partition, starting at 0
and increasing by one per batch. The partition leader remembers, for each PID, the last sequence it
appended — and treats a batch whose sequence it has already seen as a resend:

| Batch arrives with | Leader's last sequence for this PID | What the leader does |
| --- | --- | --- |
| \`seq = last + 1\` | 6 → batch is 7 | append, remember 7, ack |
| \`seq ≤ last\` | 7 → batch is 7 again | **do not append**; ack as if it had — this is the lost-ack resend |
| \`seq > last + 1\` | 6 → batch is 9 | reject with \`OutOfOrderSequenceException\`; something was skipped |

The drill's happy path, with the ack lost once:

:::sequence
{
  "participants": ["caller", "Producer", "Kafka"],
  "messages": [
    {"from": "caller", "to": "Producer", "label": "produce(events, key=e1, value) · pending 1", "kind": "async"},
    {"from": "Producer", "to": "Kafka", "label": "batch (PID 1042, seq 7)", "kind": "sync"},
    {"from": "Kafka", "to": "Kafka", "label": "last seq 6 → append, last seq 7", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack lost", "kind": "reply"},
    {"from": "Producer", "to": "Kafka", "label": "resend (PID 1042, seq 7)", "kind": "sync"},
    {"from": "Kafka", "to": "Kafka", "label": "seq 7 ≤ last 7 → written once, not appended", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack", "kind": "reply"},
    {"from": "Producer", "to": "caller", "label": "delivery report: ok → delivered 1, pending 0", "kind": "async"}
  ]
}
:::

On the client this is configuration, nothing more:

\`\`\`text
enable.idempotence = true      # librdkafka, Java         idempotent: true   (kafkajs)
acks               = all       # every in-sync replica    acks: -1           (kafkajs)
\`\`\`

- \`acks=all\` is required: the sequence table is replicated with the log, so the dedupe survives a
  leader change only if the batch did. With \`acks=1\` it would be a promise the next leader cannot keep.
- The client's retries become effectively unlimited; the real bound is \`delivery.timeout.ms\`, after
  which the record reaches the callback as a failure.
- The guarantee is **per producer session, per partition**. A restarted producer gets a new PID, so a
  record whose ack was lost across a crash can still appear twice; transactions close that gap, and
  the drill leaves them out.
- Because gaps are rejected too, batches stay **in order** within a partition even with several
  requests in flight — up to \`max.in.flight.requests.per.connection ≤ 5\`.

The same idea from an HTTP API: a request retried with the same idempotency key gets the first
response replayed, not a second side effect. The key is \`(PID, seq)\`; the server's key store is the
leader's sequence table.

:::widget idempotency {}

:::details What idempotence does not dedupe
The broker compares sequence numbers, not record contents. Two calls to \`send\` with the same
\`event_id\` are two batches with two sequences and both are written — the key only chooses the
partition. Dedupe by business key belongs to the consumer, or to a transaction that spans the
read-process-write. Confluent's
[*Exactly-once semantics are possible*](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
walks through why the producer side alone is called "effectively once" and what transactions add.
:::

:::quiz
Q: Why does \`enable.idempotence\` require \`acks=all\` rather than working with \`acks=1\`?
- [ ] Because sequence numbers are only assigned when all replicas are in sync
- [x] Because the dedupe state must survive a leader change, and only a fully replicated write guarantees that
- [ ] Because \`acks=1\` disables retries in the client
> The leader deduplicates by remembering the last sequence per producer. If the leader dies after acking with \`acks=1\`, the new leader may not have the batch or the sequence that goes with it; the client's resend would then be appended as new. With \`acks=all\`, the write and the sequence state are on every in-sync replica before the ack.
:::

# Retriable or fatal: the delivery callback decides

Idempotence makes the *client's* retries safe. But the client gives up eventually — the message
timeout passes, the transport breaks — and what it hands the callback is an error with a verdict
attached: **retriable** or not. The callback has three outcomes and nothing else:

| The report says | Meaning | The callback does |
| --- | --- | --- |
| no error | the record is on the topic, once | \`delivered += 1\` |
| retriable (\`_MSG_TIMED_OUT\`, \`_TRANSPORT\`, \`NOT_LEADER_FOR_PARTITION\`, …) | the broker may be fine in a moment | re-produce the same key and value, \`retried += 1\` — while \`attempt < MAX_RETRIES\` |
| not retriable (\`MSG_SIZE_TOO_LARGE\`, \`TOPIC_AUTHORIZATION_FAILED\`, unknown topic, …) | trying again gives the same answer | \`dead.append(event_id)\` |

The split is the client library's, not yours: \`err.retriable()\` in librdkafka, \`RetriableException\`
in the Java client. A message that is too large will be too large at 3 a.m. too. Two rules keep the
callback honest:

- **Same key, same value.** A retry is the same record; the key puts it on the same partition, so a
  consumer that keys on \`event_id\` sees the same stream it would have seen without the failure.
- **The attempt rides with the record.** The callback must know *which* record and *which* attempt it
  is reporting on — a closure over \`(event_id, payload, attempt)\`, a promise chain, the message
  opaque, a callback object — because the producer does not remember it for you.

:::sequence
{
  "participants": ["callback", "Producer", "Kafka"],
  "messages": [
    {"from": "Kafka", "to": "Producer", "label": "— (message timeout, nothing heard)", "kind": "async"},
    {"from": "Producer", "to": "callback", "label": "report: _MSG_TIMED_OUT (retriable) · e1 attempt 0 · pending 0", "kind": "async"},
    {"from": "callback", "to": "Producer", "label": "produce(events, key=e1, value) · attempt 1 · retried 1 · pending 1", "kind": "async"},
    {"from": "Producer", "to": "Kafka", "label": "batch (seq 8)", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "ack", "kind": "reply"},
    {"from": "Producer", "to": "callback", "label": "report: ok · e1 attempt 1 → delivered 1, pending 0", "kind": "async"}
  ]
}
:::

Note the sequence number: the retry is a *new* batch (seq 8), not a resend of seq 7. The client had
already given up on seq 7, so the broker's dedupe cannot help — the callback's retry is at-least-once
by nature, and that residual risk is what the message timeout is tuned against: long enough that the
client's own safe retries usually succeed, short enough that a dead partition is noticed.

:::quiz
Q: The delivery report for a record says the message was too large for the broker. What should the callback do?
- [ ] Retry up to \`MAX_RETRIES\` times; the limit might be raised meanwhile
- [x] Park the id in \`dead\` immediately; retrying cannot change the answer
- [ ] Split the payload and send it as two records
> A non-retriable error is the broker saying no and meaning it. Spending three retries on it delays the verdict and spends in-flight slots that other records need. Parking it keeps the pipeline moving and leaves the operator a list to act on.
:::

# Bounded retries and a dead list

A retriable error that keeps coming back — a partition whose leader is gone for an hour — must not
keep one record looping forever. Attempts start at 0; a retry happens only while
\`attempt < MAX_RETRIES\`:

| Attempt | Report | \`attempt < 3\`? | Outcome | \`retried\` | \`dead\` |
| --- | --- | --- | --- | --- | --- |
| 0 | timed out | yes | re-produce as attempt 1 | 1 | \`[]\` |
| 1 | timed out | yes | re-produce as attempt 2 | 2 | \`[]\` |
| 2 | timed out | yes | re-produce as attempt 3 | 3 | \`[]\` |
| 3 | timed out | **no** | give up | 3 | \`["e1"]\` |

Four failures — \`MAX_RETRIES + 1\` — and the id is parked. Two timeouts then a success is \`retried 2\`,
\`delivered 1\`, \`dead\` empty, one record on the topic.

- **One record counts once.** Every report ends in exactly one of \`delivered\`, a retry, or \`dead\`.
- **A list, in order**, not a counter: the ids in \`dead\` are what an operator or a replay job needs.
  Real producers write them to a **dead-letter topic**; the drill keeps the list in memory.
- **The next record is unaffected.** A parked \`e1\` does not block \`e2\`.

\`\`\`python
def _on_delivery(err, event_id, payload, attempt):
    pending -= 1                                  # the report has arrived, whatever it says
    if err is None:          delivered += 1; return
    if err.retriable() and attempt < MAX_RETRIES:
        retried += 1; _produce(event_id, payload, attempt + 1); return
    dead.append(event_id)
\`\`\`

:::quiz
Q: With \`MAX_RETRIES = 3\`, how many times is a record produced before it is parked, and what does \`retried\` read?
- [ ] 3 times; \`retried\` is 3
- [x] 4 times; \`retried\` is 3
- [ ] 4 times; \`retried\` is 4
> The first attempt is not a retry. Attempts 0, 1 and 2 each fail with \`attempt < 3\` and are re-produced — three retries — and attempt 3 fails with the bound reached. Four produces, three counted retries, one id in \`dead\`.
:::

# The in-flight window is backpressure, and flush has a deadline

\`send\` returns before the broker answers; that is what makes a producer fast, and what makes a slow
broker dangerous: every record handed over sits in client memory until its report arrives. Two
reflexes are wrong — dropping the record (at-most-once, chosen by accident) and letting the queue
grow (an out-of-memory, scheduled for later). The third is right: **hold the caller back**.

\`pending\` counts produces minus reports: \`+1\` at every produce, first attempt and retry alike, \`-1\`
at the top of the callback. \`send\` refuses to produce while \`pending >= MAX_PENDING\`:

\`\`\`python
def send(event_id, payload):
    while pending >= MAX_PENDING:
        producer.poll(0.1)        # serves delivery reports — the only thing that frees a slot
    _produce(event_id, payload, 0)
    producer.poll(0)              # serve whatever reports are already waiting
\`\`\`

:::sequence
{
  "participants": ["caller", "send", "Producer", "Kafka"],
  "messages": [
    {"from": "caller", "to": "send", "label": "send(e101) · pending 100 = MAX_PENDING", "kind": "sync"},
    {"from": "send", "to": "Producer", "label": "poll(0.1) … poll(0.1) — broker stalled, no reports", "kind": "sync"},
    {"from": "Kafka", "to": "Producer", "label": "(5 s later) acks for the first batches", "kind": "async"},
    {"from": "Producer", "to": "send", "label": "reports served → callbacks → pending 97", "kind": "async"},
    {"from": "send", "to": "Producer", "label": "produce(e101) · pending 98 · poll(0)", "kind": "async"},
    {"from": "send", "to": "caller", "label": "returns — 5 s late, nothing dropped", "kind": "reply"}
  ]
}
:::

- **Polling is not optional.** In librdkafka the delivery callbacks run inside \`poll\`; a loop that
  waits on \`pending\` without polling waits forever, because nothing can decrement it. In kafkajs the
  equivalent is awaiting the first in-flight delivery promise to settle.
- **Retries count.** A re-produce from the callback is \`+1\` like any produce; a storm of retries
  cannot slip past the window.
- **The bound is the signal.** With the broker stalled for 5 s and 150 sends, at most 100 are ever
  waiting; the rest wait their turn, and every record lands once the broker answers. \`pending\` is the
  first number that moves when a broker is in trouble — the metric to graph.

Real producers have the same window one layer down: \`queue.buffering.max.messages\` (librdkafka),
\`buffer.memory\` with \`max.block.ms\` (Java). The drill makes the bound explicit so the caller, not
the library, decides how it behaves.

## Flush with a timeout

A stopping process owns records nobody else has: in the client's queue, on no topic. \`flush\` serves
reports until the queue is empty — and against a dead broker, "until" is the message timeout, which
can be minutes. So the wait is bounded:

\`\`\`python
def shutdown() -> int:
    return producer.flush(timeout=FLUSH_TIMEOUT_S)   # 3 s; returns how many are still in flight
\`\`\`

- Broker healthy: \`flush\` returns 0 well inside the bound; every callback has run, \`stats()\` is final.
- Broker dead, one record in flight: \`shutdown()\` returns **1** after about 3 seconds — not after the
  message timeout. Zero means a clean stop; anything else is the number of events the next operator
  conversation is about. A \`flush\` without a bound reports nothing, because it never returns.
- \`FLUSH_TIMEOUT_MS = 3000\` is the same constant where the client takes milliseconds.

:::quiz
Q: The broker stops answering and the caller keeps calling \`send\`. What is the right behaviour at the 101st unacknowledged record?
- [ ] Drop it and increment a counter; the caller must not be slowed
- [x] Block in \`send\`, polling for delivery reports, until a report frees a slot
- [ ] Queue it; the broker will catch up when it returns
> For an event stream, a dropped record is a lost event and an unbounded queue is a crash scheduled for later. Blocking the caller moves the problem to where it belongs — upstream — at the cost of latency, which is the honest cost of a broker that is not answering. Polling while blocked is what makes the block end.
:::

# What to take away

- **A lost ack is the duplicate's origin.** The client cannot tell "not written" from "written, ack
  lost"; before idempotence its retry was a coin toss between a duplicate and a loss.
- **Idempotence is a broker-side table.** A producer id and a per-partition sequence number let the
  leader recognise a resend and write it once; \`enable.idempotence\` with \`acks=all\` is the whole
  client-side cost. The guarantee is per producer session — a restart or a business-level duplicate
  is not covered.
- **The callback decides, by verdict.** Success counts once; a retriable error is re-produced with the
  same key while \`attempt < MAX_RETRIES\`; a fatal error or an exhausted record goes to \`dead\`, in
  order, where a real system has a dead-letter topic.
- **The window is backpressure.** \`pending\` is produces minus reports; \`send\` polls while it is at
  \`MAX_PENDING\`, so a stalled broker slows the caller instead of filling memory or dropping events.
- **Flush with a deadline and report the remainder.** \`shutdown()\` waits \`FLUSH_TIMEOUT_S\` and
  returns what is still in flight — a clean stop is a zero, anything else is a number to act on.

The primary reference is
[KIP-98: Exactly Once Delivery and Transactional Messaging](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging),
the design document that introduced the producer id and sequence numbers; the
[producer configuration reference](https://kafka.apache.org/documentation/#producerconfigs_enable.idempotence)
states what \`enable.idempotence\` requires of \`acks\`, \`retries\` and the in-flight limit.
`;
