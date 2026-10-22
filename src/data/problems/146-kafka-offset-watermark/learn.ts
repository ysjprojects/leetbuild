/**
 * The learning guide for the offset-watermark drill: where at-least-once redelivery comes from, why
 * idempotence has to live in the apply, why one integer per partition is a complete record of what
 * has been done, and what production systems add around it.
 * Rendered at `/kafka-offset-watermark/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A consumer that commits **after** its side effect is at-least-once: a crash between the two makes the
broker redeliver the record, and the side effect happens twice. The standard fix leaves the commit
alone and makes the **apply** idempotent, by storing — next to the results — the highest offset
applied for each partition. That integer is the **watermark**.

:::diagram
{
  "nodes": [
    {"id": "kafka", "kind": "kafka", "label": "transfers", "sub": "key = account · 3 partitions · offsets per partition", "x": 25, "y": 50},
    {"id": "consumer", "kind": "service", "label": "balances consumer", "sub": "group balances · applied[account] · watermark[partition]", "x": 70, "y": 50}
  ],
  "edges": [
    {"from": "kafka", "to": "consumer", "kind": "kafka", "label": "poll (partition, offset) · {account, delta}"},
    {"from": "consumer", "to": "kafka", "kind": "kafka", "label": "commit offset + 1 — applied or skipped"}
  ]
}
:::

The contract the drill implements, in one loop:

\`\`\`text
for each record (partition, offset, {account, delta}) from transfers, group balances, auto-commit off:
    if offset > watermark.get(partition, -1):      # never applied from → -1, so offset 0 is applied
        applied[account] += delta                   # missing account starts at 0
        watermark[partition] = offset
    commit(partition, offset + 1)                   # applied or skipped — after the store, never before
\`\`\`

- \`store()\` returns \`{"applied": {account: balance}, "watermark": {partition: offset}}\` — the
  balances and, per partition, the offset of the last record applied. A partition never applied from
  has **no entry**.
- \`run()\` consumes until stopped, with auto-commit off; the loop above is its whole body.
- \`restart()\` closes the consumer and creates a new one in the same group. The process survived,
  only the consumer did not: the store is kept, and the new consumer resumes from the group's
  committed offsets.

Two numbers describe the same partition and mean different things: the broker's **committed offset**
says where to *resume*; the **watermark** says what has been *done*. Normally they agree. A crash
between the apply and the commit makes them disagree — and the comparison
\`offset > watermark[partition]\` is what makes the resulting replay harmless.

# Where the duplicate comes from

Kafka's [delivery semantics](https://kafka.apache.org/documentation/#semantics) are not a broker
setting; they are a consequence of **where the consumer commits** relative to its side effect:

| Order | Crash between the two | Semantics | Who pays |
| --- | --- | --- | --- |
| commit, then apply | record committed, never applied → **lost** | at-most-once | a view counter: a rounding error |
| apply, then commit | record applied, redelivered, applied again → **duplicated** | at-least-once | an account balance: money |
| apply + remember, then commit | redelivered, recognised, **skipped** | effectively-once | nobody |

:::widget delivery-semantics {}

The naive apply-then-commit consumer, on the drill's own example — partition 0, offset 7, \`{a, +5}\`:

:::sequence
{
  "participants": ["Kafka", "naive consumer", "balances"],
  "messages": [
    {"from": "Kafka", "to": "naive consumer", "label": "poll → partition 0, offset 7: {a, +5}", "kind": "reply"},
    {"from": "naive consumer", "to": "balances", "label": "applied[a] += 5 → 15", "kind": "sync"},
    {"from": "naive consumer", "to": "Kafka", "label": "commit (0 → 8) — crash before it lands", "kind": "sync"},
    {"from": "naive consumer", "to": "naive consumer", "label": "new consumer, same group: resume from committed offset 7", "kind": "sync"},
    {"from": "Kafka", "to": "naive consumer", "label": "poll → partition 0, offset 7 again", "kind": "reply"},
    {"from": "naive consumer", "to": "balances", "label": "applied[a] += 5 → 20 — the transfer counted twice", "kind": "sync"},
    {"from": "naive consumer", "to": "Kafka", "label": "commit (0 → 8)", "kind": "sync"}
  ]
}
:::

The broker did nothing wrong. It was told that offset 8 was the place to resume only once, and the
message never arrived; redelivering 7 is the contract. Moving the commit **before** the apply trades
the duplicate for a loss, which is worse for a balance. The commit cannot be made safer from the
broker's side: it is a message over a network, and the process can die on either side of it.

:::quiz
Q: A consumer crashes after applying a record and before its commit lands. Which setting on the broker or the consumer prevents the record from being applied twice?
- [ ] Turning auto-commit on, so the commit is sent sooner
- [ ] A shorter session timeout, so the group rebalances faster
- [x] None — only the consumer knows what it has already applied, so only the apply can refuse the duplicate
> The redelivery is correct behaviour: the broker was never told the record was done. Auto-commit only moves the window around (and can turn the duplicate into a loss). Idempotence has to live where the side effect lives.
:::

# Idempotence by comparison, not by lookup

The usual idempotent consumer keeps a set of seen ids and checks membership. That works for any
source, and it grows forever — or needs a TTL, and a TTL is a bet about how late a duplicate can
arrive. Kafka gives a stronger guarantee that makes the set unnecessary: within a partition, offsets
are a **total order** and a consumer sees them **in that order**. So "have I applied this record?"
reduces to "is its offset above the highest one I have applied on this partition?" — one integer per
partition, compared, never searched.

The drill's own sequence, with the watermark in place:

:::sequence
{
  "participants": ["Kafka", "balances", "store"],
  "messages": [
    {"from": "Kafka", "to": "balances", "label": "poll → partition 0, offset 7: {a, +5}", "kind": "reply"},
    {"from": "balances", "to": "store", "label": "watermark[0] = 6 < 7 → applied[a] += 5, watermark[0] = 7", "kind": "sync"},
    {"from": "balances", "to": "Kafka", "label": "commit (0 → 8) — crash before it lands", "kind": "sync"},
    {"from": "balances", "to": "balances", "label": "restart(): new consumer, same store", "kind": "sync"},
    {"from": "Kafka", "to": "balances", "label": "poll → partition 0, offset 7 again", "kind": "reply"},
    {"from": "balances", "to": "store", "label": "7 > watermark[0] = 7? no → skip", "kind": "sync"},
    {"from": "balances", "to": "Kafka", "label": "commit (0 → 8)", "kind": "sync"}
  ]
}
:::

A fuller replay. Partition 0 delivered \`{a, +10}\`, \`{a, +5}\`, \`{b, +3}\` at offsets 0–2 and all
three were applied, but only the commit for offset 0 landed before the consumer died. The group
resumes from 1:

| Redelivered | \`watermark[0]\` | \`offset > watermark\`? | Apply? | Balances after | Commit |
| --- | --- | --- | --- | --- | --- |
| offset 1 \`{a, +5}\` | 2 | 1 > 2 — no | skip | \`a: 15, b: 3\` unchanged | 0 → 2 |
| offset 2 \`{b, +3}\` | 2 | 2 > 2 — no | skip | unchanged | 0 → 3 |
| offset 3 \`{a, +1}\` (new) | 2 | 3 > 2 — yes | apply, \`watermark[0] = 3\` | \`a: 16, b: 3\` | 0 → 4 |

Three properties the comparison depends on:

- **Offsets are dense and increasing per partition.** The broker assigns them on append; the
  consumer receives them in that order. A record above the watermark is new; one at or below it has
  been seen.
- **The store is keyed by partition, not by consumer or topic.** Partition 0's offset 7 and
  partition 1's offset 7 are unrelated records. A watermark per topic would compare apples with
  oranges; a watermark per consumer would be lost on reassignment.
- **Skipped records are still committed.** The comparison decides whether to *apply*; the commit
  happens either way. A skipped record left uncommitted is redelivered on every restart, forever.

:::details Why the fresh-partition default is -1, not 0
Kafka's first offset in a partition is 0. If a partition with no watermark entry were read as 0, the
test \`0 > 0\` would be false and the first record would be silently skipped — committed, never
applied, exactly the at-most-once loss the whole mechanism exists to avoid. Reading the missing
entry as \`-1\` makes \`0 > -1\` true, and after that first apply the partition's watermark is 0. The
sentinel is the difference between "never applied from" and "applied up to offset 0", and the two
must not collide.
:::

:::quiz
Q: Why can the consumer keep one integer per partition instead of a set of every offset it has applied?
- [x] Because offsets within a partition are strictly increasing and delivered in order, so every offset at or below the highest applied one has already been seen
- [ ] Because the broker deletes records once they are committed
- [ ] Because Kafka guarantees each record is delivered at most once per group
> The watermark summarises a prefix: "everything on this partition up to here is done". That is only a complete record because the partition is a total order consumed in order. A source without that guarantee — an HTTP retry, a queue that reorders — needs the set of ids back.
:::

# Apply, then watermark, then commit

The order inside the loop is not cosmetic. The store must be **ahead of or equal to** the broker at
every instant, never behind, because the broker's committed offset is where the next consumer will
start reading and the store is what it will compare against:

| Crash after … | Store | Broker resumes at | On restart |
| --- | --- | --- | --- |
| apply, before watermark | balance includes 7, \`watermark[0] = 6\` | 7 | \`7 > 6\` → applied **again** |
| watermark, before commit | balance includes 7, \`watermark[0] = 7\` | 7 | \`7 > 7\` false → skipped, committed |
| commit | balance includes 7, \`watermark[0] = 7\` | 8 | offset 8 is next; nothing to replay |

The first row is the one a reasonable-looking implementation produces by moving the watermark after
the commit "once it is safe". Then the window between apply and watermark is a duplicate window — a
smaller one than the naive consumer's, but a duplicate on a balance is a duplicate. The rule:

- **Apply** the delta to the account.
- **Move the watermark** to this offset — in the same store, as close to the apply as the storage
  allows (in production: the same transaction).
- **Commit** \`offset + 1\` to the broker, synchronously, after both.

A reader who already knows the [outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html)
will recognise the shape: the fact that work was done is recorded *with* the work, and the
acknowledgement to the outside world comes last and may be lost without harm.

:::quiz
Q: An implementation applies the delta, commits the offset, and then sets the watermark. Where is the bug?
- [ ] Nowhere — the watermark is only consulted on restart, so its timing does not matter
- [x] A crash between the apply and the commit leaves the watermark one behind the balance, so the redelivered record passes \`offset > watermark\` and is applied twice
- [ ] The commit will fail because the watermark is not yet set
> With the watermark moved last, the store can be behind what it has actually applied. The redelivery then looks new. The watermark has to move with the apply, before anything is told to the broker.
:::

# Where the watermark lives, and what real systems add

In the drill the store is two module-level maps that outlive the consumer: \`restart()\` replaces the
consumer object and nothing else. That isolates the comparison, and it also means the drill pretends
a particular crash cannot happen — the one where the **process** dies and takes the in-memory
watermark with it. A watermark that does not survive the crash is no watermark: on the next start
every partition reads as \`-1\`, and every record from the committed offset is applied again.

The mechanism only works when the watermark is as durable as the state, and written **with** it:

| System | The state | The watermark | Written together by |
| --- | --- | --- | --- |
| hand-written consumer → database | the balances table | a \`consumer_offsets\` row per \`(topic, partition)\` | one SQL transaction |
| Kafka Streams | the state store (RocksDB + changelog topic) | the input offsets recorded in the store | a Kafka transaction (\`processing.guarantee=exactly_once_v2\`) |
| Flink | operator state | the source offsets in the checkpoint | one checkpoint barrier |

\`\`\`sql
BEGIN;
UPDATE balances SET balance = balance + 5 WHERE account = 'a';
UPDATE consumer_offsets SET applied = 7 WHERE topic = 'transfers' AND partition = 0 AND applied < 7;
COMMIT;   -- only then: consumer.commit(partition 0, offset 8)
\`\`\`

If the \`UPDATE … applied < 7\` touches no row, the record is a replay and the balance update is
rolled back with it. Kleppmann's *Designing Data-Intensive Applications* describes this under
idempotence and exactly-once message processing: an operation that carries its own position in a
totally ordered log can be made idempotent by comparing positions, and the comparison must be
atomic with the effect.

Three more things production adds, which the drill leaves out:

- **Rebalances.** When a partition is reassigned, the new owner must read the watermark the old one
  left — from the shared store — and the old owner must stop writing it. Keying the store by
  partition, not by consumer, is what makes the hand-over a read rather than a merge.
- **Transactions and idempotent producers.** When the consumer's output is another topic, Kafka's
  [transactional producer](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
  writes the output records and the consumed offsets in one atomic batch, so the watermark becomes
  the broker's own committed offset. The idea is the same; the store is Kafka.
- **Bounded replay.** A durable watermark makes replay harmless but not free: a consumer that
  crashed with thousands of uncommitted records reads them all back and skips each one. Committing
  periodically rather than per record bounds the throughput cost; it does not change the
  correctness argument.

:::quiz
Q: A consumer keeps its balances in Postgres and its per-partition watermark in a local file, updated right after each database write. What happens after the host loses power between the two?
- [ ] Nothing: the broker's committed offset is behind the watermark, so the redelivery is skipped
- [x] The file lags the database by one record; on restart that record passes \`offset > watermark\` and is applied to the balance a second time
- [ ] Postgres rolls back the balance update because the watermark was not written
> Two stores cannot be updated atomically by writing them one after the other. The watermark protects the state only when it is in the same durable write as the state — the same row, transaction, or checkpoint.
:::

# What to take away

- **Process-then-commit is at-least-once.** A crash between the apply and the commit redelivers
  the record; the broker is doing its job, and no setting removes the window.
- **Idempotence lives in the apply.** Only the consumer knows what it has done, so the duplicate is
  refused where the side effect is, not at the commit.
- **One integer per partition is a complete record** — because offsets within a partition are a
  total order consumed in order. \`offset > watermark[partition]\` replaces a set of seen ids; the
  missing entry reads as \`-1\`, so offset 0 is applied.
- **Apply, watermark, commit — in that order.** The store must never be behind the broker. A
  skipped record is still committed, or it is redelivered forever.
- **The watermark is only as good as its durability.** Keep it in the same write as the state: a
  row in the same transaction, a Kafka Streams state store, a Flink checkpoint. Key it by partition
  so a rebalance hands it over.

The primary reference is the Kafka documentation's
[*Message Delivery Semantics*](https://kafka.apache.org/documentation/#semantics): two pages on
why at-least-once is the consumer's default position, and how storing the offset with the output
turns it into effectively-once.
`;
