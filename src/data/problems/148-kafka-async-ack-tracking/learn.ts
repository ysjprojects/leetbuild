/**
 * The learning guide for the async ack-tracking drill: what a committed offset promises, why
 * concurrent handlers break the serial consumer's free lunch, and how a per-partition frontier
 * restores it — a figure or a demo where one says it faster than prose, a pop quiz per section.
 * Rendered at `/kafka-async-ack-tracking/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A Kafka consumer has no per-record acknowledgement. What it commits is **one number per partition**,
and that number makes one promise: *everything below this is done*. A consumer that handles records
one at a time keeps the promise for free. One that runs handlers concurrently — a webhook dispatcher,
an email sender, an enrichment job calling a model — does not, because completion order is no longer
delivery order. The **ack tracker** is the piece that turns a set of out-of-order completions back
into that one honest number:

:::diagram
{
  "nodes": [
    {"id": "kafka", "kind": "kafka", "label": "requests", "sub": "group async-workers · auto-commit off", "x": 15, "y": 50},
    {"id": "workers", "kind": "service", "label": "async-workers", "sub": "run(handler) · one tracker per partition · shutdown()", "x": 50, "y": 50},
    {"id": "handlers", "kind": "service", "label": "handlers", "sub": "≤ CONCURRENCY = 8 in flight · finish in any order", "x": 85, "y": 50}
  ],
  "edges": [
    {"from": "kafka", "to": "workers", "kind": "kafka", "label": "poll"},
    {"from": "workers", "to": "handlers", "kind": "plain", "label": "handler(value) · complete(offset) when done"},
    {"from": "workers", "to": "kafka", "kind": "kafka", "label": "commit frontier — the lowest unfinished offset"}
  ]
}
:::

The contract the drill implements, in \`async_consumer\`:

- \`run(handler)\` — consume topic \`requests\` in group \`async-workers\` with **auto-commit off**; start one
  handler task per record, never more than \`CONCURRENCY = 8\` at a time; at the limit, wait for one to
  finish before polling again.
- One **tracker per partition**, created at the first offset delivered from it. \`complete(offset)\`
  marks an offset finished and advances the **frontier** — the lowest offset not yet finished — across
  every finished offset above it. When the frontier moves, commit it. Nothing else is ever committed.
- A handler that raises is logged and counts as finished, so the frontier never stalls on it.
- \`shutdown()\` — stop polling, wait for the in-flight handlers at most **5 s** (\`SHUTDOWN_TIMEOUT_S = 5\`),
  commit every partition's frontier synchronously, close.
- \`stats()\` → \`{"in_flight": n, "committed": {partition: offset}}\`.

# One number per partition: what a commit promises

Kafka's [consumer position](https://kafka.apache.org/documentation/#design_consumerposition) is the
design choice everything here follows from. A traditional message queue tracks an acknowledgement per
message — a flag per record, in broker memory, that must be set and later cleaned up. Kafka tracks
**one integer per partition per group**: the offset of the next record to read. Cheap to store, cheap
to checkpoint, and on a restart or a rebalance the new owner of the partition simply reads from there.

The convention matters because the drill commits it directly: the committed value is the **next offset
to read**, so a consumer that finished offsets 0 through 42 commits \`43\`. Three things a consumer could
write into that number, and what each promises:

| What gets committed | Serial consumer | Concurrent consumer |
| --- | --- | --- |
| \`offset + 1\` of the record that just finished | correct — it is also the highest delivered | wrong: 42 finishing first commits 43 while 40 still runs |
| the poll position (auto-commit, or \`commit(message=msg)\`) | correct — polled ⇒ done, by the time the commit lands | wrong: polled ⇒ started, nothing more |
| the lowest offset not yet finished | correct — it equals \`offset + 1\` | **correct** — this is the frontier |

Why the obvious version loses data. Three records arrive, 42 and 41 finish while 40 waits on a slow
downstream call, and the consumer commits what just finished:

:::sequence
{
  "participants": ["Kafka", "naive consumer", "handlers"],
  "messages": [
    {"from": "Kafka", "to": "naive consumer", "label": "poll → offsets 40, 41, 42 (partition 0)", "kind": "reply"},
    {"from": "naive consumer", "to": "handlers", "label": "handler(40) · handler(41) · handler(42)", "kind": "async"},
    {"from": "handlers", "to": "naive consumer", "label": "42 done", "kind": "reply"},
    {"from": "naive consumer", "to": "Kafka", "label": "commit 43 — \\"everything below 43 is done\\"", "kind": "sync"},
    {"from": "naive consumer", "to": "naive consumer", "label": "crash — 40 still running, 41 still running", "kind": "sync"},
    {"from": "Kafka", "to": "naive consumer", "label": "restart: next read is 43 — 40 and 41 never replayed", "kind": "reply"}
  ]
}
:::

- The commit was *true of 42* and *false of the partition*; the broker stores the number, not the
  reasoning.
- The loss is silent: no error, no dead letter.
- Auto-commit has the same shape with a timer instead of a completion — it commits the poll position
  whatever the handlers are doing. That is why the drill turns it off.

:::widget delivery-semantics {}

:::quiz
Q: Handlers for offsets 40, 41 and 42 are running; 42 finishes first. What may the consumer commit at that moment?
- [ ] 43 — offset 42 is done, and the commit is the next offset to read
- [x] Nothing — 40 is the lowest unfinished offset, and the frontier has not moved
- [ ] 42 — the offset that finished, so a restart replays it once
> The committed offset is a statement about every record below it, not about the record that just finished. With 40 still running, no number above 40 is true, and 40 is what was already implied before anything finished. The only honest action is no commit.
:::

# The contiguous frontier

The tracker keeps two things per partition: the **frontier**, the next offset to commit, and a **set of
finished offsets above it** — the ones that completed early and are waiting for the gap below them to
close. \`complete\` is a few lines:

\`\`\`python
class AckTracker:
    def __init__(self, first: int) -> None:
        self.frontier = first          # next offset to commit: everything below has finished
        self.finished: set[int] = set()  # finished offsets above a still-running one

    def complete(self, offset: int) -> bool:
        self.finished.add(offset)
        before = self.frontier
        while self.frontier in self.finished:
            self.finished.discard(self.frontier)
            self.frontier += 1
        return self.frontier != before   # True → commit the frontier
\`\`\`

The same three records, with the tracker in the loop — the step's own sequence:

:::sequence
{
  "participants": ["Kafka", "async-workers", "handlers"],
  "messages": [
    {"from": "Kafka", "to": "async-workers", "label": "poll → offsets 40, 41, 42 (partition 0) · tracker created at 40", "kind": "reply"},
    {"from": "async-workers", "to": "handlers", "label": "handler(40) · handler(41) · handler(42)", "kind": "async"},
    {"from": "handlers", "to": "async-workers", "label": "42 done · 41 done", "kind": "reply"},
    {"from": "async-workers", "to": "async-workers", "label": "finished = {41, 42}; frontier still 40: nothing to commit", "kind": "sync"},
    {"from": "handlers", "to": "async-workers", "label": "40 done → frontier walks 40, 41, 42 → 43; finished = {}", "kind": "reply"},
    {"from": "async-workers", "to": "Kafka", "label": "commit offset 43 (partition 0)", "kind": "sync"}
  ]
}
:::

Completion by completion:

| Completion | \`finished\` after | Frontier | Commit? |
| --- | --- | --- | --- |
| 42 | \`{42}\` | 40 | no — 40 not finished |
| 41 | \`{41, 42}\` | 40 | no |
| 40 | \`{}\` | 43 | **yes, 43** — one commit for three records |

The properties that make it correct:

- **Monotone.** The frontier only moves across finished offsets, so it never passes a running one. At
  every commit, the committed offset is at most the lowest offset still running.
- **Contiguous.** A finished offset above a gap stays in the set until the gap closes; the set is
  exactly the work that has been done but cannot yet be promised.
- **Per partition.** Offsets are only ordered within a partition, so the frontier is too. A slow
  record on partition 0 holds partition 0's commit and nothing else — partition 1, fully done, is
  committed to its end.
- **Created at the first delivered offset.** The tracker starts wherever the group's position was, not
  at zero; a partition assigned at offset 1,000 has a frontier of 1,000.
- **Failure counts as finished.** A handler that raises is logged and completed; otherwise one bad
  record would pin the frontier forever, and every record above it would be replayed on the next
  restart. What to *do* with the failure — retry, dead-letter — is a separate decision this drill
  leaves out.
- **Commit only on movement.** \`complete\` returns whether the frontier moved; two of three completions
  above produced no commit at all. Fewer commits, and never a redundant one.

:::widget kafka-partitions {"partitions": 3}

:::quiz
Q: Offsets 1–4 of partition 0 finish while offset 0 is still running; partition 1 has finished everything it was given. What is committed?
- [ ] Partition 0 to 5 and partition 1 to its end — all of that work is done
- [x] Partition 1 to its end; nothing for partition 0 until offset 0 finishes, then 5 in one step
- [ ] Nothing on either partition until every handler is done
> Each partition has its own frontier. Partition 1's has moved, so it is committed; partition 0's is pinned at 0 with {1, 2, 3, 4} waiting in the set. When 0 completes the frontier walks across all five and the single commit says 5.
:::

# Bounded in flight

The loop never has more than \`CONCURRENCY = 8\` handlers running. At the limit it does not poll; it
waits for *one* task to finish — \`asyncio.wait(inflight, return_when=FIRST_COMPLETED)\`,
\`Promise.race(inflight)\` — and then admits exactly one more. With nothing to deliver it sleeps
briefly rather than spinning on \`poll(0)\`.

\`\`\`text
loop:
  if len(inflight) >= CONCURRENCY:   wait for any one task to finish; continue
  msg = poll(0)
  if msg is None:                    sleep briefly; continue
  tracker = trackers[partition] or AckTracker(offset)
  inflight.add(task: handler(value) → tracker.complete(offset) → commit if moved)
\`\`\`

The bound is not only about memory or downstream politeness. It bounds two things the tracker cares
about:

| Without a bound | With \`CONCURRENCY = 8\` |
| --- | --- |
| a slow record lets thousands of later offsets finish above it; the \`finished\` set grows without limit | at most 7 finished offsets can wait above the frontier of a partition |
| a crash replays everything from the frontier to the poll position — however far the loop ran ahead | replay after a crash is at most 8 records per consumer, the ones that were running |

- **Window = replay.** Everything between the frontier and the highest started offset is redone after
  a crash. The bound is the size of that window.
- **One in, one out.** Waiting for *first completed* rather than *all completed* keeps the pipeline
  full: a freed slot is reused immediately, whatever its offset.
- **The commit comes from the tracker, not the loop.** The handler task finishes, calls \`complete\`,
  and only a moved frontier is committed. The loop never commits a message it polled.

:::details What the broker thinks while the loop waits at the limit
A consumer that stops calling poll looks, to the group coordinator, like a consumer that has died:
past \`max.poll.interval.ms\` it is evicted and its partitions are rebalanced to someone else — who
starts from the last committed frontier and replays the window. The drill's loop blocks at the limit
and accepts that; real systems either keep the poll loop running and
[pause](https://kafka.apache.org/documentation/#consumerconfigs_max.poll.interval.ms) the partitions
whose work is backed up, or send heartbeats from a separate thread, so that *busy* and *dead* are
distinguishable.
:::

:::quiz
Q: Why wait for the *first* in-flight handler to finish at the limit, rather than for all eight?
- [x] So a finished slot is refilled at once; waiting for all eight makes the batch as slow as its slowest record
- [ ] Because the frontier can only move when all eight are done
- [ ] Because Kafka delivers records in batches of eight
> The limit is a count, not a batch. Each completion frees one slot and the next record takes it; the tracker separately decides whether that completion moved the frontier. Draining to zero before polling again would turn every batch into a wait on its slowest member.
:::

# Shutdown: wait, then commit, then close

Stopping a concurrent consumer is where the two halves meet. Work that has finished but not been
committed is work the next owner of the partition will redo; work that is still running when the
consumer closes is work it will also redo. \`shutdown()\` does three things in a fixed order:

:::sequence
{
  "participants": ["operator", "async-workers", "handlers", "Kafka"],
  "messages": [
    {"from": "operator", "to": "async-workers", "label": "shutdown()", "kind": "sync"},
    {"from": "async-workers", "to": "async-workers", "label": "stopping = true — the loop polls no more", "kind": "sync"},
    {"from": "async-workers", "to": "handlers", "label": "wait for in-flight tasks, at most SHUTDOWN_TIMEOUT_S = 5", "kind": "sync"},
    {"from": "handlers", "to": "async-workers", "label": "last handler done → complete(offset) → frontier at the end", "kind": "reply"},
    {"from": "async-workers", "to": "Kafka", "label": "commit every partition's frontier, synchronously", "kind": "sync"},
    {"from": "Kafka", "to": "async-workers", "label": "committed", "kind": "reply"},
    {"from": "async-workers", "to": "Kafka", "label": "close", "kind": "sync"}
  ]
}
:::

1. **Stop polling.** No new work is admitted; the in-flight set can only shrink.
2. **Wait, with a deadline.** The same wait as the loop's, with \`timeout=5\` instead of
   \`FIRST_COMPLETED\`. Called with one handler still running, \`shutdown()\` does not return and does
   not close the consumer until that handler finishes. A handler that outlives the deadline is
   abandoned: its offset is not completed, so the frontier stays below it and the next owner replays
   it — redone, not lost.
3. **Commit each frontier synchronously, then close.** Synchronous because an asynchronous commit
   followed by \`close\` may never leave the process. The order is the point: commit *after* the wait,
   so that work already done is committed rather than redone; close *after* the commit, so the
   commit lands.

Afterwards \`stats()\` reports nothing in flight and, per partition, a committed offset equal to the
frontier — the end of the partition, if every handler finished in time.

:::quiz
Q: shutdown() is called while one handler is still running. Which order is right?
- [ ] Commit the frontier, close the consumer, let the handler finish in the background
- [x] Wait for the handler (up to 5 s), commit the frontier, close
- [ ] Close the consumer immediately; the handler's completion will be committed by the next owner
> The commit must come after the wait or the finished record is replayed by whoever takes over the partition; the close must come after the commit or the commit may never be sent. A consumer that closes first has no way to commit anything at all.
:::

# Head-of-line blocking, and what production adds

The frontier's honesty has a price: a single slow record holds its partition's commit, and every
finished offset above it waits in the set. That is
[head-of-line blocking](https://en.wikipedia.org/wiki/Head-of-line_blocking) — not in delivery (the
handlers above it ran and finished) but in *what can be promised*. The drill accepts it, bounded by
\`CONCURRENCY\`. Production systems narrow it:

| Gap in the drill | What it costs | What production adds |
| --- | --- | --- |
| the finished-above-frontier set lives only in memory | a restart replays every finished offset above the frontier, up to the bound | encode the set into the **commit metadata**, so a restart skips what was already done above the frontier |
| no ordering inside a partition | two records with the same key may run concurrently | order work by **key** inside a partition: one handler per key at a time, concurrency across keys |
| a failing handler just counts as finished | the record is gone after one attempt | retries with backoff, then a dead-letter topic |
| the loop blocks at the limit | the coordinator may evict a busy consumer | heartbeat or pause partitions while waiting |

Confluent's [Parallel Consumer](https://github.com/confluentinc/parallel-consumer) is the industrial
version of exactly this drill: it processes one partition's records concurrently, commits the lowest
contiguous offset, and writes the finished offsets above it as a compressed bitmap into the commit's
metadata string. Its key-ordered mode is the "order by key" row above; its unordered mode is this
drill with the metadata trick.

- **Replay is the failure mode, not loss.** Everything this design gives up on a crash is redone, so
  handlers must tolerate seeing a record twice —
  [at-least-once](https://kafka.apache.org/documentation/#semantics), with the window bounded by
  \`CONCURRENCY\`.
- **The bound is the knob.** Raise it and a slow record holds more finished work hostage and a crash
  replays more; lower it and the slowest record caps throughput sooner.

:::quiz
Q: A handler for offset 40 is hung on a downstream call; 41 through 47 have finished. What is the honest description of the consumer's state?
- [ ] Seven records are lost
- [x] Seven records are done but unpromised; a crash now replays all eight, none is lost
- [ ] The partition is committed to 48 because most of the work is done
> The frontier is at 40 and the set holds 41–47. Nothing has been committed above 40, so a restart re-reads from 40 — the hung record and the seven finished ones. Duplicate work, never missing work; the bound of 8 is what keeps "duplicate" small.
:::

# What to take away

- **A commit is a promise about everything below it**, not about the record that just finished.
  Concurrency breaks the serial consumer's free equivalence between the two.
- **Track per partition, commit the frontier.** A set of finished offsets plus the lowest unfinished
  one; \`while frontier in finished: frontier += 1\`; commit only when it moved, never \`offset + 1\`.
- **A slow record holds its partition and only its partition.** Finished work above it waits; it is
  never skipped and never lost.
- **Bound what is in flight.** The bound is the size of the finished set and of the replay window
  after a crash.
- **Shutdown waits, then commits, then closes.** In that order, synchronously, with a deadline — so
  done work is committed, not redone.

The primary reference is the Kafka documentation's section on
[consumer position](https://kafka.apache.org/documentation/#design_consumerposition) — one integer per
partition, and why; Confluent's
[Parallel Consumer](https://github.com/confluentinc/parallel-consumer) README is the same tracker
grown up, with the bitmap in the commit metadata.
`;
