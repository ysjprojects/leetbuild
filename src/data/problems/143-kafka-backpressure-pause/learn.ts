/**
 * The learning guide for the backpressure drill: why a consumer's fetch side outruns its work side,
 * why it cannot simply stop polling, and how pause/resume over a bounded queue with two water marks
 * keeps memory flat and offsets honest. Rendered at `/kafka-backpressure-pause/learn`.
 */
export const learn = `# The mechanism at a glance

A Kafka consumer **fetches in bulk** and a worker **processes one record at a time**. When the work
is slow — a model call, a PDF render, a third-party API — the fetch side runs ahead, and whatever
sits between them grows. **Pause/resume with hysteresis** is the standard answer: fetch into a queue
bounded at a high-water mark, pause the partitions there, resume at a low-water mark, and keep
calling \`poll\` the whole time so the consumer stays in its group.

:::diagram
{
  "nodes": [
    {"id": "producers", "kind": "client", "label": "producers", "sub": "jobs, keyed by tenant", "x": 10, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "jobs", "sub": "3 partitions · group workers", "x": 45, "y": 50},
    {"id": "worker", "kind": "service", "label": "worker", "sub": "poll loop → queue ≤ HIGH → drain loop", "x": 80, "y": 50}
  ],
  "edges": [
    {"from": "producers", "to": "kafka", "kind": "kafka", "label": "produce"},
    {"from": "kafka", "to": "worker", "kind": "kafka", "label": "poll · pause · resume · commit"}
  ]
}
:::

The drill is a module \`backpressure\` with four entry points:

| Function | Contract |
| --- | --- |
| \`run(worker)\` | subscribe to \`jobs\` as group \`workers\`, \`enable.auto.commit\` off; run the poll loop and the drain loop; return once \`stop()\` has ended both |
| \`worker(job)\` | awaited by the drain loop with \`job = {partition, offset, value}\`, \`value\` decoded as text |
| \`stats()\` | \`{queued, paused, processed}\` — records waiting, whether the partitions are paused, records committed |
| \`stop()\` | stop polling, let the drain loop finish what is queued, close the consumer |

Three constants carry the behaviour:

- \`HIGH = 20\` — the poll loop pauses the whole assignment when the queue reaches it.
- \`LOW = 5\` — the drain loop resumes the assignment when a paused queue is down to it.
- \`IDLE_S = 0.01\` — how long the poll loop sleeps after an empty poll, so the drain loop gets
  the CPU.

The same loop, in different clothes, is inside Kafka Streams, Flink's Kafka source and every job
runner built on a consumer group.

# Fetch and work are two different speeds

The consumer client is built to be fast: a single \`poll\` returns a batch, the fetcher prefetches
the next one in the background, and a topic with a backlog hands over thousands of records a
second. The worker is as slow as the slowest thing it calls. Put a queue between them without a
bound and the arithmetic is simple:

\`\`\`text
fetch   1000 records / s
work     100 records / s   (10 ms each)
growth   900 records / s   → 54,000 in a minute, 3.2 million in an hour
\`\`\`

[Little's law](https://en.wikipedia.org/wiki/Little%27s_law) gives the same answer from the other
side: records in the system = arrival rate × time spent in it, and with the work side slower than
the fetch side, time spent in the queue has no upper limit. The process does not degrade; it is
killed for memory, usually with every record it had in flight uncommitted.

:::sequence
{
  "participants": ["Kafka", "poll loop", "queue", "drain loop"],
  "messages": [
    {"from": "poll loop", "to": "Kafka", "label": "poll → 500 records", "kind": "sync"},
    {"from": "poll loop", "to": "queue", "label": "append × 500 → 500 queued", "kind": "sync"},
    {"from": "drain loop", "to": "queue", "label": "pop one → worker (10 ms)", "kind": "sync"},
    {"from": "poll loop", "to": "Kafka", "label": "poll → 500 more", "kind": "sync"},
    {"from": "poll loop", "to": "queue", "label": "append × 500 → 999 queued", "kind": "sync"},
    {"from": "drain loop", "to": "queue", "label": "pop one → worker", "kind": "sync"},
    {"from": "poll loop", "to": "queue", "label": "… an hour later: 3.2 million queued, process killed", "kind": "async"}
  ]
}
:::

Why decouple the two at all, then, rather than process each record inside the poll loop? Because
the two loops have different jobs and different tempos:

- The **poll loop** must keep running regardless of the worker: it is how the client serves
  callbacks and stays in the group (next section). It only ever appends and pauses.
- The **drain loop** owns the slow part and the commits. It only ever pops, commits and resumes.
- Neither blocks on the other. The queue is the only shared state — plus one \`paused\` flag.

The queue must be **FIFO**: the drain loop processes records in the order they were fetched, which
is offset order within each partition. A bound changes how many records sit there, never which
order they leave in.

:::quiz
Q: The worker is ten times slower than the fetcher and the topic has a backlog of a million records. Without a bound, what limits the queue?
- [ ] The broker's fetch size: the consumer only gets one batch at a time
- [ ] The worker: the queue stops growing once the worker is busy
- [x] Nothing but memory: the fetcher never waits for the worker, so growth is the difference between the two rates
> A poll returns as soon as a batch is ready, and the next batch is prefetched while the worker is busy. The worker's speed sets how fast the queue drains, not how fast it fills. Without a bound the process is killed for memory, and nothing it held was committed.
:::

# Why the consumer cannot just stop polling

The obvious bound is to block: when the queue is full, do not call \`poll\` until there is room. It
fails because \`poll\` is not only how records arrive. In the Kafka client, calling it is how the
consumer **proves it is alive and making progress**:

| Signal | What carries it | Timeout | What happens past it |
| --- | --- | --- | --- |
| heartbeat | a background thread (Java), or the client's own \`poll\` cycle | \`session.timeout.ms\` | the group coordinator declares the member dead |
| progress | each call to \`poll\` | [\`max.poll.interval.ms\`](https://kafka.apache.org/documentation/#consumerconfigs_max.poll.interval.ms) (default 5 min) | the client leaves the group; its partitions are rebalanced away |
| rebalance callbacks | served inside \`poll\` | — | a consumer that is not polling cannot be told its assignment changed |

The second row is the trap. A consumer stuck behind a full queue stops calling \`poll\`; after
\`max.poll.interval.ms\` the broker hands its partitions to another member of \`workers\`. That member
starts from the last **committed** offset — and the stuck consumer had a queue full of fetched,
uncommitted records. Every one of them is fetched again by the new owner:

:::sequence
{
  "participants": ["Kafka", "consumer A", "consumer B"],
  "messages": [
    {"from": "consumer A", "to": "Kafka", "label": "poll → jobs[0]@12 … @31 queued; worker busy", "kind": "sync"},
    {"from": "consumer A", "to": "consumer A", "label": "queue full → stops calling poll", "kind": "sync"},
    {"from": "Kafka", "to": "consumer A", "label": "max.poll.interval.ms elapsed: evicted from workers", "kind": "async"},
    {"from": "Kafka", "to": "consumer B", "label": "rebalance: jobs[0] assigned, start at committed offset 12", "kind": "async"},
    {"from": "consumer B", "to": "Kafka", "label": "poll → jobs[0]@12 … again", "kind": "sync"},
    {"from": "consumer A", "to": "consumer A", "label": "worker finishes @12 … @31 — duplicated by B, commits rejected", "kind": "sync"}
  ]
}
:::

The outcome is worse than the memory problem it replaced: the slow worker is now processing records
that another consumer is also processing, its commits fail because it no longer owns the partition,
and when B falls behind the same way, the group rebalances again. A consumer group with slow workers
and a blocking bound **rebalances in a loop**.

> The rule: a consumer that wants fewer records must keep calling \`poll\`. The question is how to
> make a call to \`poll\` return nothing.

:::quiz
Q: The queue is full, so the poll loop sleeps until the drain loop frees a slot. The worker takes eight minutes to clear twenty records. What does the broker do?
- [ ] Nothing: the consumer's heartbeat thread keeps the session alive
- [x] After \`max.poll.interval.ms\` it treats the consumer as failed and rebalances its partitions to another member, which refetches everything the sleeping consumer had queued
- [ ] It buffers the records on the broker side until the consumer polls again
> Heartbeats prove the process is up; \`poll\` proves it is making progress. Eight minutes without a poll is past the five-minute default, so the partitions move. The new owner starts at the committed offset, which is behind everything the sleeping consumer fetched — all of it is processed twice.
:::

# Pause: in the group, delivering nothing

The client's answer is
[\`pause\` and \`resume\`](https://kafka.apache.org/39/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html#consumption-flow-control-heading).
A paused partition stays assigned; the fetcher simply stops asking the broker for it, and \`poll\`
returns no records from it. Everything else \`poll\` does — heartbeats, the progress signal,
rebalance callbacks — carries on. The drill's happy path:

:::sequence
{
  "participants": ["Kafka", "poll loop", "queue", "drain loop"],
  "messages": [
    {"from": "poll loop", "to": "Kafka", "label": "poll", "kind": "sync"},
    {"from": "Kafka", "to": "poll loop", "label": "jobs[1]@37", "kind": "reply"},
    {"from": "poll loop", "to": "queue", "label": "append → 20 queued = HIGH", "kind": "sync"},
    {"from": "poll loop", "to": "Kafka", "label": "pause(assignment) · paused = true", "kind": "sync"},
    {"from": "poll loop", "to": "Kafka", "label": "poll → nothing (paused); sleep IDLE_S", "kind": "sync"},
    {"from": "drain loop", "to": "queue", "label": "pop jobs[0]@12 → worker", "kind": "sync"},
    {"from": "drain loop", "to": "Kafka", "label": "commit jobs[0] → 13", "kind": "sync"},
    {"from": "drain loop", "to": "queue", "label": "… pops until 5 queued = LOW", "kind": "sync"},
    {"from": "drain loop", "to": "Kafka", "label": "resume(assignment) · paused = false", "kind": "sync"},
    {"from": "Kafka", "to": "poll loop", "label": "jobs[2]@40 (fetching again)", "kind": "reply"}
  ]
}
:::

The rules the loop follows:

- **Pause the assignment, not the record.** The bound is on the whole queue, so every assigned
  partition stops: \`consumer.pause(consumer.assignment())\` in Python, \`pause([{topic: TOPIC}])\`
  in TypeScript. A consumer that pauses only the partition the last record came from keeps filling
  the queue from the other two.
- **Check right after the append.** \`queue.qsize() >= HIGH\` immediately after \`put_nowait(msg)\`;
  the record that made it twenty is the last one in until the drain loop makes room.
- **Keep polling while paused.** \`consumer.poll(0)\` returns \`None\`; the loop sleeps \`IDLE_S\`
  and calls it again. That sleep is also what lets the drain loop run.
- **Resume from the drain side.** The drain loop is the one that knows the queue is shrinking;
  after a commit, \`paused and queue.qsize() <= LOW\` → \`consumer.resume(consumer.assignment())\`.
- **Yield between records.** \`await asyncio.sleep(0)\` after each append, so a burst of twenty
  records from one poll does not starve the drain loop.

\`\`\`python
msg = consumer.poll(0)                      # still called while paused: callbacks are served, records are not
if msg is None:
    await asyncio.sleep(IDLE_S)
    continue
queue.put_nowait(msg)
if queue.qsize() >= HIGH:
    consumer.pause(consumer.assignment())
    paused = True
await asyncio.sleep(0)                      # let the drain task run between records
\`\`\`

A worker that keeps up never triggers any of this: the queue hovers near zero, \`paused\` stays
false, and the consumer behaves exactly as one without a bound. Backpressure is a mechanism that
engages only when the drain loop falls behind.

:::widget consumer-groups {"partitions": 3}

:::quiz
Q: What does \`poll\` return while every assigned partition is paused, and why is calling it still necessary?
- [x] Nothing — but the call still heartbeats, signals progress and serves rebalance callbacks, so the consumer keeps its partitions
- [ ] The records it already fetched, so the queue keeps growing until resume
- [ ] An error, because a fully paused consumer has nothing to do
> Pause stops the fetcher from asking for a partition; it does not stop the group protocol. The call is cheap and returns at once, and it is what distinguishes "I want no records right now" from "I am dead".
:::

# Two marks, not one

If the consumer paused at twenty and resumed at nineteen, it would pause and resume on nearly every
record: each resume refills the queue to twenty within one poll, each commit drops it to nineteen.
Every pause and resume is a client call and a change in what the fetcher requests, and a consumer
that flaps between them spends its time on flow control instead of work. The fix is
[hysteresis](https://en.wikipedia.org/wiki/Hysteresis): two thresholds with a gap between them, so
the state changes only after a meaningful amount of work.

A worker ten times slower than the fetcher, traced through the queue length:

| Event | \`queued\` | \`paused\` | What happens |
| --- | --- | --- | --- |
| poll returns a batch | 0 → 20 | false → **true** | the twentieth append reaches \`HIGH\`: pause the assignment |
| poll, poll, poll … | 20 | true | nothing returned; sleep \`IDLE_S\` each time |
| drain pops and commits | 19, 18, … 6 | true | fifteen records of work, no client calls for flow control |
| drain commits, 5 left | 5 | true → **false** | \`<= LOW\`: resume the assignment |
| poll returns again | 5 → 20 | false → **true** | pause again — one cycle per fifteen records, not per record |
| topic drained | 0 | false | the last resume stands; a consumer with nothing queued is never paused |

The two marks have different owners and different jobs:

- \`HIGH\` **bounds memory.** It is the most records ever held: the poll loop checks it after every
  append and nothing can push past it, except the batch granularity discussed below.
- \`LOW\` **bounds churn.** The gap \`HIGH − LOW\` is the minimum amount of work between a resume and
  the next pause. \`LOW\` is above zero so the worker is not left idle while the first fetch after a
  resume is in flight.
- \`stats()\` reports the **live** values — \`queue.qsize()\` and the flag — so an operator can see
  the cycle, not a counter updated later.

:::details Batch granularity, and why the Java client caps max.poll.records
The drill's \`poll(0)\` returns one record at a time, so the check after each append holds the queue
at exactly \`HIGH\`. The Java client's \`poll\` returns a batch, and the check can only run after the
batch is appended — a queue at nineteen that receives a batch of five hundred overshoots to 519. Real
consumers on that client cap \`max.poll.records\` so one poll cannot push far past the high-water
mark, and the honest bound is \`HIGH + max.poll.records\`.
:::

:::quiz
Q: A team sets \`LOW = 19\` to keep the worker as busy as possible. What do they get?
- [ ] A faster worker: the queue is always nearly full
- [x] A pause and a resume for almost every record: a resume refills the queue to twenty, one commit drops it to nineteen, and the consumer flaps
- [ ] Lower memory, because the queue never shrinks below nineteen
> The worker is no faster; its speed is set by the work. What changes is the consumer's overhead: the gap between the marks is the amount of work per flow-control cycle, and a gap of one makes the cycle run per record. Twenty and five give fifteen records of work per cycle.
:::

# Commit the work, not the fetch

With auto-commit on, the client commits the **position** — the offset after the last record
\`poll\` returned — on a timer. In a consumer with a queue, the position is twenty records ahead of
the worker. A crash then loses everything in the queue: the next owner starts at the committed
offset, which is past records nobody processed.

:::sequence
{
  "participants": ["Kafka", "poll loop", "queue", "drain loop"],
  "messages": [
    {"from": "poll loop", "to": "Kafka", "label": "poll → jobs[0]@12 … @31", "kind": "sync"},
    {"from": "poll loop", "to": "Kafka", "label": "auto-commit: jobs[0] → 32 (the position)", "kind": "async"},
    {"from": "drain loop", "to": "queue", "label": "pop @12 → worker", "kind": "sync"},
    {"from": "drain loop", "to": "drain loop", "label": "process crashes with @13 … @31 queued", "kind": "sync"},
    {"from": "Kafka", "to": "poll loop", "label": "new owner starts at 32: nineteen records never processed", "kind": "async"}
  ]
}
:::

The drill turns auto-commit off (\`"enable.auto.commit": False\`) and commits from the drain loop,
**after** the worker returns, from the record it popped:

\`\`\`python
msg = await queue.get()
await worker({"partition": msg.partition(), "offset": msg.offset(), "value": msg.value().decode()})
consumer.commit(message=msg, asynchronous=False)   # commits offset + 1 for that partition
processed += 1
\`\`\`

What that buys, and what it costs:

| | Auto-commit | Commit after the worker |
| --- | --- | --- |
| committed offset | the position: ahead of the work by up to \`HIGH\` | at most the records the worker has finished |
| crash with twenty queued | twenty records **lost** | twenty records **replayed** |
| guarantee | at-most-once for anything in the queue | [at-least-once](https://kafka.apache.org/documentation/#design_consumerposition) |
| lag once the topic is drained | zero | zero — every processed record was committed |

At-least-once means the worker may see a record twice after a crash, so the job it does should be
idempotent — the standard price, and the one every serious consumer pays. The FIFO queue makes the
commit sequence per partition monotone: records leave in offset order, so each commit is one past
the previous.

:::widget delivery-semantics {}

:::quiz
Q: The consumer crashes with twenty records in its queue. With commits made after the worker returns, what does the next owner of the partition do?
- [ ] Starts after the twenty records, which are lost
- [x] Starts at the last committed offset and fetches the twenty again — a replay, not a loss
- [ ] Waits for the crashed consumer's queue to be recovered
> Nothing in the queue was committed, because commits follow the worker. The twenty records are fetched again by whoever owns the partition next. The worker may see some of them a second time, which is why its job should tolerate a repeat.
:::

# What to take away

- **Fetch and work run at different speeds.** A queue between them without a bound grows at the
  difference between the two rates until the process is killed, with everything in it uncommitted.
- **A consumer that wants fewer records must keep polling.** \`poll\` carries heartbeats, the
  progress signal behind \`max.poll.interval.ms\` and rebalance callbacks; blocking it turns a slow
  worker into a rebalance loop.
- **Pause the assignment at the high mark, resume at the low.** Pausing keeps the partitions and makes
  \`poll\` return nothing; the gap between the marks is the amount of work per flow-control cycle.
- **Commit from the drain loop, after the worker.** Offsets follow the work, never the fetch; a
  crash replays the queue instead of losing it.
- **Real consumers add** byte-based bounds, per-partition pausing when one key runs hot, commits
  routed back to the poll thread on single-threaded clients, and a cap on \`max.poll.records\` so
  one poll cannot overshoot the mark.

The primary reference is the Kafka consumer's own documentation on
[consumption flow control](https://kafka.apache.org/39/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html#consumption-flow-control-heading)
— \`pause\`, \`resume\`, and the section before it on detecting consumer failures, which explains
why \`max.poll.interval.ms\` exists and what tripping it does.
`;
