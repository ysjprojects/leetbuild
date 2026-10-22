/**
 * The learning guide for the changelog-restore drill: a changelog topic as the durable form of a
 * key-value state, compaction and tombstones, the captured-end-offset restore protocol, readiness,
 * and why the restoring consumer owns its partitions and commits nothing.
 * Rendered at `/kafka-changelog-restore/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A **changelog topic** is a key-value store written down as a log: one record per write, keyed by the
kv key, a \`null\` value for a delete. A process that replays it from the beginning, last write
winning, ends up holding the whole store in memory. That is how Kafka Streams and ksqlDB rebuild a
state store on a fresh instance, how a Debezium consumer materialises a table, and how a service keeps
a local copy of a config topic. The drill builds the view as one module with a three-function contract:

:::diagram
{
  "nodes": [
    {"id": "view", "kind": "service", "label": "kv view", "sub": "start · get · stats — in memory, ready only after the replay", "x": 25, "y": 50},
    {"id": "kafka", "kind": "kafka", "label": "kv-changelog", "sub": "3 partitions · key = kv key · null = tombstone", "x": 70, "y": 50}
  ],
  "edges": [{"from": "view", "to": "kafka", "kind": "kafka", "label": "end offsets · assign · replay · live"}]
}
:::

- \`start(on_restored)\` — captures the **end offset of every partition** of \`kv-changelog\`
  (\`PARTITIONS = 3\`), assigns all three at the beginning with no consumer group and auto-commit off,
  then polls forever, applying each record last-write-wins. \`on_restored(partition, offset)\` is
  called after each *restored* record is applied.
- \`get(key)\` — raises \`NotReadyError\` until the view is \`ready\`; afterwards the value, or
  \`None\`/\`null\` for a key that is absent or tombstoned.
- \`stats()\` — \`{ready, restored, applied_live}\`: \`restored\` counts replayed records,
  \`applied_live\` the ones written after the capture.

One rule under all three: a record whose offset is **below its partition's captured end** is part of
the restore; everything else is the present.

# A table is a log, a log is a table

Kafka's documentation calls the relationship
[log compaction](https://kafka.apache.org/documentation/#compaction) rests on the *table/log
duality*: a table is the latest value per key, a log is the sequence of changes that produced it.
Keep the log and the table can always be rebuilt; keep only the table and the history is gone. A
changelog topic is the log side, and the view is the table side, derived — which is why the view
needs no storage of its own.

Six records on one partition and the table they produce:

| Offset | Key | Value | View after applying |
| --- | --- | --- | --- |
| 0 | \`user:1\` | \`{"name": "ana"}\` | \`user:1 → ana\` |
| 1 | \`user:2\` | \`{"name": "ben"}\` | \`user:1 → ana\`, \`user:2 → ben\` |
| 2 | \`user:1\` | \`{"name": "ana b."}\` | \`user:1 → ana b.\`, \`user:2 → ben\` |
| 3 | \`user:2\` | \`null\` — tombstone | \`user:1 → ana b.\` |
| 4 | \`user:3\` | \`null\` — tombstone for a key never held | unchanged, a no-op |
| 5 | \`user:2\` | \`{"name": "ben"}\` | \`user:1 → ana b.\`, \`user:2 → ben\` |

Three rules, and the view is correct for any such log:

- **Last write wins per key.** Apply records in offset order; a later value replaces the earlier one.
- **A tombstone deletes.** A \`null\` value removes the key — \`pop\`, \`delete\`, \`erase\` — it does
  not store a null. A later write for the same key brings it back.
- **Key = kv key.** The producer hashes the key to a partition, so every write to one key lands on
  one partition in order. Order *across* keys is not promised and the view does not need it.

:::widget kafka-partitions {"partitions": 3}

:::quiz
Q: The view sees \`user:2 → null\` at offset 3 and \`user:2 → {"name": "ben"}\` at offset 5. What must \`get("user:2")\` answer after the replay?
- [ ] \`null\` — a tombstone is final for that key
- [x] \`{"name": "ben"}\` — the tombstone removed the key, the later write re-created it
- [ ] Whichever record was delivered last, which may be either
> Same key, same partition, so offset order is write order. The tombstone removed the key; offset 5 set it again. A view that treated a tombstone as permanent would answer wrong for every key that was deleted and later re-created.
:::

# Compaction keeps the replay bounded

A plain topic with retention would eventually drop the first write of a key that has not changed
since — and the view would lose that key on its next restart. A changelog topic sets
\`cleanup.policy=compact\` instead: the broker keeps **at least the last record for every key**,
forever, and discards older records for keys that were written again. The history of each key is
collapsed; the final state is not.

Before and after one compaction pass over the partition above:

| | Offsets kept | What the replay does |
| --- | --- | --- |
| Before | 0, 1, 2, 3, 4, 5 | six records, three of them superseded |
| After | 2, 4, 5 | three records; the view that results is identical |

- **Offsets are never renumbered.** A compacted partition has gaps; the consumer sees offsets 2, 4, 5
  and nothing in between. The end offset is still the next offset to be written, which is why the
  restore protocol in the next section compares offsets rather than counting records.
- **The tail is compacted, the head is not.** The active segment is left alone, so the latest writes
  are always present in full.
- **Tombstones are kept for a while, then dropped.** A \`null\` must survive long enough for every
  consumer to see the delete (\`delete.retention.ms\`, 24 hours by default); after that it is removed
  too, and the key is simply absent from the log — the same answer for a reader starting from zero.

So the cost of a restore is proportional to the number of **live keys**, not to the number of writes
ever made. A config topic with a thousand keys edited a million times replays a thousand records.

:::quiz
Q: A changelog partition has offsets 2, 4, 5 after compaction and an end offset of 6. A fresh consumer replays it from the beginning. What does it see?
- [x] Three records at offsets 2, 4 and 5; the view they produce is the one the full log would have produced
- [ ] Six records, with the compacted ones delivered as empty values
- [ ] An error, because offsets 0, 1 and 3 are missing
> Compaction removes superseded records and leaves the offsets of the survivors as they were. The reader gets the latest value per key, which is all a last-write-wins view ever needed. Code that counts records up to the end offset, rather than comparing offsets to it, would wait forever for three records that no longer exist.
:::

# Knowing when the replay is done

The view must not answer while it is half-way through the log — a stale value, or no value, for a key
that exists is a confident wrong answer. But the log never ends: the writer keeps appending. So the
question "is the restore done?" needs a line drawn *before* reading anything. The broker's
**end offset** per partition — the offset the next write will get — is that line.

:::sequence
{
  "participants": ["kv view", "Kafka"],
  "messages": [
    {"from": "kv view", "to": "Kafka", "label": "end offsets of kv-changelog[0..2]", "kind": "sync"},
    {"from": "Kafka", "to": "kv view", "label": "{0: 4, 1: 0, 2: 7} — captured; partition 1 is caught up already", "kind": "reply"},
    {"from": "kv view", "to": "Kafka", "label": "assign [0, 1, 2] at OFFSET_BEGINNING · no group · no commits", "kind": "sync"},
    {"from": "Kafka", "to": "kv view", "label": "p0@0 … p0@3, p2@0 … p2@6 → apply, restored += 1, on_restored(p, offset)", "kind": "reply"},
    {"from": "kv view", "to": "kv view", "label": "p2@6 was the last captured end → ready = true; get answers", "kind": "sync"},
    {"from": "Kafka", "to": "kv view", "label": "p0@4 (written after the capture) → apply, applied_live += 1", "kind": "reply"}
  ]
}
:::

The protocol, in the order the step's task gives it:

1. **Capture** \`ends[p]\` for every partition — \`get_watermark_offsets\`, \`fetchTopicOffsets\`,
   \`endOffsets\` — before the first poll. Taken once; never moved.
2. **Assign** all \`PARTITIONS\` partitions at \`OFFSET_BEGINNING\`.
3. **Classify every record with one comparison**: \`offset < ends[partition]\` → restored, else live.
   Both are applied the same way; only the counter differs.
4. **Readiness is per partition.** A \`caught_up[p]\` flag, initialised to \`ends[p] == 0\`, is set when
   a restored record has \`offset + 1 >= ends[p]\`. \`ready\` is "every partition caught up", recomputed
   right there.

\`\`\`text
ends       = {0: 4, 1: 0, 2: 7}          captured before the first poll
caught_up  = {0: False, 1: True, 2: False}   end == 0 is caught up at once
record p2@6: 6 < 7 → restored; 6 + 1 >= 7 → caught_up[2] = True
ready      = all(caught_up)             → True once p0@3 has also been applied
\`\`\`

- An **empty partition** (end \`0\`) never delivers a record, so waiting for one from every partition
  would wedge the restore. Seeding the flag from the captured end is what lets it finish.
- A **busy partition** is not done when the others are; the view stays \`NotReadyError\` until the big
  one reaches *its* end.
- A compacted partition reaches its end at the last surviving offset, which is why the test is
  \`offset + 1 >= end\` and not \`offset + 1 == end\`.

:::quiz
Q: Partitions 0 and 1 finished their replay a second ago; partition 2 has 50,000 records left. A request calls \`get("user:1")\`, a key that lives on partition 0. What should happen?
- [ ] Return the value — partition 0 is caught up, so its keys are final
- [x] Raise \`NotReadyError\` — readiness is a property of the whole view, not of one partition
- [ ] Return \`null\` until the view is ready
> The caller does not know which partition a key hashes to, and a view that answers some keys and refuses others is a view nobody can reason about. \`ready\` flips once, when the last partition reaches its captured end; before that every read is refused, with an error rather than a plausible \`null\`.
:::

# The two obvious versions, and how each one lies

Both shortcuts people reach for first replace the captured offsets with a guess:

| Version | How it decides "done" | Where it goes wrong |
| --- | --- | --- |
| Empty poll | \`ready\` when a poll returns nothing | a slow fetch looks like the end → ready too early; a busy topic never returns empty → ready never |
| Global flag | one \`restoring\` boolean, cleared when the last partition catches up | a record appended during the restore to a partition that already finished is counted as restored, and the counts lie |
| Captured ends | \`offset < ends[p]\`, per partition | — |

The global flag's failure, drawn out. Partition 0 finished early; the writer appends to it while
partition 2 is still draining:

:::sequence
{
  "participants": ["writer", "Kafka", "naive view", "correct view"],
  "messages": [
    {"from": "Kafka", "to": "naive view", "label": "p0@3 → restoring = true → restored = 4; p0 done", "kind": "reply"},
    {"from": "Kafka", "to": "correct view", "label": "p0@3 → 3 < ends[0] = 4 → restored = 4; caught_up[0]", "kind": "reply"},
    {"from": "writer", "to": "Kafka", "label": "SET user:9 → kv-changelog p0@4", "kind": "async"},
    {"from": "Kafka", "to": "naive view", "label": "p0@4 → still restoring → restored = 5 (wrong: it did not exist at the capture)", "kind": "reply"},
    {"from": "Kafka", "to": "correct view", "label": "p0@4 → 4 < 4 is false → applied_live = 1", "kind": "reply"},
    {"from": "Kafka", "to": "naive view", "label": "p2@6 → restoring = false → ready", "kind": "reply"},
    {"from": "Kafka", "to": "correct view", "label": "p2@6 → caught_up[2] → ready; restored = 11 = what existed at the capture", "kind": "reply"}
  ]
}
:::

Both views hold the same data at the end — \`user:9\` is applied either way — so the bug is invisible
in \`get\`. It shows in the accounting: the naive view reports a restore that is larger than the log
was, its progress listener fires for a record that was never part of the restore, and in a system
that writes a checkpoint "restored up to offset N" the wrong N is what gets persisted. The captured
end is a **fact** about the log at one instant; a flag is a guess about timing.

The empty-poll version is worse, because it lies in \`get\`: a fetch that happens to return nothing
while 50,000 records are still on the broker flips \`ready\`, and the next read returns \`null\` for a
key that exists. The broker's
[consumer position](https://kafka.apache.org/documentation/#design_consumerposition) is an offset,
and so is the end of the log; readiness compares the two and never consults the clock.

:::quiz
Q: A record is written to partition 0 after the end offsets were captured but before partition 2 finished replaying. How should the view count it?
- [ ] As restored — it arrived before \`ready\`, so it is part of the restore
- [x] As live — its offset is not below partition 0's captured end
- [ ] Hold it until \`ready\`, then apply it as live
> "Restored" means "existed when the ends were captured", and that is decided by offset, not by arrival time. The record is applied immediately — the view must not fall behind on the partitions it has finished — and counted in \`applied_live\`. Buffering it would only make the finished partition stale for the duration of the slow one.
:::

# Own the partitions, commit nothing

A normal consumer joins a group and commits offsets so a restart resumes where it left off. The
restoring view does neither — \`assign\`, not \`subscribe\`; no \`group.id\`; \`enable.auto.commit\` off;
never a \`commit\` — and each of those is a decision, not an omission:

- **The topic is the durable state.** The view holds nothing on disk, so after a restart the only
  correct position is offset 0. A remembered position would let the restart *skip* exactly the
  records it needs to rebuild the table.
- **Every instance needs every partition.** A group splits partitions among its members; a view
  that holds a third of the keys answers \`null\` for the other two thirds. Self-assignment gives each
  instance the whole topic.
- **No rebalance, no half-restored hand-off.** With no group there is no reassignment mid-replay and
  no second instance taking partitions the first one was still draining.

Each restart is a full replay — which is why compaction matters, and why real systems add more on top:

:::details What Kafka Streams adds around the same protocol
Kafka Streams restores its state stores from internal \`<app>-<store>-changelog\` topics with exactly
this split: end offsets first, replay to them, serve afterwards. Around it, three things the drill
leaves out. A [\`StateRestoreListener\`](https://kafka.apache.org/documentation/streams/developer-guide/running-app.html#state-restoration-during-workload-rebalance)
reports progress per partition, the way \`on_restored\` does here. A **checkpoint file** beside the
RocksDB store records the changelog offset the on-disk state corresponds to, so a restart replays from
that offset rather than from zero. And **standby replicas** keep a second instance's copy warm, so a
failover is a short catch-up rather than a full replay. All three shorten the restore; none of them
changes what "done" means.
:::

:::quiz
Q: Why does the restoring consumer refuse to commit offsets, even though committing would let a restart skip records it has already seen?
- [ ] Commits are slow and the replay is latency-sensitive
- [x] Skipping records is exactly the failure: the in-memory view is gone after a restart, so the records it has "already seen" must be seen again
- [ ] Committing requires a consumer group, and groups are limited to one consumer per partition
> A committed offset is a promise that everything before it is safely processed and need not be re-read. For a view held only in memory that promise is false the moment the process exits. The topic is the durable copy; replaying it from the beginning is not a cost to minimise but the recovery path itself.
:::

# What to take away

- **A changelog is a table written as a log.** Key = kv key, last write wins, \`null\` is a tombstone
  that deletes and a later write re-creates. The view is derived; the topic is the durable state.
- **Compaction makes the replay proportional to live keys**, not to writes. Offsets keep their gaps,
  so the restore compares offsets to the end rather than counting records.
- **Capture the end offsets before the first read.** \`offset < ends[p]\` is restored, everything else
  is live; the split is a fact about the log at one instant, never a guess about silence.
- **Readiness is per partition and all-or-nothing.** \`caught_up[p]\` seeded from \`end == 0\`, set at
  \`offset + 1 >= end\`; \`get\` raises \`NotReadyError\` until every partition is there.
- **Assign, never subscribe; never commit.** Each instance needs the whole topic, and a restart must
  replay from the beginning again.

The primary reference is the Kafka documentation's section on
[log compaction](https://kafka.apache.org/documentation/#compaction) — the table/log duality, the
guarantees compaction keeps, and how tombstones are retained — read alongside Kafka Streams'
[state-restoration notes](https://kafka.apache.org/documentation/streams/developer-guide/running-app.html#state-restoration-during-workload-rebalance),
which describe the same end-offset protocol with checkpoints and standbys around it.
`;
