/**
 * The learning guide for the ordered-merge drill: why Kafka's order stops at the partition edge,
 * what a watermark promises, what lateness and idleness do to that promise, and why the commit
 * follows the output rather than the input. A figure where one says it faster than prose, a pop quiz
 * per section. Rendered at `/kafka-ordered-merge-watermark/learn`; the download exports the same
 * Markdown.
 */
export const learn = `# The mechanism at a glance

A topic with six partitions is six logs. Each is in order on its own; together they are not. The
**merger** puts them back into one stream ordered by event time, the way a stream processor's
watermark operator does — buffer per partition, release what every partition has moved past:

:::diagram
{
  "nodes": [
    {"id": "sensors", "kind": "client", "label": "sensors", "sub": "{\\"sensor\\", \\"ts\\"} · keyed by sensor", "x": 10, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "sensor-readings", "sub": "6 partitions · each in rough ts order", "x": 45, "y": 50},
    {"id": "merger", "kind": "service", "label": "merger", "sub": "group merger · buffers · watermark · emit in ts order", "x": 82, "y": 50}
  ],
  "edges": [
    {"from": "sensors", "to": "kafka", "kind": "kafka", "label": "produce"},
    {"from": "kafka", "to": "merger", "kind": "kafka", "label": "poll · commit behind the frontier"}
  ]
}
:::

The contract the drill implements, in one module, \`merger\`:

- \`run(emit)\` joins consumer group \`merger\`, reads \`sensor-readings\` — JSON \`{"sensor", "ts"}\`, \`ts\`
  the event time in ms — and calls \`emit(reading)\` with \`{sensor, ts, partition, offset}\` in
  **global order by** \`ts\`. Auto-commit is off; \`auto.offset.reset\` is \`earliest\`.
- Two constants: \`LATENESS_MS\` = 2000, how far behind the watermark a reading may still be; and
  \`IDLE_MS\` = 10 000, how long a partition may be silent before it stops counting.
- \`stats()\` answers \`{emitted, dropped, buffered}\`.

Everything else — the buffers, the watermark, the drop rule, the commit rule — is a consequence of
one sentence: *a reading leaves only once no partition can still deliver anything older*.

# Order is per partition, and nowhere else

Kafka's ordering guarantee is exact and narrow: records with one key go to one partition, and within
a partition a consumer reads them in the order they were appended. Across partitions there is no
order at all — a poll returns whatever the brokers had ready, and the broker for partition 3 may
answer before the one for partition 0.

:::widget kafka-partitions {"partitions": 6}

What that looks like at the consumer, with three sensors keyed to three partitions:

| Poll returns | Partition | \`ts\` | In order? |
| --- | --- | --- | --- |
| 1st | p3 | 12:00:04 | — |
| 2nd | p0 | 12:00:01 | behind the previous reading |
| 3rd | p5 | 12:00:09 | — |
| 4th | p3 | 12:00:05 | fine within p3, behind p5 |

Each partition is *roughly* in \`ts\` order — one sensor, one clock, appended as produced — but the
union is a shuffle. A per-key aggregate or a by-sensor time series does not care. A session detector,
a window aggregate over all sensors, a replay into one chronological file does — and for those the
merge is the consumer's job; Kafka will not do it.

The obvious merges are wrong:

- **Sort each poll** — the next poll can bring something older than everything in this one.
- **Wait a fixed delay** — too short when one partition lags a minute, wasteful the rest of the time.
- **Round-robin the partitions** — merges by arrival, not by time.

The merge that is right is the one stream processors converged on: **k-way merge by timestamp,
bounded by a watermark**. The rest of this guide is that mechanism.

:::quiz
Q: A consumer polls six partitions and sorts each poll's batch by \`ts\` before emitting it. Why is the output still out of order?
- [ ] Sorting a batch is too slow to keep up with the brokers
- [x] The next poll can deliver, from a lagging partition, a reading older than everything already emitted
- [ ] Kafka reorders records inside a partition between polls
> Each batch is ordered, but batches are not ordered against each other: partition 2 may deliver its 12:00:01 reading three polls after partition 5 delivered 12:00:09. Order needs a bound on what can still arrive, and a batch has none.
:::

# The watermark: a promise made by the slowest partition

A **watermark** is a statement about the input: "no record with event time below *W* is still to
come." [Akidau's *Streaming 102*](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-102/)
makes it the central idea of event-time processing — it is what lets a system say a window is
complete, or a merge is safe, without waiting forever. Where does *W* come from? From the inputs
themselves. Each partition is roughly in order, so its newest \`ts\` is a fair estimate of where it
stands; the merge is only as far along as its slowest input, so:

\`\`\`text
watermark = min over partitions of (newest ts seen)
threshold = watermark − LATENESS_MS
release   = every buffered reading with ts <= threshold, sorted by (ts, partition, offset)
frontier  = ts of the last reading emitted
\`\`\`

Per partition the merger keeps four things: the **buffer** of pending readings, the **newest** \`ts\`
seen, the processing time of the **last delivery**, and the **offset after the last delivery**. The
happy path, from the drill's own trace:

:::sequence
{
  "participants": ["Kafka", "merger", "sink"],
  "messages": [
    {"from": "Kafka", "to": "merger", "label": "poll → p0@0 ts 1000, p1@0 ts 3000, p0@1 ts 5000", "kind": "reply"},
    {"from": "merger", "to": "merger", "label": "newest: p0 = 5000, p1 = 3000 → watermark 3000 → threshold 1000", "kind": "sync"},
    {"from": "merger", "to": "sink", "label": "emit ts 1000 (p0@0) · frontier = 1000", "kind": "async"},
    {"from": "merger", "to": "merger", "label": "p0@1 (5000) and p1@0 (3000) stay buffered: above the threshold", "kind": "sync"},
    {"from": "merger", "to": "Kafka", "label": "commit p0 → 1, p1 → 0 — the lowest offset still buffered", "kind": "sync"}
  ]
}
:::

| Partition | Buffered | Newest \`ts\` | Holds the watermark at |
| --- | --- | --- | --- |
| p0 | \`@1\` ts 5000 | 5000 | — |
| p1 | \`@0\` ts 3000 | 3000 | **3000** — the minimum |
| p2 – p5 | nothing | never delivered | not counted (see idle, below) |

Properties that make it correct:

- **Monotone.** Newest \`ts\` per partition only rises, so the watermark only rises, so the frontier
  only rises. Order is a consequence of a bound that never retreats.
- **The slowest input decides.** A partition a minute ahead does not pull the watermark forward; one
  a minute behind holds it back. That is the price of correctness, and the reason the next two
  sections exist.
- **A flush is one sort, not six.** Everything at or below the threshold, across all partitions,
  sorted together by \`(ts, partition, offset)\`; the tie-break makes the output deterministic.
- **Flush on every delivery, and at least once a second regardless.** The second clause is what
  makes the idle rule work.

:::quiz
Q: Partition 4 is forty seconds ahead of the others. What does that do to the watermark?
- [ ] Raises it: the newest reading anywhere is the best estimate of now
- [x] Nothing: the watermark is the minimum, and p4 is not the minimum
- [ ] Raises it by the average of the six partitions
> The watermark is a promise about what can still arrive, and p4 being ahead says nothing about what p1 still has. Only the slowest partition can keep the promise, so only it sets the watermark; p4's readings wait in its buffer.
:::

# Allowed lateness, and what arrives after the promise

"Roughly in order" is doing work in the sentence above. A sensor retries a send; a producer batches
and the batch lands out of order; two sensors share a partition and their clocks differ. So the
watermark is treated as an estimate and the merger keeps its distance: it releases only readings at
or below \`watermark − LATENESS_MS\`. With \`LATENESS_MS\` = 2000, a reading may trail its partition's
newest \`ts\` by two seconds and still find its place. The frontier is the \`ts\` of the last reading
emitted, and three fates follow from it:

| A reading arrives with | Relative to | Fate |
| --- | --- | --- |
| \`ts\` above \`watermark − LATENESS_MS\` | the threshold | buffered; waits for the watermark |
| \`ts\` at or below the threshold, at or above the frontier | the frontier | buffered; emitted in its place on the next flush |
| \`ts\` **below** the frontier | the frontier | **dropped and counted** — its slot has already been passed |

Only \`ts < frontier\` is late; equal is in time, because \`emit\` has not yet promised anything above the
frontier. The drill's trace: frontier is 1000, \`p0@2\` arrives with \`ts\` 900 — \`dropped\` becomes 1.
It still counts as a delivery: the partition's newest \`ts\` and last-delivery time move, so p0 stays
active.

Why drop rather than emit late? Because the output's contract is *in order*; a reading emitted
behind the frontier breaks every consumer that needed the merge in the first place. The honest
outcome is a counter the operator can graph: a rising \`dropped\` means the allowance is too small for
the input, or a sensor's clock is wrong. Real systems route late readings to a **side output** — a
second topic — instead of only counting them.

:::details Lateness as a dial between latency and completeness
\`LATENESS_MS\` = 0 emits the moment the slowest partition passes a reading: fastest output, and any
out-of-order pair inside a partition loses its older member. A large allowance catches more but holds
every reading that much longer — the output is always at least \`LATENESS_MS\` behind the slowest
partition. Akidau's framing: lateness is a knob between latency and completeness, set from the
measured distribution of how far behind its partition a reading arrives; \`dropped\` is how you find
out that distribution moved.
:::

:::quiz
Q: The frontier is 1000. A reading arrives with \`ts\` 1000 from a partition whose newest reading is 4000. What happens to it?
- [ ] Dropped: it is three seconds behind its partition, more than \`LATENESS_MS\`
- [x] Buffered, and emitted next flush: it is not below the frontier
- [ ] Emitted immediately, ahead of the flush
> Lateness relative to its own partition is what the allowance absorbs; the only test that drops is \`ts < frontier\`, and 1000 is not below 1000. It goes into the buffer and comes out in its place — after the 1000 already emitted, before anything higher.
:::

# Idle partitions: silence is not a promise

The minimum has a failure mode the happy path hides. A sensor is switched off. Its partition stops
delivering. Its newest \`ts\` stays where it was, and so does the watermark — forever. Every other
partition keeps filling its buffer and nothing is ever emitted:

:::sequence
{
  "participants": ["Kafka", "naive merger", "sink"],
  "messages": [
    {"from": "Kafka", "to": "naive merger", "label": "p1@0 ts 3000 … then nothing from p1, ever", "kind": "reply"},
    {"from": "Kafka", "to": "naive merger", "label": "p0 keeps delivering: ts 5000, 7000, 9000 …", "kind": "reply"},
    {"from": "naive merger", "to": "naive merger", "label": "watermark = min(9000, 3000) = 3000 — unchanged", "kind": "sync"},
    {"from": "naive merger", "to": "naive merger", "label": "threshold 1000; p0's buffer grows; p1@0 itself never leaves", "kind": "sync"},
    {"from": "naive merger", "to": "sink", "label": "(nothing — the stream is frozen at 3000)", "kind": "async"}
  ]
}
:::

The fix is the one Flink documents under
[dealing with idle sources](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/event-time/generating_watermarks/#dealing-with-idle-sources)
(\`withIdleness\`), and Kafka Streams under \`max.task.idle.ms\`: a partition that has delivered nothing
for \`IDLE_MS\` is **idle** and is left out of the minimum. The merger's watermark is the minimum
newest \`ts\` over the partitions that delivered within the last \`IDLE_MS\` = 10 000 ms of
*processing* time; when every partition is idle, it is the highest \`ts\` seen anywhere.

:::sequence
{
  "participants": ["Kafka", "merger", "sink"],
  "messages": [
    {"from": "Kafka", "to": "merger", "label": "10 s of empty polls — p1's last delivery is now IDLE_MS old", "kind": "reply"},
    {"from": "merger", "to": "merger", "label": "once-a-second flush: p1 idle → watermark = min over {p0} = 5000 → threshold 3000", "kind": "sync"},
    {"from": "merger", "to": "sink", "label": "emit ts 3000 (p1@0)", "kind": "async"},
    {"from": "merger", "to": "Kafka", "label": "commit p1 → 1 (buffer empty: position after last delivery)", "kind": "sync"}
  ]
}
:::

Three details carry the rule:

- **Idle is about processing time, not event time.** "Has this partition said anything lately" is
  answered by the wall clock — the only clock that advances while a partition is silent.
- **Release happens by time passing, not by records.** Nothing arrives from an idle partition to
  trigger a check; that is what the once-a-second flush on empty polls is for. Skip it and the
  stream freezes as in the naive trace.
- **A partition that wakes up re-enters the minimum.** If its first reading back is below the
  frontier, it is dropped — the stream moved on. A partition that never delivered counts as idle
  from the start, which is why four silent partitions do not block the two that speak.

Flink's newer [watermark alignment](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/event-time/generating_watermarks/#watermark-alignment)
addresses the opposite case: a partition so far *ahead* that its buffer grows without bound. It
pauses reading the fast source until the slow one catches up — bounded memory, same watermark. The
drill leaves buffer bounds out; a real merger needs one or the other.

:::quiz
Q: Partition 2's sensor is powered off at 12:00. With an idle rule of \`IDLE_MS\` = 10 s, what does the output do?
- [x] Pauses for up to ten seconds, then continues without p2 until it speaks again
- [ ] Stops until p2 delivers: the watermark cannot pass its newest reading
- [ ] Continues immediately: a partition with an empty buffer never holds the watermark
> Silence makes no promise either way, so the merger waits a bounded time for p2 to prove it is alive and then drops it from the minimum. An empty buffer is not the test — p2 had an empty buffer the whole time it was healthy too; the test is whether it has delivered within IDLE_MS of processing time.
:::

# Commit what you emitted, not what you read

A consumer's position in Kafka is the committed offset: on restart the group resumes from there.
With a plain consumer "processed" and "read" are the same record, and committing after each batch
is enough. The merger has state between the two — the buffers — and the commit must account for it.

:::sequence
{
  "participants": ["Kafka", "naive merger", "sink"],
  "messages": [
    {"from": "Kafka", "to": "naive merger", "label": "poll → p0@0 ts 1000, p0@1 ts 5000, p1@0 ts 3000", "kind": "reply"},
    {"from": "naive merger", "to": "sink", "label": "emit ts 1000 (p0@0)", "kind": "async"},
    {"from": "naive merger", "to": "Kafka", "label": "commit p0 → 2, p1 → 1 — \\"everything I read\\"", "kind": "sync"},
    {"from": "naive merger", "to": "naive merger", "label": "crash; p0@1 and p1@0 were only in memory", "kind": "sync"},
    {"from": "Kafka", "to": "naive merger", "label": "restart resumes at p0@2, p1@1 — ts 5000 and 3000 are gone", "kind": "reply"}
  ]
}
:::

Auto-commit does exactly this: it commits the position after the last poll, which is the position
after the last *read*. Hence \`enable.auto.commit\` off, and a commit the merger computes itself,
after a flush that emitted, per partition:

\`\`\`text
commit[p] = lowest offset still buffered on p
          = offset after the last delivery, when p's buffer is empty
\`\`\`

- **Never above an unemitted reading.** In the trace, \`p0@0\` was emitted but \`p0@1\` is buffered, so
  p0 commits \`1\`. "Highest emitted + 1" is the wrong formula even where it gives the same number:
  a reading can be emitted while an older offset of its partition still waits; the lowest buffered
  offset is the only number a restart can rebuild the buffer from.
- **Only when it changed.** A partition whose number did not move sends no commit; six commits per
  flush is noise the brokers do not need.
- **Replay, not skip.** A crash after the commit re-reads everything from the lowest buffered offset;
  some of it was already emitted. That is
  [at-least-once](https://kafka.apache.org/documentation/#semantics) delivery, and the consumer
  downstream must tolerate the duplicate — the alternative, committing ahead, is at-most-once with
  silent holes in a stream that promised order.

:::widget delivery-semantics {}

Real systems **checkpoint the buffers** — Flink snapshots operator state and Kafka offsets together
— so they can commit further ahead and restart from the snapshot. Without one, the buffers are the
state, and the committed offset is the one thing that lets a restart rebuild them.

:::quiz
Q: Partition 3 has \`@7\` emitted, \`@8\` emitted, \`@9\` buffered, \`@10\` buffered, \`@11\` emitted (it had a lower \`ts\` than \`@9\`). What does the merger commit for p3?
- [ ] 12 — the position after the highest emitted offset
- [x] 9 — the lowest offset still buffered
- [ ] 8 — the last offset before anything was buffered
> After a crash the buffer is empty and whatever was in it must come back from Kafka; the only offset that brings back @9 and @10 is 9. @11 will be re-read and re-emitted — a duplicate, which at-least-once allows; committing 12 would lose two readings, which an ordered stream cannot explain.
:::

# What to take away

- **Order stops at the partition edge.** Within a partition, exact; across partitions, none. A
  consumer that needs one time-ordered stream merges, and the merge is its own responsibility.
- **A watermark is a promise, and only the slowest input can make it.**
  \`min(newest ts per partition)\`: hold everything above it, release everything at or below
  \`watermark − LATENESS_MS\` in one sort by \`(ts, partition, offset)\`.
- **Lateness is a dial, not a bug.** The allowance is the distance you keep from the promise; what
  arrives below the frontier is dropped and counted, never emitted out of place.
- **Silence is not a promise.** A partition quiet for \`IDLE_MS\` leaves the minimum, and the release
  is driven by the clock — flush on empty polls, or the stream freezes.
- **Commit behind the output.** Auto-commit off; per partition, the lowest buffered offset or the
  position after the last delivery; replay beats skipping.

The primary reference is Tyler Akidau's
[*Streaming 102*](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-102/) (O'Reilly,
2016): the *what / where / when / how* of event-time processing, with watermarks, allowed lateness
and the latency-versus-completeness trade-off worked through in pictures. Flink's
[watermark generation](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/event-time/generating_watermarks/)
page is the production-grade version of the idle and alignment rules.
`;
