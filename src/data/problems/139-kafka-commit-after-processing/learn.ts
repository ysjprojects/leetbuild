/**
 * The learning guide for Consume, process, then commit: what a committed offset is, why its place
 * relative to the work sets the delivery guarantee, and the two records that complicate the loop —
 * a figure where one says it faster than prose, a pop quiz per section.
 * Rendered at `/kafka-commit-after-processing/learn`; the same Markdown is what the download exports.
 */
export const learn = `# The mechanism at a glance

A Kafka consumer does not acknowledge records one by one. It **commits an offset** per partition —
"everything before here is done" — and the broker remembers that number for the consumer group. The
drill builds the smallest loop that gets the commit right: \`run(handler)\`, a member of group
\`ledger-writer\` reading topic \`payments\` from the beginning with auto-commit off, which for every
record parses the JSON value, calls \`handler(event)\`, and then — only then — commits that record's
offset synchronously.

:::diagram
{
  "nodes": [
    {"id": "kafka", "kind": "kafka", "label": "payments", "sub": "3 partitions · committed offset per partition for group ledger-writer", "x": 25, "y": 50},
    {"id": "ledger", "kind": "service", "label": "ledger-writer", "sub": "run(handler) · parse → handler → commit, per record", "x": 70, "y": 50}
  ],
  "edges": [
    {"from": "kafka", "to": "ledger", "kind": "kafka", "label": "poll → record"},
    {"from": "ledger", "to": "kafka", "kind": "kafka", "label": "commit offset + 1"}
  ]
}
:::

The contract, in four lines:

- \`group.id\` \`ledger-writer\`, \`auto.offset.reset\` \`earliest\` (\`fromBeginning: true\`),
  \`enable.auto.commit=false\` / \`autoCommit: false\`.
- Per record, in partition order: parse → \`handler(event)\` → \`commit(message=msg, asynchronous=False)\`
  (kafkajs: \`commitOffsets([{topic, partition, offset: offset + 1}])\`).
- A value that is not JSON is a **poison record**: log it, skip the handler, commit it anyway.
- A handler that raises **stops the loop** with its record uncommitted; the error is not caught.

Everything a consumer that writes somewhere does — a ledger writer, a search indexer, a counter, a
notifier — is this loop with a different \`handler\`.

# What a consumer group remembers

Kafka's [consumer position](https://kafka.apache.org/documentation/#design_consumerposition) is a
single integer per partition per group. The broker keeps no per-record acknowledgement state, which
is why a partition can be read at disk speed: the consumer *is* its cursor, and the only durable fact
about it is the last offset it committed.

| Number | Who owns it | Meaning |
| --- | --- | --- |
| **log end offset** | the broker | one past the newest record in the partition |
| **position** | the consumer, in memory | the next offset \`poll\` will return |
| **committed offset** | the group, on the broker | where a restarted or reassigned member will begin |
| **lag** | derived | log end − committed: records the group has not yet vouched for |

Two consequences shape the drill:

- **A commit names the *next* record, not the last one.** Processing offset 41 and committing \`42\`
  says "resume at 42". That is why the Python client's \`commit(message=msg)\` commits \`offset + 1\`,
  and why kafkajs makes you write \`offset + 1\` yourself (as a string). Committing \`41\` would replay
  41 on every restart.
- **A commit is per partition, independently.** Partition 0 can be committed at 3 while partition 1
  sits at 1. The drill's commits each name the processed record's partition alone.

\`\`\`text
partition 0:  [0] [1] [2] [3]        log end = 4
                       ^ committed = 2      lag = 2
                       ^ position  = 2  (after a restart, position := committed)
\`\`\`

\`auto.offset.reset=earliest\` only matters when there is **no** committed offset — a brand-new group.
Once \`ledger-writer\` has committed anything, the committed offset wins and the setting is ignored.

:::widget consumer-groups {"partitions": 3}

:::quiz
Q: The handler has just returned for the record at partition 1, offset 41. What should the commit say?
- [ ] 41 — the offset that was processed
- [x] 42 — the next offset to read on partition 1
- [ ] 42 for every partition the consumer currently holds
> The committed offset is a resume point. Committing 41 would hand the same record back after every restart; committing for other partitions would vouch for records whose handler has not run.
:::

# Where the commit sits decides what a crash does

The [delivery semantics](https://kafka.apache.org/documentation/#semantics) of a consumer are not a
broker setting. They fall out of one ordering decision in the loop: does the commit happen before the
work, or after it? A crash between the two is the whole story.

:::widget delivery-semantics {}

With \`enable.auto.commit\` left on — the client's default — the client commits, every
\`auto.commit.interval.ms\`, whatever \`poll\` last **returned**. Not what the handler finished: what
was fetched. The ordering is chosen for you:

:::sequence
{
  "participants": ["Kafka", "auto-commit consumer", "handler"],
  "messages": [
    {"from": "Kafka", "to": "auto-commit consumer", "label": "poll → offsets 41, 42, 43 (partition 1)", "kind": "reply"},
    {"from": "auto-commit consumer", "to": "handler", "label": "handler(41)", "kind": "sync"},
    {"from": "handler", "to": "auto-commit consumer", "label": "returns", "kind": "reply"},
    {"from": "auto-commit consumer", "to": "Kafka", "label": "timer fires: commit 44 — 42 and 43 not yet processed", "kind": "async"},
    {"from": "auto-commit consumer", "to": "handler", "label": "handler(42)", "kind": "sync"},
    {"from": "auto-commit consumer", "to": "auto-commit consumer", "label": "crash", "kind": "sync"},
    {"from": "Kafka", "to": "auto-commit consumer", "label": "restart: resume at 44 — payments 42 and 43 are gone", "kind": "reply"}
  ]
}
:::

The drill's loop puts the commit last, so a crash can only strike *before* it:

:::sequence
{
  "participants": ["Kafka", "ledger-writer", "handler"],
  "messages": [
    {"from": "Kafka", "to": "ledger-writer", "label": "poll → record (partition 1, offset 41)", "kind": "reply"},
    {"from": "ledger-writer", "to": "handler", "label": "handler(event)", "kind": "sync"},
    {"from": "handler", "to": "ledger-writer", "label": "returns", "kind": "reply"},
    {"from": "ledger-writer", "to": "Kafka", "label": "commit offset 42 (partition 1), synchronously", "kind": "sync"},
    {"from": "Kafka", "to": "ledger-writer", "label": "poll → record (partition 1, offset 42)", "kind": "reply"},
    {"from": "ledger-writer", "to": "handler", "label": "handler(event)", "kind": "sync"},
    {"from": "ledger-writer", "to": "ledger-writer", "label": "crash before the commit", "kind": "sync"},
    {"from": "Kafka", "to": "ledger-writer", "label": "restart: resume at 42 — the record is delivered again", "kind": "reply"}
  ]
}
:::

| Order | Crash between the two | Guarantee | Who pays |
| --- | --- | --- | --- |
| commit, then process (auto-commit's window) | the record is committed and never processed | at-most-once | the ledger: a payment silently missing |
| process, then commit (the drill) | the record is processed and delivered again | at-least-once | the handler: it must tolerate a repeat |
| process and commit in one atomic step | neither, by construction | effectively-once | the system: transactions or an idempotent sink |

For a ledger the choice is not close. A duplicate is visible — the same payment id twice — and a
handler can be written to ignore it; a missing payment is invisible until someone reconciles. So the
drill takes at-least-once and makes it explicit: auto-commit off, one synchronous commit per record,
**after** the handler returns. Synchronous because the next \`poll\` must not run until the broker has
stored the number; an asynchronous commit that fails quietly would widen the replay window without
anyone knowing.

:::quiz
Q: Auto-commit is on with a five-second interval. The consumer fetches twenty records, processes six, and crashes. What is lost?
- [ ] Nothing: the timer only commits what the handler finished
- [x] Up to fourteen records, if the timer fired after the fetch — the client commits the fetched position, not the processed one
- [ ] All twenty: a crash discards the fetch
> Auto-commit tracks the position returned by poll, so whatever it committed included the records still waiting. On restart the group resumes past them. It is at-most-once decided by a timer, and the loop never had a say.
:::

# Poison records: skip and commit

A value that cannot be parsed is not a transient failure. The broker will hand it back on every
restart, in exactly the same bytes, and \`json.loads\` will fail on it in exactly the same way. If the
loop treats it like a handler error — stop, leave it uncommitted — the committed offset never moves
past it, and every record behind it on that partition waits forever. Lag climbs; the group looks
alive and does nothing.

:::sequence
{
  "participants": ["Kafka", "ledger-writer", "handler"],
  "messages": [
    {"from": "Kafka", "to": "ledger-writer", "label": "poll → partition 0, offset 0: {\\"id\\": \\"pay-0-0\\", …}", "kind": "reply"},
    {"from": "ledger-writer", "to": "handler", "label": "handler(event)", "kind": "sync"},
    {"from": "handler", "to": "ledger-writer", "label": "returns", "kind": "reply"},
    {"from": "ledger-writer", "to": "Kafka", "label": "commit 1 (partition 0)", "kind": "sync"},
    {"from": "Kafka", "to": "ledger-writer", "label": "poll → partition 0, offset 1: not json", "kind": "reply"},
    {"from": "ledger-writer", "to": "ledger-writer", "label": "parse fails → log \\"skipping malformed record payments[0]@1\\"; handler not called", "kind": "sync"},
    {"from": "ledger-writer", "to": "Kafka", "label": "commit 2 (partition 0) — past the poison record", "kind": "sync"},
    {"from": "Kafka", "to": "ledger-writer", "label": "poll → partition 0, offset 2: {\\"id\\": \\"pay-0-2\\", …}", "kind": "reply"},
    {"from": "ledger-writer", "to": "handler", "label": "handler(event)", "kind": "sync"},
    {"from": "handler", "to": "ledger-writer", "label": "returns", "kind": "reply"},
    {"from": "ledger-writer", "to": "Kafka", "label": "commit 3 (partition 0) — lag 0", "kind": "sync"}
  ]
}
:::

Two partitions, one poison record on each, after the loop drains them:

| Partition | Records | Reaches the handler | Committed offset | Lag |
| --- | --- | --- | --- | --- |
| 0 | \`pay-0-0\` · \`not json\` · \`pay-0-2\` | offsets 0 and 2 | 3 | 0 |
| 1 | \`{"id": "pay-1-0", "cents": \` (truncated) | nothing | 1 | 0 |

The shape that makes this fall out is one commit site at the bottom of the loop body:

\`\`\`python
try:
    event = json.loads(msg.value())
except (ValueError, TypeError):
    log.warning("skipping malformed record %s[%d]@%d", msg.topic(), msg.partition(), msg.offset())
else:
    handler(event)  # raises → the loop ends here, this record uncommitted
consumer.commit(message=msg, asynchronous=False)
\`\`\`

A parse failure takes the \`except\` branch and falls through to the commit; a handler exception
leaves the function before the commit. The two edge cases are decided by control flow, not by two
commit statements that could drift apart. Note the \`except\` is narrow — \`ValueError\`,
\`TypeError\`, the two things a parser raises — so that it cannot accidentally become the catch-all
that swallows the handler's error.

Skipping is not losing: the record is still in the log, the warning names \`topic[partition]@offset\`,
and an operator can read it back. Real systems add a **dead-letter topic** — produce the raw bytes
there before committing — so the poison records collect in one place instead of in the log output.

:::quiz
Q: A record's value is the bytes \`not json\`. The loop leaves it uncommitted so that it can be looked at later. What happens?
- [ ] It is redelivered once, then Kafka moves past it
- [x] Every record behind it on that partition is stuck until someone moves the offset by hand
- [ ] The consumer group rebalances and another member gets it
> The committed offset is a single cursor per partition; nothing behind the cursor is reachable until it moves. A record that will fail identically on every retry must be committed and recorded elsewhere, or the partition is dead.
:::

# A failing handler: stop, and let it come back

The opposite case: the value parsed, the handler ran, and the handler raised — the ledger was
unavailable, say. Nothing about the record is wrong; a retry may well succeed. So the record must
**not** be committed, and the simplest correct way to guarantee that is to let the exception out of
the loop:

:::sequence
{
  "participants": ["Kafka", "ledger-writer", "handler"],
  "messages": [
    {"from": "Kafka", "to": "ledger-writer", "label": "poll → partition 0, offset 0", "kind": "reply"},
    {"from": "ledger-writer", "to": "handler", "label": "handler(event)", "kind": "sync"},
    {"from": "handler", "to": "ledger-writer", "label": "returns", "kind": "reply"},
    {"from": "ledger-writer", "to": "Kafka", "label": "commit 1 (partition 0)", "kind": "sync"},
    {"from": "Kafka", "to": "ledger-writer", "label": "poll → partition 0, offset 1", "kind": "reply"},
    {"from": "ledger-writer", "to": "handler", "label": "handler(event)", "kind": "sync"},
    {"from": "handler", "to": "ledger-writer", "label": "raises RuntimeError(\\"ledger unavailable\\")", "kind": "reply"},
    {"from": "ledger-writer", "to": "ledger-writer", "label": "exception leaves run(); no commit — committed offset stays 1, lag 2", "kind": "sync"},
    {"from": "Kafka", "to": "ledger-writer", "label": "next run(): resume at 1 — offset 1 is delivered again", "kind": "reply"}
  ]
}
:::

Three records seeded, the handler failing on offset 1: the handler sees offsets 0 and 1, the committed
offset is 1, the lag is 2 — the failed record and the one behind it, both waiting for the restart.

- **Do not catch the handler's error.** A \`try/except Exception\` around \`handler(event)\` that logs
  and continues reaches the commit site, commits the failed record, and turns a transient outage
  into a lost payment — the at-most-once failure, reintroduced by a defensive habit.
- **Stopping is the honest state.** If the ledger is down, processing the next record will fail too.
  A loop that keeps polling and failing burns through the partition committing nothing; a loop that
  exits is restarted by its supervisor and resumes at the committed offset.
- **Replay is the contract, so the handler must be idempotent.** At-least-once means the record at
  offset 1 arrives twice: once before the crash, once after. A ledger handler that inserts by payment
  id — \`pay-0-1\` — and ignores a duplicate is an
  [idempotent receiver](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html);
  one that appends a row per call double-books.

:::details Why the handler's own retries belong outside the loop
Retrying inside \`handler\` is fine — it is the handler's business how hard it tries before giving up.
What the loop must not do is decide on the handler's behalf that a failure is final. A bounded retry
with backoff *around* the handler, followed by a dead-letter produce and a commit, is how production
consumers avoid stopping on every blip; but that is a policy layered on this loop, and it still ends
in the same two outcomes: the record is done (commit) or it is not (do not commit).
:::

:::quiz
Q: The handler raises on offset 1 of partition 0. The loop catches it, logs it, and carries on to offset 2. What is the committed offset after offset 2 is processed, and what was lost?
- [ ] 2 — nothing; offset 1 will be retried on the next restart
- [x] 3 — offset 1 is committed past and will never be delivered again
- [ ] 1 — the commit for offset 2 is refused because offset 1 failed
> A commit of 3 vouches for everything before it, including the record whose handler failed. The broker has no record of individual failures; the only way to keep a record is to keep the cursor before it, which means not reaching the commit.
:::

# What real consumers add

The drill's loop is the one every production consumer is bolted onto. The additions do not change the
rule — nothing commits a record the handler has not finished — they change the granularity and what
happens on the two edges:

| Left out here | What real systems do | Why |
| --- | --- | --- |
| one commit per record | one commit per \`poll\` batch, after the last handler in it returns | a synchronous commit is a broker round trip; per record it caps throughput |
| rebalances | \`on_revoke\` commits the current position before the partition moves | otherwise the new owner replays everything since the last commit |
| a logged poison record | a dead-letter topic, produced to before the commit | the bytes land somewhere queryable rather than in a log line |
| a stopping handler | bounded retries with backoff, then dead-letter and commit | one transient failure should not stop a partition for a restart cycle |
| at-least-once | transactions: consume → produce → commit offsets atomically | effectively-once when the sink is another Kafka topic |

Per-batch commits widen the replay window — a crash after processing twelve of twenty records
replays twelve, not one — so a batch commit raises the bar on handler idempotency, not lowers it.
The drill commits per record precisely so the window is one record and the reasoning is visible.

:::quiz
Q: A consumer commits once per 500-record batch and crashes with 300 processed. What does the restart do?
- [x] Replays the 300 and processes the remaining 200 — the handler sees 300 duplicates
- [ ] Resumes at record 301; the client remembered the position
- [ ] Loses the 300 — they were never committed
> The in-memory position dies with the process; only the committed offset survives, and it is still at the batch's start. Larger batches mean fewer round trips and more replay — the same at-least-once, with a bigger window.
:::

# What to take away

- **A committed offset is a resume point, per partition, per group** — the next offset to read,
  stored on the broker. Commit \`offset + 1\`; \`earliest\` applies only when there is nothing committed.
- **Commit placement is the delivery guarantee.** Auto-commit commits what was fetched, on a timer:
  at-most-once by default. Commit after the handler returns: at-least-once by construction.
- **Poison records are committed.** A record that fails identically on every retry must not hold the
  cursor; log it (real systems dead-letter it) and move on.
- **A failing handler is not committed.** Let the exception out; the restart replays the record. Never
  wrap the handler in a catch-all that reaches the commit.
- **At-least-once is a contract with the handler.** It will see records twice; it must be idempotent.

The primary reference is the Kafka documentation on
[consumer position](https://kafka.apache.org/documentation/#design_consumerposition) and
[message delivery semantics](https://kafka.apache.org/documentation/#semantics): two short sections
that state, in the project's own terms, why the offset is the only consumer state and what each
commit order guarantees.
`;
