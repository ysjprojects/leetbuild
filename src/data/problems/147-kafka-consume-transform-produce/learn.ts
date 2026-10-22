/**
 * The learning guide for the consume → transform → produce drill: the loop, where the commit sits,
 * the two kinds of duplicate and the two mechanisms that answer them, bounded flushes, and what
 * transactions would add — a figure or a demo where one says it faster than prose, a pop quiz per
 * section. Rendered at `/kafka-consume-transform-produce/learn`; the same Markdown is what the
 * download exports.
 */
export const learn = `# The mechanism at a glance

The smallest stream processor: a consumer reads a topic, a function changes each record, a producer
writes the result to another topic. Every CDC relay, enrichment stage and log sanitiser is this loop
with a different function in the middle — and whether the stage **loses**, **duplicates** or does
**neither** is decided not by the function but by the order of three operations around it:
produce, flush, commit.

:::diagram
{
  "nodes": [
    {"id": "raw", "kind": "kafka", "label": "raw", "sub": "3 partitions · keyed · group cleaner reads it", "x": 10, "y": 50},
    {"id": "cleaner", "kind": "service", "label": "cleaner", "sub": "run(transform) · batch 20 · flush ≤ 2 s, then commit", "x": 50, "y": 50},
    {"id": "clean", "kind": "kafka", "label": "clean", "sub": "key = source key · src_partition · src_offset", "x": 90, "y": 50}
  ],
  "edges": [
    {"from": "raw", "to": "cleaner", "kind": "kafka", "label": "poll · commit after flush"},
    {"from": "cleaner", "to": "clean", "kind": "kafka", "label": "produce (idempotent, acks=all)"}
  ]
}
:::

The contract the drill implements, in one function and one constant pair:

- \`run(transform)\` — one member of consumer group \`cleaner\`, reading \`raw\` with **auto-commit off**
  (\`auto.offset.reset=earliest\`), producing \`transform(value)\` to \`clean\` under the **same key**, through
  a producer that is **idempotent with** \`acks=all\`.
- Every output record carries two headers, \`src_partition\` and \`src_offset\` — the source record's
  coordinates as decimal strings.
- Records are committed in batches of at most \`BATCH = 20\`. A batch ends at 20 records, when a poll
  returns nothing, or when the loop stops; the open batch is always finished before \`run\` returns.
- Finishing a batch: **flush** — wait for every acknowledgement, at most \`FLUSH_TIMEOUT_MS = 2000\` —
  **then commit** the next offset per partition, synchronously.
- A delivery error or a flush that runs out of time **fails the batch**: \`run\` raises \`BatchFailed\` and
  commits nothing. \`restart()\` hands the process fresh clients that resume from the committed offsets.

At-least-once on the wire, exactly-once in effect: nothing is lost, the producer's own retries never
duplicate, and the one duplicate a crash can create is recognisable by its headers.

# Where the commit sits is the guarantee

A committed offset is the consumer's claim: "everything before this is done". What matters is when
the claim is made relative to the output being safe. Three orderings, three semantics:

| Order | Crash between the two | Semantics |
| --- | --- | --- |
| commit, then produce (or auto-commit on a timer) | the offset moved on; the record was never written | **at-most-once** — loses |
| produce, flush, **then commit** | the record is on \`clean\`; the offset did not move; the restart writes it again | **at-least-once** — replays |
| produce and commit in one atomic unit | neither or both | **exactly-once** — needs transactions |

The first ordering is what \`enable.auto.commit=true\` buys by default: the client commits whatever it
has *polled* every few seconds, whether or not the output is acknowledged. The naive loop, drawn:

:::sequence
{
  "participants": ["raw", "cleaner (auto-commit)", "clean"],
  "messages": [
    {"from": "raw", "to": "cleaner (auto-commit)", "label": "poll → raw[1]@7 … raw[1]@26", "kind": "reply"},
    {"from": "cleaner (auto-commit)", "to": "raw", "label": "auto-commit raw[1] → 27 (timer fired)", "kind": "sync"},
    {"from": "cleaner (auto-commit)", "to": "clean", "label": "produce @7 … @14", "kind": "async"},
    {"from": "cleaner (auto-commit)", "to": "cleaner (auto-commit)", "label": "crash — @15 … @26 never produced", "kind": "sync"},
    {"from": "raw", "to": "cleaner (auto-commit)", "label": "restart: poll resumes at raw[1]@27", "kind": "reply"},
    {"from": "cleaner (auto-commit)", "to": "cleaner (auto-commit)", "label": "twelve records are gone for good", "kind": "sync"}
  ]
}
:::

The drill's loop moves the commit to the end and makes it conditional:

:::sequence
{
  "participants": ["raw", "cleaner", "clean"],
  "messages": [
    {"from": "raw", "to": "cleaner", "label": "poll → raw[1]@7 key=ana", "kind": "reply"},
    {"from": "cleaner", "to": "clean", "label": "produce key=ana · src_partition=1 · src_offset=7", "kind": "async"},
    {"from": "raw", "to": "cleaner", "label": "poll → … (up to 20)", "kind": "reply"},
    {"from": "cleaner", "to": "clean", "label": "flush: wait for every ack (≤ 2 s)", "kind": "sync"},
    {"from": "clean", "to": "cleaner", "label": "acknowledged — once per record", "kind": "reply"},
    {"from": "cleaner", "to": "raw", "label": "commit raw[1] → 27 (after the acks)", "kind": "sync"}
  ]
}
:::

- **Nothing is committed that is not on** \`clean\`. The commit covers exactly the records whose
  acknowledgements arrived.
- **A crash before the commit replays the batch** — the restart re-reads from the last committed
  offset. Replay is the price of never losing; the next two sections make it cheap.
- **Commit the next offset**, \`offset + 1\` per partition: a committed offset is *where to resume*, not
  *the last one done*.

:::widget delivery-semantics {}

:::quiz
Q: The broker acknowledges \`clean\` one second late. When may the commit for a batch happen?
- [ ] As soon as every record has been handed to the producer
- [x] After that second — once every acknowledgement in the batch has arrived
- [ ] Whenever the auto-commit timer fires next
> A record handed to the producer sits in a client-side buffer; only the acknowledgement says it is on the broker's log. Committing before the ack claims work the broker has not yet done, and a crash in the gap loses it. The commit waits for the flush, however long the broker takes.
:::

# The duplicates the producer makes, and the broker that swallows them

Even with the commit in the right place, a plain producer duplicates on its own. The broker writes a
record, the acknowledgement is lost on the way back, the producer retries, and the broker writes the
record again — two copies, no crash anywhere, invisible to the loop. Turning retries off trades this
for loss; the fix is the
[idempotent producer](https://kafka.apache.org/documentation/#semantics), the first half of what
Kafka's exactly-once work added:

:::sequence
{
  "participants": ["producer (pid 42)", "broker (clean[0])"],
  "messages": [
    {"from": "producer (pid 42)", "to": "broker (clean[0])", "label": "produce seq=17 · key=ana", "kind": "sync"},
    {"from": "broker (clean[0])", "to": "broker (clean[0])", "label": "append — last seq for pid 42 is now 17", "kind": "sync"},
    {"from": "broker (clean[0])", "to": "producer (pid 42)", "label": "ack … lost", "kind": "reply"},
    {"from": "producer (pid 42)", "to": "broker (clean[0])", "label": "retry: produce seq=17 · key=ana", "kind": "sync"},
    {"from": "broker (clean[0])", "to": "producer (pid 42)", "label": "ack — seq 17 already written, nothing appended", "kind": "reply"}
  ]
}
:::

- Every producer gets a **producer id**; every record a **sequence number** per partition. The broker
  keeps the last sequence it wrote for each producer and partition and drops a retry whose number it
  has already seen.
- \`enable.idempotence=true\` **requires** \`acks=all\`: an acknowledgement from the leader alone can
  still be lost with the leader, and then the retry is not a duplicate but a first write — the
  dedup only means something if the first write was durable.
- The sequence numbers also enforce **order within a partition** across retries: a retried record
  cannot overtake the one sent after it.
- The producer's own duplicates **never exist** on the log. Nothing downstream has to recognise them.

\`\`\`text
consumer:  enable.auto.commit=false   auto.offset.reset=earliest   group.id=cleaner
producer:  enable.idempotence=true    acks=all
\`\`\`

:::widget idempotency {}

:::quiz
Q: Why does \`enable.idempotence\` refuse to run with \`acks=1\`?
- [ ] Sequence numbers are only assigned by follower replicas
- [x] A leader-only ack can be lost together with the leader; the retry would then be a first write, not a duplicate, and the broker would have no sequence to compare against
- [ ] Because idempotence doubles the request size
> Deduplication by sequence number presumes the first write survived. With \`acks=all\` it is on every in-sync replica before the ack, so whichever broker leads next knows sequence 17 was written and drops the retry. With \`acks=1\`, a lost leader can take the write and its sequence with it.
:::

# The duplicates it cannot see, and the headers that name them

A crash between the flush and the commit — or a delivery error, or a flush that times out — leaves
some of the batch on \`clean\` and none of it committed. The restart re-reads the batch and produces
those records **again**, from a new producer the broker has never met:

:::sequence
{
  "participants": ["raw", "cleaner", "clean"],
  "messages": [
    {"from": "raw", "to": "cleaner", "label": "poll → raw[1]@7 … raw[1]@26", "kind": "reply"},
    {"from": "cleaner", "to": "clean", "label": "produce @7 … @26, each with src_partition / src_offset", "kind": "async"},
    {"from": "clean", "to": "cleaner", "label": "@7 … @19 acknowledged; @20: delivery error", "kind": "reply"},
    {"from": "cleaner", "to": "cleaner", "label": "BatchFailed — commit nothing; the process is gone", "kind": "sync"},
    {"from": "raw", "to": "cleaner", "label": "restart(): fresh clients; poll resumes at raw[1]@7", "kind": "reply"},
    {"from": "cleaner", "to": "clean", "label": "produce @7 … @26 again — @7 … @19 now twice, same headers", "kind": "async"},
    {"from": "clean", "to": "cleaner", "label": "all acknowledged", "kind": "reply"},
    {"from": "cleaner", "to": "raw", "label": "commit raw[1] → 27", "kind": "sync"}
  ]
}
:::

The copies match the originals in key and value — that is what a deterministic transform means — so
a reader needs something else to tell them apart: the source record's **partition and offset**, unique
on \`raw\`, stable across restarts, carried by every copy.

| \`clean\` after the replay | key | \`src_partition\` | \`src_offset\` | Reader keeps |
| --- | --- | --- | --- | --- |
| first copy of @7 | \`ana\` | \`1\` | \`7\` | yes — first time it sees \`(1, 7)\` |
| … | | | | |
| first copy of @19 | \`ben\` | \`1\` | \`19\` | yes |
| second copy of @7 | \`ana\` | \`1\` | \`7\` | **no** — \`(1, 7)\` already seen |
| … | | | | |
| second copy of @19 | \`ben\` | \`1\` | \`19\` | **no** |
| @20 … @26 (first time) | … | \`1\` | \`20\` … \`26\` | yes |

Grouped by the headers, exactly one record per source record remains. The drill writes the headers;
the reader that drops on them is the downstream consumer's job — in real systems a small state store,
"highest \`src_offset\` seen per \`src_partition\`", which suffices because the producer keeps consume
order: a key's records stay on one partition of \`clean\` in their \`raw\` order.

- **Deterministic transform.** A replay must produce the same value; a function that reads the clock
  or a counter makes duplicates that differ, and the headers are then the *only* evidence.
- **Same key in, same key out.** The output partition is chosen by the source key, so the copies land
  on the same partition and a per-partition reader can dedupe locally.
- **Decimal strings**, not integers: headers are bytes, and a reader in any language parses them.

:::quiz
Q: After a crash the restart re-produces \`raw[1]@7\` with a brand-new producer. Why does the idempotent producer not drop it?
- [ ] It does — the broker remembers every record ever written
- [x] The new producer has a new producer id and starts its sequence numbers afresh; to the broker this is a first write
- [ ] Because \`acks=all\` disables deduplication after a restart
> Idempotence is a conversation between one producer instance and the broker. A restarted process is a different instance; its first record of @7 carries sequence 0 of a new id, and the broker appends it. The only thing that links the two copies is the content the loop put there — the source headers.
:::

# Batches, and a flush with a deadline

One commit per record would be correct and slow: a synchronous commit is a round trip to the group
coordinator, and \`acks=all\` costs a replication round per flush. The loop amortises both over a batch
of up to 20 records, finished in three moves:

\`\`\`text
finish(batch):
  flush(FLUSH_TIMEOUT_MS)                  # every delivery report, or give up at 2 s
  if anything is unacknowledged or failed: raise BatchFailed   # commit nothing
  commit {partition: last offset in batch + 1}, synchronously
\`\`\`

The batch ends in three places, each a correctness rule rather than a tuning knob:

| Trigger | Why the batch must end here |
| --- | --- |
| 20 records | bounds how much a crash replays and how far the commit lags the log |
| a poll returns nothing | a trickle must not sit uncommitted waiting for the twentieth record |
| the loop stops | finished before \`run\` returns; a clean stop never leaves acked records uncommitted |

The deadline on the flush matters as much as the ordering. Without one, a broker that stops
acknowledging holds the process *inside* \`flush\` forever: offsets never advance, no restart happens,
and no rebalance comes because the member is alive, just stuck. Bounded at 2 s, the same outage raises
\`BatchFailed\` with **nothing committed and nothing lost** — the records still sit on \`raw\` — and a
restart, or a rebalance to another member of \`cleaner\`, re-reads them when the broker is back.

- A **delivery error** on one record fails the whole batch, even though the other nineteen landed.
  Committing around the failed one would require committing an offset past it — losing it.
- **Serve the delivery reports.** The error arrives through the producer's callback, which runs only
  when the client is polled: poll the producer after every produce; the flush drains the rest.
- \`BatchFailed\` is not caught inside \`run\`. The process is gone, its batch and pending reports with
  it; a fresh consumer from \`restart()\` knows only the committed offsets.

:::quiz
Q: The broker stops acknowledging \`clean\` entirely. What is the difference between an unbounded flush and one bounded at 2 s?
- [ ] None — in both cases the records are lost
- [x] Unbounded, the process hangs holding its partitions with nothing committed; bounded, it fails the batch with nothing committed and a restart can retry when the broker returns
- [ ] Bounded, the batch is committed after 2 s so the loop can continue
> Both commit nothing — the data is safe on \`raw\` either way. The bounded flush turns a silent stall into a failure something can act on: a supervisor restarts the process, or the group gives the partitions to another member. The unbounded flush is a stuck partition that looks healthy.
:::

# What transactions add, and why the loop does without them

Kafka's transactional producer, the second half of its exactly-once work, closes the one gap the loop
leaves: it writes the output records **and the source offsets** as one atomic unit, so a crash between
them cannot happen because there is no between.

| | produce → flush → commit (this drill) | transactions |
| --- | --- | --- |
| Producer config | \`enable.idempotence\`, \`acks=all\` | the same, plus a \`transactional.id\` |
| The offsets move | via \`consumer.commit\` after the flush | via \`sendOffsetsToTransaction\` inside the transaction |
| Atomicity | output first, then offsets; a gap exists | output and offsets commit together or not at all |
| Crash before the commit | replay: duplicates on \`clean\`, with headers | aborted: the records are on the log but marked, and never read |
| Reader | reads everything; dedupes on \`src_*\` | \`isolation.level=read_committed\` skips aborted records |
| Zombie producer | an old process can still write | fenced by the producer epoch on \`transactional.id\` |
| Cost | one replication round per batch | coordinator round trips and markers on the log, on every batch |

Three things from Confluent's own account of the mechanism —
[*Exactly-once semantics are possible: here's how Kafka does it*](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/) —
are worth holding on to:

- The transaction covers **Kafka-to-Kafka** only. An output that goes to a database, a search index or
  an HTTP endpoint is outside it, and the pipeline is back to idempotent writes and dedup keys —
  which is exactly what the headers are.
- \`read_committed\` is a reader-side promise: aborted records stay on the log and are skipped. Every
  consumer of \`clean\` would have to opt in.
- The price is paid on every batch, by every stage, whether or not a crash ever happens.

The loop in this drill pays nothing extra on the happy path and leaves one well-labelled duplicate
per crash per batch for a reader to drop. Most pipelines take that trade; the ones that cannot — a
count that must be exact, an aggregate never re-derivable — reach for transactions, or for a
[stream processing framework](https://kafka.apache.org/documentation/streams/) that wraps them.

:::details Real systems add
A rebalance listener that finishes the open batch on revocation, so a partition moving to another
member is not a replay. A deduplicating consumer with a state store keyed by the source headers. A
dead-letter topic for records the transform rejects — a poison record that throws fails its batch on
every replay, forever, until something takes it out of the way. None of these change the order of the
three operations.
:::

:::quiz
Q: The output of a stage goes to Postgres, not to another topic. What does a Kafka transaction give it?
- [ ] Exactly-once into Postgres, since the offsets commit atomically with the output
- [x] Nothing for the Postgres write — the transaction spans Kafka topics only; the write needs its own idempotency key, and the source offset is the natural one
- [ ] Exactly-once as long as the consumer uses \`read_committed\`
> \`sendOffsetsToTransaction\` moves the source offsets together with records produced to Kafka. A row in Postgres is not in that unit. The stage is back to at-least-once plus dedup: insert keyed by \`(src_partition, src_offset)\` with \`ON CONFLICT DO NOTHING\`, the same identity the headers carry.
:::

# What to take away

- **The guarantee is an ordering.** Produce, flush, then commit. Commit before the acks and a crash
  loses; after, a crash replays. Replay is the one you can make harmless.
- **Two kinds of duplicate, two answers.** The producer's own retries are the broker's to swallow —
  \`enable.idempotence\` with \`acks=all\`, a producer id and a sequence number per record. A replay by a
  new process is a new record, and only the content tells: \`src_partition\` and \`src_offset\` on every
  output.
- **Commit only what is acknowledged, and commit the next offset.** The committed offset is where to
  resume; it must never point past a record that is not on the output.
- **Bound the flush.** An unbounded flush on a dead broker is a stuck partition that looks healthy;
  a bounded one fails the batch with nothing committed and lets a restart or a rebalance retry.
- **Transactions make output and offsets one unit** — for Kafka-to-Kafka, at a per-batch cost, and
  with every reader opting into \`read_committed\`. Everything that leaves Kafka is dedup keys again.

The primary reference is Confluent's
[*Exactly-once semantics are possible: here's how Kafka does it*](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
(Neha Narkhede, 2017), with the
[message delivery semantics](https://kafka.apache.org/documentation/#semantics) section of the Kafka
documentation for the three guarantees in the project's own words.
`;
