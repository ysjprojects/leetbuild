/**
 * The learning guide for Batch by count or by time: the one Kafka mechanism the drill rests on —
 * closing a batch on whichever of two conditions comes first and committing once per batch — with
 * a figure where one says it faster than prose and a pop quiz per section.
 * Rendered at `/kafka-batch-consumer/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A consumer that writes one row per record pays the sink's round trip for every record; one that
waits for a thousand records writes nothing on a quiet afternoon. Every sink connector — Kafka
Connect's Elasticsearch, ClickHouse and S3 sinks, every hand-written warehouse loader — sits between
those two with **two knobs and one rule**: collect records into a batch, close it on whichever comes
first, hand it to the sink in one call, commit once.

:::diagram
{
  "nodes": [
    {"id": "kafka", "kind": "kafka", "label": "metrics", "sub": "3 partitions · group rollup", "x": 15, "y": 50},
    {"id": "consumer", "kind": "service", "label": "batch consumer", "sub": "run(flush) · BATCH_SIZE 50 · BATCH_WAIT_MS 500", "x": 50, "y": 50},
    {"id": "sink", "kind": "db", "label": "rollup store", "sub": "flush(records): one write per batch", "x": 85, "y": 50}
  ],
  "edges": [
    {"from": "kafka", "to": "consumer", "kind": "kafka", "label": "poll"},
    {"from": "consumer", "to": "sink", "kind": "plain", "label": "flush(batch)"},
    {"from": "consumer", "to": "kafka", "kind": "kafka", "label": "commit last offset + 1 per partition"}
  ]
}
:::

The contract the drill implements, \`run(flush)\`:

- A member of consumer group \`rollup\` reads \`metrics\` from the earliest offset with
  **auto-commit off**.
- \`BATCH_SIZE = 50\`, \`BATCH_WAIT_MS = 500\`. A batch closes on whichever comes first: it holds 50
  records, or 500 ms have passed since collecting it started.
- A closed batch is \`flush(records)\` **once**, the records exactly as the client delivered them, in
  delivery order. \`flush\` is never called with an empty batch.
- After \`flush\` returns, **one synchronous commit**: for every partition present in the batch, its
  highest offset + 1. A partition absent from the batch is absent from the commit.
- The next batch starts after the last one, empty: no record is flushed twice, none is skipped.

# Why batch: amortise the write and the commit

A sink call and a commit each cost a round trip, and neither cost grows much with what it carries.
One record per call pays both prices per record; a batch pays them once per batch.

| Shape | Sink calls per 10,000 records | Commits | Cost per record |
| --- | --- | --- | --- |
| one record per write, commit each | 10,000 | 10,000 | two round trips |
| 50 per batch, one commit per batch | 200 | 200 | 1/50 of two round trips |
| 1,000 per batch | 10 | 10 | tiny — but see the next section |

Bulk APIs make the gap wider than the arithmetic: Elasticsearch's \`_bulk\`, ClickHouse's one
\`INSERT\` with many rows, an S3 part upload — each is designed for one large call and is slow or
rate-limited for many small ones. The commit is the same story on the broker side: a
[committed offset](https://kafka.apache.org/documentation/#design_consumerposition) is a write to
\`__consumer_offsets\`, and committing after every record turns the offsets topic into the hottest
topic in the cluster.

The Kafka client is already batching underneath you. A poll fetches as many records as the broker
has ready, capped by
[\`max.poll.records\`](https://kafka.apache.org/documentation/#consumerconfigs_max.poll.records);
the consumer's job is to keep that shape all the way to the sink instead of unrolling it into one
call per record. In librdkafka the whole loop is one call:

\`\`\`python
batch = consumer.consume(BATCH_SIZE, BATCH_WAIT_MS / 1000)   # up to 50, or whatever arrived in 500 ms
\`\`\`

:::widget consumer-groups {"partitions": 3}

:::quiz
Q: A loader writes one row to the warehouse per record and commits after each. Where does the time go?
- [ ] Deserialising each record
- [x] Two round trips per record — the sink's and the broker's — regardless of how small the record is
- [ ] Rebalances triggered by the frequent commits
> Both the write and the commit are fixed-cost round trips. Carrying 50 records in each divides both costs by 50 without changing what is written; nothing about the record itself was the bottleneck.
:::

# Two conditions, one rule: count or clock

A batch of a fixed size is the wrong tool on its own. When the topic is busy it fills in
milliseconds; when the topic goes quiet the 49 records already collected wait for a 50th that may
be an hour away. So the batch is closed by **whichever comes first**, and each condition bounds a
different thing:

| Condition | Closes when | What it bounds | What it costs |
| --- | --- | --- | --- |
| count — \`BATCH_SIZE\` 50 | the 50th record arrives | how much one sink call carries; how much is at risk between flush and commit | nothing on a busy topic |
| clock — \`BATCH_WAIT_MS\` 500 | 500 ms since the batch's **first** record | how stale the sink may be when the stream is quiet | a smaller batch on a quiet one |

The step's happy path, three partitions, 70 records arriving:

:::sequence
{
  "participants": ["Kafka", "rollup consumer", "store"],
  "messages": [
    {"from": "Kafka", "to": "rollup consumer", "label": "poll → 50 records (p0 0–16, p1 0–16, p2 0–15) — count closes the batch", "kind": "reply"},
    {"from": "rollup consumer", "to": "store", "label": "flush(50 records)", "kind": "sync"},
    {"from": "store", "to": "rollup consumer", "label": "ok", "kind": "reply"},
    {"from": "rollup consumer", "to": "Kafka", "label": "commit {p0: 17, p1: 17, p2: 16}", "kind": "sync"},
    {"from": "Kafka", "to": "rollup consumer", "label": "poll → 20 records, then nothing for 500 ms — clock closes the batch", "kind": "reply"},
    {"from": "rollup consumer", "to": "store", "label": "flush(20 records)", "kind": "sync"},
    {"from": "store", "to": "rollup consumer", "label": "ok", "kind": "reply"},
    {"from": "rollup consumer", "to": "Kafka", "label": "commit {p0: 24, p1: 24, p2: 22}", "kind": "sync"}
  ]
}
:::

Two clients, two ways to say the same thing:

- **librdkafka** (\`confluent_kafka\`): \`consumer.consume(BATCH_SIZE, BATCH_WAIT_MS / 1000)\` returns
  up to 50 messages and gives up after 500 ms. The count and the clock are the two arguments; the
  wait is the whole wait.
- **kafkajs** has no batch call on this surface: \`eachMessage\` delivers one record at a time. The
  batch is a list filled across calls; the **first** record arms \`setTimeout(flushBatch,
  BATCH_WAIT_MS)\`, the 50th calls \`flushBatch\` directly and clears the timer.

The clock runs from the batch's first record, not from the previous flush, not from the last
record. A timer reset by every arrival never fires on a topic that trickles one record every 400 ms;
a timer started at the previous flush closes an empty window on a quiet topic. Started at the first
record, it promises exactly one thing: no record waits more than 500 ms before it is in the sink.

:::quiz
Q: The topic delivers one record every 100 ms. With \`BATCH_SIZE = 50\` and \`BATCH_WAIT_MS = 500\`, what does the sink see?
- [ ] One write of 50 records every 5 s
- [x] One write of about 5 records every 500 ms
- [ ] One write per record, since the count is never reached
> The count would need 5 s to close; the clock closes the batch at 500 ms with whatever has arrived. That is the point of the second condition: the sink is never more than 500 ms behind, however slow the stream.
:::

# The commit is the batch's receipt

Kafka does not acknowledge records; a consumer
[commits a position](https://kafka.apache.org/documentation/#design_consumerposition) per partition,
and the position is the offset of the **next** record to read. The commit is therefore built from
the batch — the highest offset seen per partition, plus one — and nothing else:

\`\`\`text
batch of 50:  p0 0–16   p1 0–16   p2 0–15
commit:       {p0: 17,  p1: 17,   p2: 16}       highest + 1, per partition present

batch of 20:  p0 17–23  p1 17–23  p2 16–21
commit:       {p0: 24,  p1: 24,   p2: 22}
\`\`\`

- **Per partition.** Offsets are per partition; a batch spanning three partitions produces three
  entries. A partition the batch never touched is **left out** — committing it would mean
  committing a position for records the sink has not seen.
- **Highest + 1.** The committed offset is where the next consumer starts. Committing the highest
  offset itself replays that record on every restart.
- **After the flush, synchronous.** \`flush\` returns, then the commit; the commit blocks until the
  broker has it. Auto-commit is off because the client's timer-driven commit knows nothing about
  whether the flush happened.
- **From the batch, not from the position.** \`consumer.position()\` after a poll already points
  past records still sitting in the batch; committing it before the flush is the lost-update race.

The race the rule prevents, drawn against the correct order:

:::sequence
{
  "participants": ["Kafka", "naive consumer", "store"],
  "messages": [
    {"from": "Kafka", "to": "naive consumer", "label": "poll → 50 records (p0 0–16, p1 0–16, p2 0–15)", "kind": "reply"},
    {"from": "naive consumer", "to": "Kafka", "label": "auto-commit fires: commit position {p0: 17, p1: 17, p2: 16}", "kind": "sync"},
    {"from": "naive consumer", "to": "store", "label": "flush(50 records) — crashes mid-write", "kind": "sync"},
    {"from": "Kafka", "to": "naive consumer", "label": "restart → resumes at {17, 17, 16}: records 0–16 never reach the store", "kind": "reply"}
  ]
}
:::

With the commit after the flush, the same crash restarts at \`{0, 0, 0}\` and the 50 records are
flushed again: **at-least-once, batch-granular** — the one batch between flush and commit is the
largest thing that can be replayed, and \`BATCH_SIZE\` is what bounds it. That is Kafka's
[delivery semantics](https://kafka.apache.org/documentation/#semantics) applied to a batch rather
than a record; an idempotent sink (an upsert keyed on the record, a \`_bulk\` index by id) turns the
replay into a no-op.

:::widget delivery-semantics {}

:::quiz
Q: A batch holds records from p0 and p1 only. What should the commit contain for p2?
- [ ] p2 at its current position, so the consumer's view stays consistent
- [x] Nothing — p2 is absent from the batch, so it is absent from the commit
- [ ] p2 at 0, to be safe
> A commit says "everything before this offset is in the sink". The batch carried nothing from p2, so there is nothing new to say about it; committing its position anyway would skip records the batch never held.
:::

# Never flush an empty batch

Both clients can hand the loop nothing: \`consume()\` returns an empty list after 500 ms of silence,
and in kafkajs a timer armed by the first record can fire after the count already closed the batch.
An empty batch closes nothing:

- No \`flush([])\` — a sink call with no rows is a round trip for nothing, and some bulk APIs reject
  it.
- No commit — there is no offset to commit; a commit built from an empty batch is an empty map, and
  a commit built from the position instead would be the race above.
- The clock restarts with the **next** first record, not now.

The subtler failure is in the timer version, where the count and the clock race each other:

:::sequence
{
  "participants": ["eachMessage", "batch list", "timer", "store"],
  "messages": [
    {"from": "eachMessage", "to": "batch list", "label": "record 1 — arm setTimeout(flushBatch, 500)", "kind": "sync"},
    {"from": "eachMessage", "to": "batch list", "label": "record 50 — count closes: flushBatch()", "kind": "sync"},
    {"from": "batch list", "to": "store", "label": "await flush(50 records) — list not swapped out", "kind": "sync"},
    {"from": "timer", "to": "batch list", "label": "fires mid-flush: still sees 50 records", "kind": "async"},
    {"from": "batch list", "to": "store", "label": "flush(the same 50 records) — duplicate write, duplicate commit", "kind": "sync"}
  ]
}
:::

Two lines fix it, in this order:

\`\`\`typescript
const records = batch;   // take the batch
batch = [];              // the next one starts empty, before any await
if (records.length === 0) return;
clearTimeout(timer);
await flush(records);
await consumer.commitOffsets(nextOffsets(records));
\`\`\`

Swap the list out **before** the first \`await\`, so a timer firing mid-flush finds an empty list
and returns before calling \`flush\` at all; clear the timer when the count closes the batch so it
does not fire for nothing. The same rule, stated for the sink: the next batch starts after the last
one, empty, so no record is flushed twice and none is skipped.

:::quiz
Q: In the kafkajs version, the 50th record closes the batch while the 500 ms timer is still armed. What must be true when that timer fires?
- [x] It finds an empty list and returns without calling \`flush\` or committing
- [ ] It flushes whatever arrived since, even if that is nothing
- [ ] It re-arms itself for another 500 ms
> The count already took the batch and cleared the timer; if the timer fires anyway, the empty-batch rule is what makes it harmless. A timer that flushes an empty list makes a sink call and a commit for nothing — or, if the list was not swapped out first, flushes the same records twice.
:::

# Latency against throughput: the two numbers

The two constants are the only tuning the mechanism has, and they pull in opposite directions:

| Raise | Throughput | Latency | Replay on crash |
| --- | --- | --- | --- |
| \`BATCH_SIZE\` | up: fewer, larger sink calls | unchanged on a busy topic; irrelevant on a quiet one | up: more records between flush and commit |
| \`BATCH_WAIT_MS\` | up on a quiet topic: fuller batches | up: the sink may be that far behind | unchanged |

- Throughput is bounded **below** by the count: on a busy topic every sink call carries 50 records,
  never fewer.
- Latency is bounded **above** by the clock: no record waits more than 500 ms in the consumer,
  however quiet the topic.
- A busy topic never meets the clock; a quiet topic never meets the count. The pair covers both
  without the operator knowing which one today is.

:::details What production connectors add
The drill is the two-condition close and the one commit. A real sink connector adds, in roughly this
order: a **byte** bound next to the record bound, since 50 records of 1 MB each is not a 50-record
batch to the sink; committing what it holds when a partition is **revoked** (\`on_revoke\`), so a
rebalance does not replay a flushed batch; **pausing** the partition when the sink is slow instead of
letting the loop exceed \`max.poll.interval.ms\` and be thrown out of the group; and a **retry or
dead-letter** path for a failed flush rather than a crash loop that replays the same batch into the
same failure. None changes the shape: collect, close on count or clock, flush once, commit the
receipt.
:::

:::quiz
Q: Operators report the rollup store is 500 ms behind during the quiet night hours and want it fresher. Which knob, and what does it cost?
- [ ] Lower \`BATCH_SIZE\`; batches close sooner
- [x] Lower \`BATCH_WAIT_MS\`; night batches get smaller, so the sink sees more, smaller writes
- [ ] Raise \`BATCH_SIZE\`; larger batches are faster to write
> At night the count is never reached, so it is not what closes the batch — the clock is. Lowering the clock is the only change that moves night-time latency, and its price is paid at the sink in smaller calls.
:::

# What to take away

- **Batch to amortise two round trips**, the sink's and the broker's; the client already fetches in
  batches, so keep the shape to the sink instead of unrolling it.
- **Close on whichever comes first.** The count bounds what one call carries and what a crash
  replays; the clock, running from the batch's first record, bounds how stale the sink may be.
- **The commit is the batch's receipt**: after the flush, synchronous, built from the batch — the
  highest offset + 1 for every partition present, nothing for the ones absent.
- **An empty batch closes nothing**: no flush, no commit; swap the list out before the first await so
  a late timer finds nothing to do.
- **At-least-once, batch-granular**: a crash between flush and commit replays one batch; an
  idempotent sink makes the replay free.

The primary reference is the Kafka documentation's
[consumer position and commit semantics](https://kafka.apache.org/documentation/#design_consumerposition)
alongside the
[\`max.poll.records\`](https://kafka.apache.org/documentation/#consumerconfigs_max.poll.records)
consumer setting: the offset is a position, not an acknowledgement, and the consumer — not the broker
— decides when a record counts as delivered.
`;
