/**
 * The learning guide for the replay-from-offset drill: the log as a replayable history, assigning
 * partitions instead of joining a group, seeking, snapshotting the end so a replay terminates, and
 * why a tool never commits. A figure or a table where one says it faster than prose, a pop quiz per
 * concept. Rendered at `/kafka-replay-from-offset/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A Kafka topic is a log, and a log can be read again. The **replay tool** is a consumer that does not
belong to the live group: it asks the broker where every partition ends *now*, assigns the partitions
itself at the offset it wants, reads up to that snapshot, and closes without committing a thing.

:::diagram
{
  "nodes": [
    {"id": "tool", "kind": "service", "label": "replay tool", "sub": "group replay-tool · assign · seek · never commits", "x": 18, "y": 30},
    {"id": "kafka", "kind": "kafka", "label": "order-events", "sub": "3 partitions · a log per partition", "x": 55, "y": 50},
    {"id": "live", "kind": "service", "label": "live consumers", "sub": "group orders · own committed offsets", "x": 18, "y": 70},
    {"id": "producers", "kind": "client", "label": "producers", "sub": "keep appending during the replay", "x": 88, "y": 50}
  ],
  "edges": [
    {"from": "tool", "to": "kafka", "kind": "kafka", "label": "watermarks · assign · poll"},
    {"from": "live", "to": "kafka", "kind": "kafka", "label": "subscribe · poll · commit"},
    {"from": "producers", "to": "kafka", "kind": "kafka", "label": "produce"}
  ]
}
:::

The contract: \`replay(topic, from_offset, handler)\` hands every record of every one of the
\`PARTITIONS\` (3) partitions, from \`from_offset\` up to the end that existed when the call started, to
\`handler\` as a \`ReplayRecord\` (\`partition\`, \`offset\`, \`key\`, \`value\`) in each partition's offset
order, and returns how many it handled. It runs as group \`replay-tool\` with auto-commit off, commits
nothing, and the live group \`orders\` finds its committed offsets exactly where it left them.

- **Rewind** — \`assign\` (Python, Java) or \`subscribe\` + \`seek\` (kafkajs) puts every partition at
  \`from_offset\`; \`0\` is the beginning.
- **Bounded** — the high watermark of each partition, read before the first fetch, is the stop line.
- **Side-effect free** — a tool that commits would move someone else's bookmark.

# The log is a history, not a queue

In a message queue a delivered message is gone. In Kafka a record is appended to a partition at the
next **offset** and stays there until retention expires it, whoever has read it. Reading does not
consume; a consumer only moves its own **position** — an integer per partition, the offset of the
next record it will read. The broker keeps almost no per-consumer state, which is
[why Kafka's consumer model is cheap](https://kafka.apache.org/documentation/#design_consumerposition):
acknowledging a record is incrementing a number, and rewinding is decrementing it.

:::widget kafka-partitions {"partitions": 3}

Each partition has two edges the tool cares about:

| Watermark | Meaning | Python | kafkajs |
| --- | --- | --- | --- |
| **low** | the oldest offset still retained | \`get_watermark_offsets(tp)[0]\` | \`fetchTopicOffsets\` → \`low\` |
| **high** | the offset the *next* append will get; one past the last record | \`get_watermark_offsets(tp)[1]\` | \`fetchTopicOffsets\` → \`high\` |

A partition with records at offsets \`0, 1, 2, 3\` has \`high = 4\`. \`high\` is exclusive — the records
to read are \`[from_offset, high)\`, and when \`from_offset >= high\` there is nothing to read.

Because the history stays, the same records serve three kinds of reader at once:

- the **live group**, reading the tail as it grows and committing as it goes;
- a **replay**, reading a fixed stretch of the past once, for a backfill or a rebuilt projection;
- a **new subscriber** started weeks later, reading from \`low\` to build its own state from scratch.

The same mechanism underlies [event sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) and
log-based integration: if the log is the source of truth, any derived view can be thrown away and
rebuilt by reading it again from an offset.

:::quiz
Q: A projection is corrupted by a bug deployed yesterday. The live group has already committed past every affected record. Can those records be read again?
- [x] Yes — commits move the group's position, they do not remove records; another consumer can read from any retained offset
- [ ] No — a committed record is acknowledged and the broker discards it
- [ ] Only if the live group is stopped and its offsets reset
> A committed offset is a bookmark owned by one group. The records stay in the partition until retention removes them, and a consumer that chooses its own position can read them regardless of what any group has committed.
:::

# Assign, not subscribe

A consumer can get its partitions two ways, and they are not interchangeable:

| | \`subscribe(topic)\` | \`assign([TopicPartition(topic, p, offset)])\` |
| --- | --- | --- |
| Who picks the partitions | the group coordinator, balanced across members | the caller, explicitly |
| Starting position | the group's committed offset; \`auto.offset.reset\` when there is none | the offset given, or \`seek\` afterwards |
| Rebalances | yes — joining or leaving reshuffles everyone | none — no group membership |
| Right for | the live service | a tool that wants a fixed stretch of a fixed set of partitions |

The naive replay subscribes to \`order-events\` — and worse, in group \`orders\`, because that is the
config lying around. It joins the live group, the coordinator rebalances, and half the partitions
move from the service to the tool:

:::sequence
{
  "participants": ["replay tool", "coordinator", "live consumer"],
  "messages": [
    {"from": "replay tool", "to": "coordinator", "label": "subscribe order-events, group orders", "kind": "sync"},
    {"from": "coordinator", "to": "live consumer", "label": "rebalance — revoke [1], [2]", "kind": "async"},
    {"from": "coordinator", "to": "replay tool", "label": "assigned [1], [2] at the group's committed offsets", "kind": "reply"},
    {"from": "replay tool", "to": "replay tool", "label": "reads from the bookmark, not from from_offset", "kind": "sync"},
    {"from": "live consumer", "to": "live consumer", "label": "serves [0] only until the tool leaves", "kind": "sync"},
    {"from": "replay tool", "to": "coordinator", "label": "close → another rebalance", "kind": "async"}
  ]
}
:::

Three things went wrong at once: the live service lost partitions for the duration, the tool started
at the group's bookmark instead of the offset it was given, and the tool's membership was a second
live consumer, not a replay. The drill's tool avoids all of it by never joining the live group:

- Python and Java: \`assign\` with \`TopicPartition(topic, p, from_offset)\` for \`p\` in \`0..2\` — no
  \`subscribe\`, no coordinator involvement in the assignment.
- kafkajs: \`subscribe({topic, fromBeginning: true})\`, then \`seek({topic, partition, offset})\` on each
  of the three partitions before the first fetch. kafkajs always goes through a group, so the tool gets
  its own group id, \`replay-tool\`, which has no members the replay could disturb.

:::widget consumer-groups {"partitions": 3}

> The group id on a replay tool is a label, not a membership. \`replay-tool\` exists so that the live
> group is never named; with auto-commit off and no commit call, nothing is ever stored under it.

:::quiz
Q: Why does the replay tool pass an explicit offset to every partition rather than rely on \`auto.offset.reset: earliest\`?
- [ ] Because \`earliest\` is slower than a seek
- [x] Because \`auto.offset.reset\` only applies when the group has no committed offset; a seek or assigned offset applies always, and to any offset, not just the ends
- [ ] Because \`earliest\` is not allowed with \`assign\`
> \`auto.offset.reset\` is a fallback for the *absence* of a bookmark and only knows two places, earliest and latest. A replay wants a specific offset regardless of what any group has committed, so it sets its position directly.
:::

# Where to stop: a snapshot of the end

A replay needs two fixed ends. The start is given. The end is the problem: producers keep appending
while the replay runs, so "read until there is nothing left" is a target that moves at the write
rate, and a backfill that chases it never finishes — it has become a second live consumer with no
commits. The fix is to decide the end **before reading anything**: read each partition's high
watermark once and treat it as the stop line.

:::sequence
{
  "participants": ["replay tool", "Kafka"],
  "messages": [
    {"from": "replay tool", "to": "Kafka", "label": "watermarks for order-events[0..2]", "kind": "sync"},
    {"from": "Kafka", "to": "replay tool", "label": "high = {0: 4, 1: 2, 2: 3}", "kind": "reply"},
    {"from": "replay tool", "to": "Kafka", "label": "assign [0..2] at offset 1 (group replay-tool)", "kind": "sync"},
    {"from": "replay tool", "to": "Kafka", "label": "poll", "kind": "sync"},
    {"from": "Kafka", "to": "replay tool", "label": "order-events[1]@1 → handler", "kind": "reply"},
    {"from": "replay tool", "to": "Kafka", "label": "pause [1] (position 2 reached end 2)", "kind": "async"},
    {"from": "Kafka", "to": "replay tool", "label": "[0]@1 … [0]@3, [2]@1, [2]@2 → handler", "kind": "reply"},
    {"from": "Kafka", "to": "replay tool", "label": "[0]@4 — appended during the replay: skipped", "kind": "reply"},
    {"from": "replay tool", "to": "Kafka", "label": "close — no commit", "kind": "async"}
  ]
}
:::

With \`from_offset = 1\` and that snapshot, the job is fully determined before the first fetch:

| Partition | \`from_offset\` | \`end\` (high) | Handled | Count |
| --- | --- | --- | --- | --- |
| 0 | 1 | 4 | \`@1 @2 @3\` | 3 |
| 1 | 1 | 2 | \`@1\` | 1 |
| 2 | 1 | 3 | \`@1 @2\` | 2 |
| **total** | | | | **6** |

Whatever producers append during those fetches sits at \`[0]@4\` and beyond — the next replay's
business. The loop that enforces it is three maps and a condition:

\`\`\`text
end[p]      = high watermark of p, read before assign      (fixed)
position[p] = from_offset                                   (advances to offset + 1 per record)
run while   any position[p] < end[p]
per record  handler(record) only if offset < end[p]; pause p once position[p] >= end[p]
\`\`\`

- The broker does not know about the snapshot: it keeps serving a partition past its end. The
  **position check**, not the fetch, decides what reaches the handler.
- A partition whose end is at or below \`from_offset\` is paused before the first poll and contributes
  nothing; if that is true of all three, the call returns \`0\` without calling the handler.
- Pausing a finished partition stops the broker from filling buffers with records the tool will throw
  away, and keeps the loop condition the only thing that ends the replay.
- A second \`replay\` call takes its **own** snapshot: records appended between two replays belong to the
  second one, and no position from the first leaks into it.

:::details Why not read the end offsets after assigning?
The order matters. If the tool assigned first and snapshotted second, a record appended between the
two calls would be counted in \`end\` but could also have been fetched already — harmless here, but the
invariant "the end is what existed when the replay started" would be a lie by one fetch. Snapshot,
then assign, then poll: the end is fixed before the tool has read a byte, and the return value is the
count of a stretch anyone can name — \`[from_offset, end)\` per partition.
:::

:::quiz
Q: Producers write 1,000 records a second to the topic while a replay runs. What does the replay's end depend on?
- [x] Only the high watermarks captured before the first fetch; the 1,000/s go to the next replay
- [ ] The high watermark at the moment each partition is exhausted
- [ ] The number of records the handler can process per second
> The snapshot is taken once, before anything is read, and nothing moves it. A replay whose end is re-read at the end of each partition is a tail, and a tail at a write rate above the handler's rate never terminates.
:::

# Never commit from a tool

A committed offset is the live group's bookmark: where group \`orders\` resumes after a restart or a
rebalance. A tool that commits — explicitly, on an auto-commit timer, or on close — overwrites that
bookmark with its own position. Two outcomes, both bad:

:::sequence
{
  "participants": ["replay tool", "Kafka", "live consumer (orders)"],
  "messages": [
    {"from": "live consumer (orders)", "to": "Kafka", "label": "committed [0] = 4, [1] = 2, [2] = 3", "kind": "sync"},
    {"from": "replay tool", "to": "Kafka", "label": "replay in group orders from offset 0, auto-commit on", "kind": "sync"},
    {"from": "replay tool", "to": "Kafka", "label": "close → commits [0] = 2 (where the replay happened to be)", "kind": "async"},
    {"from": "live consumer (orders)", "to": "Kafka", "label": "restart — fetch committed offsets", "kind": "sync"},
    {"from": "Kafka", "to": "live consumer (orders)", "label": "[0] = 2 — reprocesses @2 @3", "kind": "reply"}
  ]
}
:::

- Commit **behind** the live position and the service re-processes records it already handled.
- Commit **ahead** of it — a replay that ran to a later snapshot — and the service silently skips the
  records in between. Nothing errors; the data is just missing.
- Even in a group nobody reads, committed offsets are a liability: the next tool that happens to use
  the same group id inherits a position someone else left behind.

The drill's tool closes every door. On the consumer, \`group.id\` is \`replay-tool\` and
\`enable.auto.commit\` is \`False\` (kafkajs: \`run({autoCommit: false})\`); the code never calls
\`commit\`, and close commits nothing because there is nothing pending to commit. Where should the
tool's progress live, then? **In the return value** — the count — and in whatever the handler wrote.
A replay is restartable by construction: run it again with the same \`from_offset\` and it reads the
same stretch.

\`\`\`text
Consumer({"bootstrap.servers": "kafka:9092", "group.id": "replay-tool", "enable.auto.commit": False})
assign(...) · poll(...) · pause(...) · close()      ← no commit anywhere
\`\`\`

A consequence worth stating: a replay delivers records the live group has **already delivered once**.
Whatever the handler writes to must tolerate that — an upsert keyed by the record's identity, a
projection that is rebuilt from empty, a sink that dedupes. That is the consumer half of
[Kafka's delivery semantics](https://kafka.apache.org/documentation/#semantics): the log guarantees
what is read, the sink decides whether reading twice matters.

:::quiz
Q: The replay runs in its own group, \`replay-tool\`, which no service reads. Why still disable auto-commit?
- [ ] Auto-commit would slow the replay down
- [x] So no position is ever stored under that group id — the next replay, or anyone reusing the id, starts where it is told, not where the last run stopped
- [ ] Because commits are not allowed with \`assign\`
> A stored offset is state that outlives the process. A tool whose every run is defined by its arguments must leave none, or the second run with \`from_offset = 0\` quietly becomes a run from wherever the first one closed.
:::

# Offsets or timestamps

The drill takes a \`from_offset\` and applies it to all three partitions. That is the primitive; it is
rarely what an operator has in hand. Real requests sound like "replay everything since 09:40, when
the bad deploy went out":

| Starting point | What it is | How a tool turns it into a position |
| --- | --- | --- |
| **offset** | the exact position in one partition | \`assign\` / \`seek\` directly — what the drill does |
| **timestamp** | a wall-clock moment, the same across partitions | \`offsets_for_times\` → the first offset at or after that time, **per partition**, then seek each one |
| **beginning** | \`low\` watermark | offset \`0\` here; \`low\` in a topic with retention |

Offsets are per partition and independent: offset \`1\` in partition 0 and offset \`1\` in partition 2
were written at unrelated times, which is why one \`from_offset\` for every partition is a drill
simplification. A timestamp maps to a *different* offset per partition, and the broker answers that
lookup from each record's timestamp — a lookup the drill leaves out on purpose, like reading the
partition count from metadata instead of a constant.

Real tools add, on top of the same two fixed ends:

- \`offsets_for_times\` to choose \`from_offset\` per partition from a timestamp;
- one replay per partition in parallel, each with its own \`[from, end)\`;
- an idempotent sink, because a replay is by definition a duplicate;
- a reason to stop early — a key filter, a count cap — expressed as a narrower end, never as a commit.

:::quiz
Q: An operator asks for "everything since 09:40". Why is one offset not enough?
- [ ] Because offsets are only valid for a few minutes
- [x] Because each partition numbers its own records; 09:40 lands on a different offset in each one, so the lookup must be done per partition
- [ ] Because timestamps are only stored for compacted topics
> An offset is a position in one partition's log. The broker's time index answers "first offset at or after this time" for each partition separately, and a tool seeks each partition to its own answer.
:::

# What to take away

- **A topic is a history.** Reading moves a position; it removes nothing. Any retained stretch
  \`[from, high)\` can be read again by anyone who sets their own position.
- **Assign, do not join.** \`assign\` (or \`subscribe\` + \`seek\`) with explicit offsets gives the tool a
  fixed set of partitions at a chosen position, no rebalance, no bookmark inherited.
- **Snapshot the end first.** Read the high watermarks before the first fetch and stop at them; the
  broker keeps serving, the position check decides, finished partitions are paused.
- **A tool never commits.** Auto-commit off, no commit call, nothing on close; progress is the return
  value, and the live group's offsets are untouched.
- **Offsets are per partition.** A timestamp becomes one offset per partition via
  \`offsets_for_times\`; a single \`from_offset\` for all of them is the drill's simplification.

The primary reference is the Kafka documentation's section on
[*consumer position*](https://kafka.apache.org/documentation/#design_consumerposition) — why the
position is a single integer the consumer owns, and what that makes possible — read alongside the
[\`KafkaConsumer\` API](https://kafka.apache.org/39/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html)
notes on manual partition assignment and controlling the position.
`;
